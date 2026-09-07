/*
U32 part 1: one client object serving both protocol families in one process
(ARCHITECTURE.md "Unified client and server").

The client is booted once, as the NetQuake profile, and then:
  1. hosts a NetQuake listen server on a synthetic map and enters it
     (`cls.profile` "nq", `cl.protocol` a NetQuake protocol, cls.signon at
     SIGNONS),
  2. disconnects -- which returns the client to its boot profile,
  3. `connect 127.0.0.1:<port>` to a child-process qwsv over real UDP, which
     the connect rule (src/common/profile.ts: an address with an explicit
     port) resolves to QuakeWorld: the client brings the QuakeWorld half up,
     runs the getchallenge handshake and reaches ca_active with `cls.profile`
     "qw",
  4. and reports both legs' state from the SAME `cl`/`cls` singletons.

Run at QuakeWorld protocol 28 and again at 29 (this engine's wide variant),
so both legs of the codec seam are exercised through the unified client.

Why the client is a child `bun` process: a full Host_Init in the `bun test`
process would register every command and cvar the whole engine has and leave
them there for every other file (the reason test/qwcl_boot.test.ts,
test/qwsv_boot.test.ts and test/qw_selfplay.test.ts each use a child too).
Everything the assertions read is printed as one JSON line. THIS process
mutates nothing shared: the fixtures live under mkdtemp scratch trees that
afterAll removes.

Ports: 26320-26329 (this unit's range).
*/

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildQwclFixture, destroyQwclFixture, type QwclFixture } from "./support/qwcl_fixture";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { HAVE_PROGS106, HAVE_QWPROGS, PROGS106_DAT, QWPROGS_DAT } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

const SERVER_MARKER = "<<<U32_QWSV_JSON>>>";
const PRECACHE_MARKER = "<<<U32_PRECACHE_JSON>>>";
const CLIENT_MARKER = "<<<U32_CLIENT_JSON>>>";

const NQ_MAP = "nqstart";
const QW_MAP = "start"; // qwsv's own SV_Init falls back to `map start` when server.cfg spawns nothing

const HAVE_BOTH = HAVE_PROGS106 && HAVE_QWPROGS;

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// worldspawn, a player start, and three pickups so svc_packetentities has
// something to carry -- test/qw_selfplay.test.ts's own entity lump.
const ENTITIES =
  '{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n"worldtype" "0"\n}\n' +
  '{\n"classname" "info_player_start"\n"origin" "16 16 24"\n"angle" "90"\n}\n' +
  '{\n"classname" "item_shells"\n"origin" "48 16 24"\n}\n' +
  '{\n"classname" "item_health"\n"origin" "16 48 24"\n}\n' +
  '{\n"classname" "item_spikes"\n"origin" "48 48 24"\n}\n';

// A .bsp with its ENTITIES lump replaced, appended after the last lump so no
// other lump's offset (and therefore no checksum) moves.
function withEntities(bsp: Uint8Array, text: string): Uint8Array {
  const ent = latin1Bytes(`${text}\0`);
  const out = new Uint8Array(bsp.length + ent.length);
  out.set(bsp);
  out.set(ent, bsp.length);
  const view = new DataView(out.buffer);
  view.setInt32(4, bsp.length, true);
  view.setInt32(8, ent.length, true);
  return out;
}

// One sample of 8-bit mono PCM silence: enough for src/client/snd_mem.ts.
function buildWav(): Uint8Array {
  const out = new Uint8Array(45);
  const view = new DataView(out.buffer);
  const tag = (offset: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[offset + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 37, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 11025, true);
  view.setUint32(28, 11025, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, "data");
  view.setUint32(40, 1, true);
  out[44] = 128;
  return out;
}

function buildFixture(prefix: string): QwclFixture {
  const fixture = buildQwclFixture(prefix);
  const baseDir = fixture.baseDir;

  // SV_SpawnServer's SV_CheckModel reads these two by name before any progs
  // runs, on both trees.
  writeGameFile(baseDir, "id1/progs/player.mdl", buildMdl({ numframes: 2 }));
  writeGameFile(baseDir, "id1/progs/eyes.mdl", buildMdl({ numframes: 2 }));

  // The NetQuake leg: id1's own progs.dat and map.
  writeGameFile(baseDir, "id1/progs.dat", new Uint8Array(readFileSync(PROGS106_DAT)));
  writeGameFile(baseDir, `id1/maps/${NQ_MAP}.bsp`, withEntities(buildBsp(), ENTITIES));

  // The QuakeWorld leg: qw/ is what the client's own gamedir switch mounts
  // and what the qwsv child serves out of.
  writeGameFile(baseDir, "qw/qwprogs.dat", new Uint8Array(readFileSync(QWPROGS_DAT)));
  writeGameFile(baseDir, `qw/maps/${QW_MAP}.bsp`, withEntities(buildBsp(), ENTITIES));
  writeGameFile(baseDir, "qw/server.cfg", latin1Bytes('hostname "u32-unified"\ndeathmatch 1\n'));

  return fixture;
}

// One loadable file per precached name, under id1/ where both engines reach
// it: QW's Model_NextDownload drops a client that cannot load every model.
function materializePrecaches(baseDir: string, models: string[], sounds: string[]): void {
  const wav = buildWav();
  const bsp = buildBsp();
  for (const name of models) {
    if (name === "" || name.startsWith("*") || name === `maps/${QW_MAP}.bsp`) continue;
    const path = join(baseDir, "id1", name);
    if (existsSync(path)) continue;
    ensureDir(dirname(path));
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
// The qwsv child: test/qw_selfplay.test.ts's own server driver.

const SERVER_SCRIPT = `
import { Sys_Main_Init } from "./src/qw/main_sv";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { Cvar_Set } from "./src/common/cvar";
import { ClientStateT, sv, svs } from "./src/qw/server/server";
import { SV_Frame, SV_Shutdown } from "./src/qw/server/sv_main";

const baseDir = process.argv[1];
const port = process.argv[2];
const wanted = process.argv[3];
const frames = Number(process.argv[4]);

Sys_Main_Init(["qwsv", "-basedir", baseDir, "-port", port]);
await NET_Ready();

Cvar_Set("sv_qwprotocol", wanted);
Cbuf_AddText("map ${QW_MAP}\\n");
Cbuf_Execute();

process.stdout.write(
  "${PRECACHE_MARKER}" +
    JSON.stringify({
      models: sv.model_precache.filter((s) => s !== null && s !== ""),
      sounds: sv.sound_precache.filter((s) => s !== null && s !== ""),
    }) +
    "\\n",
);

let sawSpawned = false;
for (let i = 0; i < frames; i++) {
  SV_Frame(0.05);
  for (const cl of svs.clients) if (cl.state === ClientStateT.cs_spawned) sawSpawned = true;
  await new Promise((r) => setTimeout(r, 5));
}

SV_Shutdown();
NET_Shutdown();
process.stdout.write("${SERVER_MARKER}" + JSON.stringify({ protocol: sv.protocol, sawSpawned }) + "\\n");
process.exit(0);
`;

//============================================================================
// The unified client child: ONE boot, both connections.

const CLIENT_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { NET_Ready } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { CactiveT, SIGNONS, cl, cls } from "./src/client/client";
import { CL_QwProfileInitialized } from "./src/client/cl_main";
import { clientProfile } from "./src/common/profile";
import { sv } from "./src/server/server";

const baseDir = process.argv[1];
const port = process.argv[2];

// One boot, no -qw: the NetQuake stack, with the connect rule live.
Sys_Main_Init(["quake", "-basedir", baseDir]);

const bootProfile = clientProfile();
const qwUpAtBoot = CL_QwProfileInitialized();

//-- leg 1: a NetQuake listen server on the synthetic map -------------------
Cbuf_AddText("map ${NQ_MAP}\\n");
Cbuf_Execute();
for (let i = 0; i < 60 && cls.signon < SIGNONS; i++) Host_Frame(0.05);

const nq = {
  profile: clientProfile(),
  signon: cls.signon,
  state: cls.state,
  protocol: cl.protocol,
  serverActive: sv.active,
  levelname: cl.levelname,
};

//-- disconnect: back to the boot profile ----------------------------------
Cbuf_AddText("disconnect\\n");
Cbuf_Execute();
const afterDisconnect = clientProfile();

//-- leg 2: a QuakeWorld server, over real UDP -----------------------------
// Back to the constructed default the demo loop starts life on. Leg 1's
// \`map\` cleared it, and a real NetQuake boot reaching a QuakeWorld server
// has run no \`map\` -- it still carries the 0 that lets quake.rc's
// \`startdemos\`, which sits BEHIND the boot cfg in the command buffer and so
// runs after the handshake, take the connection down.
cls.demonum = 0;

Cbuf_AddText("connect 127.0.0.1:" + port + "\\n");
Cbuf_Execute();
await NET_Ready();

let sawActive = false;
for (let i = 0; i < 220; i++) {
  Host_Frame(0.05);
  if (cls.state === CactiveT.ca_active) {
    sawActive = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5));
}

const qw = {
  profile: clientProfile(),
  sawActive,
  state: cls.state,
  protocol: cl.qw.protocol,
  protocolflags: cl.qw.protocolflags,
  playernum: cl.qw.playernum,
  modelCount: cl.qw.model_name.filter((s) => s !== "").length,
  soundCount: cl.qw.sound_name.filter((s) => s !== "").length,
  qwUp: CL_QwProfileInitialized(),
};

// quake.rc's own last line, run where it really lands: after the join.
Cbuf_AddText("startdemos demo1 demo2 demo3\\n");
Cbuf_Execute();
Host_Frame(0.05);

const afterStartdemos = {
  profile: clientProfile(),
  demonum: cls.demonum,
  demoplayback: cls.demoplayback,
  stillActive: cls.state === CactiveT.ca_active,
};

Cbuf_AddText("disconnect\\n");
Cbuf_Execute();

process.stdout.write(
  "${CLIENT_MARKER}" +
    JSON.stringify({ bootProfile, qwUpAtBoot, nq, afterDisconnect, qw, afterStartdemos, backToBoot: clientProfile() }) +
    "\\n",
);
process.exit(0);
`;

//============================================================================

const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

function markerLine(text: string, marker: string): string | null {
  for (const line of text.split("\n")) if (line.startsWith(marker)) return line.slice(marker.length);
  return null;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${what} snapshot is not an object`);
  return { ...value };
}

function sub(r: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(r[key], key);
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

function str(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`snapshot field ${key} is not a string`);
  return v;
}

function strings(r: Record<string, unknown>, key: string): string[] {
  const v = r[key];
  if (!Array.isArray(v)) throw new Error(`snapshot field ${key} is not an array`);
  return v.map((e) => (typeof e === "string" ? e : String(e)));
}

interface UnifiedResult {
  client: Record<string, unknown>;
  server: Record<string, unknown>;
  clientLog: string;
  serverLog: string;
}

const fixtures: QwclFixture[] = [];

afterAll(() => {
  for (const f of fixtures) destroyQwclFixture(f);
});

function dumpOnDemand(label: string, result: UnifiedResult): void {
  if (process.env.U32_UNIFIED_DEBUG === undefined) return;
  console.log(`=== ${label} qwsv ===\n${result.serverLog}`);
  console.log(`=== ${label} client ===\n${result.clientLog}`);
}

async function runUnified(opts: { prefix: string; port: number; wanted: string }): Promise<UnifiedResult> {
  const fixture = buildFixture(opts.prefix);
  fixtures.push(fixture);
  const baseDir = fixture.baseDir;

  const server = Bun.spawn(
    ["timeout", "180", "bun", "-e", SERVER_SCRIPT, "--", baseDir, String(opts.port), opts.wanted, "260"],
    { cwd: repoRoot, env: headlessEnv, stdout: "pipe", stderr: "pipe" },
  );

  // Wait for the precache list, then materialize a loadable file for each
  // name: QW's Model_NextDownload insists on loading every one.
  const serverChunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = server.stdout.getReader();
  let precache: string | null = null;
  const deadline = Date.now() + 90000;
  while (precache === null && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    serverChunks.push(decoder.decode(value));
    precache = markerLine(serverChunks.join(""), PRECACHE_MARKER);
  }
  if (precache === null) {
    server.kill();
    throw new Error(`qwsv child never printed its precache list:\n${serverChunks.join("")}`);
  }
  const pre = record(JSON.parse(precache), "precache");
  materializePrecaches(baseDir, strings(pre, "models"), strings(pre, "sounds"));

  const client = Bun.spawnSync(["timeout", "180", "bun", "-e", CLIENT_SCRIPT, "--", baseDir, String(opts.port)], {
    cwd: repoRoot,
    env: headlessEnv,
  });
  const clientLog = `${client.stdout.toString()}\n${client.stderr.toString()}`;

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

  const clientJson = markerLine(clientLog, CLIENT_MARKER);
  if (clientJson === null) throw new Error(`unified client produced no snapshot:\n${clientLog}`);
  const serverJson = markerLine(serverLog, SERVER_MARKER);
  if (serverJson === null) throw new Error(`qwsv child produced no snapshot:\n${serverLog}`);

  return {
    client: record(JSON.parse(clientJson), "client"),
    server: record(JSON.parse(serverJson), "server"),
    clientLog,
    serverLog,
  };
}

//============================================================================

describe.skipIf(!HAVE_BOTH)("one unified client, a NetQuake connection then a QuakeWorld one at protocol 28", () => {
  let result: UnifiedResult;

  test("both connections are made by the same client object", async () => {
    result = await runUnified({ prefix: "u32-unified-28-", port: 26320, wanted: "28" });
    dumpOnDemand("28", result);

    // the boot is NetQuake, and the QuakeWorld half is not up yet
    expect(str(result.client, "bootProfile")).toBe("nq");
    expect(bool(result.client, "qwUpAtBoot")).toBe(false);

    const nq = sub(result.client, "nq");
    expect(str(nq, "profile")).toBe("nq");
    expect(bool(nq, "serverActive")).toBe(true);
    expect(num(nq, "signon")).toBe(4); // SIGNONS

    // the disconnect returns the client to its boot profile
    expect(str(result.client, "afterDisconnect")).toBe("nq");

    const qw = sub(result.client, "qw");
    expect(bool(qw, "qwUp")).toBe(true);
    expect(str(qw, "profile")).toBe("qw");
    expect(bool(qw, "sawActive")).toBe(true);
  }, 300000);

  test("the connect rule put the ported client on QuakeWorld's protocol 28", () => {
    const qw = sub(result.client, "qw");
    expect(num(qw, "protocol")).toBe(28);
    expect(num(qw, "protocolflags")).toBe(0);
    expect(num(result.server, "protocol")).toBe(28);
    expect(bool(result.server, "sawSpawned")).toBe(true);
  });

  test("the NetQuake leg really entered a map on a NetQuake protocol", () => {
    const nq = sub(result.client, "nq");
    expect([15, 666, 999]).toContain(num(nq, "protocol"));
    expect(bool(nq, "serverActive")).toBe(true);
  });

  test("the QuakeWorld leg received the whole model and sound list", () => {
    const qw = sub(result.client, "qw");
    expect(num(qw, "modelCount")).toBeGreaterThan(20);
    expect(num(qw, "soundCount")).toBeGreaterThan(20);
  });

  test("and the client is back on its boot profile afterwards", () => {
    expect(str(result.client, "backToBoot")).toBe("nq");
  });

  test("quake.rc's demo loop cannot pull the QuakeWorld session down behind it", () => {
    const after = sub(result.client, "afterStartdemos");
    expect(num(after, "demonum")).toBe(-1);
    expect(bool(after, "demoplayback")).toBe(false);
    expect(bool(after, "stillActive")).toBe(true);
    expect(str(after, "profile")).toBe("qw");
  });
});

describe.skipIf(!HAVE_BOTH)("the same unified client against a protocol 29 server", () => {
  let result: UnifiedResult;

  test("the QuakeWorld leg spawns under 29 and its wide flag word", async () => {
    result = await runUnified({ prefix: "u32-unified-29-", port: 26321, wanted: "29" });
    dumpOnDemand("29", result);

    const qw = sub(result.client, "qw");
    expect(bool(qw, "sawActive")).toBe(true);
    expect(num(qw, "protocol")).toBe(29);
    expect(num(qw, "protocolflags")).toBe((1 << 7) | (1 << 1));
    expect(num(result.server, "protocol")).toBe(29);
    expect(bool(result.server, "sawSpawned")).toBe(true);
  }, 300000);

  test("the NetQuake leg is unaffected by the QuakeWorld one", () => {
    const nq = sub(result.client, "nq");
    expect(str(nq, "profile")).toBe("nq");
    expect(num(nq, "signon")).toBe(4);
    expect(bool(nq, "serverActive")).toBe(true);
  });
});
