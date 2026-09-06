// Tests for src/lib/zipfile.ts (lifted from quake-2-re-ts src/qcommon/
// zipfile.ts at 7e88015 -- see that file's own header comment for the full
// format-support rationale). quake-2-re-ts's own tree has no dedicated
// zipfile.test.ts (only integration tests that mount a real retail .kpf,
// which this project doesn't have a Quake II equivalent of at all); this
// file is written fresh for the lift, self-sufficient per PORTING.md rule
// 13 -- every ZIP archive it needs is built by hand below, no game data.
//
// A guarded smoke test against the real Quake 1 re-release's QuakeEX.kpf
// lives in test/lib_kpf_smoke.test.ts, not here.

import { describe, test, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  findEndOfCentralDirectory,
  parseCentralDirectory,
  extractEntry,
  ZipArchive,
  ZIP_METHOD_STORE,
  ZIP_METHOD_DEFLATE,
  type ZipEntryT,
} from "../src/lib/zipfile";
import { ZipFormatError } from "../src/lib/errors";

// ---------------------------------------------------------------------------
// Minimal from-scratch ZIP writer -- builds a well-formed archive (local
// file headers + central directory + EOCD) byte-for-byte, the mirror image
// of zipfile.ts's own reader. CRC-32 fields are left as 0 throughout:
// zipfile.ts never validates them (it only stores the value from the
// central directory record), so a real CRC isn't needed to exercise any
// code path here.
// ---------------------------------------------------------------------------

interface ZipWriteEntry {
  name: string;
  data: Uint8Array;
  method: number; // ZIP_METHOD_STORE or ZIP_METHOD_DEFLATE
}

function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}
function nameBytes(name: string): number[] {
  return Array.from(name).map((c) => c.charCodeAt(0));
}

function buildZip(entries: ZipWriteEntry[], trailingComment: string = ""): Uint8Array {
  const localParts: number[] = [];
  const localOffsets: number[] = [];
  const payloads: Uint8Array[] = entries.map((e) => (e.method === ZIP_METHOD_DEFLATE ? deflateRawSync(e.data) : e.data));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const payload = payloads[i]!;
    localOffsets.push(localParts.length);
    const nb = nameBytes(e.name);
    localParts.push(
      0x50,
      0x4b,
      0x03,
      0x04, // local file header signature
      ...u16le(20), // version needed
      ...u16le(0), // flags
      ...u16le(e.method),
      ...u16le(0), // mod time
      ...u16le(0), // mod date
      ...u32le(0), // crc32 (unvalidated by the reader)
      ...u32le(payload.length), // compressed size
      ...u32le(e.data.length), // uncompressed size
      ...u16le(nb.length),
      ...u16le(0), // extra field length
      ...nb,
      ...Array.from(payload),
    );
  }

  const centralParts: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const payload = payloads[i]!;
    const nb = nameBytes(e.name);
    centralParts.push(
      0x50,
      0x4b,
      0x01,
      0x02, // central directory signature
      ...u16le(20), // version made by
      ...u16le(20), // version needed
      ...u16le(0), // flags
      ...u16le(e.method),
      ...u16le(0), // mod time
      ...u16le(0), // mod date
      ...u32le(0), // crc32
      ...u32le(payload.length),
      ...u32le(e.data.length),
      ...u16le(nb.length),
      ...u16le(0), // extra length
      ...u16le(0), // comment length
      ...u16le(0), // disk number start
      ...u16le(0), // internal attrs
      ...u32le(0), // external attrs
      ...u32le(localOffsets[i]!), // relative offset of local header
      ...nb,
    );
  }

  const centralDirOffset = localParts.length;
  const centralDirSize = centralParts.length;
  const commentBytes = nameBytes(trailingComment);

  const eocd = [
    0x50,
    0x4b,
    0x05,
    0x06, // EOCD signature
    ...u16le(0), // this disk
    ...u16le(0), // disk with central dir
    ...u16le(entries.length), // entries on this disk
    ...u16le(entries.length), // total entries
    ...u32le(centralDirSize),
    ...u32le(centralDirOffset),
    ...u16le(commentBytes.length),
    ...commentBytes,
  ];

  return new Uint8Array([...localParts, ...centralParts, ...eocd]);
}

const enc = new TextEncoder();

describe("zipfile.ts -- findEndOfCentralDirectory", () => {
  test("finds the EOCD signature at the end of a minimal archive", () => {
    const zip = buildZip([{ name: "a.txt", data: enc.encode("hello"), method: ZIP_METHOD_STORE }]);
    const offset = findEndOfCentralDirectory(zip);
    expect(offset).not.toBeNull();
    expect(zip[offset!]).toBe(0x50);
    expect(zip[offset! + 1]).toBe(0x4b);
    expect(zip[offset! + 2]).toBe(0x05);
    expect(zip[offset! + 3]).toBe(0x06);
  });

  test("still finds the EOCD when the archive carries a trailing comment", () => {
    const zip = buildZip([{ name: "a.txt", data: enc.encode("hello"), method: ZIP_METHOD_STORE }], "a trailing comment");
    const offset = findEndOfCentralDirectory(zip);
    expect(offset).not.toBeNull();
  });

  test("returns null for a buffer shorter than the minimum EOCD size", () => {
    expect(findEndOfCentralDirectory(new Uint8Array(10))).toBeNull();
  });

  test("returns null for a buffer with no EOCD signature anywhere", () => {
    expect(findEndOfCentralDirectory(new Uint8Array(64))).toBeNull();
  });
});

describe("zipfile.ts -- parseCentralDirectory / ZipArchive round-trip", () => {
  test("STORE entry: readFile returns the exact original bytes", () => {
    const data = enc.encode("the quick brown fox");
    const zip = buildZip([{ name: "store.txt", data, method: ZIP_METHOD_STORE }]);
    const archive = ZipArchive.open(zip);
    expect(archive).not.toBeNull();
    expect(archive!.entries.length).toBe(1);
    expect(archive!.entries[0]!.method).toBe(ZIP_METHOD_STORE);
    expect(archive!.readFile("store.txt")).toEqual(data);
  });

  test("DEFLATE entry: readFile inflates back to the exact original bytes", () => {
    // A repetitive payload so deflateRawSync actually produces a shorter
    // compressed stream than the source, proving inflateRawSync is doing
    // real work, not passing through an accidental STORE-equivalent.
    const data = enc.encode("abcdefgh".repeat(200));
    const zip = buildZip([{ name: "deflate.txt", data, method: ZIP_METHOD_DEFLATE }]);
    const archive = ZipArchive.open(zip);
    expect(archive).not.toBeNull();
    const entry = archive!.findEntry("deflate.txt");
    expect(entry).not.toBeNull();
    expect(entry!.method).toBe(ZIP_METHOD_DEFLATE);
    expect(entry!.compressedSize).toBeLessThan(data.length);
    expect(archive!.readFile("deflate.txt")).toEqual(data);
  });

  test("multiple entries: each name resolves to its own payload", () => {
    const dataA = enc.encode("first entry payload");
    const dataB = enc.encode("second entry payload, deflated".repeat(50));
    const zip = buildZip([
      { name: "dir/a.txt", data: dataA, method: ZIP_METHOD_STORE },
      { name: "dir/b.txt", data: dataB, method: ZIP_METHOD_DEFLATE },
    ]);
    const archive = ZipArchive.open(zip);
    expect(archive).not.toBeNull();
    expect(archive!.entries.length).toBe(2);
    expect(archive!.readFile("dir/a.txt")).toEqual(dataA);
    expect(archive!.readFile("dir/b.txt")).toEqual(dataB);
  });

  test("findEntry / readFile are case-insensitive, matching FS_FOpenFile's Q_strcasecmp convention", () => {
    const data = enc.encode("case insensitive lookup");
    const zip = buildZip([{ name: "Fonts/QFont.PNG", data, method: ZIP_METHOD_STORE }]);
    const archive = ZipArchive.open(zip);
    expect(archive).not.toBeNull();
    expect(archive!.findEntry("fonts/qfont.png")).not.toBeNull();
    expect(archive!.readFile("FONTS/QFONT.PNG")).toEqual(data);
  });

  test("findEntry / readFile return null for a name not present in the archive", () => {
    const zip = buildZip([{ name: "present.txt", data: enc.encode("x"), method: ZIP_METHOD_STORE }]);
    const archive = ZipArchive.open(zip);
    expect(archive).not.toBeNull();
    expect(archive!.findEntry("missing.txt")).toBeNull();
    expect(archive!.readFile("missing.txt")).toBeNull();
  });
});

describe("zipfile.ts -- ZipArchive.open on malformed input", () => {
  test("returns null for a buffer with no EOCD at all", () => {
    expect(ZipArchive.open(new Uint8Array(100))).toBeNull();
  });

  test("returns null when the EOCD's entry count claims more records than the archive actually has", () => {
    const zip = buildZip([{ name: "a.txt", data: enc.encode("hi"), method: ZIP_METHOD_STORE }]);
    // Corrupt the EOCD's entry-count field (bytes 10-11 of the 22-byte EOCD
    // record) to claim 5 entries when only 1 central directory record is
    // actually present: parseCentralDirectory reads that many consecutive
    // fixed-size records starting at the (correct) central directory
    // offset, so the phantom 2nd record either runs past the buffer or
    // lands on bytes with the wrong signature -- either way, null.
    const eocdOffset = findEndOfCentralDirectory(zip)!;
    const corrupted = zip.slice();
    const view = new DataView(corrupted.buffer);
    view.setUint16(eocdOffset + 10, 5, true);
    expect(ZipArchive.open(corrupted)).toBeNull();
  });
});

describe("zipfile.ts -- extractEntry error paths (ZipFormatError)", () => {
  function singleEntryArchive(method: number, data: Uint8Array): { zip: Uint8Array; entry: ZipEntryT } {
    const zip = buildZip([{ name: "e.bin", data, method }]);
    const entries = parseCentralDirectory(zip, findEndOfCentralDirectory(zip)!)!;
    return { zip, entry: entries[0]! };
  }

  test("a local header offset that runs past the end of the archive throws ZipFormatError", () => {
    const { zip, entry } = singleEntryArchive(ZIP_METHOD_STORE, enc.encode("x"));
    const badEntry: ZipEntryT = { ...entry, localHeaderOffset: zip.length + 1000 };
    expect(() => extractEntry(zip, badEntry)).toThrow(ZipFormatError);
  });

  test("a local header with the wrong signature throws ZipFormatError", () => {
    const { zip, entry } = singleEntryArchive(ZIP_METHOD_STORE, enc.encode("x"));
    const corrupted = zip.slice();
    corrupted[entry.localHeaderOffset] = 0x00; // stomp the first signature byte
    expect(() => extractEntry(corrupted, entry)).toThrow(ZipFormatError);
  });

  test("an unsupported compression method throws ZipFormatError", () => {
    const { zip, entry } = singleEntryArchive(ZIP_METHOD_STORE, enc.encode("x"));
    const badEntry: ZipEntryT = { ...entry, method: 99 };
    expect(() => extractEntry(zip, badEntry)).toThrow(ZipFormatError);
  });

  test("compressed data extending past the end of the archive throws ZipFormatError", () => {
    const { zip, entry } = singleEntryArchive(ZIP_METHOD_STORE, enc.encode("x"));
    const badEntry: ZipEntryT = { ...entry, compressedSize: entry.compressedSize + 10_000 };
    expect(() => extractEntry(zip, badEntry)).toThrow(ZipFormatError);
  });
});
