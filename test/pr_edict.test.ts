import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  COM_Parse,
  pop,
  type ParseState,
} from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { sysState } from "../src/platform/sys";
import { ENTVARS_OFS, GLOBAL_OFS } from "../src/progs/progdefs";
import { EDICT_NUM, ENGINE_STRING_BASE, PR_GetString, pr } from "../src/progs/progs";
import { sv, svs } from "../src/server/server";
import {
  ED_Alloc,
  ED_ClearEdict,
  ED_Count,
  ED_FieldAtOfs,
  ED_FindField,
  ED_FindFunction,
  ED_FindGlobal,
  ED_Free,
  ED_GlobalAtOfs,
  ED_LoadFromFile,
  ED_NewString,
  ED_ParseEdict,
  ED_ParseGlobals,
  ED_Print,
  ED_PrintEdicts,
  ED_Write,
  ED_WriteGlobals,
  GetEdictFieldValue,
  PR_AllocEdicts,
  PR_GlobalString,
  PR_GlobalStringNoContents,
  PR_LoadProgs,
  PR_Progs,
  PR_UglyValueString,
  PR_ValueString,
  progs,
  type TextFileWriter,
} from "../src/progs/pr_edict";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "pr-edict-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  // ED_Print/ED_Count/Con_Printf write through Sys_Printf; keep the suite quiet.
  sysState.nostdout = 1;

  // No throw: a missing progs106/progs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_PROGS106), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_PROGS106) return;
  const progsDat = new Uint8Array(readFileSync(PROGS_DAT));

  // gfx/pop.lmp inside id1/pak0.pak: the registered-version check's 128
  // big-endian shorts. Without it COM_CheckRegistered leaves the engine in
  // shareware mode. progs.dat rides in the same pak, which is where the
  // retail game ships it.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: progsDat },
  ]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();

  PR_LoadProgs();
  PR_AllocEdicts(64);
  svs.maxclients = 0;
  sv.num_edicts = 1;
  sv.time = 0;
});

class StringWriter implements TextFileWriter {
  out = "";
  write(s: string): void {
    this.out += s;
  }
}

function parseState(data: string): ParseState {
  return { data, index: 0 };
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("PR_LoadProgs", () => {
  test("CRCs the whole progs.dat file", () => {
    expect(pr.crc).toBe(24778);
  });

  test("fills the dprograms_t header", () => {
    const header = PR_Progs();
    expect(header.version).toBe(6);
    expect(header.entityfields).toBe(195);
    expect(progs).not.toBeNull();
    expect(progs?.entityfields).toBe(195);
  });

  test("pr.edict_size is entityfields, in words", () => {
    expect(pr.edict_size).toBe(195);
  });

  test("fills the lump tables", () => {
    const header = PR_Progs();
    expect(pr.functions.length).toBe(header.numfunctions);
    expect(pr.globaldefs.length).toBe(header.numglobaldefs);
    expect(pr.fielddefs.length).toBe(header.numfielddefs);
    expect(pr.statements.op.length).toBe(header.numstatements);
    expect(pr.globals).not.toBeNull();
    expect(pr.globals?.f.length).toBe(header.numglobals);
    expect(pr.global_struct).not.toBeNull();
    expect(pr.strings).not.toBeNull();
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_FindFunction / ED_FindField / ED_FindGlobal", () => {
  test("finds worldspawn and main", () => {
    expect(ED_FindFunction("worldspawn")).not.toBeNull();
    expect(ED_FindFunction("main")).not.toBeNull();
    expect(ED_FindFunction("no_such_function_at_all")).toBeNull();
  });

  test("field offsets match progdefs.q1's entvars_t layout", () => {
    expect(ED_FindField("origin")?.ofs).toBe(ENTVARS_OFS.origin);
    expect(ED_FindField("classname")?.ofs).toBe(ENTVARS_OFS.classname);
    expect(ED_FindField("angles")?.ofs).toBe(ENTVARS_OFS.angles);
    expect(ED_FindField("no_such_field")).toBeNull();
  });

  test("global offsets match progdefs.q1's globalvars_t layout", () => {
    expect(ED_FindGlobal("time")?.ofs).toBe(GLOBAL_OFS.time);
    expect(ED_FindGlobal("mapname")?.ofs).toBe(GLOBAL_OFS.mapname);
    expect(ED_FindGlobal("no_such_global")).toBeNull();
  });

  test("ED_FieldAtOfs / ED_GlobalAtOfs invert the lookup", () => {
    expect(ED_FieldAtOfs(ENTVARS_OFS.origin)?.s_name).toBe(ED_FindField("origin")?.s_name);
    expect(ED_GlobalAtOfs(GLOBAL_OFS.time)?.s_name).toBe(ED_FindGlobal("time")?.s_name);
    expect(ED_FieldAtOfs(99999)).toBeNull();
    expect(ED_GlobalAtOfs(99999)).toBeNull();
  });
});

describe.skipIf(!HAVE_PROGS106)("GetEdictFieldValue", () => {
  test("returns the field's word offset, -1 for unknown, and caches both", () => {
    const ed = EDICT_NUM(3);
    expect(GetEdictFieldValue(ed, "origin")).toBe(ENTVARS_OFS.origin);
    expect(GetEdictFieldValue(ed, "origin")).toBe(ENTVARS_OFS.origin); // cache hit
    expect(GetEdictFieldValue(ed, "no_such_field")).toBe(-1);
    expect(GetEdictFieldValue(ed, "no_such_field")).toBe(-1); // negative result is cached too
    expect(GetEdictFieldValue(ed, "classname")).toBe(ENTVARS_OFS.classname);
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_Alloc / ED_Free", () => {
  test("allocation starts at svs.maxclients+1, not edict 0", () => {
    svs.maxclients = 1;
    sv.num_edicts = 2;
    sv.time = 5;

    const e = ED_Alloc();
    expect(e.index).toBe(2);
    expect(sv.num_edicts).toBe(3);
    expect(e.free).toBe(false);
  });

  test("a just-freed edict is not reused until sv.time moves past freetime+0.5", () => {
    svs.maxclients = 1;
    sv.num_edicts = 2;
    sv.time = 5;

    const first = ED_Alloc(); // index 2
    expect(first.index).toBe(2);
    ED_Free(first);
    expect(first.free).toBe(true);
    expect(first.freetime).toBe(5);
    expect(first.v.nextthink).toBe(-1);

    // sv.time - freetime == 0, and freetime is not < 2: skipped
    const second = ED_Alloc();
    expect(second.index).toBe(3);

    // now the 0.5s replacement delay has passed
    sv.time = 5.6;
    const third = ED_Alloc();
    expect(third.index).toBe(2);
    expect(third.free).toBe(false);
  });

  test("the first couple seconds of server time relax the replacement policy", () => {
    svs.maxclients = 1;
    sv.num_edicts = 2;
    sv.time = 1;

    const e = ED_Alloc(); // index 2
    ED_Free(e);
    expect(e.freetime).toBe(1);

    const again = ED_Alloc();
    expect(again.index).toBe(2); // freetime < 2, so reused immediately
  });

  test("ED_Free resets exactly the fields the C resets", () => {
    svs.maxclients = 1;
    sv.num_edicts = 2;
    sv.time = 9;

    const e = ED_Alloc();
    e.v.model = 7;
    e.v.takedamage = 2;
    e.v.modelindex = 3;
    e.v.colormap = 4;
    e.v.skin = 5;
    e.v.frame = 6;
    e.v.origin[0] = 1;
    e.v.origin[1] = 2;
    e.v.origin[2] = 3;
    e.v.angles[0] = 4;
    e.v.angles[1] = 5;
    e.v.angles[2] = 6;
    e.v.solid = 4;
    e.v.health = 100; // not touched by ED_Free

    ED_Free(e);

    expect(e.free).toBe(true);
    expect(e.v.model).toBe(0);
    expect(e.v.takedamage).toBe(0);
    expect(e.v.modelindex).toBe(0);
    expect(e.v.colormap).toBe(0);
    expect(e.v.skin).toBe(0);
    expect(e.v.frame).toBe(0);
    expect(Array.from(e.v.origin)).toEqual([0, 0, 0]);
    expect(Array.from(e.v.angles)).toEqual([0, 0, 0]);
    expect(e.v.nextthink).toBe(-1);
    expect(e.v.solid).toBe(0);
    expect(e.freetime).toBe(9);
    expect(e.v.health).toBe(100);
  });

  test("ED_ClearEdict zeroes the whole per-edict block", () => {
    const e = EDICT_NUM(10);
    e.fields.i.fill(0x7f);
    e.free = true;
    ED_ClearEdict(e);
    expect(e.free).toBe(false);
    for (let i = 0; i < e.fields.i.length; i++) expect(e.fields.i[i]).toBe(0);
    expect(e.fields.i.length).toBe(195);
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_NewString", () => {
  test("translates \\n and leaves other backslashes alone", () => {
    expect(PR_GetString(ED_NewString("plain"))).toBe("plain");
    expect(PR_GetString(ED_NewString("a\\nb"))).toBe("a\nb");
    expect(PR_GetString(ED_NewString("a\\qb"))).toBe("a\\b");
    expect(PR_GetString(ED_NewString(""))).toBe("");
  });

  test("allocates in the engine string table (string_t at or above ENGINE_STRING_BASE)", () => {
    expect(ED_NewString("engine string table entry")).toBeGreaterThanOrEqual(ENGINE_STRING_BASE);
  });
});

describe.skipIf(!HAVE_PROGS106)("PR_ValueString / PR_UglyValueString", () => {
  // one buffer under both views, exactly as pr_globals / EdictT.fields are
  const baseBuffer = new ArrayBuffer(32);
  const base = { f: new Float32Array(baseBuffer), i: new Int32Array(baseBuffer) };

  test("floats use %5.1f / %f", () => {
    base.f[0] = 300;
    expect(PR_ValueString(2 /* ev_float */, base, 0)).toBe("300.0");
    expect(PR_UglyValueString(2, base, 0)).toBe("300.000000");

    base.f[0] = 1.5;
    expect(PR_ValueString(2, base, 0)).toBe("  1.5");
    expect(PR_UglyValueString(2, base, 0)).toBe("1.500000");

    base.f[0] = -12.24; // float32 -12.239999771118164, not a rounding tie
    expect(PR_ValueString(2, base, 0)).toBe("-12.2");
  });

  test("%f matches C printf for the float32 values a savegame can hold", () => {
    // Every case here is `printf("%f", (double)(float)x)`: the float32 value
    // is exact, and no float32 is ever an exact .0000005 tie, so toFixed(6)
    // and printf round identically.
    const cases: Array<[number, string]> = [
      [0, "0.000000"],
      [1, "1.000000"],
      [-1, "-1.000000"],
      [0.5, "0.500000"],
      [2.5, "2.500000"],
      [90, "90.000000"],
      [1e6, "1000000.000000"],
      [-4096, "-4096.000000"],
    ];
    for (const [value, want] of cases) {
      base.f[0] = value;
      expect(PR_UglyValueString(2, base, 0)).toBe(want);
    }
    // float32(0.1) is 0.100000001490116..., printf %f prints 0.100000
    base.f[0] = 0.1;
    expect(PR_UglyValueString(2, base, 0)).toBe("0.100000");
    // -0.0f survives ED_Write's zero-field skip (its bits are not zero) and
    // printf writes the sign
    base.f[0] = -0;
    expect(base.i[0]).not.toBe(0);
    expect(PR_UglyValueString(2, base, 0)).toBe("-0.000000");
  });

  test("vectors", () => {
    base.f[0] = 1;
    base.f[1] = 2;
    base.f[2] = 3;
    expect(PR_ValueString(3 /* ev_vector */, base, 0)).toBe("'  1.0   2.0   3.0'");
    expect(PR_UglyValueString(3, base, 0)).toBe("1.000000 2.000000 3.000000");
  });

  test("entities, strings, functions, fields, void, pointer, bad type", () => {
    base.i[0] = 0;
    expect(PR_ValueString(4 /* ev_entity */, base, 0)).toBe("entity 0");
    expect(PR_UglyValueString(4, base, 0)).toBe("0");

    base.i[0] = ED_NewString("hello");
    expect(PR_ValueString(1 /* ev_string */, base, 0)).toBe("hello");
    expect(PR_UglyValueString(1, base, 0)).toBe("hello");

    const worldspawn = ED_FindFunction("worldspawn");
    expect(worldspawn).not.toBeNull();
    base.i[0] = pr.functions.indexOf(worldspawn ?? pr.functions[0]);
    expect(PR_ValueString(6 /* ev_function */, base, 0)).toBe("worldspawn()");
    expect(PR_UglyValueString(6, base, 0)).toBe("worldspawn");

    base.i[0] = ENTVARS_OFS.origin;
    expect(PR_ValueString(5 /* ev_field */, base, 0)).toBe(".origin");
    expect(PR_UglyValueString(5, base, 0)).toBe("origin");

    expect(PR_ValueString(0 /* ev_void */, base, 0)).toBe("void");
    expect(PR_ValueString(7 /* ev_pointer */, base, 0)).toBe("pointer");
    expect(PR_ValueString(9, base, 0)).toBe("bad type 9");
    expect(PR_UglyValueString(9, base, 0)).toBe("bad type 9");
  });

  test("DEF_SAVEGLOBAL is masked off the type", () => {
    base.f[0] = 4;
    expect(PR_UglyValueString(0x8002, base, 0)).toBe("4.000000");
  });
});

describe.skipIf(!HAVE_PROGS106)("PR_GlobalString / PR_GlobalStringNoContents", () => {
  test("pads to 20 columns and appends one more space", () => {
    const globals = pr.globals;
    expect(globals).not.toBeNull();
    if (globals === null) return;
    globals.f[GLOBAL_OFS.time] = 0;

    const s = PR_GlobalString(GLOBAL_OFS.time);
    expect(s).toBe(`31(time)  0.0${" ".repeat(8)}`);
    expect(s.length).toBe(21);

    const n = PR_GlobalStringNoContents(GLOBAL_OFS.time);
    expect(n).toBe(`31(time)${" ".repeat(13)}`);
    expect(n.length).toBe(21);
  });

  test("unknown offsets print the (???) form", () => {
    expect(ED_GlobalAtOfs(65535)).toBeNull();
    expect(PR_GlobalString(65535)).toBe(`65535(???)${" ".repeat(11)}`);
    expect(PR_GlobalStringNoContents(65535)).toBe(`65535(???)${" ".repeat(11)}`);
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_ParseEdict", () => {
  test("parses the QuakeEd angle/light hacks and skips _ keys", () => {
    const ed = EDICT_NUM(20);
    ED_ClearEdict(ed);

    const ps = parseState(
      '{\n"classname" "info_player_start"\n"origin" "1 2 3"\n"angle" "90"\n"light" "300"\n"_ignored" "x"\n}\n',
    );
    // the C consumes the opening brace before calling ED_ParseEdict
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseEdict(ps, ed);

    expect(PR_GetString(ed.v.classname)).toBe("info_player_start");
    expect(Array.from(ed.v.origin)).toEqual([1, 2, 3]);
    expect(Array.from(ed.v.angles)).toEqual([0, 90, 0]);

    const lightLev = ED_FindField("light_lev");
    expect(lightLev).not.toBeNull();
    expect(ed.fields.f[lightLev?.ofs ?? 0]).toBe(300);

    expect(ed.free).toBe(false);
  });

  test("keyname trailing spaces are stripped", () => {
    const ed = EDICT_NUM(21);
    ED_ClearEdict(ed);
    const ps = parseState('{\n"classname   " "trailing"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseEdict(ps, ed);
    expect(PR_GetString(ed.v.classname)).toBe("trailing");
  });

  test("an empty dictionary marks the edict free", () => {
    const ed = EDICT_NUM(22);
    ED_ClearEdict(ed);
    const ps = parseState("{\n}\n");
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseEdict(ps, ed);
    expect(ed.free).toBe(true);
  });

  test("unknown keys are reported and skipped, and set init anyway", () => {
    const ed = EDICT_NUM(23);
    ED_ClearEdict(ed);
    const ps = parseState('{\n"no_such_field" "1"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseEdict(ps, ed);
    expect(ed.free).toBe(false);
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_Write", () => {
  test("emits the savegame text the C's fprintf calls produce", () => {
    const ed = EDICT_NUM(24);
    ED_ClearEdict(ed);
    const ps = parseState('{\n"classname" "info_player_start"\n"origin" "1 2 3"\n"angle" "90"\n"light" "300"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseEdict(ps, ed);

    const f = new StringWriter();
    ED_Write(f, ed);

    // Field order is pr_fielddefs order: origin (13), angles (25),
    // classname (37), light_lev (124); _x/_y/_z aliases are skipped, and so
    // is every field whose words are all still zero.
    expect(f.out).toBe(
      '{\n' +
        '"origin" "1.000000 2.000000 3.000000"\n' +
        '"angles" "0.000000 90.000000 0.000000"\n' +
        '"classname" "info_player_start"\n' +
        '"light_lev" "300.000000"\n' +
        '}\n',
    );
  });

  test("a free edict writes an empty block", () => {
    const ed = EDICT_NUM(25);
    ED_ClearEdict(ed);
    ed.free = true;
    const f = new StringWriter();
    ED_Write(f, ed);
    expect(f.out).toBe("{\n}\n");
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_ParseGlobals / ED_WriteGlobals", () => {
  test("round-trips a savegame globals block", () => {
    const ps = parseState('{\n"mapname" "e1m1"\n"total_secrets" "4"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseGlobals(ps);

    const gs = pr.global_struct;
    expect(gs).not.toBeNull();
    if (gs === null) return;
    expect(PR_GetString(gs.mapname)).toBe("e1m1");
    expect(gs.total_secrets).toBe(4);

    const f = new StringWriter();
    ED_WriteGlobals(f);
    expect(f.out.startsWith("{\n")).toBe(true);
    expect(f.out.endsWith("}\n")).toBe(true);
    expect(f.out).toContain('"mapname" "e1m1"\n');
    expect(f.out).toContain('"total_secrets" "4.000000"\n');
  });

  test("keys that are not globals are reported and skipped", () => {
    const ps = parseState('{\n"no_such_global" "1"\n"total_secrets" "7"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseGlobals(ps);
    expect(pr.global_struct?.total_secrets).toBe(7);
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_LoadFromFile", () => {
  test("worldspawn takes edict 0, unknown classnames are freed, skill filters inhibit", () => {
    svs.maxclients = 0;
    sv.num_edicts = 1;
    sv.time = 5;
    for (let i = 0; i < 64; i++) {
      ED_ClearEdict(EDICT_NUM(i));
      EDICT_NUM(i).freetime = 0;
    }

    // No classname here has a spawn function in progs.dat, so
    // PR_ExecuteProgram is never reached and no QuakeC runs.
    const entities =
      '{\n"classname" "no_spawn_function_a"\n"netname" "first"\n"origin" "8 9 10"\n}\n' +
      '{\n"classname" "no_spawn_function_b"\n"spawnflags" "256"\n}\n' +
      '{\n"classname" "no_spawn_function_c"\n}\n';

    ED_LoadFromFile(parseState(entities));

    // pr_global_struct->time = sv.time
    expect(pr.global_struct?.time).toBe(5);

    // the first entity is placed directly in EDICT_NUM(0), not ED_Alloc'd
    const world = EDICT_NUM(0);
    expect(PR_GetString(world.v.netname)).toBe("first");
    expect(world.free).toBe(true); // "No spawn function for:" -> ED_Free

    // second entity: SPAWNFLAG_NOT_EASY at skill 0 -> inhibited before the
    // classname lookup; third: allocated after it, since freetime blocks reuse
    expect(sv.num_edicts).toBe(3);
    expect(EDICT_NUM(1).free).toBe(true);
    expect(EDICT_NUM(2).free).toBe(true);
    expect(PR_GetString(EDICT_NUM(2).v.classname)).toBe("no_spawn_function_c");
  });

  test("an entity with no classname at all is freed", () => {
    svs.maxclients = 0;
    sv.num_edicts = 1;
    sv.time = 5;
    for (let i = 0; i < 64; i++) {
      ED_ClearEdict(EDICT_NUM(i));
      EDICT_NUM(i).freetime = 0;
    }

    ED_LoadFromFile(parseState('{\n"origin" "1 1 1"\n}\n'));
    expect(EDICT_NUM(0).free).toBe(true);
    expect(sv.num_edicts).toBe(1);
  });
});

describe.skipIf(!HAVE_PROGS106)("ED_Print / ED_PrintEdicts / ED_Count", () => {
  test("run over the live edict table without throwing", () => {
    svs.maxclients = 0;
    sv.num_edicts = 4;
    for (let i = 0; i < 4; i++) ED_ClearEdict(EDICT_NUM(i));
    EDICT_NUM(1).free = true;
    EDICT_NUM(2).v.solid = 1;
    EDICT_NUM(2).v.model = ED_NewString("progs/player.mdl");
    EDICT_NUM(3).v.movetype = 4; // MOVETYPE_STEP

    ED_Print(EDICT_NUM(1));
    ED_Print(EDICT_NUM(2));
    ED_PrintEdicts();
    ED_Count();
  });
});
