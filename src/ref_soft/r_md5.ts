/*
No C original: MD5 skeletal replacement models are a 2021 re-release
addition (ARCHITECTURE.md "Engine core commitments" -- "MD5 mesh/anim as
replacement models", and "Renderers" -- "Software: ... MD5 through the
alias triangle pipeline"), unknown to WinQuake's r_alias.c/model.c. Per
PORTING.md standing order 5 ("New subsystems get their own modules named
for what they do"), this is its own module rather than shoehorned into a
C-mirroring one.

U26: wires src/lib/md5_model.ts's format-agnostic parser/skinner into the
software alias pipeline. See that file's own header for the Quake 1 mapping
rules this loader follows (file discovery beside the .mdl, shader-to-skin
naming, frame-index mapping, flags reuse, the mg3 ogre_rocket joint-count
rejection) -- this module is the renderer-side half those rules explicitly
leave to "a later renderer/model-loading unit" (md5_model.ts's header,
rules 2 and 3).

PAYLOAD ATTACHMENT. The brief calls for attaching an "md5 payload...beside
the classic alias data" on the model's renderer data (AliashdrT, defined in
model_types.ts). This unit's SCOPE does not include model_types.ts, so
Md5SoftAliasT is not a field on AliashdrT itself; instead `md5Payloads`
below is a WeakMap<AliashdrT, Md5SoftAliasT> keyed by the exact AliashdrT
instance Mod_LoadAliasModel builds for that load. This is observationally
identical to a field on the class (one payload per loaded alias header,
attached once at load time, read back by identity in R_AliasDrawModel) and
survives a Cache_Alloc eviction + Mod_Extradata reload correctly. because
attachMd5ReplacementIfAny runs again, on the fresh header, every time
Mod_LoadAliasModel runs.

FRAME MAPPING (md5_model.ts's rule 3). Two cases, distinguished by comparing
the .mdl's own frame count against the .md5anim's:
  - equal (every animated monster/character pair sampled: dog 86/86, boss
    106/106, ogre 147/147, ...): ent.frame maps 1:1 onto the md5anim's own
    frame index. No lerp yet (the client-side lerp unit hasn't landed --
    see this file's own follow-up note), so buildFramePose is called with
    oldFrame === newFrame, taking its same-frame fast path (a plain copy,
    no slerp math).
  - unequal (the 24 single-joint pickups: the .mdl carries one static
    frame, ST_FRAMETIME in Ironwail's terms -- gl_model.c:4484's own
    comment: "keep IQM animations synced to when .frame is changed";
    modelgen.h:57 "sync to when .frame changes", not a fixed real-time
    rate). Ironwail's own MD5Anim_Begin discards the .md5anim's frameRate
    token outright ("irrelevant here", gl_model.c ~4046) exactly as
    src/lib/md5_model.ts's parseMd5Anim does (`skipToken`), so no per-frame
    duration survives the parse on either engine's side, and the real KEX
    engine's own runtime timing is unspecified (it is closed -- FIDELITY
    RAZOR, ARCHITECTURE.md). PICKUP_FRAME_HZ below is this port's own
    documented choice, not implied by any reference: the md5anim's extra
    frame(s) cycle by cl.time + ent.syncbase at a fixed rate, the same
    cl.time-modulo-interval shape r_alias.c's own ALIAS_GROUP frame-cycling
    already uses (R_AliasSetupFrame), so a pickup's idle animation reads as
    a slow, visible pulse rather than a flicker or a freeze. Flagged as a
    follow-up for anyone with real KEX capture to correct.

SKIN LOADING (md5_model.ts's rule 2). The .mdl's own numskins is the source
of truth (the brief's "the .mdl's flags, mins/maxs, frame count and skin
count stay authoritative"): this loads exactly pmdl.numskins .lmp files,
named "progs/<shader>_<NN>_00.lmp" (shader = the mesh's own parsed "shader"
string, which mapping rule 2 establishes always equals the model's own
basename), skipping the .mdl's own ALIAS_SKIN_GROUP per-skin animation
entirely (no "_NN_01", "_NN_02", ... frame ever exists in the retail data --
only the skin-GROUP digit varies). A standalone .lmp is the same qpic_t
layout (int width, int height, then width*height 8-bit palette indices)
software already reads for HUD pics (src/ref_soft/draw.ts's Draw_CachePic);
src/common/wad.ts's SwapPic is reused rather than re-implementing that
8-byte-header parse a third time.

TIER RULE (ARCHITECTURE.md "Engine core commitments" / md5_model.ts's own
header): COM_FindFileTier on both the .mdl's own path and the .md5mesh's
path; the replacement is used only when the mesh resolves at the same
search-path tier (an equal index) or a HIGHER-priority one (a lower index --
tier 0 is com_searchpaths' head, the highest-priority node).
*/

import { Md5FormatError } from "../lib/errors";
import {
  type Md5MeshT,
  type Md5ModelT,
  type Md5SkeletonJointT,
  buildFramePose,
  createJointPose,
  loadMd5Model,
  md5PathsFor,
  md5Skin,
  MD5_VERTEX_STRIDE,
} from "../lib/md5_model";
import { COM_FindFileTier, COM_LoadTempFile } from "../common/common";
import { SwapPic } from "../common/wad";
import { r_enhancedmodels } from "../common/render_cvars";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import { Con_DPrintf } from "../client/console";
import { cl } from "../client/client";
import type { EntityT } from "../client/render";
import type { ModelT } from "../common/model";
import type { MdlT } from "../common/modelgen";
import { AngleVectors, R_ConcatTransforms, VectorCopy, VectorInverse, type Mat3x4, type Vec3, vec3 } from "../common/mathlib";
import { PITCH, ROLL, YAW } from "../common/quakedef";
import { Sys_Error } from "../platform/sys";
import { AliashdrT, MtriangleT } from "./model_types";
import {
  ALIAS_BOTTOM_CLIP,
  ALIAS_LEFT_CLIP,
  ALIAS_RIGHT_CLIP,
  ALIAS_TOP_CLIP,
  ALIAS_XY_CLIP_MASK,
  ALIAS_Z_CLIP,
  ALIAS_Z_CLIP_PLANE,
  type AlightT,
  AuxvertT,
  FinalvertT,
  allocAuxverts,
  allocFinalverts,
  modelorg,
  // U39: read-only, matches r_alias.ts's own use of it -- see that file's
  // header note on why it lives in src/client/render.ts.
  r_lerpmodels,
  r_plightvec,
  r_refdef,
  rState,
  vpn,
  vright,
  vup,
} from "./r_local";
import { r_affinetridesc } from "./d_iface";
import { D_PolysetDraw, D_PolysetDrawFinalVerts, D_PolysetUpdateTables } from "./d_polyse";
import { R_AliasClipTriangle } from "./r_aclip";
import { R_AliasProjectFinalVert, aliasPoseFrame, aliastransform, r_aliasblend } from "./r_alias";

// Ironwail's own name and default ("1" -- enabled), per this unit's brief.
export { r_enhancedmodels }; // lives in src/common/render_cvars.ts, shared with the GL renderer
// Registered here rather than from an Init() function: this unit's SCOPE
// does not include r_main.ts (R_Init lives there), and Cvar_RegisterVariable
// is a plain linked-list prepend safe to call at module-evaluation time (it
// only needs Q_atof and the cvar_vars list, both already initialized by the
// time any module import runs) -- see cvar.ts's own header. Follow-up: move
// this call into r_main.ts's R_Init, alongside the other renderer cvars,
// once that file's owner can take it.

// this port's own choice for the ST_FRAMETIME pickup case -- see this
// file's header.
const PICKUP_FRAME_HZ = 2;

//============================================================================
// payload types

export class Md5SkinT {
  constructor(
    public readonly pixels: Uint8Array,
    public readonly width: number,
    public readonly height: number,
  ) {}
}

export class Md5SoftAliasT {
  constructor(
    public readonly model: Md5ModelT,
    public readonly skins: readonly Md5SkinT[],
    public readonly jointPose: Md5SkeletonJointT[],
    public readonly meshTriangles: readonly MtriangleT[][],
    public readonly meshVertScratch: readonly Float32Array[],
    public readonly finalverts: readonly FinalvertT[][],
    public readonly auxverts: readonly AuxvertT[][],
  ) {}
}

const md5Payloads = new WeakMap<AliashdrT, Md5SoftAliasT>();

export function getMd5Payload(header: AliashdrT): Md5SoftAliasT | null {
  return md5Payloads.get(header) ?? null;
}

//============================================================================
// loading

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function meshTrianglesOf(mesh: Md5MeshT): MtriangleT[] {
  const tris: MtriangleT[] = [];
  for (let i = 0; i < mesh.numIndices; i += 3) {
    const t = new MtriangleT();
    // MD5 has no seam/backface split (that is an artifact of the .mdl's
    // single-projection skin, mapping rule 2's header note): every
    // triangle is "facesfront" so d_polyse.ts's seamfixupX16 adjustment
    // (gated on !facesfront) never applies.
    t.facesfront = 1;
    t.vertindex[0] = mesh.indices[i];
    t.vertindex[1] = mesh.indices[i + 1];
    t.vertindex[2] = mesh.indices[i + 2];
    tris.push(t);
  }
  return tris;
}

function buildPayload(model: Md5ModelT, skins: Md5SkinT[]): Md5SoftAliasT {
  const meshTriangles: MtriangleT[][] = [];
  const meshVertScratch: Float32Array[] = [];
  const finalverts: FinalvertT[][] = [];
  const auxverts: AuxvertT[][] = [];

  for (const mesh of model.meshes) {
    meshTriangles.push(meshTrianglesOf(mesh));
    meshVertScratch.push(new Float32Array(mesh.numVerts * MD5_VERTEX_STRIDE));
    // brief: "the vertex count can exceed MAXALIASVERTS, so size the
    // finalvert scratch from the mesh" -- sized once here, at load time,
    // reused every frame (allocFinalverts/allocAuxverts, same pool-builder
    // r_alias.ts's own MAXALIASVERTS-sized pools use).
    finalverts.push(allocFinalverts(mesh.numVerts));
    auxverts.push(allocAuxverts(mesh.numVerts));
  }

  return new Md5SoftAliasT(model, skins, createJointPose(model), meshTriangles, meshVertScratch, finalverts, auxverts);
}

function loadMd5Skins(shader: string, numSkins: number): Md5SkinT[] {
  const skins: Md5SkinT[] = [];
  for (let g = 0; g < numSkins; g++) {
    const skinPath = `progs/${shader}_${pad2(g)}_00.lmp`;
    const bytes = COM_LoadTempFile(skinPath);
    if (!bytes) throw new Md5FormatError(`${skinPath}: MD5 skin not found`);
    const pic = SwapPic(bytes);
    skins.push(new Md5SkinT(pic.data, pic.width, pic.height));
  }
  return skins;
}

/*
Attempts to load and attach `progs/<mdl-basename>.md5mesh`/`.md5anim` (plus
their .lmp skins) for `mod`/`mdl`, per this unit's brief. Silent on every
"no replacement applies" outcome (r_enhancedmodels off, no MD5 pair shipped
for this model, or one shipped at a lower search-path tier than the .mdl --
the overwhelmingly common case for the vast majority of models, which ship
no MD5 pair at all); a genuinely malformed/rejected pair (Md5FormatError --
including mg3's ogre_rocket joint-count mismatch) is reported through
Con_DPrintf, which is itself gated on developer 1 (console.ts's own
implementation), satisfying the brief's "silently under developer 0, a
dprint under developer 1" in one call.
*/
export function attachMd5ReplacementIfAny(mod: ModelT, header: AliashdrT, mdl: MdlT): void {
  if (!r_enhancedmodels.value) return;

  const { meshPath, animPath } = md5PathsFor(mod.name);

  const meshTier = COM_FindFileTier(meshPath);
  if (meshTier === -1) return; // no MD5 pair shipped for this model

  const mdlTier = COM_FindFileTier(mod.name);
  if (mdlTier !== -1 && meshTier > mdlTier) return; // lower-priority tier than the .mdl: ignored

  try {
    const meshBytes = COM_LoadTempFile(meshPath);
    if (!meshBytes) return;
    const animBytes = COM_LoadTempFile(animPath);
    if (!animBytes) throw new Md5FormatError(`${meshPath}: no matching .md5anim`);

    const decoder = new TextDecoder();
    const model = loadMd5Model(decoder.decode(meshBytes), meshPath, decoder.decode(animBytes), animPath);

    const shader = model.meshes[0]?.shader ?? "";
    const skins = loadMd5Skins(shader, mdl.numskins);

    md5Payloads.set(header, buildPayload(model, skins));
  } catch (e) {
    if (!(e instanceof Md5FormatError)) throw e;
    Con_DPrintf("MD5 model %s rejected: %s\n", meshPath, e.message);
  }
}

//============================================================================
// frame selection

// U39 addition, no WinQuake counterpart (MD5 itself has none -- see this
// file's own header): the two frames + blend fraction R_MD5DrawModel hands
// buildFramePose, mirroring r_alias.c's own pose lerp (r_alias.ts's
// R_AliasSetupFrame) for the "equal frame count" case, and a small
// real-time-driven lerp of its own for the ST_FRAMETIME pickup case (which
// has no .mdl-side pose-change event to hang a lerp off of at all).
interface Md5FrameBlendT {
  prevFrame: number;
  frame: number;
  blend: number;
}

function md5FrameBlendForEntity(mdlNumFrames: number, md5NumFrames: number, ent: EntityT): Md5FrameBlendT {
  if (mdlNumFrames === md5NumFrames) {
    let frame = ent.frame;
    if (frame < 0 || frame >= md5NumFrames) frame = 0;

    // Reuses r_alias.ts's own pose-change/blend bookkeeping (already run
    // this draw by R_AliasSetupFrame, unconditionally, before this file's
    // caller ever checks for an MD5 payload) instead of a second timer:
    // ent.frame maps 1:1 onto both the .mdl frame number AND the md5anim
    // frame index in this branch (this file's own header, mapping rule 3's
    // "equal" case), so the .mdl's own previouspose/currentpose/blend ARE
    // the md5 frame lerp, once previouspose is decoded back to a plain
    // frame number.
    if (!r_lerpmodels.value) return { prevFrame: frame, frame, blend: 1 };
    const prevFrame = aliasPoseFrame(ent.previouspose);
    return { prevFrame: prevFrame < 0 || prevFrame >= md5NumFrames ? frame : prevFrame, frame, blend: r_aliasblend };
  }

  // ST_FRAMETIME pickups -- see this file's header. cl.time-driven cycling,
  // blended between the two integer frames straddling the current time
  // (this port's own choice, same shape as r_alias.c's own ALIAS_GROUP
  // interpolation) rather than snapping, unless r_lerpmodels is off.
  const t = cl.time + ent.syncbase;
  const raw = t * PICKUP_FRAME_HZ;
  const flo = Math.floor(raw);
  const frame = ((flo % md5NumFrames) + md5NumFrames) % md5NumFrames;
  if (!r_lerpmodels.value) return { prevFrame: frame, frame, blend: 1 };
  const prevFrame = (((flo - 1) % md5NumFrames) + md5NumFrames) % md5NumFrames;
  return { prevFrame, frame, blend: raw - flo };
}

//============================================================================
// transform (r_alias.c's R_AliasSetUpTransform, minus the .mdl-specific
// byte-quantization scale)

function mat3x4(): Mat3x4 {
  return [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
}

const md5_forward: Vec3 = vec3();
const md5_right: Vec3 = vec3();
const md5_up: Vec3 = vec3();

/*
r_alias.c's R_AliasSetUpTransform builds `tmatrix` from the .mdl's own
scale/scale_origin, because trivertx_t vertices are bytes 0..255 that need
decompressing into model space. md5Skin's output (calcSkelVert) is already
real model-space floats -- applying the .mdl's tmatrix on top would rescale
a real vertex through a decompression ratio it never used. This is the
same aliastransform computation with that half omitted (tmatrix === the
identity a real .mdl's own scale/scale_origin would NOT generally collapse
to, so it cannot be shared verbatim): entity angles/modelorg/view axes are
otherwise identical to R_AliasSetUpTransform's own, and the result is
written into the same shared `aliastransform` r_alias.ts exports, so
R_AliasProjectFinalVert and R_AliasClipTriangle (both reading it indirectly
through the finalverts they are handed) need no MD5-specific twin.
*/
function R_AliasSetUpTransformMd5(trivialAccept: number): void {
  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_AliasSetUpTransformMd5: no current entity");

  const angles: Vec3 = vec3();
  angles[ROLL] = ent.angles[ROLL];
  angles[PITCH] = -ent.angles[PITCH];
  angles[YAW] = ent.angles[YAW];
  AngleVectors(angles, md5_forward, md5_right, md5_up);

  const t2matrix = mat3x4();
  for (let i = 0; i < 3; i++) {
    t2matrix[i][0] = md5_forward[i];
    t2matrix[i][1] = -md5_right[i];
    t2matrix[i][2] = md5_up[i];
  }
  t2matrix[0][3] = -modelorg[0];
  t2matrix[1][3] = -modelorg[1];
  t2matrix[2][3] = -modelorg[2];

  const viewmatrix = mat3x4();
  VectorCopy(vright, viewmatrix[0]);
  VectorCopy(vup, viewmatrix[1]);
  VectorInverse(viewmatrix[1]);
  VectorCopy(vpn, viewmatrix[2]);

  R_ConcatTransforms(viewmatrix, t2matrix, aliastransform);

  if (trivialAccept) {
    for (let i = 0; i < 4; i++) {
      aliastransform[0][i] *= rState.aliasxscale * (1.0 / (0x8000 * 0x10000));
      aliastransform[1][i] *= rState.aliasyscale * (1.0 / (0x8000 * 0x10000));
      aliastransform[2][i] *= 1.0 / (0x8000 * 0x10000);
    }
  }
}

//============================================================================
// per-vertex transform+light (r_alias.c's R_AliasTransformFinalVert /
// R_AliasTransformAndProjectFinalVerts, reading an md5Skin-produced
// position+normal instead of a TrivertxT + lightnormalindex table lookup)

function md5TexCoordFixed(coord: number, size: number): number {
  return Math.trunc(coord * size * 65536);
}

function lightFinalVert(fv: FinalvertT, nx: number, ny: number, nz: number): void {
  const lightcos = nx * r_plightvec[0] + ny * r_plightvec[1] + nz * r_plightvec[2];
  let temp = rState.r_ambientlight;
  if (lightcos < 0) {
    temp += (rState.r_shadelight * lightcos) | 0;
    if (temp < 0) temp = 0;
  }
  fv.v[4] = temp;
}

// unclipped case: R_AliasTransformAndProjectFinalVerts's twin.
function transformAndProjectMd5Vertex(fv: FinalvertT, px: number, py: number, pz: number, nx: number, ny: number, nz: number, s: number, t: number): void {
  const zi = 1.0 / (px * aliastransform[2][0] + py * aliastransform[2][1] + pz * aliastransform[2][2] + aliastransform[2][3]);
  fv.v[5] = zi;
  fv.v[0] = (px * aliastransform[0][0] + py * aliastransform[0][1] + pz * aliastransform[0][2] + aliastransform[0][3]) * zi + rState.aliasxcenter;
  fv.v[1] = (px * aliastransform[1][0] + py * aliastransform[1][1] + pz * aliastransform[1][2] + aliastransform[1][3]) * zi + rState.aliasycenter;
  fv.v[2] = s;
  fv.v[3] = t;
  fv.flags = 0;
  lightFinalVert(fv, nx, ny, nz);
}

// clipped case: R_AliasTransformFinalVert's twin.
function transformMd5Vertex(fv: FinalvertT, av: AuxvertT, px: number, py: number, pz: number, nx: number, ny: number, nz: number, s: number, t: number): void {
  av.fv[0] = px * aliastransform[0][0] + py * aliastransform[0][1] + pz * aliastransform[0][2] + aliastransform[0][3];
  av.fv[1] = px * aliastransform[1][0] + py * aliastransform[1][1] + pz * aliastransform[1][2] + aliastransform[1][3];
  av.fv[2] = px * aliastransform[2][0] + py * aliastransform[2][1] + pz * aliastransform[2][2] + aliastransform[2][3];

  fv.v[2] = s;
  fv.v[3] = t;
  fv.flags = 0;
  lightFinalVert(fv, nx, ny, nz);
}

//============================================================================
// per-mesh draw (r_alias.c's R_AliasPrepareUnclippedPoints / R_AliasPreparePoints)

function drawMd5Mesh(mesh: Md5MeshT, meshIndex: number, payload: Md5SoftAliasT, ent: EntityT, skin: Md5SkinT): void {
  const skinned = payload.meshVertScratch[meshIndex];
  md5Skin(mesh, payload.jointPose, skinned);

  const fv = payload.finalverts[meshIndex];
  const av = payload.auxverts[meshIndex];
  const tris = payload.meshTriangles[meshIndex];
  const numVerts = mesh.numVerts;

  rState.pfinalverts = fv;
  rState.pauxverts = av;

  if (ent.trivial_accept) {
    for (let i = 0; i < numVerts; i++) {
      const o = i * MD5_VERTEX_STRIDE;
      const tc = mesh.tcoords[i];
      transformAndProjectMd5Vertex(
        fv[i],
        skinned[o],
        skinned[o + 1],
        skinned[o + 2],
        skinned[o + 3],
        skinned[o + 4],
        skinned[o + 5],
        md5TexCoordFixed(tc.s, skin.width),
        md5TexCoordFixed(tc.t, skin.height),
      );
    }

    if (r_affinetridesc.drawtype) D_PolysetDrawFinalVerts(fv, numVerts);

    r_affinetridesc.pfinalverts = fv;
    r_affinetridesc.ptriangles = tris;
    r_affinetridesc.numtriangles = tris.length;
    D_PolysetDraw();
    return;
  }

  for (let i = 0; i < numVerts; i++) {
    const o = i * MD5_VERTEX_STRIDE;
    const tc = mesh.tcoords[i];
    transformMd5Vertex(
      fv[i],
      av[i],
      skinned[o],
      skinned[o + 1],
      skinned[o + 2],
      skinned[o + 3],
      skinned[o + 4],
      skinned[o + 5],
      md5TexCoordFixed(tc.s, skin.width),
      md5TexCoordFixed(tc.t, skin.height),
    );

    if (av[i].fv[2] < ALIAS_Z_CLIP_PLANE) {
      fv[i].flags |= ALIAS_Z_CLIP;
    } else {
      R_AliasProjectFinalVert(fv[i], av[i]);

      if (fv[i].v[0] < r_refdef.aliasvrect.x) fv[i].flags |= ALIAS_LEFT_CLIP;
      if (fv[i].v[1] < r_refdef.aliasvrect.y) fv[i].flags |= ALIAS_TOP_CLIP;
      if (fv[i].v[0] > r_refdef.aliasvrectright) fv[i].flags |= ALIAS_RIGHT_CLIP;
      if (fv[i].v[1] > r_refdef.aliasvrectbottom) fv[i].flags |= ALIAS_BOTTOM_CLIP;
    }
  }

  r_affinetridesc.numtriangles = 1;
  for (const tri of tris) {
    const pfv0 = fv[tri.vertindex[0]];
    const pfv1 = fv[tri.vertindex[1]];
    const pfv2 = fv[tri.vertindex[2]];

    if (pfv0.flags & pfv1.flags & pfv2.flags & (ALIAS_XY_CLIP_MASK | ALIAS_Z_CLIP)) continue; // completely clipped

    if (!((pfv0.flags | pfv1.flags | pfv2.flags) & (ALIAS_XY_CLIP_MASK | ALIAS_Z_CLIP))) {
      r_affinetridesc.pfinalverts = fv;
      r_affinetridesc.ptriangles = [tri];
      D_PolysetDraw();
    } else {
      R_AliasClipTriangle(tri);
    }
  }
}

//============================================================================
// entry point, called from r_alias.ts's R_AliasDrawModel when a payload is
// attached to the current entity's alias header.

export function R_MD5DrawModel(payload: Md5SoftAliasT, plighting: AlightT): void {
  // R_AliasSetupLighting (r_alias.c, unchanged, called before this by
  // R_AliasDrawModel) already rotated r_plightvec using the entity's
  // angles alone -- identical math for MD5, so plighting is read only for
  // parameter-shape parity with the classic call site; nothing here reads
  // it directly (r_plightvec/rState.r_ambientlight/r_shadelight already
  // hold what it produced).
  void plighting;

  const ent = rState.currententity;
  if (ent === null) Sys_Error("R_MD5DrawModel: no current entity");
  const mdl = rState.pmdl;
  if (mdl === null) Sys_Error("R_MD5DrawModel: no mdl");

  let skinnum = ent.skinnum;
  if (skinnum >= payload.skins.length || skinnum < 0) skinnum = 0;
  const skin = payload.skins[skinnum];
  if (!skin) Sys_Error("R_MD5DrawModel: model has no skins");

  r_affinetridesc.pskin = skin.pixels;
  r_affinetridesc.pskindesc = null;
  r_affinetridesc.skinwidth = skin.width;
  r_affinetridesc.skinheight = skin.height;
  r_affinetridesc.seamfixupX16 = 0; // MD5 has no onseam concept, see meshTrianglesOf
  D_PolysetUpdateTables();

  R_AliasSetUpTransformMd5(ent.trivial_accept);

  // U39: the two poses + blend, mirroring r_alias.c's own pose lerp -- see
  // md5FrameBlendForEntity's own header note. backlerp weights prevFrame,
  // frontlerp weights frame, matching buildFramePose's own naming
  // (src/lib/md5_model.ts); blend === 1 (no lerp) collapses prevFrame ===
  // frame, taking buildFramePose's same-frame fast path unchanged.
  const { prevFrame, frame, blend } = md5FrameBlendForEntity(mdl.numframes, payload.model.numFrames, ent);
  buildFramePose(payload.model, prevFrame, frame, 1 - blend, blend, payload.jointPose);

  for (let m = 0; m < payload.model.meshes.length; m++) {
    drawMd5Mesh(payload.model.meshes[m], m, payload, ent, skin);
  }
}
