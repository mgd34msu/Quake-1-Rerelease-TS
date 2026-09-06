/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_screen.c (SCR_CalcRefdef, SCR_TileClear, the
SCR_UpdateScreen frame bracketing and crosshair, the TargaHeader
SCR_ScreenShot_f and the `gl_triplebuffer` cvar) and WinQuake/view.c (the
`#ifdef GLQUAKE` V_UpdatePalette and its `ramps[3][256]`), GNU GPL v2 or later.

The OpenGL renderer's assembly point, and the twin of src/ref_soft/ref_soft.ts:
`glRenderer` is this port's GL `refexport_t` (src/client/render.ts's
`Renderer`), and the module registers it with src/platform/vid.ts's renderer
registry at load, which is how `vid_ref gl` reaches it. WinQuake has no such
object -- a GLQUAKE build simply links gl_*.c and every call resolves at link
time -- so this file is the seam PORTING.md's "Renderer seam" section
describes, nothing more: every member is either a direct reference to the
ported C function of the same name or, for the members render.ts's GLQUAKE-site
table lists as seam methods, the GL body of that site ported here.

Renderer member -> implementation, in interface order:
  modelHooks               glModelHooks                ref_gl/gl_model.ts
  R_Init                   HERE + R_Init               gl_screen.c:381's
                                                       `Cvar_RegisterVariable
                                                       (&gl_triplebuffer)` then
                                                       gl_rmisc.c's R_Init
  R_InitTextures           R_InitTextures              gl_rmisc.c, filed with
                                                       ref_gl/gl_model.ts
  R_InitEfrags             empty                       (render.h declares it;
                                                       no .c defines it)
  R_RenderView             R_RenderView                gl_rmain.c
  R_ViewChanged            empty                       (no gl_*.c defines it)
  R_InitSky                R_InitSky                   gl_warp.c
  R_AddEfrags              R_AddEfrags                 gl_refrag.c
  R_RemoveEfrags           R_RemoveEfrags              gl_refrag.c
  R_NewMap                 R_NewMap                    gl_rmisc.c
  R_PushDlights            R_PushDlights               gl_rlight.c
  r_cache_thrash           glState.r_cache_thrash      gl_rmain.c
  D_SurfaceCacheForRes     returns 0                   (no gl_*.c defines it)
  D_FlushCaches            D_FlushCaches               gl_rmisc.c (empty body)
  D_DeleteSurfaceCache     empty                       (no gl_*.c defines it)
  D_InitCaches             empty                       (no gl_*.c defines it)
  R_SetVrect               empty                       (no gl_*.c defines it)
  draw_disc                draw_disc                   gl_draw.c
  Draw_*                   Draw_*                      gl_draw.c
  Draw_SubPic              Draw_SubPic                 QW gl_draw.c (new)
  Draw_Alt_String          Draw_Alt_String             QW gl_draw.c (new)
  D_StartParticles         D_StartParticles            gl_rmain.ts (r_part.c's
  D_DrawParticle           D_DrawParticle              three GLQUAKE halves,
  D_EndParticles           D_EndParticles              per U072)
  V_CalcBlend              V_CalcBlend                 view.c GLQUAKE body,
                                                       gl_rmain.ts (it fills
                                                       gl_rmain.c's v_blend)
  V_UpdatePalette          HERE                        view.c:526, GLQUAKE
  V_DrawCrosshair          empty                       (view.c:1056 is the
                                                       !GLQUAKE crosshair)
  R_TranslatePlayerSkin    R_TranslatePlayerSkin       gl_rmisc.c
  SCR_CalcRefdef           HERE                        gl_screen.c:255
  BeginFrame               HERE                        gl_screen.c:829,848
  EndFrame                 HERE                        gl_screen.c:934
  D_EnableBackBufferAccess empty                       (GL has no back buffer
  D_DisableBackBufferAccess empty                       lock; gl_screen.c drops
  D_UpdateRects            empty                        all three calls)
  GL_Set2D                 GL_Set2D                    gl_draw.c
  SCR_TileClear            HERE                        gl_screen.c:786
  SCR_SoftwareTileClear    empty                       (the four screen.c
                                                       Draw_TileClear sites
                                                       gl_screen.c drops)
  SCR_DrawCrosshair        HERE                        gl_screen.c:906
  SCR_ScreenShot_f         HERE                        gl_screen.c:592
  isGL                     true                        (this port's own
                                                       #ifdef GLQUAKE flag)
  R_NetGraph               R_NetGraph                  QW gl_ngraph.c (new);
                                                       gl_screen.c:1145 calls
                                                       it from a client file,
                                                       so it crosses the seam

Deviations from PORTING.md / the C source:
- `registerRenderer("gl", ...)`'s factory registers `gl_ztrick` and calls
  `GL_VidInit()` (gl_vid.ts) before returning `glRenderer`.
  src/platform/vid.ts's VID_CheckChanges runs the factory immediately after
  the GL context is current and before
  host.c's Draw_Init/SCR_Init/R_Init, which is exactly where
  gl_vidlinuxglx.c's VID_Init reaches its GL_Init/VID_SetPalette/
  VID_Init8bitPalette tail. gl_draw.c's Draw_Init issues GL calls, so that
  order is load-bearing, not cosmetic. See gl_vid.ts's header for the
  line-by-line split of VID_Init.
- `gl_triplebuffer` is gl_screen.c's cvar and gl_screen.c's SCR_Init
  registers it. src/client/screen.ts ports screen.c's SCR_Init, and
  screen_types.ts already ruled this cvar belongs to the GL renderer, so
  `Renderer.R_Init` registers it here and then calls gl_rmisc.c's R_Init.
  gl_rmisc.c's R_Init is imported as `R_Init_rmisc` only because the
  interface member of the same name is the wrapper; the C name is unchanged
  at its definition site.
- `r_cache_thrash` and `draw_disc` are a plain `qboolean` / `qpic_t *` global
  in C that other translation units read; on the interface they are
  properties, so they are get-only accessors forwarding to the module that
  owns each (gl_rmain.c's `glState.r_cache_thrash`, gl_draw.c's
  `draw_disc`). Nothing outside the renderer writes either one.
- `R_InitEfrags`, `R_ViewChanged`, `R_SetVrect`, `D_SurfaceCacheForRes`,
  `D_InitCaches` and `D_DeleteSurfaceCache` are render.h prototypes that NO
  gl_*.c file defines in v1.09 -- a GLQUAKE build has no software surface
  cache and computes its view rect inline in SCR_CalcRefdef. render.ts kept
  them so the interface is render.h's full surface; all six are empty here
  (`D_SurfaceCacheForRes` returns 0), which is what a link against the C
  would not even have produced. src/platform/vid.ts already guards the two
  surface-cache calls behind `if (name !== "gl")`.
- `V_UpdatePalette`'s local `qboolean new` is renamed `isnew`: `new` is a
  JavaScript keyword. Its `byte pal[768]` is a `Uint8Array(768)`, and
  `byte ramps[3][256]` (view.c:264, defined under GLQUAKE) is three
  `Uint8Array(256)`s at module scope here -- render.ts's header rules
  `ramps` and `v_blend` into src/ref_gl, and `v_blend` is gl_rmain.ts's
  because gl_rmain.c's R_PolyBlend is its other reader.
- `SCR_CalcRefdef` is `static` in gl_screen.c and calls `Sbar_Changed`,
  `Cvar_Set` and `CalcFov`; src/client/screen.ts exports `CalcFov` and the
  `scr_*` cvars precisely so both renderers' bodies can be written outside
  it. `sb_lines`, `scr_fullupdate` and `scr_vrect` are `scrState`'s
  (src/client/screen_types.ts), and `scr_vrect = r_refdef.vrect` is a C
  struct assignment, i.e. a field-by-field copy.
- Two shipped bugs in gl_screen.c's SCR_TileClear are preserved verbatim:
  the right-hand rect's width is `vid.width - r_refdef.vrect.x +
  r_refdef.vrect.width` (the C is missing the parentheses that would make it
  `vid.width - (x + width)`), and the top rect passes `r_refdef.vrect.x +
  r_refdef.vrect.width` as its WIDTH argument rather than a width. Both are
  ported as written, per PORTING.md's exactly as the original rule.
- SCR_ScreenShot_f keeps gl_screen.c's own naming and message text: the
  local is `pcxname` and the failure prints "Couldn't create a PCX file"
  even though the file it writes is a TGA. `malloc`/`free` become one
  `Uint8Array`; `memset (buffer, 0, 18)` is implicit; `glReadPixels (...,
  buffer+18)` becomes `buffer.subarray(18)`, which qgl.ts's `GLPointer`
  accepts directly.
- `hostClientHooks.rInit` / `rInitTextures` / `drawInit` / `rViewVectors` are
  NOT registered here. src/ref_soft/ref_soft.ts already installs all four,
  each dispatching through `re.current?.`, so they reach whichever renderer
  is active; registering them again would only overwrite identical bodies.
- Dropped `#ifdef GLQUAKE` branches: every member listed as "empty" in the
  table above is the GL side of a site whose only body is in screen.c,
  view.c or a d_*.c/r_*.c software file.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/gl_screen.c against WinQuake/gl_screen.c):
- `SCR_CalcRefdef`: QW's `h` is `vid.height` (not `vid.height - sb_lines`)
  when `!cl_sbar.value && full`, and the height clamp becomes an either/or --
  `if (cl_sbar.value || !full)` clamps to `vid.height - sb_lines`, `else`
  clamps to `vid.height`, where WinQuake's applies both in sequence. With
  qwcl's default `cl_sbar 0` at viewsize 100 the refresh therefore fills the
  screen and the status bar overlays it, exactly as R_SetVrect already does
  on the software side (src/ref_soft/r_main.ts).
- `host_basepal` is one C global with two holders in this port; see
  `hostBasepal()` below.
*/

import { COM_WriteFile, com_gamedir } from "../common/common";
import { Con_Printf } from "../client/console";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { Sys_FileTime } from "../platform/sys";
import { host, hostBasepal } from "../common/host";
import { cl, CSHIFT_BONUS, CSHIFT_DAMAGE, NUM_CSHIFTS } from "../client/client";
import { r_refdef, type Renderer } from "../client/render";
import { d_8to24table, vid, vidBackend } from "../client/vid";
import { scr_vrect, scrState } from "../client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../client/screen";
import { Sbar_Changed } from "../client/sbar";
import { crosshair, gammatable, V_CalcPowerupCshift, V_CheckGamma } from "../client/view";
import { qw } from "../common/quakedef";

// host.c's `byte *host_basepal` is one global; this port has two holders for
// it -- src/common/host.ts on the WinQuake track, and src/qw/client/cl_main.ts
// on the qwcl one, whose own Host_Init is what loads gfx/palette.lmp there.
// Resolved exactly as src/platform/vid.ts resolves `host_colormap`.
import type * as QwClMainModule from "../qw/client/cl_main";

function qwClMainMod(): typeof QwClMainModule {
  return require("../qw/client/cl_main");
}

import { registerRenderer } from "../platform/vid";
import { glState } from "./glquake";
import { GL_RGB, GL_UNSIGNED_BYTE, qgl, qglHolder, QGL_Shutdown } from "./qgl";
import { GL_BeginRendering, GL_EndRendering, glVidPaletteState, GL_VidInit } from "./gl_vid";
// siblings, each imported by its C name from the module its .c file maps to
import { gl_subdivide_size, glModelHooks, R_InitTextures } from "./gl_model";
import { D_DrawParticle, D_EndParticles, D_StartParticles, R_RenderView, V_CalcBlend, gl_ztrick, v_blend } from "./gl_rmain";
import { D_FlushCaches, GL_ClearTextureState, R_Init as R_Init_rmisc, R_NewMap, R_TranslatePlayerSkin } from "./gl_rmisc";
import { R_AddEfrags, R_RemoveEfrags } from "./gl_refrag";
import { R_PushDlights } from "./gl_rlight";
import { R_InitSky } from "./gl_warp";
import {
  draw_disc,
  Draw_Alt_String,
  Draw_BeginDisc,
  Draw_CachePic,
  Draw_Character,
  Draw_ConsoleBackground,
  Draw_Crosshair,
  Draw_DebugChar,
  Draw_EndDisc,
  Draw_FadeScreen,
  Draw_Fill,
  Draw_Init,
  Draw_Pic,
  Draw_PicFromWad,
  Draw_String,
  Draw_SubPic,
  Draw_TileClear,
  Draw_TransPic,
  Draw_TransPicTranslate,
  GL_Set2D,
} from "./gl_draw";
import { R_NetGraph } from "./gl_ngraph";

export const gl_triplebuffer = new CvarT("gl_triplebuffer", "1", true);

// view.c:264 `byte ramps[3][256];`, defined under GLQUAKE
const ramps: [Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];

/*
=============
V_UpdatePalette

view.c's `#ifdef GLQUAKE` body
=============
*/
function V_UpdatePalette(): void {
  let i: number;
  let j: number;
  let isnew: boolean;
  const pal = new Uint8Array(768);
  let r: number;
  let g: number;
  let b: number;
  let a: number;
  let ir: number;
  let ig: number;
  let ib: number;
  let force: boolean;

  V_CalcPowerupCshift();

  isnew = false;

  for (i = 0; i < NUM_CSHIFTS; i++) {
    if (cl.cshifts[i].percent !== cl.prev_cshifts[i].percent) {
      isnew = true;
      cl.prev_cshifts[i].percent = cl.cshifts[i].percent;
    }
    for (j = 0; j < 3; j++)
      if (cl.cshifts[i].destcolor[j] !== cl.prev_cshifts[i].destcolor[j]) {
        isnew = true;
        cl.prev_cshifts[i].destcolor[j] = cl.cshifts[i].destcolor[j];
      }
  }

  // drop the damage value
  cl.cshifts[CSHIFT_DAMAGE].percent -= host.frametime * 150;
  if (cl.cshifts[CSHIFT_DAMAGE].percent <= 0) cl.cshifts[CSHIFT_DAMAGE].percent = 0;

  // drop the bonus value
  cl.cshifts[CSHIFT_BONUS].percent -= host.frametime * 100;
  if (cl.cshifts[CSHIFT_BONUS].percent <= 0) cl.cshifts[CSHIFT_BONUS].percent = 0;

  force = V_CheckGamma();
  if (!isnew && !force) return;

  V_CalcBlend();

  a = v_blend[3];
  r = 255 * v_blend[0] * a;
  g = 255 * v_blend[1] * a;
  b = 255 * v_blend[2] * a;

  a = 1 - a;
  for (i = 0; i < 256; i++) {
    ir = (i * a + r) | 0;
    ig = (i * a + g) | 0;
    ib = (i * a + b) | 0;
    if (ir > 255) ir = 255;
    if (ig > 255) ig = 255;
    if (ib > 255) ib = 255;

    ramps[0][i] = gammatable[ir];
    ramps[1][i] = gammatable[ig];
    ramps[2][i] = gammatable[ib];
  }

  const basepal = hostBasepal();
  if (!basepal) return;

  let basepalIdx = 0;
  let newpalIdx = 0;

  for (i = 0; i < 256; i++) {
    ir = basepal[basepalIdx + 0];
    ig = basepal[basepalIdx + 1];
    ib = basepal[basepalIdx + 2];
    basepalIdx += 3;

    pal[newpalIdx + 0] = ramps[0][ir];
    pal[newpalIdx + 1] = ramps[1][ig];
    pal[newpalIdx + 2] = ramps[2][ib];
    newpalIdx += 3;
  }

  vidBackend.current?.VID_ShiftPalette(pal);
}

/*
=================
SCR_CalcRefdef

Must be called whenever vid changes
Internal use only
=================
*/
function SCR_CalcRefdef(): void {
  let size: number;
  let h: number;
  let full = false;

  scrState.scr_fullupdate = 0; // force a background redraw
  vid.recalc_refdef = 0;

  // force the status bar to redraw
  Sbar_Changed();

  //========================================

  // bound viewsize
  if (scr_viewsize.value < 30) Cvar_Set("viewsize", "30");
  if (scr_viewsize.value > 120) Cvar_Set("viewsize", "120");

  // bound field of view
  if (scr_fov.value < 10) Cvar_Set("fov", "10");
  if (scr_fov.value > 170) Cvar_Set("fov", "170");

  // intermission is always full screen
  if (cl.intermission) size = 120;
  else size = scr_viewsize.value;

  if (size >= 120) scrState.sb_lines = 0; // no status bar at all
  else if (size >= 110) scrState.sb_lines = 24; // no inventory
  else scrState.sb_lines = 24 + 16 + 8;

  if (scr_viewsize.value >= 100.0) {
    full = true;
    size = 100.0;
  } else size = scr_viewsize.value;
  if (cl.intermission) {
    full = true;
    size = 100;
    scrState.sb_lines = 0;
  }
  size /= 100.0;

  // QW/client/gl_screen.c: with `cl_sbar 0` (its default) and a full-size
  // view, the refresh gets the whole screen and the status bar overlays it,
  // instead of the view being cut short by sb_lines. The same fold is in the
  // software renderer's R_SetVrect (src/ref_soft/r_main.ts).
  const qwFullNoSbar = qw.active && !qwClMainMod().cl_sbar.value && full;

  if (qwFullNoSbar) h = vid.height;
  else h = vid.height - scrState.sb_lines;

  r_refdef.vrect.width = (vid.width * size) | 0;
  if (r_refdef.vrect.width < 96) {
    size = 96.0 / r_refdef.vrect.width;
    r_refdef.vrect.width = 96; // min for icons
  }

  r_refdef.vrect.height = (vid.height * size) | 0;
  if (!qwFullNoSbar) {
    if (r_refdef.vrect.height > vid.height - scrState.sb_lines) r_refdef.vrect.height = vid.height - scrState.sb_lines;
    if (!qw.active && r_refdef.vrect.height > vid.height) r_refdef.vrect.height = vid.height;
  } else if (r_refdef.vrect.height > vid.height) r_refdef.vrect.height = vid.height;
  r_refdef.vrect.x = ((vid.width - r_refdef.vrect.width) / 2) | 0;
  if (full) r_refdef.vrect.y = 0;
  else r_refdef.vrect.y = ((h - r_refdef.vrect.height) / 2) | 0;

  r_refdef.fov_x = scr_fov.value;
  r_refdef.fov_y = CalcFov(r_refdef.fov_x, r_refdef.vrect.width, r_refdef.vrect.height);

  scr_vrect.x = r_refdef.vrect.x;
  scr_vrect.y = r_refdef.vrect.y;
  scr_vrect.width = r_refdef.vrect.width;
  scr_vrect.height = r_refdef.vrect.height;
  scr_vrect.pnext = r_refdef.vrect.pnext;
}

/*
==================
BeginFrame

gl_screen.c's SCR_UpdateScreen head: the triple-buffer page count and
GL_BeginRendering
==================
*/
function BeginFrame(): void {
  vid.numpages = (2 + gl_triplebuffer.value) | 0;

  GL_BeginRendering();
}

/*
==================
EndFrame
==================
*/
function EndFrame(): void {
  GL_EndRendering();
}

function SCR_TileClear(): void {
  if (r_refdef.vrect.x > 0) {
    // left
    Draw_TileClear(0, 0, r_refdef.vrect.x, vid.height - scrState.sb_lines);
    // right
    Draw_TileClear(r_refdef.vrect.x + r_refdef.vrect.width, 0, vid.width - r_refdef.vrect.x + r_refdef.vrect.width, vid.height - scrState.sb_lines);
  }
  if (r_refdef.vrect.y > 0) {
    // top
    Draw_TileClear(r_refdef.vrect.x, 0, r_refdef.vrect.x + r_refdef.vrect.width, r_refdef.vrect.y);
    // bottom
    Draw_TileClear(
      r_refdef.vrect.x,
      r_refdef.vrect.y + r_refdef.vrect.height,
      r_refdef.vrect.width,
      vid.height - scrState.sb_lines - (r_refdef.vrect.height + r_refdef.vrect.y),
    );
  }
}

/*
==================
SCR_DrawCrosshair

gl_screen.c's SCR_UpdateScreen else-branch
==================
*/
function SCR_DrawCrosshair(): void {
  if (crosshair.value) {
    // QW/client/gl_screen.c:1172 factors the same site out into gl_draw.c's
    // Draw_Crosshair, which adds the crosshair.value==2 textured crosshair
    // and the -4 centering offset.
    if (qw.active) {
      Draw_Crosshair();
      return;
    }
    Draw_Character(scr_vrect.x + ((scr_vrect.width / 2) | 0), scr_vrect.y + ((scr_vrect.height / 2) | 0), "+".charCodeAt(0));
  }
}

/*
==============================================================================

						SCREEN SHOTS

==============================================================================
*/

// gl_screen.c's TargaHeader: 18 bytes ahead of the pixels, written field by
// field below at the offsets the C indexes.
const TGA_HEADER_SIZE = 18;

/*
==================
SCR_ScreenShot_f
==================
*/
function SCR_ScreenShot_f(): void {
  let i: number;
  let c: number;
  let temp: number;
  let pcxname: string;
  let checkname: string;

  //
  // find a file name to save it to
  //
  pcxname = "quake00.tga";

  for (i = 0; i <= 99; i++) {
    pcxname = `quake${String.fromCharCode(((i / 10) | 0) + 0x30)}${String.fromCharCode((i % 10) + 0x30)}.tga`;
    checkname = `${com_gamedir}/${pcxname}`;
    if (Sys_FileTime(checkname) === -1) break; // file doesn't exist
  }
  if (i === 100) {
    Con_Printf("SCR_ScreenShot_f: Couldn't create a PCX file\n");
    return;
  }

  const glwidth = glState.glwidth;
  const glheight = glState.glheight;

  const buffer = new Uint8Array(glwidth * glheight * 3 + TGA_HEADER_SIZE);
  buffer[2] = 2; // uncompressed type
  buffer[12] = glwidth & 255;
  buffer[13] = glwidth >> 8;
  buffer[14] = glheight & 255;
  buffer[15] = glheight >> 8;
  buffer[16] = 24; // pixel size

  qgl().qglReadPixels(glState.glx, glState.gly, glwidth, glheight, GL_RGB, GL_UNSIGNED_BYTE, buffer.subarray(TGA_HEADER_SIZE));

  // swap rgb to bgr
  c = 18 + glwidth * glheight * 3;
  for (i = 18; i < c; i += 3) {
    temp = buffer[i];
    buffer[i] = buffer[i + 2];
    buffer[i + 2] = temp;
  }
  COM_WriteFile(pcxname, buffer);

  Con_Printf("Wrote %s\n", pcxname);
}

//=============================================================================

export const glRenderer: Renderer = {
  modelHooks: glModelHooks,

  R_Init(): void {
    // gl_screen.c:381, SCR_Init -- see this file's header
    Cvar_RegisterVariable(gl_triplebuffer);
    R_Init_rmisc();
  },
  R_InitTextures,
  R_InitEfrags(): void {},
  R_RenderView,
  R_ViewChanged(): void {},
  R_InitSky,

  R_AddEfrags,
  R_RemoveEfrags,

  R_NewMap,

  R_PushDlights,

  get r_cache_thrash(): boolean {
    return glState.r_cache_thrash;
  },

  D_SurfaceCacheForRes(): number {
    return 0;
  },
  D_FlushCaches,
  D_DeleteSurfaceCache(): void {},
  D_InitCaches(): void {},
  R_SetVrect(): void {},

  get draw_disc() {
    return draw_disc;
  },

  Draw_Init,
  Draw_Character,
  Draw_DebugChar,
  Draw_Pic,
  Draw_TransPic,
  Draw_TransPicTranslate,
  Draw_ConsoleBackground,
  Draw_BeginDisc,
  Draw_EndDisc,
  Draw_TileClear,
  Draw_Fill,
  Draw_FadeScreen,
  Draw_String,
  Draw_PicFromWad,
  Draw_CachePic,

  Draw_SubPic,
  Draw_Alt_String,

  D_StartParticles,
  D_DrawParticle,
  D_EndParticles,

  V_CalcBlend,
  V_UpdatePalette,
  V_DrawCrosshair(): void {},

  R_TranslatePlayerSkin,

  SCR_CalcRefdef,
  BeginFrame,
  EndFrame,
  D_EnableBackBufferAccess(): void {},
  D_DisableBackBufferAccess(): void {},
  D_UpdateRects(): void {},
  GL_Set2D,
  SCR_TileClear,
  SCR_SoftwareTileClear(): void {},
  SCR_DrawCrosshair,
  SCR_ScreenShot_f,

  isGL: true,

  R_NetGraph,

  // render.ts's Renderer.Shutdown -- this port's own addition (Quake never
  // unloads a renderer). Releases what GL_VidInit/loadQGLFromSystem set up:
  // the qgl function table (QGL_Shutdown closes the libGL dlopen handle;
  // qglHolder.current drops the table itself) and undoes VID_SetPalette's
  // `d_8to24table[255] &= 0xffffff` (gl_vid.ts's header note) by restoring
  // the pre-mask value gl_vid.ts's VID_SetPalette stashed in
  // glVidPaletteState, so the software present path gets back entry 255's
  // real alpha byte.
  Shutdown(): void {
    QGL_Shutdown();
    qglHolder.current = null;

    d_8to24table[255] = glVidPaletteState.preMaskAlpha255;

    // gl_rmisc.ts's GL_ClearTextureState carries the whole contract: every
    // texture id this renderer minted belongs to the context vid.ts is about
    // to have SDL_GL_DeleteContext destroy, including the ones GLQuake keeps
    // in `if (!x)`-guarded statics across a level change (lightmap_textures,
    // solidskytexture/alphaskytexture), which are exactly the ones a
    // caches-only reset left pointing at other textures' numbers.
    GL_ClearTextureState();
  },
};

// The factory runs at gl_vidlinuxglx.c's VID_Init tail position -- see this
// file's header and gl_vid.ts's.
registerRenderer("gl", () => {
  Cvar_RegisterVariable(gl_ztrick); // gl_vidlinuxglx.c's VID_Init:747
  Cvar_RegisterVariable(gl_subdivide_size); // gl_model.c's Mod_Init
  GL_VidInit();
  return glRenderer;
});
