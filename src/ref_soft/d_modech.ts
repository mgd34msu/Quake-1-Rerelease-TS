/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_modech.c (GNU GPL v2 or later).

// d_modech.c: called when mode has just changed

Deviations from PORTING.md / the C source:
- d_modech.c DEFINES `d_vrectx`, `d_vrecty`, `d_vrectright_particle`,
  `d_vrectbottom_particle`, `d_y_aspect_shift`, `d_pix_min`, `d_pix_max`,
  `d_pix_shift`, `d_scantable[MAXHEIGHT]` and `zspantable[MAXHEIGHT]`. Every
  one of the scalars is reassigned by D_ViewChanged, so PORTING.md's holder
  rule keeps them on `rState` (r_shared.ts, `// d_modech.c` heading); the two
  tables are `Int32Array(MAXHEIGHT)` in d_local.ts and D_ViewChanged fills
  them through `buildScantable` / `buildZspantable`, which are that file's
  spelling of this function's final loop.
- `zspantable[i] = d_pzbuffer + i*d_zwidth` holds a `short *`; the port stores
  the ELEMENT offset `i*d_zwidth`, so `zspantable[v] + u` indexes
  `rState.d_pzbuffer` exactly as `zspantable[v][u]` did.
- `d_pix_min = r_refdef.vrect.width / 320` is C integer division; `| 0` after
  the divide reproduces the truncation. `(int)(... + 0.5)` likewise truncates
  toward zero, which is what `| 0` does for the non-negative values here.
- Dropped `#if id386` branch: D_Patch's whole body, which calls
  Sys_MakeCodeWriteable on D_PolysetAff8Start/End so the x86 self-modifying
  polygon drawer can be patched. On every other processor D_Patch is empty,
  and PORTING.md ports the id386 == 0 path.
*/

import { buildScantable, buildZspantable, d_scantable, zspantable } from "./d_local";
import { WARP_WIDTH } from "./d_iface";
import { r_refdef, rState } from "./r_shared";
import { vid } from "../client/vid";

export { d_scantable, zspantable };

/*
================
D_Patch
================
*/
export function D_Patch(): void {
  // id386-only: patches the self-modifying x86 affine polygon drawer
}

/*
================
D_ViewChanged
================
*/
export function D_ViewChanged(): void {
  let rowbytes: number;

  if (rState.r_dowarp) rowbytes = WARP_WIDTH;
  else rowbytes = vid.rowbytes;

  rState.scale_for_mip = rState.xscale;
  if (rState.yscale > rState.xscale) rState.scale_for_mip = rState.yscale;

  rState.d_zrowbytes = vid.width * 2;
  rState.d_zwidth = vid.width;

  rState.d_pix_min = (r_refdef.vrect.width / 320) | 0;
  if (rState.d_pix_min < 1) rState.d_pix_min = 1;

  rState.d_pix_max = (r_refdef.vrect.width / (320.0 / 4.0) + 0.5) | 0;
  rState.d_pix_shift = 8 - ((r_refdef.vrect.width / 320.0 + 0.5) | 0);
  if (rState.d_pix_max < 1) rState.d_pix_max = 1;

  if (rState.pixelAspect > 1.4) rState.d_y_aspect_shift = 1;
  else rState.d_y_aspect_shift = 0;

  rState.d_vrectx = r_refdef.vrect.x;
  rState.d_vrecty = r_refdef.vrect.y;
  rState.d_vrectright_particle = r_refdef.vrectright - rState.d_pix_max;
  rState.d_vrectbottom_particle = r_refdef.vrectbottom - (rState.d_pix_max << rState.d_y_aspect_shift);

  {
    buildScantable(vid.height, rowbytes);
    buildZspantable(vid.height, rState.d_zwidth);
  }

  D_Patch();
}
