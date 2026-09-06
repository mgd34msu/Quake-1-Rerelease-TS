/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/sv_ents.c (GNU GPL v2 or later).

sv_ents.c -- encodes the current world state into `svc_packetentities`/
`svc_deltapacketentities`, `svc_playerinfo`, and `svc_nails` messages: the
per-client fat-PVS computation (SV_FatPVS, a small dilation around the
client's eye point so head-bob doesn't clip visibility), the delta-encoding
of entity_state_t against either the client's last acknowledged frame or the
entity's baseline (SV_WriteDelta/SV_EmitPacketEntities), the special compact
nail-projectile update, and the per-player status block.

Deviations from PORTING.md / the C source:
- `SV_AddToFatPVS`/`SV_FatPVS`: identical algorithm to src/server/sv_main.ts's
  own SV_AddToFatPVS/SV_FatPVS (same C source shape); ported the same way
  (`mnode_t*`/`mleaf_t*` union narrowed with `isMleaf`, the C's implicit
  `node->contents<0` leaf test).
- `SV_Multicast`'s `Mod_PointInLeaf` dead-null-branch note applies here too
  where relevant, but this file never calls `Mod_PointInLeaf` itself.
- `NEXT_EDICT(ent)` (`SV_WriteEntitiesToClient`'s main loop): this port's
  edicts are array-indexed, not raw pointers (PORTING.md's EDICT_TO_PROG
  ruling), so the C's `for (e=..., ent=EDICT_NUM(e) ; ... ; e++, ent =
  NEXT_EDICT(ent))` becomes a single index-driven loop re-fetching
  `EDICT_NUM(e)` each iteration -- the identical sequence of edicts,
  since NEXT_EDICT(EDICT_NUM(e)) === EDICT_NUM(e+1) in both the C and this
  port's table-index scheme.
- `sv_nailmodel`/`sv_supernailmodel`/`sv_playermodel` (sv_send.c's own
  globals, set by its `SV_FindModelNumbers`) are reached through a lazy
  `require("./sv_send")`: sv_send.ts imports this file's own
  `SV_WriteEntitiesToClient` normally (SV_SendClientDatagram calls it), so a
  module-scope import back here would be a load-time cycle; sv_send.ts is
  the more fundamental of the two (imported by sv_init.ts/sv_ccmds.ts too),
  so this file breaks the cycle on its own side, per PORTING.md's rule.
- `SV_WritePlayersToClient`'s `cmd.angles[0] = 0; cmd.angles[1] =
  ent->v.angles[1]; cmd.angles[0] = 0;` (inside the `ent->v.health <= 0`
  branch): the C really does assign `angles[0]` twice and never touches
  `angles[2]` -- read directly from the source, not a transcription slip.
  Ported verbatim, exactly as the original, per this port's "faithful port" rule; not
  "fixed" to the evidently-intended `angles[2] = 0`.
- `cmd = cl->lastcmd;` (C struct-copy-by-value) is ported as a fresh
  `QwUsercmdT` with every field copied individually (`VectorCopy` for
  `angles`), so the mutations that follow (`health<=0` branch, `buttons =
  0`, `impulse = 0`) never touch the client's own stored `lastcmd`, matching
  the C's by-value-copy semantics exactly.
- `PR_GetString(ent->v.model)` dereferenced with `!*...` (empty-string test)
  becomes `=== ""`, matching src/server/sv_main.ts's own precedent for the
  identical WinQuake idiom.
- `Sys_Error ("U_REMOVE")` (SV_WriteDelta's malformed-bits guard) is the
  platform-level `Sys_Error`, not `SV_Error` -- read directly from the
  source: every *other* fatal call in this file (`SV_Error ("Unset entity
  number")`, `SV_Error ("Entity number >= 512")`) is `SV_Error`, but this one
  line is genuinely `Sys_Error` in the C.
*/

import type * as SvSendModule from "./sv_send";
import type * as SvMainModule from "./sv_main";
import { EDICT_NUM, PR_GetString, type QwEdictT } from "./progs";
import { ClientStateT, ClientT, sv, svs } from "./server";
import {
  MAX_CLIENTS,
  MAX_PACKET_ENTITIES,
  PacketEntitiesT,
  PF_COMMAND,
  PF_DEAD,
  PF_EFFECTS,
  PF_GIB,
  PF_MODEL,
  PF_MSEC,
  PF_SKINNUM,
  PF_VELOCITY1,
  PF_VELOCITY2,
  PF_VELOCITY3,
  PF_WEAPONFRAME,
  QwEntityStateT,
  QwUsercmdT,
  SvcOpsT,
  UPDATE_MASK,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_FRAME,
  U_MODEL,
  U_MOREBITS,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_REMOVE,
  U_SKIN,
  U_SOLID,
} from "../protocol";
import { MSG_WriteAngle, MSG_WriteByte, MSG_WriteCoord, MSG_WriteDeltaUsercmd, MSG_WriteShort, nullcmd, SizeBuf } from "../common";
import { DotProduct, VectorAdd, VectorCopy, vec3, type Vec3 } from "../../common/mathlib";
import { CONTENTS_SOLID, MAX_MAP_LEAFS } from "../../common/bspfile";
import { isMleaf, Mod_LeafPVS, type MleafT, type ModelT, type MnodeT } from "../../common/model";
import { Sys_Error, SysError } from "../../platform/sys";

// see file header: sv_send.ts imports this file's SV_WriteEntitiesToClient,
// so sv_nailmodel/sv_supernailmodel/sv_playermodel are reached lazily here.
function svSendMod(): typeof SvSendModule {
  return require("./sv_send");
}

// sv_main.ts imports sv_send.ts normally, and sv_send.ts imports this file's
// SV_WriteEntitiesToClient normally, so a plain import of sv_main.ts's real
// SV_Error here would complete a 3-module cycle (sv_main -> sv_send ->
// sv_ents -> sv_main); reached lazily instead, same reasoning as svSendMod().
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("sv_ents: sv.worldmodel not set");
  return sv.worldmodel;
}

function requireEdict(client: ClientT): QwEdictT {
  if (client.edict === null) throw new SysError("sv_ents: client has no edict");
  return client.edict;
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

//=============================================================================

// because there can be a lot of nails, there is a special
// network protocol for them
const MAX_NAILS = 32;
let nails: QwEdictT[] = [];
let numnails = 0;

export function SV_AddNailUpdate(ent: QwEdictT): boolean {
  if (ent.v.modelindex !== svSendMod().sv_nailmodel && ent.v.modelindex !== svSendMod().sv_supernailmodel) return false;
  if (numnails === MAX_NAILS) return true;
  nails[numnails] = ent;
  numnails++;
  return true;
}

export function SV_EmitNailUpdate(msg: SizeBuf): void {
  if (!numnails) return;

  MSG_WriteByte(msg, SvcOpsT.svc_nails);
  MSG_WriteByte(msg, numnails);

  for (let n = 0; n < numnails; n++) {
    const ent = nails[n];
    const x = Math.trunc(ent.v.origin[0] + 4096) >> 1;
    const y = Math.trunc(ent.v.origin[1] + 4096) >> 1;
    const z = Math.trunc(ent.v.origin[2] + 4096) >> 1;
    const p = Math.trunc((16 * ent.v.angles[0]) / 360) & 15;
    const yaw = Math.trunc((256 * ent.v.angles[1]) / 360) & 255;

    // [48 bits] xyzpy 12 12 12 4 8
    const bits = [x, (x >> 8) | (y << 4), y >> 4, z, (z >> 8) | (p << 4), yaw];

    for (let i = 0; i < 6; i++) MSG_WriteByte(msg, bits[i]);
  }
}

//=============================================================================

/*
==================
SV_WriteDelta

Writes part of a packetentities message.
Can delta from either a baseline or a previous packet_entity
==================
*/
export function SV_WriteDelta(from: QwEntityStateT, to: QwEntityStateT, msg: SizeBuf, force: boolean): void {
  // send an update
  let bits = 0;

  for (let i = 0; i < 3; i++) {
    const miss = to.origin[i] - from.origin[i];
    if (miss < -0.1 || miss > 0.1) bits |= U_ORIGIN1 << i;
  }

  if (to.angles[0] !== from.angles[0]) bits |= U_ANGLE1;

  if (to.angles[1] !== from.angles[1]) bits |= U_ANGLE2;

  if (to.angles[2] !== from.angles[2]) bits |= U_ANGLE3;

  if (to.colormap !== from.colormap) bits |= U_COLORMAP;

  if (to.skinnum !== from.skinnum) bits |= U_SKIN;

  if (to.frame !== from.frame) bits |= U_FRAME;

  if (to.effects !== from.effects) bits |= U_EFFECTS;

  if (to.modelindex !== from.modelindex) bits |= U_MODEL;

  if (bits & 511) bits |= U_MOREBITS;

  if (to.flags & U_SOLID) bits |= U_SOLID;

  //
  // write the message
  //
  if (!to.number) svMainMod().SV_Error("Unset entity number");
  if (to.number >= 512) svMainMod().SV_Error("Entity number >= 512");

  if (!bits && !force) return; // nothing to send!
  const i = to.number | (bits & ~511);
  if (i & U_REMOVE) Sys_Error("U_REMOVE");
  MSG_WriteShort(msg, i);

  if (bits & U_MOREBITS) MSG_WriteByte(msg, bits & 255);
  if (bits & U_MODEL) MSG_WriteByte(msg, to.modelindex);
  if (bits & U_FRAME) MSG_WriteByte(msg, to.frame);
  if (bits & U_COLORMAP) MSG_WriteByte(msg, to.colormap);
  if (bits & U_SKIN) MSG_WriteByte(msg, to.skinnum);
  if (bits & U_EFFECTS) MSG_WriteByte(msg, to.effects);
  if (bits & U_ORIGIN1) MSG_WriteCoord(msg, to.origin[0]);
  if (bits & U_ANGLE1) MSG_WriteAngle(msg, to.angles[0]);
  if (bits & U_ORIGIN2) MSG_WriteCoord(msg, to.origin[1]);
  if (bits & U_ANGLE2) MSG_WriteAngle(msg, to.angles[1]);
  if (bits & U_ORIGIN3) MSG_WriteCoord(msg, to.origin[2]);
  if (bits & U_ANGLE3) MSG_WriteAngle(msg, to.angles[2]);
}

/*
=============
SV_EmitPacketEntities

Writes a delta update of a packet_entities_t to the message.

=============
*/
export function SV_EmitPacketEntities(client: ClientT, to: PacketEntitiesT, msg: SizeBuf): void {
  // this is the frame that we are going to delta update from
  let from: PacketEntitiesT | null = null;
  let oldmax = 0;

  if (client.delta_sequence !== -1) {
    const fromframe = client.frames[client.delta_sequence & UPDATE_MASK];
    from = fromframe.entities;
    oldmax = from.num_entities;

    MSG_WriteByte(msg, SvcOpsT.svc_deltapacketentities);
    MSG_WriteByte(msg, client.delta_sequence);
  } else {
    // no delta update
    MSG_WriteByte(msg, SvcOpsT.svc_packetentities);
  }

  let newindex = 0;
  let oldindex = 0;
  while (newindex < to.num_entities || oldindex < oldmax) {
    const newnum = newindex >= to.num_entities ? 9999 : to.entities[newindex].number;
    const oldnum = from === null || oldindex >= oldmax ? 9999 : from.entities[oldindex].number;

    if (newnum === oldnum) {
      // delta update from old position
      if (from === null) throw new SysError("SV_EmitPacketEntities: from is null with a matching oldnum");
      SV_WriteDelta(from.entities[oldindex], to.entities[newindex], msg, false);
      oldindex++;
      newindex++;
      continue;
    }

    if (newnum < oldnum) {
      // this is a new entity, send it from the baseline
      const ent = EDICT_NUM(newnum);
      SV_WriteDelta(ent.baseline, to.entities[newindex], msg, true);
      newindex++;
      continue;
    }

    if (newnum > oldnum) {
      // the old entity isn't present in the new message
      MSG_WriteShort(msg, oldnum | U_REMOVE);
      oldindex++;
      continue;
    }
  }

  MSG_WriteShort(msg, 0); // end of packetentities
}

/*
=============
SV_WritePlayersToClient

=============
*/
export function SV_WritePlayersToClient(client: ClientT, clent: QwEdictT, pvs: Uint8Array, msg: SizeBuf): void {
  for (let j = 0; j < MAX_CLIENTS; j++) {
    const cl = svs.clients[j];
    if (cl.state !== ClientStateT.cs_spawned) continue;

    const ent = requireEdict(cl);

    // ZOID visibility tracking
    if (ent !== clent && !(client.spec_track && client.spec_track - 1 === j)) {
      if (cl.spectator) continue;

      // ignore if not touching a PV leaf
      let i = 0;
      for (; i < ent.num_leafs; i++) {
        if (pvs[ent.leafnums[i] >> 3] & (1 << (ent.leafnums[i] & 7))) break;
      }
      if (i === ent.num_leafs) continue; // not visible
    }

    let pflags = PF_MSEC | PF_COMMAND;

    if (ent.v.modelindex !== svSendMod().sv_playermodel) pflags |= PF_MODEL;
    for (let i = 0; i < 3; i++) {
      if (ent.v.velocity[i]) pflags |= PF_VELOCITY1 << i;
    }
    if (ent.v.effects) pflags |= PF_EFFECTS;
    if (ent.v.skin) pflags |= PF_SKINNUM;
    if (ent.v.health <= 0) pflags |= PF_DEAD;
    if (ent.v.mins[2] !== -24) pflags |= PF_GIB;

    if (cl.spectator) {
      // only sent origin and velocity to spectators
      pflags &= PF_VELOCITY1 | PF_VELOCITY2 | PF_VELOCITY3;
    } else if (ent === clent) {
      // don't send a lot of data on personal entity
      pflags &= ~(PF_MSEC | PF_COMMAND);
      if (ent.v.weaponframe) pflags |= PF_WEAPONFRAME;
    }

    if (client.spec_track && client.spec_track - 1 === j && ent.v.weaponframe) pflags |= PF_WEAPONFRAME;

    MSG_WriteByte(msg, SvcOpsT.svc_playerinfo);
    MSG_WriteByte(msg, j);
    MSG_WriteShort(msg, pflags);

    for (let i = 0; i < 3; i++) MSG_WriteCoord(msg, ent.v.origin[i]);

    MSG_WriteByte(msg, ent.v.frame);

    if (pflags & PF_MSEC) {
      let msec = Math.trunc(1000 * (sv.time - cl.localtime));
      if (msec > 255) msec = 255;
      MSG_WriteByte(msg, msec);
    }

    if (pflags & PF_COMMAND) {
      // cmd = cl->lastcmd -- a by-value struct copy in the C; see file header
      const cmd = new QwUsercmdT();
      cmd.msec = cl.lastcmd.msec;
      VectorCopy(cl.lastcmd.angles, cmd.angles);
      cmd.forwardmove = cl.lastcmd.forwardmove;
      cmd.sidemove = cl.lastcmd.sidemove;
      cmd.upmove = cl.lastcmd.upmove;
      cmd.buttons = cl.lastcmd.buttons;
      cmd.impulse = cl.lastcmd.impulse;

      if (ent.v.health <= 0) {
        // don't show the corpse looking around...
        cmd.angles[0] = 0;
        cmd.angles[1] = ent.v.angles[1];
        cmd.angles[0] = 0;
      }

      cmd.buttons = 0; // never send buttons
      cmd.impulse = 0; // never send impulses

      MSG_WriteDeltaUsercmd(msg, nullcmd, cmd);
    }

    for (let i = 0; i < 3; i++) {
      if (pflags & (PF_VELOCITY1 << i)) MSG_WriteShort(msg, ent.v.velocity[i]);
    }

    if (pflags & PF_MODEL) MSG_WriteByte(msg, ent.v.modelindex);

    if (pflags & PF_SKINNUM) MSG_WriteByte(msg, ent.v.skin);

    if (pflags & PF_EFFECTS) MSG_WriteByte(msg, ent.v.effects);

    if (pflags & PF_WEAPONFRAME) MSG_WriteByte(msg, ent.v.weaponframe);
  }
}

/*
=============
SV_WriteEntitiesToClient

Encodes the current state of the world as
a svc_packetentities messages and possibly
a svc_nails message and
svc_playerinfo messages
=============
*/
export function SV_WriteEntitiesToClient(client: ClientT, msg: SizeBuf): void {
  // this is the frame we are creating
  const frame = client.frames[client.netchan.incoming_sequence & UPDATE_MASK];

  // find the client's PVS
  const clent = requireEdict(client);
  const org = vec3();
  VectorAdd(clent.v.origin, clent.v.view_ofs, org);
  const pvs = SV_FatPVS(org);

  // send over the players in the PVS
  SV_WritePlayersToClient(client, clent, pvs, msg);

  // put other visible entities into either a packet_entities or a nails message
  const pack = frame.entities;
  pack.num_entities = 0;

  numnails = 0;

  for (let e = MAX_CLIENTS + 1; e < sv.num_edicts; e++) {
    const ent = EDICT_NUM(e); // NEXT_EDICT(ent) is EDICT_NUM(e+1) in this port -- see file header

    // ignore ents without visible models
    if (!ent.v.modelindex || PR_GetString(ent.v.model) === "") continue;

    // ignore if not touching a PV leaf
    let i = 0;
    for (; i < ent.num_leafs; i++) {
      if (pvs[ent.leafnums[i] >> 3] & (1 << (ent.leafnums[i] & 7))) break;
    }

    if (i === ent.num_leafs) continue; // not visible

    if (SV_AddNailUpdate(ent)) continue; // added to the special update list

    // add to the packetentities
    if (pack.num_entities === MAX_PACKET_ENTITIES) continue; // all full

    const state = pack.entities[pack.num_entities];
    pack.num_entities++;

    state.number = e;
    state.flags = 0;
    VectorCopy(ent.v.origin, state.origin);
    VectorCopy(ent.v.angles, state.angles);
    state.modelindex = ent.v.modelindex;
    state.frame = ent.v.frame;
    state.colormap = ent.v.colormap;
    state.skinnum = ent.v.skin;
    state.effects = ent.v.effects;
  }

  // encode the packet entities as a delta from the
  // last packetentities acknowledged by the client

  SV_EmitPacketEntities(client, pack, msg);

  // now add the specialized nail update
  SV_EmitNailUpdate(msg);
}
