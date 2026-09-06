/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_scan.c (GNU GPL v2 or later).

// d_scan.c
//
// Portable C scan-level rasterization code, all pixel depths.

Deviations from PORTING.md / the C source:
- Every `byte *pdest` / `unsigned char *pbase` walk is a byte index into a
  Uint8Array: `pdest = (byte *)d_viewbuffer + (screenwidth * pspan->v) +
  pspan->u` becomes that same sum used as an index into
  `rState.d_viewbuffer`, and `*pdest++` becomes `buf[pdest++]`.
  `short *pdest = d_pzbuffer + ...` is likewise an ELEMENT index into
  `rState.d_pzbuffer` (an Int16Array), which is what the `short *` arithmetic
  computes.
- `int *r_turb_turb = sintable + offset` has no pointer equivalent, so
  `r_turb_turb` holds the OFFSET and every read is
  `sintable[r_turb_turb + i]`. Same for `turb = intsintable + offset` in
  D_WarpScreen. `r_turb_pbase` stays a Uint8Array (it is `cacheblock`);
  `r_turb_pdest` is a byte index into `rState.d_viewbuffer`, the only
  destination Turbulent8 ever passes.
- D_WarpScreen's `byte *rowptr[MAXHEIGHT+(AMP2*2)]` and
  `int column[MAXWIDTH+(AMP2*2)]` are C stack arrays; here they are
  module-level Int32Arrays of the same lengths, and `rowptr` holds the BYTE
  OFFSET into d_viewbuffer that the C stored as a pointer, so
  `row[turb[u]][col[u]]` is `d_viewbuffer[rowptr[...] + column[...]]`.
- D_DrawZSpans: the C tests `(long)pdest & 0x02` to align, then writes pairs
  of shorts as one `int` (`ltemp = izi >> 16; ... ltemp |= izi & 0xFFFF0000`).
  Both halves of that dword hold exactly `izi >> 16` for their pixel, so the
  aligned/unaligned split and the doubled writes collapse to one per-element
  store into the Int16Array with no change in the bytes written. There is no
  pointer address in TS to test.
- C int arithmetic wraps at 32 bits; `| 0` after each add and each `(int)`
  cast reproduces that. `(int)` of a float truncates toward zero, which `| 0`
  also does. The one place the two differ is an out-of-range conversion --
  `izi = (int)(zi * 0x8000 * 0x10000)`, which the C's own comment flags ("we
  count on FP exceptions being turned off to avoid range problems"): x86
  yields 0x80000000 there, `| 0` yields the value mod 2^32. Every 16.16
  product in these loops is exactly representable as a double (< 2^53), so
  the results agree wherever the C itself was in range.
- `D_DrawSpans16` exists only as x86 assembly (d_draw16.s); WinQuake's C has
  no such function, and d_init.c's `#if !id386` half always assigns
  `d_drawspans = D_DrawSpans8`. It is therefore not ported and d_init.ts
  installs D_DrawSpans8 unconditionally.
- `rState.d_viewbuffer` / `rState.d_pzbuffer` / `vid.buffer` /
  `rState.cacheblock` are `| null` until the video backend and the surface
  code fill them; the C would dereference a null pointer, so this port raises
  Sys_Error.
- Dropped `#if id386` branches: the asm twins of D_DrawTurbulent8Span,
  D_DrawSpans8 and D_DrawZSpans (d_scan.s / d_draw.s). Turbulent8 and
  D_WarpScreen have no `#if` around them and are ported as-is.
*/

import { Sys_Error } from "../platform/sys";
import { cl } from "../client/client";
import { vid } from "../client/vid";
import { scr_vrect } from "../client/screen_types";
import { CYCLE } from "./d_iface";
import { AMP2, SPEED } from "./r_local";
import { type EspanT, MAXHEIGHT, MAXWIDTH, intsintable, r_refdef, rState, sintable } from "./r_shared";

// d_scan.c's r_turb_* file-scope globals. `r_turb_pbase` is `cacheblock`;
// `r_turb_pdest` is a byte index into rState.d_viewbuffer; `r_turb_turb` is
// an index into `sintable` (the C holds `sintable + offset`).
export const turbState: {
  r_turb_pbase: Uint8Array | null;
  r_turb_pdest: number;
  r_turb_s: number; // fixed16_t
  r_turb_t: number; // fixed16_t
  r_turb_sstep: number; // fixed16_t
  r_turb_tstep: number; // fixed16_t
  r_turb_turb: number;
  r_turb_spancount: number;
} = {
  r_turb_pbase: null,
  r_turb_pdest: 0,
  r_turb_s: 0,
  r_turb_t: 0,
  r_turb_sstep: 0,
  r_turb_tstep: 0,
  r_turb_turb: 0,
  r_turb_spancount: 0,
};

const rowptr: Int32Array = new Int32Array(MAXHEIGHT + AMP2 * 2);
const column: Int32Array = new Int32Array(MAXWIDTH + AMP2 * 2);

/*
=============
D_WarpScreen

// this performs a slight compression of the screen at the same time as
// the sine warp, to keep the edges from wrapping
=============
*/
export function D_WarpScreen(): void {
  const d_viewbuffer = rState.d_viewbuffer;
  const destbuf = vid.buffer;
  if (d_viewbuffer === null) Sys_Error("D_WarpScreen: NULL d_viewbuffer");
  if (destbuf === null) Sys_Error("D_WarpScreen: NULL vid.buffer");

  const screenwidth = rState.screenwidth;

  const w = r_refdef.vrect.width;
  const h = r_refdef.vrect.height;

  const wratio = w / scr_vrect.width;
  const hratio = h / scr_vrect.height;

  for (let v = 0; v < scr_vrect.height + AMP2 * 2; v++) {
    rowptr[v] = r_refdef.vrect.y * screenwidth + screenwidth * (((v * hratio * h) / (h + AMP2 * 2)) | 0);
  }

  for (let u = 0; u < scr_vrect.width + AMP2 * 2; u++) {
    column[u] = r_refdef.vrect.x + (((u * wratio * w) / (w + AMP2 * 2)) | 0);
  }

  const turb = ((cl.time * SPEED) | 0) & (CYCLE - 1);
  let dest = scr_vrect.y * vid.rowbytes + scr_vrect.x;

  for (let v = 0; v < scr_vrect.height; v++, dest += vid.rowbytes) {
    const col = intsintable[turb + v];
    const row = v;

    for (let u = 0; u < scr_vrect.width; u += 4) {
      destbuf[dest + u + 0] = d_viewbuffer[rowptr[row + intsintable[turb + u + 0]] + column[col + u + 0]];
      destbuf[dest + u + 1] = d_viewbuffer[rowptr[row + intsintable[turb + u + 1]] + column[col + u + 1]];
      destbuf[dest + u + 2] = d_viewbuffer[rowptr[row + intsintable[turb + u + 2]] + column[col + u + 2]];
      destbuf[dest + u + 3] = d_viewbuffer[rowptr[row + intsintable[turb + u + 3]] + column[col + u + 3]];
    }
  }
}

/*
=============
D_DrawTurbulent8Span
=============
*/
export function D_DrawTurbulent8Span(): void {
  const pbase = turbState.r_turb_pbase;
  const d_viewbuffer = rState.d_viewbuffer;
  if (pbase === null) Sys_Error("D_DrawTurbulent8Span: NULL r_turb_pbase");
  if (d_viewbuffer === null) Sys_Error("D_DrawTurbulent8Span: NULL d_viewbuffer");

  let sturb: number;
  let tturb: number;

  do {
    sturb = ((turbState.r_turb_s + sintable[turbState.r_turb_turb + ((turbState.r_turb_t >> 16) & (CYCLE - 1))]) >> 16) & 63;
    tturb = ((turbState.r_turb_t + sintable[turbState.r_turb_turb + ((turbState.r_turb_s >> 16) & (CYCLE - 1))]) >> 16) & 63;
    d_viewbuffer[turbState.r_turb_pdest++] = pbase[(tturb << 6) + sturb];
    turbState.r_turb_s = (turbState.r_turb_s + turbState.r_turb_sstep) | 0;
    turbState.r_turb_t = (turbState.r_turb_t + turbState.r_turb_tstep) | 0;
  } while (--turbState.r_turb_spancount > 0);
}

/*
=============
Turbulent8
=============
*/
export function Turbulent8(pspanIn: EspanT | null): void {
  const cacheblock = rState.cacheblock;
  if (cacheblock === null) Sys_Error("Turbulent8: NULL cacheblock");

  let pspan: EspanT | null = pspanIn;
  if (pspan === null) return;

  let count: number;
  let snext = 0;
  let tnext = 0;
  let sdivz: number;
  let tdivz: number;
  let zi: number;
  let z: number;
  let du: number;
  let dv: number;
  let spancountminus1: number;

  const screenwidth = rState.screenwidth;

  turbState.r_turb_turb = ((cl.time * SPEED) | 0) & (CYCLE - 1);

  turbState.r_turb_sstep = 0; // keep compiler happy
  turbState.r_turb_tstep = 0; // ditto

  turbState.r_turb_pbase = cacheblock;

  const sdivz16stepu = rState.d_sdivzstepu * 16;
  const tdivz16stepu = rState.d_tdivzstepu * 16;
  const zi16stepu = rState.d_zistepu * 16;

  do {
    turbState.r_turb_pdest = screenwidth * pspan.v + pspan.u;

    count = pspan.count;

    // calculate the initial s/z, t/z, 1/z, s, and t and clamp
    du = pspan.u;
    dv = pspan.v;

    sdivz = rState.d_sdivzorigin + dv * rState.d_sdivzstepv + du * rState.d_sdivzstepu;
    tdivz = rState.d_tdivzorigin + dv * rState.d_tdivzstepv + du * rState.d_tdivzstepu;
    zi = rState.d_ziorigin + dv * rState.d_zistepv + du * rState.d_zistepu;
    z = 0x10000 / zi; // prescale to 16.16 fixed-point

    turbState.r_turb_s = (((sdivz * z) | 0) + rState.sadjust) | 0;
    if (turbState.r_turb_s > rState.bbextents) turbState.r_turb_s = rState.bbextents;
    else if (turbState.r_turb_s < 0) turbState.r_turb_s = 0;

    turbState.r_turb_t = (((tdivz * z) | 0) + rState.tadjust) | 0;
    if (turbState.r_turb_t > rState.bbextentt) turbState.r_turb_t = rState.bbextentt;
    else if (turbState.r_turb_t < 0) turbState.r_turb_t = 0;

    do {
      // calculate s and t at the far end of the span
      if (count >= 16) turbState.r_turb_spancount = 16;
      else turbState.r_turb_spancount = count;

      count -= turbState.r_turb_spancount;

      if (count) {
        // calculate s/z, t/z, zi->fixed s and t at far end of span,
        // calculate s and t steps across span by shifting
        sdivz += sdivz16stepu;
        tdivz += tdivz16stepu;
        zi += zi16stepu;
        z = 0x10000 / zi; // prescale to 16.16 fixed-point

        snext = (((sdivz * z) | 0) + rState.sadjust) | 0;
        if (snext > rState.bbextents) snext = rState.bbextents;
        else if (snext < 16) snext = 16; // prevent round-off error on <0 steps from
        //  from causing overstepping & running off the
        //  edge of the texture

        tnext = (((tdivz * z) | 0) + rState.tadjust) | 0;
        if (tnext > rState.bbextentt) tnext = rState.bbextentt;
        else if (tnext < 16) tnext = 16; // guard against round-off error on <0 steps

        turbState.r_turb_sstep = (snext - turbState.r_turb_s) >> 4;
        turbState.r_turb_tstep = (tnext - turbState.r_turb_t) >> 4;
      } else {
        // calculate s/z, t/z, zi->fixed s and t at last pixel in span (so
        // can't step off polygon), clamp, calculate s and t steps across
        // span by division, biasing steps low so we don't run off the
        // texture
        spancountminus1 = turbState.r_turb_spancount - 1;
        sdivz += rState.d_sdivzstepu * spancountminus1;
        tdivz += rState.d_tdivzstepu * spancountminus1;
        zi += rState.d_zistepu * spancountminus1;
        z = 0x10000 / zi; // prescale to 16.16 fixed-point
        snext = (((sdivz * z) | 0) + rState.sadjust) | 0;
        if (snext > rState.bbextents) snext = rState.bbextents;
        else if (snext < 16) snext = 16; // prevent round-off error on <0 steps from
        //  from causing overstepping & running off the
        //  edge of the texture

        tnext = (((tdivz * z) | 0) + rState.tadjust) | 0;
        if (tnext > rState.bbextentt) tnext = rState.bbextentt;
        else if (tnext < 16) tnext = 16; // guard against round-off error on <0 steps

        if (turbState.r_turb_spancount > 1) {
          turbState.r_turb_sstep = ((snext - turbState.r_turb_s) / (turbState.r_turb_spancount - 1)) | 0;
          turbState.r_turb_tstep = ((tnext - turbState.r_turb_t) / (turbState.r_turb_spancount - 1)) | 0;
        }
      }

      turbState.r_turb_s = turbState.r_turb_s & ((CYCLE << 16) - 1);
      turbState.r_turb_t = turbState.r_turb_t & ((CYCLE << 16) - 1);

      D_DrawTurbulent8Span();

      turbState.r_turb_s = snext;
      turbState.r_turb_t = tnext;
    } while (count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}

/*
=============
D_DrawSpans8
=============
*/
export function D_DrawSpans8(pspanIn: EspanT | null): void {
  const pbase = rState.cacheblock;
  const d_viewbuffer = rState.d_viewbuffer;
  if (pbase === null) Sys_Error("D_DrawSpans8: NULL cacheblock");
  if (d_viewbuffer === null) Sys_Error("D_DrawSpans8: NULL d_viewbuffer");

  let pspan: EspanT | null = pspanIn;
  if (pspan === null) return;

  let count: number;
  let spancount: number;
  let pdest: number;
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

  const screenwidth = rState.screenwidth;
  const cachewidth = rState.cachewidth;

  sstep = 0; // keep compiler happy
  tstep = 0; // ditto

  const sdivz8stepu = rState.d_sdivzstepu * 8;
  const tdivz8stepu = rState.d_tdivzstepu * 8;
  const zi8stepu = rState.d_zistepu * 8;

  do {
    pdest = screenwidth * pspan.v + pspan.u;

    count = pspan.count;

    // calculate the initial s/z, t/z, 1/z, s, and t and clamp
    du = pspan.u;
    dv = pspan.v;

    sdivz = rState.d_sdivzorigin + dv * rState.d_sdivzstepv + du * rState.d_sdivzstepu;
    tdivz = rState.d_tdivzorigin + dv * rState.d_tdivzstepv + du * rState.d_tdivzstepu;
    zi = rState.d_ziorigin + dv * rState.d_zistepv + du * rState.d_zistepu;
    z = 0x10000 / zi; // prescale to 16.16 fixed-point

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
        d_viewbuffer[pdest++] = pbase[(s >> 16) + (t >> 16) * cachewidth];
        s = (s + sstep) | 0;
        t = (t + tstep) | 0;
      } while (--spancount > 0);

      s = snext;
      t = tnext;
    } while (count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}

/*
=============
D_DrawZSpans
=============
*/
export function D_DrawZSpans(pspanIn: EspanT | null): void {
  const d_pzbuffer = rState.d_pzbuffer;
  if (d_pzbuffer === null) Sys_Error("D_DrawZSpans: NULL d_pzbuffer");

  let pspan: EspanT | null = pspanIn;
  if (pspan === null) return;

  let count: number;
  let izi: number;
  let pdest: number;
  let zi: number;
  let du: number;
  let dv: number;

  const d_zwidth = rState.d_zwidth;

  // FIXME: check for clamping/range problems
  // we count on FP exceptions being turned off to avoid range problems
  const izistep = (rState.d_zistepu * 0x8000 * 0x10000) | 0;

  do {
    pdest = d_zwidth * pspan.v + pspan.u;

    count = pspan.count;

    // calculate the initial 1/z
    du = pspan.u;
    dv = pspan.v;

    zi = rState.d_ziorigin + dv * rState.d_zistepv + du * rState.d_zistepu;
    // we count on FP exceptions being turned off to avoid range problems
    izi = (zi * 0x8000 * 0x10000) | 0;

    while (count > 0) {
      d_pzbuffer[pdest++] = izi >> 16;
      izi = (izi + izistep) | 0;
      count--;
    }

    pspan = pspan.pnext;
  } while (pspan !== null);
}
