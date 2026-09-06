// Force headless SDL before ANY import can reach the FFI layer -- vid_menu.ts's
// Apply row calls vid.ts's VID_CheckChanges, which touches sdl.ts.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/platform/vid_menu.ts: the video options submenu vidMenuHooks
points at. Cursor navigation (up/down wraps), left/right/enter adjusting
vid_mode/vid_fullscreen/vid_ref, Escape returning to the options menu
(M_Menu_Options_f, verified through menuState.m_state per client/menu.ts's
own convention), and the Apply row driving vid.ts's VID_CheckChanges.
Self-sufficient per standing order 13: restores menuState.m_state,
keyState.key_dest, the vid_mode/vid_fullscreen/vid_ref cvars, the renderer
registry, re.current and the model-loader hooks.
*/

import { describe, test, expect, afterAll, beforeAll, beforeEach } from "bun:test";
import type { ModelLoaderHooks } from "../src/common/model";
import { getModelLoaderHooks, setModelLoaderHooks } from "../src/common/model";
import type { Renderer } from "../src/client/render";
import { re } from "../src/client/render";
import type { QpicT } from "../src/common/wad";
import { keyState, KeydestT, K_DOWNARROW, K_ENTER, K_ESCAPE, K_LEFTARROW, K_RIGHTARROW, K_UPARROW } from "../src/client/keys";
import { menuState, MStateT } from "../src/client/menu";
import { menuState as qwMenuState, MStateT as QwMStateT } from "../src/qw/client/menu";
import { qw } from "../src/common/quakedef";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer, vid_fullscreen, vid_mode, vid_ref, VID_ResetForTests } from "../src/platform/vid";
import { Cvar_RegisterVariable } from "../src/common/cvar";
import { VID_MenuCursor, VID_MenuDraw, VID_MenuKey, VID_MenuSetCursorForTests } from "../src/platform/vid_menu";
import { SDL_ResetBackendForTests } from "../src/platform/sdl";

function makePic(width: number, height: number): QpicT {
  return { width, height, data: new Uint8Array(0) };
}

const modelHooks: ModelLoaderHooks = {
  notexture: { name: "", width: 0, height: 0, gl_texturenum: 0, texturechain: null, anim_total: 0, anim_min: 0, anim_max: 0, anim_next: null, alternate_anims: null, offsets: new Uint32Array(4), data: new Uint8Array(0) },
  textureLoaded(): void {},
  Mod_LoadLighting(): void {},
  Mod_LoadAliasModel(): void {},
  Mod_LoadSpriteModel(): void {},
};

const drawCalls: string[] = [];

const fakeRenderer: Renderer = {
  modelHooks,
  R_Init(): void {},
  R_InitTextures(): void {},
  R_InitEfrags(): void {},
  R_RenderView(): void {},
  R_ViewChanged(): void {},
  R_InitSky(): void {},
  R_AddEfrags(): void {},
  R_RemoveEfrags(): void {},
  R_NewMap(): void {},
  R_PushDlights(): void {},
  r_cache_thrash: false,
  D_SurfaceCacheForRes(): number {
    return 0;
  },
  D_FlushCaches(): void {},
  D_DeleteSurfaceCache(): void {},
  D_InitCaches(): void {},
  R_SetVrect(): void {},
  draw_disc: null,
  Draw_Init(): void {},
  Draw_Character(): void {},
  Draw_DebugChar(): void {},
  Draw_Pic(): void {},
  Draw_TransPic(): void {
    drawCalls.push("Draw_TransPic");
  },
  Draw_TransPicTranslate(): void {},
  Draw_ConsoleBackground(): void {},
  Draw_BeginDisc(): void {},
  Draw_EndDisc(): void {},
  Draw_TileClear(): void {},
  Draw_Fill(): void {},
  Draw_FadeScreen(): void {},
  Draw_String(): void {},
  Draw_PicFromWad(): QpicT | null {
    return null;
  },
  Draw_CachePic(): QpicT | null {
    return makePic(16, 16);
  },
  D_StartParticles(): void {},
  D_DrawParticle(): void {},
  D_EndParticles(): void {},
  V_CalcBlend(): void {},
  V_UpdatePalette(): void {},
  V_DrawCrosshair(): void {},
  R_TranslatePlayerSkin(): void {},
  SCR_CalcRefdef(): void {},
  BeginFrame(): void {},
  EndFrame(): void {},
  D_EnableBackBufferAccess(): void {},
  D_DisableBackBufferAccess(): void {},
  D_UpdateRects(): void {},
  GL_Set2D(): void {},
  SCR_TileClear(): void {},
  SCR_SoftwareTileClear(): void {},
  SCR_DrawCrosshair(): void {},
  Draw_SubPic(): void {},
  Draw_Alt_String(): void {},
  isGL: false,
  SCR_ScreenShot_f(): void {},
};

const savedRe = re.current;
const savedModelHooks = getModelLoaderHooks();
const savedKeyDest = keyState.key_dest;
const savedMState = menuState.m_state;
const savedVidMode = vid_mode.value;
const savedVidFullscreen = vid_fullscreen.value;
const savedVidRef = vid_ref.string;
const savedSoftFactory = getRegisteredRenderer("soft");
const savedQwActive = qw.active;
const savedQwMState = qwMenuState.m_state;

function readQwMState(): QwMStateT {
  return qwMenuState.m_state;
}
function readNqMState(): MStateT {
  return menuState.m_state;
}

beforeAll(() => {
  // vid_mode/vid_fullscreen/vid_ref are normally registered by VID_Init
  // (src/platform/vid.ts), which this suite never calls; register them here
  // directly so Cvar_Set/Cvar_SetValue's Cvar_FindVar lookup succeeds --
  // Cvar_RegisterVariable is a harmless no-op (a Con_Printf) if an earlier
  // test file already linked them.
  Cvar_RegisterVariable(vid_mode);
  Cvar_RegisterVariable(vid_fullscreen);
  Cvar_RegisterVariable(vid_ref);
});

beforeEach(() => {
  drawCalls.length = 0;
  VID_MenuSetCursorForTests(0);
  registerRenderer("soft", () => fakeRenderer);
  re.current = fakeRenderer;
});

afterAll(() => {
  qw.active = savedQwActive;
  qwMenuState.m_state = savedQwMState;
  if (savedSoftFactory) registerRenderer("soft", savedSoftFactory);
  else unregisterRenderer("soft");
  VID_ResetForTests();
  SDL_ResetBackendForTests();
  re.current = savedRe;
  setModelLoaderHooks(savedModelHooks);
  keyState.key_dest = savedKeyDest;
  menuState.m_state = savedMState;
  vid_mode.value = savedVidMode;
  vid_fullscreen.value = savedVidFullscreen;
  vid_ref.string = savedVidRef;
});

describe("VID_MenuDraw", () => {
  test("draws the corner plaque and the cursor without throwing", () => {
    expect(() => VID_MenuDraw()).not.toThrow();
    expect(drawCalls).toContain("Draw_TransPic");
  });
});

describe("VID_MenuKey -- cursor navigation", () => {
  test("down/up wrap across the four rows", () => {
    VID_MenuSetCursorForTests(0);
    VID_MenuKey(K_UPARROW);
    expect(VID_MenuCursor()).toBe(3); // wraps to the last row

    VID_MenuSetCursorForTests(3);
    VID_MenuKey(K_DOWNARROW);
    expect(VID_MenuCursor()).toBe(0); // wraps back to the first row
  });

  test("Escape returns to the options menu (M_Menu_Options_f)", () => {
    keyState.key_dest = KeydestT.key_menu;
    VID_MenuKey(K_ESCAPE);
    expect(menuState.m_state).toBe(MStateT.m_options);
    expect(keyState.key_dest).toBe(KeydestT.key_menu);
  });

  /*
  menu.c exists twice in this port -- src/client/menu.ts and
  src/qw/client/menu.ts, each with its own m_state -- and both dispatch
  m_video to this one file through vidMenuHooks. Escape has to come back out
  into whichever one is running: with WinQuake's M_Menu_Options_f hard-called,
  qwcl's video menu set the WinQuake m_state and left QW's still on m_video,
  so the video menu could never be backed out of and every further key went on
  changing video settings.
  */
  test("under qw.active, Escape returns to QUAKEWORLD's options menu", () => {
    qw.active = true;
    try {
      keyState.key_dest = KeydestT.key_menu;
      menuState.m_state = MStateT.m_none;
      qwMenuState.m_state = QwMStateT.m_video;

      VID_MenuKey(K_ESCAPE);

      // read back through a call, so tsc does not narrow these to the literal
      // types the two assignments above just gave them
      expect(readQwMState()).toBe(QwMStateT.m_options);
      expect(readNqMState()).toBe(MStateT.m_none); // WinQuake's copy untouched
      expect(keyState.key_dest).toBe(KeydestT.key_menu);
    } finally {
      qw.active = savedQwActive;
    }
  });

  test("under qw.active, the menu draws through QuakeWorld's own M_* helpers", () => {
    qw.active = true;
    try {
      expect(() => VID_MenuDraw()).not.toThrow();
      expect(drawCalls).toContain("Draw_TransPic");
    } finally {
      qw.active = savedQwActive;
    }
  });
});

describe("VID_MenuKey -- adjusting values", () => {
  test("left/right on the video-mode row cycles vid_mode with wraparound", () => {
    VID_MenuSetCursorForTests(0);
    vid_mode.value = 0;
    VID_MenuKey(K_LEFTARROW); // wraps below 0 to the last mode index
    expect(vid_mode.value).toBeGreaterThan(0);

    vid_mode.value = 0;
    VID_MenuKey(K_RIGHTARROW);
    expect(vid_mode.value).toBe(1);
  });

  test("enter/left/right on the fullscreen row toggles vid_fullscreen", () => {
    VID_MenuSetCursorForTests(1);
    vid_fullscreen.value = 0;
    VID_MenuKey(K_ENTER);
    expect(vid_fullscreen.value).toBe(1);
    VID_MenuKey(K_ENTER);
    expect(vid_fullscreen.value).toBe(0);
  });

  test("enter on the renderer row toggles vid_ref between soft and gl", () => {
    VID_MenuSetCursorForTests(2);
    vid_ref.string = "soft";
    VID_MenuKey(K_ENTER);
    expect(vid_ref.string).toBe("gl");
    VID_MenuKey(K_ENTER);
    expect(vid_ref.string).toBe("soft");
  });

  test("enter on the Apply row drives VID_CheckChanges without throwing (a fake renderer is registered under \"soft\")", () => {
    VID_MenuSetCursorForTests(3);
    vid_ref.string = "soft";
    expect(() => VID_MenuKey(K_ENTER)).not.toThrow();
    expect(re.current).toBe(fakeRenderer);
  });
});
