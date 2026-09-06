/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_fill.c (GNU GPL v2 or later).

// d_clear: clears a specified rectangle to the specified color

Deviations from PORTING.md / the C source:
- `dest = (byte *)vid.buffer + ry*vid.rowbytes + rx` becomes a byte index into
  `vid.buffer` (a Uint8Array).
- The C picks between a dword clear and a byte clear on `(rwidth & 0x03) == 0
  && ((long)dest & 0x03) == 0`. Both branches write the same bytes: the dword
  path builds `color + (color<<16)` then `+ (color<<8)`, i.e. the color byte
  replicated four times, and writes `rwidth >> 2` dwords over exactly the
  `rwidth` bytes the byte path writes. There is no address to test in TS, so
  the byte loop is the only path here and the result is identical.
- `vid.buffer` is `| null` until the video backend allocates it; the C would
  dereference a null pointer, so this port raises Sys_Error.
- PRESERVED C BUG: the bottom clamp is `rheight = vid.height - rx` (the C uses
  rx where ry is meant). Kept exactly as the original per PORTING.md.
- Dropped: nothing. d_fill.c has no #ifdef branches.
*/

import { Sys_Error } from "../platform/sys";
import { d_8to24table, vid, type VrectT } from "../client/vid";
import { rState } from "./r_shared";

/*
================
D_FillRect
================
*/
export function D_FillRect(rect: VrectT, color: number): void {
  const buffer = vid.buffer;
  if (buffer === null) Sys_Error("D_FillRect: NULL vid.buffer");

  let rx = rect.x;
  let ry = rect.y;
  let rwidth = rect.width;
  let rheight = rect.height;

  if (rx < 0) {
    rwidth += rx;
    rx = 0;
  }
  if (ry < 0) {
    rheight += ry;
    ry = 0;
  }
  if (rx + rwidth > vid.width) rwidth = vid.width - rx;
  if (ry + rheight > vid.height) rheight = vid.height - rx;

  if (rwidth < 1 || rheight < 1) return;

  let dest = ry * vid.rowbytes + rx;

  // U25: the fill color is a palette index, expanded untinted into the
  // 32-bit framebuffer while the true-color path is presenting
  // (src/ref_soft/r_coloredlight.ts)
  const out32 = rState.r_truecolor ? vid.buffer32 : null;
  const color32 = out32 !== null ? d_8to24table[color & 0xff] : 0;

  // slower byte-by-byte clear for unaligned cases
  for (ry = 0; ry < rheight; ry++) {
    for (rx = 0; rx < rwidth; rx++) buffer[dest + rx] = color;
    if (out32 !== null) for (rx = 0; rx < rwidth; rx++) out32[dest + rx] = color32;
    dest += vid.rowbytes;
  }
}
