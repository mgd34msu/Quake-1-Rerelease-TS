/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_vidlinuxglx.c (GNU GPL v2 or later): the GL-side half
of that file -- GL_Init, CheckMultiTextureExtensions, GL_BeginRendering,
GL_EndRendering, VID_Init8bitPalette, VID_Is8bit, VID_SetPalette (the GL one,
which additionally builds `d_15to8table`), `is8bit`, `isPermedia`, and the
GL-specific tail of VID_Init.

gl_vidlinuxglx.c is one C file that this port splits in two, exactly as
PORTING.md's file table says ("gl_vidnt/gl_vidlinux/gl_vidlinuxglx ->
src/platform/vid.ts + swimp.ts + glimp.ts"): everything that talks to X11/GLX
(the display, the window, the visual, the XF86VidMode switch, the pointer and
keyboard grabs, the event pump) is src/platform/sdl.ts + src/platform/glimp.ts
+ src/platform/vid.ts, and everything that talks to OpenGL is here. glquake.h's
OWNERSHIP block assigns this file's globals (texture_extension_number,
texture_mode, gldepthmin, gldepthmax, gl_mtexable, gl_vendor/gl_renderer/
gl_version/gl_extensions, gl_ztrick, is8bit, isPermedia) to this unit; the
first nine live on glquake.ts's `glState` holder, `is8bit`/`isPermedia` here,
and `gl_ztrick` in gl_rmain.ts (see the deviation note below).

VID_Init's own split, and where each of its lines ended up:
  Cvar_RegisterVariable (vid_mode/in_mouse/in_dgamouse/m_filter)
                                        src/platform/vid.ts, src/platform/sdl.ts
  Cvar_RegisterVariable (gl_ztrick)     src/ref_gl/ref_gl.ts's
                                        registerRenderer("gl") factory, which
                                        is GL_VidInit's caller (see below)
  vid.maxwarpwidth/maxwarpheight        src/platform/vid.ts's VID_Init
  vid.colormap / vid.fullbright         src/platform/vid.ts's VID_Init
  -window/-width/-height/-conwidth/
    -conheight parsing                  src/platform/vid.ts's resolveMode
  XOpenDisplay .. glXMakeCurrent        src/platform/glimp.ts's GLimp_SetMode
  scr_width/scr_height                  vid.width/vid.height (see
                                        GL_BeginRendering below)
  vid.width/vid.height/conwidth/
    conheight                           src/platform/vid.ts's VID_CheckChanges
  vid.aspect, vid.numpages = 2          GL_VidInit, below
  InitSig()                             not ported (src/platform/sys.ts owns
                                        signal handling; sys_linux.c's own
                                        InitSig is the copy that survives)
  GL_Init()                             GL_VidInit, below
  Sys_mkdir("%s/glquake")               GL_VidInit, below
  VID_SetPalette(palette)               GL_VidInit, below
  VID_Init8bitPalette()                 GL_VidInit, below
  Con_SafePrintf("Video mode ...")      GL_VidInit, below
  vid.recalc_refdef = 1                 GL_VidInit, below

Deviations from PORTING.md / the C source:
- `GL_VidInit` is the name this port gives the GL-only tail of VID_Init listed
  above; the C has no such function, because in the C the two halves are one
  function in one file. It is called from src/ref_gl/ref_gl.ts's
  `registerRenderer("gl", ...)` factory, which src/platform/vid.ts's
  VID_CheckChanges invokes at exactly the point gl_vidlinuxglx.c's VID_Init
  reaches this tail: after glXMakeCurrent (glimpHolder.current is live) and
  before host.c's Draw_Init/SCR_Init/R_Init, which is the order GL_Init must
  run in -- gl_draw.c's Draw_Init issues GL calls.
- The C's GL entry points are libGL's link-time symbols, resolved once by the
  dynamic linker when the process starts. Here they come from qgl.ts's table,
  so GL_VidInit loads it (`loadQGLFromSystem(glimp.GetProcAddress)`) before
  the first GL call, and loads it only when `qglHolder.current` is still null
  -- one resolve per process, as in the C. src/platform/vid.ts has no
  renderer-teardown hook (see its own "WHY THERE IS NO Renderer.Shutdown"
  header note), so nothing calls `QGL_Shutdown` on a switch back to `vid_ref
  soft`; reported as a follow-up.
- `GL_BeginRendering (int *x, int *y, int *width, int *height)` takes four
  out-parameters that gl_screen.c passes `&glx, &gly, &glwidth, &glheight`
  to. Those four are glquake.ts's `glState` fields here, so the port writes
  them directly and takes no arguments. The C's `scr_width`/`scr_height` are
  gl_vidlinuxglx.c's own copies of the window size it created; this port's
  window size is `vid.width`/`vid.height` (src/platform/vid.ts's
  VID_CheckChanges assigns both from the same resolved mode, and unlike
  gl_vidlinuxglx.c it does not decouple vid.width from the window through
  `-conwidth`), so those are what GL_BeginRendering publishes.
- `GL_EndRendering`'s `glXSwapBuffers (dpy, win)` is glimp.ts's
  `GLimp_EndFrame` (SDL_GL_SwapWindow); the `dpy`/`win` it needs live there.
- VID_Init8bitPalette's first branch (`3DFX_set_global_palette` +
  `qgl3DfxSetPaletteEXT`) is DROPPED: qgl.ts's table has no
  `qgl3DfxSetPaletteEXT` member, and adding one is outside this unit's SCOPE.
  Only the second branch (`GL_EXT_shared_texture_palette` +
  `qglColorTableEXT`) is ported. Reported as a follow-up; the dropped branch
  is 3dfx Voodoo Graphics-only hardware support.
- The `dlopen(NULL, RTLD_LAZY)` / `dlclose` bracket around both
  CheckMultiTextureExtensions and VID_Init8bitPalette, and the two
  `Con_Printf("Unable to open symbol list for main program.\n")` early
  returns that go with it, have no counterpart: qgl.ts resolves every
  extension entry point once at load time and exposes each as a `| null`
  member, so the "did dlsym find it" test the C writes as `(qglColorTableEXT
  = dlsym(...)) != NULL` is written here as `qglColorTableEXT !== null`.
- `gl_vendor`/`gl_renderer`/`gl_version`/`gl_extensions` are `const char *`
  in the C, straight out of glGetString. qgl.ts's `qglGetString` returns the
  raw pointer, so `glGetStringText` below reads the C string off it (bun:ffi's
  CString, the same FFI boundary qgl.ts itself is built on) and stores a JS
  string; a NULL return (no context current) becomes "", which is what every
  `strstr` on it here treats the same way the C would have crashed on. The C
  would dereference NULL; this port cannot.
- `d_15to8table` is declared `unsigned char d_15to8table[65536]` in
  gl_vidlinuxglx.c and read only by gl_draw.c's GL_MipMap8Bit. src/client/vid.ts
  holds d_8to16table/d_8to24table (vid.h declares those two); d_15to8table is
  not in vid.h, so it lives here with the VID_SetPalette that fills it.
- `VID_SetPalette` here is gl_vidlinuxglx.c's, NOT src/platform/vid.ts's: the
  two C files each define their own, and this one additionally masks index
  255's alpha (`d_8to24table[255] &= 0xffffff`, "255 is transparent" for GL
  texture uploads) and builds d_15to8table. It runs at GL bring-up, after
  src/platform/vid.ts's own VID_SetPalette has already filled d_8to24table
  from the same palette, which is the order host.c + VID_Init have in the C.
  Follow-up: the alpha mask survives a later `vid_ref gl` -> `vid_ref soft`
  switch, where src/platform/vid.ts's VID_Update would present palette index
  255 with a zero alpha byte.
- `gl_ztrick` is declared by gl_rmain.c and DEFINED by gl_vidlinuxglx.c, i.e.
  by this file. It is NOT defined here: gl_rmain.c's R_Clear is its only
  reader, and gl_rmain.ts (U072) already defines the `cvar_t` so that reader
  needs no import back into this file. Importing it here for the one
  `Cvar_RegisterVariable (&gl_ztrick)` line would close a cycle (gl_vid.ts ->
  gl_rmain.ts -> gl_rsurf.ts -> gl_vid.ts, for `isPermedia`), so that one line
  of VID_Init lives in ref_gl.ts's factory instead, immediately before its
  `GL_VidInit()` call -- the same position VID_Init has it in.
- `vid_mode` is declared by gl_vidlinuxglx.c and registered by its VID_Init,
  but src/platform/vid.ts already defines and registers a `vid_mode` cvar
  (its index into VID_MODES). One cvar of that name, and it is the platform's;
  not redefined here.
- `isPermedia` is `qboolean isPermedia = false;` here and is assigned `true`
  only by gl_vidnt.c (the Win32 backend this port does not take), so it is an
  exported `const` rather than a holder field. gl_rsurf.c:1602 is its only
  reader.
- `is8bit` IS reassigned (VID_Init8bitPalette sets it), and gl_draw.c /
  gl_rmisc.c read it only through `VID_Is8bit()`, so the accessor is exported
  and the variable stays module-private, exactly as in the C.
- Dropped `#ifdef`/platform branches: everything X11 (XLateKey,
  CreateNullCursor, install_grabs/uninstall_grabs, HandleEvents,
  IN_ActivateMouse/IN_DeactivateMouse, VID_Shutdown's GLX teardown,
  signal_handler/InitSig, Sys_SendKeyEvents, Force_CenterView_f, IN_Init,
  IN_Shutdown, IN_Commands, IN_MouseMove, IN_Move) belongs to
  src/platform/sdl.ts and src/client/input.ts and is not ported here.
  `Check_Gamma` is `static` and DEAD in v1.09 -- no caller anywhere in
  gl_vidlinuxglx.c or the rest of the tree -- and view.c's BuildGammaTable
  (src/client/view.ts) is the gamma path this port actually uses; it is not
  ported. `VID_ShiftPalette` here is an EMPTY body in the C (its one line is
  commented out); src/platform/vid.ts's VidBackend already supplies the
  VID_ShiftPalette the client calls, so this file adds nothing.
*/

import { CString } from "bun:ffi";
import { Con_DPrintf, Con_Printf, Con_SafePrintf } from "../client/console";
import { cmdHost } from "../common/cmd";
import { COM_CheckParm, com_gamedir } from "../common/common";
import { hostBasepal } from "../common/host";
import { qw } from "../common/quakedef";
// host.c's `byte *host_basepal` is one global; this port has two holders for
// it -- src/common/host.ts on the WinQuake track, and src/qw/client/cl_main.ts
// on the qwcl one, whose own Host_Init is what loads gfx/palette.lmp there.
// Resolved exactly as src/platform/vid.ts resolves `host_colormap`.


import { Sys_Error, Sys_mkdir } from "../platform/sys";
import { d_8to24table, vid } from "../client/vid";
import { glimpHolder } from "../platform/glimp";
import { glState } from "./glquake";
import {
  GL_ALPHA_TEST,
  GL_EXTENSIONS,
  GL_FILL,
  GL_FLAT,
  GL_FRONT,
  GL_FRONT_AND_BACK,
  GL_GREATER,
  GL_NEAREST,
  GL_ONE_MINUS_SRC_ALPHA,
  GL_RENDERER,
  GL_REPEAT,
  GL_REPLACE,
  GL_RGB,
  GL_SHARED_TEXTURE_PALETTE_EXT,
  GL_SRC_ALPHA,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_WRAP_S,
  GL_TEXTURE_WRAP_T,
  GL_UNSIGNED_BYTE,
  GL_VENDOR,
  GL_VERSION,
  loadQGLFromSystem,
  qgl,
  qglHolder,
} from "./qgl";

export const d_15to8table = new Uint8Array(65536);

// This port's own bookkeeping (see ref_gl.ts's Renderer.Shutdown): below,
// VID_SetPalette does gl_vidlinuxglx.c's `d_8to24table[255] &= 0xffffff`
// ("255 is transparent" for GL), which the software present path cannot use
// (it needs entry 255's real alpha byte back). This holds the pre-mask value
// from the most recent VID_SetPalette call so Shutdown can restore it.
export const glVidPaletteState: { preMaskAlpha255: number } = { preMaskAlpha255: 0xff000000 };

let is8bit = false;

export const isPermedia: boolean = false;

export function VID_Is8bit(): boolean {
  return is8bit;
}

// see the header note: qglGetString hands back the `const char *` glGetString
// returned, and this is the read of it the C gets for free from its own
// `const char *` globals.
function glGetStringText(name: number): string {
  const p = qgl().qglGetString(name);
  if (p === null) return "";
  return new CString(p).toString();
}

export function VID_SetPalette(palette: Uint8Array): void {
  let r: number;
  let g: number;
  let b: number;
  let v: number;
  let r1: number;
  let g1: number;
  let b1: number;
  let k: number;
  let i: number;
  let dist: number;
  let bestdist: number;

  //
  // 8 8 8 encoding
  //
  let palIdx = 0;
  const table = d_8to24table;
  for (i = 0; i < 256; i++) {
    r = palette[palIdx + 0];
    g = palette[palIdx + 1];
    b = palette[palIdx + 2];
    palIdx += 3;

    v = (255 << 24) + (r << 0) + (g << 8) + (b << 16);
    table[i] = v;
  }
  glVidPaletteState.preMaskAlpha255 = d_8to24table[255];
  d_8to24table[255] &= 0xffffff; // 255 is transparent

  const pal = new Uint8Array(d_8to24table.buffer);

  for (i = 0; i < 1 << 15; i++) {
    /* Maps
    000000000000000
    000000000011111 = Red  = 0x1F
    000001111100000 = Blue = 0x03E0
    111110000000000 = Grn  = 0x7C00
    */
    r = ((i & 0x1f) << 3) + 4;
    g = ((i & 0x03e0) >> 2) + 4;
    b = ((i & 0x7c00) >> 7) + 4;
    let palByte = 0;
    for (v = 0, k = 0, bestdist = 10000 * 10000; v < 256; v++, palByte += 4) {
      r1 = r - pal[palByte + 0];
      g1 = g - pal[palByte + 1];
      b1 = b - pal[palByte + 2];
      dist = r1 * r1 + g1 * g1 + b1 * b1;
      if (dist < bestdist) {
        k = v;
        bestdist = dist;
      }
    }
    d_15to8table[i] = k;
  }
}

export function CheckMultiTextureExtensions(): void {
  if (glState.gl_extensions.includes("GL_SGIS_multitexture ") && !COM_CheckParm("-nomtex")) {
    Con_Printf("Found GL_SGIS_multitexture...\n");

    const gl = qgl();

    if (gl.qglMTexCoord2fSGIS && gl.qglSelectTextureSGIS) {
      Con_Printf("Multitexture extensions found.\n");
      glState.gl_mtexable = true;
    } else Con_Printf("Symbol not found, disabled.\n");
  }
}

/*
The four glGetString banner lines. GLQuake prints them once: the C reaches
GL_Init only from VID_Init, which runs once at startup (GLQUAKE is a
compile-time #define and the GLX context is created exactly once, with no
runtime way back into this function). This port's `vid_restart` and the video
menu's Apply DO re-enter GL_Init, and re-printing GL_EXTENSIONS there dumps
the whole extension string -- three rows of the notify overlay -- over the
frame after every Apply. Past host_initialized (cmdHost.initialized, this
port's host_initialized), the four lines therefore drop to Con_DPrintf: still
in the log under `developer 1`, no longer painted over the game.
*/
function GL_PrintBanner(fmt: string, value: string): void {
  if (cmdHost.initialized) Con_DPrintf(fmt, value);
  else Con_Printf(fmt, value);
}

/*
===============
GL_Init
===============
*/
export function GL_Init(): void {
  const gl = qgl();

  glState.gl_vendor = glGetStringText(GL_VENDOR);
  GL_PrintBanner("GL_VENDOR: %s\n", glState.gl_vendor);
  glState.gl_renderer = glGetStringText(GL_RENDERER);
  GL_PrintBanner("GL_RENDERER: %s\n", glState.gl_renderer);

  glState.gl_version = glGetStringText(GL_VERSION);
  GL_PrintBanner("GL_VERSION: %s\n", glState.gl_version);
  glState.gl_extensions = glGetStringText(GL_EXTENSIONS);
  GL_PrintBanner("GL_EXTENSIONS: %s\n", glState.gl_extensions);

  CheckMultiTextureExtensions();

  gl.qglClearColor(1, 0, 0, 0);
  gl.qglCullFace(GL_FRONT);
  gl.qglEnable(GL_TEXTURE_2D);

  gl.qglEnable(GL_ALPHA_TEST);
  gl.qglAlphaFunc(GL_GREATER, 0.666);

  gl.qglPolygonMode(GL_FRONT_AND_BACK, GL_FILL);
  gl.qglShadeModel(GL_FLAT);

  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
  gl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);

  gl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

  gl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
}

/*
=================
GL_BeginRendering

=================
*/
export function GL_BeginRendering(): void {
  glState.glx = glState.gly = 0;
  glState.glwidth = vid.width;
  glState.glheight = vid.height;
}

export function GL_EndRendering(): void {
  qgl().qglFlush();
  glimpHolder.current?.EndFrame();
}

export function VID_Init8bitPalette(): void {
  // Check for 8bit Extensions and initialize them.
  let i: number;

  const gl = qgl();
  const qglColorTableEXT = gl.qglColorTableEXT;

  if (glState.gl_extensions.includes("GL_EXT_shared_texture_palette") && qglColorTableEXT !== null) {
    const thePalette = new Uint8Array(256 * 3);

    Con_SafePrintf("8-bit GL extensions enabled.\n");
    gl.qglEnable(GL_SHARED_TEXTURE_PALETTE_EXT);
    const oldPalette = new Uint8Array(d_8to24table.buffer); // d_8to24table3dfx;
    let oldIdx = 0;
    let newIdx = 0;
    for (i = 0; i < 256; i++) {
      thePalette[newIdx++] = oldPalette[oldIdx++];
      thePalette[newIdx++] = oldPalette[oldIdx++];
      thePalette[newIdx++] = oldPalette[oldIdx++];
      oldIdx++;
    }
    qglColorTableEXT(GL_SHARED_TEXTURE_PALETTE_EXT, GL_RGB, 256, GL_RGB, GL_UNSIGNED_BYTE, thePalette);
    is8bit = true;
  }
}

/*
===============
GL_VidInit

gl_vidlinuxglx.c's VID_Init, minus everything src/platform owns -- see this
file's header for the line-by-line split.
===============
*/
export function GL_VidInit(): void {
  const glimp = glimpHolder.current;
  if (!glimp) Sys_Error("GL_VidInit: no GL context");

  if (!qglHolder.current) qglHolder.current = loadQGLFromSystem(glimp.GetProcAddress);

  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);
  vid.numpages = 2;

  GL_Init();

  const gldir = `${com_gamedir}/glquake`;
  Sys_mkdir(gldir);

  const palette = hostBasepal();
  if (palette) VID_SetPalette(palette);

  // Check for 3DFX Extensions and initialize them.
  VID_Init8bitPalette();

  Con_SafePrintf("Video mode %dx%d initialized.\n", vid.width, vid.height);

  vid.recalc_refdef = 1; // force a surface cache flush
}

// test seam: VID_Init8bitPalette's `is8bit = true` is a one-way latch in the
// C (a process only ever brings one GL context up), so a suite that exercises
// it needs a way back to the module's initial state.
export function VID_Reset8bitForTests(): void {
  is8bit = false;
}
