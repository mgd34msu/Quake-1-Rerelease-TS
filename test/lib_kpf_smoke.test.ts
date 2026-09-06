// Guarded end-to-end smoke test: opens the REAL Quake 1 re-release
// QuakeEX.kpf (a zip archive -- see src/lib/zipfile.ts's header comment)
// with the lifted src/lib decoders, exercising the whole chain
// zip -> raw bytes -> format decoder against genuine retail assets, not
// just hand-built fixtures. Skips itself when the fixture isn't on disk
// (mirrors test/support/fixture_availability.ts's own existsSync-guard
// idiom); game data is never committed to this repo. This file's own
// SCOPE is test/lib_*.test.ts, so the guard is inlined here rather than
// adding a new export to fixture_availability.ts.
//
// Per the unit brief: lists fonts/qfont.kfont and fonts/qfont.png (a
// well-formed .kfont referencing a colortype-6 PNG atlas, confirmed
// present in the real archive, unlike quake-2-re-ts's Q2Game.kpf whose
// equivalent asset is named fonts/qconfont.kfont), rasterizes a glyph
// from fonts/RobotoMono-Regular.ttf through ttf.ts, decodes
// fonts/qfont.png through png.ts, and decodes one gfx/*.png from the kpf.
//
// QuakeEX.kpf is itself real proof the DEFLATE path matters here in a way
// quake-2-re-ts's own kpf never exercised: this unit's own survey (see
// report) found Q2Game.kpf stores every entry uncompressed (method 0),
// but QuakeEX.kpf stores 482 of its 497 entries as method 8 (DEFLATE) --
// so this test is the first real-data exercise of zipfile.ts's
// inflateRawSync path anywhere in either project's test suite.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ZipArchive } from "../src/lib/zipfile";
import { decodePNG } from "../src/lib/png";
import { ParseKfont, KFONT_ASCII_MIN } from "../src/lib/kfont";
import { parseFont, rasterizeGlyph } from "../src/lib/ttf";

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const KPF_PATH = `${RERELEASE_DATA_DIR}/QuakeEX.kpf`;
const HAVE_KPF = existsSync(KPF_PATH);

describe.skipIf(!HAVE_KPF)("QuakeEX.kpf smoke test (real retail data, src/lib decoders end to end)", () => {
  const archive = HAVE_KPF ? ZipArchive.open(readFileSync(KPF_PATH)) : null;

  test("the archive opens and its central directory parses", () => {
    expect(archive).not.toBeNull();
    expect(archive!.entries.length).toBeGreaterThan(0);
  });

  test("most entries are DEFLATE (method 8), not STORE -- this kpf actually exercises inflateRawSync", () => {
    expect(archive).not.toBeNull();
    const deflateCount = archive!.entries.filter((e) => e.method === 8).length;
    expect(deflateCount).toBeGreaterThan(400);
  });

  test("lists fonts/qfont.kfont and fonts/qfont.png", () => {
    expect(archive).not.toBeNull();
    expect(archive!.findEntry("fonts/qfont.kfont")).not.toBeNull();
    expect(archive!.findEntry("fonts/qfont.png")).not.toBeNull();
  });

  test("lists fonts/RobotoMono-Regular.ttf", () => {
    expect(archive).not.toBeNull();
    expect(archive!.findEntry("fonts/RobotoMono-Regular.ttf")).not.toBeNull();
  });

  test("lists at least one gfx/*.png entry (gfx/check.png)", () => {
    expect(archive).not.toBeNull();
    expect(archive!.findEntry("gfx/check.png")).not.toBeNull();
  });

  test("fonts/qfont.kfont parses via kfont.ts's ParseKfont, real ASCII glyph metrics readable", () => {
    expect(archive).not.toBeNull();
    const bytes = archive!.readFile("fonts/qfont.kfont");
    expect(bytes).not.toBeNull();
    const text = Buffer.from(bytes!).toString("latin1");
    const parsed = ParseKfont(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.textureToken).toBe("fonts/qfont.png");
    // codepoint 56 = '8': "56 32 31 22 28 0" in the real file (spot-checked
    // by this unit against the extracted bytes).
    const digit8 = parsed!.chars[56 - KFONT_ASCII_MIN];
    expect(digit8).toEqual({ x: 32, y: 31, w: 22, h: 28 });
  });

  test("fonts/qfont.png decodes via png.ts (colortype 6 RGBA, 349x360)", () => {
    expect(archive).not.toBeNull();
    const bytes = archive!.readFile("fonts/qfont.png");
    expect(bytes).not.toBeNull();
    const result = decodePNG(bytes!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(349);
    expect(result.image.height).toBe(360);
    expect(result.image.pixels.length).toBe(349 * 360 * 4);
  });

  test("a gfx/*.png entry (gfx/check.png) decodes via png.ts (240x240)", () => {
    expect(archive).not.toBeNull();
    const bytes = archive!.readFile("gfx/check.png");
    expect(bytes).not.toBeNull();
    const result = decodePNG(bytes!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(240);
    expect(result.image.height).toBe(240);
  });

  test("fonts/RobotoMono-Regular.ttf parses via ttf.ts and rasterizes a real glyph", () => {
    expect(archive).not.toBeNull();
    const bytes = archive!.readFile("fonts/RobotoMono-Regular.ttf");
    expect(bytes).not.toBeNull();
    const parsed = parseFont(bytes!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.font.numGlyphs).toBeGreaterThan(0);

    const gid = parsed.font.cmapLookup("A".charCodeAt(0));
    expect(gid).toBeGreaterThan(0); // 'A' must be mapped in a real text font

    const raster = rasterizeGlyph(parsed.font, gid, 32);
    expect(raster.width).toBeGreaterThan(0);
    expect(raster.height).toBeGreaterThan(0);
    expect(raster.coverage.length).toBe(raster.width * raster.height);
    // A rasterized 'A' at a real pixel size must actually paint something
    // (not an all-zero/empty coverage buffer).
    const painted = raster.coverage.some((v) => v > 0);
    expect(painted).toBe(true);
  });
});
