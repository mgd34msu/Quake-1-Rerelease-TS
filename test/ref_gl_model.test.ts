// Self-sufficient tests for src/ref_gl/gl_model.ts (the GL renderer's half of
// model.c/gl_model.c's model loading plus gl_rmisc.c's R_InitTextures, unit
// U071).
//
// src/ref_gl/gl_model.ts statically imports GL_LoadTexture from "./gl_draw"
// (gl_draw.c, U074), and GL_SubdivideSurface/R_InitSky from "./gl_warp"
// (gl_warp.c, U073), and GL_MakeAliasModelDisplayLists from "./gl_mesh"
// (gl_mesh.c, U073). ES module imports resolve eagerly, so importing
// anything from src/ref_gl/gl_model.ts -- including this test file -- fails
// the module graph before a single test below can run, until all three
// siblings are present AND well-formed. At this unit's gate time:
//   - src/ref_gl/gl_draw.ts does not exist on disk at all: "Cannot find
//     module './gl_draw'".
//   - src/ref_gl/gl_warp.ts DOES exist (landed concurrently, U073) but has
//     its own pre-existing defect unrelated to this unit: line 47 of its
//     header comment reads "the Emit*/R_DrawSkyChain" -- the literal
//     characters `*/` inside that prose close the block comment early, so
//     every line after it (including its own `import` statements) is parsed
//     as executable code and fails with a cascade of syntax errors
//     (TS1434/TS1005/TS1003/TS1161 etc.) starting at gl_warp.ts:48. Confirmed
//     with `git status --porcelain -- src/ref_gl/gl_warp.ts` showing it as an
//     untracked file (`?? src/ref_gl/gl_warp.ts`) landed by a concurrent
//     worker; this unit's own files never touch it. Not this unit's to fix
//     (out of SCOPE) -- reported to the coordinator.
//   - src/ref_gl/gl_mesh.ts exists and is well-formed (imports
//     `pheader`/`poseverts`/`stverts`/`triangles` from "./gl_model" by name,
//     confirming this unit's module-state naming matches what it expects).
// Logic was verified in the interim by temporarily replacing all three
// imports in src/ref_gl/gl_model.ts with local no-op stand-in functions
// (never a file at any of the three paths, per standing order 12), then
// running a throwaway scratch test against that state, then restoring the
// real imports before finishing -- see this unit's report for the tsc/bun
// test tails from both states. The spy-based tests below are written against
// the REAL sibling imports, per this unit's brief, and will start running
// once gl_draw.ts lands and gl_warp.ts's comment is fixed.
//
// Most tests below call the exported hook functions directly (Mod_LoadTextures,
// Mod_LoadFaces, Mod_LoadAliasModel, Mod_LoadSpriteModel, afterBrushLoad, and
// the Mod_LoadAlias*/Mod_LoadSprite* helpers) against hand-built buffers,
// bypassing Mod_ForName/COM_LoadStackFile entirely -- self-sufficient and
// independent of any filesystem/pak fixture. Two "Mod_ForName integration"
// tests additionally drive glModelHooks through the real Mod_ForName path
// with a synthetic BSP and the pak/pop.lmp fixture, following
// test/ref_soft_model.test.ts's own convention.
//
// Test-only Cmd_AddCommand names are not used by this file (no commands are
// registered here).

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SysError } from "../src/platform/sys";
import { AliasskintypeT, TrivertxT } from "../src/common/modelgen";
import { LumpT } from "../src/common/bspfile";
import {
  MedgeT,
  MleafT,
  ModelT,
  ModtypeT,
  MsurfaceT,
  MtexinfoT,
  MvertexT,
  TextureT,
  loadState,
  Mod_ClearAll,
  Mod_ForName,
  Mod_Init,
  Mod_LoadTextures,
  setModelLoaderHooks,
} from "../src/common/model";
import { MplaneT } from "../src/common/mathlib";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { d_8to24table } from "../src/client/vid";
import { AliashdrT, MaliasframedescT, MspriteT, MspriteframeT, MspritegroupT } from "../src/ref_gl/gl_model_types";
import {
  Mod_FloodFillSkin,
  Mod_LoadAliasFrame,
  Mod_LoadAliasGroup,
  Mod_LoadAliasModel,
  Mod_LoadAllSkins,
  Mod_LoadFaces,
  Mod_LoadSpriteFrame,
  Mod_LoadSpriteGroup,
  Mod_LoadSpriteModel,
  R_InitTextures,
  afterBrushLoad,
  glModelHooks,
  notexture,
  pheader,
  poseverts,
  textureLoaded,
} from "../src/ref_gl/gl_model";
import * as glDraw from "../src/ref_gl/gl_draw";
import * as glWarp from "../src/ref_gl/gl_warp";
import * as glMesh from "../src/ref_gl/gl_mesh";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

// --- local byte-buffer builders (test infrastructure only) ----------------

class Writer {
  bytes: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  i32(v: number): void {
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  i16(v: number): void {
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  f32(v: number): void {
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  u8(v: number): void {
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  chars(s: string, width: number): void {
    for (let i = 0; i < width; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0xff : 0);
  }
  raw(b: Uint8Array): void {
    this.bytes.set(b, this.pos);
    this.pos += b.length;
  }
}

// dmiptexlump_t + miptex_t entries, mirroring bsp_builder.ts's texturesLump
// but supporting several miptexs (needed for the animation tests).
function buildTexturesLump(entries: Array<{ name: string; width: number; height: number; missing?: boolean }>): Uint8Array {
  const n = entries.length;
  const headerSize = 4 + n * 4;

  const bodies: Uint8Array[] = [];
  const dataofs: number[] = [];
  let cursor = headerSize;
  for (const e of entries) {
    if (e.missing) {
      dataofs.push(-1);
      continue;
    }
    const pixels = Math.floor((e.width * e.height) / 64) * 85;
    const w = new Writer(40 + pixels);
    w.chars(e.name, 16);
    w.u32(e.width);
    w.u32(e.height);
    let ofs = 40;
    for (let m = 0; m < 4; m++) {
      w.u32(ofs);
      ofs += (e.width >> m) * (e.height >> m);
    }
    for (let i = 0; i < pixels; i++) w.u8(i & 0xff);
    dataofs.push(cursor);
    bodies.push(w.bytes);
    cursor += w.bytes.length;
  }

  const out = new Writer(cursor);
  out.i32(n);
  for (const d of dataofs) out.i32(d);
  let pos = headerSize;
  for (const b of bodies) {
    out.pos = pos;
    out.raw(b);
    pos += b.length;
  }
  return out.bytes;
}

function lumpOf(bytes: Uint8Array): LumpT {
  const l = new LumpT();
  l.fileofs = 0;
  l.filelen = bytes.length;
  return l;
}

// one dface_t (20 bytes): planenum/side (short), firstedge (int),
// numedges/texinfo (short), styles[4] (byte), lightofs (int)
function buildFaceLump(planenum: number, side: number, firstedge: number, numedges: number, texinfo: number): Uint8Array {
  const w = new Writer(20);
  w.i16(planenum);
  w.i16(side);
  w.i32(firstedge);
  w.i16(numedges);
  w.i16(texinfo);
  w.u8(0);
  w.u8(255);
  w.u8(255);
  w.u8(255);
  w.i32(-1);
  return w.bytes;
}

// --- fixture (Mod_ForName integration only) --------------------------------

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-gl-model-test-"));
const baseDir = join(scratchDir, "quake");

let nextTexnum = 1;
let originalD8to24: Uint32Array;
let loadTextureSpy: ReturnType<typeof spyOn>;
let subdivideSurfaceSpy: ReturnType<typeof spyOn>;
let initSkySpy: ReturnType<typeof spyOn>;
let makeDisplayListsSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/test.bsp", buildBsp());
  writeGameFile(baseDir, "id1/maps/skytest.bsp", buildBsp({ miptexName: "sky" }));

  // see test/model.test.ts's header for why this must sit in a pak
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

  originalD8to24 = d_8to24table.slice();

  loadTextureSpy = spyOn(glDraw, "GL_LoadTexture").mockImplementation(() => nextTexnum++);
  subdivideSurfaceSpy = spyOn(glWarp, "GL_SubdivideSurface").mockImplementation(() => {});
  initSkySpy = spyOn(glWarp, "R_InitSky").mockImplementation(() => {});
  makeDisplayListsSpy = spyOn(glMesh, "GL_MakeAliasModelDisplayLists").mockImplementation((_m, hdr) => {
    // minimal stand-in mirroring gl_mesh.c's real posedata build, proving
    // this unit's pheader/poseverts module state is visible and correctly
    // populated for a sibling to consume (per glquake.ts's OWNERSHIP block):
    // flatten poseverts[0..numposes) with an identity vertex order.
    const numverts = hdr.numverts;
    hdr.poseverts = numverts;
    const flat: TrivertxT[] = [];
    for (let i = 0; i < hdr.numposes; i++) {
      for (let j = 0; j < numverts; j++) flat.push(poseverts[i][j]);
    }
    hdr.posedata = flat;
  });
});

afterEach(() => {
  nextTexnum = 1;
  loadTextureSpy.mockClear();
  subdivideSurfaceSpy.mockClear();
  initSkySpy.mockClear();
  makeDisplayListsSpy.mockClear();
});

afterAll(() => {
  loadTextureSpy.mockRestore();
  subdivideSurfaceSpy.mockRestore();
  initSkySpy.mockRestore();
  makeDisplayListsSpy.mockRestore();

  d_8to24table.set(originalD8to24);

  setModelLoaderHooks(null);
  loadState.loadmodel = null;
  loadState.mod_base = null;
  loadState.loadname = "";
  Mod_ClearAll();
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================

// Mod_LoadTextures itself is src/common/model.ts's now (shared with the
// software renderer and the dedicated server, see that file's header); only
// the per-texture step below (`textureLoaded`) is this renderer's own code,
// so these tests drive the shared function with `glModelHooks.textureLoaded`
// to keep exercising it exactly as Mod_LoadBrushModel would with GL installed.
describe("Mod_LoadTextures (direct)", () => {
  test("a non-sky texture gets a gl_texturenum from the GL_LoadTexture spy", () => {
    const bytes = buildTexturesLump([{ name: "bsptest", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";

    Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded);

    expect(mod.numtextures).toBe(1);
    const tx = mod.textures?.[0];
    if (!tx) throw new Error("expected a loaded texture");

    expect(tx.name).toBe("bsptest");
    expect(tx.gl_texturenum).toBeGreaterThan(0);
    expect(glDraw.GL_LoadTexture).toHaveBeenCalledTimes(1);
  });

  test("a sky texture calls R_InitSky instead of GL_LoadTexture", () => {
    const bytes = buildTexturesLump([{ name: "sky1", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";

    Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded);

    const tx = mod.textures?.[0];
    if (!tx) throw new Error("expected a loaded texture");
    expect(tx.gl_texturenum).toBe(0); // never touched by the sky branch
    expect(glWarp.R_InitSky).toHaveBeenCalledTimes(1);
    expect(glWarp.R_InitSky).toHaveBeenCalledWith(tx);
    expect(glDraw.GL_LoadTexture).not.toHaveBeenCalled();
  });

  test("with no callback installed (dedicated server), textures still load with no renderer side effects", () => {
    const bytes = buildTexturesLump([{ name: "sky1", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";

    Mod_LoadTextures(mod, bytes, lumpOf(bytes), null);

    const tx = mod.textures?.[0];
    if (!tx) throw new Error("expected a loaded texture");
    expect(tx.name).toBe("sky1");
    expect(glWarp.R_InitSky).not.toHaveBeenCalled();
    expect(glDraw.GL_LoadTexture).not.toHaveBeenCalled();
  });

  test("a non-16-aligned texture is a Sys_Error", () => {
    const bytes = buildTexturesLump([{ name: "odd", width: 15, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded)).toThrow(SysError);
  });

  test("an empty lump leaves mod.textures null", () => {
    const mod = new ModelT();
    const l = new LumpT();
    l.fileofs = 0;
    l.filelen = 0;
    Mod_LoadTextures(mod, new Uint8Array(0), l, textureLoaded);
    expect(mod.textures).toBeNull();
    expect(mod.numtextures).toBe(0);
  });
});

describe("Mod_LoadTextures: animation sequencing", () => {
  test("+0wall/+1wall link anim_next cyclically", () => {
    const bytes = buildTexturesLump([
      { name: "+0wall", width: 16, height: 16 },
      { name: "+1wall", width: 16, height: 16 },
    ]);
    const mod = new ModelT();
    loadState.loadname = "test";
    Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded);

    const tx0 = mod.textures?.[0];
    const tx1 = mod.textures?.[1];
    if (!tx0 || !tx1) throw new Error("expected both animation frames");

    expect(tx0.anim_total).toBe(4); // max(2) * ANIM_CYCLE(2)
    expect(tx0.anim_next).toBe(tx1);
    expect(tx1.anim_next).toBe(tx0); // cyclic: (j+1) % max wraps to frame 0
  });

  test("a missing animation frame is a Sys_Error naming it", () => {
    const bytes = buildTexturesLump([{ name: "+2wall", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";

    let caught: unknown = null;
    try {
      Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SysError);
    expect(caught instanceof Error ? caught.message : "").toBe("Missing frame 0 of +2wall");
  });
});

describe("R_InitTextures / notexture checkerboard", () => {
  test("R_InitTextures builds a fresh 16x16 checkerboard with the expected mip-0 pattern", () => {
    const tx = R_InitTextures();

    expect(tx.width).toBe(16);
    expect(tx.height).toBe(16);
    expect(tx.offsets[0]).toBe(0);
    expect(tx.offsets[1]).toBe(16 * 16);
    expect(tx.offsets[2]).toBe(16 * 16 + 8 * 8);
    expect(tx.offsets[3]).toBe(16 * 16 + 8 * 8 + 4 * 4);
    expect(tx.data.length).toBe(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2);

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const expected = (y < 8) !== (x < 8) ? 0 : 0xff;
        expect(tx.data[y * 16 + x]).toBe(expected);
      }
    }
  });

  test("glModelHooks.notexture is the module-load-time checkerboard singleton", () => {
    expect(glModelHooks.notexture).toBe(notexture);
    expect(notexture.width).toBe(16);
    expect(notexture.data[0]).toBe(0xff); // (0<8) === (0<8)
    expect(notexture.data[8]).toBe(0); // x=8: (0<8) !== (8<8)
  });
});

describe("Mod_LoadFaces (direct): extents capped at 512, GL_SubdivideSurface only when flagged", () => {
  // a 400x400-unit square face (extents = 400): exceeds model.c's 256 cap
  // but is within gl_model.c's 512 cap.
  function buildSquareModel(texname: string): ModelT {
    const mod = new ModelT();
    mod.vertexes = [
      Object.assign(new MvertexT(), { position: new Float32Array([0, 0, 0]) }),
      Object.assign(new MvertexT(), { position: new Float32Array([400, 0, 0]) }),
      Object.assign(new MvertexT(), { position: new Float32Array([400, 400, 0]) }),
      Object.assign(new MvertexT(), { position: new Float32Array([0, 400, 0]) }),
    ];
    const edges = [new MedgeT()]; // edge 0 reserved, unused (bsp_builder's convention)
    const pairs: Array<[number, number]> = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ];
    for (const [a, b] of pairs) {
      const e = new MedgeT();
      e.v[0] = a;
      e.v[1] = b;
      edges.push(e);
    }
    mod.edges = edges;
    mod.surfedges = new Int32Array([1, 2, 3, 4]);
    mod.planes = [new MplaneT()];

    const ti = new MtexinfoT();
    ti.vecs[0][0] = 1; // s axis: +x
    ti.vecs[1][1] = 1; // t axis: +y
    ti.flags = 0;
    const tex = new TextureT();
    tex.name = texname;
    ti.texture = tex;
    mod.texinfo = [ti];

    return mod;
  }

  test("a plain-textured face: extents [400,400], no throw, no GL_SubdivideSurface call", () => {
    const mod = buildSquareModel("wall");
    loadState.loadmodel = mod;
    const faceBytes = buildFaceLump(0, 0, 0, 4, 0);

    expect(() => Mod_LoadFaces(mod, faceBytes, lumpOf(faceBytes))).not.toThrow();

    expect(Array.from(mod.surfaces[0].extents)).toEqual([400, 400]);
    expect(mod.surfaces[0].flags & 0x04).toBe(0); // SURF_DRAWSKY not set
    expect(mod.surfaces[0].flags & 0x10).toBe(0); // SURF_DRAWTURB not set
    expect(glWarp.GL_SubdivideSurface).not.toHaveBeenCalled();
  });

  test("a sky-textured face: SURF_DRAWSKY|SURF_DRAWTILED set, GL_SubdivideSurface called", () => {
    const mod = buildSquareModel("sky1");
    loadState.loadmodel = mod;
    const faceBytes = buildFaceLump(0, 0, 0, 4, 0);

    Mod_LoadFaces(mod, faceBytes, lumpOf(faceBytes));

    expect(mod.surfaces[0].flags & (0x04 | 0x20)).toBe(0x04 | 0x20); // SURF_DRAWSKY|SURF_DRAWTILED
    expect(glWarp.GL_SubdivideSurface).toHaveBeenCalledWith(mod.surfaces[0]);
  });

  test("a turbulent-textured face: extents/texturemins overridden, GL_SubdivideSurface called", () => {
    const mod = buildSquareModel("*04mwat1");
    loadState.loadmodel = mod;
    const faceBytes = buildFaceLump(0, 0, 0, 4, 0);

    Mod_LoadFaces(mod, faceBytes, lumpOf(faceBytes));

    const surf = mod.surfaces[0];
    expect(surf.flags & (0x10 | 0x20)).toBe(0x10 | 0x20); // SURF_DRAWTURB|SURF_DRAWTILED
    expect(Array.from(surf.extents)).toEqual([16384, 16384]);
    expect(Array.from(surf.texturemins)).toEqual([-8192, -8192]);
    expect(glWarp.GL_SubdivideSurface).toHaveBeenCalledWith(surf);
  });
});

describe("afterBrushLoad: SURF_UNDERWATER pass", () => {
  test("marks every marksurface of a non-CONTENTS_EMPTY leaf", () => {
    const mod = new ModelT();
    const surfA = new MsurfaceT();
    const surfB = new MsurfaceT();
    mod.marksurfaces = [surfA, surfB];

    const solidLeaf = new MleafT();
    solidLeaf.contents = -2; // CONTENTS_SOLID
    solidLeaf.marksurfaces = mod.marksurfaces;
    solidLeaf.firstmarksurface = 0;
    solidLeaf.nummarksurfaces = 2;

    const emptyLeaf = new MleafT();
    emptyLeaf.contents = -1; // CONTENTS_EMPTY
    emptyLeaf.marksurfaces = mod.marksurfaces;
    emptyLeaf.firstmarksurface = 0;
    emptyLeaf.nummarksurfaces = 1;

    mod.leafs = [solidLeaf, emptyLeaf];

    afterBrushLoad(mod);

    expect(surfA.flags & 0x80).toBe(0x80); // SURF_UNDERWATER, from the solid leaf
    expect(surfB.flags & 0x80).toBe(0x80); // SURF_UNDERWATER, from the solid leaf
  });

  test("does not mark surfaces of a CONTENTS_EMPTY-only leaf", () => {
    const mod = new ModelT();
    const surf = new MsurfaceT();
    mod.marksurfaces = [surf];

    const emptyLeaf = new MleafT();
    emptyLeaf.contents = -1; // CONTENTS_EMPTY
    emptyLeaf.marksurfaces = mod.marksurfaces;
    emptyLeaf.firstmarksurface = 0;
    emptyLeaf.nummarksurfaces = 1;
    mod.leafs = [emptyLeaf];

    afterBrushLoad(mod);

    expect(surf.flags & 0x80).toBe(0);
  });
});

describe("Mod_FloodFillSkin", () => {
  test("propagates the neighbor colour into the fillcolor region without crossing a 255 border", () => {
    // 8x8 skin: fillcolor=3 everywhere on the left of a full-height 255
    // column border at x=4, one real colour (9) at (3,4) bordering the
    // fillable region, and untouched content (5) on the far side of the
    // border that must never be reached.
    const skinwidth = 8;
    const skinheight = 8;
    const skin = new Uint8Array(skinwidth * skinheight).fill(3);
    for (let y = 0; y < skinheight; y++) skin[4 + skinwidth * y] = 255;
    skin[3 + skinwidth * 4] = 9;
    for (let y = 0; y < skinheight; y++) {
      for (let x = 5; x < skinwidth; x++) skin[x + skinwidth * y] = 5;
    }

    d_8to24table.fill(0);
    d_8to24table[0] = 255; // deterministic filledcolor = 0 ("opaque black")

    Mod_FloodFillSkin(skin, skinwidth, skinheight);

    // far from any real colour: filled with the default filledcolor
    expect(skin[0 + skinwidth * 0]).toBe(0);
    // the real colour pixel itself is read, never overwritten
    expect(skin[3 + skinwidth * 4]).toBe(9);
    // a background pixel bordering it (found via its "down" neighbor check,
    // the last of the four direction checks, so nothing overwrites it after)
    // is resolved to the same neighbor colour instead of the default fill
    expect(skin[3 + skinwidth * 3]).toBe(9);
    // the 255 border column is never crossed or altered
    for (let y = 0; y < skinheight; y++) expect(skin[4 + skinwidth * y]).toBe(255);
    // content past the border is never reached
    for (let y = 0; y < skinheight; y++) {
      for (let x = 5; x < skinwidth; x++) expect(skin[x + skinwidth * y]).toBe(5);
    }
  });

  test("a skin whose corner pixel is already 255 is left untouched", () => {
    const skin = new Uint8Array(16).fill(3);
    skin[0] = 255;
    const before = Array.from(skin);
    Mod_FloodFillSkin(skin, 4, 4);
    expect(Array.from(skin)).toEqual(before);
  });
});

describe("Mod_LoadAliasModel (direct)", () => {
  test("builds an AliashdrT: numposes, frame pose ranges, gl_texturenum/texels, no <<16 s/t shift", () => {
    const buffer = buildMdl({ numframes: 2 });
    const mod = new ModelT();
    mod.name = "progs/test.mdl";
    loadState.loadname = "test";

    Mod_LoadAliasModel(mod, buffer);

    expect(mod.type).toBe(ModtypeT.mod_alias);
    expect(Array.from(mod.mins)).toEqual([-16, -16, -16]);
    expect(Array.from(mod.maxs)).toEqual([16, 16, 16]);
    expect(mod.numframes).toBe(2);

    const hdr = mod.cache.data;
    if (!(hdr instanceof AliashdrT)) throw new Error("expected an AliashdrT in mod.cache.data");

    expect(hdr.numverts).toBe(3);
    expect(hdr.numtris).toBe(1);
    expect(hdr.numframes).toBe(2);
    expect(hdr.skinwidth).toBe(4);
    expect(hdr.skinheight).toBe(4);

    // frames[i].firstpose/numposes and the running pose count
    expect(hdr.frames.length).toBe(2);
    expect(hdr.frames[0].firstpose).toBe(0);
    expect(hdr.frames[0].numposes).toBe(1);
    expect(hdr.frames[1].firstpose).toBe(1);
    expect(hdr.frames[1].numposes).toBe(1);
    expect(hdr.numposes).toBe(2);

    // posedata length numposes*numverts, filled by the GL_MakeAliasModelDisplayLists
    // mock (see beforeAll) proving pheader/poseverts are correctly populated
    expect(hdr.posedata.length).toBe(hdr.numposes * hdr.numverts);
    expect(pheader).toBe(hdr);
    expect(glMesh.GL_MakeAliasModelDisplayLists).toHaveBeenCalledTimes(1);
    expect(glMesh.GL_MakeAliasModelDisplayLists).toHaveBeenCalledWith(mod, hdr);

    // gl_texturenum filled for skin 0, all four anim slots (single skin -> same texnum)
    expect(hdr.gl_texturenum[0]).toBeGreaterThan(0);
    expect(hdr.gl_texturenum[1]).toBe(hdr.gl_texturenum[0]);
    expect(hdr.gl_texturenum[2]).toBe(hdr.gl_texturenum[0]);
    expect(hdr.gl_texturenum[3]).toBe(hdr.gl_texturenum[0]);

    // texels[0] holds the skin bytes
    const texels0 = hdr.texels[0];
    if (!(texels0 instanceof Uint8Array)) throw new Error("expected texels[0] to hold pixel bytes");
    expect(texels0.length).toBe(16); // 4x4 skin
    for (let i = 0; i < 16; i++) expect(texels0[i]).toBe(i & 0xff);
  });

  test("a wrong alias version is a Sys_Error", () => {
    const buffer = buildMdl({ version: 5 });
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadAliasModel(mod, buffer)).toThrow(SysError);
  });
});

describe("group/helper functions (direct)", () => {
  test("Mod_LoadAliasFrame: bboxmin holds the source's bboxmax (preserved bug), bboxmax stays default", () => {
    const w = new Writer(24 + 3 * 4);
    w.u8(1);
    w.u8(2);
    w.u8(3);
    w.u8(0); // bboxmin (source)
    w.u8(9);
    w.u8(8);
    w.u8(7);
    w.u8(0); // bboxmax (source)
    w.chars("frame0", 16);
    for (let v = 0; v < 3; v++) {
      w.u8(v);
      w.u8(v);
      w.u8(v);
      w.u8(0);
    }

    const fd = new MaliasframedescT();
    const next = Mod_LoadAliasFrame(w.bytes, 0, fd, 3);

    expect(fd.name).toBe("frame0");
    expect(Array.from(fd.bboxmin.v)).toEqual([9, 8, 7]); // source's bboxMAX, per the preserved bug
    expect(Array.from(fd.bboxmax.v)).toEqual([0, 0, 0]); // never written
    expect(fd.numposes).toBe(1);
    expect(next).toBe(w.bytes.length);
  });

  test("Mod_LoadAliasGroup: only the first interval is read, per-subframe headers are skipped unread", () => {
    const numv = 2;
    const numframes = 2;
    // daliasgroup_t (12) + 2 daliasinterval_t (4 each) + 2 * (daliasframe_t(24) + 2 trivertx(4 each))
    const w = new Writer(12 + numframes * 4 + numframes * (24 + numv * 4));
    w.i32(numframes);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.f32(0.5);
    w.f32(0.75); // second interval, never read
    for (let f = 0; f < numframes; f++) {
      w.chars("", 24); // per-subframe daliasframe_t header, skipped unread
      for (let v = 0; v < numv; v++) {
        w.u8(10 + f * 2 + v);
        w.u8(0);
        w.u8(0);
        w.u8(0);
      }
    }

    const fd = new MaliasframedescT();
    const next = Mod_LoadAliasGroup(w.bytes, 0, fd, numv);

    expect(fd.numposes).toBe(2);
    expect(fd.interval).toBeCloseTo(0.5); // only the first interval
    expect(next).toBe(w.bytes.length);
  });

  test("Mod_LoadAllSkins: single skin gets flood-filled, texels/gl_texturenum filled", () => {
    const hdr = new AliashdrT();
    hdr.skinwidth = 4;
    hdr.skinheight = 4;
    const mod = new ModelT();
    mod.name = "progs/skin.mdl";
    loadState.loadname = "test";

    const w = new Writer(4 + 16);
    w.i32(AliasskintypeT.ALIAS_SKIN_SINGLE);
    for (let i = 0; i < 16; i++) w.u8(i & 0xff);

    const next = Mod_LoadAllSkins(mod, hdr, w.bytes, 1, 0);

    expect(next).toBe(w.bytes.length);
    expect(hdr.texels[0]).not.toBeNull();
    expect(hdr.gl_texturenum[0]).toBeGreaterThan(0);
    expect(hdr.gl_texturenum[1]).toBe(hdr.gl_texturenum[0]);
  });

  test("Mod_LoadAllSkins: too many skins is a Sys_Error", () => {
    const hdr = new AliashdrT();
    hdr.skinwidth = 4;
    hdr.skinheight = 4;
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadAllSkins(mod, hdr, new Uint8Array(4), 0, 0)).toThrow(SysError);
  });
});

describe("Mod_LoadSpriteModel (direct)", () => {
  test("builds an MspriteT: MspriteframeT with gl_texturenum and up/down/left/right", () => {
    const buffer = buildSpr({ numframes: 2, width: 32, height: 64 });
    const mod = new ModelT();
    mod.name = "progs/test.spr";
    loadState.loadname = "test";

    Mod_LoadSpriteModel(mod, buffer);

    expect(mod.type).toBe(ModtypeT.mod_sprite);
    expect(mod.numframes).toBe(2);
    expect(Array.from(mod.mins)).toEqual([-16, -16, -32]);
    expect(Array.from(mod.maxs)).toEqual([16, 16, 32]);

    const spr = mod.cache.data;
    if (!(spr instanceof MspriteT)) throw new Error("expected an MspriteT in mod.cache.data");
    expect(spr.numframes).toBe(2);

    const f0 = spr.frames[0].frameptr;
    if (!(f0 instanceof MspriteframeT)) throw new Error("expected an SPR_SINGLE frame");
    expect(f0.width).toBe(32);
    expect(f0.height).toBe(64);
    expect(f0.up).toBe(32); // origin[1] = height>>1
    expect(f0.down).toBe(32 - 64);
    expect(f0.left).toBe(-16); // origin[0] = -(width>>1)
    expect(f0.right).toBe(32 - 16);
    expect(f0.gl_texturenum).toBeGreaterThan(0);
    expect(glDraw.GL_LoadTexture).toHaveBeenCalledWith("progs/test.spr_0", 32, 64, expect.anything(), true, true);
  });

  test("a wrong sprite version is a Sys_Error", () => {
    const buffer = buildSpr({ version: 2 });
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadSpriteModel(mod, buffer)).toThrow(SysError);
  });

  test("Mod_LoadSpriteFrame/Mod_LoadSpriteGroup helpers build the same shapes directly", () => {
    const mod = new ModelT();
    mod.name = "progs/g.spr";

    const fw = new Writer(16 + 256);
    fw.i32(-8);
    fw.i32(8);
    fw.i32(16);
    fw.i32(16);
    for (let i = 0; i < 256; i++) fw.u8(i & 0xff);
    const r = Mod_LoadSpriteFrame(mod, fw.bytes, 0, 3);
    expect(r.frame.width).toBe(16);
    expect(r.frame.gl_texturenum).toBeGreaterThan(0);
    expect(r.next).toBe(fw.bytes.length);

    const gw = new Writer(4 + 2 * 4 + 2 * (16 + 256));
    gw.i32(2);
    gw.f32(0.5);
    gw.f32(0.25);
    for (let f = 0; f < 2; f++) {
      gw.i32(-8);
      gw.i32(8);
      gw.i32(16);
      gw.i32(16);
      for (let i = 0; i < 256; i++) gw.u8(i & 0xff);
    }
    const gr = Mod_LoadSpriteGroup(mod, gw.bytes, 0, 5);
    expect(gr.group).toBeInstanceOf(MspritegroupT);
    expect(gr.group.numframes).toBe(2);
    expect(Array.from(gr.group.intervals)).toEqual([0.5, 0.25]);
    expect(gr.next).toBe(gw.bytes.length);
  });

  test("Mod_LoadSpriteGroup with interval<=0 is a Sys_Error", () => {
    const mod = new ModelT();
    const gw = new Writer(4 + 4);
    gw.i32(1);
    gw.f32(0);
    expect(() => Mod_LoadSpriteGroup(mod, gw.bytes, 0, 0)).toThrow(SysError);
  });
});

describe("Mod_ForName integration", () => {
  test("glModelHooks plugs into the shared Mod_LoadBrushModel loader end-to-end", () => {
    setModelLoaderHooks(glModelHooks);
    try {
      const mod = Mod_ForName("maps/test.bsp", true);
      if (mod === null) throw new Error("expected maps/test.bsp to load");

      expect(mod.numtextures).toBe(1);
      const tx = mod.textures?.[0];
      if (!tx) throw new Error("expected the map's texture to load");
      expect(tx.name).toBe("bsptest");
      expect(tx.gl_texturenum).toBeGreaterThan(0); // came from the GL_LoadTexture spy

      // Mod_LoadTexinfo (shared) resolved the miptex through this hook's array
      expect(mod.texinfo[0].texture).toBe(tx);

      // both faces share the one non-special texture: no subdivide, extents small
      expect(mod.surfaces.length).toBeGreaterThan(0);
      for (const surf of mod.surfaces) {
        expect(surf.flags & 0x04).toBe(0); // SURF_DRAWSKY
      }
    } finally {
      setModelLoaderHooks(null);
    }
  });

  test("a sky-textured map calls R_InitSky and marks SURF_DRAWSKY on every face", () => {
    setModelLoaderHooks(glModelHooks);
    try {
      const mod = Mod_ForName("maps/skytest.bsp", true);
      if (mod === null) throw new Error("expected maps/skytest.bsp to load");

      expect(glWarp.R_InitSky).toHaveBeenCalled();
      const tx = mod.textures?.[0];
      if (!tx) throw new Error("expected the map's texture to load");
      expect(tx.name).toBe("sky");
      expect(tx.gl_texturenum).toBe(0); // sky path never calls GL_LoadTexture

      for (const surf of mod.surfaces) {
        expect(surf.flags & 0x04).toBe(0x04); // SURF_DRAWSKY
      }
    } finally {
      setModelLoaderHooks(null);
    }
  });
});
