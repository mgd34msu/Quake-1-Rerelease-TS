// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/platform/glimp.ts (gl_vidlinuxglx.c's GLX context/window
creation, replaced with SDL2 the way sdl.ts's software path replaces
vid_x.c's XImage blit): GLimp_SetMode fails cleanly (returns false, never
throws) under SDL's "dummy" video driver, which cannot create a real GL
context -- confirmed empirically against the real libSDL2 this suite links:
SDL_CreateWindow(..., SDL_WINDOW_OPENGL) itself fails under it, before any
context could exist. Also exercises CreateGLimp's full member set and every
other GLimp entry point being safe to call without a context. Self-sufficient
per standing order 13: SDL_ResetBackendForTests() in afterAll.
*/

import { describe, test, expect, afterAll } from "bun:test";
import { CreateGLimp, GLimp_AppActivate, GLimp_BeginFrame, GLimp_EndFrame, GLimp_EnableLogging, GLimp_Init, GLimp_LogNewFrame, GLimp_SetMode, GLimp_Shutdown, glimpHolder } from "../src/platform/glimp";
import { SDL_ResetBackendForTests, SDL_SetBackendEnabled } from "../src/platform/sdl";

afterAll(() => {
  glimpHolder.current = null;
  SDL_ResetBackendForTests();
});

describe("src/platform/glimp.ts -- GLimp under SDL's dummy video driver", () => {
  afterAll(() => {
    SDL_ResetBackendForTests();
  });

  test("GLimp_Init reports success without creating anything (the window is created by SetMode)", () => {
    expect(GLimp_Init()).toBe(true);
  });

  test("GLimp_SetMode fails cleanly (false, not a throw) when the dummy driver refuses an OpenGL window", () => {
    SDL_SetBackendEnabled(true);
    expect(() => GLimp_SetMode(640, 480, false)).not.toThrow();
    expect(GLimp_SetMode(640, 480, false)).toBe(false);
  });

  test("the rest of the GLimp surface is safe to call without a context", () => {
    expect(() => GLimp_BeginFrame()).not.toThrow();
    expect(() => GLimp_EndFrame()).not.toThrow();
    expect(() => GLimp_AppActivate(true)).not.toThrow();
    expect(() => GLimp_AppActivate(false)).not.toThrow();
    expect(() => GLimp_EnableLogging(true)).not.toThrow();
    expect(() => GLimp_LogNewFrame()).not.toThrow();
    expect(() => GLimp_Shutdown()).not.toThrow();
  });

  test("CreateGLimp assembles every member vid.ts's vid_ref \"gl\" switch expects", () => {
    const glimp = CreateGLimp();
    const members: ReadonlyArray<keyof typeof glimp> = ["Init", "SetMode", "Shutdown", "BeginFrame", "EndFrame", "AppActivate", "EnableLogging", "LogNewFrame", "GetProcAddress"];
    for (const name of members) {
      expect(typeof glimp[name]).toBe("function");
    }
  });

  test("glimpHolder is the seam vid.ts hands a live GLimp to and a future ref_gl reads from", () => {
    expect(glimpHolder.current).toBeNull();
    const glimp = CreateGLimp();
    glimpHolder.current = glimp;
    expect(glimpHolder.current).toBe(glimp);
    glimpHolder.current = null;
  });
});
