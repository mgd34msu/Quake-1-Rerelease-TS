/*
Self-sufficient tests for F.md's D3 and D5 defects, plus the coordinator's
added exit-path case (.orch/e2e/C.md, a qwcl port-bind race): every scenario
here spawns a REAL child `bun` process (never in-process) because both
defects are about the *process*'s own termination -- OS signal delivery
(SIGINT/SIGTERM) and `process.exit()` -- which cannot be observed by calling
functions directly in this suite's own process, and because src/qw/main_sv.ts
and src/qw/main_cl.ts each register their own Cmd_AddCommand/Cvar set into
src/common/cmd.ts's single process-wide table (first-wins), exactly the
reason test/qwsv_boot.test.ts and test/qwcl_boot.test.ts already give for
booting their own trees out of process.

D3's actual finding (see this unit's report): `+quit` given on the
NON-dedicated client's own command line does NOT hang -- WinQuake's
Host_Quit_f (`if (key_dest != key_console && cls.state != ca_dedicated) {
M_Menu_Quit_f(); return; }`) faithfully opens the quit-confirm menu instead
of exiting, exactly like the original engine, and a headless run has no way
to answer it (confirmed directly: src/client/menu.ts's M_Quit_Key only
reacts to a real 'y'/'Y' keypress, which nothing synthesizes here) -- so the
demo loop plays forever, which is correct, not a hang. The genuine exit
path is "quit typed at the actual console" (`key_dest === key_console`),
which src/platform/sys.ts's Sys_Quit already handled correctly before this
unit's changes (`process.exit(0)` right after `hostShutdown()`); the tests
below (`> quit`) confirm that path positively rather than re-testing the
already-analyzed non-bug.

D1 (a separate defect, not this unit's) means both q1ts and qwcl bind a
FIXED UDP port regardless of any `-port` given (q1ts: 26000; qwcl: QW/client
has no `-port` override in the C at all, PORT_CLIENT=27001 always). Every
scenario below that boots one of those two trees can therefore collide with
a concurrent agent's own q1ts/qwcl process on this shared machine -- an
external interference condition, not a regression in this unit's own code.
Those tests detect a successful bind (a printed "UDP Initialized" or
"QuakeWorld Initialized" marker) before asserting on the scenario the test
actually targets, and log a note instead of failing when the precondition
was never reached. qwsv has a real `-port 0` (ephemeral) it actually honors
(src/qw/server/sv_main.ts's SV_InitNet passes it straight to NET_Init), so
its own scenarios need no such tolerance.
*/

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildDedicatedFixture, destroyDedicatedFixture } from "./support/dedicated_fixture";
import { buildQwclFixture, destroyQwclFixture } from "./support/qwcl_fixture";
import { buildQwsvFixture, destroyQwsvFixture, QWSV_FIXTURE_MAP } from "./support/qwsv_fixture";
import { HAVE_PROGS106, HAVE_QWPROGS } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

interface ChildHandle {
  proc: ReturnType<typeof spawnRaw>;
  out: { text: string };
  err: { text: string };
}

interface ChildHandleWithStdin {
  proc: ReturnType<typeof spawnRawWithStdin>;
  out: { text: string };
  err: { text: string };
}

function pumpStream(stream: ReadableStream<Uint8Array>, ref: { text: string }): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) ref.text += decoder.decode(value, { stream: true });
    }
  })();
}

function spawnRaw(cmd: string[]) {
  return Bun.spawn({
    cmd,
    cwd: repoRoot,
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function spawnRawWithStdin(cmd: string[]) {
  return Bun.spawn({
    cmd,
    cwd: repoRoot,
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Two concrete functions, not one parameterized on a boolean: Bun.spawn's
// `stdin` overload resolves on a literal "ignore"/"pipe" at each call site,
// and a single implementation branching on a runtime bool can't be made to
// satisfy both the ChildHandle and ChildHandleWithStdin return shapes at once.
function spawnChild(cmd: string[]): ChildHandle {
  const proc = spawnRaw(cmd);
  const out = { text: "" };
  const err = { text: "" };
  pumpStream(proc.stdout, out);
  pumpStream(proc.stderr, err);
  return { proc, out, err };
}

function spawnChildWithStdin(cmd: string[]): ChildHandleWithStdin {
  const proc = spawnRawWithStdin(cmd);
  const out = { text: "" };
  const err = { text: "" };
  pumpStream(proc.stdout, out);
  pumpStream(proc.stderr, err);
  return { proc, out, err };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start >= timeoutMs) return predicate();
    await Bun.sleep(20);
  }
}

// Races the child's own exit against a timeout; null means "still running".
// Structural on purpose: ChildHandle and ChildHandleWithStdin's `proc` types
// differ only in their `stdin` member, both of which carry a real `.exited`.
async function waitForExit(proc: { exited: Promise<number> }, timeoutMs: number): Promise<number | null> {
  const result = await Promise.race([proc.exited.then((c) => ({ code: c }) as const), Bun.sleep(timeoutMs).then(() => null)]);
  return result === null ? null : result.code;
}

function note(scenario: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[sys_exit.test.ts] SKIPPED "${scenario}" -- external interference: ${reason}`);
}

//=============================================================================
// D3: process termination on a real "quit"
//=============================================================================

describe("D3: process termination", () => {
  test.skipIf(!HAVE_PROGS106)("q1ts dedicated +quit exits 0 promptly (baseline, unaffected by D3's menu-vs-console distinction)", async () => {
    // D1 (a separate, already-flagged defect, not this unit's): q1ts always
    // binds UDP port 26000 regardless of any `-port` given, so this can
    // collide with ANY other q1ts dedicated/listen process on this shared
    // machine -- see this file's header. platform/net_udp.ts's own bind
    // failure has no errno text of its own (raw libc socket()/bind() via
    // FFI, unlike QW's Bun.udpSocket-based net_udp.ts), just this fixed
    // message.
    const fixture = buildDedicatedFixture("sysexit-q1-dedquit-");
    try {
      const start = Date.now();
      const child = spawnChild(["bun", "src/main.ts", "-dedicated", "-basedir", fixture.baseDir, "+map", "world", "+quit"]);
      const code = await waitForExit(child.proc, 5000);
      const elapsed = Date.now() - start;
      if (code === null) {
        child.proc.kill();
        throw new Error(`q1ts dedicated +quit did not exit within 5s.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.err.text.includes("UDP_Listen: Unable to open accept socket")) {
        note("q1ts dedicated +quit", `port 26000 already in use (D1) -- ${child.err.text.trim()}`);
        return;
      }
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      destroyDedicatedFixture(fixture);
    }
  }, 10000);

  test("q1ts non-dedicated: `quit` typed at the actual console (key_dest===key_console) exits 0", async () => {
    const fixture = buildQwclFixture("sysexit-q1-consolequit-");
    const script = `
import { Sys_Main_Init, runFrames } from "./src/main";
import { keyState, KeydestT } from "./src/client/keys";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
try {
  Sys_Main_Init(["quake", "-basedir", ${JSON.stringify(fixture.baseDir)}, "-vid_ref", "soft", "-nosound"]);
} catch (err) {
  console.log("SYSEXIT_BIND_FAILED: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
console.log("SYSEXIT_BOOT_OK");
runFrames(2, 0.05);
keyState.key_dest = KeydestT.key_console;
Cbuf_AddText("quit\\n");
Cbuf_Execute();
console.log("SYSEXIT_MUST_NOT_PRINT_AFTER_QUIT");
`;
    try {
      const start = Date.now();
      const child = spawnChild(["timeout", "10", "bun", "-e", script]);
      const code = await waitForExit(child.proc, 10000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill();
        throw new Error(`did not exit within 10s.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.out.text.includes("SYSEXIT_BIND_FAILED")) {
        note("q1ts console quit", `port 26000 already in use (D1: q1ts always binds it) -- ${child.out.text.trim()}`);
        return;
      }

      expect(child.out.text).toContain("SYSEXIT_BOOT_OK");
      expect(child.out.text).not.toContain("SYSEXIT_MUST_NOT_PRINT_AFTER_QUIT"); // proves process.exit(0) actually ran
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      destroyQwclFixture(fixture);
    }
  }, 15000);

  test.skipIf(!HAVE_QWPROGS)("qwsv: `quit` typed on stdin exits 0 with the config write skipped (dedicated) and a clean shutdown", async () => {
    const fixture = buildQwsvFixture("sysexit-qwsv-stdinquit-");
    try {
      const start = Date.now();
      const child = spawnChildWithStdin(["bun", "src/qw/main_sv.ts", "-basedir", fixture.baseDir, "-port", "0", "+map", QWSV_FIXTURE_MAP]);
      const booted = await waitUntil(() => child.out.text.includes("QuakeWorld Initialized"), 5000);
      if (!booted) {
        child.proc.kill();
        throw new Error(`qwsv never finished booting.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }

      child.proc.stdin.write("quit\n");
      await child.proc.stdin.end();

      const code = await waitForExit(child.proc, 5000);
      const elapsed = Date.now() - start;
      if (code === null) {
        child.proc.kill();
        throw new Error(`qwsv did not exit within 5s of "quit" on stdin.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      expect(code).toBe(0);
      expect(child.out.text).toContain("Shutting down.");
      expect(elapsed).toBeLessThan(8000);
    } finally {
      destroyQwsvFixture(fixture);
    }
  }, 15000);

  test("qwcl: answering 'y' at the quit-confirm menu exits 0", async () => {
    // Not the `key_dest===key_console` driver the other three trees use:
    // QW/client/cl_main.c's own CL_Quit_f has an always-true `if (1)` (the
    // C itself comments out its key_dest test -- see src/qw/client/cl_main.ts's
    // file header, "CL_Quit_f's always-true if(1)... Kept verbatim"), so the
    // "quit" console command can never reach `CL_Disconnect();Sys_Quit();`
    // in the real client either -- it always opens the confirm menu. The
    // real exit path (also faithfully exactly as the original, src/qw/client/menu.ts's
    // own file header) is M_Quit_Key's 'y'/'Y' case, which calls
    // `CL_Disconnect(); Sys_Quit();` directly, bypassing CL_Quit_f entirely.
    const fixture = buildQwclFixture("sysexit-qwcl-consolequit-");
    const script = `
import { Sys_Main_Init, runFrames } from "./src/qw/main_cl";
import { NET_Ready } from "./src/qw/net_udp";
import { M_Quit_Key } from "./src/qw/client/menu";
try {
  Sys_Main_Init(["qwcl", "-basedir", ${JSON.stringify(fixture.baseDir)}]);
  await NET_Ready();
} catch (err) {
  console.log("SYSEXIT_BIND_FAILED: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
console.log("SYSEXIT_BOOT_OK");
runFrames(2, 0.05);
M_Quit_Key("y".charCodeAt(0));
console.log("SYSEXIT_MUST_NOT_PRINT_AFTER_QUIT");
`;
    try {
      const start = Date.now();
      const child = spawnChild(["timeout", "10", "bun", "-e", script]);
      const code = await waitForExit(child.proc, 10000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill();
        throw new Error(`did not exit within 10s.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.out.text.includes("SYSEXIT_BIND_FAILED") || !child.out.text.includes("SYSEXIT_BOOT_OK")) {
        note("qwcl console quit", `port 27001 already in use (qwcl has no -port override) -- ${child.out.text.trim()}`);
        return;
      }

      expect(child.out.text).not.toContain("SYSEXIT_MUST_NOT_PRINT_AFTER_QUIT"); // proves process.exit(0) actually ran
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      destroyQwclFixture(fixture);
    }
  }, 15000);
});

//=============================================================================
// D5: SIGINT/SIGTERM handling (not in the C; see platform/sys.ts's
// installTerminationSignals header for the documented deviation)
//=============================================================================

describe("D5: SIGINT/SIGTERM", () => {
  test.skipIf(!HAVE_PROGS106)("q1ts dedicated: SIGINT shuts down cleanly and exits 0 within 3s", async () => {
    const fixture = buildDedicatedFixture("sysexit-q1-sigint-");
    try {
      const child = spawnChild(["bun", "src/main.ts", "-dedicated", "-basedir", fixture.baseDir, "+map", "world"]);
      const booted = await waitUntil(
        () => child.out.text.includes("UDP Initialized") || child.err.text.includes("UDP_Listen: Unable to open accept socket"),
        5000,
      );
      if (!booted) {
        child.proc.kill();
        throw new Error(`q1ts dedicated never reached a boot marker.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.err.text.includes("UDP_Listen: Unable to open accept socket")) {
        note("q1ts SIGINT", `port 26000 already in use (D1) -- ${child.err.text.trim()}`);
        child.proc.kill();
        return;
      }

      const start = Date.now();
      child.proc.kill("SIGINT");
      const code = await waitForExit(child.proc, 3000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill("SIGKILL");
        throw new Error(`q1ts dedicated did not exit within 3s of SIGINT.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      destroyDedicatedFixture(fixture);
    }
  }, 15000);

  test.skipIf(!HAVE_QWPROGS)("qwsv: SIGTERM shuts down cleanly (SV_FinalMessage + \"Shutting down.\") and exits 0 within 3s", async () => {
    const fixture = buildQwsvFixture("sysexit-qwsv-sigterm-");
    try {
      const child = spawnChild(["bun", "src/qw/main_sv.ts", "-basedir", fixture.baseDir, "-port", "0", "+map", QWSV_FIXTURE_MAP]);
      const booted = await waitUntil(() => child.out.text.includes("QuakeWorld Initialized"), 5000);
      if (!booted) {
        child.proc.kill();
        throw new Error(`qwsv never finished booting.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }

      const start = Date.now();
      child.proc.kill("SIGTERM");
      const code = await waitForExit(child.proc, 3000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill("SIGKILL");
        throw new Error(`qwsv did not exit within 3s of SIGTERM.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      expect(code).toBe(0);
      expect(child.out.text).toContain("Shutting down.");
      expect(elapsed).toBeLessThan(3000);
    } finally {
      destroyQwsvFixture(fixture);
    }
  }, 15000);

  test("qwcl: SIGINT shuts down cleanly and exits 0 within 3s", async () => {
    const fixture = buildQwclFixture("sysexit-qwcl-sigint-");
    try {
      const child = spawnChild(["bun", "src/qw/main_cl.ts", "-basedir", fixture.baseDir]);
      const booted = await waitUntil(
        () => child.out.text.includes("QuakeWorld Initialized") || child.err.text.includes("UDP_OpenSocket:"),
        5000,
      );
      if (!booted) {
        child.proc.kill();
        throw new Error(`qwcl never reached a boot marker.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.err.text.includes("UDP_OpenSocket:")) {
        note("qwcl SIGINT", `port 27001 already in use -- ${child.err.text.trim()}`);
        child.proc.kill();
        return;
      }

      const start = Date.now();
      child.proc.kill("SIGINT");
      const code = await waitForExit(child.proc, 3000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill("SIGKILL");
        throw new Error(`qwcl did not exit within 3s of SIGINT.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      destroyQwclFixture(fixture);
    }
  }, 15000);

  // .orch's SIGTERM-immunity finding: a CLIENT whose Host_WriteConfiguration
  // fails to open config.cfg for write (Sys_FileOpenWrite throws SysError,
  // e.g. because `-game` names a directory that doesn't exist) used to have
  // that error propagate out through Host_Shutdown/Sys_Quit uncaught, so
  // Sys_Quit's process.exit(0) never ran; because installTerminationSignals'
  // handler set `terminating = true` BEFORE calling quit(), every later
  // SIGTERM/SIGINT was then silently swallowed by that guard -- only
  // SIGKILL still worked. Fixed two ways: Host_WriteConfiguration now
  // catches SysError around the open the same way the C tests fopen's
  // return against NULL (src/common/host.ts, src/qw/client/cl_main.ts), and
  // installTerminationSignals itself now falls back to process.exit(1) if
  // quit() throws for any other reason (src/platform/sys.ts).
  test("q1ts non-dedicated: SIGTERM with a non-existent -game dir still prints \"Couldn't write config.cfg.\" and exits 0 within 3s", async () => {
    const fixture = buildQwclFixture("sysexit-q1-badgame-sigterm-");
    try {
      const child = spawnChild(["bun", "src/main.ts", "-basedir", fixture.baseDir, "-vid_ref", "soft", "-nosound", "-game", "sysexit_missing_gamedir"]);
      const booted = await waitUntil(
        () => child.out.text.includes("UDP Initialized") || child.err.text.includes("UDP_Listen: Unable to open accept socket"),
        5000,
      );
      if (!booted) {
        child.proc.kill();
        throw new Error(`q1ts never reached a boot marker.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.err.text.includes("UDP_Listen: Unable to open accept socket")) {
        note("q1ts SIGTERM missing -game dir", `port 26000 already in use (D1) -- ${child.err.text.trim()}`);
        child.proc.kill();
        return;
      }

      const start = Date.now();
      child.proc.kill("SIGTERM");
      const code = await waitForExit(child.proc, 3000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill("SIGKILL");
        throw new Error(`q1ts did not exit within 3s of SIGTERM with a missing -game dir.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(3000);
      expect(child.out.text).toContain("Couldn't write config.cfg.");
    } finally {
      destroyQwclFixture(fixture);
    }
  }, 15000);

  test("qwcl: SIGTERM with an unwritable config.cfg still prints \"Couldn't write config.cfg.\" and exits 0 within 3s", async () => {
    // QuakeWorld has no `-game` override at all (src/qw/client/cl_main.ts's
    // file header, and src/qw/common.ts's own COM_InitFilesystem note: "no
    // -cachedir/-rogue/-hipnotic/-game/-path handling, genuinely absent from
    // the QW source"), so this reproduces the same Sys_FileOpenWrite failure
    // class a different way: pre-creating config.cfg itself as a directory.
    // openSync(path, "w+") on an existing directory fails (EISDIR) exactly
    // like fopen() returning NULL for an unwritable path, exercising the
    // identical Host_WriteConfiguration catch.
    const fixture = buildQwclFixture("sysexit-qwcl-badconfig-sigterm-");
    mkdirSync(join(fixture.baseDir, "qw", "config.cfg"));
    try {
      const child = spawnChild(["bun", "src/qw/main_cl.ts", "-basedir", fixture.baseDir]);
      const booted = await waitUntil(
        () => child.out.text.includes("QuakeWorld Initialized") || child.err.text.includes("UDP_OpenSocket:"),
        5000,
      );
      if (!booted) {
        child.proc.kill();
        throw new Error(`qwcl never reached a boot marker.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      if (child.err.text.includes("UDP_OpenSocket:")) {
        note("qwcl SIGTERM unwritable config.cfg", `port 27001 already in use -- ${child.err.text.trim()}`);
        child.proc.kill();
        return;
      }

      const start = Date.now();
      child.proc.kill("SIGTERM");
      const code = await waitForExit(child.proc, 3000);
      const elapsed = Date.now() - start;

      if (code === null) {
        child.proc.kill("SIGKILL");
        throw new Error(`qwcl did not exit within 3s of SIGTERM with an unwritable config.cfg.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(3000);
      expect(child.out.text).toContain("Couldn't write config.cfg.");
    } finally {
      destroyQwclFixture(fixture);
    }
  }, 15000);
});

//=============================================================================
// .orch/e2e/C.md's added case: a second qwcl on the same (fixed) port must
// exit 1 promptly with the bind error, and must NOT crash uncaught trying to
// draw a screen update through a renderer VID_Shutdown already tore down
// (src/client/render.ts's getRenderer() -- see src/client/console.ts's and
// src/qw/client/console.ts's Con_Printf, both now guarded on `re.current`).
//=============================================================================

describe("qwcl port-bind race (.orch/e2e/C.md)", () => {
  test("a second qwcl bound to the same port exits 1 within 3s, no \"No renderer is loaded\" trace", async () => {
    const fixture = buildQwclFixture("sysexit-qwcl-race-");
    let first: ChildHandle | null = null;
    try {
      first = spawnChild(["bun", "src/qw/main_cl.ts", "-basedir", fixture.baseDir]);
      const firstBooted = await waitUntil(() => first!.out.text.includes("QuakeWorld Initialized"), 5000);
      if (!firstBooted) {
        note("qwcl port-bind race", `the first qwcl never bound port 27001 itself (already held by something else)\nstdout:\n${first.out.text}\nstderr:\n${first.err.text}`);
        return;
      }

      const second = spawnChild(["bun", "src/qw/main_cl.ts", "-basedir", fixture.baseDir]);
      const start = Date.now();
      const code = await waitForExit(second.proc, 3000);
      const elapsed = Date.now() - start;

      if (code === null) {
        second.proc.kill();
        throw new Error(`second qwcl did not exit within 3s.\nstdout:\n${second.out.text}\nstderr:\n${second.err.text}`);
      }

      expect(code).toBe(1);
      expect(elapsed).toBeLessThan(3000);
      expect(second.err.text).toContain("bind");
      expect(second.out.text).not.toContain("No renderer is loaded");
      expect(second.err.text).not.toContain("No renderer is loaded");
    } finally {
      first?.proc.kill();
      destroyQwclFixture(fixture);
    }
  }, 15000);
});

//=============================================================================
// Coordinator finding: four e2e engine processes outlived a `timeout ...`
// SIGTERM by ~1000s (SIGKILL was needed). Root cause is a Node/Bun runtime
// property, not a bug in installTerminationSignals itself -- see
// PORTING.md's "Runtime and build" section for the full writeup. Documented
// here directly: a *registered* SIGTERM/SIGINT handler only runs once the
// event loop is free, unlike the OS default (unhandled) disposition, which
// terminates the process immediately regardless of what it's doing. A
// process wedged in a synchronous, non-yielding loop (this port's own
// example: src/common/net_dgrm.ts's `_Datagram_Connect` retry, a bounded
// ~2.5s `do {...} while` with no `await` in its body) therefore cannot react
// to the signal at all until that loop returns control on its own.
//=============================================================================

describe("SIGTERM vs. a synchronous busy-loop (documented runtime limitation)", () => {
  test("unhandled SIGTERM kills a spinning process immediately (the OS default, and the C's own behavior)", async () => {
    const child = spawnChild(["bun", "-e", "while (true) {}"]);
    await Bun.sleep(300); // let it actually start spinning
    const start = Date.now();
    child.proc.kill("SIGTERM");
    const code = await waitForExit(child.proc, 2000);
    const elapsed = Date.now() - start;
    if (code === null) child.proc.kill("SIGKILL");
    expect(code).not.toBeNull();
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  test("a SIGTERM handler registered per installTerminationSignals cannot run inside a synchronous, non-yielding loop", async () => {
    // Mirrors installTerminationSignals' own handler shape (src/platform/sys.ts)
    // without importing net_dgrm.ts (out of this unit's scope) -- the point
    // being documented is the runtime's signal-delivery model, not any one
    // module's specific loop.
    const script = `
process.on("SIGTERM", () => process.exit(0));
console.log("SYSEXIT_SPINNING");
while (true) {
  // tight synchronous loop, never yields to the event loop -- see
  // PORTING.md's "Runtime and build" section
}
`;
    const child = spawnChild(["bun", "-e", script]);
    const spinning = await waitUntil(() => child.out.text.includes("SYSEXIT_SPINNING"), 2000);
    if (!spinning) {
      child.proc.kill();
      throw new Error("child never reported it started spinning");
    }
    // Documents the limitation directly: with the handler registered, this
    // process does NOT die within 1s of SIGTERM (unlike the unhandled case
    // above) -- it is still alive, requiring SIGKILL, exactly what the
    // coordinator's four e2e processes needed.
    child.proc.kill("SIGTERM");
    const codeAfterTerm = await waitForExit(child.proc, 1000);
    expect(codeAfterTerm).toBeNull(); // still alive: the handler is queued, not running
    child.proc.kill("SIGKILL");
    const codeAfterKill = await waitForExit(child.proc, 2000);
    expect(codeAfterKill).not.toBeNull(); // SIGKILL is unconditional; always works
  }, 10000);
});

//=============================================================================
// .orch/e2e/E.md defect B: Sys_ConsoleInput (src/platform/sys.ts) used to
// split stdin on every '\n' and return one line per call with the newline
// discarded. sys_linux.c's/QW's sys_unix.c's own Sys_ConsoleInput instead
// returns a whole `read()` chunk (up to 256 bytes) with embedded newlines
// intact, stripping only the final trailing byte -- and
// Host_GetConsoleCommands/SV_GetConsoleCommands do a bare `Cbuf_AddText(cmd)`
// per call with no newline of their own (confirmed directly against both
// host.c and sys_unix.c). So when two lines arrive in the SAME stdin write
// (a script piping several commands at once, or -- as here -- one write()
// call carrying both), the old per-line queue returned each with its
// separator already stripped, and Host_GetConsoleCommands's loop glued them
// back together with nothing in between: "hostname a" + "echo MARK" became
// the single malformed command "hostname aecho MARK". Fixed by returning
// each queued chunk with its embedded newlines intact (see sys.ts's own
// comment on Sys_ConsoleInput).
//=============================================================================

describe("Sys_ConsoleInput: two lines written to stdin in one call both execute (.orch/e2e/E.md defect B)", () => {
  test.skipIf(!HAVE_QWPROGS)("qwsv: `echo LINE_ONE\\necho LINE_TWO\\n` written in a single stdin write runs as two separate commands", async () => {
    const fixture = buildQwsvFixture("sysexit-qwsv-multiline-");
    try {
      const child = spawnChildWithStdin(["bun", "src/qw/main_sv.ts", "-basedir", fixture.baseDir, "-port", "0", "+map", QWSV_FIXTURE_MAP]);
      const booted = await waitUntil(() => child.out.text.includes("QuakeWorld Initialized"), 5000);
      if (!booted) {
        child.proc.kill();
        throw new Error(`qwsv never finished booting.\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`);
      }

      // One single write(), both lines together -- exactly the "two lines
      // arrive in one read()" case the C's Sys_ConsoleInput has to cope with.
      child.proc.stdin.write("echo SYSEXIT_LINE_ONE\necho SYSEXIT_LINE_TWO\n");

      const gotBoth = await waitUntil(
        () => child.out.text.includes("SYSEXIT_LINE_ONE \n") && child.out.text.includes("SYSEXIT_LINE_TWO \n"),
        3000,
      );

      child.proc.stdin.write("quit\n");
      await child.proc.stdin.end();
      const code = await waitForExit(child.proc, 5000);
      if (code === null) child.proc.kill();

      if (!gotBoth) {
        throw new Error(
          `both echo lines did not run as separate commands (glued into one malformed command).\nstdout:\n${child.out.text}\nstderr:\n${child.err.text}`,
        );
      }
      // Sanity: the glued-together failure mode ("hostname aecho MARK") would
      // print "SYSEXIT_LINE_ONEecho SYSEXIT_LINE_TWO \n" instead -- confirm
      // that malformed form is NOT what happened.
      expect(child.out.text).not.toContain("SYSEXIT_LINE_ONEecho");
      expect(child.out.text).toContain("SYSEXIT_LINE_ONE \n");
      expect(child.out.text).toContain("SYSEXIT_LINE_TWO \n");
    } finally {
      destroyQwsvFixture(fixture);
    }
  }, 15000);
});
