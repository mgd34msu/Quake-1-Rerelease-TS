/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cl_input.c (GNU GPL v2 or later).

cl.input.c -- builds an intended movement command to send to the server

Deviations from PORTING.md / the C source:
- `kbutton_t` is `KbuttonT`, already declared in src/client/client.ts (that
  module's header explains why: client.h forward-declares the type, this file
  defines the instances). The seventeen `in_*` globals are `export const`
  singletons here, matching PORTING.md's "Shared mutable globals ... become
  exported const singleton objects mutated in place".
- `in_impulse` (a bare `int`, reassigned only inside this file -- IN_Impulse
  sets it, CL_SendMove reads and clears it, nothing else in the C tree reads
  it) is `export let in_impulse`, a live ES binding, rather than a holder
  object: PORTING.md's holder-object rule is for globals written by more than
  one module, which this is not.
- The eight cvars cl_input.c declares (`cl_upspeed` ... `cl_anglespeedkey`)
  are `export const` CvarT instances here, exactly as sv_phys.ts/sv_user.ts
  export their own cvars. cl_main.c's `CL_Init` is the C function that calls
  `Cvar_RegisterVariable` on each of them (cl_main.c:727-736); cl_main.ts
  (U041, not yet landed) owns that registration call, not this file --
  cl_input.c itself never calls Cvar_RegisterVariable on its own cvars.
- `lookspring` (cvar) and `V_StartPitchDrift`/`V_StopPitchDrift` are extern
  reads into other WinQuake files: `lookspring` is defined in cl_main.c,
  `V_Start/StopPitchDrift` in view.c. Both cl_main.ts and view.ts are
  concurrent siblings not yet landed; imported by their C names per the
  brief's absent-sibling rule.
- `CL_Disconnect` (cl_main.c) is imported the same way, for CL_SendMove's
  "lost server connection" path.
- `Q_memset (cmd, 0, sizeof(*cmd))` in CL_BaseMove becomes explicit
  field-by-field zeroing of the four `UsercmdT` fields (viewangles is a
  Vec3, not a scalar).
- `cl.cmd = *cmd;` in CL_SendMove is a struct-value copy in the C; ported as
  a field-by-field copy into the `cl.cmd` singleton (client.ts's ClientStateT
  never reassigns `cl.cmd` itself, matching PORTING.md's singleton-mutation
  rule).
- CL_SendMove's local `sizebuf_t buf; byte data[128];` is built the same way
  host.ts's Host_ShutdownServer and sv_main.ts's SV_SendClientDatagram build
  their own throwaway sizebufs: a raw `Uint8Array(128)` plus manual
  maxsize/cursize/data fields, not `SZ_Alloc` (which floors startsize at 256
  and would silently change the buffer's capacity from the C's exact 128).
- Dropped `#ifdef QUAKE2` blocks: CL_BaseMove's `cmd->lightlevel =
  cl.light_level;` and CL_SendMove's light-level MSG_WriteByte (client.ts's
  UsercmdT already has no `lightlevel` field, matching that module's own
  documented QUAKE2 drop).
*/

import { Con_Printf } from "./console";
import { Cmd_AddCommand, Cmd_Argv } from "../common/cmd";
import { Q_atoi } from "../common/common";
import { CvarT } from "../common/cvar";
import { host } from "../common/host";
import { anglemod } from "../common/mathlib";
import { PITCH, YAW, ROLL } from "../common/quakedef";
import { MSG_WriteAngle, MSG_WriteByte, MSG_WriteFloat, MSG_WriteShort, SizeBuf } from "../common/sizebuf";
import { ClcOpsT } from "../common/protocol";
import { NET_SendUnreliableMessage } from "../common/net_main";
import { cl, cls, KbuttonT, SIGNONS, UsercmdT } from "./client";
// cl_main.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { CL_Disconnect, lookspring } from "./cl_main";
// view.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { V_StartPitchDrift, V_StopPitchDrift } from "./view";

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
export function CL_BaseMove(cmd: UsercmdT): void {
  if (cls.signon !== SIGNONS) return;

  CL_AdjustAngles();

  // Q_memset (cmd, 0, sizeof(*cmd));
  cmd.viewangles[0] = 0;
  cmd.viewangles[1] = 0;
  cmd.viewangles[2] = 0;
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.upmove = 0;

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

/*
==============
CL_SendMove
==============
*/
export function CL_SendMove(cmd: UsercmdT): void {
  const data = new Uint8Array(128);
  const buf = new SizeBuf();
  buf.maxsize = 128;
  buf.cursize = 0;
  buf.data = data;

  // cl.cmd = *cmd;
  cl.cmd.viewangles[0] = cmd.viewangles[0];
  cl.cmd.viewangles[1] = cmd.viewangles[1];
  cl.cmd.viewangles[2] = cmd.viewangles[2];
  cl.cmd.forwardmove = cmd.forwardmove;
  cl.cmd.sidemove = cmd.sidemove;
  cl.cmd.upmove = cmd.upmove;

  //
  // send the movement message
  //
  MSG_WriteByte(buf, ClcOpsT.clc_move);

  MSG_WriteFloat(buf, cl.mtime[0]); // so server can get ping times

  for (let i = 0; i < 3; i++) MSG_WriteAngle(buf, cl.viewangles[i]);

  MSG_WriteShort(buf, cmd.forwardmove);
  MSG_WriteShort(buf, cmd.sidemove);
  MSG_WriteShort(buf, cmd.upmove);

  //
  // send button bits
  //
  let bits = 0;

  if (in_attack.state & 3) bits |= 1;
  in_attack.state &= ~2;

  if (in_jump.state & 3) bits |= 2;
  in_jump.state &= ~2;

  MSG_WriteByte(buf, bits);

  MSG_WriteByte(buf, in_impulse);
  in_impulse = 0;

  //
  // deliver the message
  //
  if (cls.demoplayback) return;

  //
  // allways dump the first two message, because it may contain leftover inputs
  // from the last level
  //
  if (++cl.movemessages <= 2) return;

  if (NET_SendUnreliableMessage(cls.netcon, buf) === -1) {
    Con_Printf("CL_SendMove: lost server connection\n");
    CL_Disconnect();
  }
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
}
