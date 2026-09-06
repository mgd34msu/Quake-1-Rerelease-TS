/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/console.h and QW/client/console.c (GNU GPL v2 or later).

console.c -- the scrollback console buffer, its drawing, and Con_Printf's
print/log/echo family -- QuakeWorld's own version.

Ruling (PORTING.md's QuakeWorld track): `diff -w WinQuake/console.c
QW/client/console.c` is 370 of 693 QW lines (~53%), well past the ~40%
fold threshold, and the change is not additive -- QW replaces the flat
`con_text`/`con_current`/`con_x`/`con_backscroll` globals with a `console_t`
struct (`text`/`current`/`x`/`display`), two instances (`con_main`/`con_chat`)
selected by a `con` pointer, and a per-console `Con_Resize`. Wholesale module,
mirroring src/client/console.ts's own idioms (lazy-required client/keys/
screen modules, a small exported holder for reassigned globals, module-scope
statics for values nothing outside this file reads).

Struct/state mapping (QW/client/console.h):
- `console_t { char text[CON_TEXTSIZE]; int current; int x; int display; }`
  -> `class ConsoleT` with `text: Uint8Array`, `current`, `x`, `display`. The
  C's two static instances (`console_t con_main, con_chat;`, plain BSS, so
  `text` starts zero-filled) are `export const con_main = new ConsoleT()`/
  `con_chat = new ConsoleT()` -- no Hunk_AllocName call anywhere in this C
  file (unlike WinQuake's single `con_text`, which the WinQuake unit
  allocates via Hunk_AllocName): QW's two buffers are fixed struct members,
  so a plain zero-filled `Uint8Array` field is the faithful equivalent, and
  this module has no zone.ts dependency at all.
- `int con_ormask`, `console_t *con`, `int con_linewidth`, `int
  con_totallines`, `qboolean con_initialized`, `int con_notifylines` are all
  reassigned from multiple functions in this file (and, per the coordinator's
  wiring note below, from cl_parse.ts's PRINT_CHAT case for `con_ormask`), so
  they become the exported `conState` holder, PORTING.md's "small exported
  holder" rule for reassigned globals. `con_vislines` (assigned by
  Con_DrawConsole, read by Con_DrawInput) is also module-global in the C
  (not a `console_t` field) and joins the same holder for the same reason.
- `con_debuglog`, the function-local `static int cr` in Con_Print, and the
  function-local `static qboolean inupdate` in Con_Printf are read only
  inside this file, so they stay as plain module-level `let`s, not part of
  `conState`.
- `byte *con_chars` and `void Con_DrawCharacter(int,int,int)` are declared in
  console.h but never defined or referenced anywhere in the QW client tree
  (grepped across every QW/client/*.c and *.h) -- dead declarations, dropped
  and reported rather than stubbed.

Function-by-function differences from src/client/console.ts (WinQuake),
each verified directly against QW/client/console.c's own body (not assumed):
- `Con_ToggleConsole_f` and `Con_ToggleChat_f` have IDENTICAL bodies in the
  C (grepped the whole QW/client tree for `con = &con_` and `con_chat`: `con`
  is assigned exactly once, in Con_Init, and never reassigned anywhere else
  in any QW/client file). So `togglechat` does not swap `con` between
  `con_main`/`con_chat` -- it is a plain duplicate of `toggleconsole`, and
  `con_chat` is otherwise-dead state in retail QW 2.33 (still resized by
  Con_CheckResize, never displayed since `con` never points at it). Ported
  exactly as the original: both functions are separate exports with identical bodies,
  neither touches `conState.con`. (The unit brief's TEST section assumed
  Con_ToggleChat_f swaps `con`; it does not, per the source actually read --
  see this unit's report.)
- Neither toggle function calls SCR_EndLoadingPlaque or falls back to a menu
  when disconnected (WinQuake's Con_ToggleConsole_f does both); QW's own
  body is exactly `Key_ClearTyping(); if (key_dest==key_console) { if
  (cls.state==ca_active) key_dest=key_game; } else key_dest=key_console;
  Con_ClearNotify();` -- nothing else.
- `Con_Print` has no colored-prefix S_LocalSound("misc/talk.wav") call (that
  is WinQuake-only); QW's mask test is only `txt[0]==1 || txt[0]==2 ->
  mask=128`, no sound side effect, no snd_dma dependency.
- `Con_Print`/`Con_DrawConsole`/`Con_DrawNotify` read/write `con->x`,
  `con->current`, `con->text`, `con->display` (whichever console `con`
  currently points at) instead of WinQuake's flat `conState.con_x`/
  `con_current`/`con_text`/`con_backscroll`. There is no `con_backscroll`
  scalar in QW at all -- the backscroll indicator in Con_DrawConsole compares
  `con->display != con->current` directly.
- `Con_CheckResize`/`Con_Resize(console_t*)`: QW's own quirk, preserved
  exactly as the original -- `Con_Resize` early-returns as soon as the freshly computed
  `(vid.width>>3)-2` equals the *global* `con_linewidth`, which the first
  call (con_main) already updated. So once `vid.width` has a real value,
  `Con_CheckResize`'s second call (con_chat) is a same-width no-op that never
  touches `con_chat.current`/`display` -- only con_main ends up with
  `current`/`display` set to `con_totallines-1` on a normal resize. This
  reproduces exactly (traced by hand against the C, not assumed): the
  `width < 1` branch (video not yet initialized) recomputes the same `width`
  value every call since it does not depend on `con_linewidth`, so it takes
  effect for both consoles there.
- `Con_Init` never calls Hunk_AllocName (see struct mapping above) and has no
  `-condebug` unlink-stale-log step (unlike src/client/console.ts's WinQuake
  version, which drops the same unlink for a different reason -- QW's own C
  simply never has that line).
- `Con_Printf` has NO `cls.state == ca_dedicated` early return at all (QW has
  no dedicated-client concept -- `QW/qwsv` is a wholly separate binary/tree).
  Its screen-update condition is `if (cls.state != ca_active)`, not
  WinQuake's `cls.signon != SIGNONS && !scr_disabled_for_loading`. Also no
  `host_initialized` check anywhere in this function (read directly; absent).
- `Con_DPrintf` reads QW's own `developer` cvar directly via a lazy require of
  `./cl_main` (which already exports it, `export const developer = new
  CvarT("developer", "0")`), rather than WinQuake's console.ts's
  `setDeveloper()` registration-hook indirection: cl_main.ts lives in this
  same directory and is already one of this file's lazy-required siblings
  (for `clMainState.realtime`), so no extra wiring hook is needed. Reported
  as a deliberate simplification, not an oversight.
- `Con_DrawInput`'s guard is `key_dest != key_console && cls.state ==
  ca_active` (by name, per PORTING.md's CactiveT-numbering warning), not
  WinQuake's `con_forcedup` flag, which QW does not have. The cursor row is
  `con_vislines - 22`, not WinQuake's `-16` (QW's console layout reserves two
  extra text rows below the divider bar for... whatever id's layout tuning
  was -- ported as the literal constant). `y = con_vislines-22;` is computed
  in the C but never read (the loop below uses the literal expression again,
  not `y`) -- same dead store src/client/console.ts's own header notes for
  its own `-16` version; dropped here too, not carried as an unused local.
  The cursor-into-key_lines/restore-afterward idiom is the same scratch-copy
  substitution src/client/console.ts's header documents (key_lines entries
  are immutable strings in this port).
- `Con_DrawNotify`'s chat-mode line distinguishes `chat_team` ("say_team:",
  skip=11) from the non-team case ("say:", skip=5); WinQuake has no
  chat_team and always draws "say:". `chat_team` is QW/client/keys.c's own
  global; this port's src/client/keys.ts names the same field
  `keyState.team_message` (its own file header: "team_message is named
  chat_team in QW's C") -- no separate `chat_team` export exists or is
  needed. QW's C also right-truncates the chat line against `chat_bufferlen`
  (a `static int` private to Key_Message in keys.c); keys.ts keeps the
  matching counter as its own module-private `let chat_bufferlen`, not
  exported. `keyState.chat_buffer.length` is used here in its place (the two
  values are kept in lockstep by every keys.ts write site, per keys.ts's own
  header), and the missing export is reported as a coordinator follow-up
  rather than reached into keys.ts to add (out of this unit's SCOPE).
- `Con_DrawConsole(int lines)` drops WinQuake's `drawinput` parameter
  entirely (QW's header declares only `Con_DrawConsole (int lines)`) and
  always calls Con_DrawInput at the end, unconditionally. The backscroll
  arrows are drawn when `con->display != con->current` (a per-console
  field), not WinQuake's `con_backscroll` counter. The download-bar block
  (`cls.download`/`downloadname`/`downloadpercent`, QW-only) reads
  `cls.qw.download`/`downloadname`/`downloadpercent`
  (src/qw/client/client.ts's `QwClientStaticExtT`); WinQuake's Con_DrawConsole
  has no such block at all. `strrchr(name,'/')` is `lastIndexOf("/")` +
  slice; the C's `y`/`x`/`i`/`j`/`n` locals are reused across two unrelated
  purposes (a screen coordinate, then a progress-bar width) inside the same
  function -- given clearer names here (`barBase`/`barWidth`/`barY`) with the
  exact same arithmetic, including the truncating integer division
  (`Math.trunc` at each `/` the C performs on ints).
- The `"QuakeWorld %1.2f"`/`VERSION` string the task brief asked to verify is
  NOT drawn by console.c at all -- it lives in QW/client/draw.c's/gl_draw.c's
  own `Draw_ConsoleBackground` (grepped: `Con_DrawConsole`'s only two call
  sites, screen.c:565 and gl_screen.c:592, both just call
  `Con_DrawConsole(scr_con_current)`; VERSION only appears in draw.c/
  gl_draw.c/menu.c). Nothing for this module to do beyond calling
  `getRenderer().Draw_ConsoleBackground(lines)`, exactly as WinQuake's does.
- `Con_NotifyBox`'s border strings (`"\35\36...\37\n"`) are reproduced
  byte-for-byte: recounted directly from the C (both call sites), 1 byte
  0x1d, exactly 35 bytes 0x1e, 1 byte 0x1f -- identical count on both call
  sites (an initial hand-count suggested otherwise; a byte-exact recount
  settled it at 35/35).
- `Con_SafePrintf` exists in this file (QW/client/console.c lines 678-692)
  and is ported identically to WinQuake's (temporarily forces
  `scr_disabled_for_loading`, calls Con_Printf, restores it).

Import-cycle discipline (PORTING.md's "less fundamental module resolves
lazily" rule, mirroring src/client/console.ts's own header): src/client/
client.ts (`cls`/`CactiveT`), ./cl_main.ts (`clMainState.realtime`,
`developer`), src/client/keys.ts (`keyState`/`KeydestT`/`key_lines`), ./
screen.ts (`SCR_UpdateScreen`) and src/client/render.ts (`getRenderer`) are
each reached only through a lazy `require()` inside function bodies, per this
unit's brief. `src/common/cvar.ts`/`cmd.ts`/`common.ts`/`sprintf.ts` (none of
which import anything under src/qw/) are imported statically at module top,
also per the brief -- confirmed safe by reading each of their own import
lists (cvar.ts/cmd.ts/zone.ts/common.ts all statically import WinQuake's
`../client/console`, never this file, so no cycle reaches back here through
them). `src/client/vid.ts` (no imports of its own) and `src/client/
screen_types.ts` (imports only `./vid`) are the same proven-leaf pair
WinQuake's console.ts already imports statically.

Coordinator wiring (this unit's SCOPE is only this file and its test; every
item below is a path/signature change in ANOTHER file, listed for whoever
picks up the switch):
- 19 files currently import Con_* names from WinQuake's
  `../../client/console` (or `../client/console` for src/qw/*.ts's direct
  children) as a stand-in for this module: src/qw/pmovetst.ts,
  src/qw/net_udp.ts, src/qw/net_chan.ts, src/qw/common.ts, src/qw/cmd.ts,
  src/qw/client/cl_ents.ts, src/qw/client/cl_pred.ts, src/qw/client/skin.ts,
  src/qw/client/menu.ts, src/qw/client/r_part.ts, src/qw/client/screen.ts,
  src/qw/client/cl_main.ts, src/qw/client/cl_parse.ts,
  src/qw/client/cl_cam.ts, src/qw/client/cl_tent.ts,
  src/qw/client/cl_demo.ts, src/qw/client/cl_input.ts,
  src/qw/server/pr_edict.ts, src/qw/server/pr_exec.ts. Every export this
  file needs from those call sites (Con_Printf, Con_DPrintf, Con_Init,
  Con_Print, Con_CheckResize, Con_ClearNotify, Con_DrawConsole,
  Con_DrawNotify, Con_ToggleConsole_f, conState) exists here under the same
  name, so the switch is a bare import-path change EXCEPT:
  * src/qw/client/screen.ts:418 calls `Con_DrawConsole(scrState.scr_con_current,
    true)` -- this module's `Con_DrawConsole` takes one argument; the `true`
    must be dropped when the path switches (screen.ts's own header already
    flags this exact spot, "console.ts hasn't folded QW's 1-arg
    Con_DrawConsole yet").
  * src/qw/client/screen.ts reads `conState.con_notifylines` and
    `conState.con_initialized`, both present here under the same names on
    the same holder shape; no other change needed there.
  * src/qw/client/cl_parse.ts:1060/1063 have two commented-out
    `// con_ormask = 128;` / `// con_ormask = 0;` lines (its own header:
    "con_ormask = 128 around svc_print's PRINT_CHAT case... dropped and
    reported"); once switched to this module, those become
    `conMod.conState.con_ormask = 128;` / `= 0;` (import `conState` instead
    of a bare `con_ormask`, since a reassigned scalar needs the holder, not a
    live binding).
  * src/qw/client/cl_main.ts's own header note ("con_ormask = 128... has no
    counterpart in src/client/console.ts... Nothing here reads it") is now
    stale in the same way; cl_main.ts itself never reads `con_ormask`, so no
    change needed there beyond the plain import-path switch.
*/

import { Sys_Printf, Sys_DebugLog, Sys_SendKeyEvents, Sys_FloatTime, SysError } from "../../platform/sys";
import { Com_sprintf } from "../../common/sprintf";
import { CvarT, Cvar_RegisterVariable } from "../../common/cvar";
import { Cmd_AddCommand } from "../../common/cmd";
import { COM_CheckParm, com_gamedir } from "../../common/common";
import { vid } from "../../client/vid";
import { scrState } from "../../client/screen_types";
import type * as ClientModule from "../../client/client";
import type * as ClMainModule from "./cl_main";
import type * as KeysModule from "../../client/keys";
import type * as ScreenModule from "./screen";
import type * as RenderModule from "../../client/render";

// see the file header's import-cycle note
function clientMod(): typeof ClientModule {
  return require("../../client/client");
}
function clMainMod(): typeof ClMainModule {
  return require("./cl_main");
}
function keysMod(): typeof KeysModule {
  return require("../../client/keys");
}
function screenMod(): typeof ScreenModule {
  return require("./screen");
}
function renderMod(): typeof RenderModule {
  return require("../../client/render");
}

export const CON_TEXTSIZE = 16384;
const NUM_CON_TIMES = 4;
const CON_CURSORSPEED = 4;

// typedef struct { char text[CON_TEXTSIZE]; int current; int x; int display; } console_t;
export class ConsoleT {
  text: Uint8Array = new Uint8Array(CON_TEXTSIZE); // BSS-zeroed, same as the C's static array
  current = 0; // line where next message will be printed
  x = 0; // offset in current line for next print
  display = 0; // bottom of console displays this line
}

export const con_main = new ConsoleT();
export const con_chat = new ConsoleT();

// Reassigned-globals holder (PORTING.md's rule) -- see file header for why
// `con_backscroll` (WinQuake's own field) is not part of this shape: QW has
// no such scalar, only `console_t.display` vs `.current`.
export const conState = {
  con: con_main as ConsoleT, // console_t *con -- point to either con_main or con_chat
  con_ormask: 0,
  con_linewidth: 0, // characters across screen
  con_totallines: 0, // total lines in console scrollback
  con_initialized: false,
  con_notifylines: 0, // scan lines to clear for notify lines
  con_vislines: 0,
};

// realtime each line was generated, for the transparent notify overlay.
const con_times = new Float32Array(NUM_CON_TIMES);

let con_debuglog = false;

// cvar_t con_notifytime = {"con_notifytime","3"}; -- CvarT is a real class
// here (no cycle risk importing it statically; see file header), so this
// constructs one directly rather than WinQuake console.ts's object-literal
// workaround.
export const con_notifytime = new CvarT("con_notifytime", "3");

/*
================
Key_ClearTyping

console.c's own helper (not keys.c's), ported here unchanged.
================
*/
function Key_ClearTyping(): void {
  const keys = keysMod();
  keys.key_lines[keys.keyState.edit_line] = keys.key_lines[keys.keyState.edit_line].slice(0, 1); // key_lines[edit_line][1] = 0
  keys.keyState.key_linepos = 1;
}

/*
================
Con_ToggleConsole_f
================
*/
export function Con_ToggleConsole_f(): void {
  Key_ClearTyping();

  const keys = keysMod();
  const client = clientMod();
  if (keys.keyState.key_dest === keys.KeydestT.key_console) {
    if (client.cls.state === client.CactiveT.ca_active) keys.keyState.key_dest = keys.KeydestT.key_game;
  } else {
    keys.keyState.key_dest = keys.KeydestT.key_console;
  }

  Con_ClearNotify();
}

/*
================
Con_ToggleChat_f

Identical to Con_ToggleConsole_f in the C -- see file header. `con` is never
reassigned by either function.
================
*/
export function Con_ToggleChat_f(): void {
  Key_ClearTyping();

  const keys = keysMod();
  const client = clientMod();
  if (keys.keyState.key_dest === keys.KeydestT.key_console) {
    if (client.cls.state === client.CactiveT.ca_active) keys.keyState.key_dest = keys.KeydestT.key_game;
  } else {
    keys.keyState.key_dest = keys.KeydestT.key_console;
  }

  Con_ClearNotify();
}

/*
================
Con_Clear_f
================
*/
export function Con_Clear_f(): void {
  con_main.text.fill(0x20, 0, CON_TEXTSIZE);
  con_chat.text.fill(0x20, 0, CON_TEXTSIZE);
}

/*
================
Con_ClearNotify
================
*/
export function Con_ClearNotify(): void {
  for (let i = 0; i < NUM_CON_TIMES; i++) con_times[i] = 0;
}

/*
================
Con_MessageMode_f
================
*/
export function Con_MessageMode_f(): void {
  const keys = keysMod();
  keys.keyState.team_message = false; // chat_team = false
  keys.keyState.key_dest = keys.KeydestT.key_message;
}

/*
================
Con_MessageMode2_f
================
*/
export function Con_MessageMode2_f(): void {
  const keys = keysMod();
  keys.keyState.team_message = true; // chat_team = true
  keys.keyState.key_dest = keys.KeydestT.key_message;
}

/*
================
Con_Resize

Not declared in console.h (module-private in the C too, by convention --
nothing outside this file calls it).
================
*/
function Con_Resize(target: ConsoleT): void {
  const width = (vid.width >> 3) - 2;

  if (width === conState.con_linewidth) return;

  if (width < 1) {
    // video hasn't been initialized yet
    conState.con_linewidth = 38;
    conState.con_totallines = Math.trunc(CON_TEXTSIZE / conState.con_linewidth);
    target.text.fill(0x20, 0, CON_TEXTSIZE);
  } else {
    const oldwidth = conState.con_linewidth;
    conState.con_linewidth = width;
    const oldtotallines = conState.con_totallines;
    conState.con_totallines = Math.trunc(CON_TEXTSIZE / conState.con_linewidth);

    let numlines = oldtotallines;
    if (conState.con_totallines < numlines) numlines = conState.con_totallines;

    let numchars = oldwidth;
    if (conState.con_linewidth < numchars) numchars = conState.con_linewidth;

    const tbuf = target.text.slice(0, CON_TEXTSIZE);
    target.text.fill(0x20, 0, CON_TEXTSIZE);

    for (let i = 0; i < numlines; i++) {
      for (let j = 0; j < numchars; j++) {
        target.text[(conState.con_totallines - 1 - i) * conState.con_linewidth + j] =
          tbuf[((target.current - i + oldtotallines) % oldtotallines) * oldwidth + j];
      }
    }

    Con_ClearNotify();
  }

  target.current = conState.con_totallines - 1;
  target.display = target.current;
}

/*
================
Con_CheckResize

If the line width has changed, reformat the buffer. See file header for the
C's own quirk this reproduces (the second call is usually a same-width
no-op once vid.width is real).
================
*/
export function Con_CheckResize(): void {
  Con_Resize(con_main);
  Con_Resize(con_chat);
}

/*
================
Con_Init
================
*/
export function Con_Init(): void {
  con_debuglog = COM_CheckParm("-condebug") !== 0;

  conState.con = con_main;
  conState.con_linewidth = -1;
  Con_CheckResize();

  Con_Printf("Console initialized.\n");

  //
  // register our commands
  //
  Cvar_RegisterVariable(con_notifytime);

  Cmd_AddCommand("toggleconsole", Con_ToggleConsole_f);
  Cmd_AddCommand("togglechat", Con_ToggleChat_f);
  Cmd_AddCommand("messagemode", Con_MessageMode_f);
  Cmd_AddCommand("messagemode2", Con_MessageMode2_f);
  Cmd_AddCommand("clear", Con_Clear_f);
  conState.con_initialized = true;
}

/*
===============
Con_Linefeed
===============
*/
export function Con_Linefeed(): void {
  const con = conState.con;
  con.x = 0;
  if (con.display === con.current) con.display++;
  con.current++;
  const offset = (con.current % conState.con_totallines) * conState.con_linewidth;
  con.text.fill(0x20, offset, offset + conState.con_linewidth);
}

// static int cr; in the C -- function-local static, persists across calls.
let cr = false;

/*
================
Con_Print

Handles cursor positioning, line wrapping, etc
All console printing must go through this in order to be logged to disk
If no console is visible, the notify window will pop up.
================
*/
export function Con_Print(rawTxt: string): void {
  const con = conState.con;

  let idx = 0;
  let mask = 0;
  const first = rawTxt.charCodeAt(0);
  if (first === 1 || first === 2) {
    mask = 128; // go to colored text
    idx = 1;
  }

  let c: number;
  while ((c = idx < rawTxt.length ? rawTxt.charCodeAt(idx) : 0) !== 0) {
    // count word length
    let l = 0;
    for (; l < conState.con_linewidth; l++) {
      const ch = idx + l < rawTxt.length ? rawTxt.charCodeAt(idx + l) : 0;
      if (ch <= 32 /* ' ' */) break;
    }

    // word wrap
    if (l !== conState.con_linewidth && con.x + l > conState.con_linewidth) con.x = 0;

    idx++;

    if (cr) {
      con.current--;
      cr = false;
    }

    if (!con.x) {
      Con_Linefeed();
      // mark time for transparent overlay
      if (con.current >= 0) con_times[con.current % NUM_CON_TIMES] = clMainMod().clMainState.realtime;
    }

    switch (c) {
      case 10 /* '\n' */:
        con.x = 0;
        break;

      case 13 /* '\r' */:
        con.x = 0;
        cr = true;
        break;

      default: {
        // display character and advance
        const y = con.current % conState.con_totallines;
        con.text[y * conState.con_linewidth + con.x] = c | mask | conState.con_ormask;
        con.x++;
        if (con.x >= conState.con_linewidth) con.x = 0;
        break;
      }
    }
  }
}

/*
================
Con_Printf

Handles cursor positioning, line wrapping, etc
================
*/
let inupdate = false; // static qboolean inupdate; in the C

export function Con_Printf(fmt: string, ...args: Array<string | number>): void {
  const msg = Com_sprintf(fmt, ...args);

  // also echo to debugging console
  Sys_Printf("%s", msg);

  // log all messages to file
  if (con_debuglog) Sys_DebugLog(Com_sprintf("%s/qconsole.log", com_gamedir), "%s", msg);

  if (!conState.con_initialized) return;

  // write it to the scrollable buffer
  Con_Print(msg);

  // update the screen immediately if the console is displayed -- QW has no
  // cls.state==ca_dedicated early return at all (see file header)
  const client = clientMod();
  if (client.cls.state !== client.CactiveT.ca_active) {
    // protect against infinite loop if something in SCR_UpdateScreen calls Con_Printf
    if (!inupdate) {
      inupdate = true;
      try {
        screenMod().SCR_UpdateScreen();
      } catch (err) {
        // Not in the C: see src/client/console.ts's own Con_Printf for why a
        // renderer-not-loaded state has no counterpart there, and why this
        // swallows only this one specific failure of the screen draw step
        // (SCR_UpdateScreen -> render.ts's getRenderer()), never the print
        // itself (Sys_Printf above already ran unconditionally) -- anything
        // else escaping SCR_UpdateScreen is a real bug and still propagates.
        if (!(err instanceof SysError) || err.message !== "No renderer is loaded") throw err;
      } finally {
        inupdate = false;
      }
    }
  }
}

/*
================
Con_DPrintf

A Con_Printf that only shows up if the "developer" cvar is set
================
*/
export function Con_DPrintf(fmt: string, ...args: Array<string | number>): void {
  if (!clMainMod().developer.value) return; // don't confuse non-developers with techie stuff...

  const msg = Com_sprintf(fmt, ...args);
  Con_Printf("%s", msg);
}

/*
==================
Con_SafePrintf

Okay to call even when the screen can't be updated
==================
*/
export function Con_SafePrintf(fmt: string, ...args: Array<string | number>): void {
  const msg = Com_sprintf(fmt, ...args);

  const temp = scrState.scr_disabled_for_loading;
  scrState.scr_disabled_for_loading = true;
  Con_Printf("%s", msg);
  scrState.scr_disabled_for_loading = temp;
}

/*
==============================================================================

DRAWING

==============================================================================
*/

// console.c's own private copy of the macro (keys.c/keys.ts keep theirs too).
const MAXCMDLINE = 256;

/*
================
Con_DrawInput

The input line scrolls horizontally if typing goes beyond the right edge
================
*/
export function Con_DrawInput(): void {
  const keys = keysMod();
  const client = clientMod();
  if (keys.keyState.key_dest !== keys.KeydestT.key_console && client.cls.state === client.CactiveT.ca_active) return; // don't draw anything

  const line = keys.key_lines[keys.keyState.edit_line];
  const linepos = keys.keyState.key_linepos;

  // text = key_lines[edit_line]; -- a local scratch copy stands in for the
  // C's direct char* into that fixed 256-byte buffer (see src/client/
  // console.ts's own header for why: key_lines entries are immutable
  // strings in this port).
  const scratch = new Uint8Array(MAXCMDLINE);
  for (let i = 0; i < line.length && i < MAXCMDLINE; i++) scratch[i] = line.charCodeAt(i) & 0xff;

  // add the cursor frame
  if (linepos < MAXCMDLINE) scratch[linepos] = 10 + (Math.trunc(clMainMod().clMainState.realtime * CON_CURSORSPEED) & 1);

  // fill out remainder with spaces
  for (let i = linepos + 1; i < conState.con_linewidth && i < MAXCMDLINE; i++) scratch[i] = 0x20;

  // prestep if horizontally scrolling
  let base = 0;
  if (linepos >= conState.con_linewidth) base = 1 + linepos - conState.con_linewidth;

  // draw it -- `y = con_vislines-22;` is computed in the C but never read
  // (the loop uses the literal expression again); dropped, not carried as
  // an unused local (see file header).
  const renderer = renderMod().getRenderer();
  for (let i = 0; i < conState.con_linewidth; i++) renderer.Draw_Character((i + 1) << 3, conState.con_vislines - 22, scratch[base + i] ?? 0);
}

/*
================
Con_DrawNotify

Draws the last few lines of output transparently over the game top
================
*/
export function Con_DrawNotify(): void {
  const renderer = renderMod().getRenderer();
  const con = conState.con;

  let v = 0;
  for (let i = con.current - NUM_CON_TIMES + 1; i <= con.current; i++) {
    if (i < 0) continue;
    let time = con_times[i % NUM_CON_TIMES];
    if (time === 0) continue;
    time = clMainMod().clMainState.realtime - time;
    if (time > con_notifytime.value) continue;

    const lineOffset = (i % conState.con_totallines) * conState.con_linewidth;

    scrState.clearnotify = 0;
    scrState.scr_copytop = 1;

    for (let x = 0; x < conState.con_linewidth; x++) renderer.Draw_Character((x + 1) << 3, v, con.text[lineOffset + x]);

    v += 8;
  }

  const keys = keysMod();
  if (keys.keyState.key_dest === keys.KeydestT.key_message) {
    scrState.clearnotify = 0;
    scrState.scr_copytop = 1;

    let skip: number;
    if (keys.keyState.team_message) {
      renderer.Draw_String(8, v, "say_team:");
      skip = 11;
    } else {
      renderer.Draw_String(8, v, "say:");
      skip = 5;
    }

    // chat_bufferlen (the C's separate static counter, Key_Message's own) is
    // not exported by keys.ts -- see file header. keyState.chat_buffer.length
    // stands in for it.
    const chat = keys.keyState.chat_buffer;
    const chatLen = chat.length;
    const threshold = (vid.width >> 3) - (skip + 1);
    let sOffset = 0;
    if (chatLen > threshold) sOffset = chatLen - threshold;

    let x = 0;
    while (sOffset + x < chat.length) {
      renderer.Draw_Character((x + skip) << 3, v, chat.charCodeAt(sOffset + x));
      x++;
    }
    renderer.Draw_Character((x + skip) << 3, v, 10 + (Math.trunc(clMainMod().clMainState.realtime * CON_CURSORSPEED) & 1));
    v += 8;
  }

  if (v > conState.con_notifylines) conState.con_notifylines = v;
}

/*
================
Con_DrawConsole

Draws the console with the solid background
================
*/
export function Con_DrawConsole(lines: number): void {
  if (lines <= 0) return;

  const renderer = renderMod().getRenderer();

  // draw the background
  renderer.Draw_ConsoleBackground(lines);

  // draw the text
  conState.con_vislines = lines;

  const con = conState.con;

  // changed to line things up better
  let rows = (lines - 22) >> 3; // rows of text to draw
  let y = lines - 30;

  // draw from the bottom up
  if (con.display !== con.current) {
    // draw arrows to show the buffer is backscrolled
    for (let x = 0; x < conState.con_linewidth; x += 4) renderer.Draw_Character((x + 1) << 3, y, "^".charCodeAt(0));

    y -= 8;
    rows--;
  }

  let row = con.display;
  for (let i = 0; i < rows; i++, y -= 8, row--) {
    if (row < 0) break;
    if (con.current - row >= conState.con_totallines) break; // past scrollback wrap point

    const lineOffset = (row % conState.con_totallines) * conState.con_linewidth;

    for (let x = 0; x < conState.con_linewidth; x++) renderer.Draw_Character((x + 1) << 3, y, con.text[lineOffset + x]);
  }

  // draw the download bar
  const client = clientMod();
  if (client.cls.qw.download) {
    // figure out width
    let text = client.cls.qw.downloadname;
    const slashIdx = text.lastIndexOf("/"); // strrchr(cls.downloadname, '/')
    if (slashIdx !== -1) text = text.slice(slashIdx + 1);

    const barBase = conState.con_linewidth - Math.trunc((conState.con_linewidth * 7) / 40);
    let barWidth = barBase - text.length - 8;
    const third = Math.trunc(conState.con_linewidth / 3);
    let dlbar: string;
    if (text.length > third) {
      barWidth = barBase - third - 11;
      dlbar = text.slice(0, third) + "...";
    } else {
      dlbar = text;
    }
    dlbar += ": ";
    dlbar += "\x80";

    // where's the dot go?
    const percent = client.cls.qw.downloadpercent;
    const n = percent === 0 ? 0 : Math.trunc((barWidth * percent) / 100);

    for (let j = 0; j < barWidth; j++) dlbar += j === n ? "\x83" : "\x81";
    dlbar += "\x82";

    dlbar += Com_sprintf(" %02d%%", percent);

    // draw it
    const barY = conState.con_vislines - 22 + 8;
    for (let i = 0; i < dlbar.length; i++) renderer.Draw_Character((i + 1) << 3, barY, dlbar.charCodeAt(i));
  }

  // draw the input prompt, user text, and cursor if desired
  Con_DrawInput();
}

/*
==================
Con_NotifyBox
==================
*/
export function Con_NotifyBox(text: string): void {
  // during startup for sound / cd warnings -- 1 byte 0x1d, 35 bytes 0x1e, 1
  // byte 0x1f, recounted directly from the C source (see file header).
  const border = "\x1d" + "\x1e".repeat(35) + "\x1f" + "\n";

  Con_Printf("%s", "\n\n" + border);

  Con_Printf("%s", text);

  Con_Printf("Press a key.\n");
  Con_Printf("%s", border);

  const keys = keysMod();
  const clm = clMainMod();
  keys.keyState.key_count = -2; // wait for a key down and up
  keys.keyState.key_dest = keys.KeydestT.key_console;

  do {
    const t1 = Sys_FloatTime();
    screenMod().SCR_UpdateScreen();
    Sys_SendKeyEvents();
    const t2 = Sys_FloatTime();
    clm.clMainState.realtime += t2 - t1; // make the cursor blink
  } while (keys.keyState.key_count < 0);

  Con_Printf("\n");
  keys.keyState.key_dest = keys.KeydestT.key_game;
  clm.clMainState.realtime = 0; // put the cursor back to invisible
}
