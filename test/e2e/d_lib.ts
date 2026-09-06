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

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { conState, con_text } from "../../src/client/console";
import { Q1TS_DATA, Q1TS_REPO } from "./q1data";

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

export function spawnRole(spec: RoleSpec): SpawnedRole {
  const log = logPath(spec.label);
  const logFile = Bun.file(log);
  const writer = logFile.writer();
  writer.end(); // truncate/create
  const scriptPath = `${SCRATCH}/d_script_${spec.label}.json`;
  Bun.write(scriptPath, JSON.stringify({ script: spec.script, runMs: spec.runMs }));

  const proc = Bun.spawn({
    cmd: ["bun", D_ROLE, ...spec.engineArgs],
    env: {
      ...process.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "dummy",
      D_SCRIPT_FILE: scriptPath,
      D_LABEL: spec.label,
    },
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
  const w = role.proc.stdin;
  if (w && typeof w !== "number") {
    // Bun.spawn stdin: "pipe" gives a FileSink-like writer
    (w as { write: (s: string) => void }).write(line + "\n");
  }
}

export async function killRole(role: SpawnedRole): Promise<void> {
  try {
    role.proc.kill();
  } catch {
    /* already dead */
  }
}

export function ensureGameDir(name: string): void {
  mkdirSync(`${BASEDIR}/${name}`, { recursive: true });
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
