// Self-sufficient tests for src/qw/client/console.ts (QW/client/console.c,
// this unit's own port -- see that file's header for the full deviation
// list against src/client/console.ts, the WinQuake module it is modeled on).
//
// console.ts (this module) lazy-requires its cyclic/heavier siblings
// (src/client/client.ts, ./cl_main.ts, src/client/keys.ts, ./screen.ts,
// src/client/render.ts) inside function bodies, per its own file header, so
// this suite imports them directly at top level the same way
// test/qwcl_screen.test.ts already does -- none of them import THIS module
// (the coordinator has not switched their Con_* import paths over yet, per
// this unit's report), so there is no cycle to route around here.
//
// cls.state defaults to ca_active in beforeEach so that Con_Init's own
// "Console initialized.\n" Con_Printf call (and any other incidental
// Con_Printf during setup) never falls into the `cls.state !== ca_active`
// branch and tries to call the real SCR_UpdateScreen -- this suite only
// wants to exercise console.ts itself, not the qw screen.ts render path.
// Tests that specifically exercise the ca_active/not-active transition
// (Con_ToggleConsole_f / Con_ToggleChat_f) set cls.state explicitly.
//
// Shared singletons this suite touches and resets itself (rule 15): cls
// (state, qw.download/downloadname/downloadpercent), keyState (key_dest,
// team_message, chat_buffer), re.current, conState (every field, including
// con_ormask), con_main.text/con_chat.text, con_notifytime.value (set
// directly rather than relying on Cvar_RegisterVariable's registration,
// which races against src/client/console.ts's own same-named
// "con_notifytime" cvar when both suites run in the same bun test process
// -- whichever module's Con_Init registers first wins the name in cvar.ts's
// shared `cvar_vars` chain, so the loser's own CvarT object never gets its
// `.value` set by registration).

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  Con_Init,
  Con_CheckResize,
  Con_Print,
  Con_Printf,
  Con_ClearNotify,
  Con_ToggleConsole_f,
  Con_ToggleChat_f,
  Con_Clear_f,
  Con_DrawNotify,
  Con_DrawConsole,
  conState,
  con_main,
  con_chat,
  con_notifytime,
  CON_TEXTSIZE,
} from "../src/qw/client/console";
import { vid } from "../src/client/vid";
import { cls, CactiveT } from "../src/client/client";
import { keyState, KeydestT } from "../src/client/keys";
import { re, type Renderer } from "../src/client/render";
import { TextureT } from "../src/common/model";
import { FileHandle, COM_InitArgv, setComGamedir } from "../src/common/common";
import { clMainState } from "../src/qw/client/cl_main";

// This file's own beforeEach (below) parks cls.state at ca_active for every
// test, but every other field it touches there is reset back to its own
// pristine default each time (cls.qw.download/downloadname/downloadpercent,
// keyState.*, re.current, conState.con_ormask) -- cls.state is the one
// exception, and nothing ever puts it back to ca_dedicated afterward, so the
// last test to run here leaks ca_active into the rest of this bun process
// (rule 15). Snapshot captured before any beforeEach/test runs, restored in
// a top-level afterAll.
const savedClsState = cls.state;

afterAll(() => {
  cls.state = savedClsState;
});

interface DrawCharacterCall {
  x: number;
  y: number;
  num: number;
}
interface DrawStringCall {
  x: number;
  y: number;
  str: string;
}

// Widens the assigned type through a `KeydestT`-typed parameter: writing the
// enum member literal straight into keyState.key_dest lets tsc narrow the
// property to that literal for the rest of the enclosing block (even across
// an intervening function call), which then makes a later
// `expect(keyState.key_dest).toBe(KeydestT.key_console)` a type error --
// same fix test/menu.test.ts's own file header documents for the same tsc
// behavior on keyState.key_dest / menuState.m_state.
function setKeyDest(v: KeydestT): void {
  keyState.key_dest = v;
}

// Same recipe as test/console.test.ts / test/qwcl_screen.test.ts: a fake
// Renderer that only records Draw_Character/Draw_String, everything else a
// plain no-op satisfying the current src/client/render.ts Renderer shape.
function makeFakeRenderer(): { renderer: Renderer; draws: DrawCharacterCall[]; strings: DrawStringCall[] } {
  const draws: DrawCharacterCall[] = [];
  const strings: DrawStringCall[] = [];
  const renderer: Renderer = {
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
    Draw_Character: (x: number, y: number, num: number) => {
      draws.push({ x, y, num });
    },
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
    Draw_String: (x: number, y: number, str: string) => {
      strings.push({ x, y, str });
    },
    Draw_PicFromWad: () => null,
    Draw_CachePic: () => null,
    Draw_SubPic: () => {},
    Draw_Alt_String: () => {},
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
    isGL: false,
    SCR_ScreenShot_f: () => {},
  };
  return { renderer, draws, strings };
}

beforeEach(() => {
  // no "-condebug", so Con_Init's con_debuglog stays deterministically false
  COM_InitArgv(["quake"]);

  // ca_active so Con_Init's own "Console initialized.\n" Con_Printf (and any
  // other incidental Con_Printf during setup) skips the SCR_UpdateScreen
  // branch entirely -- see file header.
  cls.state = CactiveT.ca_active;
  cls.qw.download = null;
  cls.qw.downloadname = "";
  cls.qw.downloadpercent = 0;

  keyState.key_dest = KeydestT.key_game;
  keyState.team_message = false;
  keyState.chat_buffer = "";

  re.current = null;

  conState.con_ormask = 0;
});

// ============================================================================

describe("Con_Init / Con_CheckResize", () => {
  test("vid.width 320 sets con_linewidth to 38 for both consoles (video-uninitialized branch)", () => {
    // width=0 takes Con_Resize's `width < 1` branch every call (see
    // console.ts's own header: that branch recomputes the same raw width
    // each time regardless of the already-updated global con_linewidth), so
    // both con_main and con_chat get resized here.
    vid.width = 0;
    Con_Init();

    expect(conState.con_linewidth).toBe(38);
    expect(conState.con_initialized).toBe(true);
    expect(conState.con).toBe(con_main); // Con_Init always points `con` at con_main

    expect(con_main.current).toBe(conState.con_totallines - 1);
    expect(con_main.display).toBe(con_main.current);
    expect(con_chat.current).toBe(conState.con_totallines - 1);
    expect(con_chat.display).toBe(con_chat.current);
  });

  test("resizing to a real vid.width (640) reflows con_main but leaves con_chat's current/display stale", () => {
    // Establish both consoles at the video-uninitialized width first.
    vid.width = 0;
    Con_Init();
    const chatCurrentBefore = con_chat.current;
    const chatDisplayBefore = con_chat.display;

    Con_Print("HI\n"); // writes into con_main, the console `con` points at

    vid.width = 640;
    Con_CheckResize();

    expect(conState.con_linewidth).toBe(78); // (640>>3)-2

    // con_main: Con_Resize's first call sees width(78) != con_linewidth(38),
    // so it reflows and updates current/display.
    expect(con_main.current).toBe(conState.con_totallines - 1);
    const rowOffset = con_main.current * conState.con_linewidth;
    expect(con_main.text[rowOffset]).toBe("H".charCodeAt(0));
    expect(con_main.text[rowOffset + 1]).toBe("I".charCodeAt(0));

    // con_chat: Con_Resize's second call recomputes the same width(78),
    // which now equals the global con_linewidth con_main's call just set,
    // so it early-returns without touching con_chat.current/display at all
    // -- the quirk documented in console.ts's own file header, reproduced
    // here rather than assumed.
    expect(con_chat.current).toBe(chatCurrentBefore);
    expect(con_chat.display).toBe(chatDisplayBefore);
  });
});

describe("Con_Print", () => {
  test("byte placement with no word wrap", () => {
    vid.width = 0;
    Con_Init();
    conState.con_linewidth = 10;
    conState.con_totallines = 3;
    conState.con.current = 2;
    conState.con.x = 0;
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("hi\n");

    expect(conState.con.current).toBe(3); // one Con_Linefeed, from the initial x===0
    expect(conState.con.x).toBe(0); // '\n' resets x

    const rowOffset = (conState.con.current % conState.con_totallines) * conState.con_linewidth;
    expect(conState.con.text[rowOffset]).toBe("h".charCodeAt(0));
    expect(conState.con.text[rowOffset + 1]).toBe("i".charCodeAt(0));
    expect(conState.con.text[rowOffset + 2]).toBe(0x20); // Con_Linefeed's blank fill
  });

  test("word wrap forces a new line before a word that would overflow", () => {
    vid.width = 0;
    Con_Init();
    conState.con_linewidth = 5;
    conState.con_totallines = 3;
    conState.con.current = 2;
    conState.con.x = 4; // pretend 4 columns are already used on the current line
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("cd"); // length 2, x(4)+2=6 > con_linewidth(5) -> wraps

    expect(conState.con.current).toBe(3); // the wrap's Con_Linefeed advanced the line
    expect(conState.con.x).toBe(2);

    const rowOffset = (conState.con.current % conState.con_totallines) * conState.con_linewidth;
    expect(conState.con.text[rowOffset]).toBe("c".charCodeAt(0));
    expect(conState.con.text[rowOffset + 1]).toBe("d".charCodeAt(0));
  });

  test("'\\r' reuses the current line on the next Con_Print call", () => {
    vid.width = 0;
    Con_Init();
    conState.con_linewidth = 5;
    conState.con_totallines = 3;
    conState.con.current = 2;
    conState.con.x = 0;
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("ab\r");
    const afterCr = conState.con.current;
    const rowOffsetBefore = (afterCr % conState.con_totallines) * conState.con_linewidth;
    expect(conState.con.text[rowOffsetBefore]).toBe("a".charCodeAt(0));
    expect(conState.con.text[rowOffsetBefore + 1]).toBe("b".charCodeAt(0));

    Con_Print("XY");

    expect(conState.con.current).toBe(afterCr); // '\r' reused this line, no new Con_Linefeed
    const rowOffsetAfter = (conState.con.current % conState.con_totallines) * conState.con_linewidth;
    expect(rowOffsetAfter).toBe(rowOffsetBefore);
    expect(conState.con.text[rowOffsetAfter]).toBe("X".charCodeAt(0));
    expect(conState.con.text[rowOffsetAfter + 1]).toBe("Y".charCodeAt(0));
  });

  test("conState.con_ormask ORs into every printed byte (cl_parse's PRINT_CHAT hook point)", () => {
    vid.width = 0;
    Con_Init();
    conState.con_linewidth = 10;
    conState.con_totallines = 3;
    conState.con.current = 2;
    conState.con.x = 0;
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);

    conState.con_ormask = 128; // what cl_parse.ts's svc_print PRINT_CHAT case sets around a chat line

    Con_Print("AB");

    const rowOffset = (conState.con.current % conState.con_totallines) * conState.con_linewidth;
    expect(conState.con.text[rowOffset]).toBe(("A".charCodeAt(0) | 128) & 0xff);
    expect(conState.con.text[rowOffset + 1]).toBe(("B".charCodeAt(0) | 128) & 0xff);
    expect(conState.con.text[rowOffset] & 0x80).toBe(0x80); // high bit set
    expect(conState.con.text[rowOffset + 1] & 0x80).toBe(0x80);
  });
});

describe("Con_ToggleConsole_f / Con_ToggleChat_f", () => {
  test("Con_ToggleConsole_f: key_game -> key_console, then key_console -> key_game once ca_active", () => {
    vid.width = 0;
    Con_Init();

    setKeyDest(KeydestT.key_game);
    Con_ToggleConsole_f();
    expect(keyState.key_dest).toBe(KeydestT.key_console);

    cls.state = CactiveT.ca_active;
    Con_ToggleConsole_f();
    expect(keyState.key_dest).toBe(KeydestT.key_game);
  });

  test("Con_ToggleChat_f behaves IDENTICALLY to Con_ToggleConsole_f and never swaps conState.con", () => {
    // QW/client/console.c's own Con_ToggleChat_f is byte-for-byte the same
    // body as Con_ToggleConsole_f (verified directly against the source: `con`
    // is assigned exactly once in the whole QW/client tree, in Con_Init, and
    // never reassigned anywhere else). This suite exercises the actual
    // behavior rather than the swap this unit's brief assumed.
    vid.width = 0;
    Con_Init();
    const conBefore = conState.con;

    setKeyDest(KeydestT.key_game);
    Con_ToggleChat_f();
    expect(keyState.key_dest).toBe(KeydestT.key_console);
    expect(conState.con).toBe(conBefore); // unchanged -- still con_main

    cls.state = CactiveT.ca_active;
    Con_ToggleChat_f();
    expect(keyState.key_dest).toBe(KeydestT.key_game);
    expect(conState.con).toBe(conBefore); // still unchanged
    expect(conState.con).toBe(con_main);
  });
});

describe("Con_Clear_f", () => {
  test("clears both con_main and con_chat text buffers", () => {
    vid.width = 0;
    Con_Init();
    con_main.text.fill("X".charCodeAt(0), 0, CON_TEXTSIZE);
    con_chat.text.fill("Y".charCodeAt(0), 0, CON_TEXTSIZE);

    Con_Clear_f();

    expect(con_main.text.every((b) => b === 0x20)).toBe(true);
    expect(con_chat.text.every((b) => b === 0x20)).toBe(true);
  });
});

describe("Con_ClearNotify / notify timing", () => {
  test("a recent line is drawn within con_notifytime, then skipped once cleared", () => {
    vid.width = 0;
    Con_Init();
    conState.con_linewidth = 8;
    conState.con_totallines = 4;
    conState.con.current = 0;
    conState.con.x = 0;
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);
    con_notifytime.value = 3; // set directly -- see file header on the cvar-registration race

    clMainState.realtime = 5;
    Con_Print("hi\n"); // Con_Linefeed marks con_times[] at realtime=5

    const { renderer, draws } = makeFakeRenderer();
    re.current = renderer;

    clMainState.realtime = 5; // no time elapsed yet -- within con_notifytime.value
    Con_DrawNotify();
    expect(draws.length).toBeGreaterThan(0);

    draws.length = 0;
    Con_ClearNotify();
    Con_DrawNotify();
    expect(draws.length).toBe(0);
  });

  test("a stale line (older than con_notifytime) is skipped even without ClearNotify", () => {
    vid.width = 0;
    Con_Init();
    conState.con_linewidth = 8;
    conState.con_totallines = 4;
    conState.con.current = 0;
    conState.con.x = 0;
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);
    con_notifytime.value = 3;

    clMainState.realtime = 5;
    Con_Print("hi\n");

    const { renderer, draws } = makeFakeRenderer();
    re.current = renderer;

    clMainState.realtime = 500; // far past con_notifytime.value seconds later
    Con_DrawNotify();
    expect(draws.length).toBe(0);
  });
});

describe("Con_DrawNotify chat prompt", () => {
  function setupNoTextLines(): void {
    // an empty con_times[] (freshly cleared) means the text-lines loop draws
    // nothing, isolating the chat-prompt assertions below to just the
    // key_message branch.
    conState.con_linewidth = 40;
    conState.con_totallines = 4;
    conState.con.current = 0;
    Con_ClearNotify();
  }

  test("chat_team false draws the \"say:\" prompt with skip=5", () => {
    vid.width = 320;
    Con_Init();
    setupNoTextLines();

    keyState.key_dest = KeydestT.key_message;
    keyState.team_message = false;
    keyState.chat_buffer = "hi";

    const { renderer, draws, strings } = makeFakeRenderer();
    re.current = renderer;

    Con_DrawNotify();

    expect(strings).toEqual([{ x: 8, y: 0, str: "say:" }]);
    // skip=5: chat chars start at x=(0+5)<<3=40, (1+5)<<3=48, ...
    const chatDraws = draws.filter((d) => d.y === 0);
    expect(chatDraws[0]).toEqual({ x: 40, y: 0, num: "h".charCodeAt(0) });
    expect(chatDraws[1]).toEqual({ x: 48, y: 0, num: "i".charCodeAt(0) });
    expect(chatDraws.length).toBe(3); // "h", "i", the trailing cursor glyph
  });

  test("chat_team true draws the \"say_team:\" prompt with skip=11", () => {
    vid.width = 320;
    Con_Init();
    setupNoTextLines();

    keyState.key_dest = KeydestT.key_message;
    keyState.team_message = true;
    keyState.chat_buffer = "hi";

    const { renderer, draws, strings } = makeFakeRenderer();
    re.current = renderer;

    Con_DrawNotify();

    expect(strings).toEqual([{ x: 8, y: 0, str: "say_team:" }]);
    // skip=11: chat chars start at x=(0+11)<<3=88, (1+11)<<3=96, ...
    const chatDraws = draws.filter((d) => d.y === 0);
    expect(chatDraws[0]).toEqual({ x: 88, y: 0, num: "h".charCodeAt(0) });
    expect(chatDraws[1]).toEqual({ x: 96, y: 0, num: "i".charCodeAt(0) });
    expect(chatDraws.length).toBe(3);
  });

  test("key_dest other than key_message draws no chat prompt", () => {
    vid.width = 320;
    Con_Init();
    setupNoTextLines();

    keyState.key_dest = KeydestT.key_game;
    keyState.chat_buffer = "hi";

    const { renderer, draws, strings } = makeFakeRenderer();
    re.current = renderer;

    Con_DrawNotify();

    expect(strings.length).toBe(0);
    expect(draws.length).toBe(0);
  });
});

describe("Con_DrawConsole download bar", () => {
  test("cls.qw.download set draws the progress bar line", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 40;
    conState.con_totallines = 100;
    conState.con.current = 0;
    conState.con.display = 0;
    conState.con.text.fill(0x20, 0, CON_TEXTSIZE);

    cls.qw.download = new FileHandle(-1, 0);
    cls.qw.downloadname = "gfx/foo.pak";
    cls.qw.downloadpercent = 50;

    const { renderer, draws } = makeFakeRenderer();
    re.current = renderer;

    // lines=100 -> barY = con_vislines-22+8 = 100-22+8 = 86, distinct from
    // the main text row (y = lines-30 = 70) so the two never collide.
    Con_DrawConsole(100);

    const barDraws = draws.filter((d) => d.y === 86);
    // strrchr('/') strips "gfx/" -> "foo.pak" (7 chars) + ": " (2) + 0x80 (1)
    // + barWidth(18) dot chars + 0x82 (1) + " 50%" (4) = 33 total.
    expect(barDraws.length).toBe(33);
    expect(barDraws[0].num).toBe("f".charCodeAt(0));
    expect(barDraws[1].num).toBe("o".charCodeAt(0));
    expect(barDraws[7].num).toBe(":".charCodeAt(0));
    expect(barDraws[8].num).toBe(" ".charCodeAt(0));
    expect(barDraws[9].num).toBe(0x80); // bar left cap
    expect(barDraws[28].num).toBe(0x82); // bar right cap
    // dot position: n = trunc(barWidth(18) * percent(50) / 100) = 9
    expect(barDraws[10 + 9].num).toBe(0x83); // the progress dot
    expect(barDraws[10].num).toBe(0x81); // a plain bar segment before the dot
    expect(barDraws[29].num).toBe(" ".charCodeAt(0));
    expect(barDraws[30].num).toBe("5".charCodeAt(0));
    expect(barDraws[31].num).toBe("0".charCodeAt(0));
    expect(barDraws[32].num).toBe("%".charCodeAt(0));
  });

  test("cls.qw.download null draws no bar line", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 40;
    conState.con_totallines = 100;
    conState.con.current = 0;
    conState.con.display = 0;

    cls.qw.download = null;

    const { renderer, draws } = makeFakeRenderer();
    re.current = renderer;

    Con_DrawConsole(100);

    expect(draws.some((d) => d.y === 86)).toBe(false);
  });
});

// F.md D2: same root cause as src/client/console.ts's own Con_DebugLog (see
// test/console.test.ts) -- a failed qconsole.log open under -condebug (a
// -game gamedir that doesn't exist yet) must be a silent no-op, not an
// uncaught crash. This module routes through the same Sys_DebugLog
// (src/platform/sys.ts), which is where the fix lives; this test exercises
// this file's own Con_Printf call site.
describe("Con_DebugLog (D2: -condebug with a not-yet-existing -game directory)", () => {
  test("a failed qconsole.log open under -condebug is a silent no-op, not a crash", () => {
    vid.width = 320;
    COM_InitArgv(["quake", "-condebug"]);
    setComGamedir("/nonexistent-dir-for-d2-qwcl-console-test/does-not-exist");

    Con_Init();
    expect(() => Con_Printf("this must not crash the engine\n")).not.toThrow();
  });
});
