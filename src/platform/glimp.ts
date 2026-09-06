/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_vidlinuxglx.c (GNU GPL v2 or later): the GLX
context/window creation half of that file, replaced with SDL2 the way
sdl.ts's software path replaces vid_x.c's XImage blit -- one bun
implementation per PORTING.md's platform-track rule, not a per-OS ifdef
ladder. Adapted from ../quake-2-ts/src/platform/glimp.ts, trimmed to what
this port's brief actually asks for: "export GLimp_*-style functions the way
q2ts's glimp.ts does: CreateGLimp -> { Init, SetMode, BeginFrame,
EndFrame(swap), Shutdown, GetProcAddress }". `GL_BeginRendering`/
`GL_EndRendering` themselves (gl_vidlinuxglx.c:611-640) are ref_gl's (U075,
not yet landed) -- this file only creates the context/window and swaps it;
nothing here issues a single GL call of its own (no `qgl` import, unlike
quake-2-ts's version, which drove an ARB_framebuffer_object render-scale
target from here -- Quake 1 has no vid_scale-style internal render
resolution to support, see vid_scale.ts's own header, so there is nothing
for BeginFrame/EndFrame to redirect).

Under the SDL "dummy" video driver (this port's headless/test posture),
SDL_CreateWindow with SDL_WINDOW_OPENGL fails outright -- confirmed
empirically against the real libSDL2 this file links: "OpenGL support is
either not configured in SDL or not available in current SDL video driver
(dummy) or platform". GLimp_SetMode surfaces that as a `false` SetMode
result rather than throwing, so vid.ts's vid_ref switch can fall back to
"soft" the same way a real driver's rejected mode does.

Deviations from PORTING.md / the C source:
- gl_vidlinuxglx.c's VID_Init interleaves window/context creation with
  cvar registration, palette upload and `vid.conwidth`/`vid.conheight`
  command-line parsing. Those belong to vid.ts (the caller) and to the
  VidBackend interface's VID_Init, not to GLimp -- this file is only the
  context/window half PORTING.md's brief calls out ("the context/window
  creation is yours" -- GL_BeginRendering/EndRendering are ref_gl's).
- `GLimp_EnableLogging`/`GLimp_LogNewFrame` have no wrapgl-equivalent
  call-logging path in this port (no such file exists anywhere in the
  WinQuake tree either); both are no-ops, matching quake-2-ts's own
  precedent for a feature nothing in the reachable call graph depends on.
*/

import { Con_Printf } from "../client/console";
import { SDL_AppActivate, SDL_SetFullscreenHint, SDLGL_CreateContext, SDLGL_CreateWindow, SDLGL_GetProcAddress, SDLGL_SetSwapInterval, SDLGL_Shutdown, SDLGL_SwapWindow } from "./sdl";

// vid.ts creates the GLimp instance (this unit's brief: "for 'gl' create the
// GL context first via glimp") and hands it here rather than through
// registerRenderer's factory (which takes no arguments), so a future ref_gl
// unit's Renderer.BeginFrame/EndFrame methods have a fixed place to read the
// live context from -- the same `{ current }` holder pattern render.ts's
// `re` and client/vid.ts's `vidBackend` already use.
export const glimpHolder: { current: GLimp | null } = { current: null };

export interface GLimp {
  Init(): boolean;
  SetMode(width: number, height: number, fullscreen: boolean): boolean;
  Shutdown(): void;
  BeginFrame(): void;
  EndFrame(): void;
  AppActivate(active: boolean): void;
  EnableLogging(enable: boolean): void;
  LogNewFrame(): void;
  GetProcAddress(name: string): ReturnType<typeof SDLGL_GetProcAddress>;
}

export function GLimp_Init(): boolean {
  return true; // the window is created by GLimp_SetMode, not here -- see SDLVID_Init's identical shape in sdl.ts
}

export function GLimp_SetMode(width: number, height: number, fullscreen: boolean): boolean {
  Con_Printf("GL setting mode %ix%i%s\n", width, height, fullscreen ? " fullscreen" : "");

  SDL_SetFullscreenHint(fullscreen);

  if (!SDLGL_CreateWindow(width, height, fullscreen)) return false;
  if (!SDLGL_CreateContext()) return false;

  SDLGL_SetSwapInterval(1);
  return true;
}

export function GLimp_Shutdown(): void {
  SDLGL_Shutdown();
}

export function GLimp_BeginFrame(): void {
  // win32/glw_imp.c's GLimp_BeginFrame only handles the gl_bitdepth cvar
  // (Win95 OSR2/WinNT display-depth-change gating), which has no SDL
  // equivalent; gl_vidlinuxglx.c's GL_BeginRendering (ref_gl's, not this
  // file's) does the rest. Nothing OS-specific is left to do before a frame.
}

export function GLimp_EndFrame(): void {
  SDLGL_SwapWindow();
}

export function GLimp_AppActivate(active: boolean): void {
  SDL_AppActivate(active);
}

export function GLimp_EnableLogging(enable: boolean): void {
  void enable; // see file header
}

export function GLimp_LogNewFrame(): void {
  // see GLimp_EnableLogging's note
}

export function CreateGLimp(): GLimp {
  return {
    Init: GLimp_Init,
    SetMode: GLimp_SetMode,
    Shutdown: GLimp_Shutdown,
    BeginFrame: GLimp_BeginFrame,
    EndFrame: GLimp_EndFrame,
    AppActivate: GLimp_AppActivate,
    EnableLogging: GLimp_EnableLogging,
    LogNewFrame: GLimp_LogNewFrame,
    GetProcAddress: SDLGL_GetProcAddress,
  };
}
