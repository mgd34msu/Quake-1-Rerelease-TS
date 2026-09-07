/*
t_matrix -- one content/protocol/ruleset pairing, played for real.

  bun test/e2e/t_matrix.ts --content classic-id1 --protocol 666 --ruleset auto --port 26310

A dedicated server (the compiled binary) serves one map of one content tree on
one protocol under one ruleset; one client (the same compiled binary, its own
OS process, real UDP) connects, walks, fires and fights. What the driver
asserts:

  - the SERVER's `Server ruleset <id>` and `Server protocol <n> (flags 0x<f>)`
    lines are the pairing that was asked for (and, for `auto`, the pairing the
    documented rule in src/server/sv_main.ts's SV_ChooseProtocol picks);
  - the CLIENT negotiated the same protocol number and the same protocol
    flags, read off its own `Client protocol <n> (flags 0x<f>)` line (F20),
    with the serverinfo bytes in a demo it recorded from before the connect
    kept as a fallback cross-check;
  - the client reached the level: it printed the level title, and the title in
    its demo is the same one;
  - the player can move: the server's `edict 1` origin changes across a
    `+forward` phase;
  - the player can fire: `edict 1`'s currentammo drops across a `+attack`
    phase;
  - a monster dies from the client's shots: fewer `monster_*` edicts are still
    solid in the server's `edicts` dump after the fight than before it, fought
    with `sv_aim 0` widening autoaim to a full forward hemisphere and a
    hitscan weapon (the shotgun) so a headless client that cannot aim by
    itself still lands real damage instead of relying on splash near-misses.

The invalid-by-design pairing is protocol 15 with a BSP2 map (mg1, mg3, dopa).
Protocol 15's coordinates are 13.3 fixed point, so it cannot address a world
built past BSP29's limits at all; the driver asserts the server refuses that
pairing with an error naming it, and asserts that `auto` answers 999 for the
same map.
*/

import {
  BINARY,
  baseArgs,
  check,
  clientLevelTitle,
  clientProtocolLine,
  consoleLine,
  svQuery,
  contentById,
  edictNumber,
  edictVector,
  killSeat,
  lastEdict,
  type EdictSampleT,
  parseEdicts,
  readDemoServerInfo,
  readLog,
  recordedDemoPath,
  serverProtocolLine,
  serverRuleset,
  sleep,
  startPolledClient,
  startServer,
  summary,
  waitFor,
  waits,
  type PolledClientT,
  argValue,
} from "./t_lib";

const contentId = argValue("content", "classic-id1");
const protocolArg = argValue("protocol", "auto");
const rulesetArg = argValue("ruleset", "auto");
const port = argValue("port", "26310");

const c = contentById(contentId);
const slug = `${contentId}_${protocolArg}_${rulesetArg}`.replace(/[^A-Za-z0-9_]/g, "_");
const svGame = `e2e_t_${slug}_sv`;
const clGame = `e2e_t_${slug}_cl`;

// protocol 999's own default protocolflags (src/common/protocol/rmq999.ts);
// 15 and 666 carry none at all.
const RMQ_FLAGS = 0x82;

console.log(`t_matrix: content=${contentId} map=${c.map} protocol=${protocolArg} ruleset=${rulesetArg} port=${port} binary=${BINARY}`);

const expectedRuleset = rulesetArg === "auto" ? c.ruleset : rulesetArg;

const serverArgs = [
  ...baseArgs(c, svGame),
  "-port", port,
  // Host_InitLocal sets `deathmatch 1` for every server with more than one
  // client slot (src/common/host.ts, WinQuake's own rule), and a deathmatch
  // server removes the monsters at spawn and refuses the cheat impulses. The
  // matrix wants the single-player rules the content was built for, and
  // stuffcmds runs after Host_Init, so this is the value that reaches the map.
  "+deathmatch", "0",
  "+sv_cheats", "1",
  // PF_aim's autoaim cone (src/progs/pr_cmds.ts) compares the dot product of
  // the client's forward vector and the direction to a live target against
  // this threshold; 0.93 (the QuakeC default) is a narrow cone around dead
  // centre, which a headless client sweeping blind cannot reliably land. 0
  // accepts any target the trace can still see anywhere in front of the
  // player (a full hemisphere), which is what turns "spray in the general
  // direction of the monster" into an observable, deterministic kill without
  // touching the monster's own health, damage, or the client's aim itself.
  "+sv_aim", "0",
  "+sv_ruleset", rulesetArg,
  "+sv_protocol", protocolArg,
  "+map", c.map,
];

const sv = startServer(`t_matrix_${slug}_sv`, serverArgs);

const booted = await waitFor(sv, /========Quake Initialized/, 60000);
check("server boots", booted, booted ? sv.log : `${sv.log} never printed the init banner`);
if (!booted) summary(`t_matrix ${slug}`);

// ---------------------------------------------------------------------------
// invalid by design: protocol 15 cannot address a BSP2 world
// ---------------------------------------------------------------------------

if (protocolArg === "15" && c.bsp2) {
  await waitFor(sv, /Server protocol|cannot|refus/i, 40000);
  await sleep(2000);
  const text = readLog(sv);
  const line = serverProtocolLine(text);
  const refused = /protocol 15[^\n]*(BSP2|cannot|refus|too large|not supported)|(BSP2|wide)[^\n]*protocol 15/i.test(text);
  check(
    "protocol 15 refuses a BSP2 map with an error naming the pairing",
    refused,
    refused ? "" : `no refusal in ${sv.log}; the server announced "Server protocol ${line === null ? "?" : line.protocol}" and served ${c.map} anyway`,
  );
  check(
    "protocol 15 does not spawn the BSP2 map",
    line === null || line.protocol !== 15,
    line === null ? "" : `served ${c.map} on protocol ${line.protocol} (flags 0x${line.flags.toString(16)})`,
  );
  killSeat(sv);
  summary(`t_matrix ${slug}`);
}

// ---------------------------------------------------------------------------
// the pairing the server announced
// ---------------------------------------------------------------------------

const announced = await waitFor(sv, /Server protocol \d+ \(flags/, 60000);
check("server announces the protocol it serves the map on", announced, announced ? "" : `no "Server protocol" line in ${sv.log}`);
if (!announced) summary(`t_matrix ${slug}`);

const svText0 = readLog(sv);
const svProto = serverProtocolLine(svText0);
const svRuleset = serverRuleset(svText0);

check("server ruleset is the one asked for", svRuleset === expectedRuleset, `expected ${expectedRuleset}, server printed ${svRuleset ?? "nothing"}`);

if (svProto === null) {
  check("server protocol line parses", false, "no Server protocol line");
  summary(`t_matrix ${slug}`);
}

if (protocolArg === "auto") {
  // SV_ChooseProtocol's documented `auto`: never 15, and 999 whenever the map
  // needs the width (BSP2/2PSB, bounds outside +-4096, or more than 600
  // entities in the entity lump).
  check("auto never picks protocol 15", svProto.protocol !== 15, `auto picked ${svProto.protocol}`);
  if (c.bsp2) check("auto picks 999 for a BSP2 map", svProto.protocol === 999, `auto picked ${svProto.protocol} for ${c.map}`);
  else check("auto picks 666 or 999 for a BSP29 map", svProto.protocol === 666 || svProto.protocol === 999, `auto picked ${svProto.protocol} for ${c.map}`);
} else {
  check("server serves the requested protocol", svProto.protocol === Number(protocolArg), `asked for ${protocolArg}, got ${svProto.protocol}`);
}

const expectedFlags = svProto.protocol === 999 ? RMQ_FLAGS : 0;
check(
  "server protocol flags match the protocol",
  svProto.flags === expectedFlags,
  `protocol ${svProto.protocol} announced flags 0x${svProto.flags.toString(16)}, expected 0x${expectedFlags.toString(16)}`,
);

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

const DEMO = `t_m_${slug}`.slice(0, 40);

/*
`record` sits ahead of `connect` in ONE console frame -- quake.rc leaves the
client inside `startdemos demo1 demo2 demo3`, which puts cls.state at
ca_connected and makes `record` refuse, so the disconnect/record/connect trio
has to land together, or a demo restarts in the gap. Everything after the
join is driven live through a PolledClientT (t_lib.ts's startPolledClient),
the same interactive mechanism family T's own t_deathmatch.ts and
t_demos_net.ts use, rather than a single long fixed timeline: the fight below
needs to read the map's own monster positions back from the server before it
knows which way to turn, which a script written before the client even
connects cannot do.
*/
const clientArgs = [...baseArgs(c, clGame), "-port", port];
const cl: PolledClientT = startPolledClient(`t_matrix_${slug}_cl`, clGame, clientArgs, ["cl_shownet 0", "disconnect", `record ${DEMO}`, "connect 127.0.0.1"]);

const joined = await waitFor(sv, /entered the game/, 120000);
check("client connects and reaches the level", joined, `server log: ${(readLog(sv).match(/.*entered the game.*/g) ?? []).slice(-1).join("")}`);

const title = clientLevelTitle(readLog(cl.seat));
check("client printed the level title it was sent", title !== null && title.length > 0, `title=${title ?? "(none)"}`);

const statusOut = await svQuery(sv, "status", "STATUS");
check("server status names the map and one active player", new RegExp(`map:\\s+${c.map}`).test(statusOut) && /players:\s*1 active/.test(statusOut), statusOut.replace(/\n/g, " | ").slice(0, 240));

await cl.arm();

// One impulse per step: `impulse` sets a single `in_impulse` that CL_SendMove
// puts in the next usercmd, so two in the same step would lose the first.
// `impulse 9` (F20 D4's "give all" cheat) sets self.weapon to the rocket
// launcher directly (weapons.qc's CheatCommand), so the nailgun is selected
// here, BEFORE sampleA, and stays selected through the movement check below
// -- sampleA/B/C all have to read the same ammo pool (nails) for the
// ammo-drop comparison to mean anything.
await cl.run(["god"]);
await cl.run(["impulse 9"]);
await cl.run(["impulse 4"]);
const sampleA = lastEdict(await svQuery(sv, "edict 1", "A"), 1);
check("server can report the connected player's edict", sampleA !== null, sampleA === null ? "no EDICT 1 block in the server log" : `classname=${sampleA.fields.get("classname") ?? "?"}`);

await cl.run(["+forward"]);
await sleep(3000);
await cl.run(["-forward"]);
const sampleB = lastEdict(await svQuery(sv, "edict 1", "B"), 1);
const originA = edictVector(sampleA, "origin");
const originB = edictVector(sampleB, "origin");
const movedFar =
  originA !== null && originB !== null && Math.hypot(originB[0] - originA[0], originB[1] - originA[1], originB[2] - originA[2]) > 8;
check("the player moves when the client holds +forward", movedFar, `origin ${JSON.stringify(originA)} -> ${JSON.stringify(originB)}`);

await cl.run(["+attack"]);
await sleep(2000);
await cl.run(["-attack"]);
const sampleC = lastEdict(await svQuery(sv, "edict 1", "C"), 1);
const ammoB = edictNumber(sampleB, "currentammo");
const ammoC = edictNumber(sampleC, "currentammo");
check("the player's ammo drops when the client holds +attack", ammoC < ammoB, `currentammo ${ammoB} -> ${ammoC} (weapon ${edictNumber(sampleB, "weapon")})`);

/** `monster_*` edicts still solid, i.e. alive: a killed monster goes SOLID_NOT and a gibbed one is freed outright. */
function liveMonsters(dump: string): number {
  let n = 0;
  for (const e of parseEdicts(dump)) {
    if (!(e.fields.get("classname") ?? "").startsWith("monster_")) continue;
    if (edictNumber(e, "solid") !== 0) n++;
  }
  return n;
}

const dumpBefore = await svQuery(sv, "edicts", "M1");
const beforeLive = liveMonsters(dumpBefore);

if (c.monsters) {
  check("the map spawned monsters to fight", beforeLive > 0, `${beforeLive} live monster_* edicts on ${c.map}`);
} else {
  check("a monster-free map spawns no monsters", beforeLive === 0, `${beforeLive} live monster_* edicts on ${c.map}`);
}

/*
The fight. A headless client cannot aim by itself, and the ten content trees
this driver covers put their first monster in ten different places, so
rather than a fixed walk-and-spray timeline tuned to one map (which turned
out not even to reach id1's e1m1's own single nearby monster -- it sits
behind the entry room's window, out of PF_aim's line-of-sight trace no
matter how the hemisphere is widened), the driver reads the live monster
positions back off the server (svQuery's "edicts") and STEERS the client
onto whichever one is closest, using `noclip` to close the distance
regardless of any wall, window or grate between the two -- once the player's
own origin is within a few dozen units of the target, no wall remains
between them for PF_aim's trace to catch on. `sv_aim 0` (above, on the
server) still does the actual aiming: this only gets the player close enough
and turned roughly the right way for that widened hemisphere to have
something to find. `god` keeps incidental contact damage (a monster's own
melee, a fall) from ending the run before the shot lands.
*/
if (c.monsters && beforeLive > 0) {
  const monsters = parseEdicts(dumpBefore).filter((e) => (e.fields.get("classname") ?? "").startsWith("monster_"));
  const originNow = edictVector(sampleC, "origin") ?? [0, 0, 0];
  let target: EdictSampleT = monsters[0];
  let bestDist = Infinity;
  for (const m of monsters) {
    const o = edictVector(m, "origin");
    if (o === null) continue;
    const d = Math.hypot(o[0] - originNow[0], o[1] - originNow[1], o[2] - originNow[2]);
    if (d < bestDist) {
      bestDist = d;
      target = m;
    }
  }
  const targetOrigin = edictVector(target, "origin") ?? [0, 0, 0];
  console.log(`t_matrix: nearest monster ${target.fields.get("classname") ?? "?"} at ${JSON.stringify(targetOrigin)}, ${bestDist.toFixed(0)} units away`);

  const norm180 = (deg: number): number => (((deg + 180) % 360) + 360) % 360 - 180;
  const playerYaw = (dump: string): number | null => {
    const a = edictVector(lastEdict(dump, 1), "angles");
    return a === null ? null : a[1];
  };
  const playerOrigin = (dump: string): readonly [number, number, number] | null => edictVector(lastEdict(dump, 1), "origin");

  await cl.run(["impulse 2"]); // the shotgun -- a hitscan weapon, see the file header

  /*
  Turning and moving are held for a COUNTED number of `wait` frames inside a
  SINGLE run() step (`+key`, N waits, `-key`, all one step), not across two
  separate run() calls with a real-time sleep() between them: t_lib.ts's
  PolledClientT idles STEP_IDLE_FRAMES (40) frames at the tail of every step
  before the NEXT step's file is even exec'd, so a `sleep()` shorter than
  that idle is silently rounded UP to it -- a two-call "+right" / sleep(400)
  / "-right" was observed turning the same ~124 degrees regardless of the
  requested sleep, because the 40-frame idle dominated the real duration
  either way. Holding both halves of a press/release pair inside one step's
  own wait count sidesteps the idle entirely: the client executes the whole
  thing, unpaced by any other step boundary, in exactly the frame count
  asked for.
  */

  // Measure the actual, signed turn rate of "+right" in degrees-per-FRAME
  // rather than assuming one, then correct the yaw. This rate is kept for
  // the approach loop below too, which re-aims every iteration rather than
  // committing to one heading for the whole flight: a straight line from a
  // single one-shot correction only has to be off by a few degrees to miss
  // the target's own small "close enough" radius while passing near it
  // between two distance checks, and the loop cannot tell "getting closer"
  // from "just flew past it" without comparing to where it aimed.
  const TURN_PROBE_FRAMES = 30;
  const yawBefore = playerYaw(await svQuery(sv, "edict 1", "YAW0"));
  await cl.run(["+right", ...waits(TURN_PROBE_FRAMES), "-right"]);
  const afterProbe = await svQuery(sv, "edict 1", "YAW1");
  const yawAfter = playerYaw(afterProbe);
  const posAfterProbe = playerOrigin(afterProbe) ?? originNow;

  let degPerFrame = 1; // degrees per frame of "+right"; refined just below
  if (yawBefore !== null && yawAfter !== null) {
    const measured = norm180(yawAfter - yawBefore) / TURN_PROBE_FRAMES;
    if (Math.abs(measured) > 0.01) degPerFrame = measured;
  }

  /** Turns toward `to` from the CURRENT live yaw, using the measured degPerFrame rate. */
  async function aimAt(to: readonly [number, number, number]): Promise<readonly [number, number, number]> {
    const dump = await svQuery(sv, "edict 1", `AIM${Math.random().toString(36).slice(2, 6)}`);
    const yaw = playerYaw(dump);
    const pos = playerOrigin(dump) ?? posAfterProbe;
    if (yaw === null) return pos;
    const desiredYaw = (Math.atan2(to[1] - pos[1], to[0] - pos[0]) * 180) / Math.PI;
    const neededDeg = norm180(desiredYaw - yaw);
    const frames = Math.min(90, Math.round(Math.abs(neededDeg / degPerFrame)));
    const key = neededDeg / degPerFrame > 0 ? "right" : "left";
    if (frames > 0) await cl.run([`+${key}`, ...waits(frames), `-${key}`]);
    return pos;
  }

  await aimAt(targetOrigin);

  /*
  Close the distance with noclip so no wall, window or grate between the
  player and the target can block the approach, stopping a BUFFER short of
  it rather than closing all the way. Two independent things make landing
  too close its own failure, not just "closer is always better":

  - noclip stops paying attention to collision AT ALL, so flying too far
    risks landing the player's own origin embedded IN whatever wall it just
    flew through, which leaves PF_aim's own SV_Move trace starting stuck in
    solid (a real, observed failure: point-blank noclip on id1's e1m1
    landed zero damage, health unchanged). Handing off to ordinary WALKING
    for a separate "final approach" was tried and made its own trouble too
    -- on classic-hipnotic the walk got wedged against geometry it could
    not path around and never got any closer.
  - even on open, unobstructed ground, landing WITHIN the target's own
    hitbox radius breaks the same trace from the other side: a player and a
    Quake monster are both roughly 32 units wide, so under ~60 units puts
    their bounding boxes overlapping, and the trace starts already inside
    the very entity it is aiming at. A confirmed case: 10.8 units away,
    aimed within one degree of exact, zero damage on every attempt.

  So the 90-unit buffer this loop aims for is not "as close as possible" --
  it targets a middle distance clear of both failure modes.

  The distance that gates the approach has to be the REAL 3D distance, not
  just X/Y: hip1m1's nearest monster sits 200 units below the player on a
  lower floor but only ~93 units away in X/Y, and an X/Y-only gate reads
  that as "close enough" without ever closing the vertical gap -- no shot
  ever reaches a monster on a different floor. But closing that vertical gap
  in one large burst is its own hazard: on rogue's r1m1 a single long
  `+movedown` burst flew the player below the actual floor into open void.
  And a FIXED horizontal burst length has the matching failure the other
  way -- one sized for mg1's 1500-unit gap overshot hip1m1's 90-unit gap by
  thousands of units in a single step, with nothing to notice the miss until
  the burst was already over. So both axes size their own burst from a
  MEASURED units-per-frame speed (a short calibration hold) and the actual
  remaining distance each iteration -- a monster's own floor is reached
  gradually and by measurement, not by a guessed frame count in either axis.
  */
  const dist3D = (cur: readonly [number, number, number]): number =>
    Math.hypot(targetOrigin[0] - cur[0], targetOrigin[1] - cur[1], targetOrigin[2] - cur[2]);

  await cl.run(["noclip"]);

  const CAL_FRAMES = 20;
  let cur = playerOrigin(await svQuery(sv, "edict 1", "APPCAL0"));
  let unitsPerFrame = 4.3; // WinQuake's default 200 u/s at a headless server's own frame rate; refined below
  if (cur !== null && dist3D(cur) >= 120) {
    const before = cur;
    await cl.run(["+forward", ...waits(CAL_FRAMES), "-forward"]);
    const after = playerOrigin(await svQuery(sv, "edict 1", "APPCAL1"));
    if (after !== null) {
      const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
      if (moved > 4) unitsPerFrame = moved / CAL_FRAMES;
      cur = after;
    }
  }

  for (let i = 0; i < 16; i++) {
    if (cur === null) break;
    let remaining = dist3D(cur);
    if (remaining < 120) break;
    // Re-aim every iteration from the CURRENT position rather than trusting
    // the one heading computed before the approach started: a straight line
    // only has to be off by a few degrees to pass NEAR the target without
    // ever registering "close enough" between two burst-boundary distance
    // checks, and every burst after that flies further away in a straight
    // line, compounding rather than correcting the miss.
    cur = await aimAt(targetOrigin);
    remaining = dist3D(cur);
    if (remaining < 120) break;
    // `+forward` is held for the WHOLE burst (totalFrames); the vertical key
    // only covers the FIRST vFrames of that same span, not extra frames on
    // top of it -- laying vFrames before totalFrames, as an earlier version
    // of this loop did, held `+forward` for vFrames+totalFrames and roughly
    // doubled the actual distance travelled versus what totalFrames alone
    // was sized for.
    const totalFrames = Math.min(150, Math.max(4, Math.round((remaining - 90) / unitsPerFrame)));
    const dz = targetOrigin[2] - cur[2];
    const vertical = Math.abs(dz) > 40 ? (dz > 0 ? "moveup" : "movedown") : null;
    const vFrames = vertical === null ? 0 : Math.min(totalFrames, Math.max(2, Math.round(Math.abs(dz) / unitsPerFrame)));
    const vDown = vertical === null ? [] : [`+${vertical}`, ...waits(vFrames), `-${vertical}`];
    await cl.run(["+forward", ...vDown, ...waits(totalFrames - vFrames), "-forward"]);
    cur = playerOrigin(await svQuery(sv, "edict 1", `APP${i}`));
  }

  /*
  A burst sized from ONE calibration measurement can still overshoot well
  past the intended 90-unit buffer if Quake's own acceleration ramp made
  that one measurement read slower than the speed the burst actually
  cruised at for most of its length -- a confirmed case landed at 7.7 units
  (aimed within a degree, zero damage every attempt) despite the same math
  that reliably lands in the 90-150 range most of the time. So the final
  distance is checked explicitly and, if it is inside the overlap radius
  the file header above explains, the player backs OUT to a safe distance
  rather than firing from on top of the target. Used again after the fire
  loop's own closer nudge below, which is exactly the same kind of burst
  and can overshoot the same way.
  */
  async function backOffIfTooClose(to: readonly [number, number, number]): Promise<void> {
    const here = playerOrigin(await svQuery(sv, "edict 1", `BACKOFF${Math.random().toString(36).slice(2, 6)}`));
    if (here === null) return;
    const d = Math.hypot(to[0] - here[0], to[1] - here[1], to[2] - here[2]);
    if (d >= 70 || d <= 0) return;
    const backFrames = Math.min(60, Math.max(4, Math.round((90 - d) / unitsPerFrame)));
    await cl.run(["+back", ...waits(backFrames), "-back"]);
    await aimAt(to);
  }
  await backOffIfTooClose(targetOrigin);

  /*
  Firing happens WITHOUT ever turning noclip back off. Toggling it off to
  "verify" the landing spot was tried and made things worse: src/server/
  sv_phys.ts's SV_CheckStuck (src/server/sv_phys.ts:637, WinQuake's own
  anti-stuck hack) runs the instant movetype goes back to MOVETYPE_WALK, and
  if the current origin tests as embedded it does not just report that -- it
  OVERWRITES ent.v.origin with ent.v.oldorigin, which MOVETYPE_NOCLIP's own
  physics (SV_Physics_Noclip, sv_phys.ts:990) never updates while flying, so
  oldorigin is however many frames stale since the last time this entity was
  in MOVETYPE_WALK -- observed reverting the player all the way back to
  wherever it stood right after the ammo-drop check, discarding this entire
  approach. PF_aim's own trace (the thing that actually needs the player not
  to be embedded) never checks self.movetype at all, so there is nothing
  toggling collision back on was buying that the buffered, measured approach
  above was not already aiming for on its own.

  The nearest live `monster_*` to the player's OWN current position is
  looked up FRESH each attempt, by classname and liveness rather than by
  entity index: ED_Alloc recycles a freed edict's slot number for whatever
  gets spawned next (a projectile, a temp entity, anything), so an index
  captured before the fight is not a stable handle on "the same monster"
  once real time has passed -- confirmed by a retry that fired at
  `target.index`'s LATER occupant, an unrelated entity nowhere near where
  the actual monster stood. Re-deriving the nearest live monster from
  scratch each attempt sidesteps that entirely. A single re-aim-and-fire
  attempt was also observed missing outright on an otherwise well-navigated
  approach (~25 units from the target, zero damage) -- FireBullets' own
  pellet spread, or the target turning away right as the burst started,
  does not need a navigation failure to explain a miss, so a failed attempt
  retargets and fires again rather than giving up on the first one.
  */
  for (let fireAttempt = 0; fireAttempt < 3; fireAttempt++) {
    const liveDump = await svQuery(sv, "edicts", `RETARGET${fireAttempt}`);
    const livePlayerOrigin = playerOrigin(liveDump) ?? originNow;
    const liveMonstersNow = parseEdicts(liveDump).filter((e) => (e.fields.get("classname") ?? "").startsWith("monster_") && edictNumber(e, "solid") !== 0);
    if (liveMonstersNow.length === 0) break; // nothing left alive to shoot at
    let liveTarget = liveMonstersNow[0];
    let liveBestDist = Infinity;
    for (const m of liveMonstersNow) {
      const o = edictVector(m, "origin");
      if (o === null) continue;
      const d = Math.hypot(o[0] - livePlayerOrigin[0], o[1] - livePlayerOrigin[1], o[2] - livePlayerOrigin[2]);
      if (d < liveBestDist) {
        liveBestDist = d;
        liveTarget = m;
      }
    }
    const liveTargetOrigin = edictVector(liveTarget, "origin") ?? targetOrigin;

    // A closer nudge before every attempt but the first, IF the target has
    // wandered back out past the approach loop's own safe buffer -- but
    // never closer than that buffer. Landing basically ON TOP of the target
    // was tried and made things worse: a player and a monster are both
    // roughly 32 units wide, so anything under about 60 units puts their
    // bounding boxes overlapping, and PF_aim's own straight-ahead SV_Move
    // trace starts already inside the very entity it is trying to reach --
    // a confirmed miss (10.8 units away, correctly aimed within a degree,
    // zero damage every attempt) that closing the gap further cannot fix.
    if (fireAttempt > 0 && liveBestDist > 150) {
      await aimAt(liveTargetOrigin);
      const nudgeFrames = Math.min(60, Math.max(4, Math.round((liveBestDist - 90) / unitsPerFrame)));
      await cl.run(["+forward", ...waits(nudgeFrames), "-forward"]);
      await backOffIfTooClose(liveTargetOrigin);
    }

    await aimAt(liveTargetOrigin);
    await cl.run(["+attack", ...waits(400), "-attack"]);

    const afterDump = await svQuery(sv, "edicts", `FIREDONE${fireAttempt}`);
    if (liveMonsters(afterDump) < beforeLive) break; // a kill landed: no more attempts needed
  }
}

const dumpAfter = await svQuery(sv, "edicts", "M2");
const afterLive = liveMonsters(dumpAfter);

if (c.monsters) {
  check("a monster dies from the client's shots", afterLive < beforeLive, `live monster_* edicts ${beforeLive} -> ${afterLive}`);
}

await cl.run(["stop"]);
await sleep(1500);

// ---------------------------------------------------------------------------
// the client's own view of the negotiated protocol
// ---------------------------------------------------------------------------

const clText = readLog(cl.seat);

// F20's own client-side observable: the client prints its negotiated
// protocol and flags directly (t_lib.ts's clientProtocolLine), so this is
// the primary assertion rather than something dug back out of the demo.
const clientProto = clientProtocolLine(clText);
check(
  "client negotiated the same protocol the server announced",
  clientProto !== null && clientProto.protocol === svProto.protocol,
  clientProto === null ? `no "Client protocol" line in ${cl.seat.log}` : `server ${svProto.protocol}, client ${clientProto.protocol}`,
);
check(
  "client negotiated the same protocol flags the server announced",
  clientProto !== null && clientProto.flags === svProto.flags,
  clientProto === null ? `no "Client protocol" line in ${cl.seat.log}` : `server 0x${svProto.flags.toString(16)}, client 0x${clientProto.flags.toString(16)}`,
);

// The recorded demo is kept as a fallback cross-check against what actually
// landed on the wire, and is still the only place the level title the
// client parsed out of the serverinfo is observable.
const demoPath = recordedDemoPath(clText);
const demo = demoPath === null ? null : readDemoServerInfo(demoPath);
check("the client recorded the session", demo !== null, demo !== null ? `${demoPath ?? ""}` : demoPath === null ? "no 'recording to <path>.' line in the client log" : `${demoPath}: no serverinfo message in the demo`);

if (demo !== null) {
  check(
    "the demo's serverinfo carries the same protocol and flags",
    demo.protocol === svProto.protocol && demo.flags === svProto.flags,
    `server ${svProto.protocol}/0x${svProto.flags.toString(16)}, demo ${demo.protocol}/0x${demo.flags.toString(16)}`,
  );
  check(
    "the level title on the client is the one in the serverinfo",
    title !== null && demo.levelname.trim() === title.trim(),
    `client console "${title ?? ""}" vs serverinfo "${demo.levelname}"`,
  );
}

/*
Report-only defect check (E2E-COMMON: the driver asserts the CORRECT
behaviour and stays red until the engine is fixed). Two console lines written
to a dedicated server's stdin in the same frame must stay two commands.
Sys_ConsoleInput queues whole stdin chunks and Host_GetConsoleCommands
(src/common/host.ts:976) drains the queue in one frame, appending each chunk
to the command buffer with no separator, so today they are concatenated.
*/
{
  const before = readLog(sv).length;
  consoleLine(sv, "version");
  consoleLine(sv, "echo T_SV_GLUE_END");
  await waitFor(sv, "T_SV_GLUE_END", 20000);
  const out = readLog(sv).slice(before);
  check(
    "two console lines sent to the dedicated server stay two commands",
    /Version \d/.test(out) && /T_SV_GLUE_END/.test(out) && !/versionecho/.test(out),
    out.replace(/\n/g, " | ").slice(0, 200),
  );
}

check("neither seat hit a fatal engine error", !/Sys_Error|SysError|Fatal:|Host_Error/.test(readLog(sv) + clText), (readLog(sv) + clText).match(/.*(Sys_Error|Fatal:|Host_Error).*/g)?.slice(0, 2).join(" | ") ?? "");

killSeat(cl.seat);
killSeat(sv);
summary(`t_matrix ${slug}`);
