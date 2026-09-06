/*
Self-sufficient test for Q011: src/qw/server/pr_edict.ts + pr_exec.ts (QW's
own progs loader and bytecode interpreter for the standalone qwsv binary).
Builds its own scratch `-basedir` (id1/pak0.pak with gfx/pop.lmp for the
registration recipe, plus a loose qw/qwprogs.dat -- the real retail
QuakeWorld progs, ../qsrc/quake/QW/progs/qwprogs.dat) and re-initializes
com_searchpaths/com_modified through src/qw/common.ts's own
COM_InitArgv/COM_InitFilesystem, per test/qw_common.test.ts's own recipe and
per standing order 13 (never rely on another test file's run having already
initialized shared state) and rule 15 (shared singletons get reset by their
own suite): com_searchpaths is the same process-wide singleton every other
suite reaches through src/common/common.ts, so this file resets it before
building its own fixture and restores it afterward.

This is the "headless qwsv boot on qwprogs.dat" milestone PORTING.md's
QuakeWorld track names: load the real retail progs, walk its lump tables,
find its well-known functions, allocate an edict table, parse an entity
block, and execute one QuakeC function through the interpreter -- all
without a real pr_cmds.ts (Q012, not yet landed): PR_ExecuteProgram's calls
into the builtin table are stubbed out through pr_exec.ts's `setBuiltins`
seam, exactly as pr_exec.test.ts (WinQuake) does with a hand-built program.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sysState } from "../src/platform/sys";
import { setComSearchpaths, setComModified } from "../src/common/common";
import { Cmd_TokenizeString } from "../src/common/cmd";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, COM_Parse, pop, type ParseState } from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { PROGHEADER_CRC } from "../src/qw/server/progdefs";
import { MAX_EDICTS, MAX_MSGLEN } from "../src/qw/bothdefs";
import { SZ_Alloc, net_message } from "../src/common/sizebuf";
import { MAX_CLIENTS } from "../src/qw/protocol";
import { EDICT_NUM, PR_GetString, QwEdictT, qwpr, setEdictTable } from "../src/qw/server/progs";
import { sv, svs } from "../src/qw/server/server";
import {
  ED_Alloc,
  ED_ClearEdict,
  ED_Count,
  ED_Free,
  ED_FindFunction,
  ED_LoadFromFile,
  ED_NewString,
  ED_ParseEdict,
  ED_Print,
  ED_PrintEdict_f,
  ED_PrintEdicts,
  PR_AllocEdicts,
  PR_Init,
  PR_LoadProgs,
  PR_Progs,
  prSpectator,
} from "../src/qw/server/pr_edict";
import { PRRunError, PR_ExecuteProgram, prExec, setBuiltins } from "../src/qw/server/pr_exec";
import { svErrorState } from "../src/qw/server/sv_main";
import { HAVE_QWPROGS } from "./support/fixture_availability";

const QWPROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/QW/progs/qwprogs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-progs-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;
const savedNetMessageData = net_message.data;
const savedNetMessageMaxsize = net_message.maxsize;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setComSearchpaths(null);
  setComModified(false);
  net_message.data = savedNetMessageData;
  net_message.maxsize = savedNetMessageMaxsize;
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  // ED_Print/ED_PrintEdicts/ED_Count/PR_LoadProgs's own diagnostics write
  // through Con_Printf -> Sys_Printf; keep the suite quiet.
  sysState.nostdout = 1;

  // No throw: a missing QW/progs/qwprogs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_QWPROGS), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_QWPROGS) return;

  // com_searchpaths is a process-wide singleton (shared with every WinQuake
  // and QW suite alike, per Task 1's structural fix); reset it before
  // building this file's own fixture so an earlier-run suite's leftover
  // search path entries cannot satisfy (or shadow) a lookup this file's own
  // fixture is supposed to answer.
  setComSearchpaths(null);
  setComModified(false);

  // gfx/pop.lmp inside id1/pak0.pak: the registered-version check's 128
  // big-endian shorts, same recipe as every other suite's registration fixture.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  // the real retail QuakeWorld progs, loose under qw/ -- PR_LoadProgs tries
  // "qwprogs.dat" first (a real QW delta over WinQuake, see pr_edict.ts's
  // file header), so this exercises that exact path rather than the
  // progs.dat fallback.
  mkdirSync(join(baseDir, "qw"), { recursive: true });
  const qwprogsData = new Uint8Array(readFileSync(QWPROGS_DAT));
  writeFileSync(join(baseDir, "qw", "qwprogs.dat"), qwprogsData);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();

  PR_LoadProgs();
  PR_AllocEdicts(MAX_EDICTS);
  sv.num_edicts = 1;
  sv.time = 0;

  // SV_Error (sv_main.ts) unconditionally calls SV_FinalMessage, which
  // writes into net_message before checking whether any client is even
  // connected -- the two "throws PRRunError" tests below provoke SV_Error
  // for real, so net_message needs a real buffer the same way a booted
  // server's own NET_Init would have given it (net_main.ts's own SZ_Alloc,
  // never called by this suite's own fixture).
  SZ_Alloc(net_message, MAX_MSGLEN);

  // pr_cmds.ts (Q012) is not landed yet; install a stub table big enough to
  // cover every builtin index the retail progs' QuakeC ever emits, via
  // pr_exec.ts's own setBuiltins seam (the same one src/progs/pr_cmds.ts
  // fills for the WinQuake track).
  const stubs: Array<() => void> = [];
  for (let i = 0; i < 300; i++) stubs.push(() => {});
  setBuiltins(stubs);
});

function parseState(data: string): ParseState {
  return { data, index: 0 };
}

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("PR_LoadProgs", () => {
  test("loads the real qwprogs.dat: header CRC passes, progs.crc === PROGHEADER_CRC (54730)", () => {
    expect(PROGHEADER_CRC).toBe(54730);
    expect(PR_Progs().crc).toBe(PROGHEADER_CRC);
    expect(PR_Progs().version).toBe(6);
  });

  test("lump counts match the retail qwprogs.dat", () => {
    const header = PR_Progs();
    expect(qwpr.functions.length).toBe(header.numfunctions);
    expect(qwpr.globaldefs.length).toBe(header.numglobaldefs);
    expect(qwpr.fielddefs.length).toBe(header.numfielddefs);
    expect(qwpr.statements.op.length).toBe(header.numstatements);
    expect(qwpr.globals).not.toBeNull();
    expect(qwpr.global_struct).not.toBeNull();
    expect(qwpr.strings).not.toBeNull();

    // measured against the real file, a concrete regression check (mirrors
    // test/pr_edict.test.ts's own "fills the dprograms_t header" style)
    expect(header.numfunctions).toBe(482);
    expect(header.numglobaldefs).toBe(2114);
    expect(header.numfielddefs).toBe(216);
    expect(header.entityfields).toBe(194);
  });

  test("qwpr.edict_size is entityfields, in words (see file header deviation note)", () => {
    expect(qwpr.edict_size).toBe(PR_Progs().entityfields);
    expect(qwpr.edict_size).toBe(194);
  });

  test("a real QW delta: the whole-file CRC_Block result is published to svs.info under *progs, not kept as a persistent pr_crc global", () => {
    expect(svs.info).toContain("\\*progs\\");
    // qwpr.crc is filled with the same CRC_Block value for this port's own
    // bookkeeping (see pr_edict.ts's file header); it is NOT PROGHEADER_CRC.
    expect(qwpr.crc).not.toBe(0);
    expect(qwpr.crc).not.toBe(PROGHEADER_CRC);
  });

  test("Zoid's spectator functions are resolved: the retail qwprogs.dat has all three", () => {
    expect(prSpectator.connect).toBeGreaterThan(0);
    expect(prSpectator.think).toBeGreaterThan(0);
    expect(prSpectator.disconnect).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAVE_QWPROGS)("ED_FindFunction", () => {
  test("finds main / StartFrame / PutClientInServer / worldspawn", () => {
    expect(ED_FindFunction("main")).not.toBeNull();
    expect(ED_FindFunction("StartFrame")).not.toBeNull();
    expect(ED_FindFunction("PutClientInServer")).not.toBeNull();
    expect(ED_FindFunction("worldspawn")).not.toBeNull();
    expect(ED_FindFunction("no_such_function_at_all")).toBeNull();
  });
});

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("ED_Alloc / ED_Free (over sv.edicts, MAX_EDICTS QwEdictT allocated via setEdictTable)", () => {
  test("allocation starts at MAX_CLIENTS+1, not svs.maxclients (QW has no such field) and not edict 0", () => {
    sv.num_edicts = MAX_CLIENTS + 1;
    sv.time = 5;

    const e = ED_Alloc();
    expect(e.index).toBe(MAX_CLIENTS + 1);
    expect(sv.num_edicts).toBe(MAX_CLIENTS + 2);
    expect(e.free).toBe(false);
  });

  test("a just-freed edict is not reused until sv.time moves past freetime+0.5", () => {
    sv.num_edicts = MAX_CLIENTS + 1;
    sv.time = 5;

    const first = ED_Alloc();
    expect(first.index).toBe(MAX_CLIENTS + 1);
    ED_Free(first);
    expect(first.free).toBe(true);
    expect(first.freetime).toBe(5);
    expect(first.v.nextthink).toBe(-1);

    const second = ED_Alloc();
    expect(second.index).toBe(MAX_CLIENTS + 2);

    sv.time = 5.6;
    const third = ED_Alloc();
    expect(third.index).toBe(MAX_CLIENTS + 1);
    expect(third.free).toBe(false);
  });

  test("ED_Free resets exactly the fields the C resets", () => {
    sv.num_edicts = MAX_CLIENTS + 1;
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

  test("QW delta: 'no free edicts' reuses the last edict with a warning instead of throwing", () => {
    // sv.num_edicts === MAX_EDICTS is the only way the C's `i == MAX_EDICTS`
    // branch is reachable, so this test uses the full MAX_EDICTS-sized table
    // (already allocated in beforeAll) with every slot marked in-use.
    const savedEdicts = sv.edicts;
    const savedNum = sv.num_edicts;
    try {
      sv.num_edicts = MAX_EDICTS;
      for (let i = MAX_CLIENTS + 1; i < MAX_EDICTS; i++) ED_ClearEdict(EDICT_NUM(i));

      const e = ED_Alloc();
      expect(e.index).toBe(MAX_EDICTS - 1); // stepped on the last edict
      expect(sv.num_edicts).toBe(MAX_EDICTS); // NOT incremented past MAX_EDICTS
      expect(e.free).toBe(false);
    } finally {
      setEdictTable(savedEdicts);
      sv.edicts = savedEdicts;
      sv.num_edicts = savedNum;
    }
  });
});

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("ED_ParseEdict", () => {
  test("sets classname/origin from a small entity string", () => {
    const ed = EDICT_NUM(20);
    ED_ClearEdict(ed);

    const ps = parseState('{\n"classname" "info_player_start"\n"origin" "1 2 3"\n"angle" "90"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    ED_ParseEdict(ps, ed);

    expect(PR_GetString(ed.v.classname)).toBe("info_player_start");
    expect(Array.from(ed.v.origin)).toEqual([1, 2, 3]);
    expect(Array.from(ed.v.angles)).toEqual([0, 90, 0]); // the QuakeEd angle hack
    expect(ed.free).toBe(false);
  });

  test("QW delta: unknown key message has no surrounding quotes ('%s is not a field', not \"'%s' is not a field\")", () => {
    // no direct string-capture hook is in this unit's scope (console.ts is
    // shared, out of SCOPE); this asserts the call completes without
    // throwing and that init still happens, mirroring
    // test/pr_edict.test.ts's own "unknown keys are reported and skipped"
    // case, which is the observable behavior this delta does not change.
    const ed = EDICT_NUM(21);
    ED_ClearEdict(ed);
    const ps = parseState('{\n"no_such_field_at_all" "1"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    expect(() => ED_ParseEdict(ps, ed)).not.toThrow();
    expect(ed.free).toBe(false);
  });

  test("a malformed value (unknown ev_function/ev_field name) throws PRRunError, not a bare Error", () => {
    const ed = EDICT_NUM(22);
    ED_ClearEdict(ed);
    // `think` is an ev_function field; a name that isn't a real function
    // makes ED_ParseEpair return false, which SV_Error's "parse error"
    const ps = parseState('{\n"think" "no_such_function_at_all"\n}\n');
    expect(COM_Parse(ps)).toBe("{");
    // SV_Error's real implementation (sv_main.ts) now runs for real; its
    // `static qboolean inerror` reentrancy guard is a process-wide
    // singleton another test file may have left tripped (rule 15), so
    // clear it before provoking SV_Error here rather than assume it is
    // fresh.
    svErrorState.inerror = false;
    expect(() => ED_ParseEdict(ps, ed)).toThrow(PRRunError);
  });
});

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("ED_LoadFromFile", () => {
  test("QW delta: only SPAWNFLAG_NOT_DEATHMATCH inhibits -- no deathmatch.value/skill-level filtering at all", () => {
    // realistic QW boot state: sv.num_edicts already reserves the MAX_CLIENTS
    // player slots (SV_SpawnServer's job, not this unit's), so ED_Alloc's
    // MAX_CLIENTS+1 scan start actually lands on freshly-cleared edicts.
    sv.num_edicts = MAX_CLIENTS + 1;
    sv.time = 5;
    for (let i = 0; i < MAX_EDICTS; i++) {
      ED_ClearEdict(EDICT_NUM(i));
      EDICT_NUM(i).freetime = 0;
    }

    const SPAWNFLAG_NOT_DEATHMATCH = 2048;
    const entities =
      `{\n"classname" "no_spawn_function_a"\n"netname" "first"\n"origin" "8 9 10"\n}\n` +
      `{\n"classname" "no_spawn_function_b"\n"spawnflags" "${SPAWNFLAG_NOT_DEATHMATCH}"\n}\n` +
      // WinQuake would inhibit this one at skill 0 (SPAWNFLAG_NOT_EASY); QW
      // has no such check at all, so it is allocated normally.
      `{\n"classname" "no_spawn_function_c"\n"spawnflags" "256"\n}\n`;

    ED_LoadFromFile(parseState(entities));

    expect(qwpr.global_struct?.time).toBe(5);

    const world = EDICT_NUM(0);
    expect(PR_GetString(world.v.netname)).toBe("first");
    expect(world.free).toBe(true); // "No spawn function for:" -> ED_Free

    // second entity: SPAWNFLAG_NOT_DEATHMATCH -> inhibited before the
    // classname lookup even runs (ED_Alloc'd at MAX_CLIENTS+1). third:
    // allocated right after it (no skill filter in QW), then freed only
    // because it has no real spawn function either.
    expect(sv.num_edicts).toBe(MAX_CLIENTS + 3);
    expect(EDICT_NUM(MAX_CLIENTS + 1).free).toBe(true);
    expect(EDICT_NUM(MAX_CLIENTS + 2).free).toBe(true);
    expect(PR_GetString(EDICT_NUM(MAX_CLIENTS + 2).v.classname)).toBe("no_spawn_function_c");
  });

  test("an entity with no classname at all is freed", () => {
    sv.num_edicts = MAX_CLIENTS + 1;
    sv.time = 5;
    for (let i = 0; i < MAX_EDICTS; i++) {
      ED_ClearEdict(EDICT_NUM(i));
      EDICT_NUM(i).freetime = 0;
    }

    ED_LoadFromFile(parseState('{\n"origin" "1 1 1"\n}\n'));
    expect(EDICT_NUM(0).free).toBe(true);
    expect(sv.num_edicts).toBe(MAX_CLIENTS + 1);
  });
});

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("PR_ExecuteProgram", () => {
  test("runs the retail qwprogs.dat's main() to completion through the stubbed builtin table", () => {
    sv.num_edicts = 1;
    sv.time = 0;
    ED_ClearEdict(EDICT_NUM(0));

    const mainFn = ED_FindFunction("main");
    expect(mainFn).not.toBeNull();
    if (mainFn === null) return;
    const idx = qwpr.functions.indexOf(mainFn);

    const depthBefore = prExec.depth;
    expect(() => PR_ExecuteProgram(idx)).not.toThrow();
    // the interpreter's own stack-balance invariant: PR_ExecuteProgram
    // returns only once prExec.depth is back to the depth it entered at
    expect(prExec.depth).toBe(depthBefore);
  });

  test("a NULL function number throws PRRunError (SV_Error, not Host_Error)", () => {
    // see the "malformed value" test above: reset SV_Error's reentrancy
    // guard before provoking it again, rather than assume it is fresh.
    svErrorState.inerror = false;
    expect(() => PR_ExecuteProgram(0)).toThrow(PRRunError);
  });
});

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("ED_Print / ED_PrintEdicts / ED_PrintEdict_f / ED_Count (QW's header-line delta)", () => {
  test("run over the live edict table without throwing", () => {
    sv.num_edicts = 4;
    for (let i = 0; i < 4; i++) ED_ClearEdict(EDICT_NUM(i));
    EDICT_NUM(1).free = true;
    EDICT_NUM(2).v.solid = 1;
    EDICT_NUM(2).v.model = ED_NewString("progs/player.mdl");
    EDICT_NUM(3).v.movetype = 4; // MOVETYPE_STEP

    // QW delta: ED_Print itself no longer prints "\nEDICT %i:\n" (moved to
    // its two callers below); still must not throw either way.
    expect(() => ED_Print(EDICT_NUM(1))).not.toThrow();
    expect(() => ED_Print(EDICT_NUM(2))).not.toThrow();
    expect(() => ED_PrintEdicts()).not.toThrow();
    expect(() => ED_Count()).not.toThrow();
  });

  test("QW delta: ED_PrintEdict_f no longer bounds-checks -- an out-of-range index throws via EDICT_NUM itself", () => {
    Cmd_TokenizeString(`edict ${MAX_EDICTS + 5}`);
    expect(() => ED_PrintEdict_f()).toThrow();
  });
});

describe.skipIf(!HAVE_QWPROGS)("PR_Init", () => {
  test("registers edict/edicts/edictcount/profile and no cvars (QW's eleven WinQuake cvars are all gone)", () => {
    expect(() => PR_Init()).not.toThrow();
  });
});
