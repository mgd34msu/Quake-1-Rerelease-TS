/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/pmove.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- pmove.c's `movevars`, `pmove`, `onground`, `waterlevel`, `watertype`,
  `frametime`, `player_mins` and `player_maxs` are defined in
  src/qw/pmove_types.ts (pmove.h's module) and re-exported here; see that
  file's header for why. `onground`/`waterlevel`/`watertype`/`frametime` are
  reassigned scalars, so they are fields of the `pmState` holder rather than
  bare exports.
- `vec3_t forward, right, up;` are pmove.c globals that pmove.h never
  declares and no other translation unit reads. They are module-level `const`
  Vec3 buffers here, mutated in place by AngleVectors/VectorNormalize exactly
  as the C mutates the globals, and exported so a test can inspect them.
- `SpectatorMove`'s `#ifndef SERVERONLY extern float server_version;` is
  dropped: the declaration is never used in the function body.
- PM_GroundMove's `goto usedown` becomes a `usedown` boolean, evaluated in
  the same order as the C's fallthrough.
- The commented-out `Con_Printf` debug lines and the commented-out
  `PM_GRAVITY`/`PM_STOPSPEED`/... `#define` block are dropped.
- C `float` locals (speed, drop, wishspeed, ...) are TS doubles; only the
  values stored back into Vec3 (`Float32Array`) round to float32. This is the
  port-wide convention (src/server/world.ts and src/server/sv_phys.ts do the
  same) and is the one place QW's C and this port can disagree in the last
  bits. Client and server prediction stay in lockstep here because both run
  this same module.
*/

import {
  type Vec3,
  vec3,
  vec3_origin,
  DotProduct,
  CrossProduct,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  AngleVectors,
  Length,
} from "../common/mathlib";
import { CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_SLIME, CONTENTS_WATER } from "../common/bspfile";
import { movevars, pmove, pmState, player_mins, player_maxs } from "./pmove_types";
import { PM_InitBoxHull, PM_PlayerMove, PM_PointContents, PM_TestPlayerPosition } from "./pmovetst";

export {
  MAX_PHYSENTS,
  MovevarsT,
  PhysentT,
  PlayermoveT,
  PmplaneT,
  PmStateT,
  PmtraceT,
  movevars,
  player_maxs,
  player_mins,
  pmState,
  pmove,
} from "./pmove_types";

export const forward: Vec3 = vec3();
export const right: Vec3 = vec3();
export const up: Vec3 = vec3();

export function Pmove_Init(): void {
  PM_InitBoxHull();
}

const STEPSIZE = 18;

const BUTTON_JUMP = 2;

/*
==================
PM_ClipVelocity

Slide off of the impacting object
returns the blocked flags (1 = floor, 2 = step / wall)
==================
*/
const STOP_EPSILON = 0.1;

export function PM_ClipVelocity(vin: Vec3, normal: Vec3, out: Vec3, overbounce: number): number {
  let blocked = 0;
  if (normal[2] > 0) blocked |= 1; // floor
  if (!normal[2]) blocked |= 2; // step

  const backoff = DotProduct(vin, normal) * overbounce;

  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = vin[i] - change;
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) out[i] = 0;
  }

  return blocked;
}

/*
============
PM_FlyMove

The basic solid body movement clip that slides along multiple planes
============
*/
const MAX_CLIP_PLANES = 5;

export function PM_FlyMove(): number {
  const dir = vec3();
  const planes: Vec3[] = Array.from({ length: MAX_CLIP_PLANES }, () => vec3());
  const primal_velocity = vec3();
  const original_velocity = vec3();
  const end = vec3();

  const numbumps = 4;

  let blocked = 0;
  VectorCopy(pmove.velocity, original_velocity);
  VectorCopy(pmove.velocity, primal_velocity);
  let numplanes = 0;

  let time_left = pmState.frametime;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    for (let i = 0; i < 3; i++) end[i] = pmove.origin[i] + time_left * pmove.velocity[i];

    const trace = PM_PlayerMove(pmove.origin, end);

    if (trace.startsolid || trace.allsolid) {
      // entity is trapped in another solid
      VectorCopy(vec3_origin, pmove.velocity);
      return 3;
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, pmove.origin);
      numplanes = 0;
    }

    if (trace.fraction === 1) break; // moved the entire distance

    // save entity for contact
    pmove.touchindex[pmove.numtouch] = trace.ent;
    pmove.numtouch++;

    if (trace.plane.normal[2] > 0.7) {
      blocked |= 1; // floor
    }
    if (!trace.plane.normal[2]) {
      blocked |= 2; // step
    }

    time_left -= time_left * trace.fraction;

    // cliped to another plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      VectorCopy(vec3_origin, pmove.velocity);
      break;
    }

    VectorCopy(trace.plane.normal, planes[numplanes]);
    numplanes++;

    //
    // modify original_velocity so it parallels all of the clip planes
    //
    let i = 0;
    let j = 0;
    for (i = 0; i < numplanes; i++) {
      PM_ClipVelocity(original_velocity, planes[i], pmove.velocity, 1);
      for (j = 0; j < numplanes; j++)
        if (j !== i) {
          if (DotProduct(pmove.velocity, planes[j]) < 0) break; // not ok
        }
      if (j === numplanes) break;
    }

    if (i !== numplanes) {
      // go along this plane
    } else {
      // go along the crease
      if (numplanes !== 2) {
        VectorCopy(vec3_origin, pmove.velocity);
        break;
      }
      CrossProduct(planes[0], planes[1], dir);
      const d = DotProduct(dir, pmove.velocity);
      VectorScale(dir, d, pmove.velocity);
    }

    //
    // if original velocity is against the original velocity, stop dead
    // to avoid tiny occilations in sloping corners
    //
    if (DotProduct(pmove.velocity, primal_velocity) <= 0) {
      VectorCopy(vec3_origin, pmove.velocity);
      break;
    }
  }

  if (pmove.waterjumptime) {
    VectorCopy(primal_velocity, pmove.velocity);
  }
  return blocked;
}

/*
=============
PM_GroundMove

Player is on ground, with no upwards velocity
=============
*/
export function PM_GroundMove(): void {
  const start = vec3();
  const dest = vec3();
  const original = vec3();
  const originalvel = vec3();
  const down = vec3();
  const up_ = vec3();
  const downvel = vec3();

  pmove.velocity[2] = 0;
  if (!pmove.velocity[0] && !pmove.velocity[1] && !pmove.velocity[2]) return;

  // first try just moving to the destination
  dest[0] = pmove.origin[0] + pmove.velocity[0] * pmState.frametime;
  dest[1] = pmove.origin[1] + pmove.velocity[1] * pmState.frametime;
  dest[2] = pmove.origin[2];

  // first try moving directly to the next spot
  VectorCopy(dest, start);
  let trace = PM_PlayerMove(pmove.origin, dest);
  if (trace.fraction === 1) {
    VectorCopy(trace.endpos, pmove.origin);
    return;
  }

  // try sliding forward both on ground and up 16 pixels
  // take the move that goes farthest
  VectorCopy(pmove.origin, original);
  VectorCopy(pmove.velocity, originalvel);

  // slide move
  PM_FlyMove();

  VectorCopy(pmove.origin, down);
  VectorCopy(pmove.velocity, downvel);

  VectorCopy(original, pmove.origin);
  VectorCopy(originalvel, pmove.velocity);

  // move up a stair height
  VectorCopy(pmove.origin, dest);
  dest[2] += STEPSIZE;
  trace = PM_PlayerMove(pmove.origin, dest);
  if (!trace.startsolid && !trace.allsolid) {
    VectorCopy(trace.endpos, pmove.origin);
  }

  // slide move
  PM_FlyMove();

  // press down the stepheight
  VectorCopy(pmove.origin, dest);
  dest[2] -= STEPSIZE;
  trace = PM_PlayerMove(pmove.origin, dest);
  let usedown = trace.plane.normal[2] < 0.7;
  if (!usedown) {
    if (!trace.startsolid && !trace.allsolid) {
      VectorCopy(trace.endpos, pmove.origin);
    }
    VectorCopy(pmove.origin, up_);

    // decide which one went farther
    const downdist =
      (down[0] - original[0]) * (down[0] - original[0]) + (down[1] - original[1]) * (down[1] - original[1]);
    const updist = (up_[0] - original[0]) * (up_[0] - original[0]) + (up_[1] - original[1]) * (up_[1] - original[1]);

    usedown = downdist > updist;
  }

  if (usedown) {
    VectorCopy(down, pmove.origin);
    VectorCopy(downvel, pmove.velocity);
  } // copy z value from slide move
  else pmove.velocity[2] = downvel[2];

  // if at a dead stop, retry the move with nudges to get around lips
}

/*
==================
PM_Friction

Handles both ground friction and water friction
==================
*/
export function PM_Friction(): void {
  const start = vec3();
  const stop = vec3();

  if (pmove.waterjumptime) return;

  const vel = pmove.velocity;

  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
  if (speed < 1) {
    vel[0] = 0;
    vel[1] = 0;
    return;
  }

  let friction = movevars.friction;

  // if the leading edge is over a dropoff, increase friction
  if (pmState.onground !== -1) {
    start[0] = stop[0] = pmove.origin[0] + (vel[0] / speed) * 16;
    start[1] = stop[1] = pmove.origin[1] + (vel[1] / speed) * 16;
    start[2] = pmove.origin[2] + player_mins[2];
    stop[2] = start[2] - 34;

    const trace = PM_PlayerMove(start, stop);

    if (trace.fraction === 1) {
      friction *= 2;
    }
  }

  let drop = 0;

  if (pmState.waterlevel >= 2)
    // apply water friction
    drop += speed * movevars.waterfriction * pmState.waterlevel * pmState.frametime;
  else if (pmState.onground !== -1) {
    // apply ground friction
    const control = speed < movevars.stopspeed ? movevars.stopspeed : speed;
    drop += control * friction * pmState.frametime;
  }

  // scale the velocity
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;

  vel[0] = vel[0] * newspeed;
  vel[1] = vel[1] * newspeed;
  vel[2] = vel[2] * newspeed;
}

/*
==============
PM_Accelerate
==============
*/
export function PM_Accelerate(wishdir: Vec3, wishspeed: number, accel: number): void {
  if (pmove.dead) return;
  if (pmove.waterjumptime) return;

  const currentspeed = DotProduct(pmove.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * pmState.frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) pmove.velocity[i] += accelspeed * wishdir[i];
}

export function PM_AirAccelerate(wishdir: Vec3, wishspeed: number, accel: number): void {
  let wishspd = wishspeed;

  if (pmove.dead) return;
  if (pmove.waterjumptime) return;

  if (wishspd > 30) wishspd = 30;
  const currentspeed = DotProduct(pmove.velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * pmState.frametime;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) pmove.velocity[i] += accelspeed * wishdir[i];
}

/*
===================
PM_WaterMove

===================
*/
export function PM_WaterMove(): void {
  const wishvel = vec3();
  const wishdir = vec3();
  const start = vec3();
  const dest = vec3();

  //
  // user intentions
  //
  for (let i = 0; i < 3; i++)
    wishvel[i] = forward[i] * pmove.cmd.forwardmove + right[i] * pmove.cmd.sidemove;

  if (!pmove.cmd.forwardmove && !pmove.cmd.sidemove && !pmove.cmd.upmove)
    wishvel[2] -= 60; // drift towards bottom
  else wishvel[2] += pmove.cmd.upmove;

  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  if (wishspeed > movevars.maxspeed) {
    VectorScale(wishvel, movevars.maxspeed / wishspeed, wishvel);
    wishspeed = movevars.maxspeed;
  }
  wishspeed *= 0.7;

  //
  // water acceleration
  //
  PM_Accelerate(wishdir, wishspeed, movevars.wateraccelerate);

  // assume it is a stair or a slope, so press down from stepheight above
  VectorMA(pmove.origin, pmState.frametime, pmove.velocity, dest);
  VectorCopy(dest, start);
  start[2] += STEPSIZE + 1;
  const trace = PM_PlayerMove(start, dest);
  if (!trace.startsolid && !trace.allsolid) {
    // FIXME: check steep slope?
    // walked up the step
    VectorCopy(trace.endpos, pmove.origin);
    return;
  }

  PM_FlyMove();
}

/*
===================
PM_AirMove

===================
*/
export function PM_AirMove(): void {
  const wishvel = vec3();
  const wishdir = vec3();

  const fmove = pmove.cmd.forwardmove;
  const smove = pmove.cmd.sidemove;

  forward[2] = 0;
  right[2] = 0;
  VectorNormalize(forward);
  VectorNormalize(right);

  for (let i = 0; i < 2; i++) wishvel[i] = forward[i] * fmove + right[i] * smove;
  wishvel[2] = 0;

  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  //
  // clamp to server defined max speed
  //
  if (wishspeed > movevars.maxspeed) {
    VectorScale(wishvel, movevars.maxspeed / wishspeed, wishvel);
    wishspeed = movevars.maxspeed;
  }

  if (pmState.onground !== -1) {
    pmove.velocity[2] = 0;
    PM_Accelerate(wishdir, wishspeed, movevars.accelerate);
    pmove.velocity[2] -= movevars.entgravity * movevars.gravity * pmState.frametime;
    PM_GroundMove();
  } else {
    // not on ground, so little effect on velocity
    PM_AirAccelerate(wishdir, wishspeed, movevars.accelerate);

    // add gravity
    pmove.velocity[2] -= movevars.entgravity * movevars.gravity * pmState.frametime;

    PM_FlyMove();
  }
}

/*
=============
PM_CatagorizePosition
=============
*/
export function PM_CatagorizePosition(): void {
  const point = vec3();

  // if the player hull point one unit down is solid, the player
  // is on ground

  // see if standing on something solid
  point[0] = pmove.origin[0];
  point[1] = pmove.origin[1];
  point[2] = pmove.origin[2] - 1;
  if (pmove.velocity[2] > 180) {
    pmState.onground = -1;
  } else {
    const tr = PM_PlayerMove(pmove.origin, point);
    if (tr.plane.normal[2] < 0.7)
      pmState.onground = -1; // too steep
    else pmState.onground = tr.ent;
    if (pmState.onground !== -1) {
      pmove.waterjumptime = 0;
      if (!tr.startsolid && !tr.allsolid) VectorCopy(tr.endpos, pmove.origin);
    }

    // standing on an entity other than the world
    if (tr.ent > 0) {
      pmove.touchindex[pmove.numtouch] = tr.ent;
      pmove.numtouch++;
    }
  }

  //
  // get waterlevel
  //
  pmState.waterlevel = 0;
  pmState.watertype = CONTENTS_EMPTY;

  point[2] = pmove.origin[2] + player_mins[2] + 1;
  let cont = PM_PointContents(point);

  if (cont <= CONTENTS_WATER) {
    pmState.watertype = cont;
    pmState.waterlevel = 1;
    point[2] = pmove.origin[2] + (player_mins[2] + player_maxs[2]) * 0.5;
    cont = PM_PointContents(point);
    if (cont <= CONTENTS_WATER) {
      pmState.waterlevel = 2;
      point[2] = pmove.origin[2] + 22;
      cont = PM_PointContents(point);
      if (cont <= CONTENTS_WATER) pmState.waterlevel = 3;
    }
  }
}

/*
=============
JumpButton
=============
*/
export function JumpButton(): void {
  if (pmove.dead) {
    pmove.oldbuttons |= BUTTON_JUMP; // don't jump again until released
    return;
  }

  if (pmove.waterjumptime) {
    pmove.waterjumptime -= pmState.frametime;
    if (pmove.waterjumptime < 0) pmove.waterjumptime = 0;
    return;
  }

  if (pmState.waterlevel >= 2) {
    // swimming, not jumping
    pmState.onground = -1;

    if (pmState.watertype === CONTENTS_WATER) pmove.velocity[2] = 100;
    else if (pmState.watertype === CONTENTS_SLIME) pmove.velocity[2] = 80;
    else pmove.velocity[2] = 50;
    return;
  }

  if (pmState.onground === -1) return; // in air, so no effect

  if (pmove.oldbuttons & BUTTON_JUMP) return; // don't pogo stick

  pmState.onground = -1;
  pmove.velocity[2] += 270;

  pmove.oldbuttons |= BUTTON_JUMP; // don't jump again until released
}

/*
=============
CheckWaterJump
=============
*/
export function CheckWaterJump(): void {
  const spot = vec3();
  const flatforward = vec3();

  if (pmove.waterjumptime) return;

  // ZOID, don't hop out if we just jumped in
  if (pmove.velocity[2] < -180) return; // only hop out if we are moving up

  // see if near an edge
  flatforward[0] = forward[0];
  flatforward[1] = forward[1];
  flatforward[2] = 0;
  VectorNormalize(flatforward);

  VectorMA(pmove.origin, 24, flatforward, spot);
  spot[2] += 8;
  let cont = PM_PointContents(spot);
  if (cont !== CONTENTS_SOLID) return;
  spot[2] += 24;
  cont = PM_PointContents(spot);
  if (cont !== CONTENTS_EMPTY) return;
  // jump out of water
  VectorScale(flatforward, 50, pmove.velocity);
  pmove.velocity[2] = 310;
  pmove.waterjumptime = 2; // safety net
  pmove.oldbuttons |= BUTTON_JUMP; // don't jump again until released
}

/*
=================
NudgePosition

If pmove.origin is in a solid position,
try nudging slightly on all axis to
allow for the cut precision of the net coordinates
=================
*/
const sign: number[] = [0, -1, 1];

export function NudgePosition(): void {
  const base = vec3();

  VectorCopy(pmove.origin, base);

  for (let i = 0; i < 3; i++) pmove.origin[i] = (pmove.origin[i] * 8 | 0) * 0.125;

  for (let z = 0; z <= 2; z++) {
    for (let x = 0; x <= 2; x++) {
      for (let y = 0; y <= 2; y++) {
        pmove.origin[0] = base[0] + sign[x] * (1.0 / 8);
        pmove.origin[1] = base[1] + sign[y] * (1.0 / 8);
        pmove.origin[2] = base[2] + sign[z] * (1.0 / 8);
        if (PM_TestPlayerPosition(pmove.origin)) return;
      }
    }
  }
  VectorCopy(base, pmove.origin);
}

/*
===============
SpectatorMove
===============
*/
export function SpectatorMove(): void {
  const wishvel = vec3();
  const wishdir = vec3();

  // friction

  const speed = Length(pmove.velocity);
  if (speed < 1) {
    VectorCopy(vec3_origin, pmove.velocity);
  } else {
    let drop = 0;

    const friction = movevars.friction * 1.5; // extra friction
    const control = speed < movevars.stopspeed ? movevars.stopspeed : speed;
    drop += control * friction * pmState.frametime;

    // scale the velocity
    let newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;

    VectorScale(pmove.velocity, newspeed, pmove.velocity);
  }

  // accelerate
  const fmove = pmove.cmd.forwardmove;
  const smove = pmove.cmd.sidemove;

  VectorNormalize(forward);
  VectorNormalize(right);

  for (let i = 0; i < 3; i++) wishvel[i] = forward[i] * fmove + right[i] * smove;
  wishvel[2] += pmove.cmd.upmove;

  VectorCopy(wishvel, wishdir);
  let wishspeed = VectorNormalize(wishdir);

  //
  // clamp to server defined max speed
  //
  if (wishspeed > movevars.spectatormaxspeed) {
    VectorScale(wishvel, movevars.spectatormaxspeed / wishspeed, wishvel);
    wishspeed = movevars.spectatormaxspeed;
  }

  const currentspeed = DotProduct(pmove.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = movevars.accelerate * pmState.frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;

  for (let i = 0; i < 3; i++) pmove.velocity[i] += accelspeed * wishdir[i];

  // move
  VectorMA(pmove.origin, pmState.frametime, pmove.velocity, pmove.origin);
}

/*
=============
PlayerMove

Returns with origin, angles, and velocity modified in place.

Numtouch and touchindex[] will be set if any of the physents
were contacted during the move.
=============
*/
export function PlayerMove(): void {
  pmState.frametime = pmove.cmd.msec * 0.001;
  pmove.numtouch = 0;

  AngleVectors(pmove.angles, forward, right, up);

  if (pmove.spectator) {
    SpectatorMove();
    return;
  }

  NudgePosition();

  // take angles directly from command
  VectorCopy(pmove.cmd.angles, pmove.angles);

  // set onground, watertype, and waterlevel
  PM_CatagorizePosition();

  if (pmState.waterlevel === 2) CheckWaterJump();

  if (pmove.velocity[2] < 0) pmove.waterjumptime = 0;

  if (pmove.cmd.buttons & BUTTON_JUMP) JumpButton();
  else pmove.oldbuttons &= ~BUTTON_JUMP;

  PM_Friction();

  if (pmState.waterlevel >= 2) PM_WaterMove();
  else PM_AirMove();

  // set onground, watertype, and waterlevel for final spot
  PM_CatagorizePosition();
}
