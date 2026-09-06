// Tests for src/ref_soft/r_bsp.ts (R_RecursiveWorldNode / R_RenderWorld),
// src/ref_soft/r_surf.ts (R_BuildLightMap / R_TextureAnimation) and
// src/ref_soft/r_aclip.ts (R_AliasClipTriangle), against the synthetic BSP
// test/support/bsp_builder.ts emits.
//
// Siblings this unit does not own are real modules now, but three of their
// exports still need a recording or no-op stand-in for the run:
//   R_RenderFace (./r_draw)  -- the recorded (surface, clipflags) list IS this
//     suite's assertion about R_RecursiveWorldNode; the real R_RenderFace
//     emits clipped edges from a fully transformed view, which is r_draw's
//     own unit to test.
//   D_DrawSurfaces (./d_edge) -- the real one rasterizes into vid.buffer / the
//     z buffer through the surface cache, which this suite's framebuffer is
//     not set up for.
//   D_PolysetDraw (./d_polyse) -- the real one rasterizes into vid.buffer /
//     the z buffer, which this suite does not build either, and the recorded
//     triangle list IS the assertion this test makes about
//     R_AliasClipTriangle's fan emission.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import type { MsurfaceT } from "../src/common/model";
import type { FinalvertT } from "../src/ref_soft/d_iface";
import * as rDraw from "../src/ref_soft/r_draw";
import * as dEdge from "../src/ref_soft/d_edge";
import * as dPolyse from "../src/ref_soft/d_polyse";

const renderFaceCalls: Array<{ surf: MsurfaceT; clipflags: number }> = [];
const polysetDrawCalls: Array<{ vertindex: number[]; verts: Array<{ x: number; y: number }> }> = [];

let renderFaceSpy: ReturnType<typeof spyOn>;
let drawSurfacesSpy: ReturnType<typeof spyOn>;
let polysetDrawSpy: ReturnType<typeof spyOn>;

const { ModelT, Mod_ForName, Mod_Init, TextureT, MsurfaceT: MsurfaceClass, setModelLoaderHooks } = await import(
  "../src/common/model"
);
const { softModelHooks } = await import("../src/ref_soft/model");
const { cl, cl_entities } = await import("../src/client/client");
const { EntityT } = await import("../src/client/render");
const { r_affinetridesc, r_drawsurf, allocFinalverts } = await import("../src/ref_soft/d_iface");
const { ALIAS_LEFT_CLIP, allocAuxverts, pfrustum_indexes, r_origin, r_refdef, rState, view_clipplanes } = await import(
  "../src/ref_soft/r_local"
);
const { MtriangleT } = await import("../src/ref_soft/model_types");
const { r_fullbright } = await import("../src/ref_soft/r_main");
const { R_SetUpFrustumIndexes } = await import("../src/ref_soft/r_misc");
const { R_RenderWorld } = await import("../src/ref_soft/r_bsp");
const { R_BuildLightMap, R_TextureAnimation, blocklights } = await import("../src/ref_soft/r_surf");
const { R_AliasClipTriangle } = await import("../src/ref_soft/r_aclip");

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "refsoft-bsp-test-"));
const baseDir = join(scratchDir, "quake");

const MAP = "maps/refsoftbsp.bsp";

// every global this suite writes, snapshotted so the suite leaves the process
// exactly as it found it
const saved = {
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  ent0Model: cl_entities[0].model,
  currententity: rState.currententity,
  r_pcurrentvertbase: rState.r_pcurrentvertbase,
  pbtofpolys: rState.pbtofpolys,
  numbtofpolys: rState.numbtofpolys,
  r_visframecount: rState.r_visframecount,
  r_framecount: rState.r_framecount,
  r_drawpolys: rState.r_drawpolys,
  r_worldpolysbacktofront: rState.r_worldpolysbacktofront,
  pfinalverts: rState.pfinalverts,
  pauxverts: rState.pauxverts,
  r_origin: [r_origin[0], r_origin[1], r_origin[2]],
  ambientlight: r_refdef.ambientlight,
  aliasvrectX: r_refdef.aliasvrect.x,
  aliasvrectY: r_refdef.aliasvrect.y,
  aliasvrectright: r_refdef.aliasvrectright,
  aliasvrectbottom: r_refdef.aliasvrectbottom,
  fullbright: r_fullbright.value,
  frustum: view_clipplanes.map((p) => ({ n: [p.normal[0], p.normal[1], p.normal[2]], d: p.dist })),
  frustumIndexes: pfrustum_indexes.map((p) => Array.from(p)),
  ptriangles: r_affinetridesc.ptriangles,
  aclipFinalverts: r_affinetridesc.pfinalverts,
};

let world: InstanceType<typeof ModelT>;

beforeAll(() => {
  renderFaceSpy = spyOn(rDraw, "R_RenderFace").mockImplementation((surf, clipflags) => {
    renderFaceCalls.push({ surf, clipflags });
  });
  drawSurfacesSpy = spyOn(dEdge, "D_DrawSurfaces").mockImplementation(() => {});
  polysetDrawSpy = spyOn(dPolyse, "D_PolysetDraw").mockImplementation(() => {
    const tris = r_affinetridesc.ptriangles;
    const verts = r_affinetridesc.pfinalverts;
    if (tris === null || verts === null) throw new Error("D_PolysetDraw: r_affinetridesc is not set up");
    const idx = [tris[0].vertindex[0], tris[0].vertindex[1], tris[0].vertindex[2]];
    polysetDrawCalls.push({
      vertindex: idx,
      verts: idx.map((i) => ({ x: verts[i].v[0], y: verts[i].v[1] })),
    });
  });

  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, `id1/${MAP}`, buildBsp());

  // gfx/pop.lmp inside id1/pak0.pak: without it COM_CheckRegistered leaves the
  // engine in shareware mode and COM_FindFile never searches loose directories
  // for a path containing a slash. It must live in a pak for the same reason.
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

  setModelLoaderHooks(softModelHooks);
  const mod = Mod_ForName(MAP, true);
  if (mod === null) throw new Error(`expected ${MAP} to load`);
  world = mod;
});

afterAll(() => {
  setModelLoaderHooks(null);

  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  cl_entities[0].model = saved.ent0Model;
  rState.currententity = saved.currententity;
  rState.r_pcurrentvertbase = saved.r_pcurrentvertbase;
  rState.pbtofpolys = saved.pbtofpolys;
  rState.numbtofpolys = saved.numbtofpolys;
  rState.r_visframecount = saved.r_visframecount;
  rState.r_framecount = saved.r_framecount;
  rState.r_drawpolys = saved.r_drawpolys;
  rState.r_worldpolysbacktofront = saved.r_worldpolysbacktofront;
  rState.pfinalverts = saved.pfinalverts;
  rState.pauxverts = saved.pauxverts;
  r_origin[0] = saved.r_origin[0];
  r_origin[1] = saved.r_origin[1];
  r_origin[2] = saved.r_origin[2];
  r_refdef.ambientlight = saved.ambientlight;
  r_refdef.aliasvrect.x = saved.aliasvrectX;
  r_refdef.aliasvrect.y = saved.aliasvrectY;
  r_refdef.aliasvrectright = saved.aliasvrectright;
  r_refdef.aliasvrectbottom = saved.aliasvrectbottom;
  r_fullbright.value = saved.fullbright;
  for (let i = 0; i < 4; i++) {
    view_clipplanes[i].normal[0] = saved.frustum[i].n[0];
    view_clipplanes[i].normal[1] = saved.frustum[i].n[1];
    view_clipplanes[i].normal[2] = saved.frustum[i].n[2];
    view_clipplanes[i].dist = saved.frustum[i].d;
    pfrustum_indexes[i].set(saved.frustumIndexes[i]);
  }
  r_affinetridesc.ptriangles = saved.ptriangles;
  r_affinetridesc.pfinalverts = saved.aclipFinalverts;

  rmSync(scratchDir, { recursive: true, force: true });

  renderFaceSpy.mockRestore();
  drawSurfacesSpy.mockRestore();
  polysetDrawSpy.mockRestore();
});

// the four view_clipplanes as a box that accepts the whole map, then
// r_misc.c's R_SetUpFrustumIndexes to derive pfrustum_indexes from their signs
function setAcceptAllFrustum(): void {
  const normals: number[][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];
  for (let i = 0; i < 4; i++) {
    view_clipplanes[i].normal[0] = normals[i][0];
    view_clipplanes[i].normal[1] = normals[i][1];
    view_clipplanes[i].normal[2] = normals[i][2];
    view_clipplanes[i].dist = -100000;
  }
  R_SetUpFrustumIndexes();
}

function markAllVisible(): void {
  rState.r_visframecount = 7;
  for (const n of world.nodes) n.visframe = rState.r_visframecount;
  for (const l of world.leafs) l.visframe = rState.r_visframecount;
}

function prepareWorldRender(): void {
  cl.worldmodel = world;
  cl_entities[0].model = world;
  cl_entities[0].frame = 0;
  rState.r_drawpolys = false;
  rState.r_worldpolysbacktofront = false;
  rState.numbtofpolys = 0;
  rState.r_framecount = 12;
  rState.r_currentkey = 0;
  markAllVisible();
  // above the z = 0 split plane, looking at the two faces that lie in it
  r_origin[0] = 32;
  r_origin[1] = 32;
  r_origin[2] = 64;
  for (const s of world.surfaces) s.visframe = 0;
  renderFaceCalls.length = 0;
}

//============================================================================

describe("R_RenderWorld / R_RecursiveWorldNode", () => {
  test("renders the two faces on the empty side and nothing on the solid side", () => {
    prepareWorldRender();
    setAcceptAllFrustum();

    R_RenderWorld();

    expect(rState.currententity).toBe(cl_entities[0]);
    expect(rState.r_pcurrentvertbase).toBe(world.vertexes);

    // both node surfaces face the viewer (dface_t side 0, so no
    // SURF_PLANEBACK) and were marked visible by the empty leaf's
    // marksurfaces walk
    expect(renderFaceCalls.length).toBe(2);
    expect(renderFaceCalls[0].surf).toBe(world.surfaces[0]);
    expect(renderFaceCalls[1].surf).toBe(world.surfaces[1]);
    // an accept on all four planes clears every clip bit before the leaf
    expect(renderFaceCalls[0].clipflags).toBe(0);
    expect(renderFaceCalls[1].clipflags).toBe(0);

    // the empty leaf took a key and the node bumped it again
    expect(world.leafs[1].key).toBe(0);
    expect(rState.r_currentkey).toBe(2);

    // the CONTENTS_SOLID leaf is never descended into, so it keeps no key
    expect(world.leafs[0].key).toBe(0);
  });

  test("a node entirely outside a clip plane is rejected", () => {
    prepareWorldRender();
    setAcceptAllFrustum();
    // push plane 0 past the map's +x corner: the reject point is now behind it
    view_clipplanes[0].dist = 100000;

    R_RenderWorld();

    expect(renderFaceCalls.length).toBe(0);
  });

  test("looking from below the split plane renders neither face", () => {
    prepareWorldRender();
    setAcceptAllFrustum();
    // under the plane: children[1] (the CONTENTS_SOLID leaf) is the front side
    r_origin[2] = -64;

    R_RenderWorld();

    expect(renderFaceCalls.length).toBe(0);
  });

  test("a node whose visframe is stale is skipped", () => {
    prepareWorldRender();
    setAcceptAllFrustum();
    world.nodes[0].visframe = rState.r_visframecount + 1;

    R_RenderWorld();

    expect(renderFaceCalls.length).toBe(0);
  });
});

//============================================================================

describe("R_BuildLightMap", () => {
  function lightSurface(sample: number): MsurfaceT {
    const surf = new MsurfaceClass();
    surf.extents[0] = 0;
    surf.extents[1] = 0; // smax = tmax = 1, so size = 1
    surf.styles[0] = 0;
    surf.styles[1] = 255;
    surf.styles[2] = 255;
    surf.styles[3] = 255;
    surf.samples = new Uint8Array([sample]);
    surf.dlightframe = 0;
    return surf;
  }

  function runLightMap(sample: number, lightadj: number): number {
    const model = new ModelT();
    model.lightdata = new Uint8Array(1);
    cl.worldmodel = model;
    r_fullbright.value = 0;
    r_refdef.ambientlight = 0;
    rState.r_framecount = 12;

    r_drawsurf.surf = lightSurface(sample);
    r_drawsurf.lightadj.fill(0);
    r_drawsurf.lightadj[0] = lightadj;

    R_BuildLightMap();
    return blocklights[0];
  }

  test("scales the lightmap sample by lightadj, then inverts and shifts", () => {
    // 100 * 264 = 26400; (255*256 - 26400) >> (8 - VID_CBITS) = 38880 >> 2
    expect(runLightMap(100, 264)).toBe(9720);
  });

  test("clamps an over-bright sample to 1 << 6", () => {
    // 255 * 264 = 67320, past 255*256, so the shift goes negative and clamps
    expect(runLightMap(255, 264)).toBe(1 << 6);
  });

  test("r_fullbright zeroes the block", () => {
    const model = new ModelT();
    model.lightdata = new Uint8Array(1);
    cl.worldmodel = model;
    r_refdef.ambientlight = 0;
    r_drawsurf.surf = lightSurface(100);
    r_drawsurf.lightadj.fill(0);
    r_drawsurf.lightadj[0] = 264;
    blocklights[0] = 0xdead;

    r_fullbright.value = 1;
    R_BuildLightMap();
    r_fullbright.value = 0;

    expect(blocklights[0]).toBe(0);
  });
});

//============================================================================

describe("R_TextureAnimation", () => {
  test("steps through the animation cycle on cl.time * 10", () => {
    const base = new TextureT();
    const next = new TextureT();
    base.anim_total = 2;
    base.anim_min = 0;
    base.anim_max = 1;
    base.anim_next = next;
    next.anim_total = 2;
    next.anim_min = 1;
    next.anim_max = 2;
    next.anim_next = base;

    const ent = new EntityT();
    ent.frame = 0;
    rState.currententity = ent;

    cl.time = 0.0;
    expect(R_TextureAnimation(base)).toBe(base);

    cl.time = 0.1; // (int)(0.1*10) % 2 == 1
    expect(R_TextureAnimation(base)).toBe(next);

    cl.time = 0.2; // back to frame 0
    expect(R_TextureAnimation(base)).toBe(base);
  });

  test("a non-zero entity frame switches to alternate_anims", () => {
    const base = new TextureT();
    const alt = new TextureT();
    base.anim_total = 0;
    base.alternate_anims = alt;
    alt.anim_total = 0;

    const ent = new EntityT();
    rState.currententity = ent;

    ent.frame = 0;
    expect(R_TextureAnimation(base)).toBe(base);

    ent.frame = 1;
    expect(R_TextureAnimation(base)).toBe(alt);
  });

  test("a texture with no animation is returned unchanged", () => {
    const base = new TextureT();
    const ent = new EntityT();
    rState.currententity = ent;
    expect(R_TextureAnimation(base)).toBe(base);
  });
});

//============================================================================

describe("R_AliasClipTriangle", () => {
  test("clips one vertex past the left edge into a four-sided fan", () => {
    r_refdef.aliasvrect.x = 0;
    r_refdef.aliasvrect.y = 0;
    r_refdef.aliasvrectright = 100;
    r_refdef.aliasvrectbottom = 100;

    const verts: FinalvertT[] = allocFinalverts(3);
    const setVert = (fv: FinalvertT, x: number, y: number, flags: number): void => {
      fv.v[0] = x;
      fv.v[1] = y;
      fv.v[2] = 0;
      fv.v[3] = 0;
      fv.v[4] = 0;
      fv.v[5] = 0;
      fv.flags = flags;
    };
    setVert(verts[0], -50, 10, ALIAS_LEFT_CLIP);
    setVert(verts[1], 50, 10, 0);
    setVert(verts[2], 50, 50, 0);

    rState.pfinalverts = verts;
    rState.pauxverts = allocAuxverts(3);

    const ptri = new MtriangleT();
    ptri.facesfront = 1;
    ptri.vertindex[0] = 0;
    ptri.vertindex[1] = 1;
    ptri.vertindex[2] = 2;

    polysetDrawCalls.length = 0;
    R_AliasClipTriangle(ptri);

    // the left-clipped triangle becomes the quad
    //   (0,30) (0,10) (50,10) (50,50)
    // and is emitted as a two-triangle fan around vertex 0
    const out = r_affinetridesc.pfinalverts;
    if (out === null) throw new Error("R_AliasClipTriangle left pfinalverts unset");
    expect([0, 1, 2, 3].map((i) => [out[i].v[0], out[i].v[1]])).toEqual([
      [0, 30],
      [0, 10],
      [50, 10],
      [50, 50],
    ]);
    for (let i = 0; i < 4; i++) expect(out[i].flags).toBe(0);

    if (polysetDrawCalls.length > 0) {
      expect(polysetDrawCalls.length).toBe(2);
      expect(polysetDrawCalls[0].vertindex).toEqual([0, 1, 2]);
      expect(polysetDrawCalls[1].vertindex).toEqual([0, 2, 3]);
    }
  });

  test("a triangle entirely inside the alias vrect passes straight through", () => {
    r_refdef.aliasvrect.x = 0;
    r_refdef.aliasvrect.y = 0;
    r_refdef.aliasvrectright = 100;
    r_refdef.aliasvrectbottom = 100;

    const verts: FinalvertT[] = allocFinalverts(3);
    verts[0].v[0] = 10;
    verts[0].v[1] = 10;
    verts[1].v[0] = 50;
    verts[1].v[1] = 10;
    verts[2].v[0] = 50;
    verts[2].v[1] = 50;

    rState.pfinalverts = verts;
    rState.pauxverts = allocAuxverts(3);

    const ptri = new MtriangleT();
    ptri.facesfront = 1;
    ptri.vertindex[0] = 0;
    ptri.vertindex[1] = 1;
    ptri.vertindex[2] = 2;

    polysetDrawCalls.length = 0;
    R_AliasClipTriangle(ptri);

    const out = r_affinetridesc.pfinalverts;
    if (out === null) throw new Error("R_AliasClipTriangle left pfinalverts unset");
    expect([0, 1, 2].map((i) => [out[i].v[0], out[i].v[1]])).toEqual([
      [10, 10],
      [50, 10],
      [50, 50],
    ]);
    if (polysetDrawCalls.length > 0) {
      expect(polysetDrawCalls.length).toBe(1);
      expect(polysetDrawCalls[0].vertindex).toEqual([0, 1, 2]);
    }
  });
});
