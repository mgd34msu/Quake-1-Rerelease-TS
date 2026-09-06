import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { SysError } from "../src/platform/sys";
import { SynctypeT } from "../src/common/modelgen";
import { CONTENTS_EMPTY, CONTENTS_SOLID, LumpT, MAX_MAP_LEAFS, TEX_SPECIAL } from "../src/common/bspfile";
import { vec3 } from "../src/common/mathlib";
import {
  CalcSurfaceExtents,
  EF_ROCKET,
  Mod_ClearAll,
  Mod_DecompressVis,
  Mod_FindName,
  Mod_ForName,
  Mod_Init,
  Mod_LeafPVS,
  Mod_LoadFaces,
  Mod_LoadTexinfo,
  Mod_PointInLeaf,
  ModelT,
  ModtypeT,
  NL_PRESENT,
  NL_UNREFERENCED,
  SURF_DRAWSKY,
  TextureT,
  loadState,
  mod_novis,
  setModelLoaderHooks,
  type ModelLoaderHooks,
} from "../src/common/model";
import {
  BSP_ENTITIES,
  BSP_MIPTEX_NAME,
  BSP_NUMCLIPNODES,
  BSP_NUMEDGES,
  BSP_NUMFACES,
  BSP_NUMLEAFS,
  BSP_NUMMARKSURFACES,
  BSP_NUMNODES,
  BSP_NUMPLANES,
  BSP_NUMSUBMODELS,
  BSP_NUMSURFEDGES,
  BSP_NUMTEXINFO,
  BSP_NUMTEXINFO_WITH_SKY,
  BSP_NUMVERTEXES,
  BSP_SKY_MIPTEX_NAME,
  BSP_VISLEAFS,
  buildBsp,
  buildMdl,
  buildSpr,
  ensureDir,
  writeGameFile,
} from "./support/bsp_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "model-test-"));
const baseDir = join(scratchDir, "quake");

// the compressed PVS row the "visibility lump" map carries: one literal 0xff
// byte, then a run of two zero bytes, then a literal 0x81.
const COMPRESSED_VIS = new Uint8Array([0xff, 0x00, 0x02, 0x81]);

afterAll(() => {
  setModelLoaderHooks(null);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/test.bsp", buildBsp());
  writeGameFile(baseDir, "id1/maps/vis.bsp", buildBsp({ visdata: COMPRESSED_VIS }));
  writeGameFile(baseDir, "id1/maps/hooks.bsp", buildBsp());
  writeGameFile(baseDir, "id1/progs/test.mdl", buildMdl({ numframes: 3, synctype: 1, flags: EF_ROCKET }));
  writeGameFile(baseDir, "id1/progs/test.spr", buildSpr({ numframes: 2, width: 32, height: 64, synctype: 0 }));

  // gfx/pop.lmp inside id1/pak0.pak: the registered-version check's 128
  // big-endian shorts. Without it COM_CheckRegistered leaves the engine in
  // shareware mode, and COM_FindFile then never searches loose directories
  // for a path containing a slash ("maps/test.bsp") -- exactly as the C does.
  // It must sit in a pak because that same rule would hide a loose pop.lmp.
  // Another suite in the same process may already have run the check, so
  // this one re-runs it.
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

function loadWorld(name: string): ModelT {
  const mod = Mod_ForName(name, true);
  if (mod === null) throw new Error(`expected ${name} to load`);
  return mod;
}

//============================================================================

describe("Mod_Init / mod_novis", () => {
  test("mod_novis is MAX_MAP_LEAFS/8 bytes of 0xff", () => {
    expect(mod_novis.length).toBe(MAX_MAP_LEAFS / 8);
    for (let i = 0; i < mod_novis.length; i++) expect(mod_novis[i]).toBe(0xff);
  });
});

describe("Mod_ForName: brush model, no hooks installed (dedicated path)", () => {
  test("loads every lump the builder emitted", () => {
    const mod = loadWorld("maps/test.bsp");

    expect(mod.type).toBe(ModtypeT.mod_brush);
    expect(mod.needload).toBe(NL_PRESENT);
    expect(mod.numplanes).toBe(BSP_NUMPLANES);
    expect(mod.numnodes).toBe(BSP_NUMNODES);
    expect(mod.numclipnodes).toBe(BSP_NUMCLIPNODES);
    expect(mod.numvertexes).toBe(BSP_NUMVERTEXES);
    expect(mod.numedges).toBe(BSP_NUMEDGES);
    expect(mod.numsurfedges).toBe(BSP_NUMSURFEDGES);
    expect(mod.numsurfaces).toBe(BSP_NUMFACES);
    expect(mod.numtexinfo).toBe(BSP_NUMTEXINFO);
    expect(mod.nummarksurfaces).toBe(BSP_NUMMARKSURFACES);
    expect(mod.numsubmodels).toBe(BSP_NUMSUBMODELS);

    // Mod_LoadLeafs sets numleafs to the lump count; the submodel loop then
    // overwrites it with the submodel's visleafs, exactly as the C does.
    expect(mod.leafs.length).toBe(BSP_NUMLEAFS);
    expect(mod.numleafs).toBe(BSP_VISLEAFS);

    // Mod_LoadEdges allocates count + 1 entries and fills count
    expect(mod.edges.length).toBe(BSP_NUMEDGES + 1);
  });

  test("textures load even with no hooks installed; only lighting is skipped", () => {
    // Mod_LoadTextures is shared and unconditional (see src/common/model.ts's
    // header): WinQuake links it into the dedicated server too, so texinfo
    // and faces need real texture names/flags on every path. Lighting is the
    // one genuine deviation the dedicated path still has -- see below.
    const mod = loadWorld("maps/test.bsp");
    const tex = mod.textures?.[0];
    if (!tex) throw new Error("expected a loaded texture");
    expect(mod.numtextures).toBe(1);
    expect(tex.name).toBe(BSP_MIPTEX_NAME);
    expect(mod.texinfo[0].texture).toBe(tex);

    expect(mod.lightdata).toBeNull();
    expect(mod.surfaces[0].samples).toBeNull();
    expect(mod.surfaces[0].lightofs).toBe(-1);
  });

  test("numframes/flags/mins/maxs/radius come from the submodel", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(mod.numframes).toBe(2); // regular and alternate animation
    expect(mod.flags).toBe(0);
    // Mod_LoadSubmodels spreads the mins/maxs by a pixel
    expect(Array.from(mod.mins)).toEqual([-257, -257, -257]);
    expect(Array.from(mod.maxs)).toEqual([257, 257, 257]);
    expect(mod.radius).toBeCloseTo(Math.sqrt(3 * 257 * 257), 3);
  });

  test("CalcSurfaceExtents filled texturemins/extents for both faces", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(Array.from(mod.surfaces[0].texturemins)).toEqual([0, 0]);
    expect(Array.from(mod.surfaces[0].extents)).toEqual([64, 64]);
    expect(Array.from(mod.surfaces[1].texturemins)).toEqual([128, 0]);
    expect(Array.from(mod.surfaces[1].extents)).toEqual([64, 64]);
  });

  test("node children point at the two leafs, and Mod_SetParent linked them", () => {
    const mod = loadWorld("maps/test.bsp");
    const node = mod.nodes[0];
    expect(node.plane).toBe(mod.planes[0]);
    expect(node.children[0]).toBe(mod.leafs[1]);
    expect(node.children[1]).toBe(mod.leafs[0]);
    expect(node.parent).toBeNull();
    expect(mod.leafs[0].parent).toBe(node);
    expect(mod.leafs[1].parent).toBe(node);
  });

  test("Mod_LoadPlanes computed signbits", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(Array.from(mod.planes[0].normal)).toEqual([0, 0, 1]);
    expect(mod.planes[0].type).toBe(2); // PLANE_Z
    expect(mod.planes[0].signbits).toBe(0);
    expect(mod.planes[1].signbits).toBe(0);
  });

  test("marksurfaces resolve to surfaces, and leaf 1 owns both", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(mod.marksurfaces[0]).toBe(mod.surfaces[0]);
    expect(mod.marksurfaces[1]).toBe(mod.surfaces[1]);

    const leaf = mod.leafs[1];
    expect(leaf.nummarksurfaces).toBe(BSP_NUMMARKSURFACES);
    expect(leaf.marksurfaces).toBe(mod.marksurfaces);
    expect(leaf.marksurfaces[leaf.firstmarksurface + 0]).toBe(mod.surfaces[0]);
    expect(leaf.marksurfaces[leaf.firstmarksurface + 1]).toBe(mod.surfaces[1]);
    expect(Array.from(leaf.ambient_sound_level)).toEqual([1, 2, 3, 4]);
  });

  test("entities string roundtrips", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(mod.entities).toBe(BSP_ENTITIES);
  });
});

describe("hulls", () => {
  test("Mod_MakeHull0 duplicates the drawing hull with leaf contents inlined", () => {
    const mod = loadWorld("maps/test.bsp");
    const hull = mod.hulls[0];

    expect(hull.clipnodes.length).toBe(mod.numnodes);
    expect(hull.planes).toBe(mod.planes);
    expect(hull.firstclipnode).toBe(0); // submodel 0's headnode[0]
    expect(hull.lastclipnode).toBe(mod.numnodes - 1);

    expect(hull.clipnodes[0].planenum).toBe(0);
    expect(hull.clipnodes[0].children[0]).toBe(CONTENTS_EMPTY); // leaf 1
    expect(hull.clipnodes[0].children[1]).toBe(CONTENTS_SOLID); // leaf 0
  });

  test("hull 1 and hull 2 carry the player and shambler bounding boxes", () => {
    const mod = loadWorld("maps/test.bsp");

    expect(Array.from(mod.hulls[1].clip_mins)).toEqual([-16, -16, -24]);
    expect(Array.from(mod.hulls[1].clip_maxs)).toEqual([16, 16, 32]);
    expect(mod.hulls[1].clipnodes).toBe(mod.clipnodes);
    expect(mod.hulls[1].firstclipnode).toBe(0);
    expect(mod.hulls[1].lastclipnode).toBe(BSP_NUMCLIPNODES - 1);

    expect(Array.from(mod.hulls[2].clip_mins)).toEqual([-32, -32, -24]);
    expect(Array.from(mod.hulls[2].clip_maxs)).toEqual([32, 32, 64]);

    // hull 3 is never filled in by a BSP29 loader
    expect(Array.from(mod.hulls[3].clip_mins)).toEqual([0, 0, 0]);
  });

  test("the loaded clipnodes match the builder's", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(mod.clipnodes[0].planenum).toBe(0);
    expect(Array.from(mod.clipnodes[0].children)).toEqual([1, CONTENTS_SOLID]);
    expect(mod.clipnodes[1].planenum).toBe(1);
    expect(Array.from(mod.clipnodes[1].children)).toEqual([CONTENTS_EMPTY, 2]);
    expect(Array.from(mod.clipnodes[2].children)).toEqual([CONTENTS_EMPTY, CONTENTS_EMPTY]);
  });
});

describe("Mod_PointInLeaf", () => {
  test("a point above the splitting plane lands in the empty leaf", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(Mod_PointInLeaf(vec3(0, 0, 10), mod)).toBe(mod.leafs[1]);
    expect(Mod_PointInLeaf(vec3(0, 0, 10), mod).contents).toBe(CONTENTS_EMPTY);
  });

  test("a point below it lands in the solid leaf", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(Mod_PointInLeaf(vec3(0, 0, -10), mod)).toBe(mod.leafs[0]);
    expect(Mod_PointInLeaf(vec3(0, 0, -10), mod).contents).toBe(CONTENTS_SOLID);
  });

  test("a null model is a Sys_Error", () => {
    expect(() => Mod_PointInLeaf(vec3(0, 0, 0), null)).toThrow(SysError);
  });
});

describe("visibility", () => {
  test("Mod_LeafPVS on leaf 0 returns mod_novis", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(Mod_LeafPVS(mod.leafs[0], mod)).toBe(mod_novis);
  });

  test("Mod_LeafPVS with no vis info is all 0xff for the whole row", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(mod.visdata).toBeNull();
    expect(mod.leafs[1].compressed_vis).toBeNull();

    const pvs = Mod_LeafPVS(mod.leafs[1], mod);
    const row = (mod.numleafs + 7) >> 3;
    expect(row).toBe(1);
    for (let i = 0; i < row; i++) expect(pvs[i]).toBe(0xff);
  });

  test("Mod_DecompressVis expands a compressed row exactly", () => {
    const m = new ModelT();
    m.numleafs = 24; // row = 3 bytes

    const out = Mod_DecompressVis(COMPRESSED_VIS, m);
    expect(Array.from(out.subarray(0, 3))).toEqual([0xff, 0x00, 0x00]);
  });

  test("Mod_DecompressVis with a longer row keeps decoding past the zero run", () => {
    const m = new ModelT();
    m.numleafs = 32; // row = 4 bytes
    const out = Mod_DecompressVis(COMPRESSED_VIS, m);
    expect(Array.from(out.subarray(0, 4))).toEqual([0xff, 0x00, 0x00, 0x81]);
  });

  test("a map with a visibility lump gives leaf 1 a view into visdata", () => {
    const mod = loadWorld("maps/vis.bsp");

    expect(mod.visdata).not.toBeNull();
    const visdata = mod.visdata;
    if (visdata === null) throw new Error("expected visdata");
    expect(Array.from(visdata)).toEqual(Array.from(COMPRESSED_VIS));

    const leaf = mod.leafs[1];
    expect(leaf.visofs).toBe(0);
    const cv = leaf.compressed_vis;
    if (cv === null) throw new Error("expected compressed_vis");
    expect(Array.from(cv)).toEqual(Array.from(COMPRESSED_VIS));

    // numleafs is the submodel's visleafs (1), so the row is one byte
    const pvs = Mod_LeafPVS(leaf, mod);
    expect(pvs[0]).toBe(0xff);
  });
});

describe("mod_known caching", () => {
  test("a second Mod_ForName returns the same object without reloading", () => {
    const a = loadWorld("maps/test.bsp");
    const b = loadWorld("maps/test.bsp");
    expect(b).toBe(a);
    expect(Mod_FindName("maps/test.bsp")).toBe(a);
  });

  test("Mod_ForName on a missing file throws when crash is true", () => {
    expect(() => Mod_ForName("maps/nosuchmap.bsp", true)).toThrow(SysError);
  });

  test("Mod_ForName on a missing file returns null when crash is false", () => {
    expect(Mod_ForName("maps/alsomissing.bsp", false)).toBeNull();
  });
});

describe("alias and sprite models, no hooks installed (dedicated path)", () => {
  test("an IDPOLYHEADER file sets type/numframes/synctype/flags and +-16 bounds", () => {
    const mod = Mod_ForName("progs/test.mdl", true);
    if (mod === null) throw new Error("expected progs/test.mdl to load");

    expect(mod.type).toBe(ModtypeT.mod_alias);
    expect(mod.numframes).toBe(3);
    expect(mod.synctype).toBe(SynctypeT.ST_RAND);
    expect(mod.flags).toBe(EF_ROCKET);
    expect(Array.from(mod.mins)).toEqual([-16, -16, -16]);
    expect(Array.from(mod.maxs)).toEqual([16, 16, 16]);
    expect(mod.cache.data).toBeNull();
  });

  test("an IDSPRITEHEADER file sets bounds from the sprite's width and height", () => {
    const mod = Mod_ForName("progs/test.spr", true);
    if (mod === null) throw new Error("expected progs/test.spr to load");

    expect(mod.type).toBe(ModtypeT.mod_sprite);
    expect(mod.numframes).toBe(2);
    expect(mod.synctype).toBe(SynctypeT.ST_SYNC);
    expect(mod.flags).toBe(0);
    expect(Array.from(mod.mins)).toEqual([-16, -16, -32]);
    expect(Array.from(mod.maxs)).toEqual([16, 16, 32]);
    expect(mod.cache.data).toBeNull();
  });

  test("a wrong alias version is a Sys_Error", () => {
    writeGameFile(baseDir, "id1/progs/badver.mdl", buildMdl({ version: 5 }));
    expect(() => Mod_ForName("progs/badver.mdl", true)).toThrow(SysError);
  });

  test("a wrong sprite version is a Sys_Error", () => {
    writeGameFile(baseDir, "id1/progs/badver.spr", buildSpr({ version: 2 }));
    expect(() => Mod_ForName("progs/badver.spr", true)).toThrow(SysError);
  });
});

describe("ModelLoaderHooks", () => {
  test("the hooks fire in the C's lump order", () => {
    // Mod_LoadTextures itself is no longer a hook (it's shared and
    // unconditional, see src/common/model.ts's header); `textureLoaded` is
    // its per-texture step, called with the REAL texture the shared table
    // build produced from maps/hooks.bsp's single "bsptest" miptex.
    const calls: string[] = [];
    let loadedTexture: TextureT | null = null;

    const notexture = new TextureT();
    notexture.name = "notexture";
    notexture.width = 16;
    notexture.height = 16;

    const hooks: ModelLoaderHooks = {
      notexture,
      textureLoaded(tx) {
        calls.push("textureLoaded");
        loadedTexture = tx;
      },
      Mod_LoadLighting(mod, buf, l) {
        calls.push("Mod_LoadLighting");
        mod.lightdata = l.filelen ? buf.subarray(l.fileofs, l.fileofs + l.filelen) : null;
      },
      Mod_LoadFaces(_mod, _buf, l) {
        calls.push("Mod_LoadFaces");
        Mod_LoadFaces(l);
      },
      Mod_LoadAliasModel() {
        calls.push("Mod_LoadAliasModel");
      },
      Mod_LoadSpriteModel() {
        calls.push("Mod_LoadSpriteModel");
      },
      afterBrushLoad(mod) {
        calls.push(`afterBrushLoad:${mod.name}`);
      },
    };

    setModelLoaderHooks(hooks);
    try {
      const mod = loadWorld("maps/hooks.bsp");

      expect(calls).toEqual([
        "textureLoaded",
        "Mod_LoadLighting",
        "Mod_LoadFaces",
        "afterBrushLoad:maps/hooks.bsp",
      ]);

      // Mod_LoadTexinfo resolved the miptex through the shared table build,
      // and textureLoaded saw that same object.
      expect(mod.numtextures).toBe(1);
      expect(mod.texinfo[0].texture).toBe(loadedTexture);
      expect(mod.texinfo[0].texture?.name).toBe(BSP_MIPTEX_NAME);
      expect(mod.surfaces[0].texinfo).toBe(mod.texinfo[0]);
    } finally {
      setModelLoaderHooks(null);
    }
  });

  test("with hooks installed, an unresolved miptex (dataofs -1) falls back to notexture", () => {
    // Direct Mod_LoadTexinfo coverage: mod.textures with a null slot is what
    // the shared Mod_LoadTextures leaves for a dataofs of -1 (see
    // test/ref_soft_model.test.ts and test/ref_gl_model.test.ts, which drive
    // Mod_LoadTextures itself with exactly this case); this test only needs
    // to prove Mod_LoadTexinfo's own notexture-fallback branch, given that
    // state, still reads ModelLoaderHooks.notexture correctly.
    const notexture = new TextureT();
    notexture.name = "notexture";

    const hooks: ModelLoaderHooks = {
      notexture,
      textureLoaded() {},
      Mod_LoadLighting(mod) {
        mod.lightdata = null;
      },
      Mod_LoadAliasModel() {},
      Mod_LoadSpriteModel() {},
    };

    setModelLoaderHooks(hooks);
    try {
      const mod = new ModelT();
      mod.textures = [null];
      mod.numtextures = 1;

      // texinfo_t: vecs[2][4] float, miptex int, flags int (40 bytes);
      // miptex 0 / flags 0, s/t vecs irrelevant to this test.
      const tiBytes = new Uint8Array(40);
      new DataView(tiBytes.buffer).setFloat32(0, 1, true);
      new DataView(tiBytes.buffer).setFloat32(16, 1, true);

      loadState.loadmodel = mod;
      loadState.mod_base = tiBytes;
      const l = new LumpT();
      l.fileofs = 0;
      l.filelen = tiBytes.length;
      Mod_LoadTexinfo(l);

      expect(mod.texinfo[0].texture).toBe(notexture);
      expect(mod.texinfo[0].flags).toBe(0);
    } finally {
      setModelLoaderHooks(null);
      loadState.loadmodel = null;
      loadState.mod_base = null;
    }
  });

  test("the hooked alias and sprite loaders replace the dedicated ones", () => {
    const calls: string[] = [];
    const notexture = new TextureT();

    const hooks: ModelLoaderHooks = {
      notexture,
      textureLoaded() {},
      Mod_LoadLighting() {},
      Mod_LoadAliasModel(mod) {
        calls.push("Mod_LoadAliasModel");
        mod.type = ModtypeT.mod_alias;
        mod.cache.data = { hooked: true };
      },
      Mod_LoadSpriteModel(mod) {
        calls.push("Mod_LoadSpriteModel");
        mod.type = ModtypeT.mod_sprite;
      },
    };

    setModelLoaderHooks(hooks);
    try {
      writeGameFile(baseDir, "id1/progs/hooked.mdl", buildMdl());
      writeGameFile(baseDir, "id1/progs/hooked.spr", buildSpr());
      Mod_ForName("progs/hooked.mdl", true);
      Mod_ForName("progs/hooked.spr", true);
      expect(calls).toEqual(["Mod_LoadAliasModel", "Mod_LoadSpriteModel"]);
    } finally {
      setModelLoaderHooks(null);
    }
  });
});

// Reproduces and fixes the retail-pak dedicated-server crash: Mod_LoadTexinfo
// used to zero every texinfo's flags whenever no renderer hooks were
// installed (because mod.textures stayed null, since Mod_LoadTextures used
// to run only through a hook), so a sky/water texinfo lost TEX_SPECIAL and
// CalcSurfaceExtents rejected its oversized extents with "Bad surface
// extents". Mod_LoadTextures is now shared and unconditional (see
// src/common/model.ts's header), so this no longer happens on any path.
describe("dedicated path: sky/TEX_SPECIAL surface with oversized extents", () => {
  test("with NO hooks installed, the surface loads without Sys_Error and keeps TEX_SPECIAL/SURF_DRAWSKY", () => {
    writeGameFile(baseDir, "id1/maps/sky.bsp", buildBsp({ skyFace: true }));

    const mod = loadWorld("maps/sky.bsp");

    expect(mod.numtexinfo).toBe(BSP_NUMTEXINFO_WITH_SKY);
    expect(mod.numtextures).toBe(2);
    expect(mod.textures?.[0]?.name).toBe(BSP_MIPTEX_NAME);
    expect(mod.textures?.[1]?.name).toBe(BSP_SKY_MIPTEX_NAME);

    // texinfo 1 (face 1's) kept TEX_SPECIAL -- the bug zeroed this to 0
    const skyTexinfo = mod.texinfo[1];
    expect(skyTexinfo.flags & TEX_SPECIAL).toBe(TEX_SPECIAL);

    // face 1's extents are > 256 (the non-TEX_SPECIAL cap); CalcSurfaceExtents
    // only lets that through because TEX_SPECIAL survived, and Mod_LoadFaces
    // classified it as sky from the texture's real name
    const skySurface = mod.surfaces[1];
    expect(skySurface.extents[0]).toBeGreaterThan(256);
    expect(skySurface.flags & SURF_DRAWSKY).toBe(SURF_DRAWSKY);
  });

  test("with hooks installed, textureLoaded fires once per non-null texture", () => {
    writeGameFile(baseDir, "id1/maps/sky2.bsp", buildBsp({ skyFace: true }));

    const loaded: TextureT[] = [];
    const hooks: ModelLoaderHooks = {
      notexture: new TextureT(),
      textureLoaded(tx) {
        loaded.push(tx);
      },
      Mod_LoadLighting(mod) {
        mod.lightdata = null;
      },
      Mod_LoadAliasModel() {},
      Mod_LoadSpriteModel() {},
    };

    setModelLoaderHooks(hooks);
    try {
      const mod = loadWorld("maps/sky2.bsp");
      const tex0 = mod.textures?.[0];
      const tex1 = mod.textures?.[1];
      if (!tex0 || !tex1) throw new Error("expected both textures to load");
      expect(mod.numtextures).toBe(2);
      expect(loaded).toEqual([tex0, tex1]);
    } finally {
      setModelLoaderHooks(null);
    }
  });
});

describe("CalcSurfaceExtents", () => {
  test("rejects a surface wider than the extents cap unless TEX_SPECIAL", () => {
    const mod = loadWorld("maps/test.bsp");
    loadState.loadmodel = mod;

    const surf = mod.surfaces[0];
    // 64 units of extent is fine at the soft renderer's 256 cap
    expect(() => CalcSurfaceExtents(surf)).not.toThrow();
    // ... and a cap below it is not
    expect(() => CalcSurfaceExtents(surf, 32)).toThrow(SysError);
  });
});

describe("Mod_ClearAll", () => {
  // last, deliberately: it marks every mod_known entry unreferenced, which
  // makes the next Mod_ForName of any name reload the file from disk.
  test("marks every known model unreferenced", () => {
    const mod = loadWorld("maps/test.bsp");
    expect(mod.needload).toBe(NL_PRESENT);

    Mod_ClearAll();
    expect(mod.needload).toBe(NL_UNREFERENCED);

    // the entry is still found by name, and reloading restores NL_PRESENT
    const again = loadWorld("maps/test.bsp");
    expect(again).toBe(mod);
    expect(again.needload).toBe(NL_PRESENT);
  });
});
