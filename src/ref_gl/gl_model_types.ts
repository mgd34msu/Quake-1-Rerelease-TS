/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from the SPRITE MODELS and ALIAS MODELS halves of WinQuake/gl_model.h
(GNU GPL v2 or later), plus that header's `glpoly_t`/`VERTEXSIZE`.

model.h and gl_model.h declare DIFFERENT in-memory alias and sprite shapes
for the same on-disk files, and PORTING.md's "Model loading" section keeps
only the shared brush half in src/common/model.ts. These are gl_model.h's
versions -- the counterpart of src/ref_soft/model_types.ts, which holds
model.h's. src/ref_gl/gl_model.ts (U071) builds them; gl_rmain.ts (U072) and
gl_mesh.ts (U073) read them back through Mod_Extradata.

The two headers differ in exactly these ways:
- mspriteframe_t: `byte *pixels` (software) becomes `int gl_texturenum`, and
  `void *pcachespot` is gone.
- aliashdr_t: software's `model`/`stverts`/`skindesc`/`triangles` offsets are
  replaced by `numposes`/`poseverts`/`posedata`/`commands` plus
  `gl_texturenum[MAX_SKINS][4]` and `texels[MAX_SKINS]`; the skin types
  (maliasskindesc_t, maliasskingroup_t) do not exist at all, because
  GL_LoadTexture uploads every skin at load time.
- maliasframedesc_t: software's ALIAS_SINGLE/ALIAS_GROUP tagged `frame`
  offset is replaced by a flat `firstpose`/`numposes`/`interval` range into
  the one `posedata` pose array, so nothing here needs a discriminated union.

Deviations from PORTING.md / the C source:
- aliashdr_t's `posedata`, `commands` and `texels[]` are `int` BYTE OFFSETS
  from the aliashdr_t base in the C (`(byte *)paliashdr + paliashdr->
  posedata`), because the alias block is one relocatable cache allocation.
  This port has no byte-offset-from-object arithmetic, so each becomes a
  direct reference to the array it addressed (PORTING.md: "C pointers into an
  array become (array, index) pairs or subarray views"):
    posedata  -> TrivertxT[], flat, numposes*poseverts entries
    commands  -> Int32Array, GL_MakeAliasModelDisplayLists' command list
    texels[i] -> Uint8Array | null, the 8-bit skin pixels (player skins only)
  Nothing outside gl_model.c/gl_mesh.c/gl_rmain.c ever reads the numeric
  value.
- `int gl_texturenum[MAX_SKINS][4]` becomes one flat Int32Array of
  MAX_SKINS*4, indexed `[skin * 4 + anim]` (gl_rmain.c:551's
  `gl_texturenum[currententity->skinnum][anim]`). Same shape r_local.ts uses
  for r_frustum_indexes.
- maliasgroup_t/maliasgroupframedesc_t are declared by gl_model.h but the GL
  build reads neither: gl_model.c flattens every group into the flat pose
  array, and gl_mesh.c:293's `maliasgroup_t *paliasgroup;` is an unused
  local. They are kept so this module still has every type the header
  declares; `intervals` keeps the header's `int` (a byte offset in the C,
  never written).
- The C's trailing `frames[1]` variable-length array members become plain
  arrays sized at load time.
- msprite_t's `void *cachespot` carries id's own "remove?" comment and is
  read by no .c file in v1.09. It is kept, typed `unknown`, so the struct
  still has every field gl_model.h declares.
- glpoly_t's `float verts[4][VERTEXSIZE]` is the C's variable-sized-array
  idiom (the [4] is a placeholder; BuildSurfaceDisplayList and
  SubdividePolygon allocate numverts rows). It becomes one flat Float32Array
  of numverts*VERTEXSIZE, row i at [i*VERTEXSIZE .. i*VERTEXSIZE+6].
*/

import { SynctypeT, TrivertxT } from "../common/modelgen";
import { SpriteframetypeT } from "../common/spritegn";
import { type Vec3, vec3 } from "../common/mathlib";

export const VERTEXSIZE = 7;

export class GlpolyT {
  next: GlpolyT | null = null;
  chain: GlpolyT | null = null;
  numverts = 0;
  flags = 0; // for SURF_UNDERWATER
  verts: Float32Array; // variable sized (xyz s1t1 s2t2)

  constructor(numverts = 0) {
    this.numverts = numverts;
    this.verts = new Float32Array(numverts * VERTEXSIZE);
  }
}

/*
==============================================================================

SPRITE MODELS

==============================================================================
*/

// FIXME: shorten these?
export class MspriteframeT {
  width = 0;
  height = 0;
  up = 0;
  down = 0;
  left = 0;
  right = 0;
  gl_texturenum = 0;
}

export class MspritegroupT {
  numframes = 0;
  intervals: Float32Array = new Float32Array(0);
  frames: MspriteframeT[] = [];
}

export class MspriteframedescT {
  type: SpriteframetypeT = SpriteframetypeT.SPR_SINGLE;
  frameptr: MspriteframeT | MspritegroupT | null = null;
}

export class MspriteT {
  type = 0;
  maxwidth = 0;
  maxheight = 0;
  numframes = 0;
  beamlength = 0; // remove?
  cachespot: unknown = null; // remove?
  frames: MspriteframedescT[] = [];
}

/*
==============================================================================

ALIAS MODELS

Alias models are position independent, so the cache manager can move them.
==============================================================================
*/

export class MaliasframedescT {
  firstpose = 0;
  numposes = 0;
  interval = 0;
  bboxmin: TrivertxT = new TrivertxT();
  bboxmax: TrivertxT = new TrivertxT();
  frame = 0;
  name = "";
}

export class MaliasgroupframedescT {
  bboxmin: TrivertxT = new TrivertxT();
  bboxmax: TrivertxT = new TrivertxT();
  frame = 0;
}

export class MaliasgroupT {
  numframes = 0;
  intervals = 0;
  frames: MaliasgroupframedescT[] = [];
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class MtriangleT {
  facesfront = 0;
  vertindex: Int32Array = new Int32Array(3);
}

export const MAX_SKINS = 32;

export class AliashdrT {
  ident = 0;
  version = 0;
  scale: Vec3 = vec3();
  scale_origin: Vec3 = vec3();
  boundingradius = 0;
  eyeposition: Vec3 = vec3();
  numskins = 0;
  skinwidth = 0;
  skinheight = 0;
  numverts = 0;
  numtris = 0;
  numframes = 0;
  synctype: SynctypeT = SynctypeT.ST_SYNC;
  flags = 0;
  size = 0;

  numposes = 0;
  poseverts = 0;
  // C: `int posedata`, a byte offset from this header's base
  posedata: TrivertxT[] = []; // numposes*poseverts trivert_t
  // C: `int commands`, a byte offset from this header's base
  commands: Int32Array = new Int32Array(0); // gl command list with embedded s/t
  // C: `int gl_texturenum[MAX_SKINS][4]`, indexed [skin * 4 + anim]
  gl_texturenum: Int32Array = new Int32Array(MAX_SKINS * 4);
  // C: `int texels[MAX_SKINS]`, byte offsets -- only for player skins
  texels: Array<Uint8Array | null> = new Array<Uint8Array | null>(MAX_SKINS).fill(null);
  frames: MaliasframedescT[] = []; // variable sized
}

export const MAXALIASVERTS = 1024;
export const MAXALIASFRAMES = 256;
export const MAXALIASTRIS = 2048;
