/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_sprite.c (GNU GPL v2 or later).

// d_sprite.c: software top-level rasterization driver module for drawing
// sprites

Deviations from PORTING.md / the C source:
- `sspan_t spans[MAXHEIGHT+1]` is a C stack array in D_DrawSprite and the
  static `sprite_spans` points at it. Here it is one module-level pool built
  by d_local.ts's `allocSspans(MAXHEIGHT + 1)`, and `sprite_spans` is that
  array; `pspan++` becomes an index. D_SpriteDrawSpans takes the array and
  starts at element 0, which is the only thing the C ever passes.
- `byte *pdest` / `short *pz` walks become byte and element indexes into
  `rState.d_viewbuffer` (Uint8Array) and `rState.d_pzbuffer` (Int16Array),
  which is what the C's pointer arithmetic computes.
- `emitpoint_t *pnext = pvert - 1` / `pvert + 1` walk r_spritedesc.pverts,
  which is an EmitpointT[] here, so both become index arithmetic on that
  array.
- `pverts[nump] = pverts[0]` is a C struct copy; assigning the object
  reference would alias, so the five fields are copied.
- C int arithmetic wraps at 32 bits; `| 0` after each `(int)` cast and each
  fixed-point add reproduces that, and `(int)` of a float truncates toward
  zero exactly as `| 0` does. `ceil()` is Math.ceil.
- `TransformVector` is r_misc.c's and is imported from ./r_misc by its C name;
  until that unit lands, `bun run check` reports "Cannot find module
  './r_misc'" for this file.
- `rState.d_viewbuffer` / `rState.d_pzbuffer` / `rState.cacheblock` are
  `| null`; the C would dereference a null pointer, so this port raises
  Sys_Error.
- Dropped `#if id386` branch: D_SpriteDrawSpans has an asm twin in d_spr8.s.
  This is the `#if !id386` body, which PORTING.md ports.
*/

import { Sys_Error } from "../platform/sys";
import { DotProduct, VectorInverse, vec3 } from "../common/mathlib";
import { DS_SPAN_LIST_END, MAXHEIGHT, type SspanT, allocSspans } from "./d_local";
import { r_spritedesc } from "./d_iface";
import { modelorg, r_refdef, rState } from "./r_shared";
import { TransformVector } from "./r_misc";

let sprite_height = 0;
let minindex = 0;
let maxindex = 0;
const sprite_spans: SspanT[] = allocSspans(MAXHEIGHT + 1);

/*
=====================
D_SpriteDrawSpans
=====================
*/
export function D_SpriteDrawSpans(spans: SspanT[]): void {
  const pbase = rState.cacheblock;
  const d_viewbuffer = rState.d_viewbuffer;
  const d_pzbuffer = rState.d_pzbuffer;
  if (pbase === null) Sys_Error("D_SpriteDrawSpans: NULL cacheblock");
  if (d_viewbuffer === null) Sys_Error("D_SpriteDrawSpans: NULL d_viewbuffer");
  if (d_pzbuffer === null) Sys_Error("D_SpriteDrawSpans: NULL d_pzbuffer");

  let count: number;
  let spancount: number;
  let izi: number;
  let pdest: number;
  let pz: number;
  let s: number;
  let t: number;
  let snext = 0;
  let tnext = 0;
  let sstep: number;
  let tstep: number;
  let sdivz: number;
  let tdivz: number;
  let zi: number;
  let z: number;
  let du: number;
  let dv: number;
  let spancountminus1: number;
  let btemp: number;

  const screenwidth = rState.screenwidth;
  const d_zwidth = rState.d_zwidth;
  const cachewidth = rState.cachewidth;

  sstep = 0; // keep compiler happy
  tstep = 0; // ditto

  const sdivz8stepu = rState.d_sdivzstepu * 8;
  const tdivz8stepu = rState.d_tdivzstepu * 8;
  const zi8stepu = rState.d_zistepu * 8;

  // we count on FP exceptions being turned off to avoid range problems
  const izistep = (rState.d_zistepu * 0x8000 * 0x10000) | 0;

  let i = 0;

  do {
    const pspan = spans[i];

    pdest = screenwidth * pspan.v + pspan.u;
    pz = d_zwidth * pspan.v + pspan.u;

    count = pspan.count;

    if (count > 0) {
      // calculate the initial s/z, t/z, 1/z, s, and t and clamp
      du = pspan.u;
      dv = pspan.v;

      sdivz = rState.d_sdivzorigin + dv * rState.d_sdivzstepv + du * rState.d_sdivzstepu;
      tdivz = rState.d_tdivzorigin + dv * rState.d_tdivzstepv + du * rState.d_tdivzstepu;
      zi = rState.d_ziorigin + dv * rState.d_zistepv + du * rState.d_zistepu;
      z = 0x10000 / zi; // prescale to 16.16 fixed-point
      // we count on FP exceptions being turned off to avoid range problems
      izi = (zi * 0x8000 * 0x10000) | 0;

      s = (((sdivz * z) | 0) + rState.sadjust) | 0;
      if (s > rState.bbextents) s = rState.bbextents;
      else if (s < 0) s = 0;

      t = (((tdivz * z) | 0) + rState.tadjust) | 0;
      if (t > rState.bbextentt) t = rState.bbextentt;
      else if (t < 0) t = 0;

      do {
        // calculate s and t at the far end of the span
        if (count >= 8) spancount = 8;
        else spancount = count;

        count -= spancount;

        if (count) {
          // calculate s/z, t/z, zi->fixed s and t at far end of span,
          // calculate s and t steps across span by shifting
          sdivz += sdivz8stepu;
          tdivz += tdivz8stepu;
          zi += zi8stepu;
          z = 0x10000 / zi; // prescale to 16.16 fixed-point

          snext = (((sdivz * z) | 0) + rState.sadjust) | 0;
          if (snext > rState.bbextents) snext = rState.bbextents;
          else if (snext < 8) snext = 8; // prevent round-off error on <0 steps from
          //  from causing overstepping & running off the
          //  edge of the texture

          tnext = (((tdivz * z) | 0) + rState.tadjust) | 0;
          if (tnext > rState.bbextentt) tnext = rState.bbextentt;
          else if (tnext < 8) tnext = 8; // guard against round-off error on <0 steps

          sstep = (snext - s) >> 3;
          tstep = (tnext - t) >> 3;
        } else {
          // calculate s/z, t/z, zi->fixed s and t at last pixel in span (so
          // can't step off polygon), clamp, calculate s and t steps across
          // span by division, biasing steps low so we don't run off the
          // texture
          spancountminus1 = spancount - 1;
          sdivz += rState.d_sdivzstepu * spancountminus1;
          tdivz += rState.d_tdivzstepu * spancountminus1;
          zi += rState.d_zistepu * spancountminus1;
          z = 0x10000 / zi; // prescale to 16.16 fixed-point
          snext = (((sdivz * z) | 0) + rState.sadjust) | 0;
          if (snext > rState.bbextents) snext = rState.bbextents;
          else if (snext < 8) snext = 8; // prevent round-off error on <0 steps from
          //  from causing overstepping & running off the
          //  edge of the texture

          tnext = (((tdivz * z) | 0) + rState.tadjust) | 0;
          if (tnext > rState.bbextentt) tnext = rState.bbextentt;
          else if (tnext < 8) tnext = 8; // guard against round-off error on <0 steps

          if (spancount > 1) {
            sstep = ((snext - s) / (spancount - 1)) | 0;
            tstep = ((tnext - t) / (spancount - 1)) | 0;
          }
        }

        do {
          btemp = pbase[(s >> 16) + (t >> 16) * cachewidth];
          if (btemp !== 255) {
            if (d_pzbuffer[pz] <= izi >> 16) {
              d_pzbuffer[pz] = izi >> 16;
              d_viewbuffer[pdest] = btemp;
            }
          }

          izi = (izi + izistep) | 0;
          pdest++;
          pz++;
          s = (s + sstep) | 0;
          t = (t + tstep) | 0;
        } while (--spancount > 0);

        s = snext;
        t = tnext;
      } while (count > 0);
    }

    i++;
  } while (spans[i].count !== DS_SPAN_LIST_END);
}

/*
=====================
D_SpriteScanLeftEdge
=====================
*/
export function D_SpriteScanLeftEdge(): void {
  const pverts = r_spritedesc.pverts;
  if (pverts === null) Sys_Error("D_SpriteScanLeftEdge: NULL pverts");

  let v: number;
  let itop: number;
  let ibottom: number;
  let du: number;
  let dv: number;
  let vbottom: number;
  let slope: number;
  let u: number;
  let u_step: number;

  let pspan = 0;
  let i = minindex;
  if (i === 0) i = r_spritedesc.nump;

  let lmaxindex = maxindex;
  if (lmaxindex === 0) lmaxindex = r_spritedesc.nump;

  let vtop = Math.ceil(pverts[i].v);

  do {
    const pvert = pverts[i];
    const pnext = pverts[i - 1];

    vbottom = Math.ceil(pnext.v);

    if (vtop < vbottom) {
      du = pnext.u - pvert.u;
      dv = pnext.v - pvert.v;
      slope = du / dv;
      u_step = (slope * 0x10000) | 0;
      // adjust u to ceil the integer portion
      u = (((pvert.u + slope * (vtop - pvert.v)) * 0x10000) | 0) + (0x10000 - 1);
      itop = vtop | 0;
      ibottom = vbottom | 0;

      for (v = itop; v < ibottom; v++) {
        sprite_spans[pspan].u = u >> 16;
        sprite_spans[pspan].v = v;
        u = (u + u_step) | 0;
        pspan++;
      }
    }

    vtop = vbottom;

    i--;
    if (i === 0) i = r_spritedesc.nump;
  } while (i !== lmaxindex);
}

/*
=====================
D_SpriteScanRightEdge
=====================
*/
export function D_SpriteScanRightEdge(): void {
  const pverts = r_spritedesc.pverts;
  if (pverts === null) Sys_Error("D_SpriteScanRightEdge: NULL pverts");

  let v: number;
  let itop: number;
  let ibottom: number;
  let du: number;
  let dv: number;
  let vbottom: number;
  let slope: number;
  let uvert: number;
  let unext: number;
  let vnext: number;
  let u: number;
  let u_step: number;

  let pspan = 0;
  let i = minindex;

  let vvert = pverts[i].v;
  if (vvert < r_refdef.fvrecty_adj) vvert = r_refdef.fvrecty_adj;
  if (vvert > r_refdef.fvrectbottom_adj) vvert = r_refdef.fvrectbottom_adj;

  let vtop = Math.ceil(vvert);

  do {
    const pvert = pverts[i];
    const pnext = pverts[i + 1];

    vnext = pnext.v;
    if (vnext < r_refdef.fvrecty_adj) vnext = r_refdef.fvrecty_adj;
    if (vnext > r_refdef.fvrectbottom_adj) vnext = r_refdef.fvrectbottom_adj;

    vbottom = Math.ceil(vnext);

    if (vtop < vbottom) {
      uvert = pvert.u;
      if (uvert < r_refdef.fvrectx_adj) uvert = r_refdef.fvrectx_adj;
      if (uvert > r_refdef.fvrectright_adj) uvert = r_refdef.fvrectright_adj;

      unext = pnext.u;
      if (unext < r_refdef.fvrectx_adj) unext = r_refdef.fvrectx_adj;
      if (unext > r_refdef.fvrectright_adj) unext = r_refdef.fvrectright_adj;

      du = unext - uvert;
      dv = vnext - vvert;
      slope = du / dv;
      u_step = (slope * 0x10000) | 0;
      // adjust u to ceil the integer portion
      u = (((uvert + slope * (vtop - vvert)) * 0x10000) | 0) + (0x10000 - 1);
      itop = vtop | 0;
      ibottom = vbottom | 0;

      for (v = itop; v < ibottom; v++) {
        sprite_spans[pspan].count = (u >> 16) - sprite_spans[pspan].u;
        u = (u + u_step) | 0;
        pspan++;
      }
    }

    vtop = vbottom;
    vvert = vnext;

    i++;
    if (i === r_spritedesc.nump) i = 0;
  } while (i !== maxindex);

  sprite_spans[pspan].count = DS_SPAN_LIST_END; // mark the end of the span list
}

const p_normal = vec3();
const p_saxis = vec3();
const p_taxis = vec3();
const p_temp1 = vec3();

/*
=====================
D_SpriteCalculateGradients
=====================
*/
export function D_SpriteCalculateGradients(): void {
  TransformVector(r_spritedesc.vpn, p_normal);
  TransformVector(r_spritedesc.vright, p_saxis);
  TransformVector(r_spritedesc.vup, p_taxis);
  VectorInverse(p_taxis);

  const distinv = 1.0 / -DotProduct(modelorg, r_spritedesc.vpn);

  rState.d_sdivzstepu = p_saxis[0] * rState.xscaleinv;
  rState.d_tdivzstepu = p_taxis[0] * rState.xscaleinv;

  rState.d_sdivzstepv = -p_saxis[1] * rState.yscaleinv;
  rState.d_tdivzstepv = -p_taxis[1] * rState.yscaleinv;

  rState.d_zistepu = p_normal[0] * rState.xscaleinv * distinv;
  rState.d_zistepv = -p_normal[1] * rState.yscaleinv * distinv;

  rState.d_sdivzorigin = p_saxis[2] - rState.xcenter * rState.d_sdivzstepu - rState.ycenter * rState.d_sdivzstepv;
  rState.d_tdivzorigin = p_taxis[2] - rState.xcenter * rState.d_tdivzstepu - rState.ycenter * rState.d_tdivzstepv;
  rState.d_ziorigin = p_normal[2] * distinv - rState.xcenter * rState.d_zistepu - rState.ycenter * rState.d_zistepv;

  TransformVector(modelorg, p_temp1);

  rState.sadjust = (((DotProduct(p_temp1, p_saxis) * 0x10000 + 0.5) | 0) - (-(rState.cachewidth >> 1) << 16)) | 0;
  rState.tadjust = (((DotProduct(p_temp1, p_taxis) * 0x10000 + 0.5) | 0) - (-(sprite_height >> 1) << 16)) | 0;

  // -1 (-epsilon) so we never wander off the edge of the texture
  rState.bbextents = ((rState.cachewidth << 16) - 1) | 0;
  rState.bbextentt = ((sprite_height << 16) - 1) | 0;
}

/*
=====================
D_DrawSprite
=====================
*/
export function D_DrawSprite(): void {
  let i: number;
  let ymin: number;
  let ymax: number;

  const pverts = r_spritedesc.pverts;
  const pspriteframe = r_spritedesc.pspriteframe;
  if (pverts === null) Sys_Error("D_DrawSprite: NULL pverts");
  if (pspriteframe === null) Sys_Error("D_DrawSprite: NULL pspriteframe");

  // find the top and bottom vertices, and make sure there's at least one scan to
  // draw
  ymin = 999999.9;
  ymax = -999999.9;

  for (i = 0; i < r_spritedesc.nump; i++) {
    if (pverts[i].v < ymin) {
      ymin = pverts[i].v;
      minindex = i;
    }

    if (pverts[i].v > ymax) {
      ymax = pverts[i].v;
      maxindex = i;
    }
  }

  ymin = Math.ceil(ymin);
  ymax = Math.ceil(ymax);

  if (ymin >= ymax) return; // doesn't cross any scans at all

  rState.cachewidth = pspriteframe.width;
  sprite_height = pspriteframe.height;
  rState.cacheblock = pspriteframe.pixels;

  // copy the first vertex to the last vertex, so we don't have to deal with
  // wrapping
  const nump = r_spritedesc.nump;
  pverts[nump].u = pverts[0].u;
  pverts[nump].v = pverts[0].v;
  pverts[nump].s = pverts[0].s;
  pverts[nump].t = pverts[0].t;
  pverts[nump].zi = pverts[0].zi;

  D_SpriteCalculateGradients();
  D_SpriteScanLeftEdge();
  D_SpriteScanRightEdge();
  D_SpriteDrawSpans(sprite_spans);
}
