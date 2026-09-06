// Test helper: reads a REAL PACK-format .pak file (WinQuake common.c's
// dpackheader_t/dpackfile_t: "PACK" + dirofs/dirlen int32, then a directory
// of 64-byte name[56]+filepos+filelen records) from disk, for test/lib_md5
// .test.ts's guarded retail-data tests. Not a ported C file -- test
// infrastructure only, read-only (this project has no shared pak reader yet
// -- see test/support/pak_builder.ts, which only ever BUILDS paks, never
// reads them, and test/lib_loc.test.ts's own inline PACK-reading code,
// written before this one existed and scoped to that single test file per
// the same "no shared reader" note). This is intentionally the minimal
// read-only counterpart: list every entry, or read one by name.

import { readFileSync } from "node:fs";

const DPACKFILE_NAME_LEN = 56;
const DPACKFILE_SIZE = DPACKFILE_NAME_LEN + 4 + 4; // name[56] + filepos + filelen

export interface PakEntry {
  name: string;
  filepos: number;
  filelen: number;
}

export interface OpenPak {
  data: Buffer;
  entries: PakEntry[];
}

/** Opens a PACK-format .pak and reads its directory. Throws if the file
 * doesn't start with the "PACK" magic. */
export function openPak(pakPath: string): OpenPak {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") throw new Error(`${pakPath}: not a PACK file`);

  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / DPACKFILE_SIZE;

  const entries: PakEntry[] = [];
  for (let i = 0; i < numEntries; i++) {
    const off = dirofs + i * DPACKFILE_SIZE;
    const rawName = data.toString("ascii", off, off + DPACKFILE_NAME_LEN);
    const name = rawName.slice(0, rawName.indexOf("\0") === -1 ? undefined : rawName.indexOf("\0"));
    const filepos = data.readInt32LE(off + DPACKFILE_NAME_LEN);
    const filelen = data.readInt32LE(off + DPACKFILE_NAME_LEN + 4);
    entries.push({ name, filepos, filelen });
  }

  return { data, entries };
}

/** Reads one named entry's bytes as UTF-8 text (MD5 files are always plain
 * ASCII text). Throws if the entry isn't present. */
export function readPakText(pak: OpenPak, name: string): string {
  const entry = pak.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`${name} not found in pak`);
  return new TextDecoder().decode(new Uint8Array(pak.data.buffer, pak.data.byteOffset + entry.filepos, entry.filelen));
}

/** Reads one named entry's raw bytes. Throws if the entry isn't present. */
export function readPakBytes(pak: OpenPak, name: string): Uint8Array {
  const entry = pak.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`${name} not found in pak`);
  return new Uint8Array(pak.data.buffer, pak.data.byteOffset + entry.filepos, entry.filelen);
}
