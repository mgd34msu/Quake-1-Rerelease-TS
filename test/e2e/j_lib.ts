// Harness helpers for the J end-to-end agent (ambient/spatialization + real
// QuakeC intermission/finale). Not a bun:test suite -- each j_*.ts scenario
// is a standalone script run with `bun test/e2e/j_<name>.ts`, modeled on
// test/e2e/b_lib.ts and test/e2e/c_harness.ts's shape (this agent owns only
// test/e2e/j_*.ts and .orch/e2e/J.md; b_lib.ts/c_harness.ts/c_analyzer.ts
// belong to sibling agents and are read/imported here, never edited).
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute } from "../../src/common/cmd";
import { Key_Event } from "../../src/client/keys";
import { conState } from "../../src/client/console";
import * as consoleMod from "../../src/client/console";
import { Q1TS_DATA } from "./q1data";

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
}

export function boot(args: string[]): void {
  Sys_Main_Init(["q1ts", ...args]);
}

export function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

export function exec(text: string, n = 2): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n);
}

export function execNow(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  Cbuf_Execute();
}

export function key(k: number, down: boolean): void {
  Key_Event(k, down);
}

export function tap(k: number): void {
  Key_Event(k, true);
  Key_Event(k, false);
}

// A real-time-paced frame pump: SDL's disk audio driver paces its writes to
// wall-clock time (see c_analyzer.ts's header, confirmed by the C-track
// agent with standalone probes), so any scenario that wants the captured
// .raw file's timing to mean anything must advance frames in step with real
// elapsed time, not just call runFrames in a tight synchronous loop. tSec is
// wall-clock time since this function's own start (not since process start);
// onTick, if given, runs once per iteration before the frame step, receiving
// that elapsed time -- callers use it to fire timed commands/edicts writes.
// Returns the number of frames actually run, so a caller that wants to
// isolate "just this window"'s console output (e.g. one snd_show line per
// frame) can take conLines().slice(-thatCount) instead of scanning the
// whole ring buffer, which would also see leftover lines from an earlier
// phase (con_totallines is a large fixed-size ring, not cleared between
// phases).
export async function pump(durationSec: number, dt = 0.05, onTick?: (elapsedSec: number) => void): Promise<number> {
  const start = Date.now();
  let n = 0;
  while ((Date.now() - start) / 1000 < durationSec) {
    const elapsed = (Date.now() - start) / 1000;
    if (onTick) onTick(elapsed);
    runFrames(1, dt);
    n++;
    await Bun.sleep(Math.max(1, Math.round(dt * 1000)));
  }
  return n;
}

/** Whole console scrollback as an array of trimmed lines, oldest first. */
export function conLines(): string[] {
  const t = consoleMod.con_text;
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

export function conHas(needle: string): boolean {
  return conLines().some((l) => l.includes(needle));
}

export function conTail(n = 12): string {
  return conLines()
    .filter((l) => l.length > 0)
    .slice(-n)
    .join("\n");
}

// Extracts the highest N seen in any "----(N)----" line snd_dma.ts's
// S_Update prints once `snd_show 1` is set (one line per frame). Pass an
// explicit line window (e.g. conLines().slice(-frameCount) for the frame
// count a pump() call just reported) rather than the whole backscroll --
// con_totallines is one large ring shared across the whole run, so scanning
// it unbounded after a later, quieter phase still sees an earlier phase's
// higher counts.
export function maxSndShowCount(lines: string[]): number {
  let max = -1;
  const re = /^----\((\d+)\)----$/;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

// ---- screenshots ---------------------------------------------------------
export const SHOTDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/jshots`;

function shotFiles(gamedir: string): Set<string> {
  if (!existsSync(gamedir)) return new Set();
  return new Set(readdirSync(gamedir).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/** Runs `screenshot` and renames the new file to <SHOTDIR>/<name>.<ext>. gamedir is the mod directory screenshot writes into (e.g. .../q1-basedir/e2e_j). */
export function shot(gamedir: string, name: string): string | null {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles(gamedir);
  exec("screenshot", 2);
  frames(2);
  const after = shotFiles(gamedir);
  for (const f of after) {
    if (!before.has(f)) {
      const ext = f.slice(f.lastIndexOf("."));
      const dest = `${SHOTDIR}/${name}${ext}`;
      copyFileSync(`${gamedir}/${f}`, dest);
      unlinkSync(`${gamedir}/${f}`);
      console.log(`  [shot] ${name}${ext}`);
      return dest;
    }
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}

export const BASEDIR = Q1TS_DATA;
export const GAMEDIR_NAME = "e2e_j";
export const GAMEDIR = `${BASEDIR}/${GAMEDIR_NAME}`;
