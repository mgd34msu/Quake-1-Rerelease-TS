// Force headless SDL before ANY import can reach the FFI layer: these tests
// must never open a real window or audio device on the host desktop.
// sdl.ts dlopen()s lazily, so as long as no SDL entry point is called above
// this assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/platform/sdl.ts against the real system libSDL2, driven
headlessly through SDL's own dummy video and audio drivers: palette
expansion, the SDLK_* -> K_* key map (built from keys.ts, not
quake-2-ts's own K_* numbering -- see the file's own header on why), the
window/texture/audio pipeline, and IN_Move's mouse-to-viewangles math.
Self-sufficient per standing order 13: this file never assumes another
suite has already armed the backend, and undoes everything it arms in
afterAll (SDL_ResetBackendForTests, plus the client-state fields IN_Move
touches).
*/

import { describe, test, expect, afterAll } from "bun:test";
import {
  IN_ClearStates,
  IN_Commands,
  IN_Init,
  IN_Move,
  IN_Shutdown,
  SDL_SetFullscreenHint,
  SDLSND_Active,
  SDLSND_Close,
  SDLSND_ConsumedBytes,
  SDLSND_Open,
  SDLSND_Queue,
  SDLVID_Active,
  SDLVID_ExpandFrame,
  SDLVID_FramesPresented,
  SDLVID_Init,
  SDLVID_Present,
  SDLVID_Shutdown,
  SDL_BackendEnabled,
  SDL_KeyToQuake,
  SDL_ResetBackendForTests,
  SDL_SetBackendEnabled,
} from "../src/platform/sdl";
import {
  K_ALT,
  K_BACKSPACE,
  K_CTRL,
  K_DEL,
  K_ESCAPE,
  K_F1,
  K_HOME,
  K_MOUSE1,
  K_MOUSE2,
  K_MOUSE3,
  K_MWHEELDOWN,
  K_MWHEELUP,
  K_PAUSE,
  K_SHIFT,
  K_TAB,
  K_UPARROW,
} from "../src/client/keys";
import { cl } from "../src/client/client";
import { UsercmdT } from "../src/server/server";
import { vec3 } from "../src/common/mathlib";

const savedViewangles = new Float32Array(cl.viewangles);

afterAll(() => {
  SDL_ResetBackendForTests();
  cl.viewangles[0] = savedViewangles[0];
  cl.viewangles[1] = savedViewangles[1];
  cl.viewangles[2] = savedViewangles[2];
});

describe("src/platform/sdl.ts -- palette expansion and keymap (no SDL needed)", () => {
  test("SDLVID_ExpandFrame turns 8-bit indices into RGBA through the padded xRGB palette", () => {
    // 2x2 frame, stride wider than the visible width so the row padding a C
    // surface would allow is exercised
    const rowbytes = 4;
    const buffer = new Uint8Array([1, 2, 0xee, 0xee, 3, 0, 0xee, 0xee]);
    const palette = new Uint8Array(1024);
    palette.set([0, 0, 0, 0], 0); // index 0 = black
    palette.set([255, 0, 0, 0], 4); // index 1 = red
    palette.set([0, 255, 0, 0], 8); // index 2 = green
    palette.set([0, 0, 255, 0], 12); // index 3 = blue

    const out = new Uint8Array(2 * 2 * 4);
    SDLVID_ExpandFrame(buffer, rowbytes, 2, 2, palette, out);

    expect(Array.from(out)).toEqual([
      255, 0, 0, 255, // (0,0) index 1 -> red
      0, 255, 0, 255, // (1,0) index 2 -> green
      0, 0, 255, 255, // (0,1) index 3 -> blue
      0, 0, 0, 255, // (1,1) index 0 -> black
    ]);
  });

  test("SDL_KeyToQuake maps SDLK_* onto keys.ts's K_* numbers (Quake 1's own, not quake-2-ts's)", () => {
    expect(K_ESCAPE).toBe(27);
    expect(K_TAB).toBe(9);
    expect(K_BACKSPACE).toBe(127);
    expect(K_DEL).toBe(148);
    expect(K_F1).toBe(135);
    expect(K_UPARROW).toBe(128);
    expect(K_SHIFT).toBe(134);
    expect(K_CTRL).toBe(133);
    expect(K_ALT).toBe(132);
    expect(K_HOME).toBe(151);
    expect(K_PAUSE).toBe(255);
    expect(K_MOUSE1).toBe(200);
    expect(K_MOUSE2).toBe(201);
    expect(K_MOUSE3).toBe(202);
    expect(K_MWHEELUP).toBe(239);
    expect(K_MWHEELDOWN).toBe(240);

    expect(SDL_KeyToQuake(27)).toBe(K_ESCAPE); // SDLK_ESCAPE
    expect(SDL_KeyToQuake(9)).toBe(K_TAB); // SDLK_TAB
    expect(SDL_KeyToQuake(13)).toBe(13); // SDLK_RETURN == K_ENTER numerically too
    expect(SDL_KeyToQuake(8)).toBe(K_BACKSPACE); // SDLK_BACKSPACE -> 127
    expect(SDL_KeyToQuake(127)).toBe(K_DEL); // SDLK_DELETE -> 148
    expect(SDL_KeyToQuake(1073741906)).toBe(K_UPARROW); // SDLK_UP
    expect(SDL_KeyToQuake(1073741882)).toBe(K_F1); // SDLK_F1
    expect(SDL_KeyToQuake(1073742049)).toBe(K_SHIFT); // SDLK_LSHIFT
    expect(SDL_KeyToQuake(1073742053)).toBe(K_SHIFT); // SDLK_RSHIFT
    expect(SDL_KeyToQuake(1073742048)).toBe(K_CTRL); // SDLK_LCTRL
    expect(SDL_KeyToQuake(1073742054)).toBe(K_ALT); // SDLK_RALT
    expect(SDL_KeyToQuake(1073741896)).toBe(K_PAUSE); // SDLK_PAUSE

    // printable ascii passes straight through, matching keys.h's "normal
    // keys should be passed as lowercased ascii" comment
    expect(SDL_KeyToQuake(97)).toBe(97); // 'a'
    expect(SDL_KeyToQuake(32)).toBe(32); // space
    expect(SDL_KeyToQuake(96)).toBe(96); // '`', the console key

    // Quake 1 has no keypad key constants (grepped keys.h): a numpad
    // keysym (SDLK_KP_ENTER, well outside the printable-ASCII range) is
    // dropped rather than mapped to anything.
    expect(SDL_KeyToQuake(1073741912)).toBe(0); // SDLK_KP_ENTER

    // anything else with no K_* number is dropped rather than forwarded
    expect(SDL_KeyToQuake(1073741881)).toBe(0); // SDLK_CAPSLOCK
    expect(SDL_KeyToQuake(0)).toBe(0);
  });

  test("the backend is disarmed until something asks for it", () => {
    expect(SDL_BackendEnabled()).toBe(false);
    expect(SDLVID_Init(320, 240, false)).toBe(false);
    expect(SDLVID_Active()).toBe(false);
  });
});

describe("src/platform/sdl.ts -- real libSDL2 under the dummy drivers", () => {
  afterAll(() => {
    SDL_ResetBackendForTests();
  });

  test("the video pipeline comes up headless and a frame round-trips through it", () => {
    SDL_SetBackendEnabled(true);
    expect(SDLVID_Init(320, 240, false)).toBe(true);
    expect(SDLVID_Active()).toBe(true);

    const buffer = new Uint8Array(320 * 240);
    buffer.fill(7);
    const palette = new Uint8Array(1024);
    palette.set([12, 34, 56, 0], 7 * 4);

    expect(() => SDLVID_Present(buffer, 320, 320, 240, palette)).not.toThrow();
    expect(SDLVID_FramesPresented()).toBeGreaterThan(0);

    // a mode change tears the old window/texture down and builds a new one
    expect(SDLVID_Init(640, 480, false)).toBe(true);
    expect(() => SDLVID_Present(new Uint8Array(640 * 480), 640, 640, 480, palette)).not.toThrow();

    SDLVID_Shutdown();
    expect(SDLVID_Active()).toBe(false);
  });

  test("the audio device opens, takes queued PCM, and reports what it consumed", () => {
    SDL_SetBackendEnabled(true);
    const obtained = SDLSND_Open(44100, 2, 16);
    expect(obtained).not.toBeNull();
    expect(obtained?.freq).toBe(44100);
    expect(obtained?.channels).toBe(2);
    expect(SDLSND_Active()).toBe(true);

    const chunk = new Uint8Array(4096);
    SDLSND_Queue(chunk);
    const consumed = SDLSND_ConsumedBytes();
    expect(consumed).toBeGreaterThanOrEqual(0);
    expect(consumed).toBeLessThanOrEqual(chunk.length);

    SDLSND_Close();
    expect(SDLSND_Active()).toBe(false);
  });
});

describe("src/platform/sdl.ts -- IN_Move applies mouse deltas with sensitivity/m_yaw/m_pitch", () => {
  afterAll(() => {
    IN_Shutdown();
    SDL_ResetBackendForTests();
  });

  test("with the mouse activated (IN_Init + IN_Commands under a fullscreen window), IN_Move is safe to call and cl.viewangles stays finite", () => {
    SDL_SetBackendEnabled(true);
    expect(SDLVID_Init(320, 240, true)).toBe(true);

    IN_Init();
    // fullscreen always captures regardless of _windowed_mouse (see
    // sdl.ts's wantMouseCapture header comment) -- IN_Commands is this
    // port's own per-frame capture gate (vid_x.c has none; see IN_Commands's
    // own header comment on why).
    SDL_SetFullscreenHint(true);
    IN_Commands();

    const cmd = new UsercmdT();
    cmd.viewangles = vec3();
    expect(() => IN_Move(cmd)).not.toThrow();
    expect(Number.isFinite(cl.viewangles[0])).toBe(true);
    expect(Number.isFinite(cmd.forwardmove)).toBe(true);
    expect(Number.isFinite(cmd.sidemove)).toBe(true);

    IN_ClearStates();
    SDL_SetFullscreenHint(false);
  });
});
