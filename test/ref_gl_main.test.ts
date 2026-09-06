// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U072's src/ref_gl/gl_rmain.ts: the cvar/command registration
gl_rmisc.c's R_Init performs, the frustum, R_SetupGL's qgl call sequence,
R_RotateForEntity, GL_DrawAliasFrame's walk of gl_mesh.c's display-list
commands, R_DrawSpriteModel's quad, R_PolyBlend, and the three
particle-drawing seam bodies r_part.c's R_DrawParticles calls through the
renderer. R_MarkLeaves is defined in gl_rsurf.c; its test coverage lives in
test/ref_gl_rsurf.test.ts.

Every case drives a QGLRecording installed as qglHolder.current, and every
shared singleton the suite writes (glState, r_refdef, vid, vup/vpn/vright/
r_origin, cl, d_8to24table, cmdHost.initialized, the gl_rmain cvars) is saved
in beforeAll and restored in afterAll, per standing orders 13 and 15.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { Cmd_Exists, cmdHost } from "../src/common/cmd";
import { Cvar_FindVar, Cvar_VariableValue } from "../src/common/cvar";
import { ModelT, ModtypeT } from "../src/common/model";
import { TrivertxT } from "../src/common/modelgen";
import { SPR_VP_PARALLEL, SpriteframetypeT } from "../src/common/spritegn";
import { EntityT, ParticleT, r_origin, r_refdef, vpn, vright, vup } from "../src/client/render";
import { cl } from "../src/client/client";
import { d_8to24table, vid } from "../src/client/vid";
import { frustum, glState } from "../src/ref_gl/glquake";
import { AliashdrT, MspriteT, MspriteframeT, MspriteframedescT } from "../src/ref_gl/gl_model_types";
import {
  GL_ALPHA_TEST,
  GL_BLEND,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRONT,
  GL_MODELVIEW,
  GL_MODULATE,
  GL_PROJECTION,
  GL_QUADS,
  GL_REPLACE,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TRIANGLES,
  GL_TRIANGLE_FAN,
  type GLPointer,
  QGLRecording,
  SetQGL,
  qglHolder,
} from "../src/ref_gl/qgl";
import {
  D_DrawParticle,
  D_EndParticles,
  D_StartParticles,
  GL_DrawAliasFrame,
  MYgluPerspective,
  R_CullBox,
  R_DrawSpriteModel,
  R_PolyBlend,
  R_RotateForEntity,
  R_SetFrustum,
  R_SetupGL,
  gl_cull,
  gl_polyblend,
  r_novis,
  rmainState,
  v_blend,
} from "../src/ref_gl/gl_rmain";
import { R_Init } from "../src/ref_gl/gl_rmisc";

// QGLRecording stores every pointer argument by reference, and the C reuses one
// `vec3_t point` across all four sprite corners / every shadow vertex. This
// subclass snapshots each glVertex3fv argument so a test can see the four
// distinct corners the single buffer held.
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
  cmdInitialized: cmdHost.initialized,
  vidWidth: vid.width,
  vidHeight: vid.height,
  worldmodel: cl.worldmodel,
  clTime: cl.time,
  vrect: { x: r_refdef.vrect.x, y: r_refdef.vrect.y, width: r_refdef.vrect.width, height: r_refdef.vrect.height },
  fov_x: r_refdef.fov_x,
  fov_y: r_refdef.fov_y,
  viewangles: [r_refdef.viewangles[0], r_refdef.viewangles[1], r_refdef.viewangles[2]],
  vieworg: [r_refdef.vieworg[0], r_refdef.vieworg[1], r_refdef.vieworg[2]],
  r_origin: [r_origin[0], r_origin[1], r_origin[2]],
  vpn: [vpn[0], vpn[1], vpn[2]],
  vright: [vright[0], vright[1], vright[2]],
  vup: [vup[0], vup[1], vup[2]],
  glx: glState.glx,
  gly: glState.gly,
  glwidth: glState.glwidth,
  glheight: glState.glheight,
  envmap: glState.envmap,
  gl_mtexable: glState.gl_mtexable,
  mirror: glState.mirror,
  mirror_plane: glState.mirror_plane,
  currententity: glState.currententity,
  currenttexture: glState.currenttexture,
  particletexture: glState.particletexture,
  playertextures: glState.playertextures,
  texture_extension_number: glState.texture_extension_number,
  r_visframecount: glState.r_visframecount,
  r_viewleaf: glState.r_viewleaf,
  r_oldviewleaf: glState.r_oldviewleaf,
  palette7: d_8to24table[7],
  v_blend: [v_blend[0], v_blend[1], v_blend[2], v_blend[3]],
  shadelight: rmainState.shadelight,
  ambientlight: rmainState.ambientlight,
  lastposenum: rmainState.lastposenum,
  shadedots: rmainState.shadedots,
  gl_cull: gl_cull.value,
  gl_polyblend: gl_polyblend.value,
  r_novis: r_novis.value,
  frustum: frustum.map((p) => ({ normal: [p.normal[0], p.normal[1], p.normal[2]], dist: p.dist, type: p.type, signbits: p.signbits })),
};

beforeAll(() => {
  SetQGL(rec);
  cmdHost.initialized = false;
});

beforeEach(() => {
  rec.clear();
  rec.vertex3fv.length = 0;
});

afterAll(() => {
  SetQGL(saved.qgl);
  cmdHost.initialized = saved.cmdInitialized;
  vid.width = saved.vidWidth;
  vid.height = saved.vidHeight;
  cl.worldmodel = saved.worldmodel;
  cl.time = saved.clTime;
  r_refdef.vrect.x = saved.vrect.x;
  r_refdef.vrect.y = saved.vrect.y;
  r_refdef.vrect.width = saved.vrect.width;
  r_refdef.vrect.height = saved.vrect.height;
  r_refdef.fov_x = saved.fov_x;
  r_refdef.fov_y = saved.fov_y;
  for (let i = 0; i < 3; i++) {
    r_refdef.viewangles[i] = saved.viewangles[i];
    r_refdef.vieworg[i] = saved.vieworg[i];
    r_origin[i] = saved.r_origin[i];
    vpn[i] = saved.vpn[i];
    vright[i] = saved.vright[i];
    vup[i] = saved.vup[i];
  }
  glState.glx = saved.glx;
  glState.gly = saved.gly;
  glState.glwidth = saved.glwidth;
  glState.glheight = saved.glheight;
  glState.envmap = saved.envmap;
  glState.gl_mtexable = saved.gl_mtexable;
  glState.mirror = saved.mirror;
  glState.mirror_plane = saved.mirror_plane;
  glState.currententity = saved.currententity;
  glState.currenttexture = saved.currenttexture;
  glState.particletexture = saved.particletexture;
  glState.playertextures = saved.playertextures;
  glState.texture_extension_number = saved.texture_extension_number;
  glState.r_visframecount = saved.r_visframecount;
  glState.r_viewleaf = saved.r_viewleaf;
  glState.r_oldviewleaf = saved.r_oldviewleaf;
  d_8to24table[7] = saved.palette7;
  for (let i = 0; i < 4; i++) v_blend[i] = saved.v_blend[i];
  rmainState.shadelight = saved.shadelight;
  rmainState.ambientlight = saved.ambientlight;
  rmainState.lastposenum = saved.lastposenum;
  rmainState.shadedots = saved.shadedots;
  gl_cull.value = saved.gl_cull;
  gl_polyblend.value = saved.gl_polyblend;
  r_novis.value = saved.r_novis;
  for (let i = 0; i < 4; i++) {
    frustum[i].normal[0] = saved.frustum[i].normal[0];
    frustum[i].normal[1] = saved.frustum[i].normal[1];
    frustum[i].normal[2] = saved.frustum[i].normal[2];
    frustum[i].dist = saved.frustum[i].dist;
    frustum[i].type = saved.frustum[i].type;
    frustum[i].signbits = saved.frustum[i].signbits;
  }
});

function names(): string[] {
  return rec.calls.map((c) => c.name);
}

describe("R_Init (gl_rmisc.c)", () => {
  test("registers gl_rmain.c's cvars and the three console commands", () => {
    // gl_mtexable drives R_Init's `Cvar_SetValue ("gl_texsort", 0)`; pin it
    // false so the assertion below sees the C initializer
    glState.gl_mtexable = false;
    const beforeExt = glState.texture_extension_number;

    R_Init();

    expect(Cmd_Exists("timerefresh")).toBe(true);
    expect(Cmd_Exists("envmap")).toBe(true);
    expect(Cmd_Exists("pointfile")).toBe(true);

    // gl_rmain.c:99 spells the cvar "gl_doubleeys" while the C variable is
    // gl_doubleeyes -- a shipped typo this port keeps
    expect(Cvar_FindVar("gl_doubleeys")).not.toBeNull();
    expect(Cvar_FindVar("gl_doubleeyes")).toBeNull();
    expect(Cvar_VariableValue("gl_doubleeys")).toBe(1);

    for (const name of [
      "r_norefresh",
      "r_lightmap",
      "r_fullbright",
      "r_drawentities",
      "r_drawviewmodel",
      "r_shadows",
      "r_mirroralpha",
      "r_wateralpha",
      "r_dynamic",
      "r_novis",
      "r_speeds",
      "gl_finish",
      "gl_clear",
      "gl_texsort",
      "gl_cull",
      "gl_smoothmodels",
      "gl_affinemodels",
      "gl_polyblend",
      "gl_flashblend",
      "gl_playermip",
      "gl_nocolors",
      "gl_keeptjunctions",
      "gl_reporttjunctions",
    ]) {
      expect(Cvar_FindVar(name)).not.toBeNull();
    }

    // the C initializers of the GL-only cvars
    expect(Cvar_VariableValue("r_mirroralpha")).toBe(1);
    expect(Cvar_VariableValue("r_wateralpha")).toBe(1);
    expect(Cvar_VariableValue("r_dynamic")).toBe(1);
    expect(Cvar_VariableValue("gl_texsort")).toBe(1);
    expect(Cvar_VariableValue("gl_cull")).toBe(1);
    expect(Cvar_VariableValue("gl_flashblend")).toBe(1);
    expect(Cvar_VariableValue("gl_affinemodels")).toBe(0);

    // R_InitParticleTexture takes one texture name, then R_Init reserves 16
    // more for the color-translated player skins
    expect(glState.particletexture).toBe(beforeExt);
    expect(glState.playertextures).toBe(beforeExt + 1);
    expect(glState.texture_extension_number).toBe(beforeExt + 17);
  });
});

describe("R_SetFrustum / R_CullBox", () => {
  function setViewAxes(): void {
    r_refdef.fov_x = 90;
    r_refdef.fov_y = 90;
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
  }

  test("fov_x 90 takes the fast path: the four planes are vpn +/- vright and vpn +/- vup", () => {
    setViewAxes();

    R_SetFrustum();

    expect(Array.from(frustum[0].normal)).toEqual([1, -1, 0]);
    expect(Array.from(frustum[1].normal)).toEqual([1, 1, 0]);
    expect(Array.from(frustum[2].normal)).toEqual([1, 0, 1]);
    expect(Array.from(frustum[3].normal)).toEqual([1, 0, -1]);

    for (let i = 0; i < 4; i++) {
      expect(frustum[i].type).toBe(5); // PLANE_ANYZ
      expect(frustum[i].dist).toBe(0); // DotProduct(r_origin=0, normal)
    }

    // SignbitsForPlane: one bit per negative normal component
    expect(frustum[0].signbits).toBe(2);
    expect(frustum[1].signbits).toBe(0);
    expect(frustum[2].signbits).toBe(0);
    expect(frustum[3].signbits).toBe(4);
  });

  test("R_CullBox rejects a box behind the viewer and keeps one in front", () => {
    setViewAxes();
    R_SetFrustum();

    const behindMins = new Float32Array([-100, -10, -10]);
    const behindMaxs = new Float32Array([-50, 10, 10]);
    expect(R_CullBox(behindMins, behindMaxs)).toBe(true);

    const frontMins = new Float32Array([50, -10, -10]);
    const frontMaxs = new Float32Array([100, 10, 10]);
    expect(R_CullBox(frontMins, frontMaxs)).toBe(false);
  });
});

describe("R_RotateForEntity", () => {
  test("emits the translate then the three rotates in the C's order", () => {
    const e = new EntityT();
    e.origin[0] = 1;
    e.origin[1] = 2;
    e.origin[2] = 3;
    e.angles[0] = 10;
    e.angles[1] = 20;
    e.angles[2] = 30;

    R_RotateForEntity(e);

    expect(rec.calls).toEqual([
      { name: "qglTranslatef", args: [1, 2, 3] },
      { name: "qglRotatef", args: [20, 0, 0, 1] },
      { name: "qglRotatef", args: [-10, 0, 1, 0] },
      { name: "qglRotatef", args: [30, 1, 0, 0] },
    ]);
  });
});

describe("MYgluPerspective / R_SetupGL", () => {
  test("MYgluPerspective turns fovy/aspect into the C's glFrustum arguments", () => {
    MYgluPerspective(90, 1.6, 4, 4096);

    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0].name).toBe("qglFrustum");
    const args = rec.calls[0].args;
    expect(typeof args[0] === "number" ? args[0] : NaN).toBeCloseTo(-6.4, 5);
    expect(typeof args[1] === "number" ? args[1] : NaN).toBeCloseTo(6.4, 5);
    expect(typeof args[2] === "number" ? args[2] : NaN).toBeCloseTo(-4, 5);
    expect(typeof args[3] === "number" ? args[3] : NaN).toBeCloseTo(4, 5);
    expect(args[4]).toBe(4);
    expect(args[5]).toBe(4096);
  });

  test("R_SetupGL emits viewport, projection, the five rotates and the drawing parms", () => {
    vid.width = 320;
    vid.height = 200;
    glState.glx = 0;
    glState.gly = 0;
    glState.glwidth = 640;
    glState.glheight = 400;
    glState.envmap = false;
    glState.mirror = false;
    gl_cull.value = 1;
    r_refdef.vrect.x = 0;
    r_refdef.vrect.y = 0;
    r_refdef.vrect.width = 320;
    r_refdef.vrect.height = 200;
    r_refdef.fov_y = 90;
    r_refdef.viewangles[0] = 10;
    r_refdef.viewangles[1] = 20;
    r_refdef.viewangles[2] = 30;
    r_refdef.vieworg[0] = 1;
    r_refdef.vieworg[1] = 2;
    r_refdef.vieworg[2] = 3;

    R_SetupGL();

    expect(names()).toEqual([
      "qglMatrixMode",
      "qglLoadIdentity",
      "qglViewport",
      "qglFrustum",
      "qglCullFace",
      "qglMatrixMode",
      "qglLoadIdentity",
      "qglRotatef",
      "qglRotatef",
      "qglRotatef",
      "qglRotatef",
      "qglRotatef",
      "qglTranslatef",
      "qglGetFloatv",
      "qglEnable",
      "qglDisable",
      "qglDisable",
      "qglEnable",
    ]);

    expect(rec.calls[0].args).toEqual([GL_PROJECTION]);
    // x=0, x2=640, y=400, y2=0 -- none of the four fudge steps fire
    expect(rec.calls[2].args).toEqual([0, 0, 640, 400]);
    expect(rec.calls[4].args).toEqual([GL_FRONT]);
    expect(rec.calls[5].args).toEqual([GL_MODELVIEW]);
    expect(rec.calls[7].args).toEqual([-90, 1, 0, 0]);
    expect(rec.calls[8].args).toEqual([90, 0, 0, 1]);
    expect(rec.calls[9].args).toEqual([-30, 1, 0, 0]);
    expect(rec.calls[10].args).toEqual([-10, 0, 1, 0]);
    expect(rec.calls[11].args).toEqual([-20, 0, 0, 1]);
    expect(rec.calls[12].args).toEqual([-1, -2, -3]);
    expect(rec.calls[14].args).toEqual([GL_CULL_FACE]);
    expect(rec.calls[17].args).toEqual([GL_DEPTH_TEST]);
  });
});

describe("GL_DrawAliasFrame", () => {
  test("walks one triangle fan out of the command list, lighting each vertex from shadedots", () => {
    const paliashdr = new AliashdrT();
    paliashdr.numposes = 1;
    paliashdr.poseverts = 3;

    for (let i = 0; i < 3; i++) {
      const v = new TrivertxT();
      v.v[0] = 10 * (i + 1);
      v.v[1] = 20 * (i + 1);
      v.v[2] = 30 * (i + 1);
      v.lightnormalindex = i;
      paliashdr.posedata.push(v);
    }

    // gl_mesh.c's layout: [count][s0 t0][s1 t1][s2 t2][0], with the texture
    // coordinates written as raw float bits into the int command list
    const buf = new ArrayBuffer(8 * 4);
    const cmdI = new Int32Array(buf);
    const cmdF = new Float32Array(buf);
    cmdI[0] = -3; // negative count -> GL_TRIANGLE_FAN
    cmdF[1] = 0.125;
    cmdF[2] = 0.25;
    cmdF[3] = 0.375;
    cmdF[4] = 0.5;
    cmdF[5] = 0.625;
    cmdF[6] = 0.75;
    cmdI[7] = 0; // terminator
    paliashdr.commands = cmdI;

    rmainState.shadelight = 1;
    const dots = rmainState.shadedots;

    GL_DrawAliasFrame(paliashdr, 0);

    expect(rmainState.lastposenum).toBe(0);
    expect(names()).toEqual([
      "qglBegin",
      "qglTexCoord2f",
      "qglColor3f",
      "qglVertex3f",
      "qglTexCoord2f",
      "qglColor3f",
      "qglVertex3f",
      "qglTexCoord2f",
      "qglColor3f",
      "qglVertex3f",
      "qglEnd",
    ]);
    expect(rec.calls[0].args).toEqual([GL_TRIANGLE_FAN]);
    expect(rec.calls[1].args).toEqual([0.125, 0.25]);
    expect(rec.calls[2].args).toEqual([dots[0], dots[0], dots[0]]);
    expect(rec.calls[3].args).toEqual([10, 20, 30]);
    expect(rec.calls[4].args).toEqual([0.375, 0.5]);
    expect(rec.calls[5].args).toEqual([dots[1], dots[1], dots[1]]);
    expect(rec.calls[6].args).toEqual([20, 40, 60]);
    expect(rec.calls[7].args).toEqual([0.625, 0.75]);
    expect(rec.calls[8].args).toEqual([dots[2], dots[2], dots[2]]);
    expect(rec.calls[9].args).toEqual([30, 60, 90]);
  });
});

describe("R_DrawSpriteModel", () => {
  test("emits a GL_QUADS with the four corners built from the frame's up/down/left/right", () => {
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
    glState.currententity = e;

    vup[0] = 0;
    vup[1] = 0;
    vup[2] = 1;
    vright[0] = 0;
    vright[1] = -1;
    vright[2] = 0;

    R_DrawSpriteModel(e);

    const seq = names();
    expect(seq[0]).toBe("qglColor3f");
    expect(rec.calls[0].args).toEqual([1, 1, 1]);
    // GL_DisableMultitexture / GL_Bind sit between; the quad itself is the tail
    const beginAt = seq.indexOf("qglBegin");
    expect(beginAt).toBeGreaterThan(0);
    expect(rec.calls[beginAt].args).toEqual([GL_QUADS]);
    expect(seq.slice(beginAt)).toEqual([
      "qglBegin",
      "qglTexCoord2f",
      "qglVertex3fv",
      "qglTexCoord2f",
      "qglVertex3fv",
      "qglTexCoord2f",
      "qglVertex3fv",
      "qglTexCoord2f",
      "qglVertex3fv",
      "qglEnd",
      "qglDisable",
    ]);
    expect(rec.calls[beginAt + 1].args).toEqual([0, 1]);
    expect(rec.calls[beginAt + 3].args).toEqual([0, 0]);
    expect(rec.calls[beginAt + 5].args).toEqual([1, 0]);
    expect(rec.calls[beginAt + 7].args).toEqual([1, 1]);
    expect(rec.calls[beginAt + 10].args).toEqual([GL_ALPHA_TEST]);

    // origin + down*vup + left*vright, then the other three corners
    expect(rec.vertex3fv).toEqual([
      [0, 8, -10],
      [0, 8, 10],
      [0, -8, 10],
      [0, -8, -10],
    ]);
  });
});

describe("R_PolyBlend", () => {
  test("draws nothing when v_blend[3] is zero", () => {
    gl_polyblend.value = 1;
    v_blend[0] = 1;
    v_blend[1] = 0;
    v_blend[2] = 0;
    v_blend[3] = 0;

    R_PolyBlend();

    expect(rec.calls.length).toBe(0);
  });

  test("draws the full-screen quad when v_blend[3] is non-zero", () => {
    gl_polyblend.value = 1;
    v_blend[0] = 1;
    v_blend[1] = 0.5;
    v_blend[2] = 0.25;
    v_blend[3] = 0.75;

    R_PolyBlend();

    const seq = names();
    expect(seq.slice(seq.indexOf("qglDisable"))).toEqual([
      "qglDisable",
      "qglEnable",
      "qglDisable",
      "qglDisable",
      "qglLoadIdentity",
      "qglRotatef",
      "qglRotatef",
      "qglColor4fv",
      "qglBegin",
      "qglVertex3f",
      "qglVertex3f",
      "qglVertex3f",
      "qglVertex3f",
      "qglEnd",
      "qglDisable",
      "qglEnable",
      "qglEnable",
    ]);

    const colorAt = seq.indexOf("qglColor4fv");
    expect(rec.calls[colorAt].args[0]).toBe(v_blend);
    expect(rec.calls[colorAt + 2].args).toEqual([10, 100, 100]);
    expect(rec.calls[colorAt + 3].args).toEqual([10, -100, 100]);
    expect(rec.calls[colorAt + 4].args).toEqual([10, -100, -100]);
    expect(rec.calls[colorAt + 5].args).toEqual([10, 100, -100]);
  });

  test("draws nothing when gl_polyblend is 0", () => {
    gl_polyblend.value = 0;
    v_blend[3] = 0.75;

    R_PolyBlend();

    expect(rec.calls.length).toBe(0);
  });
});

// R_MarkLeaves is defined in gl_rsurf.c and covered by
// test/ref_gl_rsurf.test.ts; gl_rmain.ts only imports and calls it.

describe("the r_part.c GLQUAKE particle seam", () => {
  test("D_StartParticles binds the particle texture and opens GL_TRIANGLES; D_DrawParticle emits three vertices", () => {
    glState.particletexture = 5;
    glState.currenttexture = -1;
    vup[0] = 0;
    vup[1] = 0;
    vup[2] = 1;
    vright[0] = 0;
    vright[1] = -1;
    vright[2] = 0;
    vpn[0] = 1;
    vpn[1] = 0;
    vpn[2] = 0;
    r_origin[0] = r_origin[1] = r_origin[2] = 0;

    // (255<<24) | r | (g<<8) | (b<<16), the packing platform/vid.ts's
    // VID_SetPalette writes; glColor3ubv reads the first three bytes
    d_8to24table[7] = ((255 << 24) | 10 | (20 << 8) | (30 << 16)) >>> 0;

    D_StartParticles();

    const startSeq = names();
    expect(startSeq).toContain("qglBindTexture");
    expect(startSeq.slice(startSeq.indexOf("qglBindTexture") + 1)).toEqual(["qglEnable", "qglTexEnvf", "qglBegin"]);
    expect(rec.calls[rec.calls.length - 3].args).toEqual([GL_BLEND]);
    expect(rec.calls[rec.calls.length - 2].args).toEqual([GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE]);
    expect(rec.calls[rec.calls.length - 1].args).toEqual([GL_TRIANGLES]);

    rec.clear();

    const p = new ParticleT();
    p.org[0] = 10; // scale = 10 < 20 -> scale stays 1
    p.org[1] = 0;
    p.org[2] = 0;
    p.color = 7;

    D_DrawParticle(p);

    expect(names()).toEqual(["qglColor3f", "qglTexCoord2f", "qglVertex3fv", "qglTexCoord2f", "qglVertex3f", "qglTexCoord2f", "qglVertex3f"]);
    expect(rec.calls[0].args).toEqual([10 / 255, 20 / 255, 30 / 255]);
    expect(rec.calls[1].args).toEqual([0, 0]);
    // up = vup*1.5, right = vright*1.5
    expect(rec.calls[4].args).toEqual([10, 0, 1.5]);
    expect(rec.calls[6].args).toEqual([10, -1.5, 0]);

    rec.clear();

    D_EndParticles();

    expect(names()).toEqual(["qglEnd", "qglDisable", "qglTexEnvf"]);
    expect(rec.calls[1].args).toEqual([GL_BLEND]);
    expect(rec.calls[2].args).toEqual([GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE]);
  });

  test("D_DrawParticle applies the distance scale hack past 20 units", () => {
    glState.particletexture = 5;
    vup[0] = 0;
    vup[1] = 0;
    vup[2] = 1;
    vright[0] = 0;
    vright[1] = -1;
    vright[2] = 0;
    vpn[0] = 1;
    vpn[1] = 0;
    vpn[2] = 0;
    r_origin[0] = r_origin[1] = r_origin[2] = 0;
    d_8to24table[7] = 0;

    D_StartParticles();
    rec.clear();

    const p = new ParticleT();
    p.org[0] = 100; // scale = 100 -> 1 + 100*0.004 = 1.4
    p.color = 7;

    D_DrawParticle(p);

    expect(rec.calls[4].args).toEqual([100, 0, 1.5 * 1.4]);
    expect(rec.calls[6].args).toEqual([100, -1.5 * 1.4, 0]);
  });
});

test("GL_TEXTURE_2D is the target every bind in this suite used", () => {
  // guards the constant the seam bodies pass through GL_Bind
  expect(GL_TEXTURE_2D).toBe(0x0de1);
});
