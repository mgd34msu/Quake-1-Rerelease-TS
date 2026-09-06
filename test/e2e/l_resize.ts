/*
Driver for the window-resize defect: a Wayland compositor resized the game
window to 1181x502 while the engine kept rendering the 640x480 mode into it,
so the frame was cropped -- the status bar and the weapon model fell off the
bottom. src/platform/sdl.ts's pump decoded only FOCUS_GAINED/FOCUS_LOST/CLOSE
and dropped SDL_WINDOWEVENT_SIZE_CHANGED on the floor.

Not a bun:test suite -- a standalone script, run under a real X server so the
resize is a REAL one (SDL_SetWindowSize -> XResizeWindow -> ConfigureNotify ->
SDL_WINDOWEVENT_SIZE_CHANGED), not a synthesized event:

  xvfb-run -a -s "-screen 0 1280x720x24" env SDL_VIDEODRIVER=x11 \
    SDL_AUDIODRIVER=dummy bun test/e2e/l_resize.ts soft
  xvfb-run -a -s "-screen 0 1280x720x24" env SDL_VIDEODRIVER=x11 \
    SDL_AUDIODRIVER=dummy bun test/e2e/l_resize.ts gl

Each run boots `-vid_ref <soft|gl> -width 640 -height 480 +map start`,
screenshots the un-resized frame, resizes the window to 1181x502, screenshots
again, then opens the console, resizes to a third size and screenshots that.
Every shot is decoded (PCX for the software refresh, TGA for GL) and checked
for its dimensions and for a lit status-bar band along the bottom.

Env:
  Q1TS_DATA   engine -basedir (required; see test/e2e/q1data.ts)
  L_GAME      engine -game    (default e2e_l)
  L_SHOTDIR   where the renamed screenshots land
*/
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { re } from "../../src/client/render";
import { Sys_SendKeyEvents } from "../../src/platform/sys";
import { SDL_SetWindowSizeForTests, SDLGL_GetWindowSize } from "../../src/platform/sdl";
import { keyState, KeydestT } from "../../src/client/keys";
import { vid } from "../../src/client/vid";
import { Q1TS_DATA } from "./q1data";

const BASEDIR = Q1TS_DATA;
const GAME = process.env.L_GAME ?? "e2e_l";
const GAMEDIR = `${BASEDIR}/${GAME}`;
const SHOTDIR = process.env.L_SHOTDIR ?? `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/resize`;

const REF = process.argv[2] === "gl" ? "gl" : "soft";

const results: Array<{ name: string; pass: boolean; note: string }> = [];

function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

function exec(text: string, n = 2): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n);
}

function shotFiles(): Set<string> {
  if (!existsSync(GAMEDIR)) return new Set();
  return new Set(readdirSync(GAMEDIR).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

function shot(name: string): string | null {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles();
  exec("screenshot", 2);
  frames(2);
  for (const f of shotFiles()) {
    if (before.has(f)) continue;
    const ext = f.slice(f.lastIndexOf("."));
    const dest = `${SHOTDIR}/${REF}_${name}${ext}`;
    copyFileSync(`${GAMEDIR}/${f}`, dest);
    unlinkSync(`${GAMEDIR}/${f}`);
    console.log(`  [shot] ${dest}`);
    return dest;
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}

// ---- image decoding ------------------------------------------------------
// Both writers are the engine's own: screen.c's WritePCXfile (run-length
// encoded 8-bit indices, xmax/ymax at header offsets 8/10, a 0x0c-tagged
// 768-byte palette at the tail) and gl_screen.c's SCR_ScreenShot_f
// (uncompressed 24-bit BGR TGA, rows bottom-to-top).

interface Image {
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

function decodeTGA(bytes: Uint8Array): Image {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bpp = bytes[16];
  const pixelBytes = bpp / 8;
  let src = 18 + idLength;
  const rgb = new Uint8Array(width * height * 3);
  // TGA origin is bottom-left, so the first row in the file is the LAST row
  // of the image (gl_screen.c writes glReadPixels' output straight through,
  // which has the same bottom-up order).
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

function decode(path: string): Image {
  const bytes = new Uint8Array(readFileSync(path));
  return path.toLowerCase().endsWith(".tga") ? decodeTGA(bytes) : decodePCX(bytes);
}

/* Fraction of non-black pixels in a rectangle. */
function litFraction(img: Image, x0: number, y0: number, w: number, h: number): number {
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

// screen.c: `sb_lines = 24 + 16` at the default scr_viewsize, of which the
// bottom 24 rows are sbar.lmp itself -- a 320-wide pic centred in the window,
// drawn over Draw_TileClear's backtile whenever vid.width > 320.
const SBAR_HEIGHT = 24;
const SBAR_WIDTH = 320;

function checkShot(label: string, path: string | null, wantW: number, wantH: number): void {
  if (path === null) {
    check(`${label}: screenshot written`, false, "no file");
    return;
  }
  const img = decode(path);
  check(`${label}: screenshot is ${wantW}x${wantH}`, img.width === wantW && img.height === wantH, `got ${img.width}x${img.height}`);

  const bandX = Math.max(0, ((img.width - SBAR_WIDTH) / 2) | 0);
  const bandY = img.height - SBAR_HEIGHT;
  const sbar = litFraction(img, bandX, bandY, Math.min(SBAR_WIDTH, img.width), SBAR_HEIGHT);
  const bottomRows = litFraction(img, 0, img.height - 4, img.width, 4);
  check(`${label}: status bar drawn in the bottom ${SBAR_HEIGHT} rows`, sbar > 0.7, `sbar band lit=${sbar.toFixed(3)}`);
  check(`${label}: bottom rows of the frame are not black`, bottomRows > 0.5, `bottom-4-rows lit=${bottomRows.toFixed(3)}`);
}

/* A real resize: SDL resizes the X window, the server sends ConfigureNotify
   back, SDL turns that into SDL_WINDOWEVENT_SIZE_CHANGED, and the engine's
   own pump picks it up on the next Sys_SendKeyEvents. */
function resizeWindow(width: number, height: number): void {
  const ok = SDL_SetWindowSizeForTests(width, height);
  console.log(`  [resize] SDL_SetWindowSize(${width}, ${height}) -> ${ok}`);
  for (let i = 0; i < 20; i++) {
    Sys_SendKeyEvents();
    frames(1);
    if (vid.width === width && vid.height === height) break;
  }
  const win = SDLGL_GetWindowSize();
  console.log(`  [resize] window=${win.width}x${win.height} vid=${vid.width}x${vid.height} recalc_refdef=${vid.recalc_refdef}`);
}

// ---- run -----------------------------------------------------------------

if (!existsSync(GAMEDIR)) mkdirSync(GAMEDIR, { recursive: true });

Sys_Main_Init(["quake", "-basedir", BASEDIR, "-game", GAME, "-vid_ref", REF, "-nosound", "-width", "640", "-height", "480"]);
frames(5);
// quake.rc's `exec config.cfg` runs long after VID_Init has chosen the
// refresh, and the shared basedir's Id1/config.cfg carries `vid_ref "gl"` /
// `vid_mode "8"` from another family's run -- so the CVAR is not what is
// live. The renderer object is.
const activeIsGL = re.current?.isGL === true;
console.log(`  BOOT ${vid.width}x${vid.height} active=${activeIsGL ? "gl" : "soft"} vid_ref cvar=${Cvar_VariableString("vid_ref")} vid_mode=${Cvar_VariableValue("vid_mode")}`);
check("boot: -width/-height parms sized the mode", vid.width === 640 && vid.height === 480, `${vid.width}x${vid.height}`);
if (activeIsGL !== (REF === "gl")) {
  console.log(`  ABORT: asked for ${REF}, got ${activeIsGL ? "gl" : "soft"} -- no such refresh on this video driver`);
  process.exit(2);
}
const bootVidMode = Cvar_VariableValue("vid_mode");

exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(30);

checkShot("before resize", shot("before"), 640, 480);

// the size the report came in at
resizeWindow(1181, 502);
check("in-game resize: vid.width/height adopted the new drawable", vid.width === 1181 && vid.height === 502, `${vid.width}x${vid.height}`);
frames(20);
checkShot("after resize to 1181x502", shot("after"), 1181, 502);

// a resize while the console is up has to reformat and redraw it, not leave
// the old frame's pixels around the edges (Con_CheckResize runs off
// vid.recalc_refdef through SCR_CalcRefdef)
exec("toggleconsole", 4);
frames(6);
resizeWindow(900, 700);
check("console-up resize: vid.width/height adopted the new drawable", vid.width === 900 && vid.height === 700, `${vid.width}x${vid.height}`);
frames(20);
const conPath = shot("console");
if (conPath === null) check("console-up resize: screenshot written", false, "no file");
else {
  const img = decode(conPath);
  check("console-up resize: screenshot is 900x700", img.width === 900 && img.height === 700, `got ${img.width}x${img.height}`);
  // the console occupies the top half and draws the conback pic plus text
  const top = litFraction(img, 0, 0, img.width, 40);
  check("console-up resize: the console redrew across the new width", top > 0.5, `top-40-rows lit=${top.toFixed(3)}`);
}

// the resize must not have rewritten the user's requested mode: vid_mode is
// untouched, and the next vid_restart goes back to what the cvars and the
// -width/-height parms resolve to
check("resize left vid_mode alone", Cvar_VariableValue("vid_mode") === bootVidMode, `vid_mode=${Cvar_VariableValue("vid_mode")} (boot ${bootVidMode})`);
exec("toggleconsole", 4);
keyState.key_dest = KeydestT.key_game;
exec(`vid_ref ${REF}`, 2);
exec("vid_restart", 30);
check("vid_restart returns to the -width/-height mode", vid.width === 640 && vid.height === 480, `${vid.width}x${vid.height}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n--- ${REF}: ${results.length - failed.length}/${results.length} passed ---`);
for (const f of failed) console.log(`  FAIL ${f.name} :: ${f.note}`);
process.exit(failed.length === 0 ? 0 : 1);
