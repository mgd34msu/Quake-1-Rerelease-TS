/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_pred.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- `qboolean spectator` (CL_PredictUsercmd's fourth argument) is `boolean` here,
  while `pmove.spectator` (src/qw/pmove_types.ts) is a `number` because the C
  assigns `cl.spectator`/`sv_client->spectator` straight into it. The one call
  site that passes a real value, CL_PredictMove, converts `cl.qw.spectator !== 0`.
- The `#ifdef _WIN32` tail of CL_PredictMove's ca_onserver branch
  (`sprintf (text, "QuakeWorld: %s", cls.servername); SetWindowText
  (mainwindow, text);`) is the Win32-only window title. PORTING.md's rule is to
  take the portable branch, where nothing remains of it, so the sprintf and its
  buffer are dropped with it -- see "dropped #ifdef branches" in the report.
- `onground` is `pmState.onground` (src/qw/pmove_types.ts's holder for pmove.c's
  reassigned int globals).
*/

import { type Vec3, vec3, VectorCopy } from "../../common/mathlib";
import { CONTENTS_EMPTY } from "../../common/bspfile";
import { STAT_HEALTH } from "../../common/quakedef";
import { CactiveT, cl, cls } from "../../client/client";
import { Con_DPrintf } from "./console";
import { clMainState } from "./cl_main";
import { Cvar_RegisterVariable, Cvar_Set, CvarT } from "../../common/cvar";
import { pmove, pmState } from "../pmove_types";
import { PM_HullPointContents } from "../pmovetst";
import { PlayerMove } from "../pmove";
import { QwUsercmdT, UPDATE_BACKUP, UPDATE_MASK } from "../protocol";
import { PlayerStateT } from "./client";
import type { FrameT } from "./client";
import { CL_SetSolidPlayers } from "./cl_ents";

export const cl_nopred = new CvarT("cl_nopred", "0");
export const cl_pushlatency = new CvarT("pushlatency", "-999");

/*
=================
CL_NudgePosition

If pmove.origin is in a solid position,
try nudging slightly on all axis to
allow for the cut precision of the net coordinates
=================
*/
export function CL_NudgePosition(): void {
  const base: Vec3 = vec3();

  const world = cl.model_precache[1];
  if (world === null) return;

  if (PM_HullPointContents(world.hulls[1], 0, pmove.origin) === CONTENTS_EMPTY) return;

  VectorCopy(pmove.origin, base);
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      pmove.origin[0] = base[0] + (x * 1.0) / 8;
      pmove.origin[1] = base[1] + (y * 1.0) / 8;
      if (PM_HullPointContents(world.hulls[1], 0, pmove.origin) === CONTENTS_EMPTY) return;
    }
  }
  Con_DPrintf("CL_NudgePosition: stuck\n");
}

/*
==============
CL_PredictUsercmd
==============
*/
export function CL_PredictUsercmd(from: PlayerStateT, to: PlayerStateT, u: QwUsercmdT, spectator: boolean): void {
  // split up very long moves
  if (u.msec > 50) {
    const temp: PlayerStateT = new PlayerStateT();
    const split = new QwUsercmdT();

    copyUsercmd(u, split);
    split.msec = Math.trunc(split.msec / 2);

    CL_PredictUsercmd(from, temp, split, spectator);
    CL_PredictUsercmd(temp, to, split, spectator);
    return;
  }

  VectorCopy(from.origin, pmove.origin);
  //	VectorCopy (from->viewangles, pmove.angles);
  VectorCopy(u.angles, pmove.angles);
  VectorCopy(from.velocity, pmove.velocity);

  pmove.oldbuttons = from.oldbuttons;
  pmove.waterjumptime = from.waterjumptime;
  pmove.dead = cl.stats[STAT_HEALTH] <= 0;
  pmove.spectator = spectator ? 1 : 0;

  copyUsercmd(u, pmove.cmd);

  PlayerMove();

  to.waterjumptime = pmove.waterjumptime;
  to.oldbuttons = pmove.cmd.buttons;
  VectorCopy(pmove.origin, to.origin);
  VectorCopy(pmove.angles, to.viewangles);
  VectorCopy(pmove.velocity, to.velocity);
  to.onground = pmState.onground;

  to.weaponframe = from.weaponframe;
}

/*
==============
CL_PredictMove
==============
*/
export function CL_PredictMove(): void {
  let from: FrameT;
  let to: FrameT | null = null;
  let i: number;

  if (cl_pushlatency.value > 0) Cvar_Set("pushlatency", "0");

  if (cl.paused) return;

  cl.time = clMainState.realtime - cls.qw.latency - cl_pushlatency.value * 0.001;
  if (cl.time > clMainState.realtime) cl.time = clMainState.realtime;

  if (cl.intermission) return;

  if (!cl.qw.validsequence) return;

  if (cls.qw.netchan.outgoing_sequence - cls.qw.netchan.incoming_sequence >= UPDATE_BACKUP - 1) return;

  VectorCopy(cl.viewangles, cl.qw.simangles);

  // this is the last frame received from the server
  from = cl.qw.frames[cls.qw.netchan.incoming_sequence & UPDATE_MASK];

  // we can now render a frame
  if (cls.state === CactiveT.ca_onserver) {
    // first update is the final signon stage
    cls.state = CactiveT.ca_active;
  }

  if (cl_nopred.value) {
    VectorCopy(from.playerstate[cl.qw.playernum].velocity, cl.qw.simvel);
    VectorCopy(from.playerstate[cl.qw.playernum].origin, cl.qw.simorg);
    return;
  }

  // predict forward until cl.time <= to->senttime
  const oldphysent = pmove.numphysent;
  CL_SetSolidPlayers(cl.qw.playernum);

  for (i = 1; i < UPDATE_BACKUP - 1 && cls.qw.netchan.incoming_sequence + i < cls.qw.netchan.outgoing_sequence; i++) {
    to = cl.qw.frames[(cls.qw.netchan.incoming_sequence + i) & UPDATE_MASK];
    CL_PredictUsercmd(from.playerstate[cl.qw.playernum], to.playerstate[cl.qw.playernum], to.cmd, cl.qw.spectator !== 0);
    if (to.senttime >= cl.time) break;
    from = to;
  }

  pmove.numphysent = oldphysent;

  if (i === UPDATE_BACKUP - 1 || !to) return; // net hasn't deliver packets in a long time...

  // now interpolate some fraction of the final frame
  let f: number;
  if (to.senttime === from.senttime) f = 0;
  else {
    f = (cl.time - from.senttime) / (to.senttime - from.senttime);

    if (f < 0) f = 0;
    if (f > 1) f = 1;
  }

  for (i = 0; i < 3; i++) {
    if (Math.abs(from.playerstate[cl.qw.playernum].origin[i] - to.playerstate[cl.qw.playernum].origin[i]) > 128) {
      // teleported, so don't lerp
      VectorCopy(to.playerstate[cl.qw.playernum].velocity, cl.qw.simvel);
      VectorCopy(to.playerstate[cl.qw.playernum].origin, cl.qw.simorg);
      return;
    }
  }

  for (i = 0; i < 3; i++) {
    cl.qw.simorg[i] =
      from.playerstate[cl.qw.playernum].origin[i] +
      f * (to.playerstate[cl.qw.playernum].origin[i] - from.playerstate[cl.qw.playernum].origin[i]);
    cl.qw.simvel[i] =
      from.playerstate[cl.qw.playernum].velocity[i] +
      f * (to.playerstate[cl.qw.playernum].velocity[i] - from.playerstate[cl.qw.playernum].velocity[i]);
  }
}

/*
==============
CL_InitPrediction
==============
*/
export function CL_InitPrediction(): void {
  Cvar_RegisterVariable(cl_pushlatency);
  Cvar_RegisterVariable(cl_nopred);
}

// `usercmd_t split = *u;` / `pmove.cmd = *u;` struct assignments. QwUsercmdT
// (src/qw/protocol.ts, out of this unit's SCOPE) has no copy method.
function copyUsercmd(from: QwUsercmdT, to: QwUsercmdT): void {
  to.msec = from.msec;
  to.angles[0] = from.angles[0];
  to.angles[1] = from.angles[1];
  to.angles[2] = from.angles[2];
  to.forwardmove = from.forwardmove;
  to.sidemove = from.sidemove;
  to.upmove = from.upmove;
  to.buttons = from.buttons;
  to.impulse = from.impulse;
}
