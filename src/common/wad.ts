/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/wad.h and WinQuake/wad.c (GNU GPL v2 or later).

WAD2 lump-file loader. Follows the on-disk struct pattern established by
bspfile.ts: `class WadinfoT`/`LumpinfoT` + `*_T_SIZE` (== the C sizeof) +
`read*(view, offset)`.

Deviations from the C:
- `qpic_t` is declared with a flexible array member (`byte data[4]`, actually
  variably sized: `width*height` bytes follow the 8-byte header, one byte per
  8-bit palette index -- confirmed by draw.c, which uses `rowbytes =
  pic->width` and copies `pic->width` bytes per scanline). `QpicT.data` is a
  `subarray` view over those bytes, not a copy.
- `W_GetLumpName`'s C return type is `void *`; every caller (draw.c) casts it
  to `qpic_t *`. This port keeps `W_GetLumpName` returning the raw
  `Uint8Array` lump bytes (the RULING in this unit's brief) and adds
  `W_GetQpic(name)`, which is that cast: it reads the qpic header out of the
  bytes `W_GetLumpName` returns and builds a `QpicT`. `W_GetQpic` is the
  port's addition, not present in wad.h/wad.c.
- `SwapPic` no longer mutates a `qpic_t *` in place (TS has no aliasable
  struct pointer): it takes the raw lump bytes and returns a `QpicT` with the
  (identity, since this port only targets little-endian hosts) `LittleLong`
  swap applied to width/height. `W_LoadWadFromBytes` still calls it once per
  TYP_QPIC lump during load, exactly where the C does, purely for fidelity --
  the C's call is itself a byte-order no-op on a little-endian host, and so
  is this one; the result is discarded there, same as the C's in-place swap
  produces no visible change on this port's target. `W_GetQpic` uses it to
  build the pic it returns.
- `W_CleanupName` returns a new string instead of writing through an `out`
  pointer; per this unit's RULING it keeps the C's algorithm (lowercase,
  stop at the first NUL, 16-char limit) and drops the zero-padding tail: a JS
  string that stops where the C's NUL-terminated buffer would makes the
  trailing zero bytes observationally irrelevant (every comparison the C
  makes is `strcmp`, which also stops at the first NUL).
- `wad_numlumps`/`wad_lumps`/`wad_base` stay module-private (not exported),
  matching this unit's RULING; the C declares them `extern` only so
  gl_draw.c/gl_rmisc.c can also read them directly, which this port's
  renderer seam does not need.
- `W_LoadWadFile` calls `COM_LoadHunkFile` (common.ts, unit U003, concurrent
  with this one, not landed yet) and is ruled to return `Uint8Array | null`
  with a trailing NUL byte appended, matching `COM_LoadFile`'s `"\0"` pad in
  the C, and to set `com_filesize` as a side effect the way the C global is
  set; wad.c itself never reads `com_filesize`, so this module does not
  import it. `W_LoadWadFile`'s body after the null check (RULING: split out
  as `W_LoadWadFromBytes(name, bytes)`, exported so tests can drive it
  without a real file) is exactly the C's parse loop.
- Names are decoded/encoded Latin-1 (`charCodeAt(i) & 0xff` /
  `String.fromCharCode`), never UTF-8, matching every other on-disk-string
  reader in this port.
*/

import { Sys_Error } from "../platform/sys";
import { COM_LoadHunkFile } from "./common";

//===============
//   TYPES
//===============

export const CMP_NONE = 0;
export const CMP_LZSS = 1;

export const TYP_NONE = 0;
export const TYP_LABEL = 1;

export const TYP_LUMPY = 64; // 64 + grab command number
export const TYP_PALETTE = 64;
export const TYP_QTEX = 65;
export const TYP_QPIC = 66;
export const TYP_SOUND = 67;
export const TYP_MIPTEX = 68;

export class QpicT {
  width = 0;
  height = 0;
  data: Uint8Array = new Uint8Array(0); // variably sized in the C (byte data[4]); the width*height pixel bytes following the 8-byte header
}

export class WadinfoT {
  identification = ""; // should be WAD2 or 2DAW
  numlumps = 0;
  infotableofs = 0;
}
export const WADINFO_T_SIZE = 12;

export class LumpinfoT {
  filepos = 0;
  disksize = 0;
  size = 0; // uncompressed
  type = 0;
  compression = 0;
  pad1 = 0;
  pad2 = 0;
  name = ""; // must be null terminated
}
export const LUMPINFO_T_SIZE = 32;

// reads up to maxLen bytes starting at offset, stopping at the first NUL --
// same convention as bspfile.ts's readCString, kept as a private copy here
// since the two modules have no other shared dependency in the C.
function readCString(view: DataView, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function readWadinfo(view: DataView, offset: number): WadinfoT {
  const w = new WadinfoT();
  w.identification = readCString(view, offset, 4);
  w.numlumps = view.getInt32(offset + 4, true);
  w.infotableofs = view.getInt32(offset + 8, true);
  return w;
}

export function readLumpinfo(view: DataView, offset: number): LumpinfoT {
  const l = new LumpinfoT();
  l.filepos = view.getInt32(offset, true);
  l.disksize = view.getInt32(offset + 4, true);
  l.size = view.getInt32(offset + 8, true);
  l.type = view.getInt8(offset + 12);
  l.compression = view.getInt8(offset + 13);
  l.pad1 = view.getInt8(offset + 14);
  l.pad2 = view.getInt8(offset + 15);
  l.name = readCString(view, offset + 16, 16);
  return l;
}

let wad_numlumps = 0;
let wad_lumps: LumpinfoT[] = [];
let wad_base: Uint8Array = new Uint8Array(0);

/*
==================
W_CleanupName

Lowercases name and pads with spaces and a terminating 0 to the length of
lumpinfo_t->name.
Used so lumpname lookups can proceed rapidly by comparing 4 chars at a time
Space padding is so names can be printed nicely in tables.
Can safely be performed in place.
==================
*/
export function W_CleanupName(inStr: string): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    const c = i < inStr.length ? inStr.charCodeAt(i) & 0xff : 0;
    if (!c) break;

    if (c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + (0x61 - 0x41));
    // 'A'-'Z' -> 'a'-'z'
    else out += String.fromCharCode(c);
  }

  return out;
}

/*
====================
W_LoadWadFile
====================
*/
export function W_LoadWadFile(filename: string): void {
  const data = COM_LoadHunkFile(filename);
  if (!data) return Sys_Error("W_LoadWadFile: couldn't load %s", filename);

  W_LoadWadFromBytes(filename, data);
}

// The C body of W_LoadWadFile after the load and null check. Split out
// (this unit's RULING) so tests can exercise the WAD2 parser without a real
// COM_LoadHunkFile / search-path setup.
export function W_LoadWadFromBytes(filename: string, bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    view.getUint8(0) !== "W".charCodeAt(0) ||
    view.getUint8(1) !== "A".charCodeAt(0) ||
    view.getUint8(2) !== "D".charCodeAt(0) ||
    view.getUint8(3) !== "2".charCodeAt(0)
  ) {
    return Sys_Error("Wad file %s doesn't have WAD2 id\n", filename);
  }

  const header = readWadinfo(view, 0);

  wad_base = bytes;
  wad_numlumps = header.numlumps; // LittleLong(header->numlumps) -- identity on little-endian
  const infotableofs = header.infotableofs; // LittleLong(header->infotableofs) -- identity on little-endian

  wad_lumps = [];
  for (let i = 0; i < wad_numlumps; i++) {
    const lump_p = readLumpinfo(view, infotableofs + i * LUMPINFO_T_SIZE);
    // lump_p->filepos/size are LittleLong'd in the C; identity on little-endian, already read that way above.
    lump_p.name = W_CleanupName(lump_p.name);
    if (lump_p.type === TYP_QPIC) SwapPic(wad_base.subarray(lump_p.filepos));
    wad_lumps.push(lump_p);
  }
}

/*
=============
W_GetLumpinfo
=============
*/
export function W_GetLumpinfo(name: string): LumpinfoT {
  const clean = W_CleanupName(name);

  for (let i = 0; i < wad_numlumps; i++) {
    const lump_p = wad_lumps[i];
    if (clean === lump_p.name) return lump_p;
  }

  return Sys_Error("W_GetLumpinfo: %s not found", name);
}

export function W_GetLumpName(name: string): Uint8Array {
  const lump = W_GetLumpinfo(name);

  return wad_base.subarray(lump.filepos, lump.filepos + lump.disksize);
}

export function W_GetLumpNum(num: number): Uint8Array {
  if (num < 0 || num > wad_numlumps) return Sys_Error("W_GetLumpNum: bad number: %i", num);

  const lump = wad_lumps[num];

  return wad_base.subarray(lump.filepos, lump.filepos + lump.disksize);
}

// draw.c's `qpic_t *pic = (qpic_t *)Draw_PicFromWad(name)` cast, made explicit
// (see this unit's RULING and the header note above): reads a qpic_t header
// out of the raw lump bytes W_GetLumpName returns.
export function W_GetQpic(name: string): QpicT {
  return SwapPic(W_GetLumpName(name));
}

/*
=============================================================================

automatic byte swapping

=============================================================================
*/

export function SwapPic(bytes: Uint8Array): QpicT {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pic = new QpicT();

  pic.width = view.getInt32(0, true); // LittleLong(pic->width) -- identity on little-endian
  pic.height = view.getInt32(4, true); // LittleLong(pic->height) -- identity on little-endian
  pic.data = bytes.subarray(8, 8 + pic.width * pic.height);

  return pic;
}
