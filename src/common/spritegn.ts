/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/spritegn.h (GNU GPL v2 or later).

spritegn.h: header file for sprite generation program

// **********************************************************
// * This file must be identical in the spritegen directory *
// * and in the Quake directory, because it's used to       *
// * pass data from one to the other via .spr files.        *
// **********************************************************

//-------------------------------------------------------
// This program generates .spr sprite package files.
// The format of the files is as follows:
//
// dsprite_t file header structure
// <repeat dsprite_t.numframes times>
//   <if spritegroup, repeat dspritegroup_t.numframes times>
//     dspriteframe_t frame header structure
//     sprite bitmap
//   <else (single sprite frame)>
//     dspriteframe_t frame header structure
//     sprite bitmap
// <endrepeat>
//-------------------------------------------------------

Same class + `*_T_SIZE` + `read*(view, offset)` convention as bspfile.ts;
little-endian only.

Deviations from the C source:
- The `#ifdef INCLUDELIBS` block is the spritegen tool's include list; dropped.
- `synctype_t` is declared identically here and in modelgen.h under a shared
  `SYNCTYPE_T` include guard; modelgen.ts holds the one declaration and it is
  re-exported here so this module still exports what spritegn.h exported.
*/

import { SynctypeT } from "./modelgen";

export { SynctypeT };

export const SPRITE_VERSION = 1;

// TODO: shorten these?
export class DspriteT {
  ident = 0;
  version = 0;
  type = 0;
  boundingradius = 0;
  width = 0;
  height = 0;
  numframes = 0;
  beamlength = 0;
  synctype: SynctypeT = SynctypeT.ST_SYNC;
}
export const DSPRITE_T_SIZE = 36;

export function readDsprite(view: DataView, offset: number): DspriteT {
  const s = new DspriteT();
  s.ident = view.getInt32(offset, true);
  s.version = view.getInt32(offset + 4, true);
  s.type = view.getInt32(offset + 8, true);
  s.boundingradius = view.getFloat32(offset + 12, true);
  s.width = view.getInt32(offset + 16, true);
  s.height = view.getInt32(offset + 20, true);
  s.numframes = view.getInt32(offset + 24, true);
  s.beamlength = view.getFloat32(offset + 28, true);
  s.synctype = view.getInt32(offset + 32, true);
  return s;
}

export const SPR_VP_PARALLEL_UPRIGHT = 0;
export const SPR_FACING_UPRIGHT = 1;
export const SPR_VP_PARALLEL = 2;
export const SPR_ORIENTED = 3;
export const SPR_VP_PARALLEL_ORIENTED = 4;

export class DspriteframeT {
  origin: Int32Array = new Int32Array(2);
  width = 0;
  height = 0;
}
export const DSPRITEFRAME_T_SIZE = 16;

export function readDspriteframe(view: DataView, offset: number): DspriteframeT {
  const f = new DspriteframeT();
  for (let i = 0; i < 2; i++) f.origin[i] = view.getInt32(offset + i * 4, true);
  f.width = view.getInt32(offset + 8, true);
  f.height = view.getInt32(offset + 12, true);
  return f;
}

export class DspritegroupT {
  numframes = 0;
}
export const DSPRITEGROUP_T_SIZE = 4;

export function readDspritegroup(view: DataView, offset: number): DspritegroupT {
  const g = new DspritegroupT();
  g.numframes = view.getInt32(offset, true);
  return g;
}

export class DspriteintervalT {
  interval = 0;
}
export const DSPRITEINTERVAL_T_SIZE = 4;

export function readDspriteinterval(view: DataView, offset: number): DspriteintervalT {
  const i = new DspriteintervalT();
  i.interval = view.getFloat32(offset, true);
  return i;
}

export enum SpriteframetypeT {
  SPR_SINGLE = 0,
  SPR_GROUP = 1,
}

export class DspriteframetypeT {
  type: SpriteframetypeT = SpriteframetypeT.SPR_SINGLE;
}
export const DSPRITEFRAMETYPE_T_SIZE = 4;

export function readDspriteframetype(view: DataView, offset: number): DspriteframetypeT {
  const t = new DspriteframetypeT();
  t.type = view.getInt32(offset, true);
  return t;
}

// little-endian "IDSP"
export const IDSPRITEHEADER = ("P".charCodeAt(0) << 24) + ("S".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);
