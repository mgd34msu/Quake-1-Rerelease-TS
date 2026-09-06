/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sv_phys.c (GNU GPL v2 or later).

sv_phys.c -- server entity physics

pushmove objects do not obey gravity, and do not interact with each other or
trigger fields, but block normal movement and push normal objects when they
move.

onground is set for toss objects when they come to a complete rest.  it is
set for steping or walking objects

doors, plats, etc are SOLID_BSP, and MOVETYPE_PUSH
bonus items are SOLID_TRIGGER touch, and MOVETYPE_TOSS
corpses are SOLID_NOT and MOVETYPE_TOSS
crates are SOLID_BBOX and MOVETYPE_TOSS
walking monsters are SOLID_SLIDEBOX and MOVETYPE_STEP
flying/floating monsters are SOLID_SLIDEBOX and MOVETYPE_FLY

solid_edge items only clip against bsp models.

Deviations from PORTING.md / the C source:
- `ClipVelocity`'s C parameter name `in` (`vec3_t in`) is a reserved word in
  TypeScript (used by `for...in`/the `in` operator); renamed `inVec` at the
  parameter and every call site. No other renames.
- `SV_AddGravity`'s `#else` (non-QUAKE2) path reads the QuakeC-declared
  "gravity" field through `GetEdictFieldValue`/`E_FLOAT` (pr_edict.ts,
  progs.ts) exactly as the C's `eval_t *val` does: `GetEdictFieldValue`
  returns the field's word offset (or -1) instead of an `eval_t *`, so
  `if (val && val->_float)` becomes `if (ofs >= 0 && E_FLOAT(ent, ofs) !== 0)`.
- `*steptrace = trace;` (SV_FlyMove) and `*steptrace = trace` (SV_WalkMove's
  friend calls) are C struct-assignment copies into a caller-owned
  `trace_t*` out-param. This port has no struct assignment operator, so a
  local `copyTraceInto(dst, src)` copies every `TraceT` field (deep for the
  nested `plane`) to match.
- Four call sites read `trace.ent`/`downtrace.ent` unconditionally after a
  branch that is only reached because the trace hit something (SV_FlyMove
  already throws `SysError` on `!trace.ent` before its own two later uses;
  SV_WalkMove's downward step trace and SV_Physics_Toss's ground-stop trace
  have no equivalent C null check because the C never checks the pointer
  there). This port adds the same explicit `SysError` guard world.ts already
  uses for other pointer-can't-really-be-null spots ("this only changes
  behavior on a call sequence that would already have been a C crash"),
  because `trace.ent: EdictT | null`'s type otherwise cannot be narrowed.
- `moved_edict[MAX_EDICTS]`/`moved_from[MAX_EDICTS]` (SV_PushMove) are
  C automatic (stack) arrays, freshly zeroed on every call. Per the unit
  brief they become module-level arrays sized `MAX_EDICTS` here instead of
  being reallocated every SV_PushMove call; only the entries touched during
  a call (indices `0..num_moved-1`) are ever read back, so the stale tail
  from a previous call is never observed, matching the C's own
  read-only-what-you-wrote-this-call discipline.
- `SV_StartSound` is imported from "./sv_main" (U031, concurrent with this
  unit). If that module is not yet landed, `bun run check`'s only failure
  from this file is `Cannot find module './sv_main'` (plus the re-exported
  name `SV_StartSound`).
- `MOVE_EPSILON` (0.01) is ported as an exported constant even though the C
  never references it anywhere in sv_phys.c (grep confirms) -- already dead
  code in the original.

Dropped `#ifdef QUAKE2` blocks (WinQuake never defines QUAKE2; PORTING.md's
"take the portable path" rule):
- The file-scope `static vec3_t vec_origin` (unused outside QUAKE2 code).
- SV_CheckAllEnts's and SV_PushMove's `check->v.movetype == MOVETYPE_FOLLOW`
  skip-arm.
- SV_AddGravity's `ent->v.gravity` branch (the non-QUAKE2 `eval_t`/
  GetEdictFieldValue path is the one this port runs).
- SV_PushRotate (the entire function) and SV_Physics_Pusher's
  avelocity-driven call to it.
- SV_CheckWater's `truecont`/`SV_TruePointContents` read and the
  CONTENTS_CURRENT_* -> ent->v.basevelocity current-push block.
- SV_Physics_Follow (the entire function) and SV_Physics's
  `MOVETYPE_FOLLOW` dispatch arm.
- SV_CheckWaterTransition's QUAKE2 point-offset content sample (kept the
  non-QUAKE2 `SV_PointContents(ent->v.origin)` sample).
- SV_Physics_Toss's entire QUAKE2 half: the groundentity/FL_CONVEYOR
  basevelocity setup, the `SV_CheckWater` pre-check, the
  `VectorCompare(ent->v.basevelocity, vec_origin)` early return, the
  MOVETYPE_BOUNCEMISSILE/MOVETYPE_FLYMISSILE gravity exemptions, and the
  MOVETYPE_BOUNCEMISSILE backoff/ground-stop velocity variants.
- SV_Physics_Step's entire QUAKE2 version (PF_WaterMove, basevelocity,
  friction-while-onground, the four-corner CONTENTS_SOLID ground probe);
  the non-QUAKE2 version is the one ported.
- SV_Physics's `MOVETYPE_BOUNCEMISSILE` dispatch arm.
- SV_Trace_Toss (the entire function, `#ifdef QUAKE2`-guarded).
*/

import {
  EdictT,
  EDICT_TO_PROG,
  PROG_TO_EDICT,
  pr,
  PR_GetString,
  E_FLOAT,
} from "../progs/progs";
import type { GlobalVars } from "../progs/progdefs";
import { PR_ExecuteProgram } from "../progs/pr_exec";
import { GetEdictFieldValue } from "../progs/pr_edict";
import {
  sv,
  svs,
  svState,
  MOVETYPE_NONE,
  MOVETYPE_WALK,
  MOVETYPE_STEP,
  MOVETYPE_FLY,
  MOVETYPE_TOSS,
  MOVETYPE_PUSH,
  MOVETYPE_NOCLIP,
  MOVETYPE_FLYMISSILE,
  MOVETYPE_BOUNCE,
  SOLID_NOT,
  SOLID_TRIGGER,
  SOLID_BSP,
  FL_FLY,
  FL_SWIM,
  FL_ONGROUND,
  FL_WATERJUMP,
} from "./server";
import { SV_Move, SV_LinkEdict, SV_PointContents, SV_TestEntityPosition, TraceT, MOVE_NORMAL, MOVE_NOMONSTERS, MOVE_MISSILE } from "./world";
import { SV_StartSound } from "./sv_main";
import { CvarT } from "../common/cvar";
import { host } from "../common/host";
import {
  type Vec3,
  vec3,
  vec3_origin,
  IS_NAN,
  DotProduct,
  VectorAdd,
  VectorSubtract,
  VectorCopy,
  VectorScale,
  VectorMA,
  CrossProduct,
  AngleVectors,
} from "../common/mathlib";
import { CONTENTS_EMPTY, CONTENTS_WATER } from "../common/bspfile";
import { MAX_EDICTS } from "../common/quakedef";
import { Sys_Error, SysError } from "../platform/sys";
import { Con_Printf, Con_DPrintf } from "../client/console";

export const sv_friction = new CvarT("sv_friction", "4", false, true);
export const sv_stopspeed = new CvarT("sv_stopspeed", "100");
export const sv_gravity = new CvarT("sv_gravity", "800", false, true);
export const sv_maxvelocity = new CvarT("sv_maxvelocity", "2000");
export const sv_nostep = new CvarT("sv_nostep", "0");

export const MOVE_EPSILON = 0.01;

function requireGlobalStruct(): GlobalVars {
  if (pr.global_struct === null) throw new SysError("sv_phys: progs not loaded");
  return pr.global_struct;
}

function requireSvPlayer(): EdictT {
  if (svState.sv_player === null) throw new SysError("sv_phys: svState.sv_player not set");
  return svState.sv_player;
}

// `*steptrace = trace;` / `*dst = *src;` -- see file header's deviation note.
function copyTraceInto(dst: TraceT, src: TraceT): void {
  dst.allsolid = src.allsolid;
  dst.startsolid = src.startsolid;
  dst.inopen = src.inopen;
  dst.inwater = src.inwater;
  dst.fraction = src.fraction;
  VectorCopy(src.endpos, dst.endpos);
  VectorCopy(src.plane.normal, dst.plane.normal);
  dst.plane.dist = src.plane.dist;
  dst.ent = src.ent;
}

/*
================
SV_CheckAllEnts
================
*/
export function SV_CheckAllEnts(): void {
  // see if any solid entities are inside the final position
  for (let e = 1; e < sv.num_edicts; e++) {
    const check = sv.edicts[e];
    if (check.free) continue;
    if (check.v.movetype === MOVETYPE_PUSH || check.v.movetype === MOVETYPE_NONE || check.v.movetype === MOVETYPE_NOCLIP) continue;

    if (SV_TestEntityPosition(check) !== null) Con_Printf("entity in invalid position\n");
  }
}

/*
================
SV_CheckVelocity
================
*/
export function SV_CheckVelocity(ent: EdictT): void {
  //
  // bound velocity
  //
  for (let i = 0; i < 3; i++) {
    if (IS_NAN(ent.v.velocity[i])) {
      Con_Printf("Got a NaN velocity on %s\n", PR_GetString(ent.v.classname));
      ent.v.velocity[i] = 0;
    }
    if (IS_NAN(ent.v.origin[i])) {
      Con_Printf("Got a NaN origin on %s\n", PR_GetString(ent.v.classname));
      ent.v.origin[i] = 0;
    }
    if (ent.v.velocity[i] > sv_maxvelocity.value) ent.v.velocity[i] = sv_maxvelocity.value;
    else if (ent.v.velocity[i] < -sv_maxvelocity.value) ent.v.velocity[i] = -sv_maxvelocity.value;
  }
}

/*
=============
SV_RunThink

Runs thinking code if time.  There is some play in the exact time the think
function will be called, because it is called before any movement is done
in a frame.  Not used for pushmove objects, because they must be exact.
Returns false if the entity removed itself.
=============
*/
export function SV_RunThink(ent: EdictT): boolean {
  let thinktime = ent.v.nextthink;
  if (thinktime <= 0 || thinktime > sv.time + host.frametime) return true;

  if (thinktime < sv.time) thinktime = sv.time; // don't let things stay in the past.
  // it is possible to start that way
  // by a trigger with a local time.
  ent.v.nextthink = 0;
  const globals = requireGlobalStruct();
  globals.time = thinktime;
  globals.self = EDICT_TO_PROG(ent);
  globals.other = EDICT_TO_PROG(sv.edicts[0]);
  PR_ExecuteProgram(ent.v.think);
  return !ent.free;
}

/*
==================
SV_Impact

Two entities have touched, so run their touch functions
==================
*/
export function SV_Impact(e1: EdictT, e2: EdictT): void {
  const globals = requireGlobalStruct();
  const old_self = globals.self;
  const old_other = globals.other;

  globals.time = sv.time;
  if (e1.v.touch !== 0 && e1.v.solid !== SOLID_NOT) {
    globals.self = EDICT_TO_PROG(e1);
    globals.other = EDICT_TO_PROG(e2);
    PR_ExecuteProgram(e1.v.touch);
  }

  if (e2.v.touch !== 0 && e2.v.solid !== SOLID_NOT) {
    globals.self = EDICT_TO_PROG(e2);
    globals.other = EDICT_TO_PROG(e1);
    PR_ExecuteProgram(e2.v.touch);
  }

  globals.self = old_self;
  globals.other = old_other;
}

/*
==================
ClipVelocity

Slide off of the impacting object
returns the blocked flags (1 = floor, 2 = step / wall)
==================
*/
export const STOP_EPSILON = 0.1;

export function ClipVelocity(inVec: Vec3, normal: Vec3, out: Vec3, overbounce: number): number {
  let blocked = 0;
  if (normal[2] > 0) blocked |= 1; // floor
  if (!normal[2]) blocked |= 2; // step

  const backoff = DotProduct(inVec, normal) * overbounce;

  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = inVec[i] - change;
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) out[i] = 0;
  }

  return blocked;
}

/*
============
SV_FlyMove

The basic solid body movement clip that slides along multiple planes
Returns the clipflags if the velocity was modified (hit something solid)
1 = floor
2 = wall / step
4 = dead stop
If steptrace is not NULL, the trace of any vertical wall hit will be stored
============
*/
export const MAX_CLIP_PLANES = 5;

export function SV_FlyMove(ent: EdictT, time: number, steptrace: TraceT | null): number {
  const numbumps = 4;

  let blocked = 0;
  const original_velocity = vec3();
  const primal_velocity = vec3();
  VectorCopy(ent.v.velocity, original_velocity);
  VectorCopy(ent.v.velocity, primal_velocity);
  let numplanes = 0;

  const planes: Vec3[] = Array.from({ length: MAX_CLIP_PLANES }, () => vec3());

  let time_left = time;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    if (!ent.v.velocity[0] && !ent.v.velocity[1] && !ent.v.velocity[2]) break;

    const end = vec3();
    for (let i = 0; i < 3; i++) end[i] = ent.v.origin[i] + time_left * ent.v.velocity[i];

    const trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, end, MOVE_NORMAL, ent);

    if (trace.allsolid) {
      // entity is trapped in another solid
      VectorCopy(vec3_origin, ent.v.velocity);
      return 3;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, ent.v.origin);
      VectorCopy(ent.v.velocity, original_velocity);
      numplanes = 0;
    }

    if (trace.fraction === 1) break; // moved the entire distance

    if (trace.ent === null) Sys_Error("SV_FlyMove: !trace.ent");
    const traceEnt = trace.ent;

    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1; // floor
      if (traceEnt.v.solid === SOLID_BSP) {
        ent.v.flags = (ent.v.flags | 0) | FL_ONGROUND;
        ent.v.groundentity = EDICT_TO_PROG(traceEnt);
      }
    }
    if (!trace.plane.normal[2]) {
      blocked |= 2; // step
      if (steptrace !== null) copyTraceInto(steptrace, trace); // save for player extrafriction
    }

    //
    // run the impact function
    //
    SV_Impact(ent, traceEnt);
    if (ent.free) break; // removed by the impact function

    time_left -= time_left * trace.fraction;

    // cliped to another plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      VectorCopy(vec3_origin, ent.v.velocity);
      return 3;
    }

    VectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    //
    // modify original_velocity so it parallels all of the clip planes
    //
    const new_velocity = vec3();
    let i = 0;
    for (i = 0; i < numplanes; i++) {
      ClipVelocity(original_velocity, planes[i], new_velocity, 1);
      let j = 0;
      for (j = 0; j < numplanes; j++) {
        if (j !== i) {
          if (DotProduct(new_velocity, planes[j]) < 0) break; // not ok
        }
      }
      if (j === numplanes) break;
    }

    if (i !== numplanes) {
      // go along this plane
      VectorCopy(new_velocity, ent.v.velocity);
    } else {
      // go along the crease
      if (numplanes !== 2) {
        // Con_Printf ("clip velocity, numplanes == %i\n",numplanes);
        VectorCopy(vec3_origin, ent.v.velocity);
        return 7;
      }
      const dir = vec3();
      CrossProduct(planes[0], planes[1], dir);
      const d = DotProduct(dir, ent.v.velocity);
      VectorScale(dir, d, ent.v.velocity);
    }

    //
    // if original velocity is against the original velocity, stop dead
    // to avoid tiny occilations in sloping corners
    //
    if (DotProduct(ent.v.velocity, primal_velocity) <= 0) {
      VectorCopy(vec3_origin, ent.v.velocity);
      return blocked;
    }
  }

  return blocked;
}

/*
============
SV_AddGravity

============
*/
export function SV_AddGravity(ent: EdictT): void {
  let ent_gravity: number;

  const ofs = GetEdictFieldValue(ent, "gravity");
  if (ofs >= 0 && E_FLOAT(ent, ofs) !== 0) ent_gravity = E_FLOAT(ent, ofs);
  else ent_gravity = 1.0;

  ent.v.velocity[2] -= ent_gravity * sv_gravity.value * host.frametime;
}

/*
===============================================================================

PUSHMOVE

===============================================================================
*/

/*
============
SV_PushEntity

Does not change the entities velocity at all
============
*/
export function SV_PushEntity(ent: EdictT, push: Vec3): TraceT {
  const end = vec3();
  VectorAdd(ent.v.origin, push, end);

  let trace: TraceT;
  if (ent.v.movetype === MOVETYPE_FLYMISSILE) trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, end, MOVE_MISSILE, ent);
  else if (ent.v.solid === SOLID_TRIGGER || ent.v.solid === SOLID_NOT)
    // only clip against bmodels
    trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, end, MOVE_NOMONSTERS, ent);
  else trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, end, MOVE_NORMAL, ent);

  VectorCopy(trace.endpos, ent.v.origin);
  SV_LinkEdict(ent, true);

  if (trace.ent !== null) SV_Impact(ent, trace.ent);

  return trace;
}

/*
============
SV_PushMove

============
*/
// C automatic (stack) arrays -- see file header's deviation note.
const moved_edict: Array<EdictT | null> = new Array<EdictT | null>(MAX_EDICTS).fill(null);
const moved_from: Vec3[] = Array.from({ length: MAX_EDICTS }, () => vec3());

export function SV_PushMove(pusher: EdictT, movetime: number): void {
  if (!pusher.v.velocity[0] && !pusher.v.velocity[1] && !pusher.v.velocity[2]) {
    pusher.v.ltime += movetime;
    return;
  }

  const move = vec3();
  const mins = vec3();
  const maxs = vec3();
  for (let i = 0; i < 3; i++) {
    move[i] = pusher.v.velocity[i] * movetime;
    mins[i] = pusher.v.absmin[i] + move[i];
    maxs[i] = pusher.v.absmax[i] + move[i];
  }

  const pushorig = vec3();
  VectorCopy(pusher.v.origin, pushorig);

  // move the pusher to it's final position

  VectorAdd(pusher.v.origin, move, pusher.v.origin);
  pusher.v.ltime += movetime;
  SV_LinkEdict(pusher, false);

  // see if any solid entities are inside the final position
  let num_moved = 0;
  for (let e = 1; e < sv.num_edicts; e++) {
    const check = sv.edicts[e];
    if (check.free) continue;
    if (check.v.movetype === MOVETYPE_PUSH || check.v.movetype === MOVETYPE_NONE || check.v.movetype === MOVETYPE_NOCLIP) continue;

    // if the entity is standing on the pusher, it will definately be moved
    if (!(((check.v.flags | 0) & FL_ONGROUND) !== 0 && PROG_TO_EDICT(check.v.groundentity) === pusher)) {
      if (
        check.v.absmin[0] >= maxs[0] ||
        check.v.absmin[1] >= maxs[1] ||
        check.v.absmin[2] >= maxs[2] ||
        check.v.absmax[0] <= mins[0] ||
        check.v.absmax[1] <= mins[1] ||
        check.v.absmax[2] <= mins[2]
      )
        continue;

      // see if the ent's bbox is inside the pusher's final position
      if (SV_TestEntityPosition(check) === null) continue;
    }

    // remove the onground flag for non-players
    if (check.v.movetype !== MOVETYPE_WALK) check.v.flags = (check.v.flags | 0) & ~FL_ONGROUND;

    const entorig = vec3();
    VectorCopy(check.v.origin, entorig);
    VectorCopy(check.v.origin, moved_from[num_moved]);
    moved_edict[num_moved] = check;
    num_moved++;

    // try moving the contacted entity
    pusher.v.solid = SOLID_NOT;
    SV_PushEntity(check, move);
    pusher.v.solid = SOLID_BSP;

    // if it is still inside the pusher, block
    const block = SV_TestEntityPosition(check);
    if (block !== null) {
      // fail the move
      if (check.v.mins[0] === check.v.maxs[0]) continue;
      if (check.v.solid === SOLID_NOT || check.v.solid === SOLID_TRIGGER) {
        // corpse
        check.v.mins[0] = 0;
        check.v.mins[1] = 0;
        VectorCopy(check.v.mins, check.v.maxs);
        continue;
      }

      VectorCopy(entorig, check.v.origin);
      SV_LinkEdict(check, true);

      VectorCopy(pushorig, pusher.v.origin);
      SV_LinkEdict(pusher, false);
      pusher.v.ltime -= movetime;

      // if the pusher has a "blocked" function, call it
      // otherwise, just stay in place until the obstacle is gone
      if (pusher.v.blocked !== 0) {
        const globals = requireGlobalStruct();
        globals.self = EDICT_TO_PROG(pusher);
        globals.other = EDICT_TO_PROG(check);
        PR_ExecuteProgram(pusher.v.blocked);
      }

      // move back any entities we already moved
      for (let i = 0; i < num_moved; i++) {
        const moved = moved_edict[i];
        if (moved === null) continue;
        VectorCopy(moved_from[i], moved.v.origin);
        SV_LinkEdict(moved, false);
      }
      return;
    }
  }
}

/*
================
SV_Physics_Pusher

================
*/
export function SV_Physics_Pusher(ent: EdictT): void {
  const oldltime = ent.v.ltime;

  const thinktime = ent.v.nextthink;
  let movetime: number;
  if (thinktime < ent.v.ltime + host.frametime) {
    movetime = thinktime - ent.v.ltime;
    if (movetime < 0) movetime = 0;
  } else movetime = host.frametime;

  if (movetime) {
    SV_PushMove(ent, movetime); // advances ent->v.ltime if not blocked
  }

  if (thinktime > oldltime && thinktime <= ent.v.ltime) {
    ent.v.nextthink = 0;
    const globals = requireGlobalStruct();
    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(ent);
    globals.other = EDICT_TO_PROG(sv.edicts[0]);
    PR_ExecuteProgram(ent.v.think);
    if (ent.free) return;
  }
}

/*
===============================================================================

CLIENT MOVEMENT

===============================================================================
*/

/*
=============
SV_CheckStuck

This is a big hack to try and fix the rare case of getting stuck in the world
clipping hull.
=============
*/
export function SV_CheckStuck(ent: EdictT): void {
  if (SV_TestEntityPosition(ent) === null) {
    VectorCopy(ent.v.origin, ent.v.oldorigin);
    return;
  }

  const org = vec3();
  VectorCopy(ent.v.origin, org);
  VectorCopy(ent.v.oldorigin, ent.v.origin);
  if (SV_TestEntityPosition(ent) === null) {
    Con_DPrintf("Unstuck.\n");
    SV_LinkEdict(ent, true);
    return;
  }

  for (let z = 0; z < 18; z++)
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        ent.v.origin[0] = org[0] + i;
        ent.v.origin[1] = org[1] + j;
        ent.v.origin[2] = org[2] + z;
        if (SV_TestEntityPosition(ent) === null) {
          Con_DPrintf("Unstuck.\n");
          SV_LinkEdict(ent, true);
          return;
        }
      }

  VectorCopy(org, ent.v.origin);
  Con_DPrintf("player is stuck.\n");
}

/*
=============
SV_CheckWater
=============
*/
export function SV_CheckWater(ent: EdictT): boolean {
  const point = vec3();

  point[0] = ent.v.origin[0];
  point[1] = ent.v.origin[1];
  point[2] = ent.v.origin[2] + ent.v.mins[2] + 1;

  ent.v.waterlevel = 0;
  ent.v.watertype = CONTENTS_EMPTY;
  let cont = SV_PointContents(point);
  if (cont <= CONTENTS_WATER) {
    ent.v.watertype = cont;
    ent.v.waterlevel = 1;
    point[2] = ent.v.origin[2] + (ent.v.mins[2] + ent.v.maxs[2]) * 0.5;
    cont = SV_PointContents(point);
    if (cont <= CONTENTS_WATER) {
      ent.v.waterlevel = 2;
      point[2] = ent.v.origin[2] + ent.v.view_ofs[2];
      cont = SV_PointContents(point);
      if (cont <= CONTENTS_WATER) ent.v.waterlevel = 3;
    }
  }

  return ent.v.waterlevel > 1;
}

/*
============
SV_WallFriction

============
*/
export function SV_WallFriction(ent: EdictT, trace: TraceT): void {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(ent.v.v_angle, forward, right, up);
  let d = DotProduct(trace.plane.normal, forward);

  d += 0.5;
  if (d >= 0) return;

  // cut the tangential velocity
  const i = DotProduct(trace.plane.normal, ent.v.velocity);
  const into = vec3();
  VectorScale(trace.plane.normal, i, into);
  const side = vec3();
  VectorSubtract(ent.v.velocity, into, side);

  ent.v.velocity[0] = side[0] * (1 + d);
  ent.v.velocity[1] = side[1] * (1 + d);
}

/*
=====================
SV_TryUnstick

Player has come to a dead stop, possibly due to the problem with limited
float precision at some angle joins in the BSP hull.

Try fixing by pushing one pixel in each direction.

This is a hack, but in the interest of good gameplay...
======================
*/
export function SV_TryUnstick(ent: EdictT, oldvel: Vec3): number {
  const oldorg = vec3();
  VectorCopy(ent.v.origin, oldorg);
  const dir = vec3();
  VectorCopy(vec3_origin, dir);

  for (let i = 0; i < 8; i++) {
    // try pushing a little in an axial direction
    switch (i) {
      case 0:
        dir[0] = 2;
        dir[1] = 0;
        break;
      case 1:
        dir[0] = 0;
        dir[1] = 2;
        break;
      case 2:
        dir[0] = -2;
        dir[1] = 0;
        break;
      case 3:
        dir[0] = 0;
        dir[1] = -2;
        break;
      case 4:
        dir[0] = 2;
        dir[1] = 2;
        break;
      case 5:
        dir[0] = -2;
        dir[1] = 2;
        break;
      case 6:
        dir[0] = 2;
        dir[1] = -2;
        break;
      case 7:
        dir[0] = -2;
        dir[1] = -2;
        break;
    }

    SV_PushEntity(ent, dir);

    // retry the original move
    ent.v.velocity[0] = oldvel[0];
    ent.v.velocity[1] = oldvel[1];
    ent.v.velocity[2] = 0;
    const steptrace = new TraceT();
    const clip = SV_FlyMove(ent, 0.1, steptrace);

    if (Math.abs(oldorg[1] - ent.v.origin[1]) > 4 || Math.abs(oldorg[0] - ent.v.origin[0]) > 4) {
      // Con_DPrintf ("unstuck!\n");
      return clip;
    }

    // go back to the original pos and try again
    VectorCopy(oldorg, ent.v.origin);
  }

  VectorCopy(vec3_origin, ent.v.velocity);
  return 7; // still not moving
}

/*
=====================
SV_WalkMove

Only used by players
======================
*/
export const STEPSIZE = 18;

export function SV_WalkMove(ent: EdictT): void {
  //
  // do a regular slide move unless it looks like you ran into a step
  //
  const oldonground = (ent.v.flags | 0) & FL_ONGROUND;
  ent.v.flags = (ent.v.flags | 0) & ~FL_ONGROUND;

  const oldorg = vec3();
  const oldvel = vec3();
  VectorCopy(ent.v.origin, oldorg);
  VectorCopy(ent.v.velocity, oldvel);

  const steptrace = new TraceT();
  let clip = SV_FlyMove(ent, host.frametime, steptrace);

  if (!(clip & 2)) return; // move didn't block on a step

  if (!oldonground && ent.v.waterlevel === 0) return; // don't stair up while jumping

  if (ent.v.movetype !== MOVETYPE_WALK) return; // gibbed by a trigger

  if (sv_nostep.value) return;

  const sv_player = requireSvPlayer();
  if ((sv_player.v.flags | 0) & FL_WATERJUMP) return;

  const nosteporg = vec3();
  const nostepvel = vec3();
  VectorCopy(ent.v.origin, nosteporg);
  VectorCopy(ent.v.velocity, nostepvel);

  //
  // try moving up and forward to go up a step
  //
  VectorCopy(oldorg, ent.v.origin); // back to start pos

  const upmove = vec3();
  const downmove = vec3();
  VectorCopy(vec3_origin, upmove);
  VectorCopy(vec3_origin, downmove);
  upmove[2] = STEPSIZE;
  downmove[2] = -STEPSIZE + oldvel[2] * host.frametime;

  // move up
  SV_PushEntity(ent, upmove); // FIXME: don't link?

  // move forward
  ent.v.velocity[0] = oldvel[0];
  ent.v.velocity[1] = oldvel[1];
  ent.v.velocity[2] = 0;
  clip = SV_FlyMove(ent, host.frametime, steptrace);

  // check for stuckness, possibly due to the limited precision of floats
  // in the clipping hulls
  if (clip) {
    if (Math.abs(oldorg[1] - ent.v.origin[1]) < 0.03125 && Math.abs(oldorg[0] - ent.v.origin[0]) < 0.03125) {
      // stepping up didn't make any progress
      clip = SV_TryUnstick(ent, oldvel);
    }
  }

  // extra friction based on view angle
  if (clip & 2) SV_WallFriction(ent, steptrace);

  // move down
  const downtrace = SV_PushEntity(ent, downmove); // FIXME: don't link?

  if (downtrace.plane.normal[2] > 0.7) {
    if (ent.v.solid === SOLID_BSP) {
      ent.v.flags = (ent.v.flags | 0) | FL_ONGROUND;
      if (downtrace.ent === null) throw new SysError("SV_WalkMove: !downtrace.ent");
      ent.v.groundentity = EDICT_TO_PROG(downtrace.ent);
    }
  } else {
    // if the push down didn't end up on good ground, use the move without
    // the step up.  This happens near wall / slope combinations, and can
    // cause the player to hop up higher on a slope too steep to climb
    VectorCopy(nosteporg, ent.v.origin);
    VectorCopy(nostepvel, ent.v.velocity);
  }
}

/*
================
SV_Physics_Client

Player character actions
================
*/
export function SV_Physics_Client(ent: EdictT, num: number): void {
  if (!svs.clients[num - 1].active) return; // unconnected slot

  //
  // call standard client pre-think
  //
  const globals = requireGlobalStruct();
  globals.time = sv.time;
  globals.self = EDICT_TO_PROG(ent);
  PR_ExecuteProgram(globals.PlayerPreThink);

  //
  // do a move
  //
  SV_CheckVelocity(ent);

  //
  // decide which move function to call
  //
  switch (ent.v.movetype | 0) {
    case MOVETYPE_NONE:
      if (!SV_RunThink(ent)) return;
      break;

    case MOVETYPE_WALK:
      if (!SV_RunThink(ent)) return;
      if (!SV_CheckWater(ent) && !((ent.v.flags | 0) & FL_WATERJUMP)) SV_AddGravity(ent);
      SV_CheckStuck(ent);
      SV_WalkMove(ent);
      break;

    case MOVETYPE_TOSS:
    case MOVETYPE_BOUNCE:
      SV_Physics_Toss(ent);
      break;

    case MOVETYPE_FLY:
      if (!SV_RunThink(ent)) return;
      SV_FlyMove(ent, host.frametime, null);
      break;

    case MOVETYPE_NOCLIP:
      if (!SV_RunThink(ent)) return;
      VectorMA(ent.v.origin, host.frametime, ent.v.velocity, ent.v.origin);
      break;

    default:
      Sys_Error("SV_Physics_client: bad movetype %i", ent.v.movetype | 0);
  }

  //
  // call standard player post-think
  //
  SV_LinkEdict(ent, true);

  globals.time = sv.time;
  globals.self = EDICT_TO_PROG(ent);
  PR_ExecuteProgram(globals.PlayerPostThink);
}

//============================================================================

/*
=============
SV_Physics_None

Non moving objects can only think
=============
*/
export function SV_Physics_None(ent: EdictT): void {
  // regular thinking
  SV_RunThink(ent);
}

/*
=============
SV_Physics_Noclip

A moving object that doesn't obey physics
=============
*/
export function SV_Physics_Noclip(ent: EdictT): void {
  // regular thinking
  if (!SV_RunThink(ent)) return;

  VectorMA(ent.v.angles, host.frametime, ent.v.avelocity, ent.v.angles);
  VectorMA(ent.v.origin, host.frametime, ent.v.velocity, ent.v.origin);

  SV_LinkEdict(ent, false);
}

/*
==============================================================================

TOSS / BOUNCE

==============================================================================
*/

/*
=============
SV_CheckWaterTransition

=============
*/
export function SV_CheckWaterTransition(ent: EdictT): void {
  const cont = SV_PointContents(ent.v.origin);
  if (!ent.v.watertype) {
    // just spawned here
    ent.v.watertype = cont;
    ent.v.waterlevel = 1;
    return;
  }

  if (cont <= CONTENTS_WATER) {
    if (ent.v.watertype === CONTENTS_EMPTY) {
      // just crossed into water
      SV_StartSound(ent, 0, "misc/h2ohit1.wav", 255, 1);
    }
    ent.v.watertype = cont;
    ent.v.waterlevel = 1;
  } else {
    if (ent.v.watertype !== CONTENTS_EMPTY) {
      // just crossed into water
      SV_StartSound(ent, 0, "misc/h2ohit1.wav", 255, 1);
    }
    ent.v.watertype = CONTENTS_EMPTY;
    ent.v.waterlevel = cont;
  }
}

/*
=============
SV_Physics_Toss

Toss, bounce, and fly movement.  When onground, do nothing.
=============
*/
export function SV_Physics_Toss(ent: EdictT): void {
  // regular thinking
  if (!SV_RunThink(ent)) return;

  // if onground, return without moving
  if ((ent.v.flags | 0) & FL_ONGROUND) return;

  SV_CheckVelocity(ent);

  // add gravity
  if (ent.v.movetype !== MOVETYPE_FLY && ent.v.movetype !== MOVETYPE_FLYMISSILE) SV_AddGravity(ent);

  // move angles
  VectorMA(ent.v.angles, host.frametime, ent.v.avelocity, ent.v.angles);

  // move origin
  const move = vec3();
  VectorScale(ent.v.velocity, host.frametime, move);
  const trace = SV_PushEntity(ent, move);
  if (trace.fraction === 1) return;
  if (ent.free) return;

  let backoff: number;
  if (ent.v.movetype === MOVETYPE_BOUNCE) backoff = 1.5;
  else backoff = 1;

  ClipVelocity(ent.v.velocity, trace.plane.normal, ent.v.velocity, backoff);

  // stop if on ground
  if (trace.plane.normal[2] > 0.7) {
    if (ent.v.velocity[2] < 60 || ent.v.movetype !== MOVETYPE_BOUNCE) {
      ent.v.flags = (ent.v.flags | 0) | FL_ONGROUND;
      if (trace.ent === null) throw new SysError("SV_Physics_Toss: !trace.ent");
      ent.v.groundentity = EDICT_TO_PROG(trace.ent);
      VectorCopy(vec3_origin, ent.v.velocity);
      VectorCopy(vec3_origin, ent.v.avelocity);
    }
  }

  // check for in water
  SV_CheckWaterTransition(ent);
}

/*
===============================================================================

STEPPING MOVEMENT

===============================================================================
*/

/*
=============
SV_Physics_Step

Monsters freefall when they don't have a ground entity, otherwise
all movement is done with discrete steps.

This is also used for objects that have become still on the ground, but
will fall if the floor is pulled out from under them.
=============
*/
export function SV_Physics_Step(ent: EdictT): void {
  // freefall if not onground
  if (!((ent.v.flags | 0) & (FL_ONGROUND | FL_FLY | FL_SWIM))) {
    const hitsound = ent.v.velocity[2] < sv_gravity.value * -0.1;

    SV_AddGravity(ent);
    SV_CheckVelocity(ent);
    SV_FlyMove(ent, host.frametime, null);
    SV_LinkEdict(ent, true);

    if ((ent.v.flags | 0) & FL_ONGROUND) {
      // just hit ground
      if (hitsound) SV_StartSound(ent, 0, "demon/dland2.wav", 255, 1);
    }
  }

  // regular thinking
  SV_RunThink(ent);

  SV_CheckWaterTransition(ent);
}

//============================================================================

/*
================
SV_Physics

================
*/
export function SV_Physics(): void {
  // let the progs know that a new frame has started
  const globals = requireGlobalStruct();
  globals.self = EDICT_TO_PROG(sv.edicts[0]);
  globals.other = EDICT_TO_PROG(sv.edicts[0]);
  globals.time = sv.time;
  PR_ExecuteProgram(globals.StartFrame);

  // SV_CheckAllEnts ();

  //
  // treat each object in turn
  //
  for (let i = 0; i < sv.num_edicts; i++) {
    const ent = sv.edicts[i];
    if (ent.free) continue;

    if (globals.force_retouch) {
      SV_LinkEdict(ent, true); // force retouch even for stationary
    }

    if (i > 0 && i <= svs.maxclients) SV_Physics_Client(ent, i);
    else if (ent.v.movetype === MOVETYPE_PUSH) SV_Physics_Pusher(ent);
    else if (ent.v.movetype === MOVETYPE_NONE) SV_Physics_None(ent);
    else if (ent.v.movetype === MOVETYPE_NOCLIP) SV_Physics_Noclip(ent);
    else if (ent.v.movetype === MOVETYPE_STEP) SV_Physics_Step(ent);
    else if (ent.v.movetype === MOVETYPE_TOSS || ent.v.movetype === MOVETYPE_BOUNCE || ent.v.movetype === MOVETYPE_FLY || ent.v.movetype === MOVETYPE_FLYMISSILE)
      SV_Physics_Toss(ent);
    else Sys_Error("SV_Physics: bad movetype %i", ent.v.movetype | 0);
  }

  if (globals.force_retouch) globals.force_retouch--;

  sv.time += host.frametime;
}
