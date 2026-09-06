/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/r_part.c (GNU GPL v2 or later).

r_part.c -- particle system

Ruling (Q023b): `diff -w WinQuake/r_part.c QW/client/r_part.c` is 331 changed
lines of WinQuake's 800 (~41%) / QW's own 615 (~54%), over the ~40% fold
threshold, and several functions are dropped outright or restructured (not
additive), so this is a wholesale module mirroring src/client/r_part.ts's own
idioms rather than a qw.active fold of it.

Function inventory (QW/client/r_part.c, top to bottom): R_InitParticles,
R_ClearParticles, R_ReadPointFile_f, R_ParticleExplosion, R_BlobExplosion,
R_RunParticleEffect, R_LavaSplash, R_TeleportSplash, R_RocketTrail,
R_DrawParticles.

Not ported, with why:
- `R_DarkFieldParticles` (`#ifdef QUAKE2`): PORTING.md drops `QUAKE2` blocks
  silently everywhere; same ruling as the WinQuake module.
- `R_EntityParticles`: WinQuake's r_part.c already carries this as unreachable
  code (nothing calls it -- see src/client/r_part.ts's own header); QW's
  r_part.c removes the function (and `anorms.h`'s `r_avertexnormals`/
  `avelocities`/`beamlength`, needed only by it) entirely. Not ported here for
  the same reason src/client/r_part.ts already gives for `R_DarkFieldParticles`:
  dead code with no call site anywhere in the tree.
- `R_ParticleExplosion2`: WinQuake declares it in render.h and defines it in
  r_part.c, but (per src/client/render.ts's own header, which this unit
  re-checked) nothing calls it in WinQuake either; QW drops the definition
  outright. Not ported.
- `R_ParseParticleEffect`: QW/client/protocol.h comments out `svc_particle`
  entirely (`//define svc_particle 18`) and QW/client/cl_parse.c has no
  `case svc_particle:` handler, but QW/client/render.h still forward-declares
  `void R_ParseParticleEffect (void);` with no definition anywhere in the
  tree -- confirmed by grep across every QW/client/*.c. Same "declared, never
  defined" shape as src/client/view.ts's own `cl_pitchdriftspeed` deviation;
  not ported here, reported as a dropped declaration.

Deviations from PORTING.md / the C source:
- `rand()` -> the same module-local `rand(): number { return
  Math.floor(Math.random() * 0x8000); }` ruling src/client/r_part.ts already
  uses (and cl_tent.ts/sv_move.ts do too).
- `R_ReadPointFile_f`'s own `sprintf (name,"maps/%s.pts", sv.name);` is
  commented out in the C itself (`// FIXME sprintf (...)`), leaving `name`
  read uninitialized (undefined behavior) before `COM_FOpenFile (name, &f)`.
  This is QW's own bug, not this port's: qwcl has no local `sv` (the server
  is the separate `qwsv` process/tree, per PORTING.md's QuakeWorld track), so
  `sv.name` was never available to the client build in the first place --
  the FIXME is id leaving a known-broken code path in place rather than
  removing the (still-registered, elsewhere) command. There is no
  deterministic C behavior to reproduce for an uninitialized read, so `name`
  is ported as `""`; `COM_FOpenFile("")` deterministically fails to open,
  landing on the same "couldn't open" `Con_Printf` the C would almost always
  hit anyway (a stack garbage path essentially never resolves to a real
  `maps/*.pts` file). Reported as a deviation, not silently "fixed".
- `fscanf(f, "%f %f %f\n", ...)` -> the same COM_FOpenFile/COM_FRead/COM_FClose
  plus whitespace-tokenizing-and-float-regex approach src/client/r_part.ts's
  own header documents and this file copies verbatim (same tokenizer, same
  short-read-or-non-numeric-stops-the-loop behavior).
- `particle_t.ramp` is a C `float`; ramp1/ramp2/ramp3 lookups that the C
  casts with `(int)p->ramp` truncate with `Math.trunc` here.
- `R_RunParticleEffect`'s rocket-explosion branch (`count == 1024`... wait,
  QW's R_RunParticleEffect has NO such branch at all -- WinQuake's `count`
  special-case (`if (count == 1024)`) is entirely gone in QW; every particle
  this function spawns is `pt_grav` (WinQuake: `pt_slowgrav`), with a `scale`
  (1/2/3, from `count` thresholds 130/20) multiplying the position jitter
  that WinQuake does not have. See the function's own comment.
- `R_LavaSplash`/`R_TeleportSplash` spawn `pt_grav` (WinQuake: `pt_slowgrav`);
  everything else about both functions is unchanged.
- `R_RocketTrail`: WinQuake's `type < 128 ? dec=3 : (dec=1, type-=128)`
  high-bit decimation and its `switch` are both gone; QW always decrements
  `len` by 3 per particle and dispatches with a plain `if/else if` chain in
  the C's own written order (4, 2, 6, 1, 0, then 3-or-5), which this function
  keeps (not restructured into a `switch`, per the "do not restructure
  algorithms" standing order) even though the dispatch is mutually exclusive
  either way. `case 4` (slight blood) is the one branch that still does its
  own extra `len -= 3`, exactly as written.
- `R_DrawParticles`: `frametime = host.frametime` (WinQuake: `cl.time -
  cl.oldtime`), and `grav = frametime * 800 * 0.05` -- a literal `800`, NOT
  `sv_gravity.value`/`movevars.gravity` (this unit verified directly against
  the C: QW/client/r_part.c hardcodes `800` here, it never reads
  `sv_gravity`/`movevars` at all, in either the software or the `#ifdef
  GLQUAKE` half of this function). The `#ifdef GLQUAKE` half (particle
  texture/vertex/alpha emission) lives entirely in
  `D_StartParticles`/`D_DrawParticle`/`D_EndParticles` per the renderer seam,
  same as WinQuake's module; only the non-GLQUAKE prologue
  (`VectorScale(vright, xscaleshrink, ...)` etc, software-renderer internals)
  is dropped for the same reason WinQuake's own r_part.ts drops it.
- `static int tracercount` (function-static, C-side, declared INSIDE the
  `type==3||type==5` branch in QW, unlike WinQuake's function-top
  declaration) becomes the same module-level `let tracercount = 0;`
  WinQuake's r_part.ts already uses -- JS has no block-scoped statics either.
*/

import { Con_Printf } from "./console";
import { COM_CheckParm, COM_FClose, COM_FOpenFile, COM_FRead, Q_atoi, com_argv } from "../../common/common";
import { host } from "../../common/host";
import { VectorAdd, VectorCopy, VectorNormalize, VectorScale, VectorSubtract, vec3, vec3_origin, type Vec3 } from "../../common/mathlib";
import { cl } from "../../client/client";
import { ParticleT, PtypeT, getRenderer } from "../../client/render";

export const MAX_PARTICLES = 2048; // default max # of particles at one time
export const ABSOLUTE_MIN_PARTICLES = 512; // no fewer than this no matter what's on the command line

export const ramp1: readonly number[] = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
export const ramp2: readonly number[] = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
export const ramp3: readonly number[] = [0x6d, 0x6b, 6, 5, 4, 3, 0, 0]; // C initializes only the first 6 of 8

export let active_particles: ParticleT | null = null;
export let free_particles: ParticleT | null = null;

export let particles: ParticleT[] = [];
export let r_numparticles = 0;

// this unit's ruling for r_part.c's bare `rand()` calls (see file header)
function rand(): number {
  return Math.floor(Math.random() * 0x8000);
}

/*
===============
R_InitParticles
===============
*/
export function R_InitParticles(): void {
  const i = COM_CheckParm("-particles");

  if (i) {
    r_numparticles = Q_atoi(com_argv[i + 1]);
    if (r_numparticles < ABSOLUTE_MIN_PARTICLES) r_numparticles = ABSOLUTE_MIN_PARTICLES;
  } else {
    r_numparticles = MAX_PARTICLES;
  }

  particles = Array.from({ length: r_numparticles }, () => new ParticleT());
}

/*
===============
R_ClearParticles
===============
*/
export function R_ClearParticles(): void {
  free_particles = particles.length > 0 ? particles[0] : null;
  active_particles = null;

  for (let i = 0; i < r_numparticles; i++) {
    particles[i].next = i + 1 < r_numparticles ? particles[i + 1] : null;
  }
  if (r_numparticles > 0) particles[r_numparticles - 1].next = null;
}

// this unit's tokenizer for r_part.c's `fscanf(f,"%f %f %f\n", ...)` (see
// file header, and src/client/r_part.ts's identical ruling)
const FSCANF_FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/*
===============
R_ReadPointFile_f
===============
*/
export function R_ReadPointFile_f(): void {
  // `sprintf (name,"maps/%s.pts", sv.name);` is commented out in the C
  // itself -- see file header
  const name = "";

  const { file, length } = COM_FOpenFile(name);
  if (!file) {
    Con_Printf("couldn't open %s\n", name);
    return;
  }

  Con_Printf("Reading %s...\n", name);

  const buf = new Uint8Array(length);
  COM_FRead(file, buf, length);
  COM_FClose(file);

  let contents = "";
  for (let i = 0; i < buf.length; i++) contents += String.fromCharCode(buf[i]);
  const tokens = contents.split(/\s+/).filter((t) => t.length > 0);

  const org = vec3();
  let c = 0;
  let idx = 0;

  for (;;) {
    if (idx + 3 > tokens.length) break;
    const t0 = tokens[idx];
    const t1 = tokens[idx + 1];
    const t2 = tokens[idx + 2];
    if (!FSCANF_FLOAT_RE.test(t0) || !FSCANF_FLOAT_RE.test(t1) || !FSCANF_FLOAT_RE.test(t2)) break;

    org[0] = Number.parseFloat(t0);
    org[1] = Number.parseFloat(t1);
    org[2] = Number.parseFloat(t2);
    idx += 3;
    c++;

    if (!free_particles) {
      Con_Printf("Not enough free particles\n");
      break;
    }
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    p.die = 99999;
    p.color = -c & 15;
    p.type = PtypeT.pt_static;
    VectorCopy(vec3_origin, p.vel);
    VectorCopy(org, p.org);
  }

  Con_Printf("%i points read\n", c);
}

/*
===============
R_ParticleExplosion

===============
*/
export function R_ParticleExplosion(org: Vec3): void {
  for (let i = 0; i < 1024; i++) {
    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    p.die = cl.time + 5;
    p.color = ramp1[0];
    p.ramp = rand() & 3;
    if (i & 1) {
      p.type = PtypeT.pt_explode;
      for (let j = 0; j < 3; j++) {
        p.org[j] = org[j] + ((rand() % 32) - 16);
        p.vel[j] = (rand() % 512) - 256;
      }
    } else {
      p.type = PtypeT.pt_explode2;
      for (let j = 0; j < 3; j++) {
        p.org[j] = org[j] + ((rand() % 32) - 16);
        p.vel[j] = (rand() % 512) - 256;
      }
    }
  }
}

/*
===============
R_BlobExplosion

===============
*/
export function R_BlobExplosion(org: Vec3): void {
  for (let i = 0; i < 1024; i++) {
    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    p.die = cl.time + 1 + (rand() & 8) * 0.05;

    if (i & 1) {
      p.type = PtypeT.pt_blob;
      p.color = 66 + (rand() % 6);
      for (let j = 0; j < 3; j++) {
        p.org[j] = org[j] + ((rand() % 32) - 16);
        p.vel[j] = (rand() % 512) - 256;
      }
    } else {
      p.type = PtypeT.pt_blob2;
      p.color = 150 + (rand() % 6);
      for (let j = 0; j < 3; j++) {
        p.org[j] = org[j] + ((rand() % 32) - 16);
        p.vel[j] = (rand() % 512) - 256;
      }
    }
  }
}

/*
===============
R_RunParticleEffect

QW: every particle is pt_grav (WinQuake: pt_slowgrav for the non-explosion
case, and this function has no explosion case at all any more -- see file
header), and the position jitter is multiplied by a count-derived `scale`
WinQuake does not have.
===============
*/
export function R_RunParticleEffect(org: Vec3, dir: Vec3, color: number, count: number): void {
  let scale: number;
  if (count > 130) scale = 3;
  else if (count > 20) scale = 2;
  else scale = 1;

  for (let i = 0; i < count; i++) {
    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    p.die = cl.time + 0.1 * (rand() % 5);
    p.color = (color & ~7) + (rand() & 7);
    p.type = PtypeT.pt_grav;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + scale * ((rand() & 15) - 8);
      p.vel[j] = dir[j] * 15; // + (rand()%300)-150;
    }
  }
}

/*
===============
R_LavaSplash

===============
*/
export function R_LavaSplash(org: Vec3): void {
  const dir = vec3();

  for (let i = -16; i < 16; i++) {
    for (let j = -16; j < 16; j++) {
      for (let k = 0; k < 1; k++) {
        if (!free_particles) return;
        const p = free_particles;
        free_particles = p.next;
        p.next = active_particles;
        active_particles = p;

        p.die = cl.time + 2 + (rand() & 31) * 0.02;
        p.color = 224 + (rand() & 7);
        p.type = PtypeT.pt_grav;

        dir[0] = j * 8 + (rand() & 7);
        dir[1] = i * 8 + (rand() & 7);
        dir[2] = 256;

        p.org[0] = org[0] + dir[0];
        p.org[1] = org[1] + dir[1];
        p.org[2] = org[2] + (rand() & 63);

        VectorNormalize(dir);
        const vel = 50 + (rand() & 63);
        VectorScale(dir, vel, p.vel);
      }
    }
  }
}

/*
===============
R_TeleportSplash

===============
*/
export function R_TeleportSplash(org: Vec3): void {
  const dir = vec3();

  for (let i = -16; i < 16; i += 4) {
    for (let j = -16; j < 16; j += 4) {
      for (let k = -24; k < 32; k += 4) {
        if (!free_particles) return;
        const p = free_particles;
        free_particles = p.next;
        p.next = active_particles;
        active_particles = p;

        p.die = cl.time + 0.2 + (rand() & 7) * 0.02;
        p.color = 7 + (rand() & 7);
        p.type = PtypeT.pt_grav;

        dir[0] = j * 8;
        dir[1] = i * 8;
        dir[2] = k * 8;

        p.org[0] = org[0] + i + (rand() & 3);
        p.org[1] = org[1] + j + (rand() & 3);
        p.org[2] = org[2] + k + (rand() & 3);

        VectorNormalize(dir);
        const vel = 50 + (rand() & 63);
        VectorScale(dir, vel, p.vel);
      }
    }
  }
}

// static int tracercount; -- see file header (function-static -> module-local)
let tracercount = 0;

/*
===============
R_RocketTrail

QW always decrements len by 3 (WinQuake's type<128/dec=3 vs type>=128/dec=1
high-bit split is gone) and dispatches with an if/else-if chain in the C's
own written order, not a switch -- see file header.
===============
*/
export function R_RocketTrail(start: Vec3, end: Vec3, type: number): void {
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  let j = 0;

  while (len > 0) {
    len -= 3;

    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    VectorCopy(vec3_origin, p.vel);
    p.die = cl.time + 2;

    if (type === 4) {
      // slight blood
      p.type = PtypeT.pt_slowgrav;
      p.color = 67 + (rand() & 3);
      for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
      len -= 3;
    } else if (type === 2) {
      // blood
      p.type = PtypeT.pt_slowgrav;
      p.color = 67 + (rand() & 3);
      for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
    } else if (type === 6) {
      // voor trail
      p.color = 9 * 16 + 8 + (rand() & 3);
      p.type = PtypeT.pt_static;
      p.die = cl.time + 0.3;
      for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() & 15) - 8);
    } else if (type === 1) {
      // smoke smoke
      p.ramp = (rand() & 3) + 2;
      p.color = ramp3[Math.trunc(p.ramp)];
      p.type = PtypeT.pt_fire;
      for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
    } else if (type === 0) {
      // rocket trail
      p.ramp = rand() & 3;
      p.color = ramp3[Math.trunc(p.ramp)];
      p.type = PtypeT.pt_fire;
      for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
    } else if (type === 3 || type === 5) {
      // tracer
      p.die = cl.time + 0.5;
      p.type = PtypeT.pt_static;
      if (type === 3) p.color = 52 + ((tracercount & 4) << 1);
      else p.color = 230 + ((tracercount & 4) << 1);

      tracercount++;

      VectorCopy(start, p.org);
      if (tracercount & 1) {
        p.vel[0] = 30 * vec[1];
        p.vel[1] = 30 * -vec[0];
      } else {
        p.vel[0] = 30 * -vec[1];
        p.vel[1] = 30 * vec[0];
      }
    }

    VectorAdd(start, vec, start);
  }
}

/*
===============
R_DrawParticles
===============
*/
export function R_DrawParticles(): void {
  const renderer = getRenderer();
  renderer.D_StartParticles();

  // `frametime = host_frametime;` (WinQuake: `cl.time - cl.oldtime`); `grav`
  // is a literal `800`, not `sv_gravity`/`movevars.gravity` -- see file header
  const frametime = host.frametime;
  const time3 = frametime * 15;
  const time2 = frametime * 10; // 15;
  const time1 = frametime * 5;
  const grav = frametime * 800 * 0.05;
  const dvel = 4 * frametime;

  for (;;) {
    const kill = active_particles;
    if (kill && kill.die < cl.time) {
      active_particles = kill.next;
      kill.next = free_particles;
      free_particles = kill;
      continue;
    }
    break;
  }

  let i = 0;

  for (let p = active_particles; p; p = p.next) {
    for (;;) {
      const kill = p.next;
      if (kill && kill.die < cl.time) {
        p.next = kill.next;
        kill.next = free_particles;
        free_particles = kill;
        continue;
      }
      break;
    }

    renderer.D_DrawParticle(p);

    p.org[0] += p.vel[0] * frametime;
    p.org[1] += p.vel[1] * frametime;
    p.org[2] += p.vel[2] * frametime;

    switch (p.type) {
      case PtypeT.pt_static:
        break;
      case PtypeT.pt_fire:
        p.ramp += time1;
        if (p.ramp >= 6) p.die = -1;
        else p.color = ramp3[Math.trunc(p.ramp)];
        p.vel[2] += grav;
        break;

      case PtypeT.pt_explode:
        p.ramp += time2;
        if (p.ramp >= 8) p.die = -1;
        else p.color = ramp1[Math.trunc(p.ramp)];
        for (i = 0; i < 3; i++) p.vel[i] += p.vel[i] * dvel;
        p.vel[2] -= grav;
        break;

      case PtypeT.pt_explode2:
        p.ramp += time3;
        if (p.ramp >= 8) p.die = -1;
        else p.color = ramp2[Math.trunc(p.ramp)];
        for (i = 0; i < 3; i++) p.vel[i] -= p.vel[i] * frametime;
        p.vel[2] -= grav;
        break;

      case PtypeT.pt_blob:
        for (i = 0; i < 3; i++) p.vel[i] += p.vel[i] * dvel;
        p.vel[2] -= grav;
        break;

      case PtypeT.pt_blob2:
        for (i = 0; i < 2; i++) p.vel[i] -= p.vel[i] * dvel;
        p.vel[2] -= grav;
        break;

      case PtypeT.pt_grav:
      case PtypeT.pt_slowgrav:
        p.vel[2] -= grav;
        break;
    }
  }

  renderer.D_EndParticles();
}
