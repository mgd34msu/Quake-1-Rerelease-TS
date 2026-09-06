/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_main.c (GNU GPL v2 or later).

sv_main.c -- server main program. The qwsv binary's own error/shutdown path,
connectionless packet handlers, IP filter list, packet read loop, timeout
sweep, frame driver, and the whole cvar registration block.

Deviations from PORTING.md / the C source:
- `SV_Error`: the C prints, sends SV_FinalMessage, calls SV_Shutdown, then
  Sys_Error. Q011's src/qw/server/pr_exec.ts landed a stand-in `SV_Error` +
  `PRRunError` class because this file did not exist yet, and pr_edict.ts /
  pr_exec.ts / sv_send.ts all throw/catch `PRRunError`. The real
  implementation lives here and keeps those throw semantics: it performs the
  C's side effects and then throws `PRRunError` (which extends
  src/platform/sys.ts's `SysError`) in place of the C's final `Sys_Error`
  call, so nothing that already relies on the class changes. pr_exec.ts is
  outside this unit's SCOPE; its stand-in body should become a lazy delegate
  to this function (the exact edit is in this unit's report). The `static
  qboolean inerror` reentrancy guard is the module-level `inerror` below and
  routes the recursive case to `Sys_Error`, exactly as the C does.
- `quakeparms_t host_parms`: sv_main.c defines its own copy, but
  src/common/common.ts already owns the single `host_parms` singleton that
  COM_InitFilesystem reads. `host_parms = *parms` is a field-by-field copy
  into that singleton, matching src/common/host.ts's Host_Init precedent.
- `host_initialized` / `host_frametime` / `realtime` / `host_hunklevel`:
  reassigned scalar globals, so they become the exported `svMainState` holder
  (PORTING.md's "small exported holder" rule; src/common/host.ts's `host`
  object is the same idiom). sv_phys.ts (SV_Physics reads host_frametime and
  clamps it with sv_mintic/sv_maxtic) and sv_ccmds.ts read them from here.
- `net_chan.c`'s `#ifdef SERVERONLY if (ServerPaused()) ...` and its direct
  reads of the `realtime` global reach this module through src/qw/net_chan.ts's
  already-landed seams: SV_InitNet installs `setNetchanServerHooks({isPaused})`
  and clears `netchanState.isClient`, and SV_Frame republishes `realtime` into
  `netchanState.realtime` once per frame, which is the only writer.
- `Sys_DoubleTime` (QW/server/sys_unix.c) has no entry in src/platform/sys.ts,
  which exposes the same monotonic clock as `Sys_FloatTime`; a one-line local
  alias stands in. Q017 (src/qw/main_sv.ts + the sys delta) owns the real name.
- `Con_Printf ("Exe: "__TIME__" "__DATE__"\n")` and `build_number()`:
  `__TIME__`/`__DATE__` are compiler-supplied and QW/client/buildnum.c is not
  ported (src/qw/common.ts's header records the same drop for `build_number`).
  `EXE_BUILD_TIME`/`EXE_BUILD_DATE` are local consts holding id's own release
  stamp and `build_number()` below is buildnum.c's algorithm run over them, so
  both prints keep their exact C format and a stable value. src/qw/bothdefs.ts
  has no such constant to import.
- `SV_CheckVars`'s `static char *pw, *spw` pointer comparison detects "the
  cvar's string buffer was reallocated", which in the C means "Cvar_Set ran".
  TS strings are values, so the two statics are `string | null` (null being
  the C's zero-initialized static pointer) compared by value: a Cvar_Set that
  writes the identical text no longer re-runs the body. The observable
  serverinfo result is the same; only the "Updated needpass." print differs on
  a redundant set.
- `SV_SendServerInfoChange` is defined by QW/server/sv_ccmds.c (its true C
  home is sv_ccmds.c:527), not by sv_main.c; it is exported from
  src/qw/server/sv_ccmds.ts (the module whose C file actually defines it)
  and reached from here through the lazy `svCcmdsMod()` helper, exactly the
  cross-module pattern this file already uses for sv_phys.ts/sv_user.ts/
  sv_init.ts/pr_cmds.ts.
- `SV_CvarInfoHook` has no C counterpart: it is the `CvarInfoHook` body that
  src/common/cvar.ts's folded `Cvar_Set` calls when `qw.active` (PORTING.md's
  "Cvars gain `info`" ruling), doing exactly what cvar.c's `#ifdef SERVERONLY`
  block does -- `Info_SetValueForKey (svs.info, ...)` then
  `SV_SendServerInfoChange`. SV_Init registers it first thing, before any
  info-flagged cvar is registered. `qw.active` itself stays the entry point's
  to set, per PORTING.md. `SV_CvarInfoHook` itself stays in this module (its
  brief), only the `SV_SendServerInfoChange` call it makes is delegated.
- `netadr_t adr = net_from;` (SVC_DirectConnect) and `svs.challenges[i].adr =
  net_from;` (SVC_GetChallenge) are struct copies in the C, and
  src/qw/net_chan.ts's Netchan_Setup stores the `netadr_t` it is handed by
  reference; `copyNetadr` (src/qw/net_udp.ts, the module that owns `NetadrT`)
  makes both copies explicit so a stored address never aliases the `net_from`
  singleton. Netchan_Setup uses the same helper.
- QW's `cvar_t` (QW/client/cvar.h) is `{name, string, archive, info}` -- it has
  no `server` field at all, so sv_main.c's `{"fraglimit","0",false,true}` style
  initializers mean archive=false, **info**=true. src/common/cvar.ts's `CvarT`
  keeps WinQuake's `server` as its 4th constructor argument and puts `info`
  5th, so every one of those cvars is constructed here as
  `new CvarT(name, value, false, false, true)`: archive false, server false,
  info true.
- `Info_*` in src/qw/common.ts are pure (they return the new string) rather
  than editing a `char *` in place, so every call site assigns the result back
  (`svs.info = Info_SetValueForKey(svs.info, ...)`).
- `ipfilter_t.mask`/`.compare` are built by `*(unsigned *)m` over a `byte[4]`,
  i.e. a little-endian pack; `packAddr` below does that explicitly and every
  value is kept unsigned with `>>> 0`. `SV_FilterPacket`'s `return
  filterban.value;` / `return !filterban.value;` are a float-to-int truncation
  and a float logical-not in the C, ported as `Math.trunc(...) !== 0` and
  `=== 0` respectively.
- `SV_ReadPackets`'s `good` local is assigned and never read anywhere in the C
  -- a dead local in the original source; omitted, same precedent as
  sv_send.ts's `field_mask`.
- `SVC_DirectConnect`'s `client_t temp; ... *newcl = temp;` copies a whole
  struct into the chosen slot. `svs.clients` holds fixed `ClientT` instances
  that other modules address by index, so the copy is `Object.assign(newcl,
  temp)`: the slot object keeps its identity (the C keeps its address) and
  takes every field, including the freshly constructed netchan/sizebuf
  sub-objects `temp` owns and then discards.
- `if (strlen(val) > sizeof(cl->name) - 1) val[sizeof(cl->name) - 4] = 0;` in
  SV_ExtractFromUserinfo writes through the pointer Info_ValueForKey returned
  (its own static buffer); with a pure Info_ValueForKey that becomes a local
  truncation of `val`, same subsequent behaviour.
- `SV_ExtractFromUserinfo`'s trailing-whitespace trim starts at
  `newname + strlen(newname) - 1`, which is one byte before the buffer when
  the name is empty (undefined behaviour in the C, and in practice a no-op
  leaving the empty string alone). The empty case is skipped here instead of
  reproducing the out-of-bounds read.
- `rand()`: `Math.floor(Math.random() * 0x8000) & 0x7fff` (RAND_MAX 0x7fff),
  the same helper shape src/progs/pr_cmds.ts uses.
- `SV_WriteIP_f`'s `if (!f) Con_Printf ("Couldn't open %s\n", name);` branch is
  unreachable here: src/platform/sys.ts's `Sys_FileOpenWrite` raises Sys_Error
  on an open failure instead of returning a null handle, so the message it
  guards can never print; the branch is dropped rather than kept as dead code.
- `FILE *` fields: `sv_logfile`/`sv_fraglogfile` are already owned by
  src/qw/server/sv_send.ts's `svSendFileState` (its header explains why), so
  SV_Shutdown closes them through that holder. `drop->download`/`drop->upload`
  are src/common/common.ts `FileHandle`s, closed with `Sys_FileClose(f.fd)`.
- `SV_Init` calls `Cmd_Init()` from src/qw/cmd.ts, which is QW/client/cmd.c's.
  That file's `Cmd_AddCommand ("cmd", Cmd_ForwardToServer_f)` sits inside
  `#ifndef SERVERONLY`, gated at runtime on `qw.serveronly`
  (src/common/quakedef.ts). Per PORTING.md's `qw.active` ruling, the QW entry
  points (src/qw/main_sv.ts, not yet landed) are responsible for setting
  `qw.serveronly = true` before calling SV_Init, the same way they set
  `qw.active`; this file does not set it itself.
- The unit brief lists a few things sv_main.c does not contain, checked
  against the source and therefore not ported: SV_Frame has no
  sv_mintic/sv_maxtic clamp (that lives in sv_phys.c's SV_Physics, which is
  why this file only registers the two cvars) and no host_speeds-style timing
  prints (only the `svs.stats` accumulator); SV_Init has no `localinfo`
  handling (localinfo is sv_init.c's global) and no `Sys_GetHostname` call.
- Modules that certainly depend on this one (sv_phys.c, sv_user.c, sv_ccmds.c,
  sv_init.c, pr_cmds.c all call SV_DropClient/SV_Error/SV_FinalMessage or read
  its cvars) are reached with Bun's synchronous `require()`, per PORTING.md's
  import-cycle rule: this module is the more fundamental of each pair, so it
  breaks the cycle on its own side. src/qw/server/sv_send.ts already resolves
  this module lazily for the same reason and is imported normally here.
*/

import type * as SvPhysModule from "./sv_phys";
import type * as SvUserModule from "./sv_user";
import type * as SvCcmdsModule from "./sv_ccmds";
import type * as SvInitModule from "./sv_init";
import type * as PrCmdsModule from "./pr_cmds";

import { ClientStateT, ClientT, MAX_CHALLENGES, MAX_MASTERS, NUM_SPAWN_PARMS, RedirectT, STATFRAMES, ServerStateT, sv, svs } from "./server";
import { EDICT_NUM, EDICT_TO_PROG, qwpr, type QwEdictT } from "./progs";
import { QW_GLOBAL_OFS, type QwGlobalVars } from "./progdefs";
import { PRRunError, PR_ExecuteProgram } from "./pr_exec";
import { PR_Init, prSpectator } from "./pr_edict";
import { Con_DPrintf, Con_Printf, SV_BeginRedirect, SV_BroadcastPrintf, SV_ClientPrintf, SV_EndRedirect, SV_SendClientMessages, svSendFileState } from "./sv_send";
import { ClientReliableCheckBlock, ClientReliable_FinishWrite } from "./sv_nchan";

import { MAX_CLIENTS, PORT_SERVER, PRINT_HIGH, PROTOCOL_VERSION, SvcOpsT, UPDATE_BACKUP, A2A_ACK, A2A_NACK, A2A_PING, A2C_PRINT, S2C_CHALLENGE, S2C_CONNECTION, S2M_HEARTBEAT, S2M_SHUTDOWN } from "../protocol";
import { MAX_MODELS, MINIMUM_MEMORY, VERSION } from "../bothdefs";
import {
  COM_AddParm,
  COM_CheckParm,
  COM_Init,
  COM_InitArgv,
  Info_RemoveKey,
  Info_RemovePrefixedKeys,
  Info_SetValueForKey,
  Info_SetValueForStarKey,
  Info_ValueForKey,
  MAX_INFO_STRING,
  MAX_SERVERINFO_STRING,
  MSG_BeginReading,
  MSG_ReadLong,
  MSG_ReadShort,
  MSG_ReadStringLine,
  MSG_WriteByte,
  MSG_WriteFloat,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  Q_atoi,
  Q_strcasecmp,
  SZ_Clear,
  SizeBuf,
  com_argc,
  com_argv,
  com_gamedir,
  host_parms,
  net_message,
  va,
} from "../common";
import { NET_AdrToString, NET_CompareBaseAdr, NET_GetPacket, NET_Init, NET_SendPacket, NET_Shutdown, NetadrT, copyNetadr, net_from } from "../net_udp";
import { Netchan_Init, Netchan_OutOfBandPrint, Netchan_Process, Netchan_Setup, Netchan_Transmit, netchanState, setNetchanServerHooks } from "../net_chan";
import { Cmd_ExecuteString, Cmd_Init } from "../cmd";
import { Pmove_Init } from "../pmove";

import { Cbuf_AddText, Cbuf_Execute, Cbuf_Init, Cbuf_InsertText, Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cmd_StuffCmds_f, Cmd_TokenizeString } from "../../common/cmd";
import { CvarT, Cvar_RegisterVariable, Cvar_SetValue, setCvarInfoHook } from "../../common/cvar";
import { Com_sprintf } from "../../common/sprintf";
import { Hunk_AllocName, Hunk_LowMark, Memory_Init } from "../../common/zone";
import { Mod_Init } from "../../common/model";
import type { QuakeParmsT } from "../../common/quakedef";
import { Sys_ConsoleInput, Sys_Error, Sys_FileClose, Sys_FileOpenWrite, Sys_FileWrite, Sys_FloatTime } from "../../platform/sys";
import { Sys_Init } from "../sys_sv";

//============================================================================
// lazily resolved siblings -- see file header

function svPhysMod(): typeof SvPhysModule {
  return require("./sv_phys");
}

function svUserMod(): typeof SvUserModule {
  return require("./sv_user");
}

function svCcmdsMod(): typeof SvCcmdsModule {
  return require("./sv_ccmds");
}

function svInitMod(): typeof SvInitModule {
  return require("./sv_init");
}

function prCmdsMod(): typeof PrCmdsModule {
  return require("./pr_cmds");
}

// QW/server/sys_unix.c's Sys_DoubleTime -- see file header
function Sys_DoubleTime(): number {
  return Sys_FloatTime();
}

// rand() with the RAND_MAX id's compilers used -- see file header
function rand(): number {
  return Math.floor(Math.random() * 0x8000) & 0x7fff;
}

function stringToLatin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// the C's `(char *)svs.log_buf[n]` read: everything up to the first NUL
function latin1CStringFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new PRRunError("sv_main: pr_global_struct not set (PR_LoadProgs not called)");
  return qwpr.global_struct;
}

function requireGlobalFloats(): Float32Array {
  if (qwpr.globals === null) throw new PRRunError("sv_main: pr_globals not set (PR_LoadProgs not called)");
  return qwpr.globals.f;
}

function requireEdict(cl: ClientT): QwEdictT {
  if (cl.edict === null) throw new PRRunError("sv_main: client has no edict");
  return cl.edict;
}

//============================================================================

// host_parms is src/common/common.ts's singleton -- see file header.

// `host_initialized`/`host_frametime`/`realtime`/`host_hunklevel`
export const svMainState = {
  host_initialized: false, // true if into command execution (compatability)
  host_frametime: 0,
  realtime: 0, // without any filtering or bounding
  host_hunklevel: 0,
};

export const master_adr: NetadrT[] = Array.from({ length: MAX_MASTERS }, () => new NetadrT()); // address of group servers

export const sv_mintic = new CvarT("sv_mintic", "0.03"); // bound the size of the
export const sv_maxtic = new CvarT("sv_maxtic", "0.1"); // physics time tic

export const developer = new CvarT("developer", "0"); // show extra messages

export const timeout = new CvarT("timeout", "65"); // seconds without any message
export const zombietime = new CvarT("zombietime", "2"); // seconds to sink messages
// after disconnect

export const rcon_password = new CvarT("rcon_password", ""); // password for remote server commands
export const password = new CvarT("password", ""); // password for entering the game
export const spectator_password = new CvarT("spectator_password", ""); // password for entering as a sepctator

export const allow_download = new CvarT("allow_download", "1");
export const allow_download_skins = new CvarT("allow_download_skins", "1");
export const allow_download_models = new CvarT("allow_download_models", "1");
export const allow_download_sounds = new CvarT("allow_download_sounds", "1");
export const allow_download_maps = new CvarT("allow_download_maps", "1");

export const sv_highchars = new CvarT("sv_highchars", "1");

export const sv_phs = new CvarT("sv_phs", "1");

export const pausable = new CvarT("pausable", "1");

//
// game rules mirrored in svs.info
//
export const fraglimit = new CvarT("fraglimit", "0", false, false, true);
export const timelimit = new CvarT("timelimit", "0", false, false, true);
export const teamplay = new CvarT("teamplay", "0", false, false, true);
export const samelevel = new CvarT("samelevel", "0", false, false, true);
export const maxclients = new CvarT("maxclients", "8", false, false, true);
export const maxspectators = new CvarT("maxspectators", "8", false, false, true);
export const deathmatch = new CvarT("deathmatch", "1", false, false, true); // 0, 1, or 2
export const spawn = new CvarT("spawn", "0", false, false, true);
export const watervis = new CvarT("watervis", "0", false, false, true);

export const hostname = new CvarT("hostname", "unnamed", false, false, true);

//============================================================================

export function ServerPaused(): boolean {
  return sv.paused;
}

/*
================
SV_Shutdown

Quake calls this before calling Sys_Quit or Sys_Error
================
*/
export function SV_Shutdown(): void {
  Master_Shutdown();
  if (svSendFileState.sv_logfile !== null) {
    Sys_FileClose(svSendFileState.sv_logfile);
    svSendFileState.sv_logfile = null;
  }
  if (svSendFileState.sv_fraglogfile !== null) {
    Sys_FileClose(svSendFileState.sv_fraglogfile);
    svSendFileState.sv_logfile = null;
  }
  NET_Shutdown();
}

/*
================
SV_Error

Sends a datagram to all the clients informing them of the server crash,
then exits
================
*/
// `static qboolean inerror` + `static char sv_error_string[1024]`: exported
// as a small holder (same idiom as svMainState above) rather than private
// module `let`s, so a test suite that deliberately provokes SV_Error can
// reset the reentrancy guard afterward, per rule 15 (shared singletons get
// reset by the suite that touches them, not assumed fresh).
export const svErrorState = {
  sv_error_string: "",
  inerror: false,
};

export function SV_Error(error: string, ...args: Array<string | number>): never {
  if (svErrorState.inerror) Sys_Error("SV_Error: recursively entered (%s)", svErrorState.sv_error_string);

  svErrorState.inerror = true;

  svErrorState.sv_error_string = Com_sprintf(error, ...args);

  Con_Printf("SV_Error: %s\n", svErrorState.sv_error_string);

  SV_FinalMessage(va("server crashed: %s\n", svErrorState.sv_error_string));

  SV_Shutdown();

  // Sys_Error ("SV_Error: %s\n", string) -- thrown as PRRunError, see file header
  throw new PRRunError(Com_sprintf("SV_Error: %s\n", svErrorState.sv_error_string));
}

/*
==================
SV_FinalMessage

Used by SV_Error and SV_Quit_f to send a final message to all connected
clients before the server goes down.  The messages are sent immediately,
not just stuck on the outgoing message list, because the server is going
to totally exit after returning from this function.
==================
*/
export function SV_FinalMessage(message: string): void {
  SZ_Clear(net_message);
  MSG_WriteByte(net_message, SvcOpsT.svc_print);
  MSG_WriteByte(net_message, PRINT_HIGH);
  MSG_WriteString(net_message, message);
  MSG_WriteByte(net_message, SvcOpsT.svc_disconnect);

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (cl.state >= ClientStateT.cs_spawned) Netchan_Transmit(cl.netchan, net_message.cursize, net_message.data);
  }
}

/*
=====================
SV_DropClient

Called when the player is totally leaving the server, either willingly
or unwillingly.  This is NOT called if the entire server is quiting
or crashing.
=====================
*/
export function SV_DropClient(drop: ClientT): void {
  // add the disconnect
  MSG_WriteByte(drop.netchan.message, SvcOpsT.svc_disconnect);

  if (drop.state === ClientStateT.cs_spawned) {
    if (!drop.spectator) {
      // call the prog function for removing a client
      // this will set the body to a dead frame, among other things
      const pr_global_struct = requireGlobalStruct();
      pr_global_struct.self = EDICT_TO_PROG(requireEdict(drop));
      PR_ExecuteProgram(pr_global_struct.ClientDisconnect);
    } else if (prSpectator.disconnect) {
      // call the prog function for removing a client
      // this will set the body to a dead frame, among other things
      const pr_global_struct = requireGlobalStruct();
      pr_global_struct.self = EDICT_TO_PROG(requireEdict(drop));
      PR_ExecuteProgram(prSpectator.disconnect);
    }
  }

  if (drop.spectator) Con_Printf("Spectator %s removed\n", drop.name);
  else Con_Printf("Client %s removed\n", drop.name);

  if (drop.download) {
    Sys_FileClose(drop.download.fd);
    drop.download = null;
  }
  if (drop.upload) {
    Sys_FileClose(drop.upload.fd);
    drop.upload = null;
  }
  drop.uploadfn = "";

  drop.state = ClientStateT.cs_zombie; // become free in a few seconds
  drop.connection_started = svMainState.realtime; // for zombie timeout

  drop.old_frags = 0;
  requireEdict(drop).v.frags = 0;
  drop.name = "";
  drop.userinfo = "";

  // send notification to all remaining clients
  SV_FullClientUpdate(drop, sv.reliable_datagram);
}

//====================================================================

/*
===================
SV_CalcPing

===================
*/
export function SV_CalcPing(cl: ClientT): number {
  let ping = 0;
  let count = 0;
  for (let i = 0; i < UPDATE_BACKUP; i++) {
    const frame = cl.frames[i];
    if (frame.ping_time > 0) {
      ping += frame.ping_time;
      count++;
    }
  }
  if (!count) return 9999;
  ping /= count;

  return Math.trunc(ping * 1000);
}

/*
===================
SV_FullClientUpdate

Writes all update values to a sizebuf
===================
*/
export function SV_FullClientUpdate(client: ClientT, buf: SizeBuf): void {
  const i = svs.clients.indexOf(client);

  MSG_WriteByte(buf, SvcOpsT.svc_updatefrags);
  MSG_WriteByte(buf, i);
  MSG_WriteShort(buf, client.old_frags);

  MSG_WriteByte(buf, SvcOpsT.svc_updateping);
  MSG_WriteByte(buf, i);
  MSG_WriteShort(buf, SV_CalcPing(client));

  MSG_WriteByte(buf, SvcOpsT.svc_updatepl);
  MSG_WriteByte(buf, i);
  MSG_WriteByte(buf, client.lossage);

  MSG_WriteByte(buf, SvcOpsT.svc_updateentertime);
  MSG_WriteByte(buf, i);
  MSG_WriteFloat(buf, svMainState.realtime - client.connection_started);

  let info = client.userinfo;
  info = Info_RemovePrefixedKeys(info, "_"); // server passwords, etc

  MSG_WriteByte(buf, SvcOpsT.svc_updateuserinfo);
  MSG_WriteByte(buf, i);
  MSG_WriteLong(buf, client.userid);
  MSG_WriteString(buf, info);
}

/*
===================
SV_FullClientUpdateToClient

Writes all update values to a client's reliable stream
===================
*/
export function SV_FullClientUpdateToClient(client: ClientT, cl: ClientT): void {
  ClientReliableCheckBlock(cl, 24 + client.userinfo.length);
  if (cl.num_backbuf) {
    SV_FullClientUpdate(client, cl.backbuf);
    ClientReliable_FinishWrite(cl);
  } else SV_FullClientUpdate(client, cl.netchan.message);
}

/*
==============================================================================

CONNECTIONLESS COMMANDS

==============================================================================
*/

/*
================
SVC_Status

Responds with all the info that qplug or qspy can see
This message can be up to around 5k with worst case string lengths.
================
*/
export function SVC_Status(): void {
  Cmd_TokenizeString("status");
  SV_BeginRedirect(RedirectT.RD_PACKET);
  Con_Printf("%s\n", svs.info);
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if ((cl.state === ClientStateT.cs_connected || cl.state === ClientStateT.cs_spawned) && !cl.spectator) {
      let top = Q_atoi(Info_ValueForKey(cl.userinfo, "topcolor"));
      let bottom = Q_atoi(Info_ValueForKey(cl.userinfo, "bottomcolor"));
      top = top < 0 ? 0 : top > 13 ? 13 : top;
      bottom = bottom < 0 ? 0 : bottom > 13 ? 13 : bottom;
      const ping = SV_CalcPing(cl);
      Con_Printf(
        '%i %i %i %i "%s" "%s" %i %i\n',
        cl.userid,
        cl.old_frags,
        Math.trunc((svMainState.realtime - cl.connection_started) / 60),
        ping,
        cl.name,
        Info_ValueForKey(cl.userinfo, "skin"),
        top,
        bottom,
      );
    }
  }
  SV_EndRedirect();
}

/*
===================
SV_CheckLog

===================
*/
const LOG_HIGHWATER = 4096;
const LOG_FLUSH = 10 * 60;

export function SV_CheckLog(): void {
  let sz = svs.log[svs.logsequence & 1];

  // bump sequence if allmost full, or ten minutes have passed and
  // there is something still sitting there
  if (sz.cursize > LOG_HIGHWATER || (svMainState.realtime - svs.logtime > LOG_FLUSH && sz.cursize)) {
    // swap buffers and bump sequence
    svs.logtime = svMainState.realtime;
    svs.logsequence++;
    sz = svs.log[svs.logsequence & 1];
    sz.cursize = 0;
    Con_Printf("beginning fraglog sequence %i\n", svs.logsequence);
  }
}

/*
================
SVC_Log

Responds with all the logged frags for ranking programs.
If a sequence number is passed as a parameter and it is
the same as the current sequence, an A2A_NACK will be returned
instead of the data.
================
*/
export function SVC_Log(): void {
  let seq: number;
  if (Cmd_Argc() === 2) seq = Q_atoi(Cmd_Argv(1));
  else seq = -1;

  if (seq === svs.logsequence - 1 || svSendFileState.sv_fraglogfile === null) {
    // they allready have this data, or we aren't logging frags
    const nack = new Uint8Array(1);
    nack[0] = A2A_NACK.charCodeAt(0);
    NET_SendPacket(1, nack, net_from);
    return;
  }

  Con_DPrintf("sending log %i to %s\n", svs.logsequence - 1, NET_AdrToString(net_from));

  let data = Com_sprintf("stdlog %i\n", svs.logsequence - 1);
  data += latin1CStringFromBytes(svs.log_buf[(svs.logsequence - 1) & 1]);

  const bytes = new Uint8Array(data.length + 1);
  bytes.set(stringToLatin1Bytes(data), 0);
  NET_SendPacket(data.length + 1, bytes, net_from);
}

/*
================
SVC_Ping

Just responds with an acknowledgement
================
*/
export function SVC_Ping(): void {
  const data = new Uint8Array(1);
  data[0] = A2A_ACK.charCodeAt(0);

  NET_SendPacket(1, data, net_from);
}

/*
=================
SVC_GetChallenge

Returns a challenge number that can be used
in a subsequent client_connect command.
We do this to prevent denial of service attacks that
flood the server with invalid connection IPs.  With a
challenge, they must give a valid IP address.
=================
*/
export function SVC_GetChallenge(): void {
  let oldest = 0;
  let oldestTime = 0x7fffffff;

  // see if we already have a challenge for this ip
  let i = 0;
  for (; i < MAX_CHALLENGES; i++) {
    if (NET_CompareBaseAdr(net_from, svs.challenges[i].adr)) break;
    if (svs.challenges[i].time < oldestTime) {
      oldestTime = svs.challenges[i].time;
      oldest = i;
    }
  }

  if (i === MAX_CHALLENGES) {
    // overwrite the oldest
    svs.challenges[oldest].challenge = ((rand() << 16) ^ rand()) | 0;
    svs.challenges[oldest].adr = copyNetadr(net_from);
    svs.challenges[oldest].time = Math.trunc(svMainState.realtime);
    i = oldest;
  }

  // send it back
  Netchan_OutOfBandPrint(net_from, "%c%i", S2C_CHALLENGE, svs.challenges[i].challenge);
}

/*
==================
SVC_DirectConnect

A connection request that did not come from the master
==================
*/
let sv_connect_userid = 0;

export function SVC_DirectConnect(): void {
  const version = Q_atoi(Cmd_Argv(1));
  if (version !== PROTOCOL_VERSION) {
    Netchan_OutOfBandPrint(net_from, "%c\nServer is version %4.2f.\n", A2C_PRINT, VERSION);
    Con_Printf("* rejected connect from version %i\n", version);
    return;
  }

  const qport = Q_atoi(Cmd_Argv(2));

  const challenge = Q_atoi(Cmd_Argv(3));

  // note an extra byte is needed to replace spectator key
  let userinfo = Cmd_Argv(4).slice(0, 1022);

  // see if the challenge is valid
  let i = 0;
  for (; i < MAX_CHALLENGES; i++) {
    if (NET_CompareBaseAdr(net_from, svs.challenges[i].adr)) {
      if (challenge === svs.challenges[i].challenge) break; // good
      Netchan_OutOfBandPrint(net_from, "%c\nBad challenge.\n", A2C_PRINT);
      return;
    }
  }
  if (i === MAX_CHALLENGES) {
    Netchan_OutOfBandPrint(net_from, "%c\nNo challenge for address.\n", A2C_PRINT);
    return;
  }

  let spectator: boolean;

  // check for password or spectator_password
  let s = Info_ValueForKey(userinfo, "spectator");
  if (s[0] && s !== "0") {
    if (spectator_password.string[0] && Q_strcasecmp(spectator_password.string, "none") !== 0 && spectator_password.string !== s) {
      // failed
      Con_Printf("%s:spectator password failed\n", NET_AdrToString(net_from));
      Netchan_OutOfBandPrint(net_from, "%c\nrequires a spectator password\n\n", A2C_PRINT);
      return;
    }
    userinfo = Info_RemoveKey(userinfo, "spectator"); // remove passwd
    userinfo = Info_SetValueForStarKey(userinfo, "*spectator", "1", MAX_INFO_STRING);
    spectator = true;
  } else {
    s = Info_ValueForKey(userinfo, "password");
    if (password.string[0] && Q_strcasecmp(password.string, "none") !== 0 && password.string !== s) {
      Con_Printf("%s:password failed\n", NET_AdrToString(net_from));
      Netchan_OutOfBandPrint(net_from, "%c\nserver requires a password\n\n", A2C_PRINT);
      return;
    }
    spectator = false;
    userinfo = Info_RemoveKey(userinfo, "password"); // remove passwd
  }

  const adr = copyNetadr(net_from);
  sv_connect_userid++; // so every client gets a unique id

  const temp = new ClientT();

  temp.userid = sv_connect_userid;

  // works properly
  if (!sv_highchars.value) {
    let p = "";
    for (let q = 0; q < userinfo.length && p.length < MAX_INFO_STRING - 1; q++) {
      const c = userinfo.charCodeAt(q) & 0xff;
      if (c > 31 && c <= 127) p += String.fromCharCode(c);
    }
    temp.userinfo = p;
  } else temp.userinfo = userinfo.slice(0, MAX_INFO_STRING - 1);

  // if there is allready a slot for this ip, drop it
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const cl = svs.clients[j];
    if (cl.state === ClientStateT.cs_free) continue;
    if (NET_CompareBaseAdr(adr, cl.netchan.remote_address) && (cl.netchan.qport === qport || adr.port === cl.netchan.remote_address.port)) {
      if (cl.state === ClientStateT.cs_connected) {
        Con_Printf("%s:dup connect\n", NET_AdrToString(adr));
        sv_connect_userid--;
        return;
      }

      Con_Printf("%s:reconnect\n", NET_AdrToString(adr));
      SV_DropClient(cl);
      break;
    }
  }

  // count up the clients and spectators
  let clients = 0;
  let spectators = 0;
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const cl = svs.clients[j];
    if (cl.state === ClientStateT.cs_free) continue;
    if (cl.spectator) spectators++;
    else clients++;
  }

  // if at server limits, refuse connection
  if (maxclients.value > MAX_CLIENTS) Cvar_SetValue("maxclients", MAX_CLIENTS);
  if (maxspectators.value > MAX_CLIENTS) Cvar_SetValue("maxspectators", MAX_CLIENTS);
  if (maxspectators.value + maxclients.value > MAX_CLIENTS) Cvar_SetValue("maxspectators", MAX_CLIENTS - maxspectators.value + maxclients.value);
  if ((spectator && spectators >= Math.trunc(maxspectators.value)) || (!spectator && clients >= Math.trunc(maxclients.value))) {
    Con_Printf("%s:full connect\n", NET_AdrToString(adr));
    Netchan_OutOfBandPrint(adr, "%c\nserver is full\n\n", A2C_PRINT);
    return;
  }

  // find a client slot
  let newcl: ClientT | null = null;
  let newclnum = -1;
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const cl = svs.clients[j];
    if (cl.state === ClientStateT.cs_free) {
      newcl = cl;
      newclnum = j;
      break;
    }
  }
  if (!newcl) {
    Con_Printf("WARNING: miscounted available clients\n");
    return;
  }

  // build a new connection
  // accept the new client
  // this is the only place a client_t is ever initialized
  Object.assign(newcl, temp); // *newcl = temp -- see file header

  Netchan_OutOfBandPrint(adr, "%c", S2C_CONNECTION);

  const edictnum = newclnum + 1;

  Netchan_Setup(newcl.netchan, adr, qport);

  newcl.state = ClientStateT.cs_connected;

  newcl.datagram.allowoverflow = true;
  newcl.datagram.data = newcl.datagram_buf;
  newcl.datagram.maxsize = newcl.datagram_buf.length;

  // spectator mode can ONLY be set at join time
  newcl.spectator = spectator ? 1 : 0;

  const ent = EDICT_NUM(edictnum);
  newcl.edict = ent;

  // parse some info from the info strings
  SV_ExtractFromUserinfo(newcl);

  // JACK: Init the floodprot stuff.
  for (let j = 0; j < 10; j++) newcl.whensaid[j] = 0.0;
  newcl.whensaidhead = 0;
  newcl.lockedtill = 0;

  // call the progs to get default spawn parms for the new client
  const pr_global_struct = requireGlobalStruct();
  PR_ExecuteProgram(pr_global_struct.SetNewParms);
  const globalFloats = requireGlobalFloats();
  for (let j = 0; j < NUM_SPAWN_PARMS; j++) newcl.spawn_parms[j] = globalFloats[QW_GLOBAL_OFS.parm1 + j];

  if (newcl.spectator) Con_Printf("Spectator %s connected\n", newcl.name);
  else Con_DPrintf("Client %s connected\n", newcl.name);
  newcl.sendinfo = true;
}

export function Rcon_Validate(): number {
  if (!rcon_password.string.length) return 0;

  if (Cmd_Argv(1) !== rcon_password.string) return 0;

  return 1;
}

/*
===============
SVC_RemoteCommand

A client issued an rcon command.
Shift down the remaining args
Redirect all printfs
===============
*/
export function SVC_RemoteCommand(): void {
  // net_message.data+4 -- the command text following the 0xffffffff marker
  const raw = latin1CStringFromBytes(net_message.data.subarray(4, net_message.cursize));

  if (!Rcon_Validate()) {
    Con_Printf("Bad rcon from %s:\n%s\n", NET_AdrToString(net_from), raw);

    SV_BeginRedirect(RedirectT.RD_PACKET);

    Con_Printf("Bad rcon_password.\n");
  } else {
    Con_Printf("Rcon from %s:\n%s\n", NET_AdrToString(net_from), raw);

    SV_BeginRedirect(RedirectT.RD_PACKET);

    let remaining = "";

    for (let i = 2; i < Cmd_Argc(); i++) {
      remaining += Cmd_Argv(i);
      remaining += " ";
    }

    Cmd_ExecuteString(remaining);
  }

  SV_EndRedirect();
}

/*
=================
SV_ConnectionlessPacket

A connectionless packet has four leading 0xff
characters to distinguish it from a game channel.
Clients that are in the game can still send
connectionless packets.
=================
*/
export function SV_ConnectionlessPacket(): void {
  MSG_BeginReading();
  MSG_ReadLong(); // skip the -1 marker

  const s = MSG_ReadStringLine();

  Cmd_TokenizeString(s);

  const c = Cmd_Argv(0);

  if (c === "ping" || (c[0] === A2A_PING && (c[1] === undefined || c[1] === "\n"))) {
    SVC_Ping();
    return;
  }
  if (c[0] === A2A_ACK && (c[1] === undefined || c[1] === "\n")) {
    Con_Printf("A2A_ACK from %s\n", NET_AdrToString(net_from));
    return;
  } else if (c === "status") {
    SVC_Status();
    return;
  } else if (c === "log") {
    SVC_Log();
    return;
  } else if (c === "connect") {
    SVC_DirectConnect();
    return;
  } else if (c === "getchallenge") {
    SVC_GetChallenge();
    return;
  } else if (c === "rcon") SVC_RemoteCommand();
  else Con_Printf("bad connectionless packet from %s:\n%s\n", NET_AdrToString(net_from), s);
}

/*
==============================================================================

PACKET FILTERING


You can add or remove addresses from the filter list with:

addip <ip>
removeip <ip>

The ip address is specified in dot format, and any unspecified digits will match any value, so you can specify an entire class C network with "addip 192.246.40".

Removeip will only remove an address specified exactly the same way.  You cannot addip a subnet, then removeip a single host.

listip
Prints the current list of filters.

writeip
Dumps "addip <ip>" commands to listip.cfg so it can be execed at a later date.  The filter lists are not saved and restored by default, because I beleive it would cause too much confusion.

filterban <0 or 1>

If 1 (the default), then ip addresses matching the current list will be prohibited from entering the game.  This is the default setting.

If 0, then only addresses matching the list will be allowed.  This lets you easily set up a private game, or a game that only allows players from your local network.


==============================================================================
*/

export class IpfilterT {
  mask = 0; // unsigned
  compare = 0; // unsigned
}

export const MAX_IPFILTERS = 1024;

export const ipfilters: IpfilterT[] = Array.from({ length: MAX_IPFILTERS }, () => new IpfilterT());
export let numipfilters = 0;

export const filterban = new CvarT("filterban", "1");

// `*(unsigned *)b` over a byte[4] -- little-endian, see file header
function packAddr(b: Uint8Array): number {
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

function unpackAddr(v: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = v & 0xff;
  b[1] = (v >>> 8) & 0xff;
  b[2] = (v >>> 16) & 0xff;
  b[3] = (v >>> 24) & 0xff;
  return b;
}

/*
=================
StringToFilter
=================
*/
export function StringToFilter(s: string, f: IpfilterT): boolean {
  const b = new Uint8Array(4);
  const m = new Uint8Array(4);

  let pos = 0;
  for (let i = 0; i < 4; i++) {
    const c = pos < s.length ? s.charCodeAt(pos) : 0;
    if (c < 0x30 /* '0' */ || c > 0x39 /* '9' */) {
      Con_Printf("Bad filter address: %s\n", s);
      return false;
    }

    let num = "";
    while (pos < s.length) {
      const d = s.charCodeAt(pos);
      if (d < 0x30 || d > 0x39) break;
      num += s[pos];
      pos++;
    }
    b[i] = Q_atoi(num);
    if (b[i] !== 0) m[i] = 255;

    if (pos >= s.length) break;
    pos++;
  }

  f.mask = packAddr(m);
  f.compare = packAddr(b);

  return true;
}

/*
=================
SV_AddIP_f
=================
*/
export function SV_AddIP_f(): void {
  let i = 0;
  for (; i < numipfilters; i++) if (ipfilters[i].compare === 0xffffffff) break; // free spot
  if (i === numipfilters) {
    if (numipfilters === MAX_IPFILTERS) {
      Con_Printf("IP filter list is full\n");
      return;
    }
    numipfilters++;
  }

  if (!StringToFilter(Cmd_Argv(1), ipfilters[i])) ipfilters[i].compare = 0xffffffff;
}

/*
=================
SV_RemoveIP_f
=================
*/
export function SV_RemoveIP_f(): void {
  const f = new IpfilterT();

  if (!StringToFilter(Cmd_Argv(1), f)) return;
  for (let i = 0; i < numipfilters; i++)
    if (ipfilters[i].mask === f.mask && ipfilters[i].compare === f.compare) {
      for (let j = i + 1; j < numipfilters; j++) {
        ipfilters[j - 1].mask = ipfilters[j].mask;
        ipfilters[j - 1].compare = ipfilters[j].compare;
      }
      numipfilters--;
      Con_Printf("Removed.\n");
      return;
    }
  Con_Printf("Didn't find %s.\n", Cmd_Argv(1));
}

/*
=================
SV_ListIP_f
=================
*/
export function SV_ListIP_f(): void {
  Con_Printf("Filter list:\n");
  for (let i = 0; i < numipfilters; i++) {
    const b = unpackAddr(ipfilters[i].compare);
    Con_Printf("%3i.%3i.%3i.%3i\n", b[0], b[1], b[2], b[3]);
  }
}

/*
=================
SV_WriteIP_f
=================
*/
export function SV_WriteIP_f(): void {
  const name = Com_sprintf("%s/listip.cfg", com_gamedir);

  Con_Printf("Writing %s.\n", name);

  const f = Sys_FileOpenWrite(name);

  for (let i = 0; i < numipfilters; i++) {
    const b = unpackAddr(ipfilters[i].compare);
    const line = Com_sprintf("addip %i.%i.%i.%i\n", b[0], b[1], b[2], b[3]);
    const bytes = stringToLatin1Bytes(line);
    Sys_FileWrite(f, bytes, bytes.length);
  }

  Sys_FileClose(f);
}

/*
=================
SV_SendBan
=================
*/
export function SV_SendBan(): void {
  // data[0..3] = 0xff, data[4] = A2C_PRINT, data[5] = 0, then strcat at the NUL
  const body = "\nbanned.\n";
  const data = new Uint8Array(128);
  data[0] = data[1] = data[2] = data[3] = 0xff;
  data[4] = A2C_PRINT.charCodeAt(0);
  data.set(stringToLatin1Bytes(body), 5);
  data[5 + body.length] = 0;

  NET_SendPacket(5 + body.length, data, net_from);
}

/*
=================
SV_FilterPacket
=================
*/
export function SV_FilterPacket(): boolean {
  const inAddr = packAddr(net_from.ip);

  for (let i = 0; i < numipfilters; i++) if (((inAddr & ipfilters[i].mask) >>> 0) === ipfilters[i].compare) return Math.trunc(filterban.value) !== 0;

  return filterban.value === 0;
}

//============================================================================

/*
=================
SV_ReadPackets
=================
*/
export function SV_ReadPackets(): void {
  while (NET_GetPacket()) {
    if (SV_FilterPacket()) {
      SV_SendBan(); // tell them we aren't listening...
      continue;
    }

    // check for connectionless packet (0xffffffff) first
    if (net_message.data[0] === 0xff && net_message.data[1] === 0xff && net_message.data[2] === 0xff && net_message.data[3] === 0xff) {
      SV_ConnectionlessPacket();
      continue;
    }

    // read the qport out of the message so we can fix up
    // stupid address translating routers
    MSG_BeginReading();
    MSG_ReadLong(); // sequence number
    MSG_ReadLong(); // sequence number
    const qport = MSG_ReadShort() & 0xffff;

    // check for packets from connected clients
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const cl = svs.clients[i];
      if (cl.state === ClientStateT.cs_free) continue;
      if (!NET_CompareBaseAdr(net_from, cl.netchan.remote_address)) continue;
      if (cl.netchan.qport !== qport) continue;
      if (cl.netchan.remote_address.port !== net_from.port) {
        Con_DPrintf("SV_ReadPackets: fixing up a translated port\n");
        cl.netchan.remote_address.port = net_from.port;
      }
      if (Netchan_Process(cl.netchan)) {
        // this is a valid, sequenced packet, so process it
        svs.stats.packets++;
        cl.send_message = true; // reply at end of frame
        if (cl.state !== ClientStateT.cs_zombie) svUserMod().SV_ExecuteClientMessage(cl);
      }
      break;
    }

    // packet is not from a known client
    //	Con_Printf ("%s:sequenced packet without connection\n"
    // ,NET_AdrToString(net_from));
  }
}

/*
==================
SV_CheckTimeouts

If a packet has not been received from a client in timeout.value
seconds, drop the conneciton.

When a client is normally dropped, the client_t goes into a zombie state
for a few seconds to make sure any final reliable message gets resent
if necessary
==================
*/
export function SV_CheckTimeouts(): void {
  const droptime = svMainState.realtime - timeout.value;
  let nclients = 0;

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (cl.state === ClientStateT.cs_connected || cl.state === ClientStateT.cs_spawned) {
      if (!cl.spectator) nclients++;
      if (cl.netchan.last_received < droptime) {
        SV_BroadcastPrintf(PRINT_HIGH, "%s timed out\n", cl.name);
        SV_DropClient(cl);
        cl.state = ClientStateT.cs_free; // don't bother with zombie state
      }
    }
    if (cl.state === ClientStateT.cs_zombie && svMainState.realtime - cl.connection_started > zombietime.value) {
      cl.state = ClientStateT.cs_free; // can now be reused
    }
  }
  if (sv.paused && !nclients) {
    // nobody left, unpause the server
    svUserMod().SV_TogglePause("Pause released since no players are left.\n");
  }
}

/*
===================
SV_GetConsoleCommands

Add them exactly as if they had been typed at the console
===================
*/
export function SV_GetConsoleCommands(): void {
  for (;;) {
    const cmd = Sys_ConsoleInput();
    if (cmd === null) break;
    Cbuf_AddText(cmd);
  }
}

/*
===================
SV_CheckVars

===================
*/
let checkvars_pw: string | null = null;
let checkvars_spw: string | null = null;

export function SV_CheckVars(): void {
  if (password.string === checkvars_pw && spectator_password.string === checkvars_spw) return;
  const pw = password.string;
  const spw = spectator_password.string;
  checkvars_pw = pw;
  checkvars_spw = spw;

  let v = 0;
  if (pw && pw[0] && pw !== "none") v |= 1;
  if (spw && spw[0] && spw !== "none") v |= 2;

  Con_Printf("Updated needpass.\n");
  if (!v) svs.info = Info_SetValueForKey(svs.info, "needpass", "", MAX_SERVERINFO_STRING);
  else svs.info = Info_SetValueForKey(svs.info, "needpass", va("%i", v), MAX_SERVERINFO_STRING);
}

/*
==================
SV_Frame

==================
*/
let sv_frame_start = 0;
let sv_frame_end = 0;

export function SV_Frame(time: number): void {
  sv_frame_start = Sys_DoubleTime();
  svs.stats.idle += sv_frame_start - sv_frame_end;

  // keep the random time dependent
  rand();

  // decide the simulation time
  if (!sv.paused) {
    svMainState.realtime += time;
    sv.time += time;
  }
  netchanState.realtime = svMainState.realtime; // net_chan.c reads the `realtime` global -- see file header

  // check timeouts
  SV_CheckTimeouts();

  // toggle the log buffer if full
  SV_CheckLog();

  // move autonomous things around if enough time has passed
  if (!sv.paused) svPhysMod().SV_Physics();

  // get packets
  SV_ReadPackets();

  // check for commands typed to the host
  SV_GetConsoleCommands();

  // process console commands
  Cbuf_Execute();

  SV_CheckVars();

  // send messages back to the clients that had packets read this frame
  SV_SendClientMessages();

  // send a heartbeat to the master if needed
  Master_Heartbeat();

  // collect timing statistics
  sv_frame_end = Sys_DoubleTime();
  svs.stats.active += sv_frame_end - sv_frame_start;
  if (++svs.stats.count === STATFRAMES) {
    svs.stats.latched_active = svs.stats.active;
    svs.stats.latched_idle = svs.stats.idle;
    svs.stats.latched_packets = svs.stats.packets;
    svs.stats.active = 0;
    svs.stats.idle = 0;
    svs.stats.packets = 0;
    svs.stats.count = 0;
  }
}

/*
===============
SV_InitLocal
===============
*/
export function SV_InitLocal(): void {
  const svPhys = svPhysMod();
  const prCmds = prCmdsMod();

  svCcmdsMod().SV_InitOperatorCommands();
  svUserMod().SV_UserInit();

  Cvar_RegisterVariable(rcon_password);
  Cvar_RegisterVariable(password);
  Cvar_RegisterVariable(spectator_password);

  Cvar_RegisterVariable(sv_mintic);
  Cvar_RegisterVariable(sv_maxtic);

  Cvar_RegisterVariable(fraglimit);
  Cvar_RegisterVariable(timelimit);
  Cvar_RegisterVariable(teamplay);
  Cvar_RegisterVariable(samelevel);
  Cvar_RegisterVariable(maxclients);
  Cvar_RegisterVariable(maxspectators);
  Cvar_RegisterVariable(hostname);
  Cvar_RegisterVariable(deathmatch);
  Cvar_RegisterVariable(spawn);
  Cvar_RegisterVariable(watervis);

  Cvar_RegisterVariable(developer);

  Cvar_RegisterVariable(timeout);
  Cvar_RegisterVariable(zombietime);

  Cvar_RegisterVariable(svPhys.sv_maxvelocity);
  Cvar_RegisterVariable(svPhys.sv_gravity);
  Cvar_RegisterVariable(svPhys.sv_stopspeed);
  Cvar_RegisterVariable(svPhys.sv_maxspeed);
  Cvar_RegisterVariable(svPhys.sv_spectatormaxspeed);
  Cvar_RegisterVariable(svPhys.sv_accelerate);
  Cvar_RegisterVariable(svPhys.sv_airaccelerate);
  Cvar_RegisterVariable(svPhys.sv_wateraccelerate);
  Cvar_RegisterVariable(svPhys.sv_friction);
  Cvar_RegisterVariable(svPhys.sv_waterfriction);

  Cvar_RegisterVariable(prCmds.sv_aim);

  Cvar_RegisterVariable(filterban);

  Cvar_RegisterVariable(allow_download);
  Cvar_RegisterVariable(allow_download_skins);
  Cvar_RegisterVariable(allow_download_models);
  Cvar_RegisterVariable(allow_download_sounds);
  Cvar_RegisterVariable(allow_download_maps);

  Cvar_RegisterVariable(sv_highchars);

  Cvar_RegisterVariable(sv_phs);

  Cvar_RegisterVariable(pausable);

  Cmd_AddCommand("addip", SV_AddIP_f);
  Cmd_AddCommand("removeip", SV_RemoveIP_f);
  Cmd_AddCommand("listip", SV_ListIP_f);
  Cmd_AddCommand("writeip", SV_WriteIP_f);

  const localmodels = svInitMod().localmodels;
  for (let i = 0; i < MAX_MODELS; i++) localmodels[i] = Com_sprintf("*%i", i);

  svs.info = Info_SetValueForStarKey(svs.info, "*version", va("%4.2f", VERSION), MAX_SERVERINFO_STRING);

  // init fraglog stuff
  svs.logsequence = 1;
  svs.logtime = svMainState.realtime;
  svs.log[0].data = svs.log_buf[0];
  svs.log[0].maxsize = svs.log_buf[0].length;
  svs.log[0].cursize = 0;
  svs.log[0].allowoverflow = true;
  svs.log[1].data = svs.log_buf[1];
  svs.log[1].maxsize = svs.log_buf[1].length;
  svs.log[1].cursize = 0;
  svs.log[1].allowoverflow = true;
}

//============================================================================

/*
================
Master_Heartbeat

Send a message to the master every few minutes to
let it know we are alive, and log information
================
*/
const HEARTBEAT_SECONDS = 300;

export function Master_Heartbeat(): void {
  if (svMainState.realtime - svs.last_heartbeat < HEARTBEAT_SECONDS) return; // not time to send yet

  svs.last_heartbeat = svMainState.realtime;

  //
  // count active users
  //
  let active = 0;
  for (let i = 0; i < MAX_CLIENTS; i++) if (svs.clients[i].state === ClientStateT.cs_connected || svs.clients[i].state === ClientStateT.cs_spawned) active++;

  svs.heartbeat_sequence++;
  const string = Com_sprintf("%c\n%i\n%i\n", S2M_HEARTBEAT, svs.heartbeat_sequence, active);

  // send to group master
  for (let i = 0; i < MAX_MASTERS; i++)
    if (master_adr[i].port) {
      Con_Printf("Sending heartbeat to %s\n", NET_AdrToString(master_adr[i]));
      NET_SendPacket(string.length, stringToLatin1Bytes(string), master_adr[i]);
    }
}

/*
=================
Master_Shutdown

Informs all masters that this server is going down
=================
*/
export function Master_Shutdown(): void {
  const string = Com_sprintf("%c\n", S2M_SHUTDOWN);

  // send to group master
  for (let i = 0; i < MAX_MASTERS; i++)
    if (master_adr[i].port) {
      Con_Printf("Sending heartbeat to %s\n", NET_AdrToString(master_adr[i]));
      NET_SendPacket(string.length, stringToLatin1Bytes(string), master_adr[i]);
    }
}

/*
=================
SV_ExtractFromUserinfo

Pull specific info from a newly changed userinfo string
into a more C freindly form.
=================
*/
function isNameSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\r" || ch === "\n";
}

export function SV_ExtractFromUserinfo(cl: ClientT): void {
  let dupc = 1;

  // name for C code
  let val = Info_ValueForKey(cl.userinfo, "name");

  // trim user name
  let newname = val.slice(0, 79); // char newname[80]

  let p = 0;
  while (p < newname.length && isNameSpace(newname[p])) p++;

  if (p !== 0 && p === newname.length) {
    // white space only
    newname = "unnamed";
    p = 0;
  }

  if (p !== 0 && p < newname.length) {
    newname = newname.slice(p);
  }
  if (newname.length > 0) {
    let q = newname.length - 1;
    while (q !== 0 && isNameSpace(newname[q])) q--;
    newname = newname.slice(0, q + 1);
  }

  if (val !== newname) {
    cl.userinfo = Info_SetValueForKey(cl.userinfo, "name", newname, MAX_INFO_STRING);
    val = Info_ValueForKey(cl.userinfo, "name");
  }

  if (!val[0] || Q_strcasecmp(val, "console") === 0) {
    cl.userinfo = Info_SetValueForKey(cl.userinfo, "name", "unnamed", MAX_INFO_STRING);
    val = Info_ValueForKey(cl.userinfo, "name");
  }

  // check to see if another user by the same name exists
  for (;;) {
    let i = 0;
    for (; i < MAX_CLIENTS; i++) {
      const client = svs.clients[i];
      if (client.state !== ClientStateT.cs_spawned || client === cl) continue;
      if (Q_strcasecmp(client.name, val) === 0) break;
    }
    if (i !== MAX_CLIENTS) {
      // dup name
      if (val.length > 31) val = val.slice(0, 28); // sizeof(cl->name) - 4
      let base = val;

      if (val[0] === "(") {
        if (val[2] === ")") base = val.slice(3);
        else if (val[3] === ")") base = val.slice(4);
      }

      newname = Com_sprintf("(%d)%-.40s", dupc++, base);
      cl.userinfo = Info_SetValueForKey(cl.userinfo, "name", newname, MAX_INFO_STRING);
      val = Info_ValueForKey(cl.userinfo, "name");
    } else break;
  }

  if (val.slice(0, cl.name.length) !== cl.name) {
    if (!sv.paused) {
      if (!cl.lastnametime || svMainState.realtime - cl.lastnametime > 5) {
        cl.lastnamecount = 0;
        cl.lastnametime = svMainState.realtime;
      } else if (cl.lastnamecount++ > 4) {
        SV_BroadcastPrintf(PRINT_HIGH, "%s was kicked for name spam\n", cl.name);
        SV_ClientPrintf(cl, PRINT_HIGH, "You were kicked from the game for name spamming\n");
        SV_DropClient(cl);
        return;
      }
    }

    if (cl.state >= ClientStateT.cs_spawned && !cl.spectator) SV_BroadcastPrintf(PRINT_HIGH, "%s changed name to %s\n", cl.name, val);
  }

  cl.name = val.slice(0, 31);

  // rate command
  val = Info_ValueForKey(cl.userinfo, "rate");
  if (val.length) {
    let i = Q_atoi(val);
    if (i < 500) i = 500;
    if (i > 10000) i = 10000;
    cl.netchan.rate = 1.0 / i;
  }

  // msg command
  val = Info_ValueForKey(cl.userinfo, "msg");
  if (val.length) {
    cl.messagelevel = Q_atoi(val);
  }
}

//============================================================================

// QW/client/cvar.c's Cvar_Set `#ifdef SERVERONLY` block -- see file header.
// SV_SendServerInfoChange is sv_ccmds.c-owned (its true C home is
// sv_ccmds.c:527) and exported from src/qw/server/sv_ccmds.ts; reached
// through the lazy `svCcmdsMod()` helper above rather than a direct import,
// since sv_ccmds.ts imports sv_send.ts, which this file also imports, so a
// direct import of sv_ccmds.ts here would be one hop from a cycle (the same
// reasoning sv_ccmds.ts's own file header gives for its lazy `svMainMod()`).
export function SV_CvarInfoHook(name: string, value: string): void {
  svs.info = Info_SetValueForKey(svs.info, name, value, MAX_SERVERINFO_STRING);
  svCcmdsMod().SV_SendServerInfoChange(name, value);
  //		SV_BroadcastCommand ("fullserverinfo \"%s\"\n", svs.info);
}

//============================================================================

/*
====================
SV_InitNet
====================
*/
export function SV_InitNet(): void {
  let port = PORT_SERVER;
  const p = COM_CheckParm("-port");
  if (p && p < com_argc) {
    port = Q_atoi(com_argv[p + 1]);
    Con_Printf("Port: %i\n", port);
  }
  NET_Init(port);

  Netchan_Init();

  // net_chan.c's #ifdef SERVERONLY branches -- see file header
  netchanState.isClient = false;
  setNetchanServerHooks({ isPaused: ServerPaused });

  // heartbeats will allways be sent to the id master
  svs.last_heartbeat = -99999; // send immediately
  //	NET_StringToAdr ("192.246.40.70:27000", &idmaster_adr);
}

//============================================================================
// __TIME__ / __DATE__ / buildnum.c -- see file header

const EXE_BUILD_TIME = "16:19:31";
const EXE_BUILD_DATE = "Dec 20 1999";

const build_mon: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const build_mond: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// returns days since Oct 24 1996
function build_number(): number {
  let m = 0;
  let d = 0;

  for (m = 0; m < 11; m++) {
    if (Q_strcasecmp(EXE_BUILD_DATE.slice(0, 3), build_mon[m]) === 0) break;
    d += build_mond[m];
  }

  d += Q_atoi(EXE_BUILD_DATE.slice(4)) - 1;

  const y = Q_atoi(EXE_BUILD_DATE.slice(7)) - 1900;

  let b = d + Math.trunc((y - 1) * 365.25);

  if (y % 4 === 0 && m > 1) {
    b += 1;
  }

  b -= 34995; // Oct 24 1996

  return b;
}

/*
====================
SV_Init
====================
*/
export function SV_Init(parms: QuakeParmsT): void {
  // QW/client/cvar.c's SERVERONLY serverinfo propagation -- see file header
  setCvarInfoHook(SV_CvarInfoHook);

  COM_InitArgv(parms.argv);
  COM_AddParm("-game");
  COM_AddParm("qw");

  if (COM_CheckParm("-minmemory")) parms.memsize = MINIMUM_MEMORY;

  // host_parms = *parms -- src/common/common.ts owns the singleton
  host_parms.basedir = parms.basedir;
  host_parms.cachedir = parms.cachedir;
  host_parms.argc = parms.argc;
  host_parms.argv = parms.argv;
  host_parms.membase = parms.membase;
  host_parms.memsize = parms.memsize;

  if (parms.memsize < MINIMUM_MEMORY) SV_Error("Only %4.1f megs of memory reported, can't execute game", parms.memsize / 0x100000);

  Memory_Init(parms.memsize);
  Cbuf_Init();
  Cmd_Init();

  COM_Init();

  PR_Init();
  Mod_Init();

  SV_InitNet();

  SV_InitLocal();
  Sys_Init();
  Pmove_Init();

  Hunk_AllocName(0, "-HOST_HUNKLEVEL-");
  svMainState.host_hunklevel = Hunk_LowMark();

  Cbuf_InsertText("exec server.cfg\n");

  svMainState.host_initialized = true;

  Con_Printf("Exe: %s %s\n", EXE_BUILD_TIME, EXE_BUILD_DATE);
  Con_Printf("%4.1f megabyte heap\n", parms.memsize / (1024 * 1024.0));

  Con_Printf("\nServer Version %4.2f (Build %04d)\n\n", VERSION, build_number());

  Con_Printf("======== QuakeWorld Initialized ========\n");

  // process command line arguments
  Cmd_StuffCmds_f();
  Cbuf_Execute();

  // if a map wasn't specified on the command line, spawn start.map
  if (sv.state === ServerStateT.ss_dead) Cmd_ExecuteString("map start");
  if (sv.state === ServerStateT.ss_dead) SV_Error("Couldn't spawn a server");
}
