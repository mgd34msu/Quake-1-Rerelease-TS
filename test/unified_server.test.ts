/*
U38: one binary serving either server (ARCHITECTURE.md "Unified client and
server"), the server-side half of test/unified_client.test.ts.

Three child `bun` processes, all of them `src/main.ts`:

  1. `-dedicated -qw` -- the boot `qwsv` is now a thin wrapper over. It spawns
     the QuakeWorld server on the synthetic map, and a fourth-argument client
     (`src/main.ts` with no `-qw`, `+connect 127.0.0.1:<port>`) joins it over
     real UDP and reaches ca_active at protocol 28. That client also runs
     `name` under the QuakeWorld profile and reports its userinfo, which is
     the collision ruling: WinQuake's `name` COMMAND, QuakeWorld's `name`
     CVAR as the storage.
  2. `-dedicated -noudp` -- a NetQuake dedicated server that switches servers
     twice through `sv_profile`: NetQuake map, then `sv_profile qw` + `map`,
     then `sv_profile nq` + `map` again. Asserts the one-server-at-a-time rule
     from both directions and that `status` reaches the server whose profile
     is in force, which is the console-source profile (src/common/cmd.ts's
     `Cmd_WithConsoleProfile`) doing its job. `-noudp` keeps WinQuake's own
     dgrm driver off the port the QuakeWorld server's SV_InitNet then takes,
     since both read the same `-port`.

Why child processes: a full Host_Init in the `bun test` process would register
every command and cvar the whole engine has and leave them there for every
other file (the same reason test/unified_client.test.ts, test/qwcl_boot.test.ts
and test/qw_selfplay.test.ts each use one). Everything the assertions read is
printed as one JSON line. THIS process mutates nothing shared: the fixtures
live under mkdtemp scratch trees that afterAll removes.

Ports: 26330-26339 (this unit's range).
*/

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildQwclFixture, destroyQwclFixture, type QwclFixture } from "./support/qwcl_fixture";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { HAVE_PROGS106, HAVE_QWPROGS, PROGS106_DAT, QWPROGS_DAT } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

const SERVER_MARKER = "<<<U38_SERVER_JSON>>>";
const PRECACHE_MARKER = "<<<U38_PRECACHE_JSON>>>";
const CLIENT_MARKER = "<<<U38_CLIENT_JSON>>>";
const SWITCH_MARKER = "<<<U38_SWITCH_JSON>>>";

const NQ_MAP = "nqstart";
const QW_MAP = "start";

const HAVE_BOTH = HAVE_PROGS106 && HAVE_QWPROGS;

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const ENTITIES =
  '{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n"worldtype" "0"\n}\n' +
  '{\n"classname" "info_player_start"\n"origin" "16 16 24"\n"angle" "90"\n}\n' +
  '{\n"classname" "item_shells"\n"origin" "48 16 24"\n}\n' +
  '{\n"classname" "item_health"\n"origin" "16 48 24"\n}\n';

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

  writeGameFile(baseDir, "id1/progs.dat", new Uint8Array(readFileSync(PROGS106_DAT)));
  writeGameFile(baseDir, `id1/maps/${NQ_MAP}.bsp`, withEntities(buildBsp(), ENTITIES));

  writeGameFile(baseDir, "qw/qwprogs.dat", new Uint8Array(readFileSync(QWPROGS_DAT)));
  writeGameFile(baseDir, `qw/maps/${QW_MAP}.bsp`, withEntities(buildBsp(), ENTITIES));
  writeGameFile(baseDir, "qw/server.cfg", latin1Bytes('hostname "u38-unified"\ndeathmatch 1\n'));

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
// Child 1: the unified binary booted as the QuakeWorld dedicated server.
// `-dedicated -qw` is exactly what src/qw/main_sv.ts now inserts, so this is
// the qwsv boot with no qwsv entry point involved.

const SERVER_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { Cvar_Set } from "./src/common/cvar";
import { connectionProfile, serverProfile } from "./src/common/profile";
import { sysState } from "./src/platform/sys";
import { ClientStateT, ServerStateT, sv, svs } from "./src/qw/server/server";
import { SV_Shutdown } from "./src/qw/server/sv_main";

const baseDir = process.argv[1];
const port = process.argv[2];
const wanted = process.argv[3];
const frames = Number(process.argv[4]);

Sys_Main_Init(["quake", "-dedicated", "-qw", "-basedir", baseDir, "-port", port]);
await NET_Ready();

const bootSnapshot = {
  serverProfile: serverProfile(),
  serveronly: connectionProfile.serveronly,
  dedicated: sysState.isDedicated,
  svProfile: sv.profile,
};

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
  // src/main.ts's own Host_Frame, NOT SV_Frame: the dispatch is what proves
  // one binary hosts this server.
  Host_Frame(0.05);
  for (const cl of svs.clients) if (cl.state === ClientStateT.cs_spawned) sawSpawned = true;
  await new Promise((r) => setTimeout(r, 5));
}

const snapshot = {
  boot: bootSnapshot,
  protocol: sv.protocol,
  state: sv.state,
  spawned: sv.state === ServerStateT.ss_active,
  serverProfile: serverProfile(),
  svProfile: sv.profile,
  sawSpawned,
};

SV_Shutdown();
NET_Shutdown();
process.stdout.write("${SERVER_MARKER}" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`;

//============================================================================
// Child 2: a plain unified client (no -qw) joining that server, and running
// `name` once it is in.

const CLIENT_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { NET_Ready } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { CactiveT, cl, cls } from "./src/client/client";
import { clientProfile } from "./src/common/profile";
import { Info_ValueForKey } from "./src/qw/common";

const baseDir = process.argv[1];
const port = process.argv[2];

Sys_Main_Init(["quake", "-basedir", baseDir]);

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

// The name collision ruling: WinQuake's "name" command is what the player
// types, QuakeWorld's "name" cvar is where it is stored, and the userinfo
// follows through the cvar info hook.
const nameBefore = Info_ValueForKey(cls.qw.userinfo, "name");
Cbuf_AddText("name Ranger\\n");
Cbuf_Execute();
for (let i = 0; i < 10; i++) Host_Frame(0.05);
const nameAfter = Info_ValueForKey(cls.qw.userinfo, "name");

const snapshot = {
  profile: clientProfile(),
  sawActive,
  state: cls.state,
  protocol: cl.qw.protocol,
  nameBefore,
  nameAfter,
};

Cbuf_AddText("disconnect\\n");
Cbuf_Execute();

process.stdout.write("${CLIENT_MARKER}" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`;

//============================================================================
// Child 3: ONE dedicated process moving between the two servers.

const SWITCH_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { Cbuf_AddText } from "./src/common/cmd";
import { serverProfile } from "./src/common/profile";
import { sv as nqSv } from "./src/server/server";
import { sv as qwSv, ServerStateT as QwServerStateT } from "./src/qw/server/server";

const baseDir = process.argv[1];
const port = process.argv[2];

// -noudp: WinQuake's own dgrm driver must not take the port the QuakeWorld
// server's SV_InitNet then binds, since both read the same -port.
Sys_Main_Init(["quake", "-dedicated", "-noudp", "-basedir", baseDir, "-port", port]);

// Everything goes through the frame loop rather than a bare Cbuf_Execute:
// the console-source profile is applied by the DRAIN (src/common/host.ts's
// _Host_Frame for the NetQuake server, src/qw/server/sv_main.ts's SV_Frame
// for the QuakeWorld one), and src/main.ts's Host_Frame is what picks which
// of the two runs. Driving Cbuf_Execute directly would bypass exactly the
// thing under test.
function pump(text, frames) {
  Cbuf_AddText(text);
  for (let i = 0; i < frames; i++) Host_Frame(0.2);
}

function status(tag) {
  process.stdout.write("<<<STATUS " + tag + ">>>\\n");
  pump("status\\n", 4);
  process.stdout.write("<<<ENDSTATUS " + tag + ">>>\\n");
}

//-- leg 1: the NetQuake server ------------------------------------------
pump("map ${NQ_MAP}\\n", 4);
const nq1 = { nqActive: nqSv.active, nqProfile: nqSv.profile, serverProfile: serverProfile() };
status("nq1");

//-- leg 2: sv_profile qw, then map -- the QuakeWorld server takes over ---
pump("sv_profile qw\\nmap ${QW_MAP}\\n", 6);
const qw = {
  qwProfile: qwSv.profile,
  qwSpawned: qwSv.state === QwServerStateT.ss_active,
  nqActive: nqSv.active,
  serverProfile: serverProfile(),
};
status("qw");

//-- leg 3: back to NetQuake -- the QuakeWorld server is shut down --------
pump("sv_profile nq\\nmap ${NQ_MAP}\\n", 6);
const nq2 = {
  nqActive: nqSv.active,
  qwDead: qwSv.state === QwServerStateT.ss_dead,
  serverProfile: serverProfile(),
};
status("nq2");

process.stdout.write("${SWITCH_MARKER}" + JSON.stringify({ nq1, qw, nq2 }) + "\\n");
process.exit(0);
`;

//============================================================================

const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

function markerLine(text: string, marker: string): string | null {
  for (const line of text.split("\n")) if (line.startsWith(marker)) return line.slice(marker.length);
  return null;
}

// The console output between the two sentinels a `status` invocation printed.
function statusBlock(text: string, tag: string): string {
  const start = text.indexOf(`<<<STATUS ${tag}>>>`);
  const end = text.indexOf(`<<<ENDSTATUS ${tag}>>>`);
  if (start < 0 || end < 0 || end < start) return "";
  return text.slice(start, end);
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

// Set U38_UNIFIED_DEBUG to have a failing run print the children's whole
// console output, which is otherwise captured and only sampled by the
// assertions.
function dumpOnDemand(label: string, text: string): void {
  if (process.env.U38_UNIFIED_DEBUG === undefined) return;
  console.log(`=== ${label} ===\n${text}`);
}

const fixtures: QwclFixture[] = [];

afterAll(() => {
  for (const f of fixtures) destroyQwclFixture(f);
});

interface HostedResult {
  client: Record<string, unknown>;
  server: Record<string, unknown>;
  clientLog: string;
  serverLog: string;
}

async function runHostedQwServer(opts: { prefix: string; port: number; wanted: string }): Promise<HostedResult> {
  const fixture = buildFixture(opts.prefix);
  fixtures.push(fixture);
  const baseDir = fixture.baseDir;

  const server = Bun.spawn(
    ["timeout", "180", "bun", "-e", SERVER_SCRIPT, "--", baseDir, String(opts.port), opts.wanted, "260"],
    { cwd: repoRoot, env: headlessEnv, stdout: "pipe", stderr: "pipe" },
  );

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
    throw new Error(`the -dedicated -qw child never printed its precache list:\n${serverChunks.join("")}`);
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
  dumpOnDemand("-dedicated -qw server", serverLog);
  dumpOnDemand("unified client", clientLog);

  const clientJson = markerLine(clientLog, CLIENT_MARKER);
  if (clientJson === null) throw new Error(`the unified client produced no snapshot:\n${clientLog}`);
  const serverJson = markerLine(serverLog, SERVER_MARKER);
  if (serverJson === null) throw new Error(`the -dedicated -qw child produced no snapshot:\n${serverLog}`);

  return {
    client: record(JSON.parse(clientJson), "client"),
    server: record(JSON.parse(serverJson), "server"),
    clientLog,
    serverLog,
  };
}

//============================================================================

describe.skipIf(!HAVE_BOTH)("the unified binary booted as the QuakeWorld dedicated server", () => {
  let result: HostedResult;

  test("-dedicated -qw spawns the QuakeWorld server and a unified client enters at 28", async () => {
    result = await runHostedQwServer({ prefix: "u38-qwsv-28-", port: 26330, wanted: "28" });

    const boot = sub(result.server, "boot");
    expect(str(boot, "serverProfile")).toBe("qw");
    expect(bool(boot, "serveronly")).toBe(true);
    expect(bool(boot, "dedicated")).toBe(true);
    expect(str(boot, "svProfile")).toBe("qw");

    // ss_active, not `server_t.active`: QW/server never sets that field.
    expect(bool(result.server, "spawned")).toBe(true);
    expect(num(result.server, "protocol")).toBe(28);
    expect(str(result.server, "serverProfile")).toBe("qw");
    expect(str(result.server, "svProfile")).toBe("qw");
    expect(bool(result.server, "sawSpawned")).toBe(true);

    expect(bool(result.client, "sawActive")).toBe(true);
    expect(str(result.client, "profile")).toBe("qw");
    expect(num(result.client, "protocol")).toBe(28);
  }, 300000);

  test("`name` under the QuakeWorld profile sets the QuakeWorld userinfo", () => {
    expect(str(result.client, "nameBefore")).toBe("unnamed");
    expect(str(result.client, "nameAfter")).toBe("Ranger");
  });
});

describe.skipIf(!HAVE_BOTH)("one process, one server: sv_profile moves between the two", () => {
  let snapshot: Record<string, unknown>;
  let log = "";

  test("a NetQuake map, then a QuakeWorld map, then a NetQuake map again", async () => {
    const fixture = buildFixture("u38-switch-");
    fixtures.push(fixture);

    // The NetQuake leg's progs.dat precaches models the synthetic fixture has
    // no files for, and Mod_ForName is fatal on a miss. The QuakeWorld server
    // spawns the same map WITHOUT needing them on disk, so one throwaway
    // `-dedicated -qw` boot names them and this materializes one loadable
    // file each -- the same bootstrap test/unified_client.test.ts uses.
    const probe = Bun.spawnSync(
      ["timeout", "120", "bun", "-e", SERVER_SCRIPT, "--", fixture.baseDir, "26332", "28", "0"],
      { cwd: repoRoot, env: headlessEnv },
    );
    const probeLog = `${probe.stdout.toString()}\n${probe.stderr.toString()}`;
    const probeJson = markerLine(probeLog, PRECACHE_MARKER);
    if (probeJson === null) throw new Error(`the precache probe produced no list:\n${probeLog}`);
    const pre = record(JSON.parse(probeJson), "precache");
    materializePrecaches(fixture.baseDir, strings(pre, "models"), strings(pre, "sounds"));

    const child = Bun.spawnSync(["timeout", "180", "bun", "-e", SWITCH_SCRIPT, "--", fixture.baseDir, "26331"], {
      cwd: repoRoot,
      env: headlessEnv,
    });
    log = `${child.stdout.toString()}\n${child.stderr.toString()}`;
    dumpOnDemand("sv_profile switch", log);
    const json = markerLine(log, SWITCH_MARKER);
    if (json === null) throw new Error(`the sv_profile child produced no snapshot:\n${log}`);
    snapshot = record(JSON.parse(json), "switch");

    const nq1 = sub(snapshot, "nq1");
    expect(bool(nq1, "nqActive")).toBe(true);
    expect(str(nq1, "nqProfile")).toBe("nq");
    expect(str(nq1, "serverProfile")).toBe("nq");

    const qw = sub(snapshot, "qw");
    // QW/server has no live `server_t.active` flag -- nothing in that tree
    // ever sets it -- so ss_active is what says the server is up.
    expect(bool(qw, "qwSpawned")).toBe(true);
    expect(str(qw, "qwProfile")).toBe("qw");
    expect(str(qw, "serverProfile")).toBe("qw");
    // the one-server-at-a-time rule, from the QuakeWorld side
    expect(bool(qw, "nqActive")).toBe(false);

    const nq2 = sub(snapshot, "nq2");
    expect(bool(nq2, "nqActive")).toBe(true);
    expect(str(nq2, "serverProfile")).toBe("nq");
    // and from the NetQuake side
    expect(bool(nq2, "qwDead")).toBe(true);
  }, 300000);

  test("the console-source profile routes `status` to the server whose profile is in force", () => {
    // WinQuake's Host_Status_f leads with "host:"; QuakeWorld's SV_Status_f
    // has no such line and prints "cpu utilization" instead.
    const nq1 = statusBlock(log, "nq1");
    expect(nq1).toContain("host:");
    expect(nq1).not.toContain("cpu utilization");

    const qw = statusBlock(log, "qw");
    expect(qw).toContain("cpu utilization");
    expect(qw).not.toContain("host:");

    const nq2 = statusBlock(log, "nq2");
    expect(nq2).toContain("host:");
    expect(nq2).not.toContain("cpu utilization");
  });
});
