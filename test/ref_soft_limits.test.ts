// Force headless SDL before ANY import can reach the FFI layer -- see
// test/ref_soft_world_render.test.ts's own copy of this comment.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
U14: the software renderer stops rejecting re-release content.
  - blocklights is sized from MAX_SURFACE_EXTENTS, not the WinQuake-fixed
    18*18 (a 256-texel-extents-only size).
  - D_SCAlloc's sanity bounds (cache width, cache size) are re-derived from
    MAX_SURFACE_EXTENTS instead of the old 256/0x10000 pair.
  - r_surf.ts's R_DrawSurface reads a texture's mip dimensions with mipDim
    (floor-and-minimum-1), matching how model.ts's Mod_LoadTextures now
    generates them, instead of a plain shift that can hit zero.

The in-process render test below follows test/ref_soft_world_render.test.ts's
own harness (R_Init/R_NewMap/R_RenderView against a synthetic BSP through a
fake VidBackend) rather than a real Sys_Main_Init boot: sweep_driver.ts's own
header explains why a second real engine boot in the same process is never
clean, so a synthetic in-process case belongs at the R_RenderView layer, the
same layer test/ref_soft_world_render.test.ts already exercises. The retail
"thordetrime" case, which does need a real listen-server boot, runs as its
own subprocess instead (test/support/sweep_driver.ts, via sweep_lib.ts's
runOneJob) -- the actual "headless boot" sense of the word, gated on
Q1TS_DATA.

Self-sufficient per standing order 13: this file initializes the filesystem,
the renderer, the video mode and every cvar it reads, and restores every
process-wide singleton it touches (vid.*, vidBackend.current, re.current,
rState.d_pzbuffer, the model-loader hooks, the platform renderer registry,
scrState, cl/clState, cl_lightstyle[0], d_lightstylevalue[0], dState).
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { hostClientHooks } from "../src/common/host";
import { qw } from "../src/common/quakedef";
import { cl, cl_entities, cl_lightstyle, clState } from "../src/client/client";
import { r_refdef, re } from "../src/client/render";
import { vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer } from "../src/platform/vid";
import { softRenderer } from "../src/ref_soft/ref_soft";
import { R_Init, R_NewMap, R_RenderView, R_ViewChanged, r_ambient, r_clearcolor, r_drawentities, r_drawflat, r_drawviewmodel, r_fullbright } from "../src/ref_soft/r_main";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import { blocklights } from "../src/ref_soft/r_surf";
import { r_drawsurf } from "../src/ref_soft/d_iface";
import { dState, GUARDSIZE, SurfcacheT } from "../src/ref_soft/d_local";
import { D_InitCaches, D_SCAlloc } from "../src/ref_soft/d_surf";
import { SysError } from "../src/platform/sys";
import { MAX_SURFACE_EXTENTS } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { HAVE_DATA } from "./support/fixture_availability";
import { rereleaseConfigs, runOneJob, type SweepJobT } from "./support/sweep_lib";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-limits-test-"));
const baseDir = join(scratchDir, "quake");

//============================================================================

describe("blocklights", () => {
  test("is sized from MAX_SURFACE_EXTENTS, not the WinQuake-fixed 18*18", () => {
    const perSide = (MAX_SURFACE_EXTENTS >> 4) + 2;
    expect(blocklights.length).toBe(perSide * perSide);
    // covers every (smax, tmax) CalcSurfaceExtents can ever hand R_BuildLightMap:
    // the largest a non-TEX_SPECIAL extent can be is MAX_SURFACE_EXTENTS, so
    // the largest smax/tmax is (MAX_SURFACE_EXTENTS>>4)+1.
    const maxIndexNeeded = ((MAX_SURFACE_EXTENTS >> 4) + 1) * ((MAX_SURFACE_EXTENTS >> 4) + 1) - 1;
    expect(maxIndexNeeded).toBeLessThan(blocklights.length);
  });
});

describe("D_SCAlloc: bounds raised from 256/0x10000 to MAX_SURFACE_EXTENTS", () => {
  const savedDState = { ...dState };

  afterAll(() => {
    dState.sc_heap = savedDState.sc_heap;
    dState.sc_base = savedDState.sc_base;
    dState.sc_rover = savedDState.sc_rover;
    dState.sc_size = savedDState.sc_size;
    dState.d_initial_rover = savedDState.d_initial_rover;
    dState.d_roverwrapped = savedDState.d_roverwrapped;
    dState.r_cache_thrash = savedDState.r_cache_thrash;
    dState.surfscale = savedDState.surfscale;
  });

  test("a cache width of exactly MAX_SURFACE_EXTENTS is accepted", () => {
    const heapSize = MAX_SURFACE_EXTENTS + 4096;
    D_InitCaches(new Uint8Array(heapSize), heapSize);
    const block = D_SCAlloc(MAX_SURFACE_EXTENTS, MAX_SURFACE_EXTENTS);
    expect(block).toBeInstanceOf(SurfcacheT);
    expect(block.width).toBe(MAX_SURFACE_EXTENTS);
  });

  test("a cache width past MAX_SURFACE_EXTENTS still throws (the bound moved, it did not disappear)", () => {
    const heapSize = MAX_SURFACE_EXTENTS * 2 + 4096;
    D_InitCaches(new Uint8Array(heapSize), heapSize);
    expect(() => D_SCAlloc(MAX_SURFACE_EXTENTS + 1, 4)).toThrow(SysError);
    expect(() => D_SCAlloc(MAX_SURFACE_EXTENTS + 1, 4)).toThrow(/bad cache width/);
  });

  test("a cache size of MAX_SURFACE_EXTENTS^2 is accepted when the heap is big enough", () => {
    const size = MAX_SURFACE_EXTENTS * MAX_SURFACE_EXTENTS;
    const heapSize = size + GUARDSIZE + 64;
    D_InitCaches(new Uint8Array(heapSize), heapSize);
    const block = D_SCAlloc(1, size);
    expect(block.data.length).toBeGreaterThanOrEqual(size);
  });

  test("a cache size past MAX_SURFACE_EXTENTS^2 still throws", () => {
    const heapSize = 4096;
    D_InitCaches(new Uint8Array(heapSize), heapSize);
    expect(() => D_SCAlloc(1, MAX_SURFACE_EXTENTS * MAX_SURFACE_EXTENTS + 1)).toThrow(SysError);
    expect(() => D_SCAlloc(1, MAX_SURFACE_EXTENTS * MAX_SURFACE_EXTENTS + 1)).toThrow(/bad cache size/);
  });
});

//============================================================================
// A 24x40 (not 16-aligned) world texture through the actual R_RenderView
// pipeline: D_CacheSurface -> R_DrawSurface -> R_BuildLightMap ->
// R_DrawSurfaceBlock8_mipN, all reading real texture/mip data through
// r_surf.ts's mipDim-based smax/tmax/texwidth. A pre-fix engine either threw
// in Mod_LoadTextures (16-alignment Sys_Error) or read past/short of the
// real mip data (the width*height/64*85 shortcut is wrong for 24x40's height
// component... it happens to be exact for 24x40 specifically, since both
// dimensions are multiples of 8; the point of this test is that the whole
// pipeline runs end to end with an odd-sized texture with no throw).

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

function flatColormap(): Uint8Array {
  // every colormap row is the identity: whatever the surface cache draws
  // reaches the framebuffer unchanged, so a non-clearcolor pixel proves a
  // real texel (not just ambient light) got through.
  const cm = new Uint8Array(256 * 64);
  for (let i = 0; i < cm.length; i++) cm[i] = i & 0xff;
  return cm;
}

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

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/oddworld.bsp", buildBsp({ lightLevel: 128, miptexWidth: 24, miptexHeight: 40 }));

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

  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  setMode320x200();

  const mod = Mod_ForName("maps/oddworld.bsp", true);
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
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  rState.d_pzbuffer = savedZbuffer;
  qw.active = savedQwActive;
  cl_entities[0].model = null;
  cl.viewentity = 0;
  cl.maxclients = 0;
  cl.worldmodel = null;
  clState.cl_numvisedicts = 0;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;
  d_lightstylevalue[0] = savedLightstyleValue;
  r_drawsurf.clear();
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

function renderFrame(): Uint8Array {
  vid.colormap = flatColormap();
  vid.fullbright = 256;
  setCvar(r_clearcolor, 2);

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
  expect(buffer).not.toBeNull();
  if (!buffer) return new Uint8Array(0);
  buffer.fill(0);

  R_RenderView();

  const vrect = r_refdef.vrect;
  const out = new Uint8Array(vrect.width * vrect.height);
  for (let row = 0; row < vrect.height; row++) {
    const src = (vrect.y + row) * vid.rowbytes + vrect.x;
    out.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
  }
  return out;
}

describe("R_RenderView against a world whose only texture is 24x40", () => {
  test("renders a full frame with no throw and draws textured pixels", () => {
    expect(world).not.toBeNull();
    let pixels: Uint8Array = new Uint8Array(0);
    expect(() => {
      pixels = renderFrame();
    }).not.toThrow();

    const seen = new Set<number>();
    for (const p of pixels) seen.add(p);
    // more than one distinct value: some pixel came from the textured/lit
    // surface, not only the flat r_clearcolor background
    expect(seen.size).toBeGreaterThan(1);
  });
});

//============================================================================
// The retail "thordetrime" case: horde2.bsp (rerelease/mg1, BSP2) has a
// world texture the pre-fix loader rejected outright ("Texture thordetrime
// is not 16 aligned"). This needs a real listen-server boot -- not the
// R_RenderView harness above -- so it runs as its own subprocess exactly the
// way the coordinator's sweep does (test/support/sweep_driver.ts via
// sweep_lib.ts's runOneJob), gated on Q1TS_DATA.

describe.skipIf(!HAVE_DATA)("retail: rerelease/mg1 horde2 (thordetrime) through the default (software) renderer", () => {
  test("boots to ss_active with none of the U14 crash classes", async () => {
    const dataDir = process.env.Q1TS_DATA;
    if (dataDir === undefined) throw new Error("HAVE_DATA true but Q1TS_DATA unset");

    const cfg = rereleaseConfigs(dataDir).find((c) => c.label === "rerelease/mg1");
    if (cfg === undefined) throw new Error("expected a rerelease/mg1 config");

    const job: SweepJobT = {
      gamedir: cfg.label,
      basedir: cfg.basedir,
      extraArgs: cfg.extraArgs,
      map: "horde2",
      bspVersion: "BSP2",
    };

    const outDir = mkdtempSync(join(scratchRoot, "ref-soft-limits-sweep-"));
    try {
      const record = await runOneJob(job, outDir, { frames: 20, dt: 0.05 });

      expect(record.console.texture_not_16_aligned).toEqual([]);
      expect(record.console.mod_numknown_overflow).toEqual([]);
      expect(record.console.bad_surface_extents).toEqual([]);
      expect(record.console.range_error).toEqual([]);
      expect(record.error).toBeNull();
      expect(record.reached_active).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
