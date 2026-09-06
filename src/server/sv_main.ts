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
import { Cvar_RegisterVariable, Cvar_Set, Cvar_SetValue } from "../common/cvar";
import { Com_sprintf } from "../common/sprintf";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { Cmd_ExecuteString, CmdSourceT } from "../common/cmd";
import { standard_quake } from "../common/common";
import { coop, deathmatch, host, Host_ClearMemory, skill } from "../common/host";
import { hostname, NET_CanSendMessage, NET_CheckNewConnections, NET_SendMessage, NET_SendToAll, NET_SendUnreliableMessage, net_activeconnections, setNetActiveConnections } from "../common/net_main";
import { CONTENTS_SOLID, MAX_MAP_LEAFS } from "../common/bspfile";
import { isMleaf, Mod_ForName, Mod_LeafPVS, type MleafT, type ModelT, type MnodeT } from "../common/model";
import { DotProduct, VectorAdd, VectorCopy, type Vec3, vec3 } from "../common/mathlib";
import { MAX_DATAGRAM, MAX_EDICTS, MAX_MODELS, MAX_MSGLEN, MAX_SOUNDS, VERSION } from "../common/quakedef";
import {
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_VIEWHEIGHT,
  GAME_COOP,
  GAME_DEATHMATCH,
  PROTOCOL_VERSION,
  SND_ATTENUATION,
  SND_VOLUME,
  SU_ARMOR,
  SU_IDEALPITCH,
  SU_INWATER,
  SU_ITEMS,
  SU_ONGROUND,
  SU_PUNCH1,
  SU_VELOCITY1,
  SU_VIEWHEIGHT,
  SU_WEAPON,
  SU_WEAPONFRAME,
  SvcOpsT,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_FRAME,
  U_LONGENTITY,
  U_MODEL,
  U_MOREBITS,
  U_NOLERP,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_SIGNAL,
  U_SKIN,
} from "../common/protocol";
import { MSG_WriteAngle, MSG_WriteByte, MSG_WriteChar, MSG_WriteCoord, MSG_WriteFloat, MSG_WriteLong, MSG_WriteShort, MSG_WriteString, SZ_Clear, SZ_Write, SizeBuf } from "../common/sizebuf";
import { Sys_Error, SysError, sysState } from "../platform/sys";
import {
  ClientT,
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
export const svMainHooks: {
  dropClient: ((crash: boolean) => void) | null;
  scrCenterTimeOff: (() => void) | null;
} = {
  dropClient: null,
  scrCenterTimeOff: null,
};

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

// sv.datagram/reliable_datagram/signon SizeBuf setup -- see file header.
function initServerBuffers(): void {
  sv.datagram.maxsize = sv.datagram_buf.length;
  sv.datagram.cursize = 0;
  sv.datagram.data = sv.datagram_buf;

  sv.reliable_datagram.maxsize = sv.reliable_datagram_buf.length;
  sv.reliable_datagram.cursize = 0;
  sv.reliable_datagram.data = sv.reliable_datagram_buf;

  sv.signon.maxsize = sv.signon_buf.length;
  sv.signon.cursize = 0;
  sv.signon.data = sv.signon_buf;
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
  if (sv.datagram.cursize > MAX_DATAGRAM - 16) return;

  MSG_WriteByte(sv.datagram, SvcOpsT.svc_particle);
  MSG_WriteCoord(sv.datagram, org[0]);
  MSG_WriteCoord(sv.datagram, org[1]);
  MSG_WriteCoord(sv.datagram, org[2]);
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

  if (sv.datagram.cursize > MAX_DATAGRAM - 16) return;

  // find precache number for sound
  let sound_num = 1;
  for (; sound_num < MAX_SOUNDS && sv.sound_precache[sound_num] !== null; sound_num++) {
    if (sample === sv.sound_precache[sound_num]) break;
  }

  if (sound_num === MAX_SOUNDS || sv.sound_precache[sound_num] === null) {
    Con_Printf("SV_StartSound: %s not precacheed\n", sample);
    return;
  }

  const ent = NUM_FOR_EDICT(entity);

  const channelBits = (ent << 3) | channel;

  let field_mask = 0;
  if (volume !== DEFAULT_SOUND_PACKET_VOLUME) field_mask |= SND_VOLUME;
  if (attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) field_mask |= SND_ATTENUATION;

  // directed messages go only to the entity the are targeted on
  MSG_WriteByte(sv.datagram, SvcOpsT.svc_sound);
  MSG_WriteByte(sv.datagram, field_mask);
  if (field_mask & SND_VOLUME) MSG_WriteByte(sv.datagram, volume);
  if (field_mask & SND_ATTENUATION) MSG_WriteByte(sv.datagram, attenuation * 64);
  MSG_WriteShort(sv.datagram, channelBits);
  MSG_WriteByte(sv.datagram, sound_num);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(sv.datagram, entity.v.origin[i] + 0.5 * (entity.v.mins[i] + entity.v.maxs[i]));
  }
}

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

  MSG_WriteByte(client.message, SvcOpsT.svc_serverinfo);
  MSG_WriteLong(client.message, PROTOCOL_VERSION);
  MSG_WriteByte(client.message, svs.maxclients);

  if (!coop.value && deathmatch.value) MSG_WriteByte(client.message, GAME_DEATHMATCH);
  else MSG_WriteByte(client.message, GAME_COOP);

  const worldEnt = sv.edicts[0];
  MSG_WriteString(client.message, PR_GetString(worldEnt.v.message));

  for (let i = 1; i < MAX_MODELS; i++) {
    const s = sv.model_precache[i];
    if (s === null) break;
    MSG_WriteString(client.message, s);
  }
  MSG_WriteByte(client.message, 0);

  for (let i = 1; i < MAX_SOUNDS; i++) {
    const s = sv.sound_precache[i];
    if (s === null) break;
    MSG_WriteString(client.message, s);
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

  client.name = "unconnected";
  client.active = true;
  client.spawned = false;
  client.edict = ent;
  client.message.data = client.msgbuf;
  client.message.maxsize = client.msgbuf.length;
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
export function SV_WriteEntitiesToClient(clent: EdictT, msg: SizeBuf): void {
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

    if (msg.maxsize - msg.cursize < 16) {
      Con_Printf("packet overflow\n");
      return;
    }

    // send an update
    let bits = 0;

    for (let i = 0; i < 3; i++) {
      const miss = ent.v.origin[i] - ent.baseline.origin[i];
      if (miss < -0.1 || miss > 0.1) bits |= U_ORIGIN1 << i;
    }

    if (ent.v.angles[0] !== ent.baseline.angles[0]) bits |= U_ANGLE1;

    if (ent.v.angles[1] !== ent.baseline.angles[1]) bits |= U_ANGLE2;

    if (ent.v.angles[2] !== ent.baseline.angles[2]) bits |= U_ANGLE3;

    if (ent.v.movetype === MOVETYPE_STEP) bits |= U_NOLERP; // don't mess up the step animation

    if (ent.baseline.colormap !== ent.v.colormap) bits |= U_COLORMAP;

    if (ent.baseline.skin !== ent.v.skin) bits |= U_SKIN;

    if (ent.baseline.frame !== ent.v.frame) bits |= U_FRAME;

    if (ent.baseline.effects !== ent.v.effects) bits |= U_EFFECTS;

    if (ent.baseline.modelindex !== ent.v.modelindex) bits |= U_MODEL;

    if (e >= 256) bits |= U_LONGENTITY;

    if (bits >= 256) bits |= U_MOREBITS;

    // write the message
    MSG_WriteByte(msg, bits | U_SIGNAL);

    if (bits & U_MOREBITS) MSG_WriteByte(msg, bits >> 8);
    if (bits & U_LONGENTITY) MSG_WriteShort(msg, e);
    else MSG_WriteByte(msg, e);

    if (bits & U_MODEL) MSG_WriteByte(msg, ent.v.modelindex);
    if (bits & U_FRAME) MSG_WriteByte(msg, ent.v.frame);
    if (bits & U_COLORMAP) MSG_WriteByte(msg, ent.v.colormap);
    if (bits & U_SKIN) MSG_WriteByte(msg, ent.v.skin);
    if (bits & U_EFFECTS) MSG_WriteByte(msg, ent.v.effects);
    if (bits & U_ORIGIN1) MSG_WriteCoord(msg, ent.v.origin[0]);
    if (bits & U_ANGLE1) MSG_WriteAngle(msg, ent.v.angles[0]);
    if (bits & U_ORIGIN2) MSG_WriteCoord(msg, ent.v.origin[1]);
    if (bits & U_ANGLE2) MSG_WriteAngle(msg, ent.v.angles[1]);
    if (bits & U_ORIGIN3) MSG_WriteCoord(msg, ent.v.origin[2]);
    if (bits & U_ANGLE3) MSG_WriteAngle(msg, ent.v.angles[2]);
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
export function SV_WriteClientdataToMessage(ent: EdictT, msg: SizeBuf): void {
  // send a damage message
  if (ent.v.dmg_take || ent.v.dmg_save) {
    const other = PROG_TO_EDICT(ent.v.dmg_inflictor);
    MSG_WriteByte(msg, SvcOpsT.svc_damage);
    MSG_WriteByte(msg, ent.v.dmg_save);
    MSG_WriteByte(msg, ent.v.dmg_take);
    for (let i = 0; i < 3; i++) MSG_WriteCoord(msg, other.v.origin[i] + 0.5 * (other.v.mins[i] + other.v.maxs[i]));

    ent.v.dmg_take = 0;
    ent.v.dmg_save = 0;
  }

  // send the current viewpos offset from the view entity
  SV_SetIdealPitch(); // how much to look up / down ideally

  // a fixangle might get lost in a dropped packet.  Oh well.
  if (ent.v.fixangle) {
    MSG_WriteByte(msg, SvcOpsT.svc_setangle);
    for (let i = 0; i < 3; i++) MSG_WriteAngle(msg, ent.v.angles[i]);
    ent.v.fixangle = 0;
  }

  let bits = 0;

  if (ent.v.view_ofs[2] !== DEFAULT_VIEWHEIGHT) bits |= SU_VIEWHEIGHT;

  if (ent.v.idealpitch) bits |= SU_IDEALPITCH;

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

  bits |= SU_ITEMS;

  if ((ent.v.flags | 0) & FL_ONGROUND) bits |= SU_ONGROUND;

  if (ent.v.waterlevel >= 2) bits |= SU_INWATER;

  for (let i = 0; i < 3; i++) {
    if (ent.v.punchangle[i]) bits |= SU_PUNCH1 << i;
    if (ent.v.velocity[i]) bits |= SU_VELOCITY1 << i;
  }

  if (ent.v.weaponframe) bits |= SU_WEAPONFRAME;

  if (ent.v.armorvalue) bits |= SU_ARMOR;

  //	if (ent->v.weapon)
  bits |= SU_WEAPON;

  // send the data

  MSG_WriteByte(msg, SvcOpsT.svc_clientdata);
  MSG_WriteShort(msg, bits);

  if (bits & SU_VIEWHEIGHT) MSG_WriteChar(msg, ent.v.view_ofs[2]);

  if (bits & SU_IDEALPITCH) MSG_WriteChar(msg, ent.v.idealpitch);

  for (let i = 0; i < 3; i++) {
    if (bits & (SU_PUNCH1 << i)) MSG_WriteChar(msg, ent.v.punchangle[i]);
    if (bits & (SU_VELOCITY1 << i)) MSG_WriteChar(msg, ent.v.velocity[i] / 16);
  }

  // [always sent]	if (bits & SU_ITEMS)
  MSG_WriteLong(msg, items);

  if (bits & SU_WEAPONFRAME) MSG_WriteByte(msg, ent.v.weaponframe);
  if (bits & SU_ARMOR) MSG_WriteByte(msg, ent.v.armorvalue);
  if (bits & SU_WEAPON) MSG_WriteByte(msg, SV_ModelIndex(PR_GetString(ent.v.weaponmodel)));

  MSG_WriteShort(msg, ent.v.health);
  MSG_WriteByte(msg, ent.v.currentammo);
  MSG_WriteByte(msg, ent.v.ammo_shells);
  MSG_WriteByte(msg, ent.v.ammo_nails);
  MSG_WriteByte(msg, ent.v.ammo_rockets);
  MSG_WriteByte(msg, ent.v.ammo_cells);

  if (standard_quake) {
    MSG_WriteByte(msg, ent.v.weapon);
  } else {
    for (let i = 0; i < 32; i++) {
      if ((ent.v.weapon | 0) & (1 << i)) {
        MSG_WriteByte(msg, i);
        break;
      }
    }
  }
}

/*
=======================
SV_SendClientDatagram
=======================
*/
export function SV_SendClientDatagram(client: ClientT): boolean {
  const buf = new Uint8Array(MAX_DATAGRAM);
  const msg = new SizeBuf();

  msg.data = buf;
  msg.maxsize = buf.length;
  msg.cursize = 0;

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
  // update frags, names, etc
  SV_UpdateToReliableMessages();

  // build individual updates
  for (let i = 0; i < svs.maxclients; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;

    if (!host_client.active) continue;

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
    } else {
      svent.baseline.colormap = 0;
      svent.baseline.modelindex = SV_ModelIndex(PR_GetString(svent.v.model));
    }

    // add to the message
    MSG_WriteByte(sv.signon, SvcOpsT.svc_spawnbaseline);
    MSG_WriteShort(sv.signon, entnum);

    MSG_WriteByte(sv.signon, svent.baseline.modelindex);
    MSG_WriteByte(sv.signon, svent.baseline.frame);
    MSG_WriteByte(sv.signon, svent.baseline.colormap);
    MSG_WriteByte(sv.signon, svent.baseline.skin);
    for (let i = 0; i < 3; i++) {
      MSG_WriteCoord(sv.signon, svent.baseline.origin[i]);
      MSG_WriteAngle(sv.signon, svent.baseline.angles[i]);
    }
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
SV_SpawnServer

This is called at the start of each level
================
*/
export function SV_SpawnServer(server: string): void {
  // let's not have any servers with no name
  if (hostname.string === "") Cvar_Set("hostname", "UNNAMED");
  if (svMainHooks.scrCenterTimeOff) svMainHooks.scrCenterTimeOff(); // scr_centertime_off = 0

  Con_DPrintf("SpawnServer: %s\n", server);
  svs.changelevel_issued = false; // now safe to issue another

  // tell all connected clients that we are going to a new level
  if (sv.active) SV_SendReconnect();

  // make cvars consistant
  if (coop.value) Cvar_SetValue("deathmatch", 0);
  hostCmdState.current_skill = Math.trunc(skill.value + 0.5);
  if (hostCmdState.current_skill < 0) hostCmdState.current_skill = 0;
  if (hostCmdState.current_skill > 3) hostCmdState.current_skill = 3;

  Cvar_SetValue("skill", hostCmdState.current_skill);

  // set up the new server
  Host_ClearMemory();

  sv.clear(); // memset (&sv, 0, sizeof(sv)) -- see file header (Host_ClearMemory already does this; kept for fidelity, matching the C's own double memset)

  sv.name = server;

  // load progs to get entity field count
  PR_LoadProgs();

  // allocate server memory
  PR_AllocEdicts(MAX_EDICTS); // in place of `Hunk_AllocName (sv.max_edicts*pr_edict_size, "edicts")`; sets sv.edicts/sv.max_edicts (PORTING.md ruling, U021)

  initServerBuffers(); // see file header's SV_Init deviation note (also done here, matching the real C's placement)

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

  Con_DPrintf("Server spawned.\n");
}
