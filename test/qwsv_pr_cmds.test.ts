/*
Self-sufficient suite for Q012: src/qw/server/pr_cmds.ts (QW/server/pr_cmds.c).
Follows test/qwsv_progs.test.ts's own scratch-basedir recipe (real
../qsrc/quake/QW/progs/qwprogs.dat via QW's own COM_InitArgv/COM_InitFilesystem/
COM_CheckRegistered, src/qw/server/model.ts's Mod_Init) plus test/
qwsv_world.test.ts's synthetic-map recipe (test/support/bsp_builder's
buildBsp) so PF_traceline/PF_setmodel/PF_multicast have a real world to
clip/checksum against, and test/pr_cmds.test.ts's (WinQuake) style of driving
builtins directly by writing parms into qwpr.globals and calling
`pr_builtin[N]()` -- no QuakeC bytecode runs except in the one "real progs"
test at the bottom.

Per standing order 13 and rule 15: this file resets com_searchpaths/
com_modified (a process-wide singleton shared with every other suite) before
and after its own fixture, and builds its own scratch basedir, pak, and
gfx/pop.lmp rather than relying on another test file's run.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sysState } from "../src/platform/sys";
import { setComSearchpaths, setComModified } from "../src/common/common";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, writeGameFile } from "./support/bsp_builder";
import { Mod_Init, Mod_ForName } from "../src/qw/server/model";
import { Com_sprintf } from "../src/common/sprintf";
import { CvarT, Cvar_RegisterVariable, Cvar_VariableValue } from "../src/common/cvar";
import { SZ_Alloc } from "../src/common/sizebuf";
import { MAX_EDICTS } from "../src/qw/bothdefs";
import { MAX_CLIENTS, SvcOpsT } from "../src/qw/protocol";
import { OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3, OFS_RETURN } from "../src/progs/pr_comp";
import { EDICT_NUM, EDICT_TO_PROG, PR_GetString, PR_SetString, QwEdictT, qwpr } from "../src/qw/server/progs";
import { ED_FindField, ED_FindFunction, PR_AllocEdicts, PR_LoadProgs } from "../src/qw/server/pr_edict";
import { PRRunError, PR_ExecuteProgram, prExec } from "../src/qw/server/pr_exec";
import { ClientStateT, ServerStateT, SOLID_BBOX, SOLID_BSP, MOVETYPE_PUSH, sv, svs } from "../src/qw/server/server";
import { SV_ClearWorld } from "../src/qw/server/world";
import { SV_CalcPHS } from "../src/qw/server/sv_init";
import { MSG_BROADCAST, MSG_ONE, pr_builtin, pr_numbuiltins, sv_aim } from "../src/qw/server/pr_cmds";
import { svErrorState } from "../src/qw/server/sv_main";
import { HAVE_QWPROGS } from "./support/fixture_availability";

const QWPROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/QW/progs/qwprogs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-pr-cmds-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  sysState.nostdout = 1; // keep Con_Printf/Sys_Printf diagnostics quiet

  // No throw: a missing QW/progs/qwprogs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_QWPROGS), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_QWPROGS) return;

  setComSearchpaths(null);
  setComModified(false);

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  mkdirSync(join(baseDir, "qw"), { recursive: true });
  const qwprogsData = new Uint8Array(readFileSync(QWPROGS_DAT));
  writeFileSync(join(baseDir, "qw", "qwprogs.dat"), qwprogsData);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  PR_LoadProgs();
  PR_AllocEdicts(MAX_EDICTS);
  sv.num_edicts = 1;
  sv.time = 0;

  SZ_Alloc(sv.datagram, 1024);
  SZ_Alloc(sv.reliable_datagram, 1024);
  SZ_Alloc(sv.signon, 8192);
  SZ_Alloc(sv.multicast, 1024);
  SZ_Alloc(svs.log[0], 1024);
  SZ_Alloc(svs.log[1], 1024);

  const mod = Mod_ForName("maps/world.bsp", true);
  if (mod === null) throw new Error("expected maps/world.bsp to load");
  sv.worldmodel = mod;

  const world = EDICT_NUM(0);
  world.v.solid = SOLID_BSP;
  world.v.movetype = MOVETYPE_PUSH;
  world.v.modelindex = 1;

  SV_ClearWorld();
  SV_CalcPHS();

  sv.state = ServerStateT.ss_loading;

  // one fake spawned client (svs.clients is pre-filled to MAX_CLIENTS, see
  // server.ts's own file header), for PF_sprint/PF_centerprint/PF_stuffcmd/
  // PF_bprint/PF_infokey/PF_logfrag/PF_multicast/WriteDest MSG_ONE
  const client = svs.clients[0];
  client.state = ClientStateT.cs_spawned;
  client.name = "Player1";
  client.userinfo = "\\name\\Player1\\";
  client.edict = EDICT_NUM(1);
  SZ_Alloc(client.netchan.message, 1024);
});

//============================================================================
// parm/return helpers, matching test/pr_cmds.test.ts's (WinQuake) own habit
// of reaching through the VM's raw globals for builtin-level tests.

function requireGlobals(): { f: Float32Array; i: Int32Array } {
  if (qwpr.globals === null) throw new Error("qwpr.globals not set (PR_LoadProgs not called)");
  return qwpr.globals;
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
  requireGlobals().i[ofs] = PR_SetString(s);
}

function setParmEdict(ofs: number, ed: QwEdictT): void {
  requireGlobals().i[ofs] = EDICT_TO_PROG(ed);
}

function returnFloat(): number {
  return requireGlobals().f[OFS_RETURN];
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
// itself, matching test/pr_cmds.test.ts's own spawnEdict() helper.
function spawnEdict(): QwEdictT {
  pr_builtin[14]();
  return EDICT_NUM(returnEdictNum());
}

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("pr_builtin table", () => {
  test("table length is 83 (WinQuake's 79 + PF_logfrag/PF_infokey/PF_stof/PF_multicast)", () => {
    expect(pr_builtin.length).toBe(83);
    expect(pr_numbuiltins).toBe(83);
  });

  test("PF_Fixme (slot 0) throws 'unimplemented bulitin'", () => {
    expect(() => pr_builtin[0]()).toThrow("unimplemented bulitin");
  });

  test("every #ifdef QUAKE2 / setabssize gap slot is also PF_Fixme, including QW's former #46 PF_particle slot", () => {
    for (const gap of [5, 33, 39, 42, 48, 50, 60, 61, 62, 63, 64, 65, 66, 71]) {
      expect(() => pr_builtin[gap]()).toThrow("unimplemented bulitin");
    }
  });

  test("the four new QW builtins are real functions, not PF_Fixme", () => {
    // #79 PF_logfrag, #80 PF_infokey, #81 PF_stof, #82 PF_multicast
    for (const real of [79, 80, 81, 82]) {
      expect(() => pr_builtin[real]()).not.toThrow("unimplemented bulitin");
    }
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_ftos / PF_vtos (Com_sprintf formatting)", () => {
  test("ftos: whole numbers format as %d, fractional as %5.1f", () => {
    setParmFloat(OFS_PARM0, 5);
    pr_builtin[26]();
    expect(returnString()).toBe(Com_sprintf("%d", 5));

    setParmFloat(OFS_PARM0, 3.14159);
    pr_builtin[26]();
    expect(returnString()).toBe(Com_sprintf("%5.1f", 3.14159));
  });

  test("vtos formats as '%5.1f %5.1f %5.1f'", () => {
    setParmVector(OFS_PARM0, [1, 2, 3]);
    pr_builtin[27]();
    expect(returnString()).toBe(Com_sprintf("'%5.1f %5.1f %5.1f'", 1, 2, 3));
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_Find", () => {
  // D.md Defect B: QW/server/pr_cmds.c's PF_Find is identical to WinQuake's
  // here -- G_STRING/E_STRING are (pr_strings + offset), never a NULL
  // pointer, so the C's `if (!s)`/`if (!t)` checks are dead code and an
  // unset (empty) field is searched/matched like any other value. Same
  // repro as test/pr_cmds.test.ts's identical case: func_train_find's
  // `find(world, targetname, self.target)` in plats.qc with `self.target`
  // unset.
  test("an empty search string does not throw, and matches an edict whose field is also empty", () => {
    const targetOfs = ED_FindField("target")?.ofs;
    if (targetOfs === undefined) throw new Error("target field not found");

    // ED_Alloc (matching the C's own `for (i=MAX_CLIENTS+1; i<sv.num_edicts;
    // i++)` scan) hands back the same scratch edict on every call while
    // sv.num_edicts sits below MAX_CLIENTS+1, which this fixture's
    // beforeAll leaves it at (1) -- so spawnEdict() cannot produce several
    // distinct edicts here. Reach for fresh, never-yet-touched indices
    // directly instead (every edict up to MAX_EDICTS is pre-allocated by
    // PR_AllocEdicts in beforeAll, free=false and all fields zero by
    // construction) and bump sv.num_edicts to cover them, restored after.
    const savedNumEdicts = sv.num_edicts;
    try {
      const base = Math.max(sv.num_edicts, MAX_CLIENTS + 2);
      const start = EDICT_NUM(base);
      const emptyTarget = EDICT_NUM(base + 1); // .target left at its default (0 -> "")
      const nonEmptyTarget = EDICT_NUM(base + 2);
      nonEmptyTarget.v.target = PR_SetString("qwsv_pr_cmds_test_target");
      sv.num_edicts = base + 3;

      setParmEdict(OFS_PARM0, start);
      setParmInt(OFS_PARM1, targetOfs);
      setParmString(OFS_PARM2, ""); // the empty search string itself
      expect(() => pr_builtin[18]()).not.toThrow();

      expect(returnEdictNum()).toBe(EDICT_TO_PROG(emptyTarget));
    } finally {
      sv.num_edicts = savedNumEdicts;
    }
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_infokey", () => {
  test("entity 0: svs.info, falling back to localinfo", () => {
    svs.info = "\\hostname\\Test Server\\";

    setParmEdict(OFS_PARM0, EDICT_NUM(0));
    setParmString(OFS_PARM1, "hostname");
    pr_builtin[80]();
    expect(returnString()).toBe("Test Server");

    setParmEdict(OFS_PARM0, EDICT_NUM(0));
    setParmString(OFS_PARM1, "no_such_serverinfo_key");
    pr_builtin[80]();
    expect(returnString()).toBe("");
  });

  test("a client entity: userinfo lookup", () => {
    setParmEdict(OFS_PARM0, EDICT_NUM(1));
    setParmString(OFS_PARM1, "name");
    pr_builtin[80]();
    expect(returnString()).toBe("Player1");
  });

  test("entity beyond MAX_CLIENTS returns empty string", () => {
    setParmEdict(OFS_PARM0, EDICT_NUM(MAX_CLIENTS + 5));
    setParmString(OFS_PARM1, "name");
    pr_builtin[80]();
    expect(returnString()).toBe("");
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_logfrag", () => {
  test("appends '\\\\killer\\\\killee\\\\\\n' to svs.log[svs.logsequence & 1]", () => {
    svs.clients[0].name = "Alice";
    svs.clients[1].name = "Bob";

    const buf = svs.log[svs.logsequence & 1];
    const startCursize = buf.cursize;

    setParmEdict(OFS_PARM0, EDICT_NUM(1));
    setParmEdict(OFS_PARM1, EDICT_NUM(2));
    pr_builtin[79]();

    expect(readCString(buf.data, startCursize)).toBe("\\Alice\\Bob\\\n");
  });

  test("out-of-range client numbers are a silent no-op", () => {
    const buf = svs.log[svs.logsequence & 1];
    const startCursize = buf.cursize;

    setParmEdict(OFS_PARM0, EDICT_NUM(0)); // world, not a client
    setParmEdict(OFS_PARM1, EDICT_NUM(1));
    pr_builtin[79]();

    expect(buf.cursize).toBe(startCursize);
  });
});

describe.skipIf(!HAVE_QWPROGS)("WriteDest MSG_ONE (PF_WriteByte through the reliable back-buffer)", () => {
  test("a byte written with dest MSG_ONE lands in msg_entity's netchan.message, not sv.datagram", () => {
    const client = svs.clients[0];
    const startCursize = client.netchan.message.cursize;
    const datagramStart = sv.datagram.cursize;

    const gs = qwpr.global_struct;
    if (gs === null) throw new Error("global_struct not set");
    gs.msg_entity = EDICT_TO_PROG(EDICT_NUM(1));

    setParmFloat(OFS_PARM0, MSG_ONE);
    setParmFloat(OFS_PARM1, 200);
    pr_builtin[52](); // PF_WriteByte

    expect(client.netchan.message.data[startCursize]).toBe(200);
    expect(sv.datagram.cursize).toBe(datagramStart); // untouched
  });

  test("MSG_BROADCAST still lands in sv.datagram", () => {
    const startCursize = sv.datagram.cursize;

    setParmFloat(OFS_PARM0, MSG_BROADCAST);
    setParmFloat(OFS_PARM1, 123);
    pr_builtin[52](); // PF_WriteByte

    expect(sv.datagram.data[startCursize]).toBe(123);
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_bprint / PF_multicast (sv_send.ts)", () => {
  test("PF_bprint writes svc_print + level + the string into every spawned client's netchan.message", () => {
    const client = svs.clients[0];
    const startCursize = client.netchan.message.cursize;

    prExec.argc = 2; // bprint(level, value): one extra PF_VarString parm
    setParmFloat(OFS_PARM0, 1); // PRINT_HIGH-ish level; PF_bprint doesn't validate it
    setParmString(OFS_PARM1, "hello");
    pr_builtin[23](); // PF_bprint

    expect(client.netchan.message.data[startCursize]).toBe(SvcOpsT.svc_print);
    expect(client.netchan.message.data[startCursize + 1]).toBe(1);
    expect(readCString(client.netchan.message.data, startCursize + 2)).toBe("hello");
  });

  test("PF_multicast (MULTICAST_ALL) runs to completion and clears sv.multicast", () => {
    setParmVector(OFS_PARM0, [0, 0, 0]);
    setParmFloat(OFS_PARM1, 0); // MulticastT.MULTICAST_ALL
    expect(() => pr_builtin[82]()).not.toThrow();
    expect(sv.multicast.cursize).toBe(0);
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_precache_model error outside ss_loading", () => {
  test("throws PRRunError when sv.state is not ss_loading", () => {
    const saved = sv.state;
    try {
      sv.state = ServerStateT.ss_active;
      setParmString(OFS_PARM0, "models/never_precached.mdl");
      // SV_Error's real implementation (sv_main.ts) now runs for real; its
      // `static qboolean inerror` reentrancy guard is a process-wide
      // singleton another test file may have left tripped (rule 15), so
      // clear it before provoking SV_Error here rather than assume it is
      // fresh.
      svErrorState.inerror = false;
      expect(() => pr_builtin[20]()).toThrow(PRRunError);
    } finally {
      sv.state = saved;
    }
  });

  test("succeeds during ss_loading and records the string in sv.model_precache", () => {
    sv.state = ServerStateT.ss_loading;
    setParmString(OFS_PARM0, "models/qwsv_pr_cmds_test.mdl");
    expect(() => pr_builtin[20]()).not.toThrow();
    expect(sv.model_precache.includes("models/qwsv_pr_cmds_test.mdl")).toBe(true);
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_setorigin / PF_setsize (world.ts linking)", () => {
  test("PF_setsize then PF_setorigin link the edict into the world (area list becomes non-null)", () => {
    const ed = spawnEdict();
    ed.v.solid = SOLID_BBOX;

    setParmEdict(OFS_PARM0, ed);
    setParmVector(OFS_PARM1, [-16, -16, -24]);
    setParmVector(OFS_PARM2, [16, 16, 32]);
    pr_builtin[4](); // PF_setsize

    expect(Array.from(ed.v.mins)).toEqual([-16, -16, -24]);
    expect(Array.from(ed.v.maxs)).toEqual([16, 16, 32]);
    expect(Array.from(ed.v.size)).toEqual([32, 32, 56]);

    setParmEdict(OFS_PARM0, ed);
    setParmVector(OFS_PARM1, [5, 5, 5]);
    pr_builtin[2](); // PF_setorigin

    expect(ed.v.origin[0]).toBe(5);
    expect(ed.area.prev).not.toBeNull();
  });
});

describe.skipIf(!HAVE_QWPROGS)("sv_aim", () => {
  // Checked via `.string` (set unconditionally by CvarT's constructor), not
  // `.value` (only populated by a successful Cvar_RegisterVariable call):
  // src/progs/pr_cmds.ts (WinQuake) registers its own, separate CvarT also
  // named "sv_aim" against the same process-wide cvar registry (src/common/
  // cvar.ts's `cvar_vars`, shared across every test file bun loads into one
  // process); Cvar_RegisterVariable is idempotent by name (see this file's
  // own header), so whichever module's sv_aim registers first "wins" the
  // registry slot and the other's `.value` stays its constructor default (0)
  // -- a real, pre-existing, already-documented cross-track collision (also
  // observable for `teamplay`/`developer`/etc.), not a defect in this port.
  test("QW's real default is \"2\", not WinQuake's \"0.93\"", () => {
    expect(sv_aim.string).toBe("2");
  });
});

describe.skipIf(!HAVE_QWPROGS)("PF_cvar / PF_cvar_set (unchanged from WinQuake)", () => {
  test("roundtrips a registered cvar's value", () => {
    const testCvar = new CvarT("qwsv_pr_cmds_test_cvar", "1");
    Cvar_RegisterVariable(testCvar);

    setParmString(OFS_PARM0, "qwsv_pr_cmds_test_cvar");
    pr_builtin[45](); // PF_cvar
    expect(returnFloat()).toBe(1);

    setParmString(OFS_PARM0, "qwsv_pr_cmds_test_cvar");
    setParmString(OFS_PARM1, "42");
    pr_builtin[72](); // PF_cvar_set
    expect(Cvar_VariableValue("qwsv_pr_cmds_test_cvar")).toBe(42);
  });
});

describe.skipIf(!HAVE_QWPROGS)("PR_ExecuteProgram with the real pr_cmds.ts builtin table installed", () => {
  test("runs the retail qwprogs.dat's main() to completion", () => {
    sv.num_edicts = 1;
    sv.time = 0;

    const mainFn = ED_FindFunction("main");
    expect(mainFn).not.toBeNull();
    if (mainFn === null) return;
    const idx = qwpr.functions.indexOf(mainFn);

    const depthBefore = prExec.depth;
    expect(() => PR_ExecuteProgram(idx)).not.toThrow();
    expect(prExec.depth).toBe(depthBefore);
  });
});
