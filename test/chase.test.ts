// Self-sufficient test for src/client/chase.ts (WinQuake chase.c).
//
// Builds the same synthetic BSP test/world.test.ts and test/sv_user.test.ts
// use (test/support/bsp_builder.ts's buildBsp(): an infinite flat floor --
// plane 0 is z=0 facing up, the front (z>0) side is the empty leaf, the back
// (z<0) side is the solid leaf) and points cl.worldmodel at it, since
// chase.ts's TraceLine traces against cl.worldmodel.hulls[0] directly (see
// chase.ts's own file header for why that call passes the literal 0, not
// hull.firstclipnode). This is the only client-side dependency chase.ts has
// -- unlike cl_main.ts, none of its imports reach an unlanded sibling unit,
// so this whole file can run today.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop, setStaticRegistered, static_registered } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { AngleVectors, DotProduct, M_PI, VectorMA, VectorSubtract, vec3 } from "../src/common/mathlib";
import { PITCH } from "../src/common/quakedef";
import { hostClientHooks } from "../src/common/host";
import { cl } from "../src/client/client";
import { r_refdef } from "../src/client/render";
import { Chase_Init, Chase_Update, TraceLine, chase_back, chase_dest, chase_up } from "../src/client/chase";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "chase-test-"));
const baseDir = join(scratchDir, "quake");

let mod: ModelT;

// static_registered (src/common/common.ts) is sticky module state: this
// suite's COM_CheckRegistered() call below sets it from the fixture's
// gfx/pop.lmp, and nothing else in this process resets it afterward
// (rule 15), so save/restore it around the suite ourselves.
const savedStaticRegistered = static_registered;

afterAll(() => {
  setStaticRegistered(savedStaticRegistered);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // gfx/pop.lmp inside id1/pak0.pak, exactly as test/world.test.ts does: the
  // registered-version check must pass before COM_FindFile will search a
  // loose "maps/world.bsp" path at all.
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

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  mod = loaded;

  cl.worldmodel = mod;

  Chase_Init(); // registers chase_back/chase_up/chase_right/chase_active at their C defaults (100/16/0/0)
});

describe("hostClientHooks.chaseInit", () => {
  test("chase.ts registers Chase_Init at module load (host.c's Host_Init is chase.c's only caller)", () => {
    expect(hostClientHooks.chaseInit).toBe(Chase_Init);
  });
});

describe("TraceLine", () => {
  test("a ray that crosses the floor plane stops within DIST_EPSILON of z=0, on the near (empty) side", () => {
    const start = vec3(0, 0, 100);
    const forward = vec3(Math.SQRT1_2, 0, -Math.SQRT1_2); // 45 degrees down, +X
    const end = vec3();
    VectorMA(start, 4096, forward, end);

    const impact = vec3();
    TraceLine(start, end, impact);

    // the crosspoint sits a hair (1/32 unit) to the near/empty side of the
    // plane, not exactly on it -- see src/server/world.ts's DIST_EPSILON.
    expect(impact[2]).toBeGreaterThan(-0.1);
    expect(impact[2]).toBeLessThan(0.1);
    // and it is nowhere near (0,0,0) -- the ray actually crossed, it did not
    // just fail to hit anything (see the next test for that case).
    expect(impact[0]).toBeGreaterThan(50);
  });

  test("a ray that never reaches the solid half comes back (0,0,0) -- the documented memset-only bug", () => {
    const start = vec3(0, 0, 100);
    const end = vec3(4096, 0, 100); // level: stays in the empty leaf (z>0) the whole way

    const impact = vec3(1, 2, 3); // pre-poisoned, to prove TraceLine actually wrote zeros
    TraceLine(start, end, impact);

    expect(impact[0]).toBe(0);
    expect(impact[1]).toBe(0);
    expect(impact[2]).toBe(0);
  });
});

describe("Chase_Update", () => {
  test("moves r_refdef.vieworg chase_back behind / chase_up above the eye point, level view", () => {
    cl.viewangles[0] = 0; // PITCH
    cl.viewangles[1] = 0; // YAW
    cl.viewangles[2] = 0; // ROLL
    r_refdef.vieworg[0] = 0;
    r_refdef.vieworg[1] = 0;
    r_refdef.vieworg[2] = 100;

    Chase_Update();

    // level view: AngleVectors gives forward=(1,0,0), right=(0,-1,0).
    // chase_right is 0 by default, so only chase_back/chase_up show up.
    expect(r_refdef.vieworg[0]).toBeCloseTo(-chase_back.value, 2);
    expect(r_refdef.vieworg[1]).toBeCloseTo(0, 2);
    expect(r_refdef.vieworg[2]).toBeCloseTo(100 + chase_up.value, 2);
    expect(chase_dest[0]).toBeCloseTo(r_refdef.vieworg[0], 5);
    expect(chase_dest[1]).toBeCloseTo(r_refdef.vieworg[1], 5);
    expect(chase_dest[2]).toBeCloseTo(r_refdef.vieworg[2], 5);
  });

  test("looking down at the floor: camera still goes behind/above, and PITCH is driven by a look-target trace that stops at the solid half", () => {
    cl.viewangles[0] = 45; // PITCH, looking down
    cl.viewangles[1] = 0;
    cl.viewangles[2] = 0;
    r_refdef.vieworg[0] = 0;
    r_refdef.vieworg[1] = 0;
    r_refdef.vieworg[2] = 100;

    const eye = vec3(0, 0, 100);
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(cl.viewangles, forward, right, up);

    // independently predict Chase_Update's own math (chase.c's exact
    // formula, confirmed line-for-line against the C source) from the same
    // inputs, rather than re-deriving it from scratch.
    const dest = vec3();
    VectorMA(eye, 4096, forward, dest);
    const stop = vec3();
    TraceLine(eye, dest, stop);
    VectorSubtract(stop, eye, stop);
    let dist = DotProduct(stop, forward);
    if (dist < 1) dist = 1;
    const expectedPitch = (-Math.atan(stop[2] / dist) / M_PI) * 180;

    Chase_Update();

    expect(r_refdef.vieworg[0]).toBeCloseTo(eye[0] - forward[0] * chase_back.value, 2);
    expect(r_refdef.vieworg[1]).toBeCloseTo(eye[1] - forward[1] * chase_back.value, 2);
    expect(r_refdef.vieworg[2]).toBeCloseTo(eye[2] + chase_up.value, 2);
    expect(r_refdef.viewangles[PITCH]).toBeCloseTo(expectedPitch, 2);

    // the look-target ray really did cross into solid ground close to the
    // eye's Z=0 plane, not sail through untouched.
    expect(stop[2] + eye[2]).toBeGreaterThan(-1);
    expect(stop[2] + eye[2]).toBeLessThan(1);
  });
});
