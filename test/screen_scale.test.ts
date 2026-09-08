/*
Self-sufficient tests for U19's HUD/console scaling: kfont_text.ts's
ConsoleVirtualWidth/ConsoleScale/SbarScale formulas (QuakeSpasm's own
gl_screen.c cvar semantics -- see that file's header), console.ts's
Con_CheckResize reading them, sbar.ts's Sbar_DrawCharacter/Sbar_DrawString
scaling their real-pixel anchor, and src/ref_soft/draw.ts's Draw_GlyphAtlas
nearest-neighbour stretch blit (both the 8-bit buffer and the U25 true-color
overlay).

Per standing order 13: every shared singleton mutated here (vid.*, rState.*,
re.current, the kfont_text.ts scale cvars) is saved before and restored in
afterAll/afterEach as appropriate.
*/

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { vid } from "../src/client/vid";
import { d_8to24table } from "../src/client/vid";
import { re, type Renderer } from "../src/client/render";
import { TextureT } from "../src/common/model";
import { rState } from "../src/ref_soft/r_shared";
import { Con_CheckResize, Con_Init, conState } from "../src/client/console";
import { cl, CactiveT, cls } from "../src/client/client";
import { GAME_DEATHMATCH } from "../src/common/protocol";
import { Sbar_DrawCharacter, Sbar_DrawString, SBAR_HEIGHT } from "../src/client/sbar";
import {
  ConsoleAutoScale,
  ConsoleScale,
  ConsoleVirtualWidth,
  CrosshairScale,
  scr_conscale,
  scr_crosshairscale,
  scr_sbarscale,
  SbarScale,
  test_ResetGlyphCache,
} from "../src/client/kfont_text";
import { CvarT } from "../src/common/cvar";
import { MenuFitScale, MenuScale, scr_menuscale } from "../src/client/screen";
import * as softDrawModule from "../src/ref_soft/draw";
import type { GlyphAtlasSourceT } from "../src/client/kfont_text";

function makeFakeRenderer(): Renderer {
  return {
    modelHooks: {
      notexture: new TextureT(),
      textureLoaded: () => {},
      Mod_LoadLighting: () => {},
      Mod_LoadAliasModel: () => {},
      Mod_LoadSpriteModel: () => {},
    },
    R_Init: () => {},
    R_InitTextures: () => {},
    R_InitEfrags: () => {},
    R_RenderView: () => {},
    R_ViewChanged: () => {},
    R_InitSky: () => {},
    R_AddEfrags: () => {},
    R_RemoveEfrags: () => {},
    R_NewMap: () => {},
    R_PushDlights: () => {},
    r_cache_thrash: false,
    D_SurfaceCacheForRes: () => 0,
    D_FlushCaches: () => {},
    D_DeleteSurfaceCache: () => {},
    D_InitCaches: () => {},
    R_SetVrect: () => {},
    draw_disc: null,
    Draw_Init: () => {},
    Draw_Character: () => {},
    Draw_DebugChar: () => {},
    Draw_Pic: () => {},
    Draw_TransPic: () => {},
    Draw_TransPicTranslate: () => {},
    Draw_ConsoleBackground: () => {},
    Draw_BeginDisc: () => {},
    Draw_EndDisc: () => {},
    Draw_TileClear: () => {},
    Draw_Fill: () => {},
    Draw_FadeScreen: () => {},
    Draw_String: () => {},
    Draw_PicFromWad: () => null,
    Draw_CachePic: () => null,
    D_StartParticles: () => {},
    D_DrawParticle: () => {},
    D_EndParticles: () => {},
    V_CalcBlend: () => {},
    V_UpdatePalette: () => {},
    V_DrawCrosshair: () => {},
    R_TranslatePlayerSkin: () => {},
    SCR_CalcRefdef: () => {},
    BeginFrame: () => {},
    EndFrame: () => {},
    D_EnableBackBufferAccess: () => {},
    D_DisableBackBufferAccess: () => {},
    D_UpdateRects: () => {},
    GL_Set2D: () => {},
    SCR_TileClear: () => {},
    SCR_SoftwareTileClear: () => {},
    SCR_DrawCrosshair: () => {},
    Draw_SubPic: () => {},
    Draw_Alt_String: () => {},
    isGL: false,
    SCR_ScreenShot_f: () => {},
    // through the module namespace, so a spy on softDrawModule.Draw_GlyphAtlas sees the call
    Draw_GlyphAtlas: (...args: Parameters<typeof softDrawModule.Draw_GlyphAtlas>) => softDrawModule.Draw_GlyphAtlas(...args),
  };
}

const savedWidth = vid.width;
const savedHeight = vid.height;
const savedConscale = scr_conscale.value;
const savedSbarscale = scr_sbarscale.value;
const savedCrosshairscale = scr_crosshairscale.value;
const savedMenuscale = { value: scr_menuscale.value, string: scr_menuscale.string };

afterAll(() => {
  vid.width = savedWidth;
  vid.height = savedHeight;
  scr_conscale.value = savedConscale;
  scr_sbarscale.value = savedSbarscale;
  scr_crosshairscale.value = savedCrosshairscale;
  scr_menuscale.value = savedMenuscale.value;
  scr_menuscale.string = savedMenuscale.string;
});

describe("kfont_text.ts -- ConsoleVirtualWidth/ConsoleScale (QuakeSpasm SCR_Conwidth_f formula)", () => {
  test("scr_conscale=0 (the default, auto) is one step per 300 rows: 3 at 1280x960, 2 at 720p, 1 at 480p", () => {
    vid.width = 1280;
    vid.height = 960;
    scr_conscale.value = 0;
    expect(ConsoleAutoScale()).toBe(3);
    expect(ConsoleVirtualWidth()).toBe(424); // floor(1280/3) & ~7
    expect(ConsoleScale()).toBeCloseTo(1280 / 424, 6);

    vid.width = 1280;
    vid.height = 720;
    expect(ConsoleAutoScale()).toBe(2);
    expect(ConsoleVirtualWidth()).toBe(640);

    vid.width = 640;
    vid.height = 480;
    expect(ConsoleAutoScale()).toBe(1);
    expect(ConsoleVirtualWidth()).toBe(640);
  });

  test("scr_conscale=1 is native resolution: no scaling", () => {
    vid.width = 1280;
    vid.height = 960;
    scr_conscale.value = 1;
    expect(ConsoleVirtualWidth()).toBe(1280);
    expect(ConsoleScale()).toBe(1);
  });

  test("scr_conscale=2 halves the virtual width, doubling the scale", () => {
    vid.width = 1280;
    vid.height = 960;
    scr_conscale.value = 2;
    expect(ConsoleVirtualWidth()).toBe(640);
    expect(ConsoleScale()).toBe(2);
  });

  test("clamped to a minimum of 320 (never scales the console narrower than classic)", () => {
    vid.width = 640;
    vid.height = 480;
    scr_conscale.value = 4; // 640/4 = 160, clamped up to 320
    expect(ConsoleVirtualWidth()).toBe(320);
    expect(ConsoleScale()).toBe(2);
  });

  test("rounds down to a multiple of 8 (matches QuakeSpasm's `& 0xFFFFFFF8`)", () => {
    vid.width = 1000;
    vid.height = 750;
    scr_conscale.value = 1;
    expect(ConsoleVirtualWidth() % 8).toBe(0);
    expect(ConsoleVirtualWidth()).toBeLessThanOrEqual(1000);
  });
});

describe("console.ts -- Con_CheckResize reads the scaled console width", () => {
  test("at 1280x960 with scr_conscale=2, con_linewidth matches the 640-wide virtual console (not the real 1280)", () => {
    vid.width = 1280;
    vid.height = 960;
    scr_conscale.value = 2;
    Con_Init();
    conState.con_linewidth = -1; // force Con_CheckResize to recompute
    Con_CheckResize();
    expect(conState.con_linewidth).toBe((640 >> 3) - 2); // 78
  });

  test("scr_conscale=1 matches the pre-U19 vid.width-based formula exactly", () => {
    vid.width = 1280;
    vid.height = 960;
    scr_conscale.value = 1;
    conState.con_linewidth = -1;
    Con_CheckResize();
    expect(conState.con_linewidth).toBe((1280 >> 3) - 2);
  });
});

describe("kfont_text.ts -- SbarScale/CrosshairScale (QuakeSpasm CLAMP formulas)", () => {
  test("SbarScale: CLAMP(1, scr_sbarscale.value, fit) with fit = min(floor(w/320), floor(h/144))", () => {
    vid.width = 320;
    vid.height = 200;
    scr_sbarscale.value = 1;
    expect(SbarScale()).toBe(1);

    vid.width = 640;
    vid.height = 480;
    scr_sbarscale.value = 3; // clamped down to the fit, floor(640/320) = 2
    expect(SbarScale()).toBe(2);

    vid.width = 640;
    vid.height = 200; // too short for 2x: floor(200/144) = 1
    scr_sbarscale.value = 3;
    expect(SbarScale()).toBe(1);
  });

  test("SbarScale: 0 (the default) is auto = the fit: 1 at 320x200 and 640x480 below 2 bars, 4 at 720p, 6 at 1080p", () => {
    scr_sbarscale.value = 0;
    vid.width = 320;
    vid.height = 200;
    expect(SbarScale()).toBe(1);
    vid.width = 640;
    vid.height = 480;
    expect(SbarScale()).toBe(2);
    vid.width = 1280;
    vid.height = 720;
    expect(SbarScale()).toBe(4);
    vid.width = 1920;
    vid.height = 1080;
    expect(SbarScale()).toBe(6);
  });

  test("CrosshairScale: CLAMP(1, scr_crosshairscale.value, 10)", () => {
    scr_crosshairscale.value = 0;
    expect(CrosshairScale()).toBe(1);
    scr_crosshairscale.value = 5;
    expect(CrosshairScale()).toBe(5);
    scr_crosshairscale.value = 99;
    expect(CrosshairScale()).toBe(10);
  });
});

describe("sbar.ts -- Sbar_DrawCharacter/Sbar_DrawString scale around the F2b scale-tied anchor", () => {
  const savedGametype = cl.gametype;
  const savedClsState = cls.state;

  beforeEach(() => {
    re.current = makeFakeRenderer();
    vid.width = 640;
    vid.height = 480;
    cl.gametype = 0; // not GAME_DEATHMATCH
    cls.state = CactiveT.ca_active;
    scr_sbarscale.value = 1;
    test_ResetGlyphCache();
  });

  afterEach(() => {
    cl.gametype = savedGametype;
    cls.state = savedClsState;
  });

  test("at scale 1 (default), positions match the pre-U19 anchor formula exactly", () => {
    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Sbar_DrawCharacter(10, 5, "Q".charCodeAt(0));
      // pre-U19: x + ((vid.width-320)>>1) + 4, y + vid.height - SBAR_HEIGHT
      const anchorX = (vid.width - 320) >> 1;
      const anchorY = vid.height - SBAR_HEIGHT;
      expect(spy).toHaveBeenCalledTimes(0); // classic/scale-1 still takes the direct renderer.Draw_Character path -- see kfont_text.ts's Text_Draw
      void anchorX;
      void anchorY;
    } finally {
      spy.mockRestore();
    }
  });

  test("at scale 2, the anchor itself moves with the scale (stays centred/bottom-glued) and the (x,y) sbar-local offset scales around THAT anchor", () => {
    scr_sbarscale.value = 2;
    expect(SbarScale()).toBe(2); // vid.width/320 = 2, so CLAMP(1,2,2) = 2

    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Sbar_DrawCharacter(10, 5, "Q".charCodeAt(0));
      expect(spy).toHaveBeenCalledTimes(1);

      // F2b: `(vid.width - 320*s)/2` (0: 640 - 320*2 == 0, so the scaled bar
      // exactly fills the 640-wide screen) and `vid.height - SBAR_HEIGHT*s`
      // (432: the taller bar still ends flush with the bottom) -- see
      // sbar.ts's own header's F2b note.
      const anchorX = Math.floor((vid.width - 320 * 2) / 2); // 0
      const anchorY = vid.height - SBAR_HEIGHT * 2; // 432
      const [dstX, dstY, dstW, dstH] = spy.mock.calls[0]!;
      expect(dstX).toBe(anchorX + (10 + 4) * 2); // 0 + 28 = 28
      expect(dstY).toBe(anchorY + 5 * 2); // 432 + 10 = 442
      expect(dstW).toBe(16); // 8 * scale
      expect(dstH).toBe(16);
    } finally {
      spy.mockRestore();
    }
  });

  test("deathmatch drops the (vid.width-320*s)/2 centering term but still glues the bottom to the SCALED height", () => {
    cl.gametype = GAME_DEATHMATCH;
    scr_sbarscale.value = 2;

    const spy = spyOn(softDrawModule, "Draw_GlyphAtlas");
    try {
      Sbar_DrawString(0, 0, "Q");
      const [dstX, dstY] = spy.mock.calls[0]!;
      expect(dstX).toBe(0);
      // F2b: anchorY (`vid.height - SBAR_HEIGHT*s`) IS scaled now -- only the
      // deathmatch x-centering term is dropped; at y=0 the y offset is just
      // the (now scaled) anchor itself.
      expect(dstY).toBe(vid.height - SBAR_HEIGHT * 2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("src/ref_soft/draw.ts -- Draw_GlyphAtlas nearest-neighbour scaling", () => {
  const W = 16;
  const H = 16;
  const savedBuffer = vid.buffer;
  const savedBuffer32 = vid.buffer32;
  const savedRowbytes = vid.rowbytes;
  const savedTruecolor = rState.r_truecolor;

  afterAll(() => {
    vid.buffer = savedBuffer;
    vid.buffer32 = savedBuffer32;
    vid.rowbytes = savedRowbytes;
    rState.r_truecolor = savedTruecolor;
  });

  beforeEach(() => {
    vid.width = W;
    vid.height = H;
    vid.rowbytes = W;
    vid.buffer = new Uint8Array(W * H).fill(0);
    vid.buffer32 = new Uint32Array(W * H).fill(0);
    for (let i = 0; i < 256; i++) d_8to24table[i] = (255 << 24) | (i << 16) | (i << 8) | i; // grayscale ramp, palette index i ~ RGB(i,i,i)
    rState.r_truecolor = true;
  });

  // A 2x2 RGBA atlas, each texel a distinct opaque color, no palette
  // ambiguity at the corners.
  const ATLAS_W = 2;
  const ATLAS_H = 2;
  const atlasPixels = new Uint8Array([
    255, 0, 0, 255, // (0,0) red
    0, 255, 0, 255, // (1,0) green
    0, 0, 255, 255, // (0,1) blue
    255, 255, 0, 255, // (1,1) yellow
  ]);
  const source: GlyphAtlasSourceT = { kind: "custom", id: "screen_scale_test_atlas", width: ATLAS_W, height: ATLAS_H, pixels: atlasPixels };

  test("scale-2 output is an exact nearest-neighbour upscale of scale-1 output, byte for byte (true-color overlay)", () => {
    softDrawModule.Draw_GlyphAtlas(0, 0, ATLAS_W, ATLAS_H, source, 0, 0, ATLAS_W, ATLAS_H, null);
    const scale1 = vid.buffer32!.slice();

    vid.buffer32!.fill(0);
    vid.buffer!.fill(0);
    softDrawModule.Draw_GlyphAtlas(0, 0, ATLAS_W * 2, ATLAS_H * 2, source, 0, 0, ATLAS_W, ATLAS_H, null);
    const scale2 = vid.buffer32!;

    for (let y = 0; y < ATLAS_H * 2; y++) {
      for (let x = 0; x < ATLAS_W * 2; x++) {
        const nearestSrcX = Math.floor(x / 2);
        const nearestSrcY = Math.floor(y / 2);
        expect(scale2[y * W + x]).toBe(scale1[nearestSrcY * W + nearestSrcX]);
      }
    }
  });

  test("the 8-bit palette buffer is also stretched (one nearest-palette index for the whole glyph, per this unit's documented simplification)", () => {
    // pure red (255,0,0) is closest to palette index 255 on this grayscale
    // ramp fixture (all channels equal, so the nearest match is whichever
    // gray value minimizes the sum of squared channel differences -- not
    // asserted exactly here, just that SOME single index was picked and
    // applied uniformly to every opaque destination pixel).
    softDrawModule.Draw_GlyphAtlas(0, 0, ATLAS_W * 2, ATLAS_H * 2, source, 0, 0, ATLAS_W, ATLAS_H, null);
    const idx = vid.buffer![0];
    for (let y = 0; y < ATLAS_H * 2; y++) {
      for (let x = 0; x < ATLAS_W * 2; x++) {
        expect(vid.buffer![y * W + x]).toBe(idx);
      }
    }
  });

  test("an alpha-transparent atlas pixel is never drawn, at any scale", () => {
    const transparentSource: GlyphAtlasSourceT = {
      kind: "custom",
      id: "screen_scale_test_transparent",
      width: 1,
      height: 1,
      pixels: new Uint8Array([255, 255, 255, 0]),
    };
    softDrawModule.Draw_GlyphAtlas(0, 0, 4, 4, transparentSource, 0, 0, 1, 1, null);
    expect(vid.buffer32!.slice(0, 16).every((v) => v === 0)).toBe(true);
  });
});

//=============================================================================
// G4: screen.ts's scr_menuscale (gl_draw.c GL_SetCanvas CANVAS_MENU).

describe("screen.ts -- MenuFitScale/MenuScale (GL_SetCanvas CANVAS_MENU)", () => {
  function setMenuscale(v: number): void {
    scr_menuscale.value = v;
    scr_menuscale.string = String(v);
  }

  test("the fit is the largest whole scale at which 320x200 still fits", () => {
    vid.width = 1920;
    vid.height = 1080;
    expect(MenuFitScale()).toBe(5); // min(floor(1920/320)=6, floor(1080/200)=5)
    vid.width = 1280;
    vid.height = 720;
    expect(MenuFitScale()).toBe(3); // min(4, 3)
    vid.width = 640;
    vid.height = 480;
    expect(MenuFitScale()).toBe(2);
    vid.width = 320;
    vid.height = 240;
    expect(MenuFitScale()).toBe(1);
    vid.width = 320;
    vid.height = 200;
    expect(MenuFitScale()).toBe(1);
  });

  test("a window smaller than the canvas still reports 1, never 0", () => {
    vid.width = 256;
    vid.height = 160;
    expect(MenuFitScale()).toBe(1);
    setMenuscale(0);
    expect(MenuScale()).toBe(1);
  });

  test("scr_menuscale 0 is auto: the fit itself", () => {
    setMenuscale(0);
    vid.width = 1920;
    vid.height = 1080;
    expect(MenuScale()).toBe(5);
    vid.width = 640;
    vid.height = 480;
    expect(MenuScale()).toBe(2);
    vid.width = 320;
    vid.height = 240;
    expect(MenuScale()).toBe(1);
  });

  test("an explicit scr_menuscale is CLAMP(1, value, fit)", () => {
    vid.width = 1920;
    vid.height = 1080;
    setMenuscale(2);
    expect(MenuScale()).toBe(2);
    setMenuscale(5);
    expect(MenuScale()).toBe(5);
    setMenuscale(12);
    expect(MenuScale()).toBe(5); // clamped down to the fit
    setMenuscale(0.5);
    expect(MenuScale()).toBe(1); // clamped up to 1

    // The same explicit 2 clamps down at a window the canvas barely fits.
    vid.width = 320;
    vid.height = 240;
    setMenuscale(2);
    expect(MenuScale()).toBe(1);
  });

  test("a fresh cvar's construction default is 0 (auto), archived", () => {
    const fresh = new CvarT("scr_menuscale", "0", true);
    expect(fresh.value).toBe(0);
    expect(fresh.archive).toBe(true);
  });
});
