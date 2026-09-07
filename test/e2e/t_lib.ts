/*
Family T -- every protocol and every content/ruleset pairing, over real UDP,
with OUR OWN COMPILED BINARY in both seats (unit E3,
.orch/briefs/E3-protocols-binary.md; standing order 19).

Two things make this family different from family D's two-process harness:

  - BOTH seats are the compiled binary. Family D keeps a CLIENT seat on
    d_role.ts because `Sys_ConsoleInput` reads stdin only when
    `cls.state == ca_dedicated` (faithful to sys_linux.c), so a shipped
    client has no console channel at all. Here a client is scripted the way
    a player's own autoexec would do it: a per-scenario `.cfg` written into
    the writable `-game` directory and run by `+exec <name>.cfg`, whose
    `wait` lines pace it one console frame at a time. The driver never
    assumes how long a `wait` is -- the cfg prints `echo T_PHASE_<name>`
    markers and the driver polls the client's log for them.

  - the observable state is read out of the two logs. The SERVER prints
    `Server ruleset <id>` and `Server protocol <n> (flags 0x<f>)` at every
    map load, answers `status` with the player list and their frags, and
    answers `edict <n>` with that entity's live fields (origin, ammo,
    health, deadflag). The CLIENT prints the level title it received, the
    obituaries and chat the server broadcast, and -- since F20 -- its own
    `Client protocol <n> (flags 0x<f>)` line (t_lib.ts's clientProtocolLine),
    the direct client-side observable of the negotiated protocol number and
    protocol flags; a demo it records from before the connect carries the
    same numbers in its serverinfo bytes (readDemoServerInfo) and stays
    available as a fallback cross-check.

Ports: this unit's assigned UDP band is 26300-26399. Every driver picks its
own ports out of it so two drivers in the runner's pool never collide.
QuakeWorld is the exception the runner's `lock` field exists for: QW's client
port is the hardcoded `PORT_CLIENT = 27001` in src/qw/protocol.ts, so every
QuakeWorld driver here declares `"lock": "qwclient"` and runs its QW seats
strictly one at a time.
*/

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { Q1TS_DATA, Q1TS_REPO, homedirArgs, homedirRoot } from "./q1data";

export const SCRATCH: string = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
export const T_DIR = `${SCRATCH}/e2e/t`;
mkdirSync(T_DIR, { recursive: true });

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
    throw new Error(`t_lib: could not build the engine binary at ${out}\n${err}`);
  }
}

/** `$Q1TS_BINARY` when the runner built one, else this family's own build. */
export const BINARY: string = ((): string => {
  const env = process.env.Q1TS_BINARY;
  if (env !== undefined && env !== "" && existsSync(env)) return env;
  const out = `${T_DIR}/q1rets`;
  if (!existsSync(out)) buildBinary(out);
  return out;
})();

// ===========================================================================
// content trees
// ===========================================================================

/*
The ten content/ruleset pairings this family runs. `basedir` + `parms` is the
boot form from .orch/briefs/E2E-COMMON.md: `-norerelease` mounts the classic
root alone, `<Q1TS_DATA>/rerelease` mounts the 2021 re-release, and the
episode flags pick the mission pack or add-on inside whichever root is
mounted. `ruleset` is what `sv_ruleset auto` must detect from that tree's
progs.dat; `bsp2` is whether `map` loads a BSP2 world, which is what
`sv_protocol auto` has to answer 999 for.
*/
export interface ContentT {
  readonly id: string;
  readonly basedir: string;
  readonly parms: readonly string[];
  /** single-player map with monsters on it */
  readonly map: string;
  /** map to run deathmatch/coop scenarios on */
  readonly dmMap: string;
  readonly bsp2: boolean;
  readonly ruleset: "classic" | "rerelease";
  /** does `map` spawn monsters that can be killed? */
  readonly monsters: boolean;
}

const RR = `${Q1TS_DATA}/rerelease`;

export const CONTENT: readonly ContentT[] = [
  { id: "classic-id1", basedir: Q1TS_DATA, parms: ["-norerelease"], map: "e1m1", dmMap: "dm4", bsp2: false, ruleset: "classic", monsters: true },
  { id: "classic-hipnotic", basedir: Q1TS_DATA, parms: ["-norerelease", "-hipnotic"], map: "hip1m1", dmMap: "hipdm1", bsp2: false, ruleset: "classic", monsters: true },
  { id: "classic-rogue", basedir: Q1TS_DATA, parms: ["-norerelease", "-rogue"], map: "r1m1", dmMap: "ctf1", bsp2: false, ruleset: "classic", monsters: true },
  { id: "rr-id1", basedir: RR, parms: [], map: "e1m1", dmMap: "dm4", bsp2: false, ruleset: "rerelease", monsters: true },
  { id: "rr-hipnotic", basedir: RR, parms: ["-hipnotic"], map: "hip1m1", dmMap: "hipdm1", bsp2: false, ruleset: "rerelease", monsters: true },
  { id: "rr-rogue", basedir: RR, parms: ["-rogue"], map: "r1m1", dmMap: "ctf1", bsp2: false, ruleset: "rerelease", monsters: true },
  { id: "mg1", basedir: RR, parms: ["-mg1"], map: "mge1m1", dmMap: "mgdm1", bsp2: true, ruleset: "rerelease", monsters: true },
  { id: "mg3", basedir: RR, parms: ["-mg3"], map: "map1", dmMap: "dm1", bsp2: true, ruleset: "rerelease", monsters: true },
  { id: "dopa", basedir: RR, parms: ["-dopa"], map: "e5m1", dmMap: "e5dm", bsp2: true, ruleset: "rerelease", monsters: true },
  { id: "ctf", basedir: RR, parms: ["-ctf"], map: "ctf1", dmMap: "ctf1", bsp2: false, ruleset: "rerelease", monsters: false },
];

export function contentById(id: string): ContentT {
  const c = CONTENT.find((x) => x.id === id);
  if (c === undefined) throw new Error(`t_lib: unknown --content ${id} (have ${CONTENT.map((x) => x.id).join(", ")})`);
  return c;
}

/** The boot argv shared by every seat of a scenario: content tree, writable game dir, no sound. */
export function baseArgs(c: ContentT, game: string): string[] {
  return ["-basedir", c.basedir, ...c.parms, ...homedirArgs(game), "-game", game, "-nosound"];
}

/*
The QuakeWorld seats run against a basedir of this family's own, the same
isolated tree family E builds (test/e2e/e_lib.ts's ensureBasedir): `Id1`
symlinked back to the retail install and a private WRITABLE `qw/` holding a
copy of qwprogs.dat.

It is not an optimisation. `-homedir` does not reach the QuakeWorld side --
a `-qw` client resolves `config.cfg` and every `exec` against
`<basedir>/qw` and never looks in the homedir (see t_qw.ts's defect note) --
so a QuakeWorld seat scripted by an exec'd cfg needs a writable `qw/`
directory that is NOT the retail install.

A zero-byte map left under `qw/maps` by a failed client download makes
COM_FindFile prefer it over the pak's real map and takes the server down, so
any empty file there is cleared first (README.md's "A zero-byte map file
takes the server down").
*/
let qwBasedirReady = false;

export function qwBasedir(): string {
  const base = `${T_DIR}/tb`;
  if (qwBasedirReady) return base;
  mkdirSync(`${base}/qw`, { recursive: true });

  const id1Link = `${base}/Id1`;
  if (!existsSync(id1Link)) {
    const src = existsSync(`${Q1TS_DATA}/id1`) ? `${Q1TS_DATA}/id1` : `${Q1TS_DATA}/Id1`;
    try {
      symlinkSync(src, id1Link);
    } catch {
      /* a concurrent driver won the race; the link is there either way */
    }
  }

  const mapsDir = `${base}/qw/maps`;
  if (existsSync(mapsDir)) {
    for (const f of readdirSync(mapsDir)) {
      const p = `${mapsDir}/${f}`;
      try {
        if (statSync(p).size === 0) unlinkSync(p);
      } catch {
        /* raced with another driver */
      }
    }
  }

  const progs = `${base}/qw/qwprogs.dat`;
  if (!existsSync(progs)) {
    for (const candidate of [`${Q1TS_DATA}/qw/qwprogs.dat`, `${Q1TS_DATA}/QW/qwprogs.dat`]) {
      if (existsSync(candidate)) {
        copyFileSync(candidate, progs);
        break;
      }
    }
  }
  if (!existsSync(progs)) throw new Error(`t_lib: no qwprogs.dat under ${Q1TS_DATA}/qw -- the QuakeWorld drivers cannot run`);
  qwBasedirReady = true;
  return base;
}

/*
A QuakeWorld client seat's console script. It goes into `<qwBasedir>/qw`
rather than the homedir for the reason qwBasedir() gives, and is chained the
same way a NetQuake client's is.
*/
export function startQwClient(name: string, args: readonly string[], script: readonly string[]): SeatT {
  const dir = `${qwBasedir()}/qw`;
  const cfg = writeScriptInto(dir, name, script);
  return spawnSeat(name, [BINARY, ...args, "+exec", cfg]);
}

/*
A named cfg written into a QuakeWorld basedir's `qw/` directory for a client
to run on its OWN, once it reaches ca_active, by arming `cl_execonspawn
<name>` (F20 defect D4) in the client's opening cfg rather than placing the
script itself ahead of `connect`. cl_execonspawn's exec reaches the command
buffer through Cbuf_AddText -- behind anything the server has already
stuffed to finish the join -- so a `record` (or anything else) inside the
returned cfg runs once cls.state is ALREADY ca_active, unlike a script
placed in the boot cfg, which always runs ahead of that stuffed text (see
x_qwd.ts's file header for the four designs that failed before F20 landed).
*/
export function writeQwSpawnCfg(name: string, script: readonly string[]): string {
  return writeScriptInto(`${qwBasedir()}/qw`, name, script);
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
Every seat this family spawns is headless, without exception: no driver here
takes a screenshot or needs a GL context, so there is no reason for one of
these processes to be able to open a window on the machine running the suite.
SDL_VIDEODRIVER and SDL_AUDIODRIVER are therefore FORCED to "dummy" in the
child's environment rather than inherited -- a parent shell that happens to
export SDL_VIDEODRIVER=x11 (or a runner that exports "offscreen" for a GL
family) must not be able to put a real window on someone's desktop -- and
spawnSeat adds `-nosound` to any command line that does not already carry it.
*/
function seatEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.SDL_VIDEODRIVER = "dummy";
  env.SDL_AUDIODRIVER = "dummy";
  return env;
}

function spawnSeat(name: string, cmd: readonly string[]): SeatT {
  const log = `${T_DIR}/${name}.log`;
  writeFileSync(log, ""); // a stale log makes every check pass
  const argv = cmd.includes("-nosound") ? [...cmd] : [cmd[0], "-nosound", ...cmd.slice(1)];
  const proc = Bun.spawn({
    cmd: argv,
    env: seatEnv(),
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    stdin: "pipe",
  });
  const seat: SeatT = { name, proc, log };
  liveSeats.push(seat);
  return seat;
}

/** A dedicated server seat. Its scripted console lines go over the engine's real stdin. */
export function startServer(name: string, args: readonly string[]): SeatT {
  return spawnSeat(name, [BINARY, "-dedicated", ...args]);
}

/*
The command buffer is one 8192-byte SizeBuf (src/common/cmd.ts's
`SZ_Alloc(cmd_text, 8192)`), and `exec` splices the WHOLE file into it, so a
timeline long enough to pace a match in `wait` lines does not fit in one
file -- it reaches Cbuf_AddText's "overflow" and the rest of the script is
dropped silently. So a script is written as a chain: each segment ends by
exec'ing the next one, and no segment is anywhere near the buffer's size.
Splitting introduces no timing seam of its own -- Cbuf_InsertText splices in
front of what is left and Cbuf_Execute keeps consuming in the same frame, so
a chain boundary is not a frame boundary.

That front-splice is also a starvation risk for ANY chained one-shot script,
not only an armed PolledClientT's looping step chain. A PolledClientT starves
the server's stuffed join-completion text forever, because its step cfg keeps
re-execing itself in a loop that never stops. A plain one-shot script chained
by writeScriptInto/writeScript starves the SAME text for exactly as long as
the chain has segments left to splice: each segment's trailing `exec
<name>_i+1.cfg` re-inserts at the front, ahead of whatever Cbuf_AddText has
appended behind it, so anything the server stuffs to finish a connect (QW's
`skins`/`cmd` pair, or a NetQuake `soundlist`/`spawnstatic` batch) that lands
while segments are still queued gets pushed back by every remaining segment
boundary -- the exact mechanism x_qwd.ts's file header proved for design (3)
(a chained one-shot QuakeWorld boot script with a `record` past the connect).
A one-shot script is safe from this only if the WHOLE timeline up to and past
the point anything gets stuffed fits in ONE segment (under CFG_SEGMENT_BYTES,
no chaining at all), or if the script's own `connect`/join sits in the FIRST
segment with nothing chained behind it yet. See writeQwSpawnCfg above for the
alternative F20 makes possible: running the post-join script through
`cl_execonspawn` instead of chaining it into the one-shot boot script at all,
since its exec lands through Cbuf_AddText well after the join has already
completed.
*/
const CFG_SEGMENT_BYTES = 1600;

function writeScript(name: string, game: string, script: readonly string[]): string {
  return writeScriptInto(`${homedirRoot()}/${game}`, name, script);
}

function writeScriptInto(dir: string, name: string, script: readonly string[]): string {
  mkdirSync(dir, { recursive: true });
  const segments: string[][] = [[]];
  let size = 0;
  for (const line of script) {
    const last = segments[segments.length - 1];
    if (size + line.length + 1 > CFG_SEGMENT_BYTES && last.length > 0) {
      segments.push([]);
      size = 0;
    }
    segments[segments.length - 1].push(line);
    size += line.length + 1;
  }
  for (let i = 0; i < segments.length; i++) {
    const tail = i + 1 < segments.length ? [`exec ${name}_${i + 1}.cfg`] : [];
    writeFileSync(`${dir}/${name}_${i}.cfg`, [...segments[i], ...tail].join("\n") + "\n");
  }
  return `${name}_0.cfg`;
}

/*
A client seat. `script` is its console timeline, written into the writable
`-game` directory and started with `+exec <name>_0.cfg`, because
Sys_ConsoleInput never reads a client's stdin (see the file header). The
per-seat cfg name keeps two concurrent drivers out of each other's files.
*/
export function startClient(name: string, game: string, args: readonly string[], script: readonly string[]): SeatT {
  const cfg = writeScript(name, game, script);
  return spawnSeat(name, [BINARY, ...args, "+exec", cfg]);
}

/*
A client seat the driver can drive ON DEMAND, instead of on a fixed timeline.

Two facts about the command buffer shape everything here.

  - `exec` is Cbuf_InsertText: it splices the file in FRONT of whatever is
    already queued. A cfg that re-execs itself in a loop therefore pushes any
    text appended behind it back by the whole file, every cycle, forever.
  - the server stuffs text into that same buffer with Cbuf_AddText, which
    APPENDS. QuakeWorld's join is finished by stuffed commands (`skins`, and
    the `cmd` lines behind it), so a client running a looping cfg starves its
    own connect: it sits at "Checking models..." indefinitely while its
    console counts down waits. (Reproduce with a `-qw` client whose cfg loops
    `exec`; the same client with a bare `+connect` joins in seconds.)

So a polled client is armed in two stages. It boots with ONE file -- no
chaining, no loop -- holding its opening commands, a run of `wait`s long
enough to cover the join, and three attempts to `exec` its first step file.
That file does not exist yet, and `exec` of a missing file is a no-op, so
nothing is ever spliced in front of the server's stuffed text and the join
completes normally. Once the driver has seen the join land it ARMS the seat by
writing the step chain, and the next attempt picks it up; from then on each
step echoes its index, idles a few frames and execs the next, and the driver
makes the client do something by rewriting a step file a few indices AHEAD of
where the log says the client is -- far enough that the client cannot already
have read it, so there is no torn-read race.

An armed client's loop does starve anything the server stuffs afterwards.
Nothing in this family needs post-join stuffed text; a driver that does must
stay on a one-shot script.
*/
const STEP_IDLE_FRAMES = 40;
const STEP_LOOKAHEAD = 3;
const STEP_COUNT = 600;
// The whole boot cfg has to fit the 8192-byte command buffer, which caps the
// arming window at roughly 1600 `wait` frames (~22 s) however it is spent. It
// is spent on MANY short-gap attempts rather than a few long ones, so a
// driver that arms a seat a few seconds after it joins still finds an attempt
// ahead of it.
const ARM_ATTEMPT_FRAMES = 50;
const ARM_ATTEMPTS = 20;
// Cbuf_InsertText adds the WHOLE file to the 8192-byte buffer on top of what
// is already queued, and an oversized file is dropped entirely with one
// "Cbuf_AddText: overflow" line -- a silently unscripted client. The boot cfg
// is trimmed to leave room for whatever stuffcmds has already queued.
const BOOT_CFG_BYTES = 3500;

export interface PolledClientT {
  readonly seat: SeatT;
  /** Writes the step chain so the seat's next `exec` attempt picks it up. Call once the join has landed. */
  arm(timeoutMs?: number): Promise<boolean>;
  /** Runs `lines` on the client, resolving once the client has executed them. */
  run(lines: readonly string[], timeoutMs?: number): Promise<boolean>;
  /** The highest step index the client has reported reaching. */
  step(): number;
}

function writeStep(dir: string, name: string, k: number, actions: readonly string[]): void {
  const body = [...actions, `echo T_STEP_${k}`, ...waits(STEP_IDLE_FRAMES), `exec ${name}_s${k + 1}.cfg`];
  writeFileSync(`${dir}/${name}_s${k}.cfg`, body.join("\n") + "\n");
}

function currentStep(seat: SeatT): number {
  const all = [...readLog(seat).matchAll(/T_STEP_(\d+)/g)];
  return all.length === 0 ? -1 : Number(all[all.length - 1][1]);
}

function startPolled(name: string, dir: string, args: readonly string[], boot: readonly string[]): PolledClientT {
  mkdirSync(dir, { recursive: true });
  // A stale step chain from an earlier run would be picked up by the FIRST
  // arming attempt, starting the loop before the join has landed.
  for (const f of readdirSync(dir)) {
    if (/^.+_s\d+\.cfg$/.test(f) && f.startsWith(`${name}_s`)) {
      try {
        unlinkSync(`${dir}/${f}`);
      } catch {
        /* raced with another driver */
      }
    }
  }

  const attempt = `exec ${name}_s0.cfg`;
  const bootBody = [...boot];
  for (let i = 0; i < ARM_ATTEMPTS; i++) {
    const grown = [...bootBody, ...waits(ARM_ATTEMPT_FRAMES), attempt];
    if (grown.join("\n").length + 1 > BOOT_CFG_BYTES) break;
    bootBody.length = 0;
    bootBody.push(...grown);
  }
  writeFileSync(`${dir}/${name}_boot.cfg`, bootBody.join("\n") + "\n");
  const seat = spawnSeat(name, [BINARY, ...args, "+exec", `${name}_boot.cfg`]);
  let armed = false;
  return {
    seat,
    step: () => currentStep(seat),
    async arm(timeoutMs = 120000): Promise<boolean> {
      if (armed) return true;
      armed = true;
      for (let k = 0; k <= STEP_COUNT; k++) writeStep(dir, name, k, []);
      return await waitFor(seat, "T_STEP_0", timeoutMs);
    },
    async run(lines: readonly string[], timeoutMs = 120000): Promise<boolean> {
      if (!armed && !(await this.arm(timeoutMs))) return false;
      const k = currentStep(seat) + STEP_LOOKAHEAD;
      writeStep(dir, name, k, lines);
      return await waitFor(seat, `T_STEP_${k}`, timeoutMs);
    },
  };
}

/** A polled NetQuake client seat (its step files live in the writable -game dir). */
export function startPolledClient(name: string, game: string, args: readonly string[], boot: readonly string[] = []): PolledClientT {
  return startPolled(name, `${homedirRoot()}/${game}`, args, boot);
}

/** A polled QuakeWorld client seat (its step files live in this family's own qw/ dir). */
export function startPolledQwClient(name: string, args: readonly string[], boot: readonly string[] = []): PolledClientT {
  return startPolled(name, `${qwBasedir()}/qw`, args, boot);
}

export function consoleLine(seat: SeatT, line: string): void {
  // Bun.spawn's stdin union also admits a number and null; narrowed by the
  // two methods actually used rather than by an assertion (as d_lib.ts does).
  const w: unknown = seat.proc.stdin;
  if (w !== null && typeof w === "object" && "write" in w && typeof w.write === "function" && "flush" in w && typeof w.flush === "function") {
    w.write(line + "\n");
    w.flush();
  }
}

/*
Runs one console command on a dedicated server and returns ONLY the output it
produced, by fencing it with an `echo` marker and waiting for that marker.

The command and its marker go out as ONE line joined by `;` rather than as two
writes. Two writes are what the engine cannot currently take: Sys_ConsoleInput
(src/platform/sys.ts) hands Host_GetConsoleCommands one queued stdin chunk per
call, Host_GetConsoleCommands (src/common/host.ts:976) loops until the queue is
empty, and each chunk is `Cbuf_AddText`ed with no separator -- so two lines
that arrive in the same frame are concatenated into one nonsense command
(`edicts` + `echo X` executes as `edictsecho X`). See t_matrix.ts's
"two console lines sent to the dedicated server stay two commands" check,
which asserts the behaviour this workaround is avoiding.
*/
export async function svQuery(seat: SeatT, cmd: string, tag: string): Promise<string> {
  const before = readLog(seat).length;
  const end = `T_SV_${tag}_END`;
  consoleLine(seat, `${cmd};echo ${end}`);
  await waitFor(seat, end, 60000);
  return readLog(seat).slice(before);
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

/*
A seat that dies on a Sys_Error does not necessarily release its UDP port, and
one orphan holding a port in the 26300-26399 band makes every later run of
this family look like an engine failure -- the next server cannot bind and
stops after "UDP Initialized". The runner runs every driver under
`timeout -k 10 <n>`, so the signals it sends are reaped here as well as the
normal exit: an "exit" handler alone does not run when the driver is
SIGTERMed out of a wait.
*/
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
    await Bun.sleep(120);
  }
}

export async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

// ===========================================================================
// client console scripts
// ===========================================================================

/*
`wait` defers the rest of the command buffer to the next console frame, so a
run of them is the only pacing a `.cfg` has. How long one is depends on the
host's frame rate, which is exactly why every phase ends with an `echo`
marker the driver waits for instead of counting milliseconds here.
*/
export function waits(frames: number): string[] {
  return new Array<string>(frames).fill("wait");
}

export function marker(name: string): string {
  return `T_PHASE_${name}`;
}

export function echoMarker(name: string): string {
  return `echo ${marker(name)}`;
}

// ===========================================================================
// reading the engine back
// ===========================================================================

/*
`edict <n>` on the server console prints that entity's non-zero fields, one
per line, under an `EDICT <n>:` header (src/progs/profiles/nq.ts's
printEdictHeader). Vectors come out quoted -- `origin '480.0 -352.0 88.0'`.
A log holds every sample taken so far, so a caller asking for edict 1 after
the movement phase wants the LAST block, which is what this returns.
*/
export interface EdictSampleT {
  readonly index: number;
  readonly fields: ReadonlyMap<string, string>;
}

export function parseEdicts(text: string): EdictSampleT[] {
  const out: EdictSampleT[] = [];
  const lines = text.split("\n");
  let index = -1;
  let fields: Map<string, string> | null = null;
  const flush = (): void => {
    if (fields !== null && index >= 0) out.push({ index, fields });
    fields = null;
    index = -1;
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const head = /^\s*EDICT (\d+):\s*$/.exec(line);
    if (head !== null) {
      flush();
      index = Number(head[1]);
      fields = new Map<string, string>();
      continue;
    }
    if (fields === null) continue;
    const kv = /^([A-Za-z_][A-Za-z_0-9]{0,14}) +(\S.*)$/.exec(line);
    if (kv === null) {
      flush();
      continue;
    }
    fields.set(kv[1], kv[2].trim());
  }
  flush();
  return out;
}

/** The last `edict <n>` sample for that entity number in a server log. */
export function lastEdict(text: string, index: number): EdictSampleT | null {
  const all = parseEdicts(text).filter((e) => e.index === index);
  return all.length === 0 ? null : all[all.length - 1];
}

export function edictVector(e: EdictSampleT | null, field: string): [number, number, number] | null {
  const v = e?.fields.get(field);
  if (v === undefined) return null;
  const m = /^'?\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*'?$/.exec(v);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function edictNumber(e: EdictSampleT | null, field: string): number {
  const v = e?.fields.get(field);
  if (v === undefined) return 0; // ED_Print skips a field that is still all zero
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : 0;
}

export interface BoundsT {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/*
An entity's world-space bounding box as the SERVER itself reports it.
`absmin`/`absmax` are what SV_LinkEdict wrote for the entity's current
origin, so they are read first and `origin + mins/maxs` is only rebuilt when
ED_Print skipped one of them for being all zero. The last fallback is Quake's
own standard 32x32x64 monster/player hull, which is what every entity these
drivers measure against actually carries.
*/
export function edictBounds(e: EdictSampleT | null): BoundsT | null {
  const absmin = edictVector(e, "absmin");
  const absmax = edictVector(e, "absmax");
  if (absmin !== null && absmax !== null) return { min: absmin, max: absmax };
  const origin = edictVector(e, "origin");
  if (origin === null) return null;
  const mins = edictVector(e, "mins") ?? [-16, -16, -24];
  const maxs = edictVector(e, "maxs") ?? [16, 16, 40];
  return {
    min: [origin[0] + mins[0], origin[1] + mins[1], origin[2] + mins[2]],
    max: [origin[0] + maxs[0], origin[1] + maxs[1], origin[2] + maxs[2]],
  };
}

/** How many `monster_*` edicts in an `edicts` dump carry a non-zero `deadflag`, i.e. have been killed. */
export function deadMonsters(text: string): number {
  let n = 0;
  for (const e of parseEdicts(text)) {
    const cls = e.fields.get("classname") ?? "";
    if (!cls.startsWith("monster_")) continue;
    if (edictNumber(e, "deadflag") !== 0) n++;
  }
  return n;
}

export function monsterEdicts(text: string): number {
  let n = 0;
  for (const e of parseEdicts(text)) if ((e.fields.get("classname") ?? "").startsWith("monster_")) n++;
  return n;
}

/*
The negotiated protocol as the CLIENT saw it.

A recorded .dem is a `%i\n` cd-track line followed by, per message, a 4-byte
length, three view angles and the message bytes exactly as they came off the
wire (src/client/cl_demo.ts's CL_WriteDemoMessage). The first message
carrying `svc_serverinfo` is the one the client parsed its protocol out of,
so reading that long back is the client-side half of "the negotiated
protocol and flags on both sides". Protocol 999 is the only one that puts a
flags long after it (src/common/protocol/rmq999.ts's readProtocolFlags).
*/
const SVC_SERVERINFO = 11;
const PROTOCOL_RMQ = 999;

export interface DemoServerInfoT {
  readonly protocol: number;
  readonly flags: number;
  readonly levelname: string;
}

export function readDemoServerInfo(path: string): DemoServerInfoT | null {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  let p = buf.indexOf(0x0a); // the cd-track line
  if (p < 0) return null;
  p += 1;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p + 16 <= buf.length) {
    const len = view.getInt32(p, true);
    p += 16; // length + three view angles
    if (len < 0 || p + len > buf.length) return null;
    const info = scanServerInfo(buf, view, p, p + len);
    if (info !== null) return info;
    p += len;
  }
  return null;
}

/*
svc_serverinfo is not necessarily the first opcode in the message the client
recorded -- the server's own "VERSION ... SERVER" svc_print goes out ahead of
it in the same packet -- so the message body is scanned for the opcode and the
find is confirmed by the fields that follow it: one of the three protocol
numbers, a maxclients in range, a gametype of 0 or 1, and a printable
NUL-terminated level name.
*/
function scanServerInfo(buf: Uint8Array, view: DataView, from: number, to: number): DemoServerInfoT | null {
  for (let i = from; i + 12 < to; i++) {
    if (buf[i] !== SVC_SERVERINFO) continue;
    let q = i + 1;
    const protocol = view.getInt32(q, true);
    if (protocol !== 15 && protocol !== 666 && protocol !== PROTOCOL_RMQ) continue;
    q += 4;
    let flags = 0;
    if (protocol === PROTOCOL_RMQ) {
      flags = view.getInt32(q, true);
      q += 4;
    }
    const maxclients = buf[q];
    const gametype = buf[q + 1];
    if (maxclients < 1 || maxclients > 16 || gametype > 1) continue;
    q += 2;
    let levelname = "";
    while (q < to && buf[q] !== 0) {
      levelname += String.fromCharCode(buf[q] & 0x7f);
      q++;
    }
    if (q >= to) continue;
    return { protocol, flags, levelname };
  }
  return null;
}

/** The path `record` reported, out of the client's own `recording to <path>.` line. */
export function recordedDemoPath(text: string): string | null {
  const m = /recording to (\S+)\./.exec(text);
  return m === null ? null : m[1];
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

/** The `Server protocol <n> (flags 0x<f>)` line the server printed for its current map. */
export function serverProtocolLine(text: string): { protocol: number; flags: number } | null {
  const all = [...text.matchAll(/Server protocol (\d+) \(flags 0x([0-9a-f]+)\)/g)];
  if (all.length === 0) return null;
  const m = all[all.length - 1];
  return { protocol: Number(m[1]), flags: parseInt(m[2], 16) };
}

/** The `Server ruleset <id>` line the server printed for its current map. */
export function serverRuleset(text: string): string | null {
  const all = [...text.matchAll(/Server ruleset (\w+)/g)];
  return all.length === 0 ? null : all[all.length - 1][1];
}

/*
The negotiated protocol as the CLIENT saw it, read straight off F20's
`Client protocol <n> (flags 0x<f>)` line (src/client/cl_parse.ts's
CL_ParseServerInfo on NetQuake, gated on SS_IsPrimary; src/qw/client/
cl_parse.ts's unconditionally) rather than out of a recorded demo. This is
the primary observable for "what protocol/flags did the client negotiate" --
readDemoServerInfo above stays available as a fallback cross-check against
what actually landed in a recorded .dem, but no longer the only way to ask
the client side of the question.
*/
export function clientProtocolLine(text: string): { protocol: number; flags: number } | null {
  const all = [...text.matchAll(/Client protocol (\d+) \(flags 0x([0-9a-f]+)\)/g)];
  if (all.length === 0) return null;
  const m = all[all.length - 1];
  return { protocol: Number(m[1]), flags: parseInt(m[2], 16) };
}

/*
The level title the client printed out of the serverinfo. CL_ParseServerInfo
prints it as `Con_Printf("%c%s\n", 2, str)`, and Sys_Printf renders a control
byte as `[NN]`, so the line on the log is `[02]the Slipgate Complex`.
*/
export function clientLevelTitle(text: string): string | null {
  const all = [...text.matchAll(/\[02\](.+)/g)];
  return all.length === 0 ? null : all[all.length - 1][1].trim();
}
