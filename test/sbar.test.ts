// Tests for src/client/sbar.ts (U050). Self-sufficient: installs its own fake
// Renderer (src/client/render.ts's `re.current`), its own `vid`/`scrState`
// values, and resets `cl` via `cl.clear()` before every test, per the standing
// orders ("every suite initializes the globals it reads").
//
// rogue/hipnotic note: src/common/common.ts exports `rogue`/`hipnotic` as
// plain `let` bindings that only `COM_InitArgv` (also exported) reassigns by
// parsing `-rogue`/`-hipnotic` out of argv. That function *can* be called
// from here, but doing so would flip those flags for the rest of this bun
// process (there is no `-norogue` to undo it), permanently changing every
// other suite that shares this process. Per the brief's fallback, this file
// exercises the standard (non-rogue, non-hipnotic) path only.

import { beforeEach, describe, expect, test } from "bun:test";

import { cl } from "../src/client/client";
import { ScoreboardT } from "../src/client/client";
import { EntityT, ParticleT, re } from "../src/client/render";
import type { Renderer } from "../src/client/render";
import { vid } from "../src/client/vid";
import { VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import { QpicT } from "../src/common/wad";
import { STAT_HEALTH } from "../src/common/quakedef";

import {
  Sbar_Changed,
  Sbar_DontShowScores,
  Sbar_Draw,
  Sbar_DrawFace,
  Sbar_DrawNum,
  Sbar_Init,
  Sbar_IntermissionOverlay,
  Sbar_SortFrags,
  fragsort,
  sb_faces,
  sb_items,
  sb_nums,
  sb_scorebar,
  sb_updates,
  sb_weapons,
  scoreboardlines,
} from "../src/client/sbar";

type DrawCall =
  | { fn: "Draw_Pic"; x: number; y: number; picName: string }
  | { fn: "Draw_TransPic"; x: number; y: number; picName: string }
  | { fn: "Draw_Character"; x: number; y: number; num: number }
  | { fn: "Draw_String"; x: number; y: number; str: string }
  | { fn: "Draw_Fill"; x: number; y: number; w: number; h: number; c: number }
  | { fn: "Draw_TileClear"; x: number; y: number; w: number; h: number };

function makeFakeRenderer(): { renderer: Renderer; calls: DrawCall[]; picByName: Map<string, QpicT> } {
  const picByName = new Map<string, QpicT>();
  const nameByPic = new Map<QpicT, string>();
  const calls: DrawCall[] = [];

  function namedPic(name: string): QpicT {
    let p = picByName.get(name);
    if (!p) {
      p = new QpicT();
      p.width = 8;
      p.height = 8;
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
      calls.push({ fn: "Draw_Character", x, y, num });
    },
    Draw_DebugChar(_num: number): void {},
    Draw_Pic(x: number, y: number, pic: QpicT): void {
      calls.push({ fn: "Draw_Pic", x, y, picName: nameOf(pic) });
    },
    Draw_TransPic(x: number, y: number, pic: QpicT): void {
      calls.push({ fn: "Draw_TransPic", x, y, picName: nameOf(pic) });
    },
    Draw_TransPicTranslate(x: number, y: number, pic: QpicT, _translation: Uint8Array): void {
      calls.push({ fn: "Draw_TransPic", x, y, picName: nameOf(pic) });
    },
    Draw_ConsoleBackground(_lines: number): void {},
    Draw_BeginDisc(): void {},
    Draw_EndDisc(): void {},
    Draw_TileClear(x: number, y: number, w: number, h: number): void {
      calls.push({ fn: "Draw_TileClear", x, y, w, h });
    },
    Draw_Fill(x: number, y: number, w: number, h: number, c: number): void {
      calls.push({ fn: "Draw_Fill", x, y, w, h, c });
    },
    Draw_FadeScreen(): void {},
    Draw_String(x: number, y: number, str: string): void {
      calls.push({ fn: "Draw_String", x, y, str });
    },
    Draw_PicFromWad(name: string): QpicT | null {
      return namedPic(name);
    },
    Draw_CachePic(path: string): QpicT | null {
      return namedPic(path);
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
    isGL: false,
    SCR_ScreenShot_f(): void {},
  };

  return { renderer, calls, picByName };
}

const fake = makeFakeRenderer();
re.current = fake.renderer;

// Populate every sb_*/rsb_*/hsb_* table once; the fake's Draw_PicFromWad
// caches by name, so calling it again from another test would just hand
// back the same pic objects.
Sbar_Init();

beforeEach(() => {
  cl.clear();
  fake.calls.length = 0;
  Sbar_Changed(); // sb_updates = 0
  Sbar_DontShowScores(); // sb_showscores = false
  scrState.scr_con_current = 0;
  scrState.sb_lines = 0;
  scrState.scr_copyeverything = 0;
  scrState.scr_fullupdate = 0;
  vid.width = 320;
  vid.height = 200;
  vid.numpages = 2;
});

describe("Sbar_Init", () => {
  test("loads the expected wad picture names into the sb_* tables", () => {
    expect(sb_nums[0][5]).toBe(fake.picByName.get("num_5") ?? null);
    expect(sb_nums[1][10]).toBe(fake.picByName.get("anum_minus") ?? null);
    expect(sb_weapons[0][0]).toBe(fake.picByName.get("inv_shotgun") ?? null);
    // sb_weapons[2+i][4] = Draw_PicFromWad(`inva${i+1}_rlaunch`); i=2 -> row 4, "inva3_rlaunch"
    expect(sb_weapons[4][4]).toBe(fake.picByName.get("inva3_rlaunch") ?? null);
    expect(sb_items[0]).toBe(fake.picByName.get("sb_key1") ?? null);
    expect(sb_faces[1][0]).toBe(fake.picByName.get("face4") ?? null);
    expect(sb_faces[3][1]).toBe(fake.picByName.get("face_p2") ?? null);
    // The C calls `Draw_PicFromWad ("scorebar")` (no "sb_" prefix) for the
    // `sb_scorebar` *variable*; the brief's expected-name list says
    // "sb_scorebar", which is the variable name, not the wad lookup string.
    // Asserting against the actual C source string here.
    expect(sb_scorebar).toBe(fake.picByName.get("scorebar") ?? null);
  });
});

describe("Sbar_DrawNum", () => {
  test("health 25 color 1 draws anum_2, anum_5 right-aligned at the right x/y", () => {
    // Same call Sbar_Draw makes for the health line: cl.stats[STAT_HEALTH] = 25,
    // color = (health <= 25) = 1.
    Sbar_DrawNum(136, 0, 25, 3, 1);

    const transPics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_TransPic" }> => c.fn === "Draw_TransPic");
    // digits "25" (2 chars) right-aligned in a 3-digit field: x starts at
    // 136 + (3-2)*24 = 160, then +24 per digit; y offset by
    // Sbar_DrawTransPic (vid.width == 320, so no centering offset;
    // vid.height - SBAR_HEIGHT = 200 - 24 = 176).
    expect(transPics).toEqual([
      { fn: "Draw_TransPic", x: 160, y: 176, picName: "anum_2" },
      { fn: "Draw_TransPic", x: 184, y: 176, picName: "anum_5" },
    ]);
  });
});

describe("Sbar_DrawFace", () => {
  test("picks the face name from health, and the pain anim frame when cl.time <= faceanimtime", () => {
    cl.maxclients = 1;
    cl.items = 0;
    cl.stats[STAT_HEALTH] = 45; // f = trunc(45/20) = 2 -> sb_faces[2][anim]

    cl.time = 10;
    cl.faceanimtime = 5; // cl.time > faceanimtime -> anim 0 (static)
    Sbar_DrawFace();
    let pics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Pic" }> => c.fn === "Draw_Pic");
    expect(pics.length).toBe(1);
    expect(pics[0].picName).toBe("face3"); // sb_faces[2][0]

    fake.calls.length = 0;
    cl.time = 5;
    cl.faceanimtime = 10; // cl.time <= faceanimtime -> anim 1 (pain)
    Sbar_DrawFace();
    pics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Pic" }> => c.fn === "Draw_Pic");
    expect(pics.length).toBe(1);
    expect(pics[0].picName).toBe("face_p3"); // sb_faces[2][1]
    expect(sb_updates).toBe(0); // "make sure the anim gets drawn over"
  });
});

describe("Sbar_SortFrags", () => {
  test("orders fragsort by descending frags", () => {
    cl.maxclients = 3;
    const a = new ScoreboardT();
    a.name = "Alice";
    a.frags = 5;
    const b = new ScoreboardT();
    b.name = "Bob";
    b.frags = 10;
    const c = new ScoreboardT();
    c.name = "Carl";
    c.frags = 2;
    cl.scores = [a, b, c];

    Sbar_SortFrags();

    expect(scoreboardlines).toBe(3);
    expect(fragsort.slice(0, 3)).toEqual([1, 0, 2]); // Bob(10), Alice(5), Carl(2)
  });
});

describe("Sbar_Draw", () => {
  test("with sb_lines 48 and a flashing item draws inventory pics", () => {
    scrState.sb_lines = 48; // > 24 -> Sbar_DrawInventory runs
    cl.maxclients = 1; // skip Sbar_DrawFrags
    cl.stats[STAT_HEALTH] = 50;
    cl.items = 1; // IT_SHOTGUN
    cl.time = 1.0;
    cl.item_gettime[0] = 0.9; // flashon = trunc((1.0-0.9)*10) = 1 -> (1%5)+2 = 3

    Sbar_Draw();

    const pics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Pic" }> => c.fn === "Draw_Pic");
    // sb_weapons[3][0] = Draw_PicFromWad("inva2_shotgun") (row 2+i with i=1)
    const flash = pics.find((p) => p.picName === "inva2_shotgun");
    expect(flash).toBeDefined();
    expect(flash?.x).toBe(0); // i*24 with i=0, vid.width==320 so no centering
    expect(flash?.y).toBe(160); // -16 + (vid.height - SBAR_HEIGHT) = -16 + 176

    expect(sb_updates).toBe(0); // flashon > 1 forces sb_updates back to 0
    // Also drew the base status bar pics, proving the >24 ladder ran.
    expect(pics.some((p) => p.picName === "ibar")).toBe(true);
  });
});

describe("Sbar_IntermissionOverlay", () => {
  test("completed_time 125 places the '2:05' digits", () => {
    cl.completed_time = 125; // 2 minutes, 5 seconds

    Sbar_IntermissionOverlay();

    const transPics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_TransPic" }> => c.fn === "Draw_TransPic");
    // Sbar_IntermissionNumber(160, 64, dig=2, 3, 0): "2" right-aligned in a
    // 3-digit field starting at 160 -> x = 160 + (3-1)*24 = 208.
    expect(transPics).toContainEqual({ fn: "Draw_TransPic", x: 208, y: 64, picName: "num_2" });
    expect(transPics).toContainEqual({ fn: "Draw_TransPic", x: 234, y: 64, picName: "num_colon" });
    expect(transPics).toContainEqual({ fn: "Draw_TransPic", x: 246, y: 64, picName: "num_0" }); // tens of 05
    expect(transPics).toContainEqual({ fn: "Draw_TransPic", x: 266, y: 64, picName: "num_5" }); // units of 05
  });
});
