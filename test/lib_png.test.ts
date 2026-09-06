// Tests for src/lib/png.ts (lifted from quake-2-re-ts src/qcommon/png.ts at
// 7e88015 -- see that file's own header comment for the exact format
// coverage this decoder targets: colortypes 0/2/3/4/6 at bit depth 8,
// colortype 3 with PLTE+tRNS, bit depth 16 downsampled to 8, and Adam7
// interlacing). quake-2-re-ts's own png tests (test/r_image_png.test.ts,
// test/png_retail_sweep.test.ts) are engine-bound (renderer palette
// quantization, or a real retail-pak sweep); this file is written fresh
// for the lift, self-sufficient per PORTING.md rule 13 -- every PNG buffer
// it needs is hand-built below via node:zlib.deflateSync, no game data.

import { describe, test, expect } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodePNG } from "../src/lib/png";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // Bytes 8+data.length..+4 (the CRC) are left as 0 -- decodePNG never
  // validates chunk CRCs, it just skips 4 bytes past each chunk's data.
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Packs one filter-type-0 ("None") scanline set for a w x h image with the
// given channel count/bit depth, calling sampleFn(x, y, channelIndex) for
// every sample.
function packImage(w: number, h: number, channels: number, bitDepth: number, sampleFn: (x: number, y: number, ch: number) => number): Uint8Array {
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const rowBytes = w * channels * bytesPerSample;
  const raw = new Uint8Array((rowBytes + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter type: None
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        const v = sampleFn(x, y, c);
        if (bitDepth === 16) {
          raw[o++] = (v >> 8) & 0xff;
          raw[o++] = v & 0xff;
        } else {
          raw[o++] = v & 0xff;
        }
      }
    }
  }
  return raw;
}

// Adam7 sub-image geometry, identical to decodePNG's own XO/YO/XS/YS
// tables (PNG spec 8.2) -- used here to build a matching interlaced stream.
const XO = [0, 4, 0, 2, 0, 1, 0];
const YO = [0, 0, 4, 0, 2, 0, 1];
const XS = [8, 8, 4, 4, 2, 2, 1];
const YS = [8, 8, 8, 4, 4, 2, 2];

function packAdam7(w: number, h: number, channels: number, bitDepth: number, sampleFn: (x: number, y: number, ch: number) => number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let pass = 0; pass < 7; pass++) {
    const pw = Math.ceil((w - XO[pass]!) / XS[pass]!);
    const ph = Math.ceil((h - YO[pass]!) / YS[pass]!);
    if (pw <= 0 || ph <= 0) continue;
    parts.push(packImage(pw, ph, channels, bitDepth, (px, py, c) => sampleFn(XO[pass]! + px * XS[pass]!, YO[pass]! + py * YS[pass]!, c)));
  }
  return concat(parts);
}

interface BuildPngOptions {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  colorType: 0 | 2 | 3 | 4 | 6;
  interlace?: 0 | 1;
  palette?: [number, number, number][];
  trns?: number[];
  sample: (x: number, y: number, ch: number) => number;
}

function channelsFor(colorType: number): number {
  return colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
}

function buildPng(opts: BuildPngOptions): Uint8Array {
  const { width, height, bitDepth, colorType, interlace = 0, palette, trns, sample } = opts;
  const channels = channelsFor(colorType);
  const raw = interlace === 1 ? packAdam7(width, height, channels, bitDepth, sample) : packImage(width, height, channels, bitDepth, sample);
  const compressed = new Uint8Array(deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;

  const parts: Uint8Array[] = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr)];
  if (colorType === 3 && palette) {
    const plte = new Uint8Array(palette.length * 3);
    palette.forEach((c, i) => {
      plte[i * 3] = c[0];
      plte[i * 3 + 1] = c[1];
      plte[i * 3 + 2] = c[2];
    });
    parts.push(chunk("PLTE", plte));
    if (trns) parts.push(chunk("tRNS", new Uint8Array(trns)));
  }
  parts.push(chunk("IDAT", compressed));
  parts.push(chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

describe("decodePNG -- header/chunk validation", () => {
  test("rejects a buffer too short to hold a signature + IHDR", () => {
    const result = decodePNG(new Uint8Array(10));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("file too short");
  });

  test("rejects a bad PNG signature", () => {
    const bytes = new Uint8Array(40);
    bytes.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = decodePNG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad PNG signature");
  });

  test("rejects a malformed IHDR (wrong chunk length)", () => {
    // Padded with trailing zero bytes past the malformed IHDR chunk so the
    // buffer clears decodePNG's own upfront "file too short" length check
    // (8-byte signature + 25) and actually reaches the IHDR length check.
    const bad = concat([new Uint8Array(SIGNATURE), chunk("IHDR", new Uint8Array(10)), new Uint8Array(10)]);
    const result = decodePNG(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed IHDR");
  });

  test("rejects a file with no IHDR at all", () => {
    // The IDAT chunk's data is sized (not actually valid zlib data, but
    // that's never reached) so the buffer clears decodePNG's own upfront
    // "file too short" length check with no leftover trailing bytes for
    // the chunk-walk loop to choke on as a phantom truncated chunk.
    const bad = concat([new Uint8Array(SIGNATURE), chunk("IDAT", new Uint8Array(25))]);
    const result = decodePNG(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing IHDR");
  });

  test("rejects an unsupported color type", () => {
    const png = buildPng({ width: 1, height: 1, bitDepth: 8, colorType: 2, sample: () => 0 });
    // colorType 1 doesn't exist in the PNG spec; stomp IHDR's color type
    // byte (offset 8+8+4+4+1+1 = signature(8) + chunk header(8) + w(4)+h(4)+depth(1)) directly.
    const mutated = png.slice();
    mutated[8 + 8 + 4 + 4 + 1] = 1;
    const result = decodePNG(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported PNG color type");
  });

  test("rejects an unsupported bit depth for a truecolor image", () => {
    const png = buildPng({ width: 1, height: 1, bitDepth: 8, colorType: 2, sample: () => 0 });
    const mutated = png.slice();
    mutated[8 + 8 + 4 + 4] = 4; // bit depth byte -> 4 (only 8/16 supported for colorType 2)
    const result = decodePNG(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported PNG bit depth");
  });

  test("rejects zero-size images", () => {
    const png = buildPng({ width: 1, height: 1, bitDepth: 8, colorType: 2, sample: () => 0 });
    const mutated = png.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(8 + 8, 0, false); // width -> 0
    const result = decodePNG(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("zero-size image");
  });

  test("rejects a file with no IDAT", () => {
    const ihdr = new Uint8Array(13);
    const iv = new DataView(ihdr.buffer);
    iv.setUint32(0, 1, false);
    iv.setUint32(4, 1, false);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bad = concat([new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IEND", new Uint8Array(0))]);
    const result = decodePNG(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing IDAT");
  });

  test("rejects a truncated chunk (declared length runs past the buffer)", () => {
    const png = buildPng({ width: 1, height: 1, bitDepth: 8, colorType: 2, sample: () => 0 });
    const truncated = png.slice(0, png.length - 20);
    const result = decodePNG(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("truncated chunk");
  });

  test("rejects a palette PNG (colorType 3) with no PLTE chunk", () => {
    const raw = packImage(1, 1, 1, 8, () => 0);
    const compressed = new Uint8Array(deflateSync(raw));
    const ihdr = new Uint8Array(13);
    const iv = new DataView(ihdr.buffer);
    iv.setUint32(0, 1, false);
    iv.setUint32(4, 1, false);
    ihdr[8] = 8;
    ihdr[9] = 3;
    const bad = concat([new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))]);
    const result = decodePNG(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("palette PNG missing PLTE");
  });
});

describe("decodePNG -- colorType 0 (grayscale)", () => {
  test("expands each gray sample to R=G=B=gray, alpha 255", () => {
    const png = buildPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      sample: (x) => (x === 0 ? 30 : 220),
    });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([30, 30, 30, 255, 220, 220, 220, 255]);
  });
});

describe("decodePNG -- colorType 2 (truecolor RGB)", () => {
  test("decodes exact RGB samples with alpha forced to 255", () => {
    const png = buildPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      sample: (_x, _y, ch) => [10, 20, 30][ch]!,
    });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([10, 20, 30, 255]);
  });
});

describe("decodePNG -- colorType 3 (palette + tRNS)", () => {
  test("maps palette indices to RGB, and tRNS supplies per-entry alpha", () => {
    const palette: [number, number, number][] = [
      [255, 0, 0], // index 0: red
      [0, 255, 0], // index 1: green, half-transparent via tRNS
      [0, 0, 255], // index 2: blue, no tRNS entry -> fully opaque
    ];
    const png = buildPng({
      width: 3,
      height: 1,
      bitDepth: 8,
      colorType: 3,
      palette,
      trns: [255, 128], // index 0 -> alpha 255, index 1 -> alpha 128, index 2 unspecified -> opaque
      sample: (x) => x, // pixel x uses palette index x
    });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const px = result.image.pixels;
    expect([px[0], px[1], px[2], px[3]]).toEqual([255, 0, 0, 255]);
    expect([px[4], px[5], px[6], px[7]]).toEqual([0, 255, 0, 128]);
    expect([px[8], px[9], px[10], px[11]]).toEqual([0, 0, 255, 255]);
  });
});

describe("decodePNG -- colorType 4 (grayscale + alpha)", () => {
  test("carries the alpha channel through, gray expanded to R=G=B", () => {
    const png = buildPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 4,
      sample: (_x, _y, ch) => [100, 77][ch]!,
    });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([100, 100, 100, 77]);
  });
});

describe("decodePNG -- colorType 6 (truecolor RGBA)", () => {
  test("decodes exact RGBA samples", () => {
    const png = buildPng({
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 6,
      sample: (_x, _y, ch) => [1, 2, 3, 4][ch]!,
    });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([1, 2, 3, 4]);
  });
});

describe("decodePNG -- bit depth 16 (downsampled to 8 by taking the high byte)", () => {
  test("a 16-bit RGB sample keeps only its high byte, matching libpng's png_set_strip_16", () => {
    const png = buildPng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 2,
      sample: (_x, _y, ch) => [0xabcd, 0x1234, 0xff00][ch]!,
    });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([0xab, 0x12, 0xff, 255]);
  });
});

describe("decodePNG -- Adam7 interlacing", () => {
  test("an 8x8 RGBA interlaced image decodes every pixel to its exact expected value", () => {
    // Deterministic per-pixel channel function so every one of the 64
    // pixels has a distinguishable value; verifies all 7 Adam7 passes
    // land their pixels in the right place, not just a spot check.
    const sample = (x: number, y: number, ch: number): number => {
      const base = (y * 8 + x) * 4;
      return (base + ch) & 0xff;
    };
    const png = buildPng({ width: 8, height: 8, bitDepth: 8, colorType: 6, interlace: 1, sample });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(8);
    expect(result.image.height).toBe(8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const o = (y * 8 + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          expect(result.image.pixels[o + ch]).toBe(sample(x, y, ch));
        }
      }
    }
  });

  test("a non-multiple-of-8 interlaced image (some Adam7 passes empty) still decodes correctly", () => {
    // 3x3: several Adam7 passes have zero pixels at this size (e.g. pass 2's
    // 4-pixel-stride grid has no room), exercising the "pw<=0||ph<=0 ->
    // skip pass" branch on both the encoder and decoder side identically.
    const sample = (x: number, y: number, ch: number): number => (x * 10 + y * 20 + ch * 5) & 0xff;
    const png = buildPng({ width: 3, height: 3, bitDepth: 8, colorType: 2, interlace: 1, sample });
    const result = decodePNG(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const o = (y * 3 + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          expect(result.image.pixels[o + ch]).toBe(sample(x, y, ch));
        }
        expect(result.image.pixels[o + 3]).toBe(255);
      }
    }
  });
});
