/*
No C original: MD5 skeletal replacement models are a 2021 re-release
addition (ARCHITECTURE.md "Engine core commitments" -- "MD5 mesh/anim as
replacement models", and "Renderers" -- "Software: ... MD5 through the
alias triangle pipeline" / "OpenGL: ... same MD5 replacement, pose
interpolation"). Per PORTING.md standing order 5 ("New subsystems get
their own modules named for what they do"), this is its own module rather
than shoehorned into a C-mirroring one.

U29: wires src/lib/md5_model.ts's format-agnostic parser/skinner into the
GL alias pipeline, the same way U26's src/ref_soft/r_md5.ts already wired
it into the software one. See that file's own header for the Quake 1
mapping rules both renderers follow (file discovery beside the .mdl,
shader-to-skin naming, the frame-index equal/unequal cases, the ogre_rocket
joint-count rejection); this module mirrors its PAYLOAD ATTACHMENT, SKIN
LOADING and TIER RULE sections exactly, adapted for GL's own AliashdrT and
GL_LoadTexture instead of software's raw-pixel Md5SkinT.

LOADER DUPLICATION (this unit's brief: "share the loading through a common
helper if you can factor one into src/ref_soft/r_md5.ts's loader without
editing that file -- else duplicate the small loader with a header note").
This unit's SCOPE excludes src/ref_soft/** (r_md5.ts cannot be edited), and
r_md5.ts's own attachMd5ReplacementIfAny/loadMd5Skins/buildPayload are
typed against the SOFTWARE renderer's own AliashdrT (model_types.ts) and
build a software-only payload shape (raw Md5SkinT pixel buffers,
FinalvertT/AuxvertT rasterizer scratch) -- neither this unit's SCOPE nor
r_md5.ts's own can introduce a shared payload type both renderers' structurally
different AliashdrT classes could key a WeakMap on. Only the tiny
renderer-glue orchestration is therefore duplicated below (the tier check
+ try/catch/Con_DPrintf fallback shape, and the PICKUP_FRAME_HZ ST_FRAMETIME
constant/selection, kept numerically identical to r_md5.ts's own so both
renderers cycle a pickup's idle frame the same way) -- every actual
format/skinning computation (loadMd5Model, md5PathsFor, buildFramePose,
md5Skin, createJointPose, MD5_VERTEX_STRIDE) is imported straight from
src/lib/md5_model.ts, the SAME shared module r_md5.ts itself imports from;
no parsing or skinning math is duplicated, only load orchestration glue.
The r_enhancedmodels cvar is imported (read-only) from r_md5.ts and
re-exported below, per this unit's brief ("reuse the cvar object, do not
register twice").

PAYLOAD ATTACHMENT. GL's own AliashdrT (gl_model_types.ts) is a different
class from the software renderer's (model_types.ts) -- structurally
unrelated, built by this renderer's own Mod_LoadAliasModel (gl_model.ts) --
so this module keeps its OWN WeakMap<AliashdrT, Md5GlAliasT>, keyed by the
exact GL AliashdrT instance that renderer's Mod_LoadAliasModel just built,
mirroring r_md5.ts's md5Payloads/getMd5Payload pattern exactly (see that
file's header for why a WeakMap rather than a field on AliashdrT itself,
and why this survives a Cache_Alloc eviction + Mod_Extradata reload
correctly).

SKIN LOADING. Same rule as r_md5.ts (mapping rule 2): exactly mdl.numskins
`progs/<shader>_<NN>_00.lmp` files, decoded through src/common/wad.ts's
SwapPic (the same 8-bit qpic_t layout). Unlike software, each skin is
immediately uploaded through GL_LoadTexture -- the same call classic
skins already go through (gl_model.ts's Mod_LoadAllSkins) -- with the
.lmp's own path as the cache identifier (stable and unique per skin, the
same role `${mod.name}_${i}` plays for classic skins) and the SAME
mipmap/alpha arguments classic skins use (true/false: mipmapped, no alpha
channel). GL_LoadTexture's internal power-of-two/gl_picmip/gl_max_size
upload-size rescaling is irrelevant to texture coordinates here: unlike
the software rasterizer's fixed-point s/skinwidth*65536 math (r_md5.ts's
md5TexCoordFixed), an MD5 mesh's own tcoords (Md5TCoordT.s/.t) are ALREADY
normalized floats in [0,1] (the same UV convention every modern mesh
format uses, confirmed against md5_model.ts's own header/grammar) -- GL's
qglTexCoord2f reads them unmodified, needing no logical-vs-upload-size
conversion at all. Md5GlSkinT.width/height are kept anyway (the .lmp's own
LOGICAL size, standing order 20) for parity with the software renderer's
Md5SkinT shape and for tests, even though this module's own draw path
never multiplies a tcoord by them.

FRAME MAPPING. Unlike software (which has no client-side alias lerp yet,
per r_md5.ts's own header, and always calls buildFramePose same-frame),
this renderer already has U16's two-pose entity lerp (gl_rmain.ts's
R_SetupAliasFrame/GL_DrawAliasFrame). For the mapping rule 3 EQUAL case
(mdl.numframes === the md5anim's own numFrames -- every animated
monster/character pair sampled: dog 86/86, boss 106/106, ogre 147/147...),
every classic frame is ALIAS_SINGLE (one pose per frame, firstpose===frame
index -- confirmed against every id1 MD5-paired .mdl), so R_SetupAliasFrame's
own pose1/pose2/blend already ARE the two MD5 frame indices and the
interpolation fraction to draw between them: this module feeds them
straight into buildFramePose (backlerp = 1-blend, the weight on pose1/
previouspose; frontlerp = blend, the weight on pose2/currentpose -- see
md5_model.ts's own Quat_SLerp/buildFramePose header for that convention),
giving genuine per-frame joint-slerp interpolation as a GL-only
enhancement consistent with U16's already-established alias lerp
elsewhere (FIDELITY RAZOR: KEX's own MD5 pose blending is unspecified
since it is closed, and slerp-interpolating a skeletal format's own joints
is the natural upgrade path U16 already set for the classic vertex-morph
case). For the UNEQUAL case (the 24 single-joint ST_FRAMETIME pickups:
.mdl has exactly 1 frame, forever posenum 0, so R_SetupAliasFrame could
never reach the md5anim's extra frame(s) through pose indices at all),
this module falls back to the exact same cl.time-modulo-interval cycling
r_md5.ts's own md5FrameForEntity uses (PICKUP_FRAME_HZ, duplicated here --
see the header note above), with no lerp (buildFramePose same-frame),
so both renderers show a pickup's idle animation identically.

LIGHTING. gl_rmain.c's classic GL_DrawAliasFrame computes
`dot = shadedots[lightnormalindex]` (a precomputed
DotProduct(unit_normal, shadevector) lookup) and
`color[c] = dot * shadelightColor[c]`, with no manual clamp -- negative
dot values reach qglColor3f/4f unclamped and GL's own fixed-function
color clamp absorbs them. This module computes the same dot product
directly from md5Skin's own (unnormalized, exactly as
calc_skel_vert/r_md5.ts's lightFinalVert leave it -- no per-vertex
renormalize on either renderer) blended vertex normal against
`shadevector`, since MD5 has no precomputed per-normal-index table to
look up -- same formula, computed instead of tabulated.

TRANSFORM. Classic alias vertices (TrivertxT) are bytes 0..255 that
R_DrawAliasModel's own qglTranslatef(scale_origin)/qglScalef(scale) pair
decompresses into model space, after R_RotateForEntity's entity
rotate/translate/scale. md5Skin's output is already real model-space
floats (mirroring src/ref_soft/r_md5.ts's own R_AliasSetUpTransformMd5
ruling for the same reason), so gl_rmain.ts's R_DrawAliasModel skips that
decompression pair entirely on the MD5 path -- see that file's own call
site comment.

SHADOW. U35: `GL_DrawMd5Shadow` below is the "project the skinned verts
like GL_DrawAliasShadow" option this unit's own U29 header left as a
follow-up. It reuses `payload.meshVertScratch` -- the SAME per-mesh
Float32Array `GL_DrawMd5AliasFrame` just filled through `md5Skin` this
frame for this entity's draw -- rather than re-skinning: R_DrawAliasModel
(gl_rmain.ts) always calls `GL_DrawMd5AliasFrame` immediately before the
shadow pass for the same entity, and the module is never reentrant (this
file's own "zero-per-frame-allocation" note below), so the scratch still
holds this frame's blended positions when the shadow pass reads them.
Applies gl_rmain.c's own GL_DrawAliasShadow skew formula byte-for-byte
(`point[0] -= shadevector[0]*(point[2]+lheight)`, `point[2] = height`
where `height = -lheight+1` and `lheight = origin[2]-lightspot[2]`) to
those already-model-space floats instead of a classic TrivertxT's
scale/scale_origin-decompressed point -- no scale_origin/scale step is
needed here for the same reason GL_DrawMd5AliasFrame's own TRANSFORM
section skips it for the main draw. `shadevector` is taken as a parameter
(mirroring `GL_DrawMd5AliasFrame`'s own signature) rather than imported
from gl_rmain.ts directly, to avoid a gl_md5.ts<->gl_rmain.ts import
cycle; `lightspot` is imported straight from gl_rlight.ts, which does not
import this module, so no cycle risk there. gl_rmain.ts's own
R_DrawAliasModel calls this from its MD5 branch under `r_shadows` in
place of `GL_DrawAliasShadow` -- see that file's own comment at the call
site (the one line this unit touches there beyond the accessor allowance:
the shadow dispatch already branches on `md5Payload` for the draw call
immediately above it, so this is the same shape extended to the shadow
call three lines later).

IMMEDIATE MODE. Per this unit's brief ("immediate mode is acceptable"):
every mesh draws as one glBegin(GL_TRIANGLES)/glEnd walking mesh.indices
directly, no strip/fan building (unlike gl_mesh.c's classic BuildTris --
MD5 has no on-disk triangle-strip precomputation to reuse, and building
one at load time for a handful of small monster meshes is not worth the
qgl.ts vertex-array additions the brief allows but does not require). No
new qgl.ts entry points were needed: qglBegin/qglEnd/qglVertex3f/
qglTexCoord2f/qglColor3f/qglColor4f/qglBindTexture already cover this
module's whole draw loop.
*/

import { Md5FormatError } from "../lib/errors";
import { type Md5MeshT, type Md5ModelT, type Md5SkeletonJointT, buildFramePose, createJointPose, loadMd5Model, MD5_VERTEX_STRIDE, md5PathsFor, md5Skin } from "../lib/md5_model";
import { COM_FindFileTier, COM_LoadTempFile } from "../common/common";
import { SwapPic } from "../common/wad";
import { Con_DPrintf } from "../client/console";
import { cl } from "../client/client";
import type { EntityT } from "../client/render";
import type { ModelT } from "../common/model";
import type { MdlT } from "../common/modelgen";
import { type Vec3, vec3 } from "../common/mathlib";
import { Sys_Error } from "../platform/sys";
import { AliashdrT } from "./gl_model_types";
import { GL_Bind, GL_LoadTexture } from "./gl_draw";
import { GL_TRIANGLES, qgl } from "./qgl";
// read-only reuse of the software renderer's cvar object -- see this
// file's header ("do not register twice").
import { r_enhancedmodels } from "../common/render_cvars";
// read-only reuse of the shadow projection's own light-height input -- see
// this file's header (SHADOW). gl_rlight.ts does not import this module,
// so no cycle.
import { lightspot } from "./gl_rlight";

export { r_enhancedmodels };

// this port's own choice for the ST_FRAMETIME pickup case, duplicated from
// r_md5.ts (not exported there) so both renderers cycle identically -- see
// this file's header.
const PICKUP_FRAME_HZ = 2;

//============================================================================
// payload types

export class Md5GlSkinT {
  constructor(
    public readonly texturenum: number,
    // the .lmp's own LOGICAL size (standing order 20) -- kept for parity
    // with the software renderer's Md5SkinT and for tests; this module's
    // own draw loop never needs it (see this file's header, SKIN LOADING).
    public readonly width: number,
    public readonly height: number,
  ) {}
}

export class Md5GlAliasT {
  constructor(
    public readonly model: Md5ModelT,
    public readonly skins: readonly Md5GlSkinT[],
    public readonly jointPose: Md5SkeletonJointT[],
    public readonly meshVertScratch: readonly Float32Array[],
    // the paired .mdl's own frame count, captured at attach time -- see
    // this file's header, FRAME MAPPING, for the equal/unequal-case draw
    // it selects between.
    public readonly mdlNumFrames: number,
  ) {}
}

const md5GlPayloads = new WeakMap<AliashdrT, Md5GlAliasT>();

export function getMd5GlPayload(header: AliashdrT): Md5GlAliasT | null {
  return md5GlPayloads.get(header) ?? null;
}

//============================================================================
// loading

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function loadMd5GlSkins(shader: string, numSkins: number): Md5GlSkinT[] {
  const skins: Md5GlSkinT[] = [];
  for (let g = 0; g < numSkins; g++) {
    const skinPath = `progs/${shader}_${pad2(g)}_00.lmp`;
    const bytes = COM_LoadTempFile(skinPath);
    if (!bytes) throw new Md5FormatError(`${skinPath}: MD5 skin not found`);
    const pic = SwapPic(bytes);
    const texturenum = GL_LoadTexture(skinPath, pic.width, pic.height, pic.data, true, false);
    skins.push(new Md5GlSkinT(texturenum, pic.width, pic.height));
  }
  return skins;
}

function buildPayload(model: Md5ModelT, skins: Md5GlSkinT[], mdlNumFrames: number): Md5GlAliasT {
  const meshVertScratch: Float32Array[] = [];
  for (const mesh of model.meshes) meshVertScratch.push(new Float32Array(mesh.numVerts * MD5_VERTEX_STRIDE));
  return new Md5GlAliasT(model, skins, createJointPose(model), meshVertScratch, mdlNumFrames);
}

/*
Attempts to load and attach `progs/<mdl-basename>.md5mesh`/`.md5anim` (plus
their .lmp skins) for `mod`/`mdl`, mirroring r_md5.ts's
attachMd5ReplacementIfAny exactly (see this file's header for why it is a
separate, GL-typed copy rather than a shared call). Silent on every "no
replacement applies" outcome; a genuinely malformed/rejected pair is
reported through Con_DPrintf (developer-gated, same as r_md5.ts's copy).
*/
export function attachMd5GlReplacementIfAny(mod: ModelT, header: AliashdrT, mdl: MdlT): void {
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
    const skins = loadMd5GlSkins(shader, mdl.numskins);

    md5GlPayloads.set(header, buildPayload(model, skins, mdl.numframes));
  } catch (e) {
    if (!(e instanceof Md5FormatError)) throw e;
    Con_DPrintf("MD5 model %s rejected: %s\n", meshPath, e.message);
  }
}

//============================================================================
// drawing (gl_rmain.ts's R_DrawAliasModel calls this in place of
// GL_DrawAliasFrame once R_SetupAliasFrame's pose1/pose2/blend and the
// lighting/shadevector state are in place -- see this file's header)

// module-scope scratch (this port's zero-per-frame-allocation idiom, e.g.
// gl_rmain.ts's own aliasFrameLerp/entityTransformLerp) -- R_DrawAliasModel
// is never reentrant.
const md5FrameSel = { frameA: 0, frameB: 0, backlerp: 1, frontlerp: 0 };

export function GL_DrawMd5AliasFrame(payload: Md5GlAliasT, ent: EntityT, pose1: number, pose2: number, blend: number, shadevector: Vec3, shadelightColor: Vec3, alpha: number): void {
  if (payload.mdlNumFrames === payload.model.numFrames) {
    // the common (equal) case -- see this file's header, FRAME MAPPING.
    md5FrameSel.frameA = pose1;
    md5FrameSel.frameB = pose2;
    md5FrameSel.backlerp = 1 - blend;
    md5FrameSel.frontlerp = blend;
  } else {
    // ST_FRAMETIME pickups -- see this file's header, FRAME MAPPING.
    const t = cl.time + ent.syncbase;
    const frame = Math.floor(t * PICKUP_FRAME_HZ) % payload.model.numFrames;
    md5FrameSel.frameA = frame;
    md5FrameSel.frameB = frame;
    md5FrameSel.backlerp = 1;
    md5FrameSel.frontlerp = 0;
  }

  buildFramePose(payload.model, md5FrameSel.frameA, md5FrameSel.frameB, md5FrameSel.backlerp, md5FrameSel.frontlerp, payload.jointPose);

  let skinnum = ent.skinnum;
  if (skinnum >= payload.skins.length || skinnum < 0) skinnum = 0;
  const skin = payload.skins[skinnum];
  if (!skin) Sys_Error("GL_DrawMd5AliasFrame: model has no skins");

  GL_Bind(skin.texturenum);

  for (let m = 0; m < payload.model.meshes.length; m++) {
    const mesh: Md5MeshT = payload.model.meshes[m];
    const skinned = payload.meshVertScratch[m];
    md5Skin(mesh, payload.jointPose, skinned);

    qgl().qglBegin(GL_TRIANGLES);
    for (let i = 0; i < mesh.numIndices; i++) {
      const v = mesh.indices[i];
      const o = v * MD5_VERTEX_STRIDE;
      const nx = skinned[o + 3];
      const ny = skinned[o + 4];
      const nz = skinned[o + 5];
      // the classic alias lighting rule (gl_rmain.c's GL_DrawAliasFrame,
      // see this file's header, LIGHTING) -- unclamped, same as the C.
      const dot = nx * shadevector[0] + ny * shadevector[1] + nz * shadevector[2];
      const tc = mesh.tcoords[v];

      qgl().qglTexCoord2f(tc.s, tc.t);
      if (alpha === 1) qgl().qglColor3f(dot * shadelightColor[0], dot * shadelightColor[1], dot * shadelightColor[2]);
      else qgl().qglColor4f(dot * shadelightColor[0], dot * shadelightColor[1], dot * shadelightColor[2], alpha);
      qgl().qglVertex3f(skinned[o], skinned[o + 1], skinned[o + 2]);
    }
    qgl().qglEnd();
  }
}

// module-scope scratch, same idiom as `md5FrameSel`/`shadowPoint`
// (gl_rmain.ts) -- GL_DrawMd5Shadow is never reentrant either.
const md5ShadowPoint: Vec3 = vec3();

/*
U35: gl_rmain.c's own GL_DrawAliasShadow skew, fed md5Skin's already-
blended positions (still sitting in `payload.meshVertScratch` from the
GL_DrawMd5AliasFrame call this frame's draw just made -- reused verbatim,
no re-skin) instead of a classic TrivertxT -- see this file's header,
SHADOW.
*/
export function GL_DrawMd5Shadow(payload: Md5GlAliasT, ent: EntityT, shadevector: Vec3): void {
  const lheight = ent.origin[2] - lightspot[2];
  const height = -lheight + 1.0;

  for (let m = 0; m < payload.model.meshes.length; m++) {
    const mesh: Md5MeshT = payload.model.meshes[m];
    const skinned = payload.meshVertScratch[m];

    qgl().qglBegin(GL_TRIANGLES);
    for (let i = 0; i < mesh.numIndices; i++) {
      const v = mesh.indices[i];
      const o = v * MD5_VERTEX_STRIDE;

      md5ShadowPoint[0] = skinned[o] - shadevector[0] * (skinned[o + 2] + lheight);
      md5ShadowPoint[1] = skinned[o + 1] - shadevector[1] * (skinned[o + 2] + lheight);
      md5ShadowPoint[2] = height;

      qgl().qglVertex3fv(md5ShadowPoint);
    }
    qgl().qglEnd();
  }
}
