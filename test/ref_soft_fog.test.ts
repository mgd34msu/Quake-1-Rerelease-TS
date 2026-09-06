// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U27's src/ref_soft/r_fog.ts: the software renderer's depth-post-pass
fog (ARCHITECTURE.md's "Renderers" section: "fog as a depth post-pass"), and
the software half of the renderer seam's fog/skybox members
(src/client/render.ts's Renderer.fogParseServerMessage/fogParseWorldspawn/
skyLoadSkyBox, wired in src/ref_soft/ref_soft.ts and src/ref_soft/r_main.ts).

What each group proves:
  - Fog_ParseServerMessage/Fog_ParseWorldspawn/Fog_Update/the 'fog' console
    command reuse gl_fog.ts's own logic (r_fog.ts's header explains why the
    state is duplicated rather than shared) -- covered at the same level of
    detail test/ref_gl_fog.test.ts already covers the GL twin at, not
    exhaustively re-proven line by line.
  - Fog_Init does not register a global 'fog' console command (r_fog.ts's
    header explains why, empirically, and this is the fix for the collision
    this unit found against test/ref_gl_fog.test.ts).
  - the seam members exist on softRenderer and forward to r_fog.ts/r_main.ts.
  - Fog_PostPass against a real rendered frame of a synthetic BSP: density 0
    leaves the frame byte-for-byte unchanged; a dense fog moves a far
    surface's pixels toward the fog color more than a near surface's,
    monotonic with the reconstructed depth; the 8-bit palette path is
    unaffected (this unit's documented decision -- see r_fog.ts's header).
  - guarded real data: an mg1 map whose worldspawn carries a "fog" key
    renders headless at 320x200 in true color with the far pixels fogged.

Self-sufficient per standing order 13: this file initializes the filesystem,
the renderer, the video mode and every cvar it reads, and restores every
process-wide singleton it touches (vid.*, d_8to24table, vidBackend.current,
re.current, rState.*, the model-loader hooks, the platform renderer registry,
scrState, cl/clState, cl_lightstyle[0], d_lightstylevalue[0], qw.active,
r_fog.ts's module-private fog_* state via Fog_ParseWorldspawn("") in
afterAll, softSkyBoxState).
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { Cmd_Exists, Cmd_TokenizeString } from "../src/common/cmd";
import { Mod_ClearAll, Mod_ForName, Mod_Init, type ModelT, getModelLoaderHooks, setModelLoaderHooks } from "../src/common/model";
import { hostClientHooks } from "../src/common/host";
import { qw } from "../src/common/quakedef";
import { cl, cl_entities, cl_lightstyle, clState } from "../src/client/client";
import { r_refdef, re } from "../src/client/render";
import { VID_GRADES, d_8to24table, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer } from "../src/platform/vid";
import { softRenderer } from "../src/ref_soft/ref_soft";
import { R_Init, R_NewMap, R_RenderView, R_ViewChanged, r_ambient, r_clearcolor, r_drawentities, r_drawflat, r_drawviewmodel, r_fullbright, softSkyBoxState } from "../src/ref_soft/r_main";
import { r_coloredlight } from "../src/ref_soft/r_coloredlight";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import { Fog_FogCommand_f, Fog_GetColor, Fog_GetDensity, Fog_Init, Fog_ParseServerMessage, Fog_ParseWorldspawn, Fog_Update, r_fog, r_skyfog } from "../src/ref_soft/r_fog";
import { BSP_FACE_LIGHTMAP_SAMPLES, BSP_NUMFACES, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { PakFile } from "./support/pak_reader";
import { listMaps, parseEntityLump, readEntityLumpText } from "./support/ent_lumps";

//============================================================================

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-fog-test-"));
const baseDir = join(scratchDir, "quake");

const MID_LIGHT = 128;
const RGB_BYTES = BSP_NUMFACES * BSP_FACE_LIGHTMAP_SAMPLES * 3;

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

// VID_GRADES rows of 256, row 0 the identity and row 63 all index 0, as in
// test/ref_soft_world_render.test.ts.
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

// distinct per-channel palette, as test/ref_soft_colored_light.test.ts's
// fillPaletteTable, so a rendered pixel's color is not a degenerate grey.
function fillPaletteTable(): void {
  for (let i = 0; i < 256; i++) {
    const r = i;
    const g = i >> 1;
    const b = i >> 2;
    d_8to24table[i] = ((255 << 24) + (r << 0) + (g << 8) + (b << 16)) >>> 0;
  }
}

function setCvar(cv: { string: string; value: number }, v: number): void {
  cv.string = String(v);
  cv.value = v;
}

function setMode(width: number, height: number): void {
  vid.width = width;
  vid.height = height;
  vid.rowbytes = width;
  vid.buffer = new Uint8Array(width * height);
  vid.buffer32 = new Uint32Array(width * height);
  vid.conbuffer = vid.buffer;
  vid.conrowbytes = width;
  vid.conwidth = width;
  vid.conheight = height;
  vid.maxwarpwidth = 320;
  vid.maxwarpheight = 200;
  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);
  vid.numpages = 1;
}

//============================================================================

let world: ModelT | null = null;

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
const savedBuffer32 = vid.buffer32;
const savedConbuffer = vid.conbuffer;
const savedConrowbytes = vid.conrowbytes;
const savedConwidth = vid.conwidth;
const savedConheight = vid.conheight;
const savedPalette = new Uint32Array(d_8to24table);
const savedBlockDrawing = scrState.block_drawing;
const savedSbLines = scrState.sb_lines;
const savedZbuffer = rState.d_pzbuffer;
const savedTruecolor = rState.r_truecolor;
const savedViewbuffer32 = rState.d_viewbuffer32;
const savedShiftramp = rState.d_shiftramp;
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
const savedRFog = { string: r_fog.string, value: r_fog.value };
const savedRSkyfog = { string: r_skyfog.string, value: r_skyfog.value };
const savedSkyBoxState = { name: softSkyBoxState.name, faces: [...softSkyBoxState.faces] };

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/refsoftfog.bsp", buildBsp({ lightLevel: MID_LIGHT }));

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
  setCvar(r_drawentities, 0);
  setCvar(r_drawviewmodel, 0);
  setCvar(r_coloredlight, 1);
  setCvar(r_fog, 1);
  setCvar(r_skyfog, 0.5);

  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  fillPaletteTable();
  setMode(320, 200);
  vid.colormap = realShapedColormap();
  vid.fullbright = 256;

  const mod = Mod_ForName("maps/refsoftfog.bsp", true);
  expect(mod).not.toBeNull();
  world = mod;
  cl.worldmodel = mod;
  cl_entities[0].model = mod;
  cl.viewentity = 0;
  cl.maxclients = 1;
  cl.intermission = 0;
  clState.cl_numvisedicts = 0;

  R_NewMap();
});

afterAll(() => {
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
  vid.buffer32 = savedBuffer32;
  vid.conbuffer = savedConbuffer;
  vid.conrowbytes = savedConrowbytes;
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  d_8to24table.set(savedPalette);
  rState.d_pzbuffer = savedZbuffer;
  rState.r_truecolor = savedTruecolor;
  rState.d_viewbuffer32 = savedViewbuffer32;
  rState.cacheblock32 = null;
  rState.d_shiftramp = savedShiftramp;
  qw.active = savedQwActive;
  cl_entities[0].model = null;
  cl.viewentity = 0;
  cl.maxclients = 0;
  cl.worldmodel = null;
  clState.cl_numvisedicts = 0;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;
  d_lightstylevalue[0] = savedLightstyleValue;
  Fog_ParseWorldspawn(""); // resets r_fog.ts's module-private fog_* state
  r_fog.string = savedRFog.string;
  r_fog.value = savedRFog.value;
  r_skyfog.string = savedRSkyfog.string;
  r_skyfog.value = savedRSkyfog.value;
  softSkyBoxState.name = savedSkyBoxState.name;
  softSkyBoxState.faces = savedSkyBoxState.faces;
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
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================

interface Frame {
  px32: Uint32Array;
  px8: Uint8Array;
  zbuf: Int16Array;
  width: number;
  height: number;
}

// every face's RGB light sample set to one flat grey -- forces
// rState.r_truecolor on (R_ColoredLightAvailable) without needing real
// per-channel color variation, since these tests care about DEPTH, not hue.
function setWorldRgbGrey(v: number): void {
  const bytes = new Uint8Array(RGB_BYTES);
  bytes.fill(v);
  if (world) world.lightdata_rgb = bytes;
}

/*
Renders one frame of the synthetic map from directly above its two 64-unit
quads (the same view test/ref_soft_world_render.test.ts and
test/ref_soft_colored_light.test.ts render), truecolor unless `truecolor` is
false.
*/
function renderFrame(clearcolor: number, truecolor: boolean): Frame {
  setWorldRgbGrey(truecolor ? 128 : 0);
  if (!truecolor && world) world.lightdata_rgb = null;

  setCvar(r_clearcolor, clearcolor);

  softRenderer.D_FlushCaches();
  rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
  const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
  softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

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
  const buffer32 = vid.buffer32;
  expect(buffer).not.toBeNull();
  expect(buffer32).not.toBeNull();
  if (!buffer || !buffer32) return { px32: new Uint32Array(0), px8: new Uint8Array(0), zbuf: new Int16Array(0), width: 0, height: 0 };
  buffer.fill(0);
  buffer32.fill(d_8to24table[clearcolor & 0xff]);

  R_RenderView();

  const vrect = r_refdef.vrect;
  const px32 = new Uint32Array(vrect.width * vrect.height);
  const px8 = new Uint8Array(vrect.width * vrect.height);
  const zbuf = new Int16Array(vrect.width * vrect.height);
  const zsrc = rState.d_pzbuffer;
  for (let row = 0; row < vrect.height; row++) {
    const src = (vrect.y + row) * vid.rowbytes + vrect.x;
    px32.set(buffer32.subarray(src, src + vrect.width), row * vrect.width);
    px8.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
    if (zsrc) zbuf.set(zsrc.subarray(src, src + vrect.width), row * vrect.width);
  }
  return { px32, px8, zbuf, width: vrect.width, height: vrect.height };
}

// picks the index of the closest (max positive zi) and farthest (min
// positive zi) real-geometry pixel in a frame's z-buffer -- see r_fog.ts's
// header on why only zi>0 is real depth.
function nearAndFarIndex(zbuf: Int16Array): { near: number; far: number } {
  let near = -1;
  let far = -1;
  let bestNear = -Infinity;
  let bestFar = Infinity;
  for (let i = 0; i < zbuf.length; i++) {
    const zi = zbuf[i];
    if (zi <= 0) continue;
    if (zi > bestNear) {
      bestNear = zi;
      near = i;
    }
    if (zi < bestFar) {
      bestFar = zi;
      far = i;
    }
  }
  return { near, far };
}

function channelDist(a: number, b: number): number {
  const ar = a & 0xff;
  const ag = (a >>> 8) & 0xff;
  const ab = (a >>> 16) & 0xff;
  const br = b & 0xff;
  const bg = (b >>> 8) & 0xff;
  const bb = (b >>> 16) & 0xff;
  return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
}

//============================================================================
// r_fog / r_skyfog cvars
//============================================================================

describe("r_fog / r_skyfog cvars", () => {
  test("r_fog defaults to 1, r_skyfog to 0.5", () => {
    expect(r_fog.value).toBe(1);
    expect(r_skyfog.value).toBe(0.5);
  });
});

//============================================================================
// Fog_ParseServerMessage / Fog_ParseWorldspawn / Fog_Update fade
//============================================================================

describe("Fog_ParseServerMessage", () => {
  test("normalizes the 0-255 density/rgb bytes and the centisecond time (no fade at time=0)", () => {
    cl.time = 5;
    Fog_ParseServerMessage(128, 255, 0, 64, 0); // wireTime 0 -> no fade
    expect(Fog_GetDensity()).toBeCloseTo(128 / 255, 4);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(1, 2);
    expect(c[1]).toBeCloseTo(0, 2);
    expect(c[2]).toBeCloseTo(64 / 255, 2);
  });

  test("a negative wire time clamps to 0 (takes effect immediately)", () => {
    cl.time = 10;
    Fog_ParseServerMessage(255, 0, 0, 0, -50);
    expect(Fog_GetDensity()).toBeCloseTo(1, 4);
  });
});

describe("Fog_ParseWorldspawn", () => {
  test('reads "density red green blue" from the "fog" key', () => {
    const ents = '{\n"classname" "worldspawn"\n"fog" "0.5 0.2 0.4 0.6"\n}\n';
    Fog_ParseWorldspawn(ents);
    expect(Fog_GetDensity()).toBeCloseTo(0.5, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(0.2, 2);
    expect(c[1]).toBeCloseTo(0.4, 2);
    expect(c[2]).toBeCloseTo(0.6, 2);
  });

  test('a worldspawn with no "fog" key resets to no fog', () => {
    Fog_ParseWorldspawn('{\n"classname" "worldspawn"\n"fog" "0.9 1 1 1"\n}\n');
    expect(Fog_GetDensity()).toBeCloseTo(0.9, 5);
    Fog_ParseWorldspawn('{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n}\n');
    expect(Fog_GetDensity()).toBe(0);
  });
});

describe("Fog_Update fade", () => {
  test("reads the exact midpoint of a fade", () => {
    cl.time = 0;
    Fog_Update(0, 0, 0, 0, 0); // known starting point: no fog
    cl.time = 10;
    Fog_Update(1.0, 1, 1, 1, 4); // fade to full white fog over 4 seconds

    cl.time = 12; // halfway
    expect(Fog_GetDensity()).toBeCloseTo(0.5, 4);
    const half = Fog_GetColor();
    expect(half[0]).toBeCloseTo(0.5, 1);

    cl.time = 14; // fade complete
    expect(Fog_GetDensity()).toBeCloseTo(1, 4);
  });
});

//============================================================================
// 'fog' console command
//============================================================================

describe("Fog_FogCommand_f", () => {
  test("no args prints the current values and does not change them", () => {
    cl.time = 0;
    Fog_Update(0.42, 0.1, 0.2, 0.3, 0);
    Cmd_TokenizeString("fog");
    Fog_FogCommand_f();
    expect(Fog_GetDensity()).toBeCloseTo(0.42, 5);
  });

  test("four args set density r g b together", () => {
    Cmd_TokenizeString("fog 0.9 1 0 0.5");
    Fog_FogCommand_f();
    expect(Fog_GetDensity()).toBeCloseTo(0.9, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(1, 2);
    expect(c[1]).toBeCloseTo(0, 2);
    expect(c[2]).toBeCloseTo(0.5, 2);
  });

  test("r/g/b clamp to [0,1] and density clamps to >=0", () => {
    Cmd_TokenizeString("fog -1 2 -2 3");
    Fog_FogCommand_f();
    expect(Fog_GetDensity()).toBe(0);
    const c = Fog_GetColor();
    expect(c[0]).toBe(1);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(1);
  });
});

describe("Fog_Init and the shared 'fog' console command name", () => {
  test("Fog_Init does not register a global 'fog' command (r_fog.ts's header explains why)", () => {
    // R_Init (called in this file's own beforeAll) has already run Fog_Init
    // at least once by the time this test runs. Calling it again here must
    // not touch the shared command table at all -- see r_fog.ts's header,
    // "THE 'fog' CONSOLE COMMAND": registering it, guarded or not, was proven
    // (empirically, verifying this unit) to steal the name away from
    // whichever renderer's OWN dedicated test suite runs later in the same
    // `bun test` process, since Cmd_AddCommand has no reclaim path outside a
    // real vid_ref switch. Fog_FogCommand_f is still fully implemented and
    // directly callable, as every other test in this file does.
    const before = Cmd_Exists("fog");
    Fog_Init();
    expect(Cmd_Exists("fog")).toBe(before);
  });
});

//============================================================================
// seam members (src/client/render.ts's Renderer.fogParseServerMessage/
// fogParseWorldspawn/skyLoadSkyBox)
//============================================================================

describe("softRenderer seam members", () => {
  test("fogParseServerMessage/fogParseWorldspawn/skyLoadSkyBox exist and forward", () => {
    expect(typeof softRenderer.fogParseServerMessage).toBe("function");
    expect(typeof softRenderer.fogParseWorldspawn).toBe("function");
    expect(typeof softRenderer.skyLoadSkyBox).toBe("function");

    cl.time = 0;
    softRenderer.fogParseServerMessage?.(255, 0, 128, 0, 0);
    expect(Fog_GetDensity()).toBeCloseTo(1, 4);
    const c = Fog_GetColor();
    expect(c[1]).toBeCloseTo(128 / 255, 2);

    softRenderer.fogParseWorldspawn?.('{\n"classname" "worldspawn"\n"fog" "0.3 0 0 0"\n}\n');
    expect(Fog_GetDensity()).toBeCloseTo(0.3, 5);

    // no gfx/env/ faces on disk in this test's gamedir -- keeps the skybox
    // cleared, but must not throw (this unit's "load and keep" fallback --
    // see r_main.ts's SOFTWARE SKYBOX LOADING section).
    expect(() => softRenderer.skyLoadSkyBox?.("nonexistent_skybox_name")).not.toThrow();
    expect(softSkyBoxState.name).toBe("");
  });
});

//============================================================================
// Fog_PostPass against a real rendered frame
//============================================================================

describe("Fog_PostPass", () => {
  afterAll(() => {
    Fog_ParseWorldspawn(""); // back to no fog for later describes
  });

  test("density 0 leaves the true-color frame byte-for-byte unchanged", () => {
    Fog_ParseWorldspawn("");
    const noFog = renderFrame(2, true);

    Fog_Update(0, 0.9, 0.9, 0.9, 0); // density 0, but a real (unused) color
    const stillNoFog = renderFrame(2, true);

    expect(stillNoFog.px32).toEqual(noFog.px32);
  });

  test("a dense fog moves the far surface's pixels toward the fog color more than the near surface's", () => {
    Fog_ParseWorldspawn("");
    const before = renderFrame(2, true);
    const { near, far } = nearAndFarIndex(before.zbuf);
    expect(near).toBeGreaterThanOrEqual(0);
    expect(far).toBeGreaterThanOrEqual(0);
    // a real depth spread to fog against -- otherwise this synthetic view
    // has nothing to prove monotonicity with
    expect(before.zbuf[near]).toBeGreaterThan(before.zbuf[far]);

    Fog_Update(0.05, 1, 0, 0, 0); // dense red fog, no fade
    const after = renderFrame(2, true);

    const nearDelta = channelDist(before.px32[near], after.px32[near]);
    const farDelta = channelDist(before.px32[far], after.px32[far]);

    expect(farDelta).toBeGreaterThan(nearDelta);
    expect(farDelta).toBeGreaterThan(0);
  });

  test("r_fog 0 is a general off switch regardless of density", () => {
    Fog_Update(0.05, 1, 0, 0, 0);
    const fogged = renderFrame(2, true);

    setCvar(r_fog, 0);
    const unfogged = renderFrame(2, true);
    setCvar(r_fog, 1);

    expect(unfogged.px32).not.toEqual(fogged.px32);
  });

  test("the 8-bit palette path is left unchanged (this unit's documented decision)", () => {
    Fog_Update(0, 0, 0, 0, 0);
    const noFog = renderFrame(2, false);
    expect(rState.r_truecolor).toBe(false);

    Fog_Update(0.05, 1, 0, 0, 0);
    const withDenseFog = renderFrame(2, false);
    expect(rState.r_truecolor).toBe(false);

    expect(withDenseFog.px8).toEqual(noFog.px8);

    Fog_Update(0, 0, 0, 0, 0);
  });
});

//============================================================================
// Guarded real data: an mg1 map whose worldspawn carries a "fog" key.
//============================================================================

const RERELEASE_DIR = process.env.Q1TS_RERELEASE ?? "/home/buzzkill/Projects/qfiles/q1/rerelease";
const MG1_PAK = join(RERELEASE_DIR, "mg1", "pak0.pak");
const HAVE_MG1 = existsSync(MG1_PAK) && existsSync(join(RERELEASE_DIR, "id1", "pak0.pak"));

function findMg1FogMap(): { mapPath: string; density: number } | null {
  const pak = new PakFile(MG1_PAK);
  for (const mapPath of listMaps(pak)) {
    const ents = parseEntityLump(readEntityLumpText(pak, mapPath));
    const worldspawn = ents.find((e) => e.get("classname") === "worldspawn");
    const fogValue = worldspawn?.get("fog");
    if (fogValue === undefined) continue;
    const density = Number.parseFloat(fogValue.trim().split(/\s+/)[0] ?? "0");
    if (density > 0) return { mapPath, density };
  }
  return null;
}

describe.skipIf(!HAVE_MG1)("mg1's real fog data (skipped when absent, e.g. on CI)", () => {
  afterAll(() => {
    Mod_ClearAll();
    setComSearchpaths(null);
    Fog_ParseWorldspawn("");
  });

  test("a real mg1 map's worldspawn fog key fogs the far pixels of a headless 320x200 true-color render", () => {
    const found = findMg1FogMap();
    expect(found).not.toBeNull();
    if (!found) return;

    setComSearchpaths(null);
    COM_InitArgv(["quake", "-basedir", RERELEASE_DIR, "-game", "mg1"]);
    setComModified(false);
    COM_InitFilesystem();
    COM_CheckRegistered();

    const mapName = found.mapPath.slice("maps/".length, -".bsp".length);
    const mod = Mod_ForName(found.mapPath, true);
    expect(mod).not.toBeNull();
    if (!mod) return;

    cl.worldmodel = mod;
    cl_entities[0].model = mod;
    setCvar(r_coloredlight, 1);
    R_NewMap();

    // the map's own worldspawn fog key, parsed by R_NewMap's
    // Fog_ParseWorldspawn call -- not something this test sets by hand.
    expect(Fog_GetDensity()).toBeCloseTo(found.density, 3);

    setMode(320, 200);
    vid.colormap = realShapedColormap();
    vid.fullbright = 256;

    softRenderer.D_FlushCaches();
    rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
    const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
    softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

    const vrectin = new VrectT();
    vrectin.width = vid.width;
    vrectin.height = vid.height;
    r_refdef.fov_x = 90;
    r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
    scrState.sb_lines = 0;
    R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

    // this map's own info_player_start, so the camera sits in real,
    // navigable space instead of an arbitrary point that might be solid.
    const pak = new PakFile(MG1_PAK);
    const ents = parseEntityLump(readEntityLumpText(pak, found.mapPath));
    const start = ents.find((e) => e.get("classname") === "info_player_start");
    const originStr = start?.get("origin") ?? "0 0 32";
    const [ox, oy, oz] = originStr.trim().split(/\s+/).map(Number.parseFloat);
    r_refdef.vieworg[0] = ox ?? 0;
    r_refdef.vieworg[1] = oy ?? 0;
    r_refdef.vieworg[2] = (oz ?? 0) + 22; // roughly eye height above the origin
    const angleStr = start?.get("angle") ?? "0";
    r_refdef.viewangles[0] = 0;
    r_refdef.viewangles[1] = Number.parseFloat(angleStr) || 0;
    r_refdef.viewangles[2] = 0;

    const buffer32 = vid.buffer32;
    expect(buffer32).not.toBeNull();
    if (!buffer32) return;
    const buf = buffer32;

    // one render with the map's own real fog (already parsed by R_NewMap
    // above), one with fog forced off, same view -- so any pixel difference
    // is Fog_PostPass's doing, not a coincidence of the scene.
    function renderOnce(): { px32: Uint32Array; zbuf: Int16Array } {
      softRenderer.D_FlushCaches();
      rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
      const cs = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
      softRenderer.D_InitCaches(new Uint8Array(cs), cs);
      buf.fill(d_8to24table[0]);
      R_RenderView();
      const vrect = r_refdef.vrect;
      const px32 = new Uint32Array(vrect.width * vrect.height);
      const zbuf = new Int16Array(vrect.width * vrect.height);
      const zsrc = rState.d_pzbuffer;
      for (let row = 0; row < vrect.height; row++) {
        const src = (vrect.y + row) * vid.rowbytes + vrect.x;
        px32.set(buf.subarray(src, src + vrect.width), row * vrect.width);
        if (zsrc) zbuf.set(zsrc.subarray((vrect.y + row) * rState.d_zwidth + vrect.x, (vrect.y + row) * rState.d_zwidth + vrect.x + vrect.width), row * vrect.width);
      }
      return { px32, zbuf };
    }

    const fogged = renderOnce();
    expect(rState.r_truecolor).toBe(true);

    const entityText = readEntityLumpText(pak, found.mapPath);
    Fog_Update(0, 0, 0, 0, 0); // force fog off, same map/view
    const unfogged = renderOnce();
    Fog_ParseWorldspawn(entityText); // restore the map's own fog for afterAll's reset to be a no-op either way

    const { near, far } = nearAndFarIndex(fogged.zbuf);
    expect(far).toBeGreaterThanOrEqual(0);
    expect(near).toBeGreaterThanOrEqual(0);

    const farDelta = channelDist(fogged.px32[far], unfogged.px32[far]);
    const nearDelta = channelDist(fogged.px32[near], unfogged.px32[near]);

    expect(farDelta).toBeGreaterThan(0);
    expect(farDelta).toBeGreaterThanOrEqual(nearDelta);

    console.log(`mg1 fog map: ${mapName}, density ${found.density}, far-pixel delta ${farDelta}, near-pixel delta ${nearDelta}`);
  }, 30_000);
});
