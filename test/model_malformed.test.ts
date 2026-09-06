// F16: a .bsp that is present but not loadable -- the zero-byte file a
// failed client download leaves behind, a cut-short copy, a version this
// engine does not read, a header whose lumps point past the end -- is
// refused by name at the map load instead of faulting inside a lump reader.
// Before this, an empty maps/dm2.bsp reached Mod_LoadModel's `view.getInt32(0)`
// and the whole process died on "Out of bounds access", naming neither the
// file nor the problem.
//
// Two halves: Mod_BrushModelProblem over buffers (no filesystem, no globals),
// then Mod_ForName over a real scratch basedir for the two answers its
// callers actually take -- `crash` false returns null the way a missing file
// does (which is how both SV_SpawnServers refuse a level and stay up), and
// `crash` true keeps the C's fatal abort, now carrying the file name and the
// reason. The filesystem half follows test/model_limits.test.ts's fixture
// recipe.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { SysError } from "../src/platform/sys";
import { Mod_BrushModelProblem, Mod_ClearAll, Mod_ForName, Mod_Init } from "../src/common/model";
import { DHEADER_T_SIZE, LUMP_MODELS, LUMP_VERTEXES, LUMP_T_SIZE, DVERTEX_T_SIZE } from "../src/common/bspfile";
import { BSP_WIDTH_2PSB, BSP_WIDTH_BSP2, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "model-malformed-test-"));
const baseDir = join(scratchDir, "quake");

const GOOD = buildBsp();

function copy(bsp: Uint8Array): Uint8Array {
  return new Uint8Array(bsp);
}

function lumpField(bsp: Uint8Array, lump: number, field: 0 | 1, value: number): Uint8Array {
  const out = copy(bsp);
  new DataView(out.buffer).setInt32(4 + lump * LUMP_T_SIZE + field * 4, value, true);
  return out;
}

function version(bsp: Uint8Array, value: number): Uint8Array {
  const out = copy(bsp);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

// The four shapes of the brief, plus the two a truncated download actually
// produces (a file cut mid-lump, and a lump length no longer a whole number
// of structures).
const FUNNY_VERTEXES = DVERTEX_T_SIZE * 3 - 1;

const MALFORMED: ReadonlyArray<readonly [string, Uint8Array, RegExp]> = [
  ["empty", new Uint8Array(0), /^is empty$/],
  ["shorthdr", GOOD.subarray(0, 12), /^is too short for a 124 byte header$/],
  ["badversion", version(GOOD, 30), /^has unsupported version number \(30\)$/],
  ["lumprange", lumpField(GOOD, LUMP_MODELS, 0, GOOD.length), /^has lump 14 out of range \(offset \d+, length \d+, past the end of the file\)$/],
  ["truncated", GOOD.subarray(0, GOOD.length - 64), /^has lump \d+ out of range \(offset \d+, length \d+, past the end of the file\)$/],
  [
    "funnysize",
    lumpField(GOOD, LUMP_VERTEXES, 1, FUNNY_VERTEXES),
    new RegExp(`^has a funny lump size in lump ${LUMP_VERTEXES} \\(${FUNNY_VERTEXES} bytes is not a multiple of ${DVERTEX_T_SIZE}\\)$`),
  ],
];

afterAll(() => {
  // Every model this suite named is left marked for reload rather than
  // holding a scratch tree that is about to be deleted.
  Mod_ClearAll();
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/good.bsp", GOOD);
  for (const [name, bsp] of MALFORMED) writeGameFile(baseDir, `id1/maps/${name}.bsp`, bsp);

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

describe("Mod_BrushModelProblem names what is wrong with a file", () => {
  for (const [name, bsp, reason] of MALFORMED) {
    test(`${name} is refused: ${reason.source}`, () => {
      const problem = Mod_BrushModelProblem(bsp);
      if (problem === null) throw new Error(`expected ${name} to be refused`);
      expect(problem).toMatch(reason);
    });
  }

  test("a zero-byte file, which COM_LoadFile hands over as its single terminating zero, is empty", () => {
    expect(Mod_BrushModelProblem(new Uint8Array(1))).toBe("is empty");
  });

  test("a header exactly one byte short of dheader_t is too short, a full one is not", () => {
    expect(Mod_BrushModelProblem(GOOD.subarray(0, DHEADER_T_SIZE - 1))).toBe("is too short for a 124 byte header");
    expect(Mod_BrushModelProblem(GOOD.subarray(0, DHEADER_T_SIZE))).toMatch(/^has lump/);
  });

  test("a negative lump offset or length is out of range, not a huge unsigned one", () => {
    expect(Mod_BrushModelProblem(lumpField(GOOD, LUMP_MODELS, 0, -1))).toMatch(/^has lump 14 out of range/);
    expect(Mod_BrushModelProblem(lumpField(GOOD, LUMP_MODELS, 1, -1))).toMatch(/^has lump 14 out of range/);
  });

  test("every width a real map ships in is accepted", () => {
    expect(Mod_BrushModelProblem(GOOD)).toBeNull();
    expect(Mod_BrushModelProblem(buildBsp({ width: BSP_WIDTH_2PSB }))).toBeNull();
    expect(Mod_BrushModelProblem(buildBsp({ width: BSP_WIDTH_BSP2 }))).toBeNull();
  });

  test("the loaded image's trailing zero byte does not make a whole file look out of range", () => {
    const padded = new Uint8Array(GOOD.length + 1);
    padded.set(GOOD);
    expect(Mod_BrushModelProblem(padded)).toBeNull();
  });
});

describe("Mod_ForName with crash=false: a malformed map is a map that is not there", () => {
  for (const [name] of MALFORMED) {
    test(`maps/${name}.bsp returns null instead of aborting`, () => {
      expect(Mod_ForName(`maps/${name}.bsp`, false)).toBeNull();
    });
  }

  test("and a missing file still returns null the same way", () => {
    expect(Mod_ForName("maps/nosuchmap.bsp", false)).toBeNull();
  });

  test("a good map still loads", () => {
    const mod = Mod_ForName("maps/good.bsp", true);
    if (mod === null) throw new Error("expected maps/good.bsp to load");
    expect(mod.name).toBe("maps/good.bsp");
    expect(mod.numsubmodels).toBeGreaterThan(0);
  });
});

describe("Mod_ForName with crash=true: the abort names the file and the reason", () => {
  for (const [name, , reason] of MALFORMED) {
    test(`maps/${name}.bsp aborts with Mod_LoadBrushModel: maps/${name}.bsp ...`, () => {
      let thrown: unknown = null;
      try {
        Mod_ForName(`maps/${name}.bsp`, true);
      } catch (e) {
        thrown = e;
      }
      if (!(thrown instanceof SysError)) throw new Error(`expected a SysError for maps/${name}.bsp`);
      expect(thrown.message).toMatch(new RegExp(`^Mod_LoadBrushModel: maps/${name}\\.bsp ${reason.source.replace(/^\^|\$$/g, "")}$`));
    });
  }
});
