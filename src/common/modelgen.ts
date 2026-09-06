/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/modelgen.h (GNU GPL v2 or later).

modelgen.h: header file for model generation program

// *********************************************************
// * This file must be identical in the modelgen directory *
// * and in the Quake directory, because it's used to      *
// * pass data from one to the other via model files.      *
// *********************************************************

Same class + `*_T_SIZE` + `read*(view, offset)` convention as bspfile.ts;
little-endian only.

Deviations from the C source:
- The `#ifdef INCLUDELIBS` block is the modelgen tool's include list; dropped.
- `synctype_t` is declared identically in modelgen.h and spritegn.h under a
  shared `SYNCTYPE_T` include guard, so exactly one of the two can win. It is
  declared here and re-exported by spritegn.ts.
- The trailing struct headers (`daliasframetype_t`, `daliasskintype_t`,
  `daliasgroup_t`, ...) are single-field headers the loader reads in sequence
  from the model file; each still gets its own class, size and reader so the
  loader can walk the file the way alias model loading does in the C.
*/

import type { Vec3 } from "./mathlib";

export const ALIAS_VERSION = 6;

export const ALIAS_ONSEAM = 0x0020;

// must match definition in spritegn.h
export enum SynctypeT {
  ST_SYNC = 0,
  ST_RAND = 1,
}

export enum AliasframetypeT {
  ALIAS_SINGLE = 0,
  ALIAS_GROUP = 1,
}

export enum AliasskintypeT {
  ALIAS_SKIN_SINGLE = 0,
  ALIAS_SKIN_GROUP = 1,
}

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

export class MdlT {
  ident = 0;
  version = 0;
  scale: Vec3 = new Float32Array(3);
  scale_origin: Vec3 = new Float32Array(3);
  boundingradius = 0;
  eyeposition: Vec3 = new Float32Array(3);
  numskins = 0;
  skinwidth = 0;
  skinheight = 0;
  numverts = 0;
  numtris = 0;
  numframes = 0;
  synctype: SynctypeT = SynctypeT.ST_SYNC;
  flags = 0;
  size = 0;
}
export const MDL_T_SIZE = 84;

export function readMdl(view: DataView, offset: number): MdlT {
  const m = new MdlT();
  m.ident = view.getInt32(offset, true);
  m.version = view.getInt32(offset + 4, true);
  for (let i = 0; i < 3; i++) m.scale[i] = view.getFloat32(offset + 8 + i * 4, true);
  for (let i = 0; i < 3; i++) m.scale_origin[i] = view.getFloat32(offset + 20 + i * 4, true);
  m.boundingradius = view.getFloat32(offset + 32, true);
  for (let i = 0; i < 3; i++) m.eyeposition[i] = view.getFloat32(offset + 36 + i * 4, true);
  m.numskins = view.getInt32(offset + 48, true);
  m.skinwidth = view.getInt32(offset + 52, true);
  m.skinheight = view.getInt32(offset + 56, true);
  m.numverts = view.getInt32(offset + 60, true);
  m.numtris = view.getInt32(offset + 64, true);
  m.numframes = view.getInt32(offset + 68, true);
  m.synctype = view.getInt32(offset + 72, true);
  m.flags = view.getInt32(offset + 76, true);
  m.size = view.getFloat32(offset + 80, true);
  return m;
}

// TODO: could be shorts

export class StvertT {
  onseam = 0;
  s = 0;
  t = 0;
}
export const STVERT_T_SIZE = 12;

export function readStvert(view: DataView, offset: number): StvertT {
  const v = new StvertT();
  v.onseam = view.getInt32(offset, true);
  v.s = view.getInt32(offset + 4, true);
  v.t = view.getInt32(offset + 8, true);
  return v;
}

export class DtriangleT {
  facesfront = 0;
  vertindex: Int32Array = new Int32Array(3);
}
export const DTRIANGLE_T_SIZE = 16;

export function readDtriangle(view: DataView, offset: number): DtriangleT {
  const t = new DtriangleT();
  t.facesfront = view.getInt32(offset, true);
  for (let i = 0; i < 3; i++) t.vertindex[i] = view.getInt32(offset + 4 + i * 4, true);
  return t;
}

export const DT_FACES_FRONT = 0x0010;

// This mirrors trivert_t in trilib.h, is present so Quake knows how to
// load this data

export class TrivertxT {
  v: Uint8Array = new Uint8Array(3);
  lightnormalindex = 0;
}
export const TRIVERTX_T_SIZE = 4;

export function readTrivertx(view: DataView, offset: number): TrivertxT {
  const t = new TrivertxT();
  for (let i = 0; i < 3; i++) t.v[i] = view.getUint8(offset + i);
  t.lightnormalindex = view.getUint8(offset + 3);
  return t;
}

export class DaliasframeT {
  bboxmin: TrivertxT = new TrivertxT(); // lightnormal isn't used
  bboxmax: TrivertxT = new TrivertxT(); // lightnormal isn't used
  name = ""; // frame name from grabbing
}
export const DALIASFRAME_T_SIZE = 24;

export function readDaliasframe(view: DataView, offset: number): DaliasframeT {
  const f = new DaliasframeT();
  f.bboxmin = readTrivertx(view, offset);
  f.bboxmax = readTrivertx(view, offset + TRIVERTX_T_SIZE);
  f.name = readCString(view, offset + 2 * TRIVERTX_T_SIZE, 16);
  return f;
}

export class DaliasgroupT {
  numframes = 0;
  bboxmin: TrivertxT = new TrivertxT(); // lightnormal isn't used
  bboxmax: TrivertxT = new TrivertxT(); // lightnormal isn't used
}
export const DALIASGROUP_T_SIZE = 12;

export function readDaliasgroup(view: DataView, offset: number): DaliasgroupT {
  const g = new DaliasgroupT();
  g.numframes = view.getInt32(offset, true);
  g.bboxmin = readTrivertx(view, offset + 4);
  g.bboxmax = readTrivertx(view, offset + 4 + TRIVERTX_T_SIZE);
  return g;
}

export class DaliasskingroupT {
  numskins = 0;
}
export const DALIASSKINGROUP_T_SIZE = 4;

export function readDaliasskingroup(view: DataView, offset: number): DaliasskingroupT {
  const g = new DaliasskingroupT();
  g.numskins = view.getInt32(offset, true);
  return g;
}

export class DaliasintervalT {
  interval = 0;
}
export const DALIASINTERVAL_T_SIZE = 4;

export function readDaliasinterval(view: DataView, offset: number): DaliasintervalT {
  const i = new DaliasintervalT();
  i.interval = view.getFloat32(offset, true);
  return i;
}

export class DaliasskinintervalT {
  interval = 0;
}
export const DALIASSKININTERVAL_T_SIZE = 4;

export function readDaliasskininterval(view: DataView, offset: number): DaliasskinintervalT {
  const i = new DaliasskinintervalT();
  i.interval = view.getFloat32(offset, true);
  return i;
}

export class DaliasframetypeT {
  type: AliasframetypeT = AliasframetypeT.ALIAS_SINGLE;
}
export const DALIASFRAMETYPE_T_SIZE = 4;

export function readDaliasframetype(view: DataView, offset: number): DaliasframetypeT {
  const t = new DaliasframetypeT();
  t.type = view.getInt32(offset, true);
  return t;
}

export class DaliasskintypeT {
  type: AliasskintypeT = AliasskintypeT.ALIAS_SKIN_SINGLE;
}
export const DALIASSKINTYPE_T_SIZE = 4;

export function readDaliasskintype(view: DataView, offset: number): DaliasskintypeT {
  const t = new DaliasskintypeT();
  t.type = view.getInt32(offset, true);
  return t;
}

// little-endian "IDPO"
export const IDPOLYHEADER = ("O".charCodeAt(0) << 24) + ("P".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);
