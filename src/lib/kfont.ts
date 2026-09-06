// Lifted from quake-2-re-ts src/client/cgame/kfont.ts at 7e88015 (GPLv2, our
// own repo). Two changes for src/lib's "imports nothing from src/ outside
// src/lib" rule (ARCHITECTURE.md "Source layout"):
//   - `COM_Parse`/`ComParseState` now come from ./tokenizer (a same-repo
//     extraction of quake-2-re-ts's shared/math.ts COM_Parse, see that
//     file's own header) instead of "../../shared/math".
//   - `FontAtlasT` now comes from ./ttf instead of "../../qcommon/ttf" --
//     both files live in src/lib here, so this is a same-directory import,
//     not a new dependency.
// No other behavior change. The original comments below still refer to
// quake-2-re-ts's own file layout (host.ts, gl_image.ts/r_image.ts,
// draw.c) as historical context for the format and the seam this module
// was built for -- those files are not part of this project.
//
// [Paril-KEX] kfont format -- q2repro's src/refresh/draw.c
// (SCR_LoadKFont/SCR_KFontLookup/draw_kfont_char) and inc/refresh/refresh.h
// (kfont_t/kfont_char_t/KFONT_ASCII_MIN/KFONT_ASCII_MAX). This is NOT a port
// of anything in the original id Quake II source -- kfont is a Paril-KEX/
// q2repro rerelease-only asset format with no vanilla counterpart. Added for
// the FIDELITY RAZOR sweep (.orch/preferences.md rule 17): host.ts's own
// kfont doc comment already found that q2repro's SCR_Init loads
// "fonts/qconfont.kfont" and every font draw/measure function branches on
// whether that load succeeded; with the retail rerelease KPF now mounted
// (Q2Game.kpf, fonts/qconfont.kfont + fonts/qconfont.png present), that
// branch is reachable for real and needs a real implementation instead of
// the documented-gap conchars-only fallback.
//
// FORMAT (confirmed against the real fonts/qconfont.kfont extracted from
// Q2Game.kpf -- a small text/token format, not binary, despite this
// project's own follow-up note guessing "binary" before extraction):
//
//   texture "fonts/qconfont.png"
//   unicode
//   mapchar
//   {
//       <codepoint> <x> <y> <w> <h> <unused>
//       ...
//   }
//
// Tokenized with COM_Parse (shared/math.ts) exactly like SCR_LoadKFont's own
// COM_Parse walk: `texture` is followed by a quoted texture path; `unicode`
// takes no argument (a bare flag token in every sample seen); `mapchar`
// consumes one token (the `{`) then reads 6-token lines
// (codepoint x y w h <trailing token, always "0" in the real file and
// otherwise unused by SCR_LoadKFont too, which discards it via a bare
// `COM_Parse(&data)`) until a lone `}`.
//
// KNOWN q2repro BUG, NOT REPRODUCED (FIDELITY RAZOR, rule 17): SCR_LoadKFont
// computes the array index as `codepoint - KFONT_ASCII_MIN` and bounds-checks
// it against `KFONT_ASCII_MAX` (126) -- but `chars[]` is sized
// `KFONT_ASCII_MAX - KFONT_ASCII_MIN + 1` (95) entries. Any source codepoint
// in [KFONT_ASCII_MIN + 95, KFONT_ASCII_MAX] == [127, 157] passes that check
// and writes past the end of `chars[]`, into `kfont_t.line_height`/`sw`/`sh`
// -- a real out-of-bounds WRITE in q2repro's own C, not something with an
// equivalent memory layout on this platform to reproduce identically (there
// is no adjacent-field aliasing to imitate in a garbage-collected array).
// This port therefore bounds-checks against the array's REAL size (95
// entries, source codepoints 32-126 only). Verified moot for the actual
// shipped asset: none of fonts/qconfont.kfont's 257 mapchar entries have a
// codepoint in the dangerous [127, 157] range (spot-checked against the
// extracted file by this unit), so this deviation has no observable effect
// on today's data.
export const KFONT_ASCII_MIN = 32;
export const KFONT_ASCII_MAX = 126;
const KFONT_NUM_CHARS = KFONT_ASCII_MAX - KFONT_ASCII_MIN + 1;

export interface KfontCharT {
  x: number;
  y: number;
  w: number;
  h: number;
  // true for a COLR v0 + CPAL color glyph baked as a full-RGBA atlas region
  // (ttf.ts's AtlasRectT.color -- see that field's own doc comment and
  // buildFontAtlas's "COLR v0 + CPAL COLOR GLYPHS" section); the classic
  // .kfont path (ParseKfont below) never sets this -- its qconfont.png
  // atlas has no color-icon regions at all -- so it stays undefined there,
  // which host.ts's drawKfontChar treats the same as false (tinted, the
  // pre-existing behavior for every classic-kfont glyph).
  color?: boolean;
}

// The parsed-but-not-yet-renderer-registered shape: everything ParseKfont
// can determine from the text alone. `textureToken` is the raw path from
// the "texture" line (e.g. "fonts/qconfont.png") -- registering it as a
// renderer pic (via RefExports.RegisterPic("/" + textureToken), matching
// Draw_FindPic's own "leading '/' means exact path" convention this port's
// gl_draw.ts/r_draw.ts Draw_FindPic already implement) is the caller's job
// (host.ts's LoadKfontAsset), not this pure module's -- keeps this file
// renderer-independent and directly unit-testable against real file bytes.
export interface ParsedKfontT {
  textureToken: string;
  chars: (KfontCharT | null)[]; // length KFONT_NUM_CHARS, index = codepoint - KFONT_ASCII_MIN
  line_height: number;
}

// Reuses shared/math.ts's own COM_Parse tokenizer (already the established
// port of q2's COM_Parse -- see e.g. kexgame/g_spawn.ts's entity-string
// parsing) rather than duplicating its quoted-string/word-token/`//`-comment
// behavior here; that tokenizer is exactly what SCR_LoadKFont's own
// COM_Parse calls need.
import { COM_Parse, type ComParseState } from "./tokenizer";
// See this file's Kfont_FromTTF doc comment below for the full seam writeup.
import type { FontAtlasT } from "./ttf";

function parseError(reason: string): null {
  // No engine Con_Printf reachable from this pure module (see file header --
  // deliberately renderer/engine independent for testability); callers that
  // want a console message log `reason` themselves. Returning null already
  // matches SCR_LoadKFont's own "just return" reaction to anything it can't
  // parse (`if (FS_LoadFile(...) < 0) return;` -- the whole function is a
  // silent bail on failure, no error message).
  void reason;
  return null;
}

export function ParseKfont(text: string): ParsedKfontT | null {
  const state: ComParseState = { data: text, index: 0 };
  let textureToken: string | null = null;
  const chars: (KfontCharT | null)[] = new Array(KFONT_NUM_CHARS).fill(null);
  let line_height = 0;

  for (;;) {
    const token = COM_Parse(state);
    if (token === "") break;

    if (token === "texture") {
      textureToken = COM_Parse(state);
    } else if (token === "unicode") {
      // no-op token, matches SCR_LoadKFont's own `else if (!strcmp(token, "unicode")) {}`
    } else if (token === "mapchar") {
      COM_Parse(state); // the opening "{" (SCR_LoadKFont discards this token the same way)
      for (;;) {
        const entryToken = COM_Parse(state);
        if (entryToken === "}" || entryToken === "") break;

        const codepoint = parseInt(entryToken, 10);
        const x = parseInt(COM_Parse(state), 10);
        const y = parseInt(COM_Parse(state), 10);
        const w = parseInt(COM_Parse(state), 10);
        const h = parseInt(COM_Parse(state), 10);
        COM_Parse(state); // trailing per-glyph token, unused (matches SCR_LoadKFont's bare COM_Parse)

        if (!Number.isFinite(codepoint) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
          return parseError("malformed mapchar entry");
        }

        const index = codepoint - KFONT_ASCII_MIN;
        // See this file's header comment: bounds-checked against the real
        // array size (KFONT_NUM_CHARS), not q2repro's own off-by-31 check
        // against KFONT_ASCII_MAX.
        if (index >= 0 && index < KFONT_NUM_CHARS) {
          chars[index] = { x, y, w, h };
          if (h > line_height) line_height = h;
        }
      }
    }
  }

  if (textureToken === null) return parseError("missing texture line");

  return { textureToken, chars, line_height };
}

export interface KfontT {
  pic: string; // renderer-registered pic name (the "/"-prefixed exact path); presence of a KfontT at all means this loaded
  chars: (KfontCharT | null)[];
  line_height: number;
}

// SCR_KFontLookup (src/refresh/draw.c): range-checks the codepoint and
// treats a zero-width entry the same as a missing one (`if (!ch->w) return
// NULL`) -- e.g. the real fonts/qconfont.kfont has no entry at all for `
// (backtick, 96) or ~ (tilde, 126), and this is how q2repro's own callers
// (CG_MeasureKFontWidth, draw_kfont_char) skip codepoints the atlas has no
// glyph for.
export function SCR_KFontLookup(font: KfontT, codepoint: number): KfontCharT | null {
  const index = codepoint - KFONT_ASCII_MIN;
  if (index < 0 || index >= KFONT_NUM_CHARS) return null;
  const ch = font.chars[index];
  if (!ch || !ch.w) return null;
  return ch;
}

// ---------------------------------------------------------------------------
// Kfont_FromTTF -- TTF/OTF-backed kfont seam (OWNER RULING, 2026-08-31).
//
// The retail rerelease KPF ships 29 real font files under fonts/ (26 .ttf +
// 3 .otf -- the KEX UI's actual font stack), separate from the single
// pre-baked fonts/qconfont.kfont asset ParseKfont/SCR_KFontLookup above
// already handle. qcommon/ttf.ts parses those files from raw bytes
// (sfnt/glyf/CFF, no external dependencies) and rasterizes a requested
// glyph set into an RGBA atlas + per-glyph metrics; this seam relabels that
// atlas's output into THIS file's own KfontCharT rect shape, so it can be
// drawn/measured through the exact same DrawStretchPicRegion-against-an-
// atlas machinery client/cgame/host.ts already has for the classic kfont
// path above -- no new render path, additive only.
//
// Kept pure/renderer-independent, same division of labor as
// ParseKfont/ParsedKfontT above: this function does NOT touch the
// filesystem, does NOT call RegisterPic/GL_LoadPic, and does NOT choose the
// pixel size or codepoint set -- those are the caller's decisions (made via
// qcommon/ttf.ts's own parseFont/buildFontAtlas/latin1Codepoints).
//
// WHY A SEPARATE TYPE (TtfKfontT), NOT KfontT: KfontT.chars is a fixed
// 95-entry array indexed by `codepoint - KFONT_ASCII_MIN` (32-126) --
// that's q2repro's own C array-sizing choice for its ASCII-only
// qconfont.kfont asset, not a limit inherent to the kfont CONCEPT. The
// OWNER RULING's codepoint set is ASCII + Latin-1 (ttf.ts's own
// latin1Codepoints(), 0x20-0x7E + 0xA0-0xFF -- verified against the real
// localization/loc_english.txt, whose only non-ASCII codepoint is U+00F6,
// already inside that range), which doesn't fit a 95-entry array. TtfKfontT
// generalizes the same {x,y,w,h} rect shape and the same SCR_KFontLookup
// lookup contract (a present-but-zero-width entry counts as missing) to an
// arbitrary codepoint set via a Map instead of a fixed array.
//
// INTEGRATION CONTRACT for the caller that wires this to a live cvar (a
// client/cgame/host.ts change -- OUT OF THIS UNIT'S TERRITORY, see this
// port's own report for the full cross-boundary writeup; documented here so
// the seam is discoverable at its call site):
//   1. bytes = FS_LoadFile(`fonts/${name}.ttf`) (or ".otf") via the
//      KPF-mounted engine FS -- same FS_LoadFile loadKfontAsset already
//      uses above, just a different path.
//   2. const parsed = parseFont(bytes); if (!parsed.ok), fall back to the
//      classic conchars/kfont path (never a hard error -- matches
//      SCR_LoadKFont's own "just return" bail-on-failure convention).
//   3. const atlas = buildFontAtlas(parsed.font, latin1Codepoints(), pxSize)
//   4. const pic = `/ttf:${name}:${pxSize}`; register the atlas pixels
//      under that exact name ONCE via the renderer's existing raw-pixel
//      image entry point -- gl_image.ts's already-public
//      `GL_LoadPic(pic, atlas.pixels, atlas.width, atlas.height,
//      ImagetypeT.it_pic, 32)` on the GL renderer, r_image.ts's equivalent
//      on the software renderer. Both are ALREADY exported (no change
//      needed to either renderer's image-loading internals): GL_LoadPic
//      inserts directly into the same gltextures[] cache Draw_FindPic's own
//      GL_FindImage scans by exact name match, so every subsequent
//      Draw_FindPic(pic) / DrawStretchPicRegion(..., pic, ...) call after
//      the first hits that cache -- the same "already registered, no disk
//      hit" fast path any other pic name gets.
//   5. const font: TtfKfontT = Kfont_FromTTF(atlas, pic)
//   6. draw/measure exactly like the existing kfont path above, substituting
//      TtfKfont_Lookup for SCR_KFontLookup and this file's Map-based
//      `chars` field for the fixed-array one.
//
// Proposed cvar (documented here, not wired -- see contract above): reusing
// q2repro's own naming family (scr_font/con_font, both plain asset-name
// string cvars -- see ~/Projects/q2repro/src/client/{cgame,screen,console}.c)
// would be misleading, since those two cvars govern the UNRELATED classic
// conchars-style bitmap charset, not the kfont system at all (q2repro loads
// fonts/qconfont.kfont unconditionally, no cvar gates it -- see
// screen.c's SCR_Init calling SCR_LoadKFont directly). This project's own
// three-way choice (classic charset | kfont | ttf:<name>) has no q2repro
// counterpart, so per the brief: document ours. Proposed name
// `cl_kfont_source`, default value `"kfont"` (byte-identical to today's
// unconditional opportunistic-load-with-conchars-fallback behavior --
// see ensureKfont()/loadKfontAsset() in host.ts), accepted values
// `"classic"` (force-disable the kfont path, conchars only),
// `"kfont"` (today's default), `"ttf:<name>"` (this seam, e.g.
// `"ttf:RobotoMono-Regular"`); a companion `cl_kfont_ttf_size` integer cvar
// (proposed default 16) supplies the pixel size for the ttf: source.
export interface TtfKfontT {
  pic: string; // caller-assigned name (see INTEGRATION CONTRACT step 4); presence of a TtfKfontT at all means this loaded
  chars: Map<number, KfontCharT>; // codepoint -> rect, arbitrary codepoints (not just 32-126)
  line_height: number;
}

// Same lookup contract as SCR_KFontLookup above: a present-but-zero-width
// entry counts as missing (zero-advance codepoints, if any ever appear in
// a rasterized set, would otherwise stall the cursor on draw).
export function TtfKfont_Lookup(font: TtfKfontT, codepoint: number): KfontCharT | null {
  const ch = font.chars.get(codepoint);
  if (!ch || !ch.w) return null;
  return ch;
}

// The atlas -> TtfKfontT relabel itself: a straight copy of each
// {x,y,w,h} rect (ttf.ts's AtlasRectT and this file's KfontCharT are
// structurally identical -- same field set, same units, same meaning),
// carrying through AtlasRectT's `color` flag verbatim (see KfontCharT's own
// doc comment on that field), plus ttf.ts's own max-rect-height line_height
// convention, which already matches ParseKfont's
// `if (h > line_height) line_height = h;` above.
export function Kfont_FromTTF(atlas: FontAtlasT, pic: string): TtfKfontT {
  const chars = new Map<number, KfontCharT>();
  for (const [codepoint, rect] of atlas.glyphs) {
    chars.set(codepoint, { x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: rect.color });
  }
  return { pic, chars, line_height: atlas.lineHeight };
}
