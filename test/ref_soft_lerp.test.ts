// Tests for U39 (interpolation in the software renderer, mirroring the GL
// renderer's U16/U29): src/ref_soft/r_alias.ts's pose lerp (R_AliasSetupFrame)
// and move lerp (R_AliasSetUpTransform). Follows test/ref_soft_alias.test.ts's
// own camera/fixture convention throughout (angles (0,0,0) gives
// forward=(1,0,0), right=(0,-1,0), up=(0,0,1)) and test/ref_gl_lerp.test.ts's
// own style for driving cl.time through a pose/move change by hand.
//
// Self-sufficient per standing order 13: every rState/r_origin/modelorg/vup/
// vpn/vright/r_refdef/cl.time/r_lerpmodels/r_lerpmove/r_nolerp_list field this
// file writes is snapshotted before the suite runs and restored in afterAll.
// Every entity fixture below is a freshly constructed EntityT, so r_alias.ts's
// own per-entity pose-verts cache (a WeakMap keyed by entity identity, never
// exported) cannot leak between tests or suites: a cache entry is reachable
// only through the exact entity object that created it.

import { afterAll, describe, expect, test } from "bun:test";

import { vec3 } from "../src/common/mathlib";
import { AliasframetypeT, StvertT, TrivertxT, type MdlT } from "../src/common/modelgen";
import { ModelT } from "../src/common/model";
import { EntityT, LERP_FINISH, LERP_MOVESTEP, LERP_RESETANIM, r_lerpmodels, r_lerpmove } from "../src/client/render";
import { lerpFraction } from "../src/common/lerp_blend";
import { cl } from "../src/client/client";
import { AuxvertT, FinalvertT, allocAuxverts, allocFinalverts, modelorg, r_origin, r_refdef, rState, vpn, vright, vup } from "../src/ref_soft/r_local";
import { AliashdrT, MaliasframedescT } from "../src/ref_soft/model_types";
import { r_nolerp_list } from "../src/ref_gl/glquake";
import { R_AliasPreparePoints, R_AliasProjectFinalVert, R_AliasSetUpTransform, R_AliasSetupFrame, R_AliasTransformFinalVert, aliastransform, r_aliasblend, r_apverts1, r_apverts2 } from "../src/ref_soft/r_alias";

const saved = {
  currententity: rState.currententity,
  pmdl: rState.pmdl,
  paliashdr: rState.paliashdr,
  pfinalverts: rState.pfinalverts,
  pauxverts: rState.pauxverts,
  xscale: rState.xscale,
  yscale: rState.yscale,
  xcenter: rState.xcenter,
  ycenter: rState.ycenter,
  aliasxscale: rState.aliasxscale,
  aliasyscale: rState.aliasyscale,
  aliasxcenter: rState.aliasxcenter,
  aliasycenter: rState.aliasycenter,
  r_ambientlight: rState.r_ambientlight,
  r_shadelight: rState.r_shadelight,
  r_origin: [r_origin[0], r_origin[1], r_origin[2]] as const,
  modelorg: [modelorg[0], modelorg[1], modelorg[2]] as const,
  vpn: [vpn[0], vpn[1], vpn[2]] as const,
  vright: [vright[0], vright[1], vright[2]] as const,
  vup: [vup[0], vup[1], vup[2]] as const,
  fvrectx: r_refdef.fvrectx,
  fvrecty: r_refdef.fvrecty,
  fvrectright: r_refdef.fvrectright,
  fvrectbottom: r_refdef.fvrectbottom,
  aliasvrectx: r_refdef.aliasvrect.x,
  aliasvrecty: r_refdef.aliasvrect.y,
  aliasvrectright: r_refdef.aliasvrectright,
  aliasvrectbottom: r_refdef.aliasvrectbottom,
  cltime: cl.time,
  r_lerpmodels: r_lerpmodels.value,
  r_lerpmove: r_lerpmove.value,
  r_nolerp_list: r_nolerp_list.string,
};

afterAll(() => {
  rState.currententity = saved.currententity;
  rState.pmdl = saved.pmdl;
  rState.paliashdr = saved.paliashdr;
  rState.pfinalverts = saved.pfinalverts;
  rState.pauxverts = saved.pauxverts;
  rState.xscale = saved.xscale;
  rState.yscale = saved.yscale;
  rState.xcenter = saved.xcenter;
  rState.ycenter = saved.ycenter;
  rState.aliasxscale = saved.aliasxscale;
  rState.aliasyscale = saved.aliasyscale;
  rState.aliasxcenter = saved.aliasxcenter;
  rState.aliasycenter = saved.aliasycenter;
  rState.r_ambientlight = saved.r_ambientlight;
  rState.r_shadelight = saved.r_shadelight;
  r_origin[0] = saved.r_origin[0];
  r_origin[1] = saved.r_origin[1];
  r_origin[2] = saved.r_origin[2];
  modelorg[0] = saved.modelorg[0];
  modelorg[1] = saved.modelorg[1];
  modelorg[2] = saved.modelorg[2];
  vpn[0] = saved.vpn[0];
  vpn[1] = saved.vpn[1];
  vpn[2] = saved.vpn[2];
  vright[0] = saved.vright[0];
  vright[1] = saved.vright[1];
  vright[2] = saved.vright[2];
  vup[0] = saved.vup[0];
  vup[1] = saved.vup[1];
  vup[2] = saved.vup[2];
  r_refdef.fvrectx = saved.fvrectx;
  r_refdef.fvrecty = saved.fvrecty;
  r_refdef.fvrectright = saved.fvrectright;
  r_refdef.fvrectbottom = saved.fvrectbottom;
  r_refdef.aliasvrect.x = saved.aliasvrectx;
  r_refdef.aliasvrect.y = saved.aliasvrecty;
  r_refdef.aliasvrectright = saved.aliasvrectright;
  r_refdef.aliasvrectbottom = saved.aliasvrectbottom;
  cl.time = saved.cltime;
  r_lerpmodels.value = saved.r_lerpmodels;
  r_lerpmove.value = saved.r_lerpmove;
  r_nolerp_list.string = saved.r_nolerp_list;
});

// Common view/entity fixture, reused from test/ref_soft_alias.test.ts's own
// setUpView: camera at the origin looking down +X (AngleVectors(0,0,0):
// forward=(1,0,0), right=(0,-1,0), up=(0,0,1)).
function setUpView(): EntityT {
  r_origin[0] = 0;
  r_origin[1] = 0;
  r_origin[2] = 0;
  vpn[0] = 1;
  vpn[1] = 0;
  vpn[2] = 0;
  vright[0] = 0;
  vright[1] = -1;
  vright[2] = 0;
  vup[0] = 0;
  vup[1] = 0;
  vup[2] = 1;

  const ent = new EntityT();
  ent.origin[0] = 64;
  ent.origin[1] = 0;
  ent.origin[2] = 0;
  ent.angles[0] = 0;
  ent.angles[1] = 0;
  ent.angles[2] = 0;
  rState.currententity = ent;
  // r_bsp.c's R_RotateBmodel/R_AliasSetUpTransform caller normally computes
  // this as r_entorigin - r_origin; set directly for this isolated test.
  modelorg[0] = 64;
  modelorg[1] = 0;
  modelorg[2] = 0;

  return ent;
}

function makeMdl(numframes: number, numverts: number): MdlT {
  return {
    ident: 0,
    version: 0,
    scale: vec3(1, 1, 1),
    scale_origin: vec3(0, 0, 0),
    boundingradius: 0,
    eyeposition: vec3(0, 0, 0),
    numskins: 0,
    skinwidth: 0,
    skinheight: 0,
    numverts,
    numtris: 0,
    numframes,
    synctype: 0,
    flags: 0,
    size: 0,
  };
}

// One vertex, two ALIAS_SINGLE frames -- frame0's v=[96,20,30], frame1's
// v=[96,120,30] (only Y differs, so the blend shows up cleanly in av.fv[0] --
// see this file's header derivation in the PR description / r_alias.ts's own
// header note on aliastransform's row layout for this camera).
function makeTwoFrameAliashdr(pmdl: MdlT): AliashdrT {
  const v0 = new TrivertxT();
  v0.v[0] = 96;
  v0.v[1] = 20;
  v0.v[2] = 30;
  v0.lightnormalindex = 0;

  const v1 = new TrivertxT();
  v1.v[0] = 96;
  v1.v[1] = 120;
  v1.v[2] = 30;
  v1.lightnormalindex = 0;

  const frame0 = new MaliasframedescT();
  frame0.type = AliasframetypeT.ALIAS_SINGLE;
  frame0.frame = [v0];

  const frame1 = new MaliasframedescT();
  frame1.type = AliasframetypeT.ALIAS_SINGLE;
  frame1.frame = [v1];

  const st = new StvertT();
  st.s = 5;
  st.t = 7;
  st.onseam = 0;

  const pahdr = new AliashdrT();
  pahdr.model = pmdl;
  pahdr.frames = [frame0, frame1];
  pahdr.stverts = [st];
  pahdr.triangles = [];
  return pahdr;
}

function setUpProjection(): void {
  rState.aliasxscale = 32;
  rState.aliasyscale = 32;
  rState.aliasxcenter = 160;
  rState.aliasycenter = 100;
  rState.r_ambientlight = 200;
  rState.r_shadelight = 0; // lightcos never negative-weighted: temp === ambient always
  r_refdef.aliasvrect.x = 0;
  r_refdef.aliasvrect.y = 0;
  r_refdef.aliasvrectright = 320;
  r_refdef.aliasvrectbottom = 200;
}

//============================================================================

describe("R_AliasSetupFrame -- pose lerp", () => {
  test("blend progresses 0 -> 0.5 -> 1 across a pose change, then snaps pose1 to pose2 at blend 1", () => {
    const ent = setUpView();
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    r_lerpmodels.value = 1;

    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();
    expect(r_apverts1).toBe(r_apverts2); // first frame ever selected: nothing to lerp from
    expect(r_apverts2?.[0].v[1]).toBe(20);

    // frame changes to 1 at cl.time 0: blend starts at exactly 0 this instant
    ent.frame = 1;
    R_AliasSetupFrame();
    expect(r_apverts1?.[0].v[1]).toBe(20); // previous pose: frame0
    expect(r_apverts2?.[0].v[1]).toBe(120); // current pose: frame1
    expect(r_aliasblend).toBe(0);

    // halfway through the 0.1s ALIAS_SINGLE lerptime
    cl.time = 0.05;
    R_AliasSetupFrame();
    expect(r_aliasblend).toBeCloseTo(0.5, 6);
    expect(r_apverts1?.[0].v[1]).toBe(20);
    expect(r_apverts2?.[0].v[1]).toBe(120);

    // lerp finished: previouspose snaps to currentpose (pose1 === pose2 again)
    cl.time = 0.1;
    R_AliasSetupFrame();
    expect(r_aliasblend).toBe(1);
    expect(r_apverts1).toBe(r_apverts2);
    expect(r_apverts2?.[0].v[1]).toBe(120);
  });

  test("r_lerpmodels 0 always reports pose1 === pose2 (the classic single-pose path), regardless of an in-progress lerp", () => {
    const ent = setUpView();
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;

    r_lerpmodels.value = 1;
    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();
    ent.frame = 1;
    cl.time = 0;
    R_AliasSetupFrame(); // lerp now in progress (pose1 !== pose2)
    cl.time = 0.05;

    r_lerpmodels.value = 0;
    R_AliasSetupFrame();
    expect(r_aliasblend).toBe(1);
    expect(r_apverts1).toBe(r_apverts2);
    expect(r_apverts2?.[0].v[1]).toBe(120); // still the classic "current pose" selection
  });

  test("r_nolerp_list blocks lerping at r_lerpmodels 1, but r_lerpmodels 2 overrides it (MOD_NOLERP semantics)", () => {
    const ent = setUpView();
    const mod = new ModelT();
    mod.name = "progs/flame.mdl"; // r_nolerp_list's own default includes this name
    ent.model = mod;
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    r_nolerp_list.string = "progs/flame.mdl";

    r_lerpmodels.value = 1;
    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();
    ent.frame = 1;
    cl.time = 0;
    R_AliasSetupFrame();
    cl.time = 0.05;
    R_AliasSetupFrame();
    expect(r_aliasblend).toBe(1); // blocked: nolerp-flagged model, r_lerpmodels 1
    expect(r_apverts1).toBe(r_apverts2);

    r_lerpmodels.value = 2;
    R_AliasSetupFrame();
    expect(r_aliasblend).toBeCloseTo(0.5, 6); // overridden: r_lerpmodels 2 lerps anyway
    expect(r_apverts1).not.toBe(r_apverts2);
  });

  test("LERP_RESETANIM kills any lerp in progress and clears the flag", () => {
    const ent = setUpView();
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    r_lerpmodels.value = 1;

    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();
    ent.frame = 1;
    cl.time = 0;
    R_AliasSetupFrame(); // lerp in progress

    ent.lerpflags = LERP_RESETANIM;
    cl.time = 0.3; // would clamp to blend 1 anyway, but RESETANIM should force it immediately
    R_AliasSetupFrame();

    expect(ent.lerpflags & LERP_RESETANIM).toBe(0);
    expect(r_aliasblend).toBe(1);
    expect(r_apverts1).toBe(r_apverts2);
    expect(r_apverts2?.[0].v[1]).toBe(120);
  });
});

//============================================================================

describe("vertex blend end-to-end (R_AliasSetUpTransform + R_AliasPreparePoints)", () => {
  test("the finalvert scratch's screen X lands at the midpoint between the two poses' own projections", () => {
    const ent = setUpView();
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    rState.pfinalverts = allocFinalverts(1);
    rState.pauxverts = allocAuxverts(1);
    r_lerpmodels.value = 1;
    setUpProjection();

    R_AliasSetUpTransform(0);

    ent.frame = 1;
    cl.time = 0;
    R_AliasSetupFrame();
    R_AliasPreparePoints();
    const fv = rState.pfinalverts;
    expect(fv).not.toBeNull();
    if (!fv) return;
    // blend 0: exactly frame0's own projection (av.fv[0] = -20, +160 center)
    expect(fv[0].v[0]).toBe(140);
    expect(fv[0].v[1]).toBe(70);
    expect(fv[0].v[4]).toBe(200);

    cl.time = 0.05;
    R_AliasSetupFrame();
    R_AliasPreparePoints();
    // blend 0.5: av.fv[0] = -(20*0.5+120*0.5) = -70, +160 center = 90 -- the
    // exact midpoint between 140 (blend 0) and 40 (blend 1) below.
    expect(fv[0].v[0]).toBe(90);
    expect(fv[0].v[1]).toBe(70);
    expect(fv[0].v[4]).toBe(200);

    cl.time = 0.1;
    R_AliasSetupFrame();
    R_AliasPreparePoints();
    // blend 1: exactly frame1's own projection (av.fv[0] = -120, +160 = 40)
    expect(fv[0].v[0]).toBe(40);
    expect(fv[0].v[1]).toBe(70);
    expect(fv[0].v[4]).toBe(200);
  });

  test("r_lerpmodels 0 output is byte-identical to calling the classic (unlerped) R_AliasTransformFinalVert/R_AliasProjectFinalVert directly", () => {
    const ent = setUpView();
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    rState.pfinalverts = allocFinalverts(1);
    rState.pauxverts = allocAuxverts(1);
    setUpProjection();

    R_AliasSetUpTransform(0);

    // prime a lerp in progress, then disable r_lerpmodels: R_AliasSetupFrame
    // must report the classic single-pose selection regardless.
    r_lerpmodels.value = 1;
    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();
    ent.frame = 1;
    cl.time = 0.05;
    R_AliasSetupFrame();

    r_lerpmodels.value = 0;
    cl.time = 0.05;
    R_AliasSetupFrame();
    R_AliasPreparePoints();
    const fv = rState.pfinalverts;
    expect(fv).not.toBeNull();
    if (!fv) return;
    const got = { v0: fv[0].v[0], v1: fv[0].v[1], v4: fv[0].v[4] };

    // the reference (pre-U39) path: transform+project frame1's own vertex
    // directly, with the SAME aliastransform this test's R_AliasSetUpTransform
    // call above already built.
    const frame1Frame = pahdr.frames[1].frame;
    expect(Array.isArray(frame1Frame)).toBe(true);
    if (!Array.isArray(frame1Frame)) return;
    const frame1Vert = frame1Frame[0];
    const refFv = new FinalvertT();
    const refAv = new AuxvertT();
    R_AliasTransformFinalVert(refFv, refAv, frame1Vert, pahdr.stverts[0]);
    R_AliasProjectFinalVert(refFv, refAv);

    expect(got.v0).toBe(refFv.v[0]);
    expect(got.v1).toBe(refFv.v[1]);
    expect(got.v4).toBe(refFv.v[4]);
  });
});

//============================================================================

describe("R_AliasSetUpTransform -- move lerp", () => {
  test("a MOVETYPE_STEP entity under r_lerpmove blends its translation to the midpoint between previousorigin and currentorigin", () => {
    const ent = setUpView();
    const pmdl = makeMdl(1, 0);
    rState.pmdl = pmdl;

    r_lerpmove.value = 1;
    ent.lerpflags = LERP_MOVESTEP;
    ent.angles[0] = 0;
    ent.angles[1] = 0;
    ent.angles[2] = 0;

    // step from (0,0,0) to (100,0,0): ent.origin differing from the default
    // currentorigin (0,0,0) starts the lerp on the FIRST call below.
    ent.origin[0] = 100;
    ent.origin[1] = 0;
    ent.origin[2] = 0;
    modelorg[0] = r_origin[0] - ent.origin[0];
    modelorg[1] = r_origin[1] - ent.origin[1];
    modelorg[2] = r_origin[2] - ent.origin[2];

    cl.time = 0;
    R_AliasSetUpTransform(0);
    // aliastransform's row 2 picks out t2matrix's row 0 translation for this
    // camera (forward=(1,0,0)) -- see this file's header derivation. Expected
    // == lerpOrigin[0] - r_origin[0].
    expect(aliastransform[2][3]).toBeCloseTo(0, 5); // blend 0: previousorigin (0,0,0)

    cl.time = 0.05;
    R_AliasSetUpTransform(0);
    expect(aliastransform[2][3]).toBeCloseTo(50, 5); // blend 0.5: midpoint (50,0,0)

    cl.time = 0.1;
    R_AliasSetUpTransform(0);
    expect(aliastransform[2][3]).toBeCloseTo(100, 5); // blend 1: currentorigin (100,0,0)
  });

  test("r_lerpmove 0 always transforms at the entity's raw (unlerped) origin", () => {
    const ent = setUpView();
    const pmdl = makeMdl(1, 0);
    rState.pmdl = pmdl;

    r_lerpmove.value = 0;
    ent.lerpflags = LERP_MOVESTEP;
    ent.origin[0] = 100;
    ent.origin[1] = 0;
    ent.origin[2] = 0;
    modelorg[0] = r_origin[0] - ent.origin[0];
    modelorg[1] = r_origin[1] - ent.origin[1];
    modelorg[2] = r_origin[2] - ent.origin[2];

    cl.time = 0;
    R_AliasSetUpTransform(0);
    cl.time = 0.05; // would be blend 0.5 if r_lerpmove were on
    R_AliasSetUpTransform(0);
    expect(aliastransform[2][3]).toBeCloseTo(100, 5); // always the raw origin
  });

  test("without LERP_MOVESTEP, an entity is never move-lerped even with r_lerpmove on", () => {
    const ent = setUpView();
    const pmdl = makeMdl(1, 0);
    rState.pmdl = pmdl;

    r_lerpmove.value = 1;
    ent.lerpflags = 0; // no LERP_MOVESTEP
    ent.origin[0] = 100;
    ent.origin[1] = 0;
    ent.origin[2] = 0;
    modelorg[0] = r_origin[0] - ent.origin[0];
    modelorg[1] = r_origin[1] - ent.origin[1];
    modelorg[2] = r_origin[2] - ent.origin[2];

    cl.time = 0;
    R_AliasSetUpTransform(0);
    cl.time = 0.05;
    R_AliasSetUpTransform(0);
    expect(aliastransform[2][3]).toBeCloseTo(100, 5);
  });
});

//============================================================================

describe("lerpFraction", () => {
  test("a positive span reproduces the CLAMP(0, (now-start)/(end-start), 1) it replaces", () => {
    expect(lerpFraction(0, 0, 0.1)).toBe(0);
    expect(lerpFraction(0.025, 0, 0.1)).toBeCloseTo(0.25, 12);
    expect(lerpFraction(0.05, 0, 0.1)).toBeCloseTo(0.5, 12);
    expect(lerpFraction(0.1, 0, 0.1)).toBe(1);
    expect(lerpFraction(2.05, 2, 2.1)).toBeCloseTo(0.5, 12);
  });

  test("clamps outside the span at both ends", () => {
    expect(lerpFraction(-5, 0, 0.1)).toBe(0);
    expect(lerpFraction(5, 0, 0.1)).toBe(1);
  });

  test("a zero span reports the blend as already finished instead of 0/0", () => {
    expect(lerpFraction(1.5, 1.5, 1.5)).toBe(1);
    expect(lerpFraction(2, 1.5, 1.5)).toBe(1);
  });

  test("a negative span reports the blend as already finished", () => {
    expect(lerpFraction(1.5, 1.5, 1.0)).toBe(1);
  });

  test("a NaN anywhere still yields a finite 0..1 fraction", () => {
    expect(lerpFraction(Number.NaN, 0, 0.1)).toBe(1);
    expect(lerpFraction(0.05, Number.NaN, 0.1)).toBe(1);
    expect(lerpFraction(0.05, 0, Number.NaN)).toBe(1);
  });

  test("infinities never escape as a non-finite fraction", () => {
    expect(lerpFraction(Number.POSITIVE_INFINITY, 0, 0.1)).toBe(1);
    expect(lerpFraction(Number.NEGATIVE_INFINITY, 0, 0.1)).toBe(0);
    expect(lerpFraction(0.05, 0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

//============================================================================

// A second model, with MORE vertices than makeTwoFrameAliashdr's one, so the
// pose arrays cached for that model are too short for this one.
function makeThreeVertAliashdr(pmdl: MdlT): AliashdrT {
  const framesVerts: TrivertxT[][] = [];
  for (let f = 0; f < 2; f++) {
    const verts: TrivertxT[] = [];
    for (let i = 0; i < 3; i++) {
      const v = new TrivertxT();
      v.v[0] = 96;
      v.v[1] = 20 + f * 40 + i * 30;
      v.v[2] = 30;
      v.lightnormalindex = 0;
      verts.push(v);
    }
    framesVerts.push(verts);
  }

  const pahdr = new AliashdrT();
  pahdr.model = pmdl;
  pahdr.frames = framesVerts.map((verts) => {
    const fd = new MaliasframedescT();
    fd.type = AliasframetypeT.ALIAS_SINGLE;
    fd.frame = verts;
    return fd;
  });
  pahdr.stverts = [0, 1, 2].map(() => {
    const st = new StvertT();
    st.s = 5;
    st.t = 7;
    st.onseam = 0;
    return st;
  });
  pahdr.triangles = [];
  return pahdr;
}

describe("R_AliasSetupFrame -- pose cache across a model change", () => {
  test("an entity that switches model drops the previous model's cached pose verts and draws every vertex of the new one", () => {
    const ent = setUpView();
    setUpProjection();
    r_lerpmodels.value = 1;

    // Model A: one vertex, two frames. Leave a lerp in progress so the cache
    // holds A's own (one-element) pose arrays.
    const pmdlA = makeMdl(2, 1);
    const pahdrA = makeTwoFrameAliashdr(pmdlA);
    rState.pmdl = pmdlA;
    rState.paliashdr = pahdrA;
    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();
    ent.frame = 1;
    cl.time = 0;
    R_AliasSetupFrame();
    expect(r_apverts1).not.toBe(r_apverts2);
    expect(r_apverts1?.length).toBe(1);

    // Model B: three vertices. Same EntityT -- this is cl.viewent changing
    // weapon, or a reused entity slot.
    const pmdlB = makeMdl(2, 3);
    const pahdrB = makeThreeVertAliashdr(pmdlB);
    rState.pmdl = pmdlB;
    rState.paliashdr = pahdrB;
    rState.pfinalverts = allocFinalverts(3);
    rState.pauxverts = allocAuxverts(3);
    R_AliasSetUpTransform(0);
    ent.frame = 0;
    cl.time = 0.05;
    R_AliasSetupFrame();

    // reset, exactly as LERP_RESETANIM would leave it
    expect(r_apverts1).toBe(r_apverts2);
    expect(r_apverts1?.length).toBe(3);
    expect(ent.previouspose).toBe(ent.currentpose);
    expect(ent.lerpstart).toBe(0);

    // and the draw reads all three of the new model's vertices
    R_AliasPreparePoints();
    const fv = rState.pfinalverts;
    expect(fv).not.toBeNull();
    if (!fv) return;
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(fv[i].v[0])).toBe(true);
      expect(Number.isFinite(fv[i].v[1])).toBe(true);
    }
    expect(fv[0].v[0]).not.toBe(fv[1].v[0]);
  });

  test("a cold-start pose number that resolves to fewer verts than the model has is ignored", () => {
    const ent = setUpView();
    setUpProjection();
    r_lerpmodels.value = 1;

    // frame 1 carries only one vertex while the mdl claims three: a
    // previouspose pointing at it must not become a lerp source.
    const pmdl = makeMdl(2, 3);
    const pahdr = makeThreeVertAliashdr(pmdl);
    const shortFrame = pahdr.frames[1].frame;
    expect(Array.isArray(shortFrame)).toBe(true);
    if (!Array.isArray(shortFrame)) return;
    pahdr.frames[1].frame = [shortFrame[0]];

    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    ent.previouspose = 65536; // frame 1, subframe 0
    ent.currentpose = 65536;
    ent.frame = 0;
    cl.time = 0;
    R_AliasSetupFrame();

    expect(r_apverts1?.length).toBe(3);
    expect(r_apverts2?.length).toBe(3);
  });
});

//============================================================================

describe("zero-span LERP_FINISH", () => {
  test("a pose lerp whose lerpfinish equals its lerpstart blends fully to the current pose", () => {
    const ent = setUpView();
    setUpProjection();
    const pmdl = makeMdl(2, 1);
    const pahdr = makeTwoFrameAliashdr(pmdl);
    rState.pmdl = pmdl;
    rState.paliashdr = pahdr;
    r_lerpmodels.value = 1;

    ent.lerpflags = LERP_FINISH;
    ent.frame = 0;
    cl.time = 1.4;
    R_AliasSetupFrame();

    // pose change at cl.time 1.4 sets lerpstart to 1.4; a U_LERPFINISH byte
    // of 0 puts lerpfinish on the same instant, so the span is exactly zero.
    ent.frame = 1;
    R_AliasSetupFrame();
    ent.lerpfinish = 1.4;
    R_AliasSetupFrame();

    expect(r_aliasblend).toBe(1);
    expect(r_apverts1).toBe(r_apverts2);
    expect(r_apverts2?.[0].v[1]).toBe(120);
  });

  test("a move lerp whose lerpfinish equals its movelerpstart transforms at the current origin, finitely", () => {
    const ent = setUpView();
    const pmdl = makeMdl(1, 0);
    rState.pmdl = pmdl;
    r_lerpmove.value = 1;

    ent.lerpflags = LERP_MOVESTEP | LERP_FINISH;
    ent.origin[0] = 100;
    ent.origin[1] = 0;
    ent.origin[2] = 0;
    modelorg[0] = r_origin[0] - ent.origin[0];
    modelorg[1] = r_origin[1] - ent.origin[1];
    modelorg[2] = r_origin[2] - ent.origin[2];

    cl.time = 1.4;
    ent.lerpfinish = 1.4; // == the movelerpstart the call below records
    R_AliasSetUpTransform(0);

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        expect(Number.isFinite(aliastransform[i][j])).toBe(true);
      }
    }
    expect(aliastransform[2][3]).toBeCloseTo(100, 5);
  });
});
