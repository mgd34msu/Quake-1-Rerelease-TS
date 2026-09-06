/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/host.c (GNU GPL v2 or later).

host.c -- coordinates spawning and killing of local servers

Deviations from PORTING.md / the C source:
- `longjmp (host_abortserver, 1)` is a thrown HostError / HostEndGame
  (PORTING.md's idiom map). The matching `if (setjmp (host_abortserver))
  return;` is a try/catch wrapped around the whole of `_Host_Frame`'s body,
  which is exactly where the C's setjmp sits -- not around `Host_Frame`, so
  the `serverprofile` timing brackets still close on an aborted frame.
  `PRRunError` (pr_exec.ts) extends `HostError` and is caught by the same
  clause, standing in for the C's `PR_RunError -> Host_Error -> longjmp`
  chain; every other exception (`SysError` above all, which is how the
  dedicated `Sys_Error` exit path leaves the frame) rethrows.
- Every client-side call `host.c` makes (`cls.*`, `cl.*`, `CL_*`, `SCR_*`,
  `key_dest`, `M_*`, `V_Init`, `Chase_Init`, `Key_*`, `IN_*`, `VID_*`,
  `Draw_Init`, `R_Init*`, `S_*`, `CDAudio_*`, `Sbar_Init`, `Con_Init`) goes
  through the one exported `hostClientHooks` holder, whose members are named
  after the C function or field and are `null` until the owning client unit
  installs them. Every call site is `hostClientHooks.x?.(...)` with the C
  line kept beside it, so a dedicated server runs with all of them absent.
  `flushCaches`/`clearClient` (the coordinator placeholder's two members)
  keep their names.
- `cls.state == ca_dedicated` is `sysState.isDedicated` (platform/sys.ts),
  per PORTING.md's dedicated-server note; `Host_FindMaxClients` sets it and
  additionally calls the `setClsStateDedicated`/`setClsStateDisconnected`
  hooks so the client unit can keep its own `cls.state` in step.
- `S_Update (r_origin, vpn, vright, vup)` reads four renderer globals
  (`r_local.h`) that no landed module owns. They arrive through one hook,
  `rViewVectors()`, and are handed to `sUpdate` unchanged; with no hook
  installed the whole `S_Update` call is skipped, as it is on a dedicated
  server.
- `host_frametime`, `host_time`, `realtime`, `oldrealtime`, `host_framecount`,
  `host_initialized`, `host_hunklevel`, `minimum_memory` are reassigned C
  globals and are fields of the exported `host` holder.
- `host_parms`: `common.ts` already owns the `quakeparms_t` singleton
  (`COM_InitFilesystem` reads `host_parms.basedir`/`cachedir`, and common.ts
  is the more fundamental module). host.ts imports and re-exports it, and
  `Host_Init`'s `host_parms = *parms;` becomes a field-by-field copy into
  that singleton.
- `com_argc = parms->argc; com_argv = parms->argv;` in Host_Init is dropped:
  `main()` (sys_linux.c, this port's src/main.ts) has already called
  `COM_InitArgv` with the same argv, exactly as the C's main does, and
  `COM_InitArgv` is common.ts's only writer of those two globals. The one
  path where the C's copy-back is not a no-op is `-playback`, where
  `Host_InitVCR` itself replaces `com_argv`; that branch calls
  `COM_InitArgv` with the recorded argv (see Host_InitVCR).
- `Memory_Init (parms->membase, parms->memsize)` -> `Memory_Init(memsize)`:
  zone.ts's ported signature takes no base pointer (PORTING.md's zone rules).
- `Con_Printf ("Exe: "__TIME__" "__DATE__"\n")` has no TypeScript equivalent
  (no compile-time date/time macro) and is dropped rather than faked.
- `Host_WriteConfiguration`'s `fopen`/`fclose` and `Host_InitVCR`'s
  `Sys_FileOpenWrite` both go through platform/sys.ts's file layer via the
  `SysFileTextWriter` sink below (`{ write(s) }`, which is the shape
  `Cvar_WriteVariables` and `ED_Write` already take). One behavioural
  difference: `Sys_FileOpenWrite` throws `SysError` where the C's `fopen`
  returned NULL (e.g. `-game` names a directory that doesn't exist, so
  `com_gamedir` is unwritable); `Host_WriteConfiguration` catches that
  `SysError` around the open the same way the C tests `fopen`'s return
  against NULL, so `Con_Printf ("Couldn't write config.cfg.\n"); return;`
  stays reachable instead of the error propagating out through
  `Host_Shutdown`/`Sys_Quit` (see src/platform/sys.ts's
  `installTerminationSignals`, which now also survives a `quit()` that
  throws, but a config write failure during ordinary shutdown should never
  reach that far in the first place).
- `Host_InitVCR`'s `-record` branch writes the VCR header with raw
  `Sys_FileWrite` calls in the C. net_main.ts (U009) already ruled that the
  whole `quake.vcr` recording is buffered in `vcrState.writeChunks` and
  flushed once by `NET_Shutdown`; the header chunks are appended there
  instead, so they lead the same byte stream.
- `Host_ShutdownServer`'s `memset (svs.clients, 0, svs.maxclientslimit *
  sizeof(client_t))` becomes a fresh `ClientT` per slot (PORTING.md: `memset`
  -> `clear()`; `ClientT` has no `clear()`). The C's loop leaves `host_client`
  as a one-past-the-end pointer into the block it then zeroes; `svState
  .host_client` is set to `null` there instead, which is the only honest
  equivalent of a dangling pointer nothing reads.
- `net_activeconnections--` goes through net_main.ts's
  `setNetActiveConnections`, the only writer it exports for that `let`.
- `svs.clients` is handed to net_main.ts's `NetHostHooks.svsClients()` as an
  array of live getter views: `client_t` has no `frags` field (the C reads
  `client->edict->v.frags` at that one call site) and the hook interface
  needs one, so the view derives it from the edict.
- `developer` takes the non-`QUAKE2` initializer "0", and is handed to
  console.ts's `setDeveloper` where `Cvar_RegisterVariable(&developer)` runs
  (console.ts's placeholder has no other way to read it).
- `Host_FilterTime`'s `float time` parameter is a plain `number`: this port
  does not emulate C's double->float narrowing at call boundaries anywhere.
  `sys_ticrate` is registered here, as in the C, but is read only by
  sys_linux.c's `main()` loop -- src/main.ts (U036), not this file.
- Import-cycle rule (PORTING.md): `pr_exec.ts` imports `HostError` from here,
  so nothing this module's *body* pulls in may reach `pr_exec.ts` /
  `pr_cmds.ts` -- if it did, entering the graph at `pr_exec.ts` would run
  `pr_cmds.ts`'s top-level `setBuiltins(pr_builtin)` while `pr_exec.ts`'s own
  `let pr_builtins` was still in its temporal dead zone. host.c is the less
  fundamental half of every one of those cycles, so the six modules that
  reach `pr_exec.ts` -- `../server/sv_main`, `../server/sv_phys`,
  `../server/sv_user`, `../progs/pr_edict`, `../progs/pr_exec` and
  `./host_cmd` -- are resolved lazily with Bun's synchronous `require()`
  (`svMainMod()`/`svPhysMod()`/`svUserMod()`/`prEdictMod()`/`prExecMod()`/
  `hostCmdMod()` below), the same mechanism net_main.ts uses for net_loop.ts
  and net_dgrm.ts. Type-only imports stay static.
- `Host_Shutdown`'s bare `printf ("recursive shutdown\n")` becomes
  `Sys_Printf`: PORTING.md allows no print outside `src/platform/sys.ts`'s
  boundary, and `Sys_Printf` is that boundary.
- `#ifdef FPS_20`'s `_Host_ServerFrame` / sub-stepped `Host_ServerFrame`,
  `#ifdef QUAKE2`'s `developer` default, and the `_WIN32`/`GLQUAKE` ordering
  branches inside `Host_Init`'s client block are the dropped `#ifdef`s.
*/

import { CvarT, Cvar_RegisterVariable, Cvar_SetValue, Cvar_WriteVariables, setCvarServerHooks } from "./cvar";
import { Com_sprintf } from "./sprintf";
import { Con_Printf, Con_DPrintf, Con_Init, setDeveloper } from "../client/console";
import {
  Sys_Error,
  Sys_FileClose,
  Sys_FileOpenRead,
  Sys_FileOpenWrite,
  Sys_FileRead,
  Sys_FileWrite,
  Sys_FloatTime,
  Sys_ConsoleInput,
  Sys_Printf,
  Sys_SendKeyEvents,
  setHostShutdown,
  sysState,
  SysError,
} from "../platform/sys";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteString, SZ_Clear, SizeBuf } from "./sizebuf";
import { SvcOpsT } from "./protocol";
import { Hunk_AllocName, Hunk_FreeToLowMark, Hunk_LowMark, Memory_Init } from "./zone";
import { Mod_ClearAll, Mod_Init, type ModelT } from "./model";
import { ClientT, sv, svState, svs } from "../server/server";
import type * as SvMainModule from "../server/sv_main";
import type * as SvPhysModule from "../server/sv_phys";
import type * as SvUserModule from "../server/sv_user";
import type * as PrEdictModule from "../progs/pr_edict";
import type * as PrExecModule from "../progs/pr_exec";
import type * as HostCmdModule from "./host_cmd";
import { EDICT_TO_PROG, pr } from "../progs/progs";
import type { GlobalVars } from "../progs/progdefs";
import { Cbuf_Execute, Cbuf_AddText, Cbuf_InsertText, Cbuf_Init, Cmd_Init, cmdHost } from "./cmd";
import {
  COM_CheckParm,
  COM_Init,
  COM_InitArgv,
  COM_LoadHunkFile,
  Q_atoi,
  com_argc,
  com_argv,
  com_gamedir,
  host_parms,
  standard_quake,
} from "./common";
import {
  NET_CanSendMessage,
  NET_Close,
  NET_GetMessage,
  NET_Init,
  NET_Poll,
  NET_SendMessage,
  NET_SendToAll,
  NET_Shutdown,
  net_activeconnections,
  setNetActiveConnections,
  setNetHostHooks,
  vcrState,
  type NetSvsClientT,
} from "./net_main";
import { MAX_SCOREBOARD, MINIMUM_MEMORY, MINIMUM_MEMORY_LEVELPAK, qw, type QuakeParmsT } from "./quakedef";
import { W_LoadWadFile } from "./wad";
import type { Vec3 } from "./mathlib";
import { vec3_origin } from "./mathlib";

// see the file header's import-cycle note
function svMainMod(): typeof SvMainModule {
  return require("../server/sv_main");
}
function svPhysMod(): typeof SvPhysModule {
  return require("../server/sv_phys");
}
function svUserMod(): typeof SvUserModule {
  return require("../server/sv_user");
}
function prEdictMod(): typeof PrEdictModule {
  return require("../progs/pr_edict");
}
function prExecMod(): typeof PrExecModule {
  return require("../progs/pr_exec");
}
function hostCmdMod(): typeof HostCmdModule {
  return require("./host_cmd");
}

export { host_parms };

/*

A server can allways be started, even if the system started out as a client
to a remote system.

A client can NOT be started if the system started as a dedicated server.

Memory is cleared / released when a server or client begins, not when they end.

*/

//============================================================================
// the client seam -- see the file header

export interface RViewVectors {
  origin: Vec3; // r_origin
  forward: Vec3; // vpn
  right: Vec3; // vright
  up: Vec3; // vup
}

export interface HostClientHooks {
  flushCaches: (() => void) | null; // D_FlushCaches
  clearClient: (() => void) | null; // cls.signon = 0; memset (&cl, 0, sizeof(cl))

  clDisconnect: (() => void) | null; // CL_Disconnect
  clDisconnectF: (() => void) | null; // CL_Disconnect_f
  clEstablishConnection: ((name: string) => void) | null; // CL_EstablishConnection
  clNextDemo: (() => void) | null; // CL_NextDemo
  clStopPlayback: (() => void) | null; // CL_StopPlayback
  clSendCmd: (() => void) | null; // CL_SendCmd
  clReadFromServer: (() => void) | null; // CL_ReadFromServer
  clDecayLights: (() => void) | null; // CL_DecayLights
  clInit: (() => void) | null; // CL_Init

  clsStateConnected: (() => boolean) | null; // cls.state == ca_connected
  setClsStateDedicated: (() => void) | null; // cls.state = ca_dedicated
  setClsStateDisconnected: (() => void) | null; // cls.state = ca_disconnected
  clsTimedemo: (() => boolean) | null; // cls.timedemo
  clsDemoplayback: (() => boolean) | null; // cls.demoplayback
  clsSignonComplete: (() => boolean) | null; // cls.signon == SIGNONS
  clsSignonZero: (() => void) | null; // cls.signon = 0
  clsDemonum: (() => number) | null; // cls.demonum
  setClsDemonum: ((n: number) => void) | null; // cls.demonum = n
  setClsDemos: ((i: number, name: string) => void) | null; // strncpy (cls.demos[i], ...)
  setClsMapstring: ((s: string) => void) | null; // cls.mapstring
  setClsSpawnparms: ((s: string) => void) | null; // cls.spawnparms

  clIntermission: (() => number) | null; // cl.intermission
  clLevelname: (() => string) | null; // cl.levelname
  clStat: ((n: number) => number) | null; // cl.stats[n]
  clModelPrecache: ((n: number) => ModelT | null) | null; // cl.model_precache[n]
  setClModelPrecache: ((n: number, m: ModelT) => void) | null; // cl.model_precache[n] = m
  clNameString: (() => string) | null; // cl_name.string
  clColorValue: (() => number) | null; // cl_color.value

  keyDestIsGame: (() => boolean) | null; // key_dest == key_game
  keyDestIsConsole: (() => boolean) | null; // key_dest == key_console
  setKeyDestGame: (() => void) | null; // key_dest = key_game
  keyWriteBindings: ((f: { write(s: string): void }) => void) | null; // Key_WriteBindings
  keyInit: (() => void) | null; // Key_Init

  scrBeginLoadingPlaque: (() => void) | null; // SCR_BeginLoadingPlaque
  scrEndLoadingPlaque: (() => void) | null; // SCR_EndLoadingPlaque
  scrUpdateScreen: (() => void) | null; // SCR_UpdateScreen
  scrDisableForLoading: (() => void) | null; // scr_disabled_for_loading = true
  scrInit: (() => void) | null; // SCR_Init

  mInit: (() => void) | null; // M_Init
  mMenuQuitF: (() => void) | null; // M_Menu_Quit_f

  vInit: (() => void) | null; // V_Init
  chaseInit: (() => void) | null; // Chase_Init
  conInit: (() => void) | null; // Con_Init
  inInit: (() => void) | null; // IN_Init
  inCommands: (() => void) | null; // IN_Commands
  inShutdown: (() => void) | null; // IN_Shutdown
  vidInit: ((palette: Uint8Array) => void) | null; // VID_Init
  vidShutdown: (() => void) | null; // VID_Shutdown
  drawInit: (() => void) | null; // Draw_Init
  rInit: (() => void) | null; // R_Init
  rInitTextures: (() => void) | null; // R_InitTextures
  rViewVectors: (() => RViewVectors) | null; // r_origin / vpn / vright / vup
  sInit: (() => void) | null; // S_Init
  sUpdate: ((origin: Vec3, forward: Vec3, right: Vec3, up: Vec3) => void) | null; // S_Update
  sShutdown: (() => void) | null; // S_Shutdown
  cdaudioInit: (() => number) | null; // CDAudio_Init
  cdaudioUpdate: (() => void) | null; // CDAudio_Update
  cdaudioShutdown: (() => void) | null; // CDAudio_Shutdown
  sbarInit: (() => void) | null; // Sbar_Init
}

export const hostClientHooks: HostClientHooks = {
  flushCaches: null,
  clearClient: null,

  clDisconnect: null,
  clDisconnectF: null,
  clEstablishConnection: null,
  clNextDemo: null,
  clStopPlayback: null,
  clSendCmd: null,
  clReadFromServer: null,
  clDecayLights: null,
  clInit: null,

  clsStateConnected: null,
  setClsStateDedicated: null,
  setClsStateDisconnected: null,
  clsTimedemo: null,
  clsDemoplayback: null,
  clsSignonComplete: null,
  clsSignonZero: null,
  clsDemonum: null,
  setClsDemonum: null,
  setClsDemos: null,
  setClsMapstring: null,
  setClsSpawnparms: null,

  clIntermission: null,
  clLevelname: null,
  clStat: null,
  clModelPrecache: null,
  setClModelPrecache: null,
  clNameString: null,
  clColorValue: null,

  keyDestIsGame: null,
  keyDestIsConsole: null,
  setKeyDestGame: null,
  keyWriteBindings: null,
  keyInit: null,

  scrBeginLoadingPlaque: null,
  scrEndLoadingPlaque: null,
  scrUpdateScreen: null,
  scrDisableForLoading: null,
  scrInit: null,

  mInit: null,
  mMenuQuitF: null,

  vInit: null,
  chaseInit: null,
  conInit: null,
  inInit: null,
  inCommands: null,
  inShutdown: null,
  vidInit: null,
  vidShutdown: null,
  drawInit: null,
  rInit: null,
  rInitTextures: null,
  rViewVectors: null,
  sInit: null,
  sUpdate: null,
  sShutdown: null,
  cdaudioInit: null,
  cdaudioUpdate: null,
  cdaudioShutdown: null,
  sbarInit: null,
};

//============================================================================

// `FILE *f` destinations: Key_WriteBindings/Cvar_WriteVariables (config.cfg)
// and ED_Write/ED_WriteGlobals (savegames) both take `{ write(s) }`.
export class SysFileTextWriter {
  handle: number;
  constructor(handle: number) {
    this.handle = handle;
  }
  write(s: string): void {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    Sys_FileWrite(this.handle, bytes, bytes.length);
  }
}

export const host = {
  initialized: false, // true if into command execution
  frametime: 0,
  time: 0,
  realtime: 0, // without any filtering or bounding
  oldrealtime: 0, // last frame run
  framecount: 0,
  hunklevel: 0,
  minimum_memory: 0,
};

// byte *host_basepal; byte *host_colormap;
export let host_basepal: Uint8Array | null = null;
export let host_colormap: Uint8Array | null = null;

// `host_basepal` and `host_colormap` are one C global each, but this port has
// two holders for each: these, filled by this file's Host_Init on the WinQuake
// track, and src/qw/client/cl_main.ts's `{ data }` boxes, filled by qwcl's own
// Host_Init. Every module that runs in BOTH binaries -- the two renderers,
// src/platform/vid.ts, src/client/screen.ts -- must read them through these two
// accessors, never through the bindings above: under qwcl the WinQuake binding
// is null, which silently degrades (Draw_Fill painted every scoreboard colour
// block white that way). `realtime`, `host_frametime` and `host_framecount` do
// not need this -- qwcl's Host_Frame mirrors those into the shared `host`
// holder above, so there is already one home for them.
//
// cl_main.ts imports this module, so the back-reference is a genuine load-time
// cycle and is resolved with the same lazy `require()` this file already uses
// for its server-side siblings.
import type * as QwClMainModule from "../qw/client/cl_main";

function qwClMainMod(): typeof QwClMainModule {
  return require("../qw/client/cl_main");
}

export function hostBasepal(): Uint8Array | null {
  return qw.active ? qwClMainMod().host_basepal.data : host_basepal;
}

export function hostColormap(): Uint8Array | null {
  return qw.active ? qwClMainMod().host_colormap.data : host_colormap;
}

export const host_framerate = new CvarT("host_framerate", "0"); // set for slow motion
export const host_speeds = new CvarT("host_speeds", "0"); // set for running times

export const sys_ticrate = new CvarT("sys_ticrate", "0.05");
export const serverprofile = new CvarT("serverprofile", "0");

export const fraglimit = new CvarT("fraglimit", "0", false, true);
export const timelimit = new CvarT("timelimit", "0", false, true);
export const teamplay = new CvarT("teamplay", "0", false, true);

export const samelevel = new CvarT("samelevel", "0");
export const noexit = new CvarT("noexit", "0", false, true);

export const developer = new CvarT("developer", "0");

export const skill = new CvarT("skill", "1"); // 0 - 3
export const deathmatch = new CvarT("deathmatch", "0"); // 0, 1, or 2
export const coop = new CvarT("coop", "0"); // 0 or 1

export const pausable = new CvarT("pausable", "1");

export const temp1 = new CvarT("temp1", "0");

export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

export class HostEndGame extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostEndGame";
  }
}

function globalStruct(): GlobalVars {
  if (pr.global_struct === null) Sys_Error("host: pr.global_struct not set (PR_LoadProgs not called)");
  return pr.global_struct;
}

/*
================
Host_EndGame
================
*/
export function Host_EndGame(message: string, ...args: Array<string | number>): never {
  const string = Com_sprintf(message, ...args);
  Con_DPrintf("Host_EndGame: %s\n", string);

  if (sv.active) Host_ShutdownServer(false);

  if (sysState.isDedicated) Sys_Error("Host_EndGame: %s\n", string); // dedicated servers exit

  if ((hostClientHooks.clsDemonum?.() ?? -1) !== -1) hostClientHooks.clNextDemo?.();
  else hostClientHooks.clDisconnect?.();

  throw new HostEndGame(string); // longjmp (host_abortserver, 1)
}

/*
================
Host_Error

This shuts down both the client and server
================
*/
let inerror = false;

export function Host_Error(error: string, ...args: Array<string | number>): never {
  if (inerror) Sys_Error("Host_Error: recursively entered");
  inerror = true;

  hostClientHooks.scrEndLoadingPlaque?.(); // reenable screen updates

  const string = Com_sprintf(error, ...args);
  Con_Printf("Host_Error: %s\n", string);

  if (sv.active) Host_ShutdownServer(false);

  if (sysState.isDedicated) Sys_Error("Host_Error: %s\n", string); // dedicated servers exit

  hostClientHooks.clDisconnect?.();
  hostClientHooks.setClsDemonum?.(-1);

  inerror = false;

  throw new HostError(string); // longjmp (host_abortserver, 1)
}

/*
================
Host_FindMaxClients
================
*/
export function Host_FindMaxClients(): void {
  svs.maxclients = 1;

  let i = COM_CheckParm("-dedicated");
  if (i) {
    sysState.isDedicated = true; // cls.state = ca_dedicated
    hostClientHooks.setClsStateDedicated?.();
    if (i !== com_argc - 1) {
      svs.maxclients = Q_atoi(com_argv[i + 1]);
    } else svs.maxclients = 8;
  } else {
    sysState.isDedicated = false;
    hostClientHooks.setClsStateDisconnected?.(); // cls.state = ca_disconnected
  }

  i = COM_CheckParm("-listen");
  if (i) {
    if (sysState.isDedicated) Sys_Error("Only one of -dedicated or -listen can be specified");
    if (i !== com_argc - 1) svs.maxclients = Q_atoi(com_argv[i + 1]);
    else svs.maxclients = 8;
  }
  if (svs.maxclients < 1) svs.maxclients = 8;
  else if (svs.maxclients > MAX_SCOREBOARD) svs.maxclients = MAX_SCOREBOARD;

  svs.maxclientslimit = svs.maxclients;
  if (svs.maxclientslimit < 4) svs.maxclientslimit = 4;
  // Hunk_AllocName (svs.maxclientslimit*sizeof(client_t), "clients")
  svs.clients = Array.from({ length: svs.maxclientslimit }, () => new ClientT());

  if (svs.maxclients > 1) Cvar_SetValue("deathmatch", 1.0);
  else Cvar_SetValue("deathmatch", 0.0);
}

/*
=======================
Host_InitLocal
======================
*/
export function Host_InitLocal(): void {
  hostCmdMod().Host_InitCommands();

  Cvar_RegisterVariable(host_framerate);
  Cvar_RegisterVariable(host_speeds);

  Cvar_RegisterVariable(sys_ticrate);
  Cvar_RegisterVariable(serverprofile);

  Cvar_RegisterVariable(fraglimit);
  Cvar_RegisterVariable(timelimit);
  Cvar_RegisterVariable(teamplay);
  Cvar_RegisterVariable(samelevel);
  Cvar_RegisterVariable(noexit);
  Cvar_RegisterVariable(skill);
  Cvar_RegisterVariable(developer);
  setDeveloper(developer); // console.ts's placeholder has no other route to developer.value
  Cvar_RegisterVariable(deathmatch);
  Cvar_RegisterVariable(coop);

  Cvar_RegisterVariable(pausable);

  Cvar_RegisterVariable(temp1);

  Host_FindMaxClients();

  host.time = 1.0; // so a think at time 0 won't get called
}

/*
===============
Host_WriteConfiguration

Writes key bindings and archived cvars to config.cfg
===============
*/
export function Host_WriteConfiguration(): void {
  // dedicated servers initialize the host but don't parse and set the
  // config.cfg cvars
  if (host.initialized && !sysState.isDedicated) {
    let handle: number;
    try {
      // f = fopen (va("%s/config.cfg",com_gamedir), "w");
      handle = Sys_FileOpenWrite(Com_sprintf("%s/config.cfg", com_gamedir));
    } catch (err) {
      if (!(err instanceof SysError)) throw err;
      // if (!f) { Con_Printf ("Couldn't write config.cfg.\n"); return; }
      Con_Printf("Couldn't write config.cfg.\n");
      return;
    }
    if (handle === -1) {
      Con_Printf("Couldn't write config.cfg.\n");
      return;
    }
    const f = new SysFileTextWriter(handle);

    hostClientHooks.keyWriteBindings?.(f);
    Cvar_WriteVariables(f);

    Sys_FileClose(handle);
  }
}

/*
=================
SV_ClientPrintf

Sends text across to be displayed
FIXME: make this just a stuffed echo?
=================
*/
export function SV_ClientPrintf(fmt: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(fmt, ...args);

  const host_client = svState.host_client;
  if (host_client === null) Sys_Error("SV_ClientPrintf: no host_client");
  MSG_WriteByte(host_client.message, SvcOpsT.svc_print);
  MSG_WriteString(host_client.message, string);
}

/*
=================
SV_BroadcastPrintf

Sends text to all active clients
=================
*/
export function SV_BroadcastPrintf(fmt: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(fmt, ...args);

  for (let i = 0; i < svs.maxclients; i++)
    if (svs.clients[i].active && svs.clients[i].spawned) {
      MSG_WriteByte(svs.clients[i].message, SvcOpsT.svc_print);
      MSG_WriteString(svs.clients[i].message, string);
    }
}

/*
=================
Host_ClientCommands

Send text over to the client to be executed
=================
*/
export function Host_ClientCommands(fmt: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(fmt, ...args);

  const host_client = svState.host_client;
  if (host_client === null) Sys_Error("Host_ClientCommands: no host_client");
  MSG_WriteByte(host_client.message, SvcOpsT.svc_stufftext);
  MSG_WriteString(host_client.message, string);
}

/*
=====================
SV_DropClient

Called when the player is getting totally kicked off the host
if (crash = true), don't bother sending signofs
=====================
*/
export function SV_DropClient(crash: boolean): void {
  const host_client = svState.host_client;
  if (host_client === null) Sys_Error("SV_DropClient: no host_client");

  if (!crash) {
    // send any final messages (don't check for errors)
    if (NET_CanSendMessage(host_client.netconnection)) {
      MSG_WriteByte(host_client.message, SvcOpsT.svc_disconnect);
      NET_SendMessage(host_client.netconnection, host_client.message);
    }

    if (host_client.edict !== null && host_client.spawned) {
      // call the prog function for removing a client
      // this will set the body to a dead frame, among other things
      const saveSelf = globalStruct().self;
      globalStruct().self = EDICT_TO_PROG(host_client.edict);
      prExecMod().PR_ExecuteProgram(globalStruct().ClientDisconnect);
      globalStruct().self = saveSelf;
    }

    Sys_Printf("Client %s removed\n", host_client.name);
  }

  // break the net connection
  NET_Close(host_client.netconnection);
  host_client.netconnection = null;

  // free the client (the body stays around)
  host_client.active = false;
  host_client.name = "";
  host_client.old_frags = -999999;
  setNetActiveConnections(net_activeconnections - 1);

  // send notification to all clients
  const clientnum = svs.clients.indexOf(host_client); // host_client - svs.clients
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (!client.active) continue;
    MSG_WriteByte(client.message, SvcOpsT.svc_updatename);
    MSG_WriteByte(client.message, clientnum);
    MSG_WriteString(client.message, "");
    MSG_WriteByte(client.message, SvcOpsT.svc_updatefrags);
    MSG_WriteByte(client.message, clientnum);
    MSG_WriteShort(client.message, 0);
    MSG_WriteByte(client.message, SvcOpsT.svc_updatecolors);
    MSG_WriteByte(client.message, clientnum);
    MSG_WriteByte(client.message, 0);
  }
}

/*
==================
Host_ShutdownServer

This only happens at the end of a game, not between levels
==================
*/
export function Host_ShutdownServer(crash: boolean): void {
  if (!sv.active) return;

  sv.active = false;

  // stop all client sounds immediately
  if (hostClientHooks.clsStateConnected?.() ?? false) hostClientHooks.clDisconnect?.();

  // flush any pending messages - like the score!!!
  const start = Sys_FloatTime();
  let count = 0;
  do {
    count = 0;
    for (let i = 0; i < svs.maxclients; i++) {
      const host_client = svs.clients[i];
      svState.host_client = host_client;
      if (host_client.active && host_client.message.cursize) {
        if (NET_CanSendMessage(host_client.netconnection)) {
          NET_SendMessage(host_client.netconnection, host_client.message);
          SZ_Clear(host_client.message);
        } else {
          NET_GetMessage(host_client.netconnection);
          count++;
        }
      }
    }
    if (Sys_FloatTime() - start > 3.0) break;
  } while (count);

  // make sure all the clients know we're disconnecting
  const message = new Uint8Array(4);
  const buf = new SizeBuf();
  buf.data = message;
  buf.maxsize = 4;
  buf.cursize = 0;
  MSG_WriteByte(buf, SvcOpsT.svc_disconnect);
  count = NET_SendToAll(buf, 5);
  if (count) Con_Printf("Host_ShutdownServer: NET_SendToAll failed for %u clients\n", count);

  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;
    if (host_client.active) SV_DropClient(crash);
  }

  //
  // clear structures
  //
  sv.clear(); // memset (&sv, 0, sizeof(sv))
  // memset (svs.clients, 0, svs.maxclientslimit*sizeof(client_t)) -- see the
  // file header for host_client, which the C leaves one past the end here.
  for (let i = 0; i < svs.maxclientslimit; i++) svs.clients[i] = new ClientT();
  svState.host_client = null;
}

/*
================
Host_ClearMemory

This clears all the memory used by both the client and server, but does
not reinitialize anything.
================
*/
export function Host_ClearMemory(): void {
  Con_DPrintf("Clearing memory\n");
  hostClientHooks.flushCaches?.(); // D_FlushCaches
  Mod_ClearAll();
  if (host.hunklevel) Hunk_FreeToLowMark(host.hunklevel);

  hostClientHooks.clearClient?.(); // cls.signon = 0; memset (&cl, 0, sizeof(cl))
  sv.clear();
}

//============================================================================

/*
===================
Host_FilterTime

Returns false if the time is too short to run a frame
===================
*/
export function Host_FilterTime(time: number): boolean {
  host.realtime += time;

  if (!(hostClientHooks.clsTimedemo?.() ?? false) && host.realtime - host.oldrealtime < 1.0 / 72.0) return false; // framerate is too high

  host.frametime = host.realtime - host.oldrealtime;
  host.oldrealtime = host.realtime;

  if (host_framerate.value > 0) host.frametime = host_framerate.value;
  else {
    // don't allow really long or short frames
    if (host.frametime > 0.1) host.frametime = 0.1;
    if (host.frametime < 0.001) host.frametime = 0.001;
  }

  return true;
}

/*
===================
Host_GetConsoleCommands

Add them exactly as if they had been typed at the console
===================
*/
export function Host_GetConsoleCommands(): void {
  while (true) {
    const cmd = Sys_ConsoleInput();
    if (cmd === null) break;
    Cbuf_AddText(cmd);
  }
}

/*
==================
Host_ServerFrame

==================
*/
export function Host_ServerFrame(): void {
  // run the world state
  globalStruct().frametime = host.frametime;

  // set the time and clear the general datagram
  svMainMod().SV_ClearDatagram();

  // check for new clients
  svMainMod().SV_CheckForNewClients();

  // read client messages
  svUserMod().SV_RunClients();

  // move things around and think
  // always pause in single player if in console or menus
  if (!sv.paused && (svs.maxclients > 1 || (hostClientHooks.keyDestIsGame?.() ?? true))) svPhysMod().SV_Physics();

  // send all messages to the clients
  svMainMod().SV_SendClientMessages();
}

/*
==================
Host_Frame

Runs all active servers
==================
*/
let time1 = 0;
let time2 = 0;
let time3 = 0;

export function _Host_Frame(time: number): void {
  try {
    // keep the random time dependent
    Math.random(); // rand ()

    // decide the simulation time
    if (!Host_FilterTime(time)) return; // don't run too fast, or packets will flood out

    // get new key events
    Sys_SendKeyEvents();

    // allow mice or other external controllers to add commands
    hostClientHooks.inCommands?.(); // IN_Commands

    // process console commands
    Cbuf_Execute();

    NET_Poll();

    // if running the server locally, make intentions now
    if (sv.active) hostClientHooks.clSendCmd?.(); // CL_SendCmd

    //-------------------
    //
    // server operations
    //
    //-------------------

    // check for commands typed to the host
    Host_GetConsoleCommands();

    if (sv.active) Host_ServerFrame();

    //-------------------
    //
    // client operations
    //
    //-------------------

    // if running the server remotely, send intentions now after
    // the incoming messages have been read
    if (!sv.active) hostClientHooks.clSendCmd?.(); // CL_SendCmd

    host.time += host.frametime;

    // fetch results from server
    if (hostClientHooks.clsStateConnected?.() ?? false) {
      hostClientHooks.clReadFromServer?.(); // CL_ReadFromServer
    }

    // update video
    if (host_speeds.value) time1 = Sys_FloatTime();

    hostClientHooks.scrUpdateScreen?.(); // SCR_UpdateScreen

    if (host_speeds.value) time2 = Sys_FloatTime();

    // update audio
    if (hostClientHooks.clsSignonComplete?.() ?? false) {
      const v = hostClientHooks.rViewVectors?.(); // r_origin, vpn, vright, vup
      if (v) hostClientHooks.sUpdate?.(v.origin, v.forward, v.right, v.up);
      hostClientHooks.clDecayLights?.();
    } else hostClientHooks.sUpdate?.(vec3_origin, vec3_origin, vec3_origin, vec3_origin);

    hostClientHooks.cdaudioUpdate?.(); // CDAudio_Update

    if (host_speeds.value) {
      const pass1 = ((time1 - time3) * 1000) | 0;
      time3 = Sys_FloatTime();
      const pass2 = ((time2 - time1) * 1000) | 0;
      const pass3 = ((time3 - time2) * 1000) | 0;
      Con_Printf("%3i tot %3i server %3i gfx %3i snd\n", pass1 + pass2 + pass3, pass1, pass2, pass3);
    }

    host.framecount++;
  } catch (e) {
    // if (setjmp (host_abortserver)) return; -- something bad happened, or
    // the server disconnected
    if (e instanceof HostError || e instanceof HostEndGame) return;
    throw e;
  }
}

let timetotal = 0;
let timecount = 0;

export function Host_Frame(time: number): void {
  if (!serverprofile.value) {
    _Host_Frame(time);
    return;
  }

  const t1 = Sys_FloatTime();
  _Host_Frame(time);
  const t2 = Sys_FloatTime();

  timetotal += t2 - t1;
  timecount++;

  if (timecount < 1000) return;

  const m = ((timetotal * 1000) / timecount) | 0;
  timecount = 0;
  timetotal = 0;
  let c = 0;
  for (let i = 0; i < svs.maxclients; i++) {
    if (svs.clients[i].active) c++;
  }

  Con_Printf("serverprofile: %2i clients %2i msec\n", c, m);
}

//============================================================================

export const VCR_SIGNATURE = 0x56435231;
// "VCR1"

export function Host_InitVCR(parms: QuakeParmsT): void {
  if (COM_CheckParm("-playback")) {
    if (com_argc !== 2) Sys_Error("No other parameters allowed with -playback\n");

    const opened = Sys_FileOpenRead("quake.vcr");
    vcrState.playbackHandle = opened.handle;
    if (opened.handle === -1) Sys_Error("playback file not found\n");

    const word = new Uint8Array(4);
    const wordView = new DataView(word.buffer);
    Sys_FileRead(opened.handle, word, 4);
    if (wordView.getInt32(0, true) !== VCR_SIGNATURE) Sys_Error("Invalid signature in vcr file\n");

    Sys_FileRead(opened.handle, word, 4);
    const argc = wordView.getInt32(0, true);
    const argv: string[] = [parms.argv[0] ?? ""];
    for (let i = 0; i < argc; i++) {
      Sys_FileRead(opened.handle, word, 4);
      const len = wordView.getInt32(0, true);
      const p = new Uint8Array(len);
      Sys_FileRead(opened.handle, p, len);
      let s = "";
      for (let k = 0; k < len && p[k] !== 0; k++) s += String.fromCharCode(p[k]);
      argv[i + 1] = s;
    }
    // com_argv = <the recorded argv>; com_argc++ (for arg[0]) -- see the file
    // header: COM_InitArgv is common.ts's only writer of com_argc/com_argv.
    COM_InitArgv(argv);
    parms.argc = com_argc;
    parms.argv = com_argv;
  }

  const n = COM_CheckParm("-record");
  if (n !== 0) {
    // vcrFile = Sys_FileOpenWrite("quake.vcr") -- the recording is buffered
    // in net_main.ts's vcrState and flushed by NET_Shutdown (see the header)
    const header: Uint8Array[] = [];
    header.push(int32Bytes(VCR_SIGNATURE));
    header.push(int32Bytes(com_argc - 1));
    for (let i = 1; i < com_argc; i++) {
      if (i === n) {
        const len = 10;
        header.push(int32Bytes(len));
        header.push(latin1Bytes("-playback", len));
        continue;
      }
      const len = com_argv[i].length + 1;
      header.push(int32Bytes(len));
      header.push(latin1Bytes(com_argv[i], len));
    }
    vcrState.writeChunks.unshift(...header);
  }
}

function int32Bytes(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, v, true);
  return out;
}

function latin1Bytes(s: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < s.length && i < size; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// see the file header: `svs.clients` as net_main.ts's NetSvsClientT[], live.
function netSvsClientView(c: ClientT): NetSvsClientT {
  return {
    get active(): boolean {
      return c.active;
    },
    get name(): string {
      return c.name;
    },
    get colors(): number {
      return c.colors;
    },
    get frags(): number {
      return c.edict === null ? 0 : c.edict.v.frags; // client->edict->v.frags
    },
    get netconnection() {
      return c.netconnection;
    },
  };
}

/*
====================
Host_Init
====================
*/
export function Host_Init(parms: QuakeParmsT): void {
  // The C resolves these at link time; this port installs them at the top of
  // Host_Init, the earliest point every module in the cycle exists.
  setHostShutdown(Host_Shutdown);
  svMainMod().svMainHooks.dropClient = SV_DropClient;
  setCvarServerHooks({ active: () => sv.active, broadcastPrintf: SV_BroadcastPrintf });
  setNetHostHooks({
    svActive: () => sv.active,
    svName: () => sv.name,
    svsMaxclients: () => svs.maxclients,
    svsMaxclientslimit: () => svs.maxclientslimit,
    setSvsMaxclients: (n: number) => {
      svs.maxclients = n;
    },
    clsStateDedicated: () => sysState.isDedicated,
    svsClients: () => svs.clients.map(netSvsClientView),
    deathmatch: () => (pr.global_struct === null ? false : pr.global_struct.deathmatch !== 0),
    hostClientPrivileged: () => svState.host_client !== null && svState.host_client.privileged,
    svClientPrintf: SV_ClientPrintf,
    scrUpdateScreen: () => {
      hostClientHooks.scrUpdateScreen?.();
    },
    menuSetReturnReason: () => {},
    menuHandleConnectError: () => {},
    menuConnectSucceeded: () => {},
    hostTime: () => host.time,
  });

  if (standard_quake) host.minimum_memory = MINIMUM_MEMORY;
  else host.minimum_memory = MINIMUM_MEMORY_LEVELPAK;

  if (COM_CheckParm("-minmemory")) parms.memsize = host.minimum_memory;

  // host_parms = *parms -- see the file header (common.ts owns the singleton)
  host_parms.basedir = parms.basedir;
  host_parms.cachedir = parms.cachedir;
  host_parms.argc = parms.argc;
  host_parms.argv = parms.argv;
  host_parms.membase = parms.membase;
  host_parms.memsize = parms.memsize;

  if (parms.memsize < host.minimum_memory) Sys_Error("Only %4.1f megs of memory available, can't execute game", parms.memsize / 0x100000);

  Memory_Init(parms.memsize);
  Cbuf_Init();
  Cmd_Init();
  hostClientHooks.vInit?.(); // V_Init
  hostClientHooks.chaseInit?.(); // Chase_Init
  Host_InitVCR(parms);
  COM_Init(parms.basedir);
  Host_InitLocal();
  W_LoadWadFile("gfx.wad");
  hostClientHooks.keyInit?.(); // Key_Init
  Con_Init(); // console.ts is a load-time leaf and cannot register a hook; called directly as host.c does
  hostClientHooks.mInit?.(); // M_Init
  prEdictMod().PR_Init();
  Mod_Init();
  NET_Init();
  svMainMod().SV_Init();

  Con_Printf("%4.1f megabyte heap\n", parms.memsize / (1024 * 1024.0));

  hostClientHooks.rInitTextures?.(); // R_InitTextures -- needed even for dedicated servers

  if (!sysState.isDedicated) {
    host_basepal = COM_LoadHunkFile("gfx/palette.lmp");
    if (!host_basepal) Sys_Error("Couldn't load gfx/palette.lmp");
    host_colormap = COM_LoadHunkFile("gfx/colormap.lmp");
    if (!host_colormap) Sys_Error("Couldn't load gfx/colormap.lmp");

    // on non win32, mouse comes before video for security reasons
    hostClientHooks.inInit?.(); // IN_Init
    hostClientHooks.vidInit?.(host_basepal); // VID_Init

    hostClientHooks.drawInit?.(); // Draw_Init
    hostClientHooks.scrInit?.(); // SCR_Init
    hostClientHooks.rInit?.(); // R_Init
    // on Win32, sound initialization has to come before video initialization, so we
    // can put up a popup if the sound hardware is in use
    hostClientHooks.sInit?.(); // S_Init
    hostClientHooks.cdaudioInit?.(); // CDAudio_Init
    hostClientHooks.sbarInit?.(); // Sbar_Init
    hostClientHooks.clInit?.(); // CL_Init
  }

  Cbuf_InsertText("exec quake.rc\n");

  Hunk_AllocName(0, "-HOST_HUNKLEVEL-");
  host.hunklevel = Hunk_LowMark();

  host.initialized = true;
  cmdHost.initialized = true;

  Sys_Printf("========Quake Initialized=========\n");
}

/*
===============
Host_Shutdown

FIXME: this is a callback from Sys_Quit and Sys_Error.  It would be better
to run quit through here before the final handoff to the sys code.
===============
*/
let isdown = false;

export function Host_Shutdown(): void {
  if (isdown) {
    Sys_Printf("recursive shutdown\n");
    return;
  }
  isdown = true;

  // keep Con_Printf from trying to update the screen
  hostClientHooks.scrDisableForLoading?.(); // scr_disabled_for_loading = true

  Host_WriteConfiguration();

  hostClientHooks.cdaudioShutdown?.(); // CDAudio_Shutdown
  NET_Shutdown();
  hostClientHooks.sShutdown?.(); // S_Shutdown
  hostClientHooks.inShutdown?.(); // IN_Shutdown

  if (!sysState.isDedicated) {
    hostClientHooks.vidShutdown?.(); // VID_Shutdown
  }
}
