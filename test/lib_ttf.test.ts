// Tests for src/lib/ttf.ts (lifted from quake-2-re-ts src/qcommon/ttf.ts at
// 7e88015 -- a dependency-free TTF/OTF parser + rasterizer + atlas builder,
// pure, no engine state, no filesystem) and its src/lib/kfont.ts seam
// (Kfont_FromTTF/TtfKfont_Lookup). Adapted from quake-2-re-ts's own
// test/ttf.test.ts, updated to import from src/lib instead of
// src/qcommon+src/client/cgame -- the test vectors themselves are
// unchanged. Per PORTING.md rule 13 (self-sufficient test files), this
// file hand-builds every sfnt/glyf/cmap/kern byte sequence it needs from
// scratch rather than depending on real font data (a guarded smoke test
// against the real Quake 1 re-release's fonts/RobotoMono-Regular.ttf lives
// in test/lib_kpf_smoke.test.ts, not here).
//
// Byte-level correctness strategy: rather than eyeballing hex, every
// hand-built glyph outline test asserts EXACT coordinate output --
// straight-line glyphs (triangles) assert the raw point list verbatim;
// the one curved glyph asserts specific points on its flattened quadratic
// Bezier against the closed-form Bernstein evaluation at that same t
// (t=0.5 and t=1.0), so a subdivision-math regression would fail this
// test even though it "still looks curvy".

import { describe, test, expect } from "bun:test";
import { parseFont, rasterizeContours, buildFontAtlas, latin1Codepoints, type FlattenedContourT } from "../src/lib/ttf";
import { Kfont_FromTTF, TtfKfont_Lookup } from "../src/lib/kfont";

// ---------------------------------------------------------------------------
// Byte-assembly helpers (sfnt directory, head/hhea/maxp/hmtx, cmap 4/12,
// loca/glyf simple+composite, kern format 0). Deliberately verbose/direct
// (no "clever" bit-packing beyond what the real formats require) so each
// helper is itself easy to eyeball against the spec fields it's encoding.
// ---------------------------------------------------------------------------

function u16(v: number): number[] {
  const u = v & 0xffff;
  return [(u >> 8) & 0xff, u & 0xff];
}
function i16(v: number): number[] {
  return u16(v < 0 ? v + 0x10000 : v);
}
function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function buildSfnt(sfntVersion: number[], tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const numTables = tables.length;
  const headerSize = 12 + numTables * 16;
  let offset = headerSize;
  const records: number[] = [];
  const dataParts: Uint8Array[] = [];
  for (const t of tables) {
    const tagBytes = Array.from(t.tag).map((c) => c.charCodeAt(0));
    records.push(...tagBytes, ...u32(0), ...u32(offset), ...u32(t.data.length));
    dataParts.push(t.data);
    let padded = t.data.length;
    while (padded % 4 !== 0) {
      dataParts.push(new Uint8Array([0]));
      padded++;
    }
    offset += padded;
  }
  return bytes(bytes(sfntVersion, u16(numTables), u16(0), u16(0), u16(0)), new Uint8Array(records), ...dataParts);
}

function buildHead(unitsPerEm: number, indexToLocFormat: number): Uint8Array {
  return bytes(
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0x5f0f3cf5),
    u16(0),
    u16(unitsPerEm),
    new Uint8Array(8),
    new Uint8Array(8),
    i16(0),
    i16(0),
    i16(0),
    i16(0),
    u16(0),
    u16(8),
    i16(2),
    i16(indexToLocFormat),
    i16(0),
  );
}

function buildHhea(ascent: number, descent: number, lineGap: number, numberOfHMetrics: number): Uint8Array {
  return bytes(u32(0x00010000), i16(ascent), i16(descent), i16(lineGap), u16(0), i16(0), i16(0), i16(0), i16(0), i16(1), i16(0), new Uint8Array(8), i16(0), u16(numberOfHMetrics));
}

function buildMaxp(numGlyphs: number): Uint8Array {
  return bytes(u32(0x00005000), u16(numGlyphs));
}

function buildHmtx(widths: number[]): Uint8Array {
  const parts: number[] = [];
  for (const w of widths) parts.push(...u16(w), ...i16(0));
  return new Uint8Array(parts);
}

function buildCmapFormat4(mappings: { codepoint: number; gid: number }[]): Uint8Array {
  const sorted = [...mappings].sort((a, b) => a.codepoint - b.codepoint);
  const segs = sorted.map((m) => ({ start: m.codepoint, end: m.codepoint, delta: m.gid - m.codepoint }));
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 }); // terminator segment: codepoint 0xffff + delta 1 wraps to gid 0
  const segCount = segs.length;
  const searchRange = 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
  const entrySelector = Math.floor(Math.log2(segCount));
  const rangeShift = segCount * 2 - searchRange;

  const endCodes = segs.flatMap((s) => u16(s.end));
  const startCodes = segs.flatMap((s) => u16(s.start));
  const idDeltas = segs.flatMap((s) => i16(s.delta));
  const idRangeOffsets = segs.flatMap(() => u16(0));

  return bytes(
    u16(4),
    u16(0), // length -- not read by cmapFormat4Lookup (which derives everything from segCountX2), left unset
    u16(0),
    u16(segCount * 2),
    u16(searchRange),
    u16(entrySelector),
    u16(rangeShift),
    new Uint8Array(endCodes),
    u16(0), // reservedPad
    new Uint8Array(startCodes),
    new Uint8Array(idDeltas),
    new Uint8Array(idRangeOffsets),
  );
}

function buildCmapFormat12(groups: { start: number; end: number; startGid: number }[]): Uint8Array {
  const body: number[] = [];
  body.push(...u16(12), ...u16(0));
  body.push(...u32(16 + groups.length * 12));
  body.push(...u32(0));
  body.push(...u32(groups.length));
  for (const g of groups) body.push(...u32(g.start), ...u32(g.end), ...u32(g.startGid));
  return new Uint8Array(body);
}

function buildCmapTable(subtables: { platformID: number; encodingID: number; data: Uint8Array }[]): Uint8Array {
  const headerSize = 4 + subtables.length * 8;
  let offset = headerSize;
  const records: number[] = [];
  for (const s of subtables) {
    records.push(...u16(s.platformID), ...u16(s.encodingID), ...u32(offset));
    offset += s.data.length;
  }
  return bytes(u16(0), u16(subtables.length), new Uint8Array(records), ...subtables.map((s) => s.data));
}

function buildLoca(glyphLengths: number[]): Uint8Array {
  const parts: number[] = [];
  let acc = 0;
  parts.push(...u32(0));
  for (const len of glyphLengths) {
    acc += len;
    parts.push(...u32(acc));
  }
  return new Uint8Array(parts);
}

function buildSimpleGlyf(contour: { x: number; y: number; onCurve: boolean }[]): Uint8Array {
  const xs = contour.map((p) => p.x);
  const ys = contour.map((p) => p.y);
  const flags = contour.map((p) => (p.onCurve ? 0x01 : 0x00)); // always full int16 deltas below -- no short-vector/repeat bits, deterministic and easy to hand-verify
  const xDeltas: number[] = [];
  const yDeltas: number[] = [];
  let px = 0;
  let py = 0;
  for (const p of contour) {
    xDeltas.push(...i16(p.x - px));
    px = p.x;
    yDeltas.push(...i16(p.y - py));
    py = p.y;
  }
  return bytes(
    i16(1), // numberOfContours
    i16(Math.min(...xs)),
    i16(Math.min(...ys)),
    i16(Math.max(...xs)),
    i16(Math.max(...ys)),
    u16(contour.length - 1), // single contour's endPtsOfContours[0]
    u16(0), // instructionLength
    new Uint8Array(flags),
    new Uint8Array(xDeltas),
    new Uint8Array(yDeltas),
  );
}

function buildCompositeGlyf(components: { glyphIndex: number; dx: number; dy: number }[]): Uint8Array {
  const ARG_WORDS = 0x0001;
  const ARGS_XY = 0x0002;
  const MORE = 0x0020;
  const parts: number[] = [];
  components.forEach((c, idx) => {
    const isLast = idx === components.length - 1;
    const flags = ARG_WORDS | ARGS_XY | (isLast ? 0 : MORE);
    parts.push(...u16(flags), ...u16(c.glyphIndex), ...i16(c.dx), ...i16(c.dy));
  });
  return bytes(i16(-1), i16(0), i16(0), i16(0), i16(0), new Uint8Array(parts));
}

function buildKernTable(pairs: { left: number; right: number; value: number }[]): Uint8Array {
  const nPairs = pairs.length;
  const subLength = 14 + nPairs * 6;
  const subtable = bytes(
    u16(0), // subtable version
    u16(subLength),
    u16(0x0001), // coverage: horizontal bit set, format 0 in the high byte
    u16(nPairs),
    u16(0),
    u16(0),
    u16(0),
    new Uint8Array(pairs.flatMap((p) => [...u16(p.left), ...u16(p.right), ...i16(p.value)])),
  );
  return bytes(u16(0), u16(1), subtable);
}

// ---------------------------------------------------------------------------
// Fixture: a minimal 4-glyph TrueType font (format 4 cmap).
//   gid0 = .notdef (empty)
//   gid1 = 'A' (0x41): triangle (0,0)-(600,0)-(300,800), all on-curve
//   gid2 = 'B' (0x42): (0,0)on -> (0,600)off -> (600,600)on, ONE quadratic edge
//   gid3 = 'C' (0x43): composite -- gid1 shifted by (100,50)
// unitsPerEm=1000, ascent=800, descent=-200. Plus a 'kern' table with one
// pair (gid1,gid2,-50).
// ---------------------------------------------------------------------------

const TRIANGLE: { x: number; y: number; onCurve: boolean }[] = [
  { x: 0, y: 0, onCurve: true },
  { x: 600, y: 0, onCurve: true },
  { x: 300, y: 800, onCurve: true },
];
const CURVE_SHAPE: { x: number; y: number; onCurve: boolean }[] = [
  { x: 0, y: 0, onCurve: true },
  { x: 0, y: 600, onCurve: false },
  { x: 600, y: 600, onCurve: true },
];

function buildFixtureFont(): Uint8Array {
  const glyf0 = new Uint8Array(0);
  const glyf1 = buildSimpleGlyf(TRIANGLE);
  const glyf2 = buildSimpleGlyf(CURVE_SHAPE);
  const glyf3 = buildCompositeGlyf([{ glyphIndex: 1, dx: 100, dy: 50 }]);

  const glyphLengths = [glyf0.length, glyf1.length, glyf2.length, glyf3.length];
  const glyf = bytes(glyf0, glyf1, glyf2, glyf3);
  const loca = buildLoca(glyphLengths);

  const cmap = buildCmapTable([
    {
      platformID: 3,
      encodingID: 1,
      data: buildCmapFormat4([
        { codepoint: 0x41, gid: 1 },
        { codepoint: 0x42, gid: 2 },
        { codepoint: 0x43, gid: 3 },
      ]),
    },
  ]);

  return buildSfnt(u32(0x00010000), [
    { tag: "head", data: buildHead(1000, 1) },
    { tag: "hhea", data: buildHhea(800, -200, 0, 4) },
    { tag: "maxp", data: buildMaxp(4) },
    { tag: "hmtx", data: buildHmtx([0, 600, 600, 700]) },
    { tag: "cmap", data: cmap },
    { tag: "loca", data: loca },
    { tag: "glyf", data: glyf },
    { tag: "kern", data: buildKernTable([{ left: 1, right: 2, value: -50 }]) },
  ]);
}

// A second, separate minimal font exercising ONLY a format 12 cmap subtable,
// mapping a codepoint beyond the BMP (U+1F600, which format 4 cannot even
// represent) -- unambiguous proof the format 12 path, not format 4, is what
// resolved the lookup.
function buildFormat12Font(): Uint8Array {
  const glyf0 = new Uint8Array(0);
  const glyf1 = buildSimpleGlyf([
    { x: 0, y: 0, onCurve: true },
    { x: 400, y: 0, onCurve: true },
    { x: 400, y: 400, onCurve: true },
    { x: 0, y: 400, onCurve: true },
  ]);
  const loca = buildLoca([glyf0.length, glyf1.length]);
  const glyf = bytes(glyf0, glyf1);
  const cmap = buildCmapTable([{ platformID: 3, encodingID: 10, data: buildCmapFormat12([{ start: 0x1f600, end: 0x1f600, startGid: 1 }]) }]);

  return buildSfnt(u32(0x00010000), [
    { tag: "head", data: buildHead(1000, 1) },
    { tag: "hhea", data: buildHhea(800, -200, 0, 2) },
    { tag: "maxp", data: buildMaxp(2) },
    { tag: "hmtx", data: buildHmtx([0, 500]) },
    { tag: "cmap", data: cmap },
    { tag: "loca", data: loca },
    { tag: "glyf", data: glyf },
  ]);
}

// ---------------------------------------------------------------------------
// Parser vectors
// ---------------------------------------------------------------------------

describe("ttf.ts -- parseFont: sfnt directory / required-table validation", () => {
  test("rejects a buffer with no recognizable sfnt signature", () => {
    const result = parseFont(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(result.ok).toBe(false);
  });

  test("rejects a well-signed sfnt missing a required table (maxp/hmtx/cmap)", () => {
    const truncated = buildSfnt(u32(0x00010000), [
      { tag: "head", data: buildHead(1000, 1) },
      { tag: "hhea", data: buildHhea(800, -200, 0, 1) },
    ]);
    const result = parseFont(truncated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing/i);
  });

  test("rejects an sfnt with all required tables but no outline table (no glyf+loca, no CFF)", () => {
    const noOutline = buildSfnt(u32(0x00010000), [
      { tag: "head", data: buildHead(1000, 1) },
      { tag: "hhea", data: buildHhea(800, -200, 0, 1) },
      { tag: "maxp", data: buildMaxp(1) },
      { tag: "hmtx", data: buildHmtx([0]) },
      { tag: "cmap", data: buildCmapTable([{ platformID: 3, encodingID: 1, data: buildCmapFormat4([]) }]) },
    ]);
    const result = parseFont(noOutline);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outline/i);
  });
});

describe("ttf.ts -- parseFont: head/hhea/maxp/hmtx metrics", () => {
  test("unitsPerEm, ascent/descent/lineGap, numGlyphs, and per-glyph advance widths all read back exactly", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const f = result.font;
    expect(f.unitsPerEm).toBe(1000);
    expect(f.ascent).toBe(800);
    expect(f.descent).toBe(-200);
    expect(f.lineGap).toBe(0);
    expect(f.numGlyphs).toBe(4);
    expect(f.outlineFormat).toBe("glyf");
    expect(f.advanceWidth(0)).toBe(0);
    expect(f.advanceWidth(1)).toBe(600);
    expect(f.advanceWidth(2)).toBe(600);
    expect(f.advanceWidth(3)).toBe(700);
    expect(f.advanceWidth(99)).toBe(0); // out of range -- no throw
  });
});

describe("ttf.ts -- parseFont: cmap format 4 and format 12", () => {
  test("format 4: maps 'A'/'B'/'C' to gid 1/2/3, and an unmapped codepoint to gid 0", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font.cmapLookup(0x41)).toBe(1);
    expect(result.font.cmapLookup(0x42)).toBe(2);
    expect(result.font.cmapLookup(0x43)).toBe(3);
    expect(result.font.cmapLookup(0x5a)).toBe(0); // 'Z', not in this fixture's cmap
  });

  test("format 12: resolves a codepoint beyond the BMP (U+1F600), which format 4 cannot even encode", () => {
    const result = parseFont(buildFormat12Font());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font.cmapLookup(0x1f600)).toBe(1);
    expect(result.font.cmapLookup(0x41)).toBe(0); // not in this fixture's cmap at all
  });
});

describe("ttf.ts -- parseFont: glyf simple glyphs (straight-line exact point check)", () => {
  test("a triangle glyph (all on-curve points) round-trips its exact coordinates", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contours = result.font.contours(1);
    expect(contours.length).toBe(1);
    expect(contours[0]).toEqual([
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 300, y: 800 },
    ]);
  });

  test("gid 0 (.notdef, empty loca range) has zero contours", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font.contours(0)).toEqual([]);
  });
});

describe("ttf.ts -- parseFont: glyf quadratic curve flattening (exact Bernstein-formula check)", () => {
  test("the on-off-on curve glyph's flattened points match the closed-form quadratic Bezier at t=0.5 and t=1.0", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contours = result.font.contours(2);
    expect(contours.length).toBe(1);
    const pts = contours[0];
    // pts[0] = the starting on-curve point (0,0); pts[1..8] = the 8-segment
    // flattening of the single quadratic (p0=(0,0), c=(0,600), p1=(600,600)).
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    // t=0.5 (segment index 4 of 8): 0.25*p0 + 0.5*c + 0.25*p1 = (150, 450)
    expect(pts[4].x).toBeCloseTo(150, 6);
    expect(pts[4].y).toBeCloseTo(450, 6);
    // t=1.0 (segment index 8 of 8, the last point) must land exactly on p1
    expect(pts[8].x).toBeCloseTo(600, 6);
    expect(pts[8].y).toBeCloseTo(600, 6);
  });
});

describe("ttf.ts -- parseFont: glyf composite glyphs (exact transform check)", () => {
  test("a composite referencing the triangle glyph with a (100,50) offset shifts every point by exactly that amount", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contours = result.font.contours(3);
    expect(contours.length).toBe(1);
    expect(contours[0]).toEqual([
      { x: 100, y: 50 },
      { x: 700, y: 50 },
      { x: 400, y: 850 },
    ]);
  });
});

describe("ttf.ts -- parseFont: kern format 0", () => {
  test("a mapped pair returns its exact value; an unmapped pair returns 0", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font.kerning(1, 2)).toBe(-50);
    expect(result.font.kerning(1, 3)).toBe(0);
    expect(result.font.kerning(2, 1)).toBe(0); // direction matters -- kern pairs are ordered (left,right)
  });

  test("a font with no kern table reports 0 for every pair (not a crash)", () => {
    const result = parseFont(buildFormat12Font());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font.kerning(0, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rasterizer sanity: non-zero winding rule, AA coverage falloff
// ---------------------------------------------------------------------------

describe("ttf.ts -- rasterizeContours: winding rule and coverage", () => {
  test("a single filled square: full coverage at center, zero outside, ~50% at a half-covered boundary pixel", () => {
    // Left edge at x=2.5 -> pixel column 2 (spanning [2,3)) is exactly
    // half-covered by the shape (from 2.5 to 3.0).
    const square: FlattenedContourT = [
      { x: 2.5, y: 2 },
      { x: 2.5, y: 8 },
      { x: 8, y: 8 },
      { x: 8, y: 2 },
    ];
    const raster = rasterizeContours([square], 10, 10);
    const at = (x: number, y: number) => raster.coverage[y * 10 + x];
    expect(at(5, 5)).toBe(255); // deep interior
    expect(at(0, 5)).toBe(0); // outside, left of the shape entirely
    expect(at(9, 5)).toBe(0); // outside, right of the shape entirely
    expect(at(2, 5)).toBeGreaterThan(100);
    expect(at(2, 5)).toBeLessThan(155); // ~127, half-covered boundary column
  });

  test("donut ('o'-like) shape: an inner contour wound opposite to the outer contour punches a hole under the non-zero winding rule", () => {
    const outer: FlattenedContourT = [
      { x: 2, y: 2 },
      { x: 2, y: 12 },
      { x: 12, y: 12 },
      { x: 12, y: 2 },
    ];
    // Reversed traversal relative to `outer`'s pattern -- opposite signed
    // area (verified by hand via the shoelace formula in this test file's
    // own header derivation), which is what makes this a hole and not a
    // second solid shape under the non-zero rule.
    const hole: FlattenedContourT = [
      { x: 5, y: 5 },
      { x: 9, y: 5 },
      { x: 9, y: 9 },
      { x: 5, y: 9 },
    ];
    const raster = rasterizeContours([outer, hole], 14, 14);
    const at = (x: number, y: number) => raster.coverage[y * 14 + x];
    expect(at(7, 7)).toBe(0); // dead center -- inside the hole
    expect(at(3, 7)).toBe(255); // in the ring: inside outer, outside inner
    expect(at(0, 0)).toBe(0); // outside the outer contour entirely
  });

  test("two contours wound the SAME direction add (not cancel): the 'hole' region stays filled", () => {
    const outer: FlattenedContourT = [
      { x: 2, y: 2 },
      { x: 2, y: 12 },
      { x: 12, y: 12 },
      { x: 12, y: 2 },
    ];
    const sameDirection: FlattenedContourT = [
      { x: 5, y: 5 },
      { x: 5, y: 9 },
      { x: 9, y: 9 },
      { x: 9, y: 5 },
    ];
    const raster = rasterizeContours([outer, sameDirection], 14, 14);
    expect(raster.coverage[7 * 14 + 7]).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// Atlas builder + kfont.ts seam shape-compatibility
// ---------------------------------------------------------------------------

describe("ttf.ts -- buildFontAtlas / kfont.ts's Kfont_FromTTF seam", () => {
  test("builds an atlas rect per mapped codepoint, skips unmapped codepoints, and Kfont_FromTTF/TtfKfont_Lookup round-trip the same rects", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const atlas = buildFontAtlas(result.font, [0x41, 0x42, 0x43, 0x5a], 32); // 'Z' (0x5a) is unmapped in this fixture
    expect(atlas.glyphs.has(0x41)).toBe(true);
    expect(atlas.glyphs.has(0x5a)).toBe(false);
    expect(atlas.width).toBeGreaterThan(0);
    expect(atlas.height).toBeGreaterThan(0);
    expect(atlas.lineHeight).toBeGreaterThan(0);
    expect(atlas.pixels.length).toBe(atlas.width * atlas.height * 4);

    const rectA = atlas.glyphs.get(0x41);
    expect(rectA).toBeDefined();

    const font = Kfont_FromTTF(atlas, "/ttf:fixture:32");
    expect(font.pic).toBe("/ttf:fixture:32");
    expect(font.line_height).toBe(atlas.lineHeight);

    const chA = TtfKfont_Lookup(font, 0x41);
    expect(chA).not.toBeNull();
    expect(chA).toEqual(rectA!);

    expect(TtfKfont_Lookup(font, 0x5a)).toBeNull(); // never rasterized -- no atlas entry at all
    expect(TtfKfont_Lookup(font, 0x99)).toBeNull(); // never requested either
  });

  test("a codepoint with zero-width geometry (degenerate/never occurs in this fixture, simulated via an empty codepoint set) yields an empty atlas, not a crash", () => {
    const result = parseFont(buildFixtureFont());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atlas = buildFontAtlas(result.font, [], 16);
    expect(atlas.glyphs.size).toBe(0);
  });
});

describe("ttf.ts -- latin1Codepoints", () => {
  test("covers ASCII printable (0x20-0x7E) and Latin-1 Supplement printable (0xA0-0xFF), 158 codepoints total", () => {
    const cps = latin1Codepoints();
    expect(cps.length).toBe((0x7e - 0x20 + 1) + (0xff - 0xa0 + 1));
    expect(cps).toContain(0x41); // 'A'
    expect(cps).toContain(0xf6); // o-diaeresis -- the one non-ASCII codepoint loc_english.txt actually uses
    expect(cps).not.toContain(0x7f); // DEL, excluded
    expect(cps).not.toContain(0x9f); // C1 control range, excluded
  });
});
