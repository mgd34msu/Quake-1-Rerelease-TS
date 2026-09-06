/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_zpoint.c (GNU GPL v2 or later).

// d_zpoint.c: software driver module for drawing z-buffered points

Deviations from PORTING.md / the C source:
- `short *pz = d_pzbuffer + (d_zwidth * v) + u` and `byte *pdest =
  d_viewbuffer + d_scantable[v] + u` become element indexes into
  `rState.d_pzbuffer` (an Int16Array) and `rState.d_viewbuffer` (a
  Uint8Array), which is what those two pointer expressions compute once the
  `short *` / `byte *` scaling is applied.
- `rState.d_pzbuffer` / `rState.d_viewbuffer` are `| null` until the video
  backend allocates them; the C would dereference a null pointer, so this port
  raises Sys_Error, which is PORTING.md's mapping for a C crash.
- `izi = (int)(r_zpointdesc.zi * 0x8000)` truncates toward zero; `| 0` does
  the same and additionally wraps at 32 bits, where the C's x86 conversion
  yields the integer-indefinite value. Every zi reaching here is a screen-space
  1/z, so the product stays far inside int32 and the two agree.
- The `*pz` compare reads back through the Int16Array, so it is already the
  C's signed 16-bit read; the store truncates to 16 bits as the C's
  `*pz = izi` does.
- Dropped: nothing. d_zpoint.c has no #ifdef branches.
*/

import { Sys_Error } from "../platform/sys";
import { d_scantable } from "./d_local";
import { r_zpointdesc } from "./d_iface";
import { rState } from "./r_shared";

/*
=====================
D_DrawZPoint
=====================
*/
export function D_DrawZPoint(): void {
  const d_pzbuffer = rState.d_pzbuffer;
  const d_viewbuffer = rState.d_viewbuffer;
  if (d_pzbuffer === null) Sys_Error("D_DrawZPoint: NULL d_pzbuffer");
  if (d_viewbuffer === null) Sys_Error("D_DrawZPoint: NULL d_viewbuffer");

  const pz = rState.d_zwidth * r_zpointdesc.v + r_zpointdesc.u;
  const pdest = d_scantable[r_zpointdesc.v] + r_zpointdesc.u;
  const izi = (r_zpointdesc.zi * 0x8000) | 0;

  if (d_pzbuffer[pz] <= izi) {
    d_pzbuffer[pz] = izi;
    d_viewbuffer[pdest] = r_zpointdesc.color;
  }
}
