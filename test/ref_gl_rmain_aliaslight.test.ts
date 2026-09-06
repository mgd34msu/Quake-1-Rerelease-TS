// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
The lighting arithmetic in gl_rmain.c's R_DrawAliasModel: the R_LightPoint
seed, the "allways give the gun some light" floor of 24, the two overbright
clamps, ZOID's never-totally-black floor of 8 for player entities, the
progs/flame*.mdl full-light hack and the final `shadelight / 200.0`. The C
applies the flame hack AFTER both clamps, so 256 is what survives into
shadelight; these cases pin that order down.

Every case drives a QGLRecording installed as qglHolder.current, and every
shared singleton the suite writes (qglHolder, glState.currententity, cl,
cl_dlights, cl_entities, frustum, rmainState, r_shadows/gl_nocolors) is saved
in beforeAll and restored in afterAll, per standing orders 13 and 15.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { CONTENTS_EMPTY } from "../src/common/bspfile";
import { MleafT, MnodeT, ModelT, ModtypeT } from "../src/common/model";
import { MplaneT, PLANE_Z } from "../src/common/mathlib";
import { cl, cl_dlights, cl_entities, MAX_DLIGHTS } from "../src/client/client";
import { EntityT } from "../src/client/render";
import { frustum, glState } from "../src/ref_gl/glquake";
import { AliashdrT, MaliasframedescT } from "../src/ref_gl/gl_model_types";
import { QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { R_DrawAliasModel, gl_nocolors, r_shadows, rmainState } from "../src/ref_gl/gl_rmain";

const rec = new QGLRecording();

const saved = {
  qgl: qglHolder.current,
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  maxclients: cl.maxclients,
  currententity: glState.currententity,
  shadelight: rmainState.shadelight,
  ambientlight: rmainState.ambientlight,
  lastposenum: rmainState.lastposenum,
  shadedots: rmainState.shadedots,
  r_shadows: r_shadows.value,
  gl_nocolors: gl_nocolors.value,
  frustum: frustum.map((p) => ({ normal: [p.normal[0], p.normal[1], p.normal[2]], dist: p.dist, type: p.type, signbits: p.signbits })),
  dlights: cl_dlights.map((d) => ({ die: d.die, radius: d.radius })),
  viewentModel: cl.viewent.model,
  ent1Model: cl_entities[1].model,
};

/* A frustum that never culls: all four planes axial +x with a dist far behind
   any box the tests use, so BoxOnPlaneSide's PLANE_X fast path returns 1. */
function openFrustum(): void {
  for (let i = 0; i < 4; i++) {
    frustum[i].normal[0] = 1;
    frustum[i].normal[1] = 0;
    frustum[i].normal[2] = 0;
    frustum[i].dist = -1e9;
    frustum[i].type = 0;
    frustum[i].signbits = 0;
  }
}

/* The smallest aliashdr_t R_SetupAliasFrame + GL_DrawAliasFrame will walk:
   one frame, one pose, and a command list that is nothing but the
   terminating zero. */
function makeAliashdr(): AliashdrT {
  const hdr = new AliashdrT();
  hdr.numframes = 1;
  hdr.numposes = 1;
  hdr.poseverts = 0;
  hdr.numtris = 0;
  hdr.commands = new Int32Array(1); // [0] -- `if (!count) break;`
  const fr = new MaliasframedescT();
  fr.firstpose = 0;
  fr.numposes = 1;
  fr.interval = 0.1;
  hdr.frames.push(fr);
  return hdr;
}

function makeModel(name: string): ModelT {
  const mod = new ModelT();
  mod.name = name;
  mod.type = ModtypeT.mod_alias;
  mod.cache.data = makeAliashdr();
  return mod;
}

/* R_LightPoint returns 255 with no lightdata; with a worldmodel whose root
   node splits into two empty leafs, RecursiveLightPoint returns -1 and
   R_LightPoint turns that into 0. Those are the two seeds every case below
   needs. */
function setLightPoint(value: 0 | 255): void {
  if (value === 255) {
    cl.worldmodel = null;
    return;
  }
  const world = new ModelT();
  world.lightdata = new Uint8Array(1);
  const leaf = new MleafT();
  leaf.contents = CONTENTS_EMPTY;
  const node = new MnodeT();
  const plane = new MplaneT();
  plane.normal[2] = 1;
  plane.dist = -4096; // both ends of the -2048 trace stay in front
  plane.type = PLANE_Z;
  node.plane = plane;
  node.children = [leaf, leaf];
  world.nodes = [node];
  cl.worldmodel = world;
}

/* Runs R_DrawAliasModel on `e` and hands back what the lighting block left in
   rmainState. */
function draw(e: EntityT): { ambientlight: number; shadelight: number } {
  glState.currententity = e;
  R_DrawAliasModel(e);
  return { ambientlight: rmainState.ambientlight, shadelight: rmainState.shadelight };
}

function makeEntity(name: string): EntityT {
  const e = new EntityT();
  e.model = makeModel(name);
  e.origin[0] = 0;
  e.origin[1] = 0;
  e.origin[2] = 0;
  e.angles[0] = 0;
  e.angles[1] = 0;
  e.angles[2] = 0;
  return e;
}

beforeAll(() => {
  SetQGL(rec);
});

beforeEach(() => {
  rec.clear();
  openFrustum();
  cl.time = 0;
  cl.maxclients = 1;
  r_shadows.value = 0;
  gl_nocolors.value = 1; // skip the player-colormap GL_Bind branch
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    cl_dlights[i].die = -1;
    cl_dlights[i].radius = 0;
  }
});

afterAll(() => {
  SetQGL(saved.qgl);
  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  cl.maxclients = saved.maxclients;
  cl.viewent.model = saved.viewentModel;
  cl_entities[1].model = saved.ent1Model;
  glState.currententity = saved.currententity;
  rmainState.shadelight = saved.shadelight;
  rmainState.ambientlight = saved.ambientlight;
  rmainState.lastposenum = saved.lastposenum;
  rmainState.shadedots = saved.shadedots;
  r_shadows.value = saved.r_shadows;
  gl_nocolors.value = saved.gl_nocolors;
  for (let i = 0; i < 4; i++) {
    frustum[i].normal[0] = saved.frustum[i].normal[0];
    frustum[i].normal[1] = saved.frustum[i].normal[1];
    frustum[i].normal[2] = saved.frustum[i].normal[2];
    frustum[i].dist = saved.frustum[i].dist;
    frustum[i].type = saved.frustum[i].type;
    frustum[i].signbits = saved.frustum[i].signbits;
  }
  for (let i = 0; i < MAX_DLIGHTS; i++) {
    cl_dlights[i].die = saved.dlights[i].die;
    cl_dlights[i].radius = saved.dlights[i].radius;
  }
});

describe("R_DrawAliasModel lighting", () => {
  test("clamps a fully lit ordinary model to ambient 128 / shade 64", () => {
    setLightPoint(255);
    const { ambientlight, shadelight } = draw(makeEntity("progs/soldier.mdl"));

    // ambientlight = shadelight = 255; `if (ambientlight > 128) ambientlight = 128;`
    // then `if (ambientlight + shadelight > 192) shadelight = 192 - ambientlight;`
    expect(ambientlight).toBe(128);
    // shadelight is left as shadelight/200 by the end of the function
    expect(shadelight).toBeCloseTo(64 / 200.0, 10);
  });

  test("leaves a mid-lit model under both clamps untouched", () => {
    setLightPoint(0);
    const e = makeEntity("progs/soldier.mdl");
    // one dlight worth exactly 90 units at the entity origin
    cl_dlights[0].die = 1;
    cl_dlights[0].radius = 90;
    cl_dlights[0].origin[0] = 0;
    cl_dlights[0].origin[1] = 0;
    cl_dlights[0].origin[2] = 0;

    const { ambientlight, shadelight } = draw(e);

    // 0 + 90 = 90 for both; 90 <= 128 and 90 + 90 = 180 <= 192, so neither
    // clamp fires
    expect(ambientlight).toBe(90);
    expect(shadelight).toBeCloseTo(90 / 200.0, 10);
  });

  test("gives the view model a floor of 24 when R_LightPoint returns 0", () => {
    setLightPoint(0);
    cl.viewent.model = makeModel("progs/v_shot.mdl");
    cl.viewent.origin[0] = cl.viewent.origin[1] = cl.viewent.origin[2] = 0;
    cl.viewent.angles[0] = cl.viewent.angles[1] = cl.viewent.angles[2] = 0;

    const { ambientlight, shadelight } = draw(cl.viewent);

    expect(ambientlight).toBe(24);
    expect(shadelight).toBeCloseTo(24 / 200.0, 10);
  });

  test("gives an unlit player entity ZOID's floor of 8", () => {
    setLightPoint(0);
    cl.maxclients = 4;
    const e = cl_entities[1];
    e.model = makeModel("progs/player.mdl");
    e.origin[0] = e.origin[1] = e.origin[2] = 0;
    e.angles[0] = e.angles[1] = e.angles[2] = 0;

    const { ambientlight, shadelight } = draw(e);

    expect(ambientlight).toBe(8);
    expect(shadelight).toBeCloseTo(8 / 200.0, 10);
  });

  test("makes progs/flame2.mdl full light AFTER the clamps, so 256 survives", () => {
    setLightPoint(255);
    const { ambientlight, shadelight } = draw(makeEntity("progs/flame2.mdl"));

    expect(ambientlight).toBe(256);
    expect(shadelight).toBeCloseTo(256 / 200.0, 10);
    expect(shadelight).toBeCloseTo(1.28, 10);
  });

  test("makes progs/flame.mdl full light from an unlit sample too", () => {
    setLightPoint(0);
    const { ambientlight, shadelight } = draw(makeEntity("progs/flame.mdl"));

    expect(ambientlight).toBe(256);
    expect(shadelight).toBeCloseTo(1.28, 10);
  });

  test("shadedots row comes from angles[1] quantized to SHADEDOT_QUANT", () => {
    setLightPoint(255);
    const e = makeEntity("progs/soldier.mdl");
    e.angles[1] = 90; // (int)(90 * 16/360) = 4
    draw(e);
    const row4 = rmainState.shadedots;

    e.angles[1] = 0;
    draw(e);
    const row0 = rmainState.shadedots;

    expect(row4.length).toBe(256);
    expect(row0.length).toBe(256);
    expect(Array.from(row4)).not.toEqual(Array.from(row0));
  });
});
