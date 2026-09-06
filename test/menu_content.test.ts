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

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContentFsSeam, MountedRoots } from "../src/client/menu_content";
import {
  ADDON_DIRS,
  AvailableLanguages,
  BuildContentModel,
  ClassicProgsEligible,
  ClassicProgsPlan,
  Content_PerformLaunch,
  ContentRoot,
  EpisodeAllowsNightmare,
  EPISODE_DIRS,
  LoadContentModel,
  LoadMapdb,
  LoadMenuLocalization,
  LocalizedEpisodeName,
  MountedContentDirs,
  realContentFsSeam,
  ResolveLaunch,
  RULESETS,
} from "../src/client/menu_content";
import { Cbuf_Init } from "../src/common/cmd";
import { Cvar_RegisterVariable, Cvar_VariableValue, Cvar_VariableString } from "../src/common/cvar";
import { COM_InitArgv, COM_InitFilesystem } from "../src/common/common";
import { Loc_ReloadFile, Loc_Unload } from "../src/lib/loc";
import type { Mapdb } from "../src/lib/mapdb";
import { campaign, sv_ruleset } from "../src/progs/ext/ruleset";

Cbuf_Init();

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

const savedSvRulesetString = sv_ruleset.string;
const savedSvRulesetValue = sv_ruleset.value;
const savedCampaignString = campaign.string;
const savedCampaignValue = campaign.value;

afterAll(() => {
  Loc_Unload();
  sv_ruleset.string = savedSvRulesetString;
  sv_ruleset.value = savedSvRulesetValue;
  campaign.string = savedCampaignString;
  campaign.value = savedCampaignValue;
});

//=============================================================================
// A fake ContentFsSeam: no real filesystem access at all.

function fakeSeam(files: Readonly<Record<string, string>>, dirs: readonly string[]): ContentFsSeam {
  const dirSet = new Set(dirs);
  return {
    directoryExists: (path: string) => dirSet.has(path),
    loadTempFile: (path: string) => {
      const text = files[path];
      if (text === undefined) return null;
      // Mirrors COM_LoadFile's trailing NUL (see menu_content.ts's own
      // decodeTempFileText comment) so the trim path is exercised too.
      const bytes = new TextEncoder().encode(text);
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes, 0);
      return padded;
    },
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
  });

  test("loads the current language's loc file through the seam", () => {
    const seam = fakeSeam({ "localization/loc_english.txt": 'm_quake = "Quake"\n' }, []);
    const count = LoadMenuLocalization(seam);
    expect(count).toBeGreaterThan(0);
  });

  test("missing loc file -> 0, table cleared", () => {
    const count = LoadMenuLocalization(fakeSeam({}, []));
    expect(count).toBe(0);
  });
});

//=============================================================================
// Content_PerformLaunch -- cvar side effects (no Cbuf_Execute: exercising the
// queued `game`/`map` commands would need a real mounted gamedir/bsp, which
// is this file's synthetic-model territory, not this unit's -- see
// test/menu.test.ts's own key-navigation extension for an end-to-end check).

describe("Content_PerformLaunch", () => {
  Cvar_RegisterVariable(sv_ruleset); // no-op if already registered (cvar.ts's own guard)
  Cvar_RegisterVariable(campaign);

  test("rerelease plan sets sv_ruleset and latches campaign to the episode number", () => {
    Content_PerformLaunch({ gameArgs: ["hipnotic"], ruleset: "rerelease", map: "hip1m1", skill: 1, campaign: true, campaignNumber: 2 });
    expect(Cvar_VariableString("sv_ruleset")).toBe("rerelease");
    expect(Cvar_VariableValue("campaign")).toBe(2);
  });

  test("classic plan sets sv_ruleset classic and clears campaign", () => {
    Content_PerformLaunch({ gameArgs: ["id1"], ruleset: "classic", map: "e1m1", skill: 0, campaign: false, campaignNumber: 0 });
    expect(Cvar_VariableString("sv_ruleset")).toBe("classic");
    expect(Cvar_VariableValue("campaign")).toBe(0);
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

    COM_InitArgv(["q1ts", "-rerelease", root]);
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
    COM_InitArgv(["q1ts", "-basedir", REAL_Q1_DIR]);
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
