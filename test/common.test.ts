import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Q_atoi,
  Q_atof,
  Q_strcasecmp,
  Q_strncasecmp,
  BigShort,
  LittleShort,
  BigLong,
  LittleLong,
  BigFloat,
  LittleFloat,
  COM_Parse,
  type ParseState,
  COM_CheckParm,
  COM_InitArgv,
  com_argc,
  com_argv,
  COM_SkipPath,
  COM_StripExtension,
  COM_FileExtension,
  COM_FileBase,
  COM_DefaultExtension,
  COM_InitFilesystem,
  COM_LoadHunkFile,
  COM_LoadTempFile,
  COM_OpenFile,
  COM_CloseFile,
  COM_CheckRegistered,
  com_filesize,
  com_modified,
  com_searchpaths,
  static_registered,
  setComModified,
  setComSearchpaths,
  setStaticRegistered,
  va,
} from "../src/common/common";
import { buildPak, writePakToDisk, ensureDir } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "common-test-"));

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break; // COM_LoadFile's trailing NUL
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

//============================================================================

describe("Q_atoi", () => {
  test("hex literal", () => {
    expect(Q_atoi("0x1F")).toBe(31);
    expect(Q_atoi("0X1f")).toBe(31);
    expect(Q_atoi("-0x10")).toBe(-16);
  });

  test("single-quoted character literal", () => {
    expect(Q_atoi("'a'")).toBe(97);
    expect(Q_atoi("'Z'")).toBe(90);
  });

  test("decimal, stopping at the first bad character", () => {
    expect(Q_atoi("12abc")).toBe(12);
    expect(Q_atoi("-3.5e")).toBe(-3); // '.' is not a digit; Q_atoi has no decimal handling
  });

  test("leading whitespace is NOT skipped (unlike Number())", () => {
    expect(Q_atoi(" 7")).toBe(0);
    expect(Number(" 7")).toBe(7); // documents the divergence from JS's own parser
  });

  test("plain decimal and sign", () => {
    expect(Q_atoi("42")).toBe(42);
    expect(Q_atoi("-42")).toBe(-42);
    expect(Q_atoi("0")).toBe(0);
  });
});

describe("Q_atof", () => {
  test("hex literal (no fractional part)", () => {
    expect(Q_atof("0x1F")).toBe(31);
  });

  test("single-quoted character literal", () => {
    expect(Q_atof("'a'")).toBe(97);
  });

  test("decimal, stopping at the first bad character", () => {
    expect(Q_atof("12abc")).toBe(12);
  });

  test("fractional values and a trailing bad character", () => {
    expect(Q_atof("-3.5e")).toBeCloseTo(-3.5, 10);
    expect(Q_atof("3.25")).toBeCloseTo(3.25, 10);
    expect(Q_atof("100.0")).toBeCloseTo(100, 10);
  });

  test("leading whitespace is NOT skipped", () => {
    expect(Q_atof(" 7")).toBe(0);
  });
});

describe("Q_strcasecmp / Q_strncasecmp", () => {
  test("case-insensitive equality", () => {
    expect(Q_strcasecmp("ABC", "abc")).toBe(0);
    expect(Q_strcasecmp("Quake", "QUAKE")).toBe(0);
  });

  test("never returns +1 -- ported bit-for-bit as an equality test", () => {
    expect(Q_strcasecmp("abd", "abc")).toBe(-1);
    expect(Q_strcasecmp("abc", "abd")).toBe(-1);
    expect(Q_strcasecmp("zzz", "aaa")).toBe(-1);
  });

  test("Q_strncasecmp respects the count", () => {
    expect(Q_strncasecmp("abcXXX", "abcYYY", 3)).toBe(0);
    expect(Q_strncasecmp("abcXXX", "abdYYY", 3)).toBe(-1);
    expect(Q_strncasecmp("ab", "ab", 0)).toBe(0);
  });
});

describe("byte order (little-endian fixed)", () => {
  test("LittleX is the identity", () => {
    expect(LittleShort(0x1234)).toBe(0x1234);
    expect(LittleLong(0x12345678)).toBe(0x12345678);
    expect(LittleFloat(3.5)).toBe(3.5);
  });

  test("BigShort swaps the two bytes", () => {
    expect(BigShort(0x1234)).toBe(0x3412);
    expect(BigShort(BigShort(0x1234))).toBe(0x1234);
  });

  test("BigLong swaps all four bytes", () => {
    expect(BigLong(0x12345678) >>> 0).toBe(0x78563412);
    expect(BigLong(BigLong(0x12345678))).toBe(0x12345678);
  });

  test("BigFloat is a byte-order reversal, self-inverse", () => {
    expect(BigFloat(BigFloat(3.5))).toBeCloseTo(3.5, 6);
  });
});

describe("COM_Parse", () => {
  test("returns null at end of data", () => {
    const ps: ParseState = { data: "", index: 0 };
    expect(COM_Parse(ps)).toBeNull();
  });

  test("returns null when only whitespace remains", () => {
    const ps: ParseState = { data: "   \t\n  ", index: 0 };
    expect(COM_Parse(ps)).toBeNull();
  });

  test("parses a plain word", () => {
    const ps: ParseState = { data: "foo bar", index: 0 };
    expect(COM_Parse(ps)).toBe("foo");
    expect(COM_Parse(ps)).toBe("bar");
    expect(COM_Parse(ps)).toBeNull();
  });

  test("parses a quoted string, including embedded spaces", () => {
    const ps: ParseState = { data: '"hello there" next', index: 0 };
    expect(COM_Parse(ps)).toBe("hello there");
    expect(COM_Parse(ps)).toBe("next");
  });

  test("an unterminated quoted string reads to end of data", () => {
    const ps: ParseState = { data: '"unterminated', index: 0 };
    expect(COM_Parse(ps)).toBe("unterminated");
    expect(COM_Parse(ps)).toBeNull();
  });

  test("skips // comments through end of line", () => {
    const ps: ParseState = { data: "// this is ignored\nreal_token", index: 0 };
    expect(COM_Parse(ps)).toBe("real_token");
  });

  test("single-character tokens: { } ( ) ' :", () => {
    const ps: ParseState = { data: "{ } ( ) ' :", index: 0 };
    expect(COM_Parse(ps)).toBe("{");
    expect(COM_Parse(ps)).toBe("}");
    expect(COM_Parse(ps)).toBe("(");
    expect(COM_Parse(ps)).toBe(")");
    expect(COM_Parse(ps)).toBe("'");
    expect(COM_Parse(ps)).toBe(":");
    expect(COM_Parse(ps)).toBeNull();
  });

  test("a single-character token immediately ends a preceding word", () => {
    const ps: ParseState = { data: "origin(1 2 3)", index: 0 };
    expect(COM_Parse(ps)).toBe("origin");
    expect(COM_Parse(ps)).toBe("(");
    expect(COM_Parse(ps)).toBe("1");
  });
});

describe("COM_SkipPath / COM_StripExtension / COM_FileExtension / COM_FileBase / COM_DefaultExtension", () => {
  test("COM_SkipPath", () => {
    expect(COM_SkipPath("maps/e1m1.bsp")).toBe("e1m1.bsp");
    expect(COM_SkipPath("noslash.txt")).toBe("noslash.txt");
    expect(COM_SkipPath("a/b/c")).toBe("c");
  });

  test("COM_StripExtension stops at the FIRST '.' found scanning forward", () => {
    expect(COM_StripExtension("maps/e1m1.bsp")).toBe("maps/e1m1");
    expect(COM_StripExtension("noext")).toBe("noext");
    // a dot in an earlier path segment truncates everything after it --
    // this is the C's forward scan, not "strip the real extension"
    expect(COM_StripExtension("a.b/c.txt")).toBe("a");
  });

  test("COM_FileExtension", () => {
    expect(COM_FileExtension("maps/e1m1.bsp")).toBe("bsp");
    expect(COM_FileExtension("noext")).toBe("");
    expect(COM_FileExtension("a.verylongextension")).toBe("verylon"); // max 7 chars
  });

  test("COM_FileBase: typical model/map paths", () => {
    expect(COM_FileBase("maps/e1m1.bsp")).toBe("e1m1");
    expect(COM_FileBase("progs/knight.mdl")).toBe("knight");
    expect(COM_FileBase("ab.c")).toBe("ab");
  });

  test("COM_FileBase: pathological inputs fall back to \"?model?\"", () => {
    expect(COM_FileBase("noext")).toBe("?model?");
    expect(COM_FileBase("a")).toBe("?model?");
  });

  test("COM_DefaultExtension appends only when the last path segment has no dot", () => {
    expect(COM_DefaultExtension("config", ".cfg")).toBe("config.cfg");
    expect(COM_DefaultExtension("config.cfg", ".cfg")).toBe("config.cfg");
    // a dot in an earlier directory segment doesn't count -- the C scan
    // stops at the preceding '/'
    expect(COM_DefaultExtension("a/b.c/config", ".cfg")).toBe("a/b.c/config.cfg");
  });
});

describe("COM_CheckParm / COM_InitArgv / va", () => {
  test("COM_CheckParm finds the 1-based argv index, 0 if absent", () => {
    COM_InitArgv(["quake", "-foo", "bar", "-game", "rogue"]);
    expect(COM_CheckParm("-foo")).toBe(1);
    expect(COM_CheckParm("-game")).toBe(3);
    expect(COM_CheckParm("-nonexistent")).toBe(0);
  });

  test("va formats like Com_sprintf", () => {
    expect(va("%s/%s", "id1", "pak0.pak")).toBe("id1/pak0.pak");
    expect(va("%i files", 5)).toBe("5 files");
  });
});

// F.md D4: a command line with more than ~50 `+`/`-` tokens appeared to
// "hang the process". WinQuake's own COM_InitArgv (common.c:1057, read in
// full against ../qsrc/quake/WinQuake/common.c) drops
// argv entries past MAX_NUM_ARGVS (50, including argv[0], the program name)
// silently, exactly as this port's COM_InitArgv does below -- confirmed by
// direct comparison, line for line. COM_InitArgv itself cannot hang (every
// loop here is bounded by MAX_NUM_ARGVS/CMDLINE_LENGTH and argc, both finite);
// the per-test timeout below is a regression guard, not evidence this one
// ever needed it. What actually happened in the e2e report: enough `+echo`/
// `+alias` tokens push a trailing `+quit` past the 50-token cutoff, so it
// gets silently dropped along with everything after it -- the dedicated
// server then legitimately keeps running (waiting for connections, low CPU,
// no `+quit` ever having arrived) instead of exiting, which is the same
// thing the original engine would do given the identical command line, not
// an infinite loop in this function.
describe("COM_InitArgv argv truncation at MAX_NUM_ARGVS=50 (D4)", () => {
  test("49 total tokens (including argv[0]): none dropped", () => {
    const argv = ["quake", ...Array.from({ length: 48 }, (_, i) => `arg${i}`)];
    COM_InitArgv(argv);
    expect(com_argc).toBe(49);
    expect(com_argv[48]).toBe("arg47"); // last real token survives
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
    expect(com_argv[49]).toBe("arg48"); // "+quit" (index 50) never made it in
    expect(com_argv.slice(0, com_argc)).not.toContain("+quit");
  }, 2000);

  test("70 total tokens (F.md's repro scale): truncated to 50, no hang", () => {
    const argv = ["quake", ...Array.from({ length: 68 }, (_, i) => `+echo${i}`), "+quit"];
    COM_InitArgv(argv);
    expect(com_argc).toBe(50);
    expect(com_argv.slice(0, com_argc)).not.toContain("+quit");
  }, 2000);
});

//============================================================================
// filesystem / PAK tests

describe("filesystem: synthetic paks", () => {
  // com_modified is sticky module state that only -game/-path (never
  // -basedir) sets, and once true it never resets on its own; every other
  // test in this describe block uses -path (or a synthetic pak0.pak whose
  // file count differs from PAK0_COUNT, which COM_LoadPackFile itself flags
  // as modified). `bun test` runs every file in one process, so some other
  // suite -- in this file or another one entirely -- may have already left
  // com_modified true by the time this test runs, depending on which
  // suites are present in a given run (this test used to rely on running
  // first in this describe block to see it still false, which does not
  // hold across every subset of suites CI can run). COM_CheckRegistered
  // throws when com_modified is true and no gfx/pop.lmp is found, which is
  // not what this test is about, so set up the precondition explicitly
  // instead of assuming it, and restore both flags afterward.
  test("COM_CheckRegistered: no gfx/pop.lmp on the search path -> shareware, no throw", () => {
    const baseDir = join(scratchDir, "noregistered");
    ensureDir(join(baseDir, "id1")); // no pak0.pak, no gfx/pop.lmp

    // COM_InitFilesystem's -basedir branch only PREPENDS a search path node
    // (unlike -path, which resets com_searchpaths to null first); some other
    // suite in this shared bun test process may have left a real,
    // checksum-valid gfx/pop.lmp reachable further back on the chain, which
    // would make COM_OpenFile below find it and defeat the "no gfx/pop.lmp
    // on the search path" this test is named for. Reset com_searchpaths (and
    // com_modified) to a known-empty state first, and restore both after.
    const savedModified = com_modified;
    const savedRegistered = static_registered;
    const savedSearchpaths = com_searchpaths;
    setComModified(false);
    setComSearchpaths(null);
    try {
      COM_InitArgv(["quake", "-basedir", baseDir]);
      COM_InitFilesystem();

      expect(() => COM_CheckRegistered()).not.toThrow();
      expect(static_registered).toBe(0);
    } finally {
      setComModified(savedModified);
      setStaticRegistered(savedRegistered);
      setComSearchpaths(savedSearchpaths);
    }
  });

  test("COM_LoadFile finds a file inside a synthetic pak, sets com_filesize", () => {
    const pakPath = join(scratchDir, "testA.pak");
    writePakToDisk(pakPath, [{ name: "gfx/uniqueA.lmp", data: new Uint8Array([1, 2, 3, 4, 5]) }]);

    COM_InitArgv(["quake", "-path", pakPath]);
    COM_InitFilesystem();

    const data = COM_LoadHunkFile("gfx/uniqueA.lmp");
    if (data === null) throw new Error("expected gfx/uniqueA.lmp to be found");

    expect(data.length).toBe(6); // 5 bytes + trailing NUL
    expect(Array.from(data.subarray(0, 5))).toEqual([1, 2, 3, 4, 5]);
    expect(data[5]).toBe(0);
    expect(com_filesize).toBe(5);
  });

  test("COM_OpenFile / COM_FindFile: not found returns handle -1 and com_filesize -1", () => {
    const pakPath = join(scratchDir, "testB.pak");
    writePakToDisk(pakPath, [{ name: "gfx/onlyone.lmp", data: new Uint8Array([9]) }]);

    COM_InitArgv(["quake", "-path", pakPath]);
    COM_InitFilesystem();

    const { handle, length } = COM_OpenFile("does/not/exist.xyz");
    expect(handle).toBe(-1);
    expect(length).toBe(-1);
    expect(com_filesize).toBe(-1);
  });

  test("a loose file is shadowed by a pak searched earlier (last -path entry wins)", () => {
    const looseDir = join(scratchDir, "loosedir");
    ensureDir(join(looseDir, "data"));
    writeLoose(join(looseDir, "data", "shadow.txt"), "LOOSE");

    const pakPath = join(scratchDir, "shadow.pak");
    writePakToDisk(pakPath, [{ name: "data/shadow.txt", data: latin1Bytes("PAK") }]);

    // -path prepends each entry as it's processed, so the LAST argv entry
    // ends up at the head of com_searchpaths and is searched FIRST, exactly
    // as COM_InitFilesystem's C source does.
    COM_InitArgv(["quake", "-path", looseDir, pakPath]);
    COM_InitFilesystem();

    const data = COM_LoadTempFile("data/shadow.txt");
    if (data === null) throw new Error("expected data/shadow.txt to be found");
    expect(bytesToLatin1(data)).toBe("PAK");
  });

  test("COM_InitFilesystem with -basedir pointing at a scratch dir containing id1/pak0.pak", () => {
    const baseDir = join(scratchDir, "basedirtest");
    ensureDir(join(baseDir, "id1"));
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "maps/uniqueE.bsp", data: latin1Bytes("BSPDATA") }]);

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    const data = COM_LoadTempFile("maps/uniqueE.bsp");
    if (data === null) throw new Error("expected maps/uniqueE.bsp to be found via -basedir/id1/pak0.pak");
    expect(bytesToLatin1(data)).toBe("BSPDATA");
  });

  test("COM_CloseFile on a pak-shared handle does not throw", () => {
    const pakPath = join(scratchDir, "testC.pak");
    writePakToDisk(pakPath, [{ name: "sound/test.wav", data: new Uint8Array([1, 2]) }]);

    COM_InitArgv(["quake", "-path", pakPath]);
    COM_InitFilesystem();

    const { handle } = COM_OpenFile("sound/test.wav");
    expect(handle).not.toBe(-1);
    expect(() => COM_CloseFile(handle)).not.toThrow();
  });
});

describe("buildPak sanity", () => {
  test("directory entries carry the right filepos/filelen", () => {
    const built = buildPak([
      { name: "a.txt", data: new Uint8Array([1, 2, 3]) },
      { name: "b.txt", data: new Uint8Array([4, 5]) },
    ]);
    expect(built.entries[0]).toEqual({ name: "a.txt", filepos: 12, filelen: 3 });
    expect(built.entries[1]).toEqual({ name: "b.txt", filepos: 15, filelen: 2 });
    expect(String.fromCharCode(built.bytes[0], built.bytes[1], built.bytes[2], built.bytes[3])).toBe("PACK");
  });
});

//============================================================================

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function writeLoose(path: string, content: string): void {
  writeFileSync(path, latin1Bytes(content));
}
