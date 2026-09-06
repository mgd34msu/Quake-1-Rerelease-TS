/*
Driver for the GL `vid_restart` texture-id defect: after a runtime renderer
restart, walls sampled the lightmap atlas and the sky patch sampled a
fragment of another texture, because gl_rsurf.c's `lightmap_textures` and
gl_warp.c's `solidskytexture`/`alphaskytexture` survive the restart behind
their `if (!x)` guards while the caches and the name counter were rewound
under them (see gl_rmisc.ts's GL_ClearTextureState).

Not a bun:test suite -- a standalone script, run as

  bun test/e2e/i_gl_restart.ts <scenario> <shotname> [engine args...]

Scenarios (each one loads `map start`, settles, then screenshots):
  fresh     no restart at all -- the reference frame every other shot is
            compared against
  restart1  one `vid_restart`
  restart3  three `vid_restart`s back to back
  softtrip  gl -> soft -> gl, each leg through `vid_ref X; vid_restart`
  modeN     `vid_mode N; vid_restart` -- the console equivalent of the video
            menu's Apply (menu.c's M_Menu_Video_f -> VID_MenuKey ->
            vid_menu.ts, which applies through exactly those two cvars)
  menu      the video menu driven with real key events from inside a running
            level: ESC, Options, Video Options, bump the mode row, Apply

Env:
  I_PRERESTART=1  run one `vid_restart` BEFORE `map start`, i.e. the video
              menu opened from the main menu with no level loaded
  I_PREPAD    extra frames burned before the scenario runs, so a `fresh`
              reference can be put at the same animation phase as the
              restart shot it is compared against
  Q1TS_DATA   engine -basedir (required; see test/e2e/q1data.ts)
  I_GAME      engine -game    (default e2e_b)
  I_SHOTDIR   where the renamed .tga lands
*/
import { readdirSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Key_Event, keyState, KeydestT } from "../../src/client/keys";
import { K_DOWNARROW, K_ENTER, K_ESCAPE, K_RIGHTARROW } from "../../src/client/keys";
import { vid } from "../../src/client/vid";
import { cl } from "../../src/client/client";
import { glState } from "../../src/ref_gl/glquake";
import { glWarpState } from "../../src/ref_gl/gl_warp";
import { VID_MenuCursor } from "../../src/platform/vid_menu";
import { Q1TS_DATA } from "./q1data";

const BASEDIR = Q1TS_DATA;
const GAME = process.env.I_GAME ?? "e2e_b";
const GAMEDIR = `${BASEDIR}/${GAME}`;
const SHOTDIR = process.env.I_SHOTDIR ?? `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/glrestart`;

function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

function exec(text: string, n = 2): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n);
}

function tap(k: number): void {
  Key_Event(k, true);
  Key_Event(k, false);
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
    const dest = `${SHOTDIR}/${name}${ext}`;
    copyFileSync(`${GAMEDIR}/${f}`, dest);
    unlinkSync(`${GAMEDIR}/${f}`);
    console.log(`  [shot] ${dest}`);
    return dest;
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}

function ids(label: string): void {
  console.log(
    `  [ids ${label}] texext=${glState.texture_extension_number} lightmap=${glState.lightmap_textures} ` +
      `solidsky=${glWarpState.solidskytexture} alphasky=${glWarpState.alphaskytexture} ` +
      `particle=${glState.particletexture} player=${glState.playertextures} current=${glState.currenttexture}`,
  );
}

const argv = process.argv.slice(2);
const scenario = argv[0] ?? "fresh";
const name = argv[1] ?? scenario;
const engineArgs = argv.slice(2);

Sys_Main_Init(["quake", "-basedir", BASEDIR, "-game", GAME, "-vid_ref", "gl", ...engineArgs]);
frames(5);
console.log(`  BOOT ${vid.width}x${vid.height} vid_ref=${Cvar_VariableString("vid_ref")} vid_mode=${Cvar_VariableValue("vid_mode")}`);
if (Cvar_VariableString("vid_ref") !== "gl") {
  console.log("  ABORT: vid_ref fell back off gl -- no GL context on this video driver");
  process.exit(2);
}

exec("disconnect", 3);
// The video menu is most often opened from the main menu, i.e. with no level
// up at all -- VID_CheckChanges's `restartLevel` is false there, so nothing
// re-runs R_NewMap and the ids zeroed by GL_ClearTextureState have to be
// re-minted by the NEXT map load instead.
if (process.env.I_PRERESTART === "1") {
  exec("vid_restart", 20);
  ids("after pre-map vid_restart");
}
exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(40);
// Every animated thing in the frame -- the two sky layers (gl_warp.c's
// speedscale = realtime*8/*16), the torch flames, the teleporter -- is driven
// by host.realtime, which runFrames advances by a fixed dt per frame. A
// restart scenario burns more frames than `fresh` does, so `fresh` is padded
// with the same count to put the reference frame at the same animation phase;
// without it the sky's scroll offset alone dominates the RMSE.
frames(Number(process.env.I_PREPAD ?? 0));
ids("after map start");

switch (scenario) {
  case "fresh":
    break;
  case "restart1":
    exec("vid_restart", 20);
    break;
  case "restart3":
    exec("vid_restart", 20);
    exec("vid_restart", 20);
    exec("vid_restart", 20);
    break;
  case "softtrip":
    exec("vid_ref soft", 2);
    exec("vid_restart", 20);
    console.log(`  after soft leg: vid_ref=${Cvar_VariableString("vid_ref")}`);
    exec("vid_ref gl", 2);
    exec("vid_restart", 20);
    break;
  case "menu": {
    // The video menu really is reached this way: menu.c's M_Main_Key walks
    // m_main_cursor to "Options" (row 2), M_Options_Key's row 12 is
    // "Video Options" (M_Menu_Video_f), and vid_menu.ts's own four rows are
    // mode / fullscreen / renderer / Apply, Apply calling VID_CheckChanges()
    // -- the same function `vid_restart` calls.
    tap(K_ESCAPE);
    frames(4);
    tap(K_DOWNARROW); // Single Player -> Multiplayer
    tap(K_DOWNARROW); // -> Options
    frames(2);
    tap(K_ENTER);
    frames(4);
    for (let i = 0; i < 12; i++) tap(K_DOWNARROW); // -> Video Options
    frames(2);
    tap(K_ENTER);
    frames(6);
    console.log(`  video menu cursor=${VID_MenuCursor()} vid_mode=${Cvar_VariableValue("vid_mode")}`);
    // Cursor starts on the mode row: bump the mode, then walk to Apply.
    tap(K_RIGHTARROW);
    frames(2);
    console.log(`  mode row now vid_mode=${Cvar_VariableValue("vid_mode")}`);
    tap(K_DOWNARROW); // -> Fullscreen
    tap(K_DOWNARROW); // -> Renderer
    tap(K_DOWNARROW); // -> Apply
    frames(2);
    console.log(`  apply row cursor=${VID_MenuCursor()}`);
    tap(K_ENTER); // Apply -> VID_CheckChanges()
    frames(30);
    exec("togglemenu", 2);
    keyState.key_dest = KeydestT.key_game;
    frames(10);
    break;
  }
  default: {
    const m = /^mode(\d+)$/.exec(scenario);
    if (!m) {
      console.log(`  ABORT: unknown scenario ${scenario}`);
      process.exit(3);
    }
    exec(`vid_mode ${m[1]}`, 2);
    exec("vid_restart", 20);
    break;
  }
}

keyState.key_dest = KeydestT.key_game;
// `vid_restart` Con_Printf's the new context's GL_EXTENSIONS string and the
// mode line, which the console's notify rows then draw over the top of the
// frame -- a console artifact, not a renderer one, and it would swamp the
// RMSE comparison against the un-restarted reference.
exec("clear", 1);
frames(Number(process.env.I_SETTLE_FRAMES ?? 40));
ids(`after ${scenario}`);
console.log(`  FINAL ${vid.width}x${vid.height} vid_ref=${Cvar_VariableString("vid_ref")} levelname=${JSON.stringify(cl.levelname)}`);
shot(name);
process.exit(0);
