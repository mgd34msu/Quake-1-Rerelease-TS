/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/console.h and WinQuake/console.c (GNU GPL v2 or later).

console.c -- the scrollback console buffer, its drawing, and Con_Printf's
print/log/echo family.

This unit (U047) replaces the coordinator's placeholder, which only ported
Con_Printf/Con_DPrintf/Con_SafePrintf's dedicated-early-return shape. Every
exported name and signature the placeholder had stays; everything else is
new.

Deviations from PORTING.md / the C source:
- `con_linewidth`, `con_forcedup`, `con_totallines`, `con_backscroll`,
  `con_current`, `con_x`, `con_initialized`, `con_notifylines`, `con_vislines`
  are all reassigned from multiple call sites, so they become one holder,
  `conState`, per PORTING.md's rule -- and per this unit's brief, with
  exactly these nine field names (keys.ts (U048) already imports `conState`
  with this shape). `con_text` (a raw buffer, only ever reassigned once, by
  Con_Init) and `con_debuglog`/`con_times` (read only inside this file) stay
  outside conState as their own module bindings.
- `con_text` (`char *`) -> `Uint8Array | null`, module-level `let`, allocated
  by Con_Init via `Hunk_AllocName`. C index arithmetic on it is kept exactly
  (PORTING.md's ruling for this unit).
- Import-cycle rule (PORTING.md): console.ts is imported by nearly every
  other module in the tree (directly for Con_Printf, or transitively), so
  ANY module it statically imports back that itself is reachable from a
  chain already passing through a module with risky top-level construction
  (`new SomeClass()` at that module's own top level, not inside a function)
  can deadlock the load order: whichever module started the cycle gets a
  live-but-not-yet-initialized binding for a `class` declaration further down
  in the partner module's body (a `class`, unlike a `function`, is not fully
  bound until its own declaration statement runs), and if that binding is
  used at top level (a field initializer like `datagram: SizeBuf = new
  SizeBuf()`) before the owning module reaches its own declaration, the
  whole graph throws `ReferenceError: Cannot access 'X' before
  initialization`. Two concrete cases were found and reproduced empirically
  (confirmed absent with the coordinator's placeholder console.ts, confirmed
  present the instant this module statically imported the culprit, by
  swapping console.ts for the placeholder and rerunning the suite):
    * `host`/`hostClientHooks` (../common/host): host.ts reaches net_main.ts,
      which constructs `new CvarT(...)` cvars at its own top level. A load
      that reaches this module through cvar.ts (cvar.ts -> this module ->
      host.ts -> net_main.ts -> cvar.ts) hit that `new CvarT(...)` while
      cvar.ts's own `class CvarT` declaration was still in its temporal dead
      zone (cvar.ts was still resolving its own import list, of which this
      module is one entry) -- `ReferenceError: Cannot access 'CvarT' before
      initialization` at net_main.ts.
    * `CactiveT`/`SIGNONS`/`cls` (./client): client.ts reaches server.ts
      (`import { UsercmdT } from "../server/server"`) and constructs `new
      UsercmdT()`/`new SizeBuf()` in its own top-level singletons (`cl`,
      `cls`). A load that reaches this module through sizebuf.ts (sizebuf.ts
      -> this module -> client.ts -> server.ts -> sizebuf.ts, closing back on
      itself) hit that construction while sizebuf.ts's own `class SizeBuf`
      (or server.ts's own classes) were still TDZ'd -- reproduced via
      `bun test test/main_boot.test.ts` alone, which enters through
      server.ts directly.
  Every module this file needs beyond the proven-zero-risk leaves (sys.ts,
  sprintf.ts, vid.ts, screen_types.ts -- none of which import this module,
  directly or transitively) is therefore reached through a lazy `require()`
  (hostMod()/keysMod()/cvarMod()/cmdMod()/zoneMod()/commonMod()/clientMod()/
  renderMod()/menuMod()/sndDmaMod() below), used only inside function
  bodies, never at this module's own top level. host.ts calls Con_Init
  directly (as host.c does) rather than through a hook, because this module
  cannot reach host.ts at load time. `con_notifytime` avoids the
  analogous risk for `CvarT` itself by importing `CvarT` `import type` only
  (fully erased, no runtime edge at all) and building the cvar as a plain
  object literal -- TypeScript's structural typing accepts it in place of
  `new CvarT(...)`.
- `menu.ts` (M_Menu_Main_f, Con_ToggleConsole_f's disconnected branch) and
  `snd_dma.ts` (S_LocalSound, Con_Print's colored-prefix branch) are NOT yet
  landed (concurrent siblings, absent-at-gate rule). Unlike host.ts/keys.ts,
  a static import of a module that does not exist on disk would fail to
  resolve this file entirely -- and console.ts is imported by nearly every
  other module in the tree, so that failure would take down the whole `bun
  test` run, not just this unit's own tests. Both are therefore reached
  through a lazy `require()` (menuMod()/sndDmaMod() below), deferred to the
  actual call inside Con_ToggleConsole_f/Con_Print, so `Cannot find module
  './menu'` / `'./snd_dma'` only surfaces if a test exercises those exact
  branches, per the absent-sibling rule. `SCR_EndLoadingPlaque`/
  `SCR_UpdateScreen` (screen.c, also not landed) go through
  `hostClientHooks.scrEndLoadingPlaque`/`scrUpdateScreen` instead of a direct
  screen.ts import, for the same reason -- host.ts already exports those
  hooks and keys.ts already calls `hostClientHooks.scrUpdateScreen` the same
  way, so this carries zero additional module-resolution risk.
- The `unlink (temp)` in Con_Init (clearing a stale qconsole.log before
  `-condebug` logging starts) has no primitive across sys.ts's file-IO
  boundary (no `Sys_FileDelete`/unlink is exported). Skipped, per this unit's
  ruling: a `-condebug` run appends to whatever qconsole.log a previous run
  left behind instead of truncating it first.
- Con_Printf's dedicated check is `cls.state === ca_dedicated` (the literal
  C condition) OR `sysState.isDedicated` (platform/sys.ts's own dedicated
  flag, which host.ts's Host_FindMaxClients keeps in step with `cls.state`
  but which is the flag this port's other early-return checks generally use)
  -- both are checked, per this unit's brief.
- `Con_DrawInput`'s `text = key_lines[edit_line]; text[key_linepos] = ...`
  writes a temporary cursor character (and space padding) directly into the
  C's fixed 256-byte line buffer, draws it, then overwrites the cursor
  position back to 0 (NUL) to restore the line exactly as it was. Since
  `key_lines` entries are plain immutable strings here (keys.ts's own
  ruling), the equivalent is a local `Uint8Array(MAXCMDLINE)` scratch copy
  built fresh on every call and never written back -- there is nothing to
  "restore" since keys.ts's own state is never touched. `y = con_vislines -
  16;` is computed in the C but never read (the draw loop below it uses the
  literal expression `con_vislines - 16` again, not `y`) -- dead code,
  dropped rather than kept as an unused local.
- `Con_NotifyBox`'s border strings (`"\35\36...\36\37\n"`) are reproduced
  byte-for-byte: 1 byte 0x1d, 35 bytes 0x1e, 1 byte 0x1f, counted directly
  from the C source rather than retyped by eye.
- `S_LocalSound`'s call site in Con_Print (txt[0]==1) and `menuMod().
  M_Menu_Main_f()`/Con_ToggleConsole_f are the two lazy-required absent-sibling
  calls; see above.
- `MAXCMDLINE` (256) is redeclared locally in this file exactly as console.c
  itself does (`#define MAXCMDLINE 256` sits at console.c's own top, a literal
  duplicate of keys.c's private copy of the same macro -- not an import).

QuakeWorld track (`qw.active` fold): `diff -w WinQuake/console.c QW/client/console.c`
(both fully read) shows a genuinely wholesale rewrite -- QW replaces the flat
`con_text`/`con_current`/`con_x`/`con_backscroll`/`con_totallines` globals
with a `console_t` struct (two instances, `con_main`/`con_chat`, selected by
a `con` pointer) plus `Con_ToggleChat_f`/`Key_ClearTyping`/a per-console
`Con_Resize`. That is comfortably past PORTING.md's "~40% of the module
changes" threshold for folding in place (370 of 693 QW lines differ from
WinQuake's 649-line file) and would need its own src/qw/client/console.ts
module -- not attempted in this unit (out of the SCOPE this brief grants;
reported as a follow-up, add to SCOPE for whichever unit picks it up).
Only `Con_Printf`'s own gating logic is folded here, since it is small,
genuinely additive, and the one piece the unit brief's tests exercise
(read directly, both `Con_Printf` bodies in full):
- QW's `Con_Printf` has no `cls.state == ca_dedicated` early return at all
  (WinQuake's/this port's dedicated-mode short-circuit is entirely absent
  from QW/client/console.c's version).
- QW's screen-update condition is `if (cls.state != ca_active)`, not
  WinQuake's `if (cls.signon != SIGNONS && !scr_disabled_for_loading)`.
Everything else in console.c (`Con_ToggleConsole_f`'s `Con_ToggleChat_f`
QW-only sibling, `Con_Resize`/`Con_CheckResize`'s per-console rewrite,
`Con_Print`'s `con->x`/`con_ormask` fields, `Con_Init`'s `con = &con_main`)
is not folded, per the module-creation note above.
*/

import { Sys_Printf, Sys_DebugLog, Sys_SendKeyEvents, Sys_FloatTime, SysError, sysState } from "../platform/sys";
import { qw } from "../common/quakedef";
import { Com_sprintf } from "../common/sprintf";
import type { CvarT } from "../common/cvar";
import type * as CvarModule from "../common/cvar";
import type * as CmdModule from "../common/cmd";
import type * as ZoneModule from "../common/zone";
import type * as CommonModule from "../common/common";
import type * as HostModule from "../common/host";
import type * as ClientModule from "./client";
import type * as RenderModule from "./render";
import { scrState } from "./screen_types";
import { vid } from "./vid";
import type * as KeysModule from "./keys";
import type * as MenuModule from "./menu";
import type * as SndDmaModule from "./snd_dma";

// see the file header's import-cycle note
function cvarMod(): typeof CvarModule {
  return require("../common/cvar");
}
function cmdMod(): typeof CmdModule {
  return require("../common/cmd");
}
function zoneMod(): typeof ZoneModule {
  return require("../common/zone");
}
function commonMod(): typeof CommonModule {
  return require("../common/common");
}
function hostMod(): typeof HostModule {
  return require("../common/host");
}
function clientMod(): typeof ClientModule {
  return require("./client");
}
function renderMod(): typeof RenderModule {
  return require("./render");
}
function keysMod(): typeof KeysModule {
  return require("./keys");
}
function menuMod(): typeof MenuModule {
  return require("./menu");
}
function sndDmaMod(): typeof SndDmaModule {
  return require("./snd_dma");
}

export const CON_TEXTSIZE = 16384;
const NUM_CON_TIMES = 4;
const CON_CURSORSPEED = 4;

/*
The qwcl binary links QW/client/console.c, not this file. Nine modules under
src/qw/ are shared by BOTH QuakeWorld binaries (src/qw/common.ts, cmd.ts,
net_chan.ts, net_udp.ts, pmovetst.ts, src/qw/server/pr_edict.ts, pr_exec.ts)
and import their Con_Printf/Con_DPrintf from here, because qwsv links no
console module at all and the `qw.active` fold in Con_Printf below is what
gives those calls QW's semantics there. In qwcl the same calls have to reach
QW's console instead, or "Playing registered version." and "UDP Initialized"
would go to stdout and to a `con_text` no Con_Init ever allocated, instead of
into `con_main.text` where the C puts them. src/qw/main_cl.ts installs the
three forwards at composition time -- the C's link step; qwsv installs none
and keeps this file's own bodies.
*/
type PrintfFn = (fmt: string, ...args: Array<string | number>) => void;

export const qwConsoleHooks: {
  Con_Printf: PrintfFn | null;
  Con_DPrintf: PrintfFn | null;
  Con_SafePrintf: PrintfFn | null;
} = {
  Con_Printf: null,
  Con_DPrintf: null,
  Con_SafePrintf: null,
};

// reassigned-globals holder -- exactly these nine names, per this unit's
// brief (keys.ts (U048) already imports this shape).
export const conState = {
  con_backscroll: 0, // lines up from bottom to display
  con_totallines: 0, // total lines in console scrollback
  con_forcedup: false, // because no entities to refresh
  con_initialized: false,
  con_notifylines: 0, // scan lines to clear for notify lines
  con_linewidth: 0,
  con_current: 0, // where next message will be printed
  con_x: 0, // offset in current line for next print
  con_vislines: 0,
};

// char *con_text=0; -- allocated once by Con_Init, C index arithmetic kept exact.
export let con_text: Uint8Array | null = null;

// realtime time each line was generated, for the transparent notify overlay.
const con_times = new Float32Array(NUM_CON_TIMES);

let con_debuglog = false;

// cvar_t con_notifytime = {"con_notifytime","3"}; -- see file header: CvarT
// is a type-only import here, so this object literal carries zero runtime
// dependency on cvar.ts's class.
export const con_notifytime: CvarT = {
  name: "con_notifytime",
  string: "3",
  archive: false,
  server: false,
  info: false,
  value: 0,
  next: null,
};

interface DeveloperCvar {
  value: number;
}
let developer: DeveloperCvar | null = null;
export function setDeveloper(cv: DeveloperCvar | null): void {
  developer = cv;
}

/*
================
Con_ToggleConsole_f
================
*/
export function Con_ToggleConsole_f(): void {
  const keys = keysMod();
  const client = clientMod();
  if (keys.keyState.key_dest === keys.KeydestT.key_console) {
    if (client.cls.state === client.CactiveT.ca_connected) {
      keys.keyState.key_dest = keys.KeydestT.key_game;
      keys.key_lines[keys.keyState.edit_line] = keys.key_lines[keys.keyState.edit_line].slice(0, 1); // key_lines[edit_line][1] = 0; -- clear any typing
      keys.keyState.key_linepos = 1;
    } else {
      menuMod().M_Menu_Main_f();
    }
  } else {
    keys.keyState.key_dest = keys.KeydestT.key_console;
  }

  hostMod().hostClientHooks.scrEndLoadingPlaque?.(); // SCR_EndLoadingPlaque
  con_times.fill(0); // memset (con_times, 0, sizeof(con_times))
}

/*
================
Con_Clear_f
================
*/
export function Con_Clear_f(): void {
  if (con_text) con_text.fill(0x20, 0, CON_TEXTSIZE); // Q_memset (con_text, ' ', CON_TEXTSIZE)
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
  keys.keyState.key_dest = keys.KeydestT.key_message;
  keys.keyState.team_message = false;
}

/*
================
Con_MessageMode2_f
================
*/
export function Con_MessageMode2_f(): void {
  const keys = keysMod();
  keys.keyState.key_dest = keys.KeydestT.key_message;
  keys.keyState.team_message = true;
}

/*
================
Con_CheckResize

If the line width has changed, reformat the buffer.
================
*/
export function Con_CheckResize(): void {
  const width = (vid.width >> 3) - 2;

  if (width === conState.con_linewidth) return;

  if (width < 1) {
    // video hasn't been initialized yet
    conState.con_linewidth = 38;
    conState.con_totallines = Math.trunc(CON_TEXTSIZE / conState.con_linewidth);
    if (con_text !== null) con_text.fill(0x20, 0, CON_TEXTSIZE);
  } else {
    const oldwidth = conState.con_linewidth;
    conState.con_linewidth = width;
    const oldtotallines = conState.con_totallines;
    conState.con_totallines = Math.trunc(CON_TEXTSIZE / conState.con_linewidth);
    let numlines = oldtotallines;

    if (conState.con_totallines < numlines) numlines = conState.con_totallines;

    let numchars = oldwidth;

    if (conState.con_linewidth < numchars) numchars = conState.con_linewidth;

    if (con_text !== null) {
      const tbuf = con_text.slice(0, CON_TEXTSIZE);
      con_text.fill(0x20, 0, CON_TEXTSIZE);

      for (let i = 0; i < numlines; i++) {
        for (let j = 0; j < numchars; j++) {
          con_text[(conState.con_totallines - 1 - i) * conState.con_linewidth + j] =
            tbuf[((conState.con_current - i + oldtotallines) % oldtotallines) * oldwidth + j];
        }
      }
    }

    Con_ClearNotify();
  }

  conState.con_backscroll = 0;
  conState.con_current = conState.con_totallines - 1;
}

/*
================
Con_Init
================
*/
export function Con_Init(): void {
  const MAXGAMEDIRLEN = 1000;
  const t2 = "/qconsole.log";
  const common = commonMod();

  con_debuglog = common.COM_CheckParm("-condebug") !== 0;

  if (con_debuglog) {
    if (common.com_gamedir.length < MAXGAMEDIRLEN - t2.length) {
      // sprintf (temp, "%s%s", com_gamedir, t2); unlink (temp); -- see file
      // header: no unlink primitive crosses sys.ts's file-IO boundary.
    }
  }

  con_text = zoneMod().Hunk_AllocName(CON_TEXTSIZE, "context");
  con_text.fill(0x20, 0, CON_TEXTSIZE); // Q_memset (con_text, ' ', CON_TEXTSIZE)
  conState.con_linewidth = -1;
  Con_CheckResize();

  Con_Printf("Console initialized.\n");

  //
  // register our commands
  //
  cvarMod().Cvar_RegisterVariable(con_notifytime);

  const cmd = cmdMod();
  cmd.Cmd_AddCommand("toggleconsole", Con_ToggleConsole_f);
  cmd.Cmd_AddCommand("messagemode", Con_MessageMode_f);
  cmd.Cmd_AddCommand("messagemode2", Con_MessageMode2_f);
  cmd.Cmd_AddCommand("clear", Con_Clear_f);
  conState.con_initialized = true;
}

/*
===============
Con_Linefeed
===============
*/
export function Con_Linefeed(): void {
  conState.con_x = 0;
  conState.con_current++;
  if (con_text === null) return; // defensive; con_text is allocated by Con_Init before this can run
  const offset = (conState.con_current % conState.con_totallines) * conState.con_linewidth;
  con_text.fill(0x20, offset, offset + conState.con_linewidth);
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
  conState.con_backscroll = 0;

  let idx = 0;
  let mask = 0;
  if (rawTxt.charCodeAt(0) === 1) {
    mask = 128; // go to colored text
    sndDmaMod().S_LocalSound("misc/talk.wav"); // play talk wav
    idx = 1;
  } else if (rawTxt.charCodeAt(0) === 2) {
    mask = 128; // go to colored text
    idx = 1;
  }

  if (con_text === null) return; // defensive; con_text is allocated by Con_Init before this can run
  const text = con_text;

  let c: number;
  while ((c = idx < rawTxt.length ? rawTxt.charCodeAt(idx) : 0) !== 0) {
    // count word length
    let l = 0;
    for (; l < conState.con_linewidth; l++) {
      const ch = idx + l < rawTxt.length ? rawTxt.charCodeAt(idx + l) : 0;
      if (ch <= 32 /* ' ' */) break;
    }

    // word wrap
    if (l !== conState.con_linewidth && conState.con_x + l > conState.con_linewidth) conState.con_x = 0;

    idx++;

    if (cr) {
      conState.con_current--;
      cr = false;
    }

    if (!conState.con_x) {
      Con_Linefeed();
      // mark time for transparent overlay
      if (conState.con_current >= 0) con_times[conState.con_current % NUM_CON_TIMES] = hostMod().host.realtime;
    }

    switch (c) {
      case 10 /* '\n' */:
        conState.con_x = 0;
        break;

      case 13 /* '\r' */:
        conState.con_x = 0;
        cr = true;
        break;

      default: {
        // display character and advance
        const y = conState.con_current % conState.con_totallines;
        text[y * conState.con_linewidth + conState.con_x] = c | mask;
        conState.con_x++;
        if (conState.con_x >= conState.con_linewidth) conState.con_x = 0;
        break;
      }
    }
  }
}

/*
================
Con_DebugLog
================
*/
export function Con_DebugLog(file: string, fmt: string, ...args: Array<string | number>): void {
  // vsprintf(data, fmt, argptr); open/write/close -- Sys_DebugLog already
  // does exactly this (see its own file header).
  Sys_DebugLog(file, fmt, ...args);
}

/*
================
Con_Printf

Handles cursor positioning, line wrapping, etc
================
*/
let inupdate = false; // static qboolean inupdate; in the C

export function Con_Printf(fmt: string, ...args: Array<string | number>): void {
  const qwcl = qwConsoleHooks.Con_Printf; // see qwConsoleHooks
  if (qwcl) return qwcl(fmt, ...args);

  const msg = Com_sprintf(fmt, ...args);

  // also echo to debugging console
  Sys_Printf("%s", msg);

  // log all messages to file
  if (con_debuglog) Con_DebugLog(Com_sprintf("%s/qconsole.log", commonMod().com_gamedir), "%s", msg);

  if (!conState.con_initialized) return;

  const client = clientMod();

  if (!qw.active) {
    // cls.state == ca_dedicated in the C; sysState.isDedicated (platform/sys.ts)
    // is also checked -- see file header. QW/client/console.c's Con_Printf has
    // no such early return at all -- see this file's QuakeWorld track note.
    if (client.cls.state === client.CactiveT.ca_dedicated || sysState.isDedicated) return; // no graphics mode
  }

  // write it to the scrollable buffer
  Con_Print(msg);

  // update the screen if the console is displayed
  const shouldUpdate = qw.active
    ? client.cls.state !== client.CactiveT.ca_active // QW: `if (cls.state != ca_active)`
    : client.cls.signon !== client.SIGNONS && !scrState.scr_disabled_for_loading;

  if (shouldUpdate) {
    // protect against infinite loop if something in SCR_UpdateScreen calls Con_Printf
    if (!inupdate) {
      inupdate = true;
      try {
        hostMod().hostClientHooks.scrUpdateScreen?.(); // SCR_UpdateScreen
      } catch (err) {
        // Not in the C: a renderer-not-loaded state (VID_Shutdown already
        // ran, or never ran yet) has no counterpart there -- the C's
        // screen-update calls always have a live video mode to draw into
        // once host_initialized is true. This port can reach Con_Printf
        // with `re.current === null` (a shutdown-path or startup-path
        // print racing the renderer's lifetime, e.g. an error raised while
        // NET_Init's async bind is still resolving), where SCR_UpdateScreen's
        // own call chain reaches render.ts's getRenderer() and throws a
        // fresh "No renderer is loaded" Sys_Error instead of drawing. The
        // real engine always prints to stdout regardless of video state
        // (Sys_Printf above already ran unconditionally); matching that
        // means swallowing only this one specific failure of the screen
        // draw step, not the print itself -- anything else escaping
        // SCR_UpdateScreen is a real bug and still propagates.
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
  const qwcl = qwConsoleHooks.Con_DPrintf; // see qwConsoleHooks
  if (qwcl) return qwcl(fmt, ...args);

  if (!developer || !developer.value) return; // don't confuse non-developers with techie stuff...

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
  const qwcl = qwConsoleHooks.Con_SafePrintf; // see qwConsoleHooks
  if (qwcl) return qwcl(fmt, ...args);

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
  if (keys.keyState.key_dest !== keys.KeydestT.key_console && !conState.con_forcedup) return; // don't draw anything

  const line = keys.key_lines[keys.keyState.edit_line];
  const linepos = keys.keyState.key_linepos;

  // text = key_lines[edit_line]; -- a local scratch copy stands in for the
  // C's direct char* into that fixed 256-byte buffer (see file header).
  const scratch = new Uint8Array(MAXCMDLINE);
  for (let i = 0; i < line.length && i < MAXCMDLINE; i++) scratch[i] = line.charCodeAt(i) & 0xff;

  // add the cursor frame
  if (linepos < MAXCMDLINE) scratch[linepos] = 10 + (Math.trunc(hostMod().host.realtime * CON_CURSORSPEED) & 1);

  // fill out remainder with spaces
  for (let i = linepos + 1; i < conState.con_linewidth && i < MAXCMDLINE; i++) scratch[i] = 0x20;

  // prestep if horizontally scrolling
  let base = 0;
  if (linepos >= conState.con_linewidth) base = 1 + linepos - conState.con_linewidth;

  // draw it
  const renderer = renderMod().getRenderer();
  for (let i = 0; i < conState.con_linewidth; i++) renderer.Draw_Character((i + 1) << 3, conState.con_vislines - 16, scratch[base + i] ?? 0);

  // remove cursor -- nothing to restore: `scratch` is a local drawing
  // buffer, never written back into key_lines.
}

/*
================
Con_DrawNotify

Draws the last few lines of output transparently over the game top
================
*/
export function Con_DrawNotify(): void {
  let v = 0;

  if (con_text !== null) {
    const renderer = renderMod().getRenderer();
    const host = hostMod().host;
    for (let i = conState.con_current - NUM_CON_TIMES + 1; i <= conState.con_current; i++) {
      if (i < 0) continue;
      let time = con_times[i % NUM_CON_TIMES];
      if (time === 0) continue;
      time = host.realtime - time;
      if (time > con_notifytime.value) continue;

      const lineOffset = (i % conState.con_totallines) * conState.con_linewidth;

      scrState.clearnotify = 0;
      scrState.scr_copytop = 1;

      for (let x = 0; x < conState.con_linewidth; x++) renderer.Draw_Character((x + 1) << 3, v, con_text[lineOffset + x]);

      v += 8;
    }
  }

  const keys = keysMod();
  if (keys.keyState.key_dest === keys.KeydestT.key_message) {
    scrState.clearnotify = 0;
    scrState.scr_copytop = 1;

    const renderer = renderMod().getRenderer();
    renderer.Draw_String(8, v, "say:");

    let x = 0;
    const chat = keys.keyState.chat_buffer;
    while (x < chat.length && chat.charCodeAt(x) !== 0) {
      renderer.Draw_Character((x + 5) << 3, v, chat.charCodeAt(x));
      x++;
    }
    renderer.Draw_Character((x + 5) << 3, v, 10 + (Math.trunc(hostMod().host.realtime * CON_CURSORSPEED) & 1));
    v += 8;
  }

  if (v > conState.con_notifylines) conState.con_notifylines = v;
}

/*
================
Con_DrawConsole

Draws the console with the solid background
The typing input line at the bottom should only be drawn if typing is allowed
================
*/
export function Con_DrawConsole(lines: number, drawinput: boolean): void {
  if (lines <= 0) return;

  const renderer = renderMod().getRenderer();

  // draw the background
  renderer.Draw_ConsoleBackground(lines);

  // draw the text
  conState.con_vislines = lines;

  const rows = (lines - 16) >> 3; // rows of text to draw
  let y = lines - 16 - (rows << 3); // may start slightly negative

  if (con_text !== null) {
    const text = con_text;
    for (let i = conState.con_current - rows + 1; i <= conState.con_current; i++, y += 8) {
      let j = i - conState.con_backscroll;
      if (j < 0) j = 0;
      const lineOffset = (j % conState.con_totallines) * conState.con_linewidth;

      for (let x = 0; x < conState.con_linewidth; x++) renderer.Draw_Character((x + 1) << 3, y, text[lineOffset + x]);
    }
  }

  // draw the input prompt, user text, and cursor if desired
  if (drawinput) Con_DrawInput();
}

/*
==================
Con_NotifyBox
==================
*/
export function Con_NotifyBox(text: string): void {
  // during startup for sound / cd warnings -- 1 byte 0x1d, 35 bytes 0x1e, 1
  // byte 0x1f, counted directly from the C source (see file header).
  const border = "\n\n" + "\x1d" + "\x1e".repeat(35) + "\x1f" + "\n";

  Con_Printf("%s", border);

  Con_Printf("%s", text);

  Con_Printf("Press a key.\n");
  Con_Printf("%s", "\x1d" + "\x1e".repeat(35) + "\x1f" + "\n");

  const keys = keysMod();
  const h = hostMod();
  keys.keyState.key_count = -2; // wait for a key down and up
  keys.keyState.key_dest = keys.KeydestT.key_console;

  do {
    const t1 = Sys_FloatTime();
    h.hostClientHooks.scrUpdateScreen?.(); // SCR_UpdateScreen
    Sys_SendKeyEvents();
    const t2 = Sys_FloatTime();
    h.host.realtime += t2 - t1; // make the cursor blink
  } while (keys.keyState.key_count < 0);

  Con_Printf("\n");
  keys.keyState.key_dest = keys.KeydestT.key_game;
  h.host.realtime = 0; // put the cursor back to invisible
}

