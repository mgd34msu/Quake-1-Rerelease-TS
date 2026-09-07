/*
Family R, driver 4: re-release text rendering and localization.

  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/r_text.ts
  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/r_text.ts --vid gl

Boots the re-release id1 tree, whose own quake.rc sets `scr_usekfont 1`, so
src/client/kfont_text.ts's glyph-atlas path is the one actually drawing text,
and asserts:

  - the console's text region draws real glyphs at `scr_conscale 1` and at
    `scr_conscale 2`, is non-blank in both, and the two are not the same
    picture (the scale reaches the drawn glyph size, it is not ignored)
  - kfont glyphs and the classic charset draw through different primitives
    with different metrics, so `con_font` selects a real font rather than
    silently falling back
  - a UTF-8 localized string renders its own glyphs rather than the '?'
    fallback
  - switching `language` changes a visible menu string

The font and scale assertions read the glyph draw calls themselves
(r_lib.ts's captureGlyphDraws) rather than diffing pixels: the console
backdrop slides in over several frames and the console's own text is drawn
from the bottom of the pane upward, both of which make a fixed pixel window a
poor witness for "did this glyph draw at this size".
*/

import {
  arg,
  bootTree,
  captureGlyphDraws,
  check,
  cmd,
  Cvar_Set,
  Cvar_VariableString,
  Cvar_VariableValue,
  diffFraction,
  fbSnapshot,
  finish,
  frames,
  glyphSignature,
  homedirFor,
  isGL,
  regionStats,
  screenText,
  shot,
  statsNote,
  treeConfig,
  wholeScreen,
  fbHeight,
  type GlyphDrawT,
} from "./r_lib";
import { Loc_Localize } from "../../src/lib/loc";
import { LoadMenuLocalization, LocalizedEpisodeName, AvailableLanguages } from "../../src/client/menu_content";
import { SbarScale, test_ResetClLocCache, test_ResetGlyphCache, Text_Draw, Text_Width } from "../../src/client/kfont_text";
import { keyState, KeydestT } from "../../src/client/keys";

const vid = arg("vid", "soft");
const tag = `text_${vid}`;
const home = homedirFor(tag);

bootTree({ cfg: treeConfig("id1"), vid, homedir: home });
frames(20);
check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

// With no map loaded the console owns the whole screen; the extra frames let
// its slide-in finish so a screen snapshot is a settled picture.
keyState.key_dest = KeydestT.key_console;
cmd("clear", 4);
frames(60);

/** Clears the console, prints `line`, and returns the glyphs the next screen refresh draws. */
function consoleGlyphs(line: string): GlyphDrawT[] {
  cmd("clear", 2);
  frames(4);
  cmd(`echo ${line}`, 2);
  frames(4);
  return captureGlyphDraws(() => {
    frames(1);
  });
}

function screenPixels(): Uint8Array | null {
  return fbSnapshot(wholeScreen());
}

// ---------------------------------------------------------------------------
// the re-release turns kfont on for itself
// ---------------------------------------------------------------------------

check(
  `${tag}/usekfont`,
  Cvar_VariableValue("scr_usekfont") === 1,
  `scr_usekfont=${Cvar_VariableValue("scr_usekfont")} con_font="${Cvar_VariableString("con_font")}" after the re-release quake.rc ran`,
);

// ---------------------------------------------------------------------------
// console text at scr_conscale 1 and 2
// ---------------------------------------------------------------------------

{
  const line = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  Cvar_Set("scr_conscale", "1");
  frames(10);
  const g1 = consoleGlyphs(line);
  const px1 = screenPixels();
  const s1 = regionStats(px1);
  shot(`${tag}_conscale1`);

  Cvar_Set("scr_conscale", "2");
  frames(10);
  const g2 = consoleGlyphs(line);
  const px2 = screenPixels();
  const s2 = regionStats(px2);
  shot(`${tag}_conscale2`);

  // The status bar of the demo quake.rc's startdemos started draws behind the
  // console at SbarScale() (its gold ammo digits are classic-atlas glyphs
  // too); only the console's own rows, above the bar, say anything about
  // scr_conscale.
  const barTop = fbHeight() - 48 * SbarScale();
  const inConsole = (g: GlyphDrawT): boolean => g.y < barTop;
  const height1 = g1.some(inConsole) ? Math.max(...g1.filter(inConsole).map((g) => g.h)) : 0;
  const height2 = g2.some(inConsole) ? Math.max(...g2.filter(inConsole).map((g) => g.h)) : 0;

  check(`${tag}/console-glyphs-scale1`, g1.length > 20, `scr_conscale 1 drew ${g1.length} glyphs, tallest ${height1}px`);
  check(`${tag}/console-glyphs-scale2`, g2.length > 20, `scr_conscale 2 drew ${g2.length} glyphs, tallest ${height2}px`);
  check(`${tag}/console-nonblank-scale1`, s1.distinct > 4 && s1.litFraction > 0.02, `scr_conscale 1: ${statsNote(s1)}`);
  check(`${tag}/console-nonblank-scale2`, s2.distinct > 4 && s2.litFraction > 0.02, `scr_conscale 2: ${statsNote(s2)}`);
  // Which draws produced each height: "source:height=count" so a fixed-size
  // element hiding in the frame is named rather than guessed at.
  const histogram = (gs: GlyphDrawT[]): string => {
    const m = new Map<string, number>();
    for (const g of gs) {
      const k = `${g.source}:${g.h}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    const odd = gs.filter((g) => g.h !== 8 * Math.round(g.h / 8) || g.h > 8).slice(0, 8).map((g) => `${g.source}@${g.x},${g.y}:${g.w}x${g.h}/src${g.srcX},${g.srcY}`);
    return [...m.entries()].map(([k, n]) => `${k}=${n}`).join(" ") + (odd.length > 0 ? ` [${odd.join(" ")}]` : "");
  };
  check(
    `${tag}/console-scale-differs`,
    height2 > height1,
    `tallest drawn glyph ${height1}px at scr_conscale 1 vs ${height2}px at scr_conscale 2 (scale1: ${histogram(g1)} | scale2: ${histogram(g2)})`,
  );
  const pixelDiff = diffFraction(px1, px2, 8);
  check(
    `${tag}/console-scale-pixels`,
    pixelDiff > 0.01,
    `${(pixelDiff * 100).toFixed(1)}% of the screen differs between scr_conscale 1 and 2`,
  );

  Cvar_Set("scr_conscale", "1");
  frames(10);
}

// ---------------------------------------------------------------------------
// kfont glyphs vs the classic charset
// ---------------------------------------------------------------------------

{
  const line = "QUAKE-KFONT-0123456789";

  Cvar_Set("con_font", "kfont");
  test_ResetGlyphCache();
  frames(8);
  const kfont = consoleGlyphs(line);
  const kfontWidth = Text_Width(line);
  const kfontPixels = screenPixels();

  Cvar_Set("con_font", "classic");
  test_ResetGlyphCache();
  frames(8);
  const classic = consoleGlyphs(line);
  const classicWidth = Text_Width(line);
  const classicPixels = screenPixels();

  Cvar_Set("con_font", "kfont");
  test_ResetGlyphCache();
  frames(8);

  const kfontAtlas = kfont.filter((g) => g.source === "custom").length;
  const classicChars = classic.filter((g) => g.source === "charset").length;
  check(
    `${tag}/kfont-draws`,
    kfontAtlas > 20,
    `con_font kfont drew ${kfontAtlas} custom-atlas glyphs out of ${kfont.length} text draws`,
  );
  check(
    `${tag}/classic-draws`,
    classicChars > 20,
    `con_font classic drew ${classicChars} charset characters out of ${classic.length} text draws`,
  );
  check(
    `${tag}/kfont-metrics`,
    kfontWidth > 0 && kfontWidth !== classicWidth,
    `Text_Width("${line}"): kfont=${kfontWidth}, classic charset=${classicWidth} (a proportional font must not measure the same as the fixed 8px charset)`,
  );
  const fontPixelDiff = diffFraction(kfontPixels, classicPixels, 8);
  check(
    `${tag}/kfont-pixels`,
    fontPixelDiff > 0.005,
    `${(fontPixelDiff * 100).toFixed(2)}% of the screen differs between con_font kfont and con_font classic`,
  );
}

// ---------------------------------------------------------------------------
// a UTF-8 loc string renders glyphs, not question marks
// ---------------------------------------------------------------------------

{
  const langs = AvailableLanguages();
  check(`${tag}/languages`, langs.length > 1, `localization/loc_*.txt mounted: ${langs.join(" ")}`);

  Cvar_Set("language", "russian");
  test_ResetClLocCache();
  LoadMenuLocalization();
  // loc_russian.txt spells m_single_player in Cyrillic ("Один игрок"); its
  // first word is the shortest guaranteed non-Latin string in the shipped
  // tables and survives `echo`'s own tokenization intact.
  const russian = Loc_Localize("$m_single_player", false, null, 0);
  const word = russian.split(" ")[0];
  check(
    `${tag}/utf8-string`,
    word.length > 0 && russian !== "m_single_player",
    `loc_russian.txt "$m_single_player" -> "${russian}"; first word code units [${Array.from(word).map((c) => c.charCodeAt(0)).join(",")}]`,
  );
  check(
    `${tag}/utf8-decoded`,
    Array.from(word).every((c) => c.charCodeAt(0) > 0x400 || c.charCodeAt(0) < 0x80),
    `Cyrillic code points live at U+0400..U+04FF; got [${Array.from(word).map((c) => c.charCodeAt(0)).join(",")}]` +
      " (values in 0x80..0xFF mean the loc file's UTF-8 bytes were taken one byte per character)",
  );

  // Drawn straight through Text_Draw rather than through the console, so the
  // captured glyphs are exactly this string's and nothing else on screen.
  // Every unmapped code point is drawn with kfont_text.ts's fallbackGlyph
  // ('?'), so a fallen-back character produces the '?' source rectangle.
  consoleGlyphs(word); // leaves the string on screen for the screenshot below
  shot(`${tag}_utf8`);
  const glyphs = captureGlyphDraws(() => {
    Text_Draw(0, 0, word);
  });
  const questionGlyphs = captureGlyphDraws(() => {
    Text_Draw(0, 0, "?");
  });
  const questionRects = new Set(questionGlyphs.map((g) => `${g.srcX},${g.srcY},${g.srcW},${g.srcH}`));
  const fellBack = glyphs.filter((g) => questionRects.has(`${g.srcX},${g.srcY},${g.srcW},${g.srcH}`)).length;
  const distinct = new Set(glyphs.map((g) => `${g.srcX},${g.srcY},${g.srcW},${g.srcH}`)).size;
  check(
    `${tag}/utf8-glyphs`,
    glyphs.length === word.length && fellBack === 0 && distinct > 1,
    `Text_Draw("${word}") emitted ${glyphs.length} glyphs for ${word.length} characters` +
      ` (${distinct} distinct, ${fellBack} of them the '?' fallback rectangle` +
      ` ${questionGlyphs.length === 0 ? "-- the font has no '?' glyph, so an unmapped code point draws nothing at all" : `[${Array.from(questionRects).join(" ")}]`})` +
      ` [${glyphSignature(glyphs)}]`,
  );

  Cvar_Set("language", "english");
  test_ResetClLocCache();
  LoadMenuLocalization();
  frames(4);
}

// ---------------------------------------------------------------------------
// the loc language switch changes a visible menu string
// ---------------------------------------------------------------------------

{
  // Leave the console: with it still down its own text is drawn over the menu
  // and would make any two captures differ for the wrong reason.
  keyState.key_dest = KeydestT.key_menu;
  cmd("menu_options", 4);
  frames(80);

  /** The Options screen's drawn text, with the language row's own echoed
   * value removed -- that row prints the cvar string itself, so it changes
   * under any language switch whether or not anything is localized. */
  function optionsText(lang: string): string {
    Cvar_Set("language", lang);
    test_ResetClLocCache();
    LoadMenuLocalization();
    cmd("menu_options", 4);
    frames(20);
    return screenText()
      .split("\n")
      .map((l) => l.split(lang).join("").replace(/\s+$/, ""))
      .filter((l) => l.trim().length > 0)
      .join("\n");
  }

  const english = optionsText("english");
  shot(`${tag}_menu_english`);
  const russian = optionsText("russian");
  shot(`${tag}_menu_russian`);

  check(`${tag}/menu-drawn`, english.split("\n").length > 4, `the Options screen drew ${english.split("\n").length} rows of text under language english`);
  check(
    `${tag}/menu-language-switch`,
    english !== russian,
    english === russian
      ? `identical Options text under language english and russian: ${english.split("\n").slice(0, 8).join(" | ")}`
      : `rows that differ: ${english
          .split("\n")
          .filter((l, i) => l !== russian.split("\n")[i])
          .slice(0, 6)
          .map((l, i) => `"${l}" vs "${russian.split("\n")[i] ?? ""}"`)
          .join(" | ")}`,
  );

  // Diagnostic: the one menu string this engine does route through the loc
  // table is mapdb.json's episode name.
  Cvar_Set("language", "english");
  LoadMenuLocalization();
  const epEnglish = LocalizedEpisodeName("$m_quake", true);
  Cvar_Set("language", "russian");
  LoadMenuLocalization();
  const epRussian = LocalizedEpisodeName("$m_quake", true);
  check(
    `${tag}/episode-name-localized`,
    epEnglish.length > 0 && !epEnglish.startsWith("$"),
    `LocalizedEpisodeName("$m_quake") english="${epEnglish}" russian="${epRussian}"`,
  );

  Cvar_Set("language", "english");
  LoadMenuLocalization();
}

finish(tag);
