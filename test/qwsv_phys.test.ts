/*
Self-sufficient test for Q016's src/qw/server/sv_phys.ts (QW/server/sv_phys.c).

Two fixtures, both built by this file and nothing else (standing order 13):

- A hand-assembled progs image written straight into src/qw/server/progs.ts's
  `qwpr` singleton (globals buffer, string block, statement table, function
  table), the same technique test/pr_exec.test.ts uses for WinQuake. No
  progs.dat is read. One QuakeC "function" is compiled by hand as
  `OP_CALL0 <builtin 1>; OP_DONE`, and builtin 1 dispatches to a mutable
  `thinkHook`, so SV_RunThink's think call is observable and can free the
  entity from inside the think.
- A synthetic BSP world (test/support/bsp_builder's buildBsp: floor plane at
  z=0 facing up, solid below, empty above) written into a scratch `-basedir`
  with the id1/pak0.pak + gfx/pop.lmp registration recipe COM_CheckRegistered
  needs, then loaded through src/qw/server/model.ts and linked with
  src/qw/server/world.ts's SV_ClearWorld -- the same recipe
  test/qwsv_world.test.ts uses.

Shared singletons this suite touches and resets itself (standing order 15):
com_searchpaths/com_modified (process-wide, shared with every other suite),
sysState.nostdout, `qwpr`, the qw `sv` server singleton and its edict table,
src/qw/server/sv_main.ts's `svMainState` (host_frametime/realtime),
src/qw/pmove_types.ts's `movevars`, and sv_phys.ts's own ten cvars (values
only -- they are never registered here, so nothing is added to the global
cvar list).
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { sysState } from "../src/platform/sys";
import { setComModified, setComSearchpaths } from "../src/common/common";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Mod_ForName, Mod_Init } from "../src/qw/server/model";
import type { ModelT } from "../src/common/model";
import { DfunctionT, OpT } from "../src/progs/pr_comp";
import { QW_ENTVARS_SIZE_WORDS, QwGlobalVars } from "../src/qw/server/progdefs";
import { QwEdictT, qwpr, setEdictTable } from "../src/qw/server/progs";
import { setBuiltins } from "../src/qw/server/pr_exec";
import { SV_ClearWorld } from "../src/qw/server/world";
import {
  FL_ONGROUND,
  MOVETYPE_BOUNCE,
  MOVETYPE_TOSS,
  SOLID_BBOX,
  SOLID_BSP,
  MOVETYPE_PUSH,
  ServerStateT,
  sv,
} from "../src/qw/server/server";
import { movevars } from "../src/qw/pmove_types";
import { svMainState } from "../src/qw/server/sv_main";
import {
  SV_AddGravity,
  SV_CheckVelocity,
  SV_Physics_Toss,
  SV_RunThink,
  SV_SetMoveVars,
  sv_accelerate,
  sv_airaccelerate,
  sv_friction,
  sv_gravity,
  sv_maxspeed,
  sv_maxvelocity,
  sv_spectatormaxspeed,
  sv_stopspeed,
  sv_wateraccelerate,
  sv_waterfriction,
} from "../src/qw/server/sv_phys";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-phys-test-"));
const baseDir = join(scratchDir, "quake");

const NUM_GLOBALS = 200;
const GFN = 150; // scratch global holding the builtin function's index

let gf: Float32Array;
let gi: Int32Array;
let gs: QwGlobalVars;
let edicts: QwEdictT[];
let worldmodel: ModelT;
let thinkHook: () => void = () => {};

const savedNostdout = sysState.nostdout;
const savedCvars: Array<[{ value: number; string: string }, number, string]> = [];

function saveCvar(c: { value: number; string: string }): void {
  savedCvars.push([c, c.value, c.string]);
}

function buildProgsImage(): void {
  const buffer = new ArrayBuffer(NUM_GLOBALS * 4);
  gf = new Float32Array(buffer);
  gi = new Int32Array(buffer);
  qwpr.globals = { f: gf, i: gi };
  gs = new QwGlobalVars(gf, gi);
  qwpr.global_struct = gs;

  // string block: offset 0 is "", offset 1 is "test_ent"
  const bytes: number[] = [0];
  const classnameOfs = bytes.length;
  for (const ch of "test_ent") bytes.push(ch.charCodeAt(0));
  bytes.push(0);
  qwpr.strings = new Uint8Array(bytes);

  // OP_CALL0 <builtin>; OP_DONE
  const stmts: Array<[number, number, number, number]> = [
    [OpT.OP_CALL0, GFN, 0, 0],
    [OpT.OP_DONE, 0, 0, 0],
  ];
  const op = new Int16Array(stmts.length);
  const a = new Int16Array(stmts.length);
  const b = new Int16Array(stmts.length);
  const c = new Int16Array(stmts.length);
  for (let i = 0; i < stmts.length; i++) {
    op[i] = stmts[i][0];
    a[i] = stmts[i][1];
    b[i] = stmts[i][2];
    c[i] = stmts[i][3];
  }
  qwpr.statements = { op, a, b, c };

  const fn0 = new DfunctionT(); // index 0 is the "no function" slot
  const think = new DfunctionT();
  think.first_statement = 0;
  think.parm_start = 0;
  think.locals = 0;
  think.numparms = 0;
  const builtin = new DfunctionT();
  builtin.first_statement = -1; // negative == builtin 1
  qwpr.functions = [fn0, think, builtin];
  qwpr.edict_size = QW_ENTVARS_SIZE_WORDS;

  gi[GFN] = 2; // the builtin's function index, read by OP_CALL0

  setBuiltins([
    () => {
      throw new Error("builtin 0 called");
    },
    () => thinkHook(),
  ]);

  edicts = [];
  for (let i = 0; i < 8; i++) edicts.push(new QwEdictT(i, QW_ENTVARS_SIZE_WORDS));
  setEdictTable(edicts);

  sv.edicts = edicts;
  sv.num_edicts = edicts.length;
  sv.state = ServerStateT.ss_active;
  sv.time = 0;

  // classname for the two SV_CheckVelocity NaN prints
  for (const e of edicts) e.v.classname = classnameOfs;
}

beforeAll(() => {
  // Con_Printf/SV_Error diagnostics go to Sys_Printf; keep the suite quiet.
  sysState.nostdout = 1;

  for (const c of [
    sv_maxvelocity,
    sv_gravity,
    sv_stopspeed,
    sv_maxspeed,
    sv_spectatormaxspeed,
    sv_accelerate,
    sv_airaccelerate,
    sv_wateraccelerate,
    sv_friction,
    sv_waterfriction,
  ])
    saveCvar(c);

  setComSearchpaths(null);
  setComModified(false);

  ensureDir(join(baseDir, "id1"));
  ensureDir(join(baseDir, "qw"));

  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["qwsv", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  worldmodel = loaded;
});

afterAll(() => {
  sysState.nostdout = savedNostdout;
  for (const [c, value, string] of savedCvars) {
    c.value = value;
    c.string = string;
  }
  setComSearchpaths(null);
  setComModified(false);
  sv.clear();
  svMainState.host_frametime = 0;
  svMainState.realtime = 0;
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  thinkHook = () => {};
  buildProgsImage();

  sv.worldmodel = worldmodel;
  sv.models[1] = worldmodel;
  SV_ClearWorld();

  // edict 0 is the world, exactly as SV_SpawnServer sets it up
  edicts[0].v.solid = SOLID_BSP;
  edicts[0].v.movetype = MOVETYPE_PUSH;
  edicts[0].v.modelindex = 1;

  svMainState.host_frametime = 0.1;
  svMainState.realtime = 0;

  sv_maxvelocity.value = 2000;
  sv_gravity.value = 800;
  sv_stopspeed.value = 100;
  sv_maxspeed.value = 320;
  sv_spectatormaxspeed.value = 500;
  sv_accelerate.value = 10;
  sv_airaccelerate.value = 0.7;
  sv_wateraccelerate.value = 10;
  sv_friction.value = 4;
  sv_waterfriction.value = 4;
});

describe("SV_CheckVelocity", () => {
  test("clamps each axis to +/- sv_maxvelocity", () => {
    sv_maxvelocity.value = 500;
    const ent = edicts[1];
    ent.v.velocity[0] = 900;
    ent.v.velocity[1] = -900;
    ent.v.velocity[2] = 100;

    SV_CheckVelocity(ent);

    expect(ent.v.velocity[0]).toBe(500);
    expect(ent.v.velocity[1]).toBe(-500);
    expect(ent.v.velocity[2]).toBe(100);
  });

  test("a raised sv_maxvelocity leaves the same velocity untouched", () => {
    sv_maxvelocity.value = 2000;
    const ent = edicts[1];
    ent.v.velocity[0] = 900;
    SV_CheckVelocity(ent);
    expect(ent.v.velocity[0]).toBe(900);
  });

  test("resets a NaN velocity component to 0", () => {
    const ent = edicts[1];
    ent.v.velocity[0] = NaN;
    ent.v.velocity[1] = 10;
    SV_CheckVelocity(ent);
    expect(ent.v.velocity[0]).toBe(0);
    expect(ent.v.velocity[1]).toBe(10);
  });

  test("resets a NaN origin component to 0 without touching that axis's velocity", () => {
    const ent = edicts[1];
    ent.v.origin[2] = NaN;
    ent.v.velocity[2] = 42;
    SV_CheckVelocity(ent);
    expect(ent.v.origin[2]).toBe(0);
    expect(ent.v.velocity[2]).toBe(42);
  });
});

describe("SV_AddGravity", () => {
  test("subtracts scale * movevars.gravity * host_frametime from velocity[2]", () => {
    movevars.gravity = 800;
    svMainState.host_frametime = 0.05;
    const ent = edicts[1];
    ent.v.velocity[2] = 0;

    SV_AddGravity(ent, 1.0);
    expect(ent.v.velocity[2]).toBeCloseTo(-40, 5);

    SV_AddGravity(ent, 0.5);
    expect(ent.v.velocity[2]).toBeCloseTo(-60, 5);
  });

  test("reads movevars.gravity, not the sv_gravity cvar directly", () => {
    // QW's SV_AddGravity has no cvar read at all; SV_SetMoveVars is the only
    // path from sv_gravity into movevars.
    sv_gravity.value = 1600;
    movevars.gravity = 100;
    svMainState.host_frametime = 0.1;
    const ent = edicts[1];
    ent.v.velocity[2] = 0;

    SV_AddGravity(ent, 1.0);
    expect(ent.v.velocity[2]).toBeCloseTo(-10, 5);
  });

  test("SV_SetMoveVars then SV_AddGravity uses the cvar value", () => {
    sv_gravity.value = 1600;
    SV_SetMoveVars();
    svMainState.host_frametime = 0.1;
    const ent = edicts[1];
    ent.v.velocity[2] = 0;

    SV_AddGravity(ent, 1.0);
    expect(ent.v.velocity[2]).toBeCloseTo(-160, 5);
  });
});

describe("SV_SetMoveVars", () => {
  test("copies every cvar into movevars and pins entgravity to 1", () => {
    sv_gravity.value = 700;
    sv_stopspeed.value = 90;
    sv_maxspeed.value = 300;
    sv_spectatormaxspeed.value = 450;
    sv_accelerate.value = 12;
    sv_airaccelerate.value = 0.5;
    sv_wateraccelerate.value = 8;
    sv_friction.value = 5;
    sv_waterfriction.value = 3;
    movevars.entgravity = 0.25;

    SV_SetMoveVars();

    expect(movevars.gravity).toBe(700);
    expect(movevars.stopspeed).toBe(90);
    expect(movevars.maxspeed).toBe(300);
    expect(movevars.spectatormaxspeed).toBe(450);
    expect(movevars.accelerate).toBe(12);
    expect(movevars.airaccelerate).toBe(0.5);
    expect(movevars.wateraccelerate).toBe(8);
    expect(movevars.friction).toBe(5);
    expect(movevars.waterfriction).toBe(3);
    expect(movevars.entgravity).toBe(1.0);
  });
});

describe("SV_RunThink", () => {
  test("returns true and runs nothing when nextthink is 0", () => {
    const ent = edicts[1];
    ent.v.nextthink = 0;
    ent.v.think = 1;
    let ran = 0;
    thinkHook = () => {
      ran++;
    };

    expect(SV_RunThink(ent)).toBe(true);
    expect(ran).toBe(0);
  });

  test("returns true and runs nothing when nextthink is past sv.time + host_frametime", () => {
    sv.time = 1;
    svMainState.host_frametime = 0.1;
    const ent = edicts[1];
    ent.v.nextthink = 1.2;
    ent.v.think = 1;
    let ran = 0;
    thinkHook = () => {
      ran++;
    };

    expect(SV_RunThink(ent)).toBe(true);
    expect(ran).toBe(0);
    expect(ent.v.nextthink).toBeCloseTo(1.2, 5);
  });

  test("runs the think, clears nextthink and sets pr_global_struct time/self/other", () => {
    sv.time = 1;
    svMainState.host_frametime = 0.1;
    const ent = edicts[3];
    ent.v.nextthink = 1.05;
    ent.v.think = 1;
    let seenTime = -1;
    let seenSelf = -1;
    let seenOther = -1;
    thinkHook = () => {
      seenTime = gs.time;
      seenSelf = gs.self;
      seenOther = gs.other;
    };

    expect(SV_RunThink(ent)).toBe(true);
    expect(seenTime).toBeCloseTo(1.05, 5);
    expect(seenSelf).toBe(3);
    expect(seenOther).toBe(0); // sv.edicts[0], the world
    expect(ent.v.nextthink).toBe(0);
  });

  test("clamps a nextthink in the past forward to sv.time", () => {
    sv.time = 5;
    svMainState.host_frametime = 0.1;
    const ent = edicts[1];
    ent.v.nextthink = 2;
    ent.v.think = 1;
    let seenTime = -1;
    thinkHook = () => {
      seenTime = gs.time;
    };

    expect(SV_RunThink(ent)).toBe(true);
    expect(seenTime).toBe(5);
  });

  test("loops while the think keeps setting a new nextthink in range", () => {
    sv.time = 1;
    svMainState.host_frametime = 0.1;
    const ent = edicts[1];
    ent.v.nextthink = 1.01;
    ent.v.think = 1;
    let ran = 0;
    thinkHook = () => {
      ran++;
      if (ran < 3) ent.v.nextthink = 1.01 + ran * 0.01;
    };

    expect(SV_RunThink(ent)).toBe(true);
    expect(ran).toBe(3);
  });

  test("returns false when the think frees the entity", () => {
    sv.time = 1;
    svMainState.host_frametime = 0.1;
    const ent = edicts[1];
    ent.v.nextthink = 1.05;
    ent.v.think = 1;
    thinkHook = () => {
      ent.free = true;
    };

    expect(SV_RunThink(ent)).toBe(false);
  });
});

describe("SV_Physics_Toss against the synthetic world", () => {
  function dropper(index: number, movetype: number, velocityZ: number): QwEdictT {
    const ent = edicts[index];
    ent.free = false;
    ent.v.movetype = movetype;
    ent.v.solid = SOLID_BBOX;
    ent.v.origin[0] = 0;
    ent.v.origin[1] = 0;
    ent.v.origin[2] = 10;
    ent.v.velocity[2] = velocityZ;
    ent.v.nextthink = 0;
    ent.v.think = 0;
    ent.v.watertype = 0;
    ent.v.flags = 0;
    return ent;
  }

  test("MOVETYPE_BOUNCE reverses velocity with the 1.5 backoff and stays off the ground", () => {
    movevars.gravity = 0; // isolate ClipVelocity from the gravity add
    svMainState.host_frametime = 0.1;
    const ent = dropper(2, MOVETYPE_BOUNCE, -400);

    SV_Physics_Toss(ent);

    // -400 clipped against the floor normal (0,0,1) with overbounce 1.5:
    // -400 - 1*(-400)*1.5 = 200, which is >= 60, so it does not stop.
    expect(ent.v.velocity[2]).toBeCloseTo(200, 4);
    expect((ent.v.flags | 0) & FL_ONGROUND).toBe(0);
    expect(ent.v.origin[2]).toBeGreaterThan(0);
    expect(ent.v.origin[2]).toBeLessThan(1);
  });

  test("MOVETYPE_TOSS comes to rest on the floor with FL_ONGROUND and the world as groundentity", () => {
    movevars.gravity = 0;
    svMainState.host_frametime = 0.1;
    const ent = dropper(2, MOVETYPE_TOSS, -400);

    SV_Physics_Toss(ent);

    // overbounce 1 leaves velocity[2] == 0, which is < 60, so it stops dead.
    expect(ent.v.velocity[2]).toBe(0);
    expect(ent.v.velocity[0]).toBe(0);
    expect(ent.v.velocity[1]).toBe(0);
    expect((ent.v.flags | 0) & FL_ONGROUND).toBe(FL_ONGROUND);
    expect(ent.v.groundentity).toBe(0);
    expect(ent.v.origin[2]).toBeGreaterThan(0);
    expect(ent.v.origin[2]).toBeLessThan(1);
  });

  test("a free fall that does not reach the floor just integrates velocity and gravity", () => {
    movevars.gravity = 800;
    svMainState.host_frametime = 0.05;
    const ent = dropper(2, MOVETYPE_TOSS, 0);
    ent.v.origin[2] = 500;

    SV_Physics_Toss(ent);

    // velocity[2] = 0 - 800*0.05 = -40; origin moves -40*0.05 = -2
    expect(ent.v.velocity[2]).toBeCloseTo(-40, 4);
    expect(ent.v.origin[2]).toBeCloseTo(498, 3);
    expect((ent.v.flags | 0) & FL_ONGROUND).toBe(0);
  });

  test("an entity already flagged onground does not move", () => {
    movevars.gravity = 800;
    const ent = dropper(2, MOVETYPE_TOSS, 0);
    ent.v.origin[2] = 500;
    ent.v.flags = FL_ONGROUND;

    SV_Physics_Toss(ent);

    expect(ent.v.origin[2]).toBe(500);
    expect(ent.v.velocity[2]).toBe(0);
  });

  test("SV_CheckWaterTransition seeds watertype once a move actually hits something", () => {
    // SV_Physics_Toss returns before SV_CheckWaterTransition when the move
    // covers its whole distance (trace.fraction == 1), so the transition is
    // only reached on a blocked move -- here the drop onto the floor.
    movevars.gravity = 0;
    svMainState.host_frametime = 0.1;
    const clear = dropper(2, MOVETYPE_TOSS, 0);
    clear.v.origin[2] = 500;
    SV_Physics_Toss(clear);
    expect(clear.v.watertype).toBe(0);

    const ent = dropper(2, MOVETYPE_TOSS, -400);
    SV_Physics_Toss(ent);

    expect(ent.v.watertype).toBe(-1); // CONTENTS_EMPTY
    expect(ent.v.waterlevel).toBe(1);
  });
});
