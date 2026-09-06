// Harness helpers for the B end-to-end agent. Not a bun:test suite; each
// b_s*.ts scenario is a standalone script run with `bun test/e2e/b_sN.ts`.
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute, Cmd_Exists } from "../../src/common/cmd";
import { Cvar_FindVar, Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Key_Event, keyState, keybindings, Key_KeynumToString, KeydestT } from "../../src/client/keys";
import { conState, con_text } from "../../src/client/console";
import * as consoleMod from "../../src/client/console";
import { MStateT } from "../../src/client/menu";

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

export function boot(args: string[]): void {
  Sys_Main_Init(["quake", ...args]);
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

export function typeText(s: string): void {
  for (const ch of s) tap(ch.charCodeAt(0));
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

export { Cvar_FindVar, Cvar_VariableString, Cvar_VariableValue, Cmd_Exists, keyState, keybindings, Key_KeynumToString, conState };

/* Reads a value back at its declared type. A plain `x === OTHER_CONST` after
   `x = SOME_CONST` a few statements earlier is folded away by TypeScript's
   control-flow narrowing (the engine mutates these through calls TS cannot
   see -- Key_Event/M_Keydown reach keyState.key_dest / menuState.m_state
   through the real key/menu code, not through anything visible at the call
   site), so every such comparison in the b_s*.ts scenarios goes through one
   of these. Same idiom as test/e2e/g_lib.ts's asDest/asBool. */
export function asDest(v: KeydestT): KeydestT {
  return v;
}
export function asMState(v: MStateT): MStateT {
  return v;
}

export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
}

// ---- screenshots ---------------------------------------------------------
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { Q1TS_DATA } from "./q1data";

export const GAMEDIR = `${Q1TS_DATA}/e2e_b`;
export const SHOTDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/bshots`;

function shotFiles(): Set<string> {
  if (!existsSync(GAMEDIR)) return new Set();
  return new Set(readdirSync(GAMEDIR).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/** Runs `screenshot` and renames the new file to <SHOTDIR>/<name>.<ext>. */
export function shot(name: string): string | null {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles();
  exec("screenshot", 2);
  frames(2);
  const after = shotFiles();
  for (const f of after) {
    if (!before.has(f)) {
      const ext = f.slice(f.lastIndexOf("."));
      const dest = `${SHOTDIR}/${name}${ext}`;
      copyFileSync(`${GAMEDIR}/${f}`, dest);
      unlinkSync(`${GAMEDIR}/${f}`);
      console.log(`  [shot] ${name}${ext}`);
      return dest;
    }
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}
