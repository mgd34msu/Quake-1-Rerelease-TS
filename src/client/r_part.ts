/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_part.c and WinQuake/anorms.h (GNU GPL v2 or later).

r_part.c -- particle system

PORTING.md's "Renderer seam" section keeps particle *simulation* on the
client side of the seam; only the three D_* drawing calls
(D_StartParticles/D_DrawParticle/D_EndParticles) cross into
src/client/render.ts's `Renderer` interface and are implemented once per
renderer (src/ref_soft, src/ref_gl -- neither landed yet).

Deviations from PORTING.md / the C source:
- `rand()` -> a module-local `rand(): number { return
  Math.floor(Math.random() * 0x8000); }`, this unit's ruling (matching
  cl_tent.ts's / sv_move.ts's identical local helpers -- nothing outside
  this file needs Quake's particular particle-spawn RNG shape, so it stays
  private here too).
- `r_avertexnormals` (declared `extern float r_avertexnormals[NUMVERTEXNORMALS][3]`
  in the C, defined in anorms.h, and also read by r_alias.c/gl_rmain.c for
  alias-model lighting) is ported HERE, per render.ts's own header ruling:
  "port anorms.h's 162 normals here as an exported Float32Array(162*3) so
  ref_soft/ref_gl can re-export rather than duplicate". Generated verbatim
  from anorms.h's 162 `{x, y, z}` rows, one row per source line.
- `avelocities` (`vec3_t avelocities[NUMVERTEXNORMALS]`) is likewise a flat
  `Float32Array(NUMVERTEXNORMALS * 3)`, addressed as `avelocities[i*3+j]`.
  This mirrors the C's own memory layout exactly: R_EntityParticles's lazy
  init loop --
    if (!avelocities[0][0])
      for (i=0 ; i<NUMVERTEXNORMALS*3 ; i++)
        avelocities[0][i] = (rand()&255) * 0.01;
  -- walks `avelocities` as one flat array of 486 floats through the
  `avelocities[0]` sub-array, aliasing past the first vec3_t into every
  following one. A flat Float32Array reproduces that addressing exactly.
  The lazy-init guard (`avelocities[0][0] === 0`) is preserved exactly as the C has it:
  since `(rand()&255)*0.01` can legitimately produce exactly 0 (rand()&255
  == 0, a 1-in-256 chance), the C can occasionally re-run this
  "one-time" init later in the game; this port reproduces that, not "fixes" it.
- Dropped globals that r_part.c declares but never reads anywhere in the
  file: `vec3_t avelocity = {23,7,3}`, `float partstep = 0.01`, `float
  timescale = 0.01` (truly dead C globals -- not in this unit's brief's
  "PORT (same names)" list, unlike `beamlength`/`avelocities`, which are).
  R_EntityParticles's local `count = 50` is the same story: the C sets it
  but the function's only loop is `for (i=0 ; i<NUMVERTEXNORMALS ; i++)`,
  which never reads `count` -- dropped for the same reason. That same
  function's `sr`/`cr` (`sin`/`cos` of the roll angle) are computed by the C
  and then never read either (only `forward[]`, built from `sy`/`cy`/`sp`/
  `cp`, is used) -- dropped; `Math.sin`/`Math.cos` have no side effects, so
  this changes nothing observable.
- Dropped `#ifdef QUAKE2` blocks: R_DarkFieldParticles (render.ts's header
  already notes render.h's declaration is dropped) and R_DrawParticles's
  QUAKE2-only `pt_grav` branch (`p->vel[2] -= grav*20; break;`). Per this
  unit's ruling, `pt_grav` falls straight through into `pt_slowgrav`'s
  `p->vel[2] -= grav;`, exactly as v1.09 behaves with QUAKE2 undefined.
- Dropped `#ifdef GLQUAKE` blocks in R_DrawParticles: the GL vertex/color
  emission (`GL_Bind`/`glBegin`.../`glEnd`) and the software prologue
  (`VectorScale(vright, xscaleshrink, r_pright)` etc. -- `xscaleshrink`/
  `yscaleshrink`/`r_pright`/`r_pup`/`r_ppn` are r_local.h software-renderer
  internals, never read outside d_part.c) both live entirely inside
  D_StartParticles/D_DrawParticle/D_EndParticles now; this file only calls
  the three seam methods.
- `sprintf(name, "maps/%s.pts", sv.name)` (a fixed `char name[MAX_OSPATH]`
  buffer in the C) -> a plain JS template string; no length limit is needed
  on a memory-safe host.
- `fscanf(f, "%f %f %f\n", ...)` -> the whole file is read via
  COM_FOpenFile/COM_FRead/COM_FClose, decoded as Latin-1 (matching every
  other on-disk-text reader in this port -- text is raw bytes, never
  UTF-8), then split into whitespace-delimited tokens. Each token is
  checked against a plain decimal/exponent float grammar before being
  parsed; a short read (fewer than 3 tokens left) or a non-numeric token
  stops the loop exactly where an `fscanf` return value other than 3 would
  have stopped it. This does not implement `%f`'s C hex-float syntax --
  qbsp's leak-file writer never emits it.
- `particle_t.ramp` is a C `float`; ramp1/ramp2/ramp3 lookups that the C
  casts with `(int)p->ramp` truncate with `Math.trunc` here.
- R_ParticleExplosion's and R_RunParticleEffect's rocket-explosion branch
  keep the C's literal `if (i&1) {...} else {...}` duplication (both arms
  compute org/vel identically, differing only in `p->type`) rather than
  merging the arms, per the "do not restructure algorithms" standing order.
- `Hunk_AllocName (r_numparticles * sizeof(particle_t), "particles")` ->
  `Array.from({length: r_numparticles}, () => new ParticleT())`, the same
  substitution sizebuf.ts's own header already documents for `Hunk_AllocName`
  (a fresh allocation is the observable behavior Hunk_AllocName reduces to;
  zone.ts is a concurrent/unlanded unit, out of this unit's scope).
- `static int tracercount` (function-static in R_RocketTrail) becomes a
  module-level `let tracercount = 0` -- JS has no function-static locals;
  nothing else in this file reads it, so the wider (module) scope is not
  observable.
*/

import { Con_Printf } from "./console";
import { COM_CheckParm, COM_FClose, COM_FOpenFile, COM_FRead, Q_atoi, com_argv } from "../common/common";
import { MSG_ReadByte, MSG_ReadChar, MSG_ReadCoord } from "../common/sizebuf";
import { VectorAdd, VectorCopy, VectorNormalize, VectorScale, VectorSubtract, vec3, vec3_origin, type Vec3 } from "../common/mathlib";
import { sv_gravity } from "../server/sv_phys";
import { sv } from "../server/server";
import { cl } from "./client";
import { EntityT, ParticleT, PtypeT, getRenderer } from "./render";

export const MAX_PARTICLES = 2048; // default max # of particles at one time
export const ABSOLUTE_MIN_PARTICLES = 512; // no fewer than this no matter what's on the command line

export const ramp1: readonly number[] = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
export const ramp2: readonly number[] = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
export const ramp3: readonly number[] = [0x6d, 0x6b, 6, 5, 4, 3, 0, 0]; // C initializes only the first 6 of 8

export let active_particles: ParticleT | null = null;
export let free_particles: ParticleT | null = null;

export let particles: ParticleT[] = [];
export let r_numparticles = 0;

// this unit's ruling for r_part.c's bare `rand()` calls
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

//=============================================================================
// anorms.h, verbatim (see file header)

const NUMVERTEXNORMALS = 162;

export const r_avertexnormals: Float32Array = new Float32Array([
  -0.525731, 0.000000, 0.850651,
  -0.442863, 0.238856, 0.864188,
  -0.295242, 0.000000, 0.955423,
  -0.309017, 0.500000, 0.809017,
  -0.162460, 0.262866, 0.951056,
  0.000000, 0.000000, 1.000000,
  0.000000, 0.850651, 0.525731,
  -0.147621, 0.716567, 0.681718,
  0.147621, 0.716567, 0.681718,
  0.000000, 0.525731, 0.850651,
  0.309017, 0.500000, 0.809017,
  0.525731, 0.000000, 0.850651,
  0.295242, 0.000000, 0.955423,
  0.442863, 0.238856, 0.864188,
  0.162460, 0.262866, 0.951056,
  -0.681718, 0.147621, 0.716567,
  -0.809017, 0.309017, 0.500000,
  -0.587785, 0.425325, 0.688191,
  -0.850651, 0.525731, 0.000000,
  -0.864188, 0.442863, 0.238856,
  -0.716567, 0.681718, 0.147621,
  -0.688191, 0.587785, 0.425325,
  -0.500000, 0.809017, 0.309017,
  -0.238856, 0.864188, 0.442863,
  -0.425325, 0.688191, 0.587785,
  -0.716567, 0.681718, -0.147621,
  -0.500000, 0.809017, -0.309017,
  -0.525731, 0.850651, 0.000000,
  0.000000, 0.850651, -0.525731,
  -0.238856, 0.864188, -0.442863,
  0.000000, 0.955423, -0.295242,
  -0.262866, 0.951056, -0.162460,
  0.000000, 1.000000, 0.000000,
  0.000000, 0.955423, 0.295242,
  -0.262866, 0.951056, 0.162460,
  0.238856, 0.864188, 0.442863,
  0.262866, 0.951056, 0.162460,
  0.500000, 0.809017, 0.309017,
  0.238856, 0.864188, -0.442863,
  0.262866, 0.951056, -0.162460,
  0.500000, 0.809017, -0.309017,
  0.850651, 0.525731, 0.000000,
  0.716567, 0.681718, 0.147621,
  0.716567, 0.681718, -0.147621,
  0.525731, 0.850651, 0.000000,
  0.425325, 0.688191, 0.587785,
  0.864188, 0.442863, 0.238856,
  0.688191, 0.587785, 0.425325,
  0.809017, 0.309017, 0.500000,
  0.681718, 0.147621, 0.716567,
  0.587785, 0.425325, 0.688191,
  0.955423, 0.295242, 0.000000,
  1.000000, 0.000000, 0.000000,
  0.951056, 0.162460, 0.262866,
  0.850651, -0.525731, 0.000000,
  0.955423, -0.295242, 0.000000,
  0.864188, -0.442863, 0.238856,
  0.951056, -0.162460, 0.262866,
  0.809017, -0.309017, 0.500000,
  0.681718, -0.147621, 0.716567,
  0.850651, 0.000000, 0.525731,
  0.864188, 0.442863, -0.238856,
  0.809017, 0.309017, -0.500000,
  0.951056, 0.162460, -0.262866,
  0.525731, 0.000000, -0.850651,
  0.681718, 0.147621, -0.716567,
  0.681718, -0.147621, -0.716567,
  0.850651, 0.000000, -0.525731,
  0.809017, -0.309017, -0.500000,
  0.864188, -0.442863, -0.238856,
  0.951056, -0.162460, -0.262866,
  0.147621, 0.716567, -0.681718,
  0.309017, 0.500000, -0.809017,
  0.425325, 0.688191, -0.587785,
  0.442863, 0.238856, -0.864188,
  0.587785, 0.425325, -0.688191,
  0.688191, 0.587785, -0.425325,
  -0.147621, 0.716567, -0.681718,
  -0.309017, 0.500000, -0.809017,
  0.000000, 0.525731, -0.850651,
  -0.525731, 0.000000, -0.850651,
  -0.442863, 0.238856, -0.864188,
  -0.295242, 0.000000, -0.955423,
  -0.162460, 0.262866, -0.951056,
  0.000000, 0.000000, -1.000000,
  0.295242, 0.000000, -0.955423,
  0.162460, 0.262866, -0.951056,
  -0.442863, -0.238856, -0.864188,
  -0.309017, -0.500000, -0.809017,
  -0.162460, -0.262866, -0.951056,
  0.000000, -0.850651, -0.525731,
  -0.147621, -0.716567, -0.681718,
  0.147621, -0.716567, -0.681718,
  0.000000, -0.525731, -0.850651,
  0.309017, -0.500000, -0.809017,
  0.442863, -0.238856, -0.864188,
  0.162460, -0.262866, -0.951056,
  0.238856, -0.864188, -0.442863,
  0.500000, -0.809017, -0.309017,
  0.425325, -0.688191, -0.587785,
  0.716567, -0.681718, -0.147621,
  0.688191, -0.587785, -0.425325,
  0.587785, -0.425325, -0.688191,
  0.000000, -0.955423, -0.295242,
  0.000000, -1.000000, 0.000000,
  0.262866, -0.951056, -0.162460,
  0.000000, -0.850651, 0.525731,
  0.000000, -0.955423, 0.295242,
  0.238856, -0.864188, 0.442863,
  0.262866, -0.951056, 0.162460,
  0.500000, -0.809017, 0.309017,
  0.716567, -0.681718, 0.147621,
  0.525731, -0.850651, 0.000000,
  -0.238856, -0.864188, -0.442863,
  -0.500000, -0.809017, -0.309017,
  -0.262866, -0.951056, -0.162460,
  -0.850651, -0.525731, 0.000000,
  -0.716567, -0.681718, -0.147621,
  -0.716567, -0.681718, 0.147621,
  -0.525731, -0.850651, 0.000000,
  -0.500000, -0.809017, 0.309017,
  -0.238856, -0.864188, 0.442863,
  -0.262866, -0.951056, 0.162460,
  -0.864188, -0.442863, 0.238856,
  -0.809017, -0.309017, 0.500000,
  -0.688191, -0.587785, 0.425325,
  -0.681718, -0.147621, 0.716567,
  -0.442863, -0.238856, 0.864188,
  -0.587785, -0.425325, 0.688191,
  -0.309017, -0.500000, 0.809017,
  -0.147621, -0.716567, 0.681718,
  -0.425325, -0.688191, 0.587785,
  -0.162460, -0.262866, 0.951056,
  0.442863, -0.238856, 0.864188,
  0.162460, -0.262866, 0.951056,
  0.309017, -0.500000, 0.809017,
  0.147621, -0.716567, 0.681718,
  0.000000, -0.525731, 0.850651,
  0.425325, -0.688191, 0.587785,
  0.587785, -0.425325, 0.688191,
  0.688191, -0.587785, 0.425325,
  -0.955423, 0.295242, 0.000000,
  -0.951056, 0.162460, 0.262866,
  -1.000000, 0.000000, 0.000000,
  -0.850651, 0.000000, 0.525731,
  -0.955423, -0.295242, 0.000000,
  -0.951056, -0.162460, 0.262866,
  -0.864188, 0.442863, -0.238856,
  -0.951056, 0.162460, -0.262866,
  -0.809017, 0.309017, -0.500000,
  -0.864188, -0.442863, -0.238856,
  -0.951056, -0.162460, -0.262866,
  -0.809017, -0.309017, -0.500000,
  -0.681718, 0.147621, -0.716567,
  -0.681718, -0.147621, -0.716567,
  -0.850651, 0.000000, -0.525731,
  -0.688191, 0.587785, -0.425325,
  -0.587785, 0.425325, -0.688191,
  -0.425325, 0.688191, -0.587785,
  -0.425325, -0.688191, -0.587785,
  -0.587785, -0.425325, -0.688191,
  -0.688191, -0.587785, -0.425325,
]);

// vec3_t avelocities[NUMVERTEXNORMALS] -- see file header for the flat
// aliasing this reproduces.
export const avelocities: Float32Array = new Float32Array(NUMVERTEXNORMALS * 3);

export const beamlength = 16;

/*
===============
R_EntityParticles
===============
*/
export function R_EntityParticles(ent: EntityT): void {
  const dist = 64;

  if (avelocities[0] === 0) {
    for (let i = 0; i < NUMVERTEXNORMALS * 3; i++) avelocities[i] = (rand() & 255) * 0.01;
  }

  const forward = vec3();

  for (let i = 0; i < NUMVERTEXNORMALS; i++) {
    let angle = cl.time * avelocities[i * 3 + 0];
    const sy = Math.sin(angle);
    const cy = Math.cos(angle);
    angle = cl.time * avelocities[i * 3 + 1];
    const sp = Math.sin(angle);
    const cp = Math.cos(angle);
    angle = cl.time * avelocities[i * 3 + 2];
    // sin(angle)/cos(angle) are computed by the C too, but never used (no
    // right/up vector is built here, only `forward`); dropped since nothing
    // reads them (unlike `sy`/`cy`/`sp`/`cp`, which forward[] does read).

    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;

    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    p.die = cl.time + 0.01;
    p.color = 0x6f;
    p.type = PtypeT.pt_explode;

    p.org[0] = ent.origin[0] + r_avertexnormals[i * 3 + 0] * dist + forward[0] * beamlength;
    p.org[1] = ent.origin[1] + r_avertexnormals[i * 3 + 1] * dist + forward[1] * beamlength;
    p.org[2] = ent.origin[2] + r_avertexnormals[i * 3 + 2] * dist + forward[2] * beamlength;
  }
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
// file header)
const FSCANF_FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function R_ReadPointFile_f(): void {
  const name = `maps/${sv.name}.pts`;

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
R_ParseParticleEffect

Parse an effect out of the server message
===============
*/
export function R_ParseParticleEffect(): void {
  const org = vec3();
  const dir = vec3();

  for (let i = 0; i < 3; i++) org[i] = MSG_ReadCoord();
  for (let i = 0; i < 3; i++) dir[i] = MSG_ReadChar() * (1.0 / 16);
  const msgcount = MSG_ReadByte();
  const color = MSG_ReadByte();

  const count = msgcount === 255 ? 1024 : msgcount;

  R_RunParticleEffect(org, dir, color, count);
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
R_ParticleExplosion2

===============
*/
export function R_ParticleExplosion2(org: Vec3, colorStart: number, colorLength: number): void {
  let colorMod = 0;

  for (let i = 0; i < 512; i++) {
    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    p.die = cl.time + 0.3;
    p.color = colorStart + (colorMod % colorLength);
    colorMod++;

    p.type = PtypeT.pt_blob;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() % 32) - 16);
      p.vel[j] = (rand() % 512) - 256;
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

===============
*/
export function R_RunParticleEffect(org: Vec3, dir: Vec3, color: number, count: number): void {
  for (let i = 0; i < count; i++) {
    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    if (count === 1024) {
      // rocket explosion
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
    } else {
      p.die = cl.time + 0.1 * (rand() % 5);
      p.color = (color & ~7) + (rand() & 7);
      p.type = PtypeT.pt_slowgrav;
      for (let j = 0; j < 3; j++) {
        p.org[j] = org[j] + ((rand() & 15) - 8);
        p.vel[j] = dir[j] * 15; // + (rand()%300)-150;
      }
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
        p.type = PtypeT.pt_slowgrav;

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
        p.type = PtypeT.pt_slowgrav;

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

export function R_RocketTrail(start: Vec3, end: Vec3, type: number): void {
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  let dec: number;
  if (type < 128) {
    dec = 3;
  } else {
    dec = 1;
    type -= 128;
  }

  let j = 0;

  while (len > 0) {
    len -= dec;

    if (!free_particles) return;
    const p = free_particles;
    free_particles = p.next;
    p.next = active_particles;
    active_particles = p;

    VectorCopy(vec3_origin, p.vel);
    p.die = cl.time + 2;

    switch (type) {
      case 0: // rocket trail
        p.ramp = rand() & 3;
        p.color = ramp3[Math.trunc(p.ramp)];
        p.type = PtypeT.pt_fire;
        for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
        break;

      case 1: // smoke smoke
        p.ramp = (rand() & 3) + 2;
        p.color = ramp3[Math.trunc(p.ramp)];
        p.type = PtypeT.pt_fire;
        for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
        break;

      case 2: // blood
        p.type = PtypeT.pt_grav;
        p.color = 67 + (rand() & 3);
        for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
        break;

      case 3:
      case 5: // tracer
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
        break;

      case 4: // slight blood
        p.type = PtypeT.pt_grav;
        p.color = 67 + (rand() & 3);
        for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() % 6) - 3);
        len -= 3;
        break;

      case 6: // voor trail
        p.color = 9 * 16 + 8 + (rand() & 3);
        p.type = PtypeT.pt_static;
        p.die = cl.time + 0.3;
        for (j = 0; j < 3; j++) p.org[j] = start[j] + ((rand() & 15) - 8);
        break;
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

  const frametime = cl.time - cl.oldtime;
  const time3 = frametime * 15;
  const time2 = frametime * 10; // 15;
  const time1 = frametime * 5;
  const grav = frametime * sv_gravity.value * 0.05;
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
