/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sys_linux.c's `main()` (GNU GPL v2 or later), plus the
frame-loop expectations host.c's Host_Init/Host_Frame place on their caller.

sys_linux.c's main() is the process entry point for the Linux build: it
builds `quakeparms_t`, hands it to Host_Init, then spins calling Host_Frame
forever. Every other WinQuake platform file (sys_win.c, sys_dos.c, ...) has
its own copy of the same shape; PORTING.md assigns all of them to this one
module.

Deviations from the C:
- `signal (SIGFPE, SIG_IGN)` is dropped: bun/V8 floating point never raises
  SIGFPE (there is no hardware trap to ignore), so there is nothing to mask.
- `parms.membase = malloc (parms.memsize)` has no equivalent: zone.ts's
  Memory_Init takes a size, not a base pointer (PORTING.md's zone rule), so
  `parms.membase` is left at its `QuakeParmsT` default (`null`) and never
  read.
- `fcntl (0, F_SETFL, ... | FNDELAY)` (both call sites -- the one right
  before Host_Init and the one in the `-nostdout`-not-given `else` branch)
  is dropped: platform/sys.ts's Sys_ConsoleInput already documents its own
  non-blocking-stdin replacement (a background stream reader draining into a
  line queue), so there is no FNDELAY toggle for this port to make.
- `main`'s single body is split into `Sys_Main_Init(argv)` (everything up to
  and including the `-nostdout` check) and `Sys_Main_Loop()` (the `while (1)`
  loop), so a test can drive Host_Init/Host_Frame without ever entering the
  infinite loop. `runFrames(count, seconds)` is the synchronous frame driver
  a test uses instead of `Sys_Main_Loop` (mirrors quake-2-ts's src/main.ts).
- The C's `while (1) { ... Host_Frame(time); ... }` spins on Sys_FloatTime
  with no yield point of its own outside the "not time yet" `continue`
  (whose `usleep(1)` becomes `await Bun.sleep(1)` below, unchanged). A spin
  here would never hand control back to Bun's event loop, so a dedicated
  server's `Bun.udpSocket` receive callbacks (net_udp.ts) could never run
  and NET_Poll would see nothing but a permanently empty queue; the same is
  true of a future client build's SDL event pump. `await Bun.sleep(1)` after
  every `Host_Frame` call (not just on the "not time yet" branch) is this
  port's fix, on both the dedicated and listen/client paths.
- `if (time < sys_ticrate.value) { usleep(1); continue; }` -- the actual C
  condition additionally gates on `(vcrFile == -1 || recording)` (playing
  back a recorded `.vcr` file runs at max speed, ignoring sys_ticrate); this
  is ported as written, using net_main.ts's `vcrState` (`vcrFile == -1` ->
  `vcrState.playbackHandle === null`, `recording` -> `vcrState.recording`),
  which is the file's own home for those two globals (see net_main.ts's file
  header). Standing order 4 (exact fidelity) over a coordination
  brief's abbreviated pseudocode that dropped this clause.
- `parms.basedir = basedir` reads sys_linux.c's own file-scope
  `char *basedir = ".";` (line 26); ported as the literal `"."` this port's
  main() assigns, exactly as sys_linux.c's compiled-in default -- `-basedir`
  on the command line overrides it inside common.ts's COM_InitFilesystem,
  same as the C.
- `j = COM_CheckParm ("-mem"); if (j) parms.memsize = (int) (Q_atof
  (com_argv[j+1]) * 1024 * 1024);` uses `Q_atof`, not `Q_atoi` (a
  coordination brief said Q_atoi; the actual sys_linux.c source, read in
  full for this unit, uses Q_atof -- ported against the real source per
  standing order 4). The `(int)` cast's truncation is `| 0`, per
  PORTING.md's C-int-arithmetic idiom; this also reproduces the C's 32-bit
  wraparound for a `-mem` value large enough to overflow a signed int,
  which is the original's actual (undefined but reproducible-in-practice)
  behavior, not a new one.
- `net_bsd.c`'s static `net_landrivers[]` initializer (net_udp.ts's
  `udpLandriver`) is registered here, at the top of `Sys_Main_Init`, before
  `Host_Init` -- followups.md's ruling for this unit: "at program
  composition ... NOT inside NET_Init". A local `landriverRegistered` guard
  keeps a test harness that calls `Sys_Main_Init` more than once in one
  process from pushing the same driver into net_main.ts's `net_landrivers[]`
  twice; a real process only ever calls this once, same as the C's one-time
  static initialization.
- `main`'s top-level try/catch is this port's stand-in for the process
  simply calling `exit(1)` from inside `Sys_Error` (platform/sys.ts, which
  throws `SysError` instead so a caller -- here, and every test -- can
  observe it). `Sys_Error` already wrote its message to stderr and ran
  `Host_Shutdown` before throwing (see its own file), so this catch does not
  print it again; anything else escaping this far is not a modeled C exit
  path at all and gets a `Sys_Printf` + `exit(1)` of its own so a boot bug
  never hangs the process silently instead of exiting.
*/

import { COM_CheckParm, COM_InitArgv, Q_atof, com_argc, com_argv } from "./common/common";
import { Host_Frame, Host_Init, sys_ticrate } from "./common/host";
import { LINUX_VERSION, QuakeParmsT } from "./common/quakedef";
import { registerLandriver, vcrState } from "./common/net_main";
import { udpLandriver } from "./platform/net_udp";
import { Sys_FloatTime, Sys_Init, Sys_Printf, Sys_Quit, SysError, installTerminationSignals, sysState } from "./platform/sys";
// The client subsystems host.c links against. Each registers its
// hostClientHooks members at module load, so importing them here is the
// port's equivalent of the C link step; a dedicated server still runs with
// every hook absent because Host_Init only calls them on the client path.
import "./client/cl_main";
import "./client/cl_input";
import "./client/cl_parse";
import "./client/cl_tent";
import "./client/cl_demo";
import "./client/chase";
import "./client/keys";
import "./client/menu";
import "./client/sbar";
import "./client/screen";
import "./client/view";
import "./client/r_part";
import "./client/snd_dma";
// snd_linux.c and cd_linux.c, this port's src/platform/snd.ts and
// src/platform/cd_ogg.ts: they install `sndDma.current` / `cdAudio.current`
// at module load and nothing else in the tree imports them, so Host_Init's
// S_Init and CDAudio_Init would find both holders empty without these two
// lines (src/qw/main_cl.ts links the same two object files for the same
// reason). vid_x.c / in_x.c -- src/platform/vid.ts's `vidBackend.current`
// and src/platform/sdl.ts's `inputBackend.current` -- need no line of their
// own here: both renderer modules below import platform/vid.ts for
// registerRenderer, and platform/vid.ts imports platform/sdl.ts.
import "./platform/snd";
import "./platform/cd_ogg";
// The renderers register themselves with src/platform/vid.ts's registry at
// module load (the C links exactly one; this port links both and selects by
// vid_ref).
import "./ref_soft/ref_soft";
import "./ref_gl/ref_gl"; // registers itself under "gl"

let landriverRegistered = false;

/*
================
Sys_Main_Init

Everything sys_linux.c's main() does before entering its `while (1)` loop:
build quakeparms_t from argv, hand it to Host_Init, then apply the
`-nostdout` command-line switch (an `int nostdout` global in the C, not a
cvar -- see platform/sys.ts's own header).
================
*/
export function Sys_Main_Init(argv: string[]): void {
  // signal (SIGFPE, SIG_IGN); -- dropped, see file header

  const parms = new QuakeParmsT(); // memset (&parms, 0, sizeof(parms))

  COM_InitArgv(argv);
  parms.argc = com_argc;
  parms.argv = com_argv;

  parms.memsize = 8 * 1024 * 1024; // #else (non-GLQUAKE) branch of sys_linux.c's #ifdef

  const j = COM_CheckParm("-mem");
  if (j) parms.memsize = (Q_atof(com_argv[j + 1]) * 1024 * 1024) | 0; // see file header

  // parms.membase = malloc (parms.memsize); -- not applicable, see file header

  parms.basedir = "."; // sys_linux.c:26 `char *basedir = "."`, see file header
  // parms.cachedir left at null: caching is disabled by default in the C too

  // fcntl (0, F_SETFL, fcntl (0, F_GETFL, 0) | FNDELAY); -- dropped, see file header

  // net_bsd.c's static net_landrivers[] initializer -- see file header.
  if (!landriverRegistered) {
    landriverRegistered = true;
    registerLandriver(udpLandriver);
  }

  Host_Init(parms);

  Sys_Init();

  if (COM_CheckParm("-nostdout")) {
    sysState.nostdout = 1;
  } else {
    // fcntl (0, F_SETFL, fcntl (0, F_GETFL, 0) | FNDELAY); -- dropped, see file header
    Sys_Printf("Linux Quake -- Version %0.3f\n", LINUX_VERSION);
  }
}

/*
================
Sys_Main_Loop

sys_linux.c's `while (1) { ... Host_Frame(time); ... }`. Never returns in
production (`main`'s own call is the only caller outside tests); a test
drives Host_Init/Host_Frame through `runFrames` below instead of calling
this at all, so it never has to await an infinite loop.
================
*/
export async function Sys_Main_Loop(): Promise<never> {
  let oldtime = Sys_FloatTime() - 0.1;
  for (;;) {
    // find time spent rendering last frame
    const newtime = Sys_FloatTime();
    let time = newtime - oldtime;

    if (sysState.isDedicated) {
      // play vcrfiles at max speed -- see file header for the vcrState clause
      if (time < sys_ticrate.value && (vcrState.playbackHandle === null || vcrState.recording)) {
        await Bun.sleep(1); // usleep(1)
        continue; // not time to run a server only tic yet
      }
      time = sys_ticrate.value;
    }

    if (time > sys_ticrate.value * 2) oldtime = newtime;
    else oldtime += time;

    Host_Frame(time);

    // if (sys_linerefresh.value) Sys_LineRefresh(); -- sys_linux.c's own
    // Sys_LineRefresh is an empty function body, so this call has no
    // observable effect either way; dropped rather than ported as a no-op
    // call to a no-op.

    // See file header: hands the event loop back every iteration, not just
    // on the "not time yet" branch above.
    await Bun.sleep(1);
  }
}

// Synchronous frame driver, so an embedder (a test, a future tool) can step
// the server without owning the process's event loop the way Sys_Main_Loop
// does.
export function runFrames(count: number, seconds: number): void {
  for (let i = 0; i < count; i++) Host_Frame(seconds);
}

/*
================
main

sys_linux.c's process entry point. See the file header for the top-level
try/catch's role.
================
*/
export async function main(argv: string[]): Promise<void> {
  // Not in sys_linux.c -- see platform/sys.ts's installTerminationSignals
  // header for why this port installs SIGINT/SIGTERM handling anyway.
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

// bun src/main.ts +map e1m1 -> process.argv is ["bun", "src/main.ts", "+map",
// "e1m1"]; slice(1) keeps the script path as argv[0], standing in for the
// C's own argv[0] (the program path) the same way test fixtures pass
// ["quake", ...] as their own argv[0] for COM_InitArgv.
if (import.meta.main) {
  await main(process.argv.slice(1));
}
