/*
The unified QuakeC VM's host profiles (src/progs/profiles).

Covers, in one process:
- switching the active profile between the two retail fixtures --
  ../qsrc/quake/progs106/progs.dat (system-defs CRC 5927, WinQuake's
  progdefs) under `nq` and ../qsrc/quake/QW/progs/qwprogs.dat (CRC 54730,
  QuakeWorld's own progdefs) under `qw` -- with each one's main() actually
  executed through the shared interpreter afterwards, and each host's VM
  state left holding its own progs;
- the name binding Ironwail's PR_InitBuiltins (Quake/pr_edict.c:1858-1900)
  does for the re-release progs' `= #0:ex_name` builtins: after load, every
  function whose first_statement, parm_start and locals are all zero is looked
  up in the profile's `namedBuiltins` and bound to a slot appended after the
  numbered table;
- the loud failure an *unbound* name gets here (Ironwail leaves it at
  first_statement 0, where calling it silently runs whatever statement sits at
  index 0);
- `checkextension` at builtin 99 answering from the profile's `extensions`.

The three extension-point cases build their progs.dat bytes inline rather than
reading a re-release pak, so they run on any checkout. Self-sufficient per
rule 13: its own scratch basedirs, its own filesystem init per load, and every
shared singleton it touches (both hosts' builtin tables, sv/svs on both sides,
com_searchpaths, sysState.nostdout, the active profile) restored in afterAll.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sysState } from "../src/platform/sys";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop, setComModified, setComSearchpaths } from "../src/common/common";
import {
  COM_CheckRegistered as QW_COM_CheckRegistered,
  COM_InitArgv as QW_COM_InitArgv,
  COM_InitFilesystem as QW_COM_InitFilesystem,
} from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { DFUNCTION_T_SIZE, DPROGRAMS_T_SIZE, DSTATEMENT_T_SIZE, OFS_PARM0, OFS_RETURN, OpT, PROG_VERSION } from "../src/progs/pr_comp";
import { PR_SetProfile, type ProgsProfileT } from "../src/progs/profiles/profile";
import { nqProfile } from "../src/progs/profiles/nq";
import { qwProfile } from "../src/progs/profiles/qw";
import * as edictCore from "../src/progs/pr_edict_core";
import * as execCore from "../src/progs/pr_exec_core";
import { PR_SetEngineString, pr } from "../src/progs/progs";
import { PRRunError } from "../src/progs/pr_exec";
import { PROGHEADER_CRC as NQ_PROGHEADER_CRC } from "../src/progs/progdefs";
import { PROGHEADER_CRC as QW_PROGHEADER_CRC } from "../src/qw/server/progdefs";
import { qwpr } from "../src/qw/server/progs";
import { getBuiltins as nqGetBuiltins, setBuiltins as nqSetBuiltins } from "../src/progs/pr_exec";
import { getBuiltins as qwGetBuiltins, setBuiltins as qwSetBuiltins } from "../src/qw/server/pr_exec";
import { sv as nqSv, svs as nqSvs } from "../src/server/server";
import { sv as qwSv } from "../src/qw/server/server";
import { MAX_EDICTS as QW_MAX_EDICTS } from "../src/qw/bothdefs";
import { HAVE_PROGS106, HAVE_QWPROGS, PROGS106_DAT, QWPROGS_DAT } from "./support/fixture_availability";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "progs-profiles-test-"));

const nqBaseDir = join(scratchDir, "nq");
const qwBaseDir = join(scratchDir, "qw");
const synthBaseDir = join(scratchDir, "synth");

const savedNostdout = sysState.nostdout;
let savedNqBuiltins: ReturnType<typeof nqGetBuiltins> | null = null;
let savedQwBuiltins: ReturnType<typeof qwGetBuiltins> | null = null;

function popLmp(): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    bytes[i * 2] = (pop[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = pop[i] & 0xff;
  }
  return bytes;
}

function makeBaseDir(dir: string, files: Array<{ path: string; data: Uint8Array }>): void {
  mkdirSync(join(dir, "id1"), { recursive: true });
  mkdirSync(join(dir, "qw"), { recursive: true });
  writePakToDisk(join(dir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp() }]);
  for (const file of files) writeFileSync(join(dir, file.path), file.data);
}

// A stub builtin table wide enough for every index the retail progs' QuakeC
// emits, so running main() exercises the interpreter and not the engine.
function stubBuiltins(): Array<() => void> {
  const stubs: Array<() => void> = [];
  for (let i = 0; i < 400; i++) stubs.push(() => {});
  return stubs;
}

beforeAll(() => {
  sysState.nostdout = 1;
  savedNqBuiltins = nqGetBuiltins();
  savedQwBuiltins = qwGetBuiltins();

  makeBaseDir(
    nqBaseDir,
    HAVE_PROGS106 ? [{ path: join("id1", "progs.dat"), data: new Uint8Array(readFileSync(PROGS106_DAT)) }] : [],
  );
  makeBaseDir(
    qwBaseDir,
    HAVE_QWPROGS ? [{ path: join("qw", "qwprogs.dat"), data: new Uint8Array(readFileSync(QWPROGS_DAT)) }] : [],
  );
  makeBaseDir(synthBaseDir, [{ path: join("id1", "progs.dat"), data: buildSyntheticProgs() }]);
});

afterAll(() => {
  if (savedNqBuiltins !== null) nqSetBuiltins(savedNqBuiltins);
  if (savedQwBuiltins !== null) qwSetBuiltins(savedQwBuiltins);
  sysState.nostdout = savedNostdout;
  setComSearchpaths(null);
  setComModified(false);
  nqSv.num_edicts = 0;
  nqSv.time = 0;
  nqSvs.maxclients = 0;
  qwSv.num_edicts = 0;
  qwSv.time = 0;
  PR_SetProfile(nqProfile);
  rmSync(scratchDir, { recursive: true, force: true });
});

function initNqFilesystem(baseDir: string): void {
  setComSearchpaths(null);
  setComModified(false);
  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
}

function initQwFilesystem(baseDir: string): void {
  setComSearchpaths(null);
  setComModified(false);
  QW_COM_InitArgv(["quake", "-basedir", baseDir]);
  QW_COM_InitFilesystem();
  QW_COM_CheckRegistered();
}

//============================================================================
// a hand-built progs.dat for the extension-point cases

const SYNTH_ENTITYFIELDS = 105;
const SYNTH_NUMGLOBALS = 100;
const SYNTH_EXTEST_GLOBAL = 92; // holds func_t 2 ("ex_test")
const SYNTH_EXMISSING_GLOBAL = 93; // holds func_t 3 ("ex_missing")

// function indices in the image below
const SYNTH_MAIN = 1;
const SYNTH_EX_TEST = 2;
const SYNTH_EX_MISSING = 3;
const SYNTH_CALL_MISSING = 4;

function buildSyntheticProgs(): Uint8Array {
  // strings block
  const names = ["", "main", "ex_test", "ex_missing", "call_missing"];
  const stringOfs: number[] = [];
  let stringBytes: number[] = [];
  for (const name of names) {
    stringOfs.push(stringBytes.length);
    for (let i = 0; i < name.length; i++) stringBytes.push(name.charCodeAt(i));
    stringBytes.push(0);
  }

  // statements: 0 is the conventional dummy every qcc build emits
  const statements: Array<[number, number, number, number]> = [
    [OpT.OP_DONE, 0, 0, 0],
    [OpT.OP_CALL0, SYNTH_EXTEST_GLOBAL, 0, 0],
    [OpT.OP_DONE, 0, 0, 0],
    [OpT.OP_CALL0, SYNTH_EXMISSING_GLOBAL, 0, 0],
    [OpT.OP_DONE, 0, 0, 0],
  ];

  // first_statement, parm_start, locals, s_name
  const functions: Array<[number, number, number, number]> = [
    [0, 0, 0, stringOfs[0]], // the null function
    [1, 0, 0, stringOfs[1]], // main
    [0, 0, 0, stringOfs[2]], // ex_test -- a `= #0:ex_test` stub
    [0, 0, 0, stringOfs[3]], // ex_missing -- a stub with no engine binding
    [3, 0, 0, stringOfs[4]], // call_missing
  ];

  const ofs_statements = DPROGRAMS_T_SIZE;
  const ofs_functions = ofs_statements + statements.length * DSTATEMENT_T_SIZE;
  const ofs_strings = ofs_functions + functions.length * DFUNCTION_T_SIZE;
  const ofs_globals = ofs_strings + stringBytes.length;
  const total = ofs_globals + SYNTH_NUMGLOBALS * 4;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  view.setInt32(0, PROG_VERSION, true);
  view.setInt32(4, NQ_PROGHEADER_CRC, true);
  view.setInt32(8, ofs_statements, true);
  view.setInt32(12, statements.length, true);
  view.setInt32(16, ofs_strings, true); // ofs_globaldefs (no defs; points at valid data)
  view.setInt32(20, 0, true); // numglobaldefs
  view.setInt32(24, ofs_strings, true); // ofs_fielddefs
  view.setInt32(28, 0, true); // numfielddefs
  view.setInt32(32, ofs_functions, true);
  view.setInt32(36, functions.length, true);
  view.setInt32(40, ofs_strings, true);
  view.setInt32(44, stringBytes.length, true);
  view.setInt32(48, ofs_globals, true);
  view.setInt32(52, SYNTH_NUMGLOBALS, true);
  view.setInt32(56, SYNTH_ENTITYFIELDS, true);

  statements.forEach((st, i) => {
    const at = ofs_statements + i * DSTATEMENT_T_SIZE;
    view.setUint16(at, st[0], true);
    view.setInt16(at + 2, st[1], true);
    view.setInt16(at + 4, st[2], true);
    view.setInt16(at + 6, st[3], true);
  });

  functions.forEach((fn, i) => {
    const at = ofs_functions + i * DFUNCTION_T_SIZE;
    view.setInt32(at, fn[0], true); // first_statement
    view.setInt32(at + 4, fn[1], true); // parm_start
    view.setInt32(at + 8, fn[2], true); // locals
    view.setInt32(at + 12, 0, true); // profile
    view.setInt32(at + 16, fn[3], true); // s_name
    view.setInt32(at + 20, 0, true); // s_file
    view.setInt32(at + 24, 0, true); // numparms
  });

  bytes.set(new Uint8Array(stringBytes), ofs_strings);

  view.setInt32(ofs_globals + SYNTH_EXTEST_GLOBAL * 4, SYNTH_EX_TEST, true);
  view.setInt32(ofs_globals + SYNTH_EXMISSING_GLOBAL * 4, SYNTH_EX_MISSING, true);

  return bytes;
}

//============================================================================

describe.skipIf(!HAVE_PROGS106 || !HAVE_QWPROGS)("PR_SetProfile switches hosts between two progs.dat in one process", () => {
  test("progs106 loads under nq, qwprogs under qw, and each main() runs on the shared interpreter", () => {
    // --- NetQuake
    initNqFilesystem(nqBaseDir);
    PR_SetProfile(nqProfile);
    edictCore.PR_LoadProgs();

    expect(pr.progs).not.toBeNull();
    expect(pr.progs?.crc).toBe(NQ_PROGHEADER_CRC);
    expect(pr.progs?.entityfields).toBe(195);
    expect(pr.global_struct).not.toBeNull();

    edictCore.PR_AllocEdicts(64);
    nqSv.num_edicts = 2;
    nqSv.time = 0;
    nqSetBuiltins(stubBuiltins());

    const nqMain = pr.global_struct?.main ?? 0;
    expect(nqMain).toBeGreaterThan(0);
    expect(() => execCore.PR_ExecuteProgram(nqMain)).not.toThrow();
    expect(pr.exec.depth).toBe(0);

    // --- QuakeWorld, same process
    initQwFilesystem(qwBaseDir);
    PR_SetProfile(qwProfile);
    edictCore.PR_LoadProgs();

    expect(qwpr.progs).not.toBeNull();
    expect(qwpr.progs?.crc).toBe(QW_PROGHEADER_CRC);
    expect(qwpr.global_struct).not.toBeNull();

    edictCore.PR_AllocEdicts(QW_MAX_EDICTS);
    qwSv.num_edicts = 1;
    qwSv.time = 0;
    qwSetBuiltins(stubBuiltins());

    const qwMain = qwpr.global_struct?.main ?? 0;
    expect(qwMain).toBeGreaterThan(0);
    expect(() => execCore.PR_ExecuteProgram(qwMain)).not.toThrow();
    expect(qwpr.exec.depth).toBe(0);

    // the two VM states stayed separate across the switch
    expect(pr.progs?.crc).toBe(NQ_PROGHEADER_CRC);
    expect(qwpr.progs?.crc).toBe(QW_PROGHEADER_CRC);
    expect(pr.functions).not.toBe(qwpr.functions);
  });

  test("each host's globalvars layout rejects the other host's fields", () => {
    // WinQuake has deathmatch/coop/teamplay and no newmis; QuakeWorld the
    // reverse. progdefs_layout.ts installs a throwing accessor for whichever
    // the loaded layout does not declare.
    const nqGlobals = pr.global_struct;
    const qwGlobals = qwpr.global_struct;
    if (nqGlobals === null || qwGlobals === null) throw new Error("PR_LoadProgs has not run");

    expect(() => nqGlobals.deathmatch).not.toThrow();
    expect(() => nqGlobals.newmis).toThrow(/newmis/);
    expect(() => qwGlobals.newmis).not.toThrow();
    expect(() => qwGlobals.deathmatch).toThrow(/deathmatch/);
  });
});

//============================================================================

describe("name-bound builtins and checkextension", () => {
  let exTestCalls = 0;

  const testProfile: ProgsProfileT = {
    ...nqProfile,
    namedBuiltins: new Map<string, () => void>([
      [
        "ex_test",
        () => {
          exTestCalls++;
        },
      ],
    ]),
    extensions: new Set(["TEST_EXTENSION"]),
  };

  function loadSynthetic(): void {
    initNqFilesystem(synthBaseDir);
    PR_SetProfile(testProfile);
    edictCore.PR_LoadProgs();
    edictCore.PR_AllocEdicts(8);
    nqSv.num_edicts = 2;
    nqSv.time = 0;
    exTestCalls = 0;
  }

  test("a function with first_statement/parm_start/locals all zero is bound by name", () => {
    loadSynthetic();

    const numbered = testProfile.numberedBuiltins().length;
    const bound = pr.functions[SYNTH_EX_TEST];
    expect(bound.first_statement).toBeLessThan(0);
    // the slot lives past the numbered table and past checkextension's 99
    // (U9: the NetQuake numbered table now runs to 401 for `setcolor`, so the
    // first appended slot is the table's own length)
    expect(-bound.first_statement).toBeGreaterThanOrEqual(Math.max(numbered, edictCore.CHECKEXTENSION_BUILTIN + 1));
    expect(-bound.first_statement).toBeLessThan(pr.builtins.length);

    // functions that carry real bytecode are left alone
    expect(pr.functions[SYNTH_MAIN].first_statement).toBe(1);
    // ...and so is the all-zero null function at index 0, which has no name
    expect(pr.functions[0].first_statement).toBe(0);

    execCore.PR_ExecuteProgram(SYNTH_MAIN);
    expect(exTestCalls).toBe(1);
  });

  test("an unbound name raises a PR_RunError naming the function instead of running statement 0", () => {
    loadSynthetic();

    const unbound = pr.functions[SYNTH_EX_MISSING];
    expect(unbound.first_statement).toBeLessThan(0);

    let message = "";
    expect(() => {
      try {
        execCore.PR_ExecuteProgram(SYNTH_CALL_MISSING);
      } catch (e) {
        if (e instanceof Error) message = e.message;
        throw e;
      }
    }).toThrow(PRRunError);
    expect(message).toContain("ex_missing");
  });

  test("checkextension (builtin 99) answers from the profile's extension set", () => {
    loadSynthetic();

    const globals = pr.globals;
    if (globals === null) throw new Error("PR_LoadProgs has not run");
    const checkextension = pr.builtins[edictCore.CHECKEXTENSION_BUILTIN];

    globals.i[OFS_PARM0] = PR_SetEngineString("TEST_EXTENSION");
    checkextension();
    expect(globals.f[OFS_RETURN]).toBe(1);

    globals.i[OFS_PARM0] = PR_SetEngineString("NO_SUCH_EXTENSION");
    checkextension();
    expect(globals.f[OFS_RETURN]).toBe(0);
  });
});
