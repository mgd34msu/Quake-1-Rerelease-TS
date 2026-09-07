/*
Self-sufficient per standing order 13: this file builds its own scratch
basedir (id1/pak0.pak with gfx/pop.lmp + progs.dat + a minimal gfx.wad, and
a synthetic maps/world.bsp), calls COM_InitArgv itself and boots a real
dedicated host with Host_Init.

Every process-wide flag Host_Init installs (sysState.isDedicated,
cmdHost.initialized, setHostShutdown, setCvarServerHooks, setNetHostHooks,
svs/sv) is captured before and restored in afterAll, because `bun test` runs
every file in one process and the suites that follow this one register their
own net host hooks and add their own console commands.
*/

import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, com_gamedir, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Cbuf_AddText, Cmd_AddCommand, Cmd_Exists, Cmd_ExecuteString, CmdSourceT, cmdHost } from "../src/common/cmd";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set, Cvar_VariableString, Cvar_VariableValue, setCvarServerHooks } from "../src/common/cvar";
import { scr_sbarscale } from "../src/client/kfont_text";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../src/common/wad";
import { QuakeParmsT } from "../src/common/quakedef";
import { SvcOpsT } from "../src/common/protocol";
import { QsocketT } from "../src/common/net";
import type { SizeBuf } from "../src/common/sizebuf";
import { setHostShutdown, sysState } from "../src/platform/sys";
import * as sysModule from "../src/platform/sys";
import {
  NET_CheckNewConnections,
  NET_Connect,
  NET_Init,
  getNetHostHooks,
  setNetHostHooks,
  net_activeconnections,
  setNetActiveConnections,
  type NetHostHooks,
} from "../src/common/net_main";
import { ClientT, sv, svState, svs } from "../src/server/server";
import { pr_builtin } from "../src/progs/pr_cmds";
import { setBuiltins } from "../src/progs/pr_exec";
import { HAVE_PROGS106 } from "./support/fixture_availability";
import {
  HostError,
  Host_Error,
  Host_FilterTime,
  Host_Frame,
  Host_Init,
  Host_MigrateConfig,
  Host_ShutdownServer,
  Host_WriteConfiguration,
  SV_BroadcastPrintf,
  SV_ClientPrintf,
  SV_DropClient,
  SeatError,
  host,
  hostClientHooks,
  host_framerate,
} from "../src/common/host";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "host-test-"));
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

// The smallest legal WAD2 (wad.c's W_LoadWadFile only checks the "WAD2" id
// and walks numlumps lumpinfo_t records): one uncompressed TYP_NONE lump.
function buildWad2(): Uint8Array {
  const lumpData = new Uint8Array([1, 2, 3, 4]);
  const infotableofs = WADINFO_T_SIZE + lumpData.length;
  const total = infotableofs + LUMPINFO_T_SIZE;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 1, true); // numlumps
  view.setInt32(8, infotableofs, true);

  bytes.set(lumpData, WADINFO_T_SIZE);

  view.setInt32(infotableofs, WADINFO_T_SIZE, true); // filepos
  view.setInt32(infotableofs + 4, lumpData.length, true); // disksize
  view.setInt32(infotableofs + 8, lumpData.length, true); // size
  const name = "CONCHARS";
  for (let i = 0; i < name.length; i++) bytes[infotableofs + 16 + i] = name.charCodeAt(i);
  return bytes;
}

// progs106/world.qc's worldspawn precache_model list, in its C order. Every
// one has to exist on disk or PF_precache_model's Mod_ForName(s, true)
// Sys_Errors out of the spawn.
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

  // gfx/pop.lmp: the registered-version check's 128 big-endian shorts, as
  // test/sv_main.test.ts's recipe.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  const entries = [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: new Uint8Array(readFileSync(PROGS_DAT)) },
    { name: "gfx.wad", data: buildWad2() }, // Host_Init's W_LoadWadFile("gfx.wad")
  ];
  for (const m of WORLDSPAWN_MODELS)
    entries.push({ name: m, data: m.endsWith(".spr") ? buildSpr() : buildMdl({ numframes: 2 }) });

  ensureDir(join(baseDir, "id1"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), entries);
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // sys_linux.c's main(): COM_InitArgv, then the quakeparms_t, then Host_Init.
  const argv = ["quake", "-basedir", baseDir, "-dedicated", "-port", "26995", "-nohomedir"];
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

function bytesOf(buf: SizeBuf): number[] {
  return Array.from(buf.data.subarray(0, buf.cursize));
}

function stringAt(buf: SizeBuf, offset: number): string {
  let out = "";
  for (let i = offset; i < buf.cursize && buf.data[i] !== 0; i++) out += String.fromCharCode(buf.data[i]);
  return out;
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_Init (-dedicated)", () => {
  test("reaches host.initialized and locks the command table", () => {
    expect(host.initialized).toBe(true);
    expect(cmdHost.initialized).toBe(true);
    expect(sysState.isDedicated).toBe(true);
  });

  test("registers host_cmd.c's commands", () => {
    for (const name of ["status", "quit", "god", "map", "restart", "changelevel", "name", "say", "kick", "load", "save", "give", "mcache"])
      expect(Cmd_Exists(name)).toBe(true);
  });

  test("Host_MigrateConfig: a config from before cfg_version 2 gets the auto scales and the classic font once, a current one is left alone", () => {
    const cfg = Cvar_FindVar("cfg_version");
    expect(cfg).not.toBeNull();
    if (cfg === null) return;
    // A dedicated boot registers none of the three client cvars; register
    // kfont_text.ts's own scr_sbarscale object when it is not there yet, so
    // the reset can be observed (KfontText_RegisterCvars later finds it).
    if (Cvar_FindVar("scr_sbarscale") === null) Cvar_RegisterVariable(scr_sbarscale);
    const savedProbe = scr_sbarscale.string;
    const savedCfg = cfg.string;
    try {
      Cvar_Set("scr_sbarscale", "1");
      Cvar_Set("cfg_version", "0"); // what a config.cfg with no cfg_version line resolves to
      Host_MigrateConfig();
      expect(Cvar_VariableString("scr_sbarscale")).toBe("0");
      expect(Cvar_VariableValue("cfg_version")).toBe(2);

      Cvar_Set("scr_sbarscale", "1"); // the player's own later choice
      Host_MigrateConfig();
      expect(Cvar_VariableString("scr_sbarscale")).toBe("1");
      expect(Cvar_VariableValue("cfg_version")).toBe(2);

      // An old config whose value is NOT the old default was a choice: kept.
      Cvar_Set("scr_sbarscale", "2");
      Cvar_Set("cfg_version", "0");
      Host_MigrateConfig();
      expect(Cvar_VariableString("scr_sbarscale")).toBe("2");
      expect(Cvar_VariableValue("cfg_version")).toBe(2);
    } finally {
      Cvar_Set("cfg_version", savedCfg);
      Cvar_Set("scr_sbarscale", savedProbe);
    }
  });

  test("registers host.c's cvars", () => {
    for (const name of ["host_framerate", "host_speeds", "sys_ticrate", "serverprofile", "fraglimit", "timelimit", "teamplay", "samelevel", "noexit", "developer", "skill", "deathmatch", "coop", "pausable", "temp1"])
      expect(Cvar_FindVar(name)).not.toBeNull();
  });

  test("Host_FindMaxClients: bare -dedicated is 8 players, deathmatch 1, and the client pool is the full scoreboard", () => {
    expect(svs.maxclients).toBe(8);
    // G6: the pool is always MAX_SCOREBOARD so `maxplayers` can be raised to
    // 16 at runtime on any boot (the re-release hosts 16 from a plain boot).
    expect(svs.maxclientslimit).toBe(16);
    expect(svs.clients.length).toBe(16);
    expect(Cvar_VariableValue("deathmatch")).toBe(1);
  });

  test("com_gamedir points at the scratch id1", () => {
    expect(com_gamedir).toBe(join(baseDir, "id1"));
  });

  test("the dedicated `map` boot spawns the synthetic level", () => {
    Cmd_ExecuteString("map world", CmdSourceT.src_command);
    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
    // svs.maxclients + 1 client/world slots, then worldspawn's InitBodyQue
    // bodies and the map's info_player_start
    expect(sv.num_edicts).toBeGreaterThan(svs.maxclients + 1);
    expect(sv.model_precache[1]).toBe("maps/world.bsp");
    expect(sv.model_precache[2]).toBe("progs/player.mdl");
    expect(sv.worldmodel).not.toBeNull();

    Host_ShutdownServer(false);
    expect(sv.active).toBe(false);
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_FilterTime", () => {
  // host.c's Host_FilterTime has no sys_ticrate handling; sys_linux.c's
  // main() is what compares `time < sys_ticrate.value` for a dedicated
  // server, and that loop belongs to src/main.ts (U036).
  function reset(): void {
    host.realtime = 0;
    host.oldrealtime = 0;
    host.frametime = 0;
    host_framerate.value = 0;
    hostClientHooks.clsTimedemo = null;
  }

  test("refuses a frame shorter than 1/72 and still accumulates realtime", () => {
    reset();
    expect(Host_FilterTime(0.001)).toBe(false);
    expect(host.realtime).toBe(0.001);
    expect(host.oldrealtime).toBe(0);
    expect(host.frametime).toBe(0);
  });

  test("accepts a frame at 1/72 and advances oldrealtime", () => {
    reset();
    expect(Host_FilterTime(1.0 / 72.0)).toBe(true);
    expect(host.frametime).toBeCloseTo(1.0 / 72.0, 10);
    expect(host.oldrealtime).toBe(host.realtime);
  });

  test("cls.timedemo bypasses the 1/72 gate", () => {
    reset();
    hostClientHooks.clsTimedemo = () => true;
    expect(Host_FilterTime(0.0001)).toBe(true);
    // below the 0.001 floor, so it clamps up
    expect(host.frametime).toBe(0.001);
    hostClientHooks.clsTimedemo = null;
  });

  test("clamps a long frame to 0.1", () => {
    reset();
    expect(Host_FilterTime(5.0)).toBe(true);
    expect(host.frametime).toBe(0.1);
  });

  test("host_framerate overrides both clamps", () => {
    reset();
    host_framerate.value = 0.25;
    expect(Host_FilterTime(5.0)).toBe(true);
    expect(host.frametime).toBe(0.25);
    host_framerate.value = 0;
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_Frame", () => {
  test("runs a frame with no server active and does not throw", () => {
    const wasDedicated = sysState.isDedicated;
    sysState.isDedicated = false; // Sys_ConsoleInput only pumps stdin when dedicated
    try {
      sv.active = false;
      host.realtime = 0;
      host.oldrealtime = 0;
      const before = host.framecount;
      Host_Frame(0.5);
      expect(host.framecount).toBe(before + 1);
    } finally {
      sysState.isDedicated = wasDedicated;
    }
  });

  test("catches a HostError thrown by a console command instead of propagating", () => {
    const wasDedicated = sysState.isDedicated;
    sysState.isDedicated = false;
    // Cmd_AddCommand Sys_Errors once host_initialized is set (the C's hunk
    // comment); unlock it for this one registration, as the C could not.
    cmdHost.initialized = false;
    let ran = false;
    Cmd_AddCommand("host_test_throw", () => {
      ran = true;
      throw new HostError("deliberate");
    });
    cmdHost.initialized = true;

    try {
      sv.active = false;
      host.realtime = 0;
      host.oldrealtime = 0;
      const before = host.framecount;
      Cbuf_AddText("host_test_throw\n");
      expect(() => Host_Frame(0.5)).not.toThrow();
      expect(ran).toBe(true);
      // the longjmp equivalent returns from _Host_Frame before host_framecount++
      expect(host.framecount).toBe(before);
    } finally {
      sysState.isDedicated = wasDedicated;
    }
  });

  test("rethrows anything that is not HostError/HostEndGame", () => {
    const wasDedicated = sysState.isDedicated;
    sysState.isDedicated = false;
    cmdHost.initialized = false;
    Cmd_AddCommand("host_test_throw_other", () => {
      throw new RangeError("not a host error");
    });
    cmdHost.initialized = true;

    try {
      sv.active = false;
      host.realtime = 0;
      host.oldrealtime = 0;
      Cbuf_AddText("host_test_throw_other\n");
      expect(() => Host_Frame(0.5)).toThrow(RangeError);
    } finally {
      sysState.isDedicated = wasDedicated;
    }
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("SV_ClientPrintf / SV_BroadcastPrintf", () => {
  test("SV_ClientPrintf writes svc_print + the formatted string to host_client", () => {
    const c = freshClient();
    svState.host_client = c;
    SV_ClientPrintf("hi %s %i\n", "bob", 3);
    expect(c.message.data[0]).toBe(SvcOpsT.svc_print);
    expect(stringAt(c.message, 1)).toBe("hi bob 3\n");
    svState.host_client = null;
  });

  test("SV_BroadcastPrintf reaches every active+spawned client and skips the rest", () => {
    const saveClients = svs.clients;
    const saveMax = svs.maxclients;
    svs.clients = [freshClient(), freshClient(), freshClient()];
    svs.maxclients = 3;
    svs.clients[0].active = true;
    svs.clients[0].spawned = true;
    svs.clients[1].active = true; // not spawned
    svs.clients[2].active = false;
    svs.clients[2].spawned = true;

    SV_BroadcastPrintf("all: %s\n", "hello");

    expect(svs.clients[0].message.data[0]).toBe(SvcOpsT.svc_print);
    expect(stringAt(svs.clients[0].message, 1)).toBe("all: hello\n");
    expect(svs.clients[1].message.cursize).toBe(0);
    expect(svs.clients[2].message.cursize).toBe(0);

    svs.clients = saveClients;
    svs.maxclients = saveMax;
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("SV_DropClient", () => {
  test("frees the client and broadcasts updatename/updatefrags/updatecolors", () => {
    const saveClients = svs.clients;
    const saveMax = svs.maxclients;
    const saveConnections = net_activeconnections;

    svs.clients = [freshClient(), freshClient()];
    svs.maxclients = 2;
    const dropped = svs.clients[0];
    const watcher = svs.clients[1];
    dropped.active = true;
    dropped.spawned = false; // no ClientDisconnect progs call
    dropped.name = "victim";
    dropped.old_frags = 7;
    // A real client has a socket. NET_Close leaves an already-disconnected
    // one alone, which is all this needs from it.
    const sock = new QsocketT();
    sock.disconnected = true;
    dropped.netconnection = sock;
    watcher.active = true;
    setNetActiveConnections(2);

    svState.host_client = dropped;
    SV_DropClient(false);

    expect(dropped.active).toBe(false);
    expect(dropped.name).toBe("");
    expect(dropped.old_frags).toBe(-999999);
    expect(dropped.netconnection).toBeNull();
    expect(net_activeconnections).toBe(1);

    // svc_updatename 0 "" / svc_updatefrags 0 0 / svc_updatecolors 0 0
    expect(bytesOf(watcher.message)).toEqual([
      SvcOpsT.svc_updatename,
      0,
      0,
      SvcOpsT.svc_updatefrags,
      0,
      0,
      0,
      SvcOpsT.svc_updatecolors,
      0,
      0,
    ]);
    // the dropped client is no longer active, so it gets nothing
    expect(dropped.message.cursize).toBe(0);

    svState.host_client = null;
    setNetActiveConnections(saveConnections);
    svs.clients = saveClients;
    svs.maxclients = saveMax;
  });

  test("a client with no socket gives no connection back, because it never took one", () => {
    // src/bots: a bot is a client_t whose netconnection is null. It never
    // went through NET_CheckNewConnections, so it never incremented
    // net_activeconnections -- and Host_ShutdownServer drops every client on
    // every level change, which took the counter negative one bot at a time.
    const saveClients = svs.clients;
    const saveMax = svs.maxclients;
    const saveConnections = net_activeconnections;

    svs.clients = [freshClient()];
    svs.maxclients = 1;
    const dropped = svs.clients[0];
    dropped.active = true;
    dropped.spawned = false;
    dropped.name = "socketless";
    dropped.netconnection = null;
    setNetActiveConnections(0);

    svState.host_client = dropped;
    SV_DropClient(false);

    expect(dropped.active).toBe(false);
    expect(net_activeconnections).toBe(0);

    svState.host_client = null;
    setNetActiveConnections(saveConnections);
    svs.clients = saveClients;
    svs.maxclients = saveMax;
  });
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("Host_ShutdownServer", () => {
  const fakeHooks: NetHostHooks = {
    svActive: () => sv.active,
    svName: () => sv.name,
    svsMaxclients: () => svs.maxclients,
    svsMaxclientslimit: () => svs.maxclientslimit,
    setSvsMaxclients: () => {},
    clsStateDedicated: () => false,
    svsClients: () =>
      svs.clients.map((c) => ({
        active: c.active,
        name: c.name,
        colors: c.colors,
        frags: 0,
        netconnection: c.netconnection,
      })),
    deathmatch: () => false,
    hostClientPrivileged: () => false,
    svClientPrintf: () => {},
    scrUpdateScreen: () => {},
    menuSetReturnReason: () => {},
    menuHandleConnectError: () => {},
    menuConnectSucceeded: () => {},
    hostTime: () => host.time,
  };

  test("flushes, drops and clears every client over the loopback driver", () => {
    const saveClients = svs.clients;
    const saveMax = svs.maxclients;
    const saveLimit = svs.maxclientslimit;
    const saveHooks = getNetHostHooks();
    const saveConnections = net_activeconnections;
    const wasDedicated = sysState.isDedicated;
    setNetHostHooks(fakeHooks);

    // net_loop.c's Loop_Init returns -1 (driver not initialized) when
    // cls.state == ca_dedicated, so the -dedicated Host_Init above left the
    // loop driver down. Bring it up the way a listen server would.
    sysState.isDedicated = false;
    cmdHost.initialized = false; // NET_Init re-adds slist/listen/maxplayers/port
    NET_Init();
    cmdHost.initialized = true;

    svs.clients = [freshClient()];
    svs.maxclients = 1;
    svs.maxclientslimit = 1;

    const client = NET_Connect("local");
    expect(client).not.toBeNull();
    const server = NET_CheckNewConnections();
    expect(server).not.toBeNull();

    const slot = svs.clients[0];
    slot.active = true;
    slot.spawned = false;
    slot.name = "loopplayer";
    slot.netconnection = server;
    setNetActiveConnections(1);

    // something pending, so the flush loop's NET_SendMessage path runs
    slot.message.data[0] = SvcOpsT.svc_nop;
    slot.message.cursize = 1;

    sv.active = true;
    const start = Date.now();
    Host_ShutdownServer(false);
    expect(Date.now() - start).toBeLessThan(3500); // the C's 3-second flush cap

    expect(sv.active).toBe(false);
    // memset (svs.clients, 0, svs.maxclientslimit*sizeof(client_t))
    expect(svs.clients[0]).not.toBe(slot);
    expect(svs.clients[0].active).toBe(false);
    expect(svs.clients[0].name).toBe("");
    expect(svState.host_client).toBeNull();

    if (client !== null) client.disconnected = true;

    setNetActiveConnections(saveConnections);
    setNetHostHooks(saveHooks);
    sysState.isDedicated = wasDedicated;
    svs.clients = saveClients;
    svs.maxclients = saveMax;
    svs.maxclientslimit = saveLimit;
  });

  test("returns immediately when no server is active", () => {
    sv.active = false;
    expect(() => Host_ShutdownServer(false)).not.toThrow();
  });
});

//============================================================================

/*
U43 (local splitscreen): Host_Error's scope is the client it was raised for.
This block drives host.ts's own contract with fake ssActiveSeat/ssSeatFailed
hooks rather than importing splitscreen.ts, which is where the other half of
the pair is tested (test/splitscreen.test.ts).
*/
describe("Host_Error is scoped to the seat it was raised in", () => {
  const savedHooks = {
    ssActiveSeat: hostClientHooks.ssActiveSeat,
    ssSeatFailed: hostClientHooks.ssSeatFailed,
    clDisconnect: hostClientHooks.clDisconnect,
    setClsDemonum: hostClientHooks.setClsDemonum,
    scrEndLoadingPlaque: hostClientHooks.scrEndLoadingPlaque,
  };
  const savedIsDedicatedHere = sysState.isDedicated;
  const savedSvActive = sv.active;

  let seat = 0;
  let dropped: number[] = [];
  let disconnects = 0;
  let demonum = 0;

  beforeAll(() => {
    // Host_Error's dedicated branch is Sys_Error, which never returns; a
    // splitscreen session is a client one by definition.
    sysState.isDedicated = false;
    hostClientHooks.scrEndLoadingPlaque = null;
    hostClientHooks.ssActiveSeat = () => seat;
    hostClientHooks.ssSeatFailed = (n: number) => {
      dropped.push(n);
    };
    hostClientHooks.clDisconnect = () => {
      disconnects++;
    };
    hostClientHooks.setClsDemonum = (n: number) => {
      demonum = n;
    };
  });

  afterAll(() => {
    hostClientHooks.ssActiveSeat = savedHooks.ssActiveSeat;
    hostClientHooks.ssSeatFailed = savedHooks.ssSeatFailed;
    hostClientHooks.clDisconnect = savedHooks.clDisconnect;
    hostClientHooks.setClsDemonum = savedHooks.setClsDemonum;
    hostClientHooks.scrEndLoadingPlaque = savedHooks.scrEndLoadingPlaque;
    sysState.isDedicated = savedIsDedicatedHere;
    sv.active = savedSvActive;
  });

  function reset(active: number): void {
    seat = active;
    dropped = [];
    disconnects = 0;
    demonum = 0;
  }

  function raise(message: string): unknown {
    try {
      Host_Error(message);
    } catch (e) {
      return e;
    }
    return null;
  }

  test("a seat past 0 loses the seat, not the server and not the primary client", () => {
    reset(2);
    sv.active = true; // the thing a seat's error must not shut down

    const thrown = raise("CL_ParseServerMessage: Illegible server message");

    expect(thrown).toBeInstanceOf(SeatError);
    expect(thrown instanceof SeatError ? thrown.seat : -1).toBe(2);
    expect(dropped).toEqual([2]);
    // neither Host_ShutdownServer nor CL_Disconnect ran
    expect(sv.active).toBe(true);
    expect(disconnects).toBe(0);
    expect(demonum).toBe(0);

    sv.active = false;
  });

  test("the SeatError is still a HostError, so _Host_Frame's own catch stands", () => {
    reset(1);
    sv.active = false;
    expect(raise("bad")).toBeInstanceOf(HostError);
  });

  test("seat 0 takes the C's path: disconnect, cls.demonum = -1, a plain HostError", () => {
    reset(0);
    sv.active = false;

    const thrown = raise("CL_ParseServerMessage: Illegible server message");

    expect(thrown).toBeInstanceOf(HostError);
    expect(thrown instanceof SeatError).toBe(false);
    expect(dropped).toEqual([]);
    expect(disconnects).toBe(1);
    expect(demonum).toBe(-1);
  });

  test("with no seat hooks installed at all -- a dedicated server, a single-seat client -- it is seat 0's path", () => {
    reset(0);
    sv.active = false;
    hostClientHooks.ssActiveSeat = null;

    const thrown = raise("no hooks");

    expect(thrown).toBeInstanceOf(HostError);
    expect(thrown instanceof SeatError).toBe(false);
    expect(disconnects).toBe(1);

    hostClientHooks.ssActiveSeat = () => seat;
  });

  test("an error raised while the failed seat is being torn down takes the whole host down", () => {
    reset(3);
    sv.active = false;
    let inner: unknown = null;
    hostClientHooks.ssSeatFailed = (n: number) => {
      dropped.push(n);
      inner = raise("the teardown itself failed");
    };

    const thrown = raise("CL_ParseServerMessage: Illegible server message");

    // the outer call still reports its own seat failure ...
    expect(thrown).toBeInstanceOf(SeatError);
    // ... but the one raised inside the teardown is the session's
    expect(inner).toBeInstanceOf(HostError);
    expect(inner instanceof SeatError).toBe(false);
    expect(disconnects).toBe(1);
    expect(dropped).toEqual([3]);

    hostClientHooks.ssSeatFailed = (n: number) => {
      dropped.push(n);
    };
  });

  test("and `inerror` is left clear, so the next Host_Error is not a recursive one", () => {
    reset(0);
    sv.active = false;
    expect(raise("first")).toBeInstanceOf(HostError);
    expect(raise("second")).toBeInstanceOf(HostError);
    expect(disconnects).toBe(2);
  });
});

/*
host.c's Host_WriteConfiguration tests `fopen (va("%s/config.cfg",
com_gamedir), "w")` against NULL and prints "Couldn't write config.cfg."
rather than dying. src/platform/sys.ts's Sys_FileOpenWriteNonFatal is what
makes that branch reachable here: plain Sys_FileOpenWrite raises Sys_Error
instead, which used to leave the failure to propagate out through
Host_Shutdown/Sys_Quit.

This suite boots -dedicated and Host_WriteConfiguration's first line skips a
dedicated server, so sysState.isDedicated is cleared around each call and put
back in the same test (the file's own afterAll restores it too).
*/
describe.skipIf(!HAVE_PROGS106)("Host_WriteConfiguration", () => {
  const sysPrintfSpy = spyOn(sysModule, "Sys_Printf"); // bare call-through spy (rule 15)
  const configPath = (): string => join(com_gamedir, "config.cfg");

  function writeConfigAsClient(): void {
    const wasDedicated = sysState.isDedicated;
    sysState.isDedicated = false;
    try {
      Host_WriteConfiguration();
    } finally {
      sysState.isDedicated = wasDedicated;
    }
  }

  afterAll(() => {
    sysPrintfSpy.mockRestore();
    rmSync(configPath(), { recursive: true, force: true });
  });

  test("writes config.cfg into com_gamedir", () => {
    rmSync(configPath(), { recursive: true, force: true });

    writeConfigAsClient();

    expect(existsSync(configPath())).toBe(true);
    expect(readFileSync(configPath(), "utf8").length).toBeGreaterThan(0);
  });

  test('prints "Couldn\'t write config.cfg." and returns when the open fails', () => {
    // openSync(path, "w+") on an existing directory fails (EISDIR), which is
    // the same NULL the C's fopen hands back for an unwritable path.
    rmSync(configPath(), { recursive: true, force: true });
    mkdirSync(configPath());
    sysPrintfSpy.mockClear();

    expect(() => writeConfigAsClient()).not.toThrow();

    const printed = sysPrintfSpy.mock.calls.filter((c) => String(c[1]).includes("Couldn't write config.cfg."));
    expect(printed.length).toBeGreaterThan(0);
    // nothing was written over it: the directory is still a directory
    expect(statSync(configPath()).isDirectory()).toBe(true);
  });

  test("and the host is still initialized afterwards -- the failed open ran no shutdown", () => {
    expect(host.initialized).toBe(true);
    expect(cmdHost.initialized).toBe(true);
  });
});

/*
F20 defect D3, end to end through the real drain: two commands the engine
read in two separate reads, drained by one frame's Host_GetConsoleCommands,
must stay two commands. Sys_ConsoleInput used to hand back each read minus
its last byte, and Host_GetConsoleCommands's bare Cbuf_AddText per call then
glued them: `test_f20_first a` + `test_f20_second b` executed as the single
command `test_f20_first atest_f20_second b`.

The child starts the stdin reader FIRST and then does nothing for two
seconds: that is what puts each write in the queue as its own entry (a
reader started after both writes sees them as one read, which the old code
happened to survive, because it kept that read's embedded newline).

A child process: Bun.stdin.stream() can be taken only once per process, and
taking it in this suite would swallow the runner's own stdin (the same reason
test/sys.test.ts spawns one).
*/
describe("Host_GetConsoleCommands", () => {
  test("keeps two stdin reads drained in one frame as two commands", async () => {
    const hostPath = new URL("../src/common/host.ts", import.meta.url).pathname;
    const cmdPath = new URL("../src/common/cmd.ts", import.meta.url).pathname;
    const sysPath = new URL("../src/platform/sys.ts", import.meta.url).pathname;
    const child = `
      const { Host_GetConsoleCommands } = await import(${JSON.stringify(hostPath)});
      const { Cbuf_Execute, Cbuf_Init, Cmd_AddCommand, Cmd_Argv } = await import(${JSON.stringify(cmdPath)});
      const { Sys_ConsoleInput, sysState } = await import(${JSON.stringify(sysPath)});
      Cbuf_Init(); // Host_Init's own first step: the command buffer's storage
      sysState.isDedicated = true;
      Sys_ConsoleInput(); // starts the background stdin reader
      const ran = [];
      Cmd_AddCommand("test_f20_first", () => ran.push("first:" + Cmd_Argv(1)));
      Cmd_AddCommand("test_f20_second", () => ran.push("second:" + Cmd_Argv(1)));
      await Bun.sleep(2000); // both writes are read into the queue, nothing drains it
      for (let i = 0; i < 200 && ran.length < 2; i++) {
        Host_GetConsoleCommands();
        Cbuf_Execute();
        await Bun.sleep(25);
      }
      console.log("RAN:" + JSON.stringify(ran));
      process.exit(0);
    `;

    const proc = Bun.spawn(["bun", "-e", child], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(800); // the child's reader is up and idle
    proc.stdin.write("test_f20_first a\n");
    proc.stdin.flush();
    await Bun.sleep(300); // a second read, not a continuation of the first
    proc.stdin.write("test_f20_second b\n");
    proc.stdin.flush();

    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;

    const match = /RAN:(\[.*\])/.exec(`${out}${err}`);
    expect(match).not.toBeNull();
    const ran: unknown = JSON.parse(match === null ? "[]" : match[1]);
    expect(ran).toEqual(["first:a", "second:b"]);
  }, 30000);
});
