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
//
// U17 additions (below the original test body): the New Game episode picker/
// level select/Add-Ons screens and the Options screen's seven new rows.
// Every new cvar this file registers to exercise those rows (gl_coloredlight,
// snd_speed, cl_weaponswitch, sv_autosave, joy_enable, language) is the REAL
// object from its owning module, imported directly and registered with
// Cvar_RegisterVariable (idempotent per cvar.ts's own "allready defined"
// guard) -- never a throwaway same-named CvarT, which would permanently
// shadow the real one for any other test file sharing this bun process (rule
// 15's restoration requirement exists precisely to avoid that). Values are
// snapshotted and restored in this file's own afterAll. Screens that need a
// mounted re-release root (COM_IsRereleaseRoot()) call COM_InitArgv/
// COM_InitFilesystem against a fresh scratch directory per test, the same
// pattern test/fs_rerelease.test.ts uses; com_searchpaths/com_gamedir are
// snapshotted before the first such call and restored afterward via
// common.ts's own setComSearchpaths/setComGamedir (com_rerelease_root/
// com_classic_root/com_basedir have no exported setter -- see this file's
// afterAll for the compensating final COM_InitFilesystem reset).

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelLoaderHooks } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import type { Renderer } from "../src/client/render";
import { Cvar_RegisterVariable, Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString } from "../src/common/cvar";
import { v_gamma } from "../src/client/view";
import {
  COM_AddGameDirectory,
  COM_InitArgv,
  COM_InitFilesystem,
  COM_IsRereleaseRoot,
  COM_RereleaseDir,
  com_gamedir,
  com_searchpaths,
  registered,
  rogue,
  setComGamedir,
  setComHomedir,
  com_homedir,
  setComSearchpaths,
} from "../src/common/common";
import * as cmdModule from "../src/common/cmd";
import { Cbuf_Init, Cbuf_Execute, Cmd_TokenizeString } from "../src/common/cmd";
import { host, sv_autosave, coop, skill, teamplay } from "../src/common/host";
import "../src/common/host_cmd";
import { hostCacheCount, hostcache } from "../src/common/net_main";
import { svs, sv } from "../src/server/server";
import { cls, cl, CactiveT } from "../src/client/client";
import {
  KeydestT,
  keyState,
  keybindings,
  Key_Init,
  Key_SetBinding,
  K_ESCAPE,
  K_ENTER,
  K_UPARROW,
  K_DOWNARROW,
  K_LEFTARROW,
  K_RIGHTARROW,
  K_BACKSPACE,
  K_DEL,
} from "../src/client/keys";
import { re } from "../src/client/render";
import { vid } from "../src/client/vid";
import "../src/client/screen_types";
import "../src/client/screen";
import "../src/client/cl_main";
import { cl_weaponswitch, cl_protocol } from "../src/client/cl_main";
import { snd_speed } from "../src/client/sound";
import { joy_enable } from "../src/platform/sdl";
import { gl_coloredlight } from "../src/ref_gl/glquake";
import { language, sv_ruleset, campaign } from "../src/progs/ext/ruleset";
import { sv_protocol } from "../src/server/sv_main";
import { Bot_ForgetKnowledge, Bot_ForgetMapdb, bot_count, bot_skill } from "../src/bots";
import * as menu from "../src/client/menu";

// cmd_text (cmd.ts's command buffer) is unallocated until Cbuf_Init runs;
// without this, Cbuf_AddText/Cbuf_InsertText immediately "overflow" (maxsize
// is 0). Host_Init calls this in the real engine; this test does it directly.
Cbuf_Init();

// U40 addition: a bare spyOn (rule 15) recording every Cbuf_AddText call
// without changing its behavior -- the New Game/Bots/Join Game launch-string
// tests below read `.mock.calls` off this rather than re-implementing
// Cbuf_Execute-driven end-to-end checks (menu_content.test.ts's own
// Content_PerformLaunch describe block explains why: exercising the queued
// commands for real needs a mounted gamedir/bsp, out of this file's scope).
// Cleared before every test (this file's own beforeEach below) and restored
// in this file's own afterAll.
const cbufAddTextSpy = spyOn(cmdModule, "Cbuf_AddText");

// resetMenuState() (below) parks cls.state at ca_disconnected as this file's
// own beforeEach baseline, not the pristine ca_dedicated default, and this
// file has no afterAll to put it back -- the last test to run here leaks
// ca_disconnected into the rest of this bun process (rule 15). Snapshot
// captured before resetMenuState ever runs, restored below.
const savedClsState = cls.state;

// U17: snapshots for the new cvars this file registers/mutates and the
// filesystem globals its re-release-root tests rebuild via COM_InitFilesystem
// -- see this file's own header note on why com_rerelease_root/
// com_classic_root/com_basedir get only a best-effort neutral reset below
// (no exported setter exists for them).
const savedGlColoredLight = { string: gl_coloredlight.string, value: gl_coloredlight.value };
const savedSndSpeed = { string: snd_speed.string, value: snd_speed.value };
const savedClWeaponswitch = { string: cl_weaponswitch.string, value: cl_weaponswitch.value };
const savedSvAutosave = { string: sv_autosave.string, value: sv_autosave.value };
const savedJoyEnable = { string: joy_enable.string, value: joy_enable.value };
const savedLanguage = { string: language.string, value: language.value };
const savedSvRuleset = { string: sv_ruleset.string, value: sv_ruleset.value };
const savedCampaign = { string: campaign.string, value: campaign.value };
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;
const savedComHomedir = com_homedir;

// U40: cl_protocol/sv_protocol/coop/teamplay (real objects, each registered
// inside its own module's init function rather than at module load -- see
// this file's own header note above on why every cvar this file exercises
// gets registered here explicitly) plus bot_count/bot_skill (registered as a
// module-load side effect of importing "../src/bots" transitively through
// menu_content.ts -- see that module's own header).
const savedClProtocol = { string: cl_protocol.string, value: cl_protocol.value };
const savedSvProtocol = { string: sv_protocol.string, value: sv_protocol.value };
const savedCoop = { string: coop.string, value: coop.value };
const savedTeamplay = { string: teamplay.string, value: teamplay.value };
// F3: the Begin Game launch script now re-queues `skill` after the gamedir
// switch, so this file drives the real cvar too.
const savedSkill = { string: skill.string, value: skill.value };
const savedBotCount = { string: bot_count.string, value: bot_count.value };
const savedBotSkill = { string: bot_skill.string, value: bot_skill.value };

Cvar_RegisterVariable(gl_coloredlight);
Cvar_RegisterVariable(snd_speed);
Cvar_RegisterVariable(cl_weaponswitch);
Cvar_RegisterVariable(sv_autosave);
Cvar_RegisterVariable(joy_enable);
Cvar_RegisterVariable(language);
Cvar_RegisterVariable(sv_ruleset);
Cvar_RegisterVariable(campaign);
Cvar_RegisterVariable(cl_protocol);
Cvar_RegisterVariable(sv_protocol);
Cvar_RegisterVariable(coop);
Cvar_RegisterVariable(teamplay);
Cvar_RegisterVariable(skill);

// A neutral scratch root (no mapdb.json) this file's afterAll re-mounts as
// its last act, so COM_IsRereleaseRoot()/COM_ClassicDir()/COM_RereleaseDir()
// read a sane, non-leaking value for whatever test file shares this bun
// process next -- the closest this file can get to "restoring" those three
// private common.ts globals, which have no exported setter (unlike
// com_searchpaths/com_gamedir, restored exactly below).
const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
const neutralScratchRoot = mkdtempSync(join(scratchRoot, "menu-neutral-"));
mkdirSync(join(neutralScratchRoot, "id1"), { recursive: true });

afterAll(() => {
  cls.state = savedClsState;

  gl_coloredlight.string = savedGlColoredLight.string;
  gl_coloredlight.value = savedGlColoredLight.value;
  snd_speed.string = savedSndSpeed.string;
  snd_speed.value = savedSndSpeed.value;
  cl_weaponswitch.string = savedClWeaponswitch.string;
  cl_weaponswitch.value = savedClWeaponswitch.value;
  sv_autosave.string = savedSvAutosave.string;
  sv_autosave.value = savedSvAutosave.value;
  joy_enable.string = savedJoyEnable.string;
  joy_enable.value = savedJoyEnable.value;
  language.string = savedLanguage.string;
  language.value = savedLanguage.value;
  sv_ruleset.string = savedSvRuleset.string;
  sv_ruleset.value = savedSvRuleset.value;
  campaign.string = savedCampaign.string;
  campaign.value = savedCampaign.value;
  cl_protocol.string = savedClProtocol.string;
  cl_protocol.value = savedClProtocol.value;
  sv_protocol.string = savedSvProtocol.string;
  sv_protocol.value = savedSvProtocol.value;
  coop.string = savedCoop.string;
  coop.value = savedCoop.value;
  skill.string = savedSkill.string;
  skill.value = savedSkill.value;
  teamplay.string = savedTeamplay.string;
  teamplay.value = savedTeamplay.value;
  bot_count.string = savedBotCount.string;
  bot_count.value = savedBotCount.value;
  bot_skill.string = savedBotSkill.string;
  bot_skill.value = savedBotSkill.value;
  Bot_ForgetKnowledge();
  Bot_ForgetMapdb();
  cbufAddTextSpy.mockRestore();

  COM_InitArgv(["q1ts", "-basedir", neutralScratchRoot]);
  COM_InitFilesystem();
  setComSearchpaths(savedComSearchpaths);
  setComGamedir(savedComGamedir);
  setComHomedir(savedComHomedir);
  rmSync(neutralScratchRoot, { recursive: true, force: true });
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
  // Renderer interface addition (U19/U44, landed concurrently with this
  // unit): menu.ts never calls this (it's kfont_text.ts's own primitive),
  // but the Renderer interface requires every implementer to have it. Not
  // this unit's own work -- see this file's own header note if this test
  // ever needs to assert on it.
  Draw_GlyphAtlas(): void {},
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

// U17 addition: the same widening trick as setKeyDest above, for
// menu.menuState.m_state (this file's header note already flagged this as
// the same narrowing hazard menu.ts's own M_Draw works around).
function setMState(v: menu.MStateT): void {
  menu.menuState.m_state = v;
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

  // U40 additions.
  menu.menuState.qexBotsCursor = 0;
  menu.menuState.gameoptionsRulesetIndex = 1;
  menu.menuState.gameoptionsProtocolIndex = 0;
  menu.menuState.gameoptionsBotCount = 0;
  menu.menuState.gameoptionsBotSkillIndex = 2;
  menu.menuState.gameoptionsCtf = false;
  menu.menuState.setupTeamIndex = 0;
  menu.menuState.m_multiplayer_cursor = 0;
  menu.menuState.setup_cursor = 4;
}

beforeEach(() => {
  resetMenuState();
  cbufAddTextSpy.mockClear();
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

      // F3: com_gamedir is the WRITE tier, which defaults to the per-user
      // home directory. This test's saves live in the scratch gamedir
      // itself, so it mounts with the home tier off -- the -nohomedir
      // behaviour -- rather than under $XDG_DATA_HOME.
      setComHomedir("");
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

//=============================================================================
// U17: New Game gates on the content model. See this file's own header note
// on why COM_InitFilesystem is called with an explicit scratch root here
// rather than relying on "nothing else in this process mounted a re-release
// root yet" -- that assumption is not this test file's to make.

describe("M_SinglePlayer_Key New Game: classic path preserved with no mapdb.json", () => {
  test("cursor 0 + ENTER queues the classic 'map start' sequence, m_state untouched", () => {
    const plainRoot = mkdtempSync(join(scratchRoot, "menu-nogame-classic-"));
    mkdirSync(join(plainRoot, "id1"), { recursive: true });
    try {
      setComSearchpaths(null); // see "U17 re-release content screens" block's own comment on why
      COM_InitArgv(["q1ts", "-basedir", plainRoot]);
      COM_InitFilesystem();
      expect(COM_IsRereleaseRoot()).toBe(false);

      menu.menuState.m_singleplayer_cursor = 0;
      setMState(menu.MStateT.m_singleplayer);
      sv.active = false;
      setKeyDest(KeydestT.key_menu);

      menu.M_SinglePlayer_Key(K_ENTER);

      // the classic body only ever sets key_dest -- it never touches m_state
      // (M_Menu_Load_f/M_Menu_Save_f are the only other case-0 exits, and
      // this is cursor 0's "New Game" case).
      expect(keyState.key_dest).toBe(KeydestT.key_game);
      expect(menu.menuState.m_state).toBe(menu.MStateT.m_singleplayer);
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
    }
  });
});

//=============================================================================
// U17: New Game episode picker / level select / Start, and Options' Add-Ons
// screen, against a synthetic -rerelease scratch root (COM_InitArgv/
// -rerelease bypasses COM_IsRereleaseRootDir's pak-scanning auto-detect, so a
// loose mapdb.json with no pak/kpf is enough -- test/menu_content.test.ts's
// own header explains this in more depth).

describe("U17 re-release content screens", () => {
  const root = mkdtempSync(join(scratchRoot, "menu-newgame-rerelease-"));
  const MAPDB_TEXT = JSON.stringify({
    episodes: [
      { dir: "id1", name: "$m_quake" },
      { dir: "hipnotic", name: "$m_scourge" },
    ],
    maps: [
      { title: "Entrance", bsp: "start", episode: "id1", game: "id1", sp: true },
      { title: "Slipgate Complex", bsp: "e1m1", episode: "id1", game: "id1", sp: true },
    ],
  });

  // Re-mounted before EVERY test in this block, not just once -- bun:test
  // interleaves test execution across FILES sharing this process (confirmed
  // empirically: test/menu_content.test.ts's own real-qfiles/q1 mount was
  // observed landing between two of this block's tests during a combined
  // run), and common.ts's COM_InitFilesystem PREPENDS onto whatever
  // com_searchpaths already holds rather than resetting it (by design --
  // the real engine only ever calls it once at boot; test/fs_rerelease.
  // test.ts's own header note is the precedent for handling this: unique
  // names for positive assertions, and here, a full setComSearchpaths(null)
  // plus a fresh mount for every single test rather than trusting an
  // earlier test in this describe block, or another file entirely, to leave
  // the search path exactly as this block last set it).
  beforeEach(() => {
    setComSearchpaths(null);
    mkdirSync(join(root, "id1", "localization"), { recursive: true });
    writeFileSync(join(root, "id1", "mapdb.json"), MAPDB_TEXT);
    writeFileSync(join(root, "id1", "localization", "loc_english.txt"), 'm_quake = "Quake"\n');
    writeFileSync(join(root, "id1", "localization", "loc_french.txt"), 'm_quake = "Quake (FR)"\n');
    // hipnotic's dir is deliberately never created -- mapdb.json lists it,
    // but it isn't mounted, so it must not appear in the picker (mirrors
    // menu_content.test.ts's own "not mounted -> excluded" coverage).

    COM_InitArgv(["q1ts", "-rerelease", root]);
    COM_InitFilesystem();
    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(COM_RereleaseDir()).toBe(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("New Game opens the episode picker with only the mounted episode", () => {
    menu.menuState.m_singleplayer_cursor = 0;
    setMState(menu.MStateT.m_singleplayer);
    sv.active = false;
    setKeyDest(KeydestT.key_menu);

    menu.M_SinglePlayer_Key(K_ENTER);

    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_episodes);
    expect(keyState.key_dest).toBe(KeydestT.key_menu);
  });

  test("K_ESCAPE from the episode picker returns to Single Player", () => {
    menu.M_QexEpisodes_Key(K_ESCAPE);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_singleplayer);
  });

  test("selecting the episode opens Level Select; Down/Enter/ruleset/difficulty/Start navigate and launch", () => {
    // Re-enter the picker (the previous test escaped out of it).
    menu.menuState.m_singleplayer_cursor = 0;
    sv.active = false;
    setKeyDest(KeydestT.key_menu);
    menu.M_SinglePlayer_Key(K_ENTER);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_episodes);

    menu.menuState.qexEpisodeCursor = 0;
    menu.M_QexEpisodes_Key(K_ENTER);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_levels);
    expect(menu.menuState.qexSelectedEpisode).toBe(0);
    expect(menu.menuState.qexSelectedLevel).toBe(0); // defaults to "start"

    // rows: [start(0), e1m1(1), ruleset(2), difficulty(3), start-button(4)]
    menu.menuState.qexLevelCursor = 0;
    menu.M_QexLevels_Key(K_DOWNARROW);
    expect(menu.menuState.qexLevelCursor).toBe(1);
    menu.M_QexLevels_Key(K_ENTER); // select e1m1
    expect(menu.menuState.qexSelectedLevel).toBe(1);

    menu.M_QexLevels_Key(K_DOWNARROW); // -> ruleset row
    expect(menu.menuState.qexLevelCursor).toBe(2);
    const rulesetBefore = menu.menuState.qexRulesetIndex;
    menu.M_QexLevels_Key(K_RIGHTARROW);
    expect(menu.menuState.qexRulesetIndex).toBe((rulesetBefore + 1) % 2);

    menu.M_QexLevels_Key(K_DOWNARROW); // -> difficulty row
    expect(menu.menuState.qexLevelCursor).toBe(3);
    menu.M_QexLevels_Key(K_DOWNARROW); // -> Start row
    expect(menu.menuState.qexLevelCursor).toBe(4);

    menu.M_QexLevels_Key(K_ENTER); // Start

    expect(keyState.key_dest).toBe(KeydestT.key_game);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_none);
  });

  test("K_ESCAPE from Level Select returns to the episode picker", () => {
    menu.menuState.qexSelectedEpisode = 0;
    menu.M_Menu_QexLevels_f();
    menu.M_QexLevels_Key(K_ESCAPE);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_episodes);
  });

  test("Add-Ons screen (from Options) lists Base Game and navigates/switches", () => {
    menu.menuState.options_cursor = 19;
    setMState(menu.MStateT.m_options);
    setKeyDest(KeydestT.key_menu);

    menu.M_Options_Key(K_ENTER);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_addons);
    expect(menu.menuState.qexAddonsCursor).toBe(0);

    menu.M_QexAddons_Key(K_ESCAPE);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_options);
  });

  // F3: choosing an Add-Ons row queues the gamedir switch AND the command
  // that opens that add-on's own New Game screen once the switch (and the
  // quake.rc re-exec Host_Game_f inserts ahead of it) has actually run.
  test("Add-Ons ENTER queues `game <dir>` then `menu_episodes <dir>`", () => {
    menu.M_Menu_QexAddons_f();
    menu.menuState.qexAddonsCursor = 0; // the synthetic "Base Game" row
    cbufAddTextSpy.mockClear();

    menu.M_QexAddons_Key(K_ENTER);

    expect(cbufAddTextSpy.mock.calls.map(([s]) => s)).toEqual(["game id1\n", "menu_episodes id1\n"]);
  });

  test("menu_episodes reloads the content model and lands on the named episode", () => {
    setMState(menu.MStateT.m_options);
    Cmd_TokenizeString("menu_episodes id1");
    menu.M_Menu_QexEpisodes_Cmd_f();

    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_episodes);
    expect(menu.menuState.qexEpisodeCursor).toBe(0); // id1 is the only mounted episode here
    expect(keyState.key_dest).toBe(KeydestT.key_menu);
  });

  test("menu_episodes with a name that has no episode leaves the cursor alone", () => {
    menu.menuState.qexEpisodeCursor = 0;
    Cmd_TokenizeString("menu_episodes nosuchdir");
    menu.M_Menu_QexEpisodes_Cmd_f();

    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_episodes);
    expect(menu.menuState.qexEpisodeCursor).toBe(0);
  });

  test("Options' language row cycles through the mounted loc files", () => {
    Cvar_Set("language", "english");
    menu.menuState.options_cursor = 17; // language row
    menu.M_Options_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("language")).toBe("french");
    menu.M_Options_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("language")).toBe("english");
  });

  test("Draw functions run without throwing over the mounted content", () => {
    menu.menuState.qexSelectedEpisode = 0;
    menu.M_Menu_QexEpisodes_f();
    expect(() => menu.M_QexEpisodes_Draw()).not.toThrow();
    menu.M_Menu_QexLevels_f();
    expect(() => menu.M_QexLevels_Draw()).not.toThrow();
    menu.M_Menu_QexAddons_f();
    expect(() => menu.M_QexAddons_Draw()).not.toThrow();
  });
});

//=============================================================================
// U17: Options screen's seven new rows (registered against the REAL cvars --
// see this file's header note).

describe("M_Options_Key / M_AdjustSliders: U17 rows", () => {
  test("gl_coloredlight and joy_enable toggle 0/1", () => {
    Cvar_Set("gl_coloredlight", "1");
    menu.menuState.options_cursor = 13;
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("gl_coloredlight")).toBe(0);

    Cvar_Set("joy_enable", "0");
    menu.menuState.options_cursor = 18;
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("joy_enable")).toBe(1);
  });

  test("snd_speed cycles through the fixed rate list", () => {
    Cvar_SetValue("snd_speed", 44100);
    menu.menuState.options_cursor = 14;
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("snd_speed")).toBe(48000);
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("snd_speed")).toBe(11025); // wraps
  });

  test("cl_weaponswitch is a 3-way cycle (0=only new, 1=never, 2=always), not a checkbox", () => {
    Cvar_Set("cl_weaponswitch", "0");
    menu.menuState.options_cursor = 16;
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("cl_weaponswitch")).toBe(1);
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("cl_weaponswitch")).toBe(2);
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("cl_weaponswitch")).toBe(0); // wraps
    menu.M_AdjustSliders(-1);
    expect(Cvar_VariableValue("cl_weaponswitch")).toBe(2); // wraps the other way
  });

  test("sv_autosave toggles 0/1", () => {
    Cvar_Set("sv_autosave", "1");
    menu.menuState.options_cursor = 15;
    menu.M_AdjustSliders(1);
    expect(Cvar_VariableValue("sv_autosave")).toBe(0);
  });

  test("language row is a no-op with no loc files mounted", () => {
    // Explicitly mounts a clean, loc-file-free root rather than trusting
    // "nothing else mounted one" -- another test FILE sharing this bun
    // process (e.g. test/menu_content.test.ts's guarded real-data block,
    // which mounts the real qfiles/q1 install with every LOC_LANGUAGES file
    // present) may leave a real re-release root mounted, and this suite's
    // own file-order relative to others isn't this test's to assume.
    const cleanRoot = mkdtempSync(join(scratchRoot, "menu-options-noloc-"));
    mkdirSync(join(cleanRoot, "id1"), { recursive: true });
    try {
      setComSearchpaths(null); // see "U17 re-release content screens" block's own comment on why
      COM_InitArgv(["q1ts", "-basedir", cleanRoot]);
      COM_InitFilesystem();

      const before = Cvar_VariableString("language");
      menu.menuState.options_cursor = 17;
      menu.M_AdjustSliders(1);
      expect(Cvar_VariableString("language")).toBe(before);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  test("OPTIONS_ITEMS wraps at the new last row (19, Add-Ons)", () => {
    menu.menuState.options_cursor = menu.OPTIONS_ITEMS - 1;
    menu.M_Options_Key(K_DOWNARROW);
    expect(menu.menuState.options_cursor).toBe(0);

    menu.menuState.options_cursor = 0;
    menu.M_Options_Key(K_UPARROW);
    expect(menu.menuState.options_cursor).toBe(menu.OPTIONS_ITEMS - 1);
  });
});

//=============================================================================
// U17: Load/Save screens' Autosave row.

describe("M_Load_Key / M_Save_Key: Autosave row", () => {
  test("the newest autosave/*.sav is scanned and 'load autosave' is queued", () => {
    const dir = mkdtempSync(join(scratchRoot, "menu-autosave-"));
    try {
      mkdirSync(join(dir, "autosave"), { recursive: true });
      writeFileSync(join(dir, "autosave", "e1m1.sav"), "6\nAutosaved_Game\n");

      // See M_ScanSaves above: the autosave lives in the scratch gamedir, so
      // this mounts with the home write tier off.
      setComHomedir("");
      COM_AddGameDirectory(dir);
      menu.M_ScanSaves();

      expect(menu.autosaveFilename).toBe("Autosaved Game");
      expect(menu.autosaveLoadable).toBe(true);

      menu.menuState.load_cursor = menu.AUTOSAVE_SLOT;
      menu.M_Load_Key(K_ENTER);

      expect(menu.menuState.m_state).toBe(menu.MStateT.m_none);
      expect(keyState.key_dest).toBe(KeydestT.key_game);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Save screen's Autosave row is a no-op on ENTER", () => {
    setMState(menu.MStateT.m_save);
    menu.menuState.load_cursor = menu.AUTOSAVE_SLOT;
    setKeyDest(KeydestT.key_menu);

    menu.M_Save_Key(K_ENTER);

    expect(menu.menuState.m_state).toBe(menu.MStateT.m_save); // unchanged
    expect(keyState.key_dest).toBe(KeydestT.key_menu); // unchanged
  });

  test("Load/Save cursor wraps over LOAD_ROWS (13: 12 classic slots + Autosave)", () => {
    menu.menuState.load_cursor = menu.LOAD_ROWS - 1;
    menu.M_Load_Key(K_DOWNARROW);
    expect(menu.menuState.load_cursor).toBe(0);

    menu.menuState.load_cursor = 0;
    menu.M_Load_Key(K_UPARROW);
    expect(menu.menuState.load_cursor).toBe(menu.LOAD_ROWS - 1);
  });
});

//=============================================================================
// U40: "the multiplayer menus learn bots, rulesets, protocols and the
// unified client." A shared fixture root -- id1/mapdb.json (dm/coop/ctf
// maps), id1/bots/*.txt (two characters, two skills), and an empty "ctf"
// gamedir -- mounted fresh before every test in this section, the same
// setComSearchpaths(null) + full remount pattern the "U17 re-release content
// screens" block above uses and explains (bun:test interleaves file
// execution, so nothing here trusts another test/file's mount to still be
// in effect).

const U40_WEAPONS_TXT = `
{
  name "axe"
  number 4096
  damage 20
  min_range 0
  max_range 72
  min_height 0
  max_height 0
  priority 1
  ammo none
  ammo_name ""
  min_ammo 0
  max_ammo 0
  flags melee | starting
  aim_point center
}
`;

function u40SettingsBlock(skill: string): string {
  return `
skill ${skill}
{
  aiming.max_acceleration 360
  aiming.spring_stiffness 125
  aiming.damping 20
  aiming.velocity_offset -0.1
  aiming.modifier.max_angle 30
  aiming.modifier.apply_time 0.75
  aiming.modifier.accel_scalar 1.25
  aiming.modifier.spring_scalar 1.25
  aiming.modifier.damping_scalar 1.25
  behaviors.allow_combat true
  behaviors.allow_grab_items_in_combat false
  behaviors.allow_melee true
  behaviors.allow_check_six false
  behaviors.allow_grab_items true
  behaviors.allow_grab_power_items true
  behaviors.defer_power_items_to_humans false
  behaviors.min_respawn_time 1
  behaviors.max_respawn_time 1.5
  movement.allow_jumping_in_combat true
  movement.jump_chance 35
  movement.jump_cooldown 1
  movement.walk_only false
  senses.sight_time 0.25
  senses.sight_decay_time 0.3
  senses.invis_enemy_sight_scalar 2
  senses.max_invis_enemy_sight_dist 256
  senses.fov_angle 140
  senses.forget_non_vis_enemy_time 1.5
  senses.sound_range 640
  senses.sound_time 0.4
  senses.sound_decay_time 2.5
  senses.sound_persist_time 0.4
  weapons.decay_time 2
  weapons.fov_angle 40
  weapons.sight_time 0.2
}
`;
}

const U40_SETTINGS_TXT = u40SettingsBlock("easy") + u40SettingsBlock("medium");

const U40_CHARACTERS_TXT = `
{
  fun_name Grunt
  name grunt
  shirt_color 4
  pants_color 11
}
{
  fun_name Ogre
  name ogre
  shirt_color 2
  pants_color 6
}
`;

const U40_MAPDB_TEXT = JSON.stringify({
  episodes: [{ dir: "id1", name: "$m_quake" }],
  maps: [
    { title: "Entrance", bsp: "start", episode: "id1", game: "id1", sp: true },
    { title: "Slipgate Complex", bsp: "e1m1", episode: "id1", game: "id1", sp: true },
    { title: "Place of Two Deaths", bsp: "dm1", episode: "id1", game: "id1", dm: true, bots: true },
    { title: "The Cistern", bsp: "dm5", episode: "id1", game: "id1", dm: true, bots: false },
    { title: "Bounce", bsp: "coop1", episode: "id1", game: "id1", coop: true },
    { title: "McKinley Base", bsp: "ctf1", episode: "id1", game: "ctf", ctf: true, bots: true },
  ],
});

describe("U40: bots/rulesets/protocols, ctf-and-bots root mounted", () => {
  const root = mkdtempSync(join(scratchRoot, "menu-u40-ctf-bots-"));

  beforeEach(() => {
    setComSearchpaths(null);
    mkdirSync(join(root, "id1", "bots"), { recursive: true });
    mkdirSync(join(root, "ctf"), { recursive: true });
    writeFileSync(join(root, "id1", "mapdb.json"), U40_MAPDB_TEXT);
    writeFileSync(join(root, "id1", "bots", "weapons.txt"), U40_WEAPONS_TXT);
    writeFileSync(join(root, "id1", "bots", "settings_PC.txt"), U40_SETTINGS_TXT);
    writeFileSync(join(root, "id1", "bots", "characters.txt"), U40_CHARACTERS_TXT);

    COM_InitArgv(["q1ts", "-rerelease", root]);
    COM_InitFilesystem();
    expect(COM_IsRereleaseRoot()).toBe(true);
    Bot_ForgetKnowledge();
    Bot_ForgetMapdb();

    // Refreshes menu.ts's own cached content model against this mount --
    // ctfMounted()/mpEpisodesForCurrentGameType() (GameOptions, the Bots
    // page's currentOrSelectedMapName, and Setup's Team row) all read that
    // cache rather than re-scanning the filesystem on every call, the same
    // way M_Menu_QexAddons_f refreshes it on entry.
    menu.M_Menu_GameOptions_f();
    menu.menuState.startepisode = 0;
    menu.menuState.startlevel = 0;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  //---------------------------------------------------------------------
  // Multiplayer -> Bots

  test("Multiplayer gains a fourth Bots item, reaching m_qex_bots", () => {
    setMState(menu.MStateT.m_multiplayer);
    menu.menuState.m_multiplayer_cursor = 3;
    menu.M_MultiPlayer_Key(K_ENTER);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_qex_bots);
  });

  test("K_ESCAPE from the Bots page returns to Multiplayer", () => {
    setMState(menu.MStateT.m_qex_bots);
    menu.M_QexBots_Key(K_ESCAPE);
    expect(menu.menuState.m_state).toBe(menu.MStateT.m_multiplayer);
  });

  //---------------------------------------------------------------------
  // Bots page: enable/disable by map flag

  test("enabled on dm1 (mapdb bots:true), disabled on dm5 (bots:false)", () => {
    // Game Type defaults to Deathmatch, so resolveGameOptionsMap()'s mapdb-
    // driven dm list is [dm1, dm5]; startlevel selects between them.
    menu.menuState.startlevel = 0;
    expect(menu.M_QexBots_Draw).not.toThrow(); // sanity: Draw runs over both states below

    menu.menuState.qexBotsCursor = 2; // Grunt's roster row
    menu.M_QexBots_Key(K_ENTER);
    expect(cbufAddTextSpy).toHaveBeenCalledWith('addbot "grunt" "medium"\n');

    cbufAddTextSpy.mockClear();
    menu.menuState.startlevel = 1; // dm5, bots:false
    menu.M_QexBots_Key(K_ENTER);
    expect(cbufAddTextSpy).not.toHaveBeenCalled();
  });

  test("Draw prints a note when disabled", () => {
    menu.menuState.startlevel = 1; // dm5, bots:false
    setMState(menu.MStateT.m_qex_bots);
    expect(() => menu.M_QexBots_Draw()).not.toThrow();
  });

  //---------------------------------------------------------------------
  // Bots page: roster add/kick and Add Random, issued through Cbuf

  test("roster row ENTER (inactive) issues addbot \"<characterName>\" \"<skill>\"", () => {
    menu.menuState.startlevel = 0; // dm1, bots:true
    Cvar_Set("bot_skill", "easy");
    menu.menuState.qexBotsCursor = 3; // Ogre's roster row (0=count,1=skill,2=Grunt,3=Ogre)
    menu.M_QexBots_Key(K_ENTER);
    expect(cbufAddTextSpy).toHaveBeenCalledWith('addbot "ogre" "easy"\n');
  });

  test("Add Random row issues addbot random \"<skill>\"", () => {
    menu.menuState.startlevel = 0; // dm1, bots:true
    Cvar_Set("bot_skill", "medium");
    menu.menuState.qexBotsCursor = 4; // 2 roster rows + Add Random == row 4
    menu.M_QexBots_Key(K_ENTER);
    expect(cbufAddTextSpy).toHaveBeenCalledWith('addbot random "medium"\n');
  });

  test("Bot Count/Bot Skill rows adjust bot_count/bot_skill only when enabled", () => {
    menu.menuState.startlevel = 0; // dm1, bots:true
    Cvar_SetValue("bot_count", 2);
    menu.menuState.qexBotsCursor = 0;
    menu.M_QexBots_Key(K_RIGHTARROW);
    expect(Cvar_VariableValue("bot_count")).toBe(3);

    Cvar_Set("bot_skill", "easy");
    menu.menuState.qexBotsCursor = 1;
    menu.M_QexBots_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("bot_skill")).toBe("medium");

    // disabled (dm5, bots:false): no-op
    menu.menuState.startlevel = 1;
    Cvar_SetValue("bot_count", 2);
    menu.menuState.qexBotsCursor = 0;
    menu.M_QexBots_Key(K_RIGHTARROW);
    expect(Cvar_VariableValue("bot_count")).toBe(2);
  });

  //---------------------------------------------------------------------
  // GameOptions: Ruleset/Protocol/Bot Count/Bot Skill rows

  test("Ruleset (9) and Protocol (10) rows cycle RULESETS/SV_PROTOCOLS", () => {
    menu.menuState.gameoptions_cursor = 9;
    menu.menuState.gameoptionsRulesetIndex = 0;
    menu.M_NetStart_Change(1);
    expect(menu.menuState.gameoptionsRulesetIndex).toBe(1);
    menu.M_NetStart_Change(1);
    expect(menu.menuState.gameoptionsRulesetIndex).toBe(0); // wraps

    menu.menuState.gameoptions_cursor = 10;
    menu.menuState.gameoptionsProtocolIndex = 0;
    menu.M_NetStart_Change(-1);
    expect(menu.menuState.gameoptionsProtocolIndex).toBe(3); // wraps to "999"
  });

  test("Bot Count (11) wraps 0-8, Bot Skill (12) cycles the mounted skill list", () => {
    menu.menuState.gameoptions_cursor = 11;
    menu.menuState.gameoptionsBotCount = 8;
    menu.M_NetStart_Change(1);
    expect(menu.menuState.gameoptionsBotCount).toBe(0);
    menu.M_NetStart_Change(-1);
    expect(menu.menuState.gameoptionsBotCount).toBe(8);

    menu.menuState.gameoptions_cursor = 12;
    menu.menuState.gameoptionsBotSkillIndex = 0;
    menu.M_NetStart_Change(-1);
    expect(menu.menuState.gameoptionsBotSkillIndex).toBe(1); // wraps to "medium" (2-entry mounted list)
  });

  //---------------------------------------------------------------------
  // GameOptions: mapdb-driven Game Type / Episode / Level

  test("Game Type cycles Deathmatch -> Cooperative -> CTF -> Deathmatch when ctf is mounted", () => {
    menu.menuState.gameoptions_cursor = 2;
    Cvar_SetValue("coop", 0);
    menu.menuState.gameoptionsCtf = false;

    menu.M_NetStart_Change(1); // -> Cooperative
    expect(Cvar_VariableValue("coop")).toBe(1);
    expect(menu.menuState.gameoptionsCtf).toBe(false);

    menu.M_NetStart_Change(1); // -> CTF
    expect(Cvar_VariableValue("coop")).toBe(0);
    expect(menu.menuState.gameoptionsCtf).toBe(true);

    menu.M_NetStart_Change(1); // -> Deathmatch
    expect(Cvar_VariableValue("coop")).toBe(0);
    expect(menu.menuState.gameoptionsCtf).toBe(false);
  });

  test("Episode/Level rows source from mapdb's dm flag for Deathmatch", () => {
    Cvar_SetValue("coop", 0);
    menu.menuState.gameoptionsCtf = false;
    menu.menuState.gameoptions_cursor = 8; // Level
    menu.menuState.startlevel = 0;

    menu.M_NetStart_Change(1);
    expect(menu.menuState.startlevel).toBe(1);
    menu.M_NetStart_Change(1);
    expect(menu.menuState.startlevel).toBe(0); // wraps: only 2 dm maps (dm1, dm5)
  });

  test("Episode/Level rows source from mapdb's coop flag for Cooperative", () => {
    Cvar_SetValue("coop", 1);
    menu.menuState.gameoptionsCtf = false;
    menu.menuState.gameoptions_cursor = 8;
    menu.menuState.startlevel = 0;

    menu.M_NetStart_Change(1);
    expect(menu.menuState.startlevel).toBe(0); // wraps: only 1 coop map (coop1)
  });

  //---------------------------------------------------------------------
  // GameOptions: Begin Game launch strings

  test("Begin Game (classic ruleset, mapdb dm mounted, with bots) queues game before the cvars, then bot_count/bot_skill/map", () => {
    Cvar_SetValue("coop", 0);
    Cvar_SetValue("skill", 2);
    menu.menuState.gameoptionsCtf = false;
    menu.menuState.maxplayers = 4;
    menu.menuState.startlevel = 0; // dm1
    menu.menuState.gameoptionsRulesetIndex = 0; // classic
    menu.menuState.gameoptionsProtocolIndex = 0; // auto
    menu.menuState.gameoptionsBotCount = 4;
    menu.menuState.gameoptionsBotSkillIndex = 1; // "medium" (mounted list: easy, medium)
    menu.menuState.gameoptions_cursor = 0;
    sv.active = false;

    menu.M_GameOptions_Key(K_ENTER);

    const calls = cbufAddTextSpy.mock.calls.map(([s]) => s);
    expect(calls).toEqual([
      "listen 0\n",
      // F3: `game` FIRST -- it re-execs quake.rc, whose config.cfg would
      // otherwise overwrite the archived sv_ruleset/sv_protocol below.
      "game id1\n",
      "maxplayers 4\n",
      "coop 0\n",
      "skill 2\n",
      "sv_ruleset classic\n",
      "sv_protocol auto\n",
      "bot_count 4\n",
      "bot_skill medium\n",
      "map dm1\n",
    ]);
    expect(calls.indexOf("game id1\n")).toBeLessThan(calls.indexOf("sv_ruleset classic\n"));
  });

  test("Begin Game (rerelease ruleset, disconnect prefix when sv.active)", () => {
    Cvar_SetValue("coop", 0);
    Cvar_SetValue("skill", 1);
    menu.menuState.gameoptionsCtf = false;
    menu.menuState.maxplayers = 2;
    menu.menuState.startlevel = 1; // dm5
    menu.menuState.gameoptionsRulesetIndex = 1; // rerelease
    menu.menuState.gameoptionsProtocolIndex = 2; // "666"
    menu.menuState.gameoptionsBotCount = 0;
    menu.menuState.gameoptionsBotSkillIndex = 0; // "easy"
    menu.menuState.gameoptions_cursor = 0;
    sv.active = true;

    menu.M_GameOptions_Key(K_ENTER);

    const calls = cbufAddTextSpy.mock.calls.map(([s]) => s);
    expect(calls).toEqual([
      "disconnect\n",
      "listen 0\n",
      "game id1\n",
      "maxplayers 2\n",
      "coop 0\n",
      "skill 1\n",
      "sv_ruleset rerelease\n",
      "sv_protocol 666\n",
      "bot_count 0\n",
      "bot_skill easy\n",
      "map dm5\n",
    ]);
  });

  test("Begin Game with CTF Game Type queues game ctf and teamplay 1, map from CtfMaps", () => {
    // Cycle Game Type to CTF the same way a player would (row 2's ENTER).
    menu.menuState.gameoptions_cursor = 2;
    Cvar_SetValue("coop", 0);
    Cvar_SetValue("skill", 3);
    menu.menuState.gameoptionsCtf = false;
    menu.M_NetStart_Change(1); // -> Cooperative
    menu.M_NetStart_Change(1); // -> CTF
    expect(menu.menuState.gameoptionsCtf).toBe(true);

    menu.menuState.maxplayers = 8;
    menu.menuState.gameoptionsRulesetIndex = 1;
    menu.menuState.gameoptionsProtocolIndex = 0;
    menu.menuState.gameoptionsBotCount = 1;
    menu.menuState.gameoptionsBotSkillIndex = 1;
    menu.menuState.gameoptions_cursor = 0;
    sv.active = false;

    menu.M_GameOptions_Key(K_ENTER);

    const calls = cbufAddTextSpy.mock.calls.map(([s]) => s);
    expect(calls).toEqual([
      "listen 0\n",
      "game ctf\n",
      "maxplayers 8\n",
      "coop 0\n",
      "skill 3\n",
      "sv_ruleset rerelease\n",
      "sv_protocol auto\n",
      "teamplay 1\n",
      "bot_count 1\n",
      "bot_skill medium\n",
      "map ctf1\n",
    ]);
  });

  //---------------------------------------------------------------------
  // Join Game: Protocol row (cl_protocol), keeping the classic entries

  test("Join Game gains a Protocol row cycling cl_protocol auto/nq/qw", () => {
    menu.menuState.m_multiplayer_cursor = 0; // JoiningGame()
    Cvar_Set("cl_protocol", "auto");
    menu.menuState.lanConfig_cursor = 3; // the new Protocol row

    menu.M_LanConfig_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("cl_protocol")).toBe("nq");
    menu.M_LanConfig_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("cl_protocol")).toBe("qw");
    menu.M_LanConfig_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("cl_protocol")).toBe("auto");
  });

  test("Join Game with a host:port address: cl_protocol set via the Protocol row, connect still queues the typed address", () => {
    menu.menuState.m_multiplayer_cursor = 0; // JoiningGame()
    menu.menuState.lanConfig_cursor = 3;
    Cvar_Set("cl_protocol", "auto");
    menu.M_LanConfig_Key(K_RIGHTARROW);
    menu.M_LanConfig_Key(K_RIGHTARROW);
    expect(Cvar_VariableString("cl_protocol")).toBe("qw");

    menu.menuState.lanConfig_cursor = 2; // "Join game at:"
    menu.menuState.lanConfig_joinname = "example.com:27500";
    setKeyDest(KeydestT.key_menu);
    menu.M_LanConfig_Key(K_ENTER);

    expect(cbufAddTextSpy).toHaveBeenCalledWith('connect "example.com:27500"\n');
    expect(keyState.key_dest).toBe(KeydestT.key_game);
  });

  test("StartingGame's LanConfig path keeps its classic 3-row shape -- Protocol row unreachable", () => {
    menu.menuState.m_multiplayer_cursor = 1; // StartingGame()
    menu.menuState.lanConfig_cursor = 1;
    menu.M_LanConfig_Key(K_DOWNARROW);
    // Classic StartingGame bounce (unchanged): cursor 2 is immediately
    // routed off, landing back on 0 -- lanConfigRowCount() never returns 4
    // for this path, so the new Protocol row is never reachable here.
    expect(menu.menuState.lanConfig_cursor).not.toBe(3);
  });

  //---------------------------------------------------------------------
  // Setup: Team row (CTF colours), only with the ctf gamedir mounted

  test("Setup gains a Team row cycling Red/Blue, pushing Accept Changes to row 5", () => {
    setMState(menu.MStateT.m_setup);
    menu.menuState.setup_cursor = 4; // Team row (ctf mounted: 0..5, Team=4, Accept=5)
    menu.menuState.setupTeamIndex = 0;

    menu.M_Setup_Key(K_RIGHTARROW);
    expect(menu.menuState.setupTeamIndex).toBe(1); // Blue
    expect(menu.menuState.setup_top).toBe(13);
    expect(menu.menuState.setup_bottom).toBe(13);

    menu.M_Setup_Key(K_DOWNARROW);
    expect(menu.menuState.setup_cursor).toBe(5); // Accept Changes

    expect(() => menu.M_Setup_Draw()).not.toThrow();
  });
});

//=============================================================================
// U40: classic screens stay byte-identical (same row counts/behavior) with no
// re-release data mounted -- no bots/ directory, no "ctf" gamedir, no
// mapdb.json. Reuses the plain-classic-root pattern from
// "M_SinglePlayer_Key New Game: classic path preserved" above.

describe("U40: classic screens byte-identical with no re-release data mounted", () => {
  test("Multiplayer stays a 3-item menu; cursor 2 ENTER reaches Setup, not Bots", () => {
    const plainRoot = mkdtempSync(join(scratchRoot, "menu-u40-classic-mp-"));
    mkdirSync(join(plainRoot, "id1"), { recursive: true });
    try {
      setComSearchpaths(null);
      COM_InitArgv(["q1ts", "-basedir", plainRoot]);
      COM_InitFilesystem();
      Bot_ForgetKnowledge();
      Bot_ForgetMapdb();
      expect(COM_IsRereleaseRoot()).toBe(false);

      setMState(menu.MStateT.m_multiplayer);
      menu.menuState.m_multiplayer_cursor = menu.MULTIPLAYER_ITEMS - 1; // 2, "Setup"
      menu.M_MultiPlayer_Key(K_DOWNARROW);
      expect(menu.menuState.m_multiplayer_cursor).toBe(0); // wraps at 3, not 4

      menu.menuState.m_multiplayer_cursor = 2;
      menu.M_MultiPlayer_Key(K_ENTER);
      expect(menu.menuState.m_state).toBe(menu.MStateT.m_setup);
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
    }
  });

  test("GameOptions Episode/Level keep the exact classic per-build counts (no mapdb mounted)", () => {
    const plainRoot = mkdtempSync(join(scratchRoot, "menu-u40-classic-go-"));
    mkdirSync(join(plainRoot, "id1"), { recursive: true });
    try {
      setComSearchpaths(null);
      COM_InitArgv(["q1ts", "-basedir", plainRoot]);
      COM_InitFilesystem();
      Bot_ForgetKnowledge();
      Bot_ForgetMapdb();
      menu.M_Menu_GameOptions_f(); // refresh the cached content model against this (mapdb-less) mount

      expect(rogue).toBe(false);
      menu.menuState.gameoptions_cursor = 7; // Episode
      registered.value = 1;
      menu.menuState.startepisode = 0;
      menu.M_NetStart_Change(-1); // classic registered count is 7
      expect(menu.menuState.startepisode).toBe(6);
      registered.value = 0;
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
    }
  });

  test("Setup stays a classic 5-row screen (no Team row, Accept Changes at row 4)", () => {
    const plainRoot = mkdtempSync(join(scratchRoot, "menu-u40-classic-setup-"));
    mkdirSync(join(plainRoot, "id1"), { recursive: true });
    try {
      setComSearchpaths(null);
      COM_InitArgv(["q1ts", "-basedir", plainRoot]);
      COM_InitFilesystem();
      menu.M_Menu_GameOptions_f(); // refresh the cached content model (ctfMounted() reads it) against this mount

      setMState(menu.MStateT.m_setup);
      menu.menuState.setup_cursor = menu.NUM_SETUP_CMDS - 1; // 4, Accept Changes
      menu.M_Setup_Key(K_DOWNARROW);
      expect(menu.menuState.setup_cursor).toBe(0); // wraps at 5, not 6

      expect(() => menu.M_Setup_Draw()).not.toThrow();
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
    }
  });

  test("LanConfig's StartingGame path keeps its classic 3-row shape regardless of what's mounted", () => {
    // The Join Game Protocol row is a deliberate always-on addition (cl_protocol
    // is a universal engine concept, not re-release content -- see this
    // file's own U40 header note), so it is JoiningGame()-gated, not
    // mapdb-gated; what stays byte-identical with no re-release data mounted
    // is the StartingGame (New Game) path, which never reaches it either way
    // (lanConfigRowCount() returns NUM_LANCONFIG_CMDS for StartingGame no
    // matter what's mounted).
    const plainRoot = mkdtempSync(join(scratchRoot, "menu-u40-classic-lan-"));
    mkdirSync(join(plainRoot, "id1"), { recursive: true });
    try {
      setComSearchpaths(null);
      COM_InitArgv(["q1ts", "-basedir", plainRoot]);
      COM_InitFilesystem();

      menu.menuState.m_multiplayer_cursor = 1; // StartingGame()
      menu.menuState.lanConfig_cursor = menu.NUM_LANCONFIG_CMDS - 1; // 2
      menu.M_LanConfig_Key(K_DOWNARROW);
      // classic StartingGame behavior, unchanged: DOWNARROW wraps 2 -> 0
      // (lanConfigRowCount() is NUM_LANCONFIG_CMDS === 3 for this path no
      // matter what's mounted), and the post-switch StartingGame bounce
      // (cursor === 2 only) doesn't re-fire once it's already left 2.
      expect(menu.menuState.lanConfig_cursor).toBe(0);
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
    }
  });
});
