/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cmd.h and QW/client/cmd.c (GNU GPL v2 or later),
diffed against the landed WinQuake/cmd.h and WinQuake/cmd.c port
(src/common/cmd.ts).

QW cmd.c predates several changes retail WinQuake's cmd.c later picked up
(`cmd_source_t`, `Cmd_Print`, the `Cmd_Argc() != 1` guard in
`Cmd_StuffCmds_f`) -- `diff -w QW/client/cmd.c WinQuake/cmd.c` reads as if
WinQuake is the newer file, which it is; QW's tree forked from an earlier
snapshot. `src/qw/cmd.ts` is its own module over the same command/alias
registry and command-text buffer src/common/cmd.ts owns (one shared list and
buffer for the whole process: every already-landed subsystem registers its
commands through src/common/cmd.ts's `Cmd_AddCommand`, and `Cbuf_Execute`
that src/common/cmd.ts owns must keep seeing all of them).

Re-export table (identical between QW cmd.c and WinQuake cmd.c bodies, or
differing only in a `cmd_source_t` parameter this port's brief already drops
from the shared module -- verified against `diff -w QW/client/cmd.c
WinQuake/cmd.c`):
  Cmd_Argc, Cmd_Argv, Cmd_Args, Cmd_TokenizeString, Cmd_AddCommand,
  Cmd_Exists, Cmd_CompleteCommand, Cmd_CheckParm, Cbuf_Init, Cbuf_AddText,
  Cbuf_Execute, Cmd_Echo_f, Cmd_Alias_f, Cmd_Wait_f, setForwardToServerHandler

Corrected 2026-09-05 (Task 2): `Cbuf_InsertText` and `Cmd_StuffCmds_f` are now
also re-exports -- src/common/cmd.ts folded both small deltas under the
`qw.active` runtime flag (see that file's header), closing the "known
integration gap" this file's header used to document for `Cmd_ExecuteString`'s
"Unknown command" print gate too (that gate now also lives in the shared
`Cmd_ExecuteString`, gated on `developer.value` under qw.active -- see
src/common/cmd.ts's header for why `cl_warncmd` itself is not part of that
fold). Cvar_Command()'s userinfo/serverinfo-hook half of the same gap is
independently closed by Task 2's cvar `info` correction, which folded QW's
`Cvar_Set` into src/common/cvar.ts the same way.

Ported fresh (QW behavior genuinely differs from WinQuake's landed cmd.c,
with no shared counterpart to fold into, or a mechanism this port has ruled
hook-based instead):
  Cmd_Exec_f, Cmd_ForwardToServer, Cmd_ForwardToServer_f, Cmd_Init, cl_warncmd

Deviations from PORTING.md / the C source:
- `cmd_source_t`/`cmd_source` do not exist in QW's cmd.h/cmd.c at all (see
  above); `Cmd_ExecuteString(char *text)` takes one argument in QW, two in
  WinQuake. `Cmd_ExecuteString` below is a thin wrapper over
  src/common/cmd.ts's exported `Cmd_ExecuteString(text, CmdSourceT.src_command)`
  restoring QW's one-argument signature; with the fold above, this now *is*
  the function that behaves like QW's own when qw.active, not just a call-
  shape convenience.
- `Cmd_Exec_f`: QW gates the "execing %s\n" print behind `!Cvar_Command() &&
  (cl_warncmd.value || developer.value)` instead of printing unconditionally.
  `Cvar_Command()` here checks `Cmd_Argv(0)` ("exec") against `cvar_vars`,
  which is never a defined cvar name in practice, so the call is effectively
  inert; ported verbatim (this module's own `Cvar_Command`, src/qw/cvar.ts)
  rather than simplified, per PORTING.md's exactly as the original rule. Also unlike
  WinQuake's landed `Cmd_Exec_f`, QW's never calls `Hunk_FreeToLowMark` on the
  "couldn't exec" failure path either (same asymmetry already noted in
  src/common/cmd.ts, preserved here too).
- `cl_warncmd` (`cvar_t cl_warncmd = {"cl_warncmd", "0"};`, file-scope in
  cmd.c): declared but **never registered** via `Cvar_RegisterVariable`
  anywhere in the QW client tree (checked cmd.c, cl_main.c, cl_parse.c,
  client.h) -- a real bug in the shipped source, preserved exactly as the C has it per
  PORTING.md rather than "fixed" by registering it here. cl_parse.c's
  `Cbuf_AddText ("cl_warncmd 1\n")` server-forced toggle would therefore print
  "Cvar_Set: variable cl_warncmd not found" and never actually change
  anything; `cl_warncmd.value` stays permanently 0 (its literal's own
  default), so the print gates above are controlled by `developer` alone in
  practice. `new CvarT(...)` uses the current two-argument form (name,
  string only), so this compiles whether or not Q001's `flags` parameter has
  landed.
- `Cmd_ForwardToServer`/`Cmd_ForwardToServer_f`: QW writes into
  `cls.netchan.message` (a `netchan_t`'s SizeBuf), not WinQuake's
  `cls.message`. `cls.qw.netchan` is `unknown` here (src/qw/net_chan.ts, Q003/
  Q021, not yet landed), so the destination SizeBuf is a registrable hook,
  `qwCmdHooks.netchanMessage`, set by the qwcl entry point once net_chan.ts
  exists. With no hook registered, both functions still run their
  `cls.state`/`cls.demoplayback` checks (matching the C's early returns) and
  then do nothing further, the same "hook not registered yet" convention
  src/qw/cvar.ts's `qwCvarHooks` and src/client/client.ts's
  `setForwardToServerHandler` already use. `cls`/`CactiveT` (src/client/
  client.ts) are read directly, not through a hook: per PORTING.md's
  "Client state is a superset" ruling, `cls` is the one shared
  `ClientStaticT` singleton for both the WinQuake and QW binaries; only
  QW-only fields go through `cls.qw`, and `state`/`demoplayback` are not
  QW-only.
- `Cmd_ForwardToServer_f`'s `Q_strcasecmp(Cmd_Argv(1), "snap")` uses a small
  local helper, the same non-exported pattern src/common/cmd.ts's own file
  already uses for this exact purpose (cmd.h's contract does not require an
  exported `Q_strcasecmp`).
- `Cmd_Init`: registers QW's own command set, in QW's own order (`stuffcmds`,
  `exec`, `echo`, `alias`, `wait`, then `cmd` under `#ifndef SERVERONLY`),
  all through src/common/cmd.ts's shared `Cmd_AddCommand` (the one registry
  every subsystem's commands land in). `echo`/`alias`/`wait` are registered
  with the re-exported, unchanged function bodies; `exec`/`cmd` are
  registered with this file's own fresh bodies, and `stuffcmds` with the
  now-shared, qw.active-aware `Cmd_StuffCmds_f`. `#ifndef SERVERONLY`/
  `#ifdef SERVERONLY` becomes the runtime flag `qw.serveronly`
  (src/common/quakedef.ts, same "no C source line" idiom as `qw.active`):
  qwsv (src/qw/server/sv_main.ts's SV_Init) calls this same Cmd_Init and
  must not register "cmd" at all, so the registration is gated on
  `!qw.serveronly` rather than split into a second Cmd_Init.
*/

import { Con_Printf } from "../client/console";
import { Hunk_LowMark, Hunk_FreeToLowMark } from "../common/zone";
import { COM_LoadHunkFile } from "../common/common";
import { CvarT } from "../common/cvar";
import { developer } from "../common/host";
import { qw } from "../common/quakedef";
import { SizeBuf, MSG_WriteByte, SZ_Print } from "../common/sizebuf";
import { cls, CactiveT } from "../client/client";
import { ClcOpsT } from "./protocol";
import { Cvar_Command } from "./cvar";
import {
  Cmd_Argc,
  Cmd_Argv,
  Cmd_Args,
  Cmd_TokenizeString,
  Cmd_AddCommand,
  Cmd_Exists,
  Cmd_CompleteCommand,
  Cmd_CheckParm,
  Cbuf_Init,
  Cbuf_AddText,
  Cbuf_InsertText,
  Cbuf_Execute,
  Cmd_Echo_f,
  Cmd_Alias_f,
  Cmd_Wait_f,
  Cmd_StuffCmds_f,
  Cmd_ExecuteString as CommonCmd_ExecuteString,
  CmdSourceT,
  setForwardToServerHandler,
} from "../common/cmd";

// re-exported unchanged -- see file header's re-export table (Cbuf_InsertText
// and Cmd_StuffCmds_f are qw.active-folded in src/common/cmd.ts now, so they
// behave like QW's own when this binary sets qw.active -- see that file's
// header)
export {
  Cmd_Argc,
  Cmd_Argv,
  Cmd_Args,
  Cmd_TokenizeString,
  Cmd_AddCommand,
  Cmd_Exists,
  Cmd_CompleteCommand,
  Cmd_CheckParm,
  Cbuf_Init,
  Cbuf_AddText,
  Cbuf_InsertText,
  Cbuf_Execute,
  Cmd_Echo_f,
  Cmd_Alias_f,
  Cmd_Wait_f,
  Cmd_StuffCmds_f,
  setForwardToServerHandler,
};

// mirrors common cmd.ts's own local Q_strcasecmp -- see file header
function Q_strcasecmp(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return 0;
}

function latin1BytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// cvar_t cl_warncmd = {"cl_warncmd", "0"}; -- declared, never registered.
// See file header's deviation note.
export const cl_warncmd = new CvarT("cl_warncmd", "0");

export interface QwCmdHooks {
  netchanMessage: SizeBuf | null;
}

// set by the qwcl entry point once src/qw/net_chan.ts (Q003/Q021) lands --
// see file header's deviation note.
export const qwCmdHooks: QwCmdHooks = {
  netchanMessage: null,
};

/*
============
Cmd_ExecuteString

QW's one-argument call shape. With Task 2's cmd.ts fold, the shared
src/common/cmd.ts Cmd_ExecuteString this wraps now behaves exactly like QW's
own (the "Unknown command" print gate) whenever qw.active is set, closing the
integration gap this file's header used to document.
============
*/
export function Cmd_ExecuteString(text: string): void {
  CommonCmd_ExecuteString(text, CmdSourceT.src_command);
}

//==============================================================================
//
//						SCRIPT COMMANDS
//
//==============================================================================

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
  // see file header's deviation note: this Cvar_Command() call is effectively
  // inert ("exec" is never a defined cvar name), ported verbatim
  if (!Cvar_Command() && (cl_warncmd.value || developer.value)) {
    Con_Printf("execing %s\n", Cmd_Argv(1));
  }

  // f carries one trailing NUL byte (common.ts's COM_LoadHunkFile ruling);
  // drop it so Cbuf_InsertText sees exactly what the C's Q_strlen(f) would.
  const text = latin1BytesToString(f.subarray(0, f.length - 1));
  Cbuf_InsertText(text);
  Hunk_FreeToLowMark(mark);
}

//=============================================================================
//
//					COMMAND EXECUTION
//
//=============================================================================

// #ifndef SERVERONLY (qwcl) -- the #ifdef SERVERONLY variant (qwsv) is an
// empty function body, `void Cmd_ForwardToServer (void) {}`; that is qwsv's
// own unit, not this one.
/*
===================
Cmd_ForwardToServer

adds the current command line as a clc_stringcmd to the client message.
things like godmode, noclip, etc, are commands directed to the server,
so when they are typed in at the console, they will need to be forwarded.
===================
*/
export function Cmd_ForwardToServer(): void {
  if (cls.state === CactiveT.ca_disconnected) {
    Con_Printf('Can\'t "%s", not connected\n', Cmd_Argv(0));
    return;
  }

  if (cls.demoplayback) return; // not really connected

  const sb = qwCmdHooks.netchanMessage;
  if (!sb) return; // net_chan.ts (Q003/Q021) hook not registered yet

  MSG_WriteByte(sb, ClcOpsT.clc_stringcmd);
  SZ_Print(sb, Cmd_Argv(0));
  if (Cmd_Argc() > 1) {
    SZ_Print(sb, " ");
    SZ_Print(sb, Cmd_Args() ?? "");
  }
}

// don't forward the first argument
export function Cmd_ForwardToServer_f(): void {
  if (cls.state === CactiveT.ca_disconnected) {
    Con_Printf('Can\'t "%s", not connected\n', Cmd_Argv(0));
    return;
  }

  if (Q_strcasecmp(Cmd_Argv(1), "snap") === 0) {
    Cbuf_InsertText("snap\n");
    return;
  }

  if (cls.demoplayback) return; // not really connected

  if (Cmd_Argc() > 1) {
    const sb = qwCmdHooks.netchanMessage;
    if (!sb) return; // net_chan.ts (Q003/Q021) hook not registered yet

    MSG_WriteByte(sb, ClcOpsT.clc_stringcmd);
    SZ_Print(sb, Cmd_Args() ?? "");
  }
}

/*
============
Cmd_Init
============
*/
export function Cmd_Init(): void {
  // register our commands
  Cmd_AddCommand("stuffcmds", Cmd_StuffCmds_f);
  Cmd_AddCommand("exec", Cmd_Exec_f);
  Cmd_AddCommand("echo", Cmd_Echo_f);
  Cmd_AddCommand("alias", Cmd_Alias_f);
  Cmd_AddCommand("wait", Cmd_Wait_f);
  // #ifndef SERVERONLY -- qwsv (SERVERONLY) never registers "cmd" at all.
  if (!qw.serveronly) Cmd_AddCommand("cmd", Cmd_ForwardToServer_f);
}
