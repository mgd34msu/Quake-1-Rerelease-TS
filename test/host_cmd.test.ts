/*
Self-sufficient per standing order 13: this file builds its own scratch
basedir (id1/pak0.pak with gfx/pop.lmp + progs.dat + a minimal gfx.wad + every
model progs106's worldspawn precaches, plus a synthetic maps/world.bsp), calls
COM_InitArgv itself and boots a real `-dedicated 1` host with Host_Init, so
`map`, `save` and `load` run end to end against progs106/progs.dat.

Every process-wide flag Host_Init installs is captured before and restored in
afterAll (`bun test` runs every file in one process).
*/

import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_GetGameNames, COM_InitArgv, com_gamedir, com_searchpaths, pop, setComGamedir, setComSearchpaths } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Cbuf_AddText, Cbuf_Execute, Cmd_ExecuteString, Cmd_TokenizeString, CmdSourceT, cmdHost, cmdState } from "../src/common/cmd";
import { Cvar_Set, Cvar_VariableString, Cvar_VariableValue, setCvarServerHooks } from "../src/common/cvar";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../src/common/wad";
import {
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_AXE,
  IT_GRENADE_LAUNCHER,
  IT_KEY1,
  IT_KEY2,
  IT_LIGHTNING,
  IT_NAILGUN,
  IT_ROCKET_LAUNCHER,
  IT_SHOTGUN,
  IT_SUPER_NAILGUN,
  IT_SUPER_SHOTGUN,
  MAX_LIGHTSTYLES,
  QuakeParmsT,
  SAVEGAME_COMMENT_LENGTH,
  STAT_MONSTERS,
  STAT_TOTALMONSTERS,
} from "../src/common/quakedef";
import { SvcOpsT } from "../src/common/protocol";
import type { SizeBuf } from "../src/common/sizebuf";
import { SZ_Clear } from "../src/common/sizebuf";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { QsocketT } from "../src/common/net";
import { getNetHostHooks, net_activeconnections, net_time, setNetActiveConnections, setNetHostHooks } from "../src/common/net_main";
import { ClientT, sv, svState, svs } from "../src/server/server";
import { EDICT_NUM, type EdictT } from "../src/progs/progs";
import { pr_builtin } from "../src/progs/pr_cmds";
import { setBuiltins } from "../src/progs/pr_exec";
import { Host_Init, host, hostClientHooks } from "../src/common/host";
import { HAVE_PROGS106 } from "./support/fixture_availability";
import {
  Host_Color_f,
  Host_Give_f,
  Host_Kick_f,
  Host_Name_f,
  Host_SavegameComment,
  Host_Say_f,
  Host_Status_f,
  SAVEGAME_VERSION,
  hostCmdState,
} from "../src/common/host_cmd";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "host-cmd-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;
const savedIsDedicated = sysState.isDedicated;
const savedCmdInitialized = cmdHost.initialized;
const savedNetHooks = getNetHostHooks();
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
const savedActiveConnections = net_activeconnections;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  sysState.isDedicated = savedIsDedicated;
  cmdHost.initialized = savedCmdInitialized;
  setNetHostHooks(savedNetHooks);
  setHostShutdown(null);
  setCvarServerHooks(null);
  setNetActiveConnections(savedActiveConnections);
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;
  svState.host_client = null;
  svState.sv_player = null;
  sv.clear();
  rmSync(scratchDir, { recursive: true, force: true });
});

// The smallest legal WAD2 -- Host_Init calls W_LoadWadFile("gfx.wad")
// unconditionally, dedicated or not.
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
  // test/pr_exec.test.ts and test/sv_phys.test.ts install their own stub
  // builtin tables through setBuiltins; progs106's worldspawn needs the real
  // pr_cmds.c table back (standing order 13: initialize what this suite reads).
  setBuiltins(pr_builtin);

  // No throw: a missing progs106/progs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_PROGS106), so this beforeAll simply has
  // nothing to set up for tests that never run.
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

  ensureDir(join(baseDir, "id1"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), entries);
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // -dedicated 1: one player slot, so `save`/`load` (svs.maxclients != 1
  // refuses) are reachable.
  // -nohomedir: this suite's `save`/`load` round-trips assert paths under
  // com_gamedir, which F3 makes the per-user home tier by default -- the
  // scratch basedir is the write target here.
  const argv = ["quake", "-basedir", baseDir, "-dedicated", "1", "-nohomedir"];
  COM_InitArgv(argv);
  cmdHost.initialized = false; // a previous suite in this process may have set it

  const parms = new QuakeParmsT();
  parms.basedir = baseDir;
  parms.argc = argv.length;
  parms.argv = argv;
  parms.memsize = 16 * 1024 * 1024;

  Host_Init(parms);
});

function freshClient(): ClientT {
  const c = new ClientT();
  c.message.data = c.msgbuf;
  c.message.maxsize = c.msgbuf.length;
  c.message.cursize = 0;
  return c;
}

// SV_ClientPrintf writes [svc_print][NUL-terminated string] per call.
function readPrints(buf: SizeBuf): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < buf.cursize) {
    if (buf.data[i] !== SvcOpsT.svc_print) break;
    i++;
    let s = "";
    while (i < buf.cursize && buf.data[i] !== 0) {
      s += String.fromCharCode(buf.data[i]);
      i++;
    }
    i++; // the terminator
    out.push(s);
  }
  return out;
}

function bytesOf(buf: SizeBuf): number[] {
  return Array.from(buf.data.subarray(0, buf.cursize));
}

// Cmd_ExecuteString's own body minus the name lookup. test/sv_user.test.ts
// registers its own `status` and `kick` command stubs, and Cmd_AddCommand
// keeps whichever registration came first in this shared process -- so the
// per-command tests below drive host_cmd.c's functions directly, exactly as
// Cmd_ExecuteString would once it had resolved the name.
function runCommand(text: string, src: CmdSourceT, fn: () => void): void {
  cmdState.source = src;
  Cmd_TokenizeString(text);
  fn();
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("the dedicated map boot", () => {
  test("`map world` spawns progs106's worldspawn on the synthetic level", () => {
    expect(host.initialized).toBe(true);
    expect(svs.maxclients).toBe(1);
    expect(Cvar_VariableValue("deathmatch")).toBe(0);

    Cmd_ExecuteString("map world", CmdSourceT.src_command);

    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
    expect(sv.model_precache[1]).toBe("maps/world.bsp");
    // worldspawn's 26 precache_model calls land in slots 2..27
    expect(sv.model_precache[2]).toBe(WORLDSPAWN_MODELS[0]);
    expect(sv.model_precache[2 + WORLDSPAWN_MODELS.length - 1]).toBe(WORLDSPAWN_MODELS[WORLDSPAWN_MODELS.length - 1]);
    // 1 world + 1 client slot + worldspawn's InitBodyQue bodies + the map's
    // info_player_start
    expect(sv.num_edicts).toBe(7);
    expect(sv.time).toBeCloseTo(1.2, 6);
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_SavegameComment", () => {
  test("levelname at 0, kills at 22, spaces turned into underscores", () => {
    hostClientHooks.clLevelname = () => "the Slipgate Complex";
    hostClientHooks.clStat = (n: number) => (n === STAT_MONSTERS ? 7 : n === STAT_TOTALMONSTERS ? 21 : 0);
    try {
      const comment = Host_SavegameComment();
      expect(comment.length).toBe(SAVEGAME_COMMENT_LENGTH);
      // "the Slipgate Complex" (20) then two pad columns, then
      // sprintf("kills:%3i/%3i", 7, 21) at offset 22, all spaces -> '_'
      expect(comment).toBe("the_Slipgate_Complex__kills:__7/_21____");
    } finally {
      hostClientHooks.clLevelname = null;
      hostClientHooks.clStat = null;
    }
  });

  test("with no client attached it is all underscores plus a zero killcount", () => {
    const comment = Host_SavegameComment();
    expect(comment).toBe("______________________kills:__0/__0____");
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_Savegame_f / Host_Loadgame_f", () => {
  test("roundtrips sv.time, the map name, the edict count and a player origin", () => {
    expect(sv.active).toBe(true);

    const beforeTime = sv.time;
    const beforeEdicts = sv.num_edicts;
    const player = EDICT_NUM(1);
    player.v.origin[0] = 12;
    player.v.origin[1] = 34;
    player.v.origin[2] = 56;
    svs.clients[0].spawn_parms[0] = 42.5;
    hostCmdState.current_skill = 2;

    Cmd_ExecuteString("save roundtrip", CmdSourceT.src_command);

    const savePath = join(com_gamedir, "roundtrip.sav");
    expect(existsSync(savePath)).toBe(true);
    const text = readFileSync(savePath, "latin1");
    const lines = text.split("\n");
    expect(lines[0]).toBe(String(SAVEGAME_VERSION));
    expect(lines[1]).toBe("______________________kills:__0/__0____");
    expect(lines[2]).toBe("42.500000"); // spawn_parms[0], "%f"
    expect(lines[3]).toBe("0.000000");
    expect(lines[2 + 16]).toBe("2"); // current_skill, "%d"
    expect(lines[3 + 16]).toBe("world"); // sv.name
    expect(lines[4 + 16]).toBe("1.200000"); // sv.time, "%f"
    // MAX_LIGHTSTYLES lines: progs106 worldspawn's own lightstyle() calls
    // (world.qc:297 `lightstyle(0, "m")`, :300 style 1, :335 `lightstyle(63,
    // "a")`), and "m" for whatever it left unset
    expect(lines[5 + 16]).toBe("m");
    expect(lines[5 + 16 + 1]).toBe("mmnmmommommnonmmonqnmmo");
    expect(lines[5 + 16 + MAX_LIGHTSTYLES - 1]).toBe("a");

    sv.time = 999;
    Cmd_ExecuteString("load roundtrip", CmdSourceT.src_command);

    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
    expect(sv.paused).toBe(true);
    expect(sv.loadgame).toBe(true);
    expect(sv.time).toBeCloseTo(beforeTime, 5);
    expect(sv.num_edicts).toBe(beforeEdicts);
    expect(Array.from(EDICT_NUM(1).v.origin)).toEqual([12, 34, 56]);
    expect(svs.clients[0].spawn_parms[0]).toBe(42.5);
    expect(hostCmdState.current_skill).toBe(2);
    expect(Cvar_VariableValue("skill")).toBe(2);
    // the light styles come back out of the file too
    expect(sv.lightstyles[0]).toBe("m");
    expect(sv.lightstyles[1]).toBe("mmnmmommommnonmmonqnmmo");
    expect(sv.lightstyles[MAX_LIGHTSTYLES - 1]).toBe("a");
  });

  test("refuses to save a multiplayer game", () => {
    const saveMax = svs.maxclients;
    svs.maxclients = 4;
    try {
      Cmd_ExecuteString("save nope", CmdSourceT.src_command);
      expect(existsSync(join(com_gamedir, "nope.sav"))).toBe(false);
    } finally {
      svs.maxclients = saveMax;
    }
  });

  test("refuses a relative pathname", () => {
    Cmd_ExecuteString("save ../escape", CmdSourceT.src_command);
    expect(existsSync(join(com_gamedir, "..", "escape.sav"))).toBe(false);
  });
});

//============================================================================
// The src_client commands. Each installs its own svs.clients and restores it.

function withClients<T>(count: number, body: (clients: ClientT[]) => T): T {
  const saveClients = svs.clients;
  const saveMax = svs.maxclients;
  const saveHostClient = svState.host_client;
  const saveSvPlayer = svState.sv_player;
  svs.clients = Array.from({ length: count }, () => freshClient());
  svs.maxclients = count;
  try {
    return body(svs.clients);
  } finally {
    svs.clients = saveClients;
    svs.maxclients = saveMax;
    svState.host_client = saveHostClient;
    svState.sv_player = saveSvPlayer;
  }
}

describe.skipIf(!HAVE_PROGS106)("Host_Name_f", () => {
  test("caps the name at 15 characters and broadcasts svc_updatename", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.name = "unconnected";
      c.edict = EDICT_NUM(1);
      svState.host_client = c;
      SZ_Clear(sv.reliable_datagram);

      runCommand("name ABCDEFGHIJKLMNOPQRSTUVWXYZ", CmdSourceT.src_client, Host_Name_f);

      expect(c.name).toBe("ABCDEFGHIJKLMNO");
      expect(c.name.length).toBe(15);
      expect(bytesOf(sv.reliable_datagram)).toEqual([
        SvcOpsT.svc_updatename,
        0,
        ...Array.from("ABCDEFGHIJKLMNO", (ch) => ch.charCodeAt(0)),
        0,
      ]);
    });
  });
});

describe.skipIf(!HAVE_PROGS106)("Host_Color_f", () => {
  // The `load` round-trip earlier in this file leaves sv.loadgame true (the
  // engine only clears it at the next SV_SpawnServer), and Host_Color_f's
  // S3 branch reads it -- so which path each test below wants is pinned
  // here rather than inherited from whatever ran before.
  const savedLoadgame = sv.loadgame;
  beforeEach(() => {
    sv.loadgame = false;
  });
  afterAll(() => {
    sv.loadgame = savedLoadgame;
  });

  test("masks to 4 bits, clamps to 13 and packs top*16+bottom", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.edict = EDICT_NUM(1);
      svState.host_client = c;
      SZ_Clear(sv.reliable_datagram);

      runCommand("color 14 15", CmdSourceT.src_client, Host_Color_f);

      expect(c.colors).toBe(13 * 16 + 13);
      expect(c.edict.v.team).toBe(14);
      expect(bytesOf(sv.reliable_datagram)).toEqual([SvcOpsT.svc_updatecolors, 0, 13 * 16 + 13]);
    });
  });

  test("a single argument sets both halves", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.edict = EDICT_NUM(1);
      svState.host_client = c;
      SZ_Clear(sv.reliable_datagram);

      runCommand("color 4", CmdSourceT.src_client, Host_Color_f);

      expect(c.colors).toBe(4 * 16 + 4);
    });
  });

  // S3: the `color` the reconnecting client sends during a load signon must
  // not overwrite the team the save restored -- quakec_ctf's TeamCheckLock
  // reads a changed `team` as a mid-game team change and kills the player.
  test("a load signon recovers the bottom colour from the restored team", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.spawned = false;
      c.colors = 0;
      c.edict = EDICT_NUM(1);
      c.edict.v.team = 14; // blue, as the save file restored it
      svState.host_client = c;
      SZ_Clear(sv.reliable_datagram);
      sv.loadgame = true;

      runCommand("color 0 0", CmdSourceT.src_client, Host_Color_f);

      expect(c.edict.v.team).toBe(14);
      expect(c.colors).toBe(13);
      expect(bytesOf(sv.reliable_datagram)).toEqual([SvcOpsT.svc_updatecolors, 0, 13]);
    });
  });

  test("a normal in-game `color` still writes the team, loadgame or not", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.spawned = true; // already in the game: an ordinary team change
      c.edict = EDICT_NUM(1);
      c.edict.v.team = 14;
      svState.host_client = c;
      SZ_Clear(sv.reliable_datagram);
      sv.loadgame = true;

      runCommand("color 0 3", CmdSourceT.src_client, Host_Color_f);

      expect(c.edict.v.team).toBe(4);
      expect(c.colors).toBe(3);
    });
  });
});

describe.skipIf(!HAVE_PROGS106)("Host_Say", () => {
  test("a client's say is `\\x01name: text`", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.spawned = true;
      c.name = "bob";
      svState.host_client = c;

      runCommand("say hello there", CmdSourceT.src_client, Host_Say_f);

      expect(readPrints(c.message)).toEqual(["bob: hello there\n"]);
    });
  });

  test("the dedicated console's say is `\\x01<hostname> text`", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.spawned = true;
      c.name = "bob";
      svState.host_client = null;

      runCommand("say server speaking", CmdSourceT.src_command, Host_Say_f);

      expect(readPrints(c.message)).toEqual(["<UNNAMED> server speaking\n"]);
    });
  });
});

describe.skipIf(!HAVE_PROGS106)("Host_Kick_f", () => {
  test("kick # <n> drops that slot and prints the trailing message", () => {
    const saveConnections = net_activeconnections;
    withClients(2, (clients) => {
      clients[0].active = true;
      clients[1].active = true;
      clients[1].name = "target";
      setNetActiveConnections(2);
      svState.host_client = null;

      runCommand("kick # 2 you are gone", CmdSourceT.src_command, Host_Kick_f);

      expect(readPrints(clients[1].message)[0]).toBe("Kicked by Console: you are gone\n");
      expect(clients[1].active).toBe(false);
      expect(clients[1].name).toBe("");
      expect(clients[1].old_frags).toBe(-999999);
    });
    setNetActiveConnections(saveConnections);
  });

  test("an out-of-range number is ignored", () => {
    withClients(2, (clients) => {
      clients[0].active = true;
      clients[1].active = true;
      svState.host_client = null;

      runCommand("kick # 99 bye", CmdSourceT.src_command, Host_Kick_f);

      expect(clients[0].active).toBe(true);
      expect(clients[1].active).toBe(true);
    });
  });
});

describe.skipIf(!HAVE_PROGS106)("Host_Give_f", () => {
  test("`give 2` sets IT_SHOTGUN", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      svState.host_client = c;
      const player = EDICT_NUM(1);
      player.v.items = 0;
      svState.sv_player = player;

      runCommand("give 2", CmdSourceT.src_client, Host_Give_f);

      expect(player.v.items | 0).toBe(IT_SHOTGUN);
    });
  });

  test("`give h 75` sets health", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      svState.host_client = c;
      const player = EDICT_NUM(1);
      svState.sv_player = player;

      runCommand("give h 75", CmdSourceT.src_client, Host_Give_f);

      expect(player.v.health).toBe(75);
    });
  });

  // D1: johnfitz's `give a` (Ironwail host_cmd.c:3447-3471) plus the
  // currentammo fix-up that follows every give.
  function givePlayer(text: string, prepare: (player: EdictT) => void): EdictT {
    return withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      svState.host_client = c;
      const player = EDICT_NUM(1);
      player.v.items = 0;
      player.v.armortype = 0;
      player.v.armorvalue = 0;
      player.v.weapon = 0;
      player.v.currentammo = 0;
      player.v.ammo_shells = 0;
      player.v.ammo_nails = 0;
      player.v.ammo_rockets = 0;
      player.v.ammo_cells = 0;
      svState.sv_player = player;
      prepare(player);
      runCommand(text, CmdSourceT.src_client, Host_Give_f);
      return player;
    });
  }

  test("`give a 250` is red armour: armortype 0.8, IT_ARMOR3", () => {
    const player = givePlayer("give a 250", () => {});
    expect(player.v.armortype).toBeCloseTo(0.8, 5);
    expect(player.v.armorvalue).toBe(250);
    expect(player.v.items | 0).toBe(IT_ARMOR3);
  });

  test("`give a 120` is yellow armour: armortype 0.6, IT_ARMOR2", () => {
    const player = givePlayer("give a 120", () => {});
    expect(player.v.armortype).toBeCloseTo(0.6, 5);
    expect(player.v.armorvalue).toBe(120);
    expect(player.v.items | 0).toBe(IT_ARMOR2);
  });

  test("`give a 50` is green armour and replaces the shell already worn", () => {
    const player = givePlayer("give a 50", (p) => {
      p.v.items = IT_ARMOR3;
    });
    expect(player.v.armortype).toBeCloseTo(0.3, 5);
    expect(player.v.armorvalue).toBe(50);
    expect(player.v.items | 0).toBe(IT_ARMOR1);
  });

  test("`give a 0` is armour 0, not a no-op -- the reference engines' `give all`", () => {
    const player = givePlayer("give a 0", () => {});
    expect(player.v.armorvalue).toBe(0);
    expect(player.v.items | 0).toBe(IT_ARMOR1);
  });

  test("the currentammo fix-up follows a shell give while the shotgun is out", () => {
    const player = givePlayer("give s 42", (p) => {
      p.v.weapon = IT_SHOTGUN;
    });
    expect(player.v.ammo_shells).toBe(42);
    expect(player.v.currentammo).toBe(42);
  });

  test("the currentammo fix-up follows a rocket give while the launcher is out", () => {
    const player = givePlayer("give r 17", (p) => {
      p.v.weapon = IT_ROCKET_LAUNCHER;
    });
    expect(player.v.ammo_rockets).toBe(17);
    expect(player.v.currentammo).toBe(17);
  });

  test("the currentammo fix-up leaves a weapon with no matching ammo alone", () => {
    const player = givePlayer("give s 42", (p) => {
      p.v.weapon = IT_AXE;
      p.v.currentammo = 7;
    });
    expect(player.v.currentammo).toBe(7);
  });

  // DEVIATION (QoL addition, documented in Host_GiveAll): the reference
  // engines reach the armour case through "all"'s leading 'a' and grant
  // armour 0. See src/common/host_cmd.ts.
  test("`give all` grants every weapon, full ammo, both keys and 200 armour", () => {
    const player = givePlayer("give all", (p) => {
      p.v.weapon = IT_LIGHTNING;
    });
    const weapons =
      IT_AXE | IT_SHOTGUN | IT_SUPER_SHOTGUN | IT_NAILGUN | IT_SUPER_NAILGUN | IT_GRENADE_LAUNCHER | IT_ROCKET_LAUNCHER | IT_LIGHTNING;
    expect((player.v.items | 0) & weapons).toBe(weapons);
    expect((player.v.items | 0) & (IT_KEY1 | IT_KEY2)).toBe(IT_KEY1 | IT_KEY2);
    expect(player.v.ammo_shells).toBe(100);
    expect(player.v.ammo_nails).toBe(200);
    expect(player.v.ammo_rockets).toBe(100);
    expect(player.v.ammo_cells).toBe(100);
    expect(player.v.armorvalue).toBe(200);
    expect(player.v.armortype).toBeCloseTo(0.8, 5);
    expect((player.v.items | 0) & IT_ARMOR3).toBe(IT_ARMOR3);
    // the fix-up runs after the QoL grant too
    expect(player.v.currentammo).toBe(100);
  });
});

describe.skipIf(!HAVE_PROGS106)("Host_Status_f", () => {
  test("prints the header block and one #n line per active client", () => {
    withClients(1, (clients) => {
      const c = clients[0];
      c.active = true;
      c.name = "playername";
      const sock = new QsocketT();
      sock.connecttime = net_time - 3661; // 1:01:01
      sock.address = "local";
      c.netconnection = sock;
      const edict = EDICT_NUM(1);
      edict.v.frags = 5;
      c.edict = edict;
      svState.host_client = c;

      runCommand("status", CmdSourceT.src_client, Host_Status_f);

      const lines = readPrints(c.message);
      expect(lines[0]).toBe("host:    UNNAMED\n");
      expect(lines[1]).toBe("version: 1.09\n");
      expect(lines[2]).toBe("map:     world\n");
      expect(lines[3]).toBe("players: 0 active (1 max)\n\n");
      // "#%-2u %-16.16s  %3i  %2i:%02i:%02i\n"
      expect(lines[4]).toBe("#1  " + "playername      " + "  " + "  5" + "  " + " 1:01:01" + "\n");
      expect(lines[5]).toBe("   local\n");
    });
  });
});

//============================================================================
// F3: Host_Game_f re-execs quake.rc with Cbuf_InsertText, so the whole
// default.cfg/config.cfg chain runs BEFORE whatever the caller queued behind
// the `game` line. The menus queue `game <dir>; sv_ruleset X; ...; map m`;
// with a tail append the newly mounted gamedir's archived `sv_ruleset "auto"`
// ran last and silently reverted the player's choice.
//
// Placed last in this file: it mounts a mod above the base tier, and puts the
// search path back in its own afterAll.

describe.skipIf(!HAVE_PROGS106)("Host_Game_f re-execs quake.rc ahead of the rest of the queued script", () => {
  const savedSearchpaths = com_searchpaths;
  const savedGamedir = com_gamedir;

  afterAll(() => {
    // sv_ruleset is left on "rerelease" by the last test below; a later
    // suite's dedicated boot would otherwise run the fixed-step server clock.
    Cvar_Set("sv_ruleset", "auto");
    setComSearchpaths(savedSearchpaths);
    setComGamedir(savedGamedir);
  });

  test("a cvar queued after `game` survives that gamedir's archived config.cfg", () => {
    // A mod whose quake.rc execs a config.cfg that archives sv_ruleset back
    // to "auto" -- exactly the shape of the retail rerelease/id1/config.cfg
    // this defect was found against.
    writeGameFile(baseDir, "rcmod/quake.rc", new TextEncoder().encode("exec config.cfg\n"));
    writeGameFile(baseDir, "rcmod/config.cfg", new TextEncoder().encode('sv_ruleset "auto"\n'));

    Cvar_Set("sv_ruleset", "auto");
    Cbuf_AddText("game rcmod\nsv_ruleset classic\n");
    Cbuf_Execute();

    expect(COM_GetGameNames()).toBe("rcmod");
    expect(Cvar_VariableString("sv_ruleset")).toBe("classic");
  });

  test("the same script with the gamedir's config.cfg absent still lands on the queued value", () => {
    Cvar_Set("sv_ruleset", "auto");
    Cbuf_AddText("game id1\nsv_ruleset rerelease\n");
    Cbuf_Execute();

    expect(COM_GetGameNames()).toBe("id1");
    expect(Cvar_VariableString("sv_ruleset")).toBe("rerelease");
  });
  // P8 (2026-09-07, Mike's play session): the menus queue `game <dir>` on
  // EVERY New Game / Start Server, and the switch always re-ran quake.rc --
  // default.cfg's unbindall and the archived config.cfg over the live
  // settings -- so every bind, option and console setting made since boot was
  // thrown away each time a game started. Ironwail's COM_Game_f: same layer
  // means no switch and no re-exec.
  test("`game` for the layer already mounted is a no-op: the live settings are kept", () => {
    Cbuf_AddText("game rcmod\n");
    Cbuf_Execute();
    expect(COM_GetGameNames()).toBe("rcmod");
    expect(Cvar_VariableString("sv_ruleset")).toBe("auto"); // rcmod's config.cfg archived it

    Cvar_Set("sv_ruleset", "classic"); // a setting made during play
    Cbuf_AddText("game rcmod\n");
    Cbuf_Execute();

    expect(COM_GetGameNames()).toBe("rcmod");
    expect(Cvar_VariableString("sv_ruleset")).toBe("classic"); // no quake.rc re-exec
  });

  test("a real switch archives the live settings into the outgoing gamedir's config.cfg first", () => {
    // Ironwail COM_SwitchGame: Host_WriteConfiguration before the teardown,
    // so the settings survive into the config the next quake.rc exec reads.
    expect(COM_GetGameNames()).toBe("rcmod");
    const outgoing = com_gamedir;
    Cvar_Set("sv_ruleset", "classic");
    const savedInit = host.initialized;
    const savedDedicated = sysState.isDedicated;
    host.initialized = true; // Host_WriteConfiguration's client-only guard
    sysState.isDedicated = false;
    try {
      Cbuf_AddText("game id1\n");
      Cbuf_Execute();
    } finally {
      host.initialized = savedInit;
      sysState.isDedicated = savedDedicated;
    }
    expect(COM_GetGameNames()).toBe("id1");
    const archived = readFileSync(join(outgoing, "config.cfg"), "utf8");
    expect(archived).toContain('sv_ruleset "classic"');
  });
});
