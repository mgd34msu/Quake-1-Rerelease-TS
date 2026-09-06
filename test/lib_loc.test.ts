// Tests for src/lib/loc.ts (lifted from quake-2-re-ts src/qcommon/loc.ts at
// 7e88015, itself a port of the 2023 Quake II re-release's loc.c/loc.h).
// See loc.ts's own header comment for the full decoupling writeup: Cvar_Get/
// FS_LoadFile/Com_Printf are gone, replaced by a `bytes: Uint8Array | null`
// parameter and an optional LibLog callback, and the loc-file grammar gains
// an optional platform filter for `key <ps4 ps5 switch> = "..."` lines
// (this project's own Quake 1 re-release loc files use that syntax for
// real, unlike quake-2-re-ts's own retail data).
//
// Two groups, same split as quake-2-re-ts's own test/loc.test.ts:
//
// 1. Tests that need no loc file at all -- Loc_Localize's "in-place"
//    localization type, argument substitution/reordering, and the various
//    documented fallback paths -- adapted 1:1 from quake-2-re-ts's own
//    vectors (this half of Loc_Localize is pure and untouched by the
//    decoupling).
//
// 2. Loc_ReloadFile tests exercising the new bytes-in / LibLog-out API
//    directly (no FS_InitFilesystem, no cvar -- this module doesn't have
//    either any more), plus the new platform-filter behavior, plus a
//    guarded end-to-end test against the REAL Quake 1 re-release
//    localization/loc_english.txt (extracted from
//    .../rerelease/id1/pak0.pak with a tiny inline PACK reader -- see
//    test/support/fixture_availability.ts's own header for why a guarded
//    skip beats a beforeAll throw bun can't skip around; game data is
//    never committed to this repo).

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  Loc_Localize,
  Loc_ReloadFile,
  Loc_MergeFile,
  Loc_LoadOrdered,
  Loc_LanguageFromLocale,
  Loc_Unload,
  Loc_TableSize,
  LOC_KNOWN_LANGUAGES,
  type LocReloadOptions,
  type LocLoadTier,
} from "../src/lib/loc";
import type { LibLog } from "../src/lib/errors";

// ---------------------------------------------------------------------------
// Section 1: Loc_Localize, no loc file needed
// ---------------------------------------------------------------------------

describe("loc.ts -- in-place localization (no file needed)", () => {
  test("in-place localization type: {0} substitution on a raw string", () => {
    expect(Loc_Localize("Score: {0}", true, ["100"], 1)).toBe("Score: 100");
  });

  test("allow_in_place=false skips in-place substitution entirely", () => {
    expect(Loc_Localize("Score: {0}", false, ["100"], 1)).toBe("Score: {0}");
  });

  test("allow_in_place=true with no arguments and no $ prefix returns base unchanged", () => {
    expect(Loc_Localize("Just plain text", true, [], 0)).toBe("Just plain text");
  });

  test("an empty-string argument is valid, not treated as a missing/invalid argument", () => {
    expect(Loc_Localize("Value: [{0}]", true, [""], 1)).toBe("Value: []");
  });

  test("positional argument reordering: {1} appears before {0} in the format", () => {
    expect(Loc_Localize("{1} then {0}", true, ["first", "second"], 2)).toBe("second then first");
  });

  test("sequential ({} {}) arguments assign 0, 1, 2, ... in encounter order", () => {
    expect(Loc_Localize("A is {} and B is {}", true, ["X", "Y"], 2)).toBe("A is X and B is Y");
  });

  test("mixing positional and sequential args is a parse error; falls back to the raw base string", () => {
    const warnings: string[] = [];
    const log: LibLog = { warn: (m) => warnings.push(m) };
    expect(Loc_Localize("{0} and {}", true, ["a", "b"], 2, undefined, log)).toBe("{0} and {}");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("in-place localization");
  });

  test("too few arguments supplied falls back to the base string", () => {
    expect(Loc_Localize("{0} and {1}", true, ["only-one"], 1)).toBe("{0} and {1}");
  });

  test("a substituted argument is itself recursively localized (allow_in_place=false)", () => {
    expect(Loc_Localize("Hi, {0}!", true, ["$missing"], 1)).toBe("Hi, missing!");
  });

  test("output_length truncates the result (Q_strlcpy semantics)", () => {
    expect(Loc_Localize("Hello, World!", false, null, 0, 6)).toBe("Hello");
  });

  test("log is optional -- omitting it is silent, not a throw", () => {
    expect(() => Loc_Localize("{0} and {}", true, ["a", "b"], 2)).not.toThrow();
  });
});

describe("loc.ts -- table lookup (no file loaded: empty table)", () => {
  test("a table lookup miss returns the key WITHOUT its leading '$' (allow_in_place=false)", () => {
    Loc_Unload();
    expect(Loc_Localize("$nonexistent_key", false, [], 0)).toBe("nonexistent_key");
  });

  test("a table lookup miss returns the key WITHOUT its leading '$' (allow_in_place=true)", () => {
    Loc_Unload();
    expect(Loc_Localize("$nonexistent_key", true, [], 0)).toBe("nonexistent_key");
  });
});

// ---------------------------------------------------------------------------
// Section 2: Loc_ReloadFile -- bytes in, LibLog out (no FS, no cvar)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

describe("loc.ts -- Loc_ReloadFile (bytes-in API, no filesystem)", () => {
  test("bytes === null clears the table and loads zero strings, no warning", () => {
    Loc_Unload();
    const warnings: string[] = [];
    const count = Loc_ReloadFile(null, { log: { warn: (m) => warnings.push(m) } });
    expect(count).toBe(0);
    expect(warnings).toEqual([]);
    expect(Loc_Localize("$anything", true, [], 0)).toBe("anything");
  });

  test("a well-formed loc file loads its keys, queryable via $-prefixed lookup", () => {
    Loc_Unload();
    const locFile = [`g_greeting = "Hello, {0}!"`, `g_two_args = "{1} met {0}"`, `g_name = "Bob"`, ``].join("\n");
    const count = Loc_ReloadFile(enc.encode(locFile));
    expect(count).toBe(3);
    expect(Loc_Localize("$g_greeting", true, ["World"], 1)).toBe("Hello, World!");
    expect(Loc_Localize("$g_two_args", true, ["World", "Hello"], 2)).toBe("Hello met World");
  });

  test("a recursively-localized argument resolves through the loaded table", () => {
    Loc_Unload();
    const locFile = [`g_name = "Bob"`, `g_hello = "Hi, {0}!"`, ``].join("\n");
    Loc_ReloadFile(enc.encode(locFile));
    expect(Loc_Localize("$g_hello", true, ["$g_name"], 1)).toBe("Hi, Bob!");
  });

  test("a malformed entry is skipped (warned, not fatal), the rest of the file still loads", () => {
    Loc_Unload();
    const locFile = [`g_bad_mixed = "{0} and {}"`, `g_after_bad = "still parses"`, ``].join("\n");
    const warnings: string[] = [];
    const count = Loc_ReloadFile(enc.encode(locFile), { log: { warn: (m) => warnings.push(m) } });
    expect(count).toBe(1); // only g_after_bad
    expect(Loc_Localize("$g_bad_mixed", true, [], 0)).toBe("g_bad_mixed"); // never stored -> miss
    expect(Loc_Localize("$g_after_bad", true, [], 0)).toBe("still parses");
    expect(warnings.some((w) => w.includes("g_bad_mixed"))).toBe(true);
  });

  test("info callback reports the loaded string count", () => {
    Loc_Unload();
    const infos: string[] = [];
    const locFile = [`a = "1"`, `b = "2"`, ``].join("\n");
    Loc_ReloadFile(enc.encode(locFile), { log: { warn: () => undefined, info: (m) => infos.push(m) } });
    expect(infos).toEqual(["Loaded 2 localization strings"]);
  });

  test("Loc_Unload clears a previously loaded table (standing order 13: this test restores the singleton itself)", () => {
    Loc_ReloadFile(enc.encode(`x = "y"`));
    expect(Loc_Localize("$x", true, [], 0)).toBe("y");
    Loc_Unload();
    expect(Loc_Localize("$x", true, [], 0)).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// U30: Loc_MergeFile -- adds to/overwrites the table instead of clearing it,
// for the re-release's `loc_<lang>_mod.txt` overlay convention.
// ---------------------------------------------------------------------------

describe("loc.ts -- Loc_MergeFile (add/override without clearing)", () => {
  test("merging into an empty table adds every key, same as a fresh Loc_ReloadFile", () => {
    Loc_Unload();
    const count = Loc_MergeFile(enc.encode(`a = "1"`));
    expect(count).toBe(1);
    expect(Loc_Localize("$a", true, [], 0)).toBe("1");
  });

  test("does not clear existing keys the way Loc_ReloadFile does", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(`base_only = "kept"`));
    const count = Loc_MergeFile(enc.encode(`extra = "added"`));
    expect(count).toBe(1);
    expect(Loc_Localize("$base_only", true, [], 0)).toBe("kept");
    expect(Loc_Localize("$extra", true, [], 0)).toBe("added");
  });

  test("overwrites a key an earlier Loc_ReloadFile already set", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(`greeting = "Hello"`));
    Loc_MergeFile(enc.encode(`greeting = "Bonjour"`));
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("Bonjour");
  });

  test("bytes === null is a no-op, returns 0, leaves the table untouched", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(`x = "y"`));
    const count = Loc_MergeFile(null);
    expect(count).toBe(0);
    expect(Loc_Localize("$x", true, [], 0)).toBe("y");
  });

  test("first occurrence within the merged file wins, same convention as Loc_ReloadFile", () => {
    Loc_Unload();
    const count = Loc_MergeFile(enc.encode([`dup = "first"`, `dup = "second"`, ``].join("\n")));
    expect(count).toBe(1);
    expect(Loc_Localize("$dup", true, [], 0)).toBe("first");
  });

  test("a later Loc_MergeFile call overwrites a key an earlier merge call set (last CALL wins, not last line)", () => {
    Loc_Unload();
    Loc_MergeFile(enc.encode(`k = "tier1"`));
    Loc_MergeFile(enc.encode(`k = "tier2"`));
    expect(Loc_Localize("$k", true, [], 0)).toBe("tier2");
  });

  test("info callback reports the merged count under its own wording", () => {
    Loc_Unload();
    const infos: string[] = [];
    Loc_MergeFile(enc.encode(`a = "1"`), { log: { warn: () => undefined, info: (m) => infos.push(m) } });
    expect(infos).toEqual(["Merged 1 localization strings"]);
  });

  test("a malformed entry is skipped (warned, not fatal), the rest of the merged file still loads", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(`base = "kept"`));
    const warnings: string[] = [];
    const locFile = [`bad_mixed = "{0} and {}"`, `after_bad = "still parses"`, ``].join("\n");
    const count = Loc_MergeFile(enc.encode(locFile), { log: { warn: (m) => warnings.push(m) } });
    expect(count).toBe(1); // only after_bad
    expect(Loc_Localize("$base", true, [], 0)).toBe("kept");
    expect(Loc_Localize("$after_bad", true, [], 0)).toBe("still parses");
    expect(warnings.some((w) => w.includes("bad_mixed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U30: Loc_LoadOrdered -- base file + `_mod.txt` overlays lowest-to-highest
// priority, falling back to a WHOLE different tier when the primary base
// file is missing (Ironwail's own LOC_Load: a tier swap, not a per-key
// merge across languages).
// ---------------------------------------------------------------------------

describe("loc.ts -- Loc_LoadOrdered (base + mods, low-to-high, whole-tier fallback)", () => {
  const emptyTier: LocLoadTier = { base: null, mods: [] };

  test("base file alone, no mods", () => {
    Loc_Unload();
    const count = Loc_LoadOrdered({ base: enc.encode(`a = "1"`), mods: [] }, emptyTier);
    expect(count).toBe(1);
    expect(Loc_Localize("$a", true, [], 0)).toBe("1");
  });

  test("mods apply low to high priority: the LAST array entry wins a key shared with an earlier one", () => {
    Loc_Unload();
    const base = enc.encode(`greeting = "base"`);
    const low = enc.encode(`greeting = "low-mod"`);
    const high = enc.encode(`greeting = "high-mod"`);
    const count = Loc_LoadOrdered({ base, mods: [low, high] }, emptyTier);
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("high-mod");
  });

  test("a mod file adds a key the base file never had (the real retail placeholder_mod shape)", () => {
    Loc_Unload();
    const base = enc.encode(`a = "1"`);
    const mod = enc.encode(`placeholder_mod = "overwrite me"`);
    const count = Loc_LoadOrdered({ base, mods: [mod] }, emptyTier);
    expect(count).toBe(2);
    expect(Loc_Localize("$placeholder_mod", true, [], 0)).toBe("overwrite me");
  });

  test("primary base missing falls back to the WHOLE fallback tier, including its own mods -- the primary tier's own mods are never applied", () => {
    Loc_Unload();
    const fallbackBase = enc.encode(`only_in_fallback = "fb"`);
    const fallbackMod = enc.encode(`fb_mod_key = "fbmod"`);
    const primaryMod = enc.encode(`never_applied = "nope"`);
    const count = Loc_LoadOrdered({ base: null, mods: [primaryMod] }, { base: fallbackBase, mods: [fallbackMod] });
    expect(count).toBe(2);
    expect(Loc_Localize("$only_in_fallback", true, [], 0)).toBe("fb");
    expect(Loc_Localize("$fb_mod_key", true, [], 0)).toBe("fbmod");
    expect(Loc_Localize("$never_applied", true, [], 0)).toBe("never_applied"); // never loaded -- a miss
  });

  test("clears whatever was loaded before, same as a single Loc_ReloadFile", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(`stale = "leftover"`));
    Loc_LoadOrdered({ base: enc.encode(`fresh = "new"`), mods: [] }, emptyTier);
    expect(Loc_Localize("$stale", true, [], 0)).toBe("stale"); // gone -- table was cleared
    expect(Loc_Localize("$fresh", true, [], 0)).toBe("new");
  });

  test("both tiers empty (no base anywhere) loads nothing, warns nothing", () => {
    Loc_Unload();
    const count = Loc_LoadOrdered(emptyTier, emptyTier);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U30: Loc_LanguageFromLocale -- the pure locale-tag -> one-of-six-names
// mapper behind `language auto`.
// ---------------------------------------------------------------------------

describe("loc.ts -- Loc_LanguageFromLocale (`language auto`'s pure mapper)", () => {
  test.each([
    ["en", "english"],
    ["en_US", "english"],
    ["en-GB", "english"],
    ["EN", "english"],
    ["fr", "french"],
    ["fr_FR", "french"],
    ["de", "german"],
    ["de-DE", "german"],
    ["it", "italian"],
    ["it_IT.UTF-8", "italian"],
    ["ru", "russian"],
    ["ru_RU", "russian"],
    ["es", "spanish"],
    ["es_MX", "spanish"],
    ["pt_BR", "english"], // an unlisted language falls back to english
    ["zh_CN", "english"],
    ["", "english"],
  ] as const)("Loc_LanguageFromLocale(%p) === %p", (tag, expected) => {
    expect(Loc_LanguageFromLocale(tag)).toBe(expected);
  });

  test("null/undefined both fall back to english", () => {
    expect(Loc_LanguageFromLocale(null)).toBe("english");
    expect(Loc_LanguageFromLocale(undefined)).toBe("english");
  });

  test("LOC_KNOWN_LANGUAGES lists exactly the six names the retail data ships", () => {
    expect([...LOC_KNOWN_LANGUAGES].sort()).toEqual(["english", "french", "german", "italian", "russian", "spanish"].sort());
  });
});

// ---------------------------------------------------------------------------
// '=' adjacency (coordinator ruling on the mg3_hub_rune3_hint finding): a
// key never contains '=', so '=' always terminates a key token even with
// no separating whitespace on either side. All four spellings below must
// tokenize identically to `key`, `=`, `format`.
// ---------------------------------------------------------------------------

describe("loc.ts -- '=' terminates a key token with no separating whitespace required", () => {
  test("key =\"value\" (space before '=', none after) -- the real file's own mg3_hub_rune3_hint shape", () => {
    Loc_Unload();
    const count = Loc_ReloadFile(enc.encode(`greeting ="Hello"`));
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("Hello");
  });

  test("key= \"value\" (none before '=', space after)", () => {
    Loc_Unload();
    const count = Loc_ReloadFile(enc.encode(`greeting= "Hello"`));
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("Hello");
  });

  test("key=\"value\" (no space on either side)", () => {
    Loc_Unload();
    const count = Loc_ReloadFile(enc.encode(`greeting="Hello"`));
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("Hello");
  });

  test("key = \"value\" (space on both sides -- the baseline spelling, unaffected by the fix)", () => {
    Loc_Unload();
    const count = Loc_ReloadFile(enc.encode(`greeting = "Hello"`));
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("Hello");
  });

  test("all four spellings mixed in one file, plus a trailing key, all parse with zero warnings", () => {
    Loc_Unload();
    const locFile = [`a ="1"`, `b= "2"`, `c="3"`, `d = "4"`, `e = "5"`, ``].join("\n");
    const warnings: string[] = [];
    const count = Loc_ReloadFile(enc.encode(locFile), { log: { warn: (m) => warnings.push(m) } });
    expect(warnings).toEqual([]);
    expect(count).toBe(5);
    expect(Loc_Localize("$a", true, [], 0)).toBe("1");
    expect(Loc_Localize("$b", true, [], 0)).toBe("2");
    expect(Loc_Localize("$c", true, [], 0)).toBe("3");
    expect(Loc_Localize("$d", true, [], 0)).toBe("4");
    expect(Loc_Localize("$e", true, [], 0)).toBe("5");
  });

  test("a platform-tagged line with no space before '=' still parses and is discarded by default, same as a spaced one", () => {
    Loc_Unload();
    const locFile = [`greeting <switch>="Hi Switch"`, `greeting = "Hi"`, ``].join("\n");
    const warnings: string[] = [];
    const count = Loc_ReloadFile(enc.encode(locFile), { log: { warn: (m) => warnings.push(m) } });
    expect(warnings).toEqual([]);
    expect(count).toBe(1);
    expect(Loc_Localize("$greeting", true, [], 0)).toBe("Hi");
  });

  test("a genuinely malformed line (no '=' at all before EOF) still stops the whole file, unaffected by the '=' fix", () => {
    Loc_Unload();
    const locFile = [`good = "1"`, `bad_no_equals "oops"`, `never_reached = "2"`, ``].join("\n");
    const count = Loc_ReloadFile(enc.encode(locFile));
    expect(count).toBe(1); // "good" only -- the syntax error on "bad_no_equals" stops the file
    expect(Loc_Localize("$good", true, [], 0)).toBe("1");
    expect(Loc_Localize("$never_reached", true, [], 0)).toBe("never_reached"); // never loaded
  });
});

// ---------------------------------------------------------------------------
// Platform-tagged lines (`key <ps4 ps5 switch> = "..."`) -- the Quake 1
// re-release loc file's own per-platform variant syntax. See loc.ts's
// header comment: default (no platform filter) matches q2repro exactly
// (every platform-tagged line is discarded, unconditional line wins);
// giving a platform filter is this project's own addition.
// ---------------------------------------------------------------------------

describe("loc.ts -- platform-tagged lines (`key <plat...> = \"...\"`)", () => {
  const locFile = [
    `m_gamepad_restricted = "Controller Only"`,
    `m_gamepad_restricted <ps4 ps5 switch> = "Controller Only (PS)"`,
    `m_gamepad_restricted <xboxone xboxseries winstore> = "Controller Only (Xbox)"`,
    // platform tag appearing BEFORE the unconditional line for the same
    // key -- real loc_english.txt does this (m_vibration), and the
    // unconditional line must still win when no filter is given regardless
    // of which line came first in the file.
    `m_vibration <switch> = "Vibration Feature"`,
    `m_vibration = "Vibration"`,
    ``,
  ].join("\n");

  test("default (no platform filter): every platform-tagged line is ignored, the unconditional line always wins", () => {
    Loc_Unload();
    const count = Loc_ReloadFile(enc.encode(locFile));
    expect(count).toBe(2); // m_gamepad_restricted, m_vibration -- unconditional lines only
    expect(Loc_Localize("$m_gamepad_restricted", true, [], 0)).toBe("Controller Only");
    expect(Loc_Localize("$m_vibration", true, [], 0)).toBe("Vibration");
  });

  test("platform filter matching a tagged line overrides the unconditional value", () => {
    Loc_Unload();
    const opts: LocReloadOptions = { platform: "ps5" };
    Loc_ReloadFile(enc.encode(locFile), opts);
    expect(Loc_Localize("$m_gamepad_restricted", true, [], 0)).toBe("Controller Only (PS)");
    // m_vibration has no <ps5> variant -- unmatched key still falls back to
    // its unconditional line, not dropped.
    expect(Loc_Localize("$m_vibration", true, [], 0)).toBe("Vibration");
  });

  test("platform filter matching a tagged line that comes BEFORE the unconditional line still overrides it", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(locFile), { platform: "switch" });
    expect(Loc_Localize("$m_vibration", true, [], 0)).toBe("Vibration Feature");
    expect(Loc_Localize("$m_gamepad_restricted", true, [], 0)).toBe("Controller Only (PS)");
  });

  test("platform filter is case-insensitive", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(locFile), { platform: "PS5" });
    expect(Loc_Localize("$m_gamepad_restricted", true, [], 0)).toBe("Controller Only (PS)");
  });

  test("a platform filter matching nothing in the file behaves like the default (unconditional lines only)", () => {
    Loc_Unload();
    Loc_ReloadFile(enc.encode(locFile), { platform: "stadia" });
    expect(Loc_Localize("$m_gamepad_restricted", true, [], 0)).toBe("Controller Only");
    expect(Loc_Localize("$m_vibration", true, [], 0)).toBe("Vibration");
  });

  test("parsing continues correctly after a platform-tagged line, whether or not the filter matches", () => {
    Loc_Unload();
    const withTail = locFile + `g_after_tag = "still parses after every platform-spec line"\n`;
    Loc_ReloadFile(enc.encode(withTail), { platform: "xboxone" });
    expect(Loc_Localize("$g_after_tag", true, [], 0)).toBe("still parses after every platform-spec line");
  });
});

// ---------------------------------------------------------------------------
// Guarded end-to-end test: the REAL Quake 1 re-release
// localization/loc_english.txt, extracted from
// .../rerelease/id1/pak0.pak with a tiny inline PACK reader (this file's
// own SCOPE is test/lib_*.test.ts, so this doesn't reach for
// test/support/pak_builder.ts, which only ever builds paks, not reads
// them). Skips itself when the fixture isn't on disk -- mirrors
// test/support/fixture_availability.ts's own existsSync-guard idiom
// rather than a beforeAll throw bun can't skip around. Game data is never
// committed to this repo.
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const RERELEASE_PAK0 = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const HAVE_RERELEASE_PAK0 = existsSync(RERELEASE_PAK0);

const DPACKFILE_NAME_LEN = 56;

/** Reads one named entry out of a PACK-format .pak (WinQuake common.c's
 * dpackheader_t/dpackfile_t: "PACK" + dirofs/dirlen int32, then a
 * directory of 64-byte name[56]+filepos+filelen records) -- just enough of
 * the format to pull one file out for this test, not a full FS_* mount. */
function readPakEntry(pakPath: string, entryName: string): Uint8Array | null {
  const buf = readFileSync(pakPath);
  if (buf.toString("ascii", 0, 4) !== "PACK") return null;
  const dirofs = buf.readInt32LE(4);
  const dirlen = buf.readInt32LE(8);
  const numEntries = dirlen / 64;
  for (let i = 0; i < numEntries; i++) {
    const off = dirofs + i * 64;
    const rawName = buf.toString("ascii", off, off + DPACKFILE_NAME_LEN);
    const name = rawName.slice(0, rawName.indexOf("\0"));
    if (name === entryName) {
      const filepos = buf.readInt32LE(off + DPACKFILE_NAME_LEN);
      const filelen = buf.readInt32LE(off + DPACKFILE_NAME_LEN + 4);
      return new Uint8Array(buf.subarray(filepos, filepos + filelen));
    }
  }
  return null;
}

describe.skipIf(!HAVE_RERELEASE_PAK0)("loc.ts -- real Quake 1 re-release localization/loc_english.txt", () => {
  const bytes = HAVE_RERELEASE_PAK0 ? readPakEntry(RERELEASE_PAK0, "localization/loc_english.txt") : null;

  test("the file is present inside pak0.pak", () => {
    expect(bytes).not.toBeNull();
  });

  // Coordinator ruling: the real game displays the mg3 hub hints, so the
  // closed KEX engine's tokenizer accepts `key ="value"` (and `key= "..."`,
  // `key="..."`) -- '=' always terminates a key token, key/=/value adjacency
  // with no separating whitespace is not a syntax error. src/lib/loc.ts's
  // comParseToken now special-cases '=' (see its own header comment); this
  // test proves EVERY key line in the real file parses under the fixed
  // tokenizer, not just the ones that happen to have a space before '='.
  //
  // "every one of the key lines parses" is checked as an accounting
  // invariant rather than a hardcoded count, so it stays meaningful if the
  // retail file is ever updated: independently regex-count every line
  // shaped like a key declaration (`key`, optional `<platform...>`, `=`)
  // in the raw file, then assert that count equals (the loaded map size) +
  // (the number of platform-tagged lines, which are always discarded by
  // default -- see this file's platform-tag describe block above) -- i.e.
  // every single key line was consumed into one bucket or the other, none
  // silently dropped by a parse failure. Zero warnings pins down the "no
  // parse failures at all" half of that same claim.
  test("every one of the file's key lines parses: loaded-map-size + discarded-platform-tagged-lines == raw key-line count, zero warnings", () => {
    Loc_Unload();
    expect(bytes).not.toBeNull();

    const text = Buffer.from(bytes!).toString("latin1");
    const keyLineRe = /^[A-Za-z0-9_]+\s*(<[^>]*>)?\s*=/;
    let totalKeyLines = 0;
    let platformTaggedLines = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const m = keyLineRe.exec(line);
      if (!m) continue;
      totalKeyLines++;
      if (m[1]) platformTaggedLines++;
    }
    // Sanity-check the regex-count itself isn't degenerate before using it
    // as the expected total below.
    expect(totalKeyLines).toBeGreaterThan(1600);
    expect(platformTaggedLines).toBeGreaterThan(0);

    const warnings: string[] = [];
    const loadedCount = Loc_ReloadFile(bytes!, { log: { warn: (m) => warnings.push(m) } });
    expect(warnings).toEqual([]);
    expect(loadedCount + platformTaggedLines).toBe(totalKeyLines);
  });

  test("mg3_hub_rune3_hint and every mg3 hub-hint key after it now load (the fixed key=\"...\"/key =\"...\" adjacency)", () => {
    Loc_Unload();
    Loc_ReloadFile(bytes!);
    // Real line: `mg3_hub_rune3_hint ="This path leads to\nthe Rune of
    // Sorrow.\n\nseek the Mist of Torment..."` -- no space before the quote.
    expect(Loc_Localize("$mg3_hub_rune3_hint", true, [], 0)).toBe("This path leads to\nthe Rune of Sorrow.\n\nseek the Mist of Torment...");
    // The last key in the file, past all 17 that used to be dropped.
    expect(Loc_Localize("$mg3_qc_newgameplus_item", true, [], 0)).not.toBe("mg3_qc_newgameplus_item");
  });

  test("a handful of real menu keys resolve to their real English text", () => {
    Loc_Unload();
    Loc_ReloadFile(bytes!);
    expect(Loc_Localize("$m_on", true, [], 0)).toBe("On");
    expect(Loc_Localize("$m_off", true, [], 0)).toBe("Off");
    expect(Loc_Localize("$m_single_player", true, [], 0)).toBe("Single Player");
    expect(Loc_Localize("$m_quake", true, [], 0)).toBe("Quake");
  });

  test("a {0}/{1}-argument key from the real file substitutes correctly", () => {
    Loc_Unload();
    Loc_ReloadFile(bytes!);
    // m_searching_estimate = "{0} players ({1} seconds)"
    expect(Loc_Localize("$m_searching_estimate", true, ["4", "30"], 2)).toBe("4 players (30 seconds)");
  });

  test("default (no platform filter): a platform-tagged real key falls back to its unconditional value", () => {
    Loc_Unload();
    Loc_ReloadFile(bytes!);
    // m_gamepad_restricted = "Controller Only", plus <ps4 ps5 switch> and
    // <xboxone xboxseries winstore> tagged variants with the same text in
    // the real file -- this assertion only needs the unconditional line to
    // have won.
    expect(Loc_Localize("$m_gamepad_restricted", true, [], 0)).toBe("Controller Only");
  });

  test("a platform filter selects the real file's platform-tagged override (m_vibration <switch>)", () => {
    Loc_Unload();
    Loc_ReloadFile(bytes!, { platform: "switch" });
    // Real file order: `m_vibration <switch> = "Vibration Feature"` appears
    // BEFORE the unconditional `m_vibration = "Vibration"` -- proves the
    // platform override wins regardless of file order, against genuine
    // retail data, not just the synthetic fixture above.
    expect(Loc_Localize("$m_vibration", true, [], 0)).toBe("Vibration Feature");
  });
});

// ---------------------------------------------------------------------------
// U30 guarded end-to-end: the real loc_<lang>_mod.txt overlay files, and
// every one of the six languages the retail rerelease/id1/pak0.pak actually
// ships (english, french, german, italian, russian, spanish -- verified by
// this unit against the real pak; not the 5-entry table the specific
// Ironwail checkout in this unit's own brief carries).
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_RERELEASE_PAK0)("loc.ts -- real Quake 1 re-release loc_<lang>_mod.txt overlays and all six languages", () => {
  test("english + loc_english_mod.txt merge over the retail pak yields 1636 keys (1635 base + placeholder_mod)", () => {
    Loc_Unload();
    const base = readPakEntry(RERELEASE_PAK0, "localization/loc_english.txt");
    const mod = readPakEntry(RERELEASE_PAK0, "localization/loc_english_mod.txt");
    expect(base).not.toBeNull();
    expect(mod).not.toBeNull();

    const baseCount = Loc_ReloadFile(base);
    expect(baseCount).toBe(1635);
    const mergedCount = Loc_MergeFile(mod);
    expect(mergedCount).toBe(1); // placeholder_mod, the file's only key

    expect(Loc_Localize("$placeholder_mod", true, [], 0)).toBe("Overwrite me in a mod with mod-specific terms!");
    // every base key is still there -- the merge added, it did not clear.
    expect(Loc_Localize("$m_on", true, [], 0)).toBe("On");
  });

  test("Loc_LoadOrdered against the real base + mod file reaches the same 1636-key total in one call", () => {
    Loc_Unload();
    const base = readPakEntry(RERELEASE_PAK0, "localization/loc_english.txt");
    const mod = readPakEntry(RERELEASE_PAK0, "localization/loc_english_mod.txt");
    const count = Loc_LoadOrdered({ base, mods: mod ? [mod] : [] }, { base: null, mods: [] });
    expect(count).toBe(1636);
  });

  test.each([...LOC_KNOWN_LANGUAGES])("localization/loc_%s.txt loads with no warnings and a non-trivial key count", (lang) => {
    Loc_Unload();
    const bytes = readPakEntry(RERELEASE_PAK0, `localization/loc_${lang}.txt`);
    expect(bytes).not.toBeNull();

    const warnings: string[] = [];
    const count = Loc_ReloadFile(bytes!, { log: { warn: (m) => warnings.push(m) } });
    expect(warnings).toEqual([]);
    expect(count).toBeGreaterThan(1000);
  });

  test.each([...LOC_KNOWN_LANGUAGES])("localization/loc_%s_mod.txt is present and merges cleanly", (lang) => {
    Loc_Unload();
    const base = readPakEntry(RERELEASE_PAK0, `localization/loc_${lang}.txt`);
    const mod = readPakEntry(RERELEASE_PAK0, `localization/loc_${lang}_mod.txt`);
    expect(base).not.toBeNull();
    expect(mod).not.toBeNull();

    const baseCount = Loc_ReloadFile(base);
    const warnings: string[] = [];
    const mergedCount = Loc_MergeFile(mod, { log: { warn: (m) => warnings.push(m) } });
    expect(warnings).toEqual([]);
    expect(mergedCount).toBeGreaterThan(0);
    // the merge added to the table, it did not replace it.
    expect(Loc_TableSize()).toBeGreaterThanOrEqual(baseCount);
  });
});
