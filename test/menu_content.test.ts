// Self-sufficient tests for U17's content model (src/client/menu_content.ts):
// mounted-root/episode-dir detection, mapdb.json loading and parsing (via
// both a fake ContentFsSeam and the real filesystem), BuildContentModel's
// per-episode sp map lists, ResolveLaunch/ClassicProgsPlan for every
// (episode, ruleset) cell, EpisodeAllowsNightmare, language enumeration, and
// Content_PerformLaunch's cvar side effects.
//
// Per standing order 13: every synthetic scratch directory is uniquely named
// under a fresh mkdtemp, and the shared module-level singletons this file
// touches (src/lib/loc.ts's loc table, src/progs/ext/ruleset.ts's sv_ruleset/
// campaign CvarT objects) are snapshotted and restored in afterAll.

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContentFsSeam, MountedRoots } from "../src/client/menu_content";
import {
  ADDON_DIRS,
  AvailableBotSkillNames,
  AvailableLanguages,
  BOT_SKILL_NAMES,
  BotAddCommand,
  BotAddRandomCommand,
  BotKickCommand,
  BotsMenuAvailable,
  BotsPageEnabled,
  BuildBotsPageModel,
  BuildContentModel,
  BuildMpEpisodes,
  ClassicProgsEligible,
  ClassicProgsPlan,
  CL_PROTOCOLS,
  Content_PerformLaunch,
  ContentRoot,
  CtfMaps,
  EpisodeAllowsNightmare,
  EPISODE_DIRS,
  LoadContentModel,
  LoadMapdb,
  LoadMenuLocalization,
  LocalizedEpisodeName,
  MenuLoc,
  MountedContentDirs,
  realContentFsSeam,
  ResolveLaunch,
  RULESETS,
  SV_PROTOCOLS,
  test_ResetMenuLocCache,
} from "../src/client/menu_content";
import * as cmdModule from "../src/common/cmd";
import { Cbuf_Init } from "../src/common/cmd";
import { Cvar_RegisterVariable, Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString } from "../src/common/cvar";
import { COM_InitArgv, COM_InitFilesystem, com_gamedir, com_searchpaths, setComGamedir, setComSearchpaths } from "../src/common/common";
import { Loc_ReloadFile, Loc_Unload } from "../src/lib/loc";
import type { Mapdb } from "../src/lib/mapdb";
import { campaign, language, sv_ruleset } from "../src/progs/ext/ruleset";
import { Loc_SetLocaleProbeForTest } from "../src/common/loc_host";
import { Bot_ForgetKnowledge, Bot_ForgetMapdb, bot_count, bot_skill } from "../src/bots";

Cbuf_Init();

// A bare spyOn (rule 15) recording every Cbuf_AddText call, so the launch
// ORDER Content_PerformLaunch queues can be asserted without running the
// commands (which would need a real mounted gamedir and bsp -- see the
// Content_PerformLaunch describe block's own note below).
const cbufAddTextSpy = spyOn(cmdModule, "Cbuf_AddText");

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

const savedSvRulesetString = sv_ruleset.string;
const savedSvRulesetValue = sv_ruleset.value;
const savedCampaignString = campaign.string;
Cvar_RegisterVariable(language); // no-op if already registered (cvar.ts's own guard)
const savedLanguageString = language.string;
const savedCampaignValue = campaign.value;
// U40 additions: bot_count/bot_skill (real objects, registered as a
// module-load side effect of importing "../src/bots" -- see that module's
// own header) and the filesystem globals the U40 Bots-model tests below
// rebuild via COM_InitFilesystem.
const savedBotCountString = bot_count.string;
const savedBotCountValue = bot_count.value;
const savedBotSkillString = bot_skill.string;
const savedBotSkillValue = bot_skill.value;
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;

afterAll(() => {
  Loc_Unload();
  sv_ruleset.string = savedSvRulesetString;
  sv_ruleset.value = savedSvRulesetValue;
  campaign.string = savedCampaignString;
  campaign.value = savedCampaignValue;
  bot_count.string = savedBotCountString;
  bot_count.value = savedBotCountValue;
  bot_skill.string = savedBotSkillString;
  bot_skill.value = savedBotSkillValue;
  Bot_ForgetKnowledge();
  Bot_ForgetMapdb();
  setComSearchpaths(savedComSearchpaths);
  setComGamedir(savedComGamedir);
});

//=============================================================================
// A fake ContentFsSeam: no real filesystem access at all.

function padded(text: string): Uint8Array {
  // Mirrors COM_LoadFile's trailing NUL (see menu_content.ts's own
  // decodeTempFileText comment) so the trim path is exercised too.
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  return out;
}

/** `overlays` maps a path to every copy of it "found across the search
 * path", lowest priority first -- COM_LoadAllFiles' own ordering. */
function fakeSeam(
  files: Readonly<Record<string, string>>,
  dirs: readonly string[],
  overlays: Readonly<Record<string, readonly string[]>> = {},
): ContentFsSeam {
  const dirSet = new Set(dirs);
  return {
    directoryExists: (path: string) => dirSet.has(path),
    loadTempFile: (path: string) => {
      const text = files[path];
      if (text === undefined) return null;
      return padded(text);
    },
    loadAllFiles: (path: string) => (overlays[path] ?? []).map(padded),
  };
}

const FAKE_ROOT = "/fake/rerelease";

function fakeRoots(): MountedRoots {
  return { classicRoot: "", rereleaseRoot: FAKE_ROOT, isRerelease: true };
}

const SYNTHETIC_MAPDB_TEXT = JSON.stringify({
  episodes: [
    { dir: "id1", name: "$m_quake" },
    { dir: "hipnotic", name: "$m_scourge" },
    { dir: "rogue", name: "$m_dissolution" },
    { dir: "dopa", name: "$m_dopa" },
    { dir: "mg1", name: "$m_mg1" },
    { dir: "mg3", name: "$m_mg3" },
  ],
  maps: [
    { title: "Entrance", bsp: "start", episode: "id1", game: "id1", sp: true },
    { title: "Slipgate Complex", bsp: "e1m1", episode: "id1", game: "id1", sp: true },
    { title: "Castle of the Damned", bsp: "e1m2", episode: "id1", game: "id1", sp: true },
    { title: "Place of Two Deaths", bsp: "dm1", episode: "id1", game: "id1", dm: true, bots: true },
    { title: "McKinley Base", bsp: "ctf1", episode: "id1", game: "ctf", ctf: true, bots: true },
    { title: "Command HQ", bsp: "start", episode: "hipnotic", game: "hipnotic", sp: true },
    { title: "The Pumping Station", bsp: "hip1m1", episode: "hipnotic", game: "hipnotic", sp: true },
    // rogue/dopa/mg1/mg3 appear in episodes[] but have NO sp:true entries --
    // BuildContentModel must filter these out even when their dir is mounted
    // (see the "no sp content" test below).
  ],
}) as string;

//=============================================================================

describe("MountedContentDirs / ContentRoot", () => {
  test("ContentRoot prefers the re-release root", () => {
    expect(ContentRoot({ classicRoot: "/classic", rereleaseRoot: "/rerelease", isRerelease: true })).toBe("/rerelease");
    expect(ContentRoot({ classicRoot: "/classic", rereleaseRoot: "", isRerelease: false })).toBe("/classic");
    expect(ContentRoot({ classicRoot: "", rereleaseRoot: "", isRerelease: false })).toBe("");
  });

  test("only dirs the seam reports as existing are returned", () => {
    const seam = fakeSeam({}, [`${FAKE_ROOT}/id1`, `${FAKE_ROOT}/hipnotic`, `${FAKE_ROOT}/ctf`]);
    const dirs = MountedContentDirs(seam, fakeRoots());
    expect(dirs.sort()).toEqual(["ctf", "hipnotic", "id1"].sort());
  });

  test("no root mounted -> no dirs", () => {
    const seam = fakeSeam({}, [`${FAKE_ROOT}/id1`]);
    const dirs = MountedContentDirs(seam, { classicRoot: "", rereleaseRoot: "", isRerelease: false });
    expect(dirs).toEqual([]);
  });

  test("EPISODE_DIRS/ADDON_DIRS shape", () => {
    expect(EPISODE_DIRS).toEqual(["id1", "hipnotic", "rogue", "dopa", "mg1", "mg3"]);
    expect(ADDON_DIRS).toEqual(["hipnotic", "rogue", "dopa", "mg1", "mg3", "ctf"]);
  });
});

describe("LoadMapdb (fake seam)", () => {
  test("null when mapdb.json isn't present", () => {
    const seam = fakeSeam({}, []);
    const result = LoadMapdb(seam);
    expect(result.mapdb).toBeNull();
    expect(result.errors).toEqual([]);
  });

  test("parses a real-shaped mapdb.json, trailing NUL trimmed", () => {
    const seam = fakeSeam({ "mapdb.json": SYNTHETIC_MAPDB_TEXT }, []);
    const result = LoadMapdb(seam);
    expect(result.mapdb).not.toBeNull();
    expect(result.mapdb?.episodes.length).toBe(6);
    expect(result.mapdb?.maps.length).toBe(7);
    expect(result.errors).toEqual([]);
  });
});

describe("BuildContentModel", () => {
  const parsed = LoadMapdb(fakeSeam({ "mapdb.json": SYNTHETIC_MAPDB_TEXT }, [])).mapdb as Mapdb;

  test("every episode dir mounted, but only id1/hipnotic have sp maps", () => {
    const mounted = [...EPISODE_DIRS, "ctf"]; // all six + ctf mounted
    const model = BuildContentModel(fakeRoots(), parsed, [], mounted);

    expect(model.mapdbPresent).toBe(true);
    // Only id1/hipnotic have sp:true entries in SYNTHETIC_MAPDB_TEXT --
    // rogue/dopa/mg1/mg3 are mounted but have no sp content, so they're
    // filtered out of the New Game episode list (see BuildContentModel's
    // own "no sp content" comment).
    expect(model.episodes.map((e) => e.dir)).toEqual(["id1", "hipnotic"]);
    // addonDirs is unfiltered by sp content -- every mounted ADDON_DIRS entry
    // shows up for the Add-Ons screen regardless of campaign content.
    expect(model.addonDirs.sort()).toEqual([...ADDON_DIRS].sort());
  });

  test("sp maps preserve mapdb.json's own order, 'start' first", () => {
    const mounted = ["id1", "hipnotic"];
    const model = BuildContentModel(fakeRoots(), parsed, [], mounted);
    const id1 = model.episodes.find((e) => e.dir === "id1");
    expect(id1).toBeDefined();
    expect(id1?.maps.map((m) => m.bsp)).toEqual(["start", "e1m1", "e1m2"]);
    expect(id1?.maps[0].title).toBe("Entrance");
    // dm-only and ctf-only entries are excluded (sp is false/absent on them)
    expect(id1?.maps.some((m) => m.bsp === "dm1")).toBe(false);
  });

  test("campaignNumber is the 1-based mapdb.json episodes[] position", () => {
    const mounted = EPISODE_DIRS;
    const model = BuildContentModel(fakeRoots(), parsed, [], mounted);
    const id1 = model.episodes.find((e) => e.dir === "id1");
    const hipnotic = model.episodes.find((e) => e.dir === "hipnotic");
    expect(id1?.campaignNumber).toBe(1);
    expect(hipnotic?.campaignNumber).toBe(2);
  });

  test("an episode dir not mounted is excluded even though mapdb.json lists it", () => {
    const mounted = ["id1"]; // hipnotic's dir isn't mounted here
    const model = BuildContentModel(fakeRoots(), parsed, [], mounted);
    expect(model.episodes.map((e) => e.dir)).toEqual(["id1"]);
  });

  test("a mounted episode dir with zero sp maps is excluded", () => {
    const mounted = ["rogue", "dopa", "mg1", "mg3"]; // all mounted, none have sp:true entries
    const model = BuildContentModel(fakeRoots(), parsed, [], mounted);
    expect(model.episodes).toEqual([]);
  });

  test("null mapdb -> mapdbPresent false, no episodes", () => {
    const model = BuildContentModel(fakeRoots(), null, ["mapdb.json not found"], EPISODE_DIRS);
    expect(model.mapdbPresent).toBe(false);
    expect(model.episodes).toEqual([]);
    expect(model.mapdbErrors).toEqual(["mapdb.json not found"]);
  });

  test("addonDirs is ADDON_DIRS filtered by what's actually mounted", () => {
    const model = BuildContentModel(fakeRoots(), parsed, [], ["hipnotic", "ctf", "id1"]);
    expect(model.addonDirs.sort()).toEqual(["ctf", "hipnotic"].sort());
  });
});

//=============================================================================
// ResolveLaunch / ClassicProgsPlan -- every (episode, ruleset) cell.

describe("ResolveLaunch", () => {
  const parsed = LoadMapdb(fakeSeam({ "mapdb.json": SYNTHETIC_MAPDB_TEXT }, [])).mapdb as Mapdb;
  const model = BuildContentModel(fakeRoots(), parsed, [], EPISODE_DIRS);
  const id1 = model.episodes.find((e) => e.dir === "id1")!;
  const hipnotic = model.episodes.find((e) => e.dir === "hipnotic")!;

  test("classic: same gameArgs as the episode dir, campaign false", () => {
    const plan = ResolveLaunch(id1, "classic", "e1m1", 2);
    expect(plan).toEqual({ gameArgs: ["id1"], ruleset: "classic", map: "e1m1", skill: 2, campaign: false, campaignNumber: 1 });
  });

  test("rerelease: same gameArgs, campaign true with the episode's campaign number", () => {
    const plan = ResolveLaunch(id1, "rerelease", "e1m1", 2);
    expect(plan).toEqual({ gameArgs: ["id1"], ruleset: "rerelease", map: "e1m1", skill: 2, campaign: true, campaignNumber: 1 });

    const hipPlan = ResolveLaunch(hipnotic, "rerelease", "hip1m1", 0);
    expect(hipPlan.gameArgs).toEqual(["hipnotic"]);
    expect(hipPlan.campaign).toBe(true);
    expect(hipPlan.campaignNumber).toBe(2);
  });

  test("RULESETS has exactly the two brief-specified choices, in display order", () => {
    expect(RULESETS.map((r) => r.id)).toEqual(["classic", "rerelease"]);
    expect(RULESETS.map((r) => r.name)).toEqual(["Classic 1999", "Re-release 2021"]);
  });
});

describe("ClassicProgsPlan (the mg1/mg3/dopa/ctf 'classic 1.06 progs' crossover)", () => {
  test("eligible content resolves to id1's own progs, classic ruleset, no campaign", () => {
    for (const dir of ["mg1", "mg3", "dopa", "ctf"]) {
      expect(ClassicProgsEligible(dir)).toBe(true);
      const plan = ClassicProgsPlan(dir, "somebsp", 1);
      expect(plan).toEqual({ gameArgs: ["id1"], ruleset: "classic", map: "somebsp", skill: 1, campaign: false, campaignNumber: 0 });
    }
  });

  test("id1/hipnotic/rogue have no classic-progs crossover of their own", () => {
    for (const dir of ["id1", "hipnotic", "rogue"]) {
      expect(ClassicProgsEligible(dir)).toBe(false);
      expect(ClassicProgsPlan(dir, "somebsp", 1)).toBeNull();
    }
  });
});

describe("EpisodeAllowsNightmare", () => {
  test("rerelease always allows it", () => {
    for (const dir of EPISODE_DIRS) expect(EpisodeAllowsNightmare(dir, "rerelease")).toBe(true);
  });

  test("classic only allows it for id1 (the secret-button episode)", () => {
    expect(EpisodeAllowsNightmare("id1", "classic")).toBe(true);
    for (const dir of ["hipnotic", "rogue", "dopa", "mg1", "mg3"]) {
      expect(EpisodeAllowsNightmare(dir, "classic")).toBe(false);
    }
  });
});

//=============================================================================
// Language enumeration

describe("AvailableLanguages", () => {
  test("only languages the seam actually has a loc file for, in LOC_LANGUAGES order", () => {
    const seam = fakeSeam(
      {
        "localization/loc_english.txt": "",
        "localization/loc_french.txt": "",
        "localization/loc_russian.txt": "",
      },
      [],
    );
    expect(AvailableLanguages(seam)).toEqual(["english", "french", "russian"]);
  });

  test("none mounted -> empty list", () => {
    expect(AvailableLanguages(fakeSeam({}, []))).toEqual([]);
  });
});

describe("LocalizedEpisodeName", () => {
  test("locLoaded false returns the raw mapdb name text", () => {
    expect(LocalizedEpisodeName("$m_quake", false)).toBe("$m_quake");
  });

  test("locLoaded true resolves through src/lib/loc.ts's table", () => {
    const locText = 'm_quake = "Quake"\n';
    const bytes = new TextEncoder().encode(locText);
    const count = Loc_ReloadFile(bytes);
    expect(count).toBeGreaterThan(0);
    expect(LocalizedEpisodeName("$m_quake", true)).toBe("Quake");
    Loc_Unload();
  });
});

describe("LoadMenuLocalization", () => {
  afterAll(() => {
    Loc_Unload();
    Cvar_Set("language", savedLanguageString);
  });

  test("loads the current language's loc file through the seam", () => {
    Cvar_Set("language", "english");
    const seam = fakeSeam({ "localization/loc_english.txt": 'm_quake = "Quake"\n' }, []);
    const count = LoadMenuLocalization(seam);
    expect(count).toBeGreaterThan(0);
  });

  test("missing loc file -> 0, table cleared", () => {
    Cvar_Set("language", "english");
    const count = LoadMenuLocalization(fakeSeam({}, []));
    expect(count).toBe(0);
  });

  // F3: the menu goes through the SAME ordered loader as the server's own
  // QEX_LoadLocalization (Loc_ResolveLanguage + COM_LoadAllFiles +
  // Loc_LoadOrdered), so a mod's `loc_<lang>_mod.txt` overlay wins in the
  // menus too -- highest-priority overlay last.
  test("_mod.txt overlays are merged over the base file, highest priority last", () => {
    Cvar_Set("language", "english");
    const seam = fakeSeam(
      { "localization/loc_english.txt": 'm_quake = "Quake"\nm_hipnotic = "Scourge of Armagon"\n' },
      [],
      { "localization/loc_english_mod.txt": ['m_quake = "Base Mod"\n', 'm_quake = "Top Mod"\nm_extra = "Extra"\n'] },
    );

    const count = LoadMenuLocalization(seam);
    expect(count).toBe(3);
    expect(LocalizedEpisodeName("$m_quake", true)).toBe("Top Mod");
    expect(LocalizedEpisodeName("$m_hipnotic", true)).toBe("Scourge of Armagon");
    expect(LocalizedEpisodeName("$m_extra", true)).toBe("Extra");
  });

  // The whole tier falls back, base file AND overlays, exactly as
  // Loc_LoadOrdered specifies -- a language with no base file anywhere does
  // not pick up its own stray overlay.
  test("a language with no base file falls back to the english tier, overlays included", () => {
    Cvar_Set("language", "german");
    const seam = fakeSeam(
      { "localization/loc_english.txt": 'm_quake = "Quake"\n' },
      [],
      {
        "localization/loc_german_mod.txt": ['m_quake = "Beben"\n'],
        "localization/loc_english_mod.txt": ['m_quake = "English Mod"\n'],
      },
    );

    LoadMenuLocalization(seam);
    expect(LocalizedEpisodeName("$m_quake", true)).toBe("English Mod");
  });

  // `language auto` resolves through the system locale the same way the
  // server side already did -- previously the menu read the cvar straight
  // and looked for "localization/loc_auto.txt".
  test("language auto resolves through the locale probe", () => {
    Cvar_Set("language", "auto");
    Loc_SetLocaleProbeForTest(() => "fr_FR.UTF-8");
    try {
      const seam = fakeSeam(
        {
          "localization/loc_french.txt": 'm_quake = "Quake FR"\n',
          "localization/loc_english.txt": 'm_quake = "Quake EN"\n',
        },
        [],
      );
      LoadMenuLocalization(seam);
      expect(LocalizedEpisodeName("$m_quake", true)).toBe("Quake FR");
    } finally {
      Loc_SetLocaleProbeForTest(null);
    }
  });
});

// D7: every menu label with a retail `m_*` key draws through this resolver.
describe("MenuLoc", () => {
  afterAll(() => {
    Loc_Unload();
    test_ResetMenuLocCache();
    Cvar_Set("language", savedLanguageString);
  });

  const RETAIL_ENGLISH = 'm_options = "Options"\nm_always_run = "Always Run"\nm_on = "On"\n';
  const RETAIL_RUSSIAN = 'm_options = "Настройки"\nm_always_run = "Всегда бежать"\n';

  function withLanguage(lang: string, files: Readonly<Record<string, string>>): ContentFsSeam {
    Cvar_Set("language", lang);
    test_ResetMenuLocCache();
    return fakeSeam(files, []);
  }

  test("a key the table has resolves to the table's text", () => {
    const seam = withLanguage("english", { "localization/loc_english.txt": RETAIL_ENGLISH });
    expect(MenuLoc("$m_always_run", "Always Run", seam)).toBe("Always Run");
    expect(MenuLoc("$m_on", "on", seam)).toBe("On");
  });

  test("a key the table does NOT have draws the English fallback, not the bare key", () => {
    const seam = withLanguage("english", { "localization/loc_english.txt": RETAIL_ENGLISH });
    expect(MenuLoc("$m_lookspring", "Lookspring", seam)).toBe("Lookspring");
  });

  test("no loc file at all draws every English fallback", () => {
    const seam = withLanguage("english", {});
    expect(MenuLoc("$m_options", "Options", seam)).toBe("Options");
    expect(MenuLoc("$m_always_run", "Always Run", seam)).toBe("Always Run");
  });

  test("a string with no key is returned unchanged", () => {
    const seam = withLanguage("english", { "localization/loc_english.txt": RETAIL_ENGLISH });
    expect(MenuLoc("Go to console", "Go to console", seam)).toBe("Go to console");
  });

  // The Options screen's own language row changes the cvar mid-session; the
  // next label draw must reload rather than keep serving the old language.
  test("changing the language cvar changes what the next label resolves to", () => {
    const files = {
      "localization/loc_english.txt": RETAIL_ENGLISH,
      "localization/loc_russian.txt": RETAIL_RUSSIAN,
    };
    const seam = withLanguage("english", files);
    expect(MenuLoc("$m_options", "Options", seam)).toBe("Options");

    Cvar_Set("language", "russian");
    expect(MenuLoc("$m_options", "Options", seam)).toBe("Настройки");
    // Loc_LoadOrdered swaps the WHOLE tier rather than patching keys in from
    // two languages at once, so a key the Russian file omits is a plain miss
    // here -- and a miss is exactly what the caller's English text is for.
    expect(MenuLoc("$m_on", "on", seam)).toBe("on");

    Cvar_Set("language", "english");
    expect(MenuLoc("$m_options", "Options", seam)).toBe("Options");
  });

  test("LoadMenuLocalization's explicit load is what the next MenuLoc uses", () => {
    Cvar_Set("language", "english");
    test_ResetMenuLocCache();
    const seam = fakeSeam({ "localization/loc_english.txt": 'm_options = "Preferences"\n' }, []);
    LoadMenuLocalization(seam);
    // no seam passed: the cached load above is honoured rather than a
    // reload through the real filesystem
    expect(MenuLoc("$m_options", "Options")).toBe("Preferences");
  });
});

// A real temp gamedir on the search path, proving the overlay merge reaches
// the menus through the REAL seam (COM_LoadTempFile + COM_LoadAllFiles), not
// only through fakeSeam's records.
describe("LoadMenuLocalization (real search path, temp gamedir with a _mod overlay)", () => {
  const root = mkdtempSync(join(scratchRoot, "menu-loc-mod-"));

  afterAll(() => {
    Loc_Unload();
    Cvar_Set("language", savedLanguageString);
    setComSearchpaths(savedComSearchpaths);
    setComGamedir(savedComGamedir);
    rmSync(root, { recursive: true, force: true });
  });

  test("a mod gamedir's loc_english_mod.txt overrides id1's base loc file", () => {
    mkdirSync(join(root, "id1", "localization"), { recursive: true });
    mkdirSync(join(root, "locmod", "localization"), { recursive: true });
    writeFileSync(join(root, "id1", "localization", "loc_english.txt"), 'm_quake = "Quake"\nm_rogue = "Dissolution of Eternity"\n');
    writeFileSync(join(root, "locmod", "localization", "loc_english_mod.txt"), 'm_quake = "Overlaid"\n');

    setComSearchpaths(null);
    COM_InitArgv(["q1ts", "-basedir", root, "-game", "locmod", "-nohomedir"]);
    COM_InitFilesystem();

    Cvar_Set("language", "english");
    const count = LoadMenuLocalization();
    expect(count).toBe(2);
    expect(LocalizedEpisodeName("$m_quake", true)).toBe("Overlaid");
    expect(LocalizedEpisodeName("$m_rogue", true)).toBe("Dissolution of Eternity");
  });
});

//=============================================================================
// Content_PerformLaunch -- the queued launch script and the `campaign` side
// effect (no Cbuf_Execute: exercising the queued `game`/`map` commands would
// need a real mounted gamedir/bsp, which is this file's synthetic-model
// territory, not this unit's -- see test/menu.test.ts's own key-navigation
// extension for an end-to-end check).

describe("Content_PerformLaunch", () => {
  Cvar_RegisterVariable(sv_ruleset); // no-op if already registered (cvar.ts's own guard)
  Cvar_RegisterVariable(campaign);

  test("rerelease plan queues game first, then the cvars, then map, and latches campaign", () => {
    cbufAddTextSpy.mockClear();
    Content_PerformLaunch({ gameArgs: ["hipnotic"], ruleset: "rerelease", map: "hip1m1", skill: 1, campaign: true, campaignNumber: 2 });

    expect(cbufAddTextSpy.mock.calls.map(([s]) => s)).toEqual([
      "disconnect\n",
      "game hipnotic\n",
      "maxplayers 1\n",
      "sv_ruleset rerelease\n",
      "skill 1\n",
      "map hip1m1\n",
    ]);
    expect(Cvar_VariableValue("campaign")).toBe(2);
  });

  test("classic plan queues sv_ruleset classic after the gamedir switch and clears campaign", () => {
    cbufAddTextSpy.mockClear();
    Content_PerformLaunch({ gameArgs: ["id1"], ruleset: "classic", map: "e1m1", skill: 0, campaign: false, campaignNumber: 0 });

    const calls = cbufAddTextSpy.mock.calls.map(([s]) => s);
    expect(calls).toEqual(["disconnect\n", "game id1\n", "maxplayers 1\n", "sv_ruleset classic\n", "skill 0\n", "map e1m1\n"]);
    expect(Cvar_VariableValue("campaign")).toBe(0);
  });

  // The defect this ordering fixes: `game <dir>` re-execs quake.rc, whose
  // config.cfg carries an archived `sv_ruleset "auto"` for that content. A
  // ruleset applied BEFORE the switch (or applied synchronously as a cvar
  // write) is reverted moments after the level spawns; queued after the
  // `game` line it wins.
  test("sv_ruleset is queued after game, never before it and never set synchronously", () => {
    Cvar_Set("sv_ruleset", "auto");
    cbufAddTextSpy.mockClear();
    Content_PerformLaunch({ gameArgs: ["rogue"], ruleset: "rerelease", map: "r1m1", skill: 3, campaign: false, campaignNumber: 0 });

    const calls = cbufAddTextSpy.mock.calls.map(([s]) => s);
    expect(Cvar_VariableString("sv_ruleset")).toBe("auto"); // not touched synchronously
    expect(calls.indexOf("game rogue\n")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("game rogue\n")).toBeLessThan(calls.indexOf("sv_ruleset rerelease\n"));
    expect(calls.indexOf("sv_ruleset rerelease\n")).toBeLessThan(calls.indexOf("map r1m1\n"));
  });
});

//=============================================================================
// LoadContentModel against the real filesystem: a synthetic -rerelease root
// (COM_InitArgv/-rerelease bypasses COM_IsRereleaseRootDir's auto-detection,
// so a loose mapdb.json with no pak/kpf is enough -- see menu_content.ts's
// own header and common.ts's COM_InitFilesystem for why -rerelease "trusts
// it as-is").

describe("LoadContentModel (real filesystem, synthetic -rerelease root)", () => {
  const root = mkdtempSync(join(scratchRoot, "menu-content-test-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("id1 and hipnotic mounted, mapdb.json describes both", () => {
    mkdirSync(join(root, "id1"), { recursive: true });
    mkdirSync(join(root, "hipnotic"), { recursive: true });
    writeFileSync(join(root, "id1", "mapdb.json"), SYNTHETIC_MAPDB_TEXT);

    COM_InitArgv(["q1ts", "-rerelease", root, "-nohomedir"]);
    COM_InitFilesystem();

    const model = LoadContentModel();
    expect(model.mapdbPresent).toBe(true);
    expect(model.episodes.map((e) => e.dir).sort()).toEqual(["hipnotic", "id1"].sort());
  });
});

//=============================================================================
// Guarded real-data check (skipped unless the real retail install is
// present) -- the unit brief's own acceptance line: "the six retail episodes
// enumerate with their 143 maps."

const REAL_Q1_DIR = process.env.Q1TS_REAL_DATA ?? "/home/buzzkill/Projects/qfiles/q1";
const HAVE_REAL_Q1 = existsSync(join(REAL_Q1_DIR, "id1")) && existsSync(join(REAL_Q1_DIR, "rerelease"));

describe.skipIf(!HAVE_REAL_Q1)("real-data: qfiles/q1's retail mapdb.json", () => {
  test("6 episodes, 143 maps total, all six enumerate as content-model episodes", () => {
    COM_InitArgv(["q1ts", "-basedir", REAL_Q1_DIR, "-nohomedir"]);
    COM_InitFilesystem();

    const { mapdb } = LoadMapdb(realContentFsSeam);
    expect(mapdb).not.toBeNull();
    expect(mapdb?.episodes.length).toBe(6);
    expect(mapdb?.maps.length).toBe(143);

    const model = LoadContentModel();
    expect(model.mapdbPresent).toBe(true);
    expect(model.episodes.length).toBe(6);
    expect(model.episodes.map((e) => e.dir).sort()).toEqual(["dopa", "hipnotic", "id1", "mg1", "mg3", "rogue"].sort());
  });
});

//=============================================================================
// U40: BuildMpEpisodes / CtfMaps -- the New Game (start server) screen's
// mapdb-driven multiplayer map lists.

describe("BuildMpEpisodes / CtfMaps", () => {
  const mapdb: Mapdb = {
    episodes: [
      { dir: "id1", name: "$m_quake" },
      { dir: "hipnotic", name: "$m_scourge" },
    ],
    maps: [
      { title: "Entrance", bsp: "start", episode: "id1", game: "id1", sp: true, dm: false, coop: false, bots: false, ctf: false, horde: false },
      { title: "Place of Two Deaths", bsp: "dm1", episode: "id1", game: "id1", sp: false, dm: true, coop: false, bots: true, ctf: false, horde: false },
      { title: "The Cistern", bsp: "dm5", episode: "id1", game: "id1", sp: false, dm: true, coop: false, bots: false, ctf: false, horde: false },
      { title: "Hub", bsp: "start", episode: "id1", game: "id1", sp: true, dm: false, coop: true, bots: false, ctf: false, horde: false },
      { title: "McKinley Base", bsp: "ctf1", episode: "id1", game: "ctf", sp: false, dm: false, coop: false, bots: true, ctf: true, horde: false },
      { title: "Focal Point", bsp: "ctf2", episode: "id1", game: "ctf", sp: false, dm: false, coop: false, bots: false, ctf: true, horde: false },
      // hipnotic has no dm/coop entries in this fixture -- excluded below.
      { title: "Command HQ", bsp: "start", episode: "hipnotic", game: "hipnotic", sp: true, dm: false, coop: false, bots: false, ctf: false, horde: false },
    ],
  };

  test("dm filter: only id1's two dm maps, hipnotic excluded (no dm content)", () => {
    const result = BuildMpEpisodes(mapdb, ["id1", "hipnotic"], "dm");
    expect(result.map((e) => e.dir)).toEqual(["id1"]);
    expect(result[0]?.maps.map((m) => m.bsp)).toEqual(["dm1", "dm5"]);
  });

  test("coop filter: only the coop-flagged map", () => {
    const result = BuildMpEpisodes(mapdb, ["id1", "hipnotic"], "coop");
    expect(result.map((e) => e.dir)).toEqual(["id1"]);
    expect(result[0]?.maps.map((m) => m.bsp)).toEqual(["start"]);
  });

  test("an episode dir not in mountedDirs is excluded even though mapdb.json lists it", () => {
    const result = BuildMpEpisodes(mapdb, ["hipnotic"], "dm");
    expect(result).toEqual([]);
  });

  test("CtfMaps: every game==='ctf' entry, regardless of episode", () => {
    const maps = CtfMaps(mapdb);
    expect(maps.map((m) => m.bsp)).toEqual(["ctf1", "ctf2"]);
    expect(maps[0]).toEqual({ title: "McKinley Base", bsp: "ctf1" });
  });
});

//=============================================================================
// U40: SV_PROTOCOLS / CL_PROTOCOLS -- the New Game/Join Game Protocol rows.

describe("SV_PROTOCOLS / CL_PROTOCOLS", () => {
  test("SV_PROTOCOLS matches sv_protocol's own accepted values", () => {
    expect(SV_PROTOCOLS).toEqual(["auto", "15", "666", "999"]);
  });

  test("CL_PROTOCOLS matches cl_protocol's own accepted values", () => {
    expect(CL_PROTOCOLS).toEqual(["auto", "nq", "qw"]);
  });
});

//=============================================================================
// U40: the Bots page model (BotsMenuAvailable/AvailableBotSkillNames/
// BuildBotsPageModel/BotsPageEnabled), against a real mounted game directory
// (Bot_Knowledge/Bot_MapAllowsBots read off COM_LoadTempFile, not a seam --
// see src/bots/bot_data.ts's own header). Bot_ForgetKnowledge/Bot_ForgetMapdb
// reset those modules' own caches between mounts, per rule 13.

const BOTS_WEAPONS_TXT = `
{
  name "axe"
  number 4096
  damage 20
  min_range 0
  max_range 72
  min_height 0
  max_height 0
  priority 1
  ammo none
  ammo_name ""
  min_ammo 0
  max_ammo 0
  flags melee | starting
  aim_point center
}
`;

const BOTS_SETTINGS_TXT = `
skill easy
{
  aiming.max_acceleration 200
  aiming.spring_stiffness 80
  aiming.damping 10
  aiming.velocity_offset -0.1
  aiming.modifier.max_angle 30
  aiming.modifier.apply_time 0.75
  aiming.modifier.accel_scalar 1
  aiming.modifier.spring_scalar 1
  aiming.modifier.damping_scalar 1
  behaviors.allow_combat true
  behaviors.allow_grab_items_in_combat false
  behaviors.allow_melee true
  behaviors.allow_check_six false
  behaviors.allow_grab_items true
  behaviors.allow_grab_power_items true
  behaviors.defer_power_items_to_humans false
  behaviors.min_respawn_time 1
  behaviors.max_respawn_time 1.5
  movement.allow_jumping_in_combat false
  movement.jump_chance 10
  movement.jump_cooldown 1
  movement.walk_only true
  senses.sight_time 0.25
  senses.sight_decay_time 0.3
  senses.invis_enemy_sight_scalar 2
  senses.max_invis_enemy_sight_dist 256
  senses.fov_angle 120
  senses.forget_non_vis_enemy_time 1.5
  senses.sound_range 500
  senses.sound_time 0.4
  senses.sound_decay_time 2.5
  senses.sound_persist_time 0.4
  weapons.decay_time 2
  weapons.fov_angle 40
  weapons.sight_time 0.2
}
skill medium
{
  aiming.max_acceleration 360
  aiming.spring_stiffness 125
  aiming.damping 20
  aiming.velocity_offset -0.1
  aiming.modifier.max_angle 30
  aiming.modifier.apply_time 0.75
  aiming.modifier.accel_scalar 1.25
  aiming.modifier.spring_scalar 1.25
  aiming.modifier.damping_scalar 1.25
  behaviors.allow_combat true
  behaviors.allow_grab_items_in_combat false
  behaviors.allow_melee true
  behaviors.allow_check_six false
  behaviors.allow_grab_items true
  behaviors.allow_grab_power_items true
  behaviors.defer_power_items_to_humans false
  behaviors.min_respawn_time 1
  behaviors.max_respawn_time 1.5
  movement.allow_jumping_in_combat true
  movement.jump_chance 35
  movement.jump_cooldown 1
  movement.walk_only false
  senses.sight_time 0.25
  senses.sight_decay_time 0.3
  senses.invis_enemy_sight_scalar 2
  senses.max_invis_enemy_sight_dist 256
  senses.fov_angle 140
  senses.forget_non_vis_enemy_time 1.5
  senses.sound_range 640
  senses.sound_time 0.4
  senses.sound_decay_time 2.5
  senses.sound_persist_time 0.4
  weapons.decay_time 2
  weapons.fov_angle 40
  weapons.sight_time 0.2
}
`;

const BOTS_CHARACTERS_TXT = `
{
  fun_name Grunt
  name grunt
  shirt_color 4
  pants_color 11
}
{
  fun_name Ogre
  name ogre
  shirt_color 2
  pants_color 6
}
`;

const BOTS_MAPDB_TEXT = JSON.stringify({
  episodes: [{ dir: "id1", name: "$m_quake" }],
  maps: [
    { title: "Place of Two Deaths", bsp: "dm1", episode: "id1", game: "id1", dm: true, bots: true },
    { title: "The Cistern", bsp: "dm5", episode: "id1", game: "id1", dm: true, bots: false },
  ],
});

describe("Bots page model", () => {
  const botsRoot = mkdtempSync(join(scratchRoot, "menu-bots-model-"));
  const plainRoot = mkdtempSync(join(scratchRoot, "menu-bots-none-"));

  mkdirSync(join(botsRoot, "id1", "bots"), { recursive: true });
  writeFileSync(join(botsRoot, "id1", "bots", "weapons.txt"), BOTS_WEAPONS_TXT);
  writeFileSync(join(botsRoot, "id1", "bots", "settings_PC.txt"), BOTS_SETTINGS_TXT);
  writeFileSync(join(botsRoot, "id1", "bots", "characters.txt"), BOTS_CHARACTERS_TXT);
  writeFileSync(join(botsRoot, "id1", "mapdb.json"), BOTS_MAPDB_TEXT);
  mkdirSync(join(plainRoot, "id1"), { recursive: true });

  afterAll(() => {
    rmSync(botsRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
  });

  test("no bots/ data mounted -> BotsMenuAvailable false, model.available false, no roster", () => {
    setComSearchpaths(null);
    COM_InitArgv(["q1ts", "-basedir", plainRoot, "-nohomedir"]);
    COM_InitFilesystem();
    Bot_ForgetKnowledge();
    Bot_ForgetMapdb();

    expect(BotsMenuAvailable()).toBe(false);
    const model = BuildBotsPageModel("dm1");
    expect(model.available).toBe(false);
    expect(model.roster).toEqual([]);
    expect(model.mapAllowsBots).toBe(false);
    expect(BotsPageEnabled(model)).toBe(false);
    expect(AvailableBotSkillNames()).toEqual(BOT_SKILL_NAMES);
  });

  test("bots/ data mounted -> available true, roster from characters.txt, skill names from settings_PC.txt", () => {
    setComSearchpaths(null);
    COM_InitArgv(["q1ts", "-basedir", botsRoot, "-nohomedir"]);
    COM_InitFilesystem();
    Bot_ForgetKnowledge();
    Bot_ForgetMapdb();

    expect(BotsMenuAvailable()).toBe(true);
    expect(AvailableBotSkillNames()).toEqual(["easy", "medium"]);

    const model = BuildBotsPageModel("dm1");
    expect(model.available).toBe(true);
    expect(model.roster.map((r) => ({ characterName: r.characterName, funName: r.funName, active: r.active }))).toEqual([
      { characterName: "grunt", funName: "Grunt", active: false },
      { characterName: "ogre", funName: "Ogre", active: false },
    ]);
  });

  test("mapAllowsBots reflects mapdb.json's own per-map bots flag", () => {
    setComSearchpaths(null);
    COM_InitArgv(["q1ts", "-basedir", botsRoot, "-nohomedir"]);
    COM_InitFilesystem();
    Bot_ForgetKnowledge();
    Bot_ForgetMapdb();

    const allowed = BuildBotsPageModel("dm1"); // bots: true
    expect(allowed.mapAllowsBots).toBe(true);
    expect(BotsPageEnabled(allowed)).toBe(true);

    const notAllowed = BuildBotsPageModel("dm5"); // bots: false
    expect(notAllowed.mapAllowsBots).toBe(false);
    expect(BotsPageEnabled(notAllowed)).toBe(false);

    const unknownMap = BuildBotsPageModel("e1m1"); // not in mapdb.json at all
    expect(unknownMap.mapAllowsBots).toBe(false);
  });

  test("count/skillIndex reflect the bot_count/bot_skill cvars", () => {
    setComSearchpaths(null);
    COM_InitArgv(["q1ts", "-basedir", botsRoot, "-nohomedir"]);
    COM_InitFilesystem();
    Bot_ForgetKnowledge();
    Bot_ForgetMapdb();

    Cvar_SetValue("bot_count", 3);
    Cvar_Set("bot_skill", "easy");
    const model = BuildBotsPageModel("dm1");
    expect(model.count).toBe(3);
    expect(model.skillNames[model.skillIndex]).toBe("easy");
  });
});

//=============================================================================
// U40: the addbot/kickbot/addbot-random command-line builders (pure).

describe("BotAddCommand / BotKickCommand / BotAddRandomCommand", () => {
  test("quotes both the character name and the skill name", () => {
    expect(BotAddCommand("grunt", "hard")).toBe('addbot "grunt" "hard"\n');
    expect(BotKickCommand("Grunt")).toBe('kickbot "Grunt"\n');
    expect(BotAddRandomCommand("medium")).toBe('addbot random "medium"\n');
  });
});
