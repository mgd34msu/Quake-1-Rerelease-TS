// Self-sufficient tests for src/ref_soft/model.ts (the software renderer's
// half of model.c/r_main.c's R_InitTextures, unit U061).
//
// src/ref_soft/model.ts statically imports `R_InitSky` from "./r_sky"
// (r_sky.c, U064, concurrent with this unit). r_sky.ts had not landed on
// disk when this unit started -- ES module imports resolve eagerly, so
// every import of anything from src/ref_soft/model.ts would have failed the
// module graph with "Cannot find module './r_sky'" before a single test
// below could run, the accepted absent-sibling failure this unit's brief
// rules on (see keys.test.ts for the repo's established precedent of writing
// tests against a ruled contract before a concurrent sibling lands). Logic
// was verified in the interim by temporarily replacing the import in
// src/ref_soft/model.ts with a local no-op function (never a file at
// ./r_sky, per standing order 12), running the suite, then restoring the
// real import before finishing -- see this unit's report for the tsc/bun
// test tails from both states. r_sky.ts landed mid-session and all tests
// below now run and pass against the real import.
//
// Most tests below call the exported hook functions directly (textureLoaded,
// Mod_LoadAliasModel, Mod_LoadSpriteModel, and the Mod_LoadAlias*/Mod_LoadSprite*
// helpers, plus src/common/model.ts's now-shared Mod_LoadTextures) against
// hand-built buffers, bypassing Mod_ForName/COM_LoadStackFile entirely --
// self-sufficient and independent of any filesystem/pak fixture.
// One integration describe block ("Mod_ForName integration") additionally
// drives softModelHooks through the real Mod_ForName path with a synthetic
// BSP and the pak/pop.lmp fixture, following test/model.test.ts's own
// convention, to prove the hooks plug into the shared loader end-to-end.
//
// Test-only Cmd_AddCommand names are not used by this file (no commands are
// registered here).

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SysError } from "../src/platform/sys";
import { AliasframetypeT, AliasskintypeT } from "../src/common/modelgen";
import { LumpT } from "../src/common/bspfile";
import {
  ModelT,
  ModtypeT,
  loadState,
  Mod_ClearAll,
  Mod_ForName,
  Mod_Init,
  Mod_LoadTexinfo,
  Mod_LoadTextures,
  setModelLoaderHooks,
} from "../src/common/model";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { rState } from "../src/ref_soft/r_local";
import {
  AliashdrT,
  MaliasgroupT,
  MaliasskingroupT,
  MspriteT,
  MspriteframeT,
  MspritegroupT,
} from "../src/ref_soft/model_types";
import {
  Mod_LoadAliasGroup,
  Mod_LoadAliasModel,
  Mod_LoadAliasSkin,
  Mod_LoadAliasSkinGroup,
  Mod_LoadSpriteGroup,
  Mod_LoadSpriteModel,
  R_InitTextures,
  notexture,
  softModelHooks,
  textureLoaded,
} from "../src/ref_soft/model";
import * as rSky from "../src/ref_soft/r_sky";
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
// but supporting several miptexs (needed for the animation tests) and a
// missing (dataofs == -1) entry.
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

// texinfo_t: vecs[2][4] float, miptex int, flags int (40 bytes)
function buildTexinfoLump(miptex: number, flags = 0): Uint8Array {
  const w = new Writer(40);
  w.f32(1);
  w.f32(0);
  w.f32(0);
  w.f32(0);
  w.f32(0);
  w.f32(1);
  w.f32(0);
  w.f32(0);
  w.i32(miptex);
  w.i32(flags);
  return w.bytes;
}

// daliasgroup_t (numframes int, bboxmin/bboxmax trivertx) + numframes
// daliasinterval_t floats + numframes (daliasframe_t + numv trivertx)
function buildAliasGroupBuffer(numv: number, intervals: number[], names: string[]): Uint8Array {
  const numframes = names.length;
  const frameSize = 24 + numv * 4;
  const w = new Writer(12 + numframes * 4 + numframes * frameSize);
  w.i32(numframes);
  w.u8(0);
  w.u8(0);
  w.u8(0);
  w.u8(0);
  w.u8(255);
  w.u8(255);
  w.u8(255);
  w.u8(0);
  for (const iv of intervals) w.f32(iv);
  for (const name of names) {
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(0);
    w.u8(255);
    w.u8(255);
    w.u8(255);
    w.u8(0);
    w.chars(name, 16);
    for (let v = 0; v < numv; v++) {
      w.u8(v);
      w.u8(v);
      w.u8(v);
      w.u8(0);
    }
  }
  return w.bytes;
}

// daliasskingroup_t (numskins int) + numskins daliasskininterval_t floats +
// numskins raw skin pixel blocks of `skinsize` bytes each
function buildAliasSkinGroupBuffer(skinsize: number, intervals: number[]): Uint8Array {
  const numskins = intervals.length;
  const w = new Writer(4 + numskins * 4 + numskins * skinsize);
  w.i32(numskins);
  for (const iv of intervals) w.f32(iv);
  for (let s = 0; s < numskins; s++) for (let i = 0; i < skinsize; i++) w.u8((s * 16 + i) & 0xff);
  return w.bytes;
}

// dspritegroup_t (numframes int) + numframes dspriteinterval_t floats +
// numframes (dspriteframe_t + pixels)
function buildSpriteGroupBuffer(frames: Array<{ width: number; height: number }>, intervals: number[]): Uint8Array {
  const numframes = frames.length;
  let bodySize = 0;
  for (const f of frames) bodySize += 16 + f.width * f.height;
  const w = new Writer(4 + numframes * 4 + bodySize);
  w.i32(numframes);
  for (const iv of intervals) w.f32(iv);
  for (const f of frames) {
    w.i32(-(f.width >> 1));
    w.i32(f.height >> 1);
    w.i32(f.width);
    w.i32(f.height);
    for (let i = 0; i < f.width * f.height; i++) w.u8(i & 0xff);
  }
  return w.bytes;
}

// --- fixture (Mod_ForName integration only) --------------------------------

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-model-test-"));
const baseDir = join(scratchDir, "quake");

let initSkySpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/test.bsp", buildBsp());

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

  // r_sky.c's R_InitSky reads a 256x128 layout out of tx.data; the small
  // synthetic textures below don't carry real sky pixels, so this spy
  // verifies textureLoaded's branch selection without exercising R_InitSky's
  // own pixel copy.
  initSkySpy = spyOn(rSky, "R_InitSky").mockImplementation(() => {});
});

afterEach(() => {
  initSkySpy.mockClear();
});

afterAll(() => {
  setModelLoaderHooks(null);
  loadState.loadmodel = null;
  loadState.mod_base = null;
  loadState.loadname = "";
  rState.r_pixbytes = 1;
  Mod_ClearAll();
  rmSync(scratchDir, { recursive: true, force: true });
  initSkySpy.mockRestore();
});

//============================================================================

// Mod_LoadTextures itself is src/common/model.ts's now (shared with the GL
// renderer and the dedicated server -- fixing the dedicated server's "Bad
// surface extents" crash, see that file's header); these tests drive it
// directly with `null` since none of them depend on the per-texture step.
// The per-texture step itself (`textureLoaded`, this renderer's own code) is
// covered by its own describe block below.
describe("Mod_LoadTextures (direct)", () => {
  test("loads four mips whose byte counts are w*h + w*h/4 + w*h/16 + w*h/64", () => {
    const bytes = buildTexturesLump([{ name: "bsptest", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";

    Mod_LoadTextures(mod, bytes, lumpOf(bytes), null);

    expect(mod.numtextures).toBe(1);
    const tx = mod.textures?.[0];
    if (!tx) throw new Error("expected a loaded texture");

    expect(tx.name).toBe("bsptest");
    expect(tx.width).toBe(16);
    expect(tx.height).toBe(16);
    expect(tx.data.length).toBe(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2);

    expect(tx.offsets[0]).toBe(0);
    expect(tx.offsets[1] - tx.offsets[0]).toBe(16 * 16);
    expect(tx.offsets[2] - tx.offsets[1]).toBe(8 * 8);
    expect(tx.offsets[3] - tx.offsets[2]).toBe(4 * 4);
    expect(tx.data.length - tx.offsets[3]).toBe(2 * 2);

    for (let i = 0; i < 16 * 16; i++) expect(tx.data[tx.offsets[0] + i]).toBe(i & 0xff);
  });

  test("a non-16-aligned texture is a Sys_Error", () => {
    const bytes = buildTexturesLump([{ name: "odd", width: 15, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadTextures(mod, bytes, lumpOf(bytes), null)).toThrow(SysError);
  });

  test("an empty lump leaves mod.textures null", () => {
    const mod = new ModelT();
    const l = new LumpT();
    l.fileofs = 0;
    l.filelen = 0;
    Mod_LoadTextures(mod, new Uint8Array(0), l, null);
    expect(mod.textures).toBeNull();
    expect(mod.numtextures).toBe(0);
  });

  test("a missing miptex (dataofs -1) leaves a null slot, and Mod_LoadTexinfo substitutes notexture", () => {
    const texBytes = buildTexturesLump([{ name: "gone", width: 16, height: 16, missing: true }]);
    const mod = new ModelT();
    loadState.loadname = "test";
    Mod_LoadTextures(mod, texBytes, lumpOf(texBytes), null);
    expect(mod.textures?.[0]).toBeNull();

    setModelLoaderHooks(softModelHooks);
    try {
      const tiBytes = buildTexinfoLump(0);
      loadState.loadmodel = mod;
      loadState.mod_base = tiBytes;
      Mod_LoadTexinfo(lumpOf(tiBytes));

      expect(mod.texinfo[0].texture).toBe(softModelHooks.notexture);
      expect(mod.texinfo[0].flags).toBe(0);
    } finally {
      setModelLoaderHooks(null);
    }
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
    Mod_LoadTextures(mod, bytes, lumpOf(bytes), null);

    const tx0 = mod.textures?.[0];
    const tx1 = mod.textures?.[1];
    if (!tx0 || !tx1) throw new Error("expected both animation frames");

    expect(tx0.anim_total).toBe(4); // max(2) * ANIM_CYCLE(2)
    expect(tx0.anim_min).toBe(0);
    expect(tx0.anim_max).toBe(2);
    expect(tx0.anim_next).toBe(tx1);

    expect(tx1.anim_total).toBe(4);
    expect(tx1.anim_min).toBe(2);
    expect(tx1.anim_max).toBe(4);
    expect(tx1.anim_next).toBe(tx0); // cyclic: (j+1) % max wraps to frame 0
  });

  test("a missing animation frame is a Sys_Error naming it", () => {
    // "+2wall" implies frames 0, 1 and 2 must all exist; only 2 is present.
    const bytes = buildTexturesLump([{ name: "+2wall", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";

    let caught: unknown = null;
    try {
      Mod_LoadTextures(mod, bytes, lumpOf(bytes), null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SysError);
    expect(caught instanceof Error ? caught.message : "").toBe("Missing frame 0 of +2wall");
  });
});

describe("textureLoaded (per-texture step)", () => {
  test("a sky-named texture calls R_InitSky", () => {
    const bytes = buildTexturesLump([{ name: "sky1", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";
    Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded);

    const tx = mod.textures?.[0];
    if (!tx) throw new Error("expected a loaded texture");
    expect(rSky.R_InitSky).toHaveBeenCalledTimes(1);
    expect(rSky.R_InitSky).toHaveBeenCalledWith(tx);
  });

  test("a non-sky texture does not call R_InitSky", () => {
    const bytes = buildTexturesLump([{ name: "bsptest", width: 16, height: 16 }]);
    const mod = new ModelT();
    loadState.loadname = "test";
    Mod_LoadTextures(mod, bytes, lumpOf(bytes), textureLoaded);

    expect(rSky.R_InitSky).not.toHaveBeenCalled();
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

  test("softModelHooks.notexture is the module-load-time checkerboard singleton", () => {
    expect(softModelHooks.notexture).toBe(notexture);
    expect(notexture.width).toBe(16);
    expect(notexture.height).toBe(16);
    expect(notexture.data.length).toBe(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2);
    // spot-check the same mip-0 pattern at a couple of points
    expect(notexture.data[0]).toBe(0xff); // (0<8) === (0<8)
    expect(notexture.data[8]).toBe(0); // x=8: (0<8) !== (8<8)
  });
});

describe("Mod_LoadAliasModel (direct)", () => {
  test("loads numverts/numtris/named frames/skin pixels, and +-16 mins/maxs", () => {
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

    expect(hdr.model?.numverts).toBe(3);
    expect(hdr.model?.numtris).toBe(1);
    expect(hdr.model?.numframes).toBe(2);
    expect(hdr.model?.skinwidth).toBe(4);
    expect(hdr.model?.skinheight).toBe(4);

    expect(hdr.frames.length).toBe(2);
    expect(hdr.frames[0].type).toBe(AliasframetypeT.ALIAS_SINGLE);
    expect(hdr.frames[0].name).toBe("frame0");
    expect(hdr.frames[1].name).toBe("frame1");

    const frame0 = hdr.frames[0].frame;
    if (!Array.isArray(frame0)) throw new Error("expected an ALIAS_SINGLE trivertx array");
    expect(frame0.length).toBe(3);
    for (let v = 0; v < 3; v++) {
      expect(Array.from(frame0[v].v)).toEqual([v, v, v]);
      expect(frame0[v].lightnormalindex).toBe(0);
    }

    expect(hdr.triangles.length).toBe(1);
    expect(hdr.triangles[0].facesfront).toBe(1);
    expect(Array.from(hdr.triangles[0].vertindex)).toEqual([0, 1, 2]);

    expect(hdr.stverts.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(hdr.stverts[i].onseam).toBe(0);
      expect(hdr.stverts[i].s).toBe(i << 16);
      expect(hdr.stverts[i].t).toBe(i << 16);
    }

    expect(hdr.skindesc.length).toBe(1);
    expect(hdr.skindesc[0].type).toBe(AliasskintypeT.ALIAS_SKIN_SINGLE);
    const skin = hdr.skindesc[0].skin;
    if (!(skin instanceof Uint8Array)) throw new Error("expected ALIAS_SKIN_SINGLE pixel bytes");
    expect(skin.length).toBe(16); // 4x4
    for (let i = 0; i < 16; i++) expect(skin[i]).toBe(i & 0xff);
  });

  test("a wrong alias version is a Sys_Error", () => {
    const buffer = buildMdl({ version: 5 });
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadAliasModel(mod, buffer)).toThrow(SysError);
  });
});

describe("Mod_LoadSpriteModel (direct)", () => {
  test("loads MspriteT with up/down/left/right and mins/maxs from width/height", () => {
    const buffer = buildSpr({ numframes: 2, width: 32, height: 64 });
    const mod = new ModelT();
    loadState.loadname = "test";

    Mod_LoadSpriteModel(mod, buffer);

    expect(mod.type).toBe(ModtypeT.mod_sprite);
    expect(mod.numframes).toBe(2);
    expect(Array.from(mod.mins)).toEqual([-16, -16, -32]);
    expect(Array.from(mod.maxs)).toEqual([16, 16, 32]);

    const spr = mod.cache.data;
    if (!(spr instanceof MspriteT)) throw new Error("expected an MspriteT in mod.cache.data");

    expect(spr.numframes).toBe(2);
    expect(spr.frames.length).toBe(2);

    const f0 = spr.frames[0].frameptr;
    if (!(f0 instanceof MspriteframeT)) throw new Error("expected an SPR_SINGLE frame");
    expect(f0.width).toBe(32);
    expect(f0.height).toBe(64);
    expect(f0.up).toBe(32); // origin[1] = height>>1
    expect(f0.down).toBe(32 - 64);
    expect(f0.left).toBe(-16); // origin[0] = -(width>>1)
    expect(f0.right).toBe(32 - 16);
    expect(f0.pixels.length).toBe(32 * 64);
    for (let i = 0; i < 32 * 64; i++) expect(f0.pixels[i]).toBe(i & 0xff);
  });

  test("a wrong sprite version is a Sys_Error", () => {
    const buffer = buildSpr({ version: 2 });
    const mod = new ModelT();
    loadState.loadname = "test";
    expect(() => Mod_LoadSpriteModel(mod, buffer)).toThrow(SysError);
  });
});

describe("group helpers (direct)", () => {
  test("Mod_LoadAliasGroup builds a MaliasgroupT and the outer name is the LAST subframe's (C's overwrite quirk)", () => {
    const buffer = buildAliasGroupBuffer(2, [0.5, 0.25], ["first", "second"]);
    loadState.loadname = "test";

    const r = Mod_LoadAliasGroup(buffer, 0, 2);

    expect(r.group).toBeInstanceOf(MaliasgroupT);
    expect(r.group.numframes).toBe(2);
    expect(Array.from(r.group.intervals)).toEqual([0.5, 0.25]);
    expect(r.group.frames.length).toBe(2);
    expect(r.group.frames[0].frame.length).toBe(2);
    expect(r.name).toBe("second"); // last subframe's name, per the header note
    expect(r.next).toBe(buffer.length);
  });

  test("Mod_LoadAliasGroup with interval<=0 is a Sys_Error", () => {
    const buffer = buildAliasGroupBuffer(1, [0.1, 0], ["a", "b"]);
    loadState.loadname = "test";
    expect(() => Mod_LoadAliasGroup(buffer, 0, 1)).toThrow(SysError);
  });

  test("Mod_LoadAliasSkinGroup builds a MaliasskingroupT with skin pixels intact", () => {
    const buffer = buildAliasSkinGroupBuffer(4, [0.5, 0.25]);
    loadState.loadname = "test";

    const r = Mod_LoadAliasSkinGroup(buffer, 0, 4);

    expect(r.group).toBeInstanceOf(MaliasskingroupT);
    expect(r.group.numskins).toBe(2);
    expect(Array.from(r.group.intervals)).toEqual([0.5, 0.25]);
    expect(r.group.skindescs.length).toBe(2);
    expect(r.group.skindescs[0].type).toBe(AliasskintypeT.ALIAS_SKIN_SINGLE);
    const skin1 = r.group.skindescs[1].skin;
    if (!(skin1 instanceof Uint8Array)) throw new Error("expected pixel bytes");
    expect(Array.from(skin1)).toEqual([16, 17, 18, 19]);
    expect(r.next).toBe(buffer.length);
  });

  test("Mod_LoadAliasSkinGroup with interval<=0 is a Sys_Error", () => {
    const buffer = buildAliasSkinGroupBuffer(2, [-1]);
    loadState.loadname = "test";
    expect(() => Mod_LoadAliasSkinGroup(buffer, 0, 2)).toThrow(SysError);
  });

  test("Mod_LoadSpriteGroup builds an MspritegroupT with per-frame pixels intact", () => {
    const buffer = buildSpriteGroupBuffer(
      [
        { width: 4, height: 4 },
        { width: 2, height: 2 },
      ],
      [0.5, 0.25],
    );
    loadState.loadname = "test";

    const r = Mod_LoadSpriteGroup(buffer, 0);

    expect(r.group).toBeInstanceOf(MspritegroupT);
    expect(r.group.numframes).toBe(2);
    expect(Array.from(r.group.intervals)).toEqual([0.5, 0.25]);
    expect(r.group.frames.length).toBe(2);
    expect(r.group.frames[0].width).toBe(4);
    expect(r.group.frames[1].width).toBe(2);
    expect(Array.from(r.group.frames[1].pixels)).toEqual([0, 1, 2, 3]);
    expect(r.next).toBe(buffer.length);
  });

  test("Mod_LoadAliasSkin at r_pixbytes 2 packs through d_8to16table into the same Uint8Array", () => {
    const saved = rState.r_pixbytes;
    rState.r_pixbytes = 2;
    try {
      loadState.loadname = "test";
      const pixels = new Uint8Array([1, 2, 3, 4]);
      const r = Mod_LoadAliasSkin(pixels, 0, 4);
      expect(r.skin.length).toBe(8); // 4 pixels * 2 bytes
      const dv = new DataView(r.skin.buffer, r.skin.byteOffset, r.skin.byteLength);
      for (let i = 0; i < 4; i++) {
        expect(dv.getUint16(i * 2, true)).toBe(0); // this session's d_8to16table is unpopulated (zero-filled)
      }
    } finally {
      rState.r_pixbytes = saved;
    }
  });
});

describe("Mod_ForName integration", () => {
  test("softModelHooks plugs into the shared Mod_LoadBrushModel loader end-to-end", () => {
    setModelLoaderHooks(softModelHooks);
    try {
      const mod = Mod_ForName("maps/test.bsp", true);
      if (mod === null) throw new Error("expected maps/test.bsp to load");

      expect(mod.numtextures).toBe(1);
      const tx = mod.textures?.[0];
      if (!tx) throw new Error("expected the map's texture to load");
      expect(tx.name).toBe("bsptest");
      expect(tx.data.length).toBe(16 * 16 + 8 * 8 + 4 * 4 + 2 * 2);

      // Mod_LoadTexinfo (shared) resolved the miptex through this hook's array
      expect(mod.texinfo[0].texture).toBe(tx);
    } finally {
      setModelLoaderHooks(null);
    }
  });
});
