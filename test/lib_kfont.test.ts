// Tests for src/lib/kfont.ts's pure parser/lookup functions (ParseKfont,
// SCR_KFontLookup), lifted from quake-2-re-ts src/client/cgame/kfont.ts at
// 7e88015. See kfont.ts's own header comment for the full .kfont format
// writeup and the FIDELITY RAZOR history behind the deliberate
// [KFONT_ASCII_MIN, KFONT_ASCII_MAX] bounds check.
//
// Adapted from quake-2-re-ts's own test/kfont.test.ts, keeping only its
// first describe block ("ParseKfont / SCR_KFontLookup, pure, no engine
// state") -- that file's remaining describes exercise
// quake-2-re-ts's client/cgame/host.ts (RefExports, cvars, FS_InitFilesystem),
// which is a later unit's territory here, not part of this lift.
//
// FIXTURE_KFONT below is a hand-built literal, not a copy of any real
// asset -- but its numeric glyph metrics (codepoint/x/y/w/h for 32, 33,
// 48, 65, 97, 115, 116) are copied verbatim from quake-2-re-ts's own real
// fonts/qconfont.kfont bytes (per that project's test file's own
// provenance comment), so the parse/measure assertions below are checked
// against genuine .kfont data shape, not invented numbers. A guarded
// smoke test against the real Quake 1 re-release's fonts/qfont.kfont
// (from QuakeEX.kpf) lives in test/lib_kpf_smoke.test.ts, not here.

import { describe, test, expect } from "bun:test";
import { ParseKfont, SCR_KFontLookup, kfontGlyph, kfontHasGlyph, KFONT_ASCII_MIN, KFONT_ASCII_MAX, type KfontT } from "../src/lib/kfont";

const FIXTURE_KFONT = `texture "fonts/qconfont.png"
unicode
mapchar
{
\t32 178 56 9 8 0
\t33 186 104 3 14 0
\t48 93 38 8 14 0
\t65 114 218 8 14 0
\t97 14 236 8 14 0
\t115 25 236 8 14 0
\t116 15 110 8 14 0
}
`;

// A second fixture adding one non-ASCII entry outside the legacy ASCII
// `chars` array's [KFONT_ASCII_MIN, KFONT_ASCII_MAX] range -- codepoint 1074
// (Cyrillic В lowercase в) at real coordinates copied verbatim from the
// retail fonts/qfont.kfont bytes (see this unit's report: "1074 ... 28 0"
// is a real mapchar line in that file), so the non-ASCII assertions below
// are checked against genuine .kfont data shape too, not an invented
// codepoint.
const FIXTURE_KFONT_WITH_CYRILLIC = `texture "fonts/qfont.png"
unicode
mapchar
{
\t65 114 218 8 14 0
\t97 14 236 8 14 0
\t1074 87 241 17 28 0
}
`;

function parsedFixtureFont(): KfontT {
  const parsed = ParseKfont(FIXTURE_KFONT);
  expect(parsed).not.toBeNull();
  const p = parsed!;
  return { pic: "/" + p.textureToken, chars: p.chars, glyphs: p.glyphs, line_height: p.line_height };
}

describe("kfont.ts -- ParseKfont / SCR_KFontLookup (pure, no engine state)", () => {
  test("ParseKfont: reads the texture line and mapchar entries (real-byte-derived values)", () => {
    const parsed = ParseKfont(FIXTURE_KFONT);
    expect(parsed).not.toBeNull();
    expect(parsed!.textureToken).toBe("fonts/qconfont.png");

    const a = parsed!.chars[97 - KFONT_ASCII_MIN]; // 'a'
    expect(a).toEqual({ x: 14, y: 236, w: 8, h: 14 });

    const bang = parsed!.chars[33 - KFONT_ASCII_MIN]; // '!'
    expect(bang).toEqual({ x: 186, y: 104, w: 3, h: 14 });
  });

  test("ParseKfont: line_height is the max h across all parsed entries (14 in the real asset)", () => {
    const parsed = ParseKfont(FIXTURE_KFONT);
    expect(parsed!.line_height).toBe(14);
  });

  test("ParseKfont: returns null when the file has no 'texture' line", () => {
    const noTexture = `unicode\nmapchar\n{\n\t97 14 236 8 14 0\n}\n`;
    expect(ParseKfont(noTexture)).toBeNull();
  });

  test("ParseKfont/SCR_KFontLookup: a codepoint in the [127,157] out-of-bounds range q2repro's own C array indexing would overrun (see kfont.ts's header comment) is dropped from the ASCII `chars` array, not stored -- FIDELITY RAZOR deviation, not reproduced as a real OOB write", () => {
    const withDangerRange = `texture "fonts/qconfont.png"\nmapchar\n{\n\t140 1 1 5 5 0\n}\n`;
    const parsed = ParseKfont(withDangerRange);
    expect(parsed).not.toBeNull();
    const font: KfontT = { pic: "/x", chars: parsed!.chars, glyphs: parsed!.glyphs, line_height: parsed!.line_height };
    expect(SCR_KFontLookup(font, 140)).toBeNull();
    // U31: the Map-based `glyphs`/kfontGlyph path has no such array-sizing
    // bug to reproduce or deviate from -- codepoint 140 IS reachable there.
    expect(kfontGlyph(font, 140)).toEqual({ x: 1, y: 1, w: 5, h: 5 });
  });

  test("SCR_KFontLookup: returns the glyph rect for a mapped codepoint", () => {
    const font = parsedFixtureFont();
    expect(SCR_KFontLookup(font, "t".charCodeAt(0))).toEqual({ x: 15, y: 110, w: 8, h: 14 });
  });

  test("SCR_KFontLookup: returns null for a codepoint outside [KFONT_ASCII_MIN, KFONT_ASCII_MAX]", () => {
    const font = parsedFixtureFont();
    expect(SCR_KFontLookup(font, KFONT_ASCII_MIN - 1)).toBeNull();
    expect(SCR_KFontLookup(font, KFONT_ASCII_MAX + 1)).toBeNull();
  });

  test("SCR_KFontLookup: returns null for an in-range codepoint the atlas has no entry for (e.g. 'b', not in this fixture)", () => {
    const font = parsedFixtureFont();
    expect(SCR_KFontLookup(font, "b".charCodeAt(0))).toBeNull();
  });

  test("SCR_KFontLookup: treats a present-but-zero-width entry as missing (synthetic case)", () => {
    const withZeroWidth = `texture "fonts/qconfont.png"\nmapchar\n{\n\t34 0 0 0 0 0\n}\n`;
    const parsed = ParseKfont(withZeroWidth);
    const font: KfontT = { pic: "/x", chars: parsed!.chars, glyphs: parsed!.glyphs, line_height: parsed!.line_height };
    expect(SCR_KFontLookup(font, 34)).toBeNull();
  });
});

describe("kfont.ts -- U31: full glyph map (glyphs, kfontGlyph, kfontHasGlyph)", () => {
  test("ParseKfont: a non-ASCII entry (e.g. Cyrillic codepoint 1074) parses into `glyphs` with real fonts/qfont.kfont-derived coordinates", () => {
    const parsed = ParseKfont(FIXTURE_KFONT_WITH_CYRILLIC);
    expect(parsed).not.toBeNull();
    expect(parsed!.glyphs.get(1074)).toEqual({ x: 87, y: 241, w: 17, h: 28 });
  });

  test("kfontGlyph/kfontHasGlyph: resolve a non-ASCII codepoint that `chars`/SCR_KFontLookup can never reach", () => {
    const parsed = ParseKfont(FIXTURE_KFONT_WITH_CYRILLIC);
    const font: KfontT = { pic: "/x", chars: parsed!.chars, glyphs: parsed!.glyphs, line_height: parsed!.line_height };

    expect(kfontHasGlyph(font, 1074)).toBe(true);
    expect(kfontGlyph(font, 1074)).toEqual({ x: 87, y: 241, w: 17, h: 28 });

    // 1074 is well outside [KFONT_ASCII_MIN, KFONT_ASCII_MAX] (32-126), so
    // the legacy ASCII-array path never sees it at all.
    expect(1074).toBeGreaterThan(KFONT_ASCII_MAX);
    expect(SCR_KFontLookup(font, 1074)).toBeNull();
  });

  test("kfontGlyph/kfontHasGlyph: an unmapped codepoint returns null/false", () => {
    const parsed = ParseKfont(FIXTURE_KFONT_WITH_CYRILLIC);
    const font: KfontT = { pic: "/x", chars: parsed!.chars, glyphs: parsed!.glyphs, line_height: parsed!.line_height };
    expect(kfontHasGlyph(font, 1075)).toBe(false);
    expect(kfontGlyph(font, 1075)).toBeNull();
  });

  test("kfontGlyph: treats a present-but-zero-width entry as missing, same contract as SCR_KFontLookup/TtfKfont_Lookup", () => {
    const withZeroWidth = `texture "fonts/qfont.png"\nmapchar\n{\n\t1074 0 0 0 0 0\n}\n`;
    const parsed = ParseKfont(withZeroWidth);
    expect(parsed).not.toBeNull();
    const font: KfontT = { pic: "/x", chars: parsed!.chars, glyphs: parsed!.glyphs, line_height: parsed!.line_height };
    expect(kfontHasGlyph(font, 1074)).toBe(false);
    expect(kfontGlyph(font, 1074)).toBeNull();
  });

  test("the ASCII fast path (`chars`) agrees with `glyphs` for every ASCII entry the fixture defines", () => {
    const parsed = ParseKfont(FIXTURE_KFONT);
    expect(parsed).not.toBeNull();
    for (let cp = KFONT_ASCII_MIN; cp <= KFONT_ASCII_MAX; cp++) {
      const fromArray = parsed!.chars[cp - KFONT_ASCII_MIN];
      const fromMap = parsed!.glyphs.get(cp) ?? null;
      expect(fromArray).toEqual(fromMap);
    }
    // and the fixture actually exercises both a present and an absent entry
    expect(parsed!.chars[97 - KFONT_ASCII_MIN]).not.toBeNull();
    expect(parsed!.chars["b".charCodeAt(0) - KFONT_ASCII_MIN]).toBeNull();
  });

  test("`glyphs` has no upper bound: a codepoint far above KFONT_ASCII_MAX (7838, the real fonts/qfont.kfont's own max codepoint) round-trips", () => {
    const withHighCodepoint = `texture "fonts/qfont.png"\nmapchar\n{\n\t7838 165 331 16 28 0\n}\n`;
    const parsed = ParseKfont(withHighCodepoint);
    expect(parsed).not.toBeNull();
    expect(parsed!.glyphs.get(7838)).toEqual({ x: 165, y: 331, w: 16, h: 28 });
  });

  test("line_height is the max h across EVERY parsed glyph, including non-ASCII ones outside `chars`'s range (U31 documented behavior widening -- see kfont.ts's header comment)", () => {
    const tallerNonAscii = `texture "fonts/qfont.png"\nmapchar\n{\n\t65 1 1 8 14 0\n\t1074 1 1 8 40 0\n}\n`;
    const parsed = ParseKfont(tallerNonAscii);
    expect(parsed).not.toBeNull();
    expect(parsed!.line_height).toBe(40);
  });
});
