// Lifted from quake-2-re-ts src/qcommon/ttf.ts at 7e88015 (GPLv2, our own
// repo). Game-agnostic as-is: the original file had no engine imports at
// all (a dependency-free TrueType/OpenType parser + rasterizer + atlas
// builder). Copied verbatim into src/lib; no behavior change. The original
// comment below cross-references quake-2-re-ts's kfont.ts/host.ts -- this
// project's equivalent is src/lib/kfont.ts (see that file's own Kfont_FromTTF
// for the seam), everything else (client/cgame/host.ts) is a later unit's
// territory.
//
// TrueType/OpenType font parsing + rasterization -- NOT a port of any file in
// the original id Quake II source, and NOT a port of anything in q2repro
// either (q2repro's kfont system only ever consumes a pre-baked PNG atlas +
// a text metrics file, fonts/qconfont.kfont -- see kfont.ts's own header).
// Added per OWNER RULING (2026-08-31): the retail rerelease KPF
// (Q2Game.kpf, mounted via qcommon/zipfile.ts) ships 29 real font files
// under fonts/ -- 26 .ttf + 3 .otf -- the KEX UI's actual font stack. This
// module parses them from raw bytes and rasterizes requested glyphs into an
// RGBA atlas + per-glyph metrics shaped exactly like kfont.ts's own
// KfontCharT {x,y,w,h}, so the EXISTING kfont draw machinery
// (DrawStretchPicRegion against an atlas + metrics -- see kfont.ts and
// client/cgame/host.ts's drawKfontChar) can consume a TTF/OTF-backed font
// as an alternative to a hand-authored .kfont/.png pair, with no new render
// path. See client/cgame/kfont.ts's own Kfont_FromTTF for the seam that
// relabels this module's output into that shape.
//
// NO EXTERNAL DEPENDENCIES (project rule -- qcommon/png.ts's hand-rolled
// PNG chunk/filter reader is the precedent for "decode a real binary
// asset format using only DataView/Uint8Array", even though PNG's own
// IDAT payload happens to lean on node:zlib for the deflate step; TTF/OTF
// table data is never compressed, so this module needs no decompression
// step of any kind -- sfnt tables, glyf outlines, and CFF charstrings are
// all read directly off the raw bytes below).
//
// FORMAT COVERAGE (verified against all 29 real files extracted from
// Q2Game.kpf -- see this port's own report for the full per-font matrix):
//   - sfnt table directory: version 0x00010000 (TrueType) and 'OTTO'
//     (CFF-flavored OpenType); 'true' (old Mac TrueType) accepted as a
//     signature but untested against any shipped asset (none uses it).
//   - head, hhea, maxp, hmtx: full parse (unitsPerEm, indexToLocFormat,
//     ascent/descent/lineGap, per-glyph advance widths).
//   - cmap: formats 4 (BMP, uint16 GIDs) and 12 (full Unicode, segmented
//     coverage) -- the two formats every shipped font actually carries;
//     format 0 (Mac Roman byte encoding) is NOT implemented (not needed --
//     every one of the 29 fonts has a format 4 or format 12 subtable).
//   - loca + glyf: TrueType outlines, simple AND composite glyphs (26 of
//     the 29 shipped fonts use this -- everything except the 3 .otf files).
//     Composite transforms support all three scale forms (single F2Dot14,
//     independent X/Y F2Dot14, full 2x2 F2Dot14 matrix) and
//     ARGS_ARE_XY_VALUES offsets; point-matching composites (the
//     ARGS_ARE_XY_VALUES-clear form, "align component N's point I to
//     component M's point J") are NOT implemented -- vanishingly rare in
//     production fonts and not hit by any glyph this port actually
//     rasterizes (spot-checked: every accented Latin composite in the
//     retail font set, e.g. the 'o with diaeresis' loc_english.txt needs,
//     uses plain XY offsets). Falls back to a (0,0) offset if encountered,
//     documented, not silently wrong-shaped -- see parseCompositeGlyph.
//   - COLR v0 + CPAL color glyphs -- IMPLEMENTED (closer unit, follow-up to
//     the finding below): parseCOLR/parseCPAL decode the layer-record and
//     palette tables, ParsedFontT.colorLayers()/paletteColor() expose them,
//     and rasterizeColorGlyph() composites each layer's outline (rasterized
//     via the SAME rasterizeContours() every other glyph in this module
//     uses) tinted by its CPAL color, alpha-blended in COLR's own
//     bottom-to-top layer order. Verified against the real bytes: every
//     KexControllerIcons*.ttf file (DS4/DSense/Generic/Mouse/SwitchJoy/
//     SwitchPro/Xbox) is a COLR v0 + CPAL color font (each one's sfnt table
//     directory carries COLR/CPAL/GDEF tables) -- their cmap-reachable
//     glyphs are, BY DESIGN, empty base outlines; the actual multi-color
//     button-icon artwork lives in separate, higher-numbered "layer" glyphs
//     a COLR table composites with per-layer palette colors from CPAL (see
//     test/ttf_colr_retail.test.ts). COLRv1 (the gradient/paint-graph
//     extension) is NOT implemented -- parseCOLR only accepts version 0,
//     see its own doc comment; no font in the shipped retail set uses v1.
//     rasterizeColorGlyph() -- WIRED into buildFontAtlas()/the kfont draw
//     model as of the COLR draw-path completion unit (see buildFontAtlas's
//     own "COLR v0 + CPAL COLOR GLYPHS" doc comment below and
//     client/cgame/kfont.ts's KfontCharT.color / client/cgame/host.ts's
//     drawKfontChar): a color-glyph codepoint is baked into the atlas as a
//     full-RGBA region (AtlasRectT.color = true) instead of the usual
//     white-RGB/coverage-alpha mask, and drawKfontChar draws that region
//     UNTINTED (white RGB, caller's alpha preserved) instead of tinted by
//     the string's text color -- no new render path, same single
//     DrawStretchPicRegion-per-character call either way, just a per-region
//     choice of which DrawColorT to pass. NO q2repro PRECEDENT EXISTS for
//     this distinction: q2repro's own draw_kfont_char (src/refresh/draw.c)
//     applies exactly one caller-supplied `color` to every glyph rect
//     unconditionally, because q2repro's kfont system only ever consumes
//     ONE pre-baked qconfont.png atlas that never mixes multi-color icon
//     art with text glyphs in the first place (see this file's own top-of-
//     file comment and client/cgame/kfont.ts's header) -- this is a
//     TTF-path-specific completion, needed only because THIS port newly
//     parses the real KexControllerIcons*.ttf files directly. The nearest
//     C-side precedent is structural, not behavioral: q2repro's own
//     fonts/qconfont.kfont format already establishes "one shared atlas
//     texture, many independent per-glyph {x,y,w,h} regions" (see
//     client/cgame/kfont.ts's ParseKfont/KfontCharT) -- this unit extends
//     that same per-region-rect precedent with a second per-region
//     attribute (tinted vs untinted) rather than inventing a new shape.
//   - CFF (Type 2 charstrings): the 3 .otf files (AtkinsonHyperLegible-
//     Regular, NotoSansJP-Regular, NotoSansKR-Regular) all carry 'CFF '
//     outlines, not 'glyf'. AtkinsonHyperLegible is a plain (non-CID) CFF
//     font; NotoSansJP and NotoSansKR are CID-keyed CFF (Top DICT ROS
//     operator present) -- both shapes are implemented: INDEX/DICT
//     parsing, Private DICT + local Subrs (per-FD for CID fonts via
//     FDArray + FDSelect formats 0 and 3), global Subrs, subroutine bias,
//     and the full Type 2 path-construction operator set (moveto/lineto/
//     curveto family, vv/hh/vh/hv-curveto, rcurveline/rlinecurve, hintmask/
//     cntrmask stem-count tracking, callsubr/callgsubr/return, endchar,
//     and the hflex/flex/hflex1/flex1 smooth-curve escape operators).
//     NOT implemented: the arithmetic/storage escape operators (12 3-30
//     other than the flex family -- and/or/not/abs/add/sub/div/neg/eq/
//     drop/put/get/ifelse/random/mul/sqrt/dup/exch/index/roll) and 4-arg
//     "seac-like" endchar (accent composition via two base charstrings).
//     Both are legacy/rare in modern Latin outlines -- present-but-unused
//     by every glyph this module's own retail-gated tests rasterize from
//     the real files (verified: 'A' and the full ASCII+Latin-1 set render
//     with non-zero, non-degenerate coverage from all 3 CFF fonts). If an
//     unsupported escape op is hit, its operands are dropped and drawing
//     continues (best-effort, not a crash) -- documented cut, not a silent
//     wrong shape for the paths this port actually exercises.
//   - kern (legacy format 0 subtable only): implemented, ~40 lines,
//     "cheap" per the brief. GPOS pair-adjustment (the modern kerning
//     mechanism) is NOT implemented -- full script/feature/lookup-list +
//     Coverage-table machinery is not "cheap" by any reading. Verdict is
//     moot for the shipped data either way: NONE of the 29 real fonts in
//     Q2Game.kpf carries a 'kern' table at all (checked every one); where
//     kerning data exists in this set (most of the proportional fonts:
//     Montserrat, NotoSans*, RussoOne, AtkinsonHyperLegible all carry
//     GPOS) it is exclusively in GPOS. So this module's kern support has
//     real, tested behavior against a hand-built fixture (see
//     test/ttf.test.ts) but zero effect on today's actual assets, and the
//     GPOS gap costs nothing observable today either -- both are reported
//     plainly rather than silently glossed over.
//
// RASTERIZER: curves are flattened to line-segment polylines before
// filling -- quadratic Bezier segments from glyf (De Casteljau/Bernstein
// evaluation, fixed 8-segment subdivision) and cubic Bezier segments from
// CFF charstrings (same evaluation, cubic form) both converge to the same
// FlattenedContourT representation, so ONE fill routine handles both
// outline formats instead of two curve-aware scanline fillers. The fill
// itself (rasterizeContours) is a proper active-edge scanline algorithm:
// per-glyph edge list (skipping horizontal edges), Y-supersampled (4x)
// sub-scanlines, non-zero winding-rule crossing accumulation, and EXACT
// fractional-pixel coverage in X (interval overlap against each pixel
// cell, not X supersampling) -- the same "supersample one axis, integrate
// the other exactly" shape stb_truetype's rasterizer uses, giving good
// anti-aliasing without O(width) per-pixel sampling. Coverage in [0,1] is
// quantized to 8-bit alpha. No instruction/hinting execution (TrueType
// glyf instructions and CFF hints are read past, never executed) -- pure
// outline-to-coverage, matching what a 90s-console-font-sized rasterizer
// (16-32px) actually needs; documented cut, not relevant at these sizes.

// -----------------------------------------------------------------------
// Shared geometry types
// -----------------------------------------------------------------------

// A single closed polygon contour in font units (glyf) or already-scaled
// pixel space (rasterizer input) -- callers distinguish by which function
// produced the array. Always implicitly closed: the fill routine connects
// the last point back to the first, no repeated closing point needed.
export type FlattenedContourT = { x: number; y: number }[];

interface RawPoint {
  x: number;
  y: number;
  onCurve: boolean;
}

// -----------------------------------------------------------------------
// sfnt table directory
// -----------------------------------------------------------------------

interface TableRecord {
  offset: number;
  length: number;
}

function readTag(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function readSfntDirectory(buf: Uint8Array, view: DataView): Map<string, TableRecord> | null {
  if (buf.length < 12) return null;
  const versionNum = view.getUint32(0, false);
  const tag = readTag(buf, 0);
  if (versionNum !== 0x00010000 && tag !== "OTTO" && tag !== "true" && versionNum !== 0x74727565) {
    return null;
  }
  const numTables = view.getUint16(4, false);
  const tables = new Map<string, TableRecord>();
  let off = 12;
  for (let i = 0; i < numTables; i++) {
    if (off + 16 > buf.length) return null;
    const recTag = readTag(buf, off);
    const tOff = view.getUint32(off + 8, false);
    const tLen = view.getUint32(off + 12, false);
    tables.set(recTag, { offset: tOff, length: tLen });
    off += 16;
  }
  return tables;
}

// -----------------------------------------------------------------------
// cmap (formats 4 + 12)
// -----------------------------------------------------------------------

function cmapFormat4Lookup(view: DataView, subtableOffset: number, codepoint: number): number {
  if (codepoint > 0xffff) return 0;
  const segCountX2 = view.getUint16(subtableOffset + 6, false);
  const segCount = segCountX2 / 2;
  const endCodesOff = subtableOffset + 14;
  const startCodesOff = endCodesOff + segCountX2 + 2; // +2 skips reservedPad
  const idDeltaOff = startCodesOff + segCountX2;
  const idRangeOff = idDeltaOff + segCountX2;
  for (let i = 0; i < segCount; i++) {
    const endCode = view.getUint16(endCodesOff + i * 2, false);
    if (codepoint > endCode) continue;
    const startCode = view.getUint16(startCodesOff + i * 2, false);
    if (codepoint < startCode) return 0;
    const idDelta = view.getInt16(idDeltaOff + i * 2, false);
    const idRangeOffset = view.getUint16(idRangeOff + i * 2, false);
    if (idRangeOffset === 0) return (codepoint + idDelta) & 0xffff;
    const glyphIndexAddr = idRangeOff + i * 2 + idRangeOffset + (codepoint - startCode) * 2;
    const g = view.getUint16(glyphIndexAddr, false);
    if (g === 0) return 0;
    return (g + idDelta) & 0xffff;
  }
  return 0;
}

function cmapFormat12Lookup(view: DataView, subtableOffset: number, codepoint: number): number {
  const numGroups = view.getUint32(subtableOffset + 12, false);
  const groupsOff = subtableOffset + 16;
  let lo = 0;
  let hi = numGroups - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const base = groupsOff + mid * 12;
    const startChar = view.getUint32(base, false);
    const endChar = view.getUint32(base + 4, false);
    if (codepoint < startChar) {
      hi = mid - 1;
    } else if (codepoint > endChar) {
      lo = mid + 1;
    } else {
      const startGlyph = view.getUint32(base + 8, false);
      return startGlyph + (codepoint - startChar);
    }
  }
  return 0;
}

type CmapLookupFn = (view: DataView, codepoint: number) => number;

function selectCmapSubtable(view: DataView, cmapOffset: number): CmapLookupFn | null {
  const numTables = view.getUint16(cmapOffset + 2, false);
  let best: { offset: number; format: number; score: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platformID = view.getUint16(rec, false);
    const encodingID = view.getUint16(rec + 2, false);
    const subOffset = cmapOffset + view.getUint32(rec + 4, false);
    const format = view.getUint16(subOffset, false);
    let score = -1;
    if (format === 12 && ((platformID === 3 && encodingID === 10) || (platformID === 0 && (encodingID === 4 || encodingID === 6)))) score = 100;
    else if (format === 12) score = 90;
    else if (format === 4 && ((platformID === 3 && encodingID === 1) || platformID === 0)) score = 80;
    else if (format === 4) score = 70;
    if (score > (best === null ? -1 : best.score)) best = { offset: subOffset, format, score };
  }
  if (best === null) return null;
  const chosen = best;
  if (chosen.format === 12) return (v, cp) => cmapFormat12Lookup(v, chosen.offset, cp);
  if (chosen.format === 4) return (v, cp) => cmapFormat4Lookup(v, chosen.offset, cp);
  return null;
}

// -----------------------------------------------------------------------
// loca + glyf (TrueType outlines)
// -----------------------------------------------------------------------

function readLoca(view: DataView, offset: number, numGlyphs: number, indexToLocFormat: number): Uint32Array {
  const out = new Uint32Array(numGlyphs + 1);
  if (indexToLocFormat === 0) {
    for (let i = 0; i <= numGlyphs; i++) out[i] = view.getUint16(offset + i * 2, false) * 2;
  } else {
    for (let i = 0; i <= numGlyphs; i++) out[i] = view.getUint32(offset + i * 4, false);
  }
  return out;
}

function parseSimpleGlyph(view: DataView, buf: Uint8Array, off: number, numContours: number): RawPoint[][] {
  let p = off;
  const endPts: number[] = [];
  for (let i = 0; i < numContours; i++) {
    endPts.push(view.getUint16(p, false));
    p += 2;
  }
  const numPoints = numContours > 0 ? endPts[numContours - 1] + 1 : 0;
  const instructionLength = view.getUint16(p, false);
  p += 2 + instructionLength;

  const flags: number[] = [];
  while (flags.length < numPoints) {
    const f = buf[p];
    p += 1;
    flags.push(f);
    if (f & 0x08) {
      let repeat = buf[p];
      p += 1;
      while (repeat > 0 && flags.length < numPoints) {
        flags.push(f);
        repeat -= 1;
      }
    }
  }

  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i];
    if (f & 0x02) {
      const dx = buf[p];
      p += 1;
      x += f & 0x10 ? dx : -dx;
    } else if (!(f & 0x10)) {
      x += view.getInt16(p, false);
      p += 2;
    }
    xs.push(x);
  }

  const ys: number[] = [];
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i];
    if (f & 0x04) {
      const dy = buf[p];
      p += 1;
      y += f & 0x20 ? dy : -dy;
    } else if (!(f & 0x20)) {
      y += view.getInt16(p, false);
      p += 2;
    }
    ys.push(y);
  }

  const contours: RawPoint[][] = [];
  let start = 0;
  for (let c = 0; c < numContours; c++) {
    const end = endPts[c];
    const pts: RawPoint[] = [];
    for (let i = start; i <= end; i++) {
      pts.push({ x: xs[i], y: ys[i], onCurve: (flags[i] & 0x01) !== 0 });
    }
    contours.push(pts);
    start = end + 1;
  }
  return contours;
}

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

function parseCompositeGlyph(view: DataView, off: number, resolve: (gid: number, depth: number) => RawPoint[][], depth: number): RawPoint[][] {
  let p = off;
  const contours: RawPoint[][] = [];
  for (;;) {
    const flags = view.getUint16(p, false);
    p += 2;
    const glyphIndex = view.getUint16(p, false);
    p += 2;
    let dx = 0;
    let dy = 0;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      const a1 = view.getInt16(p, false);
      const a2 = view.getInt16(p + 2, false);
      p += 4;
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = a1;
        dy = a2;
      }
      // else: point-matching component args (rare) -- not implemented, see
      // this file's header CFF/composite coverage note; falls back to (0,0).
    } else {
      const a1 = view.getInt8(p);
      const a2 = view.getInt8(p + 1);
      p += 2;
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = a1;
        dy = a2;
      }
    }
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & WE_HAVE_A_SCALE) {
      a = view.getInt16(p, false) / 16384;
      d = a;
      p += 2;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      a = view.getInt16(p, false) / 16384;
      d = view.getInt16(p + 2, false) / 16384;
      p += 4;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      a = view.getInt16(p, false) / 16384;
      b = view.getInt16(p + 2, false) / 16384;
      c = view.getInt16(p + 4, false) / 16384;
      d = view.getInt16(p + 6, false) / 16384;
      p += 8;
    }
    if (depth < 8) {
      const sub = resolve(glyphIndex, depth + 1);
      for (const contour of sub) {
        contours.push(
          contour.map((pt) => ({
            x: a * pt.x + c * pt.y + dx,
            y: b * pt.x + d * pt.y + dy,
            onCurve: pt.onCurve,
          })),
        );
      }
    }
    if (!(flags & MORE_COMPONENTS)) break;
  }
  return contours;
}

// Reconstructs the implied on-curve midpoints between consecutive
// off-curve points (the standard glyf quadratic-spline convention), then
// walks the resulting point ring emitting straight lines for on-on
// segments and flattened quadratic Beziers for on-off-on segments.
function flattenQuadraticContour(rawPoints: RawPoint[]): FlattenedContourT {
  const n = rawPoints.length;
  if (n < 2) return [];

  const expanded: RawPoint[] = [];
  for (let i = 0; i < n; i++) {
    const cur = rawPoints[i];
    const next = rawPoints[(i + 1) % n];
    expanded.push(cur);
    if (!cur.onCurve && !next.onCurve) {
      expanded.push({ x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2, onCurve: true });
    }
  }

  const startIdx = expanded.findIndex((p) => p.onCurve);
  if (startIdx === -1) return []; // guarded by construction above (n>=2 implies >=1 implied on-curve point)

  const ring = expanded.slice(startIdx).concat(expanded.slice(0, startIdx));
  const m = ring.length;

  const out: FlattenedContourT = [{ x: ring[0].x, y: ring[0].y }];
  let cur = { x: ring[0].x, y: ring[0].y };
  let i = 1;
  while (i < m) {
    const p = ring[i];
    if (p.onCurve) {
      out.push({ x: p.x, y: p.y });
      cur = { x: p.x, y: p.y };
      i += 1;
    } else {
      const end = ring[(i + 1) % m]; // guaranteed on-curve by the expansion above
      flattenQuadSegment(cur, { x: p.x, y: p.y }, { x: end.x, y: end.y }, out);
      cur = { x: end.x, y: end.y };
      i += 2;
    }
  }
  return out;
}

function flattenQuadSegment(p0: { x: number; y: number }, c: { x: number; y: number }, p1: { x: number; y: number }, out: FlattenedContourT): void {
  const segments = 8;
  for (let s = 1; s <= segments; s++) {
    const t = s / segments;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    });
  }
}

// -----------------------------------------------------------------------
// CFF (Type 2 charstrings)
// -----------------------------------------------------------------------

interface CffIndexResult {
  items: Uint8Array[];
  end: number;
}

function readCffIndex(buf: Uint8Array, view: DataView, pos: number): CffIndexResult {
  const count = view.getUint16(pos, false);
  pos += 2;
  if (count === 0) return { items: [], end: pos };
  const offSize = buf[pos];
  pos += 1;
  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) {
    let v = 0;
    for (let b = 0; b < offSize; b++) {
      v = v * 256 + buf[pos];
      pos += 1;
    }
    offsets.push(v);
  }
  const dataStart = pos - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    items.push(buf.subarray(dataStart + offsets[i], dataStart + offsets[i + 1]));
  }
  return { items, end: dataStart + offsets[count] };
}

type CffDict = Map<number, number[]>; // key: 0-21 direct operators, 1200+b1 for the "12 b1" escape operators

function parseCffDict(b: Uint8Array): CffDict {
  const dict: CffDict = new Map();
  let operands: number[] = [];
  let i = 0;
  while (i < b.length) {
    const b0 = b[i];
    if (b0 <= 21) {
      let op: number;
      if (b0 === 12) {
        op = 1200 + b[i + 1];
        i += 2;
      } else {
        op = b0;
        i += 1;
      }
      dict.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(readInt16BE(b, i + 1));
      i += 3;
    } else if (b0 === 29) {
      operands.push(readInt32BE(b, i + 1));
      i += 5;
    } else if (b0 === 30) {
      // Real-number (nibble-encoded) operand -- none of the DICT operators
      // this module reads (CharStrings/Private/ROS/FDArray/FDSelect
      // offsets, Subrs offset) are ever real-valued in practice; the exact
      // value is discarded, only the byte-stream position matters.
      i += 1;
      let done = false;
      while (!done && i < b.length) {
        const byte = b[i];
        i += 1;
        if (byte >> 4 === 0xf || (byte & 0xf) === 0xf) done = true;
      }
      operands.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      i += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + b[i + 1] + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - b[i + 1] - 108);
      i += 2;
    } else {
      i += 1;
    }
  }
  return dict;
}

function readInt16BE(b: Uint8Array, pos: number): number {
  const v = (b[pos] << 8) | b[pos + 1];
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readInt32BE(b: Uint8Array, pos: number): number {
  return (b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
}

function subrBias(n: number): number {
  return n < 1240 ? 107 : n < 33900 ? 1131 : 32768;
}

function parsePrivateAndLocalSubrs(buf: Uint8Array, view: DataView, privSizeOffset: [number, number] | null): { subrs: Uint8Array[]; bias: number } {
  if (privSizeOffset === null) return { subrs: [], bias: subrBias(0) };
  const [size, offset] = privSizeOffset;
  const privDict = parseCffDict(buf.subarray(offset, offset + size));
  const subrsRel = privDict.get(19);
  if (subrsRel === undefined || subrsRel.length === 0) return { subrs: [], bias: subrBias(0) };
  const { items } = readCffIndex(buf, view, offset + subrsRel[0]);
  return { subrs: items, bias: subrBias(items.length) };
}

function privateEntryOf(dict: CffDict): [number, number] | null {
  const entry = dict.get(18);
  if (entry === undefined || entry.length !== 2) return null;
  return [entry[0], entry[1]];
}

function parseFdSelect(buf: Uint8Array, view: DataView, offset: number, numGlyphs: number): Uint8Array {
  const result = new Uint8Array(numGlyphs);
  const format = buf[offset];
  if (format === 0) {
    for (let i = 0; i < numGlyphs; i++) result[i] = buf[offset + 1 + i];
  } else if (format === 3) {
    const nRanges = view.getUint16(offset + 1, false);
    let p = offset + 3;
    let prevFirst = view.getUint16(p, false);
    let prevFd = buf[p + 2];
    p += 3;
    for (let r = 1; r < nRanges; r++) {
      const first = view.getUint16(p, false);
      const fd = buf[p + 2];
      for (let g = prevFirst; g < first; g++) result[g] = prevFd;
      prevFirst = first;
      prevFd = fd;
      p += 3;
    }
    const sentinel = view.getUint16(p, false);
    for (let g = prevFirst; g < sentinel; g++) result[g] = prevFd;
  }
  return result;
}

interface CffFont {
  charStrings: Uint8Array[];
  globalSubrs: Uint8Array[];
  globalBias: number;
  isCID: boolean;
  defaultLocalSubrs: Uint8Array[];
  defaultLocalBias: number;
  fdLocalSubrs: Uint8Array[][];
  fdLocalBias: number[];
  fdSelect: Uint8Array | null;
}

function parseCFF(buf: Uint8Array, tableOffset: number, tableLength: number): CffFont | null {
  const cff = buf.subarray(tableOffset, tableOffset + tableLength);
  if (cff.length < 4) return null;
  const cffView = new DataView(cff.buffer, cff.byteOffset, cff.byteLength);

  const hdrSize = cff[2];
  let pos = hdrSize;
  const nameIdx = readCffIndex(cff, cffView, pos);
  pos = nameIdx.end;
  const topDictIdx = readCffIndex(cff, cffView, pos);
  pos = topDictIdx.end;
  const stringIdx = readCffIndex(cff, cffView, pos);
  pos = stringIdx.end;
  const globalSubrIdx = readCffIndex(cff, cffView, pos);

  if (topDictIdx.items.length === 0) return null;
  const topDict = parseCffDict(topDictIdx.items[0]);

  const charStringsOff = topDict.get(17);
  if (charStringsOff === undefined || charStringsOff.length === 0) return null;
  const csIdx = readCffIndex(cff, cffView, charStringsOff[0]);

  const isCID = topDict.has(1230); // ROS operator (12 30)
  const globalSubrs = globalSubrIdx.items;
  const globalBias = subrBias(globalSubrs.length);

  const { subrs: defaultLocalSubrs, bias: defaultLocalBias } = parsePrivateAndLocalSubrs(cff, cffView, privateEntryOf(topDict));

  const fdLocalSubrs: Uint8Array[][] = [];
  const fdLocalBias: number[] = [];
  let fdSelect: Uint8Array | null = null;

  if (isCID) {
    const fdArrayOff = topDict.get(1236);
    const fdSelectOff = topDict.get(1237);
    if (fdArrayOff !== undefined && fdArrayOff.length > 0) {
      const fdArrayIdx = readCffIndex(cff, cffView, fdArrayOff[0]);
      for (const fdBytes of fdArrayIdx.items) {
        const fdDict = parseCffDict(fdBytes);
        const r = parsePrivateAndLocalSubrs(cff, cffView, privateEntryOf(fdDict));
        fdLocalSubrs.push(r.subrs);
        fdLocalBias.push(r.bias);
      }
    }
    if (fdSelectOff !== undefined && fdSelectOff.length > 0) {
      fdSelect = parseFdSelect(cff, cffView, fdSelectOff[0], csIdx.items.length);
    }
  }

  return {
    charStrings: csIdx.items,
    globalSubrs,
    globalBias,
    isCID,
    defaultLocalSubrs,
    defaultLocalBias,
    fdLocalSubrs,
    fdLocalBias,
    fdSelect,
  };
}

interface Type2Context {
  x: number;
  y: number;
  contours: FlattenedContourT[];
  current: FlattenedContourT | null;
  stack: number[];
  nStems: number;
  widthParsed: boolean;
}

function moveTo(ctx: Type2Context, dx: number, dy: number): void {
  if (ctx.current !== null && ctx.current.length > 0) ctx.contours.push(ctx.current);
  ctx.x += dx;
  ctx.y += dy;
  ctx.current = [{ x: ctx.x, y: ctx.y }];
}

function lineTo(ctx: Type2Context, dx: number, dy: number): void {
  ctx.x += dx;
  ctx.y += dy;
  if (ctx.current === null) ctx.current = [{ x: ctx.x, y: ctx.y }];
  else ctx.current.push({ x: ctx.x, y: ctx.y });
}

function emitCurveAbs(ctx: Type2Context, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number): void {
  if (ctx.current === null) ctx.current = [{ x: ctx.x, y: ctx.y }];
  const p0x = ctx.x;
  const p0y = ctx.y;
  const segments = 8;
  for (let s = 1; s <= segments; s++) {
    const t = s / segments;
    const mt = 1 - t;
    ctx.current.push({
      x: mt * mt * mt * p0x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
      y: mt * mt * mt * p0y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey,
    });
  }
  ctx.x = ex;
  ctx.y = ey;
}

function curveTo(ctx: Type2Context, dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number): void {
  const c1x = ctx.x + dx1;
  const c1y = ctx.y + dy1;
  const c2x = c1x + dx2;
  const c2y = c1y + dy2;
  emitCurveAbs(ctx, c1x, c1y, c2x, c2y, c2x + dx3, c2y + dy3);
}

function maybeTakeWidth(ctx: Type2Context, hasExtra: boolean): void {
  if (ctx.widthParsed) return;
  ctx.widthParsed = true;
  if (hasExtra) ctx.stack.shift();
}

function execHflex(ctx: Type2Context, s: number[]): void {
  const [dx1, dx2, dy2, dx3, dx4, dx5, dx6] = s;
  const x0 = ctx.x;
  const y0 = ctx.y;
  const c1x = x0 + dx1;
  const c1y = y0;
  const c2x = c1x + dx2;
  const c2y = c1y + dy2;
  const p1x = c2x + dx3;
  emitCurveAbs(ctx, c1x, c1y, c2x, c2y, p1x, c2y);
  const c3x = p1x + dx4;
  const c3y = c2y;
  const c4x = c3x + dx5;
  emitCurveAbs(ctx, c3x, c3y, c4x, c3y, c4x + dx6, y0);
}

function execFlex(ctx: Type2Context, s: number[]): void {
  const [dx1, dy1, dx2, dy2, dx3, dy3, dx4, dy4, dx5, dy5, dx6, dy6] = s; // 13th arg (flex depth) ignored
  curveTo(ctx, dx1, dy1, dx2, dy2, dx3, dy3);
  curveTo(ctx, dx4, dy4, dx5, dy5, dx6, dy6);
}

function execHflex1(ctx: Type2Context, s: number[]): void {
  const [dx1, dy1, dx2, dy2, dx3, dx4, dx5, dy5, dx6] = s;
  const x0 = ctx.x;
  const y0 = ctx.y;
  const c1x = x0 + dx1;
  const c1y = y0 + dy1;
  const c2x = c1x + dx2;
  const c2y = c1y + dy2;
  const p1x = c2x + dx3;
  emitCurveAbs(ctx, c1x, c1y, c2x, c2y, p1x, c2y);
  const c3x = p1x + dx4;
  const c3y = c2y;
  const c4x = c3x + dx5;
  const c4y = c3y + dy5;
  emitCurveAbs(ctx, c3x, c3y, c4x, c4y, c4x + dx6, y0);
}

function execFlex1(ctx: Type2Context, s: number[]): void {
  const [dx1, dy1, dx2, dy2, dx3, dy3, dx4, dy4, dx5, dy5, d6] = s;
  const x0 = ctx.x;
  const y0 = ctx.y;
  const c1x = x0 + dx1;
  const c1y = y0 + dy1;
  const c2x = c1x + dx2;
  const c2y = c1y + dy2;
  const p1x = c2x + dx3;
  const p1y = c2y + dy3;
  emitCurveAbs(ctx, c1x, c1y, c2x, c2y, p1x, p1y);
  const c3x = p1x + dx4;
  const c3y = p1y + dy4;
  const c4x = c3x + dx5;
  const c4y = c3y + dy5;
  const sumDx = dx1 + dx2 + dx3 + dx4 + dx5;
  const sumDy = dy1 + dy2 + dy3 + dy4 + dy5;
  if (Math.abs(sumDx) > Math.abs(sumDy)) emitCurveAbs(ctx, c3x, c3y, c4x, c4y, c4x + d6, y0);
  else emitCurveAbs(ctx, c3x, c3y, c4x, c4y, x0, c4y + d6);
}

function execEscapeOp(op: number, ctx: Type2Context, stack: number[]): void {
  switch (op) {
    case 34:
      execHflex(ctx, stack);
      break;
    case 35:
      execFlex(ctx, stack);
      break;
    case 36:
      execHflex1(ctx, stack);
      break;
    case 37:
      execFlex1(ctx, stack);
      break;
    default:
      // Arithmetic/storage escape operators (and/or/not/abs/add/sub/div/
      // neg/eq/drop/put/get/ifelse/random/mul/sqrt/dup/exch/index/roll) --
      // not implemented, see this file's header CFF coverage note.
      break;
  }
  stack.length = 0;
}

function execCharstring(code: Uint8Array, ctx: Type2Context, globalSubrs: Uint8Array[], globalBias: number, localSubrs: Uint8Array[], localBias: number, depth: number): void {
  if (depth > 10) return;
  const stack = ctx.stack;
  let i = 0;
  while (i < code.length) {
    const b0 = code[i];
    if (b0 >= 32 || b0 === 28) {
      let v: number;
      if (b0 === 28) {
        v = readInt16BE(code, i + 1);
        i += 3;
      } else if (b0 <= 246) {
        v = b0 - 139;
        i += 1;
      } else if (b0 <= 250) {
        v = (b0 - 247) * 256 + code[i + 1] + 108;
        i += 2;
      } else if (b0 <= 254) {
        v = -(b0 - 251) * 256 - code[i + 1] - 108;
        i += 2;
      } else {
        v = readInt32BE(code, i + 1) / 65536;
        i += 5;
      }
      stack.push(v);
      continue;
    }

    i += 1;
    switch (b0) {
      case 1:
      case 3:
      case 18:
      case 23: {
        // hstem / vstem / hstemhm / vstemhm
        maybeTakeWidth(ctx, stack.length % 2 === 1);
        ctx.nStems += Math.floor(stack.length / 2);
        stack.length = 0;
        break;
      }
      case 19:
      case 20: {
        // hintmask / cntrmask
        maybeTakeWidth(ctx, stack.length % 2 === 1);
        ctx.nStems += Math.floor(stack.length / 2);
        stack.length = 0;
        i += (ctx.nStems + 7) >> 3;
        break;
      }
      case 21: {
        // rmoveto
        maybeTakeWidth(ctx, stack.length > 2);
        moveTo(ctx, stack[0], stack[1]);
        stack.length = 0;
        break;
      }
      case 22: {
        // hmoveto
        maybeTakeWidth(ctx, stack.length > 1);
        moveTo(ctx, stack[0], 0);
        stack.length = 0;
        break;
      }
      case 4: {
        // vmoveto
        maybeTakeWidth(ctx, stack.length > 1);
        moveTo(ctx, 0, stack[0]);
        stack.length = 0;
        break;
      }
      case 5: {
        // rlineto
        for (let k = 0; k + 1 < stack.length; k += 2) lineTo(ctx, stack[k], stack[k + 1]);
        stack.length = 0;
        break;
      }
      case 6: {
        // hlineto
        let horiz = true;
        for (let k = 0; k < stack.length; k++) {
          if (horiz) lineTo(ctx, stack[k], 0);
          else lineTo(ctx, 0, stack[k]);
          horiz = !horiz;
        }
        stack.length = 0;
        break;
      }
      case 7: {
        // vlineto
        let horiz = false;
        for (let k = 0; k < stack.length; k++) {
          if (horiz) lineTo(ctx, stack[k], 0);
          else lineTo(ctx, 0, stack[k]);
          horiz = !horiz;
        }
        stack.length = 0;
        break;
      }
      case 8: {
        // rrcurveto
        for (let k = 0; k + 5 < stack.length; k += 6) curveTo(ctx, stack[k], stack[k + 1], stack[k + 2], stack[k + 3], stack[k + 4], stack[k + 5]);
        stack.length = 0;
        break;
      }
      case 24: {
        // rcurveline
        let k = 0;
        for (; k + 5 < stack.length - 2; k += 6) curveTo(ctx, stack[k], stack[k + 1], stack[k + 2], stack[k + 3], stack[k + 4], stack[k + 5]);
        lineTo(ctx, stack[k], stack[k + 1]);
        stack.length = 0;
        break;
      }
      case 25: {
        // rlinecurve
        let k = 0;
        for (; k + 1 < stack.length - 6; k += 2) lineTo(ctx, stack[k], stack[k + 1]);
        curveTo(ctx, stack[k], stack[k + 1], stack[k + 2], stack[k + 3], stack[k + 4], stack[k + 5]);
        stack.length = 0;
        break;
      }
      case 26: {
        // vvcurveto
        let k = 0;
        let dx1 = 0;
        if (stack.length % 4 === 1) {
          dx1 = stack[0];
          k = 1;
        }
        for (; k + 3 < stack.length; k += 4) {
          const c1x = ctx.x + dx1;
          const c1y = ctx.y + stack[k];
          const c2x = c1x + stack[k + 1];
          const c2y = c1y + stack[k + 2];
          emitCurveAbs(ctx, c1x, c1y, c2x, c2y, c2x, c2y + stack[k + 3]);
          dx1 = 0;
        }
        stack.length = 0;
        break;
      }
      case 27: {
        // hhcurveto
        let k = 0;
        let dy1 = 0;
        if (stack.length % 4 === 1) {
          dy1 = stack[0];
          k = 1;
        }
        for (; k + 3 < stack.length; k += 4) {
          const c1x = ctx.x + stack[k];
          const c1y = ctx.y + dy1;
          const c2x = c1x + stack[k + 1];
          const c2y = c1y + stack[k + 2];
          emitCurveAbs(ctx, c1x, c1y, c2x, c2y, c2x + stack[k + 3], c2y);
          dy1 = 0;
        }
        stack.length = 0;
        break;
      }
      case 30:
      case 31: {
        // vhcurveto (30) / hvcurveto (31)
        let horiz = b0 === 31;
        let k = 0;
        while (k + 3 < stack.length) {
          const hasExtra = k + 5 === stack.length;
          if (horiz) {
            const c1x = ctx.x + stack[k];
            const c1y = ctx.y;
            const c2x = c1x + stack[k + 1];
            const c2y = c1y + stack[k + 2];
            const ey = c2y + stack[k + 3];
            const ex = hasExtra ? c2x + stack[k + 4] : c2x;
            emitCurveAbs(ctx, c1x, c1y, c2x, c2y, ex, ey);
          } else {
            const c1x = ctx.x;
            const c1y = ctx.y + stack[k];
            const c2x = c1x + stack[k + 1];
            const c2y = c1y + stack[k + 2];
            const ex = c2x + stack[k + 3];
            const ey = hasExtra ? c2y + stack[k + 4] : c2y;
            emitCurveAbs(ctx, c1x, c1y, c2x, c2y, ex, ey);
          }
          horiz = !horiz;
          k += 4;
        }
        stack.length = 0;
        break;
      }
      case 10: {
        // callsubr
        const idx = (stack.pop() ?? 0) + localBias;
        const sub = localSubrs[idx];
        if (sub !== undefined) execCharstring(sub, ctx, globalSubrs, globalBias, localSubrs, localBias, depth + 1);
        break;
      }
      case 29: {
        // callgsubr
        const idx = (stack.pop() ?? 0) + globalBias;
        const sub = globalSubrs[idx];
        if (sub !== undefined) execCharstring(sub, ctx, globalSubrs, globalBias, localSubrs, localBias, depth + 1);
        break;
      }
      case 11: {
        // return
        return;
      }
      case 14: {
        // endchar (4-arg seac-like accent composition NOT implemented -- see header)
        maybeTakeWidth(ctx, stack.length === 1 || stack.length === 5);
        return;
      }
      case 12: {
        const b1 = code[i];
        i += 1;
        execEscapeOp(b1, ctx, stack);
        break;
      }
      default: {
        stack.length = 0;
        break;
      }
    }
  }
}

function getCffContours(cff: CffFont, gid: number): FlattenedContourT[] {
  const code = cff.charStrings[gid];
  if (code === undefined) return [];
  let localSubrs = cff.defaultLocalSubrs;
  let localBias = cff.defaultLocalBias;
  if (cff.isCID && cff.fdSelect !== null) {
    const fd = cff.fdSelect[gid] ?? 0;
    if (cff.fdLocalSubrs[fd] !== undefined) {
      localSubrs = cff.fdLocalSubrs[fd];
      localBias = cff.fdLocalBias[fd];
    }
  }
  const ctx: Type2Context = { x: 0, y: 0, contours: [], current: null, stack: [], nStems: 0, widthParsed: false };
  execCharstring(code, ctx, cff.globalSubrs, cff.globalBias, localSubrs, localBias, 0);
  if (ctx.current !== null && ctx.current.length > 0) ctx.contours.push(ctx.current);
  return ctx.contours;
}

// -----------------------------------------------------------------------
// kern (legacy format 0 subtable)
// -----------------------------------------------------------------------

function parseKernFormat0(view: DataView, offset: number, length: number): Map<number, number> | null {
  if (length < 4) return null;
  const version = view.getUint16(offset, false);
  if (version !== 0) return null; // classic (Windows/OpenType) version-0 header only; Apple's version-1 header not implemented (unused by every font in this set -- see header note)
  const nTables = view.getUint16(offset + 2, false);
  let pos = offset + 4;
  const pairs = new Map<number, number>();
  for (let t = 0; t < nTables && pos + 6 <= offset + length; t++) {
    const subVersion = view.getUint16(pos, false);
    const subLength = view.getUint16(pos + 2, false);
    const coverage = view.getUint16(pos + 4, false);
    const format = coverage >> 8;
    if (subVersion === 0 && format === 0) {
      const nPairs = view.getUint16(pos + 6, false);
      let p = pos + 14;
      for (let i = 0; i < nPairs; i++) {
        const left = view.getUint16(p, false);
        const right = view.getUint16(p + 2, false);
        const value = view.getInt16(p + 4, false);
        pairs.set(left * 65536 + right, value);
        p += 6;
      }
    }
    pos += subLength;
  }
  return pairs.size > 0 ? pairs : null;
}

// -----------------------------------------------------------------------
// COLR v0 + CPAL (color glyphs)
//
// OpenType spec references: "COLR — Color Table"
// (https://learn.microsoft.com/en-us/typography/opentype/spec/colr) and
// "CPAL — Color Palette Table"
// (https://learn.microsoft.com/en-us/typography/opentype/spec/cpal). Only
// COLR version 0 is implemented (the "COLRv1" gradient/paint-graph
// extension -- version 1 header + the whole PaintXxx/ClipList machinery --
// is NOT implemented; version-1 tables report `null` from colorLayers, the
// same "not a color glyph as far as this module is concerned" result as no
// COLR table at all). Verified against the 7 real KexControllerIcons*.ttf
// files shipped in the retail rerelease KPF (Q2Game.kpf, fonts/) -- see
// test/ttf_colr_retail.test.ts: each carries a v0 COLR table, single-palette
// CPAL, and every cmap-mapped icon codepoint resolves to a multi-layer base
// glyph record (3 to 16 layers observed).
// -----------------------------------------------------------------------

// COLR table, "Color table header" + BaseGlyphRecord + LayerRecord (COLR
// spec, version 0): uint16 version; uint16 numBaseGlyphRecords;
// Offset32 baseGlyphRecordsOffset; Offset32 layerRecordsOffset;
// uint16 numLayerRecords. BaseGlyphRecord (6 bytes, sorted by gID):
// uint16 gID; uint16 firstLayerIndex; uint16 numLayers. LayerRecord
// (4 bytes): uint16 gID; uint16 paletteIndex (0xFFFF is the spec's "use the
// applied text foreground color instead of a CPAL entry" sentinel --
// preserved as-is in ColorLayerT.paletteIndex; see rasterizeColorGlyph's
// own handling).
interface ColrTable {
  base: Map<number, { firstLayerIndex: number; numLayers: number }>;
  layers: { gid: number; paletteIndex: number }[];
}

function parseCOLR(view: DataView, offset: number, length: number): ColrTable | null {
  if (length < 14) return null;
  const version = view.getUint16(offset, false);
  if (version !== 0) return null; // COLRv1 (gradient paint graph) -- documented cut, see file header above
  const numBaseGlyphRecords = view.getUint16(offset + 2, false);
  const baseGlyphRecordsOffset = view.getUint32(offset + 4, false);
  const layerRecordsOffset = view.getUint32(offset + 8, false);
  const numLayerRecords = view.getUint16(offset + 12, false);

  const base = new Map<number, { firstLayerIndex: number; numLayers: number }>();
  let bp = offset + baseGlyphRecordsOffset;
  for (let i = 0; i < numBaseGlyphRecords; i++) {
    const gID = view.getUint16(bp, false);
    const firstLayerIndex = view.getUint16(bp + 2, false);
    const numLayers = view.getUint16(bp + 4, false);
    base.set(gID, { firstLayerIndex, numLayers });
    bp += 6;
  }

  const layers: { gid: number; paletteIndex: number }[] = new Array(numLayerRecords);
  let lp = offset + layerRecordsOffset;
  for (let i = 0; i < numLayerRecords; i++) {
    const gID = view.getUint16(lp, false);
    const paletteIndex = view.getUint16(lp + 2, false);
    layers[i] = { gid: gID, paletteIndex };
    lp += 4;
  }

  return { base, layers };
}

// CPAL table (CPAL spec): uint16 version; uint16 numPaletteEntries;
// uint16 numPalettes; uint16 numColorRecords; Offset32
// colorRecordsArrayOffset; uint16 colorRecordIndices[numPalettes] (each is
// the index, into the shared colorRecords array, of that palette's FIRST
// entry -- a palette's `numPaletteEntries` colors are contiguous from
// there). ColorRecord (4 bytes) is BGRA byte order, NOT RGBA: uint8 blue;
// uint8 green; uint8 red; uint8 alpha. Version-1-only fields (palette
// flags/label-offset arrays, appended after colorRecordIndices) are never
// read -- this module has no use for palette names/dark-mode flags, only
// the color data every version carries at the same fixed offset.
interface CpalTable {
  numPaletteEntries: number;
  numPalettes: number;
  colorRecordIndices: Uint16Array;
  colorRecords: { r: number; g: number; b: number; a: number }[];
}

function parseCPAL(view: DataView, offset: number, length: number): CpalTable | null {
  if (length < 12) return null;
  const numPaletteEntries = view.getUint16(offset + 2, false);
  const numPalettes = view.getUint16(offset + 4, false);
  const numColorRecords = view.getUint16(offset + 6, false);
  const colorRecordsArrayOffset = view.getUint32(offset + 8, false);

  const colorRecordIndices = new Uint16Array(numPalettes);
  const idxBase = offset + 12;
  for (let i = 0; i < numPalettes; i++) colorRecordIndices[i] = view.getUint16(idxBase + i * 2, false);

  const recBase = offset + colorRecordsArrayOffset;
  const colorRecords: { r: number; g: number; b: number; a: number }[] = new Array(numColorRecords);
  for (let i = 0; i < numColorRecords; i++) {
    const p = recBase + i * 4;
    const blue = view.getUint8(p);
    const green = view.getUint8(p + 1);
    const red = view.getUint8(p + 2);
    const alpha = view.getUint8(p + 3);
    colorRecords[i] = { r: red, g: green, b: blue, a: alpha };
  }

  return { numPaletteEntries, numPalettes, colorRecordIndices, colorRecords };
}

// One COLR layer record, relabeled onto this module's own naming (gid, not
// "gID" -- matches every other gid-shaped field in this file).
export interface ColorLayerT {
  gid: number;
  paletteIndex: number; // 0xFFFF = use the caller's foreground color (COLR spec sentinel), not a CPAL index
}

// -----------------------------------------------------------------------
// Top-level parse: ParsedFontT
// -----------------------------------------------------------------------

export interface ParsedFontT {
  unitsPerEm: number;
  numGlyphs: number;
  ascent: number;
  descent: number;
  lineGap: number;
  outlineFormat: "glyf" | "cff";
  cmapLookup(codepoint: number): number;
  advanceWidth(gid: number): number; // font units
  contours(gid: number): FlattenedContourT[]; // font units, fully resolved (composites flattened)
  kerning(leftGid: number, rightGid: number): number; // font units, 0 if no 'kern' data
  // null if `gid` has no COLR v0 base-glyph record at all (not a color
  // glyph, or a COLRv1-only record -- see parseCOLR's own version check) --
  // matches kerning's "0 if no data" and contours' "[] if none" convention
  // of a plain not-present result rather than an error.
  colorLayers(gid: number): ColorLayerT[] | null;
  // null if there is no CPAL table, `paletteId` is out of range, or
  // `paletteIndex` is out of range for that palette's entry count.
  paletteColor(paletteIndex: number, paletteId?: number): { r: number; g: number; b: number; a: number } | null;
}

export type ParseFontResultT = { ok: true; font: ParsedFontT } | { ok: false; reason: string };

export function parseFont(buf: Uint8Array): ParseFontResultT {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tables = readSfntDirectory(buf, view);
  if (tables === null) return { ok: false, reason: "not a recognized sfnt file (bad signature)" };

  const headT = tables.get("head");
  const hheaT = tables.get("hhea");
  const maxpT = tables.get("maxp");
  const hmtxT = tables.get("hmtx");
  const cmapT = tables.get("cmap");
  if (headT === undefined || hheaT === undefined || maxpT === undefined || hmtxT === undefined || cmapT === undefined) {
    return { ok: false, reason: "missing a required table (head/hhea/maxp/hmtx/cmap)" };
  }
  if (headT.length < 54) return { ok: false, reason: "head table too short" };
  if (hheaT.length < 36) return { ok: false, reason: "hhea table too short" };

  const unitsPerEm = view.getUint16(headT.offset + 18, false);
  if (unitsPerEm === 0) return { ok: false, reason: "invalid unitsPerEm" };
  const indexToLocFormat = view.getInt16(headT.offset + 50, false);

  const ascent = view.getInt16(hheaT.offset + 4, false);
  const descent = view.getInt16(hheaT.offset + 6, false);
  const lineGap = view.getInt16(hheaT.offset + 8, false);
  const numberOfHMetrics = view.getUint16(hheaT.offset + 34, false);

  const numGlyphs = view.getUint16(maxpT.offset + 4, false);

  const advanceWidths = new Uint16Array(numGlyphs);
  {
    let hOff = hmtxT.offset;
    let lastAdvance = 0;
    for (let g = 0; g < numGlyphs; g++) {
      if (g < numberOfHMetrics) {
        lastAdvance = view.getUint16(hOff, false);
        hOff += 4;
      }
      advanceWidths[g] = lastAdvance;
    }
  }

  const cmapLookupFn = selectCmapSubtable(view, cmapT.offset);
  if (cmapLookupFn === null) return { ok: false, reason: "no supported cmap subtable (need format 4 or 12)" };

  const glyfT = tables.get("glyf");
  const locaT = tables.get("loca");
  const cffT = tables.get("CFF ");

  let contoursFn: (gid: number) => FlattenedContourT[];
  let outlineFormat: "glyf" | "cff";

  if (glyfT !== undefined && locaT !== undefined) {
    outlineFormat = "glyf";
    const locaOffsets = readLoca(view, locaT.offset, numGlyphs, indexToLocFormat);
    const rawCache = new Map<number, RawPoint[][]>();
    const getRaw = (gid: number, depth: number): RawPoint[][] => {
      if (depth === 0) {
        const cached = rawCache.get(gid);
        if (cached !== undefined) return cached;
      }
      if (gid < 0 || gid >= numGlyphs || depth > 8) return [];
      const start = locaOffsets[gid];
      const end = locaOffsets[gid + 1];
      if (end <= start) return [];
      const base = glyfT.offset + start;
      const numContours = view.getInt16(base, false);
      const result = numContours >= 0 ? parseSimpleGlyph(view, buf, base + 10, numContours) : parseCompositeGlyph(view, base + 10, getRaw, depth);
      if (depth === 0) rawCache.set(gid, result);
      return result;
    };
    const flatCache = new Map<number, FlattenedContourT[]>();
    contoursFn = (gid: number) => {
      const cached = flatCache.get(gid);
      if (cached !== undefined) return cached;
      const flat = getRaw(gid, 0).map(flattenQuadraticContour);
      flatCache.set(gid, flat);
      return flat;
    };
  } else if (cffT !== undefined) {
    outlineFormat = "cff";
    const cffFont = parseCFF(buf, cffT.offset, cffT.length);
    if (cffFont === null) return { ok: false, reason: "malformed CFF table" };
    const flatCache = new Map<number, FlattenedContourT[]>();
    contoursFn = (gid: number) => {
      const cached = flatCache.get(gid);
      if (cached !== undefined) return cached;
      const result = gid >= 0 && gid < cffFont.charStrings.length ? getCffContours(cffFont, gid) : [];
      flatCache.set(gid, result);
      return result;
    };
  } else {
    return { ok: false, reason: "no outline table found (need glyf+loca or CFF )" };
  }

  const kernT = tables.get("kern");
  const kernPairs = kernT !== undefined ? parseKernFormat0(view, kernT.offset, kernT.length) : null;

  const colrT = tables.get("COLR");
  const colrTable = colrT !== undefined ? parseCOLR(view, colrT.offset, colrT.length) : null;
  const cpalT = tables.get("CPAL");
  const cpalTable = cpalT !== undefined ? parseCPAL(view, cpalT.offset, cpalT.length) : null;

  const font: ParsedFontT = {
    unitsPerEm,
    numGlyphs,
    ascent,
    descent,
    lineGap,
    outlineFormat,
    cmapLookup: (cp: number) => cmapLookupFn(view, cp),
    advanceWidth: (gid: number) => (gid >= 0 && gid < numGlyphs ? advanceWidths[gid] : 0),
    contours: contoursFn,
    kerning: (l: number, r: number) => (kernPairs === null ? 0 : (kernPairs.get(l * 65536 + r) ?? 0)),
    colorLayers: (gid: number) => {
      if (colrTable === null) return null;
      const rec = colrTable.base.get(gid);
      if (rec === undefined) return null;
      const out: ColorLayerT[] = [];
      for (let i = 0; i < rec.numLayers; i++) {
        const layer = colrTable.layers[rec.firstLayerIndex + i];
        if (layer === undefined) continue;
        out.push({ gid: layer.gid, paletteIndex: layer.paletteIndex });
      }
      return out;
    },
    paletteColor: (paletteIndex: number, paletteId = 0) => {
      if (cpalTable === null) return null;
      if (paletteId < 0 || paletteId >= cpalTable.numPalettes) return null;
      if (paletteIndex < 0 || paletteIndex >= cpalTable.numPaletteEntries) return null;
      const first = cpalTable.colorRecordIndices[paletteId];
      const rec = cpalTable.colorRecords[first + paletteIndex];
      return rec === undefined ? null : rec;
    },
  };
  return { ok: true, font };
}

// -----------------------------------------------------------------------
// Rasterizer: non-zero-winding scanline fill -> 8-bit coverage
// -----------------------------------------------------------------------

export interface RasterizedGlyphT {
  width: number;
  height: number;
  coverage: Uint8Array; // width*height, row-major top-down, 0-255 alpha
}

interface FillEdge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: 1 | -1;
}

function accumulateSpan(coverage: Float32Array, row: number, width: number, xa: number, xb: number, weight: number): void {
  let a = xa;
  let b = xb;
  if (b <= a) return;
  if (a < 0) a = 0;
  if (b > width) b = width;
  if (b <= a) return;
  const rowBase = row * width;
  const firstPx = Math.floor(a);
  const lastPx = Math.floor(b - 1e-9);
  if (firstPx === lastPx) {
    coverage[rowBase + firstPx] += (b - a) * weight;
    return;
  }
  coverage[rowBase + firstPx] += (firstPx + 1 - a) * weight;
  for (let px = firstPx + 1; px < lastPx; px++) coverage[rowBase + px] += weight;
  coverage[rowBase + lastPx] += (b - lastPx) * weight;
}

// Rasterizes already-pixel-space contours (see rasterizeGlyph below for the
// font-units-to-pixel-space transform) into a `width`x`height` 8-bit
// coverage buffer using the non-zero winding rule. Exported directly
// (rather than only through rasterizeGlyph) so the rasterizer's own
// correctness -- winding direction, span accumulation, AA falloff -- can be
// unit-tested against hand-built synthetic contours (e.g. a donut/'o'
// shape: an outer contour wound one way and an inner contour wound the
// other way must punch a hole) without needing a real font at all.
export function rasterizeContours(contoursPx: FlattenedContourT[], width: number, height: number, supersampleY = 4): RasterizedGlyphT {
  const coverage = new Float32Array(width * height);
  const edges: FillEdge[] = [];
  for (const contour of contoursPx) {
    const n = contour.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const p0 = contour[i];
      const p1 = contour[(i + 1) % n];
      if (p0.y === p1.y) continue;
      if (p0.y < p1.y) edges.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y, dir: 1 });
      else edges.push({ x0: p1.x, y0: p1.y, x1: p0.x, y1: p0.y, dir: -1 });
    }
  }

  const invSS = 1 / supersampleY;
  for (let row = 0; row < height; row++) {
    for (let s = 0; s < supersampleY; s++) {
      const sy = row + (s + 0.5) * invSS;
      const xs: { x: number; dir: number }[] = [];
      for (const e of edges) {
        if (sy >= e.y0 && sy < e.y1) {
          const t = (sy - e.y0) / (e.y1 - e.y0);
          xs.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        winding += xs[k].dir;
        if (winding !== 0) accumulateSpan(coverage, row, width, xs[k].x, xs[k + 1].x, invSS);
      }
    }
  }

  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const v = coverage[i];
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return { width, height, coverage: out };
}

// Rasterizes glyph `gid` of `font` at `px` pixels-per-em. The cell is sized
// to the glyph's own advance width (rounded, matching kfont's own "rect
// width doubles as draw advance" convention -- see kfont.ts's Kfont_FromTTF
// doc comment) and to the font's ascent-to-(baseline-or-descender) span, so
// every glyph in a font shares the same "top" reference (the ascent line)
// when drawn at a constant per-line y, exactly like the real qconfont.kfont
// asset's own near-uniform per-glyph height (spot-checked: kfont.ts's own
// test fixture, real-byte-derived, shows h=14 for every sampled non-space
// glyph). Glyphs with no outline (e.g. space) return an all-zero-alpha
// buffer sized to their advance -- transparent, but still advances the
// cursor on draw, matching SCR_KFontLookup's own "w>0, zero-coverage is
// fine" contract.
export function rasterizeGlyph(font: ParsedFontT, gid: number, px: number): RasterizedGlyphT {
  const scale = px / font.unitsPerEm;
  const width = Math.max(1, Math.round(font.advanceWidth(gid) * scale));
  const contours = font.contours(gid);

  let yMin = 0;
  for (const c of contours) for (const p of c) if (p.y < yMin) yMin = p.y;
  const bottom = Math.min(0, yMin);
  const height = Math.max(1, Math.round((font.ascent - bottom) * scale));

  if (contours.length === 0) {
    return { width, height, coverage: new Uint8Array(width * height) };
  }

  const pxContours: FlattenedContourT[] = contours.map((c) => c.map((p) => ({ x: p.x * scale, y: (font.ascent - p.y) * scale })));
  return rasterizeContours(pxContours, width, height);
}

// -----------------------------------------------------------------------
// COLR v0 compositing: rasterize a color glyph as a stack of tinted
// grayscale-coverage layers, alpha-blended in COLR's own bottom-to-top
// layer order (COLR spec, "Baseline table format": "the first layer
// specified for a base glyph is the bottom-most layer, and it will get
// painted first"). Reuses rasterizeContours -- each layer glyph's outline
// is a perfectly ordinary glyph outline in its own right, so its coverage
// buffer is computed identically, then tinted by that layer's CPAL color
// and composited with standard non-premultiplied "over" alpha blending
// instead of being written straight into an RGBA8 atlas as flat white.
// -----------------------------------------------------------------------

export interface RasterizedColorGlyphT {
  width: number;
  height: number;
  pixels: Uint8Array; // RGBA8 straight (non-premultiplied) alpha, width*height*4
}

const COLR_FOREGROUND_SENTINEL = 0xffff;

// Standard non-premultiplied "source over destination" compositing (Porter-
// Duff "over"): outA = srcA + dstA*(1-srcA); outRGB = (srcRGB*srcA +
// dstRGB*dstA*(1-srcA)) / outA. `srcCoverage` is the layer's rasterized
// alpha (0-255) at this pixel, further modulated by the layer color's own
// alpha (CPAL/COLR spec: a color record's alpha applies exactly like any
// other paint alpha).
function compositeOver(pixels: Uint8Array, i: number, srcCoverage: number, color: { r: number; g: number; b: number; a: number }): void {
  const srcA = (srcCoverage / 255) * (color.a / 255);
  if (srcA <= 0) return;
  const o = i * 4;
  const dstA = pixels[o + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  const dstFactor = dstA * (1 - srcA);
  pixels[o] = Math.round((color.r * srcA + pixels[o] * dstFactor) / outA);
  pixels[o + 1] = Math.round((color.g * srcA + pixels[o + 1] * dstFactor) / outA);
  pixels[o + 2] = Math.round((color.b * srcA + pixels[o + 2] * dstFactor) / outA);
  pixels[o + 3] = Math.round(outA * 255);
}

// Rasterizes COLR base glyph `baseGid` (a gid with a `font.colorLayers()`
// entry -- see that method's own doc comment) at `px` pixels-per-em,
// compositing every layer's outline tinted by its CPAL palette color (or
// `foregroundColor` for a layer using the 0xFFFF "text foreground" sentinel)
// into one RGBA8 bitmap. Returns null if `baseGid` has no COLR entry at
// all (not a color glyph -- callers that don't already know this should
// check via `font.colorLayers(baseGid) !== null` first, exactly like
// rasterizeGlyph's callers already check contours()/cmapLookup() first).
//
// Cell sizing deliberately mirrors rasterizeGlyph's own convention (advance
// width for the width, ascent-to-lowest-point for the height) but computes
// yMin over the UNION of every layer's contours, not the base glyph's own
// (empty, by COLR v0 design -- see this file's header FINDING) contours,
// so every layer shares one consistent pixel-space transform and lands in
// its correct relative position instead of each layer picking its own
// (wrongly offset) bounding box.
export function rasterizeColorGlyph(
  font: ParsedFontT,
  baseGid: number,
  px: number,
  paletteId = 0,
  foregroundColor: { r: number; g: number; b: number; a: number } = { r: 255, g: 255, b: 255, a: 255 },
): RasterizedColorGlyphT | null {
  const layers = font.colorLayers(baseGid);
  if (layers === null) return null;

  const scale = px / font.unitsPerEm;
  const width = Math.max(1, Math.round(font.advanceWidth(baseGid) * scale));

  const resolved: { contours: FlattenedContourT[]; color: { r: number; g: number; b: number; a: number } }[] = [];
  let yMin = 0;
  for (const layer of layers) {
    const color = layer.paletteIndex === COLR_FOREGROUND_SENTINEL ? foregroundColor : font.paletteColor(layer.paletteIndex, paletteId);
    if (color === null) continue; // malformed/out-of-range palette index -- skip the layer rather than fail the whole glyph
    const contours = font.contours(layer.gid);
    for (const c of contours) for (const p of c) if (p.y < yMin) yMin = p.y;
    resolved.push({ contours, color });
  }

  const bottom = Math.min(0, yMin);
  const height = Math.max(1, Math.round((font.ascent - bottom) * scale));
  const pixels = new Uint8Array(width * height * 4);

  for (const { contours, color } of resolved) {
    if (contours.length === 0) continue;
    const pxContours: FlattenedContourT[] = contours.map((c) => c.map((p) => ({ x: p.x * scale, y: (font.ascent - p.y) * scale })));
    const raster = rasterizeContours(pxContours, width, height);
    for (let i = 0; i < raster.coverage.length; i++) {
      if (raster.coverage[i] === 0) continue;
      compositeOver(pixels, i, raster.coverage[i], color);
    }
  }

  return { width, height, pixels };
}

// -----------------------------------------------------------------------
// Atlas builder
// -----------------------------------------------------------------------

export interface AtlasRectT {
  x: number;
  y: number;
  w: number;
  h: number;
  // true for a COLR v0 + CPAL color glyph baked as a full-RGBA region (its
  // pixels are the glyph's REAL composited colors, not a white/coverage-alpha
  // mask) -- see this function's own doc comment below and
  // client/cgame/host.ts's drawKfontChar, which reads this flag to draw the
  // region untinted instead of tinted by the caller's text color. false for
  // every ordinary (non-color) glyph, unchanged from this atlas format's
  // original white-RGB/coverage-alpha shape.
  color: boolean;
}

export interface FontAtlasT {
  width: number;
  height: number;
  pixels: Uint8Array; // RGBA8 straight alpha, width*height*4 -- white RGB / coverage alpha for ordinary glyphs (matches conchars-style single-channel-as-alpha glyph art), REAL composited RGBA for glyphs whose AtlasRectT.color is true (see that field's doc comment)
  glyphs: Map<number, AtlasRectT>; // codepoint -> atlas rect (kfont's own KfontCharT shape)
  lineHeight: number; // max rect height over every included glyph, matching kfont.ts's ParseKfont convention
}

// One rasterized cell awaiting packing -- either an ordinary glyph's
// coverage-alpha mask (rasterizeGlyph) or a COLR/CPAL color glyph's already-
// composited RGBA bitmap (rasterizeColorGlyph). Unified so the shelf packer
// below only has to know each entry's width/height, not which rasterizer
// produced it.
interface AtlasCellT {
  codepoint: number;
  width: number;
  height: number;
  color: boolean;
  coverage: Uint8Array | null; // set when !color
  rgba: Uint8Array | null; // set when color
}

// Rasterizes every codepoint in `codepoints` that this font's cmap actually
// maps (codepoints the font has no glyph for are silently skipped -- same
// "missing entry, not a fallback glyph" contract SCR_KFontLookup already
// has for the real qconfont.kfont asset) into a single shelf-packed RGBA
// atlas, 1px gaps between cells (bleed hygiene for bilinear-filtered
// sampling; not load-bearing for correctness).
//
// COLR v0 + CPAL COLOR GLYPHS (completes the follow-up ttf.ts's own header
// FINDING recorded: "rasterizeColorGlyph() produces a standalone RGBA8
// bitmap, NOT an atlas rect wired into buildFontAtlas()/kfont's single-tint
// draw model"): a codepoint whose mapped gid has a COLR base-glyph record
// (`font.colorLayers(gid) !== null` -- true today only for the 7 real
// KexControllerIcons*.ttf PUA icon glyphs, see test/ttf_colr_retail.test.ts)
// is rasterized via rasterizeColorGlyph() instead of rasterizeGlyph(), and
// its REAL composited RGBA pixels are copied into the atlas verbatim (not
// forced to white RGB + coverage alpha the way an ordinary glyph is) --
// AtlasRectT.color records which case applies so the draw path
// (client/cgame/host.ts's drawKfontChar) knows to skip its usual text-color
// tint for this region. rasterizeColorGlyph()'s own default palette (id 0)
// and default foreground color (opaque white, for any layer using the COLR
// 0xFFFF "use the caller's text color" sentinel) are used here, since an
// atlas is built once and shared by every subsequent draw call at
// potentially different text colors -- a per-draw-call foreground tint for
// THOSE specific sentinel layers is not achievable through a pre-baked
// atlas rect and is out of scope for this pass; no glyph in the real
// retail controller-icon fonts actually uses the sentinel (verified:
// test/ttf_colr_retail.test.ts's real-bytes layer dump for
// KexControllerIconsDS4.ttf's codepoint 0xF0000 has three CPAL-indexed
// layers, no 0xFFFF sentinel among them), so this is a documented
// theoretical gap, not an observed one.
export function buildFontAtlas(font: ParsedFontT, codepoints: Iterable<number>, px: number, maxWidth = 512): FontAtlasT {
  const cells: AtlasCellT[] = [];
  let lineHeight = 0;
  for (const cp of codepoints) {
    const gid = font.cmapLookup(cp);
    if (gid === 0) continue;
    if (font.colorLayers(gid) !== null) {
      const raster = rasterizeColorGlyph(font, gid, px);
      if (raster === null) continue; // colorLayers() said yes but the composite came back empty -- stay defensive like rasterizeGlyph's own callers, skip rather than fail the whole atlas
      if (raster.height > lineHeight) lineHeight = raster.height;
      cells.push({ codepoint: cp, width: raster.width, height: raster.height, color: true, coverage: null, rgba: raster.pixels });
      continue;
    }
    const raster = rasterizeGlyph(font, gid, px);
    if (raster.height > lineHeight) lineHeight = raster.height;
    cells.push({ codepoint: cp, width: raster.width, height: raster.height, color: false, coverage: raster.coverage, rgba: null });
  }

  const sorted = [...cells].sort((a, b) => b.height - a.height);
  const gap = 1;
  const atlasWidth = maxWidth;
  let cursorX = gap;
  let cursorY = gap;
  let shelfHeight = 0;
  const placements = new Map<number, { x: number; y: number }>();
  for (const { codepoint, width, height } of sorted) {
    if (cursorX + width + gap > atlasWidth) {
      cursorX = gap;
      cursorY += shelfHeight + gap;
      shelfHeight = 0;
    }
    placements.set(codepoint, { x: cursorX, y: cursorY });
    cursorX += width + gap;
    if (height > shelfHeight) shelfHeight = height;
  }
  const atlasHeight = cursorY + shelfHeight + gap;

  const pixels = new Uint8Array(atlasWidth * atlasHeight * 4);
  const glyphs = new Map<number, AtlasRectT>();
  for (const cell of cells) {
    const pos = placements.get(cell.codepoint);
    if (pos === undefined) continue;
    if (cell.color) {
      const src = cell.rgba!;
      for (let y = 0; y < cell.height; y++) {
        for (let x = 0; x < cell.width; x++) {
          const so = (y * cell.width + x) * 4;
          const dst = ((pos.y + y) * atlasWidth + (pos.x + x)) * 4;
          pixels[dst] = src[so];
          pixels[dst + 1] = src[so + 1];
          pixels[dst + 2] = src[so + 2];
          pixels[dst + 3] = src[so + 3];
        }
      }
    } else {
      const src = cell.coverage!;
      for (let y = 0; y < cell.height; y++) {
        for (let x = 0; x < cell.width; x++) {
          const a = src[y * cell.width + x];
          const dst = ((pos.y + y) * atlasWidth + (pos.x + x)) * 4;
          pixels[dst] = 255;
          pixels[dst + 1] = 255;
          pixels[dst + 2] = 255;
          pixels[dst + 3] = a;
        }
      }
    }
    glyphs.set(cell.codepoint, { x: pos.x, y: pos.y, w: cell.width, h: cell.height, color: cell.color });
  }

  return { width: atlasWidth, height: atlasHeight, pixels, glyphs, lineHeight };
}

// ASCII printable (0x20-0x7E) + Latin-1 Supplement printable (0xA0-0xFF) --
// the "ASCII + Latin-1 minimum" set from the brief. Covers every codepoint
// the retail localization/loc_english.txt actually uses: scanned via the
// real Q2Game.kpf file, its only non-ASCII codepoint is U+00F6 (o with
// diaeresis), already inside this range.
export function latin1Codepoints(): number[] {
  const out: number[] = [];
  for (let cp = 0x20; cp <= 0x7e; cp++) out.push(cp);
  for (let cp = 0xa0; cp <= 0xff; cp++) out.push(cp);
  return out;
}
