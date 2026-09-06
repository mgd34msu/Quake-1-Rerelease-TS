/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from the ALIAS MODELS and SPRITE MODELS halves of WinQuake/model.h
(GNU GPL v2 or later).

model.h and gl_model.h declare DIFFERENT in-memory alias and sprite shapes
for the same on-disk files, and PORTING.md's "Model loading" section keeps
only the shared brush half in src/common/model.ts. These are model.h's
(software) versions: the block src/ref_soft/model.ts (U061) builds and caches
in `model_t.cache`, and r_alias.ts / r_sprite.ts (U066) read back through
Mod_Extradata. gl_model.h's versions belong to src/ref_gl/gl_model.ts.

They live in their own module rather than in r_local.ts because the C
declares them in model.h, not r_local.h; r_local.ts and d_iface.ts reach
them with `import type` only, so nothing here participates in a runtime
import cycle.

Deviations from PORTING.md / the C source:
- aliashdr_t's `model`, `stverts`, `skindesc`, `triangles` and
  maliasframedesc_t's / maliasgroupframedesc_t's `frame`, maliasgroup_t's and
  maliasskingroup_t's `intervals`, and maliasskindesc_t's `skin` are all `int`
  BYTE OFFSETS from the aliashdr_t base in the C (`(byte *)paliashdr +
  paliashdr->stverts`), because the alias block is one relocatable cache
  allocation. This port has no byte-offset-from-object arithmetic, so each
  becomes a direct reference to the object or array it addressed
  (PORTING.md: "C pointers into an array become (array, index) pairs or
  subarray views"). Nothing outside the alias loader and r_alias.c ever reads
  the numeric value.
- The two offsets the C overloads on a type tag become unions the reader
  narrows, per PORTING.md's "Discriminated unions where the C switches on a
  type tag":
    maliasframedesc_t.frame  ALIAS_SINGLE -> TrivertxT[] (one pose)
                             ALIAS_GROUP  -> MaliasgroupT
    maliasskindesc_t.skin    ALIAS_SKIN_SINGLE -> Uint8Array (skin pixels)
                             ALIAS_SKIN_GROUP  -> MaliasskingroupT
    mspriteframedesc_t.frameptr
                             SPR_SINGLE -> MspriteframeT
                             SPR_GROUP  -> MspritegroupT
  `Array.isArray` / `instanceof` narrow them; no `as` cast is needed.
- `void *pcachespot` (mspriteframe_t, maliasskindesc_t) and `void *cachespot`
  (msprite_t) carry id's own "remove?" comment and are read by no .c file in
  v1.09. They are kept, typed `unknown`, so the structs still have every field
  model.h declares.
- The C's trailing `frames[1]` / `skindescs[1]` variable-length array members
  become plain arrays sized at load time.
*/

import { AliasframetypeT, AliasskintypeT, TrivertxT } from "../common/modelgen";
import type { MdlT, StvertT } from "../common/modelgen";
import { SpriteframetypeT } from "../common/spritegn";

/*
==============================================================================

SPRITE MODELS

==============================================================================
*/

// FIXME: shorten these?
export class MspriteframeT {
  width = 0;
  height = 0;
  pcachespot: unknown = null; // remove?
  up = 0;
  down = 0;
  left = 0;
  right = 0;
  pixels: Uint8Array = new Uint8Array(0);
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
  type: AliasframetypeT = AliasframetypeT.ALIAS_SINGLE;
  bboxmin: TrivertxT = new TrivertxT();
  bboxmax: TrivertxT = new TrivertxT();
  // C: `int frame`, a byte offset from the aliashdr_t base
  frame: TrivertxT[] | MaliasgroupT | null = null;
  name = "";
}

export class MaliasskindescT {
  type: AliasskintypeT = AliasskintypeT.ALIAS_SKIN_SINGLE;
  pcachespot: unknown = null;
  // C: `int skin`, a byte offset from the aliashdr_t base
  skin: Uint8Array | MaliasskingroupT | null = null;
}

export class MaliasgroupframedescT {
  bboxmin: TrivertxT = new TrivertxT();
  bboxmax: TrivertxT = new TrivertxT();
  // C: `int frame`, a byte offset from the aliashdr_t base
  frame: TrivertxT[] = [];
}

export class MaliasgroupT {
  numframes = 0;
  // C: `int intervals`, a byte offset from the aliashdr_t base
  intervals: Float32Array = new Float32Array(0);
  frames: MaliasgroupframedescT[] = [];
}

export class MaliasskingroupT {
  numskins = 0;
  // C: `int intervals`, a byte offset from the aliashdr_t base
  intervals: Float32Array = new Float32Array(0);
  skindescs: MaliasskindescT[] = [];
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class MtriangleT {
  facesfront = 0;
  vertindex: Int32Array = new Int32Array(3);
}

export class AliashdrT {
  // C: `int model`, a byte offset from this header's base
  model: MdlT | null = null;
  // C: `int stverts`, a byte offset from this header's base
  stverts: StvertT[] = [];
  // C: `int skindesc`, a byte offset from this header's base
  skindesc: MaliasskindescT[] = [];
  // C: `int triangles`, a byte offset from this header's base
  triangles: MtriangleT[] = [];
  frames: MaliasframedescT[] = [];
}
