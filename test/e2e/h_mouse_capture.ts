// H scenario -- real mouse capture under a real (non-dummy) SDL video
// driver, proving the defect fix end to end: not just that this port's own
// `mouse_active` flag flips (test/sdl_input.test.ts already covers that
// under SDL_VIDEODRIVER=dummy), but that SDL's *actual* relative-mouse-mode
// state changes on the *actual* window libSDL2 owns in this process.
//
// Not a bun:test suite (pattern: test/e2e/g_lib.ts's own header) -- driven
// directly with:
//
//   xvfb-run -a -s "-screen 0 1280x720x24" \
//     env SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy \
//     timeout 60 bun test/e2e/h_mouse_capture.ts
//
// A real Xvfb X server is required: SDL_VIDEODRIVER=x11 makes VID_Init open
// a real X11 window (src/platform/vid.ts's VID_Init calls
// SDL_SetBackendEnabled(true) itself, exactly as a production run does --
// see g_lib.ts's own boot()), and SDL2's relative-mouse-mode grab is
// implemented as a real XGrabPointer + XFixesHideCursor/blank-cursor dance
// that the dummy driver never exercises. This never opens a window on the
// real display: run it under Xvfb only, never bare.
//
// SDL_GetRelativeMouseMode has no existing binding in src/platform/sdl.ts
// (nothing there needs to read it back, only set it), so this driver opens
// its own bun:ffi handle on the same shared library sdl.ts already dlopen()s
// -- the OS dynamic linker hands back the SAME loaded instance for a second
// dlopen of the same path in one process, so this reads the real state of
// the window sdl.ts itself created, not an independent copy (test/e2e's own
// precedent: test/e2e/g_s2_mouse.ts already dlopens libSDL3.so.0 directly
// for a symbol sdl.ts does not export).
import { dlopen } from "bun:ffi";
import { BASE, boot, frames, check, summary, exec, results, asDest } from "./g_lib";
import { cl, cls, CactiveT, SIGNONS } from "../../src/client/client";
import { keyState, KeydestT } from "../../src/client/keys";

const sdl = dlopen("libSDL2-2.0.so.0", {
  SDL_GetRelativeMouseMode: { args: [], returns: "i32" },
  SDL_ShowCursor: { args: ["i32"], returns: "i32" },
} as const);

const SDL_QUERY = -1;
function relativeMouseMode(): number {
  return sdl.symbols.SDL_GetRelativeMouseMode();
}
function cursorVisible(): boolean {
  return sdl.symbols.SDL_ShowCursor(SDL_QUERY) === 1;
}

function inGame(): boolean {
  return cls.state === CactiveT.ca_connected && cls.signon === SIGNONS;
}

boot(["-basedir", BASE, "-game", "e2e_h", "-nosound", "-vid_ref", "soft", "-width", "640", "-height", "480", "+map", "start"]);

let reachedGame = false;
for (let i = 0; i < 200; i++) {
  frames(1);
  if (inGame()) {
    reachedGame = true;
    break;
  }
}
check("reached ca_connected/SIGNONS from `+map start` on the command line", reachedGame, `cls.state=${cls.state} signon=${cls.signon} levelname=${JSON.stringify(cl.levelname)}`);

// e2e_h/config.cfg carries the reported defect's exact archived value
// (`_windowed_mouse "0"`) -- the fix no longer reads it for capture, so this
// must still grab despite it.
keyState.key_dest = KeydestT.key_game;
frames(3);

check("SDL_GetRelativeMouseMode() is 1 while playing with the window focused", relativeMouseMode() === 1, `SDL_GetRelativeMouseMode()=${relativeMouseMode()}`);
check("the pointer is hidden while captured", !cursorVisible(), `cursorVisible=${cursorVisible()}`);

// toggleconsole -- key_dest -> key_console should release the real grab
exec("toggleconsole", 3);
check("key_dest left the console up", asDest(keyState.key_dest) === KeydestT.key_console, `key_dest=${keyState.key_dest}`);
check("SDL_GetRelativeMouseMode() drops to 0 with the console up", relativeMouseMode() === 0, `SDL_GetRelativeMouseMode()=${relativeMouseMode()}`);
check("the pointer is shown once released", cursorVisible(), `cursorVisible=${cursorVisible()}`);

// toggleconsole again -- back to key_game should re-grab
exec("toggleconsole", 3);
check("key_dest is back to key_game", asDest(keyState.key_dest) === KeydestT.key_game, `key_dest=${keyState.key_dest}`);
check("SDL_GetRelativeMouseMode() is 1 again once the console closes", relativeMouseMode() === 1, `SDL_GetRelativeMouseMode()=${relativeMouseMode()}`);

summary("H mouse capture");
if (results.some((r) => !r.pass)) process.exit(1);
