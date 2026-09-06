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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

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
import { GAME_DEATHMATCH } from "../src/common/protocol";
import { scr_sbarscale } from "../src/client/kfont_text";
import { scr_viewsize } from "../src/client/screen";
// F2b: "a seat rect" test below -- see that test's own header note for why
// this is the minimal-footprint way to raise the seat count (no server, no
// coop-cvar side effect) rather than test/splitscreen.test.ts's own heavier
// SS_Init/NET_Init setup.
import { SPLIT_LAYOUT_SIDE_BY_SIDE, SS_ActivateSeat, SS_Canvas, SS_SetSeats, cl_splitscreen_layout } from "../src/client/splitscreen";
import { sv, svs } from "../src/server/server";
import { Cvar_FindVar, Cvar_RegisterVariable } from "../src/common/cvar";

import {
  Sbar_Changed,
  Sbar_DontShowScores,
  Sbar_Draw,
  Sbar_DrawFace,
  Sbar_DrawNum,
  Sbar_DrawPic,
  Sbar_DrawTransPic,
  Sbar_Init,
  Sbar_IntermissionOverlay,
  Sbar_SortFrags,
  SBAR_HEIGHT,
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
  | { fn: "Draw_ScaledPic"; x: number; y: number; picName: string; scale: number }
  | { fn: "Draw_ScaledTransPic"; x: number; y: number; picName: string; scale: number }
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
    // F2: recorded, not dispatched to a real renderer module, so scale
    // tests here stay self-sufficient (no vid.buffer/rowbytes fixture
    // needed) -- see this file's own header.
    Draw_ScaledPic(x: number, y: number, pic: QpicT, scale: number): void {
      calls.push({ fn: "Draw_ScaledPic", x, y, picName: nameOf(pic), scale });
    },
    Draw_ScaledTransPic(x: number, y: number, pic: QpicT, scale: number): void {
      calls.push({ fn: "Draw_ScaledTransPic", x, y, picName: nameOf(pic), scale });
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

// F2b: sbar.ts's Sbar_Draw reads `scr_viewsize` through `Cvar_FindVar("viewsize")`
// (sbar.ts's own `sbarViewsizeTier`, a load-order-cycle workaround -- see its
// doc comment), which only sees this file's own `scr_viewsize.value` writes
// once the SAME cvar object is registered under that name. Idempotent, like
// every other suite's own "register if nothing has claimed the name yet"
// guard, so a full-suite run where some other file already registered it is
// unaffected.
if (!Cvar_FindVar("viewsize")) Cvar_RegisterVariable(scr_viewsize);

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
  const savedViewsize = { value: scr_viewsize.value, string: scr_viewsize.string };
  afterAll(() => {
    scr_viewsize.value = savedViewsize.value;
    scr_viewsize.string = savedViewsize.string;
  });

  test("with a with-inventory viewsize (<110) and a flashing item draws inventory pics", () => {
    // F2b: Sbar_Draw now reads the VIEWSIZE TIER (sbarViewsizeTier(), this
    // file's own doc comment), not `scrState.sb_lines`'s magnitude, to decide
    // whether to draw the inventory row -- see sbar.ts's own header's F2b
    // note. `scrState.sb_lines` is set to what the real SCR_CalcRefdef would
    // compute for this same tier (24+16+8 unscaled), kept for Sbar_Draw's own
    // Draw_TileClear pixel math even though it no longer gates the ladder.
    scr_viewsize.value = 100; // < 110 -> Sbar_DrawInventory runs
    scrState.sb_lines = 48;
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
    // Also drew the base status bar pics, proving the with-inventory ladder ran.
    expect(pics.some((p) => p.picName === "ibar")).toBe(true);
  });

  test("a viewsize >= 110 (no-inventory tier) skips Sbar_DrawInventory even when scrState.sb_lines reads a with-inventory magnitude", () => {
    // F2b's own regression case: at scr_sbarscale 2 a no-inventory tier's
    // scaled sb_lines (24*2 = 48) reads exactly like the unscaled
    // with-inventory tier's own 48 -- proving the fix reads viewsize, not
    // scrState.sb_lines, for this decision. See sbarViewsizeTier's own doc
    // comment in sbar.ts.
    scr_viewsize.value = 115; // >= 110, < 120 -> no inventory, bar still drawn
    scrState.sb_lines = 48; // what a scale-2 no-inventory tier would read (24*2)
    cl.maxclients = 1;
    cl.stats[STAT_HEALTH] = 50;
    cl.items = 1; // IT_SHOTGUN -- would draw a weapon pic if Sbar_DrawInventory ran

    Sbar_Draw();

    const pics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Pic" }> => c.fn === "Draw_Pic");
    expect(pics.some((p) => p.picName === "inva2_shotgun")).toBe(false); // Sbar_DrawInventory did NOT run
    expect(pics.some((p) => p.picName === "sbar")).toBe(true); // the base bar itself still draws (viewsize < 120)
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

describe("Sbar_DrawPic / Sbar_DrawTransPic scr_sbarscale (F2/F2b)", () => {
  const savedSbarscale = scr_sbarscale.value;
  const savedGametype = cl.gametype;

  afterAll(() => {
    scr_sbarscale.value = savedSbarscale;
    cl.gametype = savedGametype;
  });

  afterEach(() => {
    cl.gametype = savedGametype;
  });

  test("at scale 1 (vid.width 320 clamps SbarScale to 1 regardless of the cvar), draws through the plain unscaled Draw_Pic/Draw_TransPic", () => {
    scr_sbarscale.value = 4; // irrelevant here: sbarSeatScale caps at vid.width/320 = 1
    cl.gametype = 0; // not GAME_DEATHMATCH

    Sbar_DrawPic(10, 5, sb_scorebar);
    Sbar_DrawTransPic(20, 8, sb_scorebar);

    const anchorY = vid.height - SBAR_HEIGHT; // 176
    expect(fake.calls).toEqual([
      { fn: "Draw_Pic", x: 10, y: 5 + anchorY, picName: "scorebar" },
      { fn: "Draw_TransPic", x: 20, y: 8 + anchorY, picName: "scorebar" },
    ]);
  });

  test("at scale 2 (vid.width 640, scr_sbarscale 2), position and size both scale around a scale-tied anchor that stays centred and on screen", () => {
    vid.width = 640;
    scr_sbarscale.value = 2;
    cl.gametype = 0; // not GAME_DEATHMATCH

    Sbar_DrawPic(10, 5, sb_scorebar);
    Sbar_DrawTransPic(20, -16, sb_scorebar);

    // F2b: the anchor now moves WITH the scale -- `(vid.width - 320*s)/2` (0
    // here: 640 - 320*2 == 0, so the 640-wide scaled bar exactly fills the
    // 640-wide screen) and `vid.height - SBAR_HEIGHT*s` (152: the taller,
    // scaled bar still ends flush with the bottom) -- see sbar.ts's own
    // header's F2b note and this suite's own header just above.
    const anchorX = Math.floor((vid.width - 320 * 2) / 2); // 0
    const anchorY = vid.height - SBAR_HEIGHT * 2; // 152

    expect(fake.calls).toEqual([
      { fn: "Draw_ScaledPic", x: anchorX + 10 * 2, y: anchorY + 5 * 2, picName: "scorebar", scale: 2 },
      { fn: "Draw_ScaledTransPic", x: anchorX + 20 * 2, y: anchorY + -16 * 2, picName: "scorebar", scale: 2 },
    ]);
  });

  test("deathmatch drops the (vid.width-320*s)/2 centering term but still glues the bottom to the SCALED height, at scale 2", () => {
    vid.width = 640;
    scr_sbarscale.value = 2;
    cl.gametype = GAME_DEATHMATCH;

    Sbar_DrawPic(0, 0, sb_scorebar);

    expect(fake.calls).toEqual([{ fn: "Draw_ScaledPic", x: 0, y: vid.height - SBAR_HEIGHT * 2, picName: "scorebar", scale: 2 }]);
  });

  test("a seat's own rect: two side-by-side seats, the active (right) seat centres within its OWN pane at its OWN scale, not the whole screen's", () => {
    // F2b: "the seat's rect" case the unit brief asks for -- SS_Canvas()
    // returns a genuinely offset, narrower pane once more than one seat is
    // live (src/client/splitscreen.ts's own SS_Layout), and sbarCenterX/
    // sbarAnchorY must add the scaled centering to the PANE's own origin, not
    // vid.width/vid.height's. `sv.active = true` with `svs.maxclients` already
    // at the seat count sidesteps SS_SetSeats' `SS_WidenServer` branch
    // entirely (no server, no coop-cvar side effect) -- the minimal-footprint
    // path; test/splitscreen.test.ts's own SS_Init/NET_Init setup exercises
    // the heavier "no server yet" path, out of this unit's SCOPE to touch.
    const savedVidWidth = vid.width;
    const savedSvActive = sv.active;
    const savedMaxclients = svs.maxclients;
    const savedLayout = cl_splitscreen_layout.value;
    try {
      vid.width = 1280; // two 640-wide side-by-side panes
      scr_sbarscale.value = 2;
      cl.gametype = 0;
      cl_splitscreen_layout.value = SPLIT_LAYOUT_SIDE_BY_SIDE;
      sv.active = true;
      svs.maxclients = 2; // >= the seat count asked for -- SS_SetSeats sets seatCount directly, no SS_WidenServer call
      SS_SetSeats(2);
      SS_ActivateSeat(1); // the right-hand pane: x = halfW, width = vid.width - halfW

      const pane = SS_Canvas();
      expect(pane).toEqual({ x: 640, y: 0, width: 640, height: 200 });

      Sbar_DrawPic(10, 5, sb_scorebar);

      // pane cap = max(1, pane.width/320) = 2, so scr_sbarscale 2 is NOT
      // capped down here (unlike a quarter-screen pane would be) -- anchor is
      // pane.x + (pane.width - 320*2)/2 = 640 + 0 = 640, pane.bottom -
      // SBAR_HEIGHT*2 = 200 - 48 = 152.
      expect(fake.calls).toEqual([{ fn: "Draw_ScaledPic", x: 640 + 10 * 2, y: 152 + 5 * 2, picName: "scorebar", scale: 2 }]);
    } finally {
      SS_ActivateSeat(0);
      SS_SetSeats(1);
      vid.width = savedVidWidth;
      sv.active = savedSvActive;
      svs.maxclients = savedMaxclients;
      cl_splitscreen_layout.value = savedLayout;
    }
  });
});
