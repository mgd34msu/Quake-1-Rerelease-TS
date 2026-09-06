/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_edge.c (GNU GPL v2 or later).

// d_edge.c

Deviations from PORTING.md / the C source:
- `byte *pdest = (byte *)d_viewbuffer + screenwidth*span->v` becomes that sum
  used as a byte index into `rState.d_viewbuffer`. D_DrawSolidSurface's
  `*(int *)((byte *)pdest + u) = pix` writes four copies of the same color
  byte (`pix = (color<<24)|(color<<16)|(color<<8)|color`), so the dword store
  becomes four byte stores over the same four indexes and the bytes written
  are identical; the surrounding alignment loops are kept as they are.
- `surf_t *s` walks `&surfaces[1] .. surface_p`; r_shared.ts makes `surfaces`
  an array and `surface_p` an INDEX into it, so the walk is `for (let i = 1;
  i < rState.surface_p; i++)`.
- `D_DrawSolidSurface (s, (int)s->data & 0xFF)` under `r_drawflat` takes the
  low byte of the msurface_t POINTER as an arbitrary per-surface color. There
  is no pointer value in TS, so the SurfT pool index (`s->index`, the C's
  `surf - surfaces`) supplies that arbitrary constant instead. r_drawflat is a
  debug cvar and the exact color it picks is not part of the rendering.
- `cacheblock = (pixel_t *)((byte *)pface->texinfo->texture +
  pface->texinfo->texture->offsets[0])` reaches the mip pixels stored after
  the texture_t. src/common/model.ts stores that block in `TextureT.data` and
  keeps `offsets[]` as byte indexes INTO it (src/ref_soft/model.ts writes them
  that way and r_surf.ts reads them that way), so this becomes
  `texture.data.subarray(texture.offsets[0])`.
- `D_CalcGradients`'s unused `mplane_t *pplane = pface->plane;` is a dead
  local in the C and is not carried over.
- `sadjust`/`tadjust` end in a float expression (`+ pface->texinfo->
  vecs[0][3]*t`) assigned to a `fixed16_t`; the assignment truncates toward
  zero, which is what the trailing `| 0` does. The inner
  `(fixed16_t)(DotProduct(...) * 0x10000 + 0.5)` truncates the same way.
- `d_drawspans` is d_init.c's function pointer and is reached through
  d_init.ts's `drawspansState` holder, since an imported ESM binding is
  read-only to the importer.
- `miplevel` is d_edge.c's file-scope static; `scale_for_mip`, `screenwidth`,
  `ubasestep`, `errorterm`, `erroradjustup`, `erroradjustdown` and
  `vstartscan` are its globals and live on `rState`. `transformed_modelorg` is
  mutated in place, so it is an exported `vec3()`.
- Dropped: nothing. d_edge.c has no #ifdef branches (`R_RotateBmodel` and
  `R_TransformFrustum` keep their "FIXME: should go away" extern comment in
  the C; here they are ordinary imports).
*/

import { Sys_Error } from "../platform/sys";
import { DotProduct, VectorCopy, VectorScale, VectorSubtract, vec3 } from "../common/mathlib";
import { SURF_DRAWBACKGROUND, SURF_DRAWSKY, SURF_DRAWTURB } from "../common/model";
import type { MsurfaceT } from "../common/model";
import { cl_entities } from "../client/client";
import { d_scalemip } from "./d_local";
import { D_CacheSurface } from "./d_surf";
import { D_DrawZSpans, Turbulent8 } from "./d_scan";
import { D_DrawSkyScans8 } from "./d_sky";
import { drawspansState } from "./d_init";
import { R_MakeSky } from "./r_sky";
import { R_RotateBmodel } from "./r_bsp";
import { R_TransformFrustum, TransformVector } from "./r_misc";
import { r_clearcolor, r_drawflat } from "./r_main";
import {
  type SurfT,
  base_modelorg,
  base_vpn,
  base_vright,
  base_vup,
  modelorg,
  r_origin,
  rState,
  vpn,
  vright,
  vup,
} from "./r_shared";

let miplevel = 0;

// FIXME: should go away
export const transformed_modelorg = vec3();

/*
==============
D_DrawPoly

==============
*/
export function D_DrawPoly(): void {
  // this driver takes spans, not polygons
}

/*
=============
D_MipLevelForScale
=============
*/
export function D_MipLevelForScale(scale: number): number {
  let lmiplevel: number;

  if (scale >= d_scalemip[0]) lmiplevel = 0;
  else if (scale >= d_scalemip[1]) lmiplevel = 1;
  else if (scale >= d_scalemip[2]) lmiplevel = 2;
  else lmiplevel = 3;

  if (lmiplevel < rState.d_minmip) lmiplevel = rState.d_minmip;

  return lmiplevel;
}

/*
==============
D_DrawSolidSurface
==============
*/

// FIXME: clean this up

export function D_DrawSolidSurface(surf: SurfT, color: number): void {
  const d_viewbuffer = rState.d_viewbuffer;
  if (d_viewbuffer === null) Sys_Error("D_DrawSolidSurface: NULL d_viewbuffer");

  const screenwidth = rState.screenwidth;
  const pix = color & 0xff;

  for (let span = surf.spans; span; span = span.pnext) {
    const pdest = screenwidth * span.v;
    let u = span.u;
    let u2 = span.u + span.count - 1;
    d_viewbuffer[pdest + u] = pix;

    if (u2 - u < 8) {
      for (u++; u <= u2; u++) d_viewbuffer[pdest + u] = pix;
    } else {
      for (u++; u & 3; u++) d_viewbuffer[pdest + u] = pix;

      u2 -= 4;
      for (; u <= u2; u += 4) {
        d_viewbuffer[pdest + u + 0] = pix;
        d_viewbuffer[pdest + u + 1] = pix;
        d_viewbuffer[pdest + u + 2] = pix;
        d_viewbuffer[pdest + u + 3] = pix;
      }
      u2 += 4;
      for (; u <= u2; u++) d_viewbuffer[pdest + u] = pix;
    }
  }
}

const p_temp1 = vec3();
const p_saxis = vec3();
const p_taxis = vec3();

/*
==============
D_CalcGradients
==============
*/
export function D_CalcGradients(pface: MsurfaceT): void {
  const texinfo = pface.texinfo;
  if (texinfo === null) Sys_Error("D_CalcGradients: NULL texinfo");

  let t: number;

  const mipscale = 1.0 / (1 << miplevel);

  TransformVector(texinfo.vecs[0], p_saxis);
  TransformVector(texinfo.vecs[1], p_taxis);

  t = rState.xscaleinv * mipscale;
  rState.d_sdivzstepu = p_saxis[0] * t;
  rState.d_tdivzstepu = p_taxis[0] * t;

  t = rState.yscaleinv * mipscale;
  rState.d_sdivzstepv = -p_saxis[1] * t;
  rState.d_tdivzstepv = -p_taxis[1] * t;

  rState.d_sdivzorigin = p_saxis[2] * mipscale - rState.xcenter * rState.d_sdivzstepu - rState.ycenter * rState.d_sdivzstepv;
  rState.d_tdivzorigin = p_taxis[2] * mipscale - rState.xcenter * rState.d_tdivzstepu - rState.ycenter * rState.d_tdivzstepv;

  VectorScale(transformed_modelorg, mipscale, p_temp1);

  t = 0x10000 * mipscale;
  rState.sadjust =
    (((DotProduct(p_temp1, p_saxis) * 0x10000 + 0.5) | 0) -
      ((pface.texturemins[0] << 16) >> miplevel) +
      texinfo.vecs[0][3] * t) |
    0;
  rState.tadjust =
    (((DotProduct(p_temp1, p_taxis) * 0x10000 + 0.5) | 0) -
      ((pface.texturemins[1] << 16) >> miplevel) +
      texinfo.vecs[1][3] * t) |
    0;

  //
  // -1 (-epsilon) so we never wander off the edge of the texture
  //
  rState.bbextents = (((pface.extents[0] << 16) >> miplevel) - 1) | 0;
  rState.bbextentt = (((pface.extents[1] << 16) >> miplevel) - 1) | 0;
}

const world_transformed_modelorg = vec3();
const local_modelorg = vec3();

/*
==============
D_DrawSurfaces
==============
*/
export function D_DrawSurfaces(): void {
  const surfaces = rState.surfaces;
  if (surfaces === null) Sys_Error("D_DrawSurfaces: NULL surfaces");

  rState.currententity = cl_entities[0];
  TransformVector(modelorg, transformed_modelorg);
  VectorCopy(transformed_modelorg, world_transformed_modelorg);

  // TODO: could preset a lot of this at mode set time
  if (r_drawflat.value) {
    for (let i = 1; i < rState.surface_p; i++) {
      const s = surfaces[i];
      if (!s.spans) continue;

      rState.d_zistepu = s.d_zistepu;
      rState.d_zistepv = s.d_zistepv;
      rState.d_ziorigin = s.d_ziorigin;

      D_DrawSolidSurface(s, s.index & 0xff);
      D_DrawZSpans(s.spans);
    }
  } else {
    for (let i = 1; i < rState.surface_p; i++) {
      const s = surfaces[i];
      if (!s.spans) continue;

      rState.r_drawnpolycount++;

      rState.d_zistepu = s.d_zistepu;
      rState.d_zistepv = s.d_zistepv;
      rState.d_ziorigin = s.d_ziorigin;

      if (s.flags & SURF_DRAWSKY) {
        if (!rState.r_skymade) {
          R_MakeSky();
        }

        D_DrawSkyScans8(s.spans);
        D_DrawZSpans(s.spans);
      } else if (s.flags & SURF_DRAWBACKGROUND) {
        // set up a gradient for the background surface that places it
        // effectively at infinity distance from the viewpoint
        rState.d_zistepu = 0;
        rState.d_zistepv = 0;
        rState.d_ziorigin = -0.9;

        D_DrawSolidSurface(s, r_clearcolor.value & 0xff);
        D_DrawZSpans(s.spans);
      } else if (s.flags & SURF_DRAWTURB) {
        const pface = s.data;
        if (pface === null) Sys_Error("D_DrawSurfaces: NULL surf data");
        const texinfo = pface.texinfo;
        if (texinfo === null) Sys_Error("D_DrawSurfaces: NULL texinfo");
        const texture = texinfo.texture;
        if (texture === null) Sys_Error("D_DrawSurfaces: NULL texture");

        miplevel = 0;
        rState.cacheblock = texture.data.subarray(texture.offsets[0]);
        rState.cachewidth = 64;

        if (s.insubmodel) {
          // FIXME: we don't want to do all this for every polygon!
          // TODO: store once at start of frame
          const entity = s.entity;
          if (entity === null) Sys_Error("D_DrawSurfaces: NULL surf entity");
          rState.currententity = entity; //FIXME: make this passed in to
          // R_RotateBmodel ()
          VectorSubtract(r_origin, entity.origin, local_modelorg);
          TransformVector(local_modelorg, transformed_modelorg);

          R_RotateBmodel(); // FIXME: don't mess with the frustum,
          // make entity passed in
        }

        D_CalcGradients(pface);
        Turbulent8(s.spans);
        D_DrawZSpans(s.spans);

        if (s.insubmodel) {
          //
          // restore the old drawing state
          // FIXME: we don't want to do this every time!
          // TODO: speed up
          //
          rState.currententity = cl_entities[0];
          VectorCopy(world_transformed_modelorg, transformed_modelorg);
          VectorCopy(base_vpn, vpn);
          VectorCopy(base_vup, vup);
          VectorCopy(base_vright, vright);
          VectorCopy(base_modelorg, modelorg);
          R_TransformFrustum();
        }
      } else {
        if (s.insubmodel) {
          // FIXME: we don't want to do all this for every polygon!
          // TODO: store once at start of frame
          const entity = s.entity;
          if (entity === null) Sys_Error("D_DrawSurfaces: NULL surf entity");
          rState.currententity = entity; //FIXME: make this passed in to
          // R_RotateBmodel ()
          VectorSubtract(r_origin, entity.origin, local_modelorg);
          TransformVector(local_modelorg, transformed_modelorg);

          R_RotateBmodel(); // FIXME: don't mess with the frustum,
          // make entity passed in
        }

        const pface = s.data;
        if (pface === null) Sys_Error("D_DrawSurfaces: NULL surf data");
        const texinfo = pface.texinfo;
        if (texinfo === null) Sys_Error("D_DrawSurfaces: NULL texinfo");

        miplevel = D_MipLevelForScale(s.nearzi * rState.scale_for_mip * texinfo.mipadjust);

        // FIXME: make this passed in to D_CacheSurface
        const pcurrentcache = D_CacheSurface(pface, miplevel);

        rState.cacheblock = pcurrentcache.data;
        rState.cachewidth = pcurrentcache.width;

        D_CalcGradients(pface);

        const d_drawspans = drawspansState.d_drawspans;
        if (d_drawspans === null) Sys_Error("D_DrawSurfaces: NULL d_drawspans");
        d_drawspans(s.spans);

        D_DrawZSpans(s.spans);

        if (s.insubmodel) {
          //
          // restore the old drawing state
          // FIXME: we don't want to do this every time!
          // TODO: speed up
          //
          rState.currententity = cl_entities[0];
          VectorCopy(world_transformed_modelorg, transformed_modelorg);
          VectorCopy(base_vpn, vpn);
          VectorCopy(base_vup, vup);
          VectorCopy(base_vright, vright);
          VectorCopy(base_modelorg, modelorg);
          R_TransformFrustum();
        }
      }
    }
  }
}
