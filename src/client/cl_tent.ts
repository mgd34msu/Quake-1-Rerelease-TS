/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cl_tent.c (GNU GPL v2 or later).

cl_tent.c -- client side temporary entities

Deviations from PORTING.md / the C source:
- `entity_t cl_temp_entities[MAX_TEMP_ENTITIES]` and `beam_t
  cl_beams[MAX_BEAMS]` are already defined in src/client/client.ts as
  `cl_temp_entities`/`cl_beams` (that module's header explains why: they are
  read by cl_parse.c, view.c, r_efrag.c and the renderers too, not just this
  file). This file imports them rather than redeclaring.
- `num_temp_entities` is written only inside this file (CL_NewTempEntity,
  CL_UpdateTEnts) and read by no other WinQuake file, so it stays an
  `export let`, a live ES binding, rather than a holder object.
- The brief for this unit mentions "cl_spike/cl_bolt/cl_bolt2/cl_bolt3/
  cl_beam? model holders"; cl_tent.c v1.09 has no such statics -- every
  TE_LIGHTNING (1/2/3) / TE_BEAM case calls `Mod_ForName` inline with a literal path
  each time a bolt arrives (see CL_ParseTEnt below), and nothing caches the
  result. Only the seven `cl_sfx_*` sound holders are real module state; no
  model holders are added here, since PORTING.md's fidelity rule ("preserve
  original function names, field names, constants, and logic") forbids
  inventing state the C does not have.
- `rand()` -> `Math.floor(Math.random() * 0x8000)` per this unit's ruling
  (module-local `rand()` helper below), matching mathlib.ts's existing
  rand()-family helpers in spirit but kept local since nothing outside this
  file needs Quake's particular `rand() % 5` / `rand() & 3` spike-sound
  selection or the `rand() % 360` beam roll.
- CL_UpdateTEnts's C body declares exactly one `int i`, shared between the
  outer `for (i=0, b=cl_beams ; i<MAX_BEAMS ; i++, b++)` beam loop and the
  inner `for (i=0 ; i<3 ; i++) org[i] += dist[i]*30;` per-segment axis loop
  that runs inside the `while (d > 0)` body. Because the inner loop always
  leaves `i` at 3 when it finishes, and the outer loop's own `i++` then adds
  one more, any beam whose lightning actually draws (d > 0, i.e. any beam of
  nonzero length -- the overwhelmingly common case) desyncs `i` from `b`:
  `b` still advances exactly one beam per outer iteration (its own `b++` is
  untouched by `i`), but the loop's continuation test `i < MAX_BEAMS` no
  longer reflects how many beams `b` has actually visited. The one place
  this is observable is if a beam happens to occupy the very last slot
  (`cl_beams[MAX_BEAMS-1]`) and is active: after processing it, `i` is
  forced back down to 4, so the C loop runs one further iteration and reads
  `b->model` one element past the end of the `cl_beams` array -- undefined
  behavior with no faithful equivalent on a memory-safe host (there is no
  "next global" for a TypeScript array access to alias into; it would just
  throw on `undefined.model`). This port uses two independent loop
  variables (`i` for beams, `j` for the axis loop), which reproduces the
  C's evident intent -- and its observable output for every beam except that
  one pathological last-slot case -- without crashing the process.
- Dropped `#ifdef QUAKE2`/`#ifdef GLTEST` blocks: `cl_sfx_imp`/`cl_sfx_rail`
  and CL_InitTEnts's two QUAKE2 S_PrecacheSound calls; TE_IMPLOSION/
  TE_RAILTRAIL in CL_ParseTEnt; TE_SPIKE's `#ifdef GLTEST Test_Spawn(pos)`
  (GLTEST is never defined in a normal build, same dead-define rule as
  PARANOID elsewhere in this port).
*/

import { Con_Printf } from "./console";
import { M_PI, VectorCopy, VectorNormalize, VectorSubtract, vec3, vec3_origin } from "../common/mathlib";
import { Mod_ForName, type ModelT } from "../common/model";
import { MSG_ReadByte, MSG_ReadCoord, MSG_ReadShort } from "../common/sizebuf";
import { TE_BEAM, TE_EXPLOSION, TE_EXPLOSION2, TE_GUNSHOT, TE_KNIGHTSPIKE, TE_LAVASPLASH, TE_LIGHTNING1, TE_LIGHTNING2, TE_LIGHTNING3, TE_SPIKE, TE_SUPERSPIKE, TE_TAREXPLOSION, TE_TELEPORT, TE_WIZSPIKE } from "../common/protocol";
import { Sys_Error } from "../platform/sys";
import { cl, cl_beams, cl_entities, cl_temp_entities, cl_visedicts, clState, MAX_BEAMS, MAX_TEMP_ENTITIES, MAX_VISEDICTS } from "./client";
import { EntityT } from "./render";
import { vid } from "./vid";
// cl_main.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { CL_AllocDlight } from "./cl_main";
// r_part.c (concurrent sibling, not yet landed -- absent-at-gate rule)
import { R_BlobExplosion, R_LavaSplash, R_ParticleExplosion, R_ParticleExplosion2, R_RunParticleEffect, R_TeleportSplash } from "./r_part";
// snd_dma.c (concurrent sibling, not yet landed -- absent-at-gate rule).
import { S_PrecacheSound, S_StartSound } from "./snd_dma";
// sound.h's real `SfxT` (not client.ts's `SfxT = unknown` placeholder) types
// the cl_sfx_* holders below: client.ts's own header already flags that
// placeholder as due to become a re-export of this real type once
// snd_dma.ts lands, and snd_dma.ts's S_PrecacheSound/S_StartSound now
// require exactly this type, not `unknown` -- the C's `sfx_t *cl_sfx_*`
// globals are sound.h's sfx_t, which sound.ts's SfxT now represents.
// Updating client.ts's own placeholder is that module's follow-up, out of
// this unit's scope.
import type { SfxT } from "./sound";

// this unit's ruling for cl_tent.c's bare `rand()` calls
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

export let num_temp_entities = 0;

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

    case TE_GUNSHOT: {
      // bullet hitting wall
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_RunParticleEffect(pos, vec3_origin, 0, 20);
      break;
    }

    case TE_EXPLOSION: {
      // rocket explosion
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      R_ParticleExplosion(pos);
      const dl = CL_AllocDlight(0);
      VectorCopy(pos, dl.origin);
      dl.radius = 350;
      dl.die = cl.time + 0.5;
      dl.decay = 300;
      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);
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

    // PGM 01/21/97
    case TE_BEAM: // grappling hook beam
      CL_ParseBeam(Mod_ForName("progs/beam.mdl", true));
      break;
    // PGM 01/21/97

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

    case TE_EXPLOSION2: {
      // color mapped explosion
      const pos = vec3(MSG_ReadCoord(), MSG_ReadCoord(), MSG_ReadCoord());
      const colorStart = MSG_ReadByte();
      const colorLength = MSG_ReadByte();
      R_ParticleExplosion2(pos, colorStart, colorLength);
      const dl = CL_AllocDlight(0);
      VectorCopy(pos, dl.origin);
      dl.radius = 350;
      dl.die = cl.time + 0.5;
      dl.decay = 300;
      S_StartSound(-1, 0, cl_sfx_r_exp3, pos, 1, 1);
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
  if (num_temp_entities === MAX_TEMP_ENTITIES) return null;
  const ent = cl_temp_entities[num_temp_entities];
  ent.clear();
  num_temp_entities++;
  cl_visedicts[clState.cl_numvisedicts] = ent;
  clState.cl_numvisedicts++;

  ent.colormap = vid.colormap;
  return ent;
}

/*
=================
CL_UpdateTEnts
=================
*/
export function CL_UpdateTEnts(): void {
  num_temp_entities = 0;

  // update lightning
  // see file header: the C reuses one `i` for both this loop and the
  // per-segment axis loop below; this port keeps them independent.
  for (let i = 0; i < MAX_BEAMS; i++) {
    const b = cl_beams[i];
    if (!b.model || b.endtime < cl.time) continue;

    // if coming from the player, update the start position
    if (b.entity === cl.viewentity) {
      VectorCopy(cl_entities[cl.viewentity].origin, b.start);
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
