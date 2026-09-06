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

PORTING.md's QuakeWorld track names this module the qwcl process entry point
("one engine, two extra entry points").

Deviations from PORTING.md / the C source:
- `main`'s single body is split into `Sys_Main_Init(argv)` (everything up to
  and including Host_Init) and `Sys_Main_Loop()` (the `while (1)` loop), with
  `runFrames(count, seconds)` as the synchronous frame driver a test uses
  instead, exactly as src/main.ts and src/qw/main_sv.ts split their own
  `main()`s.
- `signal (SIGFPE, SIG_IGN)` is dropped: bun/V8 floating point never raises
  SIGFPE, so there is no hardware trap to mask.
- `parms.membase = malloc (parms.memsize)` has no equivalent: zone.ts's
  Memory_Init takes a size, not a base pointer (PORTING.md's zone rule), so
  `parms.membase` stays at its `QuakeParmsT` default (`null`).
- `noconinput = COM_CheckParm("-noconinput"); if (!noconinput) fcntl (0,
  F_SETFL, ... | FNDELAY);` -- the `noconinput` global is read nowhere else
  in QW/client (grepped across every .c there), and the FNDELAY toggle it
  guards has no port: src/platform/sys.ts's Sys_ConsoleInput drains a line
  queue a background stdin reader fills instead of making fd 0 non-blocking.
  The parm is still consumed here so `-noconinput` is not reported as an
  unknown parm, and its one C effect is documented as absent.
- `parms.basedir = basedir` reads sys_linux.c's own file-scope `char *basedir
  = ".";` (line 44); ported as that literal, exactly as src/main.ts does for
  WinQuake's identical line. `-basedir` overrides it inside COM_InitFilesystem.
- `j = COM_CheckParm("-mem"); parms.memsize = (int) (Q_atof (com_argv[j+1]) *
  1024 * 1024);` keeps `Q_atof` and the `(int)` truncation as `| 0`, the same
  reading src/main.ts and src/qw/main_sv.ts record for their copies.
- The C's `while (1) { newtime = Sys_DoubleTime (); time = newtime - oldtime;
  Host_Frame(time); oldtime = newtime; }` has no yield point at all (qwcl's
  loop, unlike WinQuake's, has no `sys_ticrate` sleep branch -- Host_Frame's
  own `cl_maxfps`/`rate` check is what throttles it). A bare spin would never
  hand control back to Bun's event loop, so src/qw/net_udp.ts's
  `Bun.udpSocket` receive callbacks could never run and CL_ReadPackets would
  see a permanently empty queue. `await Bun.sleep(1)` at the end of every
  iteration is this port's fix, the same one src/main.ts and
  src/qw/main_sv.ts make for the same reason.
- `Sys_DoubleTime` is src/platform/sys.ts's `Sys_FloatTime`.
- Bun's UDP bind is asynchronous where the C's is not, so `Sys_Main_Loop`
  awaits src/qw/net_udp.ts's `NET_Ready()` before its first frame, exactly as
  src/qw/main_sv.ts's loop does. Host_Init's `NET_Init (PORT_CLIENT)` has
  already been called by then; the await only waits for the bind to land.

Link step (what the C's Makefile does and this module has to do by hand):
- Module side-effect imports below stand in for the object files qwcl links.
  src/main.ts's header makes the same point for the WinQuake binary.
- `qw.active = true` (src/common/quakedef.ts) is PORTING.md's runtime
  stand-in for the QW tree, set at the very top of Sys_Main_Init before
  COM_InitArgv, since COM_InitArgv/COM_Init and every cvar registration under
  them read it. `qw.serveronly` stays false: qwcl is the client binary, which
  the qwsv Makefile's `-DSERVERONLY` is precisely not.
- `setHostShutdown(Host_Shutdown)`: src/platform/sys.ts's Sys_Error and
  Sys_Quit call Host_Shutdown, which the C resolves at link time. WinQuake's
  src/common/host.ts registers its own from inside Host_Init; QW's Host_Init
  (src/qw/client/cl_main.ts) has no such line because the C never needed one,
  so the qwcl entry point installs it, before Host_Init, so a Sys_Error
  raised during Host_Init still shuts down.
- `qwConsoleHooks` (src/client/console.ts): the modules both QW binaries
  share -- src/qw/common.ts, cmd.ts, net_chan.ts, net_udp.ts, pmovetst.ts --
  import Con_Printf/Con_DPrintf from WinQuake's console module, since qwsv
  links no console at all and that file's `qw.active` fold is what gives them
  QW's Con_Printf semantics there. In qwcl the C links QW/client/console.c,
  so those same calls must land in THIS console's buffer (`con_main.text`),
  not WinQuake's `con_text` (which no Con_Init ever allocates here). These
  three assignments are that link step; qwsv leaves them null.
- `hostClientHooks.scrUpdateScreen = SCR_UpdateScreen`: src/client/keys.ts
  (shared by both trees, QW/client/keys.c being a near-copy of WinQuake's)
  calls SCR_UpdateScreen through that hook from Key_Console. WinQuake's
  src/client/screen.ts registers its own SCR_UpdateScreen there at module
  load, and it is in this binary's import graph whether or not qwcl wants it
  (src/ref_soft/r_main.ts and src/ref_gl/ref_gl.ts both import `scr_viewsize`
  from it), so without this line a qwcl console keypress would run WinQuake's
  screen code. QW's screen.c is what qwcl links; this points the hook at it.
*/

import { COM_CheckParm, COM_InitArgv, Q_atof, com_argc, com_argv } from "./common";
import { QuakeParmsT, qw } from "../common/quakedef";
import { NET_Ready } from "./net_udp";
import { Host_Frame, Host_Init, Host_Shutdown } from "./client/cl_main";
import { Con_DPrintf, Con_Printf, Con_SafePrintf } from "./client/console";
import { SCR_UpdateScreen } from "./client/screen";
import { qwConsoleHooks } from "../client/console";
import { hostClientHooks } from "../common/host";
import {
  Sys_FloatTime,
  Sys_Init,
  Sys_Printf,
  Sys_Quit,
  SysError,
  installTerminationSignals,
  setHostShutdown,
  sysState,
} from "../platform/sys";
// The object files qwcl links -- see the file header's link-step note. Each
// module either installs a backend/hook holder at load (the platform layer,
// the two renderers) or is reached only through one of those, so importing
// it here is what makes it exist in the binary.
import "./client/cl_input";
import "./client/cl_parse";
import "./client/cl_tent";
import "./client/cl_demo";
import "./client/cl_ents";
import "./client/cl_pred";
import "./client/cl_cam";
import "./client/skin";
import "./client/menu";
import "./client/sbar";
import "./pmove";
// snd_linux.c and cd_linux.c, this port's src/platform/snd.ts and
// src/platform/cd_ogg.ts: they install `sndDma.current` / `cdAudio.current`
// at module load and nothing else in the tree imports them, so Host_Init's
// CDAudio_Init and VID_Init's S_Init would find both holders empty without
// these two lines.
import "../platform/snd";
import "../platform/cd_ogg";
// vid_x.c / in_x.c: src/platform/vid.ts installs `vidBackend.current` and
// src/platform/sdl.ts `inputBackend.current`, which are what Host_Init's
// VID_Init and IN_Init calls go through.
import "../platform/vid";
import "../platform/sdl";
// The renderers register themselves with src/platform/vid.ts's registry at
// module load (the C links exactly one; this port links both and selects by
// vid_ref, PORTING.md's one added cvar).
import "../ref_soft/ref_soft";
import "../ref_gl/ref_gl";

/*
=============
Sys_Main_Init

QW/client/sys_linux.c's main() up to and including its Host_Init call.
=============
*/
export function Sys_Main_Init(argv: string[]): void {
  // PORTING.md's QuakeWorld runtime flag -- see the file header's link-step
  // note for why it is set before anything else runs.
  qw.active = true;

  // see the file header's link-step note
  setHostShutdown(Host_Shutdown);
  qwConsoleHooks.Con_Printf = Con_Printf;
  qwConsoleHooks.Con_DPrintf = Con_DPrintf;
  qwConsoleHooks.Con_SafePrintf = Con_SafePrintf;
  hostClientHooks.scrUpdateScreen = SCR_UpdateScreen;

  // signal(SIGFPE, SIG_IGN); -- dropped, see file header

  const parms = new QuakeParmsT(); // memset(&parms, 0, sizeof(parms))

  COM_InitArgv(argv);
  parms.argc = com_argc;
  parms.argv = com_argv;

  parms.memsize = 16 * 1024 * 1024;

  const j = COM_CheckParm("-mem");
  if (j) parms.memsize = (Q_atof(com_argv[j + 1]) * 1024 * 1024) | 0;

  // parms.membase = malloc (parms.memsize); -- not applicable, see file header

  parms.basedir = "."; // sys_linux.c:44 `char *basedir = "."`, see file header
  // caching is disabled by default, use -cachedir to enable
  //	parms.cachedir = cachedir;

  COM_CheckParm("-noconinput"); // the fcntl it guards has no port, see file header

  if (COM_CheckParm("-nostdout")) sysState.nostdout = 1;

  Sys_Init();

  Host_Init(parms);
}

/*
=============
Sys_Main_Loop

sys_linux.c's `while (1)` main loop. Never returns in production; a test
drives Host_Frame through `runFrames` below instead of awaiting an infinite
loop.
=============
*/
export async function Sys_Main_Loop(): Promise<never> {
  // Bun's bind is asynchronous where the C's is not, so the socket
  // Host_Init's NET_Init opened is not usable until this resolves.
  await NET_Ready();

  let oldtime = Sys_FloatTime();
  for (;;) {
    // find time spent rendering last frame
    const newtime = Sys_FloatTime();
    const time = newtime - oldtime;

    Host_Frame(time);
    oldtime = newtime;

    // See the file header: hands the event loop back every iteration, which
    // the C's loop has no need to do.
    await Bun.sleep(1);
  }
}

// Synchronous frame driver, so an embedder (a test, a future tool) can step
// the client without owning the process's event loop the way Sys_Main_Loop
// does.
export function runFrames(count: number, seconds: number): void {
  for (let i = 0; i < count; i++) Host_Frame(seconds);
}

/*
=============
main

sys_linux.c's process entry point. `main`'s top-level try/catch stands in for
the `exit(1)` inside the C's own Sys_Error: src/platform/sys.ts throws
`SysError` instead so a caller -- here, and every test -- can observe it. The
message is already on stderr by then, so this catch does not print it again.
=============
*/
export async function main(argv: string[]): Promise<void> {
  // Not in QW/client/sys_linux.c -- see platform/sys.ts's
  // installTerminationSignals header for why this port installs
  // SIGINT/SIGTERM handling anyway. setHostShutdown(Host_Shutdown) (below,
  // in Sys_Main_Init) is what makes Sys_Quit's own hostShutdown hook run
  // qwcl's CDAudio/NET/S/IN/VID shutdown and config write.
  installTerminationSignals(Sys_Quit);

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

// bun src/qw/main_cl.ts +connect host -> process.argv is ["bun",
// "src/qw/main_cl.ts", "+connect", "host"]; slice(1) keeps the script path as
// argv[0], standing in for the C's own argv[0].
if (import.meta.main) {
  await main(process.argv.slice(1));
}
