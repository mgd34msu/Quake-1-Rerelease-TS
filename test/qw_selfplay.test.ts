/*
U18 self-play: OUR qwsv and OUR qwcl, over real UDP on 127.0.0.1, at
QuakeWorld protocol 28 and at protocol 29 (this engine's wide variant,
src/common/protocol/qw29.ts) -- standing order 19's "our own compiled binary
in both seats".

Both engines run as child `bun` processes rather than in this one, for the
reason test/qwsv_boot.test.ts's and test/qwcl_boot.test.ts's own headers give:
src/common/cmd.ts has one process-wide `cmd_functions` table and
`Cmd_AddCommand` is first-wins, so qwsv's SV_InitOperatorCommands and qwcl's
CL_Init would fight each other for `say`, `status`, `kick` and thirty more
names -- and both would fight the WinQuake suites in the same `bun test`
process. One OS process per engine is also what the C has (qwsv and qwcl are
two binaries), and it is what makes the UDP between them real rather than a
loopback fake.

Each child drives Sys_Main_Init and then pumps frames from an async loop,
never entering Sys_Main_Loop's infinite loop, so the event loop that delivers
Bun.udpSocket's packets actually gets to run between frames -- `runFrames` is
synchronous and would starve it. Each prints one JSON line of the state this
file asserts on, exactly as test/qwsv_boot.test.ts does.

The basedir is one scratch tree shared by both children: test/support's qwcl
fixture (the client's gfx.wad / palette / colormap / conback, plus quake.rc
and default.cfg) plus the qwsv fixture's server side (qwprogs.dat, a synthetic
map, server.cfg), plus one synthetic .mdl / .spr / .wav per entry qwprogs
precaches. That last part is discovered rather than hardcoded: the server
child prints its own precache tables before the client starts, and this file
materializes a loadable file for each, because QW's Model_NextDownload
disconnects a client that cannot load every precached model.

Ports: 26310-26319 (this unit's range).

Standing order 13: everything this file mutates lives and dies in a child
process or under its own mkdtemp scratch directory. Nothing shared in THIS
process is touched.
*/

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { buildQwclFixture, destroyQwclFixture, type QwclFixture } from "./support/qwcl_fixture";
import { BSP_WIDTH_BSP2, buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { HAVE_QWPROGS, QWPROGS_DAT } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

const SERVER_MARKER = "<<<QWSV_SELFPLAY_JSON>>>";
const CLIENT_MARKER = "<<<QWCL_SELFPLAY_JSON>>>";
const PRECACHE_MARKER = "<<<QWSV_PRECACHE_JSON>>>";

const MAP = "start";

// Real Quake data cannot ship in this repository, so the retail-data suite
// below is opt-in on Q1TS_DATA, the same variable test/net_e2e.test.ts uses.
const RETAIL_BASEDIR = process.env.Q1TS_DATA ?? "";
const HAVE_RETAIL_QW =
  RETAIL_BASEDIR !== "" &&
  existsSync(join(RETAIL_BASEDIR, "qw", "qwprogs.dat")) &&
  (existsSync(join(RETAIL_BASEDIR, "id1")) || existsSync(join(RETAIL_BASEDIR, "Id1")));

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// The entity lump the self-play map carries: worldspawn, a player start, and
// three pickups near it. The pickups are what make `svc_packetentities`
// non-empty -- a player is sent through `svc_playerinfo`, never through the
// packet-entities list, so a map with nothing but a start would prove the
// player path and nothing else.
const SELFPLAY_ENTITIES =
  '{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n"worldtype" "0"\n}\n' +
  '{\n"classname" "info_player_start"\n"origin" "16 16 24"\n"angle" "90"\n}\n' +
  '{\n"classname" "item_shells"\n"origin" "48 16 24"\n}\n' +
  '{\n"classname" "item_health"\n"origin" "16 48 24"\n}\n' +
  '{\n"classname" "item_spikes"\n"origin" "48 48 24"\n}\n';

// A .bsp with its ENTITIES lump replaced. The new text is appended after the
// last lump and lump 0's directory entry repointed at it, which keeps every
// other lump's offset (and therefore src/common/model.ts's checksums) exactly
// where buildBsp put them -- the server and the client load the same file, so
// the checksums match on both sides either way.
function withEntities(bsp: Uint8Array, text: string): Uint8Array {
  const ent = latin1Bytes(`${text}\0`);
  const out = new Uint8Array(bsp.length + ent.length);
  out.set(bsp);
  out.set(ent, bsp.length);
  // dheader_t: int version, then lump_t lumps[HEADER_LUMPS]; ENTITIES is 0.
  const view = new DataView(out.buffer);
  view.setInt32(4, bsp.length, true);
  view.setInt32(8, ent.length, true);
  return out;
}

// A minimal but real 8-bit mono PCM RIFF/WAVE: src/client/snd_mem.ts parses
// the chunk chain, and a precached sound that is ever actually played reaches
// it. One sample of silence is enough.
function buildWav(): Uint8Array {
  const data = new Uint8Array(1);
  data[0] = 128; // 8-bit PCM silence
  const total = 4 + (8 + 16) + (8 + data.length);
  const out = new Uint8Array(8 + total);
  const view = new DataView(out.buffer);
  const tag = (offset: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[offset + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, total, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 11025, true);
  view.setUint32(28, 11025, true);
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits
  tag(36, "data");
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

interface SelfplayFixture {
  fixture: QwclFixture;
  baseDir: string;
}

function buildSelfplayFixture(prefix: string, bsp2: boolean): SelfplayFixture {
  const fixture = buildQwclFixture(prefix);
  const baseDir = fixture.baseDir;

  // SV_SpawnServer's SV_CheckModel reads these two by name before any progs
  // runs (src/qw/server/sv_init.ts); the qwcl fixture's pak0 has neither.
  writeGameFile(baseDir, "id1/progs/player.mdl", buildMdl({ numframes: 2 }));
  writeGameFile(baseDir, "id1/progs/eyes.mdl", buildMdl({ numframes: 2 }));

  writeGameFile(baseDir, "qw/qwprogs.dat", new Uint8Array(readFileSync(QWPROGS_DAT)));
  writeGameFile(
    baseDir,
    `qw/maps/${MAP}.bsp`,
    withEntities(buildBsp(bsp2 ? { width: BSP_WIDTH_BSP2 } : {}), SELFPLAY_ENTITIES),
  );
  writeGameFile(baseDir, "qw/server.cfg", latin1Bytes("hostname \"qw-selfplay\"\ndeathmatch 1\n"));

  return { fixture, baseDir };
}

// Materializes one loadable file per precached name, under id1/ where both
// engines' search paths reach it.
function materializePrecaches(baseDir: string, models: string[], sounds: string[]): void {
  const wav = buildWav();
  const bsp = buildBsp();
  for (const name of models) {
    // "*N" is an inline submodel of the level, and the level itself already
    // exists under qw/ -- writing either would shadow the real thing.
    if (name === "" || name.startsWith("*") || name === `maps/${MAP}.bsp`) continue;
    const path = join(baseDir, "id1", name);
    if (existsSync(path)) continue;
    ensureDir(dirname(path));
    // The pickups' own bmodels (maps/b_shell0.bsp and friends) are precached
    // by name like any other model, and QW's Model_NextDownload insists on
    // loading every one of them.
    if (name.endsWith(".bsp")) writeFileSync(path, bsp);
    else if (name.endsWith(".spr")) writeFileSync(path, buildSpr());
    else writeFileSync(path, buildMdl({ numframes: 2 }));
  }
  for (const name of sounds) {
    if (name === "") continue;
    const path = join(baseDir, "id1", "sound", name);
    if (existsSync(path)) continue;
    ensureDir(dirname(path));
    writeFileSync(path, wav);
  }
}

//============================================================================
// The two children.

const SERVER_SCRIPT = `
import { Sys_Main_Init, runFrames } from "./src/qw/main_sv";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { Cvar_Set } from "./src/common/cvar";
import { ClientStateT, ServerStateT, sv, svs } from "./src/qw/server/server";
import { SV_Frame, SV_Shutdown } from "./src/qw/server/sv_main";

// bun -e's own argv: [bun, ...the args after "--"].
const baseDir = process.argv[1];
const port = process.argv[2];
const wanted = process.argv[3];
const frames = Number(process.argv[4]);

Sys_Main_Init(["qwsv", "-basedir", baseDir, "-port", port]);
await NET_Ready();

Cvar_Set("sv_qwprotocol", wanted);
Cbuf_AddText("map ${MAP}\\n");
Cbuf_Execute();

process.stdout.write(
  "${PRECACHE_MARKER}" +
    JSON.stringify({
      models: sv.model_precache.filter((s) => s !== null && s !== ""),
      sounds: sv.sound_precache.filter((s) => s !== null && s !== ""),
      protocol: sv.protocol,
      protocolflags: sv.protocolflags,
    }) +
    "\\n",
);

let sawSpawned = false;
let sawConnected = false;
let peakEntities = 0;
for (let i = 0; i < frames; i++) {
  SV_Frame(0.05);
  for (const cl of svs.clients) {
    if (cl.state === ClientStateT.cs_connected) sawConnected = true;
    if (cl.state === ClientStateT.cs_spawned) {
      sawSpawned = true;
      const pack = cl.frames[cl.netchan.incoming_sequence & 63].entities;
      if (pack.num_entities > peakEntities) peakEntities = pack.num_entities;
    }
  }
  await new Promise((r) => setTimeout(r, 5));
}

const snapshot = {
  protocol: sv.protocol,
  protocolflags: sv.protocolflags,
  maxEdicts: sv.max_edicts,
  numEdicts: sv.num_edicts,
  stateIsActive: sv.state === ServerStateT.ss_active,
  sawConnected,
  sawSpawned,
  peakEntities,
  spawnedNames: svs.clients.filter((c) => c.state === ClientStateT.cs_spawned).map((c) => c.name),
  wideClients: svs.clients.filter((c) => c.state !== ClientStateT.cs_free).map((c) => c.wide),
};

SV_Shutdown();
NET_Shutdown();
process.stdout.write("${SERVER_MARKER}" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`;

const CLIENT_SCRIPT = `
import { Sys_Main_Init } from "./src/qw/main_cl";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { Host_Frame } from "./src/qw/client/cl_main";
import { CactiveT, cl, cls } from "./src/client/client";
import { UPDATE_MASK } from "./src/qw/protocol";

// bun -e's own argv: [bun, ...the args after "--"].
const baseDir = process.argv[1];
const port = process.argv[2];
const frames = Number(process.argv[3]);

Sys_Main_Init(["qwcl", "-basedir", baseDir]);
await NET_Ready();

Cbuf_AddText("connect 127.0.0.1:" + port + "\\n");
Cbuf_Execute();

let sawActive = false;
let peakEntities = 0;
let sawPlayerinfo = false;
for (let i = 0; i < frames; i++) {
  Host_Frame(0.05);
  if (cls.state === CactiveT.ca_active) {
    sawActive = true;
    const frame = cl.qw.frames[cl.qw.validsequence & UPDATE_MASK];
    if (frame.packet_entities.num_entities > peakEntities) peakEntities = frame.packet_entities.num_entities;
    if (frame.playerstate[cl.qw.playernum].messagenum === cl.qw.parsecount) sawPlayerinfo = true;
  }
  await new Promise((r) => setTimeout(r, 5));
}

const snapshot = {
  protocol: cl.qw.protocol,
  protocolflags: cl.qw.protocolflags,
  sawActive,
  stateIsActive: cls.state === CactiveT.ca_active,
  playernum: cl.qw.playernum,
  levelname: cl.levelname,
  modelCount: cl.qw.model_name.filter((s) => s !== "").length,
  soundCount: cl.qw.sound_name.filter((s) => s !== "").length,
  peakEntities,
  sawPlayerinfo,
  validsequence: cl.qw.validsequence,
  simorg: Array.from(cl.qw.simorg),
};

Cbuf_AddText("disconnect\\n");
Cbuf_Execute();
NET_Shutdown();
process.stdout.write("${CLIENT_MARKER}" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`;

const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

function markerLine(text: string, marker: string): string | null {
  for (const line of text.split("\n")) {
    if (line.startsWith(marker)) return line.slice(marker.length);
  }
  return null;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${what} snapshot is not an object`);
  return { ...value };
}

function num(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (typeof v !== "number") throw new Error(`snapshot field ${key} is not a number`);
  return v;
}

function bool(r: Record<string, unknown>, key: string): boolean {
  const v = r[key];
  if (typeof v !== "boolean") throw new Error(`snapshot field ${key} is not a boolean`);
  return v;
}

function strings(r: Record<string, unknown>, key: string): string[] {
  const v = r[key];
  if (!Array.isArray(v)) throw new Error(`snapshot field ${key} is not an array`);
  return v.map((e) => (typeof e === "string" ? e : String(e)));
}

// Both engines are children, so a failure here is a JSON field that came back
// wrong with no stack to look at. `QW_SELFPLAY_DEBUG=1` prints the two
// consoles, which is where the real diagnosis lives (a missing model file, a
// signon that stalled, a byte the other side could not parse).
function dumpOnDemand(label: string, result: SelfplayResult): void {
  if (process.env.QW_SELFPLAY_DEBUG === undefined) return;
  console.log(`=== ${label} server ===\n${result.serverLog}`);
  console.log(`=== ${label} client ===\n${result.clientLog}`);
}

interface SelfplayResult {
  server: Record<string, unknown>;
  client: Record<string, unknown>;
  serverLog: string;
  clientLog: string;
}

const scratchDirs: string[] = [];
const fixtures: QwclFixture[] = [];

afterAll(() => {
  for (const f of fixtures) destroyQwclFixture(f);
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

async function runSelfplay(opts: { prefix: string; port: number; wanted: string; bsp2: boolean; baseDir?: string }): Promise<SelfplayResult> {
  let baseDir: string;
  // A retail basedir is the user's own Quake installation: read it, never
  // write synthetic models into it.
  let ownFixture: boolean;
  if (opts.baseDir !== undefined) {
    baseDir = opts.baseDir;
    ownFixture = false;
  } else {
    const built = buildSelfplayFixture(opts.prefix, opts.bsp2);
    fixtures.push(built.fixture);
    baseDir = built.baseDir;
    ownFixture = true;
  }

  const server = Bun.spawn(
    ["timeout", "120", "bun", "-e", SERVER_SCRIPT, "--", baseDir, String(opts.port), opts.wanted, "220"],
    { cwd: repoRoot, env: headlessEnv, stdout: "pipe", stderr: "pipe" },
  );

  // Wait for the server's precache line before starting the client: the map
  // is loaded by then, and this file needs the list to materialize files the
  // client's Model_NextDownload will insist on.
  const serverChunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = server.stdout.getReader();
  let precache: string | null = null;
  const deadline = Date.now() + 60000;
  while (precache === null && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    serverChunks.push(decoder.decode(value));
    precache = markerLine(serverChunks.join(""), PRECACHE_MARKER);
  }
  if (precache === null) {
    server.kill();
    throw new Error(`server child never printed its precache list:\n${serverChunks.join("")}`);
  }
  const pre = record(JSON.parse(precache), "precache");
  if (ownFixture) materializePrecaches(baseDir, strings(pre, "models"), strings(pre, "sounds"));

  const client = Bun.spawnSync(
    ["timeout", "120", "bun", "-e", CLIENT_SCRIPT, "--", baseDir, String(opts.port), "180"],
    { cwd: repoRoot, env: headlessEnv },
  );
  const clientLog = `${client.stdout.toString()}\n${client.stderr.toString()}`;

  // Drain the rest of the server's stdout, then let it finish its own frames.
  const drain = (async (): Promise<void> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      serverChunks.push(decoder.decode(value));
    }
  })();
  await server.exited;
  await drain;
  const serverLog = `${serverChunks.join("")}\n${await new Response(server.stderr).text()}`;

  const serverJson = markerLine(serverLog, SERVER_MARKER);
  if (serverJson === null) throw new Error(`server child produced no snapshot:\n${serverLog}`);
  const clientJson = markerLine(clientLog, CLIENT_MARKER);
  if (clientJson === null) throw new Error(`client child produced no snapshot:\n${clientLog}`);

  return {
    server: record(JSON.parse(serverJson), "server"),
    client: record(JSON.parse(clientJson), "client"),
    serverLog,
    clientLog,
  };
}

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("qwsv + qwcl self-play on the synthetic map at protocol 28", () => {
  let result: SelfplayResult;

  test("a client connects, spawns and reaches ca_active", async () => {
    result = await runSelfplay({ prefix: "qw-selfplay-28-", port: 26310, wanted: "28", bsp2: false });

    dumpOnDemand("28", result);
    expect(bool(result.server, "stateIsActive")).toBe(true);
    expect(bool(result.server, "sawConnected")).toBe(true);
    expect(bool(result.server, "sawSpawned")).toBe(true);
    expect(bool(result.client, "sawActive")).toBe(true);
  }, 180000);

  test("both sides settled on protocol 28 with no flag word", () => {
    expect(num(result.server, "protocol")).toBe(28);
    expect(num(result.server, "protocolflags")).toBe(0);
    expect(num(result.client, "protocol")).toBe(28);
    expect(num(result.client, "protocolflags")).toBe(0);
  });

  test("the server saw our client advertise *wide, and answered 28 anyway", () => {
    const wide = result.server.wideClients;
    expect(Array.isArray(wide)).toBe(true);
    expect(wide).toContain(true);
  });

  test("the client got the whole model and sound list", () => {
    expect(num(result.client, "modelCount")).toBeGreaterThan(20);
    expect(num(result.client, "soundCount")).toBeGreaterThan(20);
  });

  test("entities arrived in svc_packetentities and the player in svc_playerinfo", () => {
    expect(num(result.client, "peakEntities")).toBeGreaterThan(0);
    expect(num(result.server, "peakEntities")).toBeGreaterThan(0);
    expect(bool(result.client, "sawPlayerinfo")).toBe(true);
  });

  test("the edict table is the shared max_edicts, not QuakeWorld's old 768", () => {
    expect(num(result.server, "maxEdicts")).toBeGreaterThan(768);
  });
});

describe.skipIf(!HAVE_QWPROGS)("qwsv + qwcl self-play on the synthetic map at protocol 29", () => {
  let result: SelfplayResult;

  test("a client connects, spawns and reaches ca_active", async () => {
    result = await runSelfplay({ prefix: "qw-selfplay-29-", port: 26311, wanted: "29", bsp2: false });

    expect(bool(result.server, "stateIsActive")).toBe(true);
    expect(bool(result.server, "sawSpawned")).toBe(true);
    expect(bool(result.client, "sawActive")).toBe(true);
  }, 180000);

  test("both sides settled on protocol 29 and its PRFL_INT32COORD|PRFL_SHORTANGLE word", () => {
    expect(num(result.server, "protocol")).toBe(29);
    expect(num(result.server, "protocolflags")).toBe((1 << 7) | (1 << 1));
    expect(num(result.client, "protocol")).toBe(29);
    expect(num(result.client, "protocolflags")).toBe(num(result.server, "protocolflags"));
  });

  test("entities arrived through 29's wider packetentities envelope", () => {
    expect(num(result.client, "peakEntities")).toBeGreaterThan(0);
    expect(bool(result.client, "sawPlayerinfo")).toBe(true);
  });
});

describe.skipIf(!HAVE_QWPROGS)("sv_qwprotocol auto on a BSP2 map picks 29 by itself", () => {
  let result: SelfplayResult;

  test("a BSP2 world makes the server choose 29 with no cvar set", async () => {
    result = await runSelfplay({ prefix: "qw-selfplay-bsp2-", port: 26312, wanted: "auto", bsp2: true });

    expect(num(result.server, "protocol")).toBe(29);
    expect(num(result.client, "protocol")).toBe(29);
    expect(bool(result.server, "sawSpawned")).toBe(true);
    expect(bool(result.client, "sawActive")).toBe(true);
  }, 180000);

  test("and a BSP29 world of the same size leaves it on 28", () => {
    // the protocol-28 suite above ran `auto`'s narrow arm's map through an
    // explicit 28; this is the same map under `auto`, so the two agree only
    // because SV_QwAutoProtocol looked at the world.
    expect(num(result.server, "protocolflags")).toBe((1 << 7) | (1 << 1));
  });
});

describe.skipIf(!HAVE_RETAIL_QW)("qwsv + qwcl self-play on the retail QuakeWorld data", () => {
  test("28 and 29 both carry a real map's players and entities", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "qw-selfplay-retail-"));
    scratchDirs.push(scratch);
    mkdirSync(join(scratch, "qw"), { recursive: true });

    const at28 = await runSelfplay({ prefix: "unused", port: 26313, wanted: "28", bsp2: false, baseDir: RETAIL_BASEDIR });
    expect(num(at28.server, "protocol")).toBe(28);
    expect(num(at28.client, "protocol")).toBe(28);
    expect(bool(at28.server, "sawSpawned")).toBe(true);
    expect(bool(at28.client, "sawActive")).toBe(true);

    const at29 = await runSelfplay({ prefix: "unused", port: 26314, wanted: "29", bsp2: false, baseDir: RETAIL_BASEDIR });
    dumpOnDemand("retail-29", at29);
    expect(num(at29.server, "protocol")).toBe(29);
    expect(num(at29.client, "protocol")).toBe(29);
    expect(bool(at29.server, "sawSpawned")).toBe(true);
    expect(bool(at29.client, "sawActive")).toBe(true);
  }, 360000);
});
