/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/model.h, WinQuake/model.c, WinQuake/gl_model.h and
WinQuake/gl_model.c (GNU GPL v2 or later).

models.c -- model loading and caching

models are the only shared resource between a client and server running
on the same machine.

WinQuake links either model.c or gl_model.c. Both load the same BSP, alias
and sprite files but build different in-memory shapes, while the server only
ever needs the brush half (hulls, nodes, leafs, planes, visdata, entities,
submodels). Per PORTING.md's "Model loading" section this module is the
server-visible loader: the m*_t types are the field-by-field UNION of model.h
and gl_model.h, and the renderer-specific loaders install a
`ModelLoaderHooks` object (src/ref_soft/model.ts, src/ref_gl/gl_model.ts).

Which C function landed where, from a function-by-function diff of model.c
against gl_model.c:

  identical in both, ported here as shared:
    Mod_Init, Mod_Extradata, Mod_PointInLeaf, Mod_DecompressVis, Mod_LeafPVS,
    Mod_TouchModel, Mod_ForName, Mod_LoadLighting, Mod_LoadVisibility,
    Mod_LoadEntities, Mod_LoadVertexes, Mod_LoadSubmodels, Mod_LoadEdges,
    Mod_LoadTexinfo, Mod_SetParent, Mod_LoadClipnodes, Mod_MakeHull0,
    Mod_LoadMarksurfaces, Mod_LoadSurfedges, Mod_LoadPlanes,
    RadiusFromBounds
  identical except for one step, so that step alone is the ModelLoaderHooks
  entry, not the whole function -- WinQuake links Mod_LoadTextures into
  every build, dedicated server included, so the table build and the flags
  it produces must run on every path, not only when a renderer installs
  itself. Ported unconditionally, called straight from Mod_LoadBrushModel:
    Mod_LoadTextures      (model.c calls R_InitSky(tx) for "sky*" names
                           only, right after each texture's pixels are
                           copied; gl_model.c calls R_InitSky(tx) for "sky*"
                           and GL_LoadTexture(tx) for everything else. That
                           one step is `ModelLoaderHooks.textureLoaded`,
                           called once per non-null texture; with no
                           renderer installed it is null and the step is
                           skipped, exactly as the alias/sprite loaders skip
                           their renderer-only fields with no hooks.)
  differ, so they are ModelLoaderHooks entries:
    Mod_LoadFaces         (gl_model.c calls GL_SubdivideSurface for sky and
                           turbulent surfaces; its CalcSurfaceExtents caps
                           extents at 512 instead of 256)
    Mod_LoadAliasModel    (wholly different: soft builds stverts/triangles
                           inside the cached block, GL fills the file-scope
                           stverts[]/triangles[]/poseverts[] and calls
                           GL_MakeAliasModelDisplayLists)
    Mod_LoadSpriteModel   (soft stores 8- or 16-bit pixels in the frame, GL
                           calls GL_LoadTexture per frame)
  differ but stay shared, because the server needs them and only a renderer
  post-pass differs:
    Mod_LoadLeafs         (gl_model.c appends a loop that ORs SURF_UNDERWATER
                           into every marksurface of a non-CONTENTS_EMPTY
                           leaf; nothing between there and the end of
                           Mod_LoadBrushModel reads surface flags, so U071
                           does that pass in afterBrushLoad instead)
    Mod_LoadBrushModel    (soft clears mod->flags, GL does not; the soft
                           value is the one kept, see below)
    Mod_ClearAll, Mod_FindName, Mod_LoadModel, Mod_Print (the NL_* needload
                           state machine, see below)

Deviations from PORTING.md / the C source:
- model.c and gl_model.c disagree about `model_t.needload`: model.c (the
  1.09 WinQuake source, which also raised MAX_MOD_KNOWN's sibling constant
  the other way) uses the three-state NL_PRESENT/NL_NEEDS_LOADED/
  NL_UNREFERENCED scheme with the `avail` slot-reuse path in Mod_FindName,
  gl_model.c still uses the original qboolean and MAX_MOD_KNOWN 512.
  model.c's version is the one ported (MAX_MOD_KNOWN 256, NL_* states), so
  the states are numbers, not `qboolean`.
- gl_model.h's EF_BRIGHTFIELD/EF_MUZZLEFLASH/EF_BRIGHTLIGHT/EF_DIMLIGHT block
  is a duplicate of server.h's; it is not re-declared here, so that the
  server unit owns those four names.
- LittleLong/LittleShort/LittleFloat are the identity on this port's
  little-endian-only target (see common.ts), and every d*_t reader in
  bspfile.ts / modelgen.ts / spritegn.ts already reads little-endian, so the
  loaders below assign reader output straight through instead of wrapping
  each field in a redundant Little* call. Mod_LoadBrushModel's
  `for (i=0 ; i<sizeof(dheader_t)/4 ; i++) ((int*)header)[i] = LittleLong(...)`
  in-place header swap is likewise a no-op and is done by readDheader.
- C pointers into an array become (array, index) pairs or subarray views:
  * `msurface_t.samples` (a `byte *` into model->lightdata) keeps the disk
    `lightofs` in a new `MsurfaceT.lightofs` field and exposes `samples` as a
    `lightdata.subarray(lightofs)` view.
  * `mleaf_t.compressed_vis` (a `byte *` into model->visdata) likewise keeps
    `MleafT.visofs` and exposes a `visdata.subarray(visofs)` view.
  * `mleaf_t.firstmarksurface` (an `msurface_t **` into model->marksurfaces)
    becomes `MleafT.marksurfaces` (the base array, shared, never copied) plus
    `MleafT.firstmarksurface` (the index into it), so `leaf.firstmarksurface
    + j` indexes `leaf.marksurfaces` exactly where the C did pointer
    arithmetic. `nummarksurfaces` is unchanged.
  * Mod_MakeHull0 recovers `in->plane - loadmodel->planes` and
    `child - loadmodel->nodes` from Maps built once per call instead of
    from pointer differences.
- `r_notexture_mip` is a renderer global (r_local.h / glquake.h), so
  Mod_LoadTexinfo cannot name it. It is `ModelLoaderHooks.notexture`; with no
  hooks installed (dedicated server) it is null, which is the state
  QW/server/model.c's server also tolerates -- but only for a texinfo whose
  own miptex is missing (`dataofs === -1`) or out of range, which is rare.
  Every OTHER texinfo gets its real `TextureT` (Mod_LoadTextures now runs on
  every path, see above), so Mod_LoadFaces sees the real name on every path
  and the SURF_DRAWSKY/SURF_DRAWTURB classification runs identically to the
  C, dedicated server included.
- Mod_LoadBrushModel still skips Mod_LoadLighting with no hooks installed
  (model->lightdata stays null). This IS a deviation from the C, not a match
  for it: WinQuake's Mod_LoadLighting has no such branch and always loads
  lightdata, dedicated build included. Nothing under src/server/ or
  src/progs/ reads `model.lightdata`, so the skip is harmless, but it is a
  real behavioural difference and is called out as one rather than described
  as matching C (unlike Mod_LoadTextures above, which this port now does
  match). The alias and sprite loaders fill in only type/numframes/synctype/
  flags/mins/maxs with no hooks installed and leave `cache.data` null, which
  is all the server reads.
- `model_t.cache` is `CacheUser<RendererModelData>` where `RendererModelData`
  is `unknown`: the aliashdr_t / msprite_t block the C caches there is
  renderer-private and has a different layout in model.c and gl_model.c, so
  the renderer that put it there narrows it back out with its own type guard.
- `Mod_Print` prints "%8p" of `mod->cache.data` in the C. TS has no pointer
  values, so it prints whether the cache slot is filled instead.
- `Mod_LoadEntities` copies `l->filelen` bytes into a `char *`; the string
  ends at the lump's NUL. This port decodes latin1 up to the first NUL (or
  filelen) into a JS string, so `entities` is `string | null`.
- Hunk_AllocName is called for the two lumps that really are byte blocks
  (lighting, visibility). The lumps that the C allocates as arrays of structs
  become JS arrays of objects (or an Int32Array for surfedges), per
  PORTING.md's "Hunk_AllocName -> allocate the typed array or object the
  caller needs". The C's slack allocations -- `count*2` planes and `count+1`
  edges -- are kept for the edges (the extra entry exists) and dropped for
  the planes (numplanes is count and nothing indexes past it).
- `Mod_LoadModel` returns `ModelT | null` and `Mod_ForName` passes it
  through, exactly as the C's `model_t *`.
*/

import {
  BSPVERSION,
  DCLIPNODE_T_SIZE,
  DEDGE_T_SIZE,
  DFACE_T_SIZE,
  DLEAF_T_SIZE,
  DMODEL_T_SIZE,
  DNODE_T_SIZE,
  DPLANE_T_SIZE,
  DVERTEX_T_SIZE,
  DclipnodeT,
  DmodelT,
  HEADER_LUMPS,
  LUMP_CLIPNODES,
  LUMP_EDGES,
  LUMP_ENTITIES,
  LUMP_FACES,
  LUMP_LEAFS,
  LUMP_LIGHTING,
  LUMP_MARKSURFACES,
  LUMP_MODELS,
  LUMP_NODES,
  LUMP_PLANES,
  LUMP_SURFEDGES,
  LUMP_TEXINFO,
  LUMP_TEXTURES,
  LUMP_VERTEXES,
  LUMP_VISIBILITY,
  MAXLIGHTMAPS,
  MAX_MAP_HULLS,
  MAX_MAP_LEAFS,
  MIPLEVELS,
  MIPTEX_T_SIZE,
  NUM_AMBIENTS,
  TEXINFO_T_SIZE,
  TEX_SPECIAL,
  readDclipnode,
  readDedge,
  readDface,
  readDheader,
  readDleaf,
  readDmiptexlump,
  readDmodel,
  readDnode,
  readDplane,
  readDvertex,
  readMiptex,
  readTexinfo,
  type LumpT,
} from "./bspfile";
import { ALIAS_VERSION, IDPOLYHEADER, SynctypeT, readMdl } from "./modelgen";
import { IDSPRITEHEADER, SPRITE_VERSION, readDsprite } from "./spritegn";
import { COM_FileBase, COM_LoadStackFile } from "./common";
import { Com_BlockChecksum } from "../qw/md4";
import { DotProduct, Length, MplaneT, VectorCopy, vec3, type Vec3 } from "./mathlib";
import { Cache_Check, Cache_Free, CacheUser, Hunk_AllocName } from "./zone";
import { Sys_Error } from "../platform/sys";
import { Con_Printf } from "../client/console";
import type { EfragT } from "../client/render";
import { qw } from "./quakedef";

/*

d*_t structures are on-disk representations
m*_t structures are in-memory

*/

/*
==============================================================================

BRUSH MODELS

==============================================================================
*/

//
// in memory representation
//
export class MvertexT {
  position: Vec3 = vec3();
}

export const SURF_PLANEBACK = 2;
export const SURF_DRAWSKY = 4;
export const SURF_DRAWSPRITE = 8;
export const SURF_DRAWTURB = 0x10;
export const SURF_DRAWTILED = 0x20;
export const SURF_DRAWBACKGROUND = 0x40;
export const SURF_UNDERWATER = 0x80; // gl_model.h only
export const SURF_DONTWARP = 0x100; // QW/client/gl_model.h only

export class MedgeT {
  v: Uint16Array = new Uint16Array(2);
  cachededgeoffset = 0;
}

export class MtexinfoT {
  vecs: [Float32Array, Float32Array] = [new Float32Array(4), new Float32Array(4)];
  mipadjust = 0;
  texture: TextureT | null = null;
  flags = 0;
}

export class TextureT {
  name = "";
  width = 0;
  height = 0;
  gl_texturenum = 0; // gl_model.h only
  texturechain: MsurfaceT | null = null; // gl_model.h only -- for gl_texsort drawing
  anim_total = 0; // total tenths in sequence ( 0 = no)
  anim_min = 0;
  anim_max = 0; // time for this frame min <=time< max
  anim_next: TextureT | null = null; // in the animation sequence
  alternate_anims: TextureT | null = null; // bmodels in frmae 1 use these
  offsets: Uint32Array = new Uint32Array(MIPLEVELS); // four mip maps stored
  // model.h stores the mip pixels immediately after the texture_t and points
  // `offsets` at them; the block itself lives here instead.
  data: Uint8Array = new Uint8Array(0);
}

// gl_model.h's glpoly_t is renderer-private; ref_gl narrows it back out.
import type { GlpolyT } from "../ref_gl/gl_model_types";
export type { GlpolyT };

// efrag_t is declared in render.h and only the client ever touches it.
export type { EfragT };

export class MsurfaceT {
  visframe = 0; // should be drawn when node is crossed

  dlightframe = 0;
  dlightbits = 0;

  plane: MplaneT | null = null;
  flags = 0;

  firstedge = 0; // look up in model->surfedges[], negative numbers
  numedges = 0; // are backwards edges

  // surface generation data
  cachespots: Array<CacheUser<unknown> | null> = [null, null, null, null];

  texturemins: Int16Array = new Int16Array(2);
  extents: Int16Array = new Int16Array(2);

  light_s = 0; // gl lightmap coordinates
  light_t = 0;

  polys: GlpolyT | null = null; // multiple if warped
  texturechain: MsurfaceT | null = null;

  texinfo: MtexinfoT | null = null;

  // lighting info
  lightmaptexturenum = 0;
  styles: Uint8Array = new Uint8Array(MAXLIGHTMAPS);
  cached_light: Int32Array = new Int32Array(MAXLIGHTMAPS); // values currently used in lightmap
  cached_dlight = false; // true if dynamic light in cache
  lightofs = -1; // dface_t's lightofs; -1 means no samples
  samples: Uint8Array | null = null; // [numstyles*surfsize]
}

// the half of mnode_t that mleaf_t shares, so Mod_SetParent and every
// contents<0 walk can hold either one.
export class MnodeBaseT {
  contents = 0; // 0, to differentiate from leafs
  visframe = 0; // node needs to be traversed if current

  minmaxs: Float32Array = new Float32Array(6); // for bounding box culling

  parent: MnodeT | null = null;
}

export class MnodeT extends MnodeBaseT {
  // node specific
  plane: MplaneT | null = null;
  children: [MnodeT | MleafT | null, MnodeT | MleafT | null] = [null, null];

  firstsurface = 0;
  numsurfaces = 0;
}

export class MleafT extends MnodeBaseT {
  // leaf specific
  visofs = -1;
  compressed_vis: Uint8Array | null = null;
  efrags: EfragT | null = null;

  marksurfaces: MsurfaceT[] = []; // the base of the C's msurface_t ** pointer
  firstmarksurface = 0;
  nummarksurfaces = 0;
  key = 0; // BSP sequence number for leaf's contents
  ambient_sound_level: Uint8Array = new Uint8Array(NUM_AMBIENTS);
}

// the C's `node->contents < 0` leaf test, as a narrowing guard.
export function isMleaf(n: MnodeT | MleafT): n is MleafT {
  return n.contents < 0;
}

export type MclipnodeT = DclipnodeT;

export class HullT {
  clipnodes: MclipnodeT[] = [];
  planes: MplaneT[] = [];
  firstclipnode = 0;
  lastclipnode = 0;
  clip_mins: Vec3 = vec3();
  clip_maxs: Vec3 = vec3();
}

//===================================================================

//
// Whole model
//

export enum ModtypeT {
  mod_brush = 0,
  mod_sprite = 1,
  mod_alias = 2,
}

export const mod_brush = ModtypeT.mod_brush;
export const mod_sprite = ModtypeT.mod_sprite;
export const mod_alias = ModtypeT.mod_alias;

export const EF_ROCKET = 1; // leave a trail
export const EF_GRENADE = 2; // leave a trail
export const EF_GIB = 4; // leave a trail
export const EF_ROTATE = 8; // rotate (bonus items)
export const EF_TRACER = 16; // green split trail
export const EF_ZOMGIB = 32; // small blood trail
export const EF_TRACER2 = 64; // orange split trail + rotate
export const EF_TRACER3 = 128; // purple trail

// the aliashdr_t / msprite_t block the renderer's loader caches in
// model_t.cache. Renderer-private, so it stays unknown here.
export type RendererModelData = unknown;

export class ModelT {
  name = "";
  needload = 0; // bmodels and sprites don't cache normally

  type: ModtypeT = ModtypeT.mod_brush;
  numframes = 0;
  synctype: SynctypeT = SynctypeT.ST_SYNC;

  flags = 0;

  //
  // volume occupied by the model graphics
  //
  mins: Vec3 = vec3();
  maxs: Vec3 = vec3();
  radius = 0;

  //
  // solid volume for clipping
  //
  clipbox = false;
  clipmins: Vec3 = vec3();
  clipmaxs: Vec3 = vec3();

  //
  // brush model
  //
  firstmodelsurface = 0;
  nummodelsurfaces = 0;

  numsubmodels = 0;
  submodels: DmodelT[] = [];

  numplanes = 0;
  planes: MplaneT[] = [];

  numleafs = 0; // number of visible leafs, not counting 0
  leafs: MleafT[] = [];

  numvertexes = 0;
  vertexes: MvertexT[] = [];

  numedges = 0;
  edges: MedgeT[] = [];

  numnodes = 0;
  nodes: MnodeT[] = [];

  numtexinfo = 0;
  texinfo: MtexinfoT[] = [];

  numsurfaces = 0;
  surfaces: MsurfaceT[] = [];

  numsurfedges = 0;
  surfedges: Int32Array = new Int32Array(0);

  numclipnodes = 0;
  clipnodes: MclipnodeT[] = [];

  nummarksurfaces = 0;
  marksurfaces: MsurfaceT[] = [];

  hulls: HullT[] = [new HullT(), new HullT(), new HullT(), new HullT()];

  numtextures = 0;
  textures: Array<TextureT | null> | null = null;

  visdata: Uint8Array | null = null;
  lightdata: Uint8Array | null = null;
  entities: string | null = null;

  // QW/server/model.c's Mod_LoadBrushModel-only fields (`mod->checksum`/
  // `mod->checksum2`, see that function's file header note): WinQuake's
  // model.h/gl_model.h never declare them, but Mod_LoadBrushModel is shared
  // between both engines in this port, so it computes them unconditionally
  // (cheap; WinQuake simply never reads the fields). `checksum` is an XOR of
  // Com_BlockChecksum over every header lump except LUMP_ENTITIES;
  // `checksum2` additionally excludes LUMP_VISIBILITY/LUMP_LEAFS/LUMP_NODES
  // (sv_init.c's anti-cheat check on the client-server model handshake).
  checksum = 0;
  checksum2 = 0;

  //
  // additional model data
  //
  cache: CacheUser<RendererModelData> = new CacheUser<RendererModelData>(); // only access through Mod_Extradata
}

//============================================================================

/*
The renderer half of model.c / gl_model.c. src/ref_soft/model.ts and
src/ref_gl/gl_model.ts each export one of these; the dedicated server
installs none. See the diff table in this file's header for why exactly these
entries are hooks and everything else is shared.
*/
export interface ModelLoaderHooks {
  // r_notexture_mip, the renderer's checkerboard texture
  readonly notexture: TextureT;

  // the per-texture renderer step inside Mod_LoadTextures (now shared, see
  // that function below): called once per non-null texture, right after its
  // pixels are copied into tx.data. model.c's step is R_InitSky for "sky*"
  // names only; gl_model.c's is R_InitSky for "sky*" and GL_LoadTexture for
  // everything else.
  textureLoaded(tx: TextureT): void;
  Mod_LoadLighting(mod: ModelT, buf: Uint8Array, l: LumpT): void;
  // optional: with this absent the shared Mod_LoadFaces below runs
  Mod_LoadFaces?(mod: ModelT, buf: Uint8Array, l: LumpT): void;
  Mod_LoadAliasModel(mod: ModelT, buf: Uint8Array): void;
  Mod_LoadSpriteModel(mod: ModelT, buf: Uint8Array): void;
  // GL_SubdivideSurface's model-wide post-step, plus gl_model.c's
  // SURF_UNDERWATER marking pass
  afterBrushLoad?(mod: ModelT): void;
}

let modelLoaderHooks: ModelLoaderHooks | null = null;

export function setModelLoaderHooks(h: ModelLoaderHooks | null): void {
  modelLoaderHooks = h;
}

export function getModelLoaderHooks(): ModelLoaderHooks | null {
  return modelLoaderHooks;
}

//============================================================================

// model.c's `loadmodel`, `loadname` and `mod_base`: C globals that are
// reassigned pointers, so per PORTING.md they live on one exported holder.
export interface LoadStateT {
  loadmodel: ModelT | null;
  loadname: string; // for hunk tags
  mod_base: Uint8Array | null;
}

export const loadState: LoadStateT = { loadmodel: null, loadname: "", mod_base: null };

function currentModel(): ModelT {
  const m = loadState.loadmodel;
  if (m === null) Sys_Error("MOD_LoadBmodel: no loadmodel");
  return m;
}

function baseView(): DataView {
  const b = loadState.mod_base;
  if (b === null) Sys_Error("MOD_LoadBmodel: no mod_base");
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export const mod_novis = new Uint8Array(MAX_MAP_LEAFS / 8);

export const MAX_MOD_KNOWN = 256;
const mod_known: ModelT[] = [];
let mod_numknown = 0;

// values for model_t's needload
export const NL_PRESENT = 0;
export const NL_NEEDS_LOADED = 1;
export const NL_UNREFERENCED = 2;

// the C's mod_known[] is a static array of MAX_MOD_KNOWN model_t; grown on
// demand here so an unused slot costs nothing.
function modKnownAt(i: number): ModelT {
  while (mod_known.length <= i) mod_known.push(new ModelT());
  return mod_known[i];
}

/*
===============
Mod_Init
===============
*/
export function Mod_Init(): void {
  mod_novis.fill(0xff);
}

/*
===============
Mod_Extradata

Caches the data if needed
===============
*/
export function Mod_Extradata(mod: ModelT): RendererModelData {
  const r = Cache_Check(mod.cache);
  if (r !== null) return r;

  Mod_LoadModel(mod, true);

  if (mod.cache.data === null) Sys_Error("Mod_Extradata: caching failed");
  return mod.cache.data;
}

/*
===============
Mod_PointInLeaf
===============
*/
export function Mod_PointInLeaf(p: Vec3, model: ModelT | null): MleafT {
  if (!model || model.nodes.length === 0) Sys_Error("Mod_PointInLeaf: bad model");

  let node: MnodeT | MleafT = model.nodes[0];
  for (;;) {
    if (isMleaf(node)) return node;
    const plane: MplaneT | null = node.plane;
    if (plane === null) Sys_Error("Mod_PointInLeaf: bad model");
    const d: number = DotProduct(p, plane.normal) - plane.dist;
    const child: MnodeT | MleafT | null = d > 0 ? node.children[0] : node.children[1];
    if (child === null) Sys_Error("Mod_PointInLeaf: bad model");
    node = child;
  }
}

/*
===================
Mod_DecompressVis
===================
*/
const decompressed = new Uint8Array(MAX_MAP_LEAFS / 8);

export function Mod_DecompressVis(inBuf: Uint8Array | null, model: ModelT): Uint8Array {
  let row = (model.numleafs + 7) >> 3;
  const out = decompressed;
  let o = 0;

  if (inBuf === null) {
    // no vis info, so make all visible
    while (row) {
      out[o++] = 0xff;
      row--;
    }
    return decompressed;
  }

  let i = 0;
  do {
    if (inBuf[i]) {
      out[o++] = inBuf[i++];
      continue;
    }

    let c = inBuf[i + 1];
    i += 2;
    while (c) {
      out[o++] = 0;
      c--;
    }
  } while (o < row);

  return decompressed;
}

export function Mod_LeafPVS(leaf: MleafT, model: ModelT): Uint8Array {
  if (leaf === model.leafs[0]) return mod_novis;
  return Mod_DecompressVis(leaf.compressed_vis, model);
}

/*
===================
Mod_ClearAll
===================
*/
export function Mod_ClearAll(): void {
  for (let i = 0; i < mod_numknown; i++) {
    const mod = mod_known[i];
    if (qw.active) {
      // QW/client/model.c: only non-alias models are marked stale here;
      // alias models are left to cache_user_t eviction (no avail-slot reuse
      // and no sprite cache.data fix -- both dropped, see Mod_FindName below).
      if (mod.type !== ModtypeT.mod_alias) mod.needload = NL_NEEDS_LOADED;
    } else {
      mod.needload = NL_UNREFERENCED;
      //FIX FOR CACHE_ALLOC ERRORS:
      if (mod.type === ModtypeT.mod_sprite) mod.cache.data = null;
    }
  }
}

/*
==================
Mod_FindName

==================
*/
export function Mod_FindName(name: string): ModelT {
  if (name.length === 0) Sys_Error("Mod_ForName: NULL name");

  //
  // search the currently loaded models
  //
  let mod: ModelT = modKnownAt(0);
  let i = 0;

  if (qw.active) {
    // QW/client/model.c: no avail-slot reuse -- mod_known only ever grows.
    for (i = 0; i < mod_numknown; i++) {
      mod = mod_known[i];
      if (mod.name === name) break;
    }

    if (i === mod_numknown) {
      if (mod_numknown === MAX_MOD_KNOWN) Sys_Error("mod_numknown == MAX_MOD_KNOWN");
      mod = modKnownAt(mod_numknown);
      mod.name = name;
      mod.needload = NL_NEEDS_LOADED;
      mod_numknown++;
    }

    return mod;
  }

  let avail: ModelT | null = null;
  for (i = 0; i < mod_numknown; i++) {
    mod = mod_known[i];
    if (mod.name === name) break;
    if (mod.needload === NL_UNREFERENCED)
      if (!avail || mod.type !== ModtypeT.mod_alias) avail = mod;
  }

  if (i === mod_numknown) {
    if (mod_numknown === MAX_MOD_KNOWN) {
      if (avail) {
        mod = avail;
        if (mod.type === ModtypeT.mod_alias) if (Cache_Check(mod.cache) !== null) Cache_Free(mod.cache);
      } else Sys_Error("mod_numknown == MAX_MOD_KNOWN");
    } else {
      mod = modKnownAt(mod_numknown);
      mod_numknown++;
    }
    mod.name = name;
    mod.needload = NL_NEEDS_LOADED;
  }

  return mod;
}

/*
==================
Mod_TouchModel

==================
*/
export function Mod_TouchModel(name: string): void {
  const mod = Mod_FindName(name);

  if (mod.needload === NL_PRESENT) {
    if (mod.type === ModtypeT.mod_alias) Cache_Check(mod.cache);
  }
}

/*
==================
Mod_LoadModel

Loads a model into the cache
==================
*/
export function Mod_LoadModel(mod: ModelT, crash: boolean): ModelT | null {
  if (mod.type === ModtypeT.mod_alias) {
    if (Cache_Check(mod.cache) !== null) {
      mod.needload = NL_PRESENT;
      return mod;
    }
  } else {
    if (mod.needload === NL_PRESENT) return mod;
  }

  //
  // because the world is so huge, load it one piece at a time
  //

  //
  // load the file
  //
  const buf = COM_LoadStackFile(mod.name);
  if (buf === null) {
    if (crash) Sys_Error("Mod_NumForName: %s not found", mod.name);
    return null;
  }

  //
  // allocate a new model
  //
  loadState.loadname = COM_FileBase(mod.name);

  loadState.loadmodel = mod;

  //
  // fill it in
  //

  // call the apropriate loader
  mod.needload = NL_PRESENT;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (view.getInt32(0, true)) {
    case IDPOLYHEADER:
      Mod_LoadAliasModel(mod, buf);
      break;

    case IDSPRITEHEADER:
      Mod_LoadSpriteModel(mod, buf);
      break;

    default:
      Mod_LoadBrushModel(mod, buf);
      break;
  }

  return mod;
}

/*
==================
Mod_ForName

Loads in a model for the given name
==================
*/
export function Mod_ForName(name: string, crash: boolean): ModelT | null {
  const mod = Mod_FindName(name);

  return Mod_LoadModel(mod, crash);
}

/*
===============================================================================

					BRUSHMODEL LOADING

===============================================================================
*/

// a fixed C char[] reads 0 past its NUL; a decoded JS string simply ends
// there, so this mirrors that read instead of returning NaN from charCodeAt.
function charAtOrZero(s: string, i: number): number {
  return i < s.length ? s.charCodeAt(i) : 0;
}

/*
=================
Mod_LoadTextures

model.c and gl_model.c are byte-identical here except for the one step
after the pixel copy: model.c calls R_InitSky(tx) only for "sky*" names;
gl_model.c calls R_InitSky(tx) for "sky*" and GL_LoadTexture(tx) for every
other non-null texture. That step is `textureLoaded`, called once per
non-null texture (dataofs !== -1) after tx.data is filled in, exactly where
the C's per-renderer branch sits. With no renderer installed (dedicated
server) `textureLoaded` is null and the step is skipped -- the table build
and animation sequencing below still run unconditionally, which is what
fixes U/dedicated bad-surface-extents: texinfo and faces need real texture
names and TEX_SPECIAL flags on every path, not just when a renderer is
present (see this file's header).
=================
*/
export function Mod_LoadTextures(mod: ModelT, buffer: Uint8Array, l: LumpT, textureLoaded: ((tx: TextureT) => void) | null): void {
  if (!l.filelen) {
    mod.textures = null;
    return;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const m = readDmiptexlump(view, l.fileofs);

  mod.numtextures = m.nummiptex;
  const textures: Array<TextureT | null> = new Array<TextureT | null>(m.nummiptex).fill(null);
  mod.textures = textures;

  for (let i = 0; i < m.nummiptex; i++) {
    const dataofs = m.dataofs[i];
    if (dataofs === -1) continue;

    const mtOffset = l.fileofs + dataofs;
    const mt = readMiptex(view, mtOffset);

    if (mt.width & 15 || mt.height & 15) Sys_Error("Texture %s is not 16 aligned", mt.name);

    const pixels = Math.floor((mt.width * mt.height) / 64) * 85;
    const tx = new TextureT();
    textures[i] = tx;

    tx.name = mt.name;
    tx.width = mt.width;
    tx.height = mt.height;
    // the pixels immediately follow the structures in the C; here they are
    // TextureT.data, so each offset is kept relative to that block instead
    // (mt.offsets[0] === sizeof(miptex_t), so this starts at 0)
    for (let j = 0; j < MIPLEVELS; j++) tx.offsets[j] = mt.offsets[j] - MIPTEX_T_SIZE;

    const data = Hunk_AllocName(pixels, loadState.loadname);
    data.set(buffer.subarray(mtOffset + MIPTEX_T_SIZE, mtOffset + MIPTEX_T_SIZE + pixels));
    tx.data = data;

    if (textureLoaded !== null) textureLoaded(tx);
  }

  //
  // sequence the animations
  //
  const ANIM_CYCLE = 2;
  for (let i = 0; i < m.nummiptex; i++) {
    const tx = textures[i];
    if (tx === null || charAtOrZero(tx.name, 0) !== "+".charCodeAt(0)) continue;
    if (tx.anim_next !== null) continue; // already sequenced

    // find the number of frames in the animation
    const anims: Array<TextureT | null> = new Array<TextureT | null>(10).fill(null);
    const altanims: Array<TextureT | null> = new Array<TextureT | null>(10).fill(null);

    let max = charAtOrZero(tx.name, 1);
    let altmax = 0;
    if (max >= 0x61 && max <= 0x7a) max -= 0x61 - 0x41; // 'a'-'z' -> 'A'-'Z'
    if (max >= 0x30 && max <= 0x39) {
      max -= 0x30;
      altmax = 0;
      anims[max] = tx;
      max++;
    } else if (max >= 0x41 && max <= 0x4a) {
      altmax = max - 0x41;
      max = 0;
      altanims[altmax] = tx;
      altmax++;
    } else {
      Sys_Error("Bad animating texture %s", tx.name);
    }

    for (let j = i + 1; j < m.nummiptex; j++) {
      const tx2 = textures[j];
      if (tx2 === null || charAtOrZero(tx2.name, 0) !== "+".charCodeAt(0)) continue;
      if (tx2.name.slice(2) !== tx.name.slice(2)) continue;

      let num = charAtOrZero(tx2.name, 1);
      if (num >= 0x61 && num <= 0x7a) num -= 0x61 - 0x41;
      if (num >= 0x30 && num <= 0x39) {
        num -= 0x30;
        anims[num] = tx2;
        if (num + 1 > max) max = num + 1;
      } else if (num >= 0x41 && num <= 0x4a) {
        num = num - 0x41;
        altanims[num] = tx2;
        if (num + 1 > altmax) altmax = num + 1;
      } else {
        Sys_Error("Bad animating texture %s", tx.name);
      }
    }

    // link them all together
    for (let j = 0; j < max; j++) {
      const tx2 = anims[j];
      if (tx2 === null) Sys_Error("Missing frame %i of %s", j, tx.name);
      tx2.anim_total = max * ANIM_CYCLE;
      tx2.anim_min = j * ANIM_CYCLE;
      tx2.anim_max = (j + 1) * ANIM_CYCLE;
      tx2.anim_next = anims[(j + 1) % max];
      if (altmax) tx2.alternate_anims = altanims[0];
    }
    for (let j = 0; j < altmax; j++) {
      const tx2 = altanims[j];
      if (tx2 === null) Sys_Error("Missing frame %i of %s", j, tx.name);
      tx2.anim_total = altmax * ANIM_CYCLE;
      tx2.anim_min = j * ANIM_CYCLE;
      tx2.anim_max = (j + 1) * ANIM_CYCLE;
      tx2.anim_next = altanims[(j + 1) % altmax];
      if (max) tx2.alternate_anims = anims[0];
    }
  }
}

/*
=================
Mod_LoadLighting
=================
*/
export function Mod_LoadLighting(l: LumpT): void {
  const loadmodel = currentModel();
  const base = loadState.mod_base;
  if (base === null) Sys_Error("MOD_LoadBmodel: no mod_base");

  if (!l.filelen) {
    loadmodel.lightdata = null;
    return;
  }
  loadmodel.lightdata = Hunk_AllocName(l.filelen, loadState.loadname);
  loadmodel.lightdata.set(base.subarray(l.fileofs, l.fileofs + l.filelen));
}

/*
=================
Mod_LoadVisibility
=================
*/
export function Mod_LoadVisibility(l: LumpT): void {
  const loadmodel = currentModel();
  const base = loadState.mod_base;
  if (base === null) Sys_Error("MOD_LoadBmodel: no mod_base");

  if (!l.filelen) {
    loadmodel.visdata = null;
    return;
  }
  loadmodel.visdata = Hunk_AllocName(l.filelen, loadState.loadname);
  loadmodel.visdata.set(base.subarray(l.fileofs, l.fileofs + l.filelen));
}

/*
=================
Mod_LoadEntities
=================
*/
export function Mod_LoadEntities(l: LumpT): void {
  const loadmodel = currentModel();
  const base = loadState.mod_base;
  if (base === null) Sys_Error("MOD_LoadBmodel: no mod_base");

  if (!l.filelen) {
    loadmodel.entities = null;
    return;
  }
  let s = "";
  for (let i = 0; i < l.filelen; i++) {
    const c = base[l.fileofs + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  loadmodel.entities = s;
}

/*
=================
Mod_LoadVertexes
=================
*/
export function Mod_LoadVertexes(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DVERTEX_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DVERTEX_T_SIZE;
  const out: MvertexT[] = [];

  loadmodel.vertexes = out;
  loadmodel.numvertexes = count;

  for (let i = 0; i < count; i++) {
    const inv = readDvertex(view, l.fileofs + i * DVERTEX_T_SIZE);
    const v = new MvertexT();
    v.position[0] = inv.point[0];
    v.position[1] = inv.point[1];
    v.position[2] = inv.point[2];
    out.push(v);
  }
}

/*
=================
Mod_LoadSubmodels
=================
*/
export function Mod_LoadSubmodels(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DMODEL_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DMODEL_T_SIZE;
  const out: DmodelT[] = [];

  loadmodel.submodels = out;
  loadmodel.numsubmodels = count;

  for (let i = 0; i < count; i++) {
    const inm = readDmodel(view, l.fileofs + i * DMODEL_T_SIZE);
    const m = new DmodelT();
    for (let j = 0; j < 3; j++) {
      // spread the mins / maxs by a pixel
      m.mins[j] = inm.mins[j] - 1;
      m.maxs[j] = inm.maxs[j] + 1;
      m.origin[j] = inm.origin[j];
    }
    for (let j = 0; j < MAX_MAP_HULLS; j++) m.headnode[j] = inm.headnode[j];
    m.visleafs = inm.visleafs;
    m.firstface = inm.firstface;
    m.numfaces = inm.numfaces;
    out.push(m);
  }
}

/*
=================
Mod_LoadEdges
=================
*/
export function Mod_LoadEdges(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DEDGE_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DEDGE_T_SIZE;
  const out: MedgeT[] = [];
  // the C allocates (count + 1) edges and only fills count
  for (let i = 0; i < count + 1; i++) out.push(new MedgeT());

  loadmodel.edges = out;
  loadmodel.numedges = count;

  for (let i = 0; i < count; i++) {
    const ine = readDedge(view, l.fileofs + i * DEDGE_T_SIZE);
    out[i].v[0] = ine.v[0];
    out[i].v[1] = ine.v[1];
  }
}

/*
=================
Mod_LoadTexinfo
=================
*/
export function Mod_LoadTexinfo(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % TEXINFO_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / TEXINFO_T_SIZE;
  const out: MtexinfoT[] = [];

  loadmodel.texinfo = out;
  loadmodel.numtexinfo = count;

  const notexture = modelLoaderHooks !== null ? modelLoaderHooks.notexture : null;

  for (let i = 0; i < count; i++) {
    const intex = readTexinfo(view, l.fileofs + i * TEXINFO_T_SIZE);
    const o = new MtexinfoT();
    for (let j = 0; j < 4; j++) {
      o.vecs[0][j] = intex.vecs[0][j];
      o.vecs[1][j] = intex.vecs[1][j];
    }
    let len1 = Length(o.vecs[0]);
    const len2 = Length(o.vecs[1]);
    len1 = (len1 + len2) / 2;
    if (len1 < 0.32) o.mipadjust = 4;
    else if (len1 < 0.49) o.mipadjust = 3;
    else if (len1 < 0.99) o.mipadjust = 2;
    else o.mipadjust = 1;

    const miptex = intex.miptex;
    o.flags = intex.flags;

    if (loadmodel.textures === null) {
      o.texture = notexture; // checkerboard texture
      o.flags = 0;
    } else {
      if (miptex >= loadmodel.numtextures) Sys_Error("miptex >= loadmodel->numtextures");
      o.texture = loadmodel.textures[miptex];
      if (o.texture === null) {
        o.texture = notexture; // texture not found
        o.flags = 0;
      }
    }
    out.push(o);
  }
}

/*
================
CalcSurfaceExtents

Fills in s->texturemins[] and s->extents[]
================
*/
// gl_model.c's copy caps extents at 512 where model.c caps at 256; the cap is
// a parameter so the GL hook can pass its own.
export function CalcSurfaceExtents(s: MsurfaceT, maxextents = 256): void {
  const loadmodel = currentModel();
  const mins = [999999, 999999];
  const maxs = [-99999, -99999];

  const tex = s.texinfo;
  if (tex === null) Sys_Error("CalcSurfaceExtents: no texinfo");

  for (let i = 0; i < s.numedges; i++) {
    const e = loadmodel.surfedges[s.firstedge + i];
    let v: MvertexT;
    if (e >= 0) v = loadmodel.vertexes[loadmodel.edges[e].v[0]];
    else v = loadmodel.vertexes[loadmodel.edges[-e].v[1]];

    for (let j = 0; j < 2; j++) {
      const val = v.position[0] * tex.vecs[j][0] + v.position[1] * tex.vecs[j][1] + v.position[2] * tex.vecs[j][2] + tex.vecs[j][3];
      if (val < mins[j]) mins[j] = val;
      if (val > maxs[j]) maxs[j] = val;
    }
  }

  for (let i = 0; i < 2; i++) {
    const bmins = Math.floor(mins[i] / 16);
    const bmaxs = Math.ceil(maxs[i] / 16);

    s.texturemins[i] = bmins * 16;
    s.extents[i] = (bmaxs - bmins) * 16;
    if (!(tex.flags & TEX_SPECIAL) && s.extents[i] > maxextents) Sys_Error("Bad surface extents");
  }
}

/*
=================
Mod_LoadFaces
=================
*/
export function Mod_LoadFaces(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

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

    CalcSurfaceExtents(out);

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
      continue;
    }

    if (texname.startsWith("*")) {
      // turbulent
      out.flags |= SURF_DRAWTURB | SURF_DRAWTILED;
      for (let i = 0; i < 2; i++) {
        out.extents[i] = 16384;
        out.texturemins[i] = -8192;
      }
      continue;
    }
  }
}

/*
=================
Mod_SetParent
=================
*/
export function Mod_SetParent(node: MnodeT | MleafT, parent: MnodeT | null): void {
  node.parent = parent;
  if (isMleaf(node)) return;
  const c0 = node.children[0];
  if (c0 !== null) Mod_SetParent(c0, node);
  const c1 = node.children[1];
  if (c1 !== null) Mod_SetParent(c1, node);
}

/*
=================
Mod_LoadNodes
=================
*/
export function Mod_LoadNodes(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DNODE_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DNODE_T_SIZE;
  const out: MnodeT[] = [];
  // the C's nodes are one contiguous block, so children can point at a node
  // this loop has not reached yet; the objects exist before the fill loop.
  for (let i = 0; i < count; i++) out.push(new MnodeT());

  loadmodel.nodes = out;
  loadmodel.numnodes = count;

  for (let i = 0; i < count; i++) {
    const inn = readDnode(view, l.fileofs + i * DNODE_T_SIZE);
    for (let j = 0; j < 3; j++) {
      out[i].minmaxs[j] = inn.mins[j];
      out[i].minmaxs[3 + j] = inn.maxs[j];
    }

    out[i].plane = loadmodel.planes[inn.planenum];

    out[i].firstsurface = inn.firstface;
    out[i].numsurfaces = inn.numfaces;

    for (let j = 0; j < 2; j++) {
      const p = inn.children[j];
      if (p >= 0) out[i].children[j] = loadmodel.nodes[p];
      else out[i].children[j] = loadmodel.leafs[-1 - p];
    }
  }

  Mod_SetParent(loadmodel.nodes[0], null); // sets nodes and leafs
}

/*
=================
Mod_LoadLeafs
=================
*/
export function Mod_LoadLeafs(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DLEAF_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DLEAF_T_SIZE;
  const outs: MleafT[] = [];

  loadmodel.leafs = outs;
  loadmodel.numleafs = count;

  for (let i = 0; i < count; i++) {
    const inl = readDleaf(view, l.fileofs + i * DLEAF_T_SIZE);
    const out = new MleafT();
    outs.push(out);

    for (let j = 0; j < 3; j++) {
      out.minmaxs[j] = inl.mins[j];
      out.minmaxs[3 + j] = inl.maxs[j];
    }

    out.contents = inl.contents;

    out.marksurfaces = loadmodel.marksurfaces;
    out.firstmarksurface = inl.firstmarksurface;
    out.nummarksurfaces = inl.nummarksurfaces;

    const p = inl.visofs;
    out.visofs = p;
    if (p === -1) out.compressed_vis = null;
    else out.compressed_vis = loadmodel.visdata !== null ? loadmodel.visdata.subarray(p) : null;
    out.efrags = null;

    for (let j = 0; j < 4; j++) out.ambient_sound_level[j] = inl.ambient_level[j];
  }
}

/*
=================
Mod_LoadClipnodes
=================
*/
export function Mod_LoadClipnodes(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DCLIPNODE_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DCLIPNODE_T_SIZE;
  const out: MclipnodeT[] = [];

  loadmodel.clipnodes = out;
  loadmodel.numclipnodes = count;

  let hull = loadmodel.hulls[1];
  hull.clipnodes = out;
  hull.firstclipnode = 0;
  hull.lastclipnode = count - 1;
  hull.planes = loadmodel.planes;
  hull.clip_mins[0] = -16;
  hull.clip_mins[1] = -16;
  hull.clip_mins[2] = -24;
  hull.clip_maxs[0] = 16;
  hull.clip_maxs[1] = 16;
  hull.clip_maxs[2] = 32;

  hull = loadmodel.hulls[2];
  hull.clipnodes = out;
  hull.firstclipnode = 0;
  hull.lastclipnode = count - 1;
  hull.planes = loadmodel.planes;
  hull.clip_mins[0] = -32;
  hull.clip_mins[1] = -32;
  hull.clip_mins[2] = -24;
  hull.clip_maxs[0] = 32;
  hull.clip_maxs[1] = 32;
  hull.clip_maxs[2] = 64;

  for (let i = 0; i < count; i++) {
    const inc = readDclipnode(view, l.fileofs + i * DCLIPNODE_T_SIZE);
    const c = new DclipnodeT();
    c.planenum = inc.planenum;
    c.children[0] = inc.children[0];
    c.children[1] = inc.children[1];
    out.push(c);
  }
}

/*
=================
Mod_MakeHull0

Deplicate the drawing hull structure as a clipping hull
=================
*/
export function Mod_MakeHull0(): void {
  const loadmodel = currentModel();

  const hull = loadmodel.hulls[0];

  const inNodes = loadmodel.nodes;
  const count = loadmodel.numnodes;
  const out: MclipnodeT[] = [];

  hull.clipnodes = out;
  hull.firstclipnode = 0;
  hull.lastclipnode = count - 1;
  hull.planes = loadmodel.planes;

  // the C recovers these two indices with pointer subtraction
  const planeIndex = new Map<MplaneT, number>();
  for (let i = 0; i < loadmodel.planes.length; i++) planeIndex.set(loadmodel.planes[i], i);
  const nodeIndex = new Map<MnodeT, number>();
  for (let i = 0; i < inNodes.length; i++) nodeIndex.set(inNodes[i], i);

  for (let i = 0; i < count; i++) {
    const inn = inNodes[i];
    const o = new DclipnodeT();
    out.push(o);

    const plane = inn.plane;
    o.planenum = plane !== null ? (planeIndex.get(plane) ?? 0) : 0;
    for (let j = 0; j < 2; j++) {
      const child = inn.children[j];
      if (child === null) {
        o.children[j] = 0;
        continue;
      }
      if (isMleaf(child)) o.children[j] = child.contents;
      else o.children[j] = nodeIndex.get(child) ?? 0;
    }
  }
}

/*
=================
Mod_LoadMarksurfaces
=================
*/
export function Mod_LoadMarksurfaces(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % 2) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / 2;
  const out: MsurfaceT[] = [];

  loadmodel.marksurfaces = out;
  loadmodel.nummarksurfaces = count;

  for (let i = 0; i < count; i++) {
    const j = view.getInt16(l.fileofs + i * 2, true);
    if (j >= loadmodel.numsurfaces) Sys_Error("Mod_ParseMarksurfaces: bad surface number");
    out.push(loadmodel.surfaces[j]);
  }
}

/*
=================
Mod_LoadSurfedges
=================
*/
export function Mod_LoadSurfedges(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % 4) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / 4;
  const out = new Int32Array(count);

  loadmodel.surfedges = out;
  loadmodel.numsurfedges = count;

  for (let i = 0; i < count; i++) out[i] = view.getInt32(l.fileofs + i * 4, true);
}

/*
=================
Mod_LoadPlanes
=================
*/
export function Mod_LoadPlanes(l: LumpT): void {
  const loadmodel = currentModel();
  const view = baseView();

  if (l.filelen % DPLANE_T_SIZE) Sys_Error("MOD_LoadBmodel: funny lump size in %s", loadmodel.name);
  const count = l.filelen / DPLANE_T_SIZE;
  const outs: MplaneT[] = [];

  loadmodel.planes = outs;
  loadmodel.numplanes = count;

  for (let i = 0; i < count; i++) {
    const inp = readDplane(view, l.fileofs + i * DPLANE_T_SIZE);
    const out = new MplaneT();
    outs.push(out);

    let bits = 0;
    for (let j = 0; j < 3; j++) {
      out.normal[j] = inp.normal[j];
      if (out.normal[j] < 0) bits |= 1 << j;
    }

    out.dist = inp.dist;
    out.type = inp.type;
    out.signbits = bits;
  }
}

/*
=================
RadiusFromBounds
=================
*/
export function RadiusFromBounds(mins: Vec3, maxs: Vec3): number {
  const corner = vec3();

  for (let i = 0; i < 3; i++) {
    corner[i] = Math.abs(mins[i]) > Math.abs(maxs[i]) ? Math.abs(mins[i]) : Math.abs(maxs[i]);
  }

  return Length(corner);
}

// `*loadmodel = *mod` copies the struct by value: the vec3_t and hull_t[]
// members are embedded arrays and become independent storage in the copy,
// while every pointer member is shared. A shallow object copy would alias the
// typed arrays instead, so each one is copied element by element here.
function copyHull(dst: HullT, src: HullT): void {
  dst.clipnodes = src.clipnodes;
  dst.planes = src.planes;
  dst.firstclipnode = src.firstclipnode;
  dst.lastclipnode = src.lastclipnode;
  VectorCopy(src.clip_mins, dst.clip_mins);
  VectorCopy(src.clip_maxs, dst.clip_maxs);
}

function copyModel(dst: ModelT, src: ModelT): void {
  dst.name = src.name;
  dst.needload = src.needload;
  dst.type = src.type;
  dst.numframes = src.numframes;
  dst.synctype = src.synctype;
  dst.flags = src.flags;
  VectorCopy(src.mins, dst.mins);
  VectorCopy(src.maxs, dst.maxs);
  dst.radius = src.radius;
  dst.clipbox = src.clipbox;
  VectorCopy(src.clipmins, dst.clipmins);
  VectorCopy(src.clipmaxs, dst.clipmaxs);
  dst.firstmodelsurface = src.firstmodelsurface;
  dst.nummodelsurfaces = src.nummodelsurfaces;
  dst.numsubmodels = src.numsubmodels;
  dst.submodels = src.submodels;
  dst.numplanes = src.numplanes;
  dst.planes = src.planes;
  dst.numleafs = src.numleafs;
  dst.leafs = src.leafs;
  dst.numvertexes = src.numvertexes;
  dst.vertexes = src.vertexes;
  dst.numedges = src.numedges;
  dst.edges = src.edges;
  dst.numnodes = src.numnodes;
  dst.nodes = src.nodes;
  dst.numtexinfo = src.numtexinfo;
  dst.texinfo = src.texinfo;
  dst.numsurfaces = src.numsurfaces;
  dst.surfaces = src.surfaces;
  dst.numsurfedges = src.numsurfedges;
  dst.surfedges = src.surfedges;
  dst.numclipnodes = src.numclipnodes;
  dst.clipnodes = src.clipnodes;
  dst.nummarksurfaces = src.nummarksurfaces;
  dst.marksurfaces = src.marksurfaces;
  for (let j = 0; j < MAX_MAP_HULLS; j++) copyHull(dst.hulls[j], src.hulls[j]);
  dst.numtextures = src.numtextures;
  dst.textures = src.textures;
  dst.visdata = src.visdata;
  dst.lightdata = src.lightdata;
  dst.entities = src.entities;
  dst.checksum = src.checksum;
  dst.checksum2 = src.checksum2;
  dst.cache.data = src.cache.data;
}

/*
=================
Mod_LoadBrushModel
=================
*/
export function Mod_LoadBrushModel(mod: ModelT, buffer: Uint8Array): void {
  let model = mod;
  const brushmodel = mod;

  model.type = ModtypeT.mod_brush;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const header = readDheader(view, 0);

  const version = header.version;
  if (version !== BSPVERSION)
    Sys_Error("Mod_LoadBrushModel: %s has wrong version number (%i should be %i)", mod.name, version, BSPVERSION);

  // swap all the lumps
  loadState.mod_base = buffer;

  // load into heap

  // checksum all of the map, except for entities -- QW/server/model.c's
  // Mod_LoadBrushModel (this port's Mod_LoadBrushModel is shared, so it
  // always computes these; see ModelT's checksum/checksum2 field note).
  let checksum = 0;
  let checksum2 = 0;
  for (let i = 0; i < HEADER_LUMPS; i++) {
    if (i === LUMP_ENTITIES) continue;
    const lump = header.lumps[i];
    checksum = (checksum ^ Com_BlockChecksum(buffer.subarray(lump.fileofs, lump.fileofs + lump.filelen), lump.filelen)) >>> 0;

    if (i === LUMP_VISIBILITY || i === LUMP_LEAFS || i === LUMP_NODES) continue;
    checksum2 = (checksum2 ^ Com_BlockChecksum(buffer.subarray(lump.fileofs, lump.fileofs + lump.filelen), lump.filelen)) >>> 0;
  }
  model.checksum = checksum;
  model.checksum2 = checksum2;

  const hooks = modelLoaderHooks;

  Mod_LoadVertexes(header.lumps[LUMP_VERTEXES]);
  Mod_LoadEdges(header.lumps[LUMP_EDGES]);
  Mod_LoadSurfedges(header.lumps[LUMP_SURFEDGES]);
  // shared and unconditional, per this file's header: texinfo and faces
  // need real texture names/flags on every path, dedicated server included.
  Mod_LoadTextures(mod, buffer, header.lumps[LUMP_TEXTURES], hooks !== null ? hooks.textureLoaded : null);
  if (hooks !== null) hooks.Mod_LoadLighting(mod, buffer, header.lumps[LUMP_LIGHTING]);
  Mod_LoadPlanes(header.lumps[LUMP_PLANES]);
  Mod_LoadTexinfo(header.lumps[LUMP_TEXINFO]);
  if (hooks !== null && hooks.Mod_LoadFaces !== undefined) hooks.Mod_LoadFaces(mod, buffer, header.lumps[LUMP_FACES]);
  else Mod_LoadFaces(header.lumps[LUMP_FACES]);
  Mod_LoadMarksurfaces(header.lumps[LUMP_MARKSURFACES]);
  Mod_LoadVisibility(header.lumps[LUMP_VISIBILITY]);
  Mod_LoadLeafs(header.lumps[LUMP_LEAFS]);
  Mod_LoadNodes(header.lumps[LUMP_NODES]);
  Mod_LoadClipnodes(header.lumps[LUMP_CLIPNODES]);
  Mod_LoadEntities(header.lumps[LUMP_ENTITIES]);
  Mod_LoadSubmodels(header.lumps[LUMP_MODELS]);

  Mod_MakeHull0();

  model.numframes = 2; // regular and alternate animation
  // QW/client/model.c drops this clear (matching gl_model.c's WinQuake
  // behavior, already the case here without qw.active -- see this file's
  // header note on Mod_LoadBrushModel's soft-vs-gl flags disagreement).
  if (!qw.active) model.flags = 0;

  //
  // set up the submodels (FIXME: this is confusing)
  //
  for (let i = 0; i < model.numsubmodels; i++) {
    const bm = model.submodels[i];

    model.hulls[0].firstclipnode = bm.headnode[0];
    for (let j = 1; j < MAX_MAP_HULLS; j++) {
      model.hulls[j].firstclipnode = bm.headnode[j];
      model.hulls[j].lastclipnode = model.numclipnodes - 1;
    }

    model.firstmodelsurface = bm.firstface;
    model.nummodelsurfaces = bm.numfaces;

    if (qw.active) {
      // QW/client/model.c reorders this ahead of the VectorCopy calls below,
      // so it reads the PREVIOUS submodel's mins/maxs (or the zeroed initial
      // values on the first submodel) rather than this one's -- exactly as the original.
      model.radius = RadiusFromBounds(model.mins, model.maxs);
      VectorCopy(bm.maxs, model.maxs);
      VectorCopy(bm.mins, model.mins);
    } else {
      VectorCopy(bm.maxs, model.maxs);
      VectorCopy(bm.mins, model.mins);
      model.radius = RadiusFromBounds(model.mins, model.maxs);
    }

    model.numleafs = bm.visleafs;

    if (i < model.numsubmodels - 1) {
      // duplicate the basic information
      const name = `*${i + 1}`;

      const next = Mod_FindName(name);
      loadState.loadmodel = next;
      copyModel(next, model);
      next.name = name;
      model = next;
    }
  }

  if (hooks !== null && hooks.afterBrushLoad !== undefined) hooks.afterBrushLoad(brushmodel);
}

/*
==============================================================================

ALIAS MODELS

==============================================================================
*/

/*
=================
Mod_LoadAliasModel
=================
*/
export function Mod_LoadAliasModel(mod: ModelT, buffer: Uint8Array): void {
  if (modelLoaderHooks !== null) {
    modelLoaderHooks.Mod_LoadAliasModel(mod, buffer);
    return;
  }

  // no renderer installed (dedicated server): only the fields the server and
  // host_cmd.c read are filled in, and nothing goes into the cache.
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pinmodel = readMdl(view, 0);

  const version = pinmodel.version;
  if (version !== ALIAS_VERSION) Sys_Error("%s has wrong version number (%i should be %i)", mod.name, version, ALIAS_VERSION);

  mod.flags = pinmodel.flags;
  mod.synctype = pinmodel.synctype;
  mod.numframes = pinmodel.numframes;

  mod.type = ModtypeT.mod_alias;

  // FIXME: do this right
  mod.mins[0] = mod.mins[1] = mod.mins[2] = -16;
  mod.maxs[0] = mod.maxs[1] = mod.maxs[2] = 16;

  mod.cache.data = null;
}

//=============================================================================

/*
=================
Mod_LoadSpriteModel
=================
*/
export function Mod_LoadSpriteModel(mod: ModelT, buffer: Uint8Array): void {
  if (modelLoaderHooks !== null) {
    modelLoaderHooks.Mod_LoadSpriteModel(mod, buffer);
    return;
  }

  // no renderer installed (dedicated server): the msprite_t and its frames
  // are renderer data, so only the model_t fields are filled in.
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pin = readDsprite(view, 0);

  const version = pin.version;
  if (version !== SPRITE_VERSION) Sys_Error("%s has wrong version number (%i should be %i)", mod.name, version, SPRITE_VERSION);

  const numframes = pin.numframes;

  const maxwidth = pin.width;
  const maxheight = pin.height;
  mod.synctype = pin.synctype;

  mod.mins[0] = mod.mins[1] = (-maxwidth / 2) | 0;
  mod.maxs[0] = mod.maxs[1] = (maxwidth / 2) | 0;
  mod.mins[2] = (-maxheight / 2) | 0;
  mod.maxs[2] = (maxheight / 2) | 0;

  //
  // load the frames
  //
  if (numframes < 1) Sys_Error("Mod_LoadSpriteModel: Invalid # of frames: %d\n", numframes);

  mod.numframes = numframes;
  // QW/client/model.c drops this clear, same as Mod_LoadBrushModel above.
  if (!qw.active) mod.flags = 0;

  mod.cache.data = null;

  mod.type = ModtypeT.mod_sprite;
}

//=============================================================================

/*
================
Mod_Print
================
*/
export function Mod_Print(): void {
  Con_Printf("Cached models:\n");
  for (let i = 0; i < mod_numknown; i++) {
    const mod = mod_known[i];
    Con_Printf("%8s : %s", mod.cache.data === null ? "(null)" : "(cached)", mod.name);
    // QW/client/model.c drops the needload annotations below.
    if (!qw.active) {
      if (mod.needload & NL_UNREFERENCED) Con_Printf(" (!R)");
      if (mod.needload & NL_NEEDS_LOADED) Con_Printf(" (!P)");
    }
    Con_Printf("\n");
  }
}
