// Test helper: builds a synthetic PACK-format .pak file (WinQuake/common.c's
// dpackheader_t/dpackfile_t) in memory, and optionally writes it to disk
// under a scratch directory. Not a ported C file -- test infrastructure only.

import { mkdirSync, writeFileSync } from "node:fs";

const DPACKFILE_NAME_LEN = 56;
const DPACKFILE_SIZE = DPACKFILE_NAME_LEN + 4 + 4; // name[56] + filepos + filelen
const DPACKHEADER_SIZE = 12; // id[4] + dirofs + dirlen

export interface PakEntrySpec {
  name: string; // path inside the pak, e.g. "progs/knight.mdl" (< 56 bytes)
  data: Uint8Array;
}

export interface BuiltPakEntry {
  name: string;
  filepos: number;
  filelen: number;
}

export interface BuiltPak {
  bytes: Uint8Array;
  entries: BuiltPakEntry[];
}

// Builds a well-formed pak: "PACK" header, file bytes back to back, then a
// directory of 64-byte dpackfile_t records at the end.
export function buildPak(entries: PakEntrySpec[]): BuiltPak {
  let dataSize = 0;
  for (const e of entries) dataSize += e.data.length;

  const dirofs = DPACKHEADER_SIZE + dataSize;
  const dirlen = entries.length * DPACKFILE_SIZE;
  const total = dirofs + dirlen;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  bytes[0] = 0x50; // 'P'
  bytes[1] = 0x41; // 'A'
  bytes[2] = 0x43; // 'C'
  bytes[3] = 0x4b; // 'K'
  view.setInt32(4, dirofs, true);
  view.setInt32(8, dirlen, true);

  const built: BuiltPakEntry[] = [];
  let pos = DPACKHEADER_SIZE;
  for (const e of entries) {
    bytes.set(e.data, pos);
    built.push({ name: e.name, filepos: pos, filelen: e.data.length });
    pos += e.data.length;
  }

  let dirPos = dirofs;
  for (const rec of built) {
    for (let i = 0; i < DPACKFILE_NAME_LEN; i++) bytes[dirPos + i] = 0;
    for (let i = 0; i < rec.name.length && i < DPACKFILE_NAME_LEN - 1; i++) {
      bytes[dirPos + i] = rec.name.charCodeAt(i) & 0xff;
    }
    view.setInt32(dirPos + DPACKFILE_NAME_LEN, rec.filepos, true);
    view.setInt32(dirPos + DPACKFILE_NAME_LEN + 4, rec.filelen, true);
    dirPos += DPACKFILE_SIZE;
  }

  return { bytes, entries: built };
}

// Builds a pak and writes it to `path` (parent directory must already exist,
// see ensureDir below).
export function writePakToDisk(path: string, entries: PakEntrySpec[]): BuiltPak {
  const built = buildPak(entries);
  writeFileSync(path, built.bytes);
  return built;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
