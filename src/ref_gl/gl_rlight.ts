/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_rlight.c (GNU GPL v2 or later).

r_light.c -- the GL renderer's lightstyle animation, the gl_flashblend
"dynamic lights blend rendering" pass (a translucent fan drawn per dlight
instead of a lightmap update), the R_MarkLights/R_PushDlights surface marking
the non-flashblend path uses, and R_LightPoint's BSP light sampling (which
gl_rmain.c's R_DrawAliasModel and R_DrawViewModel call, and whose `lightspot`
GL_DrawAliasShadow reads).

Deviations from PORTING.md / the C source:
- `int r_dlightframecount` and `mplane_t *lightplane` are gl_rlight.c file-scope
  globals the C REASSIGNS. glquake.ts's `glState` names them in its OWNERSHIP
  block but carries no field for either (glquake.h declares neither), so
  PORTING.md's globals rule gives them the "small exported holder" shape here:
  `rlightState`. `lightspot` is only ever written in place, so it stays an
  exported `const` vec3 -- which is also what gl_rmain.c's `extern vec3_t
  lightspot;` reads.
- `node`/`start`/`end` parameters that are `mnode_t *` in C become
  `MnodeT | MleafT` (model.ts's split base-class shape); `isMleaf`
  (`node.contents < 0`) narrows exactly where the C's `if (node->contents < 0)`
  does. Same ruling src/ref_soft/r_light.ts already carries.
- `node->children[side]` is typed `MnodeT | MleafT | null`; a null child throws
  SysError with the "bad model" idiom src/common/model.ts's Mod_PointInLeaf
  uses, since the C has no guard (a null deref would crash) and this port needs
  a narrowing step somewhere.
- `cl_lightstyle[j].map` is a JS `string` (client.ts's LightstyleT), not a
  `char[]`; `.charCodeAt(k) - 'a'.charCodeAt(0)` replaces the C's `map[k] - 'a'`.
- `v_blend` lives in gl_rmain.ts (view.c defines it under #ifdef GLQUAKE and
  gl_rmain.c's R_PolyBlend is its other reader); AddLightBlend imports it.
- R_RenderDlight's `v` is one vec3 reused across all 18 glVertex3fv calls,
  exactly as in the C.

QuakeWorld deltas (QW/client/gl_rlight.c vs WinQuake/gl_rlight.c), folded
under qw.active:
- QW adds `bubble_sintable[17]`/`bubble_costable[17]` and `R_InitBubble()`,
  precomputing the 17 angle steps R_RenderDlight's fan loop used to call
  `sin`/`cos` for on every vertex, every dlight, every frame. Ported as
  `bubbleSintable`/`bubbleCostable` + `R_InitBubble` below; gl_rmisc.ts calls
  it from R_Init under qw.active (gl_rmisc.c:207).
- QW also changes R_RenderDlight's fan color from the fixed
  `glColor3f(0.2,0.1,0.0)` to `glColor4f(light->color[0..3])`, reading the
  per-dlight `color[4]` field QW's dlight_t gains (`DlightT.color`,
  src/client/client.ts). Both branches are ported below.

U15 (colored lighting -- QuakeSpasm gl_rlight.c's R_LightPoint/
RecursiveLightPoint, which return a genuine RGB color via a file-scope
`lightcolor` vec3 instead of a single scalar): RecursiveLightPoint/
R_LightPoint here keep this port's PRE-EXISTING single-lookup algorithm
(no bilinear interpolation across the four nearest luxels, unlike current
QuakeSpasm's much-rewritten version) and only generalize its lightmap read
from one channel to three, exactly the way gl_rsurf.ts's R_BuildLightMap
does: `lightcolor` (exported here, alongside `lightspot`) receives the real
per-channel sample when gl_coloredlight is on and the map has RGB data,
else the same grey value replicated across all three channels -- so classic
maps and gl_coloredlight 0 reproduce the pre-U15 scalar bit for bit (see
RecursiveLightPoint's own comment). The scalar RecursiveLightPoint/
R_LightPoint still return, for every existing caller that only reads a
single brightness, is the AVERAGE of the three channels (exactly equal to
any one of them when they are all the same, i.e. whenever color is not
active). gl_rmain.ts's R_DrawAliasModel reads `lightcolor` directly to
shade alias models per channel; see that file's own header note.
*/

import { DotProduct, Length, M_PI, MplaneT, type Vec3, VectorCopy, VectorSubtract, vec3 } from "../common/mathlib";
import { qw } from "../common/quakedef";
import { MAX_LIGHTSTYLES } from "../common/quakedef";
import { MAXLIGHTMAPS } from "../common/bspfile";
import { SURF_DRAWTILED, type MleafT, type MnodeT, isMleaf } from "../common/model";
import { Sys_Error } from "../platform/sys";
import { MAX_DLIGHTS, cl, cl_dlights, cl_lightstyle, type DlightT } from "../client/client";
import { r_origin, vpn, vright, vup } from "../client/render";
import { d_lightstylevalue, gl_coloredlight, glState, r_lerplightstyles } from "./glquake";
import { GL_BLEND, GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_SMOOTH, GL_SRC_ALPHA, GL_TEXTURE_2D, GL_TRIANGLE_FAN, qgl } from "./qgl";
import { gl_flashblend, v_blend } from "./gl_rmain";
import { clientProfile } from "../common/profile";

// gl_rlight.c's reassigned file-scope globals (see the header note).
export const rlightState: { r_dlightframecount: number; lightplane: MplaneT | null } = {
  r_dlightframecount: 0,
  lightplane: null,
};

export const lightspot: Vec3 = vec3();

// QW/client/gl_rlight.c: `float bubble_sintable[17], bubble_costable[17];`
// and `R_InitBubble()` (see file header). Populated by R_InitBubble, read by
// R_RenderDlight's fan loop in place of per-vertex sin/cos when qw.active.
export const bubbleSintable = new Float32Array(17);
export const bubbleCostable = new Float32Array(17);

export function R_InitBubble(): void {
  let bi = 0;
  for (let i = 16; i >= 0; i--) {
    const a = (i / 16.0) * M_PI * 2;
    bubbleSintable[bi] = Math.sin(a);
    bubbleCostable[bi] = Math.cos(a);
    bi++;
  }
}

/*
==================
R_AnimateLight
==================
*/
export function R_AnimateLight(): void {
  //
  // light animations
  // 'm' is normal light, 'a' is no light, 'z' is double bright
  //
  // U16 (Ironwail gl_rlight.c): r_lerplightstyles interpolates between the
  // current decisecond's value ('k') and the next one ('n') by the
  // fractional part of cl.time*10 ('f'); r_lerplightstyles 0 forces f to 0,
  // which reduces this to the classic WinQuake snap-to-current-value read.
  let f = cl.time * 10.0;
  const base = Math.floor(f);
  const i = base;
  f -= base;
  if (!r_lerplightstyles.value) f = 0.0;

  for (let j = 0; j < MAX_LIGHTSTYLES; j++) {
    const style = cl_lightstyle[j];
    if (!style.length) {
      d_lightstylevalue[j] = 256;
      continue;
    }
    const k0 = i % style.length;
    let n0 = k0 + 1;
    if (n0 === style.length) n0 = 0;
    let k = style.map.charCodeAt(k0) - "a".charCodeAt(0);
    let n = style.map.charCodeAt(n0) - "a".charCodeAt(0);

    // only interpolate abrupt changes (e.g. flickering light in e1m1) if
    // r_lerplightstyles >= 2
    if (r_lerplightstyles.value < 2 && Math.abs(n - k) >= ("m".charCodeAt(0) - "a".charCodeAt(0)) / 2) n = k;

    d_lightstylevalue[j] = (k * 22 + (n - k) * 22 * f) | 0;
  }
}

/*
=============================================================================

DYNAMIC LIGHTS BLEND RENDERING

=============================================================================
*/

export function AddLightBlend(r: number, g: number, b: number, a2: number): void {
  let a: number;

  v_blend[3] = a = v_blend[3] + a2 * (1 - v_blend[3]);

  a2 = a2 / a;

  v_blend[0] = v_blend[1] * (1 - a2) + r * a2;
  v_blend[1] = v_blend[1] * (1 - a2) + g * a2;
  v_blend[2] = v_blend[2] * (1 - a2) + b * a2;
}

const dlightV: Vec3 = vec3();

export function R_RenderDlight(light: DlightT): void {
  const rad = light.radius * 0.35;

  VectorSubtract(light.origin, r_origin, dlightV);
  if (Length(dlightV) < rad) {
    // view is inside the dlight
    AddLightBlend(1, 0.5, 0, light.radius * 0.0003);
    return;
  }

  qgl().qglBegin(GL_TRIANGLE_FAN);
  // QW/client/gl_rlight.c replaces the fixed fan color with the dlight's own
  // color[4] (the two WinQuake values are the C's own commented-out lines).
  if (clientProfile() === "qw") qgl().qglColor4f(light.color[0], light.color[1], light.color[2], light.color[3]);
  else qgl().qglColor3f(0.2, 0.1, 0.0);
  for (let i = 0; i < 3; i++) dlightV[i] = light.origin[i] - vpn[i] * rad;
  qgl().qglVertex3fv(dlightV);
  qgl().qglColor3f(0, 0, 0);
  if (clientProfile() === "qw") {
    // QW/client/gl_rlight.c: table lookup instead of per-vertex sin/cos
    // (R_InitBubble precomputes bubbleSintable/bubbleCostable).
    for (let i = 0; i < 17; i++) {
      for (let j = 0; j < 3; j++) dlightV[j] = light.origin[j] + (vright[j] * bubbleCostable[i] + vup[j] * bubbleSintable[i]) * rad;
      qgl().qglVertex3fv(dlightV);
    }
  } else {
    for (let i = 16; i >= 0; i--) {
      const a = (i / 16.0) * M_PI * 2;
      for (let j = 0; j < 3; j++) dlightV[j] = light.origin[j] + vright[j] * Math.cos(a) * rad + vup[j] * Math.sin(a) * rad;
      qgl().qglVertex3fv(dlightV);
    }
  }
  qgl().qglEnd();
}

/*
=============
R_RenderDlights
=============
*/
export function R_RenderDlights(): void {
  if (!gl_flashblend.value) return;

  // because the count hasn't advanced yet for this frame
  rlightState.r_dlightframecount = glState.r_framecount + 1;

  qgl().qglDepthMask(false);
  qgl().qglDisable(GL_TEXTURE_2D);
  qgl().qglShadeModel(GL_SMOOTH);
  qgl().qglEnable(GL_BLEND);
  qgl().qglBlendFunc(GL_ONE, GL_ONE);

  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const l = cl_dlights[i];
    if (l.die < cl.time || !l.radius) continue;
    R_RenderDlight(l);
  }

  qgl().qglColor3f(1, 1, 1);
  qgl().qglDisable(GL_BLEND);
  qgl().qglEnable(GL_TEXTURE_2D);
  qgl().qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl().qglDepthMask(true);
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
    if (surf.dlightframe !== rlightState.r_dlightframecount) {
      surf.dlightbits = 0;
      surf.dlightframe = rlightState.r_dlightframecount;
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
  if (gl_flashblend.value) return;

  // because the count hasn't advanced yet for this frame
  rlightState.r_dlightframecount = glState.r_framecount + 1;

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

// U15: the RGB light color the last successful RecursiveLightPoint/
// R_LightPoint call sampled -- a real per-channel value when gl_coloredlight
// is on and the map has RGB data, else the same grey value in all three
// channels (see this file's header). gl_rmain.ts's R_DrawAliasModel reads
// this directly to shade alias models per channel.
export const lightcolor: Vec3 = vec3();

// U15: true when this map's surfaces should be sampled for real color
// (mirrors gl_rsurf.ts's identically-named predicate, which this module
// cannot import without closing a new gl_rsurf<->gl_rlight cycle -- see
// glquake.ts's gl_coloredlight comment).
function coloredLightingAvailable(): boolean {
  const worldmodel = cl.worldmodel;
  return gl_coloredlight.value !== 0 && worldmodel !== null && worldmodel.lightdata_rgb !== null;
}

export function RecursiveLightPoint(node: MnodeT | MleafT, start: Vec3, end: Vec3): number {
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
  const mid: Vec3 = vec3();
  mid[0] = start[0] + (end[0] - start[0]) * frac;
  mid[1] = start[1] + (end[1] - start[1]) * frac;
  mid[2] = start[2] + (end[2] - start[2]) * frac;

  // go down front side
  const frontChild = node.children[side];
  if (frontChild === null) Sys_Error("RecursiveLightPoint: bad model");
  let r = RecursiveLightPoint(frontChild, start, mid);
  if (r >= 0) return r; // hit something

  if ((back < 0 ? 1 : 0) === side) return -1; // didn't hit anuthing

  // check for impact on this node
  VectorCopy(mid, lightspot);
  rlightState.lightplane = plane;

  if (cl.worldmodel === null) Sys_Error("RecursiveLightPoint: no worldmodel");
  const worldmodel = cl.worldmodel;
  const colored = coloredLightingAvailable();
  const rgbLightdata = colored ? worldmodel.lightdata_rgb : null;
  const surfaces = worldmodel.surfaces;
  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = surfaces[node.firstsurface + i];

    if (surf.flags & SURF_DRAWTILED) continue; // no lightmaps

    const tex = surf.texinfo;
    if (tex === null) Sys_Error("RecursiveLightPoint: bad surface");

    const s = (DotProduct(mid, tex.vecs[0]) + tex.vecs[0][3]) | 0;
    const t = (DotProduct(mid, tex.vecs[1]) + tex.vecs[1][3]) | 0;

    if (s < surf.texturemins[0] || t < surf.texturemins[1]) continue;

    let ds = s - surf.texturemins[0];
    let dt = t - surf.texturemins[1];

    if (ds > surf.extents[0] || dt > surf.extents[1]) continue;

    if (surf.samples === null) {
      lightcolor[0] = lightcolor[1] = lightcolor[2] = 0;
      return 0;
    }

    ds >>= 4;
    dt >>= 4;

    const lightmap = surf.samples;
    const rgbSamples = rgbLightdata !== null && surf.lightofs !== -1 ? rgbLightdata.subarray(surf.lightofs * 3) : null;
    let lightmapOfs = 0;
    let rr = 0;
    let gg = 0;
    let bb = 0;

    lightmapOfs += dt * ((surf.extents[0] >> 4) + 1) + ds;

    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const scale = d_lightstylevalue[surf.styles[maps]];
      if (rgbSamples) {
        const base = lightmapOfs * 3;
        rr += rgbSamples[base] * scale;
        gg += rgbSamples[base + 1] * scale;
        bb += rgbSamples[base + 2] * scale;
      } else {
        const v = lightmap[lightmapOfs] * scale;
        rr += v;
        gg += v;
        bb += v;
      }
      lightmapOfs += ((surf.extents[0] >> 4) + 1) * ((surf.extents[1] >> 4) + 1);
    }

    rr >>= 8;
    gg >>= 8;
    bb >>= 8;
    lightcolor[0] = rr;
    lightcolor[1] = gg;
    lightcolor[2] = bb;

    // the classic scalar callers get the average of the three channels --
    // exactly `rr` (any one of them) whenever they are all equal, i.e.
    // whenever color is not active, so this is byte-identical to the
    // pre-U15 return for every existing caller.
    return ((rr + gg + bb) / 3) | 0;
  }

  // go down back side
  const backChild = node.children[side ? 0 : 1];
  if (backChild === null) Sys_Error("RecursiveLightPoint: bad model");
  return RecursiveLightPoint(backChild, mid, end);
}

export function R_LightPoint(p: Vec3): number {
  if (cl.worldmodel === null || cl.worldmodel.lightdata === null) {
    lightcolor[0] = lightcolor[1] = lightcolor[2] = 255;
    return 255;
  }
  if (cl.worldmodel.nodes.length === 0) Sys_Error("R_LightPoint: bad worldmodel");

  const end: Vec3 = vec3();
  end[0] = p[0];
  end[1] = p[1];
  end[2] = p[2] - 2048;

  lightcolor[0] = lightcolor[1] = lightcolor[2] = 0;
  let r = RecursiveLightPoint(cl.worldmodel.nodes[0], p, end);

  if (r === -1) {
    r = 0;
    lightcolor[0] = lightcolor[1] = lightcolor[2] = 0;
  }

  return r;
}
