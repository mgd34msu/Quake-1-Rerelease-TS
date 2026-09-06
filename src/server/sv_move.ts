/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sv_move.c (GNU GPL v2 or later).

sv_move.c -- monster movement

Deviations from PORTING.md / the C source:
- `PF_changeyaw` is forward-declared inside sv_move.c itself and called
  directly from SV_StepDirection, bypassing the builtin table. pr_cmds.ts
  exports it for exactly this call site.
- `c_yes`/`c_no` (`int c_yes, c_no;` at file scope in the C, referenced only
  inside this file) become `svMoveCounters.c_yes`/`.c_no`, a small exported
  holder object -- the same pattern server.ts uses for `svState.host_client`
  -- so tests can observe them without a reassignable module-level binding.
- `STEPSIZE` and `DI_NODIR` are `#define`s local to this C file (sv_phys.c
  has its own separate `STEPSIZE`); ported as unexported module-local
  `const`s rather than exported names.
- `rand()` (stdlib, via `<stdlib.h>`) has no project-wide helper (mathlib.ts's
  own header comment: "Quake's [random helpers] are QuakeC builtins... None
  are invented here"). Ruling for this unit: a file-private `rand()` =
  `Math.floor(Math.random() * 0x8000)`, matching stdlib rand()'s [0, RAND_MAX]
  range with RAND_MAX = 0x7fff on the reference toolchain.
- `enemy == sv.edicts` / `!= sv.edicts` (comparing an edict pointer against
  the pointer to edict 0, the world edict, C's "no entity" sentinel) becomes
  `... === EDICT_NUM(0)` / `!== EDICT_NUM(0)`, the same idiom already used by
  the landed pr_exec.ts/pr_edict.ts for this exact C pattern.
- `(int)ent->v.flags & FLAG` truncations and their use as a boolean each get
  an explicit `!== 0` per PORTING.md's "C truthiness on ints/pointers made
  explicit" rule, rather than relying on JS's own truthiness of a nonzero
  bitwise-and result.
- Dropped `#ifdef QUAKE2` block in SV_MoveToGoal (never defined in a
  WinQuake build, per PORTING.md): the QUAKE2-only `enemy` local and its
  alternate `SV_CloseEnough` call against `enemy` instead of `goal`.
*/

import { PF_changeyaw } from "../progs/pr_cmds";
import { type EdictT, pr, PROG_TO_EDICT, EDICT_TO_PROG, EDICT_NUM, G_FLOAT } from "../progs/progs";
import type { GlobalVars } from "../progs/progdefs";
import { OFS_PARM0, OFS_RETURN } from "../progs/pr_comp";
import { SV_Move, SV_LinkEdict, SV_PointContents, MOVE_NORMAL, MOVE_NOMONSTERS, type TraceT } from "./world";
import { FL_FLY, FL_SWIM, FL_ONGROUND, FL_PARTIALGROUND } from "./server";
import { type Vec3, vec3, vec3_origin, anglemod, VectorCopy, VectorAdd, M_PI } from "../common/mathlib";
import { YAW } from "../common/quakedef";
import { CONTENTS_SOLID, CONTENTS_EMPTY } from "../common/bspfile";
import { SysError } from "../platform/sys";

const STEPSIZE = 18;
const DI_NODIR = -1;

// see file header's deviation note.
export const svMoveCounters = { c_yes: 0, c_no: 0 };

function requireGlobalStruct(): GlobalVars {
  if (pr.global_struct === null) throw new SysError("sv_move: progs not loaded");
  return pr.global_struct;
}

function requireGlobals(): { f: Float32Array; i: Int32Array } {
  if (pr.globals === null) throw new SysError("sv_move: progs not loaded");
  return pr.globals;
}

// see file header's deviation note.
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

/*
=============
SV_CheckBottom

Returns false if any part of the bottom of the entity is off an edge that
is not a staircase.

=============
*/
export function SV_CheckBottom(ent: EdictT): boolean {
  const mins = vec3();
  const maxs = vec3();
  const start = vec3();
  const stop = vec3();
  let trace: TraceT;

  VectorAdd(ent.v.origin, ent.v.mins, mins);
  VectorAdd(ent.v.origin, ent.v.maxs, maxs);

  // if all of the points under the corners are solid world, don't bother
  // with the tougher checks
  // the corners must be within 16 of the midpoint
  start[2] = mins[2] - 1;
  let needsRealcheck = false;
  cornerCheck: for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      start[0] = x ? maxs[0] : mins[0];
      start[1] = y ? maxs[1] : mins[1];
      if (SV_PointContents(start) !== CONTENTS_SOLID) {
        needsRealcheck = true;
        break cornerCheck;
      }
    }
  }

  if (!needsRealcheck) {
    svMoveCounters.c_yes++;
    return true; // we got out easy
  }

  // realcheck:
  svMoveCounters.c_no++;
  //
  // check it for real...
  //
  start[2] = mins[2];

  // the midpoint must be within 16 of the bottom
  start[0] = stop[0] = (mins[0] + maxs[0]) * 0.5;
  start[1] = stop[1] = (mins[1] + maxs[1]) * 0.5;
  stop[2] = start[2] - 2 * STEPSIZE;
  trace = SV_Move(start, vec3_origin, vec3_origin, stop, MOVE_NOMONSTERS, ent);

  if (trace.fraction === 1.0) return false;
  let mid = trace.endpos[2];
  let bottom = mid;

  // the corners must be within 16 of the midpoint
  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      start[0] = stop[0] = x ? maxs[0] : mins[0];
      start[1] = stop[1] = y ? maxs[1] : mins[1];

      trace = SV_Move(start, vec3_origin, vec3_origin, stop, MOVE_NOMONSTERS, ent);

      if (trace.fraction !== 1.0 && trace.endpos[2] > bottom) bottom = trace.endpos[2];
      if (trace.fraction === 1.0 || mid - trace.endpos[2] > STEPSIZE) return false;
    }
  }

  svMoveCounters.c_yes++;
  return true;
}

/*
=============
SV_movestep

Called by monster program code.
The move will be adjusted for slopes and stairs, but if the move isn't
possible, no move is done, false is returned, and
pr_global_struct->trace_normal is set to the normal of the blocking wall
=============
*/
export function SV_movestep(ent: EdictT, move: Vec3, relink: boolean): boolean {
  const oldorg = vec3();
  const neworg = vec3();
  const end = vec3();
  let trace: TraceT;

  // try the move
  VectorCopy(ent.v.origin, oldorg);
  VectorAdd(ent.v.origin, move, neworg);

  // flying monsters don't step up
  if (((ent.v.flags | 0) & (FL_SWIM | FL_FLY)) !== 0) {
    // try one move with vertical motion, then one without
    for (let i = 0; i < 2; i++) {
      VectorAdd(ent.v.origin, move, neworg);
      const enemy = PROG_TO_EDICT(ent.v.enemy);
      if (i === 0 && enemy !== EDICT_NUM(0)) {
        const dz = ent.v.origin[2] - PROG_TO_EDICT(ent.v.enemy).v.origin[2];
        if (dz > 40) neworg[2] -= 8;
        if (dz < 30) neworg[2] += 8;
      }
      trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, neworg, MOVE_NORMAL, ent);

      if (trace.fraction === 1) {
        if (((ent.v.flags | 0) & FL_SWIM) !== 0 && SV_PointContents(trace.endpos) === CONTENTS_EMPTY) return false; // swim monster left water

        VectorCopy(trace.endpos, ent.v.origin);
        if (relink) SV_LinkEdict(ent, true);
        return true;
      }

      if (enemy === EDICT_NUM(0)) break;
    }

    return false;
  }

  // push down from a step height above the wished position
  neworg[2] += STEPSIZE;
  VectorCopy(neworg, end);
  end[2] -= STEPSIZE * 2;

  trace = SV_Move(neworg, ent.v.mins, ent.v.maxs, end, MOVE_NORMAL, ent);

  if (trace.allsolid) return false;

  if (trace.startsolid) {
    neworg[2] -= STEPSIZE;
    trace = SV_Move(neworg, ent.v.mins, ent.v.maxs, end, MOVE_NORMAL, ent);
    if (trace.allsolid || trace.startsolid) return false;
  }
  if (trace.fraction === 1) {
    // if monster had the ground pulled out, go ahead and fall
    if (((ent.v.flags | 0) & FL_PARTIALGROUND) !== 0) {
      VectorAdd(ent.v.origin, move, ent.v.origin);
      if (relink) SV_LinkEdict(ent, true);
      ent.v.flags = (ent.v.flags | 0) & ~FL_ONGROUND;
      // Con_Printf ("fall down\n");
      return true;
    }

    return false; // walked off an edge
  }

  // check point traces down for dangling corners
  VectorCopy(trace.endpos, ent.v.origin);

  if (!SV_CheckBottom(ent)) {
    if (((ent.v.flags | 0) & FL_PARTIALGROUND) !== 0) {
      // entity had floor mostly pulled out from underneath it
      // and is trying to correct
      if (relink) SV_LinkEdict(ent, true);
      return true;
    }
    VectorCopy(oldorg, ent.v.origin);
    return false;
  }

  if (((ent.v.flags | 0) & FL_PARTIALGROUND) !== 0) {
    // Con_Printf ("back on ground\n");
    ent.v.flags = (ent.v.flags | 0) & ~FL_PARTIALGROUND;
  }
  if (trace.ent === null) throw new SysError("SV_movestep: trace.ent is null after a fractional-length move");
  ent.v.groundentity = EDICT_TO_PROG(trace.ent);

  // the move is ok
  if (relink) SV_LinkEdict(ent, true);
  return true;
}

//============================================================================

/*
======================
SV_StepDirection

Turns to the movement direction, and walks the current distance if
facing it.

======================
*/
export function SV_StepDirection(ent: EdictT, yaw: number, dist: number): boolean {
  const move = vec3();
  const oldorigin = vec3();

  ent.v.ideal_yaw = yaw;
  PF_changeyaw();

  yaw = (yaw * M_PI * 2) / 360;
  move[0] = Math.cos(yaw) * dist;
  move[1] = Math.sin(yaw) * dist;
  move[2] = 0;

  VectorCopy(ent.v.origin, oldorigin);
  if (SV_movestep(ent, move, false)) {
    const delta = ent.v.angles[YAW] - ent.v.ideal_yaw;
    if (delta > 45 && delta < 315) {
      // not turned far enough, so don't take the step
      VectorCopy(oldorigin, ent.v.origin);
    }
    SV_LinkEdict(ent, true);
    return true;
  }
  SV_LinkEdict(ent, true);

  return false;
}

/*
======================
SV_FixCheckBottom

======================
*/
export function SV_FixCheckBottom(ent: EdictT): void {
  // Con_Printf ("SV_FixCheckBottom\n");

  ent.v.flags = (ent.v.flags | 0) | FL_PARTIALGROUND;
}

/*
================
SV_NewChaseDir

================
*/
export function SV_NewChaseDir(actor: EdictT, enemy: EdictT, dist: number): void {
  const d: number[] = [0, 0, 0];

  const olddir = anglemod(Math.trunc(actor.v.ideal_yaw / 45) * 45);
  const turnaround = anglemod(olddir - 180);

  const deltax = enemy.v.origin[0] - actor.v.origin[0];
  const deltay = enemy.v.origin[1] - actor.v.origin[1];
  if (deltax > 10) d[1] = 0;
  else if (deltax < -10) d[1] = 180;
  else d[1] = DI_NODIR;
  if (deltay < -10) d[2] = 270;
  else if (deltay > 10) d[2] = 90;
  else d[2] = DI_NODIR;

  // try direct route
  if (d[1] !== DI_NODIR && d[2] !== DI_NODIR) {
    let tdir: number;
    if (d[1] === 0) tdir = d[2] === 90 ? 45 : 315;
    else tdir = d[2] === 90 ? 135 : 215;

    if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist)) return;
  }

  // try other directions
  if (((rand() & 3) & 1) !== 0 || Math.abs(deltay) > Math.abs(deltax)) {
    const tdir = d[1];
    d[1] = d[2];
    d[2] = tdir;
  }

  if (d[1] !== DI_NODIR && d[1] !== turnaround && SV_StepDirection(actor, d[1], dist)) return;

  if (d[2] !== DI_NODIR && d[2] !== turnaround && SV_StepDirection(actor, d[2], dist)) return;

  /* there is no direct path to the player, so pick another direction */

  if (olddir !== DI_NODIR && SV_StepDirection(actor, olddir, dist)) return;

  if ((rand() & 1) !== 0) {
    /*randomly determine direction of search*/
    for (let tdir = 0; tdir <= 315; tdir += 45) {
      if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist)) return;
    }
  } else {
    for (let tdir = 315; tdir >= 0; tdir -= 45) {
      if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist)) return;
    }
  }

  if (turnaround !== DI_NODIR && SV_StepDirection(actor, turnaround, dist)) return;

  actor.v.ideal_yaw = olddir; // can't move

  // if a bridge was pulled out from underneath a monster, it may not have
  // a valid standing position at all

  if (!SV_CheckBottom(actor)) SV_FixCheckBottom(actor);
}

/*
======================
SV_CloseEnough

======================
*/
export function SV_CloseEnough(ent: EdictT, goal: EdictT, dist: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (goal.v.absmin[i] > ent.v.absmax[i] + dist) return false;
    if (goal.v.absmax[i] < ent.v.absmin[i] - dist) return false;
  }
  return true;
}

/*
======================
SV_MoveToGoal

======================
*/
export function SV_MoveToGoal(): void {
  const ent = PROG_TO_EDICT(requireGlobalStruct().self);
  const goal = PROG_TO_EDICT(ent.v.goalentity);
  const dist = G_FLOAT(OFS_PARM0);

  if (((ent.v.flags | 0) & (FL_ONGROUND | FL_FLY | FL_SWIM)) === 0) {
    requireGlobals().f[OFS_RETURN] = 0;
    return;
  }

  // if the next step hits the enemy, return immediately
  // dropped #ifdef QUAKE2 block (never defined in a WinQuake build): the
  // QUAKE2-only `enemy` local and its SV_CloseEnough(ent, enemy, dist) call.
  if (PROG_TO_EDICT(ent.v.enemy) !== EDICT_NUM(0) && SV_CloseEnough(ent, goal, dist)) return;

  // bump around...
  if ((rand() & 3) === 1 || !SV_StepDirection(ent, ent.v.ideal_yaw, dist)) {
    SV_NewChaseDir(ent, goal, dist);
  }
}
