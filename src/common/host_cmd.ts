/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/host_cmd.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- Every client-side reference (`cls.*`, `cl.*`, `CL_*`, `SCR_*`, `key_dest`,
  `M_Menu_Quit_f`, `cl_name`, `cl_color`) goes through host.ts's exported
  `hostClientHooks` holder, the same seam host.c's own port uses; each call
  site keeps the C line beside it and no-ops when the client unit has not
  installed the hook (a dedicated server). `cls.state == ca_dedicated` is
  `sysState.isDedicated`.
- `int current_skill` is host_cmd.c's global; it lives on the exported
  `hostCmdState` holder ("C globals that are reassigned ... become fields on
  ... a small exported holder", PORTING.md). NOTE: sv_main.c's
  SV_SpawnServer also assigns `current_skill`; the landed
  `src/server/sv_main.ts` (U031, out of this unit's scope) made that a
  function-local `let current_skill` instead, so a `map` does not update the
  holder here and Host_Savegame_f will write the last value Host_Loadgame_f
  set (0 at startup). Reported as a follow-up.
- `qboolean noclip_anglehack` is exported directly (`export let` +
  `setNoclipAnglehack`, since a module may not have its `let` reassigned from
  outside); in the C it is read by in_win.c/in_sun.c/vid_x.c and cl_parse.c,
  none of them landed.
- `Host_Status_f`'s `if (ipxAvailable) print ("ipx: %s\n", my_ipx_address)`
  is dropped: net.ts/net_main.ts (U008/U009) already dropped
  `ipxAvailable`/`my_ipx_address` along with the IPX drivers PORTING.md does
  not port. `tcpipAvailable`/`my_tcpip_address` are kept.
- `client->netconnection->connecttime` / `client->edict->v.frags` are raw
  dereferences in the C; `netconnection`/`edict` are `| null` here, so those
  reads are guarded and fall back to 0 / "" rather than crashing.
- `FILE *f` in Host_Savegame_f/Host_Loadgame_f: the writer is host.ts's
  `SysFileTextWriter` over Sys_FileOpenWrite/Sys_FileWrite/Sys_FileClose;
  the reader loads the whole file with Sys_FileOpenRead/Sys_FileRead and
  decodes it Latin-1, then drives it with the `scanToken` reader below.
  `fscanf(f, "%i\n" | "%f\n" | "%s\n", ...)` in glibc means "skip leading
  whitespace, take one whitespace-delimited token, then consume the
  whitespace that follows" -- which is exactly `scanToken`, so the character
  loop that reads the `{ ... }` blocks afterwards starts on the same byte the
  C's `fgetc` loop does. `Sys_FileOpenWrite` `Sys_Error`s where the C's
  `fopen` returned NULL, so Host_Savegame_f's "ERROR: couldn't open." branch
  is unreachable (kept for the documented `handle === -1` case).
- `sv.lightstyles[i]` is `string` here, `char *` in the C: the savegame
  writer's `if (sv.lightstyles[i]) ... else fprintf (f,"m\n")` maps NULL to
  `""`, so a lightstyle deliberately set to the empty string (which the C
  would write as a blank line) writes `m` instead. A server.ts
  representation gap, not a change made here.
- `PrintFrameName` reads `aliashdr_t->frames[frame].name` through
  `Mod_Extradata`, which is renderer-owned data (`RendererModelData` =
  `unknown` in model.ts) with no loader landed. Ruling (unit brief): print
  the C's line with the frame number only.
- `MAX_DEMOS`/`MAX_DEMONAME` are client.h constants; client.ts is not landed,
  so they are declared here with their C values and move to client.ts when
  it lands.
- `Host_Version_f`'s `Con_Printf ("Exe: "__TIME__" "__DATE__"\n")` is dropped
  for the same reason host.ts drops the identical line in Host_Init: there is
  no compile-time date/time macro to port.
- `Host_Say`'s `unsigned char text[64]` overflow arithmetic (`j = sizeof(text)
  - 2 - strlen(text)`) is ported verbatim on strings.
- Dropped `#ifdef`s: `QUAKE2` (Host_Changelevel2_f, SaveGamestate,
  LoadGamestate, the startspot arguments to SV_SpawnServer, and
  Host_Loadgame_f's `Cvar_SetValue("deathmatch"/"coop"/"teamplay", 0)`),
  `IDGODS` (Host_Please_f and its `please` command).
*/

import {
  Cbuf_AddText,
  Cmd_AddCommand,
  Cmd_Argc,
  Cmd_Args,
  Cmd_Argv,
  Cmd_ExecuteString,
  Cmd_ForwardToServer,
  CmdSourceT,
  cmdState,
} from "./cmd";
import { Cvar_Set, Cvar_SetValue, Cvar_VariableString } from "./cvar";
import { COM_DefaultExtension, COM_Parse, Q_atof, Q_atoi, Q_strcasecmp, com_gamedir, hipnotic, rogue, type ParseState } from "./common";
import { Con_Printf } from "../client/console";
import { Com_sprintf } from "./sprintf";
import {
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteFloat,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  SZ_Clear,
  SZ_Write,
} from "./sizebuf";
import { SvcOpsT } from "./protocol";
import {
  Sys_Error,
  Sys_FileClose,
  Sys_FileOpenRead,
  Sys_FileOpenWrite,
  Sys_FileRead,
  Sys_FloatTime,
  Sys_Printf,
  Sys_Quit,
  sysState,
} from "../platform/sys";
import {
  HIT_LASER_CANNON,
  HIT_MJOLNIR,
  HIT_PROXIMITY_GUN,
  IT_GRENADE_LAUNCHER,
  IT_LIGHTNING,
  IT_SHOTGUN,
  MAX_LIGHTSTYLES,
  SAVEGAME_COMMENT_LENGTH,
  STAT_MONSTERS,
  STAT_TOTALMONSTERS,
  VERSION,
  STAT_TOTALSECRETS,
  STAT_SECRETS,
} from "./quakedef";
import {
  FL_GODMODE,
  FL_NOTARGET,
  MOVETYPE_FLY,
  MOVETYPE_NOCLIP,
  MOVETYPE_WALK,
  NUM_PING_TIMES,
  NUM_SPAWN_PARMS,
  type ClientT,
  sv,
  svState,
  svs,
} from "../server/server";
import { SV_SaveSpawnparms, SV_SpawnServer, SV_WriteClientdataToMessage } from "../server/sv_main";
import { SV_LinkEdict } from "../server/world";
import { Mod_ForName, Mod_Print, type ModelT } from "./model";
import { my_tcpip_address, net_activeconnections, net_time, tcpipAvailable, hostname } from "./net_main";
import { EDICT_NUM, EDICT_TO_PROG, NUM_FOR_EDICT, PR_GetString, PR_SetEngineStringRef, pr, type EdictT } from "../progs/progs";
import { ED_ParseEdict, ED_ParseGlobals, ED_Write, ED_WriteGlobals, GetEdictFieldValue } from "../progs/pr_edict";
import { PR_ExecuteProgram } from "../progs/pr_exec";
import { GLOBAL_OFS, type GlobalVars } from "../progs/progdefs";
import {
  Host_ShutdownServer,
  SV_BroadcastPrintf,
  SV_ClientPrintf,
  SV_DropClient,
  SysFileTextWriter,
  hostClientHooks,
  pausable,
  teamplay,
} from "./host";

// client.h -- see the file header
const MAX_DEMOS = 8;
const MAX_DEMONAME = 16;

// int current_skill; -- see the file header
export const hostCmdState = { current_skill: 0 };

export let noclip_anglehack = false;
export function setNoclipAnglehack(v: boolean): void {
  noclip_anglehack = v;
}

function globalStruct(): GlobalVars {
  if (pr.global_struct === null) Sys_Error("host_cmd: pr.global_struct not set (PR_LoadProgs not called)");
  return pr.global_struct;
}

function globalsF(): Float32Array {
  if (pr.globals === null) Sys_Error("host_cmd: pr.globals not set (PR_LoadProgs not called)");
  return pr.globals.f;
}

function requireHostClient(): ClientT {
  const c = svState.host_client;
  if (c === null) Sys_Error("host_cmd: no host_client");
  return c;
}

function requireSvPlayer(): EdictT {
  const e = svState.sv_player;
  if (e === null) Sys_Error("host_cmd: no sv_player");
  return e;
}

/*
==================
Host_Quit_f
==================
*/
export function Host_Quit_f(): void {
  if (!(hostClientHooks.keyDestIsConsole?.() ?? true) && !sysState.isDedicated) {
    hostClientHooks.mMenuQuitF?.(); // M_Menu_Quit_f
    return;
  }
  hostClientHooks.clDisconnect?.(); // CL_Disconnect
  Host_ShutdownServer(false);

  Sys_Quit();
}

/*
==================
Host_Status_f
==================
*/
export function Host_Status_f(): void {
  let hours = 0;
  let print: (fmt: string, ...args: Array<string | number>) => void;

  if (cmdState.source === CmdSourceT.src_command) {
    if (!sv.active) {
      Cmd_ForwardToServer();
      return;
    }
    print = Con_Printf;
  } else print = SV_ClientPrintf;

  print("host:    %s\n", Cvar_VariableString("hostname"));
  print("version: %4.2f\n", VERSION);
  if (tcpipAvailable) print("tcp/ip:  %s\n", my_tcpip_address);
  print("map:     %s\n", sv.name);
  print("players: %i active (%i max)\n\n", net_activeconnections, svs.maxclients);
  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (!client.active) continue;
    let seconds = Math.trunc(net_time - (client.netconnection === null ? 0 : client.netconnection.connecttime));
    let minutes = Math.trunc(seconds / 60);
    if (minutes) {
      seconds -= minutes * 60;
      hours = Math.trunc(minutes / 60);
      if (hours) minutes -= hours * 60;
    } else hours = 0;
    print(
      "#%-2u %-16.16s  %3i  %2i:%02i:%02i\n",
      j + 1,
      client.name,
      client.edict === null ? 0 : client.edict.v.frags | 0,
      hours,
      minutes,
      seconds,
    );
    print("   %s\n", client.netconnection === null ? "" : client.netconnection.address);
  }
}

/*
==================
Host_God_f

Sets client to godmode
==================
*/
export function Host_God_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (globalStruct().deathmatch && !requireHostClient().privileged) return;

  const sv_player = requireSvPlayer();
  sv_player.v.flags = (sv_player.v.flags | 0) ^ FL_GODMODE;
  if (!((sv_player.v.flags | 0) & FL_GODMODE)) SV_ClientPrintf("godmode OFF\n");
  else SV_ClientPrintf("godmode ON\n");
}

export function Host_Notarget_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (globalStruct().deathmatch && !requireHostClient().privileged) return;

  const sv_player = requireSvPlayer();
  sv_player.v.flags = (sv_player.v.flags | 0) ^ FL_NOTARGET;
  if (!((sv_player.v.flags | 0) & FL_NOTARGET)) SV_ClientPrintf("notarget OFF\n");
  else SV_ClientPrintf("notarget ON\n");
}

export function Host_Noclip_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (globalStruct().deathmatch && !requireHostClient().privileged) return;

  const sv_player = requireSvPlayer();
  if (sv_player.v.movetype !== MOVETYPE_NOCLIP) {
    noclip_anglehack = true;
    sv_player.v.movetype = MOVETYPE_NOCLIP;
    SV_ClientPrintf("noclip ON\n");
  } else {
    noclip_anglehack = false;
    sv_player.v.movetype = MOVETYPE_WALK;
    SV_ClientPrintf("noclip OFF\n");
  }
}

/*
==================
Host_Fly_f

Sets client to flymode
==================
*/
export function Host_Fly_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (globalStruct().deathmatch && !requireHostClient().privileged) return;

  const sv_player = requireSvPlayer();
  if (sv_player.v.movetype !== MOVETYPE_FLY) {
    sv_player.v.movetype = MOVETYPE_FLY;
    SV_ClientPrintf("flymode ON\n");
  } else {
    sv_player.v.movetype = MOVETYPE_WALK;
    SV_ClientPrintf("flymode OFF\n");
  }
}

/*
==================
Host_Ping_f

==================
*/
export function Host_Ping_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  SV_ClientPrintf("Client ping times:\n");
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (!client.active) continue;
    let total = 0;
    for (let j = 0; j < NUM_PING_TIMES; j++) total += client.ping_times[j];
    total /= NUM_PING_TIMES;
    SV_ClientPrintf("%4i %s\n", Math.trunc(total * 1000), client.name);
  }
}

/*
===============================================================================

SERVER TRANSITIONS

===============================================================================
*/

/*
======================
Host_Map_f

handle a
map <servername>
command from the console.  Active clients are kicked off.
======================
*/
export function Host_Map_f(): void {
  if (cmdState.source !== CmdSourceT.src_command) return;

  hostClientHooks.setClsDemonum?.(-1); // stop demo loop in case this fails

  hostClientHooks.clDisconnect?.(); // CL_Disconnect
  Host_ShutdownServer(false);

  hostClientHooks.setKeyDestGame?.(); // key_dest = key_game -- remove console or menu
  hostClientHooks.scrBeginLoadingPlaque?.(); // SCR_BeginLoadingPlaque

  let mapstring = "";
  for (let i = 0; i < Cmd_Argc(); i++) {
    mapstring += Cmd_Argv(i);
    mapstring += " ";
  }
  mapstring += "\n";
  hostClientHooks.setClsMapstring?.(mapstring); // cls.mapstring

  svs.serverflags = 0; // haven't completed an episode yet
  const name = Cmd_Argv(1);
  SV_SpawnServer(name);
  if (!sv.active) return;

  if (!sysState.isDedicated) {
    let spawnparms = "";

    for (let i = 2; i < Cmd_Argc(); i++) {
      spawnparms += Cmd_Argv(i);
      spawnparms += " ";
    }
    hostClientHooks.setClsSpawnparms?.(spawnparms); // cls.spawnparms

    Cmd_ExecuteString("connect local", CmdSourceT.src_command);
  }
}

/*
==================
Host_Changelevel_f

Goes to a new map, taking all clients along
==================
*/
export function Host_Changelevel_f(): void {
  if (Cmd_Argc() !== 2) {
    Con_Printf("changelevel <levelname> : continue game on a new level\n");
    return;
  }
  if (!sv.active || (hostClientHooks.clsDemoplayback?.() ?? false)) {
    Con_Printf("Only the server may changelevel\n");
    return;
  }
  SV_SaveSpawnparms();
  const level = Cmd_Argv(1);
  SV_SpawnServer(level);
}

/*
==================
Host_Restart_f

Restarts the current server for a dead player
==================
*/
export function Host_Restart_f(): void {
  if ((hostClientHooks.clsDemoplayback?.() ?? false) || !sv.active) return;

  if (cmdState.source !== CmdSourceT.src_command) return;
  const mapname = sv.name; // must copy out, because it gets cleared
  // in sv_spawnserver
  SV_SpawnServer(mapname);
}

/*
==================
Host_Reconnect_f

This command causes the client to wait for the signon messages again.
This is sent just before a server changes levels
==================
*/
export function Host_Reconnect_f(): void {
  hostClientHooks.scrBeginLoadingPlaque?.(); // SCR_BeginLoadingPlaque
  hostClientHooks.clsSignonZero?.(); // cls.signon = 0 -- need new connection messages
}

/*
=====================
Host_Connect_f

User command to connect to server
=====================
*/
export function Host_Connect_f(): void {
  hostClientHooks.setClsDemonum?.(-1); // stop demo loop in case this fails
  if (hostClientHooks.clsDemoplayback?.() ?? false) {
    hostClientHooks.clStopPlayback?.(); // CL_StopPlayback
    hostClientHooks.clDisconnect?.(); // CL_Disconnect
  }
  const name = Cmd_Argv(1);
  hostClientHooks.clEstablishConnection?.(name); // CL_EstablishConnection
  Host_Reconnect_f();
}

/*
===============================================================================

LOAD / SAVE GAME

===============================================================================
*/

export const SAVEGAME_VERSION = 5;

/*
===============
Host_SavegameComment

Writes a SAVEGAME_COMMENT_LENGTH character comment describing the current
===============
*/
export function Host_SavegameComment(): string {
  const text: string[] = [];

  for (let i = 0; i < SAVEGAME_COMMENT_LENGTH; i++) text[i] = " ";
  const levelname = hostClientHooks.clLevelname?.() ?? ""; // cl.levelname
  for (let i = 0; i < levelname.length && i < SAVEGAME_COMMENT_LENGTH; i++) text[i] = levelname[i];
  const kills = Com_sprintf(
    "kills:%3i/%3i",
    hostClientHooks.clStat?.(STAT_MONSTERS) ?? 0,
    hostClientHooks.clStat?.(STAT_TOTALMONSTERS) ?? 0,
  );
  for (let i = 0; i < kills.length && 22 + i < SAVEGAME_COMMENT_LENGTH; i++) text[22 + i] = kills[i];
  // convert space to _ to make stdio happy
  for (let i = 0; i < SAVEGAME_COMMENT_LENGTH; i++) if (text[i] === " ") text[i] = "_";

  return text.join("");
}

/*
===============
Host_Savegame_f
===============
*/
export function Host_Savegame_f(): void {
  if (cmdState.source !== CmdSourceT.src_command) return;

  if (!sv.active) {
    Con_Printf("Not playing a local game.\n");
    return;
  }

  if (hostClientHooks.clIntermission?.() ?? 0) {
    Con_Printf("Can't save in intermission.\n");
    return;
  }

  if (svs.maxclients !== 1) {
    Con_Printf("Can't save multiplayer games.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Con_Printf("save <savename> : save a game\n");
    return;
  }

  if (Cmd_Argv(1).includes("..")) {
    Con_Printf("Relative pathnames are not allowed.\n");
    return;
  }

  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    if (client.active && client.edict !== null && client.edict.v.health <= 0) {
      Con_Printf("Can't savegame with a dead player\n");
      return;
    }
  }

  let name = Com_sprintf("%s/%s", com_gamedir, Cmd_Argv(1));
  name = COM_DefaultExtension(name, ".sav");

  Con_Printf("Saving game to %s...\n", name);
  const handle = Sys_FileOpenWrite(name);
  if (handle === -1) {
    Con_Printf("ERROR: couldn't open.\n");
    return;
  }
  const f = new SysFileTextWriter(handle);

  f.write(Com_sprintf("%i\n", SAVEGAME_VERSION));
  const comment = Host_SavegameComment();
  f.write(Com_sprintf("%s\n", comment));
  for (let i = 0; i < NUM_SPAWN_PARMS; i++) f.write(Com_sprintf("%f\n", svs.clients[0].spawn_parms[i]));
  f.write(Com_sprintf("%d\n", hostCmdState.current_skill));
  f.write(Com_sprintf("%s\n", sv.name));
  f.write(Com_sprintf("%f\n", sv.time));

  // write the light styles

  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    if (sv.lightstyles[i]) f.write(Com_sprintf("%s\n", sv.lightstyles[i]));
    else f.write("m\n");
  }

  ED_WriteGlobals(f);
  for (let i = 0; i < sv.num_edicts; i++) {
    ED_Write(f, EDICT_NUM(i));
  }
  Sys_FileClose(handle);
  Con_Printf("done.\n");
}

// `fscanf (f, "%i\n" | "%f\n" | "%s\n", ...)`: skip whitespace, take one
// whitespace-delimited token, then consume the whitespace that follows.
class TextScanner {
  data: string;
  index = 0;
  constructor(data: string) {
    this.data = data;
  }
  private skipWhite(): void {
    while (this.index < this.data.length) {
      const c = this.data[this.index];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") this.index++;
      else break;
    }
  }
  scanToken(): string {
    this.skipWhite();
    let out = "";
    while (this.index < this.data.length) {
      const c = this.data[this.index];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") break;
      out += c;
      this.index++;
    }
    this.skipWhite();
    return out;
  }
}

/*
===============
Host_Loadgame_f
===============
*/
export function Host_Loadgame_f(): void {
  const spawn_parms = new Float32Array(NUM_SPAWN_PARMS);

  if (cmdState.source !== CmdSourceT.src_command) return;

  if (Cmd_Argc() !== 2) {
    Con_Printf("load <savename> : load a game\n");
    return;
  }

  hostClientHooks.setClsDemonum?.(-1); // stop demo loop in case this fails

  let name = Com_sprintf("%s/%s", com_gamedir, Cmd_Argv(1));
  name = COM_DefaultExtension(name, ".sav");

  // we can't call SCR_BeginLoadingPlaque, because too much stack space has
  // been used.  The menu calls it before stuffing loadgame command
  //	SCR_BeginLoadingPlaque ();

  Con_Printf("Loading game from %s...\n", name);
  const opened = Sys_FileOpenRead(name);
  if (opened.handle === -1) {
    Con_Printf("ERROR: couldn't open.\n");
    return;
  }
  const bytes = new Uint8Array(opened.length);
  Sys_FileRead(opened.handle, bytes, opened.length);
  Sys_FileClose(opened.handle);
  let contents = "";
  for (let i = 0; i < bytes.length; i++) contents += String.fromCharCode(bytes[i]);
  const scan = new TextScanner(contents);

  const version = Q_atoi(scan.scanToken());
  if (version !== SAVEGAME_VERSION) {
    Con_Printf("Savegame is version %i, not %i\n", version, SAVEGAME_VERSION);
    return;
  }
  scan.scanToken(); // the comment
  for (let i = 0; i < NUM_SPAWN_PARMS; i++) spawn_parms[i] = Q_atof(scan.scanToken());
  // this silliness is so we can load 1.06 save files, which have float skill values
  const tfloat = Q_atof(scan.scanToken());
  hostCmdState.current_skill = Math.trunc(tfloat + 0.1);
  Cvar_SetValue("skill", hostCmdState.current_skill);

  const mapname = scan.scanToken();
  const time = Q_atof(scan.scanToken());

  hostClientHooks.clDisconnectF?.(); // CL_Disconnect_f

  SV_SpawnServer(mapname);
  if (!sv.active) {
    Con_Printf("Couldn't load map\n");
    return;
  }
  sv.paused = true; // pause until all clients connect
  sv.loadgame = true;

  // load the light styles

  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    sv.lightstyles[i] = scan.scanToken();
  }

  // load the edicts out of the savegame file
  let entnum = -1; // -1 is the globals
  while (scan.index < contents.length) {
    let str = "";
    for (;;) {
      if (scan.index >= contents.length) break; // r == EOF
      const r = contents[scan.index++];
      if (r === "\0") break; // !r
      str += r;
      if (r === "}") break;
    }
    const ps: ParseState = { data: str, index: 0 };
    const com_token = COM_Parse(ps) ?? "";
    if (!com_token[0]) break; // end of file
    if (com_token !== "{") Sys_Error("First token isn't a brace");

    if (entnum === -1) {
      // parse the global vars
      ED_ParseGlobals(ps);
    } else {
      // parse an edict

      const ent = EDICT_NUM(entnum);
      ent.fields.i.fill(0); // memset (&ent->v, 0, progs->entityfields * 4)
      ent.free = false;
      ED_ParseEdict(ps, ent);

      // link it into the bsp tree
      if (!ent.free) SV_LinkEdict(ent, false);
    }

    entnum++;
  }

  sv.num_edicts = entnum;
  sv.time = time;

  for (let i = 0; i < NUM_SPAWN_PARMS; i++) svs.clients[0].spawn_parms[i] = spawn_parms[i];

  if (!sysState.isDedicated) {
    hostClientHooks.clEstablishConnection?.("local"); // CL_EstablishConnection
    Host_Reconnect_f();
  }
}

//============================================================================

/*
======================
Host_Name_f
======================
*/
export function Host_Name_f(): void {
  let newName: string;

  if (Cmd_Argc() === 1) {
    Con_Printf('"name" is "%s"\n', hostClientHooks.clNameString?.() ?? ""); // cl_name.string
    return;
  }
  if (Cmd_Argc() === 2) newName = Cmd_Argv(1);
  else newName = Cmd_Args() ?? "";
  newName = newName.slice(0, 15); // newName[15] = 0

  if (cmdState.source === CmdSourceT.src_command) {
    if ((hostClientHooks.clNameString?.() ?? "") === newName) return;
    Cvar_Set("_cl_name", newName);
    if (hostClientHooks.clsStateConnected?.() ?? false) Cmd_ForwardToServer();
    return;
  }

  const host_client = requireHostClient();
  if (host_client.name && host_client.name !== "unconnected")
    if (host_client.name !== newName) Con_Printf("%s renamed to %s\n", host_client.name, newName);
  host_client.name = newName;
  if (host_client.edict === null) Sys_Error("Host_Name_f: client has no edict");
  host_client.edict.v.netname = PR_SetEngineStringRef(host_client, () => host_client.name); // host_client->name - pr_strings

  // send notification to all clients

  MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_updatename);
  MSG_WriteByte(sv.reliable_datagram, svs.clients.indexOf(host_client)); // host_client - svs.clients
  MSG_WriteString(sv.reliable_datagram, host_client.name);
}

export function Host_Version_f(): void {
  Con_Printf("Version %4.2f\n", VERSION);
}

export function Host_Say(teamonly: boolean): void {
  let fromServer = false;

  if (cmdState.source === CmdSourceT.src_command) {
    if (sysState.isDedicated) {
      fromServer = true;
      teamonly = false;
    } else {
      Cmd_ForwardToServer();
      return;
    }
  }

  if (Cmd_Argc() < 2) return;

  const save = svState.host_client;

  let p = Cmd_Args() ?? "";
  // remove quotes if present
  if (p[0] === '"') {
    p = p.slice(1);
    p = p.slice(0, Math.max(0, p.length - 1));
  }

  // turn on color set 1
  let text: string;
  if (!fromServer) {
    if (save === null) Sys_Error("Host_Say: no host_client");
    text = Com_sprintf("%c%s: ", 1, save.name);
  } else text = Com_sprintf("%c<%s> ", 1, hostname.string);

  const j = 64 - 2 - text.length; // -2 for /n and null terminator
  if (p.length > j) p = p.slice(0, j);

  text += p;
  text += "\n";

  for (let k = 0; k < svs.maxclients; k++) {
    const client = svs.clients[k];
    if (!client || !client.active || !client.spawned) continue;
    if (teamplay.value && teamonly && save !== null && client.edict !== null && save.edict !== null && client.edict.v.team !== save.edict.v.team) continue;
    svState.host_client = client;
    SV_ClientPrintf("%s", text);
  }
  svState.host_client = save;

  Sys_Printf("%s", text.slice(1));
}

export function Host_Say_f(): void {
  Host_Say(false);
}

export function Host_Say_Team_f(): void {
  Host_Say(true);
}

export function Host_Tell_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (Cmd_Argc() < 3) return;

  let text = requireHostClient().name;
  text += ": ";

  let p = Cmd_Args() ?? "";

  // remove quotes if present
  if (p[0] === '"') {
    p = p.slice(1);
    p = p.slice(0, Math.max(0, p.length - 1));
  }

  // check length & truncate if necessary
  const j = 64 - 2 - text.length; // -2 for /n and null terminator
  if (p.length > j) p = p.slice(0, j);

  text += p;
  text += "\n";

  const save = svState.host_client;
  for (let k = 0; k < svs.maxclients; k++) {
    const client = svs.clients[k];
    if (!client.active || !client.spawned) continue;
    if (Q_strcasecmp(client.name, Cmd_Argv(1))) continue;
    svState.host_client = client;
    SV_ClientPrintf("%s", text);
    break;
  }
  svState.host_client = save;
}

/*
==================
Host_Color_f
==================
*/
export function Host_Color_f(): void {
  let top: number;
  let bottom: number;

  if (Cmd_Argc() === 1) {
    const clColor = hostClientHooks.clColorValue?.() ?? 0; // cl_color.value
    Con_Printf('"color" is "%i %i"\n', (clColor | 0) >> 4, (clColor | 0) & 0x0f);
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

  const playercolor = top * 16 + bottom;

  if (cmdState.source === CmdSourceT.src_command) {
    Cvar_SetValue("_cl_color", playercolor);
    if (hostClientHooks.clsStateConnected?.() ?? false) Cmd_ForwardToServer();
    return;
  }

  const host_client = requireHostClient();
  host_client.colors = playercolor;
  if (host_client.edict === null) Sys_Error("Host_Color_f: client has no edict");
  host_client.edict.v.team = bottom + 1;

  // send notification to all clients
  MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_updatecolors);
  MSG_WriteByte(sv.reliable_datagram, svs.clients.indexOf(host_client));
  MSG_WriteByte(sv.reliable_datagram, host_client.colors);
}

/*
==================
Host_Kill_f
==================
*/
export function Host_Kill_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  const sv_player = requireSvPlayer();
  if (sv_player.v.health <= 0) {
    SV_ClientPrintf("Can't suicide -- allready dead!\n");
    return;
  }

  globalStruct().time = sv.time;
  globalStruct().self = EDICT_TO_PROG(sv_player);
  PR_ExecuteProgram(globalStruct().ClientKill);
}

/*
==================
Host_Pause_f
==================
*/
export function Host_Pause_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }
  if (!pausable.value) SV_ClientPrintf("Pause not allowed.\n");
  else {
    sv.paused = !sv.paused; // sv.paused ^= 1

    const sv_player = requireSvPlayer();
    if (sv.paused) {
      SV_BroadcastPrintf("%s paused the game\n", PR_GetString(sv_player.v.netname));
    } else {
      SV_BroadcastPrintf("%s unpaused the game\n", PR_GetString(sv_player.v.netname));
    }

    // send notification to all clients
    MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_setpause);
    MSG_WriteByte(sv.reliable_datagram, sv.paused ? 1 : 0);
  }
}

//===========================================================================

/*
==================
Host_PreSpawn_f
==================
*/
export function Host_PreSpawn_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Con_Printf("prespawn is not valid from the console\n");
    return;
  }

  const host_client = requireHostClient();
  if (host_client.spawned) {
    Con_Printf("prespawn not valid -- allready spawned\n");
    return;
  }

  SZ_Write(host_client.message, sv.signon.data, sv.signon.cursize);
  MSG_WriteByte(host_client.message, SvcOpsT.svc_signonnum);
  MSG_WriteByte(host_client.message, 2);
  host_client.sendsignon = true;
}

/*
==================
Host_Spawn_f
==================
*/
export function Host_Spawn_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Con_Printf("spawn is not valid from the console\n");
    return;
  }

  const host_client = requireHostClient();
  if (host_client.spawned) {
    Con_Printf("Spawn not valid -- allready spawned\n");
    return;
  }

  // run the entrance script
  if (sv.loadgame) {
    // loaded games are fully inited allready
    // if this is the last client to be connected, unpause
    sv.paused = false;
  } else {
    // set up the edict
    const ent = host_client.edict;
    if (ent === null) Sys_Error("Host_Spawn_f: client has no edict");

    ent.fields.i.fill(0); // memset (&ent->v, 0, progs->entityfields * 4)
    ent.v.colormap = NUM_FOR_EDICT(ent);
    ent.v.team = (host_client.colors & 15) + 1;
    ent.v.netname = PR_SetEngineStringRef(host_client, () => host_client.name); // host_client->name - pr_strings

    // copy spawn parms out of the client_t

    for (let i = 0; i < NUM_SPAWN_PARMS; i++) globalsF()[GLOBAL_OFS.parm1 + i] = host_client.spawn_parms[i];

    // call the spawn function

    globalStruct().time = sv.time;
    globalStruct().self = EDICT_TO_PROG(requireSvPlayer());
    PR_ExecuteProgram(globalStruct().ClientConnect);

    if (Sys_FloatTime() - (host_client.netconnection === null ? 0 : host_client.netconnection.connecttime) <= sv.time)
      Sys_Printf("%s entered the game\n", host_client.name);

    PR_ExecuteProgram(globalStruct().PutClientInServer);
  }

  // send all current names, colors, and frag counts
  SZ_Clear(host_client.message);

  // send time of update
  MSG_WriteByte(host_client.message, SvcOpsT.svc_time);
  MSG_WriteFloat(host_client.message, sv.time);

  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i];
    MSG_WriteByte(host_client.message, SvcOpsT.svc_updatename);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteString(host_client.message, client.name);
    MSG_WriteByte(host_client.message, SvcOpsT.svc_updatefrags);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteShort(host_client.message, client.old_frags);
    MSG_WriteByte(host_client.message, SvcOpsT.svc_updatecolors);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteByte(host_client.message, client.colors);
  }

  // send all current light styles
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    MSG_WriteByte(host_client.message, SvcOpsT.svc_lightstyle);
    MSG_WriteByte(host_client.message, i);
    MSG_WriteString(host_client.message, sv.lightstyles[i]);
  }

  //
  // send some stats
  //
  MSG_WriteByte(host_client.message, SvcOpsT.svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_TOTALSECRETS);
  MSG_WriteLong(host_client.message, globalStruct().total_secrets);

  MSG_WriteByte(host_client.message, SvcOpsT.svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_TOTALMONSTERS);
  MSG_WriteLong(host_client.message, globalStruct().total_monsters);

  MSG_WriteByte(host_client.message, SvcOpsT.svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_SECRETS);
  MSG_WriteLong(host_client.message, globalStruct().found_secrets);

  MSG_WriteByte(host_client.message, SvcOpsT.svc_updatestat);
  MSG_WriteByte(host_client.message, STAT_MONSTERS);
  MSG_WriteLong(host_client.message, globalStruct().killed_monsters);

  //
  // send a fixangle
  // Never send a roll angle, because savegames can catch the server
  // in a state where it is expecting the client to correct the angle
  // and it won't happen if the game was just loaded, so you wind up
  // with a permanent head tilt
  const ent = EDICT_NUM(1 + svs.clients.indexOf(host_client));
  MSG_WriteByte(host_client.message, SvcOpsT.svc_setangle);
  for (let i = 0; i < 2; i++) MSG_WriteAngle(host_client.message, ent.v.angles[i]);
  MSG_WriteAngle(host_client.message, 0);

  SV_WriteClientdataToMessage(requireSvPlayer(), host_client.message);

  MSG_WriteByte(host_client.message, SvcOpsT.svc_signonnum);
  MSG_WriteByte(host_client.message, 3);
  host_client.sendsignon = true;
}

/*
==================
Host_Begin_f
==================
*/
export function Host_Begin_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Con_Printf("begin is not valid from the console\n");
    return;
  }

  requireHostClient().spawned = true;
}

//===========================================================================

/*
==================
Host_Kick_f

Kicks a user off of the server
==================
*/
export function Host_Kick_f(): void {
  let who: string;
  let message: string | null = null;
  let byNumber = false;

  if (cmdState.source === CmdSourceT.src_command) {
    if (!sv.active) {
      Cmd_ForwardToServer();
      return;
    }
  } else if (globalStruct().deathmatch && !requireHostClient().privileged) return;

  const save = svState.host_client;

  let i: number;
  if (Cmd_Argc() > 2 && Cmd_Argv(1) === "#") {
    i = Math.trunc(Q_atof(Cmd_Argv(2))) - 1;
    if (i < 0 || i >= svs.maxclients) return;
    if (!svs.clients[i].active) return;
    svState.host_client = svs.clients[i];
    byNumber = true;
  } else {
    for (i = 0; i < svs.maxclients; i++) {
      svState.host_client = svs.clients[i];
      if (!svs.clients[i].active) continue;
      if (Q_strcasecmp(svs.clients[i].name, Cmd_Argv(1)) === 0) break;
    }
  }

  if (i < svs.maxclients) {
    if (cmdState.source === CmdSourceT.src_command)
      if (sysState.isDedicated) who = "Console";
      else who = hostClientHooks.clNameString?.() ?? ""; // cl_name.string
    else {
      if (save === null) Sys_Error("Host_Kick_f: no host_client");
      who = save.name;
    }

    // can't kick yourself!
    if (svState.host_client === save) return;

    if (Cmd_Argc() > 2) {
      const args = Cmd_Args() ?? "";
      const ps: ParseState = { data: args, index: 0 };
      COM_Parse(ps);
      let m = ps.index;
      if (byNumber) {
        m++; // skip the #
        while (args[m] === " ") m++; // skip white space
        m += Cmd_Argv(2).length; // skip the number
      }
      while (m < args.length && args[m] === " ") m++;
      message = args.slice(m);
    }
    if (message !== null) SV_ClientPrintf("Kicked by %s: %s\n", who, message);
    else SV_ClientPrintf("Kicked by %s\n", who);
    SV_DropClient(false);
  }

  svState.host_client = save;
}

/*
===============================================================================

DEBUGGING TOOLS

===============================================================================
*/

/*
==================
Host_Give_f
==================
*/
export function Host_Give_f(): void {
  if (cmdState.source === CmdSourceT.src_command) {
    Cmd_ForwardToServer();
    return;
  }

  if (globalStruct().deathmatch && !requireHostClient().privileged) return;

  const t = Cmd_Argv(1);
  const v = Q_atoi(Cmd_Argv(2));
  const sv_player = requireSvPlayer();

  switch (t[0]) {
    case "0":
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      // MED 01/04/97 added hipnotic give stuff
      if (hipnotic) {
        if (t[0] === "6") {
          if (t[1] === "a") sv_player.v.items = (sv_player.v.items | 0) | HIT_PROXIMITY_GUN;
          else sv_player.v.items = (sv_player.v.items | 0) | IT_GRENADE_LAUNCHER;
        } else if (t[0] === "9") sv_player.v.items = (sv_player.v.items | 0) | HIT_LASER_CANNON;
        else if (t[0] === "0") sv_player.v.items = (sv_player.v.items | 0) | HIT_MJOLNIR;
        else if (t[0] >= "2") sv_player.v.items = (sv_player.v.items | 0) | (IT_SHOTGUN << (t.charCodeAt(0) - 0x32));
      } else {
        if (t[0] >= "2") sv_player.v.items = (sv_player.v.items | 0) | (IT_SHOTGUN << (t.charCodeAt(0) - 0x32));
      }
      break;

    case "s": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_shells1");
        if (val !== -1) sv_player.fields.f[val] = v;
      }

      sv_player.v.ammo_shells = v;
      break;
    }
    case "n": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_nails1");
        if (val !== -1) {
          sv_player.fields.f[val] = v;
          if (sv_player.v.weapon <= IT_LIGHTNING) sv_player.v.ammo_nails = v;
        }
      } else {
        sv_player.v.ammo_nails = v;
      }
      break;
    }
    case "l": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_lava_nails");
        if (val !== -1) {
          sv_player.fields.f[val] = v;
          if (sv_player.v.weapon > IT_LIGHTNING) sv_player.v.ammo_nails = v;
        }
      }
      break;
    }
    case "r": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_rockets1");
        if (val !== -1) {
          sv_player.fields.f[val] = v;
          if (sv_player.v.weapon <= IT_LIGHTNING) sv_player.v.ammo_rockets = v;
        }
      } else {
        sv_player.v.ammo_rockets = v;
      }
      break;
    }
    case "m": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_multi_rockets");
        if (val !== -1) {
          sv_player.fields.f[val] = v;
          if (sv_player.v.weapon > IT_LIGHTNING) sv_player.v.ammo_rockets = v;
        }
      }
      break;
    }
    case "h":
      sv_player.v.health = v;
      break;
    case "c": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_cells1");
        if (val !== -1) {
          sv_player.fields.f[val] = v;
          if (sv_player.v.weapon <= IT_LIGHTNING) sv_player.v.ammo_cells = v;
        }
      } else {
        sv_player.v.ammo_cells = v;
      }
      break;
    }
    case "p": {
      if (rogue) {
        const val = GetEdictFieldValue(sv_player, "ammo_plasma");
        if (val !== -1) {
          sv_player.fields.f[val] = v;
          if (sv_player.v.weapon > IT_LIGHTNING) sv_player.v.ammo_cells = v;
        }
      }
      break;
    }
  }
}

export function FindViewthing(): EdictT | null {
  for (let i = 0; i < sv.num_edicts; i++) {
    const e = EDICT_NUM(i);
    if (PR_GetString(e.v.classname) === "viewthing") return e;
  }
  Con_Printf("No viewthing on map\n");
  return null;
}

/*
==================
Host_Viewmodel_f
==================
*/
export function Host_Viewmodel_f(): void {
  const e = FindViewthing();
  if (!e) return;

  const m = Mod_ForName(Cmd_Argv(1), false);
  if (!m) {
    Con_Printf("Can't load %s\n", Cmd_Argv(1));
    return;
  }

  e.v.frame = 0;
  hostClientHooks.setClModelPrecache?.(e.v.modelindex | 0, m); // cl.model_precache[(int)e->v.modelindex] = m
}

/*
==================
Host_Viewframe_f
==================
*/
export function Host_Viewframe_f(): void {
  const e = FindViewthing();
  if (!e) return;
  const m = hostClientHooks.clModelPrecache?.(e.v.modelindex | 0) ?? null;
  if (m === null) return;

  let f = Q_atoi(Cmd_Argv(1));
  if (f >= m.numframes) f = m.numframes - 1;

  e.v.frame = f;
}

// see the file header: the alias frame name lives in renderer-owned data
// (Mod_Extradata -> aliashdr_t), which no landed module can read.
export function PrintFrameName(_m: ModelT, frame: number): void {
  Con_Printf("frame %i\n", frame);
}

/*
==================
Host_Viewnext_f
==================
*/
export function Host_Viewnext_f(): void {
  const e = FindViewthing();
  if (!e) return;
  const m = hostClientHooks.clModelPrecache?.(e.v.modelindex | 0) ?? null;
  if (m === null) return;

  e.v.frame = e.v.frame + 1;
  if (e.v.frame >= m.numframes) e.v.frame = m.numframes - 1;

  PrintFrameName(m, e.v.frame);
}

/*
==================
Host_Viewprev_f
==================
*/
export function Host_Viewprev_f(): void {
  const e = FindViewthing();
  if (!e) return;

  const m = hostClientHooks.clModelPrecache?.(e.v.modelindex | 0) ?? null;
  if (m === null) return;

  e.v.frame = e.v.frame - 1;
  if (e.v.frame < 0) e.v.frame = 0;

  PrintFrameName(m, e.v.frame);
}

/*
===============================================================================

DEMO LOOP CONTROL

===============================================================================
*/

/*
==================
Host_Startdemos_f
==================
*/
export function Host_Startdemos_f(): void {
  if (sysState.isDedicated) {
    if (!sv.active) Cbuf_AddText("map start\n");
    return;
  }

  let c = Cmd_Argc() - 1;
  if (c > MAX_DEMOS) {
    Con_Printf("Max %i demos in demoloop\n", MAX_DEMOS);
    c = MAX_DEMOS;
  }
  Con_Printf("%i demo(s) in loop\n", c);

  for (let i = 1; i < c + 1; i++) hostClientHooks.setClsDemos?.(i - 1, Cmd_Argv(i).slice(0, MAX_DEMONAME - 1));

  if (!sv.active && (hostClientHooks.clsDemonum?.() ?? -1) !== -1 && !(hostClientHooks.clsDemoplayback?.() ?? false)) {
    hostClientHooks.setClsDemonum?.(0);
    hostClientHooks.clNextDemo?.(); // CL_NextDemo
  } else hostClientHooks.setClsDemonum?.(-1);
}

/*
==================
Host_Demos_f

Return to looping demos
==================
*/
export function Host_Demos_f(): void {
  if (sysState.isDedicated) return;
  if ((hostClientHooks.clsDemonum?.() ?? -1) === -1) hostClientHooks.setClsDemonum?.(1);
  hostClientHooks.clDisconnectF?.(); // CL_Disconnect_f
  hostClientHooks.clNextDemo?.(); // CL_NextDemo
}

/*
==================
Host_Stopdemo_f

Return to looping demos
==================
*/
export function Host_Stopdemo_f(): void {
  if (sysState.isDedicated) return;
  if (!(hostClientHooks.clsDemoplayback?.() ?? false)) return;
  hostClientHooks.clStopPlayback?.(); // CL_StopPlayback
  hostClientHooks.clDisconnect?.(); // CL_Disconnect
}

//=============================================================================

/*
==================
Host_InitCommands
==================
*/
export function Host_InitCommands(): void {
  Cmd_AddCommand("status", Host_Status_f);
  Cmd_AddCommand("quit", Host_Quit_f);
  Cmd_AddCommand("god", Host_God_f);
  Cmd_AddCommand("notarget", Host_Notarget_f);
  Cmd_AddCommand("fly", Host_Fly_f);
  Cmd_AddCommand("map", Host_Map_f);
  Cmd_AddCommand("restart", Host_Restart_f);
  Cmd_AddCommand("changelevel", Host_Changelevel_f);
  Cmd_AddCommand("connect", Host_Connect_f);
  Cmd_AddCommand("reconnect", Host_Reconnect_f);
  Cmd_AddCommand("name", Host_Name_f);
  Cmd_AddCommand("noclip", Host_Noclip_f);
  Cmd_AddCommand("version", Host_Version_f);
  Cmd_AddCommand("say", Host_Say_f);
  Cmd_AddCommand("say_team", Host_Say_Team_f);
  Cmd_AddCommand("tell", Host_Tell_f);
  Cmd_AddCommand("color", Host_Color_f);
  Cmd_AddCommand("kill", Host_Kill_f);
  Cmd_AddCommand("pause", Host_Pause_f);
  Cmd_AddCommand("spawn", Host_Spawn_f);
  Cmd_AddCommand("begin", Host_Begin_f);
  Cmd_AddCommand("prespawn", Host_PreSpawn_f);
  Cmd_AddCommand("kick", Host_Kick_f);
  Cmd_AddCommand("ping", Host_Ping_f);
  Cmd_AddCommand("load", Host_Loadgame_f);
  Cmd_AddCommand("save", Host_Savegame_f);
  Cmd_AddCommand("give", Host_Give_f);

  Cmd_AddCommand("startdemos", Host_Startdemos_f);
  Cmd_AddCommand("demos", Host_Demos_f);
  Cmd_AddCommand("stopdemo", Host_Stopdemo_f);

  Cmd_AddCommand("viewmodel", Host_Viewmodel_f);
  Cmd_AddCommand("viewframe", Host_Viewframe_f);
  Cmd_AddCommand("viewnext", Host_Viewnext_f);
  Cmd_AddCommand("viewprev", Host_Viewprev_f);

  Cmd_AddCommand("mcache", Mod_Print);
}
