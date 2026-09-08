// W5: `language` (the Options row) switches a visible menu string between
// two languages the retail loc files ship; a `_mod` overlay in a temp -game
// dir wins over the base string. `bun test/e2e/w_loc.ts`
//
// The mod-overlay half needs a gamedir the real retail tree does not ship
// (Q1TS_DATA/rerelease never gets written to, per this unit's brief and
// standing orders) -- test/e2e/w_lib.ts's buildScratchRereleaseRoot mirrors
// the real rerelease id1 (symlinked, read-only) into a private basedir under
// scratch, the same technique test/e2e/e_lib.ts/o_qwcl_video.ts already use
// for their own isolated basedirs, then this file adds one real synthetic
// gamedir of its own under that private root.
import { boot, frames, exec, tap, check, summary, results, menuState, MStateT, asMState, Cvar_VariableString, buildScratchRereleaseRoot, writeScratchGameFile, W_HOMEDIR } from "./w_lib";
import { K_RIGHTARROW } from "../../src/client/keys";
import { AvailableLanguages, LoadMenuLocalization } from "../../src/client/menu_content";
import { Loc_Localize } from "../../src/lib/loc";
import { QEX_LoadLocalization } from "../../src/progs/ext/ruleset";

const SCRATCH = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";

// The mod overlay's own gamedir mounts ON TOP of the same private root's
// real (symlinked) id1, so `map`/textures/etc. still resolve normally --
// only `localization/loc_english_mod.txt` differs from a plain retail boot.
const root = buildScratchRereleaseRoot(SCRATCH, "w_loc");
writeScratchGameFile(root, "e2e_w_locmod", "localization/loc_english_mod.txt", 'm_quake = "E2E_MOD_OVERRIDE"\n');

boot(["-basedir", root, "-game", "e2e_w_locmod", "-homedir", W_HOMEDIR]);
frames(5);
exec("disconnect", 3);

// ============================================================================
// Part A: `language` (the Options row) switches a visible menu string.
// ============================================================================
console.log("[W] === language switches a visible menu string ===");
const langs = AvailableLanguages();
check("english and french are both mounted (real retail loc files)", langs.includes("english") && langs.includes("french"), `langs=${langs.join(",")}`);

exec("menu_options", 3);
check("Options menu opens", asMState(menuState.m_state) === MStateT.m_options, `m_state=${menuState.m_state}`);
menuState.options_cursor = 17; // Language row -- see src/client/menu.ts's OPTIONS_ITEMS comment

function setLanguage(target: string): void {
  for (let i = 0; i < langs.length && Cvar_VariableString("language").trim().toLowerCase() !== target; i++) {
    tap(K_RIGHTARROW);
    frames(1);
  }
}

setLanguage("english");
check("language row reads english", Cvar_VariableString("language").trim().toLowerCase() === "english", `language=${Cvar_VariableString("language")}`);
LoadMenuLocalization();
const englishText = Loc_Localize("$m_single_player", false, null, 0);

setLanguage("french");
check("language row reads french", Cvar_VariableString("language").trim().toLowerCase() === "french", `language=${Cvar_VariableString("language")}`);
LoadMenuLocalization();
const frenchText = Loc_Localize("$m_single_player", false, null, 0);

console.log(`  $m_single_player: english="${englishText}" french="${frenchText}"`);
check("switching `language` changes the visible menu string ($m_single_player)", englishText !== frenchText && englishText.length > 0 && frenchText.length > 0, `english="${englishText}" french="${frenchText}"`);

// mapdb episode names themselves are untranslated proper nouns in the real
// retail loc files (checked directly against loc_english.txt/loc_french.txt:
// both read `m_quake = "Quake"`) -- noted here rather than silently assumed,
// since the New Game episode picker (M_QexEpisodes_Draw) is the screen the
// brief calls out and its own text does not visibly change between languages.
setLanguage("english");
LoadMenuLocalization();
const quakeEnglish = Loc_Localize("$m_quake", false, null, 0);
setLanguage("french");
LoadMenuLocalization();
const quakeFrench = Loc_Localize("$m_quake", false, null, 0);
// The English table sees this driver's own mounted loc_english_mod.txt
// override (F3's ordered loader merges it); French has no overlay and shows
// the untranslated proper noun the retail data ships.
check(
  "mapdb episode names are untranslated proper nouns in retail data ($m_quake reads \"Quake\" in French) and the mounted English overlay is merged",
  quakeFrench === "Quake" && quakeEnglish === "E2E_MOD_OVERRIDE",
  `english="${quakeEnglish}" french="${quakeFrench}"`,
);
setLanguage("english");

// ============================================================================
// Part B: a `_mod` overlay wins over the base string.
// ============================================================================
console.log("[W] === _mod overlay wins over the base string ===");

// Since F3 the menu's own loader (src/client/menu_content.ts) goes through
// the same ordered loader as the server, so the mounted overlay wins here too.
LoadMenuLocalization();
const baseViaMenu = Loc_Localize("$m_quake", false, null, 0);
check("LoadMenuLocalization merges the mounted _mod.txt overlay (F3)", baseViaMenu === "E2E_MOD_OVERRIDE", `got="${baseViaMenu}"`);

// The engine's own loader (src/progs/ext/ruleset.ts's QEX_LoadLocalization,
// called from QEX_AfterLoadProgs on every rerelease-ruleset map spawn) DOES
// merge every `_mod.txt` found on the search path, via src/lib/loc.ts's
// Loc_LoadOrdered -- our custom gamedir's loc_english_mod.txt is mounted at
// higher search priority than id1's own (inert) placeholder one.
QEX_LoadLocalization();
const overlayViaEngine = Loc_Localize("$m_quake", false, null, 0);
check('QEX_LoadLocalization merges the _mod.txt overlay ("m_quake" -> our override)', overlayViaEngine === "E2E_MOD_OVERRIDE", `got="${overlayViaEngine}"`);

// F3 routed the menu's own loader through the same ordered loader the
// server uses (Loc_LoadOrderedForCurrentLanguage), so re-opening the New
// Game/Options screens must keep the mod's override.
LoadMenuLocalization();
const afterMenuReload = Loc_Localize("$m_quake", false, null, 0);
check(
  "the New Game/Options screens keep the _mod.txt override after their own reload (F3)",
  afterMenuReload === "E2E_MOD_OVERRIDE",
  `got="${afterMenuReload}" (engine-side QEX_LoadLocalization read "${overlayViaEngine}")`,
);

summary("W5 loc");
process.exit(results.some((r) => !r.pass) ? 1 : 0);
