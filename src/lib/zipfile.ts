// Lifted from quake-2-re-ts src/qcommon/zipfile.ts at 7e88015 (GPLv2, our
// own repo). Game-agnostic as-is: the original file had no engine imports
// at all. The only change made here is swapping the three raw `throw new
// Error(...)` sites in extractEntry for src/lib/errors.ts's ZipFormatError,
// per this project's src/lib convention (a file under src/lib imports
// nothing from src/ outside src/lib; ZipFormatError gives callers a typed
// error to catch instead of matching on message text). No other behavior
// change.
//
// zipfile.ts -- minimal ZIP central-directory reader for KEX/rerelease .kpf
// archives (Q2Game.kpf in the original comment; here, Quake 1's
// QuakeEX.kpf).
//
// Not a port of any single upstream .c file: q2repro's KPF support
// (src/common/files.c:3676 add_game_kpf, guarded by #if USE_ZLIB) calls
// into a full libzip-backed load_zip_file() that this project does not
// carry over. This module is a from-scratch, dependency-free ZIP reader
// (central directory + local file header parsing, STORE and DEFLATE
// methods only) sized to what a KEX .kpf actually needs: DEFLATE (method
// 8) is implemented via node:zlib's inflateRawSync (raw deflate -- the
// format ZIP entries use, no zlib/gzip wrapper), since PORTING.md's "no
// external deps" rule rules out pulling in a general-purpose unzip package.
//
// No ZIP64 support: the end-of-central-directory record's 32-bit fields
// (entry count, central directory size/offset) are trusted as-is. A real
// ZIP64 archive is reported as a parse failure (null) rather than silently
// misread.

import * as zlib from "node:zlib";

import { ZipFormatError } from "./errors";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_DIR_FIXED_SIZE = 46;
const LOCAL_FILE_FIXED_SIZE = 30;

// The EOCD record can be followed by a variable-length archive comment (up
// to 65535 bytes), so it isn't necessarily the last 22 bytes of the file --
// scan backwards for the signature within the maximum possible comment
// length instead of assuming a fixed offset.
const MAX_COMMENT_LENGTH = 0xffff;

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

export interface ZipEntryT {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/*
====================
findEndOfCentralDirectory

Scans backwards from the end of the buffer for the EOCD signature, and
returns the byte offset it was found at, or null if the buffer isn't a
valid (non-ZIP64) ZIP archive.
====================
*/
export function findEndOfCentralDirectory(buf: Uint8Array): number | null {
  if (buf.length < EOCD_MIN_SIZE) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);

  for (let pos = buf.length - EOCD_MIN_SIZE; pos >= searchStart; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIGNATURE) return pos;
  }

  return null;
}

interface EndOfCentralDirectoryT {
  readonly entryCount: number;
  readonly centralDirSize: number;
  readonly centralDirOffset: number;
}

function parseEndOfCentralDirectory(buf: Uint8Array, eocdOffset: number): EndOfCentralDirectoryT | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  // ZIP64 sentinel values -- not supported (see module header comment).
  if (entryCount === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    return null;
  }

  return { entryCount, centralDirSize, centralDirOffset };
}

/*
====================
parseCentralDirectory

Reads `eocd.entryCount` consecutive central directory file headers starting
at `eocd.centralDirOffset`, returning one ZipEntryT per record. Returns null
if any record's signature doesn't match (corrupt/truncated archive) or runs
past the buffer.
====================
*/
export function parseCentralDirectory(buf: Uint8Array, eocdOffset: number): ZipEntryT[] | null {
  const eocd = parseEndOfCentralDirectory(buf, eocdOffset);
  if (!eocd) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries: ZipEntryT[] = [];

  let pos = eocd.centralDirOffset;
  for (let i = 0; i < eocd.entryCount; i++) {
    if (pos + CENTRAL_DIR_FIXED_SIZE > buf.length) return null;
    if (view.getUint32(pos, true) !== CENTRAL_DIR_SIGNATURE) return null;

    const method = view.getUint16(pos + 10, true);
    const crc32 = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const nameStart = pos + CENTRAL_DIR_FIXED_SIZE;
    if (nameStart + nameLength > buf.length) return null;
    const name = new TextDecoder().decode(buf.subarray(nameStart, nameStart + nameLength));

    entries.push({ name, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });

    pos = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

/*
====================
extractEntry

Decompresses a single ZIP entry's payload, locating the actual compressed
data by re-reading that entry's local file header (its filename/extra-field
lengths can differ from the central directory copy, so the data offset
can't be derived from the central directory record alone).
====================
*/
export function extractEntry(buf: Uint8Array, entry: ZipEntryT): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pos = entry.localHeaderOffset;

  if (pos + LOCAL_FILE_FIXED_SIZE > buf.length) {
    throw new ZipFormatError(`zipfile: local header for '${entry.name}' runs past end of archive`);
  }
  if (view.getUint32(pos, true) !== LOCAL_FILE_SIGNATURE) {
    throw new ZipFormatError(`zipfile: bad local file header signature for '${entry.name}'`);
  }

  const nameLength = view.getUint16(pos + 26, true);
  const extraLength = view.getUint16(pos + 28, true);
  const dataStart = pos + LOCAL_FILE_FIXED_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > buf.length) {
    throw new ZipFormatError(`zipfile: compressed data for '${entry.name}' runs past end of archive`);
  }

  const compressed = buf.subarray(dataStart, dataEnd);

  if (entry.method === ZIP_METHOD_STORE) {
    return compressed.slice();
  }
  if (entry.method === ZIP_METHOD_DEFLATE) {
    // ZIP's DEFLATE entries are raw deflate streams (no zlib/gzip header or
    // trailer) -- node:zlib's inflateRawSync is the exact counterpart.
    // (quake-2-re-ts's original used a lazy `require("node:zlib")` here;
    // this project's own convention is a plain top-level ESM import of
    // node built-ins -- see e.g. src/common/common.ts -- which also avoids
    // the `as typeof import(...)` cast that `require`'s return type would
    // otherwise need, and this project's rule 2 bans `as` casts other than
    // `as const`.)
    return new Uint8Array(zlib.inflateRawSync(compressed));
  }

  throw new ZipFormatError(`zipfile: unsupported compression method ${entry.method} for '${entry.name}'`);
}

/*
====================
ZipArchive

Parses a whole ZIP file's central directory once at construction (the
buffer is retained for on-demand entry extraction). Entry name lookups are
case-insensitive, matching FS_FOpenFile's Q_strcasecmp comparison against
classic .pak directory entries.
====================
*/
export class ZipArchive {
  readonly entries: readonly ZipEntryT[];
  private readonly buf: Uint8Array;
  private readonly byNameLower: Map<string, ZipEntryT>;

  private constructor(buf: Uint8Array, entries: ZipEntryT[]) {
    this.buf = buf;
    this.entries = entries;
    this.byNameLower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  }

  static open(buf: Uint8Array): ZipArchive | null {
    const eocdOffset = findEndOfCentralDirectory(buf);
    if (eocdOffset === null) return null;

    const entries = parseCentralDirectory(buf, eocdOffset);
    if (!entries) return null;

    return new ZipArchive(buf, entries);
  }

  findEntry(name: string): ZipEntryT | null {
    return this.byNameLower.get(name.toLowerCase()) ?? null;
  }

  readFile(name: string): Uint8Array | null {
    const entry = this.findEntry(name);
    if (!entry) return null;
    return extractEntry(this.buf, entry);
  }
}
