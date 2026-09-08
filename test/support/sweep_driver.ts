/*
Map x progs sweep -- ONE boot of ONE (gamedir, map) pair, per process,
emitting a plain-JSON SweepRecordT (test/support/sweep_lib.ts owns the
schema). Spawned by that file's runOneJob, one process per pair, for the
same reason quake-2-re-ts's test/support/parity_boot_driver.ts forks
instead of booting in-process: the engine owns process-wide singletons
(sv/svs, cl/cls, com_searchpaths, which only ever grows) and a second boot
in the same process is never a clean boot.

BOOT SHAPE
----------
Exactly test/e2e/a_lib.ts's own recipe (`Sys_Main_Init`, `Cbuf_AddText("map
<name>\n")`, pump frames, watch `cls.state`/`cls.signon`): this is an
ordinary listen-server boot, not a dedicated one. Host_Map_f's own body
(src/common/host_cmd.ts) issues `connect local` for us the moment
SV_SpawnServer succeeds and the process is not `-dedicated` -- there is no
separate "connect a player" step to write here, unlike quake-2-re-ts's
driver, which has to call ge.ClientConnect/ClientBegin itself because its
dedicated-server boot has no automatic local client.

WHY THERE IS A WARM-UP PUMP BEFORE THE MAP COMMAND IS QUEUED
--------------------------------------------------------------
quake.rc's own `startdemos demo1 demo2 demo3` line (src/common/host_cmd.ts's
Host_Startdemos_f) calls CL_NextDemo() SYNCHRONOUSLY while quake.rc is still
being processed, which Cbuf_InsertText's "insert ahead of whatever is left"
semantics put in front of a `map <name>` this driver queued right after
Sys_Main_Init returns. Measured empirically (scratch driver, not committed):
booting straight into `map start` under the re-release id1 tree loses this
race outright -- the demo loop's own recorded serverinfo takes over the
connection (signon reaches SIGNONS playing demo1.dem's OWN map, e1m3) and
`map start` never runs at all, while the identical recipe against classic
id1's `map e1m1` happened to interleave the other way and worked. Relying on
that interleaving would make the sweep's own reliability depend on which
gamedir's quake.rc/config.cfg happen to exist on disk, so this driver pumps
WARMUP_FRAMES frames before ever calling Cbuf_AddText, letting the initial
demo-loop trigger fully settle (into an established, disconnectable
demoplayback) first. `map <name>`, queued into a now-empty command buffer,
then always wins outright: Host_Map_f's own `clDisconnect()` (the first
thing it does) stops the demo/`connect local` and starts loading normally.

WHAT IS RECORDED, AND FROM WHERE
---------------------------------
- bsp_version: passed in from the parent (`--bspversion`), which read it
  straight out of the pak directory entry before ever invoking the engine
  -- see sweep_lib.ts's bspVersionFact. This is the one fact that survives
  a BSP2 map's load crash.
- reached_active / num_edicts_after_spawn / model_precache_count /
  sound_precache_count / worldmodel_name: read the instant `sv.state`
  first becomes `ss_active` (the very end of SV_SpawnServer, before any
  client has joined -- src/server/sv_main.ts:1125), i.e. before the
  `connect local` Host_Map_f queues can possibly run. A BSP2 map's
  Mod_ForName throws before this point is ever reached, which is exactly
  why these five fields are `null`/`false` on that failure rather than
  every field lower down in the record.
- player_entered: test/e2e/a_lib.ts's own `inGame()` check
  (`cls.state === ca_connected && cls.signon === SIGNONS`), polled for up
  to CONNECT_POLL_LIMIT frames after ss_active.
- unbound_named_builtins: a static scan of `pr.functions` for
  ARCHITECTURE.md's exact name-bound-builtin bit pattern
  (first_statement === 0 && parm_start === 0 && locals === 0, skipping
  function 0, the progs format's own reserved null function) -- see
  sweep_lib.ts's header for why this is a static fact rather than a
  runtime console-line class. Taken right after PR_LoadProgs runs (which
  happens before Mod_ForName, so this is available even on a BSP2 crash).
- console: sweep_lib.ts's classifyConsoleLines, absorbed INCREMENTALLY --
  once per frame, not once at the end. Coordinator finding (2026-09-06):
  console.ts's scrollback is a fixed-capacity ring buffer, and a stalled
  re-release map's Cvar_Set/PutClientInServer retry (`Cvar_Set: variable
  campaign not found`) reprints every single frame for the whole
  CONNECT_POLL_LIMIT budget -- hundreds of repeats, easily wrapping the
  ring buffer many times over and evicting a one-time line (the unified
  VM's own `unbound builtin "ex_bprint": ...` trace) long before a single
  end-of-run read would ever see it. `absorbConsole()` below reads and
  classifies only the NEW rows since the last check (via the same
  `conLines(since)` marker used to exclude warm-up noise) after every
  `runFrames` call, so a line is captured before the buffer can wrap over
  it, and the record's five original classes (is_not_a_field,
  no_spawn_function, ...) are exactly as complete as before -- this is a
  strict widening, not a behavior change to what already worked.

DETERMINISM
-----------
Math.random is pinned to a fixed-seed LCG before Sys_Main_Init runs, so two
runs of the same (gamedir, map) draw the same sequence of "random" values
and the sweep is byte-identical across runs -- quake-2-re-ts's own driver
does the same thing (there with a constant; this file uses an actual
generator per the brief, so a run that draws many values does not fold
every one of them to the same number).

NEVER HANGS
-----------
A HARD_TIMEOUT_MS watchdog (`setTimeout`) is armed before anything else
happens and writes whatever has been gathered so far as a failed record,
then force-exits, if the run is still going at 60s. Every frame-pump loop
below `await`s once per iteration (`Bun.sleep(0)`), which is what lets that
timer actually fire in between frames instead of the driver blocking the
event loop for the whole run; PR_ExecuteProgram's own runaway-loop counter
(src/progs/pr_exec.ts) is the thing that stops a true QuakeC infinite loop
from ever reaching this watchdog in the first place. sweep_lib.ts's
runOneJob wraps this whole process in `timeout 300` as a second, external
backstop.
*/

import { mkdirSync, writeFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { cls, CactiveT, SIGNONS } from "../../src/client/client";
import { sv, ServerStateT } from "../../src/server/server";
import { pr, PR_GetString } from "../../src/progs/progs";
import { conState, con_text } from "../../src/client/console";
import { classifyConsoleLines, CONSOLE_CLASS_KEYS, emptyConsoleClassification, type SweepRecordT, type SweepTimingT } from "./sweep_lib";

const HARD_TIMEOUT_MS = 60_000;
const SPAWN_POLL_LIMIT = 600; // matches quake-2-re-ts's own generous per-map budget
const CONNECT_POLL_LIMIT = 500;
const WARMUP_FRAMES = 10; // see file header: lets the startup demo-loop trigger settle before `map <name>` is queued

/*
Deterministic Math.random, per the brief: a small fixed-seed LCG (Numerical
Recipes' constants), not a constant, so a map that draws many random values
over a run does not fold them all to the same number -- two runs of the
same map still draw the identical SEQUENCE, which is what makes the sweep
byte-identical across repeats. This is this driver's own process-local
choice; nothing in src/ is touched.
*/
let lcgState = 0x2545f491;
function deterministicRandom(): number {
  lcgState = (Math.imul(1664525, lcgState) + 1013904223) >>> 0;
  return lcgState / 4294967296;
}
Math.random = deterministicRandom;

function argOf(name: string, fallback: string | null = null): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) {
    if (fallback === null) throw new Error(`missing --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
}

function errMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * test/e2e/b_lib.ts's own conLines(), inlined so this file needs no import
 * from test/e2e, plus a `since` marker (a `conState.con_current` snapshot):
 * the warm-up pump (see file header) plays whatever demo quake.rc's own
 * `startdemos` queues, under the GAMEDIR's shared base id1 progs, BEFORE
 * the map under test ever loads -- so its own console chatter (a stray
 * "'fog' is not a field" from THAT demo's map, not this record's) would
 * otherwise get classified as if the map under test had produced it. A
 * caller passes the `conState.con_current` value from right after warm-up
 * to see only rows written from that point on.
 */
function conLines(since = -1): string[] {
  const t = con_text;
  if (!t) return [];
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  const start = Math.max(since + 1, conState.con_current - total + 1);
  const out: string[] = [];
  for (let i = start; i <= conState.con_current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(t[row * w + x] & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}

/** ARCHITECTURE.md's exact name-bound-builtin bit pattern; see file header. */
function collectUnboundNamedBuiltins(): string[] {
  const names: string[] = [];
  for (let i = 1; i < pr.functions.length; i++) {
    const f = pr.functions[i];
    if (f === undefined) continue;
    if (f.first_statement === 0 && f.parm_start === 0 && f.locals === 0) {
      try {
        names.push(PR_GetString(f.s_name));
      } catch {
        names.push(`<function ${i}, bad s_name>`);
      }
    }
  }
  return names;
}

function inGame(): boolean {
  return cls.state === CactiveT.ca_connected && cls.signon === SIGNONS;
}

async function main(): Promise<void> {
  const basedir = argOf("basedir");
  const gamedir = argOf("gamedir");
  const map = argOf("map");
  const bspVersion = argOf("bspversion");
  const frames = Number(argOf("frames", "100"));
  const dt = Number(argOf("dt", "0.05"));
  const out = argOf("out");
  const extra = argOf("extra", "")
    .split(" ")
    .filter((s) => s.length > 0);

  let finished = false;
  let consoleMarker = -1; // conState.con_current right after warm-up; see conLines()'s own header
  let absorbedUpTo = -1; // conState.con_current at the last absorbConsole() call
  const accumulatedConsole = emptyConsoleClassification();

  /**
   * Reads and classifies only the console rows written since the last call
   * (or since warm-up, on the first call), merging any new hits into
   * accumulatedConsole. See this file's header for why this must run every
   * frame rather than once at the end: the scrollback is a fixed-capacity
   * ring buffer and a stalled connection's own retry spam
   * ("Cvar_Set: variable campaign not found") can wrap it many times over
   * a several-hundred-frame poll budget.
   */
  function absorbConsole(): void {
    const from = Math.max(consoleMarker, absorbedUpTo);
    const newLines = conLines(from);
    absorbedUpTo = conState.con_current;
    if (newLines.length === 0) return;
    const classified = classifyConsoleLines(newLines);
    for (const key of CONSOLE_CLASS_KEYS) {
      for (const snippet of classified[key]) {
        if (!accumulatedConsole[key].includes(snippet)) accumulatedConsole[key].push(snippet);
      }
    }
  }

  const t0 = Date.now();
  let tSpawn = t0;
  let tConnect = t0;
  let tSettleEnd = t0;

  let error: string | null = null;
  let reachedActive = false;
  let numEdictsAfterSpawn: number | null = null;
  let modelPrecacheCount: number | null = null;
  let soundPrecacheCount: number | null = null;
  let worldmodelName: string | null = null;
  let playerEntered = false;
  let unboundNamedBuiltins: string[] = [];
  let framesSettled = 0;

  function writeRecord(): void {
    const record: SweepRecordT = {
      map,
      gamedir,
      ok: error === null,
      error,
      bsp_version: bspVersion,
      reached_active: reachedActive,
      num_edicts_after_spawn: numEdictsAfterSpawn,
      model_precache_count: modelPrecacheCount,
      sound_precache_count: soundPrecacheCount,
      worldmodel_name: worldmodelName,
      player_entered: playerEntered,
      unbound_named_builtins: unboundNamedBuiltins,
      // accumulatedConsole already holds every class hit from every frame
      // this run pumped (absorbConsole(), called after each one -- see its
      // own header for why a single end-of-run read is not enough). One
      // final absorb here catches whatever was printed since the last
      // scheduled call (e.g. between the last settle frame and now), and a
      // caught crash's own `error` message is folded in too: several of the
      // coordinator's newer classes (ED_Alloc, mod_numknown, texture
      // alignment, SZ_GetSpace, Bad surface extents, RangeError) are
      // Sys_Error/native-exception text that never reaches the console at
      // all (src/platform/sys.ts's Sys_Error writes to stderr, not
      // Con_Printf).
      console: (() => {
        try {
          absorbConsole();
        } catch {
          /* best effort -- accumulatedConsole already holds every prior frame's hits */
        }
        if (error === null) return accumulatedConsole;
        const withError = classifyConsoleLines([error]);
        for (const key of CONSOLE_CLASS_KEYS) {
          for (const snippet of withError[key]) {
            if (!accumulatedConsole[key].includes(snippet)) accumulatedConsole[key].push(snippet);
          }
        }
        return accumulatedConsole;
      })(),
      timing: {
        boot_ms: tSpawn - t0,
        spawn_ms: tSpawn - t0,
        connect_ms: tConnect - tSpawn,
        settle_ms: tSettleEnd - tConnect,
        total_ms: Date.now() - t0,
      } satisfies SweepTimingT,
      frames_settled: framesSettled,
    };
    const dir = out.slice(0, out.lastIndexOf("/"));
    if (dir !== "") mkdirSync(dir, { recursive: true });
    writeFileSync(out, JSON.stringify(record));
  }

  const watchdog = setTimeout(() => {
    if (finished) return;
    if (error === null) error = `sweep_driver hard timeout: no result after ${HARD_TIMEOUT_MS}ms`;
    try {
      writeRecord();
    } catch {
      /* best effort -- the process is exiting either way */
    }
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  watchdog.unref?.();

  try {
    // Every write this boot makes (qconsole.log under -condebug, autosaves,
    // config.cfg at shutdown) lands beside the record, never in the retail
    // tree: `bun test` runs with the no-home setting, so without this the
    // sweep left autosaves in every retail game directory it visited.
    const outDir = out.slice(0, out.lastIndexOf("/"));
    const home = `${outDir === "" ? "." : outDir}/home`;
    mkdirSync(home, { recursive: true });
    const argv = ["quake", "-basedir", basedir, "-homedir", home, ...extra, "-nosound"];
    Sys_Main_Init(argv);

    // See file header: lets quake.rc's own `startdemos` (which synchronously
    // triggers CL_NextDemo -> Cbuf_InsertText("playdemo demo1\n")) settle
    // into an established, disconnectable demoplayback BEFORE `map <name>`
    // is queued, so Host_Map_f's own clDisconnect() always wins outright
    // instead of racing whatever quake.rc happens to contain.
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      runFrames(1, dt);
      await Bun.sleep(0);
    }
    consoleMarker = conState.con_current;
    absorbedUpTo = consoleMarker; // absorbConsole() below starts reading right after warm-up, never before

    Cbuf_AddText(`map ${map}\n`);

    for (let i = 0; i < SPAWN_POLL_LIMIT && sv.state !== ServerStateT.ss_active; i++) {
      runFrames(1, dt);
      absorbConsole();
      await Bun.sleep(0);
    }

    // Static PR fact -- available whether or not the map itself loaded,
    // because PR_LoadProgs runs before SV_SpawnServer ever touches the
    // .bsp (see file header).
    unboundNamedBuiltins = collectUnboundNamedBuiltins();

    tSpawn = Date.now();

    if (sv.state === ServerStateT.ss_active) {
      reachedActive = true;
      numEdictsAfterSpawn = sv.num_edicts;
      worldmodelName = sv.worldmodel !== null ? sv.worldmodel.name : sv.modelname;

      let mc = 0;
      while (mc < sv.model_precache.length && sv.model_precache[mc] !== null) mc++;
      modelPrecacheCount = mc;

      let sc = 0;
      while (sc < sv.sound_precache.length && sv.sound_precache[sc] !== null) sc++;
      soundPrecacheCount = sc;

      for (let i = 0; i < CONNECT_POLL_LIMIT && !inGame(); i++) {
        runFrames(1, dt);
        absorbConsole(); // the coordinator's own repro: a stalled connect reprints "Cvar_Set: variable campaign not found" every frame, wrapping the ring buffer well within this budget
        await Bun.sleep(0);
      }
      playerEntered = inGame();
    } else {
      error = `never reached ss_active (state ${String(sv.state)}) after ${SPAWN_POLL_LIMIT} frames`;
    }

    tConnect = Date.now();

    if (error === null) {
      // One frame at a time here too (not a single runFrames(frames, dt)
      // batch call): settle can be the longest phase (`--frames` defaults
      // to 100) and the same ring-buffer-eviction risk applies to whatever
      // it prints.
      for (let i = 0; i < frames; i++) {
        runFrames(1, dt);
        absorbConsole();
        await Bun.sleep(0);
      }
      framesSettled = frames;
    }

    tSettleEnd = Date.now();
  } catch (e) {
    if (error === null) error = errMessage(e);
    // A crash mid-run still leaves whatever facts were captured before it
    // (bsp_version always; unbound_named_builtins and the spawn-time facts
    // if the throw happened after they were read) -- see file header.
    try {
      unboundNamedBuiltins = collectUnboundNamedBuiltins();
    } catch {
      /* pr.functions may not exist yet (boot itself failed) */
    }
  } finally {
    // `finally` rather than plain code after the try/catch (coordinator
    // follow-up, 2026-09-06): writeRecord() -- and so the console tail it
    // captures -- now runs even if something above (down to the catch
    // block's own recovery step) throws a second time, instead of that
    // second throw skipping straight past it.
    finished = true;
    clearTimeout(watchdog);
    writeRecord();
  }
  process.exit(error === null ? 0 : 1);
}

try {
  await main();
} catch (e) {
  // Last-resort backstop: main() already writes a record from inside its
  // own try/finally on every path it controls, so reaching here means
  // something escaped that (e.g. a missing --arg before `out` is even
  // known). Exit non-zero rather than let bun print an unhandled-rejection
  // stack trace -- sweep_lib.ts's runOneJob treats "no JSON at --out" as
  // its own failure record either way.
  process.stderr.write(`sweep_driver: unhandled: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
