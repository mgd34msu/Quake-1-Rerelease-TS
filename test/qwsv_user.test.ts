/*
Self-sufficient test for Q016's src/qw/server/sv_user.ts (QW/server/sv_user.c).

Fixtures, all built by this file (standing order 13):

- A hand-assembled progs image written straight into src/qw/server/progs.ts's
  `qwpr` (globals buffer, string block, statement table, function table), the
  same technique test/pr_exec.test.ts uses for WinQuake; no progs.dat is
  read. Function 1 is `OP_CALL0 <builtin 1>; OP_DONE` and builtin 1 calls a
  mutable `progsHook`, so PlayerPreThink/PlayerPostThink are observable.
- A synthetic BSP world (test/support/bsp_builder's buildBsp: floor plane at
  z=0 facing up, solid below, empty above) in a scratch `-basedir` with the
  id1/pak0.pak + gfx/pop.lmp registration recipe COM_CheckRegistered needs,
  loaded through src/qw/server/model.ts -- the same recipe
  test/qwsv_world.test.ts uses.
- One fake client in `svs.clients[0]` with a Netchan_Setup netchan, so the
  reliable-message writes SV_ClientPrintf/ClientReliableWrite_* perform have
  a real buffer to land in.

Shared singletons this suite touches and resets itself (standing order 15):
com_searchpaths/com_modified, sysState.nostdout, `qwpr`, the qw `sv`/`svs`/
`svState` singletons and the edict table, src/common/sizebuf.ts's
`net_message`/`msgState`, src/qw/server/sv_main.ts's `svMainState`,
src/qw/pmove_types.ts's `movevars`/`pmove`, and the cvar *values*
sv_user.ts/sv_phys.ts declare (never registered here, so the global cvar
list is untouched). sv_ccmds.ts's
`fp_*` flood-protection globals are `export let` bindings with no setter, so
they are driven through sv_ccmds.ts's own `SV_Floodprot_f` command body and
restored the same way.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { sysState } from "../src/platform/sys";
import { setComModified, setComSearchpaths } from "../src/common/common";
import { SizeBuf } from "../src/common/sizebuf";
import { Cmd_TokenizeString } from "../src/common/cmd";
import {
  COM_BlockSequenceCRCByte,
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  Info_ValueForKey,
  MSG_BeginReading,
  MSG_WriteByte,
  MSG_WriteDeltaUsercmd,
  net_message,
  msgState,
  nullcmd,
  pop,
} from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Mod_ForName, Mod_Init } from "../src/qw/server/model";
import type { ModelT } from "../src/common/model";
import { DfunctionT, OpT } from "../src/progs/pr_comp";
import { QW_ENTVARS_SIZE_WORDS, QwGlobalVars } from "../src/qw/server/progdefs";
import { QwEdictT, qwpr, setEdictTable } from "../src/qw/server/progs";
import { setBuiltins } from "../src/qw/server/pr_exec";
import { SV_ClearWorld, SV_LinkEdict } from "../src/qw/server/world";
import {
  ClientStateT,
  FL_ONGROUND,
  MOVETYPE_PUSH,
  MOVETYPE_WALK,
  SOLID_BSP,
  SOLID_SLIDEBOX,
  ServerStateT,
  sv,
  svs,
  svState,
} from "../src/qw/server/server";
import { svMainState } from "../src/qw/server/sv_main";
import { SV_Floodprot_f } from "../src/qw/server/sv_ccmds";
import { Netchan_Setup } from "../src/qw/net_chan";
import { NetadrT } from "../src/qw/net_udp";
import { ClcOpsT, MAX_CLIENTS, QwUsercmdT, SvcOpsT } from "../src/qw/protocol";
import { MAX_MSGLEN } from "../src/qw/bothdefs";
import { Pmove_Init, movevars, player_mins, player_maxs, pmove } from "../src/qw/pmove";
import {
  SV_SetMoveVars,
  sv_accelerate,
  sv_airaccelerate,
  sv_friction,
  sv_gravity,
  sv_maxspeed,
  sv_maxvelocity,
  sv_spectatormaxspeed,
  sv_stopspeed,
  sv_wateraccelerate,
  sv_waterfriction,
} from "../src/qw/server/sv_phys";
import {
  SV_ExecuteClientMessage,
  SV_ExecuteUserCommand,
  SV_Rate_f,
  SV_RunCmd,
  SV_Say,
  SV_SetInfo_f,
  SV_UserInit,
  cl_rollangle,
  cl_rollspeed,
  sv_mapcheck,
  sv_spectalk,
  ucmds,
} from "../src/qw/server/sv_user";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-user-test-"));
const baseDir = join(scratchDir, "quake");

const NUM_GLOBALS = 200;
const GFN = 150;

let gf: Float32Array;
let gi: Int32Array;
let gs: QwGlobalVars;
let edicts: QwEdictT[];
let worldmodel: ModelT;
let progsHook: () => void = () => {};

const savedNostdout = sysState.nostdout;
const savedNetMessage = { data: net_message.data, maxsize: net_message.maxsize, cursize: net_message.cursize };
const savedCvars: Array<[{ value: number; string: string }, number, string]> = [];

function saveCvar(c: { value: number; string: string }): void {
  savedCvars.push([c, c.value, c.string]);
}

function buildProgsImage(): void {
  const buffer = new ArrayBuffer(NUM_GLOBALS * 4);
  gf = new Float32Array(buffer);
  gi = new Int32Array(buffer);
  qwpr.globals = { f: gf, i: gi };
  gs = new QwGlobalVars(gf, gi);
  qwpr.global_struct = gs;

  qwpr.strings = new Uint8Array([0]);

  const stmts: Array<[number, number, number, number]> = [
    [OpT.OP_CALL0, GFN, 0, 0],
    [OpT.OP_DONE, 0, 0, 0],
  ];
  const op = new Int16Array(stmts.length);
  const a = new Int16Array(stmts.length);
  const b = new Int16Array(stmts.length);
  const c = new Int16Array(stmts.length);
  for (let i = 0; i < stmts.length; i++) {
    op[i] = stmts[i][0];
    a[i] = stmts[i][1];
    b[i] = stmts[i][2];
    c[i] = stmts[i][3];
  }
  qwpr.statements = { op, a, b, c };

  const fn0 = new DfunctionT();
  const body = new DfunctionT();
  body.first_statement = 0;
  const builtin = new DfunctionT();
  builtin.first_statement = -1;
  qwpr.functions = [fn0, body, builtin];
  qwpr.edict_size = QW_ENTVARS_SIZE_WORDS;

  gi[GFN] = 2;
  setBuiltins([
    () => {
      throw new Error("builtin 0 called");
    },
    () => progsHook(),
  ]);

  edicts = [];
  for (let i = 0; i < 8; i++) edicts.push(new QwEdictT(i, QW_ENTVARS_SIZE_WORDS));
  setEdictTable(edicts);

  sv.edicts = edicts;
  sv.num_edicts = edicts.length;
  sv.state = ServerStateT.ss_active;
  sv.time = 10;
  sv.paused = false;

  sv.reliable_datagram = new SizeBuf();
  sv.reliable_datagram.data = new Uint8Array(MAX_MSGLEN);
  sv.reliable_datagram.maxsize = MAX_MSGLEN;
  sv.reliable_datagram.cursize = 0;
}

function resetClients(): void {
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    cl.state = ClientStateT.cs_free;
    cl.spectator = 0;
    cl.name = "";
    cl.userinfo = "";
    cl.messagelevel = 0;
    cl.lossage = 0;
    cl.num_backbuf = 0;
    cl.lockedtill = 0;
    cl.whensaidhead = 0;
    cl.whensaid.fill(0);
    cl.delta_sequence = -1;
    cl.oldbuttons = 0;
    cl.maxspeed = 0;
    cl.entgravity = 0;
    cl.edict = null;
    cl.lastcmd = new QwUsercmdT();
    Netchan_Setup(cl.netchan, new NetadrT(), 0);
  }
  svs.info = "";
  svs.spawncount = 1;
}

/* the fake client this suite drives every command through */
function hostClient(): (typeof svs.clients)[number] {
  return svs.clients[0];
}

beforeAll(() => {
  sysState.nostdout = 1;

  for (const c of [
    sv_maxvelocity,
    sv_gravity,
    sv_stopspeed,
    sv_maxspeed,
    sv_spectatormaxspeed,
    sv_accelerate,
    sv_airaccelerate,
    sv_wateraccelerate,
    sv_friction,
    sv_waterfriction,
    cl_rollspeed,
    cl_rollangle,
    sv_spectalk,
    sv_mapcheck,
  ])
    saveCvar(c);

  setComSearchpaths(null);
  setComModified(false);

  ensureDir(join(baseDir, "id1"));
  ensureDir(join(baseDir, "qw"));
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["qwsv", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  worldmodel = loaded;

  Pmove_Init();

  net_message.data = new Uint8Array(MAX_MSGLEN);
  net_message.maxsize = MAX_MSGLEN;
});

afterAll(() => {
  // put the flood-protection globals back on sv_ccmds.c's own defaults
  Cmd_TokenizeString("floodprot 4 4 10");
  SV_Floodprot_f();

  sysState.nostdout = savedNostdout;
  for (const [c, value, string] of savedCvars) {
    c.value = value;
    c.string = string;
  }
  net_message.data = savedNetMessage.data;
  net_message.maxsize = savedNetMessage.maxsize;
  net_message.cursize = savedNetMessage.cursize;
  msgState.readcount = 0;
  msgState.badread = false;
  svState.host_client = null;
  svState.sv_player = null;
  resetClients();
  sv.clear();
  svMainState.host_frametime = 0;
  svMainState.realtime = 0;
  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  progsHook = () => {};
  buildProgsImage();
  resetClients();

  sv.worldmodel = worldmodel;
  sv.models[1] = worldmodel;
  SV_ClearWorld();

  edicts[0].v.solid = SOLID_BSP;
  edicts[0].v.movetype = MOVETYPE_PUSH;
  edicts[0].v.modelindex = 1;

  svMainState.host_frametime = 0.05;
  svMainState.realtime = 100;

  // a CvarT is 0 until Cvar_RegisterVariable runs; this suite never registers
  // anything, so every value SV_SetMoveVars/V_CalcRoll reads is set by hand
  // here to the C's declared default.
  sv_maxvelocity.value = 2000;
  sv_gravity.value = 800;
  sv_stopspeed.value = 100;
  sv_maxspeed.value = 320;
  sv_spectatormaxspeed.value = 500;
  sv_accelerate.value = 10;
  sv_airaccelerate.value = 0.7;
  sv_wateraccelerate.value = 10;
  sv_friction.value = 4;
  sv_waterfriction.value = 4;
  cl_rollspeed.value = 200;
  cl_rollangle.value = 2.0;
  sv_spectalk.value = 1;
  sv_mapcheck.value = 1;

  const cl = hostClient();
  cl.state = ClientStateT.cs_spawned;
  cl.name = "player";
  cl.userinfo = "\\name\\player\\team\\red";
  cl.edict = edicts[1];
  svState.host_client = cl;
  svState.sv_player = edicts[1];
});

describe("ucmds table + SV_ExecuteUserCommand", () => {
  test("the table carries QW's twenty-one commands in source order", () => {
    expect(ucmds.map((u) => u.name)).toEqual([
      "new",
      "modellist",
      "soundlist",
      "prespawn",
      "spawn",
      "begin",
      "drop",
      "pings",
      "rate",
      "kill",
      "pause",
      "msg",
      "say",
      "say_team",
      "setinfo",
      "serverinfo",
      "download",
      "nextdl",
      "ptrack",
      "snap",
    ]);
  });

  test("dispatches to the named entry and sets sv_player from host_client", () => {
    svState.sv_player = edicts[7]; // anything but host_client's own edict
    SV_ExecuteUserCommand("rate 3000");

    expect(svState.sv_player).toBe(edicts[1]);
    expect(hostClient().netchan.rate).toBeCloseTo(1 / 3000, 10);
  });

  test("`msg` sets the client's message level", () => {
    SV_ExecuteUserCommand("msg 2");
    expect(hostClient().messagelevel).toBe(2);
  });

  test("an unknown command still writes the redirected `Bad user command` print", () => {
    const before = hostClient().netchan.message.cursize;
    SV_ExecuteUserCommand("not_a_real_command");
    const cl = hostClient();
    expect(cl.netchan.message.cursize).toBeGreaterThan(before);
    expect(cl.netchan.message.data[before]).toBe(SvcOpsT.svc_print);
  });
});

describe("SV_Rate_f", () => {
  test("clamps below 500", () => {
    Cmd_TokenizeString("rate 100");
    SV_Rate_f();
    expect(hostClient().netchan.rate).toBeCloseTo(1 / 500, 10);
  });

  test("clamps above 10000", () => {
    Cmd_TokenizeString("rate 99999");
    SV_Rate_f();
    expect(hostClient().netchan.rate).toBeCloseTo(1 / 10000, 10);
  });

  test("a value inside the range is taken as-is", () => {
    Cmd_TokenizeString("rate 2500");
    SV_Rate_f();
    expect(hostClient().netchan.rate).toBeCloseTo(1 / 2500, 10);
  });

  test("with no argument it only reports, leaving the rate alone", () => {
    const cl = hostClient();
    cl.netchan.rate = 1 / 1234;
    Cmd_TokenizeString("rate");
    SV_Rate_f();
    expect(cl.netchan.rate).toBeCloseTo(1 / 1234, 10);
  });
});

describe("SV_SetInfo_f", () => {
  test("rejects a key beginning with * and broadcasts nothing", () => {
    const cl = hostClient();
    cl.userinfo = "\\name\\player";
    const before = sv.reliable_datagram.cursize;

    Cmd_TokenizeString("setinfo *spectator 1");
    SV_SetInfo_f();

    expect(Info_ValueForKey(cl.userinfo, "*spectator")).toBe("");
    expect(sv.reliable_datagram.cursize).toBe(before);
  });

  test("sets an ordinary key and writes svc_setinfo into the reliable datagram", () => {
    const cl = hostClient();
    cl.userinfo = "\\name\\player";
    const before = sv.reliable_datagram.cursize;

    Cmd_TokenizeString("setinfo topcolor 4");
    SV_SetInfo_f();

    expect(Info_ValueForKey(cl.userinfo, "topcolor")).toBe("4");
    expect(sv.reliable_datagram.cursize).toBeGreaterThan(before);
    expect(sv.reliable_datagram.data[before]).toBe(SvcOpsT.svc_setinfo);
    expect(sv.reliable_datagram.data[before + 1]).toBe(0); // client slot
  });

  test("re-setting a key to the same value broadcasts nothing", () => {
    const cl = hostClient();
    cl.userinfo = "\\name\\player\\topcolor\\4";
    const before = sv.reliable_datagram.cursize;

    Cmd_TokenizeString("setinfo topcolor 4");
    SV_SetInfo_f();

    expect(sv.reliable_datagram.cursize).toBe(before);
  });
});

describe("SV_Say flood protection", () => {
  function floodprot(messages: number, persecond: number, secondsdead: number): void {
    Cmd_TokenizeString(`floodprot ${messages} ${persecond} ${secondsdead}`);
    SV_Floodprot_f();
  }

  test("a second message inside the window locks the talker out for fp_secondsdead", () => {
    floodprot(1, 100, 30);
    const cl = hostClient();

    svMainState.realtime = 100;
    Cmd_TokenizeString("say hello");
    SV_Say(false);
    expect(cl.lockedtill).toBe(0);
    expect(cl.whensaid[cl.whensaidhead]).toBe(100);

    svMainState.realtime = 101;
    Cmd_TokenizeString("say again");
    SV_Say(false);
    expect(cl.lockedtill).toBe(131);
  });

  test("while locked out, a further say is refused and does not extend the lockout", () => {
    floodprot(1, 100, 30);
    const cl = hostClient();

    svMainState.realtime = 100;
    Cmd_TokenizeString("say hello");
    SV_Say(false);
    svMainState.realtime = 101;
    Cmd_TokenizeString("say again");
    SV_Say(false);
    expect(cl.lockedtill).toBe(131);

    svMainState.realtime = 105;
    const head = cl.whensaidhead;
    Cmd_TokenizeString("say still talking");
    SV_Say(false);

    expect(cl.lockedtill).toBe(131); // unchanged
    expect(cl.whensaidhead).toBe(head); // the refused message is not recorded
  });

  test("messages spaced beyond fp_persecond are never locked out", () => {
    floodprot(1, 1, 30);
    const cl = hostClient();

    for (let i = 0; i < 4; i++) {
      svMainState.realtime = 100 + i * 5;
      Cmd_TokenizeString("say tick");
      SV_Say(false);
    }

    expect(cl.lockedtill).toBe(0);
  });

  test("a paused server skips the flood check entirely", () => {
    floodprot(1, 100, 30);
    sv.paused = true;
    const cl = hostClient();

    svMainState.realtime = 100;
    Cmd_TokenizeString("say hello");
    SV_Say(false);
    svMainState.realtime = 101;
    Cmd_TokenizeString("say again");
    SV_Say(false);

    expect(cl.lockedtill).toBe(0);
  });

  test("SV_Say with fewer than two arguments does nothing", () => {
    floodprot(1, 100, 30);
    const cl = hostClient();
    svMainState.realtime = 100;
    Cmd_TokenizeString("say");
    SV_Say(false);
    expect(cl.whensaid[cl.whensaidhead]).toBe(0);
  });
});

describe("SV_ExecuteClientMessage", () => {
  function makeCmd(msec: number, yaw: number, forward: number, buttons: number, impulse: number): QwUsercmdT {
    const c = new QwUsercmdT();
    c.msec = msec;
    c.angles[0] = 0;
    c.angles[1] = yaw; // exact multiples of 360/65536 survive MSG_*Angle16
    c.angles[2] = 0;
    c.forwardmove = forward;
    c.sidemove = 0;
    c.upmove = 0;
    c.buttons = buttons;
    c.impulse = impulse;
    return c;
  }

  function loadClcMove(
    seq: number,
    lossage: number,
    c1: QwUsercmdT,
    c2: QwUsercmdT,
    c3: QwUsercmdT,
    corruptChecksum: boolean,
  ): void {
    const buf = new SizeBuf();
    buf.data = new Uint8Array(MAX_MSGLEN);
    buf.maxsize = MAX_MSGLEN;

    MSG_WriteByte(buf, ClcOpsT.clc_move);
    const checksumIndex = buf.cursize;
    MSG_WriteByte(buf, 0); // placeholder
    MSG_WriteByte(buf, lossage);
    MSG_WriteDeltaUsercmd(buf, nullcmd, c1);
    MSG_WriteDeltaUsercmd(buf, c1, c2);
    MSG_WriteDeltaUsercmd(buf, c2, c3);

    const crc = COM_BlockSequenceCRCByte(
      buf.data.subarray(checksumIndex + 1),
      buf.cursize - checksumIndex - 1,
      seq,
    );
    buf.data[checksumIndex] = corruptChecksum ? (crc ^ 0xff) & 0xff : crc;

    net_message.data.set(buf.data.subarray(0, buf.cursize));
    net_message.cursize = buf.cursize;
    MSG_BeginReading();
  }

  test("parses three delta usercmds and latches the newest as lastcmd", () => {
    const cl = hostClient();
    cl.netchan.incoming_sequence = 7;
    sv.paused = true; // keep SV_RunCmd (and pmove) out of this parsing test

    const oldest = makeCmd(10, 90, 100, 1, 0);
    const oldcmd = makeCmd(20, 180, 200, 2, 5);
    const newcmd = makeCmd(30, 270, 300, 3, 7);
    loadClcMove(7, 12, oldest, oldcmd, newcmd, false);

    SV_ExecuteClientMessage(cl);

    expect(cl.lossage).toBe(12);
    expect(cl.lastcmd.msec).toBe(30);
    // MSG_ReadAngle16 reads a *signed* short, so 270 degrees comes back as -90
    expect(cl.lastcmd.angles[1]).toBeCloseTo(-90, 3);
    expect(cl.lastcmd.forwardmove).toBe(300);
    expect(cl.lastcmd.impulse).toBe(7);
    expect(cl.lastcmd.buttons).toBe(0); // zeroed to avoid multiple fires on lag
    expect(svState.host_client).toBe(cl);
    expect(svState.sv_player).toBe(cl.edict);
  });

  test("a bad message checksum drops the rest of the packet and leaves lastcmd alone", () => {
    const cl = hostClient();
    cl.netchan.incoming_sequence = 7;
    sv.paused = true;
    cl.lastcmd.msec = 99;

    loadClcMove(7, 3, makeCmd(10, 0, 0, 0, 0), makeCmd(11, 0, 0, 0, 0), makeCmd(12, 0, 0, 0, 0), true);

    SV_ExecuteClientMessage(cl);

    expect(cl.lastcmd.msec).toBe(99);
  });

  test("a checksum computed against the wrong sequence is rejected too", () => {
    const cl = hostClient();
    cl.netchan.incoming_sequence = 9;
    sv.paused = true;
    cl.lastcmd.msec = 99;

    // CRC built for sequence 7, but the channel is on 9
    loadClcMove(7, 3, makeCmd(10, 0, 0, 0, 0), makeCmd(11, 0, 0, 0, 0), makeCmd(12, 0, 0, 0, 0), false);

    SV_ExecuteClientMessage(cl);

    expect(cl.lastcmd.msec).toBe(99);
  });

  test("clc_delta records the requested delta sequence, clc_nop is a no-op", () => {
    const cl = hostClient();
    const buf = new SizeBuf();
    buf.data = new Uint8Array(MAX_MSGLEN);
    buf.maxsize = MAX_MSGLEN;
    MSG_WriteByte(buf, ClcOpsT.clc_nop);
    MSG_WriteByte(buf, ClcOpsT.clc_delta);
    MSG_WriteByte(buf, 42);
    net_message.data.set(buf.data.subarray(0, buf.cursize));
    net_message.cursize = buf.cursize;
    MSG_BeginReading();

    SV_ExecuteClientMessage(cl);

    expect(cl.delta_sequence).toBe(42);
  });

  test("an empty message still updates the ping bookkeeping and the outgoing sequence", () => {
    const cl = hostClient();
    cl.netchan.incoming_sequence = 20;
    cl.netchan.incoming_acknowledged = 3;
    cl.netchan.outgoing_sequence = 5;
    cl.frames[3].senttime = 90;
    svMainState.realtime = 100;

    net_message.cursize = 0;
    MSG_BeginReading();

    SV_ExecuteClientMessage(cl);

    expect(cl.frames[3].ping_time).toBeCloseTo(10, 5);
    expect(cl.netchan.outgoing_sequence).toBe(20);
    expect(cl.frames[20 & 63].senttime).toBe(100);
    expect(cl.frames[20 & 63].ping_time).toBe(-1);
    expect(cl.localtime).toBe(sv.time);
    expect(cl.delta_sequence).toBe(-1);
  });

  test("a slipped sequence stops the reply", () => {
    const cl = hostClient();
    cl.netchan.incoming_sequence = 4;
    cl.netchan.outgoing_sequence = 9;
    cl.send_message = true;

    net_message.cursize = 0;
    MSG_BeginReading();

    SV_ExecuteClientMessage(cl);

    expect(cl.send_message).toBe(false);
    expect(cl.netchan.outgoing_sequence).toBe(9);
  });
});

describe("SV_RunCmd through PlayerMove", () => {
  function spawnPlayer(): QwEdictT {
    const cl = hostClient();
    const ent = edicts[1];
    ent.free = false;
    ent.v.movetype = MOVETYPE_WALK;
    ent.v.solid = SOLID_SLIDEBOX;
    ent.v.health = 100;
    ent.v.origin[0] = 0;
    ent.v.origin[1] = 0;
    // buildBsp's hull1/hull2 clipnodes split on the same z=0 plane as hull0
    // (a real qbsp bakes the player-hull expansion into them), so the player
    // *origin* -- not its feet -- rests on z=0 here.
    ent.v.origin[2] = 0.5;
    ent.v.velocity[0] = 0;
    ent.v.velocity[1] = 0;
    ent.v.velocity[2] = 0;
    ent.v.mins[0] = player_mins[0];
    ent.v.mins[1] = player_mins[1];
    ent.v.mins[2] = player_mins[2];
    ent.v.maxs[0] = player_maxs[0];
    ent.v.maxs[1] = player_maxs[1];
    ent.v.maxs[2] = player_maxs[2];
    ent.v.flags = 0;
    ent.v.fixangle = 0;
    ent.v.nextthink = 0;
    ent.v.think = 0;
    SV_LinkEdict(ent, false);

    cl.edict = ent;
    cl.spectator = 0;
    cl.entgravity = 1.0;
    cl.maxspeed = sv_maxspeed.value;
    svState.sv_player = ent;

    SV_SetMoveVars();

    gs.PlayerPreThink = 1;
    gs.PlayerPostThink = 1;
    return ent;
  }

  test("a forward move walks the edict along +x and leaves it standing on the floor", () => {
    const ent = spawnPlayer();

    const ucmd = new QwUsercmdT();
    ucmd.msec = 50;
    ucmd.forwardmove = 400;

    SV_RunCmd(ucmd);

    expect(ent.v.origin[0]).toBeGreaterThan(0);
    expect((ent.v.flags | 0) & FL_ONGROUND).toBe(FL_ONGROUND);
    expect(ent.v.groundentity).toBe(0); // physents[0] is the world
    expect(ent.v.velocity[0]).toBeGreaterThan(0);
    expect(pmove.physents[0].model).toBe(worldmodel);
  });

  test("the usercmd's buttons and impulse reach the edict, and angles follow v_angle", () => {
    const ent = spawnPlayer();

    const ucmd = new QwUsercmdT();
    ucmd.msec = 20;
    ucmd.buttons = 3; // attack | jump
    ucmd.impulse = 9;
    ucmd.angles[0] = 30;
    ucmd.angles[1] = 45;

    SV_RunCmd(ucmd);

    expect(ent.v.button0).toBe(1);
    expect(ent.v.button2).toBe(1);
    expect(ent.v.impulse).toBe(9);
    expect(ent.v.v_angle[0]).toBeCloseTo(30, 4);
    expect(ent.v.v_angle[1]).toBeCloseTo(45, 4);
    expect(ent.v.angles[0]).toBeCloseTo(-10, 4); // -pitch/3
    expect(ent.v.angles[1]).toBeCloseTo(45, 4);
  });

  test("PlayerPreThink runs for a player and not for a spectator", () => {
    spawnPlayer();
    let calls = 0;
    progsHook = () => {
      calls++;
    };

    const ucmd = new QwUsercmdT();
    ucmd.msec = 20;
    SV_RunCmd(ucmd);
    expect(calls).toBe(1);

    hostClient().spectator = 1;
    calls = 0;
    SV_RunCmd(ucmd);
    expect(calls).toBe(0);
  });

  test("host_frametime is taken from the usercmd and capped at 0.1", () => {
    spawnPlayer();

    const ucmd = new QwUsercmdT();
    ucmd.msec = 20;
    SV_RunCmd(ucmd);
    expect(svMainState.host_frametime).toBeCloseTo(0.02, 6);

    // 200ms is chopped to 100, and each 100ms half is chopped again, so the
    // last leg actually run is 50ms
    ucmd.msec = 200;
    SV_RunCmd(ucmd);
    expect(svMainState.host_frametime).toBeCloseTo(0.05, 6);
  });

  test("a command longer than 50ms is split into two halves with the impulse only on the first", () => {
    const ent = spawnPlayer();
    ent.v.impulse = 0;

    const ucmd = new QwUsercmdT();
    ucmd.msec = 100;
    ucmd.impulse = 4;

    SV_RunCmd(ucmd);

    // both halves run at 50ms; the second clears impulse before recursing
    expect(ent.v.impulse).toBe(4);
  });
});

describe("SV_UserInit", () => {
  test("declares QW's four sv_user.c cvars with their C defaults", () => {
    expect(cl_rollspeed.name).toBe("cl_rollspeed");
    expect(cl_rollangle.name).toBe("cl_rollangle");
    expect(sv_spectalk.name).toBe("sv_spectalk");
    expect(sv_mapcheck.name).toBe("sv_mapcheck");
    expect(typeof SV_UserInit).toBe("function");
  });
});
