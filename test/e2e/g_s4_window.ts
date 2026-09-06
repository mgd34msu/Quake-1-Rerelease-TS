// G scenario 4 -- SDL window events and SDL_QUIT under the dummy driver.
import {
  BASE, boot, frames, exec, check, summary, pump, drain, inputState, sdlWindowEvent, SDLK, sdlTap, keyState,
} from "./g_lib";
import {
  IN_Commands, SDL_AppActivate,
  SDL_TEST_WINDOWEVENT_FOCUS_GAINED, SDL_TEST_WINDOWEVENT_FOCUS_LOST,
} from "../../src/platform/sdl";
import { KeydestT } from "../../src/client/keys";
import { Cvar_SetValue } from "../../src/common/cvar";

boot(["-basedir", BASE, "-game", "e2e_g", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map e1m1", 25);
exec("unbindall", 2);
keyState.key_dest = KeydestT.key_game;
frames(5);
drain();

// Capture is now driven by focus + key_dest/fullscreen, not this cvar (see
// sdl.ts's wantMouseCapture/_windowed_mouse header comments); key_dest is
// key_game (set above), which is why this captures. The Cvar_SetValue call
// is kept only to show it does not need to be anything in particular.
Cvar_SetValue("_windowed_mouse", 0);
IN_Commands();
check("mouse captured before the focus tests (key_dest is key_game, regardless of _windowed_mouse)", inputState().mouse_active, `mouse_active=${inputState().mouse_active}`);

// ---- 4a: SDL_WINDOWEVENT focus lost / gained ----------------------------
drain();
check("SDL accepts SDL_WINDOWEVENT_FOCUS_LOST", sdlWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_LOST), "");
pump();
{
  const st = inputState();
  check("FOCUS_LOST through SDL clears windowActive", st.windowActive === false, `windowActive=${st.windowActive}`);
  check("FOCUS_LOST through SDL calls IN_DeactivateMouse", st.mouse_active === false, `mouse_active=${st.mouse_active}`);
}
frames(2);
check("IN_Commands leaves the mouse released while unfocused", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);

drain();
check("SDL accepts SDL_WINDOWEVENT_FOCUS_GAINED", sdlWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_GAINED), "");
pump();
check("FOCUS_GAINED through SDL restores windowActive", inputState().windowActive === true, `windowActive=${inputState().windowActive}`);
IN_Commands();
check("IN_Commands re-captures the mouse once focused", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);

// keyboard still works after a focus round trip
drain();
const kc = keyState.key_count;
sdlTap(SDLK.w, 1);
check("keyboard survives a focus lost/gained round trip", keyState.key_count > kc, `key_count ${kc} -> ${keyState.key_count}`);

// ---- 4b/4c: SDL_QUIT and SDL_WINDOWEVENT_CLOSE exit the process ---------
async function runChild(mode: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "test/e2e/g_s4_child.ts", mode], {
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const code = await proc.exited;
  return { code, out };
}

const quitRun = await runChild("quit");
check("SDL_QUIT through the pump exits the process cleanly (status 0)", quitRun.code === 0, `exit=${quitRun.code}`);
check("SDL_QUIT does not fall through to the next statement", !quitRun.out.includes("STILL ALIVE"), quitRun.out.split("\n").filter((l) => l.startsWith("CHILD:")).join(" | "));
check("SDL_QUIT ran Host_Shutdown on the way out", quitRun.out.includes("VID_Shutdown") || quitRun.out.includes("Host_Shutdown"), quitRun.out.split("\n").slice(-4).join(" | "));

const closeRun = await runChild("close");
check("SDL_WINDOWEVENT_CLOSE through the pump exits cleanly (status 0)", closeRun.code === 0, `exit=${closeRun.code}`);
check("SDL_WINDOWEVENT_CLOSE does not fall through", !closeRun.out.includes("STILL ALIVE"), closeRun.out.split("\n").filter((l) => l.startsWith("CHILD:")).join(" | "));

const focusRun = await runChild("focus");
check("SDL_WINDOWEVENT_FOCUS_LOST does NOT exit the process", focusRun.code === 42, `exit=${focusRun.code}`);
check("FOCUS_LOST in a fresh process clears windowActive", focusRun.out.includes("windowActive=false"), focusRun.out.split("\n").filter((l) => l.startsWith("CHILD:")).join(" | "));

// ---- 4d: the quit menu, reached and answered entirely through SDL keys ---
const quitMenuRun = await runChild("quitmenu");
check("ESC -> Quit -> 'y' through SDL exits the process (status 0)", quitMenuRun.code === 0, `exit=${quitMenuRun.code}`);
check("the SDL key walk actually reached the quit prompt", quitMenuRun.out.includes("m_state at the quit prompt") && !quitMenuRun.out.includes("NOT AT THE QUIT PROMPT"), quitMenuRun.out.split("\n").filter((l) => l.startsWith("CHILD:")).join(" | "));
check("the quit menu does not fall through", !quitMenuRun.out.includes("STILL ALIVE"), quitMenuRun.out.split("\n").filter((l) => l.startsWith("CHILD:")).join(" | "));

summary("G4 window events");
