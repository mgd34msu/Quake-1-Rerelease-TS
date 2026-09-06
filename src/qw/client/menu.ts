/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/menu.c (GNU GPL v2 or later).

menu.c -- interactive menu system (QuakeWorld)

QuakeWorld's menu.c is a wholesale-different file from WinQuake's (PORTING.md's
QuakeWorld track): most of WinQuake's menu screens are gone. Checked the C
directly rather than assuming the unit brief's guess:
- IMPLEMENTED (real Draw/Key bodies, reachable): Main, SinglePlayer,
  MultiPlayer, Options, Keys, Video, Help, Quit. SinglePlayer and MultiPlayer
  ARE present (contrary to the brief's guess) -- both are trivial one-screen
  text boxes ("QuakeWorld is for Internet play only" / a quakeworld.net URL
  pointer), reachable only from the main menu's cursor, not registered as
  their own `menu_*` console commands.
- DROPPED (forward-declared in the C, in `m_state`'s enum, referenced only
  inside commented-out `//` lines in `M_Draw`/`M_Keydown` -- never DEFINED
  anywhere in the QW client tree, not merely `#ifdef`-excluded): Load, Save,
  Setup, Net, SerialConfig, ModemConfig, LanConfig, GameOptions, Search,
  ServerList. `M_Menu_GameOptions_f`/`M_Menu_LanConfig_f`/etc. and their
  Draw/Key counterparts are not ported: there is no C body to port, and
  `M_Init` never registers a `menu_*` command for any of them either.
- `MStateT`'s ordinal values are still every one of the C enum's 19 members
  (`m_none` through `m_slist`) -- QW's own enum keeps every WinQuake ordinal,
  it just never defines a handler for most of them. `M_Draw`/`M_Keydown`'s
  switches have a case for each of the 10 dropped ordinals that does nothing,
  matching the C's commented-out call (`// M_Load_Draw ();` etc.) exactly.

Deviations from PORTING.md / the C source:
- `M_AdjustSliders`'s `case 13` (cl_hudswap) has NO `break;` before
  `case 15:` (_windowed_mouse) in the C -- verified against
  `QW/client/menu.c` line 458-460, with no `#ifdef` around either case
  (unlike WinQuake's own `menu.c`, where the whole `case 13` is `#ifdef
  _WIN32`-only and so does not exist in a portable build at all). QW's
  version is unconditional: pressing Enter/Right-arrow at options_cursor 13
  toggles `cl_hudswap` AND falls through into also toggling
  `_windowed_mouse`. Ported as a real fallthrough (no `break` between the
  two `case` bodies), per the exactly as the original rule, not "fixed".
- The "Use Mouse" item (`_windowed_mouse`, options_cursor 15) is likewise
  unconditional on this port's portable (non-`_WIN32`) path: QW's
  `M_Options_Draw` wraps only the `if (modestate == MS_WINDOWED)` braces in
  `#ifdef _WIN32`, leaving the `M_Print`/`M_DrawCheckbox` body itself
  OUTSIDE any `#ifdef` (re-checked against the C: this is a different
  `#ifdef` shape from WinQuake's own menu.c, which wraps the whole
  print+checkbox in `#ifdef _WIN32`). So on this port's Linux-only build the
  item always draws, `OPTIONS_ITEMS` is 16 (all 16 QW items, not 13 the way
  WinQuake's port is), and `M_Options_Key`'s cursor-skip-past-15 block is
  also unconditional on this path (`#ifdef _WIN32 && (modestate !=
  MS_WINDOWED) #endif` vanishes entirely, leaving a bare `if
  (options_cursor == 15)`): up/down arrows can never rest the cursor on 15,
  but Enter's fallthrough from 13 (above) still reaches it as a side effect.
- `M_Keys_Key`'s bind command format differs from WinQuake's: QW's
  `sprintf (cmd, "bind %s \"%s\"\n", ...)` leaves the key name UNQUOTED
  (WinQuake's is `"bind \"%s\" \"%s\"\n"`, both quoted -- checked both C
  files side by side). Ported literally: `` `bind ${Key_KeynumToString(k)}
  "${bindnames[...][0]}"\n` ``.
- `bindnames` is QW's own 18-entry list (checked against the C): no
  `+showscores`/`impulse 10 (change weapon)` -- wait, `impulse 10` IS
  present (index 1) -- and no `messagemode`/`messagemode2` entries at all
  (WinQuake's `bindnames` has neither either; QW's list is otherwise a
  subset ordering match). `NUMCOMMANDS = bindnames.length` (18), not a
  `sizeof` division.
- `M_Quit_Draw`'s body is a static "about QuakeWorld" credits box (`#if 1`
  branch of the C, unconditionally compiled -- not a WIN32/portable split),
  replacing WinQuake's random `quitMessage` joke box entirely. The `#else`
  branch (the one that WOULD read `quitMessage`/`msgNumber`) is genuinely
  unreachable in any build of this C file (`#if 1` is not platform-gated,
  just permanently true), the same practical situation as an `#if 0` block
  per standing order 3, so it is not exercised here -- but `quitMessage`
  (identical wording to WinQuake's own) and `menuState.msgNumber`
  (`M_Menu_Quit_f` still computes it via `rand()&7`) are still ported, since
  the C still declares/assigns them; they are simply unread by the active
  `M_Quit_Draw` body. `VSTR2(VERSION)` (the credits box's version line)
  stringizes bothdefs.h's `#define VERSION 2.40` textually to "2.40" at
  preprocess time -- hardcoded as the literal string here, matching what
  the C's preprocessor actually produces (not `String(VERSION)`, which would
  print "2.4" since `VERSION` the exported number is `2.4`).
- QW's Quit-key 'y'/'Y' case calls `CL_Disconnect(); Sys_Quit();` directly
  (`src/qw/client/cl_main.ts`'s `CL_Disconnect`, `src/platform/sys.ts`'s
  `Sys_Quit`), NOT WinQuake's `Host_Quit_f()` -- QW has no `host_cmd.ts`
  equivalent in this unit's SCOPE, and the C itself does not route through
  one either.
- `M_BuildTranslationTable`/`M_DrawTransPicTranslate` are dead code: grepped
  every QW client `.c`/`.h` file and neither is called anywhere but their
  own declaration in menu.c (WinQuake's Setup-menu color picker, the one
  place WinQuake calls them, does not exist in QW's menu.c at all). Ported
  anyway, unreferenced, per "port every function".
- Cvar reads/writes not owned by this unit's SCOPE (`viewsize`, `gamma`,
  `sensitivity`, `bgmvolume`, `volume`, `cl_forwardspeed`, `cl_backspeed`,
  `m_pitch`, `lookspring`, `lookstrafe`, `_windowed_mouse`) go through
  `Cvar_VariableValue`/`Cvar_SetValue`/`Cvar_Set` BY NAME, the same idiom
  WinQuake's own menu.ts uses and for the same reason (avoids importing
  every owner module -- view.ts, cl_input.ts, snd_dma.ts, cdaudio.ts,
  sdl.ts -- several of which this unit does not otherwise need). `cl_sbar`/
  `cl_hudswap` are the one exception: imported directly as the concrete
  `CvarT` objects from the now-landed `src/qw/client/cl_main.ts` (matching
  this track's sbar.ts sibling), since `Cvar_VariableValue` would read 0 for
  either until `CL_Init()`'s `Cvar_RegisterVariable` call has run, while
  reading `.value` off the object works regardless of registration order --
  the same reasoning that led sbar.ts to do this for `cl_sbar`/`cl_hudswap`
  too. Writes still go through `Cvar_SetValue("cl_sbar", ...)` by name,
  exactly matching the C's own call shape (`Cvar_SetValue` even when a
  direct pointer is available).
- Not registered into `hostClientHooks.mInit`/`mMenuQuitF`
  (src/common/host.ts): that shared singleton already receives WinQuake's
  `M_Init`/`M_Menu_Quit_f` from src/client/menu.ts's own module-load side
  effect, and both module trees load into the same process in this repo's
  test suite (one module registry, per the standing test-hygiene rule).
  Registering this module's versions there too would silently overwrite
  whichever one loaded second. QW's own Host_Init equivalent
  (src/qw/client/cl_main.ts's `CL_Init`, or a future qw.active-gated second
  hook slot on host.ts, out of this unit's SCOPE) should call `M_Init()`
  directly instead. Flagged as a follow-up, same as sbar.ts's.
- `M_SinglePlayer_Key`/`M_MultiPlayer_Key(key)` are old-style K&R C with no
  declared parameter type (implicit `int`) in the source; ported with an
  explicit `key: number` parameter, no behavioral difference.
*/

import { getRenderer, TOP_RANGE, BOTTOM_RANGE } from "../../client/render";
import type { QpicT } from "../../common/wad";
import { vid, vidMenuHooks, vidBackend } from "../../client/vid";
import { scrState } from "../../client/screen_types";
import {
  keyState,
  KeydestT,
  K_ESCAPE,
  K_ENTER,
  K_UPARROW,
  K_DOWNARROW,
  K_LEFTARROW,
  K_RIGHTARROW,
  K_BACKSPACE,
  K_DEL,
  Key_KeynumToString,
  Key_SetBinding,
  keybindings,
} from "../../client/keys";
import { cls, CactiveT } from "../../client/client";
import { host } from "../../common/host";
import { Cvar_SetValue, Cvar_VariableValue } from "../../common/cvar";
import { Sys_Error, Sys_Quit } from "../../platform/sys";
import { _windowed_mouse } from "../../platform/sdl";
import { Con_ToggleConsole_f } from "./console";
import { S_LocalSound, S_ExtraUpdate } from "../../client/snd_dma";
import { Cmd_AddCommand, Cbuf_AddText, Cbuf_InsertText } from "../cmd";
import { CL_NextDemo, CL_Disconnect, cl_sbar, cl_hudswap } from "./cl_main";

/*
==============================================================================

						MENU STATE

==============================================================================
*/

export enum MStateT {
  m_none,
  m_main,
  m_singleplayer,
  m_load,
  m_save,
  m_multiplayer,
  m_setup,
  m_net,
  m_options,
  m_video,
  m_keys,
  m_help,
  m_quit,
  m_serialconfig,
  m_modemconfig,
  m_lanconfig,
  m_gameoptions,
  m_search,
  m_slist,
}

// see file header: every scalar file-scope global in menu.c lives here.
export const menuState = {
  m_state: MStateT.m_none,
  // play after drawing a frame, so caching won't disrupt the sound
  m_entersound: false,
  m_recursiveDraw: false,

  m_save_demonum: 0,

  m_main_cursor: 0,

  options_cursor: 0,

  keys_cursor: 0,
  bind_grab: false,

  help_page: 0,

  msgNumber: 0,
  m_quit_prevstate: MStateT.m_none as number,
  wasInMenus: false,
};

/*
================
M_DrawCharacter

Draws one solid graphics character
================
*/
export function M_DrawCharacter(cx: number, line: number, num: number): void {
  getRenderer().Draw_Character(cx + ((vid.width - 320) >> 1), line, num);
}

export function M_Print(cx: number, cy: number, str: string): void {
  let x = cx;
  for (let i = 0; i < str.length; i++) {
    M_DrawCharacter(x, cy, str.charCodeAt(i) + 128);
    x += 8;
  }
}

export function M_PrintWhite(cx: number, cy: number, str: string): void {
  let x = cx;
  for (let i = 0; i < str.length; i++) {
    M_DrawCharacter(x, cy, str.charCodeAt(i));
    x += 8;
  }
}

// not a ported C name; menu.c's real callers assume Draw_CachePic always
// succeeds (a missing lump would already have called Sys_Error inside
// W_GetLumpName in the C), so this is a strict-null-check adaptation only,
// same idiom src/client/menu.ts's own `cachePic` uses.
function cachePic(path: string): QpicT {
  const p = getRenderer().Draw_CachePic(path);
  if (p === null) Sys_Error("cachePic: couldn't load %s", path);
  return p;
}

export function M_DrawTransPic(x: number, y: number, pic: QpicT): void {
  getRenderer().Draw_TransPic(x + ((vid.width - 320) >> 1), y, pic);
}

export function M_DrawPic(x: number, y: number, pic: QpicT): void {
  getRenderer().Draw_Pic(x + ((vid.width - 320) >> 1), y, pic);
}

export const identityTable = new Uint8Array(256);
export const translationTable = new Uint8Array(256);

// dead code -- see file header
export function M_BuildTranslationTable(top: number, bottom: number): void {
  for (let j = 0; j < 256; j++) identityTable[j] = j;
  translationTable.set(identityTable);

  // the artists made some backwards ranges. sigh.
  if (top < 128) {
    for (let j = 0; j < 16; j++) translationTable[TOP_RANGE + j] = identityTable[top + j];
  } else {
    for (let j = 0; j < 16; j++) translationTable[TOP_RANGE + j] = identityTable[top + 15 - j];
  }

  if (bottom < 128) {
    for (let j = 0; j < 16; j++) translationTable[BOTTOM_RANGE + j] = identityTable[bottom + j];
  } else {
    for (let j = 0; j < 16; j++) translationTable[BOTTOM_RANGE + j] = identityTable[bottom + 15 - j];
  }
}

// dead code -- see file header
export function M_DrawTransPicTranslate(x: number, y: number, pic: QpicT): void {
  getRenderer().Draw_TransPicTranslate(x + ((vid.width - 320) >> 1), y, pic, translationTable);
}

export function M_DrawTextBox(x: number, y: number, width: number, lines: number): void {
  // draw left side
  let cx = x;
  let cy = y;
  let p = cachePic("gfx/box_tl.lmp");
  M_DrawTransPic(cx, cy, p);
  p = cachePic("gfx/box_ml.lmp");
  for (let n = 0; n < lines; n++) {
    cy += 8;
    M_DrawTransPic(cx, cy, p);
  }
  p = cachePic("gfx/box_bl.lmp");
  M_DrawTransPic(cx, cy + 8, p);

  // draw middle
  cx += 8;
  let w = width;
  while (w > 0) {
    cy = y;
    p = cachePic("gfx/box_tm.lmp");
    M_DrawTransPic(cx, cy, p);
    p = cachePic("gfx/box_mm.lmp");
    for (let n = 0; n < lines; n++) {
      cy += 8;
      if (n === 1) p = cachePic("gfx/box_mm2.lmp");
      M_DrawTransPic(cx, cy, p);
    }
    p = cachePic("gfx/box_bm.lmp");
    M_DrawTransPic(cx, cy + 8, p);
    w -= 2;
    cx += 16;
  }

  // draw right side
  cy = y;
  p = cachePic("gfx/box_tr.lmp");
  M_DrawTransPic(cx, cy, p);
  p = cachePic("gfx/box_mr.lmp");
  for (let n = 0; n < lines; n++) {
    cy += 8;
    M_DrawTransPic(cx, cy, p);
  }
  p = cachePic("gfx/box_br.lmp");
  M_DrawTransPic(cx, cy + 8, p);
}

//=============================================================================

/*
================
M_ToggleMenu_f
================
*/
export function M_ToggleMenu_f(): void {
  menuState.m_entersound = true;

  if (keyState.key_dest === KeydestT.key_menu) {
    if (menuState.m_state !== MStateT.m_main) {
      M_Menu_Main_f();
      return;
    }
    keyState.key_dest = KeydestT.key_game;
    menuState.m_state = MStateT.m_none;
    return;
  }
  if (keyState.key_dest === KeydestT.key_console) {
    Con_ToggleConsole_f();
  } else {
    M_Menu_Main_f();
  }
}

//=============================================================================
/* MAIN MENU */

export const MAIN_ITEMS = 5;

export function M_Menu_Main_f(): void {
  if (keyState.key_dest !== KeydestT.key_menu) {
    menuState.m_save_demonum = cls.demonum;
    cls.demonum = -1;
  }
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_main;
  menuState.m_entersound = true;
}

export function M_Main_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/ttl_main.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);
  M_DrawTransPic(72, 32, cachePic("gfx/mainmenu.lmp"));

  const f = Math.trunc(host.realtime * 10) % 6;

  M_DrawTransPic(54, 32 + menuState.m_main_cursor * 20, cachePic(`gfx/menudot${f + 1}.lmp`));
}

export function M_Main_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      keyState.key_dest = KeydestT.key_game;
      menuState.m_state = MStateT.m_none;
      cls.demonum = menuState.m_save_demonum;
      if (cls.demonum !== -1 && !cls.demoplayback && cls.state === CactiveT.ca_disconnected) CL_NextDemo();
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_main_cursor++;
      if (menuState.m_main_cursor >= MAIN_ITEMS) menuState.m_main_cursor = 0;
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_main_cursor--;
      if (menuState.m_main_cursor < 0) menuState.m_main_cursor = MAIN_ITEMS - 1;
      break;

    case K_ENTER:
      menuState.m_entersound = true;

      switch (menuState.m_main_cursor) {
        case 0:
          M_Menu_SinglePlayer_f();
          break;

        case 1:
          M_Menu_MultiPlayer_f();
          break;

        case 2:
          M_Menu_Options_f();
          break;

        case 3:
          M_Menu_Help_f();
          break;

        case 4:
          M_Menu_Quit_f();
          break;
      }
  }
}

//=============================================================================
/* OPTIONS MENU */

// see file header: OPTIONS_ITEMS is 16 on this port's portable path (the
// "Use Mouse" item is unconditional here, unlike WinQuake's own menu.ts).
export const OPTIONS_ITEMS = 16;

export const SLIDER_RANGE = 10;

export function M_Menu_Options_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_options;
  menuState.m_entersound = true;
}

export function M_AdjustSliders(dir: number): void {
  S_LocalSound("misc/menu3.wav");

  switch (menuState.options_cursor) {
    case 3: {
      // screen size
      let v = Cvar_VariableValue("viewsize") + dir * 10;
      if (v < 30) v = 30;
      if (v > 120) v = 120;
      Cvar_SetValue("viewsize", v);
      break;
    }
    case 4: {
      // gamma
      let v = Cvar_VariableValue("gamma") - dir * 0.05;
      if (v < 0.5) v = 0.5;
      if (v > 1) v = 1;
      Cvar_SetValue("gamma", v);
      break;
    }
    case 5: {
      // mouse speed
      let v = Cvar_VariableValue("sensitivity") + dir * 0.5;
      if (v < 1) v = 1;
      if (v > 11) v = 11;
      Cvar_SetValue("sensitivity", v);
      break;
    }
    case 6: {
      // music volume -- non-_WIN32 step is 0.1 (the _WIN32 branch used 1.0, dropped)
      let v = Cvar_VariableValue("bgmvolume") + dir * 0.1;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      Cvar_SetValue("bgmvolume", v);
      break;
    }
    case 7: {
      // sfx volume
      let v = Cvar_VariableValue("volume") + dir * 0.1;
      if (v < 0) v = 0;
      if (v > 1) v = 1;
      Cvar_SetValue("volume", v);
      break;
    }

    case 8: // allways run
      if (Cvar_VariableValue("cl_forwardspeed") > 200) {
        Cvar_SetValue("cl_forwardspeed", 200);
        Cvar_SetValue("cl_backspeed", 200);
      } else {
        Cvar_SetValue("cl_forwardspeed", 400);
        Cvar_SetValue("cl_backspeed", 400);
      }
      break;

    case 9: // invert mouse
      Cvar_SetValue("m_pitch", -Cvar_VariableValue("m_pitch"));
      break;

    case 10: // lookspring
      Cvar_SetValue("lookspring", Cvar_VariableValue("lookspring") ? 0 : 1);
      break;

    case 11: // lookstrafe
      Cvar_SetValue("lookstrafe", Cvar_VariableValue("lookstrafe") ? 0 : 1);
      break;

    case 12:
      Cvar_SetValue("cl_sbar", cl_sbar.value ? 0 : 1);
      break;

    // see file header: no `break;` here in the C -- this falls through into
    // case 15 unconditionally. Ported as a real fallthrough, not a bug fix.
    case 13:
      Cvar_SetValue("cl_hudswap", cl_hudswap.value ? 0 : 1);

    // eslint/tsc would flag an intentional fallthrough with no `break` as
    // unusual, but there is no `case 14` in the C's switch at all (options
    // 14 - Video Options - is only ever handled by M_Options_Key's own
    // K_ENTER dispatch, never through M_AdjustSliders), so falling through
    // here lands directly on case 15, exactly as the C does.
    // src/platform/sdl.ts's mouse-capture policy no longer reads this cvar
    // (capture now follows window focus + key_dest/fullscreen -- see
    // `_windowed_mouse`'s own header comment in sdl.ts). This menu item still
    // toggles and displays the cvar exactly as the C does, for config-file
    // compatibility with a saved `_windowed_mouse "0"|"1"`; it is otherwise
    // inert. Not fixed/removed here -- exact fidelity to the C, per
    // standing order 4.
    case 15: // _windowed_mouse
      Cvar_SetValue("_windowed_mouse", _windowed_mouse.value ? 0 : 1);
      break;
  }
}

export function M_DrawSlider(x: number, y: number, range: number): void {
  let r = range;
  if (r < 0) r = 0;
  if (r > 1) r = 1;
  M_DrawCharacter(x - 8, y, 128);
  let i = 0;
  for (; i < SLIDER_RANGE; i++) M_DrawCharacter(x + i * 8, y, 129);
  M_DrawCharacter(x + i * 8, y, 130);
  M_DrawCharacter(Math.trunc(x + (SLIDER_RANGE - 1) * 8 * r), y, 131);
}

export function M_DrawCheckbox(x: number, y: number, on: boolean): void {
  // #if 0 M_DrawCharacter(...) block dropped silently, per standing order 3
  if (on) M_Print(x, y, "on");
  else M_Print(x, y, "off");
}

export function M_Options_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_option.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  M_Print(16, 32, "    Customize controls");
  M_Print(16, 40, "         Go to console");
  M_Print(16, 48, "     Reset to defaults");

  M_Print(16, 56, "           Screen size");
  let r = (Cvar_VariableValue("viewsize") - 30) / (120 - 30);
  M_DrawSlider(220, 56, r);

  M_Print(16, 64, "            Brightness");
  r = (1.0 - Cvar_VariableValue("gamma")) / 0.5;
  M_DrawSlider(220, 64, r);

  M_Print(16, 72, "           Mouse Speed");
  r = (Cvar_VariableValue("sensitivity") - 1) / 10;
  M_DrawSlider(220, 72, r);

  M_Print(16, 80, "       CD Music Volume");
  r = Cvar_VariableValue("bgmvolume");
  M_DrawSlider(220, 80, r);

  M_Print(16, 88, "          Sound Volume");
  r = Cvar_VariableValue("volume");
  M_DrawSlider(220, 88, r);

  M_Print(16, 96, "            Always Run");
  M_DrawCheckbox(220, 96, Cvar_VariableValue("cl_forwardspeed") > 200);

  M_Print(16, 104, "          Invert Mouse");
  M_DrawCheckbox(220, 104, Cvar_VariableValue("m_pitch") < 0);

  M_Print(16, 112, "            Lookspring");
  M_DrawCheckbox(220, 112, Cvar_VariableValue("lookspring") !== 0);

  M_Print(16, 120, "            Lookstrafe");
  M_DrawCheckbox(220, 120, Cvar_VariableValue("lookstrafe") !== 0);

  M_Print(16, 128, "    Use old status bar");
  M_DrawCheckbox(220, 128, cl_sbar.value !== 0);

  M_Print(16, 136, "      HUD on left side");
  M_DrawCheckbox(220, 136, cl_hudswap.value !== 0);

  if (vidMenuHooks.vid_menudrawfn) M_Print(16, 144, "         Video Options");

  // see file header: unconditional on this port's portable path (the
  // `#ifdef _WIN32 if (modestate == MS_WINDOWED)` wrapper vanishes,
  // leaving just this print+checkbox).
  M_Print(16, 152, "             Use Mouse");
  M_DrawCheckbox(220, 152, _windowed_mouse.value !== 0);

  // cursor
  M_DrawCharacter(200, 32 + menuState.options_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
}

export function M_Options_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_Main_f();
      break;

    case K_ENTER:
      menuState.m_entersound = true;
      switch (menuState.options_cursor) {
        case 0:
          M_Menu_Keys_f();
          break;
        case 1:
          menuState.m_state = MStateT.m_none;
          Con_ToggleConsole_f();
          break;
        case 2:
          Cbuf_AddText("exec default.cfg\n");
          break;
        case 14:
          M_Menu_Video_f();
          break;
        default:
          M_AdjustSliders(1);
          break;
      }
      return;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.options_cursor--;
      if (menuState.options_cursor < 0) menuState.options_cursor = OPTIONS_ITEMS - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.options_cursor++;
      if (menuState.options_cursor >= OPTIONS_ITEMS) menuState.options_cursor = 0;
      break;

    case K_LEFTARROW:
      M_AdjustSliders(-1);
      break;

    case K_RIGHTARROW:
      M_AdjustSliders(1);
      break;
  }

  if (menuState.options_cursor === 14 && !vidMenuHooks.vid_menudrawfn) {
    if (k === K_UPARROW) menuState.options_cursor = 13;
    else menuState.options_cursor = 0;
  }

  // see file header: unconditional on this port's portable path.
  if (menuState.options_cursor === 15) {
    if (k === K_UPARROW) menuState.options_cursor = 14;
    else menuState.options_cursor = 0;
  }
}

//=============================================================================
/* KEYS MENU */

// QW's own 18-entry list -- see file header
export const bindnames: Array<[string, string]> = [
  ["+attack", "attack"],
  ["impulse 10", "change weapon"],
  ["+jump", "jump / swim up"],
  ["+forward", "walk forward"],
  ["+back", "backpedal"],
  ["+left", "turn left"],
  ["+right", "turn right"],
  ["+speed", "run"],
  ["+moveleft", "step left"],
  ["+moveright", "step right"],
  ["+strafe", "sidestep"],
  ["+lookup", "look up"],
  ["+lookdown", "look down"],
  ["centerview", "center view"],
  ["+mlook", "mouse look"],
  ["+klook", "keyboard look"],
  ["+moveup", "swim up"],
  ["+movedown", "swim down"],
];

export const NUMCOMMANDS = bindnames.length;

export function M_Menu_Keys_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_keys;
  menuState.m_entersound = true;
}

export function M_FindKeysForCommand(command: string, twokeys: [number, number]): void {
  twokeys[0] = -1;
  twokeys[1] = -1;
  let count = 0;

  for (let j = 0; j < 256; j++) {
    const b = keybindings[j];
    if (!b) continue;
    if (b.startsWith(command)) {
      twokeys[count] = j;
      count++;
      if (count === 2) break;
    }
  }
}

export function M_UnbindCommand(command: string): void {
  for (let j = 0; j < 256; j++) {
    const b = keybindings[j];
    if (!b) continue;
    if (b.startsWith(command)) Key_SetBinding(j, "");
  }
}

export function M_Keys_Draw(): void {
  const p = cachePic("gfx/ttl_cstm.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  if (menuState.bind_grab) M_Print(12, 32, "Press a key or button for this action");
  else M_Print(18, 32, "Enter to change, backspace to clear");

  // search for known bindings
  for (let i = 0; i < NUMCOMMANDS; i++) {
    const y = 48 + 8 * i;

    M_Print(16, y, bindnames[i][1]);

    const keys: [number, number] = [-1, -1];
    M_FindKeysForCommand(bindnames[i][0], keys);

    if (keys[0] === -1) {
      M_Print(140, y, "???");
    } else {
      const name = Key_KeynumToString(keys[0]);
      M_Print(140, y, name);
      const x = name.length * 8;
      if (keys[1] !== -1) {
        M_Print(140 + x + 8, y, "or");
        M_Print(140 + x + 32, y, Key_KeynumToString(keys[1]));
      }
    }
  }

  if (menuState.bind_grab) M_DrawCharacter(130, 48 + menuState.keys_cursor * 8, "=".charCodeAt(0));
  else M_DrawCharacter(130, 48 + menuState.keys_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
}

const K_GRAVE = "`".charCodeAt(0);

export function M_Keys_Key(k: number): void {
  if (menuState.bind_grab) {
    // defining a key
    S_LocalSound("misc/menu1.wav");
    if (k === K_ESCAPE) {
      menuState.bind_grab = false;
    } else if (k !== K_GRAVE) {
      // see file header: key name is NOT quoted here, unlike WinQuake's
      // M_Keys_Key -- matches QW's own sprintf format exactly.
      const cmd = `bind ${Key_KeynumToString(k)} "${bindnames[menuState.keys_cursor][0]}"\n`;
      Cbuf_InsertText(cmd);
    }

    menuState.bind_grab = false;
    return;
  }

  switch (k) {
    case K_ESCAPE:
      M_Menu_Options_f();
      break;

    case K_LEFTARROW:
    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.keys_cursor--;
      if (menuState.keys_cursor < 0) menuState.keys_cursor = NUMCOMMANDS - 1;
      break;

    case K_DOWNARROW:
    case K_RIGHTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.keys_cursor++;
      if (menuState.keys_cursor >= NUMCOMMANDS) menuState.keys_cursor = 0;
      break;

    case K_ENTER: {
      // go into bind mode
      const keys: [number, number] = [-1, -1];
      M_FindKeysForCommand(bindnames[menuState.keys_cursor][0], keys);
      S_LocalSound("misc/menu2.wav");
      if (keys[1] !== -1) M_UnbindCommand(bindnames[menuState.keys_cursor][0]);
      menuState.bind_grab = true;
      break;
    }

    case K_BACKSPACE: // delete bindings
    case K_DEL: // delete bindings
      S_LocalSound("misc/menu2.wav");
      M_UnbindCommand(bindnames[menuState.keys_cursor][0]);
      break;
  }
}

//=============================================================================
/* VIDEO MENU */

export function M_Menu_Video_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_video;
  menuState.m_entersound = true;
}

export function M_Video_Draw(): void {
  vidMenuHooks.vid_menudrawfn?.();
}

export function M_Video_Key(key: number): void {
  vidMenuHooks.vid_menukeyfn?.(key);
}

//=============================================================================
/* HELP MENU */

export const NUM_HELP_PAGES = 6;

export function M_Menu_Help_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_help;
  menuState.m_entersound = true;
  menuState.help_page = 0;
}

export function M_Help_Draw(): void {
  M_DrawPic(0, 0, cachePic(`gfx/help${menuState.help_page}.lmp`));
}

export function M_Help_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Main_f();
      break;

    case K_UPARROW:
    case K_RIGHTARROW:
      menuState.m_entersound = true;
      menuState.help_page++;
      if (menuState.help_page >= NUM_HELP_PAGES) menuState.help_page = 0;
      break;

    case K_DOWNARROW:
    case K_LEFTARROW:
      menuState.m_entersound = true;
      menuState.help_page--;
      if (menuState.help_page < 0) menuState.help_page = NUM_HELP_PAGES - 1;
      break;
  }
}

//=============================================================================
/* QUIT MENU */

// dead: only the never-compiled `#else` half of M_Quit_Draw would read this
// (see file header). Ported anyway since M_Menu_Quit_f still assigns
// menuState.msgNumber from it (the C's own dead-but-present bookkeeping).
export const quitMessage: string[] = [
  /* .........1.........2.... */
  "  Are you gonna quit    ",
  "  this game just like   ",
  "   everything else?     ",
  "                        ",

  " Milord, methinks that  ",
  "   thou art a lowly     ",
  " quitter. Is this true? ",
  "                        ",

  " Do I need to bust your ",
  "  face open for trying  ",
  "        to quit?        ",
  "                        ",

  " Man, I oughta smack you",
  "   for trying to quit!  ",
  "     Press Y to get     ",
  "      smacked out.      ",

  " Press Y to quit like a ",
  "   big loser in life.   ",
  "  Press N to stay proud ",
  "    and successful!     ",

  "   If you press Y to    ",
  "  quit, I will summon   ",
  "  Satan all over your   ",
  "      hard drive!       ",

  "  Um, Asmodeus dislikes ",
  " his children trying to ",
  " quit. Press Y to return",
  "   to your Tinkertoys.  ",

  "  If you quit now, I'll ",
  "  throw a blanket-party ",
  "   for you next time!   ",
  "                        ",
];

// menu.c calls libc rand() directly here, not a QuakeC builtin; mathlib.ts
// deliberately provides no such wrapper. Local Math.random()-backed
// stand-in, per PORTING.md's rand()->Math.random() idiom -- same as
// WinQuake's menu.ts's own `menuRand`.
function menuRand(): number {
  return Math.floor(Math.random() * 0x7fff);
}

export function M_Menu_Quit_f(): void {
  if (menuState.m_state === MStateT.m_quit) return;
  menuState.wasInMenus = keyState.key_dest === KeydestT.key_menu;
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_quit_prevstate = menuState.m_state;
  menuState.m_state = MStateT.m_quit;
  menuState.m_entersound = true;
  menuState.msgNumber = menuRand() & 7;
}

const CHAR_LOWER_N = "n".charCodeAt(0);
const CHAR_UPPER_N = "N".charCodeAt(0);
const CHAR_LOWER_Y = "y".charCodeAt(0);
const CHAR_UPPER_Y = "Y".charCodeAt(0);

export function M_Quit_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
    case CHAR_LOWER_N:
    case CHAR_UPPER_N:
      if (menuState.wasInMenus) {
        menuState.m_state = menuState.m_quit_prevstate;
        menuState.m_entersound = true;
      } else {
        keyState.key_dest = KeydestT.key_game;
        menuState.m_state = MStateT.m_none;
      }
      break;

    case CHAR_UPPER_Y:
    case CHAR_LOWER_Y:
      // see file header: QW calls CL_Disconnect()/Sys_Quit() directly, not
      // Host_Quit_f()
      keyState.key_dest = KeydestT.key_console;
      CL_Disconnect();
      Sys_Quit();
      break;

    default:
      break;
  }
}

// see file header: the credits box (`#if 1` in the C), the only M_Quit_Draw
// body this port has -- VSTR2(VERSION) is stringized to the literal "2.40"
// at preprocess time in the C.
const quitCreditsLines: string[] = [
  "0            QuakeWorld",
  "1    version 2.40 by id Software",
  "0Programming",
  "1 John Carmack    Michael Abrash",
  "1 John Cash       Christian Antkow",
  "0Additional Programming",
  "1 Dave 'Zoid' Kirsch",
  "1 Jack 'morbid' Mathews",
  "0Id Software is not responsible for",
  "0providing technical support for",
  "0QUAKEWORLD(tm). (c)1996 Id Software,",
  "0Inc.  All Rights Reserved.",
  "0QUAKEWORLD(tm) is a trademark of Id",
  "0Software, Inc.",
  "1NOTICE: THE COPYRIGHT AND TRADEMARK",
  "1NOTICES APPEARING  IN YOUR COPY OF",
  "1QUAKE(r) ARE NOT MODIFIED BY THE USE",
  "1OF QUAKEWORLD(tm) AND REMAIN IN FULL",
  "1FORCE.",
  "0NIN(r) is a registered trademark",
  "0licensed to Nothing Interactive, Inc.",
  "0All rights reserved. Press y to exit",
];

export function M_Quit_Draw(): void {
  if (menuState.wasInMenus) {
    menuState.m_state = menuState.m_quit_prevstate;
    menuState.m_recursiveDraw = true;
    M_Draw();
    menuState.m_state = MStateT.m_quit;
  }

  M_DrawTextBox(0, 0, 38, 23);
  let y = 12;
  for (const line of quitCreditsLines) {
    if (line[0] === "0") M_PrintWhite(16, y, line.slice(1));
    else M_Print(16, y, line.slice(1));
    y += 8;
  }
}

//=============================================================================
/* SINGLE PLAYER (QW: an "Internet play only" notice, not a real menu) */

export function M_Menu_SinglePlayer_f(): void {
  menuState.m_state = MStateT.m_singleplayer;
}

export function M_SinglePlayer_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/ttl_sgl.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  M_DrawTextBox(60, 10 * 8, 23, 4);
  M_PrintWhite(92, 12 * 8, "QuakeWorld is for");
  M_PrintWhite(88, 13 * 8, "Internet play only");
}

export function M_SinglePlayer_Key(key: number): void {
  if (key === K_ESCAPE || key === K_ENTER) menuState.m_state = MStateT.m_main;
}

//=============================================================================
/* MULTIPLAYER (QW: a quakeworld.net/quakespy.com pointer, not a real menu) */

export function M_Menu_MultiPlayer_f(): void {
  menuState.m_state = MStateT.m_multiplayer;
}

export function M_MultiPlayer_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  M_DrawTextBox(46, 8 * 8, 27, 9);
  M_PrintWhite(72, 10 * 8, "If you want to find QW  ");
  M_PrintWhite(72, 11 * 8, "games, head on over to: ");
  M_Print(72, 12 * 8, "   www.quakeworld.net   ");
  M_PrintWhite(72, 13 * 8, "          or            ");
  M_Print(72, 14 * 8, "   www.quakespy.com     ");
  M_PrintWhite(72, 15 * 8, "For pointers on getting ");
  M_PrintWhite(72, 16 * 8, "        started!        ");
}

export function M_MultiPlayer_Key(key: number): void {
  if (key === K_ESCAPE || key === K_ENTER) menuState.m_state = MStateT.m_main;
}

//=============================================================================
/* Menu Subsystem */

export function M_Init(): void {
  Cmd_AddCommand("togglemenu", M_ToggleMenu_f);

  Cmd_AddCommand("menu_main", M_Menu_Main_f);
  Cmd_AddCommand("menu_options", M_Menu_Options_f);
  Cmd_AddCommand("menu_keys", M_Menu_Keys_f);
  Cmd_AddCommand("menu_video", M_Menu_Video_f);
  Cmd_AddCommand("help", M_Menu_Help_f);
  Cmd_AddCommand("menu_quit", M_Menu_Quit_f);
}

export function M_Draw(): void {
  if (menuState.m_state === MStateT.m_none || keyState.key_dest !== KeydestT.key_menu) return;

  if (!menuState.m_recursiveDraw) {
    scrState.scr_copyeverything = 1;

    if (scrState.scr_con_current) {
      getRenderer().Draw_ConsoleBackground(vid.height);
      vidBackend.current?.VID_UnlockBuffer();
      S_ExtraUpdate();
      vidBackend.current?.VID_LockBuffer();
    } else {
      getRenderer().Draw_FadeScreen();
    }

    scrState.scr_fullupdate = 0;
  } else {
    menuState.m_recursiveDraw = false;
  }

  switch (menuState.m_state) {
    case MStateT.m_main:
      M_Main_Draw();
      break;

    case MStateT.m_singleplayer:
      M_SinglePlayer_Draw();
      break;

    case MStateT.m_multiplayer:
      M_MultiPlayer_Draw();
      break;

    case MStateT.m_options:
      M_Options_Draw();
      break;

    case MStateT.m_keys:
      M_Keys_Draw();
      break;

    case MStateT.m_video:
      M_Video_Draw();
      break;

    case MStateT.m_help:
      M_Help_Draw();
      break;

    case MStateT.m_quit:
      M_Quit_Draw();
      break;

    // dropped: Load/Save/Setup/Net/SerialConfig/ModemConfig/LanConfig/
    // GameOptions/Search/ServerList -- no C body exists for any of them;
    // see file header.
    case MStateT.m_load:
    case MStateT.m_save:
    case MStateT.m_setup:
    case MStateT.m_net:
    case MStateT.m_serialconfig:
    case MStateT.m_modemconfig:
    case MStateT.m_lanconfig:
    case MStateT.m_gameoptions:
    case MStateT.m_search:
    case MStateT.m_slist:
      break;

    // menuState.m_state is narrowed to exclude m_none by the early return
    // above (TS retains that across the calls in between), so the C's
    // `case m_none: break;` -- already a no-op -- is provably unreachable
    // here and omitted rather than a type error (same as src/client/
    // menu.ts's own M_Draw).
  }

  if (menuState.m_entersound) {
    S_LocalSound("misc/menu2.wav");
    menuState.m_entersound = false;
  }

  vidBackend.current?.VID_UnlockBuffer();
  S_ExtraUpdate();
  vidBackend.current?.VID_LockBuffer();
}

export function M_Keydown(key: number): void {
  switch (menuState.m_state) {
    case MStateT.m_none:
      return;

    case MStateT.m_main:
      M_Main_Key(key);
      return;

    case MStateT.m_singleplayer:
      M_SinglePlayer_Key(key);
      return;

    case MStateT.m_multiplayer:
      M_MultiPlayer_Key(key);
      return;

    case MStateT.m_options:
      M_Options_Key(key);
      return;

    case MStateT.m_keys:
      M_Keys_Key(key);
      return;

    case MStateT.m_video:
      M_Video_Key(key);
      return;

    case MStateT.m_help:
      M_Help_Key(key);
      return;

    case MStateT.m_quit:
      M_Quit_Key(key);
      return;

    // dropped -- see file header and M_Draw's identical list
    case MStateT.m_load:
    case MStateT.m_save:
    case MStateT.m_setup:
    case MStateT.m_net:
    case MStateT.m_serialconfig:
    case MStateT.m_modemconfig:
    case MStateT.m_lanconfig:
    case MStateT.m_gameoptions:
      return;

    case MStateT.m_search:
      // the C's own `case m_search:` falls to `break;`, not `return;` --
      // ported exactly (a no-op difference, since M_Keydown returns void
      // either way and this is the last statement in the function).
      break;

    case MStateT.m_slist:
      return;
  }
}
