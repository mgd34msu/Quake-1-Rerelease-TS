// Lifted from quake-2-re-ts src/qcommon/jpg.ts at 7e88015 (GPLv2, our own
// repo). Game-agnostic as-is: the original file had no engine imports at
// all (its own header explains why JPEG decoding lives in qcommon rather
// than being a port of any original id Quake II .c file -- vanilla never
// loaded .jpg at all). One change made here: the private `JpgDecodeError`
// class (used only internally, to unwind the recursive decode on malformed
// data before decodeJPG converts it to a `{ ok: false, reason }` result) now
// lives in src/lib/errors.ts, per this project's src/lib convention (a file
// under src/lib imports nothing from src/ outside src/lib; errors.ts is the
// one shared home for this kind of internal-signaling Error subclass). No
// other behavior change.
//
// JPEG (JFIF/baseline sequential DCT) decoding -- NOT a port of any file in
// the original id Quake II source (vanilla ref_gl/ref_soft only ever load
// PCX/WAL/TGA; see gl_image.ts's own header comment). Added so the retail
// re-release's shipped .jpg assets load: baseq2/pak0.pak's images.c texture
// format probe chain is "png jpg tga" (images.c:2258 in the reference
// engine) and the pak ships 198 .jpg files (all under vault/ and
// vault/preview/ -- promotional artwork the in-game "vault" unlockable
// gallery displays), none of which have a .png or .tga sibling.
//
// SURVEY (this unit's own pass over all 198 shipped .jpg files, reading
// every file's SOF marker/precision/component/sampling-factor bytes
// directly out of baseq2/pak0.pak -- see the task report for the full
// listing): every single one is SOF0 (baseline sequential DCT), 8-bit
// precision, 3 components (YCbCr), no arithmetic coding, no restart
// markers (no DRI segment in any of them). Subsampling splits two ways:
// 184 files 4:2:0 (H=2,V=2 on the Y component), 14 files 4:4:4 (H=1,V=1
// on every component, all under vault/preview/ or vault/*.jpg full-size
// concept art) -- no 4:2:2 example exists in the shipped data. A
// baseline-only decoder was therefore sufficient for 100% of the real
// retail data, and progressive (SOF2) support was originally left
// unimplemented (reported as "unsupported", never misdecoded). It has
// since been added as a scoped follow-up (this file's SOF2 branch) so
// that non-retail progressive JPEGs (mod/tool-authored content, or future
// retail updates) decode correctly instead of hard-failing; the baseline
// (SOF0) decode path below is untouched by that follow-up. 4:2:2 and
// restart-marker support were also implemented beyond what the retail
// survey required (both are simple extensions of the same general
// subsampling-factor and entropy-alignment logic already needed for
// 4:2:0), since a decoder that only handles the exact subsampling ratios
// seen in one snapshot of one pak is needlessly brittle.
//
// Scope, matching png.ts's "narrow deliberately" precedent:
//   - SOF0 (baseline sequential DCT) and SOF2 (progressive DCT, Huffman
//     coding) are supported. SOF1 (extended sequential), SOF3/SOF7
//     (lossless), SOF5/SOF6 (differential sequential/progressive),
//     SOF9-SOF15 (arithmetic-coded variants) are recognized by marker
//     byte and reported as `{ ok: false, reason: "unsupported JPEG
//     variant: ..." }` -- never misdecoded as baseline or progressive.
//   - 8-bit sample precision only (SOF0/SOF2's precision byte); 12-bit is
//     recognized and reported unsupported, matching png.ts's bit-depth
//     check.
//   - 1 (grayscale) or 3 (YCbCr) component scans only; anything else
//     (e.g. 4-component CMYK/YCCK, seen in some Adobe-authored JPEGs but
//     never in the shipped retail data) reports unsupported. This applies
//     to SOF2 as well, even though the spec permits up to 4 components in
//     a progressive frame (Table B.2) -- CMYK/YCCK was out of scope for
//     the baseline decoder and stays out of scope here.
//   - Arbitrary integer H/V sampling factors (1-4) per component -- not
//     hardcoded to 4:2:0/4:2:2/4:4:4 specifically, so any legal baseline
//     or progressive subsampling ratio decodes correctly.
//   - Baseline (SOF0): a single interleaved scan (one SOS) is supported;
//     a second SOS (non-interleaved multi-scan baseline, legal but
//     vanishingly rare and absent from the retail data) reports
//     unsupported rather than being silently dropped.
//   - Progressive (SOF2): an arbitrary number of scans is supported --
//     DC first scan and DC refinement scans (interleaved or
//     non-interleaved), AC first scans (spectral selection, one
//     component per scan, with end-of-band run coding), and AC
//     refinement scans (successive approximation, with correction bits
//     and ZRL) -- see decodeProgressiveScan and its helpers below.
//   - Restart markers (DRI/RSTn) are supported for both baseline and
//     progressive scans: DC predictors and (for progressive AC scans)
//     the end-of-band run counter reset, and the entropy bitstream
//     re-aligns to a byte boundary, at each restart interval boundary
//     (ITU-T T.81 B.1.1.5 Note 1 for the byte-alignment padding
//     convention; G.1.2.2's EOBRUN text and F.2.4.4/B.2.4.4 for restart
//     semantics generally).
// Anything outside that returns `{ ok: false }`, the same "recognized but
// not handled, degrade gracefully" shape LoadPCX/LoadTGA/decodePNG already
// use for their own out-of-spec inputs -- callers decide whether that's a
// soft failure (missing-asset fallback) or a hard error (Sys_Error),
// exactly like LoadPNG's existing `reason.startsWith("unsupported")` check
// in gl_image.ts (this decoder's "unsupported" reasons are written to be
// caught by the identical check).
//
// Algorithm notes (all hand-rolled per PORTING.md's "no external
// dependencies" rule -- png.ts's own hand-rolled inflate is the
// precedent; this file has no zlib-equivalent shortcut available since
// node:zlib doesn't do JPEG):
//   - Huffman decode uses the canonical BITS/HUFFVAL table-building
//     procedure from ITU-T T.81 Annex C.2 (generate_size_table /
//     generate_code_table) and the mincode/maxcode/valptr DECODE
//     procedure from Annex F.2.2.3 -- the standard, well-documented
//     approach, not a from-scratch design.
//   - The inverse DCT is the direct separable (row-pass then
//     column-pass) formulation of Annex A's IDCT formula: O(8^3) per
//     block via two 8x8 matrix multiplies against a precomputed cosine
//     basis, rather than a naive O(8^4) double sum. Not a fast
//     (AAN/Loeffler) IDCT -- correctness and readability over raw speed,
//     matching png.ts's own "hand-rolled, not hand-optimized" precedent.
//   - Chroma upsampling is nearest-neighbor (box replication): each
//     subsampled plane sample is read back via
//     `floor(fullResCoord * samplingFactor / maxSamplingFactor)`, the
//     simplest correct baseline reconstruction (real decoders often use
//     smarter interpolation, but nothing in the JPEG spec requires it).
//   - YCbCr->RGB uses the standard ITU-R BT.601 full-range JFIF formula.
//
// Progressive (SOF2) decoding model (ITU-T T.81 Annex G -- "Progressive
// DCT-based mode of operation"; Annex G.2 states decoder operation
// explicitly: "Decoder operation is defined by reversing the function of
// each step described in the encoder flow charts [Figures G.3-G.11], and
// performing the steps in reverse order" -- there are no decoder-side
// flowcharts in the spec for this mode, only encoder ones, by design):
//   - Unlike baseline's single scan that goes straight from Huffman-coded
//     bits to dequantized-and-IDCT'd pixels per block (decodeBlockInto),
//     a progressive frame spreads each block's 64 DCT coefficients across
//     many scans: a DC first scan plus zero or more DC refinement scans
//     (Ss=Se=0), and one AC first scan plus zero or more AC refinement
//     scans per contiguous spectral band (1<=Ss<=Se<=63) per component
//     (ITU-T T.81 A.4, G.1.1.1.1). This file accumulates each component's
//     raw (pre-dequantization) coefficient levels into a persistent
//     Int32Array (Component.coeffs, one 64-entry natural-order block per
//     entry, allocated once per component when SOF2 is parsed) that scans
//     progressively fill in and refine; only after every scan has been
//     processed does finalizeProgressive dequantize (ITU-T T.81 A.3.4)
//     and run the coefficients through the SAME idct8x8/pixel-store logic
//     baseline uses, so the existing dequant/IDCT/upsample/color-convert
//     stages are unchanged -- progressive decoding differs only in how
//     the 64 coefficients per block are assembled before that point.
//   - Successive approximation (ITU-T T.81 A.4, B.2.3's Ah/Al fields):
//     each scan of a spectral band codes coefficients at a fixed bit
//     position Al, refining a lower-precision version coded in an earlier
//     scan (Ah = the Al of the previous scan of that band; Ah=0 means
//     "first scan of this band"). The DC point transform is an
//     arithmetic shift right by Al at the encoder / a shift left by Al at
//     the decoder (A.4); the AC point transform is an integer divide by
//     2^Al at the encoder / a rescale by 2^Al at the decoder. This file
//     applies that rescale at the moment a coefficient is first written
//     (`<< al`) and applies later refinement scans as direct additions of
//     +-2^Al (DC: a single OR'd-in bit at position Al; AC: correction
//     bits per G.1.2.3, see below) -- so by the time finalizeProgressive
//     runs, every stored coefficient is already at full (Al=0) scale and
//     dequantization proceeds exactly like the baseline path's.
//   - DC coefficient decoding (ITU-T T.81 G.1.2.1): the first DC scan for
//     a component (Ah=0) is decoded exactly like baseline's DC coding
//     (F.2.2.1 EXTEND over a Huffman-coded magnitude category, added to a
//     running per-component predictor reset at each scan/restart), then
//     left-shifted by Al. A DC refinement scan (Ah!=0) carries no Huffman
//     coding at all -- G.1.2.1: "the least significant bits are appended
//     to the compressed bit stream without compression or modification"
//     -- so the decoder just reads one raw bit per block and ORs it into
//     the coefficient at bit position Al.
//   - AC first-scan decoding (ITU-T T.81 G.1.2.2, Table G.1, Figure G.2):
//     within a spectral band [Ss,Se], coefficients are decoded with the
//     same RRRRSSSS composite Huffman code as baseline AC decoding
//     (F.2.2.2), except the all-zero "EOB" code point is replaced by 15
//     EOBn codes (RRRR=0..14, SSSS=0) that each mean "the current block's
//     remaining band is zero, and so are the next N-1 blocks' entire
//     bands" -- Table G.1 gives the run length per EOBn (EOBn's range is
//     2^RRRR .. 2^(RRRR+1)-1, with RRRR extra bits selecting the exact
//     value, mirroring EXTEND's category encoding); RRRR=15,SSSS=0 (ZRL)
//     still means "16 zero coefficients" as in baseline. The end-of-band
//     run counter (EOBRUN) persists across blocks within a scan and is
//     reset to zero at the start of the scan and at each restart interval
//     (Table G.1's text, mirroring F.2.4.4/B.2.4.4's restart semantics).
//   - AC refinement-scan decoding (ITU-T T.81 G.1.2.3, Figures G.7-G.9,
//     reversed per G.2): this is the trickiest part of progressive JPEG.
//     Within a block's band, existing (non-zero-history) coefficients
//     each carry one "correction" bit (rule b, T.81 page 125): a 1-bit
//     means "add 2^Al to the coefficient's magnitude" (sign preserved).
//     RRRR in a composite code counts *zero-history* coefficients only,
//     skipping over (but still correcting) any non-zero-history
//     coefficients encountered along the way (T.81 page 124-125,
//     G.1.2.3's intro text) -- this file's inner skip loop in
//     decodeACRefineBlock implements exactly that rule. A composite code
//     with SSSS=1 introduces a newly non-zero coefficient of magnitude
//     2^Al with one sign bit following (rule a); ZRL (RRRR=15, SSSS=0)
//     skips exactly 16 zero-history coefficients (correcting any
//     non-zero-history ones passed over) without placing a value, and --
//     since RRRR can only directly express 0-15 -- longer zero-history
//     runs are ZRL-chained exactly like baseline/AC-first coding. An
//     EOBn code (SSSS=0, RRRR<15) sets EOBRUN and means "the rest of this
//     block's band, and the next EOBRUN-1 blocks' entire bands, get
//     correction bits only (no new coefficients)"; while EOBRUN>0, each
//     subsequent block in the scan applies correction bits to its
//     existing non-zero coefficients across the whole band and then
//     decrements EOBRUN, with no Huffman codes read for that block at
//     all.
//   - Interleaving (ITU-T T.81 clause 4.10, G.1.1.1.1): only DC scans may
//     interleave more than one component (decoded MCU-by-MCU exactly
//     like baseline); AC scans are always single-component
//     ("non-interleaved"), decoded in the component's own block-raster
//     order (A.2.2) rather than MCU order. A non-interleaved scan's block
//     grid is the *tight* grid derived straight from that component's own
//     sample dimensions (A.1.1: xi=ceil(X*Hi/Hmax), yi=ceil(Y*Vi/Vmax),
//     then ceil(./8) blocks each way) -- NOT the MCU-padded grid
//     (mcusPerLine*Hi etc.) baseline/interleaved-DC scans use, since
//     A.2.4's "extend to a whole number of blocks per Hi/Vi" padding rule
//     is explicitly conditioned on "if the component is to be
//     interleaved". The coefficient buffer itself is always sized to the
//     MCU-padded grid, though (that's what the DC scan already
//     allocated) -- so non-interleaved scans iterate the tight grid's
//     block *count* but still address the padded grid's *stride* when
//     computing each block's offset into Component.coeffs. Getting this
//     wrong is a classic progressive-decoder bug for subsampled (e.g.
//     4:2:0) images whose dimensions aren't exact multiples of 16;
//     Component.tightBlocksPerLine/tightBlocksPerColumn (loop bounds) vs
//     Component.coeffBlocksPerLine/coeffBlocksPerColumn (buffer stride,
//     also the plane dimensions) keep the two apart.
//   - Restart interval semantics (ITU-T T.81 B.2.4.4, clause 4.8.2): Ri
//     counts MCUs, and clause 4.8.2 defines "for non-interleaved data the
//     MCU is one data unit" -- so for a non-interleaved (AC, or
//     single-component DC) scan, Ri directly counts 8x8 blocks, exactly
//     like this file's restart-countdown loop already does for both scan
//     shapes.

import { JpgDecodeError } from "./errors";

export interface DecodedJpgT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down (row 0 is the
  // top scanline) -- alpha is always 255 (JPEG has no alpha channel) --
  // same shape/orientation as png.ts's DecodedPngT.pixels, so callers can
  // treat both the same way.
  pixels: Uint8Array;
}

export type DecodeJpgResultT = { ok: true; image: DecodedJpgT } | { ok: false; reason: string };

// Standard JPEG zigzag scan order: ZIGZAG[i] is the natural (row-major,
// 0..63) coefficient index stored at zigzag position i. (ITU-T T.81
// Figure A.6.)
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

// Precomputed 8-point IDCT cosine basis: COS[x][u] = cos((2x+1) * u * PI / 16).
const IDCT_COS: number[][] = (() => {
  const table: number[][] = [];
  for (let x = 0; x < 8; x++) {
    const row: number[] = [];
    for (let u = 0; u < 8; u++) {
      row.push(Math.cos(((2 * x + 1) * u * Math.PI) / 16));
    }
    table.push(row);
  }
  return table;
})();
const IDCT_C = [1 / Math.SQRT2, 1, 1, 1, 1, 1, 1, 1]; // C(u): 1/sqrt(2) for u=0, else 1

// Separable inverse DCT: block is 64 dequantized coefficients in natural
// (row-major, u + v*8) order; returns 64 spatial-domain samples in the
// range roughly [-128, 127] (still needs the +128 level shift by the
// caller), row-major (x + y*8).
function idct8x8(block: Float64Array): Float64Array {
  const tmp = new Float64Array(64); // after column pass: tmp[u + y*8]
  for (let u = 0; u < 8; u++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        sum += IDCT_C[v] * block[u + v * 8]! * IDCT_COS[y]![v]!;
      }
      tmp[u + y * 8] = sum * 0.5;
    }
  }
  const out = new Float64Array(64); // out[x + y*8]
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        sum += IDCT_C[u] * tmp[u + y * 8]! * IDCT_COS[x]![u]!;
      }
      out[x + y * 8] = sum * 0.5;
    }
  }
  return out;
}

interface HuffTable {
  mincode: Int32Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  huffval: number[];
}

// ITU-T T.81 Annex C.2: canonical Huffman table construction from the
// BITS (count of codes per length, 1..16) and HUFFVAL (symbols in
// code-length order) arrays straight out of a DHT segment.
function buildHuffmanTable(bits: number[], huffval: number[]): HuffTable {
  const huffsize: number[] = [];
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < (bits[l - 1] ?? 0); i++) huffsize.push(l);
  }
  const huffcode: number[] = [];
  let code = 0;
  let si = huffsize.length > 0 ? huffsize[0]! : 0;
  let k = 0;
  while (k < huffsize.length) {
    while (k < huffsize.length && huffsize[k] === si) {
      huffcode.push(code);
      code++;
      k++;
    }
    code <<= 1;
    si++;
  }

  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let p = 0;
  for (let l = 1; l <= 16; l++) {
    const count = bits[l - 1] ?? 0;
    if (count === 0) {
      maxcode[l] = -1;
    } else {
      valptr[l] = p;
      mincode[l] = huffcode[p]!;
      p += count;
      maxcode[l] = huffcode[p - 1]!;
    }
  }
  return { mincode, maxcode, valptr, huffval };
}

// Entropy-coded segment bit reader: MSB-first, with JPEG byte-stuffing
// (a literal 0xFF data byte is always followed by a stuffed 0x00, which
// this strips transparently). Hitting `0xFF <anything but 0x00>` mid-block
// means the entropy data ended early (marker or restart boundary reached
// before the decoder expected one) -- that's always a corrupt-stream
// condition from nextBit()'s point of view, since callers only ever pull
// exactly as many bits as a correctly-formed stream provides.
class BitReader {
  private buffer: Uint8Array;
  pos: number;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(buffer: Uint8Array, pos: number) {
    this.buffer = buffer;
    this.pos = pos;
  }

  nextBit(): number {
    if (this.bitCount === 0) {
      if (this.pos >= this.buffer.length) throw new JpgDecodeError("truncated JPEG entropy data");
      let b = this.buffer[this.pos]!;
      if (b === 0xff) {
        const next = this.buffer[this.pos + 1];
        if (next === 0x00) {
          this.pos += 2;
        } else {
          throw new JpgDecodeError("truncated JPEG entropy data (marker encountered before scan finished)");
        }
      } else {
        this.pos += 1;
      }
      this.bitBuf = b;
      this.bitCount = 8;
    }
    this.bitCount--;
    return (this.bitBuf >> this.bitCount) & 1;
  }

  receiveBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.nextBit();
    return v;
  }

  // Discards any partially-consumed byte so the reader sits on a byte
  // boundary, matching the encoder's restart-marker padding convention
  // (Annex F.2.2.7: the last incomplete byte before a restart marker is
  // padded with 1-bits and never re-examined).
  byteAlign(): void {
    this.bitCount = 0;
  }
}

function huffmanDecode(br: BitReader, table: HuffTable): number {
  let code = br.nextBit();
  let l = 1;
  while (l <= 16 && code > table.maxcode[l]!) {
    code = (code << 1) | br.nextBit();
    l++;
  }
  if (l > 16) throw new JpgDecodeError("corrupt Huffman code (no matching entry)");
  const idx = table.valptr[l]! + (code - table.mincode[l]!);
  const sym = table.huffval[idx];
  if (sym === undefined) throw new JpgDecodeError("corrupt Huffman code (symbol index out of range)");
  return sym;
}

// Annex F.2.2.1 EXTEND: sign-extends a `size`-bit unsigned value read from
// the bitstream into JPEG's signed magnitude-category coding.
function extend(v: number, size: number): number {
  if (size === 0) return 0;
  const vt = 1 << (size - 1);
  return v < vt ? v - (1 << size) + 1 : v;
}

interface Component {
  id: number;
  h: number;
  v: number;
  quantTableId: number;
  dcTableId: number;
  acTableId: number;
  planeWidth: number;
  planeHeight: number;
  plane: Uint8Array; // level-shifted back to 0..255 already
  dcPred: number;
  // Progressive (SOF2) only, below -- unused (empty/zero) for baseline.
  // Raw (pre-dequantization) coefficient levels accumulated across scans,
  // one 64-entry natural-order (not zigzag) block per entry. See the
  // "Progressive (SOF2) decoding model" comment above.
  coeffs: Int32Array;
  // Buffer stride/dimensions: the MCU-padded grid (mcusPerLine*h etc, the
  // same grid baseline's plane already uses), always used to compute a
  // block's offset into `coeffs` and `plane`.
  coeffBlocksPerLine: number;
  coeffBlocksPerColumn: number;
  // Loop bounds for a non-interleaved (AC, or single-component DC) scan:
  // the tight grid derived from this component's own sample dimensions
  // (ITU-T T.81 A.1.1/A.2.4) -- see the header comment's "Interleaving"
  // paragraph for why this differs from coeffBlocksPerLine/Column.
  tightBlocksPerLine: number;
  tightBlocksPerColumn: number;
}

const SOF_NAMES: Record<number, string> = {
  0xc1: "extended sequential DCT (SOF1)",
  0xc3: "lossless (SOF3)",
  0xc5: "differential sequential DCT (SOF5)",
  0xc6: "differential progressive DCT (SOF6)",
  0xc7: "differential lossless (SOF7)",
  0xc9: "arithmetic-coded extended sequential DCT (SOF9)",
  0xca: "arithmetic-coded progressive DCT (SOF10)",
  0xcb: "arithmetic-coded lossless (SOF11)",
  0xcd: "arithmetic-coded differential sequential DCT (SOF13)",
  0xce: "arithmetic-coded differential progressive DCT (SOF14)",
  0xcf: "arithmetic-coded differential lossless (SOF15)",
};

export function decodeJPG(buffer: Uint8Array): DecodeJpgResultT {
  try {
    return decodeJPGInner(buffer);
  } catch (e) {
    if (e instanceof JpgDecodeError) return { ok: false, reason: e.message };
    throw e;
  }
}

function decodeJPGInner(buffer: Uint8Array): DecodeJpgResultT {
  if (buffer.length < 4) return { ok: false, reason: "file too short" };
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return { ok: false, reason: "bad JPEG signature" };

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const quantTables = new Map<number, Int32Array>(); // 64 entries each, zigzag order
  const dcTables = new Map<number, HuffTable>();
  const acTables = new Map<number, HuffTable>();

  let precision = 0;
  let width = 0;
  let height = 0;
  let components: Component[] = [];
  let restartInterval = 0;
  let sawSOF = false;
  let sawSOS = false;
  let progressive = false;
  // Frame-level MCU grid (ITU-T T.81 A.1.1/A.2.1), needed by every
  // progressive scan and by the final coefficient-to-pixel pass; computed
  // once from ALL of the frame's components right after SOF2, since an AC
  // scan only lists a single component and can't derive maxH/maxV itself.
  let frameMaxH = 1;
  let frameMaxV = 1;
  let mcusPerLine = 0;
  let mcusPerColumn = 0;

  let pos = 2;
  while (pos < buffer.length) {
    if (buffer[pos] !== 0xff) return { ok: false, reason: "malformed marker segment" };
    let mpos = pos + 1;
    while (buffer[mpos] === 0xff) mpos++; // fill bytes
    const marker = buffer[mpos];
    pos = mpos + 1;
    if (marker === undefined) return { ok: false, reason: "truncated marker segment" };

    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM / stray RST: no length, no payload

    if (pos + 2 > buffer.length) return { ok: false, reason: "truncated marker segment" };
    const length = view.getUint16(pos, false);
    if (length < 2 || pos + length > buffer.length) return { ok: false, reason: "truncated marker segment" };
    const segStart = pos + 2;
    const segEnd = pos + length;

    if (marker === 0xc0 || marker === 0xc2) {
      // SOF0 -- baseline sequential DCT; SOF2 -- progressive DCT, Huffman
      // coding (ITU-T T.81 B.2.2 Figure B.3; Table B.2 lists SOF0/SOF2's
      // frame header as byte-for-byte identical: P, Y, X, Nf, then Nf
      // component-specification triples).
      progressive = marker === 0xc2;
      if (segEnd - segStart < 6) return { ok: false, reason: `malformed SOF${progressive ? "2" : "0"} segment` };
      precision = buffer[segStart]!;
      if (precision !== 8) return { ok: false, reason: `unsupported JPEG bit depth ${precision}` };
      height = view.getUint16(segStart + 1, false);
      width = view.getUint16(segStart + 3, false);
      const numComponents = buffer[segStart + 5]!;
      if (numComponents !== 1 && numComponents !== 3) {
        return { ok: false, reason: `unsupported JPEG component count ${numComponents}` };
      }
      if (segEnd - segStart < 6 + numComponents * 3) {
        return { ok: false, reason: `malformed SOF${progressive ? "2" : "0"} segment` };
      }
      components = [];
      for (let c = 0; c < numComponents; c++) {
        const off = segStart + 6 + c * 3;
        const id = buffer[off]!;
        const hv = buffer[off + 1]!;
        const h = hv >> 4;
        const v = hv & 0xf;
        if (h < 1 || h > 4 || v < 1 || v > 4) return { ok: false, reason: "unsupported JPEG sampling factor" };
        const quantTableId = buffer[off + 2]!;
        components.push({
          id,
          h,
          v,
          quantTableId,
          dcTableId: 0,
          acTableId: 0,
          planeWidth: 0,
          planeHeight: 0,
          plane: new Uint8Array(0),
          dcPred: 0,
          coeffs: new Int32Array(0),
          coeffBlocksPerLine: 0,
          coeffBlocksPerColumn: 0,
          tightBlocksPerLine: 0,
          tightBlocksPerColumn: 0,
        });
      }
      if (progressive) {
        // Allocate every component's coefficient-accumulation buffer and
        // pixel plane once, up front, sized to the MCU-padded grid (ITU-T
        // T.81 A.1.1/A.2.4) -- the same grid baseline's decodeScan builds
        // per-scan, but built once here since scans only partially fill
        // each block and later scans must accumulate into what earlier
        // scans already wrote.
        frameMaxH = Math.max(...components.map((c) => c.h));
        frameMaxV = Math.max(...components.map((c) => c.v));
        mcusPerLine = Math.ceil(width / (frameMaxH * 8));
        mcusPerColumn = Math.ceil(height / (frameMaxV * 8));
        for (const comp of components) {
          comp.coeffBlocksPerLine = mcusPerLine * comp.h;
          comp.coeffBlocksPerColumn = mcusPerColumn * comp.v;
          comp.planeWidth = comp.coeffBlocksPerLine * 8;
          comp.planeHeight = comp.coeffBlocksPerColumn * 8;
          comp.plane = new Uint8Array(comp.planeWidth * comp.planeHeight);
          comp.coeffs = new Int32Array(comp.coeffBlocksPerLine * comp.coeffBlocksPerColumn * 64);
          // Tight (non-MCU-padded) per-component grid for non-interleaved
          // scans -- ITU-T T.81 A.1.1's xi/yi formula, then blocks of 8.
          const xi = Math.ceil((width * comp.h) / frameMaxH);
          const yi = Math.ceil((height * comp.v) / frameMaxV);
          comp.tightBlocksPerLine = Math.ceil(xi / 8);
          comp.tightBlocksPerColumn = Math.ceil(yi / 8);
        }
      }
      sawSOF = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const name = SOF_NAMES[marker] ?? `SOF marker 0x${marker.toString(16)}`;
      return { ok: false, reason: `unsupported JPEG variant: ${name}` };
    } else if (marker === 0xdb) {
      // DQT
      let p = segStart;
      while (p < segEnd) {
        const pq = buffer[p]! >> 4;
        const tq = buffer[p]! & 0xf;
        p++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          if (pq === 0) {
            table[i] = buffer[p]!;
            p++;
          } else {
            table[i] = view.getUint16(p, false);
            p += 2;
          }
        }
        quantTables.set(tq, table);
      }
    } else if (marker === 0xc4) {
      // DHT
      let p = segStart;
      while (p < segEnd) {
        const classId = buffer[p]! >> 4;
        const tableId = buffer[p]! & 0xf;
        p++;
        const bits: number[] = [];
        for (let i = 0; i < 16; i++) bits.push(buffer[p + i]!);
        p += 16;
        const total = bits.reduce((a, b) => a + b, 0);
        const huffval: number[] = [];
        for (let i = 0; i < total; i++) huffval.push(buffer[p + i]!);
        p += total;
        const table = buildHuffmanTable(bits, huffval);
        if (classId === 0) dcTables.set(tableId, table);
        else acTables.set(tableId, table);
      }
    } else if (marker === 0xdd) {
      // DRI
      if (segEnd - segStart < 2) return { ok: false, reason: "malformed DRI segment" };
      restartInterval = view.getUint16(segStart, false);
    } else if (marker === 0xda) {
      // SOS (ITU-T T.81 B.2.3 Figure B.4): Ns, then Ns * (Csj, Tdj|Taj)
      // pairs, then Ss, Se, Ah|Al -- identical layout for baseline and
      // progressive; only the allowed *values* of Ss/Se/Ah/Al differ
      // (Table B.3).
      if (!progressive && sawSOS) return { ok: false, reason: "unsupported JPEG variant: multiple scans" };
      if (!sawSOF) return { ok: false, reason: "missing SOF marker" };
      const numScanComponents = buffer[segStart]!;
      if (segEnd - segStart < 1 + numScanComponents * 2 + 3) return { ok: false, reason: "malformed SOS segment" };
      const scanComponents: Component[] = [];
      for (let c = 0; c < numScanComponents; c++) {
        const off = segStart + 1 + c * 2;
        const selector = buffer[off]!;
        const tables = buffer[off + 1]!;
        const comp = components.find((cc) => cc.id === selector);
        if (!comp) return { ok: false, reason: "malformed SOS segment (unknown component selector)" };
        comp.dcTableId = tables >> 4;
        comp.acTableId = tables & 0xf;
        scanComponents.push(comp); // SOS order, not frame order (A.2.3)
      }
      const tailOff = segStart + 1 + numScanComponents * 2;
      const ss = buffer[tailOff]!;
      const se = buffer[tailOff + 1]!;
      const ahAl = buffer[tailOff + 2]!;
      const ah = ahAl >> 4;
      const al = ahAl & 0xf;

      if (progressive) {
        if (ss > se || se > 63) return { ok: false, reason: "malformed SOS segment (bad Ss/Se)" };
        const isDcScan = ss === 0;
        if (isDcScan && se !== 0) return { ok: false, reason: "malformed SOS segment (Se must be 0 when Ss is 0)" };
        if (!isDcScan && numScanComponents !== 1) {
          return { ok: false, reason: "malformed SOS segment (AC scan must be non-interleaved)" };
        }
        pos = decodeProgressiveScan(
          buffer,
          segEnd,
          scanComponents,
          ss,
          se,
          ah,
          al,
          dcTables,
          acTables,
          restartInterval,
          mcusPerLine,
          mcusPerColumn,
        );
      } else {
        // Entropy-coded data isn't length-prefixed (`length` above only
        // covers the scan header): decodeScan's own bit reader consumes
        // exactly the entropy-coded bytes (including any embedded restart
        // markers, which it handles itself) and its final position lands
        // right after the last consumed byte -- which, since baseline
        // encoders always pad the last partial byte to a boundary, is
        // exactly the next real marker (EOI for a single-scan image).
        // Deliberately NOT a byte-level re-scan for the next `0xFF <marker>`
        // pair from segEnd: restart markers are genuine unstuffed `0xFF Dx`
        // bytes embedded inside the entropy-coded data, so a naive re-scan
        // would latch onto the first one instead of the real trailing
        // marker.
        pos = decodeScan(buffer, segEnd, components, quantTables, dcTables, acTables, restartInterval, width, height);
      }
      sawSOS = true;
      continue;
    } else {
      // APPn / COM / DNL / DHP / EXP / reserved JPGn / anything else with
      // a standard length-prefixed payload: not needed for baseline
      // decode, skip.
    }

    pos = segEnd;
  }

  if (!sawSOF) return { ok: false, reason: "missing SOF marker" };
  if (!sawSOS) return { ok: false, reason: "missing SOS marker" };
  if (width <= 0 || height <= 0) return { ok: false, reason: "zero-size image" };

  // All progressive scans only accumulate coefficient levels (see the
  // "Progressive (SOF2) decoding model" header comment); dequantize and
  // IDCT every block now, once, through the same stage baseline's
  // decodeBlockInto uses per-block during its single scan.
  if (progressive) finalizeProgressive(components, quantTables);

  const pixels = renderOutput(components, width, height);
  return { ok: true, image: { width, height, pixels } };
}

// Decodes the entropy-coded scan data starting at `scanDataStart` and
// returns the buffer position immediately after the last byte it
// consumed -- see the SOS handler's call site for why that position (not
// a byte-level re-scan) is what the outer marker loop resumes from.
function decodeScan(
  buffer: Uint8Array,
  scanDataStart: number,
  components: Component[],
  quantTables: Map<number, Int32Array>,
  dcTables: Map<number, HuffTable>,
  acTables: Map<number, HuffTable>,
  restartInterval: number,
  width: number,
  height: number,
): number {
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcuWidthPx = maxH * 8;
  const mcuHeightPx = maxV * 8;
  const mcusPerLine = Math.ceil(width / mcuWidthPx);
  const mcusPerColumn = Math.ceil(height / mcuHeightPx);

  for (const comp of components) {
    comp.planeWidth = mcusPerLine * comp.h * 8;
    comp.planeHeight = mcusPerColumn * comp.v * 8;
    comp.plane = new Uint8Array(comp.planeWidth * comp.planeHeight);
    comp.dcPred = 0;
  }

  const br = new BitReader(buffer, scanDataStart);
  let mcusUntilRestart = restartInterval > 0 ? restartInterval : Infinity;
  const totalMcus = mcusPerLine * mcusPerColumn;
  let mcusDone = 0;

  for (let mcuY = 0; mcuY < mcusPerColumn; mcuY++) {
    for (let mcuX = 0; mcuX < mcusPerLine; mcuX++) {
      for (const comp of components) {
        const quant = quantTables.get(comp.quantTableId);
        const dcTable = dcTables.get(comp.dcTableId);
        const acTable = acTables.get(comp.acTableId);
        if (!quant) throw new JpgDecodeError("missing DQT table referenced by SOF");
        if (!dcTable || !acTable) throw new JpgDecodeError("missing DHT table referenced by SOS");

        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            decodeBlockInto(br, comp, quant, dcTable, acTable, mcuX, mcuY, bx, by);
          }
        }
      }

      mcusDone++;
      mcusUntilRestart--;
      if (mcusUntilRestart === 0 && mcusDone < totalMcus) {
        br.byteAlign();
        if (buffer[br.pos] !== 0xff || buffer[br.pos + 1] === undefined || !(buffer[br.pos + 1]! >= 0xd0 && buffer[br.pos + 1]! <= 0xd7)) {
          throw new JpgDecodeError("expected restart marker");
        }
        br.pos += 2;
        for (const comp of components) comp.dcPred = 0;
        mcusUntilRestart = restartInterval;
      }
    }
  }

  return br.pos;
}

function decodeBlockInto(
  br: BitReader,
  comp: Component,
  quant: Int32Array,
  dcTable: HuffTable,
  acTable: HuffTable,
  mcuX: number,
  mcuY: number,
  bx: number,
  by: number,
): void {
  const coeffs = new Float64Array(64); // natural order

  // DC
  const dcSize = huffmanDecode(br, dcTable);
  const dcDiffBits = dcSize > 0 ? br.receiveBits(dcSize) : 0;
  const dcDiff = extend(dcDiffBits, dcSize);
  comp.dcPred += dcDiff;
  coeffs[0] = comp.dcPred * quant[0]!;

  // AC
  let k = 1;
  while (k < 64) {
    const rs = huffmanDecode(br, acTable);
    const run = rs >> 4;
    const size = rs & 0xf;
    if (size === 0) {
      if (run === 15) {
        k += 16; // ZRL: 16 zero coefficients
        continue;
      }
      break; // EOB
    }
    k += run;
    if (k >= 64) throw new JpgDecodeError("corrupt AC coefficient run (out of block bounds)");
    const bits = br.receiveBits(size);
    const value = extend(bits, size);
    const zigzagIndex = k;
    const naturalIndex = ZIGZAG[zigzagIndex]!;
    coeffs[naturalIndex] = value * quant[zigzagIndex]!;
    k++;
  }

  const spatial = idct8x8(coeffs);

  const blockOriginX = (mcuX * comp.h + bx) * 8;
  const blockOriginY = (mcuY * comp.v + by) * 8;
  for (let y = 0; y < 8; y++) {
    const rowOff = (blockOriginY + y) * comp.planeWidth + blockOriginX;
    for (let x = 0; x < 8; x++) {
      const s = spatial[x + y * 8]! + 128;
      comp.plane[rowOff + x] = s < 0 ? 0 : s > 255 ? 255 : Math.round(s);
    }
  }
}

// Decodes one progressive scan's entropy-coded data, accumulating into
// each named component's Component.coeffs (see the "Progressive (SOF2)
// decoding model" header comment for the algorithm and its ITU-T T.81
// citations). Returns the buffer position immediately after the last
// consumed byte, same contract as decodeScan.
function decodeProgressiveScan(
  buffer: Uint8Array,
  scanDataStart: number,
  scanComponents: Component[],
  ss: number,
  se: number,
  ah: number,
  al: number,
  dcTables: Map<number, HuffTable>,
  acTables: Map<number, HuffTable>,
  restartInterval: number,
  mcusPerLine: number,
  mcusPerColumn: number,
): number {
  const br = new BitReader(buffer, scanDataStart);
  const isDcScan = ss === 0;
  // ITU-T T.81 clause 4.10/G.1.1.1.1: only DC scans may interleave more
  // than one component; the SOS parser already rejected a multi-component
  // AC scan, so `scanComponents.length > 1` here implies a DC scan.
  const interleaved = scanComponents.length > 1;

  for (const comp of scanComponents) comp.dcPred = 0;
  let eobrun = 0;

  const decodeOneUnit = (comp: Component, blockIndex: number): void => {
    if (isDcScan) {
      const dcTable = ah === 0 ? dcTables.get(comp.dcTableId) : undefined;
      if (ah === 0 && !dcTable) throw new JpgDecodeError("missing DHT table referenced by SOS");
      decodeDCBlock(br, comp, dcTable, ah, al, blockIndex);
    } else {
      const acTable = acTables.get(comp.acTableId);
      if (!acTable) throw new JpgDecodeError("missing DHT table referenced by SOS");
      eobrun =
        ah === 0
          ? decodeACFirstBlock(br, comp, acTable, ss, se, al, blockIndex, eobrun)
          : decodeACRefineBlock(br, comp, acTable, ss, se, al, blockIndex, eobrun);
    }
  };

  const restartAndResync = (): void => {
    br.byteAlign();
    if (buffer[br.pos] !== 0xff || buffer[br.pos + 1] === undefined || !(buffer[br.pos + 1]! >= 0xd0 && buffer[br.pos + 1]! <= 0xd7)) {
      throw new JpgDecodeError("expected restart marker");
    }
    br.pos += 2;
    for (const comp of scanComponents) comp.dcPred = 0;
    eobrun = 0; // Table G.1 text: EOBRUN resets at the start of each restart interval
  };

  if (interleaved) {
    // DC scan, MCU-interleaved: identical iteration shape to baseline's
    // decodeScan (A.2.3 interleaved ordering), just decoding one DC
    // coefficient (or its refinement bit) per block instead of a full
    // 64-coefficient block.
    let mcusUntilRestart = restartInterval > 0 ? restartInterval : Infinity;
    const totalMcus = mcusPerLine * mcusPerColumn;
    let mcusDone = 0;
    for (let mcuY = 0; mcuY < mcusPerColumn; mcuY++) {
      for (let mcuX = 0; mcuX < mcusPerLine; mcuX++) {
        for (const comp of scanComponents) {
          for (let by = 0; by < comp.v; by++) {
            for (let bx = 0; bx < comp.h; bx++) {
              const blockCol = mcuX * comp.h + bx;
              const blockRow = mcuY * comp.v + by;
              decodeOneUnit(comp, blockRow * comp.coeffBlocksPerLine + blockCol);
            }
          }
        }
        mcusDone++;
        mcusUntilRestart--;
        if (mcusUntilRestart === 0 && mcusDone < totalMcus) {
          restartAndResync();
          mcusUntilRestart = restartInterval;
        }
      }
    }
  } else {
    // Non-interleaved (AC scan, or a single-component DC scan): iterate
    // the component's own tight block grid (A.2.2 non-interleaved
    // ordering; A.1.1/A.2.4 for why this grid can be smaller than the
    // MCU-padded coeffBlocksPerLine/Column grid used for addressing) --
    // clause 4.8.2 defines the MCU as one data unit here, so the restart
    // interval directly counts blocks.
    const comp = scanComponents[0]!;
    const bpl = comp.tightBlocksPerLine;
    const bpc = comp.tightBlocksPerColumn;
    let unitsUntilRestart = restartInterval > 0 ? restartInterval : Infinity;
    const totalUnits = bpl * bpc;
    let unitsDone = 0;
    for (let row = 0; row < bpc; row++) {
      for (let col = 0; col < bpl; col++) {
        decodeOneUnit(comp, row * comp.coeffBlocksPerLine + col);
        unitsDone++;
        unitsUntilRestart--;
        if (unitsUntilRestart === 0 && unitsDone < totalUnits) {
          restartAndResync();
          unitsUntilRestart = restartInterval;
        }
      }
    }
  }

  return br.pos;
}

// ITU-T T.81 G.1.2.1, reversed per G.2: a DC first scan (ah === 0) decodes
// exactly like baseline DC coding (F.2.2.1 EXTEND over a Huffman-coded
// magnitude category, added to the running per-component predictor), then
// left-shifts by al (A.4's decoder-side point-transform rescale). A DC
// refinement scan (ah !== 0) has no entropy coding at all -- it's a single
// raw bit per block, OR'd into the coefficient at bit position al.
function decodeDCBlock(br: BitReader, comp: Component, dcTable: HuffTable | undefined, ah: number, al: number, blockIndex: number): void {
  const coeffOffset = blockIndex * 64;
  if (ah === 0) {
    const size = huffmanDecode(br, dcTable!);
    const diffBits = size > 0 ? br.receiveBits(size) : 0;
    const diff = extend(diffBits, size);
    comp.dcPred += diff;
    comp.coeffs[coeffOffset] = comp.dcPred << al;
  } else {
    const bit = br.nextBit();
    if (bit) comp.coeffs[coeffOffset] |= 1 << al;
  }
}

// ITU-T T.81 G.1.2.2 (Table G.1, Figure G.2), reversed per G.2: the first
// AC scan of a spectral band [ss,se]. Same RRRRSSSS composite Huffman
// code as baseline AC decoding, except SSSS=0 no longer means a single
// "EOB" -- RRRR=0..14 selects one of 15 EOBn codes, each meaning "this
// block's remaining band, and the next (run-1) blocks' entire bands, are
// zero" (run given by Table G.1: 2**RRRR, plus RRRR extra bits selecting
// the exact value within that range, mirroring EXTEND's category coding).
// RRRR=15 is still ZRL (16 zero coefficients), same as baseline. Returns
// the updated EOBRUN (persists across blocks within the scan).
function decodeACFirstBlock(
  br: BitReader,
  comp: Component,
  acTable: HuffTable,
  ss: number,
  se: number,
  al: number,
  blockIndex: number,
  eobrunIn: number,
): number {
  if (eobrunIn > 0) return eobrunIn - 1; // this block's whole band is covered by a pending EOB run
  const coeffOffset = blockIndex * 64;
  let eobrun = 0;
  let k = ss;
  while (k <= se) {
    const rs = huffmanDecode(br, acTable);
    const r = rs >> 4;
    const s = rs & 0xf;
    if (s === 0) {
      if (r < 15) {
        let run = 1 << r;
        if (r > 0) run += br.receiveBits(r);
        eobrun = run - 1; // this block is the first of the run; consume it now
        break;
      }
      k += 16; // ZRL
      continue;
    }
    k += r;
    if (k > se) throw new JpgDecodeError("corrupt progressive AC coefficient run (out of band bounds)");
    const bits = br.receiveBits(s);
    const value = extend(bits, s);
    comp.coeffs[coeffOffset + ZIGZAG[k]!] = value << al;
    k++;
  }
  return eobrun;
}

// ITU-T T.81 G.1.2.3 (Figures G.7-G.9), reversed per G.2: an AC
// successive-approximation (refinement) scan. Every existing non-zero
// coefficient in the band carries a one-bit "correction" (rule b, page
// 125: 1 means add 2**al to the magnitude, sign unchanged); RRRR in a
// composite code counts only *zero-history* coefficients, skipping over
// (but still correcting) any non-zero-history coefficients found along
// the way (page 124-125's "RRRR... the number of zero coefficients...
// skipped over when counting"). SSSS=1 introduces a newly non-zero
// coefficient of magnitude 2**al with a following sign bit (rule a); ZRL
// (RRRR=15, SSSS=0) skips zero-history coefficients the same way a
// value-placing code does, just with RRRR's literal decoded value (15,
// not 16) and no value placed at the position that resolves it -- since a
// single composite code's RRRR can only directly express 0-15, longer
// zero-history runs chain ZRLs exactly like baseline/AC-first coding. An
// EOBn code (SSSS=0, RRRR<15) sets EOBRUN; while EOBRUN>0, every
// subsequent block applies correction bits across its whole band and
// reads no Huffman codes at all.
//
// Composite-code boundary (the subtle part): once a composite code's
// RRRR budget is exhausted, its "job" ends at the very next position --
// whether that position is the fresh zero-history coefficient it
// resolves (place a value, or nothing for ZRL) or, if intervening
// coefficients are already non-zero, once those are corrected. Either
// way, resolution happens by unconditionally advancing one more position
// (this is what lets a lone value-placing/ZRL code and a following run of
// already-non-zero corrections share one composite code, and is also why
// RRRR's skip count for ZRL is 15 rather than 16 -- the 16th zero-history
// position is consumed by that same unconditional advance, not by an
// extra decrement): the very next Huffman code is always read immediately
// after, before any further already-non-zero corrections past that point
// are applied, not after them.
function decodeACRefineBlock(
  br: BitReader,
  comp: Component,
  acTable: HuffTable,
  ss: number,
  se: number,
  al: number,
  blockIndex: number,
  eobrunIn: number,
): number {
  const coeffOffset = blockIndex * 64;
  const positive = 1 << al;
  const negative = -positive;
  let eobrun = eobrunIn;
  let k = ss;

  // Rule b (page 125) only defines the correction for a coefficient not
  // already refined at this bit position this scan; guard against
  // re-applying it (matches the reference decoder's "skip if the target
  // bit is already set" check) even though well-formed input never visits
  // a position twice within one call.
  const applyCorrection = (idx: number): void => {
    const current = comp.coeffs[idx]!;
    if ((current & positive) !== 0) return;
    if (br.nextBit()) {
      comp.coeffs[idx] = current + (current > 0 ? positive : negative);
    }
  };

  if (eobrun === 0) {
    outer: while (k <= se) {
      const rs = huffmanDecode(br, acTable);
      const r = rs >> 4;
      const s = rs & 0xf;

      if (s === 0 && r < 15) {
        // EOBn: the rest of this block's band, plus the next (run-1)
        // blocks' whole bands, get correction bits only.
        let run = 1 << r;
        if (r > 0) run += br.receiveBits(r);
        eobrun = run;
        break;
      }

      // ZRL (s === 0, r === 15): 15 zero-history skips, then the 16th
      // zero-history position found also gets consumed (below) without a
      // value placed -- RRRR's literal decoded value, not 16 (see the
      // "composite-code boundary" note above). New coefficient (s !== 0,
      // always size 1 in refinement scans): r zero-history skips, then
      // place +-2**al at the (r+1)-th zero-history position per the
      // following sign bit.
      let zerosToSkip = s === 0 ? 15 : r;
      const placeValue = s !== 0;
      const newValue = placeValue ? (br.nextBit() ? positive : negative) : 0;

      while (k <= se) {
        const idx = coeffOffset + ZIGZAG[k]!;
        if (comp.coeffs[idx] !== 0) {
          applyCorrection(idx);
          k++;
          continue;
        }
        if (zerosToSkip > 0) {
          zerosToSkip--;
          k++;
          continue;
        }
        // The zero-history position that resolves this composite code:
        // place the new coefficient (if any), then unconditionally
        // advance past it -- this composite code's job ends exactly here,
        // so the very next position (zero-history or not) belongs to a
        // fresh composite code, read by resuming the outer loop
        // immediately.
        if (placeValue) comp.coeffs[idx] = newValue;
        k++;
        continue outer;
      }
    }
  }

  if (eobrun > 0) {
    while (k <= se) {
      const idx = coeffOffset + ZIGZAG[k]!;
      if (comp.coeffs[idx] !== 0) applyCorrection(idx);
      k++;
    }
    eobrun--;
  }
  return eobrun;
}

// Dequantizes (ITU-T T.81 A.3.4) and runs the IDCT for every block of
// every component once all progressive scans have been decoded, using
// the exact same idct8x8 + level-shift-and-clamp pipeline baseline's
// decodeBlockInto uses per-block during its single scan.
function finalizeProgressive(components: Component[], quantTables: Map<number, Int32Array>): void {
  for (const comp of components) {
    const quant = quantTables.get(comp.quantTableId);
    if (!quant) throw new JpgDecodeError("missing DQT table referenced by SOF");
    const totalBlocks = comp.coeffBlocksPerLine * comp.coeffBlocksPerColumn;
    for (let b = 0; b < totalBlocks; b++) {
      const blockOriginX = (b % comp.coeffBlocksPerLine) * 8;
      const blockOriginY = Math.floor(b / comp.coeffBlocksPerLine) * 8;
      renderCoeffBlock(comp, quant, b * 64, blockOriginX, blockOriginY);
    }
  }
}

function renderCoeffBlock(comp: Component, quant: Int32Array, coeffOffset: number, blockOriginX: number, blockOriginY: number): void {
  const dequantized = new Float64Array(64); // natural order, like decodeBlockInto's `coeffs`
  for (let zz = 0; zz < 64; zz++) {
    const nat = ZIGZAG[zz]!;
    dequantized[nat] = comp.coeffs[coeffOffset + nat]! * quant[zz]!;
  }
  const spatial = idct8x8(dequantized);
  for (let y = 0; y < 8; y++) {
    const rowOff = (blockOriginY + y) * comp.planeWidth + blockOriginX;
    for (let x = 0; x < 8; x++) {
      const s = spatial[x + y * 8]! + 128;
      comp.plane[rowOff + x] = s < 0 ? 0 : s > 255 ? 255 : Math.round(s);
    }
  }
}

function renderOutput(components: Component[], width: number, height: number): Uint8Array {
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const pixels = new Uint8Array(width * height * 4);

  if (components.length === 1) {
    const y = components[0]!;
    for (let py = 0; py < height; py++) {
      const sy = Math.floor((py * y.v) / maxV);
      for (let px = 0; px < width; px++) {
        const sx = Math.floor((px * y.h) / maxH);
        const val = y.plane[sy * y.planeWidth + sx]!;
        const o = (py * width + px) * 4;
        pixels[o] = val;
        pixels[o + 1] = val;
        pixels[o + 2] = val;
        pixels[o + 3] = 255;
      }
    }
    return pixels;
  }

  const yComp = components[0]!;
  const cbComp = components[1]!;
  const crComp = components[2]!;
  for (let py = 0; py < height; py++) {
    const ySy = Math.floor((py * yComp.v) / maxV);
    const cbSy = Math.floor((py * cbComp.v) / maxV);
    const crSy = Math.floor((py * crComp.v) / maxV);
    for (let px = 0; px < width; px++) {
      const ySx = Math.floor((px * yComp.h) / maxH);
      const cbSx = Math.floor((px * cbComp.h) / maxH);
      const crSx = Math.floor((px * crComp.h) / maxH);
      const Y = yComp.plane[ySy * yComp.planeWidth + ySx]!;
      const Cb = cbComp.plane[cbSy * cbComp.planeWidth + cbSx]! - 128;
      const Cr = crComp.plane[crSy * crComp.planeWidth + crSx]! - 128;

      const r = Y + 1.402 * Cr;
      const g = Y - 0.344136 * Cb - 0.714136 * Cr;
      const b = Y + 1.772 * Cb;

      const o = (py * width + px) * 4;
      pixels[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      pixels[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      pixels[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}
