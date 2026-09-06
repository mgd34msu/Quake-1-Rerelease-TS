// Covers, in one process:
// - the compat spawn table mechanism pr_edict_core.ts's ED_LoadFromFile /
//   ED_ParseEdict grew (registerSpawnCompat, SpawnResolutionT's three kinds,
//   knownKeys) against a synthetic table, so the mechanism itself is tested
//   independently of src/server/compat_spawn.ts's actual NetQuake table;
// - a guarded real-data exhaustiveness check of that actual table against
//   the 2021 re-release's own retail maps (test/support/ent_lumps.ts against
//   /home/buzzkill/Projects/qfiles/q1/rerelease/*/pak0.pak): every classname
//   any re-release gamedir's maps use must either be a function some classic
//   progs (progs106/hipnotic/rogue) defines, or have a compat_spawn.ts table
//   entry. Since no compiled hipnotic/rogue progs.dat exists in this
//   environment (only their QuakeC source, alongside progs106 under the same
//   ../qsrc/quake checkout HAVE_PROGS106 already requires), "a classic progs
//   defines it" is answered by scanning that QuakeC source the same way
//   src/server/compat_spawn.ts's own file header says the table was built,
//   rather than loading a second compiled fixture ED_FindFunction could
//   query directly the way the synthetic-table tests below do against the
//   real progs106/progs.dat fixture.
//
// Self-sufficient per rule 13: its own scratch basedir and filesystem init,
// sysState.nostdout and the pr_edict_core.ts compat registry ("nq" key)
// restored in afterAll. The synthetic-table describe block also restores
// the real src/server/compat_spawn.ts table it temporarily replaces, so the
// exhaustiveness describe block (and any later test file in the same
// process) sees the real table again.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop, type ParseState } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { sysState } from "../src/platform/sys";
import { EDICT_NUM, PR_GetString, pr } from "../src/progs/progs";
import { sv, svs } from "../src/server/server";
import { ED_ClearEdict, ED_LoadFromFile, PR_AllocEdicts, PR_LoadProgs } from "../src/progs/pr_edict";
import { clearSpawnCompat, registerSpawnCompat, type SpawnCompatT, type SpawnResolutionT } from "../src/progs/pr_edict_core";
import type { EdictBaseT } from "../src/progs/progs_core";
import * as consoleMod from "../src/client/console";
import { HAVE_PROGS106, PROGS106_DAT, QSRC_DIR } from "./support/fixture_availability";
import { PakFile } from "./support/pak_reader";
import { classnamesInPak } from "./support/ent_lumps";
import { DOCUMENTED_VANILLA_QUIRKS, nqSpawnCompat } from "../src/server/compat_spawn";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "compat-spawn-test-"));
const baseDir = join(scratchDir, "quake");

const savedNostdout = sysState.nostdout;

afterAll(() => {
  sysState.nostdout = savedNostdout;
  clearSpawnCompat("nq");
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  // Con_Printf/Con_DPrintf write through Sys_Printf; keep the suite quiet.
  sysState.nostdout = 1;

  // No throw: a missing progs106/progs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_PROGS106), so this beforeAll simply has
  // nothing to set up for tests that never run.
  if (!HAVE_PROGS106) return;
  const progsDat = new Uint8Array(readFileSync(PROGS106_DAT));

  // gfx/pop.lmp inside id1/pak0.pak: the registered-version check's 128
  // big-endian shorts, same recipe as test/pr_edict.test.ts.
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

function parseState(data: string): ParseState {
  return { data, index: 0 };
}

function resetEdicts(count: number): void {
  svs.maxclients = 0;
  sv.num_edicts = 1;
  sv.time = 5;
  for (let i = 0; i < count; i++) {
    ED_ClearEdict(EDICT_NUM(i));
    EDICT_NUM(i).freetime = 0;
  }
}

//============================================================================

describe.skipIf(!HAVE_PROGS106)("registerSpawnCompat mechanism (synthetic table, real progs106 fixture)", () => {
  const syntheticTable = new Map<string, SpawnResolutionT>([
    [
      "compat_test_rename",
      {
        kind: "rename",
        classname: "info_player_start",
        rewrite: (ent: EdictBaseT) => {
          ent.v.health = 42;
        },
      },
    ],
    ["compat_test_inhibit", { kind: "inhibit" }],
  ]);
  const syntheticCompat: SpawnCompatT = {
    resolveClassname(classname: string): SpawnResolutionT {
      return syntheticTable.get(classname) ?? { kind: "none" };
    },
    knownKeys: new Set<string>(["compat_test_known_key"]),
  };

  beforeAll(() => {
    registerSpawnCompat("nq", syntheticCompat);
  });

  afterAll(() => {
    // restore the real table src/server/compat_spawn.ts registered on
    // import, for the exhaustiveness describe block below and for any
    // later test file sharing this process.
    registerSpawnCompat("nq", nqSpawnCompat);
  });

  test("a classname with a spawn function never consults the compat table", () => {
    resetEdicts(8);
    ED_LoadFromFile(parseState('{\n"classname" "info_player_start"\n"origin" "0 0 0"\n}\n'));
    expect(EDICT_NUM(0).free).toBe(false);
    expect(PR_GetString(EDICT_NUM(0).v.classname)).toBe("info_player_start");
  });

  test("an unknown classname with a rename entry spawns as the target with rewritten fields", () => {
    resetEdicts(8);
    ED_LoadFromFile(parseState('{\n"classname" "compat_test_rename"\n"origin" "1 2 3"\n}\n'));
    const world = EDICT_NUM(0);
    expect(world.free).toBe(false);
    expect(PR_GetString(world.v.classname)).toBe("info_player_start");
    expect(world.v.health).toBe(42);
  });

  test("an inhibited classname is freed with a compat dprint, not the classic warning", () => {
    resetEdicts(8);
    const printSpy = spyOn(consoleMod, "Con_Printf");
    const dprintSpy = spyOn(consoleMod, "Con_DPrintf");
    ED_LoadFromFile(parseState('{\n"classname" "compat_test_inhibit"\n}\n'));
    expect(EDICT_NUM(0).free).toBe(true);
    expect(printSpy).not.toHaveBeenCalledWith("No spawn function for:\n");
    expect(dprintSpy).toHaveBeenCalledWith("compat: inhibiting %s\n", "compat_test_inhibit");
    printSpy.mockRestore();
    dprintSpy.mockRestore();
  });

  test("an unknown classname with no table entry keeps the classic warning and free", () => {
    resetEdicts(8);
    const printSpy = spyOn(consoleMod, "Con_Printf");
    ED_LoadFromFile(parseState('{\n"classname" "compat_test_totally_unknown"\n}\n'));
    expect(EDICT_NUM(0).free).toBe(true);
    expect(printSpy).toHaveBeenCalledWith("No spawn function for:\n");
    printSpy.mockRestore();
  });

  test("knownKeys and leading-underscore keys are silent; a random unknown key still warns", () => {
    resetEdicts(8);
    const printSpy = spyOn(consoleMod, "Con_Printf");
    ED_LoadFromFile(
      parseState(
        '{\n"classname" "info_player_start"\n"compat_test_known_key" "1"\n"_tb_anything" "x"\n"totally_random_unknown_key" "1"\n}\n',
      ),
    );
    const messages = printSpy.mock.calls.map((call) => call.join("|"));
    expect(messages.some((m) => m.includes("compat_test_known_key"))).toBe(false);
    expect(messages.some((m) => m.includes("_tb_anything"))).toBe(false);
    expect(messages.some((m) => m.includes("totally_random_unknown_key"))).toBe(true);
    printSpy.mockRestore();
  });
});

//============================================================================
// Guarded real-data exhaustiveness gate.

const RERELEASE_DIR = process.env.Q1TS_RERELEASE ?? "/home/buzzkill/Projects/qfiles/q1/rerelease";
const GAMEDIRS = ["id1", "hipnotic", "rogue", "mg1", "mg3", "ctf", "dopa"] as const;
const HAVE_RERELEASE_MAPS = GAMEDIRS.every((gamedir) => existsSync(join(RERELEASE_DIR, gamedir, "pak0.pak")));

const MP1_DIR = join(QSRC_DIR, "Mission Packs", "quake-mp1");
const MP2_DIR = join(QSRC_DIR, "Mission Packs", "quake-mp2");
const PROGS106_DIR = join(QSRC_DIR, "progs106");
const HAVE_CLASSIC_SOURCE = existsSync(MP1_DIR) && existsSync(MP2_DIR) && existsSync(PROGS106_DIR);

// Every function name progs106/hipnotic(mp1)/rogue(mp2) QuakeC defines, the
// same "returntype(params) name = ..." shape src/server/compat_spawn.ts's
// own file header describes building the table from -- every compiled
// function, not just ones that look like spawn functions, because
// ED_FindFunction (pr_edict_core.ts) matches by name against all of them.
function classicFunctionNames(dirs: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  const pattern = /^\S+\s*\([^)]*\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/gm;
  for (const dir of dirs) {
    for (const file of readdirSync(dir)) {
      if (!/\.qc$/i.test(file)) continue;
      const text = readFileSync(join(dir, file), "utf8");
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return names;
}

describe.skipIf(!HAVE_PROGS106 || !HAVE_RERELEASE_MAPS || !HAVE_CLASSIC_SOURCE)(
  "compat_spawn table exhaustiveness (real re-release retail data)",
  () => {
    test("every classname the retail maps use is covered per gamedir", () => {
      const classicNames = classicFunctionNames([PROGS106_DIR, MP1_DIR, MP2_DIR]);
      const dummyEnt = EDICT_NUM(0); // never inspected by resolveClassname; just satisfies the parameter type
      const uncoveredByGamedir: string[] = [];

      for (const gamedir of GAMEDIRS) {
        const pak = new PakFile(join(RERELEASE_DIR, gamedir, "pak0.pak"));
        const classnames = classnamesInPak(pak);
        const uncovered = [...classnames]
          .filter((cn) => !classicNames.has(cn))
          .filter((cn) => !DOCUMENTED_VANILLA_QUIRKS.has(cn))
          .filter((cn) => nqSpawnCompat.resolveClassname(cn, dummyEnt, new Map()).kind === "none");
        if (uncovered.length > 0) uncoveredByGamedir.push(`${gamedir}: ${uncovered.sort().join(", ")}`);
      }

      expect(uncoveredByGamedir).toEqual([]);
    });
  },
);
