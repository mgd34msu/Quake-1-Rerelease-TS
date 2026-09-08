/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sv_main.c (GNU GPL v2 or later).

sv_main.c -- server main program

Deviations from PORTING.md / the C source:
- `localmodels[MAX_MODELS][5]` -> `localmodels: string[]`, filled by SV_Init
  exactly as the C's `sprintf (localmodels[i], "*%i", i)` loop does.
- SV_Init also performs the C's `sv.datagram`/`sv.reliable_datagram`/
  `sv.signon` SizeBuf setup (pointing each at its `_buf` backing array,
  `maxsize` = that array's length, `cursize = 0`). In the real C this setup
  lives in SV_SpawnServer, not SV_Init -- but the unit brief's own test list
  requires SV_Init alone to leave the three SizeBufs usable (no QuakeC/BSP
  load needed to exercise SV_StartParticle/SV_StartSound), and `sv.clear()`
  (ServerT.clear(), called by Host_ClearMemory and again by SV_SpawnServer,
  matching the C's own double `memset (&sv, 0, sizeof(sv))`) replaces
  `sv.datagram`/etc. with fresh, unconfigured SizeBuf instances -- so leaving
  this setup only in SV_SpawnServer would leave the buffers permanently
  unusable after the first real level load. `initServerBuffers` below runs
  from both SV_Init and SV_SpawnServer (the latter matching the real C's
  placement) so neither the test brief's requirement nor real multi-level
  play breaks; this is an addition (extra call site), not a removed one.
- `SV_DropClient` (`qboolean crash`) is declared in server.h but defined in
  host.c (U035, not yet landed); confirmed against the C source (`grep` for
  `void SV_DropClient` finds only host.c:343). Ruling (unit brief):
  `svMainHooks.dropClient` is a registrable hook host.ts's own landing
  installs; every call site below calls through the local `SV_DropClient`
  wrapper exactly as the C calls `SV_DropClient(...)` directly, and the
  wrapper Sys_Errors with "SV_DropClient not registered" if host.ts hasn't
  installed it yet. `svMainHooks.scrCenterTimeOff` is the same kind of hook
  for `scr_centertime_off = 0` (screen.c, not yet landed); unlike dropClient
  it has no observable effect on server logic (it only resets a client-side
  center-print timer) so it is a silent no-op hook, matching
  host.ts's own `hostClientHooks` pattern, rather than a fallback error.
- cvar.ts's file header notes it expects sv_main.ts to call
  `setCvarServerHooks` once `sv` and `SV_BroadcastPrintf` exist. `sv.active`
  is available now, but `SV_BroadcastPrintf` is host.c's function (see
  `grep` above: `void SV_BroadcastPrintf` is host.c:297), out of this unit's
  scope and not declared anywhere yet -- this unit does not call
  `setCvarServerHooks`; whichever unit ports host.c's SV_BroadcastPrintf
  should wire it there instead, now that `sv.active` exists.
- `SV_Physics` (sv_phys.c) and `SV_SetIdealPitch` (sv_user.c) are concurrent
  siblings (U032/U033) imported by name per the unit brief; so are the ten
  cvars `SV_Init` registers (`sv_maxvelocity`/`sv_gravity`/`sv_friction`/
  `sv_stopspeed`/`sv_nostep` from sv_phys.ts, `sv_edgefriction`/`sv_maxspeed`/
  `sv_accelerate`/`sv_idealpitchscale` from sv_user.ts, `sv_aim` from
  pr_cmds.ts). If any of `sv_phys.ts`/`sv_user.ts`/`pr_cmds.ts` is absent at
  gate time, `bun run check`'s only failures from this file are "Cannot find
  module './sv_phys'" / "'./sv_user'" / "'../progs/pr_cmds'" and the unbound
  names they would have exported.
- `Host_CheckForNewClients` in SV_CheckForNewClients's `Sys_Error` string is
  a naming mismatch already present in the C source (the function itself is
  `SV_CheckForNewClients`; the error text was never updated when it was
  renamed) -- kept verbatim, exactly as the original.
- `GetEdictFieldValue`'s C signature returns an `eval_t *` (null when the
  field doesn't exist); this port's version (pr_edict.ts, U021) returns the
  field's word offset or `-1`. SV_WriteClientdataToMessage's `items2` lookup
  therefore checks `!== -1` rather than C's `if (val)`, which is the same
  "does this field exist" test through the offset-based ruling.
- `(&pr_global_struct->parm1)[i]` (SV_ConnectClient, SV_SaveSpawnparms) reads
  16 consecutive floats starting at parm1's word offset by pointer
  arithmetic; ported as `pr.globals.f[GLOBAL_OFS.parm1 + i]` through the
  `globalsF()` helper below, since progdefs.ts's `parm1`..`parm16` offsets
  (43..58) are contiguous in the same underlying Float32Array.
- `ent->v.model = sv.worldmodel->name - pr_strings` / `pr_global_struct->
  mapname = sv.name - pr_strings`: PORTING.md's engine string table ruling
  (progs.ts's `PR_SetEngineString`), same as every other C
  pointer-into-pr_strings site in this codebase.
- `current_skill` (host_cmd.c's file-scope `int`, not declared anywhere in
  this port yet) is a local in SV_SpawnServer, matching pr_edict.ts's own
  ED_LoadFromFile ruling: both C assignment sites immediately do
  `Cvar_SetValue ("skill", (float)current_skill)`, so the `skill` cvar holds
  the same value ED_LoadFromFile reads back through `Cvar_VariableValue`.
- The client_t "memset (client, 0, sizeof(*client))" in SV_ConnectClient:
  `ClientT` has no `clear()` (server.ts's own ruling -- client_t is never
  memset wholesale anywhere else in the C). SV_ConnectClient below resets
  every field the C's memset zeroes one at a time, then re-sets
  `netconnection`/`name`/`active`/`spawned`/`edict`/`message.{data,maxsize,
  allowoverflow}`/`privileged` exactly where the C's post-memset lines do.
- `#ifdef IDGODS ... client->privileged = IsID(...); #else client->
  privileged = false; #endif`: IDGODS is never defined in a WinQuake build;
  only the `#else` line survives.
- Dropped `#ifdef QUAKE2` blocks (never defined in a WinQuake build):
  SV_WriteEntitiesToClient's `EF_NODRAW` skip, SV_WriteClientdataToMessage's
  `items2`-via-`ent->v.items2` branch (the non-QUAKE2 `GetEdictFieldValue`
  branch is the one this port runs), SV_SpawnServer's `startspot` parameter
  and `sv.startspot`/`pr_global_struct->startspot` assignments, and
  `SV_SpawnServer`'s QUAKE2-only signature variant (this port keeps the
  single-argument `SV_SpawnServer(server)`).
*/

import { hostCmdState } from "../common/host_cmd";
import { CvarT, Cvar_RegisterVariable, Cvar_Set, Cvar_SetValue } from "../common/cvar";
import { Com_sprintf } from "../common/sprintf";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cmd_ExecuteString, CmdSourceT, cmdState } from "../common/cmd";
import { COM_CheckParm, com_argv, Q_atoi, standard_quake } from "../common/common";
import { coop, deathmatch, host, Host_ClearMemory, Host_MaxEdicts, Host_ShutdownServer, skill } from "../common/host";
import { claimServerProfile, serverProfile, serverShutdownHooks, type NetProfileT } from "../common/profile";
import { hostname, NET_CanSendMessage, NET_CheckNewConnections, NET_SendMessage, NET_SendToAll, NET_SendUnreliableMessage, net_activeconnections, setNetActiveConnections } from "../common/net_main";
import { CONTENTS_SOLID, MAX_MAP_LEAFS } from "../common/bspfile";
import { NET_MAXMESSAGE } from "../common/net";
import { isMleaf, loadState, Mod_ForName, Mod_LeafPVS, type MleafT, type ModelT, type MnodeT } from "../common/model";
import { BSP_WIDTH_29 } from "../common/bspfile";
import { DotProduct, Q_SeedRandom, VectorAdd, VectorCopy, type Vec3, vec3 } from "../common/mathlib";
import { DATAGRAM_MTU, MAX_DATAGRAM, MAX_MODELS, MAX_MSGLEN, MAX_SOUNDS, VERSION } from "../common/quakedef";
import {
  ENTALPHA_DEFAULT,
  ENTALPHA_ENCODE,
  ENTALPHA_ZERO,
  ENTSCALE_DEFAULT,
  ENTSCALE_ENCODE,
  GAME_COOP,
  GAME_DEATHMATCH,
  PROTOCOL_FITZQUAKE,
  PROTOCOL_NETQUAKE,
  PROTOCOL_RMQ,
  SvcOpsT,
  svc_setviews,
} from "../common/protocol";
import { getCodec } from "../common/protocol/registry";
import { ClientdataT, EntityUpdateT, SoundMessageT } from "../common/protocol/codec";
import { MSG_WriteByte, MSG_WriteChar, MSG_WriteFloat, MSG_WriteShort, MSG_WriteString, SZ_Clear, SZ_Write, SizeBuf } from "../common/sizebuf";
import { Sys_Error, SysError, sysState } from "../platform/sys";
import {
  ClientT,
  SIGNON_BUF_NQ15,
  EF_MUZZLEFLASH,
  FL_ONGROUND,
  MOVETYPE_PUSH,
  MOVETYPE_STEP,
  NUM_PING_TIMES,
  NUM_SPAWN_PARMS,
  ServerStateT,
  SOLID_BSP,
  UsercmdT,
  sv,
  svState,
  svs,
} from "./server";
import { SV_ClearWorld } from "./world";
import { GetEdictFieldValue, PR_AllocEdicts, ED_LoadFromFile, PR_LoadProgs } from "../progs/pr_edict";
import { QEX_AfterLoadProgs, QEX_PrintRuleset, QEX_RegisterCvars, SV_EffectsMask } from "../progs/ext/ruleset";
import { QEX_ClearClient, QEX_ClearLevel, QEX_SetClientExFlags } from "../progs/ext/qex";
import { QEX_DebugDrawClear, QEX_DebugDrawExpire, QEX_RegisterDrawCvars } from "../progs/ext/qex_draw";
import { PR_SetProfile } from "../progs/profiles/profile";
import { nqProfile } from "../progs/profiles/nq";
import { PR_ExecuteProgram } from "../progs/pr_exec";
import { E_FLOAT, EDICT_NUM, EDICT_TO_PROG, NUM_FOR_EDICT, PROG_TO_EDICT, PR_GetString, PR_SetEngineString, pr, type EdictT } from "../progs/progs";
import { GLOBAL_OFS, type GlobalVars } from "../progs/progdefs";
import { sv_accelerate, sv_edgefriction, sv_idealpitchscale, sv_maxspeed, SV_SetIdealPitch } from "./sv_user";
import { sv_friction, sv_gravity, sv_maxvelocity, sv_nostep, sv_stopspeed, SV_Physics } from "./sv_phys";
import { sv_aim } from "../progs/pr_cmds";

//============================================================================

// inline model names for precache ("*0".."*255"), filled by SV_Init
export const localmodels: string[] = new Array<string>(MAX_MODELS).fill("");

// see file header: host.c's function, registered here once host.ts (U035)
// lands it. scrCenterTimeOff is screen.c's (not yet landed) `scr_centertime_off
// = 0` poke -- a silent no-op hook, unlike dropClient's Sys_Error fallback.
// `isBot`/`botThink`/`spawnServer` are src/bots's three registration points
// (U20). A bot is a client_t whose `netconnection` is null: SV_SendClientMessages
// below would hand that null socket to NET_SendUnreliableMessage, which answers
// -1 and drops the client, so it has to skip bots outright; SV_RunClients
// (sv_user.ts) has the mirror-image problem with NET_GetMessage and calls
// `botThink` where it would have read the wire. `spawnServer` is one call at the
// end of SV_SpawnServer, where the map's nav file is loaded and every bot is
// put back into the new level.
export const svMainHooks: {
  dropClient: ((crash: boolean) => void) | null;
  scrCenterTimeOff: (() => void) | null;
  isBot: ((client: ClientT) => boolean) | null;
  botThink: ((client: ClientT) => void) | null;
  spawnServer: ((mapname: string) => void) | null;
  /**
   * The mirror of `spawnServer`, called at the top of Host_ShutdownServer:
   * the bot slots come out of svs.clients before that function drops every
   * client and replaces the array, and the roster they were built from is
   * kept so `spawnServer` can put the same bots into the next level.
   */
  shutdownServer: (() => void) | null;
  /** U43: how many LOCAL splitscreen seats the client on this machine is
   *  running (src/client/splitscreen.ts installs it; 1 on a dedicated
   *  server, which has no client at all). Read only by SV_SendServerinfo,
   *  for the svc_setviews byte a loopback client is told. */
  localSeatCount: (() => number) | null;
  /** U43: called where SV_SpawnServer sizes svs.clients, and answers with a
   *  player-slot count a `cl_splitscreen` asked for while the previous server
   *  was still running (0 = nothing held). svs.clients and the player edicts
   *  are sized here and nowhere else, so this is the only point that count can
   *  be applied; see src/client/splitscreen.ts's SS_ServerSpawned. */
  /** Player slots a `cl_splitscreen` asked for before the server that sizes them existed; consumed once. */
  heldClientSlots: (() => number) | null;
  /** The server has just spawned a level: the seats re-arm their signon. */
  serverSpawned: (() => void) | null;
  /** F13: called once per server frame, from SV_CheckForNewClients, before
   *  any new connection is accepted. src/bots installs it so a `bot_count`
   *  raised while the level is running seats bots on the next frame even
   *  when the roster is empty -- the reconcile used to run off the first
   *  bot to think, which never happens when there is no bot to think. */
  serverFrame: (() => void) | null;
  /** F13: the mirror of `spawnServer` at the near end of SV_SpawnServer,
   *  where the ruleset cvars the level is about to be built from are still
   *  changeable. src/bots installs it so a map the retail mapdb.json flags
   *  `horde` spawns in the mode its own spawn points need -- see
   *  src/bots/bot_client.ts's Bot_PrepareLevel. Called before the
   *  `coop`/`deathmatch` consistency rule below, so a mode chosen here goes
   *  through it like any operator's. */
  prepareLevel: ((mapname: string) => void) | null;
} = {
  dropClient: null,
  scrCenterTimeOff: null,
  isBot: null,
  botThink: null,
  spawnServer: null,
  shutdownServer: null,
  localSeatCount: null,
  heldClientSlots: null,
  serverSpawned: null,
  serverFrame: null,
  prepareLevel: null,
};

// U38: the NetQuake half of src/common/profile.ts's one-server-at-a-time
// rule. host.ts's Host_ShutdownServer is the level-scope shutdown -- it drops
// every client and clears sv.active without touching the process.
serverShutdownHooks.nq = (): void => {
  Host_ShutdownServer(false);
};

/** True when this client slot is an engine-driven bot rather than a socket. */
export function SV_ClientIsBot(client: ClientT): boolean {
  return svMainHooks.isBot !== null && svMainHooks.isBot(client);
}

function SV_DropClient(crash: boolean): void {
  if (svMainHooks.dropClient === null) Sys_Error("SV_DropClient not registered");
  svMainHooks.dropClient(crash);
}

function globalStruct(): GlobalVars {
  if (pr.global_struct === null) throw new SysError("sv_main: pr.global_struct not set (PR_LoadProgs not called)");
  return pr.global_struct;
}

function globalsF(): Float32Array {
  if (pr.globals === null) throw new SysError("sv_main: pr.globals not set (PR_LoadProgs not called)");
  return pr.globals.f;
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("sv_main: sv.worldmodel not set");
  return sv.worldmodel;
}

// U3: `sv_protocol` (Ironwail sv_main.c's SV_Protocol_f, here a cvar per this
// engine's brief so it can be set from a config the way every other server
// setting is). `15`, `666`, `999` or `auto`; changes take effect at the next
// map load, exactly as Ironwail's command does.
export const sv_protocol = new CvarT("sv_protocol", "auto", true);

// F13 (addition, no C original): the seed the engine's stdlib rand() runs
// from -- the QuakeC `random()` builtin and SV_MoveToGoal's chase-direction
// roll (mathlib.ts's Q_rand). 0, the default, is WinQuake's unseeded engine:
// Math.random, a different match every run. Any other value pins the stream,
// so a driver that measures play (frags scored, ground covered) measures the
// same match twice. Applied at every SV_SpawnServer, so each `map` restarts
// the sequence from the seed rather than continuing the previous level's;
// `-randseed <n>` sets it from the command line.
export const sv_randomseed = new CvarT("sv_randomseed", "0", false);

// U38 (ARCHITECTURE.md "Unified client and server"): which server tree the
// next `map` spawns -- "nq" (WinQuake's, this file's) or "qw" (QuakeWorld's,
// src/qw/server/). Not in either C tree: each binary has exactly one server.
// Like sv_protocol it takes effect at the next map load, and like sv_protocol
// it is archived, so `-dedicated` plus a config line is a complete way to
// stand up either server. The `-dedicated -qw` command line (what `qwsv`
// passes) is the other way in, and does not go through this cvar at all --
// it never runs this file's SV_Init. src/common/host_cmd.ts's Host_Map_f
// reads it.
export const sv_profile = new CvarT("sv_profile", "", true);

// The profile `sv_profile` names. Empty (its default) means "whichever server
// is running", so a boot that never touches the cvar behaves exactly as it did
// before this cvar existed: `connectionProfile.server` is "nq" on a WinQuake
// boot and "qw" on a `-dedicated -qw` one, and each tree's `map` stays on its
// own server. Both `map` commands consult this -- host_cmd.ts's Host_Map_f
// and src/qw/server/sv_ccmds.ts's SV_Map_f -- so whichever of the two the
// console profile in force resolves to, the map lands on the server the
// operator asked for.
export function SV_WantedProfile(): NetProfileT {
  const wanted = sv_profile.string.trim().toLowerCase();
  if (wanted === "qw" || wanted === "quakeworld" || wanted === "28" || wanted === "29") return "qw";
  if (wanted === "nq" || wanted === "netquake" || wanted === "15" || wanted === "666" || wanted === "999") return "nq";
  return serverProfile();
}

// The codec this session's protocol selects. Never null: getCodec falls back to
// protocol 15, and sv.protocol is only ever one of the three numbers below.
function svCodec() {
  return getCodec(sv.protocol);
}

// What the network layer can actually carry in one message today. Ironwail's
// NET_MAXMESSAGE is 65535 (net.h:37) and its MAX_MSGLEN is 64000, so nothing
// there ever hits this; this port's NET_MAXMESSAGE is still 8192
// (src/common/net.ts, outside this unit's SCOPE), and both send paths copy a
// whole message into a NET_MAXMESSAGE-byte buffer before fragmenting it
// (net_dgrm.ts's Datagram_SendMessage into `sock.sendMessage`, net_loop.ts's
// Loop_SendMessage/Loop_SendUnreliableMessage into the peer's
// `receiveMessage`). Holding every buffer this server fills to that ceiling
// keeps a wide protocol from building a message the net layer would overrun or
// silently drop. When NET_MAXMESSAGE is raised to Ironwail's 65535 this clamp
// stops binding on its own and the codec's own size is what applies.
function netCap(size: number): number {
  return Math.min(size, NET_MAXMESSAGE);
}

// sv.datagram/reliable_datagram/signon SizeBuf setup -- see file header.
// U3: the three `maxsize` values are the CHOSEN PROTOCOL's wire sizes, not the
// buffers' allocated length: the buffers are allocated at quakedef.ts's wide
// MAX_DATAGRAM/MAX_MSGLEN so a 666/999 session can use all of it, while a
// protocol-15 session is held to WinQuake's own 1024/8192 and therefore
// overflows at exactly the byte the seed overflowed at.
function initServerBuffers(): void {
  const codec = svCodec();

  sv.datagram.maxsize = netCap(Math.min(sv.datagram_buf.length, codec.maxDatagram));
  sv.datagram.cursize = 0;
  sv.datagram.data = sv.datagram_buf;

  sv.reliable_datagram.maxsize = netCap(Math.min(sv.reliable_datagram_buf.length, codec.maxDatagram));
  sv.reliable_datagram.cursize = 0;
  sv.reliable_datagram.data = sv.reliable_datagram_buf;

  sv.signon.maxsize = netCap(codec.protocol === PROTOCOL_NETQUAKE ? SIGNON_BUF_NQ15 : sv.signon_buf.length);
  sv.signon.cursize = 0;
  sv.signon.data = sv.signon_buf;
}

// Ironwail keeps the encoded alpha and scale on edict_t itself (`ent->alpha`,
// `ent->scale`, set by ED_ParseEdict and refreshed in SV_WriteEntitiesToClient
// from the QuakeC `alpha`/`scale` fields). src/progs/progs.ts's EdictT is
// outside this unit's SCOPE, so both are read straight off the progs field
// each time they are needed, which is the same value Ironwail's cache holds.
export function SV_EdictAlpha(ent: EdictT): number {
  const ofs = GetEdictFieldValue(ent, "alpha");
  return ofs === -1 ? ENTALPHA_DEFAULT : ENTALPHA_ENCODE(E_FLOAT(ent, ofs));
}

export function SV_EdictScale(ent: EdictT): number {
  const ofs = GetEdictFieldValue(ent, "scale");
  return ofs === -1 ? ENTSCALE_DEFAULT : ENTSCALE_ENCODE(E_FLOAT(ent, ofs));
}

/*
===============
SV_ExFlags_f

`ex_flags <bits>`, a client string command (U9, an addition). NetQuake has no
userinfo, so this is how a client's weapon-auto-switch preference reaches
`ex_CheckPlayerEXFlags` -- src/client/cl_main.ts sends it from the
`cl_weaponswitch` cvar right after `name`/`color` in CL_SignonReply, and
src/server/sv_user.ts allows it through the clc_stringcmd filter. Bits are
quakec/defs.qc:444-445's PEF_CHANGEONLYNEW / PEF_CHANGENEVER.
===============
*/
export function SV_ExFlags_f(): void {
  if (cmdState.source !== CmdSourceT.src_client) return; // console-side: nothing to set
  const host_client = svState.host_client;
  if (host_client === null) return;
  const index = svs.clients.indexOf(host_client);
  if (index < 0) return;
  if (Cmd_Argc() < 2) return;
  QEX_SetClientExFlags(index, Q_atoi(Cmd_Argv(1)));
}

/*
===============
SV_Init
===============
*/
export function SV_Init(): void {
  Cvar_RegisterVariable(sv_maxvelocity);
  Cvar_RegisterVariable(sv_gravity);
  Cvar_RegisterVariable(sv_friction);
  Cvar_RegisterVariable(sv_edgefriction);
  Cvar_RegisterVariable(sv_stopspeed);
  Cvar_RegisterVariable(sv_maxspeed);
  Cvar_RegisterVariable(sv_accelerate);
  Cvar_RegisterVariable(sv_idealpitchscale);
  Cvar_RegisterVariable(sv_aim);
  Cvar_RegisterVariable(sv_nostep);
  Cvar_RegisterVariable(sv_protocol);
  Cvar_RegisterVariable(sv_randomseed);
  {
    const i = COM_CheckParm("-randseed");
    if (i && i < com_argv.length - 1) Cvar_Set("sv_randomseed", com_argv[i + 1]!);
  }
  Cvar_RegisterVariable(sv_profile); // U38, see its own comment
  // U9: the behaviour profile's own cvars, the ones the re-release QuakeC
  // reads or sets, and the debug-draw gate.
  QEX_RegisterCvars();
  QEX_RegisterDrawCvars();
  Cmd_AddCommand("ex_flags", SV_ExFlags_f);

  for (let i = 0; i < MAX_MODELS; i++) localmodels[i] = `*${i}`;

  initServerBuffers(); // see file header's SV_Init deviation note
}

/*
=============================================================================

EVENT MESSAGES

=============================================================================
*/

/*
==================
SV_StartParticle

Make sure the event gets sent to all clients
==================
*/
export function SV_StartParticle(org: Vec3, dir: Vec3, color: number, count: number): void {
  const codec = svCodec();
  if (sv.datagram.cursize > sv.datagram.maxsize - 16) return;

  MSG_WriteByte(sv.datagram, SvcOpsT.svc_particle);
  codec.writeCoord(sv.datagram, org[0], sv.protocolflags);
  codec.writeCoord(sv.datagram, org[1], sv.protocolflags);
  codec.writeCoord(sv.datagram, org[2], sv.protocolflags);
  for (let i = 0; i < 3; i++) {
    let v = dir[i] * 16;
    if (v > 127) v = 127;
    else if (v < -128) v = -128;
    MSG_WriteChar(sv.datagram, v);
  }
  MSG_WriteByte(sv.datagram, count);
  MSG_WriteByte(sv.datagram, color);
}

/*
==================
SV_StartSound

Each entity can have eight independant sound sources, like voice,
weapon, feet, etc.

Channel 0 is an auto-allocate channel, the others override anything
allready running on that entity/channel pair.

An attenuation of 0 will play full volume everywhere in the level.
Larger attenuations will drop off.  (max 4 attenuation)

==================
*/
export function SV_StartSound(entity: EdictT, channel: number, sample: string, volume: number, attenuation: number): void {
  if (volume < 0 || volume > 255) Sys_Error("SV_StartSound: volume = %i", volume);

  if (attenuation < 0 || attenuation > 4) Sys_Error("SV_StartSound: attenuation = %f", attenuation);

  if (channel < 0 || channel > 7) Sys_Error("SV_StartSound: channel = %i", channel);

  // Ironwail's 21-byte headroom: SND_LARGEENTITY/SND_LARGESOUND make the
  // header five bytes longer than WinQuake's, and PRFL_INT32COORD doubles each
  // coordinate. WinQuake's own 16 is kept for protocol 15 so the byte at which
  // a full protocol-15 datagram stops accepting sounds does not move.
  const headroom = sv.protocol === PROTOCOL_NETQUAKE ? 16 : 21;
  if (sv.datagram.cursize > sv.datagram.maxsize - headroom) return;

  // find precache number for sound
  let sound_num = 1;
  for (; sound_num < MAX_SOUNDS && sv.sound_precache[sound_num] !== null; sound_num++) {
    if (sample === sv.sound_precache[sound_num]) break;
  }

  if (sound_num === MAX_SOUNDS || sv.sound_precache[sound_num] === null) {
    Con_Printf("SV_StartSound: %s not precacheed\n", sample);
    return;
  }

  const msg = svStartSoundScratch;
  msg.ent = NUM_FOR_EDICT(entity);
  msg.channel = channel;
  msg.soundNum = sound_num;
  msg.volume = volume;
  msg.attenuation = attenuation;
  for (let i = 0; i < 3; i++) {
    msg.origin[i] = entity.v.origin[i] + 0.5 * (entity.v.mins[i] + entity.v.maxs[i]);
  }

  svCodec().writeSound(sv.datagram, msg, sv.protocolflags);
}

const svStartSoundScratch = new SoundMessageT();

/*
==============================================================================

CLIENT SPAWNING

==============================================================================
*/

/*
================
SV_SendServerinfo

Sends the first message from the server to a connected client.
This will be sent on the initial connection and upon each server load.
================
*/
export function SV_SendServerinfo(client: ClientT): void {
  MSG_WriteByte(client.message, SvcOpsT.svc_print);
  const banner = Com_sprintf("%c\nVERSION %4.2f SERVER (%i CRC)", 2, VERSION, pr.crc);
  MSG_WriteString(client.message, banner);

  const codec = svCodec();

  MSG_WriteByte(client.message, SvcOpsT.svc_serverinfo);
  codec.writeProtocol(client.message, sv.protocolflags); // sv.protocol, plus the PRFL_* word for 999
  MSG_WriteByte(client.message, svs.maxclients);

  if (!coop.value && deathmatch.value) MSG_WriteByte(client.message, GAME_DEATHMATCH);
  else MSG_WriteByte(client.message, GAME_COOP);

  const worldEnt = sv.edicts[0];
  MSG_WriteString(client.message, PR_GetString(worldEnt.v.message));

  // only send the first 256 model and sound precaches if protocol is 15
  for (let i = 1; i < MAX_MODELS; i++) {
    const s = sv.model_precache[i];
    if (s === null) break;
    if (i < codec.maxPrecache) MSG_WriteString(client.message, s);
  }
  MSG_WriteByte(client.message, 0);

  for (let i = 1; i < MAX_SOUNDS; i++) {
    const s = sv.sound_precache[i];
    if (s === null) break;
    if (i < codec.maxPrecache) MSG_WriteString(client.message, s);
  }
  MSG_WriteByte(client.message, 0);

  // send music
  MSG_WriteByte(client.message, SvcOpsT.svc_cdtrack);
  MSG_WriteByte(client.message, worldEnt.v.sounds);
  MSG_WriteByte(client.message, worldEnt.v.sounds);

  // set view
  MSG_WriteByte(client.message, SvcOpsT.svc_setview);
  if (client.edict === null) throw new SysError("SV_SendServerinfo: client has no edict");
  MSG_WriteShort(client.message, NUM_FOR_EDICT(client.edict));

  // U43 (local splitscreen): tell a LOCAL (loopback) client how many local
  // seats this machine is running, so it can tell "one of N views on one
  // screen" from "one of N players on N machines". Our own semantics for the
  // re-release's svc_setviews (45) -- see src/client/splitscreen.ts's header
  // -- sent only to clients on the loopback driver and only when there is
  // more than one seat, so a classic session's byte stream is unchanged and
  // no remote client ever sees an opcode protocol 15 has no room for.
  const localSeats = svMainHooks.localSeatCount?.() ?? 1;
  if (localSeats > 1 && client.netconnection !== null && client.netconnection.address === "LOCAL") {
    MSG_WriteByte(client.message, svc_setviews);
    MSG_WriteByte(client.message, localSeats);
  }

  MSG_WriteByte(client.message, SvcOpsT.svc_signonnum);
  MSG_WriteByte(client.message, 1);

  client.sendsignon = true;
  client.spawned = false; // need prespawn, spawn, etc
}

/*
================
SV_ConnectClient

Initializes a client_t for a new net connection.  This will only be called
once for a player each game, not once for each level change.
================
*/
export function SV_ConnectClient(clientnum: number): void {
  const client = svs.clients[clientnum];

  Con_DPrintf("Client %s connected\n", client.netconnection === null ? "" : client.netconnection.address);

  const edictnum = clientnum + 1;

  const ent = EDICT_NUM(edictnum);

  // set up the client_t
  const netconnection = client.netconnection;
  // A wide session fragments reliables at its codec's datagram size
  // (Ironwail's MAX_DATAGRAM); protocol 15 keeps WinQuake's 1024.
  if (netconnection !== null) netconnection.fragmentSize = svCodec().maxDatagram;

  const spawn_parms = sv.loadgame ? client.spawn_parms.slice() : null;

  // memset (client, 0, sizeof(*client)) -- see file header's ClientT deviation note
  client.active = false;
  client.spawned = false;
  client.dropasap = false;
  client.privileged = false;
  client.sendsignon = false;
  client.last_message = 0;
  client.netconnection = null;
  client.cmd = new UsercmdT();
  client.wishdir = vec3();
  client.message = new SizeBuf();
  client.msgbuf = new Uint8Array(MAX_MSGLEN);
  client.edict = null;
  client.name = "";
  client.colors = 0;
  client.ping_times = new Float32Array(NUM_PING_TIMES);
  client.num_pings = 0;
  client.spawn_parms = new Float32Array(NUM_SPAWN_PARMS);
  client.old_frags = 0;

  client.netconnection = netconnection;

  QEX_ClearClient(clientnum); // U9: the client's ex_flags word and finale state

  client.name = "unconnected";
  client.active = true;
  client.spawned = false;
  client.edict = ent;
  client.message.data = client.msgbuf;
  // U3: `sizeof(client->msgbuf)` in the C, where msgbuf is MAX_MSGLEN bytes.
  // Here msgbuf is allocated at the wide MAX_MSGLEN and the session's codec
  // narrows the usable size, so protocol 15 overflows at WinQuake's own 8000.
  client.message.maxsize = netCap(Math.min(client.msgbuf.length, svCodec().maxMsglen));
  client.message.allowoverflow = true; // we can catch it

  // #ifdef IDGODS ... #else: IDGODS is never defined in a WinQuake build
  client.privileged = false;

  if (sv.loadgame && spawn_parms !== null) {
    client.spawn_parms = spawn_parms;
  } else {
    // call the progs to get default spawn parms for the new client
    PR_ExecuteProgram(globalStruct().SetNewParms);
    for (let i = 0; i < NUM_SPAWN_PARMS; i++) client.spawn_parms[i] = globalsF()[GLOBAL_OFS.parm1 + i];
  }

  SV_SendServerinfo(client);
}

/*
===================
SV_CheckForNewClients

===================
*/
export function SV_CheckForNewClients(): void {
  if (svMainHooks.serverFrame !== null) svMainHooks.serverFrame();

  // check for new connections
  for (;;) {
    const ret = NET_CheckNewConnections();
    if (!ret) break;

    // init a new client structure
    let i = 0;
    for (; i < svs.maxclients; i++) if (!svs.clients[i].active) break;
    if (i === svs.maxclients) Sys_Error("Host_CheckForNewClients: no free clients"); // see file header

    svs.clients[i].netconnection = ret;
    SV_ConnectClient(i);

    setNetActiveConnections(net_activeconnections + 1);
  }
}

/*
===============================================================================

FRAME UPDATES

===============================================================================
*/

/*
==================
SV_ClearDatagram

==================
*/
export function SV_ClearDatagram(): void {
  SZ_Clear(sv.datagram);
}

/*
=============================================================================

The PVS must include a small area around the client to allow head bobbing
or other small motion on the client side.  Otherwise, a bob might cause an
entity that should be visible to not show up, especially when the bob
crosses a waterline.

=============================================================================
*/

let fatbytes = 0;
const fatpvs = new Uint8Array(MAX_MAP_LEAFS / 8);

export function SV_AddToFatPVS(org: Vec3, nodeIn: MnodeT | MleafT): void {
  let node = nodeIn;
  for (;;) {
    // if this is a leaf, accumulate the pvs bits
    if (isMleaf(node)) {
      if (node.contents !== CONTENTS_SOLID) {
        const pvs = Mod_LeafPVS(node, requireWorldmodel());
        for (let i = 0; i < fatbytes; i++) fatpvs[i] |= pvs[i];
      }
      return;
    }

    const plane = node.plane;
    if (plane === null) throw new SysError("SV_AddToFatPVS: node has no plane");
    const d = DotProduct(org, plane.normal) - plane.dist;
    if (d > 8) {
      const child = node.children[0];
      if (child === null) throw new SysError("SV_AddToFatPVS: node has no front child");
      node = child;
    } else if (d < -8) {
      const child = node.children[1];
      if (child === null) throw new SysError("SV_AddToFatPVS: node has no back child");
      node = child;
    } else {
      // go down both
      const front = node.children[0];
      if (front !== null) SV_AddToFatPVS(org, front);
      const back = node.children[1];
      if (back === null) throw new SysError("SV_AddToFatPVS: node has no back child");
      node = back;
    }
  }
}

/*
=============
SV_FatPVS

Calculates a PVS that is the inclusive or of all leafs within 8 pixels of the
given point.
=============
*/
export function SV_FatPVS(org: Vec3): Uint8Array {
  const worldmodel = requireWorldmodel();
  fatbytes = (worldmodel.numleafs + 31) >> 3;
  fatpvs.fill(0, 0, fatbytes); // Q_memset (fatpvs, 0, fatbytes)
  SV_AddToFatPVS(org, worldmodel.nodes[0]);
  return fatpvs;
}

/*
=============
SV_WriteEntitiesToClient

=============
*/
// One reused snapshot; SV_WriteEntitiesToClient fills it per entity and hands
// it to the codec, so nothing is allocated per entity per frame.
const svEntityUpdateScratch = new EntityUpdateT();

export function SV_WriteEntitiesToClient(clent: EdictT, msg: SizeBuf): void {
  const codec = svCodec();
  const wide = sv.protocol !== PROTOCOL_NETQUAKE;

  // find the client's PVS
  const org = vec3();
  VectorAdd(clent.v.origin, clent.v.view_ofs, org);
  const pvs = SV_FatPVS(org);

  // send over all entities (excpet the client) that touch the pvs
  for (let e = 1; e < sv.num_edicts; e++) {
    const ent = sv.edicts[e];

    // ignore if not touching a PV leaf
    if (ent !== clent) {
      // clent is ALLWAYS sent
      // ignore ents without visible models
      if (!ent.v.modelindex || PR_GetString(ent.v.model) === "") continue;

      let i = 0;
      for (; i < ent.num_leafs; i++) {
        if (pvs[ent.leafnums[i] >> 3] & (1 << (ent.leafnums[i] & 7))) break;
      }

      if (i === ent.num_leafs) continue; // not visible
    }

    // Ironwail reserves 16 bytes here too; a wide update's worst case (four
    // bit bytes, a short entity number, three 4-byte coords, three 2-byte
    // angles, alpha, scale, frame2, model2, lerpfinish) needs 32.
    if (msg.maxsize - msg.cursize < (wide ? 32 : 16)) {
      Con_Printf("packet overflow\n");
      return;
    }

    const u = svEntityUpdateScratch;
    VectorCopy(ent.v.origin, u.origin);
    VectorCopy(ent.v.angles, u.angles);
    // The QuakeC values go in unrounded: every comparison below is against a
    // baseline the C compares the same raw float against, and every write
    // truncates in MSG_Write*/`& 0xFF00` exactly as the C's `(int)` cast does.
    u.modelindex = ent.v.modelindex;
    u.frame = ent.v.frame;
    u.colormap = ent.v.colormap;
    u.skin = ent.v.skin;
    // U9: Ironwail's `qcvm->effects_mask` (Quake/sv_main.c:857, :870, :929):
    // the EF_QEX_* bits only reach the wire when the loaded progs declares
    // them, so a mod that reuses bit 32 is not read as a colored dynlight.
    u.effects = (ent.v.effects | 0) & SV_EffectsMask();
    u.movetypeStep = ent.v.movetype === MOVETYPE_STEP;
    u.baseline = ent.baseline;

    if (wide) {
      // johnfitz -- alpha. Protocol 15 leaves alpha and scale at their
      // defaults so its bits and bytes are exactly what the seed produced;
      // Ironwail runs this on every protocol, but its protocol-15 output is
      // already not byte-identical to WinQuake's (see sizebuf.ts's header).
      u.alpha = SV_EdictAlpha(ent);

      // don't send invisible entities unless they have effects
      if (u.alpha === ENTALPHA_ZERO && !u.effects) continue;

      u.scale = SV_EdictScale(ent);

      // johnfitz -- capture the interval to nextthink and send it to the
      // client for better lerp timing, but only if the interval is not 0.1
      // (which the client assumes). The gate itself (`ent.sendinterval`) is
      // SV_Physics's, computed once per entity per frame from
      // `oldthinktime`/`oldframe` (sv_phys.ts, sv_phys.c:1283-1289); this
      // site only recomputes the wire quantity Ironwail's sv_main.c does at
      // write time, `nextthink - sv.time` (sv_main.c:952).
      u.sendinterval = ent.sendinterval;
      u.lerpfinish = ent.sendinterval ? ent.v.nextthink - sv.time : 0;
    } else {
      u.alpha = ENTALPHA_DEFAULT;
      u.scale = ENTSCALE_DEFAULT;
      u.sendinterval = false;
      u.lerpfinish = 0;
    }

    codec.writeEntityUpdate(msg, e, u, sv.protocolflags);
  }
}

/*
=============
SV_CleanupEnts

=============
*/
export function SV_CleanupEnts(): void {
  for (let e = 1; e < sv.num_edicts; e++) {
    const ent = sv.edicts[e];
    ent.v.effects = (ent.v.effects | 0) & ~EF_MUZZLEFLASH;
  }
}

/*
==================
SV_WriteClientdataToMessage

==================
*/
const svClientdataScratch = new ClientdataT();

export function SV_WriteClientdataToMessage(ent: EdictT, msg: SizeBuf): void {
  const codec = svCodec();

  // send a damage message
  if (ent.v.dmg_take || ent.v.dmg_save) {
    const other = PROG_TO_EDICT(ent.v.dmg_inflictor);
    MSG_WriteByte(msg, SvcOpsT.svc_damage);
    MSG_WriteByte(msg, ent.v.dmg_save);
    MSG_WriteByte(msg, ent.v.dmg_take);
    for (let i = 0; i < 3; i++) codec.writeCoord(msg, other.v.origin[i] + 0.5 * (other.v.mins[i] + other.v.maxs[i]), sv.protocolflags);

    ent.v.dmg_take = 0;
    ent.v.dmg_save = 0;
  }

  // send the current viewpos offset from the view entity
  SV_SetIdealPitch(); // how much to look up / down ideally

  // a fixangle might get lost in a dropped packet.  Oh well.
  if (ent.v.fixangle) {
    MSG_WriteByte(msg, SvcOpsT.svc_setangle);
    for (let i = 0; i < 3; i++) codec.writeAngle(msg, ent.v.angles[i], sv.protocolflags);
    ent.v.fixangle = 0;
  }

  // stuff the sigil bits into the high bits of items for sbar, or else
  // mix in items2 (non-QUAKE2 branch: the port has no `items2` entvars_t
  // field, so the C's `#else` half, GetEdictFieldValue, is the one that runs)
  const items2Ofs = GetEdictFieldValue(ent, "items2");
  let items: number;
  if (items2Ofs !== -1) {
    items = (ent.v.items | 0) | ((E_FLOAT(ent, items2Ofs) | 0) << 23);
  } else {
    items = (ent.v.items | 0) | ((globalStruct().serverflags | 0) << 28);
  }

  const cd = svClientdataScratch;
  cd.viewheight = ent.v.view_ofs[2];
  cd.idealpitch = ent.v.idealpitch;
  VectorCopy(ent.v.punchangle, cd.punchangle);
  VectorCopy(ent.v.velocity, cd.velocity);
  cd.items = items;
  cd.onground = ((ent.v.flags | 0) & FL_ONGROUND) !== 0;
  cd.inwater = ent.v.waterlevel >= 2;
  cd.weaponframe = ent.v.weaponframe;
  cd.armorvalue = ent.v.armorvalue;
  cd.weaponmodelindex = SV_ModelIndex(PR_GetString(ent.v.weaponmodel));
  cd.health = ent.v.health;
  cd.currentammo = ent.v.currentammo;
  cd.ammo_shells = ent.v.ammo_shells;
  cd.ammo_nails = ent.v.ammo_nails;
  cd.ammo_rockets = ent.v.ammo_rockets;
  cd.ammo_cells = ent.v.ammo_cells;
  cd.weapon = ent.v.weapon;
  cd.standardQuake = standard_quake;
  cd.alpha = sv.protocol === PROTOCOL_NETQUAKE ? ENTALPHA_DEFAULT : SV_EdictAlpha(ent);

  codec.writeClientdata(msg, cd, sv.protocolflags);
}

/*
=======================
SV_SendClientDatagram
=======================
*/
const svDatagramBuf = new Uint8Array(MAX_DATAGRAM);

export function SV_SendClientDatagram(client: ClientT): boolean {
  const msg = new SizeBuf();

  msg.data = svDatagramBuf;
  msg.maxsize = netCap(Math.min(svDatagramBuf.length, svCodec().maxDatagram));
  msg.cursize = 0;

  // johnfitz -- if the client is nonlocal, use a smaller max size so packets
  // aren't fragmented (Ironwail sv_main.c's SV_SendClientDatagram). A local
  // (loopback) client has no MTU at all, so it keeps the codec's full size.
  const address = client.netconnection === null ? "" : client.netconnection.address;
  if (address !== "LOCAL" && msg.maxsize > DATAGRAM_MTU) msg.maxsize = DATAGRAM_MTU;

  MSG_WriteByte(msg, SvcOpsT.svc_time);
  MSG_WriteFloat(msg, sv.time);

  // add the client specific data to the datagram
  if (client.edict === null) throw new SysError("SV_SendClientDatagram: client has no edict");
  SV_WriteClientdataToMessage(client.edict, msg);

  SV_WriteEntitiesToClient(client.edict, msg);

  // copy the server datagram if there is space
  if (msg.cursize + sv.datagram.cursize < msg.maxsize) SZ_Write(msg, sv.datagram.data, sv.datagram.cursize);

  // send the datagram
  if (NET_SendUnreliableMessage(client.netconnection, msg) === -1) {
    SV_DropClient(true); // if the message couldn't send, kick off
    return false;
  }

  return true;
}

/*
=======================
SV_UpdateToReliableMessages
=======================
*/
export function SV_UpdateToReliableMessages(): void {
  // check for changes to be sent over the reliable streams
  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;
    if (host_client.edict === null) throw new SysError("SV_UpdateToReliableMessages: client has no edict");

    if (host_client.old_frags !== host_client.edict.v.frags) {
      for (let j = 0; j < svs.maxclients; j++) {
        const client = svs.clients[j];
        if (!client.active) continue;
        MSG_WriteByte(client.message, SvcOpsT.svc_updatefrags);
        MSG_WriteByte(client.message, i);
        MSG_WriteShort(client.message, host_client.edict.v.frags);
      }

      host_client.old_frags = host_client.edict.v.frags | 0; // client_t's old_frags is `int` (server.h:108)
    }
  }

  for (let j = 0; j < svs.maxclients; j++) {
    const client = svs.clients[j];
    if (!client.active) continue;
    SZ_Write(client.message, sv.reliable_datagram.data, sv.reliable_datagram.cursize);
  }

  SZ_Clear(sv.reliable_datagram);
}

/*
=======================
SV_SendNop

Send a nop message without trashing or sending the accumulated client
message buffer
=======================
*/
export function SV_SendNop(client: ClientT): void {
  const buf = new Uint8Array(4);
  const msg = new SizeBuf();

  msg.data = buf;
  msg.maxsize = buf.length;
  msg.cursize = 0;

  MSG_WriteChar(msg, SvcOpsT.svc_nop);

  if (NET_SendUnreliableMessage(client.netconnection, msg) === -1) SV_DropClient(true); // if the message couldn't send, kick off
  client.last_message = host.realtime;
}

/*
=======================
SV_SendClientMessages
=======================
*/
export function SV_SendClientMessages(): void {
  // U9: the `ex_draw_*` shapes the QuakeC recorded this frame stop being drawn
  // once their lifetime has run out (a lifetime of 0 means "this frame only").
  QEX_DebugDrawExpire(sv.time);

  // update frags, names, etc
  SV_UpdateToReliableMessages();

  // build individual updates
  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;

    if (!host_client.active) continue;

    // A bot has no socket to send to, and every send below would answer -1
    // and drop it. Nothing it needs is on the wire: its view is produced
    // inside the process.
    if (SV_ClientIsBot(host_client)) continue;

    if (host_client.spawned) {
      if (!SV_SendClientDatagram(host_client)) continue;
    } else {
      // the player isn't totally in the game yet
      // send small keepalive messages if too much time has passed
      // send a full message when the next signon stage has been requested
      // some other message data (name changes, etc) may accumulate
      // between signon stages
      if (!host_client.sendsignon) {
        if (host.realtime - host_client.last_message > 5) SV_SendNop(host_client);
        continue; // don't send out non-signon messages
      }
    }

    // check for an overflowed message.  Should only happen
    // on a very fucked up connection that backs up a lot, then
    // changes level
    if (host_client.message.overflowed) {
      SV_DropClient(true);
      host_client.message.overflowed = false;
      continue;
    }

    if (host_client.message.cursize || host_client.dropasap) {
      if (!NET_CanSendMessage(host_client.netconnection)) {
        continue;
      }

      if (host_client.dropasap) {
        SV_DropClient(false); // went to another level
      } else {
        if (NET_SendMessage(host_client.netconnection, host_client.message) === -1) SV_DropClient(true); // if the message couldn't send, kick off
        SZ_Clear(host_client.message);
        host_client.last_message = host.realtime;
        host_client.sendsignon = false;
      }
    }
  }

  // clear muzzle flashes
  SV_CleanupEnts();
}

/*
==============================================================================

SERVER SPAWNING

==============================================================================
*/

/*
================
SV_ModelIndex

================
*/
export function SV_ModelIndex(name: string): number {
  if (name === "") return 0;

  let i = 0;
  for (; i < MAX_MODELS && sv.model_precache[i] !== null; i++) if (sv.model_precache[i] === name) return i;
  if (i === MAX_MODELS || sv.model_precache[i] === null) Sys_Error("SV_ModelIndex: model %s not precached", name);
  return i;
}

/*
================
SV_CreateBaseline

================
*/
export function SV_CreateBaseline(): void {
  const codec = svCodec();
  const rmq = sv.protocol === PROTOCOL_RMQ;

  for (let entnum = 0; entnum < sv.num_edicts; entnum++) {
    // get the current server version
    const svent = sv.edicts[entnum]; // EDICT_NUM(entnum)
    if (svent.free) continue;
    if (entnum > svs.maxclients && !svent.v.modelindex) continue;

    // create entity baseline
    VectorCopy(svent.v.origin, svent.baseline.origin);
    VectorCopy(svent.v.angles, svent.baseline.angles);
    // entity_state_t's frame/skin are `int` (quakedef.h:224-225), so the C
    // truncates the QuakeC float on the way in.
    svent.baseline.frame = svent.v.frame | 0;
    svent.baseline.skin = svent.v.skin | 0;
    if (entnum > 0 && entnum <= svs.maxclients) {
      svent.baseline.colormap = entnum;
      svent.baseline.modelindex = SV_ModelIndex("progs/player.mdl");
      svent.baseline.alpha = ENTALPHA_DEFAULT; // johnfitz -- alpha support
      svent.baseline.scale = ENTSCALE_DEFAULT;
    } else {
      svent.baseline.colormap = 0;
      svent.baseline.modelindex = SV_ModelIndex(PR_GetString(svent.v.model));
      svent.baseline.alpha = sv.protocol === PROTOCOL_NETQUAKE ? ENTALPHA_DEFAULT : SV_EdictAlpha(svent);
      svent.baseline.scale = rmq ? SV_EdictScale(svent) : ENTSCALE_DEFAULT;
    }

    // add to the message. nq15's writeBaseline normalizes a modelindex or
    // frame that will not fit in a byte before it writes, which is what keeps
    // the client's baseline and the server's in agreement on protocol 15.
    codec.writeBaseline(sv.signon, entnum, svent.baseline, sv.protocolflags);
  }
}

/*
================
SV_SendReconnect

Tell all the clients that the server is changing levels
================
*/
export function SV_SendReconnect(): void {
  const data = new Uint8Array(128);
  const msg = new SizeBuf();

  msg.data = data;
  msg.cursize = 0;
  msg.maxsize = data.length;

  MSG_WriteChar(msg, SvcOpsT.svc_stufftext);
  MSG_WriteString(msg, "reconnect\n");
  NET_SendToAll(msg, 5);

  // ruling: `cls.state != ca_dedicated` -> `!sysState.isDedicated` (see file header/unit brief)
  if (!sysState.isDedicated) Cmd_ExecuteString("reconnect\n", CmdSourceT.src_command);
}

/*
================
SV_SaveSpawnparms

Grabs the current state of each client for saving across the
transition to another level
================
*/
export function SV_SaveSpawnparms(): void {
  svs.serverflags = globalStruct().serverflags;

  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;

    if (!host_client.active) continue;

    // call the progs to get default spawn parms for the new client
    if (host_client.edict === null) throw new SysError("SV_SaveSpawnparms: client has no edict");
    globalStruct().self = EDICT_TO_PROG(host_client.edict);
    PR_ExecuteProgram(globalStruct().SetChangeParms);
    for (let j = 0; j < NUM_SPAWN_PARMS; j++) host_client.spawn_parms[j] = globalsF()[GLOBAL_OFS.parm1 + j];
  }
}

/*
================
SV_ChooseProtocol

`sv_protocol` is `15`, `666`, `999` or `auto`. Ironwail's own SV_Protocol_f has
no `auto`; this engine's default is `auto` (ARCHITECTURE.md "Protocol layer"),
which never picks 15 -- 15 is only ever chosen by asking for it -- and picks
999 when the map needs width:

  * the map is BSP2 or 2PSB (its lump indices are 32-bit, so it is a map built
    past BSP29's limits and its coordinates routinely leave +-4096), or
  * any worldmodel bound is outside +-4096, which is the range protocol 15 and
    666's 13.3 fixed-point coordinates can address, or
  * the map's entity lump holds more than 600 entities (WinQuake's MAX_EDICTS).

else 666.

The count is taken from the entity lump rather than from `sv.num_edicts` after
the spawn functions run, because PF_makestatic and PF_ambientsound write into
the signon buffer from inside ED_LoadFromFile and therefore need the protocol
already fixed. ED_LoadFromFile creates exactly one edict per entity block, so
the lump count is the spawn count before any QuakeC-created entity.
================
*/
const AUTO_EXTENT = 4096; // protocol 15/666's 13.3 fixed-point coordinate range
const AUTO_EDICTS = 600; // WinQuake's MAX_EDICTS

// Entity blocks in a map's entity lump: `{` at the top level, outside strings.
export function SV_CountEntityLump(entities: string): number {
  let count = 0;
  let inQuote = false;
  for (let i = 0; i < entities.length; i++) {
    const c = entities[i];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && c === "{") count++;
  }
  return count;
}

export function SV_AutoProtocol(worldmodel: ModelT, bspWidth: number): number {
  if (bspWidth !== BSP_WIDTH_29) return PROTOCOL_RMQ;

  for (let i = 0; i < 3; i++) {
    if (worldmodel.mins[i] < -AUTO_EXTENT || worldmodel.maxs[i] > AUTO_EXTENT) return PROTOCOL_RMQ;
  }

  if (SV_CountEntityLump(worldmodel.entities ?? "") + svs.maxclients + 1 > AUTO_EDICTS) return PROTOCOL_RMQ;

  return PROTOCOL_FITZQUAKE;
}

export function SV_ChooseProtocol(worldmodel: ModelT, bspWidth: number): number {
  const requested = sv_protocol.string.trim().toLowerCase();
  switch (requested) {
    case "15":
      return PROTOCOL_NETQUAKE;
    case "666":
      return PROTOCOL_FITZQUAKE;
    case "999":
      return PROTOCOL_RMQ;
    case "auto":
      return SV_AutoProtocol(worldmodel, bspWidth);
    default:
      Con_Printf("sv_protocol must be 15, 666, 999 or auto\n");
      return SV_AutoProtocol(worldmodel, bspWidth);
  }
}

/*
================
SV_ProtocolTooNarrow

`sv_protocol 15` is the one setting that can ask for a protocol the map is out
of reach of: 15's coordinates are 13.3 fixed point, so a world built past
BSP29's limits (BSP2/2PSB) or whose bounds leave +-4096 cannot be addressed on
it at all, and serving it anyway puts every entity in the level at a wrapped
position. `auto` never picks 15 and the other two settings widen rather than
narrow (SV_AutoProtocol's own comment), so this asks only about 15.
================
*/
export function SV_ProtocolTooNarrow(protocol: number, worldmodel: ModelT, bspWidth: number): boolean {
  if (protocol !== PROTOCOL_NETQUAKE) return false;
  if (bspWidth !== BSP_WIDTH_29) return true;

  for (let i = 0; i < 3; i++) {
    if (worldmodel.mins[i] < -AUTO_EXTENT || worldmodel.maxs[i] > AUTO_EXTENT) return true;
  }

  return false;
}

// sv.protocol + sv.protocolflags + the three staging buffers' wire sizes, and
// the console line that says which protocol this map is being served on.
function SV_SetProtocol(protocol: number): void {
  sv.protocol = protocol;
  const codec = getCodec(protocol);
  sv.protocolflags = codec.defaultFlags;
  initServerBuffers();
  Con_Printf("Server protocol %i (flags 0x%x)\n", sv.protocol, sv.protocolflags);
}

/*
================
SV_SpawnServer

This is called at the start of each level
================
*/
export function SV_SpawnServer(server: string): void {
  // U38 (ARCHITECTURE.md "Unified client and server"): one process, one
  // server. `map` under the NetQuake profile takes any QuakeWorld server
  // this process is running down first and publishes "nq" as
  // `connectionProfile.server`, which is what the console-source profile
  // (src/common/cmd.ts) and `sv.profile` below both read.
  claimServerProfile("nq");

  // let's not have any servers with no name
  if (hostname.string === "") Cvar_Set("hostname", "UNNAMED");
  if (svMainHooks.scrCenterTimeOff) svMainHooks.scrCenterTimeOff(); // scr_centertime_off = 0

  Con_DPrintf("SpawnServer: %s\n", server);
  svs.changelevel_issued = false; // now safe to issue another

  // tell all connected clients that we are going to a new level
  if (sv.active) SV_SendReconnect();
  // A client kept across the change has just been told to reconnect and gets
  // its svc_serverinfo from the loop at the end of this function; until then
  // it is not spawned in the new level. WinQuake left `spawned` set here
  // because nothing wrote player information during a spawn; this port's bots
  // do -- the prepareLevel/spawnServer hooks re-seat them, with QC prints and
  // svc_updatename/svc_updatecolors to every spawned client -- and a kept
  // client that has already reset on the reconnect (cl.maxclients 0) would
  // read those ahead of its serverinfo and Host_Error. Host_Spawn_f re-sends
  // every slot's name, frags and colours once the client spawns again.
  for (let i = 0; i < svs.maxclients; i++) {
    const kept = svs.clients[i];
    if (!kept.active) continue;
    kept.spawned = false;
    // Reliable bytes the old level queued for this client but could not send
    // yet (the loopback carries one reliable message at a time, so a bot
    // seated in the frame a level change was ordered can leave its
    // svc_updatename/svc_updatecolors waiting here) would precede the new
    // serverinfo in the buffer; the client, wiped for the reconnect
    // (Host_ClearMemory), has no scoreboard to put them in and aborts. Nothing
    // in that backlog outlives the level: the signon and Host_Spawn_f rebuild
    // every name, frag and colour. An addition over WinQuake, whose loopback
    // never held a message back across a frame.
    SZ_Clear(kept.message);
  }

  // make cvars consistant
  if (svMainHooks.prepareLevel !== null) svMainHooks.prepareLevel(server);
  if (coop.value) Cvar_SetValue("deathmatch", 0);
  hostCmdState.current_skill = Math.trunc(skill.value + 0.5);
  if (hostCmdState.current_skill < 0) hostCmdState.current_skill = 0;
  if (hostCmdState.current_skill > 3) hostCmdState.current_skill = 3;

  Cvar_SetValue("skill", hostCmdState.current_skill);

  // F13: every level starts the random sequence from the seed, so the same
  // seed replays the same map. See sv_randomseed's own comment.
  Q_SeedRandom(sv_randomseed.value);

  // set up the new server
  Host_ClearMemory();

  sv.clear(); // memset (&sv, 0, sizeof(sv)) -- see file header (Host_ClearMemory already does this; kept for fidelity, matching the C's own double memset)

  sv.profile = "nq"; // U38, see the claimServerProfile call above

  sv.name = server;

  // load progs to get entity field count
  PR_SetProfile(nqProfile); // this binary's QuakeC host profile (ARCHITECTURE.md, "Core model")
  PR_LoadProgs();

  // U9: the behaviour profile is a property of the progs that just loaded, and
  // everything the re-release expects the engine to own (the effects mask, the
  // `cheats_allowed`/`campaign` globals, the loc table the `$key` prints
  // resolve through) follows from it.
  QEX_AfterLoadProgs();
  QEX_ClearLevel();
  QEX_DebugDrawClear();
  QEX_PrintRuleset();

  // allocate server memory. `qcvm->max_edicts = CLAMP (MIN_EDICTS,
  // (int)max_edicts.value, MAX_EDICTS)` (Ironwail sv_main.c:1971) in place of
  // `Hunk_AllocName (sv.max_edicts*pr_edict_size, "edicts")`; sets
  // sv.edicts/sv.max_edicts (PORTING.md ruling, U021)
  PR_AllocEdicts(Host_MaxEdicts());

  initServerBuffers(); // see file header's SV_Init deviation note (also done here, matching the real C's placement)

  // U43: a `cl_splitscreen` that wanted more player slots than the server it
  // was typed at had is held until here, because svs.clients and the player
  // edicts below are what a slot count sizes.
  const heldSlots = svMainHooks.heldClientSlots?.() ?? 0;
  if (heldSlots > svs.maxclients) {
    svs.maxclients = heldSlots;
    if (svs.maxclientslimit < heldSlots) svs.maxclientslimit = heldSlots;
    while (svs.clients.length < svs.maxclientslimit) svs.clients.push(new ClientT());
  }

  // leave slots at start for clients only
  sv.num_edicts = svs.maxclients + 1;
  for (let i = 0; i < svs.maxclients; i++) {
    const ent = EDICT_NUM(i + 1);
    svs.clients[i].edict = ent;
  }

  sv.state = ServerStateT.ss_loading;
  sv.paused = false;

  sv.time = 1.0;

  sv.name = server;
  sv.modelname = Com_sprintf("maps/%s.bsp", server);
  const worldmodel = Mod_ForName(sv.modelname, false);
  if (worldmodel === null) {
    Con_Printf("Couldn't spawn server %s\n", sv.modelname);
    sv.active = false;
    return;
  }
  sv.worldmodel = worldmodel;
  sv.models[1] = worldmodel;

  // The BSP width Mod_LoadBrushModel just parsed. model.ts records it on the
  // `loadState` holder rather than on ModelT, and Mod_ForName's submodel
  // lookups below never re-enter Mod_LoadBrushModel, so it is read here, at
  // the one point where it is unambiguously this map's.
  const bspWidth = loadState.bspWidth;

  // The protocol has to be fixed before ED_LoadFromFile: PF_makestatic and
  // PF_ambientsound write into sv.signon from inside the spawn functions.
  const protocol = SV_ChooseProtocol(worldmodel, bspWidth);
  if (SV_ProtocolTooNarrow(protocol, worldmodel, bspWidth)) {
    Con_Printf("sv_protocol 15 cannot carry %s (BSP2 / extents beyond +-4096): use 666, 999 or auto\n", sv.modelname);
    sv.active = false;
    return;
  }
  SV_SetProtocol(protocol);

  // clear world interaction links
  SV_ClearWorld();

  sv.sound_precache[0] = ""; // pr_strings

  sv.model_precache[0] = ""; // pr_strings
  sv.model_precache[1] = sv.modelname;
  for (let i = 1; i < worldmodel.numsubmodels; i++) {
    sv.model_precache[1 + i] = localmodels[i];
    sv.models[i + 1] = Mod_ForName(localmodels[i], false);
  }

  // load the rest of the entities
  const ent = EDICT_NUM(0);
  ent.fields.i.fill(0); // memset (&ent->v, 0, progs->entityfields * 4)
  ent.free = false;
  ent.v.model = PR_SetEngineString(worldmodel.name); // ent->v.model = sv.worldmodel->name - pr_strings
  ent.v.modelindex = 1; // world model
  ent.v.solid = SOLID_BSP;
  ent.v.movetype = MOVETYPE_PUSH;

  if (coop.value) globalStruct().coop = coop.value;
  else globalStruct().deathmatch = deathmatch.value;

  globalStruct().mapname = PR_SetEngineString(sv.name); // pr_global_struct->mapname = sv.name - pr_strings

  // serverflags are for cross level information (sigils)
  globalStruct().serverflags = svs.serverflags;

  ED_LoadFromFile({ data: worldmodel.entities ?? "", index: 0 });

  sv.active = true;

  // all setup is completed, any further precache statements are errors
  sv.state = ServerStateT.ss_active;

  // run two frames to allow everything to settle
  host.frametime = 0.1;
  SV_Physics();
  SV_Physics();

  // create a baseline for more efficient communications
  SV_CreateBaseline();

  // send serverinfo to all connected clients
  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;
    if (host_client.active) SV_SendServerinfo(host_client);
  }

  // U20: src/bots loads bots/navigation/<map>.nav and re-seats every bot in
  // the level that just spawned. Registered, not called directly, so a build
  // with no bot support links without it.
  if (svMainHooks.spawnServer !== null) svMainHooks.spawnServer(server);

  Con_DPrintf("Server spawned.\n");
}
