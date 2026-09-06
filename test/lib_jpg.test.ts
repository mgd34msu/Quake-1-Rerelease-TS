/*
Tests for src/lib/jpg.ts (lifted from quake-2-re-ts src/qcommon/jpg.ts at
7e88015 -- see that file's own header comment for the full scope
rationale: a dependency-free baseline+progressive JPEG decoder).

quake-2-re-ts's own test/jpg.test.ts drives this decoder via
test/support/jpeg_builder.ts, a from-scratch baseline JPEG encoder. This
project's SCOPE for this unit is `src/lib/**` and `test/lib_*.test.ts`
only, so rather than adding a new test/support file, the encoder is
inlined below (adapted from that same source, same "constant 8x8 block ->
exact forward DCT -> exact round trip" trick -- see its own comment) so
this file stays fully self-sufficient per PORTING.md rule 13.
*/

import { describe, test, expect } from "bun:test";
import { decodeJPG } from "../src/lib/jpg";

// ---------------------------------------------------------------------------
// Inlined from-scratch baseline JPEG encoder (adapted from quake-2-re-ts's
// test/support/jpeg_builder.ts). See that file's header comment for the
// full derivation of the "every 8x8 block is a single constant sample
// value" exact-round-trip trick this relies on.
// ---------------------------------------------------------------------------

interface JpegComponentSpec {
  h: number;
  v: number;
}

interface BuildBaselineJpegOptions {
  width: number;
  height: number;
  components: JpegComponentSpec[];
  blocks: number[][][];
  restartInterval?: number;
}

class BitWriter {
  bytes: number[] = [];
  private bitBuf = 0;
  private bitCount = 0;

  writeBits(value: number, size: number): void {
    for (let i = size - 1; i >= 0; i--) {
      const bit = (value >> i) & 1;
      this.bitBuf = (this.bitBuf << 1) | bit;
      this.bitCount++;
      if (this.bitCount === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    const b = this.bitBuf & 0xff;
    this.bytes.push(b);
    if (b === 0xff) this.bytes.push(0x00); // byte-stuffing
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  padToByteBoundary(): void {
    if (this.bitCount > 0) {
      const pad = 8 - this.bitCount;
      this.bitBuf = (this.bitBuf << pad) | ((1 << pad) - 1);
      this.bitCount = 8;
      this.flushByte();
    }
  }
}

function categoryAndBits(d: number): { size: number; bits: number } {
  if (d === 0) return { size: 0, bits: 0 };
  const mag = Math.abs(d);
  let size = 0;
  while (1 << size <= mag) size++;
  const bits = d >= 0 ? d : d + (1 << size) - 1;
  return { size, bits };
}

function marker(type: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, type, (length >> 8) & 0xff, length & 0xff, ...payload];
}

function flatHuffmanTable(classAndId: number, symbols: number[]): { dhtPayload: number[]; codeOf: Map<number, number> } {
  const bits = new Array(16).fill(0);
  bits[7] = symbols.length; // all codes at length 8
  const dhtPayload = [classAndId, ...bits, ...symbols];
  const codeOf = new Map<number, number>();
  symbols.forEach((sym, i) => codeOf.set(sym, i));
  return { dhtPayload, codeOf };
}

function buildBaselineJpeg(opts: BuildBaselineJpegOptions): Uint8Array {
  const { width, height, components, blocks, restartInterval = 0 } = opts;
  const numComponents = components.length;
  if (numComponents !== 1 && numComponents !== 3) throw new Error("test helper only supports 1 or 3 components");

  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (maxH * 8));
  const mcusPerColumn = Math.ceil(height / (maxV * 8));
  const totalMcus = mcusPerLine * mcusPerColumn;

  const dcSymbols = Array.from({ length: 12 }, (_, i) => i);
  const acSymbols = [0x00];
  const { dhtPayload: dcPayload, codeOf: dcCodeOf } = flatHuffmanTable(0x00, dcSymbols);
  const { dhtPayload: acPayload, codeOf: acCodeOf } = flatHuffmanTable(0x10, acSymbols);

  const componentIds = numComponents === 1 ? [1] : [1, 2, 3];

  const bytes: number[] = [0xff, 0xd8]; // SOI

  const dqtPayload = [0x00, ...new Array(64).fill(8)];
  bytes.push(...marker(0xdb, dqtPayload));

  bytes.push(...marker(0xc4, dcPayload));
  bytes.push(...marker(0xc4, acPayload));

  if (restartInterval > 0) {
    bytes.push(...marker(0xdd, [(restartInterval >> 8) & 0xff, restartInterval & 0xff]));
  }

  const sofPayload = [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, numComponents];
  for (let i = 0; i < numComponents; i++) {
    const c = components[i]!;
    sofPayload.push(componentIds[i]!, (c.h << 4) | c.v, 0x00);
  }
  bytes.push(...marker(0xc0, sofPayload));

  const sosPayload = [numComponents];
  for (let i = 0; i < numComponents; i++) {
    sosPayload.push(componentIds[i]!, 0x00);
  }
  sosPayload.push(0x00, 0x3f, 0x00);
  bytes.push(...marker(0xda, sosPayload));

  const bw = new BitWriter();
  const dcPred = new Array(numComponents).fill(0);
  let mcusUntilRestart = restartInterval > 0 ? restartInterval : Infinity;
  let restartCounter = 0;
  let mcusDone = 0;

  for (let mcuIndex = 0; mcuIndex < totalMcus; mcuIndex++) {
    for (let ci = 0; ci < numComponents; ci++) {
      const comp = components[ci]!;
      const compBlocks = blocks[mcuIndex]?.[ci];
      if (!compBlocks || compBlocks.length !== comp.h * comp.v) {
        throw new Error(`buildBaselineJpeg: missing/mis-sized block data for mcu ${mcuIndex} component ${ci}`);
      }
      for (const c of compBlocks) {
        const diff = c - dcPred[ci];
        dcPred[ci] = c;
        const { size, bits } = categoryAndBits(diff);
        const dcCode = dcCodeOf.get(size);
        if (dcCode === undefined) throw new Error(`buildBaselineJpeg: DC category ${size} out of range`);
        bw.writeBits(dcCode, 8);
        if (size > 0) bw.writeBits(bits, size);
        const acCode = acCodeOf.get(0x00)!;
        bw.writeBits(acCode, 8);
      }
    }

    mcusDone++;
    mcusUntilRestart--;
    if (mcusUntilRestart === 0 && mcusDone < totalMcus) {
      bw.padToByteBoundary();
      bytes.push(...bw.bytes);
      bw.bytes.length = 0;
      bytes.push(0xff, 0xd0 + (restartCounter % 8));
      restartCounter++;
      for (let ci = 0; ci < numComponents; ci++) dcPred[ci] = 0;
      mcusUntilRestart = restartInterval;
    }
  }

  bw.padToByteBoundary();
  bytes.push(...bw.bytes);
  bytes.push(0xff, 0xd9); // EOI

  return new Uint8Array(bytes);
}

function buildMinimalSof(sofMarker: number, precision: number, width: number, height: number, numComponents: number): Uint8Array {
  const payload = [precision, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, numComponents];
  for (let i = 0; i < numComponents; i++) {
    payload.push(i + 1, 0x11, 0x00);
  }
  return new Uint8Array([0xff, 0xd8, ...marker(sofMarker, payload), 0xff, 0xd9]);
}

function ycbcrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const Cb = cb - 128;
  const Cr = cr - 128;
  const r = y + 1.402 * Cr;
  const g = y - 0.344136 * Cb - 0.714136 * Cr;
  const b = y + 1.772 * Cb;
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return [clamp(r), clamp(g), clamp(b)];
}

// ---------------------------------------------------------------------------
// Tests (same vectors as quake-2-re-ts's test/jpg.test.ts, against the
// lifted decoder)
// ---------------------------------------------------------------------------

describe("decodeJPG -- subsampling modes", () => {
  test("4:4:4 (no subsampling): two MCUs, each block a distinct constant YCbCr color, exact pixel match", () => {
    const mcu0 = { y: 200, cb: 90, cr: 170 };
    const mcu1 = { y: 50, cb: 200, cr: 60 };
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 8,
      components: [
        { h: 1, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: [
        [[mcu0.y - 128], [mcu0.cb - 128], [mcu0.cr - 128]],
        [[mcu1.y - 128], [mcu1.cb - 128], [mcu1.cr - 128]],
      ],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(8);

    const expected0 = ycbcrToRgb(mcu0.y, mcu0.cb, mcu0.cr);
    const expected1 = ycbcrToRgb(mcu1.y, mcu1.cb, mcu1.cr);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = x < 8 ? expected0 : expected1;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2], result.image.pixels[o + 3]]).toEqual([
          expected[0],
          expected[1],
          expected[2],
          255,
        ]);
      }
    }
  });

  test("4:2:0 (H=2,V=2 luma): one MCU, four distinct Y quadrants sharing one Cb/Cr pair, exact pixel match", () => {
    const yTL = 220,
      yTR = 180,
      yBL = 90,
      yBR = 40;
    const cb = 140,
      cr = 110;
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 16,
      components: [
        { h: 2, v: 2 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: [
        [
          [yTL - 128, yTR - 128, yBL - 128, yBR - 128],
          [cb - 128],
          [cr - 128],
        ],
      ],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(16);

    const expTL = ycbcrToRgb(yTL, cb, cr);
    const expTR = ycbcrToRgb(yTR, cb, cr);
    const expBL = ycbcrToRgb(yBL, cb, cr);
    const expBR = ycbcrToRgb(yBR, cb, cr);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = y < 8 ? (x < 8 ? expTL : expTR) : x < 8 ? expBL : expBR;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(expected);
        expect(result.image.pixels[o + 3]).toBe(255);
      }
    }
  });

  test("4:2:2 (H=2,V=1 luma): one MCU, two distinct Y halves sharing one Cb/Cr pair, exact pixel match", () => {
    const yL = 210,
      yR = 30;
    const cb = 160,
      cr = 100;
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 8,
      components: [
        { h: 2, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: [
        [
          [yL - 128, yR - 128],
          [cb - 128],
          [cr - 128],
        ],
      ],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(8);

    const expL = ycbcrToRgb(yL, cb, cr);
    const expR = ycbcrToRgb(yR, cb, cr);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = x < 8 ? expL : expR;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(expected);
      }
    }
  });

  test("grayscale (1 component): R=G=B=Y, alpha 255", () => {
    const y0 = 33,
      y1 = 222;
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 8,
      components: [{ h: 1, v: 1 }],
      blocks: [[[y0 - 128]], [[y1 - 128]]],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = x < 8 ? y0 : y1;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2], result.image.pixels[o + 3]]).toEqual([
          expected,
          expected,
          expected,
          255,
        ]);
      }
    }
  });
});

describe("decodeJPG -- restart markers", () => {
  test("DRI=1 (restart after every MCU): four distinct MCUs decode correctly, proving DC predictors reset at each restart", () => {
    const colors = [
      { y: 240, cb: 128, cr: 128 },
      { y: 16, cb: 200, cr: 60 },
      { y: 128, cb: 60, cr: 200 },
      { y: 80, cb: 90, cr: 170 },
    ];
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 16,
      components: [
        { h: 1, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: colors.map((c) => [[c.y - 128], [c.cb - 128], [c.cr - 128]]),
      restartInterval: 1,
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(16);

    const expected = colors.map((c) => ycbcrToRgb(c.y, c.cb, c.cr));
    const mcuAt = (x: number, y: number): number => (y < 8 ? 0 : 2) + (x < 8 ? 0 : 1);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const exp = expected[mcuAt(x, y)]!;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(exp);
      }
    }
  });

  test("DRI=2 (restart every other MCU): four MCUs still decode correctly", () => {
    const colors = [
      { y: 10, cb: 128, cr: 128 },
      { y: 250, cb: 128, cr: 128 },
      { y: 100, cb: 40, cr: 210 },
      { y: 190, cb: 210, cr: 40 },
    ];
    const bytes = buildBaselineJpeg({
      width: 32,
      height: 8,
      components: [
        { h: 1, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: colors.map((c) => [[c.y - 128], [c.cb - 128], [c.cr - 128]]),
      restartInterval: 2,
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = colors.map((c) => ycbcrToRgb(c.y, c.cb, c.cr));
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 32; x++) {
        const mcuIndex = Math.floor(x / 8);
        const o = (y * 32 + x) * 4;
        const exp = expected[mcuIndex]!;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(exp);
      }
    }
  });
});

describe("decodeJPG -- progressive DCT (SOF2) is a supported variant, not a bare marker probe", () => {
  test("SOF2 with no SOS reports missing SOS marker, not unsupported", () => {
    const bytes = buildMinimalSof(0xc2, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing SOS marker");
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });
});

describe("decodeJPG -- unsupported variants (recognized but not decoded, never misdecoded)", () => {
  test("extended sequential DCT (SOF1) reports unsupported", () => {
    const bytes = buildMinimalSof(0xc1, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("arithmetic-coded extended sequential DCT (SOF9) reports unsupported", () => {
    const bytes = buildMinimalSof(0xc9, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
    expect(result.reason).toContain("arithmetic");
  });

  test("arithmetic-coded progressive DCT (SOF10) reports unsupported", () => {
    const bytes = buildMinimalSof(0xca, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("lossless (SOF3) reports unsupported", () => {
    const bytes = buildMinimalSof(0xc3, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("12-bit precision (SOF0) reports unsupported bit depth, never misdecoded as 8-bit", () => {
    const bytes = buildMinimalSof(0xc0, 12, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
    expect(result.reason).toContain("12");
  });

  test("2-component SOF0 reports unsupported component count", () => {
    const bytes = buildMinimalSof(0xc0, 8, 8, 8, 2);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("4-component SOF0 (e.g. CMYK) reports unsupported component count", () => {
    const bytes = buildMinimalSof(0xc0, 8, 8, 8, 4);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("a second SOS (non-interleaved multi-scan) reports unsupported, not silently dropped", () => {
    const valid = buildBaselineJpeg({
      width: 8,
      height: 8,
      components: [{ h: 1, v: 1 }],
      blocks: [[[0]]],
    });
    const withoutEoi = valid.slice(0, valid.length - 2);
    const secondSos = new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    const bytes = new Uint8Array(withoutEoi.length + secondSos.length + 2);
    bytes.set(withoutEoi, 0);
    bytes.set(secondSos, withoutEoi.length);
    bytes.set([0xff, 0xd9], withoutEoi.length + secondSos.length);

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
    expect(result.reason).toContain("multiple scans");
  });
});

describe("decodeJPG -- corrupt/malformed data (soft failure, no throw escapes decodeJPG)", () => {
  test("file too short", () => {
    const result = decodeJPG(new Uint8Array([0xff, 0xd8]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });

  test("bad JPEG signature (not FFD8)", () => {
    const result = decodeJPG(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad JPEG signature");
  });

  test("missing SOF marker (SOI then straight to EOI)", () => {
    const result = decodeJPG(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing SOF marker");
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });

  test("missing SOS marker (SOF0 present, no SOS)", () => {
    const bytes = buildMinimalSof(0xc0, 8, 8, 8, 1);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing SOS marker");
  });

  test("SOS referencing a Huffman table that was never defined via DHT", () => {
    const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(8)];
    const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00];
    const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
    const bytes = new Uint8Array([0xff, 0xd8, ...dqt, ...sof, ...sos, 0xff, 0xd9]);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(false);
    expect(result.reason).toContain("DHT");
  });

  test("truncated marker segment (length field claims more bytes than exist)", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x50, 0x00, 0x08, 0x08]);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });
});
