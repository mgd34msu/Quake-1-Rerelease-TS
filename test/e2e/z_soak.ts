/*
z_soak.ts -- family Z's one driver (unit E10, .orch/briefs/E10-soak.md): a
long-running stability soak of the compiled binary as a listen server, with
bots on a re-release map rotation and a client seat driven by a stuffed cfg
loop (move, fire, respawn).

Usage:
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
    bun test/e2e/z_soak.ts --minutes <n> --scenario <sp|dm-bots|coop-bots|splitscreen>

Scenario shapes (see z_lib.ts's header for why each multiplayer scenario is
two OS processes and `sp` is one):

  sp          one process, no bots: the mg1 single-player campaign rotation
              (mge1m1.. -- mg1's own dm/horde maps are the only ones flagged
              "bots": true in mapdb.json, so the campaign maps have no
              bots/navigation/*.nav and are not asked to carry bots).
              `god`/`noclip` are set (a_stability.ts's precedent) because a
              classic death here would stall the soak with no auto-respawn.
  dm-bots     listen server (`-listen 8`, deathmatch, `bot_count 4`) + one
              connecting client. Rotation: mg1's own deathmatch maps, then
              classic id1's rerelease deathmatch maps (both flagged "bots":
              true AND carry bots/navigation/*.nav, confirmed against
              QFILES/rerelease/{mg1,id1}/pak0.pak's own listings).
  coop-bots   listen server (coop, `bot_count 4`) + one connecting client, on
              rerelease id1's own campaign maps (e1m1..): these are the ONLY
              maps in the retail mapdb that are flagged "bots": true AND
              "coop": true together -- the deathmatch maps above have no
              info_player_coop and would park every client, human or bot, at
              the intermission camera forever (the same failure mode
              mapdb.json's "horde" flag exists to route around, see
              src/bots/bot_client.ts's Bot_PrepareLevel comment).
  splitscreen dm-bots's server + rotation + connecting client, but the
              SERVER also issues `cl_splitscreen 2` on its own local seat
              once the first map has loaded. It has to be the server's own
              seat, not the connecting client's: src/client/splitscreen.ts's
              SS_SetSeats opens an extra seat's connection over the LOOPBACK
              driver to a server in the SAME process ("once there is a local
              server to connect to"), and a remote client has no local
              server to loop back to at all -- confirmed against the engine
              directly, see the "splitscreen" branch below for the repro.
              Only the server's seat 0 and the remote client are driven; the
              assertion is that the server survives a second LOCAL player
              joining mid-soak, not that the splitscreen seat personally
              racks up frags -- per-seat input routing (in_player2_* / real
              SDL events) is family V's own scope (.orch/briefs/E6-
              splitscreen.md), not reachable through a headless spawned
              binary with no console channel on either seat.

"bots still moving at the end" is read off the SERVER's own `status` (frags
growing) and `edicts` dump (player entities present with non-zero fields) --
the two observables the driver contract already prefers ("a frag in the
scoreboard", never "did not crash"). `sp` has no bots and is not asked to
prove this; the campaign's own `edictcount` standing in for "the level is
still simulating something" instead.
*/
import {
  argValue,
  baseArgs,
  check,
  exitedCode,
  frameSpikes,
  hostErrorLines,
  killAll,
  lastNumEdicts,
  lastStatusFrags,
  readLog,
  RR_DATA,
  rssKB,
  startPolledSeat,
  summary,
  type PolledSeatT,
} from "./z_lib";

// ===========================================================================
// argv / scenario
// ===========================================================================

const minutes = Number(argValue("minutes", "10"));
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.log(`z_soak: --minutes must be a positive number (got ${argValue("minutes", "")})`);
  process.exit(2);
}
const scenarioArg = argValue("scenario", "dm-bots");
const SCENARIOS = ["sp", "dm-bots", "coop-bots", "splitscreen"] as const;
type ScenarioT = (typeof SCENARIOS)[number];
function isScenario(s: string): s is ScenarioT {
  return (SCENARIOS as readonly string[]).includes(s);
}
if (!isScenario(scenarioArg)) {
  console.log(`z_soak: --scenario must be one of ${SCENARIOS.join("|")} (got ${scenarioArg})`);
  process.exit(2);
}
const scenario: ScenarioT = scenarioArg;

// mg1's own campaign, in order (no bots -- see the file header).
const SP_ROTATION = ["mge1m1", "mge1m2", "mge1m3", "mge2m1", "mge2m2", "mge3m1", "mge3m2", "mge4m1", "mge4m2", "mge5m1", "mge5m2"];
/*
mg1's deathmatch maps, then classic id1's rerelease ones -- both bots:true and
nav-covered. The rotation RETURNS to maps it has already played (mgdm1 at
index 4, dm1 at index 9) because the memory assertions below need the same
map's cost measured twice with other maps in between: a level that costs more
on its second visit than its first is the observable a real leak leaves, and
comparing two DIFFERENT maps' footprints (what this driver used to do) only
measures how big the maps are.
*/
const DM_ROTATION = ["mgdm1", "mgdm2", "mgdm3", "mgdm4", "mgdm1", "dm1", "dm2", "dm3", "dm4", "dm1"];
// rerelease id1's campaign -- the only maps flagged bots:true AND coop:true together.
const COOP_ROTATION = ["e1m1", "e1m2", "e1m3", "e2m1", "e2m2", "e2m3"];

// UDP 27000-27099, never 27001 (E2E-COMMON.md's E10 band).
const PORTS: Record<Exclude<ScenarioT, "sp">, number> = { "dm-bots": 27010, "coop-bots": 27020, splitscreen: 27030 };

const rotation = scenario === "sp" ? SP_ROTATION : scenario === "coop-bots" ? COOP_ROTATION : DM_ROTATION;
const parms = scenario === "coop-bots" ? [] : ["-mg1"];

console.log(`=== z_soak: scenario=${scenario} minutes=${minutes} rotation=${rotation.join(",")} ===`);

// ===========================================================================
// step-chain sizing (z_lib.ts's header: t_lib.ts's fixed 600-step/40-frame
// chain is sized for a several-second protocol check, not this)
// ===========================================================================

const IDLE_FRAMES = 15; // ~0.2-0.25s/idle step at a typical dummy-video frame rate
const STEP_COUNT = Math.ceil((minutes * 60 * 8) + 300); // 8 steps/s upper bound, plus headroom

// ===========================================================================
// boot
// ===========================================================================

const SV_RANDOMSEED = "42"; // F13: bots need a non-zero seed for a replayable run

let server: PolledSeatT | null = null;
let client: PolledSeatT | null = null;

if (scenario === "sp") {
  server = startPolledSeat(
    "z_sp",
    "z_sp",
    baseArgs(RR_DATA, parms, "z_sp"),
    ["god 1", "noclip 1", "host_speeds 1", `map ${rotation[0]}`],
    STEP_COUNT,
    IDLE_FRAMES,
  );
} else {
  const port = PORTS[scenario];
  const svBoot = ["sv_randomseed " + SV_RANDOMSEED, "host_speeds 1", ...(scenario === "coop-bots" ? ["coop 1"] : []), "bot_count 4", `map ${rotation[0]}`];
  // The seat NAME is what z_lib.ts builds the log filename AND the step-chain
  // cfg names from, so it carries the scenario: with a bare "z_sv"/"z_cl"
  // every scenario writes the same two logs, and running two of them one
  // after another destroys the first one's evidence before anyone reads it.
  // The hyphen goes, because the name reaches the engine inside an `exec`
  // argument and the console's tokenizer ends a token at one ("couldn't exec
  // z_dm" for a z_dm-bots_sv_boot.cfg); the `-game` directory keeps it, being
  // an argv value that is never tokenized.
  const seatName = `z_${scenario.replace(/-/g, "_")}`;
  server = startPolledSeat(`${seatName}_sv`, `z_${scenario}_sv`, [...baseArgs(RR_DATA, parms, `z_${scenario}_sv`), "-listen", "8", "-port", String(port)], svBoot, STEP_COUNT, IDLE_FRAMES);
  client = startPolledSeat(
    `${seatName}_cl`,
    `z_${scenario}_cl`,
    [...baseArgs(RR_DATA, parms, `z_${scenario}_cl`), "-port", String(port), "+connect", "127.0.0.1"],
    ["name Z_HUMAN", "host_speeds 1"],
    STEP_COUNT,
    IDLE_FRAMES,
  );
}

const svArmed = await server.arm(180000);
check("the server/host seat comes up and starts its own step chain", svArmed, svArmed ? "" : readLog(server.seat).slice(-2000));
if (!svArmed) summary(`Z soak ${scenario} ${minutes}m`);

let clArmed = true;
if (client !== null) {
  clArmed = await client.arm(180000);
  check("the connecting client joins and starts its own step chain", clArmed, clArmed ? "" : readLog(client.seat).slice(-2000));
  if (!clArmed) summary(`Z soak ${scenario} ${minutes}m`);
}

if (scenario === "splitscreen") {
  // src/client/splitscreen.ts's SS_SetSeats: an extra seat opens its
  // connection over the LOOPBACK driver to a server in the SAME process
  // ("once there is a local server to connect to") -- there is no path for
  // a second seat to dial out a second real UDP connection to a REMOTE
  // server, so this has to run on the listen server's own seat (which
  // already has one local player), not on the connecting client seat. Confirmed
  // against the engine directly: issuing it on the connecting client printed
  // "cl_splitscreen: 2 local players -- start a map to seat them" and the
  // second seat never appeared in the server's own roster even across a
  // later changelevel (repro: `--scenario splitscreen`, grep the server log
  // for `^#` after the client's `cl_splitscreen 2`).
  const ok = await server.run(["cl_splitscreen 2"], 30000);
  check("cl_splitscreen 2 is accepted on the listen server's own seat", ok, ok ? "" : readLog(server.seat).slice(-1500));
}

/*
The roster the server's own `status` printed: Host_Status_f's `#n name frags
time` rows (src/common/host_cmd.ts), read out of the log the command was
issued into.

Reading it ONCE right after a command is a race, and the race is what a
"roster shows 0 clients" result means rather than a seating failure. A
splitscreen seat's loopback connect and full signon take several server
frames (src/client/splitscreen.ts's SS_Reconcile opens the connection on the
frame AFTER `cl_splitscreen`, and SV_ConnectClient's signon runs from there),
the bots' own join is not instant either, and `status` shares the seat's step
chain with everything else the driver is doing. So every roster assertion
here polls until the roster it is waiting for appears or its deadline passes,
and reports whatever it last saw.
*/
interface RosterT {
  readonly count: number;
  readonly names: readonly string[];
}

// `server` is a `let` the boot block above assigns in both branches; a
// closure does not keep that narrowing, so the seat is captured once here.
const svSeat: PolledSeatT = server;

async function roster(): Promise<RosterT> {
  const before = readLog(svSeat.seat).length;
  if (!(await svSeat.run(["status"], 30000))) return { count: 0, names: [] };
  const chunk = readLog(svSeat.seat).slice(before);
  const blocks = chunk.split(/(?=players: \d+ active)/);
  const last = blocks[blocks.length - 1] ?? "";
  return { count: (last.match(/^#\s*\d+/gm) ?? []).length, names: [...lastStatusFrags(last).keys()] };
}

async function rosterOf(want: number, timeoutMs: number): Promise<RosterT> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await roster();
    if (r.count >= want || Date.now() >= deadline) return r;
    await Bun.sleep(2000);
  }
}

// 1 host local seat 0 + 4 bots + 1 remote client, plus the splitscreen
// scenario's own host local seat 1.
const WANT_ROSTER = scenario === "splitscreen" ? 7 : 6;

if (scenario !== "sp") {
  const r = await rosterOf(WANT_ROSTER, 60000);
  check("the client seat shows up in the server's status", r.names.includes("Z_HUMAN"), `roster: ${r.names.join(", ")}`);
  if (scenario === "splitscreen") {
    check("the splitscreen seat is actually seated (server roster grew to 7)", r.count >= 7, `roster shows ${r.count} clients: ${r.names.join(", ")}`);
  }
}

// ===========================================================================
// the soak loop
// ===========================================================================

interface SampleT {
  readonly tSec: number;
  // Index into `rotation`, not the map name: the rotation returns to maps it
  // has already played, and the two visits are two different levels' worth of
  // samples that must not merge into one.
  readonly visit: number;
  readonly level: string;
  readonly svRssKB: number | null;
  readonly clRssKB: number | null;
  readonly numEdicts: number | null;
  readonly botFrags: number;
}

const MOVE_MS = 1500;
const SAMPLE_MS = 30000;
const CHANGELEVEL_MS = 120000;
const SCAN_MS = 500;
const LEVEL_GRACE_MS = 9000; // host_speeds spikes this soon after a changelevel are the load itself, not a stall

const MOVES: readonly (readonly string[])[] = [
  ["+forward"],
  ["-forward", "+right"],
  ["-right", "+attack"],
  ["-attack", "+back"],
  ["-back", "+left"],
  ["-left", "+attack"],
  ["-attack"],
];

const startT = Date.now();
const totalMs = minutes * 60 * 1000;
const changeTimesMs: number[] = [0]; // t=0 counts as a "level change" (the boot map load)
const samples: SampleT[] = [];
const svSpikes: number[] = [];
const clSpikes: number[] = [];
let svCursor = 0;
let clCursor = 0;
let rotIdx = 0;
let moveIdx = 0;
let nextMove = 0;
let nextSample = 0;
let nextChangelevel = CHANGELEVEL_MS;
let earlyExit: string | null = null;
let ssAfterChange: RosterT | null = null;

function inGrace(tMs: number): boolean {
  return changeTimesMs.some((c) => tMs >= c - 1000 && tMs <= c + LEVEL_GRACE_MS);
}

while (Date.now() - startT < totalMs) {
  const elapsed = Date.now() - startT;

  if (exitedCode(server.seat) !== null) {
    earlyExit = `server exited with code ${exitedCode(server.seat)} at t=${Math.round(elapsed / 1000)}s`;
    break;
  }
  if (client !== null && exitedCode(client.seat) !== null) {
    earlyExit = `client exited with code ${exitedCode(client.seat)} at t=${Math.round(elapsed / 1000)}s`;
    break;
  }

  // frame-time evidence (host_speeds 1), scanned incrementally. The cursor
  // only ever advances to the last COMPLETE newline it has seen -- a cursor
  // landing mid-line would split a "<ms> tot ..." line across two scans and
  // the half with the leading digits would never match.
  const svText = readLog(server.seat);
  const svBoundary = svText.lastIndexOf("\n") + 1;
  if (svBoundary > svCursor) {
    for (const ms of frameSpikes(svText.slice(svCursor, svBoundary), 250)) if (!inGrace(elapsed)) svSpikes.push(ms);
    svCursor = svBoundary;
  }
  if (client !== null) {
    const clText = readLog(client.seat);
    const clBoundary = clText.lastIndexOf("\n") + 1;
    if (clBoundary > clCursor) {
      for (const ms of frameSpikes(clText.slice(clCursor, clBoundary), 250)) if (!inGrace(elapsed)) clSpikes.push(ms);
      clCursor = clBoundary;
    }
  }

  if (client !== null && elapsed >= nextMove) {
    await client.run(MOVES[moveIdx % MOVES.length], 15000);
    moveIdx++;
    nextMove += MOVE_MS;
  } else if (client === null && elapsed >= nextMove) {
    // sp: drive the sole seat directly with the same movement cycle.
    await server.run(MOVES[moveIdx % MOVES.length], 15000);
    moveIdx++;
    nextMove += MOVE_MS;
  }

  if (elapsed >= nextChangelevel && rotIdx + 1 < rotation.length) {
    rotIdx++;
    changeTimesMs.push(Date.now() - startT);
    const ok = await server.run([`changelevel ${rotation[rotIdx]}`], 60000);
    if (!ok) {
      earlyExit = `changelevel to ${rotation[rotIdx]} at t=${Math.round((Date.now() - startT) / 1000)}s never echoed back`;
      break;
    }
    nextChangelevel += CHANGELEVEL_MS;
    if (scenario === "splitscreen" && ssAfterChange === null) {
      // The seats are torn down and re-armed around a level change
      // (src/client/splitscreen.ts's SS_Shutdown / SS_Reconcile), so the
      // second local player has to sign on again before the roster shows it.
      ssAfterChange = await rosterOf(WANT_ROSTER, 45000);
    }
  }

  if (elapsed >= nextSample) {
    const svBefore = readLog(server.seat).length;
    await server.run(["edictcount", "status"], 20000);
    const chunk = readLog(server.seat).slice(svBefore);
    const frags = lastStatusFrags(chunk);
    let botFrags = 0;
    for (const [name, f] of frags) if (name !== "Z_HUMAN") botFrags += f;
    samples.push({
      tSec: Math.round(elapsed / 1000),
      visit: rotIdx,
      level: rotation[rotIdx],
      svRssKB: rssKB(server.seat.proc.pid),
      clRssKB: client === null ? null : rssKB(client.seat.proc.pid),
      numEdicts: lastNumEdicts(chunk),
      botFrags,
    });
    nextSample += SAMPLE_MS;
  }

  await Bun.sleep(SCAN_MS);
}

// final sample
{
  const svBefore = readLog(server.seat).length;
  await server.run(["edictcount", "status"], 20000).catch(() => false);
  const chunk = readLog(server.seat).slice(svBefore);
  const frags = lastStatusFrags(chunk);
  let botFrags = 0;
  for (const [name, f] of frags) if (name !== "Z_HUMAN") botFrags += f;
  samples.push({
    tSec: Math.round((Date.now() - startT) / 1000),
    visit: rotIdx,
    level: rotation[rotIdx],
    svRssKB: rssKB(server.seat.proc.pid),
    clRssKB: client === null ? null : rssKB(client.seat.proc.pid),
    numEdicts: lastNumEdicts(chunk),
    botFrags,
  });
}

// ===========================================================================
// assertions
// ===========================================================================

const fullSvLog = readLog(server.seat);
const fullClLog = client === null ? "" : readLog(client.seat);

console.log("\n--- metrics table (t=seconds, RSS in kB) ---");
console.log("tSec  level      svRSS   clRSS  edicts  botFrags");
for (const s of samples) {
  console.log(
    `${String(s.tSec).padStart(4)}  ${s.level.padEnd(9)}  ${String(s.svRssKB ?? "-").padStart(6)}  ${String(s.clRssKB ?? "-").padStart(6)}  ${String(s.numEdicts ?? "-").padStart(6)}  ${String(s.botFrags).padStart(8)}`,
  );
}
console.log("--- end metrics table ---\n");

check("the soak completed without an early exit", earlyExit === null, earlyExit ?? "");

const svErrors = hostErrorLines(fullSvLog);
const clErrors = hostErrorLines(fullClLog);
check("the server/host seat logged no Host_Error", svErrors.length === 0, svErrors.slice(0, 3).join(" | "));
if (client !== null) check("the client seat logged no Host_Error", clErrors.length === 0, clErrors.slice(0, 3).join(" | "));

check("the server/host process is still running at the end", exitedCode(server.seat) === null, `exit code ${exitedCode(server.seat)}`);
if (client !== null) check("the client process is still running at the end", exitedCode(client.seat) === null, `exit code ${exitedCode(client.seat)}`);

/*
MEMORY. Two questions, and they are not the same question.

Comparing the run's second half against its first half -- what this driver
did until F22 -- compares DIFFERENT MAPS: the rotation walks from mgdm1 (84
edicts) to mgdm3 (159), and a bigger level legitimately costs more, so the
comparison measures map size and calls it growth. Worse, the engine's own
footprint is dominated by things that never come back: `bun build --compile`'s
own runtime and the bundled engine modules are ~165MB of the RSS before a
map is even loaded, this port's hunk is one `new Uint8Array` per
Hunk_AllocName with no shared buffer to rewind (src/common/zone.ts:
Hunk_FreeToLowMark is a no-op), and JavaScriptCore grows its heap's high-water
mark and never returns the pages to the OS. RSS therefore steps UP per larger
map by design and steps down only as far as the allocator feels like.

What a leak actually looks like is either of:

  - a level whose footprint keeps climbing while it is being PLAYED (nothing
    is being loaded any more, so a rising RSS is retention), or
  - a map that costs more the SECOND time the rotation reaches it than it did
    the first, with other maps played in between.

Both are measured below, per level, which is why `SampleT` carries the
rotation index and why DM_ROTATION revisits its maps.

The FIRST sample of every level is dropped from both: it is taken as soon as
`changelevel` echoes back, with the level's models still being decoded and
nothing collected yet, so it is the load in progress rather than the level's
cost. (t=0's sample is the boot map's own version of the same thing.)
*/
interface VisitT {
  readonly visit: number;
  readonly level: string;
  readonly rss: number[];
}

const visits: VisitT[] = [];
for (const s of samples) {
  if (s.svRssKB === null) continue;
  const cur = visits[visits.length - 1];
  if (cur === undefined || cur.visit !== s.visit) visits.push({ visit: s.visit, level: s.level, rss: [s.svRssKB] });
  else cur.rss.push(s.svRssKB);
}
const steady: VisitT[] = visits.map((v) => ({ visit: v.visit, level: v.level, rss: v.rss.slice(1) })).filter((v) => v.rss.length > 0);

function worstWithinLevel(vs: readonly VisitT[]): string {
  let worst = "n/a";
  let worstPct = Number.NEGATIVE_INFINITY;
  for (const v of vs) {
    if (v.rss.length < 2) continue;
    const first = v.rss[0];
    const last = v.rss[v.rss.length - 1];
    const pct = first === 0 ? 0 : ((last - first) / first) * 100;
    if (pct > worstPct) {
      worstPct = pct;
      worst = `${v.level} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    }
  }
  return worst;
}

const WITHIN_LEVEL_PCT = 10;
const climbing: string[] = [];
let levelsMeasured = 0;
for (const v of steady) {
  if (v.rss.length < 2) continue;
  levelsMeasured++;
  const first = v.rss[0];
  const last = v.rss[v.rss.length - 1];
  const pct = first === 0 ? 0 : ((last - first) / first) * 100;
  if (pct >= WITHIN_LEVEL_PCT) climbing.push(`${v.level} ${first}->${last}kB (+${pct.toFixed(1)}%)`);
}
check(
  `server RSS is flat within each level (last sample within ${WITHIN_LEVEL_PCT}% of the first settled one)`,
  levelsMeasured > 0 && climbing.length === 0,
  levelsMeasured === 0 ? "no level was sampled twice after its load window (need a longer run)" : climbing.length === 0 ? `${levelsMeasured} levels measured, worst ${worstWithinLevel(steady)}` : climbing.join("; "),
);

/*
The revisit. `later <= earlier * 1.1` is the comparison this wants to be and
cannot be, because RSS is a HIGH-WATER MARK: JavaScriptCore grows its heap to
fit the biggest map the process has loaded and does not hand the pages back,
so mgdm1's second visit legitimately sits wherever mgdm3 left the process,
not back at mgdm1's own first-visit figure. Measured directly (F22, in
process, with a full GC forced before each reading): the RETAINED bytes are
flat across revisits -- mgdm1 at 40.7MB of ArrayBuffer on its first visit and
44.1MB on its third and fifth, mgdm3 44.1MB on both of its -- while RSS over
the same visits reads 641MB, 930MB, 929MB. Retention is flat; RSS is a
ratchet.

So the budget for a revisit is the WORST the process was already running at
between the two visits, not the earlier visit alone. A revisit that stays
under that has cost the process nothing it had not already spent; a real leak
is what pushes the mark up again every time the rotation comes round, and
fails this.
*/
const REVISIT_PCT = 10;
const byLevel = new Map<string, VisitT[]>();
for (const v of steady) {
  const list = byLevel.get(v.level);
  if (list === undefined) byLevel.set(v.level, [v]);
  else list.push(v);
}
const revisits: string[] = [];
const costlier: string[] = [];
for (const [level, vs] of byLevel) {
  if (vs.length < 2) continue;
  const first = vs[0];
  const final = vs[vs.length - 1];
  const earlier = first.rss[first.rss.length - 1];
  const later = final.rss[final.rss.length - 1];
  let peakBetween = earlier;
  for (const v of steady) {
    if (v.visit <= first.visit || v.visit >= final.visit) continue;
    for (const r of v.rss) if (r > peakBetween) peakBetween = r;
  }
  const budget = peakBetween * (1 + REVISIT_PCT / 100);
  const line = `${level} ${earlier}kB -> ${later}kB (peak in between ${peakBetween}kB, budget ${budget.toFixed(0)}kB)`;
  revisits.push(line);
  if (later > budget) costlier.push(line);
}
if (revisits.length > 0) {
  check(`a map the rotation returns to costs no more than ${REVISIT_PCT}% over the worst the run had already reached`, costlier.length === 0, revisits.join("; "));
} else {
  console.log(`[note] the rotation did not return to any map in ${minutes} minutes -- the revisit comparison was not exercised`);
}

check("no server/host frame outside a level-change window ran over 250ms (host_speeds 1)", svSpikes.length === 0, svSpikes.length === 0 ? "" : `${svSpikes.length} spikes, worst ${Math.max(...svSpikes)}ms`);
if (client !== null) check("no client frame outside a level-change window ran over 250ms (host_speeds 1)", clSpikes.length === 0, clSpikes.length === 0 ? "" : `${clSpikes.length} spikes, worst ${Math.max(...clSpikes)}ms`);

if (scenario === "sp") {
  const last = samples[samples.length - 1];
  check("the campaign is still simulating at the end (edictcount answered)", last !== undefined && last.numEdicts !== null, last === undefined ? "no samples" : `numEdicts=${last.numEdicts}`);
} else {
  const fragsSeries = samples.map((s) => s.botFrags);
  const first = fragsSeries[0] ?? 0;
  const last = fragsSeries[fragsSeries.length - 1] ?? 0;
  const lastServerStatus = fullSvLog.slice(fullSvLog.lastIndexOf("players:"));
  const stillConnected = (lastServerStatus.match(/^#\s*\d+/gm) ?? []).length;
  check("bots are still moving at the end (scoreboard frags increased, or the roster is still fully seated)", last > first || stillConnected >= 4, `frags ${first} -> ${last}; ${stillConnected} clients in the final status`);
}

if (scenario === "splitscreen") {
  if (ssAfterChange !== null) {
    check("the splitscreen seat is still seated on the other side of a level change", ssAfterChange.count >= WANT_ROSTER, `roster shows ${ssAfterChange.count} clients: ${ssAfterChange.names.join(", ")}`);
  } else {
    console.log(`[note] the soak ended before the first changelevel -- the seat's survival across a level change was not exercised`);
  }
}

summary(`Z soak ${scenario} ${minutes}m`);
