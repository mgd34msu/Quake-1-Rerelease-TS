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
import { ParseKfont, SCR_KFontLookup, KFONT_ASCII_MIN, KFONT_ASCII_MAX, type KfontT } from "../src/lib/kfont";

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

function parsedFixtureFont(): KfontT {
  const parsed = ParseKfont(FIXTURE_KFONT);
  expect(parsed).not.toBeNull();
  const p = parsed!;
  return { pic: "/" + p.textureToken, chars: p.chars, line_height: p.line_height };
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

  test("ParseKfont/SCR_KFontLookup: a codepoint in the [127,157] out-of-bounds range q2repro's own C array indexing would overrun (see kfont.ts's header comment) is dropped, not stored -- FIDELITY RAZOR deviation, not reproduced as a real OOB write", () => {
    const withDangerRange = `texture "fonts/qconfont.png"\nmapchar\n{\n\t140 1 1 5 5 0\n}\n`;
    const parsed = ParseKfont(withDangerRange);
    expect(parsed).not.toBeNull();
    const font: KfontT = { pic: "/x", chars: parsed!.chars, line_height: parsed!.line_height };
    expect(SCR_KFontLookup(font, 140)).toBeNull();
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
    const font: KfontT = { pic: "/x", chars: parsed!.chars, line_height: parsed!.line_height };
    expect(SCR_KFontLookup(font, 34)).toBeNull();
  });
});
