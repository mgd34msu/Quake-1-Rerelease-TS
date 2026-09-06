// Self-sufficient test for src/client/cl_input.ts (WinQuake cl_input.c).
//
// cl_input.ts's two sibling imports ("./cl_main" for CL_Disconnect/
// lookspring, "./view" for V_StartPitchDrift/V_StopPitchDrift) are both real,
// landed modules now, so this file drives them directly rather than
// stubbing either specifier: `lookspring` is the real registered CvarT (set
// its `.value` directly), and V_StartPitchDrift/V_StopPitchDrift are spied
// with bun:test's `spyOn` -- a wrapper around the real export that still
// calls through to it (confirmed empirically: a `spyOn` on a module's
// namespace object is visible from every other module's call sites too,
// static import or lazy `require()` alike, since bun's ESM transpile reads
// each import through the shared module object) rather than a `mock.module`
// replacement of the whole sibling.
//
// The `in_impulse` export is a live ES binding (`export let`), so this file
// reads it through the imported module namespace object (`cl_input.in_impulse`)
// rather than a destructured copy, which would only capture the value at
// import time.

import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { Cmd_Exists, Cmd_TokenizeString } from "../src/common/cmd";
import { Cvar_RegisterVariable } from "../src/common/cvar";
import { host } from "../src/common/host";
import { anglemod } from "../src/common/mathlib";
import { PITCH, YAW, ROLL } from "../src/common/quakedef";
import { MSG_BeginReading, MSG_ReadAngle, MSG_ReadByte, MSG_ReadFloat, MSG_ReadShort, net_message } from "../src/common/sizebuf";
import { ClcOpsT } from "../src/common/protocol";
import { NET_Init, NET_Connect, NET_CheckNewConnections, NET_GetMessage, setNetHostHooks, type NetHostHooks } from "../src/common/net_main";
import { cl, cls, KbuttonT, UsercmdT, SIGNONS } from "../src/client/client";
import * as cl_main from "../src/client/cl_main";
import * as view from "../src/client/view";
import * as cl_input from "../src/client/cl_input";

// -- spies wrapping the real cl_main/view exports (see file header) --------

const disconnectSpy = spyOn(cl_main, "CL_Disconnect");
const startPitchDriftSpy = spyOn(view, "V_StartPitchDrift");
const stopPitchDriftSpy = spyOn(view, "V_StopPitchDrift");

afterAll(() => {
  disconnectSpy.mockRestore();
  startPitchDriftSpy.mockRestore();
  stopPitchDriftSpy.mockRestore();
});

// register the module's own eight cvars for real (Cvar_RegisterVariable is
// a guarded no-op if another file already registered the same instance) so
// .value reflects cl_input.c's literal defaults, not the CvarT
// not-yet-registered default of 0.
for (const cv of [
  cl_input.cl_upspeed,
  cl_input.cl_forwardspeed,
  cl_input.cl_backspeed,
  cl_input.cl_sidespeed,
  cl_input.cl_movespeedkey,
  cl_input.cl_yawspeed,
  cl_input.cl_pitchspeed,
  cl_input.cl_anglespeedkey,
]) {
  Cvar_RegisterVariable(cv);
}

// loopback net setup, same pattern as test/net_loop.test.ts (its own file
// header explains why NET_Init() must be called again here: the qsocket
// pool is process-shared, and this call's own pool-seeding is additive and
// idempotent for cmd/cvar registration).
const fakeHooks: NetHostHooks = {
  svActive: () => false,
  svName: () => "",
  svsMaxclients: () => 32,
  svsMaxclientslimit: () => 32,
  setSvsMaxclients: () => {},
  clsStateDedicated: () => false,
  svsClients: () => [],
  deathmatch: () => false,
  hostClientPrivileged: () => false,
  svClientPrintf: () => {},
  scrUpdateScreen: () => {},
  menuSetReturnReason: () => {},
  menuHandleConnectError: () => {},
  menuConnectSucceeded: () => {},
  hostTime: () => 0,
};
setNetHostHooks(fakeHooks);
NET_Init();

const allButtons = [
  cl_input.in_mlook,
  cl_input.in_klook,
  cl_input.in_left,
  cl_input.in_right,
  cl_input.in_forward,
  cl_input.in_back,
  cl_input.in_lookup,
  cl_input.in_lookdown,
  cl_input.in_moveleft,
  cl_input.in_moveright,
  cl_input.in_strafe,
  cl_input.in_speed,
  cl_input.in_use,
  cl_input.in_jump,
  cl_input.in_attack,
  cl_input.in_up,
  cl_input.in_down,
];

function resetButtons(): void {
  for (const b of allButtons) {
    b.down[0] = 0;
    b.down[1] = 0;
    b.state = 0;
  }
}

beforeEach(() => {
  resetButtons();
  cl.viewangles[0] = 0;
  cl.viewangles[1] = 0;
  cl.viewangles[2] = 0;
  host.frametime = 0.1;
  disconnectSpy.mockClear();
  startPitchDriftSpy.mockClear();
  stopPitchDriftSpy.mockClear();
  cl_main.lookspring.value = 0;
});

describe("KeyDown / KeyUp (kbutton_t state machine)", () => {
  test("typed manually at the console (no argument): KeyDown sets down[0]=-1; KeyUp clears both slots and sets state=4", () => {
    const b = new KbuttonT();
    Cmd_TokenizeString("+forward");
    cl_input.KeyDown(b);
    expect(b.down[0]).toBe(-1);
    expect(b.state).toBe(3); // down(1) + impulsedown(2)

    Cmd_TokenizeString("-forward");
    cl_input.KeyUp(b);
    expect(b.down[0]).toBe(0);
    expect(b.down[1]).toBe(0);
    expect(b.state).toBe(4); // impulse up, unsticking path
  });

  test("a repeated down for the same key number is ignored (\"repeating key\")", () => {
    const b = new KbuttonT();
    Cmd_TokenizeString("+forward 12");
    cl_input.KeyDown(b);
    expect(b.down[0]).toBe(12);
    expect(b.state).toBe(3);

    // same key fires again (key auto-repeat from the OS) -- must be a no-op
    Cmd_TokenizeString("+forward 12");
    cl_input.KeyDown(b);
    expect(b.down[0]).toBe(12);
    expect(b.down[1]).toBe(0);
    expect(b.state).toBe(3);
  });

  test("two distinct keys down, then a third prints \"Three keys down\" and changes nothing; releasing one key at a time", () => {
    const b = new KbuttonT();

    Cmd_TokenizeString("+forward 12");
    cl_input.KeyDown(b);
    expect(b.down).toEqual(new Int32Array([12, 0]));
    expect(b.state).toBe(3);

    // second distinct key: fills down[1], but the button is already down
    // (state&1), so no additional impulsedown edge is set
    Cmd_TokenizeString("+forward 34");
    cl_input.KeyDown(b);
    expect(b.down).toEqual(new Int32Array([12, 34]));
    expect(b.state).toBe(3);

    // third distinct key: both slots full -> "Three keys down for a button!"
    Cmd_TokenizeString("+forward 56");
    cl_input.KeyDown(b);
    expect(b.down).toEqual(new Int32Array([12, 34]));
    expect(b.state).toBe(3);

    // release the first key: the second still holds it down, so state is untouched
    Cmd_TokenizeString("-forward 12");
    cl_input.KeyUp(b);
    expect(b.down).toEqual(new Int32Array([0, 34]));
    expect(b.state).toBe(3);

    // an up for a key that was never down (menu pass-through) changes nothing
    Cmd_TokenizeString("-forward 999");
    cl_input.KeyUp(b);
    expect(b.down).toEqual(new Int32Array([0, 34]));
    expect(b.state).toBe(3);

    // release the second key: now actually up -- clears bit0, sets bit2 (impulse up)
    Cmd_TokenizeString("-forward 34");
    cl_input.KeyUp(b);
    expect(b.down).toEqual(new Int32Array([0, 0]));
    expect(b.state).toBe(6); // impulsedown(2) [never cleared by KeyUp] + impulseup(4)

    // CL_KeyState on this down-then-up-within-the-frame history: 0.25
    expect(cl_input.CL_KeyState(b)).toBeCloseTo(0.25, 5);
    expect(b.state).toBe(0); // impulses cleared, and it was up
  });

  test("the exported +forward/-forward handlers wire KeyDown/KeyUp to the in_forward singleton", () => {
    Cmd_TokenizeString("+forward 7");
    cl_input.IN_ForwardDown();
    expect(cl_input.in_forward.down[0]).toBe(7);
    expect(cl_input.in_forward.state & 1).toBe(1);

    Cmd_TokenizeString("-forward 7");
    cl_input.IN_ForwardUp();
    expect(cl_input.in_forward.down[0]).toBe(0);
    expect(cl_input.in_forward.state & 1).toBe(0);
  });

  test("IN_MLookUp starts pitch drift when lookspring is set and mlook is fully released", () => {
    cl_main.lookspring.value = 1;
    Cmd_TokenizeString("+mlook 5");
    cl_input.IN_MLookDown();
    Cmd_TokenizeString("-mlook 5");
    cl_input.IN_MLookUp();
    expect(startPitchDriftSpy).toHaveBeenCalledTimes(1);
    expect(stopPitchDriftSpy).not.toHaveBeenCalled();
  });

  test("IN_MLookUp does not start pitch drift when lookspring is 0", () => {
    cl_main.lookspring.value = 0;
    Cmd_TokenizeString("+mlook 5");
    cl_input.IN_MLookDown();
    Cmd_TokenizeString("-mlook 5");
    cl_input.IN_MLookUp();
    expect(startPitchDriftSpy).not.toHaveBeenCalled();
  });

  test("IN_Impulse sets in_impulse from Cmd_Argv(1)", () => {
    Cmd_TokenizeString("impulse 9");
    cl_input.IN_Impulse();
    expect(cl_input.in_impulse).toBe(9);
  });
});

describe("CL_KeyState", () => {
  test("held the entire frame (state=1, no impulse edges) -> 1.0, then clears to plain down", () => {
    const b = new KbuttonT();
    b.state = 1;
    expect(cl_input.CL_KeyState(b)).toBe(1.0);
    expect(b.state).toBe(1);
  });

  test("up the entire frame (state=0) -> 0", () => {
    const b = new KbuttonT();
    b.state = 0;
    expect(cl_input.CL_KeyState(b)).toBe(0);
    expect(b.state).toBe(0);
  });

  test("pressed and held this frame (state=3: down + impulsedown) -> 0.5", () => {
    const b = new KbuttonT();
    b.state = 3;
    expect(cl_input.CL_KeyState(b)).toBe(0.5);
    expect(b.state).toBe(1); // impulses cleared, down bit survives
  });

  test("released this frame, now up (state=4: impulseup only) -> 0", () => {
    const b = new KbuttonT();
    b.state = 4;
    expect(cl_input.CL_KeyState(b)).toBe(0);
    expect(b.state).toBe(0);
  });

  test("released and re-pressed this frame, now down (state=7) -> 0.75", () => {
    const b = new KbuttonT();
    b.state = 7;
    expect(cl_input.CL_KeyState(b)).toBe(0.75);
    expect(b.state).toBe(1);
  });

  test("pressed and released this frame, now up (state=6) -> 0.25", () => {
    const b = new KbuttonT();
    b.state = 6;
    expect(cl_input.CL_KeyState(b)).toBe(0.25);
    expect(b.state).toBe(0);
  });
});

describe("CL_AdjustAngles", () => {
  test("yaw changes by frametime * cl_yawspeed * keystate when in_right is held", () => {
    host.frametime = 0.1;
    cl_input.in_right.state = 1; // CL_KeyState -> 1.0
    cl_input.CL_AdjustAngles();
    const expected = anglemod(-(0.1 * cl_input.cl_yawspeed.value * 1.0));
    expect(cl.viewangles[YAW]).toBeCloseTo(expected, 5);
  });

  test("in_left pushes yaw the other way", () => {
    host.frametime = 0.1;
    cl_input.in_left.state = 1;
    cl_input.CL_AdjustAngles();
    const expected = anglemod(0.1 * cl_input.cl_yawspeed.value * 1.0);
    expect(cl.viewangles[YAW]).toBeCloseTo(expected, 5);
  });

  test("in_strafe suppresses the yaw block entirely (in_right/in_left redirect to sidemove in CL_BaseMove instead)", () => {
    host.frametime = 0.1;
    cl_input.in_strafe.state = 1;
    cl_input.in_right.state = 1;
    cl_input.CL_AdjustAngles();
    expect(cl.viewangles[YAW]).toBe(0);
    // CL_KeyState was never called on in_right, so its impulse bit survives
    expect(cl_input.in_right.state).toBe(1);
  });

  test("in_speed multiplies the effective frametime by cl_anglespeedkey, not a flat doubling", () => {
    host.frametime = 0.1;
    cl_input.in_right.state = 1;
    cl_input.in_speed.state = 1;
    cl_input.CL_AdjustAngles();
    const speed = 0.1 * cl_input.cl_anglespeedkey.value; // 1.5 by default, not 2x
    const expected = anglemod(-(speed * cl_input.cl_yawspeed.value * 1.0));
    expect(cl.viewangles[YAW]).toBeCloseTo(expected, 5);
  });

  test("in_klook redirects in_forward/in_back into pitch and calls V_StopPitchDrift", () => {
    host.frametime = 0.1;
    cl_input.in_klook.state = 1;
    cl_input.in_forward.state = 1;
    cl_input.CL_AdjustAngles();
    const expected = -(0.1 * cl_input.cl_pitchspeed.value * 1.0);
    expect(cl.viewangles[PITCH]).toBeCloseTo(expected, 5);
    expect(stopPitchDriftSpy).toHaveBeenCalled();
  });

  test("in_lookup/in_lookdown also call V_StopPitchDrift when either fires, independent of in_klook", () => {
    host.frametime = 0.1;
    cl_input.in_lookup.state = 1;
    cl_input.CL_AdjustAngles();
    expect(stopPitchDriftSpy).toHaveBeenCalled();
    expect(cl.viewangles[PITCH]).toBeCloseTo(-(0.1 * cl_input.cl_pitchspeed.value * 1.0), 5);
  });

  test("pitch clamps to [-70, 80] and roll clamps to [-50, 50]", () => {
    host.frametime = 1000; // deliberately blow past the clamp
    cl_input.in_lookdown.state = 1;
    cl_input.CL_AdjustAngles();
    expect(cl.viewangles[PITCH]).toBe(80);

    resetButtons();
    cl.viewangles[PITCH] = 0;
    cl_input.in_lookup.state = 1;
    cl_input.CL_AdjustAngles();
    expect(cl.viewangles[PITCH]).toBe(-70);

    cl.viewangles[ROLL] = 51;
    cl_input.CL_AdjustAngles();
    expect(cl.viewangles[ROLL]).toBe(50);

    cl.viewangles[ROLL] = -51;
    cl_input.CL_AdjustAngles();
    expect(cl.viewangles[ROLL]).toBe(-50);
  });
});

describe("CL_BaseMove", () => {
  const savedSignon = cls.signon;
  beforeEach(() => {
    cls.signon = savedSignon;
  });

  test("returns immediately, leaving cmd untouched, when cls.signon != SIGNONS", () => {
    cls.signon = 0;
    const cmd = new UsercmdT();
    cmd.forwardmove = 42;
    cl_input.CL_BaseMove(cmd);
    expect(cmd.forwardmove).toBe(42);
  });

  test("zeroes cmd, then composes side/up/forward from held buttons", () => {
    cls.signon = SIGNONS;
    cl_input.in_moveright.state = 1;
    cl_input.in_up.state = 1;
    cl_input.in_forward.state = 1;

    const cmd = new UsercmdT();
    cmd.forwardmove = -999;
    cmd.sidemove = -999;
    cmd.upmove = -999;

    cl_input.CL_BaseMove(cmd);

    expect(cmd.sidemove).toBeCloseTo(cl_input.cl_sidespeed.value, 5);
    expect(cmd.upmove).toBeCloseTo(cl_input.cl_upspeed.value, 5);
    expect(cmd.forwardmove).toBeCloseTo(cl_input.cl_forwardspeed.value, 5);
  });

  test("in_strafe redirects in_right into sidemove instead of yaw", () => {
    cls.signon = SIGNONS;
    cl_input.in_strafe.state = 1;
    cl_input.in_right.state = 1;
    const cmd = new UsercmdT();
    cl_input.CL_BaseMove(cmd);
    expect(cmd.sidemove).toBeCloseTo(cl_input.cl_sidespeed.value, 5);
  });

  test("in_klook exception: forwardmove stays 0 regardless of in_forward/in_back while klook is held", () => {
    cls.signon = SIGNONS;
    cl_input.in_klook.state = 1;
    cl_input.in_forward.state = 1;
    const cmd = new UsercmdT();
    cl_input.CL_BaseMove(cmd);
    expect(cmd.forwardmove).toBe(0);
  });

  test("in_speed multiplies forward/side/up by cl_movespeedkey", () => {
    cls.signon = SIGNONS;
    cl_input.in_forward.state = 1;
    cl_input.in_speed.state = 1;
    const cmd = new UsercmdT();
    cl_input.CL_BaseMove(cmd);
    const expected = cl_input.cl_forwardspeed.value * cl_input.cl_movespeedkey.value;
    expect(cmd.forwardmove).toBeCloseTo(expected, 4);
  });
});

describe("CL_SendMove", () => {
  // NET_Connect/NET_CheckNewConnections (not netLoopDriver.Connect/
  // CheckNewConnections directly) because they are the only things that
  // leave `net_driverlevel` at 0 by the time NET_NewQSocket stamps each
  // socket's `.driver` field -- CL_SendMove goes through net_main.ts's
  // NET_SendUnreliableMessage, which indexes net_drivers[sock.driver], so
  // the socket must carry the right driver index (unlike test/net_loop.test.ts,
  // which drives netLoopDriver's own methods directly and never needs it).
  const client = NET_Connect("local");
  if (!client) throw new Error("expected a loopback client socket");
  const server = NET_CheckNewConnections();
  if (!server) throw new Error("expected a loopback server socket");

  beforeEach(() => {
    cls.netcon = client;
    cls.demoplayback = false;
    cl.movemessages = 0;
    // net_loop.ts's `loop_client`/`loop_server` are module-level singletons
    // that `client`/`server` above alias -- another test file that marks a
    // loopback socket `disconnected = true` directly (instead of routing it
    // through NET_Close, which would null out the singleton for a fresh
    // future allocation) leaves that flag stuck on these same objects. Reset
    // every test, not just once at describe-registration time, since which
    // other file's tests have run by then is not guaranteed.
    client.disconnected = false;
    server.disconnected = false;
    // drain any stray pending message from a previous test
    while (NET_GetMessage(server) > 0) {
      /* drain */
    }
  });

  test("the first two calls are dumped (movemessages<=2); nothing reaches the wire", () => {
    cl_input.CL_SendMove(new UsercmdT());
    expect(cl.movemessages).toBe(1);
    expect(NET_GetMessage(server)).toBe(0);

    cl_input.CL_SendMove(new UsercmdT());
    expect(cl.movemessages).toBe(2);
    expect(NET_GetMessage(server)).toBe(0);
  });

  test("the byte layout of the third call matches clc_move exactly, and button/impulse state is cleared afterward", () => {
    cl_input.CL_SendMove(new UsercmdT());
    cl_input.CL_SendMove(new UsercmdT());

    cl.mtime[0] = 3.5;
    cl.viewangles[0] = 10;
    cl.viewangles[1] = 20;
    cl.viewangles[2] = 30;
    cl_input.in_attack.state = 3; // down + impulsedown
    cl_input.in_jump.state = 0;
    Cmd_TokenizeString("impulse 7");
    cl_input.IN_Impulse();

    const cmd = new UsercmdT();
    cmd.forwardmove = 100;
    cmd.sidemove = -50;
    cmd.upmove = 5;

    cl_input.CL_SendMove(cmd);
    expect(cl.movemessages).toBe(3);

    const ret = NET_GetMessage(server);
    expect(ret).toBe(2); // unreliable message
    expect(net_message.cursize).toBe(16); // 1 + 4 + 3 + 2*3 + 1 + 1

    MSG_BeginReading();
    expect(MSG_ReadByte()).toBe(ClcOpsT.clc_move);
    expect(MSG_ReadFloat()).toBeCloseTo(3.5, 4);
    expect(Math.abs(MSG_ReadAngle() - 10)).toBeLessThan(360 / 256);
    expect(Math.abs(MSG_ReadAngle() - 20)).toBeLessThan(360 / 256);
    expect(Math.abs(MSG_ReadAngle() - 30)).toBeLessThan(360 / 256);
    expect(MSG_ReadShort()).toBe(100);
    expect(MSG_ReadShort()).toBe(-50);
    expect(MSG_ReadShort()).toBe(5);
    expect(MSG_ReadByte()).toBe(1); // bit 0 (attack) set, bit 1 (jump) clear
    expect(MSG_ReadByte()).toBe(7); // impulse

    // cl.cmd is a field-by-field copy of the cmd passed in
    expect(cl.cmd.forwardmove).toBe(100);
    expect(cl.cmd.sidemove).toBe(-50);
    expect(cl.cmd.upmove).toBe(5);

    // "state &= ~2" clears the impulse-down edge but not the down bit;
    // in_impulse is reset to 0 unconditionally after being written
    expect(cl_input.in_attack.state).toBe(1);
    expect(cl_input.in_impulse).toBe(0);
  });

  test("demoplayback returns before movemessages is even incremented", () => {
    cls.demoplayback = true;
    cl.movemessages = 5;
    cl_input.CL_SendMove(new UsercmdT());
    expect(cl.movemessages).toBe(5);
  });

  test("a send failure (no connection) logs and calls CL_Disconnect", () => {
    cls.netcon = null; // NET_SendUnreliableMessage(null, ...) returns -1
    cl.movemessages = 3; // already past the dump-first-two threshold
    cl_input.CL_SendMove(new UsercmdT());
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CL_InitInput", () => {
  test("registers every +/- movement and button command cl_input.c registers, plus impulse", () => {
    cl_input.CL_InitInput();
    const expectedCommands = [
      "+moveup",
      "-moveup",
      "+movedown",
      "-movedown",
      "+left",
      "-left",
      "+right",
      "-right",
      "+forward",
      "-forward",
      "+back",
      "-back",
      "+lookup",
      "-lookup",
      "+lookdown",
      "-lookdown",
      "+strafe",
      "-strafe",
      "+moveleft",
      "-moveleft",
      "+moveright",
      "-moveright",
      "+speed",
      "-speed",
      "+attack",
      "-attack",
      "+use",
      "-use",
      "+jump",
      "-jump",
      "impulse",
      "+klook",
      "-klook",
      "+mlook",
      "-mlook",
    ];
    for (const name of expectedCommands) {
      expect(Cmd_Exists(name)).toBe(true);
    }
  });
});

describe("cvar defaults (cl_input.c literals)", () => {
  test("values and archive flags", () => {
    expect(cl_input.cl_upspeed.value).toBe(200);
    expect(cl_input.cl_upspeed.archive).toBe(false);
    expect(cl_input.cl_forwardspeed.value).toBe(200);
    expect(cl_input.cl_forwardspeed.archive).toBe(true);
    expect(cl_input.cl_backspeed.value).toBe(200);
    expect(cl_input.cl_backspeed.archive).toBe(true);
    expect(cl_input.cl_sidespeed.value).toBe(350);
    expect(cl_input.cl_sidespeed.archive).toBe(false);
    expect(cl_input.cl_movespeedkey.value).toBe(2.0);
    expect(cl_input.cl_movespeedkey.archive).toBe(false);
    expect(cl_input.cl_yawspeed.value).toBe(140);
    expect(cl_input.cl_yawspeed.archive).toBe(false);
    expect(cl_input.cl_pitchspeed.value).toBe(150);
    expect(cl_input.cl_pitchspeed.archive).toBe(false);
    expect(cl_input.cl_anglespeedkey.value).toBe(1.5);
    expect(cl_input.cl_anglespeedkey.archive).toBe(false);
  });
});
