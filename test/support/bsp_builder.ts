// Test helper: builds a valid BSP29 file (WinQuake/bspfile.h's dheader_t and
// the fifteen lumps) in memory, and optionally writes it to disk under a
// scratch directory. Not a ported C file -- test infrastructure only.
//
// The map it emits is the minimum src/common/model.ts's loader and the
// server's hull traces need, not a real sealed room:
//   - 2 planes  (plane 0 is z=0 facing up, plane 1 is x=0 facing +x)
//   - 1 node    (splits on plane 0; front child is leaf 1, back child leaf 0)
//   - 2 leafs   (leaf 0 CONTENTS_SOLID -- the generic solid leaf every BSP
//                has at index 0 -- and leaf 1 CONTENTS_EMPTY)
//   - 3 clipnodes for hull1/hull2 (hull0's are derived by Mod_MakeHull0)
//   - 1 submodel whose headnode[] points at node 0 / clipnode 0
//   - entities: worldspawn + one info_player_start
//   - 8 vertexes / 9 edges / 8 surfedges / 2 faces / 1 texinfo / 1 miptex
//   - empty lighting unless `lightLevel` is passed; visibility is empty
//     unless `visdata` is passed

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HEADER_LUMPS = 15;
const LUMP_ENTITIES = 0;
const LUMP_PLANES = 1;
const LUMP_TEXTURES = 2;
const LUMP_VERTEXES = 3;
const LUMP_VISIBILITY = 4;
const LUMP_NODES = 5;
const LUMP_TEXINFO = 6;
const LUMP_FACES = 7;
const LUMP_LIGHTING = 8;
const LUMP_CLIPNODES = 9;
const LUMP_LEAFS = 10;
const LUMP_MARKSURFACES = 11;
const LUMP_EDGES = 12;
const LUMP_SURFEDGES = 13;
const LUMP_MODELS = 14;

export const BSPVERSION = 29;
export const MAX_MAP_HULLS = 4;
export const MIPLEVELS = 4;
export const MAXLIGHTMAPS = 4;
export const NUM_AMBIENTS = 4;

// U4 addition (BSP2/2PSB support): the same magic numbers src/common/bspfile.ts
// computes, duplicated here per this file's own convention (every other
// on-disk constant in this builder is a hand-copied duplicate of the src/
// side, not an import, so a bug in one side is never masked by the other).
export const BSP2VERSION_2PSB = (("B".charCodeAt(0) << 24) | ("S".charCodeAt(0) << 16) | ("P".charCodeAt(0) << 8) | "2".charCodeAt(0)) >>> 0;
export const BSP2VERSION_BSP2 = ("B".charCodeAt(0) | ("S".charCodeAt(0) << 8) | ("P".charCodeAt(0) << 16) | ("2".charCodeAt(0) << 24)) >>> 0;

export const BSP_WIDTH_29 = 0;
export const BSP_WIDTH_2PSB = 1;
export const BSP_WIDTH_BSP2 = 2;
export type BspWidth = 0 | 1 | 2;

export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;

// what the builder emits, so a test can assert against it instead of against
// hand-copied magic numbers.
export const BSP_NUMPLANES = 2;
export const BSP_NUMNODES = 1;
export const BSP_NUMLEAFS = 2;
export const BSP_NUMCLIPNODES = 3;
export const BSP_NUMVERTEXES = 8;
export const BSP_NUMEDGES = 9; // edge 0 is the unused reserved entry
export const BSP_NUMSURFEDGES = 8;
export const BSP_NUMFACES = 2;
// each face is a 64-unit square whose texinfo s/t axes are the x/y axes, so
// Mod_CalcSurfaceExtents gives extents 64 and the lightmap is
// ((64>>4)+1)^2 = 25 samples per style
export const BSP_FACE_LIGHTMAP_SAMPLES = 25;
export const BSP_NUMTEXINFO = 1;
export const BSP_NUMSUBMODELS = 1;
export const BSP_NUMMARKSURFACES = 2;
export const BSP_VISLEAFS = 1; // submodel visleafs: leafs not counting leaf 0

export const BSP_ENTITIES =
  '{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n"worldtype" "0"\n}\n' +
  '{\n"classname" "info_player_start"\n"origin" "16 16 24"\n"angle" "90"\n}\n';

export const BSP_MIPTEX_NAME = "bsptest";
export const BSP_MIPTEX_WIDTH = 16;
export const BSP_MIPTEX_HEIGHT = 16;

// skyFace's second miptex/texinfo, for U/dedicated-surface-extents coverage:
// a "sky" named texture, a TEX_SPECIAL texinfo whose enlarged s/t vecs blow
// face 1's extents past the 256 cap without needing new geometry, and face 1
// (the builder's existing 64x64 square at x=128..192) repointed at it.
export const BSP_SKY_MIPTEX_NAME = "sky1";
export const BSP_NUMTEXINFO_WITH_SKY = 2;
const SKY_TEXINFO_VEC_SCALE = 16; // extents = (192-128) * SKY_TEXINFO_VEC_SCALE = 1024 > 256

export interface BspBuildOptions {
  // when set, becomes the VISIBILITY lump and leaf 1's visofs becomes 0
  visdata?: Uint8Array;
  // overrides the texture name written into the single miptex
  miptexName?: string;
  // adds a second miptex (BSP_SKY_MIPTEX_NAME) and a second, TEX_SPECIAL
  // texinfo with oversized extents, and repoints face 1 at it
  skyFace?: boolean;
  // fills the LIGHTING lump with this 0..255 sample value and points every
  // non-sky face's lightofs at its own BSP_FACE_LIGHTMAP_SAMPLES-byte block
  // under style 0, so a face lights the way a qbsp/light-built map's does
  lightLevel?: number;

  // U4 additions (BSP2/2PSB, BSPX, external wads -- see this file's own
  // header for the classic-only fields above):

  // on-disk width for the widened lumps (nodes/clipnodes/edges/faces/leafs/
  // marksurfaces); BSP_WIDTH_29 (default) emits the classic narrow layout
  // byte-for-byte unchanged from before this option existed.
  width?: BspWidth;
  // appends this many extra, unreferenced dvertex_t entries after the real
  // 8 -- lets a test push numvertexes past 65535 without hand-building a
  // real level that big. Requires width !== BSP_WIDTH_29 once the total
  // exceeds 65535 (a real BSP29 edge could not reference them anyway).
  extraVertexes?: number;
  // appends this many extra, unreferenced clipnode entries (planenum 0,
  // both children CONTENTS_EMPTY) after the real 3 -- same idea as
  // extraVertexes, for numclipnodes past 32767.
  extraClipnodes?: number;
  // a BSPX lump directory to append after the last standard lump's data,
  // 4-byte aligned, each entry's bytes placed right after the directory.
  bspxLumps?: Array<{ name: string; data: Uint8Array }>;
  // overrides the worldspawn "wad" key's value (default "gfx/base.wad",
  // baked into BSP_ENTITIES above).
  wadKey?: string;
  // makes the primary miptex an external placeholder: a real miptex_t
  // header (name/width/height) but all four mip offsets zero and no pixel
  // bytes stored in the bsp at all -- src/common/model.ts's Mod_LoadTextures
  // must resolve its pixels from one of worldspawn's "wad" key's wads.
  externalMiptex?: boolean;
}

class Writer {
  bytes: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  i32(v: number): void {
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  u32(v: number): void {
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  i16(v: number): void {
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  u16(v: number): void {
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  u8(v: number): void {
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  f32(v: number): void {
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  // a fixed-width C char[] field, NUL padded
  chars(s: string, width: number): void {
    for (let i = 0; i < width; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0xff : 0);
  }

  raw(b: Uint8Array): void {
    this.bytes.set(b, this.pos);
    this.pos += b.length;
  }
}

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

// --- the individual lump bodies ------------------------------------------

function planesLump(): Uint8Array {
  // dplane_t: normal[3] float, dist float, type int  (20 bytes)
  const w = new Writer(BSP_NUMPLANES * 20);
  // plane 0: z = 0, normal +z, PLANE_Z (2)
  w.f32(0);
  w.f32(0);
  w.f32(1);
  w.f32(0);
  w.i32(2);
  // plane 1: x = 0, normal +x, PLANE_X (0)
  w.f32(1);
  w.f32(0);
  w.f32(0);
  w.f32(0);
  w.i32(0);
  return w.bytes;
}

function vertexesLump(extra: number): Uint8Array {
  // face A: a 64x64 square in the z=0 plane; face B: the same, 128 units +x
  const pts: number[][] = [
    [0, 0, 0],
    [64, 0, 0],
    [64, 64, 0],
    [0, 64, 0],
    [128, 0, 0],
    [192, 0, 0],
    [192, 64, 0],
    [128, 64, 0],
  ];
  const w = new Writer((pts.length + extra) * 12);
  for (const p of pts) {
    w.f32(p[0]);
    w.f32(p[1]);
    w.f32(p[2]);
  }
  // extra, unreferenced vertexes (U4: pushes numvertexes past 65535 for the
  // "BSP2 only" test without a real level that big); placed far from the
  // real geometry so a bug that DID reference one would be obvious.
  for (let i = 0; i < extra; i++) {
    w.f32(1000 + i);
    w.f32(1000);
    w.f32(1000);
  }
  return w.bytes;
}

function edgesLump(width: BspWidth): Uint8Array {
  // dedge_t (BSPVERSION): unsigned short v[2]; dledge_t (2PSB/BSP2): unsigned
  // int v[2]. edge 0 is never used, because negative edge nums are used for
  // counterclockwise use of the edge in a face.
  const e: number[][] = [
    [0, 0],
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
  ];
  if (width === BSP_WIDTH_29) {
    const w = new Writer(e.length * 4);
    for (const p of e) {
      w.u16(p[0]);
      w.u16(p[1]);
    }
    return w.bytes;
  }
  const w = new Writer(e.length * 8);
  for (const p of e) {
    w.u32(p[0]);
    w.u32(p[1]);
  }
  return w.bytes;
}

function surfedgesLump(): Uint8Array {
  // qbsp winds a face's vertices CLOCKWISE as seen from the front of its
  // plane -- checked against maps/start.bsp, where the Newell normal of
  // every face's vertex loop is the negation of its plane normal. The
  // software rasterizer depends on it: r_draw.c's R_EmitEdge calls an edge
  // whose screen v increases a TRAILING edge and one whose v decreases a
  // LEADING edge, so the other winding puts a surface's leading edge to the
  // right of its trailing edge and r_edge.c's R_GenerateSpans emits no span
  // at all. Walking edges 4,3,2,1 (and 8,7,6,5) backwards -- which is what
  // the negative surfedge numbers mean -- gives that winding.
  const se = [-4, -3, -2, -1, -8, -7, -6, -5];
  const w = new Writer(se.length * 4);
  for (const v of se) w.i32(v);
  return w.bytes;
}

function texinfoLump(skyFace: boolean): Uint8Array {
  // texinfo_t: vecs[2][4] float, miptex int, flags int  (40 bytes)
  const count = skyFace ? BSP_NUMTEXINFO_WITH_SKY : BSP_NUMTEXINFO;
  const w = new Writer(count * 40);
  w.f32(1);
  w.f32(0);
  w.f32(0);
  w.f32(0); // s axis
  w.f32(0);
  w.f32(1);
  w.f32(0);
  w.f32(0); // t axis
  w.i32(0); // miptex
  w.i32(0); // flags
  if (skyFace) {
    // texinfo 1: miptex 1 (the sky miptex), TEX_SPECIAL, and s/t axes scaled
    // up so face 1's existing 64-unit-wide geometry produces extents > 256
    // without needing new vertexes (see BSP_SKY_MIPTEX_NAME's comment above).
    w.f32(SKY_TEXINFO_VEC_SCALE);
    w.f32(0);
    w.f32(0);
    w.f32(0);
    w.f32(0);
    w.f32(SKY_TEXINFO_VEC_SCALE);
    w.f32(0);
    w.f32(0);
    w.i32(1); // miptex
    w.i32(1); // flags: TEX_SPECIAL
  }
  return w.bytes;
}

function facesLump(width: BspWidth, skyFace: boolean, lit: boolean): Uint8Array {
  // dsface_t (BSPVERSION, 20 bytes): planenum short, side short, firstedge
  // int, numedges short, texinfo short, styles[4] byte, lightofs int.
  // dlface_t (2PSB/BSP2, 28 bytes): the same fields, all as int.
  const size = width === BSP_WIDTH_29 ? 20 : 28;
  const w = new Writer(BSP_NUMFACES * size);
  for (let f = 0; f < BSP_NUMFACES; f++) {
    const isSky = skyFace && f === 1;
    const lightofs = lit && !isSky ? f * BSP_FACE_LIGHTMAP_SAMPLES : -1; // a sky face never reaches R_BuildLightMap
    if (width === BSP_WIDTH_29) {
      w.i16(0); // planenum
      w.i16(0); // side
      w.i32(f * 4); // firstedge
      w.i16(4); // numedges
      w.i16(isSky ? 1 : 0); // texinfo -- face 1 uses the sky texinfo
    } else {
      w.i32(0); // planenum
      w.i32(0); // side
      w.i32(f * 4); // firstedge
      w.i32(4); // numedges
      w.i32(isSky ? 1 : 0); // texinfo
    }
    w.u8(0);
    w.u8(255);
    w.u8(255);
    w.u8(255); // styles
    w.i32(lightofs);
  }
  return w.bytes;
}

function texturesLump(name: string, skyName: string | null, external: boolean): Uint8Array {
  // dmiptexlump_t { int nummiptex; int dataofs[nummiptex]; } then one (or
  // two, with skyName) miptex_t { char name[16]; unsigned width, height;
  // unsigned offsets[4]; } each followed by its width*height/64*85 mip pixels
  // -- EXCEPT the primary miptex when `external` is set (U4: the re-release
  // "external texture wad" case), which stores just the 40-byte header with
  // all four mip offsets zero and no pixel bytes at all; src/common/model.ts's
  // Mod_LoadTextures must then resolve its pixels from a wad named in
  // worldspawn's "wad" key.
  const nummiptex = skyName === null ? 1 : 2;
  const headerSize = 4 + nummiptex * 4;
  const pixels = ((BSP_MIPTEX_WIDTH * BSP_MIPTEX_HEIGHT) / 64) * 85;
  const names = skyName === null ? [name] : [name, skyName];
  const sizeOf = (i: number): number => (i === 0 && external ? 40 : 40 + pixels);

  let total = headerSize;
  for (let i = 0; i < nummiptex; i++) total += sizeOf(i);
  const w = new Writer(total);

  w.i32(nummiptex);
  let ofs = headerSize;
  for (let i = 0; i < nummiptex; i++) {
    w.i32(ofs); // dataofs[i], relative to the lump start
    ofs += sizeOf(i);
  }

  for (let i = 0; i < names.length; i++) {
    const isExternal = i === 0 && external;
    w.chars(names[i], 16);
    w.u32(BSP_MIPTEX_WIDTH);
    w.u32(BSP_MIPTEX_HEIGHT);
    if (isExternal) {
      for (let m = 0; m < MIPLEVELS; m++) w.u32(0);
      continue; // no pixel bytes follow
    }
    // the four mip offsets are relative to the miptex_t
    let mipofs = 40;
    for (let m = 0; m < MIPLEVELS; m++) {
      w.u32(mipofs);
      mipofs += (BSP_MIPTEX_WIDTH >> m) * (BSP_MIPTEX_HEIGHT >> m);
    }
    for (let j = 0; j < pixels; j++) w.u8(j & 0xff);
  }
  return w.bytes;
}

// U4 addition: a synthetic WAD2 file (wad.ts's WADinfoT/LumpinfoT layout)
// holding a single TYP_MIPTEX lump, for the external-texture-wad test: a
// map's texturesLump(..., external: true) miptex has no pixel data, and
// this is what src/common/model.ts's Mod_LoadTextures should resolve it
// from (via a candidate "gfx/<name>.wad" or "<name>.wad").
export function buildTextureWad(entries: Array<{ name: string; width: number; height: number; fill: number }>): Uint8Array {
  const TYP_MIPTEX = 68;
  const pixelsOf = (width: number, height: number): number => ((width * height) / 64) * 85;
  const lumpSize = (e: { width: number; height: number }): number => 40 + pixelsOf(e.width, e.height);

  const headerSize = 12;
  const lumpinfoSize = 32;
  let dataOfs = headerSize;
  const lumpOffsets: number[] = [];
  for (const e of entries) {
    lumpOffsets.push(dataOfs);
    dataOfs += lumpSize(e);
  }
  const infotableofs = dataOfs;
  const total = infotableofs + entries.length * lumpinfoSize;

  const w = new Writer(total);
  w.chars("WAD2", 4);
  w.i32(entries.length);
  w.i32(infotableofs);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    w.chars(e.name, 16);
    w.u32(e.width);
    w.u32(e.height);
    let mipofs = 40;
    for (let m = 0; m < MIPLEVELS; m++) {
      w.u32(mipofs);
      mipofs += (e.width >> m) * (e.height >> m);
    }
    const pixels = pixelsOf(e.width, e.height);
    for (let j = 0; j < pixels; j++) w.u8(e.fill & 0xff);
  }

  w.pos = infotableofs;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    w.i32(lumpOffsets[i]); // filepos
    w.i32(lumpSize(e)); // disksize
    w.i32(lumpSize(e)); // size
    w.u8(TYP_MIPTEX); // type
    w.u8(0); // compression
    w.u8(0);
    w.u8(0); // pad1/pad2
    w.chars(e.name, 16);
  }

  return w.bytes;
}

function nodesLump(width: BspWidth): Uint8Array {
  // dsnode_t (BSPVERSION, 24 bytes): planenum int, children[2] short,
  // mins[3]/maxs[3] short, firstface/numfaces ushort.
  // dl1node_t (2PSB, 32 bytes): children[2] int, mins/maxs stay short.
  // dl2node_t (BSP2, 44 bytes): children[2] int, mins/maxs float.
  if (width === BSP_WIDTH_29) {
    const w = new Writer(BSP_NUMNODES * 24);
    w.i32(0); // planenum 0 (z = 0)
    w.i16(-2); // front child: -1 - 1 => leaf 1 (empty)
    w.i16(-1); // back child:  -1 - 0 => leaf 0 (solid)
    w.i16(-256);
    w.i16(-256);
    w.i16(-256);
    w.i16(256);
    w.i16(256);
    w.i16(256);
    w.u16(0); // firstface
    w.u16(BSP_NUMFACES); // numfaces
    return w.bytes;
  }

  const size = width === BSP_WIDTH_2PSB ? 32 : 44;
  const w = new Writer(BSP_NUMNODES * size);
  w.i32(0); // planenum 0 (z = 0)
  w.i32(-2); // front child: -1 - 1 => leaf 1 (empty)
  w.i32(-1); // back child:  -1 - 0 => leaf 0 (solid)
  if (width === BSP_WIDTH_2PSB) {
    w.i16(-256);
    w.i16(-256);
    w.i16(-256);
    w.i16(256);
    w.i16(256);
    w.i16(256);
  } else {
    w.f32(-256);
    w.f32(-256);
    w.f32(-256);
    w.f32(256);
    w.f32(256);
    w.f32(256);
  }
  w.u32(0); // firstface
  w.u32(BSP_NUMFACES); // numfaces
  return w.bytes;
}

function leafsLump(width: BspWidth, hasVis: boolean): Uint8Array {
  // dsleaf_t (BSPVERSION, 28 bytes): contents int, visofs int, mins[3]/
  // maxs[3] short, firstmarksurface/nummarksurfaces ushort, ambient_level[4].
  // dl1leaf_t (2PSB, 32 bytes): mins/maxs stay short, indices widen to uint.
  // dl2leaf_t (BSP2, 44 bytes): mins/maxs widen to float too.
  if (width === BSP_WIDTH_29) {
    const w = new Writer(BSP_NUMLEAFS * 28);

    // leaf 0: the generic CONTENTS_SOLID leaf, no visibility info
    w.i32(CONTENTS_SOLID);
    w.i32(-1);
    w.i16(-256);
    w.i16(-256);
    w.i16(-256);
    w.i16(0);
    w.i16(256);
    w.i16(256);
    w.u16(0);
    w.u16(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);

    // leaf 1: empty, owning both marksurfaces
    w.i32(CONTENTS_EMPTY);
    w.i32(hasVis ? 0 : -1);
    w.i16(-256);
    w.i16(-256);
    w.i16(0);
    w.i16(256);
    w.i16(256);
    w.i16(256);
    w.u16(0);
    w.u16(BSP_NUMMARKSURFACES);
    w.u8(1);
    w.u8(2);
    w.u8(3);
    w.u8(4);

    return w.bytes;
  }

  const size = width === BSP_WIDTH_2PSB ? 32 : 44;
  const w = new Writer(BSP_NUMLEAFS * size);
  const bound = (v: number): void => {
    if (width === BSP_WIDTH_2PSB) w.i16(v);
    else w.f32(v);
  };

  // leaf 0
  w.i32(CONTENTS_SOLID);
  w.i32(-1);
  bound(-256);
  bound(-256);
  bound(-256);
  bound(0);
  bound(256);
  bound(256);
  w.u32(0);
  w.u32(0);
  w.u8(0);
  w.u8(0);
  w.u8(0);
  w.u8(0);

  // leaf 1
  w.i32(CONTENTS_EMPTY);
  w.i32(hasVis ? 0 : -1);
  bound(-256);
  bound(-256);
  bound(0);
  bound(256);
  bound(256);
  bound(256);
  w.u32(0);
  w.u32(BSP_NUMMARKSURFACES);
  w.u8(1);
  w.u8(2);
  w.u8(3);
  w.u8(4);

  return w.bytes;
}

function clipnodesLump(width: BspWidth, extra: number): Uint8Array {
  // dsclipnode_t (BSPVERSION, 8 bytes): planenum int, children[2] short.
  // dlclipnode_t (2PSB/BSP2, 12 bytes): children[2] int -- one shared wide
  // layout for both.
  if (width === BSP_WIDTH_29) {
    const w = new Writer((BSP_NUMCLIPNODES + extra) * 8);
    // 0: split on plane 0 (z=0): above => clipnode 1, below => solid
    w.i32(0);
    w.i16(1);
    w.i16(CONTENTS_SOLID);
    // 1: split on plane 1 (x=0): +x => empty, -x => clipnode 2
    w.i32(1);
    w.i16(CONTENTS_EMPTY);
    w.i16(2);
    // 2: split on plane 0 again: both sides empty
    w.i32(0);
    w.i16(CONTENTS_EMPTY);
    w.i16(CONTENTS_EMPTY);
    // extra, unreferenced clipnodes (U4: pushes numclipnodes past 32767 for
    // the "BSP2 only" test): plane 0, both children empty.
    for (let i = 0; i < extra; i++) {
      w.i32(0);
      w.i16(CONTENTS_EMPTY);
      w.i16(CONTENTS_EMPTY);
    }
    return w.bytes;
  }

  const w = new Writer((BSP_NUMCLIPNODES + extra) * 12);
  w.i32(0);
  w.i32(1);
  w.i32(CONTENTS_SOLID);
  w.i32(1);
  w.i32(CONTENTS_EMPTY);
  w.i32(2);
  w.i32(0);
  w.i32(CONTENTS_EMPTY);
  w.i32(CONTENTS_EMPTY);
  for (let i = 0; i < extra; i++) {
    w.i32(0);
    w.i32(CONTENTS_EMPTY);
    w.i32(CONTENTS_EMPTY);
  }
  return w.bytes;
}

function marksurfacesLump(width: BspWidth): Uint8Array {
  if (width === BSP_WIDTH_29) {
    const w = new Writer(BSP_NUMMARKSURFACES * 2);
    w.u16(0);
    w.u16(1);
    return w.bytes;
  }
  const w = new Writer(BSP_NUMMARKSURFACES * 4);
  w.u32(0);
  w.u32(1);
  return w.bytes;
}

function modelsLump(): Uint8Array {
  // dmodel_t: mins[3], maxs[3], origin[3] float, headnode[4] int,
  // visleafs int, firstface int, numfaces int  (64 bytes)
  const w = new Writer(BSP_NUMSUBMODELS * 64);
  w.f32(-256);
  w.f32(-256);
  w.f32(-256);
  w.f32(256);
  w.f32(256);
  w.f32(256);
  w.f32(0);
  w.f32(0);
  w.f32(0);
  w.i32(0); // headnode[0] -- node 0
  w.i32(0); // headnode[1] -- clipnode 0
  w.i32(0); // headnode[2] -- clipnode 0
  w.i32(0); // headnode[3]
  w.i32(BSP_VISLEAFS);
  w.i32(0);
  w.i32(BSP_NUMFACES);
  return w.bytes;
}

function lightingLump(lightLevel: number | undefined): Uint8Array {
  if (lightLevel === undefined) return new Uint8Array(0);
  const bytes = new Uint8Array(BSP_NUMFACES * BSP_FACE_LIGHTMAP_SAMPLES);
  bytes.fill(lightLevel & 0xff);
  return bytes;
}

// --- assembly -------------------------------------------------------------

export function buildBsp(options: BspBuildOptions = {}): Uint8Array {
  const vis = options.visdata ?? new Uint8Array(0);
  const skyFace = options.skyFace ?? false;
  const width = options.width ?? BSP_WIDTH_29;
  const extraVertexes = options.extraVertexes ?? 0;
  const extraClipnodes = options.extraClipnodes ?? 0;
  const bspxLumps = options.bspxLumps ?? [];
  const wadKey = options.wadKey ?? "gfx/base.wad";
  const externalMiptex = options.externalMiptex ?? false;

  const entities = BSP_ENTITIES.replace('"gfx/base.wad"', `"${wadKey}"`);

  const lumps: Uint8Array[] = new Array(HEADER_LUMPS);
  lumps[LUMP_ENTITIES] = latin1(entities + "\0");
  lumps[LUMP_PLANES] = planesLump();
  lumps[LUMP_TEXTURES] = texturesLump(options.miptexName ?? BSP_MIPTEX_NAME, skyFace ? BSP_SKY_MIPTEX_NAME : null, externalMiptex);
  lumps[LUMP_VERTEXES] = vertexesLump(extraVertexes);
  lumps[LUMP_VISIBILITY] = vis;
  lumps[LUMP_NODES] = nodesLump(width);
  lumps[LUMP_TEXINFO] = texinfoLump(skyFace);
  lumps[LUMP_FACES] = facesLump(width, skyFace, options.lightLevel !== undefined);
  lumps[LUMP_LIGHTING] = lightingLump(options.lightLevel);
  lumps[LUMP_CLIPNODES] = clipnodesLump(width, extraClipnodes);
  lumps[LUMP_LEAFS] = leafsLump(width, vis.length > 0);
  lumps[LUMP_MARKSURFACES] = marksurfacesLump(width);
  lumps[LUMP_EDGES] = edgesLump(width);
  lumps[LUMP_SURFEDGES] = surfedgesLump();
  lumps[LUMP_MODELS] = modelsLump();

  const headerSize = 4 + HEADER_LUMPS * 8;
  let total = headerSize;
  const offsets: number[] = new Array(HEADER_LUMPS);
  for (let i = 0; i < HEADER_LUMPS; i++) {
    // keep every lump 4-byte aligned, as qbsp does
    total = (total + 3) & ~3;
    offsets[i] = total;
    total += lumps[i].length;
  }

  // U4: BSPX lump directory, appended after the last standard lump's data,
  // 4-byte aligned -- "BSPX" magic, uint32 count, then that many 24-byte-
  // name + uint32 offset + uint32 length entries (32 bytes each), with each
  // entry's bytes placed right after the directory itself.
  const XLUMP_T_SIZE = 24 + 4 + 4;
  let bspxHeaderOfs = 0;
  let bspxEntriesOfs = 0;
  const bspxDataOfs: number[] = [];
  if (bspxLumps.length > 0) {
    total = (total + 3) & ~3;
    bspxHeaderOfs = total;
    total += 8; // "BSPX" + count
    bspxEntriesOfs = total;
    total += bspxLumps.length * XLUMP_T_SIZE;
    for (const lump of bspxLumps) {
      bspxDataOfs.push(total);
      total += lump.data.length;
    }
  }

  const w = new Writer(total);
  w.i32(bspVersionForWidth(width));
  for (let i = 0; i < HEADER_LUMPS; i++) {
    w.i32(offsets[i]);
    w.i32(lumps[i].length);
  }
  for (let i = 0; i < HEADER_LUMPS; i++) {
    w.pos = offsets[i];
    w.raw(lumps[i]);
  }

  if (bspxLumps.length > 0) {
    w.pos = bspxHeaderOfs;
    w.chars("BSPX", 4);
    w.u32(bspxLumps.length);
    w.pos = bspxEntriesOfs;
    for (let i = 0; i < bspxLumps.length; i++) {
      const lump = bspxLumps[i];
      w.chars(lump.name, 24);
      w.u32(bspxDataOfs[i]);
      w.u32(lump.data.length);
    }
    for (let i = 0; i < bspxLumps.length; i++) {
      w.pos = bspxDataOfs[i];
      w.raw(bspxLumps[i].data);
    }
  }

  return w.bytes;
}

function bspVersionForWidth(width: BspWidth): number {
  if (width === BSP_WIDTH_2PSB) return BSP2VERSION_2PSB;
  if (width === BSP_WIDTH_BSP2) return BSP2VERSION_BSP2;
  return BSPVERSION;
}

// the byte offset and length of one lump inside a built BSP, so a test can
// check what the loader stored against the file itself.
export function bspLump(bsp: Uint8Array, lumpIndex: number): { fileofs: number; filelen: number } {
  const view = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  return {
    fileofs: view.getInt32(4 + lumpIndex * 8, true),
    filelen: view.getInt32(4 + lumpIndex * 8 + 4, true),
  };
}

export const BSP_LUMP_VISIBILITY = LUMP_VISIBILITY;
export const BSP_LUMP_ENTITIES = LUMP_ENTITIES;

// --- alias and sprite headers --------------------------------------------

export interface MdlBuildOptions {
  numframes?: number;
  synctype?: number;
  flags?: number;
  version?: number;
}

// a minimal mdl_t (modelgen.h) with IDPOLYHEADER, one skin, three vertexes,
// one triangle and `numframes` ALIAS_SINGLE frames.
export function buildMdl(options: MdlBuildOptions = {}): Uint8Array {
  const numframes = options.numframes ?? 1;
  const numverts = 3;
  const numtris = 1;
  const skinwidth = 4;
  const skinheight = 4;

  const headerSize = 84;
  const skinSize = 4 + skinwidth * skinheight; // type int + pixels
  const stvertsSize = numverts * 12;
  const trisSize = numtris * 16;
  const frameSize = 4 + 24 + numverts * 4; // type int + daliasframe_t + verts

  const w = new Writer(headerSize + skinSize + stvertsSize + trisSize + numframes * frameSize);

  w.i32(0x4f504449); // "IDPO"
  w.i32(options.version ?? 6); // ALIAS_VERSION
  w.f32(1);
  w.f32(1);
  w.f32(1); // scale
  w.f32(0);
  w.f32(0);
  w.f32(0); // scale_origin
  w.f32(10); // boundingradius
  w.f32(0);
  w.f32(0);
  w.f32(0); // eyeposition
  w.i32(1); // numskins
  w.i32(skinwidth);
  w.i32(skinheight);
  w.i32(numverts);
  w.i32(numtris);
  w.i32(numframes);
  w.i32(options.synctype ?? 1); // ST_RAND
  w.i32(options.flags ?? 0);
  w.f32(1); // size

  // one ALIAS_SKIN_SINGLE skin
  w.i32(0);
  for (let i = 0; i < skinwidth * skinheight; i++) w.u8(i & 0xff);

  // stvert_t onseam, s, t
  for (let i = 0; i < numverts; i++) {
    w.i32(0);
    w.i32(i);
    w.i32(i);
  }

  // dtriangle_t facesfront, vertindex[3]
  for (let i = 0; i < numtris; i++) {
    w.i32(1);
    w.i32(0);
    w.i32(1);
    w.i32(2);
  }

  // frames: daliasframetype_t (ALIAS_SINGLE) then daliasframe_t + trivertx_t
  for (let f = 0; f < numframes; f++) {
    w.i32(0); // ALIAS_SINGLE
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0); // bboxmin
    w.u8(255);
    w.u8(255);
    w.u8(255);
    w.u8(0); // bboxmax
    w.chars(`frame${f}`, 16);
    for (let v = 0; v < numverts; v++) {
      w.u8(v);
      w.u8(v);
      w.u8(v);
      w.u8(0);
    }
  }

  return w.bytes;
}

export interface SprBuildOptions {
  numframes?: number;
  width?: number;
  height?: number;
  synctype?: number;
  version?: number;
}

// a minimal dsprite_t (spritegn.h) with IDSPRITEHEADER and `numframes`
// SPR_SINGLE frames.
export function buildSpr(options: SprBuildOptions = {}): Uint8Array {
  const numframes = options.numframes ?? 1;
  const width = options.width ?? 32;
  const height = options.height ?? 64;

  const frameSize = 4 + 16 + width * height; // type int + dspriteframe_t + pixels
  const w = new Writer(36 + numframes * frameSize);

  w.i32(0x50534449); // "IDSP"
  w.i32(options.version ?? 1); // SPRITE_VERSION
  w.i32(0); // type: SPR_VP_PARALLEL_UPRIGHT
  w.f32(32); // boundingradius
  w.i32(width);
  w.i32(height);
  w.i32(numframes);
  w.f32(10); // beamlength
  w.i32(options.synctype ?? 0); // ST_SYNC

  for (let f = 0; f < numframes; f++) {
    w.i32(0); // SPR_SINGLE
    w.i32(-(width >> 1)); // origin[0]
    w.i32(height >> 1); // origin[1]
    w.i32(width);
    w.i32(height);
    for (let i = 0; i < width * height; i++) w.u8(i & 0xff);
  }

  return w.bytes;
}

// --- disk placement -------------------------------------------------------

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeGameFile(baseDir: string, relPath: string, bytes: Uint8Array): string {
  const full = `${baseDir}/${relPath}`;
  ensureDir(dirname(full));
  writeFileSync(full, bytes);
  return full;
}
