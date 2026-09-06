// Self-sufficient tests for src/client/console.ts (WinQuake console.c/console.h,
// unit U047, replacing the coordinator's Con_Printf/Con_DPrintf/Con_SafePrintf
// placeholder).
//
// console.ts is imported by nearly every other module in this tree, so it
// resolves its own cyclic dependencies (host.ts, keys.ts) with plain static
// imports (both sides only touch the cycle inside function bodies -- see
// console.ts's own file header) and its two not-yet-landed siblings
// (menu.ts, snd_dma.ts) with a lazy `require()`, deferred to the exact call
// site. This suite never exercises Con_ToggleConsole_f's disconnected branch
// or Con_Print's txt[0]==1 colored-talk branch, so it never touches either
// lazy require and needs no `mock.module` stand-in.
//
// `con_text` is a live ES binding (`export let`) on console.ts, read here
// through `requireConText()` after Con_Init has allocated it; conState's
// nine fields are freely overwritten between tests for small, hand-traced
// scenarios (con_text's own CON_TEXTSIZE=16384 backing buffer easily holds
// every scratch con_linewidth/con_totallines combination used below).
//
// No console/stdout mock is used to independently reverify that Con_Printf
// calls Sys_Printf, matching this project's established convention
// (test/cmd.test.ts's own file header: "no console mock to intercept
// Con_Printf's output").

import { describe, test, expect, beforeEach } from "bun:test";
import {
  Con_Init,
  Con_Print,
  Con_CheckResize,
  Con_ClearNotify,
  Con_Printf,
  Con_DrawConsole,
  Con_DrawNotify,
  conState,
  con_text,
  CON_TEXTSIZE,
} from "../src/client/console";
import { vid } from "../src/client/vid";
import { sysState } from "../src/platform/sys";
import { host } from "../src/common/host";
import { re, type Renderer } from "../src/client/render";
import { TextureT } from "../src/common/model";
import { keyState, KeydestT } from "../src/client/keys";
import { COM_InitArgv, setComGamedir } from "../src/common/common";

function requireConText(): Uint8Array {
  if (con_text === null) throw new Error("con_text not allocated -- Con_Init must run first");
  return con_text;
}

interface DrawCharacterCall {
  x: number;
  y: number;
  num: number;
}

// Every method beyond Draw_Character is a plain no-op: TypeScript accepts a
// function with fewer parameters than the interface member it satisfies, so
// the fakes below omit unused parameters entirely.
function makeFakeRenderer(): { renderer: Renderer; draws: DrawCharacterCall[] } {
  const draws: DrawCharacterCall[] = [];
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
  };
  return { renderer, draws };
}

beforeEach(() => {
  // no "-condebug", so Con_Init's con_debuglog stays deterministically false
  COM_InitArgv(["quake"]);
  sysState.isDedicated = false;
  keyState.key_dest = KeydestT.key_game;
  re.current = null;
});

// ============================================================================

describe("Con_Init / Con_CheckResize", () => {
  test("Con_Init with vid.width 320 sets con_linewidth to 38", () => {
    vid.width = 320;
    Con_Init();
    expect(conState.con_linewidth).toBe(38);
    expect(conState.con_initialized).toBe(true);
  });

  test("Con_CheckResize reflow at 640 keeps a known line", () => {
    vid.width = 320;
    Con_Init();
    expect(conState.con_linewidth).toBe(38);

    Con_Print("HI\n");
    const text = requireConText();

    vid.width = 640;
    Con_CheckResize();
    expect(conState.con_linewidth).toBe(78); // (640>>3)-2

    // the reflow's i=0 case lands the most-recently-written line at the new
    // buffer's last row, which is exactly where con_current now points.
    const rowOffset = conState.con_current * conState.con_linewidth;
    expect(text[rowOffset]).toBe("H".charCodeAt(0));
    expect(text[rowOffset + 1]).toBe("I".charCodeAt(0));
    expect(text[rowOffset + 2]).toBe(0x20); // padded with spaces by Con_Linefeed's fill
  });
});

describe("Con_Print", () => {
  test("byte placement with no word wrap", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 10;
    conState.con_totallines = 3;
    conState.con_current = 2;
    conState.con_x = 0;
    conState.con_backscroll = 0;
    const text = requireConText();
    text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("hi\n");

    expect(conState.con_current).toBe(3); // one Con_Linefeed, from the initial con_x===0
    expect(conState.con_x).toBe(0); // '\n' resets con_x

    const rowOffset = (conState.con_current % conState.con_totallines) * conState.con_linewidth;
    expect(text[rowOffset]).toBe("h".charCodeAt(0));
    expect(text[rowOffset + 1]).toBe("i".charCodeAt(0));
    expect(text[rowOffset + 2]).toBe(0x20); // Con_Linefeed's blank fill, untouched by "hi"
  });

  test("word wrap forces a new line before a word that would overflow", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 5;
    conState.con_totallines = 3;
    conState.con_current = 2;
    conState.con_x = 4; // pretend 4 columns are already used on the current line
    conState.con_backscroll = 0;
    const text = requireConText();
    text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("cd"); // length 2, con_x(4)+2=6 > con_linewidth(5) -> wraps

    expect(conState.con_current).toBe(3); // the wrap's Con_Linefeed advanced the line
    expect(conState.con_x).toBe(2);

    const rowOffset = (conState.con_current % conState.con_totallines) * conState.con_linewidth;
    expect(text[rowOffset]).toBe("c".charCodeAt(0));
    expect(text[rowOffset + 1]).toBe("d".charCodeAt(0));
    expect(text[rowOffset + 2]).toBe(0x20);
  });

  test("colored prefix (txt[0] == 2) ORs 128 into every following byte", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 5;
    conState.con_totallines = 3;
    conState.con_current = 2;
    conState.con_x = 0;
    conState.con_backscroll = 0;
    const text = requireConText();
    text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("\x02AB");

    const rowOffset = (conState.con_current % conState.con_totallines) * conState.con_linewidth;
    expect(text[rowOffset]).toBe(("A".charCodeAt(0) | 128) & 0xff);
    expect(text[rowOffset + 1]).toBe(("B".charCodeAt(0) | 128) & 0xff);
  });

  test("'\\r' reuses the current line on the next Con_Print call", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 5;
    conState.con_totallines = 3;
    conState.con_current = 2;
    conState.con_x = 0;
    conState.con_backscroll = 0;
    const text = requireConText();
    text.fill(0x20, 0, CON_TEXTSIZE);

    Con_Print("ab\r");
    const afterCr = conState.con_current;
    const rowOffsetBefore = (afterCr % conState.con_totallines) * conState.con_linewidth;
    expect(text[rowOffsetBefore]).toBe("a".charCodeAt(0));
    expect(text[rowOffsetBefore + 1]).toBe("b".charCodeAt(0));

    Con_Print("XY");

    // the '\r' from the previous call reuses this line: con_current lands
    // back on the exact same row instead of advancing to a new one.
    expect(conState.con_current).toBe(afterCr);
    const rowOffsetAfter = (conState.con_current % conState.con_totallines) * conState.con_linewidth;
    expect(rowOffsetAfter).toBe(rowOffsetBefore);
    expect(text[rowOffsetAfter]).toBe("X".charCodeAt(0));
    expect(text[rowOffsetAfter + 1]).toBe("Y".charCodeAt(0));
  });
});

describe("Con_ClearNotify", () => {
  test("blanks the notify timestamps so Con_DrawNotify draws nothing", () => {
    vid.width = 320;
    Con_Init();

    host.realtime = 5;
    Con_Print("NOTIFY\n"); // marks a con_times[] entry via Con_Linefeed

    const { renderer, draws } = makeFakeRenderer();
    re.current = renderer;

    Con_ClearNotify();
    Con_DrawNotify();

    expect(draws.length).toBe(0);
  });
});

describe("Con_Printf", () => {
  test("in dedicated mode, echoes (via Sys_Printf) but leaves con_text unchanged", () => {
    vid.width = 320;
    Con_Init();
    const text = requireConText();
    const before = Array.from(text);

    sysState.isDedicated = true;
    expect(() => Con_Printf("should not touch the scrollback buffer\n")).not.toThrow();
    expect(Array.from(text)).toEqual(before);
  });
});

describe("Con_DrawConsole", () => {
  test("with a fake Renderer, records Draw_Character at the right x,y", () => {
    vid.width = 320;
    Con_Init();
    conState.con_linewidth = 5;
    conState.con_totallines = 3;
    conState.con_current = 2;
    conState.con_backscroll = 0;
    const text = requireConText();
    text.fill(0x20, 0, CON_TEXTSIZE);
    text[2 * 5 + 0] = "Q".charCodeAt(0);
    text[2 * 5 + 1] = "1".charCodeAt(0);

    const { renderer, draws } = makeFakeRenderer();
    re.current = renderer;

    // lines=40 -> rows=(40-16)>>3=3, y starts at 40-16-(3<<3)=0, so the three
    // drawn rows land at y=0,8,16 -- con_current(2) is the last of them (y=16).
    Con_DrawConsole(40, false);

    const lastRow = draws.filter((d) => d.y === 16);
    expect(lastRow.length).toBe(5);
    expect(lastRow[0]).toEqual({ x: 8, y: 16, num: "Q".charCodeAt(0) });
    expect(lastRow[1]).toEqual({ x: 16, y: 16, num: "1".charCodeAt(0) });
    expect(lastRow[2]).toEqual({ x: 24, y: 16, num: 0x20 });
  });
});

// F.md D2: `-condebug` with a `-game` directory that doesn't exist yet
// crashed with an uncaught ENOENT from the qconsole.log append. WinQuake's
// Con_DebugLog (open/write/close, all unchecked) tolerates a failed open as
// a silent no-op; this reproduces that by pointing com_gamedir at a
// directory that was never created and confirming Con_Printf (which routes
// through Con_DebugLog whenever con_debuglog is set) doesn't throw.
describe("Con_DebugLog (D2: -condebug with a not-yet-existing -game directory)", () => {
  test("a failed qconsole.log open under -condebug is a silent no-op, not a crash", () => {
    vid.width = 320;
    COM_InitArgv(["quake", "-condebug"]);
    setComGamedir("/nonexistent-dir-for-d2-console-test/does-not-exist");

    Con_Init();
    expect(() => Con_Printf("this must not crash the engine\n")).not.toThrow();
  });
});
