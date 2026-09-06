/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/screen.h (GNU GPL v2 or later).

screen.h -- the data half only.

PORTING.md maps screen.h + screen.c + gl_screen.c to src/client/screen.ts.
screen.c and gl_screen.c each DEFINE the whole `scr_*` extern list below, and
the renderer seam methods that absorb their differences (Renderer.EndFrame,
Renderer.SCR_CalcRefdef, Renderer.SCR_TileClear, Renderer.SCR_ScreenShot_f in
src/client/render.ts) read `scr_copytop`, `scr_copyeverything`, `scr_vrect`,
`scr_fullupdate` and `sb_lines`. So the shared data lives here, in a module
both src/client/screen.ts (U051) and both renderers can import without either
renderer importing screen.ts, and screen.ts holds the SCR_* functions.

Deviations from PORTING.md / the C source:
- Every extern in this header is a scalar the C reassigns from several
  translation units, which an ESM import binding cannot do, so they become
  fields on the `scrState` holder (PORTING.md's "small exported holder"
  rule). `scr_vrect` is a struct, so it is a mutated-in-place singleton like
  `vid` and `r_refdef`.
- `scr_conlines`, `scr_fullupdate`, `clearnotify` and `sb_lines` are in this
  header but are not in the brief's list; they are here for the same reason as
  the rest: screen.c/gl_screen.c define them and console.c, sbar.c and the
  renderers read them.
- `sb_lines` is defined in sbar.c in a software build and in gl_screen.c in a
  GL build. One definition here, since only one of the two ever links in C.
- Not ported here, with the module that owns each:
  * `extern cvar_t scr_viewsize;` and the rest of the `scr_*` cvars
    (scr_fov, scr_conspeed, scr_centertime, scr_showram, scr_showturtle,
    scr_showpause, scr_printspeed) -> src/client/screen.ts (U051).
  * `gl_triplebuffer` is gl_screen.c's and is registered by the GL renderer's
    own init, not by screen.ts: src/ref_gl/gl_screen.ts (U075).
  * SCR_Init, SCR_UpdateScreen, SCR_SizeUp, SCR_SizeDown, SCR_BringDownConsole,
    SCR_CenterPrint, SCR_BeginLoadingPlaque, SCR_EndLoadingPlaque,
    SCR_ModalMessage, SCR_UpdateWholeScreen -> src/client/screen.ts (U051).
  * The GLQUAKE-only SCR_TileClear and the two SCR_ScreenShot_f bodies are
    Renderer methods; see src/client/render.ts's header table.
- `scr_skipupdate` is tested by screen.c's SCR_UpdateScreen but not by
  gl_screen.c's. Only the Win32 software video backend ever sets it, so
  screen.ts keeping the test costs nothing in a GL build; U051 should port the
  software test verbatim and note it.
*/

import { VrectT } from "./vid";

export const scr_vrect = new VrectT();

export const scrState = {
  scr_con_current: 0,
  scr_conlines: 0, // lines of console to display

  scr_fullupdate: 0, // set to 0 to force full redraw
  sb_lines: 0,

  clearnotify: 0, // set to 0 whenever notify text is drawn
  scr_disabled_for_loading: false,
  scr_skipupdate: false,

  // only the refresh window will be updated unless these variables are flagged
  scr_copytop: 0,
  scr_copyeverything: 0,

  block_drawing: false,
};
