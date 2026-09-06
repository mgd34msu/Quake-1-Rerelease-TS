/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_alias.c (GNU GPL v2 or later).

r_alias.c: the alias-model (.mdl) transform/lighting/clipping pipeline --
R_AliasDrawModel is r_main.c's (U062) per-entity call; it builds
`aliastransform` (model space -> view space), lights and clips every
vertex, and hands complete or clipped triangles to D_PolysetDraw /
R_AliasClipTriangle (d_polyse.c / r_aclip.c, U065/U063).

Deviations from PORTING.md / the C source:
- `pmodel` (`static model_t *pmodel`) and `pskindesc` (`static
  maliasskindesc_t *pskindesc`) are C file-scope statics, but each is read
  only inside the single function that assigns it (R_AliasCheckBBox and
  R_AliasSetupSkin respectively) -- grepped the whole file to confirm. Both
  are plain local variables here; no other function needs them, so nothing
  is lost keeping them off module scope.
- `r_apverts` (`trivertx_t *`) and `r_anumverts`/`aliastransform` (all
  non-static externs) ARE read across functions here (R_AliasSetupFrame
  writes `r_apverts`, R_AliasPreparePoints reads it; R_AliasSetUpTransform
  writes `aliastransform`, R_AliasTransformFinalVert reads it) and are not
  in r_shared.ts's `RStateT` ownership list for r_alias.c, so they stay
  module-private `let`/`const` state here, exported (read-only from outside)
  since their C declarations have external linkage and a `r_aclip.ts`
  (U063) sibling may need to read `aliastransform`.
- `tmatrix`/`viewmatrix` inside R_AliasSetUpTransform are C function-local
  `static` arrays, but every element either gets written every call or is
  never written at all (and is relied on to read back as the zero its
  `static` storage duration guarantees once and never loses). Ported as
  fresh `mat3x4()` locals each call: `Float32Array` rows already read back
  as 0 before any write, so the never-written slots (`tmatrix`'s six
  off-diagonal entries, `viewmatrix`'s three translation columns) come out
  identical to the C's permanently-zero statics.
- `DotProduct` (mathlib.ts) is typed `(Vec3, Vec3) => number` where `Vec3 =
  Float32Array`; `trivertx_t.v` is `TrivertxT.v: Uint8Array` (unsigned byte
  triple) here, so `DotProduct(pverts->v, aliastransform[N])` is inlined as
  three multiply-adds in R_AliasTransformFinalVert and
  R_AliasTransformAndProjectFinalVerts rather than calling DotProduct on a
  byte array DotProduct's signature does not accept.
- `r_avertexnormals[NUMVERTEXNORMALS][3]` is a flat `Float32Array` on
  src/client/r_part.ts (already landed, re-exported through r_shared.ts /
  r_local.ts), indexed `[i*3+0/1/2]` -- the same convention r_part.ts's own
  reader already uses -- rather than a 2D array.
- `finalvert_t finalverts[MAXALIASVERTS + ((CACHE_SIZE-1)/sizeof(finalvert_t))
  + 1]` and `auxvert_t auxverts[MAXALIASVERTS]` are R_AliasDrawModel stack
  locals in C, cache-aligned by hand (`pfinalverts = (finalvert_t*)(((long)
  &finalverts[0] + CACHE_SIZE - 1) & ~(CACHE_SIZE - 1));`). This port has no
  pointer alignment concern, so both pools are `allocFinalverts(MAXALIASVERTS)`
  / `allocAuxverts(MAXALIASVERTS)` module-level singletons sized exactly
  `MAXALIASVERTS` (the cache-line pad bytes existed only to keep the x86
  FPU/asm code aligned) -- same reasoning quake-2-ts's r_alias.ts documents
  for its own dropped `CACHE_SIZE` trick. `rState.pfinalverts`/`.pauxverts`
  are assigned these pools once per R_AliasDrawModel call, exactly where the
  C reassigns the (there, cache-aligned) pointers.
- `r_affinetridesc.ptriangles = ptri;` inside R_AliasPreparePoints's
  unclipped-triangle branch points the C's moving `mtriangle_t *` at exactly
  the CURRENT triangle, paired with `numtriangles = 1`, so D_PolysetDraw
  reads exactly that one triangle. `AffinetridescT.ptriangles` here is a
  plain `MtriangleT[]` with no pointer offset, so this port passes a
  one-element `[tri]` array instead of slicing the full array -- same
  single triangle D_PolysetDraw would read either way.
- `R_AliasClipTriangle` (r_aclip.c, U063) and `D_PolysetDraw` /
  `D_PolysetDrawFinalVerts` / `D_PolysetUpdateTables` (d_polyse.c, U065)
  landed concurrently with this unit; imported from "./r_aclip" /
  "./d_polyse" by name, per PORTING.md.
- Dropped `#if id386` branch: R_AliasTransformFinalVerts's asm body (the
  portable `#else` fallback is the only one ported, matching the file's own
  `#if !id386` guard around it) and the `D_Aff8Patch` call in
  R_AliasDrawModel's `#if id386` branch.
*/

import { AngleVectors, DotProduct, R_ConcatTransforms, VectorCopy, VectorInverse, type Mat3x4, type Vec3, vec3 } from "../common/mathlib";
import { PITCH, ROLL, YAW } from "../common/quakedef";
import { AliasframetypeT, AliasskintypeT, type StvertT, type TrivertxT } from "../common/modelgen";
import { Mod_Extradata } from "../common/model";
import { Con_DPrintf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import { cl } from "../client/client";
import { qw } from "../common/quakedef";
import type * as SkinModule from "../qw/client/skin";

// QW skin.c reaches the whole QuakeWorld client (skin.c -> cl_parse.c ->
// cl_main.c -> ...). A static import would pull all of it into every
// software-renderer build and put a client module in the renderer's load
// graph; resolved lazily with Bun's synchronous require(), the same
// mechanism src/common/host.ts uses for its own import-cycle breaks. Only
// reached with qw.active, so the WinQuake binary never loads it.
function skinMod(): typeof SkinModule {
  return require("../qw/client/skin");
}
import { VID_CBITS, VID_GRADES } from "../client/vid";
import { AliashdrT, MaliasgroupT, MaliasskingroupT, type MaliasskindescT } from "./model_types";
import { r_affinetridesc } from "./d_iface";
import {
  ALIAS_BOTTOM_CLIP,
  ALIAS_LEFT_CLIP,
  ALIAS_RIGHT_CLIP,
  ALIAS_TOP_CLIP,
  ALIAS_XY_CLIP_MASK,
  ALIAS_Z_CLIP,
  ALIAS_Z_CLIP_PLANE,
  type AlightT,
  type AuxvertT,
  FinalvertT,
  MAXALIASVERTS,
  allocAuxverts,
  allocFinalverts,
  modelorg,
  r_avertexnormals,
  r_plightvec,
  r_refdef,
  rState,
  vpn,
  vright,
  vup,
} from "./r_local";
import { R_AliasClipTriangle } from "./r_aclip";
import { D_PolysetDraw, D_PolysetDrawFinalVerts, D_PolysetUpdateTables } from "./d_polyse";

const LIGHT_MIN = 5; // lowest light value we'll allow, to avoid the
//  need for inner-loop light clamping

function mat3x4(): Mat3x4 {
  return [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
}

// TODO: these probably will go away with optimized rasterization
export let r_apverts: TrivertxT[] | null = null;
export let r_anumverts = 0;
export const aliastransform: Mat3x4 = mat3x4();

const alias_forward: Vec3 = vec3();
const alias_right: Vec3 = vec3();
const alias_up: Vec3 = vec3();

let ziscale = 0;

const finalvertsPool: FinalvertT[] = allocFinalverts(MAXALIASVERTS);
const auxvertsPool: AuxvertT[] = allocAuxverts(MAXALIASVERTS);

const AEDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 5],
  [1, 4],
  [2, 7],
  [3, 6],
];

/*
================
R_AliasCheckBBox
================
*/
export function R_AliasCheckBBox(): boolean {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_AliasCheckBBox: no current entity");

  // expand, rotate, and translate points into worldspace
  ent.trivial_accept = 0;
  const pmodel = ent.model;
  if (pmodel === null) Sys_Error("R_AliasCheckBBox: no model");
  const data = Mod_Extradata(pmodel);
  if (!(data instanceof AliashdrT)) Sys_Error("R_AliasCheckBBox: model has no alias data");
  const pahdr = data;
  rState.paliashdr = pahdr;
  if (pahdr.model === null) Sys_Error("R_AliasCheckBBox: no mdl_t");
  const pmdl = pahdr.model;
  rState.pmdl = pmdl;

  R_AliasSetUpTransform(0);

  // construct the base bounding box for this frame
  let frame = ent.frame;
  // TODO: don't repeat this check when drawing?
  if (frame >= pmdl.numframes || frame < 0) {
    Con_DPrintf("No such frame %d %s\n", frame, pmodel.name);
    frame = 0;
  }

  const pframedesc = pahdr.frames[frame];

  const basepts: Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()];

  // x worldspace coordinates
  basepts[0][0] = basepts[1][0] = basepts[2][0] = basepts[3][0] = pframedesc.bboxmin.v[0];
  basepts[4][0] = basepts[5][0] = basepts[6][0] = basepts[7][0] = pframedesc.bboxmax.v[0];

  // y worldspace coordinates
  basepts[0][1] = basepts[3][1] = basepts[5][1] = basepts[6][1] = pframedesc.bboxmin.v[1];
  basepts[1][1] = basepts[2][1] = basepts[4][1] = basepts[7][1] = pframedesc.bboxmax.v[1];

  // z worldspace coordinates
  basepts[0][2] = basepts[1][2] = basepts[4][2] = basepts[5][2] = pframedesc.bboxmin.v[2];
  basepts[2][2] = basepts[3][2] = basepts[6][2] = basepts[7][2] = pframedesc.bboxmax.v[2];

  let zclipped = false;
  let zfullyclipped = true;

  let minz = 9999;

  const viewaux: Vec3[] = Array.from({ length: 16 }, () => vec3());
  const viewflags: number[] = new Array<number>(16).fill(0);

  for (let i = 0; i < 8; i++) {
    R_AliasTransformVector(basepts[i], viewaux[i]);

    if (viewaux[i][2] < ALIAS_Z_CLIP_PLANE) {
      // we must clip points that are closer than the near clip plane
      viewflags[i] = ALIAS_Z_CLIP;
      zclipped = true;
    } else {
      if (viewaux[i][2] < minz) minz = viewaux[i][2];
      viewflags[i] = 0;
      zfullyclipped = false;
    }
  }

  if (zfullyclipped) {
    return false; // everything was near-z-clipped
  }

  let numv = 8;

  if (zclipped) {
    // organize points by edges, use edges to get new points (possible trivial
    // reject)
    for (let i = 0; i < 12; i++) {
      // edge endpoints
      const i0 = AEDGES[i][0];
      const i1 = AEDGES[i][1];

      // if one end is clipped and the other isn't, make a new point
      if ((viewflags[i0] ^ viewflags[i1]) !== 0) {
        const frac = (ALIAS_Z_CLIP_PLANE - viewaux[i0][2]) / (viewaux[i1][2] - viewaux[i0][2]);
        viewaux[numv][0] = viewaux[i0][0] + (viewaux[i1][0] - viewaux[i0][0]) * frac;
        viewaux[numv][1] = viewaux[i0][1] + (viewaux[i1][1] - viewaux[i0][1]) * frac;
        viewaux[numv][2] = ALIAS_Z_CLIP_PLANE;
        viewflags[numv] = 0;
        numv++;
      }
    }
  }

  // project the vertices that remain after clipping
  let anyclip = 0;
  let allclip = ALIAS_XY_CLIP_MASK;

  // TODO: probably should do this loop in ASM, especially if we use floats
  for (let i = 0; i < numv; i++) {
    // we don't need to bother with vertices that were z-clipped
    if (viewflags[i] & ALIAS_Z_CLIP) continue;

    const zi = 1.0 / viewaux[i][2];

    // FIXME: do with chop mode in ASM, or convert to float
    const v0 = viewaux[i][0] * rState.xscale * zi + rState.xcenter;
    const v1 = viewaux[i][1] * rState.yscale * zi + rState.ycenter;

    let flags = 0;

    if (v0 < r_refdef.fvrectx) flags |= ALIAS_LEFT_CLIP;
    if (v1 < r_refdef.fvrecty) flags |= ALIAS_TOP_CLIP;
    if (v0 > r_refdef.fvrectright) flags |= ALIAS_RIGHT_CLIP;
    if (v1 > r_refdef.fvrectbottom) flags |= ALIAS_BOTTOM_CLIP;

    anyclip |= flags;
    allclip &= flags;
  }

  if (allclip) return false; // trivial reject off one side

  ent.trivial_accept = anyclip === 0 && !zclipped ? 1 : 0;

  if (ent.trivial_accept) {
    if (minz > rState.r_aliastransition + pmdl.size * rState.r_resfudge) {
      ent.trivial_accept |= 2;
    }
  }

  return true;
}

/*
================
R_AliasTransformVector
================
*/
export function R_AliasTransformVector(inV: Vec3, out: Vec3): void {
  out[0] = DotProduct(inV, aliastransform[0]) + aliastransform[0][3];
  out[1] = DotProduct(inV, aliastransform[1]) + aliastransform[1][3];
  out[2] = DotProduct(inV, aliastransform[2]) + aliastransform[2][3];
}

/*
================
R_AliasPreparePoints

General clipped case
================
*/
export function R_AliasPreparePoints(): void {
  const pahdr = rState.paliashdr;
  const pmdl = rState.pmdl;
  if (pahdr === null || pmdl === null) Sys_Error("R_AliasPreparePoints: not set up");
  if (r_apverts === null) Sys_Error("R_AliasPreparePoints: no frame verts");
  const fv = rState.pfinalverts;
  const av = rState.pauxverts;
  if (fv === null || av === null) Sys_Error("R_AliasPreparePoints: no vertex pools");

  const pstverts = pahdr.stverts;
  r_anumverts = pmdl.numverts;

  for (let i = 0; i < r_anumverts; i++) {
    R_AliasTransformFinalVert(fv[i], av[i], r_apverts[i], pstverts[i]);
    if (av[i].fv[2] < ALIAS_Z_CLIP_PLANE) {
      fv[i].flags |= ALIAS_Z_CLIP;
    } else {
      R_AliasProjectFinalVert(fv[i], av[i]);

      if (fv[i].v[0] < r_refdef.aliasvrect.x) fv[i].flags |= ALIAS_LEFT_CLIP;
      if (fv[i].v[1] < r_refdef.aliasvrect.y) fv[i].flags |= ALIAS_TOP_CLIP;
      if (fv[i].v[0] > r_refdef.aliasvrectright) fv[i].flags |= ALIAS_RIGHT_CLIP;
      if (fv[i].v[1] > r_refdef.aliasvrectbottom) fv[i].flags |= ALIAS_BOTTOM_CLIP;
    }
  }

  //
  // clip and draw all triangles
  //
  r_affinetridesc.numtriangles = 1;

  const ptri = pahdr.triangles;
  for (let i = 0; i < pmdl.numtris; i++) {
    const tri = ptri[i];

    const pfv0 = fv[tri.vertindex[0]];
    const pfv1 = fv[tri.vertindex[1]];
    const pfv2 = fv[tri.vertindex[2]];

    if (pfv0.flags & pfv1.flags & pfv2.flags & (ALIAS_XY_CLIP_MASK | ALIAS_Z_CLIP)) continue; // completely clipped

    if (!((pfv0.flags | pfv1.flags | pfv2.flags) & (ALIAS_XY_CLIP_MASK | ALIAS_Z_CLIP))) {
      // totally unclipped
      r_affinetridesc.pfinalverts = fv;
      r_affinetridesc.ptriangles = [tri];
      D_PolysetDraw();
    } else {
      // partially clipped
      R_AliasClipTriangle(tri);
    }
  }
}

/*
================
R_AliasSetUpTransform
================
*/
export function R_AliasSetUpTransform(trivial_accept: number): void {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_AliasSetUpTransform: no current entity");
  const pmdl = rState.pmdl;
  if (pmdl === null) Sys_Error("R_AliasSetUpTransform: no mdl");

  // TODO: should really be stored with the entity instead of being reconstructed
  // TODO: should use a look-up table
  // TODO: could cache lazily, stored in the entity
  const angles: Vec3 = vec3();
  angles[ROLL] = ent.angles[ROLL];
  angles[PITCH] = -ent.angles[PITCH];
  angles[YAW] = ent.angles[YAW];
  AngleVectors(angles, alias_forward, alias_right, alias_up);

  const tmatrix = mat3x4();
  tmatrix[0][0] = pmdl.scale[0];
  tmatrix[1][1] = pmdl.scale[1];
  tmatrix[2][2] = pmdl.scale[2];

  tmatrix[0][3] = pmdl.scale_origin[0];
  tmatrix[1][3] = pmdl.scale_origin[1];
  tmatrix[2][3] = pmdl.scale_origin[2];

  // TODO: can do this with simple matrix rearrangement
  const t2matrix = mat3x4();
  for (let i = 0; i < 3; i++) {
    t2matrix[i][0] = alias_forward[i];
    t2matrix[i][1] = -alias_right[i];
    t2matrix[i][2] = alias_up[i];
  }

  t2matrix[0][3] = -modelorg[0];
  t2matrix[1][3] = -modelorg[1];
  t2matrix[2][3] = -modelorg[2];

  // FIXME: can do more efficiently than full concatenation
  const rotationmatrix = mat3x4();
  R_ConcatTransforms(t2matrix, tmatrix, rotationmatrix);

  // TODO: should be global, set when vright, etc., set
  const viewmatrix = mat3x4();
  VectorCopy(vright, viewmatrix[0]);
  VectorCopy(vup, viewmatrix[1]);
  VectorInverse(viewmatrix[1]);
  VectorCopy(vpn, viewmatrix[2]);

  // viewmatrix[0][3] = 0;
  // viewmatrix[1][3] = 0;
  // viewmatrix[2][3] = 0;

  R_ConcatTransforms(viewmatrix, rotationmatrix, aliastransform);

  // do the scaling up of x and y to screen coordinates as part of the transform
  // for the unclipped case (it would mess up clipping in the clipped case).
  // Also scale down z, so 1/z is scaled 31 bits for free, and scale down x and y
  // correspondingly so the projected x and y come out right
  // FIXME: make this work for clipped case too?
  if (trivial_accept) {
    for (let i = 0; i < 4; i++) {
      aliastransform[0][i] *= rState.aliasxscale * (1.0 / (0x8000 * 0x10000));
      aliastransform[1][i] *= rState.aliasyscale * (1.0 / (0x8000 * 0x10000));
      aliastransform[2][i] *= 1.0 / (0x8000 * 0x10000);
    }
  }
}

/*
================
R_AliasTransformFinalVert
================
*/
export function R_AliasTransformFinalVert(fv: FinalvertT, av: AuxvertT, pverts: TrivertxT, pstverts: StvertT): void {
  const v = pverts.v;
  av.fv[0] = v[0] * aliastransform[0][0] + v[1] * aliastransform[0][1] + v[2] * aliastransform[0][2] + aliastransform[0][3];
  av.fv[1] = v[0] * aliastransform[1][0] + v[1] * aliastransform[1][1] + v[2] * aliastransform[1][2] + aliastransform[1][3];
  av.fv[2] = v[0] * aliastransform[2][0] + v[1] * aliastransform[2][1] + v[2] * aliastransform[2][2] + aliastransform[2][3];

  fv.v[2] = pstverts.s;
  fv.v[3] = pstverts.t;

  fv.flags = pstverts.onseam;

  // lighting
  const ni = pverts.lightnormalindex * 3;
  const nx = r_avertexnormals[ni];
  const ny = r_avertexnormals[ni + 1];
  const nz = r_avertexnormals[ni + 2];
  const lightcos = nx * r_plightvec[0] + ny * r_plightvec[1] + nz * r_plightvec[2];
  let temp = rState.r_ambientlight;

  if (lightcos < 0) {
    temp += (rState.r_shadelight * lightcos) | 0;

    // clamp; because we limited the minimum ambient and shading light, we
    // don't have to clamp low light, just bright
    if (temp < 0) temp = 0;
  }

  fv.v[4] = temp;
}

/*
================
R_AliasTransformAndProjectFinalVerts

Portable (non-id386-asm) C fallback only -- see file header comment.
================
*/
function R_AliasTransformAndProjectFinalVerts(fv: FinalvertT[], pstverts: StvertT[]): void {
  if (r_apverts === null) Sys_Error("R_AliasTransformAndProjectFinalVerts: no frame verts");
  const pverts = r_apverts;

  for (let i = 0; i < r_anumverts; i++) {
    const p = pverts[i];
    const v = p.v;

    // transform and project
    const zi = 1.0 / (v[0] * aliastransform[2][0] + v[1] * aliastransform[2][1] + v[2] * aliastransform[2][2] + aliastransform[2][3]);

    // x, y, and z are scaled down by 1/2**31 in the transform, so 1/z is
    // scaled up by 1/2**31, and the scaling cancels out for x and y in the
    // projection
    const f = fv[i];
    f.v[5] = zi;

    f.v[0] = (v[0] * aliastransform[0][0] + v[1] * aliastransform[0][1] + v[2] * aliastransform[0][2] + aliastransform[0][3]) * zi + rState.aliasxcenter;
    f.v[1] = (v[0] * aliastransform[1][0] + v[1] * aliastransform[1][1] + v[2] * aliastransform[1][2] + aliastransform[1][3]) * zi + rState.aliasycenter;

    f.v[2] = pstverts[i].s;
    f.v[3] = pstverts[i].t;
    f.flags = pstverts[i].onseam;

    // lighting
    const ni = p.lightnormalindex * 3;
    const nx = r_avertexnormals[ni];
    const ny = r_avertexnormals[ni + 1];
    const nz = r_avertexnormals[ni + 2];
    const lightcos = nx * r_plightvec[0] + ny * r_plightvec[1] + nz * r_plightvec[2];
    let temp = rState.r_ambientlight;

    if (lightcos < 0) {
      temp += (rState.r_shadelight * lightcos) | 0;

      // clamp; because we limited the minimum ambient and shading light, we
      // don't have to clamp low light, just bright
      if (temp < 0) temp = 0;
    }

    f.v[4] = temp;
  }
}

/*
================
R_AliasProjectFinalVert
================
*/
export function R_AliasProjectFinalVert(fv: FinalvertT, av: AuxvertT): void {
  // project points
  const zi = 1.0 / av.fv[2];

  fv.v[5] = zi * ziscale;

  fv.v[0] = av.fv[0] * rState.aliasxscale * zi + rState.aliasxcenter;
  fv.v[1] = av.fv[1] * rState.aliasyscale * zi + rState.aliasycenter;
}

/*
================
R_AliasPrepareUnclippedPoints
================
*/
export function R_AliasPrepareUnclippedPoints(): void {
  const pahdr = rState.paliashdr;
  const pmdl = rState.pmdl;
  if (pahdr === null || pmdl === null) Sys_Error("R_AliasPrepareUnclippedPoints: not set up");
  const fv = rState.pfinalverts;
  if (fv === null) Sys_Error("R_AliasPrepareUnclippedPoints: no finalverts");

  const pstverts = pahdr.stverts;
  r_anumverts = pmdl.numverts;

  R_AliasTransformAndProjectFinalVerts(fv, pstverts);

  if (r_affinetridesc.drawtype) {
    D_PolysetDrawFinalVerts(fv, r_anumverts);
  }

  r_affinetridesc.pfinalverts = fv;
  r_affinetridesc.ptriangles = pahdr.triangles;
  r_affinetridesc.numtriangles = pmdl.numtris;

  D_PolysetDraw();
}

/*
===============
R_AliasSetupSkin
===============
*/
export function R_AliasSetupSkin(): void {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_AliasSetupSkin: no current entity");
  const pmdl = rState.pmdl;
  const pahdr = rState.paliashdr;
  if (pmdl === null || pahdr === null) Sys_Error("R_AliasSetupSkin: not set up");

  let skinnum = ent.skinnum;
  if (skinnum >= pmdl.numskins || skinnum < 0) {
    Con_DPrintf("R_AliasSetupSkin: no such skin # %d\n", skinnum);
    skinnum = 0;
  }

  let pskindesc: MaliasskindescT = pahdr.skindesc[skinnum];
  rState.a_skinwidth = pmdl.skinwidth;

  if (pskindesc.type === AliasskintypeT.ALIAS_SKIN_GROUP) {
    const paliasskingroup = pskindesc.skin;
    if (!(paliasskingroup instanceof MaliasskingroupT)) Sys_Error("R_AliasSetupSkin: bad skin group");

    const pskinintervals = paliasskingroup.intervals;
    const numskins = paliasskingroup.numskins;
    const fullskininterval = pskinintervals[numskins - 1];

    const skintime = cl.time + ent.syncbase;

    // when loading in Mod_LoadAliasSkinGroup, we guaranteed all interval
    // values are positive, so we don't have to worry about division by 0
    const skintargettime = skintime - ((skintime / fullskininterval) | 0) * fullskininterval;

    let i = 0;
    for (; i < numskins - 1; i++) {
      if (pskinintervals[i] > skintargettime) break;
    }

    pskindesc = paliasskingroup.skindescs[i];
  }

  if (!(pskindesc.skin instanceof Uint8Array)) Sys_Error("R_AliasSetupSkin: bad single skin");

  r_affinetridesc.pskindesc = pskindesc;
  r_affinetridesc.pskin = pskindesc.skin;
  r_affinetridesc.skinwidth = rState.a_skinwidth;
  r_affinetridesc.seamfixupX16 = (rState.a_skinwidth >> 1) << 16;
  r_affinetridesc.skinheight = pmdl.skinheight;

  // QW/client/r_alias.c appends this to R_AliasSetupSkin: the connected
  // player's downloaded skin overrides the model's own, so player models
  // don't all wear the pak0 default.
  if (qw.active && ent.scoreboard !== null) {
    const sc = ent.scoreboard;
    if (!sc.skin) skinMod().Skin_Find(sc);
    // Skin_Find leaves sc.skin null only on its ran-out-of-slots flush path;
    // the C dereferences it regardless.
    const base = sc.skin !== null ? skinMod().Skin_Cache(sc.skin) : null;
    if (base) {
      r_affinetridesc.pskin = base;
      r_affinetridesc.skinwidth = 320;
      r_affinetridesc.skinheight = 200;
    }
  }
}

/*
================
R_AliasSetupLighting
================
*/
export function R_AliasSetupLighting(plighting: AlightT): void {
  // guarantee that no vertex will ever be lit below LIGHT_MIN, so we don't have
  // to clamp off the bottom
  rState.r_ambientlight = plighting.ambientlight;

  if (rState.r_ambientlight < LIGHT_MIN) rState.r_ambientlight = LIGHT_MIN;

  rState.r_ambientlight = (255 - rState.r_ambientlight) << VID_CBITS;

  if (rState.r_ambientlight < LIGHT_MIN) rState.r_ambientlight = LIGHT_MIN;

  rState.r_shadelight = plighting.shadelight;

  if (rState.r_shadelight < 0) rState.r_shadelight = 0;

  rState.r_shadelight *= VID_GRADES;

  // rotate the lighting vector into the model's frame of reference
  if (plighting.plightvec === null) Sys_Error("R_AliasSetupLighting: no plightvec");
  r_plightvec[0] = DotProduct(plighting.plightvec, alias_forward);
  r_plightvec[1] = -DotProduct(plighting.plightvec, alias_right);
  r_plightvec[2] = DotProduct(plighting.plightvec, alias_up);
}

/*
=================
R_AliasSetupFrame

set r_apverts
=================
*/
export function R_AliasSetupFrame(): void {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_AliasSetupFrame: no current entity");
  const pmdl = rState.pmdl;
  const pahdr = rState.paliashdr;
  if (pmdl === null || pahdr === null) Sys_Error("R_AliasSetupFrame: not set up");

  let frame = ent.frame;
  if (frame >= pmdl.numframes || frame < 0) {
    Con_DPrintf("R_AliasSetupFrame: no such frame %d\n", frame);
    frame = 0;
  }

  const framedesc = pahdr.frames[frame];

  if (framedesc.type === AliasframetypeT.ALIAS_SINGLE) {
    if (!Array.isArray(framedesc.frame)) Sys_Error("R_AliasSetupFrame: bad single frame");
    r_apverts = framedesc.frame;
    return;
  }

  const paliasgroup = framedesc.frame;
  if (!(paliasgroup instanceof MaliasgroupT)) Sys_Error("R_AliasSetupFrame: bad frame group");

  const pintervals = paliasgroup.intervals;
  const numframes = paliasgroup.numframes;
  const fullinterval = pintervals[numframes - 1];

  const time = cl.time + ent.syncbase;

  //
  // when loading in Mod_LoadAliasGroup, we guaranteed all interval values
  // are positive, so we don't have to worry about division by 0
  //
  const targettime = time - ((time / fullinterval) | 0) * fullinterval;

  let i = 0;
  for (; i < numframes - 1; i++) {
    if (pintervals[i] > targettime) break;
  }

  r_apverts = paliasgroup.frames[i].frame;
}

/*
================
R_AliasDrawModel
================
*/
export function R_AliasDrawModel(plighting: AlightT): void {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_AliasDrawModel: no current entity");

  rState.r_amodels_drawn++;

  // cache align: dropped, see file header comment
  rState.pfinalverts = finalvertsPool;
  rState.pauxverts = auxvertsPool;

  if (ent.model === null) Sys_Error("R_AliasDrawModel: no model");
  const data = Mod_Extradata(ent.model);
  if (!(data instanceof AliashdrT)) Sys_Error("R_AliasDrawModel: model has no alias data");
  rState.paliashdr = data;
  if (data.model === null) Sys_Error("R_AliasDrawModel: no mdl_t");
  rState.pmdl = data.model;

  R_AliasSetupSkin();
  R_AliasSetUpTransform(ent.trivial_accept);
  R_AliasSetupLighting(plighting);
  R_AliasSetupFrame();

  if (ent.colormap === null) Sys_Error("R_AliasDrawModel: !currententity->colormap");

  r_affinetridesc.drawtype = ent.trivial_accept === 3 && rState.r_recursiveaffinetriangles ? 1 : 0;

  if (r_affinetridesc.drawtype) {
    D_PolysetUpdateTables(); // FIXME: precalc...
  }
  // #if id386's D_Aff8Patch(currententity->colormap) call is dropped, see
  // file header comment.

  rState.acolormap = ent.colormap;

  if (ent !== cl.viewent) ziscale = 0x8000 * 0x10000;
  else ziscale = 0x8000 * 0x10000 * 3.0;

  if (ent.trivial_accept) R_AliasPrepareUnclippedPoints();
  else R_AliasPreparePoints();
}
