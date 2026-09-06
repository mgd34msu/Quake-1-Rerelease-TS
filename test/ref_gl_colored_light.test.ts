// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U15's colored-lighting additions to src/ref_gl/gl_rsurf.ts
(blocklights/R_AddDynamicLights/R_BuildLightMap/GL_BuildLightmaps/
GL_CreateSurfaceLightmap) and src/ref_gl/gl_rlight.ts (RecursiveLightPoint/
R_LightPoint/lightcolor), against `mod.lightdata_rgb` (a `.lit` file's
samples, per src/common/model.ts's Mod_LoadLighting) and the new
gl_coloredlight cvar (glquake.ts).

Self-sufficient per standing order 13: every shared singleton this file
writes (qglHolder.current, cl.worldmodel, cl.model_precache, blocklights,
allocated/lightmaps/glRsurfState via GL_ClearLightmapState, d_lightstylevalue,
glState.r_framecount, cl_dlights, gl_coloredlight, gl_texsort, and
glDrawState.gl_lightmap_format) is saved in beforeAll and restored in
afterAll per standing order 15.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import {
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  pop,
  setComModified,
  setComSearchpaths,
} from "../src/common/common";
import { Mod_ClearAll, Mod_ForName, Mod_Init, ModelT, MsurfaceT, MtexinfoT, setModelLoaderHooks } from "../src/common/model";
import { MplaneT } from "../src/common/mathlib";
import { buildBsp, BSP_FACE_LIGHTMAP_SAMPLES, BSP_NUMFACES, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { cl, cl_dlights, MAX_DLIGHTS } from "../src/client/client";
import { BLOCK_HEIGHT, BLOCK_WIDTH, d_lightstylevalue, gl_coloredlight, glState } from "../src/ref_gl/glquake";
import { GL_LUMINANCE, GL_RGBA, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { glDrawState } from "../src/ref_gl/gl_draw";
import { gl_texsort } from "../src/ref_gl/gl_rmain";
import * as glDraw from "../src/ref_gl/gl_draw";
import { glModelHooks } from "../src/ref_gl/gl_model";
import {
  AllocBlock,
  GL_BuildLightmaps,
  GL_ClearLightmapState,
  GL_CreateSurfaceLightmap,
  R_AddDynamicLights,
  R_BuildLightMap,
  allocated,
  blocklights,
  glRsurfState,
} from "../src/ref_gl/gl_rsurf";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "refgl-colored-light-test-"));
const baseDir = join(scratchDir, "quake");

const MAP = "maps/refglcoloredlight.bsp";

// 'm' is lightstyle 0's normal value: ('m' - 'a') * 22, as R_AnimateLight
// computes it (test/ref_gl_rsurf_world_light.test.ts's own constant).
const NORMAL_LIGHT_SCALE = 264;

const saved = {
  qgl: qglHolder.current,
  worldmodel: cl.worldmodel,
  modelPrecache: cl.model_precache.slice(),
  lightmapFormat: glDrawState.gl_lightmap_format,
  framecount: glState.r_framecount,
  lightstyles: new Int32Array(256),
  coloredlight: { value: gl_coloredlight.value, string: gl_coloredlight.string },
  texsort: { value: gl_texsort.value, string: gl_texsort.string },
  dlights: cl_dlights.map((l) => ({ origin: [l.origin[0], l.origin[1], l.origin[2]], radius: l.radius, die: l.die, minlight: l.minlight })),
};

beforeAll(() => {
  saved.lightstyles.set(d_lightstylevalue);

  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, `id1/${MAP}`, buildBsp({ lightLevel: 128 }));

  // gfx/pop.lmp inside id1/pak0.pak: without it COM_CheckRegistered leaves
  // shareware mode on and COM_FindFile never searches loose slash paths.
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
});

afterAll(() => {
  SetQGL(saved.qgl);
  setModelLoaderHooks(null);
  cl.worldmodel = saved.worldmodel;
  for (let i = 0; i < cl.model_precache.length; i++) cl.model_precache[i] = saved.modelPrecache[i];
  glDrawState.gl_lightmap_format = saved.lightmapFormat;
  glState.r_framecount = saved.framecount;
  d_lightstylevalue.set(saved.lightstyles);
  gl_coloredlight.value = saved.coloredlight.value;
  gl_coloredlight.string = saved.coloredlight.string;
  gl_texsort.value = saved.texsort.value;
  gl_texsort.string = saved.texsort.string;
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    cl_dlights[i].origin[0] = saved.dlights[i].origin[0];
    cl_dlights[i].origin[1] = saved.dlights[i].origin[1];
    cl_dlights[i].origin[2] = saved.dlights[i].origin[2];
    cl_dlights[i].radius = saved.dlights[i].radius;
    cl_dlights[i].die = saved.dlights[i].die;
    cl_dlights[i].minlight = saved.dlights[i].minlight;
  }
  blocklights.fill(0);
  GL_ClearLightmapState();
});

beforeEach(() => {
  blocklights.fill(0);
  glState.r_framecount = 1;
  d_lightstylevalue.fill(0);
  d_lightstylevalue[0] = NORMAL_LIGHT_SCALE;
  gl_coloredlight.value = 1;
  gl_coloredlight.string = "1";
});

// Reproduces test/ref_gl_rsurf_world_light.test.ts's fixtureSurface (four
// luxels, one lightstyle, dlightframe disabled) plus a `.lit`-shaped RGB
// sample block whose R channel matches that file's grey samples exactly.
function coloredFixture(): { surf: MsurfaceT; world: ModelT } {
  const surf = new MsurfaceT();
  surf.extents[0] = 16; // smax = 2
  surf.extents[1] = 16; // tmax = 2
  surf.styles[0] = 0;
  surf.styles[1] = 255;
  surf.dlightframe = -1;
  surf.samples = new Uint8Array([53, 106, 134, 0]);
  surf.lightofs = 0;

  const world = new ModelT();
  world.lightdata = new Uint8Array(16);
  // luxel0 (10,20,30), luxel1 (40,50,60), luxel2 (70,80,90), luxel3 (0,0,0):
  // three distinct, non-equal channels per luxel, so a channel mixup would
  // be caught immediately.
  world.lightdata_rgb = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 0, 0, 0]);
  return { surf, world };
}

describe("R_BuildLightMap (colored)", () => {
  test("blocklights scales each channel independently by the lightstyle value", () => {
    const { surf, world } = coloredFixture();
    cl.worldmodel = world;
    d_lightstylevalue[0] = 256; // 8.8 fixed-point 1.0, for round numbers

    const stride = BLOCK_WIDTH * 4;
    const dest = new Uint8Array(stride * 4);
    R_BuildLightMap(surf, dest, 0, stride);

    // blocklights is r,g,b interleaved per luxel (index*3 + channel);
    // scale 256 (1.0 in 8.8) means blocklights[i] === sample*256 exactly.
    expect(blocklights[0]).toBe(10 * 256);
    expect(blocklights[1]).toBe(20 * 256);
    expect(blocklights[2]).toBe(30 * 256);
    expect(blocklights[3]).toBe(40 * 256);
    expect(blocklights[4]).toBe(50 * 256);
    expect(blocklights[5]).toBe(60 * 256);
    expect(blocklights[6]).toBe(70 * 256);
    expect(blocklights[7]).toBe(80 * 256);
    expect(blocklights[8]).toBe(90 * 256);
  });

  test("writes uninverted RGB (not the classic invert trick) with opaque alpha", () => {
    const { surf, world } = coloredFixture();
    cl.worldmodel = world;
    d_lightstylevalue[0] = 256;

    const stride = BLOCK_WIDTH * 4;
    const dest = new Uint8Array(stride * 4);
    R_BuildLightMap(surf, dest, 0, stride);

    // t >>= 7 with scale 256 is just sample*2 -- no clamping, no inversion.
    expect(Array.from(dest.slice(0, 4))).toEqual([20, 40, 60, 255]);
    expect(Array.from(dest.slice(4, 8))).toEqual([80, 100, 120, 255]);
    expect(Array.from(dest.slice(stride, stride + 4))).toEqual([140, 160, 180, 255]);
    // luxel3 is black, but still gets the forced-opaque alpha.
    expect(Array.from(dest.slice(stride + 4, stride + 8))).toEqual([0, 0, 0, 255]);
  });

  test("gl_coloredlight 0 forces the classic grey path even when the map has real RGB data", () => {
    const { surf, world } = coloredFixture();
    cl.worldmodel = world;
    d_lightstylevalue[0] = NORMAL_LIGHT_SCALE;
    glDrawState.gl_lightmap_format = GL_LUMINANCE;
    gl_coloredlight.value = 0;
    gl_coloredlight.string = "0";

    const dest = new Uint8Array(BLOCK_WIDTH * 4);
    R_BuildLightMap(surf, dest, 0, BLOCK_WIDTH);

    // identical to test/ref_gl_rsurf_world_light.test.ts's GL_LUMINANCE
    // assertions for the same grey samples and lightstyle scale, proving the
    // (genuinely different) RGB data was never read.
    expect(dest[0]).toBe(146);
    expect(dest[1]).toBe(37);
    expect(dest[BLOCK_WIDTH + 0]).toBe(0);
    expect(dest[BLOCK_WIDTH + 1]).toBe(255);
  });

  test("an RGB lump with equal channels accumulates identically to the grey 8-bit path", () => {
    // A monochrome `.lit` still routes through the colored branch (RGB data
    // exists, so gl_coloredlight decides on presence, not on whether the
    // data happens to be grey) -- but the ACCUMULATOR it produces must be
    // the exact expansion the grey-only path already computes for the same
    // sample bytes, checked here at the blocklights level since the two
    // paths' final byte layouts differ on purpose (uninverted RGBA vs the
    // classic invert-and-blend format, see gl_rsurf.ts's header note) and
    // are not directly comparable byte for byte.
    const greySamples = new Uint8Array([53, 106, 134, 0]);
    d_lightstylevalue[0] = NORMAL_LIGHT_SCALE;

    const worldGrey = new ModelT();
    worldGrey.lightdata = new Uint8Array(16);
    const surfGrey = new MsurfaceT();
    surfGrey.extents[0] = 16;
    surfGrey.extents[1] = 16;
    surfGrey.styles[0] = 0;
    surfGrey.styles[1] = 255;
    surfGrey.dlightframe = -1;
    surfGrey.samples = greySamples;
    surfGrey.lightofs = -1; // no rgb source at all

    cl.worldmodel = worldGrey;
    const greyDest = new Uint8Array(BLOCK_WIDTH * 4);
    R_BuildLightMap(surfGrey, greyDest, 0, BLOCK_WIDTH);
    const greyAccum = Array.from(blocklights.slice(0, 9));

    blocklights.fill(0);

    const worldColor = new ModelT();
    worldColor.lightdata = new Uint8Array(16);
    worldColor.lightdata_rgb = new Uint8Array([53, 53, 53, 106, 106, 106, 134, 134, 134, 0, 0, 0]);
    const surfColor = new MsurfaceT();
    surfColor.extents[0] = 16;
    surfColor.extents[1] = 16;
    surfColor.styles[0] = 0;
    surfColor.styles[1] = 255;
    surfColor.dlightframe = -1;
    surfColor.samples = greySamples;
    surfColor.lightofs = 0;

    cl.worldmodel = worldColor;
    const colorDest = new Uint8Array(BLOCK_WIDTH * 4 * 4);
    R_BuildLightMap(surfColor, colorDest, 0, BLOCK_WIDTH * 4);
    const colorAccum = Array.from(blocklights.slice(0, 9));

    expect(colorAccum).toEqual(greyAccum);
    // and within the colored run, all three channels of every luxel agree
    // with each other, since the source data was monochrome.
    for (let i = 0; i < 3; i++) {
      expect(blocklights[i * 3]).toBe(blocklights[i * 3 + 1]);
      expect(blocklights[i * 3 + 1]).toBe(blocklights[i * 3 + 2]);
    }
  });
});

describe("R_AddDynamicLights (colored)", () => {
  test("classic dlights stay white: the same contribution lands on all three channels", () => {
    const surf = new MsurfaceT();
    surf.extents[0] = 16; // smax = 2
    surf.extents[1] = 16; // tmax = 2
    surf.texturemins[0] = 0;
    surf.texturemins[1] = 0;
    surf.dlightbits = 1; // lit by dlight 0

    const texinfo = new MtexinfoT();
    texinfo.vecs[0].set([1, 0, 0, 0]);
    texinfo.vecs[1].set([0, 1, 0, 0]);
    surf.texinfo = texinfo;

    const plane = new MplaneT();
    plane.normal.set([0, 0, 1]);
    plane.dist = 0;
    surf.plane = plane;

    cl_dlights[0].origin[0] = 0;
    cl_dlights[0].origin[1] = 0;
    cl_dlights[0].origin[2] = 50;
    cl_dlights[0].radius = 100;
    cl_dlights[0].minlight = 0;

    R_AddDynamicLights(surf);

    // luxel (s=0,t=0): dist=0, add=(50-0)*256=12800
    expect(blocklights[0]).toBe(12800);
    expect(blocklights[1]).toBe(12800);
    expect(blocklights[2]).toBe(12800);
    // luxel (s=1,t=0): dist=16, add=(50-16)*256=8704
    expect(blocklights[3]).toBe(8704);
    expect(blocklights[4]).toBe(8704);
    expect(blocklights[5]).toBe(8704);
  });
});

describe("GL_CreateSurfaceLightmap / AllocBlock (re-release surface sizes)", () => {
  afterAll(() => {
    GL_ClearLightmapState();
  });

  test("a surface at 1600-unit extents (101x101 texels) allocates without a lightmap overflow", () => {
    glRsurfState.lightmap_bytes = 4;
    cl.worldmodel = null; // R_BuildLightMap's null-worldmodel branch: full bright, no accumulation needed

    const surf = new MsurfaceT();
    surf.extents[0] = 1600;
    surf.extents[1] = 1600;
    surf.styles.fill(255);
    surf.samples = null;
    surf.lightofs = -1;

    const smax = (surf.extents[0] >> 4) + 1;
    const tmax = (surf.extents[1] >> 4) + 1;
    expect(smax).toBe(101);
    expect(tmax).toBe(101);

    expect(() => GL_CreateSurfaceLightmap(surf)).not.toThrow();

    expect(surf.light_s + smax).toBeLessThanOrEqual(BLOCK_WIDTH);
    expect(surf.light_t + tmax).toBeLessThanOrEqual(BLOCK_HEIGHT);
  });

  test("AllocBlock rejects a surface as wide as the block itself (the C's `i < BLOCK_WIDTH - w` never runs)", () => {
    expect(() => AllocBlock(BLOCK_WIDTH, 1, { x: 0, y: 0 })).toThrow();
    allocated.fill(0);
  });
});

describe("GL_BuildLightmaps end-to-end (QGLRecording)", () => {
  let world: InstanceType<typeof ModelT>;
  const rec = new QGLRecording();

  beforeAll(() => {
    // the hookless path (setModelLoaderHooks(null)) never calls
    // Mod_LoadLighting at all -- that shared function is reached only
    // through a ModelLoaderHooks.Mod_LoadLighting implementation
    // (src/common/model.ts:2023's `if (hooks !== null)` guard), and
    // glModelHooks.Mod_LoadLighting (src/ref_gl/gl_model.ts) is a thin
    // delegate to it. Needs a real QGL backend for GL_LoadTexture's miptex
    // upload, cleared before the test below records anything.
    SetQGL(rec);
    setModelLoaderHooks(glModelHooks);
    const mod = Mod_ForName(MAP, true);
    if (mod === null) throw new Error(`expected ${MAP} to load`);
    world = mod;
    expect(world.lightdata).not.toBeNull();

    // shaped like a real `.lit`: BSP_NUMFACES faces, BSP_FACE_LIGHTMAP_SAMPLES
    // samples/face/style, one style, three distinct non-equal channels so a
    // channel mixup in the upload path would be caught.
    const rgb = new Uint8Array(BSP_NUMFACES * BSP_FACE_LIGHTMAP_SAMPLES * 3);
    for (let f = 0; f < BSP_NUMFACES; f++) {
      for (let i = 0; i < BSP_FACE_LIGHTMAP_SAMPLES; i++) {
        const base = (f * BSP_FACE_LIGHTMAP_SAMPLES + i) * 3;
        rgb[base] = 10;
        rgb[base + 1] = 20;
        rgb[base + 2] = 30;
      }
    }
    world.lightdata_rgb = rgb;
  });

  beforeEach(() => {
    rec.clear();
    SetQGL(rec);
    cl.model_precache.fill(null);
    cl.model_precache[1] = world;
    cl.worldmodel = world;
    d_lightstylevalue.fill(256); // 8.8 fixed-point 1.0
    gl_texsort.value = 1;
    gl_texsort.string = "1";
    glState.lightmap_textures = 0;
    glState.texture_extension_number = 1;
  });

  afterAll(() => {
    GL_ClearLightmapState();
  });

  test("uploads real, uninverted RGB texels for the loaded map's first lightmap block", () => {
    GL_BuildLightmaps();

    expect(glDrawState.gl_lightmap_format).toBe(GL_RGBA);

    const uploads = rec.calls.filter((c) => c.name === "qglTexImage2D");
    expect(uploads.length).toBeGreaterThan(0);

    const pixels = uploads[0].args[8];
    if (!(pixels instanceof Uint8Array)) throw new Error("expected qglTexImage2D's pixels argument to be a Uint8Array");

    // 10*256>>7=20, 20*256>>7=40, 30*256>>7=60, alpha forced to 255 -- not
    // the classic invert-and-blend format's `255 - t` alpha-only encoding.
    expect(Array.from(pixels.slice(0, 4))).toEqual([20, 40, 60, 255]);
  });
});

//============================================================================
// Guarded real-data test: rerelease/id1 e1m1, which ships a real .lit file.
//============================================================================

const RERELEASE_DIR = process.env.Q1TS_RERELEASE ?? "/home/buzzkill/Projects/qfiles/q1/rerelease";
const HAVE_RERELEASE = existsSync(join(RERELEASE_DIR, "id1", "pak0.pak"));

describe.skipIf(!HAVE_RERELEASE)("colored lighting against real rerelease e1m1 data (skipped when absent, e.g. on CI)", () => {
  afterAll(() => {
    setModelLoaderHooks(null);
    setComSearchpaths(null);
    Mod_ClearAll();
  });

  test("R_BuildLightMap produces non-grey texels for at least one e1m1 surface", () => {
    setComSearchpaths(null);
    COM_InitArgv(["quake", "-basedir", RERELEASE_DIR]);
    setComModified(false);
    COM_InitFilesystem();
    COM_CheckRegistered();
    Mod_Init();

    let nextTexnum = 1;
    const loadTextureSpy = spyOn(glDraw, "GL_LoadTexture").mockImplementation(() => nextTexnum++);
    // textureLoaded (gl_model.ts) calls R_InitSky directly for sky-named
    // textures, bypassing the GL_LoadTexture spy above; e1m1 has a sky
    // texture, so a real (recording) QGL backend is needed too.
    const savedQgl = qglHolder.current;
    SetQGL(new QGLRecording());
    // U21 fixed the stack overflow GL_SubdivideSurface's SubdividePolygon
    // used to hit on e1m1's real sky geometry here (this test used to stub
    // GL_SubdivideSurface out to work around it) -- see gl_warp.ts's
    // SubdividePolygon header note: gl_subdivide_size reads as 0 until
    // Cvar_RegisterVariable runs (R_Init is never called in this test, only
    // Mod_ForName), which turned every axial cut into a NaN comparison and
    // recursed forever with a numverts=0 split at every level. The fix is a
    // `numverts <= 0` early return; real subdivision now runs unstubbed.
    try {
      setModelLoaderHooks(glModelHooks);
      const mod = Mod_ForName("maps/e1m1.bsp", true);
      if (mod === null) throw new Error("expected maps/e1m1.bsp to load");

      expect(mod.lightdata_rgb).not.toBeNull();

      cl.worldmodel = mod;
      gl_coloredlight.value = 1;
      gl_coloredlight.string = "1";
      d_lightstylevalue.fill(264);

      let foundColor = false;
      for (const surf of mod.surfaces) {
        if (surf.samples === null) continue;
        const smax = (surf.extents[0] >> 4) + 1;
        const tmax = (surf.extents[1] >> 4) + 1;
        const stride = smax * 4;
        const buf = new Uint8Array(stride * tmax);
        R_BuildLightMap(surf, buf, 0, stride);
        for (let i = 0; i < smax * tmax; i++) {
          const r = buf[i * 4];
          const g = buf[i * 4 + 1];
          const b = buf[i * 4 + 2];
          if (r !== g || g !== b) {
            foundColor = true;
            break;
          }
        }
        if (foundColor) break;
      }

      expect(foundColor).toBe(true);
    } finally {
      loadTextureSpy.mockRestore();
      SetQGL(savedQgl);
    }
  });
});
