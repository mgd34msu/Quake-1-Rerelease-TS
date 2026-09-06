// Self-sufficient test for src/client/menu.ts (WinQuake menu.c), unit U049.
//
// menu.ts statically imports src/common/cvar.ts (Cvar_Set/SetValue/
// VariableValue/VariableString, by name, per this unit's ruling), src/common/
// host.ts (host.realtime/host.time, hostClientHooks), src/client/screen.ts
// (SCR_ModalMessage, SCR_BeginLoadingPlaque), src/client/console.ts
// (Con_ToggleConsole_f) and src/client/snd_dma.ts (S_LocalSound,
// S_ExtraUpdate). All are real, landed modules and are imported and driven
// for real here: neither Con_ToggleConsole_f nor S_LocalSound/S_ExtraUpdate
// need any setup this suite doesn't already have to be safe to call
// (S_LocalSound/S_ExtraUpdate are no-ops unless `sound_started` is true,
// which this suite never sets), and no test in this file asserts on their
// call args, so no spy is needed for either. keys.ts is real and unmocked
// throughout, per this unit's brief.
//
// Per the brief: the quit menu's 'y'/'Y' key (M_Quit_Key -> Host_Quit_f ->
// eventually Sys_Quit, which really exits the process) is never exercised
// here.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelLoaderHooks } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import type { Renderer } from "../src/client/render";
import { Cvar_RegisterVariable, Cvar_Set, Cvar_VariableValue, Cvar_VariableString } from "../src/common/cvar";
import { v_gamma } from "../src/client/view";
import { COM_AddGameDirectory, registered, rogue } from "../src/common/common";
import { Cbuf_Init, Cbuf_Execute } from "../src/common/cmd";
import { host } from "../src/common/host";
import "../src/common/host_cmd";
import { hostCacheCount, hostcache } from "../src/common/net_main";
import { svs, sv } from "../src/server/server";
import { cls, cl, CactiveT } from "../src/client/client";
import { KeydestT, keyState, keybindings, Key_Init, Key_SetBinding, K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, K_BACKSPACE, K_DEL } from "../src/client/keys";
import { re } from "../src/client/render";
import { vid } from "../src/client/vid";
import "../src/client/screen_types";
import "../src/client/screen";
import "../src/client/cl_main";
import * as menu from "../src/client/menu";

// cmd_text (cmd.ts's command buffer) is unallocated until Cbuf_Init runs;
// without this, Cbuf_AddText/Cbuf_InsertText immediately "overflow" (maxsize
// is 0). Host_Init calls this in the real engine; this test does it directly.
Cbuf_Init();

// resetMenuState() (below) parks cls.state at ca_disconnected as this file's
// own beforeEach baseline, not the pristine ca_dedicated default, and this
// file has no afterAll to put it back -- the last test to run here leaks
// ca_disconnected into the rest of this bun process (rule 15). Snapshot
// captured before resetMenuState ever runs, restored below.
const savedClsState = cls.state;

afterAll(() => {
  cls.state = savedClsState;
});

//=============================================================================
// A minimal recording Renderer (only Draw_* -- menu.c never touches the
// render.h/view.c/screen.c seam methods).

function makePic(width: number, height: number): QpicT {
  return { width, height, data: new Uint8Array(0) };
}

const cachePicCalls: string[] = [];
const drawCalls: Array<{ fn: string; args: unknown[] }> = [];

const modelHooks: ModelLoaderHooks = {
  notexture: { name: "", width: 0, height: 0, gl_texturenum: 0, texturechain: null, anim_total: 0, anim_min: 0, anim_max: 0, anim_next: null, alternate_anims: null, offsets: new Uint32Array(4), data: new Uint8Array(0) },
  textureLoaded(): void {},
  Mod_LoadLighting(): void {},
  Mod_LoadAliasModel(): void {},
  Mod_LoadSpriteModel(): void {},
};

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
  Draw_Character(x: number, y: number, num: number): void {
    drawCalls.push({ fn: "Draw_Character", args: [x, y, num] });
  },
  Draw_DebugChar(): void {},
  Draw_Pic(x: number, y: number, pic: QpicT): void {
    drawCalls.push({ fn: "Draw_Pic", args: [x, y, pic] });
  },
  Draw_TransPic(x: number, y: number, pic: QpicT): void {
    drawCalls.push({ fn: "Draw_TransPic", args: [x, y, pic] });
  },
  Draw_TransPicTranslate(x: number, y: number, pic: QpicT, translation: Uint8Array): void {
    drawCalls.push({ fn: "Draw_TransPicTranslate", args: [x, y, pic, translation] });
  },
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
  Draw_CachePic(path: string): QpicT | null {
    cachePicCalls.push(path);
    return makePic(32, 32);
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

// Widens the assigned type through a `KeydestT`-typed parameter: writing the
// enum member literal straight into keyState.key_dest lets tsc narrow the
// property to that literal for the rest of the enclosing block (even across
// an intervening function call), which then makes a later
// `expect(keyState.key_dest).toBe(KeydestT.key_menu)` a type error (the same
// narrowing tsc applies to menu.ts's own menuState.m_state, worked around in
// menu.ts's M_Draw the same way: not comparable once narrowed away).
function setKeyDest(v: KeydestT): void {
  keyState.key_dest = v;
}

function resetMenuState(): void {
  cachePicCalls.length = 0;
  drawCalls.length = 0;

  re.current = fakeRenderer;
  vid.width = 320;
  vid.height = 200;

  // host.oldrealtime paired with host.realtime: Host_FilterTime (host.ts)
  // gates every frame on `host.realtime - host.oldrealtime >= 1/72`, so
  // zeroing realtime alone leaves oldrealtime at whatever an earlier suite's
  // own Host_Frame calls last set it to -- a stale, larger oldrealtime makes
  // that difference deeply negative, and every later suite's first frame
  // (any dedicated/qwsv/qwcl boot that calls Host_Frame once with a small
  // synthetic timestep) silently no-ops forever after (rule 15).
  host.realtime = 0;
  host.oldrealtime = 0;
  host.time = 0;

  keyState.key_dest = KeydestT.key_game;

  cls.demonum = 0;
  cls.demoplayback = false;
  cls.state = CactiveT.ca_disconnected;

  sv.active = false;
  cl.intermission = 0;
  svs.maxclients = 0;

  menu.menuState.m_state = menu.MStateT.m_none;
  menu.menuState.m_main_cursor = 0;
  menu.menuState.options_cursor = 0;
  menu.menuState.keys_cursor = 0;
  menu.menuState.bind_grab = false;
  menu.menuState.lanConfig_cursor = -1;
  menu.menuState.lanConfig_port = 0;
  menu.menuState.lanConfig_portname = "";
  menu.menuState.gameoptions_cursor = 0;
  menu.menuState.maxplayers = 0;
  menu.menuState.startepisode = 0;
  menu.menuState.startlevel = 0;
  menu.menuState.m_serverInfoMessage = false;
}

beforeEach(() => {
  resetMenuState();
});

//=============================================================================

describe("M_Menu_Main_f / M_Main_Draw", () => {
  test("M_Menu_Main_f sets m_state and key_dest", () => {
    setKeyDest(KeydestT.key_game);
    cls.demonum = 3;

    menu.M_Menu_Main_f();

    expect(menu.menuState.m_state).toBe(menu.MStateT.m_main);
    expect(keyState.key_dest).toBe(KeydestT.key_menu);
    // key_dest != key_menu on entry, so cls.demonum is saved and cleared
    expect(cls.demonum).toBe(-1);
  });

  test("M_Main_Draw issues the expected pic sequence", () => {
    host.time = 0; // (int)(0*10)%6 == 0 -> "gfx/menudot1.lmp"
    menu.menuState.m_main_cursor = 0;

    menu.M_Main_Draw();

    expect(cachePicCalls).toEqual(["gfx/qplaque.lmp", "gfx/ttl_main.lmp", "gfx/mainmenu.lmp", "gfx/menudot1.lmp"]);
    // gfx/ttl_main.lmp draws via Draw_Pic; the other three via Draw_TransPic
    expect(drawCalls.map((c) => c.fn)).toEqual(["Draw_TransPic", "Draw_Pic", "Draw_TransPic", "Draw_TransPic"]);
  });

  test("M_Main_Key K_DOWNARROW cycles mod MAIN_ITEMS", () => {
    menu.menuState.m_main_cursor = menu.MAIN_ITEMS - 1;

    menu.M_Main_Key(K_DOWNARROW);

    expect(menu.menuState.m_main_cursor).toBe(0);

    menu.M_Main_Key(K_DOWNARROW);
    expect(menu.menuState.m_main_cursor).toBe(1);
  });
});

//=============================================================================

describe("M_AdjustSliders", () => {
  test("gamma clamps to 0.5..1", () => {
    // menu.ts reads/writes "gamma" by name (menu.c does the same -- it
    // never links view.c's cvar_t directly), so this test registers the
    // same object view.ts exports rather than a throwaway CvarT: two
    // separate objects under the same name would leave whichever
    // registers second permanently unreachable by name (Cvar_RegisterVariable
    // does not replace an existing entry, matching the C's own "allready
    // defined" behavior), and view.ts's V_CheckGamma reads its own `v_gamma`
    // binding directly, not a by-name lookup.
    Cvar_RegisterVariable(v_gamma); // a no-op if view.ts already registered it
    const savedGamma = v_gamma.value;
    menu.menuState.options_cursor = 4; // gamma

    try {
      // upper clamp: v_gamma.value -= dir*0.05, dir=-1 pushes it above 1
      Cvar_Set("gamma", "1");
      menu.M_AdjustSliders(-1);
      expect(Cvar_VariableValue("gamma")).toBe(1);

      // lower clamp: dir=1 pushes it below 0.5
      Cvar_Set("gamma", "0.5");
      menu.M_AdjustSliders(1);
      expect(Cvar_VariableValue("gamma")).toBe(0.5);

      // an in-range adjustment is not clamped
      Cvar_Set("gamma", "0.8");
      menu.M_AdjustSliders(1); // 0.8 - 0.05 = 0.75
      expect(Cvar_VariableValue("gamma")).toBeCloseTo(0.75, 5);
    } finally {
      Cvar_Set("gamma", String(savedGamma));
    }
  });
});

//=============================================================================

describe("M_FindKeysForCommand / M_UnbindCommand", () => {
  test("finds two bound keys", () => {
    Key_SetBinding(11, "+menutest_cmd");
    Key_SetBinding(22, "+menutest_cmd");

    const twokeys: [number, number] = [-1, -1];
    menu.M_FindKeysForCommand("+menutest_cmd", twokeys);

    expect(twokeys).toEqual([11, 22]);

    Key_SetBinding(11, "");
    Key_SetBinding(22, "");
  });
});

//=============================================================================

describe("M_Keys_Key", () => {
  beforeEach(() => {
    Key_Init(); // registers "bind"/"unbind" (idempotent if already registered)
  });

  test("K_ENTER then a key inserts the bind text into the command buffer", () => {
    const testKeyCode = "j".charCodeAt(0);
    Key_SetBinding(testKeyCode, "");
    menu.menuState.keys_cursor = 0; // bindnames[0][0] === "+attack"
    menu.menuState.bind_grab = false;

    menu.M_Keys_Key(K_ENTER); // enters bind_grab mode
    expect(menu.menuState.bind_grab).toBe(true);

    menu.M_Keys_Key(testKeyCode); // defines the key, inserts `bind "J" "+attack"`
    expect(menu.menuState.bind_grab).toBe(false);

    Cbuf_Execute(); // actually run the inserted "bind" command

    expect(keybindings[testKeyCode]).toBe("+attack");

    Key_SetBinding(testKeyCode, "");
  });

  test("K_BACKSPACE unbinds the selected command", () => {
    const testKeyCode = "k".charCodeAt(0);
    Key_SetBinding(testKeyCode, "+attack");
    menu.menuState.keys_cursor = 0; // bindnames[0][0] === "+attack"
    menu.menuState.bind_grab = false;

    menu.M_Keys_Key(K_BACKSPACE);

    expect(keybindings[testKeyCode]).toBe("");
  });

  test("K_DEL also unbinds", () => {
    const testKeyCode = "l".charCodeAt(0);
    Key_SetBinding(testKeyCode, "+attack");
    menu.menuState.keys_cursor = 0;
    menu.menuState.bind_grab = false;

    menu.M_Keys_Key(K_DEL);

    expect(keybindings[testKeyCode]).toBe("");
  });
});

//=============================================================================

describe("M_ScanSaves", () => {
  const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");

  test("reads s%i.sav comments over a scratch game directory", () => {
    const dir = mkdtempSync(join(scratchRoot, "menu-scansaves-"));
    try {
      // version 5, comment "Hello_World" (SAVEGAME_COMMENT_LENGTH-padded in
      // real saves; M_ScanSaves only reads the one whitespace-delimited
      // token fscanf's "%79s" would, so an unpadded token round-trips fine).
      writeFileSync(join(dir, "s0.sav"), "5\nHello_World\n");
      writeFileSync(join(dir, "s5.sav"), "5\nAnother_Save\n");

      COM_AddGameDirectory(dir);
      menu.M_ScanSaves();

      expect(menu.m_filenames[0]).toBe("Hello World");
      expect(menu.loadable[0]).toBe(true);

      expect(menu.m_filenames[5]).toBe("Another Save");
      expect(menu.loadable[5]).toBe(true);

      expect(menu.m_filenames[1]).toBe("--- UNUSED SLOT ---");
      expect(menu.loadable[1]).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

//=============================================================================

describe("M_LanConfig_Key", () => {
  test("digit editing and the 65535 clamp", () => {
    menu.menuState.lanConfig_cursor = 0; // the Port field
    menu.menuState.lanConfig_port = 26000;
    menu.menuState.lanConfig_portname = "";

    for (const ch of "70000") menu.M_LanConfig_Key(ch.charCodeAt(0));

    // the 5th digit pushes Q_atoi("70000") = 70000 past 65535, so it is
    // discarded and the display reverts to the last valid value (7000)
    expect(menu.menuState.lanConfig_port).toBe(7000);
    expect(menu.menuState.lanConfig_portname).toBe("7000");
  });

  test("non-digit keys are ignored on the Port field", () => {
    menu.menuState.lanConfig_cursor = 0;
    menu.menuState.lanConfig_port = 123;
    menu.menuState.lanConfig_portname = "123";

    menu.M_LanConfig_Key("a".charCodeAt(0));

    expect(menu.menuState.lanConfig_portname).toBe("123");
  });
});

//=============================================================================

describe("M_GameOptions", () => {
  test("maxplayers clamps to svs.maxclientslimit", () => {
    svs.maxclientslimit = 8;
    menu.menuState.gameoptions_cursor = 1; // Max players
    menu.menuState.maxplayers = 7;

    menu.M_NetStart_Change(1);
    expect(menu.menuState.maxplayers).toBe(8);

    menu.M_NetStart_Change(1);
    expect(menu.menuState.maxplayers).toBe(8);
    expect(menu.menuState.m_serverInfoMessage).toBe(true);
  });

  test("episode table selection: shareware caps at 2, registered at 7 (not hipnotic/rogue)", () => {
    expect(rogue).toBe(false); // this port's build is neither mission pack
    menu.menuState.gameoptions_cursor = 7; // Episode

    registered.value = 0; // shareware
    menu.menuState.startepisode = 1;
    menu.M_NetStart_Change(1); // 2 >= count(2) -> wraps to 0
    expect(menu.menuState.startepisode).toBe(0);

    registered.value = 1; // registered
    menu.menuState.startepisode = 0;
    menu.M_NetStart_Change(-1); // -1 < 0 -> wraps to count(7)-1
    expect(menu.menuState.startepisode).toBe(6);

    registered.value = 0;
  });
});

//=============================================================================

describe("M_DrawTextBox", () => {
  test("tile count for a 16x2 box", () => {
    menu.M_DrawTextBox(0, 0, 16, 2);

    // Draw_TransPic: left column + right column ((lines+2) each) + middle
    // (width/2 == 8 iterations of (lines+2)) == 4 + 4 + 8*4 == 40.
    const transPicCalls = drawCalls.filter((c) => c.fn === "Draw_TransPic");
    expect(transPicCalls.length).toBe(40);
    // Draw_CachePic: fewer, since the *_ml/_mr/_mm columns fetch one pic and
    // reuse it across all `lines` draws (only re-fetching for box_mm2 on the
    // second row) -- left/right: 3 cachePics each (tl|ml|bl, tr|mr|br) drawn
    // over 4 pics; middle: 4 cachePics per iteration (tm, mm, mm2, bm) drawn
    // over 4 pics -- 3 + 3 + 8*4 == 38.
    expect(cachePicCalls.length).toBe(38);
  });
});

//=============================================================================
// sanity: hostCacheCount/hostcache/host.realtime are real net_main.ts/host.ts
// state, not stubs -- exercised indirectly by M_Search_Draw/M_ServerList_Draw
// (not required by the brief's test list, checked here only for the import
// wiring itself).

describe("wiring sanity", () => {
  test("hostCacheCount and hostcache come from the real net_main.ts", () => {
    expect(hostCacheCount).toBe(0);
    expect(hostcache.length).toBeGreaterThan(0);
  });
});
