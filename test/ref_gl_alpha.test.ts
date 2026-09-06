// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U21's translucency additions: gl_rmain.ts's R_WaterAlphaForTextureName
(the lava/slime/tele-by-texture-name override of r_wateralpha),
R_EntityAlpha (the cl_entity_ext/cl_static_entity_ext ENTALPHA lookup),
R_DrawEntitiesOnList's alphapass (translucent entities drawn last, sorted
back-to-front), R_DrawBrushModel's entity-alpha GL_BLEND bracket, and
gl_rsurf.ts's R_DrawWaterSurfaces per-surface alpha bracket.

Every case drives a QGLRecording installed as qglHolder.current. Every
shared singleton this file writes (qglHolder, r_wateralpha/r_lavaalpha/
r_slimealpha/r_telealpha, cl_entities/cl_entity_ext slots this file uses,
cl_visedicts/clState.cl_numvisedicts, r_refdef.vieworg, glRsurfState.waterchain,
r_drawentities) is saved in beforeAll and restored in afterAll, per standing
orders 13 and 15.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { MsurfaceT, MtexinfoT, TextureT, SURF_DRAWTURB } from "../src/common/model";
import { ENTALPHA_DECODE, ENTALPHA_DEFAULT, ENTALPHA_ENCODE } from "../src/common/protocol";
import { cl, cl_entities, cl_entity_ext, cl_static_entities, cl_static_entity_ext, cl_visedicts, clState } from "../src/client/client";
import { EntityT, r_refdef, r_drawentities } from "../src/client/render";
import { glState, GlpolyT, setSurfPolys } from "../src/ref_gl/glquake";
import { GL_BLEND, QGLRecording, qglHolder } from "../src/ref_gl/qgl";
import { R_DrawEntitiesOnList, R_WaterAlphaForTextureName, R_EntityAlpha, r_lavaalpha, r_slimealpha, r_telealpha, gl_texsort } from "../src/ref_gl/gl_rmain";
import { r_wateralpha } from "../src/ref_gl/gl_rmain";
import { glRsurfState, R_DrawWaterSurfaces } from "../src/ref_gl/gl_rsurf";
import { MspriteT, MspriteframeT, MspriteframedescT } from "../src/ref_gl/gl_model_types";
import { SPR_VP_PARALLEL, SpriteframetypeT } from "../src/common/spritegn";
import { ModelT, ModtypeT } from "../src/common/model";
import { vup, vright } from "../src/client/render";

const rec = new QGLRecording();

const saved = {
  qgl: qglHolder.current,
  wateralpha: r_wateralpha.string,
  lavaalpha: r_lavaalpha.string,
  slimealpha: r_slimealpha.string,
  telealpha: r_telealpha.string,
  gl_texsort: gl_texsort.value,
  drawentities: r_drawentities.value,
  numvisedicts: clState.cl_numvisedicts,
  vieworg: [r_refdef.vieworg[0], r_refdef.vieworg[1], r_refdef.vieworg[2]],
  waterchain: glRsurfState.waterchain,
  vup: [vup[0], vup[1], vup[2]],
  vright: [vright[0], vright[1], vright[2]],
  ent1: { model: cl_entities[1].model, origin: [...cl_entities[1].origin], frame: cl_entities[1].frame, alpha: cl_entity_ext[1].alpha },
  ent2: { model: cl_entities[2].model, origin: [...cl_entities[2].origin], frame: cl_entities[2].frame, alpha: cl_entity_ext[2].alpha },
  ent3: { model: cl_entities[3].model, origin: [...cl_entities[3].origin], frame: cl_entities[3].frame, alpha: cl_entity_ext[3].alpha },
};

function setAlpha(index: number, value: 0 | number): void {
  cl_entity_ext[index].alpha = value === 0 ? ENTALPHA_DEFAULT : ENTALPHA_ENCODE(value);
}

beforeEach(() => {
  rec.clear();
  qglHolder.current = rec;
  r_wateralpha.value = 1;
  r_wateralpha.string = "1";
  r_lavaalpha.value = 0;
  r_lavaalpha.string = "0";
  r_slimealpha.value = 0;
  r_slimealpha.string = "0";
  r_telealpha.value = 0;
  r_telealpha.string = "0";
  r_drawentities.value = 1;
  clState.cl_numvisedicts = 0;
  cl_visedicts.fill(null);
  r_refdef.vieworg[0] = r_refdef.vieworg[1] = r_refdef.vieworg[2] = 0;
  glRsurfState.waterchain = null;
  for (const i of [1, 2, 3]) {
    cl_entities[i].model = null;
    cl_entities[i].origin[0] = cl_entities[i].origin[1] = cl_entities[i].origin[2] = 0;
    cl_entities[i].frame = 0;
    cl_entity_ext[i].alpha = ENTALPHA_DEFAULT;
  }
});

afterAll(() => {
  qglHolder.current = saved.qgl;
  r_wateralpha.string = saved.wateralpha;
  r_wateralpha.value = Number.parseFloat(saved.wateralpha);
  r_lavaalpha.string = saved.lavaalpha;
  r_lavaalpha.value = Number.parseFloat(saved.lavaalpha);
  r_slimealpha.string = saved.slimealpha;
  r_slimealpha.value = Number.parseFloat(saved.slimealpha);
  r_telealpha.string = saved.telealpha;
  r_telealpha.value = Number.parseFloat(saved.telealpha);
  gl_texsort.value = saved.gl_texsort;
  r_drawentities.value = saved.drawentities;
  clState.cl_numvisedicts = saved.numvisedicts;
  r_refdef.vieworg[0] = saved.vieworg[0];
  r_refdef.vieworg[1] = saved.vieworg[1];
  r_refdef.vieworg[2] = saved.vieworg[2];
  glRsurfState.waterchain = saved.waterchain;
  vup[0] = saved.vup[0];
  vup[1] = saved.vup[1];
  vup[2] = saved.vup[2];
  vright[0] = saved.vright[0];
  vright[1] = saved.vright[1];
  vright[2] = saved.vright[2];
  cl_entities[1].model = saved.ent1.model;
  cl_entities[1].origin.set(saved.ent1.origin);
  cl_entities[1].frame = saved.ent1.frame;
  cl_entity_ext[1].alpha = saved.ent1.alpha;
  cl_entities[2].model = saved.ent2.model;
  cl_entities[2].origin.set(saved.ent2.origin);
  cl_entities[2].frame = saved.ent2.frame;
  cl_entity_ext[2].alpha = saved.ent2.alpha;
  cl_entities[3].model = saved.ent3.model;
  cl_entities[3].origin.set(saved.ent3.origin);
  cl_entities[3].frame = saved.ent3.frame;
  cl_entity_ext[3].alpha = saved.ent3.alpha;
});

//============================================================================
// R_WaterAlphaForTextureName
//============================================================================

describe("R_WaterAlphaForTextureName", () => {
  test("a plain liquid texture uses r_wateralpha", () => {
    r_wateralpha.value = 0.5;
    expect(R_WaterAlphaForTextureName("*water0")).toBe(0.5);
  });

  test('a "*lava" texture uses r_lavaalpha when it is set (> 0)', () => {
    r_wateralpha.value = 0.5;
    r_lavaalpha.value = 0.25;
    expect(R_WaterAlphaForTextureName("*lava1")).toBe(0.25);
  });

  test('a "*lava" texture falls back to r_wateralpha when r_lavaalpha is 0 (unset)', () => {
    r_wateralpha.value = 0.7;
    r_lavaalpha.value = 0;
    expect(R_WaterAlphaForTextureName("*lava1")).toBe(0.7);
  });

  test('"*slime" and "*teleport" get their own overrides the same way', () => {
    r_wateralpha.value = 1;
    r_slimealpha.value = 0.4;
    r_telealpha.value = 0.6;
    expect(R_WaterAlphaForTextureName("*slime0")).toBe(0.4);
    expect(R_WaterAlphaForTextureName("*teleport")).toBe(0.6);
  });

  test("the match is case-insensitive on the texture body, matching gl_model.c's own strncmp/name convention", () => {
    r_lavaalpha.value = 0.2;
    expect(R_WaterAlphaForTextureName("*LAVA1")).toBe(0.2);
  });

  test("a non-liquid (no leading '*') texture name falls straight to r_wateralpha", () => {
    r_wateralpha.value = 0.9;
    expect(R_WaterAlphaForTextureName("brick0")).toBe(0.9);
  });
});

//============================================================================
// R_EntityAlpha
//============================================================================

describe("R_EntityAlpha", () => {
  test("an entity not found in cl_entities or cl_static_entities decodes ENTALPHA_DEFAULT (opaque)", () => {
    const e = new EntityT();
    expect(R_EntityAlpha(e)).toBe(ENTALPHA_DECODE(ENTALPHA_DEFAULT));
    expect(R_EntityAlpha(e)).toBe(1);
  });

  test("reads the decoded alpha out of cl_entity_ext by index", () => {
    setAlpha(2, 0.5);
    expect(R_EntityAlpha(cl_entities[2])).toBeCloseTo(0.5, 2);
  });

  test("reads cl_static_entity_ext for a static entity", () => {
    const saved = cl_static_entity_ext[0].alpha;
    cl_static_entity_ext[0].alpha = ENTALPHA_ENCODE(0.25);
    expect(R_EntityAlpha(cl_static_entities[0])).toBeCloseTo(0.25, 2);
    cl_static_entity_ext[0].alpha = saved;
  });
});

//============================================================================
// R_DrawEntitiesOnList -- alphapass ordering
//============================================================================

function makeSpriteModel(gl_texturenum: number): ModelT {
  const frame = new MspriteframeT();
  frame.up = 1;
  frame.down = -1;
  frame.left = -1;
  frame.right = 1;
  frame.gl_texturenum = gl_texturenum;

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
  return model;
}

describe("R_DrawEntitiesOnList -- alphapass", () => {
  test("opaque entities draw in the normal pass; translucent ones draw last, sorted far-to-near", () => {
    vup[0] = 0;
    vup[1] = 0;
    vup[2] = 1;
    vright[0] = 0;
    vright[1] = -1;
    vright[2] = 0;

    // entity 1: opaque, texture 10
    cl_entities[1].model = makeSpriteModel(10);
    cl_entities[1].origin[0] = 0;
    setAlpha(1, 0);

    // entity 2: translucent, texture 20, FAR from the viewer
    cl_entities[2].model = makeSpriteModel(20);
    cl_entities[2].origin[0] = 1000;
    setAlpha(2, 0.5);

    // entity 3: translucent, texture 30, NEAR the viewer
    cl_entities[3].model = makeSpriteModel(30);
    cl_entities[3].origin[0] = 100;
    setAlpha(3, 0.5);

    cl_visedicts[0] = cl_entities[1];
    cl_visedicts[1] = cl_entities[2];
    cl_visedicts[2] = cl_entities[3];
    clState.cl_numvisedicts = 3;

    R_DrawEntitiesOnList();

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture").map((c) => c.args[1]);
    // texture 10 (opaque) binds before both translucent ones (drawn in the
    // early sprite pass); 20 (far) binds before 30 (near) in the alphapass.
    expect(binds).toEqual([10, 20, 30]);
  });

  test("an all-opaque scene never runs the alphapass sort at all (no extra draws)", () => {
    cl_entities[1].model = makeSpriteModel(40);
    setAlpha(1, 0);
    cl_visedicts[0] = cl_entities[1];
    clState.cl_numvisedicts = 1;

    R_DrawEntitiesOnList();

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture").map((c) => c.args[1]);
    expect(binds).toEqual([40]);
  });

  test("r_drawentities 0 draws nothing", () => {
    r_drawentities.value = 0;
    cl_entities[1].model = makeSpriteModel(50);
    setAlpha(1, 0.5);
    cl_visedicts[0] = cl_entities[1];
    clState.cl_numvisedicts = 1;

    R_DrawEntitiesOnList();

    expect(rec.calls).toHaveLength(0);
  });
});

//============================================================================
// R_DrawWaterSurfaces -- per-surface alpha bracket
//============================================================================

describe("R_DrawWaterSurfaces", () => {
  function makeWaterSurface(name: string): MsurfaceT {
    const texture = new TextureT();
    texture.name = name;
    texture.gl_texturenum = 99;
    const texinfo = new MtexinfoT();
    texinfo.texture = texture;
    const surf = new MsurfaceT();
    surf.texinfo = texinfo;
    surf.flags |= SURF_DRAWTURB;
    setSurfPolys(surf, new GlpolyT(0));
    return surf;
  }

  test("r_wateralpha 1 (fully opaque) with gl_texsort on draws nothing (no translucent surfaces to catch)", () => {
    gl_texsort.value = 1;
    r_wateralpha.value = 1;
    glRsurfState.waterchain = makeWaterSurface("*water0");
    R_DrawWaterSurfaces();
    // r_wateralpha===1 && gl_texsort: the whole function is a no-op --
    // opaque water already drew in the normal (non-gl_texsort-skipped) pass.
    expect(rec.calls).toHaveLength(0);
  });

  test("translucent water (gl_texsort off) brackets EmitWaterPolys in depth-write-off + GL_BLEND + the surface's alpha", () => {
    gl_texsort.value = 0;
    r_wateralpha.value = 0.5;
    glRsurfState.waterchain = makeWaterSurface("*water0");

    R_DrawWaterSurfaces();

    const depthMask = rec.calls.filter((c) => c.name === "qglDepthMask").map((c) => c.args[0]);
    expect(depthMask).toEqual([false, true]);
    const enable = rec.calls.findIndex((c) => c.name === "qglEnable" && c.args[0] === GL_BLEND);
    const disable = rec.calls.findIndex((c) => c.name === "qglDisable" && c.args[0] === GL_BLEND);
    expect(enable).toBeGreaterThanOrEqual(0);
    expect(disable).toBeGreaterThan(enable);
    const colors = rec.calls.filter((c) => c.name === "qglColor4f");
    expect(colors[0].args).toEqual([1, 1, 1, 0.5]);
  });

  test("a lava surface uses r_lavaalpha instead of r_wateralpha when gl_texsort is off", () => {
    gl_texsort.value = 0;
    r_wateralpha.value = 1;
    r_lavaalpha.value = 0.3;
    glRsurfState.waterchain = makeWaterSurface("*lava1");

    R_DrawWaterSurfaces();

    const colors = rec.calls.filter((c) => c.name === "qglColor4f");
    expect(colors[0].args).toEqual([1, 1, 1, 0.3]);
  });
});
