/*
Self-sufficient test for Sys_ResolveCase (src/platform/sys.ts) and its use in
WinQuake's COM_InitFilesystem/COM_AddGameDirectory (src/common/common.ts).

id Software's own Quake distribution ships the game directory as `Id1` with
`PAK0.PAK`/`PAK1.PAK` (see src/common/common.ts's COM_AddGameDirectory
comment); the C built `%s/id1` and `pak%i.pak` lowercase and relied on
DOS/Windows case-insensitivity. Sys_ResolveCase is the general resolver that
replaces the removed COM_PakFileName stop-gap. Its own unit cases (exact
match, one-level mismatch, two-level mismatch, no match) are independent of
any Quake state; the COM_InitFilesystem case below proves the real call
site (COM_AddGameDirectory resolving `${basedir}/id1` against a real `Id1`
directory, and each pak%i.pak lookup against `PAK%i.PAK`) end to end.

Per standing order 13, this file initializes the globals it reads
(COM_InitArgv/COM_InitFilesystem) rather than relying on another test file's
run, and does not reset com_searchpaths itself -- like test/common.test.ts's
own suite (whose precedent this follows), every scratch directory below is
uniquely named per test and only positive "the file we just wrote is found"
assertions are made, so an earlier-run file's leftover search-path entries
underneath cannot affect the result.
*/

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Sys_ResolveCase } from "../src/platform/sys";
import { COM_InitArgv, COM_InitFilesystem, COM_LoadHunkFile, com_gamedir } from "../src/common/common";
import { writePakToDisk, ensureDir } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "fs-case-test-"));

//============================================================================

describe("Sys_ResolveCase", () => {
  test("exact path already exists: returned unchanged", () => {
    const dir = join(scratchDir, "exact");
    ensureDir(dir);
    const filePath = join(dir, "file.txt");
    writeFileSync(filePath, "x");

    expect(Sys_ResolveCase(filePath)).toBe(filePath);
    expect(Sys_ResolveCase(dir)).toBe(dir);
  });

  test("one-level mismatch: a single path component's case differs from the real entry", () => {
    const parent = join(scratchDir, "onelevel");
    ensureDir(join(parent, "Foo"));

    const requested = join(parent, "foo");
    expect(Sys_ResolveCase(requested)).toBe(join(parent, "Foo"));
  });

  test("two-level mismatch: two path components both differ in case from the real entries", () => {
    const parent = join(scratchDir, "twolevel");
    ensureDir(join(parent, "Foo", "Bar"));
    writeFileSync(join(parent, "Foo", "Bar", "Baz.txt"), "y");

    const requested = join(parent, "foo", "bar", "baz.txt");
    expect(Sys_ResolveCase(requested)).toBe(join(parent, "Foo", "Bar", "Baz.txt"));
  });

  test("no match at some level: the original path is returned unchanged", () => {
    const parent = join(scratchDir, "nomatch");
    ensureDir(parent);

    const requested = join(parent, "doesnotexist", "nested.txt");
    expect(Sys_ResolveCase(requested)).toBe(requested);
  });
});

//============================================================================

describe("COM_InitFilesystem resolves id Software's own mixed-case distribution (WinQuake)", () => {
  test("-basedir <scratch> with Id1/PAK0.PAK finds gfx/pop.lmp, com_gamedir ends with /Id1", () => {
    const baseDir = join(scratchDir, "realdist");
    ensureDir(join(baseDir, "Id1"));
    writePakToDisk(join(baseDir, "Id1", "PAK0.PAK"), [{ name: "gfx/pop.lmp", data: new Uint8Array([1, 2, 3, 4]) }]);

    COM_InitArgv(["quake", "-basedir", baseDir]);
    COM_InitFilesystem();

    expect(com_gamedir).toBe(join(baseDir, "Id1"));
    expect(com_gamedir.endsWith("/Id1")).toBe(true);

    const data = COM_LoadHunkFile("gfx/pop.lmp");
    if (data === null) throw new Error("expected gfx/pop.lmp to be found inside Id1/PAK0.PAK");
    expect(Array.from(data.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });
});
