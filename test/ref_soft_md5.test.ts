// Force headless SDL before ANY import can reach the FFI layer -- see
// test/ref_soft_world_render.test.ts's own header for why this has to come
// first.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U26 (the software renderer's re-release MD5 replacement models):
src/ref_soft/r_md5.ts, plus the load-time hook src/ref_soft/model.ts wires in
(attachMd5ReplacementIfAny) and the draw-time branch src/ref_soft/r_alias.ts's
R_AliasDrawModel takes when a payload is attached.

Follows test/ref_soft_world_render.test.ts's own pattern throughout (a
synthetic BSP world + R_RenderView, headless SDL, a fake VidBackend): this
suite needs the FULL render pipeline (Mod_ForName -> R_DrawEntitiesOnList ->
R_AliasDrawModel), not just the individual r_alias.c-ported functions
test/ref_soft_alias.test.ts drives directly, because the thing under test is
which DATA SOURCE R_AliasDrawModel draws from.

Camera/geometry: reused from test/ref_soft_alias.test.ts's own setUpView
convention -- angles (0,0,0) gives forward=(1,0,0), right=(0,-1,0),
up=(0,0,1) (AngleVectors' own output for the zero angle, that file's
comment). The camera sits at the world origin looking down +X; every
synthetic entity below sits further down +X so it is centered in view.

Self-sufficient per standing order 13: every rState/vid/cl/filesystem
singleton this file touches is snapshotted before its own describe block's
beforeAll and restored in that block's afterAll.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
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
import { Mod_ForName, Mod_Init, type ModelT, getModelLoaderHooks, setModelLoaderHooks } from "../src/common/model";
import { hostClientHooks, developer } from "../src/common/host";
import { setDeveloper } from "../src/client/console";
import { sysState } from "../src/platform/sys";
import { qw } from "../src/common/quakedef";
import { cl, cl_entities, cl_lightstyle, clState, cl_visedicts } from "../src/client/client";
import { EntityT, r_refdef, re } from "../src/client/render";
import { vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer, VID_CheckChanges } from "../src/platform/vid";
import { softRenderer } from "../src/ref_soft/ref_soft";
import { R_Init, R_NewMap, R_RenderView, R_ViewChanged, r_ambient, r_clearcolor, r_drawentities, r_drawflat, r_drawviewmodel, r_fullbright } from "../src/ref_soft/r_main";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import { r_enhancedmodels } from "../src/ref_soft/r_md5";
import { buildBsp, buildMdl, ensureDir } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

//============================================================================
// small local byte builders (test infrastructure only, not a port of any C)

function buildLmp(width: number, height: number, fillValue: number): Uint8Array {
  const buf = new Uint8Array(8 + width * height);
  const view = new DataView(buf.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  buf.fill(fillValue & 0xff, 8);
  return buf;
}

// one joint, one triangle spanning the full 0..1 UV range of a 4x4 skin,
// sitting 20 units either side of the joint origin on Y/Z -- see this
// file's header for the camera this is meant to be seen from.
function md5MeshText(shader: string): string {
  return `MD5Version 10
commandline ""

numJoints 1
numMeshes 1

joints {
  "joint0" -1 ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

mesh {
  shader "${shader}"

  numverts 3
  vert 0 ( 0.0 0.0 ) 0 1
  vert 1 ( 1.0 0.0 ) 1 1
  vert 2 ( 0.0 1.0 ) 2 1

  numtris 1
  tri 0 0 1 2

  numweights 3
  weight 0 0 1.0 ( 0.0 -30.0 -30.0 )
  weight 1 0 1.0 ( 0.0 30.0 -30.0 )
  weight 2 0 1.0 ( 0.0 30.0 30.0 )
}
`;
}

// a static (no animated components) one-frame anim, so `numJoints` is the
// only axis the mismatch test below needs to vary.
function md5AnimText(numJoints: number): string {
  return `MD5Version 10
commandline ""

numFrames 1
numJoints ${numJoints}
frameRate 24
numAnimatedComponents 0

hierarchy {
  "joint0" -1 0 0
}

bounds {
  ( -30.0 -30.0 -30.0 ) ( 30.0 30.0 30.0 )
}

baseframe {
  ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

frame 0 {
}
`;
}

//============================================================================
// shared fixture plumbing (mirrors test/ref_soft_world_render.test.ts)

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

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

function setMode320x200(): void {
  vid.width = 320;
  vid.height = 200;
  vid.rowbytes = 320;
  vid.buffer = new Uint8Array(320 * 200);
  vid.conwidth = 320;
  vid.conheight = 200;
  vid.maxwarpwidth = 320;
  vid.maxwarpheight = 200;
  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);
  vid.numpages = 1;
}

// identity across every light row, so a drawn pixel's value is exactly the
// skin's own raw palette index regardless of which light level R_LightPoint
// samples at the entity's position -- this suite cares about which SKIN's
// bytes got drawn, not about lighting.
function identityColormap(): Uint8Array {
  const VID_GRADES = 64;
  const cm = new Uint8Array(256 * VID_GRADES);
  for (let row = 0; row < VID_GRADES; row++) for (let p = 0; p < 256; p++) cm[row * 256 + p] = p;
  return cm;
}

const CLEARCOLOR = 250; // outside both the classic skin's [0,16) range and the MD5 skin's 200 sentinel

//============================================================================

const savedBackend = vidBackend.current;
const savedRenderer = re.current;
const savedModelHooks = getModelLoaderHooks();
const savedSoftFactory = getRegisteredRenderer("soft");
const savedColormap = vid.colormap;
const savedFullbright = vid.fullbright;
const savedAspect = vid.aspect;
const savedWidth = vid.width;
const savedHeight = vid.height;
const savedRowbytes = vid.rowbytes;
const savedBuffer = vid.buffer;
const savedConwidth = vid.conwidth;
const savedConheight = vid.conheight;
const savedBlockDrawing = scrState.block_drawing;
const savedSbLines = scrState.sb_lines;
const savedZbuffer = rState.d_pzbuffer;
const savedQwActive = qw.active;
const savedRInit = hostClientHooks.rInit;
const savedRInitTextures = hostClientHooks.rInitTextures;
const savedDrawInit = hostClientHooks.drawInit;
const savedRViewVectors = hostClientHooks.rViewVectors;
const savedLightstyleLength = cl_lightstyle[0].length;
const savedLightstyleMap = cl_lightstyle[0].map;
const savedLightstyleValue = d_lightstylevalue[0];
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;
const savedComModified = com_modified;
const savedStaticRegistered = static_registered;
const savedEnhanced = { string: r_enhancedmodels.string, value: r_enhancedmodels.value };
const savedDeveloper = { string: developer.string, value: developer.value };
const savedNumVisedicts = clState.cl_numvisedicts;
const savedViewentity = cl.viewentity;
const savedWorldmodel = cl.worldmodel;
const savedMaxclients = cl.maxclients;
const savedIntermission = cl.intermission;

function commonSetup(baseDir: string): void {
  ensureDir(join(baseDir, "id1"));

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "maps/refsoftmd5.bsp", data: buildBsp() },
    // "main": full, tier-matched MD5 pair -- the r_enhancedmodels=1 draw test
    { name: "progs/main.mdl", data: buildMdl({ numframes: 1 }) },
    { name: "progs/main.md5mesh", data: new TextEncoder().encode(md5MeshText("main")) },
    { name: "progs/main.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/main_00_00.lmp", data: buildLmp(4, 4, 200) },
    // "off": has an MD5 pair too, but only ever loaded/drawn with
    // r_enhancedmodels 0 -- proves the load-time gate skips it entirely.
    { name: "progs/off.mdl", data: buildMdl({ numframes: 1 }) },
    { name: "progs/off.md5mesh", data: new TextEncoder().encode(md5MeshText("off")) },
    { name: "progs/off.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/off_00_00.lmp", data: buildLmp(4, 4, 200) },
    // "bad": a REAL, format-broken pair (mesh numJoints 1, anim numJoints 2 --
    // the same shape of failure as mg3/progs/ogre_rocket, see md5_model.ts's
    // header comment mapping rule 5) -- must fall back to the .mdl.
    { name: "progs/bad.mdl", data: buildMdl({ numframes: 1 }) },
    { name: "progs/bad.md5mesh", data: new TextEncoder().encode(md5MeshText("bad")) },
    { name: "progs/bad.md5anim", data: new TextEncoder().encode(md5AnimText(2)) },
    // separate basenames for the developer-cvar test below: Mod_ForName
    // short-circuits (Cache_Check hits) on a name already loaded, so that
    // test needs two never-before-loaded models, one per developer setting,
    // rather than reloading "bad.mdl" twice.
    { name: "progs/baddev0.mdl", data: buildMdl({ numframes: 1 }) },
    { name: "progs/baddev0.md5mesh", data: new TextEncoder().encode(md5MeshText("baddev0")) },
    { name: "progs/baddev0.md5anim", data: new TextEncoder().encode(md5AnimText(2)) },
    { name: "progs/baddev1.mdl", data: buildMdl({ numframes: 1 }) },
    { name: "progs/baddev1.md5mesh", data: new TextEncoder().encode(md5MeshText("baddev1")) },
    { name: "progs/baddev1.md5anim", data: new TextEncoder().encode(md5AnimText(2)) },
    // "tier": the .mdl only in pak1 (mounted after pak0, so it is searched
    // FIRST -- tier 0); the MD5 pair only in pak0 (tier 1, lower priority) --
    // COM_FindFileTier's own header documents tier 0 as com_searchpaths'
    // head, i.e. the most-recently-mounted node.
    { name: "progs/tier.md5mesh", data: new TextEncoder().encode(md5MeshText("tier")) },
    { name: "progs/tier.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/tier_00_00.lmp", data: buildLmp(4, 4, 200) },
  ]);
  writePakToDisk(join(baseDir, "id1", "pak1.pak"), [{ name: "progs/tier.mdl", data: buildMdl({ numframes: 1 }) }]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  scrState.block_drawing = true;

  setCvar(scr_viewsize, 100);
  setCvar(scr_fov, 90);
  setCvar(lcd_x, 0);

  vidBackend.current = fakeVid;
  registerRenderer("soft", () => softRenderer);
  re.current = softRenderer;
  setModelLoaderHooks(softRenderer.modelHooks);

  R_Init();
  setCvar(r_ambient, 0);
  setCvar(r_fullbright, 0);
  setCvar(r_drawflat, 0);
  setCvar(r_drawentities, 1); // this suite's whole point is drawing an entity
  setCvar(r_drawviewmodel, 0);

  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  setMode320x200();

  const worldMod = Mod_ForName("maps/refsoftmd5.bsp", true);
  expect(worldMod).not.toBeNull();
  cl.worldmodel = worldMod;
  cl_entities[0].model = worldMod;
  cl.viewentity = 0;
  cl.maxclients = 1;
  cl.intermission = 0;
  clState.cl_numvisedicts = 0;

  R_NewMap();
}

function commonTeardown(scratchDir: string): void {
  scrState.block_drawing = savedBlockDrawing;
  scrState.sb_lines = savedSbLines;
  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;
  vid.colormap = savedColormap;
  vid.fullbright = savedFullbright;
  vid.aspect = savedAspect;
  vid.width = savedWidth;
  vid.height = savedHeight;
  vid.rowbytes = savedRowbytes;
  vid.buffer = savedBuffer;
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  rState.d_pzbuffer = savedZbuffer;
  qw.active = savedQwActive;
  cl_entities[0].model = null;
  cl.viewentity = savedViewentity;
  cl.maxclients = savedMaxclients;
  cl.intermission = savedIntermission;
  cl.worldmodel = savedWorldmodel;
  clState.cl_numvisedicts = savedNumVisedicts;
  cl_visedicts[0] = null;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;
  d_lightstylevalue[0] = savedLightstyleValue;
  vidBackend.current = savedBackend;
  re.current = savedRenderer;
  hostClientHooks.rInit = savedRInit;
  hostClientHooks.rInitTextures = savedRInitTextures;
  hostClientHooks.drawInit = savedDrawInit;
  hostClientHooks.rViewVectors = savedRViewVectors;
  setModelLoaderHooks(savedModelHooks);
  if (savedSoftFactory) registerRenderer("soft", savedSoftFactory);
  else unregisterRenderer("soft");
  setComSearchpaths(savedComSearchpaths);
  setComGamedir(savedComGamedir);
  setComModified(savedComModified);
  setStaticRegistered(savedStaticRegistered);
  r_enhancedmodels.string = savedEnhanced.string;
  r_enhancedmodels.value = savedEnhanced.value;
  developer.string = savedDeveloper.string;
  developer.value = savedDeveloper.value;
  rmSync(scratchDir, { recursive: true, force: true });
}

// Renders one frame with `mod` as a single visible entity, camera at the
// world origin looking down +X (see this file's header). Returns the
// 320x200 8-bit buffer.
function renderEntityFrame(mod: ModelT, frame: number, skinnum: number, colormap: Uint8Array): Uint8Array {
  vid.colormap = colormap;
  vid.fullbright = 256;
  setCvar(r_clearcolor, CLEARCOLOR);

  softRenderer.D_FlushCaches();
  rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
  const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
  softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

  const ent = new EntityT();
  ent.model = mod;
  ent.origin[0] = 100;
  ent.origin[1] = 0;
  ent.origin[2] = 0;
  ent.angles[0] = 0;
  ent.angles[1] = 0;
  ent.angles[2] = 0;
  ent.frame = frame;
  ent.skinnum = skinnum;
  ent.colormap = vid.colormap;
  ent.syncbase = 0;

  cl_visedicts[0] = ent;
  clState.cl_numvisedicts = 1;

  const vrectin = new VrectT();
  vrectin.width = vid.width;
  vrectin.height = vid.height;
  r_refdef.fov_x = 90;
  r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
  scrState.sb_lines = 0;
  R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

  r_refdef.vieworg[0] = 0;
  r_refdef.vieworg[1] = 0;
  r_refdef.vieworg[2] = 0;
  r_refdef.viewangles[0] = 0;
  r_refdef.viewangles[1] = 0;
  r_refdef.viewangles[2] = 0;

  const buffer = vid.buffer;
  expect(buffer).not.toBeNull();
  if (!buffer) return new Uint8Array(0);
  buffer.fill(0);

  R_RenderView();

  clState.cl_numvisedicts = 0;

  const vrect = r_refdef.vrect;
  const out = new Uint8Array(vrect.width * vrect.height);
  for (let row = 0; row < vrect.height; row++) {
    const src = (vrect.y + row) * vid.rowbytes + vrect.x;
    out.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
  }
  return out;
}

function countValue(pixels: Uint8Array, value: number): number {
  let n = 0;
  for (const p of pixels) if (p === value) n++;
  return n;
}

//============================================================================

describe("U26: MD5 replacement models (software renderer, synthetic)", () => {
  let scratchDir: string;
  let baseDir: string;
  let mainMod: ModelT | null = null;
  let offMod: ModelT | null = null;
  let badMod: ModelT | null = null;
  let tierMod: ModelT | null = null;

  beforeAll(() => {
    scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-md5-test-"));
    baseDir = join(scratchDir, "quake");
    commonSetup(baseDir);

    setCvar(r_enhancedmodels, 1);
    mainMod = Mod_ForName("progs/main.mdl", true);
    badMod = Mod_ForName("progs/bad.mdl", true);
    tierMod = Mod_ForName("progs/tier.mdl", true);

    setCvar(r_enhancedmodels, 0);
    offMod = Mod_ForName("progs/off.mdl", true);
    setCvar(r_enhancedmodels, 1); // back to the default for the rest of this block
  });

  afterAll(() => {
    commonTeardown(scratchDir);
  });

  test("draws the MD5 skin's palette index, not the .mdl's own skin", () => {
    expect(mainMod).not.toBeNull();
    if (!mainMod) return;
    setCvar(r_enhancedmodels, 1);
    const pixels = renderEntityFrame(mainMod, 0, 0, identityColormap());
    const md5Pixels = countValue(pixels, 200);
    const classicPixels = countValue(pixels, 0) + countValue(pixels, 5) + countValue(pixels, 10);
    expect(md5Pixels).toBeGreaterThan(0);
    expect(classicPixels).toBe(0);
  });

  test("r_enhancedmodels 0 at load time: the classic .mdl path draws nothing different", () => {
    expect(offMod).not.toBeNull();
    if (!offMod) return;
    // offMod was loaded above with r_enhancedmodels 0, so no MD5 payload was
    // ever attached, regardless of the cvar's value now.
    setCvar(r_enhancedmodels, 1);
    const pixels = renderEntityFrame(offMod, 0, 0, identityColormap());
    const md5Pixels = countValue(pixels, 200);
    const classicPixels = countValue(pixels, 0) + countValue(pixels, 5) + countValue(pixels, 10);
    expect(md5Pixels).toBe(0);
    expect(classicPixels).toBeGreaterThan(0);
  });

  test("the tier rule: a .md5mesh in a lower tier than the .mdl is ignored", () => {
    expect(tierMod).not.toBeNull();
    if (!tierMod) return;
    const pixels = renderEntityFrame(tierMod, 0, 0, identityColormap());
    const md5Pixels = countValue(pixels, 200);
    const classicPixels = countValue(pixels, 0) + countValue(pixels, 5) + countValue(pixels, 10);
    expect(md5Pixels).toBe(0);
    expect(classicPixels).toBeGreaterThan(0);
  });

  test("a format error in the MD5 pair falls back to the .mdl", () => {
    expect(badMod).not.toBeNull();
    if (!badMod) return;
    const pixels = renderEntityFrame(badMod, 0, 0, identityColormap());
    const md5Pixels = countValue(pixels, 200);
    const classicPixels = countValue(pixels, 0) + countValue(pixels, 5) + countValue(pixels, 10);
    expect(md5Pixels).toBe(0);
    expect(classicPixels).toBeGreaterThan(0);
  });

  test("developer 1 prints a message for the rejected pair; developer 0 stays quiet", () => {
    // console.ts's Con_DPrintf reads its OWN module-private `developer`
    // binding, wired in via setDeveloper -- nothing in this test harness's
    // init path (no Host_Init here) calls that, so this test wires it
    // itself and unwires it in `finally`, per standing order 13.
    const savedNostdout = sysState.nostdout;
    sysState.nostdout = 0;
    setDeveloper(developer);

    let sawPrint = false;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const capture = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string" && chunk.includes("MD5 model")) sawPrint = true;
      return true;
    };

    try {
      setCvar(developer, 0);
      process.stdout.write = capture as typeof process.stdout.write;
      Mod_ForName("progs/baddev0.mdl", true);
      process.stdout.write = originalWrite;
      expect(sawPrint).toBe(false);

      sawPrint = false;
      setCvar(developer, 1);
      process.stdout.write = capture as typeof process.stdout.write;
      Mod_ForName("progs/baddev1.mdl", true);
      process.stdout.write = originalWrite;
      expect(sawPrint).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
      setCvar(developer, 0);
      setDeveloper(null);
      sysState.nostdout = savedNostdout;
    }
  });
});

//============================================================================
// Guarded: real retail data (rerelease/id1's dog.mdl + dog.md5mesh/anim +
// dog_00_00.lmp). Skips itself when the retail install isn't present,
// mirroring test/lib_md5.test.ts's own existsSync-guard idiom.

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const ID1_PAK0 = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const HAVE_ID1 = existsSync(ID1_PAK0);

function boundingBoxOf(pixels: Uint8Array, width: number, height: number, background: number): { minX: number; minY: number; maxX: number; maxY: number; count: number } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] === background) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, count };
}

(HAVE_ID1 ? describe : describe.skip)("U26: MD5 replacement models (guarded: real dog.mdl + dog.md5mesh/anim)", () => {
  let scratchDir: string;
  let dogMod: ModelT | null = null;

  beforeAll(() => {
    // no scratch fixture needed: the real retail pak0.pak carries
    // gfx/pop.lmp, maps/start.bsp and the whole progs/dog.* MD5 replacement
    // set already (verified against the real file before writing this
    // test).
    scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-md5-dog-test-"));

    COM_InitArgv(["quake", "-basedir", RERELEASE_DATA_DIR]);
    COM_InitFilesystem();
    COM_CheckRegistered();
    Mod_Init();

    scrState.block_drawing = true;
    setCvar(scr_viewsize, 100);
    setCvar(scr_fov, 90);
    setCvar(lcd_x, 0);

    vidBackend.current = fakeVid;
    registerRenderer("soft", () => softRenderer);
    re.current = softRenderer;
    setModelLoaderHooks(softRenderer.modelHooks);

    R_Init();
    setCvar(r_ambient, 0);
    setCvar(r_fullbright, 0);
    setCvar(r_drawflat, 0);
    setCvar(r_drawentities, 1);
    setCvar(r_drawviewmodel, 0);

    cl_lightstyle[0].length = 0;
    cl_lightstyle[0].map = "";

    setMode320x200();

    // the real id1 tree's own maps/start.bsp is small and always present in
    // a retail install; used purely so R_NewMap/R_RenderView have a valid
    // world model to walk (this test's own point is the entity draw, not
    // the world).
    const worldMod = Mod_ForName("maps/start.bsp", true);
    expect(worldMod).not.toBeNull();
    cl.worldmodel = worldMod;
    cl_entities[0].model = worldMod;
    cl.viewentity = 0;
    cl.maxclients = 1;
    cl.intermission = 0;
    clState.cl_numvisedicts = 0;
    R_NewMap();

    setCvar(r_enhancedmodels, 1);
    dogMod = Mod_ForName("progs/dog.mdl", true);
  });

  afterAll(() => {
    commonTeardown(scratchDir);
  });

  test("the MD5 replacement draws non-background pixels overlapping the classic .mdl's own", () => {
    expect(dogMod).not.toBeNull();
    if (!dogMod) return;

    const ent = new EntityT();
    ent.model = dogMod;
    ent.origin[0] = 150;
    ent.origin[1] = 0;
    ent.origin[2] = 0;
    ent.angles[0] = 0;
    ent.angles[1] = 0;
    ent.angles[2] = 0;
    ent.frame = 0;
    ent.skinnum = 0;
    ent.syncbase = 0;

    function render(enhanced: number): Uint8Array {
      setCvar(r_enhancedmodels, enhanced);
      vid.colormap = identityColormap();
      vid.fullbright = 256;
      setCvar(r_clearcolor, CLEARCOLOR);

      softRenderer.D_FlushCaches();
      rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
      const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
      softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

      ent.colormap = vid.colormap;
      cl_visedicts[0] = ent;
      clState.cl_numvisedicts = 1;

      const vrectin = new VrectT();
      vrectin.width = vid.width;
      vrectin.height = vid.height;
      r_refdef.fov_x = 90;
      r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
      scrState.sb_lines = 0;
      R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

      r_refdef.vieworg[0] = 0;
      r_refdef.vieworg[1] = 0;
      r_refdef.vieworg[2] = 0;
      r_refdef.viewangles[0] = 0;
      r_refdef.viewangles[1] = 0;
      r_refdef.viewangles[2] = 0;

      const buffer = vid.buffer;
      if (!buffer) return new Uint8Array(0);
      buffer.fill(0);
      R_RenderView();
      clState.cl_numvisedicts = 0;

      const vrect = r_refdef.vrect;
      const out = new Uint8Array(vrect.width * vrect.height);
      for (let row = 0; row < vrect.height; row++) {
        const src = (vrect.y + row) * vid.rowbytes + vrect.x;
        out.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
      }
      return out;
    }

    const md5Pixels = render(1);
    const classicPixels = render(0);

    const md5Box = boundingBoxOf(md5Pixels, r_refdef.vrect.width, r_refdef.vrect.height, CLEARCOLOR);
    const classicBox = boundingBoxOf(classicPixels, r_refdef.vrect.width, r_refdef.vrect.height, CLEARCOLOR);

    expect(md5Box.count).toBeGreaterThan(0);
    expect(classicBox.count).toBeGreaterThan(0);

    // bounding boxes overlap (the MD5 replacement is built to match the
    // .mdl it replaces, so both should occupy roughly the same screen area,
    // not disjoint corners of the frame)
    const overlaps = md5Box.minX <= classicBox.maxX && md5Box.maxX >= classicBox.minX && md5Box.minY <= classicBox.maxY && md5Box.maxY >= classicBox.minY;
    expect(overlaps).toBe(true);
  });
});
