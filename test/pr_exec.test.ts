import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sysState } from "../src/platform/sys";
import { DfunctionT, OFS_PARM0, OFS_PARM1, OFS_RETURN, OpT } from "../src/progs/pr_comp";
import {
  MAX_STACK_DEPTH,
  PRRunError,
  PR_EnterFunction,
  PR_ExecuteProgram,
  PR_MakePointer,
  PR_PrintStatement,
  PR_Profile_f,
  PR_ResolvePointer,
  PR_StackTrace,
  pr_opnames,
  prExec,
  getBuiltins,
  setBuiltins,
} from "../src/progs/pr_exec";
import { ENTVARS_OFS, ENTVARS_SIZE_WORDS, GlobalVars } from "../src/progs/progdefs";
import { EdictT, pr, setEdictTable } from "../src/progs/progs";
import { ServerStateT, sv } from "../src/server/server";

// Every case below builds a tiny in-memory program by hand; progs.dat is
// never loaded here.

const NUM_GLOBALS = 200;

type Stmt = [op: number, a: number, b: number, c: number];

let gf: Float32Array;
let gi: Int32Array;
let gs: GlobalVars;
let edicts: EdictT[];
let strOfs: number[];

// Offsets used by the hand-written programs. 0..91 is the globalvars_t
// block (pad[28] + progdefs.q1's globals), so everything scratch lives at
// 100 and above.
const L0 = 100;
const L1 = 101;
const L2 = 102;

function buildStrings(list: string[]): { block: Uint8Array; ofs: number[] } {
  const ofs: number[] = [];
  const bytes: number[] = [];
  for (const s of list) {
    ofs.push(bytes.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    bytes.push(0);
  }
  return { block: new Uint8Array(bytes), ofs };
}

function setStatements(list: Stmt[]): void {
  const n = list.length;
  const op = new Int16Array(n);
  const a = new Int16Array(n);
  const b = new Int16Array(n);
  const c = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    op[i] = list[i][0];
    a[i] = list[i][1];
    b[i] = list[i][2];
    c[i] = list[i][3];
  }
  pr.statements = { op, a, b, c };
}

function makeFunction(
  first_statement: number,
  parm_start: number,
  locals: number,
  numparms: number,
  parmSizes: number[],
): DfunctionT {
  const f = new DfunctionT();
  f.first_statement = first_statement;
  f.parm_start = parm_start;
  f.locals = locals;
  f.numparms = numparms;
  for (let i = 0; i < parmSizes.length; i++) f.parm_size[i] = parmSizes[i];
  f.s_name = strOfs[1]; // "prog.qc" doubles as both name and file here
  f.s_file = strOfs[1];
  return f;
}

let savedNostdout = 0;
// src/progs/pr_cmds.ts installs the real builtin table at module load
// (a side-effect import reached through src/main.ts, among others); every
// test below installs its own hand-built stand-in table via setBuiltins
// and none of them ever put the real one back, permanently truncating
// pr_builtins for the rest of this bun process (rule 15) -- restore it here.
const savedBuiltins = getBuiltins();

beforeAll(() => {
  // PR_RunError and PR_PrintStatement print through Con_Printf -> Sys_Printf;
  // keep the error cases from spraying the test output.
  savedNostdout = sysState.nostdout;
  sysState.nostdout = 1;
});

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setBuiltins(savedBuiltins);
});

beforeEach(() => {
  const buffer = new ArrayBuffer(NUM_GLOBALS * 4);
  gf = new Float32Array(buffer);
  gi = new Int32Array(buffer);
  pr.globals = { f: gf, i: gi };
  gs = new GlobalVars(gf, gi);
  pr.global_struct = gs;

  const built = buildStrings(["", "prog.qc", "alpha", "alpha", "beta"]);
  pr.strings = built.block;
  strOfs = built.ofs;

  pr.globaldefs = [];
  pr.fielddefs = [];
  pr.functions = [];
  pr.edict_size = ENTVARS_SIZE_WORDS;

  edicts = [];
  for (let i = 0; i < 4; i++) edicts.push(new EdictT(i, ENTVARS_SIZE_WORDS));
  setEdictTable(edicts);

  sv.state = ServerStateT.ss_loading;

  setBuiltins([]);
  prExec.trace = false;
  prExec.argc = 0;
  // prExec (src/progs/pr_exec.ts) is a process-wide singleton; depth/
  // xfunction/xstatement are PR_EnterFunction/PR_ExecuteProgram's own
  // call-stack bookkeeping, which a test elsewhere in this process may have
  // left unbalanced (an error path that doesn't unwind, or another suite's
  // own PR_ExecuteProgram call still "in progress" as far as this state is
  // concerned) -- reset the full baseline here rather than assume depth is
  // still 0 (rule 15).
  prExec.depth = 0;
  prExec.xfunction = null;
  prExec.xstatement = 0;
});

describe("pr_opnames", () => {
  test("has one name per opcode, in pr_comp.h's order", () => {
    expect(pr_opnames.length).toBe(OpT.OP_BITOR + 1);
    expect(pr_opnames[OpT.OP_DONE]).toBe("DONE");
    expect(pr_opnames[OpT.OP_DIV_F]).toBe("DIV");
    expect(pr_opnames[OpT.OP_LOAD_F]).toBe("INDIRECT");
    expect(pr_opnames[OpT.OP_LOAD_FNC]).toBe("INDIRECT");
    expect(pr_opnames[OpT.OP_ADDRESS]).toBe("ADDRESS");
    expect(pr_opnames[OpT.OP_STORE_F]).toBe("STORE_F");
    expect(pr_opnames[OpT.OP_CALL8]).toBe("CALL8");
    expect(pr_opnames[OpT.OP_BITOR]).toBe("BITOR");
  });
});

describe("PR_ExecuteProgram: arithmetic", () => {
  test("OP_ADD_F on the two parm globals returns their sum", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 3, 2, [1, 1])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_ADD_F, L0, L1, L2],
      [OpT.OP_RETURN, L2, 0, 0],
    ]);

    gf[OFS_PARM0] = 3;
    gf[OFS_PARM1] = 4;

    PR_ExecuteProgram(1);

    expect(gf[OFS_RETURN]).toBe(7);
    expect(prExec.depth).toBe(0);
  });

  test("OP_ADD_V / OP_MUL_FV / OP_MUL_VF / OP_MUL_V", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_ADD_V, 110, 113, 116],
      [OpT.OP_MUL_FV, 119, 110, 122],
      [OpT.OP_MUL_VF, 113, 119, 125],
      [OpT.OP_MUL_V, 110, 113, 128],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gf[110] = 1;
    gf[111] = 2;
    gf[112] = 3;
    gf[113] = 4;
    gf[114] = 5;
    gf[115] = 6;
    gf[119] = 2;

    PR_ExecuteProgram(1);

    expect([gf[116], gf[117], gf[118]]).toEqual([5, 7, 9]);
    expect([gf[122], gf[123], gf[124]]).toEqual([2, 4, 6]);
    expect([gf[125], gf[126], gf[127]]).toEqual([8, 10, 12]);
    expect(gf[128]).toBe(32);
  });

  test("OP_SUB_F, OP_SUB_V, OP_DIV_F, OP_BITAND, OP_BITOR", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_SUB_F, 110, 111, 130],
      [OpT.OP_SUB_V, 113, 116, 131],
      [OpT.OP_DIV_F, 110, 111, 134],
      [OpT.OP_DIV_F, 110, 112, 135], // divide by zero: the C produces inf
      [OpT.OP_BITAND, 119, 120, 136],
      [OpT.OP_BITOR, 119, 120, 137],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gf[110] = 10;
    gf[111] = 4;
    gf[112] = 0;
    gf[113] = 9;
    gf[114] = 8;
    gf[115] = 7;
    gf[116] = 1;
    gf[117] = 2;
    gf[118] = 3;
    gf[119] = 12.9; // (int)12.9 == 12
    gf[120] = 10.2; // (int)10.2 == 10

    PR_ExecuteProgram(1);

    expect(gf[130]).toBe(6);
    expect([gf[131], gf[132], gf[133]]).toEqual([8, 6, 4]);
    expect(gf[134]).toBe(2.5);
    expect(gf[135]).toBe(Number.POSITIVE_INFINITY);
    expect(gf[136]).toBe(8); // 12 & 10
    expect(gf[137]).toBe(14); // 12 | 10
  });

  test("comparison and boolean ops write 1.0/0.0 floats", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_GE, 110, 111, 130],
      [OpT.OP_LE, 110, 111, 131],
      [OpT.OP_GT, 110, 111, 132],
      [OpT.OP_LT, 110, 111, 133],
      [OpT.OP_AND, 110, 112, 134],
      [OpT.OP_OR, 110, 112, 135],
      [OpT.OP_NOT_F, 112, 0, 136],
      [OpT.OP_EQ_F, 110, 111, 137],
      [OpT.OP_NE_F, 110, 111, 138],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gf[110] = 5;
    gf[111] = 2;
    gf[112] = 0;

    PR_ExecuteProgram(1);

    expect(gf[130]).toBe(1); // 5 >= 2
    expect(gf[131]).toBe(0); // 5 <= 2
    expect(gf[132]).toBe(1); // 5 > 2
    expect(gf[133]).toBe(0); // 5 < 2
    expect(gf[134]).toBe(0); // 5 && 0
    expect(gf[135]).toBe(1); // 5 || 0
    expect(gf[136]).toBe(1); // !0
    expect(gf[137]).toBe(0);
    expect(gf[138]).toBe(1);
  });

  test("OP_NOT_ENT is true only for the world edict", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_NOT_ENT, 130, 0, 140],
      [OpT.OP_NOT_ENT, 131, 0, 141],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[130] = 0; // sv.edicts[0], the world
    gi[131] = 2;

    PR_ExecuteProgram(1);

    expect(gf[140]).toBe(1);
    expect(gf[141]).toBe(0);
  });
});

describe("PR_ExecuteProgram: branching", () => {
  test("OP_IF / OP_LT / OP_GOTO form a counted loop", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_STORE_F, 110, L0, 0], // counter = 0
      [OpT.OP_ADD_F, L0, 111, L0], // counter = counter + 1
      [OpT.OP_LT, L0, 112, L1], // L1 = counter < 5
      [OpT.OP_IF, L1, -2, 0],
      [OpT.OP_RETURN, L0, 0, 0],
    ]);

    gf[110] = 0;
    gf[111] = 1;
    gf[112] = 5;

    PR_ExecuteProgram(1);

    expect(gf[L0]).toBe(5);
    expect(gf[OFS_RETURN]).toBe(5);
  });

  test("OP_IFNOT skips forward when the int word is zero", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_IFNOT, 110, 2, 0],
      [OpT.OP_STORE_F, 111, 130, 0], // skipped when globals[110] is 0
      [OpT.OP_STORE_F, 112, 131, 0],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gf[110] = 0;
    gf[111] = 7;
    gf[112] = 9;

    PR_ExecuteProgram(1);

    expect(gf[130]).toBe(0);
    expect(gf[131]).toBe(9);
  });

  test("OP_GOTO backward with no exit hits the runaway loop check", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_GOTO, 0, 0, 0], // s += 0 - 1, then s++ -> back to itself
    ]);

    expect(() => PR_ExecuteProgram(1)).toThrow(PRRunError);
    expect(() => PR_ExecuteProgram(1)).toThrow("runaway loop error");
    expect(prExec.depth).toBe(0); // PR_RunError dumps the stack
  });
});

describe("PR_ExecuteProgram: calls", () => {
  test("OP_CALL1 into a QuakeC function preserves the caller's locals", () => {
    // fnA and fnB share parm_start 100, so fnB steps on fnA's local at 101.
    const fnA = makeFunction(1, L0, 3, 1, [1]);
    const fnB = makeFunction(6, L0, 2, 1, [1]);
    pr.functions = [new DfunctionT(), fnA, fnB];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_STORE_F, 110, L1, 0], // A: local = 42
      [OpT.OP_STORE_F, 111, OFS_PARM0, 0], // A: parm0 = 7
      [OpT.OP_CALL1, 120, 0, 0],
      [OpT.OP_ADD_F, L1, OFS_RETURN, L2], // A: local + B's return
      [OpT.OP_RETURN, L2, 0, 0],
      [OpT.OP_MUL_F, L0, 112, L0], // B: parm * 2, into the shared window
      [OpT.OP_RETURN, L0, 0, 0],
    ]);

    gf[110] = 42;
    gf[111] = 7;
    gf[112] = 2;
    gi[120] = 2; // func_t for fnB

    PR_ExecuteProgram(1);

    expect(gf[OFS_RETURN]).toBe(56); // 42 + 7*2
    expect(prExec.depth).toBe(0);
    expect(prExec.argc).toBe(1);
  });

  test("OP_CALL0 dispatches to a builtin registered through setBuiltins", () => {
    let seenArgc = -1;
    setBuiltins([
      () => {
        throw new Error("builtin 0 must never be called");
      },
      () => {
        seenArgc = prExec.argc;
        gf[OFS_RETURN] = 123;
      },
    ]);

    const builtinFn = makeFunction(-1, L0, 0, 0, []);
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, []), builtinFn];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_CALL0, 120, 0, 0],
      [OpT.OP_RETURN, OFS_RETURN, 0, 0],
    ]);

    gi[120] = 2;

    PR_ExecuteProgram(1);

    expect(seenArgc).toBe(0);
    expect(gf[OFS_RETURN]).toBe(123);
  });

  test("an out-of-range builtin number raises Bad builtin call number", () => {
    setBuiltins([() => {}, () => {}]);

    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, []), makeFunction(-99, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_CALL0, 120, 0, 0],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[120] = 2;

    expect(() => PR_ExecuteProgram(1)).toThrow(PRRunError);
    expect(() => PR_ExecuteProgram(1)).toThrow("Bad builtin call number");
  });

  test("a zero func_t in OP_CALL raises NULL function", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_CALL0, 120, 0, 0],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[120] = 0;

    expect(() => PR_ExecuteProgram(1)).toThrow("NULL function");
  });

  test("unbounded recursion raises stack overflow at MAX_STACK_DEPTH", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_CALL0, 120, 0, 0],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[120] = 1; // calls itself

    expect(() => PR_ExecuteProgram(1)).toThrow(PRRunError);
    expect(() => PR_ExecuteProgram(1)).toThrow("stack overflow");
    expect(MAX_STACK_DEPTH).toBe(32);
  });

  test("PR_ExecuteProgram(0) raises NULL function, with and without self set", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([[OpT.OP_DONE, 0, 0, 0]]);

    gs.self = 0;
    expect(() => PR_ExecuteProgram(0)).toThrow(PRRunError);
    expect(() => PR_ExecuteProgram(0)).toThrow("PR_ExecuteProgram: NULL function");

    gs.self = 1; // takes the ED_Print branch in pr_edict.ts
    expect(() => PR_ExecuteProgram(0)).toThrow("PR_ExecuteProgram: NULL function");

    // a func_t past the end of pr_functions takes the same path
    expect(() => PR_ExecuteProgram(99)).toThrow("PR_ExecuteProgram: NULL function");
  });
});

describe("PR_ExecuteProgram: edict fields", () => {
  test("OP_ADDRESS + OP_STOREP_F + OP_LOAD_F round trip through an edict field", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_ADDRESS, 120, 121, 122],
      [OpT.OP_STOREP_F, 110, 122, 0],
      [OpT.OP_LOAD_F, 120, 121, 123],
      [OpT.OP_RETURN, 123, 0, 0],
    ]);

    gi[120] = 1; // edict 1
    gi[121] = ENTVARS_OFS.health;
    gf[110] = 99;

    PR_ExecuteProgram(1);

    expect(gi[122]).toBe(1 * ENTVARS_SIZE_WORDS + ENTVARS_OFS.health);
    expect(edicts[1].fields.f[ENTVARS_OFS.health]).toBe(99);
    expect(gf[123]).toBe(99);
    expect(gf[OFS_RETURN]).toBe(99);
  });

  test("OP_ADDRESS + OP_STOREP_V + OP_LOAD_V round trip a vector field", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_ADDRESS, 120, 121, 122],
      [OpT.OP_STOREP_V, 110, 122, 0],
      [OpT.OP_LOAD_V, 120, 121, 130],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[120] = 2;
    gi[121] = ENTVARS_OFS.origin;
    gf[110] = 11;
    gf[111] = 22;
    gf[112] = 33;

    PR_ExecuteProgram(1);

    expect([edicts[2].v.origin[0], edicts[2].v.origin[1], edicts[2].v.origin[2]]).toEqual([11, 22, 33]);
    expect([gf[130], gf[131], gf[132]]).toEqual([11, 22, 33]);
  });

  test("OP_ADDRESS on the world entity errors only while sv.state is ss_active", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_ADDRESS, 120, 121, 122],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[120] = 0; // the world edict
    gi[121] = ENTVARS_OFS.health;

    sv.state = ServerStateT.ss_loading;
    PR_ExecuteProgram(1); // allowed during load
    expect(gi[122]).toBe(ENTVARS_OFS.health);

    sv.state = ServerStateT.ss_active;
    expect(() => PR_ExecuteProgram(1)).toThrow(PRRunError);
    expect(() => PR_ExecuteProgram(1)).toThrow("assignment to world entity");
    sv.state = ServerStateT.ss_loading;
  });

  test("OP_STATE sets nextthink, frame and think on pr_global_struct->self", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_STATE, 110, 121, 0],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gs.self = 1;
    gs.time = 5;
    gf[110] = 3; // frame
    gi[121] = 7; // think func_t

    PR_ExecuteProgram(1);

    expect(edicts[1].v.frame).toBe(3);
    expect(edicts[1].v.think).toBe(7);
    expect(edicts[1].v.nextthink).toBeCloseTo(5.1, 5);
  });
});

describe("PR_ExecuteProgram: strings", () => {
  test("OP_EQ_S / OP_NE_S use strcmp, not offset identity", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_EQ_S, 130, 131, 140],
      [OpT.OP_EQ_S, 130, 132, 141],
      [OpT.OP_NE_S, 130, 131, 142],
      [OpT.OP_NE_S, 130, 132, 143],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[130] = strOfs[2]; // "alpha"
    gi[131] = strOfs[3]; // a second, distinct copy of "alpha"
    gi[132] = strOfs[4]; // "beta"
    expect(strOfs[2]).not.toBe(strOfs[3]);

    PR_ExecuteProgram(1);

    expect(gf[140]).toBe(1); // equal content at different offsets
    expect(gf[141]).toBe(0);
    expect(gf[142]).toBe(0);
    expect(gf[143]).toBe("a".charCodeAt(0) - "b".charCodeAt(0)); // strcmp's value, not a 0/1
  });

  test("OP_NOT_S is true for string offset 0 and for the empty string", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_NOT_S, 130, 0, 140],
      [OpT.OP_NOT_S, 131, 0, 141],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[130] = 0; // the string block's leading empty string
    gi[131] = strOfs[2]; // "alpha"

    PR_ExecuteProgram(1);

    expect(gf[140]).toBe(1);
    expect(gf[141]).toBe(0);
  });
});

describe("PR_ExecuteProgram: stores and loads", () => {
  test("OP_STORE_F copies the int word, OP_STORE_V copies three floats", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_STORE_ENT, 130, 131, 0],
      [OpT.OP_STORE_V, 110, 140, 0],
      [OpT.OP_RETURN, 0, 0, 0],
    ]);

    gi[130] = 0x1234; // an entity number, not a float
    gf[110] = 1.5;
    gf[111] = 2.5;
    gf[112] = 3.5;

    PR_ExecuteProgram(1);

    expect(gi[131]).toBe(0x1234); // bit-exact int copy
    expect([gf[140], gf[141], gf[142]]).toEqual([1.5, 2.5, 3.5]);
  });
});

describe("PR_EnterFunction / PR_LeaveFunction", () => {
  test("copies parms from OFS_PARM0 by parm_size and returns first_statement - 1", () => {
    pr.functions = [new DfunctionT(), makeFunction(9, L0, 4, 2, [3, 1])];
    setStatements([[OpT.OP_DONE, 0, 0, 0]]);

    gf[OFS_PARM0] = 1;
    gf[OFS_PARM0 + 1] = 2;
    gf[OFS_PARM0 + 2] = 3;
    gf[OFS_PARM1] = 4;

    const s = PR_EnterFunction(pr.functions[1]);

    expect(s).toBe(8);
    expect([gf[100], gf[101], gf[102], gf[103]]).toEqual([1, 2, 3, 4]);
    expect(prExec.depth).toBe(1);

    prExec.depth = 0; // unwind the frame this test pushed by hand
    prExec.xfunction = null;
  });
});

describe("pointer encoding", () => {
  test("PR_MakePointer / PR_ResolvePointer round trip", () => {
    for (const index of [0, 1, 3]) {
      for (const ofs of [0, ENTVARS_OFS.health, ENTVARS_SIZE_WORDS - 1]) {
        const p = PR_MakePointer(edicts[index], ofs);
        expect(p).toBe(index * ENTVARS_SIZE_WORDS + ofs);
        const back = PR_ResolvePointer(p);
        expect(back.ed).toBe(edicts[index]);
        expect(back.ofs).toBe(ofs);
      }
    }
  });
});

describe("printers", () => {
  test("PR_PrintStatement and PR_StackTrace run for every statement shape", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_IF, 110, 3, 0],
      [OpT.OP_GOTO, -2, 0, 0],
      [OpT.OP_STORE_F, 110, 111, 0],
      [OpT.OP_ADD_F, 110, 111, 112],
      [999, 0, 0, 0], // op past pr_opnames: the name block is skipped
    ]);

    for (let i = 0; i < 6; i++) expect(() => PR_PrintStatement(i)).not.toThrow();

    expect(() => PR_StackTrace()).not.toThrow(); // pr_depth == 0 -> <NO STACK>
  });

  test("PR_Profile_f zeroes every function's profile and terminates", () => {
    const f1 = makeFunction(1, L0, 0, 0, []);
    const f2 = makeFunction(1, L0, 0, 0, []);
    f1.profile = 17;
    f2.profile = 4;
    pr.functions = [new DfunctionT(), f1, f2];

    PR_Profile_f();

    expect(f1.profile).toBe(0);
    expect(f2.profile).toBe(0);
  });

  test("executing a program accumulates profile counts on the running function", () => {
    const f1 = makeFunction(1, L0, 0, 0, []);
    pr.functions = [new DfunctionT(), f1];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [OpT.OP_ADD_F, 110, 111, 112],
      [OpT.OP_RETURN, 112, 0, 0],
    ]);

    PR_ExecuteProgram(1);

    expect(f1.profile).toBe(2);
  });
});

describe("bad opcode", () => {
  test("an unknown opcode raises Bad opcode", () => {
    pr.functions = [new DfunctionT(), makeFunction(1, L0, 0, 0, [])];
    setStatements([
      [OpT.OP_DONE, 0, 0, 0],
      [200, 0, 0, 0],
    ]);

    expect(() => PR_ExecuteProgram(1)).toThrow(PRRunError);
    expect(() => PR_ExecuteProgram(1)).toThrow("Bad opcode 200");
  });
});
