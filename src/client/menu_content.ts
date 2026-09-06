// menu_content.ts -- the re-release content & ruleset selector for menu.ts's
// New Game / Add-Ons / Options screens (unit U17). Not a port of any
// WinQuake C file -- menu.c has no such concept, since classic Quake's
// episode set is fixed at compile time. This is the MODEL half of a new
// re-release-era menu feature (ARCHITECTURE.md's "Core model: one engine,
// one VM, content x ruleset" and "Content crossover" sections), split from
// menu.ts the way quake-2-re-ts's own src/client/menu_content.ts splits its
// model from its screens -- see that file's header for the import-cycle
// rationale, unchanged here: menu.ts imports this file's exports, this file
// never imports menu.ts.
//
// WHAT "CONTENT" AND "RULESET" MEAN HERE (Quake I's shape of the split,
// different from quake-2-re-ts's)
// ---------------------------------------------------------------------------
// "Content" is WHICH episode/campaign to play: id1 (the original four
// episodes), hipnotic, rogue, dopa (Dimension of the Past), mg1, mg3 --
// mapdb.json's own six `episodes` entries (confirmed against the real
// 27836-byte retail mapdb.json: src/lib/mapdb.ts's own header) -- plus "ctf"
// as a mounted gamedir with no single-player campaign of its own: every one
// of its 9 real maps is an `episode: "id1", game: "ctf"` entry, not a
// seventh episodes[] row. Content always keeps its own progs.dat: id1's
// episodes run id1's progs, hipnotic runs hipnotic's, and so on -- there is
// no "one module plays everything" concept here the way quake-2-re-ts's kex
// module is a content superset (ARCHITECTURE.md's "Content crossover":
// "Content chooses its progs by default").
//
// "Ruleset" is the ENGINE BEHAVIOUR PROFILE (src/progs/ext/ruleset.ts's
// classic/rerelease SV_Ruleset()), forced here via the `sv_ruleset` cvar
// rather than left on "auto", independent of which progs is running:
// picking "Classic 1999" for hipnotic still runs hipnotic's own (re-release)
// progs.dat, just with `sv_ruleset classic` forcing the pre-re-release
// physics/effects/print-formatting profile. This is why ResolveLaunch below
// returns the SAME gameArgs for both rulesets of a given episode -- unlike
// quake-2-re-ts's LAUNCH_TABLE, where classic/rerelease pick different game
// modules entirely.
//
// THE ONE CASE WHERE THE PROGS DOES CHANGE (ARCHITECTURE.md's "Content
// crossover": "mg1/mg3/dopa/ctf under classic 1.06 progs is 'classic progs'
// only when the user picks it explicitly and the compat table handles the
// rest") is ClassicProgsPlan below: running one of those four content sets'
// maps under id1's OWN 1.06 progs.dat, via the engine's future compat spawn
// table (ARCHITECTURE.md's per-classname rewrite/inhibit table -- a
// separate, not-yet-landed engine deliverable; this module only models the
// LaunchPlan such a choice would produce, it does not implement the table
// itself). This is a data-model capability, not a menu row this unit wires
// up -- the brief's screen list gives the Ruleset row exactly two choices
// (Classic 1999 / Re-release 2021); ClassicProgsPlan is exercised by
// menu_content.test.ts only, ready for a later unit's explicit UI entry.
//
// FILESYSTEM SEAM (ContentFsSeam, mirroring quake-2-re-ts's own
// GameFsSeam pattern in its menu_content.ts): every real filesystem/mapdb
// read goes through this one interface so menu_content.test.ts can drive
// BuildContentModel with synthetic data with no real mounted root, while
// LoadContentModel (menu.ts's real entry point) uses realContentFsSeam.

import { statSync } from "node:fs";
import { parseMapdb, type Mapdb, type MapdbMap } from "../lib/mapdb";
import { Loc_Localize, Loc_ReloadFile } from "../lib/loc";
import { Cvar_Set, Cvar_VariableString } from "../common/cvar";
import { Cbuf_AddText } from "../common/cmd";
import { COM_ClassicDir, COM_LoadTempFile, COM_RereleaseDir, COM_IsRereleaseRoot } from "../common/common";
import { QEX_SetCampaign } from "../progs/ext/ruleset";

export interface ContentFsSeam {
  directoryExists(path: string): boolean;
  loadTempFile(path: string): Uint8Array | null;
}

function realDirectoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const realContentFsSeam: ContentFsSeam = {
  directoryExists: realDirectoryExists,
  loadTempFile: (path: string) => COM_LoadTempFile(path),
};

//=============================================================================
// MOUNTED ROOTS / DIRS

export interface MountedRoots {
  classicRoot: string; // "" when no classic root is mounted
  rereleaseRoot: string; // "" when no re-release root is mounted
  isRerelease: boolean;
}

export function ScanMountedRoots(): MountedRoots {
  return {
    classicRoot: COM_ClassicDir(),
    rereleaseRoot: COM_RereleaseDir(),
    isRerelease: COM_IsRereleaseRoot(),
  };
}

// Where a content gamedir name resolves against -- mirrors common.ts's own
// (private) episodeRoot(): the re-release root when one is mounted, else
// the classic root.
export function ContentRoot(roots: MountedRoots): string {
  return roots.rereleaseRoot || roots.classicRoot;
}

// mapdb.json's six SP episode dirs, plus "ctf" -- a mounted gamedir with no
// mapdb.json episode of its own (see file header). Matches common.ts's own
// MISSION_PACK_DIRS set (hipnotic/rogue/mg1/mg3/dopa/ctf) plus "id1" itself.
export const EPISODE_DIRS: readonly string[] = ["id1", "hipnotic", "rogue", "dopa", "mg1", "mg3"];
export const ADDON_DIRS: readonly string[] = ["hipnotic", "rogue", "dopa", "mg1", "mg3", "ctf"];

// Every one of EPISODE_DIRS/ADDON_DIRS that actually exists as a directory
// under the active content root -- the New Game episode picker and the
// Add-Ons screen both start from this list (see LoadContentModel /
// MountedAddonDirs below).
export function MountedContentDirs(seam: ContentFsSeam, roots: MountedRoots): string[] {
  const root = ContentRoot(roots);
  if (!root) return [];
  const all = new Set<string>([...EPISODE_DIRS, ...ADDON_DIRS]);
  return [...all].filter((dir) => seam.directoryExists(`${root}/${dir}`));
}

//=============================================================================
// MAPDB LOADING

// COM_LoadFile pads every load with a trailing NUL (see common.ts's own
// COM_LoadFile); mapdb.json's JSON.parse needs that byte trimmed first, same
// as test/fs_rerelease.test.ts's own bytesToLatin1 helper does for text
// comparisons.
function decodeTempFileText(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export interface MapdbLoadResult {
  mapdb: Mapdb | null; // null when mapdb.json isn't present at all
  errors: string[];
}

export function LoadMapdb(seam: ContentFsSeam): MapdbLoadResult {
  const bytes = seam.loadTempFile("mapdb.json");
  if (bytes === null) return { mapdb: null, errors: [] };
  const text = decodeTempFileText(bytes);
  const result = parseMapdb(text);
  return { mapdb: result.mapdb, errors: result.errors };
}

//=============================================================================
// CONTENT MODEL

export interface ContentMap {
  title: string;
  bsp: string;
  dm: boolean;
  coop: boolean;
  bots: boolean;
  horde: boolean;
}

export interface ContentEpisode {
  dir: string;
  // mapdb.json's raw episodes[].name field -- a "$key" for Loc_Localize, or
  // plain text; see LocalizedEpisodeName below for the display rule.
  nameKey: string;
  // 1-based position in mapdb.json's episodes[] array, passed to
  // QEX_SetCampaign for a rerelease-ruleset launch (see that function's own
  // doc comment on this file's inference, since the KEX engine that defines
  // this numbering is closed source).
  campaignNumber: number;
  // sp maps for this episode, in mapdb.json's own map-array order (which the
  // real retail file already begins with each episode's "start" hub map --
  // see this file's header evidence -- so no separate "start entry first"
  // step is needed here).
  maps: ContentMap[];
}

export interface ContentModel {
  roots: MountedRoots;
  mapdbPresent: boolean;
  mapdbErrors: string[];
  episodes: ContentEpisode[];
  addonDirs: string[]; // ADDON_DIRS entries actually mounted, for the Add-Ons screen
}

function toContentMap(m: MapdbMap): ContentMap {
  return { title: m.title, bsp: m.bsp, dm: m.dm, coop: m.coop, bots: m.bots, horde: m.horde };
}

/**
 * Pure builder: no filesystem access, so menu_content.test.ts can drive it
 * directly with a synthetic mapdb and a fake mounted-dirs list. `mapdb` is
 * null when mapdb.json wasn't found (a classic-only install, or a
 * re-release root whose pak0.pak is missing it); `mountedDirs` is whichever
 * of EPISODE_DIRS/ADDON_DIRS the caller found present on disk.
 */
export function BuildContentModel(roots: MountedRoots, mapdb: Mapdb | null, mapdbErrors: readonly string[], mountedDirs: readonly string[]): ContentModel {
  const mountedSet = new Set(mountedDirs);
  const episodes: ContentEpisode[] = [];

  if (mapdb) {
    mapdb.episodes.forEach((e, index) => {
      if (!mountedSet.has(e.dir)) return;
      const maps = mapdb.maps.filter((m) => m.episode === e.dir && m.sp).map(toContentMap);
      if (maps.length === 0) return; // no sp content -- e.g. a future episodes[] row with dm/ctf maps only
      episodes.push({ dir: e.dir, nameKey: e.name, campaignNumber: index + 1, maps });
    });
  }

  const addonDirs = ADDON_DIRS.filter((d) => mountedSet.has(d));

  return {
    roots,
    mapdbPresent: mapdb !== null,
    mapdbErrors: [...mapdbErrors],
    episodes,
    addonDirs,
  };
}

/** The real entry point: menu.ts's New Game / Add-Ons screens call this
 * (with no argument) when entered. */
export function LoadContentModel(seam: ContentFsSeam = realContentFsSeam): ContentModel {
  const roots = ScanMountedRoots();
  const { mapdb, errors } = LoadMapdb(seam);
  const mountedDirs = MountedContentDirs(seam, roots);
  return BuildContentModel(roots, mapdb, errors, mountedDirs);
}

//=============================================================================
// LOCALIZATION (episode display names)
//
// The re-release resolves `$key` names through src/lib/loc.ts's table, which
// is loaded from `localization/loc_<language>.txt` -- see this unit's brief
// and src/progs/ext/ruleset.ts's own QEX_LoadLocalization (the SERVER-side
// loader, used for in-game prints). The menu needs its OWN load of the same
// table before a game is even running, so episode names on the New Game
// screen resolve too; this intentionally shares src/lib/loc.ts's one module-
// level table with the server loader (same file, same language, so no
// conflict -- QEX_AfterLoadProgs simply reloads/clears the same table once a
// map spawns, per its own ruleset gate).

export const LOC_LANGUAGES = ["english", "french", "german", "italian", "russian", "spanish"] as const;
export type LocLanguage = (typeof LOC_LANGUAGES)[number];

/** Which of LOC_LANGUAGES actually has a loc file mounted -- Options'
 * language row cycles this list. */
export function AvailableLanguages(seam: ContentFsSeam = realContentFsSeam): LocLanguage[] {
  return LOC_LANGUAGES.filter((lang) => seam.loadTempFile(`localization/loc_${lang}.txt`) !== null);
}

/** Loads the loc table for the current `language` cvar (falling back to
 * english, matching QEX_LoadLocalization's own fallback), for the menu's own
 * use. Returns the string count Loc_ReloadFile reports (0 means no table --
 * see LocalizedEpisodeName's fallback rule). */
export function LoadMenuLocalization(seam: ContentFsSeam = realContentFsSeam): number {
  const lang = Cvar_VariableString("language").trim().toLowerCase() || "english";
  let bytes = seam.loadTempFile(`localization/loc_${lang}.txt`);
  if (bytes === null && lang !== "english") bytes = seam.loadTempFile("localization/loc_english.txt");
  return Loc_ReloadFile(bytes);
}

/** `locLoaded` is whether LoadMenuLocalization returned > 0 (the brief's
 * "localized via $m_quake etc. when loc is available, else the mapdb name
 * text" rule) -- Loc_Localize's own miss fallback strips the leading "$"
 * instead of returning the raw mapdb string, which is why this isn't just
 * `Loc_Localize(nameKey, false, null, 0)` unconditionally. */
export function LocalizedEpisodeName(nameKey: string, locLoaded: boolean): string {
  if (!locLoaded) return nameKey;
  return Loc_Localize(nameKey, false, null, 0);
}

//=============================================================================
// RULESET / SKILL / LAUNCH

export type RulesetId = "classic" | "rerelease";

export const RULESETS: ReadonlyArray<{ id: RulesetId; name: string }> = [
  { id: "classic", name: "Classic 1999" },
  { id: "rerelease", name: "Re-release 2021" },
];

export const DIFFICULTIES: readonly string[] = ["Easy", "Normal", "Hard", "Nightmare"];

/**
 * Whether Nightmare should be offered for this (episode, ruleset) pair.
 *
 * ASSUMPTION (KEX engine is closed source, no ground truth to check this
 * against -- documented per standing order 4's "deviations and additions are
 * documented, never silent"): the re-release's own New Game screen offers
 * Nightmare directly for every episode (no secret-button unlock), while
 * WinQuake's classic Nightmare skill was only ever reachable through id1's
 * start.bsp ranger-statue Easter egg -- a secret this new episode picker
 * substitutes for only on id1 itself. Follow-up: revisit if retail re-
 * release UI text/behavior ever becomes available to check this against.
 */
export function EpisodeAllowsNightmare(episodeDir: string, ruleset: RulesetId): boolean {
  if (ruleset === "rerelease") return true;
  return episodeDir === "id1";
}

export interface LaunchPlan {
  gameArgs: string[]; // args to the `game` command
  ruleset: RulesetId;
  map: string; // bsp name for the `map` command
  skill: number; // 0-3
  campaign: boolean; // true => QEX_SetCampaign latches campaign_valid
  campaignNumber: number; // value passed to QEX_SetCampaign when campaign is true
}

/**
 * ResolveLaunch
 *
 * The New Game screen's launch plan for one (episode, ruleset, map, skill)
 * choice. Content always keeps its own progs (see file header), so
 * gameArgs is the episode's own dir under both rulesets -- the only things
 * that differ are `ruleset` (forces sv_ruleset) and `campaign` (a rerelease
 * launch marks the episode's campaign number engine-chosen; a classic
 * launch does not, per the unit brief).
 */
export function ResolveLaunch(episode: ContentEpisode, ruleset: RulesetId, map: string, skill: number): LaunchPlan {
  return {
    gameArgs: [episode.dir],
    ruleset,
    map,
    skill,
    campaign: ruleset === "rerelease",
    campaignNumber: episode.campaignNumber,
  };
}

export const CLASSIC_PROGS_ELIGIBLE: ReadonlySet<string> = new Set(["mg1", "mg3", "dopa", "ctf"]);

export function ClassicProgsEligible(episodeDir: string): boolean {
  return CLASSIC_PROGS_ELIGIBLE.has(episodeDir);
}

/**
 * ClassicProgsPlan -- see file header's "THE ONE CASE WHERE THE PROGS DOES
 * CHANGE". Returns null for content that isn't in CLASSIC_PROGS_ELIGIBLE
 * (id1/hipnotic/rogue have no "classic 1.06 progs" alternative to their own
 * progs -- id1 already IS the 1.06 progs, and hipnotic/rogue's own classic
 * progs are their own gamedir, reached through ResolveLaunch instead).
 */
export function ClassicProgsPlan(episodeDir: string, map: string, skill: number): LaunchPlan | null {
  if (!ClassicProgsEligible(episodeDir)) return null;
  return {
    gameArgs: ["id1"],
    ruleset: "classic",
    map,
    skill,
    campaign: false,
    campaignNumber: 0,
  };
}

/**
 * Content_PerformLaunch
 *
 * The engine side effect: mirrors M_SinglePlayer_Key's existing classic New
 * Game idiom (disconnect if a server is active, then queue the commands that
 * actually start the game) rather than quake-2-re-ts's own
 * "loading;killserver;wait;..." chain -- this engine's `map`/`game` commands
 * already do their own teardown (Host_Game_f/Host_Map_f), so there is no
 * cvar.ts CVAR_LATCH hazard to route around here (this port's cvar.ts has no
 * latch concept at all -- see this function's own Cvar_Set calls, applied
 * synchronously and safely before the queued `game`/`map` commands run).
 */
export function Content_PerformLaunch(plan: LaunchPlan): void {
  Cvar_Set("sv_ruleset", plan.ruleset);
  if (plan.campaign) QEX_SetCampaign(plan.campaignNumber);
  else Cvar_Set("campaign", "0");

  Cbuf_AddText("disconnect\n");
  Cbuf_AddText("maxplayers 1\n");
  Cbuf_AddText(`game ${plan.gameArgs.join(" ")}\n`);
  Cbuf_AddText(`skill ${plan.skill}\n`);
  Cbuf_AddText(`map ${plan.map}\n`);
}
