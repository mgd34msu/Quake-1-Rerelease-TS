// Live protocol gates.
//
// Two layers, each guarded on what the checkout actually has:
//
// 1. In-process, guarded on progs106/progs.dat (test/support/fixture_availability.ts):
//    SV_SpawnServer picks and publishes a protocol for a synthetic BSP29 map
//    and a synthetic BSP2 map, at every `sv_protocol` setting. This is the
//    "auto picks 999 for a BSP2 map" assertion, with a real Mod_LoadBrushModel
//    parse behind it rather than a hand-set width. SV_SpawnServer fixes the
//    protocol before ED_LoadFromFile (PF_makestatic writes into the signon
//    buffer from inside the spawn functions), so `sv.protocol` is meaningful
//    even on a synthetic map whose worldspawn QuakeC then fails to precache
//    the retail assets that are not there -- exactly the shape
//    test/sv_main.test.ts's own SV_SpawnServer test relies on.
//
// 2. Child-process, guarded on Q1TS_DATA: our own binary in both seats -- a
//    listen server plus its loopback client, booted with `+sv_protocol N +map
//    e1m1`, pumped until cls.signon reaches SIGNONS, then asked what protocol
//    each side ended up on, whether the player spawned and whether entity
//    updates arrived. One OS process per engine, exactly as
//    test/net_e2e.test.ts does it, so nothing in `bun test`'s shared module
//    registry is disturbed by a full Host_Init.
//
// Self-sufficiency: layer 1 builds its own scratch basedir, saves and restores
// sysState.nostdout, svs.maxclients/maxclientslimit/clients, the `sv_protocol`
// and `max_edicts` cvar strings, and calls sv.clear() in afterAll. Layer 2
// touches nothing in this process at all.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { BSP_WIDTH_BSP2, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Mod_Init } from "../src/common/model";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } from "../src/common/cvar";
import { coop, deathmatch, max_edicts, skill } from "../src/common/host";
import { sysState } from "../src/platform/sys";
import { PR_LoadProgs } from "../src/progs/pr_edict";
import { ClientT, sv, svs } from "../src/server/server";
import { SV_Init, SV_SpawnServer, sv_protocol } from "../src/server/sv_main";
import { PROTOCOL_FITZQUAKE, PROTOCOL_NETQUAKE, PROTOCOL_RMQ, PRFL_INT32COORD, PRFL_SHORTANGLE } from "../src/common/protocol";
import { NET_MAXMESSAGE } from "../src/common/net";
import { HAVE_DATA, HAVE_PROGS106, PROGS106_DAT } from "./support/fixture_availability";

//============================================================================
// Layer 1: SV_SpawnServer's protocol choice, in process.

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "protocol-live-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
const savedSvProtocol = sv_protocol.string;
const savedMaxEdicts = max_edicts.string;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  sv.clear();
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;
  if (Cvar_FindVar("sv_protocol") !== null) Cvar_Set("sv_protocol", savedSvProtocol);
  if (Cvar_FindVar("max_edicts") !== null) Cvar_Set("max_edicts", savedMaxEdicts);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  sysState.nostdout = 1;
  if (!HAVE_PROGS106) return;

  const progsDat = new Uint8Array(readFileSync(PROGS106_DAT));

  // gfx/pop.lmp's 128 big-endian shorts, the registered-version check's
  // fixture (test/sv_main.test.ts's own recipe).
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  ensureDir(join(baseDir, "id1"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: progsDat },
  ]);
  // The classic narrow map, and the same map written with BSP2's 32-bit lumps.
  writeGameFile(baseDir, "id1/maps/narrow.bsp", buildBsp());
  writeGameFile(baseDir, "id1/maps/wide2.bsp", buildBsp({ width: BSP_WIDTH_BSP2 }));

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();
  PR_LoadProgs();

  if (Cvar_FindVar("sv_protocol") === null) Cvar_RegisterVariable(sv_protocol);
  if (Cvar_FindVar("max_edicts") === null) Cvar_RegisterVariable(max_edicts);
  SV_Init();
});

// Spawns `map` and reports the protocol the server settled on. SV_SpawnServer
// fixes sv.protocol before ED_LoadFromFile runs worldspawn's QuakeC, so the
// answer is valid whether or not the synthetic basedir has the retail assets
// that QuakeC then tries to precache.
function spawnAndReadProtocol(map: string): { protocol: number; protocolflags: number } {
  svs.maxclients = 1;
  svs.maxclientslimit = 1;
  svs.clients = [new ClientT()];
  coop.value = 0;
  deathmatch.value = 0;
  skill.value = 1;

  try {
    SV_SpawnServer(map);
  } catch {
    // worldspawn's precaches reach for retail assets this scratch basedir does
    // not hold; the protocol was chosen several statements earlier.
  }
  return { protocol: sv.protocol, protocolflags: sv.protocolflags };
}

describe.skipIf(!HAVE_PROGS106)("SV_SpawnServer chooses and publishes a protocol", () => {
  test("auto picks 666 for a narrow BSP29 map", () => {
    Cvar_Set("sv_protocol", "auto");
    const r = spawnAndReadProtocol("narrow");
    expect(r.protocol).toBe(PROTOCOL_FITZQUAKE);
    expect(r.protocolflags).toBe(0);
    // 666's wire size, clamped by what src/common/net.ts's NET_MAXMESSAGE can
    // carry today (sv_main.ts's `netCap`; see this unit's report).
    expect(sv.datagram.maxsize).toBe(Math.min(64000, NET_MAXMESSAGE));
  });

  test("auto picks 999 for a BSP2 map", () => {
    Cvar_Set("sv_protocol", "auto");
    const r = spawnAndReadProtocol("wide2");
    expect(r.protocol).toBe(PROTOCOL_RMQ);
    // Ironwail sv_main.c:1962's own flag word.
    expect(r.protocolflags).toBe(PRFL_INT32COORD | PRFL_SHORTANGLE);
    expect(r.protocolflags).toBe(0x82);
  });

  test("an explicit sv_protocol 15 narrows a BSP2 map back to WinQuake's wire", () => {
    Cvar_Set("sv_protocol", "15");
    const r = spawnAndReadProtocol("wide2");
    expect(r.protocol).toBe(PROTOCOL_NETQUAKE);
    expect(r.protocolflags).toBe(0);
    // WinQuake's own datagram and signon sizes, not the wide ones
    expect(sv.datagram.maxsize).toBe(1024);
    expect(sv.signon.maxsize).toBe(8192);
  });

  test("an explicit sv_protocol 666 and 999 are honored on a narrow map", () => {
    Cvar_Set("sv_protocol", "666");
    expect(spawnAndReadProtocol("narrow").protocol).toBe(PROTOCOL_FITZQUAKE);

    Cvar_Set("sv_protocol", "999");
    const r = spawnAndReadProtocol("narrow");
    expect(r.protocol).toBe(PROTOCOL_RMQ);
    expect(r.protocolflags).toBe(0x82);

    Cvar_Set("sv_protocol", "auto");
  });

  test("the edict table is allocated from the max_edicts cvar, not from MAX_EDICTS", () => {
    Cvar_Set("sv_protocol", "auto");
    Cvar_Set("max_edicts", "1024");
    spawnAndReadProtocol("narrow");
    expect(sv.max_edicts).toBe(1024);
    expect(sv.edicts.length).toBe(1024);

    Cvar_Set("max_edicts", "300"); // below MIN_EDICTS, so it clamps up
    spawnAndReadProtocol("narrow");
    expect(sv.max_edicts).toBe(300);

    Cvar_Set("max_edicts", "100");
    spawnAndReadProtocol("narrow");
    expect(sv.max_edicts).toBe(256); // MIN_EDICTS

    Cvar_Set("max_edicts", savedMaxEdicts);
  });
});

//============================================================================
// Layer 2: a real listen server plus its loopback client, one child process
// per protocol. Skipped unless Q1TS_DATA points at a basedir with id1/.

const BASEDIR = process.env.Q1TS_DATA ?? "";
const GAME = "e2e_proto_t";
const MAP = "e1m1";
const mainTs = join(import.meta.dir, "..", "src", "main.ts");
const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

if (HAVE_DATA) mkdirSync(join(BASEDIR, GAME), { recursive: true }); // Host_Shutdown writes config.cfg here

const logDir = mkdtempSync(join(tmpdir(), "q1-protocol-live-"));

afterAll(() => {
  if (!process.env.Q1_KEEP_E2E_LOG) rmSync(logDir, { recursive: true, force: true });
  else console.log(`kept protocol live logs in ${logDir}`);
});

// `+sv_protocol N +map <map>` boots a listen server and connects this same
// process's client to it over the loopback driver -- our own binary in both
// seats. Frames are paced the way sys_linux.c's main loop paces Host_Frame
// (a fixed slice spun as fast as a loop can go would race the server clock).
function buildScript(protocol: string, map: string, extraArgs: string[]): string {
  const args = ["q1ts", "-basedir", BASEDIR, "-game", GAME, "-nosound", ...extraArgs, "+sv_protocol", protocol, "+map", map];
  return [
    `const { Sys_Main_Init, runFrames } = await import(${JSON.stringify(mainTs)});`,
    `const { cl, cls, cl_entities, SIGNONS } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "client", "client.ts"))});`,
    `const { sv } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "server", "server.ts"))});`,
    `const { Sys_FloatTime } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "platform", "sys.ts"))});`,
    `Sys_Main_Init(${JSON.stringify(args)});`,
    `const deadline = Date.now() + 60000;`,
    `let oldtime = Sys_FloatTime() - 0.1;`,
    `while (cls.signon !== SIGNONS && Date.now() < deadline) {`,
    `  const newtime = Sys_FloatTime();`,
    `  const elapsed = newtime - oldtime;`,
    `  oldtime = newtime;`,
    `  runFrames(1, elapsed);`,
    `  await Bun.sleep(1);`,
    `}`,
    // A few more frames so at least one full entity datagram has been parsed.
    `for (let i = 0; i < 20; i++) {`,
    `  const newtime = Sys_FloatTime();`,
    `  const elapsed = newtime - oldtime;`,
    `  oldtime = newtime;`,
    `  runFrames(1, elapsed);`,
    `  await Bun.sleep(1);`,
    `}`,
    `const player = cl_entities[cl.viewentity];`,
    `let withModels = 0;`,
    `for (let i = 1; i < cl.num_entities; i++) if (cl_entities[i].model) withModels++;`,
    `const result = {`,
    `  signon: cls.signon,`,
    `  clProtocol: cl.protocol,`,
    `  clProtocolFlags: cl.protocolflags,`,
    `  svProtocol: sv.protocol,`,
    `  svProtocolFlags: sv.protocolflags,`,
    `  numEntities: cl.num_entities,`,
    `  numStatics: cl.num_statics,`,
    `  entitiesWithModels: withModels,`,
    `  viewentity: cl.viewentity,`,
    `  playerHasModel: player ? player.model !== null : false,`,
    `  playerOrigin: player ? [player.origin[0], player.origin[1], player.origin[2]] : null,`,
    `  levelname: cl.levelname,`,
    `};`,
    `console.log("PROTO_RESULT " + JSON.stringify(result));`,
    `process.exit(0);`,
  ].join("\n");
}

interface LiveResult {
  signon: number;
  clProtocol: number;
  clProtocolFlags: number;
  svProtocol: number;
  svProtocolFlags: number;
  numEntities: number;
  numStatics: number;
  entitiesWithModels: number;
  viewentity: number;
  playerHasModel: boolean;
  playerOrigin: [number, number, number] | null;
  levelname: string;
}

function parseResult(log: string): LiveResult | null {
  for (const line of log.split("\n")) {
    if (!line.startsWith("PROTO_RESULT ")) continue;
    const parsed: unknown = JSON.parse(line.slice("PROTO_RESULT ".length));
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed;
    if (
      "signon" in r &&
      typeof r.signon === "number" &&
      "clProtocol" in r &&
      typeof r.clProtocol === "number" &&
      "clProtocolFlags" in r &&
      typeof r.clProtocolFlags === "number" &&
      "svProtocol" in r &&
      typeof r.svProtocol === "number" &&
      "svProtocolFlags" in r &&
      typeof r.svProtocolFlags === "number" &&
      "numEntities" in r &&
      typeof r.numEntities === "number" &&
      "numStatics" in r &&
      typeof r.numStatics === "number" &&
      "entitiesWithModels" in r &&
      typeof r.entitiesWithModels === "number" &&
      "viewentity" in r &&
      typeof r.viewentity === "number" &&
      "playerHasModel" in r &&
      typeof r.playerHasModel === "boolean" &&
      "levelname" in r &&
      typeof r.levelname === "string"
    ) {
      return {
        signon: r.signon,
        clProtocol: r.clProtocol,
        clProtocolFlags: r.clProtocolFlags,
        svProtocol: r.svProtocol,
        svProtocolFlags: r.svProtocolFlags,
        numEntities: r.numEntities,
        numStatics: r.numStatics,
        entitiesWithModels: r.entitiesWithModels,
        viewentity: r.viewentity,
        playerHasModel: r.playerHasModel,
        playerOrigin: null,
        levelname: r.levelname,
      };
    }
  }
  return null;
}

async function runChild(tag: string, protocol: string, map: string, extraArgs: string[] = []): Promise<{ result: LiveResult | null; log: string; exitCode: number | string }> {
  const logPath = join(logDir, `${tag}.log`);
  const fd = openSync(logPath, "w");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", buildScript(protocol, map, extraArgs)],
    env: headlessEnv,
    stdout: fd,
    stderr: fd,
  });
  const exitCode = await Promise.race([child.exited, Bun.sleep(120000).then(() => "timeout" as const)]);
  if (exitCode === "timeout") child.kill(9);
  closeSync(fd);
  const log = readFileSync(logPath, "latin1");
  return { result: parseResult(log), log, exitCode };
}

describe.skipIf(!HAVE_DATA)("a listen server and its loopback client on every protocol", () => {
  for (const [name, requested, expectedProtocol, expectedFlags] of [
    ["15", "15", PROTOCOL_NETQUAKE, 0],
    ["666", "666", PROTOCOL_FITZQUAKE, 0],
    ["999", "999", PROTOCOL_RMQ, PRFL_INT32COORD | PRFL_SHORTANGLE],
  ] as const) {
    test(`sv_protocol ${name} on ${MAP}: the player spawns and entities arrive`, async () => {
      const { result, log, exitCode } = await runChild(`listen-${name}`, requested, MAP);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      if (result === null) return;

      // Both seats agree on the protocol, and the server announced it.
      expect(result.svProtocol).toBe(expectedProtocol);
      expect(result.svProtocolFlags).toBe(expectedFlags);
      expect(result.clProtocol).toBe(expectedProtocol);
      expect(result.clProtocolFlags).toBe(expectedFlags);
      expect(log).toContain(`Server protocol ${expectedProtocol} (flags 0x${expectedFlags.toString(16)})`);

      // The signon sequence completed and the map loaded.
      expect(result.signon).toBe(4); // SIGNONS
      expect(result.levelname.length).toBeGreaterThan(0);

      // The player spawned: a view entity with a model, past the world edict.
      expect(result.viewentity).toBeGreaterThan(0);
      expect(result.playerHasModel).toBe(true);

      // Entity updates arrived: e1m1 has plenty of visible entities and
      // static torches, and the client only creates entity slots through
      // CL_EntityNum, which only runs from a parsed update or baseline.
      expect(result.numEntities).toBeGreaterThan(1);
      expect(result.entitiesWithModels).toBeGreaterThan(0);
      expect(result.numStatics).toBeGreaterThan(0);
    }, 180000);
  }
});

// The re-release's mission pack 1 (`rerelease/mg1`) ships BSP2 maps; `start` is
// the one every installation has. Skipped when the tree is a classic-only
// install.
const MG1_DIRS = HAVE_DATA ? ["rerelease/mg1", "mg1"] : [];
const MG1_GAME = MG1_DIRS.find((d) => existsSync(join(BASEDIR, d, "pak0.pak")) || existsSync(join(BASEDIR, d, "maps")));

describe.skipIf(!HAVE_DATA || MG1_GAME === undefined)("a BSP2 map under sv_protocol auto", () => {
  test("mg1 start picks protocol 999", async () => {
    const { result, log, exitCode } = await runChild("auto-mg1", "auto", "start", ["-game", MG1_GAME ?? "mg1"]);
    expect(exitCode).toBe(0);
    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.svProtocol).toBe(PROTOCOL_RMQ);
    expect(result.svProtocolFlags).toBe(PRFL_INT32COORD | PRFL_SHORTANGLE);
    expect(result.clProtocol).toBe(PROTOCOL_RMQ);
    expect(result.clProtocolFlags).toBe(PRFL_INT32COORD | PRFL_SHORTANGLE);
    expect(log).toContain("Server protocol 999 (flags 0x82)");

    expect(result.signon).toBe(4);
    expect(result.playerHasModel).toBe(true);
    expect(result.numEntities).toBeGreaterThan(1);
  }, 180000);
});
