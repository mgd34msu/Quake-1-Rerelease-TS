/*
One command that runs every end-to-end driver under test/e2e/ and prints a
pass/fail table.

The drivers themselves are standalone programs (`bun test/e2e/<file>.ts`,
never a `bun test` suite -- see README.md's "Headless recipe"). What each
family considers a runnable driver, with which arguments, lives in that
family's own `test/e2e/<letter>_manifest.json`; this file globs those
manifests, filters them, and runs what is left through a subprocess pool.
The pool, the per-subprocess `timeout -k 10 <n>` wrapper and the summary
table follow test/support/sweep_lib.ts's shape, for the same reason it gives
there: a driver that spins inside one synchronous engine frame never returns
to the event loop, so Bun alone cannot kill it and `timeout`'s follow-up
SIGKILL is what actually ends the run.

Manifest schema (one file per family letter):

  {
    "family": "r",
    "drivers": [
      {
        "name": "r_id1_soft",                                   required, unique across all manifests
        "cmd": ["bun", "test/e2e/r_content.ts", "--tree", "id1"], required, argv, run from the repo root
        "env": { "SDL_VIDEODRIVER": "dummy" },                   optional, added to the runner's own env
        "timeoutSec": 300,                                       optional, default 300
        "needs": ["rerelease"],                                  optional, default []
        "lock": "qwclient"                                       optional, default none
      }
    ]
  }

`needs` values are "classic", "rerelease", "gl", "qw", "binary", "audio",
"long". `lock` is this runner's addition to the schema in
.orch/briefs/E2E-COMMON.md: two drivers naming the same lock never run at the
same time, whatever `--jobs` says. QuakeWorld's client port is the hardcoded
`PORT_CLIENT = 27001` in src/qw/protocol.ts with no `-port` override, so only
one qwcl can be alive on the host at a time; without a lock, a two-job pool
that happens to schedule two QW drivers together fails them both for a reason
that has nothing to do with the engine.

`${Q1TS_DATA}`, `${Q1TS_SCRATCH}`, `${Q1TS_HOMEDIR}` and `${Q1TS_BINARY}` are substituted in
every `cmd` element and `env` value, so a manifest can name a path without
knowing where this host keeps it.

Usage:
  bun test/e2e/run_all.ts [--family abc] [--name <glob>] [--needs gl,qw]
                          [--no-needs long] [--jobs 4] [--list] [--build]

  --family <letters>  only these family letters (a string of letters, or a
                      comma-separated list)
  --name <glob>       only drivers whose name matches (`*` and `?` wildcards)
  --needs <tags>      only drivers declaring at least one of these needs
  --no-needs <tags>   drop drivers declaring any of these needs
  --jobs <n>          concurrent drivers, default 2
  --list              print the selected manifest and exit without running
  --build             build the compiled binary even when no selected driver
                      declares needs:["binary"]

Environment: Q1TS_DATA is required (the retail base directory), Q1TS_SCRATCH
defaults to /tmp/q1ts-tests, and Q1TS_HOMEDIR (default $Q1TS_SCRATCH/e2e/home)
is the root of the writable homes -- each driver is handed
$Q1TS_HOMEDIR/<family> as its own Q1TS_HOMEDIR, which is what its `-homedir`
resolves to, so the engine's config.cfg, savegames, demos and screenshots
never land in the retail install and one family's archived config never leaks
into another's boot. Q1TS_NOHOMEDIR is stripped from every driver's
environment: it is COM_DefaultHomeDir's `-nohomedir`, which would send the
writes of a driver that passes no explicit -homedir back into the basedir.
SDL_AUDIODRIVER is forced to "dummy" for every driver that does not set its
own. Logs land in $Q1TS_SCRATCH/e2e/logs/, the machine-readable run record in
$Q1TS_SCRATCH/e2e/report.json.
*/

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const E2E_DIR = import.meta.dir;

// ===========================================================================
// manifest schema
// ===========================================================================

export interface DriverSpecT {
  readonly family: string;
  readonly name: string;
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSec: number;
  readonly needs: readonly string[];
  readonly lock: string | null;
  readonly manifest: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === "string");
}

/** Parses one `<letter>_manifest.json`. Throws with the file name on anything malformed: a silently skipped driver is worse than a loud stop. */
export function parseManifest(path: string, raw: unknown): DriverSpecT[] {
  if (!isRecord(raw)) throw new Error(`${path}: top level is not an object`);
  const family = raw.family;
  if (typeof family !== "string" || family.length === 0) throw new Error(`${path}: "family" must be a non-empty string`);
  const drivers = raw.drivers;
  if (!Array.isArray(drivers)) throw new Error(`${path}: "drivers" must be an array`);

  const out: DriverSpecT[] = [];
  for (let i = 0; i < drivers.length; i++) {
    const d: unknown = drivers[i];
    const where = `${path} drivers[${i}]`;
    if (!isRecord(d)) throw new Error(`${where}: not an object`);

    const name = d.name;
    if (typeof name !== "string" || name.length === 0) throw new Error(`${where}: "name" must be a non-empty string`);
    const cmd = d.cmd;
    if (!isStringArray(cmd) || cmd.length === 0) throw new Error(`${where}: "cmd" must be a non-empty array of strings`);

    const envRaw = d.env;
    let env: Record<string, string> = {};
    if (envRaw !== undefined) {
      if (!isStringMap(envRaw)) throw new Error(`${where}: "env" must be an object of string values`);
      env = { ...envRaw };
    }

    const tRaw = d.timeoutSec;
    let timeoutSec = 300;
    if (tRaw !== undefined) {
      if (typeof tRaw !== "number" || !Number.isFinite(tRaw) || tRaw <= 0) throw new Error(`${where}: "timeoutSec" must be a positive number`);
      timeoutSec = Math.trunc(tRaw);
    }

    const needsRaw = d.needs;
    let needs: readonly string[] = [];
    if (needsRaw !== undefined) {
      if (!isStringArray(needsRaw)) throw new Error(`${where}: "needs" must be an array of strings`);
      needs = needsRaw;
    }

    const lockRaw = d.lock;
    let lock: string | null = null;
    if (lockRaw !== undefined) {
      if (typeof lockRaw !== "string" || lockRaw.length === 0) throw new Error(`${where}: "lock" must be a non-empty string`);
      lock = lockRaw;
    }

    out.push({ family, name, cmd, env, timeoutSec, needs, lock, manifest: path });
  }
  return out;
}

/** Every `*_manifest.json` in test/e2e/, in family order, with duplicate driver names rejected. */
export function loadManifests(dir: string): DriverSpecT[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith("_manifest.json"))
    .sort();
  const all: DriverSpecT[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const path = join(dir, f);
    const specs = parseManifest(f, JSON.parse(readFileSync(path, "utf8")));
    for (const s of specs) {
      const prev = seen.get(s.name);
      if (prev !== undefined) throw new Error(`duplicate driver name "${s.name}" in ${f} (already defined in ${prev})`);
      seen.set(s.name, f);
      all.push(s);
    }
  }
  return all;
}

// ===========================================================================
// selection
// ===========================================================================

/** `*` and `?` only; anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

export interface SelectionT {
  readonly families: ReadonlySet<string> | null;
  readonly namePattern: RegExp | null;
  readonly needs: ReadonlySet<string> | null;
  readonly noNeeds: ReadonlySet<string>;
}

export function selectDrivers(all: readonly DriverSpecT[], sel: SelectionT): DriverSpecT[] {
  return all.filter((d) => {
    if (sel.families !== null && !sel.families.has(d.family)) return false;
    if (sel.namePattern !== null && !sel.namePattern.test(d.name)) return false;
    if (sel.needs !== null && !d.needs.some((n) => sel.needs?.has(n) === true)) return false;
    if (d.needs.some((n) => sel.noNeeds.has(n))) return false;
    return true;
  });
}

// ===========================================================================
// results
// ===========================================================================

export type DriverStatusT = "PASS" | "FAIL" | "TIMEOUT";

export interface DriverResultT {
  readonly family: string;
  readonly name: string;
  readonly cmd: readonly string[];
  readonly pass: number;
  readonly fail: number;
  readonly seconds: number;
  readonly exitCode: number;
  readonly status: DriverStatusT;
  readonly log: string;
  readonly firstFailure: string | null;
}

export interface DriverOutputFactsT {
  readonly pass: number;
  readonly fail: number;
  readonly firstFailure: string | null;
}

const PASS_LINE = /^\s*\[PASS\]/;
const FAIL_LINE = /^\s*\[FAIL\]/;
const RESULT_LINE = /^\s*RESULT\s+(\d+)\s+(\d+)\s*$/;

/**
 * Counts a driver's own assertions out of its log. A `RESULT <pass> <fail>`
 * line is authoritative when present (a driver that ends early still prints
 * one); otherwise the [PASS]/[FAIL] lines are counted directly, so a driver
 * killed by `timeout` mid-run still reports the assertions it got through.
 */
export function parseDriverOutput(text: string): DriverOutputFactsT {
  let pass = 0;
  let fail = 0;
  let firstFailure: string | null = null;
  let resultPass: number | null = null;
  let resultFail: number | null = null;
  for (const line of text.split("\n")) {
    if (PASS_LINE.test(line)) pass++;
    else if (FAIL_LINE.test(line)) {
      fail++;
      if (firstFailure === null) firstFailure = line.trim();
    } else {
      const m = RESULT_LINE.exec(line);
      if (m !== null) {
        resultPass = Number(m[1]);
        resultFail = Number(m[2]);
      }
    }
  }
  if (resultPass !== null && resultFail !== null) return { pass: resultPass, fail: resultFail, firstFailure };
  return { pass, fail, firstFailure };
}

/** PASS only on exit 0 with no [FAIL] line, per .orch/briefs/E2E-COMMON.md. `timeout` reports 124, or 128+9 after its own -k SIGKILL. */
export function statusOf(exitCode: number, facts: DriverOutputFactsT): DriverStatusT {
  if (exitCode === 124 || exitCode === 137) return "TIMEOUT";
  if (exitCode !== 0) return "FAIL";
  return facts.fail > 0 ? "FAIL" : "PASS";
}

// ===========================================================================
// running
// ===========================================================================

function substitute(s: string, vars: Readonly<Record<string, string>>): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

export interface RunnerEnvT {
  readonly data: string;
  readonly scratch: string;
  readonly logDir: string;
  readonly homeDir: string;
  readonly binary: string | null;
}

async function runOne(spec: DriverSpecT, renv: RunnerEnvT): Promise<DriverResultT> {
  // One writable home per FAMILY. Everything the engine writes -- config.cfg,
  // savegames, demos, screenshots, qconsole.log -- goes under it, so a run
  // never touches the retail install and one family's archived config.cfg
  // never leaks into another's boot.
  const familyHome = join(renv.homeDir, spec.family);
  mkdirSync(familyHome, { recursive: true });

  const vars: Record<string, string> = {
    Q1TS_DATA: renv.data,
    Q1TS_SCRATCH: renv.scratch,
    Q1TS_HOMEDIR: familyHome,
    Q1TS_BINARY: renv.binary ?? "",
  };
  const cmd = spec.cmd.map((a) => substitute(a, vars));
  const driverEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) driverEnv[k] = substitute(v, vars);

  const env: Record<string, string> = {
    ...process.env,
    Q1TS_DATA: renv.data,
    Q1TS_SCRATCH: renv.scratch,
    Q1TS_HOMEDIR: familyHome,
    // H1 (2026-09-08): a boot that passes neither -homedir nor -nohomedir
    // resolves COM_DefaultHomeDir from XDG_DATA_HOME; pointed under the
    // family home so nothing a driver forgets to pin can reach the real
    // per-user directory (it did: e2e_q, e2e_w, id1, mg1 folders turned up in
    // ~/.local/share/q1rets after a regate).
    XDG_DATA_HOME: join(familyHome, "xdg"),
    SDL_AUDIODRIVER: "dummy",
    ...driverEnv,
  };
  if (renv.binary !== null) env.Q1TS_BINARY = renv.binary;
  // Q1TS_NOHOMEDIR is COM_DefaultHomeDir's `-nohomedir`: it sends the writes
  // of any driver that passes no explicit -homedir back into the BASEDIR,
  // i.e. into the retail install. Never pass it down, whatever this process
  // inherited.
  delete env.Q1TS_NOHOMEDIR;

  // `bash -c 'exec "$@" 2>&1'` keeps the driver's stderr interleaved with its
  // stdout in one stream (an engine Sys_Error goes to stderr, the [FAIL] line
  // that explains it to stdout; two separate captures lose which came first).
  const wrapped = ["bash", "-c", 'exec "$@" 2>&1', "bash", "timeout", "-k", "10", String(spec.timeoutSec), ...cmd];

  const t0 = Date.now();
  const proc = Bun.spawn(wrapped, { cwd: REPO_ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const seconds = (Date.now() - t0) / 1000;

  const logPath = join(renv.logDir, `${spec.name}.log`);
  const header = `# ${spec.name} (family ${spec.family})\n# cmd: ${cmd.join(" ")}\n# env: ${JSON.stringify(driverEnv)}\n# timeoutSec: ${spec.timeoutSec}\n\n`;
  writeFileSync(logPath, header + text);

  const facts = parseDriverOutput(text);
  return {
    family: spec.family,
    name: spec.name,
    cmd,
    pass: facts.pass,
    fail: facts.fail,
    seconds: Math.round(seconds * 10) / 10,
    exitCode,
    status: statusOf(exitCode, facts),
    log: logPath,
    firstFailure: facts.firstFailure,
  };
}

/*
How long to wait after a lock-holding driver exits before handing its lock to
the next one. A lock stands for an exclusive resource OUTSIDE this process --
above all QuakeWorld's hardcoded client port 27001 -- and the kernel does not
release a UDP bind at the instant the process that held it exits. Releasing
the lock on `proc.exited` alone gives the next driver a "UDP_OpenSocket:
bind: Address already in use" that has nothing to do with the engine.
*/
const LOCK_SETTLE_MS = 2000;

/**
 * Bounded worker pool. `lock` is honoured by refusing to start a driver whose
 * lock is already held and coming back to it later, rather than by
 * serialising the whole run: a single busy lock must not idle the other
 * workers.
 */
export async function runAll(specs: readonly DriverSpecT[], renv: RunnerEnvT, jobs: number, onDone: (r: DriverResultT) => void): Promise<DriverResultT[]> {
  const results: DriverResultT[] = new Array(specs.length);
  const done: boolean[] = new Array(specs.length).fill(false);
  const started: boolean[] = new Array(specs.length).fill(false);
  const heldLocks = new Set<string>();
  let remaining = specs.length;

  const takeNext = (): number => {
    for (let i = 0; i < specs.length; i++) {
      if (started[i]) continue;
      const lock = specs[i].lock;
      if (lock !== null && heldLocks.has(lock)) continue;
      started[i] = true;
      if (lock !== null) heldLocks.add(lock);
      return i;
    }
    return -1;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = takeNext();
      if (i < 0) {
        // Either everything is running/finished, or the only work left is
        // blocked on a lock another worker holds; wait for that to clear.
        if (remaining === 0) return;
        if (!started.includes(false)) return;
        await Bun.sleep(100);
        continue;
      }
      const spec = specs[i];
      const r = await runOne(spec, renv);
      results[i] = r;
      done[i] = true;
      remaining--;
      if (spec.lock !== null) {
        await Bun.sleep(LOCK_SETTLE_MS);
        heldLocks.delete(spec.lock);
      }
      onDone(r);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return results;
}

// ===========================================================================
// reporting
// ===========================================================================

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function formatTable(results: readonly DriverResultT[]): string {
  const rows = results.map((r) => [r.family, r.name, String(r.pass), String(r.fail), r.seconds.toFixed(1), r.status]);
  const header = ["family", "driver", "pass", "fail", "seconds", "status"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (i <= 1 ? pad(c, widths[i]) : padLeft(c, widths[i]))).join("  ");
  const out: string[] = [line(header), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

// ===========================================================================
// CLI
// ===========================================================================

function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function tagSet(v: string | null): Set<string> | null {
  if (v === null) return null;
  return new Set(v.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
}

async function buildBinary(outPath: string): Promise<boolean> {
  mkdirSync(join(outPath, ".."), { recursive: true });
  console.log(`building the compiled binary at ${outPath} ...`);
  const proc = Bun.spawn(["timeout", "300", "bun", "build", "--compile", "src/main.ts", "--outfile", outPath], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || !existsSync(outPath)) {
    console.log(out.trim());
    console.log(err.trim());
    console.log(`BUILD FAILED (exit ${code})`);
    return false;
  }
  return true;
}

async function cli(argv: readonly string[]): Promise<number> {
  const data = process.env.Q1TS_DATA;
  if (data === undefined || data === "") {
    console.log("run_all.ts: Q1TS_DATA must point at the retail base directory (see test/e2e/README.md).");
    return 2;
  }
  const scratch = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
  const e2eScratch = join(scratch, "e2e");
  const logDir = join(e2eScratch, "logs");
  // The engine writes config.cfg, savegames, demos, screenshots and
  // qconsole.log under its home directory (F3: $XDG_DATA_HOME/q1rets/<game>
  // with no -homedir), and com_gamedir points there. Every driver is handed
  // one inside the scratch tree instead, so a run never writes into the
  // retail install and never inherits the developer's own saved config.
  const homeDir = process.env.Q1TS_HOMEDIR ?? join(e2eScratch, "home");
  // runOne() gives each driver `<homeDir>/<family>`; this is only the root.

  const familyArg = argValue(argv, "--family");
  const families =
    familyArg === null
      ? null
      : new Set(
          familyArg
            .split(",")
            .flatMap((part) => (part.includes("_") ? [part.trim()] : part.trim().split("")))
            .filter((s) => s.length > 0),
        );
  const nameArg = argValue(argv, "--name");
  const sel: SelectionT = {
    families,
    namePattern: nameArg === null ? null : globToRegExp(nameArg),
    needs: tagSet(argValue(argv, "--needs")),
    noNeeds: tagSet(argValue(argv, "--no-needs")) ?? new Set(),
  };

  let all: DriverSpecT[];
  try {
    all = loadManifests(E2E_DIR);
  } catch (e) {
    console.log(`run_all.ts: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const selected = selectDrivers(all, sel);

  if (argv.includes("--list")) {
    console.log(`${selected.length} driver(s) of ${all.length}:`);
    for (const d of selected) {
      const needs = d.needs.length > 0 ? ` needs=${d.needs.join(",")}` : "";
      const lock = d.lock !== null ? ` lock=${d.lock}` : "";
      console.log(`  ${pad(d.family, 2)} ${pad(d.name, 26)} ${d.timeoutSec}s${needs}${lock}  ${d.cmd.join(" ")}`);
    }
    return 0;
  }
  if (selected.length === 0) {
    console.log("run_all.ts: no drivers selected.");
    return 2;
  }

  mkdirSync(logDir, { recursive: true });

  let binary: string | null = null;
  const envBinary = process.env.Q1TS_BINARY;
  const wantBinary = argv.includes("--build") || selected.some((d) => d.needs.includes("binary"));
  if (envBinary !== undefined && envBinary !== "" && existsSync(envBinary)) {
    binary = envBinary;
    console.log(`using Q1TS_BINARY=${binary}`);
  } else if (wantBinary) {
    const outPath = join(e2eScratch, "q1rets");
    if (!(await buildBinary(outPath))) return 2;
    binary = outPath;
  }

  const jobsArg = argValue(argv, "--jobs");
  const jobs = jobsArg === null ? 2 : Math.max(1, Math.trunc(Number(jobsArg)));

  mkdirSync(homeDir, { recursive: true });
  const renv: RunnerEnvT = { data, scratch, logDir, homeDir, binary };
  console.log(`running ${selected.length} driver(s), ${jobs} at a time; logs in ${logDir}, engine writes under ${homeDir}`);
  const t0 = Date.now();
  let finished = 0;
  const results = await runAll(selected, renv, jobs, (r) => {
    finished++;
    console.log(`[${padLeft(String(finished), 3)}/${selected.length}] ${pad(r.status, 7)} ${pad(r.name, 26)} ${r.seconds.toFixed(1)}s  ${r.pass} pass / ${r.fail} fail`);
  });
  const wallSeconds = Math.round((Date.now() - t0) / 100) / 10;

  console.log("");
  console.log(formatTable(results));

  const bad = results.filter((r) => r.status !== "PASS");
  const totalPass = results.reduce((a, r) => a + r.pass, 0);
  const totalFail = results.reduce((a, r) => a + r.fail, 0);
  console.log("");
  console.log(`${results.length - bad.length}/${results.length} drivers green; ${totalPass} assertions passed, ${totalFail} failed; ${wallSeconds}s wall clock`);
  for (const r of bad) {
    console.log(`  ${r.status}: ${r.name} (exit ${r.exitCode})${r.firstFailure !== null ? ` -- ${r.firstFailure}` : ""}`);
    console.log(`         log: ${r.log}`);
  }

  const reportPath = join(e2eScratch, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        started: new Date(t0).toISOString(),
        wallSeconds,
        data,
        scratch,
        homeDir,
        binary,
        jobs,
        selection: { family: familyArg, name: nameArg, needs: argValue(argv, "--needs"), noNeeds: argValue(argv, "--no-needs") },
        totals: { drivers: results.length, green: results.length - bad.length, assertionsPassed: totalPass, assertionsFailed: totalFail },
        drivers: results,
      },
      null,
      2,
    ),
  );
  console.log(`report: ${reportPath}`);

  return bad.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await cli(process.argv.slice(2)));
}
