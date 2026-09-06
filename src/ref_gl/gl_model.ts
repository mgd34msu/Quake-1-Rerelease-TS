/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_model.c and WinQuake/gl_model.h (GNU GPL v2 or
later), plus WinQuake/gl_rmisc.c's R_InitTextures (the GL notexture
checkerboard).

gl_model.c is linked into the GL build; src/common/model.ts's header diffs it
against model.c and keeps the identical functions shared, leaving
Mod_LoadFaces, Mod_LoadAliasModel, Mod_LoadSpriteModel as `ModelLoaderHooks`
entries, plus an `afterBrushLoad` hook for the
SURF_UNDERWATER marking pass gl_model.c's Mod_LoadLeafs does inline (that
function itself stays shared -- see src/common/model.ts's header). This
module is that hook set for the GL renderer, `glModelHooks`, plus
R_InitTextures (gl_rmisc.c's, a DIFFERENT body from r_main.c's software one --
it owns the checkerboard `notexture` texture the hooks object must carry, per
this unit's ruling, so it lives here; U072's gl_rmain.ts/gl_rmisc.ts calls it
again from R_Init for call-order fidelity and otherwise never touches its
return value).

Mod_LoadLighting is NOT a second copy here: src/common/model.ts's header
lists it as IDENTICAL between model.c and gl_model.c, so this hook is a
one-line delegating shim to that shared function (see softModelHooks's own
copy of this pattern in src/ref_soft/model.ts).

Mod_LoadTextures is likewise shared now, not duplicated here (fixing the
dedicated server's "Bad surface extents" crash: the table build and
animation sequencing must run on every path, not only when a renderer is
installed -- see src/common/model.ts's header). Only the per-texture step
that gl_model.c's copy does differently from model.c's -- R_InitSky for
"sky*" textures, GL_LoadTexture for everything else -- is still this
renderer's own code, as `ModelLoaderHooks.textureLoaded` below.

gl_model.c's own file-scope statics that model.c does not have (`pheader`,
`stverts[MAXALIASVERTS]`, `triangles[MAXALIASTRIS]`,
`poseverts[MAXALIASFRAMES]`, `posenum`) are this unit's per glquake.ts's
OWNERSHIP block; `loadmodel` is the same global as model.c's, already
src/common/model.ts's `loadState.loadmodel`, so it is not duplicated here.
`pheader`/`stverts`/`triangles`/`poseverts` cannot be added to glquake.ts's
`glState` (out of this unit's SCOPE), so they are plain `export let` module
bindings here instead (the same pattern src/common/common.ts and
src/common/net_main.ts already use for reassigned globals) -- gl_mesh.ts
(U073, concurrent) reads them back through gl_model.h's own `extern`
declarations while GL_MakeAliasModelDisplayLists runs synchronously at the
end of Mod_LoadAliasModel below, before `pheader` is reassigned by the next
load. `posenum` is never read outside this file (gl_mesh.c reads
`pheader->numposes`, not `posenum` directly), so it stays module-private.

gl_model.c also declares and registers a `gl_subdivide_size` cvar (used by
gl_warp.c's SubdividePolygon, not by this file) inside its own `Mod_Init`.
Per glquake.ts's OWNERSHIP block this cvar is this unit's, so it is declared
and exported here -- but `Mod_Init` itself is src/common/model.ts's SHARED
function (out of this unit's SCOPE) and registers nothing beyond
`mod_novis`'s memset, so `Cvar_RegisterVariable(gl_subdivide_size)` has
nowhere to run from this unit's files. ref_gl.ts's `registerRenderer("gl", ...)`
factory registers it instead, next to `gl_ztrick`.

Cache-block -> object-graph mapping, per model_types.ts's header and
PORTING.md's "C pointers into an array become (array, index) pairs or
subarray views" (see gl_model_types.ts's own header for the full list):
  aliashdr_t.gl_texturenum[MAX_SKINS][4] -> AliashdrT.gl_texturenum:
                           Int32Array(MAX_SKINS*4), indexed [skin*4+anim]
  aliashdr_t.texels[MAX_SKINS] -> AliashdrT.texels: Array<Uint8Array|null>
  aliashdr_t.posedata/commands -> left untouched here (Uint8Array/Int32Array
                           defaults); GL_MakeAliasModelDisplayLists (gl_mesh.c)
                           is what fills them, reading this file's `pheader`/
                           `stverts`/`triangles`/`poseverts` module state --
                           gl_model.c's own Mod_LoadAliasModel never writes
                           pheader->posedata/commands/poseverts(the header's
                           OWN scalar vertex-per-pose count field, a
                           different thing from this file's `poseverts` array
                           global of the same name) either, confirmed by
                           reading gl_mesh.c's GL_MakeAliasModelDisplayLists.

Since Mod_LoadAliasFrame/Mod_LoadAliasGroup/Mod_LoadAllSkins/Mod_LoadSpriteFrame/
Mod_LoadSpriteGroup each read sequentially through one buffer and return
"where to resume reading" in the C via a `void *` return value, here each
returns the next byte offset into `buffer` (plus whatever it built, where
applicable), instead of a pointer, exactly as src/ref_soft/model.ts's
counterparts do.

Deviations from PORTING.md / the C source:
- GL_LoadTexture's `data` argument is a raw `byte *` in the C, bounded only by
  the `width`/`height` the call also passes; this port's TextureT.data (and
  AliashdrT skin-pixel buffers) hold more bytes than one mip level in some
  cases (TextureT.data is all four mip levels back to back). Every call below
  passes a `Uint8Array.subarray` bounded to exactly `width*height` bytes
  (mip 0 only for textures; already-exact-sized views for skins/sprite
  frames), matching what a real pointer + width*height read would touch.
- Mod_LoadAllSkins's `skin` local (the flood-fill target) is computed ONCE
  from the FIRST skin's pixel bytes and never reassigned in the C, even
  though the loop advances `pskintype` (and therefore which skin's pixels are
  actually copied into `texels`/uploaded via GL_LoadTexture) on every
  iteration. Every Mod_FloodFillSkin call in the loop -- for every skin and
  every skin-group subframe -- therefore re-processes the SAME first skin's
  pixel bytes, repeatedly re-filling (and further corrupting on each
  re-entry, since 255 is left behind as a visited marker) memory that has
  nothing to do with the skin actually being uploaded that iteration. This is
  preserved exactly as the C has it: `skin` here is a single `Uint8Array.subarray` view
  computed once, reused unchanged across the whole function.
- Mod_LoadAliasFrame/Mod_LoadAliasGroup's C assigns `frame->bboxmin.v[i]`
  TWICE in the same loop -- once from the source's bboxmin, once from its
  bboxmax -- and never assigns `frame->bboxmax` at all:
    frame->bboxmin.v[i] = pdaliasframe->bboxmin.v[i];
    frame->bboxmin.v[i] = pdaliasframe->bboxmax.v[i];
  The second write wins, so `frame.bboxmin` ends up holding the SOURCE's
  bboxMAX, and `frame.bboxmax` (MaliasframedescT's own field) is never
  written, staying at `new TrivertxT()`'s zero default. Preserved exactly as the C has it
  in both Mod_LoadAliasFrame and Mod_LoadAliasGroup below; ref_soft's
  same-named functions do NOT have this bug (model.c's software copies read
  both fields correctly), so this is a genuine gl_model.c-only defect, not a
  transcription mistake here.
- Mod_LoadAliasGroup's C skips over each subframe's own `daliasframe_t`
  header (`(daliasframe_t *)ptemp + 1`) without ever reading its `name`,
  `bboxmin` or `bboxmax` fields -- unlike ref_soft's Mod_LoadAliasGroup, which
  recurses into Mod_LoadAliasFrame per subframe and does read them. This is
  not a bug to preserve so much as a structural difference already noted in
  gl_model_types.ts's header (MaliasframedescT is a flat firstpose/numposes
  range, no per-subframe storage at all): the per-subframe header bytes are
  skipped by advancing the read offset past `DALIASFRAME_T_SIZE` with no
  `readDaliasframe` call.
- Mod_LoadAliasGroup's C also reads only the FIRST subframe's interval
  (`frame->interval = LittleFloat (pin_intervals->interval);`, read once
  before the loop) and never validates any interval for `<=0` -- unlike
  Mod_LoadAliasSkinGroup/Mod_LoadSpriteGroup, which validate every one.
  MaliasframedescT.interval is a single scalar (gl_model.h's aliashdr_t
  design, see gl_model_types.ts's header), consistent with this.
- The base s/t vertices are NOT left-shifted by 16 here, unlike
  src/ref_soft/model.ts's Mod_LoadAliasModel (`sv.s = insv.s << 16`).
  gl_model.c's copy reads `stverts[i].s = LittleLong (pinstverts[i].s);` with
  no shift at all -- the software rasterizer's 16.16 fixed-point convention is
  softModelHooks-only; GL's mesh/texture-coordinate path (gl_mesh.c) uses
  plain integers.
- Mod_LoadSpriteModel's C never sets `mod->flags` (unlike model.c's software
  copy, which explicitly zeroes it). Preserved: this hook does not touch
  `mod.flags` either, so a `ModelT` reused across loads keeps whatever value
  a previous load left there.
- `size = sizeof(aliashdr_t) + (numframes-1)*sizeof(frames[0]);
  pheader = Hunk_AllocName(size, loadname);` has no equivalent here: `pheader`
  is a plain `AliashdrT` object, not a sized hunk block, so this port does not
  fake a Hunk_AllocName call for it -- same ruling src/ref_soft/model.ts's
  header already made for its own `pheader`/`Hunk_LowMark` bracketing. `total`
  for `Cache_Alloc(mod.cache, total, loadname, hdr)` is therefore
  `Hunk_LowMark() - start` counting only the real Hunk_AllocName calls made
  for skin texel copies in Mod_LoadAllSkins, an under-count of the C's true
  total for the same reason ref_soft's header explains, but still a genuine,
  positive, monotonically increasing measurement. `Hunk_FreeToLowMark` is
  still called for the same bracketing-fidelity reason PORTING.md keeps it as
  a no-op.
- Mod_LoadAliasFrame/Mod_LoadAliasGroup take an explicit `numv`/`hdr` argument
  here instead of reaching into a module-global `pheader->numverts` the way
  the real gl_model.c body does (`pinframe += pheader->numverts;`). Since
  `pheader` is always exactly the `hdr` object Mod_LoadAliasModel just built
  by the time either helper runs, this is a value-identical, null-safe
  rewrite -- the same adaptation src/ref_soft/model.ts's Mod_LoadAliasFrame/
  Mod_LoadAliasGroup already make relative to their OWN C source
  (WinQuake/model.c's copies take `numv`/`pheader` as explicit parameters
  too, so this brings the GL copies in line with the project's established
  idiom rather than inventing a new one).
- `textureLoaded`'s `sky` branch imports `R_InitSky` from "./gl_warp"
  (gl_warp.c, U073) and its else branch imports `GL_LoadTexture` from
  "./gl_draw" (gl_draw.c, U074); Mod_LoadAliasModel's draw-list step imports
  `GL_MakeAliasModelDisplayLists` from "./gl_mesh" (gl_mesh.c, U073). All
  three landed since this note was first written (it recorded an
  accepted-absent-sibling gate failure while they were still concurrent
  units; see this unit's original report for that tsc/bun test tail).
- `notexture` (r_notexture_mip) is built once at module load, matching
  ModelLoaderHooks.notexture's `readonly` contract and src/ref_soft/model.ts's
  same ruling; R_InitTextures() itself still builds and returns a FRESH
  TextureT each call (matching the C's fresh Hunk_AllocName every call).
- The else branch of `textureLoaded` mutates `glState.texture_mode`
  around the GL_LoadTexture call (`GL_LINEAR_MIPMAP_NEAREST` then
  `GL_LINEAR`), exactly as gl_model.c's file-scope global write does, even
  though gl_vidlinuxglx.c (U075) is glquake.ts's OWNERSHIP-listed owner of
  that field's steady-state default -- this file only ever writes it
  transiently around the call, the same way the C does.
*/

import {
  CONTENTS_EMPTY,
  DFACE_T_SIZE,
  MAXLIGHTMAPS,
  readDface,
  type LumpT,
} from "../common/bspfile";
import {
  ALIAS_VERSION,
  AliasframetypeT,
  AliasskintypeT,
  DALIASFRAME_T_SIZE,
  DALIASFRAMETYPE_T_SIZE,
  DALIASGROUP_T_SIZE,
  DALIASINTERVAL_T_SIZE,
  DALIASSKINGROUP_T_SIZE,
  DALIASSKININTERVAL_T_SIZE,
  DALIASSKINTYPE_T_SIZE,
  DTRIANGLE_T_SIZE,
  MDL_T_SIZE,
  STVERT_T_SIZE,
  StvertT,
  TRIVERTX_T_SIZE,
  TrivertxT,
  readDaliasframe,
  readDaliasframetype,
  readDaliasgroup,
  readDaliasinterval,
  readDaliasskingroup,
  readDaliasskininterval,
  readDaliasskintype,
  readDtriangle,
  readMdl,
  readStvert,
  readTrivertx,
} from "../common/modelgen";
import {
  DSPRITE_T_SIZE,
  DSPRITEFRAME_T_SIZE,
  DSPRITEFRAMETYPE_T_SIZE,
  DSPRITEGROUP_T_SIZE,
  DSPRITEINTERVAL_T_SIZE,
  SPRITE_VERSION,
  SpriteframetypeT,
  readDsprite,
  readDspriteframe,
  readDspriteframetype,
  readDspritegroup,
  readDspriteinterval,
} from "../common/spritegn";
import {
  ModelT,
  ModtypeT,
  MsurfaceT,
  SURF_DRAWSKY,
  SURF_DRAWTILED,
  SURF_DRAWTURB,
  SURF_DONTWARP,
  SURF_PLANEBACK,
  SURF_UNDERWATER,
  TextureT,
  CalcSurfaceExtents,
  loadState,
  Mod_LoadLighting as sharedMod_LoadLighting,
  type ModelLoaderHooks,
} from "../common/model";
import { Cache_Alloc, Hunk_AllocName, Hunk_FreeToLowMark, Hunk_LowMark } from "../common/zone";
import { CvarT } from "../common/cvar";
import { Sys_Error } from "../platform/sys";
import { d_8to24table } from "../client/vid";
import { ALIAS_BASE_SIZE_RATIO, MAX_LBM_HEIGHT, glState } from "./glquake";
import { GL_LINEAR, GL_LINEAR_MIPMAP_NEAREST } from "./qgl";
import {
  AliashdrT,
  MAX_SKINS,
  MAXALIASVERTS,
  MaliasframedescT,
  MspriteT,
  MspriteframeT,
  MspriteframedescT,
  MspritegroupT,
  MtriangleT,
} from "./gl_model_types";
// gl_draw.c (U074) / gl_warp.c (U073) / gl_mesh.c (U073), concurrent with this
// unit: see this file's header note above.
import { GL_LoadTexture } from "./gl_draw";
import { GL_SubdivideSurface, R_InitSky } from "./gl_warp";
import { GL_MakeAliasModelDisplayLists } from "./gl_mesh";
// QuakeWorld track: gl_model.c's player.mdl/eyes.mdl CRC -> cls.qw.userinfo fold.
import { qw } from "../common/quakedef";
import { cl, cls, CactiveT } from "../client/client";
import { CRC_Block } from "../common/crc";
import { com_filesize } from "../common/common";
import { Info_SetValueForKey, Info_ValueForKey, MAX_INFO_STRING } from "../qw/common";
import { modelNames } from "../qw/client/cl_main";
import { MSG_WriteByte, SZ_Print } from "../common/sizebuf";
import { ClcOpsT } from "../qw/protocol";

/*
==============================================================================

BRUSHMODEL LOADING -- Mod_LoadTextures's per-texture step, Mod_LoadFaces,
afterBrushLoad

==============================================================================
*/

/*
=================
textureLoaded

gl_model.c's per-texture step inside Mod_LoadTextures (now shared, see
src/common/model.ts): R_InitSky for "sky*" names, GL_LoadTexture for every
other texture, exactly as gl_model.c's own if/else does.
=================
*/
export function textureLoaded(tx: TextureT): void {
  if (tx.name.startsWith("sky")) {
    R_InitSky(tx);
  } else {
    glState.texture_mode = GL_LINEAR_MIPMAP_NEAREST; //_LINEAR;
    tx.gl_texturenum = GL_LoadTexture(tx.name, tx.width, tx.height, tx.data.subarray(0, tx.width * tx.height), true, false);
    glState.texture_mode = GL_LINEAR;
  }
}

/*
================
CalcSurfaceExtents is src/common/model.ts's; gl_model.c's copy is identical
except for the 512 cap (passed as this hook's own argument below) instead of
model.c's 256.
================
*/

/*
=================
Mod_LoadFaces
=================
*/
export function Mod_LoadFaces(mod: ModelT, buffer: Uint8Array, l: LumpT): void {
  const loadmodel = mod;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (l.filelen % DFACE_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DFACE_T_SIZE;
  const outs: MsurfaceT[] = [];

  loadmodel.surfaces = outs;
  loadmodel.numsurfaces = count;

  for (let surfnum = 0; surfnum < count; surfnum++) {
    const inf = readDface(view, l.fileofs + surfnum * DFACE_T_SIZE);
    const out = new MsurfaceT();
    outs.push(out);

    out.firstedge = inf.firstedge;
    out.numedges = inf.numedges;
    out.flags = 0;

    const planenum = inf.planenum;
    const side = inf.side;
    if (side) out.flags |= SURF_PLANEBACK;

    out.plane = loadmodel.planes[planenum];
    out.texinfo = loadmodel.texinfo[inf.texinfo];

    // gl_model.c's CalcSurfaceExtents caps extents at 512, not model.c's 256
    // (src/common/model.ts's shared CalcSurfaceExtents takes the cap as a
    // parameter for exactly this reason -- reads loadState.loadmodel, which
    // must equal `mod` when this hook runs, exactly as it does when
    // Mod_LoadBrushModel calls this hook).
    CalcSurfaceExtents(out, 512);

    // lighting info
    for (let i = 0; i < MAXLIGHTMAPS; i++) out.styles[i] = inf.styles[i];
    const lightofs = inf.lightofs;
    out.lightofs = lightofs;
    if (lightofs === -1) out.samples = null;
    else out.samples = loadmodel.lightdata !== null ? loadmodel.lightdata.subarray(lightofs) : null;

    // set the drawing flags flag
    const texture = out.texinfo !== null ? out.texinfo.texture : null;
    const texname = texture !== null ? texture.name : "";

    if (texname.startsWith("sky")) {
      // sky
      out.flags |= SURF_DRAWSKY | SURF_DRAWTILED;
      GL_SubdivideSurface(out); // cut up polygon for warps
      continue;
    }

    if (texname.startsWith("*")) {
      // turbulent
      out.flags |= SURF_DRAWTURB | SURF_DRAWTILED;
      for (let i = 0; i < 2; i++) {
        out.extents[i] = 16384;
        out.texturemins[i] = -8192;
      }
      GL_SubdivideSurface(out); // cut up polygon for warps
      continue;
    }
  }
}

/*
=================
afterBrushLoad

gl_model.c's Mod_LoadLeafs appends this pass inline; it stays shared in
src/common/model.ts (see that file's header), so this hook does the GL-only
part: mark every marksurface of a non-CONTENTS_EMPTY leaf SURF_UNDERWATER.
=================
*/
export function afterBrushLoad(mod: ModelT): void {
  // QW/client/gl_model.c: brush models that are not the current map (per
  // cl.qw.serverinfo's "map" key) get every marksurface flagged
  // SURF_DONTWARP, so gl_rsurf.c's underwater-warp gating below skips them.
  const isnotmap = qw.active && `maps/${Info_ValueForKey(cl.qw.serverinfo, "map")}.bsp` !== mod.name;

  for (const leaf of mod.leafs) {
    if (leaf.contents !== CONTENTS_EMPTY) {
      for (let j = 0; j < leaf.nummarksurfaces; j++) {
        leaf.marksurfaces[leaf.firstmarksurface + j].flags |= SURF_UNDERWATER;
      }
    }
    if (isnotmap) {
      for (let j = 0; j < leaf.nummarksurfaces; j++) {
        leaf.marksurfaces[leaf.firstmarksurface + j].flags |= SURF_DONTWARP;
      }
    }
  }
}

/*
==============================================================================

R_InitTextures (gl_rmisc.c)

==============================================================================
*/

/*
==================
R_InitTextures
==================
*/
export function R_InitTextures(): TextureT {
  const tx = new TextureT();

  // create a simple checkerboard texture for the default
  tx.width = tx.height = 16;
  tx.offsets[0] = 0;
  tx.offsets[1] = tx.offsets[0] + 16 * 16;
  tx.offsets[2] = tx.offsets[1] + 8 * 8;
  tx.offsets[3] = tx.offsets[2] + 4 * 4;

  const data = Hunk_AllocName(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2, "notexture");
  for (let m = 0; m < 4; m++) {
    let dest = tx.offsets[m];
    for (let y = 0; y < 16 >> m; y++) {
      for (let x = 0; x < 16 >> m; x++) {
        if ((y < 8 >> m) !== (x < 8 >> m)) data[dest++] = 0;
        else data[dest++] = 0xff;
      }
    }
  }
  tx.data = data;

  return tx;
}

// built at module load, since ModelLoaderHooks.notexture is readonly and can
// be installed before R_Init runs (see this file's header)
export const notexture: TextureT = R_InitTextures();

// gl_model.c's own; used by gl_warp.c's SubdividePolygon (see this file's
// header for why it is declared here but registered nowhere in this unit).
export const gl_subdivide_size = new CvarT("gl_subdivide_size", "128", true);

/*
==============================================================================

ALIAS MODELS

==============================================================================
*/

// gl_model.c's file-scope statics (see this file's header). Reset at the
// start of every Mod_LoadAliasModel call, exactly as the C's fixed-size
// arrays are simply overwritten from index 0 by the next load.
export let pheader: AliashdrT | null = null;
export let stverts: StvertT[] = [];
export let triangles: MtriangleT[] = [];
// a pose is a single set of vertexes. a frame may be an animating sequence
// of poses; this is gl_model.h's `trivertx_t *poseverts[MAXALIASFRAMES]`, a
// different thing from AliashdrT.poseverts (that field is a per-pose VERTEX
// COUNT scalar, set later by gl_mesh.c's GL_MakeAliasModelDisplayLists, see
// this file's header).
export let poseverts: TrivertxT[][] = [];
let posenum = 0;

// QW/client/gl_model.c file-scope static (not in WinQuake's gl_model.c):
// `byte player_8bit_texels[320*200]`, the fixed-size replacement for
// AliashdrT.texels[] when qw.active -- see Mod_LoadAllSkins below.
export const player_8bit_texels: Uint8Array = new Uint8Array(320 * 200);

/*
=================
Mod_LoadAliasFrame
=================
*/
export function Mod_LoadAliasFrame(buffer: Uint8Array, offset: number, frame: MaliasframedescT, numv: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pdaliasframe = readDaliasframe(view, offset);

  frame.name = pdaliasframe.name;
  frame.firstpose = posenum;
  frame.numposes = 1;

  // preserved bug: both writes target frame.bboxmin; the second (bboxmax)
  // wins and frame.bboxmax is never assigned (see this file's header)
  for (let i = 0; i < 3; i++) {
    frame.bboxmin.v[i] = pdaliasframe.bboxmin.v[i];
    frame.bboxmin.v[i] = pdaliasframe.bboxmax.v[i];
  }

  let p = offset + DALIASFRAME_T_SIZE;
  const pinframe: TrivertxT[] = [];
  for (let j = 0; j < numv; j++) {
    pinframe.push(readTrivertx(view, p));
    p += TRIVERTX_T_SIZE;
  }

  poseverts[posenum] = pinframe;
  posenum++;

  return p;
}

/*
=================
Mod_LoadAliasGroup
=================
*/
export function Mod_LoadAliasGroup(buffer: Uint8Array, offset: number, frame: MaliasframedescT, numv: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pingroup = readDaliasgroup(view, offset);

  const numframes = pingroup.numframes;

  frame.firstpose = posenum;
  frame.numposes = numframes;

  // preserved bug: see Mod_LoadAliasFrame above
  for (let i = 0; i < 3; i++) {
    frame.bboxmin.v[i] = pingroup.bboxmin.v[i];
    frame.bboxmin.v[i] = pingroup.bboxmax.v[i];
  }

  let p = offset + DALIASGROUP_T_SIZE;

  // only the FIRST subframe's interval is read; none are validated (unlike
  // Mod_LoadAliasSkinGroup/Mod_LoadSpriteGroup) -- see this file's header.
  const firstInterval = readDaliasinterval(view, p);
  frame.interval = firstInterval.interval;

  p += numframes * DALIASINTERVAL_T_SIZE;

  for (let i = 0; i < numframes; i++) {
    // each subframe's own daliasframe_t header (name/bboxmin/bboxmax) is
    // skipped over unread -- see this file's header.
    let vp = p + DALIASFRAME_T_SIZE;
    const verts: TrivertxT[] = [];
    for (let j = 0; j < numv; j++) {
      verts.push(readTrivertx(view, vp));
      vp += TRIVERTX_T_SIZE;
    }

    poseverts[posenum] = verts;
    posenum++;

    p = vp;
  }

  return p;
}

//=========================================================

/*
=================
Mod_FloodFillSkin

Fill background pixels so mipmapping doesn't have haloes - Ed
=================
*/

// must be a power of 2
const FLOODFILL_FIFO_SIZE = 0x1000;
const FLOODFILL_FIFO_MASK = FLOODFILL_FIFO_SIZE - 1;

// FLOODFILL_STEP(off, dx, dy): checks one neighbor at `pos+off`. Returns the
// updated inpt/fdc pair (the C macro mutates both by reference).
function floodStep(
  skin: Uint8Array,
  pos: number,
  fillcolor: number,
  fifoX: Int16Array,
  fifoY: Int16Array,
  inpt: number,
  nx: number,
  ny: number,
  fdc: number,
): { inpt: number; fdc: number } {
  if (skin[pos] === fillcolor) {
    skin[pos] = 255;
    fifoX[inpt] = nx;
    fifoY[inpt] = ny;
    inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;
  } else if (skin[pos] !== 255) {
    fdc = skin[pos];
  }
  return { inpt, fdc };
}

export function Mod_FloodFillSkin(skin: Uint8Array, skinwidth: number, skinheight: number): void {
  const fillcolor = skin[0]; // assume this is the pixel to fill
  const fifoX = new Int16Array(FLOODFILL_FIFO_SIZE);
  const fifoY = new Int16Array(FLOODFILL_FIFO_SIZE);
  let inpt = 0;
  let outpt = 0;
  let filledcolor = -1;

  if (filledcolor === -1) {
    filledcolor = 0;
    // attempt to find opaque black
    for (let i = 0; i < 256; i++) {
      if (d_8to24table[i] === (255 << 0)) {
        // alpha 1.0
        filledcolor = i;
        break;
      }
    }
  }

  // can't fill to filled color or to transparent color (used as visited marker)
  if (fillcolor === filledcolor || fillcolor === 255) {
    return;
  }

  fifoX[inpt] = 0;
  fifoY[inpt] = 0;
  inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;

  while (outpt !== inpt) {
    const x = fifoX[outpt];
    const y = fifoY[outpt];
    let fdc = filledcolor;
    const pos = x + skinwidth * y;

    outpt = (outpt + 1) & FLOODFILL_FIFO_MASK;

    if (x > 0) ({ inpt, fdc } = floodStep(skin, pos - 1, fillcolor, fifoX, fifoY, inpt, x - 1, y, fdc));
    if (x < skinwidth - 1) ({ inpt, fdc } = floodStep(skin, pos + 1, fillcolor, fifoX, fifoY, inpt, x + 1, y, fdc));
    if (y > 0) ({ inpt, fdc } = floodStep(skin, pos - skinwidth, fillcolor, fifoX, fifoY, inpt, x, y - 1, fdc));
    if (y < skinheight - 1) ({ inpt, fdc } = floodStep(skin, pos + skinwidth, fillcolor, fifoX, fifoY, inpt, x, y + 1, fdc));
    skin[pos] = fdc;
  }
}

/*
===============
Mod_LoadAllSkins
===============
*/
export function Mod_LoadAllSkins(mod: ModelT, hdr: AliashdrT, buffer: Uint8Array, numskins: number, offset: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const s = hdr.skinwidth * hdr.skinheight;

  // skin = (byte *)(pskintype + 1) -- see this file's header: computed ONCE
  // from the FIRST skin's pixel bytes, never reassigned, preserved bug.
  const skin = buffer.subarray(offset + DALIASSKINTYPE_T_SIZE, offset + DALIASSKINTYPE_T_SIZE + s);

  if (numskins < 1 || numskins > MAX_SKINS) Sys_Error("Mod_LoadAliasModel: Invalid # of skins: %d\n", numskins);

  let pskintype = offset;

  for (let i = 0; i < numskins; i++) {
    const skintype = readDaliasskintype(view, pskintype).type;

    if (skintype === AliasskintypeT.ALIAS_SKIN_SINGLE) {
      Mod_FloodFillSkin(skin, hdr.skinwidth, hdr.skinheight);

      // save 8 bit texels for the player model to remap
      const pixelsStart = pskintype + DALIASSKINTYPE_T_SIZE;
      if (qw.active) {
        // QW/client/gl_model.c: only player.mdl's texels are kept, into the
        // fixed-size player_8bit_texels global -- hdr.texels[i] is not set.
        if (mod.name === "progs/player.mdl") {
          if (s > player_8bit_texels.length) Sys_Error("Player skin too large");
          player_8bit_texels.set(buffer.subarray(pixelsStart, pixelsStart + s));
        }
      } else {
        const texels = Hunk_AllocName(s, loadState.loadname);
        texels.set(buffer.subarray(pixelsStart, pixelsStart + s));
        hdr.texels[i] = texels;
      }

      const name = `${mod.name}_${i}`;
      const texnum = GL_LoadTexture(name, hdr.skinwidth, hdr.skinheight, buffer.subarray(pixelsStart, pixelsStart + s), true, false);
      hdr.gl_texturenum[i * 4 + 0] = texnum;
      hdr.gl_texturenum[i * 4 + 1] = texnum;
      hdr.gl_texturenum[i * 4 + 2] = texnum;
      hdr.gl_texturenum[i * 4 + 3] = texnum;

      pskintype = pixelsStart + s;
    } else {
      // animating skin group. yuck.
      pskintype += DALIASSKINTYPE_T_SIZE;
      const pinskingroup = readDaliasskingroup(view, pskintype);
      const groupskins = pinskingroup.numskins;

      const intervalsStart = pskintype + DALIASSKINGROUP_T_SIZE;
      pskintype = intervalsStart + groupskins * DALIASSKININTERVAL_T_SIZE;

      let j = 0;
      for (; j < groupskins; j++) {
        Mod_FloodFillSkin(skin, hdr.skinwidth, hdr.skinheight);
        // QW/client/gl_model.c drops this group-skin texel save entirely.
        if (!qw.active && j === 0) {
          const texels = Hunk_AllocName(s, loadState.loadname);
          texels.set(buffer.subarray(pskintype, pskintype + s));
          hdr.texels[i] = texels;
        }
        const name = `${mod.name}_${i}_${j}`;
        hdr.gl_texturenum[i * 4 + (j & 3)] = GL_LoadTexture(
          name,
          hdr.skinwidth,
          hdr.skinheight,
          buffer.subarray(pskintype, pskintype + s),
          true,
          false,
        );
        pskintype += s;
      }
      const k = j;
      for (; j < 4; j++) {
        hdr.gl_texturenum[i * 4 + (j & 3)] = hdr.gl_texturenum[i * 4 + (j - k)];
      }
    }
  }

  return pskintype;
}

//=========================================================================

/*
=================
Mod_LoadAliasModel
=================
*/
export function Mod_LoadAliasModel(mod: ModelT, buffer: Uint8Array): void {
  const start = Hunk_LowMark();

  // QW/client/gl_model.c: player.mdl/eyes.mdl CRC -> cls.userinfo "pmodel"/"emodel",
  // so the server can verify the skin the client says it is using.
  if (qw.active && (mod.name === "progs/player.mdl" || mod.name === "progs/eyes.mdl")) {
    // CRC_Block(buffer, com_filesize): com_filesize is the exact on-disk
    // length COM_LoadStackFile just set, WITHOUT the trailing 0 byte
    // COM_LoadFile appends to `buffer` -- CRC_Block(buffer) alone would hash
    // that extra byte too and disagree with SV_CheckModel's CRC (sv_init.c).
    const crc = CRC_Block(buffer, com_filesize);
    const key = mod.name === "progs/player.mdl" ? modelNames.pmodel_name : modelNames.emodel_name;
    const value = String(crc);
    cls.qw.userinfo = Info_SetValueForKey(cls.qw.userinfo, key, value, MAX_INFO_STRING);

    if (cls.state >= CactiveT.ca_connected) {
      MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
      SZ_Print(cls.qw.netchan.message, `setinfo ${key} ${crc}`);
    }
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pinmodel = readMdl(view, 0);

  const version = pinmodel.version;
  if (version !== ALIAS_VERSION) Sys_Error("%s has wrong version number (%i should be %i)", mod.name, version, ALIAS_VERSION);

  //
  // allocate space for a working header, plus all the data except the frames,
  // skin and group info
  //
  const hdr = new AliashdrT();
  pheader = hdr; // gl_model.c's file-scope `pheader`

  mod.flags = pinmodel.flags;

  //
  // endian-adjust and copy the data, starting with the alias model header
  //
  hdr.boundingradius = pinmodel.boundingradius;
  hdr.numskins = pinmodel.numskins;
  hdr.skinwidth = pinmodel.skinwidth;
  hdr.skinheight = pinmodel.skinheight;

  if (hdr.skinheight > MAX_LBM_HEIGHT) Sys_Error("model %s has a skin taller than %d", mod.name, MAX_LBM_HEIGHT);

  hdr.numverts = pinmodel.numverts;

  if (hdr.numverts <= 0) Sys_Error("model %s has no vertices", mod.name);

  if (hdr.numverts > MAXALIASVERTS) Sys_Error("model %s has too many vertices", mod.name);

  hdr.numtris = pinmodel.numtris;

  if (hdr.numtris <= 0) Sys_Error("model %s has no triangles", mod.name);

  hdr.numframes = pinmodel.numframes;
  const numframes = hdr.numframes;
  if (numframes < 1) Sys_Error("Mod_LoadAliasModel: Invalid # of frames: %d\n", numframes);

  hdr.size = pinmodel.size * ALIAS_BASE_SIZE_RATIO;
  mod.synctype = pinmodel.synctype;
  mod.numframes = hdr.numframes;

  for (let i = 0; i < 3; i++) {
    hdr.scale[i] = pinmodel.scale[i];
    hdr.scale_origin[i] = pinmodel.scale_origin[i];
    hdr.eyeposition[i] = pinmodel.eyeposition[i];
  }

  //
  // load the skins
  //
  let offset = MDL_T_SIZE;
  offset = Mod_LoadAllSkins(mod, hdr, buffer, hdr.numskins, offset);

  //
  // load base s and t vertices
  //
  stverts = [];
  for (let i = 0; i < hdr.numverts; i++) {
    const insv = readStvert(view, offset);
    offset += STVERT_T_SIZE;
    const sv = new StvertT();
    sv.onseam = insv.onseam;
    sv.s = insv.s;
    sv.t = insv.t;
    stverts.push(sv);
  }

  //
  // load triangle lists
  //
  triangles = [];
  for (let i = 0; i < hdr.numtris; i++) {
    const indt = readDtriangle(view, offset);
    offset += DTRIANGLE_T_SIZE;
    const t = new MtriangleT();
    t.facesfront = indt.facesfront;
    for (let j = 0; j < 3; j++) t.vertindex[j] = indt.vertindex[j];
    triangles.push(t);
  }

  //
  // load the frames
  //
  posenum = 0;
  poseverts = [];

  const frames: MaliasframedescT[] = [];
  for (let i = 0; i < numframes; i++) {
    const frametype = readDaliasframetype(view, offset).type;
    offset += DALIASFRAMETYPE_T_SIZE;

    const fd = new MaliasframedescT();

    if (frametype === AliasframetypeT.ALIAS_SINGLE) {
      offset = Mod_LoadAliasFrame(buffer, offset, fd, hdr.numverts);
    } else {
      offset = Mod_LoadAliasGroup(buffer, offset, fd, hdr.numverts);
    }
    frames.push(fd);
  }
  hdr.frames = frames;

  hdr.numposes = posenum;

  mod.type = ModtypeT.mod_alias;

  // FIXME: do this right
  mod.mins[0] = mod.mins[1] = mod.mins[2] = -16;
  mod.maxs[0] = mod.maxs[1] = mod.maxs[2] = 16;

  //
  // build the draw lists
  //
  GL_MakeAliasModelDisplayLists(mod, hdr);

  //
  // move the complete, relocatable alias model to the cache
  //
  const end = Hunk_LowMark();
  const total = end - start;

  Cache_Alloc(mod.cache, total, loadState.loadname, hdr);

  Hunk_FreeToLowMark(start);
}

/*
==============================================================================

SPRITE MODELS

==============================================================================
*/

/*
=================
Mod_LoadSpriteFrame
=================
*/
export function Mod_LoadSpriteFrame(mod: ModelT, buffer: Uint8Array, offset: number, framenum: number): { frame: MspriteframeT; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pinframe = readDspriteframe(view, offset);

  const width = pinframe.width;
  const height = pinframe.height;
  const size = width * height;

  const pspriteframe = new MspriteframeT();
  pspriteframe.width = width;
  pspriteframe.height = height;

  const origin0 = pinframe.origin[0];
  const origin1 = pinframe.origin[1];
  pspriteframe.up = origin1;
  pspriteframe.down = origin1 - height;
  pspriteframe.left = origin0;
  pspriteframe.right = width + origin0;

  const pixstart = offset + DSPRITEFRAME_T_SIZE;
  const name = `${mod.name}_${framenum}`;
  pspriteframe.gl_texturenum = GL_LoadTexture(name, width, height, buffer.subarray(pixstart, pixstart + size), true, true);

  return { frame: pspriteframe, next: pixstart + size };
}

/*
=================
Mod_LoadSpriteGroup
=================
*/
export function Mod_LoadSpriteGroup(
  mod: ModelT,
  buffer: Uint8Array,
  offset: number,
  framenum: number,
): { group: MspritegroupT; next: number } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pingroup = readDspritegroup(view, offset);

  const numframes = pingroup.numframes;
  let p = offset + DSPRITEGROUP_T_SIZE;

  const intervals = new Float32Array(numframes);
  for (let i = 0; i < numframes; i++) {
    const iv = readDspriteinterval(view, p);
    if (iv.interval <= 0.0) Sys_Error("Mod_LoadSpriteGroup: interval<=0");
    intervals[i] = iv.interval;
    p += DSPRITEINTERVAL_T_SIZE;
  }

  const frames: MspriteframeT[] = [];
  for (let i = 0; i < numframes; i++) {
    const r = Mod_LoadSpriteFrame(mod, buffer, p, framenum * 100 + i);
    frames.push(r.frame);
    p = r.next;
  }

  const group = new MspritegroupT();
  group.numframes = numframes;
  group.intervals = intervals;
  group.frames = frames;

  return { group, next: p };
}

/*
=================
Mod_LoadSpriteModel
=================
*/
export function Mod_LoadSpriteModel(mod: ModelT, buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pin = readDsprite(view, 0);

  const version = pin.version;
  if (version !== SPRITE_VERSION) Sys_Error("%s has wrong version number (%i should be %i)", mod.name, version, SPRITE_VERSION);

  const numframes = pin.numframes;

  const psprite = new MspriteT();
  mod.cache.data = psprite;

  psprite.type = pin.type;
  psprite.maxwidth = pin.width;
  psprite.maxheight = pin.height;
  psprite.beamlength = pin.beamlength;
  mod.synctype = pin.synctype;
  psprite.numframes = numframes;

  mod.mins[0] = mod.mins[1] = (-psprite.maxwidth / 2) | 0;
  mod.maxs[0] = mod.maxs[1] = (psprite.maxwidth / 2) | 0;
  mod.mins[2] = (-psprite.maxheight / 2) | 0;
  mod.maxs[2] = (psprite.maxheight / 2) | 0;

  //
  // load the frames
  //
  if (numframes < 1) Sys_Error("Mod_LoadSpriteModel: Invalid # of frames: %d\n", numframes);

  mod.numframes = numframes;
  // note: gl_model.c never sets mod->flags here (unlike model.c) -- see this
  // file's header.

  let offset = DSPRITE_T_SIZE;
  const frames: MspriteframedescT[] = [];
  for (let i = 0; i < numframes; i++) {
    const frametype = readDspriteframetype(view, offset).type;
    offset += DSPRITEFRAMETYPE_T_SIZE;

    const fd = new MspriteframedescT();
    fd.type = frametype;

    if (frametype === SpriteframetypeT.SPR_SINGLE) {
      const r = Mod_LoadSpriteFrame(mod, buffer, offset, i);
      fd.frameptr = r.frame;
      offset = r.next;
    } else {
      const r = Mod_LoadSpriteGroup(mod, buffer, offset, i);
      fd.frameptr = r.group;
      offset = r.next;
    }
    frames.push(fd);
  }
  psprite.frames = frames;

  mod.type = ModtypeT.mod_sprite;
}

/*
==============================================================================

glModelHooks -- the ModelLoaderHooks this renderer installs

==============================================================================
*/

export const glModelHooks: ModelLoaderHooks = {
  notexture,
  textureLoaded,
  // Mod_LoadLighting is identical between renderers (see this file's
  // header); this delegates to src/common/model.ts's own copy instead of
  // duplicating its body.
  Mod_LoadLighting(_mod: ModelT, _buffer: Uint8Array, l: LumpT): void {
    sharedMod_LoadLighting(l);
  },
  Mod_LoadFaces,
  Mod_LoadAliasModel,
  Mod_LoadSpriteModel,
  afterBrushLoad,
};
