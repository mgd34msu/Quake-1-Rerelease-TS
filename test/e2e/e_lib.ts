// Harness helpers for the E end-to-end agent (QuakeWorld qwcl/qwsv).
// Not a bun:test suite; each e_*.ts scenario is a standalone script run with
// `bun test/e2e/e_sN.ts`. The client runs in-process so the scenario can read
// `cl`/`cls`; the server runs as a subprocess driven through its stdin
// console, which is what a real qwsv operator types into.
import { Sys_Main_Init, runFrames } from "../../src/qw/main_cl";
import { NET_Ready } from "../../src/qw/net_udp";
import { Cbuf_AddText } from "../../src/common/cmd";
import { Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { cl, cls } from "../../src/client/client";
import { con_main, conState } from "../../src/qw/client/console";
import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, symlinkSync, statSync, unlinkSync } from "node:fs";
import { Q1TS_REPO, Q1TS_DATA } from "./q1data";

export const BASEDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/eb`;
export const LOGDIR = `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/elog`;
export const REPO = Q1TS_REPO;

// ca_active in QW's CactiveT (the client is in the game)
export const CA_ACTIVE = 5;
export const CA_CONNECTED = 3;

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/*
Ends the driver. Every test/e2e driver reports through the same two lines the
runner (test/e2e/run_all.ts) reads -- the per-assertion `[PASS]`/`[FAIL]`
lines check() already prints, and one final `RESULT <pass> <fail>` -- and
exits non-zero when anything failed, per .orch/briefs/E2E-COMMON.md's driver
contract. The exit happens here rather than at each call site so a driver
that bails out early cannot report green by falling through to its own
trailing `process.exit(0)`.
*/
export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

/*
Family E runs against an ISOLATED basedir, not the retail tree the other
families share: its qwsv writes demos, screenshots and config into `qw/`, and
that directory has to be writable and private to this family. The tree is
`Id1` symlinked back at $Q1TS_DATA's own id1 (so the paks are read in place,
never copied) plus a real `qw/` holding a copy of qwprogs.dat.

test/e2e/README.md used to say "that directory is not created for you";
building it is idempotent and cheap, so every e_*.ts driver now gets it by
importing this module rather than by remembering a setup step.
*/
export function ensureBasedir(): void {
  mkdirSync(`${BASEDIR}/qw`, { recursive: true });
  mkdirSync(LOGDIR, { recursive: true });

  const id1Link = `${BASEDIR}/Id1`;
  if (!existsSync(id1Link)) {
    const src = existsSync(`${Q1TS_DATA}/id1`) ? `${Q1TS_DATA}/id1` : `${Q1TS_DATA}/Id1`;
    try {
      symlinkSync(src, id1Link);
    } catch {
      /* a concurrent driver won the race; the link is there either way */
    }
  }

  // A previous run can leave a zero-byte map under qw/maps (a failed client
  // download writes the file before it has any content). COM_FindFile then
  // prefers that empty file over the pak's real map, and loading it takes the
  // server down with "Fatal: Out of bounds access" -- see this unit's defect
  // report. Clearing empty files here keeps one bad run from poisoning every
  // later one.
  const mapsDir = `${BASEDIR}/qw/maps`;
  if (existsSync(mapsDir)) {
    for (const f of readdirSync(mapsDir)) {
      const p = `${mapsDir}/${f}`;
      try {
        if (statSync(p).size === 0) unlinkSync(p);
      } catch {
        /* raced with another driver; nothing to do */
      }
    }
  }

  const progs = `${BASEDIR}/qw/qwprogs.dat`;
  if (!existsSync(progs)) {
    for (const candidate of [`${Q1TS_DATA}/qw/qwprogs.dat`, `${Q1TS_DATA}/QW/qwprogs.dat`]) {
      if (existsSync(candidate)) {
        copyFileSync(candidate, progs);
        break;
      }
    }
  }
  if (!existsSync(progs)) {
    console.log(`[FAIL] family E basedir :: no qwprogs.dat found under ${Q1TS_DATA}/qw`);
    console.log("RESULT 0 1");
    process.exit(2);
  }
}

ensureBasedir();

// ---------------------------------------------------------------- client ---

export async function bootClient(args: string[]): Promise<void> {
  Sys_Main_Init(["qwcl", "-basedir", BASEDIR, "-nosound", ...args]);
  await NET_Ready();
}

/** Exceptions that escaped Host_Frame. An engine defect, never expected. */
export const engineErrors: string[] = [];

function frameOnce(): void {
  try {
    runFrames(1, 0.01);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    engineErrors.push(msg);
    console.log("[ENGINE THROW]\n" + msg.split("\n").slice(0, 12).join("\n"));
  }
}

/** Step the client for `ms` wall-clock milliseconds, yielding so UDP lands. */
export async function pump(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await Bun.sleep(4);
    frameOnce();
  }
}

/** Step until `pred()` is true or `ms` elapses. Returns whether it became true. */
export async function pumpUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(4);
    frameOnce();
  }
  return pred();
}

export function exec(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
}

export async function execPump(text: string, ms = 400): Promise<void> {
  exec(text);
  await pump(ms);
}

/** Whole client console scrollback as trimmed lines, oldest first. */
export function conLines(): string[] {
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  if (w <= 0 || total <= 0) return [];
  const out: string[] = [];
  for (let i = con_main.current - total + 1; i <= con_main.current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(con_main.text[row * w + x] & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}

export function conHas(needle: string): boolean {
  return conLines().some((l) => l.includes(needle));
}

/** Console lines added since `mark()`, joined. Use with conMark(). */
export function conMark(): number {
  return con_main.current;
}

export function conSince(mark: number): string[] {
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  if (w <= 0 || total <= 0) return [];
  const out: string[] = [];
  for (let i = Math.max(0, mark); i <= con_main.current; i++) {
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(con_main.text[row * w + x] & 0x7f);
    const t = s.replace(/\s+$/, "");
    if (t.length) out.push(t);
  }
  return out;
}

export function conSinceHas(mark: number, needle: string): boolean {
  return conSince(mark).some((l) => l.includes(needle));
}

export function conTail(n = 15): string {
  return conLines()
    .filter((l) => l.length > 0)
    .slice(-n)
    .join("\n");
}

// ---------------------------------------------------------------- server ---

export interface ServerHandle {
  proc: import("bun").Subprocess<"pipe", "pipe", "pipe">;
  logPath: string;
  /** Everything the server has written to stdout+stderr so far. */
  out: () => string;
  /** Type a line into the server console (as an operator would). */
  send: (line: string) => void;
  /**
   * send() plus a pause long enough for the server to consume the line on its
   * own frame. Required: two lines that land in one read get glued together
   * (see the E.md defect on SV_GetConsoleCommands).
   */
  cmd: (line: string, waitMs?: number) => Promise<void>;
  /** Wait until the server's output contains `needle`. */
  waitFor: (needle: string, ms: number) => Promise<boolean>;
  /** Marker for "output after this point". */
  mark: () => number;
  since: (mark: number) => string;
  kill: (signal?: NodeJS.Signals | number) => void;
}

/*
Standing order 19: a live gate runs OUR OWN COMPILED BINARY. The runner
(test/e2e/run_all.ts) builds one and exports Q1TS_BINARY; the qwsv seat is
then that binary with `-dedicated -qw` -- exactly what src/qw/main_sv.ts's
own withQwsvParms() inserts before handing argv to src/main.ts. Without
Q1TS_BINARY (one scenario driven by hand from a source checkout) it is
src/qw/main_sv.ts through bun, the same engine from the same source.
*/
const BINARY: string | null = ((): string | null => {
  const b = process.env.Q1TS_BINARY;
  return b !== undefined && b !== "" && existsSync(b) ? b : null;
})();

function qwsvCmd(): string[] {
  if (BINARY !== null) return [BINARY, "-dedicated", "-qw"];
  return ["bun", `${REPO}/src/qw/main_sv.ts`];
}

/*
Every qwsv this process starts, so none of them can outlive the driver. A
server that dies on a Sys_Error does not necessarily leave its UDP port, and
one orphan holding 27600-27699 makes every later run of the family look like
an engine failure ("server boots" red, the client silently connecting to
yesterday's server instead).
*/
const liveServers: ServerHandle[] = [];
let exitHookInstalled = false;

export function startServer(name: string, args: string[]): ServerHandle {
  mkdirSync(LOGDIR, { recursive: true });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const s of liveServers) {
        try {
          s.proc.kill(9);
        } catch {
          /* already gone */
        }
      }
    });
  }
  const logPath = `${LOGDIR}/${name}.log`;
  const proc = Bun.spawn([...qwsvCmd(), "-basedir", BASEDIR, ...args], {
    cwd: REPO,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  });

  let buf = "";
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const dec = new TextDecoder();
    for await (const chunk of stream) buf += dec.decode(chunk);
  };
  void drain(proc.stdout);
  void drain(proc.stderr);

  const handle: ServerHandle = {
    proc,
    logPath,
    out: () => buf,
    send: (line: string) => {
      proc.stdin.write(line.endsWith("\n") ? line : line + "\n");
      proc.stdin.flush();
    },
    cmd: async (line: string, waitMs = 400): Promise<void> => {
      proc.stdin.write(line.endsWith("\n") ? line : line + "\n");
      proc.stdin.flush();
      await Bun.sleep(waitMs);
    },
    waitFor: async (needle: string, ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (buf.includes(needle)) return true;
        await Bun.sleep(20);
      }
      return buf.includes(needle);
    },
    mark: () => buf.length,
    since: (m: number) => buf.slice(m),
    kill: (signal?: NodeJS.Signals | number) => {
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
      void Bun.write(logPath, buf);
    },
  };
  liveServers.push(handle);
  return handle;
}

/** Wait for the server to reach the point where it accepts console lines. */
export async function serverReady(sv: ServerHandle): Promise<boolean> {
  const ok = await sv.waitFor("UDP Initialized", 30000);
  // The stdin reader is installed inside Sys_Init; a line typed before that
  // is dropped, so scenarios must not race it.
  await Bun.sleep(600);
  return ok;
}

// ----------------------------------------------------------- screenshots ---

export const SHOTDIR = `${LOGDIR}/../eshots`;

function shotFiles(): Set<string> {
  if (!existsSync(`${BASEDIR}/qw`)) return new Set<string>();
  return new Set(readdirSync(`${BASEDIR}/qw`).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/** Run `screenshot`, then move the new file to <SHOTDIR>/<name>.<ext>. */
export async function shot(name: string): Promise<string | null> {
  if (!existsSync(SHOTDIR)) mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles();
  exec("screenshot");
  await pump(1500);
  for (const f of shotFiles()) {
    if (!before.has(f)) {
      const dest = `${SHOTDIR}/${name}${f.slice(f.lastIndexOf("."))}`;
      renameSync(`${BASEDIR}/qw/${f}`, dest);
      console.log(`  [shot] ${dest}`);
      return dest;
    }
  }
  console.log(`  [shot] ${name}: NO FILE PRODUCED`);
  return null;
}

export { cl, cls, Cvar_VariableString, Cvar_VariableValue, con_main, conState, runFrames };
