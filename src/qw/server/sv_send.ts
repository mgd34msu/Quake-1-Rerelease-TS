/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_send.c (GNU GPL v2 or later).

sv_send.c -- despite the file's own stray top-of-file comment reading
"// sv_main.c -- server main program" (a copy-paste artifact in id's own
source, confirmed real by reading the file directly: it is unambiguously
QW/server/sv_send.c on disk, and server.h's own function-prototype comment
block groups every name below under "sv_send.c"), this is the module that
owns the qwsv binary's Con_Printf redirection (SV_BeginRedirect/SV_EndRedirect,
outputbuf), Con_Printf/Con_DPrintf themselves, per-client and broadcast
messaging, SV_Multicast, SV_StartSound, and the per-frame client message
send path.

Deviations from PORTING.md / the C source:
- `Con_Printf`/`Con_DPrintf`: qwsv has no console.c of its own (SERVERONLY
  links no client subsystem at all, confirmed by qwsvdef.ts's own file
  header), so these two names are genuinely this file's own functions in the
  real binary, not src/client/console.ts's WinQuake versions -- every other
  qwsv-server file in this unit's SCOPE (sv_init.ts, sv_ccmds.ts) imports
  Con_Printf/Con_DPrintf from here, matching the real link graph, where the
  redirect-aware implementation is the one and only Con_Printf symbol linked
  into the qwsv binary. (src/qw/net_chan.ts and src/qw/cmd.ts, both shared
  with qwcl and landed before this unit, still import console.ts's version;
  that mismatch predates this unit and is out of SCOPE to fix -- reported as
  a deviation for the coordinator.)
- `outputbuf[8000]`/`sv_redirected` (svonly.c's own globals in the C, folded
  into this file since SV_BeginRedirect/SV_EndRedirect/SV_FlushRedirect are
  defined here): `outputbuf` is a private `let string` (append via `+=`,
  matching `strcat`); `sv_redirected` is an exported, reassigned `let`
  (RedirectT), read elsewhere in this SCOPE (sv_ccmds.ts's SV_Status_f/
  SV_Snap) the same way net_chan.ts's `net_drop` is read across modules.
- `sv_logfile`: referenced in three C files (defined in sv_main.c, opened/
  closed by sv_ccmds.c's SV_Logfile_f, read by this file's Con_Printf). Since
  this file's Con_Printf is the
  highest-frequency reader/most "fundamental" of the three, the fd is held
  here (`svSendFileState.sv_logfile: number | null`, a plain Sys_FileOpenWrite
  fd rather than src/common/common.ts's read-oriented `FileHandle` class) and
  sv_ccmds.ts's SV_Logfile_f reads/writes it through this export instead of
  duplicating storage. Q014's sv_main.ts, and Q012's pr_cmds.ts (which reads
  the sibling `sv_fraglogfile` for its frag-log write), should import both
  fields from here when they land, matching this file's real ownership.
- `SV_Error`, `developer` (cvar), `sv_phs` (cvar), `SV_DropClient`,
  `SV_FullClientUpdate`: genuinely sv_main.c-owned. sv_main.ts (Q014) landed
  mid-unit; its own file imports this file's Con_Printf/Con_DPrintf/etc.
  normally (module-scope), so a plain import back of `SV_Error` here would
  complete a cycle (sv_main -> sv_send -> sv_main) -- reached through the
  same lazy `svMainMod()` this file already uses for `SV_ModelIndex`, rather
  than through a second, direct import. `developer.value`/`sv_phs.value`/
  `SV_DropClient(...)`/`SV_FullClientUpdate(...)` are read through
  `svMainMod()` for the same reason, even though the underlying names are
  ordinary cvars/functions with no reassignment concern of their own.
- `GetEdictFieldValue` (pr_edict.c, Q011's second file): imported from
  "./pr_edict" normally.
- `SV_ModelIndex` (sv_init.c, this SCOPE's own sv_init.ts) is reached via a
  lazy `require()`: sv_init.ts imports this file's Con_Printf/Con_DPrintf
  normally (SV_SpawnServer's Con_DPrintf calls), so a plain module-scope
  import back here would be a load-time cycle; this file is the more
  fundamental of the two (imported by sv_init.ts, sv_ccmds.ts, and sv_ents.ts),
  so it breaks the cycle on its own side, per PORTING.md's import-cycle rule.
- `SV_WriteEntitiesToClient` (sv_ents.c, this SCOPE's own sv_ents.ts) is
  imported normally: sv_ents.ts's own back-reference to this file
  (`sv_nailmodel`/`sv_supernailmodel`/`sv_playermodel`) is the lazy side
  instead (see sv_ents.ts's file header), since this file is read by more of
  the SCOPE than sv_ents.ts is.
- `SV_Multicast`'s `leaf = Mod_PointInLeaf(...); if (!leaf) leafnum = 0; else
  leafnum = leaf - sv.worldmodel->leafs;` and the per-client `if (leaf) {...}`
  guard: src/common/model.ts's `Mod_PointInLeaf` never returns null (it
  Sys_Errors instead on every failure path a null return would have signaled
  in the C) -- both `if (leaf)`/`if (!leaf)` branches are therefore
  unreachable in this port and only their "leaf found" bodies are ported,
  matching src/server/world.ts's/src/progs/pr_cmds.ts's own precedent for the
  same `Mod_PointInLeaf` contract. `leaf - sv.worldmodel->leafs` (pointer
  difference) becomes `worldmodel.leafs.indexOf(leaf)`, same substitution.
- `SV_Multicast`'s `goto inrange`: restructured as an `inRange` boolean set by
  the PHS-distance shortcut, guarding the leaf-visibility suppression check
  that follows; same control flow, no `goto`.
- `SV_CalcPHS`'s row math is sv_init.ts's concern, not this file's; this file
  only reads `sv.pvs`/`sv.phs` (via `requirePvs`/`requirePhs`, thrown if
  either is still null -- SV_CalcPHS/SV_SpawnServer not yet run).
- `SV_StartSound`'s `field_mask` local: assigned (`field_mask = 0`) but never
  read anywhere in the C (the volume/attenuation flags are OR'd into
  `channel` directly, not `field_mask`) -- a genuinely dead local in the
  original source; omitted rather than carried as an inert unused binding.
- `channel = (ent<<3) | channel;`'s subsequent `channel |= SND_VOLUME` etc.:
  ported as a local `chan` (the parameter itself is reassigned in the C;
  TypeScript parameters can be reassigned too, but a fresh `let chan` keeps
  the original `channel` argument's intent legible without shadowing rules
  surprising a reader).
- `SV_SendClientMessages`'s backbuf-rotation `memcpy` loop: ported as
  `Uint8Array#set` on the fixed `backbuf_data[]` slots, same as
  sv_nchan.ts's/ClientReliableCheckBlock's own idiom; the `memset(&c->backbuf,
  0, ...)` becomes a fresh `SizeBuf` instance, matching this file's other
  buffer-reset sites.
- `Netchan_Transmit (&c->netchan, 0, NULL)`: the `NULL` becomes `new
  Uint8Array(0)` (length 0, so it is never read by Netchan_Transmit's own
  `SZ_Write` call, which is itself gated on `length`).
*/

import type * as SvMainModule from "./sv_main";
import type * as SvInitModule from "./sv_init";
import { GetEdictFieldValue } from "./pr_edict";
import { SV_WriteEntitiesToClient } from "./sv_ents";
import { ClientReliableCheckBlock, ClientReliableWrite_Begin, ClientReliableWrite_Byte, ClientReliableWrite_Float, ClientReliableWrite_Long, ClientReliableWrite_Short, ClientReliableWrite_String, ClientReliableWrite_SZ } from "./sv_nchan";
import { E_FLOAT, NUM_FOR_EDICT, PROG_TO_EDICT, PR_GetString, qwpr, type QwEdictT } from "./progs";
import type { QwGlobalVars } from "./progdefs";
import { ClientStateT, ClientT, MulticastT, RedirectT, SOLID_BSP, sv, svs, svState } from "./server";
import {
  A2C_PRINT,
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  MAX_CLIENTS,
  PRINT_HIGH,
  SND_ATTENUATION,
  SND_VOLUME,
  SvcOpsT,
} from "../protocol";
import { MAX_CL_STATS, MAX_DATAGRAM, MAX_MODELS, MAX_SOUNDS, STAT_ACTIVEWEAPON, STAT_AMMO, STAT_ARMOR, STAT_CELLS, STAT_HEALTH, STAT_ITEMS, STAT_NAILS, STAT_ROCKETS, STAT_SHELLS, STAT_WEAPON } from "../bothdefs";
import { MSG_WriteAngle, MSG_WriteByte, MSG_WriteCoord, MSG_WriteFloat, MSG_WriteLong, MSG_WriteShort, MSG_WriteString, SizeBuf, SZ_Clear, SZ_Write } from "../common";
import { Length, VectorCopy, VectorSubtract, vec3, type Vec3 } from "../../common/mathlib";
import { Mod_PointInLeaf, type ModelT } from "../../common/model";
import { net_from, NET_SendPacket } from "../net_udp";
import { Netchan_CanPacket, Netchan_CanReliable, Netchan_Transmit } from "../net_chan";
import { Com_sprintf } from "../../common/sprintf";
import { Sys_FileWrite, Sys_Printf, SysError } from "../../platform/sys";

// see file header: sv_init.ts imports this file's Con_Printf/Con_DPrintf
// normally, so SV_ModelIndex is reached lazily here to avoid a load-time cycle.
function svInitMod(): typeof SvInitModule {
  return require("./sv_init");
}

// see file header: sv_main.c-owned names, reached lazily to avoid a
// load-time cycle (sv_main.ts imports this file's exports normally).
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("sv_send: sv.worldmodel not set");
  return sv.worldmodel;
}

function requirePvs(): Uint8Array {
  if (sv.pvs === null) throw new SysError("sv_send: sv.pvs not set (SV_CalcPHS not run)");
  return sv.pvs;
}

function requirePhs(): Uint8Array {
  if (sv.phs === null) throw new SysError("sv_send: sv.phs not set (SV_CalcPHS not run)");
  return sv.phs;
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new SysError("sv_send: qwpr.global_struct not set (PR_LoadProgs not called)");
  return qwpr.global_struct;
}

function requireEdict(client: ClientT): QwEdictT {
  if (client.edict === null) throw new SysError("sv_send: client has no edict");
  return client.edict;
}

function stringToLatin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/*
=============================================================================

Con_Printf redirection

=============================================================================
*/

const MAXOUTPUTBUF = 8000; // char outputbuf[8000]

let outputbuf = "";

export let sv_redirected: RedirectT = RedirectT.RD_NONE;

// sv_logfile/sv_fraglogfile: see file header. Plain fds (Sys_FileOpenWrite),
// not src/common/common.ts's read-oriented FileHandle class.
export const svSendFileState: { sv_logfile: number | null; sv_fraglogfile: number | null } = {
  sv_logfile: null,
  sv_fraglogfile: null,
};

/*
==================
SV_FlushRedirect
==================
*/
function SV_FlushRedirect(): void {
  if (sv_redirected === RedirectT.RD_PACKET) {
    const bodyBytes = stringToLatin1Bytes(outputbuf);
    const send = new Uint8Array(5 + bodyBytes.length + 1);
    send[0] = 0xff;
    send[1] = 0xff;
    send[2] = 0xff;
    send[3] = 0xff;
    send[4] = A2C_PRINT.charCodeAt(0);
    send.set(bodyBytes, 5);
    send[5 + bodyBytes.length] = 0;

    NET_SendPacket(send.length, send, net_from);
  } else if (sv_redirected === RedirectT.RD_CLIENT) {
    const host_client = svState.host_client;
    if (host_client === null) throw new SysError("SV_FlushRedirect: no host_client");
    ClientReliableWrite_Begin(host_client, SvcOpsT.svc_print, outputbuf.length + 3);
    ClientReliableWrite_Byte(host_client, PRINT_HIGH);
    ClientReliableWrite_String(host_client, outputbuf);
  }

  // clear it
  outputbuf = "";
}

/*
==================
SV_BeginRedirect

  Send Con_Printf data to the remote client
  instead of the console
==================
*/
export function SV_BeginRedirect(rd: RedirectT): void {
  sv_redirected = rd;
  outputbuf = "";
}

export function SV_EndRedirect(): void {
  SV_FlushRedirect();
  sv_redirected = RedirectT.RD_NONE;
}

/*
================
Con_Printf

Handles cursor positioning, line wrapping, etc
================
*/
export function Con_Printf(fmt: string, ...args: Array<string | number>): void {
  const msg = Com_sprintf(fmt, ...args);

  // add to redirected message
  if (sv_redirected) {
    if (msg.length + outputbuf.length > MAXOUTPUTBUF - 1) SV_FlushRedirect();
    outputbuf += msg;
    return;
  }

  Sys_Printf("%s", msg); // also echo to debugging console
  if (svSendFileState.sv_logfile !== null) {
    Sys_FileWrite(svSendFileState.sv_logfile, stringToLatin1Bytes(msg), msg.length);
  }
}

/*
================
Con_DPrintf

A Con_Printf that only shows up if the "developer" cvar is set
================
*/
export function Con_DPrintf(fmt: string, ...args: Array<string | number>): void {
  if (!svMainMod().developer.value) return;

  const msg = Com_sprintf(fmt, ...args);
  Con_Printf("%s", msg);
}

/*
=============================================================================

EVENT MESSAGES

=============================================================================
*/

function SV_PrintToClient(cl: ClientT, level: number, string: string): void {
  ClientReliableWrite_Begin(cl, SvcOpsT.svc_print, string.length + 3);
  ClientReliableWrite_Byte(cl, level);
  ClientReliableWrite_String(cl, string);
}

/*
=================
SV_ClientPrintf

Sends text across to be displayed if the level passes
=================
*/
export function SV_ClientPrintf(cl: ClientT, level: number, fmt: string, ...args: Array<string | number>): void {
  if (level < cl.messagelevel) return;

  const string = Com_sprintf(fmt, ...args);
  SV_PrintToClient(cl, level, string);
}

/*
=================
SV_BroadcastPrintf

Sends text to all active clients
=================
*/
export function SV_BroadcastPrintf(level: number, fmt: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(fmt, ...args);

  Sys_Printf("%s", string); // print to the console

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    if (level < cl.messagelevel) continue;
    if (!cl.state) continue;

    SV_PrintToClient(cl, level, string);
  }
}

/*
=================
SV_BroadcastCommand

Sends text to all active clients
=================
*/
export function SV_BroadcastCommand(fmt: string, ...args: Array<string | number>): void {
  if (!sv.state) return;

  const string = Com_sprintf(fmt, ...args);

  MSG_WriteByte(sv.reliable_datagram, SvcOpsT.svc_stufftext);
  MSG_WriteString(sv.reliable_datagram, string);
}

/*
=================
SV_Multicast

Sends the contents of sv.multicast to a subset of the clients,
then clears sv.multicast.

MULTICAST_ALL	same as broadcast
MULTICAST_PVS	send to clients potentially visible from org
MULTICAST_PHS	send to clients potentially hearable from org
=================
*/
export function SV_Multicast(origin: Vec3, to: MulticastT): void {
  const worldmodel = requireWorldmodel();

  // Mod_PointInLeaf never returns null in this port; the C's `if (!leaf)`
  // fallback (leafnum = 0) is unreachable here -- see file header.
  const leaf = Mod_PointInLeaf(origin, worldmodel);
  const leafnum = worldmodel.leafs.indexOf(leaf);

  let reliable = false;
  let mask: Uint8Array;

  const rowbytes = 4 * ((worldmodel.numleafs + 31) >> 5);

  switch (to) {
    case MulticastT.MULTICAST_ALL_R:
      reliable = true;
    // fallthrough
    case MulticastT.MULTICAST_ALL:
      mask = requirePvs(); // leaf 0 is everything;
      break;

    case MulticastT.MULTICAST_PHS_R:
      reliable = true;
    // fallthrough
    case MulticastT.MULTICAST_PHS:
      mask = requirePhs().subarray(leafnum * rowbytes);
      break;

    case MulticastT.MULTICAST_PVS_R:
      reliable = true;
    // fallthrough
    case MulticastT.MULTICAST_PVS:
      mask = requirePvs().subarray(leafnum * rowbytes);
      break;

    default:
      // `return` (not just the call) so TypeScript's control-flow analysis
      // recognizes this switch never falls through to `mask` unassigned --
      // svMainMod().SV_Error(...) itself never returns, matching the C's
      // SV_Error before falling into the switch's mask-using code below.
      return svMainMod().SV_Error("SV_Multicast: bad to:%i", to);
  }

  // send the data to all relevent clients
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const client = svs.clients[j];
    if (client.state !== ClientStateT.cs_spawned) continue;

    let inRange = false;
    if (to === MulticastT.MULTICAST_PHS_R || to === MulticastT.MULTICAST_PHS) {
      const delta = vec3();
      VectorSubtract(origin, requireEdict(client).v.origin, delta);
      if (Length(delta) <= 1024) inRange = true;
    }

    if (!inRange) {
      // Mod_PointInLeaf never returns null in this port -- see file header
      const clientLeaf = Mod_PointInLeaf(requireEdict(client).v.origin, worldmodel);
      // -1 is because pvs rows are 1 based, not 0 based like leafs
      const clientLeafnum = worldmodel.leafs.indexOf(clientLeaf) - 1;
      if (!(mask[clientLeafnum >> 3] & (1 << (clientLeafnum & 7)))) {
        continue;
      }
    }

    if (reliable) {
      ClientReliableCheckBlock(client, sv.multicast.cursize);
      ClientReliableWrite_SZ(client, sv.multicast.data, sv.multicast.cursize);
    } else {
      SZ_Write(client.datagram, sv.multicast.data, sv.multicast.cursize);
    }
  }

  SZ_Clear(sv.multicast);
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
export function SV_StartSound(entity: QwEdictT, channel: number, sample: string, volume: number, attenuation: number): void {
  if (volume < 0 || volume > 255) svMainMod().SV_Error("SV_StartSound: volume = %i", volume);

  if (attenuation < 0 || attenuation > 4) svMainMod().SV_Error("SV_StartSound: attenuation = %f", attenuation);

  if (channel < 0 || channel > 15) svMainMod().SV_Error("SV_StartSound: channel = %i", channel);

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

  let reliable = false;
  let use_phs: boolean;
  let chan = channel;

  if (chan & 8 || !svMainMod().sv_phs.value) {
    // no PHS flag
    if (chan & 8) reliable = true; // sounds that break the phs are reliable
    use_phs = false;
    chan &= 7;
  } else {
    use_phs = true;
  }

  chan = (ent << 3) | chan;

  // field_mask: write-only, never read in the C -- see file header; omitted
  if (volume !== DEFAULT_SOUND_PACKET_VOLUME) chan |= SND_VOLUME;
  if (attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) chan |= SND_ATTENUATION;

  // use the entity origin unless it is a bmodel
  const origin = vec3();
  if (entity.v.solid === SOLID_BSP) {
    for (let i = 0; i < 3; i++) origin[i] = entity.v.origin[i] + 0.5 * (entity.v.mins[i] + entity.v.maxs[i]);
  } else {
    VectorCopy(entity.v.origin, origin);
  }

  MSG_WriteByte(sv.multicast, SvcOpsT.svc_sound);
  MSG_WriteShort(sv.multicast, chan);
  if (chan & SND_VOLUME) MSG_WriteByte(sv.multicast, volume);
  if (chan & SND_ATTENUATION) MSG_WriteByte(sv.multicast, attenuation * 64);
  MSG_WriteByte(sv.multicast, sound_num);
  for (let i = 0; i < 3; i++) MSG_WriteCoord(sv.multicast, origin[i]);

  if (use_phs) SV_Multicast(origin, reliable ? MulticastT.MULTICAST_PHS_R : MulticastT.MULTICAST_PHS);
  else SV_Multicast(origin, reliable ? MulticastT.MULTICAST_ALL_R : MulticastT.MULTICAST_ALL);
}

/*
===============================================================================

FRAME UPDATES

===============================================================================
*/

export let sv_nailmodel = 0;
export let sv_supernailmodel = 0;
export let sv_playermodel = 0;

export function SV_FindModelNumbers(): void {
  sv_nailmodel = -1;
  sv_supernailmodel = -1;
  sv_playermodel = -1;

  for (let i = 0; i < MAX_MODELS; i++) {
    const name = sv.model_precache[i];
    if (name === null) break;
    if (name === "progs/spike.mdl") sv_nailmodel = i;
    if (name === "progs/s_spike.mdl") sv_supernailmodel = i;
    if (name === "progs/player.mdl") sv_playermodel = i;
  }
}

/*
==================
SV_WriteClientdataToMessage

==================
*/
export function SV_WriteClientdataToMessage(client: ClientT, msg: SizeBuf): void {
  const ent = requireEdict(client);

  // send the chokecount for r_netgraph
  if (client.chokecount) {
    MSG_WriteByte(msg, SvcOpsT.svc_chokecount);
    MSG_WriteByte(msg, client.chokecount);
    client.chokecount = 0;
  }

  // send a damage message if the player got hit this frame
  if (ent.v.dmg_take || ent.v.dmg_save) {
    const other = PROG_TO_EDICT(ent.v.dmg_inflictor);
    MSG_WriteByte(msg, SvcOpsT.svc_damage);
    MSG_WriteByte(msg, ent.v.dmg_save);
    MSG_WriteByte(msg, ent.v.dmg_take);
    for (let i = 0; i < 3; i++) MSG_WriteCoord(msg, other.v.origin[i] + 0.5 * (other.v.mins[i] + other.v.maxs[i]));

    ent.v.dmg_take = 0;
    ent.v.dmg_save = 0;
  }

  // a fixangle might get lost in a dropped packet.  Oh well.
  if (ent.v.fixangle) {
    MSG_WriteByte(msg, SvcOpsT.svc_setangle);
    for (let i = 0; i < 3; i++) MSG_WriteAngle(msg, ent.v.angles[i]);
    ent.v.fixangle = 0;
  }
}

/*
=======================
SV_UpdateClientStats

Performs a delta update of the stats array.  This should only be performed
when a reliable message can be delivered this frame.
=======================
*/
export function SV_UpdateClientStats(client: ClientT): void {
  let ent = requireEdict(client);

  const stats = new Int32Array(MAX_CL_STATS);

  // if we are a spectator and we are tracking a player, we get his stats
  // so our status bar reflects his
  if (client.spectator && client.spec_track > 0) {
    ent = requireEdict(svs.clients[client.spec_track - 1]);
  }

  stats[STAT_HEALTH] = ent.v.health;
  stats[STAT_WEAPON] = svInitMod().SV_ModelIndex(PR_GetString(ent.v.weaponmodel));
  stats[STAT_AMMO] = ent.v.currentammo;
  stats[STAT_ARMOR] = ent.v.armorvalue;
  stats[STAT_SHELLS] = ent.v.ammo_shells;
  stats[STAT_NAILS] = ent.v.ammo_nails;
  stats[STAT_ROCKETS] = ent.v.ammo_rockets;
  stats[STAT_CELLS] = ent.v.ammo_cells;
  if (!client.spectator) stats[STAT_ACTIVEWEAPON] = ent.v.weapon;
  // stuff the sigil bits into the high bits of items for sbar
  stats[STAT_ITEMS] = (ent.v.items | 0) | ((requireGlobalStruct().serverflags | 0) << 28);

  for (let i = 0; i < MAX_CL_STATS; i++) {
    if (stats[i] !== client.stats[i]) {
      client.stats[i] = stats[i];
      if (stats[i] >= 0 && stats[i] <= 255) {
        ClientReliableWrite_Begin(client, SvcOpsT.svc_updatestat, 3);
        ClientReliableWrite_Byte(client, i);
        ClientReliableWrite_Byte(client, stats[i]);
      } else {
        ClientReliableWrite_Begin(client, SvcOpsT.svc_updatestatlong, 6);
        ClientReliableWrite_Byte(client, i);
        ClientReliableWrite_Long(client, stats[i]);
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
  msg.allowoverflow = true;
  msg.overflowed = false;

  // add the client specific data to the datagram
  SV_WriteClientdataToMessage(client, msg);

  // send over all the objects that are in the PVS
  // this will include clients, a packetentities, and
  // possibly a nails update
  SV_WriteEntitiesToClient(client, msg);

  // copy the accumulated multicast datagram
  // for this client out to the message
  if (client.datagram.overflowed) {
    Con_Printf("WARNING: datagram overflowed for %s\n", client.name);
  } else {
    SZ_Write(msg, client.datagram.data, client.datagram.cursize);
  }
  SZ_Clear(client.datagram);

  // send deltas over reliable stream
  if (Netchan_CanReliable(client.netchan)) SV_UpdateClientStats(client);

  if (msg.overflowed) {
    Con_Printf("WARNING: msg overflowed for %s\n", client.name);
    SZ_Clear(msg);
  }

  // send the datagram
  Netchan_Transmit(client.netchan, msg.cursize, buf);

  return true;
}

/*
=======================
SV_UpdateToReliableMessages
=======================
*/
export function SV_UpdateToReliableMessages(): void {
  // check for changes to be sent over the reliable streams to all clients
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const host_client = svs.clients[i];
    svState.host_client = host_client;

    if (host_client.state !== ClientStateT.cs_spawned) continue;
    if (host_client.sendinfo) {
      host_client.sendinfo = false;
      svMainMod().SV_FullClientUpdate(host_client, sv.reliable_datagram);
    }

    const ent = requireEdict(host_client);

    if (host_client.old_frags !== ent.v.frags) {
      for (let j = 0; j < MAX_CLIENTS; j++) {
        const client = svs.clients[j];
        if (client.state < ClientStateT.cs_connected) continue;
        ClientReliableWrite_Begin(client, SvcOpsT.svc_updatefrags, 4);
        ClientReliableWrite_Byte(client, i);
        ClientReliableWrite_Short(client, ent.v.frags);
      }

      host_client.old_frags = ent.v.frags | 0; // client_t's old_frags is `int` (server.h:164)
    }

    // maxspeed/entgravity changes
    const gravityOfs = GetEdictFieldValue(ent, "gravity");
    if (gravityOfs !== -1 && host_client.entgravity !== E_FLOAT(ent, gravityOfs)) {
      host_client.entgravity = E_FLOAT(ent, gravityOfs);
      ClientReliableWrite_Begin(host_client, SvcOpsT.svc_entgravity, 5);
      ClientReliableWrite_Float(host_client, host_client.entgravity);
    }
    const maxspeedOfs = GetEdictFieldValue(ent, "maxspeed");
    if (maxspeedOfs !== -1 && host_client.maxspeed !== E_FLOAT(ent, maxspeedOfs)) {
      host_client.maxspeed = E_FLOAT(ent, maxspeedOfs);
      ClientReliableWrite_Begin(host_client, SvcOpsT.svc_maxspeed, 5);
      ClientReliableWrite_Float(host_client, host_client.maxspeed);
    }
  }

  if (sv.datagram.overflowed) SZ_Clear(sv.datagram);

  // append the broadcast messages to each client messages
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const client = svs.clients[j];
    if (client.state < ClientStateT.cs_connected) continue; // reliables go to all connected or spawned

    ClientReliableCheckBlock(client, sv.reliable_datagram.cursize);
    ClientReliableWrite_SZ(client, sv.reliable_datagram.data, sv.reliable_datagram.cursize);

    if (client.state !== ClientStateT.cs_spawned) continue; // datagrams only go to spawned
    SZ_Write(client.datagram, sv.datagram.data, sv.datagram.cursize);
  }

  SZ_Clear(sv.reliable_datagram);
  SZ_Clear(sv.datagram);
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
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const c = svs.clients[i];

    if (!c.state) continue;

    if (c.drop) {
      svMainMod().SV_DropClient(c);
      c.drop = false;
      continue;
    }

    // check to see if we have a backbuf to stick in the reliable
    if (c.num_backbuf) {
      // will it fit?
      if (c.netchan.message.cursize + c.backbuf_size[0] < c.netchan.message.maxsize) {
        Con_DPrintf("%s: backbuf %d bytes\n", c.name, c.backbuf_size[0]);

        // it'll fit
        SZ_Write(c.netchan.message, c.backbuf_data[0], c.backbuf_size[0]);

        // move along, move along
        for (let j = 1; j < c.num_backbuf; j++) {
          c.backbuf_data[j - 1].set(c.backbuf_data[j].subarray(0, c.backbuf_size[j]));
          c.backbuf_size[j - 1] = c.backbuf_size[j];
        }

        c.num_backbuf--;
        if (c.num_backbuf) {
          c.backbuf = new SizeBuf();
          c.backbuf.data = c.backbuf_data[c.num_backbuf - 1];
          c.backbuf.cursize = c.backbuf_size[c.num_backbuf - 1];
          c.backbuf.maxsize = c.backbuf_data[c.num_backbuf - 1].length;
        }
      }
    }

    // if the reliable message overflowed,
    // drop the client
    if (c.netchan.message.overflowed) {
      SZ_Clear(c.netchan.message);
      SZ_Clear(c.datagram);
      SV_BroadcastPrintf(PRINT_HIGH, "%s overflowed\n", c.name);
      Con_Printf("WARNING: reliable overflow for %s\n", c.name);
      svMainMod().SV_DropClient(c);
      c.send_message = true;
      c.netchan.cleartime = 0; // don't choke this message
    }

    // only send messages if the client has sent one
    // and the bandwidth is not choked
    if (!c.send_message) continue;
    c.send_message = false; // try putting this after choke?
    if (!sv.paused && !Netchan_CanPacket(c.netchan)) {
      c.chokecount++;
      continue; // bandwidth choke
    }

    if (c.state === ClientStateT.cs_spawned) SV_SendClientDatagram(c);
    else Netchan_Transmit(c.netchan, 0, new Uint8Array(0)); // just update reliable
  }
}

/*
=======================
SV_SendMessagesToAll

FIXME: does this sequence right?
=======================
*/
export function SV_SendMessagesToAll(): void {
  for (let i = 0; i < MAX_CLIENTS; i++) {
    if (svs.clients[i].state) svs.clients[i].send_message = true; // FIXME: should this only send to active?
  }

  SV_SendClientMessages();
}
