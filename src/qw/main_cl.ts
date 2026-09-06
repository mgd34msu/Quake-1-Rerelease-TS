/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/sys_linux.c's `main()` (GNU GPL v2 or later). The rest
of that file has no port of its own: every other function it defines
(Sys_Init, Sys_Error, Sys_Printf, Sys_Quit, Sys_FileTime, Sys_mkdir,
Sys_DoubleTime, Sys_ConsoleInput, Sys_HighFPPrecision/Sys_LowFPPrecision,
Sys_MakeCodeWriteable) is already in src/platform/sys.ts with a body
identical in effect, so there is no src/qw/sys_cl.ts -- unlike the qwsv side,
whose sys_unix.c carries two cvars (`sys_nostdout`/`sys_extrasleep`) and a
Sys_Init that registers them, which is why src/qw/sys_sv.ts exists. QW's
client sys_linux.c declares one cvar of its own, `sys_linerefresh`, but
nothing in QW/client ever registers or reads it (its `Sys_Init` is an empty
`#if id386` body and the only other occurrence in the whole tree is the
declaration itself), so it is dropped rather than carried into a module
existing only to hold it.

Unified client (ARCHITECTURE.md "Unified client and server", U32): everything
this module used to do -- the link-step imports, `qw.active = true`,
setHostShutdown, the qwConsoleHooks/scrUpdateScreen assignments, and the
QW/client Host_Init/Host_Frame calls -- now lives in src/main.ts, which is one
binary that boots either tree. `qwcl` stays as the entry point the
`start:qwcl`/`build:qwcl` targets name and old habits type, and it is exactly
"src/main.ts with `-qw`": this module inserts that argument and re-exports
src/main.ts's Sys_Main_Init / Sys_Main_Loop / runFrames / main unchanged, so
every caller (tests included) keeps the same surface. The boot itself is
byte-for-byte the one this file used to run -- src/main.ts's
`Sys_Main_Init_QW` is this file's old body, moved.

Deviations from PORTING.md / the C source (all now carried by src/main.ts's
own header, listed here because they are QW/client/sys_linux.c's lines):
- `main`'s single body is split into `Sys_Main_Init(argv)` and
  `Sys_Main_Loop()`, with `runFrames(count, seconds)` as the synchronous frame
  driver a test uses instead.
- `signal (SIGFPE, SIG_IGN)` is dropped: bun/V8 floating point never raises
  SIGFPE, so there is no hardware trap to mask.
- `parms.membase = malloc (parms.memsize)` has no equivalent: zone.ts's
  Memory_Init takes a size, not a base pointer (PORTING.md's zone rule).
- `noconinput = COM_CheckParm("-noconinput"); if (!noconinput) fcntl (0,
  F_SETFL, ... | FNDELAY);` -- the `noconinput` global is read nowhere else in
  QW/client, and the FNDELAY toggle it guards has no port: src/platform/sys.ts's
  Sys_ConsoleInput drains a line queue a background stdin reader fills. The
  parm is still consumed so `-noconinput` is not reported as unknown.
- `parms.basedir = basedir` reads sys_linux.c's file-scope `char *basedir =
  "."` (line 44); `-basedir` overrides it inside COM_InitFilesystem.
- `j = COM_CheckParm("-mem"); parms.memsize = (int) (Q_atof (com_argv[j+1]) *
  1024 * 1024);` keeps `Q_atof` and the `(int)` truncation as `| 0`.
- The C's `while (1)` loop has no yield point at all; `await Bun.sleep(1)` at
  the end of every iteration is this port's fix, so src/qw/net_udp.ts's
  `Bun.udpSocket` receive callbacks can run.
- `Sys_DoubleTime` is src/platform/sys.ts's `Sys_FloatTime`.
- Bun's UDP bind is asynchronous where the C's is not, so `Sys_Main_Loop`
  awaits src/qw/net_udp.ts's `NET_Ready()` before its first frame.
*/

import { main as unifiedMain, runFrames, Sys_Main_Init as unifiedSysMainInit, Sys_Main_Loop } from "../main";

export { runFrames, Sys_Main_Loop };

// `-qw` is what selects the QuakeWorld boot in src/main.ts; inserted right
// after argv[0] so a caller's own `-basedir`/`+connect` arguments keep their
// order and their meaning.
function withQwParm(argv: string[]): string[] {
  if (argv.includes("-qw")) return argv;
  return [argv[0] ?? "qwcl", "-qw", ...argv.slice(1)];
}

export function Sys_Main_Init(argv: string[]): void {
  unifiedSysMainInit(withQwParm(argv));
}

export async function main(argv: string[]): Promise<void> {
  await unifiedMain(withQwParm(argv));
}

// bun src/qw/main_cl.ts +connect host -> process.argv is ["bun",
// "src/qw/main_cl.ts", "+connect", "host"]; slice(1) keeps the script path as
// argv[0], standing in for the C's own argv[0].
if (import.meta.main) {
  await main(process.argv.slice(1));
}
