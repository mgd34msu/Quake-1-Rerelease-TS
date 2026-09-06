// Map x progs sweep -- test/support/sweep_lib.ts owns the design rationale
// (modeled on quake-2-re-ts's parity sweep) and test/support/sweep_driver.ts
// owns the boot recipe. This file is the bun:test surface: a retail-data-
// gated integration suite (test/support/fixture_availability.ts's HAVE_DATA
// pattern -- skips itself loudly with no Q1TS_DATA, rather than throwing
// inside a beforeAll bun cannot skip around) plus a pure unit suite on
// synthetic bytes that always runs, so this file is never fully skipped.
//
// Q1TS_SWEEP_ALL=1 widens the retail-gated suite from classic id1 only to
// every gamedir this harness knows about (id1/hipnotic/rogue plus the seven
// rerelease trees). The residual baseline (test/support/sweep_baseline.json)
// starts empty; the coordinator populates it once a wider run's real
// residuals (BSP2 load failures, re-release ex_* builtin hits -- see
// sweep_lib.ts's header for why those are not fatal today) have been
// reviewed and classified as known, non-fatal noise per map. Until then, any
// record with a console class the baseline does not list for it fails this
// suite with the offending (map, class, example) triple.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAVE_DATA } from "./support/fixture_availability";
import { buildPak } from "./support/pak_builder";
import {
  allConfigs,
  bspVersionFact,
  buildJobs,
  classicId1Configs,
  classifyConsoleLines,
  CONSOLE_CLASS_KEYS,
  isRecordObject,
  isStringArray,
  listBspEntries,
  mapNameFromBspEntry,
  parsePakDirectory,
  runSweep,
  type ConsoleClassKeyT,
  type SweepRecordT,
} from "./support/sweep_lib";

const Q1TS_DATA = process.env.Q1TS_DATA ?? "";
const SWEEP_ALL = process.env.Q1TS_SWEEP_ALL === "1";
const FRAMES = 100;
const DT = 0.05;

const BASELINE_PATH = join(import.meta.dir, "support", "sweep_baseline.json");

/** map/gamedir key ("id1/e1m1") -> console classes (plus "unbound_named_builtins") known and accepted as non-fatal noise for it. */
function loadBaseline(): Readonly<Record<string, readonly string[]>> {
  if (!existsSync(BASELINE_PATH)) return {};
  const raw: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (!isRecordObject(raw)) throw new Error("sweep_baseline.json: root is not an object");
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isStringArray(value)) throw new Error(`sweep_baseline.json: "${key}" is not a string array`);
    out[key] = value;
  }
  return out;
}

describe.skipIf(!HAVE_DATA)("map x progs sweep (retail data required)", () => {
  let records: SweepRecordT[] = [];
  let scratch = "";

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "q1ts-sweep-"));
    const configs = SWEEP_ALL ? allConfigs(Q1TS_DATA) : classicId1Configs(Q1TS_DATA);
    const jobs = buildJobs(configs);
    records = await runSweep(jobs, scratch, { frames: FRAMES, dt: DT, concurrency: 4 });
  }, 600_000);

  afterAll(() => {
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  test("the sweep produced at least one record", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  // A handful of shipped id1/rogue "maps" (b_batt0, b_bh10, ...) are not
  // levels at all -- they are the tiny icon-preview BSPs the status bar
  // renders ammo/armor pickups from, and carry no info_player_start of any
  // kind. Real WinQuake fails to spawn a player on them too (the QuakeC's
  // own PutClientInServer/SelectSpawnPoint calls `error()`, which prints
  // this exact "======SERVER ERROR in SelectSpawnPoint:" banner -- see
  // pr_cmds.c's PF_error/PF_objerror format), so a live player is not a
  // meaningful thing to require of them. This checks the ACTUAL evidence
  // (the map really did hit that error) rather than naming the map, so it
  // does not silently swallow a future map that fails to spawn a player for
  // some other, real reason.
  const hasNoSpawnPoint = (r: SweepRecordT): boolean => r.console.error.some((s) => s.includes("SelectSpawnPoint"));

  test("every map either booted with a live player, or is a spawn-point-free utility BSP (SelectSpawnPoint's own error)", () => {
    const failures = records
      .filter((r) => !(r.ok && r.reached_active && (r.player_entered || hasNoSpawnPoint(r))))
      .map((r) => `${r.gamedir}/${r.map}: ok=${String(r.ok)} reached_active=${String(r.reached_active)} player_entered=${String(r.player_entered)} error=${r.error ?? "(none)"}`);
    expect(failures).toEqual([]);
  });

  test("every non-fatal console class and every unbound-named-builtin hit is explained by the baseline", () => {
    const baseline = loadBaseline();
    const unexplained: string[] = [];

    for (const r of records) {
      const recordKey = `${r.gamedir}/${r.map}`;
      const allowed = new Set(baseline[recordKey] ?? []);

      for (const classKey of CONSOLE_CLASS_KEYS) {
        const hits = r.console[classKey];
        if (hits.length > 0 && !allowed.has(classKey)) {
          unexplained.push(`${recordKey}: unexplained console class "${classKey}" (${hits.length}x), e.g. "${hits[0]}"`);
        }
      }
      if (r.unbound_named_builtins.length > 0 && !allowed.has("unbound_named_builtins")) {
        unexplained.push(`${recordKey}: unexplained unbound_named_builtins (${r.unbound_named_builtins.length}x), e.g. "${r.unbound_named_builtins[0]}"`);
      }
    }

    expect(unexplained).toEqual([]);
  });
});

describe("console classifier and pak enumerator on synthetic bytes (no retail data needed -- this suite is never fully skipped)", () => {
  // classifyConsoleLines reports a context SNIPPET around each match (e.g.
  // "'wobble' is not a field"), not the bare needle -- see sweep_lib.ts's
  // own header for why that context matters for a human (or the baseline)
  // reading the record. `hasSnippet` checks a bucket contains a snippet
  // that itself contains the needle.
  const hasSnippet = (bucket: readonly string[], needle: string): boolean => bucket.some((s) => s.includes(needle));

  test("classifyConsoleLines finds each of the five buckets, with the surrounding context kept", () => {
    const lines = ["loading map...", "No spawn function for:", "EDICT 5:", "classname       func_bob", "'wobble' is not a field", "Host_Error: some fatal thing", "Bad builtin call number", "Parm 0 not a client"];
    const c = classifyConsoleLines(lines);
    expect(hasSnippet(c.no_spawn_function, "No spawn function for:")).toBe(true);
    expect(hasSnippet(c.is_not_a_field, "'wobble' is not a field")).toBe(true);
    expect(hasSnippet(c.error, "Host_Error: some fatal thing")).toBe(true);
    expect(hasSnippet(c.unknown_builtin, "Bad builtin call number")).toBe(true);
    expect(hasSnippet(c.pr_run_error, "Parm 0 not a client")).toBe(true);
  });

  test("classifyConsoleLines reconstructs a message word-wrapped across two scrollback rows", () => {
    // Console word-wrap breaks at a word boundary and drops the separating
    // space (see sweep_lib.ts's own header); joining rows with a single
    // space is what this synthetic split is testing the reconstruction of.
    const lines = ["PF_precache_sound:", "overflow, and then some trailing chatter"];
    const c = classifyConsoleLines(lines);
    expect(hasSnippet(c.pr_run_error, "PF_precache_sound: overflow")).toBe(true);
  });

  test("classifyConsoleLines collects unbound builtin NAMEs (coordinator follow-up)", () => {
    // The unified VM's own trace for a `= #0:name` builtin nothing bound --
    // not silent, per the coordinator's correction: it prints exactly this.
    const c = classifyConsoleLines(['CALL0      ex_bprint unbound builtin "ex_bprint": this progs.dat needs an engine extension this build does not have', "Host_Error: Program error"]);
    expect(c.unbound_builtin).toEqual(["ex_bprint"]);
  });

  test("classifyConsoleLines collects every distinct unbound builtin name, in order, deduped", () => {
    const c = classifyConsoleLines(['unbound builtin "ex_bprint": ...', 'unbound builtin "ex_sprint": ...', 'unbound builtin "ex_bprint": ... (again, same map)']);
    expect(c.unbound_builtin).toEqual(["ex_bprint", "ex_sprint"]);
  });

  test("classifyConsoleLines counts the mg1/mg3 crash texts by their own specific class", () => {
    // Sys_Error's own messages (src/platform/sys.ts writes them to stderr,
    // not the console -- sweep_driver.ts feeds a caught crash's `error`
    // text through this same classifier, see its header) have no
    // "Host_Error:"/"SV_Error:" prefix of their own, so these also double
    // as the generic-fallback-bucket non-contamination check.
    const cases: readonly [ConsoleClassKeyT, string][] = [
      ["precache_model_overflow", "PF_precache_model: overflow"],
      ["ed_alloc_no_free_edicts", "SysError: ED_Alloc: no free edicts"],
      ["mod_numknown_overflow", "SysError: mod_numknown == MAX_MOD_KNOWN"],
      ["texture_not_16_aligned", "SysError: Texture thordetrime is not 16 aligned"],
      ["sz_getspace_overflow", "SysError: SZ_GetSpace: overflow without allowoverflow set"],
      ["bad_surface_extents", "SysError: Bad surface extents"],
    ];
    for (const [key, line] of cases) {
      const c = classifyConsoleLines([line]);
      expect(c[key].length).toBeGreaterThan(0);
      expect(c.error).toEqual([]);
    }
  });

  // "Too many static ent..." and "Too many efrags!" print through
  // Con_Printf's Host_Error path (see host.ts's own "Host_Error: %s\n"),
  // so on a real run they legitimately ALSO match the generic `error`
  // class -- that is more information, not double-counting, since "error"
  // alone would not have said WHICH of Host_Error's many messages fired.
  test("classifyConsoleLines classifies Too many static ents / Too many efrags on top of the generic Host_Error class", () => {
    expect(classifyConsoleLines(["Host_Error: Too many static ents"]).too_many_static_ents.length).toBeGreaterThan(0);
    expect(classifyConsoleLines(["Host_Error: Too many efrags!"]).too_many_efrags.length).toBeGreaterThan(0);
  });

  test("classifyConsoleLines captures a RangeError's own message, not just its name", () => {
    const c = classifyConsoleLines(["RangeError: Range consisting of offset and length are out of bounds"]);
    expect(hasSnippet(c.range_error, "Range consisting of offset and length are out of bounds")).toBe(true);
  });

  test("classifyConsoleLines finds nothing in ordinary console chatter", () => {
    const c = classifyConsoleLines(["Quake -- TypeScript Edition", "map e1m1", "----- Host_Init -----", "Playing registered version."]);
    for (const key of CONSOLE_CLASS_KEYS) expect(c[key]).toEqual([]);
  });

  test("parsePakDirectory + listBspEntries + mapNameFromBspEntry + bspVersionFact round-trip a synthetic PACK", () => {
    const bsp29 = new Uint8Array(16);
    new DataView(bsp29.buffer).setInt32(0, 29, true); // classic BSPVERSION
    const bsp2 = new Uint8Array(16);
    bsp2.set([0x42, 0x53, 0x50, 0x32]); // "BSP2"

    const built = buildPak([
      { name: "maps/e1m1.bsp", data: bsp29 },
      { name: "maps/dopa/start.bsp", data: bsp2 },
      { name: "progs/knight.mdl", data: new Uint8Array(4) },
      { name: "gfx.wad", data: new Uint8Array(4) },
    ]);

    const dir = parsePakDirectory(built.bytes);
    expect(dir.length).toBe(4);

    const bspEntries = listBspEntries(dir);
    expect(bspEntries.map((e) => e.name).slice().sort()).toEqual(["maps/dopa/start.bsp", "maps/e1m1.bsp"]);

    const names = bspEntries.map(mapNameFromBspEntry).slice().sort();
    expect(names).toEqual(["dopa/start", "e1m1"]);

    const e1m1 = bspEntries.find((e) => e.name === "maps/e1m1.bsp");
    if (e1m1 === undefined) throw new Error("test setup: e1m1 entry missing");
    expect(bspVersionFact(built.bytes, e1m1)).toBe("29");

    const dopa = bspEntries.find((e) => e.name === "maps/dopa/start.bsp");
    if (dopa === undefined) throw new Error("test setup: dopa entry missing");
    expect(bspVersionFact(built.bytes, dopa)).toBe("BSP2");
  });

  test("parsePakDirectory returns [] for a non-PACK buffer and for a truncated header", () => {
    expect(parsePakDirectory(new Uint8Array([1, 2, 3, 4]))).toEqual([]);
    expect(parsePakDirectory(new Uint8Array(0))).toEqual([]);
  });

  test("listBspEntries ignores non-map and non-bsp entries, case-insensitively", () => {
    const built = buildPak([
      { name: "maps/E1M2.BSP", data: new Uint8Array(4) },
      { name: "maps/readme.txt", data: new Uint8Array(4) },
      { name: "sound/e1m1.bsp", data: new Uint8Array(4) },
    ]);
    const bspEntries = listBspEntries(parsePakDirectory(built.bytes));
    expect(bspEntries.map((e) => e.name)).toEqual(["maps/E1M2.BSP"]);
  });
});
