/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/bspfile.h (GNU GPL v2 or later).

On-disk BSP structures. Little-endian only.

The reader pattern used here is this port's convention for every on-disk /
wire format (bspfile.ts, modelgen.ts, spritegn.ts and every later format
module follow it identically):

  export class DplaneT { ...every field initialised... }
  export const DPLANE_T_SIZE = 20;          // equals the C sizeof
  export function readDplane(view: DataView, offset: number): DplaneT

Fixed-size C arrays inside a struct become typed arrays of the right length
(`Float32Array(3)` for a `vec3_t`/`float[3]`, `Int16Array(3)` for `short[3]`,
`Uint8Array(4)` for `byte[4]`, and so on), so a parsed `dvertex_t.point`
is directly usable as a `Vec3` by mathlib's out-param helpers. C `char[]`
fields become strings, read up to the first NUL.

Deviations from the C source:
- The whole `#ifndef QUAKE_GAME` half of bspfile.h (ANGLE_UP/ANGLE_DOWN, the
  static dmodels/dvisdata/dleafs/... utility arrays, epair_t, entity_t,
  LoadBSPFile/WriteBSPFile/CompressVis/ParseEntities and the key/value
  helpers) is compiled out of the engine, which defines QUAKE_GAME. It is the
  qbsp/light/vis tool half and PORTING.md rules those tools out of scope, so
  it is dropped. Nothing in WinQuake references it.
- PLANE_X..PLANE_ANYZ are declared in mathlib.ts (see its header note, which
  explains why the plane constants live beside mplane_t) and re-exported here
  so this module still exports everything bspfile.h exported.
- `dmiptexlump_t.dataofs` is declared `int dataofs[4]` but the C comment says
  `[nummiptex]` and the loaders index it that way, so `readDmiptexlump` reads
  the real `nummiptex` entries. `DMIPTEXLUMP_T_SIZE` is the declared C sizeof
  (20) and is not the size the reader consumes.
*/

import { PLANE_X, PLANE_Y, PLANE_Z, PLANE_ANYX, PLANE_ANYY, PLANE_ANYZ, type Vec3 } from "./mathlib";

export { PLANE_X, PLANE_Y, PLANE_Z, PLANE_ANYX, PLANE_ANYY, PLANE_ANYZ };

// upper design bounds

export const MAX_MAP_HULLS = 4;

export const MAX_MAP_MODELS = 256;
export const MAX_MAP_BRUSHES = 4096;
export const MAX_MAP_ENTITIES = 1024;
export const MAX_MAP_ENTSTRING = 65536;

export const MAX_MAP_PLANES = 32767;
export const MAX_MAP_NODES = 32767; // because negative shorts are contents
export const MAX_MAP_CLIPNODES = 32767; //
export const MAX_MAP_LEAFS = 8192;
export const MAX_MAP_VERTS = 65535;
export const MAX_MAP_FACES = 65535;
export const MAX_MAP_MARKSURFACES = 65535;
export const MAX_MAP_TEXINFO = 4096;
export const MAX_MAP_EDGES = 256000;
export const MAX_MAP_SURFEDGES = 512000;
export const MAX_MAP_TEXTURES = 512;
export const MAX_MAP_MIPTEX = 0x200000;
export const MAX_MAP_LIGHTING = 0x100000;
export const MAX_MAP_VISIBILITY = 0x100000;

export const MAX_MAP_PORTALS = 65536;

// key / value pair sizes

export const MAX_KEY = 32;
export const MAX_VALUE = 1024;

//=============================================================================

export const BSPVERSION = 29;
export const TOOLVERSION = 2;

// reads up to maxLen bytes starting at offset, stopping at the first NUL --
// mirrors treating a fixed C char[] field as a NUL-terminated string.
function readCString(view: DataView, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export class LumpT {
  fileofs = 0;
  filelen = 0;
}
export const LUMP_T_SIZE = 8;

export function readLump(view: DataView, offset: number): LumpT {
  const l = new LumpT();
  l.fileofs = view.getInt32(offset, true);
  l.filelen = view.getInt32(offset + 4, true);
  return l;
}

export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_TEXTURES = 2;
export const LUMP_VERTEXES = 3;
export const LUMP_VISIBILITY = 4;
export const LUMP_NODES = 5;
export const LUMP_TEXINFO = 6;
export const LUMP_FACES = 7;
export const LUMP_LIGHTING = 8;
export const LUMP_CLIPNODES = 9;
export const LUMP_LEAFS = 10;
export const LUMP_MARKSURFACES = 11;
export const LUMP_EDGES = 12;
export const LUMP_SURFEDGES = 13;
export const LUMP_MODELS = 14;

export const HEADER_LUMPS = 15;

export class DmodelT {
  mins: Vec3 = new Float32Array(3);
  maxs: Vec3 = new Float32Array(3);
  origin: Vec3 = new Float32Array(3);
  headnode: Int32Array = new Int32Array(MAX_MAP_HULLS);
  visleafs = 0; // not including the solid leaf 0
  firstface = 0;
  numfaces = 0;
}
export const DMODEL_T_SIZE = 64;

export function readDmodel(view: DataView, offset: number): DmodelT {
  const m = new DmodelT();
  for (let i = 0; i < 3; i++) m.mins[i] = view.getFloat32(offset + i * 4, true);
  for (let i = 0; i < 3; i++) m.maxs[i] = view.getFloat32(offset + 12 + i * 4, true);
  for (let i = 0; i < 3; i++) m.origin[i] = view.getFloat32(offset + 24 + i * 4, true);
  for (let i = 0; i < MAX_MAP_HULLS; i++) m.headnode[i] = view.getInt32(offset + 36 + i * 4, true);
  m.visleafs = view.getInt32(offset + 52, true);
  m.firstface = view.getInt32(offset + 56, true);
  m.numfaces = view.getInt32(offset + 60, true);
  return m;
}

export class DheaderT {
  version = 0;
  lumps: LumpT[] = [];
}
export const DHEADER_T_SIZE = 4 + HEADER_LUMPS * LUMP_T_SIZE;

export function readDheader(view: DataView, offset: number): DheaderT {
  const h = new DheaderT();
  h.version = view.getInt32(offset, true);
  for (let i = 0; i < HEADER_LUMPS; i++) h.lumps.push(readLump(view, offset + 4 + i * LUMP_T_SIZE));
  return h;
}

export class DmiptexlumpT {
  nummiptex = 0;
  dataofs: Int32Array = new Int32Array(0); // [nummiptex]
}
export const DMIPTEXLUMP_T_SIZE = 20;

export function readDmiptexlump(view: DataView, offset: number): DmiptexlumpT {
  const l = new DmiptexlumpT();
  l.nummiptex = view.getInt32(offset, true);
  l.dataofs = new Int32Array(l.nummiptex);
  for (let i = 0; i < l.nummiptex; i++) l.dataofs[i] = view.getInt32(offset + 4 + i * 4, true);
  return l;
}

export const MIPLEVELS = 4;

export class MiptexT {
  name = "";
  width = 0;
  height = 0;
  offsets: Uint32Array = new Uint32Array(MIPLEVELS); // four mip maps stored
}
export const MIPTEX_T_SIZE = 40;

export function readMiptex(view: DataView, offset: number): MiptexT {
  const t = new MiptexT();
  t.name = readCString(view, offset, 16);
  t.width = view.getUint32(offset + 16, true);
  t.height = view.getUint32(offset + 20, true);
  for (let i = 0; i < MIPLEVELS; i++) t.offsets[i] = view.getUint32(offset + 24 + i * 4, true);
  return t;
}

export class DvertexT {
  point: Vec3 = new Float32Array(3);
}
export const DVERTEX_T_SIZE = 12;

export function readDvertex(view: DataView, offset: number): DvertexT {
  const v = new DvertexT();
  for (let i = 0; i < 3; i++) v.point[i] = view.getFloat32(offset + i * 4, true);
  return v;
}

export class DplaneT {
  normal: Vec3 = new Float32Array(3);
  dist = 0;
  type = 0; // PLANE_X - PLANE_ANYZ ?remove? trivial to regenerate
}
export const DPLANE_T_SIZE = 20;

export function readDplane(view: DataView, offset: number): DplaneT {
  const p = new DplaneT();
  for (let i = 0; i < 3; i++) p.normal[i] = view.getFloat32(offset + i * 4, true);
  p.dist = view.getFloat32(offset + 12, true);
  p.type = view.getInt32(offset + 16, true);
  return p;
}

export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SLIME = -4;
export const CONTENTS_LAVA = -5;
export const CONTENTS_SKY = -6;
export const CONTENTS_ORIGIN = -7; // removed at csg time
export const CONTENTS_CLIP = -8; // changed to contents_solid

export const CONTENTS_CURRENT_0 = -9;
export const CONTENTS_CURRENT_90 = -10;
export const CONTENTS_CURRENT_180 = -11;
export const CONTENTS_CURRENT_270 = -12;
export const CONTENTS_CURRENT_UP = -13;
export const CONTENTS_CURRENT_DOWN = -14;

// !!! if this is changed, it must be changed in asm_i386.h too !!!
export class DnodeT {
  planenum = 0;
  children: Int16Array = new Int16Array(2); // negative numbers are -(leafs+1), not nodes
  mins: Int16Array = new Int16Array(3); // for sphere culling
  maxs: Int16Array = new Int16Array(3);
  firstface = 0;
  numfaces = 0; // counting both sides
}
export const DNODE_T_SIZE = 24;

export function readDnode(view: DataView, offset: number): DnodeT {
  const n = new DnodeT();
  n.planenum = view.getInt32(offset, true);
  for (let i = 0; i < 2; i++) n.children[i] = view.getInt16(offset + 4 + i * 2, true);
  for (let i = 0; i < 3; i++) n.mins[i] = view.getInt16(offset + 8 + i * 2, true);
  for (let i = 0; i < 3; i++) n.maxs[i] = view.getInt16(offset + 14 + i * 2, true);
  n.firstface = view.getUint16(offset + 20, true);
  n.numfaces = view.getUint16(offset + 22, true);
  return n;
}

export class DclipnodeT {
  planenum = 0;
  children: Int16Array = new Int16Array(2); // negative numbers are contents
}
export const DCLIPNODE_T_SIZE = 8;

export function readDclipnode(view: DataView, offset: number): DclipnodeT {
  const n = new DclipnodeT();
  n.planenum = view.getInt32(offset, true);
  for (let i = 0; i < 2; i++) n.children[i] = view.getInt16(offset + 4 + i * 2, true);
  return n;
}

export class TexinfoT {
  vecs: [Float32Array, Float32Array] = [new Float32Array(4), new Float32Array(4)]; // [s/t][xyz offset]
  miptex = 0;
  flags = 0;
}
export const TEXINFO_T_SIZE = 40;

export function readTexinfo(view: DataView, offset: number): TexinfoT {
  const t = new TexinfoT();
  for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) t.vecs[i][j] = view.getFloat32(offset + (i * 4 + j) * 4, true);
  t.miptex = view.getInt32(offset + 32, true);
  t.flags = view.getInt32(offset + 36, true);
  return t;
}

export const TEX_SPECIAL = 1; // sky or slime, no lightmap or 256 subdivision

// note that edge 0 is never used, because negative edge nums are used for
// counterclockwise use of the edge in a face
export class DedgeT {
  v: Uint16Array = new Uint16Array(2); // vertex numbers
}
export const DEDGE_T_SIZE = 4;

export function readDedge(view: DataView, offset: number): DedgeT {
  const e = new DedgeT();
  for (let i = 0; i < 2; i++) e.v[i] = view.getUint16(offset + i * 2, true);
  return e;
}

export const MAXLIGHTMAPS = 4;

export class DfaceT {
  planenum = 0;
  side = 0;

  firstedge = 0; // we must support > 64k edges
  numedges = 0;
  texinfo = 0;

  // lighting info
  styles: Uint8Array = new Uint8Array(MAXLIGHTMAPS);
  lightofs = 0; // start of [numstyles*surfsize] samples
}
export const DFACE_T_SIZE = 20;

export function readDface(view: DataView, offset: number): DfaceT {
  const f = new DfaceT();
  f.planenum = view.getInt16(offset, true);
  f.side = view.getInt16(offset + 2, true);
  f.firstedge = view.getInt32(offset + 4, true);
  f.numedges = view.getInt16(offset + 8, true);
  f.texinfo = view.getInt16(offset + 10, true);
  for (let i = 0; i < MAXLIGHTMAPS; i++) f.styles[i] = view.getUint8(offset + 12 + i);
  f.lightofs = view.getInt32(offset + 16, true);
  return f;
}

export const AMBIENT_WATER = 0;
export const AMBIENT_SKY = 1;
export const AMBIENT_SLIME = 2;
export const AMBIENT_LAVA = 3;

export const NUM_AMBIENTS = 4; // automatic ambient sounds

// leaf 0 is the generic CONTENTS_SOLID leaf, used for all solid areas
// all other leafs need visibility info
export class DleafT {
  contents = 0;
  visofs = 0; // -1 = no visibility info

  mins: Int16Array = new Int16Array(3); // for frustum culling
  maxs: Int16Array = new Int16Array(3);

  firstmarksurface = 0;
  nummarksurfaces = 0;

  ambient_level: Uint8Array = new Uint8Array(NUM_AMBIENTS);
}
export const DLEAF_T_SIZE = 28;

export function readDleaf(view: DataView, offset: number): DleafT {
  const l = new DleafT();
  l.contents = view.getInt32(offset, true);
  l.visofs = view.getInt32(offset + 4, true);
  for (let i = 0; i < 3; i++) l.mins[i] = view.getInt16(offset + 8 + i * 2, true);
  for (let i = 0; i < 3; i++) l.maxs[i] = view.getInt16(offset + 14 + i * 2, true);
  l.firstmarksurface = view.getUint16(offset + 20, true);
  l.nummarksurfaces = view.getUint16(offset + 22, true);
  for (let i = 0; i < NUM_AMBIENTS; i++) l.ambient_level[i] = view.getUint8(offset + 24 + i);
  return l;
}
