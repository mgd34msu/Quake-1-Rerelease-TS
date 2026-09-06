/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sys_unix.c's `main()` (GNU GPL v2 or later). The rest
of that file is src/qw/sys_sv.ts; PORTING.md's QuakeWorld track names this
module the qwsv process entry point ("one engine, two extra entry points").

Deviations from PORTING.md / the C source:
- `main`'s single body is split into `Sys_Main_Init(argv)` (everything up to
  and including the "run one frame immediately for first heartbeat"
  SV_Frame(0.1) call) and `Sys_Main_Loop()` (the `while (1)` loop), with
  `runFrames(count, seconds)` as the synchronous frame driver a test uses
  instead, exactly as src/main.ts splits sys_linux.c's main().
- `select (net_socket+1, &fdset, NULL, NULL, &timeout)` on the UDP socket and
  stdin has no port: src/qw/net_udp.ts is built on `Bun.udpSocket`, which
  delivers datagrams through a `data` callback into a queue NET_GetPacket
  drains, and exposes no descriptor to select on (there is no `net_socket`
  export at all); src/platform/sys.ts's stdin is likewise a background reader
  filling a line queue. Both queues fill only while the event loop runs, so
  the port's equivalent of "block until a packet, a console line, or the 1
  second timeout" is `await Bun.sleep(1)` at the top of every iteration --
  the same yield src/main.ts's loop makes for the same reason. The observable
  differences from the C: the loop wakes every millisecond rather than on the
  arrival of data, so SV_Frame is called more often with smaller `time`
  values than a real select would produce, and `stdin_ready` needs no port
  (see src/qw/sys_sv.ts's header).
- `if ((parms.membase = malloc (parms.memsize)) == NULL) Sys_Error(...)` has
  no equivalent: zone.ts's Memory_Init takes a size, not a base pointer
  (PORTING.md's zone rule), so `parms.membase` stays at its `QuakeParmsT`
  default (`null`) and the allocation-failure branch cannot be reached.
- `j = COM_CheckParm("-mem"); parms.memsize = (int) (Q_atof(com_argv[j+1]) *
  1024 * 1024);` keeps `Q_atof` and the `(int)` truncation as `| 0`, the same
  reading src/main.ts's own `-mem` handling records.
- `usleep (sys_extrasleep.value)` takes microseconds; `Bun.sleep` takes
  milliseconds, so the argument is divided by 1000.
- `sysState.isDedicated = true`: src/platform/sys.ts's Sys_ConsoleInput
  returns NULL unless that flag is set (it is sys_linux.c's `if (cls.state ==
  ca_dedicated)` gate), and qwsv is a dedicated server by construction -- the
  C's sys_unix.c has no such test because the qwsv binary is compiled with
  SERVERONLY. Without it SV_GetConsoleCommands could never read a typed line.
- `qw.active` / `qw.serveronly` (src/common/quakedef.ts) are PORTING.md's
  runtime stand-ins for the QW tree and its qwsv Makefile's `-DSERVERONLY`;
  both are set here before SV_Init, which is where PORTING.md and
  src/qw/server/sv_main.ts's header both put the job.
- `setSvFlushSignonHook(SV_FlushSignon)` is the link step for the hook
  src/qw/server/pr_edict.ts calls from ED_LoadFromFile; src/qw/server/sv_init.ts
  also registers it at module load, and this call is what pulls that module
  in.
- `main`'s top-level try/catch stands in for the `exit(1)` inside the C's own
  Sys_Error: src/platform/sys.ts throws `SysError` instead (and
  src/qw/server/sv_main.ts's SV_Error throws `PRRunError`, a subclass), so a
  caller -- here, and every test -- can observe it. The message is already on
  stderr by then, so this catch does not print it again.
- `qwConsoleHooks.Con_Printf`/`Con_DPrintf` installed below (.orch/e2e/E.md
  defect C): five modules shared with qwcl (src/qw/common.ts, cmd.ts,
  net_chan.ts, net_udp.ts, pmovetst.ts) import Con_Printf/Con_DPrintf from
  src/client/console.ts (WinQuake's file, whose `qw.active` fold gives them
  QW's Con_Printf semantics -- see that file's own header), because qwsv
  links no console.c of its own at all. Without a hook installed here, a
  Con_Printf from one of those five files in the qwsv binary fell through to
  console.ts's own body (a bare Sys_Printf to the server's local stdout),
  bypassing QW/server/sv_send.c's `SV_BeginRedirect`/`outputbuf` redirect
  entirely -- a client's `rcon`/`cmd status` (which redirects the server's
  reply back over the wire instead of printing it locally) would see nothing
  back if the message happened to originate from one of those five files
  (e.g. net_chan.ts's overflow/out-of-order warnings). qwcl already solves
  the identical problem for its own five-of-nine-shared-modules case by
  installing these same hooks pointed at its own console (src/qw/main_cl.ts);
  this is the same mechanism, pointed at src/qw/server/sv_send.ts's
  redirect-aware Con_Printf/Con_DPrintf instead, which is what every other
  qwsv-server file (sv_init.ts, sv_ccmds.ts, sv_main.ts) already imports
  Con_Printf/Con_DPrintf from as the binary's one real implementation. No
  `Con_SafePrintf` hook: none of the five shared modules calls it.
*/

import { COM_CheckParm, COM_InitArgv, Q_atof, com_argc, com_argv } from "./common";
import { QuakeParmsT, qw } from "../common/quakedef";
import { NET_Ready } from "./net_udp";
import { SV_Frame, SV_Init } from "./server/sv_main";
import { SV_FlushSignon } from "./server/sv_init";
import { setSvFlushSignonHook } from "./server/pr_edict";
import { SV_Quit_f } from "./server/sv_ccmds";
import { Con_Printf as SV_Con_Printf, Con_DPrintf as SV_Con_DPrintf } from "./server/sv_send";
import { qwConsoleHooks } from "../client/console";
import { Sys_DoubleTime, Sys_NostdoutFromCvar, sys_extrasleep } from "./sys_sv";
import { Sys_Printf, SysError, installTerminationSignals, sysState } from "../platform/sys";

/*
=============
Sys_Main_Init

QW/server/sys_unix.c's main() up to and including the first SV_Frame call.
=============
*/
export function Sys_Main_Init(argv: string[]): void {
  // PORTING.md's QuakeWorld runtime flags -- see file header
  qw.active = true;
  qw.serveronly = true;
  sysState.isDedicated = true; // see file header

  // see file header: the same link step qwcl's own main_cl.ts does, pointed
  // at this binary's real Con_Printf/Con_DPrintf instead (sv_send.ts's
  // redirect-aware ones).
  qwConsoleHooks.Con_Printf = SV_Con_Printf;
  qwConsoleHooks.Con_DPrintf = SV_Con_DPrintf;

  setSvFlushSignonHook(SV_FlushSignon); // see file header

  const parms = new QuakeParmsT(); // memset (&parms, 0, sizeof(parms))

  COM_InitArgv(argv);
  parms.argc = com_argc;
  parms.argv = com_argv;

  parms.memsize = 16 * 1024 * 1024;

  const j = COM_CheckParm("-mem");
  if (j) parms.memsize = (Q_atof(com_argv[j + 1]) * 1024 * 1024) | 0;

  // parms.membase = malloc (parms.memsize) -- not applicable, see file header

  parms.basedir = ".";

  SV_Init(parms);

  // run one frame immediately for first heartbeat
  SV_Frame(0.1);
}

/*
=============
Sys_Main_Loop

sys_unix.c's `while (1)` main loop. Never returns in production; a test drives
SV_Frame through `runFrames` below instead of awaiting an infinite loop.
=============
*/
export async function Sys_Main_Loop(): Promise<never> {
  // Bun's bind is asynchronous where the C's is not, so the socket
  // SV_InitNet opened is not usable until this resolves.
  await NET_Ready();

  let oldtime = Sys_DoubleTime() - 0.1;
  for (;;) {
    // select on the net socket and stdin -- see file header
    await Bun.sleep(1);

    Sys_NostdoutFromCvar(); // see file header

    // find time passed since last cycle
    const newtime = Sys_DoubleTime();
    const time = newtime - oldtime;
    oldtime = newtime;

    SV_Frame(time);

    // extrasleep is just a way to generate a fucked up connection on purpose
    if (sys_extrasleep.value) await Bun.sleep(sys_extrasleep.value / 1000);
  }
}

// Synchronous frame driver, so an embedder (a test, a future tool) can step
// the server without owning the process's event loop the way Sys_Main_Loop
// does.
export function runFrames(count: number, seconds = 0.1): void {
  for (let i = 0; i < count; i++) SV_Frame(seconds);
}

/*
=============
main
=============
*/
export async function main(argv: string[]): Promise<void> {
  // Not in QW/server/sys_unix.c -- see platform/sys.ts's
  // installTerminationSignals header for why this port installs
  // SIGINT/SIGTERM handling anyway. qwsv never calls setHostShutdown (see
  // that file's own header: sys_unix.c's Sys_Quit has no such hook to
  // register), so the tree's own "quit" body is SV_Quit_f (SV_FinalMessage,
  // "Shutting down.", SV_Shutdown, Sys_Quit) -- the same body Cmd_AddCommand
  // wires to the typed "quit" console command in sv_ccmds.ts -- rather than
  // bare Sys_Quit, which alone would exit with no cleanup at all here.
  installTerminationSignals(SV_Quit_f);

  try {
    Sys_Main_Init(argv);
    await Sys_Main_Loop();
  } catch (err) {
    if (err instanceof SysError) {
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    Sys_Printf("Fatal: %s\n", message);
    process.exit(1);
  }
}

// bun src/qw/main_sv.ts +map start -> process.argv is ["bun",
// "src/qw/main_sv.ts", "+map", "start"]; slice(1) keeps the script path as
// argv[0], standing in for the C's own argv[0].
if (import.meta.main) {
  await main(process.argv.slice(1));
}
