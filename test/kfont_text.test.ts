// Force headless SDL before ANY import can reach the FFI layer (the GL
// section below installs a real QGLRecording, matching test/ref_gl_draw.test.ts's
// own precedent).
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Self-sufficient tests for U19's src/client/kfont_text.ts: the glyph provider
(classic/kfont/ttf resolution via `con_font`/`scr_usekfont`), Text_Width/
Text_Draw, and CL_LocalizeKey.

Two fixture tiers, per the unit brief:
- A synthetic fonts/qfont.kfont + fonts/qfont.png built by this file (no
  game data), covering glyph parsing, width computation, UTF-8/codepoint
  mapping and fallback, and con_font switching. Text_Draw is observed
  through a spy on src/ref_soft/draw.ts's own Draw_GlyphAtlas (isGL: false
  in the fake Renderer below), never a `mock.module` (standing order 15).
- A guarded real-data section against the retail QuakeEX.kpf
  (test/fs_rerelease.test.ts's own Q1TS_REAL_DATA/COM_InitArgv+
  COM_InitFilesystem recipe), proving the real fonts/qfont.kfont's ASCII
  glyphs resolve and that Text_Draw emits one real GL atlas quad per
  character through a QGLRecording fake (test/ref_gl_draw.test.ts's own
  vid/glState/qgl fixture recipe).

Per standing order 13: every shared singleton this file mutates (vid.width/
height, glState, qglHolder.current, re.current, com_searchpaths/com_gamedir,
the kfont_text.ts cvars) is saved before and restored in afterAll.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { COM_AddGameDirectory, COM_InitArgv, COM_InitFilesystem, com_gamedir, com_searchpaths, setComGamedir, setComSearchpaths } from "../src/common/common";
import { re, type GlyphAtlasSourceT, type Renderer } from "../src/client/render";
import { TextureT } from "../src/common/model";
import { vid } from "../src/client/vid";
import { glState } from "../src/ref_gl/glquake";
import { GL_QUADS, GL_TEXTURE_2D, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import * as softDrawModule from "../src/ref_soft/draw";
import * as glDrawModule from "../src/ref_gl/gl_draw";
import { ZipArchive } from "../src/lib/zipfile";
import { ParseKfont, kfontHasGlyph } from "../src/lib/kfont";
import { PakFile } from "./support/pak_reader";
import {
  CL_LocalizeKey,
  con_font,
  scr_usekfont,
  Text_Draw,
  Text_LineHeight,
  Text_RowScale,
  Text_Width,
  test_ResetClLocCache,
  test_ResetGlyphCache,
} from "../src/client/kfont_text";

// ---------------------------------------------------------------------------
// Fake Renderer -- console.test.ts's own makeFakeRenderer() shape, reused
// here (self-sufficient per standing order 13, so re-declared rather than
// imported from another test file) with an `isGL` toggle. U44: kfont_text.ts's
// Text_Draw now reaches the renderer purely through
// `getRenderer().Draw_GlyphAtlas(...)` (src/client/render.ts's Renderer
// seam member), so this fake's own `Draw_GlyphAtlas` forwards to the REAL
// src/ref_soft/draw.ts or src/ref_gl/gl_draw.ts function based on `isGL`,
// which is what lets a `spyOn` on either real module's own export observe
// the call (spyOn patches the module namespace object; a value captured by
// direct reference at construction time would miss it).
// ---------------------------------------------------------------------------
function makeFakeRenderer(isGL: boolean): { renderer: Renderer; draws: Array<{ x: number; y: number; num: number }> } {
  const draws: Array<{ x: number; y: number; num: number }> = [];
  const renderer: Renderer = {
    modelHooks: {
      notexture: new TextureT(),
      textureLoaded: () => {},
      Mod_LoadLighting: () => {},
      Mod_LoadAliasModel: () => {},
      Mod_LoadSpriteModel: () => {},
    },
    R_Init: () => {},
    R_InitTextures: () => {},
    R_InitEfrags: () => {},
    R_RenderView: () => {},
    R_ViewChanged: () => {},
    R_InitSky: () => {},
    R_AddEfrags: () => {},
    R_RemoveEfrags: () => {},
    R_NewMap: () => {},
    R_PushDlights: () => {},
    r_cache_thrash: false,
    D_SurfaceCacheForRes: () => 0,
    D_FlushCaches: () => {},
    D_DeleteSurfaceCache: () => {},
    D_InitCaches: () => {},
    R_SetVrect: () => {},
    draw_disc: null,
    Draw_Init: () => {},
    Draw_Character: (x: number, y: number, num: number) => {
      draws.push({ x, y, num });
    },
    Draw_DebugChar: () => {},
    Draw_Pic: () => {},
    Draw_TransPic: () => {},
    Draw_TransPicTranslate: () => {},
    Draw_ConsoleBackground: () => {},
    Draw_BeginDisc: () => {},
    Draw_EndDisc: () => {},
    Draw_TileClear: () => {},
    Draw_Fill: () => {},
    Draw_FadeScreen: () => {},
    Draw_String: () => {},
    Draw_PicFromWad: () => null,
    Draw_CachePic: () => null,
    D_StartParticles: () => {},
    D_DrawParticle: () => {},
    D_EndParticles: () => {},
    V_CalcBlend: () => {},
    V_UpdatePalette: () => {},
    V_DrawCrosshair: () => {},
    R_TranslatePlayerSkin: () => {},
    SCR_CalcRefdef: () => {},
    BeginFrame: () => {},
    EndFrame: () => {},
    D_EnableBackBufferAccess: () => {},
    D_DisableBackBufferAccess: () => {},
    D_UpdateRects: () => {},
    GL_Set2D: () => {},
    SCR_TileClear: () => {},
    SCR_SoftwareTileClear: () => {},
    SCR_DrawCrosshair: () => {},
    Draw_SubPic: () => {},
    Draw_Alt_String: () => {},
    Draw_GlyphAtlas: (
      dstX: number,
      dstY: number,
      dstW: number,
      dstH: number,
      source: GlyphAtlasSourceT,
      srcX: number,
      srcY: number,
      srcW: number,
      srcH: number,
      tint: readonly [number, number, number] | null,
    ) => {
      const mod = isGL ? glDrawModule : softDrawModule;
      mod.Draw_GlyphAtlas(dstX, dstY, dstW, dstH, source, srcX, srcY, srcW, srcH, tint);
    },
    isGL,
    SCR_ScreenShot_f: () => {},
  };
  return { renderer, draws };
}

// ---------------------------------------------------------------------------
// Synthetic fonts/qfont.kfont + fonts/qfont.png fixture.
// ---------------------------------------------------------------------------

// Glyph rects (x, y, w, h) inside a 40x8 RGBA atlas -- 'A'/'B'/'?' are 8px
// wide, space is a distinct 4px width (proves Text_Width reads REAL
// per-glyph advances, not a fixed classic 8px assumption). GLYPH_CYRILLIC_VE
// (codepoint 1042, Cyrillic capital VE 'В') is a distinct 6px width, mapped
// at a codepoint far outside kfont.ts's legacy [KFONT_ASCII_MIN,
// KFONT_ASCII_MAX] (32-126) `chars` array -- U31's whole point is that this
// resolves through the UTF-8 path (kfontGlyph's Map-based lookup) exactly
// like an ASCII glyph does, not through the '?' fallback.
const GLYPH_A = { x: 0, y: 0, w: 8, h: 8 };
const GLYPH_B = { x: 8, y: 0, w: 8, h: 8 };
const GLYPH_QMARK = { x: 16, y: 0, w: 8, h: 8 };
const GLYPH_SPACE = { x: 24, y: 0, w: 4, h: 8 };
const GLYPH_CYRILLIC_VE = { x: 32, y: 0, w: 6, h: 8 };
const ATLAS_W = 40;
const ATLAS_H = 8;
const CYRILLIC_VE_CODEPOINT = 1042;

function buildFixtureKfontText(): string {
  return [
    'texture "fonts/qfont.png"',
    "unicode",
    "mapchar",
    "{",
    `\t${"A".charCodeAt(0)} ${GLYPH_A.x} ${GLYPH_A.y} ${GLYPH_A.w} ${GLYPH_A.h} 0`,
    `\t${"B".charCodeAt(0)} ${GLYPH_B.x} ${GLYPH_B.y} ${GLYPH_B.w} ${GLYPH_B.h} 0`,
    `\t${"?".charCodeAt(0)} ${GLYPH_QMARK.x} ${GLYPH_QMARK.y} ${GLYPH_QMARK.w} ${GLYPH_QMARK.h} 0`,
    `\t${CYRILLIC_VE_CODEPOINT} ${GLYPH_CYRILLIC_VE.x} ${GLYPH_CYRILLIC_VE.y} ${GLYPH_CYRILLIC_VE.w} ${GLYPH_CYRILLIC_VE.h} 0`,
    `\t32 ${GLYPH_SPACE.x} ${GLYPH_SPACE.y} ${GLYPH_SPACE.w} ${GLYPH_SPACE.h} 0`,
    "}",
    "",
  ].join("\n");
}

// A hand-built colortype-6 (RGBA8) PNG, matching test/lib_png.test.ts's own
// buildPng recipe (this file's own copy, per standing order 13's
// self-sufficiency rule) -- every pixel inside the four glyph rects above is
// opaque white; everything else is fully transparent.
function buildFixtureAtlasPng(): Uint8Array {
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + data.length + 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
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

  const inGlyph = (x: number, y: number): boolean =>
    [GLYPH_A, GLYPH_B, GLYPH_QMARK, GLYPH_SPACE, GLYPH_CYRILLIC_VE].some((g) => x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h);

  const rowBytes = ATLAS_W * 4;
  const raw = new Uint8Array((rowBytes + 1) * ATLAS_H);
  let o = 0;
  for (let y = 0; y < ATLAS_H; y++) {
    raw[o++] = 0; // filter: None
    for (let x = 0; x < ATLAS_W; x++) {
      const opaque = inGlyph(x, y);
      raw[o++] = 255;
      raw[o++] = 255;
      raw[o++] = 255;
      raw[o++] = opaque ? 255 : 0;
    }
  }
  const compressed = new Uint8Array(deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, ATLAS_W, false);
  iv.setUint32(4, ATLAS_H, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // no interlace

  return concat([new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))]);
}

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "kfont-text-test-"));

const savedSearchpaths = com_searchpaths;
const savedGamedir = com_gamedir;
const savedConFont = con_font.string;
const savedUsekfont = scr_usekfont.value;

beforeAll(() => {
  mkdirSync(join(scratchDir, "fonts"), { recursive: true });
  writeFileSync(join(scratchDir, "fonts", "qfont.kfont"), buildFixtureKfontText(), "latin1");
  writeFileSync(join(scratchDir, "fonts", "qfont.png"), buildFixtureAtlasPng());
  COM_AddGameDirectory(scratchDir);
});

afterAll(() => {
  setComSearchpaths(savedSearchpaths);
  setComGamedir(savedGamedir);
  con_font.string = savedConFont;
  con_font.value = 0;
  scr_usekfont.value = savedUsekfont;
  scr_usekfont.string = String(savedUsekfont);
});

beforeEach(() => {
  re.current = null;
  test_ResetGlyphCache();
  test_ResetClLocCache();
});

describe("kfont_text.ts -- con_font/scr_usekfont resolution", () => {
  test("G3: con_font=kfont selects the font on its own -- scr_usekfont is the unicode-coverage opt-in, not the font switch", () => {
    scr_usekfont.value = 0;
    con_font.string = "kfont";
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;

    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "A");
      expect(draws).toEqual([]); // not the classic per-character primitive
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![4]).toMatchObject({ kind: "custom" });
    } finally {
      spy.mockRestore();
    }
  });

  test("G3: con_font=classic with scr_usekfont=0 draws every ASCII code point through Draw_Character (pure WinQuake)", () => {
    scr_usekfont.value = 0;
    con_font.string = "classic";
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;

    Text_Draw(0, 0, "AB");
    expect(draws.map((d) => d.num)).toEqual(["A".charCodeAt(0), "B".charCodeAt(0)]);
  });

  test("G3: con_font=classic with scr_usekfont=1 STILL draws the charset for everything it has a cell for", () => {
    scr_usekfont.value = 1;
    con_font.string = "classic";
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;

    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "AB");
      expect(draws.map((d) => d.num)).toEqual(["A".charCodeAt(0), "B".charCodeAt(0)]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("con_font=classic forces classic even when scr_usekfont=1", () => {
    scr_usekfont.value = 1;
    con_font.string = "classic";
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;

    Text_Draw(0, 0, "A");
    expect(draws).toEqual([{ x: 0, y: 0, num: "A".charCodeAt(0) }]);
  });

  test("con_font=ttf:<missing-file> falls back to classic (no such fonts/*.ttf/.otf on this search path)", () => {
    scr_usekfont.value = 1;
    con_font.string = "ttf:does-not-exist";
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;

    Text_Draw(0, 0, "A");
    expect(draws).toEqual([{ x: 0, y: 0, num: "A".charCodeAt(0) }]);
  });

  test("scr_usekfont=1, con_font=kfont resolves the synthetic fonts/qfont.kfont atlas (routes through Draw_GlyphAtlas, not Draw_Character)", () => {
    scr_usekfont.value = 1;
    con_font.string = "kfont";
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "A");
      expect(draws).toEqual([]); // classic Draw_Character path NOT taken
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("kfont_text.ts -- Text_Width (synthetic kfont atlas)", () => {
  beforeEach(() => {
    scr_usekfont.value = 1;
    con_font.string = "kfont";
  });

  test("sums real per-glyph advances, not a fixed 8px classic assumption", () => {
    expect(Text_Width("AB")).toBe(GLYPH_A.w + GLYPH_B.w); // 16
    expect(Text_Width("A B")).toBe(GLYPH_A.w + GLYPH_SPACE.w + GLYPH_B.w); // 8 + 4 + 8 = 20
  });

  test("scale multiplies every glyph's advance", () => {
    expect(Text_Width("AB", 2)).toBe((GLYPH_A.w + GLYPH_B.w) * 2);
  });

  test("F17: an unmapped codepoint <= 0xFF (UTF-8/accented text the fixture atlas has no glyph for) falls back to the classic charset's 8px cell, not the font's own '?'", () => {
    // U+00F6 (ö, 246) -- this fixture's font simply doesn't define this
    // codepoint (unlike CYRILLIC_VE_CODEPOINT below, which it does), and
    // 246 <= 0xFF means the classic charset has a cell for it -- see
    // kfont_text.ts's "GLYPH FALLBACK POLICY" header paragraph, case 3.
    expect(Text_Width("ö")).toBe(8); // the classic charset's fixed 8px cell, not GLYPH_QMARK.w (also 8, coincidentally, in this fixture)
  });

  test("F17: an unmapped codepoint > 0xFF (past the classic charset's 256 cells) falls back to the font's own '?' glyph, when the font defines one", () => {
    // U+2026 (ellipsis, 8230) -- outside both this fixture's glyph map and
    // the classic charset's [0, 255] range, so case 4 applies: the font's
    // own '?' (GLYPH_QMARK, present in this fixture).
    expect(Text_Width("…")).toBe(GLYPH_QMARK.w);
  });

  test("U31: a non-ASCII codepoint the font DOES define (Cyrillic 'В', codepoint 1042, outside kfont.ts's legacy [32,126] `chars` bound) resolves to its real glyph width, not the '?' fallback", () => {
    const cyrillicVe = String.fromCodePoint(CYRILLIC_VE_CODEPOINT);
    expect(Text_Width(cyrillicVe)).toBe(GLYPH_CYRILLIC_VE.w);
    expect(Text_Width(cyrillicVe)).not.toBe(GLYPH_QMARK.w);
  });

  test("U31: width computation is per-codepoint for a mixed ASCII + Cyrillic string", () => {
    const s = "A" + String.fromCodePoint(CYRILLIC_VE_CODEPOINT) + "B";
    expect(Text_Width(s)).toBe(GLYPH_A.w + GLYPH_CYRILLIC_VE.w + GLYPH_B.w);
  });

  test("classic (scr_usekfont=0) still assumes a fixed 8px advance per character", () => {
    scr_usekfont.value = 0;
    expect(Text_Width("AB")).toBe(16);
    expect(Text_Width("AB", 2)).toBe(32);
  });
});

// F14: menu.ts asks for the multiplier that fits one line of the active font
// into one 8px menu row, and needs that multiplier to be exactly 1 with the
// classic charset so a classic menu keeps its per-character Draw_Character
// geometry.
describe("kfont_text.ts -- Text_LineHeight / Text_RowScale", () => {
  test("classic (scr_usekfont=0): the 8px charset cell IS the line, so an 8px row scales by exactly 1", () => {
    scr_usekfont.value = 0;
    con_font.string = "kfont";
    expect(Text_LineHeight()).toBe(8);
    expect(Text_RowScale(8)).toBe(1);
    expect(Text_RowScale(16)).toBe(2);
  });

  test("kfont: the line height is the font's own declared glyph height", () => {
    scr_usekfont.value = 1;
    con_font.string = "kfont";
    expect(Text_LineHeight()).toBe(GLYPH_A.h);
    expect(Text_RowScale(GLYPH_A.h / 2)).toBe(0.5);
  });
});

describe("kfont_text.ts -- Text_Draw glyph rects (synthetic kfont atlas, software dispatch)", () => {
  beforeEach(() => {
    scr_usekfont.value = 1;
    con_font.string = "kfont";
    re.current = makeFakeRenderer(false).renderer;
  });

  test("one Draw_GlyphAtlas call per resolvable character, with the fixture's exact src rect and a real-pixel dst rect", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(10, 20, "AB");
      expect(spy).toHaveBeenCalledTimes(2);

      const [dstX1, dstY1, dstW1, dstH1, source1, srcX1, srcY1, srcW1, srcH1, tint1] = spy.mock.calls[0]!;
      expect([dstX1, dstY1, dstW1, dstH1]).toEqual([10, 20, GLYPH_A.w, GLYPH_A.h]);
      expect(source1).toMatchObject({ kind: "custom", width: ATLAS_W, height: ATLAS_H });
      expect([srcX1, srcY1, srcW1, srcH1]).toEqual([GLYPH_A.x, GLYPH_A.y, GLYPH_A.w, GLYPH_A.h]);
      expect(tint1).toBeNull();

      // second glyph starts where the first one's advance ended (x=10+8=18)
      const [dstX2] = spy.mock.calls[1]!;
      expect(dstX2).toBe(10 + GLYPH_A.w);
    } finally {
      spy.mockRestore();
    }
  });

  test("alt requests a golden tint under kfont (no baked alt charset region to select instead)", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "A", true);
      const tint = spy.mock.calls[0]![9];
      expect(tint).not.toBeNull();
      expect(Array.isArray(tint)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("scale multiplies the destination rect but not the source rect", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "A", false, 3);
      const [dstX, dstY, dstW, dstH, , srcX, srcY, srcW, srcH] = spy.mock.calls[0]!;
      expect([dstX, dstY, dstW, dstH]).toEqual([0, 0, GLYPH_A.w * 3, GLYPH_A.h * 3]);
      expect([srcX, srcY, srcW, srcH]).toEqual([GLYPH_A.x, GLYPH_A.y, GLYPH_A.w, GLYPH_A.h]);
    } finally {
      spy.mockRestore();
    }
  });

  test("U31: a Cyrillic string draws one Draw_GlyphAtlas call per codepoint, each with that codepoint's own src rect (not the '?' fallback rect)", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      // Cyrillic 'ВВ' (codepoint 1042 twice) -- two distinct glyph draws,
      // both sourcing GLYPH_CYRILLIC_VE's rect, proving the UTF-8 path asks
      // the font per codepoint rather than resolving once and reusing a
      // cached fallback.
      const s = String.fromCodePoint(CYRILLIC_VE_CODEPOINT, CYRILLIC_VE_CODEPOINT);
      Text_Draw(0, 0, s);
      expect(spy).toHaveBeenCalledTimes(2);

      for (const call of spy.mock.calls) {
        const [, , dstW, dstH, source, srcX, srcY, srcW, srcH] = call;
        expect([dstW, dstH]).toEqual([GLYPH_CYRILLIC_VE.w, GLYPH_CYRILLIC_VE.h]);
        expect(source).toMatchObject({ kind: "custom", width: ATLAS_W, height: ATLAS_H });
        expect([srcX, srcY, srcW, srcH]).toEqual([GLYPH_CYRILLIC_VE.x, GLYPH_CYRILLIC_VE.y, GLYPH_CYRILLIC_VE.w, GLYPH_CYRILLIC_VE.h]);
      }

      const [dstX1] = spy.mock.calls[0]!;
      const [dstX2] = spy.mock.calls[1]!;
      expect(dstX2).toBe((dstX1 as number) + GLYPH_CYRILLIC_VE.w);
    } finally {
      spy.mockRestore();
    }
  });

  test("U31: a mixed ASCII + Cyrillic string routes each codepoint through its own glyph rect", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      const s = "A" + String.fromCodePoint(CYRILLIC_VE_CODEPOINT);
      Text_Draw(0, 0, s);
      expect(spy).toHaveBeenCalledTimes(2);

      const [, , dstW1, dstH1, , srcX1, srcY1, srcW1, srcH1] = spy.mock.calls[0]!;
      expect([dstW1, dstH1]).toEqual([GLYPH_A.w, GLYPH_A.h]);
      expect([srcX1, srcY1, srcW1, srcH1]).toEqual([GLYPH_A.x, GLYPH_A.y, GLYPH_A.w, GLYPH_A.h]);

      const [dstX2, , dstW2, dstH2, , srcX2, srcY2, srcW2, srcH2] = spy.mock.calls[1]!;
      expect(dstX2).toBe(GLYPH_A.w);
      expect([dstW2, dstH2]).toEqual([GLYPH_CYRILLIC_VE.w, GLYPH_CYRILLIC_VE.h]);
      expect([srcX2, srcY2, srcW2, srcH2]).toEqual([GLYPH_CYRILLIC_VE.x, GLYPH_CYRILLIC_VE.y, GLYPH_CYRILLIC_VE.w, GLYPH_CYRILLIC_VE.h]);
    } finally {
      spy.mockRestore();
    }
  });

  // DEFECT D6 FIX (superseded by F17 for the <= 0xFF case, see below): text
  // never silently disappears -- a codepoint the font has no glyph for
  // still draws a call, it does not just skip that character.
  //
  // F17: for a codepoint <= 0xFF specifically, that call is now the classic
  // 8x8 charset glyph AT THAT CODEPOINT'S OWN INDEX (kfont_text.ts's
  // "GLYPH FALLBACK POLICY" header paragraph, case 3), not the font's own
  // '?' -- so this test (which uses 'ö', U+00F6 = 246, still <= 0xFF) now
  // expects the classic-charset atlas source and 'ö'.charCodeAt(0)'s own
  // row/col, replacing its pre-F17 GLYPH_QMARK expectation. The >0xFF
  // "font's own '?'" case (case 4) is covered by the ellipsis test below.
  test("F17: a codepoint <= 0xFF the fixture font does NOT define ('ö', U+00F6, accented-text stand-in) still draws -- the classic charset's own cell for that codepoint, not a silently dropped character", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      const s = "A" + "ö" + "B";
      Text_Draw(0, 0, s);
      // Three draws for three characters -- the unmapped 'ö' is NOT skipped.
      expect(spy).toHaveBeenCalledTimes(3);

      const oCodepoint = "ö".charCodeAt(0); // 246
      const [, , dstW2, dstH2, source2, srcX2, srcY2, srcW2, srcH2] = spy.mock.calls[1]!;
      expect(source2).toEqual({ kind: "classic" });
      expect([dstW2, dstH2]).toEqual([8, 8]);
      expect([srcX2, srcY2, srcW2, srcH2]).toEqual([(oCodepoint & 15) * 8, (oCodepoint >> 4) * 8, 8, 8]);

      // and the glyph after it still advances from the classic cell's fixed
      // 8px width, not the original (unmapped) character's non-existent one.
      const [dstX1] = spy.mock.calls[0]!;
      const [dstX2] = spy.mock.calls[1]!;
      const [dstX3] = spy.mock.calls[2]!;
      expect(dstX2).toBe((dstX1 as number) + GLYPH_A.w);
      expect(dstX3).toBe((dstX2 as number) + 8); // the classic cell's fixed 8px advance, not GLYPH_QMARK.w (also 8, coincidentally, in this fixture)
    } finally {
      spy.mockRestore();
    }
  });

  test("F17: the classic-charset fallback scales with `scale` like the kfont glyphs around it on the same row", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(10, 20, "ö", false, 3);
      expect(spy).toHaveBeenCalledTimes(1);
      const oCodepoint = "ö".charCodeAt(0); // 246
      const [dstX, dstY, dstW, dstH, source, srcX, srcY, srcW, srcH] = spy.mock.calls[0]!;
      expect([dstX, dstY, dstW, dstH]).toEqual([10, 20, 8 * 3, 8 * 3]); // dst scaled, matching a kfont glyph's own g.w*scale/g.h*scale
      expect(source).toEqual({ kind: "classic" });
      expect([srcX, srcY, srcW, srcH]).toEqual([(oCodepoint & 15) * 8, (oCodepoint >> 4) * 8, 8, 8]); // src rect never scales
    } finally {
      spy.mockRestore();
    }
  });

  test("F17: a codepoint > 0xFF the fixture font does NOT define (ellipsis, U+2026 = 8230, past the classic charset's 256 cells) falls back to the font's own '?' glyph", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "…");
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , dstW, dstH, source, srcX, srcY, srcW, srcH] = spy.mock.calls[0]!;
      expect(source).toMatchObject({ kind: "custom" });
      expect([dstW, dstH]).toEqual([GLYPH_QMARK.w, GLYPH_QMARK.h]);
      expect([srcX, srcY, srcW, srcH]).toEqual([GLYPH_QMARK.x, GLYPH_QMARK.y, GLYPH_QMARK.w, GLYPH_QMARK.h]);
    } finally {
      spy.mockRestore();
    }
  });

  test("F17: a codepoint > 0xFF falls back to the classic charset's own '?' cell when the font has no '?' glyph either", () => {
    // Overwrites the fixture's fonts/qfont.kfont/.png with a variant that
    // drops the '?' mapchar entry entirely, so case 4's second branch (no
    // font '?' to fall back to) is reachable; restored in this test's own
    // cleanup so every other test in this file keeps seeing the normal
    // fixture (self-sufficiency, standing order 13).
    const originalKfont = readFileSync(join(scratchDir, "fonts", "qfont.kfont"));
    const originalPng = readFileSync(join(scratchDir, "fonts", "qfont.png"));
    const noQmarkKfont = [
      'texture "fonts/qfont.png"',
      "unicode",
      "mapchar",
      "{",
      `\t${"A".charCodeAt(0)} ${GLYPH_A.x} ${GLYPH_A.y} ${GLYPH_A.w} ${GLYPH_A.h} 0`,
      `\t32 ${GLYPH_SPACE.x} ${GLYPH_SPACE.y} ${GLYPH_SPACE.w} ${GLYPH_SPACE.h} 0`,
      "}",
      "",
    ].join("\n");
    writeFileSync(join(scratchDir, "fonts", "qfont.kfont"), noQmarkKfont, "latin1");
    test_ResetGlyphCache();

    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;
    try {
      Text_Draw(0, 0, "…");
      // G3: a string whose every code point resolves to the charset draws at
      // the classic size through the classic per-character primitive, even
      // under con_font=kfont -- same cell, same place, one call.
      expect(spy).not.toHaveBeenCalled();
      expect(draws).toEqual([{ x: 0, y: 0, num: "?".charCodeAt(0) }]);
    } finally {
      spy.mockRestore();
      writeFileSync(join(scratchDir, "fonts", "qfont.kfont"), originalKfont);
      writeFileSync(join(scratchDir, "fonts", "qfont.png"), originalPng);
      test_ResetGlyphCache();
    }
  });
});

describe("kfont_text.ts -- CL_LocalizeKey", () => {
  test("a string not starting with '$' is returned unchanged", () => {
    expect(CL_LocalizeKey("plain text")).toBe("plain text");
    expect(CL_LocalizeKey("")).toBe("");
  });

  test("a '$key' with no loc table reachable (no localization/loc_*.txt on this search path) falls back to the key text without its leading '$'", () => {
    expect(CL_LocalizeKey("$some_unknown_key")).toBe("some_unknown_key");
  });
});

// ---------------------------------------------------------------------------
// Guarded real-data section: the retail Q1 install (classic + nested
// rerelease/, QuakeEX.kpf mounted) this repo's tests share.
// test/fs_rerelease.test.ts's own COM_InitArgv/COM_InitFilesystem recipe.
// ---------------------------------------------------------------------------

const REAL_Q1_DIR = process.env.Q1TS_REAL_DATA ?? "/home/buzzkill/Projects/qfiles/q1";
const HAVE_REAL_Q1 = existsSync(join(REAL_Q1_DIR, "id1")) && existsSync(join(REAL_Q1_DIR, "rerelease"));

describe.skipIf(!HAVE_REAL_Q1)("kfont_text.ts -- real QuakeEX.kpf fonts/qfont.kfont (guarded)", () => {
  const savedWidth = vid.width;
  const savedHeight = vid.height;
  const glStateDefaults = { ...glState };
  const savedQgl = qglHolder.current;
  let rec = new QGLRecording();

  beforeAll(() => {
    COM_InitArgv(["q1ts", "-basedir", REAL_Q1_DIR]);
    COM_InitFilesystem();

    vid.width = 320;
    vid.height = 200;
    Object.assign(glState, glStateDefaults);
    glState.texture_extension_number = 1;
    glState.currenttexture = -1;

    rec = new QGLRecording();
    SetQGL(rec);

    re.current = makeFakeRenderer(true).renderer;
    scr_usekfont.value = 1;
    con_font.string = "kfont";
    test_ResetGlyphCache();
  });

  afterAll(() => {
    vid.width = savedWidth;
    vid.height = savedHeight;
    Object.assign(glState, glStateDefaults);
    SetQGL(savedQgl);
  });

  // The file-level beforeEach (above) unconditionally nulls re.current for
  // every other describe block's isolation; re-installed here so it survives
  // into this block's own tests.
  beforeEach(() => {
    re.current = makeFakeRenderer(true).renderer;
  });

  test("G3: fonts/qfont.kfont's real ASCII glyph metrics (codepoint 56 '8' is 22 ATLAS px wide, spot-checked against the extracted file) reach Text_Width fitted to the classic cell", () => {
    // 22 atlas px at the font's declared 28px line, fitted onto the 8px cell.
    expect(Text_Width("8")).toBeCloseTo((22 * 8) / 28, 10);
    expect(Text_Width("8", 2)).toBeCloseTo((22 * 16) / 28, 10);
  });

  test("G3: the drawn line height is the classic cell under the real 28px font, so an 8px row scales by exactly 1", () => {
    expect(Text_LineHeight()).toBe(8);
    expect(Text_RowScale(8)).toBe(1);
    expect(Text_RowScale(16)).toBe(2);
  });

  test("G3 REGRESSION (the garbled console/menu/centerprint rows): every glyph of a mixed real-font string is exactly one row tall, whatever its atlas cell measures", () => {
    // ':' is one of the 27 ASCII code points fonts/qfont.kfont omits, so this
    // string draws BOTH sources on one row -- the case that used to put a
    // 28px kfont letter next to an 8px charset cell on an 8px grid.
    const line = "This is the first episode:";
    for (const scale of [1, 2]) {
      const heights = new Set<number>();
      const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
      try {
        re.current = makeFakeRenderer(false).renderer;
        Text_Draw(0, 0, line, false, scale);
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        for (const call of spy.mock.calls) heights.add(call[3]);
      } finally {
        spy.mockRestore();
      }
      expect([...heights]).toEqual([8 * scale]);
    }
  });

  test("G3: a mixed run's drawn width is the sum of its own advances, so no glyph overlaps the next", () => {
    const line = "a:b";
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      re.current = makeFakeRenderer(false).renderer;
      Text_Draw(0, 0, line, false, 1);
      const calls = spy.mock.calls;
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i]![0]).toBeCloseTo(calls[i - 1]![0]! + calls[i - 1]![2]!, 10);
      }
    } finally {
      spy.mockRestore();
    }
    expect(Text_Width(line)).toBeCloseTo(Text_Width("a") + Text_Width(":") + Text_Width("b"), 10);
  });

  test("G3: con_font=classic + scr_usekfont=1 mixes per CODE POINT -- Latin from the charset, Cyrillic from the kfont, both one row tall", () => {
    const savedFont = con_font.string;
    con_font.string = "classic";
    scr_usekfont.value = 1;
    test_ResetGlyphCache();
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;

    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Text_Draw(0, 0, "A\u041eB"); // 'A', CYRILLIC CAPITAL O (U+041E), 'B'
      // The two Latin letters keep the charset's own cells.
      const classicCalls = spy.mock.calls.filter((c) => (c[4] as { kind: string }).kind === "classic");
      const customCalls = spy.mock.calls.filter((c) => (c[4] as { kind: string }).kind === "custom");
      expect(classicCalls.length).toBe(2);
      expect(customCalls.length).toBe(1);
      // and every one of them is exactly one classic cell tall.
      for (const call of spy.mock.calls) expect(call[3]).toBe(8);
      expect(draws).toEqual([]); // a mixed row cannot use the per-character fast path
    } finally {
      spy.mockRestore();
      con_font.string = savedFont;
      scr_usekfont.value = 1;
      test_ResetGlyphCache();
    }
  });

  test("G3: with scr_usekfont=0 a code point the charset cannot draw falls to the charset's own '?' -- no font is loaded at all", () => {
    const savedFont = con_font.string;
    con_font.string = "classic";
    scr_usekfont.value = 0;
    test_ResetGlyphCache();
    const { renderer, draws } = makeFakeRenderer(false);
    re.current = renderer;
    try {
      Text_Draw(0, 0, "\u041e");
      expect(draws).toEqual([{ x: 0, y: 0, num: "?".charCodeAt(0) }]);
    } finally {
      con_font.string = savedFont;
      scr_usekfont.value = 1;
      test_ResetGlyphCache();
    }
  });

  test("Text_Draw emits one real GL atlas quad (qglBegin(GL_QUADS)...qglEnd()) per character", () => {
    rec.calls.length = 0;
    Text_Draw(0, 0, "AB");

    const quadStarts = rec.calls.filter((c) => c.name === "qglBegin" && c.args[0] === GL_QUADS);
    const quadEnds = rec.calls.filter((c) => c.name === "qglEnd");
    expect(quadStarts.length).toBe(2);
    expect(quadEnds.length).toBe(2);

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture" && c.args[0] === GL_TEXTURE_2D);
    expect(binds.length).toBeGreaterThanOrEqual(1); // the atlas texture, registered once and reused
  });
});

// ---------------------------------------------------------------------------
// Guarded U31 real-data section: does the retail fonts/qfont.kfont cover
// every codepoint the retail loc_<lang>.txt files actually use? Reads
// fonts/qfont.kfont straight out of QuakeEX.kpf (src/lib/zipfile.ts,
// bypassing the COM virtual filesystem -- this is pure format parsing, no
// engine state needed) and the five non-English loc_<lang>.txt files
// straight out of rerelease/id1/pak0.pak (test/support/pak_reader.ts).
// Self-contained: reads only, mutates no shared singleton, so no
// beforeAll/afterAll bookkeeping is needed here (standing order 13).
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? join(REAL_Q1_DIR, "rerelease");
const KPF_PATH = join(RERELEASE_DATA_DIR, "QuakeEX.kpf");
const RERELEASE_PAK0_PATH = join(RERELEASE_DATA_DIR, "id1", "pak0.pak");
const HAVE_COVERAGE_FIXTURES = existsSync(KPF_PATH) && existsSync(RERELEASE_PAK0_PATH);

/** Every quoted-string's characters in a loc_<lang>.txt's raw text (see
 * src/lib/loc.ts's own `key = "value"` grammar note): a lightweight,
 * standalone scan of `"..."` runs with `\`-escapes resolved to a single
 * character, matching what Loc_ReloadFile's own token content ends up
 * containing. Independent of src/lib/loc.ts's real tokenizer on purpose --
 * this test's job is to characterize the RAW asset's codepoint demand, not
 * re-exercise the loc parser (that is loc.test.ts's job). */
function extractQuotedStringCodepoints(text: string): Set<number> {
  const codepoints = new Set<number>();
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          codepoints.add(text.codePointAt(j + 1)!);
          j += 2;
        } else {
          codepoints.add(text.codePointAt(j)!);
          j += 1;
        }
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return codepoints;
}

/** Independent count of mapchar entries straight from the raw token stream
 * (a plain line-count of the mapchar `{ ... }` body), deliberately NOT
 * reusing ParseKfont -- this is the cross-check that ParseKfont's `glyphs`
 * map has exactly as many entries as the file itself declares by having
 * that many glyph lines, per the unit brief's "count of glyphs parsed
 * matches the file's own declared count." */
function countMapcharEntries(text: string): number {
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  const body = text.slice(braceStart + 1, braceEnd);
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;
}

describe.skipIf(!HAVE_COVERAGE_FIXTURES)("kfont_text.ts -- U31: real fonts/qfont.kfont vs. retail loc_<lang>.txt codepoint coverage (guarded)", () => {
  const archive = HAVE_COVERAGE_FIXTURES ? ZipArchive.open(readFileSync(KPF_PATH)) : null;
  const kfontText = archive ? Buffer.from(archive.readFile("fonts/qfont.kfont")!).toString("latin1") : null;
  const parsedFont = kfontText ? ParseKfont(kfontText) : null;

  test("fonts/qfont.kfont parses, and the number of glyphs ParseKfont produces matches an independent count of the file's own mapchar lines", () => {
    expect(parsedFont).not.toBeNull();
    expect(kfontText).not.toBeNull();
    const declaredCount = countMapcharEntries(kfontText!);
    expect(parsedFont!.glyphs.size).toBe(declaredCount);
    console.log(`kfont_text.test.ts (U31): fonts/qfont.kfont declares ${declaredCount} mapchar entries, ParseKfont produced ${parsedFont!.glyphs.size} glyphs.`);
  });

  const pak = HAVE_COVERAGE_FIXTURES ? new PakFile(RERELEASE_PAK0_PATH) : null;

  for (const lang of ["russian", "french", "german", "spanish", "italian"] as const) {
    test(`localization/loc_${lang}.txt: every codepoint it uses is either covered by fonts/qfont.kfont, or printed as an uncovered exception`, () => {
      expect(parsedFont).not.toBeNull();
      expect(pak).not.toBeNull();

      const locName = `localization/loc_${lang}.txt`;
      expect(pak!.has(locName)).toBe(true);
      const text = pak!.readText(locName);
      const used = extractQuotedStringCodepoints(text);
      expect(used.size).toBeGreaterThan(0);

      const font = { pic: "/x", chars: parsedFont!.chars, glyphs: parsedFont!.glyphs, line_height: parsedFont!.line_height };
      const uncovered = [...used].filter((cp) => !kfontHasGlyph(font, cp)).sort((a, b) => a - b);

      console.log(
        `kfont_text.test.ts (U31): loc_${lang}.txt uses ${used.size} distinct codepoints; ` +
          `${uncovered.length} not covered by fonts/qfont.kfont: ` +
          uncovered.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}(${JSON.stringify(String.fromCodePoint(cp))})`).join(", "),
      );

      // fonts/qfont.kfont is verified (see this unit's report) to genuinely
      // omit a real set of codepoints these loc files use -- both ASCII
      // punctuation (e.g. '!', '(', ')', ':') and non-ASCII typographic
      // marks ('«', '»', '’', '…', '™', and, for
      // Spanish/Italian, the masculine ordinal indicator 'º') -- so
      // this test does not assert zero-uncovered; it prints the full list
      // above, per the unit brief ("except a list you print"). What IS
      // asserted, and is the actual reason U31 exists: every CASED letter
      // (Unicode Lu/Ll -- i.e. an actual alphabet character, as opposed to
      // punctuation or the Lo-category ordinal indicator) this language's
      // text uses is covered. This is where a real regression -- e.g. a
      // Cyrillic letter the font doesn't define -- would show up.
      const uncoveredCasedLetters = uncovered.filter((cp) => /\p{Lu}|\p{Ll}/u.test(String.fromCodePoint(cp)));
      expect(uncoveredCasedLetters).toEqual([]);
    });
  }
});
