// G scenario 4 child -- pushes one window/quit event through SDL and lets
// SDL_PumpInput's Sys_Quit take the process down, so the parent can observe
// the exit status. Run as: bun test/e2e/g_s4_child.ts <quit|close|focus>
import { BASE, boot, frames, exec, push, pump, drain, sdlTap, sdlWindowEvent, sdlQuit, inputState, SDLK } from "./g_lib";
import { SDL_TEST_WINDOWEVENT_CLOSE, SDL_TEST_WINDOWEVENT_FOCUS_LOST, SDL_MakeKeyEvent } from "../../src/platform/sdl";
import { MStateT, menuState } from "../../src/client/menu";

const mode = process.argv[2] ?? "quit";

boot(["-basedir", BASE, "-game", "e2e_g", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map e1m1", 20);
drain();

if (mode === "quit") {
  console.log("CHILD: pushing SDL_QUIT");
  console.log(`CHILD: push accepted=${sdlQuit()}`);
  pump();
} else if (mode === "close") {
  console.log("CHILD: pushing SDL_WINDOWEVENT_CLOSE");
  console.log(`CHILD: push accepted=${sdlWindowEvent(SDL_TEST_WINDOWEVENT_CLOSE)}`);
  pump();
} else if (mode === "quitmenu") {
  // main menu -> down to Quit -> Enter -> the quit prompt -> 'y'
  sdlTap(SDLK.ESCAPE, 2);
  console.log(`CHILD: m_state after ESC = ${menuState.m_state}`);
  for (let i = 0; i < 4; i++) sdlTap(SDLK.DOWN, 1);
  console.log(`CHILD: m_main_cursor = ${menuState.m_main_cursor}`);
  sdlTap(SDLK.RETURN, 2);
  console.log(`CHILD: m_state at the quit prompt = ${menuState.m_state} (m_quit=${MStateT.m_quit})`);
  if (menuState.m_state !== MStateT.m_quit) {
    console.log("CHILD: NOT AT THE QUIT PROMPT");
    process.exit(43);
  }
  push(SDL_MakeKeyEvent(SDLK.y, true));
  push(SDL_MakeKeyEvent(SDLK.y, false));
  pump();
} else {
  console.log(`CHILD: pushing SDL_WINDOWEVENT_FOCUS_LOST`);
  sdlWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_LOST);
  pump();
  console.log(`CHILD: windowActive=${inputState().windowActive}`);
}

// Only reached if the pump did NOT quit.
console.log("CHILD: STILL ALIVE after the pump");
process.exit(42);
