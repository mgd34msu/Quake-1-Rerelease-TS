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
    flags, read back out of the serverinfo bytes in a demo it recorded from
    before the connect;
  - the client reached the level: it printed the level title, and the title in
    its demo is the same one;
  - the player can move: the server's `edict 1` origin changes across a
    `+forward` phase;
  - the player can fire: `edict 1`'s currentammo drops across a `+attack`
    phase;
  - a monster dies from the client's shots: fewer `monster_*` edicts are still
    solid in the server's `edicts` dump after the fight than before it.

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
  consoleLine,
  svQuery,
  contentById,
  echoMarker,
  edictNumber,
  edictVector,
  killSeat,
  lastEdict,
  marker,
  parseEdicts,
  readDemoServerInfo,
  readLog,
  recordedDemoPath,
  serverProtocolLine,
  serverRuleset,
  sleep,
  startClient,
  startServer,
  summary,
  waits,
  waitFor,
  type SeatT,
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
The console timeline. quake.rc leaves the client inside `startdemos demo1
demo2 demo3`, which puts cls.state at ca_connected and makes `record` refuse,
so the disconnect/record/connect trio runs in ONE console frame -- no `wait`
between them, or a demo restarts in the gap.
*/
const script: string[] = [
  "cl_shownet 0",
  ...waits(120),
  "disconnect",
  `record ${DEMO}`,
  "connect 127.0.0.1",
  ...waits(500),
  echoMarker("CONNECTED"),
  ...waits(60),
  // One impulse per console frame: `impulse` sets a single `in_impulse` that
  // CL_SendMove puts in the next usercmd, so two in one frame lose the first.
  "god",
  ...waits(20),
  "impulse 9",
  ...waits(40),
  "impulse 4",
  ...waits(120),
  echoMarker("ARMED"),
  "+forward",
  ...waits(200),
  "-forward",
  ...waits(40),
  echoMarker("MOVED"),
  "+attack",
  ...waits(160),
  "-attack",
  ...waits(60),
  echoMarker("FIRED"),
  echoMarker("PREFIGHT"),
  ...waits(60),
  /*
  The fight. The rocket launcher (splash damage, so a near miss still kills)
  fired continuously while the player walks and sweeps its yaw: two headless
  clients cannot aim, and the monsters on a single-player map are not in front
  of the spawn, so the shots have to be sprayed down the corridors the
  monsters come out of. `god` keeps the player's own splash damage from
  ending the run. `noclip` is deliberately NOT used -- a player inside the
  geometry detonates every rocket on the wall it is standing in.
  */
  "impulse 7",
  ...waits(20),
  "+attack",
  ...waits(20),
  "+forward",
  ...(() => {
    const loop: string[] = [];
    for (let i = 0; i < 20; i++) {
      loop.push("+right", ...waits(40), "-right", ...waits(80), "+left", ...waits(40), "-left", ...waits(80));
    }
    return loop;
  })(),
  "-attack",
  "-forward",
  ...waits(60),
  echoMarker("FOUGHT"),
  "stop",
  ...waits(40),
  echoMarker("DONE"),
];

const clientArgs = [...baseArgs(c, clGame), "-port", port];
const cl = startClient(`t_matrix_${slug}_cl`, clGame, clientArgs, script);

async function phase(seat: SeatT, name: string, timeoutMs: number): Promise<boolean> {
  const ok = await waitFor(seat, marker(name), timeoutMs);
  if (!ok) console.log(`t_matrix: client never reached phase ${name}`);
  return ok;
}

const connected = await phase(cl, "CONNECTED", 90000);
check("client connects and reaches the level", connected && /entered the game/.test(readLog(sv)), `server log: ${(readLog(sv).match(/.*entered the game.*/g) ?? []).slice(-1).join("")}`);

const title = clientLevelTitle(readLog(cl));
check("client printed the level title it was sent", title !== null && title.length > 0, `title=${title ?? "(none)"}`);

const statusOut = await svQuery(sv, "status", "STATUS");
check("server status names the map and one active player", new RegExp(`map:\\s+${c.map}`).test(statusOut) && /players:\s*1 active/.test(statusOut), statusOut.replace(/\n/g, " | ").slice(0, 240));

const armed = await phase(cl, "ARMED", 60000);
const sampleA = lastEdict(await svQuery(sv, "edict 1", "A"), 1);
check("server can report the connected player's edict", armed && sampleA !== null, sampleA === null ? "no EDICT 1 block in the server log" : `classname=${sampleA.fields.get("classname") ?? "?"}`);

const moved = await phase(cl, "MOVED", 90000);
const sampleB = lastEdict(await svQuery(sv, "edict 1", "B"), 1);
const originA = edictVector(sampleA, "origin");
const originB = edictVector(sampleB, "origin");
const movedFar =
  originA !== null && originB !== null && Math.hypot(originB[0] - originA[0], originB[1] - originA[1], originB[2] - originA[2]) > 8;
check("the player moves when the client holds +forward", moved && movedFar, `origin ${JSON.stringify(originA)} -> ${JSON.stringify(originB)}`);

const fired = await phase(cl, "FIRED", 90000);
const sampleC = lastEdict(await svQuery(sv, "edict 1", "C"), 1);
const ammoB = edictNumber(sampleB, "currentammo");
const ammoC = edictNumber(sampleC, "currentammo");
check("the player's ammo drops when the client holds +attack", fired && ammoC < ammoB, `currentammo ${ammoB} -> ${ammoC} (weapon ${edictNumber(sampleB, "weapon")})`);

/** `monster_*` edicts still solid, i.e. alive: a killed monster goes SOLID_NOT and a gibbed one is freed outright. */
function liveMonsters(dump: string): number {
  let n = 0;
  for (const e of parseEdicts(dump)) {
    if (!(e.fields.get("classname") ?? "").startsWith("monster_")) continue;
    if (edictNumber(e, "solid") !== 0) n++;
  }
  return n;
}

await phase(cl, "PREFIGHT", 60000);
const dumpBefore = await svQuery(sv, "edicts", "M1");
const beforeLive = liveMonsters(dumpBefore);

const fought = await phase(cl, "FOUGHT", 180000);
const dumpAfter = await svQuery(sv, "edicts", "M2");
const afterLive = liveMonsters(dumpAfter);

if (c.monsters) {
  check("the map spawned monsters to fight", beforeLive > 0, `${beforeLive} live monster_* edicts on ${c.map}`);
  check("a monster dies from the client's shots", afterLive < beforeLive, `live monster_* edicts ${beforeLive} -> ${afterLive}`);
} else {
  check("a monster-free map spawns no monsters", beforeLive === 0, `${beforeLive} live monster_* edicts on ${c.map}`);
}

// ---------------------------------------------------------------------------
// the client's own view of the negotiated protocol
// ---------------------------------------------------------------------------

await phase(cl, "DONE", 60000);
await sleep(1500);

const clText = readLog(cl);
const demoPath = recordedDemoPath(clText);
const demo = demoPath === null ? null : readDemoServerInfo(demoPath);
check("the client recorded the session", demo !== null, demo !== null ? `${demoPath ?? ""}` : demoPath === null ? "no 'recording to <path>.' line in the client log" : `${demoPath}: no serverinfo message in the demo`);

if (demo !== null) {
  check(
    "client negotiated the same protocol the server announced",
    demo.protocol === svProto.protocol,
    `server ${svProto.protocol}, client ${demo.protocol}`,
  );
  check(
    "client negotiated the same protocol flags the server announced",
    demo.flags === svProto.flags,
    `server 0x${svProto.flags.toString(16)}, client 0x${demo.flags.toString(16)}`,
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

killSeat(cl);
killSeat(sv);
summary(`t_matrix ${slug}`);
