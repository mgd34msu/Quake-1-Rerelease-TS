// Harness for the G end-to-end agent: real SDL events pushed onto SDL's own
// queue, drained by src/platform/sdl.ts's SDL_PumpInput. Not a bun:test
// suite; each g_s*.ts scenario is a standalone script run with
// `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/g_sN.ts`.
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute } from "../../src/common/cmd";
import { Cvar_VariableValue } from "../../src/common/cvar";
import { Sys_SendKeyEvents } from "../../src/platform/sys";
import { keyState, key_lines, KeydestT } from "../../src/client/keys";
import { conState } from "../../src/client/console";
import * as consoleMod from "../../src/client/console";
import {
  SDL_MakeKeyEvent,
  SDL_MakeMouseButtonEvent,
  SDL_MakeMouseMotionEvent,
  SDL_MakeMouseWheelEvent,
  SDL_MakeWindowEvent,
  SDL_MakeQuitEvent,
  SDL_PushTestEvent,
  SDL_DrainEventsForTests,
  SDL_InputStateForTests,
  SDL_SetRelativeDeltaForTests,
} from "../../src/platform/sdl";
import { Q1TS_DATA } from "./q1data";

export const BASE = Q1TS_DATA;

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

// ---- SDL event injection -------------------------------------------------

/** Push one event and report whether SDL accepted it (SDL_PushEvent == 1). */
export function push(event: Uint8Array): boolean {
  return SDL_PushTestEvent(event) === 1;
}

/** Drain SDL's queue through the engine's own pump (sdl.ts SDL_PumpInput). */
export function pump(): void {
  Sys_SendKeyEvents();
}

/** Push a key-down/key-up pair through SDL, then pump and run frames. */
export function sdlTap(sym: number, n = 1): void {
  push(SDL_MakeKeyEvent(sym, true));
  push(SDL_MakeKeyEvent(sym, false));
  pump();
  frames(n);
}

export function sdlKeyDown(sym: number, n = 0): void {
  push(SDL_MakeKeyEvent(sym, true));
  pump();
  if (n > 0) frames(n);
}

export function sdlKeyUp(sym: number, n = 0): void {
  push(SDL_MakeKeyEvent(sym, false));
  pump();
  if (n > 0) frames(n);
}

/** Type a string through SDL keycodes; uppercase goes via a held SDLK_LSHIFT,
    which is how keys.c's own keyshift[] table produces capitals (the port's
    pump has no SDL_TEXTINPUT case -- see G.md). */
export function sdlType(s: string): void {
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const shifted = ch !== lower || SHIFTED_PUNCT.has(ch);
    const sym = shifted ? unshiftPunct(ch).charCodeAt(0) : ch.charCodeAt(0);
    if (shifted) push(SDL_MakeKeyEvent(SDLK.LSHIFT, true));
    push(SDL_MakeKeyEvent(sym, true));
    push(SDL_MakeKeyEvent(sym, false));
    if (shifted) push(SDL_MakeKeyEvent(SDLK.LSHIFT, false));
  }
  pump();
}

const SHIFTED_PUNCT = new Set(["!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", ":", '"', "<", ">", "?", "~", "|"]);
const UNSHIFT: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]", ":": ";", '"': "'",
  "<": ",", ">": ".", "?": "/", "~": "`", "|": "\\",
};
function unshiftPunct(ch: string): string {
  const u = UNSHIFT[ch];
  if (u !== undefined) return u;
  return ch.toLowerCase();
}

export function sdlMouseMotion(xrel: number, yrel: number): boolean {
  return push(SDL_MakeMouseMotionEvent(xrel, yrel));
}

export function sdlMouseButton(button: number, down: boolean): boolean {
  return push(SDL_MakeMouseButtonEvent(button, down));
}

export function sdlMouseWheel(y: number): boolean {
  return push(SDL_MakeMouseWheelEvent(y));
}

export function sdlWindowEvent(ev: number): boolean {
  return push(SDL_MakeWindowEvent(ev));
}

export function sdlQuit(): boolean {
  return push(SDL_MakeQuitEvent());
}

export { SDL_DrainEventsForTests as drain, SDL_InputStateForTests as inputState, SDL_SetRelativeDeltaForTests as setRelDelta };

// ---- SDLK keycodes (SDL_keycode.h) --------------------------------------
const SC = 1 << 30; // SDLK_SCANCODE_MASK
export const SDLK = {
  BACKSPACE: 8, TAB: 9, RETURN: 13, ESCAPE: 27, SPACE: 32,
  QUOTE: 39, COMMA: 44, MINUS: 45, PERIOD: 46, SLASH: 47,
  N0: 48, N1: 49, N2: 50, N3: 51, N4: 52, N5: 53, N6: 54, N7: 55, N8: 56, N9: 57,
  SEMICOLON: 59, EQUALS: 61,
  LEFTBRACKET: 91, BACKSLASH: 92, RIGHTBRACKET: 93, BACKQUOTE: 96,
  a: 97, b: 98, c: 99, d: 100, e: 101, f: 102, g: 103, h: 104, i: 105,
  j: 106, k: 107, l: 108, m: 109, n: 110, o: 111, p: 112, q: 113, r: 114,
  s: 115, t: 116, u: 117, v: 118, w: 119, x: 120, y: 121, z: 122,
  DELETE: 127,
  F1: SC | 58, F2: SC | 59, F3: SC | 60, F4: SC | 61, F5: SC | 62, F6: SC | 63,
  F7: SC | 64, F8: SC | 65, F9: SC | 66, F10: SC | 67, F11: SC | 68, F12: SC | 69,
  PAUSE: SC | 72, INSERT: SC | 73, HOME: SC | 74, PAGEUP: SC | 75,
  END: SC | 77, PAGEDOWN: SC | 78,
  RIGHT: SC | 79, LEFT: SC | 80, DOWN: SC | 81, UP: SC | 82,
  KP_DIVIDE: SC | 84, KP_MULTIPLY: SC | 85, KP_MINUS: SC | 86, KP_PLUS: SC | 87,
  KP_ENTER: SC | 88, KP_1: SC | 89, KP_2: SC | 90, KP_3: SC | 91, KP_4: SC | 92,
  KP_5: SC | 93, KP_6: SC | 94, KP_7: SC | 95, KP_8: SC | 96, KP_9: SC | 97,
  KP_0: SC | 98, KP_PERIOD: SC | 99,
  LCTRL: SC | 224, LSHIFT: SC | 225, LALT: SC | 226,
  RCTRL: SC | 228, RSHIFT: SC | 229, RALT: SC | 230,
} as const;

// ---- console readback (same shape as b_lib) ------------------------------
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

export function conTail(n = 10): string {
  return conLines().filter((l) => l.length > 0).slice(-n).join("\n");
}

/* Reads a value back at its declared type. A plain `x === CONST` right after
   `x = OTHER_CONST` is folded away by TypeScript's control-flow narrowing
   (the engine mutates these through calls TS cannot see), so every such
   comparison in this scenario set goes through one of these. */
export function asDest(v: KeydestT): KeydestT {
  return v;
}
export function asBool(v: boolean): boolean {
  return v;
}

export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
}

export { keyState, key_lines, conState, Cvar_VariableValue };
