/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_warp.c (GNU GPL v2 or later).

gl_warp.c -- sky and water polygons: the load-time axial subdivision that
breaks turbulent and sky faces into <= gl_subdivide_size pieces
(GL_SubdivideSurface, the ModelLoaderHooks entry point gl_model.c calls), the
per-frame turbulence and scrolling-sky emitters gl_rsurf.c draws through
(EmitWaterPolys / EmitSkyPolys / EmitBothSkyLayers / R_DrawSkyChain), and
R_InitSky, which splits a 256x128 sky miptex into the two 128x128 GL layers.

Deviations from PORTING.md / the C source:
- `solidskytexture`, `alphaskytexture` and `speedscale` are file-scope
  globals the C REASSIGNS and gl_rsurf.c reads (`extern` at gl_rsurf.c:272-
  274). Per PORTING.md's globals rule they become fields on the exported
  `glWarpState` holder rather than module-level `let`s, so gl_rsurf.ts sees
  every write. glquake.ts's OWNERSHIP block files them under gl_warp.c, so
  they are NOT added to glState.
- `warpface` is likewise reassigned, but no other .c file reads it (grepped
  the WinQuake tree), so it stays module-private.
- `float *verts` (SubdividePolygon/BoundPoly) is a flat run of vec3_t; it
  becomes a `Float32Array` indexed by `vert * 3 + axis`, and the C's
  `verts += 3` cursor walks become index arithmetic. SubdividePolygon's
  "wrap cases" step still writes one extra vertex past `numverts` (the C's
  `v -= i; VectorCopy (verts, v)`), so every buffer handed to it is sized
  for 64 vec3_t exactly as the C's `vec3_t verts[64]` / `front[64]` /
  `back[64]` locals are.
- SubdividePolygon dereferences `warpface->texinfo` and GL_SubdivideSurface
  dereferences `loadmodel`, neither of which the C null-checks. Both get a
  Sys_Error guard here, because TS has to narrow `MsurfaceT | null` /
  `ModelT | null` somewhere; the C would simply crash.
- `loadmodel` (gl_model.c's file-scope "model currently being loaded"
  pointer, `extern` at gl_warp.c:24) is src/common/model.ts's shared
  `loadState.loadmodel`: this port has ONE loader whose renderer-specific
  lumps are hooks, and GL_SubdivideSurface only ever runs from inside
  Mod_LoadFaces, i.e. while loadState.loadmodel is the model being loaded.
  GL_SubdivideSurface keeps the C's one-argument signature.
- R_InitSky's `src = (byte *)mt + mt->offsets[0]` is an index into
  TextureT.data (`mt.data.subarray(mt.offsets[0])`), the same convention
  src/ref_soft/r_sky.ts and src/ref_soft/r_surf.ts already use: model.ts
  stores the mip block in `data` and keeps `offsets` relative to it.
- R_InitSky's `unsigned trans[128*128]` and the byte-wise reads/writes of
  `transpix` through `((byte *)&transpix)[n]` become a `Uint32Array` and
  explicit little-endian byte packing, which is what the x86 build does.
- turbsin's `#include "gl_warp_sin.h"` is src/ref_gl/gl_warp_sin.ts (U070).
- gl_warp.ts and gl_rsurf.ts import from each other (gl_warp calls
  GL_DisableMultitexture, gl_rsurf calls the Emit and R_DrawSkyChain
  emitters), exactly as the two translation units cross-reference in C.
  Both directions are function calls made after module evaluation, so the
  ESM cycle resolves without a lazy `require` (PORTING.md's import-cycle
  rule: reported, not worked around).

Dropped:
- The whole `#ifdef QUAKE2` block (gl_warp.c:339-1023): the Quake 2
  environment sky box and the PCX/TGA loaders that feed it -- SKY_TEX,
  pcx_t/LoadPCX, fgetLittleShort/fgetLittleLong/LoadTGA, R_LoadSkys,
  skymins/skymaxs, st_to_vec/vec_to_st, skytexorder, c_sky,
  DrawSkyPolygon, ClipSkyPolygon, the QUAKE2 R_DrawSkyChain, R_ClearSkyBox,
  MakeSkyVec and R_DrawSkyBox. PORTING.md drops QUAKE2 branches; the
  `#ifndef QUAKE2` R_DrawSkyChain at gl_warp.c:304 is the one that is kept.
*/

import { DotProduct, type Vec3, vec3, VectorCopy, VectorSubtract } from "../common/mathlib";
import { loadState, type MsurfaceT, type TextureT } from "../common/model";
import { host } from "../common/host";
import { d_8to24table } from "../client/vid";
import { Sys_Error } from "../platform/sys";
import { GlpolyT, glState, r_origin, setSurfPolys, surfPolys, VERTEXSIZE } from "./glquake";
import { GL_BLEND, GL_LINEAR, GL_POLYGON, GL_RGBA, GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_TEXTURE_MIN_FILTER, GL_UNSIGNED_BYTE, qgl } from "./qgl";
import { gl_alpha_format, gl_solid_format, GL_Bind } from "./gl_draw";
import { gl_subdivide_size } from "./gl_model";
import { GL_DisableMultitexture } from "./gl_rsurf";
import { turbsin } from "./gl_warp_sin";

export type GlWarpStateT = {
  solidskytexture: number;
  alphaskytexture: number;
  speedscale: number; // for top sky and bottom sky
};

export const glWarpState: GlWarpStateT = {
  solidskytexture: 0,
  alphaskytexture: 0,
  speedscale: 0,
};

let warpface: MsurfaceT | null = null;

export function BoundPoly(numverts: number, verts: Float32Array, mins: Vec3, maxs: Vec3): void {
  mins[0] = mins[1] = mins[2] = 9999;
  maxs[0] = maxs[1] = maxs[2] = -9999;
  let v = 0;
  for (let i = 0; i < numverts; i++)
    for (let j = 0; j < 3; j++, v++) {
      if (verts[v] < mins[j]) mins[j] = verts[v];
      if (verts[v] > maxs[j]) maxs[j] = verts[v];
    }
}

export function SubdividePolygon(numverts: number, verts: Float32Array): void {
  const mins: Vec3 = vec3();
  const maxs: Vec3 = vec3();
  const front = new Float32Array(64 * 3);
  const back = new Float32Array(64 * 3);
  const dist = new Float32Array(64);

  if (numverts > 60) Sys_Error("numverts = %i", numverts);

  BoundPoly(numverts, verts, mins, maxs);

  for (let i = 0; i < 3; i++) {
    let m = (mins[i] + maxs[i]) * 0.5;
    m = gl_subdivide_size.value * Math.floor(m / gl_subdivide_size.value + 0.5);
    if (maxs[i] - m < 8) continue;
    if (m - mins[i] < 8) continue;

    // cut it
    let v = i;
    let j = 0;
    for (j = 0; j < numverts; j++, v += 3) dist[j] = verts[v] - m;

    // wrap cases
    dist[j] = dist[0];
    v -= i;
    VectorCopy(verts.subarray(0, 3), verts.subarray(v, v + 3));

    let f = 0;
    let b = 0;
    v = 0;
    for (j = 0; j < numverts; j++, v += 3) {
      if (dist[j] >= 0) {
        VectorCopy(verts.subarray(v, v + 3), front.subarray(f * 3, f * 3 + 3));
        f++;
      }
      if (dist[j] <= 0) {
        VectorCopy(verts.subarray(v, v + 3), back.subarray(b * 3, b * 3 + 3));
        b++;
      }
      if (dist[j] === 0 || dist[j + 1] === 0) continue;
      if (dist[j] > 0 !== dist[j + 1] > 0) {
        // clip point
        const frac = dist[j] / (dist[j] - dist[j + 1]);
        for (let k = 0; k < 3; k++) {
          front[f * 3 + k] = back[b * 3 + k] = verts[v + k] + frac * (verts[v + 3 + k] - verts[v + k]);
        }
        f++;
        b++;
      }
    }

    SubdividePolygon(f, front);
    SubdividePolygon(b, back);
    return;
  }

  const face = warpface;
  if (!face) return Sys_Error("SubdividePolygon: warpface not set");
  const texinfo = face.texinfo;
  if (!texinfo) return Sys_Error("SubdividePolygon: surface has no texinfo");

  const poly = new GlpolyT(numverts);
  poly.next = surfPolys(face);
  setSurfPolys(face, poly);
  poly.numverts = numverts;
  for (let i = 0, v = 0; i < numverts; i++, v += 3) {
    const vert = verts.subarray(v, v + 3);
    VectorCopy(vert, poly.verts.subarray(i * VERTEXSIZE, i * VERTEXSIZE + 3));
    const s = DotProduct(vert, texinfo.vecs[0]);
    const t = DotProduct(vert, texinfo.vecs[1]);
    poly.verts[i * VERTEXSIZE + 3] = s;
    poly.verts[i * VERTEXSIZE + 4] = t;
  }
}

/*
================
GL_SubdivideSurface

Breaks a polygon up along axial 64 unit
boundaries so that turbulent and sky warps
can be done reasonably.
================
*/
export function GL_SubdivideSurface(fa: MsurfaceT): void {
  const verts = new Float32Array(64 * 3);

  warpface = fa;

  const loadmodel = loadState.loadmodel;
  if (!loadmodel) return Sys_Error("GL_SubdivideSurface: no model being loaded");

  //
  // convert edges back to a normal polygon
  //
  let numverts = 0;
  for (let i = 0; i < fa.numedges; i++) {
    const lindex = loadmodel.surfedges[fa.firstedge + i];

    let vec: Vec3;
    if (lindex > 0) vec = loadmodel.vertexes[loadmodel.edges[lindex].v[0]].position;
    else vec = loadmodel.vertexes[loadmodel.edges[-lindex].v[1]].position;
    VectorCopy(vec, verts.subarray(numverts * 3, numverts * 3 + 3));
    numverts++;
  }

  SubdividePolygon(numverts, verts);
}

//=========================================================

// speed up sin calculations - Ed
export const TURBSCALE = 256.0 / (2 * Math.PI);

/*
=============
EmitWaterPolys

Does a water warp on the pre-fragmented glpoly_t chain
=============
*/
export function EmitWaterPolys(fa: MsurfaceT): void {
  const gl = qgl();

  for (let p = surfPolys(fa); p; p = p.next) {
    gl.qglBegin(GL_POLYGON);
    for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
      const os = p.verts[v + 3];
      const ot = p.verts[v + 4];

      let s = os + turbsin[(((ot * 0.125 + host.realtime) * TURBSCALE) | 0) & 255];
      s *= 1.0 / 64;

      let t = ot + turbsin[(((os * 0.125 + host.realtime) * TURBSCALE) | 0) & 255];
      t *= 1.0 / 64;

      gl.qglTexCoord2f(s, t);
      gl.qglVertex3fv(p.verts.subarray(v, v + 3));
    }
    gl.qglEnd();
  }
}

/*
=============
EmitSkyPolys
=============
*/
export function EmitSkyPolys(fa: MsurfaceT): void {
  const gl = qgl();
  const dir: Vec3 = vec3();

  for (let p = surfPolys(fa); p; p = p.next) {
    gl.qglBegin(GL_POLYGON);
    for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
      const vert = p.verts.subarray(v, v + 3);
      VectorSubtract(vert, r_origin, dir);
      dir[2] *= 3; // flatten the sphere

      let length = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
      length = Math.sqrt(length);
      length = (6 * 63) / length;

      dir[0] *= length;
      dir[1] *= length;

      const s = (glWarpState.speedscale + dir[0]) * (1.0 / 128);
      const t = (glWarpState.speedscale + dir[1]) * (1.0 / 128);

      gl.qglTexCoord2f(s, t);
      gl.qglVertex3fv(vert);
    }
    gl.qglEnd();
  }
}

/*
===============
EmitBothSkyLayers

Does a sky warp on the pre-fragmented glpoly_t chain
This will be called for brushmodels, the world
will have them chained together.
===============
*/
export function EmitBothSkyLayers(fa: MsurfaceT): void {
  const gl = qgl();

  GL_DisableMultitexture();

  GL_Bind(glWarpState.solidskytexture);
  glWarpState.speedscale = host.realtime * 8;
  glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;

  EmitSkyPolys(fa);

  gl.qglEnable(GL_BLEND);
  GL_Bind(glWarpState.alphaskytexture);
  glWarpState.speedscale = host.realtime * 16;
  glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;

  EmitSkyPolys(fa);

  gl.qglDisable(GL_BLEND);
}

/*
=================
R_DrawSkyChain
=================
*/
export function R_DrawSkyChain(s: MsurfaceT): void {
  const gl = qgl();

  GL_DisableMultitexture();

  // used when gl_texsort is on
  GL_Bind(glWarpState.solidskytexture);
  glWarpState.speedscale = host.realtime * 8;
  glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;

  for (let fa: MsurfaceT | null = s; fa; fa = fa.texturechain) EmitSkyPolys(fa);

  gl.qglEnable(GL_BLEND);
  GL_Bind(glWarpState.alphaskytexture);
  glWarpState.speedscale = host.realtime * 16;
  glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;

  for (let fa: MsurfaceT | null = s; fa; fa = fa.texturechain) EmitSkyPolys(fa);

  gl.qglDisable(GL_BLEND);
}

//===============================================================

/*
=============
R_InitSky

A sky texture is 256*128, with the right side being a masked overlay
==============
*/
export function R_InitSky(mt: TextureT): void {
  const gl = qgl();
  const trans = new Uint32Array(128 * 128);

  const src = mt.data.subarray(mt.offsets[0]);

  // make an average value for the back to avoid
  // a fringe on the top level

  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < 128; i++)
    for (let j = 0; j < 128; j++) {
      const p = src[i * 256 + j + 128];
      const rgba = d_8to24table[p];
      trans[i * 128 + j] = rgba;
      r += rgba & 0xff;
      g += (rgba >>> 8) & 0xff;
      b += (rgba >>> 16) & 0xff;
    }

  const transpix = ((((r / (128 * 128)) | 0) | (((g / (128 * 128)) | 0) << 8) | (((b / (128 * 128)) | 0) << 16)) >>> 0);

  if (!glWarpState.solidskytexture) glWarpState.solidskytexture = glState.texture_extension_number++;
  GL_Bind(glWarpState.solidskytexture);
  gl.qglTexImage2D(GL_TEXTURE_2D, 0, gl_solid_format, 128, 128, 0, GL_RGBA, GL_UNSIGNED_BYTE, trans);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

  for (let i = 0; i < 128; i++)
    for (let j = 0; j < 128; j++) {
      const p = src[i * 256 + j];
      if (p === 0) trans[i * 128 + j] = transpix;
      else trans[i * 128 + j] = d_8to24table[p];
    }

  if (!glWarpState.alphaskytexture) glWarpState.alphaskytexture = glState.texture_extension_number++;
  GL_Bind(glWarpState.alphaskytexture);
  gl.qglTexImage2D(GL_TEXTURE_2D, 0, gl_alpha_format, 128, 128, 0, GL_RGBA, GL_UNSIGNED_BYTE, trans);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
}
