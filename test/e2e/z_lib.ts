/*
Family Z -- long-running stability soak with the compiled binary (unit E10,
.orch/briefs/E10-soak.md; standing order 19).

Every multiplayer scenario is TWO separate OS processes talking real UDP on
127.0.0.1, the same shape family D's `d_s1.ts` and family T's `t_lib.ts` use:
a listen server (`-listen 8 -port <n>`, bots, the map rotation) and a
connecting client (`-port <n> +connect 127.0.0.1`). The client's own `-port`
has to equal the server's listening port, not because the two ever bind the
same socket (the client's game connection gets its own OS-assigned ephemeral
port; `-port`/`net_hostport` only feeds NET_StringToAdr's fallback for a bare
`connect 127.0.0.1` with no `:port` suffix -- src/platform/net_udp.ts's
`UDP_Listen`/`UDP_OpenSocket` never touches it for a non-listening role) --
see d_s1.ts's own header for the citation. `sp` (true single player) is the
exception: one process, no bots, no network at all.

Neither seat has a stdin console -- Sys_ConsoleInput (src/platform/sys.ts)
only reads it once `cls.state === ca_dedicated`, and this family never boots
`-dedicated` (the brief calls for a listen server, so a real local render
loop is in the loop being soaked) -- so every seat is driven the way family
T drives its client seats: a `.cfg` chain written into the seat's own
writable `-game` directory and picked up by `+exec`. `startPolled` below is
t_lib.ts's `startPolled` with the two numbers a multi-minute soak needs
tuned for that instead of a several-second protocol check: the idle-per-step
frame count is small enough that `run()` calls land close together in wall
time, and the step count scales with the run's own `--minutes` instead of a
fixed 600.

Frame-time evidence comes from the engine's own `host_speeds 1` (src/common
/host.ts's `_Host_Frame`), which prints one `<ms> tot <ms> server <ms> gfx
<ms> snd` line per frame. That is the only place a real stall is visible from
outside the process: Host_FilterTime clamps the SIMULATION's own
`host.frametime` to 100ms before anything server-side ever reads it
(src/common/host.ts:962), so a real multi-hundred-millisecond hitch would
never show up as a change in `sv.time`'s rate of advance, only as one long
`tot` line.
*/
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Q1TS_DATA, Q1TS_REPO, homedirArgs, homedirRoot } from "./q1data";

export const SCRATCH: string = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
export const Z_DIR = `${SCRATCH}/e2e/z`;
mkdirSync(Z_DIR, { recursive: true });

export const RR_DATA = `${Q1TS_DATA}/rerelease`;

// ===========================================================================
// the binary (standing order 19)
// ===========================================================================

function buildBinary(out: string): void {
  const r = Bun.spawnSync({
    cmd: ["timeout", "300", "bun", "build", "--compile", "src/main.ts", "--outfile", out],
    cwd: Q1TS_REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!existsSync(out)) {
    const err = new TextDecoder().decode(r.stderr);
    throw new Error(`z_lib: could not build the engine binary at ${out}\n${err}`);
  }
}

/** `$Q1TS_BINARY` when the runner built one, else this family's own build. */
export const BINARY: string = ((): string => {
  const env = process.env.Q1TS_BINARY;
  if (env !== undefined && env !== "" && existsSync(env)) return env;
  const out = `${Z_DIR}/q1rets`;
  if (!existsSync(out)) buildBinary(out);
  return out;
})();

/** The boot argv shared by every seat: content tree, writable game dir, software renderer, no sound. */
export function baseArgs(basedir: string, parms: readonly string[], game: string): string[] {
  return ["-basedir", basedir, ...parms, ...homedirArgs(game), "-game", game, "-vid_ref", "soft", "-nosound"];
}

// ===========================================================================
// seats
// ===========================================================================

export interface SeatT {
  readonly name: string;
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly log: string;
}

const liveSeats: SeatT[] = [];

/*
HEADLESS, NO EXCEPTIONS (E2E-COMMON.md): SDL_VIDEODRIVER and SDL_AUDIODRIVER
are FORCED to "dummy" in the child's own environment rather than inherited --
a parent shell exporting something else must never be able to put a real
window on the desktop running this soak -- and every command line gets
`-nosound` whether or not the caller already added it.
*/
function seatEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.SDL_VIDEODRIVER = "dummy";
  env.SDL_AUDIODRIVER = "dummy";
  return env;
}

function spawnSeat(name: string, cmd: readonly string[]): SeatT {
  const log = `${Z_DIR}/${name}.log`;
  writeFileSync(log, ""); // a stale log from a previous run would make every check pass
  const argv = cmd.includes("-nosound") ? [...cmd] : [cmd[0], "-nosound", ...cmd.slice(1)];
  const proc = Bun.spawn({
    cmd: argv,
    env: seatEnv(),
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    stdin: "ignore",
  });
  const seat: SeatT = { name, proc, log };
  liveSeats.push(seat);
  return seat;
}

export function killSeat(seat: SeatT): void {
  try {
    seat.proc.kill();
  } catch {
    /* already gone */
  }
}

export function killAll(): void {
  for (const s of liveSeats) killSeat(s);
}

/** `null` while the process is still running, else its exit code. Bun clears `exitCode` to a number only after exit. */
export function exitedCode(seat: SeatT): number | null {
  return seat.proc.exitCode;
}

// A seat that dies mid-run does not necessarily release its UDP port, and an
// orphan sitting on one leaves the NEXT run of this family looking like an
// engine failure. `timeout -k 10` (the runner, and this file's own
// verification invocations) sends signals that an "exit" handler alone would
// not see.
process.on("exit", killAll);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(1);
  });
}

export function readLog(seat: SeatT): string {
  if (!existsSync(seat.log)) return "";
  try {
    return readFileSync(seat.log, "utf8");
  } catch {
    return "";
  }
}

export async function waitFor(seat: SeatT, needle: string | RegExp, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const text = readLog(seat);
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await Bun.sleep(100);
  }
}

// ===========================================================================
// polled seats (t_lib.ts's startPolled, retuned for a multi-minute soak)
// ===========================================================================

/*
Two facts about the command buffer (8192-byte SizeBuf, `SZ_Alloc(cmd_text,
8192)`) shape this the same way they shape t_lib.ts's version:

  - `exec` is Cbuf_InsertText: it splices the file in FRONT of whatever is
    already queued, so a cfg that re-execs itself in a loop pushes anything
    appended behind it back by the whole file, every cycle, forever;
  - the client seat's join is finished by commands the SERVER stuffs
    (skins/model precache acks), which Cbuf_AddText APPENDS -- a client
    already looping `exec` when those land starves its own join.

So a polled seat is armed in two stages, exactly as t_lib.ts's: it boots with
ONE file (no loop) holding its opening commands, a run of `wait`s, and
several attempts to `exec` a step-0 file that does not exist yet (a no-op,
so nothing is ever spliced ahead of the server's stuffed text). Once the
caller has seen the join land (or, for the server seat, once the map has
finished loading) it arms the seat by pre-writing the WHOLE step chain as
empty placeholders; from then on the seat idles through them at `idleFrames`
engine frames per step, and the caller drives it by rewriting a step a few
indices ahead of where the log says it is.
*/
const ARM_ATTEMPT_FRAMES = 50;
const ARM_ATTEMPTS = 24;
const BOOT_CFG_BYTES = 3500;
const STEP_LOOKAHEAD = 3;

export interface PolledSeatT {
  readonly seat: SeatT;
  arm(timeoutMs?: number): Promise<boolean>;
  run(lines: readonly string[], timeoutMs?: number): Promise<boolean>;
  step(): number;
}

function waits(frames: number): string[] {
  return new Array<string>(frames).fill("wait");
}

function writeStep(dir: string, name: string, k: number, actions: readonly string[], idleFrames: number): void {
  const body = [...actions, `echo Z_STEP_${k}`, ...waits(idleFrames), `exec ${name}_s${k + 1}.cfg`];
  writeFileSync(`${dir}/${name}_s${k}.cfg`, body.join("\n") + "\n");
}

function currentStep(seat: SeatT): number {
  const all = [...readLog(seat).matchAll(/Z_STEP_(\d+)/g)];
  return all.length === 0 ? -1 : Number(all[all.length - 1][1]);
}

/**
 * Starts a polled seat. `stepCount` and `idleFrames` are sized by the caller
 * from `--minutes` (see z_soak.ts): a fixed 600-step chain (t_lib.ts's own
 * default) is sized for a several-second protocol check, not a run that may
 * last 900 real seconds of idle stepping between driver actions.
 */
export function startPolled(
  name: string,
  dir: string,
  args: readonly string[],
  boot: readonly string[],
  stepCount: number,
  idleFrames: number,
): PolledSeatT {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${name}_s`) && f.endsWith(".cfg")) {
      try {
        unlinkSync(`${dir}/${f}`);
      } catch {
        /* raced with another driver */
      }
    }
  }

  const attempt = `exec ${name}_s0.cfg`;
  let bootBody: string[] = [...boot];
  for (let i = 0; i < ARM_ATTEMPTS; i++) {
    const grown = [...bootBody, ...waits(ARM_ATTEMPT_FRAMES), attempt];
    if (grown.join("\n").length + 1 > BOOT_CFG_BYTES) break;
    bootBody = grown;
  }
  writeFileSync(`${dir}/${name}_boot.cfg`, bootBody.join("\n") + "\n");
  const seat = spawnSeat(name, [BINARY, ...args, "+exec", `${name}_boot.cfg`]);

  let armed = false;
  return {
    seat,
    step: () => currentStep(seat),
    async arm(timeoutMs = 180000): Promise<boolean> {
      if (armed) return true;
      armed = true;
      for (let k = 0; k <= stepCount; k++) writeStep(dir, name, k, [], idleFrames);
      return await waitFor(seat, "Z_STEP_0", timeoutMs);
    },
    async run(lines: readonly string[], timeoutMs = 60000): Promise<boolean> {
      if (!armed && !(await this.arm(timeoutMs))) return false;
      const k = currentStep(seat) + STEP_LOOKAHEAD;
      writeStep(dir, name, k, lines, idleFrames);
      return await waitFor(seat, `Z_STEP_${k}`, timeoutMs);
    },
  };
}

/** A polled seat inside a family-owned `-game` directory (homedirRoot()/<game>). */
export function startPolledSeat(
  name: string,
  game: string,
  args: readonly string[],
  boot: readonly string[],
  stepCount: number,
  idleFrames: number,
): PolledSeatT {
  return startPolled(name, `${homedirRoot()}/${game}`, args, boot, stepCount, idleFrames);
}

// ===========================================================================
// reading the engine back
// ===========================================================================

/** `edictcount`'s `num_edicts:NNN` line (src/progs/pr_edict_core.ts's ED_Count). Last occurrence in `text`. */
export function lastNumEdicts(text: string): number | null {
  const all = [...text.matchAll(/num_edicts:\s*(\d+)/g)];
  return all.length === 0 ? null : Number(all[all.length - 1][1]);
}

/** `status`'s `#n name frags time` rows (src/common/host_cmd.ts's Host_Status_f), keyed by player name, last block only. */
export function lastStatusFrags(text: string): Map<string, number> {
  const blocks = text.split(/(?=players: \d+ active)/);
  const last = blocks[blocks.length - 1] ?? "";
  const out = new Map<string, number>();
  for (const m of last.matchAll(/^#\s*\d+\s+(.{1,16}?)\s{2,}(-?\d+)\s+\d+:\d+:\d+\s*$/gm)) {
    out.set(m[1].trim(), Number(m[2]));
  }
  return out;
}

/** Every `Host_Error: ...` line in `text` (Host_Error itself, src/common/host.ts). */
export function hostErrorLines(text: string): string[] {
  return [...text.matchAll(/^.*Host_Error:.*$/gm)].map((m) => m[0]);
}

/** `host_speeds 1`'s per-frame `<ms> tot ...` lines (src/common/host.ts's `_Host_Frame`) over `ms`, from `text`. */
export function frameSpikes(text: string, overMs: number): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/^(\d+) tot /gm)) {
    const ms = Number(m[1]);
    if (ms > overMs) out.push(ms);
  }
  return out;
}

/** Resident set size in kB, from `/proc/<pid>/status`'s `VmRSS:` line. `null` once the process is gone. */
export function rssKB(pid: number): number | null {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s*(\d+)\s*kB/.exec(text);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

// ===========================================================================
// results (the E2E-COMMON driver contract)
// ===========================================================================

export interface ResultT {
  readonly name: string;
  readonly pass: boolean;
  readonly note: string;
}

export const results: ResultT[] = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note === "" ? "" : " :: " + note}`);
  return pass;
}

export function summary(label: string): never {
  killAll();
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

// ===========================================================================
// argv
// ===========================================================================

export function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
