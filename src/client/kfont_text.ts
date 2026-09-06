/*
U19 -- text on the client: the 2021 re-release fonts, HUD/console scaling,
and client-side `$key` resolution.

Not a port of a single original .c file. WinQuake's Draw_Character/Draw_String
(draw.c/gl_draw.c) already exist per-renderer (src/ref_soft/draw.ts,
src/ref_gl/gl_draw.ts) unchanged, and stay the classic 8x8-conchars path at
scale 1. This module is the POLICY layer the re-release adds on top of that:
- which glyph source a string draws from (`con_font`): the classic conchars
  charset each renderer's own Draw_Init already loads, the high-resolution
  fonts/qfont.kfont + fonts/qfont.png atlas (src/lib/kfont.ts), or a
  rasterized TrueType/OpenType font (src/lib/ttf.ts), gated by `scr_usekfont`
  (QuakeSpasm's own gl_screen.c name/default -- see this unit's report);
- the console/status-bar/crosshair scale cvars (`scr_conscale`/
  `scr_sbarscale`/`scr_crosshairscale`, QuakeSpasm's gl_screen.c names and
  CLAMP formulas -- see ConsoleVirtualWidth/SbarScale/CrosshairScale below);
- resolving a raw "$key" string that reaches the CLIENT without having gone
  through the server's own QEX_VarString/Loc_Localize pass
  (src/progs/ext/qex_print.ts) -- e.g. `cl.levelname`, the signon message
  reprinted to the console, and centerprint text.

GLYPH PROVIDER / RENDERER SEAM (see this unit's report for the full writeup):
`Text_Width`/`Text_Draw` below are the renderer-neutral entry points every
caller (console.ts, sbar.ts, screen.ts) uses. Internally they call
`getRenderer().Draw_GlyphAtlas(...)` -- a member src/client/render.ts's
`interface Renderer` declares (PORTING.md's "Renderer seam"), implemented by
both src/ref_gl/gl_draw.ts and src/ref_soft/draw.ts's own `Draw_GlyphAtlas`
functions and wired onto each renderer object in src/ref_gl/ref_gl.ts /
src/ref_soft/ref_soft.ts (U44). Before U44 landed that member, this file
reached those two renderer modules DIRECTLY through a pair of lazy
`require()`s (matching console.ts's own established pattern for the
identical reason: gl_draw.ts statically imports Con_Printf from console.ts
and Sbar_Changed from sbar.ts, and draw.ts statically imports Con_Printf
from console.ts too, so a static import of either renderer file here,
combined with console.ts/sbar.ts/screen.ts statically importing THIS file,
would have closed a load-order cycle), picking between them with
`getRenderer().isGL` -- a documented, temporary crossing of PORTING.md's
"nothing outside src/ref_soft and src/ref_gl imports either renderer except
src/platform/vid.ts" rule. `getRenderer().Draw_GlyphAtlas(...)` needs neither
import nor the isGL branch for either real renderer: both carry the member
directly (src/ref_gl/ref_gl.ts's and src/ref_soft/ref_soft.ts's own
`Draw_GlyphAtlas`). `GlyphAtlasSourceT` moved to render.ts, next to the
interface member that uses it; this file imports it type-only from there.

`Renderer.Draw_GlyphAtlas` is declared OPTIONAL (unlike every other draw.h
member), and `drawGlyphAtlas` below keeps the old isGL-keyed lazy-require
dispatch as a FALLBACK for when it is absent, for one reason outside this
unit's SCOPE to fix directly: several test files elsewhere in this repo
(console.test.ts's own makeFakeRenderer() shape and its copies, none of
which this unit's brief lists) build a fake `Renderer` object satisfying the
interface as it stood before this member existed, and requiring it would
have broken every one of them for a member most never exercise (some do --
test/screen_scale.test.ts spies on the real src/ref_soft/draw.ts export and
needs a real call to reach it). The fallback reproduces this file's exact
PRE-U44 behavior (reach the real module directly, keyed on `isGL`) so every
such fixture keeps working unchanged. A real renderer (or any fake one built
against this member, e.g. this file's own tests) never falls into it.

SCALING RULES (QuakeSpasm gl_screen.c names/semantics, this unit's SCOPE):
- `scr_conscale`: console virtual width = `scr_conscale.value > 0 ?
  vid.width / scr_conscale.value : vid.width` (0 or negative = native
  resolution, no upscaling), clamped to [320, vid.width] and rounded down to
  a multiple of 8 -- QuakeSpasm's own SCR_Conwidth_f formula, ported into
  ConsoleVirtualWidth() below. screen.ts writes the result into
  `vid.conwidth`/`vid.conheight` once a frame (SCR_Init and the top of
  SCR_UpdateScreen), which lights up src/ref_gl/gl_draw.ts's and
  src/ref_soft/draw.ts's OWN pre-existing vid.conwidth-aware code (the
  conback placement math, the software Draw_ConsoleBackground stretch
  blit) for free -- neither needed a new mechanism, just a real (non-1:1)
  vid.conwidth to react to. console.ts's Con_CheckResize reads
  `vid.conwidth` instead of `vid.width` (the one-line change QuakeSpasm's
  own console.c has for the same cvar), and every console glyph draw
  computes its position in that same virtual space, then asks
  Draw_GlyphAtlas for a destination rect scaled by `vid.width/vid.conwidth`
  -- see ConsoleScale() below.
- `scr_sbarscale`: `CLAMP(1, scr_sbarscale.value, vid.width/320)`, ported as
  SbarScale() below. This unit (U19) applied it narrowly: only the status
  bar's TEXT (Sbar_DrawCharacter/Sbar_DrawString in sbar.ts, which this unit
  routes through Text_Draw) scaled; the status bar's PIC-based elements
  (health/ammo digit pics, weapon/item icons, `Sbar_DrawPic`) did not, since
  scaling those too meant rewriting sbar.ts's whole coordinate convention
  from "real screen pixels with `(vid.width-320)>>1` centering baked into
  each wrapper" to QuakeSpasm's modern "virtual 320-space,
  GL_SetCanvas(CANVAS_SBAR) does the centering/scaling" convention -- too
  large a refactor for this unit, reported as a follow-up. F2 closed that
  follow-up (Sbar_DrawPic/Sbar_DrawTransPic now scale too, through
  render.ts's own Draw_ScaledPic/Draw_ScaledTransPic), and F2b closed the
  gap F2 left open: the anchor those wrappers scale AROUND is now itself
  tied to the scale (`(vid.width-320*s)/2`, `vid.height-24*s`) instead of
  staying fixed at the scale-1 position while the drawn footprint grows past
  it -- see sbar.ts's own header for the full account of both.
- `scr_crosshairscale`: `CLAMP(1, scr_crosshairscale.value, 10)`, ported as
  CrosshairScale() below and exported for use, but NOT wired to an actual
  crosshair draw call: `SCR_DrawCrosshair`/`V_DrawCrosshair` are `Renderer`
  methods implemented in src/ref_gl/ref_gl.ts and a software r_main.ts, both
  outside this unit's SCOPE. Reported as a follow-up.
- Menus (menu.ts, `scr_menuscale`) and the deathmatch/mini-deathmatch
  scoreboard overlays (real QuakeSpasm's own `GL_SetCanvas(CANVAS_MENU)` --
  checked against ~/Projects/qsrc/quakespasm/Quake/sbar.c) are explicitly
  out of this unit's scope; their unscaled path is unchanged.
*/

import { CvarT, Cvar_FindVar, Cvar_RegisterVariable } from "../common/cvar";
import { COM_LoadTempFile } from "../common/common";
import { decodePNG } from "../lib/png";
import { ParseKfont, kfontGlyph, Kfont_FromTTF, TtfKfont_Lookup, type KfontT, type TtfKfontT } from "../lib/kfont";
import { parseFont, buildFontAtlas, latin1Codepoints, type ParsedFontT } from "../lib/ttf";
import { Loc_Localize, Loc_ReloadFile } from "../lib/loc";
import { getRenderer, type GlyphAtlasSourceT } from "./render";
import { vid } from "./vid";
// see this file's header's "Renderer.Draw_GlyphAtlas is declared OPTIONAL"
// paragraph: fallback-only lazy require()s, reached only when the active
// Renderer omits the member.
import type * as GlDrawModule from "../ref_gl/gl_draw";
import type * as SoftDrawModule from "../ref_soft/draw";

//=============================================================================
// Cvars
//=============================================================================

// QuakeSpasm gl_screen.c: `cvar_t scr_usekfont = {"scr_usekfont", "0",
// CVAR_NONE};` -- not archived, default off; the re-release's own quake.rc
// sets it to 1 for re-release content (grepped: no other module in this
// tree registers it).
export const scr_usekfont = new CvarT("scr_usekfont", "0");

// This project's own addition -- no QuakeSpasm counterpart (that engine's
// scr_usekfont is a bare on/off toggle with no TTF option). See this file's
// header for the three accepted values.
export const con_font = new CvarT("con_font", "kfont", true);

// QuakeSpasm gl_screen.c: all three default to "1", CVAR_ARCHIVE.
export const scr_conscale = new CvarT("scr_conscale", "1", true);
export const scr_sbarscale = new CvarT("scr_sbarscale", "1", true);
export const scr_crosshairscale = new CvarT("scr_crosshairscale", "1", true);

// src/progs/ext/ruleset.ts already declares `language` (server-side, for
// QuakeC `$key` formatting) and registers it from QEX_RegisterCvars --
// whichever module's Init runs first wins the registration; this module
// only registers its OWN instance as a fallback when nothing has claimed
// the name yet (see this file's header: "register once, whichever module
// loads first, read via Cvar_FindVar"). Matches ruleset.ts's own
// name/default/archive exactly.
const languageFallback = new CvarT("language", "english", true);

export function KfontText_RegisterCvars(): void {
  Cvar_RegisterVariable(scr_usekfont);
  Cvar_RegisterVariable(con_font);
  Cvar_RegisterVariable(scr_conscale);
  Cvar_RegisterVariable(scr_sbarscale);
  Cvar_RegisterVariable(scr_crosshairscale);
  if (!Cvar_FindVar("language")) Cvar_RegisterVariable(languageFallback);
}

//=============================================================================
// Scale helpers -- QuakeSpasm gl_screen.c / gl_draw.c formulas
//=============================================================================

function clamp(lo: number, v: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** SCR_Conwidth_f's `vid.conwidth` formula (gl_screen.c), minus the
 * `scr_conwidth` cvar this project does not port (not in the unit brief's
 * cvar list). 0 or negative scr_conscale means "native resolution". */
export function ConsoleVirtualWidth(): number {
  const s = scr_conscale.value;
  let w = s > 0 ? vid.width / s : vid.width;
  w = clamp(320, w, Math.max(320, vid.width));
  w = Math.floor(w) & ~7; // & 0xFFFFFFF8 in the C
  return w < 8 ? 8 : w; // defensive floor; vid.width is always >= 320 once video is up
}

export function ConsoleVirtualHeight(): number {
  const vw = ConsoleVirtualWidth();
  if (vid.width <= 0) return vid.height;
  return Math.round((vw * vid.height) / vid.width);
}

/** Real-pixels-per-virtual-unit multiplier for the console canvas. */
export function ConsoleScale(): number {
  const vw = ConsoleVirtualWidth();
  return vw > 0 ? vid.width / vw : 1;
}

/** gl_draw.c GL_SetCanvas's CANVAS_SBAR scale: `CLAMP(1, scr_sbarscale.value,
 * glwidth/320)`. */
export function SbarScale(): number {
  const maxScale = vid.width / 320;
  return clamp(1, scr_sbarscale.value, Math.max(1, maxScale));
}

/** gl_draw.c GL_SetCanvas's CANVAS_CROSSHAIR scale: `CLAMP(1,
 * scr_crosshairscale.value, 10)`. Exported for a future crosshair-drawing
 * unit; not wired to any draw call here -- see this file's header. */
export function CrosshairScale(): number {
  return clamp(1, scr_crosshairscale.value, 10);
}

//=============================================================================
// Glyph provider
//=============================================================================

export interface GlyphRectT {
  x: number;
  y: number;
  w: number;
  h: number;
  color?: boolean;
}

type FontSourceT = "classic" | "kfont" | "ttf";

interface ActiveFontT {
  source: FontSourceT;
  width: number;
  height: number;
  lineHeight: number;
  pixels: Uint8Array | null; // RGBA8 straight alpha; null only for "classic"
  atlasId: string; // cache key for the renderer's own atlas-texture registration
  glyph(codepoint: number): GlyphRectT | null;
}

const CLASSIC_GLYPH_SIZE = 8;
// Approximation of the classic conchars "alt" (golden) charset color, applied
// as a runtime tint to kfont/ttf glyphs when alt text is requested -- neither
// atlas source bakes a second, gold-tinted glyph set the way conchars does
// (verified against the real fonts/qfont.kfont: see this unit's report), so
// there is no baked region to select the way Draw_Alt_String's `| 0x80]` does
// for classic. Documented deviation, not a silent behavior change.
const ALT_TINT: readonly [number, number, number] = [0.85, 0.65, 0.12];

function normalizeLanguage(raw: string): string {
  return raw.trim().toLowerCase() || "english";
}

function currentLanguage(): string {
  const cv = Cvar_FindVar("language");
  return normalizeLanguage(cv ? cv.string : "english");
}

// con_font-keyed cache: reparsing/rerasterizing on every Text_Draw call
// would be needlessly expensive, so the resolved font is cached until
// scr_usekfont/con_font/the TTF pixel size (which itself depends on the
// console scale) changes.
let cachedKey = "";
let cachedFont: ActiveFontT | null = null; // null = classic fallback

function loadKfontFont(): ActiveFontT | null {
  const kBytes = COM_LoadTempFile("fonts/qfont.kfont");
  if (!kBytes) return null;
  const text = Buffer.from(kBytes).toString("latin1");
  const parsed = ParseKfont(text);
  if (!parsed) return null;

  const pngBytes = COM_LoadTempFile(parsed.textureToken);
  if (!pngBytes) return null;
  const decoded = decodePNG(pngBytes);
  if (!decoded.ok) return null;

  // U31: `glyphs` (not the legacy ASCII-only `chars` array) is the lookup
  // this font source uses -- the retail fonts/qfont.kfont defines
  // codepoints up to 7838 (the Cyrillic block and more), and the UTF-8 text
  // path below needs every one of them reachable, not just [32, 126].
  const font: KfontT = { pic: "/" + parsed.textureToken, chars: parsed.chars, glyphs: parsed.glyphs, line_height: parsed.line_height };
  return {
    source: "kfont",
    width: decoded.image.width,
    height: decoded.image.height,
    lineHeight: parsed.line_height,
    pixels: decoded.image.pixels,
    atlasId: "kfont:" + parsed.textureToken,
    glyph: (cp: number): GlyphRectT | null => kfontGlyph(font, cp),
  };
}

// Pixel size for the rasterized TTF atlas, derived from the console canvas
// scale per the unit brief ("a size derived from the canvas scale"):
// CLASSIC_GLYPH_SIZE (the 8px classic cell) times the current console
// scale, floored to an integer and never smaller than the classic size.
function ttfPixelSize(): number {
  return Math.max(CLASSIC_GLYPH_SIZE, Math.round(CLASSIC_GLYPH_SIZE * ConsoleScale()));
}

const ttfParseCache = new Map<string, ParsedFontT | null>();

function loadTtfFont(nameArg: string): ActiveFontT | null {
  const name = nameArg.trim();
  if (name.length === 0) return null;

  let parsed = ttfParseCache.get(name);
  if (parsed === undefined) {
    const candidates = /\.(ttf|otf)$/i.test(name) ? [name] : [`${name}.ttf`, `${name}.otf`];
    parsed = null;
    for (const candidate of candidates) {
      const bytes = COM_LoadTempFile(`fonts/${candidate}`);
      if (!bytes) continue;
      const result = parseFont(bytes);
      if (result.ok) {
        parsed = result.font;
        break;
      }
    }
    ttfParseCache.set(name, parsed);
  }
  if (!parsed) return null;

  const px = ttfPixelSize();
  const atlas = buildFontAtlas(parsed, latin1Codepoints(), px);
  const kfont: TtfKfontT = Kfont_FromTTF(atlas, `ttf:${name}:${px}`);
  return {
    source: "ttf",
    width: atlas.width,
    height: atlas.height,
    lineHeight: atlas.lineHeight,
    pixels: atlas.pixels,
    atlasId: kfont.pic,
    glyph: (cp: number): GlyphRectT | null => TtfKfont_Lookup(kfont, cp),
  };
}

function loadFont(): ActiveFontT | null {
  const mode = con_font.string.trim().toLowerCase();
  if (mode === "classic") return null;
  if (scr_usekfont.value === 0) return null; // master toggle, matches QuakeSpasm's own cvar name/intent
  if (mode.startsWith("ttf:")) return loadTtfFont(mode.slice(4)) ?? null;
  return loadKfontFont() ?? null; // "kfont" (the default) or anything unrecognized
}

function resolveFont(): ActiveFontT | null {
  const key = `${scr_usekfont.value}|${con_font.string}|${con_font.string.trim().toLowerCase().startsWith("ttf:") ? ttfPixelSize() : 0}`;
  if (key === cachedKey) return cachedFont;
  cachedKey = key;
  cachedFont = loadFont();
  return cachedFont;
}

/** Test-only: drop the cached font so the next Text_Width/Text_Draw call
 * re-resolves it from the current cvars. Named per standing order 15's
 * `test_` prefix convention for test-only entry points. */
export function test_ResetGlyphCache(): void {
  cachedKey = "";
  cachedFont = null;
}

//=============================================================================
// Renderer dispatch (see this file's header: U44 closed the seam deviation)
//=============================================================================

// Re-exported for callers that used to import the type from here (its home
// before U44 moved the declaration next to Renderer.Draw_GlyphAtlas).
export type { GlyphAtlasSourceT } from "./render";

// Fallback-only: see this file's header. Reached only when
// `getRenderer().Draw_GlyphAtlas` is undefined (a test's fake Renderer built
// before this member existed).
function glDrawMod(): typeof GlDrawModule {
  return require("../ref_gl/gl_draw");
}
function softDrawMod(): typeof SoftDrawModule {
  return require("../ref_soft/draw");
}

function drawGlyphAtlas(
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
): void {
  const r = getRenderer();
  if (r.Draw_GlyphAtlas) {
    r.Draw_GlyphAtlas(dstX, dstY, dstW, dstH, source, srcX, srcY, srcW, srcH, tint);
    return;
  }
  const mod = r.isGL ? glDrawMod() : softDrawMod();
  mod.Draw_GlyphAtlas(dstX, dstY, dstW, dstH, source, srcX, srcY, srcW, srcH, tint);
}

//=============================================================================
// Text_Width / Text_Draw
//=============================================================================

function fallbackGlyph(font: ActiveFontT): GlyphRectT | null {
  return font.glyph("?".charCodeAt(0));
}

/** Total advance width, in real pixels, of `s` at the given scale. */
export function Text_Width(s: string, scale = 1): number {
  const font = resolveFont();
  if (!font) return s.length * CLASSIC_GLYPH_SIZE * scale;

  let w = 0;
  const fb = fallbackGlyph(font);
  // DEFECT D6 FIX: iterate real Unicode code points (`for...of` over a JS
  // string decodes surrogate pairs), not UTF-16 code units -- a codepoint
  // past the Basic Multilingual Plane is two `charCodeAt` units, and
  // measuring/drawing each half separately would look up two bogus
  // half-codepoints instead of the one real glyph. None of this project's
  // kfont/loc data currently ships a codepoint that high (the retail
  // fonts/qfont.kfont's own highest entry is U+1E9E, still in the BMP -- see
  // src/lib/kfont.ts's own U31 header note), so this has no observable
  // effect on today's fixtures; it is still the correct general contract.
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const g = font.glyph(cp) ?? fb;
    w += (g ? g.w : CLASSIC_GLYPH_SIZE) * scale;
  }
  return w;
}

/**
 * Draws `s` with its top-left glyph cell at real-pixel (x, y), at the given
 * scale (a plain multiplier on both glyph size and advance -- callers
 * compute their own already-real destination coordinates; see this file's
 * header on why no ambient canvas/ortho state is used). `alt` requests the
 * classic golden charset under "classic" (Draw_Alt_String's own `| 0x80`
 * row-select) or a golden runtime tint under kfont/ttf (see ALT_TINT).
 */
export function Text_Draw(x: number, y: number, s: string, alt = false, scale = 1): void {
  const font = resolveFont();

  if (!font) {
    if (scale === 1) {
      // Preserves the EXACT pre-U19 call sequence (renderer.Draw_Character,
      // once per character, same x/y/num) at classic/scale 1 -- the case
      // every existing test (console.test.ts, sbar.test.ts, screen.test.ts,
      // both renderers' own suites) already covers. Draw_Character's own
      // body already skips drawing a space (`num === 32`) while still
      // advancing the cursor, exactly like the loop below.
      const r = getRenderer();
      let cx = x;
      for (let i = 0; i < s.length; i++) {
        r.Draw_Character(cx, y, (s.charCodeAt(i) & 0xff) | (alt ? 0x80 : 0));
        cx += CLASSIC_GLYPH_SIZE;
      }
      return;
    }

    // A scaled classic charset has no pre-U19 counterpart to match -- routed
    // through the new Draw_GlyphAtlas primitive, sourcing the SAME
    // char_texture/draw_chars atlas Draw_Character itself reads (see that
    // primitive's own doc comment in gl_draw.ts/draw.ts).
    let cx = x;
    for (let i = 0; i < s.length; i++) {
      const num = (s.charCodeAt(i) & 0xff) | (alt ? 0x80 : 0);
      if (num !== 0x20 /* Draw_Character's own space check, before any alt bit would apply */) {
        const row = num >> 4;
        const col = num & 15;
        drawGlyphAtlas(cx, y, CLASSIC_GLYPH_SIZE * scale, CLASSIC_GLYPH_SIZE * scale, { kind: "classic" }, col * 8, row * 8, 8, 8, null);
      }
      cx += CLASSIC_GLYPH_SIZE * scale;
    }
    return;
  }

  const source: GlyphAtlasSourceT = { kind: "custom", id: font.atlasId, width: font.width, height: font.height, pixels: font.pixels ?? new Uint8Array(0) };
  const tint = alt ? ALT_TINT : null;
  const fb = fallbackGlyph(font);

  let cx = x;
  // DEFECT D6 FIX: code points, not UTF-16 units -- see Text_Width's own
  // comment above for why (a decoded loc string can contain any Unicode
  // text now that src/lib/loc.ts decodes as UTF-8).
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const g = font.glyph(cp) ?? (cp === 0x20 ? null : fb); // a real, resolvable space just advances; an unmapped glyph falls back to '?'
    if (g) {
      const dstW = g.w * scale;
      const dstH = g.h * scale;
      drawGlyphAtlas(cx, y, dstW, dstH, source, g.x, g.y, g.w, g.h, g.color ? null : tint);
      cx += dstW;
    } else {
      cx += CLASSIC_GLYPH_SIZE * scale;
    }
  }
}

//=============================================================================
// Client-side `$key` resolution
//=============================================================================

// See this file's header: reads/writes the SAME shared table
// src/lib/loc.ts owns (src/progs/ext/ruleset.ts's QEX_LoadLocalization is
// the other writer, server-side, for QuakeC `$key` formatting). Reloading
// with the language the server already loaded is a harmless no-op re-parse
// (same file, same bytes); this only does real work the first time a
// client-side `$key` needs resolving with nothing loaded yet (a remote
// client, or demo playback, with no local server running QEX_LoadLocalization).
let clLocLoadedFor: string | null = null;

function ensureClLocTable(): void {
  const lang = currentLanguage();
  if (lang === clLocLoadedFor) return;
  clLocLoadedFor = lang;

  let bytes = COM_LoadTempFile(`localization/loc_${lang}.txt`);
  if (bytes === null && lang !== "english") bytes = COM_LoadTempFile("localization/loc_english.txt");
  Loc_ReloadFile(bytes);
}

/**
 * Resolves a raw "$key" string against the client's own loc table -- the
 * same fallback contract src/progs/ext/qex_print.ts's QEX_LocGetString uses
 * server-side: a string not starting with '$' is returned unchanged, and a
 * miss (no table loaded, or the key isn't in it) returns the key text
 * without its leading '$' (src/lib/loc.ts's Loc_Localize own miss path).
 * `{N}` argument placeholders are left untouched -- per the unit brief, the
 * server has already substituted them by the time text reaches the client.
 */
export function CL_LocalizeKey(s: string): string {
  if (s.length === 0 || s.charAt(0) !== "$") return s;
  ensureClLocTable();
  return Loc_Localize(s, false, null, 0);
}

/** Test-only: forget which language's table this module last loaded, so the
 * next CL_LocalizeKey call reloads from the current `language` cvar. */
export function test_ResetClLocCache(): void {
  clLocLoadedFor = null;
}
