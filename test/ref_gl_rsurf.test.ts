// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U073's src/ref_gl/gl_rsurf.ts: the lightmap atlas packer
(AllocBlock), the 8.8 lightmap accumulator (R_BuildLightMap), the per-surface
display list (BuildSurfaceDisplayList), the whole-map lightmap upload
(GL_BuildLightmaps), the gl_texsort world walk (R_RecursiveWorldNode ->
DrawTextureChains -> R_BlendLightmaps, which is what R_DrawWorld is) and
R_DrawBrushModel's matrix bracketing.

Every case drives a QGLRecording installed as qglHolder.current, and every
shared singleton the suite writes (qglHolder, glState, glRsurfState,
glDrawState.gl_lightmap_format, allocated, lightmaps, lightmap_polys,
lightmap_modified, lightmap_rectchange, blocklights, d_lightstylevalue,
frustum, r_refdef.vieworg, modelorg, cl, and the gl_rmain cvars this module
reads) is saved in beforeAll and restored in afterAll, per standing orders 13
and 15.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { CONTENTS_EMPTY } from "../src/common/bspfile";
import { MplaneT, PLANE_ANYZ } from "../src/common/mathlib";
import {
  MedgeT,
  MleafT,
  MnodeT,
  ModelT,
  MsurfaceT,
  MtexinfoT,
  MvertexT,
  SURF_PLANEBACK,
  TextureT,
} from "../src/common/model";
import { cl } from "../src/client/client";
import { EntityT, r_refdef } from "../src/client/render";
import { SysError } from "../src/platform/sys";
import {
  BLOCK_HEIGHT,
  BLOCK_WIDTH,
  GlpolyT,
  MAX_LIGHTMAPS,
  VERTEXSIZE,
  cnttextures,
  d_lightstylevalue,
  frustum,
  glState,
  modelorg,
  setSurfPolys,
  surfPolys,
} from "../src/ref_gl/glquake";
import { GL_BLEND, GL_LUMINANCE, GL_POLYGON, GL_REPLACE, GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_TEXTURE_2D, GL_UNSIGNED_BYTE, QGLRecording, qglHolder } from "../src/ref_gl/qgl";
import { glDrawState } from "../src/ref_gl/gl_draw";
import { gl_flashblend, gl_keeptjunctions, gl_texsort, r_dynamic, r_fullbright, r_lightmap, r_mirroralpha, r_novis, r_wateralpha } from "../src/ref_gl/gl_rmain";
import {
  AllocBlock,
  BuildSurfaceDisplayList,
  DrawTextureChains,
  R_DrawSequentialPoly,
  GL_BuildLightmaps,
  R_BlendLightmaps,
  R_BuildLightMap,
  R_DrawBrushModel,
  R_MarkLeaves,
  R_RecursiveWorldNode,
  allocated,
  blocklights,
  glRsurfState,
  lightmap_modified,
  lightmap_polys,
  lightmap_rectchange,
  lightmaps,
} from "../src/ref_gl/gl_rsurf";

const rec = new QGLRecording();

const savedCvar = (c: { string: string; value: number }): { string: string; value: number } => ({ string: c.string, value: c.value });
const restoreCvar = (c: { string: string; value: number }, s: { string: string; value: number }): void => {
  c.string = s.string;
  c.value = s.value;
};

const saved = {
  qgl: qglHolder.current,
  lightmapFormat: 0,
  // A full snapshot rather than hand-picked fields: this file's own suite
  // (GL_BuildLightmaps/DrawTextureChains, through gl_draw.ts's GL_Bind/
  // GL_SelectTexture) also mutates glState.oldtarget and the separate
  // `cnttextures` array, and a hand-picked field list has already missed
  // fields once (rule 15) -- restore everything so a future field addition
  // to GlStateT can't reopen the same gap.
  glState: { ...glState },
  cnttextures: Array.from(cnttextures),
  rsurf: { ...glRsurfState },
  allocated: new Int32Array(allocated),
  lightmapStyles: new Int32Array(d_lightstylevalue),
  frustum: frustum.map((p) => ({ normal: [p.normal[0], p.normal[1], p.normal[2]], dist: p.dist, type: p.type, signbits: p.signbits })),
  vieworg: [r_refdef.vieworg[0], r_refdef.vieworg[1], r_refdef.vieworg[2]],
  modelorg: [modelorg[0], modelorg[1], modelorg[2]],
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  precache0: cl.model_precache[0],
  precache1: cl.model_precache[1],
  precache2: cl.model_precache[2],
  cvars: {
    gl_texsort: savedCvar(gl_texsort),
    gl_keeptjunctions: savedCvar(gl_keeptjunctions),
    gl_flashblend: savedCvar(gl_flashblend),
    r_fullbright: savedCvar(r_fullbright),
    r_lightmap: savedCvar(r_lightmap),
    r_dynamic: savedCvar(r_dynamic),
    r_wateralpha: savedCvar(r_wateralpha),
    r_mirroralpha: savedCvar(r_mirroralpha),
    r_novis: savedCvar(r_novis),
  },
};

beforeAll(() => {
  saved.lightmapFormat = glDrawState.gl_lightmap_format;
  qglHolder.current = rec;

  // a frustum that culls nothing: every plane's far side is at -1e9 on X
  for (const p of frustum) {
    p.normal[0] = 1;
    p.normal[1] = 0;
    p.normal[2] = 0;
    p.dist = -1e9;
    p.type = PLANE_ANYZ; // >= 3, so BoxOnPlaneSide's signbits path runs
    p.signbits = 0;
  }
});

afterAll(() => {
  qglHolder.current = saved.qgl;
  glDrawState.gl_lightmap_format = saved.lightmapFormat;
  Object.assign(glState, saved.glState);
  cnttextures.set(saved.cnttextures);
  Object.assign(glRsurfState, saved.rsurf);
  allocated.set(saved.allocated);
  d_lightstylevalue.set(saved.lightmapStyles);
  lightmaps.fill(0);
  blocklights.fill(0);
  lightmap_polys.fill(null);
  lightmap_modified.fill(false);
  for (const r of lightmap_rectchange) {
    r.l = 0;
    r.t = 0;
    r.w = 0;
    r.h = 0;
  }
  for (let i = 0; i < 4; i++) {
    frustum[i].normal[0] = saved.frustum[i].normal[0];
    frustum[i].normal[1] = saved.frustum[i].normal[1];
    frustum[i].normal[2] = saved.frustum[i].normal[2];
    frustum[i].dist = saved.frustum[i].dist;
    frustum[i].type = saved.frustum[i].type;
    frustum[i].signbits = saved.frustum[i].signbits;
  }
  r_refdef.vieworg.set(saved.vieworg);
  modelorg.set(saved.modelorg);
  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  cl.model_precache[0] = saved.precache0;
  cl.model_precache[1] = saved.precache1;
  cl.model_precache[2] = saved.precache2;
  restoreCvar(gl_texsort, saved.cvars.gl_texsort);
  restoreCvar(gl_keeptjunctions, saved.cvars.gl_keeptjunctions);
  restoreCvar(gl_flashblend, saved.cvars.gl_flashblend);
  restoreCvar(r_fullbright, saved.cvars.r_fullbright);
  restoreCvar(r_lightmap, saved.cvars.r_lightmap);
  restoreCvar(r_dynamic, saved.cvars.r_dynamic);
  restoreCvar(r_wateralpha, saved.cvars.r_wateralpha);
  restoreCvar(r_mirroralpha, saved.cvars.r_mirroralpha);
  restoreCvar(r_novis, saved.cvars.r_novis);
  glState.r_viewleaf = null;
  glState.r_oldviewleaf = null;
});

beforeEach(() => {
  rec.clear();
  allocated.fill(0);
  lightmaps.fill(0);
  blocklights.fill(0);
  lightmap_polys.fill(null);
  lightmap_modified.fill(false);
  for (const r of lightmap_rectchange) {
    r.l = 0;
    r.t = 0;
    r.w = 0;
    r.h = 0;
  }
  glRsurfState.lightmap_bytes = 1;
  glRsurfState.skychain = null;
  glRsurfState.waterchain = null;
  glRsurfState.mtexenabled = false;
  glRsurfState.currentmodel = null;
  glRsurfState.r_pcurrentvertbase = null;
  glRsurfState.nColinElim = 0;
  glDrawState.gl_lightmap_format = GL_LUMINANCE;
  glState.gl_mtexable = false;
  glState.currenttexture = -1;
  glState.currententity = new EntityT();
  glState.lightmap_textures = 200;
  glState.r_framecount = 1;
  glState.r_visframecount = 1;
  glState.c_brush_polys = 0;
  glState.skytexturenum = -1;
  glState.mirrortexturenum = -1;
  glState.mirror = false;
  gl_texsort.value = 1;
  gl_keeptjunctions.value = 1;
  gl_flashblend.value = 0;
  r_fullbright.value = 0;
  r_lightmap.value = 0;
  r_dynamic.value = 0;
  r_wateralpha.value = 1;
  r_mirroralpha.value = 1;
  r_novis.value = 0;
  cl.time = 0;
});

//============================================================================
// helpers
//============================================================================

function makeTexture(name: string, glnum: number): TextureT {
  const t = new TextureT();
  t.name = name;
  t.width = 16;
  t.height = 16;
  t.gl_texturenum = glnum;
  t.texturechain = null;
  return t;
}

function makeTexinfo(texture: TextureT): MtexinfoT {
  const ti = new MtexinfoT();
  ti.vecs[0].set([1, 0, 0, 0]);
  ti.vecs[1].set([0, 1, 0, 0]);
  ti.texture = texture;
  return ti;
}

// A model holding one axis-aligned quad face, walked through
// surfedges -> edges -> vertexes exactly as BuildSurfaceDisplayList does.
function makeQuadModel(size: number, texture: TextureT): { model: ModelT; face: MsurfaceT } {
  const model = new ModelT();
  model.name = "maps/quad.bsp";

  const corners: Array<[number, number]> = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
  model.vertexes = corners.map((c) => {
    const v = new MvertexT();
    v.position[0] = c[0];
    v.position[1] = c[1];
    v.position[2] = 0;
    return v;
  });
  model.numvertexes = model.vertexes.length;

  model.edges = [new MedgeT()]; // edge 0 is the reserved unused entry
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
  face.texinfo = makeTexinfo(texture);
  face.extents[0] = size;
  face.extents[1] = size;
  face.texturemins[0] = 0;
  face.texturemins[1] = 0;
  face.styles[0] = 255;
  face.plane = new MplaneT();
  face.plane.normal[2] = 1;
  face.plane.dist = 0;

  model.surfaces = [face];
  model.numsurfaces = 1;

  return { model, face };
}

//============================================================================
// AllocBlock
//============================================================================

describe("AllocBlock", () => {
  test("packs three 16x16 blocks side by side in lightmap 0", () => {
    const pos = { x: -1, y: -1 };

    expect(AllocBlock(16, 16, pos)).toBe(0);
    expect(pos).toEqual({ x: 0, y: 0 });

    expect(AllocBlock(16, 16, pos)).toBe(0);
    expect(pos).toEqual({ x: 16, y: 0 });

    expect(AllocBlock(16, 16, pos)).toBe(0);
    expect(pos).toEqual({ x: 32, y: 0 });

    for (let i = 0; i < 48; i++) expect(allocated[i]).toBe(16);
    expect(allocated[48]).toBe(0);
  });

  test("Sys_Errors once every lightmap is full", () => {
    allocated.fill(BLOCK_HEIGHT);
    const pos = { x: 0, y: 0 };
    expect(() => AllocBlock(16, 16, pos)).toThrow(SysError);
    expect(() => AllocBlock(16, 16, pos)).toThrow("AllocBlock: full");
  });
});

//============================================================================
// R_BuildLightMap
//============================================================================

describe("R_BuildLightMap", () => {
  test("stores 255 - ((sample * style) >> 7) for GL_LUMINANCE", () => {
    const surf = new MsurfaceT();
    surf.extents[0] = 16; // smax = 2
    surf.extents[1] = 16; // tmax = 2
    surf.samples = new Uint8Array([10, 20, 30, 40]);
    surf.styles[0] = 0;
    surf.styles[1] = 255;
    surf.dlightframe = -1;

    const world = new ModelT();
    world.lightdata = new Uint8Array(16);
    cl.worldmodel = world;

    const scale = 264;
    d_lightstylevalue[0] = scale;

    const dest = new Uint8Array(BLOCK_WIDTH * 4);
    R_BuildLightMap(surf, dest, 0, BLOCK_WIDTH);

    const expected = (sample: number): number => {
      let t = (sample * scale) | 0;
      t >>= 7;
      if (t > 255) t = 255;
      return 255 - t;
    };

    // row 0 at offset 0, row 1 one stride later
    expect(dest[0]).toBe(expected(10));
    expect(dest[1]).toBe(expected(20));
    expect(dest[BLOCK_WIDTH + 0]).toBe(expected(30));
    expect(dest[BLOCK_WIDTH + 1]).toBe(expected(40));

    expect(surf.cached_light[0]).toBe(scale);
    expect(surf.cached_dlight).toBe(false);
  });

  test("fills full bright when the world has no light data", () => {
    const surf = new MsurfaceT();
    surf.extents[0] = 0; // smax = 1
    surf.extents[1] = 0; // tmax = 1
    surf.samples = null;
    surf.styles[0] = 255;
    surf.dlightframe = -1;

    const world = new ModelT();
    world.lightdata = null;
    cl.worldmodel = world;

    const dest = new Uint8Array(8);
    R_BuildLightMap(surf, dest, 0, BLOCK_WIDTH);

    // blocklights = 255*256 -> t = 510 -> clamped to 255 -> 255 - 255 = 0
    expect(blocklights[0]).toBe(255 * 256);
    expect(dest[0]).toBe(0);
  });
});

//============================================================================
// BuildSurfaceDisplayList
//============================================================================

describe("BuildSurfaceDisplayList", () => {
  test("builds one glpoly_t with the texture and lightmap coordinates", () => {
    const texture = makeTexture("wall", 3);
    const { model, face } = makeQuadModel(32, texture);
    face.light_s = 4;
    face.light_t = 6;
    setSurfPolys(face, null);

    glRsurfState.currentmodel = model;
    glRsurfState.r_pcurrentvertbase = model.vertexes;

    BuildSurfaceDisplayList(face);

    const poly = surfPolys(face);
    expect(poly).not.toBeNull();
    if (poly === null) return;
    expect(poly.numverts).toBe(4);
    expect(poly.next).toBeNull();
    expect(poly.flags).toBe(face.flags);

    // vertex 1 of the quad is (32, 0, 0)
    const v = VERTEXSIZE;
    expect(poly.verts[v + 0]).toBe(32);
    expect(poly.verts[v + 1]).toBe(0);
    // texture coords: DotProduct(vec, vecs[i]) + vecs[i][3], over w/h
    expect(poly.verts[v + 3]).toBeCloseTo(32 / texture.width, 6);
    expect(poly.verts[v + 4]).toBeCloseTo(0 / texture.height, 6);
    // lightmap coords: minus texturemins, plus light_s/t*16, plus 8, over
    // BLOCK_WIDTH*16
    expect(poly.verts[v + 5]).toBeCloseTo((32 - 0 + 4 * 16 + 8) / (BLOCK_WIDTH * 16), 6);
    expect(poly.verts[v + 6]).toBeCloseTo((0 - 0 + 6 * 16 + 8) / (BLOCK_HEIGHT * 16), 6);
  });

  test("removes co-linear points when gl_keeptjunctions is 0", () => {
    const texture = makeTexture("wall", 3);
    const { model, face } = makeQuadModel(32, texture);

    // insert a vertex halfway along the first edge, making it co-linear
    const mid = new MvertexT();
    mid.position[0] = 16;
    mid.position[1] = 0;
    model.vertexes.splice(1, 0, mid);
    model.numvertexes = model.vertexes.length;
    model.edges = [new MedgeT()];
    for (let i = 0; i < 5; i++) {
      const e = new MedgeT();
      e.v[0] = i;
      e.v[1] = (i + 1) % 5;
      model.edges.push(e);
    }
    model.surfedges = new Int32Array([1, 2, 3, 4, 5]);
    face.numedges = 5;
    setSurfPolys(face, null);

    glRsurfState.currentmodel = model;
    glRsurfState.r_pcurrentvertbase = model.vertexes;
    gl_keeptjunctions.value = 0;

    BuildSurfaceDisplayList(face);

    const poly = surfPolys(face);
    expect(poly?.numverts).toBe(4);
    expect(glRsurfState.nColinElim).toBe(1);
  });
});

//============================================================================
// GL_BuildLightmaps
//============================================================================

describe("GL_BuildLightmaps", () => {
  test("packs one map's surfaces and uploads the lightmap pages that were filled", () => {
    const texture = makeTexture("wall", 3);
    const { model, face } = makeQuadModel(32, texture);
    face.samples = null;
    setSurfPolys(face, null);

    const world = new ModelT();
    world.lightdata = null;
    cl.worldmodel = world;

    cl.model_precache[0] = null;
    cl.model_precache[1] = model;
    cl.model_precache[2] = null;

    glState.lightmap_textures = 0;
    glState.texture_extension_number = 10;

    GL_BuildLightmaps();

    // the lightmap texture object range is claimed once
    expect(glState.lightmap_textures).toBe(10);
    expect(glState.texture_extension_number).toBe(10 + MAX_LIGHTMAPS);

    // GL_LUMINANCE is the default (isPermedia is false and no -lm_* switch)
    expect(glDrawState.gl_lightmap_format).toBe(GL_LUMINANCE);
    expect(glRsurfState.lightmap_bytes).toBe(1);

    // one surface, one 3x3 block, so exactly one page is in use
    const uploads = rec.calls.filter((c) => c.name === "qglTexImage2D" && c.args[3] === BLOCK_WIDTH && c.args[4] === BLOCK_HEIGHT);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].args[6]).toBe(GL_LUMINANCE);
    expect(uploads[0].args[7]).toBe(GL_UNSIGNED_BYTE);

    // and the surface got both a lightmap slot and a display list
    expect(face.lightmaptexturenum).toBe(0);
    expect(surfPolys(face)).not.toBeNull();
    expect(glRsurfState.currentmodel).toBe(model);

    // r_framecount is reset so nothing is treated as dlit
    expect(glState.r_framecount).toBe(1);
  });
});

//============================================================================
// the world walk
//============================================================================

// A one-node world: the node holds two faces, its front child is a leaf that
// marks them visible, its back child is an empty leaf.
function makeWorld(): { world: ModelT; faces: [MsurfaceT, MsurfaceT]; textures: [TextureT, TextureT] } {
  const world = new ModelT();
  world.name = "maps/world.bsp";
  world.lightdata = null;

  const texA = makeTexture("texA", 11);
  const texB = makeTexture("texB", 12);

  const faces: MsurfaceT[] = [];
  for (let i = 0; i < 2; i++) {
    const f = new MsurfaceT();
    f.texinfo = makeTexinfo(i === 0 ? texA : texB);
    f.plane = new MplaneT();
    f.plane.normal[2] = 1;
    f.flags = 0;
    f.styles[0] = 255;
    f.lightmaptexturenum = 0;
    const poly = new GlpolyT(3);
    poly.flags = 0;
    setSurfPolys(f, poly);
    faces.push(f);
  }
  world.surfaces = faces;
  world.numsurfaces = 2;
  world.textures = [texA, texB];
  world.numtextures = 2;

  const front = new MleafT();
  front.contents = CONTENTS_EMPTY;
  front.visframe = 1;
  front.marksurfaces = faces;
  front.firstmarksurface = 0;
  front.nummarksurfaces = 2;

  const back = new MleafT();
  back.contents = CONTENTS_EMPTY;
  back.visframe = 1;
  back.nummarksurfaces = 0;

  const node = new MnodeT();
  node.contents = 0;
  node.visframe = 1;
  node.plane = new MplaneT();
  node.plane.normal[2] = 1;
  node.plane.dist = 0;
  node.plane.type = PLANE_ANYZ;
  node.children = [front, back];
  node.firstsurface = 0;
  node.numsurfaces = 2;

  world.nodes = [node];
  world.numnodes = 1;
  world.leafs = [front, back];
  world.numleafs = 2;

  if (faces[0] === undefined || faces[1] === undefined) throw new Error("unreachable");
  return { world, faces: [faces[0], faces[1]], textures: [texA, texB] };
}

describe("R_RecursiveWorldNode + DrawTextureChains", () => {
  test("chains each visible face onto its texture, then draws one polygon per surface", () => {
    const { world, faces, textures } = makeWorld();
    cl.worldmodel = world;
    modelorg[0] = 0;
    modelorg[1] = 0;
    modelorg[2] = 100; // dot = 100 -> front side is children[0]

    R_RecursiveWorldNode(world.nodes[0]);

    // the leaf marked both faces visible, and the surface loop chained them
    expect(faces[0].visframe).toBe(glState.r_framecount);
    expect(textures[0].texturechain).toBe(faces[0]);
    expect(textures[1].texturechain).toBe(faces[1]);
    expect(faces[0].texturechain).toBeNull();

    rec.clear();
    DrawTextureChains();

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture").map((c) => c.args[1]);
    expect(binds).toEqual([11, 12]);

    // DrawGLPoly emits one GL_POLYGON per surface
    const polys = rec.calls.filter((c) => c.name === "qglBegin" && c.args[0] === GL_POLYGON);
    expect(polys).toHaveLength(2);

    // and every chain is emptied
    expect(textures[0].texturechain).toBeNull();
    expect(textures[1].texturechain).toBeNull();

    // R_RenderBrushPoly pushed both polys onto the lightmap chain
    expect(lightmap_polys[0]).toBe(surfPolys(faces[1]));
    expect(glState.c_brush_polys).toBe(2);
  });

  test("skips a surface facing the wrong way", () => {
    const { world, faces } = makeWorld();
    cl.worldmodel = world;
    faces[0].flags = SURF_PLANEBACK;
    modelorg[0] = 0;
    modelorg[1] = 0;
    modelorg[2] = 100;

    R_RecursiveWorldNode(world.nodes[0]);

    // dot > 0 and SURF_PLANEBACK set -> wrong side
    expect(faces[0].texinfo?.texture?.texturechain).toBeNull();
    expect(faces[1].texinfo?.texture?.texturechain).toBe(faces[1]);
  });
});

//============================================================================
// R_BlendLightmaps
//============================================================================

describe("R_BlendLightmaps", () => {
  test("uploads the modified rect with glTexSubImage2D and resets it", () => {
    const poly = new GlpolyT(3);
    poly.flags = 0;
    poly.chain = null;
    lightmap_polys[0] = poly;
    lightmap_modified[0] = true;
    lightmap_rectchange[0].l = 0;
    lightmap_rectchange[0].t = 2;
    lightmap_rectchange[0].w = 10;
    lightmap_rectchange[0].h = 4;

    R_BlendLightmaps();

    const subs = rec.calls.filter((c) => c.name === "qglTexSubImage2D");
    expect(subs).toHaveLength(1);
    expect(subs[0].args.slice(0, 8)).toEqual([GL_TEXTURE_2D, 0, 0, 2, BLOCK_WIDTH, 4, GL_LUMINANCE, GL_UNSIGNED_BYTE]);

    expect(lightmap_modified[0]).toBe(false);
    expect(lightmap_rectchange[0].l).toBe(BLOCK_WIDTH);
    expect(lightmap_rectchange[0].t).toBe(BLOCK_HEIGHT);
    expect(lightmap_rectchange[0].w).toBe(0);
    expect(lightmap_rectchange[0].h).toBe(0);

    // the lightmap pass writes no Z and leaves depth writes back on
    const depthMasks = rec.calls.filter((c) => c.name === "qglDepthMask").map((c) => c.args[0]);
    expect(depthMasks).toEqual([false, true]);
  });

  test("returns immediately when r_fullbright is set", () => {
    lightmap_polys[0] = new GlpolyT(3);
    lightmap_modified[0] = true;
    r_fullbright.value = 1;

    R_BlendLightmaps();

    expect(rec.calls).toHaveLength(0);
    expect(lightmap_modified[0]).toBe(true);
  });
});

//============================================================================
// R_DrawBrushModel
//============================================================================

describe("R_DrawBrushModel", () => {
  test("brackets the surface pass with push/rotate/pop and draws the front faces", () => {
    const texture = makeTexture("bmodel", 21);

    const clmodel = new ModelT();
    clmodel.name = "*1";
    clmodel.mins.set([-8, -8, -8]);
    clmodel.maxs.set([8, 8, 8]);
    clmodel.radius = 16;
    clmodel.firstmodelsurface = 0;
    clmodel.nummodelsurfaces = 1;

    const face = new MsurfaceT();
    face.texinfo = makeTexinfo(texture);
    face.plane = new MplaneT();
    face.plane.normal[2] = 1;
    face.plane.dist = 0;
    face.flags = 0;
    face.styles[0] = 255;
    face.lightmaptexturenum = 0;
    setSurfPolys(face, new GlpolyT(3));
    clmodel.surfaces = [face];
    clmodel.numsurfaces = 1;

    const world = new ModelT();
    world.lightdata = null;
    world.textures = [texture];
    world.numtextures = 1;
    cl.worldmodel = world;

    const ent = new EntityT();
    ent.model = clmodel;
    ent.origin.set([10, 20, 30]);
    ent.angles.set([0, 0, 0]);

    r_refdef.vieworg.set([10, 20, 130]); // 100 units above the face's plane

    R_DrawBrushModel(ent);

    const names = rec.calls.map((c) => c.name);
    expect(names).toContain("qglPushMatrix");
    expect(names).toContain("qglPopMatrix");
    expect(names.indexOf("qglPushMatrix")).toBeLessThan(names.indexOf("qglPopMatrix"));

    // R_RotateForEntity between them
    const translate = rec.calls.find((c) => c.name === "qglTranslatef");
    expect(translate?.args).toEqual([10, 20, 30]);

    // one GL_POLYGON from DrawGLPoly, plus one from R_BlendLightmaps
    expect(rec.calls.filter((c) => c.name === "qglBegin" && c.args[0] === GL_POLYGON)).toHaveLength(2);
    expect(glState.currententity).toBe(ent);
  });

  test("culls a brush model outside the frustum", () => {
    for (const p of frustum) p.dist = 1e9; // nothing is in front any more

    const clmodel = new ModelT();
    clmodel.mins.set([-8, -8, -8]);
    clmodel.maxs.set([8, 8, 8]);
    clmodel.firstmodelsurface = 0;
    clmodel.nummodelsurfaces = 0;

    const ent = new EntityT();
    ent.model = clmodel;

    R_DrawBrushModel(ent);
    expect(rec.calls).toHaveLength(0);

    for (const p of frustum) p.dist = -1e9;
  });
});

//============================================================================
// R_DrawSequentialPoly (the gl_texsort 0 path)
//============================================================================

describe("R_DrawSequentialPoly", () => {
  function lightmappedSurface(): MsurfaceT {
    const face = new MsurfaceT();
    face.texinfo = makeTexinfo(makeTexture("seq", 31));
    face.flags = 0;
    face.styles[0] = 255;
    face.lightmaptexturenum = 3;
    const poly = new GlpolyT(1);
    poly.verts.set([0, 0, 0, 0.25, 0.5, 0.125, 0.375], 0);
    setSurfPolys(face, poly);
    return face;
  }

  test("draws the base texture then the lightmap in two passes without multitexture", () => {
    glState.gl_mtexable = false;
    const face = lightmappedSurface();

    R_DrawSequentialPoly(face);

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture").map((c) => c.args[1]);
    expect(binds).toEqual([31, glState.lightmap_textures + 3]);

    expect(rec.calls.filter((c) => c.name === "qglBegin" && c.args[0] === GL_POLYGON)).toHaveLength(2);

    const texcoords = rec.calls.filter((c) => c.name === "qglTexCoord2f").map((c) => c.args);
    expect(texcoords[0]).toEqual([0.25, 0.5]); // verts[3], verts[4]
    expect(texcoords[1]).toEqual([0.125, 0.375]); // verts[5], verts[6]

    const names = rec.calls.map((c) => c.name);
    expect(names.filter((n) => n === "qglEnable")).toHaveLength(1);
    expect(rec.calls.filter((c) => c.name === "qglEnable")[0].args[0]).toBe(GL_BLEND);
    expect(rec.calls.filter((c) => c.name === "qglDisable")[0].args[0]).toBe(GL_BLEND);

    // R_RenderDynamicLightmaps chained the poly and counted the surface
    expect(lightmap_polys[3]).toBe(surfPolys(face));
    expect(glState.c_brush_polys).toBe(1);
  });

  test("uses one multitextured pass when gl_mtexable is set", () => {
    glState.gl_mtexable = true;
    const face = lightmappedSurface();

    R_DrawSequentialPoly(face);

    expect(rec.calls.filter((c) => c.name === "qglBegin" && c.args[0] === GL_POLYGON)).toHaveLength(1);
    const mtex = rec.calls.filter((c) => c.name === "qglMTexCoord2fSGIS").map((c) => c.args);
    expect(mtex).toHaveLength(2);
    expect(mtex[0].slice(1)).toEqual([0.25, 0.5]);
    expect(mtex[1].slice(1)).toEqual([0.125, 0.375]);

    // texture env 0 is REPLACE, env 1 is BLEND
    const envs = rec.calls.filter((c) => c.name === "qglTexEnvf").map((c) => c.args);
    expect(envs[0]).toEqual([GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE]);
    expect(envs[1]).toEqual([GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_BLEND]);
    expect(glRsurfState.mtexenabled).toBe(true);
  });
});

//============================================================================
// R_MarkLeaves (gl_rsurf.c:1349 defines it; gl_rmain.c only declares/calls it)
//============================================================================

describe("R_MarkLeaves", () => {
  test("walks each visible leaf's parent chain, stopping at an already-marked node", () => {
    const world = new ModelT();
    world.lightdata = null;

    const node = new MnodeT();
    node.contents = 0;
    node.plane = new MplaneT();

    // leaf 0 is the solid leaf; cl.worldmodel->leafs[i+1] is what the C walks
    const solidLeaf = new MleafT();
    const leafA = new MleafT();
    const leafB = new MleafT();
    for (const l of [leafA, leafB]) {
      l.contents = CONTENTS_EMPTY;
      l.parent = node;
    }
    world.leafs = [solidLeaf, leafA, leafB];
    world.numleafs = 2;
    world.nodes = [node];
    world.numnodes = 1;
    cl.worldmodel = world;

    glState.r_viewleaf = leafA;
    glState.r_oldviewleaf = null;
    glState.r_visframecount = 5;
    r_novis.value = 1; // take the "everything is visible" path, no PVS needed

    R_MarkLeaves();

    expect(glState.r_visframecount).toBe(6);
    expect(glState.r_oldviewleaf === leafA).toBe(true);
    expect(leafA.visframe).toBe(6);
    expect(leafB.visframe).toBe(6);
    expect(node.visframe).toBe(6);
    expect(solidLeaf.visframe).toBe(0);
  });

  test("does nothing while drawing a mirror", () => {
    glState.mirror = true;
    glState.r_viewleaf = new MleafT();
    glState.r_oldviewleaf = null;
    glState.r_visframecount = 5;

    R_MarkLeaves();

    expect(glState.r_visframecount).toBe(5);
  });
});
