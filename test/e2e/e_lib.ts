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
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { Q1TS_REPO } from "./q1data";

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

export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
}

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

export function startServer(name: string, args: string[]): ServerHandle {
  const logPath = `${LOGDIR}/${name}.log`;
  const proc = Bun.spawn(["bun", `${REPO}/src/qw/main_sv.ts`, "-basedir", BASEDIR, ...args], {
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
