// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
src/platform/vid.ts's live renderer switch with a level already loaded --
VID_CheckChanges's `restartLevel` path and the VID_RestartLevel it calls.

What broke: `map start`, then `vid_ref gl; vid_restart`, died in
gl_rmain.c's R_RenderView with "R_RenderView: NULL worldmodel", because
gl_rmisc.c's R_NewMap is the only thing that ever assigns
`r_worldentity.model` and nothing had run it since the switch. Behind that
one symptom sat the whole class: Quake 1 bakes renderer-specific data into
model_t at LOAD time (textures through ModelLoaderHooks.textureLoaded, alias
and sprite data into mod->cache in the renderer's own layout, lightmaps in
R_NewMap), and WinQuake never needs to undo that because GLQUAKE is a
compile-time #define -- so an incoming renderer inherits a level built
entirely for the outgoing one.

The switch here is exercised WITHOUT a real GL context (there is none under
the dummy video driver, and VID_CheckChanges's `name === "gl"` branch would
fall straight back to soft): the "soft" registry entry is a factory that
hands back whatever `activeRenderer` currently points at, so flipping that
variable and calling VID_CheckChanges puts a different renderer through
exactly the same teardown/install/restart sequence a real `vid_ref gl`
takes. What is under test is the sequence, not the name that selects it.

Self-sufficient per standing order 13: this file builds its own basedir,
filesystem, models, video mode and cvars, and restores every process-wide
singleton it touches (re.current, the renderer registry, the model-loader
hooks, the five hostClientHooks init members, cl/cl_entities/
cl_static_entities/cl_efrags, sv.models/sv.active, vid.*, rState.d_pzbuffer,
scrState, cmdHost.initialized, com_argv, and the "timerefresh" command).
*/

import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  com_argc,
  com_argv,
  com_gamedir,
  com_modified,
  com_searchpaths,
  pop,
  setComGamedir,
  setComModified,
  setComSearchpaths,
  setStaticRegistered,
  static_registered,
} from "../src/common/common";
import {
  MedgeT,
  ModelT as ModelClassT,
  MsurfaceT,
  MtexinfoT,
  MvertexT,
  Mod_ForName,
  Mod_Init,
  TextureT as TextureClassT,
  getModelLoaderHooks,
  setModelLoaderHooks,
  type ModelLoaderHooks,
  type ModelT,
  type TextureT,
} from "../src/common/model";
import { hostClientHooks } from "../src/common/host";
import { cmdHost, Cmd_AddCommand, Cmd_ExecuteString, CmdSourceT } from "../src/common/cmd";
import { qw } from "../src/common/quakedef";
import { cl, cl_efrags, cl_entities, cl_lightstyle, cl_static_entities, clState } from "../src/client/client";
import { EntityT, r_refdef, re, type Renderer } from "../src/client/render";
import { VID_GRADES, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import { sv } from "../src/server/server";
import {
  getRegisteredRenderer,
  registerRenderer,
  unregisterRenderer,
  VID_CheckChanges,
  vid_mode,
  vid_ref,
} from "../src/platform/vid";
import { softRenderer } from "../src/ref_soft/ref_soft";
import {
  R_Init,
  R_NewMap,
  R_RenderView,
  R_ViewChanged,
  r_ambient,
  r_clearcolor,
  r_drawentities,
  r_drawflat,
  r_drawviewmodel,
  r_fullbright,
} from "../src/ref_soft/r_main";
import { R_TimeRefresh_f } from "../src/ref_soft/r_misc";
import { CvarT, Cvar_RegisterVariable } from "../src/common/cvar";
import * as consoleModule from "../src/client/console";
import { rState } from "../src/ref_soft/r_shared";
import { MplaneT } from "../src/common/mathlib";
import { d_8to24table } from "../src/client/vid";
import {
  MAX_LIGHTMAPS,
  TEXTURE0_SGIS,
  cnttextures,
  glState,
  setSurfPolys,
} from "../src/ref_gl/glquake";
import { QGLRecording, qglHolder } from "../src/ref_gl/qgl";
import { GL_ClearTextureState } from "../src/ref_gl/gl_rmisc";
import { GL_BuildLightmaps, allocated, glRsurfState, lightmap_modified, lightmap_polys, lightmap_rectchange, lightmaps } from "../src/ref_gl/gl_rsurf";
import { R_InitSky, glWarpState } from "../src/ref_gl/gl_warp";
import { ngraphState } from "../src/ref_gl/gl_ngraph";
import { BSP_MIPTEX_NAME, buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "vid-restart-test-"));
const baseDir = join(scratchDir, "quake");

const MAP_NAME = "maps/vidrestart.bsp";
const MDL_NAME = "progs/vidrestart.mdl";
const SPR_NAME = "progs/vidrestart.spr";
const MID_LIGHT = 128;

// vid_mode 0 -- the smallest entry in VID_MODES, so the frame at the end of
// this suite rasterizes 320x240 rather than a desktop resolution.
const TEST_VID_MODE = 0;

//============================================================================
// the incoming renderer

/*
gfx/colormap.lmp's shape: VID_GRADES rows of 256, row 0 the identity and row
63 all index 0, dimming monotonically in between (test/ref_soft_world_render
.test.ts's own realShapedColormap).
*/
function realShapedColormap(): Uint8Array {
  const cm = new Uint8Array(256 * VID_GRADES);
  const last = VID_GRADES - 1;
  for (let row = 0; row < VID_GRADES; row++) {
    for (let p = 0; p < 256; p++) {
      cm[row * 256 + p] = row === last ? 0 : Math.round((p * (last - row)) / last);
    }
  }
  return cm;
}

interface SwitchLog {
  textures: string[];
  aliasModels: string[];
  spriteModels: string[];
  rInit: number;
  newMap: number;
  addEfrags: number;
  removeEfrags: number;
  timerefresh: number;
}

const log: SwitchLog = {
  textures: [],
  aliasModels: [],
  spriteModels: [],
  rInit: 0,
  newMap: 0,
  addEfrags: 0,
  removeEfrags: 0,
  timerefresh: 0,
};

function resetLog(): void {
  log.textures = [];
  log.aliasModels = [];
  log.spriteModels = [];
  log.rInit = 0;
  log.newMap = 0;
  log.addEfrags = 0;
  log.removeEfrags = 0;
  log.timerefresh = 0;
}

/*
The loader half of the incoming renderer. The bodies delegate to the software
renderer's real hooks so the reloaded model_t is a usable one (a stub here
would prove the hooks were reached and nothing else); what is recorded is
that THIS renderer's hooks -- the ones installed by the switch, not the ones
the level was originally loaded through -- are what Mod_LoadModel called.
*/
const incomingHooks: ModelLoaderHooks = {
  notexture: softRenderer.modelHooks.notexture,
  textureLoaded(tx: TextureT): void {
    log.textures.push(tx.name);
    softRenderer.modelHooks.textureLoaded(tx);
  },
  Mod_LoadLighting(mod, buf, l): void {
    softRenderer.modelHooks.Mod_LoadLighting(mod, buf, l);
  },
  Mod_LoadAliasModel(mod, buf): void {
    log.aliasModels.push(mod.name);
    softRenderer.modelHooks.Mod_LoadAliasModel(mod, buf);
  },
  Mod_LoadSpriteModel(mod, buf): void {
    log.spriteModels.push(mod.name);
    softRenderer.modelHooks.Mod_LoadSpriteModel(mod, buf);
  },
};

function incomingTimeRefresh_f(): void {
  log.timerefresh++;
}

/*
The incoming renderer itself: the software renderer with the four members
this suite watches replaced. R_Init registers "timerefresh" the way both
r_main.c's and gl_rmisc.c's do -- the call that used to die with
"Cmd_AddCommand after host_initialized" and now has to land on top of the
outgoing renderer's function of the same name.
*/
const incomingRenderer: Renderer = {
  ...softRenderer,
  modelHooks: incomingHooks,
  R_Init(): void {
    log.rInit++;
    Cmd_AddCommand("timerefresh", incomingTimeRefresh_f);
    // r_main.c's and gl_rmain.c's R_Init both register these; in this port
    // both renderers import the one CvarT from src/client/render.ts, so the
    // second pass over it is the same object being re-linked
    Cvar_RegisterVariable(r_fullbright);
    Cvar_RegisterVariable(r_drawentities);
  },
  R_NewMap(): void {
    log.newMap++;
    softRenderer.R_NewMap();
  },
  R_AddEfrags(ent: EntityT): void {
    log.addEfrags++;
    softRenderer.R_AddEfrags(ent);
  },
  R_RemoveEfrags(ent: EntityT): void {
    log.removeEfrags++;
    softRenderer.R_RemoveEfrags(ent);
  },
};

// what the "soft" registry entry hands back, flipped by the tests below to
// put a different renderer through the same switch (see the file header)
let activeRenderer: Renderer = softRenderer;

//============================================================================

const fakeVid: VidBackend = {
  VID_SetPalette(_palette: Uint8Array): void {},
  VID_ShiftPalette(_palette: Uint8Array): void {},
  VID_Init(_palette: Uint8Array): void {},
  VID_Shutdown(): void {},
  VID_Update(_rects: VrectT | null): void {},
  VID_SetMode(_modenum: number, _palette: Uint8Array): number {
    return 0;
  },
  VID_HandlePause(_pause: boolean): void {},
  VID_LockBuffer(): void {},
  VID_UnlockBuffer(): void {},
  D_BeginDirectRect(_x: number, _y: number, _pbitmap: Uint8Array, _width: number, _height: number): void {},
  D_EndDirectRect(_x: number, _y: number, _width: number, _height: number): void {},
};

function setCvar(cv: { string: string; value: number }, v: number): void {
  cv.string = String(v);
  cv.value = v;
}

// the three lines CL_ClearState uses to chain cl_efrags into cl.free_efrags,
// without CL_ClearState's own Host_ClearMemory/PR_ClearProgs side effects
function buildEfragFreeList(): void {
  for (const e of cl_efrags) {
    e.leaf = null;
    e.leafnext = null;
    e.entity = null;
    e.entnext = null;
  }
  cl.free_efrags = cl_efrags[0];
  let i: number;
  for (i = 0; i < cl_efrags.length - 1; i++) cl_efrags[i].entnext = cl_efrags[i + 1];
  cl_efrags[i].entnext = null;
}

// every leaf, not just leafs[0..numleafs): `numleafs` is the submodel's
// visleafs count, one short of the array, which is exactly what r_main.c's
// and gl_rmisc.c's own "FIXME: is this one short?" is about
function countEfragsOnWorld(world: ModelT): number {
  let n = 0;
  for (const leaf of world.leafs) {
    for (let ef = leaf.efrags; ef !== null; ef = ef.leafnext) n++;
  }
  return n;
}

//============================================================================

let world: ModelT | null = null;
let aliasModel: ModelT | null = null;
let spriteModel: ModelT | null = null;
let staticEnt: EntityT | null = null;

const savedRe = re.current;
const savedBackend = vidBackend.current;
const savedModelHooks = getModelLoaderHooks();
const savedSoftFactory = getRegisteredRenderer("soft");
const savedGlFactory = getRegisteredRenderer("gl");
const savedRInit = hostClientHooks.rInit;
const savedRInitTextures = hostClientHooks.rInitTextures;
const savedDrawInit = hostClientHooks.drawInit;
const savedScrInit = hostClientHooks.scrInit;
const savedSbarInit = hostClientHooks.sbarInit;
const savedCmdInitialized = cmdHost.initialized;
const savedVidRef = vid_ref.string;
const savedVidMode = vid_mode.value;
const savedVidModeString = vid_mode.string;
const savedQwActive = qw.active;
const savedSvActive = sv.active;
const savedSvModels = sv.models;
const savedColormap = vid.colormap;
const savedFullbright = vid.fullbright;
const savedWidth = vid.width;
const savedHeight = vid.height;
const savedRowbytes = vid.rowbytes;
const savedBuffer = vid.buffer;
const savedConwidth = vid.conwidth;
const savedConheight = vid.conheight;
const savedAspect = vid.aspect;
const savedRecalcRefdef = vid.recalc_refdef;
const savedZbuffer = rState.d_pzbuffer;
const savedBlockDrawing = scrState.block_drawing;
const savedSbLines = scrState.sb_lines;
const savedFullupdate = scrState.scr_fullupdate;
const savedArgv = com_argv.slice();
const savedArgc = com_argc;
// COM_InitFilesystem/COM_CheckRegistered below rebuild the search path and
// flip both registration flags -- this suite's synthetic pak0.pak has an
// id1-unlike CRC, so it sets com_modified, which is what turns a LATER
// suite's shareware COM_CheckRegistered into "You must have the registered
// version to use modified games" (rule 15).
const savedSearchpaths = com_searchpaths;
const savedGamedir = com_gamedir;
const savedComModified = com_modified;
const savedStaticRegistered = static_registered;
const savedLightstyleLength = cl_lightstyle[0].length;
const savedLightstyleMap = cl_lightstyle[0].map;

// what VID_CheckChanges must re-run on a switch (host.c's Host_Init runs all
// five around its own VID_Init call). Stubs rather than the real Draw_Init/
// SCR_Init/Sbar_Init, which would need a gfx.wad this synthetic basedir does
// not have; rInit forwards to the installed renderer exactly as
// ref_soft.ts's own hook does, so the incoming R_Init really runs.
const hookCalls = { rInitTextures: 0, drawInit: 0, scrInit: 0, sbarInit: 0 };

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, `id1/${MAP_NAME}`, buildBsp({ lightLevel: MID_LIGHT }));
  writeGameFile(baseDir, `id1/${MDL_NAME}`, buildMdl());
  writeGameFile(baseDir, `id1/${SPR_NAME}`, buildSpr());

  // see test/model.test.ts: COM_FindFile hides loose slash paths until
  // COM_CheckRegistered has seen gfx/pop.lmp inside a pak
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  qw.active = false;
  // console.c's Con_Printf re-enters SCR_UpdateScreen while the client is not
  // signed on; D_InitCaches and R_NewMap both print
  scrState.block_drawing = true;
  vidBackend.current = fakeVid;

  setCvar(scr_viewsize, 100);
  setCvar(scr_fov, 90);
  setCvar(lcd_x, 0);

  hostClientHooks.rInitTextures = () => {
    hookCalls.rInitTextures++;
  };
  hostClientHooks.drawInit = () => {
    hookCalls.drawInit++;
  };
  hostClientHooks.scrInit = () => {
    hookCalls.scrInit++;
  };
  hostClientHooks.sbarInit = () => {
    hookCalls.sbarInit++;
  };
  hostClientHooks.rInit = () => {
    re.current?.R_Init();
  };

  activeRenderer = softRenderer;
  registerRenderer("soft", () => activeRenderer);
  vid_ref.string = "soft";
  vid_ref.value = 0;
  setCvar(vid_mode, TEST_VID_MODE);
  cmdHost.initialized = false;

  // the boot: VID_Init's own `VID_CheckChanges(false)` plus the R_Init
  // host.c runs separately right after it
  VID_CheckChanges(false);
  R_Init();

  setCvar(r_ambient, 0);
  setCvar(r_fullbright, 0);
  setCvar(r_drawflat, 0);
  setCvar(r_drawentities, 0);
  setCvar(r_drawviewmodel, 0);
  setCvar(r_clearcolor, 2);

  // style 0 unmapped -> r_light.c's R_AnimateLight leaves it at 256
  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  vid.colormap = realShapedColormap();
  vid.fullbright = 256;

  // cl_parse.c's CL_ParseServerInfo: precache every model, then wire the
  // world into cl and (as SV_SpawnServer does) into the server, which shares
  // these exact model_t objects
  buildEfragFreeList();
  world = Mod_ForName(MAP_NAME, true);
  aliasModel = Mod_ForName(MDL_NAME, true);
  spriteModel = Mod_ForName(SPR_NAME, true);
  expect(world).not.toBeNull();
  expect(aliasModel).not.toBeNull();
  expect(spriteModel).not.toBeNull();

  cl.model_precache[1] = world;
  cl.model_precache[2] = aliasModel;
  cl.model_precache[3] = spriteModel;
  cl.worldmodel = world;
  cl_entities[0].model = world;
  cl.viewentity = 0;
  cl.maxclients = 1;
  cl.intermission = 0;
  clState.cl_numvisedicts = 0;

  sv.active = true;
  sv.worldmodel = world;
  sv.models[1] = world;

  R_NewMap();

  // cl_parse.c's CL_ParseStatic, for one static entity
  staticEnt = cl_static_entities[0];
  staticEnt.clear();
  staticEnt.model = world;
  staticEnt.colormap = vid.colormap;
  cl.num_statics = 1;
  softRenderer.R_AddEfrags(staticEnt);
});

afterAll(() => {
  if (savedSoftFactory) registerRenderer("soft", savedSoftFactory);
  else unregisterRenderer("soft");
  if (savedGlFactory) registerRenderer("gl", savedGlFactory);
  else unregisterRenderer("gl");

  // put r_main.c's own R_TimeRefresh_f back under the name the incoming
  // renderer's R_Init replaced (the switch back to soft above already does
  // this through soft's R_Init; done again unconditionally so a failure
  // partway through cannot leave another suite holding this file's stub)
  const savedRendererSwitch = cmdHost.rendererSwitch;
  cmdHost.rendererSwitch = true;
  Cmd_AddCommand("timerefresh", R_TimeRefresh_f);
  cmdHost.rendererSwitch = savedRendererSwitch;

  re.current = savedRe;
  vidBackend.current = savedBackend;
  setModelLoaderHooks(savedModelHooks);
  hostClientHooks.rInit = savedRInit;
  hostClientHooks.rInitTextures = savedRInitTextures;
  hostClientHooks.drawInit = savedDrawInit;
  hostClientHooks.scrInit = savedScrInit;
  hostClientHooks.sbarInit = savedSbarInit;
  cmdHost.initialized = savedCmdInitialized;

  vid_ref.string = savedVidRef;
  vid_mode.value = savedVidMode;
  vid_mode.string = savedVidModeString;

  cl.model_precache.fill(null);
  cl.worldmodel = null;
  cl.num_statics = 0;
  cl.maxclients = 0;
  cl.viewentity = 0;
  cl.free_efrags = null;
  for (const e of cl_efrags) {
    e.leaf = null;
    e.leafnext = null;
    e.entity = null;
    e.entnext = null;
  }
  cl_entities[0].model = null;
  cl_static_entities[0].clear();
  clState.cl_numvisedicts = 0;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;

  sv.active = savedSvActive;
  sv.worldmodel = null;
  sv.models = savedSvModels;

  qw.active = savedQwActive;
  vid.colormap = savedColormap;
  vid.fullbright = savedFullbright;
  vid.width = savedWidth;
  vid.height = savedHeight;
  vid.rowbytes = savedRowbytes;
  vid.buffer = savedBuffer;
  vid.conbuffer = savedBuffer;
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  vid.aspect = savedAspect;
  vid.recalc_refdef = savedRecalcRefdef;
  rState.d_pzbuffer = savedZbuffer;
  scrState.block_drawing = savedBlockDrawing;
  scrState.sb_lines = savedSbLines;
  scrState.scr_fullupdate = savedFullupdate;
  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;

  COM_InitArgv(["quake", ...savedArgv.slice(1, savedArgc)]);
  setComSearchpaths(savedSearchpaths);
  setComGamedir(savedGamedir);
  setComModified(savedComModified);
  setStaticRegistered(savedStaticRegistered);
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================

describe("a vid_ref switch with a level loaded", () => {
  test("installs the incoming renderer and reloads the level through it, without throwing", () => {
    expect(world).not.toBeNull();
    if (!world) return;

    const worldBefore = world;
    const aliasBefore = aliasModel;
    const spriteBefore = spriteModel;
    const efragsBefore = countEfragsOnWorld(worldBefore);
    expect(efragsBefore).toBeGreaterThan(0);

    resetLog();
    const hooksBefore = { ...hookCalls };

    // the state a `vid_restart` typed at the console is in: host.c has long
    // since set host_initialized, which is what used to turn the incoming
    // renderer's own Cmd_AddCommand into "Cmd_AddCommand after
    // host_initialized"
    cmdHost.initialized = true;
    activeRenderer = incomingRenderer;
    expect(() => VID_CheckChanges()).not.toThrow();

    expect(re.current).toBe(incomingRenderer);
    expect(getModelLoaderHooks()).toBe(incomingHooks);

    // R_Init ran, and its Cmd_AddCommand replaced the outgoing renderer's
    // function of the same name rather than printing "already defined"
    expect(log.rInit).toBe(1);
    Cmd_ExecuteString("timerefresh", CmdSourceT.src_command);
    expect(log.timerefresh).toBe(1);

    // host.c's four other per-renderer inits ran again too
    expect(hookCalls.rInitTextures).toBe(hooksBefore.rInitTextures + 1);
    expect(hookCalls.drawInit).toBe(hooksBefore.drawInit + 1);
    expect(hookCalls.scrInit).toBe(hooksBefore.scrInit + 1);
    expect(hookCalls.sbarInit).toBe(hooksBefore.sbarInit + 1);

    // every precached model was read again through the INCOMING renderer's
    // hooks -- the world's textures, the alias model and the sprite
    expect(log.textures).toContain(BSP_MIPTEX_NAME);
    expect(log.aliasModels).toEqual([MDL_NAME]);
    expect(log.spriteModels).toEqual([SPR_NAME]);

    // ... in place: the same model_t objects cl, cl_entities[0] and the
    // server are still holding
    expect(cl.model_precache[1]).toBe(worldBefore);
    expect(cl.model_precache[2]).toBe(aliasBefore);
    expect(cl.model_precache[3]).toBe(spriteBefore);
    expect(cl.worldmodel).toBe(worldBefore);
    expect(cl_entities[0].model).toBe(worldBefore);

    // the server's hull/clipnode data came back with it (sv.models[] and
    // sv.worldmodel are these same objects; SV_Move walks their hulls)
    expect(sv.models[1]).toBe(worldBefore);
    expect(sv.worldmodel).toBe(worldBefore);
    expect(worldBefore.hulls[0].clipnodes.length).toBeGreaterThan(0);
    expect(worldBefore.hulls[1].clipnodes.length).toBeGreaterThan(0);
    expect(worldBefore.hulls[0].planes.length).toBeGreaterThan(0);
    expect(worldBefore.nodes.length).toBeGreaterThan(0);
    expect(worldBefore.numleafs).toBeGreaterThan(0);

    // R_NewMap ran on the incoming renderer, and the static entity's efrags
    // were rebuilt on the freshly loaded world afterwards
    expect(log.newMap).toBe(1);
    expect(log.addEfrags).toBe(cl.num_statics);
    expect(countEfragsOnWorld(worldBefore)).toBe(efragsBefore);
    expect(staticEnt?.efrag).not.toBeNull();

    // screen.c reads this after any mode/renderer change
    expect(vid.recalc_refdef).toBe(1);
  });

  test("hands the outgoing renderer's efrags back to cl.free_efrags instead of leaking the pool", () => {
    expect(world).not.toBeNull();
    if (!world) return;

    // one efrag per leaf the static entity touches, taken off cl.free_efrags
    // and put back by R_RemoveEfrags; the count after a switch has to match
    // the count before it, or MAX_EFRAGS drains a switch at a time
    const freeBefore = (() => {
      let n = 0;
      for (let ef = cl.free_efrags; ef !== null; ef = ef.entnext) n++;
      return n;
    })();

    resetLog();
    activeRenderer = softRenderer;
    expect(() => VID_CheckChanges()).not.toThrow();

    // the OUTGOING renderer (the incoming one of the previous test) is what
    // hands the efrags back, before its world model is thrown away
    expect(log.removeEfrags).toBe(cl.num_statics);
    expect(re.current).toBe(softRenderer);

    let freeAfter = 0;
    for (let ef = cl.free_efrags; ef !== null; ef = ef.entnext) freeAfter++;
    expect(freeAfter).toBe(freeBefore);
  });

  test("switching back renders a frame of the reloaded level instead of a blank screen", () => {
    expect(world).not.toBeNull();
    if (!world) return;

    // out to the other renderer and back again, so the frame below is drawn
    // by a software renderer that got the level handed to it by a switch
    resetLog();
    activeRenderer = incomingRenderer;
    expect(() => VID_CheckChanges()).not.toThrow();
    activeRenderer = softRenderer;
    expect(() => VID_CheckChanges()).not.toThrow();
    expect(re.current).toBe(softRenderer);
    expect(getModelLoaderHooks()).toBe(softRenderer.modelHooks);
    // the outgoing renderer is the one whose R_RemoveEfrags must run
    expect(log.removeEfrags).toBe(cl.num_statics);

    // r_main.c's R_RenderView Sys_Errors "R_RenderView: NULL worldmodel"
    // unless both of these survived the round trip
    expect(cl.worldmodel).toBe(world);
    expect(cl_entities[0].model).toBe(world);

    const vrectin = new VrectT();
    vrectin.width = vid.width;
    vrectin.height = vid.height;
    r_refdef.fov_x = 90;
    r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
    scrState.sb_lines = 24;
    R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

    r_refdef.vieworg[0] = -26;
    r_refdef.vieworg[1] = 5;
    r_refdef.vieworg[2] = 64;
    r_refdef.viewangles[0] = 45;
    r_refdef.viewangles[1] = 25;
    r_refdef.viewangles[2] = 0;

    const buffer = vid.buffer;
    expect(buffer).not.toBeNull();
    if (!buffer) return;
    buffer.fill(0);

    expect(() => R_RenderView()).not.toThrow();

    const vrect = r_refdef.vrect;
    const seen = new Set<number>();
    let nonzero = 0;
    for (let row = 0; row < vrect.height; row++) {
      const src = (vrect.y + row) * vid.rowbytes + vrect.x;
      for (let x = 0; x < vrect.width; x++) {
        const p = buffer[src + x];
        seen.add(p);
        if (p !== 0) nonzero++;
      }
    }

    // more than one value means real surfaces got spans, not just
    // r_clearcolor over an empty world
    expect(seen.size).toBeGreaterThan(2);
    expect(nonzero).toBeGreaterThan((vrect.width * vrect.height) / 100);
  });

  /*
  cvar.c's "Can't register variable %s, allready defined" guard exists to
  catch two different cvar_t under one name. Every Cvar_RegisterVariable a
  switch re-runs is the SAME object being re-linked, which is a no-op, so
  cvar.ts's own `cmdHost.rendererSwitch` branch keeps those quiet -- one
  switch printed 12 of these lines and three printed 82.
  */
  test("re-registering the same cvar object during the switch prints nothing", () => {
    const spy = spyOn(consoleModule, "Con_Printf");
    try {
      activeRenderer = incomingRenderer;
      expect(() => VID_CheckChanges()).not.toThrow();

      const printed = spy.mock.calls.map((args) => String(args[0]));
      expect(printed.some((line) => line.includes("allready defined"))).toBe(false);
    } finally {
      spy.mockRestore();
      activeRenderer = softRenderer;
      VID_CheckChanges();
    }
  });

  test("a DIFFERENT cvar object under a name already taken still prints, switch window or not", () => {
    const spy = spyOn(consoleModule, "Con_Printf");
    const savedRendererSwitch = cmdHost.rendererSwitch;
    cmdHost.rendererSwitch = true;
    try {
      // r_fullbright is already linked as src/client/render.ts's object; this
      // is a second, unreachable one under the same name -- a real collision
      Cvar_RegisterVariable(new CvarT("r_fullbright", "0"));

      const printed = spy.mock.calls.map((args) => String(args[0]));
      expect(printed.some((line) => line.includes("allready defined"))).toBe(true);
    } finally {
      cmdHost.rendererSwitch = savedRendererSwitch;
      spy.mockRestore();
    }
  });
});

//============================================================================
// The GL renderer's own restart reset (src/ref_gl/gl_rmisc.ts's
// GL_ClearTextureState, which ref_gl.ts's Renderer.Shutdown calls from
// teardownActiveRenderer above).
//
// The switch exercised earlier in this file runs under the dummy video
// driver, where there is no GL context at all and VID_CheckChanges's
// `name === "gl"` branch falls straight back to soft -- so it never reaches
// the real gl_* modules. This block drives them directly.
//
// What broke: GL_ClearTextureCaches cleared gltextures[]/menu_cachepics[] and
// rewound glState.texture_extension_number to 1, but GLQuake mints several
// texture ids ONCE and keeps them behind an `if (!x)` guard so a level change
// does not re-mint them -- gl_rsurf.c's GL_BuildLightmaps
// (`if (!lightmap_textures) { lightmap_textures = texture_extension_number;
// texture_extension_number += MAX_LIGHTMAPS; }`) and gl_warp.c's R_InitSky
// (`if (!solidskytexture) solidskytexture = texture_extension_number++;`).
// Those two survived the reset, so the world textures uploaded after the
// restart were handed the very numbers they still pointed at: binding a wall
// sampled the lightmap atlas, binding the sky sampled another texture.
//
// Every process-wide singleton this block writes (qglHolder, glState,
// glWarpState, ngraphState, glRsurfState, the lightmap arrays, cl.worldmodel/
// cl.model_precache, d_8to24table) is saved and restored here, per standing
// orders 13 and 15.
//============================================================================

describe("GL_ClearTextureState (the GL renderer's restart reset)", () => {
  const rec = new QGLRecording();

  const glSaved = {
    qgl: qglHolder.current,
    texExt: glState.texture_extension_number,
    lightmap_textures: glState.lightmap_textures,
    particletexture: glState.particletexture,
    playertextures: glState.playertextures,
    mirrortexturenum: glState.mirrortexturenum,
    skytexturenum: glState.skytexturenum,
    currenttexture: glState.currenttexture,
    oldtarget: glState.oldtarget,
    cnt0: cnttextures[0],
    cnt1: cnttextures[1],
    solidsky: glWarpState.solidskytexture,
    alphasky: glWarpState.alphaskytexture,
    ngraph: ngraphState.texture,
    lightmap_bytes: glRsurfState.lightmap_bytes,
    active_lightmaps: glRsurfState.active_lightmaps,
    worldmodel: cl.worldmodel,
    precache: cl.model_precache.slice(),
    palette: Array.from(d_8to24table),
    allocated: Int32Array.from(allocated),
    lightmaps: Uint8Array.from(lightmaps),
    modified: lightmap_modified.slice(),
    polys: lightmap_polys.slice(),
    rects: lightmap_rectchange.map((r) => ({ l: r.l, t: r.t, w: r.w, h: r.h })),
  };

  beforeAll(() => {
    qglHolder.current = rec;
  });

  afterAll(() => {
    qglHolder.current = glSaved.qgl;
    glState.texture_extension_number = glSaved.texExt;
    glState.lightmap_textures = glSaved.lightmap_textures;
    glState.particletexture = glSaved.particletexture;
    glState.playertextures = glSaved.playertextures;
    glState.mirrortexturenum = glSaved.mirrortexturenum;
    glState.skytexturenum = glSaved.skytexturenum;
    glState.currenttexture = glSaved.currenttexture;
    glState.oldtarget = glSaved.oldtarget;
    cnttextures[0] = glSaved.cnt0;
    cnttextures[1] = glSaved.cnt1;
    glWarpState.solidskytexture = glSaved.solidsky;
    glWarpState.alphaskytexture = glSaved.alphasky;
    ngraphState.texture = glSaved.ngraph;
    glRsurfState.lightmap_bytes = glSaved.lightmap_bytes;
    glRsurfState.active_lightmaps = glSaved.active_lightmaps;
    glRsurfState.currentmodel = null;
    glRsurfState.r_pcurrentvertbase = null;
    cl.worldmodel = glSaved.worldmodel;
    for (let i = 0; i < cl.model_precache.length; i++) cl.model_precache[i] = glSaved.precache[i] ?? null;
    for (let i = 0; i < 256; i++) d_8to24table[i] = glSaved.palette[i];
    allocated.set(glSaved.allocated);
    lightmaps.set(glSaved.lightmaps);
    for (let i = 0; i < MAX_LIGHTMAPS; i++) {
      lightmap_modified[i] = glSaved.modified[i];
      lightmap_polys[i] = glSaved.polys[i];
      lightmap_rectchange[i].l = glSaved.rects[i].l;
      lightmap_rectchange[i].t = glSaved.rects[i].t;
      lightmap_rectchange[i].w = glSaved.rects[i].w;
      lightmap_rectchange[i].h = glSaved.rects[i].h;
    }
  });

  // A 256x128 sky miptex, the shape gl_model.c hands R_InitSky.
  function makeSkyTexture(): TextureT {
    const mt = new TextureClassT();
    mt.name = "sky1";
    mt.width = 256;
    mt.height = 128;
    mt.offsets[0] = 0;
    mt.data = new Uint8Array(256 * 128);
    for (let i = 0; i < 128; i++)
      for (let j = 0; j < 128; j++) {
        mt.data[i * 256 + j] = 0;
        mt.data[i * 256 + j + 128] = 1;
      }
    return mt;
  }

  // One axis-aligned quad face, walked surfedges -> edges -> vertexes exactly
  // as GL_BuildLightmaps -> BuildSurfaceDisplayList does.
  function makeQuadWorld(): ModelT {
    const model = new ModelClassT();
    model.name = "maps/glrestart.bsp";
    const corners: Array<[number, number]> = [
      [0, 0],
      [32, 0],
      [32, 32],
      [0, 32],
    ];
    model.vertexes = corners.map((c) => {
      const v = new MvertexT();
      v.position[0] = c[0];
      v.position[1] = c[1];
      v.position[2] = 0;
      return v;
    });
    model.numvertexes = model.vertexes.length;

    model.edges = [new MedgeT()];
    for (let i = 0; i < 4; i++) {
      const e = new MedgeT();
      e.v[0] = i;
      e.v[1] = (i + 1) % 4;
      model.edges.push(e);
    }
    model.numedges = model.edges.length;
    model.surfedges = new Int32Array([1, 2, 3, 4]);
    model.numsurfedges = 4;

    const texture = new TextureClassT();
    texture.name = "wall";
    texture.width = 16;
    texture.height = 16;
    const ti = new MtexinfoT();
    ti.vecs[0].set([1, 0, 0, 0]);
    ti.vecs[1].set([0, 1, 0, 0]);
    ti.texture = texture;

    const face = new MsurfaceT();
    face.firstedge = 0;
    face.numedges = 4;
    face.texinfo = ti;
    face.extents[0] = 32;
    face.extents[1] = 32;
    face.texturemins[0] = 0;
    face.texturemins[1] = 0;
    face.styles[0] = 255;
    face.samples = null;
    face.plane = new MplaneT();
    face.plane.normal[2] = 1;
    face.plane.dist = 0;
    setSurfPolys(face, null);

    model.surfaces = [face];
    model.numsurfaces = 1;
    model.lightdata = null;
    return model;
  }

  /* The exact statics the previous, caches-only reset left behind. */
  test("puts every retained texture id back to its initializer", () => {
    // a plausible post-boot state: Draw_Init/R_Init/R_InitSky/GL_BuildLightmaps
    // have all run and the counter has walked past everything they claimed.
    glState.lightmap_textures = 155;
    glWarpState.solidskytexture = 46;
    glWarpState.alphaskytexture = 47;
    glState.particletexture = 7;
    glState.playertextures = 8;
    ngraphState.texture = 6;
    glState.mirrortexturenum = 12;
    glState.skytexturenum = 3;
    glState.currenttexture = 46;
    glState.oldtarget = TEXTURE0_SGIS + 1;
    cnttextures[0] = 46;
    cnttextures[1] = 155;
    glState.texture_extension_number = 307;

    GL_ClearTextureState();

    // glquake.ts / gl_warp.ts / gl_ngraph.ts initializers, so every `if (!x)`
    // guard allocates again
    expect(glState.lightmap_textures).toBe(0);
    expect(glWarpState.solidskytexture).toBe(0);
    expect(glWarpState.alphaskytexture).toBe(0);
    expect(glState.particletexture).toBe(0);
    expect(glState.playertextures).toBe(0);
    expect(ngraphState.texture).toBe(0);
    expect(glState.mirrortexturenum).toBe(0);
    expect(glState.skytexturenum).toBe(0);

    // GL_Bind's and GL_SelectTexture's caches, so the first bind after the
    // restart really issues its glBindTexture
    expect(glState.currenttexture).toBe(-1);
    expect(glState.oldtarget).toBe(TEXTURE0_SGIS);
    expect(cnttextures[0]).toBe(-1);
    expect(cnttextures[1]).toBe(-1);
  });

  /* Contract point 2: the counter stays monotonic. */
  test("leaves texture_extension_number alone, so no name is ever re-issued", () => {
    glState.texture_extension_number = 307;
    GL_ClearTextureState();
    expect(glState.texture_extension_number).toBe(307);
  });

  test("clears the lightmap page bookkeeping a shorter map would otherwise inherit", () => {
    allocated[3 * 256] = 17;
    lightmap_modified[3] = true;
    lightmap_rectchange[3].l = 5;
    lightmap_rectchange[3].w = 9;
    glRsurfState.lightmap_bytes = 4;

    GL_ClearTextureState();

    expect(allocated[3 * 256]).toBe(0);
    expect(lightmap_modified[3]).toBe(false);
    expect(lightmap_rectchange[3].l).toBe(0);
    expect(lightmap_rectchange[3].w).toBe(0);
    expect(glRsurfState.lightmap_bytes).toBe(0);
  });

  /*
  The defect itself: after the reset, the guards must hand out ids that
  cannot collide with anything the pre-restart context held.
  */
  test("R_InitSky and GL_BuildLightmaps re-allocate above every pre-restart id", () => {
    d_8to24table[0] = 0xffffffff;
    d_8to24table[1] = 0x00030201;

    // pre-restart: the sky and the lightmap atlas own ids inside the range a
    // rewound counter would hand straight back out to the world textures.
    glWarpState.solidskytexture = 46;
    glWarpState.alphaskytexture = 47;
    glState.lightmap_textures = 155;
    glState.texture_extension_number = 307;
    const preRestartHighWater = glState.texture_extension_number;

    GL_ClearTextureState();

    const world = makeQuadWorld();
    cl.worldmodel = world;
    for (let i = 0; i < cl.model_precache.length; i++) cl.model_precache[i] = null;
    cl.model_precache[1] = world;

    R_InitSky(makeSkyTexture());
    GL_BuildLightmaps();

    // both guards fired again...
    expect(glWarpState.solidskytexture).not.toBe(0);
    expect(glWarpState.alphaskytexture).not.toBe(0);
    expect(glState.lightmap_textures).not.toBe(0);

    // ...and every id they minted is one the destroyed context never used
    expect(glWarpState.solidskytexture).toBeGreaterThanOrEqual(preRestartHighWater);
    expect(glWarpState.alphaskytexture).toBeGreaterThanOrEqual(preRestartHighWater);
    expect(glState.lightmap_textures).toBeGreaterThanOrEqual(preRestartHighWater);
    expect(glState.texture_extension_number).toBe(glState.lightmap_textures + MAX_LIGHTMAPS);

    // the two sky ids and the MAX_LIGHTMAPS lightmap block do not overlap
    const lmLo = glState.lightmap_textures;
    const lmHi = lmLo + MAX_LIGHTMAPS;
    expect(glWarpState.solidskytexture < lmLo || glWarpState.solidskytexture >= lmHi).toBe(true);
    expect(glWarpState.alphaskytexture < lmLo || glWarpState.alphaskytexture >= lmHi).toBe(true);
    expect(glWarpState.alphaskytexture).toBe(glWarpState.solidskytexture + 1);

    // and both really were uploaded into the new context
    const skyUploads = rec.calls.filter((c) => c.name === "qglTexImage2D" && c.args[3] === 128 && c.args[4] === 128);
    expect(skyUploads.length).toBeGreaterThanOrEqual(2);
  });
});
