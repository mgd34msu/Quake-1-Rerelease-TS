/*
Copyright (C) 1996-1997 Id Software, Inc.

Colored lighting for the software renderer (ARCHITECTURE.md ruling R3). There
is no WinQuake .c original for this file: WinQuake's rasterizer is 8-bit
paletted end to end, and none of Ironwail/vkQuake/QuakeSpasm keeps a software
renderer to port a colored path from, so this is the port's own subsystem and
gets its own module named for what it does (PORTING.md's "new subsystems get
their own modules" rule).

WHAT IT IS

`r_coloredlight` (default 1) turns on a TRUE-COLOR OUTPUT PATH that runs
beside the classic 8-bit one. It is active for a frame only when all three of
these hold:

  - `r_coloredlight` is non-zero,
  - the loaded world model carries RGB light samples (`lightdata_rgb`, from a
    `.lit` file or a BSPX RGBLIGHTING lump -- src/common/model.ts fills it),
  - the video backend gave `vid` a 32-bit framebuffer (`vid.buffer32`).

`rState.r_truecolor` records that decision once per frame in D_SetupFrame, so
every rasterizer in the frame agrees. When it is false NOTHING changes: the
8-bit surface cache, the 8-bit spans and the 8-bit framebuffer are the code
paths that run, byte for byte as before.

HOW A LIT TEXEL BECOMES A COLOR

The classic path shades a texel by picking a row of `vid.colormap` with the
lightmap's 8.8 light value and looking the texture's palette index up in it:
`colormap[(light & 0xff00) + pix]`. The colored path does exactly that THREE
TIMES, once per channel, with that channel's own light value, and takes one
channel of the palette color out of each lookup:

  r = d_8to24table[colormap[(lightR & 0xff00) + pix]]'s red byte
  g = d_8to24table[colormap[(lightG & 0xff00) + pix]]'s green byte
  b = d_8to24table[colormap[(lightB & 0xff00) + pix]]'s blue byte

That keeps the classic look exactly: the ramp a texel walks as it darkens is
still the palette's own ramp through gfx/colormap.lmp, including whatever the
colormap does at the fullbright end, rather than a linear multiply that would
wash the palette's hand-tuned shading out. And it makes the grey case
IDENTICAL by construction: when the three channel lights are equal, all three
lookups hit the same colormap entry, so the result is the classic 8-bit pixel
expanded through `d_8to24table` -- which is what
test/ref_soft_colored_light.test.ts asserts byte for byte.

Everything that is not a lit world texel is expanded through `d_8to24table`
untinted: the sky, sprites, particles, the solid-color background surface,
the 2D overlay (console/HUD/menus), and water/turbulent surfaces, which draw
their own texel colors as the C does.

Alias models take a scalar light per vertex, as in the C, and a per-entity
per-channel tint (`rState.r_alias_tint_*`, 8.8, 256 == untinted) built here
from the RGB light sampled under the entity. r_light.ts's `lightcolor` holds
that sample; `R_LightPoint`'s scalar return is the average of the three
channels, so an equal-channel sample leaves both the classic shadelight and
the tint exactly where they were.

PALETTE EFFECTS

view.c's V_UpdatePalette rebuilds the 256-entry palette through the cshift
blends (damage/bonus/quad/water) and the gamma table and hands it to
VID_ShiftPalette. In true color there is no palette to shift, but the C's
per-entry transform is CHANNEL-INDEPENDENT and defined for every 0..255 value,
not just the palette's, so it becomes three 256-entry ramps
(`rState.d_shiftramp`, r then g then b) that the present path applies to every
pixel. For a pixel that happens to be a palette color the result is exactly
the byte the shifted palette would have produced.
*/

import { CvarT } from "../common/cvar";
import { cl, NUM_CSHIFTS } from "../client/client";
import { vid } from "../client/vid";
import { rState } from "./r_shared";
import { lightcolor } from "./r_light";

export const r_coloredlight = new CvarT("r_coloredlight", "1");

/*
================
R_ColoredLightAvailable

The single predicate every part of the software renderer consults, so no two
of them can disagree about which output path a frame is on. See this file's
header for the three conditions.
================
*/
export function R_ColoredLightAvailable(): boolean {
  if (r_coloredlight.value === 0) return false;
  if (vid.buffer32 === null) return false;
  const worldmodel = cl.worldmodel;
  return worldmodel !== null && worldmodel.lightdata_rgb !== null;
}

/*
================
R_TintRGB

Multiplies a 32-bit texel by a per-channel 8.8 tint (256 == untinted) and
clamps each channel to 255. Used by the alias pipeline, the one place a
colored light is applied to an already-shaded pixel rather than to the
texel's own colormap lookup.
================
*/
export function R_TintRGB(base: number, tr: number, tg: number, tb: number): number {
  let r = ((base & 0xff) * tr) >> 8;
  let g = (((base >>> 8) & 0xff) * tg) >> 8;
  let b = (((base >>> 16) & 0xff) * tb) >> 8;
  if (r > 255) r = 255;
  if (g > 255) g = 255;
  if (b > 255) b = 255;
  return ((0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
}

/*
================
R_SetAliasLightTint

Turns the RGB light r_light.ts's R_LightPoint just sampled under an entity
into the three 8.8 tints the alias rasterizer multiplies its shaded pixels
by. The scalar shadelight the C computes is the average of the three
channels, so the tints are each channel over that average: all three are
exactly 256 whenever the sample has no color, which leaves an alias model on
a grey-lit map byte-identical to the classic path.
================
*/
export function R_SetAliasLightTint(): void {
  if (!rState.r_truecolor) {
    rState.r_alias_tint_r = 256;
    rState.r_alias_tint_g = 256;
    rState.r_alias_tint_b = 256;
    return;
  }

  const r = lightcolor[0];
  const g = lightcolor[1];
  const b = lightcolor[2];
  const avg = (r + g + b) / 3;
  if (avg <= 0) {
    rState.r_alias_tint_r = 256;
    rState.r_alias_tint_g = 256;
    rState.r_alias_tint_b = 256;
    return;
  }

  rState.r_alias_tint_r = ((r * 256) / avg) | 0;
  rState.r_alias_tint_g = ((g * 256) / avg) | 0;
  rState.r_alias_tint_b = ((b * 256) / avg) | 0;
}

/*
================
R_BuildShiftRamps

V_UpdatePalette's per-entry transform, lifted off the palette and onto the
0..255 range so it can be applied to a true-color pixel. `cshifts` is the
NUM_CSHIFTS x (percent, destcolor[3]) list view.c already walks; `gammatable`
is view.c's. Writes three 256-entry ramps into `out` (r, then g, then b).
================
*/
export function R_BuildShiftRamps(gammatable: Uint8Array, out: Uint8Array): void {
  for (let ch = 0; ch < 3; ch++) {
    const base = ch * 256;
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < NUM_CSHIFTS; j++) {
        c += (cl.cshifts[j].percent * (cl.cshifts[j].destcolor[ch] - c)) >> 8;
      }
      // the 8-bit V_UpdatePalette indexes gammatable with the unclamped sum
      // because a real basepal entry blended toward a real destcolor cannot
      // leave 0..255; the ramp covers every 0..255 input, so it clamps
      // rather than reading past the table
      if (c < 0) c = 0;
      else if (c > 255) c = 255;
      out[base + i] = gammatable[c];
    }
  }
}
