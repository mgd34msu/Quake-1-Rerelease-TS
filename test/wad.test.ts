import { describe, expect, test } from "bun:test";
import { SysError } from "../src/platform/sys";
import {
  CMP_NONE,
  TYP_NONE,
  TYP_QPIC,
  WADINFO_T_SIZE,
  LUMPINFO_T_SIZE,
  W_CleanupName,
  W_LoadWadFromBytes,
  W_GetLumpinfo,
  W_GetLumpName,
  W_GetLumpNum,
  W_GetQpic,
} from "../src/common/wad";

// Builds a synthetic WAD2 file in memory: a WAD2 header, one TYP_QPIC lump
// (4x2 pixels, known values) and one TYP_NONE blob lump. Both lump names are
// written uppercase so the tests can prove W_LoadWadFromBytes lowercases
// them via W_CleanupName, matching the C's in-place cleanup in the load loop.
function buildWad2(): {
  bytes: Uint8Array;
  picFilepos: number;
  picSize: number;
  blobFilepos: number;
  blobSize: number;
} {
  const picW = 4;
  const picH = 2;
  const picPixels = [10, 20, 30, 40, 50, 60, 70, 80];
  const picSize = 8 + picPixels.length; // qpic_t header (width, height) + pixel bytes
  const blob = [1, 2, 3, 4, 5];
  const blobSize = blob.length;

  const headerSize = WADINFO_T_SIZE;
  const picFilepos = headerSize;
  const blobFilepos = picFilepos + picSize;
  const infotableofs = blobFilepos + blobSize;
  const total = infotableofs + 2 * LUMPINFO_T_SIZE;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // wadinfo_t
  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 2, true); // numlumps
  view.setInt32(8, infotableofs, true);

  // qpic_t lump: width, height, pixel bytes
  view.setInt32(picFilepos, picW, true);
  view.setInt32(picFilepos + 4, picH, true);
  for (let i = 0; i < picPixels.length; i++) bytes[picFilepos + 8 + i] = picPixels[i] ?? 0;

  // TYP_NONE blob lump
  for (let i = 0; i < blob.length; i++) bytes[blobFilepos + i] = blob[i] ?? 0;

  // lumpinfo_t[0]: the qpic, name "TESTPIC" (uppercase)
  let o = infotableofs;
  view.setInt32(o, picFilepos, true); // filepos
  view.setInt32(o + 4, picSize, true); // disksize
  view.setInt32(o + 8, picSize, true); // size (uncompressed)
  view.setInt8(o + 12, TYP_QPIC); // type
  view.setInt8(o + 13, CMP_NONE); // compression
  view.setInt8(o + 14, 0); // pad1
  view.setInt8(o + 15, 0); // pad2
  writeName(bytes, o + 16, "TESTPIC");

  // lumpinfo_t[1]: the blob, name "OTHERLUMP" (uppercase)
  o += LUMPINFO_T_SIZE;
  view.setInt32(o, blobFilepos, true); // filepos
  view.setInt32(o + 4, blobSize, true); // disksize
  view.setInt32(o + 8, blobSize, true); // size (uncompressed)
  view.setInt8(o + 12, TYP_NONE); // type
  view.setInt8(o + 13, CMP_NONE); // compression
  view.setInt8(o + 14, 0); // pad1
  view.setInt8(o + 15, 0); // pad2
  writeName(bytes, o + 16, "OTHERLUMP");

  return { bytes, picFilepos, picSize, blobFilepos, blobSize };
}

function writeName(bytes: Uint8Array, offset: number, name: string): void {
  for (let i = 0; i < 16; i++) bytes[offset + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0;
}

describe("wad.ts (WAD2 lump loader)", () => {
  test("W_CleanupName lowercases, stops at NUL, and caps at 16 chars", () => {
    expect(W_CleanupName("CONCHARS")).toBe("conchars");
    expect(W_CleanupName("Mixed_Case1")).toBe("mixed_case1");
    expect(W_CleanupName("SEVENTEEN_CHARS_X")).toBe("seventeen_chars_"); // truncated to 16
    expect(W_CleanupName("abc\0garbage")).toBe("abc"); // stops at the first NUL
  });

  test("W_LoadWadFromBytes parses the header and lump table, lowercasing names", () => {
    const { bytes, picFilepos, picSize, blobFilepos, blobSize } = buildWad2();
    W_LoadWadFromBytes("test.wad", bytes);

    const picInfo = W_GetLumpinfo("TESTPIC"); // uppercase lookup also cleaned before compare
    expect(picInfo.filepos).toBe(picFilepos);
    expect(picInfo.size).toBe(picSize);
    expect(picInfo.type).toBe(TYP_QPIC);
    expect(picInfo.name).toBe("testpic"); // proves the loader lowercased it

    const blobInfo = W_GetLumpinfo("otherlump");
    expect(blobInfo.filepos).toBe(blobFilepos);
    expect(blobInfo.size).toBe(blobSize);
    expect(blobInfo.type).toBe(TYP_NONE);
  });

  test("W_GetQpic reads width/height and exposes the pixel bytes as a view", () => {
    const { bytes } = buildWad2();
    W_LoadWadFromBytes("test.wad", bytes);

    const pic = W_GetQpic("testpic");
    expect(pic.width).toBe(4);
    expect(pic.height).toBe(2);
    expect(Array.from(pic.data)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test("W_GetLumpName returns the raw disksize-length slice of wad_base", () => {
    const { bytes, blobFilepos, blobSize } = buildWad2();
    W_LoadWadFromBytes("test.wad", bytes);

    const raw = W_GetLumpName("OTHERLUMP");
    expect(raw.length).toBe(blobSize);
    expect(Array.from(raw)).toEqual([1, 2, 3, 4, 5]);
    // it is a view over the same buffer W_LoadWadFromBytes was given, at the lump's filepos
    expect(raw.buffer).toBe(bytes.buffer);
    expect(raw.byteOffset).toBe(blobFilepos);
  });

  test("W_GetLumpNum returns lumps by index and range-checks like the C", () => {
    const { bytes, picFilepos, picSize } = buildWad2();
    W_LoadWadFromBytes("test.wad", bytes);

    const byNum = W_GetLumpNum(0);
    expect(byNum.length).toBe(picSize);
    expect(byNum.byteOffset).toBe(picFilepos);

    expect(() => W_GetLumpNum(-1)).toThrow(SysError);
    expect(() => W_GetLumpNum(-1)).toThrow(/W_GetLumpNum: bad number: -1/);
    expect(() => W_GetLumpNum(100)).toThrow(SysError);
  });

  test("W_GetLumpinfo throws SysError for a name not in the wad", () => {
    const { bytes } = buildWad2();
    W_LoadWadFromBytes("test.wad", bytes);

    expect(() => W_GetLumpinfo("nosuchlump")).toThrow(SysError);
    expect(() => W_GetLumpinfo("nosuchlump")).toThrow(/W_GetLumpinfo: nosuchlump not found/);
  });

  test("W_LoadWadFromBytes throws SysError on a bad WAD2 magic", () => {
    const { bytes } = buildWad2();
    bytes[3] = "3".charCodeAt(0); // corrupt "WAD2" -> "WAD3"

    expect(() => W_LoadWadFromBytes("bad.wad", bytes)).toThrow(SysError);
    expect(() => W_LoadWadFromBytes("bad.wad", bytes)).toThrow(/doesn't have WAD2 id/);
  });
});
