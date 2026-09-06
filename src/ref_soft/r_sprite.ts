/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_sprite.c (GNU GPL v2 or later).

r_sprite.c: builds the world-space sprite quad for the current entity's
frame, clips it against the view frustum (view_clipplanes, r_draw.c/r_main.c,
U062/U066), projects the surviving polygon, and hands it to D_DrawSprite
(d_sprite.c, U065).

Deviations from PORTING.md / the C source:
- `vec5_t` (`float[5]`: worldspace x,y,z then s,t) stays `Vec5` (mathlib.ts's
  `Float32Array` alias); `clip_verts[2][MAXWORKINGVERTS]` becomes two
  module-private pools of `Vec5`, sized exactly `MAXWORKINGVERTS` like the
  C array (the same induction the C relies on holds here: R_SetupAndDrawSprite
  Sys_Errors the moment a clip pass returns `nump >= MAXWORKINGVERTS`, so
  every `nump` a later R_ClipSpriteFace call receives is already `<
  MAXWORKINGVERTS`, keeping the wraparound write at index `nump` in bounds).
- `dists[i] = DotProduct(instep, pclipnormal) - clipdist` reads only the
  first three (x,y,z) components of the five-float vertex; ported as
  `DotProduct(vert.subarray(0, 3), pclipnormal)`, a zero-copy view rather
  than a new Vec3.
- `emitpoint_t outverts[MAXWORKINGVERTS+1]` is a stack local in the C,
  reused every call; ported as a module-private pool of the same size (the
  "+1" is d_iface.ts's documented "room for an extra element at [nump]"
  contract for `spritedesc_t.pverts`), mutated in place like every other
  finalvert/auxvert pool in this renderer.
- `R_GetSpriteframe`'s `mspriteframe_t *`/`mspritegroup_t *` come from
  `mspriteframedesc_t.frameptr`'s `MspriteframeT | MspritegroupT | null`
  union (model_types.ts); narrowed with `instanceof`, not a cast.
- `psprite = currententity->model->cache.data` (a raw `void *`) becomes
  `Mod_Extradata(model)` narrowed with `instanceof MspriteT`, per this
  unit's RULINGS.
- `TransformVector` (r_misc.c, U062) and `D_DrawSprite` (d_sprite.c, U065)
  landed concurrently with this unit; imported from "./r_misc" / "./d_sprite"
  by name, per PORTING.md.
*/

import { AngleVectors, DotProduct, M_PI, VectorAdd, VectorNormalize, VectorScale, VectorSubtract, type Vec3, type Vec5, vec3 } from "../common/mathlib";
import { ROLL } from "../common/quakedef";
import { Mod_Extradata } from "../common/model";
import { MspriteT, MspriteframeT, MspritegroupT } from "./model_types";
import {
  SPR_FACING_UPRIGHT,
  SPR_ORIENTED,
  SPR_VP_PARALLEL,
  SPR_VP_PARALLEL_ORIENTED,
  SPR_VP_PARALLEL_UPRIGHT,
  SpriteframetypeT,
} from "../common/spritegn";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import { cl } from "../client/client";
import { EmitpointT, r_spritedesc } from "./d_iface";
import { ClipplaneT, MAXWORKINGVERTS, NEAR_CLIP, modelorg, r_entorigin, r_origin, rState, view_clipplanes, vpn, vright, vup } from "./r_local";
import { D_DrawSprite } from "./d_sprite";
import { TransformVector } from "./r_misc";

let clip_current = 0;
const clip_verts: [Vec5[], Vec5[]] = [
  Array.from({ length: MAXWORKINGVERTS }, () => new Float32Array(5)),
  Array.from({ length: MAXWORKINGVERTS }, () => new Float32Array(5)),
];
let sprite_width = 0;
let sprite_height = 0;

const outvertsPool: EmitpointT[] = Array.from({ length: MAXWORKINGVERTS + 1 }, () => new EmitpointT());

/*
================
R_RotateSprite
================
*/
export function R_RotateSprite(beamlength: number): void {
  if (beamlength === 0.0) return;

  const vec: Vec3 = vec3();
  VectorScale(r_spritedesc.vpn, -beamlength, vec);
  VectorAdd(r_entorigin, vec, r_entorigin);
  VectorSubtract(modelorg, vec, modelorg);
}

/*
=============
R_ClipSpriteFace

Clips the winding at clip_verts[clip_current] and changes clip_current
Throws out the back side
==============
*/
function R_ClipSpriteFace(nump: number, pclipplane: ClipplaneT): number {
  const clipdist = pclipplane.dist;
  const pclipnormal = pclipplane.normal;

  let inArr: Vec5[];
  let outArr: Vec5[];
  if (clip_current) {
    inArr = clip_verts[1];
    outArr = clip_verts[0];
    clip_current = 0;
  } else {
    inArr = clip_verts[0];
    outArr = clip_verts[1];
    clip_current = 1;
  }

  // calc dists
  const dists: Float32Array = new Float32Array(MAXWORKINGVERTS + 1);
  for (let i = 0; i < nump; i++) {
    dists[i] = DotProduct(inArr[i].subarray(0, 3), pclipnormal) - clipdist;
  }

  // handle wraparound case
  dists[nump] = dists[0];
  inArr[nump].set(inArr[0]);

  // clip the winding
  let outcount = 0;

  for (let i = 0; i < nump; i++) {
    if (dists[i] >= 0) {
      outArr[outcount].set(inArr[i]);
      outcount++;
    }

    if (dists[i] === 0 || dists[i + 1] === 0) continue;

    if (dists[i] > 0 === dists[i + 1] > 0) continue;

    // split it into a new vertex
    const frac = dists[i] / (dists[i] - dists[i + 1]);

    const instep = inArr[i];
    const vert2 = inArr[i + 1];
    const outstep = outArr[outcount];

    outstep[0] = instep[0] + frac * (vert2[0] - instep[0]);
    outstep[1] = instep[1] + frac * (vert2[1] - instep[1]);
    outstep[2] = instep[2] + frac * (vert2[2] - instep[2]);
    outstep[3] = instep[3] + frac * (vert2[3] - instep[3]);
    outstep[4] = instep[4] + frac * (vert2[4] - instep[4]);

    outcount++;
  }

  return outcount;
}

/*
================
R_SetupAndDrawSprite
================
*/
export function R_SetupAndDrawSprite(): void {
  const dot = DotProduct(r_spritedesc.vpn, modelorg);

  // backface cull
  if (dot >= 0) return;

  if (r_spritedesc.pspriteframe === null) Sys_Error("R_SetupAndDrawSprite: no sprite frame");
  const frame = r_spritedesc.pspriteframe;

  // build the sprite poster in worldspace
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();
  const left: Vec3 = vec3();
  const down: Vec3 = vec3();
  VectorScale(r_spritedesc.vright, frame.right, right);
  VectorScale(r_spritedesc.vup, frame.up, up);
  VectorScale(r_spritedesc.vright, frame.left, left);
  VectorScale(r_spritedesc.vup, frame.down, down);

  const pverts = clip_verts[0];

  pverts[0][0] = r_entorigin[0] + up[0] + left[0];
  pverts[0][1] = r_entorigin[1] + up[1] + left[1];
  pverts[0][2] = r_entorigin[2] + up[2] + left[2];
  pverts[0][3] = 0;
  pverts[0][4] = 0;

  pverts[1][0] = r_entorigin[0] + up[0] + right[0];
  pverts[1][1] = r_entorigin[1] + up[1] + right[1];
  pverts[1][2] = r_entorigin[2] + up[2] + right[2];
  pverts[1][3] = sprite_width;
  pverts[1][4] = 0;

  pverts[2][0] = r_entorigin[0] + down[0] + right[0];
  pverts[2][1] = r_entorigin[1] + down[1] + right[1];
  pverts[2][2] = r_entorigin[2] + down[2] + right[2];
  pverts[2][3] = sprite_width;
  pverts[2][4] = sprite_height;

  pverts[3][0] = r_entorigin[0] + down[0] + left[0];
  pverts[3][1] = r_entorigin[1] + down[1] + left[1];
  pverts[3][2] = r_entorigin[2] + down[2] + left[2];
  pverts[3][3] = 0;
  pverts[3][4] = sprite_height;

  // clip to the frustum in worldspace
  let nump = 4;
  clip_current = 0;

  for (let i = 0; i < 4; i++) {
    nump = R_ClipSpriteFace(nump, view_clipplanes[i]);
    if (nump < 3) return;
    if (nump >= MAXWORKINGVERTS) Sys_Error("R_SetupAndDrawSprite: too many points");
  }

  // transform vertices into viewspace and project
  const activeVerts = clip_verts[clip_current];
  r_spritedesc.nearzi = -999999;

  const local: Vec3 = vec3();
  const transformed: Vec3 = vec3();

  for (let i = 0; i < nump; i++) {
    const pv = activeVerts[i];

    VectorSubtract(pv.subarray(0, 3), r_origin, local);
    TransformVector(local, transformed);

    if (transformed[2] < NEAR_CLIP) transformed[2] = NEAR_CLIP;

    const pout = outvertsPool[i];
    pout.zi = 1.0 / transformed[2];
    if (pout.zi > r_spritedesc.nearzi) r_spritedesc.nearzi = pout.zi;

    pout.s = pv[3];
    pout.t = pv[4];

    let scale = rState.xscale * pout.zi;
    pout.u = rState.xcenter + scale * transformed[0];

    scale = rState.yscale * pout.zi;
    pout.v = rState.ycenter - scale * transformed[1];
  }

  // draw it
  r_spritedesc.nump = nump;
  r_spritedesc.pverts = outvertsPool;
  D_DrawSprite();
}

/*
================
R_GetSpriteframe
================
*/
export function R_GetSpriteframe(psprite: MspriteT): MspriteframeT {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_GetSpriteframe: no current entity");

  let frame = ent.frame;

  if (frame >= psprite.numframes || frame < 0) {
    Con_Printf("R_DrawSprite: no such frame %d\n", frame);
    frame = 0;
  }

  const desc = psprite.frames[frame];

  if (desc.type === SpriteframetypeT.SPR_SINGLE) {
    if (!(desc.frameptr instanceof MspriteframeT)) Sys_Error("R_GetSpriteframe: bad single frame");
    return desc.frameptr;
  }

  const pspritegroup = desc.frameptr;
  if (!(pspritegroup instanceof MspritegroupT)) Sys_Error("R_GetSpriteframe: bad frame group");

  const pintervals = pspritegroup.intervals;
  const numframes = pspritegroup.numframes;
  const fullinterval = pintervals[numframes - 1];

  const time = cl.time + ent.syncbase;

  // when loading in Mod_LoadSpriteGroup, we guaranteed all interval values
  // are positive, so we don't have to worry about division by 0
  const targettime = time - ((time / fullinterval) | 0) * fullinterval;

  let i = 0;
  for (; i < numframes - 1; i++) {
    if (pintervals[i] > targettime) break;
  }

  return pspritegroup.frames[i];
}

/*
================
R_DrawSprite
================
*/
export function R_DrawSprite(): void {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_DrawSprite: no current entity");
  const model = ent.model;
  if (model === null) Sys_Error("R_DrawSprite: no model");

  const data = Mod_Extradata(model);
  if (!(data instanceof MspriteT)) Sys_Error("R_DrawSprite: model has no sprite data");
  const psprite = data;

  r_spritedesc.pspriteframe = R_GetSpriteframe(psprite);

  sprite_width = r_spritedesc.pspriteframe.width;
  sprite_height = r_spritedesc.pspriteframe.height;

  if (psprite.type === SPR_FACING_UPRIGHT) {
    // generate the sprite's axes, with vup straight up in worldspace, and
    // r_spritedesc.vright perpendicular to modelorg.
    // This will not work if the view direction is very close to straight up or
    // down, because the cross product will be between two nearly parallel
    // vectors and starts to approach an undefined state, so we don't draw if
    // the two vectors are less than 1 degree apart
    const tvec: Vec3 = vec3();
    tvec[0] = -modelorg[0];
    tvec[1] = -modelorg[1];
    tvec[2] = -modelorg[2];
    VectorNormalize(tvec);
    const dot = tvec[2]; // same as DotProduct (tvec, r_spritedesc.vup) because
    //  r_spritedesc.vup is 0, 0, 1
    if (dot > 0.999848 || dot < -0.999848) return; // cos(1 degree) = 0.999848
    r_spritedesc.vup[0] = 0;
    r_spritedesc.vup[1] = 0;
    r_spritedesc.vup[2] = 1;
    r_spritedesc.vright[0] = tvec[1];
    // CrossProduct(r_spritedesc.vup, -modelorg, r_spritedesc.vright)
    r_spritedesc.vright[1] = -tvec[0];
    r_spritedesc.vright[2] = 0;
    VectorNormalize(r_spritedesc.vright);
    r_spritedesc.vpn[0] = -r_spritedesc.vright[1];
    r_spritedesc.vpn[1] = r_spritedesc.vright[0];
    r_spritedesc.vpn[2] = 0;
    // CrossProduct (r_spritedesc.vright, r_spritedesc.vup, r_spritedesc.vpn)
  } else if (psprite.type === SPR_VP_PARALLEL) {
    // generate the sprite's axes, completely parallel to the viewplane. There
    // are no problem situations, because the sprite is always in the same
    // position relative to the viewer
    for (let i = 0; i < 3; i++) {
      r_spritedesc.vup[i] = vup[i];
      r_spritedesc.vright[i] = vright[i];
      r_spritedesc.vpn[i] = vpn[i];
    }
  } else if (psprite.type === SPR_VP_PARALLEL_UPRIGHT) {
    // generate the sprite's axes, with vup straight up in worldspace, and
    // r_spritedesc.vright parallel to the viewplane.
    const dot = vpn[2]; // same as DotProduct (vpn, r_spritedesc.vup) because
    //  r_spritedesc.vup is 0, 0, 1
    if (dot > 0.999848 || dot < -0.999848) return; // cos(1 degree) = 0.999848
    r_spritedesc.vup[0] = 0;
    r_spritedesc.vup[1] = 0;
    r_spritedesc.vup[2] = 1;
    r_spritedesc.vright[0] = vpn[1];
    // CrossProduct (r_spritedesc.vup, vpn, r_spritedesc.vright)
    r_spritedesc.vright[1] = -vpn[0];
    r_spritedesc.vright[2] = 0;
    VectorNormalize(r_spritedesc.vright);
    r_spritedesc.vpn[0] = -r_spritedesc.vright[1];
    r_spritedesc.vpn[1] = r_spritedesc.vright[0];
    r_spritedesc.vpn[2] = 0;
    // CrossProduct (r_spritedesc.vright, r_spritedesc.vup, r_spritedesc.vpn)
  } else if (psprite.type === SPR_ORIENTED) {
    // generate the sprite's axes, according to the sprite's world orientation
    AngleVectors(ent.angles, r_spritedesc.vpn, r_spritedesc.vright, r_spritedesc.vup);
  } else if (psprite.type === SPR_VP_PARALLEL_ORIENTED) {
    // generate the sprite's axes, parallel to the viewplane, but rotated in
    // that plane around the center according to the sprite entity's roll
    // angle. So vpn stays the same, but vright and vup rotate
    const angle = ent.angles[ROLL] * ((M_PI * 2) / 360);
    const sr = Math.sin(angle);
    const cr = Math.cos(angle);

    for (let i = 0; i < 3; i++) {
      r_spritedesc.vpn[i] = vpn[i];
      r_spritedesc.vright[i] = vright[i] * cr + vup[i] * sr;
      r_spritedesc.vup[i] = vright[i] * -sr + vup[i] * cr;
    }
  } else {
    Sys_Error("R_DrawSprite: Bad sprite type %d", psprite.type);
  }

  R_RotateSprite(psprite.beamlength);

  R_SetupAndDrawSprite();
}
