/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cl_tent.c (GNU GPL v2 or later), diffed against the
landed WinQuake port (src/client/cl_tent.ts) and against WinQuake/cl_tent.c
directly (both fully read).

cl_tent.c -- client side temporary entities (QuakeWorld track: qwcl).
Wholesale-different module (own beam list at a different size, a genuinely
new sprite-explosion mechanism, a different CL_NewTempEntity), ported fresh
per PORTING.md's "wholesale-different files get their own module" ruling.

Genuine differences from WinQuake/cl_tent.c (read directly, both files in
full):
- `explosion_t`/`cl_explosions[MAX_EXPLOSIONS]`/`CL_AllocExplosion`: entirely
  new. QW's TE_EXPLOSION spawns a small animated sprite entity (`s_explod.spr`,
  10 frames/sec) via CL_UpdateExplosions, in addition to the dlight and
  particle burst WinQuake's TE_EXPLOSION already has. Not present anywhere
  in WinQuake/cl_tent.c.
- `CL_ClearTEnts`: new (`memset(&cl_beams,0,...); memset(&cl_explosions,0,...)`).
  WinQuake's cl_tent.c has no function of this name; src/qw/client/cl_main.ts
  (already landed) imports `CL_ClearTEnts` from this module by name --
  confirmed by reading that file's own import list before writing this one.
- `MAX_BEAMS` is 8 in QW, not WinQuake's 24 -- a real, different constant on
  an otherwise-identical `beam_t` shape (entity/model/endtime/start/end); its
  `cl_beams` array is grepped-confirmed to be read nowhere in the QW client
  tree except this file, so (unlike WinQuake's, which src/client/client.ts
  hoists into the shared header for cl_parse.c/view.c/renderer readers) it
  stays this module's own file-local state, mirroring PORTING.md's
  file-local-stays-file-local guidance in the opposite direction from
  WinQuake's own choice.
- `CL_ParseTEnt`: TE_GUNSHOT gains a leading count byte
  (`cnt = MSG_ReadByte(); ... R_RunParticleEffect(pos, vec3_origin, 0,
  20*cnt)`), where WinQuake's is a fixed `R_RunParticleEffect(pos,
  vec3_origin, 0, 20)`. TE_BLOOD (12) and TE_LIGHTNINGBLOOD (13) are new
  cases at the slot numbers WinQuake's protocol assigns to TE_EXPLOSION2/
  TE_BEAM -- QW drops both of those entirely (not merely `#if 0`'d: grepped
  the whole QW/client/cl_tent.c, no TE_EXPLOSION2/TE_BEAM case exists).
  TE_EXPLOSION additionally allocates a sprite via CL_AllocExplosion and sets
  `dl->color[0..3]` on the dlight (see the dlight-color deviation below);
  WinQuake's TE_EXPLOSION sets neither.
- `CL_NewTempEntity`: WinQuake pulls from a fixed `cl_temp_entities` pool
  (bounded separately by `MAX_TEMP_ENTITIES`) and pushes a *pointer* into
  `cl_visedicts`. QW's `entity_t *cl_visedicts` is (per QW/client/client.h)
  a pointer into one of two full `entity_t` value arrays
  (`cl_visedicts_list[2][MAX_VISEDICTS]`, owned by src/qw/client/cl_main.ts/
  cl_ents.ts, already landed) that cl_ents.c swaps every frame; QW's
  CL_NewTempEntity takes the *next slot of that array itself* as the new
  entity's storage (`ent = &cl_visedicts[cl_numvisedicts]`), with no second,
  separately-bounded backing pool at all -- confirmed by reading the actual
  source (`if (cl_numvisedicts == MAX_VISEDICTS) return NULL;` is the only
  bound). This port models that the same way WinQuake's cl_tent.ts models
  the pointer-into-shared-storage idiom: it does not create its own copy of
  `cl_visedicts`/`MAX_VISEDICTS`, it imports and writes through the ones
  already exported by src/client/client.ts -- which, per this port's "one
  engine" ruling and cl_ents.ts's own header (confirmed by reading that file
  before writing this one), are the SAME `cl_visedicts`/`clState`/
  `MAX_VISEDICTS` the WinQuake renderer/cl_ents.ts publish into each frame,
  not a QW-only duplicate. Since there is no fixed backing pool to reuse in
  the TS port (unlike WinQuake's `cl_temp_entities[i]`, which is a real,
  reused object slot), each call allocates one fresh `EntityT`, which is
  already all-zero by construction (matching the C's `memset(ent,0,...)`
  after taking the slot's address) -- no separate `.clear()` call is needed.
  `ent->keynum = 0` is dropped: `EntityT` (src/client/render.ts, out of this
  unit's SCOPE) has no `keynum` field (WinQuake's own `entity_t` never had
  one; QW's `entity_t` adds it for cl_ents.c's cross-frame matching, per
  that file's own header). Not consumed by anything in this unit's scope;
  reported as a follow-up for whichever unit next touches render.ts's
  `EntityT`.
- `CL_UpdateBeams`/`CL_UpdateExplosions`/`CL_UpdateTEnts`: QW splits WinQuake's
  one `CL_UpdateTEnts` (which both resets `num_temp_entities` and walks
  `cl_beams` inline) into three functions; there is no `num_temp_entities`
  reset at all in QW (it does not exist, per the CL_NewTempEntity deviation
  above). The "if beam is coming from the player, update its start" check
  reads `cl.qw.playernum`/`cl.qw.simorg` (QW-only fields), not WinQuake's
  `cl.viewentity`/`cl_entities[cl.viewentity].origin`.

Deviations from PORTING.md / the C source:
- `rand()` -> the same module-local helper WinQuake's cl_tent.ts uses,
  duplicated here rather than shared (nothing exports it, per that file's
  own ruling for its copy).
- `dl->color[0..3]`: QW's `dlight_t` gains a `float color[4]` member (QW/
  client/client.h) that WinQuake's dlight_t does not have. It is a field on
  `DlightT` (src/client/client.ts), inert on the WinQuake path, so this file
  writes `dl.color[0..3]` exactly where the C writes `dl->color[0..3]`.
- `BeamT` (entity/model/endtime/start/end) is reused from src/client/
  client.ts's export of that exact shape (WinQuake's `beam_t` and QW's are
  textually identical structs, confirmed by reading both), for the
  `cl_beams` array below; only the array and its `MAX_BEAMS` size are this
  module's own, per the deviation above.
- `Mod_ForName`, `S_PrecacheSound`/`S_StartSound`: shared, one-engine modules
  (src/common/model.ts, src/client/snd_dma.ts) -- sound is not QW-specific
  per PORTING.md's renderer-seam section, so these import directly from the
  landed WinQuake modules, not through a QW wrapper.
- `R_RunParticleEffect`/`R_ParticleExplosion`/`R_BlobExplosion`/
  `R_LavaSplash`/`R_TeleportSplash` come from ./r_part (QW/client/r_part.c,
  which QW/client/cl_tent.c is compiled and linked against), NOT from
  src/client/r_part.ts: r_part.c is one of the wholesale-different files
  (see src/qw/client/r_part.ts's own Q023b ruling), and the two modules own
  separate particle pools, so mixing them would spawn particles into a pool
  the qwcl renderer never draws.
*/

import { Con_Printf } from "./console";
import { M_PI, VectorCopy, VectorNormalize, VectorSubtract, vec3, vec3_origin } from "../../common/mathlib";
import { Mod_ForName, type ModelT } from "../../common/model";
import { MSG_ReadByte, MSG_ReadCoord, MSG_ReadShort } from "../../common/sizebuf";
import {
  TE_BLOOD,
  TE_EXPLOSION,
  TE_GUNSHOT,
  TE_KNIGHTSPIKE,
  TE_LAVASPLASH,
  TE_LIGHTNING1,
  TE_LIGHTNING2,
  TE_LIGHTNING3,
  TE_LIGHTNINGBLOOD,
  TE_SPIKE,
  TE_SUPERSPIKE,
  TE_TAREXPLOSION,
  TE_TELEPORT,
  TE_WIZSPIKE,
} from "../protocol";
import { Sys_Error } from "../../platform/sys";
import { BeamT, cl, cl_visedicts, clState, MAX_VISEDICTS } from "../../client/client";
import { EntityT } from "../../client/render";
import { vid } from "../../client/vid";
import { CL_AllocDlight } from "./cl_ents";
import { R_BlobExplosion, R_LavaSplash, R_ParticleExplosion, R_RunParticleEffect, R_TeleportSplash } from "./r_part";
import { S_PrecacheSound, S_StartSound } from "../../client/snd_dma";
import type { SfxT } from "../../client/sound";

// this unit's ruling for cl_tent.c's bare `rand()` calls -- see file header
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

export const MAX_BEAMS = 8; // QW: 8, not WinQuake's 24 -- see file header

export const cl_beams: BeamT[] = makeArray(MAX_BEAMS, () => new BeamT());

export const MAX_EXPLOSIONS = 8;

export class ExplosionT {
  origin = vec3();
  start = 0;
  model: ModelT | null = null;
}

export const cl_explosions: ExplosionT[] = makeArray(MAX_EXPLOSIONS, () => new ExplosionT());

function makeArray<T>(n: number, make: () => T): T[] {
  const a: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

export let cl_sfx_wizhit: SfxT | null = null;
export let cl_sfx_knighthit: SfxT | null = null;
export let cl_sfx_tink1: SfxT | null = null;
export let cl_sfx_ric1: SfxT | null = null;
export let cl_sfx_ric2: SfxT | null = null;
export let cl_sfx_ric3: SfxT | null = null;
export let cl_sfx_r_exp3: SfxT | null = null;

/*
=================
CL_InitTEnts
=================
*/
export function CL_InitTEnts(): void {
  cl_sfx_wizhit = S_PrecacheSound("wizard/hit.wav");
  cl_sfx_knighthit = S_PrecacheSound("hknight/hit.wav");
  cl_sfx_tink1 = S_PrecacheSound("weapons/tink1.wav");
  cl_sfx_ric1 = S_PrecacheSound("weapons/ric1.wav");
  cl_sfx_ric2 = S_PrecacheSound("weapons/ric2.wav");
  cl_sfx_ric3 = S_PrecacheSound("weapons/ric3.wav");
  cl_sfx_r_exp3 = S_PrecacheSound("weapons/r_exp3.wav");
}

/*
=================
CL_ClearTEnts
=================
*/
export function CL_ClearTEnts(): void {
  for (const b of cl_beams) {
    b.entity = 0;
    b.model = null;
    b.endtime = 0;
    b.start[0] = b.start[1] = b.start[2] = 0;
    b.end[0] = b.end[1] = b.end[2] = 0;
  }
  for (const ex of cl_explosions) {
    ex.origin[0] = ex.origin[1] = ex.origin[2] = 0;
    ex.start = 0;
    ex.model = null;
  }
}

/*
=================
CL_AllocExplosion
=================
*/
export function CL_AllocExplosion(): ExplosionT {
  for (let i = 0; i < MAX_EXPLOSIONS; i++) if (!cl_explosions[i].model) return cl_explosions[i];

  // find the oldest explosion
  let time = cl.time;
  let index = 0;

  for (let i = 0; i < MAX_EXPLOSIONS; i++) {
    if (cl_explosions[i].start < time) {
      time = cl_explosions[i].start;
      index = i;
    }
  }
  return cl_explosions[index];
}

/*
=================
CL_ParseBeam
=================
*/
export function CL_ParseBeam(m: ModelT | null): void {
  const ent = MSG_ReadShort();

  const start = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
  const end = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());

  // override any beam with the same entity
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    if (b.entity === ent) {
      b.entity = ent;
      b.model = m;
      b.endtime = cl.time + 0.2;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      return;
    }
  }

  // find a free beam
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    if (!b.model || b.endtime < cl.time) {
      b.entity = ent;
      b.model = m;
      b.endtime = cl.time + 0.2;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      return;
    }
  }
  Con_Printf("beam list overflow!\n");
}

/*
=================
CL_ParseTEnt
=================
*/
export function CL_ParseTEnt(): void {
  const type = MSG_ReadByte();
  switch (type) {
    case TE_WIZSPIKE: {
      // spike hitting wall
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 20, 30);
      S_StartSound(-1, 0, cl_sfx_wizhit, pos, 1, 1);
      break;
    }

    case TE_KNIGHTSPIKE: {
      // spike hitting wall
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 226, 20);
      S_StartSound(-1, 0, cl_sfx_knighthit, pos, 1, 1);
      break;
    }

    case TE_SPIKE: {
      // spike hitting wall
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 0, 10);
      if (rand() % 5) {
        S_StartSound(-1, 0, cl_sfx_tink1, pos, 1, 1);
      } else {
        const rnd = rand() & 3;
        if (rnd === 1) S_StartSound(-1, 0, cl_sfx_ric1, pos, 1, 1);
        else if (rnd === 2) S_StartSound(-1, 0, cl_sfx_ric2, pos, 1, 1);
        else S_StartSound(-1, 0, cl_sfx_ric3, pos, 1, 1);
      }
      break;
    }
    case TE_SUPERSPIKE: {
      // super spike hitting wall
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 0, 20);

      if (rand() % 5) {
        S_StartSound(-1, 0, cl_sfx_tink1, pos, 1, 1);
      } else {
        const rnd = rand() & 3;
        if (rnd === 1) S_StartSound(-1, 0, cl_sfx_ric1, pos, 1, 1);
        else if (rnd === 2) S_StartSound(-1, 0, cl_sfx_ric2, pos, 1, 1);
        else S_StartSound(-1, 0, cl_sfx_ric3, pos, 1, 1);
      }
      break;
    }

    case TE_EXPLOSION: {
      // rocket explosion
      // particles
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_ParticleExplosion(pos);

      // light
      const dl = CL_AllocDlight(0);
      VectorCopy(pos, dl.origin);
      dl.radius = 350;
      dl.die = cl.time + 0.5;
      dl.decay = 300;
      const color = dl.color;
      color[0] = 0.2;
      color[1] = 0.1;
      color[2] = 0.05;
      color[3] = 0.7;

      // sound
      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);

      // sprite
      const ex = CL_AllocExplosion();
      VectorCopy(pos, ex.origin);
      ex.start = cl.time;
      ex.model = Mod_ForName("progs/s_explod.spr", true);
      break;
    }

    case TE_TAREXPLOSION: {
      // tarbaby explosion
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_BlobExplosion(pos);

      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);
      break;
    }

    case TE_LIGHTNING1: // lightning bolts
      CL_ParseBeam(Mod_ForName("progs/bolt.mdl", true));
      break;

    case TE_LIGHTNING2: // lightning bolts
      CL_ParseBeam(Mod_ForName("progs/bolt2.mdl", true));
      break;

    case TE_LIGHTNING3: // lightning bolts
      CL_ParseBeam(Mod_ForName("progs/bolt3.mdl", true));
      break;

    case TE_LAVASPLASH: {
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_LavaSplash(pos);
      break;
    }

    case TE_TELEPORT: {
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_TeleportSplash(pos);
      break;
    }

    case TE_GUNSHOT: {
      // bullet hitting wall
      const cnt = MSG_ReadByte();
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 0, 20 * cnt);
      break;
    }

    case TE_BLOOD: {
      // bullets hitting body
      const cnt = MSG_ReadByte();
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 73, 20 * cnt);
      break;
    }

    case TE_LIGHTNINGBLOOD: {
      // lightning hitting body
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 225, 50);
      break;
    }

    default:
      Sys_Error("CL_ParseTEnt: bad type");
  }
}

/*
=================
CL_NewTempEntity
=================
*/
export function CL_NewTempEntity(): EntityT | null {
  if (clState.cl_numvisedicts === MAX_VISEDICTS) return null;

  // ent = &cl_visedicts[cl_numvisedicts]; cl_numvisedicts++; ent->keynum = 0;
  // memset(ent,0,sizeof(*ent)) -- see file header for why a fresh EntityT
  // stands in for "take the next value-array slot and zero it" and why
  // keynum is dropped.
  const ent = new EntityT();
  cl_visedicts[clState.cl_numvisedicts] = ent;
  clState.cl_numvisedicts++;

  ent.colormap = vid.colormap;
  return ent;
}

/*
=================
CL_UpdateBeams
=================
*/
export function CL_UpdateBeams(): void {
  // update lightning
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    if (!b.model || b.endtime < cl.time) continue;

    // if coming from the player, update the start position
    if (b.entity === cl.qw.playernum + 1) {
      // entity 0 is the world
      VectorCopy(cl.qw.simorg, b.start);
      // b.start[2] -= 22; // adjust for view height (commented out in the C)
    }

    // calculate pitch and yaw
    const dist = vec3();
    VectorSubtract(b.end, b.start, dist);

    let yaw: number;
    let pitch: number;
    if (dist[1] === 0 && dist[0] === 0) {
      yaw = 0;
      if (dist[2] > 0) pitch = 90;
      else pitch = 270;
    } else {
      yaw = Math.trunc((Math.atan2(dist[1], dist[0]) * 180) / M_PI);
      if (yaw < 0) yaw += 360;

      const forward = Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1]);
      pitch = Math.trunc((Math.atan2(dist[2], forward) * 180) / M_PI);
      if (pitch < 0) pitch += 360;
    }

    // add new entities for the lightning
    const org = vec3();
    VectorCopy(b.start, org);
    let d = VectorNormalize(dist);
    while (d > 0) {
      const ent = CL_NewTempEntity();
      if (!ent) return;
      VectorCopy(org, ent.origin);
      ent.model = b.model;
      ent.angles[0] = pitch;
      ent.angles[1] = yaw;
      ent.angles[2] = rand() % 360;

      for (let j = 0; j < 3; j++) org[j] += dist[j] * 30;
      d -= 30;
    }
  }
}

/*
=================
CL_UpdateExplosions
=================
*/
export function CL_UpdateExplosions(): void {
  for (let i = 0; i < MAX_EXPLOSIONS; i++) {
    const ex = cl_explosions[i];
    if (!ex.model) continue;
    const f = Math.trunc(10 * (cl.time - ex.start));
    if (f >= ex.model.numframes) {
      ex.model = null;
      continue;
    }

    const ent = CL_NewTempEntity();
    if (!ent) return;
    VectorCopy(ex.origin, ent.origin);
    ent.model = ex.model;
    ent.frame = f;
  }
}

/*
=================
CL_UpdateTEnts
=================
*/
export function CL_UpdateTEnts(): void {
  CL_UpdateBeams();
  CL_UpdateExplosions();
}
