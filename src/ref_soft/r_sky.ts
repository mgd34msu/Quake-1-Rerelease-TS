/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_sky.c (GNU GPL v2 or later).

r_sky.c: builds the moving two-layer sky texture (`newsky`) that
R_DrawSurfaceBlock8/16 (d_surf.c, U065) samples through R_GenSkyTile /
R_GenSkyTile (this module), and R_SetSkyFrame's per-frame time-to-shift
conversion.

Deviations from PORTING.md / the C source:
- `iskyspeed`/`iskyspeed2` are declared non-`static` in the C but assigned
  nowhere else in any non-asm .c or .h file in v1.09 (grepped the whole
  WinQuake tree), so they stay module-private `const`s here rather than
  fields any other module could reassign.
- `bottomsky`/`bottommask`/`newsky` are declared non-`static` file-scope
  globals in the C but read by no other .c file (R_GenSkyTile/R_MakeSky are
  their only readers, both here), so they stay module-private `const`
  Uint8Arrays rather than `rState` fields.
- R_MakeSky's and R_GenSkyTile's `#if UNALIGNED_OK` branch reads/writes four
  bytes at a time through an unaligned `unsigned *` as a raw-memory
  optimization; the `#else` branch it guards is the scalar byte-at-a-time
  loop that computes the exact same bytes (the dword path ORs/ANDs the same
  four byte lanes the scalar path visits one at a time). Neither branch is
  id386/asm-only or platform-conditional in the PORTING.md sense (both are
  plain C, selected only by whether unaligned dword loads are safe on the
  target), so this port takes the scalar `#else` body, which is what every
  non-x86 WinQuake target already built. Same reasoning as `#if id386`.
- `R_GenSkyTile16` (writes `unsigned short` through `d_8to16table`) is read
  by no non-asm caller under the only value `rState.r_pixbytes` is ever
  assigned in v1.09: `r_main.c` and `d_init.c` both initialize it to `1` and
  no non-asm file reassigns it, so the `r_pixbytes == 2` branch in
  r_surf.c's caller of R_GenSkyTile16 never runs. Dropped as unreachable
  dead code, not as an id386/#if 0 exclusion -- reported as a deviation
  rather than silently ignored per standing order 14.
- The C's `pnewsky`/`pd` are raw cursors marching through one packed
  256-byte-wide buffer (`newsky`'s left 128 bytes hold the moving bottom
  layer this file writes, its right 128 bytes hold the static top layer
  R_InitSky copied in); ported as direct index arithmetic on that same
  layout (`newsky[y * 256 + x]` / `newsky[y * 256 + x + 128]`), per
  PORTING.md's pointer-arithmetic-to-index-math rule.
- `texture_t`'s mip pixel block lives on `TextureT.data` in this port
  (src/common/model.ts's header comment), so `mt->offsets[0]` becomes the
  index `mt.offsets[0]` into `mt.data`, not a pointer add.
*/

import { GreatestCommonDivisor } from "../common/mathlib";
import type { TextureT } from "../common/model";
import { cl } from "../client/client";
import { SKYMASK, SKYSIZE } from "./d_iface";
import { rState } from "./r_local";

const iskyspeed = 8;
const iskyspeed2 = 2;

const bottomsky: Uint8Array = new Uint8Array(128 * 131);
const bottommask: Uint8Array = new Uint8Array(128 * 131);
// newsky and topsky both pack in here, 128 bytes of newsky on the left of
// each scan, 128 bytes of topsky on the right, because the low-level
// drawers need 256-byte scan widths
const newsky: Uint8Array = new Uint8Array(128 * 256);

let xlast = -1;
let ylast = -1;

/*
=============
R_InitSky

A sky texture is 256*128, with the right side being a masked overlay
==============
*/
export function R_InitSky(mt: TextureT): void {
  const src = mt.data;
  const base = mt.offsets[0];

  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 128; j++) {
      newsky[i * 256 + j + 128] = src[base + i * 256 + j + 128];
    }
  }

  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 131; j++) {
      const s = src[base + i * 256 + (j & 0x7f)];
      if (s) {
        bottomsky[i * 131 + j] = s;
        bottommask[i * 131 + j] = 0;
      } else {
        bottomsky[i * 131 + j] = 0;
        bottommask[i * 131 + j] = 0xff;
      }
    }
  }

  rState.r_skysource = newsky;
}

/*
=================
R_MakeSky
=================
*/
export function R_MakeSky(): void {
  const xshift = (rState.skytime * rState.skyspeed) | 0;
  const yshift = (rState.skytime * rState.skyspeed) | 0;

  if (xshift === xlast && yshift === ylast) return;

  xlast = xshift;
  ylast = yshift;

  for (let y = 0; y < SKYSIZE; y++) {
    const baseofs = ((y + yshift) & SKYMASK) * 131;
    const row = y * 256;

    for (let x = 0; x < SKYSIZE; x++) {
      const ofs = baseofs + ((x + xshift) & SKYMASK);
      newsky[row + x] = (newsky[row + x + 128] & bottommask[ofs]) | bottomsky[ofs];
    }
  }

  rState.r_skymade = 1;
}

/*
=================
R_GenSkyTile
=================
*/
export function R_GenSkyTile(pdest: Uint8Array): void {
  const xshift = (rState.skytime * rState.skyspeed) | 0;
  const yshift = (rState.skytime * rState.skyspeed) | 0;

  for (let y = 0; y < SKYSIZE; y++) {
    const baseofs = ((y + yshift) & SKYMASK) * 131;
    const row = y * 256;
    const drow = y * SKYSIZE;

    for (let x = 0; x < SKYSIZE; x++) {
      const ofs = baseofs + ((x + xshift) & SKYMASK);
      pdest[drow + x] = (newsky[row + x + 128] & bottommask[ofs]) | bottomsky[ofs];
    }
  }
}

/*
=============
R_SetSkyFrame
==============
*/
export function R_SetSkyFrame(): void {
  rState.skyspeed = iskyspeed;
  rState.skyspeed2 = iskyspeed2;

  const g = GreatestCommonDivisor(iskyspeed, iskyspeed2);
  const s1 = iskyspeed / g;
  const s2 = iskyspeed2 / g;
  const temp = SKYSIZE * s1 * s2;

  rState.skytime = cl.time - ((cl.time / temp) | 0) * temp;

  rState.r_skymade = 0;
}
