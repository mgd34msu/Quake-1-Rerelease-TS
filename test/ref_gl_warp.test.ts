// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U073's src/ref_gl/gl_warp.ts: GL_SubdivideSurface's axial
subdivision of a face into <= gl_subdivide_size pieces, EmitWaterPolys'
turbsin texture-coordinate warp, R_InitSky's split of a 256x128 sky miptex
into the solid and alpha 128x128 layers, and R_DrawSkyChain's two-layer bind
sequence.

Every case drives a QGLRecording installed as qglHolder.current, and every
shared singleton the suite writes (qglHolder, glState, glWarpState,
gl_subdivide_size, loadState, host.realtime, d_8to24table, r_origin) is saved
in beforeAll and restored in afterAll, per standing orders 13 and 15.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { MedgeT, MtexinfoT, ModelT, MsurfaceT, MvertexT, TextureT, loadState } from "../src/common/model";
import { host } from "../src/common/host";
import { d_8to24table } from "../src/client/vid";
import { r_origin } from "../src/client/render";
import { GlpolyT, VERTEXSIZE, glState, setSurfPolys, surfPolys } from "../src/ref_gl/glquake";
import { GL_BLEND, type GLPointer, QGLRecording, qglHolder } from "../src/ref_gl/qgl";
import { gl_subdivide_size } from "../src/ref_gl/gl_model";
import { turbsin } from "../src/ref_gl/gl_warp_sin";
import {
  BoundPoly,
  EmitWaterPolys,
  GL_SubdivideSurface,
  R_DrawSkyChain,
  R_InitSky,
  TURBSCALE,
  glWarpState,
} from "../src/ref_gl/gl_warp";

// QGLRecording keeps every pointer argument by reference, and R_InitSky
// uploads BOTH sky layers out of the same `trans` buffer. This subclass
// snapshots each glTexImage2D pixel block so a test can see what each upload
// actually carried.
class SnapshottingQGL extends QGLRecording {
  readonly texImages: Array<{ width: number; height: number; pixels: number[] }> = [];

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
    if (pixels instanceof Uint32Array) this.texImages.push({ width, height, pixels: Array.from(pixels) });
    super.qglTexImage2D(target, level, internalformat, width, height, border, format, type, pixels);
  }
}

const rec = new SnapshottingQGL();

const saved = {
  qgl: qglHolder.current,
  loadmodel: loadState.loadmodel,
  subdivide: gl_subdivide_size.string,
  realtime: host.realtime,
  solidsky: glWarpState.solidskytexture,
  alphasky: glWarpState.alphaskytexture,
  speedscale: glWarpState.speedscale,
  texExt: glState.texture_extension_number,
  currenttexture: glState.currenttexture,
  palette: Array.from(d_8to24table),
  origin: [r_origin[0], r_origin[1], r_origin[2]],
};

beforeAll(() => {
  qglHolder.current = rec;
});

afterAll(() => {
  qglHolder.current = saved.qgl;
  loadState.loadmodel = saved.loadmodel;
  gl_subdivide_size.string = saved.subdivide;
  gl_subdivide_size.value = Number.parseFloat(saved.subdivide);
  host.realtime = saved.realtime;
  glWarpState.solidskytexture = saved.solidsky;
  glWarpState.alphaskytexture = saved.alphasky;
  glWarpState.speedscale = saved.speedscale;
  glState.texture_extension_number = saved.texExt;
  glState.currenttexture = saved.currenttexture;
  for (let i = 0; i < 256; i++) d_8to24table[i] = saved.palette[i];
  r_origin[0] = saved.origin[0];
  r_origin[1] = saved.origin[1];
  r_origin[2] = saved.origin[2];
});

beforeEach(() => {
  rec.clear();
  rec.texImages.length = 0;
  glState.currenttexture = -1;
});

//============================================================================
// helpers
//============================================================================

function makeTexinfo(): MtexinfoT {
  const tex = new MtexinfoT();
  // the identity axial mapping: s = x, t = y
  tex.vecs[0].set([1, 0, 0, 0]);
  tex.vecs[1].set([0, 1, 0, 0]);
  const texture = new TextureT();
  texture.name = "warp";
  texture.width = 16;
  texture.height = 16;
  texture.gl_texturenum = 7;
  tex.texture = texture;
  return tex;
}

// A model holding one axis-aligned quad face, in the shape
// GL_SubdivideSurface walks it (surfedges -> edges -> vertexes).
function makeQuadModel(size: number): { model: ModelT; face: MsurfaceT } {
  const model = new ModelT();
  model.name = "*quad";

  const corners: Array<[number, number, number]> = [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
  ];
  model.vertexes = corners.map((c) => {
    const v = new MvertexT();
    v.position[0] = c[0];
    v.position[1] = c[1];
    v.position[2] = c[2];
    return v;
  });
  model.numvertexes = model.vertexes.length;

  // edge 0 is the reserved unused entry, exactly as a real BSP's is
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

  const face = new MsurfaceT();
  face.firstedge = 0;
  face.numedges = 4;
  face.texinfo = makeTexinfo();
  model.surfaces = [face];
  model.numsurfaces = 1;

  return { model, face };
}

function polyChainLength(face: MsurfaceT): number {
  let n = 0;
  for (let p = surfPolys(face); p; p = p.next) n++;
  return n;
}

//============================================================================
// BoundPoly / SubdividePolygon / GL_SubdivideSurface
//============================================================================

describe("BoundPoly", () => {
  test("brackets a flat run of vec3_t", () => {
    const verts = new Float32Array([1, 2, 3, -4, 5, -6, 7, -8, 9]);
    const mins = new Float32Array(3);
    const maxs = new Float32Array(3);
    BoundPoly(3, verts, mins, maxs);
    expect(Array.from(mins)).toEqual([-4, -8, -6]);
    expect(Array.from(maxs)).toEqual([7, 5, 9]);
  });
});

describe("GL_SubdivideSurface", () => {
  test("splits a 256x256 quad into a 4x4 grid at gl_subdivide_size 64", () => {
    gl_subdivide_size.value = 64;
    gl_subdivide_size.string = "64";

    const { model, face } = makeQuadModel(256);
    loadState.loadmodel = model;
    setSurfPolys(face, null);

    GL_SubdivideSurface(face);

    // each axis is halved at 128, then at 64/192: four 64-unit columns by
    // four 64-unit rows
    expect(polyChainLength(face)).toBe(16);

    for (let p = surfPolys(face); p; p = p.next) {
      expect(p.numverts).toBe(4);
      // SubdividePolygon stores UNSCALED s/t (DotProduct with vecs, no
      // texture width divide and no vecs[i][3] offset)
      for (let i = 0; i < p.numverts; i++) {
        expect(p.verts[i * VERTEXSIZE + 3]).toBe(p.verts[i * VERTEXSIZE]);
        expect(p.verts[i * VERTEXSIZE + 4]).toBe(p.verts[i * VERTEXSIZE + 1]);
      }
    }
  });

  test("leaves a quad smaller than the subdivide size as one polygon", () => {
    gl_subdivide_size.value = 128;
    gl_subdivide_size.string = "128";

    const { model, face } = makeQuadModel(64);
    loadState.loadmodel = model;
    setSurfPolys(face, null);

    GL_SubdivideSurface(face);

    expect(polyChainLength(face)).toBe(1);
    const poly = surfPolys(face);
    expect(poly).not.toBeNull();
    expect(poly?.numverts).toBe(4);
  });
});

//============================================================================
// EmitWaterPolys
//============================================================================

describe("EmitWaterPolys", () => {
  test("warps s/t through turbsin at realtime 0", () => {
    host.realtime = 0;

    const face = new MsurfaceT();
    const poly = new GlpolyT(1);
    poly.verts[0] = 1;
    poly.verts[1] = 2;
    poly.verts[2] = 3;
    const os = 64;
    const ot = 0;
    poly.verts[3] = os;
    poly.verts[4] = ot;
    setSurfPolys(face, poly);

    EmitWaterPolys(face);

    const texcoords = rec.calls.filter((c) => c.name === "qglTexCoord2f");
    expect(texcoords).toHaveLength(1);

    const sIndex = (((ot * 0.125 + 0) * TURBSCALE) | 0) & 255;
    const tIndex = (((os * 0.125 + 0) * TURBSCALE) | 0) & 255;
    expect(sIndex).toBe(0);
    expect(tIndex).toBe(69);

    expect(texcoords[0].args[0]).toBeCloseTo((os + turbsin[0]) / 64, 6);
    expect(texcoords[0].args[1]).toBeCloseTo((ot + turbsin[69]) / 64, 6);

    // one GL_POLYGON per glpoly_t in the chain
    expect(rec.calls.filter((c) => c.name === "qglBegin")).toHaveLength(1);
    expect(rec.calls.filter((c) => c.name === "qglEnd")).toHaveLength(1);
  });
});

//============================================================================
// R_InitSky
//============================================================================

describe("R_InitSky", () => {
  test("uploads two 128x128 layers and keys the alpha layer on the averaged back color", () => {
    // palette entry 1 is the only color in the right (solid) half, so the
    // average IS that color; entry 0 marks the transparent pixels of the
    // left (alpha) half.
    d_8to24table[0] = 0xffffffff;
    d_8to24table[1] = 0x00030201; // r=1 g=2 b=3, alpha byte 0

    const mt = new TextureT();
    mt.name = "sky1";
    mt.width = 256;
    mt.height = 128;
    mt.offsets[0] = 0;
    mt.data = new Uint8Array(256 * 128);
    for (let i = 0; i < 128; i++)
      for (let j = 0; j < 128; j++) {
        mt.data[i * 256 + j] = 0; // left half: masked overlay
        mt.data[i * 256 + j + 128] = 1; // right half: solid sky
      }

    glWarpState.solidskytexture = 0;
    glWarpState.alphaskytexture = 0;
    glState.texture_extension_number = 40;

    R_InitSky(mt);

    expect(glWarpState.solidskytexture).toBe(40);
    expect(glWarpState.alphaskytexture).toBe(41);
    expect(glState.texture_extension_number).toBe(42);

    expect(rec.texImages).toHaveLength(2);
    for (const img of rec.texImages) {
      expect(img.width).toBe(128);
      expect(img.height).toBe(128);
      expect(img.pixels).toHaveLength(128 * 128);
    }

    // solid layer: every texel is the right half's palette color
    expect(rec.texImages[0].pixels[0]).toBe(0x00030201);
    expect(rec.texImages[0].pixels[128 * 128 - 1]).toBe(0x00030201);

    // alpha layer: palette index 0 became transpix (the averaged back color
    // with a zero alpha byte), NOT d_8to24table[0]
    expect(rec.texImages[1].pixels[0]).toBe(0x00030201);
    expect(rec.texImages[1].pixels[128 * 128 - 1]).toBe(0x00030201);

    // both layers set LINEAR min/mag
    expect(rec.calls.filter((c) => c.name === "qglTexParameterf")).toHaveLength(4);
  });
});

//============================================================================
// R_DrawSkyChain
//============================================================================

describe("R_DrawSkyChain", () => {
  test("draws the solid layer, enables blending, then draws the alpha layer", () => {
    host.realtime = 0;
    glWarpState.solidskytexture = 61;
    glWarpState.alphaskytexture = 62;
    r_origin[0] = r_origin[1] = r_origin[2] = 0;

    const face = new MsurfaceT();
    const poly = new GlpolyT(1);
    poly.verts[0] = 10;
    poly.verts[1] = 20;
    poly.verts[2] = 30;
    setSurfPolys(face, poly);
    face.texturechain = null;

    R_DrawSkyChain(face);

    const names = rec.calls.map((c) => c.name);
    const binds = rec.calls.filter((c) => c.name === "qglBindTexture").map((c) => c.args[1]);
    expect(binds).toEqual([61, 62]);

    const firstBind = names.indexOf("qglBindTexture");
    const enable = rec.calls.findIndex((c) => c.name === "qglEnable" && c.args[0] === GL_BLEND);
    const secondBind = names.lastIndexOf("qglBindTexture");
    const disable = rec.calls.findIndex((c) => c.name === "qglDisable" && c.args[0] === GL_BLEND);
    expect(firstBind).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(firstBind);
    expect(secondBind).toBeGreaterThan(enable);
    expect(disable).toBeGreaterThan(secondBind);

    // speedscale ends at realtime*16 with the C's `& ~127` reduction applied
    expect(glWarpState.speedscale).toBe(0);

    // one GL_POLYGON per layer
    expect(rec.calls.filter((c) => c.name === "qglBegin")).toHaveLength(2);
  });
});
