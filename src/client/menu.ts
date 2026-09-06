/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/menu.c and WinQuake/menu.h (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:

- `host_time` (server.h's `extern double host_time`, defined in host.c,
  incremented by `host_frametime` in Host_Frame) is `host.time` on this port's
  `host` singleton (src/common/host.ts); the brief's "realtime = host.realtime"
  ruling covers the OTHER C global, plain `realtime`, which stays `host.realtime`
  here. menu.c uses `host_time` only for the four blinking "gfx/menudot%i.lmp"
  frame calculations and `realtime` for every text-cursor blink and timeout, and
  this port keeps that exact split.
- Cvars menu.c only ever reads/sets through a `cvar_t` global it doesn't own
  (scr_viewsize, v_gamma, sensitivity, bgmvolume, volume, cl_forwardspeed,
  cl_backspeed, m_pitch, lookspring, lookstrafe, coop, teamplay, skill,
  fraglimit, timelimit, cl_name, cl_color, hostname) are read/set BY NAME
  through cvar.ts's Cvar_VariableValue/Cvar_VariableString/Cvar_Set/
  Cvar_SetValue, exactly as ruled: this avoids importing every owner module
  (screen.ts, snd_dma.ts, cdaudio.ts, cl_input.ts, cl_main.ts, host.ts,
  net_main.ts), several of which have not landed yet. `_cl_name`/`_cl_color`
  are the cvars' registered names (see cl_main.ts's own header note); `viewsize`
  and `gamma` are scr_viewsize's/v_gamma's registered names, not their C
  variable names. `registered` (a `CvarT` already exported by common.ts) and
  the plain `rogue`/`hipnotic` booleans are imported directly instead, per the
  brief's landed-module list.
- `serialAvailable`/`ipxAvailable` are not exported by net_main.ts at all (its
  own header: dropped for every consumer, not just this one, since net_ser and
  IPX were never ported). They are local `false` constants here. `my_ipx_address`
  is likewise local and always `""`; the branch that would print it
  (M_LanConfig_Draw's IPXConfig() case) is unreachable because ipxAvailable is
  always false and M_Net_Key's retry loop (see below) never leaves the cursor
  on the IPX item.
- `net_hostport` (net_main.ts) is `export let` with no exported setter, and
  net_main.ts is a landed module outside this unit's SCOPE. M_ConfigureNetSubsystem
  can't reassign it directly (`net_hostport = lanConfig_port;` in the C), so it
  queues a `port <n>` command instead (NET_Port_f sets net_hostport the same way
  Cbuf-queued commands normally reach this subsystem). Side effect: NET_Port_f
  also updates DEFAULTnet_hostport, which the C's direct assignment did not do;
  a follow-up could add `setNetHostport` to net_main.ts to close this gap.
- `slistSilent`/`slistLocal` (net_main.ts) are likewise `export let` with no
  setter. M_Menu_Search_f can't set them to `true`/`false` before calling
  NET_Slist_f, so the search runs in NET_Slist_f's default verbose,
  not-local-restricted mode instead of the silent/global-only mode the C
  requests. Documented here rather than worked around outside SCOPE.
- `Draw_CachePic` returns `QpicT | null` on this port's Renderer (render.ts),
  unlike the C's `qpic_t *` (never null-checked in menu.c, since the pics are
  assumed always present in gfx.wad/the paks). The private `cachePic()` helper
  below calls `Sys_Error` if a pic is missing, preserving that assumption while
  satisfying strict null checking; it is not a ported C name.
- `MStateT` keeps `m_serialconfig`/`m_modemconfig` at their original ordinal
  positions for enum fidelity, but M_SerialConfig_Draw/Key and
  M_ModemConfig_Draw/Key are DROPPED (net_ser.c was not ported, per
  PORTING.md/the unit brief). M_Draw's and M_Keydown's switches handle both
  ordinals as no-ops; they are unreachable in practice because M_Net_Key's
  retry loop never leaves the cursor on the serial/modem items (serialAvailable
  is always false). M_MENU_SERIALCONFIG_F, the serial/modem config screens
  themselves, and the `#if 0` M_DrawCheckbox block are silently dropped.
- Windows-only (`_WIN32`) branches are dropped, taking the portable path per
  PORTING.md's idiom map: OPTIONS_ITEMS is 13 (no "Use Mouse"/windowed-mouse
  item, no `modestate`/`MS_WINDOWED` cursor-skip block), M_AdjustSliders' CD
  volume step is the non-Windows 0.1, M_Net_Draw's dimmed modem/direct pics are
  drawn unconditionally instead of via a `p = NULL` branch (both dimmed pics
  always exist in this port, since serialAvailable is always false), and
  M_Quit_Draw's Windows credits screen is dropped in favor of the non-Windows
  quitMessage box (the only M_Quit_Draw body this port has).
- `M_ScanSaves`'s `fscanf(f, "%i\n" / "%79s\n", ...)` needs the same
  read-whole-file-then-tokenize approach host_cmd.ts's Host_Loadgame_f uses,
  but host_cmd.ts's `TextScanner` is a private, unexported class. SaveTextScanner
  below is a local duplicate (this unit's SCOPE can't add an export to
  host_cmd.ts); a follow-up could hoist one shared scanner into common.ts.
- `msgNumber = rand()&7`: menu.c calls libc `rand()` directly here, not a
  QuakeC builtin, and mathlib.ts's own header says it deliberately provides no
  such wrapper. `menuRand()` below is a local Math.random()-backed stand-in,
  per PORTING.md's rand()->Math.random() idiom; the brief calls this out as
  "local rand".
- Every scalar module-global menu.c declares at file scope (m_state,
  m_entersound, m_main_cursor, options_cursor, keys_cursor, bind_grab,
  lanConfig_cursor, startepisode, ... down to slist_sorted) lives on one
  exported `menuState` object, mutated in place -- PORTING.md's "shared
  mutable globals become an exported const singleton" rule, applied here so
  tests can drive individual screens/cursors the way the C's file-scope
  globals would let a debugger. Arrays (m_filenames, loadable, bindnames,
  levels, hipnoticlevels, roguelevels, episodes, hipnoticepisodes,
  rogueepisodes, quitMessage, net_helpMessage) stay top-level `const`s with
  mutable elements, same as cl_lightstyle etc. in client.ts.
- net_main.ts's `NetHostHooks.menuSetReturnReason`/`menuHandleConnectError`/
  `menuConnectSucceeded` are wired by host.ts (Host_Init) to no-op functions,
  not to any `hostClientHooks` member, so there is nothing in a landed module
  for this unit to register against. `m_return_state`/`m_return_onerror`/
  `m_return_reason` therefore live only in `menuState` here, ported for their
  own sake (M_Menu_LanConfig_f/M_Menu_ServerList_f initialize them, the two
  Draw functions display m_return_reason); net_dgrm.c's callers of those hooks
  won't reach this menu until host.ts is revisited to forward them into
  hostClientHooks (follow-up).
- M_Init registers `hostClientHooks.mInit`/`mMenuQuitF` at module load
  (`registerMenuHooks()`), the same pattern cl_main.ts and keys.ts use, so
  Host_Init's `hostClientHooks.mInit?.()` reaches M_Init without this module
  needing to run before Host_Init calls it.

Concurrent siblings absent at gate (per the unit brief's absent-at-gate rule):
screen.ts (SCR_ModalMessage, SCR_BeginLoadingPlaque -- module does not exist
yet: "Cannot find module './screen'"), snd_dma.ts (S_LocalSound, S_ExtraUpdate
-- module does not exist yet: "Cannot find module './snd_dma'"). console.ts
(U047) landed while this unit was in progress and now exports
Con_ToggleConsole_f with the expected `() => void` signature, imported
directly below; console.ts itself only reaches menu.ts through a lazy
`require("./menu")` (its own file header explains why), so no import cycle
results from this file's static `import ... from "./console"`.
*/

import { getRenderer, TOP_RANGE, BOTTOM_RANGE } from "./render";
import type { QpicT } from "../common/wad";
import { vid, vidMenuHooks, vidBackend } from "./vid";
import { scrState } from "./screen_types";
import {
  keyState,
  KeydestT,
  K_ESCAPE,
  K_ENTER,
  K_SPACE,
  K_BACKSPACE,
  K_DEL,
  K_UPARROW,
  K_DOWNARROW,
  K_LEFTARROW,
  K_RIGHTARROW,
  Key_KeynumToString,
  Key_SetBinding,
  keybindings,
} from "./keys";
import { cls, cl, CactiveT } from "./client";
import { CL_NextDemo } from "./cl_main";
import { host, hostClientHooks } from "../common/host";
import { Host_Quit_f } from "../common/host_cmd";
import {
  NET_Slist_f,
  NET_Poll,
  hostCacheCount,
  hostcache,
  slistInProgress,
  tcpipAvailable,
  my_tcpip_address,
  DEFAULTnet_hostport,
} from "../common/net_main";
import { svs, sv } from "../server/server";
import { Cmd_AddCommand, Cbuf_AddText, Cbuf_InsertText } from "../common/cmd";
import { Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString } from "../common/cvar";
import { com_gamedir, Q_atoi, registered, rogue, hipnotic } from "../common/common";
import { Sys_FileOpenRead, Sys_FileRead, Sys_FileClose, Sys_Error } from "../platform/sys";
import { SAVEGAME_COMMENT_LENGTH } from "../common/quakedef";
import { Com_sprintf } from "../common/sprintf";
import { Con_ToggleConsole_f } from "./console";
import { SCR_ModalMessage, SCR_BeginLoadingPlaque } from "./screen";
import { S_LocalSound, S_ExtraUpdate } from "./snd_dma";

// net_ser.c / IPX were not ported; see file header.
const serialAvailable = false;
const ipxAvailable = false;
const my_ipx_address = "";

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

  m_return_state: MStateT.m_none as number,
  m_return_onerror: false,
  m_return_reason: "",

  m_save_demonum: 0,

  m_main_cursor: 0,
  m_singleplayer_cursor: 0,

  load_cursor: 0, // 0 <= load_cursor < MAX_SAVEGAMES

  m_multiplayer_cursor: 0,

  setup_cursor: 4,
  setup_hostname: "",
  setup_myname: "",
  setup_oldtop: 0,
  setup_oldbottom: 0,
  setup_top: 0,
  setup_bottom: 0,

  m_net_cursor: 0,
  m_net_items: 0,
  m_net_saveHeight: 0, // dead in the original C too: declared, never read or written past this

  options_cursor: 0,

  keys_cursor: 0,
  bind_grab: false,

  help_page: 0,

  msgNumber: 0,
  m_quit_prevstate: MStateT.m_none as number,
  wasInMenus: false,

  lanConfig_cursor: -1,
  lanConfig_port: 0,
  lanConfig_portname: "",
  lanConfig_joinname: "",

  startepisode: 0,
  startlevel: 0,
  maxplayers: 0,
  m_serverInfoMessage: false,
  m_serverInfoMessageTime: 0,
  gameoptions_cursor: 0,

  searchComplete: false,
  searchCompleteTime: 0,

  slist_cursor: 0,
  slist_sorted: false,
};

// #define StartingGame (m_multiplayer_cursor == 1)
function StartingGame(): boolean {
  return menuState.m_multiplayer_cursor === 1;
}
// #define JoiningGame (m_multiplayer_cursor == 0)
function JoiningGame(): boolean {
  return menuState.m_multiplayer_cursor === 0;
}
// #define SerialConfig (m_net_cursor == 0)
function SerialConfig(): boolean {
  return menuState.m_net_cursor === 0;
}
// #define DirectConfig (m_net_cursor == 1)
function DirectConfig(): boolean {
  return menuState.m_net_cursor === 1;
}
// #define IPXConfig (m_net_cursor == 2)
function IPXConfig(): boolean {
  return menuState.m_net_cursor === 2;
}
// #define TCPIPConfig (m_net_cursor == 3)
function TCPIPConfig(): boolean {
  return menuState.m_net_cursor === 3;
}

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

// not a ported C name; see file header's Draw_CachePic deviation note.
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

  const f = Math.trunc(host.time * 10) % 6;

  M_DrawTransPic(54, 32 + menuState.m_main_cursor * 20, cachePic(`gfx/menudot${f + 1}.lmp`));
}

export function M_Main_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      keyState.key_dest = KeydestT.key_game;
      menuState.m_state = MStateT.m_none;
      cls.demonum = menuState.m_save_demonum;
      if (cls.demonum !== -1 && !cls.demoplayback && cls.state !== CactiveT.ca_connected) CL_NextDemo();
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
      break;
  }
}

//=============================================================================
/* SINGLE PLAYER MENU */

export const SINGLEPLAYER_ITEMS = 3;

export function M_Menu_SinglePlayer_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_singleplayer;
  menuState.m_entersound = true;
}

export function M_SinglePlayer_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/ttl_sgl.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);
  M_DrawTransPic(72, 32, cachePic("gfx/sp_menu.lmp"));

  const f = Math.trunc(host.time * 10) % 6;

  M_DrawTransPic(54, 32 + menuState.m_singleplayer_cursor * 20, cachePic(`gfx/menudot${f + 1}.lmp`));
}

export function M_SinglePlayer_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Main_f();
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_singleplayer_cursor++;
      if (menuState.m_singleplayer_cursor >= SINGLEPLAYER_ITEMS) menuState.m_singleplayer_cursor = 0;
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_singleplayer_cursor--;
      if (menuState.m_singleplayer_cursor < 0) menuState.m_singleplayer_cursor = SINGLEPLAYER_ITEMS - 1;
      break;

    case K_ENTER: {
      menuState.m_entersound = true;

      switch (menuState.m_singleplayer_cursor) {
        case 0: {
          if (sv.active) {
            if (!SCR_ModalMessage("Are you sure you want to\nstart a new game?\n")) break;
          }
          keyState.key_dest = KeydestT.key_game;
          if (sv.active) Cbuf_AddText("disconnect\n");
          Cbuf_AddText("maxplayers 1\n");
          Cbuf_AddText("map start\n");
          break;
        }

        case 1:
          M_Menu_Load_f();
          break;

        case 2:
          M_Menu_Save_f();
          break;
      }
      break;
    }
  }
}

//=============================================================================
/* LOAD/SAVE MENU */

export const MAX_SAVEGAMES = 12;
export const m_filenames: string[] = new Array<string>(MAX_SAVEGAMES).fill("--- UNUSED SLOT ---");
export const loadable: boolean[] = new Array<boolean>(MAX_SAVEGAMES).fill(false);

// fscanf (f, "%i\n" / "%s\n", ...): skip whitespace, take one
// whitespace-delimited token, then consume the whitespace that follows.
// A local duplicate of host_cmd.ts's private (unexported) TextScanner; see
// file header.
class SaveTextScanner {
  private data: string;
  private index = 0;
  constructor(data: string) {
    this.data = data;
  }
  private skipWhite(): void {
    while (this.index < this.data.length) {
      const c = this.data[this.index];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") this.index++;
      else break;
    }
  }
  scanToken(): string {
    this.skipWhite();
    let out = "";
    while (this.index < this.data.length) {
      const c = this.data[this.index];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") break;
      out += c;
      this.index++;
    }
    this.skipWhite();
    return out;
  }
}

export function M_ScanSaves(): void {
  for (let i = 0; i < MAX_SAVEGAMES; i++) {
    m_filenames[i] = "--- UNUSED SLOT ---";
    loadable[i] = false;
    const path = `${com_gamedir}/s${i}.sav`;
    const opened = Sys_FileOpenRead(path);
    if (opened.handle === -1) continue;

    const bytes = new Uint8Array(opened.length);
    Sys_FileRead(opened.handle, bytes, opened.length);
    Sys_FileClose(opened.handle);
    let contents = "";
    for (let k = 0; k < bytes.length; k++) contents += String.fromCharCode(bytes[k]);
    const scan = new SaveTextScanner(contents);

    scan.scanToken(); // version -- read, exactly as the C's fscanf, and discarded
    // strncpy (m_filenames[i], name, sizeof(m_filenames[i])-1)
    let comment = scan.scanToken().slice(0, SAVEGAME_COMMENT_LENGTH);

    // change _ back to space
    comment = comment.replace(/_/g, " ");
    m_filenames[i] = comment;
    loadable[i] = true;
  }
}

export function M_Menu_Load_f(): void {
  menuState.m_entersound = true;
  menuState.m_state = MStateT.m_load;
  keyState.key_dest = KeydestT.key_menu;
  M_ScanSaves();
}

export function M_Menu_Save_f(): void {
  if (!sv.active) return;
  if (cl.intermission) return;
  if (svs.maxclients !== 1) return;
  menuState.m_entersound = true;
  menuState.m_state = MStateT.m_save;
  keyState.key_dest = KeydestT.key_menu;
  M_ScanSaves();
}

export function M_Load_Draw(): void {
  const p = cachePic("gfx/p_load.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  for (let i = 0; i < MAX_SAVEGAMES; i++) M_Print(16, 32 + 8 * i, m_filenames[i]);

  // line cursor
  M_DrawCharacter(8, 32 + menuState.load_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
}

export function M_Save_Draw(): void {
  const p = cachePic("gfx/p_save.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  for (let i = 0; i < MAX_SAVEGAMES; i++) M_Print(16, 32 + 8 * i, m_filenames[i]);

  // line cursor
  M_DrawCharacter(8, 32 + menuState.load_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
}

export function M_Load_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_SinglePlayer_f();
      break;

    case K_ENTER:
      S_LocalSound("misc/menu2.wav");
      if (!loadable[menuState.load_cursor]) return;
      menuState.m_state = MStateT.m_none;
      keyState.key_dest = KeydestT.key_game;

      // Host_Loadgame_f can't bring up the loading plaque because too much
      // stack space has been used, so do it now
      SCR_BeginLoadingPlaque();

      // issue the load command
      Cbuf_AddText(`load s${menuState.load_cursor}\n`);
      return;

    case K_UPARROW:
    case K_LEFTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor--;
      if (menuState.load_cursor < 0) menuState.load_cursor = MAX_SAVEGAMES - 1;
      break;

    case K_DOWNARROW:
    case K_RIGHTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor++;
      if (menuState.load_cursor >= MAX_SAVEGAMES) menuState.load_cursor = 0;
      break;
  }
}

export function M_Save_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_SinglePlayer_f();
      break;

    case K_ENTER:
      menuState.m_state = MStateT.m_none;
      keyState.key_dest = KeydestT.key_game;
      Cbuf_AddText(`save s${menuState.load_cursor}\n`);
      return;

    case K_UPARROW:
    case K_LEFTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor--;
      if (menuState.load_cursor < 0) menuState.load_cursor = MAX_SAVEGAMES - 1;
      break;

    case K_DOWNARROW:
    case K_RIGHTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor++;
      if (menuState.load_cursor >= MAX_SAVEGAMES) menuState.load_cursor = 0;
      break;
  }
}

//=============================================================================
/* MULTIPLAYER MENU */

export const MULTIPLAYER_ITEMS = 3;

export function M_Menu_MultiPlayer_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_multiplayer;
  menuState.m_entersound = true;
}

export function M_MultiPlayer_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);
  M_DrawTransPic(72, 32, cachePic("gfx/mp_menu.lmp"));

  const f = Math.trunc(host.time * 10) % 6;

  M_DrawTransPic(54, 32 + menuState.m_multiplayer_cursor * 20, cachePic(`gfx/menudot${f + 1}.lmp`));

  if (serialAvailable || ipxAvailable || tcpipAvailable) return;
  M_PrintWhite(Math.trunc(320 / 2 - (27 * 8) / 2), 148, "No Communications Available");
}

export function M_MultiPlayer_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Main_f();
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_multiplayer_cursor++;
      if (menuState.m_multiplayer_cursor >= MULTIPLAYER_ITEMS) menuState.m_multiplayer_cursor = 0;
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_multiplayer_cursor--;
      if (menuState.m_multiplayer_cursor < 0) menuState.m_multiplayer_cursor = MULTIPLAYER_ITEMS - 1;
      break;

    case K_ENTER:
      menuState.m_entersound = true;
      switch (menuState.m_multiplayer_cursor) {
        case 0:
          if (serialAvailable || ipxAvailable || tcpipAvailable) M_Menu_Net_f();
          break;

        case 1:
          if (serialAvailable || ipxAvailable || tcpipAvailable) M_Menu_Net_f();
          break;

        case 2:
          M_Menu_Setup_f();
          break;
      }
      break;
  }
}

//=============================================================================
/* SETUP MENU */

export const NUM_SETUP_CMDS = 5;
export const setup_cursor_table = [40, 56, 80, 104, 140];

export function M_Menu_Setup_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_setup;
  menuState.m_entersound = true;
  menuState.setup_myname = Cvar_VariableString("_cl_name");
  menuState.setup_hostname = Cvar_VariableString("hostname");
  const clColor = Math.trunc(Cvar_VariableValue("_cl_color"));
  menuState.setup_top = menuState.setup_oldtop = clColor >> 4;
  menuState.setup_bottom = menuState.setup_oldbottom = clColor & 15;
}

export function M_Setup_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  M_Print(64, 40, "Hostname");
  M_DrawTextBox(160, 32, 16, 1);
  M_Print(168, 40, menuState.setup_hostname);

  M_Print(64, 56, "Your name");
  M_DrawTextBox(160, 48, 16, 1);
  M_Print(168, 56, menuState.setup_myname);

  M_Print(64, 80, "Shirt color");
  M_Print(64, 104, "Pants color");

  M_DrawTextBox(64, 140 - 8, 14, 1);
  M_Print(72, 140, "Accept Changes");

  const bigbox = cachePic("gfx/bigbox.lmp");
  M_DrawTransPic(160, 64, bigbox);
  const menuplyr = cachePic("gfx/menuplyr.lmp");
  M_BuildTranslationTable(menuState.setup_top * 16, menuState.setup_bottom * 16);
  M_DrawTransPicTranslate(172, 72, menuplyr);

  M_DrawCharacter(56, setup_cursor_table[menuState.setup_cursor], 12 + (Math.trunc(host.realtime * 4) & 1));

  if (menuState.setup_cursor === 0)
    M_DrawCharacter(
      168 + 8 * menuState.setup_hostname.length,
      setup_cursor_table[menuState.setup_cursor],
      10 + (Math.trunc(host.realtime * 4) & 1),
    );

  if (menuState.setup_cursor === 1)
    M_DrawCharacter(
      168 + 8 * menuState.setup_myname.length,
      setup_cursor_table[menuState.setup_cursor],
      10 + (Math.trunc(host.realtime * 4) & 1),
    );
}

// the C's `forward:` label, reached both by K_RIGHTARROW and (via goto) by
// K_ENTER on cursor 2/3.
function setupForward(): void {
  S_LocalSound("misc/menu3.wav");
  if (menuState.setup_cursor === 2) menuState.setup_top += 1;
  if (menuState.setup_cursor === 3) menuState.setup_bottom += 1;
}

export function M_Setup_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_MultiPlayer_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.setup_cursor--;
      if (menuState.setup_cursor < 0) menuState.setup_cursor = NUM_SETUP_CMDS - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.setup_cursor++;
      if (menuState.setup_cursor >= NUM_SETUP_CMDS) menuState.setup_cursor = 0;
      break;

    case K_LEFTARROW:
      if (menuState.setup_cursor < 2) return;
      S_LocalSound("misc/menu3.wav");
      if (menuState.setup_cursor === 2) menuState.setup_top -= 1;
      if (menuState.setup_cursor === 3) menuState.setup_bottom -= 1;
      break;

    case K_RIGHTARROW:
      if (menuState.setup_cursor < 2) return;
      setupForward();
      break;

    case K_ENTER:
      if (menuState.setup_cursor === 0 || menuState.setup_cursor === 1) return;

      if (menuState.setup_cursor === 2 || menuState.setup_cursor === 3) {
        setupForward();
        break;
      }

      // setup_cursor == 4 (OK)
      if (Cvar_VariableString("_cl_name") !== menuState.setup_myname) Cbuf_AddText(`name "${menuState.setup_myname}"\n`);
      if (Cvar_VariableString("hostname") !== menuState.setup_hostname) Cvar_Set("hostname", menuState.setup_hostname);
      if (menuState.setup_top !== menuState.setup_oldtop || menuState.setup_bottom !== menuState.setup_oldbottom)
        Cbuf_AddText(`color ${menuState.setup_top} ${menuState.setup_bottom}\n`);
      menuState.m_entersound = true;
      M_Menu_MultiPlayer_f();
      break;

    case K_BACKSPACE:
      if (menuState.setup_cursor === 0) {
        if (menuState.setup_hostname.length > 0) menuState.setup_hostname = menuState.setup_hostname.slice(0, -1);
      }

      if (menuState.setup_cursor === 1) {
        if (menuState.setup_myname.length > 0) menuState.setup_myname = menuState.setup_myname.slice(0, -1);
      }
      break;

    default:
      if (k < 32 || k > 127) break;
      if (menuState.setup_cursor === 0) {
        if (menuState.setup_hostname.length < 15) menuState.setup_hostname += String.fromCharCode(k);
      }
      if (menuState.setup_cursor === 1) {
        if (menuState.setup_myname.length < 15) menuState.setup_myname += String.fromCharCode(k);
      }
  }

  if (menuState.setup_top > 13) menuState.setup_top = 0;
  if (menuState.setup_top < 0) menuState.setup_top = 13;
  if (menuState.setup_bottom > 13) menuState.setup_bottom = 0;
  if (menuState.setup_bottom < 0) menuState.setup_bottom = 13;
}

//=============================================================================
/* NET MENU */

export const net_helpMessage: string[] = [
  /* .........1.........2.... */
  "                        ",
  " Two computers connected",
  "   through two modems.  ",
  "                        ",

  "                        ",
  " Two computers connected",
  " by a null-modem cable. ",
  "                        ",

  " Novell network LANs    ",
  " or Windows 95 DOS-box. ",
  "                        ",
  "(LAN=Local Area Network)",

  " Commonly used to play  ",
  " over the Internet, but ",
  " also used on a Local   ",
  " Area Network.          ",
];

export function M_Menu_Net_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_net;
  menuState.m_entersound = true;
  menuState.m_net_items = 4;

  if (menuState.m_net_cursor >= menuState.m_net_items) menuState.m_net_cursor = 0;
  menuState.m_net_cursor--;
  M_Net_Key(K_DOWNARROW);
}

export function M_Net_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p0 = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p0.width) / 2), 4, p0);

  let f = 32;

  // serialAvailable is always false in this port; the C's `#ifdef _WIN32
  // p = NULL #else p = Draw_CachePic("gfx/dim_modm.lmp") #endif` becomes the
  // portable branch unconditionally, always non-null, so the C's `if (p)`
  // guards are dropped too.
  let p = cachePic(serialAvailable ? "gfx/netmen1.lmp" : "gfx/dim_modm.lmp");
  M_DrawTransPic(72, f, p);

  f += 19;

  p = cachePic(serialAvailable ? "gfx/netmen2.lmp" : "gfx/dim_drct.lmp");
  M_DrawTransPic(72, f, p);

  f += 19;
  p = cachePic(ipxAvailable ? "gfx/netmen3.lmp" : "gfx/dim_ipx.lmp");
  M_DrawTransPic(72, f, p);

  f += 19;
  p = cachePic(tcpipAvailable ? "gfx/netmen4.lmp" : "gfx/dim_tcp.lmp");
  M_DrawTransPic(72, f, p);

  if (menuState.m_net_items === 5) {
    // JDC, could just be removed
    f += 19;
    p = cachePic("gfx/netmen5.lmp");
    M_DrawTransPic(72, f, p);
  }

  f = Math.trunc((320 - 26 * 8) / 2);
  M_DrawTextBox(f, 134, 24, 4);
  f += 8;
  M_Print(f, 142, net_helpMessage[menuState.m_net_cursor * 4 + 0]);
  M_Print(f, 150, net_helpMessage[menuState.m_net_cursor * 4 + 1]);
  M_Print(f, 158, net_helpMessage[menuState.m_net_cursor * 4 + 2]);
  M_Print(f, 166, net_helpMessage[menuState.m_net_cursor * 4 + 3]);

  const dot = Math.trunc(host.time * 10) % 6;
  M_DrawTransPic(54, 32 + menuState.m_net_cursor * 20, cachePic(`gfx/menudot${dot + 1}.lmp`));
}

export function M_Net_Key(k: number): void {
  for (;;) {
    switch (k) {
      case K_ESCAPE:
        M_Menu_MultiPlayer_f();
        break;

      case K_DOWNARROW:
        S_LocalSound("misc/menu1.wav");
        menuState.m_net_cursor++;
        if (menuState.m_net_cursor >= menuState.m_net_items) menuState.m_net_cursor = 0;
        break;

      case K_UPARROW:
        S_LocalSound("misc/menu1.wav");
        menuState.m_net_cursor--;
        if (menuState.m_net_cursor < 0) menuState.m_net_cursor = menuState.m_net_items - 1;
        break;

      case K_ENTER:
        menuState.m_entersound = true;

        switch (menuState.m_net_cursor) {
          case 0: // dropped: M_Menu_SerialConfig_f (serial/modem not ported); unreachable, see below
          case 1:
            break;

          case 2:
            M_Menu_LanConfig_f();
            break;

          case 3:
            M_Menu_LanConfig_f();
            break;

          case 4:
            // multiprotocol -- unreachable, m_net_items is always 4
            break;
        }
        break;
    }

    if (menuState.m_net_cursor === 0 && !serialAvailable) continue;
    if (menuState.m_net_cursor === 1 && !serialAvailable) continue;
    if (menuState.m_net_cursor === 2 && !ipxAvailable) continue;
    if (menuState.m_net_cursor === 3 && !tcpipAvailable) continue;
    break;
  }
}

//=============================================================================
/* OPTIONS MENU */

// non-Windows list; the _WIN32 list adds a 14th item ("Use Mouse"), dropped.
export const OPTIONS_ITEMS = 13;

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

    // _WIN32's case 13 (_windowed_mouse) is dropped
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

  if (vidMenuHooks.vid_menudrawfn) M_Print(16, 128, "         Video Options");

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
        case 12:
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

  if (menuState.options_cursor === 12 && !vidMenuHooks.vid_menudrawfn) {
    if (k === K_UPARROW) menuState.options_cursor = 11;
    else menuState.options_cursor = 0;
  }
}

//=============================================================================
/* KEYS MENU */

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
  const l = command.length;
  let count = 0;

  for (let j = 0; j < 256; j++) {
    const b = keybindings[j];
    if (b === null) continue;
    if (b.slice(0, l) === command) {
      twokeys[count] = j;
      count++;
      if (count === 2) break;
    }
  }
}

export function M_UnbindCommand(command: string): void {
  const l = command.length;

  for (let j = 0; j < 256; j++) {
    const b = keybindings[j];
    if (b === null) continue;
    if (b.slice(0, l) === command) Key_SetBinding(j, "");
  }
}

export function M_Keys_Draw(): void {
  const p = cachePic("gfx/ttl_cstm.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  if (menuState.bind_grab) M_Print(12, 32, "Press a key or button for this action");
  else M_Print(18, 32, "Enter to change, backspace to clear");

  // search for known bindings
  const keys: [number, number] = [-1, -1];
  for (let i = 0; i < NUMCOMMANDS; i++) {
    const y = 48 + 8 * i;

    M_Print(16, y, bindnames[i][1]);

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
      const cmd = `bind "${Key_KeynumToString(k)}" "${bindnames[menuState.keys_cursor][0]}"\n`;
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

// non-_WIN32 quitMessage; the _WIN32 build shows a static credits screen
// instead (dropped, see file header).
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
// deliberately provides no such wrapper (see its own header). Local
// Math.random()-backed stand-in, per PORTING.md's rand()->Math.random() idiom
// -- see file header.
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
      keyState.key_dest = KeydestT.key_console;
      Host_Quit_f();
      break;

    default:
      break;
  }
}

export function M_Quit_Draw(): void {
  if (menuState.wasInMenus) {
    menuState.m_state = menuState.m_quit_prevstate;
    menuState.m_recursiveDraw = true;
    M_Draw();
    menuState.m_state = MStateT.m_quit;
  }

  M_DrawTextBox(56, 76, 24, 4);
  M_Print(64, 84, quitMessage[menuState.msgNumber * 4 + 0]);
  M_Print(64, 92, quitMessage[menuState.msgNumber * 4 + 1]);
  M_Print(64, 100, quitMessage[menuState.msgNumber * 4 + 2]);
  M_Print(64, 108, quitMessage[menuState.msgNumber * 4 + 3]);
}

//=============================================================================
/* LAN CONFIG MENU */

export const NUM_LANCONFIG_CMDS = 3;
export const lanConfig_cursor_table = [72, 92, 124];

export function M_Menu_LanConfig_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_lanconfig;
  menuState.m_entersound = true;
  if (menuState.lanConfig_cursor === -1) {
    if (JoiningGame() && TCPIPConfig()) menuState.lanConfig_cursor = 2;
    else menuState.lanConfig_cursor = 1;
  }
  if (StartingGame() && menuState.lanConfig_cursor === 2) menuState.lanConfig_cursor = 1;
  menuState.lanConfig_port = DEFAULTnet_hostport;
  menuState.lanConfig_portname = String(menuState.lanConfig_port >>> 0);

  menuState.m_return_onerror = false;
  menuState.m_return_reason = "";
}

export function M_LanConfig_Draw(): void {
  const p = cachePic("gfx/p_multi.lmp");
  const basex = Math.trunc((320 - p.width) / 2);
  M_DrawPic(basex, 4, p);

  const startJoin = StartingGame() ? "New Game" : "Join Game";
  const protocol = IPXConfig() ? "IPX" : "TCP/IP";
  M_Print(basex, 32, `${startJoin} - ${protocol}`);
  const bx = basex + 8;

  M_Print(bx, 52, "Address:");
  if (IPXConfig())
    M_Print(bx + 9 * 8, 52, my_ipx_address); // unreachable: ipxAvailable is always false
  else M_Print(bx + 9 * 8, 52, my_tcpip_address);

  M_Print(bx, lanConfig_cursor_table[0], "Port");
  M_DrawTextBox(bx + 8 * 8, lanConfig_cursor_table[0] - 8, 6, 1);
  M_Print(bx + 9 * 8, lanConfig_cursor_table[0], menuState.lanConfig_portname);

  if (JoiningGame()) {
    M_Print(bx, lanConfig_cursor_table[1], "Search for local games...");
    M_Print(bx, 108, "Join game at:");
    M_DrawTextBox(bx + 8, lanConfig_cursor_table[2] - 8, 22, 1);
    M_Print(bx + 16, lanConfig_cursor_table[2], menuState.lanConfig_joinname);
  } else {
    M_DrawTextBox(bx, lanConfig_cursor_table[1] - 8, 2, 1);
    M_Print(bx + 8, lanConfig_cursor_table[1], "OK");
  }

  M_DrawCharacter(bx - 8, lanConfig_cursor_table[menuState.lanConfig_cursor], 12 + (Math.trunc(host.realtime * 4) & 1));

  if (menuState.lanConfig_cursor === 0)
    M_DrawCharacter(
      bx + 9 * 8 + 8 * menuState.lanConfig_portname.length,
      lanConfig_cursor_table[0],
      10 + (Math.trunc(host.realtime * 4) & 1),
    );

  if (menuState.lanConfig_cursor === 2)
    M_DrawCharacter(
      bx + 16 + 8 * menuState.lanConfig_joinname.length,
      lanConfig_cursor_table[2],
      10 + (Math.trunc(host.realtime * 4) & 1),
    );

  if (menuState.m_return_reason.length > 0) M_PrintWhite(bx, 148, menuState.m_return_reason);
}

export function M_LanConfig_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Net_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.lanConfig_cursor--;
      if (menuState.lanConfig_cursor < 0) menuState.lanConfig_cursor = NUM_LANCONFIG_CMDS - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.lanConfig_cursor++;
      if (menuState.lanConfig_cursor >= NUM_LANCONFIG_CMDS) menuState.lanConfig_cursor = 0;
      break;

    case K_ENTER: {
      if (menuState.lanConfig_cursor === 0) break;

      menuState.m_entersound = true;

      M_ConfigureNetSubsystem();

      if (menuState.lanConfig_cursor === 1) {
        if (StartingGame()) {
          M_Menu_GameOptions_f();
          break;
        }
        M_Menu_Search_f();
        break;
      }

      if (menuState.lanConfig_cursor === 2) {
        menuState.m_return_state = menuState.m_state;
        menuState.m_return_onerror = true;
        keyState.key_dest = KeydestT.key_game;
        menuState.m_state = MStateT.m_none;
        Cbuf_AddText(`connect "${menuState.lanConfig_joinname}"\n`);
        break;
      }

      break;
    }

    case K_BACKSPACE:
      if (menuState.lanConfig_cursor === 0) {
        if (menuState.lanConfig_portname.length > 0) menuState.lanConfig_portname = menuState.lanConfig_portname.slice(0, -1);
      }

      if (menuState.lanConfig_cursor === 2) {
        if (menuState.lanConfig_joinname.length > 0) menuState.lanConfig_joinname = menuState.lanConfig_joinname.slice(0, -1);
      }
      break;

    default:
      if (key < 32 || key > 127) break;

      if (menuState.lanConfig_cursor === 2) {
        if (menuState.lanConfig_joinname.length < 21) menuState.lanConfig_joinname += String.fromCharCode(key);
      }

      if (key < 48 || key > 57) break; // '0'-'9'
      if (menuState.lanConfig_cursor === 0) {
        if (menuState.lanConfig_portname.length < 5) menuState.lanConfig_portname += String.fromCharCode(key);
      }
  }

  if (StartingGame() && menuState.lanConfig_cursor === 2) {
    if (key === K_UPARROW) menuState.lanConfig_cursor = 1;
    else menuState.lanConfig_cursor = 0;
  }

  let l = Q_atoi(menuState.lanConfig_portname);
  if (l > 65535) l = menuState.lanConfig_port;
  else menuState.lanConfig_port = l;
  menuState.lanConfig_portname = String(menuState.lanConfig_port >>> 0);
}

//=============================================================================
/* GAME OPTIONS MENU */

interface LevelT {
  name: string;
  description: string;
}

interface EpisodeT {
  description: string;
  firstLevel: number;
  levels: number;
}

export const levels: LevelT[] = [
  { name: "start", description: "Entrance" }, // 0

  { name: "e1m1", description: "Slipgate Complex" }, // 1
  { name: "e1m2", description: "Castle of the Damned" },
  { name: "e1m3", description: "The Necropolis" },
  { name: "e1m4", description: "The Grisly Grotto" },
  { name: "e1m5", description: "Gloom Keep" },
  { name: "e1m6", description: "The Door To Chthon" },
  { name: "e1m7", description: "The House of Chthon" },
  { name: "e1m8", description: "Ziggurat Vertigo" },

  { name: "e2m1", description: "The Installation" }, // 9
  { name: "e2m2", description: "Ogre Citadel" },
  { name: "e2m3", description: "Crypt of Decay" },
  { name: "e2m4", description: "The Ebon Fortress" },
  { name: "e2m5", description: "The Wizard's Manse" },
  { name: "e2m6", description: "The Dismal Oubliette" },
  { name: "e2m7", description: "Underearth" },

  { name: "e3m1", description: "Termination Central" }, // 16
  { name: "e3m2", description: "The Vaults of Zin" },
  { name: "e3m3", description: "The Tomb of Terror" },
  { name: "e3m4", description: "Satan's Dark Delight" },
  { name: "e3m5", description: "Wind Tunnels" },
  { name: "e3m6", description: "Chambers of Torment" },
  { name: "e3m7", description: "The Haunted Halls" },

  { name: "e4m1", description: "The Sewage System" }, // 23
  { name: "e4m2", description: "The Tower of Despair" },
  { name: "e4m3", description: "The Elder God Shrine" },
  { name: "e4m4", description: "The Palace of Hate" },
  { name: "e4m5", description: "Hell's Atrium" },
  { name: "e4m6", description: "The Pain Maze" },
  { name: "e4m7", description: "Azure Agony" },
  { name: "e4m8", description: "The Nameless City" },

  { name: "end", description: "Shub-Niggurath's Pit" }, // 31

  { name: "dm1", description: "Place of Two Deaths" }, // 32
  { name: "dm2", description: "Claustrophobopolis" },
  { name: "dm3", description: "The Abandoned Base" },
  { name: "dm4", description: "The Bad Place" },
  { name: "dm5", description: "The Cistern" },
  { name: "dm6", description: "The Dark Zone" },
];

// MED 01/06/97 added hipnotic levels
export const hipnoticlevels: LevelT[] = [
  { name: "start", description: "Command HQ" }, // 0

  { name: "hip1m1", description: "The Pumping Station" }, // 1
  { name: "hip1m2", description: "Storage Facility" },
  { name: "hip1m3", description: "The Lost Mine" },
  { name: "hip1m4", description: "Research Facility" },
  { name: "hip1m5", description: "Military Complex" },

  { name: "hip2m1", description: "Ancient Realms" }, // 6
  { name: "hip2m2", description: "The Black Cathedral" },
  { name: "hip2m3", description: "The Catacombs" },
  { name: "hip2m4", description: "The Crypt" },
  { name: "hip2m5", description: "Mortum's Keep" },
  { name: "hip2m6", description: "The Gremlin's Domain" },

  { name: "hip3m1", description: "Tur Torment" }, // 12
  { name: "hip3m2", description: "Pandemonium" },
  { name: "hip3m3", description: "Limbo" },
  { name: "hip3m4", description: "The Gauntlet" },

  { name: "hipend", description: "Armagon's Lair" }, // 16

  { name: "hipdm1", description: "The Edge of Oblivion" }, // 17
];

// PGM 01/07/97 added rogue levels
// PGM 03/02/97 added dmatch level
export const roguelevels: LevelT[] = [
  { name: "start", description: "Split Decision" },
  { name: "r1m1", description: "Deviant's Domain" },
  { name: "r1m2", description: "Dread Portal" },
  { name: "r1m3", description: "Judgement Call" },
  { name: "r1m4", description: "Cave of Death" },
  { name: "r1m5", description: "Towers of Wrath" },
  { name: "r1m6", description: "Temple of Pain" },
  { name: "r1m7", description: "Tomb of the Overlord" },
  { name: "r2m1", description: "Tempus Fugit" },
  { name: "r2m2", description: "Elemental Fury I" },
  { name: "r2m3", description: "Elemental Fury II" },
  { name: "r2m4", description: "Curse of Osiris" },
  { name: "r2m5", description: "Wizard's Keep" },
  { name: "r2m6", description: "Blood Sacrifice" },
  { name: "r2m7", description: "Last Bastion" },
  { name: "r2m8", description: "Source of Evil" },
  { name: "ctf1", description: "Division of Change" },
];

export const episodes: EpisodeT[] = [
  { description: "Welcome to Quake", firstLevel: 0, levels: 1 },
  { description: "Doomed Dimension", firstLevel: 1, levels: 8 },
  { description: "Realm of Black Magic", firstLevel: 9, levels: 7 },
  { description: "Netherworld", firstLevel: 16, levels: 7 },
  { description: "The Elder World", firstLevel: 23, levels: 8 },
  { description: "Final Level", firstLevel: 31, levels: 1 },
  { description: "Deathmatch Arena", firstLevel: 32, levels: 6 },
];

// MED 01/06/97 added hipnotic episodes
export const hipnoticepisodes: EpisodeT[] = [
  { description: "Scourge of Armagon", firstLevel: 0, levels: 1 },
  { description: "Fortress of the Dead", firstLevel: 1, levels: 5 },
  { description: "Dominion of Darkness", firstLevel: 6, levels: 6 },
  { description: "The Rift", firstLevel: 12, levels: 4 },
  { description: "Final Level", firstLevel: 16, levels: 1 },
  { description: "Deathmatch Arena", firstLevel: 17, levels: 1 },
];

// PGM 01/07/97 added rogue episodes
// PGM 03/02/97 added dmatch episode
export const rogueepisodes: EpisodeT[] = [
  { description: "Introduction", firstLevel: 0, levels: 1 },
  { description: "Hell's Fortress", firstLevel: 1, levels: 7 },
  { description: "Corridors of Time", firstLevel: 8, levels: 8 },
  { description: "Deathmatch Arena", firstLevel: 16, levels: 1 },
];

export function M_Menu_GameOptions_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_gameoptions;
  menuState.m_entersound = true;
  if (menuState.maxplayers === 0) menuState.maxplayers = svs.maxclients;
  if (menuState.maxplayers < 2) menuState.maxplayers = svs.maxclientslimit;
}

export const gameoptions_cursor_table = [40, 56, 64, 72, 80, 88, 96, 112, 120];
export const NUM_GAMEOPTIONS = 9;

export function M_GameOptions_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  M_DrawTextBox(152, 32, 10, 1);
  M_Print(160, 40, "begin game");

  M_Print(0, 56, "      Max players");
  M_Print(160, 56, `${menuState.maxplayers}`);

  M_Print(0, 64, "        Game Type");
  if (Cvar_VariableValue("coop")) M_Print(160, 64, "Cooperative");
  else M_Print(160, 64, "Deathmatch");

  M_Print(0, 72, "        Teamplay");
  const teamplayValue = Math.trunc(Cvar_VariableValue("teamplay"));
  if (rogue) {
    let msg: string;
    switch (teamplayValue) {
      case 1:
        msg = "No Friendly Fire";
        break;
      case 2:
        msg = "Friendly Fire";
        break;
      case 3:
        msg = "Tag";
        break;
      case 4:
        msg = "Capture the Flag";
        break;
      case 5:
        msg = "One Flag CTF";
        break;
      case 6:
        msg = "Three Team CTF";
        break;
      default:
        msg = "Off";
        break;
    }
    M_Print(160, 72, msg);
  } else {
    let msg: string;
    switch (teamplayValue) {
      case 1:
        msg = "No Friendly Fire";
        break;
      case 2:
        msg = "Friendly Fire";
        break;
      default:
        msg = "Off";
        break;
    }
    M_Print(160, 72, msg);
  }

  M_Print(0, 80, "            Skill");
  const skillValue = Cvar_VariableValue("skill");
  if (skillValue === 0) M_Print(160, 80, "Easy difficulty");
  else if (skillValue === 1) M_Print(160, 80, "Normal difficulty");
  else if (skillValue === 2) M_Print(160, 80, "Hard difficulty");
  else M_Print(160, 80, "Nightmare difficulty");

  M_Print(0, 88, "       Frag Limit");
  const fraglimitValue = Cvar_VariableValue("fraglimit");
  if (fraglimitValue === 0) M_Print(160, 88, "none");
  else M_Print(160, 88, `${Math.trunc(fraglimitValue)} frags`);

  M_Print(0, 96, "       Time Limit");
  const timelimitValue = Cvar_VariableValue("timelimit");
  if (timelimitValue === 0) M_Print(160, 96, "none");
  else M_Print(160, 96, `${Math.trunc(timelimitValue)} minutes`);

  M_Print(0, 112, "         Episode");
  // MED 01/06/97 added hipnotic episodes
  if (hipnotic) M_Print(160, 112, hipnoticepisodes[menuState.startepisode].description);
  // PGM 01/07/97 added rogue episodes
  else if (rogue) M_Print(160, 112, rogueepisodes[menuState.startepisode].description);
  else M_Print(160, 112, episodes[menuState.startepisode].description);

  M_Print(0, 120, "           Level");
  // MED 01/06/97 added hipnotic episodes
  if (hipnotic) {
    const lvl = hipnoticlevels[hipnoticepisodes[menuState.startepisode].firstLevel + menuState.startlevel];
    M_Print(160, 120, lvl.description);
    M_Print(160, 128, lvl.name);
  }
  // PGM 01/07/97 added rogue episodes
  else if (rogue) {
    const lvl = roguelevels[rogueepisodes[menuState.startepisode].firstLevel + menuState.startlevel];
    M_Print(160, 120, lvl.description);
    M_Print(160, 128, lvl.name);
  } else {
    const lvl = levels[episodes[menuState.startepisode].firstLevel + menuState.startlevel];
    M_Print(160, 120, lvl.description);
    M_Print(160, 128, lvl.name);
  }

  // line cursor
  M_DrawCharacter(144, gameoptions_cursor_table[menuState.gameoptions_cursor], 12 + (Math.trunc(host.realtime * 4) & 1));

  if (menuState.m_serverInfoMessage) {
    if (host.realtime - menuState.m_serverInfoMessageTime < 5.0) {
      const x = Math.trunc((320 - 26 * 8) / 2);
      M_DrawTextBox(x, 138, 24, 4);
      const x2 = x + 8;
      M_Print(x2, 146, "  More than 4 players   ");
      M_Print(x2, 154, " requires using command ");
      M_Print(x2, 162, "line parameters; please ");
      M_Print(x2, 170, "   see techinfo.txt.    ");
    } else {
      menuState.m_serverInfoMessage = false;
    }
  }
}

export function M_NetStart_Change(dir: number): void {
  let count: number;

  switch (menuState.gameoptions_cursor) {
    case 1:
      menuState.maxplayers += dir;
      if (menuState.maxplayers > svs.maxclientslimit) {
        menuState.maxplayers = svs.maxclientslimit;
        menuState.m_serverInfoMessage = true;
        menuState.m_serverInfoMessageTime = host.realtime;
      }
      if (menuState.maxplayers < 2) menuState.maxplayers = 2;
      break;

    case 2:
      Cvar_SetValue("coop", Cvar_VariableValue("coop") ? 0 : 1);
      break;

    case 3:
      count = rogue ? 6 : 2;

      Cvar_SetValue("teamplay", Cvar_VariableValue("teamplay") + dir);
      if (Cvar_VariableValue("teamplay") > count) Cvar_SetValue("teamplay", 0);
      else if (Cvar_VariableValue("teamplay") < 0) Cvar_SetValue("teamplay", count);
      break;

    case 4:
      Cvar_SetValue("skill", Cvar_VariableValue("skill") + dir);
      if (Cvar_VariableValue("skill") > 3) Cvar_SetValue("skill", 0);
      if (Cvar_VariableValue("skill") < 0) Cvar_SetValue("skill", 3);
      break;

    case 5:
      Cvar_SetValue("fraglimit", Cvar_VariableValue("fraglimit") + dir * 10);
      if (Cvar_VariableValue("fraglimit") > 100) Cvar_SetValue("fraglimit", 0);
      if (Cvar_VariableValue("fraglimit") < 0) Cvar_SetValue("fraglimit", 100);
      break;

    case 6:
      Cvar_SetValue("timelimit", Cvar_VariableValue("timelimit") + dir * 5);
      if (Cvar_VariableValue("timelimit") > 60) Cvar_SetValue("timelimit", 0);
      if (Cvar_VariableValue("timelimit") < 0) Cvar_SetValue("timelimit", 60);
      break;

    case 7:
      menuState.startepisode += dir;
      // MED 01/06/97 added hipnotic count
      if (hipnotic) count = 6;
      // PGM 01/07/97 added rogue count
      // PGM 03/02/97 added 1 for dmatch episode
      else if (rogue) count = 4;
      else if (registered.value) count = 7;
      else count = 2;

      if (menuState.startepisode < 0) menuState.startepisode = count - 1;

      if (menuState.startepisode >= count) menuState.startepisode = 0;

      menuState.startlevel = 0;
      break;

    case 8:
      menuState.startlevel += dir;
      // MED 01/06/97 added hipnotic episodes
      if (hipnotic) count = hipnoticepisodes[menuState.startepisode].levels;
      // PGM 01/06/97 added hipnotic episodes
      else if (rogue) count = rogueepisodes[menuState.startepisode].levels;
      else count = episodes[menuState.startepisode].levels;

      if (menuState.startlevel < 0) menuState.startlevel = count - 1;

      if (menuState.startlevel >= count) menuState.startlevel = 0;
      break;
  }
}

export function M_GameOptions_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Net_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.gameoptions_cursor--;
      if (menuState.gameoptions_cursor < 0) menuState.gameoptions_cursor = NUM_GAMEOPTIONS - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.gameoptions_cursor++;
      if (menuState.gameoptions_cursor >= NUM_GAMEOPTIONS) menuState.gameoptions_cursor = 0;
      break;

    case K_LEFTARROW:
      if (menuState.gameoptions_cursor === 0) break;
      S_LocalSound("misc/menu3.wav");
      M_NetStart_Change(-1);
      break;

    case K_RIGHTARROW:
      if (menuState.gameoptions_cursor === 0) break;
      S_LocalSound("misc/menu3.wav");
      M_NetStart_Change(1);
      break;

    case K_ENTER:
      S_LocalSound("misc/menu2.wav");
      if (menuState.gameoptions_cursor === 0) {
        if (sv.active) Cbuf_AddText("disconnect\n");
        Cbuf_AddText("listen 0\n"); // so host_netport will be re-examined
        Cbuf_AddText(`maxplayers ${menuState.maxplayers}\n`);
        SCR_BeginLoadingPlaque();

        if (hipnotic)
          Cbuf_AddText(`map ${hipnoticlevels[hipnoticepisodes[menuState.startepisode].firstLevel + menuState.startlevel].name}\n`);
        else if (rogue) Cbuf_AddText(`map ${roguelevels[rogueepisodes[menuState.startepisode].firstLevel + menuState.startlevel].name}\n`);
        else Cbuf_AddText(`map ${levels[episodes[menuState.startepisode].firstLevel + menuState.startlevel].name}\n`);

        return;
      }

      M_NetStart_Change(1);
      break;
  }
}

//=============================================================================
/* SEARCH MENU */

export function M_Menu_Search_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_search;
  menuState.m_entersound = false;
  // see file header: slistSilent/slistLocal can't be set from here (no
  // exported setter in net_main.ts).
  menuState.searchComplete = false;
  NET_Slist_f();
}

export function M_Search_Draw(): void {
  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);
  const x = Math.trunc(320 / 2 - (12 * 8) / 2) + 4;
  M_DrawTextBox(x - 8, 32, 12, 1);
  M_Print(x, 40, "Searching...");

  if (slistInProgress) {
    NET_Poll();
    return;
  }

  if (!menuState.searchComplete) {
    menuState.searchComplete = true;
    menuState.searchCompleteTime = host.realtime;
  }

  if (hostCacheCount) {
    M_Menu_ServerList_f();
    return;
  }

  M_PrintWhite(Math.trunc(320 / 2 - (22 * 8) / 2), 64, "No Quake servers found");
  if (host.realtime - menuState.searchCompleteTime < 3.0) return;

  M_Menu_LanConfig_f();
}

export function M_Search_Key(_key: number): void {
  // empty in the C
}

//=============================================================================
/* SLIST MENU */

export function M_Menu_ServerList_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_slist;
  menuState.m_entersound = true;
  menuState.slist_cursor = 0;
  menuState.m_return_onerror = false;
  menuState.m_return_reason = "";
  menuState.slist_sorted = false;
}

export function M_ServerList_Draw(): void {
  if (!menuState.slist_sorted) {
    if (hostCacheCount > 1) {
      for (let i = 0; i < hostCacheCount; i++) {
        for (let j = i + 1; j < hostCacheCount; j++) {
          if (hostcache[j].name < hostcache[i].name) {
            const temp = hostcache[j];
            hostcache[j] = hostcache[i];
            hostcache[i] = temp;
          }
        }
      }
    }
    menuState.slist_sorted = true;
  }

  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);
  for (let n = 0; n < hostCacheCount; n++) {
    const row = hostcache[n].maxusers
      ? Com_sprintf("%-15.15s %-15.15s %2u/%2u\n", hostcache[n].name, hostcache[n].map, hostcache[n].users, hostcache[n].maxusers)
      : Com_sprintf("%-15.15s %-15.15s\n", hostcache[n].name, hostcache[n].map);
    M_Print(16, 32 + 8 * n, row);
  }
  M_DrawCharacter(0, 32 + menuState.slist_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));

  if (menuState.m_return_reason.length > 0) M_PrintWhite(16, 148, menuState.m_return_reason);
}

export function M_ServerList_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_LanConfig_f();
      break;

    case K_SPACE:
      M_Menu_Search_f();
      break;

    case K_UPARROW:
    case K_LEFTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.slist_cursor--;
      if (menuState.slist_cursor < 0) menuState.slist_cursor = hostCacheCount - 1;
      break;

    case K_DOWNARROW:
    case K_RIGHTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.slist_cursor++;
      if (menuState.slist_cursor >= hostCacheCount) menuState.slist_cursor = 0;
      break;

    case K_ENTER:
      S_LocalSound("misc/menu2.wav");
      menuState.m_return_state = menuState.m_state;
      menuState.m_return_onerror = true;
      menuState.slist_sorted = false;
      keyState.key_dest = KeydestT.key_game;
      menuState.m_state = MStateT.m_none;
      Cbuf_AddText(`connect "${hostcache[menuState.slist_cursor].cname}"\n`);
      break;

    default:
      break;
  }
}

//=============================================================================
/* Menu Subsystem */

export function M_Init(): void {
  Cmd_AddCommand("togglemenu", M_ToggleMenu_f);

  Cmd_AddCommand("menu_main", M_Menu_Main_f);
  Cmd_AddCommand("menu_singleplayer", M_Menu_SinglePlayer_f);
  Cmd_AddCommand("menu_load", M_Menu_Load_f);
  Cmd_AddCommand("menu_save", M_Menu_Save_f);
  Cmd_AddCommand("menu_multiplayer", M_Menu_MultiPlayer_f);
  Cmd_AddCommand("menu_setup", M_Menu_Setup_f);
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

  // menuState.m_state is narrowed to exclude m_none by the early return
  // above (TS retains that across the calls in between), so the C's
  // `case m_none: break;` -- already a no-op -- is provably unreachable here
  // and omitted rather than a type error.
  switch (menuState.m_state) {
    case MStateT.m_main:
      M_Main_Draw();
      break;

    case MStateT.m_singleplayer:
      M_SinglePlayer_Draw();
      break;

    case MStateT.m_load:
      M_Load_Draw();
      break;

    case MStateT.m_save:
      M_Save_Draw();
      break;

    case MStateT.m_multiplayer:
      M_MultiPlayer_Draw();
      break;

    case MStateT.m_setup:
      M_Setup_Draw();
      break;

    case MStateT.m_net:
      M_Net_Draw();
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

    case MStateT.m_serialconfig:
    case MStateT.m_modemconfig:
      // dropped: serial/modem config screens (net_ser was not ported)
      break;

    case MStateT.m_lanconfig:
      M_LanConfig_Draw();
      break;

    case MStateT.m_gameoptions:
      M_GameOptions_Draw();
      break;

    case MStateT.m_search:
      M_Search_Draw();
      break;

    case MStateT.m_slist:
      M_ServerList_Draw();
      break;
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

    case MStateT.m_load:
      M_Load_Key(key);
      return;

    case MStateT.m_save:
      M_Save_Key(key);
      return;

    case MStateT.m_multiplayer:
      M_MultiPlayer_Key(key);
      return;

    case MStateT.m_setup:
      M_Setup_Key(key);
      return;

    case MStateT.m_net:
      M_Net_Key(key);
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

    case MStateT.m_serialconfig:
    case MStateT.m_modemconfig:
      // dropped: serial/modem config screens (net_ser was not ported)
      return;

    case MStateT.m_lanconfig:
      M_LanConfig_Key(key);
      return;

    case MStateT.m_gameoptions:
      M_GameOptions_Key(key);
      return;

    case MStateT.m_search:
      M_Search_Key(key);
      break;

    case MStateT.m_slist:
      M_ServerList_Key(key);
      return;
  }
}

export function M_ConfigureNetSubsystem(): void {
  // enable/disable net systems to match desired config

  Cbuf_AddText("stopdemo\n");
  if (SerialConfig() || DirectConfig()) {
    Cbuf_AddText("com1 enable\n");
  }

  if (IPXConfig() || TCPIPConfig()) {
    // DEVIATION: net_hostport (net_main.ts) has no exported setter; route
    // through the "port" command instead of `net_hostport = lanConfig_port`.
    // See file header.
    Cbuf_AddText(`port ${menuState.lanConfig_port}\n`);
  }
}

// module-load hook registration -- see file header and cl_main.ts/keys.ts's
// identical pattern.
function registerMenuHooks(): void {
  hostClientHooks.mInit = M_Init;
  hostClientHooks.mMenuQuitF = M_Menu_Quit_f;
}

registerMenuHooks();
