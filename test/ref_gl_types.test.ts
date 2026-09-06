// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U070's four ref_gl header modules: glquake.ts (glquake.h),
gl_warp_sin.ts (gl_warp_sin.h), gl_model_types.ts (gl_model.h's GL alias,
sprite and glpoly types) and qgl.ts (the OpenGL function table WinQuake's
gl_*.c call through). Self-sufficient per standing order 13: the qglHolder
and glimp/SDL state every case touches is restored in afterAll.
*/

import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MplaneT } from "../src/common/mathlib";
import { MsurfaceT } from "../src/common/model";
import { SynctypeT, TrivertxT } from "../src/common/modelgen";
import { SpriteframetypeT } from "../src/common/spritegn";
import { turbsin } from "../src/ref_gl/gl_warp_sin";
import {
  AliashdrT,
  GlpolyT,
  MAXALIASFRAMES,
  MAXALIASTRIS,
  MAXALIASVERTS,
  MAX_SKINS,
  MaliasframedescT,
  MaliasgroupT,
  MaliasgroupframedescT,
  MspriteT,
  MspriteframeT,
  MspriteframedescT,
  MspritegroupT,
  MtriangleT,
  VERTEXSIZE,
} from "../src/ref_gl/gl_model_types";
import {
  ALIAS_BASE_SIZE_RATIO,
  BACKFACE_EPSILON,
  BLOCK_HEIGHT,
  BLOCK_WIDTH,
  GltextureT,
  GlvertT,
  MAX_GLTEXTURES,
  MAX_LBM_HEIGHT,
  MAX_LIGHTMAPS,
  SKYMASK,
  SKYSHIFT,
  SKYSIZE,
  TEXTURE0_SGIS,
  TEXTURE1_SGIS,
  TILE_SIZE,
  cnttextures,
  d_lightstylevalue,
  frustum,
  glState,
  glv,
  modelorg,
  r_avertexnormal_dots,
  r_base_world_matrix,
  r_entorigin,
  r_world_matrix,
  r_worldentity,
  setSurfPolys,
  surfPolys,
} from "../src/ref_gl/glquake";
import {
  GL_LINEAR,
  GL_POLYGON,
  GL_TRIANGLE_FAN,
  GL_VERSION,
  QGLRecording,
  QGL_Shutdown,
  SetQGL,
  loadQGLFromSystem,
  qgl,
  qglHolder,
} from "../src/ref_gl/qgl";
import { SysError } from "../src/platform/sys";
import { CreateGLimp, glimpHolder } from "../src/platform/glimp";
import { SDL_ResetBackendForTests, SDL_SetBackendEnabled } from "../src/platform/sdl";

const glStateDefaults = { ...glState };

afterAll(() => {
  qglHolder.current = null;
  Object.assign(glState, glStateDefaults);
  glimpHolder.current = null;
  SDL_ResetBackendForTests();
});

describe("src/ref_gl/gl_warp_sin.ts -- gl_warp.c's turbsin[] table", () => {
  test("is 256 single-precision entries", () => {
    expect(turbsin.length).toBe(256);
    expect(turbsin).toBeInstanceOf(Float32Array);
  });

  // values transcribed from WinQuake/gl_warp_sin.h; Math.fround because the
  // C stores them as `float`
  test("matches the header at its corners", () => {
    expect(turbsin[0]).toBe(0);
    expect(turbsin[1]).toBe(Math.fround(0.19633));
    expect(turbsin[64]).toBe(8);
    expect(turbsin[128]).toBe(Math.fround(9.79717e-16));
    expect(turbsin[192]).toBe(-8);
    expect(turbsin[255]).toBe(Math.fround(-0.19633));
  });

  test("is a sine: the second half negates the first, and each half mirrors about its peak", () => {
    for (let i = 1; i < 128; i++) {
      expect(turbsin[128 + i]).toBe(-turbsin[i]);
    }
    for (let i = 1; i < 64; i++) {
      expect(turbsin[128 - i]).toBe(turbsin[i]);
    }
    // amplitude 8, as EmitWaterPolys' `os + turbsin[...]` expects
    let max = 0;
    for (let i = 0; i < 256; i++) max = Math.max(max, Math.abs(turbsin[i]));
    expect(max).toBe(8);
  });
});

describe("src/ref_gl/qgl.ts -- the QGL table", () => {
  test("QGLRecording records a glBegin/glVertex3f/glEnd sequence in order", () => {
    const rec = new QGLRecording();
    rec.qglBegin(GL_POLYGON);
    rec.qglVertex3f(1, 2, 3);
    rec.qglVertex3f(4, 5, 6);
    rec.qglEnd();
    expect(rec.calls).toEqual([
      { name: "qglBegin", args: [GL_POLYGON] },
      { name: "qglVertex3f", args: [1, 2, 3] },
      { name: "qglVertex3f", args: [4, 5, 6] },
      { name: "qglEnd", args: [] },
    ]);
    rec.clear();
    expect(rec.calls.length).toBe(0);
  });

  test("QGLRecording's extension members are present and record too (the C's NULL-able function pointers)", () => {
    const rec = new QGLRecording();
    rec.qglSelectTextureSGIS(TEXTURE1_SGIS);
    rec.qglMTexCoord2fSGIS(TEXTURE1_SGIS, 0.25, 0.5);
    rec.qglArrayElementEXT(7);
    expect(rec.calls.map((c) => c.name)).toEqual(["qglSelectTextureSGIS", "qglMTexCoord2fSGIS", "qglArrayElementEXT"]);
  });

  test("QGLRecording implements every QGL member gl_*.c calls", () => {
    const rec = new QGLRecording();
    const members = [
      "qglAlphaFunc", "qglBegin", "qglBindTexture", "qglBlendFunc", "qglClear", "qglClearColor", "qglColor3f", "qglColor4f", "qglColor4fv",
      "qglCullFace", "qglDepthFunc", "qglDepthMask", "qglDepthRange", "qglDisable", "qglDrawBuffer", "qglEnable", "qglEnd", "qglFinish",
      "qglFlush", "qglFogf", "qglFogfv", "qglFogi", "qglFrustum", "qglGetFloatv", "qglGetString", "qglHint", "qglLoadIdentity",
      "qglLoadMatrixf", "qglMatrixMode", "qglOrtho", "qglPolygonMode", "qglPopMatrix", "qglPushMatrix", "qglReadBuffer", "qglReadPixels",
      "qglRotatef", "qglScalef", "qglShadeModel", "qglTexCoord2f", "qglTexCoord2fv", "qglTexEnvf", "qglTexImage2D", "qglTexParameterf",
      "qglTexSubImage2D", "qglTranslatef", "qglVertex2f", "qglVertex3f", "qglVertex3fv", "qglViewport",
      "qglMTexCoord2fSGIS", "qglSelectTextureSGIS", "qglColorTableEXT", "qglArrayElementEXT", "qglColorPointerEXT", "qglTexCoordPointerEXT",
      "qglVertexPointerEXT",
    ] as const;
    for (const name of members) {
      expect(typeof rec[name]).toBe("function");
    }
    expect(members.length).toBe(56);
  });

  test("qgl() Sys_Errors when no table is loaded, and returns the table once SetQGL runs", () => {
    const saved = qglHolder.current;
    SetQGL(null);
    expect(() => qgl()).toThrow(SysError);
    const rec = new QGLRecording();
    SetQGL(rec);
    expect(qgl()).toBe(rec);
    qgl().qglBegin(GL_TRIANGLE_FAN);
    expect(rec.calls).toEqual([{ name: "qglBegin", args: [GL_TRIANGLE_FAN] }]);
    qglHolder.current = saved;
  });

  test("GL enum values match <GL/gl.h>", () => {
    expect(GL_TRIANGLE_FAN).toBe(0x0006);
    expect(GL_POLYGON).toBe(0x0009);
    expect(GL_LINEAR).toBe(0x2601);
    expect(GL_VERSION).toBe(0x1f02);
  });
});

describe("src/ref_gl/qgl.ts -- loadQGLFromSystem against the real libGL", () => {
  // gl_vidlinuxglx.c dlopen()s libGL and dlsym()s off it; this is the same
  // bind. A live GL context is a separate question -- see the test below.
  test("binds every core entry point off the system GL library", () => {
    let loaded = false;
    try {
      const table = loadQGLFromSystem();
      loaded = true;
      expect(typeof table.qglBegin).toBe("function");
      expect(typeof table.qglGetString).toBe("function");
      expect(typeof table.qglTexImage2D).toBe("function");
      // glGetString with no context current returns NULL, which is exactly
      // what this call is asserting is survivable
      expect(table.qglGetString(GL_VERSION)).toBeNull();
    } catch (err) {
      // no libGL on this machine: the loader reports it rather than crashing
      expect(err instanceof Error && err.message.startsWith("loadQGLFromSystem: failed to load")).toBe(true);
    } finally {
      if (loaded) QGL_Shutdown();
    }
  });

  test("a real GL context through GLimp, when the SDL video driver can make one", () => {
    SDL_SetBackendEnabled(true);
    const glimp = CreateGLimp();
    expect(glimp.Init()).toBe(true);
    const haveContext = glimp.SetMode(320, 200, false);
    if (!haveContext) {
      // SDL's "dummy" driver rejects SDL_WINDOW_OPENGL outright, so there is
      // no context to query here; test/glimp.test.ts pins that behaviour.
      expect(glimp.GetProcAddress("glGetString")).toBeNull();
      SDL_ResetBackendForTests();
      return;
    }
    let loaded = false;
    try {
      const table = loadQGLFromSystem(glimp.GetProcAddress);
      loaded = true;
      const version = table.qglGetString(GL_VERSION);
      expect(version).not.toBeNull();
    } finally {
      if (loaded) QGL_Shutdown();
      glimp.Shutdown();
      SDL_ResetBackendForTests();
    }
  });
});

describe("src/ref_gl/glquake.ts -- glquake.h's constants and globals", () => {
  test("constants match the header", () => {
    expect(ALIAS_BASE_SIZE_RATIO).toBe(1.0 / 11.0);
    expect(MAX_LBM_HEIGHT).toBe(480);
    expect(TILE_SIZE).toBe(128);
    expect(SKYSHIFT).toBe(7);
    expect(SKYSIZE).toBe(128);
    expect(SKYMASK).toBe(127);
    expect(BACKFACE_EPSILON).toBe(0.01);
    expect(TEXTURE0_SGIS).toBe(0x835e);
    expect(TEXTURE1_SGIS).toBe(0x835f);
    // gl_draw.c's table size and gl_rsurf.c's lightmap block
    expect(MAX_GLTEXTURES).toBe(1024);
    expect(MAX_LIGHTMAPS).toBe(64);
    expect(BLOCK_WIDTH).toBe(128);
    expect(BLOCK_HEIGHT).toBe(128);
  });

  test("glState carries gl_rmain.c's/gl_draw.c's/gl_vidlinuxglx.c's initialisers", () => {
    expect(glStateDefaults.currenttexture).toBe(-1); // gl_rmain.c:44 `int currenttexture = -1;`
    expect(glStateDefaults.gl_mtexable).toBe(false); // gl_vidlinuxglx.c:108
    expect(glStateDefaults.texture_extension_number).toBe(1); // gl_vidlinuxglx.c:90
    expect(glStateDefaults.texture_mode).toBe(GL_LINEAR); // gl_vidlinuxglx.c:86
    expect(glStateDefaults.oldtarget).toBe(TEXTURE0_SGIS); // gl_draw.c:1285
    expect(glStateDefaults.mirror).toBe(false);
    expect(glStateDefaults.mirror_plane).toBeNull();
    expect(glStateDefaults.envmap).toBe(false);
    expect(glStateDefaults.r_framecount).toBe(0);
    expect(glStateDefaults.r_visframecount).toBe(0);
    expect(glStateDefaults.currententity).toBeNull();
    expect(glStateDefaults.r_notexture_mip).toBeNull();
    expect(glStateDefaults.gl_vendor).toBe("");
  });

  test("the in-place-mutated globals are the sizes and initial values the C gives them", () => {
    expect(frustum.length).toBe(4);
    for (const p of frustum) expect(p).toBeInstanceOf(MplaneT);
    expect(r_world_matrix.length).toBe(16);
    expect(Array.from(r_world_matrix)).toEqual(new Array<number>(16).fill(0));
    expect(r_base_world_matrix.length).toBe(16);
    expect(d_lightstylevalue.length).toBe(256);
    expect(Array.from(cnttextures)).toEqual([-1, -1]); // gl_rmain.c:46 `{-1, -1}`
    expect(modelorg.length).toBe(3);
    expect(r_entorigin.length).toBe(3);
    expect(r_worldentity).toBeDefined();
    expect(glv).toBeInstanceOf(GlvertT);
    expect(glv.x).toBe(0);
    expect(glv.b).toBe(0);
  });

  test("gltexture_t is gl_draw.c's texture-table entry", () => {
    const t = new GltextureT();
    expect(t.texnum).toBe(0);
    expect(t.identifier).toBe("");
    expect(t.width).toBe(0);
    expect(t.height).toBe(0);
    expect(t.mipmap).toBe(false);
  });

  test("r_avertexnormal_dots is re-exported for gl_rmain.c's R_SetupAliasFrame lighting", () => {
    expect(r_avertexnormal_dots.length).toBe(16 * 256);
  });
});

describe("src/ref_gl/gl_model_types.ts -- gl_model.h's GL-side model types", () => {
  test("glpoly_t allocates numverts * VERTEXSIZE floats", () => {
    expect(VERTEXSIZE).toBe(7);
    const p = new GlpolyT(9);
    expect(p.numverts).toBe(9);
    expect(p.verts.length).toBe(9 * VERTEXSIZE);
    expect(p.verts).toBeInstanceOf(Float32Array);
    expect(p.next).toBeNull();
    expect(p.chain).toBeNull();
    expect(p.flags).toBe(0);
    const empty = new GlpolyT();
    expect(empty.numverts).toBe(0);
    expect(empty.verts.length).toBe(0);
  });

  test("aliashdr_t is the GL layout (poseverts/posedata/commands/gl_texturenum/texels), not model.h's", () => {
    const h = new AliashdrT();
    expect(h.scale.length).toBe(3);
    expect(h.scale_origin.length).toBe(3);
    expect(h.eyeposition.length).toBe(3);
    expect(h.synctype).toBe(SynctypeT.ST_SYNC);
    expect(h.numposes).toBe(0);
    expect(h.poseverts).toBe(0);
    expect(h.posedata).toEqual([]);
    expect(h.commands).toBeInstanceOf(Int32Array);
    expect(h.commands.length).toBe(0);
    expect(MAX_SKINS).toBe(32);
    expect(h.gl_texturenum.length).toBe(MAX_SKINS * 4);
    expect(h.texels.length).toBe(MAX_SKINS);
    expect(h.texels.every((s) => s === null)).toBe(true);
    expect(h.frames).toEqual([]);
    expect(MAXALIASVERTS).toBe(1024);
    expect(MAXALIASFRAMES).toBe(256);
    expect(MAXALIASTRIS).toBe(2048);
  });

  test("maliasframedesc_t is the flat firstpose/numposes range, not a tagged single/group union", () => {
    const f = new MaliasframedescT();
    expect(f.firstpose).toBe(0);
    expect(f.numposes).toBe(0);
    expect(f.interval).toBe(0);
    expect(f.bboxmin).toBeInstanceOf(TrivertxT);
    expect(f.bboxmax).toBeInstanceOf(TrivertxT);
    expect(f.frame).toBe(0);
    expect(f.name).toBe("");
    // declared by gl_model.h, read by no GL .c file (see the module header)
    const g = new MaliasgroupT();
    expect(g.numframes).toBe(0);
    expect(g.intervals).toBe(0);
    expect(g.frames).toEqual([]);
    expect(new MaliasgroupframedescT().frame).toBe(0);
    const tri = new MtriangleT();
    expect(tri.facesfront).toBe(0);
    expect(tri.vertindex.length).toBe(3);
  });

  test("mspriteframe_t carries gl_texturenum where model.h carries pixels", () => {
    const fr = new MspriteframeT();
    expect(fr.gl_texturenum).toBe(0);
    expect("pixels" in fr).toBe(false);
    expect("pcachespot" in fr).toBe(false);
    const grp = new MspritegroupT();
    expect(grp.intervals).toBeInstanceOf(Float32Array);
    const desc = new MspriteframedescT();
    expect(desc.type).toBe(SpriteframetypeT.SPR_SINGLE);
    expect(desc.frameptr).toBeNull();
    const spr = new MspriteT();
    expect(spr.numframes).toBe(0);
    expect(spr.frames).toEqual([]);
    expect(spr.cachespot).toBeNull();
  });

  test("surfPolys narrows model.ts's `unknown` polys field back to glpoly_t without a cast", () => {
    const surf = new MsurfaceT();
    expect(surfPolys(surf)).toBeNull();
    const poly = new GlpolyT(3);
    setSurfPolys(surf, poly);
    expect(surfPolys(surf)).toBe(poly);
    setSurfPolys(surf, null);
    expect(surfPolys(surf)).toBeNull();
  });
});

describe("src/ref_gl -- module boundary", () => {
  // The two renderers are separate translation units in C and share no
  // storage; anorm_dots.h is the one exception, a read-only table filed
  // under src/ref_soft by PORTING.md's file table but read only by
  // gl_rmain.c.
  test("nothing in src/ref_gl imports src/ref_soft except anorm_dots", () => {
    const dir = join(import.meta.dir, "..", "src", "ref_gl");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, name), "utf8");
      for (const m of src.matchAll(/from\s+"(\.\.\/ref_soft\/[^"]+)"/g)) {
        if (m[1] !== "../ref_soft/anorm_dots") offenders.push(`${name}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
