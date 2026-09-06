// Harness helpers for the B end-to-end agent. Not a bun:test suite; each
// b_s*.ts scenario is a standalone script run with `bun test/e2e/b_sN.ts`.
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute, Cmd_Exists } from "../../src/common/cmd";
import { Cvar_FindVar, Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Key_Event, keyState, keybindings, Key_KeynumToString, KeydestT } from "../../src/client/keys";
import { conState, con_text } from "../../src/client/console";
import * as common from "../../src/common/common";
import * as consoleMod from "../../src/client/console";
import { MStateT } from "../../src/client/menu";
import { classicArgv, homedirArgs } from "./q1data";

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/*
Which `-game` directory this driver writes into. Every b_s*.ts scenario spells
`-game e2e_b` in its own argv, and B_GAME overrides that value: shot() below
deletes every `quake*.pcx`/`.tga` it does not recognise while looking for the
one it just took, so two family-B drivers sharing one directory delete each
other's screenshots out from under them. The manifest gives every driver that
runs concurrently its own B_GAME; the ones that deliberately hand config.cfg
from one to the next (b_s3_bind -> b_s3b_quit -> b_s3c_reread) share one and
are serialised by the runner's `lock` instead.

The `-homedir` boot() adds is what keeps that directory in the scratch tree
rather than the retail install (see q1data.ts's homedirArgs), and gamedir()
below reads the live com_gamedir rather than rebuilding the path, so a
screenshot is looked for wherever the engine actually put it.
*/
export const GAME = process.env.B_GAME ?? "e2e_b";

export function boot(args: string[]): void {
  const argv = [...args];
  const i = argv.indexOf("-game");
  if (i >= 0 && i + 1 < argv.length) argv[i + 1] = GAME;
  else argv.push("-game", GAME);
  Sys_Main_Init(classicArgv(["quake", ...homedirArgs(GAME), ...argv]));
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

/*
Ends the driver. Every test/e2e driver reports through the same two lines the
runner (test/e2e/run_all.ts) reads -- the per-assertion `[PASS]`/`[FAIL]`
lines check() already prints, and one final `RESULT <pass> <fail>` -- and
exits non-zero when anything failed, per .orch/briefs/E2E-COMMON.md's driver
contract. The exit happens here rather than at each call site so a driver
that bails out early cannot report green by falling through to its own
trailing `process.exit(0)`.
*/
export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

// ---- screenshots ---------------------------------------------------------
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";

/** The engine's live writable game directory (com_gamedir), not a guess at it. */
export function gamedir(): string {
  return common.com_gamedir;
}
export const SHOTDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/bshots`;

function shotFiles(): Set<string> {
  const dir = gamedir();
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
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
      copyFileSync(`${gamedir()}/${f}`, dest);
      unlinkSync(`${gamedir()}/${f}`);
      console.log(`  [shot] ${name}${ext}`);
      return dest;
    }
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}
