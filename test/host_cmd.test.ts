/*
Self-sufficient per standing order 13: this file builds its own scratch
basedir (id1/pak0.pak with gfx/pop.lmp + progs.dat + a minimal gfx.wad + every
model progs106's worldspawn precaches, plus a synthetic maps/world.bsp), calls
COM_InitArgv itself and boots a real `-dedicated 1` host with Host_Init, so
`map`, `save` and `load` run end to end against progs106/progs.dat.

Every process-wide flag Host_Init installs is captured before and restored in
afterAll (`bun test` runs every file in one process).
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, com_gamedir, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Cmd_ExecuteString, Cmd_TokenizeString, CmdSourceT, cmdHost, cmdState } from "../src/common/cmd";
import { Cvar_VariableValue, setCvarServerHooks } from "../src/common/cvar";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../src/common/wad";
import { IT_SHOTGUN, MAX_LIGHTSTYLES, QuakeParmsT, SAVEGAME_COMMENT_LENGTH, STAT_MONSTERS, STAT_TOTALMONSTERS } from "../src/common/quakedef";
import { SvcOpsT } from "../src/common/protocol";
import type { SizeBuf } from "../src/common/sizebuf";
import { SZ_Clear } from "../src/common/sizebuf";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { QsocketT } from "../src/common/net";
import { getNetHostHooks, net_activeconnections, net_time, setNetActiveConnections, setNetHostHooks } from "../src/common/net_main";
import { ClientT, sv, svState, svs } from "../src/server/server";
import { EDICT_NUM } from "../src/progs/progs";
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
