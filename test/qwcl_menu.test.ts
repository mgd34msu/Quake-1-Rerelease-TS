// Self-sufficient test for src/qw/client/menu.ts's G9 scaling addition: the
// QuakeWorld menu tree's 320x200 canvas transform (M_CanvasScale/M_CanvasX/
// M_CanvasY) at scr_menuscale, mirroring src/client/menu.ts's own G4 unit
// and test/menu_scale.test.ts's precedent for that side.
//
// Installs its own fake Renderer (src/client/render.ts's `re.current`), its
// own `vid`/`scr_menuscale` values, and resets `menuState`/`keyState` before
// every test, per the standing orders ("every suite initializes the globals
// it reads").

import { beforeEach, describe, expect, test } from "bun:test";

import { re } from "../src/client/render";
import type { Renderer, GlyphAtlasSourceT } from "../src/client/render";
import { vid } from "../src/client/vid";
import { VrectT } from "../src/client/vid";
import { keyState, KeydestT } from "../src/client/keys";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import { QpicT } from "../src/common/wad";

import { MenuScale, MenuFitScale, scr_menuscale, MENU_CANVAS_WIDTH, MENU_CANVAS_HEIGHT } from "../src/client/screen";
import { M_CanvasScale, M_CanvasX, M_CanvasY, M_Main_Draw, M_DrawCharacter, menuState, MStateT } from "../src/qw/client/menu";

//=============================================================================
// A minimal recording Renderer (same recipe as test/qwcl_sbar.test.ts).

type DrawCall =
  | { fn: "Draw_Pic"; x: number; y: number; picName: string }
  | { fn: "Draw_TransPic"; x: number; y: number; picName: string }
  | { fn: "Draw_ScaledPic"; x: number; y: number; picName: string; scale: number }
  | { fn: "Draw_ScaledTransPic"; x: number; y: number; picName: string; scale: number }
  | { fn: "Draw_Character"; x: number; y: number; num: number }
  | { fn: "Draw_GlyphAtlas"; x: number; y: number; w: number; h: number; scale: number };

function makeFakeRenderer(): { renderer: Renderer; calls: DrawCall[] } {
  const picByName = new Map<string, QpicT>();
  const nameByPic = new Map<QpicT, string>();
  const calls: DrawCall[] = [];

  function namedPic(name: string): QpicT {
    let p = picByName.get(name);
    if (!p) {
      p = new QpicT();
      p.width = 32;
      p.height = 32;
      picByName.set(name, p);
      nameByPic.set(p, name);
    }
    return p;
  }

  function nameOf(pic: QpicT): string {
    return nameByPic.get(pic) ?? "?";
  }

  const modelHooks: ModelLoaderHooks = {
    notexture: new TextureT(),
    textureLoaded(): void {},
    Mod_LoadLighting(): void {},
    Mod_LoadAliasModel(): void {},
    Mod_LoadSpriteModel(): void {},
  };

  const renderer: Renderer = {
    modelHooks,
    R_Init(): void {},
    R_InitTextures(): void {},
    R_InitEfrags(): void {},
    R_RenderView(): void {},
    R_ViewChanged(_pvrect: VrectT, _lineadj: number, _aspect: number): void {},
    R_InitSky(_mt: TextureT): void {},
    R_AddEfrags(): void {},
    R_RemoveEfrags(): void {},
    R_NewMap(): void {},
    R_PushDlights(): void {},
    r_cache_thrash: false,
    D_SurfaceCacheForRes(_width: number, _height: number): number {
      return 0;
    },
    D_FlushCaches(): void {},
    D_DeleteSurfaceCache(): void {},
    D_InitCaches(_buffer: Uint8Array, _size: number): void {},
    R_SetVrect(_pvrectin: VrectT, _pvrect: VrectT, _lineadj: number): void {},
    draw_disc: null,
    Draw_Init(): void {},
    Draw_Character(x: number, y: number, num: number): void {
      calls.push({ fn: "Draw_Character", x, y, num });
    },
    Draw_DebugChar(): void {},
    Draw_Pic(x: number, y: number, pic: QpicT): void {
      calls.push({ fn: "Draw_Pic", x, y, picName: nameOf(pic) });
    },
    Draw_TransPic(x: number, y: number, pic: QpicT): void {
      calls.push({ fn: "Draw_TransPic", x, y, picName: nameOf(pic) });
    },
    Draw_TransPicTranslate(x: number, y: number, pic: QpicT): void {
      calls.push({ fn: "Draw_TransPic", x, y, picName: nameOf(pic) });
    },
    Draw_ConsoleBackground(): void {},
    Draw_BeginDisc(): void {},
    Draw_EndDisc(): void {},
    Draw_TileClear(): void {},
    Draw_Fill(): void {},
    Draw_FadeScreen(): void {},
    Draw_String(): void {},
    Draw_PicFromWad(name: string): QpicT | null {
      return namedPic(name);
    },
    Draw_CachePic(path: string): QpicT | null {
      return namedPic(path);
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

    // G9: optional scaled-blit / glyph-atlas members -- recorded so the
    // tests below can assert the exact scale a call went through, mirroring
    // test/menu_scale.test.ts's own fake renderer for the WinQuake side.
    Draw_ScaledPic(x: number, y: number, pic: QpicT, scale: number): void {
      calls.push({ fn: "Draw_ScaledPic", x, y, picName: nameOf(pic), scale });
    },
    Draw_ScaledTransPic(x: number, y: number, pic: QpicT, scale: number): void {
      calls.push({ fn: "Draw_ScaledTransPic", x, y, picName: nameOf(pic), scale });
    },
    Draw_GlyphAtlas(dstX: number, dstY: number, dstW: number, dstH: number, _source: GlyphAtlasSourceT, _srcX: number, _srcY: number, _srcW: number, _srcH: number): void {
      calls.push({ fn: "Draw_GlyphAtlas", x: dstX, y: dstY, w: dstW, h: dstH, scale: dstW / 8 });
    },
  };

  return { renderer, calls };
}

const fake = makeFakeRenderer();
re.current = fake.renderer;

beforeEach(() => {
  fake.calls.length = 0;
  vid.numpages = 2;
  scr_menuscale.value = 0; // auto (fit) -- this unit's default

  keyState.key_dest = KeydestT.key_menu;
  menuState.m_state = MStateT.m_main;
  menuState.m_main_cursor = 0;
});

//=============================================================================

describe("QW menu canvas: M_CanvasScale/M_CanvasX/M_CanvasY", () => {
  test("MENU_CANVAS_WIDTH/HEIGHT are the shared 320x200 canvas", () => {
    expect(MENU_CANVAS_WIDTH).toBe(320);
    expect(MENU_CANVAS_HEIGHT).toBe(200);
  });

  test("1920x1080 fits at scale 5, centred", () => {
    vid.width = 1920;
    vid.height = 1080;

    expect(MenuFitScale()).toBe(5);
    expect(M_CanvasScale()).toBe(5);
    // (1920 - 320*5)/2 = 160, + 16*5 = 240
    expect(M_CanvasX(16)).toBe(240);
    // (1080 - 200*5)/2 = 40, + 4*5 = 60
    expect(M_CanvasY(4)).toBe(60);
  });

  test("640x480 fits at scale 2, centred", () => {
    vid.width = 640;
    vid.height = 480;

    expect(MenuFitScale()).toBe(2);
    expect(M_CanvasScale()).toBe(2);
    // (640 - 320*2)/2 = 0, + 16*2 = 32
    expect(M_CanvasX(16)).toBe(32);
    // (480 - 200*2)/2 = 40, + 4*2 = 48
    expect(M_CanvasY(4)).toBe(48);
  });

  test("320x240 fits at scale 1 (the classic boot shape), byte-identical to the pre-G9 centring", () => {
    vid.width = 320;
    vid.height = 240;

    expect(MenuFitScale()).toBe(1);
    expect(M_CanvasScale()).toBe(1);
    // (320 - 320)/2 = 0, + 16 = 16 -- the C's own `(vid.width-320)>>1` centring
    expect(M_CanvasX(16)).toBe(16);
    // (240 - 200)/2 = 20, + 4 = 24
    expect(M_CanvasY(4)).toBe(24);
  });

  test("scr_menuscale clamps between 1 and the fit", () => {
    vid.width = 1920;
    vid.height = 1080;

    scr_menuscale.value = 2;
    expect(MenuScale()).toBe(2);

    scr_menuscale.value = 99; // past the fit (5) -- clamped down to it
    expect(MenuScale()).toBe(5);

    scr_menuscale.value = 0.5; // below 1 -- clamped up to it
    expect(MenuScale()).toBe(1);
  });
});

describe("QW menu: M_Main_Draw plaque placement at scale", () => {
  test("1920x1080: gfx/qplaque.lmp draws through Draw_ScaledTransPic at scale 5, canvas (16,4)", () => {
    vid.width = 1920;
    vid.height = 1080;

    M_Main_Draw();

    const hit = fake.calls.find((c): c is Extract<DrawCall, { fn: "Draw_ScaledTransPic" }> => c.fn === "Draw_ScaledTransPic" && c.picName === "gfx/qplaque.lmp");
    expect(hit).toBeDefined();
    expect(hit?.scale).toBe(5);
    expect(hit?.x).toBe(M_CanvasX(16));
    expect(hit?.y).toBe(M_CanvasY(4));

    // never falls back to the unscaled primitive at this scale
    const unscaled = fake.calls.some((c) => c.fn === "Draw_TransPic" && c.picName === "gfx/qplaque.lmp");
    expect(unscaled).toBe(false);
  });

  test("640x480: gfx/qplaque.lmp draws through Draw_ScaledTransPic at scale 2, canvas (16,4)", () => {
    vid.width = 640;
    vid.height = 480;

    M_Main_Draw();

    const hit = fake.calls.find((c): c is Extract<DrawCall, { fn: "Draw_ScaledTransPic" }> => c.fn === "Draw_ScaledTransPic" && c.picName === "gfx/qplaque.lmp");
    expect(hit).toBeDefined();
    expect(hit?.scale).toBe(2);
    expect(hit?.x).toBe(M_CanvasX(16));
    expect(hit?.y).toBe(M_CanvasY(4));
  });

  test("320x240 (scale 1): gfx/qplaque.lmp draws through the plain Draw_TransPic primitive, unscaled", () => {
    vid.width = 320;
    vid.height = 240;

    M_Main_Draw();

    const hit = fake.calls.find((c): c is Extract<DrawCall, { fn: "Draw_TransPic" }> => c.fn === "Draw_TransPic" && c.picName === "gfx/qplaque.lmp");
    expect(hit).toBeDefined();
    expect(hit?.x).toBe(16); // M_CanvasX(16) at scale 1 == the C's own centring
    expect(hit?.y).toBe(24);

    const scaled = fake.calls.some((c) => c.fn === "Draw_ScaledTransPic" && c.picName === "gfx/qplaque.lmp");
    expect(scaled).toBe(false);
  });

  test("M_DrawCharacter (the Load/Save line cursor, the level-select '*', slider parts) scales through Draw_GlyphAtlas past scale 1", () => {
    vid.width = 1920;
    vid.height = 1080;

    M_DrawCharacter(8, 32, 13); // an arbitrary conchars-artwork cell, e.g. the blink-cursor's alt frame

    const glyphs = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_GlyphAtlas" }> => c.fn === "Draw_GlyphAtlas");
    expect(glyphs.length).toBe(1);
    expect(glyphs[0].w).toBe(8 * 5);
    expect(glyphs[0].h).toBe(8 * 5);
    expect(glyphs[0].scale).toBe(5);
    expect(glyphs[0].x).toBe(M_CanvasX(8));
    expect(glyphs[0].y).toBe(M_CanvasY(32));

    // never falls back to the raw, unscaled Draw_Character at this scale
    expect(fake.calls.some((c) => c.fn === "Draw_Character")).toBe(false);
  });

  test("M_DrawCharacter at scale 1 draws through the plain Draw_Character primitive, unscaled", () => {
    vid.width = 320;
    vid.height = 240;

    M_DrawCharacter(8, 32, 13);

    const chars = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Character" }> => c.fn === "Draw_Character");
    expect(chars).toEqual([{ fn: "Draw_Character", x: M_CanvasX(8), y: M_CanvasY(32), num: 13 }]);
    expect(fake.calls.some((c) => c.fn === "Draw_GlyphAtlas")).toBe(false);
  });
});
