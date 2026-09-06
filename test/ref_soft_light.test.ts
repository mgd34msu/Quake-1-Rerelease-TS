// Tests for src/ref_soft/r_light.ts (R_AnimateLight / R_LightPoint /
// R_PushDlights) and src/ref_soft/r_efrag.ts (R_AddEfrags / R_RemoveEfrags /
// R_StoreEfrags), against the synthetic single-node BSP
// test/support/bsp_builder.ts emits (one splitting plane z=0, node owns both
// faces, front child leaf 1 is CONTENTS_EMPTY, back child leaf 0 is
// CONTENTS_SOLID).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { Mod_ForName, Mod_Init, ModelT, ModtypeT, setModelLoaderHooks } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { softModelHooks } from "../src/ref_soft/model";
import { cl, cl_dlights, cl_efrags, cl_lightstyle, cl_visedicts, clState, MAX_DLIGHTS } from "../src/client/client";
import { EntityT, r_refdef } from "../src/client/render";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import { R_AnimateLight, R_LightPoint, R_PushDlights } from "../src/ref_soft/r_light";
import { R_AddEfrags, R_RemoveEfrags, R_StoreEfrags } from "../src/ref_soft/r_efrag";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "refsoft-light-test-"));
const baseDir = join(scratchDir, "quake");

const MAP = "maps/refsoftlight.bsp";

// A full snapshot rather than the individual r_framecount/r_dlightframecount
// fields alone: R_AddEfrags/R_StoreEfrags below (through R_AnimateLight's own
// R_MarkLights and R_LightPoint's tree walk) also leave rState.r_pefragtopnode
// pointing at a real MleafT instead of null, which test/ref_soft_types.test.ts's
// exhaustive "every field carries its C initial value" check catches; restore
// the whole singleton so no individually-touched field can be missed (rule 15).
const savedRState = { ...rState };

const saved = {
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  ambientlight: r_refdef.ambientlight,
  cl_numvisedicts: clState.cl_numvisedicts,
  free_efrags: cl.free_efrags,
  dlights: cl_dlights.map((l) => ({ origin: [l.origin[0], l.origin[1], l.origin[2]], radius: l.radius, die: l.die })),
  lightstyle10: { length: cl_lightstyle[10].length, map: cl_lightstyle[10].map },
  lightstyle63: { length: cl_lightstyle[63].length, map: cl_lightstyle[63].map },
  d_lightstylevalue10: d_lightstylevalue[10],
  d_lightstylevalue63: d_lightstylevalue[63],
};

let world: InstanceType<typeof ModelT>;

beforeAll(() => {
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

  setModelLoaderHooks(softModelHooks);
  const mod = Mod_ForName(MAP, true);
  if (mod === null) throw new Error(`expected ${MAP} to load`);
  world = mod;
});

afterAll(() => {
  setModelLoaderHooks(null);
  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  Object.assign(rState, savedRState);
  r_refdef.ambientlight = saved.ambientlight;
  clState.cl_numvisedicts = saved.cl_numvisedicts;
  cl.free_efrags = saved.free_efrags;
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
  d_lightstylevalue[10] = saved.d_lightstylevalue10;
  d_lightstylevalue[63] = saved.d_lightstylevalue63;
});

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
});

describe("R_LightPoint", () => {
  test("returns 255 when the worldmodel has no lightdata", () => {
    cl.worldmodel = world;
    expect(world.lightdata).toBeNull();

    const p = new Float32Array([0, 0, 64]);
    expect(R_LightPoint(p)).toBe(255);
  });

  test("samples a face's lightmap: 128 at style 0 = 264 -> 128*264>>8", () => {
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
    // styles[0] is already 0 from the built face; d_lightstylevalue[0] is
    // this test's only write to style 0's animated value.
    d_lightstylevalue[0] = 264;
    r_refdef.ambientlight = 0;

    const p = new Float32Array([0, 0, 64]);
    expect(R_LightPoint(p)).toBe((128 * 264) >> 8);
  });
});

describe("R_PushDlights", () => {
  test("marks a surface's dlightbits on the synthetic map", () => {
    cl.worldmodel = world;

    for (let i = 0; i < MAX_DLIGHTS; i++) {
      cl_dlights[i].origin[0] = 0;
      cl_dlights[i].origin[1] = 0;
      cl_dlights[i].origin[2] = 0;
      cl_dlights[i].radius = 0;
      cl_dlights[i].die = 0;
    }
    cl_dlights[0].origin[0] = 0;
    cl_dlights[0].origin[1] = 0;
    cl_dlights[0].origin[2] = 0;
    cl_dlights[0].radius = 100;
    cl.time = 10;
    cl_dlights[0].die = 20;

    rState.r_framecount = 5;
    world.surfaces[0].dlightbits = 0;
    world.surfaces[0].dlightframe = 0;

    R_PushDlights();

    expect(rState.r_dlightframecount).toBe(6);
    expect(world.surfaces[0].dlightframe).toBe(6);
    expect(world.surfaces[0].dlightbits & 1).toBe(1);
  });
});

describe("R_AddEfrags / R_RemoveEfrags / R_StoreEfrags", () => {
  test("link an entity into the empty leaf's efrag list, then unlink it; R_StoreEfrags records it once per frame", () => {
    cl.worldmodel = world;

    const leaf1 = world.leafs[1];
    leaf1.efrags = null;

    // a tiny free-efrag chain -- CL_ClearState's real setup isn't part of
    // this unit; two entries are enough for one linked entity.
    cl_efrags[0].entnext = cl_efrags[1];
    cl_efrags[1].entnext = null;
    cl.free_efrags = cl_efrags[0];

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

    R_AddEfrags(ent);

    expect(ent.efrag).not.toBeNull();
    expect(leaf1.efrags === ent.efrag).toBe(true);

    clState.cl_numvisedicts = 0;
    rState.r_framecount = 42;

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
});
