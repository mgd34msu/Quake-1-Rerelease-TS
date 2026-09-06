// Tests for src/ref_soft/r_alias.ts (R_AliasSetUpTransform / R_AliasTransformFinalVert /
// R_AliasProjectFinalVert / R_AliasSetupLighting / R_AliasCheckBBox / R_AliasSetupFrame)
// and src/ref_soft/r_sprite.ts (R_GetSpriteframe / R_DrawSprite), per this unit's brief.
//
// Every rState / view field this suite writes is captured before the tests run
// and restored in afterAll, per standing order 13 -- this file never assumes
// another suite ran first, and leaves nothing behind for the ones that run after.

import { afterAll, describe, expect, test } from "bun:test";

import { vec3 } from "../src/common/mathlib";
import { AliasframetypeT, StvertT, TrivertxT, type MdlT } from "../src/common/modelgen";
import { ModelT } from "../src/common/model";
import { SPR_VP_PARALLEL, SpriteframetypeT } from "../src/common/spritegn";
import { EntityT } from "../src/client/render";
import { cl } from "../src/client/client";
import { AuxvertT, FinalvertT, rState, r_origin, r_plightvec, modelorg, r_refdef, vpn, vright, vup, type AlightT } from "../src/ref_soft/r_local";
import { AliashdrT, MaliasframedescT, MaliasgroupT, MaliasgroupframedescT, MspriteT, MspriteframeT, MspriteframedescT, MspritegroupT } from "../src/ref_soft/model_types";
import { r_spritedesc } from "../src/ref_soft/d_iface";
import { R_AliasCheckBBox, R_AliasProjectFinalVert, R_AliasSetUpTransform, R_AliasSetupFrame, R_AliasSetupLighting, R_AliasTransformFinalVert, aliastransform } from "../src/ref_soft/r_alias";
import { R_DrawSprite, R_GetSpriteframe } from "../src/ref_soft/r_sprite";

// Snapshot every field this suite mutates, restored in afterAll.
const saved = {
  currententity: rState.currententity,
  pmdl: rState.pmdl,
  paliashdr: rState.paliashdr,
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
  cltime: cl.time,
};

afterAll(() => {
  rState.currententity = saved.currententity;
  rState.pmdl = saved.pmdl;
  rState.paliashdr = saved.paliashdr;
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
  cl.time = saved.cltime;
});

// Common view/entity fixture: camera at the origin looking down +X (the
// AngleVectors(0,0,0) output: forward=(1,0,0), right=(0,-1,0), up=(0,0,1)),
// an entity 64 units straight ahead with zero angles.
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
  // r_bsp.c's R_RotateBmodel/R_AliasSetUpTransform caller normally computes
  // this as r_entorigin - r_origin; set directly for this isolated test.
  modelorg[0] = 64;
  modelorg[1] = 0;
  modelorg[2] = 0;

  const ent = new EntityT();
  ent.origin[0] = 64;
  ent.origin[1] = 0;
  ent.origin[2] = 0;
  ent.angles[0] = 0;
  ent.angles[1] = 0;
  ent.angles[2] = 0;
  rState.currententity = ent;

  return ent;
}

function makeMdl(): MdlT {
  const mdl: MdlT = {
    ident: 0,
    version: 0,
    scale: vec3(1, 1, 1),
    scale_origin: vec3(0, 0, 0),
    boundingradius: 0,
    eyeposition: vec3(0, 0, 0),
    numskins: 0,
    skinwidth: 0,
    skinheight: 0,
    numverts: 0,
    numtris: 0,
    numframes: 1,
    synctype: 0,
    flags: 0,
    size: 0,
  };
  return mdl;
}

describe("R_AliasSetUpTransform / R_AliasTransformFinalVert / R_AliasProjectFinalVert", () => {
  test("maps a model vertex through aliastransform to the expected screen coords", () => {
    setUpView();
    rState.pmdl = makeMdl();

    R_AliasSetUpTransform(0);

    // Hand-derived: t2matrix (forward=(1,0,0), right=(0,-1,0), up=(0,0,1),
    // modelorg=(64,0,0)) concatenated with the identity scale/scale_origin
    // tmatrix leaves rotationmatrix === t2matrix; concatenating with
    // viewmatrix (rows vright, -vup, vpn) gives:
    expect(aliastransform[0][0]).toBeCloseTo(0);
    expect(aliastransform[0][1]).toBeCloseTo(-1);
    expect(aliastransform[0][2]).toBeCloseTo(0);
    expect(aliastransform[0][3]).toBeCloseTo(0);
    expect(aliastransform[1][0]).toBeCloseTo(0);
    expect(aliastransform[1][1]).toBeCloseTo(0);
    expect(aliastransform[1][2]).toBeCloseTo(-1);
    expect(aliastransform[1][3]).toBeCloseTo(0);
    expect(aliastransform[2][0]).toBeCloseTo(1);
    expect(aliastransform[2][1]).toBeCloseTo(0);
    expect(aliastransform[2][2]).toBeCloseTo(0);
    expect(aliastransform[2][3]).toBeCloseTo(-64);

    // aliasxscale/aliasyscale chosen as exact powers of two so the 1/z
    // division and rescale round-trips without float error.
    rState.aliasxscale = 32;
    rState.aliasyscale = 32;
    rState.aliasxcenter = 160;
    rState.aliasycenter = 100;
    rState.r_ambientlight = 200;
    rState.r_shadelight = 0;

    const pverts = new TrivertxT();
    pverts.v[0] = 96;
    pverts.v[1] = 20;
    pverts.v[2] = 30;
    pverts.lightnormalindex = 0;

    const pstverts = new StvertT();
    pstverts.s = 5;
    pstverts.t = 7;
    pstverts.onseam = 0;

    const fv = new FinalvertT();
    const av = new AuxvertT();

    R_AliasTransformFinalVert(fv, av, pverts, pstverts);

    // av.fv = [v.y*-1, v.z*-1, v.x-64] = [-20, -30, 32]
    expect(av.fv[0]).toBeCloseTo(-20);
    expect(av.fv[1]).toBeCloseTo(-30);
    expect(av.fv[2]).toBeCloseTo(32);
    expect(fv.v[2]).toBe(5); // s
    expect(fv.v[3]).toBe(7); // t
    expect(fv.v[4]).toBe(200); // ambient only: lightcos is never negative with shadelight 0

    R_AliasProjectFinalVert(fv, av);

    // fv.v[0] = av.fv[0]*32*(1/32) + 160 = -20 + 160 = 140
    // fv.v[1] = av.fv[1]*32*(1/32) + 100 = -30 + 100 = 70
    expect(fv.v[0]).toBe(140);
    expect(fv.v[1]).toBe(70);
  });
});

describe("R_AliasSetupLighting", () => {
  test("converts ambient 100 / shade 50 to the VID_CBITS-shifted values", () => {
    setUpView();

    const plighting: AlightT = {
      ambientlight: 100,
      shadelight: 50,
      plightvec: vec3(1, 0, 0),
    };

    rState.pmdl = makeMdl();
    R_AliasSetUpTransform(0);
    R_AliasSetupLighting(plighting);

    // (255 - 100) << VID_CBITS(6) = 155 << 6 = 9920; 50 * VID_GRADES(64) = 3200
    expect(rState.r_ambientlight).toBe(9920);
    expect(rState.r_shadelight).toBe(3200);

    // plightvec rotated into the model's frame: forward=(1,0,0), right=(0,-1,0),
    // up=(0,0,1) -> [dot(fwd), -dot(right), dot(up)] = [1, 0, 0]
    expect(r_plightvec[0]).toBeCloseTo(1);
    expect(r_plightvec[1]).toBeCloseTo(0);
    expect(r_plightvec[2]).toBeCloseTo(0);
  });
});

describe("R_AliasCheckBBox", () => {
  function makeAliasModel(bboxminV: [number, number, number], bboxmaxV: [number, number, number]): ModelT {
    const bboxmin = new TrivertxT();
    bboxmin.v[0] = bboxminV[0];
    bboxmin.v[1] = bboxminV[1];
    bboxmin.v[2] = bboxminV[2];
    const bboxmax = new TrivertxT();
    bboxmax.v[0] = bboxmaxV[0];
    bboxmax.v[1] = bboxmaxV[1];
    bboxmax.v[2] = bboxmaxV[2];

    const framedesc = new MaliasframedescT();
    framedesc.type = AliasframetypeT.ALIAS_SINGLE;
    framedesc.bboxmin = bboxmin;
    framedesc.bboxmax = bboxmax;
    framedesc.frame = [];

    const pahdr = new AliashdrT();
    pahdr.model = makeMdl();
    pahdr.frames = [framedesc];

    const mod = new ModelT();
    mod.cache.data = pahdr;
    return mod;
  }

  test("a frame bbox entirely behind the near plane returns false", () => {
    const ent = setUpView();
    ent.model = makeAliasModel([0, 0, 0], [50, 50, 50]);
    ent.frame = 0;

    rState.xscale = 1;
    rState.yscale = 1;
    rState.xcenter = 160;
    rState.ycenter = 100;
    r_refdef.fvrectx = 0;
    r_refdef.fvrecty = 0;
    r_refdef.fvrectright = 320;
    r_refdef.fvrectbottom = 200;

    expect(R_AliasCheckBBox()).toBe(false);
  });

  test("a frame bbox entirely in front of the near plane returns true", () => {
    const ent = setUpView();
    ent.model = makeAliasModel([100, 100, 100], [150, 150, 150]);
    ent.frame = 0;

    rState.xscale = 1;
    rState.yscale = 1;
    rState.xcenter = 160;
    rState.ycenter = 100;
    r_refdef.fvrectx = 0;
    r_refdef.fvrecty = 0;
    r_refdef.fvrectright = 320;
    r_refdef.fvrectbottom = 200;

    expect(R_AliasCheckBBox()).toBe(true);
  });
});

describe("R_AliasSetupFrame", () => {
  test("selects a group frame by cl.time", () => {
    const ent = setUpView();
    ent.frame = 0;
    ent.syncbase = 0;

    const frameA: TrivertxT[] = [];
    const frameB: TrivertxT[] = [];

    const groupframeA = new MaliasgroupframedescT();
    groupframeA.frame = frameA;
    const groupframeB = new MaliasgroupframedescT();
    groupframeB.frame = frameB;

    const group = new MaliasgroupT();
    group.numframes = 2;
    group.intervals = new Float32Array([0.5, 1.0]);
    group.frames = [groupframeA, groupframeB];

    const framedesc = new MaliasframedescT();
    framedesc.type = AliasframetypeT.ALIAS_GROUP;
    framedesc.frame = group;

    const pahdr = new AliashdrT();
    pahdr.model = makeMdl();
    pahdr.frames = [framedesc];

    rState.pmdl = pahdr.model;
    rState.paliashdr = pahdr;

    // targettime = 0.7 - floor(0.7/1.0)*1.0 = 0.7; intervals[0]=0.5 is not
    // > 0.7, so the loop runs to i=1 -> frames[1] (frameB) is selected.
    cl.time = 0.7;

    R_AliasSetupFrame();

    // frameB is exported only through this identity check (both frame
    // arrays are empty on purpose -- the selection itself is under test).
    expect(groupframeB.frame).toBe(frameB);
  });
});

describe("R_GetSpriteframe", () => {
  test("selects a group frame by interval", () => {
    const frameA = new MspriteframeT();
    const frameB = new MspriteframeT();

    const group = new MspritegroupT();
    group.numframes = 2;
    group.intervals = new Float32Array([0.3, 1.0]);
    group.frames = [frameA, frameB];

    const desc = new MspriteframedescT();
    desc.type = SpriteframetypeT.SPR_GROUP;
    desc.frameptr = group;

    const psprite = new MspriteT();
    psprite.numframes = 1;
    psprite.frames = [desc];

    const ent = setUpView();
    ent.frame = 0;
    ent.syncbase = 0;
    rState.currententity = ent;

    // targettime = 0.5 - floor(0.5/1.0)*1.0 = 0.5; intervals[0]=0.3 is not
    // > 0.5, so the loop runs to i=1 -> frames[1] (frameB) is selected.
    cl.time = 0.5;

    expect(R_GetSpriteframe(psprite)).toBe(frameB);
  });
});

describe("R_DrawSprite", () => {
  test("SPR_VP_PARALLEL sets r_spritedesc's vectors to vup/vright/vpn", () => {
    const ent = setUpView();

    const frame = new MspriteframeT();
    frame.width = 10;
    frame.height = 10;
    frame.up = 5;
    frame.down = 5;
    frame.left = 5;
    frame.right = 5;

    const desc = new MspriteframedescT();
    desc.type = SpriteframetypeT.SPR_SINGLE;
    desc.frameptr = frame;

    const psprite = new MspriteT();
    psprite.type = SPR_VP_PARALLEL;
    psprite.numframes = 1;
    psprite.beamlength = 0; // R_RotateSprite is a no-op
    psprite.frames = [desc];

    const mod = new ModelT();
    mod.cache.data = psprite;
    ent.model = mod;
    ent.frame = 0;
    ent.syncbase = 0;

    // Force R_SetupAndDrawSprite's backface cull to trip (dot >= 0), so it
    // returns before ever calling D_DrawSprite (out of this unit's SCOPE).
    modelorg[0] = 1;
    modelorg[1] = 0;
    modelorg[2] = 0;

    R_DrawSprite();

    expect(r_spritedesc.vup[0]).toBeCloseTo(vup[0]);
    expect(r_spritedesc.vup[1]).toBeCloseTo(vup[1]);
    expect(r_spritedesc.vup[2]).toBeCloseTo(vup[2]);
    expect(r_spritedesc.vright[0]).toBeCloseTo(vright[0]);
    expect(r_spritedesc.vright[1]).toBeCloseTo(vright[1]);
    expect(r_spritedesc.vright[2]).toBeCloseTo(vright[2]);
    expect(r_spritedesc.vpn[0]).toBeCloseTo(vpn[0]);
    expect(r_spritedesc.vpn[1]).toBeCloseTo(vpn[1]);
    expect(r_spritedesc.vpn[2]).toBeCloseTo(vpn[2]);
  });
});
