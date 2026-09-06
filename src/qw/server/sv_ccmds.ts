/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_ccmds.c (GNU GPL v2 or later).

sv_ccmds.c -- "OPERATOR CONSOLE ONLY COMMANDS": every command that can only
be entered from stdin or by a remote operator datagram (rcon), registered
by SV_InitOperatorCommands. WinQuake's host_cmd.c/sv_main.c have loose
cousins for some of these (map/kick/status/say/give/god/noclip/quit), but
this file is ported fresh from the QW C, not translated from the WinQuake TS
-- per this unit's brief.

Deviations from PORTING.md / the C source:
- `SV_DropClient`/`SV_FinalMessage`/`SV_Shutdown`/`SV_CalcPing`/`master_adr`:
  genuinely sv_main.c-owned, reached through the lazy `svMainMod()` helper
  below rather than a direct import, matching sv_send.ts's/sv_init.ts's own
  reasoning (sv_main.ts imports sv_send.ts normally, and this file imports
  sv_send.ts normally too, so a direct import of sv_main.ts here would still
  be one hop from a cycle; the lazy path is used uniformly for consistency).
- `Con_Printf`/`Con_DPrintf`/`SV_ClientPrintf`/`SV_BroadcastPrintf`/
  `SV_BroadcastCommand`/`SV_SendMessagesToAll`/`sv_redirected`: sv_send.c's
  own exports (this SCOPE's sv_send.ts), imported normally -- no cycle, since
  sv_send.ts never imports anything from this file.
- `sv_logfile`/`sv_fraglogfile`: held in sv_send.ts's `svSendFileState`
  holder (see that file's header for why), not duplicated here; this file's
  SV_Logfile_f/SV_Fraglogfile_f read/write through that export.
- `gamedirfile`/`com_gamedir`: both are src/qw/common.ts's own exports
  (common.c's globals; `gamedirfile` in sv_ccmds.c and common.c's copy share
  one C-linkage "common" storage slot in the original binary, confirmed by
  the absence of a `static` qualifier on either declaration -- not two
  separate variables), imported from "../common" rather than redeclared.
- `localinfo` (sv_init.c's own storage, this SCOPE's sv_init.ts): exported
  there as `localinfoState: { value: string }` (a plain `export let string`
  cannot be reassigned from another module); this file's SV_Localinfo_f
  reads/writes `localinfoState.value`.
- `SV_Map_f`'s `#if 0` e1m8->e1m5 low-gravity-level substitution block: dead
  code in the C itself (an `#if 0`, not merely an unreached branch), dropped
  per PORTING.md's `#if 0` rule.
- `SV_Floodprot_f`'s `Cmd_Argc()==1 && !fp_messages` path: the C prints "No
  floodprots enabled." and then falls through (no `return`) into the
  `Cmd_Argc()!=4` check below, which is also true in this branch, so it also
  prints the "Usage: floodprot ..." lines. This looks like a missing
  `return`, but it is what the source does -- ported verbatim, not "fixed"
  with an added `return`, per this port's exactly as the original rule.
- `SV_Fraglogfile_f`'s `sv_fraglogfile = fopen(name,"w"); if (!sv_fraglogfile)
  i=1000;`: src/platform/sys.ts's `Sys_FileOpenWrite` throws (Sys_Error) on
  failure rather than returning a null-like sentinel the way `fopen` does
  (out of this unit's SCOPE to change) -- wrapped in a try/catch that sets
  `i = 1000` on the exception, reproducing the C's graceful failure path
  from what would otherwise be an uncaught throw.
- `SV_Snap`'s `pcxname[strlen(pcxname)-6] = i/10+'0'; pcxname[strlen(pcxname)-5]
  = i%10+'0';` (in-place byte mutation of a C string, positions that always
  land on the "00" placeholder two-digit run of `"<uid>-00.pcx"` regardless
  of how many digits `uid` has): ported as building the whole filename fresh
  each iteration, `` `${uid}-${String(j).padStart(2, "0")}.pcx` ``, the same
  string this byte mutation always produces -- see the loop's own comment.
- `memcpy(&cl->snap_from, &net_from, sizeof(net_from))`: ported as a field-by-
  field copy (`ip`/`port`/`pad`), matching this port's NetadrT shape.
- `Z_Free (var->string); var->string = CopyString (...); var->value =
  Q_atof(...)` (SV_Serverinfo_f): PORTING.md's Memory ruling collapses
  Z_Free/CopyString to nothing more than the plain string assignment itself
  (no separate allocation to free or copy); ported as `cvar.string =
  Cmd_Argv(2)` followed by the same `Q_atof` re-derivation of `cvar.value`.
- `%-16.16s`-style width+precision+left-justify format specifiers
  (SV_Status_f) go through src/common/sprintf.ts's Com_sprintf exactly as
  every other Con_Printf call in this port does; not special-cased here.
*/

import type * as SvMainModule from "./sv_main";
import { ClientReliableWrite_Begin, ClientReliableWrite_String } from "./sv_nchan";
import { Con_DPrintf, Con_Printf, SV_BroadcastCommand, SV_BroadcastPrintf, SV_ClientPrintf, SV_SendMessagesToAll, sv_redirected, svSendFileState } from "./sv_send";
import { localinfoState, SV_SpawnServer } from "./sv_init";
import { num_prstr, type QwEdictT } from "./progs";
import { ClientStateT, ClientT, MOVETYPE_NOCLIP, MOVETYPE_WALK, RedirectT, STATFRAMES, sv, svs, svState, FL_GODMODE } from "./server";
import { MAX_CLIENTS, PRINT_CHAT, PRINT_HIGH, SvcOpsT, A2A_PING } from "../protocol";
import { IT_SHOTGUN } from "../bothdefs";
import { Cmd_Argc, Cmd_Args, Cmd_Argv, Cmd_AddCommand, cl_warncmd } from "../cmd";
import { Cvar_FindVar } from "../cvar";
import {
  BigShort,
  COM_CheckParm,
  COM_FOpenFile,
  COM_Gamedir,
  com_gamedir,
  gamedirfile,
  Info_Print,
  Info_SetValueForKey,
  Info_SetValueForStarKey,
  Info_ValueForKey,
  MAX_LOCALINFO_STRING,
  MAX_SERVERINFO_STRING,
  MSG_WriteByte,
  MSG_WriteString,
  Q_atof,
  Q_atoi,
} from "../common";
import { net_from, net_local_adr, NET_AdrToString, NET_BaseAdrToString, NET_SendPacket, NET_StringToAdr } from "../net_udp";
import { Sys_FileClose, Sys_FileOpenRead, Sys_FileOpenWrite, Sys_FileTime, Sys_mkdir, Sys_Quit, SysError } from "../../platform/sys";

// see file header: sv_main.c-owned names, reached lazily.
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

function requireHostClient(): ClientT {
  if (svState.host_client === null) throw new SysError("sv_ccmds: host_client not set");
  return svState.host_client;
}

function requireSvPlayer(): QwEdictT {
  if (svState.sv_player === null) throw new SysError("sv_ccmds: sv_player not set");
  return svState.sv_player;
}

function requireEdict(client: ClientT): QwEdictT {
  if (client.edict === null) throw new SysError("sv_ccmds: client has no edict");
  return client.edict;
}

/*
===============================================================================

OPERATOR CONSOLE ONLY COMMANDS

These commands can only be entered from stdin or by a remote operator datagram
===============================================================================
*/

export let sv_allow_cheats = false;

export let fp_messages = 4;
export let fp_persecond = 4;
export let fp_secondsdead = 10;
export let fp_msg = "";

/*
====================
SV_SetMaster_f

Make a master server current
====================
*/
export function SV_SetMaster_f(): void {
  const master_adr = svMainMod().master_adr;

  for (const adr of master_adr) {
    adr.ip.fill(0);
    adr.port = 0;
    adr.pad = 0;
  }

  for (let i = 1; i < Cmd_Argc(); i++) {
    if (Cmd_Argv(i) === "none" || !NET_StringToAdr(Cmd_Argv(i), master_adr[i - 1])) {
      Con_Printf("Setting nomaster mode.\n");
      return;
    }
    if (master_adr[i - 1].port === 0) master_adr[i - 1].port = BigShort(27000);

    Con_Printf("Master server at %s\n", NET_AdrToString(master_adr[i - 1]));

    Con_Printf("Sending a ping.\n");

    const data = new Uint8Array([A2A_PING.charCodeAt(0), 0]);
    NET_SendPacket(2, data, master_adr[i - 1]);
  }

  svs.last_heartbeat = -99999;
}

/*
==================
SV_Quit_f
==================
*/
export function SV_Quit_f(): void {
  svMainMod().SV_FinalMessage("server shutdown\n");
  Con_Printf("Shutting down.\n");
  svMainMod().SV_Shutdown();
  Sys_Quit();
}

/*
============
SV_Logfile_f
============
*/
export function SV_Logfile_f(): void {
  if (svSendFileState.sv_logfile !== null) {
    Con_Printf("File logging off.\n");
    Sys_FileClose(svSendFileState.sv_logfile);
    svSendFileState.sv_logfile = null;
    return;
  }

  const name = `${com_gamedir}/qconsole.log`;
  Con_Printf("Logging text to %s.\n", name);
  try {
    svSendFileState.sv_logfile = Sys_FileOpenWrite(name);
  } catch {
    Con_Printf("failed.\n");
  }
}

/*
============
SV_Fraglogfile_f
============
*/
export function SV_Fraglogfile_f(): void {
  if (svSendFileState.sv_fraglogfile !== null) {
    Con_Printf("Frag file logging off.\n");
    Sys_FileClose(svSendFileState.sv_fraglogfile);
    svSendFileState.sv_fraglogfile = null;
    return;
  }

  // find an unused name
  let i = 0;
  let name = "";
  for (; i < 1000; i++) {
    name = `${com_gamedir}/frag_${i}.log`;
    const { handle } = Sys_FileOpenRead(name);
    if (handle === -1) {
      // can't read it, so create this one
      try {
        svSendFileState.sv_fraglogfile = Sys_FileOpenWrite(name);
      } catch {
        i = 1000; // give error
      }
      break;
    }
    Sys_FileClose(handle);
  }
  if (i === 1000) {
    Con_Printf("Can't open any logfiles.\n");
    svSendFileState.sv_fraglogfile = null;
    return;
  }

  Con_Printf("Logging frags to %s.\n", name);
}

/*
==================
SV_SetPlayer

Sets host_client and sv_player to the player with idnum Cmd_Argv(1)
==================
*/
export function SV_SetPlayer(): boolean {
  const idnum = Q_atoi(Cmd_Argv(1));

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (!cl.state) continue;
    if (cl.userid === idnum) {
      svState.host_client = cl;
      svState.sv_player = cl.edict;
      return true;
    }
  }
  Con_Printf("Userid %i is not on the server\n", idnum);
  return false;
}

/*
==================
SV_God_f

Sets client to godmode
==================
*/
export function SV_God_f(): void {
  if (!sv_allow_cheats) {
    Con_Printf("You must run the server with -cheats to enable this command.\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  const sv_player = requireSvPlayer();
  sv_player.v.flags = (sv_player.v.flags | 0) ^ FL_GODMODE;
  if (!((sv_player.v.flags | 0) & FL_GODMODE)) SV_ClientPrintf(requireHostClient(), PRINT_HIGH, "godmode OFF\n");
  else SV_ClientPrintf(requireHostClient(), PRINT_HIGH, "godmode ON\n");
}

export function SV_Noclip_f(): void {
  if (!sv_allow_cheats) {
    Con_Printf("You must run the server with -cheats to enable this command.\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  const sv_player = requireSvPlayer();
  if (sv_player.v.movetype !== MOVETYPE_NOCLIP) {
    sv_player.v.movetype = MOVETYPE_NOCLIP;
    SV_ClientPrintf(requireHostClient(), PRINT_HIGH, "noclip ON\n");
  } else {
    sv_player.v.movetype = MOVETYPE_WALK;
    SV_ClientPrintf(requireHostClient(), PRINT_HIGH, "noclip OFF\n");
  }
}

/*
==================
SV_Give_f
==================
*/
export function SV_Give_f(): void {
  if (!sv_allow_cheats) {
    Con_Printf("You must run the server with -cheats to enable this command.\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  const sv_player = requireSvPlayer();
  const t = Cmd_Argv(2);
  const v = Q_atoi(Cmd_Argv(3));

  switch (t[0]) {
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      sv_player.v.items = (sv_player.v.items | 0) | (IT_SHOTGUN << (t.charCodeAt(0) - "2".charCodeAt(0)));
      break;

    case "s":
      sv_player.v.ammo_shells = v;
      break;
    case "n":
      sv_player.v.ammo_nails = v;
      break;
    case "r":
      sv_player.v.ammo_rockets = v;
      break;
    case "h":
      sv_player.v.health = v;
      break;
    case "c":
      sv_player.v.ammo_cells = v;
      break;
  }
}

/*
======================
SV_Map_f

handle a
map <mapname>
command from the console or progs.
======================
*/
export function SV_Map_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("map <levelname> : continue game on a new level\n");
    return;
  }
  const level = Cmd_Argv(1);

  // check to make sure the level exists
  const expanded = `maps/${level}.bsp`;
  const { handle } = COM_FOpenFile(expanded);
  if (handle === -1) {
    Con_Printf("Can't find %s\n", expanded);
    return;
  }
  Sys_FileClose(handle);

  SV_BroadcastCommand("changing\n");
  SV_SendMessagesToAll();

  SV_SpawnServer(level);

  SV_BroadcastCommand("reconnect\n");
}

/*
==================
SV_Kick_f

Kick a user off of the server
==================
*/
export function SV_Kick_f(): void {
  const uid = Q_atoi(Cmd_Argv(1));

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (!cl.state) continue;
    if (cl.userid === uid) {
      SV_BroadcastPrintf(PRINT_HIGH, "%s was kicked\n", cl.name);
      // print directly, because the dropped client won't get the
      // SV_BroadcastPrintf message
      SV_ClientPrintf(cl, PRINT_HIGH, "You were kicked from the game\n");
      svMainMod().SV_DropClient(cl);
      return;
    }
  }

  Con_Printf("Couldn't find user number %i\n", uid);
}

/*
================
SV_Status_f
================
*/
export function SV_Status_f(): void {
  let cpu = svs.stats.latched_active + svs.stats.latched_idle;
  if (cpu) cpu = (100 * svs.stats.latched_active) / cpu;
  const avg = (1000 * svs.stats.latched_active) / STATFRAMES;
  const pak = svs.stats.latched_packets / STATFRAMES;

  Con_Printf("net address      : %s\n", NET_AdrToString(net_local_adr));
  Con_Printf("cpu utilization  : %3i%%\n", Math.trunc(cpu));
  Con_Printf("avg response time: %i ms\n", Math.trunc(avg));
  Con_Printf("packets/frame    : %5.2f (%d)\n", pak, num_prstr());

  if (sv_redirected !== RedirectT.RD_NONE) {
    // most remote clients are 40 columns
    //           0123456789012345678901234567890123456789
    Con_Printf("name               userid frags\n");
    Con_Printf("  address          rate ping drop\n");
    Con_Printf("  ---------------- ---- ---- -----\n");
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const cl = svs.clients[i];
      if (!cl.state) continue;

      Con_Printf("%-16.16s  ", cl.name);

      Con_Printf("%6i %5i", cl.userid, requireEdict(cl).v.frags);
      if (cl.spectator) Con_Printf(" (s)\n");
      else Con_Printf("\n");

      const s = NET_BaseAdrToString(cl.netchan.remote_address);
      Con_Printf("  %-16.16s", s);
      if (cl.state === ClientStateT.cs_connected) {
        Con_Printf("CONNECTING\n");
        continue;
      }
      if (cl.state === ClientStateT.cs_zombie) {
        Con_Printf("ZOMBIE\n");
        continue;
      }
      Con_Printf(
        "%4i %4i %5.2f\n",
        Math.trunc(1000 * cl.netchan.frame_rate),
        Math.trunc(svMainMod().SV_CalcPing(cl)),
        (100.0 * cl.netchan.drop_count) / cl.netchan.incoming_sequence,
      );
    }
  } else {
    Con_Printf("frags userid address         name            rate ping drop  qport\n");
    Con_Printf("----- ------ --------------- --------------- ---- ---- ----- -----\n");
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const cl = svs.clients[i];
      if (!cl.state) continue;

      Con_Printf("%5i %6i ", requireEdict(cl).v.frags, cl.userid);

      const s = NET_BaseAdrToString(cl.netchan.remote_address);
      Con_Printf("%s", s);
      let l = 16 - s.length;
      for (let j = 0; j < l; j++) Con_Printf(" ");

      Con_Printf("%s", cl.name);
      l = 16 - cl.name.length;
      for (let j = 0; j < l; j++) Con_Printf(" ");

      if (cl.state === ClientStateT.cs_connected) {
        Con_Printf("CONNECTING\n");
        continue;
      }
      if (cl.state === ClientStateT.cs_zombie) {
        Con_Printf("ZOMBIE\n");
        continue;
      }
      Con_Printf(
        "%4i %4i %3.1f %4i",
        Math.trunc(1000 * cl.netchan.frame_rate),
        Math.trunc(svMainMod().SV_CalcPing(cl)),
        (100.0 * cl.netchan.drop_count) / cl.netchan.incoming_sequence,
        cl.netchan.qport,
      );
      if (cl.spectator) Con_Printf(" (s)\n");
      else Con_Printf("\n");
    }
  }
  Con_Printf("\n");
}

/*
==================
SV_ConSay_f
==================
*/
export function SV_ConSay_f(): void {
  if (Cmd_Argc() < 2) return;

  let p = Cmd_Args() ?? "";

  if (p[0] === '"') p = p.slice(1, p.length - 1);

  const text = `console: ${p}`;

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const client = svs.clients[j];
    if (client.state !== ClientStateT.cs_spawned) continue;
    SV_ClientPrintf(client, PRINT_CHAT, "%s\n", text);
  }
}

/*
==================
SV_Heartbeat_f
==================
*/
export function SV_Heartbeat_f(): void {
  svs.last_heartbeat = -9999;
}

/*
====================
SV_SendServerInfoChange
====================
*/
export function SV_SendServerInfoChange(key: string, value: string): void {
  if (!sv.state) return;

  MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_serverinfo);
  MSG_WriteString(sv.reliable_datagram, key);
  MSG_WriteString(sv.reliable_datagram, value);
}

/*
===========
SV_Serverinfo_f

  Examine or change the serverinfo string
===========
*/
export function SV_Serverinfo_f(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("Server info settings:\n");
    Info_Print(svs.info);
    return;
  }

  if (Cmd_Argc() !== 3) {
    Con_Printf("usage: serverinfo [ <key> <value> ]\n");
    return;
  }

  if (Cmd_Argv(1)[0] === "*") {
    Con_Printf("Star variables cannot be changed.\n");
    return;
  }
  svs.info = Info_SetValueForKey(svs.info, Cmd_Argv(1), Cmd_Argv(2), MAX_SERVERINFO_STRING);

  // if this is a cvar, change it too
  const cvar = Cvar_FindVar(Cmd_Argv(1));
  if (cvar) {
    // Z_Free (var->string); var->string = CopyString(...) -- see file header
    cvar.string = Cmd_Argv(2);
    cvar.value = Q_atof(cvar.string);
  }

  SV_SendServerInfoChange(Cmd_Argv(1), Cmd_Argv(2));
}

/*
===========
SV_Localinfo_f

  Examine or change the local info settings
===========
*/
export function SV_Localinfo_f(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("Local info settings:\n");
    Info_Print(localinfoState.value);
    return;
  }

  if (Cmd_Argc() !== 3) {
    Con_Printf("usage: localinfo [ <key> <value> ]\n");
    return;
  }

  if (Cmd_Argv(1)[0] === "*") {
    Con_Printf("Star variables cannot be changed.\n");
    return;
  }

  localinfoState.value = Info_SetValueForKey(localinfoState.value, Cmd_Argv(1), Cmd_Argv(2), MAX_LOCALINFO_STRING);
}

/*
===========
SV_User_f

Examine a users info strings
===========
*/
export function SV_User_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("Usage: info <userid>\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  Info_Print(requireHostClient().userinfo);
}

/*
================
SV_Gamedir

Sets the fake *gamedir to a different directory.
================
*/
export function SV_Gamedir(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("Current *gamedir: %s\n", Info_ValueForKey(svs.info, "*gamedir"));
    return;
  }

  if (Cmd_Argc() !== 2) {
    Con_Printf("Usage: sv_gamedir <newgamedir>\n");
    return;
  }

  const dir = Cmd_Argv(1);

  if (dir.includes("..") || dir.includes("/") || dir.includes("\\") || dir.includes(":")) {
    Con_Printf("*Gamedir should be a single filename, not a path\n");
    return;
  }

  svs.info = Info_SetValueForStarKey(svs.info, "*gamedir", dir, MAX_SERVERINFO_STRING);
}

/*
================
SV_Floodprot_f

Sets the gamedir and path to a different directory.
================
*/
export function SV_Floodprot_f(): void {
  if (Cmd_Argc() === 1) {
    if (fp_messages) {
      Con_Printf("Current floodprot settings: \nAfter %d msgs per %d seconds, silence for %d seconds\n", fp_messages, fp_persecond, fp_secondsdead);
      return;
    } else {
      Con_Printf("No floodprots enabled.\n");
      // falls through to the usage message below -- see file header (preserved C quirk)
    }
  }

  if (Cmd_Argc() !== 4) {
    Con_Printf("Usage: floodprot <# of messages> <per # of seconds> <seconds to silence>\n");
    Con_Printf("Use floodprotmsg to set a custom message to say to the flooder.\n");
    return;
  }

  const arg1 = Q_atoi(Cmd_Argv(1));
  const arg2 = Q_atoi(Cmd_Argv(2));
  const arg3 = Q_atoi(Cmd_Argv(3));

  if (arg1 <= 0 || arg2 <= 0 || arg3 <= 0) {
    Con_Printf("All values must be positive numbers\n");
    return;
  }

  if (arg1 > 10) {
    Con_Printf("Can only track up to 10 messages.\n");
    return;
  }

  fp_messages = arg1;
  fp_persecond = arg2;
  fp_secondsdead = arg3;
}

export function SV_Floodprotmsg_f(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("Current msg: %s\n", fp_msg);
    return;
  } else if (Cmd_Argc() !== 2) {
    Con_Printf('Usage: floodprotmsg "<message>"\n');
    return;
  }
  fp_msg = Cmd_Argv(1);
}

/*
================
SV_Gamedir_f

Sets the gamedir and path to a different directory.
================
*/
export function SV_Gamedir_f(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("Current gamedir: %s\n", com_gamedir);
    return;
  }

  if (Cmd_Argc() !== 2) {
    Con_Printf("Usage: gamedir <newdir>\n");
    return;
  }

  const dir = Cmd_Argv(1);

  if (dir.includes("..") || dir.includes("/") || dir.includes("\\") || dir.includes(":")) {
    Con_Printf("Gamedir should be a single filename, not a path\n");
    return;
  }

  COM_Gamedir(dir);
  svs.info = Info_SetValueForStarKey(svs.info, "*gamedir", dir, MAX_SERVERINFO_STRING);
}

/*
================
SV_Snap
================
*/
export function SV_Snap(uid: number): void {
  let i = 0;
  let cl: ClientT | null = null;
  for (; i < MAX_CLIENTS; i++) {
    const c = svs.clients[i];
    if (!c.state) continue;
    if (c.userid === uid) {
      cl = c;
      break;
    }
  }
  if (i >= MAX_CLIENTS || cl === null) {
    Con_Printf("userid not found\n");
    return;
  }

  Sys_mkdir(gamedirfile);
  let checkname = `${gamedirfile}/snap`;
  Sys_mkdir(checkname);

  // pcxname[strlen(pcxname)-6]/[-5] byte mutation -- see file header
  let j = 0;
  for (; j <= 99; j++) {
    const pcxname = `${uid}-${String(j).padStart(2, "0")}.pcx`;
    checkname = `${gamedirfile}/snap/${pcxname}`;
    if (Sys_FileTime(checkname) === -1) break; // file doesn't exist
  }
  if (j === 100) {
    Con_Printf("Snap: Couldn't create a file, clean some out.\n");
    return;
  }
  cl.uploadfn = checkname;

  cl.snap_from.ip.set(net_from.ip);
  cl.snap_from.port = net_from.port;
  cl.snap_from.pad = net_from.pad;
  cl.remote_snap = sv_redirected !== RedirectT.RD_NONE;

  ClientReliableWrite_Begin(cl, SvcOpsT.svc_stufftext, 24);
  ClientReliableWrite_String(cl, "cmd snap");
  Con_Printf("Requesting snap from user %d...\n", uid);
}

/*
================
SV_Snap_f
================
*/
export function SV_Snap_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("Usage:  snap <userid>\n");
    return;
  }

  const uid = Q_atoi(Cmd_Argv(1));

  SV_Snap(uid);
}

/*
================
SV_SnapAll_f
================
*/
export function SV_SnapAll_f(): void {
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (cl.state < ClientStateT.cs_connected || cl.spectator) continue;
    SV_Snap(cl.userid);
  }
}

/*
==================
SV_InitOperatorCommands
==================
*/
export function SV_InitOperatorCommands(): void {
  if (COM_CheckParm("-cheats")) {
    sv_allow_cheats = true;
    svs.info = Info_SetValueForStarKey(svs.info, "*cheats", "ON", MAX_SERVERINFO_STRING);
  }

  Cmd_AddCommand("logfile", SV_Logfile_f);
  Cmd_AddCommand("fraglogfile", SV_Fraglogfile_f);

  Cmd_AddCommand("snap", SV_Snap_f);
  Cmd_AddCommand("snapall", SV_SnapAll_f);
  Cmd_AddCommand("kick", SV_Kick_f);
  Cmd_AddCommand("status", SV_Status_f);

  Cmd_AddCommand("map", SV_Map_f);
  Cmd_AddCommand("setmaster", SV_SetMaster_f);

  Cmd_AddCommand("say", SV_ConSay_f);
  Cmd_AddCommand("heartbeat", SV_Heartbeat_f);
  Cmd_AddCommand("quit", SV_Quit_f);
  Cmd_AddCommand("god", SV_God_f);
  Cmd_AddCommand("give", SV_Give_f);
  Cmd_AddCommand("noclip", SV_Noclip_f);
  Cmd_AddCommand("serverinfo", SV_Serverinfo_f);
  Cmd_AddCommand("localinfo", SV_Localinfo_f);
  Cmd_AddCommand("user", SV_User_f);
  Cmd_AddCommand("gamedir", SV_Gamedir_f);
  Cmd_AddCommand("sv_gamedir", SV_Gamedir);
  Cmd_AddCommand("floodprot", SV_Floodprot_f);
  Cmd_AddCommand("floodprotmsg", SV_Floodprotmsg_f);

  cl_warncmd.value = 1;
}
