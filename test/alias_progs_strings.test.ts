// Regression suite for the engine-string aliasing bugs found by the pointer-
// semantics audit (.orch/audit_aliasing.md, pattern A).
//
// The C hands progs a `char *` into an engine buffer it keeps rewriting, so a
// later write to that buffer is what QuakeC reads back. A JS string is a value,
// so the port has to store a live getter (PR_SetEngineStringRef / PR_SetStringRef)
// wherever the C's pointer aimed at mutable storage.
//
// Self-sufficient per rule 13: builds its own scratch basedir with a synthetic
// id1/pak0.pak (gfx/pop.lmp so COM_CheckRegistered passes, plus the real
// progs106/progs.dat) and loads progs itself, following test/pr_cmds.test.ts's
// recipe. Resets every shared singleton it touches (svState, svs, sv buffers,
// cmdState) in its own beforeAll/afterAll.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { CmdSourceT, cmdState, Cmd_TokenizeString } from "../src/common/cmd";
import { SZ_Alloc } from "../src/common/sizebuf";
import { Host_Name_f } from "../src/common/host_cmd";
import { PR_AllocEdicts, PR_LoadProgs } from "../src/progs/pr_edict";
import {
  EDICT_NUM,
  PR_ClearEngineStrings,
  PR_GetString,
  PR_SetEngineString,
  PR_SetEngineStringRef,
} from "../src/progs/progs";
import { OFS_PARM0, OFS_RETURN } from "../src/progs/pr_comp";
import { pr } from "../src/progs/progs";
import { pr_builtin } from "../src/progs/pr_cmds";
import { ClientT, sv, svs, svState } from "../src/server/server";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "alias-strings-test-"));
const baseDir = join(scratchDir, "quake");

// Set inside beforeAll below, right before this suite starts mutating
// cmdState.source itself -- capturing it any earlier (e.g. at module load,
// before other suites in this shared bun test process have run their own
// tests) would restore the wrong value in afterAll.
let savedSource = CmdSourceT.src_command;

// pr.globals is `| null` until PR_LoadProgs runs; narrow once per use site.
function globals(): { f: Float32Array; i: Int32Array } {
  const g = pr.globals;
  if (g === null) throw new Error("PR_LoadProgs has not run");
  return g;
}

beforeAll(() => {
  // No throw: a missing progs106/progs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_PROGS106), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_PROGS106) return;
  const progsDat = new Uint8Array(readFileSync(PROGS_DAT));

  mkdirSync(join(baseDir, "id1"), { recursive: true });
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

  PR_LoadProgs();
  PR_AllocEdicts(64);
  sv.num_edicts = 2;
  sv.time = 0;

  SZ_Alloc(sv.reliable_datagram, 1024);

  savedSource = cmdState.source;
});

afterAll(() => {
  // beforeAll only assigns savedSource (and only mutates cmdState.source at
  // all, through the tests below) when HAVE_PROGS106 -- nothing to restore
  // otherwise.
  if (HAVE_PROGS106) cmdState.source = savedSource;
  svState.host_client = null;
  svState.sv_player = null;
  svs.clients = [];
  svs.maxclients = 0;
  rmSync(scratchDir, { recursive: true, force: true });
});

// host_cmd.c:939 -- `host_client->edict->v.netname = host_client->name - pr_strings;`
// stores a pointer straight into client_t's own `char name[32]`. The two later
// writers to that buffer, sv_main.c:268's `strcpy (client->name, "unconnected")`
// in SV_ConnectClient and host.c:377's `host_client->name[0] = 0;` in
// SV_DropClient, deliberately do NOT re-assign v.netname -- in C they don't have
// to. The port copied the string value once, so QuakeC kept reading the old name
// after a drop or a reconnect.
describe.skipIf(!HAVE_PROGS106)("alias_ WinQuake netname follows later writes to host_client.name", () => {
  function makeClient(): ClientT {
    const client = new ClientT();
    client.active = true;
    client.spawned = true;
    client.name = "";
    client.edict = EDICT_NUM(1);
    SZ_Alloc(client.message, 1024);
    svs.maxclients = 1;
    svs.clients = [client];
    svState.host_client = client;
    return client;
  }

  test("Host_Name_f installs a netname that tracks the client's name buffer", () => {
    const client = makeClient();
    cmdState.source = CmdSourceT.src_client;

    Cmd_TokenizeString("name Ranger");
    Host_Name_f();

    const netname = client.edict === null ? -1 : client.edict.v.netname;
    expect(PR_GetString(netname)).toBe("Ranger");

    // host.c:377 -- SV_DropClient clears the buffer and leaves netname alone.
    // The body stays in the world, so QuakeC (ClientObituary's bprint of
    // targ.netname when the abandoned body is telefragged) reads "" in the C.
    client.name = "";
    expect(PR_GetString(netname)).toBe("");

    // sv_main.c:268 -- SV_ConnectClient reuses the slot and writes
    // "unconnected" into the same buffer, again without touching netname.
    client.name = "unconnected";
    expect(PR_GetString(netname)).toBe("unconnected");
  });

  test("a rename reuses the same string_t, as the C's stable pointer does", () => {
    const client = makeClient();
    cmdState.source = CmdSourceT.src_client;

    Cmd_TokenizeString("name Ranger");
    Host_Name_f();
    const first = client.edict === null ? -1 : client.edict.v.netname;

    Cmd_TokenizeString("name Shambler");
    Host_Name_f();
    const second = client.edict === null ? -1 : client.edict.v.netname;

    expect(second).toBe(first);
    expect(PR_GetString(second)).toBe("Shambler");
  });

  test("two clients get distinct netname string_ts", () => {
    const a = new ClientT();
    const b = new ClientT();
    a.active = b.active = true;
    a.edict = EDICT_NUM(1);
    b.edict = EDICT_NUM(2);
    SZ_Alloc(a.message, 1024);
    SZ_Alloc(b.message, 1024);
    svs.maxclients = 2;
    svs.clients = [a, b];
    cmdState.source = CmdSourceT.src_client;

    svState.host_client = a;
    Cmd_TokenizeString("name Alpha");
    Host_Name_f();
    svState.host_client = b;
    Cmd_TokenizeString("name Beta");
    Host_Name_f();

    const na = a.edict === null ? -1 : a.edict.v.netname;
    const nb = b.edict === null ? -1 : b.edict.v.netname;
    expect(na).not.toBe(nb);

    a.name = "";
    expect(PR_GetString(na)).toBe("");
    expect(PR_GetString(nb)).toBe("Beta");
  });
});

// pr_cmds.c:923 -- `char pr_string_temp[128];` is ONE buffer shared by PF_ftos
// and PF_vtos, handed to progs as the fixed offset `pr_string_temp - pr_strings`
// (pr_cmds.c:934, :947). Two results held at once therefore both read whatever
// the later call wrote. Minting a fresh engine string per call also grew the
// table without bound.
describe.skipIf(!HAVE_PROGS106)("alias_ PF_ftos and PF_vtos share one pr_string_temp buffer", () => {
  test("consecutive ftos results are the same string_t and read the later value", () => {
    globals().f[OFS_PARM0] = 5;
    pr_builtin[26]();
    const first = globals().i[OFS_RETURN];
    expect(PR_GetString(first)).toBe("5");

    globals().f[OFS_PARM0] = 7;
    pr_builtin[26]();
    const second = globals().i[OFS_RETURN];

    expect(second).toBe(first);
    expect(PR_GetString(first)).toBe("7");
  });

  test("vtos writes the same buffer ftos does", () => {
    globals().f[OFS_PARM0] = 5;
    pr_builtin[26]();
    const fromFtos = globals().i[OFS_RETURN];

    globals().f[OFS_PARM0] = 1;
    globals().f[OFS_PARM0 + 1] = 2;
    globals().f[OFS_PARM0 + 2] = 3;
    pr_builtin[27]();
    const fromVtos = globals().i[OFS_RETURN];

    expect(fromVtos).toBe(fromFtos);
    expect(PR_GetString(fromFtos)).toBe("'  1.0   2.0   3.0'");
  });

  test("repeated ftos calls do not grow the engine string table", () => {
    globals().f[OFS_PARM0] = 0;
    pr_builtin[26]();
    const slot = globals().i[OFS_RETURN];
    for (let i = 0; i < 4096; i++) {
      globals().f[OFS_PARM0] = i;
      pr_builtin[26]();
      expect(globals().i[OFS_RETURN]).toBe(slot);
    }
  });
});

describe.skipIf(!HAVE_PROGS106)("alias_ PR_SetEngineStringRef vs PR_SetEngineString", () => {
  test("a value string is frozen, a ref string tracks its owner", () => {
    const owner = { name: "before" };
    const byValue = PR_SetEngineString(owner.name);
    const byRef = PR_SetEngineStringRef(owner, () => owner.name);

    owner.name = "after";

    expect(PR_GetString(byValue)).toBe("before");
    expect(PR_GetString(byRef)).toBe("after");
  });

  test("the ref table is keyed on the owner, not the current text", () => {
    const owner = { name: "x" };
    const first = PR_SetEngineStringRef(owner, () => owner.name);
    owner.name = "y";
    const second = PR_SetEngineStringRef(owner, () => owner.name);
    expect(second).toBe(first);
  });

  test("PR_ClearEngineStrings drops refs as well as values", () => {
    const owner = { name: "gone" };
    PR_SetEngineStringRef(owner, () => owner.name);
    PR_ClearEngineStrings();
    // The table is empty again, so the next handout takes index 0.
    const fresh = PR_SetEngineString("fresh");
    expect(PR_GetString(fresh)).toBe("fresh");
    // Reload so the suites that follow still have a usable progs image.
    PR_LoadProgs();
    PR_AllocEdicts(64);
  });
});
