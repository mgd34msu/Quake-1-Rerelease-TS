// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Self-sufficient test for U16's client-side interpolation additions to
src/ref_gl/gl_rmain.ts: R_SetupAliasFrame's two-pose lerp bookkeeping
(lerpstart/lerptime/previouspose/currentpose, the LERP_RESETANIM/
LERP_RESETANIM2 resets), R_SetupEntityTransform's MOVETYPE_STEP
(LERP_MOVESTEP) movement blend under r_lerpmove, GL_DrawAliasFrame's
two-pose vertex blend, the r_nolerp_list snap (a listed model never blends
even mid-lerp), and R_RotateForEntity's entity-scale qglScalef.

Every case drives a QGLRecording installed as qglHolder.current. Every
shared singleton this file writes (qglHolder, glState.currententity, cl.time/
cl.worldmodel/cl.viewent, cl_entities[1], frustum, rmainState, r_lerpmodels/
r_lerpmove/r_shadows/gl_nocolors, r_nolerp_list) is saved in beforeAll and
restored in afterAll, per standing orders 13 and 15.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { ModelT, ModtypeT } from "../src/common/model";
import { TrivertxT } from "../src/common/modelgen";
import { ENTSCALE_ENCODE } from "../src/common/protocol";
import { cl, cl_entities } from "../src/client/client";
import { EntityT, LERP_FINISH, LERP_MOVESTEP, LERP_RESETANIM, LERP_RESETANIM2, LERP_RESETMOVE, r_lerpmodels, r_lerpmove } from "../src/client/render";
import { frustum, glState, r_nolerp_list } from "../src/ref_gl/glquake";
import { AliashdrT, MaliasframedescT, MspriteT, MspriteframeT, MspriteframedescT } from "../src/ref_gl/gl_model_types";
import { SPR_VP_PARALLEL, SpriteframetypeT } from "../src/common/spritegn";
import { GL_TRIANGLE_FAN, GLPointer, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { GL_DrawAliasFrame, R_DrawAliasModel, R_DrawSpriteModel, R_SetupAliasFrame, R_SetupEntityTransform, gl_nocolors, r_shadows, rmainState } from "../src/ref_gl/gl_rmain";
import { vright, vup } from "../src/client/render";

// R_DrawSpriteModel reuses one scratch vec3 (`spritePoint`) across all four
// corners, exactly as the C's `vec3_t point` does -- QGLRecording stores
// glVertex3fv's argument by reference, so reading it back after the draw
// would show only the last corner four times over. This subclass snapshots
// each call's value at the time it was made (test/ref_gl_main.test.ts's own
// SnapshottingQGL does the same, for the same reason).
class SnapshottingQGL extends QGLRecording {
  readonly vertex3fv: number[][] = [];

  override qglVertex3fv(v: GLPointer): void {
    if (v instanceof Float32Array) this.vertex3fv.push([v[0], v[1], v[2]]);
    super.qglVertex3fv(v);
  }
}

const rec = new SnapshottingQGL();

const saved = {
  qgl: qglHolder.current,
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  maxclients: cl.maxclients,
  currententity: glState.currententity,
  shadelight: rmainState.shadelight,
  ambientlight: rmainState.ambientlight,
  lastpose1: rmainState.lastpose1,
  lastpose2: rmainState.lastpose2,
  lastblend: rmainState.lastblend,
  shadedots: rmainState.shadedots,
  r_shadows: r_shadows.value,
  gl_nocolors: gl_nocolors.value,
  r_lerpmodels: r_lerpmodels.value,
  r_lerpmove: r_lerpmove.value,
  r_nolerp_list: r_nolerp_list.string,
  frustum: frustum.map((p) => ({ normal: [p.normal[0], p.normal[1], p.normal[2]], dist: p.dist, type: p.type, signbits: p.signbits })),
  ent1Model: cl_entities[1].model,
  viewentModel: cl.viewent.model,
  vup: [vup[0], vup[1], vup[2]],
  vright: [vright[0], vright[1], vright[2]],
};

// A frustum that never culls (same recipe test/ref_gl_rmain_aliaslight.test.ts
// uses, written out fresh here per this file's own self-sufficiency).
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

beforeEach(() => {
  rec.clear();
  rec.vertex3fv.length = 0;
  SetQGL(rec);
  openFrustum();
  cl.worldmodel = null; // R_LightPoint returns 255 with no lightdata
  cl.maxclients = 1;
  cl.time = 0;
  r_shadows.value = 0;
  gl_nocolors.value = 1; // skip the player-colormap GL_Bind branch
  r_lerpmodels.value = 1;
  r_lerpmove.value = 1;
});

afterAll(() => {
  SetQGL(saved.qgl);
  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  cl.maxclients = saved.maxclients;
  glState.currententity = saved.currententity;
  rmainState.shadelight = saved.shadelight;
  rmainState.ambientlight = saved.ambientlight;
  rmainState.lastpose1 = saved.lastpose1;
  rmainState.lastpose2 = saved.lastpose2;
  rmainState.lastblend = saved.lastblend;
  rmainState.shadedots = saved.shadedots;
  r_shadows.value = saved.r_shadows;
  gl_nocolors.value = saved.gl_nocolors;
  r_lerpmodels.value = saved.r_lerpmodels;
  r_lerpmove.value = saved.r_lerpmove;
  r_nolerp_list.string = saved.r_nolerp_list;
  for (let i = 0; i < 4; i++) {
    frustum[i].normal[0] = saved.frustum[i].normal[0];
    frustum[i].normal[1] = saved.frustum[i].normal[1];
    frustum[i].normal[2] = saved.frustum[i].normal[2];
    frustum[i].dist = saved.frustum[i].dist;
    frustum[i].type = saved.frustum[i].type;
    frustum[i].signbits = saved.frustum[i].signbits;
  }
  cl_entities[1].model = saved.ent1Model;
  cl.viewent.model = saved.viewentModel;
  vup[0] = saved.vup[0];
  vup[1] = saved.vup[1];
  vup[2] = saved.vup[2];
  vright[0] = saved.vright[0];
  vright[1] = saved.vright[1];
  vright[2] = saved.vright[2];
});

// A two-pose aliashdr: frame 0 cycles between pose 0 and pose 1 every 0.2s
// (MaliasframedescT.interval), poseverts=1 so GL_DrawAliasFrame's command
// list walks exactly one vertex.
function makeTwoPoseAliashdr(): AliashdrT {
  const hdr = new AliashdrT();
  hdr.numframes = 1;
  hdr.numposes = 2;
  hdr.poseverts = 1;
  hdr.numtris = 1;
  const fr = new MaliasframedescT();
  fr.firstpose = 0;
  fr.numposes = 2;
  fr.interval = 0.2;
  hdr.frames.push(fr);

  const v0 = new TrivertxT();
  v0.v[0] = 0;
  v0.v[1] = 0;
  v0.v[2] = 0;
  v0.lightnormalindex = 0;
  const v1 = new TrivertxT();
  v1.v[0] = 10;
  v1.v[1] = 20;
  v1.v[2] = 30;
  v1.lightnormalindex = 0;
  hdr.posedata = [v0, v1];

  // gl_mesh.c's layout: [count][s0 t0][0] -- one GL_TRIANGLE_FAN vertex.
  const buf = new ArrayBuffer(4 * 4);
  const cmdI = new Int32Array(buf);
  const cmdF = new Float32Array(buf);
  cmdI[0] = -1; // negative count -> GL_TRIANGLE_FAN, one vertex
  cmdF[1] = 0.0;
  cmdF[2] = 0.0;
  cmdI[3] = 0; // terminator
  hdr.commands = cmdI;
  return hdr;
}

function makeModel(name: string, hdr: AliashdrT): ModelT {
  const mod = new ModelT();
  mod.name = name;
  mod.type = ModtypeT.mod_alias;
  mod.cache.data = hdr;
  return mod;
}

//============================================================================
// R_SetupAliasFrame -- pose/blend bookkeeping
//============================================================================

describe("R_SetupAliasFrame", () => {
  test("advances through a full lerp: blend 0 right at the pose change, blend 0.5 halfway through the interval", () => {
    const hdr = makeTwoPoseAliashdr();
    const e = new EntityT();
    e.lerpflags = 0;
    e.previouspose = 0;
    e.currentpose = 0;
    e.lerpstart = 0;

    const lerpdata = { pose1: 0, pose2: 0, blend: 0 };

    cl.time = 0;
    R_SetupAliasFrame(e, 0, hdr, false, lerpdata);
    expect(lerpdata.pose1).toBe(0);
    expect(lerpdata.pose2).toBe(0);
    expect(lerpdata.blend).toBe(0);

    // exactly at the pose-1 boundary: the new pose has just started, blend 0
    cl.time = 0.2;
    R_SetupAliasFrame(e, 0, hdr, false, lerpdata);
    expect(e.previouspose).toBe(0);
    expect(e.currentpose).toBe(1);
    expect(lerpdata.pose1).toBe(0);
    expect(lerpdata.pose2).toBe(1);
    expect(lerpdata.blend).toBeCloseTo(0, 6);

    // halfway through that 0.2s interval
    cl.time = 0.3;
    R_SetupAliasFrame(e, 0, hdr, false, lerpdata);
    expect(e.previouspose).toBe(0);
    expect(e.currentpose).toBe(1);
    expect(lerpdata.pose1).toBe(0);
    expect(lerpdata.pose2).toBe(1);
    expect(lerpdata.blend).toBeCloseTo(0.5, 6);
  });

  test("LERP_RESETANIM kills any lerp in progress and clears the flag", () => {
    const hdr = makeTwoPoseAliashdr();
    const e = new EntityT();
    e.lerpflags = LERP_RESETANIM;
    e.previouspose = 5;
    e.currentpose = 5;
    e.lerpstart = 3;
    cl.time = 0.3; // posenum would be 1

    const lerpdata = { pose1: 0, pose2: 0, blend: 0 };
    R_SetupAliasFrame(e, 0, hdr, false, lerpdata);

    expect(e.lerpflags & LERP_RESETANIM).toBe(0);
    expect(e.lerpstart).toBe(0);
    expect(e.previouspose).toBe(1);
    expect(e.currentpose).toBe(1);
    expect(lerpdata.pose1).toBe(1);
    expect(lerpdata.pose2).toBe(1);
    // lerpstart landed at 0 (the reset), so cl.time===0.3 is already past the
    // 0.2s interval -- blend clamps to 1, so pose1 catches up to pose2.
    expect(lerpdata.blend).toBe(1);
  });

  test("a nolerp model snaps to the current pose (blend 1, pose1 === pose2) even mid-lerp", () => {
    const hdr = makeTwoPoseAliashdr();
    const e = new EntityT();
    e.lerpflags = 0;
    e.previouspose = 0;
    e.currentpose = 1;
    e.lerpstart = 0.2;
    e.lerptime = 0.2;
    cl.time = 0.3; // would be blend 0.5 if this model lerped

    const lerpdata = { pose1: 0, pose2: 0, blend: 0 };
    R_SetupAliasFrame(e, 0, hdr, /* noLerp */ true, lerpdata);

    expect(lerpdata.pose1).toBe(e.currentpose);
    expect(lerpdata.pose2).toBe(e.currentpose);
    expect(lerpdata.blend).toBe(1);
  });

  test("r_lerpmodels 0 also snaps to the current pose, ignoring noLerp entirely", () => {
    r_lerpmodels.value = 0;
    const hdr = makeTwoPoseAliashdr();
    const e = new EntityT();
    e.lerpflags = 0;
    e.previouspose = 0;
    e.currentpose = 1;
    e.lerpstart = 0.2;
    e.lerptime = 0.2;
    cl.time = 0.3;

    const lerpdata = { pose1: 0, pose2: 0, blend: 0 };
    R_SetupAliasFrame(e, 0, hdr, false, lerpdata);

    expect(lerpdata.pose1).toBe(1);
    expect(lerpdata.pose2).toBe(1);
    expect(lerpdata.blend).toBe(1);
  });

  test("LERP_FINISH uses lerpfinish instead of assuming a 0.1s interval, for a single-pose frame", () => {
    const hdr = new AliashdrT();
    hdr.numframes = 1;
    const fr = new MaliasframedescT();
    fr.firstpose = 0;
    fr.numposes = 1;
    hdr.frames.push(fr);

    const e = new EntityT();
    e.lerpflags = LERP_FINISH;
    e.previouspose = 0;
    e.currentpose = 0;
    e.lerpstart = 0;
    e.lerpfinish = 0.4; // finishes at cl.time===0.4, not the assumed 0.1s

    const lerpdata = { pose1: 0, pose2: 0, blend: 0 };
    cl.time = 0.2; // halfway to lerpfinish
    R_SetupAliasFrame(e, 0, hdr, false, lerpdata);

    expect(lerpdata.blend).toBeCloseTo(0.5, 6);
  });
});

//============================================================================
// R_SetupEntityTransform -- MOVETYPE_STEP movement lerp under r_lerpmove
//============================================================================

describe("R_SetupEntityTransform", () => {
  test("a non-LERP_MOVESTEP entity always draws at its own raw origin/angles", () => {
    const e = new EntityT();
    e.lerpflags = 0;
    e.origin.set([10, 20, 30]);
    e.angles.set([1, 2, 3]);
    e.currentorigin.set([0, 0, 0]);
    e.currentangles.set([0, 0, 0]);

    const lerpdata = { origin: new Float32Array(3), angles: new Float32Array(3) };
    R_SetupEntityTransform(e, lerpdata);

    expect(Array.from(lerpdata.origin)).toEqual([10, 20, 30]);
    expect(Array.from(lerpdata.angles)).toEqual([1, 2, 3]);
  });

  test("r_lerpmove 1 blends a LERP_MOVESTEP entity's transform between previousorigin and currentorigin", () => {
    r_lerpmove.value = 1;
    const e = new EntityT();
    e.lerpflags = LERP_MOVESTEP;
    // first call: origin/angles just changed from currentorigin/currentangles
    // (both start at [0,0,0] by construction) -- starts a new move-lerp
    e.origin.set([10, 0, 0]);
    e.angles.set([0, 0, 0]);
    cl.time = 1.0;

    const lerpdata = { origin: new Float32Array(3), angles: new Float32Array(3) };
    R_SetupEntityTransform(e, lerpdata);

    expect(e.movelerpstart).toBe(1.0);
    expect(Array.from(e.previousorigin)).toEqual([0, 0, 0]);
    expect(Array.from(e.currentorigin)).toEqual([10, 0, 0]);

    // halfway through the assumed 0.1s move interval
    cl.time = 1.05;
    R_SetupEntityTransform(e, lerpdata);
    expect(lerpdata.origin[0]).toBeCloseTo(5, 5);
  });

  test("r_lerpmove 0 never applies the MOVETYPE_STEP blend, even with LERP_MOVESTEP set", () => {
    r_lerpmove.value = 0;
    const e = new EntityT();
    e.lerpflags = LERP_MOVESTEP;
    e.origin.set([10, 0, 0]);
    e.currentorigin.set([0, 0, 0]);
    cl.time = 1.0;

    const lerpdata = { origin: new Float32Array(3), angles: new Float32Array(3) };
    R_SetupEntityTransform(e, lerpdata);

    // r_lerpmove 0: "don't lerp" branch -- always the entity's own raw origin
    expect(Array.from(lerpdata.origin)).toEqual([10, 0, 0]);
  });

  test("LERP_RESETMOVE kills any move-lerp in progress and clears the flag", () => {
    const e = new EntityT();
    e.lerpflags = LERP_RESETMOVE | LERP_MOVESTEP;
    e.origin.set([5, 5, 5]);
    e.angles.set([1, 1, 1]);
    e.previousorigin.set([99, 99, 99]);
    e.currentorigin.set([99, 99, 99]);

    const lerpdata = { origin: new Float32Array(3), angles: new Float32Array(3) };
    R_SetupEntityTransform(e, lerpdata);

    expect(e.lerpflags & LERP_RESETMOVE).toBe(0);
    expect(Array.from(e.previousorigin)).toEqual([5, 5, 5]);
    expect(Array.from(e.currentorigin)).toEqual([5, 5, 5]);
    expect(Array.from(lerpdata.origin)).toEqual([5, 5, 5]);
  });
});

//============================================================================
// GL_DrawAliasFrame -- the two-pose vertex blend
//============================================================================

describe("GL_DrawAliasFrame two-pose blend", () => {
  test("blend 0.5 averages the two poses' vertex positions and shadedots", () => {
    const hdr = makeTwoPoseAliashdr();
    rmainState.shadelightColor[0] = 1;
    rmainState.shadelightColor[1] = 1;
    rmainState.shadelightColor[2] = 1;
    rmainState.alpha = 1;
    const dots = rmainState.shadedots;

    GL_DrawAliasFrame(hdr, 0, 1, 0.5);

    expect(rmainState.lastpose1).toBe(0);
    expect(rmainState.lastpose2).toBe(1);
    expect(rmainState.lastblend).toBe(0.5);

    const vertexCall = rec.calls.find((c) => c.name === "qglVertex3f");
    expect(vertexCall?.args).toEqual([5, 10, 15]); // (0,0,0)*0.5 + (10,20,30)*0.5
    const colorCall = rec.calls.find((c) => c.name === "qglColor3f");
    // both poses share lightnormalindex 0, so the blended dot equals the
    // unblended one -- pins the color-blend formula without a second index.
    expect(colorCall?.args).toEqual([dots[0], dots[0], dots[0]]);
    const beginCall = rec.calls.find((c) => c.name === "qglBegin");
    expect(beginCall?.args).toEqual([GL_TRIANGLE_FAN]);
  });

  test("pose1 === pose2 draws the classic single-pose body (no blend arithmetic)", () => {
    const hdr = makeTwoPoseAliashdr();
    rmainState.shadelightColor[0] = 1;
    rmainState.shadelightColor[1] = 1;
    rmainState.shadelightColor[2] = 1;
    rmainState.alpha = 1;

    GL_DrawAliasFrame(hdr, 1, 1, 0.5); // blend is irrelevant when the poses match

    const vertexCall = rec.calls.find((c) => c.name === "qglVertex3f");
    expect(vertexCall?.args).toEqual([10, 20, 30]); // pose 1's own vertex, untouched
  });
});

//============================================================================
// R_DrawAliasModel -- end-to-end: entity scale and the nolerp-list snap
//============================================================================

describe("R_DrawAliasModel", () => {
  function makeEntity(name: string, hdr: AliashdrT): EntityT {
    const e = new EntityT();
    e.model = makeModel(name, hdr);
    e.origin.set([0, 0, 0]);
    e.angles.set([0, 0, 0]);
    return e;
  }

  test("a non-default entity scale emits qglScalef with the ENTSCALE_DECODE factor", () => {
    const hdr = makeTwoPoseAliashdr();
    hdr.frames[0].numposes = 1; // avoid the animation-pose lerp entirely for this check
    const e = makeEntity("progs/soldier.mdl", hdr);
    e.scale = ENTSCALE_ENCODE(2.0);
    glState.currententity = e;

    R_DrawAliasModel(e);

    const scaleCalls = rec.calls.filter((c) => c.name === "qglScalef");
    // the entity's own ENTSCALE_DECODE(2.0) scale, applied once by
    // R_RotateForEntity before the model's own internal scale_origin/scale
    expect(scaleCalls.some((c) => c.args[0] === 2 && c.args[1] === 2 && c.args[2] === 2)).toBe(true);
  });

  test("a model listed in r_nolerp_list never blends, even mid-lerp", () => {
    r_nolerp_list.string = "progs/flame.mdl";
    const hdr = makeTwoPoseAliashdr();
    const e = makeEntity("progs/flame.mdl", hdr);
    // put the entity mid-lerp (blend 0.5, per R_SetupAliasFrame's own test above)
    e.lerpflags = 0;
    e.previouspose = 0;
    e.currentpose = 1;
    e.lerpstart = 0.2;
    e.lerptime = 0.2;
    cl.time = 0.3;
    glState.currententity = e;

    R_DrawAliasModel(e);

    expect(rmainState.lastpose1).toBe(rmainState.lastpose2);
    expect(rmainState.lastblend).toBe(1);
  });

  test("a model NOT in r_nolerp_list blends normally at the same mid-lerp point", () => {
    r_nolerp_list.string = "progs/flame.mdl"; // does not name this model
    const hdr = makeTwoPoseAliashdr();
    const e = makeEntity("progs/ogre.mdl", hdr);
    e.lerpflags = 0;
    e.previouspose = 0;
    e.currentpose = 1;
    e.lerpstart = 0.2;
    e.lerptime = 0.2;
    cl.time = 0.3;
    glState.currententity = e;

    R_DrawAliasModel(e);

    expect(rmainState.lastpose1).toBe(0);
    expect(rmainState.lastpose2).toBe(1);
    expect(rmainState.lastblend).toBeCloseTo(0.5, 6);
  });
});

//============================================================================
// R_DrawSpriteModel -- entity scale
//============================================================================

describe("R_DrawSpriteModel entity scale", () => {
  test("a non-default entity scale multiplies every corner offset", () => {
    const frame = new MspriteframeT();
    frame.up = 10;
    frame.down = -10;
    frame.left = -8;
    frame.right = 8;
    frame.gl_texturenum = 42;

    const desc = new MspriteframedescT();
    desc.type = SpriteframetypeT.SPR_SINGLE;
    desc.frameptr = frame;

    const psprite = new MspriteT();
    psprite.type = SPR_VP_PARALLEL;
    psprite.numframes = 1;
    psprite.frames = [desc];

    const model = new ModelT();
    model.type = ModtypeT.mod_sprite;
    model.cache.data = psprite;

    const e = new EntityT();
    e.model = model;
    e.frame = 0;
    e.origin.set([0, 0, 0]);
    e.scale = ENTSCALE_ENCODE(2.0);
    glState.currententity = e;

    vup[0] = 0;
    vup[1] = 0;
    vup[2] = 1;
    vright[0] = 0;
    vright[1] = -1;
    vright[2] = 0;

    R_DrawSpriteModel(e);

    // scale 2.0 doubles every frame.up/down/left/right offset before it is
    // applied along vup/vright; e.g. the first corner is
    // origin + down*2*vup + left*2*vright = (0,0,-20) + (0,16,0)
    expect(rec.vertex3fv[0]).toEqual([0, 16, -20]);
  });
});
