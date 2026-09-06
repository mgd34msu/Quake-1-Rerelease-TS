// Harness helpers for the D end-to-end agent (report-only; test/e2e/d_*.ts
// files only, per this agent's brief). Two layers:
//  - d_role.ts runs INSIDE a spawned `bun` process: one real engine instance
//    (Sys_Main_Init + runFrames from ../../src/main), driven by a scripted
//    command timeline read from an env var, console output appended to a
//    file the whole run.
//  - this module's spawnRole()/waitFor()/readLog() run in the ORCHESTRATOR
//    process (the scenario scripts, test/e2e/d_s*.ts) to launch d_role.ts
//    subprocesses with `Bun.spawn`, poll their log files for expected
//    strings, and tear them down.
//
// Ports: this agent's assigned UDP range is 26100-26199 (task brief); every
// scenario picks distinct ports from that range so concurrent A/B/C test
// agents on other ranges never collide.

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { conState, con_text } from "../../src/client/console";
import { Q1TS_DATA, Q1TS_REPO, classicArgv, homedirArgsFor, homedirRoot } from "./q1data";

/** Whole console scrollback as an array of trimmed lines, oldest first.
 * Only meaningful when called from inside the engine process (d_role.ts);
 * mirrors test/e2e/b_lib.ts's conLines() (same con_text/conState shape). */
export function conLines(): string[] {
  const t = con_text;
  if (!t) return [];
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  const out: string[] = [];
  for (let i = conState.con_current - total + 1; i <= conState.con_current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(t[row * w + x] & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}

export function conTail(n = 20): string {
  return conLines()
    .filter((l) => l.length > 0)
    .slice(-n)
    .join("\n");
}

export const SCRATCH = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
export const BASEDIR = Q1TS_DATA;
export const D_ROLE = `${Q1TS_REPO}/test/e2e/d_role.ts`;

export interface CmdStep {
  atMs: number;
  cmd: string;
}

export interface RoleSpec {
  label: string; // log file name stem
  engineArgs: string[]; // argv passed to Sys_Main_Init (minus argv[0])
  script: CmdStep[]; // commands to Cbuf_AddText at given elapsed ms
  runMs: number; // total wall-clock lifetime before the process exits itself
}

export interface SpawnedRole {
  label: string;
  proc: ReturnType<typeof Bun.spawn>;
  logPath: string;
}

export function logPath(label: string): string {
  return `${SCRATCH}/d_${label}.log`;
}

/*
Standing order 19: a live gate runs OUR OWN COMPILED BINARY in both seats.
When the runner (test/e2e/run_all.ts) has built one and exported Q1TS_BINARY,
each role IS that binary, and its scripted command timeline is delivered over
the engine's real stdin console (_Host_Frame calls Host_GetConsoleCommands
every frame, for a listen client exactly as for a dedicated server) instead
of through d_role.ts's Cbuf_AddText shortcut. Without Q1TS_BINARY -- driving
one scenario by hand from a source checkout -- d_role.ts still runs
src/main.ts in the same shape.
*/
export const BINARY: string | null = ((): string | null => {
  const b = process.env.Q1TS_BINARY;
  return b !== undefined && b !== "" && existsSync(b) ? b : null;
})();

export function spawnRole(spec: RoleSpec): SpawnedRole {
  const log = logPath(spec.label);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(log, ""); // truncate/create -- a stale log makes every check pass

  const env = {
    ...process.env,
    SDL_VIDEODRIVER: process.env.SDL_VIDEODRIVER ?? "dummy",
    SDL_AUDIODRIVER: "dummy",
  };

  // Sys_ConsoleInput reads stdin only for a DEDICATED server ("if (cls.state
  // == ca_dedicated)", faithful to sys_linux.c), so a client seat cannot be
  // scripted through the shipped binary at all -- there is no channel into
  // its console. Client seats keep d_role.ts, which is the same engine built
  // from the same source with a Cbuf_AddText timeline bolted on.
  const dedicated = spec.engineArgs.includes("-dedicated");
  // Family D is a classic-content family; the retail tree nests the
  // re-release under rerelease/ and a plain -basedir auto-detects it.
  const engineArgs = classicArgv(["q1ts", ...homedirArgsFor(spec.engineArgs), ...spec.engineArgs]).slice(1);

  if (BINARY !== null && dedicated) {
    const proc = Bun.spawn({
      cmd: [BINARY, ...engineArgs],
      env,
      stdout: Bun.file(log),
      stderr: Bun.file(log),
      stdin: "pipe",
    });
    const role: SpawnedRole = { label: spec.label, proc, logPath: log };
    void (async () => {
      const start = Date.now();
      for (const step of [...spec.script].sort((a, b) => a.atMs - b.atMs)) {
        const wait = step.atMs - (Date.now() - start);
        if (wait > 0) await Bun.sleep(wait);
        await stdinLine(role, step.cmd);
      }
      const left = spec.runMs - (Date.now() - start);
      if (left > 0) await Bun.sleep(left);
      // `quit` from a client's console pops the quit MENU (Host_Quit_f only
      // exits outright for key_dest === key_console or a dedicated server),
      // so the role's lifetime ends with a signal, not a console line.
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    })();
    return role;
  }

  const scriptPath = `${SCRATCH}/d_script_${spec.label}.json`;
  Bun.write(scriptPath, JSON.stringify({ script: spec.script, runMs: spec.runMs }));
  const proc = Bun.spawn({
    cmd: ["bun", D_ROLE, ...engineArgs],
    env: { ...env, D_SCRIPT_FILE: scriptPath, D_LABEL: spec.label },
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    stdin: "pipe",
  });
  return { label: spec.label, proc, logPath: log };
}

export function readLog(label: string): string {
  const p = logPath(label);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export async function waitForLog(label: string, needle: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readLog(label).includes(needle)) return true;
    await Bun.sleep(150);
  }
  return false;
}

export async function waitMs(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

export async function stdinLine(role: SpawnedRole, line: string): Promise<void> {
  // Bun.spawn with stdin: "pipe" gives a FileSink; the union it is declared
  // as also admits a number and null, narrowed here by the methods actually
  // used rather than by an assertion.
  const w: unknown = role.proc.stdin;
  if (w !== null && typeof w === "object" && "write" in w && typeof w.write === "function" && "flush" in w && typeof w.flush === "function") {
    w.write(line + "\n");
    w.flush();
  }
}

export async function killRole(role: SpawnedRole): Promise<void> {
  try {
    role.proc.kill();
  } catch {
    /* already dead */
  }
}

/*
The writable tree a role's `-game <name>` resolves to. With `-homedir` (which
spawnRole adds, see homedirArgsFor) that is under $Q1TS_HOMEDIR, not under the
retail basedir -- nothing a driver run does should land in the retail install.
The engine does not create the directory itself and several of its writers
treat a failed open as fatal, so the harness makes it.
*/
export function ensureGameDir(name: string): void {
  mkdirSync(`${homedirRoot()}/${name}/glquake`, { recursive: true });
}

export interface Result {
  scenario: string;
  name: string;
  pass: boolean;
  note: string;
}
export const results: Result[] = [];
export function record(scenario: string, name: string, pass: boolean, note = ""): boolean {
  results.push({ scenario, name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${scenario}: ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/** Waits for a role's own process to end; returns false if it outlived the timeout. */
export async function waitRoleExit(role: SpawnedRole, timeoutMs: number): Promise<boolean> {
  const raced = await Promise.race([role.proc.exited.then(() => "exited"), Bun.sleep(timeoutMs).then(() => "timeout")]);
  return raced === "exited";
}

/*
Ends the scenario on the contract in .orch/briefs/E2E-COMMON.md: the
`[PASS]`/`[FAIL]` lines record() prints, one final `RESULT <pass> <fail>`,
and a non-zero exit when anything failed.
*/
export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.scenario}: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}
