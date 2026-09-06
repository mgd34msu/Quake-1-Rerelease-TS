/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/vid.h (GNU GPL v2 or later).

vid.h -- video driver defs

Deviations from PORTING.md / the C source:
- `vrect_t` -> `VrectT`, `viddef_t` -> `ViddefT`: classes with every field
  initialised, per the "C structs -> class" rule. `vid` is the exported
  singleton (PORTING.md's "Shared mutable globals ... become exported `const`
  singleton objects mutated in place").
- `pixel_t` is `typedef byte pixel_t;` and every `pixel_t *` in viddef_t is a
  pointer into an 8-bit framebuffer, so each becomes `Uint8Array | null`. No
  `PixelT` alias is exported: a lone `number` alias would carry no information
  the C's `byte` typedef in quakedef.ts does not already carry.
- `d_8to16table`/`d_8to24table` are declared `extern` here and defined by the
  video backend (vid_win.c, gl_vidnt.c, gl_vidlinuxglx.c ...). The backend in
  this port is src/platform/vid.ts, which cannot reassign another module's
  binding, so the two tables are allocated here once and filled in place. Same
  rule PORTING.md applies to `vid` itself.
- `extern void (*vid_menudrawfn)(void);` / `(*vid_menukeyfn)(int key)` are
  declared here but DEFINED in menu.c and ASSIGNED by the video backend
  (vid_win.c's `vid_menudrawfn = VID_MenuDraw;`). Two modules write them and a
  third reads them, and an ESM import binding cannot be assigned through, so
  they become the `vidMenuHooks` holder here (PORTING.md: "C globals that are
  reassigned pointers ... become ... a small exported holder with a setter").
  src/client/menu.ts (U049) reads them; src/platform/vid.ts (U056) sets them.
- `VID_*` become the `VidBackend` interface plus the `vidBackend` holder rather
  than free functions, because this port selects the backend at runtime
  (PORTING.md, "Runtime and build": the `vid_ref` cvar). src/platform/vid.ts
  implements it. `D_BeginDirectRect`/`D_EndDirectRect` are declared in
  d_iface.h, not vid.h, but every implementation of them lives in a vid_*.c /
  gl_vid*.c video backend, so they are members of VidBackend here; draw.c's
  `Draw_BeginDisc`/`Draw_EndDisc` are the only callers.
- Not ported here, with the module that owns each:
  `VID_ForceLockState`/`VID_ForceMode`/`VID_SetDefaultMode` (winquake.h, called
  only from sys_win.c and vid_win.c internals -- the DOS/Win32 platform files
  PORTING.md does not port), and `vid_mode_t`/`vid_modenum`/`vid_default`,
  which vid.h never declares: they are vid_win.c/vid_dos.c file scope.
*/

// a pixel can be one, two, or four bytes
export const VID_CBITS = 6;
export const VID_GRADES = 1 << VID_CBITS;

export class VrectT {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  pnext: VrectT | null = null;
}

export class ViddefT {
  buffer: Uint8Array | null = null; // invisible buffer
  colormap: Uint8Array | null = null; // 256 * VID_GRADES size
  colormap16: Uint16Array | null = null; // 256 * VID_GRADES size
  fullbright = 0; // index of first fullbright color
  rowbytes = 0; // may be > width if displayed in a window
  width = 0;
  height = 0;
  aspect = 0; // width / height -- < 0 is taller than wide
  numpages = 0;
  recalc_refdef = 0; // if true, recalc vid-based stuff
  conbuffer: Uint8Array | null = null;
  conrowbytes = 0;
  conwidth = 0;
  conheight = 0;
  maxwarpwidth = 0;
  maxwarpheight = 0;
  direct: Uint8Array | null = null; // direct drawing to framebuffer, if not
  //  NULL
}

export const vid = new ViddefT(); // global video state

export const d_8to16table = new Uint16Array(256);
export const d_8to24table = new Uint32Array(256);

export const vidMenuHooks: {
  vid_menudrawfn: (() => void) | null;
  vid_menukeyfn: ((key: number) => void) | null;
} = { vid_menudrawfn: null, vid_menukeyfn: null };

export interface VidBackend {
  // called at startup and after any gamma correction
  VID_SetPalette(palette: Uint8Array): void;

  // called for bonus and pain flashes, and for underwater color changes
  VID_ShiftPalette(palette: Uint8Array): void;

  // Called at startup to set up translation tables, takes 256 8 bit RGB values
  // the palette data will go away after the call, so it must be copied off if
  // the video driver will need it again
  VID_Init(palette: Uint8Array): void;

  // Called at shutdown
  VID_Shutdown(): void;

  // flushes the given rectangles from the view buffer to the screen
  VID_Update(rects: VrectT | null): void;

  // sets the mode; only used by the Quake engine for resetting to mode 0 (the
  // base mode) on memory allocation failures
  VID_SetMode(modenum: number, palette: Uint8Array): number;

  // called only on Win32, when pause happens, so the mouse can be released
  VID_HandlePause(pause: boolean): void;

  // quakedef.h: real functions on Win32, empty macros everywhere else.
  // screen.c brackets V_RenderView with them.
  VID_LockBuffer(): void;
  VID_UnlockBuffer(): void;

  // d_iface.h; every implementation is in a vid_*.c / gl_vid*.c backend.
  // draw.c's Draw_BeginDisc/Draw_EndDisc are the callers.
  D_BeginDirectRect(x: number, y: number, pbitmap: Uint8Array, width: number, height: number): void;
  D_EndDirectRect(x: number, y: number, width: number, height: number): void;
}

export const vidBackend: { current: VidBackend | null } = { current: null };
