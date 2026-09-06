/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_ents.c (GNU GPL v2 or later).

cl_ents.c -- entity parsing and management

Deviations from PORTING.md / the C source:
- `entity_t` in QW/client/render.h carries two members WinQuake's does not:
  `int keynum` (frame-to-frame entity matching, for the particle trails) and
  `struct player_info_s *scoreboard` (the per-player custom skin the QW
  renderers read). Both are fields on `EntityT` (src/client/render.ts), inert
  on the WinQuake path, so this file writes them directly.
- `cl_visedicts_list[2][MAX_VISEDICTS]` / `cl_visedicts` / `cl_oldvisedicts` /
  `cl_numvisedicts` / `cl_oldnumvisedicts` are QW cl_main.c globals. cl_main.c
  is another unit's file (Q021) and `cl_visedicts`/`cl_oldvisedicts` are
  reassigned pointers, so the two backing arrays and the which-half-is-current
  state live here, in the file whose CL_EmitEntities is the only code that
  swaps them. The current half is published into the shared
  `cl_visedicts`/`clState.cl_numvisedicts` (src/client/client.ts) that both
  renderers and cl_tent.c's CL_NewTempEntity already read, so every consumer
  outside this unit sees the QW list through the name it already uses.
- `dlight_t` gains `float color[4]` in QW/client/client.h, which CL_NewDlight
  fills per light type. It is a field on `DlightT` (src/client/client.ts),
  inert on the WinQuake path, so this file writes `dl.color[0..3]` exactly
  where the C writes `dl->color[0..3]`.
- The `#ifdef GLQUAKE` in CL_LinkPlayers guards the player dlight spawn with
  `!gl_flashblend.value || j != cl.playernum`. Both branches are ported. Which
  one runs is decided by `re.current.isGL` (src/client/render.ts's runtime
  stand-in for the compile-time macro, see that file's header). `gl_flashblend`
  itself is declared by gl_rmain.c only -- the software renderer has no such
  cvar at all -- so there is nothing to put on the Renderer interface and no
  module a client file may import it from; its value is read from the shared
  cvar registry by name, which is safe precisely because `isGL` already
  guarantees the GL renderer is loaded and has registered it.
- `EF_FLAG1`/`EF_FLAG2`/`EF_BLUE`/`EF_RED` are QW/client/model.h's four
  additions to the EF_BRIGHTFIELD..EF_DIMLIGHT block. src/common/model.ts
  deliberately does not declare that block (src/server/server.ts owns it, and
  QW's model.h delta belongs to Q024), so the four QW-only values are declared
  and exported here rather than duplicated in each file that wants them.
  `EF_BRIGHTLIGHT`/`EF_DIMLIGHT` are imported from src/server/server.ts, the
  module that already owns them, the same way src/client/cl_main.ts does.
- `entity_state_t` assignment (`*to = *from`, `newp->entities[newindex] =
  oldp->entities[oldindex]`) becomes `copyEntityState`, a field-by-field copy;
  `QwEntityStateT` (src/qw/protocol.ts, out of SCOPE) has `clear()` but no
  copy method.
- `abs(old_origin[i] - ent->origin[i]) > 128` in CL_LinkPacketEntities calls
  `int abs(int)` on a float difference, so the C truncates toward zero before
  taking the magnitude; ported as `Math.abs(Math.trunc(...))`.
- `msec = 500*(playertime - state->state_time)` and CL_ParseProjectiles'
  `360*(bits[4]>>4)/16` / `360*bits[5]/256` are integer expressions in the C
  (int assignment, int division); ported with Math.trunc.
- `cl.model_precache[i]` is `ModelT | null` in this port where the C has a
  possibly-dangling pointer it dereferences without checking. CL_LinkPacketEntities
  reads the model before allocating its visedict slot and skips the entity when
  the precache entry is null, so a missing model leaves no half-filled entity
  in the render list; the C would crash there.
- CL_ParsePlayerinfo's `player_info_t *info = &cl.players[num];` is unused in
  2.33 (a leftover of the CTF merge); dropped rather than kept as a dead local.
- Dropped `#ifdef` branches: none besides the GLQUAKE site described above,
  which is ported both ways.
*/

import { anglemod, AngleVectors, type Vec3, vec3, vec3_origin, VectorCopy } from "../../common/mathlib";
import { PITCH, ROLL, YAW } from "../../common/quakedef";
import { CactiveT, cl, cl_dlights, cl_visedicts, cls, clState, DlightT, MAX_DLIGHTS, MAX_VISEDICTS } from "../../client/client";
import { EntityT, re } from "../../client/render";
import { vid } from "../../client/vid";
import { V_CalcRoll } from "../../client/view";
import { R_RocketTrail } from "./r_part";
import { Con_DPrintf, Con_Printf } from "./console";
import { Cvar_FindVar } from "../../common/cvar";
import { Sys_Error } from "../../platform/sys";
import { EF_GIB, EF_GRENADE, EF_ROCKET, EF_ROTATE, EF_TRACER, EF_TRACER2, EF_TRACER3, EF_ZOMGIB } from "../../common/model";
import { EF_BRIGHTLIGHT, EF_DIMLIGHT } from "../../server/server";
import {
  msgState,
  MSG_ReadAngle,
  MSG_ReadByte,
  MSG_ReadCoord,
  MSG_ReadDeltaUsercmd,
  MSG_ReadShort,
  nullcmd,
} from "../common";
import {
  MAX_CLIENTS,
  MAX_PACKET_ENTITIES,
  PacketEntitiesT,
  PF_COMMAND,
  PF_DEAD,
  PF_EFFECTS,
  PF_MODEL,
  PF_MSEC,
  PF_SKINNUM,
  PF_VELOCITY1,
  PF_WEAPONFRAME,
  QwEntityStateT,
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
  UPDATE_BACKUP,
  UPDATE_MASK,
} from "../protocol";
import { player_maxs, player_mins, pmove } from "../pmove_types";
import { cl_baselines, PlayerStateT } from "./client";
import { CL_PredictUsercmd } from "./cl_pred";
import { Cam_DrawPlayer } from "./cl_cam";
import { cl_predict_players, cl_predict_players2, cl_solid_players, clMainState, Host_EndGame } from "./cl_main";
import { parseState } from "./cl_parse";
import { CL_NewTempEntity, CL_UpdateTEnts } from "./cl_tent";

// QW/client/model.h's four additions to WinQuake's EF_ block; see file header.
export const EF_FLAG1 = 16;
export const EF_FLAG2 = 32;
export const EF_BLUE = 64;
export const EF_RED = 128;

// cl_ents.c's `rand()`; no port-wide helper exists (see src/client/r_part.ts)
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

function copyEntityState(from: QwEntityStateT, to: QwEntityStateT): void {
  to.number = from.number;
  to.flags = from.flags;
  to.origin[0] = from.origin[0];
  to.origin[1] = from.origin[1];
  to.origin[2] = from.origin[2];
  to.angles[0] = from.angles[0];
  to.angles[1] = from.angles[1];
  to.angles[2] = from.angles[2];
  to.modelindex = from.modelindex;
  to.frame = from.frame;
  to.colormap = from.colormap;
  to.skinnum = from.skinnum;
  to.effects = from.effects;
}

// CL_LinkPlayers's `#ifdef GLQUAKE` guard -- see file header. Returns 0
// whenever the GL branch does not exist (software renderer, or no renderer
// at all), which makes the guard vacuously true, exactly as the #else side.
export function glFlashblend(): number {
  if (!re.current?.isGL) return 0;
  const v = Cvar_FindVar("gl_flashblend");
  return v === null ? 0 : v.value;
}

function makeArray<T>(n: number, make: () => T): T[] {
  const a: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

class PredictedPlayerT {
  flags = 0;
  active = false;
  origin: Vec3 = vec3(); // predicted origin
}

const predicted_players: PredictedPlayerT[] = makeArray(MAX_CLIENTS, () => new PredictedPlayerT());

//
// cl_main.c's `entity_t cl_visedicts_list[2][MAX_VISEDICTS]` and the two
// pointers into it (see file header).
//
export const cl_visedicts_list: [EntityT[], EntityT[]] = [
  makeArray(MAX_VISEDICTS, () => new EntityT()),
  makeArray(MAX_VISEDICTS, () => new EntityT()),
];

// which half of cl_visedicts_list is `cl_visedicts` and which is
// `cl_oldvisedicts`, plus `cl_oldnumvisedicts`
export const visState = { list: 0, oldlist: 1, cl_oldnumvisedicts: 0 };

//============================================================

/*
===============
CL_AllocDlight

===============
*/
export function CL_AllocDlight(key: number): DlightT {
  let dl: DlightT;

  // first look for an exact key match
  if (key) {
    for (let i = 0; i < MAX_DLIGHTS; i++) {
      dl = cl_dlights[i];
      if (dl.key === key) {
        clearDlight(i);
        dl.key = key;
        return dl;
      }
    }
  }

  // then look for anything else
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    dl = cl_dlights[i];
    if (dl.die < cl.time) {
      clearDlight(i);
      dl.key = key;
      return dl;
    }
  }

  dl = cl_dlights[0];
  clearDlight(0);
  dl.key = key;
  return dl;
}

// memset (dl, 0, sizeof(*dl))
function clearDlight(i: number): void {
  const dl = cl_dlights[i];
  dl.origin[0] = dl.origin[1] = dl.origin[2] = 0;
  dl.radius = 0;
  dl.die = 0;
  dl.decay = 0;
  dl.minlight = 0;
  dl.key = 0;
  dl.color.fill(0);
}

/*
===============
CL_NewDlight
===============
*/
export function CL_NewDlight(key: number, x: number, y: number, z: number, radius: number, time: number, type: number): void {
  const dl = CL_AllocDlight(key);
  dl.origin[0] = x;
  dl.origin[1] = y;
  dl.origin[2] = z;
  dl.radius = radius;
  dl.die = cl.time + time;

  const color = dl.color;
  if (type === 0) {
    color[0] = 0.2;
    color[1] = 0.1;
    color[2] = 0.05;
    color[3] = 0.7;
  } else if (type === 1) {
    color[0] = 0.05;
    color[1] = 0.05;
    color[2] = 0.3;
    color[3] = 0.7;
  } else if (type === 2) {
    color[0] = 0.5;
    color[1] = 0.05;
    color[2] = 0.05;
    color[3] = 0.7;
  } else if (type === 3) {
    color[0] = 0.5;
    color[1] = 0.05;
    color[2] = 0.4;
    color[3] = 0.7;
  }
}

/*
===============
CL_DecayLights

===============
*/
export function CL_DecayLights(): void {
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    const dl = cl_dlights[i];
    if (dl.die < cl.time || !dl.radius) continue;

    dl.radius -= clMainState.host_frametime * dl.decay;
    if (dl.radius < 0) dl.radius = 0;
  }
}

/*
=========================================================================

PACKET ENTITY PARSING / LINKING

=========================================================================
*/

/*
==================
CL_ParseDelta

Can go from either a baseline or a previous packet_entity
==================
*/
export const bitcounts = new Int32Array(32); /// just for protocol profiling

export function CL_ParseDelta(from: QwEntityStateT, to: QwEntityStateT, bits: number): void {
  // set everything to the state we are delta'ing from
  copyEntityState(from, to);

  to.number = bits & 511;
  bits &= ~511;

  if (bits & U_MOREBITS) {
    // read in the low order bits
    const i = MSG_ReadByte();
    bits |= i;
  }

  // count the bits for net profiling
  for (let i = 0; i < 16; i++) if (bits & (1 << i)) bitcounts[i]++;

  to.flags = bits;

  if (bits & U_MODEL) to.modelindex = MSG_ReadByte();

  if (bits & U_FRAME) to.frame = MSG_ReadByte();

  if (bits & U_COLORMAP) to.colormap = MSG_ReadByte();

  if (bits & U_SKIN) to.skinnum = MSG_ReadByte();

  if (bits & U_EFFECTS) to.effects = MSG_ReadByte();

  if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadCoord();

  if (bits & U_ANGLE1) to.angles[0] = MSG_ReadAngle();

  if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadCoord();

  if (bits & U_ANGLE2) to.angles[1] = MSG_ReadAngle();

  if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadCoord();

  if (bits & U_ANGLE3) to.angles[2] = MSG_ReadAngle();

  // if (bits & U_SOLID)
  // {
  //	 FIXME
  // }
}

/*
=================
FlushEntityPacket
=================
*/
export function FlushEntityPacket(): void {
  const olde = new QwEntityStateT();
  const newe = new QwEntityStateT();

  Con_DPrintf("FlushEntityPacket\n");

  olde.clear();

  cl.qw.validsequence = 0; // can't render a frame
  cl.qw.frames[cls.qw.netchan.incoming_sequence & UPDATE_MASK].invalid = true;

  // read it all, but ignore it
  for (;;) {
    const word = MSG_ReadShort() & 0xffff;
    if (msgState.badread) {
      // something didn't parse right...
      Host_EndGame("msg_badread in packetentities");
      return;
    }

    if (!word) break; // done

    CL_ParseDelta(olde, newe, word);
  }
}

/*
==================
CL_ParsePacketEntities

An svc_packetentities has just been parsed, deal with the
rest of the data stream.
==================
*/
export function CL_ParsePacketEntities(delta: boolean): void {
  let oldpacket: number;
  let oldp: PacketEntitiesT;
  const dummy = new PacketEntitiesT();

  const newpacket = cls.qw.netchan.incoming_sequence & UPDATE_MASK;
  const newp = cl.qw.frames[newpacket].packet_entities;
  cl.qw.frames[newpacket].invalid = false;

  if (delta) {
    const from = MSG_ReadByte();

    oldpacket = cl.qw.frames[newpacket].delta_sequence;

    if ((from & UPDATE_MASK) !== (oldpacket & UPDATE_MASK)) Con_DPrintf("WARNING: from mismatch\n");
  } else oldpacket = -1;

  let full = false;
  if (oldpacket !== -1) {
    if (cls.qw.netchan.outgoing_sequence - oldpacket >= UPDATE_BACKUP - 1) {
      // we can't use this, it is too old
      FlushEntityPacket();
      return;
    }
    cl.qw.validsequence = cls.qw.netchan.incoming_sequence;
    oldp = cl.qw.frames[oldpacket & UPDATE_MASK].packet_entities;
  } else {
    // this is a full update that we can start delta compressing from now
    oldp = dummy;
    dummy.num_entities = 0;
    cl.qw.validsequence = cls.qw.netchan.incoming_sequence;
    full = true;
  }

  let oldindex = 0;
  let newindex = 0;
  newp.num_entities = 0;

  for (;;) {
    const word = MSG_ReadShort() & 0xffff;
    if (msgState.badread) {
      // something didn't parse right...
      Host_EndGame("msg_badread in packetentities");
      return;
    }

    if (!word) {
      while (oldindex < oldp.num_entities) {
        // copy all the rest of the entities from the old packet
        if (newindex >= MAX_PACKET_ENTITIES) Host_EndGame("CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES");
        copyEntityState(oldp.entities[oldindex], newp.entities[newindex]);
        newindex++;
        oldindex++;
      }
      break;
    }
    const newnum = word & 511;
    let oldnum = oldindex >= oldp.num_entities ? 9999 : oldp.entities[oldindex].number;

    while (newnum > oldnum) {
      if (full) {
        Con_Printf("WARNING: oldcopy on full update");
        FlushEntityPacket();
        return;
      }

      // copy one of the old entities over to the new packet unchanged
      if (newindex >= MAX_PACKET_ENTITIES) Host_EndGame("CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES");
      copyEntityState(oldp.entities[oldindex], newp.entities[newindex]);
      newindex++;
      oldindex++;
      oldnum = oldindex >= oldp.num_entities ? 9999 : oldp.entities[oldindex].number;
    }

    if (newnum < oldnum) {
      // new from baseline
      if (word & U_REMOVE) {
        if (full) {
          cl.qw.validsequence = 0;
          Con_Printf("WARNING: U_REMOVE on full update\n");
          FlushEntityPacket();
          return;
        }
        continue;
      }
      if (newindex >= MAX_PACKET_ENTITIES) Host_EndGame("CL_ParsePacketEntities: newindex == MAX_PACKET_ENTITIES");
      CL_ParseDelta(cl_baselines[newnum], newp.entities[newindex], word);
      newindex++;
      continue;
    }

    if (newnum === oldnum) {
      // delta from previous
      if (full) {
        cl.qw.validsequence = 0;
        Con_Printf("WARNING: delta on full update");
      }
      if (word & U_REMOVE) {
        oldindex++;
        continue;
      }
      CL_ParseDelta(oldp.entities[oldindex], newp.entities[newindex], word);
      newindex++;
      oldindex++;
    }
  }

  newp.num_entities = newindex;
}

/*
===============
CL_LinkPacketEntities

===============
*/
export function CL_LinkPacketEntities(): void {
  const old_origin: Vec3 = vec3();

  const pack = cl.qw.frames[cls.qw.netchan.incoming_sequence & UPDATE_MASK].packet_entities;

  const autorotate = anglemod(100 * cl.time);

  const f = 0; // FIXME: no interpolation right now

  for (let pnum = 0; pnum < pack.num_entities; pnum++) {
    const s1 = pack.entities[pnum];
    const s2 = s1; // FIXME: no interpolation right now

    // spawn light flashes, even ones coming from invisible objects
    if ((s1.effects & (EF_BLUE | EF_RED)) === (EF_BLUE | EF_RED))
      CL_NewDlight(s1.number, s1.origin[0], s1.origin[1], s1.origin[2], 200 + (rand() & 31), 0.1, 3);
    else if (s1.effects & EF_BLUE) CL_NewDlight(s1.number, s1.origin[0], s1.origin[1], s1.origin[2], 200 + (rand() & 31), 0.1, 1);
    else if (s1.effects & EF_RED) CL_NewDlight(s1.number, s1.origin[0], s1.origin[1], s1.origin[2], 200 + (rand() & 31), 0.1, 2);
    else if (s1.effects & EF_BRIGHTLIGHT)
      CL_NewDlight(s1.number, s1.origin[0], s1.origin[1], s1.origin[2] + 16, 400 + (rand() & 31), 0.1, 0);
    else if (s1.effects & EF_DIMLIGHT) CL_NewDlight(s1.number, s1.origin[0], s1.origin[1], s1.origin[2], 200 + (rand() & 31), 0.1, 0);

    // if set to invisible, skip
    if (!s1.modelindex) continue;

    const model = cl.model_precache[s1.modelindex];
    if (model === null) continue; // see file header: the C dereferences this

    // create a new entity
    if (clState.cl_numvisedicts === MAX_VISEDICTS) break; // object list is full

    const slot = clState.cl_numvisedicts;
    const ent = cl_visedicts_list[visState.list][slot];
    clState.cl_numvisedicts++;

    ent.keynum = s1.number;
    ent.model = model;

    // set colormap
    if (s1.colormap && s1.colormap < MAX_CLIENTS && model.name === "progs/player.mdl") {
      ent.colormap = cl.qw.players[s1.colormap - 1].translations;
      ent.scoreboard = cl.qw.players[s1.colormap - 1];
    } else {
      ent.colormap = vid.colormap;
      ent.scoreboard = null;
    }

    // set skin
    ent.skinnum = s1.skinnum;

    // set frame
    ent.frame = s1.frame;

    // rotate binary objects locally
    if (model.flags & EF_ROTATE) {
      ent.angles[0] = 0;
      ent.angles[1] = autorotate;
      ent.angles[2] = 0;
    } else {
      for (let i = 0; i < 3; i++) {
        let a1 = s1.angles[i];
        const a2 = s2.angles[i];
        if (a1 - a2 > 180) a1 -= 360;
        if (a1 - a2 < -180) a1 += 360;
        ent.angles[i] = a2 + f * (a1 - a2);
      }
    }

    // calculate origin
    for (let i = 0; i < 3; i++) ent.origin[i] = s2.origin[i] + f * (s1.origin[i] - s2.origin[i]);

    // add automatic particle trails
    if (!model.flags) continue;

    // scan the old entity display list for a matching
    let i = 0;
    for (; i < visState.cl_oldnumvisedicts; i++) {
      if (cl_visedicts_list[visState.oldlist][i].keynum === ent.keynum) {
        VectorCopy(cl_visedicts_list[visState.oldlist][i].origin, old_origin);
        break;
      }
    }
    if (i === visState.cl_oldnumvisedicts) continue; // not in last message

    for (let j = 0; j < 3; j++) {
      if (Math.abs(Math.trunc(old_origin[j] - ent.origin[j])) > 128) {
        // no trail if too far
        VectorCopy(ent.origin, old_origin);
        break;
      }
    }
    if (model.flags & EF_ROCKET) {
      R_RocketTrail(old_origin, ent.origin, 0);
      const dl = CL_AllocDlight(s1.number);
      VectorCopy(ent.origin, dl.origin);
      dl.radius = 200;
      dl.die = cl.time + 0.1;
    } else if (model.flags & EF_GRENADE) R_RocketTrail(old_origin, ent.origin, 1);
    else if (model.flags & EF_GIB) R_RocketTrail(old_origin, ent.origin, 2);
    else if (model.flags & EF_ZOMGIB) R_RocketTrail(old_origin, ent.origin, 4);
    else if (model.flags & EF_TRACER) R_RocketTrail(old_origin, ent.origin, 3);
    else if (model.flags & EF_TRACER2) R_RocketTrail(old_origin, ent.origin, 5);
    else if (model.flags & EF_TRACER3) R_RocketTrail(old_origin, ent.origin, 6);
  }
}

/*
=========================================================================

PROJECTILE PARSING / LINKING

=========================================================================
*/

class ProjectileT {
  modelindex = 0;
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
}

export const MAX_PROJECTILES = 32;
export const cl_projectiles: ProjectileT[] = makeArray(MAX_PROJECTILES, () => new ProjectileT());
export const projState = { cl_num_projectiles: 0 };

export function CL_ClearProjectiles(): void {
  projState.cl_num_projectiles = 0;
}

/*
=====================
CL_ParseProjectiles

Nails are passed as efficient temporary entities
=====================
*/
export function CL_ParseProjectiles(): void {
  const bits = new Uint8Array(6);

  const c = MSG_ReadByte();
  for (let i = 0; i < c; i++) {
    for (let j = 0; j < 6; j++) bits[j] = MSG_ReadByte();

    if (projState.cl_num_projectiles === MAX_PROJECTILES) continue;

    const pr = cl_projectiles[projState.cl_num_projectiles];
    projState.cl_num_projectiles++;

    pr.modelindex = parseState.cl_spikeindex;
    pr.origin[0] = ((bits[0] + ((bits[1] & 15) << 8)) << 1) - 4096;
    pr.origin[1] = (((bits[1] >> 4) + (bits[2] << 4)) << 1) - 4096;
    pr.origin[2] = ((bits[3] + ((bits[4] & 15) << 8)) << 1) - 4096;
    pr.angles[0] = Math.trunc((360 * (bits[4] >> 4)) / 16);
    pr.angles[1] = Math.trunc((360 * bits[5]) / 256);
  }
}

/*
=============
CL_LinkProjectiles

=============
*/
export function CL_LinkProjectiles(): void {
  for (let i = 0; i < projState.cl_num_projectiles; i++) {
    const pr = cl_projectiles[i];

    // grab an entity to fill in
    if (clState.cl_numvisedicts === MAX_VISEDICTS) break; // object list is full
    const slot = clState.cl_numvisedicts;
    const ent = cl_visedicts_list[visState.list][slot];
    clState.cl_numvisedicts++;
    ent.keynum = 0;

    if (pr.modelindex < 1) continue;
    ent.model = cl.model_precache[pr.modelindex];
    ent.skinnum = 0;
    ent.frame = 0;
    ent.colormap = vid.colormap;
    ent.scoreboard = null;
    VectorCopy(pr.origin, ent.origin);
    VectorCopy(pr.angles, ent.angles);
  }
}

//========================================

/*
===================
CL_ParsePlayerinfo
===================
*/
export function CL_ParsePlayerinfo(): void {
  const num = MSG_ReadByte();
  if (num > MAX_CLIENTS) Sys_Error("CL_ParsePlayerinfo: bad num");

  const state = cl.qw.frames[parseState.parsecountmod].playerstate[num];

  const flags = (state.flags = MSG_ReadShort());

  state.messagenum = cl.qw.parsecount;
  state.origin[0] = MSG_ReadCoord();
  state.origin[1] = MSG_ReadCoord();
  state.origin[2] = MSG_ReadCoord();

  state.frame = MSG_ReadByte();

  // the other player's last move was likely some time
  // before the packet was sent out, so accurately track
  // the exact time it was valid at
  if (flags & PF_MSEC) {
    const msec = MSG_ReadByte();
    state.state_time = parseState.parsecounttime - msec * 0.001;
  } else state.state_time = parseState.parsecounttime;

  if (flags & PF_COMMAND) MSG_ReadDeltaUsercmd(nullcmd, state.command);

  for (let i = 0; i < 3; i++) {
    if (flags & (PF_VELOCITY1 << i)) state.velocity[i] = MSG_ReadShort();
    else state.velocity[i] = 0;
  }
  if (flags & PF_MODEL) state.modelindex = MSG_ReadByte();
  else state.modelindex = parseState.cl_playerindex;

  if (flags & PF_SKINNUM) state.skinnum = MSG_ReadByte();
  else state.skinnum = 0;

  if (flags & PF_EFFECTS) state.effects = MSG_ReadByte();
  else state.effects = 0;

  if (flags & PF_WEAPONFRAME) state.weaponframe = MSG_ReadByte();
  else state.weaponframe = 0;

  VectorCopy(state.command.angles, state.viewangles);
}

/*
================
CL_AddFlagModels

Called when the CTF flags are set
================
*/
export function CL_AddFlagModels(ent: EntityT, team: number): void {
  const v_forward: Vec3 = vec3();
  const v_right: Vec3 = vec3();
  const v_up: Vec3 = vec3();

  if (parseState.cl_flagindex === -1) return;

  let f = 14;
  if (ent.frame >= 29 && ent.frame <= 40) {
    if (ent.frame >= 29 && ent.frame <= 34) {
      //axpain
      if (ent.frame === 29) f = f + 2;
      else if (ent.frame === 30) f = f + 8;
      else if (ent.frame === 31) f = f + 12;
      else if (ent.frame === 32) f = f + 11;
      else if (ent.frame === 33) f = f + 10;
      else if (ent.frame === 34) f = f + 4;
    } else if (ent.frame >= 35 && ent.frame <= 40) {
      // pain
      if (ent.frame === 35) f = f + 2;
      else if (ent.frame === 36) f = f + 10;
      else if (ent.frame === 37) f = f + 10;
      else if (ent.frame === 38) f = f + 8;
      else if (ent.frame === 39) f = f + 4;
      else if (ent.frame === 40) f = f + 2;
    }
  } else if (ent.frame >= 103 && ent.frame <= 118) {
    if (ent.frame >= 103 && ent.frame <= 104) f = f + 6; //nailattack
    else if (ent.frame >= 105 && ent.frame <= 106) f = f + 6; //light
    else if (ent.frame >= 107 && ent.frame <= 112) f = f + 7; //rocketattack
    else if (ent.frame >= 112 && ent.frame <= 118) f = f + 7; //shotattack
  }

  const newent = CL_NewTempEntity();
  if (newent === null) return;
  newent.model = cl.model_precache[parseState.cl_flagindex];
  newent.skinnum = team;

  AngleVectors(ent.angles, v_forward, v_right, v_up);
  v_forward[2] = -v_forward[2]; // reverse z component
  for (let i = 0; i < 3; i++) newent.origin[i] = ent.origin[i] - f * v_forward[i] + 22 * v_right[i];
  newent.origin[2] -= 16;

  VectorCopy(ent.angles, newent.angles);
  newent.angles[2] -= 45;
}

/*
=============
CL_LinkPlayers

Create visible entities in the correct position
for all current players
=============
*/
export function CL_LinkPlayers(): void {
  const exact: PlayerStateT = new PlayerStateT();

  let playertime = clMainState.realtime - cls.qw.latency + 0.02;
  if (playertime > clMainState.realtime) playertime = clMainState.realtime;

  const frame = cl.qw.frames[cl.qw.parsecount & UPDATE_MASK];

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const info = cl.qw.players[j];
    const state = frame.playerstate[j];

    if (state.messagenum !== cl.qw.parsecount) continue; // not present this frame

    // spawn light flashes, even ones coming from invisible objects
    // #ifdef GLQUAKE: `if (!gl_flashblend.value || j != cl.playernum)`; see
    // the file header for how the GL branch is selected here
    if (!glFlashblend() || j !== cl.qw.playernum) {
      if ((state.effects & (EF_BLUE | EF_RED)) === (EF_BLUE | EF_RED))
        CL_NewDlight(j, state.origin[0], state.origin[1], state.origin[2], 200 + (rand() & 31), 0.1, 3);
      else if (state.effects & EF_BLUE) CL_NewDlight(j, state.origin[0], state.origin[1], state.origin[2], 200 + (rand() & 31), 0.1, 1);
      else if (state.effects & EF_RED) CL_NewDlight(j, state.origin[0], state.origin[1], state.origin[2], 200 + (rand() & 31), 0.1, 2);
      else if (state.effects & EF_BRIGHTLIGHT)
        CL_NewDlight(j, state.origin[0], state.origin[1], state.origin[2] + 16, 400 + (rand() & 31), 0.1, 0);
      else if (state.effects & EF_DIMLIGHT)
        CL_NewDlight(j, state.origin[0], state.origin[1], state.origin[2], 200 + (rand() & 31), 0.1, 0);
    }

    // the player object never gets added
    if (j === cl.qw.playernum) continue;

    if (!state.modelindex) continue;

    if (!Cam_DrawPlayer(j)) continue;

    // grab an entity to fill in
    if (clState.cl_numvisedicts === MAX_VISEDICTS) break; // object list is full
    const slot = clState.cl_numvisedicts;
    const ent = cl_visedicts_list[visState.list][slot];
    clState.cl_numvisedicts++;
    ent.keynum = 0;

    ent.model = cl.model_precache[state.modelindex];
    ent.skinnum = state.skinnum;
    ent.frame = state.frame;
    ent.colormap = info.translations;
    if (state.modelindex === parseState.cl_playerindex) ent.scoreboard = info; // use custom skin
    else ent.scoreboard = null;

    //
    // angles
    //
    ent.angles[PITCH] = -state.viewangles[PITCH] / 3;
    ent.angles[YAW] = state.viewangles[YAW];
    ent.angles[ROLL] = 0;
    ent.angles[ROLL] = V_CalcRoll(ent.angles, state.velocity) * 4;

    // only predict half the move to minimize overruns
    let msec = Math.trunc(500 * (playertime - state.state_time));
    if (msec <= 0 || (!cl_predict_players.value && !cl_predict_players2.value)) {
      VectorCopy(state.origin, ent.origin);
    } else {
      // predict players movement
      if (msec > 255) msec = 255;
      state.command.msec = msec;

      const oldphysent = pmove.numphysent;
      CL_SetSolidPlayers(j);
      CL_PredictUsercmd(state, exact, state.command, false);
      pmove.numphysent = oldphysent;
      VectorCopy(exact.origin, ent.origin);
    }

    if (state.effects & EF_FLAG1) CL_AddFlagModels(ent, 0);
    else if (state.effects & EF_FLAG2) CL_AddFlagModels(ent, 1);
  }
}

//======================================================================

/*
===============
CL_SetSolid

Builds all the pmove physents for the current frame
===============
*/
export function CL_SetSolidEntities(): void {
  pmove.physents[0].model = cl.worldmodel;
  VectorCopy(vec3_origin, pmove.physents[0].origin);
  pmove.physents[0].info = 0;
  pmove.numphysent = 1;

  const frame = cl.qw.frames[parseState.parsecountmod];
  const pak = frame.packet_entities;

  for (let i = 0; i < pak.num_entities; i++) {
    const state = pak.entities[i];

    if (!state.modelindex) continue;
    const model = cl.model_precache[state.modelindex];
    if (model === null) continue;
    if (model.hulls[1].firstclipnode || model.clipbox) {
      pmove.physents[pmove.numphysent].model = model;
      VectorCopy(state.origin, pmove.physents[pmove.numphysent].origin);
      pmove.numphysent++;
    }
  }
}

/*
===
Calculate the new position of players, without other player clipping

We do this to set up real player prediction.
Players are predicted twice, first without clipping other players,
then with clipping against them.
This sets up the first phase.
===
*/
export function CL_SetUpPlayerPrediction(dopred: boolean): void {
  const exact: PlayerStateT = new PlayerStateT();

  let playertime = clMainState.realtime - cls.qw.latency + 0.02;
  if (playertime > clMainState.realtime) playertime = clMainState.realtime;

  const frame = cl.qw.frames[cl.qw.parsecount & UPDATE_MASK];

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const pplayer = predicted_players[j];
    const state = frame.playerstate[j];

    pplayer.active = false;

    if (state.messagenum !== cl.qw.parsecount) continue; // not present this frame

    if (!state.modelindex) continue;

    pplayer.active = true;
    pplayer.flags = state.flags;

    // note that the local player is special, since he moves locally
    // we use his last predicted postition
    if (j === cl.qw.playernum) {
      VectorCopy(cl.qw.frames[cls.qw.netchan.outgoing_sequence & UPDATE_MASK].playerstate[cl.qw.playernum].origin, pplayer.origin);
    } else {
      // only predict half the move to minimize overruns
      let msec = Math.trunc(500 * (playertime - state.state_time));
      if (msec <= 0 || (!cl_predict_players.value && !cl_predict_players2.value) || !dopred) {
        VectorCopy(state.origin, pplayer.origin);
      } else {
        // predict players movement
        if (msec > 255) msec = 255;
        state.command.msec = msec;

        CL_PredictUsercmd(state, exact, state.command, false);
        VectorCopy(exact.origin, pplayer.origin);
      }
    }
  }
}

/*
===============
CL_SetSolid

Builds all the pmove physents for the current frame
Note that CL_SetUpPlayerPrediction() must be called first!
pmove must be setup with world and solid entity hulls before calling
(via CL_PredictMove)
===============
*/
export function CL_SetSolidPlayers(playernum: number): void {
  if (!cl_solid_players.value) return;

  for (let j = 0; j < MAX_CLIENTS; j++) {
    const pplayer = predicted_players[j];

    if (!pplayer.active) continue; // not present this frame

    // the player object never gets added
    if (j === playernum) continue;

    if (pplayer.flags & PF_DEAD) continue; // dead players aren't solid

    const pent = pmove.physents[pmove.numphysent];
    pent.model = null;
    VectorCopy(pplayer.origin, pent.origin);
    VectorCopy(player_mins, pent.mins);
    VectorCopy(player_maxs, pent.maxs);
    pmove.numphysent++;
  }
}

/*
===============
CL_EmitEntities

Builds the visedicts array for cl.time

Made up of: clients, packet_entities, nails, and tents
===============
*/
export function CL_EmitEntities(): void {
  if (cls.state !== CactiveT.ca_active) return;
  if (!cl.qw.validsequence) return;

  visState.cl_oldnumvisedicts = clState.cl_numvisedicts;
  visState.oldlist = (cls.qw.netchan.incoming_sequence - 1) & 1;
  visState.list = cls.qw.netchan.incoming_sequence & 1;

  // publish the current half through the shared cl_visedicts the renderers
  // and cl_tent.c read (see file header)
  const cur = cl_visedicts_list[visState.list];
  for (let i = 0; i < MAX_VISEDICTS; i++) cl_visedicts[i] = cur[i];

  clState.cl_numvisedicts = 0;

  CL_LinkPlayers();
  CL_LinkPacketEntities();
  CL_LinkProjectiles();
  CL_UpdateTEnts();
}
