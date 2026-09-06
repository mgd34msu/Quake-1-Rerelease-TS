// U4: BSP2/2PSB, .lit, BSPX, external .ent and external texture-wad tests
// for the shared model loader (src/common/model.ts). Not a ported C file --
// test infrastructure only, following test/model.test.ts's own conventions
// (a scratch basedir per describe group, COM_InitFilesystem/COM_CheckRegistered,
// setModelLoaderHooks(null) + setComSearchpaths(null) in every afterAll).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  COM_AddGameDirectory,
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  pop,
  setComGamedir,
  setComModified,
  setComSearchpaths,
  setStaticRegistered,
} from "../src/common/common";
import { CRC_Block } from "../src/common/crc";
import {
  Mod_ClearAll,
  Mod_ForName,
  Mod_Init,
  Mod_LoadLighting as sharedMod_LoadLighting,
  ModelT,
  TextureT,
  isMleaf,
  setModelLoaderHooks,
  type ModelLoaderHooks,
} from "../src/common/model";
import { writePakToDisk } from "./support/pak_builder";
import {
  BSP_ENTITIES,
  BSP_MIPTEX_NAME,
  BSP_MIPTEX_WIDTH,
  BSP_MIPTEX_HEIGHT,
  BSP_NUMCLIPNODES,
  BSP_NUMVERTEXES,
  BSP_WIDTH_29,
  BSP_WIDTH_2PSB,
  BSP_WIDTH_BSP2,
  buildBsp,
  buildTextureWad,
  ensureDir,
  writeGameFile,
} from "./support/bsp_builder";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

function loadWorld(name: string): ModelT {
  const mod = Mod_ForName(name, true);
  if (mod === null) throw new Error(`expected ${name} to load`);
  return mod;
}

// a minimal ModelLoaderHooks whose Mod_LoadLighting shim delegates to the
// shared function under test (softModelHooks/glModelHooks do exactly this
// -- see src/ref_soft/model.ts and src/ref_gl/gl_model.ts) so the .lit path
// runs; Mod_LoadBrushModel calls Mod_LoadLighting only when a hook is
// installed at all (this port's own deviation from the C, documented in
// src/common/model.ts's header).
function makeLitHooks(): ModelLoaderHooks {
  const notexture = new TextureT();
  notexture.name = "notexture";
  notexture.width = 16;
  notexture.height = 16;
  return {
    notexture,
    textureLoaded() {},
    Mod_LoadLighting(_mod, _buf, l) {
      sharedMod_LoadLighting(l);
    },
    Mod_LoadAliasModel() {},
    Mod_LoadSpriteModel() {},
  };
}

// plain-data snapshot of a loaded brush model, comparable across widths
// with toEqual without walking into circular parent/plane references.
function snapshotModel(mod: ModelT) {
  return {
    numplanes: mod.numplanes,
    planes: mod.planes.map((p) => ({ normal: Array.from(p.normal), dist: p.dist, type: p.type, signbits: p.signbits })),
    numvertexes: mod.numvertexes,
    vertexes: mod.vertexes.map((v) => Array.from(v.position)),
    numedges: mod.numedges,
    edges: mod.edges.slice(0, mod.numedges + 1).map((e) => [e.v[0], e.v[1]]),
    numsurfedges: mod.numsurfedges,
    surfedges: Array.from(mod.surfedges),
    numnodes: mod.numnodes,
    nodes: mod.nodes.map((n) => ({
      planenum: n.plane !== null ? mod.planes.indexOf(n.plane) : -1,
      minmaxs: Array.from(n.minmaxs),
      firstsurface: n.firstsurface,
      numsurfaces: n.numsurfaces,
      children: n.children.map((c) => {
        if (c === null) return null;
        return isMleaf(c) ? { leaf: mod.leafs.indexOf(c) } : { node: mod.nodes.indexOf(c) };
      }),
    })),
    numleafs: mod.numleafs,
    leafs: mod.leafs.map((l) => ({
      contents: l.contents,
      minmaxs: Array.from(l.minmaxs),
      firstmarksurface: l.firstmarksurface,
      nummarksurfaces: l.nummarksurfaces,
      ambient: Array.from(l.ambient_sound_level),
    })),
    numclipnodes: mod.numclipnodes,
    clipnodes: mod.clipnodes.map((c) => ({ planenum: c.planenum, children: [c.children[0], c.children[1]] })),
    nummarksurfaces: mod.nummarksurfaces,
    marksurfaces: mod.marksurfaces.map((s) => mod.surfaces.indexOf(s)),
    numsurfaces: mod.numsurfaces,
    surfaces: mod.surfaces.map((s) => ({
      firstedge: s.firstedge,
      numedges: s.numedges,
      flags: s.flags,
      lightofs: s.lightofs,
      texinfo: s.texinfo !== null ? mod.texinfo.indexOf(s.texinfo) : -1,
    })),
    hull0: mod.hulls[0].clipnodes.map((c) => ({ planenum: c.planenum, children: [c.children[0], c.children[1]] })),
  };
}

//============================================================================
// Main synthetic fixture group: one basedir, several unrelated maps.
//============================================================================

describe("BSP2/2PSB/.lit/BSPX/.ent/external-wad (synthetic fixtures)", () => {
  const scratchDir = mkdtempSync(join(scratchRoot, "model-bsp2-test-"));
  const baseDir = join(scratchDir, "quake");

  beforeAll(() => {
    ensureDir(join(baseDir, "id1"));

    // the three widths of the SAME logical level (test 1)
    writeGameFile(baseDir, "id1/maps/w29.bsp", buildBsp({ width: BSP_WIDTH_29 }));
    writeGameFile(baseDir, "id1/maps/w2psb.bsp", buildBsp({ width: BSP_WIDTH_2PSB }));
    writeGameFile(baseDir, "id1/maps/wbsp2.bsp", buildBsp({ width: BSP_WIDTH_BSP2 }));

    // capacity beyond BSP29's fields (test 2)
    writeGameFile(baseDir, "id1/maps/bigverts.bsp", buildBsp({ width: BSP_WIDTH_BSP2, extraVertexes: 66000 }));
    writeGameFile(baseDir, "id1/maps/bigclip.bsp", buildBsp({ width: BSP_WIDTH_BSP2, extraClipnodes: 33000 }));

    // .lit files (test 3): each sub-test writes its own bsp + .lit pair
    // directly (see that describe block's own header note on why).

    // BSPX directory (test 4)
    const facenormals = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const rgblighting = new Uint8Array([9, 8, 7]);
    writeGameFile(
      baseDir,
      "id1/maps/bspx.bsp",
      buildBsp({ bspxLumps: [{ name: "FACENORMALS", data: facenormals }, { name: "RGBLIGHTING", data: rgblighting }] }),
    );
    writeGameFile(baseDir, "id1/maps/nobspx.bsp", buildBsp({}));

    // external .ent (test 5)
    writeGameFile(baseDir, "id1/maps/entcrc.bsp", buildBsp({}));
    const entCrcSource = buildBsp({});
    const entLumpBytes = readEntitiesLumpText(entCrcSource);
    const crc = CRC_Block(latin1(entLumpBytes));
    const hex = crc.toString(16).padStart(4, "0");
    writeGameFile(baseDir, `id1/maps/entcrc@${hex}.ent`, latin1(`{\n"classname" "worldspawn"\n"override" "crc"\n}\n\0`));
    // a plain .ent, no crc suffix, for a different map
    writeGameFile(baseDir, "id1/maps/entplain.bsp", buildBsp({}));
    writeGameFile(baseDir, "id1/maps/entplain.ent", latin1(`{\n"classname" "worldspawn"\n"override" "plain"\n}\n\0`));
    // neither -- embedded fallback
    writeGameFile(baseDir, "id1/maps/entnone.bsp", buildBsp({}));

    // external texture wad (test 6)
    writeGameFile(baseDir, "id1/maps/extwad.bsp", buildBsp({ externalMiptex: true, wadKey: "base" }));
    writeGameFile(
      baseDir,
      "id1/gfx/base.wad",
      buildTextureWad([{ name: BSP_MIPTEX_NAME, width: BSP_MIPTEX_WIDTH, height: BSP_MIPTEX_HEIGHT, fill: 77 }]),
    );
    writeGameFile(baseDir, "id1/maps/extwad2.bsp", buildBsp({ externalMiptex: true, wadKey: "special" }));
    writeGameFile(
      baseDir,
      "id1/special.wad",
      buildTextureWad([{ name: BSP_MIPTEX_NAME, width: BSP_MIPTEX_WIDTH, height: BSP_MIPTEX_HEIGHT, fill: 42 }]),
    );
    writeGameFile(baseDir, "id1/maps/extwadmiss.bsp", buildBsp({ externalMiptex: true, wadKey: "nosuchwad" }));

    writePopPak(baseDir);

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();
    COM_CheckRegistered();
    Mod_Init();
  });

  afterAll(() => {
    setModelLoaderHooks(null);
    setComSearchpaths(null);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe("same synthetic level parsed identically from 29/2PSB/BSP2", () => {
    test("nodes, leafs, clipnodes, faces, edges, marksurfaces, hull0 all match", () => {
      const narrow = snapshotModel(loadWorld("maps/w29.bsp"));
      const psb = snapshotModel(loadWorld("maps/w2psb.bsp"));
      const bsp2 = snapshotModel(loadWorld("maps/wbsp2.bsp"));

      expect(psb).toEqual(narrow);
      expect(bsp2).toEqual(narrow);

      // and a basic sanity check that this actually exercised real content,
      // not two empty objects
      expect(narrow.numnodes).toBeGreaterThan(0);
      expect(narrow.numleafs).toBeGreaterThan(0);
      expect(narrow.numclipnodes).toBeGreaterThan(0);
      expect(narrow.numsurfaces).toBeGreaterThan(0);
    });
  });

  describe("capacity beyond BSP29's narrow fields", () => {
    test("more than 65535 vertexes loads under BSP2", () => {
      const mod = loadWorld("maps/bigverts.bsp");
      expect(mod.numvertexes).toBe(BSP_NUMVERTEXES + 66000);
      expect(mod.numvertexes).toBeGreaterThan(0xffff);
      // the real (non-padding) geometry still resolves correctly
      expect(mod.numsurfaces).toBeGreaterThan(0);
    });

    test("more than 32767 clipnodes loads under BSP2", () => {
      const mod = loadWorld("maps/bigclip.bsp");
      expect(mod.numclipnodes).toBe(BSP_NUMCLIPNODES + 33000);
      expect(mod.numclipnodes).toBeGreaterThan(0x7fff);
      // hull0 (Mod_MakeHull0, derived from the nodes, unaffected by the
      // clipnode padding) still comes out right
      expect(mod.hulls[0].clipnodes.length).toBe(mod.numnodes);
    });
  });

  describe(".lit files", () => {
    // every sub-test below uses a bsp NAME it alone ever loads: model.ts's
    // mod_known cache (Mod_FindName) returns the SAME ModelT, unreloaded, to
    // a second Mod_ForName call for a name already loaded in this describe
    // group's single Mod_Init() session -- reusing e.g. "maps/litmap.bsp"
    // for two different .lit fixtures would silently test the cache, not
    // the loader.
    test("a valid same-tier .lit is accepted alongside the classic 8-bit lump", () => {
      setModelLoaderHooks(makeLitHooks());
      try {
        const bsp = buildBsp({ lightLevel: 100 });
        writeGameFile(baseDir, "id1/maps/litgood.bsp", bsp);
        const l = bspLightingLump(bsp);
        const rgb = new Uint8Array(l.filelen * 3);
        for (let i = 0; i < l.filelen; i++) {
          rgb[i * 3] = 10;
          rgb[i * 3 + 1] = 20;
          rgb[i * 3 + 2] = 30;
        }
        writeGameFile(baseDir, "id1/maps/litgood.lit", buildLitFile(1, rgb));

        const mod = loadWorld("maps/litgood.bsp");
        expect(mod.lightdata).not.toBeNull();
        expect(mod.lightdata_rgb).not.toBeNull();
        expect(mod.lightdata_rgb?.length).toBe(l.filelen * 3);
        expect(Array.from(mod.lightdata_rgb ?? new Uint8Array(0)).slice(0, 3)).toEqual([10, 20, 30]);
        // the classic 8-bit lump is untouched -- still the ramp buildBsp wrote
        expect(mod.lightdata?.[0]).toBe(100);
      } finally {
        setModelLoaderHooks(null);
      }
    });

    test("an empty embedded lump derives 8-bit luminance from the .lit RGB data", () => {
      setModelLoaderHooks(makeLitHooks());
      try {
        writeGameFile(baseDir, "id1/maps/litderive.bsp", buildBsp({}));
        // an empty LUMP_LIGHTING (filelen 0) means the size check
        // `8 + l.filelen*3 === filesize` needs filesize === 8, i.e. this
        // .lit must carry a ZERO-length payload to be accepted here.
        writeGameFile(baseDir, "id1/maps/litderive.lit", buildLitFile(1, new Uint8Array(0)));

        const mod = loadWorld("maps/litderive.bsp");
        expect(mod.lightdata_rgb).not.toBeNull();
        expect(mod.lightdata_rgb?.length).toBe(0);
        expect(mod.lightdata).not.toBeNull();
        expect(mod.lightdata?.length).toBe(0);
      } finally {
        setModelLoaderHooks(null);
      }
    });

    test("bad magic is rejected", () => {
      setModelLoaderHooks(makeLitHooks());
      try {
        writeGameFile(baseDir, "id1/maps/litbadmagic.bsp", buildBsp({ lightLevel: 5 }));
        writeGameFile(baseDir, "id1/maps/litbadmagic.lit", latin1("XLIT\0\0\0\0"));
        const mod = loadWorld("maps/litbadmagic.bsp");
        expect(mod.lightdata_rgb).toBeNull();
        expect(mod.lightdata?.[0]).toBe(5); // classic lump still loaded fine
      } finally {
        setModelLoaderHooks(null);
      }
    });

    test("version 2 is rejected", () => {
      setModelLoaderHooks(makeLitHooks());
      try {
        writeGameFile(baseDir, "id1/maps/litver2.bsp", buildBsp({}));
        writeGameFile(baseDir, "id1/maps/litver2.lit", buildLitFile(2, new Uint8Array(0)));
        const mod = loadWorld("maps/litver2.bsp");
        expect(mod.lightdata_rgb).toBeNull();
      } finally {
        setModelLoaderHooks(null);
      }
    });

    test("wrong payload size is rejected", () => {
      setModelLoaderHooks(makeLitHooks());
      try {
        const bsp = buildBsp({ lightLevel: 9 });
        writeGameFile(baseDir, "id1/maps/litwrongsize.bsp", bsp);
        const l = bspLightingLump(bsp);
        writeGameFile(baseDir, "id1/maps/litwrongsize.lit", buildLitFile(1, new Uint8Array(l.filelen * 3 - 3)));
        const mod = loadWorld("maps/litwrongsize.bsp");
        expect(mod.lightdata_rgb).toBeNull();
        expect(mod.lightdata?.[0]).toBe(9); // classic lump still loaded fine
      } finally {
        setModelLoaderHooks(null);
      }
    });
  });

  describe("BSPX lump directory", () => {
    test("named lumps are recorded as views over the file", () => {
      const mod = loadWorld("maps/bspx.bsp");
      expect(mod.bspx.size).toBe(2);
      expect(Array.from(mod.bspx.get("FACENORMALS") ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(Array.from(mod.bspx.get("RGBLIGHTING") ?? [])).toEqual([9, 8, 7]);
    });

    test("a bsp with no BSPX directory gets an empty map", () => {
      const mod = loadWorld("maps/nobspx.bsp");
      expect(mod.bspx.size).toBe(0);
    });
  });

  describe("external .ent override", () => {
    test("a CRC-named .ent overrides the embedded entity text", () => {
      const mod = loadWorld("maps/entcrc.bsp");
      expect(mod.entities).toContain('"override" "crc"');
    });

    test("a plain .ent (no crc suffix) overrides the embedded entity text", () => {
      const mod = loadWorld("maps/entplain.bsp");
      expect(mod.entities).toContain('"override" "plain"');
    });

    test("with neither external file, the embedded lump is used", () => {
      const mod = loadWorld("maps/entnone.bsp");
      expect(mod.entities).toBe(BSP_ENTITIES);
    });
  });

  describe("external texture-wad miptex resolution", () => {
    test("resolves via gfx/<name>.wad from worldspawn's wad key", () => {
      const mod = loadWorld("maps/extwad.bsp");
      const tx = mod.textures?.[0];
      if (!tx) throw new Error("expected a texture");
      expect(tx.name).toBe(BSP_MIPTEX_NAME);
      const pixels = (BSP_MIPTEX_WIDTH * BSP_MIPTEX_HEIGHT * 85) / 64;
      expect(tx.data.length).toBe(pixels);
      expect(Array.from(tx.data).every((b) => b === 77)).toBe(true);
    });

    test("falls back to <name>.wad with no gfx/ prefix", () => {
      const mod = loadWorld("maps/extwad2.bsp");
      const tx = mod.textures?.[0];
      if (!tx) throw new Error("expected a texture");
      expect(Array.from(tx.data).every((b) => b === 42)).toBe(true);
    });

    test("an unresolvable external texture loads with zero-filled pixels instead of crashing", () => {
      const mod = loadWorld("maps/extwadmiss.bsp");
      const tx = mod.textures?.[0];
      if (!tx) throw new Error("expected a texture");
      expect(Array.from(tx.data).every((b) => b === 0)).toBe(true);
    });
  });
});

//============================================================================
// Search-path tier rule: a dedicated 3-directory filesystem, so a lower-
// priority .lit/.ent can be built and shown to be ignored.
//============================================================================

describe("search-path tier rule (Ironwail's path_id equivalent)", () => {
  const scratchDir = mkdtempSync(join(scratchRoot, "model-bsp2-tier-test-"));
  const lowDir = join(scratchDir, "lowpri");
  const id1Dir = join(scratchDir, "id1");
  const hiDir = join(scratchDir, "hipri");

  beforeAll(() => {
    ensureDir(lowDir);
    ensureDir(id1Dir);
    ensureDir(hiDir);

    // the .bsp lives in the HIGH-priority dir; a WRONG .lit/.ent for it
    // lives in the LOW-priority dir, added first (lowest priority: it ends
    // up furthest from the head of com_searchpaths).
    writeGameFile(scratchDir, "hipri/maps/tier.bsp", buildBsp({ lightLevel: 50 }));
    writeGameFile(scratchDir, "lowpri/maps/tier.lit", buildLitFile(1, new Uint8Array([1, 2, 3])));
    writeGameFile(scratchDir, "lowpri/maps/tier.ent", latin1('{\n"classname" "worldspawn"\n"override" "lowtier"\n}\n\0'));

    writePopPak(scratchDir, "id1");

    COM_InitArgv(["quake"]);
    setComGamedir("");
    setComModified(false);
    setStaticRegistered(1);
    COM_AddGameDirectory(lowDir);
    COM_AddGameDirectory(id1Dir);
    COM_AddGameDirectory(hiDir);
    COM_CheckRegistered();
    Mod_Init();
  });

  afterAll(() => {
    setModelLoaderHooks(null);
    setComSearchpaths(null);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test(".lit from a lower-priority tier than the bsp is ignored", () => {
    setModelLoaderHooks(makeLitHooks());
    try {
      const mod = loadWorld("maps/tier.bsp");
      expect(mod.lightdata_rgb).toBeNull();
      // the classic embedded lump still loaded fine
      expect(mod.lightdata?.[0]).toBe(50);
    } finally {
      setModelLoaderHooks(null);
    }
  });

  test(".ent from a lower-priority tier than the bsp is ignored", () => {
    const mod = loadWorld("maps/tier.bsp");
    expect(mod.entities).not.toContain("lowtier");
    expect(mod.entities).toBe(BSP_ENTITIES);
  });
});

//============================================================================
// Retail rerelease data (skipped entirely when absent, e.g. on CI).
//============================================================================

const RERELEASE_DIR = process.env.Q1TS_RERELEASE ?? "/home/buzzkill/Projects/qfiles/q1/rerelease";
const HAVE_RERELEASE = existsSync(join(RERELEASE_DIR, "id1", "pak0.pak"));

describe.skipIf(!HAVE_RERELEASE)("retail rerelease maps (Mod_ForName, hook-less dedicated path)", () => {
  afterAll(() => {
    setModelLoaderHooks(null);
    setComSearchpaths(null);
    Mod_ClearAll();
  });

  function loadFromGame(game: string, mapName: string): ModelT {
    setComSearchpaths(null);
    COM_InitArgv(["quake", "-basedir", RERELEASE_DIR, "-game", game]);
    setComModified(false);
    COM_InitFilesystem();
    COM_CheckRegistered();
    Mod_Init();
    return loadWorld(mapName);
  }

  test("mg1's mge1m1.bsp (BSP2) loads with sane counts", () => {
    const mod = loadFromGame("mg1", "maps/mge1m1.bsp");
    expect(mod.numvertexes).toBeGreaterThan(0);
    expect(mod.numsurfaces).toBeGreaterThan(0);
    expect(mod.numleafs).toBeGreaterThan(0);
    expect(mod.numclipnodes).toBeGreaterThan(0);
  });

  test("dopa's e5m1.bsp (BSP2) loads with sane counts", () => {
    const mod = loadFromGame("dopa", "maps/e5m1.bsp");
    expect(mod.numvertexes).toBeGreaterThan(0);
    expect(mod.numsurfaces).toBeGreaterThan(0);
    expect(mod.numleafs).toBeGreaterThan(0);
  });

  test("mg3's map1.bsp (BSP2 + BSPX FACENORMALS) loads with sane counts and a recorded FACENORMALS lump", () => {
    const mod = loadFromGame("mg3", "maps/map1.bsp");
    expect(mod.numvertexes).toBeGreaterThan(0);
    expect(mod.numsurfaces).toBeGreaterThan(0);
    expect(mod.bspx.has("FACENORMALS")).toBe(true);
    expect((mod.bspx.get("FACENORMALS") ?? new Uint8Array(0)).length).toBeGreaterThan(0);
  });
});

//============================================================================
// small local helpers
//============================================================================

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

// re-derives the raw entities lump TEXT (without the trailing NUL byte
// buildBsp appends) from a built bsp buffer, for computing the same CRC
// src/common/model.ts's Mod_LoadEntities does.
function readEntitiesLumpText(bsp: Uint8Array): string {
  const view = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  const fileofs = view.getInt32(4, true); // LUMP_ENTITIES is header lump 0
  const filelen = view.getInt32(8, true);
  let s = "";
  for (let i = 0; i < filelen - 1; i++) s += String.fromCharCode(bsp[fileofs + i]);
  return s;
}

function bspLightingLump(bsp: Uint8Array): { fileofs: number; filelen: number } {
  const LUMP_LIGHTING = 8;
  const view = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  return {
    fileofs: view.getInt32(4 + LUMP_LIGHTING * 8, true),
    filelen: view.getInt32(4 + LUMP_LIGHTING * 8 + 4, true),
  };
}

// a well-formed .lit file: "QLIT" magic, the given version, then the raw
// RGB payload bytes.
function buildLitFile(version: number, rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + rgb.length);
  const view = new DataView(out.buffer);
  out[0] = 0x51; // 'Q'
  out[1] = 0x4c; // 'L'
  out[2] = 0x49; // 'I'
  out[3] = 0x54; // 'T'
  view.setInt32(4, version, true);
  out.set(rgb, 8);
  return out;
}

// the registered-version check's 128 big-endian shorts, packed into a
// gfx/pop.lmp inside a pak0.pak -- identical recipe to test/model.test.ts's
// own beforeAll (it must sit in a pak: COM_FindFile only searches loose
// directories for a path with a slash once static_registered is true, so a
// loose pop.lmp would never be found on the FIRST check that sets it).
function writePopPak(baseDir: string, gamedir = "id1"): void {
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, gamedir, "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);
}
