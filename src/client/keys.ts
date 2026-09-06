/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/keys.h and WinQuake/keys.c (GNU GPL v2 or later).

keys.c -- key event dispatch, bindings, and console/chat line editing.

Deviations from PORTING.md / the C source:
- `keydest_t` -> `KeydestT` enum (key_game, key_console, key_message,
  key_menu -- same 0..3 values the C's plain `enum` assigns). U047
  (src/client/console.ts) imports `KeydestT`, `keyState` and `key_lines` from
  this module per this unit's brief; those three names and shapes are fixed
  by that contract.
- `key_dest`, `edit_line`, `key_linepos`, `key_count`, `chat_buffer` and
  `team_message` are grouped into one exported `keyState` object (rather than
  six separate `export let`s) because U047 reads and writes several of them
  and an ESM import binding cannot be assigned through from outside its
  module -- PORTING.md's "reassigned globals become a small exported holder"
  rule. `history_line` and `key_lastpress` are not part of that contract
  (no other landed or concurrent module reads them) and stay module-private,
  except `key_lastpress`, which screen.c's SCR_ModalMessage reads once
  screen.ts lands; it is exported as a plain `let` (only this module ever
  writes it, matching in_dos.c/keys.c being the C's only two writers, and
  this port does not carry in_dos.c).
- `char key_lines[32][MAXCMDLINE]` -> `key_lines: string[]` (32 entries), per
  this unit's ruling. A NUL-terminated C buffer's "used length" becomes the
  TS string's `.length`; `key_lines[i][1] == 0` (an empty line, just "]")
  becomes `key_lines[i].length <= 1`. `key_linepos` still indexes into the
  string the way it indexed the byte buffer: appends slice in a new
  character at that index, backspace/left-arrow decrement it, and the C's
  `key_lines[edit_line][key_linepos] = 0` truncation becomes
  `key_lines[edit_line] = key_lines[edit_line].slice(0, key_linepos)`.
- `char *keybindings[256]` -> `Array<string | null>`; `Z_Malloc`/`Z_Free` in
  Key_SetBinding have no observable behavior beyond the copy itself
  (PORTING.md's zone.c ruling), so the binding string is assigned directly
  with no allocator call.
- `char chat_buffer[32]` + the C's `static int chat_bufferlen` (function-local
  static in Key_Message) -> `keyState.chat_buffer: string` plus a
  module-private `chat_bufferlen` counter that mirrors the C's separate
  length tracking; the 31-character cap (`chat_bufferlen == 31`) is preserved
  verbatim even though a TS string does not need a fixed-size backing array.
- `con_backscroll`/`con_totallines`/`con_forcedup` (console.c globals read
  and mutated by Key_Console/Key_Event) are not yet landed: console.ts is
  still U047's coordinator placeholder. Ruling assumed here per this unit's
  brief ("tell the coordinator what you assumed"): console.ts will export
  `conState = { con_backscroll: number, con_totallines: number, con_forcedup:
  boolean }` (the reassigned-global holder pattern above), imported here as
  `conState`. Until U047 lands with that shape, this file fails the check
  gate only on that name (`Property 'conState' ... has no exported member`),
  which is the accepted absent-sibling failure for this brief.
- `M_Keydown`/`M_ToggleMenu_f` (menu.c, not yet landed) are imported from
  `./menu` by their C names; until menu.ts lands this fails the check gate
  with `Cannot find module './menu'`, the accepted absent-sibling failure.
- `SCR_UpdateScreen` (screen.c, not yet landed) is not imported directly:
  Key_Console calls it through `hostClientHooks.scrUpdateScreen`, the seam
  host.ts already declares for it.
- `Sys_Error ("Bad key_dest")` in Key_Event's two `switch` statements: TS's
  `KeydestT` is an exhaustive 4-value enum, so both switches end with a
  `default:` arm that still calls `Sys_Error`, matching the C's defensive
  handling of an out-of-range value rather than a `never`-typed
  exhaustiveness check (the enum already covers every declared case; the
  `default` exists only because the C's does).
- `Key_Bind_f`'s command-argument join (`strcat` loop) starts the buffer
  empty and prepends a space before every argument after the first, exactly
  as the C's `if (i > 2) strcat (cmd, " ")` does; not "fixed" to any other
  join convention.
- Registers `hostClientHooks.keyDestIsGame`, `keyDestIsConsole`,
  `setKeyDestGame`, `keyWriteBindings`, `keyInit` (host.c's client seam) and
  `svUserHooks.keyDestIsGame` (sv_user.c's client seam) at module load, since
  this is the module that owns `key_dest`.

QuakeWorld track (`qw.active` folds, `diff -w WinQuake/keys.c QW/client/keys.c`,
both fully read; 158 changed lines per the unit brief, concentrated in a
handful of functions -- see below for the exact ones):
- `Key_Console`'s K_ENTER branch: QW distinguishes an explicit command from a
  chat message (WinQuake's always runs the typed line as a command).
  `CheckForCommand`/`CompleteCommand` (new QW-only helpers, module-private,
  ported fresh) implement that: a line starting with `\` or `/` is always a
  command (skip the marker); otherwise `CheckForCommand`'s exact-match test
  against `Cmd_CompleteCommand`/`Cvar_CompleteVariable` decides; failing
  both, the line becomes a `say` chat message (prefixed only when
  `cls.state` is `ca_connected`/`ca_onserver`/`ca_active` -- QW's C reads
  `cls.state >= ca_connected` against *its own* cactive_t numbering, which
  is not this port's shared `CactiveT` numbering (see client.ts's own
  header); ported as an explicit three-way member comparison instead of
  `>=`, so it means the same three states QW's C means, not whatever the
  shared enum's numeric order would compare true for.
- `Key_Console`'s K_TAB branch: QW's `CompleteCommand` (distinct from
  WinQuake's inline Tab-completion) skips a leading `\`/`/` in the search
  text and always rewrites the line as `]/<cmd> ` (forcing an explicit
  command marker), where WinQuake rewrites it as `]<cmd> ` with no marker.
- `Key_Init`: QW additionally marks `K_HOME`/`K_END` as `consolekeys`.
- `Key_Event`'s autorepeat exemption list gains `K_PGUP`/`K_PGDN` (QW does
  not swallow repeated PageUp/PageDown, unlike WinQuake).
- `Key_Event`'s `key_dest === key_game` routing condition: QW's is
  `cls.state === ca_active || !consolekeys[key]`, not WinQuake's
  `!conState.con_forcedup || !consolekeys[key]` (`con_forcedup` does not
  exist in QW/client/console.c's simpler state machine).
- `Key_WriteBindings`: QW writes a `bind` line for every key with any
  binding at all (even an explicitly-unbound, empty-string one), where
  WinQuake additionally requires the binding to be non-empty; QW also does
  not quote the key name (`bind %s "%s"` vs `bind "%s" "%s"`).
- `Key_Message`: QW's chat buffer cap is `MAXCMDLINE-1` (255), not
  WinQuake's hardcoded 31 -- QW's `chat_buffer` is declared
  `char chat_buffer[MAXCMDLINE]` (reusing the same 256-byte constant
  `key_lines` uses), where WinQuake's is a separate, smaller
  `char chat_buffer[32]`. `team_message` is named `chat_team` in QW's C;
  same field, no export-name change (nothing outside this module reads it
  by either name).
- `M_Keydown`/`M_ToggleMenu_f`: the call sites are character-for-character
  identical in the two keys.c files (QW keys.c:728/732/772/812 against
  WinQuake's), but the menu.c they link is not -- WinQuake's menu.c and
  QW/client/menu.c differ wholesale, so src/qw/client/menu.ts is a module of
  its own rather than a fold of ./menu. `menuKeydown`/`menuToggleMenu_f`
  below are what makes those four call sites reach the right one at run
  time; see the comment on `qwMenuMod`.
- Not folded (checked, genuinely unchanged): `Key_StringToKeynum`,
  `Key_KeynumToString`, `Key_SetBinding`, `Key_Unbind_f`/`Key_Unbindall_f`/
  `Key_Bind_f`, `Key_ClearStates` (QW writes `key_repeats[i] = false` where
  WinQuake writes `= 0`; both are 0 on a `boolean`-coerced `Int32Array`
  write, no observable difference, not folded), `Key_Event`'s escape/menu
  dispatch and button up/down command forwarding (only the menu module they
  reach differs, see above), `messagemode`/
  `messagemode2` registration (grepped: neither exists in QW's keys.c --
  they live elsewhere, not this file's concern).
*/

import { Sys_Error } from "../platform/sys";
import { Con_Printf } from "./console";
import { Cbuf_AddText, Cmd_Argc, Cmd_Argv, Cmd_AddCommand, Cmd_CompleteCommand } from "../common/cmd";
import { Cvar_CompleteVariable } from "../common/cvar";
import { Q_strcasecmp } from "../common/common";
import { cls, CactiveT } from "./client";
import { hostClientHooks } from "../common/host";
import { qw } from "../common/quakedef";
import { vid } from "./vid";
// console.ts (U047, not yet landed with this shape) -- see file header.
import { conState } from "./console";
// menu.ts (U049, not yet landed) -- see file header.
import { M_Keydown, M_ToggleMenu_f } from "./menu";
import type * as QwMenuModule from "../qw/client/menu";
import { svUserHooks } from "../server/sv_user";

// keys.c is one of the files both trees share, but the menu.c it calls
// M_Keydown/M_ToggleMenu_f in is not: WinQuake's menu.c and QW/client/menu.c
// differ wholesale (src/qw/client/menu.ts is its own module, not a fold), so
// which one these two entry points reach is decided at run time here the way
// the C decides it at link time. A static import of the QW module would pull
// the whole QuakeWorld client into the WinQuake binary, so it is resolved
// lazily with Bun's synchronous require(), the same mechanism
// src/common/host.ts and src/ref_soft/r_alias.ts use; only reached with
// qw.active, so the WinQuake binary never loads it.
function qwMenuMod(): typeof QwMenuModule {
  return require("../qw/client/menu");
}

function menuKeydown(key: number): void {
  if (qw.active) qwMenuMod().M_Keydown(key);
  else M_Keydown(key);
}

function menuToggleMenu_f(): void {
  if (qw.active) qwMenuMod().M_ToggleMenu_f();
  else M_ToggleMenu_f();
}

//
// these are the key numbers that should be passed to Key_Event
//
export const K_TAB = 9;
export const K_ENTER = 13;
export const K_ESCAPE = 27;
export const K_SPACE = 32;

// normal keys should be passed as lowercased ascii

export const K_BACKSPACE = 127;
export const K_UPARROW = 128;
export const K_DOWNARROW = 129;
export const K_LEFTARROW = 130;
export const K_RIGHTARROW = 131;

export const K_ALT = 132;
export const K_CTRL = 133;
export const K_SHIFT = 134;
export const K_F1 = 135;
export const K_F2 = 136;
export const K_F3 = 137;
export const K_F4 = 138;
export const K_F5 = 139;
export const K_F6 = 140;
export const K_F7 = 141;
export const K_F8 = 142;
export const K_F9 = 143;
export const K_F10 = 144;
export const K_F11 = 145;
export const K_F12 = 146;
export const K_INS = 147;
export const K_DEL = 148;
export const K_PGDN = 149;
export const K_PGUP = 150;
export const K_HOME = 151;
export const K_END = 152;

export const K_PAUSE = 255;

//
// mouse buttons generate virtual keys
//
export const K_MOUSE1 = 200;
export const K_MOUSE2 = 201;
export const K_MOUSE3 = 202;

//
// joystick buttons
//
export const K_JOY1 = 203;
export const K_JOY2 = 204;
export const K_JOY3 = 205;
export const K_JOY4 = 206;

//
// aux keys are for multi-buttoned joysticks to generate so they can use
// the normal binding process
//
export const K_AUX1 = 207;
export const K_AUX2 = 208;
export const K_AUX3 = 209;
export const K_AUX4 = 210;
export const K_AUX5 = 211;
export const K_AUX6 = 212;
export const K_AUX7 = 213;
export const K_AUX8 = 214;
export const K_AUX9 = 215;
export const K_AUX10 = 216;
export const K_AUX11 = 217;
export const K_AUX12 = 218;
export const K_AUX13 = 219;
export const K_AUX14 = 220;
export const K_AUX15 = 221;
export const K_AUX16 = 222;
export const K_AUX17 = 223;
export const K_AUX18 = 224;
export const K_AUX19 = 225;
export const K_AUX20 = 226;
export const K_AUX21 = 227;
export const K_AUX22 = 228;
export const K_AUX23 = 229;
export const K_AUX24 = 230;
export const K_AUX25 = 231;
export const K_AUX26 = 232;
export const K_AUX27 = 233;
export const K_AUX28 = 234;
export const K_AUX29 = 235;
export const K_AUX30 = 236;
export const K_AUX31 = 237;
export const K_AUX32 = 238;

// JACK: Intellimouse(c) Mouse Wheel Support

export const K_MWHEELUP = 239;
export const K_MWHEELDOWN = 240;

export enum KeydestT {
  key_game,
  key_console,
  key_message,
  key_menu,
}

const MAXCMDLINE = 256;

export const key_lines: string[] = new Array(32).fill("]");

export const keyState = {
  key_dest: KeydestT.key_game,
  edit_line: 0,
  key_linepos: 1,
  key_count: 0, // incremented every key event
  chat_buffer: "",
  team_message: false,
};

// key_lastpress/history_line: see file header for why these stay outside keyState.
export let key_lastpress = 0;
let history_line = 0;

let shift_down = false;

export const keybindings: Array<string | null> = new Array(256).fill(null);
const consolekeys: boolean[] = new Array(256).fill(false); // if true, can't be rebound while in console
const menubound: boolean[] = new Array(256).fill(false); // if true, can't be rebound while in menu
const keyshift: number[] = new Array(256).fill(0); // key to map to if shift held down in console
export const key_repeats: Int32Array = new Int32Array(256); // if > 1, it is autorepeating
const keydown: boolean[] = new Array(256).fill(false);

interface KeynameT {
  name: string;
  keynum: number;
}

const keynames: KeynameT[] = [
  { name: "TAB", keynum: K_TAB },
  { name: "ENTER", keynum: K_ENTER },
  { name: "ESCAPE", keynum: K_ESCAPE },
  { name: "SPACE", keynum: K_SPACE },
  { name: "BACKSPACE", keynum: K_BACKSPACE },
  { name: "UPARROW", keynum: K_UPARROW },
  { name: "DOWNARROW", keynum: K_DOWNARROW },
  { name: "LEFTARROW", keynum: K_LEFTARROW },
  { name: "RIGHTARROW", keynum: K_RIGHTARROW },

  { name: "ALT", keynum: K_ALT },
  { name: "CTRL", keynum: K_CTRL },
  { name: "SHIFT", keynum: K_SHIFT },

  { name: "F1", keynum: K_F1 },
  { name: "F2", keynum: K_F2 },
  { name: "F3", keynum: K_F3 },
  { name: "F4", keynum: K_F4 },
  { name: "F5", keynum: K_F5 },
  { name: "F6", keynum: K_F6 },
  { name: "F7", keynum: K_F7 },
  { name: "F8", keynum: K_F8 },
  { name: "F9", keynum: K_F9 },
  { name: "F10", keynum: K_F10 },
  { name: "F11", keynum: K_F11 },
  { name: "F12", keynum: K_F12 },

  { name: "INS", keynum: K_INS },
  { name: "DEL", keynum: K_DEL },
  { name: "PGDN", keynum: K_PGDN },
  { name: "PGUP", keynum: K_PGUP },
  { name: "HOME", keynum: K_HOME },
  { name: "END", keynum: K_END },

  { name: "MOUSE1", keynum: K_MOUSE1 },
  { name: "MOUSE2", keynum: K_MOUSE2 },
  { name: "MOUSE3", keynum: K_MOUSE3 },

  { name: "JOY1", keynum: K_JOY1 },
  { name: "JOY2", keynum: K_JOY2 },
  { name: "JOY3", keynum: K_JOY3 },
  { name: "JOY4", keynum: K_JOY4 },

  { name: "AUX1", keynum: K_AUX1 },
  { name: "AUX2", keynum: K_AUX2 },
  { name: "AUX3", keynum: K_AUX3 },
  { name: "AUX4", keynum: K_AUX4 },
  { name: "AUX5", keynum: K_AUX5 },
  { name: "AUX6", keynum: K_AUX6 },
  { name: "AUX7", keynum: K_AUX7 },
  { name: "AUX8", keynum: K_AUX8 },
  { name: "AUX9", keynum: K_AUX9 },
  { name: "AUX10", keynum: K_AUX10 },
  { name: "AUX11", keynum: K_AUX11 },
  { name: "AUX12", keynum: K_AUX12 },
  { name: "AUX13", keynum: K_AUX13 },
  { name: "AUX14", keynum: K_AUX14 },
  { name: "AUX15", keynum: K_AUX15 },
  { name: "AUX16", keynum: K_AUX16 },
  { name: "AUX17", keynum: K_AUX17 },
  { name: "AUX18", keynum: K_AUX18 },
  { name: "AUX19", keynum: K_AUX19 },
  { name: "AUX20", keynum: K_AUX20 },
  { name: "AUX21", keynum: K_AUX21 },
  { name: "AUX22", keynum: K_AUX22 },
  { name: "AUX23", keynum: K_AUX23 },
  { name: "AUX24", keynum: K_AUX24 },
  { name: "AUX25", keynum: K_AUX25 },
  { name: "AUX26", keynum: K_AUX26 },
  { name: "AUX27", keynum: K_AUX27 },
  { name: "AUX28", keynum: K_AUX28 },
  { name: "AUX29", keynum: K_AUX29 },
  { name: "AUX30", keynum: K_AUX30 },
  { name: "AUX31", keynum: K_AUX31 },
  { name: "AUX32", keynum: K_AUX32 },

  { name: "PAUSE", keynum: K_PAUSE },

  { name: "MWHEELUP", keynum: K_MWHEELUP },
  { name: "MWHEELDOWN", keynum: K_MWHEELDOWN },

  { name: "SEMICOLON", keynum: ";".charCodeAt(0) }, // because a raw semicolon seperates commands
];

/*
==============================================================================

            LINE TYPING INTO THE CONSOLE

==============================================================================
*/

/*
====================
Key_Console

Interactive line editing and console scrollback
====================
*/
// QW/client/keys.c's CheckForCommand/CompleteCommand (~153-197): new helpers,
// no WinQuake counterpart. Module-private -- see file header.
function CheckForCommand(): boolean {
  const s = key_lines[keyState.edit_line].slice(1);
  let command = "";
  for (let i = 0; i < 127 && i < s.length; i++) {
    if (s.charCodeAt(i) <= 32) break;
    command += s[i];
  }

  let cmd = Cmd_CompleteCommand(command);
  if (!cmd || cmd !== command) cmd = Cvar_CompleteVariable(command);
  if (!cmd || cmd !== command) return false;
  return true;
}

function CompleteCommand(): void {
  let s = key_lines[keyState.edit_line].slice(1);
  if (s[0] === "\\" || s[0] === "/") s = s.slice(1);

  let cmd = Cmd_CompleteCommand(s);
  if (!cmd) cmd = Cvar_CompleteVariable(s);
  if (cmd) {
    key_lines[keyState.edit_line] = "]/" + cmd + " ";
    keyState.key_linepos = key_lines[keyState.edit_line].length;
  }
}

function Key_Console(key: number): void {
  if (key === K_ENTER) {
    if (qw.active) {
      // QW/client/keys.c's Key_Console K_ENTER branch (~216-233): distinguish
      // an explicit command from a chat message -- see file header.
      const line = key_lines[keyState.edit_line];
      if (line[1] === "\\" || line[1] === "/") {
        Cbuf_AddText(line.slice(2)); // skip the ]\ or ]/
      } else if (CheckForCommand()) {
        Cbuf_AddText(line.slice(1)); // valid command
      } else {
        // convert to a chat message
        if (cls.state === CactiveT.ca_connected || cls.state === CactiveT.ca_onserver || cls.state === CactiveT.ca_active) {
          Cbuf_AddText("say ");
        }
        Cbuf_AddText(line.slice(1)); // skip the >
      }
    } else {
      Cbuf_AddText(key_lines[keyState.edit_line].slice(1)); // skip the >
    }
    Cbuf_AddText("\n");
    Con_Printf("%s\n", key_lines[keyState.edit_line]);
    keyState.edit_line = (keyState.edit_line + 1) & 31;
    history_line = keyState.edit_line;
    // C only overwrites index 0 here (`key_lines[edit_line][0] = ']'`), not
    // index 1 the way Key_Init does -- whatever text this ring slot held 32
    // enters ago stays past the new ']' until the user types over it or a
    // history recall replaces the whole line. Preserved verbatim.
    key_lines[keyState.edit_line] = "]" + key_lines[keyState.edit_line].slice(1);
    keyState.key_linepos = 1;
    if (cls.state === CactiveT.ca_disconnected) hostClientHooks.scrUpdateScreen?.(); // force an update, because the command may take some time
    return;
  }

  if (key === K_TAB) {
    if (qw.active) {
      // QW/client/keys.c's Key_Console K_TAB branch calls CompleteCommand()
      // (see file header for how it differs from WinQuake's inline version
      // below).
      CompleteCommand();
      return;
    }
    // command completion
    let cmd = Cmd_CompleteCommand(key_lines[keyState.edit_line].slice(1));
    if (!cmd) cmd = Cvar_CompleteVariable(key_lines[keyState.edit_line].slice(1));
    if (cmd) {
      keyState.key_linepos = cmd.length + 1;
      key_lines[keyState.edit_line] = key_lines[keyState.edit_line].slice(0, 1) + cmd + " ";
      keyState.key_linepos++;
      return;
    }
  }

  if (key === K_BACKSPACE || key === K_LEFTARROW) {
    if (keyState.key_linepos > 1) keyState.key_linepos--;
    return;
  }

  if (key === K_UPARROW) {
    do {
      history_line = (history_line - 1) & 31;
    } while (history_line !== keyState.edit_line && key_lines[history_line].length <= 1);
    if (history_line === keyState.edit_line) history_line = (keyState.edit_line + 1) & 31;
    key_lines[keyState.edit_line] = key_lines[history_line];
    keyState.key_linepos = key_lines[keyState.edit_line].length;
    return;
  }

  if (key === K_DOWNARROW) {
    if (history_line === keyState.edit_line) return;
    do {
      history_line = (history_line + 1) & 31;
    } while (history_line !== keyState.edit_line && key_lines[history_line].length <= 1);
    if (history_line === keyState.edit_line) {
      // same partial-clear quirk as Key_Console's K_ENTER branch above.
      key_lines[keyState.edit_line] = "]" + key_lines[keyState.edit_line].slice(1);
      keyState.key_linepos = 1;
    } else {
      key_lines[keyState.edit_line] = key_lines[history_line];
      keyState.key_linepos = key_lines[keyState.edit_line].length;
    }
    return;
  }

  if (key === K_PGUP || key === K_MWHEELUP) {
    conState.con_backscroll += 2;
    if (conState.con_backscroll > conState.con_totallines - (vid.height >> 3) - 1) conState.con_backscroll = conState.con_totallines - (vid.height >> 3) - 1;
    return;
  }

  if (key === K_PGDN || key === K_MWHEELDOWN) {
    conState.con_backscroll -= 2;
    if (conState.con_backscroll < 0) conState.con_backscroll = 0;
    return;
  }

  if (key === K_HOME) {
    conState.con_backscroll = conState.con_totallines - (vid.height >> 3) - 1;
    return;
  }

  if (key === K_END) {
    conState.con_backscroll = 0;
    return;
  }

  if (key < 32 || key > 127) return; // non printable

  if (keyState.key_linepos < MAXCMDLINE - 1) {
    key_lines[keyState.edit_line] = key_lines[keyState.edit_line].slice(0, keyState.key_linepos) + String.fromCharCode(key);
    keyState.key_linepos++;
  }
}

//============================================================================

let chat_bufferlen = 0; // static int chat_bufferlen in Key_Message

function Key_Message(key: number): void {
  if (key === K_ENTER) {
    if (keyState.team_message) Cbuf_AddText('say_team "');
    else Cbuf_AddText('say "');
    Cbuf_AddText(keyState.chat_buffer);
    Cbuf_AddText('"\n');

    keyState.key_dest = KeydestT.key_game;
    chat_bufferlen = 0;
    keyState.chat_buffer = "";
    return;
  }

  if (key === K_ESCAPE) {
    keyState.key_dest = KeydestT.key_game;
    chat_bufferlen = 0;
    keyState.chat_buffer = "";
    return;
  }

  if (key < 32 || key > 127) return; // non printable

  if (key === K_BACKSPACE) {
    if (chat_bufferlen) {
      chat_bufferlen--;
      keyState.chat_buffer = keyState.chat_buffer.slice(0, chat_bufferlen);
    }
    return;
  }

  // QW: chat_buffer[MAXCMDLINE] (255-char cap), not WinQuake's fixed 32-byte
  // chat_buffer[32] (31-char cap) -- see file header.
  if (chat_bufferlen === (qw.active ? MAXCMDLINE - 1 : 31)) return; // all full

  keyState.chat_buffer += String.fromCharCode(key);
  chat_bufferlen++;
}

//============================================================================

/*
===================
Key_StringToKeynum

Returns a key number to be used to index keybindings[] by looking at
the given string.  Single ascii characters return themselves, while
the K_* names are matched up.
===================
*/
export function Key_StringToKeynum(str: string): number {
  if (!str || !str.length) return -1;
  if (str.length === 1) return str.charCodeAt(0);

  for (const kn of keynames) {
    if (Q_strcasecmp(str, kn.name) === 0) return kn.keynum;
  }
  return -1;
}

/*
===================
Key_KeynumToString

Returns a string (either a single ascii char, or a K_* name) for the
given keynum.
FIXME: handle quote special (general escape sequence?)
===================
*/
export function Key_KeynumToString(keynum: number): string {
  if (keynum === -1) return "<KEY NOT FOUND>";
  if (keynum > 32 && keynum < 127) {
    // printable ascii
    return String.fromCharCode(keynum);
  }

  for (const kn of keynames) {
    if (keynum === kn.keynum) return kn.name;
  }

  return "<UNKNOWN KEYNUM>";
}

/*
===================
Key_SetBinding
===================
*/
export function Key_SetBinding(keynum: number, binding: string): void {
  if (keynum === -1) return;

  // free old bindings / allocate memory for new binding: Z_Free+Z_Malloc+Q_strcpy
  // collapse to a plain string assignment (PORTING.md's zone.c ruling).
  keybindings[keynum] = binding;
}

/*
===================
Key_Unbind_f
===================
*/
export function Key_Unbind_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("unbind <key> : remove commands from a key\n");
    return;
  }

  const b = Key_StringToKeynum(Cmd_Argv(1));
  if (b === -1) {
    Con_Printf('"%s" isn\'t a valid key\n', Cmd_Argv(1));
    return;
  }

  Key_SetBinding(b, "");
}

export function Key_Unbindall_f(): void {
  for (let i = 0; i < 256; i++) if (keybindings[i] !== null) Key_SetBinding(i, "");
}

/*
===================
Key_Bind_f
===================
*/
export function Key_Bind_f(): void {
  const c = Cmd_Argc();

  if (c !== 2 && c !== 3) {
    Con_Printf("bind <key> [command] : attach a command to a key\n");
    return;
  }
  const b = Key_StringToKeynum(Cmd_Argv(1));
  if (b === -1) {
    Con_Printf('"%s" isn\'t a valid key\n', Cmd_Argv(1));
    return;
  }

  if (c === 2) {
    // `if (keybindings[b])` in C tests pointer non-null, not string
    // non-empty -- a key unbound via Key_Unbind_f is bound to "" (a valid
    // pointer to an empty string), so it still reports "= """ here rather
    // than "is not bound". Preserved with an explicit null check.
    const bound = keybindings[b];
    if (bound !== null) Con_Printf('"%s" = "%s"\n', Cmd_Argv(1), bound);
    else Con_Printf('"%s" is not bound\n', Cmd_Argv(1));
    return;
  }

  // copy the rest of the command line
  let cmd = ""; // start out with a null string
  for (let i = 2; i < c; i++) {
    if (i > 2) cmd += " ";
    cmd += Cmd_Argv(i);
  }

  Key_SetBinding(b, cmd);
}

/*
============
Key_WriteBindings

Writes lines containing "bind key value"
============
*/
export function Key_WriteBindings(f: { write(s: string): void }): void {
  for (let i = 0; i < 256; i++) {
    const binding = keybindings[i];
    if (binding === null) continue;
    if (qw.active) {
      // QW writes a line for any binding at all (even ""), and does not
      // quote the key name -- see file header.
      f.write(`bind ${Key_KeynumToString(i)} "${binding}"\n`);
    } else if (binding.length > 0) {
      f.write(`bind "${Key_KeynumToString(i)}" "${binding}"\n`);
    }
  }
}

/*
===================
Key_Init
===================
*/
export function Key_Init(): void {
  for (let i = 0; i < 32; i++) {
    key_lines[i] = "]";
  }
  keyState.key_linepos = 1;

  //
  // init ascii characters in console mode
  //
  for (let i = 32; i < 128; i++) consolekeys[i] = true;
  consolekeys[K_ENTER] = true;
  consolekeys[K_TAB] = true;
  consolekeys[K_LEFTARROW] = true;
  consolekeys[K_RIGHTARROW] = true;
  consolekeys[K_UPARROW] = true;
  consolekeys[K_DOWNARROW] = true;
  consolekeys[K_BACKSPACE] = true;
  // QW/client/keys.c's Key_Init additionally marks Home/End as console keys.
  if (qw.active) {
    consolekeys[K_HOME] = true;
    consolekeys[K_END] = true;
  }
  consolekeys[K_PGUP] = true;
  consolekeys[K_PGDN] = true;
  consolekeys[K_SHIFT] = true;
  consolekeys[K_MWHEELUP] = true;
  consolekeys[K_MWHEELDOWN] = true;
  consolekeys["`".charCodeAt(0)] = false;
  consolekeys["~".charCodeAt(0)] = false;

  for (let i = 0; i < 256; i++) keyshift[i] = i;
  for (let i = "a".charCodeAt(0); i <= "z".charCodeAt(0); i++) keyshift[i] = i - "a".charCodeAt(0) + "A".charCodeAt(0);
  keyshift["1".charCodeAt(0)] = "!".charCodeAt(0);
  keyshift["2".charCodeAt(0)] = "@".charCodeAt(0);
  keyshift["3".charCodeAt(0)] = "#".charCodeAt(0);
  keyshift["4".charCodeAt(0)] = "$".charCodeAt(0);
  keyshift["5".charCodeAt(0)] = "%".charCodeAt(0);
  keyshift["6".charCodeAt(0)] = "^".charCodeAt(0);
  keyshift["7".charCodeAt(0)] = "&".charCodeAt(0);
  keyshift["8".charCodeAt(0)] = "*".charCodeAt(0);
  keyshift["9".charCodeAt(0)] = "(".charCodeAt(0);
  keyshift["0".charCodeAt(0)] = ")".charCodeAt(0);
  keyshift["-".charCodeAt(0)] = "_".charCodeAt(0);
  keyshift["=".charCodeAt(0)] = "+".charCodeAt(0);
  keyshift[",".charCodeAt(0)] = "<".charCodeAt(0);
  keyshift[".".charCodeAt(0)] = ">".charCodeAt(0);
  keyshift["/".charCodeAt(0)] = "?".charCodeAt(0);
  keyshift[";".charCodeAt(0)] = ":".charCodeAt(0);
  keyshift["'".charCodeAt(0)] = '"'.charCodeAt(0);
  keyshift["[".charCodeAt(0)] = "{".charCodeAt(0);
  keyshift["]".charCodeAt(0)] = "}".charCodeAt(0);
  keyshift["`".charCodeAt(0)] = "~".charCodeAt(0);
  keyshift["\\".charCodeAt(0)] = "|".charCodeAt(0);

  menubound[K_ESCAPE] = true;
  for (let i = 0; i < 12; i++) menubound[K_F1 + i] = true;

  //
  // register our functions
  //
  Cmd_AddCommand("bind", Key_Bind_f);
  Cmd_AddCommand("unbind", Key_Unbind_f);
  Cmd_AddCommand("unbindall", Key_Unbindall_f);
}

/*
===================
Key_Event

Called by the system between frames for both key up and key down events
Should NOT be called during an interrupt!
===================
*/
export function Key_Event(key: number, down: boolean): void {
  keydown[key] = down;

  if (!down) key_repeats[key] = 0;

  key_lastpress = key;
  keyState.key_count++;
  if (keyState.key_count <= 0) {
    return; // just catching keys for Con_NotifyBox
  }

  // update auto-repeat status
  if (down) {
    key_repeats[key]++;
    // QW additionally exempts K_PGUP/K_PGDN from autorepeat suppression --
    // see file header.
    const autorepeatExempt = qw.active ? key !== K_BACKSPACE && key !== K_PAUSE && key !== K_PGUP && key !== K_PGDN : key !== K_BACKSPACE && key !== K_PAUSE;
    if (autorepeatExempt && key_repeats[key] > 1) {
      return; // ignore most autorepeats
    }

    // `!keybindings[key]` in C is a null-pointer test, true only for a key
    // that has never been bound (unbind sets an empty-string binding, which
    // is a non-null pointer and so does not trigger this message).
    if (key >= 200 && keybindings[key] === null) Con_Printf("%s is unbound, hit F4 to set.\n", Key_KeynumToString(key));
  }

  if (key === K_SHIFT) shift_down = down;

  //
  // handle escape specialy, so the user can never unbind it
  //
  if (key === K_ESCAPE) {
    if (!down) return;
    switch (keyState.key_dest) {
      case KeydestT.key_message:
        Key_Message(key);
        break;
      case KeydestT.key_menu:
        menuKeydown(key);
        break;
      case KeydestT.key_game:
      case KeydestT.key_console:
        menuToggleMenu_f();
        break;
      default:
        Sys_Error("Bad key_dest");
    }
    return;
  }

  //
  // key up events only generate commands if the game key binding is
  // a button command (leading + sign).  These will occur even in console mode,
  // to keep the character from continuing an action started before a console
  // switch.  Button commands include the kenum as a parameter, so multiple
  // downs can be matched with ups
  //
  if (!down) {
    let kb = keybindings[key];
    if (kb !== null && kb[0] === "+") {
      Cbuf_AddText(`-${kb.slice(1)} ${key}\n`);
    }
    if (keyshift[key] !== key) {
      kb = keybindings[keyshift[key]];
      if (kb !== null && kb[0] === "+") {
        Cbuf_AddText(`-${kb.slice(1)} ${key}\n`);
      }
    }
    return;
  }

  //
  // during demo playback, most keys bring up the main menu
  //
  if (cls.demoplayback && down && consolekeys[key] && keyState.key_dest === KeydestT.key_game) {
    menuToggleMenu_f();
    return;
  }

  //
  // if not a consolekey, send to the interpreter no matter what mode is
  //
  if (
    (keyState.key_dest === KeydestT.key_menu && menubound[key]) ||
    (keyState.key_dest === KeydestT.key_console && !consolekeys[key]) ||
    // QW's key_game routing gate is `cls.state === ca_active || !consolekeys[key]`,
    // not WinQuake's `con_forcedup`-based one (QW/client/console.c has no
    // `con_forcedup` at all) -- see file header.
    (keyState.key_dest === KeydestT.key_game && ((qw.active ? cls.state === CactiveT.ca_active : !conState.con_forcedup) || !consolekeys[key]))
  ) {
    const kb = keybindings[key];
    if (kb !== null) {
      if (kb[0] === "+") {
        // button commands add keynum as a parm
        Cbuf_AddText(`${kb} ${key}\n`);
      } else {
        Cbuf_AddText(kb);
        Cbuf_AddText("\n");
      }
    }
    return;
  }

  if (!down) return; // other systems only care about key down events

  let dispatchKey = key;
  if (shift_down) {
    dispatchKey = keyshift[key];
  }

  switch (keyState.key_dest) {
    case KeydestT.key_message:
      Key_Message(dispatchKey);
      break;
    case KeydestT.key_menu:
      menuKeydown(dispatchKey);
      break;

    case KeydestT.key_game:
    case KeydestT.key_console:
      Key_Console(dispatchKey);
      break;
    default:
      Sys_Error("Bad key_dest");
  }
}

/*
===================
Key_ClearStates
===================
*/
export function Key_ClearStates(): void {
  for (let i = 0; i < 256; i++) {
    keydown[i] = false;
    key_repeats[i] = 0;
  }
}

hostClientHooks.keyDestIsGame = () => keyState.key_dest === KeydestT.key_game;
hostClientHooks.keyDestIsConsole = () => keyState.key_dest === KeydestT.key_console;
hostClientHooks.setKeyDestGame = () => {
  keyState.key_dest = KeydestT.key_game;
};
hostClientHooks.keyWriteBindings = (f: { write(s: string): void }) => Key_WriteBindings(f);
hostClientHooks.keyInit = () => Key_Init();

svUserHooks.keyDestIsGame = () => keyState.key_dest === KeydestT.key_game;
