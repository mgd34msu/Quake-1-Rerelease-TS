// Lifted from quake-2-re-ts src/qcommon/tga.ts at 7e88015 (GPLv2, our own
// repo). Game-agnostic as-is: the original file had no engine imports at
// all. Copied verbatim into src/lib for this project's decoders; no
// behavior change. The original comment below refers to "ref_gl/gl_image.ts"
// and "ref_soft/r_image.ts", which are quake-2-re-ts renderer files, not
// part of this project -- kept as historical context for the format
// decisions this decoder makes, not as an active cross-reference.
//
/*
Targa (.tga) decoding, shared by both renderers.

Vanilla split this the other way round: ref_gl/gl_image.c owned LoadTGA and
ref_soft/r_image.c had no .tga path at all, because the software renderer's
image_t is palette-indexed 8-bit and a truecolor Targa had nowhere to go.
That asymmetry is fine for vanilla content -- id shipped every sky both as
env/*.pcx (for ref_soft) and env/*.tga (for ref_gl) -- but it stops being
fine for the 2023 rerelease's data, which ships env/ skies as .tga ONLY
(measured: baseq2/pak0.pak carries 154 env/ entries, every one of them
.tga, zero .pcx). See ref_soft/r_image.ts's LoadTGAQuantized and
ref_soft/r_main.ts's R_SetSky for the consumer side, and this port's
existing qcommon/{png,jpg,bmp,gif}.ts for the decoder-lives-in-qcommon
convention this file follows.

Decoding is byte-faithful to ref_gl/gl_image.ts's LoadTGA (itself the port
of vanilla's own LoadTGA), including its rerelease-era type-3 grayscale
extension. The one deliberate interface difference: where LoadTGA calls
ri.Sys_Error(ERR_DROP) on an unsupported variant, this returns
`{ok:false, reason}` -- the same "recognized format, unsupported variant,
degrade gracefully" shape decodeBMP/decodePNG/decodeGIF already use, so a
missing-or-odd .tga costs one console line instead of dropping the client
mid-load. gl_image.ts's LoadTGA is deliberately left untouched and keeps
its own Sys_Error behavior; nothing about the GL renderer changes.
*/

export interface DecodedTgaT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down (row 0 is the
  // top scanline) -- matches png.ts's DecodedPngT / bmp.ts's DecodedBmpT /
  // gif.ts's DecodedGifT, so callers treat every truecolor decoder alike.
  //
  // A default-orientation Targa stores its scanlines bottom-up, so (exactly
  // as LoadTGA does) the first scanline read is written at row index
  // rows-1 and the decode walks row indices downward; the resulting array
  // is therefore top-down. Like LoadTGA, this never consults the header's
  // TGA_TOPTOBOTTOM attributes bit.
  pixels: Uint8Array;
}

export type DecodeTgaResultT = { ok: true; image: DecodedTgaT } | { ok: false; reason: string };

// Targa image_type values this decoder accepts. 2/10 are vanilla's own
// (uncompressed / RLE truecolor). 3 is uncompressed grayscale, which
// vanilla 3.21 never shipped but the rerelease does (e.g.
// sprites/flare_01.tga) -- q2repro's IMG_LoadTGA accepts the same three.
const TGA_RGB = 2;
const TGA_MONO = 3;
const TGA_RGB_RLE = 10;

const TGA_HEADER_SIZE = 18;

export function decodeTGA(buffer: Uint8Array): DecodeTgaResultT {
  if (buffer.length < TGA_HEADER_SIZE) return { ok: false, reason: "file too short" };

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const id_length = buffer[0];
  const colormap_type = buffer[1];
  const image_type = buffer[2];
  // bytes 3-4 colormap_index, 5-6 colormap_length, 7 colormap_size,
  // 8-9 x_origin, 10-11 y_origin: all unused here, exactly as in LoadTGA.
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const pixel_size = buffer[16];
  // byte 17 attributes: unused, as in LoadTGA.

  if (image_type !== TGA_RGB && image_type !== TGA_MONO && image_type !== TGA_RGB_RLE) {
    return { ok: false, reason: `unsupported image type ${image_type} (only type 2, 3 and 10 supported)` };
  }
  if (colormap_type !== 0) {
    return { ok: false, reason: "colormapped targas are not supported" };
  }
  if (image_type === TGA_MONO ? pixel_size !== 8 : pixel_size !== 24 && pixel_size !== 32) {
    return { ok: false, reason: `unsupported pixel size ${pixel_size} (24 or 32 bit, 8 bit for type 3)` };
  }
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: `bad dimensions ${width}x${height}` };
  }

  const columns = width;
  const rows = height;
  const pixels = new Uint8Array(columns * rows * 4);

  // start of pixel data: fixed header plus the optional image-ID comment
  let p = TGA_HEADER_SIZE + id_length;

  // Every read below is bounds-checked against the buffer rather than
  // trusting the header's own dimensions: a truncated or malformed .tga
  // must degrade to `{ok:false}` like the other qcommon decoders, not read
  // `undefined` out of the Uint8Array and quantize it to a garbage palette
  // index (Uint8Array reads past the end yield undefined, not a throw).
  const need = (n: number): boolean => p + n <= buffer.length;

  if (image_type === TGA_RGB || image_type === TGA_MONO) {
    const bytesPerPixel = image_type === TGA_MONO ? 1 : pixel_size / 8;
    if (!need(columns * rows * bytesPerPixel)) return { ok: false, reason: "truncated pixel data" };

    for (let row = rows - 1; row >= 0; row--) {
      let pixbuf = row * columns * 4;
      for (let column = 0; column < columns; column++) {
        if (image_type === TGA_MONO) {
          const gray = buffer[p++];
          pixels[pixbuf++] = gray;
          pixels[pixbuf++] = gray;
          pixels[pixbuf++] = gray;
          pixels[pixbuf++] = 255;
        } else {
          const blue = buffer[p++];
          const green = buffer[p++];
          const red = buffer[p++];
          const alphabyte = pixel_size === 32 ? buffer[p++] : 255;
          pixels[pixbuf++] = red;
          pixels[pixbuf++] = green;
          pixels[pixbuf++] = blue;
          pixels[pixbuf++] = alphabyte;
        }
      }
    }

    return { ok: true, image: { width: columns, height: rows, pixels } };
  }

  // image_type === TGA_RGB_RLE: runlength encoded RGB. Mirrors LoadTGA's
  // labeled-break port of the original's `goto breakOut` (a run that spans
  // past the final row ends the whole decode).
  const sampleBytes = pixel_size / 8;
  rleDecode: for (let row = rows - 1; row >= 0; ) {
    let pixbuf = row * columns * 4;
    let column = 0;
    while (column < columns) {
      if (!need(1)) return { ok: false, reason: "truncated RLE data" };
      const packetHeader = buffer[p++];
      const packetSize = 1 + (packetHeader & 0x7f);

      if (packetHeader & 0x80) {
        // run-length packet: one sample repeated packetSize times
        if (!need(sampleBytes)) return { ok: false, reason: "truncated RLE data" };
        const blue = buffer[p++];
        const green = buffer[p++];
        const red = buffer[p++];
        const alphabyte = pixel_size === 32 ? buffer[p++] : 255;

        for (let j = 0; j < packetSize; j++) {
          pixels[pixbuf++] = red;
          pixels[pixbuf++] = green;
          pixels[pixbuf++] = blue;
          pixels[pixbuf++] = alphabyte;
          column++;
          if (column === columns) {
            // run spans across rows
            column = 0;
            if (row > 0) row--;
            else break rleDecode;
            pixbuf = row * columns * 4;
          }
        }
      } else {
        // raw packet: packetSize distinct samples
        if (!need(sampleBytes * packetSize)) return { ok: false, reason: "truncated RLE data" };
        for (let j = 0; j < packetSize; j++) {
          const blue = buffer[p++];
          const green = buffer[p++];
          const red = buffer[p++];
          const alphabyte = pixel_size === 32 ? buffer[p++] : 255;
          pixels[pixbuf++] = red;
          pixels[pixbuf++] = green;
          pixels[pixbuf++] = blue;
          pixels[pixbuf++] = alphabyte;
          column++;
          if (column === columns) {
            // pixel packet run spans across rows
            column = 0;
            if (row > 0) row--;
            else break rleDecode;
            pixbuf = row * columns * 4;
          }
        }
      }
    }
  }

  return { ok: true, image: { width: columns, height: rows, pixels } };
}
