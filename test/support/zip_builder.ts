// Test helper: builds a minimal, well-formed STORE-only ZIP archive in
// memory (and optionally writes it to disk), for exercising src/lib/
// zipfile.ts's ZipArchive reader and src/common/common.ts's "zip"
// search-path kind without needing a real QuakeEX.kpf on disk. Not a port
// of any C file -- test infrastructure only, per this unit's brief ("write
// a minimal stored-entry zip in the test" since src/lib/zipfile.ts has no
// writer of its own).
//
// Every entry is stored uncompressed (method 0): zipfile.ts's extractEntry
// never validates an entry's CRC32 (see that file's own header), so every
// CRC32 field below is left 0 and still reads back correctly.

import { mkdirSync, writeFileSync } from "node:fs";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_FILE_FIXED_SIZE = 30;
const CENTRAL_DIR_FIXED_SIZE = 46;
const EOCD_SIZE = 22;

export interface ZipEntrySpec {
  name: string; // e.g. "fonts/qfont.kfont"
  data: Uint8Array;
}

// Builds a STORE-only ZIP archive: one local file header + raw bytes per
// entry, followed by the central directory and the end-of-central-directory
// record.
export function buildZip(entries: ZipEntrySpec[]): Uint8Array {
  const nameBytes = entries.map((e) => new TextEncoder().encode(e.name));

  let localSize = 0;
  for (let i = 0; i < entries.length; i++) localSize += LOCAL_FILE_FIXED_SIZE + nameBytes[i].length + entries[i].data.length;

  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) centralSize += CENTRAL_DIR_FIXED_SIZE + nameBytes[i].length;

  const total = localSize + centralSize + EOCD_SIZE;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  const localHeaderOffsets: number[] = [];
  let pos = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = nameBytes[i];
    localHeaderOffsets.push(pos);

    view.setUint32(pos, LOCAL_FILE_SIGNATURE, true);
    view.setUint16(pos + 4, 20, true); // version needed
    view.setUint16(pos + 6, 0, true); // flags
    view.setUint16(pos + 8, 0, true); // method: STORE
    view.setUint16(pos + 10, 0, true); // mod time
    view.setUint16(pos + 12, 0, true); // mod date
    view.setUint32(pos + 14, 0, true); // crc32 (unchecked by the reader)
    view.setUint32(pos + 18, entry.data.length, true); // compressed size
    view.setUint32(pos + 22, entry.data.length, true); // uncompressed size
    view.setUint16(pos + 26, name.length, true);
    view.setUint16(pos + 28, 0, true); // extra length
    pos += LOCAL_FILE_FIXED_SIZE;

    bytes.set(name, pos);
    pos += name.length;
    bytes.set(entry.data, pos);
    pos += entry.data.length;
  }

  const centralDirOffset = pos;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = nameBytes[i];

    view.setUint32(pos, CENTRAL_DIR_SIGNATURE, true);
    view.setUint16(pos + 4, 20, true); // version made by
    view.setUint16(pos + 6, 20, true); // version needed
    view.setUint16(pos + 8, 0, true); // flags
    view.setUint16(pos + 10, 0, true); // method: STORE
    view.setUint16(pos + 12, 0, true); // mod time
    view.setUint16(pos + 14, 0, true); // mod date
    view.setUint32(pos + 16, 0, true); // crc32
    view.setUint32(pos + 20, entry.data.length, true); // compressed size
    view.setUint32(pos + 24, entry.data.length, true); // uncompressed size
    view.setUint16(pos + 28, name.length, true);
    view.setUint16(pos + 30, 0, true); // extra length
    view.setUint16(pos + 32, 0, true); // comment length
    view.setUint16(pos + 34, 0, true); // disk number start
    view.setUint16(pos + 36, 0, true); // internal attrs
    view.setUint32(pos + 38, 0, true); // external attrs
    view.setUint32(pos + 42, localHeaderOffsets[i], true);
    pos += CENTRAL_DIR_FIXED_SIZE;

    bytes.set(name, pos);
    pos += name.length;
  }

  const centralDirSize = pos - centralDirOffset;

  view.setUint32(pos, EOCD_SIGNATURE, true);
  view.setUint16(pos + 4, 0, true); // disk number
  view.setUint16(pos + 6, 0, true); // disk with central dir
  view.setUint16(pos + 8, entries.length, true); // entries on this disk
  view.setUint16(pos + 10, entries.length, true); // total entries
  view.setUint32(pos + 12, centralDirSize, true);
  view.setUint32(pos + 16, centralDirOffset, true);
  view.setUint16(pos + 20, 0, true); // comment length

  return bytes;
}

export function writeZipToDisk(path: string, entries: ZipEntrySpec[]): Uint8Array {
  const bytes = buildZip(entries);
  writeFileSync(path, bytes);
  return bytes;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
