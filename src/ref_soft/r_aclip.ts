/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_aclip.c (GNU GPL v2 or later).

r_aclip.c: clip routines for drawing Alias models directly to the screen.
R_AliasClipTriangle takes one mtriangle_t whose finalverts are already
projected, runs it through the z / left / right / bottom / top clippers with
the two `fv[2][8]` buffers ping-ponging between passes, and feeds the surviving
polygon to D_PolysetDraw as a triangle fan.

Deviations from PORTING.md / the C source:
- `static finalvert_t fv[2][8]` is one contiguous 16-element block in C, and
  R_Alias_clip_z recovers a vertex's position in it with the pointer
  subtraction `pfv0 - &fv[0][0]` in order to index the parallel `av[8]`. Here
  the block is `allocFinalverts(16)` and `fv[0]`/`fv[1]` are its two halves
  (`slice`, so the objects are shared, not copied); the subtraction becomes
  `fvPool.indexOf(...)`, which yields the same 0..15 index.
- `fv[0][i] = pfinalverts[...]`, `av[i] = pauxverts[...]` and `out[k] = in[i]`
  are C struct assignments; `copyFinalvert` / `copyAuxvert` below copy the same
  fields, since the port's finalvert_t/auxvert_t are objects.
- `auxvert_t avout` and `mtriangle_t mtri` are stack locals in C. JS has no
  stack structs, so both are module-level singletons; neither routine is
  re-entrant, and in the C's case `r_affinetridesc.ptriangles = &mtri` is left
  pointing at a dead stack frame once R_AliasClipTriangle returns, so the
  module-level object is if anything better defined.
- `r_affinetridesc.ptriangles` is `MtriangleT[]` in this port, so the C's
  `&mtri` is the one-element array `mtriList`; `pfinalverts` is likewise the
  `fv[pingpong]` array itself, so `pfinalverts[i]` indexes as the C did.
- Preserved C quirk: R_Alias_clip_z sets `out->flags` from the four
  aliasvrect edges, and R_AliasClip then immediately zeroes `out[k].flags` and
  recomputes exactly the same four bits. Both are kept.
- `R_AliasProjectFinalVert` is r_alias.c's (U064) and `D_PolysetDraw` is
  d_polyse.c's (U065); both are imported by name.
- Dropped `#if id386` alternates: R_Alias_clip_left/right/top/bottom have asm
  versions; the `!id386` C bodies are ported.
*/

import { Sys_Error } from "../platform/sys";
import { MtriangleT } from "./model_types";
import { r_affinetridesc } from "./d_iface";
import {
  ALIAS_BOTTOM_CLIP,
  ALIAS_LEFT_CLIP,
  ALIAS_ONSEAM,
  ALIAS_RIGHT_CLIP,
  ALIAS_TOP_CLIP,
  ALIAS_Z_CLIP,
  ALIAS_Z_CLIP_PLANE,
  AuxvertT,
  FinalvertT,
  allocAuxverts,
  allocFinalverts,
  r_refdef,
  rState,
} from "./r_local";
import { R_AliasProjectFinalVert } from "./r_alias";
import { D_PolysetDraw } from "./d_polyse";

// static finalvert_t fv[2][8]; static auxvert_t av[8];
const fvPool: FinalvertT[] = allocFinalverts(16);
const fv: [FinalvertT[], FinalvertT[]] = [fvPool.slice(0, 8), fvPool.slice(8, 16)];
const av: AuxvertT[] = allocAuxverts(8);

// R_Alias_clip_z's `auxvert_t avout` and R_AliasClipTriangle's
// `mtriangle_t mtri`; see this file's header.
const avout: AuxvertT = new AuxvertT();
const mtri: MtriangleT = new MtriangleT();
const mtriList: MtriangleT[] = [mtri];

function copyFinalvert(src: FinalvertT, dst: FinalvertT): void {
  dst.v[0] = src.v[0];
  dst.v[1] = src.v[1];
  dst.v[2] = src.v[2];
  dst.v[3] = src.v[3];
  dst.v[4] = src.v[4];
  dst.v[5] = src.v[5];
  dst.flags = src.flags;
  dst.reserved = src.reserved;
}

function copyAuxvert(src: AuxvertT, dst: AuxvertT): void {
  dst.fv[0] = src.fv[0];
  dst.fv[1] = src.fv[1];
  dst.fv[2] = src.fv[2];
}

// the C's `pfv0 - &fv[0][0]`; see this file's header.
function fvIndex(pfv: FinalvertT): number {
  const i = fvPool.indexOf(pfv);
  if (i < 0) Sys_Error("R_Alias_clip_z: vertex is not in the clip buffer");
  return i;
}

/*
================
R_Alias_clip_z

pfv0 is the unclipped vertex, pfv1 is the z-clipped vertex
================
*/
export function R_Alias_clip_z(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  const pav0 = av[fvIndex(pfv0)];
  const pav1 = av[fvIndex(pfv1)];

  let scale: number;

  if (pfv0.v[1] >= pfv1.v[1]) {
    scale = (ALIAS_Z_CLIP_PLANE - pav0.fv[2]) / (pav1.fv[2] - pav0.fv[2]);

    avout.fv[0] = pav0.fv[0] + (pav1.fv[0] - pav0.fv[0]) * scale;
    avout.fv[1] = pav0.fv[1] + (pav1.fv[1] - pav0.fv[1]) * scale;
    avout.fv[2] = ALIAS_Z_CLIP_PLANE;

    out.v[2] = pfv0.v[2] + (pfv1.v[2] - pfv0.v[2]) * scale;
    out.v[3] = pfv0.v[3] + (pfv1.v[3] - pfv0.v[3]) * scale;
    out.v[4] = pfv0.v[4] + (pfv1.v[4] - pfv0.v[4]) * scale;
  } else {
    scale = (ALIAS_Z_CLIP_PLANE - pav1.fv[2]) / (pav0.fv[2] - pav1.fv[2]);

    avout.fv[0] = pav1.fv[0] + (pav0.fv[0] - pav1.fv[0]) * scale;
    avout.fv[1] = pav1.fv[1] + (pav0.fv[1] - pav1.fv[1]) * scale;
    avout.fv[2] = ALIAS_Z_CLIP_PLANE;

    out.v[2] = pfv1.v[2] + (pfv0.v[2] - pfv1.v[2]) * scale;
    out.v[3] = pfv1.v[3] + (pfv0.v[3] - pfv1.v[3]) * scale;
    out.v[4] = pfv1.v[4] + (pfv0.v[4] - pfv1.v[4]) * scale;
  }

  R_AliasProjectFinalVert(out, avout);

  if (out.v[0] < r_refdef.aliasvrect.x) out.flags |= ALIAS_LEFT_CLIP;
  if (out.v[1] < r_refdef.aliasvrect.y) out.flags |= ALIAS_TOP_CLIP;
  if (out.v[0] > r_refdef.aliasvrectright) out.flags |= ALIAS_RIGHT_CLIP;
  if (out.v[1] > r_refdef.aliasvrectbottom) out.flags |= ALIAS_BOTTOM_CLIP;
}

export function R_Alias_clip_left(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v[1] >= pfv1.v[1]) {
    scale = (r_refdef.aliasvrect.x - pfv0.v[0]) / (pfv1.v[0] - pfv0.v[0]);
    for (let i = 0; i < 6; i++) out.v[i] = pfv0.v[i] + (pfv1.v[i] - pfv0.v[i]) * scale + 0.5;
  } else {
    scale = (r_refdef.aliasvrect.x - pfv1.v[0]) / (pfv0.v[0] - pfv1.v[0]);
    for (let i = 0; i < 6; i++) out.v[i] = pfv1.v[i] + (pfv0.v[i] - pfv1.v[i]) * scale + 0.5;
  }
}

export function R_Alias_clip_right(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v[1] >= pfv1.v[1]) {
    scale = (r_refdef.aliasvrectright - pfv0.v[0]) / (pfv1.v[0] - pfv0.v[0]);
    for (let i = 0; i < 6; i++) out.v[i] = pfv0.v[i] + (pfv1.v[i] - pfv0.v[i]) * scale + 0.5;
  } else {
    scale = (r_refdef.aliasvrectright - pfv1.v[0]) / (pfv0.v[0] - pfv1.v[0]);
    for (let i = 0; i < 6; i++) out.v[i] = pfv1.v[i] + (pfv0.v[i] - pfv1.v[i]) * scale + 0.5;
  }
}

export function R_Alias_clip_top(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v[1] >= pfv1.v[1]) {
    scale = (r_refdef.aliasvrect.y - pfv0.v[1]) / (pfv1.v[1] - pfv0.v[1]);
    for (let i = 0; i < 6; i++) out.v[i] = pfv0.v[i] + (pfv1.v[i] - pfv0.v[i]) * scale + 0.5;
  } else {
    scale = (r_refdef.aliasvrect.y - pfv1.v[1]) / (pfv0.v[1] - pfv1.v[1]);
    for (let i = 0; i < 6; i++) out.v[i] = pfv1.v[i] + (pfv0.v[i] - pfv1.v[i]) * scale + 0.5;
  }
}

export function R_Alias_clip_bottom(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v[1] >= pfv1.v[1]) {
    scale = (r_refdef.aliasvrectbottom - pfv0.v[1]) / (pfv1.v[1] - pfv0.v[1]);

    for (let i = 0; i < 6; i++) out.v[i] = pfv0.v[i] + (pfv1.v[i] - pfv0.v[i]) * scale + 0.5;
  } else {
    scale = (r_refdef.aliasvrectbottom - pfv1.v[1]) / (pfv0.v[1] - pfv1.v[1]);

    for (let i = 0; i < 6; i++) out.v[i] = pfv1.v[i] + (pfv0.v[i] - pfv1.v[i]) * scale + 0.5;
  }
}

export function R_AliasClip(
  inVerts: FinalvertT[],
  outVerts: FinalvertT[],
  flag: number,
  count: number,
  clip: (pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT) => void,
): number {
  let j = count - 1;
  let k = 0;

  for (let i = 0; i < count; j = i, i++) {
    const oldflags = inVerts[j].flags & flag;
    const flags = inVerts[i].flags & flag;

    if (flags && oldflags) continue;
    if (oldflags ^ flags) {
      clip(inVerts[j], inVerts[i], outVerts[k]);
      outVerts[k].flags = 0;
      if (outVerts[k].v[0] < r_refdef.aliasvrect.x) outVerts[k].flags |= ALIAS_LEFT_CLIP;
      if (outVerts[k].v[1] < r_refdef.aliasvrect.y) outVerts[k].flags |= ALIAS_TOP_CLIP;
      if (outVerts[k].v[0] > r_refdef.aliasvrectright) outVerts[k].flags |= ALIAS_RIGHT_CLIP;
      if (outVerts[k].v[1] > r_refdef.aliasvrectbottom) outVerts[k].flags |= ALIAS_BOTTOM_CLIP;
      k++;
    }
    if (!flags) {
      copyFinalvert(inVerts[i], outVerts[k]);
      k++;
    }
  }

  return k;
}

/*
================
R_AliasClipTriangle
================
*/
export function R_AliasClipTriangle(ptri: MtriangleT): void {
  const pfinalverts = rState.pfinalverts;
  if (pfinalverts === null) Sys_Error("R_AliasClipTriangle: no pfinalverts");
  const pauxverts = rState.pauxverts;
  if (pauxverts === null) Sys_Error("R_AliasClipTriangle: no pauxverts");

  let k: number;
  let pingpong: number;

  // copy vertexes and fix seam texture coordinates
  if (ptri.facesfront) {
    copyFinalvert(pfinalverts[ptri.vertindex[0]], fv[0][0]);
    copyFinalvert(pfinalverts[ptri.vertindex[1]], fv[0][1]);
    copyFinalvert(pfinalverts[ptri.vertindex[2]], fv[0][2]);
  } else {
    for (let i = 0; i < 3; i++) {
      copyFinalvert(pfinalverts[ptri.vertindex[i]], fv[0][i]);

      if (!ptri.facesfront && fv[0][i].flags & ALIAS_ONSEAM) fv[0][i].v[2] += r_affinetridesc.seamfixupX16;
    }
  }

  // clip
  let clipflags = fv[0][0].flags | fv[0][1].flags | fv[0][2].flags;

  if (clipflags & ALIAS_Z_CLIP) {
    for (let i = 0; i < 3; i++) copyAuxvert(pauxverts[ptri.vertindex[i]], av[i]);

    k = R_AliasClip(fv[0], fv[1], ALIAS_Z_CLIP, 3, R_Alias_clip_z);
    if (k === 0) return;

    pingpong = 1;
    clipflags = fv[1][0].flags | fv[1][1].flags | fv[1][2].flags;
  } else {
    pingpong = 0;
    k = 3;
  }

  if (clipflags & ALIAS_LEFT_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_LEFT_CLIP, k, R_Alias_clip_left);
    if (k === 0) return;

    pingpong ^= 1;
  }

  if (clipflags & ALIAS_RIGHT_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_RIGHT_CLIP, k, R_Alias_clip_right);
    if (k === 0) return;

    pingpong ^= 1;
  }

  if (clipflags & ALIAS_BOTTOM_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_BOTTOM_CLIP, k, R_Alias_clip_bottom);
    if (k === 0) return;

    pingpong ^= 1;
  }

  if (clipflags & ALIAS_TOP_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_TOP_CLIP, k, R_Alias_clip_top);
    if (k === 0) return;

    pingpong ^= 1;
  }

  for (let i = 0; i < k; i++) {
    if (fv[pingpong][i].v[0] < r_refdef.aliasvrect.x) fv[pingpong][i].v[0] = r_refdef.aliasvrect.x;
    else if (fv[pingpong][i].v[0] > r_refdef.aliasvrectright) fv[pingpong][i].v[0] = r_refdef.aliasvrectright;

    if (fv[pingpong][i].v[1] < r_refdef.aliasvrect.y) fv[pingpong][i].v[1] = r_refdef.aliasvrect.y;
    else if (fv[pingpong][i].v[1] > r_refdef.aliasvrectbottom) fv[pingpong][i].v[1] = r_refdef.aliasvrectbottom;

    fv[pingpong][i].flags = 0;
  }

  // draw triangles
  mtri.facesfront = ptri.facesfront;
  r_affinetridesc.ptriangles = mtriList;
  r_affinetridesc.pfinalverts = fv[pingpong];

  // FIXME: do all at once as trifan?
  mtri.vertindex[0] = 0;
  for (let i = 1; i < k - 1; i++) {
    mtri.vertindex[1] = i;
    mtri.vertindex[2] = i + 1;
    D_PolysetDraw();
  }
}
