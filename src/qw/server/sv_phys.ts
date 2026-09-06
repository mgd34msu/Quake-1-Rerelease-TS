/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_phys.c (GNU GPL v2 or later).

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

How this differs from src/server/sv_phys.ts (WinQuake), all of it real, read
off both C files rather than guessed:
- No client physics at all. WinQuake's SV_Physics runs SV_Physics_Client /
  SV_ClientThink / SV_WalkMove / SV_UserFriction / SV_Accelerate /
  SV_AirAccelerate / SV_WaterMove / SV_WaterJump / SV_TryUnstick /
  SV_CheckStuck / SV_CheckWater / SV_SetIdealPitch for the player edicts; in
  QW players move through pmove.c, driven from sv_user.c's SV_RunCmd, and
  SV_Physics skips edicts `1..MAX_CLIENTS` outright ("clients are run
  directly from packets"). None of those functions exist in QW/server/
  sv_phys.c and none are ported here.
- Gravity comes from `movevars.gravity` (pmove_types.ts), not from the
  `sv_gravity` cvar directly and not from the QuakeC-declared per-entity
  "gravity" field: `SV_AddGravity(ent, scale)` takes a scale factor instead
  of reading `GetEdictFieldValue(ent, "gravity")`. The per-client gravity
  override lives in `client_t.entgravity` and reaches pmove through
  `movevars.entgravity` (sv_user.c), not through this file.
- SV_PushMove is split in two: `SV_Push(pusher, move)` (returns false when
  blocked, and restores every entity it already moved) plus a thin
  `SV_PushMove(pusher, movetime)` that computes `move` and advances
  `ltime` only when SV_Push succeeded. WinQuake's single SV_PushMove
  advances `ltime` up front. QW's SV_Push also drops WinQuake's
  "remove the onground flag for non-players" arm and reorders the
  block-handling (it pushes the entity by direct VectorAdd and
  SV_TestEntityPosition rather than through SV_PushEntity).
- SV_Physics_Pusher gained the post-think "snap" block: if the think
  function teleported the pusher more than 1/64 units, the origin is
  restored and the delta re-applied through SV_Push so riders come along.
- SV_RunEntity is new (WinQuake inlines the movetype switch in SV_Physics)
  and is guarded by `ent->v.lastruntime == (float)realtime`, QW's own
  entvars_t field, so an entity run out of band by SV_RunNewmis is not run
  again in the same frame.
- SV_ProgStartFrame and SV_RunNewmis are new. SV_SetMoveVars is new (it
  fills `movevars` from this file's cvars once per frame).
- SV_Physics is time-driven off `realtime` with a static `old_time` and the
  `sv_mintic`/`sv_maxtic` cvars, instead of being called once per host
  frame with a precomputed `host_frametime`.
- SV_CheckWater, SV_WalkMove, SV_Physics_Client, SV_Physics_Follow and
  SV_Trace_Toss do not exist in QW/server/sv_phys.c.

Deviations from PORTING.md / the C source:
- `ClipVelocity`'s C parameter name `in` (`vec3_t in`) is a reserved word in
  TypeScript; renamed `inVec` at the parameter, as src/server/sv_phys.ts
  already does. No other renames.
- `*steptrace = trace;` (SV_FlyMove) is a C struct-assignment copy into a
  caller-owned `trace_t*` out-param. This port has no struct assignment, so
  a local `copyTraceInto(dst, src)` copies every `TraceT` field (deep for
  the nested `plane`), same helper src/server/sv_phys.ts uses.
- SV_Physics_Toss reads `trace.ent` unconditionally in the ground-stop
  branch, where the C has no null check either. `trace.ent: QwEdictT | null`
  cannot be narrowed without one, so an explicit `SysError` guard is added
  in the same spot world.ts already uses that idiom -- it only changes
  behaviour on a call sequence that would already have been a C crash.
- `moved_edict[MAX_EDICTS]`/`moved_from[MAX_EDICTS]` (SV_Push) are C
  automatic (stack) arrays; module-level arrays sized `MAX_EDICTS` here, as
  in src/server/sv_phys.ts. Only indices `0..num_moved-1` written during a
  call are ever read back, so a stale tail is never observed.
- `static double old_time` inside SV_Physics becomes a module-level `let
  old_time = 0` (C statics have exactly module lifetime here).
- `ent->v.lastruntime == (float)realtime` truncates a double to float
  before comparing; `Math.fround(realtime)` is the explicit form, since
  `lastruntime` is a Float32Array slot and reads back already rounded.
- `host_frametime` and `realtime` are QW/server/sv_main.c globals (declared
  `extern` in qwsvdef.h; qwsvdef.ts deliberately does not declare them).
  src/qw/server/sv_main.ts (Q014) is not landed yet, so they are reached
  through the same lazy `require("./sv_main")` adapter src/qw/server/
  sv_send.ts already uses for that module (sv_main.ts and sv_init.ts require
  this module back, for SV_Physics/SV_ProgStartFrame/SV_SetMoveVars, so the
  cycle has to be broken on one side; all three break it lazily). Every read
  and write of `svMainState.host_frametime`/`.realtime`, and both
  `sv_mintic`/`sv_maxtic` reads, go through the single `svMain()` accessor
  below.
- `SV_Error` comes from src/qw/server/pr_exec.ts's stand-in (Q011's own
  documented placeholder for QW/server/sv_main.c's SV_Error), not from
  "./sv_main", so this file does not add a second unresolved name for it.
- `Con_Printf` is QW/server/sv_send.c's own (redirect-aware) version, in
  src/qw/server/sv_send.ts -- qwsv has no console.c, so src/client/
  console.ts's is the wrong one for this binary.
- The nine movement cvars this file declares (`sv_gravity`, `sv_stopspeed`,
  `sv_maxspeed`, `sv_spectatormaxspeed`, `sv_accelerate`,
  `sv_airaccelerate`, `sv_wateraccelerate`, `sv_friction`,
  `sv_waterfriction`) plus `sv_maxvelocity` are declared here, exactly where
  the C declares them, but are registered by sv_main.c's `SV_Init`
  (checked: there is no SV_InitPhysics in QW). sv_main.ts (Q014) owns those
  `Cvar_RegisterVariable` calls; this module only exports the objects.
- `MOVE_EPSILON` (0.01) is declared but never referenced anywhere in
  QW/server/sv_phys.c (grep confirms) -- already dead code in the original;
  ported as an exported constant, as src/server/sv_phys.ts does.

No `#ifdef` branches exist in QW/server/sv_phys.c: id removed WinQuake's
whole `#ifdef QUAKE2` half when they forked the file, so nothing is dropped
here (src/server/sv_phys.ts's long dropped-branch list has no QW analogue).
*/

import { type QwEdictT, EDICT_TO_PROG, PROG_TO_EDICT, qwpr, PR_GetString } from "./progs";
import type { QwGlobalVars } from "./progdefs";
import { PR_ExecuteProgram, SV_Error } from "./pr_exec";
import {
  sv,
  MOVETYPE_NONE,
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
} from "./server";
import {
  SV_Move,
  SV_LinkEdict,
  SV_PointContents,
  SV_TestEntityPosition,
  TraceT,
  MOVE_NORMAL,
  MOVE_NOMONSTERS,
  MOVE_MISSILE,
} from "./world";
import { SV_StartSound, Con_Printf } from "./sv_send";
import type * as SvMainModule from "./sv_main";
import { movevars } from "../pmove_types";
import { CvarT } from "../../common/cvar";
import { MAX_CLIENTS } from "../protocol";
import { MAX_EDICTS } from "../bothdefs";
import {
  type Vec3,
  vec3,
  vec3_origin,
  IS_NAN,
  DotProduct,
  Length,
  VectorAdd,
  VectorSubtract,
  VectorCopy,
  VectorScale,
  VectorMA,
  CrossProduct,
} from "../../common/mathlib";
import { CONTENTS_EMPTY, CONTENTS_WATER } from "../../common/bspfile";
import { SysError } from "../../platform/sys";

export const sv_maxvelocity = new CvarT("sv_maxvelocity", "2000");

export const sv_gravity = new CvarT("sv_gravity", "800");
export const sv_stopspeed = new CvarT("sv_stopspeed", "100");
export const sv_maxspeed = new CvarT("sv_maxspeed", "320");
export const sv_spectatormaxspeed = new CvarT("sv_spectatormaxspeed", "500");
export const sv_accelerate = new CvarT("sv_accelerate", "10");
export const sv_airaccelerate = new CvarT("sv_airaccelerate", "0.7");
export const sv_wateraccelerate = new CvarT("sv_wateraccelerate", "10");
export const sv_friction = new CvarT("sv_friction", "4");
export const sv_waterfriction = new CvarT("sv_waterfriction", "4");

export const MOVE_EPSILON = 0.01;

// see file header: QW/server/sv_main.c-owned names (Q014, not yet landed).
function svMain(): typeof SvMainModule {
  return require("./sv_main");
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new SysError("sv_phys: progs not loaded");
  return qwpr.global_struct;
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
export function SV_CheckVelocity(ent: QwEdictT): void {
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
export function SV_RunThink(ent: QwEdictT): boolean {
  for (;;) {
    let thinktime = ent.v.nextthink;
    if (thinktime <= 0) return true;
    if (thinktime > sv.time + svMain().svMainState.host_frametime) return true;

    if (thinktime < sv.time) thinktime = sv.time; // don't let things stay in the past.
    // it is possible to start that way
    // by a trigger with a local time.
    ent.v.nextthink = 0;
    const globals = requireGlobalStruct();
    globals.time = thinktime;
    globals.self = EDICT_TO_PROG(ent);
    globals.other = EDICT_TO_PROG(sv.edicts[0]);
    PR_ExecuteProgram(ent.v.think);

    if (ent.free) return false;
  }
}

/*
==================
SV_Impact

Two entities have touched, so run their touch functions
==================
*/
export function SV_Impact(e1: QwEdictT, e2: QwEdictT): void {
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

export function SV_FlyMove(ent: QwEdictT, time: number, steptrace: TraceT | null): number {
  const numbumps = 4;

  let blocked = 0;
  const original_velocity = vec3();
  const primal_velocity = vec3();
  const new_velocity = vec3();
  VectorCopy(ent.v.velocity, original_velocity);
  VectorCopy(ent.v.velocity, primal_velocity);
  let numplanes = 0;

  const planes: Vec3[] = Array.from({ length: MAX_CLIP_PLANES }, () => vec3());

  let time_left = time;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
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

    if (trace.ent === null) SV_Error("SV_FlyMove: !trace.ent");
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
export function SV_AddGravity(ent: QwEdictT, scale: number): void {
  ent.v.velocity[2] -= scale * movevars.gravity * svMain().svMainState.host_frametime;
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
export function SV_PushEntity(ent: QwEdictT, push: Vec3): TraceT {
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
SV_Push

============
*/
// C automatic (stack) arrays -- see file header's deviation note.
const moved_edict: Array<QwEdictT | null> = new Array<QwEdictT | null>(MAX_EDICTS).fill(null);
const moved_from: Vec3[] = Array.from({ length: MAX_EDICTS }, () => vec3());

export function SV_Push(pusher: QwEdictT, move: Vec3): boolean {
  const mins = vec3();
  const maxs = vec3();
  const pushorig = vec3();

  for (let i = 0; i < 3; i++) {
    mins[i] = pusher.v.absmin[i] + move[i];
    maxs[i] = pusher.v.absmax[i] + move[i];
  }

  VectorCopy(pusher.v.origin, pushorig);

  // move the pusher to it's final position

  VectorAdd(pusher.v.origin, move, pusher.v.origin);
  SV_LinkEdict(pusher, false);

  // see if any solid entities are inside the final position
  let num_moved = 0;
  for (let e = 1; e < sv.num_edicts; e++) {
    const check = sv.edicts[e];
    if (check.free) continue;
    if (check.v.movetype === MOVETYPE_PUSH || check.v.movetype === MOVETYPE_NONE || check.v.movetype === MOVETYPE_NOCLIP) continue;

    pusher.v.solid = SOLID_NOT;
    let block = SV_TestEntityPosition(check);
    pusher.v.solid = SOLID_BSP;
    if (block !== null) continue;

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

    VectorCopy(check.v.origin, moved_from[num_moved]);
    moved_edict[num_moved] = check;
    num_moved++;

    // try moving the contacted entity
    VectorAdd(check.v.origin, move, check.v.origin);
    block = SV_TestEntityPosition(check);
    if (block === null) {
      // pushed ok
      SV_LinkEdict(check, false);
      continue;
    }

    // if it is ok to leave in the old position, do it
    VectorSubtract(check.v.origin, move, check.v.origin);
    block = SV_TestEntityPosition(check);
    if (block === null) {
      num_moved--;
      continue;
    }

    // if it is still inside the pusher, block
    if (check.v.mins[0] === check.v.maxs[0]) {
      SV_LinkEdict(check, false);
      continue;
    }
    if (check.v.solid === SOLID_NOT || check.v.solid === SOLID_TRIGGER) {
      // corpse
      check.v.mins[0] = 0;
      check.v.mins[1] = 0;
      VectorCopy(check.v.mins, check.v.maxs);
      SV_LinkEdict(check, false);
      continue;
    }

    VectorCopy(pushorig, pusher.v.origin);
    SV_LinkEdict(pusher, false);

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
    return false;
  }

  return true;
}

/*
============
SV_PushMove

============
*/
export function SV_PushMove(pusher: QwEdictT, movetime: number): void {
  if (!pusher.v.velocity[0] && !pusher.v.velocity[1] && !pusher.v.velocity[2]) {
    pusher.v.ltime += movetime;
    return;
  }

  const move = vec3();
  for (let i = 0; i < 3; i++) move[i] = pusher.v.velocity[i] * movetime;

  if (SV_Push(pusher, move)) pusher.v.ltime += movetime;
}

/*
================
SV_Physics_Pusher

================
*/
export function SV_Physics_Pusher(ent: QwEdictT): void {
  const oldorg = vec3();
  const move = vec3();

  const oldltime = ent.v.ltime;

  const thinktime = ent.v.nextthink;
  let movetime: number;
  if (thinktime < ent.v.ltime + svMain().svMainState.host_frametime) {
    movetime = thinktime - ent.v.ltime;
    if (movetime < 0) movetime = 0;
  } else movetime = svMain().svMainState.host_frametime;

  if (movetime) {
    SV_PushMove(ent, movetime); // advances ent->v.ltime if not blocked
  }

  if (thinktime > oldltime && thinktime <= ent.v.ltime) {
    VectorCopy(ent.v.origin, oldorg);
    ent.v.nextthink = 0;
    const globals = requireGlobalStruct();
    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(ent);
    globals.other = EDICT_TO_PROG(sv.edicts[0]);
    PR_ExecuteProgram(ent.v.think);
    if (ent.free) return;
    VectorSubtract(ent.v.origin, oldorg, move);

    const l = Length(move);
    if (l > 1.0 / 64) {
      //	Con_Printf ("**** snap: %f\n", Length (l));
      VectorCopy(oldorg, ent.v.origin);
      SV_Push(ent, move);
    }
  }
}

/*
=============
SV_Physics_None

Non moving objects can only think
=============
*/
export function SV_Physics_None(ent: QwEdictT): void {
  // regular thinking
  SV_RunThink(ent);
}

/*
=============
SV_Physics_Noclip

A moving object that doesn't obey physics
=============
*/
export function SV_Physics_Noclip(ent: QwEdictT): void {
  // regular thinking
  if (!SV_RunThink(ent)) return;

  const host_frametime = svMain().svMainState.host_frametime;
  VectorMA(ent.v.angles, host_frametime, ent.v.avelocity, ent.v.angles);
  VectorMA(ent.v.origin, host_frametime, ent.v.velocity, ent.v.origin);

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
export function SV_CheckWaterTransition(ent: QwEdictT): void {
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
export function SV_Physics_Toss(ent: QwEdictT): void {
  // regular thinking
  if (!SV_RunThink(ent)) return;

  if (ent.v.velocity[2] > 0) ent.v.flags = (ent.v.flags | 0) & ~FL_ONGROUND;

  // if onground, return without moving
  if (((ent.v.flags | 0) & FL_ONGROUND) !== 0) return;

  SV_CheckVelocity(ent);

  // add gravity
  if (ent.v.movetype !== MOVETYPE_FLY && ent.v.movetype !== MOVETYPE_FLYMISSILE) SV_AddGravity(ent, 1.0);

  const host_frametime = svMain().svMainState.host_frametime;

  // move angles
  VectorMA(ent.v.angles, host_frametime, ent.v.avelocity, ent.v.angles);

  // move origin
  const move = vec3();
  VectorScale(ent.v.velocity, host_frametime, move);
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
      if (trace.ent === null) throw new SysError("SV_Physics_Toss: trace.ent is null after a blocked move");
      ent.v.flags = (ent.v.flags | 0) | FL_ONGROUND;
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
FIXME: is this true?
=============
*/
export function SV_Physics_Step(ent: QwEdictT): void {
  // frefall if not onground
  if (((ent.v.flags | 0) & (FL_ONGROUND | FL_FLY | FL_SWIM)) === 0) {
    const hitsound = ent.v.velocity[2] < movevars.gravity * -0.1;

    SV_AddGravity(ent, 1.0);
    SV_CheckVelocity(ent);
    SV_FlyMove(ent, svMain().svMainState.host_frametime, null);
    SV_LinkEdict(ent, true);

    if (((ent.v.flags | 0) & FL_ONGROUND) !== 0) {
      // just hit ground
      if (hitsound) SV_StartSound(ent, 0, "demon/dland2.wav", 255, 1);
    }
  }

  // regular thinking
  SV_RunThink(ent);

  SV_CheckWaterTransition(ent);
}

//============================================================================

export function SV_ProgStartFrame(): void {
  // let the progs know that a new frame has started
  const globals = requireGlobalStruct();
  globals.self = EDICT_TO_PROG(sv.edicts[0]);
  globals.other = EDICT_TO_PROG(sv.edicts[0]);
  globals.time = sv.time;
  PR_ExecuteProgram(globals.StartFrame);
}

/*
================
SV_RunEntity

================
*/
export function SV_RunEntity(ent: QwEdictT): void {
  const realtime = svMain().svMainState.realtime;
  if (ent.v.lastruntime === Math.fround(realtime)) return;
  ent.v.lastruntime = Math.fround(realtime);

  switch (ent.v.movetype | 0) {
    case MOVETYPE_PUSH:
      SV_Physics_Pusher(ent);
      break;
    case MOVETYPE_NONE:
      SV_Physics_None(ent);
      break;
    case MOVETYPE_NOCLIP:
      SV_Physics_Noclip(ent);
      break;
    case MOVETYPE_STEP:
      SV_Physics_Step(ent);
      break;
    case MOVETYPE_TOSS:
    case MOVETYPE_BOUNCE:
    case MOVETYPE_FLY:
    case MOVETYPE_FLYMISSILE:
      SV_Physics_Toss(ent);
      break;
    default:
      SV_Error("SV_Physics: bad movetype %i", ent.v.movetype | 0);
  }
}

/*
================
SV_RunNewmis

================
*/
export function SV_RunNewmis(): void {
  const globals = requireGlobalStruct();
  if (!globals.newmis) return;
  const ent = PROG_TO_EDICT(globals.newmis);
  svMain().svMainState.host_frametime = 0.05;
  globals.newmis = 0;

  SV_RunEntity(ent);
}

/*
================
SV_Physics

================
*/
// `static double old_time;` -- see file header's deviation note.
let old_time = 0;

export function SV_Physics(): void {
  const svMainMod = svMain();

  // don't bother running a frame if sys_ticrate seconds haven't passed
  svMainMod.svMainState.host_frametime = svMainMod.svMainState.realtime - old_time;
  if (svMainMod.svMainState.host_frametime < svMainMod.sv_mintic.value) return;
  if (svMainMod.svMainState.host_frametime > svMainMod.sv_maxtic.value) svMainMod.svMainState.host_frametime = svMainMod.sv_maxtic.value;
  old_time = svMainMod.svMainState.realtime;

  const globals = requireGlobalStruct();
  globals.frametime = svMainMod.svMainState.host_frametime;

  SV_ProgStartFrame();

  //
  // treat each object in turn
  // even the world gets a chance to think
  //
  for (let i = 0; i < sv.num_edicts; i++) {
    const ent = sv.edicts[i];
    if (ent.free) continue;

    if (globals.force_retouch) SV_LinkEdict(ent, true); // force retouch even for stationary

    if (i > 0 && i <= MAX_CLIENTS) continue; // clients are run directly from packets

    SV_RunEntity(ent);
    SV_RunNewmis();
  }

  if (globals.force_retouch) globals.force_retouch--;
}

export function SV_SetMoveVars(): void {
  movevars.gravity = sv_gravity.value;
  movevars.stopspeed = sv_stopspeed.value;
  movevars.maxspeed = sv_maxspeed.value;
  movevars.spectatormaxspeed = sv_spectatormaxspeed.value;
  movevars.accelerate = sv_accelerate.value;
  movevars.airaccelerate = sv_airaccelerate.value;
  movevars.wateraccelerate = sv_wateraccelerate.value;
  movevars.friction = sv_friction.value;
  movevars.waterfriction = sv_waterfriction.value;
  movevars.entgravity = 1.0;
}
