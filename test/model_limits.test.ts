// U14: the shared model loader stops rejecting re-release content. Three
// independent limits, each tested against the exact new value:
//   - MAX_MOD_KNOWN 256 -> 8192 (mod_known grows on demand; "flush cache"
//     behaviour -- reusing an NL_UNREFERENCED slot once the table is full --
//     is unchanged, just harder to reach).
//   - Mod_LoadTextures accepts a non-16-aligned miptex (warns under
//     developer 1 only, via Con_DPrintf, instead of Sys_Error) and computes
//     the mip pixel count with the same floor-and-minimum-1 rounding as the
//     mip levels themselves, not the width*height/64*85 shortcut (only exact
//     when both dimensions are multiples of 8).
//   - MAX_SURFACE_EXTENTS 256 -> 2000 (CalcSurfaceExtents's default cap);
//     TEX_SPECIAL stays exempt at any extent.
//
// Mod_FindName's growth test needs no filesystem (it only ever touches
// mod_known/mod_numknown); the texture and extents tests need a loaded
// model, so they follow test/model.test.ts's own fixture recipe.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { SysError } from "../src/platform/sys";
import { setDeveloper } from "../src/client/console";
import {
  CalcSurfaceExtents,
  MAX_MOD_KNOWN,
  MAX_SURFACE_EXTENTS,
  Mod_FindName,
  Mod_ForName,
  Mod_Init,
  ModelT,
  MedgeT,
  MsurfaceT,
  MtexinfoT,
  MvertexT,
  TextureT,
  loadState,
} from "../src/common/model";
import { MplaneT } from "../src/common/mathlib";
import { TEX_SPECIAL } from "../src/common/bspfile";
import { BSP_MIPTEX_NAME, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "model-limits-test-"));
const baseDir = join(scratchDir, "quake");

afterAll(() => {
  setDeveloper(null);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/oddsize.bsp", buildBsp({ miptexWidth: 24, miptexHeight: 40 }));

  // gfx/pop.lmp: see test/model.test.ts's own copy of this comment.
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
});

describe("Mod_LoadTextures: textures of any size", () => {
  test("a 24x40 miptex (not 16-aligned) loads without throwing", () => {
    setDeveloper(null); // default: no developer cvar installed, matches most callers
    const mod = Mod_ForName("maps/oddsize.bsp", true);
    if (mod === null) throw new Error("expected maps/oddsize.bsp to load");

    const tex = mod.textures?.[0];
    if (!tex) throw new Error("expected a loaded texture");
    expect(tex.name).toBe(BSP_MIPTEX_NAME);
    expect(tex.width).toBe(24);
    expect(tex.height).toBe(40);

    // mip dims: 24x40, 12x20, 6x10, 3x5 (24 and 40 are both multiples of 8,
    // so this also matches the classic width*height/64*85 shortcut -- see
    // the next test for a size where the two diverge).
    const expectedPixels = 24 * 40 + 12 * 20 + 6 * 10 + 3 * 5;
    expect(tex.data.length).toBe(expectedPixels);

    // offsets are relative to `data` (mt.offsets[0] === sizeof(miptex_t) in
    // the C, normalized to 0 here -- see model.ts's own header note).
    expect(tex.offsets[0]).toBe(0);
    expect(tex.offsets[1]).toBe(24 * 40);
    expect(tex.offsets[2]).toBe(24 * 40 + 12 * 20);
    expect(tex.offsets[3]).toBe(24 * 40 + 12 * 20 + 6 * 10);
  });

  test("developer 1 does not turn the alignment mismatch into a throw either (still just a warning)", () => {
    setDeveloper({ value: 1 });
    try {
      expect(() => Mod_ForName("maps/oddsize.bsp", true)).not.toThrow();
    } finally {
      setDeveloper(null);
    }
  });

  test("textureMipPixels diverges from the classic width*height/64*85 shortcut when height is not a multiple of 8", () => {
    // width=24 (multiple of 8), height=44 (NOT a multiple of 8): the
    // classic shortcut floor(24*44/64)*85 = floor(16.5)*85 = 1360, but the
    // real per-level sum is 24*44 + 12*22 + 6*11 + 3*5 = 1401. A loader that
    // used the shortcut here would allocate/copy 41 bytes short.
    const w = 24;
    const h = 44;
    const shortcut = Math.floor((w * h) / 64) * 85;
    const perLevelSum = w * h + (w >> 1) * (h >> 1) + (w >> 2) * (h >> 2) + (w >> 3) * (h >> 3);
    expect(shortcut).not.toBe(perLevelSum);
    expect(perLevelSum).toBe(1401);

    writeGameFile(baseDir, "id1/maps/oddsize2.bsp", buildBsp({ miptexWidth: w, miptexHeight: h, miptexName: "oddsize2" }));
    const mod = Mod_ForName("maps/oddsize2.bsp", true);
    if (mod === null) throw new Error("expected maps/oddsize2.bsp to load");
    const tex = mod.textures?.[0];
    if (!tex) throw new Error("expected a loaded texture");
    expect(tex.data.length).toBe(perLevelSum);
  });
});

describe("MAX_SURFACE_EXTENTS", () => {
  test("is 2000, not the old 256", () => {
    expect(MAX_SURFACE_EXTENTS).toBe(2000);
  });

  // A minimal standalone brush model, built the same way
  // test/ref_gl_model.test.ts's buildSquareModel does: one square face whose
  // s/t texinfo axes are the world x/y axes, so its extents equal its side
  // length exactly. `side` controls the extents CalcSurfaceExtents computes;
  // `special` sets TEX_SPECIAL on its texinfo.
  function squareModel(side: number, special: boolean): { mod: ModelT; surf: MsurfaceT } {
    const mod = new ModelT();
    mod.vertexes = [
      Object.assign(new MvertexT(), { position: new Float32Array([0, 0, 0]) }),
      Object.assign(new MvertexT(), { position: new Float32Array([side, 0, 0]) }),
      Object.assign(new MvertexT(), { position: new Float32Array([side, side, 0]) }),
      Object.assign(new MvertexT(), { position: new Float32Array([0, side, 0]) }),
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
    ti.flags = special ? TEX_SPECIAL : 0;
    ti.texture = new TextureT();
    mod.texinfo = [ti];

    const surf = new MsurfaceT();
    surf.firstedge = 0;
    surf.numedges = 4;
    surf.texinfo = ti;
    surf.plane = mod.planes[0];
    mod.surfaces = [surf];

    return { mod, surf };
  }

  test("a non-TEX_SPECIAL surface at exactly 2000 extent does not throw with the default cap", () => {
    const { mod, surf } = squareModel(2000, false);
    loadState.loadmodel = mod;
    expect(() => CalcSurfaceExtents(surf)).not.toThrow();
    expect(Array.from(surf.extents)).toEqual([2000, 2000]);
  });

  test("a non-TEX_SPECIAL surface just over 2000 extent throws with the default cap", () => {
    const { mod, surf } = squareModel(2016, false); // rounds to 2016, > 2000
    loadState.loadmodel = mod;
    expect(() => CalcSurfaceExtents(surf)).toThrow(SysError);
    expect(() => CalcSurfaceExtents(surf)).toThrow(/Bad surface extents/);
  });

  test("an explicit lower cap still throws below 2000 (the parameter, not just the default, still works)", () => {
    const { mod, surf } = squareModel(400, false);
    loadState.loadmodel = mod;
    expect(() => CalcSurfaceExtents(surf, 256)).toThrow(SysError);
  });

  test("TEX_SPECIAL stays exempt no matter how far past 2000 the extents run", () => {
    const { mod, surf } = squareModel(4000, true);
    loadState.loadmodel = mod;
    expect(() => CalcSurfaceExtents(surf)).not.toThrow();
    expect(Array.from(surf.extents)).toEqual([4000, 4000]);
  });
});

// Last, deliberately: Mod_FindName only ever grows mod_known and never
// shrinks it (see model.ts's own "Pre-existing test-isolation gap" comment
// on Mod_Init -- there is no reset), so running this to exhaustion
// permanently uses up every slot mod_known can ever hold for the rest of
// this process. Any test after this one that calls Mod_ForName/Mod_FindName
// would itself throw "mod_numknown == MAX_MOD_KNOWN", which is exactly why
// it runs last in this file rather than first.
describe("MAX_MOD_KNOWN", () => {
  test("is 8192, not the old 256", () => {
    expect(MAX_MOD_KNOWN).toBe(8192);
  });

  test("mod_known grows past the old 256 cap without throwing, and still throws once truly full", () => {
    // Mod_FindName only registers a name (needload = NL_NEEDS_LOADED); it
    // never reads a file, so this exercises mod_known's own growth with no
    // filesystem involved. Unique names avoid colliding with any model
    // another describe block in this file (or another test file, if ever
    // run in the same process) has already registered. The loop runs a
    // little past MAX_MOD_KNOWN rather than assuming mod_known starts empty
    // (this file's own earlier tests already registered a couple of names),
    // and records where it actually threw.
    let registered = 0;
    let threw: unknown = null;
    for (let i = 0; i < MAX_MOD_KNOWN + 8; i++) {
      try {
        Mod_FindName(`progs/model_limits_test_${i}.mdl`);
        registered++;
      } catch (e) {
        threw = e;
        break;
      }
    }

    // proof the cap actually moved: this file's earlier tests registered at
    // most a handful of names, so clearing the OLD 256 cap by a wide margin
    // means MAX_MOD_KNOWN is genuinely larger than 256, not just that this
    // loop got lucky with leftover slots.
    expect(registered).toBeGreaterThan(256);
    expect(threw).toBeInstanceOf(SysError);
    expect((threw as SysError).message).toMatch(/mod_numknown == MAX_MOD_KNOWN/);
  });
});
