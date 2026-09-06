/*
Regression suite for the `string_t` encoding of both progs hosts
(src/progs/progs.ts and src/qw/server/progs.ts).

The globals block and every edict's field block are one ArrayBuffer viewed as
both an Int32Array and a Float32Array. Every negative int32 in
[-0x7FFFFF, -1] has all float32 exponent bits set with a non-zero mantissa --
it is a NaN bit pattern -- and JavaScript does not preserve NaN payloads
across a float read/write, so `f[b] = f[a]` canonicalises it to 0x7FC00000.
qcc moves every builtin argument with OP_STORE_V, a three-word float copy, so
while engine string indices were negative every engine-owned string handed to
a builtin was destroyed in transit: on retail data doors.qc's `func_door` ran
`OP_LOAD_S self.model -> t`, `OP_STORE_V t -> OFS_PARM1`, `OP_CALL2 setmodel`,
and PF_setmodel then wrote 0x7FC00000 into `e.v.model`.

These tests pin the fix: indices are positive, based at ENGINE_STRING_BASE,
and therefore ordinary finite float32 values that round-trip a float copy
exactly.

Per standing order 13 and rule 15 this file builds its own scratch basedir,
pak and gfx/pop.lmp for each host, and resets com_searchpaths/com_modified
(a process-wide singleton shared with every other suite) around its fixtures.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sysState } from "../src/platform/sys";
import { COM_Parse, setComModified, setComSearchpaths, type ParseState } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, writeGameFile } from "./support/bsp_builder";
import { SZ_Alloc } from "../src/common/sizebuf";
import { OFS_PARM0, OFS_PARM1 } from "../src/progs/pr_comp";

import {
  COM_CheckRegistered as NQ_COM_CheckRegistered,
  COM_InitArgv as NQ_COM_InitArgv,
  COM_InitFilesystem as NQ_COM_InitFilesystem,
  pop,
} from "../src/common/common";
import { Mod_ForName as NQ_Mod_ForName, Mod_Init as NQ_Mod_Init } from "../src/common/model";
import {
  ENGINE_STRING_BASE,
  EDICT_NUM as NQ_EDICT_NUM,
  EDICT_TO_PROG as NQ_EDICT_TO_PROG,
  PR_GetString as NQ_PR_GetString,
  PR_SetEngineString,
  pr,
} from "../src/progs/progs";
import {
  ED_ClearEdict as NQ_ED_ClearEdict,
  ED_ParseEdict as NQ_ED_ParseEdict,
  PR_AllocEdicts as NQ_PR_AllocEdicts,
  PR_LoadProgs as NQ_PR_LoadProgs,
} from "../src/progs/pr_edict";
import { pr_builtin as nq_pr_builtin } from "../src/progs/pr_cmds";
import {
  MOVETYPE_PUSH as NQ_MOVETYPE_PUSH,
  ServerStateT as NQ_ServerStateT,
  SOLID_BSP as NQ_SOLID_BSP,
  sv as nqsv,
  svs as nqsvs,
} from "../src/server/server";
import { SV_ClearWorld as NQ_SV_ClearWorld } from "../src/server/world";

import {
  COM_CheckRegistered as QW_COM_CheckRegistered,
  COM_InitArgv as QW_COM_InitArgv,
  COM_InitFilesystem as QW_COM_InitFilesystem,
} from "../src/qw/common";
import { Mod_ForName as QW_Mod_ForName, Mod_Init as QW_Mod_Init } from "../src/qw/server/model";
import { MAX_EDICTS } from "../src/qw/bothdefs";
import {
  ENGINE_STRING_BASE as QW_ENGINE_STRING_BASE,
  EDICT_NUM as QW_EDICT_NUM,
  EDICT_TO_PROG as QW_EDICT_TO_PROG,
  PR_GetString as QW_PR_GetString,
  PR_SetString,
  qwpr,
} from "../src/qw/server/progs";
import {
  ED_ClearEdict as QW_ED_ClearEdict,
  ED_ParseEdict as QW_ED_ParseEdict,
  PR_AllocEdicts as QW_PR_AllocEdicts,
  PR_LoadProgs as QW_PR_LoadProgs,
} from "../src/qw/server/pr_edict";
import { pr_builtin as qw_pr_builtin } from "../src/qw/server/pr_cmds";
import {
  MOVETYPE_PUSH as QW_MOVETYPE_PUSH,
  ServerStateT as QW_ServerStateT,
  SOLID_BSP as QW_SOLID_BSP,
  sv as qwsv,
} from "../src/qw/server/server";
import { SV_ClearWorld as QW_SV_ClearWorld } from "../src/qw/server/world";
import { HAVE_PROGS106, HAVE_QWPROGS } from "./support/fixture_availability";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;
const QWPROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/QW/progs/qwprogs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "progs-string-bits-"));

const savedNostdout = sysState.nostdout;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

function popLmp(): Uint8Array {
  const lmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    lmp[i * 2] = (pop[i] >> 8) & 0xff;
    lmp[i * 2 + 1] = pop[i] & 0xff;
  }
  return lmp;
}

function parseState(data: string): ParseState {
  return { data, index: 0 };
}

// The exact copy the interpreter's OP_STORE_V / OP_LOAD_V perform: three
// words moved through the Float32Array view of a buffer that also carries
// int32-typed string_t words.
function floatCopy(dst: Float32Array, dstOfs: number, src: Float32Array, srcOfs: number, words: number): void {
  for (let i = 0; i < words; i++) dst[dstOfs + i] = src[srcOfs + i];
}

// The map entity both hosts get spawned from: the three engine-string fields
// the retail defect showed up in (`model` after setmodel, plus `target` and
// `targetname` written by ED_ParseEpair/ED_NewString).
const ENTITY_STRING =
  '{\n"classname" "func_door"\n"model" "maps/world.bsp"\n"target" "t16"\n"targetname" "door1"\n"netname" "Player1"\n"message" "You need the silver key"\n}\n';

//============================================================================

describe("string_t bit patterns", () => {
  test("every engine string index is a finite float32, never a NaN bit pattern", () => {
    // 0x7F800000 is the smallest int32 that reinterprets as a float32 NaN or
    // infinity; ENGINE_STRING_BASE plus any plausible table size stays below it.
    expect(ENGINE_STRING_BASE).toBeGreaterThan(0);
    expect(ENGINE_STRING_BASE).toBeLessThan(0x7f800000);
    expect(QW_ENGINE_STRING_BASE).toBeGreaterThan(0);
    expect(QW_ENGINE_STRING_BASE).toBeLessThan(0x7f800000);

    const buffer = new ArrayBuffer(8);
    const f = new Float32Array(buffer);
    const i = new Int32Array(buffer);

    for (let n = 0; n < 64; n++) {
      i[0] = ENGINE_STRING_BASE + n;
      expect(Number.isNaN(f[0])).toBe(false);
      floatCopy(f, 1, f, 0, 1);
      expect(i[1]).toBe(ENGINE_STRING_BASE + n);
    }
  });

  test("the old negative encoding is what a float copy destroyed", () => {
    // Documents the defect this suite guards: -(n + 1) for small n is a
    // float32 NaN bit pattern, and the copy canonicalises it to 0x7FC00000.
    const buffer = new ArrayBuffer(8);
    const f = new Float32Array(buffer);
    const i = new Int32Array(buffer);

    i[0] = -10;
    expect(Number.isNaN(f[0])).toBe(true);
    floatCopy(f, 1, f, 0, 1);
    expect(i[1]).not.toBe(-10);
    expect(i[1]).toBe(0x7fc00000 | 0);
  });
});

//============================================================================
// WinQuake host

describe.skipIf(!HAVE_PROGS106)("src/progs: engine strings survive a float-view copy", () => {
  const baseDir = join(scratchDir, "nq", "quake");

  beforeAll(() => {
    sysState.nostdout = 1;
    if (!existsSync(PROGS_DAT)) throw new Error(`missing test fixture ${PROGS_DAT}`);

    setComSearchpaths(null);
    setComModified(false);

    mkdirSync(join(baseDir, "id1"), { recursive: true });
    writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
      { name: "gfx/pop.lmp", data: popLmp() },
      { name: "progs.dat", data: new Uint8Array(readFileSync(PROGS_DAT)) },
    ]);

    NQ_COM_InitArgv(["quake", "-basedir", baseDir]);
    NQ_COM_InitFilesystem();
    NQ_COM_CheckRegistered();
    NQ_Mod_Init();

    NQ_PR_LoadProgs();
    NQ_PR_AllocEdicts(64);
    nqsv.num_edicts = 1;
    nqsv.time = 0;

    nqsvs.maxclients = 1;
    nqsvs.clients = [];

    SZ_Alloc(nqsv.datagram, 1024);
    SZ_Alloc(nqsv.reliable_datagram, 1024);
    SZ_Alloc(nqsv.signon, 8192);

    const mod = NQ_Mod_ForName("maps/world.bsp", true);
    if (mod === null) throw new Error("expected maps/world.bsp to load");
    nqsv.worldmodel = mod;
    nqsv.models[1] = mod;
    nqsv.model_precache[0] = "";
    nqsv.model_precache[1] = "maps/world.bsp";

    const world = NQ_EDICT_NUM(0);
    world.v.solid = NQ_SOLID_BSP;
    world.v.movetype = NQ_MOVETYPE_PUSH;
    world.v.modelindex = 1;

    NQ_SV_ClearWorld();
    nqsv.state = NQ_ServerStateT.ss_loading;
  });

  function globals(): { f: Float32Array; i: Int32Array } {
    if (pr.globals === null) throw new Error("pr.globals not set");
    return pr.globals;
  }

  test("PR_GetString still resolves an index copied through a Float32Array", () => {
    const s = PR_SetEngineString("progs/player.mdl");
    expect(s).toBeGreaterThanOrEqual(ENGINE_STRING_BASE);

    const g = globals();
    const scratch = g.i.length - 8;
    g.i[scratch] = s;
    floatCopy(g.f, scratch + 4, g.f, scratch, 1);

    expect(g.i[scratch + 4]).toBe(s);
    expect(NQ_PR_GetString(g.i[scratch + 4])).toBe("progs/player.mdl");
  });

  test("setmodel resolves a model string_t moved into OFS_PARM1 by a float copy", () => {
    const ed = NQ_EDICT_NUM(30);
    NQ_ED_ClearEdict(ed);

    const ps = parseState(ENTITY_STRING);
    expect(COM_Parse(ps)).toBe("{");
    NQ_ED_ParseEdict(ps, ed);

    expect(NQ_PR_GetString(ed.v.model)).toBe("maps/world.bsp");

    // exactly what qcc emits for `setmodel (self, self.model)`: OP_LOAD_S into
    // a temp global, then OP_STORE_V that temp into OFS_PARM1, then OP_CALL2
    const g = globals();
    const temp = g.i.length - 8;
    g.i[temp] = ed.v.model;
    g.i[OFS_PARM0] = NQ_EDICT_TO_PROG(ed);
    floatCopy(g.f, OFS_PARM1, g.f, temp, 3);

    expect(g.i[OFS_PARM1]).toBe(ed.v.model);

    nq_pr_builtin[3](); // void(entity e, string m) setmodel = #3

    expect(NQ_PR_GetString(ed.v.model)).toBe("maps/world.bsp");
    expect(ed.v.modelindex).toBe(1);
  });

  test("every string field of a spawned edict survives a float copy of the whole entvars block", () => {
    const ed = NQ_EDICT_NUM(31);
    NQ_ED_ClearEdict(ed);

    const ps = parseState(ENTITY_STRING);
    expect(COM_Parse(ps)).toBe("{");
    NQ_ED_ParseEdict(ps, ed);

    const g = globals();
    g.i[OFS_PARM0] = NQ_EDICT_TO_PROG(ed);
    g.i[OFS_PARM1] = ed.v.model;
    nq_pr_builtin[3]();

    const copy = NQ_EDICT_NUM(32);
    NQ_ED_ClearEdict(copy);
    floatCopy(copy.fields.f, 0, ed.fields.f, 0, ed.fields.f.length);

    expect(NQ_PR_GetString(copy.v.classname)).toBe("func_door");
    expect(NQ_PR_GetString(copy.v.model)).toBe("maps/world.bsp");
    expect(NQ_PR_GetString(copy.v.target)).toBe("t16");
    expect(NQ_PR_GetString(copy.v.targetname)).toBe("door1");
    expect(NQ_PR_GetString(copy.v.netname)).toBe("Player1");
    expect(NQ_PR_GetString(copy.v.message)).toBe("You need the silver key");
  });
});

//============================================================================
// QuakeWorld host

describe.skipIf(!HAVE_QWPROGS)("src/qw/server: engine strings survive a float-view copy", () => {
  const baseDir = join(scratchDir, "qw", "quake");

  beforeAll(() => {
    sysState.nostdout = 1;
    if (!existsSync(QWPROGS_DAT)) throw new Error(`missing test fixture ${QWPROGS_DAT}`);

    setComSearchpaths(null);
    setComModified(false);

    mkdirSync(join(baseDir, "id1"), { recursive: true });
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp() }]);
    writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

    mkdirSync(join(baseDir, "qw"), { recursive: true });
    writeFileSync(join(baseDir, "qw", "qwprogs.dat"), new Uint8Array(readFileSync(QWPROGS_DAT)));

    QW_COM_InitArgv(["quake", "-basedir", baseDir]);
    QW_COM_InitFilesystem();
    QW_COM_CheckRegistered();
    QW_Mod_Init();

    QW_PR_LoadProgs();
    QW_PR_AllocEdicts(MAX_EDICTS);
    qwsv.num_edicts = 1;
    qwsv.time = 0;

    SZ_Alloc(qwsv.datagram, 1024);
    SZ_Alloc(qwsv.reliable_datagram, 1024);
    SZ_Alloc(qwsv.signon, 8192);
    SZ_Alloc(qwsv.multicast, 1024);

    const mod = QW_Mod_ForName("maps/world.bsp", true);
    if (mod === null) throw new Error("expected maps/world.bsp to load");
    qwsv.worldmodel = mod;
    qwsv.models[1] = mod;
    qwsv.model_precache[0] = "";
    qwsv.model_precache[1] = "maps/world.bsp";

    const world = QW_EDICT_NUM(0);
    world.v.solid = QW_SOLID_BSP;
    world.v.movetype = QW_MOVETYPE_PUSH;
    world.v.modelindex = 1;

    QW_SV_ClearWorld();
    qwsv.state = QW_ServerStateT.ss_loading;
  });

  function globals(): { f: Float32Array; i: Int32Array } {
    if (qwpr.globals === null) throw new Error("qwpr.globals not set");
    return qwpr.globals;
  }

  test("PR_GetString still resolves an index copied through a Float32Array", () => {
    const s = PR_SetString("progs/player.mdl");
    expect(s).toBeGreaterThanOrEqual(QW_ENGINE_STRING_BASE);

    const g = globals();
    const scratch = g.i.length - 8;
    g.i[scratch] = s;
    floatCopy(g.f, scratch + 4, g.f, scratch, 1);

    expect(g.i[scratch + 4]).toBe(s);
    expect(QW_PR_GetString(g.i[scratch + 4])).toBe("progs/player.mdl");
  });

  test("setmodel resolves a model string_t moved into OFS_PARM1 by a float copy", () => {
    const ed = QW_EDICT_NUM(30);
    QW_ED_ClearEdict(ed);

    const ps = parseState(ENTITY_STRING);
    expect(COM_Parse(ps)).toBe("{");
    QW_ED_ParseEdict(ps, ed);

    expect(QW_PR_GetString(ed.v.model)).toBe("maps/world.bsp");

    const g = globals();
    const temp = g.i.length - 8;
    g.i[temp] = ed.v.model;
    g.i[OFS_PARM0] = QW_EDICT_TO_PROG(ed);
    floatCopy(g.f, OFS_PARM1, g.f, temp, 3);

    expect(g.i[OFS_PARM1]).toBe(ed.v.model);

    qw_pr_builtin[3](); // void(entity e, string m) setmodel = #3

    expect(QW_PR_GetString(ed.v.model)).toBe("maps/world.bsp");
    expect(ed.v.modelindex).toBe(1);
  });

  test("every string field of a spawned edict survives a float copy of the whole entvars block", () => {
    const ed = QW_EDICT_NUM(31);
    QW_ED_ClearEdict(ed);

    const ps = parseState(ENTITY_STRING);
    expect(COM_Parse(ps)).toBe("{");
    QW_ED_ParseEdict(ps, ed);

    const g = globals();
    g.i[OFS_PARM0] = QW_EDICT_TO_PROG(ed);
    g.i[OFS_PARM1] = ed.v.model;
    qw_pr_builtin[3]();

    const copy = QW_EDICT_NUM(32);
    QW_ED_ClearEdict(copy);
    floatCopy(copy.fields.f, 0, ed.fields.f, 0, ed.fields.f.length);

    expect(QW_PR_GetString(copy.v.classname)).toBe("func_door");
    expect(QW_PR_GetString(copy.v.model)).toBe("maps/world.bsp");
    expect(QW_PR_GetString(copy.v.target)).toBe("t16");
    expect(QW_PR_GetString(copy.v.targetname)).toBe("door1");
    expect(QW_PR_GetString(copy.v.netname)).toBe("Player1");
    expect(QW_PR_GetString(copy.v.message)).toBe("You need the silver key");
  });
});
