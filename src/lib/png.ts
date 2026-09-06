// Lifted from quake-2-re-ts src/qcommon/png.ts at 7e88015 (GPLv2, our own
// repo). Game-agnostic as-is: the original file had no engine imports at
// all (its own header explains why PNG decoding lives in qcommon rather
// than being a port of any original id Quake II .c file). Copied verbatim
// into src/lib for this project's decoders; no behavior change.
//
// PNG decoding -- NOT a port of any file in the original id Quake II source
// (vanilla ref_gl/ref_soft only ever load PCX/WAL/TGA; see gl_image.ts's own
// header comment). Added for the kfont FIDELITY RAZOR sweep
// (.orch/preferences.md rule 17): q2repro's own SCR_LoadKFont registers
// "fonts/qconfont.png" (src/refresh/draw.c), a truecolor PNG shipped inside
// the retail rerelease KPF (Q2Game.kpf, mounted via qcommon/zipfile.ts) --
// there is no .tga/.pcx sibling for that exact asset, so matching q2repro's
// observable behavior with that data requires decoding it for real.
//
// Scope matches the FULL retail asset census (2026-08-31 survey of every
// .png in pak0.pak + Q2Game.kpf -- 2354 files):
//   - colortypes 0/2/4/6 at bit depth 8 (the bulk of the set)
//   - colortype 3 (palette, PLTE + optional tRNS) at bit depth 8 -- 409
//     shipped files, including every models/*/md5/skin.png (missing
//     support was a total map-load blocker: MD5 skin precache hit the
//     hard-error path on the first weapon model)
//   - bit depth 16 for colortypes 0/2/4/6, downsampled to 8 by taking the
//     high byte (libpng's own png_set_strip_16 behavior) -- 1 shipped file
//   - Adam7 interlacing -- 2 shipped files (glow textures)
// Anything outside that returns { ok: false }, the same "recognized but not
// handled, degrade gracefully" shape LoadPCX/LoadTGA already use for their
// own out-of-spec inputs (see gl_image.ts's LoadPCX bad-header branch) --
// callers decide whether that's a soft failure (missing-asset fallback) or
// a hard error (Sys_Error), matching each renderer's own existing
// convention for "recognized format, unsupported variant" (LoadTGA's own
// `Only type 2 and 10 targa RGB images supported`).
//
// DEFLATE decompression reuses node:zlib exactly like qcommon/zipfile.ts's
// own DEFLATE (method 8) support -- PNG's IDAT stream is zlib-wrapped
// (RFC 1950: 2-byte header + deflate stream + Adler-32), the plain
// `zlib.inflateSync` counterpart to zipfile.ts's raw-deflate
// `inflateRawSync` (ZIP entries have no zlib wrapper; PNG chunks do).

import * as zlib from "node:zlib";

export interface DecodedPngT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down (row 0 is the
  // top scanline) -- the same shape/orientation LoadTGA's own `targa_rgba`
  // output uses (see gl_image.ts), so callers can treat both the same way.
  pixels: Uint8Array;
}

export type DecodePngResultT = { ok: true; image: DecodedPngT } | { ok: false; reason: string };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePNG(buffer: Uint8Array): DecodePngResultT {
  if (buffer.length < 8 + 25) return { ok: false, reason: "file too short" };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: "bad PNG signature" };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawIHDR = false;
  let interlaced = false;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let idatLength = 0;

  while (pos + 8 <= buffer.length) {
    const chunkLength = view.getUint32(pos, false);
    const chunkType = String.fromCharCode(buffer[pos + 4], buffer[pos + 5], buffer[pos + 6], buffer[pos + 7]);
    const dataStart = pos + 8;
    if (dataStart + chunkLength + 4 > buffer.length) return { ok: false, reason: "truncated chunk" };

    if (chunkType === "IHDR") {
      if (chunkLength !== 13) return { ok: false, reason: "malformed IHDR" };
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filterMethod = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      if (compression !== 0 || filterMethod !== 0) return { ok: false, reason: "unsupported PNG compression/filter method" };
      if (interlace !== 0 && interlace !== 1) return { ok: false, reason: `unknown PNG interlace method ${interlace}` };
      interlaced = interlace === 1;
      if (colorType === 3) {
        if (bitDepth !== 8) return { ok: false, reason: `unsupported palette PNG bit depth ${bitDepth}` };
      } else if (colorType === 0 || colorType === 2 || colorType === 4 || colorType === 6) {
        if (bitDepth !== 8 && bitDepth !== 16) return { ok: false, reason: `unsupported PNG bit depth ${bitDepth}` };
      } else {
        return { ok: false, reason: `unsupported PNG color type ${colorType}` };
      }
      sawIHDR = true;
    } else if (chunkType === "PLTE") {
      if (chunkLength % 3 !== 0) return { ok: false, reason: "malformed PLTE" };
      palette = buffer.subarray(dataStart, dataStart + chunkLength);
    } else if (chunkType === "tRNS") {
      trns = buffer.subarray(dataStart, dataStart + chunkLength);
    } else if (chunkType === "IDAT") {
      idatParts.push(buffer.subarray(dataStart, dataStart + chunkLength));
      idatLength += chunkLength;
    } else if (chunkType === "IEND") {
      break;
    }

    pos = dataStart + chunkLength + 4; // skip CRC
  }

  if (!sawIHDR) return { ok: false, reason: "missing IHDR" };
  if (width <= 0 || height <= 0) return { ok: false, reason: "zero-size image" };
  if (idatParts.length === 0) return { ok: false, reason: "missing IDAT" };

  const compressed = new Uint8Array(idatLength);
  {
    let o = 0;
    for (const part of idatParts) {
      compressed.set(part, o);
      o += part.length;
    }
  }

  // (quake-2-re-ts's original used a lazy `require("node:zlib")` here;
  // this project's own convention is a plain top-level ESM import of node
  // built-ins, which also avoids the `as typeof import(...)` cast
  // `require`'s return type would otherwise need -- rule 2 bans `as` casts
  // other than `as const`.)
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(zlib.inflateSync(compressed));
  } catch (e) {
    return { ok: false, reason: `zlib inflate failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (colorType === 3 && palette === null) return { ok: false, reason: "palette PNG missing PLTE" };

  const channels = colorType === 3 ? 1 : colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample;

  // De-filter one (sub-)image of w x h pixels starting at raw[srcOff];
  // returns the reconstructed bytes and the new offset, or null on a bad
  // filter byte. Shared by the linear path (one pass) and Adam7 (7 passes).
  const defilter = (w: number, h: number, srcOff: number): { recon: Uint8Array; next: number } | null => {
    const rb = w * bpp;
    const out = new Uint8Array(rb * h);
    let prevRowOff = -1;
    for (let y = 0; y < h; y++) {
      if (srcOff >= raw.length) return null;
      const filterType = raw[srcOff++];
      const rowOff = y * rb;
      if (srcOff + rb > raw.length) return null;
      for (let x = 0; x < rb; x++) {
        const rawByte = raw[srcOff++];
        const a = x >= bpp ? out[rowOff + x - bpp] : 0;
        const b = prevRowOff >= 0 ? out[prevRowOff + x] : 0;
        const c = prevRowOff >= 0 && x >= bpp ? out[prevRowOff + x - bpp] : 0;
        let value: number;
        switch (filterType) {
          case 0:
            value = rawByte;
            break;
          case 1:
            value = rawByte + a;
            break;
          case 2:
            value = rawByte + b;
            break;
          case 3:
            value = rawByte + Math.floor((a + b) / 2);
            break;
          case 4:
            value = rawByte + paethPredictor(a, b, c);
            break;
          default:
            return null;
        }
        out[rowOff + x] = value & 255;
      }
      prevRowOff = rowOff;
    }
    return { recon: out, next: srcOff };
  };

  // Full-size reconstructed sample grid, row-major, bpp bytes per pixel.
  let recon: Uint8Array;
  if (!interlaced) {
    const expected = (width * bpp + 1) * height;
    if (raw.length < expected) return { ok: false, reason: "decompressed data too short" };
    const one = defilter(width, height, 0);
    if (!one) return { ok: false, reason: "bad scanline filter data" };
    recon = one.recon;
  } else {
    // Adam7 (PNG spec 8.2): 7 passes, each an independently-filtered
    // sub-image; pass pixel (px,py) lands at (xOrig + px*xStride,
    // yOrig + py*yStride) in the full image.
    const XO = [0, 4, 0, 2, 0, 1, 0];
    const YO = [0, 0, 4, 0, 2, 0, 1];
    const XS = [8, 8, 4, 4, 2, 2, 1];
    const YS = [8, 8, 8, 4, 4, 2, 2];
    recon = new Uint8Array(width * bpp * height);
    let off = 0;
    for (let pass = 0; pass < 7; pass++) {
      const pw = Math.ceil((width - XO[pass]) / XS[pass]);
      const ph = Math.ceil((height - YO[pass]) / YS[pass]);
      if (pw <= 0 || ph <= 0) continue;
      const sub = defilter(pw, ph, off);
      if (!sub) return { ok: false, reason: "bad scanline filter data (interlaced pass)" };
      off = sub.next;
      for (let py = 0; py < ph; py++) {
        const destY = YO[pass] + py * YS[pass];
        for (let px = 0; px < pw; px++) {
          const destX = XO[pass] + px * XS[pass];
          const so = (py * pw + px) * bpp;
          const dofs = (destY * width + destX) * bpp;
          for (let b2 = 0; b2 < bpp; b2++) recon[dofs + b2] = sub.recon[so + b2];
        }
      }
    }
  }

  // 16-bit samples downsample to 8 by taking the high byte (libpng's
  // png_set_strip_16); sampleAt reads channel `ch` of pixel index `pi`.
  const sampleAt = (pi: number, ch: number): number => recon[pi * bpp + ch * bytesPerSample];

  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const outPix = i * 4;
    if (colorType === 3) {
      const idx = recon[i]; // bitDepth 8 palette only (validated above)
      const po = idx * 3;
      if (palette !== null && po + 2 < palette.length) {
        pixels[outPix] = palette[po];
        pixels[outPix + 1] = palette[po + 1];
        pixels[outPix + 2] = palette[po + 2];
      }
      // tRNS carries one alpha byte per palette entry (entries past its
      // end are fully opaque, PNG spec 11.3.2.1).
      pixels[outPix + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
    } else if (colorType === 0) {
      const g = sampleAt(i, 0);
      pixels[outPix] = g;
      pixels[outPix + 1] = g;
      pixels[outPix + 2] = g;
      pixels[outPix + 3] = 255;
    } else if (colorType === 2) {
      pixels[outPix] = sampleAt(i, 0);
      pixels[outPix + 1] = sampleAt(i, 1);
      pixels[outPix + 2] = sampleAt(i, 2);
      pixels[outPix + 3] = 255;
    } else if (colorType === 4) {
      const g = sampleAt(i, 0);
      pixels[outPix] = g;
      pixels[outPix + 1] = g;
      pixels[outPix + 2] = g;
      pixels[outPix + 3] = sampleAt(i, 1);
    } else {
      pixels[outPix] = sampleAt(i, 0);
      pixels[outPix + 1] = sampleAt(i, 1);
      pixels[outPix + 2] = sampleAt(i, 2);
      pixels[outPix + 3] = sampleAt(i, 3);
    }
  }

  return { ok: true, image: { width, height, pixels } };
}
