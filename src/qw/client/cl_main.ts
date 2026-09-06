/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_main.c (GNU GPL v2 or later).

cl_main.c -- client main loop. In QuakeWorld this file also absorbs
WinQuake's host.c: Host_EndGame/Host_Error/Host_WriteConfiguration/Host_Frame/
Host_Init/Host_Shutdown and the `host_*` globals all live here, because qwcl
has no server half to host.

Deviations from PORTING.md / the C source:
- `host_initialized`/`host_frametime`/`realtime`/`oldrealtime`/
  `host_framecount`/`host_hunklevel`/`fps_count`/`connect_time`/
  `server_version`/`nomaster`/`noclip_anglehack` are reassigned scalars, so
  they live in the exported `clMainState` holder, the same shape
  src/qw/server/sv_main.ts uses for `svMainState` and src/common/host.ts for
  `host`. `netchanState.realtime` (src/qw/net_chan.ts) is net_chan.c's read of
  the same `realtime` global; Host_Frame republishes it once per frame, the
  only writer on the client side. `host.realtime`/`host.frametime`/
  `host.framecount` (src/common/host.ts) are those same three C globals as the
  shared src/client modules see them -- view.c's V_CalcBob/CalcGunAngle/
  DropPunchAngle, screen.c's SCR_SetUpToDrawConsole/SCR_DrawNet, cl_input.c's
  CL_AdjustAngles and snd_dma.c's ambient fade all read them on both tracks --
  so Host_Frame republishes those three as well, for the same reason.
- `Sys_DoubleTime` is this port's `Sys_FloatTime` (src/platform/sys.ts).
- `setjmp (host_abort)` / `longjmp (host_abort, 1)` -> `HostEndGame`
  (src/common/host.ts's class, reused rather than redeclared) thrown by
  Host_EndGame and caught by Host_Frame.
- `Host_Error` ends in `Sys_Error ("Host_Error: %s\n", string)` in the QW
  source -- it is fatal on the client, unlike WinQuake's, which longjmps.
  Ported verbatim, so it throws `SysError` (src/platform/sys.ts), not
  `HostError`. The `inerror` reentrancy guard is kept exactly as the C's.
- `adr.port = BigShort (27500)`: src/qw/net_udp.ts keeps `netadr_t.port` in
  host byte order throughout (its own ruling; the C's ntohs/htons pair is
  simply absent there), so the byte swap is absent here too and the port is
  assigned as the plain number 27500.
- `sprintf (data, "%c%c%c%cconnect ...", 255,255,255,255, ...)` and the
  A2A_ACK / rcon / packet replies build a `Uint8Array` directly: the four
  0xff bytes are not representable in a JS string the wire layer would
  re-encode byte-for-byte. `strlen(data)` counts those four bytes, so the
  lengths below match the C's.
- `Con_Printf ("Exe: "__TIME__" "__DATE__"\n")` in CL_Version_f is dropped:
  `__TIME__`/`__DATE__` are C-compiler build-date macros with no bun
  equivalent (src/qw/common.ts made the same call for build_number()).
- `build_number()` is not ported by src/qw/common.ts (its only input is
  `__DATE__`). CL_Init's `*ver` userinfo value and Host_Init's closing banner
  both need it, so this file carries a module-local `build_number()` running
  QW common.c's own "days since Oct 24 1996" arithmetic over the *current*
  date instead of a compile-time one -- the closest faithful thing available,
  reported rather than stubbed to a constant.
- `memset (cl_efrags, 0, sizeof(cl_efrags))` and the free-efrag chain use
  src/client/client.ts's shared `cl_efrags` (MAX_EFRAGS = 640) rather than a
  QW-sized copy (QW/client/client.h reduces MAX_EFRAGS to 512). The array is
  a client-wide singleton the renderer's R_AddEfrags/R_RemoveEfrags already
  walk; a second one would split that state. Only the free-list length
  differs, and nothing in QW depends on its exact size.
- `dlight_t.color[4]` (QW/client/client.h's dlight_t) is a field on
  src/client/client.ts's `DlightT`, inert on the WinQuake path, so
  CL_ClearState's `memset (cl_dlights, ...)` zeroes it with the rest.
- `cl_visedicts`/`cl_oldvisedicts`/`cl_visedicts_list`/`cl_numvisedicts`/
  `cl_oldnumvisedicts` are declared in cl_main.c but read and written only by
  cl_ents.c and the renderer; they are not declared here, so the concurrent
  cl_ents unit owns them.
- Host_Init ports the `#ifdef __linux__` branch (PORTING.md: take the
  portable path). That branch does NOT call `S_Init()` -- QW's linux video
  drivers (vid_x.c:371, vid_svgalib.c:562, gl_vidlinuxglx.c:606) call it from
  inside VID_Init, which is what the "S_Init is now done as part of VID.
  Sigh." comment means. src/platform/vid.ts's VID_Init makes the same call
  under `qw.active` (see its own comment there), so nothing is missing here.
- `Host_SimulationTime` is inside `#if 0` in the C and is dropped per
  PORTING.md's `#if 0` rule; Host_Frame carries the same fps arithmetic
  inline, which is the code that actually runs.
- `#ifdef _WIN32` SetWindowText/ShowWindow/SetForegroundWindow and the
  `#ifdef _WINDOWS` CL_Windows_f command are dropped (no Win32 window here).
- CL_Quit_f's always-true `if (1)` (the C comments out the key_dest test)
  so `CL_Disconnect (); Sys_Quit ();` is dead code there. Kept verbatim
  behind the same always-true condition.
- CL_FullServerinfo_f reads the key `"*vesion"` (sic, a typo in the C for
  "*version"), so the version print never fires against a real server.
  Preserved exactly as the C has it.
- `cls.qw.download` is `FILE *download` opened "wb". src/common/common.ts's
  `FileHandle` is the port's FILE* stand-in but its COM_FRead is read-only,
  so downloads are written through `Sys_FileWrite(cls.qw.download.fd, ...)`
  and closed with `Sys_FileClose`, the same split src/client/cl_demo.ts uses
  for its write handle. cl_parse.ts owns that write path; this file only
  closes the handle (CL_Disconnect) and tests it for null.
- `Cmd_ForwardToServer` reaches the netchan through `qwCmdHooks.netchanMessage`
  (src/qw/cmd.ts). `Netchan_Setup` allocates a fresh `SizeBuf` each call, so
  the hook is re-pointed at `cls.qw.netchan.message` after every setup.
- QW cvar.c's `#ifndef SERVERONLY` info propagation is installed here as the
  `setCvarInfoHook` callback (src/common/cvar.ts's fold, PORTING.md's
  QuakeWorld track). CL_Init installs it before registering any cvar, since
  in the C it is compiled in unconditionally.
- `Host_WriteConfiguration`'s `fopen` goes through platform/sys.ts's
  `Sys_FileOpenWrite`, which throws `SysError` where the C's `fopen` returned
  NULL (e.g. `-game` names a directory that doesn't exist). Caught around the
  open the same way the C tests `fopen`'s return against NULL, so
  `Con_Printf ("Couldn't write config.cfg.\n"); return;` stays reachable
  instead of the error propagating out through Sys_Quit (src/platform/sys.ts's
  `installTerminationSignals`).
*/

import { Cbuf_AddText, Cbuf_Execute, Cbuf_Init, Cbuf_InsertText, Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cmd_ForwardToServer, Cmd_Init, cl_warncmd, qwCmdHooks } from "../cmd";
import { cmdHost } from "../../common/cmd";
import {
  COM_Init,
  COM_InitArgv,
  COM_AddParm,
  COM_CheckParm,
  COM_LoadHunkFile,
  Info_Print,
  Info_SetValueForKey,
  Info_SetValueForStarKey,
  Info_ValueForKey,
  MAX_INFO_STRING,
  MSG_BeginReading,
  MSG_ReadByte,
  MSG_ReadLong,
  MSG_ReadString,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteString,
  Q_atof,
  Q_atoi,
  Q_strcasecmp,
  SZ_Clear,
  SZ_Print,
  com_gamedir,
  host_parms,
  net_message,
  va,
} from "../common";
import { MINIMUM_MEMORY, VERSION } from "../bothdefs";
import { NET_AdrToString, NET_CompareAdr, NET_Init, NET_IsClientLegal, NET_SendPacket, NET_Shutdown, NET_StringToAdr, NetadrT, net_from, net_local_adr } from "../net_udp";
import { Netchan_Init, Netchan_Process, Netchan_Setup, Netchan_Transmit, netchanState } from "../net_chan";
import { A2A_ACK, A2A_PING, A2C_CLIENT_COMMAND, A2C_PRINT, ClcOpsT, MAX_CLIENTS, PORT_CLIENT, PROTOCOL_VERSION, S2C_CHALLENGE, S2C_CONNECTION } from "../protocol";
import { Cvar_RegisterVariable, Cvar_Set, Cvar_VariableValue, Cvar_WriteVariables, CvarT, setCvarInfoHook } from "../../common/cvar";
import { host, HostEndGame, SysFileTextWriter } from "../../common/host";
import { FileHandle } from "../../common/common";
import type { QuakeParmsT } from "../../common/quakedef";
import { Mod_ClearAll, Mod_Init } from "../../common/model";
import { Com_sprintf } from "../../common/sprintf";
import { W_LoadWadFile } from "../../common/wad";
import { Hunk_AllocName, Hunk_FreeToLowMark, Hunk_LowMark, Memory_Init } from "../../common/zone";
import { vec3_origin } from "../../common/mathlib";
import { cdAudio } from "../../client/cdaudio";
import { CactiveT, cl, cl_dlights, cl_efrags, cl_lightstyle, cls, MAX_DEMOS } from "../../client/client";
import { DownloadTypeT } from "./client";
import { Con_DPrintf, Con_Init, Con_Print, Con_Printf } from "./console";
import { inputBackend } from "../../client/input";
import { Key_Init, Key_WriteBindings } from "../../client/keys";
import { getRenderer, r_origin, re, vpn, vright, vup } from "../../client/render";
import { S_StopAllSounds, S_Shutdown, S_Update } from "../../client/snd_dma";
import { vidBackend } from "../../client/vid";
import { V_Init } from "../../client/view";
import { Sys_Error, Sys_FileClose, Sys_FileOpenWrite, Sys_FloatTime, Sys_Quit, Sys_SendKeyEvents, Sys_mkdir, SysError } from "../../platform/sys";
import { CL_DecayLights, CL_EmitEntities, CL_SetUpPlayerPrediction } from "./cl_ents";
import { CL_InitPrediction, CL_PredictMove } from "./cl_pred";
import { Cam_Reset, CL_InitCam } from "./cl_cam";
import { baseskin, noskins, Skin_AllSkins_f, Skin_Skins_f } from "./skin";
import { CL_InitInput, CL_SendCmd, cl_anglespeedkey, cl_backspeed, cl_forwardspeed, cl_movespeedkey, cl_pitchspeed, cl_sidespeed, cl_upspeed, cl_yawspeed } from "./cl_input";
import { CL_ClearTEnts, CL_InitTEnts } from "./cl_tent";
import { CL_GetMessage, CL_PlayDemo_f, CL_Record_f, CL_ReRecord_f, CL_Stop_f, CL_StopPlayback, CL_TimeDemo_f } from "./cl_demo";
import { CL_ParseServerMessage, CL_StopUpload, CL_NextUpload } from "./cl_parse";
import { Pmove_Init } from "../pmove";
import { M_Init, M_Menu_Quit_f } from "./menu";
import { Sbar_Init } from "./sbar";
import { SCR_Init, SCR_UpdateScreen } from "./screen";

// we need to declare some mouse variables here, because the menu system
// references them even when on a unix system.

// `qboolean noclip_anglehack; // remnant from old quake` plus the host_*
// globals of the file -- see file header for why these live in one holder.
export const clMainState = {
  noclip_anglehack: false,
  host_initialized: false, // true if into command execution
  nomaster: false,
  host_frametime: 0,
  realtime: 0, // without any filtering or bounding
  oldrealtime: 0, // last frame run
  host_framecount: 0,
  host_hunklevel: 0,
  fps_count: 0,
  connect_time: -1, // for connection retransmits
  server_version: 0, // version of server we connected to
};

// byte *host_basepal; byte *host_colormap; -- reassigned pointers, so they
// live in one-field holders (PORTING.md's "reassigned pointer" rule).
export const host_basepal: { data: Uint8Array | null } = { data: null };
export const host_colormap: { data: Uint8Array | null } = { data: null };

export const rcon_password = new CvarT("rcon_password", "", false);

export const rcon_address = new CvarT("rcon_address", "");

export const cl_timeout = new CvarT("cl_timeout", "60");

export const cl_shownet = new CvarT("cl_shownet", "0"); // can be 0, 1, or 2

export const cl_sbar = new CvarT("cl_sbar", "0", true);
export const cl_hudswap = new CvarT("cl_hudswap", "0", true);
export const cl_maxfps = new CvarT("cl_maxfps", "0", true);

export const lookspring = new CvarT("lookspring", "0", true);
export const lookstrafe = new CvarT("lookstrafe", "0", true);
export const sensitivity = new CvarT("sensitivity", "3", true);

export const m_pitch = new CvarT("m_pitch", "0.022", true);
export const m_yaw = new CvarT("m_yaw", "0.022");
export const m_forward = new CvarT("m_forward", "1");
export const m_side = new CvarT("m_side", "0.8");

export const entlatency = new CvarT("entlatency", "20");
export const cl_predict_players = new CvarT("cl_predict_players", "1");
export const cl_predict_players2 = new CvarT("cl_predict_players2", "1");
export const cl_solid_players = new CvarT("cl_solid_players", "1");

export const localid = new CvarT("localid", "");

let allowremotecmd = true;

//
// info mirrors
//
export const password = new CvarT("password", "", false, false, true);
export const spectator = new CvarT("spectator", "", false, false, true);
export const name = new CvarT("name", "unnamed", true, false, true);
export const team = new CvarT("team", "", true, false, true);
export const skin = new CvarT("skin", "", true, false, true);
export const topcolor = new CvarT("topcolor", "0", true, false, true);
export const bottomcolor = new CvarT("bottomcolor", "0", true, false, true);
export const rate = new CvarT("rate", "2500", true, false, true);
export const noaim = new CvarT("noaim", "0", true, false, true);
export const msg = new CvarT("msg", "1", true, false, true);

export const master_adr = new NetadrT(); // address of the master server

export const host_speeds = new CvarT("host_speeds", "0"); // set for running times
export const show_fps = new CvarT("show_fps", "0"); // set for running times
export const developer = new CvarT("developer", "0");

// The five obfuscated command names: each C initializer is a char array of
// bytes XOR 0xff, decoded in place by Host_FixupModelNames.
export const modelNames = {
  emodel_name: xorString("emodel"),
  pmodel_name: xorString("pmodel"),
  prespawn_name: xorString("prespawn %i 0 %i"),
  modellist_name: xorString("modellist %i %i"),
  soundlist_name: xorString("soundlist %i %i"),
};

function xorString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ 0xff);
  return out;
}

// see file header: QW/client/common.c's build_number() over __DATE__, which
// this port has no equivalent of, run over the current date instead.
const buildMon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const buildMond = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
let buildNumberCache = 0;

function build_number(): number {
  if (buildNumberCache !== 0) return buildNumberCache;

  const now = new Date();
  const date = `${buildMon[now.getMonth()]} ${String(now.getDate()).padStart(2, " ")} ${now.getFullYear()}`;

  let m = 0;
  let d = 0;
  for (m = 0; m < 11; m++) {
    if (Q_strcasecmp(date.slice(0, 3), buildMon[m]) === 0) break;
    d += buildMond[m];
  }

  d += Q_atoi(date.slice(4)) - 1;

  const y = Q_atoi(date.slice(7)) - 1900;

  let b = d + Math.trunc((y - 1) * 365.25);

  if (y % 4 === 0 && m > 1) b += 1;
  b -= 35778; // Dec 16 1998

  buildNumberCache = b;
  return b;
}

function bytesFromString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// "%c%c%c%c<text>" with 255,255,255,255 as the four leading bytes
function connectlessPacket(text: string): Uint8Array {
  const body = bytesFromString(text);
  const out = new Uint8Array(4 + body.length);
  out[0] = out[1] = out[2] = out[3] = 0xff;
  out.set(body, 4);
  return out;
}

/*
==================
CL_Quit_f
==================
*/
export function CL_Quit_f(): void {
  if (true /* key_dest != key_console */ /* && cls.state != ca_dedicated */) {
    M_Menu_Quit_f();
    return;
  }
  CL_Disconnect();
  Sys_Quit();
}

/*
=======================
CL_Version_f
======================
*/
export function CL_Version_f(): void {
  Con_Printf("Version %4.2f\n", VERSION);
  // Con_Printf ("Exe: "__TIME__" "__DATE__"\n"); -- see file header
}

/*
=======================
CL_SendConnectPacket

called by CL_Connect_f and CL_CheckResend
======================
*/
export function CL_SendConnectPacket(): void {
  const adr = new NetadrT();
  // JACK: Fixed bug where DNS lookups would cause two connects real fast
  //       Now, adds lookup time to the connect time.
  //		 Should I add it to realtime instead?!?!

  if (cls.state !== CactiveT.ca_disconnected) return;

  const t1 = Sys_FloatTime();

  if (!NET_StringToAdr(cls.qw.servername, adr)) {
    Con_Printf("Bad server address\n");
    clMainState.connect_time = -1;
    return;
  }

  if (!NET_IsClientLegal(adr)) {
    Con_Printf("Illegal server address\n");
    clMainState.connect_time = -1;
    return;
  }

  if (adr.port === 0) adr.port = 27500;
  const t2 = Sys_FloatTime();

  clMainState.connect_time = clMainState.realtime + t2 - t1; // for retransmit requests

  cls.qw.qport = Cvar_VariableValue("qport");

  cls.qw.userinfo = Info_SetValueForStarKey(cls.qw.userinfo, "*ip", NET_AdrToString(adr), MAX_INFO_STRING);

  //	Con_Printf ("Connecting to %s...\n", cls.servername);
  const data = connectlessPacket(
    Com_sprintf('connect %i %i %i "%s"\n', PROTOCOL_VERSION, cls.qw.qport, cls.qw.challenge, cls.qw.userinfo),
  );
  NET_SendPacket(data.length, data, adr);
}

/*
=================
CL_CheckForResend

Resend a connect message if the last one has timed out

=================
*/
export function CL_CheckForResend(): void {
  const adr = new NetadrT();

  if (clMainState.connect_time === -1) return;
  if (cls.state !== CactiveT.ca_disconnected) return;
  if (clMainState.connect_time && clMainState.realtime - clMainState.connect_time < 5.0) return;

  const t1 = Sys_FloatTime();
  if (!NET_StringToAdr(cls.qw.servername, adr)) {
    Con_Printf("Bad server address\n");
    clMainState.connect_time = -1;
    return;
  }
  if (!NET_IsClientLegal(adr)) {
    Con_Printf("Illegal server address\n");
    clMainState.connect_time = -1;
    return;
  }

  if (adr.port === 0) adr.port = 27500;
  const t2 = Sys_FloatTime();

  clMainState.connect_time = clMainState.realtime + t2 - t1; // for retransmit requests

  Con_Printf("Connecting to %s...\n", cls.qw.servername);
  const data = connectlessPacket("getchallenge\n");
  NET_SendPacket(data.length, data, adr);
}

export function CL_BeginServerConnect(): void {
  clMainState.connect_time = 0;
  CL_CheckForResend();
}

/*
================
CL_Connect_f

================
*/
export function CL_Connect_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("usage: connect <server>\n");
    return;
  }

  const server = Cmd_Argv(1);

  CL_Disconnect();

  cls.qw.servername = server;
  CL_BeginServerConnect();
}

/*
=====================
CL_Rcon_f

  Send the rest of the command line over as
  an unconnected command.
=====================
*/
export function CL_Rcon_f(): void {
  const to = new NetadrT();

  // `if (!rcon_password.string)` -- a char* null test that is never true
  // once the cvar is registered; kept as the empty-string test that has the
  // same meaning for this port's string-valued cvars.
  if (rcon_password.string === "") {
    Con_Printf("You must set 'rcon_password' before\n" + "issuing an rcon command.\n");
    return;
  }

  let message = "rcon ";
  message += rcon_password.string;
  message += " ";

  for (let i = 1; i < Cmd_Argc(); i++) {
    message += Cmd_Argv(i);
    message += " ";
  }

  if (cls.state >= CactiveT.ca_connected) {
    const remote = cls.qw.netchan.remote_address;
    to.ip.set(remote.ip);
    to.port = remote.port;
    to.pad = remote.pad;
  } else {
    if (rcon_address.string.length === 0) {
      Con_Printf(
        "You must either be connected,\n" + "or set the 'rcon_address' cvar\n" + "to issue rcon commands\n",
      );

      return;
    }
    NET_StringToAdr(rcon_address.string, to);
  }

  const packet = connectlessPacket(message);
  // NET_SendPacket (strlen(message)+1, ...) -- the trailing NUL is sent too
  const data = new Uint8Array(packet.length + 1);
  data.set(packet, 0);
  NET_SendPacket(data.length, data, to);
}

/*
=====================
CL_ClearState

=====================
*/
export function CL_ClearState(): void {
  S_StopAllSounds(true);

  Con_DPrintf("Clearing memory\n");
  getRenderer().D_FlushCaches();
  Mod_ClearAll();
  if (clMainState.host_hunklevel) Hunk_FreeToLowMark(clMainState.host_hunklevel);

  CL_ClearTEnts();

  // wipe the entire cl structure
  cl.clear();
  cl.qw.clear();

  SZ_Clear(cls.qw.netchan.message);

  // clear other arrays
  for (const e of cl_efrags) {
    e.leaf = null;
    e.leafnext = null;
    e.entity = null;
    e.entnext = null;
  }
  for (const d of cl_dlights) {
    d.origin[0] = d.origin[1] = d.origin[2] = 0;
    d.radius = 0;
    d.die = 0;
    d.decay = 0;
    d.minlight = 0;
    d.key = 0;
    d.color.fill(0);
  }
  for (const ls of cl_lightstyle) {
    ls.map = "";
    ls.length = 0;
  }

  //
  // allocate the efrags and chain together into a free list
  //
  cl.free_efrags = cl_efrags[0];
  let i = 0;
  for (i = 0; i < cl_efrags.length - 1; i++) cl_efrags[i].entnext = cl_efrags[i + 1];
  cl_efrags[i].entnext = null;
}

/*
=====================
CL_Disconnect

Sends a disconnect message to the server
This is also called on Host_Error, so it shouldn't cause any errors
=====================
*/
export function CL_Disconnect(): void {
  clMainState.connect_time = -1;

  // stop sounds (especially looping!)
  S_StopAllSounds(true);

  // if running a local server, shut it down
  if (cls.demoplayback) CL_StopPlayback();
  else if (cls.state !== CactiveT.ca_disconnected) {
    if (cls.demorecording) CL_Stop_f();

    const final = new Uint8Array(10);
    final[0] = ClcOpsT.clc_stringcmd;
    final.set(bytesFromString("drop"), 1);
    Netchan_Transmit(cls.qw.netchan, 6, final);
    Netchan_Transmit(cls.qw.netchan, 6, final);
    Netchan_Transmit(cls.qw.netchan, 6, final);

    cls.state = CactiveT.ca_disconnected;

    cls.demoplayback = cls.demorecording = cls.timedemo = false;
  }
  Cam_Reset();

  if (cls.qw.download) {
    Sys_FileClose(cls.qw.download.fd);
    cls.qw.download = null;
  }

  CL_StopUpload();
}

export function CL_Disconnect_f(): void {
  CL_Disconnect();
}

/*
====================
CL_User_f

user <name or userid>

Dump userdata / masterdata for a user
====================
*/
export function CL_User_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("Usage: user <username / userid>\n");
    return;
  }

  const uid = Q_atoi(Cmd_Argv(1));

  for (let i = 0; i < MAX_CLIENTS; i++) {
    if (!cl.qw.players[i].name) continue;
    if (cl.qw.players[i].userid === uid || cl.qw.players[i].name === Cmd_Argv(1)) {
      Info_Print(cl.qw.players[i].userinfo);
      return;
    }
  }
  Con_Printf("User not in server.\n");
}

/*
====================
CL_Users_f

Dump userids for all current players
====================
*/
export function CL_Users_f(): void {
  let c = 0;
  Con_Printf("userid frags name\n");
  Con_Printf("------ ----- ----\n");
  for (let i = 0; i < MAX_CLIENTS; i++) {
    if (cl.qw.players[i].name) {
      Con_Printf("%6i %4i %s\n", cl.qw.players[i].userid, cl.qw.players[i].frags, cl.qw.players[i].name);
      c++;
    }
  }

  Con_Printf("%i total users\n", c);
}

export function CL_Color_f(): void {
  // just for quake compatability...
  let top: number;
  let bottom: number;

  if (Cmd_Argc() === 1) {
    Con_Printf(
      '"color" is "%s %s"\n',
      Info_ValueForKey(cls.qw.userinfo, "topcolor"),
      Info_ValueForKey(cls.qw.userinfo, "bottomcolor"),
    );
    Con_Printf("color <0-13> [0-13]\n");
    return;
  }

  if (Cmd_Argc() === 2) {
    top = bottom = Q_atoi(Cmd_Argv(1));
  } else {
    top = Q_atoi(Cmd_Argv(1));
    bottom = Q_atoi(Cmd_Argv(2));
  }

  top &= 15;
  if (top > 13) top = 13;
  bottom &= 15;
  if (bottom > 13) bottom = 13;

  Cvar_Set("topcolor", Com_sprintf("%i", top));
  Cvar_Set("bottomcolor", Com_sprintf("%i", bottom));
}

/*
==================
CL_FullServerinfo_f

Sent by server when serverinfo changes
==================
*/
export function CL_FullServerinfo_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("usage: fullserverinfo <complete info string>\n");
    return;
  }

  cl.qw.serverinfo = Cmd_Argv(1);

  const p = Info_ValueForKey(cl.qw.serverinfo, "*vesion");
  if (p) {
    const v = Q_atof(p);
    if (v) {
      if (!clMainState.server_version) Con_Printf("Version %1.2f Server\n", v);
      clMainState.server_version = v;
    }
  }
}

/*
==================
CL_FullInfo_f

Allow clients to change userinfo
==================
Casey was here :)
*/
export function CL_FullInfo_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("fullinfo <complete info string>\n");
    return;
  }

  const s = Cmd_Argv(1);
  let i = 0;
  if (s[0] === "\\") i++;
  while (i < s.length) {
    let key = "";
    while (i < s.length && s[i] !== "\\") key += s[i++];

    if (i >= s.length) {
      Con_Printf("MISSING VALUE\n");
      return;
    }

    let value = "";
    i++;
    while (i < s.length && s[i] !== "\\") value += s[i++];

    if (i < s.length) i++;

    if (Q_strcasecmp(key, modelNames.pmodel_name) === 0 || Q_strcasecmp(key, modelNames.emodel_name) === 0) continue;

    cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, key, value, MAX_INFO_STRING);
  }
}

/*
==================
CL_SetInfo_f

Allow clients to change userinfo
==================
*/
export function CL_SetInfo_f(): void {
  if (Cmd_Argc() === 1) {
    Info_Print(cls.qw.userinfo);
    return;
  }
  if (Cmd_Argc() !== 3) {
    Con_Printf("usage: setinfo [ <key> <value> ]\n");
    return;
  }
  if (Q_strcasecmp(Cmd_Argv(1), modelNames.pmodel_name) === 0 || Cmd_Argv(1) === modelNames.emodel_name) return;

  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, Cmd_Argv(1), Cmd_Argv(2), MAX_INFO_STRING);
  if (cls.state >= CactiveT.ca_connected) Cmd_ForwardToServer();
}

/*
====================
CL_Packet_f

packet <destination> <contents>

Contents allows \n escape character
====================
*/
export function CL_Packet_f(): void {
  const adr = new NetadrT();

  if (Cmd_Argc() !== 3) {
    Con_Printf("packet <destination> <contents>\n");
    return;
  }

  if (!NET_StringToAdr(Cmd_Argv(1), adr)) {
    Con_Printf("Bad address\n");
    return;
  }

  const inStr = Cmd_Argv(2);
  let out = "";

  const l = inStr.length;
  for (let i = 0; i < l; i++) {
    if (inStr[i] === "\\" && inStr[i + 1] === "n") {
      out += "\n";
      i++;
    } else {
      out += inStr[i];
    }
  }

  const send = connectlessPacket(out);
  NET_SendPacket(send.length, send, adr);
}

/*
=====================
CL_NextDemo

Called to play the next demo in the demo loop
=====================
*/
export function CL_NextDemo(): void {
  if (cls.demonum === -1) return; // don't play demos

  if (!cls.demos[cls.demonum] || cls.demonum === MAX_DEMOS) {
    cls.demonum = 0;
    if (!cls.demos[cls.demonum]) {
      //			Con_Printf ("No demos listed with startdemos\n");
      cls.demonum = -1;
      return;
    }
  }

  Cbuf_InsertText(`playdemo ${cls.demos[cls.demonum]}\n`);
  cls.demonum++;
}

/*
=================
CL_Changing_f

Just sent as a hint to the client that they should
drop to full console
=================
*/
export function CL_Changing_f(): void {
  if (cls.qw.download) return; // don't change when downloading

  S_StopAllSounds(true);
  cl.intermission = 0;
  cls.state = CactiveT.ca_connected; // not active anymore, but not disconnected
  Con_Printf("\nChanging map...\n");
}

/*
=================
CL_Reconnect_f

The server is changing levels
=================
*/
export function CL_Reconnect_f(): void {
  if (cls.qw.download) return; // don't change when downloading

  S_StopAllSounds(true);

  if (cls.state === CactiveT.ca_connected) {
    Con_Printf("reconnecting...\n");
    MSG_WriteChar(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    MSG_WriteString(cls.qw.netchan.message, "new");
    return;
  }

  if (!cls.qw.servername) {
    Con_Printf("No server to reconnect to...\n");
    return;
  }

  CL_Disconnect();
  CL_BeginServerConnect();
}

/*
=================
CL_ConnectionlessPacket

Responses to broadcasts, etc
=================
*/
export function CL_ConnectionlessPacket(): void {
  MSG_BeginReading();
  MSG_ReadLong(); // skip the -1

  const c = String.fromCharCode(MSG_ReadByte() & 0xff);
  if (!cls.demoplayback) Con_Printf("%s: ", NET_AdrToString(net_from));
  //	Con_DPrintf ("%s", net_message.data + 5);
  if (c === S2C_CONNECTION) {
    Con_Printf("connection\n");
    if (cls.state >= CactiveT.ca_connected) {
      if (!cls.demoplayback) Con_Printf("Dup connect received.  Ignored.\n");
      return;
    }
    Netchan_Setup(cls.qw.netchan, net_from, cls.qw.qport);
    qwCmdHooks.netchanMessage = cls.qw.netchan.message; // see file header
    MSG_WriteChar(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    MSG_WriteString(cls.qw.netchan.message, "new");
    cls.state = CactiveT.ca_connected;
    Con_Printf("Connected.\n");
    allowremotecmd = false; // localid required now for remote cmds
    return;
  }
  // remote command from gui front end
  if (c === A2C_CLIENT_COMMAND) {
    Con_Printf("client command\n");

    const fromLocal =
      net_from.ip[0] === net_local_adr.ip[0] &&
      net_from.ip[1] === net_local_adr.ip[1] &&
      net_from.ip[2] === net_local_adr.ip[2] &&
      net_from.ip[3] === net_local_adr.ip[3];
    const fromLoopback = net_from.ip[0] === 127 && net_from.ip[1] === 0 && net_from.ip[2] === 0 && net_from.ip[3] === 1;
    if (!fromLocal && !fromLoopback) {
      Con_Printf("Command packet from remote host.  Ignored.\n");
      return;
    }
    const cmdtext = MSG_ReadString();

    let s = MSG_ReadString();

    let start = 0;
    while (start < s.length && isspace(s.charCodeAt(start))) start++;
    s = s.slice(start);
    while (s.length && isspace(s.charCodeAt(s.length - 1))) s = s.slice(0, -1);

    if (!allowremotecmd && (!localid.string || localid.string !== s)) {
      if (!localid.string) {
        Con_Printf("===========================\n");
        Con_Printf(
          "Command packet received from local host, but no " +
            "localid has been set.  You may need to upgrade your server " +
            "browser.\n",
        );
        Con_Printf("===========================\n");
        return;
      }
      Con_Printf("===========================\n");
      Con_Printf(
        "Invalid localid on command packet received from local host. " +
          "\n|%s| != |%s|\n" +
          "You may need to reload your server browser and QuakeWorld.\n",
        s,
        localid.string,
      );
      Con_Printf("===========================\n");
      Cvar_Set("localid", "");
      return;
    }

    Cbuf_AddText(cmdtext);
    allowremotecmd = false;
    return;
  }
  // print command from somewhere
  if (c === A2C_PRINT) {
    Con_Printf("print\n");

    Con_Print(MSG_ReadString());
    return;
  }

  // ping from somewhere
  if (c === A2A_PING) {
    Con_Printf("ping\n");

    const data = new Uint8Array(6);
    data[0] = 0xff;
    data[1] = 0xff;
    data[2] = 0xff;
    data[3] = 0xff;
    data[4] = A2A_ACK.charCodeAt(0);
    data[5] = 0;

    NET_SendPacket(6, data, net_from);
    return;
  }

  if (c === S2C_CHALLENGE) {
    Con_Printf("challenge\n");

    cls.qw.challenge = Q_atoi(MSG_ReadString());
    CL_SendConnectPacket();
    return;
  }

  Con_Printf("unknown:  %c\n", c);
}

function isspace(ch: number): boolean {
  return ch === 32 || (ch >= 9 && ch <= 13);
}

/*
=================
CL_ReadPackets
=================
*/
export function CL_ReadPackets(): void {
  //	while (NET_GetPacket ())
  while (CL_GetMessage()) {
    //
    // remote command packet
    //
    if (readInt32(net_message.data) === -1) {
      CL_ConnectionlessPacket();
      continue;
    }

    if (net_message.cursize < 8) {
      Con_Printf("%s: Runt packet\n", NET_AdrToString(net_from));
      continue;
    }

    //
    // packet from server
    //
    if (!cls.demoplayback && !NET_CompareAdr(net_from, cls.qw.netchan.remote_address)) {
      Con_DPrintf("%s:sequenced packet without connection\n", NET_AdrToString(net_from));
      continue;
    }
    if (!Netchan_Process(cls.qw.netchan)) continue; // wasn't accepted for some reason
    CL_ParseServerMessage();

    //		if (cls.demoplayback && cls.state >= ca_active && !CL_DemoBehind())
    //			return;
  }

  //
  // check timeout
  //
  if (cls.state >= CactiveT.ca_connected && clMainState.realtime - cls.qw.netchan.last_received > cl_timeout.value) {
    Con_Printf("\nServer connection timed out.\n");
    CL_Disconnect();
    return;
  }
}

// `*(int *)net_message.data == -1`
function readInt32(data: Uint8Array): number {
  if (data.length < 4) return 0;
  return new DataView(data.buffer, data.byteOffset, 4).getInt32(0, true);
}

//=============================================================================

/*
=====================
CL_Download_f
=====================
*/
export function CL_Download_f(): void {
  if (cls.state === CactiveT.ca_disconnected) {
    Con_Printf("Must be connected.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Con_Printf("Usage: download <datafile>\n");
    return;
  }

  cls.qw.downloadname = `${com_gamedir}/${Cmd_Argv(1)}`;

  let p = 0;
  for (;;) {
    const q = cls.qw.downloadname.indexOf("/", p);
    if (q !== -1) {
      Sys_mkdir(cls.qw.downloadname.slice(0, q));
      p = q + 1;
    } else break;
  }

  cls.qw.downloadtempname = cls.qw.downloadname;
  const handle = Sys_FileOpenWrite(cls.qw.downloadname);
  cls.qw.download = new FileHandle(handle, 0);
  cls.qw.downloadtype = DownloadTypeT.dl_single;

  MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
  SZ_Print(cls.qw.netchan.message, va("download %s\n", Cmd_Argv(1)));
}

/*
=================
CL_Init
=================
*/
export function CL_Init(): void {
  cls.state = CactiveT.ca_disconnected;

  // QW cvar.c's `#ifndef SERVERONLY` info branch -- compiled in
  // unconditionally on qwcl, so it is installed before any cvar registers.
  setCvarInfoHook(CL_CvarInfoChanged);

  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, "name", "unnamed", MAX_INFO_STRING);
  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, "topcolor", "0", MAX_INFO_STRING);
  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, "bottomcolor", "0", MAX_INFO_STRING);
  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, "rate", "2500", MAX_INFO_STRING);
  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, "msg", "1", MAX_INFO_STRING);
  const st = Com_sprintf("%4.2f-%04d", VERSION, build_number());
  cls.qw.userinfo = Info_SetValueForStarKey(cls.qw.userinfo, "*ver", st, MAX_INFO_STRING);

  CL_InitInput();
  CL_InitTEnts();
  CL_InitPrediction();
  CL_InitCam();
  Pmove_Init();

  //
  // register our commands
  //
  Cvar_RegisterVariable(show_fps);
  Cvar_RegisterVariable(host_speeds);
  Cvar_RegisterVariable(developer);

  Cvar_RegisterVariable(cl_warncmd);
  Cvar_RegisterVariable(cl_upspeed);
  Cvar_RegisterVariable(cl_forwardspeed);
  Cvar_RegisterVariable(cl_backspeed);
  Cvar_RegisterVariable(cl_sidespeed);
  Cvar_RegisterVariable(cl_movespeedkey);
  Cvar_RegisterVariable(cl_yawspeed);
  Cvar_RegisterVariable(cl_pitchspeed);
  Cvar_RegisterVariable(cl_anglespeedkey);
  Cvar_RegisterVariable(cl_shownet);
  Cvar_RegisterVariable(cl_sbar);
  Cvar_RegisterVariable(cl_hudswap);
  Cvar_RegisterVariable(cl_maxfps);
  Cvar_RegisterVariable(cl_timeout);
  Cvar_RegisterVariable(lookspring);
  Cvar_RegisterVariable(lookstrafe);
  Cvar_RegisterVariable(sensitivity);

  Cvar_RegisterVariable(m_pitch);
  Cvar_RegisterVariable(m_yaw);
  Cvar_RegisterVariable(m_forward);
  Cvar_RegisterVariable(m_side);

  Cvar_RegisterVariable(rcon_password);
  Cvar_RegisterVariable(rcon_address);

  Cvar_RegisterVariable(entlatency);
  Cvar_RegisterVariable(cl_predict_players2);
  Cvar_RegisterVariable(cl_predict_players);
  Cvar_RegisterVariable(cl_solid_players);

  Cvar_RegisterVariable(localid);

  Cvar_RegisterVariable(baseskin);
  Cvar_RegisterVariable(noskins);

  //
  // info mirrors
  //
  Cvar_RegisterVariable(name);
  Cvar_RegisterVariable(password);
  Cvar_RegisterVariable(spectator);
  Cvar_RegisterVariable(skin);
  Cvar_RegisterVariable(team);
  Cvar_RegisterVariable(topcolor);
  Cvar_RegisterVariable(bottomcolor);
  Cvar_RegisterVariable(rate);
  Cvar_RegisterVariable(msg);
  Cvar_RegisterVariable(noaim);

  Cmd_AddCommand("version", CL_Version_f);

  Cmd_AddCommand("changing", CL_Changing_f);
  Cmd_AddCommand("disconnect", CL_Disconnect_f);
  Cmd_AddCommand("record", CL_Record_f);
  Cmd_AddCommand("rerecord", CL_ReRecord_f);
  Cmd_AddCommand("stop", CL_Stop_f);
  Cmd_AddCommand("playdemo", CL_PlayDemo_f);
  Cmd_AddCommand("timedemo", CL_TimeDemo_f);

  Cmd_AddCommand("skins", Skin_Skins_f);
  Cmd_AddCommand("allskins", Skin_AllSkins_f);

  Cmd_AddCommand("quit", CL_Quit_f);

  Cmd_AddCommand("connect", CL_Connect_f);
  Cmd_AddCommand("reconnect", CL_Reconnect_f);

  Cmd_AddCommand("rcon", CL_Rcon_f);
  Cmd_AddCommand("packet", CL_Packet_f);
  Cmd_AddCommand("user", CL_User_f);
  Cmd_AddCommand("users", CL_Users_f);

  Cmd_AddCommand("setinfo", CL_SetInfo_f);
  Cmd_AddCommand("fullinfo", CL_FullInfo_f);
  Cmd_AddCommand("fullserverinfo", CL_FullServerinfo_f);

  Cmd_AddCommand("color", CL_Color_f);
  Cmd_AddCommand("download", CL_Download_f);

  Cmd_AddCommand("nextul", CL_NextUpload);
  Cmd_AddCommand("stopul", CL_StopUpload);

  //
  // forward to server commands
  //
  Cmd_AddCommand("kill", Cmd_ForwardToServer); // Cmd_AddCommand ("kill", NULL) -- see file header
  Cmd_AddCommand("pause", Cmd_ForwardToServer); // Cmd_AddCommand ("pause", NULL) -- see file header
  Cmd_AddCommand("say", Cmd_ForwardToServer); // Cmd_AddCommand ("say", NULL) -- see file header
  Cmd_AddCommand("say_team", Cmd_ForwardToServer); // Cmd_AddCommand ("say_team", NULL) -- see file header
  Cmd_AddCommand("serverinfo", Cmd_ForwardToServer); // Cmd_AddCommand ("serverinfo", NULL) -- see file header
}

/*
QW/client/cvar.c's Cvar_Set, `#ifndef SERVERONLY` branch -- installed as
src/common/cvar.ts's info hook by CL_Init.
*/
function CL_CvarInfoChanged(var_name: string, value: string): void {
  cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, var_name, value, MAX_INFO_STRING);
  if (cls.state >= CactiveT.ca_connected) {
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    SZ_Print(cls.qw.netchan.message, va('setinfo "%s" "%s"\n', var_name, value));
  }
}

/*
================
Host_EndGame

Call this to drop to a console without exiting the qwcl
================
*/
export function Host_EndGame(message: string, ...args: Array<string | number>): never {
  const string = Com_sprintf(message, ...args);
  Con_Printf("\n===========================\n");
  Con_Printf("Host_EndGame: %s\n", string);
  Con_Printf("===========================\n\n");

  CL_Disconnect();

  throw new HostEndGame(string); // longjmp (host_abort, 1)
}

/*
================
Host_Error

This shuts down the client and exits qwcl
================
*/
let inerror = false;

export function Host_Error(error: string, ...args: Array<string | number>): never {
  if (inerror) Sys_Error("Host_Error: recursively entered");
  inerror = true;

  const string = Com_sprintf(error, ...args);
  Con_Printf("Host_Error: %s\n", string);

  CL_Disconnect();
  cls.demonum = -1;

  inerror = false;

  // FIXME
  return Sys_Error("Host_Error: %s\n", string);
}

/*
===============
Host_WriteConfiguration

Writes key bindings and archived cvars to config.cfg
===============
*/
export function Host_WriteConfiguration(): void {
  if (clMainState.host_initialized) {
    let handle: number;
    try {
      // f = fopen (va("%s/config.cfg",com_gamedir), "w");
      handle = Sys_FileOpenWrite(va("%s/config.cfg", com_gamedir));
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
    Key_WriteBindings(f);
    Cvar_WriteVariables(f);

    Sys_FileClose(handle);
  }
}

//============================================================================

/*
==================
Host_Frame

Runs all active servers
==================
*/
export const nopacketcount = { value: 0 };

let time1 = 0;
let time2 = 0;
let time3 = 0;

export function Host_Frame(time: number): void {
  try {
    let fps: number;

    // decide the simulation time
    clMainState.realtime += time;
    host.realtime = clMainState.realtime; // see below: one C global, two holders
    if (clMainState.oldrealtime > clMainState.realtime) clMainState.oldrealtime = 0;

    if (cl_maxfps.value) fps = Math.max(30.0, Math.min(cl_maxfps.value, 72.0));
    else fps = Math.max(30.0, Math.min(rate.value / 80.0, 72.0));

    if (!cls.timedemo && clMainState.realtime - clMainState.oldrealtime < 1.0 / fps) return; // framerate is too high

    clMainState.host_frametime = clMainState.realtime - clMainState.oldrealtime;
    clMainState.oldrealtime = clMainState.realtime;
    if (clMainState.host_frametime > 0.2) clMainState.host_frametime = 0.2;

    // `realtime` and `host_frametime` are single globals in the C, declared by
    // whichever Host_Frame is linked and read by every client file. This port
    // has two homes for them -- `clMainState` here and `host`
    // (src/common/host.ts), which the shared src/client modules read on both
    // tracks -- so Host_Frame republishes both, the same way it republishes
    // `netchanState.realtime` below.
    host.frametime = clMainState.host_frametime;

    netchanState.realtime = clMainState.realtime; // net_chan.c reads the `realtime` global

    // get new key events
    Sys_SendKeyEvents();

    // allow mice or other external controllers to add commands
    inputBackend.current?.IN_Commands();

    // process console commands
    Cbuf_Execute();

    // fetch results from server
    CL_ReadPackets();

    // send intentions now
    // resend a connection request if necessary
    if (cls.state === CactiveT.ca_disconnected) {
      CL_CheckForResend();
    } else CL_SendCmd();

    // Set up prediction for other players
    CL_SetUpPlayerPrediction(false);

    // do client side motion prediction
    CL_PredictMove();

    // Set up prediction for other players
    CL_SetUpPlayerPrediction(true);

    // build a refresh entity list
    CL_EmitEntities();

    // update video
    if (host_speeds.value) time1 = Sys_FloatTime();

    SCR_UpdateScreen();

    if (host_speeds.value) time2 = Sys_FloatTime();

    // update audio
    if (cls.state === CactiveT.ca_active) {
      S_Update(r_origin, vpn, vright, vup);
      CL_DecayLights();
    } else S_Update(vec3_origin, vec3_origin, vec3_origin, vec3_origin);

    cdAudio.current?.CDAudio_Update();

    if (host_speeds.value) {
      const pass1 = Math.trunc((time1 - time3) * 1000);
      time3 = Sys_FloatTime();
      const pass2 = Math.trunc((time2 - time1) * 1000);
      const pass3 = Math.trunc((time3 - time2) * 1000);
      Con_Printf("%3i tot %3i server %3i gfx %3i snd\n", pass1 + pass2 + pass3, pass1, pass2, pass3);
    }

    clMainState.host_framecount++;
    host.framecount = clMainState.host_framecount; // one C global, two holders (see above)
    clMainState.fps_count++;
  } catch (err) {
    if (err instanceof HostEndGame) return; // something bad happened, or the server disconnected
    throw err;
  }
}

export function Host_FixupModelNames(): void {
  modelNames.emodel_name = xorString(modelNames.emodel_name);
  modelNames.pmodel_name = xorString(modelNames.pmodel_name);
  modelNames.prespawn_name = xorString(modelNames.prespawn_name);
  modelNames.modellist_name = xorString(modelNames.modellist_name);
  modelNames.soundlist_name = xorString(modelNames.soundlist_name);
}

//============================================================================

/*
====================
Host_Init
====================
*/
export function Host_Init(parms: QuakeParmsT): void {
  COM_InitArgv(parms.argv);
  COM_AddParm("-game");
  COM_AddParm("qw");

  Sys_mkdir("qw");

  if (COM_CheckParm("-minmemory")) parms.memsize = MINIMUM_MEMORY;

  host_parms.basedir = parms.basedir;
  host_parms.cachedir = parms.cachedir;
  host_parms.argc = parms.argv.length;
  host_parms.argv = parms.argv;
  host_parms.membase = parms.membase;
  host_parms.memsize = parms.memsize;

  if (parms.memsize < MINIMUM_MEMORY)
    Sys_Error("Only %4.1f megs of memory reported, can't execute game", parms.memsize / 0x100000);

  Memory_Init(parms.memsize);
  Cbuf_Init();
  Cmd_Init();
  V_Init();

  COM_Init();

  Host_FixupModelNames();

  NET_Init(PORT_CLIENT);
  Netchan_Init();

  W_LoadWadFile("gfx.wad");
  Key_Init();
  Con_Init();
  M_Init();
  Mod_Init();

  //	Con_Printf ("Exe: "__TIME__" "__DATE__"\n");
  Con_Printf("%4.1f megs RAM used.\n", parms.memsize / (1024 * 1024.0));

  // R_InitTextures() -- src/ref_soft/model.ts and src/ref_gl/gl_model.ts each
  // run their own R_InitTextures at module load (`export const notexture =
  // R_InitTextures()`), and no renderer object exists yet at this point in
  // Host_Init (VID_Init below is what installs `re.current`), so this goes
  // through `re.current?.` exactly as src/common/host.ts:1112 does for
  // WinQuake's identically-placed call.
  re.current?.R_InitTextures();

  host_basepal.data = COM_LoadHunkFile("gfx/palette.lmp");
  if (!host_basepal.data) Sys_Error("Couldn't load gfx/palette.lmp");
  host_colormap.data = COM_LoadHunkFile("gfx/colormap.lmp");
  if (!host_colormap.data) Sys_Error("Couldn't load gfx/colormap.lmp");

  // #ifdef __linux__ branch -- see file header
  inputBackend.current?.IN_Init();
  cdAudio.current?.CDAudio_Init();
  if (host_basepal.data) vidBackend.current?.VID_Init(host_basepal.data);
  getRenderer().Draw_Init();
  SCR_Init();
  getRenderer().R_Init();

  //	S_Init ();		// S_Init is now done as part of VID. Sigh.

  cls.state = CactiveT.ca_disconnected;
  Sbar_Init();
  CL_Init();

  Cbuf_InsertText("exec quake.rc\n");
  Cbuf_AddText("echo Type connect <internet address> or use GameSpy to connect to a game.\n");
  Cbuf_AddText("cl_warncmd 1\n");

  Hunk_AllocName(0, "-HOST_HUNKLEVEL-");
  clMainState.host_hunklevel = Hunk_LowMark();

  clMainState.host_initialized = true;
  // ...and the same single C global's OTHER reader. QW/client/cmd.c:516's
  // `if (host_initialized) Sys_Error ("Cmd_AddCommand after host_initialized")`
  // reads the very `host_initialized` this line sets; src/common/cmd.ts holds
  // that reader's half of the global as `cmdHost.initialized` (see its own
  // header's ruling), so both have to be set here or qwcl runs with the guard
  // permanently open -- which is also what left Cmd_AddCommand re-pointing a
  // renderer switch's commands disabled (cmd.ts's `cmdHost.rendererSwitch`
  // branch is reached only once `initialized` is true), so after a
  // vid_restart every renderer command (timerefresh, gl_texturemode,
  // screenshot, sizeup/sizedown, +showscores) still pointed at the destroyed
  // renderer's function and every cvar re-registration printed "allready
  // defined". host.c:918 sets the WinQuake binary's copy the same way.
  cmdHost.initialized = true;

  Con_Printf("\nClient Version %4.2f (Build %04d)\n\n", VERSION, build_number());

  Con_Printf("\x1d\x1e\x1e\x1e\x1e\x1e\x1f QuakeWorld Initialized \x1d\x1e\x1e\x1e\x1e\x1e\x1f\n");
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
    Con_Printf("recursive shutdown\n");
    return;
  }
  isdown = true;

  Host_WriteConfiguration();

  cdAudio.current?.CDAudio_Shutdown();
  NET_Shutdown();
  S_Shutdown();
  inputBackend.current?.IN_Shutdown();
  if (host_basepal.data) vidBackend.current?.VID_Shutdown();
}
