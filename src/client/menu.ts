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

U17 addition (2026-09-06, "the menus learn the re-release content"): three
new screens with no WinQuake C original -- `m_qex_episodes` (the New Game
episode picker), `m_qex_levels` (level select + Ruleset + Difficulty +
Start, one combined screen per this unit's brief), `m_qex_addons` (reached
from Options, lists mounted gamedirs and switches with the `game` command).
Their content/launch model lives in the new src/client/menu_content.ts (see
that file's own header for the import-cycle-avoidance split, matching
quake-2-re-ts's menu.ts/menu_content.ts precedent). M_SinglePlayer_Key's
"New Game" item (cursor 0) is the only existing entry point touched: it
gates on whether LoadContentModel() finds any mounted mapdb.json episodes,
and falls through to the ORIGINAL classic body (byte-for-byte, including the
SCR_ModalMessage confirmation) when it doesn't -- test/menu.test.ts's
existing assertions never mount a re-release root, so they exercise that
unchanged classic body. The Load/Save screens grow a 13th row ("Autosave",
scanned from `<gamedir>/autosave/` the same way M_ScanSaves already reads
`s<N>.sav`) and the Options screen grows seven rows (gl_coloredlight,
snd_speed, sv_autosave, cl_weaponswitch, language, joy_enable, Add-Ons) --
all read/set BY NAME through cvar.ts, exactly like every other Options row
in this file (see this header's own cvars-by-name note above), since none of
those cvars are owned by a module this unit is scoped to import directly.

U40 addition (2026-09-06, "the multiplayer menus learn bots, rulesets,
protocols and the unified client"): no WinQuake C original for any of this --
menu.c predates bots, `sv_ruleset`/`sv_protocol`/`cl_protocol` and QuakeWorld
entirely.

- The Multiplayer menu stays the classic three-item picture menu. Bots are
  configured on the Start Server (GameOptions) screen's Bot Count / Bot Skill
  rows and join when the game begins; the separate "Bots" page with a named
  roster (U40) was removed on 2026-09-07 (P1/P2: drawn in the wrong font,
  its count/skill rows could not be selected, and it offered no way to start
  a game or pick the mode).
- GameOptions (the classic "New Game" -- start a listen server) keeps its
  original nine rows (0-8) untouched, byte-for-byte, and gains four more
  (9 Ruleset, 10 Protocol, 11 Bot Count, 12 Bot Skill) appended after them --
  NUM_GAMEOPTIONS/gameoptions_cursor_table grow accordingly, but every
  existing row's cursor position/behavior is unchanged. Game Type (row 2)
  gains a third state, CTF, only when the "ctf" gamedir is mounted
  (qexModel().addonDirs) -- with no ctf mount it stays the classic
  Deathmatch/Cooperative toggle exactly. Episode/Level (rows 7-8) source
  their map list from mapdb.json's `dm`/`coop` flags (menu_content.ts's
  BuildMpEpisodes/CtfMaps) whenever a mapdb.json is mounted for the current
  game type, falling back to the classic hardcoded levels/episodes tables
  (unchanged) otherwise -- so with no re-release data mounted, Episode/Level
  behave exactly as before. The Begin Game launch (ENTER on row 0) queues
  `disconnect; listen 0; maxplayers N` (unchanged classic prefix), then the
  new `sv_ruleset <id>`, `sv_protocol <val>`, `game <dir>` (only when a
  mapdb-driven episode/ctf dir applies), `teamplay 1` (ctf only), `bot_count
  <n>`, `bot_skill <name>`, and finally the classic `map <bsp>` suffix.
- LanConfig's Join Game path (JoiningGame()) gains a fourth row, Protocol,
  cycling `cl_protocol` through CL_PROTOCOLS (auto/nq/qw) -- the New Game
  (StartingGame()) path is untouched (NUM_LANCONFIG_CMDS/lanConfig_cursor_table
  keep their classic 3-row shape and values for that path; see
  lanConfigRowCount below). The classic "Join game at:" address field and LAN
  search entries are unchanged; profile.ts's own connectProfileFor already
  reads the address's `:port` (QuakeWorld per the connect rule) or
  `cl_protocol` at `connect` time, so this row only needs to set the cvar.
- Setup gains a Team row, cycling two preset shirt/pants colors (CTF's own
  "team via color" convention per this repo's PORTING notes), only when the
  "ctf" gamedir is mounted -- NUM_SETUP_CMDS/setup_cursor_table keep their
  classic 5-row shape and values otherwise. DEVIATION: quakec_ctf itself is
  not ported into this repo yet (no ground truth to check the exact
  Red/Blue color indices against), so CTF_TEAM_COLORS below documents its
  own assumption (colors 4/13, the commonly cited id1-era CTF mod's Red/Blue)
  rather than asserting it against source; follow-up: revisit once
  quakec_ctf lands.

F14 addition (2026-09-06, "menu text draws through the kfont path"): U17/F3
gave the menus localized labels through MenuLoc, but every one of them still
reached the screen one byte at a time through the classic 8x8 conchars
charset, so loc_russian.txt's "Один игрок" drew whatever those Cyrillic code
points happened to index into that charset. M_Print/M_PrintWhite (and
M_PrintRight's alignment) now go through src/client/kfont_text.ts's
Text_Draw/Text_Width -- the same glyph provider the console and status bar
already use, gated by the same `scr_usekfont`/`con_font` cvars -- at
menuTextScale(), which is Text_RowScale(MENU_ROW_HEIGHT). With no kfont
selected (a classic boot; scr_usekfont defaults to 0) that scale is exactly
1 and Text_Draw's own classic branch emits the same Draw_Character calls at
the same coordinates menu.c's loops did, so a classic menu is unchanged.
The screens that place something after or around a run of text
(Setup/LanConfig's typing cursor, the Customize-controls "or" column, the
centred one-line notices) measure that run with M_TextWidth instead of
`length * 8`, which is the same number with the classic charset and the real
drawn width with a proportional font.

G4 addition (2026-09-06, "the menus scale to the window"): menu.c drew its
fixed 320x200 layout at 1:1 device pixels, horizontally centred and pinned to
the top of the screen (`x + ((vid.width - 320) >> 1)`), which on any modern
window leaves the whole tree a postage stamp in the upper-left. The five
primitives above (M_DrawCharacter, M_DrawText, M_DrawTransPic, M_DrawPic,
M_DrawTransPicTranslate) are the only places this file reaches a renderer, so
they now convert canvas units to window units through one transform --
gl_draw.c GL_SetCanvas's CANVAS_MENU: a 320x200 canvas at screen.ts's
MenuScale() (`scr_menuscale`, defaulting to the largest whole scale that
fits), centred on both axes exactly as GL_SetCanvas centres it. Pics go
through Draw_ScaledPic/Draw_ScaledTransPic (nearest neighbour), text through
Text_Draw's own scale argument, and the conchars artwork M_DrawCharacter
draws through the classic branch of Draw_GlyphAtlas -- the same atlas source
Text_Draw's scaled classic path already uses. At scale 1 every one of the
five emits exactly the call it did before, including the C's own
`(vid.width - 320) >> 1` centring, so a 320x200 boot is unchanged.

Nothing else moves: key handling, cursor tables and every column literal in
this file stay in 320x200 units.

The screens whose rows come from mounted data -- the mapdb episode picker and
level select, Add-Ons and the characters.txt bots roster -- additionally draw
a bounded window of rows that follows their cursor (M_ListWindow), because a
full re-release install has more of them than 200 rows hold: a 32-map episode
and a 173-entry bots roster both ran off the bottom of the screen and drew
through gfx/qplaque.lmp on the way down. Those four screens also move their
columns right, clear of the plaque. The Load/Save screens keep their original
columns: 12 slots plus F3's Autosave row end at y 136, inside the canvas.

M_DrawCharacter is deliberately NOT rerouted: its callers draw the blinking
cursor (charset entries 12/13 and 10/11), the slider parts (128-131) and the
level-select '*', none of which any kfont defines a glyph for -- they are
conchars artwork, not text, and stay on the classic primitive under every
font setting. Menu titles are .lmp pics and are likewise untouched.
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
import { Host_Quit_f, Host_NewestAutosave, SAVEGAME_VERSION_KEX } from "../common/host_cmd";
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
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cbuf_AddText, Cbuf_InsertText } from "../common/cmd";
import { Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString } from "../common/cvar";
import { com_gamedir, Q_atoi, registered, rogue, hipnotic } from "../common/common";
import { Sys_FileOpenRead, Sys_FileRead, Sys_FileClose, Sys_Error } from "../platform/sys";
import { SAVEGAME_COMMENT_LENGTH } from "../common/quakedef";
import { Com_sprintf } from "../common/sprintf";
import { Con_ToggleConsole_f } from "./console";
import { SCR_ModalMessage, SCR_BeginLoadingPlaque, MenuScale, MENU_CANVAS_WIDTH, MENU_CANVAS_HEIGHT } from "./screen";
import { Text_Draw, Text_RowScale, Text_Width } from "./kfont_text";
import { S_LocalSound, S_ExtraUpdate } from "./snd_dma";
import {
  type ContentModel,
  type ContentEpisode,
  type MpEpisode,
  RULESETS,
  DIFFICULTIES,
  SV_PROTOCOLS,
  CL_PROTOCOLS,
  LoadContentModel,
  LoadMenuLocalization,
  LocalizedEpisodeName,
  MenuLoc,
  EpisodeAllowsNightmare,
  ResolveLaunch,
  Content_PerformLaunch,
  AvailableLanguages,
  BuildMpEpisodes,
  CtfMaps,
  AvailableBotSkillNames,
} from "./menu_content";

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
  // U17 additions -- see file header. Appended after the last WinQuake
  // ordinal so every existing MStateT value keeps its original number.
  m_qex_episodes,
  m_qex_levels,
  m_qex_addons,
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

  // U17 additions -- see file header. Not WinQuake C globals (no C original
  // has a re-release content picker), but kept on this same shared-state
  // object per this file's own "shared mutable globals become an exported
  // const singleton" convention.
  qexEpisodeCursor: 0,
  qexSelectedEpisode: 0,
  qexLevelCursor: 0,
  qexSelectedLevel: 0,
  qexRulesetIndex: 1, // RULESETS[1] === "rerelease" -- mapdb.json only ever appears under a mounted re-release root
  qexSkill: 1, // Normal
  qexAddonsCursor: 0,

  // G4 additions: the first visible row of each data-driven screen's bounded
  // list window (see M_ListWindow). Not WinQuake C globals -- menu.c has no
  // list long enough to need one.
  qexEpisodeTop: 0,
  qexLevelTop: 0,
  qexAddonsTop: 0,

  // U40 additions -- see file header. Not WinQuake C globals; kept on this
  // same shared-state object per this file's own convention.
  gameoptionsRulesetIndex: 1, // RULESETS[1] === "rerelease"
  gameoptionsProtocolIndex: 0, // SV_PROTOCOLS[0] === "auto"
  gameoptionsBotCount: 0,
  gameoptionsBotSkillIndex: 2, // the six-name list's "medium" -- bot_skill's own cvar default
  gameoptionsCtf: false, // Game Type's third state, only reachable when the ctf gamedir is mounted
  setupTeamIndex: 0, // CTF_TEAM_COLORS index for the Setup screen's Team row
};

// U17 additions -- see file header. Cached content model, refreshed each
// time the New Game / Add-Ons entry points below are opened (LoadContentModel
// re-scans the mounted filesystem, which does not change mid-session in this
// engine except through the "game" command menu.ts itself queues). Not a
// WinQuake C global, so it doesn't live on menuState (that object is for
// scalar C-global fidelity; this is a whole cached model).
let qexContentModel: ContentModel | null = null;
let qexLocLoaded = false;

const EMPTY_CONTENT_MODEL: ContentModel = {
  roots: { classicRoot: "", rereleaseRoot: "", isRerelease: false },
  mapdbPresent: false,
  mapdbErrors: [],
  episodes: [],
  addonDirs: [],
  rawMapdb: null,
  mountedDirs: [],
};

function qexModel(): ContentModel {
  return qexContentModel ?? EMPTY_CONTENT_MODEL;
}

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

// U40 addition: whether the "ctf" gamedir (ADDON_DIRS) is currently mounted
// -- gates GameOptions' Game Type CTF state, its mapdb-driven CTF map list,
// and Setup's Team row. Not a WinQuake C concept.
function ctfMounted(): boolean {
  return qexModel().addonDirs.includes("ctf");
}

/*
==============================================================================

						MENU CANVAS

gl_draw.c's GL_SetCanvas CANVAS_MENU: every menu screen in menu.c is laid
out on a fixed 320x200 canvas, and that canvas is drawn scaled by
`scr_menuscale` (screen.ts's MenuScale) and centred in the window. Position
AND size both scale -- the five primitives below are the only places menu.c
reaches a renderer, so this is the one transform the whole classic tree
draws through.

Layout, cursor movement and column math all stay in 320x200 units: only the
five functions here convert. At scale 1 with a 320-wide window every one of
them emits exactly the call menu.c's own body did, including the C's
`x + ((vid.width - 320) >> 1)` centring for a wider window at scale 1.

==============================================================================
*/

const MENU_GLYPH_SIZE = 8;

/** The whole-pixel scale the menu canvas is drawn at. */
export function M_CanvasScale(): number {
  return MenuScale();
}

/** Canvas x -> window x. */
export function M_CanvasX(cx: number): number {
  const s = M_CanvasScale();
  return Math.floor((vid.width - MENU_CANVAS_WIDTH * s) / 2) + cx * s;
}

/** Canvas y -> window y. */
export function M_CanvasY(cy: number): number {
  const s = M_CanvasScale();
  return Math.floor((vid.height - MENU_CANVAS_HEIGHT * s) / 2) + cy * s;
}

/*
==============================================================================

						MENU LIST WINDOW

G4: the screens whose rows come from mounted data (menu_content.ts's
episodes, per-episode level lists, add-on gamedirs and the characters.txt
bots roster) have no fixed row count -- a full re-release install lists far
more rows than the 200-row canvas holds, and drawing them all ran the column
off the bottom of the screen and through gfx/qplaque.lmp on the way down.
Each of those screens draws a bounded window of rows that follows its own
cursor instead, with a `^`/`v` indicator in the cursor gutter when there are
rows outside the window.

The geometry below is in canvas units. gfx/qplaque.lmp is 32x144 drawn at
(16, 4), so it covers x 16..48 and y 4..148: a list column at x 72 with its
cursor gutter at x 56 clears it entirely. The title pic on each of these
screens is 24 tall at y 4, so the first list row sits at y 40 with the "more
above" indicator in the row above it.

==============================================================================
*/

const MENU_LIST_X = 72; // list text column, clear of the plaque
const MENU_LIST_CURSOR_X = 56; // blinking cursor and scroll indicators
const MENU_LIST_MARK_X = 64; // the level screen's selected-level '*'
const MENU_LIST_TOP = 40; // first visible row
const MENU_LIST_UP_Y = 32; // "more above" indicator

/** A pure list: rows 40..176, "more below" at 184. */
const MENU_LIST_ROWS = 18;
/** The level screen: rows 40..144, "more below" at 152, then the three
 * fixed rows below the gap. */
const MENU_LEVEL_LIST_ROWS = 14;
const MENU_LEVEL_FIXED_Y: readonly number[] = [168, 176, 184]; // Ruleset, Difficulty, Start
/** The bots page: two fixed rows at 40/48, "more above" at 56, roster rows
 * 64..160, "more below" at 168, Add Random at 176, the disabled note at 184. */
const MENU_BOTS_LIST_TOP = 64;
const MENU_BOTS_UP_Y = 56;
const MENU_BOTS_DOWN_Y = 168;
const MENU_BOTS_ADD_RANDOM_Y = 176;

export interface MenuListWindowT {
  /** index of the first visible row */
  readonly top: number;
  /** how many rows are drawn */
  readonly visible: number;
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
}

/**
 * The window of `capacity` rows out of `total` that contains `cursor`,
 * scrolled as little as possible from `prevTop`. A `cursor` outside
 * [0, total) leaves the window where it was (the level screen parks its
 * cursor on the Ruleset/Difficulty/Start rows below the list).
 */
export function M_ListWindow(total: number, cursor: number, capacity: number, prevTop: number): MenuListWindowT {
  const visible = total < capacity ? total : capacity;
  let top = Number.isFinite(prevTop) ? Math.trunc(prevTop) : 0;
  const maxTop = total - visible;
  if (top > maxTop) top = maxTop;
  if (top < 0) top = 0;
  if (cursor >= 0 && cursor < total) {
    if (cursor < top) top = cursor;
    else if (cursor >= top + visible) top = cursor - visible + 1;
  }
  return { top, visible, moreAbove: top > 0, moreBelow: top + visible < total };
}

function M_DrawListIndicators(x: number, upY: number, downY: number, w: MenuListWindowT): void {
  if (w.moreAbove) M_DrawCharacter(x, upY, "^".charCodeAt(0));
  if (w.moreBelow) M_DrawCharacter(x, downY, "v".charCodeAt(0));
}

/*
================
M_DrawCharacter

Draws one solid graphics character
================
*/
export function M_DrawCharacter(cx: number, line: number, num: number): void {
  const s = M_CanvasScale();
  const x = M_CanvasX(cx);
  const y = M_CanvasY(line);
  const r = getRenderer();
  if (s === 1 || r.Draw_GlyphAtlas === undefined) {
    r.Draw_Character(x, y, num);
    return;
  }
  // The conchars artwork this function's callers draw (the blinking cursor,
  // the slider parts, the level-select '*') scaled through the same
  // classic-charset atlas source Text_Draw's own scaled branch uses.
  num = num & 0xff;
  if (num === 32) return; // Draw_Character's own space check
  const row = num >> 4;
  const col = num & 15;
  r.Draw_GlyphAtlas(x, y, MENU_GLYPH_SIZE * s, MENU_GLYPH_SIZE * s, { kind: "classic" }, col * 8, row * 8, 8, 8, null);
}

/* Every menu screen in menu.c is laid out on a fixed 8-pixel row grid. */
const MENU_ROW_HEIGHT = 8;

/* The Text_Draw/Text_Width scale one menu row asks for: 1 with the classic
 * charset (its cell is the row), and however much shrinks one kfont/TTF line
 * into a row when one of those fonts is selected -- see kfont_text.ts's F14
 * note. */
function menuTextScale(): number {
  return Text_RowScale(MENU_ROW_HEIGHT);
}

/* The drawn width of a menu string, for the screens that position something
 * after or around a run of text. Equals `str.length * 8` with the classic
 * charset, which is the literal the C wrote at each of those sites. */
function M_TextWidth(str: string): number {
  return Text_Width(str, menuTextScale());
}

/* menu.c has M_Print and M_PrintWhite as two copies of one loop differing
 * only by the `+128` alt-charset bit. Both route through kfont_text.ts's
 * Text_Draw so a localized label draws the font's own glyphs; with the
 * classic charset selected Text_Draw's scale-1 branch emits the same
 * per-character Draw_Character calls at the same positions, and the `| 0x80`
 * it applies for `alt` is the same value `+128` produced for every character
 * menu.c could hold (a codepoint above 127 -- only reachable through a
 * localized string, which menu.c had no way to draw at all -- wraps into the
 * charset instead of running off the end of it). */
function M_DrawText(cx: number, cy: number, str: string, alt: boolean): void {
  Text_Draw(M_CanvasX(cx), M_CanvasY(cy), str, alt, menuTextScale() * M_CanvasScale());
}

export function M_Print(cx: number, cy: number, str: string): void {
  M_DrawText(cx, cy, str, true);
}

export function M_PrintWhite(cx: number, cy: number, str: string): void {
  M_DrawText(cx, cy, str, false);
}

/* G4: a menu label drawn at a MULTIPLE of the 8px row grid, for the one row
 * that has to match a picture row's glyph size rather than the text grid --
 * gfx/mp_menu.lmp is a fixed three-item graphic, so U40's fourth item has no
 * art of its own. `mult` multiplies the canvas scale, so the label tracks
 * scr_menuscale like everything else. */
function M_PrintBig(cx: number, cy: number, str: string, mult: number): void {
  Text_Draw(M_CanvasX(cx), M_CanvasY(cy), str, true, menuTextScale() * M_CanvasScale() * mult);
}

/* D7: a menu label the retail localization tables have a key for. `english`
 * is what draws when they don't -- a classic tree with no localization/
 * directory at all, or one of the labels listed in this unit's report for
 * which the shipped tables never shipped a key. */
function M_Loc(key: string, english: string): string {
  return MenuLoc(key, english);
}

/* menu.c right-aligns a column of labels by hand-padding each literal to the
 * same width; a localized label is a different length, so the padding is
 * computed here instead of being written into the string. `width` is the
 * original literal's own length, which keeps the English layout of each row
 * pixel-identical to the C -- including the rows menu.c itself left one
 * column short of its neighbours. The padding measures the label with
 * M_TextWidth rather than counting characters, so a proportional kfont
 * right-aligns on its own drawn width; with the classic charset
 * M_TextWidth(str) is str.length * 8 and the column is the C's. */
function M_PrintRight(cx: number, cy: number, width: number, str: string): void {
  M_Print(cx + Math.max(0, width * 8 - M_TextWidth(str)), cy, str);
}

/* menu.c hand-wraps the multi-line message boxes into fixed-width literals.
 * The retail tables spell each of those messages as ONE key, so a localized
 * message is wrapped here to the same column count and padded out to the
 * same `lines` rows the box was drawn for. */
/* menu_content.ts's DIFFICULTIES, keyed to the retail table's own four skill
 * names. The re-release calls the second one "Medium" where this port's own
 * list says "Normal"; the table wins wherever it has the key. */
const DIFFICULTY_LOC_KEYS: readonly string[] = ["$m_easy", "$m_medium", "$m_hard", "$m_nightmare"];

function M_DifficultyName(skill: number): string {
  const key = DIFFICULTY_LOC_KEYS[skill];
  const english = DIFFICULTIES[skill] ?? "";
  return key === undefined ? english : M_Loc(key, english);
}

function M_WrapText(str: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of str.split(/\s+/).filter((w) => w.length > 0)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line.length > 0) out.push(line);
  while (out.length < lines) out.push("");
  return out.slice(0, lines);
}

// not a ported C name; see file header's Draw_CachePic deviation note.
function cachePic(path: string): QpicT {
  const p = getRenderer().Draw_CachePic(path);
  if (p === null) Sys_Error("cachePic: couldn't load %s", path);
  return p;
}

export function M_DrawTransPic(x: number, y: number, pic: QpicT): void {
  const s = M_CanvasScale();
  const r = getRenderer();
  const dx = M_CanvasX(x);
  const dy = M_CanvasY(y);
  if (s === 1 || r.Draw_ScaledTransPic === undefined) r.Draw_TransPic(dx, dy, pic);
  else r.Draw_ScaledTransPic(dx, dy, pic, s);
}

export function M_DrawPic(x: number, y: number, pic: QpicT): void {
  const s = M_CanvasScale();
  const r = getRenderer();
  const dx = M_CanvasX(x);
  const dy = M_CanvasY(y);
  if (s === 1 || r.Draw_ScaledPic === undefined) r.Draw_Pic(dx, dy, pic);
  else r.Draw_ScaledPic(dx, dy, pic, s);
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
  const s = M_CanvasScale();
  const r = getRenderer();
  const dx = M_CanvasX(x);
  const dy = M_CanvasY(y);
  if (s === 1 || r.Draw_ScaledTransPic === undefined) r.Draw_TransPicTranslate(dx, dy, pic, translationTable);
  else r.Draw_ScaledTransPic(dx, dy, pic, s, translationTable);
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
          // U17: a mounted re-release mapdb.json (at least one episode with
          // sp maps) switches "New Game" to the episode picker; with no
          // mapdb.json (a classic-only install, or none of its episodes'
          // dirs are actually mounted), fall through to the ORIGINAL
          // classic body untouched -- see file header.
          qexContentModel = LoadContentModel();
          if (qexModel().episodes.length > 0) {
            M_Menu_QexEpisodes_f();
            break;
          }

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

// U17 addition: a 13th row, the newest `<gamedir>/autosave/*.sav` (see this
// unit's brief and src/common/host_cmd.ts's own Host_AutosaveDir/
// Host_NewestAutosave header comments -- both are private to that file, so
// this is a local re-reading of the same directory rather than a call into
// them). LOAD_ROWS is the total row count both screens' cursors wrap over.
export const AUTOSAVE_SLOT = MAX_SAVEGAMES;
export const LOAD_ROWS = MAX_SAVEGAMES + 1;
export let autosaveFilename = "--- NO AUTOSAVE ---";
export let autosaveLoadable = false;

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

// Reads one already-open save file's comment the same way the loop in
// M_ScanSaves below does; factored out so scanAutosave (a different source
// path) can share it.
function readSaveComment(path: string): string | null {
  const opened = Sys_FileOpenRead(path);
  if (opened.handle === -1) return null;

  const bytes = new Uint8Array(opened.length);
  Sys_FileRead(opened.handle, bytes, opened.length);
  Sys_FileClose(opened.handle);
  let contents = "";
  for (let k = 0; k < bytes.length; k++) contents += String.fromCharCode(bytes[k]);
  const scan = new SaveTextScanner(contents);

  const version = scan.scanToken(); // read, exactly as the C's fscanf
  // S2: a KEX (version 6) file writes COM_GetGameNames() on its own line
  // between the version and the comment (host_cmd.ts's Host_WriteSaveFile),
  // so discarding one token left the Load/Save menu showing the save's
  // game/mod name where the level name and kill count belong.
  if (Q_atoi(version) === SAVEGAME_VERSION_KEX) scan.scanToken();
  // strncpy (m_filenames[i], name, sizeof(m_filenames[i])-1)
  let comment = scan.scanToken().slice(0, SAVEGAME_COMMENT_LENGTH);

  // change _ back to space
  comment = comment.replace(/_/g, " ");
  return comment;
}

// U17 addition: the newest `<gamedir>/autosave/*.sav` (host_cmd.ts's own
// Host_NewestAutosave, re-read here since that function is private to that
// file -- see this unit's brief and AUTOSAVE_SLOT's comment above). Only the
// comment is needed here (the load itself just runs `load autosave`, which
// Host_Loadgame_f resolves to the newest slot on its own), so the resolved
// path isn't kept past this function.
function scanAutosave(): void {
  autosaveFilename = "--- NO AUTOSAVE ---";
  autosaveLoadable = false;

  // S1: shared with `load autosave` rather than re-derived here, so the row
  // and the command cannot disagree about which slot is newest -- nested
  // slots (autosave/vault/tim.sav) included.
  const best = Host_NewestAutosave();
  if (best === null) return;

  const comment = readSaveComment(best);
  if (comment === null) return;
  autosaveFilename = comment;
  autosaveLoadable = true;
}

export function M_ScanSaves(): void {
  for (let i = 0; i < MAX_SAVEGAMES; i++) {
    m_filenames[i] = "--- UNUSED SLOT ---";
    loadable[i] = false;
    const comment = readSaveComment(`${com_gamedir}/s${i}.sav`);
    if (comment === null) continue;
    m_filenames[i] = comment;
    loadable[i] = true;
  }
  scanAutosave();
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
  M_Print(16, 32 + 8 * AUTOSAVE_SLOT, autosaveFilename);

  // line cursor
  M_DrawCharacter(8, 32 + menuState.load_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
}

export function M_Save_Draw(): void {
  const p = cachePic("gfx/p_save.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  for (let i = 0; i < MAX_SAVEGAMES; i++) M_Print(16, 32 + 8 * i, m_filenames[i]);
  M_Print(16, 32 + 8 * AUTOSAVE_SLOT, autosaveFilename);

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
      // U17: the Autosave row (see AUTOSAVE_SLOT) runs `load autosave`
      // instead of `load s<N>` -- Host_Loadgame_f resolves that to the
      // newest `<gamedir>/autosave/*.sav` slot itself.
      if (menuState.load_cursor === AUTOSAVE_SLOT) {
        if (!autosaveLoadable) return;
        menuState.m_state = MStateT.m_none;
        keyState.key_dest = KeydestT.key_game;
        SCR_BeginLoadingPlaque();
        Cbuf_AddText("load autosave\n");
        return;
      }
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
      if (menuState.load_cursor < 0) menuState.load_cursor = LOAD_ROWS - 1;
      break;

    case K_DOWNARROW:
    case K_RIGHTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor++;
      if (menuState.load_cursor >= LOAD_ROWS) menuState.load_cursor = 0;
      break;
  }
}

export function M_Save_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_SinglePlayer_f();
      break;

    case K_ENTER:
      // U17: the Autosave row isn't a manual save target (autosave writes to
      // `<gamedir>/autosave/<mapname>.sav`, named by map rather than by
      // slot) -- ENTER on it is a no-op, the same way an unused classic slot
      // is on the Load screen.
      if (menuState.load_cursor === AUTOSAVE_SLOT) return;
      menuState.m_state = MStateT.m_none;
      keyState.key_dest = KeydestT.key_game;
      Cbuf_AddText(`save s${menuState.load_cursor}\n`);
      return;

    case K_UPARROW:
    case K_LEFTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor--;
      if (menuState.load_cursor < 0) menuState.load_cursor = LOAD_ROWS - 1;
      break;

    case K_DOWNARROW:
    case K_RIGHTARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.load_cursor++;
      if (menuState.load_cursor >= LOAD_ROWS) menuState.load_cursor = 0;
      break;
  }
}

//=============================================================================
/* NEW GAME: EPISODE PICKER (U17 addition -- see file header; no WinQuake C
   original) */

export function M_Menu_QexEpisodes_f(): void {
  qexLocLoaded = LoadMenuLocalization() > 0;
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_qex_episodes;
  menuState.m_entersound = true;
  const count = qexModel().episodes.length;
  if (menuState.qexEpisodeCursor < 0 || menuState.qexEpisodeCursor >= count) menuState.qexEpisodeCursor = 0;
}

/*
The `menu_episodes` console command (F3 addition). Unlike M_Menu_QexEpisodes_f
above -- which every in-menu caller reaches with qexContentModel already
refreshed for the mounts in force -- this entry point is queued into the
command buffer BEHIND a `game <dir>` line, so the mounted gamedirs change
between the queueing and the run: it has to reload the content model itself.
An optional argument names the gamedir whose episode the cursor should land
on, which is what makes the Add-Ons screen open that add-on's own New Game
screen. With nothing mounted that has sp maps at all (a classic-only install,
or an add-on with no mapdb episode of its own) there is no episode picker to
show, so it falls back to the Add-Ons list it was reached from.
*/
export function M_Menu_QexEpisodes_Cmd_f(): void {
  qexContentModel = LoadContentModel();
  if (qexModel().episodes.length === 0) {
    M_Menu_QexAddons_f();
    return;
  }
  if (Cmd_Argc() > 1) {
    const wanted = Cmd_Argv(1);
    const index = qexModel().episodes.findIndex((e) => e.dir === wanted);
    if (index >= 0) menuState.qexEpisodeCursor = index;
  }
  M_Menu_QexEpisodes_f();
}

export function M_QexEpisodes_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/ttl_sgl.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  const episodes = qexModel().episodes;
  const w = M_ListWindow(episodes.length, menuState.qexEpisodeCursor, MENU_LIST_ROWS, menuState.qexEpisodeTop);
  menuState.qexEpisodeTop = w.top;

  for (let i = 0; i < w.visible; i++) {
    M_Print(MENU_LIST_X, MENU_LIST_TOP + i * 8, LocalizedEpisodeName(episodes[w.top + i].nameKey, qexLocLoaded));
  }
  M_DrawListIndicators(MENU_LIST_CURSOR_X, MENU_LIST_UP_Y, MENU_LIST_TOP + MENU_LIST_ROWS * 8, w);

  if (episodes.length > 0) {
    M_DrawCharacter(MENU_LIST_CURSOR_X, MENU_LIST_TOP + (menuState.qexEpisodeCursor - w.top) * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
  }
}

export function M_QexEpisodes_Key(key: number): void {
  const episodes = qexModel().episodes;

  switch (key) {
    case K_ESCAPE:
      M_Menu_SinglePlayer_f();
      break;

    case K_UPARROW:
      if (episodes.length === 0) break;
      S_LocalSound("misc/menu1.wav");
      menuState.qexEpisodeCursor--;
      if (menuState.qexEpisodeCursor < 0) menuState.qexEpisodeCursor = episodes.length - 1;
      break;

    case K_DOWNARROW:
      if (episodes.length === 0) break;
      S_LocalSound("misc/menu1.wav");
      menuState.qexEpisodeCursor++;
      if (menuState.qexEpisodeCursor >= episodes.length) menuState.qexEpisodeCursor = 0;
      break;

    case K_ENTER:
      if (episodes.length === 0) break;
      menuState.m_entersound = true;
      menuState.qexSelectedEpisode = menuState.qexEpisodeCursor;
      menuState.qexLevelCursor = 0;
      menuState.qexSelectedLevel = 0;
      M_Menu_QexLevels_f();
      break;
  }
}

//=============================================================================
/* NEW GAME: LEVEL SELECT + RULESET + DIFFICULTY + START (U17 addition -- see
   file header; no WinQuake C original). One combined screen per the unit
   brief: the level rows come first, then a Ruleset row, a Difficulty row,
   then Start -- qexLevelCursor is a single cursor over all of those rows. */

function qexSelectedContentEpisode(): ContentEpisode | null {
  return qexModel().episodes[menuState.qexSelectedEpisode] ?? null;
}

export function M_Menu_QexLevels_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_qex_levels;
  menuState.m_entersound = true;
}

export function M_QexLevels_Draw(): void {
  const episode = qexSelectedContentEpisode();
  if (!episode) {
    M_Menu_QexEpisodes_f();
    return;
  }

  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/ttl_sgl.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  const maps = episode.maps;
  const cursor = menuState.qexLevelCursor;

  // The cursor only steers the window while it is ON a level row; parked on
  // Ruleset/Difficulty/Start it leaves the window where the player left it.
  const w = M_ListWindow(maps.length, cursor < maps.length ? cursor : -1, MENU_LEVEL_LIST_ROWS, menuState.qexLevelTop);
  menuState.qexLevelTop = w.top;

  for (let i = 0; i < w.visible; i++) {
    M_Print(MENU_LIST_X, MENU_LIST_TOP + i * 8, maps[w.top + i].title);
  }
  const selected = menuState.qexSelectedLevel;
  if (selected >= w.top && selected < w.top + w.visible) {
    M_DrawCharacter(MENU_LIST_MARK_X, MENU_LIST_TOP + (selected - w.top) * 8, "*".charCodeAt(0));
  }
  M_DrawListIndicators(MENU_LIST_CURSOR_X, MENU_LIST_UP_Y, MENU_LIST_TOP + MENU_LEVEL_LIST_ROWS * 8, w);

  const ruleset = RULESETS[menuState.qexRulesetIndex].id;
  M_Print(MENU_LIST_X, MENU_LEVEL_FIXED_Y[0], `Ruleset: ${RULESETS[menuState.qexRulesetIndex].name}`);

  const diffCount = EpisodeAllowsNightmare(episode.dir, ruleset) ? 4 : 3;
  if (menuState.qexSkill >= diffCount) menuState.qexSkill = diffCount - 1;
  M_Print(
    MENU_LIST_X,
    MENU_LEVEL_FIXED_Y[1],
    `${M_Loc("$m_difficulty", "Difficulty")}: ${M_DifficultyName(menuState.qexSkill)}`,
  );

  M_Print(MENU_LIST_X, MENU_LEVEL_FIXED_Y[2], M_Loc("$m_start", "Start"));

  const cursorY = cursor < maps.length ? MENU_LIST_TOP + (cursor - w.top) * 8 : (MENU_LEVEL_FIXED_Y[cursor - maps.length] ?? MENU_LEVEL_FIXED_Y[0]);
  M_DrawCharacter(MENU_LIST_CURSOR_X, cursorY, 12 + (Math.trunc(host.realtime * 4) & 1));
}

export function M_QexLevels_Key(key: number): void {
  const episode = qexSelectedContentEpisode();
  if (!episode) {
    M_Menu_QexEpisodes_f();
    return;
  }

  const maps = episode.maps;
  const episodeDir = episode.dir;
  const rulesetRow = maps.length;
  const difficultyRow = maps.length + 1;
  const startRow = maps.length + 2;
  const numRows = maps.length + 3;

  function cycleDifficulty(dir: number): void {
    const ruleset = RULESETS[menuState.qexRulesetIndex].id;
    const diffCount = EpisodeAllowsNightmare(episodeDir, ruleset) ? 4 : 3;
    menuState.qexSkill = (menuState.qexSkill + dir + diffCount) % diffCount;
  }

  switch (key) {
    case K_ESCAPE:
      M_Menu_QexEpisodes_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.qexLevelCursor--;
      if (menuState.qexLevelCursor < 0) menuState.qexLevelCursor = numRows - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.qexLevelCursor++;
      if (menuState.qexLevelCursor >= numRows) menuState.qexLevelCursor = 0;
      break;

    case K_LEFTARROW:
      if (menuState.qexLevelCursor === rulesetRow) {
        S_LocalSound("misc/menu3.wav");
        menuState.qexRulesetIndex = (menuState.qexRulesetIndex - 1 + RULESETS.length) % RULESETS.length;
      } else if (menuState.qexLevelCursor === difficultyRow) {
        S_LocalSound("misc/menu3.wav");
        cycleDifficulty(-1);
      }
      break;

    case K_RIGHTARROW:
      if (menuState.qexLevelCursor === rulesetRow) {
        S_LocalSound("misc/menu3.wav");
        menuState.qexRulesetIndex = (menuState.qexRulesetIndex + 1) % RULESETS.length;
      } else if (menuState.qexLevelCursor === difficultyRow) {
        S_LocalSound("misc/menu3.wav");
        cycleDifficulty(1);
      }
      break;

    case K_ENTER:
      menuState.m_entersound = true;
      if (menuState.qexLevelCursor < maps.length) {
        menuState.qexSelectedLevel = menuState.qexLevelCursor;
      } else if (menuState.qexLevelCursor === rulesetRow) {
        menuState.qexRulesetIndex = (menuState.qexRulesetIndex + 1) % RULESETS.length;
      } else if (menuState.qexLevelCursor === difficultyRow) {
        cycleDifficulty(1);
      } else if (menuState.qexLevelCursor === startRow) {
        const levelIndex = menuState.qexSelectedLevel >= 0 && menuState.qexSelectedLevel < maps.length ? menuState.qexSelectedLevel : 0;
        const chosenMap = maps[levelIndex].bsp;
        const ruleset = RULESETS[menuState.qexRulesetIndex].id;
        const plan = ResolveLaunch(episode, ruleset, chosenMap, menuState.qexSkill);

        keyState.key_dest = KeydestT.key_game;
        menuState.m_state = MStateT.m_none;
        SCR_BeginLoadingPlaque();
        Content_PerformLaunch(plan);
      }
      break;
  }
}

//=============================================================================
/* ADD-ONS (U17 addition -- see file header; no WinQuake C original). Reached
   from the Options screen; lists the mounted gamedirs (base game plus every
   mounted mission-pack-style dir) and switches with the `game` command. */

export function M_Menu_QexAddons_f(): void {
  qexContentModel = LoadContentModel();
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_qex_addons;
  menuState.m_entersound = true;
  const count = qexModel().addonDirs.length + 1; // +1 for the base game row
  if (menuState.qexAddonsCursor < 0 || menuState.qexAddonsCursor >= count) menuState.qexAddonsCursor = 0;
}

function qexAddonsRows(): string[] {
  return ["Base Game", ...qexModel().addonDirs];
}

export function M_QexAddons_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_option.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  const rows = qexAddonsRows();
  const w = M_ListWindow(rows.length, menuState.qexAddonsCursor, MENU_LIST_ROWS, menuState.qexAddonsTop);
  menuState.qexAddonsTop = w.top;

  for (let i = 0; i < w.visible; i++) M_Print(MENU_LIST_X, MENU_LIST_TOP + i * 8, rows[w.top + i]);
  M_DrawListIndicators(MENU_LIST_CURSOR_X, MENU_LIST_UP_Y, MENU_LIST_TOP + MENU_LIST_ROWS * 8, w);

  M_DrawCharacter(MENU_LIST_CURSOR_X, MENU_LIST_TOP + (menuState.qexAddonsCursor - w.top) * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
}

export function M_QexAddons_Key(key: number): void {
  const rows = qexAddonsRows();

  switch (key) {
    case K_ESCAPE:
      M_Menu_Options_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.qexAddonsCursor--;
      if (menuState.qexAddonsCursor < 0) menuState.qexAddonsCursor = rows.length - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.qexAddonsCursor++;
      if (menuState.qexAddonsCursor >= rows.length) menuState.qexAddonsCursor = 0;
      break;

    case K_ENTER: {
      menuState.m_entersound = true;
      // rows[0] is the synthetic "Base Game" label; every real gamedir name
      // is qexModel().addonDirs[cursor - 1] (the actual `game` argument).
      const dirs = qexModel().addonDirs;
      const target = menuState.qexAddonsCursor === 0 ? "id1" : dirs[menuState.qexAddonsCursor - 1];
      Cbuf_AddText(`game ${target}\n`);
      // F3: land on the chosen add-on's OWN New Game screen once the switch
      // (and the quake.rc re-exec Host_Game_f inserts ahead of this line) has
      // run -- the add-on's mapdb episodes are not mounted until then, which
      // is why this is queued behind `game` rather than called here.
      Cbuf_AddText(`menu_episodes ${target}\n`);
      break;
    }
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
  M_PrintWhite(Math.trunc(320 / 2 - M_TextWidth("No Communications Available") / 2), 148, "No Communications Available");
}

export function M_MultiPlayer_Key(key: number): void {
  const items = MULTIPLAYER_ITEMS;

  switch (key) {
    case K_ESCAPE:
      M_Menu_Main_f();
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_multiplayer_cursor++;
      if (menuState.m_multiplayer_cursor >= items) menuState.m_multiplayer_cursor = 0;
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.m_multiplayer_cursor--;
      if (menuState.m_multiplayer_cursor < 0) menuState.m_multiplayer_cursor = items - 1;
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

// U40 addition: two preset shirt/pants colors for CTF's own team-via-color
// convention (see file header's DEVIATION note on the exact indices).
const CTF_TEAM_COLORS: ReadonlyArray<{ name: string; locKey: string; color: number }> = [
  { name: "Red", locKey: "$m_red", color: 4 },
  { name: "Blue", locKey: "$m_blue", color: 13 },
];

// U40 additions: with the "ctf" gamedir mounted, Setup grows a Team row
// between Pants and Accept Changes, pushing Accept Changes down one slot;
// with no ctf mount these return the classic constants unchanged.
function setupNumCmds(): number {
  return ctfMounted() ? NUM_SETUP_CMDS + 1 : NUM_SETUP_CMDS;
}
function setupAcceptRow(): number {
  return ctfMounted() ? NUM_SETUP_CMDS : NUM_SETUP_CMDS - 1;
}
function setupTeamRow(): number {
  return NUM_SETUP_CMDS - 1; // only meaningful when ctfMounted()
}
function activeSetupCursorTable(): number[] {
  return ctfMounted() ? [40, 56, 80, 104, 120, 148] : setup_cursor_table;
}
function cycleSetupTeam(dir: number): void {
  menuState.setupTeamIndex = (menuState.setupTeamIndex + dir + CTF_TEAM_COLORS.length) % CTF_TEAM_COLORS.length;
  const color = CTF_TEAM_COLORS[menuState.setupTeamIndex]!.color;
  menuState.setup_top = color;
  menuState.setup_bottom = color;
}

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

  const cursorTable = activeSetupCursorTable();
  const acceptRow = setupAcceptRow();

  M_Print(64, 40, "Hostname");
  M_DrawTextBox(160, 32, 16, 1);
  M_Print(168, 40, menuState.setup_hostname);

  M_Print(64, 56, "Your name");
  M_DrawTextBox(160, 48, 16, 1);
  M_Print(168, 56, menuState.setup_myname);

  M_Print(64, 80, M_Loc("$m_shirt_color", "Shirt color"));
  M_Print(64, 104, M_Loc("$m_pants_color", "Pants color"));

  // U40 addition: only drawn with the ctf gamedir mounted; Accept Changes'
  // own box/text move down to cursorTable[acceptRow] to make room.
  if (ctfMounted()) {
    M_Print(64, cursorTable[setupTeamRow()]!, "Team");
    M_Print(
      168,
      cursorTable[setupTeamRow()]!,
      M_Loc(CTF_TEAM_COLORS[menuState.setupTeamIndex]!.locKey, CTF_TEAM_COLORS[menuState.setupTeamIndex]!.name),
    );
  }

  M_DrawTextBox(64, cursorTable[acceptRow]! - 8, 14, 1);
  M_Print(72, cursorTable[acceptRow]!, "Accept Changes");

  const bigbox = cachePic("gfx/bigbox.lmp");
  M_DrawTransPic(160, 64, bigbox);
  const menuplyr = cachePic("gfx/menuplyr.lmp");
  M_BuildTranslationTable(menuState.setup_top * 16, menuState.setup_bottom * 16);
  M_DrawTransPicTranslate(172, 72, menuplyr);

  M_DrawCharacter(56, cursorTable[menuState.setup_cursor]!, 12 + (Math.trunc(host.realtime * 4) & 1));

  if (menuState.setup_cursor === 0)
    M_DrawCharacter(
      168 + M_TextWidth(menuState.setup_hostname),
      cursorTable[menuState.setup_cursor]!,
      10 + (Math.trunc(host.realtime * 4) & 1),
    );

  if (menuState.setup_cursor === 1)
    M_DrawCharacter(
      168 + M_TextWidth(menuState.setup_myname),
      cursorTable[menuState.setup_cursor]!,
      10 + (Math.trunc(host.realtime * 4) & 1),
    );
}

// the C's `forward:` label, reached both by K_RIGHTARROW and (via goto) by
// K_ENTER on cursor 2/3. U40 addition: also advances the Team row's color
// pair, only reachable when ctfMounted() puts the cursor there.
function setupForward(): void {
  S_LocalSound("misc/menu3.wav");
  if (menuState.setup_cursor === 2) menuState.setup_top += 1;
  if (menuState.setup_cursor === 3) menuState.setup_bottom += 1;
  if (ctfMounted() && menuState.setup_cursor === setupTeamRow()) cycleSetupTeam(1);
}

export function M_Setup_Key(k: number): void {
  switch (k) {
    case K_ESCAPE:
      M_Menu_MultiPlayer_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.setup_cursor--;
      if (menuState.setup_cursor < 0) menuState.setup_cursor = setupNumCmds() - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.setup_cursor++;
      if (menuState.setup_cursor >= setupNumCmds()) menuState.setup_cursor = 0;
      break;

    case K_LEFTARROW:
      if (menuState.setup_cursor < 2) return;
      S_LocalSound("misc/menu3.wav");
      if (menuState.setup_cursor === 2) menuState.setup_top -= 1;
      if (menuState.setup_cursor === 3) menuState.setup_bottom -= 1;
      if (ctfMounted() && menuState.setup_cursor === setupTeamRow()) cycleSetupTeam(-1);
      break;

    case K_RIGHTARROW:
      if (menuState.setup_cursor < 2) return;
      setupForward();
      break;

    case K_ENTER: {
      if (menuState.setup_cursor === 0 || menuState.setup_cursor === 1) return;

      if (menuState.setup_cursor !== setupAcceptRow()) {
        setupForward();
        break;
      }

      // Accept Changes
      if (Cvar_VariableString("_cl_name") !== menuState.setup_myname) Cbuf_AddText(`name "${menuState.setup_myname}"\n`);
      if (Cvar_VariableString("hostname") !== menuState.setup_hostname) Cvar_Set("hostname", menuState.setup_hostname);
      if (menuState.setup_top !== menuState.setup_oldtop || menuState.setup_bottom !== menuState.setup_oldbottom)
        Cbuf_AddText(`color ${menuState.setup_top} ${menuState.setup_bottom}\n`);
      menuState.m_entersound = true;
      M_Menu_MultiPlayer_f();
      break;
    }

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
// U17 addition: six more rows after "Video Options" (index 12) -- see this
// unit's brief and file header -- for cvars this file doesn't own (read/set
// BY NAME, same convention as every row above them): snd_speed (13),
// sv_autosave (14), cl_weaponswitch (15), language (16), joy_enable (17),
// and an "Add-Ons" action row (18) that opens M_Menu_QexAddons_f. The
// colored-lighting row U17 put here moved to Video Options (P3, 2026-09-07:
// it is a video setting, and it only ever drove the GL renderer's cvar).
export const OPTIONS_ITEMS = 19;

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

    // _WIN32's case 13 (_windowed_mouse) is dropped; case 12 (Video Options)
    // is an action row handled in M_Options_Key, not here.

    // colored lighting moved to Video Options (P3); rows 13..18 follow.
    case 13: {
      // sound frequency -- U17 addition, snd_speed. Not a slider: cycles
      // through the sample rates snd_dma.ts's mixer actually supports.
      const rates = [11025, 22050, 44100, 48000];
      const current = Math.trunc(Cvar_VariableValue("snd_speed"));
      let idx = rates.indexOf(current);
      if (idx === -1) idx = rates.indexOf(44100);
      idx = (idx + dir + rates.length) % rates.length;
      Cvar_SetValue("snd_speed", rates[idx]);
      break;
    }

    case 14: // autosave -- U17 addition, sv_autosave
      Cvar_SetValue("sv_autosave", Cvar_VariableValue("sv_autosave") ? 0 : 1);
      break;

    case 15: {
      // weapon switch -- U17 addition, cl_weaponswitch: 0=only when the
      // player didn't already have the weapon, 1=never, 2=always (cl_main.ts's
      // own header comment on this cvar) -- a 3-way cycle, not a checkbox.
      let next = Math.trunc(Cvar_VariableValue("cl_weaponswitch")) + dir;
      if (next < 0) next = 2;
      if (next > 2) next = 0;
      Cvar_SetValue("cl_weaponswitch", next);
      break;
    }

    case 16: {
      // language -- U17 addition. Cycles menu_content.ts's AvailableLanguages
      // (only loc files actually mounted in the search path).
      const langs = AvailableLanguages();
      if (langs.length === 0) break;
      const current = Cvar_VariableString("language").trim().toLowerCase();
      let idx = langs.findIndex((l) => l === current);
      if (idx === -1) idx = 0;
      idx = (idx + dir + langs.length) % langs.length;
      Cvar_Set("language", langs[idx]);
      break;
    }

    case 17: // game controller -- U17 addition, joy_enable
      Cvar_SetValue("joy_enable", Cvar_VariableValue("joy_enable") ? 0 : 1);
      break;

    // case 18 (Add-Ons) is an action row handled in M_Options_Key, not here.
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
  if (on) M_Print(x, y, M_Loc("$m_on", "on"));
  else M_Print(x, y, M_Loc("$m_off", "off"));
}

/** The label rows of M_Options_Draw that sit beside the QUAKE plaque, with the right-align width each uses. */
function M_OptionsPlaqueRows(): Array<{ y: number; width: number; label: string }> {
  return [
    { y: 32, width: 22, label: M_Loc("$m_set_binds", "Customize controls") },
    { y: 40, width: 22, label: "Go to console" },
    { y: 48, width: 22, label: M_Loc("$m_reset_settings", "Reset to defaults") },
    { y: 56, width: 22, label: "Screen size" },
    { y: 64, width: 22, label: M_Loc("$m_brightness", "Brightness") },
    { y: 72, width: 22, label: M_Loc("$m_sensitivity", "Mouse Speed") },
    { y: 80, width: 22, label: M_Loc("$m_music_volume", "CD Music Volume") },
    { y: 88, width: 22, label: M_Loc("$m_sound_volume", "Sound Volume") },
    { y: 96, width: 22, label: M_Loc("$m_always_run", "Always Run") },
    { y: 104, width: 22, label: M_Loc("$m_invert_look", "Invert Mouse") },
    { y: 112, width: 22, label: "Lookspring" },
    { y: 120, width: 22, label: "Lookstrafe" },
    { y: 128, width: 22, label: M_Loc("$m_video_settings", "Video Options") },
    { y: 136, width: 21, label: "Sound Frequency" },
    { y: 144, width: 22, label: "Autosave" },
    { y: 152, width: 21, label: M_Loc("$m_change_on_pickup", "Weapon Switch") },
    { y: 160, width: 22, label: M_Loc("$m_language", "Language") },
  ];
}

/**
 * How far right the Options column has to move so no label drawn on a row
 * the plaque spans starts left of the plaque's right edge. Whole classic
 * columns (8 px), 0 when the C's layout already fits.
 */
/** The shift M_Options_Draw applies this frame, from the plaque as cached. */
export function M_OptionsShift(): number {
  const plaque = cachePic("gfx/qplaque.lmp");
  return M_OptionsColumnShift(16 + plaque.width, 4 + plaque.height);
}

export function M_OptionsColumnShift(plaqueRight: number, plaqueBottom: number): number {
  let shift = 0;
  for (const row of M_OptionsPlaqueRows()) {
    if (row.y >= plaqueBottom) continue;
    const startX = 16 + Math.max(0, row.width * 8 - M_TextWidth(row.label));
    if (startX < plaqueRight) shift = Math.max(shift, plaqueRight - startX);
  }
  return Math.ceil(shift / 8) * 8;
}

export function M_Options_Draw(): void {
  const plaque = cachePic("gfx/qplaque.lmp");
  M_DrawTransPic(16, 4, plaque);
  const p = cachePic("gfx/p_option.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  // menu.c right-aligns the labels to column 16 + 22*8 and the widest of its
  // own English labels just clears the plaque. The re-release's strings
  // ("Customize Bindings...", or a Russian label) run further left and were
  // drawn over the plaque's right edge. The whole column -- labels, sliders,
  // values, cursor -- moves right by however much the widest label beside
  // the plaque would overlap it, so the layout stays the C's whenever no
  // label needs the room.
  const shift = M_OptionsShift();

  M_PrintRight(16 + shift, 32, 22, M_Loc("$m_set_binds", "Customize controls"));
  M_PrintRight(16 + shift, 40, 22, "Go to console");
  M_PrintRight(16 + shift, 48, 22, M_Loc("$m_reset_settings", "Reset to defaults"));

  M_PrintRight(16 + shift, 56, 22, "Screen size");
  let r = (Cvar_VariableValue("viewsize") - 30) / (120 - 30);
  M_DrawSlider(220 + shift, 56, r);

  M_PrintRight(16 + shift, 64, 22, M_Loc("$m_brightness", "Brightness"));
  r = (1.0 - Cvar_VariableValue("gamma")) / 0.5;
  M_DrawSlider(220 + shift, 64, r);

  M_PrintRight(16 + shift, 72, 22, M_Loc("$m_sensitivity", "Mouse Speed"));
  r = (Cvar_VariableValue("sensitivity") - 1) / 10;
  M_DrawSlider(220 + shift, 72, r);

  M_PrintRight(16 + shift, 80, 22, M_Loc("$m_music_volume", "CD Music Volume"));
  r = Cvar_VariableValue("bgmvolume");
  M_DrawSlider(220 + shift, 80, r);

  M_PrintRight(16 + shift, 88, 22, M_Loc("$m_sound_volume", "Sound Volume"));
  r = Cvar_VariableValue("volume");
  M_DrawSlider(220 + shift, 88, r);

  M_PrintRight(16 + shift, 96, 22, M_Loc("$m_always_run", "Always Run"));
  M_DrawCheckbox(220 + shift, 96, Cvar_VariableValue("cl_forwardspeed") > 200);

  M_PrintRight(16 + shift, 104, 22, M_Loc("$m_invert_look", "Invert Mouse"));
  M_DrawCheckbox(220 + shift, 104, Cvar_VariableValue("m_pitch") < 0);

  M_PrintRight(16 + shift, 112, 22, "Lookspring");
  M_DrawCheckbox(220 + shift, 112, Cvar_VariableValue("lookspring") !== 0);

  M_PrintRight(16 + shift, 120, 22, "Lookstrafe");
  M_DrawCheckbox(220 + shift, 120, Cvar_VariableValue("lookstrafe") !== 0);

  if (vidMenuHooks.vid_menudrawfn) M_PrintRight(16 + shift, 128, 22, M_Loc("$m_video_settings", "Video Options"));

  // U17 additions -- see OPTIONS_ITEMS' own comment. (The "Colored Lighting"
  // row that used to sit at 136 lives in Video Options now -- P3.)
  M_PrintRight(16 + shift, 136, 21, "Sound Frequency");
  M_Print(220 + shift, 136, `${Math.trunc(Cvar_VariableValue("snd_speed")) || 44100}`);

  M_PrintRight(16 + shift, 144, 22, "Autosave");
  M_DrawCheckbox(220 + shift, 144, Cvar_VariableValue("sv_autosave") !== 0);

  M_PrintRight(16 + shift, 152, 21, M_Loc("$m_change_on_pickup", "Weapon Switch"));
  const weaponSwitchLabels = [
    M_Loc("$m_onlynew", "Only New"),
    M_Loc("$m_never", "Never"),
    M_Loc("$m_always", "Always"),
  ];
  const weaponSwitchValue = Math.trunc(Cvar_VariableValue("cl_weaponswitch"));
  M_Print(220 + shift, 152, weaponSwitchLabels[weaponSwitchValue] ?? weaponSwitchLabels[0]);

  M_PrintRight(16 + shift, 160, 22, M_Loc("$m_language", "Language"));
  M_Print(220 + shift, 160, Cvar_VariableString("language") || "english");

  M_PrintRight(16 + shift, 168, 21, M_Loc("$m_controller", "Game Controller"));
  M_DrawCheckbox(220 + shift, 168, Cvar_VariableValue("joy_enable") !== 0);

  M_PrintRight(16 + shift, 176, 23, M_Loc("$m_addons", "Add-Ons"));

  // cursor
  M_DrawCharacter(200 + shift, 32 + menuState.options_cursor * 8, 12 + (Math.trunc(host.realtime * 4) & 1));
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
        case 18: // Add-Ons -- U17 addition
          M_Menu_QexAddons_f();
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

  // Row 12 (Video Options) only exists when vidMenuHooks.vid_menudrawfn is
  // set (see M_Options_Draw); this bounces the cursor off it either
  // direction. U17 addition: with rows now continuing past 12 (13..19), a
  // downward bounce has to land on 13 rather than wrapping all the way to 0
  // (the original C's own two-way bounce -- "up goes to 11, everything else
  // goes to 0" -- relied on 12 being the LAST row, where 0 and "the row
  // after 12" were the same destination; that's no longer true here).
  if (menuState.options_cursor === 12 && !vidMenuHooks.vid_menudrawfn) {
    if (k === K_UPARROW) menuState.options_cursor = 11;
    else if (k === K_DOWNARROW) menuState.options_cursor = 13;
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

/* The retail tables key the bindable actions by what they DO, not by the
 * console command, so the mapping is spelled here rather than folded into
 * `bindnames` (whose tuple shape other modules already read). "+mlook" and
 * "+klook" have no retail key -- the re-release has no such rows. */
const BIND_LOC_KEYS: ReadonlyMap<string, string> = new Map([
  ["+attack", "$m_attack"],
  ["impulse 10", "$m_next_weapon"],
  ["+jump", "$m_jump_swim"],
  ["+forward", "$m_forward"],
  ["+back", "$m_backpedal"],
  ["+left", "$m_turn_left"],
  ["+right", "$m_turn_right"],
  ["+speed", "$m_run_walk"],
  ["+moveleft", "$m_step_left"],
  ["+moveright", "$m_step_right"],
  ["+strafe", "$m_sidestep"],
  ["+lookup", "$m_look_up"],
  ["+lookdown", "$m_look_down"],
  ["centerview", "$m_center_view"],
  ["+moveup", "$m_swim_up"],
  ["+movedown", "$m_swim_down"],
]);

function M_BindName(command: string, english: string): string {
  const key = BIND_LOC_KEYS.get(command);
  return key === undefined ? english : M_Loc(key, english);
}

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

    M_Print(16, y, M_BindName(bindnames[i][0], bindnames[i][1]));

    M_FindKeysForCommand(bindnames[i][0], keys);

    if (keys[0] === -1) {
      M_Print(140, y, "???");
    } else {
      const name = Key_KeynumToString(keys[0]);
      M_Print(140, y, name);
      const x = M_TextWidth(name);
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
  // vid_menu.c's own VID_MenuDraw draws gfx/vidmodes.lmp centred at y 4
  // above its rows; this port's video menu lives in src/platform/vid_menu.ts
  // (shared with the QuakeWorld client) and had no title of its own, so the
  // screen came up as four bare rows. Drawn here, ahead of the hook, so both
  // clients get it and vid_menu.ts stays the one place the ROWS are laid out.
  const p = getRenderer().Draw_CachePic("gfx/vidmodes.lmp");
  if (p !== null) M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);
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

/* The retail tables spell each of the eight quit taunts as ONE `m_quit_N`
 * string; menu.c hand-wraps them into four 24-column literals. A localized
 * taunt is wrapped to the same box, and the hand-wrapped literals are what
 * draws when the table has no such key. */
export function M_QuitMessageLines(msgNumber: number): string[] {
  const english = [0, 1, 2, 3].map((i) => quitMessage[msgNumber * 4 + i] ?? "");
  const one = M_Loc(`$m_quit_${msgNumber}`, "");
  if (one.length === 0) return english;
  return M_WrapText(one, 24, 4);
}

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
  const quitLines = M_QuitMessageLines(menuState.msgNumber);
  M_Print(64, 84, quitLines[0]);
  M_Print(64, 92, quitLines[1]);
  M_Print(64, 100, quitLines[2]);
  M_Print(64, 108, quitLines[3]);
}

//=============================================================================
/* LAN CONFIG MENU */

export const NUM_LANCONFIG_CMDS = 3;
export const lanConfig_cursor_table = [72, 92, 124];

// U40 addition: a fourth row, Protocol, only for the Join Game path
// (JoiningGame()) -- see file header. StartingGame keeps NUM_LANCONFIG_CMDS/
// lanConfig_cursor_table's classic 3-row shape and values untouched.
const LANCONFIG_PROTOCOL_ROW = 3;
const LANCONFIG_PROTOCOL_Y = 136;

function lanConfigRowCount(): number {
  return JoiningGame() ? LANCONFIG_PROTOCOL_ROW + 1 : NUM_LANCONFIG_CMDS;
}

function lanConfigCursorY(index: number): number {
  if (index === LANCONFIG_PROTOCOL_ROW) return LANCONFIG_PROTOCOL_Y;
  return lanConfig_cursor_table[index]!;
}

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

  const startJoin = StartingGame() ? M_Loc("$m_new_game", "New Game") : "Join Game";
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

    // U40 addition: Protocol row, Join Game only.
    const protocolValue = Cvar_VariableString("cl_protocol").trim().toLowerCase() || "auto";
    M_Print(bx, LANCONFIG_PROTOCOL_Y, "Protocol");
    M_Print(bx + 9 * 8, LANCONFIG_PROTOCOL_Y, protocolValue);
  } else {
    M_DrawTextBox(bx, lanConfig_cursor_table[1] - 8, 2, 1);
    M_Print(bx + 8, lanConfig_cursor_table[1], M_Loc("$m_ok", "OK"));
  }

  M_DrawCharacter(bx - 8, lanConfigCursorY(menuState.lanConfig_cursor), 12 + (Math.trunc(host.realtime * 4) & 1));

  if (menuState.lanConfig_cursor === 0)
    M_DrawCharacter(
      bx + 9 * 8 + M_TextWidth(menuState.lanConfig_portname),
      lanConfig_cursor_table[0],
      10 + (Math.trunc(host.realtime * 4) & 1),
    );

  if (menuState.lanConfig_cursor === 2)
    M_DrawCharacter(
      bx + 16 + M_TextWidth(menuState.lanConfig_joinname),
      lanConfig_cursor_table[2],
      10 + (Math.trunc(host.realtime * 4) & 1),
    );

  // U40 addition: the Protocol row pushes this down 8px on the Join Game
  // path only, to stay clear of it -- StartingGame's own position (148, no
  // Protocol row) is unchanged.
  const returnReasonY = JoiningGame() ? LANCONFIG_PROTOCOL_Y + 16 : 148;
  if (menuState.m_return_reason.length > 0) M_PrintWhite(bx, returnReasonY, menuState.m_return_reason);
}

export function M_LanConfig_Key(key: number): void {
  switch (key) {
    case K_ESCAPE:
      M_Menu_Net_f();
      break;

    case K_UPARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.lanConfig_cursor--;
      if (menuState.lanConfig_cursor < 0) menuState.lanConfig_cursor = lanConfigRowCount() - 1;
      break;

    case K_DOWNARROW:
      S_LocalSound("misc/menu1.wav");
      menuState.lanConfig_cursor++;
      if (menuState.lanConfig_cursor >= lanConfigRowCount()) menuState.lanConfig_cursor = 0;
      break;

    // U40 addition: cycles cl_protocol on the Protocol row (Join Game only
    // -- lanConfigRowCount() keeps StartingGame from ever landing here).
    // Previously uncased: K_LEFTARROW/K_RIGHTARROW (128+, see keys.ts) fell
    // to `default`, which discards anything outside 32..127, so this adds
    // behavior only where it's now reachable and remains a no-op everywhere
    // else, exactly as before.
    case K_LEFTARROW:
    case K_RIGHTARROW: {
      if (menuState.lanConfig_cursor !== LANCONFIG_PROTOCOL_ROW || !JoiningGame()) break;
      S_LocalSound("misc/menu3.wav");
      const dir = key === K_RIGHTARROW ? 1 : -1;
      const current = Cvar_VariableString("cl_protocol").trim().toLowerCase() || "auto";
      let idx = CL_PROTOCOLS.indexOf(current);
      if (idx === -1) idx = 0;
      idx = (idx + dir + CL_PROTOCOLS.length) % CL_PROTOCOLS.length;
      Cvar_Set("cl_protocol", CL_PROTOCOLS[idx]!);
      break;
    }

    case K_ENTER: {
      if (menuState.lanConfig_cursor === 0 || menuState.lanConfig_cursor === LANCONFIG_PROTOCOL_ROW) break;

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

// U40 additions: the mapdb-driven multiplayer map list for the currently
// selected Game Type (see menu_content.ts's BuildMpEpisodes/CtfMaps and this
// file's header). Returns [] whenever no mapdb.json is mounted, or the
// current game type has no matching content -- callers fall back to the
// classic hardcoded levels/episodes/hipnoticlevels/... tables in that case,
// leaving those tables' own behavior byte-identical with no re-release data
// mounted.
function mpGameType(): "dm" | "coop" | "ctf" {
  if (menuState.gameoptionsCtf) return "ctf";
  return Cvar_VariableValue("coop") ? "coop" : "dm";
}

function mpEpisodesForCurrentGameType(): MpEpisode[] {
  const model = qexModel();
  if (!model.mapdbPresent || model.rawMapdb === null) return [];
  const type = mpGameType();
  if (type === "ctf") {
    const maps = CtfMaps(model.rawMapdb);
    return maps.length > 0 ? [{ dir: "ctf", nameKey: "CTF", maps }] : [];
  }
  return BuildMpEpisodes(model.rawMapdb, model.mountedDirs, type);
}

// Row counts for Episode (7)/Level (8): the mapdb-driven list's own length
// when present, else the exact classic per-build counts (unchanged).
function gameOptionsEpisodeCount(): number {
  const mp = mpEpisodesForCurrentGameType();
  if (mp.length > 0) return mp.length;
  if (hipnotic) return 6;
  if (rogue) return 4;
  return registered.value ? 7 : 2;
}

function gameOptionsLevelCount(episodeIndex: number): number {
  const mp = mpEpisodesForCurrentGameType();
  if (mp.length > 0) return mp[Math.min(episodeIndex, mp.length - 1)]!.maps.length;
  if (hipnotic) return hipnoticepisodes[episodeIndex]!.levels;
  if (rogue) return rogueepisodes[episodeIndex]!.levels;
  return episodes[episodeIndex]!.levels;
}

// The Episode row's display name for the current selection.
function gameOptionsEpisodeName(): string {
  const mp = mpEpisodesForCurrentGameType();
  if (mp.length > 0) {
    if (mpGameType() === "ctf") return "Capture the Flag";
    const ep = mp[Math.min(menuState.startepisode, mp.length - 1)]!;
    return LocalizedEpisodeName(ep.nameKey, qexLocLoaded);
  }
  if (hipnotic) return hipnoticepisodes[menuState.startepisode]!.description;
  if (rogue) return rogueepisodes[menuState.startepisode]!.description;
  return episodes[menuState.startepisode]!.description;
}

// The Level row's {title, bsp} for the current selection -- also what the
// Begin Game launch (below) and the Bots page's "selected map" (see
// currentOrSelectedMapName above) resolve against.
function resolveGameOptionsMap(): { title: string; bsp: string } {
  const mp = mpEpisodesForCurrentGameType();
  if (mp.length > 0) {
    const ep = mp[Math.min(menuState.startepisode, mp.length - 1)]!;
    const lvl = ep.maps[Math.min(menuState.startlevel, ep.maps.length - 1)]!;
    return { title: lvl.title, bsp: lvl.bsp };
  }
  if (hipnotic) {
    const lvl = hipnoticlevels[hipnoticepisodes[menuState.startepisode]!.firstLevel + menuState.startlevel]!;
    return { title: lvl.description, bsp: lvl.name };
  }
  if (rogue) {
    const lvl = roguelevels[rogueepisodes[menuState.startepisode]!.firstLevel + menuState.startlevel]!;
    return { title: lvl.description, bsp: lvl.name };
  }
  const lvl = levels[episodes[menuState.startepisode]!.firstLevel + menuState.startlevel]!;
  return { title: lvl.description, bsp: lvl.name };
}

// The `game <dir>` argument the Begin Game launch queues, or "" when none
// applies (classic fallback path -- no `game` command queued at all, per
// this file's header).
function gameOptionsDirArg(): string {
  const mp = mpEpisodesForCurrentGameType();
  if (mp.length === 0) return "";
  return mpGameType() === "ctf" ? "ctf" : mp[Math.min(menuState.startepisode, mp.length - 1)]!.dir;
}

export function M_Menu_GameOptions_f(): void {
  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_gameoptions;
  menuState.m_entersound = true;
  if (menuState.maxplayers === 0) menuState.maxplayers = svs.maxclients;
  if (menuState.maxplayers < 2) menuState.maxplayers = svs.maxclientslimit;

  // U40 addition: refresh the content model the same way M_Menu_QexAddons_f
  // does, so Episode/Level/Game Type reflect whatever is mounted right now.
  qexContentModel = LoadContentModel();
  qexLocLoaded = LoadMenuLocalization() > 0;
}

export const gameoptions_cursor_table = [40, 56, 64, 72, 80, 88, 96, 112, 120, 136, 144, 152, 160];
export const NUM_GAMEOPTIONS = 13;

export function M_GameOptions_Draw(): void {
  M_DrawTransPic(16, 4, cachePic("gfx/qplaque.lmp"));
  const p = cachePic("gfx/p_multi.lmp");
  M_DrawPic(Math.trunc((320 - p.width) / 2), 4, p);

  M_DrawTextBox(152, 32, 10, 1);
  M_Print(160, 40, "begin game");

  M_PrintRight(0, 56, 17, M_Loc("$m_max_players", "Max players"));
  M_Print(160, 56, `${menuState.maxplayers}`);

  M_PrintRight(0, 64, 17, M_Loc("$m_mode", "Game Type"));
  // U40 addition: CTF, only when the ctf gamedir is mounted; with no ctf
  // mount this is the unchanged classic Cooperative/Deathmatch toggle.
  if (ctfMounted() && menuState.gameoptionsCtf) M_Print(160, 64, M_Loc("$m_ctf", "CTF"));
  else if (Cvar_VariableValue("coop")) M_Print(160, 64, M_Loc("$m_coop", "Cooperative"));
  else M_Print(160, 64, M_Loc("$m_deathmatch", "Deathmatch"));

  M_PrintRight(0, 72, 16, M_Loc("$m_teamplay", "Teamplay"));
  const teamplayValue = Math.trunc(Cvar_VariableValue("teamplay"));
  if (rogue) {
    let msg: string;
    switch (teamplayValue) {
      case 1:
        msg = "No Friendly Fire";
        break;
      case 2:
        msg = M_Loc("$m_friendly_fire", "Friendly Fire");
        break;
      case 3:
        msg = "Tag";
        break;
      case 4:
        msg = M_Loc("$m_ctf", "Capture the Flag");
        break;
      case 5:
        msg = "One Flag CTF";
        break;
      case 6:
        msg = "Three Team CTF";
        break;
      default:
        msg = M_Loc("$m_off", "Off");
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
        msg = M_Loc("$m_friendly_fire", "Friendly Fire");
        break;
      default:
        msg = M_Loc("$m_off", "Off");
        break;
    }
    M_Print(160, 72, msg);
  }

  M_PrintRight(0, 80, 17, M_Loc("$m_difficulty", "Skill"));
  const skillValue = Cvar_VariableValue("skill");
  if (skillValue === 0) M_Print(160, 80, M_Loc("$m_easy", "Easy difficulty"));
  else if (skillValue === 1) M_Print(160, 80, M_Loc("$m_medium", "Normal difficulty"));
  else if (skillValue === 2) M_Print(160, 80, M_Loc("$m_hard", "Hard difficulty"));
  else M_Print(160, 80, M_Loc("$m_nightmare", "Nightmare difficulty"));

  M_PrintRight(0, 88, 17, M_Loc("$m_fraglimit", "Frag Limit"));
  const fraglimitValue = Cvar_VariableValue("fraglimit");
  if (fraglimitValue === 0) M_Print(160, 88, "none");
  else M_Print(160, 88, `${Math.trunc(fraglimitValue)} frags`);

  M_PrintRight(0, 96, 17, M_Loc("$m_timelimit", "Time Limit"));
  const timelimitValue = Cvar_VariableValue("timelimit");
  if (timelimitValue === 0) M_Print(160, 96, "none");
  else M_Print(160, 96, `${Math.trunc(timelimitValue)} minutes`);

  // U40: Episode/Level source from mapdb's dm/coop flags when a mapdb.json
  // is mounted for the current Game Type; the exact classic per-build
  // lookups (unchanged) otherwise -- see gameOptionsEpisodeName/
  // resolveGameOptionsMap's own comments above.
  M_PrintRight(0, 112, 16, M_Loc("$m_episode", "Episode"));
  M_Print(160, 112, gameOptionsEpisodeName());

  M_Print(0, 120, "           Level");
  const selectedLevel = resolveGameOptionsMap();
  M_Print(160, 120, selectedLevel.title);
  M_Print(160, 128, selectedLevel.bsp);

  // U40 additions: rows 9-12.
  M_Print(0, 136, "         Ruleset");
  M_Print(160, 136, RULESETS[menuState.gameoptionsRulesetIndex]!.name);

  M_Print(0, 144, "        Protocol");
  M_Print(160, 144, SV_PROTOCOLS[menuState.gameoptionsProtocolIndex]!);

  M_PrintRight(0, 152, 16, M_Loc("$m_num_bots", "Bot Count"));
  M_Print(160, 152, `${menuState.gameoptionsBotCount}`);

  M_PrintRight(0, 160, 16, M_Loc("$m_bot_skill", "Bot Skill"));
  M_Print(160, 160, AvailableBotSkillNames()[menuState.gameoptionsBotSkillIndex] ?? "medium");

  // line cursor
  M_DrawCharacter(144, gameoptions_cursor_table[menuState.gameoptions_cursor]!, 12 + (Math.trunc(host.realtime * 4) & 1));

  // NOTE: this box's own 4-line height (138..186) overlaps the U40 rows
  // printed above it (136-160) while m_serverInfoMessage is showing -- a
  // cosmetic tension accepted rather than relocating either one further;
  // the message is transient (5 seconds, see below) and this port's menu
  // rendering is 8x8 text with no real pixel-collision test coverage.
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
      // U40: a 3-way Deathmatch->Cooperative->CTF cycle when the ctf
      // gamedir is mounted, direction-independent same as the classic
      // toggle it extends; with no ctf mount this is the exact classic
      // toggle, unchanged.
      if (!ctfMounted()) {
        Cvar_SetValue("coop", Cvar_VariableValue("coop") ? 0 : 1);
        break;
      }
      if (menuState.gameoptionsCtf) {
        menuState.gameoptionsCtf = false; // CTF -> Deathmatch
        Cvar_SetValue("coop", 0);
      } else if (Cvar_VariableValue("coop")) {
        Cvar_SetValue("coop", 0); // Cooperative -> CTF
        menuState.gameoptionsCtf = true;
      } else {
        Cvar_SetValue("coop", 1); // Deathmatch -> Cooperative
      }
      menuState.startepisode = 0;
      menuState.startlevel = 0;
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
      // U40: gameOptionsEpisodeCount() returns the mapdb-driven list's own
      // length when one applies, else the exact classic per-build counts
      // below (unchanged).
      count = gameOptionsEpisodeCount();

      if (menuState.startepisode < 0) menuState.startepisode = count - 1;

      if (menuState.startepisode >= count) menuState.startepisode = 0;

      menuState.startlevel = 0;
      break;

    case 8:
      menuState.startlevel += dir;
      // U40: gameOptionsLevelCount() likewise prefers the mapdb-driven list.
      count = gameOptionsLevelCount(menuState.startepisode);

      if (menuState.startlevel < 0) menuState.startlevel = count - 1;

      if (menuState.startlevel >= count) menuState.startlevel = 0;
      break;

    // U40 additions: rows 9-12.
    case 9: // Ruleset
      menuState.gameoptionsRulesetIndex = (menuState.gameoptionsRulesetIndex + dir + RULESETS.length) % RULESETS.length;
      break;

    case 10: // Protocol
      menuState.gameoptionsProtocolIndex = (menuState.gameoptionsProtocolIndex + dir + SV_PROTOCOLS.length) % SV_PROTOCOLS.length;
      break;

    case 11: // Bot Count (0-8)
      menuState.gameoptionsBotCount = (menuState.gameoptionsBotCount + dir + 9) % 9;
      break;

    case 12: {
      // Bot Skill
      const names = AvailableBotSkillNames();
      menuState.gameoptionsBotSkillIndex = (menuState.gameoptionsBotSkillIndex + dir + names.length) % names.length;
      break;
    }
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
        // U40: the classic prefix (disconnect/listen 0/maxplayers) is
        // unchanged; game/sv_ruleset/sv_protocol/teamplay/bot_count/
        // bot_skill are new, queued in that order, before the classic
        // `map <bsp>` suffix -- see file header.
        //
        // F3: `game <dir>` comes BEFORE the cvars. It re-execs quake.rc, so
        // the newly mounted gamedir's archived config.cfg sets sv_ruleset
        // and sv_protocol from that content's last clean shutdown; anything
        // this screen chose has to be queued after that to survive. See
        // src/client/menu_content.ts's Content_PerformLaunch for the same
        // ordering on the single-player side.
        if (sv.active) Cbuf_AddText("disconnect\n");
        Cbuf_AddText("listen 0\n"); // so host_netport will be re-examined

        const dir = gameOptionsDirArg();
        if (dir !== "") Cbuf_AddText(`game ${dir}\n`);

        // `maxplayers` is what sets `deathmatch` (net_main.ts's MaxPlayers_f:
        // 1 -> 0, more -> 1), so it has to run after the switch too and
        // `deathmatch` is deliberately NOT re-queued from the stale
        // pre-launch value here. `coop`/`skill` were set synchronously as the
        // rows were cycled, so they are re-queued after `maxplayers` to
        // survive a gamedir whose default.cfg touches them.
        Cbuf_AddText(`maxplayers ${menuState.maxplayers}\n`);
        Cbuf_AddText(`coop ${Cvar_VariableValue("coop")}\n`);
        Cbuf_AddText(`skill ${Cvar_VariableValue("skill")}\n`);
        Cbuf_AddText(`sv_ruleset ${RULESETS[menuState.gameoptionsRulesetIndex]!.id}\n`);
        Cbuf_AddText(`sv_protocol ${SV_PROTOCOLS[menuState.gameoptionsProtocolIndex]}\n`);
        if (mpGameType() === "ctf") Cbuf_AddText("teamplay 1\n");

        Cbuf_AddText(`bot_count ${menuState.gameoptionsBotCount}\n`);
        Cbuf_AddText(`bot_skill ${AvailableBotSkillNames()[menuState.gameoptionsBotSkillIndex] ?? "medium"}\n`);

        SCR_BeginLoadingPlaque();
        Cbuf_AddText(`map ${resolveGameOptionsMap().bsp}\n`);

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
  Cmd_AddCommand("togglemenu", M_ToggleMenu_f, "nq");

  Cmd_AddCommand("menu_main", M_Menu_Main_f, "nq");
  Cmd_AddCommand("menu_singleplayer", M_Menu_SinglePlayer_f);
  Cmd_AddCommand("menu_load", M_Menu_Load_f);
  Cmd_AddCommand("menu_save", M_Menu_Save_f);
  Cmd_AddCommand("menu_multiplayer", M_Menu_MultiPlayer_f);
  Cmd_AddCommand("menu_setup", M_Menu_Setup_f);
  Cmd_AddCommand("menu_options", M_Menu_Options_f, "nq");
  Cmd_AddCommand("menu_keys", M_Menu_Keys_f, "nq");
  Cmd_AddCommand("menu_video", M_Menu_Video_f, "nq");
  Cmd_AddCommand("help", M_Menu_Help_f, "nq");
  Cmd_AddCommand("menu_quit", M_Menu_Quit_f, "nq");
  Cmd_AddCommand("menu_addons", M_Menu_QexAddons_f); // U17 addition
  Cmd_AddCommand("menu_episodes", M_Menu_QexEpisodes_Cmd_f); // F3 addition
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

    case MStateT.m_qex_episodes:
      M_QexEpisodes_Draw();
      break;

    case MStateT.m_qex_levels:
      M_QexLevels_Draw();
      break;

    case MStateT.m_qex_addons:
      M_QexAddons_Draw();
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

    case MStateT.m_qex_episodes:
      M_QexEpisodes_Key(key);
      return;

    case MStateT.m_qex_levels:
      M_QexLevels_Key(key);
      return;

    case MStateT.m_qex_addons:
      M_QexAddons_Key(key);
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
