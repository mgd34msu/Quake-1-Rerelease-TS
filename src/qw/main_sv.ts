/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sys_unix.c's `main()` (GNU GPL v2 or later). The rest
of that file is src/qw/sys_sv.ts.

Unified server (ARCHITECTURE.md "Unified client and server", U38): everything
this module used to do -- the link-step imports, `qw.active`/`qw.serveronly`,
`sysState.isDedicated`, the qwConsoleHooks and setSvFlushSignonHook
assignments, SV_Init and the first heartbeat frame, and the SV_Frame loop --
now lives in src/main.ts, which is one binary that boots either server as
well as either client. `qwsv` stays as the entry point the
`start:qwsv`/`build:qwsv` targets name and old habits type, and it is exactly
"src/main.ts with `-dedicated -qw`": this module inserts those two arguments
and re-exports src/main.ts's Sys_Main_Init / Sys_Main_Loop / runFrames / main,
so every caller (tests included) keeps the same surface. `runFrames` keeps
this file's own `seconds = 0.1` default, which src/main.ts's client-shaped
one does not have. The boot itself is byte-for-byte the one this file used to
run -- src/main.ts's `Sys_Main_Init_QWSV` is this file's old body, moved, and
its `Sys_Main_Loop` carries this file's old loop as its first arm.

Deviations from PORTING.md / the C source (all now carried by src/main.ts's
own header, listed here because they are QW/server/sys_unix.c's lines):
- `main`'s single body is split into `Sys_Main_Init(argv)` (everything up to
  and including the "run one frame immediately for first heartbeat"
  SV_Frame(0.1) call) and `Sys_Main_Loop()` (the `while (1)` loop), with
  `runFrames(count, seconds)` as the synchronous frame driver a test uses
  instead, exactly as src/main.ts splits sys_linux.c's main().
- `select (net_socket+1, &fdset, NULL, NULL, &timeout)` on the UDP socket and
  stdin has no port: src/qw/net_udp.ts is built on `Bun.udpSocket`, which
  delivers datagrams through a `data` callback into a queue NET_GetPacket
  drains, and exposes no descriptor to select on; src/platform/sys.ts's stdin
  is likewise a background reader filling a line queue. Both queues fill only
  while the event loop runs, so the port's equivalent of "block until a
  packet, a console line, or the 1 second timeout" is `await Bun.sleep(1)` at
  the top of every iteration. The observable differences from the C: the loop
  wakes every millisecond rather than on the arrival of data, so SV_Frame is
  called more often with smaller `time` values than a real select would
  produce, and `stdin_ready` needs no port (see src/qw/sys_sv.ts's header).
- `if ((parms.membase = malloc (parms.memsize)) == NULL) Sys_Error(...)` has
  no equivalent: zone.ts's Memory_Init takes a size, not a base pointer
  (PORTING.md's zone rule), so `parms.membase` stays at its `QuakeParmsT`
  default (`null`) and the allocation-failure branch cannot be reached.
- `j = COM_CheckParm("-mem"); parms.memsize = (int) (Q_atof(com_argv[j+1]) *
  1024 * 1024);` keeps `Q_atof` and the `(int)` truncation as `| 0`.
- `usleep (sys_extrasleep.value)` takes microseconds; `Bun.sleep` takes
  milliseconds, so the argument is divided by 1000.
- `main`'s top-level try/catch stands in for the `exit(1)` inside the C's own
  Sys_Error: src/platform/sys.ts throws `SysError` instead (and
  src/qw/server/sv_main.ts's SV_Error throws `PRRunError`, a subclass), so a
  caller -- here, and every test -- can observe it.
*/

import { main as unifiedMain, Host_Frame, Sys_Main_Init as unifiedSysMainInit, Sys_Main_Loop } from "../main";

export { Sys_Main_Loop };

// `-dedicated -qw` is what selects the QuakeWorld server boot in src/main.ts;
// inserted right after argv[0] so a caller's own `-basedir`/`-port`/`+map`
// arguments keep their order and their meaning.
function withQwsvParms(argv: string[]): string[] {
  const head = argv[0] ?? "qwsv";
  const rest = argv.slice(1);
  const extra: string[] = [];
  if (!rest.includes("-dedicated")) extra.push("-dedicated");
  if (!rest.includes("-qw")) extra.push("-qw");
  return [head, ...extra, ...rest];
}

export function Sys_Main_Init(argv: string[]): void {
  unifiedSysMainInit(withQwsvParms(argv));
}

// Synchronous frame driver, so an embedder (a test, a future tool) can step
// the server without owning the process's event loop the way Sys_Main_Loop
// does. Keeps QW/server/sys_unix.c's own 0.1 default.
export function runFrames(count: number, seconds = 0.1): void {
  for (let i = 0; i < count; i++) Host_Frame(seconds);
}

export async function main(argv: string[]): Promise<void> {
  await unifiedMain(withQwsvParms(argv));
}

// bun src/qw/main_sv.ts +map start -> process.argv is ["bun",
// "src/qw/main_sv.ts", "+map", "start"]; slice(1) keeps the script path as
// argv[0], standing in for the C's own argv[0].
if (import.meta.main) {
  await main(process.argv.slice(1));
}
