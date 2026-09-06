// Self-sufficient test for src/qw/client/sbar.ts and src/qw/client/menu.ts
// (QW/client/sbar.c, QW/client/menu.c), unit Q023a.
//
// Installs its own fake Renderer (src/client/render.ts's `re.current`), its
// own `vid`/`scrState`/`keyState` values, and resets `cl`/`cl.qw`/`cls`/
// `menuState` before every test, per the standing orders ("every suite
// initializes the globals it reads"). Never asserts on command-registry
// state for names WinQuake's own sbar.ts/menu.ts also register
// (`togglemenu`, `+showscores`, `-showscores`, `menu_main`, `menu_options`,
// `menu_keys`, `menu_video`, `help`, `menu_quit`), per the unit brief.

import { beforeEach, describe, expect, test } from "bun:test";

import { cl, cls } from "../src/client/client";
import { EntityT, ParticleT, re } from "../src/client/render";
import type { Renderer } from "../src/client/render";
import { vid } from "../src/client/vid";
import { VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { scr_viewsize } from "../src/client/screen";
import { keyState, KeydestT, K_ESCAPE, K_ENTER, K_DOWNARROW, K_UPARROW } from "../src/client/keys";
import { host } from "../src/common/host";
import { SZ_Alloc } from "../src/common/sizebuf";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import { QpicT } from "../src/common/wad";
import { STAT_HEALTH } from "../src/common/quakedef";

import { cl_sbar, cl_hudswap } from "../src/qw/client/cl_main";

import {
  Sbar_ColorForMap,
  Sbar_DeathmatchOverlay,
  Sbar_Draw,
  Sbar_DrawInventory,
  Sbar_Init,
  Sbar_SortFrags,
  Sbar_SortTeams,
  fragsort,
  scoreboardlines,
  scoreboardteams,
  teams,
  teamsort,
} from "../src/qw/client/sbar";

import { MAIN_ITEMS, MStateT, M_Draw, M_Keydown, M_ToggleMenu_f, menuState } from "../src/qw/client/menu";

//=============================================================================
// A minimal recording Renderer (same recipe as test/sbar.test.ts).

type DrawCall =
  | { fn: "Draw_Pic"; x: number; y: number; picName: string }
  | { fn: "Draw_TransPic"; x: number; y: number; picName: string }
  | { fn: "Draw_Character"; x: number; y: number; num: number }
  | { fn: "Draw_String"; x: number; y: number; str: string }
  | { fn: "Draw_Fill"; x: number; y: number; w: number; h: number; c: number }
  | { fn: "Draw_TileClear"; x: number; y: number; w: number; h: number }
  | { fn: "Draw_Alt_String"; x: number; y: number; str: string }
  | { fn: "Draw_SubPic"; x: number; y: number; picName: string; srcx: number; srcy: number; w: number; h: number };

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
    Draw_SubPic(x: number, y: number, pic: QpicT, srcx: number, srcy: number, w: number, h: number): void {
      calls.push({ fn: "Draw_SubPic", x, y, picName: nameOf(pic), srcx, srcy, w, h });
    },
    Draw_Alt_String(x: number, y: number, str: string): void {
      calls.push({ fn: "Draw_Alt_String", x, y, str });
    },
    isGL: false,
    SCR_ScreenShot_f(): void {},
  };

  return { renderer, calls, picByName };
}

const fake = makeFakeRenderer();
re.current = fake.renderer;

// Populate every sb_* table once, same as test/sbar.test.ts's own precedent.
Sbar_Init();

// cls.qw.netchan.message (NetchanT's SizeBuf) starts unallocated
// (maxsize 0); Sbar_DeathmatchOverlay's periodic "pings" stringcmd write
// would overflow it immediately otherwise.
SZ_Alloc(cls.qw.netchan.message, 1024);

// Widens the assigned type through a parameter: writing an enum member
// literal straight into keyState.key_dest/menuState.m_state lets tsc narrow
// the property to that literal for the rest of the enclosing block (even
// across an intervening function call), which then makes a later
// `expect(...).toBe(...)` a type error -- same issue and same fix as
// test/menu.test.ts's own `setKeyDest` helper.
function setKeyDest(v: KeydestT): void {
  keyState.key_dest = v;
}
function setMState(v: MStateT): void {
  menuState.m_state = v;
}

function resetMenuState(): void {
  menuState.m_state = MStateT.m_none;
  menuState.m_entersound = false;
  menuState.m_recursiveDraw = false;
  menuState.m_save_demonum = 0;
  menuState.m_main_cursor = 0;
  menuState.options_cursor = 0;
  menuState.keys_cursor = 0;
  menuState.bind_grab = false;
  menuState.help_page = 0;
  menuState.msgNumber = 0;
  menuState.m_quit_prevstate = MStateT.m_none;
  menuState.wasInMenus = false;
}

beforeEach(() => {
  cl.clear();
  cl.qw.clear();
  fake.calls.length = 0;

  scrState.scr_con_current = 0;
  scrState.sb_lines = 0;
  scrState.scr_copyeverything = 0;
  scrState.scr_fullupdate = 0;

  vid.width = 320;
  vid.height = 200;
  vid.numpages = 2;

  cl_sbar.value = 0;
  cl_hudswap.value = 0;
  scr_viewsize.value = 100;

  host.realtime = 0;
  cl.qw.last_ping_request = 0;

  keyState.key_dest = KeydestT.key_game;
  resetMenuState();
});

//=============================================================================

describe("Sbar_SortFrags", () => {
  test("orders fragsort by descending frags and excludes spectators by default", () => {
    cl.qw.players[0].name = "Alice";
    cl.qw.players[0].frags = 5;
    cl.qw.players[1].name = "Bob";
    cl.qw.players[1].frags = 10;
    cl.qw.players[2].name = "Carl";
    cl.qw.players[2].frags = 2;
    cl.qw.players[2].spectator = 1; // excluded when includespec is false

    Sbar_SortFrags(false);

    expect(scoreboardlines).toBe(2);
    expect(fragsort.slice(0, 2)).toEqual([1, 0]); // Bob(10), Alice(5)
  });

  test("includespec=true includes spectators and forces their frags to -999", () => {
    cl.qw.players[0].name = "Alice";
    cl.qw.players[0].frags = 5;
    cl.qw.players[1].name = "Dana";
    cl.qw.players[1].frags = 3;
    cl.qw.players[1].spectator = 1;

    Sbar_SortFrags(true);

    expect(scoreboardlines).toBe(2);
    // Alice(5) still beats the spectator, whose frags got forced to -999.
    expect(fragsort.slice(0, 2)).toEqual([0, 1]);
    expect(cl.qw.players[1].frags).toBe(-999);
  });
});

describe("Sbar_SortTeams", () => {
  test("teamplay off: scoreboardteams stays 0 and no aggregation happens", () => {
    cl.qw.serverinfo = "\\teamplay\\0";
    cl.qw.players[0].name = "Alice";
    cl.qw.players[0].userinfo = "\\team\\red";
    cl.qw.players[0].frags = 5;

    Sbar_SortTeams();

    expect(scoreboardteams).toBe(0);
  });

  test("teamplay on: aggregates frags and player counts per team", () => {
    cl.qw.serverinfo = "\\teamplay\\1";

    cl.qw.players[0].name = "Alice";
    cl.qw.players[0].userinfo = "\\team\\red";
    cl.qw.players[0].frags = 5;
    cl.qw.players[0].ping = 50;

    cl.qw.players[1].name = "Bob";
    cl.qw.players[1].userinfo = "\\team\\red";
    cl.qw.players[1].frags = 7;
    cl.qw.players[1].ping = 100;

    cl.qw.players[2].name = "Carl";
    cl.qw.players[2].userinfo = "\\team\\blue";
    cl.qw.players[2].frags = 2;
    cl.qw.players[2].ping = 20;

    // spectators are never counted onto a team, even with a "team" key set
    cl.qw.players[3].name = "Spec";
    cl.qw.players[3].userinfo = "\\team\\red";
    cl.qw.players[3].spectator = 1;

    Sbar_SortTeams();

    expect(scoreboardteams).toBe(2);
    // red (12 frags) outranks blue (2 frags): teamsort[0] is red's index.
    const redIdx = teamsort[0];
    expect(teams[redIdx].team).toBe("red");
    expect(teams[redIdx].frags).toBe(12);
    expect(teams[redIdx].players).toBe(2);
    expect(teams[redIdx].plow).toBe(50);
    expect(teams[redIdx].phigh).toBe(100);

    const blueIdx = teamsort[1];
    expect(teams[blueIdx].team).toBe("blue");
    expect(teams[blueIdx].frags).toBe(2);
    expect(teams[blueIdx].players).toBe(1);
  });
});

describe("Sbar_ColorForMap", () => {
  test("clamps to [0,13], scales by 16, then adds 8", () => {
    expect(Sbar_ColorForMap(0)).toBe(8); // 0*16+8
    expect(Sbar_ColorForMap(4)).toBe(72); // 4*16+8
    expect(Sbar_ColorForMap(13)).toBe(216); // 13*16+8
    expect(Sbar_ColorForMap(-5)).toBe(8); // clamped to 0
    expect(Sbar_ColorForMap(99)).toBe(216); // clamped to 13
  });
});

describe("Sbar_Draw / Sbar_DrawInventory: cl_sbar and cl_hudswap", () => {
  test("cl_sbar 1: draws the classic status bar and inventory bar", () => {
    cl_sbar.value = 1;
    scrState.sb_lines = 48;
    cl.stats[STAT_HEALTH] = 50;

    Sbar_Draw();

    const pics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Pic" }> => c.fn === "Draw_Pic");
    expect(pics.some((p) => p.picName === "sbar")).toBe(true);
    expect(pics.some((p) => p.picName === "ibar")).toBe(true);
  });

  test("cl_sbar 0 (headsup): the classic inventory bar pic is not drawn", () => {
    cl_sbar.value = 0;
    scr_viewsize.value = 100;
    scrState.sb_lines = 48;
    cl.stats[STAT_HEALTH] = 50;
    vid.width = 640;

    Sbar_Draw();

    const pics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Pic" }> => c.fn === "Draw_Pic");
    expect(pics.some((p) => p.picName === "ibar")).toBe(false);
    expect(pics.some((p) => p.picName === "sbar")).toBe(false);
  });

  test("headsup ammo strips land at the bottom-right: x = vid.width-42, y = vid.height-24 + (-24-(4-i)*11)", () => {
    cl_sbar.value = 0;
    scr_viewsize.value = 100;
    cl_hudswap.value = 0;
    vid.width = 640;
    vid.height = 480;

    fake.calls.length = 0;
    Sbar_DrawInventory();

    const subs = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_SubPic" }> => c.fn === "Draw_SubPic");
    // sbar.c: Sbar_DrawSubPic((hudswap)?0:(vid.width-42), -24-(4-i)*11,
    // sb_ibar, 3+(i*48), 0, 42, 11), and Sbar_DrawSubPic adds
    // (vid.height - SBAR_HEIGHT) to y.
    for (let i = 0; i < 4; i++) {
      const expectedY = -24 - (4 - i) * 11 + (vid.height - 24);
      const hit = subs.find((c) => c.picName === "ibar" && c.srcx === 3 + i * 48);
      expect(hit).toBeDefined();
      expect(hit?.x).toBe(vid.width - 42);
      expect(hit?.y).toBe(expectedY);
      expect(hit?.w).toBe(42);
      expect(hit?.h).toBe(11);
      // all four strips sit in the bottom quarter of the screen, never the top
      expect(expectedY).toBeGreaterThan(vid.height / 2);
    }
  });

  test("cl_hudswap 1 moves the headsup ammo strips to the left edge and leaves y alone", () => {
    cl_sbar.value = 0;
    scr_viewsize.value = 100;
    cl_hudswap.value = 1;
    vid.width = 640;
    vid.height = 480;

    fake.calls.length = 0;
    Sbar_DrawInventory();

    const subs = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_SubPic" }> => c.fn === "Draw_SubPic");
    for (let i = 0; i < 4; i++) {
      const hit = subs.find((c) => c.picName === "ibar" && c.srcx === 3 + i * 48);
      expect(hit).toBeDefined();
      expect(hit?.x).toBe(0);
      expect(hit?.y).toBe(-24 - (4 - i) * 11 + (vid.height - 24));
    }
  });

  test("cl_hudswap moves the headsup ammo-count digits between the left and right edges", () => {
    cl_sbar.value = 0;
    scr_viewsize.value = 100;
    vid.width = 640;
    vid.height = 200;
    cl.stats[6] = 5; // STAT_SHELLS -- a single-digit count so num[2] is the digit

    // Sbar_DrawCharacter(x, y, ...) forwards to Draw_Character(x + 4, y +
    // vid.height - SBAR_HEIGHT, ...) -- the raw (x, y) sbar.ts computes get
    // that +4 / +(vid.height-24) offset before reaching the fake renderer.
    const expectedY = -24 - 4 * 11 + (vid.height - 24);

    cl_hudswap.value = 0;
    fake.calls.length = 0;
    Sbar_DrawInventory();
    let chars = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Character" }> => c.fn === "Draw_Character");
    // (hudswap) ? 19 : (vid.width-23) -- hudswap false -> vid.width-23, +4
    expect(chars.some((c) => c.x === vid.width - 23 + 4 && c.y === expectedY)).toBe(true);

    cl_hudswap.value = 1;
    fake.calls.length = 0;
    Sbar_DrawInventory();
    chars = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Character" }> => c.fn === "Draw_Character");
    // (hudswap) ? 19 : ... -- hudswap true -> fixed 19, +4
    expect(chars.some((c) => c.x === 19 + 4 && c.y === expectedY)).toBe(true);
  });
});

describe("Sbar_DeathmatchOverlay", () => {
  test("draws ping/pl/frags/name rows for two players", () => {
    scr_viewsize.value = 100;
    cl.qw.serverinfo = "\\teamplay\\0";
    cl.qw.last_ping_request = host.realtime; // skip the "pings" stringcmd branch

    cl.qw.players[0].name = "Alice";
    cl.qw.players[0].frags = 5;
    cl.qw.players[0].ping = 42;
    cl.qw.players[0].pl = 1;
    cl.qw.players[0].entertime = 0;

    cl.qw.players[1].name = "Bob";
    cl.qw.players[1].frags = 10;
    cl.qw.players[1].ping = 88;
    cl.qw.players[1].pl = 2;
    cl.qw.players[1].entertime = 0;

    Sbar_DeathmatchOverlay(0);

    const strings = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_String" }> => c.fn === "Draw_String").map((c) => c.str);

    expect(strings).toContain("Alice");
    expect(strings).toContain("Bob");
    expect(strings).toContain("  42"); // ping, Com_sprintf("%4i", 42)
  });

  test("packet loss over 25 goes through Draw_Alt_String, at or under 25 through Draw_String", () => {
    scr_viewsize.value = 100;
    cl.qw.serverinfo = "\\teamplay\\0";
    cl.qw.last_ping_request = host.realtime;

    cl.qw.players[0].name = "Alice";
    cl.qw.players[0].pl = 26; // sbar.c: `if (p > 25) Draw_Alt_String`
    cl.qw.players[0].entertime = 0;

    cl.qw.players[1].name = "Bob";
    cl.qw.players[1].pl = 25;
    cl.qw.players[1].entertime = 0;

    Sbar_DeathmatchOverlay(0);

    const alt = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_Alt_String" }> => c.fn === "Draw_Alt_String").map((c) => c.str);
    const plain = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_String" }> => c.fn === "Draw_String").map((c) => c.str);

    expect(alt).toEqual([" 26"]);
    expect(plain).toContain(" 25");
  });
});

describe("QW menu: M_Keydown navigating m_main", () => {
  test("K_DOWNARROW/K_UPARROW cycle m_main_cursor through all 5 QW entries", () => {
    keyState.key_dest = KeydestT.key_menu;
    menuState.m_state = MStateT.m_main;

    expect(MAIN_ITEMS).toBe(5);

    for (let i = 0; i < MAIN_ITEMS; i++) {
      expect(menuState.m_main_cursor).toBe(i);
      M_Keydown(K_DOWNARROW);
    }
    // wrapped back to 0 after 5 presses
    expect(menuState.m_main_cursor).toBe(0);

    M_Keydown(K_UPARROW);
    expect(menuState.m_main_cursor).toBe(MAIN_ITEMS - 1);
  });

  test("K_ESCAPE from m_main returns to the game", () => {
    setKeyDest(KeydestT.key_menu);
    setMState(MStateT.m_main);
    cls.demonum = -1;

    M_Keydown(K_ESCAPE);

    expect(keyState.key_dest).toBe(KeydestT.key_game);
    expect(menuState.m_state).toBe(MStateT.m_none);
  });
});

describe("QW menu: M_Draw of m_quit", () => {
  test("draws the credits text box without throwing", () => {
    setKeyDest(KeydestT.key_menu);
    setMState(MStateT.m_quit);
    menuState.wasInMenus = false;

    expect(() => M_Draw()).not.toThrow();

    // M_DrawTextBox(0,0,38,23) draws box_tl.lmp at the origin as its first call
    const transPics = fake.calls.filter((c): c is Extract<DrawCall, { fn: "Draw_TransPic" }> => c.fn === "Draw_TransPic");
    expect(transPics.some((p) => p.picName === "gfx/box_tl.lmp")).toBe(true);

    // credits body text is drawn via M_Print/M_PrintWhite -> Draw_Character
    const chars = fake.calls.filter((c) => c.fn === "Draw_Character");
    expect(chars.length).toBeGreaterThan(0);
  });
});

describe("QW menu: M_ToggleMenu_f key_dest transitions", () => {
  test("from key_game, opens the main menu", () => {
    setKeyDest(KeydestT.key_game);
    setMState(MStateT.m_none);

    M_ToggleMenu_f();

    expect(keyState.key_dest).toBe(KeydestT.key_menu);
    expect(menuState.m_state).toBe(MStateT.m_main);
  });

  test("from key_menu at m_main, closes the menu back to the game", () => {
    setKeyDest(KeydestT.key_menu);
    setMState(MStateT.m_main);

    M_ToggleMenu_f();

    expect(keyState.key_dest).toBe(KeydestT.key_game);
    expect(menuState.m_state).toBe(MStateT.m_none);
  });

  test("from key_menu at a non-main state, jumps back to the main menu", () => {
    setKeyDest(KeydestT.key_menu);
    setMState(MStateT.m_options);

    M_ToggleMenu_f();

    expect(keyState.key_dest).toBe(KeydestT.key_menu);
    expect(menuState.m_state).toBe(MStateT.m_main);
  });
});
