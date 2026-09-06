/*
U9: the 2021 re-release's engine-side extensions (src/progs/ext/**), plus the
ruleset-gated physics and effects masking they switch on.

Four layers, each guarded on what the checkout actually has:

1. No fixture at all: the extension registry's answers per behaviour profile,
   the debug-draw list's lifetimes, and the print formatter's classic
   concatenation path.
2. progs106/progs.dat (../qsrc/quake, HAVE_PROGS106): ruleset detection on a
   classic progs, the EF_QEX_* mask a classic progs gets, the print formatter
   over a real progs' string block and a synthetic loc table, and
   MOVETYPE_GIB / SOLID_CORPSE on synthetic edicts in the bsp_builder map.
3. The retail re-release id1 progs.dat, pulled out of
   <Q1TS_DATA>/rerelease/id1/pak0.pak with test/support/pak_reader.ts: every
   `= #0:ex_*` name binds, ruleset detection says `rerelease`, the effects mask
   opens up, and each builtin is driven directly through the bound slot with
   synthetic parms -- asserting the bytes it writes and the state it changes.

Self-sufficiency (standing order 13): its own scratch basedirs, and every
shared singleton it touches restored in afterAll -- the builtin table
(getBuiltins/setBuiltins), sv/svs, the active progs profile, the loc table, the
`sv_ruleset`/`sv_debugdraw` cvar strings, sysState.nostdout and
com_searchpaths.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop, setComSearchpaths } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, writeGameFile } from "./support/bsp_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } from "../src/common/cvar";
import { host } from "../src/common/host";
import { vec3 } from "../src/common/mathlib";
import { SizeBuf, SZ_Alloc } from "../src/common/sizebuf";
import { PROMPT_BEGIN, PROMPT_CHOICE, PROMPT_CLEAR, SvcOpsT, svc_localsound, svc_prompt } from "../src/common/protocol";
import { sysState } from "../src/platform/sys";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_PARM4, OFS_RETURN } from "../src/progs/pr_comp";
import { EdictT, PR_SetEngineString, pr } from "../src/progs/progs";
import { ED_FindFunction, PR_AllocEdicts, PR_LoadProgs } from "../src/progs/pr_edict";
import { getBuiltins, prExec, setBuiltins } from "../src/progs/pr_exec";
import { PR_SetProfile } from "../src/progs/profiles/profile";
import { nqProfile } from "../src/progs/profiles/nq";
import { pr_builtin } from "../src/progs/pr_cmds";
import {
  ClientT,
  FL_ONGROUND,
  MOVETYPE_BOUNCE,
  MOVETYPE_PUSH,
  MOVETYPE_TOSS,
  SOLID_BBOX,
  SOLID_BSP,
  ServerStateT,
  sv,
  svs,
} from "../src/server/server";
import { MOVE_NORMAL, SV_ClearWorld, SV_LinkEdict, SV_Move } from "../src/server/world";
import { SV_Physics_Toss, sv_gravity, sv_maxvelocity, sv_friction, sv_stopspeed, sv_nostep } from "../src/server/sv_phys";
import {
  EF_QEX_CANDLELIGHT,
  EF_QEX_PENTALIGHT,
  EF_QEX_QUADLIGHT,
  MOVETYPE_GIB,
  QEX_AfterLoadProgs,
  QEX_DetectRuleset,
  QEX_LoadLocTable,
  QEX_LocTableLoaded,
  RULESET_CLASSIC,
  RULESET_RERELEASE,
  SOLID_CORPSE,
  SV_EffectsMask,
  SV_Ruleset,
  sv_ruleset,
} from "../src/progs/ext/ruleset";
import { PEF_CHANGENEVER, PEF_CHANGEONLYNEW, QEX_ClearLevel, QEX_Extensions, QEX_NamedBuiltins, QEX_SetClientExFlags, SETCOLOR_BUILTIN } from "../src/progs/ext/qex";
import { QEX_DebugDrawAdd, QEX_DebugDrawClear, QEX_DebugDrawExpire, QEX_DebugShapes, sv_debugdraw } from "../src/progs/ext/qex_draw";
import { QEX_VarString } from "../src/progs/ext/qex_print";
import { BOT_GOAL_ERROR, PATH_ERROR } from "../src/progs/ext/qex_hooks";
import { PakFile } from "./support/pak_reader";
import { HAVE_DATA, HAVE_PROGS106, PROGS106_DAT } from "./support/fixture_availability";

//============================================================================
// fixtures

const RERELEASE_PAK = HAVE_DATA ? join(process.env.Q1TS_DATA ?? "", "rerelease", "id1", "pak0.pak") : "";
const HAVE_RERELEASE_PROGS = RERELEASE_PAK !== "" && existsSync(RERELEASE_PAK);

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qex-builtins-"));
const classicDir = join(scratchDir, "classic");
const rereleaseDir = join(scratchDir, "rerelease");

const savedNostdout = sysState.nostdout;
const savedBuiltins = getBuiltins();
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
const savedFrametime = host.frametime;
let savedRuleset = "auto";
let savedDebugdraw = "0";

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setBuiltins(savedBuiltins);
  QEX_LoadLocTable(null);
  QEX_DebugDrawClear();
  QEX_ClearLevel();
  sv.clear();
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;
  host.frametime = savedFrametime;
  if (Cvar_FindVar("sv_ruleset") !== null) Cvar_Set("sv_ruleset", savedRuleset);
  if (Cvar_FindVar("sv_debugdraw") !== null) Cvar_Set("sv_debugdraw", savedDebugdraw);
  setComSearchpaths(null);
  rmSync(scratchDir, { recursive: true, force: true });
});

function popLmp(): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    bytes[i * 2] = (pop[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = pop[i] & 0xff;
  }
  return bytes;
}

function makeBaseDir(dir: string, progsDat: Uint8Array): void {
  mkdirSync(join(dir, "id1"), { recursive: true });
  writeGameFile(dir, "id1/maps/world.bsp", buildBsp());
  writePakToDisk(join(dir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp() },
    { name: "progs.dat", data: progsDat },
  ]);
}

/** Points the filesystem at `dir` and loads its progs under the nq profile. */
function loadProgsFrom(dir: string): ModelT | null {
  setComSearchpaths(null);
  COM_InitArgv(["quake", "-basedir", dir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();
  const mod = Mod_ForName("maps/world.bsp", false);
  PR_SetProfile(nqProfile);
  PR_LoadProgs();
  PR_AllocEdicts(64);
  QEX_AfterLoadProgs();
  QEX_ClearLevel();
  return mod;
}

/** svs.clients with `n` connected, spawned clients whose message buffers are
 * fresh -- the shape every print/prompt/localsound builtin writes into. */
function makeClients(n: number): ClientT[] {
  svs.maxclients = n;
  svs.maxclientslimit = n;
  svs.clients = [];
  for (let i = 0; i < n; i++) {
    const client = new ClientT();
    client.active = true;
    client.spawned = true;
    SZ_Alloc(client.message, 8000);
    client.edict = sv.edicts[i + 1];
    svs.clients.push(client);
  }
  sv.num_edicts = Math.max(sv.num_edicts, n + 1);
  return svs.clients;
}

/** The bytes a SizeBuf holds, as plain numbers. */
function bytesOf(buf: SizeBuf): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.cursize; i++) out.push(buf.data[i]);
  return out;
}

/** Reads a NUL-terminated string out of a SizeBuf starting at `at`; returns the
 * string and the offset just past its terminator. */
function readString(buf: SizeBuf, at: number): { s: string; next: number } {
  let s = "";
  let i = at;
  for (; i < buf.cursize && buf.data[i] !== 0; i++) s += String.fromCharCode(buf.data[i]);
  return { s, next: i + 1 };
}

/** Writes `args` into OFS_PARM0.. as progs strings and sets argc. */
function setStringParms(...args: string[]): void {
  const globals = pr.globals;
  if (globals === null) throw new Error("qex_builtins.test: pr.globals not set");
  for (let i = 0; i < args.length; i++) globals.i[OFS_PARM0 + i * 3] = PR_SetEngineString(args[i]);
  prExec.argc = args.length;
}

function namedBuiltin(name: string): () => void {
  const fn = QEX_NamedBuiltins().get(name);
  if (fn === undefined) throw new Error(`qex_builtins.test: no named builtin ${name}`);
  return fn;
}

beforeAll(() => {
  sysState.nostdout = 1;
  if (Cvar_FindVar("sv_ruleset") === null) Cvar_RegisterVariable(sv_ruleset);
  if (Cvar_FindVar("sv_debugdraw") === null) Cvar_RegisterVariable(sv_debugdraw);
  savedRuleset = sv_ruleset.string;
  savedDebugdraw = sv_debugdraw.string;
  for (const cvar of [sv_gravity, sv_maxvelocity, sv_friction, sv_stopspeed, sv_nostep]) {
    if (Cvar_FindVar(cvar.name) === null) Cvar_RegisterVariable(cvar);
  }

  if (HAVE_PROGS106) makeBaseDir(classicDir, new Uint8Array(readFileSync(PROGS106_DAT)));
  if (HAVE_RERELEASE_PROGS) makeBaseDir(rereleaseDir, new PakFile(RERELEASE_PAK).read("progs.dat"));
});

//============================================================================
// Layer 1: no fixture needed

describe("the extension registry", () => {
  test("answers the re-release's four names under the rerelease profile and nothing under classic", () => {
    Cvar_Set("sv_ruleset", "rerelease");
    const rerelease = QEX_Extensions();
    for (const name of ["EX_EXTENDED_EF", "EX_MOVETYPE_GIB", "EX_PROMPT", "DP_SV_SETCOLOR"]) {
      expect(rerelease.has(name)).toBe(true);
    }
    expect(rerelease.has("DP_QC_SOMETHING_ELSE")).toBe(false);

    Cvar_Set("sv_ruleset", "classic");
    expect(QEX_Extensions().size).toBe(0);
    Cvar_Set("sv_ruleset", "auto");
  });

  test("sv_ruleset forces the profile either way and auto falls back to what was detected", () => {
    Cvar_Set("sv_ruleset", "classic");
    expect(SV_Ruleset()).toBe(RULESET_CLASSIC);
    Cvar_Set("sv_ruleset", "rerelease");
    expect(SV_Ruleset()).toBe(RULESET_RERELEASE);
    Cvar_Set("sv_ruleset", "auto");
    expect([RULESET_CLASSIC, RULESET_RERELEASE]).toContain(SV_Ruleset());
  });
});

describe("the debug-draw list", () => {
  test("records nothing while sv_debugdraw is 0", () => {
    Cvar_Set("sv_debugdraw", "0");
    QEX_DebugDrawClear();
    expect(QEX_DebugDrawAdd({ kind: "bounds", colormap: 251, lifetime: 0, depthtest: 0, time: 1 })).toBeNull();
    expect(QEX_DebugShapes().length).toBe(0);
  });

  test("a lifetime-0 shape survives the frame it was recorded in and no longer", () => {
    Cvar_Set("sv_debugdraw", "1");
    QEX_DebugDrawClear();
    QEX_DebugDrawAdd({ kind: "bounds", a: vec3(-16, -16, -16), b: vec3(16, 16, 16), colormap: 251, lifetime: 0, depthtest: 0, time: 10 });
    QEX_DebugDrawExpire(10);
    expect(QEX_DebugShapes().length).toBe(1);
    QEX_DebugDrawExpire(10.1);
    expect(QEX_DebugShapes().length).toBe(0);

    QEX_DebugDrawAdd({ kind: "line", colormap: 4, lifetime: 5, depthtest: 1, time: 10 });
    QEX_DebugDrawExpire(14);
    expect(QEX_DebugShapes().length).toBe(1);
    QEX_DebugDrawExpire(16);
    expect(QEX_DebugShapes().length).toBe(0);
    Cvar_Set("sv_debugdraw", "0");
  });
});

//============================================================================
// Layer 2: progs106

describe.skipIf(!HAVE_PROGS106)("a classic progs", () => {
  beforeAll(() => {
    loadProgsFrom(classicDir);
  });

  test("is detected as the classic behaviour profile", () => {
    expect(ED_FindFunction("centerprint")).not.toBeNull();
    expect(ED_FindFunction("ex_centerprint")).toBeNull();
    expect(QEX_DetectRuleset()).toBe(RULESET_CLASSIC);
    Cvar_Set("sv_ruleset", "auto");
    expect(SV_Ruleset()).toBe(RULESET_CLASSIC);
  });

  test("has the EF_QEX_* bits masked out of the wire", () => {
    const mask = SV_EffectsMask();
    expect(mask & EF_QEX_QUADLIGHT).toBe(0);
    expect(mask & EF_QEX_PENTALIGHT).toBe(0);
    expect(mask & EF_QEX_CANDLELIGHT).toBe(0);
    // everything below bit 16 still passes
    expect(mask & 15).toBe(15);
  });

  test("loads no loc table, so prints concatenate exactly as WinQuake's PF_VarString did", () => {
    expect(QEX_LocTableLoaded()).toBe(false);
    setStringParms("You got the ", "Thunderbolt", "\n");
    expect(QEX_VarString(0)).toBe("You got the Thunderbolt\n");
    setStringParms("client", "a", "b");
    expect(QEX_VarString(1)).toBe("ab");
  });
});

describe.skipIf(!HAVE_PROGS106)("the print formatter with a loc table loaded", () => {
  beforeAll(() => {
    loadProgsFrom(classicDir);
    QEX_LoadLocTable(new TextEncoder().encode(['qc_entered = "{0} entered the game\\n"', 'qc_plain = "Welcome!"', 'qc_two = "{1} beat {0}"'].join("\n")));
  });

  afterAll(() => {
    QEX_LoadLocTable(null);
  });

  test("$key with placeholders substitutes the remaining arguments", () => {
    setStringParms("$qc_entered", "Ranger");
    expect(QEX_VarString(0)).toBe("Ranger entered the game\n");
  });

  test("positional indices are honoured", () => {
    setStringParms("$qc_two", "Ranger", "Shambler");
    expect(QEX_VarString(0)).toBe("Shambler beat Ranger");
  });

  test("a $key with no placeholders concatenates its extra arguments, as the C's no-placeholder branch does", () => {
    setStringParms("$qc_plain", " Ranger");
    expect(QEX_VarString(0)).toBe("Welcome! Ranger");
  });

  test("an unknown $key falls back to the key text", () => {
    setStringParms("$qc_missing");
    expect(QEX_VarString(0)).toBe("qc_missing");
  });

  test("a plain string with no placeholders still concatenates", () => {
    setStringParms("a", "b", "c");
    expect(QEX_VarString(0)).toBe("abc");
  });

  test("an in-place format with placeholders substitutes without any $key", () => {
    setStringParms("{0} capacity increased to {1}!\n", "Nails", "200");
    expect(QEX_VarString(0)).toBe("Nails capacity increased to 200!\n");
  });

  test("sprint's first parameter is skipped", () => {
    setStringParms("client", "$qc_entered", "Ranger");
    expect(QEX_VarString(1)).toBe("Ranger entered the game\n");
  });
});

describe.skipIf(!HAVE_PROGS106)("MOVETYPE_GIB", () => {
  let mod: ModelT | null = null;

  beforeAll(() => {
    mod = loadProgsFrom(classicDir);
    sv.worldmodel = mod;
    if (mod !== null) sv.models[1] = mod;
    sv.edicts[0].v.solid = SOLID_BSP;
    sv.edicts[0].v.movetype = MOVETYPE_PUSH;
    sv.edicts[0].v.modelindex = 1;
    sv.num_edicts = 32;
    sv.state = ServerStateT.ss_active;
    SV_ClearWorld();
    host.frametime = 0.1;
  });

  function gib(z: number, vz: number): EdictT {
    const e = sv.edicts[6];
    e.free = false;
    e.fields.i.fill(0);
    e.v.origin[0] = 0;
    e.v.origin[1] = 0;
    e.v.origin[2] = z;
    for (let i = 0; i < 3; i++) {
      e.v.mins[i] = 0;
      e.v.maxs[i] = 0;
      e.v.velocity[i] = 0;
    }
    e.v.velocity[2] = vz;
    SV_LinkEdict(e, false);
    return e;
  }

  test("bounces off the floor under the rerelease profile, the way MOVETYPE_BOUNCE does", () => {
    Cvar_Set("sv_ruleset", "rerelease");
    const bounce = gib(40, -400);
    bounce.v.movetype = MOVETYPE_BOUNCE;
    SV_Physics_Toss(bounce);
    const bounceVelocity = bounce.v.velocity[2];
    const bounceFlags = bounce.v.flags | 0;

    const g = gib(40, -400);
    g.v.movetype = MOVETYPE_GIB;
    SV_Physics_Toss(g);

    expect(g.v.velocity[2]).toBeCloseTo(bounceVelocity, 5);
    expect(g.v.flags | 0).toBe(bounceFlags);
    expect(g.v.velocity[2]).toBeGreaterThan(0); // it really came back up
    Cvar_Set("sv_ruleset", "auto");
  });

  test("stops dead like MOVETYPE_TOSS under the classic profile", () => {
    Cvar_Set("sv_ruleset", "classic");
    const toss = gib(40, -400);
    toss.v.movetype = MOVETYPE_TOSS;
    SV_Physics_Toss(toss);

    const g = gib(40, -400);
    g.v.movetype = MOVETYPE_GIB;
    SV_Physics_Toss(g);

    expect(g.v.velocity[2]).toBeCloseTo(toss.v.velocity[2], 5);
    expect(g.v.flags | 0).toBe(toss.v.flags | 0);
    expect((g.v.flags | 0) & FL_ONGROUND).toBe(FL_ONGROUND);
    Cvar_Set("sv_ruleset", "auto");
  });

  test("scales gravity by the entity's own gravity field, which is what 'adjustable gravity' means", () => {
    Cvar_Set("sv_ruleset", "rerelease");
    // progs106 has no `.gravity` field, so SV_AddGravity's lookup misses and
    // the multiplier is 1 -- the same answer Ironwail's own SV_AddGravity
    // gives for a progs without the field.
    const g = gib(400, 0);
    g.v.movetype = MOVETYPE_GIB;
    SV_Physics_Toss(g);
    expect(g.v.velocity[2]).toBeCloseTo(-sv_gravity.value * host.frametime, 4);
    Cvar_Set("sv_ruleset", "auto");
  });
});

describe.skipIf(!HAVE_PROGS106)("SOLID_CORPSE", () => {
  beforeAll(() => {
    const mod = loadProgsFrom(classicDir);
    sv.worldmodel = mod;
    if (mod !== null) sv.models[1] = mod;
    sv.edicts[0].v.solid = SOLID_BSP;
    sv.edicts[0].v.movetype = MOVETYPE_PUSH;
    sv.edicts[0].v.modelindex = 1;
    sv.num_edicts = 32;
    sv.state = ServerStateT.ss_active;
    SV_ClearWorld();
  });

  function corpse(solid: number): EdictT {
    const e = sv.edicts[7];
    e.free = false;
    e.fields.i.fill(0);
    e.v.solid = solid;
    e.v.origin[0] = 64;
    e.v.origin[1] = 0;
    e.v.origin[2] = 32;
    for (let i = 0; i < 3; i++) {
      e.v.mins[i] = i === 2 ? -24 : -16;
      e.v.maxs[i] = i === 2 ? 24 : 16;
      e.v.size[i] = e.v.maxs[i] - e.v.mins[i];
    }
    SV_LinkEdict(e, false);
    return e;
  }

  test("a point trace hits it (shootable) under the rerelease profile", () => {
    Cvar_Set("sv_ruleset", "rerelease");
    const e = corpse(SOLID_CORPSE);
    const trace = SV_Move(vec3(0, 0, 32), vec3(0, 0, 0), vec3(0, 0, 0), vec3(128, 0, 32), MOVE_NORMAL, null);
    expect(trace.fraction).toBeLessThan(1);
    expect(trace.ent).toBe(e);
    Cvar_Set("sv_ruleset", "auto");
  });

  test("a bounding-box move passes straight through it (not blocking)", () => {
    Cvar_Set("sv_ruleset", "rerelease");
    corpse(SOLID_CORPSE);
    const trace = SV_Move(vec3(0, 0, 32), vec3(-16, -16, -24), vec3(16, 16, 24), vec3(128, 0, 32), MOVE_NORMAL, null);
    expect(trace.fraction).toBe(1);

    // ...where the same entity as SOLID_BBOX does block it
    corpse(SOLID_BBOX);
    const blocked = SV_Move(vec3(0, 0, 32), vec3(-16, -16, -24), vec3(16, 16, 24), vec3(128, 0, 32), MOVE_NORMAL, null);
    expect(blocked.fraction).toBeLessThan(1);
    Cvar_Set("sv_ruleset", "auto");
  });

  test("is ignored entirely under the classic profile, where no content has solid 5", () => {
    Cvar_Set("sv_ruleset", "classic");
    corpse(SOLID_CORPSE);
    const trace = SV_Move(vec3(0, 0, 32), vec3(0, 0, 0), vec3(0, 0, 0), vec3(128, 0, 32), MOVE_NORMAL, null);
    expect(trace.fraction).toBe(1);
    Cvar_Set("sv_ruleset", "auto");
  });
});

//============================================================================
// Layer 3: the retail re-release progs

describe.skipIf(!HAVE_RERELEASE_PROGS)("the retail re-release id1 progs", () => {
  beforeAll(() => {
    loadProgsFrom(rereleaseDir);
    sv.state = ServerStateT.ss_active;
    sv.time = 100;
    SZ_Alloc(sv.reliable_datagram, 8000);
    makeClients(2);
  });

  test("is detected as the rerelease behaviour profile", () => {
    expect(ED_FindFunction("ex_centerprint")).not.toBeNull();
    expect(ED_FindFunction("centerprint")).toBeNull();
    expect(QEX_DetectRuleset()).toBe(RULESET_RERELEASE);
    Cvar_Set("sv_ruleset", "auto");
    expect(SV_Ruleset()).toBe(RULESET_RERELEASE);
  });

  test("declares EF_QUADLIGHT/EF_PENTALIGHT, so the EF_QEX_* bits reach the wire", () => {
    const mask = SV_EffectsMask();
    expect(mask & EF_QEX_QUADLIGHT).toBe(EF_QEX_QUADLIGHT);
    expect(mask & EF_QEX_PENTALIGHT).toBe(EF_QEX_PENTALIGHT);
    expect(mask & EF_QEX_CANDLELIGHT).toBe(EF_QEX_CANDLELIGHT);
  });

  test("binds every `= #0:ex_*` name to a real builtin, none to the unbound-name error", () => {
    const names = [
      "ex_bprint",
      "ex_sprint",
      "ex_centerprint",
      "ex_finaleFinished",
      "ex_localsound",
      "ex_draw_point",
      "ex_draw_line",
      "ex_draw_arrow",
      "ex_draw_ray",
      "ex_draw_circle",
      "ex_draw_bounds",
      "ex_draw_worldtext",
      "ex_draw_sphere",
      "ex_draw_cylinder",
      "ex_bot_movetopoint",
      "ex_bot_followentity",
      "ex_CheckPlayerEXFlags",
      "ex_walkpathtogoal",
    ];
    for (const name of names) {
      const func = ED_FindFunction(name);
      expect(func).not.toBeNull();
      if (func === null) continue;
      expect(func.first_statement).toBeLessThan(0);
      const slot = -func.first_statement;
      expect(pr.builtins[slot]).toBe(QEX_NamedBuiltins().get(name) ?? (() => {}));
    }
  });

  test("loads the retail loc table when the gamedir has one", () => {
    // The scratch basedir carries only progs.dat, so this asserts the shape of
    // the answer rather than the retail strings: no loc file, no loc table.
    expect(typeof QEX_LocTableLoaded()).toBe("boolean");
  });

  test("ex_bprint writes svc_print with the formatted text to every spawned client", () => {
    const clients = makeClients(2);
    QEX_LoadLocTable(new TextEncoder().encode('qc_entered = "{0} entered the game\\n"'));
    setStringParms("$qc_entered", "Ranger");
    namedBuiltin("ex_bprint")();

    for (const client of clients) {
      expect(client.message.data[0]).toBe(SvcOpsT.svc_print);
      expect(readString(client.message, 1).s).toBe("Ranger entered the game\n");
    }
    QEX_LoadLocTable(null);
  });

  test("ex_sprint and ex_centerprint write to one client only", () => {
    const clients = makeClients(2);
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");

    setStringParms("", "hello\n");
    globals.i[OFS_PARM0] = 1; // edict 1 is client 0
    namedBuiltin("ex_sprint")();
    expect(clients[0].message.data[0]).toBe(SvcOpsT.svc_print);
    expect(readString(clients[0].message, 1).s).toBe("hello\n");
    expect(clients[1].message.cursize).toBe(0);

    makeClients(2);
    setStringParms("", "centered");
    globals.i[OFS_PARM0] = 2; // edict 2 is client 1
    namedBuiltin("ex_centerprint")();
    expect(svs.clients[1].message.data[0]).toBe(SvcOpsT.svc_centerprint);
    expect(readString(svs.clients[1].message, 1).s).toBe("centered");
    expect(svs.clients[0].message.cursize).toBe(0);
  });

  test("ex_localsound writes Ironwail's svc_localsound payload: flags byte then the sound number", () => {
    const clients = makeClients(1);
    sv.sound_precache[1] = "misc/menu1.wav";
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");

    setStringParms("", "misc/menu1.wav");
    globals.i[OFS_PARM0] = 1;
    namedBuiltin("ex_localsound")();

    expect(bytesOf(clients[0].message)).toEqual([svc_localsound, 0, 1]);
  });

  test("ex_CheckPlayerEXFlags answers with the client's ex_flags word", () => {
    makeClients(1);
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");

    globals.i[OFS_PARM0] = 1;
    prExec.argc = 1;
    namedBuiltin("ex_CheckPlayerEXFlags")();
    expect(globals.f[OFS_RETURN]).toBe(PEF_CHANGEONLYNEW); // the default

    QEX_SetClientExFlags(0, PEF_CHANGENEVER);
    namedBuiltin("ex_CheckPlayerEXFlags")();
    expect(globals.f[OFS_RETURN]).toBe(PEF_CHANGENEVER);

    QEX_SetClientExFlags(0, 0);
    namedBuiltin("ex_CheckPlayerEXFlags")();
    expect(globals.f[OFS_RETURN]).toBe(0);

    // a non-client entity answers 0 rather than erroring
    globals.i[OFS_PARM0] = 30;
    namedBuiltin("ex_CheckPlayerEXFlags")();
    expect(globals.f[OFS_RETURN]).toBe(0);
  });

  test("ex_finaleFinished stays false until a client presses attack, and resets for the next finale", () => {
    const clients = makeClients(1);
    QEX_ClearLevel();
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");
    const player = clients[0].edict;
    if (player === null) throw new Error("client has no edict");

    prExec.argc = 0;
    sv.time = 200;
    player.v.button0 = 1; // already held when the finale opens: does not count
    namedBuiltin("ex_finaleFinished")();
    expect(globals.f[OFS_RETURN]).toBe(0);

    sv.time = 200.1;
    player.v.button0 = 0;
    namedBuiltin("ex_finaleFinished")();
    expect(globals.f[OFS_RETURN]).toBe(0);

    sv.time = 200.2;
    player.v.button0 = 1; // a real 0->1 edge
    namedBuiltin("ex_finaleFinished")();
    expect(globals.f[OFS_RETURN]).toBe(1);

    sv.time = 200.3;
    namedBuiltin("ex_finaleFinished")();
    expect(globals.f[OFS_RETURN]).toBe(1); // stays finished for this finale

    // a poll a long time later is a NEW finale, and the latch is clear again
    sv.time = 400;
    player.v.button0 = 0;
    namedBuiltin("ex_finaleFinished")();
    expect(globals.f[OFS_RETURN]).toBe(0);
  });

  test("the bot and nav builtins answer the QuakeC's own error codes with no hook installed", () => {
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");
    prExec.argc = 2;
    globals.i[OFS_PARM0] = 0;

    namedBuiltin("ex_bot_movetopoint")();
    expect(globals.f[OFS_RETURN]).toBe(BOT_GOAL_ERROR);
    namedBuiltin("ex_bot_followentity")();
    expect(globals.f[OFS_RETURN]).toBe(BOT_GOAL_ERROR);
    namedBuiltin("ex_walkpathtogoal")();
    expect(globals.f[OFS_RETURN]).toBe(PATH_ERROR);
  });

  test("ex_draw_bounds records mg3's own call shape when sv_debugdraw is on", () => {
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");
    QEX_DebugDrawClear();
    Cvar_Set("sv_debugdraw", "1");

    // draw_bounds( e.absmin, e.absmax, 251, 0, 0 ) -- quakec_mg3/client.qc:2162
    for (let i = 0; i < 3; i++) globals.f[OFS_PARM0 + i] = -16;
    for (let i = 0; i < 3; i++) globals.f[OFS_PARM1 + i] = 16;
    globals.f[OFS_PARM2] = 251;
    globals.f[OFS_PARM3] = 0;
    globals.f[OFS_PARM4] = 0;
    prExec.argc = 5;
    namedBuiltin("ex_draw_bounds")();

    const shapes = QEX_DebugShapes();
    expect(shapes.length).toBe(1);
    expect(shapes[0].kind).toBe("bounds");
    expect(shapes[0].colormap).toBe(251);
    expect(shapes[0].a[0]).toBe(-16);
    expect(shapes[0].b[2]).toBe(16);

    Cvar_Set("sv_debugdraw", "0");
    QEX_DebugDrawClear();
    namedBuiltin("ex_draw_bounds")();
    expect(QEX_DebugShapes().length).toBe(0);
  });

  test("the three prompt builtins write one svc_prompt message each, in call order", () => {
    const clients = makeClients(1);
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");

    // prompt(self, "$qc_ctf_intro", 4) -- quakec_ctf/status.qc:45
    setStringParms("", "Pick a team");
    globals.i[OFS_PARM0] = 1;
    globals.f[OFS_PARM2] = 4;
    prExec.argc = 3;
    namedBuiltin("ex_prompt")();

    // promptchoice(self, "$qc_ctf_intro_red", 101)
    setStringParms("", "Red");
    globals.i[OFS_PARM0] = 1;
    globals.f[OFS_PARM2] = 101;
    prExec.argc = 3;
    namedBuiltin("ex_promptchoice")();

    prExec.argc = 1;
    globals.i[OFS_PARM0] = 1;
    namedBuiltin("ex_clearprompt")();

    const msg = clients[0].message;
    expect(msg.data[0]).toBe(svc_prompt);
    expect(msg.data[1]).toBe(PROMPT_BEGIN);
    const begin = readString(msg, 2);
    expect(begin.s).toBe("Pick a team");
    expect(msg.data[begin.next]).toBe(4);

    let at = begin.next + 1;
    expect(msg.data[at]).toBe(svc_prompt);
    expect(msg.data[at + 1]).toBe(PROMPT_CHOICE);
    const choice = readString(msg, at + 2);
    expect(choice.s).toBe("Red");
    expect(msg.data[choice.next]).toBe(101);

    at = choice.next + 1;
    expect(msg.data[at]).toBe(svc_prompt);
    expect(msg.data[at + 1]).toBe(PROMPT_CLEAR);
    expect(msg.cursize).toBe(at + 2);
  });

  test("setcolor (builtin 401) stores the packed colour, sets team and broadcasts svc_updatecolors", () => {
    const clients = makeClients(2);
    sv.reliable_datagram.cursize = 0;
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");

    // quakec_ctf/teamplay.qc:150 packs `bottom + top * 16`
    globals.i[OFS_PARM0] = 2; // edict 2 is client 1
    globals.f[OFS_PARM1] = 4 + 3 * 16;
    prExec.argc = 2;
    pr_builtin[SETCOLOR_BUILTIN]();

    expect(clients[1].colors).toBe(3 * 16 + 4);
    expect(clients[1].edict?.v.team).toBe(5);
    expect(bytesOf(sv.reliable_datagram)).toEqual([SvcOpsT.svc_updatecolors, 1, 3 * 16 + 4]);
  });

  test("checkextension (builtin 99) answers the four re-release names", () => {
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");
    Cvar_Set("sv_ruleset", "auto"); // detected: rerelease

    for (const name of ["EX_EXTENDED_EF", "EX_MOVETYPE_GIB", "EX_PROMPT", "DP_SV_SETCOLOR"]) {
      globals.i[OFS_PARM0] = PR_SetEngineString(name);
      pr_builtin[99]();
      expect(globals.f[OFS_RETURN]).toBe(1);
    }

    globals.i[OFS_PARM0] = PR_SetEngineString("FTE_SOMETHING");
    pr_builtin[99]();
    expect(globals.f[OFS_RETURN]).toBe(0);
  });
});
