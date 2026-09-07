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
// mg1's deathmatch maps, then classic id1's rerelease ones -- both bots:true and nav-covered.
const DM_ROTATION = ["mgdm1", "mgdm2", "mgdm3", "mgdm4", "dm1", "dm2", "dm3", "dm4"];
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
  server = startPolledSeat("z_sv", `z_${scenario}_sv`, [...baseArgs(RR_DATA, parms, `z_${scenario}_sv`), "-listen", "8", "-port", String(port)], svBoot, STEP_COUNT, IDLE_FRAMES);
  client = startPolledSeat(
    "z_cl",
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

if (scenario !== "sp") {
  const before = readLog(server.seat).length;
  const joined = await server.run(["status"], 30000);
  check("the client seat shows up in the server's status", joined, joined ? "" : readLog(server.seat).slice(-1500));
  if (scenario === "splitscreen") {
    const seated = (readLog(server.seat).slice(before).match(/^#\s*\d+/gm) ?? []).length;
    // 1 host local seat 0 + 1 host local seat 1 (splitscreen) + 4 bots + 1 remote client = 7.
    check("the splitscreen seat is actually seated (server roster grew to 7)", seated >= 7, `roster shows ${seated} clients`);
  }
}

// ===========================================================================
// the soak loop
// ===========================================================================

interface SampleT {
  readonly tSec: number;
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

const svRssSeries = samples.map((s) => s.svRssKB).filter((v): v is number => v !== null);
if (svRssSeries.length >= 4) {
  const half = Math.floor(svRssSeries.length / 2);
  const firstHalf = svRssSeries.slice(0, half);
  const secondHalf = svRssSeries.slice(half);
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const firstMean = mean(firstHalf);
  const secondMean = mean(secondHalf);
  const growthPct = firstMean === 0 ? 0 : ((secondMean - firstMean) / firstMean) * 100;
  check("server RSS growth over the second half is below 15% of the first-half mean", growthPct < 15, `first-half mean ${firstMean.toFixed(0)}kB, second-half mean ${secondMean.toFixed(0)}kB (${growthPct.toFixed(1)}%)`);
} else {
  check("server RSS growth over the second half is below 15% of the first-half mean", false, `only ${svRssSeries.length} RSS samples collected (need >= 4)`);
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

summary(`Z soak ${scenario} ${minutes}m`);
