import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { SysError } from "../src/platform/sys";
import {
  DDEF_T_SIZE,
  DEF_SAVEGLOBAL,
  DFUNCTION_T_SIZE,
  DPROGRAMS_T_SIZE,
  DSTATEMENT_T_SIZE,
  EtypeT,
  MAX_PARMS,
  OFS_NULL,
  OFS_PARM0,
  OFS_PARM7,
  OFS_RETURN,
  OpT,
  PROG_VERSION,
  RESERVED_OFS,
  readDdef,
  readDfunction,
  readDprograms,
  readDstatement,
} from "../src/progs/pr_comp";
import {
  ENTVARS_OFS,
  ENTVARS_SIZE_WORDS,
  EntVars,
  GLOBAL_OFS,
  GlobalVars,
  NUM_GLOBAL_WORDS,
  PROGHEADER_CRC,
} from "../src/progs/progdefs";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  EdictT,
  LinkT,
  MAX_ENT_LEAFS,
  NUM_FOR_EDICT,
  PROG_TO_EDICT,
  ENGINE_STRING_BASE,
  PR_ClearEngineStrings,
  PR_GetString,
  PR_SetEngineString,
  TYPE_SIZE,
  pr,
  setEdictTable,
} from "../src/progs/progs";

describe("pr_comp.ts", () => {
  test("etype_t values match pr_comp.h's enum order", () => {
    expect(EtypeT.ev_void).toBe(0);
    expect(EtypeT.ev_string).toBe(1);
    expect(EtypeT.ev_float).toBe(2);
    expect(EtypeT.ev_vector).toBe(3);
    expect(EtypeT.ev_entity).toBe(4);
    expect(EtypeT.ev_field).toBe(5);
    expect(EtypeT.ev_function).toBe(6);
    expect(EtypeT.ev_pointer).toBe(7);
  });

  test("global-offset constants match pr_comp.h", () => {
    expect(OFS_NULL).toBe(0);
    expect(OFS_RETURN).toBe(1);
    expect(OFS_PARM0).toBe(4);
    expect(OFS_PARM7).toBe(25);
    expect(RESERVED_OFS).toBe(28);
    expect(MAX_PARMS).toBe(8);
    expect(PROG_VERSION).toBe(6);
    expect(DEF_SAVEGLOBAL).toBe(1 << 15);
  });

  test("OP_* opcodes are numbered in the C's declaration order", () => {
    expect(OpT.OP_DONE).toBe(0);
    expect(OpT.OP_MUL_F).toBe(1);
    expect(OpT.OP_SUB_V).toBe(9);
    expect(OpT.OP_EQ_F).toBe(10);
    expect(OpT.OP_NE_FNC).toBe(19);
    expect(OpT.OP_LOAD_F).toBe(24);
    expect(OpT.OP_ADDRESS).toBe(30);
    expect(OpT.OP_STORE_F).toBe(31);
    expect(OpT.OP_STOREP_F).toBe(37);
    expect(OpT.OP_RETURN).toBe(43);
    expect(OpT.OP_IF).toBe(49);
    expect(OpT.OP_CALL0).toBe(51);
    expect(OpT.OP_CALL8).toBe(59);
    expect(OpT.OP_STATE).toBe(60);
    expect(OpT.OP_GOTO).toBe(61);
    expect(OpT.OP_AND).toBe(62);
    expect(OpT.OP_OR).toBe(63);
    expect(OpT.OP_BITAND).toBe(64);
    expect(OpT.OP_BITOR).toBe(65);
  });

  test("reader struct sizes equal the C sizeof", () => {
    expect(DSTATEMENT_T_SIZE).toBe(8);
    expect(DDEF_T_SIZE).toBe(8);
    expect(DFUNCTION_T_SIZE).toBe(36);
    expect(DPROGRAMS_T_SIZE).toBe(60);
  });

  test("readDstatement reads op/a/b/c little-endian at the right byte offsets", () => {
    const buf = new ArrayBuffer(DSTATEMENT_T_SIZE);
    const view = new DataView(buf);
    view.setUint16(0, OpT.OP_STORE_F, true);
    view.setInt16(2, -3, true);
    view.setInt16(4, 7, true);
    view.setInt16(6, -1, true);
    const s = readDstatement(view, 0);
    expect(s.op).toBe(OpT.OP_STORE_F);
    expect(s.a).toBe(-3);
    expect(s.b).toBe(7);
    expect(s.c).toBe(-1);
  });

  test("readDdef reads type/ofs/s_name at the right byte offsets", () => {
    const buf = new ArrayBuffer(DDEF_T_SIZE);
    const view = new DataView(buf);
    view.setUint16(0, EtypeT.ev_float | DEF_SAVEGLOBAL, true);
    view.setUint16(2, 91, true);
    view.setInt32(4, 12345, true);
    const d = readDdef(view, 0);
    expect(d.type).toBe(EtypeT.ev_float | DEF_SAVEGLOBAL);
    expect(d.ofs).toBe(91);
    expect(d.s_name).toBe(12345);
  });

  test("readDfunction reads every field including parm_size[MAX_PARMS]", () => {
    const buf = new ArrayBuffer(DFUNCTION_T_SIZE);
    const view = new DataView(buf);
    view.setInt32(0, 100, true); // first_statement
    view.setInt32(4, 4, true); // parm_start
    view.setInt32(8, 6, true); // locals
    view.setInt32(12, 0, true); // profile
    view.setInt32(16, 55, true); // s_name
    view.setInt32(20, 2, true); // s_file
    view.setInt32(24, 3, true); // numparms
    const sizes = [1, 1, 3, 0, 0, 0, 0, 0];
    for (let i = 0; i < MAX_PARMS; i++) view.setUint8(28 + i, sizes[i]);
    const f = readDfunction(view, 0);
    expect(f.first_statement).toBe(100);
    expect(f.parm_start).toBe(4);
    expect(f.locals).toBe(6);
    expect(f.s_name).toBe(55);
    expect(f.s_file).toBe(2);
    expect(f.numparms).toBe(3);
    expect(Array.from(f.parm_size)).toEqual(sizes);
  });

  const progsPath = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

  test("readDprograms on progs106/progs.dat matches the retail header", () => {
    if (!existsSync(progsPath)) return; // fixture not present on this machine

    const data = readFileSync(progsPath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const p = readDprograms(view, 0);

    expect(p.version).toBe(6);
    expect(p.crc).toBe(5927);
    expect(p.entityfields).toBe(195);

    expect(p.ofs_statements).toBe(88396);
    expect(p.numstatements).toBe(20940);
    expect(p.ofs_globaldefs).toBe(331192);
    expect(p.numglobaldefs).toBe(4287);
    expect(p.ofs_fielddefs).toBe(365488);
    expect(p.numfielddefs).toBe(218);
    expect(p.ofs_functions).toBe(255916);
    expect(p.numfunctions).toBe(2091);
    expect(p.ofs_strings).toBe(60);
    expect(p.numstrings).toBe(88336);
    expect(p.ofs_globals).toBe(367232);
    expect(p.numglobals).toBe(11471);

    // every lump fits inside the file
    expect(p.ofs_statements + p.numstatements * DSTATEMENT_T_SIZE).toBeLessThanOrEqual(data.length);
    expect(p.ofs_globaldefs + p.numglobaldefs * DDEF_T_SIZE).toBeLessThanOrEqual(data.length);
    expect(p.ofs_fielddefs + p.numfielddefs * DDEF_T_SIZE).toBeLessThanOrEqual(data.length);
    expect(p.ofs_functions + p.numfunctions * DFUNCTION_T_SIZE).toBeLessThanOrEqual(data.length);
    expect(p.ofs_strings + p.numstrings).toBeLessThanOrEqual(data.length);
    expect(p.ofs_globals + p.numglobals * 4).toBeLessThanOrEqual(data.length);
  });
});

describe("progdefs.ts", () => {
  test("PROGHEADER_CRC matches progdefs.q1", () => {
    expect(PROGHEADER_CRC).toBe(5927);
  });

  test("GLOBAL_OFS: pad[28] precedes self/other/world, hand-checked offsets", () => {
    expect(GLOBAL_OFS.self).toBe(28);
    expect(GLOBAL_OFS.other).toBe(29);
    expect(GLOBAL_OFS.world).toBe(30);
    expect(GLOBAL_OFS.time).toBe(31); // first float field, right after world
    expect(GLOBAL_OFS.mapname).toBe(34);
    expect(GLOBAL_OFS.parm1).toBe(43);
    expect(GLOBAL_OFS.parm16).toBe(58); // 16 parms, 43..58
    expect(GLOBAL_OFS.v_forward).toBe(59); // first vec3 after parm16
    expect(GLOBAL_OFS.v_up).toBe(62); // v_forward + 3
    expect(GLOBAL_OFS.v_right).toBe(65);
    expect(GLOBAL_OFS.trace_endpos).toBe(71);
    expect(GLOBAL_OFS.trace_plane_normal).toBe(74);
    expect(GLOBAL_OFS.trace_ent).toBe(78);
    expect(GLOBAL_OFS.msg_entity).toBe(81);
    expect(GLOBAL_OFS.main).toBe(82); // first function pointer
    expect(GLOBAL_OFS.SetChangeParms).toBe(91); // last field
    expect(NUM_GLOBAL_WORDS).toBe(92);
  });

  test("ENTVARS_OFS: modelindex at 0, hand-checked offsets through the struct", () => {
    expect(ENTVARS_OFS.modelindex).toBe(0);
    expect(ENTVARS_OFS.absmin).toBe(1);
    expect(ENTVARS_OFS.absmax).toBe(4);
    expect(ENTVARS_OFS.ltime).toBe(7);
    expect(ENTVARS_OFS.origin).toBe(10); // after ltime(7),movetype(8),solid(9)
    expect(ENTVARS_OFS.oldorigin).toBe(13); // origin + 3
    expect(ENTVARS_OFS.classname).toBe(28); // after 6 vec3s (18 words) + ltime/movetype/solid
    expect(ENTVARS_OFS.model).toBe(29);
    expect(ENTVARS_OFS.mins).toBe(33);
    expect(ENTVARS_OFS.touch).toBe(42); // after mins/maxs/size (9 words) from 33
    expect(ENTVARS_OFS.nextthink).toBe(46);
    expect(ENTVARS_OFS.view_ofs).toBe(62);
    expect(ENTVARS_OFS.v_angle).toBe(70);
    expect(ENTVARS_OFS.movedir).toBe(96);
    expect(ENTVARS_OFS.message).toBe(99); // movedir + 3
    expect(ENTVARS_OFS.noise3).toBe(104); // last field
    expect(ENTVARS_SIZE_WORDS).toBe(105);
  });

  test("GlobalVars getters/setters round-trip through the shared f/i arrays", () => {
    const f = new Float32Array(NUM_GLOBAL_WORDS);
    const i = new Int32Array(f.buffer);
    const g = new GlobalVars(f, i);

    g.self = 3;
    expect(i[GLOBAL_OFS.self]).toBe(3);
    i[GLOBAL_OFS.other] = 7;
    expect(g.other).toBe(7);

    g.time = 12.5;
    expect(f[GLOBAL_OFS.time]).toBeCloseTo(12.5);
    f[GLOBAL_OFS.deathmatch] = 1;
    expect(g.deathmatch).toBe(1);

    // vector fields are persistent subarray views, not copies
    g.v_forward[0] = 1;
    g.v_forward[1] = 0;
    g.v_forward[2] = 0;
    expect(f[GLOBAL_OFS.v_forward]).toBe(1);
    expect(Array.from(g.v_forward)).toEqual([1, 0, 0]);

    g.main = 42;
    expect(i[GLOBAL_OFS.main]).toBe(42);
  });

  test("EntVars getters/setters round-trip; origin is a persistent Vec3 view", () => {
    const f = new Float32Array(ENTVARS_SIZE_WORDS);
    const i = new Int32Array(f.buffer);
    const ev = new EntVars(f, i);

    ev.health = 100;
    expect(f[ENTVARS_OFS.health]).toBe(100);

    ev.classname = 55; // string_t offset
    expect(i[ENTVARS_OFS.classname]).toBe(55);

    ev.origin[1] = 64;
    expect(f[ENTVARS_OFS.origin + 1]).toBe(64);

    f[ENTVARS_OFS.solid] = 2;
    expect(ev.solid).toBe(2);

    ev.owner = 9; // int/entity field
    expect(i[ENTVARS_OFS.owner]).toBe(9);
  });
});

describe("progs.ts", () => {
  test("MAX_ENT_LEAFS and TYPE_SIZE match progs.h / pr_edict.c", () => {
    expect(MAX_ENT_LEAFS).toBe(16);
    expect(TYPE_SIZE).toEqual([1, 1, 1, 3, 1, 1, 1, 1]);
  });

  test("EdictT constructor allocates entityfields words and v views the head of the block", () => {
    const entityfields = 195; // retail progs.dat's header word
    const ed = new EdictT(3, entityfields);

    expect(ed.index).toBe(3);
    expect(ed.free).toBe(false);
    expect(ed.leafnums.length).toBe(MAX_ENT_LEAFS);
    expect(ed.fields.f.length).toBe(entityfields);
    expect(ed.fields.i.length).toBe(entityfields);
    expect(ed.area).toBeInstanceOf(LinkT);
    expect(ed.area.owner).toBe(ed); // EDICT_FROM_AREA(l) === l.owner

    // v is a view over the head of the same buffer entvars_t occupies
    ed.v.health = 75;
    expect(ed.fields.f[ENTVARS_OFS.health]).toBe(75);
    ed.fields.i[ENTVARS_OFS.owner] = 11;
    expect(ed.v.owner).toBe(11);

    // fields beyond entvars_t (QuakeC-declared) are reachable through the
    // same buffer, past ENTVARS_SIZE_WORDS
    ed.fields.f[ENTVARS_SIZE_WORDS] = 3.5;
    expect(ed.fields.f[ENTVARS_SIZE_WORDS]).toBeCloseTo(3.5);
  });

  test("EDICT_NUM/NUM_FOR_EDICT/PROG_TO_EDICT/EDICT_TO_PROG are index round-trips over the registered table", () => {
    const entityfields = 195;
    const edicts = [new EdictT(0, entityfields), new EdictT(1, entityfields), new EdictT(2, entityfields)];
    setEdictTable(edicts);

    expect(EDICT_NUM(1)).toBe(edicts[1]);
    expect(NUM_FOR_EDICT(edicts[2])).toBe(2);
    expect(PROG_TO_EDICT(0)).toBe(edicts[0]);
    expect(EDICT_TO_PROG(edicts[2])).toBe(2);

    expect(() => EDICT_NUM(-1)).toThrow(SysError);
    expect(() => EDICT_NUM(3)).toThrow(SysError);
  });

  test("PR_SetEngineString/PR_GetString round-trip and dedup by content", () => {
    PR_ClearEngineStrings();

    const a = PR_SetEngineString("player");
    const b = PR_SetEngineString("world");
    const aAgain = PR_SetEngineString("player");

    // engine string indices are positive and based at ENGINE_STRING_BASE so
    // that a float-view copy of the shared buffer cannot canonicalise them
    // into a NaN (see progs.ts's string_t note)
    expect(a).toBeGreaterThanOrEqual(ENGINE_STRING_BASE);
    expect(b).toBeGreaterThanOrEqual(ENGINE_STRING_BASE);
    expect(a).not.toBe(b);
    expect(aAgain).toBe(a); // deduplicated by content, not a fresh index

    expect(PR_GetString(a)).toBe("player");
    expect(PR_GetString(b)).toBe("world");

    expect(() => PR_GetString(a + 1000)).toThrow(SysError);
    expect(() => PR_GetString(-1)).toThrow(SysError);
  });

  test("PR_GetString on a progs string block reads to the first NUL", () => {
    const bytes = new Uint8Array([0, ...Array.from("hello", (c) => c.charCodeAt(0)), 0, 0x41, 0x42, 0]);
    pr.strings = bytes;

    expect(PR_GetString(0)).toBe("");
    expect(PR_GetString(1)).toBe("hello");
    expect(PR_GetString(7)).toBe("AB");

    pr.strings = null;
  });
});
