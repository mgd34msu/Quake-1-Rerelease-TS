/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sys_unix.c (GNU GPL v2 or later) -- everything that
file holds except its `main()`, which PORTING.md's QuakeWorld track assigns
to src/qw/main_sv.ts.

Deviations from PORTING.md / the C source:
- `Sys_FileTime`, `Sys_mkdir`, `Sys_Error`, `Sys_Printf`, `Sys_Quit` and
  `Sys_ConsoleInput` are already in src/platform/sys.ts (PORTING.md's one
  bun implementation of every `sys_*.c`), with bodies identical in effect to
  this file's; they are not re-ported here and every caller keeps importing
  them from there.
- `Sys_DoubleTime`'s `gettimeofday` + `static int secbase` body is what
  src/platform/sys.ts's `Sys_FloatTime` already contains, down to the
  `tp.tv_usec/1000000.0` first-call return; this is the one name the QW
  server calls it by (src/qw/server/sv_main.ts keeps a private alias of its
  own), so it delegates rather than starting a second `secbase` epoch that
  would make the two clocks disagree.
- `qboolean stdin_ready` / `static int do_stdin` and the `select()` that sets
  them have no port: src/platform/sys.ts's `Sys_ConsoleInput` drains a line
  queue a background stdin reader fills, so it already returns NULL exactly
  when the C's returns NULL for want of a ready fd, and returns NULL forever
  after end-of-file the way `do_stdin = 0` does. src/qw/main_sv.ts's loop
  documents the rest of the `select` mapping.
- `Sys_Printf` reads `sys_nostdout.value` on every call; src/platform/sys.ts's
  reads the `sysState.nostdout` int that WinQuake's `-nostdout` parm sets, and
  that file is outside this unit's SCOPE. `Sys_NostdoutFromCvar` below
  republishes the cvar into that int; src/qw/main_sv.ts's loop calls it once
  per frame, so a `sys_nostdout` set from server.cfg or the console takes
  effect from the next frame instead of from the next print.
*/

import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import { Sys_FloatTime, sysState } from "../platform/sys";

export const sys_nostdout = new CvarT("sys_nostdout", "0");
export const sys_extrasleep = new CvarT("sys_extrasleep", "0");

/*
================
Sys_DoubleTime
================
*/
export function Sys_DoubleTime(): number {
  return Sys_FloatTime();
}

// see file header: Sys_Printf's `if (sys_nostdout.value) return;`
export function Sys_NostdoutFromCvar(): void {
  sysState.nostdout = Math.trunc(sys_nostdout.value) !== 0 ? 1 : 0;
}

/*
=============
Sys_Init

Quake calls this so the system can register variables before host_hunklevel
is marked
=============
*/
export function Sys_Init(): void {
  Cvar_RegisterVariable(sys_nostdout);
  Cvar_RegisterVariable(sys_extrasleep);
}
