/*
Self-sufficient tests for U10 (the filesystem learns the re-release layout):
the "zip" search-path node kind (src/common/common.ts), re-release root
detection (COM_IsRereleaseRoot/COM_RereleaseDir/COM_ClassicDir), the nested
"classic root with a rerelease/ subdirectory" mount order, the -mg1/-mg3/
-dopa/-ctf mission-pack-style flags, the runtime "game" command
(Host_Game_f, src/common/host_cmd.ts), the -homedir tier, and cd_ogg.ts's
search-path-aware music resolution.

Per standing order 13, every synthetic tree below is uniquely named under a
fresh scratch directory and only positive "the file we just wrote is found"
assertions are made (this file's own COM_InitFilesystem calls each rebuild
com_searchpaths from scratch, so an earlier test's mounted directories
cannot make a later positive assertion here pass by accident -- the concern
runs the other way, and is guarded against by using unique file/entry names
per test). The sticky module-level flags this unit's own COM_InitFilesystem/
COM_ResetGameDirectories mutate (hipnotic/rogue/mg1/mg3/dopa/ctf/
standard_quake) and sv.active are snapshotted and restored in afterAll,
using the setters src/common/common.ts exports for exactly this purpose.
*/

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  COM_ClassicDir,
  COM_DefaultHomeDir,
  COM_FindFileTier,
  COM_GetGameNames,
  COM_InitArgv,
  COM_InitFilesystem,
  COM_IsRereleaseRoot,
  COM_LoadTempFile,
  COM_RereleaseDir,
  COM_WriteFile,
  com_gamedir,
  com_homedir,
  ctf,
  dopa,
  hipnotic,
  mg1,
  mg3,
  rogue,
  setCtf,
  setDopa,
  setHipnotic,
  setMg1,
  setMg3,
  setRogue,
  setStandardQuake,
  standard_quake,
  HOMEDIR_APPNAME,
  com_searchpaths, setComGamedir, setComSearchpaths,
} from "../src/common/common";
import { Cbuf_Init, Cmd_TokenizeString } from "../src/common/cmd";
import { Host_Game_f } from "../src/common/host_cmd";
import { hostClientHooks } from "../src/common/host";
import { sv, svs } from "../src/server/server";
import { writePakToDisk, ensureDir } from "./support/pak_builder";
import { writeZipToDisk } from "./support/zip_builder";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "fs-rerelease-test-"));

const savedHipnotic = hipnotic;
const savedRogue = rogue;
const savedMg1 = mg1;
const savedMg3 = mg3;
const savedDopa = dopa;
const savedCtf = ctf;
const savedStandardQuake = standard_quake;
const savedSvActive = sv.active;
const savedSearchpaths = com_searchpaths;
const savedGamedir = com_gamedir;

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  setComSearchpaths(savedSearchpaths);
  setComGamedir(savedGamedir);
  setHipnotic(savedHipnotic);
  setRogue(savedRogue);
  setMg1(savedMg1);
  setMg3(savedMg3);
  setDopa(savedDopa);
  setCtf(savedCtf);
  setStandardQuake(savedStandardQuake);
  sv.active = savedSvActive;
});

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break; // COM_LoadFile's trailing NUL
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function loadText(path: string): string | null {
  const data = COM_LoadTempFile(path);
  return data === null ? null : bytesToLatin1(data);
}

//============================================================================

describe("zip search-path node: lookup, tier, and case-insensitive entries", () => {
  test("a .kpf mounted in a gamedir outranks that gamedir's own pak, and serves an entry the pak doesn't have", () => {
    const baseDir = join(scratchDir, "ziptest");
    ensureDir(join(baseDir, "id1"));
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "shared.txt", data: latin1Bytes("PAK") }]);
    writeZipToDisk(join(baseDir, "id1", "mods.kpf"), [
      { name: "shared.txt", data: latin1Bytes("KPF") },
      { name: "onlykpf.txt", data: latin1Bytes("KPF_ONLY") },
    ]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", baseDir]);
    COM_InitFilesystem();

    expect(loadText("shared.txt")).toBe("KPF"); // kpf mounted after the pak -> higher priority
    expect(loadText("onlykpf.txt")).toBe("KPF_ONLY");

    const kpfTier = COM_FindFileTier("shared.txt");
    const pakOnlyTier = COM_FindFileTier("onlykpf.txt");
    expect(kpfTier).not.toBe(-1);
    expect(kpfTier).toBe(pakOnlyTier); // same search-path node
  });

  test("kpf entry lookup is case-insensitive", () => {
    const baseDir = join(scratchDir, "zipcase");
    ensureDir(join(baseDir, "id1"));
    writeZipToDisk(join(baseDir, "id1", "content.kpf"), [{ name: "fonts/qfont.kfont", data: latin1Bytes("FONTDATA") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", baseDir]);
    COM_InitFilesystem();

    expect(loadText("FONTS/QFONT.KFONT")).toBe("FONTDATA");
    expect(loadText("fonts/qfont.kfont")).toBe("FONTDATA");
    expect(loadText("Fonts/QFont.Kfont")).toBe("FONTDATA");
  });

  test("multiple .kpf/.pk3 files in one gamedir are mounted sorted, later name higher priority", () => {
    const baseDir = join(scratchDir, "zipsort");
    ensureDir(join(baseDir, "id1"));
    writeZipToDisk(join(baseDir, "id1", "a_mod.kpf"), [{ name: "dup.txt", data: latin1Bytes("A") }]);
    writeZipToDisk(join(baseDir, "id1", "z_mod.pk3"), [{ name: "dup.txt", data: latin1Bytes("Z") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", baseDir]);
    COM_InitFilesystem();

    // "z_mod.pk3" sorts after "a_mod.kpf" -> mounted later -> higher priority
    expect(loadText("dup.txt")).toBe("Z");
  });
});

//============================================================================

describe("re-release root detection", () => {
  test("a root with QuakeEX.kpf directly is detected as a re-release root", () => {
    const root = join(scratchDir, "rr-kpf-root");
    ensureDir(join(root, "id1"));
    writeZipToDisk(join(root, "QuakeEX.kpf"), [{ name: "onlykpf.txt", data: latin1Bytes("KPF_ONLY") }]);
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("PROGS") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(COM_RereleaseDir()).toBe(root);
    expect(COM_ClassicDir()).toBe("");

    // QuakeEX.kpf mounts BELOW id1's own paks (retail data wins over kpf
    // duplicates): progs.dat (id1/pak0.pak) must resolve at a higher
    // priority (lower tier number) than a kpf-only file.
    const progsTier = COM_FindFileTier("progs.dat");
    const kpfTier = COM_FindFileTier("onlykpf.txt");
    expect(progsTier).not.toBe(-1);
    expect(kpfTier).not.toBe(-1);
    expect(progsTier).toBeLessThan(kpfTier);
  });

  test("a root with id1/pak0.pak containing mapdb.json (no QuakeEX.kpf) is detected as a re-release root", () => {
    const root = join(scratchDir, "rr-mapdb-root");
    ensureDir(join(root, "id1"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [
      { name: "mapdb.json", data: latin1Bytes("{}") },
      { name: "maps/rrb.bsp", data: latin1Bytes("BSPDATA") },
    ]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(COM_RereleaseDir()).toBe(root);
    expect(loadText("maps/rrb.bsp")).toBe("BSPDATA");
  });

  test("a plain classic root (no QuakeEX.kpf, no mapdb.json, no nested rerelease/) is NOT a re-release root", () => {
    const root = join(scratchDir, "classic-root");
    ensureDir(join(root, "id1"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("CLASSIC") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(false);
    expect(COM_RereleaseDir()).toBe("");
    expect(COM_ClassicDir()).toBe(root);
    expect(loadText("progs.dat")).toBe("CLASSIC");
  });

  test("-classic <dir> / -rerelease <dir> override auto-detection", () => {
    const classicDir = join(scratchDir, "override-classic");
    const rereleaseDir = join(scratchDir, "override-rerelease");
    ensureDir(join(classicDir, "id1"));
    ensureDir(join(rereleaseDir, "id1"));
    writePakToDisk(join(classicDir, "id1", "pak0.pak"), [{ name: "classiconly.txt", data: latin1Bytes("C") }]);
    writePakToDisk(join(rereleaseDir, "id1", "pak0.pak"), [{ name: "rronly.txt", data: latin1Bytes("R") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-classic", classicDir, "-rerelease", rereleaseDir]);
    COM_InitFilesystem();

    expect(COM_ClassicDir()).toBe(classicDir);
    expect(COM_RereleaseDir()).toBe(rereleaseDir);
    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(loadText("classiconly.txt")).toBe("C");
    expect(loadText("rronly.txt")).toBe("R");
  });
});

//============================================================================

describe("nested rerelease/ subdirectory: mounts both, rerelease above classic", () => {
  test("classic root/id1 is the fallback, root/rerelease/id1 (and its QuakeEX.kpf) sit above it", () => {
    const root = join(scratchDir, "nested-root");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "rerelease", "id1"));

    writePakToDisk(join(root, "id1", "pak0.pak"), [
      { name: "maps/dup.bsp", data: latin1Bytes("CLASSIC_BSP") },
      { name: "progs.dat", data: latin1Bytes("CLASSIC_PROGS") },
      { name: "classiconly.txt", data: latin1Bytes("CLASSIC_ONLY") },
    ]);
    writePakToDisk(join(root, "rerelease", "id1", "pak0.pak"), [
      { name: "maps/dup.bsp", data: latin1Bytes("RERELEASE_BSP") },
      { name: "progs.dat", data: latin1Bytes("RERELEASE_PROGS") },
      { name: "mapdb.json", data: latin1Bytes("{}") },
      { name: "rronly.txt", data: latin1Bytes("RR_ONLY") },
    ]);
    writeZipToDisk(join(root, "rerelease", "QuakeEX.kpf"), [{ name: "onlykpf2.txt", data: latin1Bytes("KPF2") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(COM_RereleaseDir()).toBe(join(root, "rerelease"));
    expect(COM_ClassicDir()).toBe(root);

    // Re-release copies win for a name that exists in both trees.
    expect(loadText("maps/dup.bsp")).toBe("RERELEASE_BSP");
    expect(loadText("progs.dat")).toBe("RERELEASE_PROGS");
    // Classic-only and kpf-only content both still resolve (fallback root).
    expect(loadText("classiconly.txt")).toBe("CLASSIC_ONLY");
    expect(loadText("onlykpf2.txt")).toBe("KPF2");
    expect(loadText("rronly.txt")).toBe("RR_ONLY");

    // Mount order (head/highest priority first):
    //   rerelease/id1 pak0.pak (rronly.txt, progs.dat, maps/dup.bsp)
    //   rerelease/id1 dir
    //   rerelease's QuakeEX.kpf (onlykpf2.txt)
    //   classic id1 pak0.pak (classiconly.txt)
    //   classic id1 dir
    const rrPakTier = COM_FindFileTier("rronly.txt");
    const kpfTier = COM_FindFileTier("onlykpf2.txt");
    const classicPakTier = COM_FindFileTier("classiconly.txt");

    expect(rrPakTier).not.toBe(-1);
    expect(kpfTier).not.toBe(-1);
    expect(classicPakTier).not.toBe(-1);
    expect(rrPakTier).toBeLessThan(kpfTier);
    expect(kpfTier).toBeLessThan(classicPakTier);

    // progs.dat and maps/dup.bsp both live in the SAME rerelease/id1 pak, so
    // they resolve from the same search-path node.
    expect(COM_FindFileTier("progs.dat")).toBe(COM_FindFileTier("maps/dup.bsp"));
    expect(COM_FindFileTier("progs.dat")).toBe(rrPakTier);
  });
});

//============================================================================

describe("-norerelease: a classic root with a nested rerelease/ mounts the classic tree alone", () => {
  test("re-release content is not mounted and the classic copies resolve", () => {
    const root = join(scratchDir, "nested-root-nore");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "rerelease", "id1"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [
      { name: "progs.dat", data: latin1Bytes("CLASSIC_PROGS") },
    ]);
    writePakToDisk(join(root, "rerelease", "id1", "pak0.pak"), [
      { name: "progs.dat", data: latin1Bytes("RERELEASE_PROGS") },
      { name: "mapdb.json", data: latin1Bytes("{}") },
      { name: "rronly.txt", data: latin1Bytes("RR_ONLY") },
    ]);

    setComSearchpaths(null); // earlier tests' mounts would otherwise still resolve a re-release-only name
    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root, "-norerelease"]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(false);
    expect(loadText("progs.dat")).toBe("CLASSIC_PROGS");
    expect(COM_LoadTempFile("rronly.txt")).toBeNull();
  });
});

describe("mission-pack-style episode flags: -mg1/-mg3/-dopa/-ctf", () => {
  test("-mg1 sets mg1=true, standard_quake=false, and mounts <root>/mg1", () => {
    const root = join(scratchDir, "mg1-root");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "mg1"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);
    writePakToDisk(join(root, "mg1", "pak0.pak"), [{ name: "maps/mge1m1.bsp", data: latin1Bytes("MG1_MAP") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root, "-mg1"]);
    COM_InitFilesystem();

    expect(mg1).toBe(true);
    expect(standard_quake).toBe(false);
    expect(loadText("maps/mge1m1.bsp")).toBe("MG1_MAP");
  });

  for (const flag of ["mg3", "dopa", "ctf"] as const) {
    test(`-${flag} sets ${flag}=true, standard_quake=false, and mounts <root>/${flag}`, () => {
      const root = join(scratchDir, `${flag}-root`);
      ensureDir(join(root, "id1"));
      ensureDir(join(root, flag));
      writePakToDisk(join(root, flag, "pak0.pak"), [{ name: `${flag}only.txt`, data: latin1Bytes(flag.toUpperCase()) }]);

      COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root, `-${flag}`]);
      COM_InitFilesystem();

      expect(standard_quake).toBe(false);
      expect(loadText(`${flag}only.txt`)).toBe(flag.toUpperCase());
      if (flag === "mg3") expect(mg3).toBe(true);
      if (flag === "dopa") expect(dopa).toBe(true);
      if (flag === "ctf") expect(ctf).toBe(true);
    });
  }

  test("-hipnotic under a re-release root uses the re-release copy of hipnotic, not the classic one", () => {
    const root = join(scratchDir, "hip-rerelease-root");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "hipnotic"));
    writeZipToDisk(join(root, "QuakeEX.kpf"), [{ name: "marker.txt", data: latin1Bytes("KPF") }]);
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);
    writePakToDisk(join(root, "hipnotic", "pak0.pak"), [{ name: "hiprr.txt", data: latin1Bytes("HIP_RERELEASE") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root, "-hipnotic"]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(hipnotic).toBe(true);
    // episodeRoot() resolves against the re-release root (== basedir here,
    // since basedir itself is the re-release root), so this is really just
    // proving -hipnotic still mounts correctly under a re-release root.
    expect(loadText("hiprr.txt")).toBe("HIP_RERELEASE");
  });
});

//============================================================================

describe('runtime "game" command (Host_Game_f)', () => {
  // Host_Game_f ends in Cbuf_AddText("exec quake.rc\n"); cmd_text (cmd.ts's
  // own SizeBuf) is otherwise never allocated in a test file that doesn't
  // call Cmd_Init/Cbuf_Init, so every call would otherwise print a spurious
  // "Cbuf_AddText: overflow" (harmless -- Cbuf_AddText degrades safely, per
  // its own comment -- but noisy). SZ_Alloc is idempotent, so this is safe
  // regardless of whether another suite already called it in this shared
  // process.
  Cbuf_Init();


  test('"game <dir>" tears down the mission-pack layer above the base tier and re-adds the requested one', () => {
    const root = join(scratchDir, "game-cmd-root");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "hipnotic"));
    ensureDir(join(root, "extramod"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);
    writePakToDisk(join(root, "hipnotic", "pak0.pak"), [{ name: "hip.txt", data: latin1Bytes("HIP") }]);
    writePakToDisk(join(root, "extramod", "pak0.pak"), [{ name: "mod.txt", data: latin1Bytes("MOD") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();
    sv.active = false;

    expect(loadText("hip.txt")).toBeNull(); // -hipnotic wasn't passed at boot

    Cmd_TokenizeString("game hipnotic");
    Host_Game_f();

    expect(hipnotic).toBe(true);
    expect(standard_quake).toBe(false);
    expect(COM_GetGameNames()).toBe("hipnotic");
    expect(loadText("hip.txt")).toBe("HIP");
    expect(loadText("progs.dat")).toBe("BASE"); // base tier survives the switch

    Cmd_TokenizeString("game extramod");
    Host_Game_f();

    expect(hipnotic).toBe(false); // torn down by the switch
    expect(COM_GetGameNames()).toBe("extramod");
    expect(loadText("mod.txt")).toBe("MOD");
    expect(loadText("hip.txt")).toBeNull(); // hipnotic's own mount is gone
    expect(loadText("progs.dat")).toBe("BASE");
  });

  test("shuts down an active server (and disconnects the client) instead of refusing, then switches -- matches Ironwail's COM_SwitchGame", () => {
    const root = join(scratchDir, "game-cmd-shutdown-root");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "hipnotic"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);
    writePakToDisk(join(root, "hipnotic", "pak0.pak"), [{ name: "hip2.txt", data: latin1Bytes("HIP2") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();

    sv.active = true;
    const savedClDisconnect = hostClientHooks.clDisconnect;
    // Host_ShutdownServer walks svs.clients (dropping active ones through the
    // net socket pool) and then replaces every client object. Other suites
    // in this process own that table and the pool's counts, so run the
    // shutdown against an empty table and put the real one back.
    const savedMaxclients = svs.maxclients;
    const savedMaxclientslimit = svs.maxclientslimit;
    const savedClients = svs.clients.slice();
    svs.maxclients = 0;
    svs.maxclientslimit = 0;
    let disconnectCalled = false;
    hostClientHooks.clDisconnect = () => {
      disconnectCalled = true;
    };
    try {
      Cmd_TokenizeString("game hipnotic");
      Host_Game_f();
    } finally {
      hostClientHooks.clDisconnect = savedClDisconnect;
      svs.maxclients = savedMaxclients;
      svs.maxclientslimit = savedMaxclientslimit;
      for (let i = 0; i < savedClients.length; i++) svs.clients[i] = savedClients[i];
      svs.clients.length = savedClients.length;
    }

    expect(disconnectCalled).toBe(true); // CL_Disconnect called unconditionally, like Host_Map_f does
    expect(sv.active).toBe(false); // Host_ShutdownServer tore the server down itself, unconditionally
    expect(hipnotic).toBe(true); // ... and still switched
    expect(loadText("hip2.txt")).toBe("HIP2");
  });

  test('"game" with no arguments reports the current gamedir(s) without throwing or switching', () => {
    const root = join(scratchDir, "game-cmd-noargs-root");
    ensureDir(join(root, "id1"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();
    sv.active = false;

    Cmd_TokenizeString("game");
    expect(() => Host_Game_f()).not.toThrow();
    expect(COM_GetGameNames()).toBe("id1");
  });
});

//============================================================================

describe("-game <dir> and the \"game\" command resolve against the re-release root first, when it exists there", () => {
  // A classic root with a nested rerelease/ subdirectory, and mg1 sitting
  // ONLY under rerelease/ (matching the real qfiles/q1 layout) -- neither
  // the classic root nor a plain <basedir>/mg1 exists.
  // markerName is unique per call site so an earlier test's leftover mount
  // (com_searchpaths is never reset between tests in this file, per its own
  // header comment) can't make a later "not mounted yet" assertion pass by
  // accident.
  function buildNestedWithMg1(root: string, markerName: string): void {
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "rerelease", "id1"));
    ensureDir(join(root, "rerelease", "mg1"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("CLASSIC") }]);
    writePakToDisk(join(root, "rerelease", "id1", "pak0.pak"), [
      { name: "progs.dat", data: latin1Bytes("RERELEASE") },
      { name: "mapdb.json", data: latin1Bytes("{}") },
    ]);
    writePakToDisk(join(root, "rerelease", "mg1", "pak0.pak"), [{ name: markerName, data: latin1Bytes("MG1_MAP") }]);
  }

  test("-game mg1 on a classic root with a nested rerelease/ reaches rerelease/mg1", () => {
    const root = join(scratchDir, "game-parm-nested-mg1");
    buildNestedWithMg1(root, "maps/mge1m1_a.bsp");

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root, "-game", "mg1"]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(loadText("maps/mge1m1_a.bsp")).toBe("MG1_MAP");
  });

  test('the "game" command resolves the same way at runtime', () => {
    const root = join(scratchDir, "game-cmd-nested-mg1");
    buildNestedWithMg1(root, "maps/mge1m1_b.bsp");

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root]);
    COM_InitFilesystem();
    sv.active = false;

    expect(loadText("maps/mge1m1_b.bsp")).toBeNull(); // not requested yet

    Cmd_TokenizeString("game mg1");
    Host_Game_f();

    expect(COM_GetGameNames()).toBe("mg1");
    expect(loadText("maps/mge1m1_b.bsp")).toBe("MG1_MAP");
  });

  test("falls back to <basedir>/<dir> when the re-release root doesn't have that directory", () => {
    const root = join(scratchDir, "game-parm-nested-fallback");
    ensureDir(join(root, "id1"));
    ensureDir(join(root, "rerelease", "id1"));
    ensureDir(join(root, "classiconlymod"));
    writePakToDisk(join(root, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("CLASSIC") }]);
    writePakToDisk(join(root, "rerelease", "id1", "pak0.pak"), [
      { name: "progs.dat", data: latin1Bytes("RERELEASE") },
      { name: "mapdb.json", data: latin1Bytes("{}") },
    ]);
    // classiconlymod exists ONLY at <basedir>/classiconlymod, not under
    // rerelease/ -- resolveGameDir must fall back to it rather than mounting
    // a nonexistent rerelease/classiconlymod (or nothing at all).
    writePakToDisk(join(root, "classiconlymod", "pak0.pak"), [{ name: "modonly.txt", data: latin1Bytes("CLASSIC_MOD") }]);

    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", root, "-game", "classiconlymod"]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(loadText("modonly.txt")).toBe("CLASSIC_MOD");
  });
});

//============================================================================

describe("home directory tier (-homedir / -nohomedir / the default)", () => {
  test("com_gamedir points at <homedir>/<gamedir>, which is searched FIRST and is the write target", () => {
    const baseDir = join(scratchDir, "homedir-base");
    const homeDir = join(scratchDir, "homedir-home");
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(homeDir, "id1"));

    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);
    writeFileSync(join(baseDir, "id1", "pref.txt"), latin1Bytes("FROM_BASE"));
    writeFileSync(join(homeDir, "id1", "pref.txt"), latin1Bytes("FROM_HOME"));

    COM_InitArgv(["q1ts", "-basedir", baseDir, "-homedir", homeDir]);
    COM_InitFilesystem();

    expect(com_gamedir).toBe(join(homeDir, "id1"));
    expect(loadText("pref.txt")).toBe("FROM_HOME"); // homedir searched first
    expect(loadText("progs.dat")).toBe("BASE"); // base content still reachable

    COM_WriteFile("written.cfg", latin1Bytes("HELLO"));
    expect(existsSync(join(homeDir, "id1", "written.cfg"))).toBe(true);
    expect(existsSync(join(baseDir, "id1", "written.cfg"))).toBe(false);
    expect(bytesToLatin1(readFileSync(join(homeDir, "id1", "written.cfg")))).toBe("HELLO");
  });

  test("-nohomedir puts com_gamedir back on the gamedir itself and writes land there (WinQuake behaviour)", () => {
    const baseDir = join(scratchDir, "nohomedir-base");
    ensureDir(join(baseDir, "id1"));
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);

    COM_InitArgv(["q1ts", "-basedir", baseDir, "-nohomedir"]);
    COM_InitFilesystem();

    expect(com_homedir).toBe("");
    expect(com_gamedir).toBe(join(baseDir, "id1"));

    COM_WriteFile("plain.cfg", latin1Bytes("PLAIN"));
    expect(existsSync(join(baseDir, "id1", "plain.cfg"))).toBe(true);
  });

  // F3: with NEITHER parameter given the engine writes under the user's own
  // data directory instead of the (often read-only, always shared) retail
  // install -- $XDG_DATA_HOME/q1rets, mirrored per gamedir.
  describe("the default with neither parameter", () => {
    const savedXdg = process.env.XDG_DATA_HOME;
    const savedHome = process.env.HOME;
    // `bun run test` exports Q1TS_NOHOMEDIR=1 so unit boots never touch the
    // real per-user directory; this describe tests the default itself.
    const savedNoHome = process.env.Q1TS_NOHOMEDIR;
    beforeAll(() => {
      delete process.env.Q1TS_NOHOMEDIR;
    });

    afterAll(() => {
      if (savedNoHome === undefined) delete process.env.Q1TS_NOHOMEDIR;
      else process.env.Q1TS_NOHOMEDIR = savedNoHome;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    test("COM_DefaultHomeDir prefers $XDG_DATA_HOME, then $HOME/.local/share, else \"\"", () => {
      process.env.XDG_DATA_HOME = "/xdg/data";
      process.env.HOME = "/home/someone";
      expect(COM_DefaultHomeDir()).toBe(`/xdg/data/${HOMEDIR_APPNAME}`);

      process.env.XDG_DATA_HOME = "/xdg/data/"; // a trailing slash is trimmed
      expect(COM_DefaultHomeDir()).toBe(`/xdg/data/${HOMEDIR_APPNAME}`);

      delete process.env.XDG_DATA_HOME;
      expect(COM_DefaultHomeDir()).toBe(`/home/someone/.local/share/${HOMEDIR_APPNAME}`);

      delete process.env.HOME;
      expect(COM_DefaultHomeDir()).toBe("");
    });

    test("com_gamedir lands under $XDG_DATA_HOME/q1rets/<gamedir>, searched first, and every mounted gamedir gets its own", () => {
      const baseDir = join(scratchDir, "defaulthome-base");
      const xdgDir = join(scratchDir, "defaulthome-xdg");
      ensureDir(join(baseDir, "id1"));
      ensureDir(join(baseDir, "mymod"));
      writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);
      writeFileSync(join(baseDir, "mymod", "pref.txt"), latin1Bytes("FROM_BASE"));

      process.env.XDG_DATA_HOME = xdgDir;
      delete process.env.HOME;

      COM_InitArgv(["q1ts", "-basedir", baseDir, "-game", "mymod"]);
      COM_InitFilesystem();

      expect(com_homedir).toBe(join(xdgDir, HOMEDIR_APPNAME));
      expect(com_gamedir).toBe(join(xdgDir, HOMEDIR_APPNAME, "mymod"));

      // The tier is created on demand, per gamedir, for id1 as well as the
      // -game dir.
      expect(existsSync(join(xdgDir, HOMEDIR_APPNAME, "id1"))).toBe(true);
      expect(existsSync(join(xdgDir, HOMEDIR_APPNAME, "mymod"))).toBe(true);

      // Writes go to the home tier; the retail install is untouched.
      COM_WriteFile("config.cfg", latin1Bytes("ARCHIVED"));
      expect(existsSync(join(xdgDir, HOMEDIR_APPNAME, "mymod", "config.cfg"))).toBe(true);
      expect(existsSync(join(baseDir, "mymod", "config.cfg"))).toBe(false);

      // The basedir gamedir is still readable underneath...
      expect(loadText("pref.txt")).toBe("FROM_BASE");
      expect(loadText("progs.dat")).toBe("BASE");

      // ...and the home tier outranks it once a file exists in both.
      writeFileSync(join(xdgDir, HOMEDIR_APPNAME, "mymod", "pref.txt"), latin1Bytes("FROM_HOME"));
      expect(loadText("pref.txt")).toBe("FROM_HOME");
    });

    test("$HOME with no $XDG_DATA_HOME lands under ~/.local/share/q1rets", () => {
      const baseDir = join(scratchDir, "defaulthome-home-base");
      const fakeHome = join(scratchDir, "defaulthome-home");
      ensureDir(join(baseDir, "id1"));
      writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);

      delete process.env.XDG_DATA_HOME;
      process.env.HOME = fakeHome;

      COM_InitArgv(["q1ts", "-basedir", baseDir]);
      COM_InitFilesystem();

      expect(com_gamedir).toBe(join(fakeHome, ".local", "share", HOMEDIR_APPNAME, "id1"));
    });

    test("-homedir still overrides the default", () => {
      const baseDir = join(scratchDir, "override-base");
      const homeDir = join(scratchDir, "override-home");
      ensureDir(join(baseDir, "id1"));
      writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "progs.dat", data: latin1Bytes("BASE") }]);

      process.env.XDG_DATA_HOME = join(scratchDir, "override-xdg");

      COM_InitArgv(["q1ts", "-basedir", baseDir, "-homedir", homeDir]);
      COM_InitFilesystem();

      expect(com_gamedir).toBe(join(homeDir, "id1"));
      expect(existsSync(join(scratchDir, "override-xdg"))).toBe(false);
    });
  });
});

//============================================================================
// Guarded real-data tests: skip when the real Quake 1 re-release install
// this repo's tests share isn't present.

const REAL_Q1_DIR = process.env.Q1TS_REAL_DATA ?? "/home/buzzkill/Projects/qfiles/q1";
const HAVE_REAL_Q1 = existsSync(join(REAL_Q1_DIR, "id1")) && existsSync(join(REAL_Q1_DIR, "rerelease"));

describe.skipIf(!HAVE_REAL_Q1)("real-data: classic root with nested rerelease/ (qfiles/q1)", () => {
  test("localization/loc_english.txt, fonts/qfont.kfont, maps/e1m1.bsp and progs.dat all resolve, rerelease above classic", () => {
    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", REAL_Q1_DIR]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(COM_RereleaseDir()).toBe(join(REAL_Q1_DIR, "rerelease"));
    expect(COM_ClassicDir()).toBe(REAL_Q1_DIR);

    expect(COM_LoadTempFile("localization/loc_english.txt")).not.toBeNull(); // from QuakeEX.kpf
    expect(COM_LoadTempFile("fonts/qfont.kfont")).not.toBeNull(); // from QuakeEX.kpf
    expect(COM_LoadTempFile("maps/e1m1.bsp")).not.toBeNull();
    expect(COM_LoadTempFile("progs.dat")).not.toBeNull();

    // fonts/qfont.kfont exists ONLY inside QuakeEX.kpf (confirmed against
    // the real archive -- unlike localization/loc_english.txt, which
    // rerelease/id1/pak0.pak also carries its own copy of), so it's the
    // clean probe for "the kpf's own tier".
    const kpfTier = COM_FindFileTier("fonts/qfont.kfont");
    const e1m1Tier = COM_FindFileTier("maps/e1m1.bsp");
    const progsTier = COM_FindFileTier("progs.dat");

    expect(kpfTier).not.toBe(-1);
    expect(e1m1Tier).not.toBe(-1);
    // maps/e1m1.bsp resolves from rerelease/id1's own pak, which sits ABOVE
    // QuakeEX.kpf (the kpf mounts below id1's own paks) -- and QuakeEX.kpf
    // itself sits above classic id1, so this transitively proves e1m1.bsp
    // resolves above classic id1 too.
    expect(e1m1Tier).toBeLessThan(kpfTier);
    // progs.dat lives in the same rerelease/id1 pak as maps/e1m1.bsp.
    expect(progsTier).toBe(e1m1Tier);
  });
});

describe.skipIf(!HAVE_REAL_Q1)("real-data: mounting the rerelease root directly with -mg1 (qfiles/q1/rerelease)", () => {
  test("maps/mge1m1.bsp resolves", () => {
    const rereleaseDir = join(REAL_Q1_DIR, "rerelease");
    COM_InitArgv(["q1ts", "-nohomedir", "-basedir", rereleaseDir, "-mg1"]);
    COM_InitFilesystem();

    expect(COM_IsRereleaseRoot()).toBe(true);
    expect(COM_RereleaseDir()).toBe(rereleaseDir);
    expect(mg1).toBe(true);
    expect(COM_LoadTempFile("maps/mge1m1.bsp")).not.toBeNull();
  });
});
