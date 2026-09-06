// Self-sufficient test suite for src/server/sv_move.ts (sv_move.c -- monster
// movement). Not a ported C file -- test infrastructure only. Follows the
// synthetic-BSP recipe test/world.test.ts established: a minimal BSP whose
// single splitting plane (z = 0) makes the entire world below z = 0 solid
// and everything above it empty, with no bounded edge to walk off of.
//
// Geometry note: the monster box used below (mins (-16,-16,-24), maxs
// (16,16,24)) has mins that exactly match model.ts's hard-coded hull1
// clip_mins (-16,-16,-24) (Mod_MakeHull1's constants), and the world edict
// sits at origin (0,0,0) -- so SV_HullForEntity's offset (hull.clip_mins -
// mins + world.origin) is exactly (0,0,0) for every box trace below: hull1
// traces this box's *origin* coordinate directly against the same z = 0
// split hull0/SV_PointContents use, with no Minkowski shift. That is what
// this bsp_builder.ts fixture actually encodes (its own header comment: "not
// a real sealed room"), so a box resting so its bottom face touches z = 0
// (origin.z = 24, used for the standalone SV_CheckBottom checks below, whose
// quick corner check reads real world corners via SV_PointContents) is a
// different height than the one at which SV_movestep's box-hull traces
// (offset-cancelled, so effectively testing raw origin.z against 0) find
// the floor (origin.z = 0). Each test below sets the origin height its own
// code path actually needs; the two are intentionally not the same number.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { vec3 } from "../src/common/mathlib";
import { EdictT, pr, setEdictTable } from "../src/progs/progs";
import { ENTVARS_SIZE_WORDS, GlobalVars } from "../src/progs/progdefs";
import { OFS_PARM0, OFS_RETURN } from "../src/progs/pr_comp";
import { sv, MOVETYPE_PUSH, SOLID_BSP, SOLID_SLIDEBOX, FL_ONGROUND, FL_FLY } from "../src/server/server";
import { SV_ClearWorld } from "../src/server/world";
import { SV_CheckBottom, SV_CloseEnough, SV_MoveToGoal, SV_NewChaseDir, SV_StepDirection, SV_movestep, svMoveCounters } from "../src/server/sv_move";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "sv_move-test-"));
const baseDir = join(scratchDir, "quake");

const NUM_GLOBALS = 200;

let mod: ModelT;

// test-only monster box, matching hull1's clip_mins exactly (see file header).
const MON_MINS = vec3(-16, -16, -24);
const MON_MAXS = vec3(16, 16, 24);

// one column per moving test entity (matching test/world.test.ts's own
// convention) -- once SV_movestep/SV_StepDirection relink an entity into the
// world's area-node tree, a later test's SV_Move would otherwise clip
// against a still-linked earlier entity sitting at the same x/y.
const WALKER_X = 0;
const FLYER_X = 600;
const ACTOR_X = 1200;
const CHASER_X = 1800;

let walker: EdictT; // walking (MOVETYPE_STEP-style) monster, SV_CheckBottom/SV_movestep
let flyer: EdictT; // FL_FLY monster, SV_movestep's flying branch
let actor: EdictT; // SV_StepDirection
let chaser: EdictT; // SV_NewChaseDir
let chaseEnemy: EdictT; // SV_NewChaseDir's enemy
let closeA: EdictT; // SV_CloseEnough
let closeB: EdictT; // SV_CloseEnough
let notOnGround: EdictT; // SV_MoveToGoal

// kept as locally-typed (non-null) bindings alongside pr.globals/global_struct
// (both `X | null` on the shared singleton) so test bodies below don't need a
// null check on every access -- same convention as test/pr_exec.test.ts.
let gf: Float32Array;
let gi: Int32Array;
let globalStruct: GlobalVars;

afterAll(() => {
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

  sv.worldmodel = mod;
  sv.models[1] = mod;

  // SV_SpawnServer's own edict-0 setup (sv_main.c): the world edict is a
  // SOLID_BSP/MOVETYPE_PUSH entity pointing at model slot 1.
  const world = new EdictT(0, ENTVARS_SIZE_WORDS);
  world.v.solid = SOLID_BSP;
  world.v.movetype = MOVETYPE_PUSH;
  world.v.modelindex = 1;

  walker = new EdictT(1, ENTVARS_SIZE_WORDS);
  flyer = new EdictT(2, ENTVARS_SIZE_WORDS);
  actor = new EdictT(3, ENTVARS_SIZE_WORDS);
  chaser = new EdictT(4, ENTVARS_SIZE_WORDS);
  chaseEnemy = new EdictT(5, ENTVARS_SIZE_WORDS);
  closeA = new EdictT(6, ENTVARS_SIZE_WORDS);
  closeB = new EdictT(7, ENTVARS_SIZE_WORDS);
  notOnGround = new EdictT(8, ENTVARS_SIZE_WORDS);

  for (const ent of [walker, flyer, actor, chaser]) {
    ent.v.solid = SOLID_SLIDEBOX;
    vec3CopyInto(ent.v.mins, MON_MINS[0], MON_MINS[1], MON_MINS[2]);
    vec3CopyInto(ent.v.maxs, MON_MAXS[0], MON_MAXS[1], MON_MAXS[2]);
  }

  sv.edicts = [world, walker, flyer, actor, chaser, chaseEnemy, closeA, closeB, notOnGround];
  sv.num_edicts = sv.edicts.length;
  sv.max_edicts = sv.edicts.length;
  setEdictTable(sv.edicts);

  SV_ClearWorld();

  const buffer = new ArrayBuffer(NUM_GLOBALS * 4);
  gf = new Float32Array(buffer);
  gi = new Int32Array(buffer);
  pr.globals = { f: gf, i: gi };
  globalStruct = new GlobalVars(gf, gi);
  pr.global_struct = globalStruct;
  pr.edict_size = ENTVARS_SIZE_WORDS;
});

function vec3CopyInto(dst: Float32Array, x: number, y: number, z: number): void {
  dst[0] = x;
  dst[1] = y;
  dst[2] = z;
}

//============================================================================

describe("SV_CheckBottom", () => {
  test("a box resting with its bottom face on the solid half's top surface is true", () => {
    walker.v.flags = FL_ONGROUND;
    vec3CopyInto(walker.v.origin, WALKER_X, 0, 24); // bottom face (origin.z + mins.z) = 0

    expect(SV_CheckBottom(walker)).toBe(true);
  });

  test("lifted 40 units above the ground is false, and increments c_no", () => {
    vec3CopyInto(walker.v.origin, WALKER_X, 0, 64); // 24 + 40

    const before = svMoveCounters.c_no;
    expect(SV_CheckBottom(walker)).toBe(false);
    expect(svMoveCounters.c_no).toBeGreaterThan(before);
  });
});

describe("SV_movestep", () => {
  test("a walking monster moving +x by 8 stays on the ground, returns true, and advances origin.x by 8", () => {
    // hull1's offset cancels out for this box (see file header), so the box
    // trace effectively tests raw origin.z against the z = 0 split: origin.z
    // = 0 is where SV_movestep's step-down probe finds the floor.
    walker.v.flags = FL_ONGROUND;
    vec3CopyInto(walker.v.origin, WALKER_X, 0, 0);

    const result = SV_movestep(walker, vec3(8, 0, 0), true);

    expect(result).toBe(true);
    expect(walker.v.origin[0]).toBeCloseTo(WALKER_X + 8, 5);
  });

  test("an FL_FLY monster moving through open air returns true", () => {
    flyer.v.flags = FL_FLY;
    vec3CopyInto(flyer.v.origin, FLYER_X, 0, 50); // well above the solid half

    const result = SV_movestep(flyer, vec3(8, 0, 0), true);

    expect(result).toBe(true);
    expect(flyer.v.origin[0]).toBeCloseTo(FLYER_X + 8, 5);
    expect(flyer.v.origin[2]).toBeCloseTo(50, 5);
  });

  test("an FL_FLY monster moving down into the solid half returns false", () => {
    flyer.v.flags = FL_FLY;
    vec3CopyInto(flyer.v.origin, FLYER_X, 0, 50);

    const result = SV_movestep(flyer, vec3(0, 0, -100), true);

    expect(result).toBe(false);
  });
});

describe("SV_StepDirection", () => {
  test("sets ideal_yaw and moves the monster forward", () => {
    actor.v.flags = FL_ONGROUND;
    actor.v.ideal_yaw = 0;
    actor.v.yaw_speed = 20;
    vec3CopyInto(actor.v.angles, 0, 0, 0);
    vec3CopyInto(actor.v.origin, ACTOR_X, 0, 0);
    globalStruct.self = actor.index;

    const result = SV_StepDirection(actor, 0, 8);

    expect(result).toBe(true);
    expect(actor.v.ideal_yaw).toBe(0);
    expect(actor.v.origin[0]).toBeCloseTo(ACTOR_X + 8, 5);
  });
});

describe("SV_NewChaseDir", () => {
  test("an enemy to the +x (and slightly +y) side sets ideal_yaw toward it", () => {
    chaser.v.flags = FL_ONGROUND;
    chaser.v.ideal_yaw = 0;
    chaser.v.yaw_speed = 20;
    vec3CopyInto(chaser.v.angles, 0, 0, 0);
    vec3CopyInto(chaser.v.origin, CHASER_X, 0, 0);
    vec3CopyInto(chaseEnemy.v.origin, CHASER_X + 200, 20, 0);
    globalStruct.self = chaser.index;

    SV_NewChaseDir(chaser, chaseEnemy, 8);

    // d[1]/d[2]'s 45-degree rounding (see sv_move.c's DI_NODIR table): the
    // direct-route candidate for this placement is 45, with 0 as its only
    // possible fallback.
    expect([0, 45]).toContain(chaser.v.ideal_yaw);
  });
});

describe("SV_CloseEnough", () => {
  test("true when the two boxes' gap is within dist", () => {
    vec3CopyInto(closeA.v.absmin, -16, -16, -24);
    vec3CopyInto(closeA.v.absmax, 16, 16, 24);
    vec3CopyInto(closeB.v.absmin, 20, 20, -24); // 4-unit gap from closeA's max
    vec3CopyInto(closeB.v.absmax, 52, 52, 24);

    expect(SV_CloseEnough(closeA, closeB, 5)).toBe(true);
  });

  test("false when the gap exceeds dist", () => {
    expect(SV_CloseEnough(closeA, closeB, 1)).toBe(false);
  });
});

describe("SV_MoveToGoal", () => {
  test("returns 0 into OFS_RETURN when the monster is not on the ground/flying/swimming", () => {
    notOnGround.v.flags = 0;
    notOnGround.v.goalentity = 0; // the world edict -- never read before the early return
    globalStruct.self = notOnGround.index;
    gf[OFS_PARM0] = 0;
    gf[OFS_RETURN] = 999; // sentinel, so the assertion proves SV_MoveToGoal wrote 0

    SV_MoveToGoal();

    expect(gf[OFS_RETURN]).toBe(0);
  });
});
