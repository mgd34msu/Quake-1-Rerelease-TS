// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U29 (the GL renderer's re-release MD5 replacement models):
src/ref_gl/gl_md5.ts, plus the load-time hook src/ref_gl/gl_model.ts wires
in (attachMd5GlReplacementIfAny) and the draw-time branch
src/ref_gl/gl_rmain.ts's R_DrawAliasModel takes when a payload is attached.

Unlike test/ref_soft_md5.test.ts (which needs the FULL software render
pipeline to compare drawn PIXELS), this suite drives gl_md5.ts's own
exported entry points directly against a QGLRecording -- "GL correctness"
here is "the recorded qgl* call sequence", so there is no need for
Mod_Init/R_Init/a full Mod_ForName load: attachMd5GlReplacementIfAny only
needs COM_FindFileTier/COM_LoadTempFile (a filesystem), and
GL_DrawMd5AliasFrame is driven directly with a hand-built payload/entity.
The one exception is the "r_enhancedmodels branches" describe block, which
drives the full R_DrawAliasModel entry point (gl_rmain.ts) to prove the
draw-time branch itself, following test/ref_gl_lerp.test.ts's own
hand-built-AliashdrT convention.

Self-sufficient per standing order 13: every shared singleton this file
mutates (qglHolder, glState.currententity/currenttexture, cl.time/
cl.worldmodel, frustum, r_enhancedmodels, gl_nocolors, r_shadows, the
common.ts filesystem globals) is snapshotted and restored.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  COM_LoadTempFile,
  com_gamedir,
  com_modified,
  com_searchpaths,
  pop,
  setComGamedir,
  setComModified,
  setComSearchpaths,
  setStaticRegistered,
  static_registered,
} from "../src/common/common";
import { ModelT, ModtypeT } from "../src/common/model";
import { MdlT, readMdl, TrivertxT } from "../src/common/modelgen";
import { EntityT, LERP_MOVESTEP, r_lerpmove } from "../src/client/render";
import { cl } from "../src/client/client";
import { vec3 } from "../src/common/mathlib";
import { frustum, glState } from "../src/ref_gl/glquake";
import { lightspot } from "../src/ref_gl/gl_rlight";
import { AliashdrT, MaliasframedescT } from "../src/ref_gl/gl_model_types";
import { GL_TRIANGLE_FAN, GL_TRIANGLES, GLPointer, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { R_DrawAliasModel, gl_nocolors, r_shadows } from "../src/ref_gl/gl_rmain";
import * as glDraw from "../src/ref_gl/gl_draw";
import { GL_DrawMd5AliasFrame, GL_DrawMd5Shadow, type Md5GlAliasT, attachMd5GlReplacementIfAny, getMd5GlPayload, md5ShadeDot, md5TranslateSkin, r_enhancedmodels } from "../src/ref_gl/gl_md5";
import { ensureDir } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

//============================================================================
// small local byte/text builders (test infrastructure only, not a port of
// any C -- mirrors test/ref_soft_md5.test.ts's own helpers of the same
// shape, duplicated here per standing order 13's self-sufficiency rule)

function buildLmp(width: number, height: number, fillValue: number): Uint8Array {
  const buf = new Uint8Array(8 + width * height);
  const view = new DataView(buf.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  buf.fill(fillValue & 0xff, 8);
  return buf;
}

// one joint, one triangle, three verts offset from the joint origin.
function md5MeshText(shader: string): string {
  return `MD5Version 10
commandline ""

numJoints 1
numMeshes 1

joints {
  "joint0" -1 ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

mesh {
  shader "${shader}"

  numverts 3
  vert 0 ( 0.0 0.0 ) 0 1
  vert 1 ( 1.0 0.0 ) 1 1
  vert 2 ( 0.0 1.0 ) 2 1

  numtris 1
  tri 0 0 1 2

  numweights 3
  weight 0 0 1.0 ( 0.0 -30.0 -30.0 )
  weight 1 0 1.0 ( 0.0 30.0 -30.0 )
  weight 2 0 1.0 ( 0.0 30.0 30.0 )
}
`;
}

// a static (no animated components) one-frame anim -- `numJoints` is only
// ever 1 (matching) or 2 (the mg3 ogre_rocket-shaped mismatch): the
// mismatch throws before this text's own hierarchy/baseframe body (one
// joint's worth) is ever parsed, so it never needs to vary.
function md5AnimText(numJoints: number): string {
  return `MD5Version 10
commandline ""

numFrames 1
numJoints ${numJoints}
frameRate 24
numAnimatedComponents 0

hierarchy {
  "joint0" -1 0 0
}

bounds {
  ( -30.0 -30.0 -30.0 ) ( 30.0 30.0 30.0 )
}

baseframe {
  ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

frame 0 {
}
`;
}

// two frames, joint position.x animated from 0 to 10 -- the blend test's
// own fixture.
function md5AnimTextBlend(): string {
  return `MD5Version 10
commandline ""

numFrames 2
numJoints 1
frameRate 24
numAnimatedComponents 1

hierarchy {
  "joint0" -1 1 0
}

bounds {
  ( -30.0 -30.0 -30.0 ) ( 30.0 30.0 30.0 )
  ( -30.0 -30.0 -30.0 ) ( 30.0 30.0 30.0 )
}

baseframe {
  ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

frame 0 {
  0.0
}
frame 1 {
  10.0
}
`;
}

//============================================================================
// shared fixture plumbing

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

// U35: GL_DrawMd5Shadow (like gl_rmain.ts's own GL_DrawAliasShadow) reuses
// one scratch vec3 across every vertex it emits through qglVertex3fv --
// QGLRecording stores that call's argument by reference, so reading it back
// afterwards would show only the LAST vertex repeated. This subclass
// snapshots each call's value at the time it was made, the same idiom
// test/ref_gl_lerp.test.ts's own SnapshottingQGL and test/ref_gl_main.
// test.ts's own copy of it use for the same reason.
class SnapshottingQGL extends QGLRecording {
  readonly vertex3fv: number[][] = [];

  override qglVertex3fv(v: GLPointer): void {
    if (v instanceof Float32Array) this.vertex3fv.push([v[0], v[1], v[2]]);
    super.qglVertex3fv(v);
  }
}

const rec = new SnapshottingQGL();
let nextTexnum = 1;
let loadTextureSpy: ReturnType<typeof spyOn>;
let scratchDir: string;

const saved = {
  qgl: qglHolder.current,
  currententity: glState.currententity,
  currenttexture: glState.currenttexture,
  comSearchpaths: com_searchpaths,
  comGamedir: com_gamedir,
  comModified: com_modified,
  staticRegistered: static_registered,
  enhancedString: r_enhancedmodels.string,
  enhancedValue: r_enhancedmodels.value,
  clTime: cl.time,
  clWorldmodel: cl.worldmodel,
  gl_nocolors: gl_nocolors.value,
  r_shadows: r_shadows.value,
  r_lerpmove: r_lerpmove.value,
  lightspot: [lightspot[0], lightspot[1], lightspot[2]],
  frustum: frustum.map((p) => ({ normal: [p.normal[0], p.normal[1], p.normal[2]], dist: p.dist, type: p.type, signbits: p.signbits })),
};

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

beforeAll(() => {
  scratchDir = mkdtempSync(join(scratchRoot, "ref-gl-md5-test-"));
  ensureDir(join(scratchDir, "id1"));

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  writePakToDisk(join(scratchDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    // "tri": a matching, tier-equal MD5 pair -- the basic load+draw fixture.
    { name: "progs/tri.mdl", data: new Uint8Array(4) },
    { name: "progs/tri.md5mesh", data: new TextEncoder().encode(md5MeshText("tri")) },
    { name: "progs/tri.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/tri_00_00.lmp", data: buildLmp(4, 4, 200) },
    // "blend": a two-frame animated pair, for the pose-lerp test.
    { name: "progs/blend.mdl", data: new Uint8Array(4) },
    { name: "progs/blend.md5mesh", data: new TextEncoder().encode(md5MeshText("blend")) },
    { name: "progs/blend.md5anim", data: new TextEncoder().encode(md5AnimTextBlend()) },
    { name: "progs/blend_00_00.lmp", data: buildLmp(4, 4, 200) },
    // "off": has a valid MD5 pair too, but only ever attached with
    // r_enhancedmodels 0 -- proves the load-time gate skips it entirely.
    { name: "progs/off.mdl", data: new Uint8Array(4) },
    { name: "progs/off.md5mesh", data: new TextEncoder().encode(md5MeshText("off")) },
    { name: "progs/off.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/off_00_00.lmp", data: buildLmp(4, 4, 200) },
    // "bad": a REAL, format-broken pair (mesh numJoints 1, anim numJoints
    // 2 -- the same shape of failure as mg3/progs/ogre_rocket) -- must
    // fall back (no payload attached) rather than throw.
    { name: "progs/bad.mdl", data: new Uint8Array(4) },
    { name: "progs/bad.md5mesh", data: new TextEncoder().encode(md5MeshText("bad")) },
    { name: "progs/bad.md5anim", data: new TextEncoder().encode(md5AnimText(2)) },
    // "tier": the .mdl only in pak1 (mounted after pak0, so it is searched
    // FIRST -- tier 0); the MD5 pair only in pak0 (tier 1, lower priority).
    { name: "progs/tier.md5mesh", data: new TextEncoder().encode(md5MeshText("tier")) },
    { name: "progs/tier.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/tier_00_00.lmp", data: buildLmp(4, 4, 200) },
    // "mixed": used by the R_DrawAliasModel end-to-end branch tests below,
    // paired with a HAND-BUILT classic AliashdrT (not loaded through
    // Mod_LoadAliasModel at all -- only its .mdl NAME needs to resolve to
    // a tier for attachMd5GlReplacementIfAny's own tier check).
    { name: "progs/mixed.mdl", data: new Uint8Array(4) },
    { name: "progs/mixed.md5mesh", data: new TextEncoder().encode(md5MeshText("mixed")) },
    { name: "progs/mixed.md5anim", data: new TextEncoder().encode(md5AnimText(1)) },
    { name: "progs/mixed_00_00.lmp", data: buildLmp(4, 4, 200) },
  ]);
  writePakToDisk(join(scratchDir, "id1", "pak1.pak"), [{ name: "progs/tier.mdl", data: new Uint8Array(4) }]);

  COM_InitArgv(["quake", "-basedir", scratchDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();

  loadTextureSpy = spyOn(glDraw, "GL_LoadTexture").mockImplementation(() => nextTexnum++);
  SetQGL(rec);
});

beforeEach(() => {
  rec.clear();
  rec.vertex3fv.length = 0;
  loadTextureSpy.mockClear();
  glState.currenttexture = -1;
  glState.currententity = null;
  cl.time = 0;
  cl.worldmodel = null; // R_LightPoint returns a deterministic 255 with no lightdata
  gl_nocolors.value = 1; // skip the player-colormap GL_Bind branch
  r_shadows.value = 0;
  r_lerpmove.value = 1;
  r_enhancedmodels.string = "1";
  r_enhancedmodels.value = 1;
  lightspot[0] = 0;
  lightspot[1] = 0;
  lightspot[2] = 0;
  openFrustum();
});

afterAll(() => {
  loadTextureSpy.mockRestore();
  SetQGL(saved.qgl);
  glState.currententity = saved.currententity;
  glState.currenttexture = saved.currenttexture;
  setComSearchpaths(saved.comSearchpaths);
  setComGamedir(saved.comGamedir);
  setComModified(saved.comModified);
  setStaticRegistered(saved.staticRegistered);
  r_enhancedmodels.string = saved.enhancedString;
  r_enhancedmodels.value = saved.enhancedValue;
  cl.time = saved.clTime;
  cl.worldmodel = saved.clWorldmodel;
  gl_nocolors.value = saved.gl_nocolors;
  r_shadows.value = saved.r_shadows;
  r_lerpmove.value = saved.r_lerpmove;
  lightspot[0] = saved.lightspot[0];
  lightspot[1] = saved.lightspot[1];
  lightspot[2] = saved.lightspot[2];
  for (let i = 0; i < 4; i++) {
    frustum[i].normal[0] = saved.frustum[i].normal[0];
    frustum[i].normal[1] = saved.frustum[i].normal[1];
    frustum[i].normal[2] = saved.frustum[i].normal[2];
    frustum[i].dist = saved.frustum[i].dist;
    frustum[i].type = saved.frustum[i].type;
    frustum[i].signbits = saved.frustum[i].signbits;
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================
// attachMd5GlReplacementIfAny / getMd5GlPayload
//============================================================================

describe("attachMd5GlReplacementIfAny", () => {
  test("loads a payload for a matching MD5 pair, uploading the skin through GL_LoadTexture", () => {
    const mod = new ModelT();
    mod.name = "progs/tri.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;

    attachMd5GlReplacementIfAny(mod, hdr, mdl);

    const payload = getMd5GlPayload(hdr);
    expect(payload).not.toBeNull();
    if (!payload) return;
    expect(payload.model.meshes.length).toBe(1);
    expect(payload.model.meshes[0].numIndices / 3).toBe(1);
    expect(payload.skins.length).toBe(1);
    expect(payload.skins[0].width).toBe(4);
    expect(payload.skins[0].height).toBe(4);
    expect(glDraw.GL_LoadTexture).toHaveBeenCalledWith("progs/tri_00_00.lmp", 4, 4, expect.anything(), true, false);
  });

  test("r_enhancedmodels 0 at load time never attaches a payload", () => {
    r_enhancedmodels.value = 0;
    const mod = new ModelT();
    mod.name = "progs/off.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;

    attachMd5GlReplacementIfAny(mod, hdr, mdl);

    expect(getMd5GlPayload(hdr)).toBeNull();
  });

  test("the tier rule: a .md5mesh in a lower tier than the .mdl is ignored", () => {
    const mod = new ModelT();
    mod.name = "progs/tier.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;

    attachMd5GlReplacementIfAny(mod, hdr, mdl);

    expect(getMd5GlPayload(hdr)).toBeNull();
  });

  test("a format error in the MD5 pair (joint-count mismatch) falls back silently", () => {
    const mod = new ModelT();
    mod.name = "progs/bad.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;

    attachMd5GlReplacementIfAny(mod, hdr, mdl);

    expect(getMd5GlPayload(hdr)).toBeNull();
  });
});

//============================================================================
// GL_DrawMd5AliasFrame -- triangle count, texcoords, skin bind
//============================================================================

describe("GL_DrawMd5AliasFrame", () => {
  let triPayload: Md5GlAliasT;

  beforeAll(() => {
    const mod = new ModelT();
    mod.name = "progs/tri.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;
    attachMd5GlReplacementIfAny(mod, hdr, mdl);
    const p = getMd5GlPayload(hdr);
    if (!p) throw new Error("test setup: no MD5 payload attached for progs/tri.mdl");
    triPayload = p;
  });

  test("draws the expected triangle count, the mesh's own texcoords, and binds the skin texture", () => {
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    GL_DrawMd5AliasFrame(triPayload, ent, 0, 0, 0, shadevector, shadelightColor, 1);

    const beginCalls = rec.calls.filter((c) => c.name === "qglBegin");
    expect(beginCalls.length).toBe(1);
    expect(beginCalls[0].args).toEqual([GL_TRIANGLES]);

    const vertexCalls = rec.calls.filter((c) => c.name === "qglVertex3f");
    expect(vertexCalls.length).toBe(3); // one triangle

    const texcoordCalls = rec.calls.filter((c) => c.name === "qglTexCoord2f");
    expect(texcoordCalls.map((c) => c.args)).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);

    const bindCalls = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(bindCalls.some((c) => c.args[1] === triPayload.skins[0].texturenum)).toBe(true);
  });

  test("an out-of-range skinnum falls back to skin 0", () => {
    const ent = new EntityT();
    ent.skinnum = 5;
    ent.syncbase = 0;
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    GL_DrawMd5AliasFrame(triPayload, ent, 0, 0, 0, shadevector, shadelightColor, 1);

    const bindCalls = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(bindCalls.some((c) => c.args[1] === triPayload.skins[0].texturenum)).toBe(true);
  });
});

describe("GL_DrawMd5AliasFrame two-frame pose blend", () => {
  let blendPayload: Md5GlAliasT;

  beforeAll(() => {
    const mod = new ModelT();
    mod.name = "progs/blend.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 2; // equal case: matches the md5anim's own 2 frames
    attachMd5GlReplacementIfAny(mod, hdr, mdl);
    const p = getMd5GlPayload(hdr);
    if (!p) throw new Error("test setup: no MD5 payload attached for progs/blend.mdl");
    blendPayload = p;
  });

  test("a vertex position at blend 0.5 between two frames is the midpoint (hand-computed)", () => {
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    GL_DrawMd5AliasFrame(blendPayload, ent, 0, 1, 0.5, shadevector, shadelightColor, 1);

    const vertexCalls = rec.calls.filter((c) => c.name === "qglVertex3f");
    // vertex 0's weight offset is (0,-30,-30) off a joint that moves from
    // (0,0,0) at frame 0 to (10,0,0) at frame 1 -- blend 0.5 puts the
    // joint (and this vertex, unrotated) at x=5, the hand-computed
    // midpoint of 0 and 10; y/z are the constant offset, unaffected.
    expect(vertexCalls[0].args).toEqual([5, -30, -30]);
  });

  test("blend 0 and blend 1 reproduce each frame's own joint position exactly", () => {
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    GL_DrawMd5AliasFrame(blendPayload, ent, 0, 1, 0, shadevector, shadelightColor, 1);
    let vertexCalls = rec.calls.filter((c) => c.name === "qglVertex3f");
    expect(vertexCalls[0].args).toEqual([0, -30, -30]);

    rec.clear();
    GL_DrawMd5AliasFrame(blendPayload, ent, 0, 1, 1, shadevector, shadelightColor, 1);
    vertexCalls = rec.calls.filter((c) => c.name === "qglVertex3f");
    expect(vertexCalls[0].args).toEqual([10, -30, -30]);
  });

  test("pose1 === pose2 draws the single-frame body (no blend arithmetic)", () => {
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    GL_DrawMd5AliasFrame(blendPayload, ent, 1, 1, 0.5, shadevector, shadelightColor, 1);

    const vertexCalls = rec.calls.filter((c) => c.name === "qglVertex3f");
    expect(vertexCalls[0].args).toEqual([10, -30, -30]); // frame 1's own vertex, untouched
  });
});

//============================================================================
// GL_DrawMd5Shadow -- U35: projects the draw's own skinned/blended
// positions (reusing GL_DrawMd5AliasFrame's scratch, no re-skin) with the
// classic GL_DrawAliasShadow skew.
//============================================================================

describe("GL_DrawMd5Shadow", () => {
  let triPayload: Md5GlAliasT;

  beforeAll(() => {
    const mod = new ModelT();
    mod.name = "progs/tri.mdl";
    const hdr = new AliashdrT();
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;
    attachMd5GlReplacementIfAny(mod, hdr, mdl);
    const p = getMd5GlPayload(hdr);
    if (!p) throw new Error("test setup: no MD5 payload attached for progs/tri.mdl");
    triPayload = p;
  });

  test("emits one GL_TRIANGLES pass, one vertex per mesh index -- equal to the mesh's own numVerts for this one-triangle fixture", () => {
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    ent.origin.set([0, 0, 0]);
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    // populates payload.meshVertScratch -- GL_DrawMd5Shadow must reuse it
    // rather than re-skinning.
    GL_DrawMd5AliasFrame(triPayload, ent, 0, 0, 0, shadevector, shadelightColor, 1);
    rec.clear();
    rec.vertex3fv.length = 0;

    GL_DrawMd5Shadow(triPayload, ent, shadevector);

    const beginCalls = rec.calls.filter((c) => c.name === "qglBegin");
    expect(beginCalls.length).toBe(1);
    expect(beginCalls[0].args).toEqual([GL_TRIANGLES]);
    expect(rec.calls.some((c) => c.name === "qglEnd")).toBe(true);

    expect(rec.vertex3fv.length).toBe(triPayload.model.meshes[0].numIndices);
    expect(rec.vertex3fv.length).toBe(triPayload.model.meshes[0].numVerts);
  });

  test("the classic skew: z = -lheight+1, x/y offset by shadevector*(z+lheight), against the fixture's own known (unrotated, unblended) vertex positions", () => {
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    ent.origin.set([0, 0, 0]);
    const drawShadevector = vec3(0, 0, 1); // this call's own light dir is irrelevant to the shadow -- only its skinning matters here
    const shadelightColor = vec3(1, 1, 1);

    // the "tri" fixture's own joint is at the origin with no rotation and
    // this is a same-frame (unblended) draw, so md5Skin's output for each
    // vertex is exactly its own weight offset -- vertex 0 (0,-30,-30),
    // vertex 1 (0,30,-30), vertex 2 (0,30,30) (see md5MeshText/this file's
    // "blend 0 and blend 1..." test, which confirms the same identity for
    // the sibling "blend" fixture).
    GL_DrawMd5AliasFrame(triPayload, ent, 0, 0, 0, drawShadevector, shadelightColor, 1);
    rec.clear();
    rec.vertex3fv.length = 0;

    lightspot[0] = 0;
    lightspot[1] = 0;
    lightspot[2] = 5; // lheight = origin[2]-lightspot[2] = -5; height = -lheight+1 = 6
    const shadowShadevector = vec3(0.5, 0.25, 1);

    GL_DrawMd5Shadow(triPayload, ent, shadowShadevector);

    // hand-computed: point[c] -= shadevector[c]*(point[2]+lheight); point[2] = height
    expect(rec.vertex3fv).toEqual([
      [17.5, -21.25, 6], // (0,-30,-30): -0.5*(-30-5)=17.5; -30-0.25*(-35)=-21.25
      [17.5, 38.75, 6], // (0,30,-30): 0-0.5*(-35)=17.5; 30-0.25*(-35)=38.75
      [-12.5, 23.75, 6], // (0,30,30): 0-0.5*(25)=-12.5; 30-0.25*(25)=23.75
    ]);
  });
});

//============================================================================
// R_DrawAliasModel -- the r_enhancedmodels draw-time branch
//============================================================================

describe("R_DrawAliasModel branches on r_enhancedmodels for an attached MD5 payload", () => {
  function makeClassicAliashdr(): AliashdrT {
    const hdr = new AliashdrT();
    hdr.numframes = 1;
    hdr.numposes = 1;
    hdr.poseverts = 1;
    hdr.numtris = 1;
    hdr.scale_origin[0] = 1;
    hdr.scale_origin[1] = 2;
    hdr.scale_origin[2] = 3;
    hdr.scale[0] = 1;
    hdr.scale[1] = 1;
    hdr.scale[2] = 1;
    hdr.gl_texturenum[0] = 999; // classic skin texnum -- distinguishable from the MD5 skin's own

    const fr = new MaliasframedescT();
    fr.firstpose = 0;
    fr.numposes = 1;
    fr.interval = 0.1;
    hdr.frames.push(fr);

    const v0 = new TrivertxT();
    v0.v[0] = 0;
    v0.v[1] = 0;
    v0.v[2] = 0;
    v0.lightnormalindex = 0;
    hdr.posedata = [v0];

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

  function makeEntity(name: string, hdr: AliashdrT): EntityT {
    const e = new EntityT();
    const mod = new ModelT();
    mod.name = name;
    mod.type = ModtypeT.mod_alias;
    mod.cache.data = hdr;
    e.model = mod;
    e.origin.set([0, 0, 0]);
    e.angles.set([0, 0, 0]);
    return e;
  }

  let hdr: AliashdrT;

  beforeAll(() => {
    hdr = makeClassicAliashdr();
    const mod = new ModelT();
    mod.name = "progs/mixed.mdl";
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.numframes = 1;
    attachMd5GlReplacementIfAny(mod, hdr, mdl);
    expect(getMd5GlPayload(hdr)).not.toBeNull();
  });

  test("r_enhancedmodels 1 draws the MD5 mesh: GL_TRIANGLES, no scale_origin decompression translate", () => {
    r_enhancedmodels.value = 1;
    const e = makeEntity("progs/mixed.mdl", hdr);
    glState.currententity = e;

    R_DrawAliasModel(e);

    expect(rec.calls.some((c) => c.name === "qglBegin" && c.args[0] === GL_TRIANGLES)).toBe(true);
    const translates = rec.calls.filter((c) => c.name === "qglTranslatef");
    expect(translates.some((c) => c.args[0] === 1 && c.args[1] === 2 && c.args[2] === 3)).toBe(false);
    const bindCalls = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(bindCalls.some((c) => c.args[1] === 999)).toBe(false);
  });

  test("r_enhancedmodels 0 draws the classic strip instead", () => {
    r_enhancedmodels.value = 0;
    const e = makeEntity("progs/mixed.mdl", hdr);
    glState.currententity = e;

    R_DrawAliasModel(e);

    expect(rec.calls.some((c) => c.name === "qglBegin" && c.args[0] === GL_TRIANGLE_FAN)).toBe(true);
    expect(rec.calls.some((c) => c.name === "qglBegin" && c.args[0] === GL_TRIANGLES)).toBe(false);
    const translates = rec.calls.filter((c) => c.name === "qglTranslatef");
    expect(translates.some((c) => c.args[0] === 1 && c.args[1] === 2 && c.args[2] === 3)).toBe(true);
    const bindCalls = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(bindCalls.some((c) => c.args[1] === 999)).toBe(true);
  });

  test("U35: r_shadows 1 draws the MD5 shadow after the model, at the projected z", () => {
    r_enhancedmodels.value = 1;
    r_shadows.value = 1;
    const e = makeEntity("progs/mixed.mdl", hdr);
    glState.currententity = e; // origin (0,0,0); lightspot reset to (0,0,0) by beforeEach

    R_DrawAliasModel(e);

    const modelVertexIdx = rec.calls.findIndex((c) => c.name === "qglVertex3f");
    const shadowBeginIdx = rec.calls.findIndex((c, idx) => c.name === "qglBegin" && c.args[0] === GL_TRIANGLES && idx > modelVertexIdx);
    expect(modelVertexIdx).toBeGreaterThanOrEqual(0);
    expect(shadowBeginIdx).toBeGreaterThan(modelVertexIdx);

    // one shadow vertex per mesh index -- same count as the model's own
    // draw (the "mixed" fixture is the same one-triangle shape as "tri").
    expect(rec.vertex3fv.length).toBe(3);
    // origin (0,0,0), lightspot (0,0,0) -> lheight = 0, height = -0+1 = 1
    for (const v of rec.vertex3fv) expect(v[2]).toBe(1);
  });

  test("U50: the MD5 model matrix translates to the move-lerped origin, exactly as the classic path's does", () => {
    r_enhancedmodels.value = 1;
    r_lerpmove.value = 1;
    const e = makeEntity("progs/mixed.mdl", hdr);
    e.lerpflags = LERP_MOVESTEP;
    e.origin.set([100, 0, 0]);
    glState.currententity = e;

    // first draw at cl.time 0 starts the lerp (previousorigin (0,0,0) ->
    // currentorigin (100,0,0)); the second, half the 0.1s step later, is the
    // midpoint the mesh must be drawn at.
    cl.time = 0;
    R_DrawAliasModel(e);
    rec.clear();

    cl.time = 0.05;
    R_DrawAliasModel(e);

    const translates = rec.calls.filter((c) => c.name === "qglTranslatef");
    expect(translates.length).toBeGreaterThan(0);
    expect(translates[0].args[0]).toBeCloseTo(50, 5);
    expect(translates[0].args[1]).toBeCloseTo(0, 5);
    expect(translates[0].args[2]).toBeCloseTo(0, 5);
    // R_RotateForEntity is the ONLY translate on the MD5 path -- no
    // scale_origin decompression pair follows it.
    expect(translates.length).toBe(1);
  });

  test("U50: r_lerpmove 0 puts the MD5 mesh at the entity's raw origin", () => {
    r_enhancedmodels.value = 1;
    r_lerpmove.value = 0;
    const e = makeEntity("progs/mixed.mdl", hdr);
    e.lerpflags = LERP_MOVESTEP;
    e.origin.set([100, 0, 0]);
    glState.currententity = e;

    cl.time = 0;
    R_DrawAliasModel(e);
    rec.clear();
    cl.time = 0.05;
    R_DrawAliasModel(e);

    const translates = rec.calls.filter((c) => c.name === "qglTranslatef");
    expect(translates[0].args[0]).toBeCloseTo(100, 5);
  });

  test("U35: r_shadows 0 draws no MD5 shadow", () => {
    r_enhancedmodels.value = 1;
    r_shadows.value = 0;
    const e = makeEntity("progs/mixed.mdl", hdr);
    glState.currententity = e;

    R_DrawAliasModel(e);

    expect(rec.vertex3fv.length).toBe(0);
  });
});

//============================================================================
// Guarded: real retail data (rerelease/id1's dog.mdl + dog.md5mesh/anim +
// dog_00_00.lmp). Skips itself when the retail install isn't present,
// mirroring test/ref_soft_md5.test.ts's own existsSync-guard idiom.

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const ID1_PAK0 = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const HAVE_ID1 = existsSync(ID1_PAK0);

(HAVE_ID1 ? describe : describe.skip)("U29: real dog.mdl + dog.md5mesh/anim (guarded)", () => {
  let dogSavedSearchpaths: typeof com_searchpaths;
  let dogSavedGamedir = "";
  let dogSavedModified = false;
  let dogSavedStatic = 0;

  let dogPayload: Md5GlAliasT | null = null;
  let dogNumTris = 0;

  beforeAll(() => {
    dogSavedSearchpaths = com_searchpaths;
    dogSavedGamedir = com_gamedir;
    dogSavedModified = com_modified;
    dogSavedStatic = static_registered;

    // this describe's own beforeAll runs before any beforeEach (this file's
    // own included), so a prior describe block's last test may have left
    // r_enhancedmodels at 0 -- set it explicitly rather than rely on
    // cross-describe beforeEach ordering.
    r_enhancedmodels.value = 1;

    COM_InitArgv(["quake", "-basedir", RERELEASE_DATA_DIR]);
    COM_InitFilesystem();
    COM_CheckRegistered();

    const meshBytes = COM_LoadTempFile("progs/dog.md5mesh");
    expect(meshBytes).not.toBeNull();
    if (meshBytes) {
      const text = new TextDecoder().decode(meshBytes);
      const m = /numtris\s+(\d+)/.exec(text);
      expect(m).not.toBeNull();
      if (m) dogNumTris = Number(m[1]);
    }

    const mdlBytes = COM_LoadTempFile("progs/dog.mdl");
    expect(mdlBytes).not.toBeNull();
    if (!mdlBytes) return;
    const view = new DataView(mdlBytes.buffer, mdlBytes.byteOffset, mdlBytes.byteLength);
    const mdl = readMdl(view, 0);

    const mod = new ModelT();
    mod.name = "progs/dog.mdl";
    const hdr = new AliashdrT();

    attachMd5GlReplacementIfAny(mod, hdr, mdl);
    dogPayload = getMd5GlPayload(hdr);
  });

  afterAll(() => {
    setComSearchpaths(dogSavedSearchpaths);
    setComGamedir(dogSavedGamedir);
    setComModified(dogSavedModified);
    setStaticRegistered(dogSavedStatic);
  });

  test("attaches a payload whose triangle count matches dog.md5mesh's own numtris", () => {
    expect(dogPayload).not.toBeNull();
    if (!dogPayload) return;
    expect(dogPayload.model.meshes.length).toBeGreaterThan(0);
    expect(dogNumTris).toBeGreaterThan(0);
    const totalTris = dogPayload.model.meshes.reduce((sum, m) => sum + m.numIndices / 3, 0);
    expect(totalTris).toBe(dogNumTris);
  });

  test("draws one frame through the recording fake with finite vertex positions", () => {
    expect(dogPayload).not.toBeNull();
    if (!dogPayload) return;

    rec.clear();
    glState.currenttexture = -1;
    const ent = new EntityT();
    ent.skinnum = 0;
    ent.syncbase = 0;
    const shadevector = vec3(0, 0, 1);
    const shadelightColor = vec3(1, 1, 1);

    GL_DrawMd5AliasFrame(dogPayload, ent, 0, 0, 0, shadevector, shadelightColor, 1);

    const vertexCalls = rec.calls.filter((c) => c.name === "qglVertex3f");
    expect(vertexCalls.length).toBe(dogNumTris * 3);
    for (const c of vertexCalls) {
      for (const n of c.args) {
        expect(typeof n).toBe("number");
        if (typeof n === "number") expect(Number.isFinite(n)).toBe(true);
      }
    }

    const bindCalls = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(bindCalls.length).toBeGreaterThan(0);
  });
});

//=============================================================================
// P9 (2026-09-07, Mike's play session): re-release models rendered near-black
// because the MD5 draw handed the raw cosine (-1..1) of an UNNORMALISED
// blended normal to glColor. The classic path reads anorm_dots.h, whose
// entries are 1 + cos (back faces flattened to 1 + cos/8); md5ShadeDot is
// QuakeSpasm's analytic form of that table.

describe("md5ShadeDot -- MD5 vertices are lit like .mdl vertices", () => {
  const up = vec3(0, 0, 1);

  test("a face toward the light shades 1 + cos, a face away 1 + cos/8, never negative", () => {
    expect(md5ShadeDot(0, 0, 1, up)).toBeCloseTo(2, 6);
    expect(md5ShadeDot(1, 0, 0, up)).toBeCloseTo(1, 6);
    expect(md5ShadeDot(0, 0, -1, up)).toBeCloseTo(1 - 1 / 8, 6);
    for (const [x, y, z] of [[0.3, -0.7, -0.6], [-1, -1, -1], [0.1, 0.1, -0.99]]) expect(md5ShadeDot(x, y, z, up)).toBeGreaterThan(0.8);
  });

  test("the blended normal's length does not change the shade (it is normalised first)", () => {
    expect(md5ShadeDot(0, 0, 4, up)).toBeCloseTo(md5ShadeDot(0, 0, 1, up), 6);
    expect(md5ShadeDot(0.2, 0, 0.2, up)).toBeCloseTo(md5ShadeDot(1, 0, 1, up), 6);
    expect(md5ShadeDot(0, 0, 0, up)).toBe(1); // a degenerate normal is unlit-but-visible, not NaN
  });

  test("stays inside anorm_dots.h's own range so the k_gl_alias_light ceiling holds", () => {
    const sv = vec3(0.6, 0.8, 0);
    let min = 9;
    let max = -9;
    for (let i = 0; i < 500; i++) {
      const a = (i / 500) * Math.PI * 2;
      const b = ((i * 7) % 500) / 500 * Math.PI - Math.PI / 2;
      const d = md5ShadeDot(Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b), sv);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    expect(min).toBeGreaterThanOrEqual(1 - 1 / 8 - 1e-6);
    expect(max).toBeLessThanOrEqual(2 + 1e-6);
  });
});

//=============================================================================
// P14 (2026-09-07): under GL the MD5 path bound the untranslated skin for
// every player, so bots wore no team colours in CTF. md5TranslateSkin is
// gl_rmisc.c's R_TranslatePlayerSkin table applied to the 8-bit MD5 skin.

describe("md5TranslateSkin -- the player colour table on an MD5 skin", () => {
  const TOP_RANGE = 16;
  const BOTTOM_RANGE = 96;

  test("shirt and trouser texels move to the player's colour rows, everything else is untouched", () => {
    const texels = new Uint8Array(256);
    for (let i = 0; i < 256; i++) texels[i] = i;
    const colors = (4 << 4) | 13; // shirt 4 (blue), trousers 13
    const out = md5TranslateSkin(texels, colors);
    for (let i = 0; i < 16; i++) {
      expect(out[TOP_RANGE + i]).toBe(4 * 16 + i); // top < 128: forwards
      expect(out[BOTTOM_RANGE + i]).toBe(13 * 16 + 15 - i); // bottom >= 128: backwards, as the C does
    }
    for (let i = 0; i < 256; i++) {
      if ((i >= TOP_RANGE && i < TOP_RANGE + 16) || (i >= BOTTOM_RANGE && i < BOTTOM_RANGE + 16)) continue;
      expect(out[i]).toBe(i);
    }
    expect(out).not.toBe(texels); // the model's own skin texels are never rewritten
  });

  test("colours 0/0 is the identity for a skin that uses the default rows", () => {
    const texels = new Uint8Array([TOP_RANGE, TOP_RANGE + 5, BOTTOM_RANGE, BOTTOM_RANGE + 15, 200, 3]);
    expect(Array.from(md5TranslateSkin(texels, 0))).toEqual([0, 5, 0, 15, 200, 3]);
  });
});
