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
- `scr_conscale`: console virtual width = `vid.width / scale`, clamped to
  [320, vid.width] and rounded down to a multiple of 8 -- QuakeSpasm's own
  SCR_Conwidth_f formula, ported into ConsoleVirtualWidth() below. The scale
  is the cvar when it is positive; 0 (the default, G4/2026-09-07) means AUTO:
  `max(1, floor(vid.height / 300))`, i.e. 1 below 600 rows, 2 at 720p, 3 at
  1080p, 4 at 1440p -- about the re-release's own 28 px console line at
  1080p. QuakeSpasm has no auto and defaults to 1 (native, 8 px glyphs on a
  1080p screen), which is what Mike saw and rejected. screen.ts writes the result into
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
- `scr_sbarscale`: `CLAMP(1, scr_sbarscale.value, fit)` with `fit =
  max(1, min(floor(vid.width/320), floor(vid.height/144)))`, ported as
  SbarScale() below; 0 (the default, G4/2026-09-07) means AUTO = `fit`, so the
  classic 320-wide bar spans the window like it did at 320x200 (4x at 720p,
  6x at 1080p) while never taking more than a third of the height.
  QuakeSpasm's own clamp is `vid.width/320` with a default of 1. This unit (U19) applied it narrowly: only the status
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

F14 addition (2026-09-06): menu.ts's M_Print/M_PrintWhite/M_PrintRight now
draw through Text_Draw as well, so a localized label (loc_russian.txt's
Cyrillic "Один игрок", say) resolves real glyphs instead of the classic
charset's byte-indexed garbage. menu.c lays its screens out on a fixed 8px
row grid, and the kfont's own line height is whatever the shipped font
declares (28px in the retail fonts/qfont.kfont), so the menu asks
Text_RowScale(8) below for the multiplier that fits one kfont line into one
menu row and hands it to Text_Draw/Text_Width as the scale. Text_RowScale
returns exactly 1 on the classic charset path, which is what keeps a
classic boot's menu geometry and its per-character Draw_Character sequence
byte-identical. `scr_menuscale` is still not ported.

F17 addition (2026-09-06): GLYPH FALLBACK POLICY -- what Text_Draw/Text_Width
do with a code point the active kfont/ttf font does not define. Before this
unit, an unmapped code point fell back to the font's own '?' glyph if it had
one, and drew NOTHING (a silently dropped character, only advancing the
cursor) if it did not -- the Keys screen's bound-key names ("???" for an
unbound key) and most ASCII punctuation are absent from the retail
fonts/qfont.kfont (see src/lib/kfont.ts's U31 header note and this file's own
guarded coverage test in test/kfont_text.test.ts), so under `con_font kfont`
real UI text was going missing outright. This is a QUALITY-OF-LIFE addition,
not a KEX fidelity concern: the KEX engine is closed source, so its own
uncovered-glyph behavior is unknown and unspecifiable, and there is no
existing cvar family (`scr_usekfont`/`con_font`) whose semantics this
changes -- the policy is unconditional, not gated behind a new cvar, because
"draw nothing" was never an intentional behavior to preserve, just the
absence of one.

The new policy, applied identically inside Text_Width and Text_Draw so the
two never disagree on an advance width:
  1. `font.glyph(cp)` found -- draw/measure the atlas glyph, unchanged.
  2. cp is U+0020 (space) and the font has no glyph for it -- just advance
     by one classic cell, unchanged (matches Draw_Character's own
     `num === 32` skip).
  3. cp <= 0xFF (representable as one of the classic charset's 256
     byte-indexed cells) -- draw/measure the classic 8x8 charset glyph AT
     THAT CODE POINT'S OWN INDEX (row = cp>>4, col = cp&15), scaled by the
     same `scale` the caller passed in (so it sits on the row like the
     kfont glyphs around it, per Text_RowScale) -- e.g. a codepoint in
     Latin-1 Supplement that happens to share a byte value with a WinQuake
     charset cell draws that cell, not '?'; this is a deliberate reuse of
     the charset's existing 256-cell layout as a fallback source, not a
     claim that the two code spaces mean the same glyph.
  4. cp > 0xFF (the classic charset has no cell for it at all) -- the
     font's own '?' glyph if it defines one (the pre-F17 behavior for this
     case); otherwise the classic charset's own '?' cell (still scaled).
Every one of these draws or explicitly no-ops (case 2) -- none of them skip
a character silently.

G3 (2026-09-07) -- TWO CORRECTIONS, both from Mike playing the re-release
id1 tree in a large GL window and finding every text surface unreadable.

(1) WHAT `scale` MEANS. Text_Draw/Text_Width's `scale` is now stated in
CLASSIC TEXT CELLS -- one line of text occupies CLASSIC_GLYPH_SIZE * scale
real pixels under EVERY font source, and a kfont/TTF glyph is multiplied by
`atlasFit` below so its declared line height lands on exactly that. That is
the unit every caller was already laying out in and the one none of them
could satisfy before: console.ts's rows are `8 * ConsoleScale()` apart,
screen.ts's centerprint rows are 8 apart, sbar.ts's are `8 * SbarScale()`,
and menu.c's are a fixed 8 -- while Text_Draw was handing back glyphs at
their raw ATLAS size. The retail fonts/qfont.kfont declares a 28px line and
8-31px glyphs, so every one of those surfaces was drawing 28-pixel letters
on an 8-pixel grid: rows overlapped the rows under them, glyphs overlapped
their right-hand neighbours, and a mixed string (F17's classic-charset
fallback for a code point the font omits, drawn at 8px next to 28px kfont
letters -- the retail font has no ':' , '?' or '(' ) drew at two sizes on
one row. Text_LineHeight() therefore reports the DRAWN line height (the
classic cell) rather than the atlas's own declaration, and Text_RowScale is
`rowHeight / CLASSIC_GLYPH_SIZE` for every source -- so menu.ts's
Text_RowScale(MENU_ROW_HEIGHT) is 1 again instead of the 8/28 that squeezed
the Options and Multiplayer rows down to unreadable 5x8 smudges (F14 read
the atlas declaration and Text_Draw consumed a different unit, so the two
ends of that call disagreed by the font's own line height).

(2) WHICH FONT DRAWS. Mike's ruling, 2026-09-07: the classic conchars
charset is the default text source for the menus, console, notify lines,
centerprints and HUD on ALL content, re-release included. The high
resolution fonts are used only when they are asked for or when the charset
genuinely cannot draw the text:
  - `con_font` (default "classic", was "kfont") selects the source for ALL
    text: "classic", "kfont" (fonts/qfont.kfont + its PNG atlas), or
    "ttf:<name>".
  - `scr_usekfont` (default 0; the re-release id1 tree's own quake.rc sets
    it to 1, with the comment "opt into unicode font rendering") no longer
    switches every surface over to the kfont. It now means what that comment
    says: with `con_font classic` in force, a code point the byte-indexed
    charset has no cell for (cp > 0xFF -- Cyrillic, Greek, CJK from a
    loc_<lang>.txt) is drawn from the kfont, fitted to the same row as the
    classic cells around it, and everything the charset CAN draw still comes
    from the charset. Mixing is per code point, not per string, because
    correction (1) put both sources on one row height.
A pure-classic string at scale 1 still emits the identical per-character
renderer.Draw_Character sequence menu.c/console.c/sbar.c wrote, byte for
byte, and that fast path is now taken whenever every code point in the
string resolves to the charset -- not only when no font is loaded at all.
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
// CVAR_NONE};` -- not archived, default off; the re-release id1 tree's own
// quake.rc sets it to 1, under its own comment "opt into unicode font
// rendering" (grepped: no other module in this tree registers it). G3 gives
// it exactly that meaning -- the unicode COVERAGE opt-in, not a whole-UI
// font switch; see this file's header.
export const scr_usekfont = new CvarT("scr_usekfont", "0");

// This project's own addition -- no QuakeSpasm counterpart (that engine's
// scr_usekfont is a bare on/off toggle with no TTF option). See this file's
// header for the three accepted values.
// Default "classic" (Mike, 2026-09-06): the Quake charset is the look of the
// menus, console and HUD on every content tree; the re-release kfont is opt-in
// (`con_font kfont`) or a per-string fallback for code points the charset lacks.
export const con_font = new CvarT("con_font", "classic", true);

// QuakeSpasm gl_screen.c: all three default to "1", CVAR_ARCHIVE. Here the
// console and status-bar scales default to "0" = auto (see the header's
// SCALING RULES); the crosshair keeps QuakeSpasm's 1.
export const scr_conscale = new CvarT("scr_conscale", "0", true);
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

/** The console scale `scr_conscale 0` (auto) resolves to: one until the
 * window is 600 rows tall, then one more step per 300 rows (2 at 720p, 3 at
 * 1080p). See the header's SCALING RULES. */
export function ConsoleAutoScale(): number {
  return Math.max(1, Math.floor(vid.height / 300));
}

/** SCR_Conwidth_f's `vid.conwidth` formula (gl_screen.c), minus the
 * `scr_conwidth` cvar this project does not port (not in the unit brief's
 * cvar list). 0 or negative scr_conscale means auto (ConsoleAutoScale). */
export function ConsoleVirtualWidth(): number {
  const s = scr_conscale.value > 0 ? scr_conscale.value : ConsoleAutoScale();
  let w = vid.width / s;
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

/** The largest whole scale at which the classic 320-wide status bar fits the
 * window and stays under a third of its height: `max(1, min(floor(w/320),
 * floor(h/144)))` (144 = three bar heights of 48). */
export function SbarFitScale(): number {
  return Math.max(1, Math.min(Math.floor(vid.width / 320), Math.floor(vid.height / 144)));
}

/** gl_draw.c GL_SetCanvas's CANVAS_SBAR scale, `CLAMP(1, scr_sbarscale.value,
 * glwidth/320)`, with two changes: the ceiling is SbarFitScale() (whole
 * steps, height-aware) and a non-positive cvar means auto = that ceiling. */
export function SbarScale(): number {
  const fit = SbarFitScale();
  return scr_sbarscale.value > 0 ? clamp(1, scr_sbarscale.value, fit) : fit;
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
let cachedMode: TextModeT | null = null;

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

/**
 * How the two font cvars combine (see this file's G3 header note).
 * - "classic": the conchars charset draws everything it has a cell for.
 *   `unicode` is the kfont consulted for the code points it does not
 *   (cp > 0xFF), or null when `scr_usekfont` is off or no kfont loaded.
 * - "font": `con_font` names a high-resolution font, and it draws all text.
 */
type TextModeT =
  | { readonly kind: "classic"; readonly unicode: ActiveFontT | null }
  | { readonly kind: "font"; readonly font: ActiveFontT };

function loadNamedFont(name: string): ActiveFontT | null {
  if (name.startsWith("ttf:")) return loadTtfFont(name.slice(4));
  return loadKfontFont(); // "kfont" or anything unrecognized
}

function loadMode(): TextModeT {
  const name = con_font.string.trim().toLowerCase();
  if (name !== "" && name !== "classic") {
    const font = loadNamedFont(name);
    // A named font that will not load leaves the charset drawing, which is
    // what a missing fonts/qfont.kfont has always meant here.
    if (font) return { kind: "font", font };
  }
  return { kind: "classic", unicode: scr_usekfont.value !== 0 ? loadKfontFont() : null };
}

function resolveMode(): TextModeT {
  const key = `${scr_usekfont.value}|${con_font.string}|${con_font.string.trim().toLowerCase().startsWith("ttf:") ? ttfPixelSize() : 0}`;
  if (key === cachedKey && cachedMode !== null) return cachedMode;
  cachedKey = key;
  cachedMode = loadMode();
  return cachedMode;
}

/** Test-only: drop the cached font so the next Text_Width/Text_Draw call
 * re-resolves it from the current cvars. Named per standing order 15's
 * `test_` prefix convention for test-only entry points. */
export function test_ResetGlyphCache(): void {
  cachedKey = "";
  cachedMode = null;
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

const CLASSIC_QMARK_CODEPOINT = "?".charCodeAt(0);

/* The classic charset is byte-indexed: it has a cell for every code point up
 * to this one and none above it. */
const CLASSIC_MAX_CODEPOINT = 0xff;

// F17 (the code-point-not-in-the-font policy) and G3 (which source draws a
// code point at all) -- see this file's header for both writeups.
type GlyphResolutionT =
  | { readonly draw: "atlas"; readonly glyph: GlyphRectT; readonly font: ActiveFontT }
  | { readonly draw: "classic"; readonly codepoint: number }
  | { readonly draw: "none" };

function atlasGlyph(font: ActiveFontT, cp: number): GlyphResolutionT | null {
  const g = font.glyph(cp);
  return g ? { draw: "atlas", glyph: g, font } : null;
}

function resolveGlyph(mode: TextModeT, cp: number): GlyphResolutionT {
  if (mode.kind === "classic") {
    // The charset draws everything it has a cell for, which is every code
    // point that fits in a byte (F17 case 3's reuse of its 256 cells).
    if (cp <= CLASSIC_MAX_CODEPOINT) return { draw: "classic", codepoint: cp };
    const font = mode.unicode;
    if (font) {
      const g = atlasGlyph(font, cp) ?? (fallbackGlyph(font) !== null ? atlasGlyph(font, CLASSIC_QMARK_CODEPOINT) : null);
      if (g) return g;
    }
    return { draw: "classic", codepoint: CLASSIC_QMARK_CODEPOINT };
  }

  const font = mode.font;
  const g = atlasGlyph(font, cp);
  if (g) return g; // case 1
  if (cp === 0x20) return { draw: "none" }; // case 2
  if (cp <= CLASSIC_MAX_CODEPOINT) return { draw: "classic", codepoint: cp }; // case 3
  const fb = atlasGlyph(font, CLASSIC_QMARK_CODEPOINT);
  if (fb) return fb; // case 4, font's own '?'
  return { draw: "classic", codepoint: CLASSIC_QMARK_CODEPOINT }; // case 4, charset '?'
}

/*
G3: ATLAS pixels -> real pixels. One line of `font` occupies exactly the
CLASSIC_GLYPH_SIZE * scale real pixels one classic charset cell does at the
same scale, so a kfont/TTF glyph sits on the row its caller laid out and a
classic-charset fallback glyph on the same row is the same height. See this
file's header for why every caller needs that and none of them could get it
before.
*/
function atlasFit(font: ActiveFontT, scale: number): number {
  const declared = font.lineHeight > 0 ? font.lineHeight : CLASSIC_GLYPH_SIZE;
  return (CLASSIC_GLYPH_SIZE * scale) / declared;
}

/** The real-pixel advance width `resolveGlyph`'s result contributes, at the
 * given scale. Shared by Text_Width and Text_Draw so the two never
 * disagree: an atlas glyph advances by its own (possibly non-8px) width
 * fitted to the row, and every classic-charset or no-op case advances by one
 * classic cell. */
function resolvedAdvance(r: GlyphResolutionT, scale: number): number {
  return r.draw === "atlas" ? r.glyph.w * atlasFit(r.font, scale) : CLASSIC_GLYPH_SIZE * scale;
}

/** The DRAWN height of one line of text at scale 1, in real pixels. G3: the
 * classic charset's 8px cell IS the line under every font source, because
 * `atlasFit` scales a kfont/TTF line onto exactly that cell -- so a
 * multi-line caller advances its rows by `Text_LineHeight() * scale`
 * whatever `con_font` says. */
export function Text_LineHeight(): number {
  return CLASSIC_GLYPH_SIZE;
}

/** The Text_Draw/Text_Width scale that fits one line of text into
 * `rowHeight` real pixels. Exactly 1 at the classic 8px row height, so a
 * caller laid out on that grid (menu.c's fixed 8-pixel rows) keeps its
 * classic geometry under every font source. */
export function Text_RowScale(rowHeight: number): number {
  return rowHeight / Text_LineHeight();
}

/** Total advance width, in real pixels, of `s` at the given scale. */
export function Text_Width(s: string, scale = 1): number {
  const mode = resolveMode();

  let w = 0;
  // DEFECT D6 FIX: iterate real Unicode code points (`for...of` over a JS
  // string decodes surrogate pairs), not UTF-16 code units -- a codepoint
  // past the Basic Multilingual Plane is two `charCodeAt` units, and
  // measuring/drawing each half separately would look up two bogus
  // half-codepoints instead of the one real glyph.
  for (const ch of s) {
    w += resolvedAdvance(resolveGlyph(mode, ch.codePointAt(0)!), scale);
  }
  return w;
}

/**
 * Draws `s` with its top-left glyph cell at real-pixel (x, y), at the given
 * scale (a multiplier on the CLASSIC TEXT CELL -- see this file's G3 header
 * note; callers compute their own already-real destination coordinates, so
 * no ambient canvas/ortho state is used). `alt` requests the classic golden
 * charset (Draw_Alt_String's own `| 0x80` row-select) or, for a kfont/ttf
 * glyph, a golden runtime tint (see ALT_TINT).
 */
export function Text_Draw(x: number, y: number, s: string, alt = false, scale = 1): void {
  const mode = resolveMode();

  const resolved: GlyphResolutionT[] = [];
  let allClassic = true;
  for (const ch of s) {
    const r = resolveGlyph(mode, ch.codePointAt(0)!);
    if (r.draw !== "classic") allClassic = false;
    resolved.push(r);
  }

  if (allClassic && scale === 1) {
    // Preserves the EXACT pre-U19 call sequence (renderer.Draw_Character,
    // once per character, same x/y/num) for text the charset draws at the
    // classic size -- which G3 made the default for every surface, not just
    // a boot with no font loaded. Draw_Character's own body already skips
    // drawing a space (`num === 32`) while still advancing the cursor,
    // exactly like the loop below.
    const r = getRenderer();
    let cx = x;
    for (const g of resolved) {
      if (g.draw !== "classic") continue;
      r.Draw_Character(cx, y, (g.codepoint & 0xff) | (alt ? 0x80 : 0));
      cx += CLASSIC_GLYPH_SIZE;
    }
    return;
  }

  const tint = alt ? ALT_TINT : null;

  let cx = x;
  for (const g of resolved) {
    if (g.draw === "atlas") {
      const fit = atlasFit(g.font, scale);
      const dstW = g.glyph.w * fit;
      const dstH = g.glyph.h * fit;
      const source: GlyphAtlasSourceT = {
        kind: "custom",
        id: g.font.atlasId,
        width: g.font.width,
        height: g.font.height,
        pixels: g.font.pixels ?? new Uint8Array(0),
      };
      drawGlyphAtlas(cx, y, dstW, dstH, source, g.glyph.x, g.glyph.y, g.glyph.w, g.glyph.h, g.glyph.color ? null : tint);
      cx += dstW;
    } else if (g.draw === "classic") {
      // F17: the classic charset, scaled to the row like every other glyph
      // on it. Sources the SAME char_texture/draw_chars atlas the fast path
      // above and Draw_Character itself read; `alt` reaches the same baked
      // golden-row selection Draw_Alt_String uses (`| 0x80`), not a runtime
      // tint (there is no baked golden variant to tint -- see ALT_TINT).
      const num = g.codepoint | (alt ? 0x80 : 0);
      if (num !== 0x20 /* Draw_Character's own space check */) {
        const row = num >> 4;
        const col = num & 15;
        drawGlyphAtlas(cx, y, CLASSIC_GLYPH_SIZE * scale, CLASSIC_GLYPH_SIZE * scale, { kind: "classic" }, col * 8, row * 8, 8, 8, null);
      }
      cx += CLASSIC_GLYPH_SIZE * scale;
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
