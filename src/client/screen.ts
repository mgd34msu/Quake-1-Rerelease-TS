/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/screen.c, WinQuake/gl_screen.c and WinQuake/screen.h
(GNU GPL v2 or later).

screen.c -- master for refresh, status bar, console, chat, notify, etc

background clear
rendering
turtle/net/ram icons
sbar
centerprint / slow centerprint
notify lines
intermission / finale overlay
loading plaque
console
menu

required background clears
required update regions


syncronous draw mode or async
One off screen buffer, with updates either copied or xblited
Need to double buffer?


async draw will require the refresh area to be cleared, because it will be
xblited, but sync draw can just ignore it.

sync
draw

CenterPrint ()
SlowPrint ()
Screen_Update ();
Con_Printf ();

net
turn off messages option

the refresh is allways rendered, unless the console is full screen


console is:
	notify lines
	half
	full


Deviations from PORTING.md / the C source:
- One module for two C files. PORTING.md maps screen.h + screen.c +
  gl_screen.c here, and render.ts's GLQUAKE-site table names the seam method
  that absorbs every place the two bodies differ. What this file implements is
  the software body (screen.c) with each of render.ts's named sites replaced by
  a `getRenderer().X()` call. The full mapping, in the order SCR_UpdateScreen
  reaches them:
    * `vid.numpages = 2 + gl_triplebuffer.value` + GL_BeginRendering (
      gl_screen.c:823,848)                              -> BeginFrame
    * SCR_CalcRefdef (screen.c:219 / gl_screen.c:255)   -> SCR_CalcRefdef
    * D_EnableBackBufferAccess / D_DisableBackBufferAccess (screen.c:869, 886,
      903, 936; empty in GL)                            -> the same two names
    * GL_Set2D (gl_screen.c:873)                        -> GL_Set2D
    * SCR_TileClear (gl_screen.c:879)                   -> SCR_TileClear
    * the GL crosshair (gl_screen.c:906)                -> SCR_DrawCrosshair
    * D_UpdateRects (screen.c:940; empty in GL)         -> D_UpdateRects
    * GL_EndRendering (gl_screen.c:934) / screen.c's scr_copyeverything /
      scr_copytop / scr_vrect three-way `VID_Update (&vrect)` (screen.c:945-981)
                                                        -> EndFrame
    * SCR_ScreenShot_f (screen.c:613 / gl_screen.c:592) -> SCR_ScreenShot_f
  `CalcFov` is exported because both renderers' SCR_CalcRefdef bodies call it,
  and so are the eight `scr_*` cvars they read.
- `BeginFrame` is called after the `scr_initialized`/`con_initialized` returns
  and before the fov/viewsize change detection, which is gl_screen.c's position
  for GL_BeginRendering. gl_screen.c sets `vid.numpages` a few lines earlier
  (before `scr_copytop = 0`), but render.ts folds that assignment into
  BeginFrame, and nothing between the two points reads vid.numpages.
- Four Draw_TileClear sites in screen.c have NO counterpart in gl_screen.c and
  no seam method in render.ts, so they are ported as written and always run:
  SCR_UpdateScreen's `scr_fullupdate++ < vid.numpages` full-screen clear,
  SCR_EraseCenterString, and SCR_SetUpToDrawConsole's two clears (gl_screen.c
  keeps the two counters and the Sbar_Changed but drops the Draw_TileClear and
  the `scr_copytop = 1` beside each). All four sit inside screen.c's
  D_EnableBackBufferAccess/D_DisableBackBufferAccess bracket, i.e. before
  GL_Set2D, so a GL build reaches them with the 3D projection still current.
  Reported as a render.ts gap; adding members to render.ts is out of this
  unit's scope.
- `cl.intermission == 3` is a screen.c-only branch of the 2D ladder
  (gl_screen.c has intermission 1 and 2 only) and is likewise ported as
  written, with no seam method.
- `scr_skipupdate` is tested by screen.c's SCR_UpdateScreen and not by
  gl_screen.c's; screen_types.ts already ruled the software test is the one to
  port. Only the Win32 software video backend ever sets it. Same for
  `if (cls.state == ca_dedicated) return;` and the `oldlcd_x` check, both of
  which screen.c has and gl_screen.c does not.
- `Draw_PicFromWad`/`Draw_CachePic` return `QpicT | null` in render.ts where
  the C returns a `qpic_t *` it never checks (both C bodies Sys_Error on a
  missing lump instead of returning NULL). Every Draw_Pic call site here
  therefore carries a null guard the C does not have; a guard that fires is a
  case the C would have died in.
- `vrect_t *pconupdate` is screen.c's own file-scope pointer, only ever
  assigned NULL in v1.09. Kept, with its `if (pconupdate) D_UpdateRects
  (pconupdate)` call site, so the call order is preserved.
- `SCR_ModalMessage` returns `boolean`; the C returns `int` (1 for the
  dedicated early-out, then `key_lastpress == 'y'`) and every caller uses it as
  a truth value. Its `do { key_count = -1; Sys_SendKeyEvents (); } while (...)`
  is a synchronous spin that only ends when the platform input pump delivers
  'y', 'n' or K_ESCAPE through Key_Event -- the same shape, and the same
  never-terminates-without-a-pump behaviour, as the C.
- File-scope C statics stay module-private: `scr_ram`/`scr_net`/`scr_turtle`,
  `clearconsole`, `oldscreensize`/`oldfov`, the centerprint state,
  `scr_drawloading`, `scr_drawdialog`, `scr_notifystring`, `scr_disabled_time`,
  `pconupdate`, SCR_DrawTurtle's `static int count` and SCR_UpdateScreen's
  `static float oldscr_viewsize` / `oldlcd_x`. The externs screen.h declares
  (`scr_con_current`, `scr_conlines`, `scr_fullupdate`, `sb_lines`,
  `clearnotify`, `scr_disabled_for_loading`, `scr_skipupdate`, `scr_copytop`,
  `scr_copyeverything`, `block_drawing`, `scr_vrect`) live in
  src/client/screen_types.ts and are MUTATED there, never redeclared here.
- Hook registration (`hostClientHooks.scrInit`/`scrUpdateScreen`/
  `scrBeginLoadingPlaque`/`scrEndLoadingPlaque`/`scrDisableForLoading` and
  `svMainHooks.scrCenterTimeOff`) happens at module load, not inside SCR_Init:
  host.c calls SCR_Init through the hook, so the hook has to be in place before
  Host_Init runs. Same pattern, and same reason, as cl_main.ts's
  `registerClMainHooks()`.
- `Sbar_Changed`/`Sbar_Draw`/`Sbar_IntermissionOverlay`/`Sbar_FinaleOverlay`
  (sbar.c), `M_Draw` (menu.c) and `S_StopAllSounds`/`S_ClearBuffer`
  (snd_dma.c) are imported directly, the way screen.c calls them, not through
  hostClientHooks: only host.c needs that indirection.
- Not ported here, with the module that owns each:
  * `pcx_t` and `WritePCXfile` (screen.c) and gl_screen.c's `TargaHeader` and
    `glx`/`gly`/`glwidth`/`glheight`: they are the two SCR_ScreenShot_f bodies'
    private data, so they belong to src/ref_soft and src/ref_gl with the
    bodies.
  * `gl_triplebuffer` is gl_screen.c's cvar and is registered by the GL
    renderer, per screen_types.ts's ruling.
  * `viddef_t vid` (defined by both C files) is src/client/vid.ts's singleton.
- Dropped `#ifdef GLQUAKE` branches: every one is listed in the mapping above.
*/

import { Cmd_AddCommand } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable, Cvar_SetValue } from "../common/cvar";
import { M_PI } from "../common/mathlib";
import { host, hostBasepal, hostClientHooks } from "../common/host";
import type { QpicT } from "../common/wad";
import { Sys_Error, Sys_SendKeyEvents } from "../platform/sys";
import { svMainHooks } from "../server/sv_main";
import { CactiveT, SIGNONS, cl, cls } from "./client";
import { Con_CheckResize, Con_ClearNotify, Con_DrawConsole, Con_DrawNotify, Con_Printf, conState } from "./console";
import { K_ESCAPE, KeydestT, keyState, key_lastpress } from "./keys";
import { M_Draw } from "./menu";
import { getRenderer } from "./render";
import { Sbar_Changed, Sbar_Draw, Sbar_FinaleOverlay, Sbar_IntermissionOverlay } from "./sbar";
import { scrState, scr_vrect } from "./screen_types";
import { S_ClearBuffer, S_StopAllSounds } from "./snd_dma";
import { V_RenderView, V_UpdatePalette, lcd_x } from "./view";
import { VrectT, vid, vidBackend } from "./vid";

let oldscreensize = 0;
let oldfov = 0;

export const scr_viewsize = new CvarT("viewsize", "100", true);
export const scr_fov = new CvarT("fov", "90"); // 10 - 170
export const scr_conspeed = new CvarT("scr_conspeed", "300");
export const scr_centertime = new CvarT("scr_centertime", "2");
export const scr_showram = new CvarT("showram", "1");
export const scr_showturtle = new CvarT("showturtle", "0");
export const scr_showpause = new CvarT("showpause", "1");
export const scr_printspeed = new CvarT("scr_printspeed", "8");

let scr_initialized = false; // ready to draw

let scr_ram: QpicT | null = null;
let scr_net: QpicT | null = null;
let scr_turtle: QpicT | null = null;

let clearconsole = 0;

let pconupdate: VrectT | null = null;

let scr_drawloading = false;
let scr_disabled_time = 0;

/*
===============================================================================

CENTER PRINTING

===============================================================================
*/

let scr_centerstring = ""; // char scr_centerstring[1024]
let scr_centertime_start = 0; // for slow victory printing
let scr_centertime_off = 0;
let scr_center_lines = 0;
let scr_erase_lines = 0;
let scr_erase_center = 0;

// `start[l]` on a NUL-terminated char array: past the end reads the terminator
function strAt(s: string, i: number): number {
  return i < s.length ? s.charCodeAt(i) : 0;
}

/*
==============
SCR_CenterPrint

Called for important messages that should stay in the center of the screen
for a few moments
==============
*/
export function SCR_CenterPrint(str: string): void {
  scr_centerstring = str.slice(0, 1023); // strncpy (..., sizeof(scr_centerstring)-1)
  scr_centertime_off = scr_centertime.value;
  scr_centertime_start = cl.time;

  // count the number of lines for centering
  scr_center_lines = 1;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) scr_center_lines++;
  }
}

export function SCR_EraseCenterString(): void {
  let y: number;

  if (scr_erase_center++ > vid.numpages) {
    scr_erase_lines = 0;
    return;
  }

  if (scr_center_lines <= 4) y = (vid.height * 0.35) | 0;
  else y = 48;

  scrState.scr_copytop = 1;
  getRenderer().SCR_SoftwareTileClear(0, y, vid.width, 8 * scr_erase_lines);
}

export function SCR_DrawCenterString(): void {
  let l: number;
  let x: number;
  let y: number;
  let remaining: number;

  // the finale prints the characters one at a time
  if (cl.intermission) remaining = (scr_printspeed.value * (cl.time - scr_centertime_start)) | 0;
  else remaining = 9999;

  scr_erase_center = 0;
  let start = 0;

  if (scr_center_lines <= 4) y = (vid.height * 0.35) | 0;
  else y = 48;

  const re = getRenderer();

  for (;;) {
    // scan the width of the line
    for (l = 0; l < 40; l++) {
      const c = strAt(scr_centerstring, start + l);
      if (c === 10 || c === 0) break;
    }
    x = ((vid.width - l * 8) / 2) | 0;
    for (let j = 0; j < l; j++, x += 8) {
      re.Draw_Character(x, y, strAt(scr_centerstring, start + j));
      if (remaining-- === 0) return;
    }

    y += 8;

    while (strAt(scr_centerstring, start) !== 0 && strAt(scr_centerstring, start) !== 10) start++;

    if (strAt(scr_centerstring, start) === 0) break;
    start++; // skip the \n
  }
}

export function SCR_CheckDrawCenterString(): void {
  scrState.scr_copytop = 1;
  if (scr_center_lines > scr_erase_lines) scr_erase_lines = scr_center_lines;

  scr_centertime_off -= host.frametime;

  if (scr_centertime_off <= 0 && !cl.intermission) return;
  if (keyState.key_dest !== KeydestT.key_game) return;

  SCR_DrawCenterString();
}

//=============================================================================

/*
====================
CalcFov
====================
*/
export function CalcFov(fov_x: number, width: number, height: number): number {
  let a: number;
  let x: number;

  if (fov_x < 1 || fov_x > 179) Sys_Error("Bad fov: %f", fov_x);

  x = width / Math.tan((fov_x / 360) * M_PI);

  a = Math.atan(height / x);

  a = (a * 360) / M_PI;

  return a;
}

/*
=================
SCR_SizeUp_f

Keybinding command
=================
*/
export function SCR_SizeUp_f(): void {
  Cvar_SetValue("viewsize", scr_viewsize.value + 10);
  vid.recalc_refdef = 1;
}

/*
=================
SCR_SizeDown_f

Keybinding command
=================
*/
export function SCR_SizeDown_f(): void {
  Cvar_SetValue("viewsize", scr_viewsize.value - 10);
  vid.recalc_refdef = 1;
}

//============================================================================

/*
==================
SCR_Init
==================
*/
export function SCR_Init(): void {
  Cvar_RegisterVariable(scr_fov);
  Cvar_RegisterVariable(scr_viewsize);
  Cvar_RegisterVariable(scr_conspeed);
  Cvar_RegisterVariable(scr_showram);
  Cvar_RegisterVariable(scr_showturtle);
  Cvar_RegisterVariable(scr_showpause);
  Cvar_RegisterVariable(scr_centertime);
  Cvar_RegisterVariable(scr_printspeed);

  //
  // register our commands
  //
  Cmd_AddCommand("screenshot", SCR_ScreenShot_f);
  Cmd_AddCommand("sizeup", SCR_SizeUp_f);
  Cmd_AddCommand("sizedown", SCR_SizeDown_f);

  const re = getRenderer();
  scr_ram = re.Draw_PicFromWad("ram");
  scr_net = re.Draw_PicFromWad("net");
  scr_turtle = re.Draw_PicFromWad("turtle");

  scr_initialized = true;
}

/*
==============
SCR_DrawRam
==============
*/
export function SCR_DrawRam(): void {
  if (!scr_showram.value) return;

  const re = getRenderer();
  if (!re.r_cache_thrash) return;

  if (scr_ram) re.Draw_Pic(scr_vrect.x + 32, scr_vrect.y, scr_ram);
}

/*
==============
SCR_DrawTurtle
==============
*/
let drawTurtleCount = 0; // static int count

export function SCR_DrawTurtle(): void {
  if (!scr_showturtle.value) return;

  if (host.frametime < 0.1) {
    drawTurtleCount = 0;
    return;
  }

  drawTurtleCount++;
  if (drawTurtleCount < 3) return;

  if (scr_turtle) getRenderer().Draw_Pic(scr_vrect.x, scr_vrect.y, scr_turtle);
}

/*
==============
SCR_DrawNet
==============
*/
export function SCR_DrawNet(): void {
  if (host.realtime - cl.last_received_message < 0.3) return;
  if (cls.demoplayback) return;

  if (scr_net) getRenderer().Draw_Pic(scr_vrect.x + 64, scr_vrect.y, scr_net);
}

/*
==============
DrawPause
==============
*/
export function SCR_DrawPause(): void {
  if (!scr_showpause.value) return; // turn off for screenshots

  if (!cl.paused) return;

  const re = getRenderer();
  const pic = re.Draw_CachePic("gfx/pause.lmp");
  if (!pic) return;
  re.Draw_Pic(((vid.width - pic.width) / 2) | 0, ((vid.height - 48 - pic.height) / 2) | 0, pic);
}

/*
==============
SCR_DrawLoading
==============
*/
export function SCR_DrawLoading(): void {
  if (!scr_drawloading) return;

  const re = getRenderer();
  const pic = re.Draw_CachePic("gfx/loading.lmp");
  if (!pic) return;
  re.Draw_Pic(((vid.width - pic.width) / 2) | 0, ((vid.height - 48 - pic.height) / 2) | 0, pic);
}

//=============================================================================

/*
==================
SCR_SetUpToDrawConsole
==================
*/
export function SCR_SetUpToDrawConsole(): void {
  Con_CheckResize();

  if (scr_drawloading) return; // never a console with loading plaque

  // decide on the height of the console
  conState.con_forcedup = !cl.worldmodel || cls.signon !== SIGNONS;

  if (conState.con_forcedup) {
    scrState.scr_conlines = vid.height; // full screen
    scrState.scr_con_current = scrState.scr_conlines;
  } else if (keyState.key_dest === KeydestT.key_console) {
    scrState.scr_conlines = (vid.height / 2) | 0; // half screen
  } else {
    scrState.scr_conlines = 0; // none visible
  }

  if (scrState.scr_conlines < scrState.scr_con_current) {
    scrState.scr_con_current -= scr_conspeed.value * host.frametime;
    if (scrState.scr_conlines > scrState.scr_con_current) scrState.scr_con_current = scrState.scr_conlines;
  } else if (scrState.scr_conlines > scrState.scr_con_current) {
    scrState.scr_con_current += scr_conspeed.value * host.frametime;
    if (scrState.scr_conlines < scrState.scr_con_current) scrState.scr_con_current = scrState.scr_conlines;
  }

  if (clearconsole++ < vid.numpages) {
    scrState.scr_copytop = 1;
    getRenderer().SCR_SoftwareTileClear(0, scrState.scr_con_current | 0, vid.width, vid.height - (scrState.scr_con_current | 0));
    Sbar_Changed();
  } else if (scrState.clearnotify++ < vid.numpages) {
    scrState.scr_copytop = 1;
    getRenderer().SCR_SoftwareTileClear(0, 0, vid.width, conState.con_notifylines);
  } else {
    conState.con_notifylines = 0;
  }
}

/*
==================
SCR_DrawConsole
==================
*/
export function SCR_DrawConsole(): void {
  if (scrState.scr_con_current) {
    scrState.scr_copyeverything = 1;
    Con_DrawConsole(scrState.scr_con_current, true);
    clearconsole = 0;
  } else {
    if (keyState.key_dest === KeydestT.key_game || keyState.key_dest === KeydestT.key_message) {
      Con_DrawNotify(); // only draw notify in game
    }
  }
}

/*
==============================================================================

						SCREEN SHOTS

==============================================================================
*/

/*
==================
SCR_ScreenShot_f
==================
*/
export function SCR_ScreenShot_f(): void {
  getRenderer().SCR_ScreenShot_f();
}

//=============================================================================

/*
===============
SCR_BeginLoadingPlaque

================
*/
export function SCR_BeginLoadingPlaque(): void {
  S_StopAllSounds(true);

  if (cls.state !== CactiveT.ca_connected) return;
  if (cls.signon !== SIGNONS) return;

  // redraw with no console and the loading plaque
  Con_ClearNotify();
  scr_centertime_off = 0;
  scrState.scr_con_current = 0;

  scr_drawloading = true;
  scrState.scr_fullupdate = 0;
  Sbar_Changed();
  SCR_UpdateScreen();
  scr_drawloading = false;

  scrState.scr_disabled_for_loading = true;
  scr_disabled_time = host.realtime;
  scrState.scr_fullupdate = 0;
}

/*
===============
SCR_EndLoadingPlaque

================
*/
export function SCR_EndLoadingPlaque(): void {
  scrState.scr_disabled_for_loading = false;
  scrState.scr_fullupdate = 0;
  Con_ClearNotify();
}

//=============================================================================

let scr_notifystring = "";
let scr_drawdialog = false;

export function SCR_DrawNotifyString(): void {
  let l: number;
  let x: number;
  let y: number;

  let start = 0;

  y = (vid.height * 0.35) | 0;

  const re = getRenderer();

  for (;;) {
    // scan the width of the line
    for (l = 0; l < 40; l++) {
      const c = strAt(scr_notifystring, start + l);
      if (c === 10 || c === 0) break;
    }
    x = ((vid.width - l * 8) / 2) | 0;
    for (let j = 0; j < l; j++, x += 8) re.Draw_Character(x, y, strAt(scr_notifystring, start + j));

    y += 8;

    while (strAt(scr_notifystring, start) !== 0 && strAt(scr_notifystring, start) !== 10) start++;

    if (strAt(scr_notifystring, start) === 0) break;
    start++; // skip the \n
  }
}

/*
==================
SCR_ModalMessage

Displays a text string in the center of the screen and waits for a Y or N
keypress.
==================
*/
export function SCR_ModalMessage(text: string): boolean {
  if (cls.state === CactiveT.ca_dedicated) return true;

  scr_notifystring = text;

  // draw a fresh screen
  scrState.scr_fullupdate = 0;
  scr_drawdialog = true;
  SCR_UpdateScreen();
  scr_drawdialog = false;

  S_ClearBuffer(); // so dma doesn't loop current sound

  do {
    keyState.key_count = -1; // wait for a key down and up
    Sys_SendKeyEvents();
  } while (key_lastpress !== 121 /* 'y' */ && key_lastpress !== 110 /* 'n' */ && key_lastpress !== K_ESCAPE);

  scrState.scr_fullupdate = 0;
  SCR_UpdateScreen();

  return key_lastpress === 121; /* 'y' */
}

//=============================================================================

/*
===============
SCR_BringDownConsole

Brings the console down and fades the palettes back to normal
================
*/
export function SCR_BringDownConsole(): void {
  scr_centertime_off = 0;

  for (let i = 0; i < 20 && scrState.scr_conlines !== scrState.scr_con_current; i++) SCR_UpdateScreen();

  cl.cshifts[0].percent = 0; // no area contents palette on next frame
  const basepal = hostBasepal();
  if (basepal) vidBackend.current?.VID_SetPalette(basepal);
}

/*
==================
SCR_UpdateScreen

This is called every frame, and can also be called explicitly to flush
text to the screen.

WARNING: be very careful calling this from elsewhere, because the refresh
needs almost the entire 256k of stack space!
==================
*/
let oldscr_viewsize = 0; // static float oldscr_viewsize
let oldlcd_x = 0; // static float oldlcd_x

export function SCR_UpdateScreen(): void {
  if (scrState.scr_skipupdate || scrState.block_drawing) return;

  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;

  if (scrState.scr_disabled_for_loading) {
    if (host.realtime - scr_disabled_time > 60) {
      scrState.scr_disabled_for_loading = false;
      Con_Printf("load failed.\n");
    } else return;
  }

  if (cls.state === CactiveT.ca_dedicated) return; // stdout only

  if (!scr_initialized || !conState.con_initialized) return; // not initialized yet

  const re = getRenderer();

  re.BeginFrame();

  if (scr_viewsize.value !== oldscr_viewsize) {
    oldscr_viewsize = scr_viewsize.value;
    vid.recalc_refdef = 1;
  }

  //
  // check for vid changes
  //
  if (oldfov !== scr_fov.value) {
    oldfov = scr_fov.value;
    vid.recalc_refdef = 1;
  }

  if (oldlcd_x !== lcd_x.value) {
    oldlcd_x = lcd_x.value;
    vid.recalc_refdef = 1;
  }

  if (oldscreensize !== scr_viewsize.value) {
    oldscreensize = scr_viewsize.value;
    vid.recalc_refdef = 1;
  }

  if (vid.recalc_refdef) {
    // something changed, so reorder the screen
    re.SCR_CalcRefdef();
  }

  //
  // do 3D refresh drawing, and then update the screen
  //
  re.D_EnableBackBufferAccess(); // of all overlay stuff if drawing directly

  if (scrState.scr_fullupdate++ < vid.numpages) {
    // clear the entire screen
    scrState.scr_copyeverything = 1;
    re.SCR_SoftwareTileClear(0, 0, vid.width, vid.height);
    Sbar_Changed();
  }

  pconupdate = null;

  SCR_SetUpToDrawConsole();
  SCR_EraseCenterString();

  re.D_DisableBackBufferAccess(); // for adapters that can't stay mapped in
  //  for linear writes all the time

  vidBackend.current?.VID_LockBuffer();

  V_RenderView();

  vidBackend.current?.VID_UnlockBuffer();

  re.D_EnableBackBufferAccess(); // of all overlay stuff if drawing directly

  re.GL_Set2D();

  //
  // draw any areas not covered by the refresh
  //
  re.SCR_TileClear();

  if (scr_drawdialog) {
    Sbar_Draw();
    re.Draw_FadeScreen();
    SCR_DrawNotifyString();
    scrState.scr_copyeverything = 1;
  } else if (scr_drawloading) {
    SCR_DrawLoading();
    Sbar_Draw();
  } else if (cl.intermission === 1 && keyState.key_dest === KeydestT.key_game) {
    Sbar_IntermissionOverlay();
  } else if (cl.intermission === 2 && keyState.key_dest === KeydestT.key_game) {
    Sbar_FinaleOverlay();
    SCR_CheckDrawCenterString();
  } else if (cl.intermission === 3 && keyState.key_dest === KeydestT.key_game) {
    SCR_CheckDrawCenterString();
  } else {
    re.SCR_DrawCrosshair();

    SCR_DrawRam();
    SCR_DrawNet();
    SCR_DrawTurtle();
    SCR_DrawPause();
    SCR_CheckDrawCenterString();
    Sbar_Draw();
    SCR_DrawConsole();
    M_Draw();
  }

  re.D_DisableBackBufferAccess(); // for adapters that can't stay mapped in
  //  for linear writes all the time
  if (pconupdate) {
    re.D_UpdateRects(pconupdate);
  }

  V_UpdatePalette();

  //
  // update one of three areas
  //
  re.EndFrame();
}

/*
==================
SCR_UpdateWholeScreen
==================
*/
export function SCR_UpdateWholeScreen(): void {
  scrState.scr_fullupdate = 0;
  SCR_UpdateScreen();
}

//============================================================================
// see the file header: host.c reaches SCR_Init/SCR_UpdateScreen/the loading
// plaque through hostClientHooks, and sv_main.c's SV_SendServerinfo zeroes
// scr_centertime_off through svMainHooks.

export function registerScreenHooks(): void {
  hostClientHooks.scrInit = SCR_Init;
  hostClientHooks.scrUpdateScreen = SCR_UpdateScreen;
  hostClientHooks.scrBeginLoadingPlaque = SCR_BeginLoadingPlaque;
  hostClientHooks.scrEndLoadingPlaque = SCR_EndLoadingPlaque;
  hostClientHooks.scrDisableForLoading = () => {
    scrState.scr_disabled_for_loading = true;
  };
  svMainHooks.scrCenterTimeOff = () => {
    scr_centertime_off = 0;
  };
}

registerScreenHooks();
