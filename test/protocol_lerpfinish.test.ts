// U33 step 1: the U_LERPFINISH gate moved into SV_Physics/SV_RunThink as
// Ironwail does it (sv_phys.c:136-137, sv_phys.c:1283-1289, sv_main.c:888,
// sv_main.c:952), with SV_WriteEntitiesToClient reduced to reading the
// result (src/server/sv_main.ts) instead of recomputing its own gate.
//
// Coverage:
//  - SV_RunThink (src/server/sv_phys.ts) captures oldthinktime/oldframe when
//    a think actually fires.
//  - SV_Physics's per-entity loop sets ent.sendinterval with Ironwail's exact
//    rule, including the `frame != oldframe` half U16 had dropped for lack of
//    `oldframe`.
//  - SV_WriteEntitiesToClient (src/server/sv_main.ts) emits U_LERPFINISH
//    (or not) under protocol 666 purely from ent.sendinterval/lerpfinish.
//
// Self-sufficiency: this suite builds its own synthetic BSP and loads the
// real progs106 fixture (test/sv_phys.test.ts's recipe), restoring every
// shared singleton it touches (sysState.nostdout, the builtin table, sv,
// svs) in afterAll.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { buildBsp, writeGameFile } from "./support/bsp_builder";
import { EdictT, pr, PR_SetEngineString } from "../src/progs/progs";
import { PR_LoadProgs, PR_AllocEdicts, ED_FindFunction } from "../src/progs/pr_edict";
import { functionIndex } from "../src/progs/pr_edict_core";
import { getBuiltins, setBuiltins, type BuiltinT } from "../src/progs/pr_exec";
import { OFS_RETURN } from "../src/progs/pr_comp";
import { sv, svs, MOVETYPE_NONE, MOVETYPE_STEP, SOLID_BSP, SOLID_NOT, FL_ONGROUND } from "../src/server/server";
import { SV_ClearWorld, SV_LinkEdict } from "../src/server/world";
import { host } from "../src/common/host";
import { Cvar_RegisterVariable } from "../src/common/cvar";
import { sysState } from "../src/platform/sys";
import { sv_gravity, sv_maxvelocity, sv_friction, sv_stopspeed, sv_nostep, SV_RunThink, SV_Physics } from "../src/server/sv_phys";
import { SV_WriteEntitiesToClient } from "../src/server/sv_main";
import { PROTOCOL_FITZQUAKE, PROTOCOL_NETQUAKE } from "../src/common/protocol";
import { SizeBuf } from "../src/common/sizebuf";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "protocol-lerpfinish-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;
const savedBuiltins = getBuiltins();
const savedSvProtocol = sv.protocol;
const savedSvsMaxclients = svs.maxclients;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setBuiltins(savedBuiltins);
  sv.protocol = savedSvProtocol;
  svs.maxclients = savedSvsMaxclients;
  rmSync(scratchDir, { recursive: true, force: true });
});

let mod: ModelT;
let subNullIndex: number;

// Same fixture recipe as test/sv_phys.test.ts: a single z=0 split-plane BSP
// (solid below, empty above) plus the real progs106 fixture, needed for
// pr.global_struct (SV_Physics unconditionally runs StartFrame) and for a
// real, harmless bound `think` function (subs.qc's `void() SUB_Null = {};`)
// so SV_RunThink's due-this-frame path can call PR_ExecuteProgram without
// throwing "NULL function".
beforeAll(() => {
  sysState.nostdout = 1;

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
  PR_AllocEdicts(32);

  const builtins: BuiltinT[] = [];
  for (let i = 0; i < 46; i++) builtins.push(() => {});
  builtins[45] = () => {
    // float(string s) cvar = #45; -- StartFrame's return value is unused
    // beyond assigning it to a global.
    if (pr.globals === null) throw new Error("protocol_lerpfinish.test: pr.globals not set");
    pr.globals.f[OFS_RETURN] = 0;
  };
  setBuiltins(builtins);

  Cvar_RegisterVariable(sv_friction);
  Cvar_RegisterVariable(sv_stopspeed);
  Cvar_RegisterVariable(sv_gravity);
  Cvar_RegisterVariable(sv_maxvelocity);
  Cvar_RegisterVariable(sv_nostep);

  sv.worldmodel = mod;
  sv.models[1] = mod;
  sv.edicts[0].v.solid = SOLID_BSP;
  sv.edicts[0].v.movetype = MOVETYPE_NONE;
  sv.edicts[0].v.modelindex = 1;
  svs.maxclients = 0; // SV_Physics never takes the client dispatch arm
  sv.num_edicts = 32;

  SV_ClearWorld();

  const found = ED_FindFunction("SUB_Null");
  if (found === null) throw new Error("expected progs106 to declare SUB_Null");
  subNullIndex = functionIndex(found);
});

//============================================================================

describe.skipIf(!HAVE_PROGS106)("SV_RunThink", () => {
  test("a think that fires this frame records oldthinktime/oldframe and clears nextthink", () => {
    const ent = sv.edicts[1];
    ent.v.movetype = MOVETYPE_NONE;
    ent.v.solid = SOLID_NOT;
    ent.v.think = subNullIndex;
    ent.v.frame = 7;
    ent.oldthinktime = 0;
    ent.oldframe = 0;
    sv.time = 100;
    ent.v.nextthink = 100; // due exactly now

    const ran = SV_RunThink(ent);

    expect(ran).toBe(true);
    expect(ent.oldthinktime).toBe(100);
    expect(ent.oldframe).toBe(7);
    expect(ent.v.nextthink).toBe(0); // SV_RunThink always clears it before the think call
  });

  test("a think not yet due leaves oldthinktime/oldframe/nextthink untouched", () => {
    const ent = sv.edicts[1];
    ent.v.movetype = MOVETYPE_NONE;
    ent.v.solid = SOLID_NOT;
    ent.v.think = subNullIndex;
    ent.v.frame = 3;
    ent.oldthinktime = 42;
    ent.oldframe = 9;
    host.frametime = 0.02;
    sv.time = 100;
    ent.v.nextthink = 100.12; // beyond sv.time + host.frametime

    const ran = SV_RunThink(ent);

    expect(ran).toBe(true);
    expect(ent.oldthinktime).toBe(42);
    expect(ent.oldframe).toBe(9);
    expect(ent.v.nextthink).toBeCloseTo(100.12, 5);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_Physics sendinterval gate", () => {
  // Every case below leaves the entity's nextthink beyond sv.time +
  // host.frametime, so SV_Physics_None/SV_Physics_Step's own SV_RunThink
  // call takes the not-yet-due branch above and never disturbs the
  // hand-set oldthinktime/oldframe/nextthink -- exactly the steady state
  // between two think fires that Ironwail's gate runs in every frame.
  const savedNumEdicts = () => sv.num_edicts;

  test("MOVETYPE_STEP with a 0.12s interval (j=31) sets sendinterval true", () => {
    const ent = sv.edicts[2];
    ent.free = false;
    ent.v.movetype = MOVETYPE_STEP;
    ent.v.solid = SOLID_NOT;
    ent.v.flags = FL_ONGROUND; // skip SV_Physics_Step's freefall block
    ent.v.frame = 4;
    ent.oldframe = 4; // unchanged: the STEP/WALK arm of the gate carries this case
    ent.oldthinktime = 10;
    ent.v.nextthink = 10.12; // interval 0.12s -> Q_rint(0.12*255) = Q_rint(30.6) = 31
    host.frametime = 0.02;
    sv.time = 10.05;

    const n = savedNumEdicts();
    sv.num_edicts = 3; // world(0), ent(1) from the SV_RunThink block above, this ent(2)
    SV_Physics();
    sv.num_edicts = n;

    expect(ent.sendinterval).toBe(true);
  });

  test("MOVETYPE_STEP with exactly a 0.1s interval (j=26) sets sendinterval false", () => {
    const ent = sv.edicts[2];
    ent.free = false;
    ent.v.movetype = MOVETYPE_STEP;
    ent.v.solid = SOLID_NOT;
    ent.v.flags = FL_ONGROUND;
    ent.v.frame = 4;
    ent.oldframe = 4;
    ent.oldthinktime = 10;
    ent.v.nextthink = 10.1; // interval 0.1s -> Q_rint(25.5) = 26, excluded
    host.frametime = 0.02;
    sv.time = 10.05;

    const n = savedNumEdicts();
    sv.num_edicts = 3;
    SV_Physics();
    sv.num_edicts = n;

    expect(ent.sendinterval).toBe(false);
  });

  test("MOVETYPE_NONE with an unchanged frame and no due think never sets sendinterval", () => {
    const ent = sv.edicts[2];
    ent.free = false;
    ent.v.movetype = MOVETYPE_NONE;
    ent.v.solid = SOLID_NOT;
    ent.v.frame = 4;
    ent.oldframe = 4; // unchanged, and MOVETYPE_NONE is neither STEP nor WALK
    ent.oldthinktime = 10;
    ent.v.nextthink = 10.12;
    host.frametime = 0.02;
    sv.time = 10.05;

    const n = savedNumEdicts();
    sv.num_edicts = 3;
    SV_Physics();
    sv.num_edicts = n;

    expect(ent.sendinterval).toBe(false);
  });

  test("MOVETYPE_NONE with a changed frame sets sendinterval true via the `frame != oldframe` half of the rule", () => {
    // U16 dropped this half of Ironwail's condition for lack of `oldframe`;
    // it is exercised here now that EdictBaseT carries it.
    const ent = sv.edicts[2];
    ent.free = false;
    ent.v.movetype = MOVETYPE_NONE;
    ent.v.solid = SOLID_NOT;
    ent.v.frame = 5;
    ent.oldframe = 4; // changed since the last think
    ent.oldthinktime = 10;
    ent.v.nextthink = 10.12; // interval 0.12s -> j=31, in range
    host.frametime = 0.02;
    sv.time = 10.05;

    const n = savedNumEdicts();
    sv.num_edicts = 3;
    SV_Physics();
    sv.num_edicts = n;

    expect(ent.sendinterval).toBe(true);
  });
});

describe.skipIf(!HAVE_PROGS106)("SV_WriteEntitiesToClient reads ent.sendinterval/lerpfinish", () => {
  function baselineMatchedEntity(index: number): EdictT {
    const ent = sv.edicts[index];
    ent.free = false;
    ent.v.solid = SOLID_NOT;
    ent.v.movetype = MOVETYPE_NONE;
    // Reset every field the wire delta looks at: this index may carry stale
    // values left by an earlier describe block's edict reuse.
    ent.v.frame = 0;
    ent.v.colormap = 0;
    ent.v.skin = 0;
    ent.v.effects = 0;
    ent.v.angles[0] = 0;
    ent.v.angles[1] = 0;
    ent.v.angles[2] = 0;
    ent.v.think = 0;
    ent.v.nextthink = 0;
    ent.v.modelindex = 5;
    ent.v.model = PR_SetEngineString("progs/somemodel.mdl");
    ent.v.origin[0] = 0;
    ent.v.origin[1] = 0;
    ent.v.origin[2] = 50; // inside leaf 1 (empty, PVS-visible), above the z=0 split plane
    ent.v.mins[0] = -8;
    ent.v.mins[1] = -8;
    ent.v.mins[2] = -8;
    ent.v.maxs[0] = 8;
    ent.v.maxs[1] = 8;
    ent.v.maxs[2] = 8;
    // Matched to the entity's own current values, so the only bits the
    // delta can produce are the sendinterval/lerpfinish ones under test.
    ent.baseline.modelindex = 5;
    ent.baseline.origin[0] = 0;
    ent.baseline.origin[1] = 0;
    ent.baseline.origin[2] = 50;
    SV_LinkEdict(ent, false);
    return ent;
  }

  test("666 emits U_LERPFINISH with nextthink - sv.time scaled to 0-255 when ent.sendinterval is true", () => {
    const world = sv.edicts[0];
    const ent = baselineMatchedEntity(1);
    ent.sendinterval = true;
    sv.time = 10;
    ent.v.nextthink = 10.12; // lerpfinish = 0.12 -> Q_rint(0.12*255) = 31

    sv.protocol = PROTOCOL_FITZQUAKE;
    const n = sv.num_edicts;
    sv.num_edicts = 2; // world(0), ent(1)

    const msg = new SizeBuf();
    msg.data = new Uint8Array(64);
    msg.maxsize = 64;
    msg.cursize = 0;
    SV_WriteEntitiesToClient(world, msg);
    sv.num_edicts = n;

    const bytes = Array.from(msg.data.subarray(0, msg.cursize));
    // bits: U_LERPFINISH(0x80000) -> >=65536 -> U_EXTEND1(0x8000) -> >=256 ->
    // U_MOREBITS(0x1). bits = 0x88001.
    // byte0 = (bits & 0xff) | U_SIGNAL(0x80) = 0x01 | 0x80 = 0x81
    // byte1 = bits>>8 & 0xff = 0x80 (MOREBITS extra byte)
    // byte2 = bits>>16 & 0xff = 0x08 (EXTEND1 extra byte)
    // byte3 = entity number 1
    // byte4 = Q_rint(0.12 * 255) = 31 = 0x1f
    expect(bytes).toEqual([0x81, 0x80, 0x08, 0x01, 0x1f]);
  });

  test("666 sends no U_LERPFINISH bit when ent.sendinterval is false, whatever nextthink holds", () => {
    const world = sv.edicts[0];
    const ent = baselineMatchedEntity(1);
    ent.sendinterval = false;
    sv.time = 10;
    ent.v.nextthink = 10.12; // would be included if sendinterval were true

    sv.protocol = PROTOCOL_FITZQUAKE;
    const n = sv.num_edicts;
    sv.num_edicts = 2;

    const msg = new SizeBuf();
    msg.data = new Uint8Array(64);
    msg.maxsize = 64;
    msg.cursize = 0;
    SV_WriteEntitiesToClient(world, msg);
    sv.num_edicts = n;

    const bytes = Array.from(msg.data.subarray(0, msg.cursize));
    // No bit at all is set (every field matches the baseline): just the
    // bare U_SIGNAL byte and the entity number.
    expect(bytes).toEqual([0x80, 0x01]);
  });

  test("protocol 15 never emits U_LERPFINISH even when ent.sendinterval is true", () => {
    const world = sv.edicts[0];
    const ent = baselineMatchedEntity(1);
    ent.sendinterval = true;
    sv.time = 10;
    ent.v.nextthink = 10.12;

    sv.protocol = PROTOCOL_NETQUAKE;
    const n = sv.num_edicts;
    sv.num_edicts = 2;

    const msg = new SizeBuf();
    msg.data = new Uint8Array(64);
    msg.maxsize = 64;
    msg.cursize = 0;
    SV_WriteEntitiesToClient(world, msg);
    sv.num_edicts = n;

    const bytes = Array.from(msg.data.subarray(0, msg.cursize));
    expect(bytes).toEqual([0x80, 0x01]); // identical to the sendinterval=false case above
  });
});
