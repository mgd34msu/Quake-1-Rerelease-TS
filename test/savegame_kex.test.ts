/*
U24: the 2021 re-release's savegame format (SAVEGAME_VERSION_KEX, Ironwail
progs.h:305) plus autosave (host_cmd.ts's Host_CheckAutosave/Host_WriteAutosave/
Host_NewestAutosave). test/host_cmd.test.ts already covers the classic
SAVEGAME_VERSION 5 format byte-for-byte and is left untouched; this file adds
the KEX header, the `sv_saveformat` selector, and autosave on top of the same
boot recipe (its own scratch basedir, own `-dedicated 1` Host_Init), so it
runs independently of that file and of test order.

Self-sufficient per standing order 13: its own scratch basedir, and every
shared singleton it touches (sysState.nostdout/isDedicated, cmdHost.initialized,
net hooks, svs.maxclients/maxclientslimit/clients, net_activeconnections,
sv_saveformat/sv_autosave/sv_autosave_interval/sv_ruleset's `.string`/`.value`,
svs.clients[0].edict, com_searchpaths/com_gamedir/hipnotic) restored in
afterAll.
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COM_GetGameNames, COM_InitArgv, COM_ResetGameDirectories, com_gamedir, hipnotic, pop, setComGamedir, setHipnotic } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, buildMdl, buildSpr, writeGameFile } from "./support/bsp_builder";
import { Cmd_ExecuteString, CmdSourceT, cmdHost } from "../src/common/cmd";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../src/common/wad";
import { MAX_LIGHTSTYLES, QuakeParmsT } from "../src/common/quakedef";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { getNetHostHooks, net_activeconnections, setNetActiveConnections, setNetHostHooks } from "../src/common/net_main";
import { FL_GODMODE, MOVETYPE_WALK, NUM_SPAWN_PARMS, sv, svs } from "../src/server/server";
import { EDICT_NUM } from "../src/progs/progs";
import { pr_builtin } from "../src/progs/pr_cmds";
import { setBuiltins } from "../src/progs/pr_exec";
import { Host_Init, host, sv_autosave, sv_autosave_interval, sv_saveformat } from "../src/common/host";
import { sv_ruleset } from "../src/progs/ext/ruleset";
import { HAVE_PROGS106 } from "./support/fixture_availability";
import { Host_CheckAutosave, SAVEGAME_VERSION, SAVEGAME_VERSION_KEX, hostCmdState } from "../src/common/host_cmd";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "savegame-kex-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;
const savedIsDedicated = sysState.isDedicated;
const savedCmdInitialized = cmdHost.initialized;
const savedNetHooks = getNetHostHooks();
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
const savedActiveConnections = net_activeconnections;
const savedSaveformat = sv_saveformat.string;
const savedAutosave = sv_autosave.value;
const savedAutosaveInterval = sv_autosave_interval.value;
const savedRuleset = sv_ruleset.string;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  sysState.isDedicated = savedIsDedicated;
  cmdHost.initialized = savedCmdInitialized;
  setNetHostHooks(savedNetHooks);
  setHostShutdown(null);
  setNetActiveConnections(savedActiveConnections);
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;
  sv.clear();
  sv_saveformat.string = savedSaveformat;
  sv_autosave.value = savedAutosave;
  sv_autosave_interval.value = savedAutosaveInterval;
  sv_ruleset.string = savedRuleset;
  rmSync(scratchDir, { recursive: true, force: true });
});

// The smallest legal WAD2 -- Host_Init calls W_LoadWadFile("gfx.wad")
// unconditionally, dedicated or not. Copied from test/host_cmd.test.ts's own
// copy (self-sufficiency, standing order 13 -- this file does not import that
// one's internals).
function buildWad2(): Uint8Array {
  const lumpData = new Uint8Array([1, 2, 3, 4]);
  const infotableofs = WADINFO_T_SIZE + lumpData.length;
  const buf = new ArrayBuffer(infotableofs + LUMPINFO_T_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 1, true);
  view.setInt32(8, infotableofs, true);
  bytes.set(lumpData, WADINFO_T_SIZE);
  view.setInt32(infotableofs, WADINFO_T_SIZE, true);
  view.setInt32(infotableofs + 4, lumpData.length, true);
  view.setInt32(infotableofs + 8, lumpData.length, true);
  const name = "CONCHARS";
  for (let i = 0; i < name.length; i++) bytes[infotableofs + 16 + i] = name.charCodeAt(i);
  return bytes;
}

// progs106/world.qc worldspawn's precache_model list, in its C order.
const WORLDSPAWN_MODELS = [
  "progs/player.mdl",
  "progs/eyes.mdl",
  "progs/h_player.mdl",
  "progs/gib1.mdl",
  "progs/gib2.mdl",
  "progs/gib3.mdl",
  "progs/s_bubble.spr",
  "progs/s_explod.spr",
  "progs/v_axe.mdl",
  "progs/v_shot.mdl",
  "progs/v_nail.mdl",
  "progs/v_rock.mdl",
  "progs/v_shot2.mdl",
  "progs/v_nail2.mdl",
  "progs/v_rock2.mdl",
  "progs/bolt.mdl",
  "progs/bolt2.mdl",
  "progs/bolt3.mdl",
  "progs/lavaball.mdl",
  "progs/missile.mdl",
  "progs/grenade.mdl",
  "progs/spike.mdl",
  "progs/s_spike.mdl",
  "progs/backpack.mdl",
  "progs/zom_gib.mdl",
  "progs/v_light.mdl",
];

beforeAll(() => {
  sysState.nostdout = 1;
  setBuiltins(pr_builtin);

  if (!HAVE_PROGS106) return;

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  const entries = [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: new Uint8Array(readFileSync(PROGS_DAT)) },
    { name: "gfx.wad", data: buildWad2() },
  ];
  for (const m of WORLDSPAWN_MODELS)
    entries.push({ name: m, data: m.endsWith(".spr") ? buildSpr() : buildMdl({ numframes: 2 }) });

  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), entries);
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // -dedicated 1: one player slot, so `save`/`load` (svs.maxclients != 1
  // refuses) are reachable.
  const argv = ["quake", "-basedir", baseDir, "-dedicated", "1"];
  COM_InitArgv(argv);
  cmdHost.initialized = false; // a previous suite in this process may have set it

  const parms = new QuakeParmsT();
  parms.basedir = baseDir;
  parms.argc = argv.length;
  parms.argv = argv;
  parms.memsize = 16 * 1024 * 1024;

  Host_Init(parms);
});

function spawnWorld(): void {
  Cmd_ExecuteString("map world", CmdSourceT.src_command);
  expect(sv.active).toBe(true);
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("sv_saveformat", () => {
  test("classic writes SAVEGAME_VERSION, kex writes SAVEGAME_VERSION_KEX plus the game-name line", () => {
    spawnWorld();

    sv_saveformat.string = "classic";
    Cmd_ExecuteString("save fmt_classic", CmdSourceT.src_command);
    const classicLines = readFileSync(join(com_gamedir, "fmt_classic.sav"), "latin1").split("\n");
    expect(classicLines[0]).toBe(String(SAVEGAME_VERSION));
    // classic layout is untouched: comment is line 1, not shifted
    expect(classicLines[1]).toBe("______________________kills:__0/__0____");

    sv_saveformat.string = "kex";
    Cmd_ExecuteString("save fmt_kex", CmdSourceT.src_command);
    const kexLines = readFileSync(join(com_gamedir, "fmt_kex.sav"), "latin1").split("\n");
    expect(kexLines[0]).toBe(String(SAVEGAME_VERSION_KEX));
    expect(kexLines[1]).toBe(COM_GetGameNames());
    // everything else is the classic layout shifted down by exactly one line
    expect(kexLines[2]).toBe("______________________kills:__0/__0____");
    expect(kexLines[2 + NUM_SPAWN_PARMS + 2]).toBe("world");
  });

  test("a save name with subdirectories creates them (re-release maps live under vault/ and test/)", () => {
    spawnWorld();
    sv_saveformat.string = "classic";
    Cmd_ExecuteString("save autosave/vault/nested_map", CmdSourceT.src_command);
    const lines = readFileSync(join(com_gamedir, "autosave", "vault", "nested_map.sav"), "latin1").split("\n");
    expect(lines[0]).toBe(String(SAVEGAME_VERSION));
  });

  test("auto writes classic under sv_ruleset classic and kex under sv_ruleset rerelease", () => {
    spawnWorld();
    sv_saveformat.string = "auto";

    sv_ruleset.string = "classic";
    Cmd_ExecuteString("save fmt_auto", CmdSourceT.src_command);
    expect(readFileSync(join(com_gamedir, "fmt_auto.sav"), "latin1").split("\n")[0]).toBe(String(SAVEGAME_VERSION));

    sv_ruleset.string = "rerelease";
    Cmd_ExecuteString("save fmt_auto", CmdSourceT.src_command);
    const lines = readFileSync(join(com_gamedir, "fmt_auto.sav"), "latin1").split("\n");
    expect(lines[0]).toBe(String(SAVEGAME_VERSION_KEX));
    expect(lines[1]).toBe(COM_GetGameNames());
  });

  test("an explicit sv_saveformat overrides sv_ruleset", () => {
    spawnWorld();
    sv_ruleset.string = "rerelease";
    sv_saveformat.string = "classic";
    Cmd_ExecuteString("save fmt_override", CmdSourceT.src_command);
    expect(readFileSync(join(com_gamedir, "fmt_override.sav"), "latin1").split("\n")[0]).toBe(String(SAVEGAME_VERSION));
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_Loadgame_f -- KEX format", () => {
  test("a kex-format save round-trips sv.time/the map name/spawn parms/an edict field", () => {
    spawnWorld();
    sv_saveformat.string = "kex";

    const player = EDICT_NUM(1);
    player.v.origin[0] = 1;
    player.v.origin[1] = 2;
    player.v.origin[2] = 3;
    svs.clients[0].spawn_parms[0] = 7.5;
    hostCmdState.current_skill = 1;

    Cmd_ExecuteString("save kex_roundtrip", CmdSourceT.src_command);
    expect(existsSync(join(com_gamedir, "kex_roundtrip.sav"))).toBe(true);

    sv.time = 54321;
    Cmd_ExecuteString("load kex_roundtrip", CmdSourceT.src_command);

    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
    expect(sv.time).toBeCloseTo(1.2, 6);
    expect(Array.from(EDICT_NUM(1).v.origin)).toEqual([1, 2, 3]);
    expect(svs.clients[0].spawn_parms[0]).toBe(7.5);
    expect(hostCmdState.current_skill).toBe(1);
  });

  test("a hand-built KEX-format file loads (Ironwail's own SAVEGAME_VERSION_KEX reader shape)", () => {
    spawnWorld();

    const lines: string[] = [];
    lines.push(String(SAVEGAME_VERSION_KEX));
    lines.push("id1"); // the KEX header's one extra field -- see host_cmd.ts's file header
    lines.push("handbuilt_test");
    for (let i = 0; i < NUM_SPAWN_PARMS; i++) lines.push("0.000000");
    lines.push("1");
    lines.push("world");
    lines.push("42.500000");
    for (let i = 0; i < MAX_LIGHTSTYLES; i++) lines.push("m");
    lines.push("{");
    lines.push("}");
    writeFileSync(join(com_gamedir, "handbuilt.sav"), lines.join("\n") + "\n", "latin1");

    Cmd_ExecuteString("load handbuilt", CmdSourceT.src_command);

    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
    expect(sv.time).toBeCloseTo(42.5, 5);
    expect(COM_GetGameNames()).toBe("id1"); // matches: no game switch
  });

  test("a mismatched KEX game field switches gamedirs via COM_SwitchGame", () => {
    spawnWorld();
    const savedGamedir = com_gamedir;
    const savedHipnotic = hipnotic;

    try {
      const lines: string[] = [];
      lines.push(String(SAVEGAME_VERSION_KEX));
      lines.push("hipnotic"); // differs from COM_GetGameNames()'s default "id1"
      lines.push("handbuilt_test");
      for (let i = 0; i < NUM_SPAWN_PARMS; i++) lines.push("0.000000");
      lines.push("1");
      lines.push("world"); // still resolvable: id1's own tier is still mounted underneath
      lines.push("1.000000");
      for (let i = 0; i < MAX_LIGHTSTYLES; i++) lines.push("m");
      lines.push("{");
      lines.push("}");
      writeFileSync(join(com_gamedir, "gameswitch.sav"), lines.join("\n") + "\n", "latin1");

      Cmd_ExecuteString("load gameswitch", CmdSourceT.src_command);

      expect(sv.active).toBe(true);
      expect(COM_GetGameNames()).toBe("hipnotic");
    } finally {
      // COM_ResetGameDirectories([]) is COM_GetGameNames()'s own reset (clears
      // com_gamenames and every MISSION_PACK_DIRS flag, restores com_searchpaths
      // to com_base_searchpaths -- the boot-time tier id1 was mounted into, so
      // "world"/progs.dat stay reachable for later tests); com_gamedir is a
      // separate field it does not touch.
      COM_ResetGameDirectories([]);
      setComGamedir(savedGamedir);
      setHipnotic(savedHipnotic);
    }
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_CheckAutosave", () => {
  test("fires at level start, gates on the interval with a fake clock, and overwrites its own per-map slot", () => {
    sv_saveformat.string = "classic";
    sv_autosave.value = 1;
    sv_autosave_interval.value = 10;

    const savedEdict = svs.clients[0].edict;
    try {
      spawnWorld(); // Host_Map_f sets hostCmdState.autosave.pendingLevelStart = true

      const player = EDICT_NUM(1);
      player.v.health = 100;
      player.v.velocity[0] = 0;
      player.v.velocity[1] = 0;
      player.v.velocity[2] = 0;
      player.v.movetype = MOVETYPE_WALK;
      player.v.flags = 0;
      player.v.button0 = 0;
      svs.clients[0].edict = player;

      const autosavePath = join(com_gamedir, "autosave", "world.sav");

      sv.time = 5;
      Host_CheckAutosave(); // pendingLevelStart -- fires immediately
      expect(existsSync(autosavePath)).toBe(true);
      let savedTimeLine = readFileSync(autosavePath, "latin1").split("\n")[2 + NUM_SPAWN_PARMS + 2];
      expect(savedTimeLine).toBe("5.000000");

      // interval not elapsed yet -- no rewrite
      sv.time = 8; // elapsed = 3 < sv_autosave_interval (10)
      Host_CheckAutosave();
      savedTimeLine = readFileSync(autosavePath, "latin1").split("\n")[2 + NUM_SPAWN_PARMS + 2];
      expect(savedTimeLine).toBe("5.000000");

      // interval elapsed -- rewrites the same slot
      sv.time = 16; // elapsed = 11 >= 10
      Host_CheckAutosave();
      savedTimeLine = readFileSync(autosavePath, "latin1").split("\n")[2 + NUM_SPAWN_PARMS + 2];
      expect(savedTimeLine).toBe("16.000000");

      // slot rotation: still exactly one file for this map, not a numbered series
      const savFiles = readdirSync(join(com_gamedir, "autosave")).filter((f) => f.toLowerCase().endsWith(".sav"));
      expect(savFiles).toEqual(["world.sav"]);

      // godmode suppresses the interval entirely, even once it would otherwise fire
      player.v.flags = FL_GODMODE;
      sv.time = 999;
      Host_CheckAutosave();
      savedTimeLine = readFileSync(autosavePath, "latin1").split("\n")[2 + NUM_SPAWN_PARMS + 2];
      expect(savedTimeLine).toBe("16.000000");
    } finally {
      svs.clients[0].edict = savedEdict;
    }
  });

  test("does not fire for a dead player, multiplayer, or sv_autosave 0", () => {
    sv_saveformat.string = "classic";
    const savedEdict = svs.clients[0].edict;
    const savedMaxclients = svs.maxclients;
    try {
      spawnWorld();
      rmSync(join(com_gamedir, "autosave"), { recursive: true, force: true });

      const player = EDICT_NUM(1);
      player.v.health = 100;
      player.v.movetype = MOVETYPE_WALK;
      player.v.flags = 0;
      svs.clients[0].edict = player;
      sv.time = 999; // far past any interval

      sv_autosave.value = 0;
      sv_autosave_interval.value = 10;
      Host_CheckAutosave();
      expect(existsSync(join(com_gamedir, "autosave"))).toBe(false);

      sv_autosave.value = 1;
      player.v.health = 0;
      Host_CheckAutosave();
      expect(existsSync(join(com_gamedir, "autosave"))).toBe(false);

      player.v.health = 100;
      svs.maxclients = 4;
      Host_CheckAutosave();
      expect(existsSync(join(com_gamedir, "autosave"))).toBe(false);
    } finally {
      svs.clients[0].edict = savedEdict;
      svs.maxclients = savedMaxclients;
    }
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("load autosave", () => {
  test("picks the newest .sav under <gamedir>/autosave, by mtime", () => {
    spawnWorld();
    const dir = join(com_gamedir, "autosave");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const savedTime = sv.time;
    try {
      sv.time = 111;
      Cmd_ExecuteString("save autosave/older", CmdSourceT.src_command);
      sv.time = 222;
      Cmd_ExecuteString("save autosave/newer", CmdSourceT.src_command);
    } finally {
      sv.time = savedTime;
    }

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "older.sav"), past, past);
    utimesSync(join(dir, "newer.sav"), future, future);

    sv.time = 0; // clobbered before load, to prove the load overwrites it
    Cmd_ExecuteString("load autosave", CmdSourceT.src_command);

    expect(sv.active).toBe(true);
    expect(sv.time).toBeCloseTo(222, 5);
  });

  test("prints an error instead of loading when no autosave exists", () => {
    spawnWorld();
    rmSync(join(com_gamedir, "autosave"), { recursive: true, force: true });

    sv.time = 777;
    Cmd_ExecuteString("load autosave", CmdSourceT.src_command);

    // no autosave directory -- Host_Loadgame_f bails before touching sv.time
    expect(sv.time).toBe(777);
  });
});
