/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/screen.c (WritePCXfile, SCR_ScreenShot_f, SCR_CalcRefdef
and SCR_UpdateScreen's three-way VID_Update tail) and WinQuake/view.c (the
`#else // !GLQUAKE` V_UpdatePalette and V_RenderView's `#ifndef GLQUAKE`
crosshair), GNU GPL v2 or later.

The software renderer's assembly point: `softRenderer` is this port's software
`refexport_t` (src/client/render.ts's `Renderer`), and the module registers it
with src/platform/vid.ts's renderer registry at load, which is how `vid_ref
soft` reaches it. WinQuake has no such object -- a software build simply links
r_*.c/d_*.c/draw.c and every call resolves at link time -- so this file is the
seam PORTING.md's "Renderer seam" section describes, nothing more: every
member is either a direct reference to the ported C function of the same name
or, for the members render.ts's GLQUAKE-site table lists as seam methods, the
software body of that site ported here.

Renderer member -> implementation, in interface order:
  modelHooks               softModelHooks              ref_soft/model.ts
  R_Init                   R_Init                      r_main.c
  R_InitTextures           R_InitTextures              model.c (renderer half)
  R_InitEfrags             empty                       (render.h declares it;
                                                       no .c defines it)
  R_RenderView             R_RenderView                r_main.c
  R_ViewChanged            R_ViewChanged               r_main.c
  R_InitSky                R_InitSky                   r_sky.c
  R_AddEfrags              R_AddEfrags                 r_efrag.c
  R_RemoveEfrags           R_RemoveEfrags              r_efrag.c
  R_NewMap                 R_NewMap                    r_main.c
  R_PushDlights            R_PushDlights               r_light.c
  r_cache_thrash           dState.r_cache_thrash       d_surf.c
  D_SurfaceCacheForRes     D_SurfaceCacheForRes        d_surf.c
  D_FlushCaches            D_FlushCaches               d_surf.c
  D_DeleteSurfaceCache     empty                       (render.h declares it;
                                                       no .c defines it)
  D_InitCaches             D_InitCaches                d_surf.c
  R_SetVrect               R_SetVrect                  r_main.c
  draw_disc                draw_disc                   draw.c
  Draw_*                   Draw_*                      draw.c
  Draw_SubPic              Draw_SubPic                 QW draw.c (new)
  Draw_Alt_String          Draw_Alt_String             QW draw.c (new)
  D_StartParticles         D_StartParticles            d_part.c
  D_DrawParticle           D_DrawParticle              d_part.c
  D_EndParticles           D_EndParticles              d_part.c
  V_CalcBlend              empty                       (GL-only in view.c)
  V_UpdatePalette          HERE                        view.c, !GLQUAKE body
  V_DrawCrosshair          HERE                        view.c:1056, !GLQUAKE
  R_TranslatePlayerSkin    empty                       (gl_rmisc.c only)
  SCR_CalcRefdef           HERE                        screen.c:219
  BeginFrame               empty                       (gl_screen.c only)
  EndFrame                 HERE                        screen.c:945-981
  D_EnableBackBufferAccess D_EnableBackBufferAccess    d_init.c
  D_DisableBackBufferAccess D_DisableBackBufferAccess  d_init.c
  D_UpdateRects            D_UpdateRects               d_init.c
  GL_Set2D                 empty                       (gl_draw.c only)
  SCR_TileClear            empty                       (gl_screen.c only)
  SCR_SoftwareTileClear    Draw_TileClear              draw.c
  SCR_DrawCrosshair        empty                       (gl_screen.c only)
  isGL                     false                       (this port's own
                                                       #ifdef GLQUAKE flag)
  R_NetGraph               not implemented             (r_misc.c's R_NetGraph
                                                       is called from
                                                       r_main.c, inside the
                                                       renderer -- see
                                                       render.ts's header)
  SCR_ScreenShot_f         HERE                        screen.c:613 + WritePCXfile

Deviations from PORTING.md / the C source:
- `r_cache_thrash` and `draw_disc` are plain `qboolean` / `qpic_t *` globals in
  C that other translation units read; on the interface they are properties,
  so they are get-only accessors that forward to the module that owns each
  (d_surf.c's `dState.r_cache_thrash`, draw.c's `draw_disc`). Nothing outside
  the renderer writes either one.
- `R_InitEfrags` and `D_DeleteSurfaceCache` are declared in render.h and
  DEFINED BY NO .c FILE in v1.09. render.ts kept them so the interface is
  render.h's full surface; both are empty here, which is what a link against
  the C would not even have produced (it would not link at all if anything
  called them -- nothing does).
- `SCR_CalcRefdef` is `static` in screen.c and calls `Sbar_Changed`,
  `Cvar_Set` and `CalcFov`; src/client/screen.ts exports `CalcFov` and the
  eight `scr_*` cvars precisely so both renderers' bodies can be written
  outside it. `sb_lines`, `scr_fullupdate`, `scr_con_current`, `scr_copytop`
  and `scr_copyeverything` are `scrState`'s (src/client/screen_types.ts).
- `WritePCXfile`'s `pcx = Hunk_TempAlloc (width*height*2+1000)` followed by
  `length = pack - (byte *)pcx` is a worst-case buffer trimmed at the end;
  here it is a `Uint8Array` of the same worst-case size and the file written
  is `pcx.subarray(0, length)`. The 128-byte pcx_t header is written field by
  field at the C's offsets through a DataView (little-endian, as LittleShort
  is on the platforms this port targets).
- `V_UpdatePalette`'s local `qboolean new` is renamed `isnew`: `new` is a
  JavaScript keyword. Its `byte pal[768]` is a `Uint8Array(768)`.
- `V_DrawCrosshair`'s `Draw_Character (scr_vrect.x + scr_vrect.width/2 +
  cl_crossx.value, ...)` mixes int division with a float cvar and truncates at
  the int parameters; the port keeps both truncations explicitly.
- `hostClientHooks.rInit` / `rInitTextures` / `drawInit` / `rViewVectors` are
  registered here, at module load. host.c calls R_Init, R_InitTextures,
  Draw_Init and reads r_origin/vpn/vright/vup directly because a software
  build links r_main.c and draw.c; this port has no such link, and
  src/platform/vid.ts's own header already names r_main.ts as the module that
  installs `hostClientHooks.rInit`. Each hook goes through `re.current?.` (the
  same shape cl_main.ts uses for `flushCaches`), so it dispatches to whichever
  renderer is active and is a no-op on a dedicated server, where host.c's
  "needed even for dedicated servers" R_InitTextures call has nothing to build
  (with no renderer installed, model.ts's loader never reaches
  `hooks.notexture`).
- Dropped `#ifdef GLQUAKE` branches: every one listed as "empty" in the table
  above is the software side of a site whose only body is in a gl_*.c file.
*/

import { COM_WriteFile, com_gamedir } from "../common/common";
import { Con_Printf } from "../client/console";
import { Cvar_Set } from "../common/cvar";
import { Sys_FileTime } from "../platform/sys";
import { host, hostBasepal, hostClientHooks } from "../common/host";
import { cl, CSHIFT_BONUS, CSHIFT_DAMAGE, NUM_CSHIFTS } from "../client/client";
import { re, r_origin, r_refdef, type Renderer, vpn, vright, vup } from "../client/render";
import { vid, vidBackend, VrectT } from "../client/vid";
import { scr_vrect, scrState } from "../client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../client/screen";
import { Sbar_Changed } from "../client/sbar";
import { cl_crossx, cl_crossy, crosshair, gammatable, V_CalcPowerupCshift, V_CheckGamma } from "../client/view";
import { qw } from "../common/quakedef";

// host.c's `byte *host_basepal` is one global; this port has two holders for
// it -- src/common/host.ts on the WinQuake track, and src/qw/client/cl_main.ts
// on the qwcl one, whose own Host_Init is what loads gfx/palette.lmp there.
// Resolved exactly as src/platform/vid.ts resolves `host_colormap`.


import { registerRenderer } from "../platform/vid";
import { dState } from "./d_local";
import { R_Init, R_NewMap, R_RenderView, R_SetVrect, R_ViewChanged } from "./r_main";
// siblings, each imported by its C name from the module its .c file maps to
import { R_InitTextures, softModelHooks } from "./model";
import { D_DisableBackBufferAccess, D_EnableBackBufferAccess, D_UpdateRects } from "./d_init";
import { D_FlushCaches, D_InitCaches, D_SurfaceCacheForRes } from "./d_surf";
import { D_DrawParticle, D_EndParticles, D_StartParticles } from "./d_part";
import { R_AddEfrags, R_RemoveEfrags } from "./r_efrag";
import { R_InitSky } from "./r_sky";
import { R_PushDlights } from "./r_light";
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
} from "./draw";

/*
=============
V_UpdatePalette

view.c's `#else // !GLQUAKE` body
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

  const basepal = hostBasepal();
  if (!basepal) return;

  let basepalIdx = 0;
  let newpalIdx = 0;

  for (i = 0; i < 256; i++) {
    r = basepal[basepalIdx + 0];
    g = basepal[basepalIdx + 1];
    b = basepal[basepalIdx + 2];
    basepalIdx += 3;

    for (j = 0; j < NUM_CSHIFTS; j++) {
      r += (cl.cshifts[j].percent * (cl.cshifts[j].destcolor[0] - r)) >> 8;
      g += (cl.cshifts[j].percent * (cl.cshifts[j].destcolor[1] - g)) >> 8;
      b += (cl.cshifts[j].percent * (cl.cshifts[j].destcolor[2] - b)) >> 8;
    }

    pal[newpalIdx + 0] = gammatable[r];
    pal[newpalIdx + 1] = gammatable[g];
    pal[newpalIdx + 2] = gammatable[b];
    newpalIdx += 3;
  }

  vidBackend.current?.VID_ShiftPalette(pal);
}

/*
=============
V_DrawCrosshair

view.c's V_RenderView tail, `#ifndef GLQUAKE`
=============
*/
function V_DrawCrosshair(): void {
  if (crosshair.value) {
    // QW/client/view.c:1019 factors the same site out into draw.c's
    // Draw_Crosshair, which adds the crosshair.value==2 dot and the -4
    // centering offset.
    if (qw.active) {
      Draw_Crosshair();
      return;
    }
    Draw_Character(
      (scr_vrect.x + ((scr_vrect.width / 2) | 0) + cl_crossx.value) | 0,
      (scr_vrect.y + ((scr_vrect.height / 2) | 0) + cl_crossy.value) | 0,
      "+".charCodeAt(0),
    );
  }
}

/*
=================
SCR_CalcRefdef

Must be called whenever vid changes
Internal use only
=================
*/
function SCR_CalcRefdef(): void {
  const vrect = new VrectT();
  let size: number;

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

  r_refdef.fov_x = scr_fov.value;
  r_refdef.fov_y = CalcFov(r_refdef.fov_x, r_refdef.vrect.width, r_refdef.vrect.height);

  // intermission is always full screen
  if (cl.intermission) size = 120;
  else size = scr_viewsize.value;

  if (size >= 120) scrState.sb_lines = 0; // no status bar at all
  else if (size >= 110) scrState.sb_lines = 24; // no inventory
  else scrState.sb_lines = 24 + 16 + 8;

  // these calculations mirror those in R_Init() for r_refdef, but take no
  // account of water warping
  vrect.x = 0;
  vrect.y = 0;
  vrect.width = vid.width;
  vrect.height = vid.height;

  R_SetVrect(vrect, scr_vrect, scrState.sb_lines);

  // guard against going from one mode to another that's less than half the
  // vertical resolution
  if (scrState.scr_con_current > vid.height) scrState.scr_con_current = vid.height;

  // notify the refresh of the change
  R_ViewChanged(vrect, scrState.sb_lines, vid.aspect);
}

/*
==================
EndFrame

screen.c's SCR_UpdateScreen tail: update one of three areas
==================
*/
function EndFrame(): void {
  const vrect = new VrectT();

  if (scrState.scr_copyeverything) {
    vrect.x = 0;
    vrect.y = 0;
    vrect.width = vid.width;
    vrect.height = vid.height;
    vrect.pnext = null;

    vidBackend.current?.VID_Update(vrect);
  } else if (scrState.scr_copytop) {
    vrect.x = 0;
    vrect.y = 0;
    vrect.width = vid.width;
    vrect.height = vid.height - scrState.sb_lines;
    vrect.pnext = null;

    vidBackend.current?.VID_Update(vrect);
  } else {
    vrect.x = scr_vrect.x;
    vrect.y = scr_vrect.y;
    vrect.width = scr_vrect.width;
    vrect.height = scr_vrect.height;
    vrect.pnext = null;

    vidBackend.current?.VID_Update(vrect);
  }
}

/*
==============================================================================

						SCREEN SHOTS

==============================================================================
*/

// screen.c's pcx_t: a fixed 128-byte header followed by the packed image.
const PCX_HEADER_SIZE = 128;

/*
==============
WritePCXfile
==============
*/
function WritePCXfile(filename: string, data: Uint8Array, width: number, height: number, rowbytes: number, palette: Uint8Array): void {
  let i: number;
  let j: number;
  let length: number;

  const pcx = new Uint8Array(width * height * 2 + 1000);
  const view = new DataView(pcx.buffer);

  pcx[0] = 0x0a; // manufacturer: PCX id
  pcx[1] = 5; // version: 256 color
  pcx[2] = 1; // encoding: uncompressed
  pcx[3] = 8; // bits_per_pixel: 256 color
  view.setUint16(4, 0, true); // xmin
  view.setUint16(6, 0, true); // ymin
  view.setUint16(8, width - 1, true); // xmax
  view.setUint16(10, height - 1, true); // ymax
  view.setUint16(12, width, true); // hres
  view.setUint16(14, height, true); // vres
  pcx.fill(0, 16, 16 + 48); // palette[48]
  pcx[65] = 1; // color_planes: chunky image
  view.setUint16(66, width, true); // bytes_per_line
  view.setUint16(68, 2, true); // palette_type: not a grey scale
  pcx.fill(0, 70, 70 + 58); // filler[58]

  // pack the image
  let pack = PCX_HEADER_SIZE;
  let src = 0;

  for (i = 0; i < height; i++) {
    for (j = 0; j < width; j++) {
      if ((data[src] & 0xc0) !== 0xc0) {
        pcx[pack++] = data[src++];
      } else {
        pcx[pack++] = 0xc1;
        pcx[pack++] = data[src++];
      }
    }

    src += rowbytes - width;
  }

  // write the palette
  pcx[pack++] = 0x0c; // palette ID byte
  for (i = 0; i < 768; i++) pcx[pack++] = palette[i];

  // write output file
  length = pack;
  COM_WriteFile(filename, pcx.subarray(0, length));
}

/*
==================
SCR_ScreenShot_f
==================
*/
function SCR_ScreenShot_f(): void {
  let i: number;
  let pcxname: string;
  let checkname: string;

  //
  // find a file name to save it to
  //
  pcxname = "quake00.pcx";

  for (i = 0; i <= 99; i++) {
    pcxname = `quake${String.fromCharCode(((i / 10) | 0) + 0x30)}${String.fromCharCode((i % 10) + 0x30)}.pcx`;
    checkname = `${com_gamedir}/${pcxname}`;
    if (Sys_FileTime(checkname) === -1) break; // file doesn't exist
  }
  if (i === 100) {
    Con_Printf("SCR_ScreenShot_f: Couldn't create a PCX file\n");
    return;
  }

  //
  // save the pcx file
  //
  D_EnableBackBufferAccess(); // enable direct drawing of console to back
  //  buffer

  const buffer = vid.buffer;
  const basepal = hostBasepal();
  if (buffer && basepal) WritePCXfile(pcxname, buffer, vid.width, vid.height, vid.rowbytes, basepal);

  D_DisableBackBufferAccess(); // for adapters that can't stay mapped in
  //  for linear writes all the time

  Con_Printf("Wrote %s\n", pcxname);
}

//=============================================================================

export const softRenderer: Renderer = {
  modelHooks: softModelHooks,

  R_Init,
  R_InitTextures,
  R_InitEfrags(): void {},
  R_RenderView,
  R_ViewChanged,
  R_InitSky,

  R_AddEfrags,
  R_RemoveEfrags,

  R_NewMap,

  R_PushDlights,

  get r_cache_thrash(): boolean {
    return dState.r_cache_thrash;
  },

  D_SurfaceCacheForRes,
  D_FlushCaches,
  D_DeleteSurfaceCache(): void {},
  D_InitCaches,
  R_SetVrect,

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

  V_CalcBlend(): void {},
  V_UpdatePalette,
  V_DrawCrosshair,

  R_TranslatePlayerSkin(_playernum: number): void {},

  SCR_CalcRefdef,
  BeginFrame(): void {},
  EndFrame,
  D_EnableBackBufferAccess,
  D_DisableBackBufferAccess,
  D_UpdateRects,
  GL_Set2D(): void {},
  SCR_TileClear(): void {},
  SCR_SoftwareTileClear(x: number, y: number, w: number, h: number): void {
    Draw_TileClear(x, y, w, h);
  },
  SCR_DrawCrosshair(): void {},
  SCR_ScreenShot_f,

  isGL: false,
};

registerRenderer("soft", () => softRenderer);

// host.c calls R_Init / R_InitTextures / Draw_Init and reads r_origin, vpn,
// vright and vup directly because a software build links r_main.c and draw.c.
// See this file's header for why the four hooks are installed here and why
// each goes through `re.current?.`.
hostClientHooks.rInit = () => {
  re.current?.R_Init();
};
hostClientHooks.rInitTextures = () => {
  re.current?.R_InitTextures();
};
hostClientHooks.drawInit = () => {
  re.current?.Draw_Init();
};
hostClientHooks.rViewVectors = () => ({ origin: r_origin, forward: vpn, right: vright, up: vup });
