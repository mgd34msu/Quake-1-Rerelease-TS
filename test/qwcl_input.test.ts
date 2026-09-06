// Q022 -- QW/client/cl_input.c -> src/qw/client/cl_input.ts,
// QW/client/cl_tent.c -> src/qw/client/cl_tent.ts, plus the keys.ts/console.ts
// qw.active folds (QW/client/keys.c, QW/client/console.c).
//
// Self-sufficient (rule 13): every shared singleton this file touches
// (cl/cls, keyState, conState, sysState, cl_dlights, cl_visedicts, clState,
// cl_tent's own cl_beams/cl_explosions) is reset in this file's own
// beforeEach, not assumed fresh. `qw.active` is set only inside the
// describe blocks that need it and always restored to false afterward, so
// other files sharing this process see the WinQuake default again. Per rule
// 15, `spyOn(...).mockImplementation(...)` overrides (NET_SendPacket,
// Mod_ForName) are installed/restored in beforeAll/afterAll; bare
// call-through spies (CL_AllocDlight, S_StartSound, Cbuf_AddText) live at
// module scope.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import * as netUdp from "../src/qw/net_udp";
import { NetadrT, NET_StringToAdr } from "../src/qw/net_udp";
import { net_message, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteCoord, SizeBuf } from "../src/common/sizebuf";
import { NetchanT, Netchan_Setup, netchanState } from "../src/qw/net_chan";
import { inputBackend } from "../src/client/input";
import { qw } from "../src/common/quakedef";
import { cl, cls, CactiveT, cl_dlights, cl_visedicts, clState, type DlightT } from "../src/client/client";
import { vid } from "../src/client/vid";
import * as cl_input from "../src/qw/client/cl_input";
import { in_attack, in_jump, cl_nodelta } from "../src/qw/client/cl_input";
import { ClcOpsT, QwUsercmdT, UPDATE_MASK, TE_EXPLOSION, TE_LIGHTNING1 } from "../src/qw/protocol";
import { COM_BlockSequenceCRCByte, MSG_ReadDeltaUsercmd, nullcmd } from "../src/qw/common";
import { Cmd_TokenizeString } from "../src/qw/cmd";
import * as cmdModule from "../src/common/cmd";
import { host, hostClientHooks } from "../src/common/host";

import * as cl_tent from "../src/qw/client/cl_tent";
import * as cl_ents from "../src/qw/client/cl_ents";
import * as modelMod from "../src/common/model";
import { ModelT } from "../src/common/model";
import * as snd_dma from "../src/client/snd_dma";

import { keyState, KeydestT, Key_ClearStates, Key_Event } from "../src/client/keys";
import * as winMenu from "../src/client/menu";
import * as qwMenu from "../src/qw/client/menu";
import { Con_Init, Con_Printf } from "../src/client/console";
import { sysState } from "../src/platform/sys";

// ---------------------------------------------------------------------------
// CL_SendCmd / CL_FinishMove (src/qw/client/cl_input.ts)
// ---------------------------------------------------------------------------

const sentPackets: Uint8Array[] = [];
const sendPacketSpy = spyOn(netUdp, "NET_SendPacket"); // module scope: bare spyOn (rule 15)

// This file's own top-level beforeEach below (not scoped to any describe)
// runs before every test in this file and unconditionally sets
// cls.state/cls.qw.netchan/cls.demoplayback/cls.demorecording -- with
// nothing to put them back afterward, the values the last-run test's
// beforeEach installed leaked into every other suite sharing this bun
// process (rule 15). Snapshotted here, before any beforeEach has run, and
// restored in a top-level afterAll.
const savedClsState = cls.state;
const savedClsNetchan = cls.qw.netchan;
const savedClsDemoplayback = cls.demoplayback;
const savedClsDemorecording = cls.demorecording;

beforeAll(() => {
  sendPacketSpy.mockImplementation((length: number, data: Uint8Array) => {
    sentPackets.push(data.slice(0, length));
  });
});

afterAll(() => {
  sendPacketSpy.mockRestore();
  cls.state = savedClsState;
  cls.qw.netchan = savedClsNetchan;
  cls.demoplayback = savedClsDemoplayback;
  cls.demorecording = savedClsDemorecording;
});

function makeAdr(s: string): NetadrT {
  const a = new NetadrT();
  NET_StringToAdr(s, a);
  return a;
}

function resetQwUsercmd(u: QwUsercmdT): void {
  u.msec = 0;
  u.angles[0] = u.angles[1] = u.angles[2] = 0;
  u.forwardmove = 0;
  u.sidemove = 0;
  u.upmove = 0;
  u.buttons = 0;
  u.impulse = 0;
}

beforeEach(() => {
  sentPackets.length = 0;
  netchanState.isClient = true;
  netchanState.demoplayback = false;
  netchanState.realtime = 0;

  cls.qw.netchan = new NetchanT();
  Netchan_Setup(cls.qw.netchan, makeAdr("10.0.0.5:27500"), 4321);

  cls.demoplayback = false;
  cls.demorecording = false;
  cls.state = CactiveT.ca_active;

  cl.qw.spectator = 0;
  cl.qw.validsequence = 0;
  cl.viewangles[0] = cl.viewangles[1] = cl.viewangles[2] = 0;
  cl.movemessages = 3; // bypass "dump the first two messages" -- see file header
  for (const f of cl.qw.frames) {
    resetQwUsercmd(f.cmd);
    f.senttime = 0;
    f.receivedtime = 0;
    f.delta_sequence = 0;
  }

  in_attack.down[0] = in_attack.down[1] = 0;
  in_attack.state = 0;
  in_jump.down[0] = in_jump.down[1] = 0;
  in_jump.state = 0;
  cl_nodelta.value = 0;

  host.frametime = 0.05; // 50ms
});

describe("CL_FinishMove", () => {
  test("sets buttons from in_attack/in_jump, msec from host.frametime*1000, and impulse from in_impulse", () => {
    in_attack.state = 3; // down + impulse down -> BUTTON_ATTACK (bit 0)
    Cmd_TokenizeString("impulse 9");
    cl_input.IN_Impulse();

    const cmd = new QwUsercmdT();
    cl_input.CL_FinishMove(cmd);

    expect(cmd.buttons & 1).toBe(1); // BUTTON_ATTACK
    expect(cmd.buttons & 2).toBe(0); // jump not pressed
    expect(cmd.msec).toBe(50);
    expect(cmd.impulse).toBe(9);
    expect(in_attack.state & 2).toBe(0); // impulse-down bit cleared, down bit stays
  });

  test("clamps an unreasonable frametime (>250ms) to 100ms", () => {
    host.frametime = 0.4; // 400ms -- ms > 250
    const cmd = new QwUsercmdT();
    cl_input.CL_FinishMove(cmd);
    expect(cmd.msec).toBe(100);
  });
});

function decodeHeaderLen(): number {
  return netchanState.isClient ? 10 : 8; // 2x4-byte sequence words (+2-byte qport if client)
}

describe("CL_SendCmd", () => {
  test("produces a clc_move packet: checksum matches COM_BlockSequenceCRCByte, three delta usercmds decode cleanly", () => {
    in_attack.state = 3;

    const seqBefore = cls.qw.netchan.outgoing_sequence;

    cl_input.CL_SendCmd();

    expect(sentPackets.length).toBe(1);
    const packet = sentPackets[0];
    if (!packet) throw new Error("unreachable");

    const payload = packet.subarray(decodeHeaderLen());
    expect(payload[0]).toBe(ClcOpsT.clc_move);

    const checksumIndex = 1;
    const expectedCrc = COM_BlockSequenceCRCByte(payload.subarray(checksumIndex + 1), payload.length - checksumIndex - 1, seqBefore);
    expect(payload[checksumIndex]).toBe(expectedCrc);

    // byte after the checksum is the network-lossage byte (CL_CalcNet's
    // return, masked to a byte) -- just needs to be a valid byte here.
    const lossage = payload[2];
    expect(lossage).toBeGreaterThanOrEqual(0);
    expect(lossage).toBeLessThanOrEqual(255);

    net_message.data = payload.slice(3);
    net_message.cursize = net_message.data.length;
    net_message.maxsize = net_message.data.length;
    MSG_BeginReading();

    const cmd1 = new QwUsercmdT();
    MSG_ReadDeltaUsercmd(nullcmd, cmd1);
    const cmd2 = new QwUsercmdT();
    MSG_ReadDeltaUsercmd(cmd1, cmd2);
    const cmd3 = new QwUsercmdT();
    MSG_ReadDeltaUsercmd(cmd2, cmd3);

    // frames -2/-1 (indices 62/63 of a fresh netchan) were reset to all-zero
    // usercmds in beforeEach, so cmd1/cmd2 decode identical to nullcmd, and
    // cmd3 (this frame) carries the BUTTON_ATTACK bit CL_FinishMove set.
    expect(cmd1.buttons).toBe(0);
    expect(cmd2.buttons).toBe(0);
    expect(cmd3.buttons & 1).toBe(1);
    expect(cmd3.msec).toBe(50);
  });

  test("cl_nodelta: a nonzero validsequence appends a trailing clc_delta byte pair when cl_nodelta=0, but not when cl_nodelta=1", () => {
    cl.qw.validsequence = 5;
    cl_nodelta.value = 0;

    cl_input.CL_SendCmd();
    expect(sentPackets.length).toBe(1);
    let packet = sentPackets[0];
    if (!packet) throw new Error("unreachable");
    let payload = packet.subarray(decodeHeaderLen());
    expect(payload[payload.length - 2]).toBe(ClcOpsT.clc_delta);
    expect(payload[payload.length - 1]).toBe(5 & 255);

    sentPackets.length = 0;
    cl.qw.validsequence = 5;
    cl_nodelta.value = 1;

    cl_input.CL_SendCmd();
    expect(sentPackets.length).toBe(1);
    packet = sentPackets[0];
    if (!packet) throw new Error("unreachable");
    payload = packet.subarray(decodeHeaderLen());
    // no clc_delta appended this time
    expect(payload[payload.length - 2]).not.toBe(ClcOpsT.clc_delta);
  });

  test("does nothing while cls.demoplayback is true", () => {
    cls.demoplayback = true;
    cl_input.CL_SendCmd();
    expect(sentPackets.length).toBe(0);
  });

  test("calls the input backend's IN_MoveQw between CL_BaseMove and CL_FinishMove", () => {
    // QW cl_input.c's CL_SendCmd: `CL_BaseMove (cmd); IN_Move (cmd);` -- our
    // InputBackend carries a QW-shaped IN_MoveQw beside WinQuake's IN_Move
    // because the two trees' usercmd_t structs differ.
    const saved = inputBackend.current;
    const seen: Array<{ forwardmove: number; sidemove: number }> = [];
    inputBackend.current = {
      IN_Init(): void {},
      IN_Shutdown(): void {},
      IN_Commands(): void {},
      IN_Move(): void {},
      IN_MoveQw(cmd: QwUsercmdT): void {
        // CL_BaseMove has already run, CL_FinishMove's MakeChar has not
        seen.push({ forwardmove: cmd.forwardmove, sidemove: cmd.sidemove });
        cmd.forwardmove += 60;
      },
      IN_ModeChanged(): void {},
      IN_ClearStates(): void {},
    };

    const i = cls.qw.netchan.outgoing_sequence & UPDATE_MASK;
    cl_input.CL_SendCmd();

    expect(seen.length).toBe(1);
    expect(seen[0]?.forwardmove).toBe(0);
    expect(cl.qw.frames[i].cmd.forwardmove).toBe(60); // MakeChar(60) === 60

    inputBackend.current = saved;
  });
});

// ---------------------------------------------------------------------------
// CL_ParseTEnt / CL_UpdateTEnts (src/qw/client/cl_tent.ts)
// ---------------------------------------------------------------------------

const cl_ents_allocDlightSpy = spyOn(cl_ents, "CL_AllocDlight"); // call-through (rule 15)
const startSoundSpy = spyOn(snd_dma, "S_StartSound"); // call-through (rule 15)

let lastFakeModel: ModelT | null = null;
let modForNameSpy: Mock<(name: string, crash: boolean) => ModelT | null>;

beforeAll(() => {
  modForNameSpy = spyOn(modelMod, "Mod_ForName").mockImplementation((): ModelT => {
    lastFakeModel = new ModelT();
    return lastFakeModel;
  });
});

afterAll(() => {
  cl_ents_allocDlightSpy.mockRestore();
  startSoundSpy.mockRestore();
  modForNameSpy.mockRestore();
});

function resetQwBeams(): void {
  for (const b of cl_tent.cl_beams) {
    b.entity = 0;
    b.model = null;
    b.endtime = 0;
    b.start[0] = b.start[1] = b.start[2] = 0;
    b.end[0] = b.end[1] = b.end[2] = 0;
  }
}

function resetQwExplosions(): void {
  for (const ex of cl_tent.cl_explosions) {
    ex.origin[0] = ex.origin[1] = ex.origin[2] = 0;
    ex.start = 0;
    ex.model = null;
  }
}

beforeEach(() => {
  cl_ents_allocDlightSpy.mockClear();
  startSoundSpy.mockClear();
  modForNameSpy.mockClear();
  resetQwBeams();
  resetQwExplosions();
  clState.cl_numvisedicts = 0;
  cl.qw.playernum = 0;
  cl.qw.simorg[0] = cl.qw.simorg[1] = cl.qw.simorg[2] = 0;
});

function beginTEntMessage(): void {
  net_message.data = new Uint8Array(2048);
  net_message.maxsize = net_message.data.length;
  net_message.cursize = 0;
}

function writeIntoNetMessage(build: (sb: SizeBuf) => void): void {
  const sb = new SizeBuf();
  sb.data = new Uint8Array(256);
  sb.maxsize = sb.data.length;
  sb.cursize = 0;
  build(sb);

  beginTEntMessage();
  net_message.data.set(sb.data.subarray(0, sb.cursize));
  net_message.cursize = sb.cursize;
  MSG_BeginReading();
}

describe("CL_ParseTEnt: TE_LIGHTNING1", () => {
  test("loads progs/bolt.mdl and stores a beam entry ending at cl.time+0.2", () => {
    cl.time = 10;

    writeIntoNetMessage((sb) => {
      MSG_WriteByte(sb, TE_LIGHTNING1);
      MSG_WriteShort(sb, 7); // entity
      MSG_WriteCoord(sb, 1);
      MSG_WriteCoord(sb, 2);
      MSG_WriteCoord(sb, 3);
      MSG_WriteCoord(sb, 4);
      MSG_WriteCoord(sb, 5);
      MSG_WriteCoord(sb, 6);
    });

    cl_tent.CL_ParseTEnt();

    const call = modForNameSpy.mock.calls[0];
    if (!call) throw new Error("unreachable");
    expect(call[0]).toBe("progs/bolt.mdl");

    const b = cl_tent.cl_beams.find((x) => x.entity === 7 && x.model === lastFakeModel);
    expect(b).toBeDefined();
    if (!b) throw new Error("unreachable");
    expect(b.endtime).toBeCloseTo(10.2, 5);
    expect(Array.from(b.start)).toEqual([1, 2, 3]);
    expect(Array.from(b.end)).toEqual([4, 5, 6]);
  });
});

describe("CL_ParseTEnt: TE_EXPLOSION", () => {
  test("allocates a dlight (radius 350, decay 300, die cl.time+0.5, color 0.2/0.1/0.05/0.7) and an explosion sprite, plays r_exp3", () => {
    cl.time = 8;

    writeIntoNetMessage((sb) => {
      MSG_WriteByte(sb, TE_EXPLOSION);
      MSG_WriteCoord(sb, 11);
      MSG_WriteCoord(sb, 12);
      MSG_WriteCoord(sb, 13);
    });

    cl_tent.CL_ParseTEnt();

    expect(startSoundSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const soundCall = startSoundSpy.mock.calls[startSoundSpy.mock.calls.length - 1];
    if (!soundCall) throw new Error("unreachable");
    expect(Array.from(soundCall[3])).toEqual([11, 12, 13]);

    expect(cl_ents_allocDlightSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const result = cl_ents_allocDlightSpy.mock.results[cl_ents_allocDlightSpy.mock.results.length - 1];
    if (!result || result.type !== "return") throw new Error("expected CL_AllocDlight to return");
    const dl: DlightT = result.value;

    expect(dl.radius).toBe(350);
    expect(dl.decay).toBe(300);
    expect(dl.die).toBeCloseTo(8.5, 5);
    expect(Array.from(dl.origin)).toEqual([11, 12, 13]);

    const idx = cl_dlights.indexOf(dl);
    expect(idx).toBeGreaterThanOrEqual(0);
    const color = dl.color;
    expect(color[0]).toBeCloseTo(0.2, 5);
    expect(color[1]).toBeCloseTo(0.1, 5);
    expect(color[2]).toBeCloseTo(0.05, 5);
    expect(color[3]).toBeCloseTo(0.7, 5);

    // sprite explosion
    const ex = cl_tent.cl_explosions.find((e) => e.model !== null && e.start === 8);
    expect(ex).toBeDefined();
    if (!ex) throw new Error("unreachable");
    expect(Array.from(ex.origin)).toEqual([11, 12, 13]);
  });
});

describe("CL_UpdateTEnts", () => {
  test("produces temp entities in cl_visedicts for an active beam", () => {
    cl.time = 5;
    const b = cl_tent.cl_beams[0];
    if (!b) throw new Error("unreachable");
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.entity = 123; // not cl.qw.playernum+1, so start is not overwritten
    b.start[0] = 0;
    b.start[1] = 0;
    b.start[2] = 0;
    b.end[0] = 30;
    b.end[1] = 0;
    b.end[2] = 0;

    cl_tent.CL_UpdateTEnts();

    expect(clState.cl_numvisedicts).toBeGreaterThanOrEqual(1);
    const e0 = cl_visedicts[0];
    expect(e0).not.toBeNull();
    if (!e0) throw new Error("unreachable");
    expect(Array.from(e0.origin)).toEqual([0, 0, 0]);
    expect(e0.model).toBe(b.model);
    expect(e0.colormap).toBe(vid.colormap);
  });
});

// ---------------------------------------------------------------------------
// keys.ts qw.active fold: Key_Message chat send
// ---------------------------------------------------------------------------

describe("Key_Message chat send under qw.active", () => {
  const cbufAddTextSpy = spyOn(cmdModule, "Cbuf_AddText"); // bare spyOn (rule 15)

  beforeAll(() => {
    qw.active = true;
  });
  afterAll(() => {
    qw.active = false;
    cbufAddTextSpy.mockRestore();
  });
  beforeEach(() => {
    cbufAddTextSpy.mockClear();
    keyState.key_dest = KeydestT.key_message;
    keyState.team_message = false;
    keyState.chat_buffer = "";
    keyState.key_count = 1; // > 0, past Key_Event's Con_NotifyBox guard
  });
  afterEach(() => {
    keyState.key_dest = KeydestT.key_game;
  });

  test('typing a message and pressing Enter sends say "<text>"', () => {
    for (const ch of "hi") Key_Event(ch.charCodeAt(0), true);
    Key_Event(13 /* K_ENTER */, true);

    const calls = cbufAddTextSpy.mock.calls.map(([s]) => s);
    expect(calls.join("")).toBe('say "hi"\n');
    expect(keyState.key_dest).toBe(KeydestT.key_game);
  });
});

// ---------------------------------------------------------------------------
// console.ts qw.active fold: Con_Printf gating
// ---------------------------------------------------------------------------

describe("Con_Printf gating under qw.active", () => {
  let savedVidWidth: number;

  beforeAll(() => {
    savedVidWidth = vid.width; // shared singleton -- restored in afterAll (rule 15)
    vid.width = 320;
    Con_Init();
  });

  afterAll(() => {
    vid.width = savedVidWidth;
  });

  afterEach(() => {
    qw.active = false;
    sysState.isDedicated = false;
    hostClientHooks.scrUpdateScreen = null;
  });

  test("WinQuake: sysState.isDedicated short-circuits before Con_Print (no screen update call either)", () => {
    let called = 0;
    hostClientHooks.scrUpdateScreen = () => {
      called++;
    };
    sysState.isDedicated = true;
    cls.state = CactiveT.ca_dedicated;
    expect(() => Con_Printf("winquake dedicated\n")).not.toThrow();
    expect(called).toBe(0);
  });

  test("QW: the same sysState.isDedicated does NOT short-circuit (QW/client/console.c's Con_Printf has no such check)", () => {
    qw.active = true;
    let called = 0;
    hostClientHooks.scrUpdateScreen = () => {
      called++;
    };
    sysState.isDedicated = true;
    cls.state = CactiveT.ca_dedicated;
    expect(() => Con_Printf("qw dedicated\n")).not.toThrow();
    // cls.state !== ca_active (it's ca_dedicated here), so the QW branch
    // still calls the screen-update hook.
    expect(called).toBe(1);
  });

  test("QW: no screen-update call when cls.state === ca_active (vs WinQuake's signon/scr_disabled_for_loading gate)", () => {
    qw.active = true;
    let called = 0;
    hostClientHooks.scrUpdateScreen = () => {
      called++;
    };
    sysState.isDedicated = false;
    cls.state = CactiveT.ca_active;
    expect(() => Con_Printf("qw active\n")).not.toThrow();
    expect(called).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// keys.ts qw.active fold: which menu.c the two menu entry points reach
// (QW/client/keys.c:728/812 M_Keydown, :732/772 M_ToggleMenu_f -- identical
// call sites in both trees, but QW/client/keys.c links QW/client/menu.c)
// ---------------------------------------------------------------------------

describe("Key_Event menu dispatch under qw.active", () => {
  // rule 15: mockImplementation spies, installed in beforeAll and restored in
  // afterAll. Both menu modules are spied, so "the QW one ran" and "the
  // WinQuake one did not" are both real assertions.
  const qwKeydownSpy = spyOn(qwMenu, "M_Keydown");
  const qwToggleSpy = spyOn(qwMenu, "M_ToggleMenu_f");
  const winKeydownSpy = spyOn(winMenu, "M_Keydown");
  const winToggleSpy = spyOn(winMenu, "M_ToggleMenu_f");

  let savedKeyDest: KeydestT;
  let savedKeyCount: number;

  beforeAll(() => {
    savedKeyDest = keyState.key_dest;
    savedKeyCount = keyState.key_count;
    qwKeydownSpy.mockImplementation(() => {});
    qwToggleSpy.mockImplementation(() => {});
    winKeydownSpy.mockImplementation(() => {});
    winToggleSpy.mockImplementation(() => {});
  });

  afterAll(() => {
    qwKeydownSpy.mockRestore();
    qwToggleSpy.mockRestore();
    winKeydownSpy.mockRestore();
    winToggleSpy.mockRestore();
    qw.active = false;
    keyState.key_dest = savedKeyDest;
    keyState.key_count = savedKeyCount;
    Key_ClearStates(); // key_repeats/keydown are module-private singletons
  });

  beforeEach(() => {
    qwKeydownSpy.mockClear();
    qwToggleSpy.mockClear();
    winKeydownSpy.mockClear();
    winToggleSpy.mockClear();
    Key_ClearStates();
    keyState.key_count = 1; // > 0, past Key_Event's Con_NotifyBox guard
    keyState.key_dest = KeydestT.key_menu;
  });

  afterEach(() => {
    qw.active = false;
    keyState.key_dest = KeydestT.key_game;
  });

  test("qw.active: a key in key_menu reaches QW's M_Keydown, not WinQuake's", () => {
    qw.active = true;
    Key_Event("a".charCodeAt(0), true);

    expect(qwKeydownSpy).toHaveBeenCalledTimes(1);
    expect(qwKeydownSpy.mock.calls[0][0]).toBe("a".charCodeAt(0));
    expect(winKeydownSpy).not.toHaveBeenCalled();
  });

  test("qw.active: K_ESCAPE in key_menu reaches QW's M_Keydown too (keys.c's escape branch)", () => {
    qw.active = true;
    Key_Event(27 /* K_ESCAPE */, true);

    expect(qwKeydownSpy).toHaveBeenCalledTimes(1);
    expect(qwKeydownSpy.mock.calls[0][0]).toBe(27);
    expect(winKeydownSpy).not.toHaveBeenCalled();
  });

  test("qw.active: K_ESCAPE in key_game reaches QW's M_ToggleMenu_f, not WinQuake's", () => {
    qw.active = true;
    keyState.key_dest = KeydestT.key_game;
    Key_Event(27 /* K_ESCAPE */, true);

    expect(qwToggleSpy).toHaveBeenCalledTimes(1);
    expect(winToggleSpy).not.toHaveBeenCalled();
  });

  test("without qw.active the same events reach WinQuake's menu.c", () => {
    Key_Event("a".charCodeAt(0), true);
    keyState.key_dest = KeydestT.key_game;
    Key_Event(27 /* K_ESCAPE */, true);

    expect(winKeydownSpy).toHaveBeenCalledTimes(1);
    expect(winToggleSpy).toHaveBeenCalledTimes(1);
    expect(qwKeydownSpy).not.toHaveBeenCalled();
    expect(qwToggleSpy).not.toHaveBeenCalled();
  });
});
