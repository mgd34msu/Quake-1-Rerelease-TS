// Harness helpers for the W end-to-end agent (menus, console, keys,
// controllers, loc). Not a bun:test suite; each w_*.ts scenario is a
// standalone script run with `bun test/e2e/w_<name>.ts`. Modeled directly on
// test/e2e/b_lib.ts (menu/console/key helpers) and test/e2e/g_lib.ts (real
// SDL event injection), which this family reuses rather than re-deriving.
import { existsSync, mkdirSync, symlinkSync, writeFileSync, readdirSync, copyFileSync, unlinkSync, readFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute, Cbuf_InsertText, Cmd_Exists } from "../../src/common/cmd";
import { Cvar_FindVar, Cvar_Set, Cvar_SetValue, Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Key_Event, keyState, keybindings, Key_KeynumToString, Key_StringToKeynum, key_lines, KeydestT } from "../../src/client/keys";
import { conState, con_text } from "../../src/client/console";
import * as consoleMod from "../../src/client/console";
import { menuState, MStateT } from "../../src/client/menu";
import { com_gamedir } from "../../src/common/common";
import {
  SDL_MakeKeyEvent,
  SDL_MakeMouseButtonEvent,
  SDL_MakeMouseMotionEvent,
  SDL_MakeMouseWheelEvent,
  SDL_PushTestEvent,
  SDL_DrainEventsForTests,
  SDL_MakeControllerButtonEvent,
  SDL_MakeControllerAxisEvent,
  SDL_InjectFakeGamepadForTests,
  SDL_RemoveFakeGamepadForTests,
  SDL_SetFakeGamepadStateForTests,
  SDL_GamepadAxisStateForTests,
} from "../../src/platform/sdl";
import { Sys_SendKeyEvents } from "../../src/platform/sys";
import { Q1TS_DATA } from "./q1data";

export const BASE = Q1TS_DATA;

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

export { con_text, Cbuf_InsertText, Cmd_Exists, Cvar_FindVar, Cvar_Set, Cvar_SetValue, Cvar_VariableString, Cvar_VariableValue, keyState, keybindings, Key_KeynumToString, Key_StringToKeynum, key_lines, conState, menuState, MStateT, com_gamedir };

/* Reads a value back at its declared type -- same idiom as b_lib.ts's
   asDest/asMState and g_lib.ts's asDest/asBool: the engine mutates these
   through calls TS cannot see, so a plain `x === OTHER_CONST` right after
   `x = SOME_CONST` a few statements earlier gets folded away by control-flow
   narrowing. */
export function asDest(v: KeydestT): KeydestT {
  return v;
}
export function asMState(v: MStateT): MStateT {
  return v;
}
export function asBool(v: boolean): boolean {
  return v;
}
export function asNum(v: number): number {
  return v;
}

// ---- screenshots ----------------------------------------------------------
export const SHOTDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/wshots`;

/*
GAME-SWITCH SANDBOXING (found while verifying this unit, see the unit's own
report): src/common/common.ts's COM_InitFilesystem processes `-game <dir>`
AFTER it captures com_base_searchpaths -- the tier COM_ResetGameDirectories/
the runtime `game` command always tears down and rebuilds from -- so a CLI
`-game e2e_w` mount is NOT part of the base tier and is silently discarded
the moment any menu screen queues a `game <dir>` command (New Game's
mission-pack episodes, Add-Ons, the multiplayer Start Server screen's
mapdb-driven `game` line). Without `-homedir`, that leaves `com_gamedir`
pointing at the REAL retail gamedir the switch just named, and
sv_autosave's default-on behaviour (or a `save`/`quit`) writes real files
into it -- confirmed against this host's own Q1TS_DATA/rerelease tree
during this unit's development. `-homedir` fixes this at the root:
COM_AddGameDirectory unconditionally redirects `com_gamedir` (and therefore
every COM_WriteFile caller -- config.cfg, saves, screenshots) to
`<homedir>/<mounted-dir-basename>` on EVERY mount, including ones a runtime
`game` command makes. Every w_*.ts driver that can reach Host_Game_f (New
Game, Add-Ons, Start Server) MUST pass `-homedir`, W_HOMEDIR below, in
addition to its initial `-game e2e_w`.
*/
export const W_HOMEDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/w_home`;

function shotFiles(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/** Runs `screenshot` and renames the new file to <SHOTDIR>/<name>.<ext>. Reads
 * the active gamedir from common.ts's own `com_gamedir` at call time, since
 * this family's drivers boot several different -game/-basedir combinations. */
export function shot(name: string): string | null {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const dir = com_gamedir;
  const before = shotFiles(dir);
  exec("screenshot", 2);
  frames(2);
  const after = shotFiles(dir);
  for (const f of after) {
    if (!before.has(f)) {
      const ext = f.slice(f.lastIndexOf("."));
      const dest = `${SHOTDIR}/${name}${ext}`;
      copyFileSync(`${dir}/${f}`, dest);
      unlinkSync(`${dir}/${f}`);
      console.log(`  [shot] ${name}${ext}`);
      return dest;
    }
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}

// ---- PCX/TGA decode (screen.c's WritePCXfile / gl_screen.c's TGA writer) --
// Duplicated from test/e2e/l_resize.ts's own local copy (that family's own
// header note applies here too: both are the engine's own writers, RLE'd
// 8-bit-indexed PCX for the software refresh and uncompressed 24-bit BGR TGA,
// rows bottom-to-top, for GL) rather than importing across family boundaries.
export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array; // width*height*3, top row first
}

function decodePCX(bytes: Uint8Array): DecodedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xmin = view.getUint16(4, true);
  const ymin = view.getUint16(6, true);
  const xmax = view.getUint16(8, true);
  const ymax = view.getUint16(10, true);
  const bytesPerLine = view.getUint16(66, true);
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;

  const palOffset = bytes.length - 768;
  const indices = new Uint8Array(width * height);
  let src = 128;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < bytesPerLine && src < palOffset) {
      let value = bytes[src++];
      let runLength = 1;
      if ((value & 0xc0) === 0xc0) {
        runLength = value & 0x3f;
        value = bytes[src++];
      }
      for (let i = 0; i < runLength && x < bytesPerLine; i++, x++) {
        if (x < width) indices[y * width + x] = value;
      }
    }
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const p = palOffset + indices[i] * 3;
    rgb[i * 3 + 0] = bytes[p + 0];
    rgb[i * 3 + 1] = bytes[p + 1];
    rgb[i * 3 + 2] = bytes[p + 2];
  }
  return { width, height, rgb };
}

function decodeTGA(bytes: Uint8Array): DecodedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bpp = bytes[16];
  const pixelBytes = bpp / 8;
  let src = 18 + idLength;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const b = bytes[src];
      const g = bytes[src + 1];
      const r = bytes[src + 2];
      src += pixelBytes;
      const dst = (y * width + x) * 3;
      rgb[dst + 0] = r;
      rgb[dst + 1] = g;
      rgb[dst + 2] = b;
    }
  }
  return { width, height, rgb };
}

export function decodeShot(path: string): DecodedImage {
  const bytes = new Uint8Array(readFileSync(path));
  return path.toLowerCase().endsWith(".tga") ? decodeTGA(bytes) : decodePCX(bytes);
}

/** Height in pixel rows of the first horizontal run of "lit" (non-background)
 * pixels found scanning down column `x` starting at `y0` -- used to measure
 * one console glyph's real on-screen height at a given scr_conscale. */
export function litRunHeight(img: DecodedImage, x: number, y0: number, maxRows: number): number {
  let started = false;
  let rows = 0;
  for (let y = y0; y < Math.min(img.height, y0 + maxRows); y++) {
    const p = (y * img.width + x) * 3;
    const lit = img.rgb[p] > 8 || img.rgb[p + 1] > 8 || img.rgb[p + 2] > 8;
    if (lit) {
      started = true;
      rows++;
    } else if (started) {
      break;
    }
  }
  return rows;
}

// ---- SDL event injection (real events, real pump; see g_lib.ts) -----------
export function push(event: Uint8Array): boolean {
  return SDL_PushTestEvent(event) === 1;
}
export function pump(): void {
  Sys_SendKeyEvents();
}
export function sdlTap(sym: number, n = 1): void {
  push(SDL_MakeKeyEvent(sym, true));
  push(SDL_MakeKeyEvent(sym, false));
  pump();
  frames(n);
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
export { SDL_DrainEventsForTests as drain };

// ---- game controller test seam (src/platform/sdl.ts) ---------------------
export {
  SDL_MakeControllerButtonEvent,
  SDL_MakeControllerAxisEvent,
  SDL_InjectFakeGamepadForTests,
  SDL_RemoveFakeGamepadForTests,
  SDL_SetFakeGamepadStateForTests,
  SDL_GamepadAxisStateForTests,
};

// ---- isolated re-release basedir mirror -----------------------------------
// Some scenarios (the loc `_mod` overlay test) need to mount a SYNTHETIC
// gamedir the real retail tree does not ship, without writing anything into
// Q1TS_DATA (standing orders / this unit's brief: retail directories are
// never touched). `-game <dir>` always resolves under whichever basedir is
// active (src/common/common.ts's resolveGameDir), so the only way to add a
// wholly-new gamedir is to boot against a private basedir of our own --
// mirrors test/e2e/e_lib.ts's/o_qwcl_video.ts's own "build an isolated
// basedir under scratch, symlink the real content back in" pattern (see
// test/e2e/README.md's "Retail data" section on family E).
export function buildScratchRereleaseRoot(scratchDir: string, name: string): string {
  const root = `${scratchDir}/${name}`;
  const rerelease = `${root}/rerelease`;
  mkdirSync(rerelease, { recursive: true });
  const kpfLink = `${rerelease}/QuakeEX.kpf`;
  if (!existsSync(kpfLink)) symlinkSync(`${BASE}/rerelease/QuakeEX.kpf`, kpfLink);
  const id1Link = `${rerelease}/id1`;
  if (!existsSync(id1Link)) symlinkSync(`${BASE}/rerelease/id1`, id1Link);
  return root;
}

/** Writes `content` to `<root>/rerelease/<gamedir>/<relPath>`, creating every
 * intermediate directory -- for the synthetic content a scratch-root
 * scenario mounts via `-game <gamedir>`. */
export function writeScratchGameFile(root: string, gamedir: string, relPath: string, content: string): string {
  const full = `${root}/rerelease/${gamedir}/${relPath}`;
  const dir = full.slice(0, full.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, "latin1");
  return full;
}
