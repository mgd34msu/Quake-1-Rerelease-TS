/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_cam.c (GNU GPL v2 or later).

ZOID

Player camera tracking in Spectator mode

This takes over player controls for spectator automatic camera.
Player moves as a spectator, but the camera tracks and enemy player

Deviations from PORTING.md / the C source:
- `autocam`, `spec_track` and `cam_forceview`/`cam_viewangles`/`cam_lastviewtime`
  are declared `extern` by QW/client/client.h and read by sbar.c and cl_input.c
  as well as here. They are exported `let` bindings (ESM live bindings, the
  same idiom src/qw/common.ts uses for `file_from_pak`/`com_basedir`): readers
  see every write this module makes, and only this module writes them.
- `memcmp(&desired_position, &self->origin, sizeof(desired_position)) != 0` is
  a byte comparison of three floats; ported as `VectorCompare(...) === 0`. The
  two differ only for +0.0 vs -0.0 and for NaN payloads, neither of which a
  coordinate read off the wire can produce.
- `#if 0` blocks (`Cam_DoTrace`'s pmove reset, `adjustang`, `Cam_SetView`,
  `Cam_FinishMove`'s camera-angle smoothing) and the two cvars they need
  (`cl_camera_maxpitch`, `cl_camera_maxyaw`, commented out in the C) are
  dropped, per PORTING.md's `#if 0` rule.
- `PM_SPECTATORMAXSPEED`/`PM_STOPSPEED`/`PM_MAXSPEED`/`MAX_ANGLE_TURN` are
  defined at the top of cl_cam.c and used by nothing in it; not ported.
*/

import { AngleVectors, M_PI, type Vec3, vec3, vec3_origin, VectorAdd, VectorCompare, VectorCopy, VectorMA, VectorNormalize, VectorSubtract } from "../../common/mathlib";
import { CactiveT, cl, cls } from "../../client/client";
import { Con_Printf } from "./console";
import { Sbar_Changed } from "../../client/sbar";
import { clMainState } from "./cl_main";
import { Com_sprintf } from "../../common/sprintf";
import { Cvar_RegisterVariable, CvarT } from "../../common/cvar";
import { MSG_WriteByte, MSG_WriteCoord, MSG_WriteString } from "../common";
import { ClcOpsT, MAX_CLIENTS, QwUsercmdT, UPDATE_MASK } from "../protocol";
import { pmove, type PmtraceT } from "../pmove_types";
import { PM_PlayerMove } from "../pmovetst";
import { CAM_NONE, CAM_TRACK, type PlayerStateT } from "./client";

const BUTTON_JUMP = 2;
const BUTTON_ATTACK = 1;

const desired_position: Vec3 = vec3(); // where the camera wants to be
let locked = false;
let oldbuttons = 0;

// track high fragger
export const cl_hightrack = new CvarT("cl_hightrack", "0");

export const cl_chasecam = new CvarT("cl_chasecam", "0");

export let cam_forceview = false;
export const cam_viewangles: Vec3 = vec3();
export let cam_lastviewtime = 0;

export let spec_track = 0; // player# of who we are tracking
export let autocam = CAM_NONE;

function vectoangles(vec: Vec3, ang: Vec3): void {
  let yaw: number;
  let pitch: number;

  if (vec[1] === 0 && vec[0] === 0) {
    yaw = 0;
    if (vec[2] > 0) pitch = 90;
    else pitch = 270;
  } else {
    yaw = Math.trunc((Math.atan2(vec[1], vec[0]) * 180) / M_PI);
    if (yaw < 0) yaw += 360;

    const forward = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]);
    pitch = Math.trunc((Math.atan2(vec[2], forward) * 180) / M_PI);
    if (pitch < 0) pitch += 360;
  }

  ang[0] = pitch;
  ang[1] = yaw;
  ang[2] = 0;
}

function vlen(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// returns true if weapon model should be drawn in camera mode
export function Cam_DrawViewModel(): boolean {
  if (!cl.qw.spectator) return true;

  if (autocam && locked && cl_chasecam.value) return true;
  return false;
}

// returns true if we should draw this player, we don't if we are chase camming
export function Cam_DrawPlayer(playernum: number): boolean {
  if (cl.qw.spectator && autocam && locked && cl_chasecam.value && spec_track === playernum) return false;
  return true;
}

export function Cam_Unlock(): void {
  if (autocam) {
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    MSG_WriteString(cls.qw.netchan.message, "ptrack");
    autocam = CAM_NONE;
    locked = false;
    Sbar_Changed();
  }
}

export function Cam_Lock(playernum: number): void {
  const st = Com_sprintf("ptrack %i", playernum);
  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
  MSG_WriteString(cls.qw.netchan.message, st);
  spec_track = playernum;
  cam_forceview = true;
  locked = false;
  Sbar_Changed();
}

export function Cam_DoTrace(vec1: Vec3, vec2: Vec3): PmtraceT {
  VectorCopy(vec1, pmove.origin);
  return PM_PlayerMove(pmove.origin, vec2);
}

// Returns distance or 9999 if invalid for some reason
function Cam_TryFlyby(self: PlayerStateT, player: PlayerStateT, vec: Vec3, checkvis: boolean): number {
  const v: Vec3 = vec3();

  vectoangles(vec, v);
  //	v[0] = -v[0];
  VectorCopy(v, pmove.angles);
  VectorNormalize(vec);
  VectorMA(player.origin, 800, vec, v);
  // v is endpos
  // fake a player move
  let trace = Cam_DoTrace(player.origin, v);
  if (/*trace.inopen ||*/ trace.inwater) return 9999;
  VectorCopy(trace.endpos, vec);
  VectorSubtract(trace.endpos, player.origin, v);
  let len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 32 || len > 800) return 9999;
  if (checkvis) {
    VectorSubtract(trace.endpos, self.origin, v);
    len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

    trace = Cam_DoTrace(self.origin, vec);
    if (trace.fraction !== 1 || trace.inwater) return 9999;
  }
  return len;
}

// Is player visible?
function Cam_IsVisible(player: PlayerStateT, vec: Vec3): boolean {
  const v: Vec3 = vec3();

  const trace = Cam_DoTrace(player.origin, vec);
  if (trace.fraction !== 1 || /*trace.inopen ||*/ trace.inwater) return false;
  // check distance, don't let the player get too far away or too close
  VectorSubtract(player.origin, vec, v);
  const d = vlen(v);
  if (d < 16) return false;
  return true;
}

function InitFlyby(self: PlayerStateT, player: PlayerStateT, checkvis: boolean): boolean {
  let f: number;
  const vec: Vec3 = vec3();
  const vec2: Vec3 = vec3();
  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();

  VectorCopy(player.viewangles, vec);
  vec[0] = 0;
  AngleVectors(vec, forward, right, up);

  let max = 1000;
  VectorAdd(forward, up, vec2);
  VectorAdd(vec2, right, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorAdd(forward, up, vec2);
  VectorSubtract(vec2, right, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorAdd(forward, right, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorSubtract(forward, right, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorAdd(forward, up, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorSubtract(forward, up, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorAdd(up, right, vec2);
  VectorSubtract(vec2, forward, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorSubtract(up, right, vec2);
  VectorSubtract(vec2, forward, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  // invert
  VectorSubtract(vec3_origin, forward, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorCopy(forward, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  // invert
  VectorSubtract(vec3_origin, right, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }
  VectorCopy(right, vec2);
  if ((f = Cam_TryFlyby(self, player, vec2, checkvis)) < max) {
    max = f;
    VectorCopy(vec2, vec);
  }

  // ack, can't find him
  if (max >= 1000) {
    //		Cam_Unlock();
    return false;
  }
  locked = true;
  VectorCopy(vec, desired_position);
  return true;
}

function Cam_CheckHighTarget(): void {
  let j = -1;
  let max = -9999;
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const s = cl.qw.players[i];
    if (s.name.length !== 0 && !s.spectator && s.frags > max) {
      max = s.frags;
      j = i;
    }
  }
  if (j >= 0) {
    if (!locked || cl.qw.players[j].frags > cl.qw.players[spec_track].frags) Cam_Lock(j);
  } else Cam_Unlock();
}

// ZOID
//
// Take over the user controls and track a player.
// We find a nice position to watch the player and move there
export function Cam_Track(cmd: QwUsercmdT): void {
  const vec: Vec3 = vec3();

  if (!cl.qw.spectator) return;

  if (cl_hightrack.value && !locked) Cam_CheckHighTarget();

  if (!autocam || cls.state !== CactiveT.ca_active) return;

  if (locked && (cl.qw.players[spec_track].name.length === 0 || cl.qw.players[spec_track].spectator)) {
    locked = false;
    if (cl_hightrack.value) Cam_CheckHighTarget();
    else Cam_Unlock();
    return;
  }

  const frame = cl.qw.frames[cls.qw.netchan.incoming_sequence & UPDATE_MASK];
  const player = frame.playerstate[spec_track];
  const self = frame.playerstate[cl.qw.playernum];

  if (!locked || !Cam_IsVisible(player, desired_position)) {
    if (!locked || clMainState.realtime - cam_lastviewtime > 0.1) {
      if (!InitFlyby(self, player, true)) InitFlyby(self, player, false);
      cam_lastviewtime = clMainState.realtime;
    }
  } else cam_lastviewtime = clMainState.realtime;

  // couldn't track for some reason
  if (!locked || !autocam) return;

  if (cl_chasecam.value) {
    cmd.forwardmove = cmd.sidemove = cmd.upmove = 0;

    VectorCopy(player.viewangles, cl.viewangles);
    VectorCopy(player.origin, desired_position);
    if (VectorCompare(desired_position, self.origin) === 0) {
      MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_tmove);
      MSG_WriteCoord(cls.qw.netchan.message, desired_position[0]);
      MSG_WriteCoord(cls.qw.netchan.message, desired_position[1]);
      MSG_WriteCoord(cls.qw.netchan.message, desired_position[2]);
      // move there locally immediately
      VectorCopy(desired_position, self.origin);
    }
    self.weaponframe = player.weaponframe;
  } else {
    // Ok, move to our desired position and set our angles to view
    // the player
    VectorSubtract(desired_position, self.origin, vec);
    const len = vlen(vec);
    cmd.forwardmove = cmd.sidemove = cmd.upmove = 0;
    if (len > 16) {
      // close enough?
      MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_tmove);
      MSG_WriteCoord(cls.qw.netchan.message, desired_position[0]);
      MSG_WriteCoord(cls.qw.netchan.message, desired_position[1]);
      MSG_WriteCoord(cls.qw.netchan.message, desired_position[2]);
    }

    // move there locally immediately
    VectorCopy(desired_position, self.origin);

    VectorSubtract(player.origin, desired_position, vec);
    vectoangles(vec, cl.viewangles);
    cl.viewangles[0] = -cl.viewangles[0];
  }
}

export function Cam_FinishMove(cmd: QwUsercmdT): void {
  let i: number;
  let end: number;

  if (cls.state !== CactiveT.ca_active) return;

  if (!cl.qw.spectator) return; // only in spectator mode

  if (cmd.buttons & BUTTON_ATTACK) {
    if (!(oldbuttons & BUTTON_ATTACK)) {
      oldbuttons |= BUTTON_ATTACK;
      autocam++;

      if (autocam > CAM_TRACK) {
        Cam_Unlock();
        VectorCopy(cl.viewangles, cmd.angles);
        return;
      }
    } else return;
  } else {
    oldbuttons &= ~BUTTON_ATTACK;
    if (!autocam) return;
  }

  if (autocam && cl_hightrack.value) {
    Cam_CheckHighTarget();
    return;
  }

  if (locked) {
    if (cmd.buttons & BUTTON_JUMP && oldbuttons & BUTTON_JUMP) return; // don't pogo stick

    if (!(cmd.buttons & BUTTON_JUMP)) {
      oldbuttons &= ~BUTTON_JUMP;
      return;
    }
    oldbuttons |= BUTTON_JUMP; // don't jump again until released
  }

  if (locked && autocam) end = (spec_track + 1) % MAX_CLIENTS;
  else end = spec_track;
  i = end;
  do {
    const s = cl.qw.players[i];
    if (s.name.length !== 0 && !s.spectator) {
      Cam_Lock(i);
      return;
    }
    i = (i + 1) % MAX_CLIENTS;
  } while (i !== end);
  // stay on same guy?
  i = spec_track;
  const s = cl.qw.players[i];
  if (s.name.length !== 0 && !s.spectator) {
    Cam_Lock(i);
    return;
  }
  Con_Printf("No target found ...\n");
  locked = false;
  autocam = 0;
}

export function Cam_Reset(): void {
  autocam = CAM_NONE;
  spec_track = 0;
}

export function CL_InitCam(): void {
  Cvar_RegisterVariable(cl_hightrack);
  Cvar_RegisterVariable(cl_chasecam);
  //	Cvar_RegisterVariable (&cl_camera_maxpitch);
  //	Cvar_RegisterVariable (&cl_camera_maxyaw);
}
