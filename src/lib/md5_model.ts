// md5_model.ts -- MD5 skeletal model loader (mesh + anim) and CPU skinning.
// Lifted from quake-2-re-ts src/qcommon/md5_model.ts at 7e88015 (GPLv2, our
// own repo), which itself ports the 2023 Quake II re-release engine
// (q2repro, Jonathan "Paril" Barkley et al., GPLv2)'s
// src/refresh/models.c `#if USE_MD5` block (MD5_ParseMesh/MD5_ParseAnim/
// MD5_BuildFrameSkeleton/MD5_ComputeNormals, lines 767-1349) and
// src/refresh/mesh.c's `#if USE_MD5` CPU-skinning block (calc_skel_vert,
// lines 747-773), plus the MD5-only quaternion helpers in src/common/math.c
// (Quat_ComputeW/Quat_Conjugate/Quat_MultiplyQuat/Quat_MultiplyVector/
// Quat_RotatePoint/Quat_ToAxis/Quat_SLerp/Quat_Normalize, lines 529-678) and
// the VectorRotate(in,axis,out) macro (inc/shared/shared.h:256). The MD5
// text grammar (MD5Version 10, joints/mesh/hierarchy/baseframe/frame
// blocks) is the same open format on both games; only the surrounding
// engine plumbing and a couple of Q1-specific facts (below) differ.
//
// DECOUPLING FOR src/lib (a file under src/lib imports nothing from src/
// outside src/lib -- ARCHITECTURE.md "Source layout"). quake-2-re-ts's copy
// reached outside itself for four things this port drops or replaces:
//   - Vec3/Quat math (src/shared/math.ts's DotProduct/VectorAdd/.../
//     CrossProduct and this file's own quaternion helpers): src/lib has no
//     shared vector-math module to import (src/common/mathlib.ts sits
//     outside src/lib), so the small subset this file actually needs is
//     inlined below, self-contained, under the same names quake-2-re-ts
//     used.
//   - COM_FilePath/COM_FileBase (used by Q2's own md5PathsFor to build a
//     "<dir>/md5/<base>.md5mesh" path next to a .md2): DROPPED along with
//     that whole Q2-specific "md5/ subdirectory" convention. Quake 1's
//     re-release ships the MD5 pair directly beside the .mdl with the SAME
//     basename and directory -- see mapping rule 1 below. The replacement
//     md5PathsFor here is a plain extension swap, no external helper
//     needed.
//   - Md5ScaleSourceT / loadMd5Scales (the ".md5scale" JSON sidecar for
//     per-joint per-frame scale overrides, models.c:1131-1217): DROPPED
//     entirely. The MD5 grammar itself has no scale concept -- q2repro
//     invented the sidecar file as its own extension. Checked: zero
//     ".md5scale" files exist anywhere across all seven Quake 1 re-release
//     trees' pak0.pak (id1/hipnotic/rogue/mg1/mg3/ctf/dopa). With no
//     sidecar ever present, Md5SkeletonJointT below carries no `scale`
//     field either -- calc_skel_vert's `VectorMA(joint.pos, joint.scale,
//     wv, wv)` and MD5_BuildFrameSkeleton's `if (info.scalePos)
//     VectorScale(...)` both fold to the constant-1.0 case their own math
//     already collapses to when no scale override exists, so calcSkelVert
//     and buildFrameSkeleton below use a plain VectorAdd/no-scale in their
//     place. Md5JointInfoT correspondingly drops `scalePos`.
//   - The `warn: (msg: string) => void` parameter Q2's parseMd5Anim took:
//     DROPPED. Q2's own MD5_ParseMesh/MD5_ParseAnim never call Com_Printf
//     on their own account -- the only call site was loadMd5Scales's "No
//     such joint"/"No such frame" warnings, which is gone along with the
//     scale sidecar above. Nothing is left needing a logging seam; if a
//     future Q1 mapping rule needs one, thread a LibLog (src/lib/errors.ts)
//     through then, following loc.ts's own precedent.
//   - md5ReplacementAllowed/md5SkinPathFor (Q2's own MD2-vs-MD5
//     search-path-tier upgrade rules, and its "MD5 skins live in a
//     parallel md5/ subdirectory with the SAME extension as the MD2 skin"
//     rule): DROPPED. Quake 1 has no MD2-style "try to find a nicer
//     replacement model at a higher search-path tier" mechanism for its
//     .mdl/.md5 pairs -- both always ship together in the same pak (see
//     mapping rule 1) -- and its skin naming rule is different enough
//     (mapping rule 2) that reusing the Q2 helper under a Q1-true body
//     would just be a same-named function doing something else. A later
///    renderer/model-loading unit owns deriving the real skin path; this
//     module only keeps `shader` on Md5MeshT as Q2's copy already did, "for
//     diagnostics/tests only".
//
// Also new here, not present in Q2's copy: an explicit per-frame skinning
// entry point for a renderer to drive without allocating (md5Skin,
// buildFramePose, frameJointsAt, createJointPose below) -- Q2's own port
// only ever drove calc_skel_vert per-vertex from its own gl_mesh.ts/
// r_model.ts call sites, which don't exist here yet (this unit lands ahead
// of the GL/software renderer MD5 support, per ARCHITECTURE.md's phase
// plan). See those functions' own comments.
//
// QUAKE 1 RE-RELEASE MAPPING RULES (verified against the real retail data,
// .../qfiles/q1/rerelease, and against Ironwail's MD5 loader -- the GPLv2
// reference named in ARCHITECTURE.md's "Renderers" section --
// Quake/gl_model.c's MD5Anim_Begin/MD5Anim_Load ~4040-4110,
// Mod_LoadMD5MeshModel ~4272-4470, Mod_LoadMD5Skins ~4215-4230):
//
//   1. FILE DISCOVERY. Unlike Q2's "models/<dir>/md5/tris.md5mesh in a
//      subdirectory beside tris.md2" convention, Quake 1's re-release ships
//      the MD5 pair directly beside the .mdl, SAME directory, SAME
//      basename, just a different extension: "progs/dog.mdl" pairs with
//      "progs/dog.md5mesh" + "progs/dog.md5anim" (Ironwail's
//      MD5Anim_Begin does exactly COM_StripExtension + COM_AddExtension
//      (".md5anim") on the model's own path, gl_model.c:4046-4050 --
//      no subdirectory insertion at all). Confirmed against every one of
//      id1/pak0.pak's 59 "progs/*.md5mesh" files: 58 have a matching
//      "progs/*.md5anim" (the sole exception, "progs/health100.md5mesh",
//      ships with no .md5anim at all -- a static-pose-only mesh with no
//      .mdl counterpart either) plus mg3/pak0.pak's 5 extra pairs
//      (dog_explosive, ogre_rocket, shambler_blood, v_bloodshot,
//      v_bloodshot2). hipnotic/rogue/mg1/ctf/dopa ship no MD5 data at all.
//      md5PathsFor below implements this Q1 rule (plain extension swap).
//
//   2. SHADER -> SKIN. The .md5mesh "shader" string is always exactly the
//      model's own basename with no path (verified: "dog"/"boss"/"ogre"/
//      "armor"/"grenade"/... all equal their "progs/<name>.mdl" name,
//      across every one of the 48 id1 pairs that also ship an .mdl).
//      Ironwail's Mod_LoadMD5Skins builds the real skin filename as
//      "progs/<shader>_<skingroup:02>_<frame:02>" (extension-probed --
//      confirmed present as classic-format ".lmp" 8-bit images in the real
//      data, e.g. "progs/dog_00_00.lmp", "progs/boss_00_00.lmp", and
//      "progs/armor_00_00.lmp"/"_01_00.lmp"/"_02_00.lmp" for armor's three
//      pickup-color skin groups). This module keeps `shader` on Md5MeshT
//      for diagnostics only, same as Q2's own copy -- deriving and loading
//      the real skin path is a renderer/texture-loading concern (no FS, no
//      renderer types in scope here).
//
//   3. FRAME INDEX. QuakeC's `.frame` field addresses the .mdl's own frame
//      table, but Ironwail's Mod_LoadMD5MeshModel entirely discards the
//      .mdl's own frame data once a valid MD5 pair loads, rebuilding the
//      model's frame table 1:1 from the md5anim instead: one framegroup of
//      exactly one pose per anim frame (`surf->frames[j].firstpose = j;
//      numposes = 1`, gl_model.c:4378-4384), so the built model's total
//      frame count becomes the ANIM's numFrames, not the .mdl's. For every
//      animated character/monster pair sampled, the .mdl's own numframes
//      equals the md5anim's numFrames exactly -- dog 86/86, boss 106/106,
//      ogre 147/147, and 21 more of id1's 48 mdl+md5 pairs -- so `.frame`
//      maps straight across, index for index, with nothing for a renderer
//      to reconcile. For the remaining 24 pairs (single-joint pickup items:
//      armor, both key colors, backpack, powerups, ammo boxes, grenade,
//      missile, the four "end" trophies) the .mdl has exactly 1 static
//      frame while the md5anim carries 2 -- Ironwail marks these models'
//      synctype ST_FRAMETIME (gl_model.c:4484) so the extra frame cycles by
//      elapsed time rather than by the QuakeC's unchanging `.frame = 0`.
//      This module always exposes the ANIM's own frame data (frameCount
//      below is the parsed md5anim's numFrames, unconditionally);
//      reconciling that against a loaded .mdl's own frame count -- and
//      picking ST_FRAMETIME-style time-based cycling when they differ --
//      is the renderer/model-loading unit's job, not this one's (bytes in,
//      typed structures out, no renderer types).
//
//   4. FLAGS (EF_ROCKET trails, EF_ROTATE spin, etc). The MD5 grammar
//      carries no flags field at all, and this module parses none.
//      Ironwail's own comment at the point it finishes loading an MD5
//      model says it plainly: "the md5 format does not have its own
//      modelflags, yet we still need to know about trails and rotating
//      etc, so we reuse the flags from the mdl version" (gl_model.c:4482).
//      Confirmed against the retail .mdl headers: every one of the 24
//      pickup items in rule 3 carries EF_ROTATE (flags=8) on its .mdl,
//      "progs/grenade.mdl" carries EF_GRENADE (flags=2), and
//      "progs/missile.mdl" carries EF_ROCKET (flags=1). A renderer combines
//      this module's skeletal geometry with the paired .mdl's own header
//      flags; nothing here changes for that.
//
//   5. A REAL BROKEN PAIR EXISTS, AND REJECTING IT IS CORRECT.
//      "mg3/progs/ogre_rocket.md5mesh" declares numJoints 55 (its "joints"
//      block's root entry even lists a parent index of 54, into its own
//      declared-but-never-animated tail), while its paired
//      "mg3/progs/ogre_rocket.md5anim" declares numJoints 39 -- the same
//      skeleton size as "progs/ogre.md5anim" (both 39 joints, both 147
//      frames; ogre_rocket is evidently an ogre-skeleton attachment mesh
//      exported with extra unanimated helper/locator bones its own anim
//      file never carries). Ironwail's own MD5Anim_Load enforces the exact
//      same strict equality this module does (`if (ctx->numjoints !=
//      numbones) MD5ERROR(...)`, its own bone-count check) -- Ironwail
//      would ALSO fail to load this specific pair as MD5 and fall back to
//      "progs/ogre_rocket.mdl" (confirmed present in mg3/pak0.pak, 147
//      frames, matching the .md5anim's own frame count). parseMd5Anim below
//      throws Md5FormatError for this real file for the same reason
//      Ironwail rejects it -- the FIDELITY RAZOR cutting the OTHER way: a
//      lenient parser that "fixed" this real data would produce an
//      observable result (a skinned ogre_rocket mesh) the KEX engine itself
//      never shows.
//
// Md5MeshT.numMeshes is always 1 in every real Quake 1 re-release file
// sampled (unlike Q2, which supports multi-mesh MD5 models); the multi-mesh
// loop below is kept anyway since the grammar itself allows it and nothing
// about parsing it is Q2-specific.

import { COM_Parse, type ComParseState } from "./tokenizer";
import { Md5FormatError } from "./errors";

//============================================================================
// constants (q2repro gl.h:393-397, 962-963)

export const MD5_VERSION = 10;
export const MD5_MAX_JOINTS = 256;
export const MD5_MAX_MESHES = 32;
export const MD5_MAX_WEIGHTS = 8192;
export const MD5_MAX_FRAMES = 1024;
const MD5_NUM_ANIMATED_COMPONENT_BITS = 6; // models.c:1074

// q2repro gl.h:962-963's fixed immediate-mode scratch-buffer caps
// (TESS_MAX_VERTICES/TESS_MAX_INDICES), reused here only as parser sanity
// bounds on numverts/numtris, same as Q2's own copy -- not tied to any
// Quake-1-specific limit, just "a .md5mesh this large is corrupt or hostile
// input either way".
const TESS_MAX_VERTICES = 6144;
const TESS_MAX_INDICES = 3 * TESS_MAX_VERTICES;

//============================================================================
// vector/quaternion math -- inlined (see header comment: src/lib has no
// shared vector-math module to import). Same names/semantics as
// quake-2-re-ts's src/shared/math.ts subset and its own math.c-ported
// quaternion helpers.

export type Vec3 = Float32Array;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

function DotProduct(x: Vec3, y: Vec3): number {
  return x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
}

function VectorAdd(a: Vec3, b: Vec3, out: Vec3): void {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
}

function VectorSubtract(a: Vec3, b: Vec3, out: Vec3): void {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
}

function VectorCopy(a: Vec3, out: Vec3): void {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
}

function VectorClear(a: Vec3): void {
  a[0] = 0;
  a[1] = 0;
  a[2] = 0;
}

function VectorScale(vin: Vec3, scale: number, out: Vec3): void {
  out[0] = vin[0] * scale;
  out[1] = vin[1] * scale;
  out[2] = vin[2] * scale;
}

function VectorMA(veca: Vec3, scale: number, vecb: Vec3, out: Vec3): void {
  out[0] = veca[0] + scale * vecb[0];
  out[1] = veca[1] + scale * vecb[1];
  out[2] = veca[2] + scale * vecb[2];
}

function CrossProduct(v1: Vec3, v2: Vec3, cross: Vec3): void {
  cross[0] = v1[1] * v2[2] - v1[2] * v2[1];
  cross[1] = v1[2] * v2[0] - v1[0] * v2[2];
  cross[2] = v1[0] * v2[1] - v1[1] * v2[0];
}

function VectorNormalize(v: Vec3): number {
  const length = Math.sqrt(DotProduct(v, v));
  if (length) {
    const ilength = 1 / length;
    v[0] *= ilength;
    v[1] *= ilength;
    v[2] *= ilength;
  }
  return length;
}

export type Quat = Float32Array; // (x, y, z, w), matches math.c's `#define X 0 / Y 1 / Z 2 / W 3`

export function quat(x = 0, y = 0, z = 0, w = 0): Quat {
  const q = new Float32Array(4);
  q[0] = x;
  q[1] = y;
  q[2] = z;
  q[3] = w;
  return q;
}

const QX = 0;
const QY = 1;
const QZ = 2;
const QW = 3;

export function Quat_ComputeW(q: Quat): void {
  const t = 1.0 - q[QX] * q[QX] - q[QY] * q[QY] - q[QZ] * q[QZ];
  q[QW] = t < 0.0 ? 0.0 : -Math.sqrt(t); // note the sign: math.c literally negates sqrtf(t), not a typo to "fix"
}

function Quat_Conjugate(inQ: Quat, out: Quat): void {
  const w = inQ[QW];
  const x = -inQ[QX];
  const y = -inQ[QY];
  const z = -inQ[QZ];
  out[QW] = w;
  out[QX] = x;
  out[QY] = y;
  out[QZ] = z;
}

function Quat_MultiplyQuat(qa: Quat, qb: Quat, out: Quat): void {
  const w = qa[QW] * qb[QW] - qa[QX] * qb[QX] - qa[QY] * qb[QY] - qa[QZ] * qb[QZ];
  const x = qa[QX] * qb[QW] + qa[QW] * qb[QX] + qa[QY] * qb[QZ] - qa[QZ] * qb[QY];
  const y = qa[QY] * qb[QW] + qa[QW] * qb[QY] + qa[QZ] * qb[QX] - qa[QX] * qb[QZ];
  const z = qa[QZ] * qb[QW] + qa[QW] * qb[QZ] + qa[QX] * qb[QY] - qa[QY] * qb[QX];
  out[QW] = w;
  out[QX] = x;
  out[QY] = y;
  out[QZ] = z;
}

const quatMulScratch = quat();
const quatConjScratch = quat();
const quatVecScratch = quat();

function Quat_MultiplyVector(q: Quat, v: Vec3, out: Quat): void {
  const w = -(q[QX] * v[0]) - q[QY] * v[1] - q[QZ] * v[2];
  const x = q[QW] * v[0] + q[QY] * v[2] - q[QZ] * v[1];
  const y = q[QW] * v[1] + q[QZ] * v[0] - q[QX] * v[2];
  const z = q[QW] * v[2] + q[QX] * v[1] - q[QY] * v[0];
  out[QW] = w;
  out[QX] = x;
  out[QY] = y;
  out[QZ] = z;
}

export function Quat_RotatePoint(q: Quat, inV: Vec3, out: Vec3): void {
  // Assume q is a unit quaternion (math.c's own assumption, unchecked there too)
  Quat_Conjugate(q, quatConjScratch);
  Quat_MultiplyVector(q, inV, quatVecScratch);
  Quat_MultiplyQuat(quatVecScratch, quatConjScratch, quatMulScratch);
  out[0] = quatMulScratch[QX];
  out[1] = quatMulScratch[QY];
  out[2] = quatMulScratch[QZ];
}

export function Quat_ToAxis(q: Quat, axis: readonly [Vec3, Vec3, Vec3]): void {
  const q0 = q[QW];
  const q1 = q[QX];
  const q2 = q[QY];
  const q3 = q[QZ];

  axis[0][0] = 2 * (q0 * q0 + q1 * q1) - 1;
  axis[0][1] = 2 * (q1 * q2 - q0 * q3);
  axis[0][2] = 2 * (q1 * q3 + q0 * q2);

  axis[1][0] = 2 * (q1 * q2 + q0 * q3);
  axis[1][1] = 2 * (q0 * q0 + q2 * q2) - 1;
  axis[1][2] = 2 * (q2 * q3 - q0 * q1);

  axis[2][0] = 2 * (q1 * q3 - q0 * q2);
  axis[2][1] = 2 * (q2 * q3 + q0 * q1);
  axis[2][2] = 2 * (q0 * q0 + q3 * q3) - 1;
}

export function Quat_Normalize(q: Quat): number {
  const length = Math.sqrt(q[QX] * q[QX] + q[QY] * q[QY] + q[QZ] * q[QZ] + q[QW] * q[QW]);
  if (length) {
    const ilength = 1 / length;
    q[QX] *= ilength;
    q[QY] *= ilength;
    q[QZ] *= ilength;
    q[QW] *= ilength;
  }
  return length;
}

const DOT_THRESHOLD = 0.9995;

export function Quat_SLerp(qa: Quat, qb: Quat, backlerp: number, frontlerp: number, out: Quat): void {
  if (backlerp <= 0.0) {
    out[0] = qb[0];
    out[1] = qb[1];
    out[2] = qb[2];
    out[3] = qb[3];
    return;
  } else if (backlerp >= 1.0) {
    out[0] = qa[0];
    out[1] = qa[1];
    out[2] = qa[2];
    out[3] = qa[3];
    return;
  }

  let cosOmega = qa[QX] * qb[QX] + qa[QY] * qb[QY] + qa[QZ] * qb[QZ] + qa[QW] * qb[QW];

  let q1w = qb[QW];
  let q1x = qb[QX];
  let q1y = qb[QY];
  let q1z = qb[QZ];

  if (cosOmega < 0.0) {
    q1w = -q1w;
    q1x = -q1x;
    q1y = -q1y;
    q1z = -q1z;
    cosOmega = -cosOmega;
  }

  let k0: number;
  let k1: number;

  if (cosOmega > DOT_THRESHOLD) {
    k0 = backlerp;
    k1 = frontlerp;
  } else {
    const sinOmega = Math.sqrt(1.0 - cosOmega * cosOmega);
    const omega = Math.atan2(sinOmega, cosOmega);
    const oneOverSinOmega = 1.0 / sinOmega;

    k0 = Math.sin(backlerp * omega) * oneOverSinOmega;
    k1 = Math.sin(frontlerp * omega) * oneOverSinOmega;
  }

  out[QW] = k0 * qa[QW] + k1 * q1w;
  out[QX] = k0 * qa[QX] + k1 * q1x;
  out[QY] = k0 * qa[QY] + k1 * q1y;
  out[QZ] = k0 * qa[QZ] + k1 * q1z;
}

// VectorRotate(in,axis,out) (shared.h:256) -- NOT Quat_RotatePoint. Dots
// `in` against each of axis's three ROWS: out[i] = DotProduct(in, axis[i]).
function VectorRotateByAxis(inV: Vec3, axis: readonly [Vec3, Vec3, Vec3], out: Vec3): void {
  out[0] = DotProduct(inV, axis[0]);
  out[1] = DotProduct(inV, axis[1]);
  out[2] = DotProduct(inV, axis[2]);
}

//============================================================================
// types (q2repro gl.h:404-449)

// baseframe_joint_t (models.c:858-861) -- bind-pose joint from either
// .md5mesh's "joints" block or .md5anim's "baseframe" block.
export class Md5BaseJointT {
  pos: Vec3 = vec3();
  orient: Quat = quat();
}

// joint_info_t (models.c:1068-1072) -- one .md5anim "hierarchy" entry.
// No `scalePos` (Q2's own field for its dropped .md5scale sidecar -- see
// this file's header comment).
export class Md5JointInfoT {
  name = "";
  parent = -1;
  flags = 0;
  startIndex = 0;
}

// md5_joint_t (gl.h:405-410) -- one joint of one built (per-frame)
// skeleton. No `scale` field (see header comment: Q1 never ships a
// .md5scale sidecar, so it would always be the constant 1.0 anyway).
export class Md5SkeletonJointT {
  pos: Vec3 = vec3();
  orient: Quat = quat();
  axis: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];
}

function copySkeletonJoint(src: Md5SkeletonJointT, dst: Md5SkeletonJointT): void {
  VectorCopy(src.pos, dst.pos);
  dst.orient[0] = src.orient[0];
  dst.orient[1] = src.orient[1];
  dst.orient[2] = src.orient[2];
  dst.orient[3] = src.orient[3];
  VectorCopy(src.axis[0], dst.axis[0]);
  VectorCopy(src.axis[1], dst.axis[1]);
  VectorCopy(src.axis[2], dst.axis[2]);
}

// md5_vertex_t (gl.h:412-418)
export class Md5VertexT {
  normal: Vec3 = vec3(); // joint-local-blended bind-pose normal, see computeNormals
  start = 0; // first weight index
  count = 0; // weight count
}

// md5_weight_t (gl.h:420-424)
export class Md5WeightT {
  pos: Vec3 = vec3();
  bias = 0;
}

// maliastc_t as used by md5_mesh_t.tcoords (gl.h:432)
export class Md5TCoordT {
  s = 0;
  t = 0;
}

// md5_mesh_t (gl.h:427-437)
export class Md5MeshT {
  shader = ""; // the .md5mesh "shader" string -- see mapping rule 2 above (always the model's own basename)
  numVerts = 0;
  numIndices = 0; // 3 * numTris
  numWeights = 0;
  vertices: Md5VertexT[] = [];
  tcoords: Md5TCoordT[] = [];
  indices: number[] = []; // flat triangle list, 3 per tri (uint16_t on disk)
  weights: Md5WeightT[] = [];
  jointnums: number[] = []; // per-weight joint index (uint8_t on disk)
}

// md5_model_t (gl.h:439-449)
export class Md5ModelT {
  numMeshes = 0;
  numJoints = 0;
  numFrames = 0; // see mapping rule 3 above: always the ANIM's own frame count
  meshes: Md5MeshT[] = [];
  skeletonFrames: Md5SkeletonJointT[] = []; // flat [frame * numJoints + joint]
}

//============================================================================
// tiny COM_Parse-based tokenizer wrappers (MD5_ParseExpect/ParseFloat/
// ParseUint/ParseInt/ParseVector, models.c:801-856) -- reuse src/lib's own
// tokenizer.ts (this port's real vanilla COM_Parse, already lifted for
// kfont.ts's ParseKfont) rather than reinventing one.

function expectToken(state: ComParseState, expect: string, path: string): void {
  const token = COM_Parse(state);
  if (token !== expect) throw new Md5FormatError(`${path}: line ${lineOf(state)}: expected "${expect}", got "${token}"`);
}

function skipToken(state: ComParseState): void {
  COM_Parse(state);
}

// COM_Parse has no line tracking (unlike q2repro's com_linenum); approximate
// for diagnostics only by counting newlines consumed so far.
function lineOf(state: ComParseState): number {
  let line = 1;
  for (let i = 0; i < state.index && i < state.data.length; i++) if (state.data[i] === "\n") line++;
  return line;
}

function parseFloatTok(state: ComParseState, path: string): number {
  const token = COM_Parse(state);
  const v = Number(token);
  if (token === "" || Number.isNaN(v)) throw new Md5FormatError(`${path}: line ${lineOf(state)}: expected float, got "${token}"`);
  return v;
}

function parseUintTok(state: ComParseState, path: string, minV: number, maxV: number): number {
  const token = COM_Parse(state);
  const v = Number(token);
  if (token === "" || !Number.isInteger(v) || v < 0) throw new Md5FormatError(`${path}: line ${lineOf(state)}: expected uint, got "${token}"`);
  if (v < minV || v > maxV) throw new Md5FormatError(`${path}: line ${lineOf(state)}: value out of range: ${v}`);
  return v;
}

function parseIntTok(state: ComParseState, path: string, minV: number, maxV: number): number {
  const token = COM_Parse(state);
  const v = Number(token);
  if (token === "" || !Number.isInteger(v)) throw new Md5FormatError(`${path}: line ${lineOf(state)}: expected int, got "${token}"`);
  if (v < minV || v > maxV) throw new Md5FormatError(`${path}: line ${lineOf(state)}: value out of range: ${v}`);
  return v;
}

function parseVectorTok(state: ComParseState, path: string, out: Vec3): void {
  expectToken(state, "(", path);
  out[0] = parseFloatTok(state, path);
  out[1] = parseFloatTok(state, path);
  out[2] = parseFloatTok(state, path);
  expectToken(state, ")", path);
}

//============================================================================
// MD5_ComputeNormals (models.c:863-945) -- angle-weighted bind-pose vertex
// normals, blended into joint-local space per weight so calcSkelVert can
// re-project them cheaply at animation time.

function vec3Key(v: Vec3): string {
  // exact-value dedup key, mirroring q2repro's HashMap_Create(vec3_t, vec3_t,
  // &HashVec3, NULL) exact-match grouping of finalVerts by float value.
  return `${v[0]}|${v[1]}|${v[2]}`;
}

function computeNormals(mesh: Md5MeshT, baseSkeleton: readonly Md5BaseJointT[]): void {
  const finalVerts: Vec3[] = mesh.vertices.map(() => vec3());

  for (let i = 0; i < mesh.numVerts; i++) {
    const vert = mesh.vertices[i];
    const out = finalVerts[i];
    VectorClear(out);

    for (let j = 0; j < vert.count; j++) {
      const weight = mesh.weights[vert.start + j];
      const joint = baseSkeleton[mesh.jointnums[vert.start + j]];

      const wv = vec3();
      Quat_RotatePoint(joint.orient, weight.pos, wv);
      VectorAdd(joint.pos, wv, wv);
      VectorMA(out, weight.bias, wv, out);
    }
  }

  const posToNormal = new Map<string, Vec3>();

  for (let i = 0; i < mesh.numIndices; i += 3) {
    const xyz: Vec3[] = [finalVerts[mesh.indices[i]], finalVerts[mesh.indices[i + 1]], finalVerts[mesh.indices[i + 2]]];

    const d1 = vec3();
    VectorSubtract(xyz[2], xyz[0], d1);
    const d2 = vec3();
    VectorSubtract(xyz[1], xyz[0], d2);
    VectorNormalize(d1);
    VectorNormalize(d2);

    const norm = vec3();
    CrossProduct(d1, d2, norm);
    VectorNormalize(norm);

    const angle = Math.acos(DotProduct(d1, d2)); // no clamping in the C original either -- NaN on degenerate triangles is the original's own behavior
    VectorScale(norm, angle, norm);

    for (let j = 0; j < 3; j++) {
      const key = vec3Key(xyz[j]);
      const found = posToNormal.get(key);
      if (found) VectorAdd(found, norm, found);
      else posToNormal.set(key, vec3(norm[0], norm[1], norm[2]));
    }
  }

  for (const norm of posToNormal.values()) VectorNormalize(norm);

  for (let i = 0; i < mesh.numVerts; i++) {
    const vert = mesh.vertices[i];
    VectorClear(vert.normal);
    const norm = posToNormal.get(vec3Key(finalVerts[i]));
    if (!norm) continue;

    for (let j = 0; j < vert.count; j++) {
      const weight = mesh.weights[vert.start + j];
      const joint = baseSkeleton[mesh.jointnums[vert.start + j]];

      const orientInv = quat();
      Quat_Conjugate(joint.orient, orientInv);
      const wv = vec3();
      Quat_RotatePoint(orientInv, norm, wv);
      VectorMA(vert.normal, weight.bias, wv, vert.normal);
    }
  }
}

//============================================================================
// MD5_ParseMesh (models.c:947-1066)

export function parseMd5Mesh(text: string, path: string): Md5ModelT {
  const state: ComParseState = { data: text, index: 0 };

  expectToken(state, "MD5Version", path);
  expectToken(state, String(MD5_VERSION), path);

  const model = new Md5ModelT();

  expectToken(state, "commandline", path);
  skipToken(state);

  expectToken(state, "numJoints", path);
  model.numJoints = parseUintTok(state, path, 1, MD5_MAX_JOINTS);

  expectToken(state, "numMeshes", path);
  model.numMeshes = parseUintTok(state, path, 1, MD5_MAX_MESHES);

  expectToken(state, "joints", path);
  expectToken(state, "{", path);

  const baseSkeleton: Md5BaseJointT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const joint = new Md5BaseJointT();
    skipToken(state); // name -- unused by MD5_ParseMesh; real joint names come from the .md5anim hierarchy instead
    skipToken(state); // parent -- likewise unused here
    parseVectorTok(state, path, joint.pos);
    parseVectorTok(state, path, joint.orient); // (x y z) triple on disk; w recomputed next
    Quat_ComputeW(joint.orient);
    baseSkeleton.push(joint);
  }
  expectToken(state, "}", path);

  for (let m = 0; m < model.numMeshes; m++) {
    const mesh = new Md5MeshT();

    expectToken(state, "mesh", path);
    expectToken(state, "{", path);

    expectToken(state, "shader", path);
    mesh.shader = COM_Parse(state);

    expectToken(state, "numverts", path);
    mesh.numVerts = parseUintTok(state, path, 0, TESS_MAX_VERTICES);
    mesh.vertices = Array.from({ length: mesh.numVerts }, () => new Md5VertexT());
    mesh.tcoords = Array.from({ length: mesh.numVerts }, () => new Md5TCoordT());

    for (let j = 0; j < mesh.numVerts; j++) {
      expectToken(state, "vert", path);
      const vertIndex = parseUintTok(state, path, 0, mesh.numVerts - 1);

      const tc = mesh.tcoords[vertIndex];
      expectToken(state, "(", path);
      tc.s = parseFloatTok(state, path);
      tc.t = parseFloatTok(state, path);
      expectToken(state, ")", path);

      const vert = mesh.vertices[vertIndex];
      vert.start = parseUintTok(state, path, 0, 0xffff);
      vert.count = parseUintTok(state, path, 0, 0xffff);
    }

    expectToken(state, "numtris", path);
    const numTris = parseUintTok(state, path, 0, Math.trunc(TESS_MAX_INDICES / 3));
    mesh.numIndices = numTris * 3;
    mesh.indices = new Array<number>(mesh.numIndices).fill(0);

    for (let j = 0; j < numTris; j++) {
      expectToken(state, "tri", path);
      const triIndex = parseUintTok(state, path, 0, numTris - 1);
      for (let k = 0; k < 3; k++) mesh.indices[triIndex * 3 + k] = parseUintTok(state, path, 0, mesh.numVerts - 1);
    }

    expectToken(state, "numweights", path);
    mesh.numWeights = parseUintTok(state, path, 0, MD5_MAX_WEIGHTS);
    mesh.weights = Array.from({ length: mesh.numWeights }, () => new Md5WeightT());
    mesh.jointnums = new Array<number>(mesh.numWeights).fill(0);

    for (let j = 0; j < mesh.numWeights; j++) {
      expectToken(state, "weight", path);
      const weightIndex = parseUintTok(state, path, 0, mesh.numWeights - 1);
      mesh.jointnums[weightIndex] = parseUintTok(state, path, 0, model.numJoints - 1);

      const weight = mesh.weights[weightIndex];
      weight.bias = parseFloatTok(state, path);
      parseVectorTok(state, path, weight.pos);
    }

    expectToken(state, "}", path);

    // integrity check done last, mirroring models.c:1054-1060's own comment
    // ("has to be done last because of circular data dependencies")
    for (let j = 0; j < mesh.numVerts; j++) {
      const vert = mesh.vertices[j];
      if (vert.start + vert.count > mesh.numWeights) throw new Md5FormatError(`${path}: bad vert start/count`);
    }

    computeNormals(mesh, baseSkeleton);
    model.meshes.push(mesh);
  }

  return model;
}

//============================================================================
// MD5_BuildFrameSkeleton (models.c:1076-1129) -- no `scalePos`/joint scale
// (see header comment: Q1 never ships a .md5scale sidecar).

function buildFrameSkeleton(
  jointInfos: readonly Md5JointInfoT[],
  baseFrame: readonly Md5BaseJointT[],
  animFrameData: Float32Array,
  skeletonFrames: Md5SkeletonJointT[],
  frameBase: number,
  numJoints: number,
): void {
  for (let i = 0; i < numJoints; i++) {
    const baseJoint = baseFrame[i];
    const info = jointInfos[i];

    // components[0..2] = position, components[3..5] = quat x/y/z (w recomputed below)
    const components = [baseJoint.pos[0], baseJoint.pos[1], baseJoint.pos[2], baseJoint.orient[0], baseJoint.orient[1], baseJoint.orient[2]];

    let j = 0;
    for (let c = 0; c < MD5_NUM_ANIMATED_COMPONENT_BITS; c++) {
      if (info.flags & (1 << c)) components[c] = animFrameData[info.startIndex + j++];
    }

    const animatedPosition = vec3(components[0], components[1], components[2]);
    const animatedQuat = quat(components[3], components[4], components[5], 0);
    Quat_ComputeW(animatedQuat);

    const thisJoint = skeletonFrames[frameBase + i];

    if (info.parent < 0) {
      VectorCopy(animatedPosition, thisJoint.pos);
      thisJoint.orient[0] = animatedQuat[0];
      thisJoint.orient[1] = animatedQuat[1];
      thisJoint.orient[2] = animatedQuat[2];
      thisJoint.orient[3] = animatedQuat[3];
      Quat_ToAxis(thisJoint.orient, thisJoint.axis);
      continue;
    }

    // parent is guaranteed already built: parseMd5Anim's hierarchy parse
    // already rejected `parent >= i` (models.c's Q_assert(parent < i))
    const parentJoint = skeletonFrames[frameBase + info.parent];

    const rotatedPos = vec3();
    Quat_RotatePoint(parentJoint.orient, animatedPosition, rotatedPos);
    VectorAdd(rotatedPos, parentJoint.pos, thisJoint.pos);

    Quat_MultiplyQuat(parentJoint.orient, animatedQuat, thisJoint.orient);
    Quat_Normalize(thisJoint.orient);

    Quat_ToAxis(thisJoint.orient, thisJoint.axis);
  }
}

//============================================================================
// MD5_ParseAnim (models.c:1219-1349) -- no scale sidecar, no warn callback
// (see header comment).

export function parseMd5Anim(text: string, path: string, model: Md5ModelT): void {
  const state: ComParseState = { data: text, index: 0 };

  expectToken(state, "MD5Version", path);
  expectToken(state, String(MD5_VERSION), path);

  expectToken(state, "commandline", path);
  skipToken(state);

  expectToken(state, "numFrames", path);
  model.numFrames = parseUintTok(state, path, 1, MD5_MAX_FRAMES);

  expectToken(state, "numJoints", path);
  const numJoints = parseUintTok(state, path, 1, MD5_MAX_JOINTS);
  if (numJoints !== model.numJoints) throw new Md5FormatError(`${path}: bad numJoints`);

  expectToken(state, "frameRate", path);
  skipToken(state);

  expectToken(state, "numAnimatedComponents", path);
  const numAnimatedComponents = parseUintTok(state, path, 0, MD5_MAX_JOINTS * MD5_NUM_ANIMATED_COMPONENT_BITS);

  expectToken(state, "hierarchy", path);
  expectToken(state, "{", path);

  const jointInfos: Md5JointInfoT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const info = new Md5JointInfoT();
    info.name = COM_Parse(state);
    info.parent = parseIntTok(state, path, -1, model.numJoints - 1);
    info.flags = parseUintTok(state, path, 0, 0xffffffff);
    info.startIndex = parseUintTok(state, path, 0, numAnimatedComponents);

    let numComponents = 0;
    for (let j = 0; j < MD5_NUM_ANIMATED_COMPONENT_BITS; j++) if (info.flags & (1 << j)) numComponents++;
    if (info.startIndex + numComponents > numAnimatedComponents) throw new Md5FormatError(`${path}: bad joint info`);
    if (info.parent >= i) throw new Md5FormatError(`${path}: bad parent joint`);

    jointInfos.push(info);
  }
  expectToken(state, "}", path);

  // bounds are parsed for shape validation but not retained -- q2repro's own
  // comment (models.c:1294-1296): "apparently usually wrong anyways so
  // we'll just rely on [the MD2's bounds] instead." Nothing in this port
  // yet computes bounds from an MD5 model either; a renderer wanting them
  // recomputes from the skinned verts, same as it would for an .mdl.
  expectToken(state, "bounds", path);
  expectToken(state, "{", path);
  for (let i = 0; i < model.numFrames * 2 * 5; i++) skipToken(state); // 2 vectors * 5 tokens ('(' x y z ')') per frame
  expectToken(state, "}", path);

  expectToken(state, "baseframe", path);
  expectToken(state, "{", path);
  const baseFrame: Md5BaseJointT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const joint = new Md5BaseJointT();
    parseVectorTok(state, path, joint.pos);
    parseVectorTok(state, path, joint.orient);
    Quat_ComputeW(joint.orient);
    baseFrame.push(joint);
  }
  expectToken(state, "}", path);

  model.skeletonFrames = Array.from({ length: model.numFrames * model.numJoints }, () => new Md5SkeletonJointT());

  const animFrameData = new Float32Array(numAnimatedComponents);
  for (let f = 0; f < model.numFrames; f++) {
    expectToken(state, "frame", path);
    const frameIndex = parseUintTok(state, path, 0, model.numFrames - 1);

    expectToken(state, "{", path);
    for (let j = 0; j < numAnimatedComponents; j++) animFrameData[j] = parseFloatTok(state, path);
    expectToken(state, "}", path);

    buildFrameSkeleton(jointInfos, baseFrame, animFrameData, model.skeletonFrames, frameIndex * model.numJoints, model.numJoints);
  }
}

//============================================================================
// runtime skinning (mesh.c:747-773) -- CPU path, allocation-free (every
// scratch vector below is module-scope and reused; nothing here allocates
// per vertex or per frame once a caller's own buffers -- frameJoints, out --
// are in hand).

// Interleaved layout md5Skin below writes into `out`: 3 floats position, 3
// floats normal, per vertex.
export const MD5_VERTEX_STRIDE = 6;

const skinWv: Vec3 = vec3();
const skinNv: Vec3 = vec3();

// calc_skel_vert (mesh.c:747-773). No `joint.scale` multiply (see header
// comment: always 1.0 for Q1, since it never ships a .md5scale sidecar).
export function calcSkelVert(vert: Md5VertexT, mesh: Md5MeshT, skeleton: readonly Md5SkeletonJointT[], outPosition: Vec3, outNormal: Vec3 | null): void {
  VectorClear(outPosition);
  if (outNormal) VectorClear(outNormal);

  for (let i = 0; i < vert.count; i++) {
    const weight = mesh.weights[vert.start + i];
    const joint = skeleton[mesh.jointnums[vert.start + i]];

    VectorRotateByAxis(weight.pos, joint.axis, skinWv);
    VectorAdd(joint.pos, skinWv, skinWv);
    VectorMA(outPosition, weight.bias, skinWv, outPosition);

    if (outNormal) {
      VectorRotateByAxis(vert.normal, joint.axis, skinNv);
      VectorMA(outNormal, weight.bias, skinNv, outNormal);
    }
  }
}

const md5SkinPos: Vec3 = vec3();
const md5SkinNormal: Vec3 = vec3();

/**
 * Skins every vertex of `mesh` against `frameJoints` (length model.numJoints
 * -- see buildFramePose/frameJointsAt below for how a renderer gets one),
 * writing interleaved position+normal (MD5_VERTEX_STRIDE floats per vertex)
 * into `out`. `out` must hold at least `mesh.numVerts * MD5_VERTEX_STRIDE`
 * floats; the caller owns and reuses it across frames -- this function
 * allocates nothing.
 */
export function md5Skin(mesh: Md5MeshT, frameJoints: readonly Md5SkeletonJointT[], out: Float32Array): void {
  for (let v = 0; v < mesh.numVerts; v++) {
    calcSkelVert(mesh.vertices[v], mesh, frameJoints, md5SkinPos, md5SkinNormal);
    const o = v * MD5_VERTEX_STRIDE;
    out[o] = md5SkinPos[0];
    out[o + 1] = md5SkinPos[1];
    out[o + 2] = md5SkinPos[2];
    out[o + 3] = md5SkinNormal[0];
    out[o + 4] = md5SkinNormal[1];
    out[o + 5] = md5SkinNormal[2];
  }
}

/** Allocates a persistent per-frame joint-pose buffer sized for `model`, for
 * a renderer to keep across frames and pass to buildFramePose/md5Skin. Call
 * once at model-load time, not per frame. */
export function createJointPose(model: Md5ModelT): Md5SkeletonJointT[] {
  return Array.from({ length: model.numJoints }, () => new Md5SkeletonJointT());
}

/**
 * The allocation-free per-frame entry point: builds the (optionally
 * lerped) joint pose for `oldFrame`/`newFrame` into the caller-owned `out`
 * (from createJointPose, reused every frame). Frame indices wrap modulo
 * model.numFrames, matching draw_alias_skeleton's own frame selection
 * (mesh.c:876-883): when oldFrame and newFrame land on the same stored
 * frame this just copies it (skipping the lerp/slerp math entirely,
 * cheaper); otherwise LerpVector2 (shared.h:286) on position and
 * Quat_SLerp on orientation, same as lerp_alias_skeleton (mesh.c:810-824).
 */
export function buildFramePose(model: Md5ModelT, oldFrame: number, newFrame: number, backlerp: number, frontlerp: number, out: Md5SkeletonJointT[]): void {
  const numJoints = model.numJoints;
  const frameA = oldFrame % model.numFrames;
  const frameB = newFrame % model.numFrames;
  const baseA = frameA * numJoints;
  const baseB = frameB * numJoints;

  if (frameA === frameB) {
    for (let i = 0; i < numJoints; i++) copySkeletonJoint(model.skeletonFrames[baseB + i], out[i]);
    return;
  }

  for (let i = 0; i < numJoints; i++) {
    const a = model.skeletonFrames[baseA + i];
    const b = model.skeletonFrames[baseB + i];
    const j = out[i];
    j.pos[0] = a.pos[0] * backlerp + b.pos[0] * frontlerp;
    j.pos[1] = a.pos[1] * backlerp + b.pos[1] * frontlerp;
    j.pos[2] = a.pos[2] * backlerp + b.pos[2] * frontlerp;
    Quat_SLerp(a.orient, b.orient, backlerp, frontlerp, j.orient);
    Quat_ToAxis(j.orient, j.axis);
  }
}

/**
 * Non-hot-path convenience: returns the exact stored joints for `frame`
 * (mod model.numFrames) as a fresh array. Useful for tests/tools that want
 * one frame's pose without setting up a persistent buffer; a renderer
 * driving skinning every frame should use buildFramePose into a reused
 * buffer (createJointPose) instead, to stay allocation-free.
 */
export function frameJointsAt(model: Md5ModelT, frame: number): readonly Md5SkeletonJointT[] {
  const f = frame % model.numFrames;
  return model.skeletonFrames.slice(f * model.numJoints, (f + 1) * model.numJoints);
}

//============================================================================
// file discovery (see mapping rule 1 above) + top-level load.

export interface Md5FilePathsT {
  meshPath: string;
  animPath: string;
}

// Quake 1 re-release convention: the MD5 pair sits directly beside the
// .mdl, same directory and basename, just a different extension --
// Ironwail's MD5Anim_Begin does exactly this (COM_StripExtension +
// COM_AddExtension(".md5anim"), gl_model.c:4046-4050). No "md5/"
// subdirectory the way Q2 does it (see header comment).
export function md5PathsFor(modelPath: string): Md5FilePathsT {
  const dot = modelPath.lastIndexOf(".");
  const base = dot >= 0 ? modelPath.slice(0, dot) : modelPath;
  return { meshPath: `${base}.md5mesh`, animPath: `${base}.md5anim` };
}

// MOD_LoadMD5's orchestration (models.c:1415-1445 / Ironwail's
// Mod_LoadMD5MeshModel), minus the hunk watermark/free-on-fail bookkeeping
// this port has no hunk allocator for. Throws Md5FormatError on any parse
// failure; callers catch it and fall back to .mdl rendering, matching the
// original's own "silently fall back if the MD5 pair doesn't parse"
// outcome.
export function loadMd5Model(meshText: string, meshPath: string, animText: string, animPath: string): Md5ModelT {
  const model = parseMd5Mesh(meshText, meshPath);
  parseMd5Anim(animText, animPath, model);
  return model;
}
