/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_init.c (GNU GPL v2 or later).

// d_init.c: rasterization driver initialization

Deviations from PORTING.md / the C source:
- `void (*d_drawspans) (espan_t *pspan)` is a reassigned function pointer, so
  PORTING.md's holder rule puts it on the exported `drawspansState` object;
  d_edge.ts's D_DrawSurfaces reads it there.
- `d_initial_rover` and `d_roverwrapped` are defined here in C but name
  `surfcache_t`, so d_local.ts's `dState` carries them alongside the rest of
  the surface-cache state. `d_minmip` is on `rState`, `d_scalemip[]` is
  d_local.ts's Float32Array, and `d_aflatcolor` is d_polyse.ts's
  `polyState.d_aflatcolor`.
- `D_EnableBackBufferAccess` / `D_DisableBackBufferAccess` call
  `VID_LockBuffer` / `VID_UnlockBuffer`, which are methods on
  src/client/vid.ts's `VidBackend`; with no backend installed (a dedicated
  server, or a test) they are the no-ops the C's non-Win32 macro expansions
  are.
- `d_viewbuffer = (void *)(byte *)vid.buffer` becomes the Uint8Array itself.
- U25 (no C original): D_SetupFrame makes the frame's one colored-lighting
  decision -- `rState.r_truecolor` -- and points `rState.d_viewbuffer32` at
  the 32-bit framebuffer (or the 32-bit warp buffer) when it is set. Because a
  surface-cache block holds either palette indices or 32-bit texels but never
  both, a change in that decision between frames flushes the caches here,
  which is the same thing vid_x.c's ResetFrameBuffer does when the pixel
  format underneath the cache changes.
- D_CopyRects and D_UpdateRects keep the C's parameters even though both
  bodies are `UNUSED(...)`; `void x;` is this port's spelling of that macro.
- `d_minmip = d_mipcap.value` truncates a float cvar to an int; `| 0` does the
  same.
- Dropped `#if id386` branch: D_SetupFrame's `d_drawspans = d_subdiv16.value ?
  D_DrawSpans16 : D_DrawSpans8`. D_DrawSpans16 exists only as x86 assembly
  (d_draw16.s), which PORTING.md does not port, and the `#else` half of that
  same `#if` assigns D_DrawSpans8 unconditionally. `d_subdiv16` is still
  registered, because the cvar is user-visible and archived in config.cfg
  either way.
*/

import { Cvar_RegisterVariable, CvarT } from "../common/cvar";
import { type VrectT, vid, vidBackend } from "../client/vid";
import { WARP_WIDTH } from "./d_iface";
import { d_scalemip, dState } from "./d_local";
import { type EspanT, rState } from "./r_shared";
import { D_DrawSpans32, D_DrawSpans8 } from "./d_scan";
import { polyState } from "./d_polyse";
import { R_ColoredLightAvailable } from "./r_coloredlight";
import { D_FlushCaches } from "./d_surf";

const NUM_MIPS = 4;

export const d_subdiv16 = new CvarT("d_subdiv16", "1");
export const d_mipcap = new CvarT("d_mipcap", "0");
export const d_mipscale = new CvarT("d_mipscale", "1");

const basemip: Float32Array = new Float32Array([1.0, 0.5 * 0.8, 0.25 * 0.8]);

export const drawspansState: { d_drawspans: ((pspan: EspanT | null) => void) | null } = {
  d_drawspans: null,
};

/*
===============
D_Init
===============
*/
export function D_Init(): void {
  rState.r_skydirect = 1;

  Cvar_RegisterVariable(d_subdiv16);
  Cvar_RegisterVariable(d_mipcap);
  Cvar_RegisterVariable(d_mipscale);

  rState.r_drawpolys = false;
  rState.r_worldpolysbacktofront = false;
  rState.r_recursiveaffinetriangles = true;
  rState.r_pixbytes = 1;
  rState.r_aliasuvscale = 1.0;
}

/*
===============
D_CopyRects
===============
*/
export function D_CopyRects(prects: VrectT | null, transparent: number): void {
  void prects;
  void transparent;

  // this function is only required if the CPU doesn't have direct access to the
  // back buffer, and there's some driver interface function that the driver
  // doesn't support and requires Quake to do in software (such as drawing the
  // console); Quake will then draw into wherever the driver points vid.buffer
  // and will call this function before swapping buffers
}

/*
===============
D_EnableBackBufferAccess
===============
*/
export function D_EnableBackBufferAccess(): void {
  const backend = vidBackend.current;
  if (backend !== null) backend.VID_LockBuffer();
}

/*
===============
D_TurnZOn
===============
*/
export function D_TurnZOn(): void {
  // not needed for software version
}

/*
===============
D_DisableBackBufferAccess
===============
*/
export function D_DisableBackBufferAccess(): void {
  const backend = vidBackend.current;
  if (backend !== null) backend.VID_UnlockBuffer();
}

/*
===============
D_SetupFrame
===============
*/
export function D_SetupFrame(): void {
  // U25: the frame's one colored-lighting decision (see this file's header
  // and src/ref_soft/r_coloredlight.ts's)
  const truecolor = R_ColoredLightAvailable();
  if (truecolor !== rState.r_truecolor) {
    rState.r_truecolor = truecolor;
    D_FlushCaches();
  }

  if (rState.r_dowarp) rState.d_viewbuffer = rState.r_warpbuffer;
  else rState.d_viewbuffer = vid.buffer;

  if (!truecolor) rState.d_viewbuffer32 = null;
  else if (rState.r_dowarp) rState.d_viewbuffer32 = rState.r_warpbuffer32;
  else rState.d_viewbuffer32 = vid.buffer32;

  if (rState.r_dowarp) rState.screenwidth = WARP_WIDTH;
  else rState.screenwidth = vid.rowbytes;

  dState.d_roverwrapped = false;
  dState.d_initial_rover = dState.sc_rover;

  rState.d_minmip = d_mipcap.value | 0;
  if (rState.d_minmip > 3) rState.d_minmip = 3;
  else if (rState.d_minmip < 0) rState.d_minmip = 0;

  for (let i = 0; i < NUM_MIPS - 1; i++) d_scalemip[i] = basemip[i] * d_mipscale.value;

  drawspansState.d_drawspans = rState.r_truecolor ? D_DrawSpans32 : D_DrawSpans8;

  polyState.d_aflatcolor = 0;
}

/*
===============
D_UpdateRects
===============
*/
export function D_UpdateRects(prect: VrectT | null): void {
  void prect;

  // the software driver draws these directly to the vid buffer
}
