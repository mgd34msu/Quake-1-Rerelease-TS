/*
Q3 -- SDL window events (resize, focus loss/gain, minimize, quit), injected
the way test/e2e/g_lib.ts's own family injects them: pushed straight onto
SDL's real event queue (SDL_PushEvent) and drained through the engine's own
pump (src/platform/sdl.ts's SDL_PumpInput), never a real windowing system --
matches this family's dummy-driver-only scope (no xvfb dependency, unlike
test/e2e/l_resize.ts's real-X11 resize scenario).

  resize        -- viewport adopts the new size; scr_sbarscale's clamp ceiling
                   (kfont_text.ts's SbarScale, the "scr_sbarscale auto" rule
                   src/client/sbar.ts draws the status bar through) moves with
                   the new vid.width.
  focus loss    -- stops mouse capture (src/platform/sdl.ts's
                   SDL_AppActivate -> IN_DeactivateMouse).
  minimize      -- probes whether SDL_WINDOWEVENT_MINIMIZED does anything at
                   all (see this file's own check for what was found).
  quit          -- `quit` at the console runs Host_Shutdown, which writes
                   config.cfg into the -game dir with whatever cvars changed
                   before the quit.

Not a bun:test suite -- run as:

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/q_window.ts

The quit scenario re-execs this same file as a child process (`--quit-child`)
because Sys_Quit calls process.exit() synchronously from inside Host_Shutdown
-- nothing after that point in the same process would ever run.

Env:
  Q1TS_DATA     engine -basedir (required; see test/e2e/q1data.ts)
*/
import {
  boot,
  frames,
  exec,
  check,
  finish,
  drain,
  pump,
  inputState,
  windowEvent,
  SDL_TEST_WINDOWEVENT_SIZE_CHANGED,
  SDL_TEST_WINDOWEVENT_FOCUS_GAINED,
  SDL_TEST_WINDOWEVENT_FOCUS_LOST,
  SDL_WINDOWEVENT_MINIMIZED_RAW,
  keyState,
  KeydestT,
  Cvar_SetValue,
  Cvar_VariableValue,
  asBool,
  GAME,
  gamedir,
} from "./q_lib";
import { IN_Commands } from "../../src/platform/sdl";
import { vid } from "../../src/client/vid";
import { SbarScale, scr_sbarscale } from "../../src/client/kfont_text";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// child mode: boots, changes an archived cvar, and quits -- run as its own
// process so the parent can assert on the exit code and the written
// config.cfg without racing Sys_Quit's own process.exit().
if (process.argv[2] === "--quit-child") {
  boot(["-vid_ref", "soft"]);
  frames(3);
  keyState.key_dest = KeydestT.key_console;
  Cvar_SetValue("vid_fullscreen", 1);
  frames(1);
  console.log(`CHILD: vid_fullscreen=${Cvar_VariableValue("vid_fullscreen")}`);
  console.log("CHILD: issuing quit");
  exec("quit", 3);
  console.log("CHILD: STILL ALIVE"); // must never print
  process.exit(1);
}

async function runChild(): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "test/e2e/q_window.ts", "--quit-child"], {
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const code = await proc.exited;
  return { code, out };
}

// ---------------------------------------------------------------------------
// main scenario

boot(["-vid_ref", "soft", "-width", "640", "-height", "480"]);
frames(5);
check("boot: -width/-height sized the mode", vid.width === 640 && vid.height === 480, `${vid.width}x${vid.height}`);

exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
exec("clear", 1);
frames(20);

// ---- 3a: resize --------------------------------------------------------
Cvar_SetValue("scr_sbarscale", 3);
frames(2);
const sbarScaleBefore = SbarScale();
check(
  "at 640 wide, scr_sbarscale 3 clamps to the resolution ceiling (640/320 = 2x), not the full request",
  sbarScaleBefore === 2,
  `SbarScale()=${sbarScaleBefore} scr_sbarscale=${scr_sbarscale.value} vid.width=${vid.width}`,
);

drain();
check("SDL accepts a synthesized SIZE_CHANGED(1280,960)", windowEvent(SDL_TEST_WINDOWEVENT_SIZE_CHANGED, 1280, 960), "");
pump();
frames(10);
check("resize: vid.width/height adopted the new size", vid.width === 1280 && vid.height === 960, `${vid.width}x${vid.height}`);

const sbarScaleAfter = SbarScale();
check(
  "resize widened the sbarscale ceiling so scr_sbarscale 3 is now honoured in full (\"scr_sbarscale auto\")",
  sbarScaleAfter === 3,
  `SbarScale()=${sbarScaleAfter} scr_sbarscale=${scr_sbarscale.value} vid.width=${vid.width}`,
);

// shrink back down and confirm the ceiling drops again
drain();
windowEvent(SDL_TEST_WINDOWEVENT_SIZE_CHANGED, 640, 480);
pump();
frames(10);
check("resize back down: vid.width/height track the new size", vid.width === 640 && vid.height === 480, `${vid.width}x${vid.height}`);
check("sbarscale ceiling shrinks back with the viewport", SbarScale() === 2, `SbarScale()=${SbarScale()}`);

// ---- 3b: focus loss / gain ----------------------------------------------
keyState.key_dest = KeydestT.key_game;
frames(3);
drain();
IN_Commands();
check("mouse captured while playing, focused", inputState().mouse_active, `mouse_active=${inputState().mouse_active}`);

check("SDL accepts FOCUS_LOST", windowEvent(SDL_TEST_WINDOWEVENT_FOCUS_LOST), "");
pump();
{
  const st = inputState();
  check("FOCUS_LOST clears windowActive", st.windowActive === false, `windowActive=${st.windowActive}`);
  check("FOCUS_LOST stops mouse capture (IN_DeactivateMouse)", st.mouse_active === false, `mouse_active=${st.mouse_active}`);
}
frames(2);
IN_Commands();
check("IN_Commands leaves the mouse released while unfocused", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);

drain();
check("SDL accepts FOCUS_GAINED", windowEvent(SDL_TEST_WINDOWEVENT_FOCUS_GAINED), "");
pump();
check("FOCUS_GAINED restores windowActive", inputState().windowActive === true, `windowActive=${inputState().windowActive}`);
IN_Commands();
check("IN_Commands re-captures the mouse once focused again", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);

// ---- 3c: minimize ---------------------------------------------------------
// SDL2's SDL_WindowEventID enum: SDL_WINDOWEVENT_MINIMIZED = 9. Real desktops
// send this alongside FOCUS_LOST when a window is minimized by its
// titlebar/taskbar, but not every window manager guarantees the pairing (an
// explicit "minimize" hotkey/gesture can deliver MINIMIZED alone), so it is
// exercised here on its own, with focus left untouched, to see whether the
// engine's own pump reacts to it independent of a focus change.
drain();
const beforeMinimize = inputState();
check("SDL accepts a synthesized MINIMIZED(9) event", windowEvent(SDL_WINDOWEVENT_MINIMIZED_RAW), "");
pump();
frames(3);
const afterMinimize = inputState();
check(
  "SDL_WINDOWEVENT_MINIMIZED on its own releases mouse capture / clears windowActive",
  asBool(afterMinimize.windowActive) === false || asBool(afterMinimize.mouse_active) === false,
  `windowActive ${beforeMinimize.windowActive}->${afterMinimize.windowActive}, mouse_active ${beforeMinimize.mouse_active}->${afterMinimize.mouse_active} -- src/platform/sdl.ts's SDL_PumpInput SDL_WINDOWEVENT switch has no case for event 9 (SDL_WINDOWEVENT_MINIMIZED), only SIZE_CHANGED(6)/FOCUS_GAINED(12)/FOCUS_LOST(13)/CLOSE(14) are decoded`,
);

// restore focus/capture for the remaining checks in this process
windowEvent(SDL_TEST_WINDOWEVENT_FOCUS_GAINED);
pump();
IN_Commands();

// ---- 3d: quit writes config.cfg with the changed cvar --------------------
// (SDL_WINDOWEVENT_CLOSE and a raw SDL_QUIT both funnel into the same
// Sys_Quit call this exercises via the console `quit` command; the two SDL
// event forms of the same exit path are family G's own coverage --
// test/e2e/g_s4_window.ts's child-process CLOSE/QUIT checks.)
const quitRun = await runChild();
check("quit at the console exits the process cleanly (status 0)", quitRun.code === 0, `exit=${quitRun.code}`);
check("quit does not fall through to the next statement", !quitRun.out.includes("STILL ALIVE"), quitRun.out.split("\n").filter((l) => l.startsWith("CHILD:")).join(" | "));

const configPath = `${gamedir()}/config.cfg`;
if (!existsSync(configPath)) {
  check("quit wrote config.cfg into the -game dir", false, `not found at ${configPath}`);
} else {
  const cfg = readFileSync(configPath, "utf8");
  check("quit wrote config.cfg into the -game dir", true, configPath);
  // Cvar_SetValue formats through `Com_sprintf("%f", value)` (common/
  // cvar.ts), byte-for-byte WinQuake's own `sprintf(val, "%f", value)` --
  // C's default %f is 6 decimal places, so "1" comes out as "1.000000".
  // Not a defect: this is the faithful, original formatting.
  check('config.cfg carries the changed cvar (vid_fullscreen "1.000000")', cfg.includes('vid_fullscreen "1.000000"'), cfg.split("\n").find((l) => l.includes("vid_fullscreen")) ?? "(not found)");
}

const fails = finish(`Q3 window events (-game ${GAME})`);
process.exit(fails === 0 ? 0 : 1);
