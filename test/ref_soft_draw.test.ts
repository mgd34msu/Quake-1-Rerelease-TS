// Tests for src/ref_soft/r_draw.ts (R_EmitEdge / R_ClipEdge / R_RenderFace),
// against a hand-built segment (for the edge-emission fixed-point math) and
// the synthetic single-node BSP test/support/bsp_builder.ts emits (for
// R_RenderFace's full per-face pass).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { Mod_ForName, Mod_Init, MedgeT, MvertexT, ModelT, setModelLoaderHooks } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { softModelHooks } from "../src/ref_soft/model";
import { EntityT, r_refdef } from "../src/client/render";
import { allocEdges, allocSurfaces, modelorg, newedges, removeedges, rState, vpn, vright, vup } from "../src/ref_soft/r_local";
import { R_BeginFaceEdges, R_ClipEdge, R_EmitEdge, R_RenderFace } from "../src/ref_soft/r_draw";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "refsoft-draw-test-"));
const baseDir = join(scratchDir, "quake");

const MAP = "maps/refsoftdraw.bsp";

const saved = {
  r_edges: rState.r_edges,
  edge_p: rState.edge_p,
  edge_max: rState.edge_max,
  surfaces: rState.surfaces,
  surface_p: rState.surface_p,
  surf_max: rState.surf_max,
  r_pedge: rState.r_pedge,
  xscale: rState.xscale,
  yscale: rState.yscale,
  xscaleinv: rState.xscaleinv,
  yscaleinv: rState.yscaleinv,
  xcenter: rState.xcenter,
  ycenter: rState.ycenter,
  insubmodel: rState.insubmodel,
  r_clipflags: rState.r_clipflags,
  r_currentkey: rState.r_currentkey,
  c_faceclip: rState.c_faceclip,
  r_outofsurfaces: rState.r_outofsurfaces,
  r_outofedges: rState.r_outofedges,
  r_polycount: rState.r_polycount,
  r_framecount: rState.r_framecount,
  currententity: rState.currententity,
  r_pcurrentvertbase: rState.r_pcurrentvertbase,
  modelorg: [modelorg[0], modelorg[1], modelorg[2]] as const,
  vright: [vright[0], vright[1], vright[2]] as const,
  vup: [vup[0], vup[1], vup[2]] as const,
  vpn: [vpn[0], vpn[1], vpn[2]] as const,
  fvrectx_adj: r_refdef.fvrectx_adj,
  fvrecty_adj: r_refdef.fvrecty_adj,
  fvrectright_adj: r_refdef.fvrectright_adj,
  fvrectbottom_adj: r_refdef.fvrectbottom_adj,
  vrect_x_adj_shift20: r_refdef.vrect_x_adj_shift20,
  vrectright_adj_shift20: r_refdef.vrectright_adj_shift20,
};

afterAll(() => {
  rState.r_edges = saved.r_edges;
  rState.edge_p = saved.edge_p;
  rState.edge_max = saved.edge_max;
  rState.surfaces = saved.surfaces;
  rState.surface_p = saved.surface_p;
  rState.surf_max = saved.surf_max;
  rState.r_pedge = saved.r_pedge;
  rState.xscale = saved.xscale;
  rState.yscale = saved.yscale;
  rState.xscaleinv = saved.xscaleinv;
  rState.yscaleinv = saved.yscaleinv;
  rState.xcenter = saved.xcenter;
  rState.ycenter = saved.ycenter;
  rState.insubmodel = saved.insubmodel;
  rState.r_clipflags = saved.r_clipflags;
  rState.r_currentkey = saved.r_currentkey;
  rState.c_faceclip = saved.c_faceclip;
  rState.r_outofsurfaces = saved.r_outofsurfaces;
  rState.r_outofedges = saved.r_outofedges;
  rState.r_polycount = saved.r_polycount;
  rState.r_framecount = saved.r_framecount;
  rState.currententity = saved.currententity;
  rState.r_pcurrentvertbase = saved.r_pcurrentvertbase;
  modelorg[0] = saved.modelorg[0];
  modelorg[1] = saved.modelorg[1];
  modelorg[2] = saved.modelorg[2];
  vright[0] = saved.vright[0];
  vright[1] = saved.vright[1];
  vright[2] = saved.vright[2];
  vup[0] = saved.vup[0];
  vup[1] = saved.vup[1];
  vup[2] = saved.vup[2];
  vpn[0] = saved.vpn[0];
  vpn[1] = saved.vpn[1];
  vpn[2] = saved.vpn[2];
  r_refdef.fvrectx_adj = saved.fvrectx_adj;
  r_refdef.fvrecty_adj = saved.fvrecty_adj;
  r_refdef.fvrectright_adj = saved.fvrectright_adj;
  r_refdef.fvrectbottom_adj = saved.fvrectbottom_adj;
  r_refdef.vrect_x_adj_shift20 = saved.vrect_x_adj_shift20;
  r_refdef.vrectright_adj_shift20 = saved.vrectright_adj_shift20;
});

// TransformVector (r_misc.ts) is world-to-view via vright/vup/vpn; using the
// world axes themselves as the view basis makes it the identity, so this
// suite's hand computations work directly off world-space coordinates.
function setUpIdentityView(): void {
  // R_RenderFace resets r_draw's emission statics before it emits; this suite
  // drives R_ClipEdge directly, so it runs that prologue itself (another
  // suite's R_RenderView leaves r_nearzionly set).
  R_BeginFaceEdges();
  modelorg[0] = 0;
  modelorg[1] = 0;
  modelorg[2] = 0;
  vright[0] = 1;
  vright[1] = 0;
  vright[2] = 0;
  vup[0] = 0;
  vup[1] = 1;
  vup[2] = 0;
  vpn[0] = 0;
  vpn[1] = 0;
  vpn[2] = 1;

  r_refdef.fvrectx_adj = -1e6;
  r_refdef.fvrecty_adj = -1e6;
  r_refdef.fvrectright_adj = 1e6;
  r_refdef.fvrectbottom_adj = 1e6;
  r_refdef.vrect_x_adj_shift20 = -2e9;
  r_refdef.vrectright_adj_shift20 = 2e9;
}

describe("R_ClipEdge / R_EmitEdge", () => {
  test("an unclipped segment inserts one edge at newedges[ceil(v0)] / removeedges[ceil(v1)-1]", () => {
    setUpIdentityView();

    rState.r_edges = allocEdges(16);
    rState.edge_p = 0;
    rState.edge_max = 16;
    rState.surfaces = allocSurfaces(8);
    rState.surface_p = 5;
    rState.surf_max = 9;
    rState.xscale = 100;
    rState.yscale = 100;
    rState.xcenter = 160;
    rState.ycenter = 100;
    rState.r_framecount = 1;

    const owner = new MedgeT();
    rState.r_pedge = owner;

    for (let i = 0; i < newedges.length; i++) {
      newedges[i] = null;
      removeedges[i] = null;
    }

    const pv0 = new MvertexT();
    pv0.position[0] = 1;
    pv0.position[1] = 8;
    pv0.position[2] = 10;
    const pv1 = new MvertexT();
    pv1.position[0] = 1;
    pv1.position[1] = 2;
    pv1.position[2] = 10;

    // hand computation (identity view, zi = 1/10 = 0.1, scale = xscale*zi = 10):
    //   u0 = 160 + 10*1 = 170, v0 = 100 - 10*8 = 20  -> ceil(v0) = 20
    //   u1 = 160 + 10*1 = 170, v1 = 100 - 10*2 = 80  -> ceil(v1) = 80
    // ceil(v0) < ceil(v1) -> trailing edge (side 0): v = 20, v2 = 79
    //   u_step = (u1-u0)/(v1-v0) = 0/60 = 0; u = u0 = 170
    //   edge.u = 170*0x100000 + 0xFFFFF = 179306495; edge.u_step = 0
    R_ClipEdge(pv0, pv1, null);

    const edge = newedges[20];
    expect(edge).not.toBeNull();
    if (edge === null) throw new Error("unreachable");

    expect(edge.owner === owner).toBe(true);
    expect(edge.surfs[0]).toBe(5);
    expect(edge.surfs[1]).toBe(0);
    expect(edge.u_step).toBe(0);
    expect(edge.u).toBe(179306495);
    expect(removeedges[79] === edge).toBe(true);
    expect(rState.edge_p).toBe(1);
  });

  test("R_EmitEdge is the same entry point R_ClipEdge falls through to with no clip planes", () => {
    setUpIdentityView();

    rState.r_edges = allocEdges(16);
    rState.edge_p = 0;
    rState.edge_max = 16;
    rState.surfaces = allocSurfaces(8);
    rState.surface_p = 0;
    rState.surf_max = 9;
    rState.xscale = 100;
    rState.yscale = 100;
    rState.xcenter = 160;
    rState.ycenter = 100;
    rState.r_framecount = 1;
    rState.r_pedge = new MedgeT();

    for (let i = 0; i < newedges.length; i++) {
      newedges[i] = null;
      removeedges[i] = null;
    }

    const pv0 = new MvertexT();
    pv0.position[0] = 1;
    pv0.position[1] = 8;
    pv0.position[2] = 10;
    const pv1 = new MvertexT();
    pv1.position[0] = 1;
    pv1.position[1] = 2;
    pv1.position[2] = 10;

    R_EmitEdge(pv0, pv1);

    expect(newedges[20]).not.toBeNull();
    expect(rState.edge_p).toBe(1);
  });
});

describe("R_RenderFace", () => {
  beforeAll(() => {
    ensureDir(join(baseDir, "id1"));
    writeGameFile(baseDir, `id1/${MAP}`, buildBsp());

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
    setModelLoaderHooks(null);
  });

  test("emits edges for the synthetic map's face and posts one SurfT", () => {
    setModelLoaderHooks(softModelHooks);
    const world = Mod_ForName(MAP, true);
    if (world === null) throw new Error(`expected ${MAP} to load`);

    setUpIdentityView();
    // the synthetic face sits at z=0; pull the "camera" back along -z so the
    // transformed depth is a sane positive number instead of getting
    // clamped up from 0 to NEAR_CLIP (which would blow up 1/z).
    modelorg[2] = -100;

    rState.r_edges = allocEdges(64);
    rState.edge_p = 0;
    rState.edge_max = 64;
    rState.surfaces = allocSurfaces(16);
    rState.surface_p = 0;
    rState.surf_max = 16;
    rState.xscale = 1;
    rState.yscale = 1;
    rState.xscaleinv = 1;
    rState.yscaleinv = 1;
    rState.xcenter = 160;
    rState.ycenter = 100;
    rState.insubmodel = false;
    rState.r_currentkey = 0;
    rState.c_faceclip = 0;
    rState.r_outofsurfaces = 0;
    rState.r_outofedges = 0;
    rState.r_polycount = 0;
    rState.r_framecount = 1;

    const ent = new EntityT();
    ent.model = world;
    rState.currententity = ent;
    rState.r_pcurrentvertbase = world.vertexes;

    for (let i = 0; i < newedges.length; i++) {
      newedges[i] = null;
      removeedges[i] = null;
    }

    const face = world.surfaces[0];

    R_RenderFace(face, 0);

    expect(rState.surface_p).toBe(1);
    if (rState.surfaces === null) throw new Error("unreachable");
    const surf = rState.surfaces[0];
    expect(surf.data).toBe(face);
    expect(Number.isFinite(surf.d_zistepu)).toBe(true);
    expect(Number.isFinite(surf.d_zistepv)).toBe(true);
    expect(Number.isFinite(surf.d_ziorigin)).toBe(true);
  });
});
