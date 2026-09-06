// Self-sufficient suite for src/progs/pr_cmds.ts. Follows test/pr_edict.test.ts's
// scratch-basedir recipe (real progs106/progs.dat via a synthetic id1/pak0.pak
// with gfx/pop.lmp so COM_CheckRegistered passes) plus test/world.test.ts's
// bsp_builder recipe for a loadable "maps/world.bsp", so PF_traceline has a
// real world to clip against. Builtins are driven directly by writing parms
// into pr.globals and calling `pr_builtin[N]()` -- no QuakeC bytecode runs.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, writeGameFile } from "./support/bsp_builder";
import { Mod_ForName, Mod_Init } from "../src/common/model";
import { CvarT, Cvar_RegisterVariable, Cvar_VariableValue } from "../src/common/cvar";
import { SvcOpsT } from "../src/common/protocol";
import { SZ_Alloc } from "../src/common/sizebuf";
import { PRRunError, prExec } from "../src/progs/pr_exec";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_RETURN } from "../src/progs/pr_comp";
import { EDICT_NUM, EDICT_TO_PROG, PROG_TO_EDICT, PR_GetString, PR_SetEngineString, type EdictT, pr } from "../src/progs/progs";
import { ED_FindField, PR_AllocEdicts, PR_LoadProgs } from "../src/progs/pr_edict";
import { MSG_BROADCAST, pr_builtin, pr_numbuiltins } from "../src/progs/pr_cmds";
import { ClientT, MOVETYPE_PUSH, ServerStateT, SOLID_BBOX, SOLID_BSP, sv, svs } from "../src/server/server";
import { SV_ClearWorld } from "../src/server/world";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "pr-cmds-test-"));
const baseDir = join(scratchDir, "quake");

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  // No throw: a missing progs106/progs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_PROGS106), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_PROGS106) return;
  const progsDat = new Uint8Array(readFileSync(PROGS_DAT));

  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: progsDat },
  ]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  PR_LoadProgs();
  PR_AllocEdicts(64);
  sv.num_edicts = 1;
  sv.time = 0;

  svs.maxclients = 1;
  const client = new ClientT();
  client.active = true;
  client.spawned = true;
  SZ_Alloc(client.message, 1024);
  svs.clients = [client];

  SZ_Alloc(sv.datagram, 1024);
  SZ_Alloc(sv.reliable_datagram, 1024);
  SZ_Alloc(sv.signon, 8192);

  // a loadable world for PF_traceline / PF_precache_model, per world.test.ts's
  // own recipe: buildBsp()'s split plane is z=0, solid below, empty above.
  const mod = Mod_ForName("maps/world.bsp", true);
  if (mod === null) throw new Error("expected maps/world.bsp to load");
  sv.worldmodel = mod;
  sv.models[1] = mod;

  const world = EDICT_NUM(0);
  world.v.solid = SOLID_BSP;
  world.v.movetype = MOVETYPE_PUSH;
  world.v.modelindex = 1;

  SV_ClearWorld();

  sv.state = ServerStateT.ss_loading;
});

//============================================================================
// parm/return helpers -- writing/reading pr.globals directly, matching
// pr_edict.test.ts's own habit of reaching through `pr` when a builtin-level
// test needs to poke the VM's storage directly rather than through QuakeC.

function requireGlobals(): { f: Float32Array; i: Int32Array } {
  if (pr.globals === null) throw new Error("pr.globals not set (PR_LoadProgs not called)");
  return pr.globals;
}

function setParmFloat(ofs: number, value: number): void {
  requireGlobals().f[ofs] = value;
}

function setParmInt(ofs: number, value: number): void {
  requireGlobals().i[ofs] = value;
}

function setParmVector(ofs: number, v: readonly [number, number, number]): void {
  const g = requireGlobals();
  g.f[ofs] = v[0];
  g.f[ofs + 1] = v[1];
  g.f[ofs + 2] = v[2];
}

function setParmString(ofs: number, s: string): void {
  requireGlobals().i[ofs] = PR_SetEngineString(s);
}

function setParmEdict(ofs: number, ed: EdictT): void {
  requireGlobals().i[ofs] = EDICT_TO_PROG(ed);
}

function returnFloat(): number {
  return requireGlobals().f[OFS_RETURN];
}

function returnVector(): [number, number, number] {
  const g = requireGlobals();
  return [g.f[OFS_RETURN], g.f[OFS_RETURN + 1], g.f[OFS_RETURN + 2]];
}

function returnString(): string {
  return PR_GetString(requireGlobals().i[OFS_RETURN]);
}

function returnEdictNum(): number {
  return requireGlobals().i[OFS_RETURN];
}

function readCString(data: Uint8Array, offset: number): string {
  let s = "";
  let i = offset;
  while (data[i] !== 0) {
    s += String.fromCharCode(data[i]);
    i++;
  }
  return s;
}

// PF_Spawn (#14), used to allocate a fresh edict through the builtin table
// itself rather than reaching for ED_Alloc directly.
function spawnEdict(): EdictT {
  pr_builtin[14]();
  return EDICT_NUM(returnEdictNum());
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("PF_normalize / PF_vlen / PF_vectoyaw / PF_vectoangles", () => {
  test("PF_normalize normalizes a (3,4,0) vector to length 1", () => {
    setParmVector(OFS_PARM0, [3, 4, 0]);
    pr_builtin[9]();
    const [x, y, z] = returnVector();
    expect(x).toBeCloseTo(0.6, 5);
    expect(y).toBeCloseTo(0.8, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  test("PF_normalize of the zero vector returns zero", () => {
    setParmVector(OFS_PARM0, [0, 0, 0]);
    pr_builtin[9]();
    expect(returnVector()).toEqual([0, 0, 0]);
  });

  test("PF_vlen of (3,4,0) is 5", () => {
    setParmVector(OFS_PARM0, [3, 4, 0]);
    pr_builtin[12]();
    expect(returnFloat()).toBeCloseTo(5, 5);
  });

  test("PF_vectoyaw of (1,1,0) is 45, truncated toward zero", () => {
    setParmVector(OFS_PARM0, [1, 1, 0]);
    pr_builtin[13]();
    expect(returnFloat()).toBe(45);
  });

  test("PF_vectoangles of straight up (0,0,5) is pitch 90, yaw 0", () => {
    setParmVector(OFS_PARM0, [0, 0, 5]);
    pr_builtin[51]();
    const g = requireGlobals();
    expect(g.f[OFS_RETURN]).toBe(90); // pitch
    expect(g.f[OFS_RETURN + 1]).toBe(0); // yaw
    expect(g.f[OFS_RETURN + 2]).toBe(0);
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_ftos / PF_vtos / PF_rint / PF_random", () => {
  test("PF_ftos formats an integer-valued float with %d", () => {
    setParmFloat(OFS_PARM0, 5);
    pr_builtin[26]();
    expect(returnString()).toBe("5");
  });

  test("PF_ftos formats a fractional float with %5.1f", () => {
    setParmFloat(OFS_PARM0, 2.5);
    pr_builtin[26]();
    expect(returnString()).toBe("  2.5");
  });

  test("PF_vtos formats a vector as three %5.1f fields, single-quoted", () => {
    setParmVector(OFS_PARM0, [1, 2, 3]);
    pr_builtin[27]();
    expect(returnString()).toBe("'  1.0   2.0   3.0'");
  });

  test("PF_rint rounds half away from zero", () => {
    setParmFloat(OFS_PARM0, 2.5);
    pr_builtin[36]();
    expect(returnFloat()).toBe(3);

    setParmFloat(OFS_PARM0, -2.5);
    pr_builtin[36]();
    expect(returnFloat()).toBe(-3);
  });

  test("PF_random returns a number in [0,1)", () => {
    for (let i = 0; i < 25; i++) {
      pr_builtin[7]();
      const v = returnFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_precache_sound / PF_precache_model", () => {
  test("PF_precache_sound inserts into sv.sound_precache", () => {
    setParmString(OFS_PARM0, "weapons/test_sound.wav");
    pr_builtin[19]();
    expect(sv.sound_precache).toContain("weapons/test_sound.wav");
  });

  test("PF_precache_sound called again with the same name does not duplicate it", () => {
    const before = sv.sound_precache.filter((s) => s === "weapons/test_sound.wav").length;
    setParmString(OFS_PARM0, "weapons/test_sound.wav");
    pr_builtin[19]();
    const after = sv.sound_precache.filter((s) => s === "weapons/test_sound.wav").length;
    expect(after).toBe(before);
    expect(after).toBe(1);
  });

  test("PF_precache_model inserts into sv.model_precache and loads the model", () => {
    setParmString(OFS_PARM0, "maps/world.bsp");
    pr_builtin[20]();
    const idx = sv.model_precache.indexOf("maps/world.bsp");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(sv.models[idx]).not.toBeNull();
  });

  test("PF_precache_model called again with the same name returns the existing index", () => {
    const before = sv.model_precache.filter((s) => s === "maps/world.bsp").length;
    setParmString(OFS_PARM0, "maps/world.bsp");
    pr_builtin[20]();
    const after = sv.model_precache.filter((s) => s === "maps/world.bsp").length;
    expect(after).toBe(before);
    expect(after).toBe(1);
  });

  test("PF_precache_sound/PF_precache_model outside ss_loading throw PRRunError", () => {
    const saved = sv.state;
    sv.state = ServerStateT.ss_active;
    try {
      setParmString(OFS_PARM0, "weapons/other.wav");
      expect(() => pr_builtin[19]()).toThrow(PRRunError);
      setParmString(OFS_PARM0, "maps/other.bsp");
      expect(() => pr_builtin[20]()).toThrow(PRRunError);
    } finally {
      sv.state = saved;
    }
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_Spawn / PF_Remove", () => {
  test("PF_Spawn allocates a non-free edict, PF_Remove frees it", () => {
    const ed = spawnEdict();
    expect(ed.free).toBe(false);

    setParmEdict(OFS_PARM0, ed);
    pr_builtin[15]();
    expect(ed.free).toBe(true);
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_Find", () => {
  test("finds an edict by classname, starting the search after the given edict", () => {
    const ed1 = spawnEdict();
    ed1.v.classname = PR_SetEngineString("pr_cmds_test_monster");

    const classnameOfs = ED_FindField("classname")?.ofs;
    if (classnameOfs === undefined) throw new Error("classname field not found");

    setParmEdict(OFS_PARM0, EDICT_NUM(0)); // start searching from the world edict
    setParmInt(OFS_PARM1, classnameOfs);
    setParmString(OFS_PARM2, "pr_cmds_test_monster");
    pr_builtin[18]();

    expect(returnEdictNum()).toBe(EDICT_TO_PROG(ed1));
  });

  test("returns the world edict when nothing matches", () => {
    const classnameOfs = ED_FindField("classname")?.ofs;
    if (classnameOfs === undefined) throw new Error("classname field not found");

    setParmEdict(OFS_PARM0, EDICT_NUM(0));
    setParmInt(OFS_PARM1, classnameOfs);
    setParmString(OFS_PARM2, "no_such_classname_anywhere");
    pr_builtin[18]();

    expect(returnEdictNum()).toBe(0);
  });

  // D.md Defect B: WinQuake's G_STRING/E_STRING macros are (pr_strings +
  // offset) -- never a NULL pointer, so the C's `if (!s)`/`if (!t)` checks
  // are dead code and an unset (empty) field is searched/matched like any
  // other value, not treated as an error. Reproduces func_train_find's
  // `find(world, targetname, self.target)` call in plats.qc for a
  // func_train whose `target` was never set.
  test("an empty search string does not throw, and matches an edict whose field is also empty", () => {
    const targetOfs = ED_FindField("target")?.ofs;
    if (targetOfs === undefined) throw new Error("target field not found");

    // a known starting point, so the search begins right after it and no
    // earlier test's edicts (whose `target` field this suite never touches,
    // but which this test must not depend on regardless) can interfere
    const start = spawnEdict();

    const emptyTarget = spawnEdict(); // .target left at its default (0 -> "")

    const nonEmptyTarget = spawnEdict();
    nonEmptyTarget.v.target = PR_SetEngineString("pr_cmds_test_target");

    setParmEdict(OFS_PARM0, start);
    setParmInt(OFS_PARM1, targetOfs);
    setParmString(OFS_PARM2, ""); // the empty search string itself
    expect(() => pr_builtin[18]()).not.toThrow();

    expect(returnEdictNum()).toBe(EDICT_TO_PROG(emptyTarget));
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_findradius", () => {
  test("chains every non-SOLID_NOT edict within the radius", () => {
    const a = spawnEdict();
    a.v.solid = SOLID_BBOX;
    a.v.origin[0] = 10;
    a.v.origin[1] = 0;
    a.v.origin[2] = 2000; // well clear of every other test's edicts

    const b = spawnEdict();
    b.v.solid = SOLID_BBOX;
    b.v.origin[0] = -10;
    b.v.origin[1] = 0;
    b.v.origin[2] = 2000;

    setParmVector(OFS_PARM0, [0, 0, 2000]);
    setParmFloat(OFS_PARM1, 50);
    pr_builtin[22]();

    const chainHead = EDICT_NUM(returnEdictNum());
    const seen = new Set<number>();
    let cur: EdictT | null = chainHead;
    while (cur !== null && cur !== EDICT_NUM(0)) {
      seen.add(EDICT_TO_PROG(cur));
      cur = PROG_TO_EDICT(cur.v.chain);
      if (cur === EDICT_NUM(0)) break;
    }
    expect(seen.has(EDICT_TO_PROG(a))).toBe(true);
    expect(seen.has(EDICT_TO_PROG(b))).toBe(true);
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_setorigin", () => {
  test("links the edict into the world (area list becomes non-null)", () => {
    const ed = spawnEdict();
    ed.v.solid = SOLID_BBOX;

    setParmEdict(OFS_PARM0, ed);
    setParmVector(OFS_PARM1, [5, 5, 5]);
    pr_builtin[2]();

    expect(ed.v.origin[0]).toBe(5);
    expect(ed.area.prev).not.toBeNull();
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_WriteByte / PF_WriteShort (MSG_BROADCAST)", () => {
  test("bytes land in sv.datagram", () => {
    const startCursize = sv.datagram.cursize;

    setParmFloat(OFS_PARM0, MSG_BROADCAST);
    setParmFloat(OFS_PARM1, 200);
    pr_builtin[52](); // PF_WriteByte
    expect(sv.datagram.data[startCursize]).toBe(200);

    const afterByte = sv.datagram.cursize;
    setParmFloat(OFS_PARM0, MSG_BROADCAST);
    setParmFloat(OFS_PARM1, 1234);
    pr_builtin[54](); // PF_WriteShort
    expect(sv.datagram.data[afterByte]).toBe(1234 & 0xff);
    expect(sv.datagram.data[afterByte + 1]).toBe((1234 >> 8) & 0xff);
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_sprint", () => {
  test("writes svc_print + the string into client 1's message", () => {
    const client = svs.clients[0];
    const startCursize = client.message.cursize;

    prExec.argc = 2; // sprint(clientent, value): one extra PF_VarString parm
    setParmEdict(OFS_PARM0, EDICT_NUM(1));
    setParmString(OFS_PARM1, "hello");
    pr_builtin[24]();

    expect(client.message.data[startCursize]).toBe(SvcOpsT.svc_print);
    expect(readCString(client.message.data, startCursize + 1)).toBe("hello");
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_stuffcmd", () => {
  test("writes svc_stufftext + the string into the client's message", () => {
    const client = svs.clients[0];
    const startCursize = client.message.cursize;

    setParmEdict(OFS_PARM0, EDICT_NUM(1));
    setParmString(OFS_PARM1, "god\n");
    pr_builtin[21]();

    expect(client.message.data[startCursize]).toBe(SvcOpsT.svc_stufftext);
    expect(readCString(client.message.data, startCursize + 1)).toBe("god\n");
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_cvar / PF_cvar_set", () => {
  test("roundtrips a registered cvar's value", () => {
    const testCvar = new CvarT("pr_cmds_test_cvar", "1");
    Cvar_RegisterVariable(testCvar);

    setParmString(OFS_PARM0, "pr_cmds_test_cvar");
    pr_builtin[45]();
    expect(returnFloat()).toBe(1);

    setParmString(OFS_PARM0, "pr_cmds_test_cvar");
    setParmString(OFS_PARM1, "42");
    pr_builtin[72]();
    expect(Cvar_VariableValue("pr_cmds_test_cvar")).toBe(42);
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_makevectors", () => {
  test("sets v_forward for yaw 90", () => {
    setParmVector(OFS_PARM0, [0, 90, 0]);
    pr_builtin[1]();

    const gs = pr.global_struct;
    if (gs === null) throw new Error("global_struct not set");
    expect(gs.v_forward[0]).toBeCloseTo(0, 4);
    expect(gs.v_forward[1]).toBeCloseTo(1, 4);
    expect(gs.v_forward[2]).toBeCloseTo(0, 4);
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_traceline", () => {
  test("traces against the synthetic world (split plane at z=0)", () => {
    setParmVector(OFS_PARM0, [0, 0, 100]);
    setParmVector(OFS_PARM1, [0, 0, -100]);
    setParmFloat(OFS_PARM2, 0); // nomonsters = false
    setParmEdict(OFS_PARM3, EDICT_NUM(0));
    pr_builtin[16]();

    const gs = pr.global_struct;
    if (gs === null) throw new Error("global_struct not set");
    expect(gs.trace_fraction).toBeGreaterThan(0);
    expect(gs.trace_fraction).toBeLessThan(1);
    expect(gs.trace_ent).toBe(0); // hit the world
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_Fixme / the builtin table", () => {
  test("PF_Fixme (slot 0) throws 'unimplemented bulitin'", () => {
    expect(() => pr_builtin[0]()).toThrow("unimplemented bulitin");
  });

  test("every #ifdef QUAKE2 / setabssize gap slot is also PF_Fixme", () => {
    for (const gap of [5, 33, 39, 42, 50, 60, 61, 62, 63, 64, 65, 66, 71]) {
      expect(() => pr_builtin[gap]()).toThrow("unimplemented bulitin");
    }
  });

  test("table length matches pr_numbuiltins (79 slots)", () => {
    expect(pr_builtin.length).toBe(pr_numbuiltins);
    expect(pr_numbuiltins).toBe(79);
  });
});
