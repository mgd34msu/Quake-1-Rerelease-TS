// Tests for src/client/ctf_hud.ts (F9). Self-sufficient per the standing
// orders: registers nothing globally, resets `cl` via `cl.clear()` in
// beforeEach, and restores `re.current` (src/client/render.ts) in afterAll --
// the only shared singleton this file touches.
//
// Draw-list coverage runs through the SAME fake-Renderer recipe
// test/sbar.test.ts already uses (a plain object satisfying the `Renderer`
// interface, `Draw_Character` capturing calls): at scr_sbarscale's default
// (1) with no custom font resolved, src/client/kfont_text.ts's Text_Draw
// takes its pre-U19 fast path and calls `Renderer.Draw_Character` directly,
// one call per character, which is what CTF_Draw's Sbar_DrawString calls
// bottom out in. Run twice with `isGL` true and false (the "both renderers"
// case this unit's brief asks for) to prove CTF_Draw's own call sequence
// does not depend on which renderer is active -- the renderer-specific
// difference lives inside each renderer's own Draw_Character, already
// covered by src/ref_gl/gl_draw.ts's and src/ref_soft/draw.ts's own suites.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { cl, ClientStateT, CtfFlagStateT } from "../src/client/client";
import { EntityT, ParticleT, re } from "../src/client/render";
import type { Renderer } from "../src/client/render";
import { vid } from "../src/client/vid";
import { VrectT } from "../src/client/vid";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import { QpicT } from "../src/common/wad";
import { Cmd_TokenizeString } from "../src/common/cmd";

import { CTF_Draw, CTF_ParseScores_f } from "../src/client/ctf_hud";

const savedRe = re.current;

afterAll(() => {
  re.current = savedRe;
});

beforeEach(() => {
  cl.clear();
  vid.width = 320;
  vid.height = 200;
});

//=============================================================================
// CTF_ParseScores_f
//=============================================================================

describe("CTF_ParseScores_f", () => {
  test('"ctfscores 3 2 9" -- both flags at base (bit0 red, bit3 blue)', () => {
    Cmd_TokenizeString("ctfscores 3 2 9");
    CTF_ParseScores_f();

    expect(cl.ctf.active).toBe(true);
    expect(cl.ctf.redScore).toBe(3);
    expect(cl.ctf.blueScore).toBe(2);
    expect(cl.ctf.redFlag).toBe(CtfFlagStateT.atBase);
    expect(cl.ctf.blueFlag).toBe(CtfFlagStateT.atBase);
  });

  test('"ctfscores 5 1 20" -- red flag dropped (bit2=4), blue flag carried (bit4=16)', () => {
    Cmd_TokenizeString("ctfscores 5 1 20");
    CTF_ParseScores_f();

    expect(cl.ctf.redScore).toBe(5);
    expect(cl.ctf.blueScore).toBe(1);
    expect(cl.ctf.redFlag).toBe(CtfFlagStateT.dropped);
    expect(cl.ctf.blueFlag).toBe(CtfFlagStateT.carried);
  });

  test("the two teams' flag bits decode independently (red carried, blue dropped)", () => {
    // bit1 (2, red carried) + bit5 (32, blue dropped) = 34
    Cmd_TokenizeString("ctfscores 0 0 34");
    CTF_ParseScores_f();

    expect(cl.ctf.redFlag).toBe(CtfFlagStateT.carried);
    expect(cl.ctf.blueFlag).toBe(CtfFlagStateT.dropped);
  });

  test("flagstatus 0 (no bit set for either team) decodes to unknown, not a crash", () => {
    Cmd_TokenizeString("ctfscores 0 0 0");
    CTF_ParseScores_f();

    expect(cl.ctf.active).toBe(true); // the command still arrived
    expect(cl.ctf.redFlag).toBe(CtfFlagStateT.unknown);
    expect(cl.ctf.blueFlag).toBe(CtfFlagStateT.unknown);
  });

  test("a malformed stuffcmd (wrong argument count) is ignored, not thrown", () => {
    Cmd_TokenizeString("ctfscores 1 2"); // missing flagstatus
    expect(() => CTF_ParseScores_f()).not.toThrow();
    expect(cl.ctf.active).toBe(false);
    expect(cl.ctf.redScore).toBe(0);
  });
});

//=============================================================================
// State: default + cleared on level change / disconnect
//=============================================================================

describe("ClientStateT.clear() (level change / disconnect)", () => {
  test("a fresh ClientStateT starts with ctf inactive and every field zeroed", () => {
    // Construction-default check per standing order 13: a fresh instance,
    // never the live `cl` singleton.
    const fresh = new ClientStateT();
    expect(fresh.ctf.active).toBe(false);
    expect(fresh.ctf.redScore).toBe(0);
    expect(fresh.ctf.blueScore).toBe(0);
    expect(fresh.ctf.redFlag).toBe(CtfFlagStateT.unknown);
    expect(fresh.ctf.blueFlag).toBe(CtfFlagStateT.unknown);
  });

  test("cl.clear() (CL_ClearState's level change, and host.ts's clearClient hook on disconnect) resets every ctf field", () => {
    Cmd_TokenizeString("ctfscores 7 4 9");
    CTF_ParseScores_f();
    expect(cl.ctf.active).toBe(true);

    cl.clear();

    expect(cl.ctf.active).toBe(false);
    expect(cl.ctf.redScore).toBe(0);
    expect(cl.ctf.blueScore).toBe(0);
    expect(cl.ctf.redFlag).toBe(CtfFlagStateT.unknown);
    expect(cl.ctf.blueFlag).toBe(CtfFlagStateT.unknown);
  });
});

//=============================================================================
// CTF_Draw -- draw-list assertion, both renderers
//=============================================================================

type CharCall = { x: number; y: number; num: number };

function makeFakeRenderer(isGL: boolean): { renderer: Renderer; chars: CharCall[] } {
  const chars: CharCall[] = [];

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
    R_AddEfrags(_ent: EntityT): void {},
    R_RemoveEfrags(_ent: EntityT): void {},
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
      chars.push({ x, y, num });
    },
    Draw_DebugChar(_num: number): void {},
    Draw_Pic(_x: number, _y: number, _pic: QpicT): void {},
    Draw_TransPic(_x: number, _y: number, _pic: QpicT): void {},
    Draw_TransPicTranslate(_x: number, _y: number, _pic: QpicT, _translation: Uint8Array): void {},
    Draw_ConsoleBackground(_lines: number): void {},
    Draw_BeginDisc(): void {},
    Draw_EndDisc(): void {},
    Draw_TileClear(_x: number, _y: number, _w: number, _h: number): void {},
    Draw_Fill(_x: number, _y: number, _w: number, _h: number, _c: number): void {},
    Draw_FadeScreen(): void {},
    Draw_String(_x: number, _y: number, _str: string): void {},
    Draw_PicFromWad(_name: string): QpicT | null {
      return null;
    },
    Draw_CachePic(_path: string): QpicT | null {
      return null;
    },
    D_StartParticles(): void {},
    D_DrawParticle(_p: ParticleT): void {},
    D_EndParticles(): void {},
    V_CalcBlend(): void {},
    V_UpdatePalette(): void {},
    V_DrawCrosshair(): void {},
    R_TranslatePlayerSkin(_playernum: number): void {},
    SCR_CalcRefdef(): void {},
    BeginFrame(): void {},
    EndFrame(): void {},
    D_EnableBackBufferAccess(): void {},
    D_DisableBackBufferAccess(): void {},
    D_UpdateRects(_rects: VrectT | null): void {},
    GL_Set2D(): void {},
    SCR_TileClear(): void {},
    SCR_SoftwareTileClear(): void {},
    SCR_DrawCrosshair(): void {},
    Draw_SubPic(): void {},
    Draw_Alt_String(): void {},
    isGL,
    SCR_ScreenShot_f(): void {},
  };

  return { renderer, chars };
}

function textOf(calls: CharCall[]): string {
  return calls.map((c) => String.fromCharCode(c.num)).join("");
}

describe("CTF_Draw", () => {
  test("does nothing until this connection's first ctfscores update (cl.ctf.active === false)", () => {
    const fake = makeFakeRenderer(false);
    re.current = fake.renderer;

    CTF_Draw();

    expect(fake.chars.length).toBe(0);
  });

  for (const isGL of [true, false]) {
    test(`draws "RED <score> <flag>" and "BLU <score> <flag>" through Sbar_DrawString's anchor (isGL=${isGL})`, () => {
      const fake = makeFakeRenderer(isGL);
      re.current = fake.renderer;

      cl.ctf.active = true;
      cl.ctf.redScore = 3;
      cl.ctf.blueScore = 12;
      cl.ctf.redFlag = CtfFlagStateT.atBase;
      cl.ctf.blueFlag = CtfFlagStateT.carried;

      CTF_Draw();

      const redExpected = "RED 3 BASE";
      const blueExpected = "BLU 12 TAKEN";
      expect(fake.chars.length).toBe(redExpected.length + blueExpected.length);

      // Anchor at scale 1, vid.width 320 (no centring offset), cl.gametype
      // not GAME_DEATHMATCH: sbarCenterX(1) = 0, sbarAnchorY(1) =
      // vid.height - SBAR_HEIGHT = 200 - 24 = 176. CTF_Draw's own local
      // (x, y) offsets are (8, -40) for the red line and (168, -40) for the
      // blue line -- see ctf_hud.ts's own CTF_HUD_* constants.
      const anchorY = 176;
      const y = anchorY - 40;

      const redCalls = fake.chars.slice(0, redExpected.length);
      const blueCalls = fake.chars.slice(redExpected.length);

      expect(textOf(redCalls)).toBe(redExpected);
      expect(textOf(blueCalls)).toBe(blueExpected);

      expect(redCalls.every((c) => c.y === y)).toBe(true);
      expect(blueCalls.every((c) => c.y === y)).toBe(true);

      expect(redCalls[0]?.x).toBe(8);
      expect(blueCalls[0]?.x).toBe(168);
      // Each character advances by the classic 8px glyph width (scale 1).
      redCalls.forEach((c, i) => expect(c.x).toBe(8 + i * 8));
      blueCalls.forEach((c, i) => expect(c.x).toBe(168 + i * 8));
    });
  }

  test("an unknown flag state prints no word, just the team letters and score", () => {
    const fake = makeFakeRenderer(false);
    re.current = fake.renderer;

    cl.ctf.active = true;
    cl.ctf.redScore = 0;
    cl.ctf.blueScore = 0;
    cl.ctf.redFlag = CtfFlagStateT.unknown;
    cl.ctf.blueFlag = CtfFlagStateT.unknown;

    CTF_Draw();

    expect(textOf(fake.chars)).toBe("RED 0BLU 0");
  });
});
