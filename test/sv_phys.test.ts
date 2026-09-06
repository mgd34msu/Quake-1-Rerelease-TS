import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { buildBsp, writeGameFile } from "./support/bsp_builder";
import { vec3 } from "../src/common/mathlib";
import { EdictT, pr, PR_GetString } from "../src/progs/progs";
import { PR_LoadProgs, PR_AllocEdicts } from "../src/progs/pr_edict";
import { getBuiltins, setBuiltins, type BuiltinT } from "../src/progs/pr_exec";
import { OFS_RETURN } from "../src/progs/pr_comp";
import {
  sv,
  svs,
  MOVETYPE_NONE,
  MOVETYPE_TOSS,
  MOVETYPE_BOUNCE,
  MOVETYPE_NOCLIP,
  MOVETYPE_PUSH,
  MOVETYPE_WALK,
  SOLID_BSP,
  SOLID_BBOX,
  SOLID_NOT,
  FL_ONGROUND,
} from "../src/server/server";
import { SV_ClearWorld, SV_LinkEdict } from "../src/server/world";
import { host } from "../src/common/host";
import { Cvar_RegisterVariable } from "../src/common/cvar";
import { sysState } from "../src/platform/sys";
import {
  sv_gravity,
  sv_maxvelocity,
  sv_friction,
  sv_stopspeed,
  sv_nostep,
  STOP_EPSILON,
  ClipVelocity,
  SV_CheckVelocity,
  SV_AddGravity,
  SV_FlyMove,
  SV_Physics_Toss,
  SV_WalkMove,
  SV_PushMove,
  SV_Physics,
} from "../src/server/sv_phys";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "sv-phys-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;
// src/progs/pr_cmds.ts installs the real builtin table at module load (a
// side-effect import reached through src/main.ts and test/host.test.ts/
// test/host_cmd.test.ts's own real-table setBuiltins calls); this suite's
// own beforeAll below replaces it with a 46-entry stub sized for world.qc's
// StartFrame alone and never puts the real one back, permanently truncating
// pr_builtins for the rest of this bun process (rule 15) -- restore it here.
const savedBuiltins = getBuiltins();

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setBuiltins(savedBuiltins);
  rmSync(scratchDir, { recursive: true, force: true });
});

let mod: ModelT;

// This suite is self-sufficient: it builds its own synthetic BSP (the
// bsp_builder.ts map: a single z=0 split plane, solid below, empty above --
// see test/world.test.ts for the same recipe) and loads the real progs106
// fixture (test/pr_edict.test.ts's recipe) so `pr.global_struct` exists for
// SV_Physics/SV_RunThink. Every edict used here has `think`/`touch`/`blocked`
// left at 0 (func_t "none"), so PR_ExecuteProgram is never reached from those
// fields. The one unavoidable exception is SV_Physics itself, which
// unconditionally calls PR_ExecuteProgram(pr_global_struct->StartFrame) --
// world.qc's real StartFrame (`teamplay = cvar(...); skill = cvar(...);
// framecount = framecount + 1;`) only calls the `cvar` builtin (#45, per
// progs106/defs.qc's `float(string s) cvar = #45;`), stubbed below because
// pr_cmds.ts (U023) is not landed yet.
beforeAll(() => {
  sysState.nostdout = 1;

  // No throw: a missing progs106/progs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_PROGS106), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_PROGS106) return;

  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  const progsDat = new Uint8Array(readFileSync(PROGS_DAT));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: progsDat },
  ]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  mod = loaded;

  PR_LoadProgs();
  PR_AllocEdicts(64);

  const builtins: BuiltinT[] = [];
  for (let i = 0; i < 46; i++) builtins.push(() => {});
  builtins[45] = () => {
    // float(string s) cvar = #45; -- return value unused by StartFrame
    // beyond assigning it to a global, so 0 is fine.
    if (pr.globals === null) throw new Error("sv_phys.test: pr.globals not set");
    pr.globals.f[OFS_RETURN] = 0;
  };
  setBuiltins(builtins);

  Cvar_RegisterVariable(sv_friction);
  Cvar_RegisterVariable(sv_stopspeed);
  Cvar_RegisterVariable(sv_gravity);
  Cvar_RegisterVariable(sv_maxvelocity);
  Cvar_RegisterVariable(sv_nostep);

  // SV_SpawnServer's own edict-0 setup (sv_main.c): the world edict is a
  // SOLID_BSP/MOVETYPE_PUSH entity pointing at model slot 1.
  sv.worldmodel = mod;
  sv.models[1] = mod;
  sv.edicts[0].v.solid = SOLID_BSP;
  sv.edicts[0].v.movetype = MOVETYPE_PUSH;
  sv.edicts[0].v.modelindex = 1;
  svs.maxclients = 0; // no client slots: SV_Physics never takes the client dispatch arm
  sv.num_edicts = 64;

  SV_ClearWorld();
});

// test-only helper: a SOLID_BBOX edict at `index` (one per test, own column,
// so different SV_Move rays never see each other's box -- test/world.test.ts's
// pattern).
function box(index: number, x: number, y: number, z: number, half = 8): EdictT {
  const e = sv.edicts[index];
  e.v.solid = SOLID_BBOX;
  e.v.movetype = MOVETYPE_NONE;
  e.v.origin[0] = x;
  e.v.origin[1] = y;
  e.v.origin[2] = z;
  e.v.mins[0] = -half;
  e.v.mins[1] = -half;
  e.v.mins[2] = -half;
  e.v.maxs[0] = half;
  e.v.maxs[1] = half;
  e.v.maxs[2] = half;
  return e;
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("ClipVelocity", () => {
  test("a floor normal sets bit 1 and fully absorbs velocity into the plane", () => {
    const out = vec3();
    const blocked = ClipVelocity(vec3(0, 0, -100), vec3(0, 0, 1), out, 1);
    expect(blocked & 1).toBe(1);
    expect(blocked & 2).toBe(0);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  test("a vertical wall normal sets bit 2 and preserves the fall speed", () => {
    const out = vec3();
    const blocked = ClipVelocity(vec3(100, 0, -50), vec3(1, 0, 0), out, 1);
    expect(blocked & 2).toBe(2);
    expect(blocked & 1).toBe(0);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[2]).toBeCloseTo(-50, 5);
  });

  test("STOP_EPSILON snaps a residual smaller than 0.1 to zero", () => {
    const out = vec3();
    // backoff = -0.1*1.5 = -0.15; out[2] = -0.1 - 1*(-0.15) = 0.05, inside
    // (-STOP_EPSILON, STOP_EPSILON).
    ClipVelocity(vec3(0, 0, -0.1), vec3(0, 0, 1), out, 1.5);
    expect(Math.abs(0.05)).toBeLessThan(STOP_EPSILON);
    expect(out[2]).toBe(0);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_CheckVelocity", () => {
  test("clamps velocity to +-sv_maxvelocity per axis", () => {
    const e = box(3, 0, 500, 100);
    e.v.velocity[0] = sv_maxvelocity.value + 500;
    e.v.velocity[1] = -(sv_maxvelocity.value + 500);
    e.v.velocity[2] = 0;
    SV_CheckVelocity(e);
    expect(e.v.velocity[0]).toBe(sv_maxvelocity.value);
    expect(e.v.velocity[1]).toBe(-sv_maxvelocity.value);
    expect(e.v.velocity[2]).toBe(0);
  });

  test("resets a NaN velocity component to zero", () => {
    const e = box(3, 0, 500, 100);
    e.v.velocity[0] = NaN;
    e.v.velocity[1] = 10;
    e.v.velocity[2] = 10;
    e.v.origin[0] = NaN;
    SV_CheckVelocity(e);
    expect(e.v.velocity[0]).toBe(0);
    expect(e.v.velocity[1]).toBe(10);
    expect(e.v.origin[0]).toBe(0);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_AddGravity", () => {
  test("subtracts sv_gravity.value * host.frametime from velocity[2]", () => {
    const e = box(3, 0, 500, 100);
    e.v.velocity[2] = 0;
    host.frametime = 0.1;
    SV_AddGravity(e);
    expect(e.v.velocity[2]).toBeCloseTo(-sv_gravity.value * 0.1, 5);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_FlyMove", () => {
  test("falling into the world's solid half returns blocked bit 1 and grounds on the world", () => {
    const e = box(4, 300, 0, 50);
    e.v.velocity[2] = -1000;
    const clip = SV_FlyMove(e, 0.1, null);
    expect(clip & 1).toBe(1);
    expect(e.v.groundentity).toBe(0); // PROG_TO_EDICT(0) is the world edict
    expect((e.v.flags | 0) & FL_ONGROUND).toBe(FL_ONGROUND);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_Physics_Toss", () => {
  test("falls under gravity, losing sv_gravity*frametime of velocity[2] per step, then rests on the floor", () => {
    const e = box(5, 300, 100, 50);
    e.v.movetype = MOVETYPE_TOSS;
    host.frametime = 0.1;

    let landed = false;
    let previousVelocity = 0;
    for (let i = 0; i < 10 && !landed; i++) {
      SV_Physics_Toss(e);
      if ((e.v.flags | 0) & FL_ONGROUND) {
        landed = true;
      } else {
        // still in freefall: this step's velocity is exactly one more
        // gravity*frametime below the previous step's.
        expect(e.v.velocity[2]).toBeCloseTo(previousVelocity - sv_gravity.value * host.frametime, 5);
        previousVelocity = e.v.velocity[2];
      }
    }

    expect(landed).toBe(true);
    // hull1's clip_mins.z (-24) minus the box's own mins.z (-8), epsilon-backed.
    expect(e.v.origin[2]).toBeCloseTo(-24 + 8 + 0.03125, 4);
    expect(e.v.velocity[2]).toBe(0);
    expect(e.v.groundentity).toBe(0);
  });

  test("MOVETYPE_BOUNCE reverses velocity[2] with backoff 1.5 instead of stopping", () => {
    const e = box(6, 400, 0, 50);
    e.v.movetype = MOVETYPE_BOUNCE;
    e.v.velocity[2] = -1000;
    host.frametime = 0.1;

    SV_Physics_Toss(e);

    // velocity entering the floor clip is -1000 - sv_gravity*frametime = -1080;
    // ClipVelocity's backoff=1.5 on a (0,0,1) floor normal gives -0.5*in.
    const velocityAtImpact = -1000 - sv_gravity.value * host.frametime;
    expect(e.v.velocity[2]).toBeCloseTo(-0.5 * velocityAtImpact, 3);
    expect(e.v.velocity[2]).toBeGreaterThan(60); // stays airborne (exactly as the original: only <60 or non-BOUNCE stops)
    expect((e.v.flags | 0) & FL_ONGROUND).toBe(0);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_WalkMove", () => {
  test("on flat ground moves the full distance (no step needed)", () => {
    // resting exactly on the world's floor already (see the SV_Physics_Toss
    // rest position above), so a purely horizontal move never touches the
    // floor plane and SV_FlyMove reports no blocking at all.
    const e = box(7, 500, 0, -24 + 8 + 0.03125);
    e.v.movetype = MOVETYPE_WALK;
    e.v.velocity[0] = 100;
    e.v.velocity[1] = 0;
    e.v.velocity[2] = 0;
    host.frametime = 0.1;

    SV_WalkMove(e);

    expect(e.v.origin[0]).toBeCloseTo(500 + 100 * 0.1, 5);
    expect(e.v.origin[1]).toBeCloseTo(0, 5);
  });

  // SV_WalkMove's step-up path (STEPSIZE=18) needs an actual vertical wall/
  // step edge in the clipping hulls; bsp_builder.ts's synthetic map is a
  // single infinite z=0 split plane with no such geometry, so the "ran into
  // a step and climbed it" branch is not reachable with this map. Reported
  // as a skip per the unit brief.
  test.skip("stepping up an 8-unit ledge is out of reach with this synthetic map", () => {});
});

describe.skipIf(!HAVE_PROGS106)("SV_PushMove", () => {
  test("moves a MOVETYPE_PUSH edict and carries a riding entity (groundentity = pusher) with it", () => {
    const pusher = sv.edicts[8];
    pusher.v.solid = SOLID_BSP;
    pusher.v.movetype = MOVETYPE_PUSH;
    pusher.v.modelindex = 1;
    pusher.v.origin[0] = 1000;
    pusher.v.origin[1] = 0;
    pusher.v.origin[2] = 0;
    pusher.v.mins[0] = -16;
    pusher.v.mins[1] = -16;
    pusher.v.mins[2] = -16;
    pusher.v.maxs[0] = 16;
    pusher.v.maxs[1] = 16;
    pusher.v.maxs[2] = 16;
    SV_LinkEdict(pusher, false);

    const rider = box(9, 1000, 0, 24);
    rider.v.movetype = MOVETYPE_TOSS; // any non-PUSH/NONE/NOCLIP movetype is an eligible mover
    rider.v.flags = FL_ONGROUND;
    rider.v.groundentity = 8; // NUM_FOR_EDICT(pusher)

    pusher.v.velocity[0] = 0;
    pusher.v.velocity[1] = 0;
    pusher.v.velocity[2] = 10;

    SV_PushMove(pusher, 0.1);

    expect(pusher.v.origin[2]).toBeCloseTo(1, 5);
    expect(rider.v.origin[2]).toBeCloseTo(25, 5); // carried by the same 1-unit rise
  });

  test("blocked by an entity that cannot be moved calls no think (blocked=0) and restores positions", () => {
    const pusher = sv.edicts[10];
    pusher.v.solid = SOLID_BSP;
    pusher.v.movetype = MOVETYPE_PUSH;
    pusher.v.modelindex = 1;
    pusher.v.origin[0] = 2000;
    pusher.v.origin[1] = 0;
    pusher.v.origin[2] = 0;
    pusher.v.mins[0] = -16;
    pusher.v.mins[1] = -16;
    pusher.v.mins[2] = -16;
    pusher.v.maxs[0] = 16;
    pusher.v.maxs[1] = 16;
    pusher.v.maxs[2] = 16;
    pusher.v.blocked = 0; // no "blocked" QuakeC function -- PR_ExecuteProgram must never run
    SV_LinkEdict(pusher, false);

    // resting directly on the pusher's own BSP floor: pusher.origin.z +
    // hull1.clip_mins.z(-24) - blocker.mins.z(-8) = -16, epsilon-adjusted.
    const blocker = box(11, 2000, 0, -24 + 8 + 0.03125, 8);
    blocker.v.movetype = MOVETYPE_TOSS;
    SV_LinkEdict(blocker, false);

    // a static ceiling only 2 units above the blocker's top face -- too
    // close for the blocker to be carried the pusher's full 10-unit rise.
    const ceiling = box(12, 2000, 0, 10, 16);
    ceiling.v.movetype = MOVETYPE_NONE;
    SV_LinkEdict(ceiling, false);

    const pusherOrigZ = pusher.v.origin[2];
    const blockerOrigZ = blocker.v.origin[2];

    pusher.v.velocity[0] = 0;
    pusher.v.velocity[1] = 0;
    pusher.v.velocity[2] = 100; // 10 units in 0.1s -- more than the ~2-unit gap

    SV_PushMove(pusher, 0.1);

    expect(pusher.v.origin[2]).toBeCloseTo(pusherOrigZ, 5);
    expect(blocker.v.origin[2]).toBeCloseTo(blockerOrigZ, 5);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_CheckWater", () => {
  // bsp_builder.ts's BspBuildOptions has no way to make a leaf CONTENTS_WATER
  // (its two leafs are hardcoded CONTENTS_SOLID / CONTENTS_EMPTY -- grep
  // confirms), so this test is skipped and reported per the unit brief
  // rather than faked against the wrong content type.
  test.skip("a CONTENTS_WATER leaf sets waterlevel/watertype (skipped: bsp_builder.ts cannot emit one)", () => {});
});

describe.skipIf(!HAVE_PROGS106)("SV_Physics", () => {
  test("dispatches MOVETYPE_NONE/MOVETYPE_NOCLIP and advances sv.time by host.frametime", () => {
    // dedicated low indices, isolated from every other describe block's
    // edicts (some of which carry MOVETYPE_WALK, only valid inside
    // SV_Physics's client-index arm) via a tight sv.num_edicts bound below --
    // this test does not depend on execution order relative to the others.
    const none = sv.edicts[1];
    none.v.movetype = MOVETYPE_NONE;
    none.v.solid = SOLID_NOT;
    none.v.origin[0] = 4000;

    const noclip = sv.edicts[2];
    noclip.v.movetype = MOVETYPE_NOCLIP;
    noclip.v.solid = SOLID_NOT;
    noclip.v.origin[0] = 5000;
    noclip.v.velocity[0] = 100;

    const savedNumEdicts = sv.num_edicts;
    sv.num_edicts = 3; // world (0), none (1), noclip (2) only

    host.frametime = 0.1;
    const t0 = sv.time;
    SV_Physics();

    expect(sv.time).toBeCloseTo(t0 + 0.1, 5);
    expect(noclip.v.origin[0]).toBeCloseTo(5010, 5);
    expect(none.v.origin[0]).toBe(4000); // MOVETYPE_NONE never moves

    sv.num_edicts = savedNumEdicts;
  });
});
