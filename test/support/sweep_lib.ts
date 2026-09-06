/*
Map x progs sweep -- shared library.

Modeled on quake-2-re-ts's test/parity_map_sweep.test.ts +
test/support/parity_boot_driver.ts (that project's own header explains the
one-boot-per-process design: both the game module and the engine own
process-wide singletons, so a second boot in the same process is never
clean). This file is the Quake 1 shape of the same idea, adapted for a
single VM instead of two game modules to compare: there is no second
implementation to diff against here, so this harness's job is to boot every
shipped map under its own game directory's progs and record what happened,
not to compare two runs against each other.

WHAT THIS FILE OWNS
--------------------
- Reading the classic id PACK format (12-byte header "PACK" + dir
  offset/len, 64-byte directory entries: 56-byte name + offset + length)
  well enough to enumerate `maps/*.bsp` and peek at a map's raw version
  field without loading it through the engine.
- The gamedir x engine-flags table (id1/hipnotic/rogue and the seven
  rerelease trees), per ARCHITECTURE.md's "Content crossover" section and
  the brief's note that the engine only reads the FIRST `-game` parm.
- The JSON record schema one sweep_driver.ts process writes per (gamedir,
  map) pair, and the console-line classifier both the driver and the unit
  tests use (the driver, at runtime; test/sweep_maps.test.ts's own pure
  unit test, on synthetic strings).
- The parent-side runner: builds the job list, spawns one sweep_driver.ts
  subprocess per job under `timeout 300` (a hung boot must never hang the
  sweep), with a concurrency limit.
- A `bun test/support/sweep_lib.ts` CLI entry point (scripts/sweep.sh's
  actual engine -- a shell script cannot parse a binary PACK directory or
  spawn a typed subprocess pool, so the orchestration and reporting live
  here and the shell script is a thin argument-forwarding wrapper).

WHY THE CLASSIFIER MATCHES ON SUBSTRINGS OVER THE JOINED SCROLLBACK, NOT
PER RAW LINE
-------------------------------------------------------------------------
console.ts's scrollback (`con_text`, read through `conState.con_linewidth`
row by row -- see test/e2e/b_lib.ts's `conLines()`, which this file's
driver reuses) wraps at word boundaries and drops the separating space
during the wrap. A message like "Precache can only be done in spawn
functions" can therefore land split across two scrollback rows depending on
console width. Joining all rows with a single space reconstructs the
original text exactly (wrapping only ever removes a word-boundary space,
never breaks a word), so every substring check below runs against
`lines.join(" ")` instead of each line in isolation.

WHY "unknown builtins" IS A STATIC FACT, NOT A CONSOLE-LINE CLASS
------------------------------------------------------------------
ARCHITECTURE.md's name-bound-builtin design ("after load, every function
with first_statement == 0 && parm_start == 0 && locals == 0 is looked up by
name... Unbound names get a builtin that raises a clear PR_RunError naming
the function") is phase-2 engine work this unit does not implement. Today,
src/progs/pr_exec.ts's OP_CALL* only treats a NEGATIVE first_statement as a
builtin (`if (newf.first_statement < 0)`); a re-release progs function
compiled as `= #0:ex_something` has first_statement exactly 0, which is
neither builtin dispatch nor a real function body -- PR_EnterFunction is
entered at statement 0 of the whole progs, which belongs to some other,
unrelated function. That is undefined behaviour with no fixed console
message to match on (it might run silent nonsense, or eventually trip some
unrelated PR_RunError several calls later). The one thing that IS
deterministic and always available -- because PR_LoadProgs finishes before
SV_SpawnServer ever touches the map file, so it runs even on a boot that
then crashes loading a BSP2 map -- is the static shape ARCHITECTURE.md
names: scan `pr.functions` once after load and report every function
matching that exact bit pattern by name. sweep_driver.ts does this
regardless of whether the run then succeeds, fails, or never calls any of
them, and records it as `unbound_named_builtins`, separately from the
best-effort `unknown_builtin` console-text bucket below (which exists for
the rarer cases -- "Bad builtin call number" for a builtin index that IS
resolved but out of range, and PF_Fixme's own "unimplemented bulitin", sic
-- that DO print a fixed message).
*/

import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

// ===========================================================================
// PACK format
// ===========================================================================

export interface PakDirEntryT {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
}

const PACK_HEADER_SIZE = 12; // "PACK"[4] + dirofs[4] + dirlen[4]
const PACK_DIRENTRY_SIZE = 64; // name[56] + filepos[4] + filelen[4]
const PACK_NAME_LEN = 56;

/** Parses a PACK file's directory. Returns [] for anything that is not a well-formed PACK file. */
export function parsePakDirectory(bytes: Uint8Array): readonly PakDirEntryT[] {
  if (bytes.length < PACK_HEADER_SIZE) return [];
  if (bytes[0] !== 0x50 || bytes[1] !== 0x41 || bytes[2] !== 0x43 || bytes[3] !== 0x4b) return []; // "PACK"

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);
  if (dirofs < 0 || dirlen < 0 || dirofs + dirlen > bytes.length) return [];

  const count = Math.trunc(dirlen / PACK_DIRENTRY_SIZE);
  const out: PakDirEntryT[] = [];
  for (let i = 0; i < count; i++) {
    const o = dirofs + i * PACK_DIRENTRY_SIZE;
    if (o + PACK_DIRENTRY_SIZE > bytes.length) break;

    let nameEnd = o;
    while (nameEnd < o + PACK_NAME_LEN && bytes[nameEnd] !== 0) nameEnd++;
    let name = "";
    for (let j = o; j < nameEnd; j++) name += String.fromCharCode(bytes[j]);

    const offset = view.getInt32(o + PACK_NAME_LEN, true);
    const length = view.getInt32(o + PACK_NAME_LEN + 4, true);
    out.push({ name, offset, length });
  }
  return out;
}

/** `maps/*.bsp` entries, any case. */
export function listBspEntries(entries: readonly PakDirEntryT[]): readonly PakDirEntryT[] {
  return entries.filter((e) => /^maps\/.+\.bsp$/i.test(e.name));
}

/** "maps/e1m1.bsp" -> "e1m1"; "maps/mg1/village.bsp" -> "mg1/village". */
export function mapNameFromBspEntry(entry: PakDirEntryT): string {
  return entry.name.slice(5, -4);
}

/**
 * Reads the raw 4-byte version field at a map entry's own offset inside the
 * pak, without going through the engine's loader at all -- this is what
 * lets the sweep record a BSP2 map's format even on a run where loading it
 * crashes.
 */
export function bspVersionFact(pakBytes: Uint8Array, entry: PakDirEntryT): string {
  if (entry.offset < 0 || entry.offset + 4 > pakBytes.length) return "unknown(short-read)";
  const b0 = pakBytes[entry.offset];
  const b1 = pakBytes[entry.offset + 1];
  const b2 = pakBytes[entry.offset + 2];
  const b3 = pakBytes[entry.offset + 3];
  const fourcc = String.fromCharCode(b0, b1, b2, b3);
  if (fourcc === "BSP2") return "BSP2";
  if (fourcc === "2PSB") return "2PSB";
  const view = new DataView(pakBytes.buffer, pakBytes.byteOffset + entry.offset, 4);
  return String(view.getInt32(0, true));
}

/** Case-insensitive file lookup inside `dir` (id1's shipped pak names are `PAK0.PAK`/`PAK1.PAK`). */
export function resolveCaseInsensitive(dir: string, name: string): string | null {
  const direct = `${dir}/${name}`;
  if (existsSync(direct)) return direct;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const lower = name.toLowerCase();
  const hit = entries.find((f) => f.toLowerCase() === lower);
  return hit !== undefined ? `${dir}/${hit}` : null;
}

// ===========================================================================
// gamedir configuration
// ===========================================================================

export interface GamedirConfigT {
  /** Report label, e.g. "id1", "rerelease/mg1". */
  readonly label: string;
  /** The engine's `-basedir` value. */
  readonly basedir: string;
  /** Directory (relative to basedir) whose own pak0.pak, pak1.pak, ... this config's maps come from. */
  readonly pakSubdir: string;
  /** Extra engine command-line flags, e.g. ["-hipnotic"] or ["-game", "mg1"]. */
  readonly extraArgs: readonly string[];
}

/** Classic id1 only -- test/sweep_maps.test.ts's own default scope. */
export function classicId1Configs(basedir: string): readonly GamedirConfigT[] {
  return [{ label: "id1", basedir, pakSubdir: "id1", extraArgs: [] }];
}

/** Classic id1 + hipnotic + rogue -- scripts/sweep.sh's own default scope. */
export function classicAllConfigs(basedir: string): readonly GamedirConfigT[] {
  return [
    { label: "id1", basedir, pakSubdir: "id1", extraArgs: [] },
    { label: "hipnotic", basedir, pakSubdir: "hipnotic", extraArgs: ["-hipnotic"] },
    { label: "rogue", basedir, pakSubdir: "rogue", extraArgs: ["-rogue"] },
  ];
}

/**
 * The seven rerelease trees, per ARCHITECTURE.md: mounted under
 * `<basedir>/rerelease`, id1/hipnotic/rogue the same way the classic trees
 * are (id1 needs no flag -- it is the engine's default GAMENAME mount --
 * hipnotic/rogue take their classic flags), mg1/mg3/dopa/ctf each need
 * `-game <dir>` since the engine only reads its first `-game` parm.
 */
export function rereleaseConfigs(basedir: string): readonly GamedirConfigT[] {
  const rbase = `${basedir}/rerelease`;
  return [
    { label: "rerelease/id1", basedir: rbase, pakSubdir: "id1", extraArgs: [] },
    { label: "rerelease/hipnotic", basedir: rbase, pakSubdir: "hipnotic", extraArgs: ["-hipnotic"] },
    { label: "rerelease/rogue", basedir: rbase, pakSubdir: "rogue", extraArgs: ["-rogue"] },
    { label: "rerelease/mg1", basedir: rbase, pakSubdir: "mg1", extraArgs: ["-game", "mg1"] },
    { label: "rerelease/mg3", basedir: rbase, pakSubdir: "mg3", extraArgs: ["-game", "mg3"] },
    { label: "rerelease/dopa", basedir: rbase, pakSubdir: "dopa", extraArgs: ["-game", "dopa"] },
    { label: "rerelease/ctf", basedir: rbase, pakSubdir: "ctf", extraArgs: ["-game", "ctf"] },
  ];
}

/** Every gamedir this sweep knows about -- Q1TS_SWEEP_ALL's scope, both in the test file and in scripts/sweep.sh. */
export function allConfigs(basedir: string): readonly GamedirConfigT[] {
  return [...classicAllConfigs(basedir), ...rereleaseConfigs(basedir)];
}

export interface MapFactsT {
  readonly map: string;
  readonly bspVersion: string;
}

/**
 * Every `maps/*.bsp` this gamedir's own pak0.pak, pak1.pak, ... define,
 * later paks overriding earlier ones by name -- the same order
 * COM_AddGameDirectory loads them in and the same override direction
 * (com_searchpaths pushes each new pak to the head of the search list).
 */
export function enumerateGamedirMaps(cfg: GamedirConfigT): readonly MapFactsT[] {
  const dir = resolveCaseInsensitive(cfg.basedir, cfg.pakSubdir) ?? `${cfg.basedir}/${cfg.pakSubdir}`;
  const byName = new Map<string, MapFactsT>();
  for (let i = 0; ; i++) {
    const pakPath = resolveCaseInsensitive(dir, `pak${i}.pak`);
    if (pakPath === null) break;
    const bytes = new Uint8Array(readFileSync(pakPath));
    const entries = parsePakDirectory(bytes);
    for (const e of listBspEntries(entries)) {
      const name = mapNameFromBspEntry(e);
      byName.set(name, { map: name, bspVersion: bspVersionFact(bytes, e) });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.map.localeCompare(b.map));
}

// ===========================================================================
// console-line classification
// ===========================================================================

export type ConsoleClassKeyT =
  | "error"
  | "is_not_a_field"
  | "no_spawn_function"
  | "pr_run_error"
  | "unknown_builtin"
  // Added on coordinator follow-up (2026-09-06): the unified VM's own
  // "unbound builtin" trace, and the specific mg1/mg3 crash texts split out
  // of the generic error/crash buckets so they are counted by kind.
  | "unbound_builtin"
  | "too_many_static_ents"
  | "precache_model_overflow"
  | "ed_alloc_no_free_edicts"
  | "too_many_efrags"
  | "mod_numknown_overflow"
  | "texture_not_16_aligned"
  | "sz_getspace_overflow"
  | "bad_surface_extents"
  | "range_error";

export const CONSOLE_CLASS_KEYS: readonly ConsoleClassKeyT[] = [
  "error",
  "is_not_a_field",
  "no_spawn_function",
  "pr_run_error",
  "unknown_builtin",
  "unbound_builtin",
  "too_many_static_ents",
  "precache_model_overflow",
  "ed_alloc_no_free_edicts",
  "too_many_efrags",
  "mod_numknown_overflow",
  "texture_not_16_aligned",
  "sz_getspace_overflow",
  "bad_surface_extents",
  "range_error",
];

// PF_Fixme's own message ("unimplemented bulitin", sic -- the C's own typo,
// see src/progs/pr_cmds.ts) and PR_ExecuteProgram's out-of-range builtin
// index both name a builtin the running progs asked for and the engine has
// no real implementation of. Distinct from `unbound_builtin` below: this
// unified-VM message names an engine EXTENSION the build lacks (a
// `= #0:name` function that was never bound), reported by name via its own
// regex, not a substring list.
const UNKNOWN_BUILTIN_SUBSTRINGS: readonly string[] = ["Bad builtin call number", "unimplemented bulitin"];

/**
 * Coordinator follow-up (2026-09-06): with the unified VM, calling an
 * unbound `#0:name` builtin ends in a PR trace whose message names the
 * builtin: `unbound builtin "ex_bprint": this progs.dat needs an engine
 * extension this build does not have`. This is what a re-release map that
 * only fails on an `ex_*` call actually prints -- there is nothing "silent"
 * about it once this pattern is matched. The names collected here should
 * agree with `unbound_named_builtins` (sweep_driver.ts's static scan of
 * pr.functions for ARCHITECTURE.md's exact name-bound-builtin bit pattern):
 * that field is what the progs COULD hit; this one is what it ACTUALLY hit
 * on this run's frame budget.
 */
const UNBOUND_BUILTIN_RE = /unbound builtin "([^"]+)"/g;

// Every other PR_RunError(...) message string in src/progs/pr_cmds.ts and
// src/progs/pr_exec.ts (grepped directly from both files for this unit).
// PF_precache_model's overflow message moved out to its own class below
// (coordinator follow-up) so mg1/mg3's precache-overflow hits are counted
// by kind instead of lumped in here.
const PR_RUN_ERROR_SUBSTRINGS: readonly string[] = [
  "backwards mins/maxs",
  "no precache:",
  "Parm 0 not a client",
  "Bad string",
  "Precache can only be done in spawn functions",
  "PF_precache_sound: overflow",
  "WriteDest: not a client",
  "WriteDest: bad destination",
  "Entity is not a client",
  "locals stack overflow",
  "locals stack underflow",
  "stack overflow",
  "runaway loop error",
  "assignment to world entity",
  "NULL function",
  "Bad opcode",
];

// Con_Printf call sites elsewhere in the tree whose message contains
// "Error" (grepped across src/ for this unit).
const ERROR_SUBSTRINGS: readonly string[] = ["Host_Error:", "SV_Error:", "Read error"];

/**
 * Coordinator follow-up (2026-09-06): the specific mg1/mg3 crash texts this
 * run observed, split into their own classes (each a one-entry substring
 * list, matching this file's single addSnippets shape) rather than left
 * lumped under the generic "error"/"crash:" buckets. Each is a real message
 * from the tree: "Too many static ent..." and "PF_precache_model: overflow"
 * print via Con_Printf before the connection drops; "ED_Alloc: no free
 * edicts", "mod_numknown == MAX_MOD_KNOWN", "... is not 16 aligned",
 * "SZ_GetSpace: overflow..." and "Bad surface extents" are Sys_Error
 * messages (src/platform/sys.ts writes them to stderr, not the console, and
 * throws `SysError` -- sweep_driver.ts feeds the caught error's own message
 * into this same classifier alongside the console scrollback, see its
 * header); "RangeError" is a native JS exception surfacing a Uint8Array/
 * DataView bounds bug rather than a modeled engine error path.
 */
const SINGLE_SUBSTRING_CLASSES: ReadonlyArray<readonly [ConsoleClassKeyT, string]> = [
  ["too_many_static_ents", "Too many static ent"],
  ["precache_model_overflow", "PF_precache_model: overflow"],
  ["ed_alloc_no_free_edicts", "ED_Alloc: no free edicts"],
  ["too_many_efrags", "Too many efrags"],
  ["mod_numknown_overflow", "mod_numknown == MAX_MOD_KNOWN"],
  ["texture_not_16_aligned", "is not 16 aligned"],
  ["sz_getspace_overflow", "SZ_GetSpace: overflow"],
  ["bad_surface_extents", "Bad surface extents"],
];

// How much context to keep on each side of a matched needle, e.g. so
// "is not a field" reports "'sky_alpha' is not a field" rather than the
// bare needle -- the field/classname is what a human (or the baseline)
// actually needs to tell one hit from another. RangeError's own message
// ("Range consisting of offset and length are out of bounds") runs longer
// than the other classes' needles, so it gets a wider trailing window.
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 20;
const RANGE_ERROR_CONTEXT_AFTER = 70;

function snippetsFor(joined: string, needle: string, contextAfter: number = CONTEXT_AFTER): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const idx = joined.indexOf(needle, from);
    if (idx < 0) break;
    const start = Math.max(0, idx - CONTEXT_BEFORE);
    const end = Math.min(joined.length, idx + needle.length + contextAfter);
    const snippet = joined.slice(start, end).trim();
    if (!out.includes(snippet)) out.push(snippet);
    from = idx + needle.length;
  }
  return out;
}

/** Coordinator follow-up: collects the bare NAMEs out of `unbound builtin "<name>"`, not context snippets -- these are meant to be compared directly against `unbound_named_builtins`. */
function unboundBuiltinNames(joined: string): string[] {
  const names: string[] = [];
  for (const m of joined.matchAll(UNBOUND_BUILTIN_RE)) {
    const name = m[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Classifies a whole console scrollback (oldest first, as returned by
 * test/e2e/b_lib.ts's `conLines()`) into this unit's classes. Pure and
 * synchronous so it can run unit-tested on synthetic strings with no
 * retail data (test/sweep_maps.test.ts's always-on part). sweep_driver.ts
 * also feeds a caught crash's own error message through this same function
 * (appended as one more "line"), since several of the coordinator's new
 * classes (ED_Alloc, mod_numknown, RangeError, ...) are Sys_Error/native-
 * exception text that never reaches the console at all.
 */
export function classifyConsoleLines(lines: readonly string[]): Record<ConsoleClassKeyT, string[]> {
  const out: Record<ConsoleClassKeyT, string[]> = {
    error: [],
    is_not_a_field: [],
    no_spawn_function: [],
    pr_run_error: [],
    unknown_builtin: [],
    unbound_builtin: [],
    too_many_static_ents: [],
    precache_model_overflow: [],
    ed_alloc_no_free_edicts: [],
    too_many_efrags: [],
    mod_numknown_overflow: [],
    texture_not_16_aligned: [],
    sz_getspace_overflow: [],
    bad_surface_extents: [],
    range_error: [],
  };
  const joined = lines.join(" ");

  const addSnippets = (key: ConsoleClassKeyT, needle: string): void => {
    out[key].push(...snippetsFor(joined, needle));
  };

  addSnippets("no_spawn_function", "No spawn function for:");
  addSnippets("is_not_a_field", "is not a field");
  for (const s of UNKNOWN_BUILTIN_SUBSTRINGS) addSnippets("unknown_builtin", s);
  for (const s of PR_RUN_ERROR_SUBSTRINGS) addSnippets("pr_run_error", s);
  for (const s of ERROR_SUBSTRINGS) addSnippets("error", s);
  for (const [key, needle] of SINGLE_SUBSTRING_CLASSES) addSnippets(key, needle);
  out.range_error.push(...snippetsFor(joined, "RangeError", RANGE_ERROR_CONTEXT_AFTER));
  out.unbound_builtin.push(...unboundBuiltinNames(joined));

  // Generic fallback: a line mentioning "error" that none of the specific
  // patterns above already matched somewhere in it. This is what keeps a
  // genuinely new message from silently vanishing instead of showing up in
  // the residual table as something to classify properly.
  const allSnippets = Object.values(out).flat();
  for (const line of lines) {
    if (!/\berror\b/i.test(line)) continue; // word boundary: "Terror" (a level title) is not an error
    const alreadyKnown = allSnippets.some((s) => line.includes(s) || s.includes(line));
    if (!alreadyKnown && !out.error.includes(line)) out.error.push(line);
  }

  return out;
}

// ===========================================================================
// the record schema
// ===========================================================================

export interface SweepTimingT {
  readonly boot_ms: number;
  readonly spawn_ms: number;
  readonly connect_ms: number;
  readonly settle_ms: number;
  readonly total_ms: number;
}

export interface SweepRecordT {
  readonly map: string;
  readonly gamedir: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly bsp_version: string;
  readonly reached_active: boolean;
  readonly num_edicts_after_spawn: number | null;
  readonly model_precache_count: number | null;
  readonly sound_precache_count: number | null;
  readonly worldmodel_name: string | null;
  readonly player_entered: boolean;
  readonly unbound_named_builtins: readonly string[];
  readonly console: Record<ConsoleClassKeyT, string[]>;
  readonly timing: SweepTimingT;
  readonly frames_settled: number;
}

export function emptyConsoleClassification(): Record<ConsoleClassKeyT, string[]> {
  return {
    error: [],
    is_not_a_field: [],
    no_spawn_function: [],
    pr_run_error: [],
    unknown_builtin: [],
    unbound_builtin: [],
    too_many_static_ents: [],
    precache_model_overflow: [],
    ed_alloc_no_free_edicts: [],
    too_many_efrags: [],
    mod_numknown_overflow: [],
    texture_not_16_aligned: [],
    sz_getspace_overflow: [],
    bad_surface_extents: [],
    range_error: [],
  };
}

const ZERO_TIMING: SweepTimingT = { boot_ms: 0, spawn_ms: 0, connect_ms: 0, settle_ms: 0, total_ms: 0 };

export function failureRecord(job: SweepJobT, error: string): SweepRecordT {
  return {
    map: job.map,
    gamedir: job.gamedir,
    ok: false,
    error,
    bsp_version: job.bspVersion,
    reached_active: false,
    num_edicts_after_spawn: null,
    model_precache_count: null,
    sound_precache_count: null,
    worldmodel_name: null,
    player_entered: false,
    unbound_named_builtins: [],
    console: emptyConsoleClassification(),
    timing: ZERO_TIMING,
    frames_settled: 0,
  };
}

// ===========================================================================
// parent-side runner
// ===========================================================================

export interface SweepJobT {
  readonly gamedir: string;
  readonly basedir: string;
  readonly extraArgs: readonly string[];
  readonly map: string;
  readonly bspVersion: string;
}

export function buildJobs(configs: readonly GamedirConfigT[]): SweepJobT[] {
  const jobs: SweepJobT[] = [];
  for (const cfg of configs) {
    for (const m of enumerateGamedirMaps(cfg)) {
      jobs.push({ gamedir: cfg.label, basedir: cfg.basedir, extraArgs: cfg.extraArgs, map: m.map, bspVersion: m.bspVersion });
    }
  }
  return jobs;
}

const DRIVER_PATH = join(import.meta.dir, "sweep_driver.ts");

export interface SweepRunOptsT {
  readonly frames: number;
  readonly dt: number;
  readonly concurrency?: number;
}

function outPathFor(outDir: string, job: SweepJobT): string {
  const safe = (s: string): string => s.replace(/\//g, "__");
  return join(outDir, `${safe(job.gamedir)}__${safe(job.map)}.json`);
}

/**
 * One driver subprocess for one (gamedir, map) pair, under `timeout 300` --
 * this unit's brief calls for a hard per-subprocess timeout, on top of
 * sweep_driver.ts's own internal 60s watchdog, so a boot that somehow gets
 * past that internal watchdog (a genuinely unkillable synchronous hang)
 * still cannot stall the sweep forever.
 */
export async function runOneJob(job: SweepJobT, outDir: string, opts: SweepRunOptsT): Promise<SweepRecordT> {
  const outPath = outPathFor(outDir, job);
  const args = [
    "timeout",
    "300",
    "bun",
    DRIVER_PATH,
    "--basedir",
    job.basedir,
    "--gamedir",
    job.gamedir,
    "--map",
    job.map,
    "--bspversion",
    job.bspVersion,
    "--frames",
    String(opts.frames),
    "--dt",
    String(opts.dt),
    "--out",
    outPath,
    "--extra",
    job.extraArgs.join(" "),
  ];
  const proc = Bun.spawn(args, {
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  if (!existsSync(outPath)) {
    return failureRecord(job, "driver produced no record (killed by timeout or crashed before writing)");
  }
  try {
    return parseSweepRecord(JSON.parse(readFileSync(outPath, "utf8")));
  } catch (e) {
    return failureRecord(job, `driver wrote unparseable JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Runs every job with a bounded worker pool, defaulting to the CPU count minus one (never less than 1). */
export async function runSweep(jobs: readonly SweepJobT[], outDir: string, opts: SweepRunOptsT): Promise<SweepRecordT[]> {
  mkdirSync(outDir, { recursive: true });
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? Math.max(1, cpus().length - 1), jobs.length || 1));
  const results: SweepRecordT[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (job === undefined) return;
      results[i] = await runOneJob(job, outDir, opts);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ===========================================================================
// reporting
// ===========================================================================

export interface GamedirSummaryT {
  readonly gamedir: string;
  readonly maps: number;
  readonly booted: number; // ok && reached_active && player_entered
  readonly failed: number;
  readonly topErrorClasses: readonly { readonly key: string; readonly count: number; readonly example: string }[];
}

/** "class" here is either one of the five console buckets, or "crash:<first line of the error message>" for a hard failure. */
function errorClassesOf(rec: SweepRecordT): readonly { readonly key: string; readonly example: string }[] {
  const out: { key: string; example: string }[] = [];
  if (!rec.ok && rec.error !== null) out.push({ key: `crash: ${rec.error.split("\n")[0]}`, example: rec.error });
  for (const k of CONSOLE_CLASS_KEYS) {
    for (const example of rec.console[k]) out.push({ key: k, example });
  }
  return out;
}

export function summarizeByGamedir(records: readonly SweepRecordT[]): GamedirSummaryT[] {
  const byGamedir = new Map<string, SweepRecordT[]>();
  for (const r of records) {
    const list = byGamedir.get(r.gamedir);
    if (list === undefined) byGamedir.set(r.gamedir, [r]);
    else list.push(r);
  }

  const out: GamedirSummaryT[] = [];
  for (const [gamedir, recs] of byGamedir) {
    const booted = recs.filter((r) => r.ok && r.reached_active && r.player_entered).length;
    const failed = recs.length - booted;

    const classCounts = new Map<string, { count: number; example: string }>();
    for (const r of recs) {
      for (const { key, example } of errorClassesOf(r)) {
        const cur = classCounts.get(key);
        if (cur === undefined) classCounts.set(key, { count: 1, example });
        else cur.count++;
      }
    }
    const topErrorClasses = Array.from(classCounts.entries())
      .map(([key, v]) => ({ key, count: v.count, example: v.example }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    out.push({ gamedir, maps: recs.length, booted, failed, topErrorClasses });
  }
  return out.sort((a, b) => a.gamedir.localeCompare(b.gamedir));
}

export function formatSummaryTable(summaries: readonly GamedirSummaryT[]): string {
  const lines: string[] = [];
  const header = ["gamedir", "maps", "booted", "failed"];
  lines.push(header.join("\t"));
  for (const s of summaries) {
    lines.push([s.gamedir, String(s.maps), String(s.booted), String(s.failed)].join("\t"));
  }
  lines.push("");
  lines.push("top error classes per gamedir:");
  for (const s of summaries) {
    if (s.topErrorClasses.length === 0) continue;
    lines.push(`  ${s.gamedir}:`);
    for (const c of s.topErrorClasses) {
      lines.push(`    ${c.count}x ${c.key}  e.g. ${c.example.slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}

export interface SweepDiffT {
  readonly newlyFailing: readonly string[]; // "<gamedir>/<map>"
  readonly newlyBooting: readonly string[];
  readonly classCountChanges: readonly { readonly key: string; readonly before: number; readonly after: number }[];
}

export function diffSweeps(before: readonly SweepRecordT[], after: readonly SweepRecordT[]): SweepDiffT {
  const key = (r: SweepRecordT): string => `${r.gamedir}/${r.map}`;
  const bootedOf = (r: SweepRecordT): boolean => r.ok && r.reached_active && r.player_entered;

  const beforeByKey = new Map(before.map((r) => [key(r), r]));
  const afterByKey = new Map(after.map((r) => [key(r), r]));

  const newlyFailing: string[] = [];
  const newlyBooting: string[] = [];
  for (const [k, a] of afterByKey) {
    const b = beforeByKey.get(k);
    if (b === undefined) continue;
    if (bootedOf(b) && !bootedOf(a)) newlyFailing.push(k);
    if (!bootedOf(b) && bootedOf(a)) newlyBooting.push(k);
  }

  const countClasses = (records: readonly SweepRecordT[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of records) for (const { key: k } of errorClassesOf(r)) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const beforeCounts = countClasses(before);
  const afterCounts = countClasses(after);
  const classCountChanges: { key: string; before: number; after: number }[] = [];
  for (const k of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
    const b = beforeCounts.get(k) ?? 0;
    const a = afterCounts.get(k) ?? 0;
    if (a !== b) classCountChanges.push({ key: k, before: b, after: a });
  }

  return { newlyFailing, newlyBooting, classCountChanges };
}

export function formatDiff(diff: SweepDiffT): string {
  const lines: string[] = [];
  lines.push(`newly failing (${diff.newlyFailing.length}): ${diff.newlyFailing.join(", ") || "(none)"}`);
  lines.push(`newly booting (${diff.newlyBooting.length}): ${diff.newlyBooting.join(", ") || "(none)"}`);
  lines.push("class count changes:");
  for (const c of diff.classCountChanges) lines.push(`  ${c.key}: ${c.before} -> ${c.after}`);
  return lines.join("\n");
}

// ===========================================================================
// CLI entry point -- scripts/sweep.sh's actual engine (see file header)
// ===========================================================================

function argOf(argv: readonly string[], name: string, fallback: string | null = null): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

// ===========================================================================
// runtime validation of a driver's JSON output -- this crosses a process
// boundary (a subprocess wrote it), so per standing order 1 it comes back
// as `unknown` and is narrowed here with real type guards, never `as`.
// ===========================================================================

export function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x): x is string => typeof x === "string");
}

function isConsoleClassification(v: unknown): v is Record<ConsoleClassKeyT, string[]> {
  if (!isRecordObject(v)) return false;
  for (const key of CONSOLE_CLASS_KEYS) {
    if (!(key in v) || !isStringArray(v[key])) return false;
  }
  return true;
}

function isTiming(v: unknown): v is SweepTimingT {
  if (!isRecordObject(v)) return false;
  return typeof v.boot_ms === "number" && typeof v.spawn_ms === "number" && typeof v.connect_ms === "number" && typeof v.settle_ms === "number" && typeof v.total_ms === "number";
}

/** Validates and narrows a driver's JSON output into a SweepRecordT. Throws with a field name on the first mismatch. */
export function parseSweepRecord(raw: unknown): SweepRecordT {
  if (!isRecordObject(raw)) throw new Error("sweep record: not an object");
  if (typeof raw.map !== "string") throw new Error("sweep record: map");
  if (typeof raw.gamedir !== "string") throw new Error("sweep record: gamedir");
  if (typeof raw.ok !== "boolean") throw new Error("sweep record: ok");
  if (!isStringOrNull(raw.error)) throw new Error("sweep record: error");
  if (typeof raw.bsp_version !== "string") throw new Error("sweep record: bsp_version");
  if (typeof raw.reached_active !== "boolean") throw new Error("sweep record: reached_active");
  if (!isNumberOrNull(raw.num_edicts_after_spawn)) throw new Error("sweep record: num_edicts_after_spawn");
  if (!isNumberOrNull(raw.model_precache_count)) throw new Error("sweep record: model_precache_count");
  if (!isNumberOrNull(raw.sound_precache_count)) throw new Error("sweep record: sound_precache_count");
  if (!isStringOrNull(raw.worldmodel_name)) throw new Error("sweep record: worldmodel_name");
  if (typeof raw.player_entered !== "boolean") throw new Error("sweep record: player_entered");
  if (!isStringArray(raw.unbound_named_builtins)) throw new Error("sweep record: unbound_named_builtins");
  if (!isConsoleClassification(raw.console)) throw new Error("sweep record: console");
  if (!isTiming(raw.timing)) throw new Error("sweep record: timing");
  if (typeof raw.frames_settled !== "number") throw new Error("sweep record: frames_settled");

  return {
    map: raw.map,
    gamedir: raw.gamedir,
    ok: raw.ok,
    error: raw.error,
    bsp_version: raw.bsp_version,
    reached_active: raw.reached_active,
    num_edicts_after_spawn: raw.num_edicts_after_spawn,
    model_precache_count: raw.model_precache_count,
    sound_precache_count: raw.sound_precache_count,
    worldmodel_name: raw.worldmodel_name,
    player_entered: raw.player_entered,
    unbound_named_builtins: raw.unbound_named_builtins,
    console: raw.console,
    timing: raw.timing,
    frames_settled: raw.frames_settled,
  };
}

export function parseSweepRecordArray(raw: unknown): SweepRecordT[] {
  if (!Array.isArray(raw)) throw new Error("expected an array of sweep records");
  return raw.map((x: unknown) => parseSweepRecord(x));
}

async function cliMain(): Promise<void> {
  const argv = process.argv.slice(2);
  const data = argOf(argv, "data", process.env.Q1TS_DATA ?? null);
  const outDir = argOf(argv, "out");
  if (data === null || outDir === null) {
    console.error("usage: bun test/support/sweep_lib.ts --data <basedir> --out <dir> [--all] [--gamedir <label>[,<label>...]] [--frames N] [--dt N] [--concurrency N] [--diff-against <prevDir>]");
    process.exit(2);
  }
  const wantAll = argv.includes("--all") || process.env.Q1TS_SWEEP_ALL === "1";
  const frames = Number(argOf(argv, "frames", "100"));
  const dt = Number(argOf(argv, "dt", "0.05"));
  const concurrencyArg = argOf(argv, "concurrency", null);
  const concurrency = concurrencyArg !== null ? Number(concurrencyArg) : undefined;
  const diffAgainst = argOf(argv, "diff-against", null);
  const gamedirFilterArg = argOf(argv, "gamedir", null);
  const gamedirFilter = gamedirFilterArg !== null ? new Set(gamedirFilterArg.split(",")) : null;

  const configs = wantAll ? allConfigs(data) : classicAllConfigs(data);
  let jobs = buildJobs(configs);
  if (gamedirFilter !== null) jobs = jobs.filter((j) => gamedirFilter.has(j.gamedir));
  console.log(`[sweep] ${jobs.length} (gamedir, map) pairs${gamedirFilter !== null ? ` (filtered to ${[...gamedirFilter].join(", ")})` : ` across ${configs.length} gamedirs`}`);

  const records = await runSweep(jobs, outDir, { frames, dt, concurrency });
  Bun.write(join(outDir, "summary.json"), JSON.stringify(records));

  const summaries = summarizeByGamedir(records);
  console.log(formatSummaryTable(summaries));

  if (diffAgainst !== null) {
    const prevPath = join(diffAgainst, "summary.json");
    if (existsSync(prevPath)) {
      const prev = parseSweepRecordArray(JSON.parse(readFileSync(prevPath, "utf8")));
      console.log("\n=== diff against previous run ===");
      console.log(formatDiff(diffSweeps(prev, records)));
    } else {
      console.log(`\n[sweep] --diff-against ${diffAgainst}: no summary.json there, skipping diff`);
    }
  }
}

if (import.meta.main) {
  await cliMain();
}
