/*
Self-sufficient test for src/platform/sys.ts (WinQuake sys.h/sys_linux.c).

Uses a scratch directory under the harness's scratchpad (never /tmp
directly) for all file I/O so this suite doesn't collide with anything else
on the filesystem and needs no cleanup step for CI to stay clean.
*/

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import {
  SysError,
  Sys_Error,
  Sys_FloatTime,
  Sys_FileOpenRead,
  Sys_FileOpenWrite,
  Sys_FileClose,
  Sys_FileSeek,
  Sys_FileRead,
  Sys_FileWrite,
  Sys_FileTime,
  Sys_mkdir,
} from "../src/platform/sys";

const SCRATCH = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/sys-test`;

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true });
});

describe("Sys_FileOpenWrite / Sys_FileWrite / Sys_FileClose / Sys_FileOpenRead / Sys_FileRead / Sys_FileSeek", () => {
  test("round-trips bytes written through a fresh file", () => {
    const path = `${SCRATCH}/roundtrip.bin`;
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const wHandle = Sys_FileOpenWrite(path);
    expect(wHandle).toBeGreaterThanOrEqual(0);

    const written = Sys_FileWrite(wHandle, payload, payload.length);
    expect(written).toBe(payload.length);
    Sys_FileClose(wHandle);

    const { handle: rHandle, length } = Sys_FileOpenRead(path);
    expect(rHandle).toBeGreaterThanOrEqual(0);
    expect(length).toBe(payload.length);

    const dest = new Uint8Array(payload.length);
    const readCount = Sys_FileRead(rHandle, dest, payload.length);
    expect(readCount).toBe(payload.length);
    expect(Array.from(dest)).toEqual(Array.from(payload));

    // Seek back to the start and re-read the first 4 bytes.
    Sys_FileSeek(rHandle, 0);
    const dest2 = new Uint8Array(4);
    const readCount2 = Sys_FileRead(rHandle, dest2, 4);
    expect(readCount2).toBe(4);
    expect(Array.from(dest2)).toEqual([1, 2, 3, 4]);

    // Seek to the middle and read the tail.
    Sys_FileSeek(rHandle, 4);
    const dest3 = new Uint8Array(4);
    const readCount3 = Sys_FileRead(rHandle, dest3, 4);
    expect(readCount3).toBe(4);
    expect(Array.from(dest3)).toEqual([5, 6, 7, 8]);

    Sys_FileClose(rHandle);
  });

  test("Sys_FileOpenRead returns handle -1 and length -1 for a missing file", () => {
    const { handle, length } = Sys_FileOpenRead(`${SCRATCH}/does-not-exist.bin`);
    expect(handle).toBe(-1);
    expect(length).toBe(-1);
  });

  test("Sys_FileOpenWrite truncates an existing file", () => {
    const path = `${SCRATCH}/truncate.bin`;

    const h1 = Sys_FileOpenWrite(path);
    Sys_FileWrite(h1, new Uint8Array([9, 9, 9, 9, 9]), 5);
    Sys_FileClose(h1);

    const h2 = Sys_FileOpenWrite(path);
    Sys_FileWrite(h2, new Uint8Array([1, 2]), 2);
    Sys_FileClose(h2);

    const { handle, length } = Sys_FileOpenRead(path);
    expect(length).toBe(2);
    Sys_FileClose(handle);
  });
});

describe("Sys_FileTime", () => {
  test("returns -1 for a missing file", () => {
    expect(Sys_FileTime(`${SCRATCH}/never-created.bin`)).toBe(-1);
  });

  test("returns a mtime in whole seconds for an existing file", () => {
    const path = `${SCRATCH}/timed.bin`;
    const h = Sys_FileOpenWrite(path);
    Sys_FileWrite(h, new Uint8Array([1]), 1);
    Sys_FileClose(h);

    const t = Sys_FileTime(path);
    expect(t).toBeGreaterThan(0);
    expect(Number.isInteger(t)).toBe(true);

    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Math.abs(nowSeconds - t)).toBeLessThan(30);
  });
});

describe("Sys_mkdir", () => {
  test("creates a new directory", () => {
    const dir = `${SCRATCH}/newdir`;
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);

    Sys_mkdir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  test("is idempotent -- a second call on the same path does not throw", () => {
    const dir = `${SCRATCH}/idempotent-dir`;
    Sys_mkdir(dir);
    expect(existsSync(dir)).toBe(true);

    expect(() => Sys_mkdir(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("Sys_FloatTime", () => {
  test("is monotonic across successive calls", () => {
    const a = Sys_FloatTime();
    const b = Sys_FloatTime();
    const c = Sys_FloatTime();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });

  test("returns seconds as a small double, not milliseconds", () => {
    const a = Sys_FloatTime();
    // Any process that has been running less than a day easily satisfies
    // this; it's here to catch an accidental ms-instead-of-s regression.
    expect(a).toBeLessThan(86400);
    expect(a).toBeGreaterThanOrEqual(0);
  });
});

describe("Sys_Error", () => {
  test("throws SysError with the formatted message", () => {
    let caught: unknown;
    try {
      Sys_Error("bad thing: %s (%i)", "oops", 42);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SysError);
    expect(caught instanceof SysError && caught.message).toBe("bad thing: oops (42)");
  });
});

/*
Sys_ConsoleInput's stdin reader starts lazily, on the first call with
sysState.isDedicated set -- so the reader is armed long after the process
started, and .orch/e2e/E.md's "Limitations" claimed that anything piped in
before Sys_Init is therefore lost. It is not: sys_linux.c's own `read(0,
text, sizeof(text))` sees whatever the pipe has buffered whenever it first
runs, and so does the lazily-started reader here -- nothing in the port
drains fd 0 before it. This is that claim's regression test: a child writes
NOTHING until it has waited past the point a real boot would have printed its
banner, the parent has already written a full line, and the line still comes
back out of the first Sys_ConsoleInput.

A child process, not an in-process test: Bun.stdin.stream() can be taken only
once per process, and taking it in a suite would swallow the runner's own
stdin.
*/
describe("Sys_ConsoleInput -- a line piped in before the reader starts", () => {
  test("is still delivered by the first call, not dropped", async () => {
    const sysPath = new URL("../src/platform/sys.ts", import.meta.url).pathname;
    const child = `
      const { Sys_ConsoleInput, sysState } = await import(${JSON.stringify(sysPath)});
      sysState.isDedicated = true;
      // stand in for everything a real boot does before Host_Frame's first
      // Sys_ConsoleInput call: the writer's line is sitting in the pipe the
      // whole time, and nothing here has read fd 0 yet.
      await Bun.sleep(400);
      for (let i = 0; i < 60; i++) {
        const line = Sys_ConsoleInput();
        if (line !== null) { console.log("GOT:" + line); process.exit(0); }
        await Bun.sleep(25);
      }
      console.log("GOT:<nothing>");
      process.exit(1);
    `;

    const proc = Bun.spawn(["bun", "-e", child], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // written before the child has produced a single byte of output
    proc.stdin.write("status\n");
    proc.stdin.flush();

    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;

    expect(`${out}${err}`).toContain("GOT:status");
  }, 20000);
});
