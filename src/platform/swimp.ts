/*
Copyright (C) 1996-1997 Id Software, Inc.

The software refresh's presentation surface -- what quake-2-ts calls swimp.c
and what src/platform/vid.ts's own header explains it already folds in for the
CLASSIC 8-bit framebuffer (VID_Init/VID_Update/VID_SetPalette do that whole
job through sdl.ts's SDLVID_Present). This module is the piece that fold did
not cover: presenting the TRUE-COLOR framebuffer `vid.buffer32` that U25's
colored lighting draws into (ARCHITECTURE.md ruling R3; the rasterizer side is
src/ref_soft/r_coloredlight.ts).

There is no WinQuake original. vid_x.c presents an 8-bit XImage through an
X11 colormap and has no 32-bit path at all.

TWO WAYS OUT TO THE WINDOW

1. RAW (what the frame actually is). `vid.buffer32` already holds exactly the
   bytes SDL's texture wants: src/platform/vid.ts's VID_SetPalette packs
   `d_8to24table` as `(255<<24) + (r<<0) + (g<<8) + (b<<16)`, which on a
   little-endian host is R,G,B,A in increasing address -- sdl.ts's
   SDL_PIXELFORMAT_ABGR8888 -- and every true-color write in the renderer
   packs its texels the same way. So the whole present is: apply the
   palette-shift ramps, then hand the bytes to SDL_UpdateTexture. That upload
   is the ONE primitive this module cannot reach: sdl.ts owns the texture and
   renderer handles, and sdl.ts is outside U25's SCOPE. `swimpRawPresent` is
   the seam for it -- whoever owns sdl.ts registers an uploader and this path
   lights up with no other change. The exact function that is wanted there is
   in this unit's report.

2. QUANTIZED (the fallback that runs until then, and the "15-bit path"
   ARCHITECTURE.md's software bullet already names). The frame is reduced to
   palette indices through a 32768-entry 5:5:5 nearest-color table and handed
   to the existing sdl.ts SDLVID_Present. gl_vidlinuxglx.c builds exactly
   this table (`d_15to8table`) by exactly this search, for exactly this
   reason -- an RGB frame that has to reach a paletted destination -- so the
   fallback is the C's own idea rather than an invention. Colored lighting
   survives it, quantized to 5 bits per channel.

   The table is built ONCE, from the base palette, and the palette-shift is
   NOT applied on this path: SDLVID_Present re-expands the indices through
   the live `d_8to24table`, which VID_ShiftPalette has already shifted. That
   is the same order of operations the classic 8-bit path uses, so a damage
   flash tints a quantized true-color frame the way it tints a classic one.
*/

import { d_8to24table } from "../client/vid";
import { SDLVID_Present } from "./sdl";

// The seam described in this file's header: an uploader that takes finished
// RGBA bytes (R,G,B,A per pixel, `width * height * 4` of them) straight to
// the window. Null until the module that owns the SDL texture registers one.
export const swimpRawPresent: { current: ((rgba: Uint8Array, width: number, height: number) => void) | null } = {
  current: null,
};

// staging buffers, allocated once per resolution and reused -- a present must
// not allocate per frame
let rgbaStage: Uint8Array = new Uint8Array(0);
let indexStage: Uint8Array = new Uint8Array(0);

// gl_vidlinuxglx.c's d_15to8table: 5:5:5 RGB -> nearest palette index
let d_15to8table: Uint8Array | null = null;

// d_8to24table's own bytes, the padded xRGB palette SDLVID_Present expects
// (src/platform/vid.ts's VID_SetPalette note); one view, reused
let paletteBytes: Uint8Array | null = null;

/*
================
SWimp_Build15to8Table

gl_vidlinuxglx.c's VID_Init tail, verbatim in shape: for every 5:5:5 color,
the palette index whose squared RGB distance is smallest.
================
*/
function SWimp_Build15to8Table(): Uint8Array {
  const table = new Uint8Array(1 << 15);
  const pr = new Int32Array(256);
  const pg = new Int32Array(256);
  const pb = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = d_8to24table[i];
    pr[i] = v & 0xff;
    pg[i] = (v >>> 8) & 0xff;
    pb[i] = (v >>> 16) & 0xff;
  }

  for (let i = 0; i < 1 << 15; i++) {
    // the 5-bit channel expanded back to 8 bits, as the C's
    // `((i & 0x1F) << 3)` does
    const r = (i & 0x1f) << 3;
    const g = ((i >> 5) & 0x1f) << 3;
    const b = ((i >> 10) & 0x1f) << 3;

    let best = 0;
    let bestdist = 0x7fffffff;
    for (let v = 0; v < 256; v++) {
      const dr = pr[v] - r;
      const dg = pg[v] - g;
      const db = pb[v] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestdist) {
        bestdist = dist;
        best = v;
        if (dist === 0) break;
      }
    }
    table[i] = best;
  }
  return table;
}

/*
================
SWimp_ResetForTests

Drops the cached staging buffers and the 5:5:5 table, so a suite that changes
the palette or the mode does not inherit the previous one's.
================
*/
export function SWimp_ResetForTests(): void {
  rgbaStage = new Uint8Array(0);
  indexStage = new Uint8Array(0);
  d_15to8table = null;
  paletteBytes = null;
}

/*
================
SWimp_ExpandFrame32

`buffer32` -> RGBA bytes, with the palette-shift ramps applied. `shiftramp`
is rState.d_shiftramp: three 256-entry ramps (r, then g, then b) that carry
V_UpdatePalette's cshift blends and gamma; null means the identity.
`rowbytes` may exceed `width`, as vid.rowbytes may.
================
*/
export function SWimp_ExpandFrame32(
  buffer32: Uint32Array,
  rowbytes: number,
  width: number,
  height: number,
  shiftramp: Uint8Array | null,
  out: Uint8Array,
): void {
  if (shiftramp === null) {
    for (let y = 0; y < height; y++) {
      let src = y * rowbytes;
      let dst = y * width * 4;
      for (let x = 0; x < width; x++) {
        const v = buffer32[src++];
        out[dst++] = v & 0xff;
        out[dst++] = (v >>> 8) & 0xff;
        out[dst++] = (v >>> 16) & 0xff;
        out[dst++] = 255;
      }
    }
    return;
  }

  for (let y = 0; y < height; y++) {
    let src = y * rowbytes;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const v = buffer32[src++];
      out[dst++] = shiftramp[v & 0xff];
      out[dst++] = shiftramp[256 + ((v >>> 8) & 0xff)];
      out[dst++] = shiftramp[512 + ((v >>> 16) & 0xff)];
      out[dst++] = 255;
    }
  }
}

/*
================
SWimp_QuantizeFrame32

`buffer32` -> palette indices through the 5:5:5 nearest-color table. No
palette-shift: see this file's header on why the shift belongs to
SDLVID_Present's own palette expansion on this path.
================
*/
export function SWimp_QuantizeFrame32(
  buffer32: Uint32Array,
  rowbytes: number,
  width: number,
  height: number,
  out: Uint8Array,
): void {
  if (d_15to8table === null) d_15to8table = SWimp_Build15to8Table();
  const table = d_15to8table;

  for (let y = 0; y < height; y++) {
    let src = y * rowbytes;
    let dst = y * width;
    for (let x = 0; x < width; x++) {
      const v = buffer32[src++];
      out[dst++] = table[((v & 0xf8) >> 3) | (((v >>> 8) & 0xf8) << 2) | (((v >>> 16) & 0xf8) << 7)];
    }
  }
}

/*
================
SWimp_Present32

The true-color present. See this file's header for the two paths.
================
*/
export function SWimp_Present32(
  buffer32: Uint32Array,
  rowbytes: number,
  width: number,
  height: number,
  shiftramp: Uint8Array | null,
): void {
  const raw = swimpRawPresent.current;

  if (raw !== null) {
    const need = width * height * 4;
    if (rgbaStage.length !== need) rgbaStage = new Uint8Array(need);
    SWimp_ExpandFrame32(buffer32, rowbytes, width, height, shiftramp, rgbaStage);
    raw(rgbaStage, width, height);
    return;
  }

  const need = width * height;
  if (indexStage.length !== need) indexStage = new Uint8Array(need);
  SWimp_QuantizeFrame32(buffer32, rowbytes, width, height, indexStage);
  // d_8to24table holds the base palette in true colour (P20: gamma and the
  // cshifts live in the present ramp), so the quantized fallback tints its
  // own copy of the palette through the ramp before handing it over.
  if (paletteBytes === null) paletteBytes = new Uint8Array(d_8to24table.buffer);
  SDLVID_Present(indexStage, width, width, height, shiftramp !== null ? SWimp_ShiftedPalette(paletteBytes, shiftramp) : paletteBytes);
}

let shiftedPalette: Uint8Array = new Uint8Array(0);

/** The 256-entry RGBA palette `base` (d_8to24table's bytes) with the present
 * ramp applied per channel -- what the quantized fallback shows. */
export function SWimp_ShiftedPalette(base: Uint8Array, shiftramp: Uint8Array): Uint8Array {
  if (shiftedPalette.length !== base.length) shiftedPalette = new Uint8Array(base.length);
  for (let i = 0; i < 256; i++) {
    shiftedPalette[i * 4] = shiftramp[base[i * 4]!]!;
    shiftedPalette[i * 4 + 1] = shiftramp[256 + base[i * 4 + 1]!]!;
    shiftedPalette[i * 4 + 2] = shiftramp[512 + base[i * 4 + 2]!]!;
    shiftedPalette[i * 4 + 3] = base[i * 4 + 3]!;
  }
  return shiftedPalette;
}
