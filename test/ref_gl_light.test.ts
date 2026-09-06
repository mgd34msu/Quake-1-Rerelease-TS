// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U072's src/ref_gl/gl_rlight.ts (R_AnimateLight, AddLightBlend,
R_RenderDlight/R_RenderDlights, R_MarkLights/R_PushDlights, R_LightPoint and
the `lightspot` GL_DrawAliasShadow reads) and src/ref_gl/gl_refrag.ts
(R_AddEfrags / R_RemoveEfrags / R_StoreEfrags), against the synthetic
single-node BSP test/support/bsp_builder.ts emits (one splitting plane z=0,
node owns both faces, front child leaf 1 is CONTENTS_EMPTY, back child leaf 0
is CONTENTS_SOLID).

The map loads with NO model loader hooks installed: src/common/model.ts's
Mod_LoadBrushModel already loads planes, nodes, leafs, faces, texinfo and
marksurfaces on the shared path, which is everything these two files read, and
src/ref_gl/gl_model.ts (U071) is a separate unit.

Self-sufficient per standing orders 13 and 15: qglHolder, glState, cl, the
dlights/lightstyles and the gl_rmain cvars this suite writes are restored in
afterAll.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { Mod_ForName, Mod_Init, ModelT, ModtypeT, setModelLoaderHooks } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { MAX_DLIGHTS, cl, cl_dlights, cl_efrags, cl_entities, cl_lightstyle, cl_visedicts, clState } from "../src/client/client";
import { EntityT, r_origin, vpn, vright, vup } from "../src/client/render";
import { d_lightstylevalue, glState } from "../src/ref_gl/glquake";
import { GL_BLEND, GL_ONE, GL_TEXTURE_2D, GL_TRIANGLE_FAN, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { AddLightBlend, R_AnimateLight, R_LightPoint, R_PushDlights, R_RenderDlights, lightspot, rlightState } from "../src/ref_gl/gl_rlight";
import { R_AddEfrags, R_RemoveEfrags, R_StoreEfrags, refragState } from "../src/ref_gl/gl_refrag";
import { gl_flashblend, v_blend } from "../src/ref_gl/gl_rmain";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "refgl-light-test-"));
const baseDir = join(scratchDir, "quake");

const MAP = "maps/refgllight.bsp";

const rec = new QGLRecording();

const saved = {
  qgl: qglHolder.current,
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  r_framecount: glState.r_framecount,
  r_dlightframecount: rlightState.r_dlightframecount,
  lightplane: rlightState.lightplane,
  lightspot: [lightspot[0], lightspot[1], lightspot[2]],
  cl_numvisedicts: clState.cl_numvisedicts,
  free_efrags: cl.free_efrags,
  gl_flashblend: gl_flashblend.value,
  v_blend: [v_blend[0], v_blend[1], v_blend[2], v_blend[3]],
  r_origin: [r_origin[0], r_origin[1], r_origin[2]],
  vpn: [vpn[0], vpn[1], vpn[2]],
  vright: [vright[0], vright[1], vright[2]],
  vup: [vup[0], vup[1], vup[2]],
  ent0Model: cl_entities[0].model,
  ent0Efrag: cl_entities[0].efrag,
  dlights: cl_dlights.map((l) => ({ origin: [l.origin[0], l.origin[1], l.origin[2]], radius: l.radius, die: l.die })),
  lightstyle10: { length: cl_lightstyle[10].length, map: cl_lightstyle[10].map },
  lightstyle63: { length: cl_lightstyle[63].length, map: cl_lightstyle[63].map },
  d_lightstylevalue0: d_lightstylevalue[0],
  d_lightstylevalue10: d_lightstylevalue[10],
  d_lightstylevalue63: d_lightstylevalue[63],
};

let world: InstanceType<typeof ModelT>;

beforeAll(() => {
  SetQGL(rec);

  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, `id1/${MAP}`, buildBsp());

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

  setModelLoaderHooks(null);
  const mod = Mod_ForName(MAP, true);
  if (mod === null) throw new Error(`expected ${MAP} to load`);
  world = mod;
});

beforeEach(() => {
  rec.clear();
});

afterAll(() => {
  SetQGL(saved.qgl);
  setModelLoaderHooks(null);
  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  glState.r_framecount = saved.r_framecount;
  rlightState.r_dlightframecount = saved.r_dlightframecount;
  rlightState.lightplane = saved.lightplane;
  lightspot[0] = saved.lightspot[0];
  lightspot[1] = saved.lightspot[1];
  lightspot[2] = saved.lightspot[2];
  clState.cl_numvisedicts = saved.cl_numvisedicts;
  cl.free_efrags = saved.free_efrags;
  gl_flashblend.value = saved.gl_flashblend;
  for (let i = 0; i < 4; i++) v_blend[i] = saved.v_blend[i];
  for (let i = 0; i < 3; i++) {
    r_origin[i] = saved.r_origin[i];
    vpn[i] = saved.vpn[i];
    vright[i] = saved.vright[i];
    vup[i] = saved.vup[i];
  }
  cl_entities[0].model = saved.ent0Model;
  cl_entities[0].efrag = saved.ent0Efrag;
  refragState.r_pefragtopnode = null;
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    cl_dlights[i].origin[0] = saved.dlights[i].origin[0];
    cl_dlights[i].origin[1] = saved.dlights[i].origin[1];
    cl_dlights[i].origin[2] = saved.dlights[i].origin[2];
    cl_dlights[i].radius = saved.dlights[i].radius;
    cl_dlights[i].die = saved.dlights[i].die;
  }
  cl_lightstyle[10].length = saved.lightstyle10.length;
  cl_lightstyle[10].map = saved.lightstyle10.map;
  cl_lightstyle[63].length = saved.lightstyle63.length;
  cl_lightstyle[63].map = saved.lightstyle63.map;
  d_lightstylevalue[0] = saved.d_lightstylevalue0;
  d_lightstylevalue[10] = saved.d_lightstylevalue10;
  d_lightstylevalue[63] = saved.d_lightstylevalue63;
});

function clearDlights(): void {
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    cl_dlights[i].origin[0] = 0;
    cl_dlights[i].origin[1] = 0;
    cl_dlights[i].origin[2] = 0;
    cl_dlights[i].radius = 0;
    cl_dlights[i].die = 0;
  }
}

describe("R_AnimateLight", () => {
  test("cl_lightstyle 'az' at cl.time 0.05 selects the first character", () => {
    cl_lightstyle[10].length = 2;
    cl_lightstyle[10].map = "az";
    cl_lightstyle[63].length = 0;
    cl_lightstyle[63].map = "";
    cl.time = 0.05;

    R_AnimateLight();

    // i = (int)(0.05*10) = 0; k = 0 % 2 = 0; 'a' - 'a' = 0; 0*22 = 0
    expect(d_lightstylevalue[10]).toBe(0);
    // no style length -> the constant "full bright" 256
    expect(d_lightstylevalue[63]).toBe(256);
  });

  test("'z' maps to 25*22", () => {
    cl_lightstyle[10].length = 2;
    cl_lightstyle[10].map = "az";
    cl.time = 0.15;

    R_AnimateLight();

    expect(d_lightstylevalue[10]).toBe(25 * 22);
  });
});

describe("AddLightBlend", () => {
  test("accumulates into v_blend, keeping gl_rlight.c's v_blend[1] source term on the red channel", () => {
    v_blend[0] = 0.9;
    v_blend[1] = 0.3;
    v_blend[2] = 0.2;
    v_blend[3] = 0.5;

    AddLightBlend(1, 0, 0, 0.5);

    // a = 0.5 + 0.5*(1-0.5) = 0.75; a2 = 0.5/0.75 = 2/3
    expect(v_blend[3]).toBeCloseTo(0.75, 6);
    // gl_rlight.c:70 reads v_blend[1] -- not v_blend[0] -- for the red term;
    // lines 71 and 72 read their own channel. The odd one out is kept as
    // shipped, so red decays towards the OLD green rather than the old red.
    expect(v_blend[0]).toBeCloseTo(0.3 * (1 / 3) + 1 * (2 / 3), 6);
    expect(v_blend[1]).toBeCloseTo(0.3 * (1 / 3), 6);
    expect(v_blend[2]).toBeCloseTo(0.2 * (1 / 3), 6);
  });
});

describe("R_RenderDlights", () => {
  test("does nothing when gl_flashblend is 0", () => {
    gl_flashblend.value = 0;
    clearDlights();
    cl_dlights[0].radius = 100;
    cl_dlights[0].die = 20;
    cl.time = 10;

    R_RenderDlights();

    expect(rec.calls.length).toBe(0);
  });

  test("emits the blend-state prologue, one 18-vertex fan per live dlight, and the epilogue", () => {
    gl_flashblend.value = 1;
    clearDlights();
    // far enough from r_origin that Length(v) >= rad and the fan is drawn
    cl_dlights[0].origin[0] = 1000;
    cl_dlights[0].radius = 100;
    cl_dlights[0].die = 20;
    cl.time = 10;
    glState.r_framecount = 5;

    r_origin[0] = r_origin[1] = r_origin[2] = 0;
    vpn[0] = 1;
    vpn[1] = 0;
    vpn[2] = 0;
    vright[0] = 0;
    vright[1] = -1;
    vright[2] = 0;
    vup[0] = 0;
    vup[1] = 0;
    vup[2] = 1;

    R_RenderDlights();

    expect(rlightState.r_dlightframecount).toBe(6);

    const seq = rec.calls.map((c) => c.name);
    expect(seq.slice(0, 5)).toEqual(["qglDepthMask", "qglDisable", "qglShadeModel", "qglEnable", "qglBlendFunc"]);
    expect(rec.calls[0].args).toEqual([false]);
    expect(rec.calls[1].args).toEqual([GL_TEXTURE_2D]);
    expect(rec.calls[3].args).toEqual([GL_BLEND]);
    expect(rec.calls[4].args).toEqual([GL_ONE, GL_ONE]);

    expect(rec.calls[5].name).toBe("qglBegin");
    expect(rec.calls[5].args).toEqual([GL_TRIANGLE_FAN]);
    expect(rec.calls[6].name).toBe("qglColor3f");
    expect(rec.calls[6].args).toEqual([0.2, 0.1, 0.0]);
    expect(rec.calls[7].name).toBe("qglVertex3fv");
    expect(rec.calls[8].name).toBe("qglColor3f");
    expect(rec.calls[8].args).toEqual([0, 0, 0]);
    // the C's `for (i=16 ; i>=0 ; i--)` ring is 17 more vertices
    expect(seq.filter((n) => n === "qglVertex3fv").length).toBe(18);

    expect(seq.slice(-6)).toEqual(["qglEnd", "qglColor3f", "qglDisable", "qglEnable", "qglBlendFunc", "qglDepthMask"]);
    expect(rec.calls[rec.calls.length - 1].args).toEqual([true]);
  });

  test("a dlight the view is inside blends into v_blend instead of drawing a fan", () => {
    gl_flashblend.value = 1;
    clearDlights();
    cl_dlights[0].origin[0] = 0;
    cl_dlights[0].radius = 100; // rad = 35, and the view sits at the origin
    cl_dlights[0].die = 20;
    cl.time = 10;
    r_origin[0] = r_origin[1] = r_origin[2] = 0;

    v_blend[0] = 0;
    v_blend[1] = 0;
    v_blend[2] = 0;
    v_blend[3] = 0;

    R_RenderDlights();

    expect(rec.calls.map((c) => c.name)).not.toContain("qglBegin");
    // AddLightBlend (1, 0.5, 0, radius*0.0003)
    expect(v_blend[3]).toBeCloseTo(100 * 0.0003, 6);
  });
});

describe("R_PushDlights", () => {
  test("marks a surface's dlightbits when gl_flashblend is 0", () => {
    cl.worldmodel = world;
    gl_flashblend.value = 0;

    clearDlights();
    cl_dlights[0].origin[0] = 0;
    cl_dlights[0].origin[1] = 0;
    cl_dlights[0].origin[2] = 0;
    cl_dlights[0].radius = 100;
    cl.time = 10;
    cl_dlights[0].die = 20;

    glState.r_framecount = 5;
    world.surfaces[0].dlightbits = 0;
    world.surfaces[0].dlightframe = 0;

    R_PushDlights();

    expect(rlightState.r_dlightframecount).toBe(6);
    expect(world.surfaces[0].dlightframe).toBe(6);
    expect(world.surfaces[0].dlightbits & 1).toBe(1);
  });

  test("does nothing at all when gl_flashblend is 1", () => {
    cl.worldmodel = world;
    gl_flashblend.value = 1;

    clearDlights();
    cl_dlights[0].radius = 100;
    cl.time = 10;
    cl_dlights[0].die = 20;

    glState.r_framecount = 50;
    rlightState.r_dlightframecount = 0;
    world.surfaces[0].dlightbits = 0;
    world.surfaces[0].dlightframe = 0;

    R_PushDlights();

    expect(rlightState.r_dlightframecount).toBe(0);
    expect(world.surfaces[0].dlightframe).toBe(0);
  });
});

describe("R_LightPoint", () => {
  test("returns 255 when the worldmodel has no lightdata", () => {
    cl.worldmodel = world;
    world.lightdata = null;

    const p = new Float32Array([0, 0, 64]);
    expect(R_LightPoint(p)).toBe(255);
  });

  test("samples a face's lightmap and records lightspot at the impact point", () => {
    cl.worldmodel = world;

    // force the initial "has lightdata" gate open; the actual sample below
    // comes from surf.samples directly, not from a real lightdata offset.
    world.lightdata = new Uint8Array(1);

    // the root node owns both faces (firstsurface=0, numsurfaces=2); the
    // texinfo bsp_builder emits maps s=x, t=y with no offset, so a point at
    // world (0,0,z) has s=0, t=0 -- inside [0,0]..[256,256].
    const surf = world.surfaces[0];
    surf.texturemins[0] = 0;
    surf.texturemins[1] = 0;
    surf.extents[0] = 256;
    surf.extents[1] = 256;
    surf.samples = new Uint8Array([128]);
    d_lightstylevalue[0] = 264;

    lightspot[0] = lightspot[1] = lightspot[2] = 999;

    const p = new Float32Array([0, 0, 64]);
    // gl_rlight.c's R_LightPoint has NO `if (r < r_refdef.ambientlight)` clamp
    // (that line is r_light.c's, the software twin)
    expect(R_LightPoint(p)).toBe((128 * 264) >> 8);

    // the trace runs from (0,0,64) straight down to (0,0,-1984) and crosses
    // the z=0 splitting plane
    expect(lightspot[0]).toBeCloseTo(0, 4);
    expect(lightspot[1]).toBeCloseTo(0, 4);
    expect(lightspot[2]).toBeCloseTo(0, 4);
    expect(rlightState.lightplane).not.toBeNull();

    world.lightdata = null;
    surf.samples = null;
  });
});

describe("R_AddEfrags / R_RemoveEfrags / R_StoreEfrags", () => {
  function makeEnt(): EntityT {
    const entModel = new ModelT();
    entModel.type = ModtypeT.mod_alias;
    entModel.mins[0] = -8;
    entModel.mins[1] = -8;
    entModel.mins[2] = -8;
    entModel.maxs[0] = 8;
    entModel.maxs[1] = 8;
    entModel.maxs[2] = 8;

    const ent = new EntityT();
    ent.model = entModel;
    ent.origin[0] = 0;
    ent.origin[1] = 0;
    ent.origin[2] = 100; // bbox z in [92,108], entirely above the z=0 split
    ent.visframe = -1;
    return ent;
  }

  function primeFreeEfrags(): void {
    cl_efrags[0].entnext = cl_efrags[1];
    cl_efrags[1].entnext = null;
    cl_efrags[0].leaf = null;
    cl_efrags[1].leaf = null;
    cl.free_efrags = cl_efrags[0];
  }

  test("links an entity into the empty leaf's efrag list, then unlinks it; R_StoreEfrags records it once per frame", () => {
    cl.worldmodel = world;

    const leaf1 = world.leafs[1];
    leaf1.efrags = null;
    primeFreeEfrags();

    const ent = makeEnt();

    R_AddEfrags(ent);

    expect(ent.efrag).not.toBeNull();
    expect(leaf1.efrags === ent.efrag).toBe(true);
    expect(ent.topnode).toBe(refragState.r_pefragtopnode);

    clState.cl_numvisedicts = 0;
    glState.r_framecount = 42;

    R_StoreEfrags(leaf1.efrags);
    expect(clState.cl_numvisedicts).toBe(1);
    expect(cl_visedicts[0]).toBe(ent);
    expect(ent.visframe).toBe(42);

    // a second pass in the same frame must not record it again
    R_StoreEfrags(leaf1.efrags);
    expect(clState.cl_numvisedicts).toBe(1);

    R_RemoveEfrags(ent);
    expect(ent.efrag).toBeNull();
    expect(leaf1.efrags).toBeNull();
  });

  test("gl_refrag.c has no 'never add the world' guard, so cl_entities[0] gets efragged too", () => {
    cl.worldmodel = world;

    const leaf1 = world.leafs[1];
    leaf1.efrags = null;
    primeFreeEfrags();

    const worldEnt = cl_entities[0];
    const entModel = new ModelT();
    entModel.type = ModtypeT.mod_brush;
    entModel.mins[0] = entModel.mins[1] = entModel.mins[2] = -8;
    entModel.maxs[0] = entModel.maxs[1] = entModel.maxs[2] = 8;
    worldEnt.model = entModel;
    worldEnt.efrag = null;
    worldEnt.origin[0] = 0;
    worldEnt.origin[1] = 0;
    worldEnt.origin[2] = 100;

    R_AddEfrags(worldEnt);

    expect(worldEnt.efrag).not.toBeNull();

    R_RemoveEfrags(worldEnt);
    expect(worldEnt.efrag).toBeNull();
    worldEnt.model = null;
    worldEnt.origin[2] = 0;
  });

  test("R_AddEfrags with no model does nothing", () => {
    cl.worldmodel = world;
    const ent = new EntityT();
    ent.model = null;
    ent.efrag = null;

    R_AddEfrags(ent);

    expect(ent.efrag).toBeNull();
  });
});
