// Tests for src/common/loc_host.ts (U30 addition, no C original): the ONE
// `language` resolver both the server (src/progs/ext/ruleset.ts's
// QEX_LoadLocalization) and a future client-side loc-file loader are meant
// to share, and the search-path composition it depends on
// (src/common/common.ts's COM_LoadAllFiles feeding src/lib/loc.ts's
// Loc_LoadOrdered). Two groups:
//
// 1. Loc_ResolveLanguage with a fake locale probe (Loc_SetLocaleProbeForTest,
//    this module's own test seam): "auto" resolves through the probe and
//    src/lib/loc.ts's Loc_LanguageFromLocale (with caching); a named
//    language forces that name outright and never touches the probe.
//
// 2. The mod-overlay load order end to end, against a synthetic two-pak
//    search path built with test/support/pak_builder.ts: COM_LoadAllFiles
//    pulling a `loc_<lang>_mod.txt` present in both paks out low-to-high
//    priority, and Loc_LoadOrdered applying them so the higher-priority
//    pak's mod wins -- the same composition src/progs/ext/ruleset.ts's own
//    QEX_LoadLocalization performs against the real search path.

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { CvarT, Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } from "../src/common/cvar";
import { COM_InitArgv, COM_InitFilesystem, COM_LoadAllFiles, COM_LoadTempFile, com_searchpaths, setComSearchpaths } from "../src/common/common";
import { Loc_ResolveLanguage, Loc_SetLocaleProbeForTest } from "../src/common/loc_host";
import { Loc_LoadOrdered, Loc_Localize, Loc_Unload, type LocLoadTier } from "../src/lib/loc";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "loc-host-test-"));

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

const enc = new TextEncoder();
function bytes(s: string): Uint8Array {
  return enc.encode(s);
}
function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

// ---------------------------------------------------------------------------
// Standing order 13: this suite is self-sufficient. Nothing has necessarily
// registered a "language" cvar yet when this file runs alone
// (`bun test test/loc_host.test.ts`), so register one if needed, and
// restore whatever value/instance was there (created or pre-existing) when
// done.
// ---------------------------------------------------------------------------

const preexistingLanguageCvar = Cvar_FindVar("language");
const languageCvar = preexistingLanguageCvar ?? new CvarT("language", "auto", true);
if (!preexistingLanguageCvar) Cvar_RegisterVariable(languageCvar);
const savedLanguageString = languageCvar.string;
const savedLanguageValue = languageCvar.value;

afterAll(() => {
  languageCvar.string = savedLanguageString;
  languageCvar.value = savedLanguageValue;
  Loc_SetLocaleProbeForTest(null);
});

// ---------------------------------------------------------------------------
// Section 1: Loc_ResolveLanguage
// ---------------------------------------------------------------------------

describe("loc_host.ts -- Loc_ResolveLanguage", () => {
  afterAll(() => {
    Loc_SetLocaleProbeForTest(null);
  });

  test("a named language forces that name outright, never touching the locale probe", () => {
    let probeCalls = 0;
    Loc_SetLocaleProbeForTest(() => {
      probeCalls++;
      return "fr_FR";
    });
    Cvar_Set("language", "german");
    expect(Loc_ResolveLanguage()).toBe("german");
    expect(probeCalls).toBe(0);
  });

  test('"auto" resolves through the fake probe and Loc_LanguageFromLocale', () => {
    Loc_SetLocaleProbeForTest(() => "fr_FR");
    Cvar_Set("language", "auto");
    expect(Loc_ResolveLanguage()).toBe("french");
  });

  test("an empty (unset) cvar value resolves the same way \"auto\" does", () => {
    Loc_SetLocaleProbeForTest(() => "de-DE");
    Cvar_Set("language", "");
    expect(Loc_ResolveLanguage()).toBe("german");
  });

  test('resolving "auto" twice only probes once -- the answer is cached until the probe changes', () => {
    let probeCalls = 0;
    Loc_SetLocaleProbeForTest(() => {
      probeCalls++;
      return "es";
    });
    Cvar_Set("language", "auto");
    expect(Loc_ResolveLanguage()).toBe("spanish");
    expect(Loc_ResolveLanguage()).toBe("spanish");
    expect(probeCalls).toBe(1);
  });

  test('case is normalized: "AUTO" and a mixed-case forced name both work', () => {
    Loc_SetLocaleProbeForTest(() => "ru");
    Cvar_Set("language", "AUTO");
    expect(Loc_ResolveLanguage()).toBe("russian");
    Cvar_Set("language", "FRENCH");
    expect(Loc_ResolveLanguage()).toBe("french");
  });

  test("swapping the locale probe (Loc_SetLocaleProbeForTest) clears the cached answer", () => {
    Loc_SetLocaleProbeForTest(() => "it");
    Cvar_Set("language", "auto");
    expect(Loc_ResolveLanguage()).toBe("italian");
    Loc_SetLocaleProbeForTest(() => "es");
    expect(Loc_ResolveLanguage()).toBe("spanish");
  });

  test("a locale tag the table doesn't know falls back to english, same as Loc_LanguageFromLocale", () => {
    Loc_SetLocaleProbeForTest(() => "zh_CN");
    Cvar_Set("language", "auto");
    expect(Loc_ResolveLanguage()).toBe("english");
  });
});

// ---------------------------------------------------------------------------
// Section 2: the mod-overlay load order, against a synthetic two-pak search
// path -- the same COM_LoadAllFiles + Loc_LoadOrdered composition
// src/progs/ext/ruleset.ts's QEX_LoadLocalization performs.
// ---------------------------------------------------------------------------

describe("loc_host.ts / COM_LoadAllFiles -- mod overlay through a synthetic two-pak search path", () => {
  const savedSearchpaths = com_searchpaths;

  afterAll(() => {
    setComSearchpaths(savedSearchpaths);
  });

  test("COM_LoadAllFiles finds the mod file mounted in BOTH paks, ordered lowest priority first", () => {
    const lowPak = join(scratchDir, "low.pak");
    const highPak = join(scratchDir, "high.pak");
    writePakToDisk(lowPak, [
      { name: "localization/loc_french.txt", data: bytes(`greeting = "low base"`) },
      { name: "localization/loc_french_mod.txt", data: bytes(`greeting = "low tier"`) },
    ]);
    writePakToDisk(highPak, [{ name: "localization/loc_french_mod.txt", data: bytes(`greeting = "high tier"`) }]);

    // "-path" prepends each entry as it's processed, so the LAST argv entry
    // ends up at the head of com_searchpaths and is searched FIRST -- see
    // test/common.test.ts's own header note on this same behaviour. lowPak
    // first, highPak last, so highPak is the higher-priority (head) node.
    COM_InitArgv(["quake", "-path", lowPak, highPak]);
    COM_InitFilesystem();

    const mods = COM_LoadAllFiles("localization/loc_french_mod.txt");
    expect(mods.length).toBe(2);
    expect(bytesToLatin1(mods[0]!)).toContain("low tier"); // lowest priority first
    expect(bytesToLatin1(mods[1]!)).toContain("high tier"); // highest priority last

    const base = COM_LoadTempFile("localization/loc_french.txt");
    expect(base).not.toBeNull();
    expect(bytesToLatin1(base!)).toContain("low base");
  });

  test("a name with no mod file anywhere on the path returns an empty array, not null or a throw", () => {
    const onlyBase = join(scratchDir, "onlybase.pak");
    writePakToDisk(onlyBase, [{ name: "localization/loc_german.txt", data: bytes(`greeting = "base"`) }]);

    COM_InitArgv(["quake", "-path", onlyBase]);
    COM_InitFilesystem();

    expect(COM_LoadAllFiles("localization/loc_german_mod.txt")).toEqual([]);
  });

  test("Loc_LoadOrdered applies COM_LoadAllFiles's own order, so the higher-priority pak's mod wins", () => {
    const lowPak = join(scratchDir, "low2.pak");
    const highPak = join(scratchDir, "high2.pak");
    writePakToDisk(lowPak, [
      { name: "localization/loc_french.txt", data: bytes(`greeting = "base"`) },
      { name: "localization/loc_french_mod.txt", data: bytes(`greeting = "low tier"`) },
    ]);
    writePakToDisk(highPak, [{ name: "localization/loc_french_mod.txt", data: bytes(`greeting = "high tier"`) }]);

    COM_InitArgv(["quake", "-path", lowPak, highPak]);
    COM_InitFilesystem();

    const tier: LocLoadTier = {
      base: COM_LoadTempFile("localization/loc_french.txt"),
      mods: COM_LoadAllFiles("localization/loc_french_mod.txt"),
    };

    Loc_Unload();
    const count = Loc_LoadOrdered(tier, { base: null, mods: [] });
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("high tier"); // highest priority mod applied last, wins
  });

  test("the fallback tier is used outright when the resolved language's base file is missing from every mounted pak", () => {
    const onlyEnglish = join(scratchDir, "onlyenglish.pak");
    writePakToDisk(onlyEnglish, [
      { name: "localization/loc_english.txt", data: bytes(`greeting = "hello"`) },
      { name: "localization/loc_english_mod.txt", data: bytes(`placeholder_mod = "overwrite me"`) },
    ]);

    COM_InitArgv(["quake", "-path", onlyEnglish]);
    COM_InitFilesystem();

    const primary: LocLoadTier = {
      base: COM_LoadTempFile("localization/loc_klingon.txt"), // never mounted -- null
      mods: COM_LoadAllFiles("localization/loc_klingon_mod.txt"),
    };
    const fallback: LocLoadTier = {
      base: COM_LoadTempFile("localization/loc_english.txt"),
      mods: COM_LoadAllFiles("localization/loc_english_mod.txt"),
    };

    Loc_Unload();
    const count = Loc_LoadOrdered(primary, fallback);
    expect(count).toBe(2);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("hello");
    expect(Loc_Localize("$placeholder_mod", true, [], 0)).toBe("overwrite me");
  });
});
