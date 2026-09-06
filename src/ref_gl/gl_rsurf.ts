/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_rsurf.c (GNU GPL v2 or later).

gl_rsurf.c: surface-related refresh code -- the lightmap atlas (AllocBlock /
GL_CreateSurfaceLightmap / GL_BuildLightmaps / R_BuildLightMap /
R_AddDynamicLights), the per-surface display lists
(BuildSurfaceDisplayList), the world and brush-model walks
(R_RecursiveWorldNode / R_DrawWorld / R_DrawBrushModel / R_MarkLeaves), and
every path that actually emits a brush polygon (R_RenderBrushPoly,
R_DrawSequentialPoly, DrawTextureChains, R_BlendLightmaps,
R_DrawWaterSurfaces, DrawGLPoly / DrawGLWaterPoly /
DrawGLWaterPolyLightmap). gl_rsurf.c also defines the multitexture
enable/disable pair the whole GL tree calls.

OWNERSHIP notes verified against the C, since two of them were open
questions in this unit's brief:
- R_MarkLeaves is DEFINED in gl_rsurf.c (line 1349). gl_rmain.c only
  forward-declares it (line 74) and calls it (line 957), so it is this
  module's and gl_rmain.ts should import it from here.
- r_pcurrentvertbase is defined in gl_rsurf.c (line 1442) for the GL build;
  r_main.c's identically named global (r_main.c:45) is the SOFTWARE
  renderer's, a separate translation unit.
- gl_lightmap_format is defined in gl_draw.c (line 50) and is therefore
  U074's, even though gl_rsurf.c is the only file that reads OR writes it
  (GL_BuildLightmaps assigns it; R_BuildLightMap / R_BlendLightmaps /
  R_DrawSequentialPoly read it). Because gl_rsurf.c assigns it across the
  translation-unit boundary it cannot be a plain exported `const` in
  gl_draw.ts: this module reads and writes it as
  `glDrawState.gl_lightmap_format`, so U074's gl_draw.ts must export a
  `glDrawState` holder carrying at least that field.
- gl_solid_format / gl_alpha_format are gl_draw.c's too but are never
  reassigned anywhere in the tree, so they stay plain named imports (the
  same shape gl_rmisc.ts already imports them with).

Deviations from PORTING.md / the C source:
- `glRect_t` is a gl_rsurf.c-local typedef; it becomes the exported
  `GlRectT` class here. Its four `unsigned char` fields are plain numbers:
  every value stored in them is bounded by BLOCK_WIDTH / BLOCK_HEIGHT
  (128), so the C's byte wraparound never occurs.
- `int allocated[MAX_LIGHTMAPS][BLOCK_WIDTH]` becomes one flat Int32Array
  indexed `texnum * BLOCK_WIDTH + i`, the same flattening gl_model_types.ts
  uses for `gl_texturenum[MAX_SKINS][4]`.
- `byte *dest` (R_BuildLightMap's second parameter) is always
  `lightmaps + <offset>` at every call site. A TS function cannot carry a
  pointer into the middle of a typed array, so the parameter list becomes
  `(surf, dest: Uint8Array, destOfs: number, stride: number)` and the C's
  `dest += ...` cursor walks become index arithmetic on `destOfs`.
- `AllocBlock (int w, int h, int *x, int *y)`'s two out parameters become
  one `{ x, y }` out object, per PORTING.md's out-param convention; the
  return value is still the texture number.
- `blocklights` is `unsigned[]`, so it is a Uint32Array; the C's
  `int t = *bl++` narrowing back to a signed int is written `| 0`.
- `r_pcurrentvertbase` (an `mvertex_t *` into the model's vertex array) is
  the MvertexT[] itself, since the C only ever assigns `m->vertexes` to it.
- `currentmodel`, `r_pcurrentvertbase`, `lightmap_bytes`,
  `active_lightmaps`, `skychain`, `waterchain`, `mtexenabled` and
  `nColinElim` are file-scope globals the C reassigns; none is read by any
  other .c file (grepped the WinQuake tree), so per PORTING.md's globals
  rule they live on the exported `glRsurfState` holder. `skytexturenum` and
  `lightmap_textures` are on glState, where glquake.ts already put them.
- The C's four `goto`s become straight-line control flow with the original
  order preserved: R_BuildLightMap's `goto store` is an if/else around the
  block it skips, and R_RenderBrushPoly's / R_RenderDynamicLightmaps'
  `goto dynamic` (a jump INTO an if body) becomes a `dynamic` flag OR-ed
  into that if's condition.
- R_BuildLightMap reads `cl.worldmodel->lightdata` unconditionally; with no
  world loaded this port takes the same branch a null `lightdata` takes (full
  bright), rather than erroring, because that is the only sensible narrowing
  of `cl.worldmodel: ModelT | null` and it changes nothing while a map is up.
- R_TextureAnimation and R_DrawSequentialPoly dereference
  `currententity` / `s->polys` / `fa->texinfo->texture`, none of which the C
  null-checks. Each gets a Sys_Error guard, because TS has to narrow the
  nullable type somewhere; the C would simply crash.
- `qglMTexCoord2fSGIS` is a `| null` QGL member (the C's function pointer);
  the multitexture paths, which the C enters only when `gl_mtexable` is
  true, read it once and Sys_Error if it is null.
- gl_rsurf.ts and gl_warp.ts import from each other (gl_rsurf calls the
  Emit and R_DrawSkyChain emitters, gl_warp calls GL_DisableMultitexture),
  exactly as the two translation units cross-reference in C. Both
  directions are function calls made after module evaluation, so the ESM
  cycle resolves without a lazy `require` (PORTING.md's import-cycle rule:
  reported, not worked around).

Dropped:
- The `#if 0` R_DrawSequentialPoly (gl_rsurf.c:304-400) and the `#if 0`
  R_DrawWaterSurfaces (gl_rsurf.c:899-947); the `#else` bodies are the ones
  that build.
- `#ifdef QUAKE2`: R_DrawWorld's `R_ClearSkyBox()` / `R_DrawSkyBox()` calls,
  and GL_BuildLightmaps' `#ifndef QUAKE2` guard around the
  `SURF_DRAWSKY continue` (the guard is kept, i.e. sky surfaces do NOT get
  a display list, which is the non-QUAKE2 build).
- The three commented-out `glTexImage2D` experiments in R_BlendLightmaps.
*/

import { COM_CheckParm } from "../common/common";
import { CONTENTS_EMPTY, CONTENTS_SOLID, MAXLIGHTMAPS } from "../common/bspfile";
import { AngleVectors, DotProduct, PLANE_X, PLANE_Y, PLANE_Z, type Vec3, vec3, VectorAdd, VectorCopy, VectorNormalize, VectorSubtract } from "../common/mathlib";
import {
  isMleaf,
  Mod_LeafPVS,
  type MleafT,
  type MnodeT,
  type ModelT,
  type MsurfaceT,
  type MvertexT,
  type TextureT,
  SURF_DRAWSKY,
  SURF_DRAWTURB,
  SURF_PLANEBACK,
  SURF_DONTWARP,
  SURF_UNDERWATER,
} from "../common/model";
import { MAX_MODELS } from "../common/quakedef";
import { cl, cl_dlights, MAX_DLIGHTS } from "../client/client";
import { Sys_Error } from "../platform/sys";
import { host } from "../common/host";
import { qw } from "../common/quakedef";
import {
  BACKFACE_EPSILON,
  BLOCK_HEIGHT,
  BLOCK_WIDTH,
  d_lightstylevalue,
  EntityT,
  GlpolyT,
  glState,
  MAX_LIGHTMAPS,
  modelorg,
  r_refdef,
  r_world_matrix,
  setSurfPolys,
  surfPolys,
  TEXTURE0_SGIS,
  TEXTURE1_SGIS,
  VERTEXSIZE,
} from "./glquake";
import {
  GL_ALPHA,
  GL_BLEND,
  GL_INTENSITY,
  GL_LINEAR,
  GL_LUMINANCE,
  GL_MODULATE,
  GL_ONE_MINUS_SRC_ALPHA,
  GL_ONE_MINUS_SRC_COLOR,
  GL_POLYGON,
  GL_REPLACE,
  GL_RGBA,
  GL_RGBA4,
  GL_SRC_ALPHA,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TRIANGLE_FAN,
  GL_UNSIGNED_BYTE,
  GL_ZERO,
  qgl,
} from "./qgl";
import { glDrawState, GL_Bind, GL_SelectTexture } from "./gl_draw";
import { gl_flashblend, gl_keeptjunctions, gl_texsort, R_CullBox, R_RotateForEntity, r_dynamic, r_fullbright, r_lightmap, r_mirroralpha, r_novis, r_wateralpha } from "./gl_rmain";
import { R_MarkLights } from "./gl_rlight";
import { R_StoreEfrags } from "./gl_refrag";
import { isPermedia } from "./gl_vid";
import { EmitBothSkyLayers, EmitSkyPolys, EmitWaterPolys, glWarpState, R_DrawSkyChain } from "./gl_warp";

export const blocklights = new Uint32Array(18 * 18);

export class GlRectT {
  l = 0;
  t = 0;
  w = 0;
  h = 0;
}

export const lightmap_polys: Array<GlpolyT | null> = new Array<GlpolyT | null>(MAX_LIGHTMAPS).fill(null);
export const lightmap_modified: boolean[] = new Array<boolean>(MAX_LIGHTMAPS).fill(false);
export const lightmap_rectchange: GlRectT[] = Array.from({ length: MAX_LIGHTMAPS }, () => new GlRectT());

export const allocated = new Int32Array(MAX_LIGHTMAPS * BLOCK_WIDTH);

// the lightmap texture data needs to be kept in
// main memory so texsubimage can update properly
export const lightmaps = new Uint8Array(4 * MAX_LIGHTMAPS * BLOCK_WIDTH * BLOCK_HEIGHT);

export type GlRsurfStateT = {
  lightmap_bytes: number; // 1, 2, or 4
  active_lightmaps: number;
  // For gl_texsort 0
  skychain: MsurfaceT | null;
  waterchain: MsurfaceT | null;
  mtexenabled: boolean;
  r_pcurrentvertbase: MvertexT[] | null;
  currentmodel: ModelT | null;
  nColinElim: number;
};

export const glRsurfState: GlRsurfStateT = {
  lightmap_bytes: 0,
  active_lightmaps: 0,
  skychain: null,
  waterchain: null,
  mtexenabled: false,
  r_pcurrentvertbase: null,
  currentmodel: null,
  nColinElim: 0,
};

/*
===============
R_AddDynamicLights
===============
*/
export function R_AddDynamicLights(surf: MsurfaceT): void {
  const impact: Vec3 = vec3();
  const local: Vec3 = vec3();

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const tex = surf.texinfo;
  if (tex === null) return Sys_Error("R_AddDynamicLights: surface has no texinfo");
  const plane = surf.plane;
  if (plane === null) return Sys_Error("R_AddDynamicLights: surface has no plane");

  for (let lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
    if (!(surf.dlightbits & (1 << lnum))) continue; // not lit by this light

    let rad = cl_dlights[lnum].radius;
    let dist = DotProduct(cl_dlights[lnum].origin, plane.normal) - plane.dist;
    rad -= Math.abs(dist);
    let minlight = cl_dlights[lnum].minlight;
    if (rad < minlight) continue;
    minlight = rad - minlight;

    for (let i = 0; i < 3; i++) {
      impact[i] = cl_dlights[lnum].origin[i] - plane.normal[i] * dist;
    }

    local[0] = DotProduct(impact, tex.vecs[0]) + tex.vecs[0][3];
    local[1] = DotProduct(impact, tex.vecs[1]) + tex.vecs[1][3];

    local[0] -= surf.texturemins[0];
    local[1] -= surf.texturemins[1];

    for (let t = 0; t < tmax; t++) {
      let td = (local[1] - t * 16) | 0;
      if (td < 0) td = -td;
      for (let s = 0; s < smax; s++) {
        let sd = (local[0] - s * 16) | 0;
        if (sd < 0) sd = -sd;
        if (sd > td) dist = sd + (td >> 1);
        else dist = td + (sd >> 1);
        if (dist < minlight) blocklights[t * smax + s] += (rad - dist) * 256;
      }
    }
  }
}

/*
===============
R_BuildLightMap

Combine and scale multiple lightmaps into the 8.8 format in blocklights
===============
*/
export function R_BuildLightMap(surf: MsurfaceT, dest: Uint8Array, destOfs: number, stride: number): void {
  surf.cached_dlight = surf.dlightframe === glState.r_framecount;

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const size = smax * tmax;
  const lightmap = surf.samples;

  const worldmodel = cl.worldmodel;

  // set to full bright if no light data. QW/client/gl_rsurf.c comments out
  // the r_fullbright.value check (dynamic lightmaps always rebuild).
  if ((!qw.active && r_fullbright.value) || worldmodel === null || !worldmodel.lightdata) {
    for (let i = 0; i < size; i++) blocklights[i] = 255 * 256;
  } else {
    // clear to no light
    for (let i = 0; i < size; i++) blocklights[i] = 0;

    // add all the lightmaps
    if (lightmap) {
      let lightofs = 0;
      for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
        const scale = d_lightstylevalue[surf.styles[maps]];
        surf.cached_light[maps] = scale; // 8.8 fraction
        for (let i = 0; i < size; i++) blocklights[i] += lightmap[lightofs + i] * scale;
        lightofs += size; // skip to next lightmap
      }
    }

    // add all the dynamic lights
    if (surf.dlightframe === glState.r_framecount) R_AddDynamicLights(surf);
  }

  // bound, invert, and shift
  switch (glDrawState.gl_lightmap_format) {
    case GL_RGBA: {
      stride -= smax << 2;
      let bl = 0;
      for (let i = 0; i < tmax; i++, destOfs += stride) {
        for (let j = 0; j < smax; j++) {
          let t = blocklights[bl++] | 0;
          t >>= 7;
          if (t > 255) t = 255;
          dest[destOfs + 3] = 255 - t;
          destOfs += 4;
        }
      }
      break;
    }
    case GL_ALPHA:
    case GL_LUMINANCE:
    case GL_INTENSITY: {
      let bl = 0;
      for (let i = 0; i < tmax; i++, destOfs += stride) {
        for (let j = 0; j < smax; j++) {
          let t = blocklights[bl++] | 0;
          t >>= 7;
          if (t > 255) t = 255;
          dest[destOfs + j] = 255 - t;
        }
      }
      break;
    }
    default:
      Sys_Error("Bad lightmap format");
  }
}

// QW/client/gl_rsurf.c: three call sites (R_BlendLightmaps, R_RenderBrushPoly,
// R_RecursiveWorldNode) replace a plain `flags & SURF_UNDERWATER` check with
// this r_viewleaf.contents-based test, ANDed with !SURF_DONTWARP (set by
// src/ref_gl/gl_model.ts's afterBrushLoad for non-map brush models). A null
// r_viewleaf cannot happen once rendering starts in the C; treated as
// CONTENTS_EMPTY here so the expression stays total.
function qwShouldWarp(flags: number): boolean {
  const emptyLeaf = glState.r_viewleaf === null || glState.r_viewleaf.contents === CONTENTS_EMPTY;
  const underwaterMatch = emptyLeaf ? (flags & SURF_UNDERWATER) !== 0 : (flags & SURF_UNDERWATER) === 0;
  return underwaterMatch && (flags & SURF_DONTWARP) === 0;
}

/*
===============
R_TextureAnimation

Returns the proper texture for a given time and base texture
===============
*/
export function R_TextureAnimation(base: TextureT): TextureT {
  const currententity = glState.currententity;
  if (currententity === null) return Sys_Error("R_TextureAnimation: no currententity");

  if (currententity.frame) {
    if (base.alternate_anims) base = base.alternate_anims;
  }

  if (!base.anim_total) return base;

  const reletive = ((cl.time * 10) | 0) % base.anim_total;

  let count = 0;
  while (base.anim_min > reletive || base.anim_max <= reletive) {
    const next = base.anim_next;
    if (!next) return Sys_Error("R_TextureAnimation: broken cycle");
    base = next;
    if (++count > 100) return Sys_Error("R_TextureAnimation: infinite cycle");
  }

  return base;
}

/*
=============================================================

	BRUSH MODELS

=============================================================
*/

export function GL_DisableMultitexture(): void {
  if (glRsurfState.mtexenabled) {
    qgl().qglDisable(GL_TEXTURE_2D);
    GL_SelectTexture(TEXTURE0_SGIS);
    glRsurfState.mtexenabled = false;
  }
}

export function GL_EnableMultitexture(): void {
  if (glState.gl_mtexable) {
    GL_SelectTexture(TEXTURE1_SGIS);
    qgl().qglEnable(GL_TEXTURE_2D);
    glRsurfState.mtexenabled = true;
  }
}

// The lightmap-rect flush the two multitexture paths of R_DrawSequentialPoly
// perform verbatim (gl_rsurf.c:440-451 and :542-553).
function uploadModifiedLightmapRect(i: number): void {
  if (lightmap_modified[i]) {
    lightmap_modified[i] = false;
    const theRect = lightmap_rectchange[i];
    qgl().qglTexSubImage2D(
      GL_TEXTURE_2D,
      0,
      0,
      theRect.t,
      BLOCK_WIDTH,
      theRect.h,
      glDrawState.gl_lightmap_format,
      GL_UNSIGNED_BYTE,
      lightmaps.subarray((i * BLOCK_HEIGHT + theRect.t) * BLOCK_WIDTH * glRsurfState.lightmap_bytes),
    );
    theRect.l = BLOCK_WIDTH;
    theRect.t = BLOCK_HEIGHT;
    theRect.h = 0;
    theRect.w = 0;
  }
}

/*
================
R_DrawSequentialPoly

Systems that have fast state and texture changes can
just do everything as it passes with no need to sort
================
*/
export function R_DrawSequentialPoly(s: MsurfaceT): void {
  const gl = qgl();
  const nv: Vec3 = vec3();

  const texinfo = s.texinfo;
  if (texinfo === null || texinfo.texture === null) return Sys_Error("R_DrawSequentialPoly: surface has no texture");

  // QW/client/gl_rsurf.c compiles a DIFFERENT, non-multitexture body of this
  // function on non-_WIN32 (WinQuake wraps that same body in `#if 0`, always
  // dead, and always compiles the multitexture-aware body below instead).
  // QW's replacement body also comments out the normal-lightmapped-poly
  // condition and compiles `if (0)` in its place, so that whole fast path is
  // dead code there too (never implemented here -- it cannot run) and every
  // non-SURF_DRAWTURB surface, including plain opaque walls, falls all the
  // way through the SURF_DRAWSKY check into the underwater-warp-with-lightmap
  // tail unconditionally. Exactly as the original.
  if (qw.active) {
    if (s.flags & SURF_DRAWTURB) {
      GL_Bind(texinfo.texture.gl_texturenum);
      EmitWaterPolys(s);
      return;
    }

    if (s.flags & SURF_DRAWSKY) {
      GL_Bind(glWarpState.solidskytexture);
      glWarpState.speedscale = host.realtime * 8;
      glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;

      EmitSkyPolys(s);

      gl.qglEnable(GL_BLEND);
      gl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
      GL_Bind(glWarpState.alphaskytexture);
      glWarpState.speedscale = host.realtime * 16;
      glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;
      EmitSkyPolys(s);
      if (glDrawState.gl_lightmap_format === GL_LUMINANCE) gl.qglBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_COLOR);

      gl.qglDisable(GL_BLEND);
      // no return: falls through to the underwater-warp tail below, as the C does.
    }

    //
    // underwater warped with lightmap
    //
    const p = surfPolys(s);
    if (p === null) return Sys_Error("R_DrawSequentialPoly: surface has no polys");

    const t = R_TextureAnimation(texinfo.texture);
    GL_Bind(t.gl_texturenum);
    DrawGLWaterPoly(p);

    GL_Bind(glState.lightmap_textures + s.lightmaptexturenum);
    gl.qglEnable(GL_BLEND);
    DrawGLWaterPolyLightmap(p);
    gl.qglDisable(GL_BLEND);
    return;
  }

  //
  // normal lightmaped poly
  //

  if (!(s.flags & (SURF_DRAWSKY | SURF_DRAWTURB | SURF_UNDERWATER))) {
    R_RenderDynamicLightmaps(s);
    if (glState.gl_mtexable) {
      const p = surfPolys(s);
      if (p === null) return Sys_Error("R_DrawSequentialPoly: surface has no polys");
      const mtex = gl.qglMTexCoord2fSGIS;
      if (mtex === null) return Sys_Error("R_DrawSequentialPoly: no multitexture entry point");

      const t = R_TextureAnimation(texinfo.texture);
      // Binds world to texture env 0
      GL_SelectTexture(TEXTURE0_SGIS);
      GL_Bind(t.gl_texturenum);
      gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
      // Binds lightmap to texenv 1
      GL_EnableMultitexture(); // Same as SelectTexture (TEXTURE1)
      GL_Bind(glState.lightmap_textures + s.lightmaptexturenum);
      uploadModifiedLightmapRect(s.lightmaptexturenum);
      gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_BLEND);
      gl.qglBegin(GL_POLYGON);
      for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
        mtex(TEXTURE0_SGIS, p.verts[v + 3], p.verts[v + 4]);
        mtex(TEXTURE1_SGIS, p.verts[v + 5], p.verts[v + 6]);
        gl.qglVertex3fv(p.verts.subarray(v, v + 3));
      }
      gl.qglEnd();
      return;
    } else {
      const p = surfPolys(s);
      if (p === null) return Sys_Error("R_DrawSequentialPoly: surface has no polys");

      const t = R_TextureAnimation(texinfo.texture);
      GL_Bind(t.gl_texturenum);
      gl.qglBegin(GL_POLYGON);
      for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
        gl.qglTexCoord2f(p.verts[v + 3], p.verts[v + 4]);
        gl.qglVertex3fv(p.verts.subarray(v, v + 3));
      }
      gl.qglEnd();

      GL_Bind(glState.lightmap_textures + s.lightmaptexturenum);
      gl.qglEnable(GL_BLEND);
      gl.qglBegin(GL_POLYGON);
      for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
        gl.qglTexCoord2f(p.verts[v + 5], p.verts[v + 6]);
        gl.qglVertex3fv(p.verts.subarray(v, v + 3));
      }
      gl.qglEnd();

      gl.qglDisable(GL_BLEND);
    }

    return;
  }

  //
  // subdivided water surface warp
  //

  if (s.flags & SURF_DRAWTURB) {
    GL_DisableMultitexture();
    GL_Bind(texinfo.texture.gl_texturenum);
    EmitWaterPolys(s);
    return;
  }

  //
  // subdivided sky warp
  //
  if (s.flags & SURF_DRAWSKY) {
    GL_DisableMultitexture();
    GL_Bind(glWarpState.solidskytexture);
    glWarpState.speedscale = host.realtime * 8;
    glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;

    EmitSkyPolys(s);

    gl.qglEnable(GL_BLEND);
    GL_Bind(glWarpState.alphaskytexture);
    glWarpState.speedscale = host.realtime * 16;
    glWarpState.speedscale -= (glWarpState.speedscale | 0) & ~127;
    EmitSkyPolys(s);

    gl.qglDisable(GL_BLEND);
    return;
  }

  //
  // underwater warped with lightmap
  //
  R_RenderDynamicLightmaps(s);
  const p = surfPolys(s);
  if (p === null) return Sys_Error("R_DrawSequentialPoly: surface has no polys");
  if (glState.gl_mtexable) {
    const mtex = gl.qglMTexCoord2fSGIS;
    if (mtex === null) return Sys_Error("R_DrawSequentialPoly: no multitexture entry point");

    const t = R_TextureAnimation(texinfo.texture);
    GL_SelectTexture(TEXTURE0_SGIS);
    GL_Bind(t.gl_texturenum);
    gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
    GL_EnableMultitexture();
    GL_Bind(glState.lightmap_textures + s.lightmaptexturenum);
    uploadModifiedLightmapRect(s.lightmaptexturenum);
    gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_BLEND);
    gl.qglBegin(GL_TRIANGLE_FAN);
    for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
      mtex(TEXTURE0_SGIS, p.verts[v + 3], p.verts[v + 4]);
      mtex(TEXTURE1_SGIS, p.verts[v + 5], p.verts[v + 6]);

      nv[0] = p.verts[v] + 8 * Math.sin(p.verts[v + 1] * 0.05 + host.realtime) * Math.sin(p.verts[v + 2] * 0.05 + host.realtime);
      nv[1] = p.verts[v + 1] + 8 * Math.sin(p.verts[v] * 0.05 + host.realtime) * Math.sin(p.verts[v + 2] * 0.05 + host.realtime);
      nv[2] = p.verts[v + 2];

      gl.qglVertex3fv(nv);
    }
    gl.qglEnd();
  } else {
    const t = R_TextureAnimation(texinfo.texture);
    GL_Bind(t.gl_texturenum);
    DrawGLWaterPoly(p);

    GL_Bind(glState.lightmap_textures + s.lightmaptexturenum);
    gl.qglEnable(GL_BLEND);
    DrawGLWaterPolyLightmap(p);
    gl.qglDisable(GL_BLEND);
  }
}

/*
================
DrawGLWaterPoly

Warp the vertex coordinates
================
*/
export function DrawGLWaterPoly(p: GlpolyT): void {
  const gl = qgl();
  const nv: Vec3 = vec3();

  GL_DisableMultitexture();

  gl.qglBegin(GL_TRIANGLE_FAN);
  for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
    gl.qglTexCoord2f(p.verts[v + 3], p.verts[v + 4]);

    nv[0] = p.verts[v] + 8 * Math.sin(p.verts[v + 1] * 0.05 + host.realtime) * Math.sin(p.verts[v + 2] * 0.05 + host.realtime);
    nv[1] = p.verts[v + 1] + 8 * Math.sin(p.verts[v] * 0.05 + host.realtime) * Math.sin(p.verts[v + 2] * 0.05 + host.realtime);
    nv[2] = p.verts[v + 2];

    gl.qglVertex3fv(nv);
  }
  gl.qglEnd();
}

export function DrawGLWaterPolyLightmap(p: GlpolyT): void {
  const gl = qgl();
  const nv: Vec3 = vec3();

  GL_DisableMultitexture();

  gl.qglBegin(GL_TRIANGLE_FAN);
  for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
    gl.qglTexCoord2f(p.verts[v + 5], p.verts[v + 6]);

    nv[0] = p.verts[v] + 8 * Math.sin(p.verts[v + 1] * 0.05 + host.realtime) * Math.sin(p.verts[v + 2] * 0.05 + host.realtime);
    nv[1] = p.verts[v + 1] + 8 * Math.sin(p.verts[v] * 0.05 + host.realtime) * Math.sin(p.verts[v + 2] * 0.05 + host.realtime);
    nv[2] = p.verts[v + 2];

    gl.qglVertex3fv(nv);
  }
  gl.qglEnd();
}

/*
================
DrawGLPoly
================
*/
export function DrawGLPoly(p: GlpolyT): void {
  const gl = qgl();

  gl.qglBegin(GL_POLYGON);
  for (let i = 0, v = 0; i < p.numverts; i++, v += VERTEXSIZE) {
    gl.qglTexCoord2f(p.verts[v + 3], p.verts[v + 4]);
    gl.qglVertex3fv(p.verts.subarray(v, v + 3));
  }
  gl.qglEnd();
}

/*
================
R_BlendLightmaps
================
*/
export function R_BlendLightmaps(): void {
  const gl = qgl();

  // QW/client/gl_rsurf.c wraps this check in `#if 0` (always dead there).
  if (!qw.active && r_fullbright.value) return;
  if (!gl_texsort.value) return;

  gl.qglDepthMask(false); // don't bother writing Z

  if (glDrawState.gl_lightmap_format === GL_LUMINANCE) gl.qglBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_COLOR);
  else if (glDrawState.gl_lightmap_format === GL_INTENSITY) {
    gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    gl.qglColor4f(0, 0, 0, 1);
    gl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  }

  if (!r_lightmap.value) {
    gl.qglEnable(GL_BLEND);
  }

  for (let i = 0; i < MAX_LIGHTMAPS; i++) {
    let p = lightmap_polys[i];
    if (!p) continue;
    GL_Bind(glState.lightmap_textures + i);
    if (lightmap_modified[i]) {
      lightmap_modified[i] = false;
      const theRect = lightmap_rectchange[i];
      gl.qglTexSubImage2D(
        GL_TEXTURE_2D,
        0,
        0,
        theRect.t,
        BLOCK_WIDTH,
        theRect.h,
        glDrawState.gl_lightmap_format,
        GL_UNSIGNED_BYTE,
        lightmaps.subarray((i * BLOCK_HEIGHT + theRect.t) * BLOCK_WIDTH * glRsurfState.lightmap_bytes),
      );
      theRect.l = BLOCK_WIDTH;
      theRect.t = BLOCK_HEIGHT;
      theRect.h = 0;
      theRect.w = 0;
    }
    for (; p; p = p.chain) {
      if (qw.active ? qwShouldWarp(p.flags) : (p.flags & SURF_UNDERWATER) !== 0) DrawGLWaterPolyLightmap(p);
      else {
        gl.qglBegin(GL_POLYGON);
        for (let j = 0, v = 0; j < p.numverts; j++, v += VERTEXSIZE) {
          gl.qglTexCoord2f(p.verts[v + 5], p.verts[v + 6]);
          gl.qglVertex3fv(p.verts.subarray(v, v + 3));
        }
        gl.qglEnd();
      }
    }
  }

  gl.qglDisable(GL_BLEND);
  if (glDrawState.gl_lightmap_format === GL_LUMINANCE) gl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  else if (glDrawState.gl_lightmap_format === GL_INTENSITY) {
    gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
    gl.qglColor4f(1, 1, 1, 1);
  }

  gl.qglDepthMask(true); // back to normal Z buffering
}

// The "check for lightmap modification" tail R_RenderBrushPoly and
// R_RenderDynamicLightmaps share verbatim (gl_rsurf.c:789-823 and :848-882),
// including the `goto dynamic` jump into the if body.
function checkLightmapModification(fa: MsurfaceT): void {
  let dynamic = false;
  for (let maps = 0; maps < MAXLIGHTMAPS && fa.styles[maps] !== 255; maps++)
    if (d_lightstylevalue[fa.styles[maps]] !== fa.cached_light[maps]) {
      dynamic = true;
      break;
    }

  if (
    dynamic ||
    fa.dlightframe === glState.r_framecount || // dynamic this frame
    fa.cached_dlight // dynamic previously
  ) {
    if (r_dynamic.value) {
      lightmap_modified[fa.lightmaptexturenum] = true;
      const theRect = lightmap_rectchange[fa.lightmaptexturenum];
      if (fa.light_t < theRect.t) {
        if (theRect.h) theRect.h += theRect.t - fa.light_t;
        theRect.t = fa.light_t;
      }
      if (fa.light_s < theRect.l) {
        if (theRect.w) theRect.w += theRect.l - fa.light_s;
        theRect.l = fa.light_s;
      }
      const smax = (fa.extents[0] >> 4) + 1;
      const tmax = (fa.extents[1] >> 4) + 1;
      if (theRect.w + theRect.l < fa.light_s + smax) theRect.w = fa.light_s - theRect.l + smax;
      if (theRect.h + theRect.t < fa.light_t + tmax) theRect.h = fa.light_t - theRect.t + tmax;
      let base = fa.lightmaptexturenum * glRsurfState.lightmap_bytes * BLOCK_WIDTH * BLOCK_HEIGHT;
      base += fa.light_t * BLOCK_WIDTH * glRsurfState.lightmap_bytes + fa.light_s * glRsurfState.lightmap_bytes;
      R_BuildLightMap(fa, lightmaps, base, BLOCK_WIDTH * glRsurfState.lightmap_bytes);
    }
  }
}

/*
================
R_RenderBrushPoly
================
*/
export function R_RenderBrushPoly(fa: MsurfaceT): void {
  glState.c_brush_polys++;

  if (fa.flags & SURF_DRAWSKY) {
    // warp texture, no lightmaps
    EmitBothSkyLayers(fa);
    return;
  }

  const texinfo = fa.texinfo;
  if (texinfo === null || texinfo.texture === null) return Sys_Error("R_RenderBrushPoly: surface has no texture");

  const t = R_TextureAnimation(texinfo.texture);
  GL_Bind(t.gl_texturenum);

  if (fa.flags & SURF_DRAWTURB) {
    // warp texture, no lightmaps
    EmitWaterPolys(fa);
    return;
  }

  const polys = surfPolys(fa);
  if (polys === null) return Sys_Error("R_RenderBrushPoly: surface has no polys");

  if (qw.active ? qwShouldWarp(fa.flags) : (fa.flags & SURF_UNDERWATER) !== 0) DrawGLWaterPoly(polys);
  else DrawGLPoly(polys);

  // add the poly to the proper lightmap chain

  polys.chain = lightmap_polys[fa.lightmaptexturenum];
  lightmap_polys[fa.lightmaptexturenum] = polys;

  // check for lightmap modification
  checkLightmapModification(fa);
}

/*
================
R_RenderDynamicLightmaps
Multitexture
================
*/
export function R_RenderDynamicLightmaps(fa: MsurfaceT): void {
  glState.c_brush_polys++;

  if (fa.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) return;

  const polys = surfPolys(fa);
  if (polys === null) return Sys_Error("R_RenderDynamicLightmaps: surface has no polys");

  polys.chain = lightmap_polys[fa.lightmaptexturenum];
  lightmap_polys[fa.lightmaptexturenum] = polys;

  // check for lightmap modification
  checkLightmapModification(fa);
}

/*
================
R_MirrorChain
================
*/
export function R_MirrorChain(s: MsurfaceT): void {
  if (glState.mirror) return;
  glState.mirror = true;
  glState.mirror_plane = s.plane;
}

/*
================
R_DrawWaterSurfaces
================
*/
export function R_DrawWaterSurfaces(): void {
  const gl = qgl();

  if (r_wateralpha.value === 1.0 && gl_texsort.value) return;

  //
  // go back to the world matrix
  //

  gl.qglLoadMatrixf(r_world_matrix);

  if (r_wateralpha.value < 1.0) {
    gl.qglEnable(GL_BLEND);
    gl.qglColor4f(1, 1, 1, r_wateralpha.value);
    gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
  }

  if (!gl_texsort.value) {
    if (!glRsurfState.waterchain) return;

    for (let s: MsurfaceT | null = glRsurfState.waterchain; s; s = s.texturechain) {
      const texinfo = s.texinfo;
      if (texinfo === null || texinfo.texture === null) return Sys_Error("R_DrawWaterSurfaces: surface has no texture");
      GL_Bind(texinfo.texture.gl_texturenum);
      EmitWaterPolys(s);
    }

    glRsurfState.waterchain = null;
  } else {
    const worldmodel = cl.worldmodel;
    if (worldmodel === null || worldmodel.textures === null) return Sys_Error("R_DrawWaterSurfaces: no worldmodel");

    for (let i = 0; i < worldmodel.numtextures; i++) {
      const t = worldmodel.textures[i];
      if (!t) continue;
      let s = t.texturechain;
      if (!s) continue;
      if (!(s.flags & SURF_DRAWTURB)) continue;

      // set modulate mode explicitly

      GL_Bind(t.gl_texturenum);

      for (; s; s = s.texturechain) EmitWaterPolys(s);

      t.texturechain = null;
    }
  }

  if (r_wateralpha.value < 1.0) {
    gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);

    gl.qglColor4f(1, 1, 1, 1);
    gl.qglDisable(GL_BLEND);
  }
}

/*
================
DrawTextureChains
================
*/
export function DrawTextureChains(): void {
  if (!gl_texsort.value) {
    GL_DisableMultitexture();

    if (glRsurfState.skychain) {
      R_DrawSkyChain(glRsurfState.skychain);
      glRsurfState.skychain = null;
    }

    return;
  }

  const worldmodel = cl.worldmodel;
  if (worldmodel === null || worldmodel.textures === null) return Sys_Error("DrawTextureChains: no worldmodel");

  for (let i = 0; i < worldmodel.numtextures; i++) {
    const t = worldmodel.textures[i];
    if (!t) continue;
    let s = t.texturechain;
    if (!s) continue;
    if (i === glState.skytexturenum) R_DrawSkyChain(s);
    else if (i === glState.mirrortexturenum && r_mirroralpha.value !== 1.0) {
      R_MirrorChain(s);
      continue;
    } else {
      if (s.flags & SURF_DRAWTURB && r_wateralpha.value !== 1.0) continue; // draw translucent water later
      for (; s; s = s.texturechain) R_RenderBrushPoly(s);
    }

    t.texturechain = null;
  }
}

/*
=================
R_DrawBrushModel
=================
*/
export function R_DrawBrushModel(e: EntityT): void {
  const gl = qgl();
  const mins: Vec3 = vec3();
  const maxs: Vec3 = vec3();
  let rotated: boolean;

  glState.currententity = e;
  glState.currenttexture = -1;

  const clmodel = e.model;
  if (clmodel === null) return Sys_Error("R_DrawBrushModel: entity has no model");

  if (e.angles[0] || e.angles[1] || e.angles[2]) {
    rotated = true;
    for (let i = 0; i < 3; i++) {
      mins[i] = e.origin[i] - clmodel.radius;
      maxs[i] = e.origin[i] + clmodel.radius;
    }
  } else {
    rotated = false;
    VectorAdd(e.origin, clmodel.mins, mins);
    VectorAdd(e.origin, clmodel.maxs, maxs);
  }

  if (R_CullBox(mins, maxs)) return;

  gl.qglColor3f(1, 1, 1);
  lightmap_polys.fill(null);

  VectorSubtract(r_refdef.vieworg, e.origin, modelorg);
  if (rotated) {
    const temp: Vec3 = vec3();
    const forward: Vec3 = vec3();
    const right: Vec3 = vec3();
    const up: Vec3 = vec3();

    VectorCopy(modelorg, temp);
    AngleVectors(e.angles, forward, right, up);
    modelorg[0] = DotProduct(temp, forward);
    modelorg[1] = -DotProduct(temp, right);
    modelorg[2] = DotProduct(temp, up);
  }

  let psurf = clmodel.firstmodelsurface;

  // calculate dynamic lighting for bmodel if it's not an
  // instanced model
  if (clmodel.firstmodelsurface !== 0 && !gl_flashblend.value) {
    for (let k = 0; k < MAX_DLIGHTS; k++) {
      if (cl_dlights[k].die < cl.time || !cl_dlights[k].radius) continue;

      R_MarkLights(cl_dlights[k], 1 << k, clmodel.nodes[clmodel.hulls[0].firstclipnode]);
    }
  }

  gl.qglPushMatrix();
  e.angles[0] = -e.angles[0]; // stupid quake bug
  R_RotateForEntity(e);
  e.angles[0] = -e.angles[0]; // stupid quake bug

  //
  // draw texture
  //
  for (let i = 0; i < clmodel.nummodelsurfaces; i++, psurf++) {
    const surf = clmodel.surfaces[psurf];
    // find which side of the node we are on
    const pplane = surf.plane;
    if (pplane === null) return Sys_Error("R_DrawBrushModel: surface has no plane");

    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if ((surf.flags & SURF_PLANEBACK && dot < -BACKFACE_EPSILON) || (!(surf.flags & SURF_PLANEBACK) && dot > BACKFACE_EPSILON)) {
      if (gl_texsort.value) R_RenderBrushPoly(surf);
      else R_DrawSequentialPoly(surf);
    }
  }

  R_BlendLightmaps();

  gl.qglPopMatrix();
}

/*
=============================================================

	WORLD MODEL

=============================================================
*/

/*
================
R_RecursiveWorldNode
================
*/
export function R_RecursiveWorldNode(node: MnodeT | MleafT): void {
  if (node.contents === CONTENTS_SOLID) return; // solid

  if (node.visframe !== glState.r_visframecount) return;
  if (R_CullBox(node.minmaxs.subarray(0, 3), node.minmaxs.subarray(3, 6))) return;

  // if a leaf node, draw stuff
  if (node.contents < 0) {
    if (!isMleaf(node)) return Sys_Error("R_RecursiveWorldNode: leaf contents on a node");
    const pleaf = node;

    let mark = pleaf.firstmarksurface;
    let c = pleaf.nummarksurfaces;

    if (c) {
      do {
        pleaf.marksurfaces[mark].visframe = glState.r_framecount;
        mark++;
      } while (--c);
    }

    // deal with model fragments in this leaf
    if (pleaf.efrags) R_StoreEfrags(pleaf.efrags);

    return;
  }

  if (isMleaf(node)) return Sys_Error("R_RecursiveWorldNode: node contents on a leaf");

  // node is just a decision point, so go down the apropriate sides

  // find which side of the node we are on
  const plane = node.plane;
  if (plane === null) return Sys_Error("R_RecursiveWorldNode: node has no plane");

  let dot: number;
  switch (plane.type) {
    case PLANE_X:
      dot = modelorg[0] - plane.dist;
      break;
    case PLANE_Y:
      dot = modelorg[1] - plane.dist;
      break;
    case PLANE_Z:
      dot = modelorg[2] - plane.dist;
      break;
    default:
      dot = DotProduct(modelorg, plane.normal) - plane.dist;
      break;
  }

  let side: number;
  if (dot >= 0) side = 0;
  else side = 1;

  // recurse down the children, front side first
  const front = node.children[side];
  if (front !== null) R_RecursiveWorldNode(front);

  // draw stuff
  let c = node.numsurfaces;

  if (c) {
    const worldmodel = cl.worldmodel;
    if (worldmodel === null) return Sys_Error("R_RecursiveWorldNode: no worldmodel");
    let surfIndex = node.firstsurface;

    if (dot < 0 - BACKFACE_EPSILON) side = SURF_PLANEBACK;
    else if (dot > BACKFACE_EPSILON) side = 0;
    {
      for (; c; c--, surfIndex++) {
        const surf = worldmodel.surfaces[surfIndex];
        if (surf.visframe !== glState.r_framecount) continue;

        // don't backface underwater surfaces, because they warp
        if (
          !(qw.active ? qwShouldWarp(surf.flags) : (surf.flags & SURF_UNDERWATER) !== 0) &&
          ((dot < 0 ? 1 : 0) ^ (surf.flags & SURF_PLANEBACK ? 1 : 0))
        )
          continue; // wrong side

        // if sorting by texture, just store it out
        if (gl_texsort.value) {
          const texinfo = surf.texinfo;
          if (texinfo === null || texinfo.texture === null) return Sys_Error("R_RecursiveWorldNode: surface has no texture");
          const mirrortex = worldmodel.textures === null ? null : worldmodel.textures[glState.mirrortexturenum];
          if (!glState.mirror || texinfo.texture !== mirrortex) {
            surf.texturechain = texinfo.texture.texturechain;
            texinfo.texture.texturechain = surf;
          }
        } else if (surf.flags & SURF_DRAWSKY) {
          surf.texturechain = glRsurfState.skychain;
          glRsurfState.skychain = surf;
        } else if (surf.flags & SURF_DRAWTURB) {
          surf.texturechain = glRsurfState.waterchain;
          glRsurfState.waterchain = surf;
        } else R_DrawSequentialPoly(surf);
      }
    }
  }

  // recurse down the back side
  const back = node.children[side ? 0 : 1];
  if (back !== null) R_RecursiveWorldNode(back);
}

/*
=============
R_DrawWorld
=============
*/
export function R_DrawWorld(): void {
  const gl = qgl();
  const ent = new EntityT();

  const worldmodel = cl.worldmodel;
  if (worldmodel === null) return Sys_Error("R_DrawWorld: no worldmodel");
  ent.model = worldmodel;

  VectorCopy(r_refdef.vieworg, modelorg);

  glState.currententity = ent;
  glState.currenttexture = -1;

  gl.qglColor3f(1, 1, 1);
  lightmap_polys.fill(null);

  R_RecursiveWorldNode(worldmodel.nodes[0]);

  DrawTextureChains();

  R_BlendLightmaps();
}

// R_MarkLeaves's `byte solid[4096]`
const solid = new Uint8Array(4096);

/*
===============
R_MarkLeaves
===============
*/
export function R_MarkLeaves(): void {
  let vis: Uint8Array;

  if (glState.r_oldviewleaf === glState.r_viewleaf && !r_novis.value) return;

  if (glState.mirror) return;

  glState.r_visframecount++;
  glState.r_oldviewleaf = glState.r_viewleaf;

  const worldmodel = cl.worldmodel;
  if (worldmodel === null) return Sys_Error("R_MarkLeaves: no worldmodel");

  if (r_novis.value) {
    vis = solid;
    solid.fill(0xff, 0, (worldmodel.numleafs + 7) >> 3);
  } else {
    const viewleaf = glState.r_viewleaf;
    if (viewleaf === null) return Sys_Error("R_MarkLeaves: no viewleaf");
    vis = Mod_LeafPVS(viewleaf, worldmodel);
  }

  for (let i = 0; i < worldmodel.numleafs; i++) {
    if (vis[i >> 3] & (1 << (i & 7))) {
      let node: MnodeT | MleafT | null = worldmodel.leafs[i + 1];
      do {
        if (node.visframe === glState.r_visframecount) break;
        node.visframe = glState.r_visframecount;
        node = node.parent;
      } while (node);
    }
  }
}

/*
=============================================================================

  LIGHTMAP ALLOCATION

=============================================================================
*/

// returns a texture number and the position inside it
export function AllocBlock(w: number, h: number, pos: { x: number; y: number }): number {
  for (let texnum = 0; texnum < MAX_LIGHTMAPS; texnum++) {
    let best = BLOCK_HEIGHT;

    for (let i = 0; i < BLOCK_WIDTH - w; i++) {
      let best2 = 0;

      let j = 0;
      for (j = 0; j < w; j++) {
        if (allocated[texnum * BLOCK_WIDTH + i + j] >= best) break;
        if (allocated[texnum * BLOCK_WIDTH + i + j] > best2) best2 = allocated[texnum * BLOCK_WIDTH + i + j];
      }
      if (j === w) {
        // this is a valid spot
        pos.x = i;
        pos.y = best = best2;
      }
    }

    if (best + h > BLOCK_HEIGHT) continue;

    for (let i = 0; i < w; i++) allocated[texnum * BLOCK_WIDTH + pos.x + i] = best + h;

    return texnum;
  }

  return Sys_Error("AllocBlock: full");
}

/*
================
BuildSurfaceDisplayList
================
*/
export function BuildSurfaceDisplayList(fa: MsurfaceT): void {
  const currentmodel = glRsurfState.currentmodel;
  if (currentmodel === null) return Sys_Error("BuildSurfaceDisplayList: no currentmodel");
  const r_pcurrentvertbase = glRsurfState.r_pcurrentvertbase;
  if (r_pcurrentvertbase === null) return Sys_Error("BuildSurfaceDisplayList: no vertex base");
  const texinfo = fa.texinfo;
  if (texinfo === null || texinfo.texture === null) return Sys_Error("BuildSurfaceDisplayList: surface has no texture");

  // reconstruct the polygon
  const pedges = currentmodel.edges;
  let lnumverts = fa.numedges;

  //
  // draw texture
  //
  const poly = new GlpolyT(lnumverts);
  poly.next = surfPolys(fa);
  poly.flags = fa.flags;
  setSurfPolys(fa, poly);
  poly.numverts = lnumverts;

  for (let i = 0; i < lnumverts; i++) {
    const lindex = currentmodel.surfedges[fa.firstedge + i];

    let vec: Vec3;
    if (lindex > 0) {
      const r_pedge = pedges[lindex];
      vec = r_pcurrentvertbase[r_pedge.v[0]].position;
    } else {
      const r_pedge = pedges[-lindex];
      vec = r_pcurrentvertbase[r_pedge.v[1]].position;
    }
    let s = DotProduct(vec, texinfo.vecs[0]) + texinfo.vecs[0][3];
    s /= texinfo.texture.width;

    let t = DotProduct(vec, texinfo.vecs[1]) + texinfo.vecs[1][3];
    t /= texinfo.texture.height;

    VectorCopy(vec, poly.verts.subarray(i * VERTEXSIZE, i * VERTEXSIZE + 3));
    poly.verts[i * VERTEXSIZE + 3] = s;
    poly.verts[i * VERTEXSIZE + 4] = t;

    //
    // lightmap texture coordinates
    //
    s = DotProduct(vec, texinfo.vecs[0]) + texinfo.vecs[0][3];
    s -= fa.texturemins[0];
    s += fa.light_s * 16;
    s += 8;
    s /= BLOCK_WIDTH * 16; //fa->texinfo->texture->width;

    t = DotProduct(vec, texinfo.vecs[1]) + texinfo.vecs[1][3];
    t -= fa.texturemins[1];
    t += fa.light_t * 16;
    t += 8;
    t /= BLOCK_HEIGHT * 16; //fa->texinfo->texture->height;

    poly.verts[i * VERTEXSIZE + 5] = s;
    poly.verts[i * VERTEXSIZE + 6] = t;
  }

  //
  // remove co-linear points - Ed
  //
  if (!gl_keeptjunctions.value && !(fa.flags & SURF_UNDERWATER)) {
    const v1: Vec3 = vec3();
    const v2: Vec3 = vec3();
    for (let i = 0; i < lnumverts; ++i) {
      const prev = poly.verts.subarray(((i + lnumverts - 1) % lnumverts) * VERTEXSIZE, ((i + lnumverts - 1) % lnumverts) * VERTEXSIZE + 3);
      const cur = poly.verts.subarray(i * VERTEXSIZE, i * VERTEXSIZE + 3);
      const next = poly.verts.subarray(((i + 1) % lnumverts) * VERTEXSIZE, ((i + 1) % lnumverts) * VERTEXSIZE + 3);

      VectorSubtract(cur, prev, v1);
      VectorNormalize(v1);
      VectorSubtract(next, prev, v2);
      VectorNormalize(v2);

      // skip co-linear points
      const COLINEAR_EPSILON = 0.001;
      if (Math.abs(v1[0] - v2[0]) <= COLINEAR_EPSILON && Math.abs(v1[1] - v2[1]) <= COLINEAR_EPSILON && Math.abs(v1[2] - v2[2]) <= COLINEAR_EPSILON) {
        for (let j = i + 1; j < lnumverts; ++j) {
          for (let k = 0; k < VERTEXSIZE; ++k) poly.verts[(j - 1) * VERTEXSIZE + k] = poly.verts[j * VERTEXSIZE + k];
        }
        --lnumverts;
        ++glRsurfState.nColinElim;
        // retry next vertex next time, which is now current vertex
        --i;
      }
    }
  }
  poly.numverts = lnumverts;
}

/*
========================
GL_CreateSurfaceLightmap
========================
*/
export function GL_CreateSurfaceLightmap(surf: MsurfaceT): void {
  if (surf.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) return;

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;

  const pos = { x: 0, y: 0 };
  surf.lightmaptexturenum = AllocBlock(smax, tmax, pos);
  surf.light_s = pos.x;
  surf.light_t = pos.y;
  let base = surf.lightmaptexturenum * glRsurfState.lightmap_bytes * BLOCK_WIDTH * BLOCK_HEIGHT;
  base += (surf.light_t * BLOCK_WIDTH + surf.light_s) * glRsurfState.lightmap_bytes;
  R_BuildLightMap(surf, lightmaps, base, BLOCK_WIDTH * glRsurfState.lightmap_bytes);
}

/*
==================
GL_ClearLightmapState

This port's own addition, called from gl_rmisc.ts's GL_ClearTextureState
when `vid_restart` throws the GL context away. gl_rsurf.c keeps
lightmap_modified[], lightmap_rectchange[], lightmap_polys[] and allocated[]
in file-scope storage that a real GLQuake process only ever sees
zero-initialized, and GL_BuildLightmaps only rewinds the entries below the
first unallocated block -- so a map that used fewer lightmap blocks than the
one before it would leave `lightmap_modified[i]` set for blocks the new
context has never been uploaded, and R_UploadLightmap would glTexSubImage2D
into a texture id that was never given a glTexImage2D. Putting the four
arrays back to their process-start values is the fresh-process equivalent.
==================
*/
export function GL_ClearLightmapState(): void {
  allocated.fill(0);
  lightmaps.fill(0);
  for (let i = 0; i < MAX_LIGHTMAPS; i++) {
    lightmap_polys[i] = null;
    lightmap_modified[i] = false;
    lightmap_rectchange[i].l = 0;
    lightmap_rectchange[i].t = 0;
    lightmap_rectchange[i].w = 0;
    lightmap_rectchange[i].h = 0;
  }
  glRsurfState.lightmap_bytes = 0;
  glRsurfState.active_lightmaps = 0;
  glRsurfState.skychain = null;
  glRsurfState.waterchain = null;
}

/*
==================
GL_BuildLightmaps

Builds the lightmap texture
with all the surfaces from all brush models
==================
*/
export function GL_BuildLightmaps(): void {
  const gl = qgl();

  allocated.fill(0);

  glState.r_framecount = 1; // no dlightcache

  if (!glState.lightmap_textures) {
    glState.lightmap_textures = glState.texture_extension_number;
    glState.texture_extension_number += MAX_LIGHTMAPS;
  }

  glDrawState.gl_lightmap_format = GL_LUMINANCE;
  // default differently on the Permedia -- QW/client/gl_rsurf.c drops this.
  if (!qw.active && isPermedia) glDrawState.gl_lightmap_format = GL_RGBA;

  if (COM_CheckParm("-lm_1")) glDrawState.gl_lightmap_format = GL_LUMINANCE;
  if (COM_CheckParm("-lm_a")) glDrawState.gl_lightmap_format = GL_ALPHA;
  if (COM_CheckParm("-lm_i")) glDrawState.gl_lightmap_format = GL_INTENSITY;
  if (COM_CheckParm("-lm_2")) glDrawState.gl_lightmap_format = GL_RGBA4;
  if (COM_CheckParm("-lm_4")) glDrawState.gl_lightmap_format = GL_RGBA;

  switch (glDrawState.gl_lightmap_format) {
    case GL_RGBA:
      glRsurfState.lightmap_bytes = 4;
      break;
    case GL_RGBA4:
      glRsurfState.lightmap_bytes = 2;
      break;
    case GL_LUMINANCE:
    case GL_INTENSITY:
    case GL_ALPHA:
      glRsurfState.lightmap_bytes = 1;
      break;
  }

  for (let j = 1; j < MAX_MODELS; j++) {
    const m = cl.model_precache[j];
    if (!m) break;
    if (m.name[0] === "*") continue;
    glRsurfState.r_pcurrentvertbase = m.vertexes;
    glRsurfState.currentmodel = m;
    for (let i = 0; i < m.numsurfaces; i++) {
      GL_CreateSurfaceLightmap(m.surfaces[i]);
      if (m.surfaces[i].flags & SURF_DRAWTURB) continue;
      if (m.surfaces[i].flags & SURF_DRAWSKY) continue;
      BuildSurfaceDisplayList(m.surfaces[i]);
    }
  }

  if (!gl_texsort.value) GL_SelectTexture(TEXTURE1_SGIS);

  //
  // upload all lightmaps that were filled
  //
  for (let i = 0; i < MAX_LIGHTMAPS; i++) {
    if (!allocated[i * BLOCK_WIDTH]) break; // no more used
    lightmap_modified[i] = false;
    lightmap_rectchange[i].l = BLOCK_WIDTH;
    lightmap_rectchange[i].t = BLOCK_HEIGHT;
    lightmap_rectchange[i].w = 0;
    lightmap_rectchange[i].h = 0;
    GL_Bind(glState.lightmap_textures + i);
    gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    gl.qglTexImage2D(
      GL_TEXTURE_2D,
      0,
      glRsurfState.lightmap_bytes,
      BLOCK_WIDTH,
      BLOCK_HEIGHT,
      0,
      glDrawState.gl_lightmap_format,
      GL_UNSIGNED_BYTE,
      lightmaps.subarray(i * BLOCK_WIDTH * BLOCK_HEIGHT * glRsurfState.lightmap_bytes),
    );
  }

  if (!gl_texsort.value) GL_SelectTexture(TEXTURE0_SGIS);
}
