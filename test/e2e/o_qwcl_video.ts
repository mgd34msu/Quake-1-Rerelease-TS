/*
Driver for three qwcl (src/qw/main_cl.ts) defects reported off a real desktop
run:

  1. the video menu's Fullscreen toggle never produced a normal-sized window
  2. previous frames showed through while the client had no level up
  3. ESC in the video menu did not back out to the options menu

Not a bun:test suite -- a standalone script, because every assertion here is
about a REAL SDL window (its size and its SDL_WindowFlags) and a real frame
reaching it, which needs a real video driver:

  xvfb-run -a -s "-screen 0 1920x1080x24" env SDL_VIDEODRIVER=x11 \
    SDL_AUDIODRIVER=dummy bash -c \
    'openbox --sm-disable & sleep 1; timeout 180 bun test/e2e/o_qwcl_video.ts gl'
  xvfb-run -a -s "-screen 0 1920x1080x24" env SDL_VIDEODRIVER=x11 \
    SDL_AUDIODRIVER=dummy bash -c \
    'openbox --sm-disable & sleep 1; timeout 180 bun test/e2e/o_qwcl_video.ts soft'

The window manager inside the Xvfb display is not optional. SDL asks for
fullscreen through _NET_WM_STATE_FULLSCREEN, and a bare Xvfb has none to
answer: SDL waits, prints "Time out elapsed after mode switch on display N
with no window becoming fullscreen; reverting" and CLEARS the
SDL_WINDOW_FULLSCREEN_DESKTOP flag it was just asked for, so every fullscreen
assertion below would fail for a reason that has nothing to do with the
engine. Confirmed directly against libSDL2 with and without openbox running.

Env:
  Q1TS_DATA   the retail data the scratch basedir is built from (required)
  O_BASEDIR   engine -basedir (default the scratch copy, so no real config.cfg
              is ever rewritten by Host_WriteConfiguration on quit)
  O_SHOTDIR   where the renamed screenshots land
*/
import { readdirSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { Sys_Main_Init, runFrames } from "../../src/qw/main_cl";
import { Cbuf_AddText } from "../../src/common/cmd";
import { cmdHost, Cmd_Exists } from "../../src/common/cmd";
import { Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Sys_SendKeyEvents } from "../../src/platform/sys";
import { SDL_WindowStateForTests, SDL_MakeKeyEvent, SDL_PushTestEvent, SDL_SetWindowSizeForTests } from "../../src/platform/sdl";
import { keyState, KeydestT } from "../../src/client/keys";
import { vid } from "../../src/client/vid";
import { menuState, MStateT } from "../../src/qw/client/menu";
import { menuState as nqMenuState, MStateT as NqMStateT } from "../../src/client/menu";
import { VID_MenuCursor, VID_MenuSetCursorForTests } from "../../src/platform/vid_menu";
import { con_main, conState as qwConState, CON_TEXTSIZE } from "../../src/qw/client/console";
import { Q1TS_DATA } from "./q1data";

/*
The engine runs against a scratch -basedir built here, never the real one:
qwcl's Host_Init forces `-game qw`, and Host_WriteConfiguration rewrites
<basedir>/qw/config.cfg on every clean exit -- so pointing this driver at a
real data directory would edit the player's own bindings and video settings.
Id1 and qwprogs.dat are symlinked (read-only use), config.cfg is COPIED, and
screenshots land in the scratch qw/ directory.
*/
const QDATA = Q1TS_DATA;
const BASEDIR = process.env.O_BASEDIR ?? `${tmpdir()}/o_qwcl_video_base`;
const GAMEDIR = `${BASEDIR}/qw`; // qwcl's Host_Init forces `-game qw`
const SHOTDIR = process.env.O_SHOTDIR ?? `${tmpdir()}/o_qwcl_video_shots`;

function buildScratchBasedir(): void {
  if (process.env.O_BASEDIR) return; // caller supplied one; leave it alone
  mkdirSync(GAMEDIR, { recursive: true });
  for (const [src, dst] of [
    [`${QDATA}/Id1`, `${BASEDIR}/Id1`],
    [`${QDATA}/qw/qwprogs.dat`, `${GAMEDIR}/qwprogs.dat`],
  ]) {
    if (!existsSync(src) || existsSync(dst)) continue;
    symlinkSync(src, dst);
  }
  // copied, not linked: the engine rewrites it on exit
  if (existsSync(`${QDATA}/qw/config.cfg`)) copyFileSync(`${QDATA}/qw/config.cfg`, `${GAMEDIR}/config.cfg`);
}
buildScratchBasedir();

const REF = process.argv[2] === "soft" ? "soft" : "gl";

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

function win(): string {
  const w = SDL_WindowStateForTests();
  if (!w) return "(no window)";
  return `${w.width}x${w.height} flags=0x${w.flags.toString(16)}${w.fullscreenDesktop ? " FULLSCREEN_DESKTOP" : ""}${w.fullscreenExclusive ? " FULLSCREEN" : ""}`;
}

//=============================================================================
// console text, so the "allready defined" / "already defined" re-registration
// noise a renderer switch used to print can be asserted absent.

function conLines(): string[] {
  const t = con_main.text;
  const w = qwConState.con_linewidth;
  const total = qwConState.con_totallines;
  if (!t || w <= 0 || total <= 0) return [];
  const out: string[] = [];
  for (let i = con_main.current - total + 1; i <= con_main.current; i++) {
    if (i < 0) continue;
    let s = "";
    for (let x = 0; x < w; x++) {
      const idx = (i % total) * w + x;
      if (idx >= CON_TEXTSIZE) break;
      s += String.fromCharCode(t[idx] & 0x7f);
    }
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}
const conHas = (n: string): boolean => conLines().some((l) => l.includes(n));

//=============================================================================
// screenshots, so the "ghosting" report can be measured rather than described:
// two frames captured with nothing but the console up must be identical, and a
// full-console frame must not be showing whatever the renderer last drew.

function shotFiles(): Set<string> {
  if (!existsSync(GAMEDIR)) return new Set();
  return new Set(readdirSync(GAMEDIR).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/* `clear` first, then let three frames draw, THEN capture: SCR_ScreenShot_f
   reads back the frame the previous Host_Frame drew, and taking a shot itself
   Con_Printf's two lines ("COM_WriteFile: ..." / "Wrote quakeNN.pcx"), so
   without the wipe every capture would differ from the last by its own
   predecessor's console output rather than by anything the renderer did. */
function shotStableConsole(name: string): string | null {
  exec("clear", 1);
  frames(3);
  return shot(name);
}

function shot(name: string): string | null {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles();
  exec("screenshot", 2);
  frames(2);
  const after = shotFiles();
  for (const f of after) {
    if (before.has(f)) continue;
    const dst = `${SHOTDIR}/${name}.${f.split(".").pop()}`;
    copyFileSync(`${GAMEDIR}/${f}`, dst);
    return dst;
  }
  return null;
}

/* TGA (GL, bottom-up BGR) or PCX (software, RLE 8-bit + 768-byte palette) to
   one RGB byte array, so two shots can be compared pixel for pixel. */
function decode(path: string): { width: number; height: number; rgb: Uint8Array } | null {
  const buf = new Uint8Array(readFileSync(path));
  if (path.endsWith(".tga")) {
    const width = buf[12] | (buf[13] << 8);
    const height = buf[14] | (buf[15] << 8);
    const bpp = buf[16] / 8;
    const rgb = new Uint8Array(width * height * 3);
    let src = 18 + buf[0];
    for (let y = 0; y < height; y++) {
      const row = (height - 1 - y) * width * 3;
      for (let x = 0; x < width; x++) {
        rgb[row + x * 3 + 0] = buf[src + 2];
        rgb[row + x * 3 + 1] = buf[src + 1];
        rgb[row + x * 3 + 2] = buf[src + 0];
        src += bpp;
      }
    }
    return { width, height, rgb };
  }
  // PCX
  const xmin = buf[4] | (buf[5] << 8);
  const ymin = buf[6] | (buf[7] << 8);
  const xmax = buf[8] | (buf[9] << 8);
  const ymax = buf[10] | (buf[11] << 8);
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  const bytesPerLine = buf[66] | (buf[67] << 8);
  const pal = buf.length - 768;
  const idx = new Uint8Array(width * height);
  let src = 128;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < bytesPerLine && src < pal) {
      let b = buf[src++];
      let run = 1;
      if ((b & 0xc0) === 0xc0) {
        run = b & 0x3f;
        b = buf[src++];
      }
      for (let i = 0; i < run && x < bytesPerLine; i++, x++) {
        if (x < width) idx[y * width + x] = b;
      }
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const p = pal + idx[i] * 3;
    rgb[i * 3 + 0] = buf[p + 0];
    rgb[i * 3 + 1] = buf[p + 1];
    rgb[i * 3 + 2] = buf[p + 2];
  }
  return { width, height, rgb };
}

/* Fraction of pixels whose colour differs by more than `tol` on any channel. */
function diffFraction(a: string, b: string, tol = 8): number {
  const da = decode(a);
  const db = decode(b);
  if (!da || !db) return 1;
  if (da.width !== db.width || da.height !== db.height) return 1;
  let n = 0;
  for (let i = 0; i < da.rgb.length; i += 3) {
    if (
      Math.abs(da.rgb[i] - db.rgb[i]) > tol ||
      Math.abs(da.rgb[i + 1] - db.rgb[i + 1]) > tol ||
      Math.abs(da.rgb[i + 2] - db.rgb[i + 2]) > tol
    ) {
      n++;
    }
  }
  return n / (da.rgb.length / 3);
}

//=============================================================================
// key input, through the SDL pump (Sys_SendKeyEvents -> Key_Event), so the
// whole binding/menu route runs exactly as it does for a person at a keyboard.

const SDLK = { ESCAPE: 27, RETURN: 13, DOWN: 0x40000051, UP: 0x40000052, RIGHT: 0x4000004f, LEFT: 0x40000050, BACKQUOTE: 96 } as const;

function key(sym: number): void {
  SDL_PushTestEvent(SDL_MakeKeyEvent(sym, true));
  SDL_PushTestEvent(SDL_MakeKeyEvent(sym, false));
  Sys_SendKeyEvents();
  frames(2);
}

//=============================================================================

console.log(`=== o_qwcl_video (${REF}) basedir=${BASEDIR} ===`);

// No -width/-height: vid_x.c's own parms override the mode table at EVERY
// mode set (resolveMode re-reads them, as the C does), which would pin this
// run to one resolution and make `vid_mode` untestable. The scratch
// config.cfg's archived `vid_mode "3"` is the 640x480 this run starts at.
Sys_Main_Init(["qwcl", "-basedir", BASEDIR, "-vid_ref", REF]);
frames(10);

console.log(`  boot: vid=${vid.width}x${vid.height} window=${win()} vid_ref=${Cvar_VariableString("vid_ref")} vid_mode=${Cvar_VariableValue("vid_mode")} vid_fullscreen=${Cvar_VariableValue("vid_fullscreen")}`);

/*
Normalize the starting video state before anything is asserted, for two
reasons:

  - `-vid_ref` is read by VID_Init, which runs BEFORE Host_Init's
    `Cbuf_InsertText("exec quake.rc")` reaches config.cfg. An archived
    `vid_ref` in the config puts the CVAR back to its own value while the LIVE
    renderer stays the one the parm picked, so the next vid_restart silently
    switches renderers underneath you. Re-asserting it here makes the rest of
    this run actually test the renderer named on the command line.
  - Host_WriteConfiguration rewrites config.cfg on every clean exit, so
    whatever mode a previous run finished in is what the next one boots into.
    Pinning vid_mode/vid_fullscreen makes the run reproducible instead of
    dependent on its own history.
*/
exec(`vid_ref ${REF}`, 2);
exec("vid_mode 3", 2); // 640x480
exec("vid_fullscreen 0", 2);
exec("vid_restart", 12);
frames(6);
console.log(`  normalized to ${REF} / vid_mode 3 / windowed: vid=${vid.width}x${vid.height} window=${win()}`);

// ---------------------------------------------------------------- host init
check("cmdHost.initialized after Host_Init", cmdHost.initialized, "QW/client/cl_main.c:1499 `host_initialized = true`");

// ------------------------------------------------------------- (1) windowed
{
  const w = SDL_WindowStateForTests();
  check("the normalized window is not fullscreen", w !== null && !w.fullscreenDesktop && !w.fullscreenExclusive, win());
  check("the normalized window is vid_mode 3's 640x480", w !== null && w.width === 640 && w.height === 480, win());
}

// ------------------------------------------------------ (2) ghosting, no level
{
  keyState.key_dest = KeydestT.key_console;
  frames(10);
  const a = shotStableConsole("noworld_a");
  frames(6);
  const b = shotStableConsole("noworld_b");
  if (a && b) {
    const d = diffFraction(a, b);
    check("two console-only frames are identical (no alternating buffer)", d < 0.002, `diff=${(d * 100).toFixed(3)}% ${a} ${b}`);
  } else {
    check("two console-only frames are identical (no alternating buffer)", false, `shot failed a=${a} b=${b}`);
  }
}

// --------------------------------------------------------- (3) menu navigation
{
  keyState.key_dest = KeydestT.key_game;
  frames(2);
  exec("togglemenu", 2);
  check("togglemenu opens QW's main menu", menuState.m_state === MStateT.m_main, `qw m_state=${menuState.m_state}`);

  exec("menu_options", 2);
  check("menu_options -> QW m_options", menuState.m_state === MStateT.m_options, `qw m_state=${menuState.m_state}`);

  exec("menu_video", 2);
  check("menu_video -> QW m_video", menuState.m_state === MStateT.m_video, `qw m_state=${menuState.m_state}`);
  check("menu_video did not touch WinQuake's own menu state", nqMenuState.m_state === NqMStateT.m_none, `nq m_state=${nqMenuState.m_state}`);

  key(SDLK.ESCAPE);
  check("ESC in the video menu -> QW m_options", menuState.m_state === MStateT.m_options, `qw m_state=${menuState.m_state} nq m_state=${nqMenuState.m_state}`);

  key(SDLK.ESCAPE);
  check("ESC in options -> QW m_main", menuState.m_state === MStateT.m_main, `qw m_state=${menuState.m_state}`);

  key(SDLK.ESCAPE);
  check("ESC in main -> menu closed, key_dest game", menuState.m_state === MStateT.m_none && keyState.key_dest === KeydestT.key_game, `qw m_state=${menuState.m_state} key_dest=${keyState.key_dest}`);
}

// ------------------------------------------ (1) the menu's fullscreen toggle
{
  exec("menu_video", 2);
  VID_MenuSetCursorForTests(1); // the Fullscreen row
  check("video menu cursor on the Fullscreen row", VID_MenuCursor() === 1);

  key(SDLK.RIGHT); // toggle fullscreen on
  check("fullscreen toggle set vid_fullscreen 1", Cvar_VariableValue("vid_fullscreen") === 1, `vid_fullscreen=${Cvar_VariableValue("vid_fullscreen")}`);
  check("toggling the cvar alone did not change the window", (() => { const w = SDL_WindowStateForTests(); return w !== null && !w.fullscreenDesktop; })(), win());

  VID_MenuSetCursorForTests(3); // Apply
  key(SDLK.RETURN);
  frames(10);
  {
    const w = SDL_WindowStateForTests();
    check("Apply with vid_fullscreen 1 -> a fullscreen window", w !== null && (w.fullscreenDesktop || w.fullscreenExclusive), win());
  }
  check("no cvar/command re-registration noise on the mode change", !conHas("allready defined") && !conHas("already defined"), conLines().filter((l) => l.includes("defined")).slice(0, 3).join(" | "));

  VID_MenuSetCursorForTests(1);
  key(SDLK.LEFT); // toggle fullscreen off
  check("fullscreen toggle set vid_fullscreen 0", Cvar_VariableValue("vid_fullscreen") === 0, `vid_fullscreen=${Cvar_VariableValue("vid_fullscreen")}`);
  VID_MenuSetCursorForTests(3);
  key(SDLK.RETURN);
  frames(10);
  {
    const w = SDL_WindowStateForTests();
    check("Apply with vid_fullscreen 0 -> a windowed window", w !== null && !w.fullscreenDesktop && !w.fullscreenExclusive, win());
    check("windowed window is the vid_mode size, not the desktop's", w !== null && w.width === 640 && w.height === 480, `${win()} vid_mode=${Cvar_VariableValue("vid_mode")} vid=${vid.width}x${vid.height}`);
  }

  key(SDLK.ESCAPE);
  check("ESC out of the video menu after Apply", menuState.m_state === MStateT.m_options, `qw m_state=${menuState.m_state}`);
  key(SDLK.ESCAPE);
  key(SDLK.ESCAPE);
}

// ----------------------------------------------- console vid_fullscreen/restart
{
  exec("vid_fullscreen 1", 2);
  exec("vid_restart", 12);
  frames(6);
  {
    const w = SDL_WindowStateForTests();
    check("console `vid_fullscreen 1; vid_restart` -> fullscreen", w !== null && (w.fullscreenDesktop || w.fullscreenExclusive), win());
  }
  exec("vid_fullscreen 0", 2);
  exec("vid_restart", 12);
  frames(6);
  {
    const w = SDL_WindowStateForTests();
    check("console `vid_fullscreen 0; vid_restart` -> windowed 640x480", w !== null && !w.fullscreenDesktop && !w.fullscreenExclusive && w.width === 640 && w.height === 480, `${win()} vid=${vid.width}x${vid.height}`);
  }
  check("timerefresh still resolves after a vid_restart", Cmd_Exists("timerefresh"));
  check("still no re-registration noise after two vid_restarts", !conHas("allready defined") && !conHas("already defined"));
}

// ------------------------------------------- (2) ghosting again, after restarts
{
  keyState.key_dest = KeydestT.key_console;
  frames(10);
  const a = shotStableConsole("post_restart_a");
  frames(6);
  const b = shotStableConsole("post_restart_b");
  if (a && b) {
    const d = diffFraction(a, b);
    check("console-only frames still identical after vid_restart", d < 0.002, `diff=${(d * 100).toFixed(3)}%`);
  } else {
    check("console-only frames still identical after vid_restart", false, `shot failed a=${a} b=${b}`);
  }
}

// --------------------------------- (2) ghosting after a compositor resize
/*
The reported "ghosting when it can't render" is a tiling compositor's doing
plus one thing VID_SizeChanged does not redo. Hyprland tiles a new window to
the whole workspace, so the 640x480 mode lands in a desktop-sized drawable and
VID_SizeChanged adopts that size -- but the console background pic
(gl_draw.ts's `conback`, whose width/height are assigned from
vid.conwidth/conheight in Draw_Init, and draw.ts's software equivalent) is
sized once at Draw_Init and never again. A full console then paints only the
old mode's rectangle and the rest of the frame keeps whatever was last drawn
there.

Tested as an equivalence: the same final resolution reached two ways -- by
resizing the live window, and by a vid_mode change through vid_restart, which
DOES re-run Draw_Init -- must produce the same console-only frame.
*/
{
  keyState.key_dest = KeydestT.key_console;
  frames(4);

  // route A: resize the live window out from under the running mode, exactly
  // as a tiling compositor does at map time.
  const resized = SDL_SetWindowSizeForTests(1280, 720);
  frames(12);
  Sys_SendKeyEvents();
  frames(12);
  console.log(`  after SDL resize to 1280x720: vid=${vid.width}x${vid.height} window=${win()} resized=${resized}`);
  check("the resize reached the engine", vid.width === 1280 && vid.height === 720, `vid=${vid.width}x${vid.height}`);
  const a = shotStableConsole("resize_1280x720");

  // route B: the same resolution through the mode table (vid_mode 8 = 1280x720).
  exec("vid_mode 8", 2);
  exec("vid_restart", 14);
  frames(10);
  console.log(`  after vid_mode 8 + vid_restart: vid=${vid.width}x${vid.height} window=${win()}`);
  const b = shotStableConsole("modeset_1280x720");

  if (a && b) {
    const d = diffFraction(a, b);
    check("a resized 1280x720 console frame matches a mode-set 1280x720 one", d < 0.01, `diff=${(d * 100).toFixed(3)}% ${a} ${b}`);
  } else {
    check("a resized 1280x720 console frame matches a mode-set 1280x720 one", false, `shot failed a=${a} b=${b}`);
  }
}

//=============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n=== o_qwcl_video ${REF}: ${results.length - failed.length}/${results.length} passed ===`);
for (const f of failed) console.log(`  FAIL ${f.name} :: ${f.note}`);
process.exit(failed.length === 0 ? 0 : 1);
