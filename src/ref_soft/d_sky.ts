/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_sky.c (GNU GPL v2 or later).

// d_sky.c

Deviations from PORTING.md / the C source:
- `D_Sky_uv_To_st (int u, int v, fixed16_t *s, fixed16_t *t)` writes two out
  params. PORTING.md's out-param style gives it one `Int32Array` of length 2
  instead of two separate pointers: `st[0]` is `*s`, `st[1]` is `*t`.
- `vec3_t end` is a C stack local; here it is a module-level `vec3()` reused
  across calls, which is safe because D_Sky_uv_To_st is not reentrant (the C's
  own callers are a single-threaded span loop).
- `byte *pdest = (byte *)d_viewbuffer + (screenwidth * pspan->v) + pspan->u`
  becomes that same sum used as a byte index into `rState.d_viewbuffer`, and
  `*pdest++ = r_skysource[...]` indexes `rState.r_skysource` (a Uint8Array).
- `int spancountminus1` is assigned `(float)(spancount - 1)` in the C and
  truncated back to int by the assignment; the value is a small non-negative
  integer either way, so it stays a plain number here.
- The `>> 8` in `r_skysource[((t & R_SKY_TMASK) >> 8) + ((s & R_SKY_SMASK) >>
  16)]` is the C's, not R_SKY_TSHIFT: r_sky.c's `newsky` is 128 rows of 256
  bytes, so the t index is the row number scaled by that 256-byte stride.
- C int arithmetic wraps at 32 bits; `| 0` after each `(int)` cast and each
  fixed-point add reproduces that, and `(int)` of a float truncates toward
  zero exactly as `| 0` does.
- `rState.d_viewbuffer` / `rState.r_skysource` are `| null` until the video
  backend and R_InitSky fill them; the C would dereference a null pointer, so
  this port raises Sys_Error.
- Dropped: nothing. d_sky.c has no #ifdef branches (D_DrawSkyScans16 is
  declared in d_local.h but exists only in the 16-bit asm the port drops).
*/

import { Sys_Error } from "../platform/sys";
import { VectorNormalize, vec3 } from "../common/mathlib";
import { vid } from "../client/vid";
import { SKYSIZE } from "./d_iface";
import { R_SKY_SMASK, R_SKY_TMASK } from "./d_local";
import { type EspanT, r_refdef, rState, vpn, vright, vup } from "./r_shared";

const SKY_SPAN_SHIFT = 5;
const SKY_SPAN_MAX = 1 << SKY_SPAN_SHIFT;

const end = vec3();

/*
=================
D_Sky_uv_To_st
=================
*/
export function D_Sky_uv_To_st(u: number, v: number, st: Int32Array): void {
  let temp: number;

  if (r_refdef.vrect.width >= r_refdef.vrect.height) temp = r_refdef.vrect.width;
  else temp = r_refdef.vrect.height;

  const wu = (8192.0 * (u - (vid.width >> 1))) / temp;
  const wv = (8192.0 * ((vid.height >> 1) - v)) / temp;

  end[0] = 4096 * vpn[0] + wu * vright[0] + wv * vup[0];
  end[1] = 4096 * vpn[1] + wu * vright[1] + wv * vup[1];
  end[2] = 4096 * vpn[2] + wu * vright[2] + wv * vup[2];
  end[2] *= 3;
  VectorNormalize(end);

  temp = rState.skytime * rState.skyspeed; // TODO: add D_SetupFrame & set this there
  st[0] = ((temp + 6 * (SKYSIZE / 2 - 1) * end[0]) * 0x10000) | 0;
  st[1] = ((temp + 6 * (SKYSIZE / 2 - 1) * end[1]) * 0x10000) | 0;
}

const st = new Int32Array(2);
const stnext = new Int32Array(2);

/*
=================
D_DrawSkyScans8
=================
*/
export function D_DrawSkyScans8(pspanIn: EspanT | null): void {
  const d_viewbuffer = rState.d_viewbuffer;
  const r_skysource = rState.r_skysource;
  if (d_viewbuffer === null) Sys_Error("D_DrawSkyScans8: NULL d_viewbuffer");
  if (r_skysource === null) Sys_Error("D_DrawSkyScans8: NULL r_skysource");

  let pspan: EspanT | null = pspanIn;
  if (pspan === null) return;

  let count: number;
  let spancount: number;
  let u: number;
  let v: number;
  let pdest: number;
  let s: number;
  let t: number;
  let snext = 0;
  let tnext = 0;
  let sstep: number;
  let tstep: number;
  let spancountminus1: number;

  const screenwidth = rState.screenwidth;

  sstep = 0; // keep compiler happy
  tstep = 0; // ditto

  do {
    pdest = screenwidth * pspan.v + pspan.u;

    count = pspan.count;

    // calculate the initial s & t
    u = pspan.u;
    v = pspan.v;
    D_Sky_uv_To_st(u, v, st);
    s = st[0];
    t = st[1];

    do {
      if (count >= SKY_SPAN_MAX) spancount = SKY_SPAN_MAX;
      else spancount = count;

      count -= spancount;

      if (count) {
        u += spancount;

        // calculate s and t at far end of span,
        // calculate s and t steps across span by shifting
        D_Sky_uv_To_st(u, v, stnext);
        snext = stnext[0];
        tnext = stnext[1];

        sstep = (snext - s) >> SKY_SPAN_SHIFT;
        tstep = (tnext - t) >> SKY_SPAN_SHIFT;
      } else {
        // calculate s and t at last pixel in span,
        // calculate s and t steps across span by division
        spancountminus1 = spancount - 1;

        if (spancountminus1 > 0) {
          u += spancountminus1;
          D_Sky_uv_To_st(u, v, stnext);
          snext = stnext[0];
          tnext = stnext[1];

          sstep = ((snext - s) / spancountminus1) | 0;
          tstep = ((tnext - t) / spancountminus1) | 0;
        }
      }

      do {
        d_viewbuffer[pdest++] = r_skysource[((t & R_SKY_TMASK) >> 8) + ((s & R_SKY_SMASK) >> 16)];
        s = (s + sstep) | 0;
        t = (t + tstep) | 0;
      } while (--spancount > 0);

      s = snext;
      t = tnext;
    } while (count > 0);

    pspan = pspan.pnext;
  } while (pspan !== null);
}
