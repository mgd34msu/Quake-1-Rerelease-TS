// Tests for src/lib/tga.ts (lifted from quake-2-re-ts src/qcommon/tga.ts at
// 7e88015 -- see that file's own header comment for the format-support
// rationale). quake-2-re-ts's own tree has no dedicated tga.test.ts (its
// one consumer, r_soft_wide_capacity.test.ts, is an engine-bound
// integration test); this file is written fresh for the lift, self-
// sufficient per PORTING.md rule 13 -- every Targa buffer it needs is
// hand-built below from the on-disk header layout (id[1] + colormap
// type[1] + image type[1] + colormap spec[5] + x/y origin[2+2] +
// width[2] + height[2] + pixel size[1] + attributes[1] = 18 bytes),
// matching decodeTGA's own field offsets exactly.

import { describe, test, expect } from "bun:test";
import { decodeTGA } from "../src/lib/tga";

const TGA_RGB = 2;
const TGA_MONO = 3;
const TGA_RGB_RLE = 10;

function u16le(v: number): [number, number] {
  return [v & 0xff, (v >> 8) & 0xff];
}

function tgaHeader(imageType: number, width: number, height: number, pixelSize: number, idLength = 0): number[] {
  const [wLo, wHi] = u16le(width);
  const [hLo, hHi] = u16le(height);
  return [
    idLength, // id length
    0, // colormap type (0 = none)
    imageType,
    0,
    0,
    0,
    0,
    0, // colormap spec (unused)
    0,
    0,
    0,
    0, // x/y origin (unused)
    wLo,
    wHi,
    hLo,
    hHi,
    pixelSize,
    0, // attributes
  ];
}

describe("decodeTGA -- header validation", () => {
  test("rejects a buffer shorter than the 18-byte header", () => {
    const result = decodeTGA(new Uint8Array(10));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("file too short");
  });

  test("rejects an unsupported image type", () => {
    const bytes = new Uint8Array([...tgaHeader(1, 2, 2, 24)]);
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported image type");
  });

  test("rejects a colormapped targa", () => {
    const bytes = new Uint8Array(tgaHeader(TGA_RGB, 2, 2, 24));
    bytes[1] = 1; // colormap_type != 0
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("colormapped targas are not supported");
  });

  test("rejects an unsupported pixel size for a truecolor image type", () => {
    const bytes = new Uint8Array(tgaHeader(TGA_RGB, 2, 2, 16));
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported pixel size");
  });

  test("rejects a type-3 (mono) image whose pixel size isn't 8", () => {
    const bytes = new Uint8Array(tgaHeader(TGA_MONO, 2, 2, 24));
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported pixel size");
  });

  test("rejects zero-size dimensions", () => {
    const bytes = new Uint8Array(tgaHeader(TGA_RGB, 0, 4, 24));
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("bad dimensions");
  });

  test("rejects truncated pixel data", () => {
    const header = tgaHeader(TGA_RGB, 4, 4, 24);
    const bytes = new Uint8Array([...header, 1, 2, 3]); // way short of 4*4*3 bytes
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("truncated pixel data");
  });
});

describe("decodeTGA -- uncompressed truecolor (type 2)", () => {
  test("24-bit BGR, bottom-up storage decodes to top-down RGBA with alpha 255", () => {
    // 2x2 image. File stores rows bottom-up (row1 first, then row0), each
    // pixel as B,G,R. Row0 (top, drawn last in the file): red, green.
    // Row1 (bottom, drawn first in the file): blue, white.
    const header = tgaHeader(TGA_RGB, 2, 2, 24);
    const row1 = [255, 0, 0, /* BGR blue */ 255, 255, 255 /* BGR white */];
    const row0 = [0, 0, 255 /* BGR red */, 0, 255, 0 /* BGR green */];
    const bytes = new Uint8Array([...header, ...row1, ...row0]);
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(2);
    expect(result.image.height).toBe(2);
    const px = result.image.pixels;
    // top-down output: row 0 = red, green ; row 1 = blue, white
    expect([px[0], px[1], px[2], px[3]]).toEqual([255, 0, 0, 255]); // (0,0) red
    expect([px[4], px[5], px[6], px[7]]).toEqual([0, 255, 0, 255]); // (1,0) green
    expect([px[8], px[9], px[10], px[11]]).toEqual([0, 0, 255, 255]); // (0,1) blue
    expect([px[12], px[13], px[14], px[15]]).toEqual([255, 255, 255, 255]); // (1,1) white
  });

  test("32-bit BGRA carries the real alpha byte through", () => {
    const header = tgaHeader(TGA_RGB, 1, 1, 32);
    const bytes = new Uint8Array([...header, 10, 20, 30, 128]); // B,G,R,A
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([30, 20, 10, 128]);
  });

  test("honors a nonzero id_length by skipping the image-ID comment before pixel data", () => {
    const header = tgaHeader(TGA_RGB, 1, 1, 24, 3);
    const idComment = [65, 66, 67]; // "ABC", 3 bytes matching id_length
    const bytes = new Uint8Array([...header, ...idComment, 9, 8, 7]); // BGR
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([7, 8, 9, 255]);
  });
});

describe("decodeTGA -- uncompressed grayscale (type 3, rerelease extension)", () => {
  test("one gray byte per pixel expands to R=G=B=gray, alpha 255", () => {
    const header = tgaHeader(TGA_MONO, 2, 1, 8);
    const bytes = new Uint8Array([...header, 200, 50]);
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const px = result.image.pixels;
    expect([px[0], px[1], px[2], px[3]]).toEqual([200, 200, 200, 255]);
    expect([px[4], px[5], px[6], px[7]]).toEqual([50, 50, 50, 255]);
  });
});

describe("decodeTGA -- run-length encoded truecolor (type 10)", () => {
  test("a single run-length packet fills every pixel with the same color", () => {
    // 2x2 image, one RLE packet: header 0x80|3 (run of 4 samples), then one
    // BGR triple.
    const header = tgaHeader(TGA_RGB_RLE, 2, 2, 24);
    const packetHeader = 0x80 | (4 - 1);
    const bytes = new Uint8Array([...header, packetHeader, 1, 2, 3]); // BGR -> RGB (3,2,1)
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const px = result.image.pixels;
    for (let i = 0; i < 4; i++) {
      const o = i * 4;
      expect([px[o], px[o + 1], px[o + 2], px[o + 3]]).toEqual([3, 2, 1, 255]);
    }
  });

  test("a raw packet stores each of its samples individually, run and raw packets can mix", () => {
    // 4x1 image: one raw packet of 2 distinct pixels, then one run-length
    // packet of 2 identical pixels.
    const header = tgaHeader(TGA_RGB_RLE, 4, 1, 24);
    const rawHeader = 0x00 | (2 - 1); // raw packet, 2 samples
    const rawSamples = [10, 20, 30, /* BGR */ 40, 50, 60];
    const runHeader = 0x80 | (2 - 1); // run-length packet, 2 samples
    const runSample = [70, 80, 90];
    const bytes = new Uint8Array([...header, rawHeader, ...rawSamples, runHeader, ...runSample]);
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const px = result.image.pixels;
    expect([px[0], px[1], px[2]]).toEqual([30, 20, 10]);
    expect([px[4], px[5], px[6]]).toEqual([60, 50, 40]);
    expect([px[8], px[9], px[10]]).toEqual([90, 80, 70]);
    expect([px[12], px[13], px[14]]).toEqual([90, 80, 70]);
  });

  test("truncated RLE data is reported, not decoded as garbage", () => {
    const header = tgaHeader(TGA_RGB_RLE, 2, 2, 24);
    const packetHeader = 0x80 | (4 - 1);
    const bytes = new Uint8Array([...header, packetHeader, 1, 2]); // missing the 3rd sample byte
    const result = decodeTGA(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("truncated RLE data");
  });
});
