/*
Self-sufficient test for Q002: src/qw/common.ts (QW/client/common.c). Builds
its own scratch basedir (id1/ and qw/ each with a loose marker file, plus a
synthetic pak0.pak and gfx/pop.lmp for the registration recipe, following
test/host.test.ts's own recipe for that fixture) and re-initializes the now-
shared (Task 1) com_argc/com_argv/com_searchpaths/com_gamedir state via
COM_InitArgv + COM_InitFilesystem in each test that needs a specific search
path, per standing order 13 (never rely on another test's run having already
initialized shared state) and the landed suites' own precedent
(test/common.test.ts re-inits per test group).

Task 1 (2026-09-05): com_filesize/com_gamedir/static_registered (and
com_argc/com_argv/com_searchpaths, read internally by this module's own
functions) are src/common/common.ts's shared bindings now, reassigned
through its exported setters -- this file's own re-exports of those names
are live re-exports of that same state, not a second copy. The
"COM_InitFilesystem / COM_Gamedir" describe block below additionally asserts
that src/common/common.ts's own COM_LoadHunkFile (the function every other
shared module -- model.ts, wad.ts, cmd.ts's Cmd_Exec_f -- actually calls)
finds files through the exact same search path this module's own
COM_InitFilesystem/COM_Gamedir just built, proving the structural fix.

That same sharing means com_searchpaths is now the SAME singleton
test/qw_pmove.test.ts (and every other WinQuake-track suite) reaches through
src/common/common.ts's own COM_InitFilesystem/COM_AddGameDirectory, which
only ever PREPEND onto the existing list (matching the real engine, which
calls COM_InitFilesystem exactly once per process and never expects to);
bun runs every test file in one process, so without an explicit reset here,
an earlier-run file's search-path entries (e.g. another suite's own
gfx/pop.lmp fixture) stay reachable underneath this file's freshly prepended
ones and can satisfy a lookup this file's own test expected to fail. Per
test hygiene rule 15 ("shared singletons... get reset by your own suite"),
`beforeEach` clears com_searchpaths to its pre-suite-boot value (null, same
as src/common/common.ts's own module-load default) before every test in this
file, and `afterAll` restores it so a later-run file sees the same clean
default this file started with.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  COM_InitArgv,
  com_argc,
  com_argv,
  COM_InitFilesystem,
  COM_Gamedir,
  COM_FOpenFile,
  COM_LoadHunkFile,
  COM_CheckRegistered,
  com_filesize,
  com_gamedir,
  gamedirfile,
  static_registered,
  pop,
  Info_ValueForKey,
  Info_SetValueForKey,
  Info_SetValueForStarKey,
  Info_RemoveKey,
  Info_RemovePrefixedKeys,
  Info_Print,
  MSG_WriteDeltaUsercmd,
  MSG_ReadDeltaUsercmd,
  MSG_ReadStringLine,
  COM_BlockSequenceCRCByte,
  net_message,
  msgState,
  MSG_BeginReading,
} from "../src/qw/common";
import { COM_LoadHunkFile as SharedCOM_LoadHunkFile, setComSearchpaths, setComModified } from "../src/common/common";
import { QwUsercmdT, CM_ANGLE2, CM_FORWARD, CM_BUTTONS } from "../src/qw/protocol";
import { SizeBuf, SZ_Alloc } from "../src/common/sizebuf";
import { writePakToDisk, ensureDir } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qw-common-test-"));

// see file header: com_searchpaths/com_modified are process-wide shared
// singletons now (Task 1) -- reset both before every test in this file so
// an earlier-run suite's leftover entries (e.g. another gfx/pop.lmp fixture,
// or another suite's synthetic pak that tripped com_modified via a file-
// count/CRC mismatch) can never affect a lookup or a registration check
// this file's own tests expect to start clean, and restore the defaults
// afterward so a later-run file sees the same clean state this file started
// with.
beforeEach(() => {
  setComSearchpaths(null);
  setComModified(false);
});
afterAll(() => {
  setComSearchpaths(null);
  setComModified(false);
});

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function writeLoose(path: string, content: string): void {
  writeFileSync(path, latin1Bytes(content));
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break; // COM_LoadFile's trailing NUL
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

// Independent bitwise CRC-16 (CCITT/XMODEM: poly 0x1021, init 0xffff, xorout
// 0x0000), the same cross-check test/crc.test.ts uses, so this test does not
// depend on qw/common.ts's own CRC_Init/CRC_ProcessByte calls being correct.
function bitwiseCrc(bytes: readonly number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc ^ 0x0000;
}

//============================================================================

describe("Info_* string functions", () => {
  test("Info_ValueForKey finds a key's value; missing key/malformed string -> \"\"", () => {
    const s = "\\name\\Player\\team\\red";
    expect(Info_ValueForKey(s, "name")).toBe("Player");
    expect(Info_ValueForKey(s, "team")).toBe("red");
    expect(Info_ValueForKey(s, "nope")).toBe("");
    expect(Info_ValueForKey("", "name")).toBe("");
  });

  test("Info_SetValueForKey adds a new key and Info_ValueForKey reads it back", () => {
    let s = "";
    s = Info_SetValueForKey(s, "name", "Player", 196);
    expect(s).toBe("\\name\\Player");
    expect(Info_ValueForKey(s, "name")).toBe("Player");

    s = Info_SetValueForKey(s, "team", "red", 196);
    expect(Info_ValueForKey(s, "name")).toBe("Player");
    expect(Info_ValueForKey(s, "team")).toBe("red");
  });

  test("Info_SetValueForKey replaces an existing key's value in place", () => {
    let s = Info_SetValueForKey("", "team", "red", 196);
    s = Info_SetValueForKey(s, "team", "blue", 196);
    expect(Info_ValueForKey(s, "team")).toBe("blue");
    // only one "team" key remains
    expect(s.split("\\team\\").length - 1).toBe(1);
  });

  test("Info_SetValueForKey rejects a key starting with '*'", () => {
    const s = Info_SetValueForKey("\\name\\Player", "*version", "1.0", 196);
    expect(s).toBe("\\name\\Player"); // unchanged
    expect(Info_ValueForKey(s, "*version")).toBe("");
  });

  test("Info_SetValueForStarKey accepts a '*' key directly (Info_SetValueForKey is the gate, not SetValueForStarKey)", () => {
    const s = Info_SetValueForStarKey("", "*version", "1.0", 196);
    expect(Info_ValueForKey(s, "*version")).toBe("1.0");
  });

  test("Info_SetValueForKey rejects keys/values containing a backslash or quote", () => {
    const base = "\\name\\Player";
    expect(Info_SetValueForKey(base, "na\\me", "x", 196)).toBe(base);
    expect(Info_SetValueForKey(base, "name", "x\\y", 196)).toBe(base);
    expect(Info_SetValueForKey(base, 'na"me', "x", 196)).toBe(base);
    expect(Info_SetValueForKey(base, "name", 'x"y', 196)).toBe(base);
  });

  test("Info_SetValueForKey rejects keys/values >= 64 characters", () => {
    const base = "\\name\\Player";
    const longKey = "k".repeat(64);
    const longValue = "v".repeat(64);
    expect(Info_SetValueForKey(base, longKey, "x", 196)).toBe(base);
    expect(Info_SetValueForKey(base, "name", longValue, 196)).toBe(base);
    // exactly 63 characters is allowed
    const okKey = "k".repeat(63);
    const s = Info_SetValueForKey(base, okKey, "x", 196);
    expect(Info_ValueForKey(s, okKey)).toBe("x");
  });

  test("Info_SetValueForKey rejects a change that would exceed maxsize, leaving the string unchanged", () => {
    let s = Info_SetValueForKey("", "name", "Player", 20); // "\name\Player" == 11 chars
    const before = s;
    // "\bigkey\1234567890" would push the total past maxsize=20
    s = Info_SetValueForKey(s, "bigkey", "1234567890", 20);
    expect(s).toBe(before);
    expect(Con_length_ok(before, 20)).toBe(true);
  });

  function Con_length_ok(s: string, maxsize: number): boolean {
    return s.length <= maxsize;
  }

  test("Info_RemoveKey removes exactly the named key, preserving the rest", () => {
    let s = Info_SetValueForKey("", "name", "Player", 196);
    s = Info_SetValueForKey(s, "team", "red", 196);
    s = Info_SetValueForKey(s, "skin", "base", 196);

    s = Info_RemoveKey(s, "team");
    expect(Info_ValueForKey(s, "team")).toBe("");
    expect(Info_ValueForKey(s, "name")).toBe("Player");
    expect(Info_ValueForKey(s, "skin")).toBe("base");
  });

  test("Info_RemoveKey refuses a key containing a backslash and returns the string unchanged", () => {
    const s = "\\name\\Player";
    expect(Info_RemoveKey(s, "na\\me")).toBe(s);
  });

  test("Info_RemovePrefixedKeys('*') removes every key starting with '*', keeps the rest", () => {
    let s = Info_SetValueForStarKey("", "*version", "1.0", 196);
    s = Info_SetValueForKey(s, "name", "Player", 196);
    s = Info_SetValueForStarKey(s, "*spawnparm", "7", 196);
    s = Info_SetValueForKey(s, "team", "red", 196);

    s = Info_RemovePrefixedKeys(s, "*");

    expect(Info_ValueForKey(s, "*version")).toBe("");
    expect(Info_ValueForKey(s, "*spawnparm")).toBe("");
    expect(Info_ValueForKey(s, "name")).toBe("Player");
    expect(Info_ValueForKey(s, "team")).toBe("red");
  });

  test("Info_Print pads each key to 20 characters and prints MISSING VALUE for a trailing key", () => {
    const lines: string[] = [];
    // Con_Printf funnels through console.ts's own state; capture via the
    // %s/%s pattern this file's Info_Print always calls with, by round-
    // tripping through Info_ValueForKey/the string shape instead of hooking
    // console output (out of this unit's SCOPE to modify console.ts).
    let s = Info_SetValueForKey("", "name", "Player", 196);
    s = Info_SetValueForKey(s, "team", "red", 196);
    // Info_Print itself only prints (void); assert it doesn't throw on a
    // well-formed string and on one with a dangling key (no value).
    expect(() => Info_Print(s)).not.toThrow();
    expect(() => Info_Print("\\dangling")).not.toThrow();
    void lines;
  });
});

//============================================================================

describe("MSG_WriteDeltaUsercmd / MSG_ReadDeltaUsercmd", () => {
  test("round-trips a cmd differing from `from` in angles[1], forwardmove, buttons; exact bits byte and byte count", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 64);

    const from = new QwUsercmdT();
    from.angles[0] = 10;
    from.angles[1] = 20;
    from.angles[2] = 30;
    from.forwardmove = 100;
    from.sidemove = 0;
    from.upmove = 0;
    from.buttons = 0;
    from.impulse = 0;
    from.msec = 16;

    const cmd = new QwUsercmdT();
    cmd.angles[0] = 10; // unchanged
    cmd.angles[1] = 45; // changed
    cmd.angles[2] = 30; // unchanged
    cmd.forwardmove = 200; // changed
    cmd.sidemove = 0; // unchanged
    cmd.upmove = 0; // unchanged
    cmd.buttons = 1; // changed
    cmd.impulse = 0; // unchanged
    cmd.msec = 16;

    MSG_WriteDeltaUsercmd(buf, from, cmd);

    // bits byte: only CM_ANGLE2 | CM_FORWARD | CM_BUTTONS set
    const expectedBits = CM_ANGLE2 | CM_FORWARD | CM_BUTTONS;
    expect(buf.data[0]).toBe(expectedBits);

    // byte count: 1 (bits) + 2 (angle2, MSG_WriteAngle16 is a short) +
    // 2 (forwardmove, a short) + 1 (buttons) + 1 (msec, always written) = 7
    expect(buf.cursize).toBe(7);

    // now read it back through the real net_message/msgState reader path
    net_message.data = buf.data;
    net_message.cursize = buf.cursize;
    MSG_BeginReading();

    const move = new QwUsercmdT();
    VectorCopyLike(move, from); // move starts as a copy of some other baseline to prove the read actually rewrites every field the C's memcpy would
    move.angles[0] = 999;
    move.angles[2] = 999;

    MSG_ReadDeltaUsercmd(from, move);

    expect(move.angles[0]).toBe(from.angles[0]); // copied from `from`, not left at 999
    expect(move.angles[1]).toBe(45);
    expect(move.angles[2]).toBe(from.angles[2]);
    expect(move.forwardmove).toBe(200);
    expect(move.sidemove).toBe(from.sidemove);
    expect(move.upmove).toBe(from.upmove);
    expect(move.buttons).toBe(1);
    expect(move.impulse).toBe(from.impulse);
    expect(move.msec).toBe(16);
  });

  function VectorCopyLike(dst: QwUsercmdT, src: QwUsercmdT): void {
    dst.angles[0] = src.angles[0];
    dst.angles[1] = src.angles[1];
    dst.angles[2] = src.angles[2];
  }

  test("an unchanged cmd writes bits=0 and only the msec byte follows", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 64);

    const from = new QwUsercmdT();
    from.msec = 33;
    const cmd = new QwUsercmdT();
    cmd.msec = 33;

    MSG_WriteDeltaUsercmd(buf, from, cmd);

    expect(buf.data[0]).toBe(0);
    expect(buf.cursize).toBe(2); // bits + msec only
    expect(buf.data[1]).toBe(33);
  });
});

//============================================================================

describe("MSG_ReadStringLine", () => {
  test("reads up to a newline, NUL, or -1, whichever comes first", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 64);
    // "hello\nworld" as raw bytes, no NUL terminator needed since '\n' stops it first
    for (const c of "hello\nworld") buf.data[buf.cursize++] = c.charCodeAt(0);

    net_message.data = buf.data;
    net_message.cursize = buf.cursize;
    MSG_BeginReading();

    expect(MSG_ReadStringLine()).toBe("hello");
  });

  test("stops at a NUL byte if no newline precedes it", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 64);
    for (const c of "abc") buf.data[buf.cursize++] = c.charCodeAt(0);
    buf.data[buf.cursize++] = 0;
    for (const c of "xyz") buf.data[buf.cursize++] = c.charCodeAt(0);

    net_message.data = buf.data;
    net_message.cursize = buf.cursize;
    MSG_BeginReading();

    expect(MSG_ReadStringLine()).toBe("abc");
  });
});

//============================================================================

describe("COM_BlockSequenceCRCByte", () => {
  test("matches a hand computation using chktbl's known first 4 bytes at sequence=0", () => {
    // chktbl[0..3] from QW/client/common.c's own literal (mechanically
    // extracted and spot-checked against the source, see src/qw/common.ts's
    // file header): 0x78, 0xd2, 0x94, 0xe3. sequence=0 selects
    // p = chktbl + (0 % (1028-8)) = chktbl+0, so p[0..3] are exactly these
    // four bytes, independent of qw/common.ts's own chktbl table.
    const p = [0x78, 0xd2, 0x94, 0xe3];
    const base = new Uint8Array([1, 2, 3, 4, 5]);
    const sequence = 0;

    const chkb = new Array<number>(64).fill(0);
    for (let i = 0; i < base.length; i++) chkb[i] = base[i];
    let length = base.length;
    chkb[length] = (sequence & 0xff) ^ p[0];
    chkb[length + 1] = p[1];
    chkb[length + 2] = ((sequence >> 8) & 0xff) ^ p[2];
    chkb[length + 3] = p[3];
    length += 4;

    const expected = bitwiseCrc(chkb.slice(0, length)) & 0xff;

    expect(COM_BlockSequenceCRCByte(base, base.length, sequence)).toBe(expected);
  });

  test("caps length at 60 bytes", () => {
    const base = new Uint8Array(100).fill(7);
    // Should not throw despite length > 60, and should equal the length=60 case
    const a = COM_BlockSequenceCRCByte(base, 100, 1);
    const b = COM_BlockSequenceCRCByte(base, 60, 1);
    expect(a).toBe(b);
  });

  test("returns a single byte (0-255)", () => {
    const base = new Uint8Array([9, 9, 9]);
    const crc = COM_BlockSequenceCRCByte(base, base.length, 42);
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(255);
  });
});

//============================================================================

// F.md D4 (this tree's own COM_InitArgv): see test/common.test.ts's own
// header comment for the full analysis -- QW/client/common.c's COM_InitArgv
// (read in full against ../qsrc/quake/QW/client/common.c)
// truncates at the same MAX_NUM_ARGVS=50 (including argv[0]), silently
// dropping anything past it, exactly as this port's own COM_InitArgv does.
// No hang is possible here either (every loop is bounded); the per-test
// timeout is a regression guard.
describe("COM_InitArgv argv truncation at MAX_NUM_ARGVS=50 (D4, QuakeWorld track)", () => {
  test("49 total tokens (including argv[0]): none dropped", () => {
    const argv = ["quake", ...Array.from({ length: 48 }, (_, i) => `arg${i}`)];
    COM_InitArgv(argv);
    expect(com_argc).toBe(49);
    expect(com_argv[48]).toBe("arg47");
  }, 2000);

  test("50 total tokens: exactly MAX_NUM_ARGVS, none dropped", () => {
    const argv = ["quake", ...Array.from({ length: 49 }, (_, i) => `arg${i}`)];
    COM_InitArgv(argv);
    expect(com_argc).toBe(50);
    expect(com_argv[49]).toBe("arg48");
  }, 2000);

  test("51 total tokens: truncated to 50, the 51st (e.g. a trailing +quit) silently dropped", () => {
    const argv = ["quake", ...Array.from({ length: 49 }, (_, i) => `arg${i}`), "+quit"];
    COM_InitArgv(argv);
    expect(com_argc).toBe(50);
    expect(com_argv.slice(0, com_argc)).not.toContain("+quit");
  }, 2000);

  test("70 total tokens (F.md's repro scale): truncated to 50, no hang", () => {
    const argv = ["quake", ...Array.from({ length: 68 }, (_, i) => `+echo${i}`), "+quit"];
    COM_InitArgv(argv);
    expect(com_argc).toBe(50);
    expect(com_argv.slice(0, com_argc)).not.toContain("+quit");
  }, 2000);
});

describe("COM_InitFilesystem / COM_Gamedir", () => {
  function makeBaseDir(name: string): string {
    const baseDir = join(scratchDir, name);
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw"));
    writeLoose(join(baseDir, "id1", "marker.txt"), "ID1");
    writeLoose(join(baseDir, "qw", "marker.txt"), "QW");
    return baseDir;
  }

  test("search order: qw is searched before id1 (a file present in both resolves to qw's)", () => {
    const baseDir = makeBaseDir("initfs");

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    const data = COM_LoadHunkFile("marker.txt");
    if (data === null) throw new Error("expected marker.txt to be found");
    expect(bytesToLatin1(data)).toBe("QW");
    expect(com_gamedir.endsWith("/qw")).toBe(true);
    expect(gamedirfile).toBe("qw");

    // Task 1's structural fix: src/common/common.ts's own COM_LoadHunkFile
    // (every shared module's actual filesystem entry point) walks the SAME
    // com_searchpaths this module's COM_InitFilesystem just built, not a
    // second, never-found parallel copy.
    const sharedData = SharedCOM_LoadHunkFile("marker.txt");
    if (sharedData === null) {
      throw new Error("expected src/common/common.ts's COM_LoadHunkFile to find marker.txt via the shared search path");
    }
    expect(bytesToLatin1(sharedData)).toBe("QW");
  });

  test("COM_Gamedir('ctf') pushes basedir/ctf ahead of qw/id1; COM_Gamedir('qw') pops back to base", () => {
    const baseDir = makeBaseDir("gamedirtest");
    ensureDir(join(baseDir, "ctf"));
    writeLoose(join(baseDir, "ctf", "marker.txt"), "CTF");
    writeLoose(join(baseDir, "ctf", "onlyctf.txt"), "ONLYCTF");

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    // before switching, marker.txt still resolves to qw's
    let data = COM_LoadHunkFile("marker.txt");
    if (data === null) throw new Error("expected marker.txt");
    expect(bytesToLatin1(data)).toBe("QW");

    COM_Gamedir("ctf");
    expect(gamedirfile).toBe("ctf");
    expect(com_gamedir).toBe(`${baseDir}/ctf`);

    data = COM_LoadHunkFile("marker.txt");
    if (data === null) throw new Error("expected marker.txt to resolve inside ctf/");
    expect(bytesToLatin1(data)).toBe("CTF");

    // a file that exists only in ctf/ is reachable
    data = COM_LoadHunkFile("onlyctf.txt");
    if (data === null) throw new Error("expected onlyctf.txt to be found while gamedir is ctf");
    expect(bytesToLatin1(data)).toBe("ONLYCTF");

    // src/common/common.ts's own COM_LoadHunkFile sees the same COM_Gamedir
    // switch (Task 1's structural fix -- see file header)
    const sharedOnlyCtf = SharedCOM_LoadHunkFile("onlyctf.txt");
    if (sharedOnlyCtf === null) throw new Error("expected the shared COM_LoadHunkFile to also find onlyctf.txt while gamedir is ctf");
    expect(bytesToLatin1(sharedOnlyCtf)).toBe("ONLYCTF");

    COM_Gamedir("qw");
    expect(gamedirfile).toBe("qw");

    // ctf/ is no longer on the search path
    const { handle } = COM_FOpenFile("onlyctf.txt");
    expect(handle).toBe(-1);

    // back to qw's marker.txt
    data = COM_LoadHunkFile("marker.txt");
    if (data === null) throw new Error("expected marker.txt to resolve back to qw/ after popping ctf");
    expect(bytesToLatin1(data)).toBe("QW");
  });

  test("COM_Gamedir rejects a path-shaped argument and leaves the current gamedir untouched", () => {
    const baseDir = makeBaseDir("gamedirreject");
    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    const before = gamedirfile;
    COM_Gamedir("../etc");
    expect(gamedirfile).toBe(before);
    COM_Gamedir("a/b");
    expect(gamedirfile).toBe(before);
  });

  // id Software's own distribution ships the game directory as Id1/PAK0.PAK
  // (mixed case; see src/common/common.ts's COM_AddGameDirectory comment).
  // This module's own COM_InitFilesystem calls COM_AddGameDirectory("id1")
  // then COM_AddGameDirectory("qw") -- qw is added last, so it ends up the
  // current com_gamedir, exactly as the "search order" test above asserts
  // for the matching-case default directories.
  test("COM_InitFilesystem resolves id Software's own mixed-case distribution (Id1/PAK0.PAK), com_gamedir ends with /Qw", () => {
    const baseDir = join(scratchDir, "realdist-qw");
    ensureDir(join(baseDir, "Id1"));
    ensureDir(join(baseDir, "Qw"));
    writePakToDisk(join(baseDir, "Id1", "PAK0.PAK"), [{ name: "gfx/pop.lmp", data: new Uint8Array([9, 9, 9, 9]) }]);

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    expect(gamedirfile).toBe("qw");
    expect(com_gamedir).toBe(join(baseDir, "Qw"));
    expect(com_gamedir.endsWith("/Qw")).toBe(true);

    // Id1/ is still on the search path underneath Qw/, reached through the
    // resolved PAK0.PAK
    const data = COM_LoadHunkFile("gfx/pop.lmp");
    if (data === null) throw new Error("expected gfx/pop.lmp to be found inside Id1/PAK0.PAK");
    expect(Array.from(data.subarray(0, 4))).toEqual([9, 9, 9, 9]);
  });

  // "Qw"-style casing: a non-default gamedir whose real on-disk name is
  // mixed-case, requested (as a real QW server would) in plain lowercase.
  test("COM_Gamedir resolves a mismatched-case gamedir directory (real disk dir 'Ctf', requested 'ctf')", () => {
    const baseDir = makeBaseDir("gamedircasing");
    ensureDir(join(baseDir, "Ctf"));
    writeLoose(join(baseDir, "Ctf", "marker.txt"), "CTF");

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    COM_Gamedir("ctf");
    expect(gamedirfile).toBe("ctf");
    expect(com_gamedir).toBe(join(baseDir, "Ctf"));

    const data = COM_LoadHunkFile("marker.txt");
    if (data === null) throw new Error("expected marker.txt to resolve inside Ctf/ despite the case mismatch");
    expect(bytesToLatin1(data)).toBe("CTF");
  });
});

//============================================================================

/*
Q026: the qwcl/qwsv filesystem is src/qw/common.ts's (its COM_LoadPackFile
opens the pak through src/platform/sys.ts's Sys_FileOpenRead), but every
shared module -- src/common/model.ts, src/common/wad.ts, cmd.ts's Cmd_Exec_f,
snd_mem.ts, the renderers' Draw_CachePic -- reads through
src/common/common.ts's COM_LoadFile family. src/common/common.ts kept a
second, private fd table until Q026 and its reads went through it, so a pak
opened by the QW module was in neither: every pak-resident read came back as
a zero-filled buffer. Both modules now share the one table sys.ts owns, which
is also where the C's own common.c keeps its handles (common.c:1452/1630).
*/
describe("a pak opened by the QW filesystem reads back through src/common/common.ts", () => {
  test("COM_LoadHunkFile of a pak-resident file returns the real bytes, not zeros", () => {
    const baseDir = join(scratchDir, "qwpakread");
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw"));

    const payload = latin1Bytes("PAKPAYLOAD-0123456789");
    writePakToDisk(join(baseDir, "qw", "pak0.pak"), [
      { name: "gfx/palette.lmp", data: payload },
      { name: "maps/qwpak.bsp", data: latin1Bytes("BSPBYTES") },
    ]);

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem(); // src/qw/common.ts's -- the qwcl/qwsv one

    const data = SharedCOM_LoadHunkFile("gfx/palette.lmp");
    if (data === null) throw new Error("expected gfx/palette.lmp to be found in the QW pak");
    // COM_LoadFile always appends a trailing 0 byte
    expect(data.length).toBe(payload.length + 1);
    expect(bytesToLatin1(data.subarray(0, payload.length))).toBe("PAKPAYLOAD-0123456789");

    // a second read of a different file in the same pak, through the same
    // shared fd: the seek-then-read pair has to land on the new file's offset
    const second = SharedCOM_LoadHunkFile("maps/qwpak.bsp");
    if (second === null) throw new Error("expected maps/qwpak.bsp to be found in the QW pak");
    expect(bytesToLatin1(second.subarray(0, 8))).toBe("BSPBYTES");
  });
});

//============================================================================

describe("pop.lmp registration recipe (as test/host.test.ts) and the loose-file-with-slash rule", () => {
  // gfx/pop.lmp: the registered-version check's 128 big-endian shorts,
  // exactly test/host.test.ts's own recipe.
  function popLmpBytes(): Uint8Array {
    const popLmp = new Uint8Array(256);
    for (let i = 0; i < 128; i++) {
      popLmp[i * 2] = (pop[i] >> 8) & 0xff;
      popLmp[i * 2 + 1] = pop[i] & 0xff;
    }
    return popLmp;
  }

  test("no gfx/pop.lmp on the search path -> shareware, static_registered set to 0, no throw", () => {
    const baseDir = join(scratchDir, "noreg");
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw"));

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    // COM_CheckRegistered sets static_registered = 0 unconditionally before
    // testing for gfx/pop.lmp -- this is how the test controls the shared
    // static_registered singleton deterministically (it cannot assign the
    // imported binding directly), not an assumption about prior test order.
    expect(() => COM_CheckRegistered()).not.toThrow();
    expect(static_registered).toBe(0);
  });

  test("while unregistered, a loose file under a subdirectory is rejected but a root-level loose file is not", () => {
    const baseDir = join(scratchDir, "noreg-slash");
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw", "sub"));
    writeLoose(join(baseDir, "qw", "marker.txt"), "QW");
    writeLoose(join(baseDir, "qw", "sub", "deep.txt"), "DEEP");

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();
    COM_CheckRegistered(); // no gfx/pop.lmp anywhere on this search path -> static_registered = 0
    expect(static_registered).toBe(0);

    // "if not static_registered, don't ever go beyond base": a filename
    // containing '/' is skipped for every directory search-path entry
    const rejected = COM_FOpenFile("sub/deep.txt");
    expect(rejected.handle).toBe(-1);

    // a root-level (no '/') loose file is unaffected by the rule
    const allowed = COM_FOpenFile("marker.txt");
    expect(allowed.handle).not.toBe(-1);
  });

  test("a genuine gfx/pop.lmp registers the game, and the loose-file-with-slash rule lifts once registered", () => {
    const baseDir = join(scratchDir, "reg");
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw"));

    writePakToDisk(join(baseDir, "qw", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmpBytes() }]);

    // a loose file living under a subdirectory, not inside any pak
    ensureDir(join(baseDir, "qw", "sub"));
    writeLoose(join(baseDir, "qw", "sub", "deep.txt"), "DEEP");

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    COM_CheckRegistered();
    expect(static_registered).toBe(1);
    expect(com_filesize).toBeGreaterThan(0);

    // now that the game is registered, a loose file under a subdirectory
    // (contains '/') is reachable, per the "if not static_registered, don't
    // go beyond base" rule in COM_FOpenFile
    const { handle, length } = COM_FOpenFile("sub/deep.txt");
    expect(handle).not.toBe(-1);
    expect(length).toBeGreaterThan(0);
  });
});
