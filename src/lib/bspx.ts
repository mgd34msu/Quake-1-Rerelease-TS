// Adapted from quake-2-re-ts src/qcommon/bspx.ts (GPLv2, our own repo), the
// `parseBspxDirectory` half only -- this project's BSPX need (U4, re-release
// map support) is just the lump directory itself (name -> byte range) plus
// recording which lump names are present; nothing here parses a specific
// lump's payload (DECOUPLED_LM/LIGHTGRID_OCTREE in the quake-2-re-ts original
// are Quake II KEX lumps this engine has no use for -- FACENORMALS/RGBLIGHTING/
// LMSHIFT/LMOFFSET/LMSTYLE/LIGHTING_E5BGR9/BRUSHLIST are Quake 1's own BSPX
// lumps and are later units' work per ARCHITECTURE.md's "Model loading"
// section).
//
// Per this project's src/lib convention (see zipfile.ts's header) a file
// under src/lib imports nothing from src/ outside src/lib -- the original's
// `Com_Printf` warnings on a malformed directory have no equivalent import
// available here, so they are dropped rather than routed through an import
// this file isn't allowed to take; a malformed BSPX directory or lump entry
// is silently skipped (returns null / omits that entry) exactly as the
// original's warned-and-continued path already did, just without the print.
//
// BSPX on-disk layout (no open GPLv2 reference implements it -- the three
// engines PORTING.md lists as references do not carry BSPX support; this is
// ported from quake-2-re-ts's own walker, which cites the published BSPX
// spec): after the last standard BSP lump's data, 4-byte aligned, a header
// (`"BSPX"` magic, then a uint32 lump count) followed by that many 24-byte-
// name + uint32-offset + uint32-length directory entries.

const BSPXHEADER = ("B".charCodeAt(0) | ("S".charCodeAt(0) << 8) | ("P".charCodeAt(0) << 16) | ("X".charCodeAt(0) << 24)) >>> 0;

const XLUMP_NAME_LEN = 24;
const XLUMP_T_SIZE = XLUMP_NAME_LEN + 4 + 4;

function alignUp4(pos: number): number {
  return (pos + 3) & ~3;
}

export interface BspxLumpT {
  readonly fileofs: number;
  readonly filelen: number;
}

export interface BspxDirectoryT {
  readonly lumps: ReadonlyMap<string, BspxLumpT>;
}

/*
====================
parseBspxDirectory

Locates and decodes the BSPX lump directory appended after a BSP file's
standard lump data. `searchPos` is the byte offset immediately following
the last standard lump's data (the caller aligns nothing -- this function
performs the same 4-byte alignment the original does).

Returns null if no BSPX header is present (the common case: most BSPs carry
no BSPX extension at all, which is not an error).
====================
*/
export function parseBspxDirectory(buf: Uint8Array, searchPos: number, filelen: number): BspxDirectoryT | null {
  const pos0 = alignUp4(searchPos);
  if (pos0 > filelen - 8) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(pos0, true) !== BSPXHEADER) return null;

  const numlumps = view.getUint32(pos0 + 4, true);
  let pos = pos0 + 8;

  if (numlumps > (filelen - pos) / XLUMP_T_SIZE) return null;

  const lumps = new Map<string, BspxLumpT>();
  const decoder = new TextDecoder();

  for (let i = 0; i < numlumps; i++, pos += XLUMP_T_SIZE) {
    const nameBytes = buf.subarray(pos, pos + XLUMP_NAME_LEN);
    let nameEnd = 0;
    while (nameEnd < XLUMP_NAME_LEN && nameBytes[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(nameBytes.subarray(0, nameEnd));

    const ofs = view.getUint32(pos + XLUMP_NAME_LEN, true);
    const len = view.getUint32(pos + XLUMP_NAME_LEN + 4, true);

    if (len === 0) continue; // ignore an empty lump
    if (ofs + len > filelen) continue; // ignore an out-of-bounds lump
    if (lumps.has(name)) continue; // ignore a duplicate name

    lumps.set(name, { fileofs: ofs, filelen: len });
  }

  return { lumps };
}
