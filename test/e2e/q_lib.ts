// Harness helpers for the Q end-to-end agent (family q: video modes, renderer
// switches, window events, screenshots, both renderers -- .orch/briefs/
// E11-video-platform.md). Not a bun:test suite; each q_*.ts scenario is a
// standalone script run with `bun test/e2e/q_<name>.ts [args...]`, matching
// every other lettered family's own <letter>_lib.ts (a_lib.ts/b_lib.ts/
// g_lib.ts). Self-contained rather than importing another family's lib file:
// six other units are editing their own test/e2e files concurrently (E2E-
// COMMON.md), so this file talks to src/ directly instead of depending on
// another family's in-flight helpers.
import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import * as common from "../../src/common/common";
import { Cvar_SetValue, Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Sys_SendKeyEvents } from "../../src/platform/sys";
import { keyState, KeydestT } from "../../src/client/keys";
import { vid } from "../../src/client/vid";
import { cl, cl_entities } from "../../src/client/client";
import { sv } from "../../src/server/server";
import { decodeTGA } from "../../src/lib/tga";
import {
  SDL_MakeWindowEvent,
  SDL_MakeQuitEvent,
  SDL_PushTestEvent,
  SDL_DrainEventsForTests,
  SDL_InputStateForTests,
  SDL_TEST_WINDOWEVENT_SIZE_CHANGED,
  SDL_TEST_WINDOWEVENT_FOCUS_GAINED,
  SDL_TEST_WINDOWEVENT_FOCUS_LOST,
  SDL_TEST_WINDOWEVENT_CLOSE,
} from "../../src/platform/sdl";
import { Q1TS_DATA, classicArgv, homedirArgs } from "./q1data";

export const BASEDIR = Q1TS_DATA;
export const GAME = "e2e_q";
/** Where the engine writes (screenshots, config): the live com_gamedir, which
    since F3 is the per-user home directory's <game> mirror unless -nohomedir or
    -homedir says otherwise -- never assume $Q1TS_DATA/<game>. */
export function gamedir(): string {
  return common.com_gamedir;
}
export const SCRATCH = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";

// ---- pass/fail bookkeeping -------------------------------------------------
// E2E-COMMON.md's driver contract: "[PASS] name :: note" / "[FAIL] name ::
// note" lines plus a final "RESULT <pass> <fail>" line, non-zero exit on any
// failure.
export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/** Prints the final RESULT line and returns the failure count. */
export function finish(label: string): number {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n--- ${label}: ${results.length - bad.length}/${results.length} passed ---`);
  for (const f of bad) console.log(`  FAIL ${f.name} :: ${f.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  return bad.length;
}

// ---- boot / frame pump -----------------------------------------------------

export function boot(extra: string[]): void {
  // H1: the family home is passed explicitly (homedirArgs) instead of relying on the per-user default
  Sys_Main_Init(classicArgv(["quake", "-basedir", BASEDIR, ...homedirArgs(GAME), "-game", GAME, "-nosound", ...extra]));
}

export function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

export function exec(text: string, n = 2): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n);
}

export function pump(): void {
  Sys_SendKeyEvents();
}

// ---- SDL test-event injection (dummy driver; no real window system) -------
// Same technique test/e2e/g_lib.ts uses for its own family (SDL_PushEvent
// onto SDL's real queue, drained by src/platform/sdl.ts's own pump) --
// reimplemented locally (see file header) rather than imported.

export function push(event: Uint8Array): boolean {
  return SDL_PushTestEvent(event) === 1;
}

export function drain(): number {
  return SDL_DrainEventsForTests();
}

export function inputState(): ReturnType<typeof SDL_InputStateForTests> {
  return SDL_InputStateForTests();
}

export function windowEvent(ev: number, data1 = 0, data2 = 0): boolean {
  return push(SDL_MakeWindowEvent(ev, data1, data2));
}

export function quitEvent(): boolean {
  return push(SDL_MakeQuitEvent());
}

export {
  SDL_TEST_WINDOWEVENT_SIZE_CHANGED,
  SDL_TEST_WINDOWEVENT_FOCUS_GAINED,
  SDL_TEST_WINDOWEVENT_FOCUS_LOST,
  SDL_TEST_WINDOWEVENT_CLOSE,
};

// SDL2's own SDL_WindowEventID enum value for SDL_WINDOWEVENT_MINIMIZED (9).
// src/platform/sdl.ts's SDL_PumpInput switch on SDL_WINDOWEVENT only decodes
// SIZE_CHANGED(6)/FOCUS_GAINED(12)/FOCUS_LOST(13)/CLOSE(14) -- there is no
// SDL_TEST_WINDOWEVENT_MINIMIZED constant exported because nothing consumes
// event 9 today; used as a raw literal by q_window.ts to probe exactly that
// gap.
export const SDL_WINDOWEVENT_MINIMIZED_RAW = 9;

/* Reads a value back at its declared type -- same idiom as g_lib.ts's/
   b_lib.ts's own asDest/asBool: a plain `x === CONST` right after `x =
   OTHER_CONST` a few statements earlier is folded away by TypeScript's
   control-flow narrowing, since the engine mutates these through calls TS
   cannot see. */
export function asDest(v: KeydestT): KeydestT {
  return v;
}
export function asBool(v: boolean): boolean {
  return v;
}

export { keyState, KeydestT, Cvar_SetValue, Cvar_VariableString, Cvar_VariableValue, cl, cl_entities, sv };

// ---- player state helpers ---------------------------------------------------

export function svPlayerOrigin(): [number, number, number] {
  const ed = sv.edicts[1];
  if (!ed) return [NaN, NaN, NaN];
  const o = ed.v.origin;
  return [o[0], o[1], o[2]];
}

// ---- screenshots ------------------------------------------------------------

function shotFiles(): Set<string> {
  const dir = gamedir();
  if (!dir || !existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/** Runs `screenshot` and renames the new file to <shotDir>/<name>.<ext>. `dt`
    is the elapsed-time-per-frame passed to the settle frames around the
    command (default 0.05, matching every other family's own shot() helper).
    For a pair of shots meant to be pixel-diffed against each other (e.g. the
    same cvar toggled twice, isolating its effect from realtime-driven
    animation -- torch flicker, sky scroll), pass the SMALLEST dt that still
    clears host.ts's Host_FilterTime floor (`host.realtime - host.oldrealtime
    < 1/72` is dropped, "framerate is too high"), never 0: a dt of exactly 0
    never clears that floor at all, so every frame is silently dropped
    -- including the "screenshot" console command itself, which then fires
    late, on whatever later frame elsewhere finally clears the floor. */
export function shot(name: string, shotDir: string, dt = 0.05): string | null {
  if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });
  const before = shotFiles();
  Cbuf_AddText("screenshot\n");
  frames(2, dt);
  frames(2, dt);
  for (const f of shotFiles()) {
    if (before.has(f)) continue;
    const ext = f.slice(f.lastIndexOf("."));
    const dest = `${shotDir}/${name}${ext}`;
    copyFileSync(`${gamedir()}/${f}`, dest);
    unlinkSync(`${gamedir()}/${f}`);
    console.log(`  [shot] ${dest}`);
    return dest;
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}

// ---- image decoding ---------------------------------------------------------
// The engine's own two screenshot writers (grepped under src/, per this
// unit's brief): ref_soft/ref_soft.ts's WritePCXfile (8-bit indexed, RLE'd,
// same shape as WinQuake's screen.c) and ref_gl/ref_gl.ts's SCR_ScreenShot_f
// (uncompressed 24-bit BGR TGA, rows bottom-to-top, gl_screen.c's
// TargaHeader). Neither renderer writes PNG in this port -- src/lib/png.ts
// is a decode-only asset loader for replacement textures, unrelated to the
// screenshot path -- so the PCX half below is hand-rolled (no src/lib
// decoder exists for it, same as test/e2e/l_resize.ts's own inline
// decodePCX) and the TGA half reuses src/lib/tga.ts's decodeTGA, per the
// brief's "(use src/lib/png.ts / tga reader)" for whichever of the two
// actually applies.

export interface Image {
  width: number;
  height: number;
  rgb: Uint8Array; // width*height*3, top row first
}

function decodePCX(bytes: Uint8Array): Image {
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

function fromDecodedTga(bytes: Uint8Array): Image {
  const result = decodeTGA(bytes);
  if (!result.ok) throw new Error(`decodeTGA: ${result.reason}`);
  const { width, height, pixels } = result.image;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3 + 0] = pixels[i * 4 + 0];
    rgb[i * 3 + 1] = pixels[i * 4 + 1];
    rgb[i * 3 + 2] = pixels[i * 4 + 2];
  }
  return { width, height, rgb };
}

export function decode(path: string): Image {
  const bytes = new Uint8Array(readFileSync(path));
  return path.toLowerCase().endsWith(".tga") ? fromDecodedTga(bytes) : decodePCX(bytes);
}

/** Fraction of non-black pixels in the whole image (or a sub-rectangle). */
export function litFraction(img: Image, x0 = 0, y0 = 0, w = img.width, h = img.height): number {
  let lit = 0;
  let total = 0;
  for (let y = y0; y < y0 + h && y < img.height; y++) {
    for (let x = x0; x < x0 + w && x < img.width; x++) {
      if (x < 0 || y < 0) continue;
      const p = (y * img.width + x) * 3;
      total++;
      if (img.rgb[p] > 8 || img.rgb[p + 1] > 8 || img.rgb[p + 2] > 8) lit++;
    }
  }
  return total === 0 ? 0 : lit / total;
}

/** Mean of (R+G+B)/3 across the whole image (or a sub-rectangle). */
export function meanBrightness(img: Image, x0 = 0, y0 = 0, w = img.width, h = img.height): number {
  let sum = 0;
  let total = 0;
  for (let y = y0; y < y0 + h && y < img.height; y++) {
    for (let x = x0; x < x0 + w && x < img.width; x++) {
      if (x < 0 || y < 0) continue;
      const p = (y * img.width + x) * 3;
      sum += (img.rgb[p] + img.rgb[p + 1] + img.rgb[p + 2]) / 3;
      total++;
    }
  }
  return total === 0 ? 0 : sum / total;
}

/** Mean "redness bias" R - (G+B)/2 across the whole image (or a rectangle). */
export function meanRednessBias(img: Image, x0 = 0, y0 = 0, w = img.width, h = img.height): number {
  let sum = 0;
  let total = 0;
  for (let y = y0; y < y0 + h && y < img.height; y++) {
    for (let x = x0; x < x0 + w && x < img.width; x++) {
      if (x < 0 || y < 0) continue;
      const p = (y * img.width + x) * 3;
      sum += img.rgb[p] - (img.rgb[p + 1] + img.rgb[p + 2]) / 2;
      total++;
    }
  }
  return total === 0 ? 0 : sum / total;
}

/** Coarse box-downsample to cols x rows luma cells, for a structural-
    similarity comparison that tolerates renderer-to-renderer pixel noise
    (dithering, filtering) between two screenshots of the same viewpoint. */
export function downsampleLuma(img: Image, cols: number, rows: number): Float64Array {
  const out = new Float64Array(cols * rows);
  const cw = img.width / cols;
  const ch = img.height / rows;
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor(cy * ch);
    const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * ch));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor(cx * cw);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cw));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < img.height; y++) {
        for (let x = x0; x < x1 && x < img.width; x++) {
          const p = (y * img.width + x) * 3;
          sum += 0.299 * img.rgb[p] + 0.587 * img.rgb[p + 1] + 0.114 * img.rgb[p + 2];
          n++;
        }
      }
      out[cy * cols + cx] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/** Root-mean-square error between two same-length luma grids, 0..255 scale. */
export function rmse(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

export { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync };
