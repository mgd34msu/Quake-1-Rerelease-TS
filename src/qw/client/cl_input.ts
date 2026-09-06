/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_input.c (GNU GPL v2 or later), diffed against the
landed WinQuake port (src/client/cl_input.ts) and against
WinQuake/cl_input.c directly.

cl_input.c -- builds an intended movement command to send to the server
(QuakeWorld track: qwcl). "One engine, two extra entry points" (PORTING.md):
this is a wholesale-different module (own kbutton_t instances, own cvars,
own CL_SendCmd/CL_FinishMove/CL_ClearStates), not a fold into the landed
WinQuake cl_input.ts -- qwcl and quake.exe are different binaries in the
original C and never share these globals at runtime, matching this port's
"identical files are not re-ported, wholesale-different files get their own
module" ruling.

Genuine differences from WinQuake/cl_input.c (read directly, both files in
full):
- No `cl_nodelta` cvar in WinQuake; QW declares one at file scope and
  registers it in CL_InitInput.
- `CL_BaseMove` does not check `cls.signon != SIGNONS` (WinQuake's does) and
  copies `cl.viewangles` into `cmd->angles` unconditionally near the top,
  not gated behind anything.
- WinQuake's `CL_SendMove` (one function: builds bits, writes one message,
  the netchan-independent NET_SendUnreliableMessage transport) is replaced
  entirely by three QW functions: `CL_FinishMove` (frametime -> msec,
  button bits, impulse, angle rounding to 16-bit precision, `MakeChar`
  truncation of forwardmove/sidemove/upmove), `MakeChar`, and `CL_SendCmd`
  (the netchan transport: three delta-compressed usercmds via
  `MSG_WriteDeltaUsercmd`, a `COM_BlockSequenceCRCByte` checksum byte, a
  network-lossage byte from `CL_CalcNet`, an optional `clc_delta` byte, and
  `Netchan_Transmit` instead of `NET_SendUnreliableMessage`).
- `Cam_Track`/`Cam_FinishMove` (spectator autocam, src/qw/client/cl_cam.ts,
  landed) and `IN_Move` (external controller input) are new calls in
  CL_SendCmd; WinQuake's own CL_SendMove has neither (its call site is
  cl_main.c's CL_SendCmd -- WinQuake's *own* wraps CL_BaseMove/CL_SendMove
  and calls IN_Move on its own UsercmdT, a different, incompatible shape --
  see deviation below).
- `CL_ClearStates` (a no-op function body in the C, `void CL_ClearStates
  (void) {}`) exists in QW's cl_input.c; WinQuake's does not declare it in
  this file at all. Ported as an equally-empty exported function, for
  fidelity with the C's declaration (not a "TODO", an intentional empty
  body matching the source).

Deviations from PORTING.md / the C source:
- `kbutton_t` is reused from src/client/client.ts's `KbuttonT` (identical
  shape in both C trees: `int down[2]; int state;`, confirmed by reading
  QW/client/client.h) rather than redeclared; the seventeen `in_*` globals
  below are this module's OWN fresh instances (`new KbuttonT()`), never the
  WinQuake singletons, matching the "two different binaries, two different
  sets of file-scope globals" reality above. Likewise `BeamT`/cvar shape
  reuse elsewhere in this track (cl_tent.ts, cl_ents.ts) reuses *classes*,
  never *instances*, across the WinQuake/QW boundary.
- `in_impulse` (bare `int`, reassigned only inside this file) is `export let
  in_impulse`, per the same live-ES-binding ruling WinQuake's cl_input.ts
  documents for its own copy.
- The eight movement cvars (`cl_upspeed` .. `cl_anglespeedkey`) are `export
  const` CvarT instances; src/qw/client/cl_main.ts (already landed) imports
  them by these exact names and registers them (mirroring cl_main.c's
  CL_Init calling Cvar_RegisterVariable on cl_input.c's cvars) -- confirmed
  by reading that file's own import list before writing this one.
- `lookspring`, `V_StartPitchDrift`/`V_StopPitchDrift`: QW's `IN_MLookUp`/
  `CL_AdjustAngles` read these exactly as WinQuake's do. `lookspring` is
  cl_main.c's own cvar, imported from ./cl_main -- the same import
  src/client/cl_input.ts makes from its own cl_main, and the same
  cl_input<->cl_main cycle the C's two translation units have (neither side
  touches the other at module-init time). QW has no cl_input-side view.c;
  view.c's QW delta is folded into src/client/view.ts under qw.active, so
  `V_StartPitchDrift`/`V_StopPitchDrift` come from there.
- `CL_CalcNet` (cl_parse.c, src/qw/client/cl_parse.ts) and `CL_WriteDemoCmd`
  (cl_demo.c, src/qw/client/cl_demo.ts) landed as concurrent siblings during
  this unit's own work (re-checked immediately before finishing this file)
  and import cleanly with exactly these names; no hook needed for either.
- `IN_Move`: WinQuake's `InputBackend.IN_Move` (src/client/input.ts) takes
  `UsercmdT` from src/server/server.ts, not this module's `QwUsercmdT` --
  two different structs, because the C's two trees are two binaries each
  with their own `usercmd_t` and their own `IN_Move` over it. The backend
  interface carries both entry points; CL_SendCmd calls `IN_MoveQw` where
  the C calls `IN_Move`. Both bodies are the same code in the C and share
  one body in src/platform/sdl.ts.
- `Cam_Track`/`Cam_FinishMove` (src/qw/client/cl_cam.ts) import cleanly --
  that module has landed with exactly these two exported names.
- `COM_BlockSequenceCRCByte`, `MSG_WriteDeltaUsercmd`, `nullcmd`, QW's own
  `MSG_WriteAngle` (different truncation order than WinQuake's, see
  src/qw/common.ts's own header) all come from src/qw/common.ts (landed).
- `cls.netchan`/`cl.frames` -> `cls.qw.netchan` (now typed `NetchanT`
  directly, per src/qw/client/client.ts's current state -- its own header
  comment calling this a pending follow-up is stale, confirmed by reading
  the file immediately before writing this one) / `cl.qw.frames`.
- `UPDATE_MASK`/`UPDATE_BACKUP` from src/qw/protocol.ts, not bothdefs.ts
  (that module's own header explains the correction).
- `Netchan_Transmit` from src/qw/net_chan.ts (landed).
*/

import { Con_Printf } from "./console";
import { Cmd_AddCommand, Cmd_Argv } from "../cmd";
import { Q_atoi } from "../../common/common";
import { CvarT, Cvar_RegisterVariable } from "../../common/cvar";
import { host } from "../../common/host";
import { anglemod, VectorCopy } from "../../common/mathlib";
import { PITCH, YAW, ROLL } from "../../common/quakedef";
import { SizeBuf } from "../../common/sizebuf";
import { KbuttonT } from "../../client/client";
import { Cam_Track, Cam_FinishMove } from "./cl_cam";
import { cl, cls } from "../../client/client";
import { CactiveT } from "../../client/client";
import { QwUsercmdT, ClcOpsT, UPDATE_BACKUP, UPDATE_MASK } from "../protocol";
import { MSG_WriteByte, MSG_WriteDeltaUsercmd, COM_BlockSequenceCRCByte, nullcmd } from "../common";
import { Netchan_Transmit } from "../net_chan";
import { CL_CalcNet } from "./cl_parse";
import { CL_WriteDemoCmd } from "./cl_demo";
import { lookspring, lookstrafe, sensitivity, m_pitch, m_yaw, m_forward, m_side } from "./cl_main";
import { V_StartPitchDrift, V_StopPitchDrift } from "../../client/view";
import { inputBackend, qwInputHooks } from "../../client/input";

/*
===============================================================================

KEY BUTTONS

Continuous button event tracking is complicated by the fact that two different
input sources (say, mouse button 1 and the control key) can both press the
same button, but the button should only be released when both of the
pressing key have been released.

When a key event issues a button command (+forward, +attack, etc), it appends
its key number as a parameter to the command so it can be matched up with
the release.

state bit 0 is the current state of the key
state bit 1 is edge triggered on the up to down transition
state bit 2 is edge triggered on the down to up transition

===============================================================================
*/

export const in_mlook = new KbuttonT();
export const in_klook = new KbuttonT();
export const in_left = new KbuttonT();
export const in_right = new KbuttonT();
export const in_forward = new KbuttonT();
export const in_back = new KbuttonT();
export const in_lookup = new KbuttonT();
export const in_lookdown = new KbuttonT();
export const in_moveleft = new KbuttonT();
export const in_moveright = new KbuttonT();
export const in_strafe = new KbuttonT();
export const in_speed = new KbuttonT();
export const in_use = new KbuttonT();
export const in_jump = new KbuttonT();
export const in_attack = new KbuttonT();
export const in_up = new KbuttonT();
export const in_down = new KbuttonT();

export let in_impulse = 0;

export function KeyDown(b: KbuttonT): void {
  const c = Cmd_Argv(1);
  let k: number;
  if (c[0]) k = Q_atoi(c);
  else k = -1; // typed manually at the console for continuous down

  if (k === b.down[0] || k === b.down[1]) return; // repeating key

  if (!b.down[0]) b.down[0] = k;
  else if (!b.down[1]) b.down[1] = k;
  else {
    Con_Printf("Three keys down for a button!\n");
    return;
  }

  if (b.state & 1) return; // still down
  b.state |= 1 + 2; // down + impulse down
}

export function KeyUp(b: KbuttonT): void {
  const c = Cmd_Argv(1);
  let k: number;
  if (c[0]) {
    k = Q_atoi(c);
  } else {
    // typed manually at the console, assume for unsticking, so clear all
    b.down[0] = b.down[1] = 0;
    b.state = 4; // impulse up
    return;
  }

  if (b.down[0] === k) b.down[0] = 0;
  else if (b.down[1] === k) b.down[1] = 0;
  else return; // key up without coresponding down (menu pass through)
  if (b.down[0] || b.down[1]) return; // some other key is still holding it down

  if (!(b.state & 1)) return; // still up (this should not happen)
  b.state &= ~1; // now up
  b.state |= 4; // impulse up
}

export function IN_KLookDown(): void {
  KeyDown(in_klook);
}
export function IN_KLookUp(): void {
  KeyUp(in_klook);
}
export function IN_MLookDown(): void {
  KeyDown(in_mlook);
}
export function IN_MLookUp(): void {
  KeyUp(in_mlook);
  if (!(in_mlook.state & 1) && lookspring.value) V_StartPitchDrift();
}
export function IN_UpDown(): void {
  KeyDown(in_up);
}
export function IN_UpUp(): void {
  KeyUp(in_up);
}
export function IN_DownDown(): void {
  KeyDown(in_down);
}
export function IN_DownUp(): void {
  KeyUp(in_down);
}
export function IN_LeftDown(): void {
  KeyDown(in_left);
}
export function IN_LeftUp(): void {
  KeyUp(in_left);
}
export function IN_RightDown(): void {
  KeyDown(in_right);
}
export function IN_RightUp(): void {
  KeyUp(in_right);
}
export function IN_ForwardDown(): void {
  KeyDown(in_forward);
}
export function IN_ForwardUp(): void {
  KeyUp(in_forward);
}
export function IN_BackDown(): void {
  KeyDown(in_back);
}
export function IN_BackUp(): void {
  KeyUp(in_back);
}
export function IN_LookupDown(): void {
  KeyDown(in_lookup);
}
export function IN_LookupUp(): void {
  KeyUp(in_lookup);
}
export function IN_LookdownDown(): void {
  KeyDown(in_lookdown);
}
export function IN_LookdownUp(): void {
  KeyUp(in_lookdown);
}
export function IN_MoveleftDown(): void {
  KeyDown(in_moveleft);
}
export function IN_MoveleftUp(): void {
  KeyUp(in_moveleft);
}
export function IN_MoverightDown(): void {
  KeyDown(in_moveright);
}
export function IN_MoverightUp(): void {
  KeyUp(in_moveright);
}

export function IN_SpeedDown(): void {
  KeyDown(in_speed);
}
export function IN_SpeedUp(): void {
  KeyUp(in_speed);
}
export function IN_StrafeDown(): void {
  KeyDown(in_strafe);
}
export function IN_StrafeUp(): void {
  KeyUp(in_strafe);
}

export function IN_AttackDown(): void {
  KeyDown(in_attack);
}
export function IN_AttackUp(): void {
  KeyUp(in_attack);
}

export function IN_UseDown(): void {
  KeyDown(in_use);
}
export function IN_UseUp(): void {
  KeyUp(in_use);
}
export function IN_JumpDown(): void {
  KeyDown(in_jump);
}
export function IN_JumpUp(): void {
  KeyUp(in_jump);
}

export function IN_Impulse(): void {
  in_impulse = Q_atoi(Cmd_Argv(1));
}

/*
===============
CL_KeyState

Returns 0.25 if a key was pressed and released during the frame,
0.5 if it was pressed and held
0 if held then released, and
1.0 if held for the entire time
===============
*/
export function CL_KeyState(key: KbuttonT): number {
  const impulsedown = (key.state & 2) !== 0;
  const impulseup = (key.state & 4) !== 0;
  const down = (key.state & 1) !== 0;
  let val = 0;

  if (impulsedown && !impulseup) {
    if (down) val = 0.5; // pressed and held this frame
    else val = 0; //	I_Error ();
  }
  if (impulseup && !impulsedown) {
    if (down) val = 0; //	I_Error ();
    else val = 0; // released this frame
  }
  if (!impulsedown && !impulseup) {
    if (down) val = 1.0; // held the entire frame
    else val = 0; // up the entire frame
  }
  if (impulsedown && impulseup) {
    if (down) val = 0.75; // released and re-pressed this frame
    else val = 0.25; // pressed and released this frame
  }

  key.state &= 1; // clear impulses

  return val;
}

//==========================================================================

export const cl_nodelta = new CvarT("cl_nodelta", "0");

export const cl_upspeed = new CvarT("cl_upspeed", "200");
export const cl_forwardspeed = new CvarT("cl_forwardspeed", "200", true);
export const cl_backspeed = new CvarT("cl_backspeed", "200", true);
export const cl_sidespeed = new CvarT("cl_sidespeed", "350");

export const cl_movespeedkey = new CvarT("cl_movespeedkey", "2.0");

export const cl_yawspeed = new CvarT("cl_yawspeed", "140");
export const cl_pitchspeed = new CvarT("cl_pitchspeed", "150");

export const cl_anglespeedkey = new CvarT("cl_anglespeedkey", "1.5");

/*
================
CL_AdjustAngles

Moves the local angle positions
================
*/
export function CL_AdjustAngles(): void {
  let speed: number;

  if (in_speed.state & 1) speed = host.frametime * cl_anglespeedkey.value;
  else speed = host.frametime;

  if (!(in_strafe.state & 1)) {
    cl.viewangles[YAW] -= speed * cl_yawspeed.value * CL_KeyState(in_right);
    cl.viewangles[YAW] += speed * cl_yawspeed.value * CL_KeyState(in_left);
    cl.viewangles[YAW] = anglemod(cl.viewangles[YAW]);
  }
  if (in_klook.state & 1) {
    V_StopPitchDrift();
    cl.viewangles[PITCH] -= speed * cl_pitchspeed.value * CL_KeyState(in_forward);
    cl.viewangles[PITCH] += speed * cl_pitchspeed.value * CL_KeyState(in_back);
  }

  const up = CL_KeyState(in_lookup);
  const down = CL_KeyState(in_lookdown);

  cl.viewangles[PITCH] -= speed * cl_pitchspeed.value * up;
  cl.viewangles[PITCH] += speed * cl_pitchspeed.value * down;

  if (up || down) V_StopPitchDrift();

  if (cl.viewangles[PITCH] > 80) cl.viewangles[PITCH] = 80;
  if (cl.viewangles[PITCH] < -70) cl.viewangles[PITCH] = -70;

  if (cl.viewangles[ROLL] > 50) cl.viewangles[ROLL] = 50;
  if (cl.viewangles[ROLL] < -50) cl.viewangles[ROLL] = -50;
}

/*
================
CL_BaseMove

Send the intended movement message to the server
================
*/
export function CL_BaseMove(cmd: QwUsercmdT): void {
  CL_AdjustAngles();

  // Q_memset (cmd, 0, sizeof(*cmd));
  cmd.msec = 0;
  cmd.angles[0] = 0;
  cmd.angles[1] = 0;
  cmd.angles[2] = 0;
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.upmove = 0;
  cmd.buttons = 0;
  cmd.impulse = 0;

  VectorCopy(cl.viewangles, cmd.angles);
  if (in_strafe.state & 1) {
    cmd.sidemove += cl_sidespeed.value * CL_KeyState(in_right);
    cmd.sidemove -= cl_sidespeed.value * CL_KeyState(in_left);
  }

  cmd.sidemove += cl_sidespeed.value * CL_KeyState(in_moveright);
  cmd.sidemove -= cl_sidespeed.value * CL_KeyState(in_moveleft);

  cmd.upmove += cl_upspeed.value * CL_KeyState(in_up);
  cmd.upmove -= cl_upspeed.value * CL_KeyState(in_down);

  if (!(in_klook.state & 1)) {
    cmd.forwardmove += cl_forwardspeed.value * CL_KeyState(in_forward);
    cmd.forwardmove -= cl_backspeed.value * CL_KeyState(in_back);
  }

  //
  // adjust for speed key
  //
  if (in_speed.state & 1) {
    cmd.forwardmove *= cl_movespeedkey.value;
    cmd.sidemove *= cl_movespeedkey.value;
    cmd.upmove *= cl_movespeedkey.value;
  }
}

function MakeChar(i: number): number {
  let r = i & ~3;
  if (r < -127 * 4) r = -127 * 4;
  if (r > 127 * 4) r = 127 * 4;
  return r;
}

/*
==============
CL_FinishMove
==============
*/
export function CL_FinishMove(cmd: QwUsercmdT): void {
  //
  // allways dump the first two message, because it may contain leftover inputs
  // from the last level
  //
  if (++cl.movemessages <= 2) return;
  //
  // figure button bits
  //
  if (in_attack.state & 3) cmd.buttons |= 1;
  in_attack.state &= ~2;

  if (in_jump.state & 3) cmd.buttons |= 2;
  in_jump.state &= ~2;

  // send milliseconds of time to apply the move
  let ms = Math.trunc(host.frametime * 1000);
  if (ms > 250) ms = 100; // time was unreasonable
  cmd.msec = ms;

  VectorCopy(cl.viewangles, cmd.angles);

  cmd.impulse = in_impulse;
  in_impulse = 0;

  //
  // chop down so no extra bits are kept that the server wouldn't get
  //
  cmd.forwardmove = MakeChar(cmd.forwardmove);
  cmd.sidemove = MakeChar(cmd.sidemove);
  cmd.upmove = MakeChar(cmd.upmove);

  for (let i = 0; i < 3; i++) cmd.angles[i] = (Math.trunc((cmd.angles[i] * 65536.0) / 360) & 65535) * (360.0 / 65536.0);
}

/*
=================
CL_SendCmd
=================
*/
export function CL_SendCmd(): void {
  if (cls.demoplayback) return; // sendcmds come from the demo

  const netchan = cls.qw.netchan;

  // save this command off for prediction
  let i = netchan.outgoing_sequence & UPDATE_MASK;
  let cmd = cl.qw.frames[i].cmd;
  cl.qw.frames[i].senttime = host.realtime;
  cl.qw.frames[i].receivedtime = -1; // we haven't gotten a reply yet

  const seq_hash = netchan.outgoing_sequence;

  // get basic movement from keyboard
  CL_BaseMove(cmd);

  // allow mice or other external controllers to add to the move
  inputBackend.current?.IN_MoveQw(cmd);

  // if we are spectator, try autocam
  if (cl.qw.spectator) Cam_Track(cmd);

  CL_FinishMove(cmd);

  Cam_FinishMove(cmd);

  // send this and the previous cmds in the message, so
  // if the last packet was dropped, it can be recovered
  const data = new Uint8Array(128);
  const buf = new SizeBuf();
  buf.maxsize = 128;
  buf.cursize = 0;
  buf.data = data;

  MSG_WriteByte(buf, ClcOpsT.clc_move);

  // save the position for a checksum byte
  const checksumIndex = buf.cursize;
  MSG_WriteByte(buf, 0);

  // write our lossage percentage
  const lost = CL_CalcNet();
  MSG_WriteByte(buf, lost & 0xff);

  i = (netchan.outgoing_sequence - 2) & UPDATE_MASK;
  cmd = cl.qw.frames[i].cmd;
  MSG_WriteDeltaUsercmd(buf, nullcmd, cmd);
  let oldcmd = cmd;

  i = (netchan.outgoing_sequence - 1) & UPDATE_MASK;
  cmd = cl.qw.frames[i].cmd;
  MSG_WriteDeltaUsercmd(buf, oldcmd, cmd);
  oldcmd = cmd;

  i = netchan.outgoing_sequence & UPDATE_MASK;
  cmd = cl.qw.frames[i].cmd;
  MSG_WriteDeltaUsercmd(buf, oldcmd, cmd);

  // calculate a checksum over the move commands
  buf.data[checksumIndex] = COM_BlockSequenceCRCByte(buf.data.subarray(checksumIndex + 1), buf.cursize - checksumIndex - 1, seq_hash);

  // request delta compression of entities
  if (netchan.outgoing_sequence - cl.qw.validsequence >= UPDATE_BACKUP - 1) cl.qw.validsequence = 0;

  if (cl.qw.validsequence && !cl_nodelta.value && cls.state === CactiveT.ca_active && !cls.demorecording) {
    cl.qw.frames[netchan.outgoing_sequence & UPDATE_MASK].delta_sequence = cl.qw.validsequence;
    MSG_WriteByte(buf, ClcOpsT.clc_delta);
    MSG_WriteByte(buf, cl.qw.validsequence & 255);
  } else {
    cl.qw.frames[netchan.outgoing_sequence & UPDATE_MASK].delta_sequence = -1;
  }

  if (cls.demorecording) CL_WriteDemoCmd(cmd);

  //
  // deliver the message
  //
  Netchan_Transmit(netchan, buf.cursize, buf.data);
}

/*
============
CL_InitInput
============
*/
export function CL_InitInput(): void {
  Cmd_AddCommand("+moveup", IN_UpDown);
  Cmd_AddCommand("-moveup", IN_UpUp);
  Cmd_AddCommand("+movedown", IN_DownDown);
  Cmd_AddCommand("-movedown", IN_DownUp);
  Cmd_AddCommand("+left", IN_LeftDown);
  Cmd_AddCommand("-left", IN_LeftUp);
  Cmd_AddCommand("+right", IN_RightDown);
  Cmd_AddCommand("-right", IN_RightUp);
  Cmd_AddCommand("+forward", IN_ForwardDown);
  Cmd_AddCommand("-forward", IN_ForwardUp);
  Cmd_AddCommand("+back", IN_BackDown);
  Cmd_AddCommand("-back", IN_BackUp);
  Cmd_AddCommand("+lookup", IN_LookupDown);
  Cmd_AddCommand("-lookup", IN_LookupUp);
  Cmd_AddCommand("+lookdown", IN_LookdownDown);
  Cmd_AddCommand("-lookdown", IN_LookdownUp);
  Cmd_AddCommand("+strafe", IN_StrafeDown);
  Cmd_AddCommand("-strafe", IN_StrafeUp);
  Cmd_AddCommand("+moveleft", IN_MoveleftDown);
  Cmd_AddCommand("-moveleft", IN_MoveleftUp);
  Cmd_AddCommand("+moveright", IN_MoverightDown);
  Cmd_AddCommand("-moveright", IN_MoverightUp);
  Cmd_AddCommand("+speed", IN_SpeedDown);
  Cmd_AddCommand("-speed", IN_SpeedUp);
  Cmd_AddCommand("+attack", IN_AttackDown);
  Cmd_AddCommand("-attack", IN_AttackUp);
  Cmd_AddCommand("+use", IN_UseDown);
  Cmd_AddCommand("-use", IN_UseUp);
  Cmd_AddCommand("+jump", IN_JumpDown);
  Cmd_AddCommand("-jump", IN_JumpUp);
  Cmd_AddCommand("impulse", IN_Impulse);
  Cmd_AddCommand("+klook", IN_KLookDown);
  Cmd_AddCommand("-klook", IN_KLookUp);
  Cmd_AddCommand("+mlook", IN_MLookDown);
  Cmd_AddCommand("-mlook", IN_MLookUp);

  Cvar_RegisterVariable(cl_nodelta);

  // QW/client/vid_x.c's IN_Move reads THESE objects, not the WinQuake tree's
  // identically-named ones; one process compiles both, so the shared backend
  // body (src/platform/sdl.ts) is handed the live set here -- see
  // src/client/input.ts's header on qwInputHooks.
  qwInputHooks.current = { in_strafe, in_mlook, lookstrafe, sensitivity, m_pitch, m_yaw, m_forward, m_side };
}

/*
============
CL_ClearStates
============
*/
export function CL_ClearStates(): void {}
