/*
Self-sufficient test for src/common/zone.ts (WinQuake zone.h/zone.c).

zone.ts reaches Cmd_AddCommand (./cmd, U004) from inside Cache_Init and
COM_CheckParm/com_argv (./common, U003) from inside Memory_Init, both lazily
via `require()` (see zone.ts's file header): neither is a static top-level
import, so zone.ts itself loads at runtime whether or not those siblings are
present. This suite only exercises functions that never call Cache_Init or
Memory_Init (Z_Malloc, Hunk_Alloc/AllocName, Hunk_LowMark, Cache_Alloc/
Check/Free/Flush), so it needs no mock.module stand-in for either sibling and
never depends on load order or another test file having run first.
*/

import { describe, expect, test } from "bun:test";
import { SysError } from "../src/platform/sys";
import {
  CacheUser,
  Cache_Alloc,
  Cache_Check,
  Cache_Flush,
  Cache_Free,
  Hunk_Alloc,
  Hunk_AllocName,
  Hunk_LowMark,
  Z_Malloc,
} from "../src/common/zone";

describe("Hunk_AllocName", () => {
  test("returns a zeroed buffer of exactly the requested size; the C's 16-byte rounding lives only in the mark counters", () => {
    const before = Hunk_LowMark();
    const buf = Hunk_AllocName(10, "test");
    expect(buf.length).toBe(10);
    expect(Array.from(buf)).toEqual(new Array(10).fill(0));
    expect(Hunk_LowMark() - before).toBe(16); // (10+15) & ~15 == 16
  });

  test("size already a multiple of 16 is unchanged", () => {
    const buf = Hunk_AllocName(32, "test");
    expect(buf.length).toBe(32);
  });
});


describe("Z_Malloc", () => {
  test("returns a zero-filled buffer of the requested size", () => {
    const buf = Z_Malloc(24);
    expect(buf.length).toBe(24);
    expect(Array.from(buf)).toEqual(new Array(24).fill(0));
  });
});

describe("Cache_Alloc / Cache_Check", () => {
  test("Cache_Alloc stores the object and Cache_Check returns the same one", () => {
    const c = new CacheUser<{ tag: string }>();
    const obj = { tag: "loaded" };

    const result = Cache_Alloc(c, 16, "test_cache", obj);

    expect(result).toBe(obj);
    expect(Cache_Check(c)).toBe(obj);
  });

  test("Cache_Alloc on an already-allocated user throws SysError with the C's message", () => {
    const c = new CacheUser<{ tag: string }>();
    Cache_Alloc(c, 16, "first", { tag: "first" });

    expect(() => Cache_Alloc(c, 16, "second", { tag: "second" })).toThrow(SysError);
    expect(() => Cache_Alloc(c, 16, "second", { tag: "second" })).toThrow(
      "Cache_Alloc: allready allocated",
    );
  });

  test("Cache_Alloc with size <= 0 throws SysError with the C's message", () => {
    const c = new CacheUser<{ tag: string }>();
    expect(() => Cache_Alloc(c, 0, "bad", { tag: "bad" })).toThrow(SysError);
    expect(() => Cache_Alloc(c, 0, "bad", { tag: "bad" })).toThrow("Cache_Alloc: size 0");
  });
});

describe("Cache_Free", () => {
  test("nulls data; Cache_Check then returns null", () => {
    const c = new CacheUser<{ tag: string }>();
    Cache_Alloc(c, 16, "test_free", { tag: "loaded" });

    Cache_Free(c);

    expect(Cache_Check(c)).toBeNull();
  });

  test("throws SysError with the C's message when already unallocated", () => {
    const c = new CacheUser<{ tag: string }>();
    expect(() => Cache_Free(c)).toThrow(SysError);
    expect(() => Cache_Free(c)).toThrow("Cache_Free: not allocated");
  });
});

describe("Cache_Flush", () => {
  test("nulls every registered user at once, the console \"flush\" command's observable effect", () => {
    const a = new CacheUser<{ tag: string }>();
    const b = new CacheUser<{ tag: string }>();
    Cache_Alloc(a, 16, "a", { tag: "a" });
    Cache_Alloc(b, 16, "b", { tag: "b" });

    Cache_Flush();

    expect(Cache_Check(a)).toBeNull();
    expect(Cache_Check(b)).toBeNull();
    // reload works normally afterward, exactly what the C's demand-cache
    // behaviour depends on
    const reloaded = Cache_Alloc(a, 16, "a", { tag: "reloaded" });
    expect(Cache_Check(a)).toBe(reloaded);
  });
});
