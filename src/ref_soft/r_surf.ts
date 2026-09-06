/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_surf.c (GNU GPL v2 or later).

r_surf.c: surface-related refresh code -- the lightmap builder
(R_AddDynamicLights / R_BuildLightMap), the animated-texture lookup
(R_TextureAnimation), and the surface-cache texture generator (R_DrawSurface
plus the four R_DrawSurfaceBlock8_mipN inner loops, R_DrawSurfaceBlock16, and
the turbulent/sky tile generators R_GenTurbTile / R_GenTurbTile16 / R_GenTile).

OWNERSHIP -- `drawsurf_t r_drawsurf` is defined by r_surf.c in the C, but
d_iface.h declares it and src/ref_soft/d_iface.ts already holds the singleton,
so it is imported here rather than redeclared. `blocklights` is an r_surf.c
global (gl_rsurf.c has its own copy) and is exported here. Every other global
in this file (`lightleft`, `sourcetstep`, `surfrowbytes`, `r_lightptr`,
`r_stepback`, `r_lightwidth`, `r_numhblocks`/`r_numvblocks`, `r_source`,
`r_sourcemax`, `prowdestbase`, `pbasesource`, ...) is read only by the x86 asm
(quakeasm.h externs them), so they stay module-private.

Deviations from PORTING.md / the C source:
- TEXTURE PIXEL ADDRESSING. The C reaches a mip level with
  `(byte *)mt + mt->offsets[mip]`, because model.c stores the four mip images
  immediately after the texture_t. src/common/model.ts keeps that block in
  `TextureT.data` instead, so this module reads `mt.data` with
  `mt.offsets[mip]` as a byte index INTO `data`. src/ref_soft/model.ts (U060)
  must write `offsets[]` on that basis (0 for mip 0), not as an offset past a
  header.
- `unsigned char *r_source, *r_sourcemax, *pbasesource, *psource` and
  `void *prowdestbase` are pointers walking one buffer each; they become byte
  OFFSETS (`r_source` into `r_sourceData` = the texture's mip block,
  `prowdestbase`/`prowdest` into `r_drawsurf.surfdat`), so every `+=`, `-=`
  and `>=` compares the same numbers the C compared.
- `unsigned *r_lightptr` walks `blocklights`, so it is an element index into
  that `Uint32Array`.
- `blocklights` was `Uint32Array(18*18)` in WinQuake, sized for the 256-texel
  extents cap ((256>>4)+1 = 17, rounded up to 18 for headroom). Re-release
  maps load with model.ts's MAX_SURFACE_EXTENTS (2000), so it is sized from
  that instead: `(MAX_SURFACE_EXTENTS>>4)+2` per side, the same "+2" headroom
  WinQuake's own 18 (one more than the 17 the 256 cap strictly needs) used.
  The C's `(int)blocklights[i]` unsigned-to-int conversion in R_BuildLightMap
  is written `| 0`.
- `int td = local[1] - t*16;` and `int sd = ...` truncate a float toward zero,
  so they use `Math.trunc`.
- R_DrawSurfaceBlock16 writes `unsigned short`s through a pointer cast of
  `prowdestbase`. `r_drawsurf.surfdat` is a `Uint8Array`, so the 16-bit writes
  go through a `DataView` at the same byte offsets, little-endian, which is
  what the x86 build produced. It is also carried over with its C bugs intact
  (see below).
- Preserved C bugs, both in R_DrawSurfaceBlock16 (which is marked
  "FIXME: make this work" in the original and is unreachable while
  `r_pixbytes == 1`): it advances the GLOBAL `pbasesource` instead of a local
  cursor, and it steps `psource` by `sourcesstep`, which no C function ever
  assigns -- so it stays 0 and every column reads the same texel.
- `R_GenSkyTile` is r_sky.c's (U066) and the `r_fullbright` cvar is
  r_main.c's (U062); both are imported by name. src/ref_soft/r_sky.ts DROPPED
  `R_GenSkyTile16` as unreachable (v1.09 assigns `r_pixbytes` only the value
  1, in r_main.c's initializer and d_init.c), so R_GenTile's `r_pixbytes != 1`
  sky branch -- the one call site -- raises Sys_Error instead of calling it.
  The branch cannot be reached for the same reason r_sky.ts gives.
- Dropped `#ifdef QUAKE2` branch in R_AddDynamicLights: the `cl_dlights[].dark`
  subtractive-light variant, per PORTING.md.
- Dropped `#if id386` alternates: R_DrawSurfaceBlock8_mip0..3 and
  R_DrawSurfaceBlock16 have asm versions; the `!id386` C bodies are ported.

U25 COLORED LIGHTING (this port's own addition; no C original -- see
src/ref_soft/r_coloredlight.ts's header for the design). When
`rState.r_truecolor` is set for the frame, R_DrawSurface builds the lightmap
into `blocklights_rgb` (three channels per texel, from the world model's
`lightdata_rgb`) instead of `blocklights` and generates the surface cache
block through R_DrawSurfaceBlock32, which writes 32-bit ARGB texels into
`r_drawsurf.surfdat32` instead of palette indices into `r_drawsurf.surfdat`.
Each channel walks the SAME colormap the 8-bit drawers walk, with that
channel's own light value, so an equal-channel lightmap produces exactly the
8-bit result expanded through `d_8to24table`. R_DrawSurfaceBlock32 is one
function rather than four mip twins because it reads `blocksize` and
`blockdivshift` the way R_DrawSurfaceBlock16 does; the four 8-bit
R_DrawSurfaceBlock8_mipN bodies are untouched.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/r_surf.c against WinQuake/r_surf.c): the diff is a
comment-out of the `r_fullbright.value ||` half of R_BuildLightMap's guard
(the removed `#ifdef QUAKE2` block above is the same dropped-both-trees
no-op noted above, not a QW delta) -- folded at the guard in R_BuildLightMap.
*/

import { DotProduct, type Vec3, vec3 } from "../common/mathlib";
import { MAXLIGHTMAPS } from "../common/bspfile";
import { MAX_SURFACE_EXTENTS, SURF_DRAWSKY, SURF_DRAWTURB, mipDim, type MsurfaceT, type TextureT } from "../common/model";
import { MAX_DLIGHTS, cl, cl_dlights } from "../client/client";
import { VID_CBITS, d_8to16table, d_8to24table, vid } from "../client/vid";
import { Sys_Error } from "../platform/sys";
import { CYCLE, TILE_SIZE, r_drawsurf } from "./d_iface";
import { SPEED, r_refdef, rState, sintable } from "./r_local";
import { r_fullbright } from "./r_main";
import { qw } from "../common/quakedef";
import { R_GenSkyTile } from "./r_sky";

export { r_drawsurf };

let lightleft = 0;
let sourcesstep = 0;
let blocksize = 0;
let sourcetstep = 0;
// `lightdelta`/`lightdeltastep` are written and read only by the x86 block
// drawers (quakeasm.h externs them); `sourcesstep` likewise, which is why the
// C's R_DrawSurfaceBlock16 always steps by 0.
let lightdelta = 0;
let lightdeltastep = 0;
let lightright = 0;
let lightleftstep = 0;
let lightrightstep = 0;
let blockdivshift = 0;
let blockdivmask = 0;
let prowdestbase = 0;
let pbasesource = 0;
let surfrowbytes = 0; // used by ASM files
let r_lightptr = 0;
let r_stepback = 0;
let r_lightwidth = 0;
let r_numhblocks = 0;
let r_numvblocks = 0;
let r_sourceData: Uint8Array = new Uint8Array(0);
let r_source = 0;
let r_sourcemax = 0;

const surfmiptable: Array<() => void> = [
  R_DrawSurfaceBlock8_mip0,
  R_DrawSurfaceBlock8_mip1,
  R_DrawSurfaceBlock8_mip2,
  R_DrawSurfaceBlock8_mip3,
];

// see the header note above: sized from MAX_SURFACE_EXTENTS instead of the
// WinQuake-fixed 18*18, which only covered a 256-texel extents cap.
const LM_BLOCK = (MAX_SURFACE_EXTENTS >> 4) + 2;
export const blocklights: Uint32Array = new Uint32Array(LM_BLOCK * LM_BLOCK);

// U25: the same lightmap, three channels per texel, interleaved r,g,b. Only
// R_BuildLightMapRGB and R_DrawSurfaceBlock32 touch it, and only while
// rState.r_truecolor is set.
export const blocklights_rgb: Uint32Array = new Uint32Array(LM_BLOCK * LM_BLOCK * 3);

function drawsurfDest32(): Uint32Array {
  const d = r_drawsurf.surfdat32;
  if (d === null) Sys_Error("R_DrawSurface: no 32-bit destination surface");
  return d;
}

function drawsurfDest(): Uint8Array {
  const d = r_drawsurf.surfdat;
  if (d === null) Sys_Error("R_DrawSurface: no destination surface");
  return d;
}

function drawColormap(): Uint8Array {
  const c = vid.colormap;
  if (c === null) Sys_Error("R_DrawSurface: no colormap");
  return c;
}

/*
===============
R_AddDynamicLights
===============
*/
export function R_AddDynamicLights(): void {
  const impact: Vec3 = vec3();
  const local: Vec3 = vec3();

  const surf = r_drawsurf.surf;
  if (surf === null) Sys_Error("R_AddDynamicLights: no surface");
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const tex = surf.texinfo;
  if (tex === null) Sys_Error("R_AddDynamicLights: surface has no texinfo");
  const plane = surf.plane;
  if (plane === null) Sys_Error("R_AddDynamicLights: surface has no plane");

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
      let td = Math.trunc(local[1] - t * 16);
      if (td < 0) td = -td;
      for (let s = 0; s < smax; s++) {
        let sd = Math.trunc(local[0] - s * 16);
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
export function R_BuildLightMap(): void {
  const surf = r_drawsurf.surf;
  if (surf === null) Sys_Error("R_BuildLightMap: no surface");

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const size = smax * tmax;
  const lightmap = surf.samples;
  let lightmapofs = 0;

  const worldmodel = cl.worldmodel;
  // QW r_surf.c comments out the `r_fullbright.value ||` half of this guard:
  // under qw.active the lightmap always rebuilds from lightdata (or clears
  // to black if there is none), regardless of r_fullbright.
  if ((!qw.active && r_fullbright.value) || worldmodel === null || worldmodel.lightdata === null) {
    for (let i = 0; i < size; i++) blocklights[i] = 0;
    return;
  }

  // clear to ambient
  for (let i = 0; i < size; i++) blocklights[i] = r_refdef.ambientlight << 8;

  // add all the lightmaps
  if (lightmap !== null) {
    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const scale = r_drawsurf.lightadj[maps]; // 8.8 fraction
      for (let i = 0; i < size; i++) blocklights[i] += lightmap[lightmapofs + i] * scale;
      lightmapofs += size; // skip to next lightmap
    }
  }

  // add all the dynamic lights
  if (surf.dlightframe === rState.r_framecount) R_AddDynamicLights();

  // bound, invert, and shift
  for (let i = 0; i < size; i++) {
    let t = (255 * 256 - (blocklights[i] | 0)) >> (8 - VID_CBITS);

    if (t < 1 << 6) t = 1 << 6;

    blocklights[i] = t;
  }
}

/*
===============
R_AddDynamicLightsRGB

R_AddDynamicLights against the three-channel blocklights. A dlight is white
in Quake 1 (cl_dlights carries no color), so the same add lands in all three
channels; the loop is otherwise line-for-line the 8-bit one above.
===============
*/
export function R_AddDynamicLightsRGB(): void {
  const impact: Vec3 = vec3();
  const local: Vec3 = vec3();

  const surf = r_drawsurf.surf;
  if (surf === null) Sys_Error("R_AddDynamicLightsRGB: no surface");
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const tex = surf.texinfo;
  if (tex === null) Sys_Error("R_AddDynamicLightsRGB: surface has no texinfo");
  const plane = surf.plane;
  if (plane === null) Sys_Error("R_AddDynamicLightsRGB: surface has no plane");

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
      let td = Math.trunc(local[1] - t * 16);
      if (td < 0) td = -td;
      for (let s = 0; s < smax; s++) {
        let sd = Math.trunc(local[0] - s * 16);
        if (sd < 0) sd = -sd;
        if (sd > td) dist = sd + (td >> 1);
        else dist = td + (sd >> 1);
        if (dist < minlight) {
          const add = (rad - dist) * 256;
          const i3 = (t * smax + s) * 3;
          blocklights_rgb[i3] += add;
          blocklights_rgb[i3 + 1] += add;
          blocklights_rgb[i3 + 2] += add;
        }
      }
    }
  }
}

/*
===============
R_BuildLightMapRGB

R_BuildLightMap against the three-channel blocklights, reading the world
model's `lightdata_rgb` (3 bytes per sample at `lightofs * 3`, the layout
src/ref_gl/gl_rsurf.ts's R_BuildLightMap already reads) instead of the
greyscale `surf.samples`. Every guard, every scale and the closing bound/
invert/shift are the 8-bit function's, applied per channel, so a surface
whose three channels carry the same value comes out of the block drawer as
the 8-bit pixel expanded through the palette.
===============
*/
export function R_BuildLightMapRGB(): void {
  const surf = r_drawsurf.surf;
  if (surf === null) Sys_Error("R_BuildLightMapRGB: no surface");

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const size = smax * tmax;
  const lightmap = surf.samples;
  let lightmapofs = 0;

  const worldmodel = cl.worldmodel;
  if ((!qw.active && r_fullbright.value) || worldmodel === null || worldmodel.lightdata === null) {
    for (let i = 0; i < size * 3; i++) blocklights_rgb[i] = 0;
    return;
  }

  // clear to ambient
  const ambient = r_refdef.ambientlight << 8;
  for (let i = 0; i < size * 3; i++) blocklights_rgb[i] = ambient;

  const rgbLightdata = worldmodel.lightdata_rgb;
  const rgbSamples = rgbLightdata !== null && surf.lightofs !== -1 ? rgbLightdata.subarray(surf.lightofs * 3) : null;

  // add all the lightmaps
  if (lightmap !== null) {
    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const scale = r_drawsurf.lightadj[maps]; // 8.8 fraction
      if (rgbSamples !== null) {
        for (let i = 0; i < size; i++) {
          const s3 = (lightmapofs + i) * 3;
          const i3 = i * 3;
          blocklights_rgb[i3] += rgbSamples[s3] * scale;
          blocklights_rgb[i3 + 1] += rgbSamples[s3 + 1] * scale;
          blocklights_rgb[i3 + 2] += rgbSamples[s3 + 2] * scale;
        }
      } else {
        for (let i = 0; i < size; i++) {
          const v = lightmap[lightmapofs + i] * scale;
          const i3 = i * 3;
          blocklights_rgb[i3] += v;
          blocklights_rgb[i3 + 1] += v;
          blocklights_rgb[i3 + 2] += v;
        }
      }
      lightmapofs += size; // skip to next lightmap
    }
  }

  // add all the dynamic lights
  if (surf.dlightframe === rState.r_framecount) R_AddDynamicLightsRGB();

  // bound, invert, and shift
  for (let i = 0; i < size * 3; i++) {
    let t = (255 * 256 - (blocklights_rgb[i] | 0)) >> (8 - VID_CBITS);

    if (t < 1 << 6) t = 1 << 6;

    blocklights_rgb[i] = t;
  }
}

/*
===============
R_TextureAnimation

Returns the proper texture for a given time and base texture
===============
*/
export function R_TextureAnimation(baseIn: TextureT): TextureT {
  let base = baseIn;
  const currententity = rState.currententity;
  if (currententity === null) Sys_Error("R_TextureAnimation: no currententity");

  if (currententity.frame) {
    if (base.alternate_anims !== null) base = base.alternate_anims;
  }

  if (!base.anim_total) return base;

  const reletive = Math.trunc(cl.time * 10) % base.anim_total;

  let count = 0;
  while (base.anim_min > reletive || base.anim_max <= reletive) {
    const next = base.anim_next;
    if (next === null) Sys_Error("R_TextureAnimation: broken cycle");
    base = next;
    if (++count > 100) Sys_Error("R_TextureAnimation: infinite cycle");
  }

  return base;
}

/*
===============
R_DrawSurface
===============
*/
export function R_DrawSurface(): void {
  // calculate the lightings
  if (rState.r_truecolor) R_BuildLightMapRGB();
  else R_BuildLightMap();

  surfrowbytes = r_drawsurf.rowbytes;

  const mt = r_drawsurf.texture;
  if (mt === null) Sys_Error("R_DrawSurface: no texture");
  const surf = r_drawsurf.surf;
  if (surf === null) Sys_Error("R_DrawSurface: no surface");

  r_sourceData = mt.data;
  r_source = mt.offsets[r_drawsurf.surfmip];

  // the fractional light values should range from 0 to (VID_GRADES - 1) << 16
  // from a source range of 0 - 255

  // mipDim, not a plain shift: model.ts's Mod_LoadTextures generates each mip
  // level's own pixel data with a floor-and-minimum-1 rounding (a re-release
  // texture need not be 16-aligned, or even large enough that every mip
  // level's dimension stays nonzero under a plain `>> level`), so reading it
  // back has to divide the same way or drift off the real data -- see this
  // file's header for the offsets-into-`data` addressing this reads through.
  const texwidth = mipDim(mt.width, r_drawsurf.surfmip);

  blocksize = 16 >> r_drawsurf.surfmip;
  blockdivshift = 4 - r_drawsurf.surfmip;
  blockdivmask = (1 << blockdivshift) - 1;

  r_lightwidth = (surf.extents[0] >> 4) + 1;

  r_numhblocks = r_drawsurf.surfwidth >> blockdivshift;
  r_numvblocks = r_drawsurf.surfheight >> blockdivshift;

  //==============================

  let pblockdrawer: () => void;
  let horzblockstep: number;
  if (rState.r_truecolor) {
    // U25: one 32-bit texel per destination element, so the horizontal step
    // is the block size, exactly as in the 8-bit case
    pblockdrawer = R_DrawSurfaceBlock32;
    horzblockstep = blocksize;
  } else if (rState.r_pixbytes === 1) {
    pblockdrawer = surfmiptable[r_drawsurf.surfmip];
    // TODO: only needs to be set when there is a display settings change
    horzblockstep = blocksize;
  } else {
    pblockdrawer = R_DrawSurfaceBlock16;
    // TODO: only needs to be set when there is a display settings change
    horzblockstep = blocksize << 1;
  }

  const smax = texwidth;
  const twidth = texwidth;
  const tmax = mipDim(mt.height, r_drawsurf.surfmip);
  sourcetstep = texwidth;
  r_stepback = tmax * twidth;

  r_sourcemax = r_source + tmax * smax;

  let soffset = surf.texturemins[0];
  const basetoffset = surf.texturemins[1];

  // << 16 components are to guarantee positive values for %
  soffset = ((soffset >> r_drawsurf.surfmip) + (smax << 16)) % smax;
  const basetptr = r_source + (((basetoffset >> r_drawsurf.surfmip) + (tmax << 16)) % tmax) * twidth;

  let pcolumndest = 0;

  for (let u = 0; u < r_numhblocks; u++) {
    r_lightptr = u;

    prowdestbase = pcolumndest;

    pbasesource = basetptr + soffset;

    pblockdrawer();

    soffset = soffset + blocksize;
    if (soffset >= smax) soffset = 0;

    pcolumndest += horzblockstep;
  }
}

//=============================================================================

/*
================
R_DrawSurfaceBlock8_mip0
================
*/
export function R_DrawSurfaceBlock8_mip0(): void {
  const colormap = drawColormap();
  const dest = drawsurfDest();

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    // FIXME: make these locals?
    // FIXME: use delta rather than both right and left, like ASM?
    lightleft = blocklights[r_lightptr];
    lightright = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    lightleftstep = (blocklights[r_lightptr] - lightleft) >> 4;
    lightrightstep = (blocklights[r_lightptr + 1] - lightright) >> 4;

    for (let i = 0; i < 16; i++) {
      const lighttemp = lightleft - lightright;
      const lightstep = lighttemp >> 4;

      let light = lightright;

      for (let b = 15; b >= 0; b--) {
        const pix = r_sourceData[psource + b];
        dest[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightright += lightrightstep;
      lightleft += lightleftstep;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock8_mip1
================
*/
export function R_DrawSurfaceBlock8_mip1(): void {
  const colormap = drawColormap();
  const dest = drawsurfDest();

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    // FIXME: make these locals?
    // FIXME: use delta rather than both right and left, like ASM?
    lightleft = blocklights[r_lightptr];
    lightright = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    lightleftstep = (blocklights[r_lightptr] - lightleft) >> 3;
    lightrightstep = (blocklights[r_lightptr + 1] - lightright) >> 3;

    for (let i = 0; i < 8; i++) {
      const lighttemp = lightleft - lightright;
      const lightstep = lighttemp >> 3;

      let light = lightright;

      for (let b = 7; b >= 0; b--) {
        const pix = r_sourceData[psource + b];
        dest[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightright += lightrightstep;
      lightleft += lightleftstep;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock8_mip2
================
*/
export function R_DrawSurfaceBlock8_mip2(): void {
  const colormap = drawColormap();
  const dest = drawsurfDest();

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    // FIXME: make these locals?
    // FIXME: use delta rather than both right and left, like ASM?
    lightleft = blocklights[r_lightptr];
    lightright = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    lightleftstep = (blocklights[r_lightptr] - lightleft) >> 2;
    lightrightstep = (blocklights[r_lightptr + 1] - lightright) >> 2;

    for (let i = 0; i < 4; i++) {
      const lighttemp = lightleft - lightright;
      const lightstep = lighttemp >> 2;

      let light = lightright;

      for (let b = 3; b >= 0; b--) {
        const pix = r_sourceData[psource + b];
        dest[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightright += lightrightstep;
      lightleft += lightleftstep;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock8_mip3
================
*/
export function R_DrawSurfaceBlock8_mip3(): void {
  const colormap = drawColormap();
  const dest = drawsurfDest();

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    // FIXME: make these locals?
    // FIXME: use delta rather than both right and left, like ASM?
    lightleft = blocklights[r_lightptr];
    lightright = blocklights[r_lightptr + 1];
    r_lightptr += r_lightwidth;
    lightleftstep = (blocklights[r_lightptr] - lightleft) >> 1;
    lightrightstep = (blocklights[r_lightptr + 1] - lightright) >> 1;

    for (let i = 0; i < 2; i++) {
      const lighttemp = lightleft - lightright;
      const lightstep = lighttemp >> 1;

      let light = lightright;

      for (let b = 1; b >= 0; b--) {
        const pix = r_sourceData[psource + b];
        dest[prowdest + b] = colormap[(light & 0xff00) + pix];
        light += lightstep;
      }

      psource += sourcetstep;
      lightright += lightrightstep;
      lightleft += lightleftstep;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock32

U25's true-color block drawer. Structurally R_DrawSurfaceBlock8_mip0 with
`blocksize`/`blockdivshift` in place of the hardcoded 16 and 4 (so one body
covers all four mip levels, the way R_DrawSurfaceBlock16 does), and with the
one colormap lookup replaced by three -- one per channel, each with that
channel's own interpolated light value, each contributing one byte of the
palette color. Three equal channel lights therefore hit the same colormap
entry three times and reproduce `d_8to24table[colormap[(light & 0xff00) +
pix]]` exactly.
================
*/
export function R_DrawSurfaceBlock32(): void {
  const colormap = drawColormap();
  const dest = drawsurfDest32();
  const size = blocksize;
  const shift = blockdivshift;

  let psource = pbasesource;
  let prowdest = prowdestbase;

  for (let v = 0; v < r_numvblocks; v++) {
    let p3 = r_lightptr * 3;
    let rleft = blocklights_rgb[p3];
    let gleft = blocklights_rgb[p3 + 1];
    let bleft = blocklights_rgb[p3 + 2];
    let rright = blocklights_rgb[p3 + 3];
    let gright = blocklights_rgb[p3 + 4];
    let bright = blocklights_rgb[p3 + 5];
    r_lightptr += r_lightwidth;
    p3 = r_lightptr * 3;
    const rleftstep = (blocklights_rgb[p3] - rleft) >> shift;
    const gleftstep = (blocklights_rgb[p3 + 1] - gleft) >> shift;
    const bleftstep = (blocklights_rgb[p3 + 2] - bleft) >> shift;
    const rrightstep = (blocklights_rgb[p3 + 3] - rright) >> shift;
    const grightstep = (blocklights_rgb[p3 + 4] - gright) >> shift;
    const brightstep = (blocklights_rgb[p3 + 5] - bright) >> shift;

    for (let i = 0; i < size; i++) {
      const rstep = (rleft - rright) >> shift;
      const gstep = (gleft - gright) >> shift;
      const bstep = (bleft - bright) >> shift;

      let rlight = rright;
      let glight = gright;
      let blight = bright;

      for (let b = size - 1; b >= 0; b--) {
        const pix = r_sourceData[psource + b];
        const cr = d_8to24table[colormap[(rlight & 0xff00) + pix]] & 0xff;
        const cg = d_8to24table[colormap[(glight & 0xff00) + pix]] & 0xff00;
        const cb = d_8to24table[colormap[(blight & 0xff00) + pix]] & 0xff0000;
        dest[prowdest + b] = (0xff000000 | cb | cg | cr) >>> 0;
        rlight += rstep;
        glight += gstep;
        blight += bstep;
      }

      psource += sourcetstep;
      rright += rrightstep;
      gright += grightstep;
      bright += brightstep;
      rleft += rleftstep;
      gleft += gleftstep;
      bleft += bleftstep;
      prowdest += surfrowbytes;
    }

    if (psource >= r_sourcemax) psource -= r_stepback;
  }
}

/*
================
R_DrawSurfaceBlock16

FIXME: make this work
================
*/
export function R_DrawSurfaceBlock16(): void {
  const colormap16 = vid.colormap16;
  if (colormap16 === null) Sys_Error("R_DrawSurfaceBlock16: no 16-bit colormap");
  const dest = drawsurfDest();
  const destView = new DataView(dest.buffer, dest.byteOffset, dest.byteLength);

  let prowdest = prowdestbase;

  for (let k = 0; k < blocksize; k++) {
    let psource = pbasesource;
    const lighttemp = lightright - lightleft;
    const lightstep = lighttemp >> blockdivshift;

    let light = lightleft;
    let pdest = prowdest;

    for (let b = 0; b < blocksize; b++) {
      const pix = r_sourceData[psource];
      destView.setUint16(pdest, colormap16[(light & 0xff00) + pix], true);
      psource += sourcesstep;
      pdest += 2;
      light += lightstep;
    }

    pbasesource += sourcetstep;
    lightright += lightrightstep;
    lightleft += lightleftstep;
    prowdest = prowdest + surfrowbytes;
  }

  prowdestbase = prowdest;
}

//============================================================================

/*
================
R_GenTurbTile
================
*/
export function R_GenTurbTile(pbasetex: Uint8Array, pdest: Uint8Array): void {
  const turb = Math.trunc(cl.time * SPEED) & (CYCLE - 1);
  let pd = 0;

  for (let i = 0; i < TILE_SIZE; i++) {
    for (let j = 0; j < TILE_SIZE; j++) {
      const s = (((j << 16) + sintable[turb + (i & (CYCLE - 1))]) >> 16) & 63;
      const t = (((i << 16) + sintable[turb + (j & (CYCLE - 1))]) >> 16) & 63;
      pdest[pd++] = pbasetex[(t << 6) + s];
    }
  }
}

/*
================
R_GenTurbTile16
================
*/
export function R_GenTurbTile16(pbasetex: Uint8Array, pdest: Uint8Array): void {
  const turb = Math.trunc(cl.time * SPEED) & (CYCLE - 1);
  const pdestView = new DataView(pdest.buffer, pdest.byteOffset, pdest.byteLength);
  let pd = 0;

  for (let i = 0; i < TILE_SIZE; i++) {
    for (let j = 0; j < TILE_SIZE; j++) {
      const s = (((j << 16) + sintable[turb + (i & (CYCLE - 1))]) >> 16) & 63;
      const t = (((i << 16) + sintable[turb + (j & (CYCLE - 1))]) >> 16) & 63;
      pdestView.setUint16(pd, d_8to16table[pbasetex[(t << 6) + s]], true);
      pd += 2;
    }
  }
}

/*
================
R_GenTile
================
*/
export function R_GenTile(psurf: MsurfaceT, pdest: Uint8Array): void {
  if (psurf.flags & SURF_DRAWTURB) {
    const texinfo = psurf.texinfo;
    if (texinfo === null) Sys_Error("R_GenTile: surface has no texinfo");
    const texture = texinfo.texture;
    if (texture === null) Sys_Error("R_GenTile: texinfo has no texture");
    const pbasetex = texture.data.subarray(texture.offsets[0]);

    if (rState.r_pixbytes === 1) {
      R_GenTurbTile(pbasetex, pdest);
    } else {
      R_GenTurbTile16(pbasetex, pdest);
    }
  } else if (psurf.flags & SURF_DRAWSKY) {
    if (rState.r_pixbytes === 1) {
      R_GenSkyTile(pdest);
    } else {
      Sys_Error("R_GenTile: R_GenSkyTile16 is not built");
    }
  } else {
    Sys_Error("Unknown tile type");
  }
}
