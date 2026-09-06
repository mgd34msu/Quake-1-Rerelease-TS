/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_user.c (GNU GPL v2 or later).

sv_user.c -- server code for moving users

QW/server/sv_user.c shares nothing but a filename with WinQuake's: WinQuake's
is the player physics (SV_UserFriction/SV_Accelerate/SV_WaterMove/SV_AirMove/
SV_ClientThink/SV_SetIdealPitch/SV_ReadClientMove), all of which moved into
QW's shared pmove.c. This file is the QW server's user-command layer: the
`ucmds[]` string-command table every client console command dispatches
through, the connect/prespawn/spawn/begin handshake, the file download and
upload channels, chat with flood protection, and SV_RunCmd, which drives
PlayerMove() on the server for each usercmd_t the client sent.

Deviations from PORTING.md / the C source:
- `host_frametime` and `realtime` are QW/server/sv_main.c globals (declared
  `extern` in qwsvdef.h; qwsvdef.ts deliberately does not declare them).
  src/qw/server/sv_main.ts (Q014) is not landed yet, so they are reached
  through the same lazy `require("./sv_main")` adapter src/qw/server/
  sv_send.ts already uses for that module (sv_main.ts requires this module
  back, for SV_ExecuteClientMessage/SV_TogglePause/SV_UserInit, so the cycle
  has to be broken on one side; both sides break it lazily). Every read and
  write of `svMainState.host_frametime`/`.realtime` goes through the single
  `svMain()` accessor below.
- `fp_messages`/`fp_persecond`/`fp_secondsdead`/`fp_msg` are QW/server/
  sv_ccmds.c's own mutable globals (`SV_Floodprot_f`/`SV_Floodprotmsg_f` set
  them). sv_ccmds.ts (Q015) is not landed either; they are read through the
  same adapter shape, expecting `svCcmdsState: { fp_messages: number;
  fp_persecond: number; fp_secondsdead: number; fp_msg: string }`.
- `net_drop` is `src/qw/net_chan.ts`'s exported mutable binding, and the C
  decrements it inside SV_ExecuteClientMessage's replay loop. An imported
  ESM binding cannot be assigned directly, so the replay loop decrements the
  real global through net_chan.ts's exported `setNetDrop` setter, matching
  the C's `net_drop--` exactly as the original (Netchan_Process recomputes it on the
  next packet regardless).
- `Con_Printf`/`Con_DPrintf` are QW/server/sv_send.c's own (redirect-aware)
  versions, in src/qw/server/sv_send.ts -- qwsv has no console.c, so
  src/client/console.ts's is the wrong one for this binary.
- `FILE *download` / `FILE *upload` (client_t) are src/common/common.ts's
  `FileHandle` in this port (server.ts's typing). QW's `COM_FOpenFile`
  returns an integer handle from `Sys_FileOpenRead`, already `Sys_FileSeek`ed
  to the pak offset, and src/platform/sys.ts keeps that handle's read
  position in its own table. So the `FileHandle` stored here carries the
  Sys_* handle in `fd`, its `pos` field is unused, and every read/write/close
  goes through `Sys_FileRead`/`Sys_FileWrite`/`Sys_FileClose` on `fd` rather
  than through `COM_FRead`, which would restart at byte 0 of the containing
  pak. `Sys_FileOpenWrite` `Sys_Error`s where the C's `fopen` returns NULL,
  so SV_NextUpload's "Can't create" arm is unreachable in practice -- the
  same documented gap src/common/host.ts and host_cmd.ts already carry.
- `sv.worldmodel->checksum`/`->checksum2`: `ModelT` (src/common/model.ts) now
  carries these as plain fields, computed unconditionally by the shared
  `Mod_LoadBrushModel` (QW/server/model.c's own addition, folded into the
  loader every engine shares); read directly as `worldmodel.checksum`/
  `.checksum2` below.
- `char text[2048]` (SV_Say), `char st[...]` (SV_Pause_f), `char send[1024]`
  (OutofBandPrintf), `char oldval[MAX_INFO_STRING]` (SV_SetInfo_f) are
  fixed C buffers written with `sprintf`/`strcat` and no bound check. They
  become plain strings, so an over-long chat line grows the string instead
  of smashing the stack. The C's overflow is a crash, not an observable
  behaviour, so nothing is truncated to imitate it.
- `strncmp(name, "maps/", 6)` in SV_BeginDownload_f's `allow_download_maps`
  arm compares six bytes of a five-byte literal, i.e. it also compares the
  terminating NUL: it is true only when `name` is exactly "maps/". Preserved
  kept as the C has it, `name === "maps/"`; the neighbouring `strncmp(name,
  "maps/", 5)` (pak check) really is a prefix test and is ported as one.
- The C lowercases `name` in place, mutating `Cmd_Argv(1)`'s own buffer.
  `Cmd_Argv` returns an immutable string here, so a lowercased copy is used.
  Nothing re-reads `Cmd_Argv(1)` afterwards, so the argument buffer staying
  mixed-case is unobservable. The lowercasing itself is ASCII-only, matching
  C's `tolower` on the byte values that arrive over the wire.
- `sv.lightstyles[i]` is `string` (never a null pointer) in server.ts, so
  SV_Spawn_f's `sv.lightstyles[i] ? strlen(...) : 1` size estimate treats
  `""` as the null case, matching the byte count the C reserves for an
  unset style.
- `sv.sound_precache`/`sv.model_precache` are NUL-terminated `char*` arrays
  in the C, walked with a bare pointer. The TS loops carry an extra
  `index < array.length` bound, which the C lacks; a full precache table
  would run past the end there.
- `cmd` (the file-scope `usercmd_t cmd`), `pmove_mins`/`pmove_maxs` and
  `playertouch` are C file-scope globals and stay module-level singletons
  mutated in place; `cmd = *ucmd` / `pmove.cmd = *ucmd` / `cl->lastcmd =
  newcmd` (C struct assignment) become `copyUsercmd(dst, src)`.
- `EDICT_NUM(host_client - svs.clients + 1)` (pointer arithmetic to recover
  a client's slot number) becomes `svs.clients.indexOf(host_client)`.
- `EDICT_FROM_AREA(l)` (progs.h's STRUCT_FROM_LINK macro) becomes
  `l.owner`, narrowed with `instanceof`, exactly as src/qw/server/world.ts
  does for its own copy of the same macro (world.ts keeps it private).
- `V_CalcRoll` lives in this file in QW's server build (there is no view.c
  in qwsv, and the C's own comment says "Used by view and sv_user"); it is
  exported from here rather than imported from src/client/view.ts.

Dropped conditional blocks (PORTING.md: `#if 0` and `#if 1`/`#else` are
dropped silently; listed here for the record):
- SV_Begin_f's trailing `#if 0` block: the `svc_setangle` fixangle send,
  with id's own comment about savegame head-tilt.
- SV_RunCmd's `#if 1 AddLinksToPmove(sv_areanodes) #else AddAllEntsToPmove()
  #endif`: the AddLinksToPmove arm is the live one. `AddAllEntsToPmove` is
  still ported (the C keeps it compiled, marked "For debugging") and
  exported, but nothing calls it.
- SV_RunCmd's `#if 0` PM_TestPlayerPosition before/after "got stuck in
  playermove" debug wrapper around `PlayerMove()`; the `#else` bare
  `PlayerMove()` is the live arm.
- SV_RunCmd's `#if 0` velocity truncation ("truncate velocity the same way
  the net protocol will"); the `#else` `VectorCopy(pmove.velocity,
  sv_player->v.velocity)` is the live arm.
*/

import { type LinkT, QwEdictT, EDICT_NUM, EDICT_TO_PROG, NUM_FOR_EDICT, PR_GetString, PR_SetStringRef, qwpr } from "./progs";
import { QW_GLOBAL_OFS, type QwGlobalVars } from "./progdefs";
import { GetEdictFieldValue, prSpectator } from "./pr_edict";
import { PR_ExecuteProgram } from "./pr_exec";
import {
  ClientStateT,
  ClientT,
  NUM_SPAWN_PARMS,
  RedirectT,
  SOLID_BBOX,
  SOLID_BSP,
  SOLID_SLIDEBOX,
  FL_ONGROUND,
  sv,
  svs,
  svState,
} from "./server";
import { type AreanodeT, SV_LinkEdict, sv_areanodes } from "./world";
import { Con_DPrintf, Con_Printf, SV_BeginRedirect, SV_BroadcastPrintf, SV_ClientPrintf, SV_EndRedirect } from "./sv_send";
import {
  ClientReliableWrite_Begin,
  ClientReliableWrite_Byte,
  ClientReliableWrite_Long,
  ClientReliableWrite_Short,
  ClientReliableWrite_String,
  ClientReliableWrite_SZ,
} from "./sv_nchan";
import { SV_RunNewmis, SV_RunThink, sv_maxspeed } from "./sv_phys";
import type * as SvMainModule from "./sv_main";
import type * as SvCcmdsModule from "./sv_ccmds";
import { MAX_PHYSENTS, PlayerMove, movevars, player_mins, pmState, pmove } from "../pmove";
import {
  A2C_PRINT,
  ClcOpsT,
  MAX_CLIENTS,
  PRINT_CHAT,
  PRINT_HIGH,
  PROTOCOL_VERSION,
  QwUsercmdT,
  SvcOpsT,
  UPDATE_MASK,
} from "../protocol";
import {
  MAX_EDICTS,
  MAX_INFO_STRING,
  MAX_LIGHTSTYLES,
  MAX_MSGLEN,
  PITCH,
  ROLL,
  STAT_MONSTERS,
  STAT_SECRETS,
  STAT_TOTALMONSTERS,
  STAT_TOTALSECRETS,
  YAW,
} from "../bothdefs";
import {
  COM_BlockSequenceCRCByte,
  COM_FOpenFile,
  Info_Print,
  Info_SetValueForKey,
  Info_ValueForKey,
  MSG_GetReadCount,
  MSG_ReadByte,
  MSG_ReadCoord,
  MSG_ReadDeltaUsercmd,
  MSG_ReadShort,
  MSG_ReadString,
  MSG_WriteByte,
  MSG_WriteFloat,
  MSG_WriteLong,
  MSG_WriteString,
  Q_atoi,
  SZ_Clear,
  SZ_Write,
  file_from_pak,
  msgState,
  net_message,
  nullcmd,
} from "../common";
import { net_drop, setNetDrop } from "../net_chan";
import { NET_SendPacket } from "../net_udp";
import type { NetadrT } from "../net_udp";
import { Cmd_Argc, Cmd_Args, Cmd_Argv, Cmd_TokenizeString } from "../../common/cmd";
import { CvarT, Cvar_RegisterVariable } from "../../common/cvar";
import { FileHandle } from "../../common/common";
import { Com_sprintf } from "../../common/sprintf";
import { type Vec3, AngleVectors, DotProduct, VectorCopy, vec3, vec3_origin } from "../../common/mathlib";
import { Sys_FileClose, Sys_FileOpenWrite, Sys_FileRead, Sys_FileWrite, Sys_Printf, SysError } from "../../platform/sys";

// `usercmd_t cmd;` -- file scope in the C, shared by SV_RunCmd's own
// chop-up recursion.
export const cmd: QwUsercmdT = new QwUsercmdT();

export const cl_rollspeed = new CvarT("cl_rollspeed", "200");
export const cl_rollangle = new CvarT("cl_rollangle", "2.0");
export const sv_spectalk = new CvarT("sv_spectalk", "1");

export const sv_mapcheck = new CvarT("sv_mapcheck", "1");

// see file header: QW/server/sv_main.c- and sv_ccmds.c-owned names
// (Q014/Q015, not yet landed).
function svMain(): typeof SvMainModule {
  return require("./sv_main");
}

function svCcmds(): typeof SvCcmdsModule {
  return require("./sv_ccmds");
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new SysError("sv_user: progs not loaded");
  return qwpr.global_struct;
}

function requireGlobals(): { f: Float32Array; i: Int32Array } {
  if (qwpr.globals === null) throw new SysError("sv_user: progs not loaded");
  return qwpr.globals;
}

function requireHostClient(): ClientT {
  if (svState.host_client === null) throw new SysError("sv_user: svState.host_client not set");
  return svState.host_client;
}

function requireSvPlayer(): QwEdictT {
  if (svState.sv_player === null) throw new SysError("sv_user: svState.sv_player not set");
  return svState.sv_player;
}

function requireClientEdict(cl: ClientT): QwEdictT {
  if (cl.edict === null) throw new SysError("sv_user: client has no edict");
  return cl.edict;
}

// `*dst = *src` on a usercmd_t -- see file header.
function copyUsercmd(dst: QwUsercmdT, src: QwUsercmdT): void {
  if (dst === src) return;
  dst.msec = src.msec;
  VectorCopy(src.angles, dst.angles);
  dst.forwardmove = src.forwardmove;
  dst.sidemove = src.sidemove;
  dst.upmove = src.upmove;
  dst.buttons = src.buttons;
  dst.impulse = src.impulse;
}

// C `tolower` over the ASCII bytes a filename arrives as -- see file header.
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s[i];
  }
  return out;
}

/*
============================================================

USER STRINGCMD EXECUTION

host_client and sv_player will be valid.
============================================================
*/

/*
================
SV_New_f

Sends the first message from the server to a connected client.
This will be sent on the initial connection and upon each server load.
================
*/
export function SV_New_f(): void {
  const host_client = requireHostClient();

  if (host_client.state === ClientStateT.cs_spawned) return;

  host_client.state = ClientStateT.cs_connected;
  host_client.connection_started = svMain().svMainState.realtime;

  // send the info about the new client to all connected clients
  //	SV_FullClientUpdate (host_client, &sv.reliable_datagram);
  //	host_client->sendinfo = true;

  let gamedir = Info_ValueForKey(svs.info, "*gamedir");
  if (gamedir === "") gamedir = "qw";

  //NOTE:  This doesn't go through ClientReliableWrite since it's before the user
  //spawns.  These functions are written to not overflow
  if (host_client.num_backbuf) {
    Con_Printf("WARNING %s: [SV_New] Back buffered (%d0, clearing", host_client.name, host_client.netchan.message.cursize);
    host_client.num_backbuf = 0;
    SZ_Clear(host_client.netchan.message);
  }

  // send the serverdata
  MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_serverdata);
  MSG_WriteLong(host_client.netchan.message, PROTOCOL_VERSION);
  MSG_WriteLong(host_client.netchan.message, svs.spawncount);
  MSG_WriteString(host_client.netchan.message, gamedir);

  let playernum = NUM_FOR_EDICT(requireClientEdict(host_client)) - 1;
  if (host_client.spectator) playernum |= 128;
  MSG_WriteByte(host_client.netchan.message, playernum);

  // send full levelname
  MSG_WriteString(host_client.netchan.message, PR_GetString(sv.edicts[0].v.message));

  // send the movevars
  MSG_WriteFloat(host_client.netchan.message, movevars.gravity);
  MSG_WriteFloat(host_client.netchan.message, movevars.stopspeed);
  MSG_WriteFloat(host_client.netchan.message, movevars.maxspeed);
  MSG_WriteFloat(host_client.netchan.message, movevars.spectatormaxspeed);
  MSG_WriteFloat(host_client.netchan.message, movevars.accelerate);
  MSG_WriteFloat(host_client.netchan.message, movevars.airaccelerate);
  MSG_WriteFloat(host_client.netchan.message, movevars.wateraccelerate);
  MSG_WriteFloat(host_client.netchan.message, movevars.friction);
  MSG_WriteFloat(host_client.netchan.message, movevars.waterfriction);
  MSG_WriteFloat(host_client.netchan.message, movevars.entgravity);

  // send music
  MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_cdtrack);
  MSG_WriteByte(host_client.netchan.message, sv.edicts[0].v.sounds);

  // send server info string
  MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_stufftext);
  MSG_WriteString(host_client.netchan.message, `fullserverinfo "${svs.info}"\n`);
}

/*
==================
SV_Soundlist_f
==================
*/
export function SV_Soundlist_f(): void {
  const host_client = requireHostClient();

  if (host_client.state !== ClientStateT.cs_connected) {
    Con_Printf("soundlist not valid -- allready spawned\n");
    return;
  }

  // handle the case of a level changing while a client was connecting
  if (Q_atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Con_Printf("SV_Soundlist_f from different level\n");
    SV_New_f();
    return;
  }

  let n = Q_atoi(Cmd_Argv(2));

  //NOTE:  This doesn't go through ClientReliableWrite since it's before the user
  //spawns.  These functions are written to not overflow
  if (host_client.num_backbuf) {
    Con_Printf("WARNING %s: [SV_Soundlist] Back buffered (%d0, clearing", host_client.name, host_client.netchan.message.cursize);
    host_client.num_backbuf = 0;
    SZ_Clear(host_client.netchan.message);
  }

  MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_soundlist);
  MSG_WriteByte(host_client.netchan.message, n);
  let index = 1 + n;
  let s = index < sv.sound_precache.length ? sv.sound_precache[index] : null;
  while (s !== null && host_client.netchan.message.cursize < MAX_MSGLEN / 2) {
    MSG_WriteString(host_client.netchan.message, s);
    index++;
    n++;
    s = index < sv.sound_precache.length ? sv.sound_precache[index] : null;
  }

  MSG_WriteByte(host_client.netchan.message, 0);

  // next msg
  if (s !== null) MSG_WriteByte(host_client.netchan.message, n);
  else MSG_WriteByte(host_client.netchan.message, 0);
}

/*
==================
SV_Modellist_f
==================
*/
export function SV_Modellist_f(): void {
  const host_client = requireHostClient();

  if (host_client.state !== ClientStateT.cs_connected) {
    Con_Printf("modellist not valid -- allready spawned\n");
    return;
  }

  // handle the case of a level changing while a client was connecting
  if (Q_atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Con_Printf("SV_Modellist_f from different level\n");
    SV_New_f();
    return;
  }

  let n = Q_atoi(Cmd_Argv(2));

  //NOTE:  This doesn't go through ClientReliableWrite since it's before the user
  //spawns.  These functions are written to not overflow
  if (host_client.num_backbuf) {
    Con_Printf("WARNING %s: [SV_Modellist] Back buffered (%d0, clearing", host_client.name, host_client.netchan.message.cursize);
    host_client.num_backbuf = 0;
    SZ_Clear(host_client.netchan.message);
  }

  MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_modellist);
  MSG_WriteByte(host_client.netchan.message, n);
  let index = 1 + n;
  let s = index < sv.model_precache.length ? sv.model_precache[index] : null;
  while (s !== null && host_client.netchan.message.cursize < MAX_MSGLEN / 2) {
    MSG_WriteString(host_client.netchan.message, s);
    index++;
    n++;
    s = index < sv.model_precache.length ? sv.model_precache[index] : null;
  }
  MSG_WriteByte(host_client.netchan.message, 0);

  // next msg
  if (s !== null) MSG_WriteByte(host_client.netchan.message, n);
  else MSG_WriteByte(host_client.netchan.message, 0);
}

/*
==================
SV_PreSpawn_f
==================
*/
export function SV_PreSpawn_f(): void {
  const host_client = requireHostClient();

  if (host_client.state !== ClientStateT.cs_connected) {
    Con_Printf("prespawn not valid -- allready spawned\n");
    return;
  }

  // handle the case of a level changing while a client was connecting
  if (Q_atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Con_Printf("SV_PreSpawn_f from different level\n");
    SV_New_f();
    return;
  }

  let buf = Q_atoi(Cmd_Argv(2)) >>> 0;
  if (buf >= sv.num_signon_buffers) buf = 0;

  if (!buf) {
    // should be three numbers following containing checksums
    const check = Q_atoi(Cmd_Argv(3)) >>> 0;

    //		Con_DPrintf("Client check = %d\n", check);

    const worldmodel = sv.worldmodel;
    if (worldmodel === null) throw new SysError("SV_PreSpawn_f: sv.worldmodel not loaded");
    if (sv_mapcheck.value && check !== worldmodel.checksum && check !== worldmodel.checksum2) {
      SV_ClientPrintf(
        host_client,
        PRINT_HIGH,
        "Map model file does not match (%s), %i != %i/%i.\nYou may need a new version of the map, or the proper install files.\n",
        sv.modelname,
        check,
        worldmodel.checksum,
        worldmodel.checksum2,
      );
      svMain().SV_DropClient(host_client);
      return;
    }
    host_client.checksum = check;
  }

  //NOTE:  This doesn't go through ClientReliableWrite since it's before the user
  //spawns.  These functions are written to not overflow
  if (host_client.num_backbuf) {
    Con_Printf("WARNING %s: [SV_PreSpawn] Back buffered (%d0, clearing", host_client.name, host_client.netchan.message.cursize);
    host_client.num_backbuf = 0;
    SZ_Clear(host_client.netchan.message);
  }

  SZ_Write(host_client.netchan.message, sv.signon_buffers[buf], sv.signon_buffer_size[buf]);

  buf++;
  if (buf === sv.num_signon_buffers) {
    // all done prespawning
    MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(host_client.netchan.message, Com_sprintf("cmd spawn %i 0\n", svs.spawncount));
  } else {
    // need to prespawn more
    MSG_WriteByte(host_client.netchan.message, SvcOpsT.svc_stufftext);
    MSG_WriteString(host_client.netchan.message, Com_sprintf("cmd prespawn %i %i\n", svs.spawncount, buf));
  }
}

/*
==================
SV_Spawn_f
==================
*/
export function SV_Spawn_f(): void {
  const host_client = requireHostClient();

  if (host_client.state !== ClientStateT.cs_connected) {
    Con_Printf("Spawn not valid -- allready spawned\n");
    return;
  }

  // handle the case of a level changing while a client was connecting
  if (Q_atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Con_Printf("SV_Spawn_f from different level\n");
    SV_New_f();
    return;
  }

  const n = Q_atoi(Cmd_Argv(2));

  // make sure n is valid
  if (n < 0 || n > MAX_CLIENTS) {
    Con_Printf("SV_Spawn_f invalid client start\n");
    SV_New_f();
    return;
  }

  // send all current names, colors, and frag counts
  // FIXME: is this a good thing?
  SZ_Clear(host_client.netchan.message);

  // send current status of all other players

  // normally this could overflow, but no need to check due to backbuf
  for (let i = n; i < MAX_CLIENTS; i++) svMain().SV_FullClientUpdateToClient(svs.clients[i], host_client);

  // send all current light styles
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_lightstyle, 3 + (sv.lightstyles[i] !== "" ? sv.lightstyles[i].length : 1));
    ClientReliableWrite_Byte(host_client, i & 0xff);
    ClientReliableWrite_String(host_client, sv.lightstyles[i]);
  }

  // set up the edict
  const ent = requireClientEdict(host_client);

  ent.fields.f.fill(0);
  ent.v.colormap = NUM_FOR_EDICT(ent);
  ent.v.team = 0; // FIXME
  // `PR_SetString(host_client->name)` stores a pointer into client_t's own
  // name buffer, so SV_ExtractFromUserinfo's later overwrite of it is what a
  // QuakeC read of netname sees -- see src/qw/server/progs.ts's header.
  ent.v.netname = PR_SetStringRef(host_client, () => host_client.name);

  host_client.entgravity = 1.0;
  let val = GetEdictFieldValue(ent, "gravity");
  if (val >= 0) ent.fields.f[val] = 1.0;
  host_client.maxspeed = sv_maxspeed.value;
  val = GetEdictFieldValue(ent, "maxspeed");
  if (val >= 0) ent.fields.f[val] = sv_maxspeed.value;

  //
  // force stats to be updated
  //
  host_client.stats.fill(0);

  const globals = requireGlobalStruct();

  ClientReliableWrite_Begin(host_client, SvcOpsT.svc_updatestatlong, 6);
  ClientReliableWrite_Byte(host_client, STAT_TOTALSECRETS);
  ClientReliableWrite_Long(host_client, globals.total_secrets);

  ClientReliableWrite_Begin(host_client, SvcOpsT.svc_updatestatlong, 6);
  ClientReliableWrite_Byte(host_client, STAT_TOTALMONSTERS);
  ClientReliableWrite_Long(host_client, globals.total_monsters);

  ClientReliableWrite_Begin(host_client, SvcOpsT.svc_updatestatlong, 6);
  ClientReliableWrite_Byte(host_client, STAT_SECRETS);
  ClientReliableWrite_Long(host_client, globals.found_secrets);

  ClientReliableWrite_Begin(host_client, SvcOpsT.svc_updatestatlong, 6);
  ClientReliableWrite_Byte(host_client, STAT_MONSTERS);
  ClientReliableWrite_Long(host_client, globals.killed_monsters);

  // get the client to check and download skins
  // when that is completed, a begin command will be issued
  ClientReliableWrite_Begin(host_client, SvcOpsT.svc_stufftext, 8);
  ClientReliableWrite_String(host_client, "skins\n");
}

/*
==================
SV_SpawnSpectator
==================
*/
export function SV_SpawnSpectator(): void {
  const sv_player = requireSvPlayer();

  VectorCopy(vec3_origin, sv_player.v.origin);
  VectorCopy(vec3_origin, sv_player.v.view_ofs);
  sv_player.v.view_ofs[2] = 22;

  // search for an info_playerstart to spawn the spectator at
  for (let i = MAX_CLIENTS - 1; i < sv.num_edicts; i++) {
    const e = EDICT_NUM(i);
    if (PR_GetString(e.v.classname) === "info_player_start") {
      VectorCopy(e.v.origin, sv_player.v.origin);
      return;
    }
  }
}

/*
==================
SV_Begin_f
==================
*/
export function SV_Begin_f(): void {
  const host_client = requireHostClient();

  if (host_client.state === ClientStateT.cs_spawned) return; // don't begin again

  host_client.state = ClientStateT.cs_spawned;

  // handle the case of a level changing while a client was connecting
  if (Q_atoi(Cmd_Argv(1)) !== svs.spawncount) {
    Con_Printf("SV_Begin_f from different level\n");
    SV_New_f();
    return;
  }

  const globals = requireGlobalStruct();
  const globalWords = requireGlobals();

  if (host_client.spectator) {
    SV_SpawnSpectator();

    if (prSpectator.connect) {
      // copy spawn parms out of the client_t
      for (let i = 0; i < NUM_SPAWN_PARMS; i++) globalWords.f[QW_GLOBAL_OFS.parm1 + i] = host_client.spawn_parms[i];

      // call the spawn function
      globals.time = sv.time;
      globals.self = EDICT_TO_PROG(requireSvPlayer());
      PR_ExecuteProgram(prSpectator.connect);
    }
  } else {
    // copy spawn parms out of the client_t
    for (let i = 0; i < NUM_SPAWN_PARMS; i++) globalWords.f[QW_GLOBAL_OFS.parm1 + i] = host_client.spawn_parms[i];

    // call the spawn function
    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(requireSvPlayer());
    PR_ExecuteProgram(globals.ClientConnect);

    // actually spawn the player
    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(requireSvPlayer());
    PR_ExecuteProgram(globals.PutClientInServer);
  }

  // clear the net statistics, because connecting gives a bogus picture
  host_client.netchan.frame_latency = 0;
  host_client.netchan.frame_rate = 0;
  host_client.netchan.drop_count = 0;
  host_client.netchan.good_count = 0;

  //check he's not cheating

  const pmodel = Q_atoi(Info_ValueForKey(host_client.userinfo, "pmodel")) >>> 0;
  const emodel = Q_atoi(Info_ValueForKey(host_client.userinfo, "emodel")) >>> 0;

  if (pmodel !== sv.model_player_checksum || emodel !== sv.eyes_player_checksum)
    SV_BroadcastPrintf(PRINT_HIGH, "%s WARNING: non standard player/eyes model detected\n", host_client.name);

  // if we are paused, tell the client
  if (sv.paused) {
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_setpause, 2);
    ClientReliableWrite_Byte(host_client, sv.paused ? 1 : 0);
    SV_ClientPrintf(host_client, PRINT_HIGH, "Server is paused.\n");
  }
}

//=============================================================================

/*
==================
SV_NextDownload_f
==================
*/
export function SV_NextDownload_f(): void {
  const host_client = requireHostClient();

  if (host_client.download === null) return;

  const buffer = new Uint8Array(1024);
  let r = host_client.downloadsize - host_client.downloadcount;
  if (r > 768) r = 768;
  r = Sys_FileRead(host_client.download.fd, buffer, r);
  ClientReliableWrite_Begin(host_client, SvcOpsT.svc_download, 6 + r);
  ClientReliableWrite_Short(host_client, r);

  host_client.downloadcount += r;
  let size = host_client.downloadsize;
  if (!size) size = 1;
  const percent = Math.trunc((host_client.downloadcount * 100) / size);
  ClientReliableWrite_Byte(host_client, percent);
  ClientReliableWrite_SZ(host_client, buffer, r);

  if (host_client.downloadcount !== host_client.downloadsize) return;

  Sys_FileClose(host_client.download.fd);
  host_client.download = null;
}

export function OutofBandPrintf(where: NetadrT, fmt: string, ...args: Array<string | number>): void {
  const text = Com_sprintf(fmt, ...args);
  const send = new Uint8Array(1024);
  send[0] = 0xff;
  send[1] = 0xff;
  send[2] = 0xff;
  send[3] = 0xff;
  send[4] = A2C_PRINT.charCodeAt(0);
  for (let i = 0; i < text.length && 5 + i < send.length; i++) send[5 + i] = text.charCodeAt(i) & 0xff;

  NET_SendPacket(5 + text.length + 1, send, where);
}

/*
==================
SV_NextUpload
==================
*/
export function SV_NextUpload(): void {
  const host_client = requireHostClient();

  if (host_client.uploadfn === "") {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Upload denied\n");
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_stufftext, 8);
    ClientReliableWrite_String(host_client, "stopul");

    // suck out rest of packet
    const skip = MSG_ReadShort();
    MSG_ReadByte();
    msgState.readcount += skip;
    return;
  }

  const size = MSG_ReadShort();
  const percent = MSG_ReadByte();

  if (host_client.upload === null) {
    const handle = Sys_FileOpenWrite(host_client.uploadfn);
    if (handle === -1) {
      Sys_Printf("Can't create %s\n", host_client.uploadfn);
      ClientReliableWrite_Begin(host_client, SvcOpsT.svc_stufftext, 8);
      ClientReliableWrite_String(host_client, "stopul");
      host_client.uploadfn = "";
      return;
    }
    host_client.upload = new FileHandle(handle, 0);
    Sys_Printf("Receiving %s from %d...\n", host_client.uploadfn, host_client.userid);
    if (host_client.remote_snap)
      OutofBandPrintf(host_client.snap_from, "Server receiving %s from %d...\n", host_client.uploadfn, host_client.userid);
  }

  Sys_FileWrite(host_client.upload.fd, net_message.data.subarray(msgState.readcount, msgState.readcount + size), size);
  msgState.readcount += size;

  Con_DPrintf("UPLOAD: %d received\n", size);

  if (percent !== 100) {
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_stufftext, 8);
    ClientReliableWrite_String(host_client, "nextul\n");
  } else {
    Sys_FileClose(host_client.upload.fd);
    host_client.upload = null;

    Sys_Printf("%s upload completed.\n", host_client.uploadfn);

    if (host_client.remote_snap) {
      const slash = host_client.uploadfn.indexOf("/");
      const p = slash !== -1 ? host_client.uploadfn.slice(slash + 1) : host_client.uploadfn;
      OutofBandPrintf(host_client.snap_from, "%s upload completed.\nTo download, enter:\ndownload %s\n", host_client.uploadfn, p);
    }
  }
}

/*
==================
SV_BeginDownload_f
==================
*/
export function SV_BeginDownload_f(): void {
  const host_client = requireHostClient();
  const svMainMod = svMain();

  let name = Cmd_Argv(1);
  // hacked by zoid to allow more conrol over download
  // first off, no .. or global allow check
  if (
    name.includes("..") ||
    !svMainMod.allow_download.value ||
    // leading dot is no good
    name.startsWith(".") ||
    // leading slash bad as well, must be in subdir
    name.startsWith("/") ||
    // next up, skin check
    (name.startsWith("skins/") && !svMainMod.allow_download_skins.value) ||
    // now models
    (name.startsWith("progs/") && !svMainMod.allow_download_models.value) ||
    // now sounds
    (name.startsWith("sound/") && !svMainMod.allow_download_sounds.value) ||
    // now maps (note special case for maps, must not be in pak)
    (name === "maps/" && !svMainMod.allow_download_maps.value) ||
    // MUST be in a subdirectory
    !name.includes("/")
  ) {
    // don't allow anything with .. path
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_download, 4);
    ClientReliableWrite_Short(host_client, -1);
    ClientReliableWrite_Byte(host_client, 0);
    return;
  }

  if (host_client.download !== null) {
    Sys_FileClose(host_client.download.fd);
    host_client.download = null;
  }

  // lowercase name (needed for casesen file systems)
  name = asciiLower(name);

  const opened = COM_FOpenFile(name);
  host_client.downloadsize = opened.length;
  host_client.download = opened.handle === -1 ? null : new FileHandle(opened.handle, 0);
  host_client.downloadcount = 0;

  if (
    host_client.download === null ||
    // special check for maps, if it came from a pak file, don't allow
    // download  ZOID
    (name.startsWith("maps/") && file_from_pak)
  ) {
    if (host_client.download !== null) {
      Sys_FileClose(host_client.download.fd);
      host_client.download = null;
    }

    Sys_Printf("Couldn't download %s to %s\n", name, host_client.name);
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_download, 4);
    ClientReliableWrite_Short(host_client, -1);
    ClientReliableWrite_Byte(host_client, 0);
    return;
  }

  SV_NextDownload_f();
  Sys_Printf("Downloading %s to %s\n", name, host_client.name);
}

//=============================================================================

/*
==================
SV_Say
==================
*/
export function SV_Say(team: boolean): void {
  const host_client = requireHostClient();
  const svMainMod = svMain();
  const fp = svCcmds();

  if (Cmd_Argc() < 2) return;

  let t1 = "";
  if (team) {
    t1 = Info_ValueForKey(host_client.userinfo, "team").slice(0, 31);
  }

  let text: string;
  if (host_client.spectator && (!sv_spectalk.value || team)) text = `[SPEC] ${host_client.name}: `;
  else if (team) text = `(${host_client.name}): `;
  else {
    text = `${host_client.name}: `;
  }

  if (fp.fp_messages) {
    if (!sv.paused && svMainMod.svMainState.realtime < host_client.lockedtill) {
      SV_ClientPrintf(
        host_client,
        PRINT_CHAT,
        "You can't talk for %d more seconds\n",
        Math.trunc(host_client.lockedtill - svMainMod.svMainState.realtime),
      );
      return;
    }
    let tmp = host_client.whensaidhead - fp.fp_messages + 1;
    if (tmp < 0) tmp = 10 + tmp;
    if (
      !sv.paused &&
      host_client.whensaid[tmp] &&
      svMainMod.svMainState.realtime - host_client.whensaid[tmp] < fp.fp_persecond
    ) {
      host_client.lockedtill = svMainMod.svMainState.realtime + fp.fp_secondsdead;
      if (fp.fp_msg !== "") SV_ClientPrintf(host_client, PRINT_CHAT, "FloodProt: %s\n", fp.fp_msg);
      else SV_ClientPrintf(host_client, PRINT_CHAT, "FloodProt: You can't talk for %d seconds.\n", fp.fp_secondsdead);
      return;
    }
    host_client.whensaidhead++;
    if (host_client.whensaidhead > 9) host_client.whensaidhead = 0;
    host_client.whensaid[host_client.whensaidhead] = svMainMod.svMainState.realtime;
  }

  let p = Cmd_Args() ?? "";

  if (p.startsWith('"')) {
    p = p.slice(1, p.length - 1);
  }

  text += p;
  text += "\n";

  Sys_Printf("%s", text);

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const client = svs.clients[j];
    if (client.state !== ClientStateT.cs_spawned) continue;
    if (host_client.spectator && !sv_spectalk.value) if (!client.spectator) continue;

    if (team) {
      // the spectator team
      if (host_client.spectator) {
        if (!client.spectator) continue;
      } else {
        const t2 = Info_ValueForKey(client.userinfo, "team");
        if (t1 !== t2 || client.spectator) continue; // on different teams
      }
    }
    SV_ClientPrintf(client, PRINT_CHAT, "%s", text);
  }
}

/*
==================
SV_Say_f
==================
*/
export function SV_Say_f(): void {
  SV_Say(false);
}
/*
==================
SV_Say_Team_f
==================
*/
export function SV_Say_Team_f(): void {
  SV_Say(true);
}

//============================================================================

/*
=================
SV_Pings_f

The client is showing the scoreboard, so send new ping times for all
clients
=================
*/
export function SV_Pings_f(): void {
  const host_client = requireHostClient();

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const client = svs.clients[j];
    if (client.state !== ClientStateT.cs_spawned) continue;

    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_updateping, 4);
    ClientReliableWrite_Byte(host_client, j);
    ClientReliableWrite_Short(host_client, svMain().SV_CalcPing(client));
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_updatepl, 4);
    ClientReliableWrite_Byte(host_client, j);
    ClientReliableWrite_Byte(host_client, client.lossage);
  }
}

/*
==================
SV_Kill_f
==================
*/
export function SV_Kill_f(): void {
  const host_client = requireHostClient();
  const sv_player = requireSvPlayer();

  if (sv_player.v.health <= 0) {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Can't suicide -- allready dead!\n");
    return;
  }

  const globals = requireGlobalStruct();
  globals.time = sv.time;
  globals.self = EDICT_TO_PROG(sv_player);
  PR_ExecuteProgram(globals.ClientKill);
}

/*
==================
SV_TogglePause
==================
*/
export function SV_TogglePause(msg: string | null): void {
  sv.paused = !sv.paused;

  if (msg !== null) SV_BroadcastPrintf(PRINT_HIGH, "%s", msg);

  // send notification to all clients
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (!cl.state) continue;
    ClientReliableWrite_Begin(cl, SvcOpsT.svc_setpause, 2);
    ClientReliableWrite_Byte(cl, sv.paused ? 1 : 0);
  }
}

/*
==================
SV_Pause_f
==================
*/
export function SV_Pause_f(): void {
  const host_client = requireHostClient();

  if (!svMain().pausable.value) {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Pause not allowed.\n");
    return;
  }

  if (host_client.spectator) {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Spectators can not pause.\n");
    return;
  }

  let st: string;
  if (sv.paused) st = `${host_client.name} paused the game\n`;
  else st = `${host_client.name} unpaused the game\n`;

  SV_TogglePause(st);
}

/*
=================
SV_Drop_f

The client is going to disconnect, so remove the connection immediately
=================
*/
export function SV_Drop_f(): void {
  const host_client = requireHostClient();

  SV_EndRedirect();
  if (!host_client.spectator) SV_BroadcastPrintf(PRINT_HIGH, "%s dropped\n", host_client.name);
  svMain().SV_DropClient(host_client);
}

/*
=================
SV_PTrack_f

Change the bandwidth estimate for a client
=================
*/
export function SV_PTrack_f(): void {
  const host_client = requireHostClient();

  if (!host_client.spectator) return;

  const slot = svs.clients.indexOf(host_client);

  if (Cmd_Argc() !== 2) {
    // turn off tracking
    host_client.spec_track = 0;
    const ent = EDICT_NUM(slot + 1);
    const tent = EDICT_NUM(0);
    ent.v.goalentity = EDICT_TO_PROG(tent);
    return;
  }

  const i = Q_atoi(Cmd_Argv(1));
  if (i < 0 || i >= MAX_CLIENTS || svs.clients[i].state !== ClientStateT.cs_spawned || svs.clients[i].spectator) {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Invalid client to track\n");
    host_client.spec_track = 0;
    const ent = EDICT_NUM(slot + 1);
    const tent = EDICT_NUM(0);
    ent.v.goalentity = EDICT_TO_PROG(tent);
    return;
  }
  host_client.spec_track = i + 1; // now tracking

  const ent = EDICT_NUM(slot + 1);
  const tent = EDICT_NUM(i + 1);
  ent.v.goalentity = EDICT_TO_PROG(tent);
}

/*
=================
SV_Rate_f

Change the bandwidth estimate for a client
=================
*/
export function SV_Rate_f(): void {
  const host_client = requireHostClient();

  if (Cmd_Argc() !== 2) {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Current rate is %i\n", Math.trunc(1.0 / host_client.netchan.rate + 0.5));
    return;
  }

  let rate = Q_atoi(Cmd_Argv(1));
  if (rate < 500) rate = 500;
  if (rate > 10000) rate = 10000;

  SV_ClientPrintf(host_client, PRINT_HIGH, "Net rate set to %i\n", rate);
  host_client.netchan.rate = 1.0 / rate;
}

/*
=================
SV_Msg_f

Change the message level for a client
=================
*/
export function SV_Msg_f(): void {
  const host_client = requireHostClient();

  if (Cmd_Argc() !== 2) {
    SV_ClientPrintf(host_client, PRINT_HIGH, "Current msg level is %i\n", host_client.messagelevel);
    return;
  }

  host_client.messagelevel = Q_atoi(Cmd_Argv(1));

  SV_ClientPrintf(host_client, PRINT_HIGH, "Msg level set to %i\n", host_client.messagelevel);
}

/*
==================
SV_SetInfo_f

Allow clients to change userinfo
==================
*/
export function SV_SetInfo_f(): void {
  const host_client = requireHostClient();

  if (Cmd_Argc() === 1) {
    Con_Printf("User info settings:\n");
    Info_Print(host_client.userinfo);
    return;
  }

  if (Cmd_Argc() !== 3) {
    Con_Printf("usage: setinfo [ <key> <value> ]\n");
    return;
  }

  if (Cmd_Argv(1)[0] === "*") return; // don't set priveledged values

  const oldval = Info_ValueForKey(host_client.userinfo, Cmd_Argv(1));

  host_client.userinfo = Info_SetValueForKey(host_client.userinfo, Cmd_Argv(1), Cmd_Argv(2), MAX_INFO_STRING);
  // name is extracted below in ExtractFromUserInfo
  //	strncpy (host_client->name, Info_ValueForKey (host_client->userinfo, "name")
  //		, sizeof(host_client->name)-1);
  //	SV_FullClientUpdate (host_client, &sv.reliable_datagram);
  //	host_client->sendinfo = true;

  if (Info_ValueForKey(host_client.userinfo, Cmd_Argv(1)) === oldval) return; // key hasn't changed

  // process any changed values
  svMain().SV_ExtractFromUserinfo(host_client);

  const i = svs.clients.indexOf(host_client);
  MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_setinfo);
  MSG_WriteByte(sv.reliable_datagram, i);
  MSG_WriteString(sv.reliable_datagram, Cmd_Argv(1));
  MSG_WriteString(sv.reliable_datagram, Info_ValueForKey(host_client.userinfo, Cmd_Argv(1)));
}

/*
==================
SV_ShowServerinfo_f

Dumps the serverinfo info string
==================
*/
export function SV_ShowServerinfo_f(): void {
  Info_Print(svs.info);
}

export function SV_NoSnap_f(): void {
  const host_client = requireHostClient();

  if (host_client.uploadfn !== "") {
    host_client.uploadfn = "";
    SV_BroadcastPrintf(PRINT_HIGH, "%s refused remote screenshot\n", host_client.name);
  }
}

interface UcmdT {
  name: string;
  func: () => void;
}

export const ucmds: readonly UcmdT[] = [
  { name: "new", func: SV_New_f },
  { name: "modellist", func: SV_Modellist_f },
  { name: "soundlist", func: SV_Soundlist_f },
  { name: "prespawn", func: SV_PreSpawn_f },
  { name: "spawn", func: SV_Spawn_f },
  { name: "begin", func: SV_Begin_f },

  { name: "drop", func: SV_Drop_f },
  { name: "pings", func: SV_Pings_f },

  // issued by hand at client consoles
  { name: "rate", func: SV_Rate_f },
  { name: "kill", func: SV_Kill_f },
  { name: "pause", func: SV_Pause_f },
  { name: "msg", func: SV_Msg_f },

  { name: "say", func: SV_Say_f },
  { name: "say_team", func: SV_Say_Team_f },

  { name: "setinfo", func: SV_SetInfo_f },

  { name: "serverinfo", func: SV_ShowServerinfo_f },

  { name: "download", func: SV_BeginDownload_f },
  { name: "nextdl", func: SV_NextDownload_f },

  { name: "ptrack", func: SV_PTrack_f }, //ZOID - used with autocam

  { name: "snap", func: SV_NoSnap_f },
];

/*
==================
SV_ExecuteUserCommand
==================
*/
export function SV_ExecuteUserCommand(s: string): void {
  Cmd_TokenizeString(s);
  svState.sv_player = requireHostClient().edict;

  SV_BeginRedirect(RedirectT.RD_CLIENT);

  let found = false;
  for (const u of ucmds) {
    if (Cmd_Argv(0) === u.name) {
      u.func();
      found = true;
      break;
    }
  }

  if (!found) Con_Printf("Bad user command: %s\n", Cmd_Argv(0));

  SV_EndRedirect();
}

/*
===========================================================================

USER CMD EXECUTION

===========================================================================
*/

/*
===============
V_CalcRoll

Used by view and sv_user
===============
*/
export function V_CalcRoll(angles: Vec3, velocity: Vec3): number {
  const forward = vec3();
  const right = vec3();
  const up = vec3();

  AngleVectors(angles, forward, right, up);
  let side = DotProduct(velocity, right);
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  const value = cl_rollangle.value;

  if (side < cl_rollspeed.value) side = (side * value) / cl_rollspeed.value;
  else side = value;

  return side * sign;
}

//============================================================================

export const pmove_mins: Vec3 = vec3();
export const pmove_maxs: Vec3 = vec3();

// progs.h's STRUCT_FROM_LINK/EDICT_FROM_AREA -- see file header.
function EDICT_FROM_AREA(l: LinkT): QwEdictT {
  const owner = l.owner;
  if (owner === null) throw new SysError("EDICT_FROM_AREA: link has no owner");
  if (!(owner instanceof QwEdictT)) throw new SysError("EDICT_FROM_AREA: link owner is not a QwEdictT");
  return owner;
}

/*
====================
AddLinksToPmove

====================
*/
export function AddLinksToPmove(node: AreanodeT): void {
  const sv_player = requireSvPlayer();
  const pl = EDICT_TO_PROG(sv_player);

  // touch linked edicts
  let l = node.solid_edicts.next;
  while (l !== null && l !== node.solid_edicts) {
    const next = l.next;
    const check = EDICT_FROM_AREA(l);
    l = next;

    if (check.v.owner === pl) continue; // player's own missile
    if (check.v.solid === SOLID_BSP || check.v.solid === SOLID_BBOX || check.v.solid === SOLID_SLIDEBOX) {
      if (check === sv_player) continue;

      let i = 0;
      for (i = 0; i < 3; i++) if (check.v.absmin[i] > pmove_maxs[i] || check.v.absmax[i] < pmove_mins[i]) break;
      if (i !== 3) continue;
      if (pmove.numphysent === MAX_PHYSENTS) return;
      const pe = pmove.physents[pmove.numphysent];
      pmove.numphysent++;

      VectorCopy(check.v.origin, pe.origin);
      pe.info = NUM_FOR_EDICT(check);
      if (check.v.solid === SOLID_BSP) pe.model = sv.models[check.v.modelindex | 0] ?? null;
      else {
        pe.model = null;
        VectorCopy(check.v.mins, pe.mins);
        VectorCopy(check.v.maxs, pe.maxs);
      }
    }
  }

  // recurse down both sides
  if (node.axis === -1) return;

  const child0 = node.children[0];
  const child1 = node.children[1];
  if (pmove_maxs[node.axis] > node.dist && child0 !== null) AddLinksToPmove(child0);
  if (pmove_mins[node.axis] < node.dist && child1 !== null) AddLinksToPmove(child1);
}

/*
================
AddAllEntsToPmove

For debugging
================
*/
export function AddAllEntsToPmove(): void {
  const sv_player = requireSvPlayer();
  const pl = EDICT_TO_PROG(sv_player);

  for (let e = 1; e < sv.num_edicts; e++) {
    const check = sv.edicts[e];
    if (check.free) continue;
    if (check.v.owner === pl) continue;
    if (check.v.solid === SOLID_BSP || check.v.solid === SOLID_BBOX || check.v.solid === SOLID_SLIDEBOX) {
      if (check === sv_player) continue;

      let i = 0;
      for (i = 0; i < 3; i++) if (check.v.absmin[i] > pmove_maxs[i] || check.v.absmax[i] < pmove_mins[i]) break;
      if (i !== 3) continue;
      const pe = pmove.physents[pmove.numphysent];

      VectorCopy(check.v.origin, pe.origin);
      pmove.physents[pmove.numphysent].info = e;
      if (check.v.solid === SOLID_BSP) pe.model = sv.models[check.v.modelindex | 0] ?? null;
      else {
        pe.model = null;
        VectorCopy(check.v.mins, pe.mins);
        VectorCopy(check.v.maxs, pe.maxs);
      }

      if (++pmove.numphysent === MAX_PHYSENTS) break;
    }
  }
}

/*
===========
SV_PreRunCmd
===========
Done before running a player command.  Clears the touch array
*/
export const playertouch = new Uint8Array((MAX_EDICTS + 7) >> 3);

export function SV_PreRunCmd(): void {
  playertouch.fill(0);
}

/*
===========
SV_RunCmd
===========
*/
export function SV_RunCmd(ucmd: QwUsercmdT): void {
  const host_client = requireHostClient();
  const sv_player = requireSvPlayer();
  const svMainMod = svMain();

  copyUsercmd(cmd, ucmd);

  // chop up very long commands
  if (cmd.msec > 50) {
    const oldmsec = ucmd.msec;
    cmd.msec = Math.floor(oldmsec / 2);
    SV_RunCmd(cmd);
    cmd.msec = Math.floor(oldmsec / 2);
    cmd.impulse = 0;
    SV_RunCmd(cmd);
    return;
  }

  if (!sv_player.v.fixangle) VectorCopy(ucmd.angles, sv_player.v.v_angle);

  sv_player.v.button0 = ucmd.buttons & 1;
  sv_player.v.button2 = (ucmd.buttons & 2) >> 1;
  if (ucmd.impulse) sv_player.v.impulse = ucmd.impulse;

  //
  // angles
  // show 1/3 the pitch angle and all the roll angle
  if (sv_player.v.health > 0) {
    if (!sv_player.v.fixangle) {
      sv_player.v.angles[PITCH] = -sv_player.v.v_angle[PITCH] / 3;
      sv_player.v.angles[YAW] = sv_player.v.v_angle[YAW];
    }
    sv_player.v.angles[ROLL] = V_CalcRoll(sv_player.v.angles, sv_player.v.velocity) * 4;
  }

  svMainMod.svMainState.host_frametime = ucmd.msec * 0.001;
  if (svMainMod.svMainState.host_frametime > 0.1) svMainMod.svMainState.host_frametime = 0.1;

  const globals = requireGlobalStruct();

  if (!host_client.spectator) {
    globals.frametime = svMainMod.svMainState.host_frametime;

    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(sv_player);
    PR_ExecuteProgram(globals.PlayerPreThink);

    SV_RunThink(sv_player);
  }

  for (let i = 0; i < 3; i++) pmove.origin[i] = sv_player.v.origin[i] + (sv_player.v.mins[i] - player_mins[i]);
  VectorCopy(sv_player.v.velocity, pmove.velocity);
  VectorCopy(sv_player.v.v_angle, pmove.angles);

  pmove.spectator = host_client.spectator;
  pmove.waterjumptime = sv_player.v.teleport_time;
  pmove.numphysent = 1;
  pmove.physents[0].model = sv.worldmodel;
  copyUsercmd(pmove.cmd, ucmd);
  pmove.dead = sv_player.v.health <= 0;
  pmove.oldbuttons = host_client.oldbuttons;

  movevars.entgravity = host_client.entgravity;
  movevars.maxspeed = host_client.maxspeed;

  for (let i = 0; i < 3; i++) {
    pmove_mins[i] = pmove.origin[i] - 256;
    pmove_maxs[i] = pmove.origin[i] + 256;
  }
  AddLinksToPmove(sv_areanodes[0]);

  PlayerMove();

  host_client.oldbuttons = pmove.oldbuttons;
  sv_player.v.teleport_time = pmove.waterjumptime;
  sv_player.v.waterlevel = pmState.waterlevel;
  sv_player.v.watertype = pmState.watertype;
  if (pmState.onground !== -1) {
    sv_player.v.flags = (sv_player.v.flags | 0) | FL_ONGROUND;
    sv_player.v.groundentity = EDICT_TO_PROG(EDICT_NUM(pmove.physents[pmState.onground].info));
  } else sv_player.v.flags = (sv_player.v.flags | 0) & ~FL_ONGROUND;
  for (let i = 0; i < 3; i++) sv_player.v.origin[i] = pmove.origin[i] - (sv_player.v.mins[i] - player_mins[i]);

  VectorCopy(pmove.velocity, sv_player.v.velocity);

  VectorCopy(pmove.angles, sv_player.v.v_angle);

  if (!host_client.spectator) {
    // link into place and touch triggers
    SV_LinkEdict(sv_player, true);

    // touch other objects
    for (let i = 0; i < pmove.numtouch; i++) {
      const n = pmove.physents[pmove.touchindex[i]].info;
      const ent = EDICT_NUM(n);
      if (!ent.v.touch || playertouch[Math.trunc(n / 8)] & (1 << n % 8)) continue;
      globals.self = EDICT_TO_PROG(ent);
      globals.other = EDICT_TO_PROG(sv_player);
      PR_ExecuteProgram(ent.v.touch);
      playertouch[Math.trunc(n / 8)] |= 1 << n % 8;
    }
  }
}

/*
===========
SV_PostRunCmd
===========
Done after running a player command.
*/
export function SV_PostRunCmd(): void {
  const host_client = requireHostClient();
  const globals = requireGlobalStruct();

  // run post-think

  if (!host_client.spectator) {
    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(requireSvPlayer());
    PR_ExecuteProgram(globals.PlayerPostThink);
    SV_RunNewmis();
  } else if (prSpectator.think) {
    globals.time = sv.time;
    globals.self = EDICT_TO_PROG(requireSvPlayer());
    PR_ExecuteProgram(prSpectator.think);
  }
}

/*
===================
SV_ExecuteClientMessage

The current net_message is parsed for the given client
===================
*/
export function SV_ExecuteClientMessage(cl: ClientT): void {
  const svMainMod = svMain();
  const oldest = new QwUsercmdT();
  const oldcmd = new QwUsercmdT();
  const newcmd = new QwUsercmdT();
  const o = vec3();
  let move_issued = false; //only allow one move command

  // calc ping time
  const frame = cl.frames[cl.netchan.incoming_acknowledged & UPDATE_MASK];
  frame.ping_time = svMainMod.svMainState.realtime - frame.senttime;

  // make sure the reply sequence number matches the incoming
  // sequence number
  if (cl.netchan.incoming_sequence >= cl.netchan.outgoing_sequence) cl.netchan.outgoing_sequence = cl.netchan.incoming_sequence;
  else cl.send_message = false; // don't reply, sequences have slipped

  // save time for ping calculations
  cl.frames[cl.netchan.outgoing_sequence & UPDATE_MASK].senttime = svMainMod.svMainState.realtime;
  cl.frames[cl.netchan.outgoing_sequence & UPDATE_MASK].ping_time = -1;

  svState.host_client = cl;
  svState.sv_player = cl.edict;

  //	seq_hash = (cl->netchan.incoming_sequence & 0xffff) ; // ^ QW_CHECK_HASH;
  const seq_hash = cl.netchan.incoming_sequence;

  // mark time so clients will know how much to predict
  // other players
  cl.localtime = sv.time;
  cl.delta_sequence = -1; // no delta unless requested
  for (;;) {
    if (msgState.badread) {
      Con_Printf("SV_ReadClientMessage: badread\n");
      svMainMod.SV_DropClient(cl);
      return;
    }

    const c = MSG_ReadByte();
    if (c === -1) break;

    switch (c) {
      default:
        Con_Printf("SV_ReadClientMessage: unknown command char\n");
        svMainMod.SV_DropClient(cl);
        return;

      case ClcOpsT.clc_nop:
        break;

      case ClcOpsT.clc_delta:
        cl.delta_sequence = MSG_ReadByte();
        break;

      case ClcOpsT.clc_move: {
        if (move_issued) return; // someone is trying to cheat...

        move_issued = true;

        const checksumIndex = MSG_GetReadCount();
        const checksum = MSG_ReadByte() & 0xff;

        // read loss percentage
        cl.lossage = MSG_ReadByte();

        MSG_ReadDeltaUsercmd(nullcmd, oldest);
        MSG_ReadDeltaUsercmd(oldest, oldcmd);
        MSG_ReadDeltaUsercmd(oldcmd, newcmd);

        if (cl.state !== ClientStateT.cs_spawned) break;

        // if the checksum fails, ignore the rest of the packet
        const calculatedChecksum = COM_BlockSequenceCRCByte(
          net_message.data.subarray(checksumIndex + 1),
          MSG_GetReadCount() - checksumIndex - 1,
          seq_hash,
        );

        if (calculatedChecksum !== checksum) {
          Con_DPrintf(
            "Failed command checksum for %s(%d) (%d != %d)\n",
            cl.name,
            cl.netchan.incoming_sequence,
            checksum,
            calculatedChecksum,
          );
          return;
        }

        if (!sv.paused) {
          SV_PreRunCmd();

          // see file header: net_chan.ts's `net_drop` cannot be assigned
          // through its imported binding, so the decrement goes through
          // `setNetDrop`, matching the C's `net_drop--` on the real global.
          if (net_drop < 20) {
            while (net_drop > 2) {
              SV_RunCmd(cl.lastcmd);
              setNetDrop(net_drop - 1);
            }
            if (net_drop > 1) SV_RunCmd(oldest);
            if (net_drop > 0) SV_RunCmd(oldcmd);
          }
          SV_RunCmd(newcmd);

          SV_PostRunCmd();
        }

        copyUsercmd(cl.lastcmd, newcmd);
        cl.lastcmd.buttons = 0; // avoid multiple fires on lag
        break;
      }

      case ClcOpsT.clc_stringcmd: {
        const s = MSG_ReadString();
        SV_ExecuteUserCommand(s);
        break;
      }

      case ClcOpsT.clc_tmove:
        o[0] = MSG_ReadCoord();
        o[1] = MSG_ReadCoord();
        o[2] = MSG_ReadCoord();
        // only allowed by spectators
        if (requireHostClient().spectator) {
          VectorCopy(o, requireSvPlayer().v.origin);
          SV_LinkEdict(requireSvPlayer(), false);
        }
        break;

      case ClcOpsT.clc_upload:
        SV_NextUpload();
        break;
    }
  }
}

/*
==============
SV_UserInit
==============
*/
export function SV_UserInit(): void {
  Cvar_RegisterVariable(cl_rollspeed);
  Cvar_RegisterVariable(cl_rollangle);
  Cvar_RegisterVariable(sv_spectalk);
  Cvar_RegisterVariable(sv_mapcheck);
}
