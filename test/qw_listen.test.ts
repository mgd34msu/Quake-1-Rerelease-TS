/*
U41: the QuakeWorld LISTEN server -- one process holding a QuakeWorld server
and the client that plays on it (ARCHITECTURE.md "Unified client and server").

QuakeWorld has no loopback network driver: QW/client and QW/server are two
binaries that talk over UDP even when the player is sitting at the machine
hosting the game. So the listen server is not the NetQuake `connect local`
arrangement at all -- it is two real sockets in one process, the client's on
PORT_CLIENT (27001) and the server's on PORT_SERVER (`-port` here), which is
what src/qw/net_udp.ts's socket-per-side split exists for. `map` under
`sv_profile qw` (src/common/host_cmd.ts's Host_Map_QW_f) stands the server up
and then seats the local client on it with a real
`connect 127.0.0.1:<the port the server bound>`.

One child `bun` process runs the whole thing, in order:

  1. boots src/main.ts as a plain unified client (no -qw, not dedicated),
  2. `sv_profile qw` + `map`, and reaches ca_active at protocol 28 against
     its own server -- both halves driven by src/main.ts's own Host_Frame,
  3. `disconnect`, which takes the connection AND the server down,
  4. `sv_profile nq` + `map` again, proving the process is still a working
     NetQuake client afterwards.

Its whole console scrollback comes back on stdout, which is also how the
duplicate-cvar assertion reads: WinQuake and QuakeWorld each declare
`deathmatch`, `hostname`, `sv_gravity` and 14 more, and before U41 the
QuakeWorld server's second object was refused ("Can't register variable %s,
allready defined") -- leaving it unreachable from the console and at value 0,
which is how a listen server ended up running with sv_gravity 0. One object
per name now, so none of those lines may appear.

Why a child process: a full Host_Init in the `bun test` process would register
every command and cvar the whole engine has and leave them there for every
other file (the same reason test/unified_client.test.ts,
test/unified_server.test.ts and test/qwcl_boot.test.ts each use one).
Everything the assertions read is printed as one JSON line. THIS process
mutates nothing shared: the fixture lives under an mkdtemp scratch tree that
afterAll removes.

Ports: 26340-26349 (this unit's range).
*/

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildQwclFixture, destroyQwclFixture, type QwclFixture } from "./support/qwcl_fixture";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { HAVE_PROGS106, HAVE_QWPROGS, PROGS106_DAT, QWPROGS_DAT } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

const PRECACHE_MARKER = "<<<U41_PRECACHE_JSON>>>";
const LISTEN_MARKER = "<<<U41_LISTEN_JSON>>>";

const NQ_MAP = "nqstart";
const QW_MAP = "start";

const SERVER_PORT = 26340;
const PROBE_PORT = 26341;
const PORT_CLIENT = 27001; // src/qw/protocol.ts, QW's own fixed client port

const HAVE_BOTH = HAVE_PROGS106 && HAVE_QWPROGS;

// Every cvar name WinQuake and QuakeWorld both declare, which U41 collapsed
// onto one object each. None of these may print the duplicate-registration
// line in a boot that brings both servers' cvars up.
const SHARED_CVARS = [
  "deathmatch",
  "developer",
  "fraglimit",
  "hostname",
  "pausable",
  "samelevel",
  "teamplay",
  "timelimit",
  "sv_accelerate",
  "sv_aim",
  "sv_friction",
  "sv_gravity",
  "sv_maxspeed",
  "sv_maxvelocity",
  "sv_stopspeed",
  "cl_rollangle",
  "cl_rollspeed",
] as const;

// The duplicate registrations U41 did NOT take on, all of them qwcl-vs-qwsv
// name collisions rather than QuakeWorld-vs-WinQuake ones: QW/client and
// QW/server each declare `password` and `rcon_password` with different
// meanings (what this client sends vs what this server demands), and
// con_notifytime is QW/client/console.c's copy of WinQuake's. They belong to
// the per-profile cvar registry follow-up (.orch/followups.md, U18/U32), so
// this suite allows them by name and forbids everything else.
const KNOWN_REMAINING = ["password", "rcon_password", "con_notifytime"];

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
  writeGameFile(baseDir, "qw/server.cfg", latin1Bytes('hostname "u41-listen"\n'));

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
// The precache probe: a throwaway `-dedicated -qw` boot that names every
// model and sound the map's progs precaches, so the fixture can materialize
// one loadable file each. Same bootstrap test/unified_server.test.ts uses.

const PROBE_SCRIPT = `
import { Sys_Main_Init } from "./src/main";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { sv } from "./src/qw/server/server";
import { SV_Shutdown, deathmatch, hostname } from "./src/qw/server/sv_main";
import { sv_aim } from "./src/qw/server/pr_cmds";
import { sv_gravity } from "./src/qw/server/sv_phys";

const baseDir = process.argv[1];
const port = process.argv[2];

Sys_Main_Init(["quake", "-dedicated", "-qw", "-basedir", baseDir, "-port", port]);
await NET_Ready();

Cbuf_AddText("map ${QW_MAP}\\n");
Cbuf_Execute();

process.stdout.write(
  "${PRECACHE_MARKER}" +
    JSON.stringify({
      models: sv.model_precache.filter((s) => s !== null && s !== ""),
      sounds: sv.sound_precache.filter((s) => s !== null && s !== ""),
      // The shared cvar objects, on a boot where WinQuake's Host_Init never
      // ran: QuakeWorld's own defaults are what they carry.
      aim: sv_aim.value,
      gravity: sv_gravity.value,
      deathmatch: deathmatch.value,
      hostname: hostname.string,
    }) +
    "\\n",
);

SV_Shutdown();
NET_Shutdown();
process.exit(0);
`;

//============================================================================
// The listen-server child: one boot, both halves.

const LISTEN_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { CactiveT, SIGNONS, cl, cls } from "./src/client/client";
import { clientProfile, serverProfile } from "./src/common/profile";
import { NET_LocalAdr } from "./src/qw/net_udp";
import { ClientStateT, ServerStateT, sv as qwSv, svs as qwSvs } from "./src/qw/server/server";
import { deathmatch } from "./src/qw/server/sv_main";
import { sv_gravity } from "./src/qw/server/sv_phys";
import { sv as nqSv } from "./src/server/server";
import { sv_gravity as nqSvGravity } from "./src/server/sv_phys";

const baseDir = process.argv[1];
const port = process.argv[2];

// -noudp: WinQuake's own dgrm driver must not take the port the QuakeWorld
// server's SV_InitNet then binds, since both read the same -port. The
// NetQuake leg below still has the loopback driver, which is what a NetQuake
// listen server uses anyway.
Sys_Main_Init(["quake", "-basedir", baseDir, "-noudp", "-port", port]);

async function pump(frames) {
  for (let i = 0; i < frames; i++) {
    Host_Frame(0.05);
    await new Promise((r) => setTimeout(r, 5));
  }
}

//-- the listen server: one command stands the server up and seats the client
Cbuf_AddText("sv_profile qw\\nmap ${QW_MAP}\\n");
Cbuf_Execute();

const spawned = qwSv.state === ServerStateT.ss_active;

let sawActive = false;
for (let i = 0; i < 240; i++) {
  Host_Frame(0.05);
  if (cls.state === CactiveT.ca_active) {
    sawActive = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5));
}
await pump(10);

let sawSpawned = false;
for (const c of qwSvs.clients) if (c.state === ClientStateT.cs_spawned) sawSpawned = true;

const listen = {
  spawned,
  sawActive,
  sawSpawned,
  state: cls.state,
  protocol: cl.qw.protocol,
  clientProfile: clientProfile(),
  serverProfile: serverProfile(),
  qwState: qwSv.state,
  clientPort: NET_LocalAdr("client").port,
  serverPort: NET_LocalAdr("server").port,
  serverAdr: cls.qw.servername,
  // The shared cvar objects the running server reads: one object per name,
  // so these are WinQuake's, registered and live rather than left at 0.
  gravity: sv_gravity.value,
  deathmatch: deathmatch.value,
  gravityIsShared: sv_gravity === nqSvGravity,
};

//-- disconnect: the connection AND the server go away
Cbuf_AddText("disconnect\\n");
Cbuf_Execute();
await pump(4);

const afterDisconnect = {
  state: cls.state,
  qwState: qwSv.state,
  clientProfile: clientProfile(),
};

//-- and the process is still a working NetQuake client
Cbuf_AddText("sv_profile nq\\nmap ${NQ_MAP}\\n");
Cbuf_Execute();
for (let i = 0; i < 60 && cls.signon < SIGNONS; i++) Host_Frame(0.05);

const nq = {
  active: nqSv.active,
  signon: cls.signon,
  state: cls.state,
  protocol: cl.protocol,
  clientProfile: clientProfile(),
  serverProfile: serverProfile(),
};

process.stdout.write("${LISTEN_MARKER}" + JSON.stringify({ listen, afterDisconnect, nq }) + "\\n");
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

// "Can't register variable %s, allready defined" -- the cvar name it names.
function duplicateCvarNames(log: string): string[] {
  const names: string[] = [];
  for (const line of log.split("\n")) {
    const m = /^Can't register variable (\S+), allready defined/.exec(line.trim());
    if (m !== null) names.push(m[1]);
  }
  return names;
}

const fixtures: QwclFixture[] = [];

afterAll(() => {
  for (const f of fixtures) destroyQwclFixture(f);
});

//============================================================================

describe.skipIf(!HAVE_BOTH)("a QuakeWorld listen server in one process", () => {
  let snapshot: Record<string, unknown> = {};
  let probe: Record<string, unknown> = {};
  let log = "";

  test("`sv_profile qw` + `map` hosts the server and seats the local client over UDP", async () => {
    const fixture = buildFixture("u41-listen-");
    fixtures.push(fixture);

    const probeChild = Bun.spawnSync(
      ["timeout", "120", "bun", "-e", PROBE_SCRIPT, "--", fixture.baseDir, String(PROBE_PORT)],
      { cwd: repoRoot, env: headlessEnv },
    );
    const probeLog = `${probeChild.stdout.toString()}\n${probeChild.stderr.toString()}`;
    const probeJson = markerLine(probeLog, PRECACHE_MARKER);
    if (probeJson === null) throw new Error(`the precache probe produced no list:\n${probeLog}`);
    const pre = record(JSON.parse(probeJson), "precache");
    probe = pre;
    materializePrecaches(fixture.baseDir, strings(pre, "models"), strings(pre, "sounds"));

    const child = Bun.spawnSync(
      ["timeout", "180", "bun", "-e", LISTEN_SCRIPT, "--", fixture.baseDir, String(SERVER_PORT)],
      { cwd: repoRoot, env: headlessEnv },
    );
    log = `${child.stdout.toString()}\n${child.stderr.toString()}`;

    const json = markerLine(log, LISTEN_MARKER);
    if (json === null) throw new Error(`the listen-server child produced no snapshot:\n${log}`);
    snapshot = record(JSON.parse(json), "listen");

    const listen = sub(snapshot, "listen");
    expect(bool(listen, "spawned")).toBe(true);
    expect(bool(listen, "sawActive")).toBe(true);
    expect(bool(listen, "sawSpawned")).toBe(true);
    expect(num(listen, "protocol")).toBe(28);
    expect(num(listen, "state")).toBe(5); // ca_active
    expect(str(listen, "clientProfile")).toBe("qw");
    expect(str(listen, "serverProfile")).toBe("qw");
  }, 300000);

  test("the two halves hold one UDP socket each, at PORT_CLIENT and the server's port", () => {
    const listen = sub(snapshot, "listen");
    expect(num(listen, "clientPort")).toBe(PORT_CLIENT);
    expect(num(listen, "serverPort")).toBe(SERVER_PORT);
    // QuakeWorld has no loopback driver: the local client's server address is
    // a real one, aimed at the port the server actually bound.
    expect(str(listen, "serverAdr")).toBe(`127.0.0.1:${SERVER_PORT}`);
  });

  test("`disconnect` tears the connection and the server down together", () => {
    const after = sub(snapshot, "afterDisconnect");
    expect(num(after, "state")).toBe(1); // ca_disconnected
    expect(num(after, "qwState")).toBe(0); // ss_dead
    expect(str(after, "clientProfile")).toBe("nq"); // back to the boot profile
  });

  test("a NetQuake `map` works again afterwards, in the same process", () => {
    const nq = sub(snapshot, "nq");
    expect(bool(nq, "active")).toBe(true);
    expect(num(nq, "signon")).toBe(4); // SIGNONS
    expect(str(nq, "clientProfile")).toBe("nq");
    expect(str(nq, "serverProfile")).toBe("nq");
  });

  test("the shared cvar objects are the live ones the running server reads", () => {
    const listen = sub(snapshot, "listen");
    // The bug this replaced: the QuakeWorld server's own sv_gravity object was
    // refused at registration and stayed at 0, so a listen server ran with no
    // gravity at all.
    expect(bool(listen, "gravityIsShared")).toBe(true);
    expect(num(listen, "gravity")).toBe(800);
    // A listen server keeps the values already in force at the NetQuake
    // console rather than resetting to QuakeWorld's compiled-in defaults --
    // the documented half of SV_RegisterSharedVariable's ruling.
    expect(num(listen, "deathmatch")).toBe(0);
  });

  test("a `-dedicated -qw` boot still gets QuakeWorld's own defaults on those objects", () => {
    // The other half of the ruling: nothing had registered the shared objects
    // in that process (WinQuake's Host_Init never runs there), so QuakeWorld's
    // declaration supplies the default -- `sv_aim 2` (no aim assist),
    // `deathmatch 1`, and a `hostname` server.cfg can still set.
    expect(num(probe, "aim")).toBe(2);
    expect(num(probe, "deathmatch")).toBe(1);
    expect(num(probe, "gravity")).toBe(800);
    expect(str(probe, "hostname")).toBe("u41-listen");
  });

  test("no cvar WinQuake and QuakeWorld both declare is registered twice", () => {
    const duplicates = duplicateCvarNames(log);
    for (const name of SHARED_CVARS) expect(duplicates).not.toContain(name);
    // and nothing else has crept in either: the only names left are the
    // qwcl-vs-qwsv collisions U41 did not take on.
    for (const name of duplicates) expect(KNOWN_REMAINING).toContain(name);
  });
});
