// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U073's src/ref_gl/gl_mesh.ts: BuildTris' fan/strip search and the
sign it encodes into the command list, the raw-float-bits texture coordinates
that follow each count, the reorder of every pose's vertices into
aliashdr_t.posedata, and the glquake/NAME.ms2 cache GL_MakeAliasModelDisplayLists
writes and reads back.

The suite drives the real loader (Mod_ForName + gl_model.ts's glModelHooks)
so gl_model.c's pheader/stverts/triangles/poseverts are populated exactly as
they are in the engine; gl_mesh.ts reads them and has no setters of its own.
A QGLRecording stands in for libGL, and every shared singleton the suite
writes (qglHolder, the model loader hooks, the model table) is restored in
afterAll, per standing orders 13 and 15.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { Mod_ClearAll, Mod_Extradata, Mod_ForName, Mod_Init, ModtypeT, setModelLoaderHooks } from "../src/common/model";
import { AliashdrT } from "../src/ref_gl/gl_model_types";
import { QGLRecording, qglHolder } from "../src/ref_gl/qgl";
import { glModelHooks, poseverts } from "../src/ref_gl/gl_model";
import { GL_MakeAliasModelDisplayLists, glMeshState } from "../src/ref_gl/gl_mesh";
import { cnttextures, glState } from "../src/ref_gl/glquake";
import { ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "mesh-test-"));
const baseDir = join(scratchDir, "quake");
const gameDir = join(baseDir, "id1");

const SKINWIDTH = 4;
const SKINHEIGHT = 4;

// A minimal mdl_t (modelgen.h) with `numtris` triangles fanning around
// vertex 0: (0,1,2), (0,2,3), (0,3,4) ... which is the shape FanLength walks.
function buildFanMdl(numtris: number): Uint8Array {
  const numverts = numtris + 2;
  const numframes = 1;
  const headerSize = 84;
  const skinSize = 4 + SKINWIDTH * SKINHEIGHT;
  const frameSize = 4 + 24 + numverts * 4;
  const bytes = new Uint8Array(headerSize + skinSize + numverts * 12 + numtris * 16 + numframes * frameSize);
  const view = new DataView(bytes.buffer);
  let o = 0;
  const i32 = (v: number): void => {
    view.setInt32(o, v, true);
    o += 4;
  };
  const f32 = (v: number): void => {
    view.setFloat32(o, v, true);
    o += 4;
  };
  const u8 = (v: number): void => {
    bytes[o++] = v & 0xff;
  };

  i32(0x4f504449); // "IDPO"
  i32(6); // ALIAS_VERSION
  f32(1);
  f32(1);
  f32(1); // scale
  f32(0);
  f32(0);
  f32(0); // scale_origin
  f32(10); // boundingradius
  f32(0);
  f32(0);
  f32(0); // eyeposition
  i32(1); // numskins
  i32(SKINWIDTH);
  i32(SKINHEIGHT);
  i32(numverts);
  i32(numtris);
  i32(numframes);
  i32(0); // ST_SYNC
  i32(0); // flags
  f32(1); // size

  // one ALIAS_SKIN_SINGLE skin
  i32(0);
  for (let i = 0; i < SKINWIDTH * SKINHEIGHT; i++) u8(i & 0xff);

  // stvert_t onseam, s, t -- s = t = vertex index
  for (let i = 0; i < numverts; i++) {
    i32(0);
    i32(i);
    i32(i);
  }

  // dtriangle_t facesfront, vertindex[3]
  for (let i = 0; i < numtris; i++) {
    i32(1);
    i32(0);
    i32(i + 1);
    i32(i + 2);
  }

  // one ALIAS_SINGLE frame; trivertx_t v[] = (i, i, i), lightnormalindex 0
  i32(0);
  u8(0);
  u8(0);
  u8(0);
  u8(0); // bboxmin
  u8(255);
  u8(255);
  u8(255);
  u8(0); // bboxmax
  for (let i = 0; i < 16; i++) u8("frame0".charCodeAt(i) || 0);
  for (let v = 0; v < numverts; v++) {
    u8(v);
    u8(v);
    u8(v);
    u8(0);
  }

  return bytes;
}

const rec = new QGLRecording();

const saved = {
  qgl: qglHolder.current,
  // Mod_ForName below drives the real loader (glModelHooks), which loads a
  // real skin through gl_draw.ts's real (unmocked, unlike
  // test/ref_gl_model.test.ts's spy) GL_LoadTexture/GL_Bind -- that mutates
  // src/ref_gl/glquake.ts's process-wide glState (currenttexture,
  // texture_extension_number, ...) and cnttextures in place (rule 15).
  glState: { ...glState },
  cnttextures: Array.from(cnttextures),
};

beforeAll(() => {
  qglHolder.current = rec;

  ensureDir(gameDir);
  ensureDir(join(gameDir, "glquake"));
  writeGameFile(baseDir, "id1/progs/mesh4.mdl", buildFanMdl(4));

  // gfx/pop.lmp inside id1/pak0.pak: without the registered-version check
  // COM_FindFile never searches loose directories for a path containing a
  // slash, and "glquake/mesh4.ms2" would never be found.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(gameDir, "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();
  setModelLoaderHooks(glModelHooks);
});

afterAll(() => {
  qglHolder.current = saved.qgl;
  Object.assign(glState, saved.glState);
  cnttextures.set(saved.cnttextures);
  setModelLoaderHooks(null);
  Mod_ClearAll();
  rmSync(scratchDir, { recursive: true, force: true });
});

function loadMesh(name: string): AliashdrT {
  const mod = Mod_ForName(name, true);
  if (mod === null) throw new Error(`expected ${name} to load`);
  expect(mod.type).toBe(ModtypeT.mod_alias);
  const data = Mod_Extradata(mod);
  if (!(data instanceof AliashdrT)) throw new Error("expected an AliashdrT in the model cache");
  return data;
}

//============================================================================

describe("GL_MakeAliasModelDisplayLists", () => {
  test("emits one negative (fan) count, float texcoords and the reordered pose data", () => {
    const hdr = loadMesh("progs/mesh4.mdl");

    // four triangles fanning around vertex 0 make one 6-vertex fan; the C
    // writes -(bestlen+2) for a fan and +(bestlen+2) for a strip
    expect(glMeshState.numorder).toBe(6);
    expect(hdr.commands[0]).toBe(-6);

    // 1 count + 6 * (s, t) + the terminating 0
    expect(glMeshState.numcommands).toBe(14);
    expect(hdr.commands.length).toBe(14);
    expect(hdr.commands[13]).toBe(0);

    // the s/t pairs are raw float bits inside the int command list
    const cmdF = new Float32Array(hdr.commands.buffer, hdr.commands.byteOffset, hdr.commands.length);
    for (let j = 0; j < 6; j++) {
      // stverts[k].s = stverts[k].t = k, and the fan visits 0,1,2,3,4,5
      expect(cmdF[1 + j * 2]).toBeCloseTo((j + 0.5) / SKINWIDTH, 6);
      expect(cmdF[2 + j * 2]).toBeCloseTo((j + 0.5) / SKINHEIGHT, 6);
    }

    // poseverts is the per-pose vertex COUNT, and posedata is every pose's
    // vertices rewritten in vertexorder
    expect(hdr.numposes).toBe(1);
    expect(hdr.poseverts).toBe(6);
    expect(hdr.posedata.length).toBe(6);
    for (let j = 0; j < 6; j++) {
      expect(hdr.posedata[j].v[0]).toBe(poseverts[0][j].v[0]);
      expect(hdr.posedata[j].v[0]).toBe(j);
    }
    // the copy is by value, not by reference (the C's `*verts++ = ...`)
    expect(hdr.posedata[0]).not.toBe(poseverts[0][0]);
  });

  test("writes glquake/NAME.ms2 with the numcommands/numorder header", () => {
    const cachePath = join(gameDir, "glquake", "mesh4.ms2");
    const raw = readFileSync(cachePath);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const numcommands = view.getInt32(0, true);
    const numorder = view.getInt32(4, true);
    expect(numcommands).toBe(14);
    expect(numorder).toBe(6);
    expect(raw.byteLength).toBe(8 + (numcommands + numorder) * 4);

    expect(view.getInt32(8, true)).toBe(-6); // commands[0]
    for (let i = 0; i < numorder; i++) expect(view.getInt32(8 + (numcommands + i) * 4, true)).toBe(i);
  });

  test("reads the cached version back instead of rebuilding it", () => {
    // Rewrite the cache with a command list BuildTris could never produce,
    // so a pass that matches it proves the read path ran.
    const numcommands = 3;
    const numorder = 2;
    const out = new Uint8Array(8 + (numcommands + numorder) * 4);
    const outView = new DataView(out.buffer);
    outView.setInt32(0, numcommands, true);
    outView.setInt32(4, numorder, true);
    outView.setInt32(8, 7, true);
    outView.setInt32(12, 8, true);
    outView.setInt32(16, 9, true);
    outView.setInt32(20, 1, true); // vertexorder[0]
    outView.setInt32(24, 0, true); // vertexorder[1]
    writeFileSync(join(gameDir, "glquake", "mesh4.ms2"), out);

    const mod = Mod_ForName("progs/mesh4.mdl", true);
    if (mod === null) throw new Error("expected progs/mesh4.mdl to load");
    const hdr = new AliashdrT();
    hdr.numposes = 1;

    GL_MakeAliasModelDisplayLists(mod, hdr);

    expect(glMeshState.numcommands).toBe(3);
    expect(glMeshState.numorder).toBe(2);
    expect(Array.from(hdr.commands)).toEqual([7, 8, 9]);
    expect(hdr.poseverts).toBe(2);
    expect(hdr.posedata.length).toBe(2);
    // reordered by the cached vertexorder [1, 0]
    expect(hdr.posedata[0].v[0]).toBe(1);
    expect(hdr.posedata[1].v[0]).toBe(0);

    expect(glMeshState.aliasmodel).toBe(mod);
    expect(glMeshState.paliashdr).toBe(hdr);
  });
});
