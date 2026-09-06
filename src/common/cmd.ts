/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cmd.h and WinQuake/cmd.c (GNU GPL v2 or later).

cmd.c -- Quake script command processing module

No #ifdef/#if 0 blocks exist in cmd.c or cmd.h to drop; every line here is a
straight port.

Deviations from PORTING.md / the C source:
- `cmd_source_t` -> `CmdSourceT` enum; the `cmd_source` global and `cmd_wait`
  both live on one holder, `cmdState = { source, wait }`, per this unit's
  brief.
- `cmdalias_t` and the internal `cmd_function_t` are plain classes held in
  arrays (`cmd_alias`, `cmd_functions`) that are `unshift`ed on registration,
  reproducing the C linked list's prepend order (`a->next = cmd_alias;
  cmd_alias = a;`), so `alias` with no arguments lists newest first exactly
  as the C does.
- `Cmd_TokenizeString`/COM_Parse: C walks a raw `char *`; here a `ParseState`
  ({ data, index }, from ./common) plays that role. `Z_Malloc`/`Z_Free` for
  the old `cmd_argv` entries have no TS equivalent (`cmd_argv = []` frees the
  same way GC does); the call sites they bracketed are otherwise unchanged.
- `Cbuf_AddText`/`Cbuf_InsertText`/`Cbuf_Execute` operate on a `SizeBuf`
  (./sizebuf, U003) whose `data` is raw bytes. Per this unit's ruling, text
  crosses that boundary as Latin-1 bytes (`charCodeAt & 0xff` / `fromCharCode`),
  never UTF-8, so byte offsets/lengths inside cmd_text match the C exactly for
  the ASCII command text Quake actually pushes through it.
- `Cbuf_InsertText`'s C body routes the leftover buffer through `Z_Malloc`/
  `Q_memcpy`/`Z_Free`; ported as a direct `Uint8Array.slice`, which is the
  same "copy out, clear, write text, write copy back" sequence without the
  separate allocator (PORTING.md: Z_Malloc/Z_Free are plain allocation with
  no observable behavior beyond the copy itself).
- `Cmd_Exec_f`: `Hunk_LowMark`/`Hunk_FreeToLowMark` (./zone) are called in
  the same order as the C, including *not* calling `Hunk_FreeToLowMark` on
  the "couldn't exec" failure path -- that asymmetry is in the original and
  is preserved exactly as the C has it. `COM_LoadHunkFile`'s
  buffer carries one trailing NUL byte (common.ts's ruling); it is trimmed
  before the bytes are decoded, matching the C's `Cbuf_InsertText(f)` running
  through `Q_strlen` and stopping short of that NUL.
- `Cmd_Alias_f`'s argument-join loop has `if (i != c)` where `i` never
  reaches `c` inside the loop body, so the C appends a trailing space after
  *every* argument, including the last, before the final `\n` is appended.
  That is preserved here verbatim (not "fixed" to match the more common
  space-between-tokens idiom).
- `Cmd_CheckParm`'s `if (!parm) Sys_Error(...)` guards a C `NULL` that TS's
  `string` parameter type cannot carry; the parameter is typed non-nullable
  and the guard is dropped as unreachable under that typing.
- `trashtest`/`trashspot` (`int trashtest; int *trashspot;`) are file-scope
  globals in the C that no function in cmd.c ever reads or writes; they are
  omitted as dead declarations rather than ported as unused holders.
- `Q_strcasecmp` (used for case-insensitive command/alias/parm lookups) is a
  small local helper here rather than an import from ./common, since cmd.h's
  contract does not require it and this unit's brief does not rule its
  ./common export shape; `Q_strcmp`/`Q_strncmp` call sites become direct `===`
  / `startsWith` since JS string equality already does what those C helpers
  did for cmd.c's case-sensitive comparisons.
- `Cmd_ForwardToServer`'s real body lives in `cls` (client.h), which does not
  exist yet. Per this unit's ruling it is a registrable hook: the handler set
  by `setForwardToServerHandler` runs if present, else the function prints
  the C's "Can't \"%s\", not connected" fallback. cl_main.ts (U041) is the
  intended registrant.
- `host_initialized` (host.c) is read by `Cmd_AddCommand`; per this unit's
  ruling it is the holder `cmdHost = { initialized: false }`, set by host.ts
  once it exists.
- QuakeWorld track (Task 2, 2026-09-05): QW/client/cmd.c duplicated three of
  this file's functions only to change one small, additive thing each; all
  three are folded here under the `qw.active` runtime flag (PORTING.md:
  "small deltas fold into the landed module under qw.active") instead of
  being kept as separate forks in src/qw/cmd.ts, so that the Cmd_ExecuteString
  /Cvar_Command path every registered command (WinQuake or QW) goes through
  behaves as QW when qw.active:
  - `Cbuf_InsertText`: QW/client/cmd.c's body is WinQuake's plus one extra
    line, `SZ_Write (&cmd_text, "\n", 1)`, right after `Cbuf_AddText (text)`
    -- equivalent to appending "\n" to `text` itself before the one call,
    since nothing reads `cmd_text` in between.
  - `Cmd_StuffCmds_f`: QW has no `if (Cmd_Argc() != 1)` guard (added later in
    retail WinQuake); skipped when qw.active.
  - `Cmd_ExecuteString`: QW gates the final "Unknown command" print behind
    `!Cvar_Command() && (cl_warncmd.value || developer.value)` instead of
    printing unconditionally. `cl_warncmd` (QW/client/cmd.c, ported at
    src/qw/cmd.ts) is declared but never registered anywhere in the QW client
    tree -- a preserved bug (see that file's header) -- so its value is
    permanently 0 and the gate reduces to `developer.value`; referencing
    `cl_warncmd` itself here would also mean this shared module reaching
    backward into a QuakeWorld-track-only module, which breaks this port's
    layering (qw/* depends on common/*, never the reverse). `developer`
    (src/common/host.ts) is reached through a lazy `require()`
    (`hostMod()` below), the same cycle-breaking idiom src/common/common.ts's
    `cvarMod()` already uses, since host.ts statically imports this module's
    `Cmd_Init`/`Cbuf_*` (a real cycle a top-level import would deadlock).
  `Cmd_ForwardToServer` is not folded: it stays hook-based, as it already is
  (`setForwardToServerHandler`); QW's own `Cmd_ForwardToServer`/
  `Cmd_ForwardToServer_f` (src/qw/cmd.ts) write directly into a netchan
  SizeBuf via their own `qwCmdHooks`, a structurally different mechanism, not
  a one-line delta. `Cmd_Exec_f`'s analogous print-gate difference (QW gates
  "execing %s\n" the same way) is also not folded -- src/qw/cmd.ts's own
  `Cmd_Exec_f` already ports it faithfully as its own fork, and the unit
  brief names only the three functions above.
*/

import { SizeBuf, SZ_Alloc, SZ_Clear, SZ_Write } from "./sizebuf";
import { COM_Parse, type ParseState, com_argc, com_argv, COM_LoadHunkFile } from "./common";
import { Cvar_Command, Cvar_VariableString } from "./cvar";
import { Hunk_LowMark, Hunk_FreeToLowMark } from "./zone";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import { qw } from "./quakedef";
import type * as HostModule from "./host";

// see file header's QuakeWorld-track deviation note: host.ts statically
// imports this module, so this module cannot statically import host.ts back
// without deadlocking the load order; reached lazily, only inside
// Cmd_ExecuteString, well after both modules have finished loading.
function hostMod(): typeof HostModule {
  return require("./host");
}

// mirrors common.c's Q_strcasecmp: case-insensitive comparison, used only
// for its ===0 result throughout this file, same as every C call site.
function Q_strcasecmp(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

function stringToLatin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function latin1BytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export type XCommandT = () => void;

export enum CmdSourceT {
  src_client, // came in over a net connection as a clc_stringcmd
  // host_client will be valid during this state.
  src_command, // from the command buffer
}

export const cmdState = { source: CmdSourceT.src_command, wait: false };

// host_initialized (host.c); host.ts sets this once it exists.
export const cmdHost = { initialized: false, rendererSwitch: false };

//=============================================================================
//
//						COMMAND BUFFER
//
//=============================================================================

const cmd_text = new SizeBuf();

// Causes execution of the remainder of the command buffer to be delayed until
// next frame.  This allows commands like:
// bind g "impulse 5 ; +attack ; wait ; -attack ; impulse 2"
export function Cmd_Wait_f(): void {
  cmdState.wait = true;
}

// allocates an initial text buffer that will grow as needed
export function Cbuf_Init(): void {
  SZ_Alloc(cmd_text, 8192); // space for commands and script files
}

// Adds command text at the end of the buffer
export function Cbuf_AddText(text: string): void {
  const l = text.length;

  if (cmd_text.cursize + l >= cmd_text.maxsize) {
    Con_Printf("Cbuf_AddText: overflow\n");
    return;
  }

  SZ_Write(cmd_text, stringToLatin1Bytes(text), text.length);
}

// Adds command text immediately after the current command
// Adds a \n to the text
// FIXME: actually change the command buffer to do less copying
export function Cbuf_InsertText(text: string): void {
  // copy off any commands still remaining in the exec buffer
  const templen = cmd_text.cursize;
  let temp: Uint8Array | null = null;
  if (templen) {
    temp = cmd_text.data.slice(0, templen);
    SZ_Clear(cmd_text);
  } else {
    temp = null; // shut up compiler
  }

  // add the entire text of the file
  // QW/client/cmd.c appends an extra "\n" after the text itself -- folded
  // under qw.active, see file header.
  Cbuf_AddText(qw.active ? `${text}\n` : text);

  // add the copied off data
  if (templen && temp) {
    SZ_Write(cmd_text, temp, templen);
  }
}

export function Cbuf_Execute(): void {
  while (cmd_text.cursize) {
    // find a \n or ; line break
    const text = cmd_text.data;

    let quotes = 0;
    let i = 0;
    for (; i < cmd_text.cursize; i++) {
      if (text[i] === 0x22 /* '"' */) quotes++;
      if (!(quotes & 1) && text[i] === 0x3b /* ';' */) break; // don't break if inside a quoted string
      if (text[i] === 0x0a /* '\n' */) break;
    }

    const line = latin1BytesToString(text.subarray(0, i));

    // delete the text from the command buffer and move remaining commands down
    // this is necessary because commands (exec, alias) can insert data at the
    // beginning of the text buffer
    if (i === cmd_text.cursize) {
      cmd_text.cursize = 0;
    } else {
      i++;
      cmd_text.cursize -= i;
      cmd_text.data.copyWithin(0, i, i + cmd_text.cursize);
    }

    // execute the command line
    Cmd_ExecuteString(line, CmdSourceT.src_command);

    if (cmdState.wait) {
      // skip out while text still remains in buffer, leaving it
      // for next frame
      cmdState.wait = false;
      break;
    }
  }
}

//==============================================================================
//
//						SCRIPT COMMANDS
//
//==============================================================================

// Adds command line parameters as script statements
// Commands lead with a +, and continue until a - or another +
// quake +prog jctest.qp +cmd amlev1
// quake -nosound +cmd amlev1
export function Cmd_StuffCmds_f(): void {
  // QW/client/cmd.c has no such guard (added later in retail WinQuake) --
  // folded under qw.active, see file header.
  if (!qw.active && Cmd_Argc() !== 1) {
    Con_Printf("stuffcmds : execute command line parameters\n");
    return;
  }

  // build the combined string to parse from
  let text = "";
  for (let i = 1; i < com_argc; i++) {
    if (com_argv[i] == null) continue; // NEXTSTEP nulls out -NXHost
    text += com_argv[i];
    if (i !== com_argc - 1) text += " ";
  }
  if (!text.length) return;

  // pull out the commands
  let build = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "+") {
      i++;

      let j = i;
      for (; j < text.length && text[j] !== "+" && text[j] !== "-"; j++);

      build += text.slice(i, j);
      build += "\n";
      i = j - 1;
    }
  }

  if (build.length) Cbuf_InsertText(build);
}

export function Cmd_Exec_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("exec <filename> : execute a script file\n");
    return;
  }

  const mark = Hunk_LowMark();
  const f = COM_LoadHunkFile(Cmd_Argv(1));
  if (!f) {
    Con_Printf("couldn't exec %s\n", Cmd_Argv(1));
    return;
  }
  Con_Printf("execing %s\n", Cmd_Argv(1));

  // f carries one trailing NUL byte (common.ts's COM_LoadHunkFile ruling);
  // drop it so Cbuf_InsertText sees exactly what the C's Q_strlen(f) would.
  const text = latin1BytesToString(f.subarray(0, f.length - 1));
  Cbuf_InsertText(text);
  Hunk_FreeToLowMark(mark);
}

// Just prints the rest of the line to the console
export function Cmd_Echo_f(): void {
  for (let i = 1; i < Cmd_Argc(); i++) Con_Printf("%s ", Cmd_Argv(i));
  Con_Printf("\n");
}

const MAX_ALIAS_NAME = 32;

class CmdAliasT {
  name: string;
  value: string;
  constructor(name: string, value: string) {
    this.name = name;
    this.value = value;
  }
}

// prepended on registration, same order as the C's `a->next = cmd_alias;
// cmd_alias = a;` -- newest alias first.
const cmd_alias: CmdAliasT[] = [];

// Creates a new command that executes a command string (possibly ; seperated)
export function Cmd_Alias_f(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("Current alias commands:\n");
    for (const a of cmd_alias) Con_Printf("%s : %s\n", a.name, a.value);
    return;
  }

  const s = Cmd_Argv(1);
  if (s.length >= MAX_ALIAS_NAME) {
    Con_Printf("Alias name is too long\n");
    return;
  }

  // if the alias allready exists, reuse it
  let a: CmdAliasT | null = null;
  for (const existing of cmd_alias) {
    if (s === existing.name) {
      a = existing;
      break;
    }
  }

  if (!a) {
    a = new CmdAliasT(s, "");
    cmd_alias.unshift(a);
  }
  a.name = s;

  // copy the rest of the command line
  let cmd = ""; // start out with a null string
  const c = Cmd_Argc();
  for (let i = 2; i < c; i++) {
    cmd += Cmd_Argv(i);
    // C's `if (i != c)` never trips false inside this loop (i stops at
    // c-1), so a space follows every argument, including the last one.
    cmd += " ";
  }
  cmd += "\n";

  a.value = cmd;
}

//=============================================================================
//
//					COMMAND EXECUTION
//
//=============================================================================

const MAX_ARGS = 80;

class CmdFunctionT {
  name: string;
  fn: XCommandT;
  constructor(name: string, fn: XCommandT) {
    this.name = name;
    this.fn = fn;
  }
}

let cmd_argc = 0;
let cmd_argv: string[] = [];
let cmd_args: string | null = null;

// prepended on registration, same order as the C's linked list.
const cmd_functions: CmdFunctionT[] = [];

export function Cmd_Init(): void {
  // register our commands
  Cmd_AddCommand("stuffcmds", Cmd_StuffCmds_f);
  Cmd_AddCommand("exec", Cmd_Exec_f);
  Cmd_AddCommand("echo", Cmd_Echo_f);
  Cmd_AddCommand("alias", Cmd_Alias_f);
  Cmd_AddCommand("cmd", Cmd_ForwardToServer);
  Cmd_AddCommand("wait", Cmd_Wait_f);
}

export function Cmd_Argc(): number {
  return cmd_argc;
}

export function Cmd_Argv(arg: number): string {
  if (arg < 0 || arg >= cmd_argc) return "";
  return cmd_argv[arg] ?? "";
}

export function Cmd_Args(): string | null {
  return cmd_args;
}

function charAt0(ps: ParseState): number {
  return ps.index < ps.data.length ? ps.data.charCodeAt(ps.index) : 0;
}

// Parses the given string into command line tokens.
export function Cmd_TokenizeString(text: string): void {
  // clear the args from the last string
  cmd_argc = 0;
  cmd_argv = [];
  cmd_args = null;

  const ps: ParseState = { data: text, index: 0 };

  for (;;) {
    // skip whitespace up to a /n
    for (;;) {
      const c = charAt0(ps);
      if (c !== 0 && c <= 32 /* ' ' */ && c !== 10 /* '\n' */) ps.index++;
      else break;
    }

    if (charAt0(ps) === 10 /* '\n' */) {
      // a newline seperates commands in the buffer
      ps.index++;
      break;
    }

    if (charAt0(ps) === 0) return;

    if (cmd_argc === 1) cmd_args = ps.data.slice(ps.index);

    const token = COM_Parse(ps);
    if (token === null) return;

    if (cmd_argc < MAX_ARGS) {
      cmd_argv[cmd_argc] = token;
      cmd_argc++;
    }
  }
}

// called by the init functions of other parts of the program to
// register commands and functions to call for them.
// The cmd_name is referenced later, so it should not be in temp memory
export function Cmd_AddCommand(cmd_name: string, fn: XCommandT): void {
  // Port deviation: a runtime renderer switch (`vid_restart`, the port's own
  // feature -- the C's renderers are separate binaries) re-runs R_Init after
  // host init; VID_CheckChanges opens `cmdHost.rendererSwitch` for that
  // window so the new renderer's commands register and replace the old
  // renderer's functions of the same name.
  if (cmdHost.initialized && !cmdHost.rendererSwitch) Sys_Error("Cmd_AddCommand after host_initialized"); // because hunk allocation would get stomped

  // fail if the command is a variable name
  if (Cvar_VariableString(cmd_name).length > 0) {
    Con_Printf("Cmd_AddCommand: %s already defined as a var\n", cmd_name);
    return;
  }

  // fail if the command already exists
  for (const cmd of cmd_functions) {
    if (cmd_name === cmd.name) {
      if (cmdHost.rendererSwitch) {
        cmd.fn = fn; // the previous renderer's function must not survive the switch
        return;
      }
      Con_Printf("Cmd_AddCommand: %s already defined\n", cmd_name);
      return;
    }
  }

  cmd_functions.unshift(new CmdFunctionT(cmd_name, fn));
}

// used by the cvar code to check for cvar / command name overlap
export function Cmd_Exists(cmd_name: string): boolean {
  for (const cmd of cmd_functions) {
    if (cmd_name === cmd.name) return true;
  }
  return false;
}

// attempts to match a partial command for automatic command line completion
export function Cmd_CompleteCommand(partial: string): string | null {
  const len = partial.length;

  if (!len) return null;

  // check functions
  for (const cmd of cmd_functions) {
    if (cmd.name.slice(0, len) === partial) return cmd.name;
  }

  return null;
}

// A complete command line has been parsed, so try to execute it
// FIXME: lookupnoadd the token to speed search?
export function Cmd_ExecuteString(text: string, src: CmdSourceT): void {
  cmdState.source = src;
  Cmd_TokenizeString(text);

  // execute the command line
  if (!Cmd_Argc()) return; // no tokens

  // check functions
  for (const cmd of cmd_functions) {
    if (Q_strcasecmp(Cmd_Argv(0), cmd.name) === 0) {
      cmd.fn();
      return;
    }
  }

  // check alias
  for (const a of cmd_alias) {
    if (Q_strcasecmp(Cmd_Argv(0), a.name) === 0) {
      Cbuf_InsertText(a.value);
      return;
    }
  }

  // check cvars
  if (!Cvar_Command()) {
    // QW/client/cmd.c gates this print behind `cl_warncmd.value ||
    // developer.value` instead of printing unconditionally -- folded under
    // qw.active as `developer.value` alone, see file header.
    if (qw.active) {
      if (hostMod().developer.value) Con_Printf('Unknown command "%s"\n', Cmd_Argv(0));
    } else {
      Con_Printf('Unknown command "%s"\n', Cmd_Argv(0));
    }
  }
}

// the C's cls-reaching body moves to cl_main.ts (U041), which registers
// itself here; until then this prints the "not connected" fallback exactly
// as the C does when cls.state != ca_connected.
let forwardToServerHandler: (() => void) | null = null;
export function setForwardToServerHandler(fn: (() => void) | null): void {
  forwardToServerHandler = fn;
}

// Sends the entire command line over to the server
export function Cmd_ForwardToServer(): void {
  if (forwardToServerHandler) {
    forwardToServerHandler();
    return;
  }

  Con_Printf('Can\'t "%s", not connected\n', Cmd_Argv(0));
}

// Returns the position (1 to argc-1) in the command's argument list
// where the given parameter apears, or 0 if not present
export function Cmd_CheckParm(parm: string): number {
  for (let i = 1; i < Cmd_Argc(); i++) {
    if (Q_strcasecmp(parm, Cmd_Argv(i)) === 0) return i;
  }

  return 0;
}
