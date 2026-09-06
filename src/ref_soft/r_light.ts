/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_light.c (GNU GPL v2 or later).

r_light.c: dynamic lights, lightstyle animation, and R_LightPoint's BSP
light sampling (used by r_alias.c's R_AliasSetupLighting caller in r_main.c,
U062, and by client-side muzzleflash/explosion dlight code).

Deviations from PORTING.md / the C source:
- `node`/`start`/`end` parameters that are `mnode_t *` in C become
  `MnodeT | MleafT` here (model.ts's split base-class shape); `isMleaf`
  (`node.contents < 0`) narrows exactly where the C's `if (node->contents <
  0)` does, since `mnode_t` and `mleaf_t` share the `contents` field
  through a union in C and through `MnodeBaseT` here.
- `node->children[side]` is typed `MnodeT | MleafT | null` (never actually
  null past the root for a loaded BSP); a null child throws SysError with
  the same "bad model" idiom src/common/model.ts's Mod_PointInLeaf already
  uses, since the C has no such guard (a null pointer deref would crash) and
  this port needs a typed narrowing step somewhere.
- `cl_lightstyle[j].map` is a JS `string` here (client.ts's LightstyleT),
  not a `char[]`; `.charCodeAt(k) - 'a'.charCodeAt(0)` replaces the C's
  pointer-indexed `map[k] - 'a'`.
*/

import { DotProduct, type Vec3 } from "../common/mathlib";
import { MAX_LIGHTSTYLES } from "../common/quakedef";
import { MAXLIGHTMAPS } from "../common/bspfile";
import { SURF_DRAWTILED, type MleafT, type MnodeT, isMleaf } from "../common/model";
import { Sys_Error } from "../platform/sys";
import { cl, cl_dlights, cl_lightstyle, MAX_DLIGHTS, type DlightT } from "../client/client";
import { r_refdef } from "../client/render";
import { d_lightstylevalue, rState } from "./r_local";

/*
==================
R_AnimateLight
==================
*/
export function R_AnimateLight(): void {
  // light animations
  // 'm' is normal light, 'a' is no light, 'z' is double bright
  const i = (cl.time * 10) | 0;
  for (let j = 0; j < MAX_LIGHTSTYLES; j++) {
    const style = cl_lightstyle[j];
    if (!style.length) {
      d_lightstylevalue[j] = 256;
      continue;
    }
    let k = i % style.length;
    k = style.map.charCodeAt(k) - "a".charCodeAt(0);
    k = k * 22;
    d_lightstylevalue[j] = k;
  }
}

/*
=============================================================================

DYNAMIC LIGHTS

=============================================================================
*/

/*
=============
R_MarkLights
=============
*/
export function R_MarkLights(light: DlightT, bit: number, node: MnodeT | MleafT): void {
  if (isMleaf(node)) return;

  const splitplane = node.plane;
  if (splitplane === null) Sys_Error("R_MarkLights: bad node");
  const dist = DotProduct(light.origin, splitplane.normal) - splitplane.dist;

  if (dist > light.radius) {
    const child = node.children[0];
    if (child === null) Sys_Error("R_MarkLights: bad model");
    R_MarkLights(light, bit, child);
    return;
  }
  if (dist < -light.radius) {
    const child = node.children[1];
    if (child === null) Sys_Error("R_MarkLights: bad model");
    R_MarkLights(light, bit, child);
    return;
  }

  // mark the polygons
  if (cl.worldmodel === null) Sys_Error("R_MarkLights: no worldmodel");
  const surfaces = cl.worldmodel.surfaces;
  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = surfaces[node.firstsurface + i];
    if (surf.dlightframe !== rState.r_dlightframecount) {
      surf.dlightbits = 0;
      surf.dlightframe = rState.r_dlightframecount;
    }
    surf.dlightbits |= bit;
  }

  const child0 = node.children[0];
  const child1 = node.children[1];
  if (child0 === null || child1 === null) Sys_Error("R_MarkLights: bad model");
  R_MarkLights(light, bit, child0);
  R_MarkLights(light, bit, child1);
}

/*
=============
R_PushDlights
=============
*/
export function R_PushDlights(): void {
  // because the count hasn't advanced yet for this frame
  rState.r_dlightframecount = rState.r_framecount + 1;

  if (cl.worldmodel === null || cl.worldmodel.nodes.length === 0) Sys_Error("R_PushDlights: no worldmodel");
  const root = cl.worldmodel.nodes[0];

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const l = cl_dlights[i];
    if (l.die < cl.time || !l.radius) continue;
    R_MarkLights(l, 1 << i, root);
  }
}

/*
=============================================================================

LIGHT SAMPLING

=============================================================================
*/

function RecursiveLightPoint(node: MnodeT | MleafT, start: Vec3, end: Vec3): number {
  if (isMleaf(node)) return -1; // didn't hit anything

  // calculate mid point
  // FIXME: optimize for axial
  const plane = node.plane;
  if (plane === null) Sys_Error("RecursiveLightPoint: bad node");
  const front = DotProduct(start, plane.normal) - plane.dist;
  const back = DotProduct(end, plane.normal) - plane.dist;
  const side = front < 0 ? 1 : 0;

  if ((back < 0 ? 1 : 0) === side) {
    const child = node.children[side];
    if (child === null) Sys_Error("RecursiveLightPoint: bad model");
    return RecursiveLightPoint(child, start, end);
  }

  const frac = front / (front - back);
  const mid: Vec3 = new Float32Array(3);
  mid[0] = start[0] + (end[0] - start[0]) * frac;
  mid[1] = start[1] + (end[1] - start[1]) * frac;
  mid[2] = start[2] + (end[2] - start[2]) * frac;

  // go down front side
  const frontChild = node.children[side];
  if (frontChild === null) Sys_Error("RecursiveLightPoint: bad model");
  const r = RecursiveLightPoint(frontChild, start, mid);
  if (r >= 0) return r; // hit something

  if ((back < 0 ? 1 : 0) === side) return -1; // didn't hit anything

  // check for impact on this node
  if (cl.worldmodel === null) Sys_Error("RecursiveLightPoint: no worldmodel");
  const surfaces = cl.worldmodel.surfaces;
  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = surfaces[node.firstsurface + i];

    if (surf.flags & SURF_DRAWTILED) continue; // no lightmaps

    const tex = surf.texinfo;
    if (tex === null) Sys_Error("RecursiveLightPoint: bad surface");

    const s = (DotProduct(mid, tex.vecs[0]) + tex.vecs[0][3]) | 0;
    const t = (DotProduct(mid, tex.vecs[1]) + tex.vecs[1][3]) | 0;

    if (s < surf.texturemins[0] || t < surf.texturemins[1]) continue;

    const ds = s - surf.texturemins[0];
    const dt = t - surf.texturemins[1];

    if (ds > surf.extents[0] || dt > surf.extents[1]) continue;

    if (surf.samples === null) return 0;

    const ds4 = ds >> 4;
    const dt4 = dt >> 4;

    let lightmapOfs = dt4 * ((surf.extents[0] >> 4) + 1) + ds4;
    let result = 0;

    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const scale = d_lightstylevalue[surf.styles[maps]];
      result += surf.samples[lightmapOfs] * scale;
      lightmapOfs += ((surf.extents[0] >> 4) + 1) * ((surf.extents[1] >> 4) + 1);
    }

    result >>= 8;
    return result;
  }

  // go down back side
  const backChild = node.children[side ? 0 : 1];
  if (backChild === null) Sys_Error("RecursiveLightPoint: bad model");
  return RecursiveLightPoint(backChild, mid, end);
}

export function R_LightPoint(p: Vec3): number {
  if (cl.worldmodel === null || cl.worldmodel.lightdata === null) return 255;
  if (cl.worldmodel.nodes.length === 0) Sys_Error("R_LightPoint: bad worldmodel");

  const end: Vec3 = new Float32Array(3);
  end[0] = p[0];
  end[1] = p[1];
  end[2] = p[2] - 2048;

  const root = cl.worldmodel.nodes[0];

  let r = RecursiveLightPoint(root, p, end);

  if (r === -1) r = 0;

  if (r < r_refdef.ambientlight) r = r_refdef.ambientlight;

  return r;
}
