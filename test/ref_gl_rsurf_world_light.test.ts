// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Regression cover for the two pieces of arithmetic that decide how bright a
world surface can get under the GL refresh, pinned to the values measured on
e1m1 by test/e2e/m_gl_world_light.ts. Nothing in src/ changed as a result of
that investigation; these cases exist so a later edit to gl_rsurf.ts's
R_BuildLightMap or gl_draw.ts's GL_Upload8/GL_MipMap cannot silently move
them.

What the measurement found, for the record: e1m1's wall light fixtures
(tlight02/tlight07/tlight11/sliplite) are built partly from palette indices
224-255, and gfx/colormap.lmp maps every one of those indices to itself at
all 64 light levels. The software refresh therefore draws them at full
palette brightness whatever the lightmap says, while the GL refresh
modulates every texel by the lightmap -- gl_rmain.c:511 is id's own comment
on the difference ("HACK HACK HACK -- no fullbright colors, so make torches
full light"). Both halves below are the GL side of that, and both match the
C exactly:
  - R_BuildLightMap writes 255 - min(255, blocklights >> 7), which
    R_BlendLightmaps' glBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_COLOR) turns
    into a multiply of the texel by (blocklights >> 7)/255.
  - GL_Upload8 -> GL_Upload32 builds every mip level >= 1 with GL_MipMap's
    2x2 box filter over level 0, never reading the artist-authored mips the
    BSP stores; a fullbright palette index gets no exemption from either
    step.

Self-sufficient per standing order 13, and every shared singleton this file
writes (qglHolder.current, glDrawState.gl_lightmap_format, blocklights,
d_lightstylevalue, d_8to24table, cl.worldmodel, glState.r_framecount, and the
r_fullbright/gl_picmip/gl_max_size cvars) is saved in beforeAll and restored
in afterAll per standing order 15.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ModelT, MsurfaceT } from "../src/common/model";
import { cl } from "../src/client/client";
import { d_8to24table } from "../src/client/vid";
import { BLOCK_WIDTH, d_lightstylevalue, glState } from "../src/ref_gl/glquake";
import { GL_LUMINANCE, GL_RGBA, type GLPointer, QGLRecording, qglHolder } from "../src/ref_gl/qgl";
import { GL_Upload8, gl_max_size, gl_picmip, glDrawState } from "../src/ref_gl/gl_draw";
import { r_fullbright } from "../src/ref_gl/gl_rmain";
import { R_BuildLightMap, blocklights } from "../src/ref_gl/gl_rsurf";

// gl_draw.c's GL_Upload32 hands glTexImage2D the same `scaled` buffer for
// every mip level, rewriting it in place between calls, so a plain
// QGLRecording would only ever hold aliases of the last level. Snapshot the
// bytes at call time instead.
class SnapshotQGL extends QGLRecording {
  readonly uploads: Array<{ level: number; width: number; height: number; rgba: Uint8Array }> = [];

  override qglTexImage2D(
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: GLPointer,
  ): void {
    if (pixels instanceof Uint32Array) {
      const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      this.uploads.push({ level, width, height, rgba: bytes.slice(0, width * height * 4) });
    }
    super.qglTexImage2D(target, level, internalformat, width, height, border, format, type, pixels);
  }
}

const rec = new SnapshotQGL();

const savedCvar = (c: { string: string; value: number }): { string: string; value: number } => ({ string: c.string, value: c.value });
const restoreCvar = (c: { string: string; value: number }, s: { string: string; value: number }): void => {
  c.string = s.string;
  c.value = s.value;
};

const saved = {
  qgl: qglHolder.current,
  lightmapFormat: 0,
  lightstyles: new Int32Array(256),
  palette: new Uint32Array(256),
  worldmodel: cl.worldmodel,
  framecount: 0,
  cvars: {
    r_fullbright: savedCvar(r_fullbright),
    gl_picmip: savedCvar(gl_picmip),
    gl_max_size: savedCvar(gl_max_size),
  },
};

// 'm' is lightstyle 0's normal value: ('m' - 'a') * 22, as R_AnimateLight
// computes it.
const NORMAL_LIGHT_SCALE = 264;

beforeAll(() => {
  saved.lightmapFormat = glDrawState.gl_lightmap_format;
  saved.lightstyles.set(d_lightstylevalue);
  saved.palette.set(d_8to24table);
  saved.framecount = glState.r_framecount;
  qglHolder.current = rec;
});

afterAll(() => {
  qglHolder.current = saved.qgl;
  glDrawState.gl_lightmap_format = saved.lightmapFormat;
  d_lightstylevalue.set(saved.lightstyles);
  d_8to24table.set(saved.palette);
  blocklights.fill(0);
  cl.worldmodel = saved.worldmodel;
  glState.r_framecount = saved.framecount;
  restoreCvar(r_fullbright, saved.cvars.r_fullbright);
  restoreCvar(gl_picmip, saved.cvars.gl_picmip);
  restoreCvar(gl_max_size, saved.cvars.gl_max_size);
});

beforeEach(() => {
  rec.clear();
  rec.uploads.length = 0;
  blocklights.fill(0);
  d_lightstylevalue.fill(0);
  d_lightstylevalue[0] = NORMAL_LIGHT_SCALE;
  glState.r_framecount = 1;
  r_fullbright.value = 0;
  r_fullbright.string = "0";
  gl_picmip.value = 0;
  gl_picmip.string = "0";
  gl_max_size.value = 1024;
  gl_max_size.string = "1024";
});

// A surface whose four luxels reproduce the accumulator values measured on
// e1m1's tlight11 fixtures: 53*264 = 13992, 106*264 = 27984, 134*264 = 35376
// (past the >> 7 clamp) and 0.
function fixtureSurface(): MsurfaceT {
  const surf = new MsurfaceT();
  surf.extents[0] = 16; // smax = 2
  surf.extents[1] = 16; // tmax = 2
  surf.samples = new Uint8Array([53, 106, 134, 0]);
  surf.styles[0] = 0;
  surf.styles[1] = 255;
  surf.dlightframe = -1;

  const world = new ModelT();
  world.lightdata = new Uint8Array(16);
  cl.worldmodel = world;
  return surf;
}

// R_BlendLightmaps binds the lightmap with glBlendFunc(GL_ZERO,
// GL_ONE_MINUS_SRC_COLOR), so the framebuffer keeps texel * (1 - lightmap).
function modulation(lightmapByte: number): number {
  return (255 - lightmapByte) / 255;
}

//============================================================================
// R_BuildLightMap: the GL modulation factor for e1m1's light fixtures
//============================================================================

describe("R_BuildLightMap (world light regression)", () => {
  test("GL_LUMINANCE stores 255 - (blocklights >> 7), clamped, for the measured e1m1 luxels", () => {
    glDrawState.gl_lightmap_format = GL_LUMINANCE;
    const surf = fixtureSurface();
    const dest = new Uint8Array(BLOCK_WIDTH * 4);

    R_BuildLightMap(surf, dest, 0, BLOCK_WIDTH);

    expect(blocklights[0]).toBe(13992);
    expect(blocklights[1]).toBe(27984);
    expect(blocklights[2]).toBe(35376);

    // 13992 >> 7 = 109, 27984 >> 7 = 218, 35376 >> 7 = 276 -> clamped to 255
    expect(dest[0]).toBe(146);
    expect(dest[1]).toBe(37);
    expect(dest[BLOCK_WIDTH + 0]).toBe(0);
    expect(dest[BLOCK_WIDTH + 1]).toBe(255);
  });

  test("the blend of that lightmap with a white texel is the measured 0.4275", () => {
    glDrawState.gl_lightmap_format = GL_LUMINANCE;
    const surf = fixtureSurface();
    const dest = new Uint8Array(BLOCK_WIDTH * 4);

    R_BuildLightMap(surf, dest, 0, BLOCK_WIDTH);

    // the luxel under the traced pixel on e1m1's surface 4034
    expect(modulation(dest[0])).toBeCloseTo(0.4275, 4);
    expect(Math.round(255 * modulation(dest[0]))).toBe(109);

    // its brighter neighbours, up to the point where the lightmap saturates
    // and the texel passes through untouched
    expect(Math.round(255 * modulation(dest[1]))).toBe(218);
    expect(modulation(dest[BLOCK_WIDTH + 0])).toBe(1);
    expect(modulation(dest[BLOCK_WIDTH + 1])).toBe(0);
  });

  test("GL_RGBA puts the same value in the alpha byte, four bytes per luxel", () => {
    glDrawState.gl_lightmap_format = GL_RGBA;
    const surf = fixtureSurface();
    const stride = BLOCK_WIDTH * 4;
    const dest = new Uint8Array(stride * 4);

    R_BuildLightMap(surf, dest, 0, stride);

    expect(dest[3]).toBe(146);
    expect(dest[7]).toBe(37);
    expect(dest[stride + 3]).toBe(0);
    expect(dest[stride + 7]).toBe(255);
  });
});

//============================================================================
// GL_Upload8: GL builds its own mip chain and exempts no palette index
//============================================================================

describe("GL_Upload8 mip chain (world light regression)", () => {
  test("levels >= 1 are GL_MipMap's box filter over level 0, fullbright indices included", () => {
    // index 254 is inside gfx/colormap.lmp's identity range; the software
    // refresh would keep it at full white at every light level.
    d_8to24table.fill(255 << 24); // opaque black for every other index
    d_8to24table[254] = ((255 << 24) | (255 << 16) | (255 << 8) | 255) >>> 0;

    const data = new Uint8Array(16); // 4x4, all index 0
    data[0] = 254;

    GL_Upload8(data, 4, 4, true, false);

    expect(rec.uploads.map((u) => `${u.level}:${u.width}x${u.height}`)).toEqual(["0:4x4", "1:2x2", "2:1x1"]);

    // level 0 carries the fullbright texel verbatim, expanded through
    // d_8to24table like any other index -- GL_Upload8 has no fullbright case
    expect(Array.from(rec.uploads[0].rgba.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(rec.uploads[0].rgba.slice(4, 8))).toEqual([0, 0, 0, 255]);

    // GL_MipMap averages 2x2 quads: (255 + 0 + 0 + 0) >> 2 = 63, then again
    expect(Array.from(rec.uploads[1].rgba.slice(0, 4))).toEqual([63, 63, 63, 255]);
    expect(Array.from(rec.uploads[2].rgba.slice(0, 4))).toEqual([15, 15, 15, 255]);
  });

  test("with mipmap false only level 0 is uploaded", () => {
    d_8to24table.fill(255 << 24);
    d_8to24table[254] = ((255 << 24) | (255 << 16) | (255 << 8) | 255) >>> 0;

    const data = new Uint8Array(16);
    data[0] = 254;

    GL_Upload8(data, 4, 4, false, false);

    expect(rec.uploads.map((u) => u.level)).toEqual([0]);
    expect(Array.from(rec.uploads[0].rgba.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });
});
