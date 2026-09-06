// Jump / bunny-hop measurement driver. Not a bun:test suite.
//
//   SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/p_jump.ts [map] [jumps]
//
// Spawns test/e2e/p_jump_sv.ts (a real qwsv with call-through spies on
// pmove.ts's PlayerMove and sv_send.ts's SV_StartSound), connects one
// in-process qwcl to it, and drives repeated jump cycles while walking and
// turning, so the resting height under the player varies.
//
// Then it counts the user-reported symptom: the QC PlayerJump sound
// ("player/plyrjmp8.wav", played from PlayerPreThink when button2 +
// FL_ONGROUND + FL_JUMPRELEASED) fired for a command whose PlayerMove did NOT
// add the +270 of pmove.c's JumpButton, and prints which JumpButton branch
// bailed for each such command.
import { Sys_Main_Init, runFrames } from "../../src/qw/main_cl";
import { NET_Ready } from "../../src/qw/net_udp";
import { Cbuf_AddText } from "../../src/common/cmd";
import { cl, cls } from "../../src/client/client";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { Q1TS_DATA, Q1TS_REPO } from "./q1data";

const BASEDIR = Q1TS_DATA;
const REPO = Q1TS_REPO;
const OUT = process.env.P_OUT ?? "/tmp/p_jump";
const CA_ACTIVE = 5;

const MAP = process.argv[2] ?? "dm3";
const JUMPS = Number(process.argv[3] ?? 200);
const PORT = Number(process.env.P_PORT ?? 27731);
const MODE = process.argv[4] ?? "settle";

interface Rec {
  seq: number;
  msec: number;
  buttons: number;
  oldbuttonsBefore: number;
  oldbuttonsAfter: number;
  dead: boolean;
  waterjumptime: number;
  flags: number;
  lastFlags: number;
  onground: number;
  ongroundAfter: number;
  waterlevel: number;
  watertype: number;
  gap: number;
  originZ: number;
  feetZ: number;
  velBefore: number[];
  velAfter: number[];
  sounds: string[];
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}/${MAP}.jsonl`;
rmSync(LOG, { force: true });

const proc = Bun.spawn(
  [
    "bun",
    `${REPO}/test/e2e/p_jump_sv.ts`,
    "-basedir",
    BASEDIR,
    "-port",
    String(PORT),
    "-jumplog",
    LOG,
    "+map",
    MAP,
  ],
  {
    cwd: REPO,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  },
);

let svOut = "";
const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
  const dec = new TextDecoder();
  for await (const chunk of stream) svOut += dec.decode(chunk);
};
void drain(proc.stdout);
void drain(proc.stderr);

for (let i = 0; i < 400 && !svOut.includes("UDP Initialized"); i++) await Bun.sleep(50);
await Bun.sleep(600);
if (!svOut.includes("UDP Initialized")) {
  console.log("server never came up:\n" + svOut.slice(-3000));
  process.exit(1);
}

Sys_Main_Init(["qwcl", "-basedir", BASEDIR, "-nosound", "+connect", `127.0.0.1:${PORT}`]);
await NET_Ready();

const FRAME = 0.014; // 1/72 + a hair, so every Host_Frame passes the cl_maxfps gate
const SLEEP = Number(process.env.P_SLEEP ?? 2); // wall-clock ms between client frames
const JITTER = Number(process.env.P_JITTER ?? 0); // extra seconds of frame time, randomised
function step(n: number): void {
  for (let i = 0; i < n; i++) runFrames(1, FRAME + Math.random() * JITTER);
}
async function pump(frames: number, sleepMs = 2): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await Bun.sleep(sleepMs);
    step(1);
  }
}
function exec(s: string): void {
  Cbuf_AddText(s + "\n");
}

exec("cl_maxfps 72");
await pump(60, 8);
for (let i = 0; i < 400 && cls.state !== CA_ACTIVE; i++) await pump(4, 8);
if (cls.state !== CA_ACTIVE) {
  console.log("client never reached ca_active, state=", cls.state, "\n" + svOut.slice(-3000));
  proc.kill();
  process.exit(1);
}
console.log(`connected to ${MAP} on ${PORT}`);

// Walk and turn continuously so the player wanders over stairs, ramps and
// ledges and the resting height under him keeps changing. The yaw is
// rewritten every frame: dm3's teleporters send svc_setangle, which would
// otherwise pin the view.
let yaw = 0;
// The client's own predicted vertical velocity, sampled once a frame. A
// press the server honoured but the prediction did not is what the player
// actually sees as "I heard the jump but did not jump".
let predictedJumps = 0;
let prevSimVz = 0;
async function walk(frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    yaw = (yaw + 1.7) % 360;
    cl.viewangles[0] = 0;
    cl.viewangles[1] = yaw;
    cl.viewangles[2] = 0;
    await Bun.sleep(SLEEP);
    step(1);
    const vz = cl.qw.simvel[2];
    if (vz > 100 && vz - prevSimVz > 150) predictedJumps++;
    prevSimVz = vz;
  }
}

// settle on the floor before the first jump
exec("+forward");
await walk(80);

// MODE "settle": one deliberate press per landing, 48 frames apart.
// MODE "spam":   space tapped every third frame while running, which is how
//                a player actually bunny-hops -- a press lands on the
//                touchdown frame, on the frame before it, and on the frame
//                after it, in turn.
for (let j = 0; j < JUMPS; j++) {
  if (j % 3 === 0) exec(j % 6 === 0 ? "+moveleft" : "-moveleft");
  if (j % 4 === 0) exec(j % 8 === 0 ? "+moveright" : "-moveright");
  // "hold": the button is pressed while still airborne and kept down across
  // the landing -- how a player actually times a bunny hop.
  const down = MODE === "spam" ? 1 : MODE === "hold" ? 26 : 2;
  const up = MODE === "spam" ? 2 : MODE === "hold" ? 24 : 48;
  exec("+jump");
  await walk(down);
  exec("-jump");
  await walk(up);
}
exec("-forward");
exec("-moveleft");
exec("-moveright");
await walk(40);

proc.kill();
await Bun.sleep(400);

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  return typeof v === "number" ? v : 0;
}
function nums(o: Record<string, unknown>, k: string): number[] {
  const v = o[k];
  return Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : 0)) : [0, 0, 0];
}
function strs(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function parseRec(line: string): Rec {
  const v: unknown = JSON.parse(line);
  if (typeof v !== "object" || v === null) throw new Error("bad record");
  const o: Record<string, unknown> = { ...v };
  return {
    seq: num(o, "seq"),
    msec: num(o, "msec"),
    buttons: num(o, "buttons"),
    oldbuttonsBefore: num(o, "oldbuttonsBefore"),
    oldbuttonsAfter: num(o, "oldbuttonsAfter"),
    dead: o.dead === true,
    waterjumptime: num(o, "waterjumptime"),
    flags: num(o, "flags"),
    lastFlags: num(o, "lastFlags"),
    onground: num(o, "onground"),
    ongroundAfter: num(o, "ongroundAfter"),
    waterlevel: num(o, "waterlevel"),
    watertype: num(o, "watertype"),
    gap: num(o, "gap"),
    originZ: num(o, "originZ"),
    feetZ: num(o, "feetZ"),
    velBefore: nums(o, "velBefore"),
    velAfter: nums(o, "velAfter"),
    sounds: strs(o, "sounds"),
  };
}

const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
const recs: Rec[] = lines.map(parseRec);

const FL_JUMPRELEASED = 4096;
const JUMPSND = "player/plyrjmp8.wav";

let soundCount = 0;
let jumpCount = 0;
let velMismatch = 0;
const bad: Rec[] = [];
const jumpNoSound: Rec[] = [];
for (const r of recs) {
  const sounded = r.sounds.includes(JUMPSND);
  // pmove.c JumpButton's own condition, from the state the spy measured
  const jumped =
    !r.dead &&
    !r.waterjumptime &&
    r.waterlevel < 2 &&
    (r.buttons & 2) !== 0 &&
    r.onground !== -1 &&
    (r.oldbuttonsBefore & 2) === 0;
  if (jumped && r.velAfter[2] - r.velBefore[2] < 200) velMismatch++;
  if (sounded) soundCount++;
  if (jumped) jumpCount++;
  if (sounded && !jumped) bad.push(r);
  if (jumped && !sounded) jumpNoSound.push(r);
}

function branch(r: Rec): string {
  if (r.dead) return "dead";
  if (r.waterjumptime) return "waterjumptime";
  if (r.waterlevel >= 2) return "waterlevel>=2";
  if (!(r.buttons & 2)) return "no BUTTON_JUMP in cmd";
  if (r.onground === -1) return `onground==-1 (gap ${r.gap.toFixed(4)})`;
  if (r.oldbuttonsBefore & 2) return "oldbuttons & BUTTON_JUMP (pogo latch)";
  return "unknown";
}

console.log(`\n=== ${MAP} (${MODE}): ${recs.length} commands, ${soundCount} jump sounds, ${jumpCount} +270s`);
console.log(`sound-without-jump events: ${bad.length}`);
console.log(`jump-without-sound events: ${jumpNoSound.length}`);
console.log(`JumpButton fired but velocity[2] did not rise 200: ${velMismatch}`);
console.log(`client-predicted jumps (simvel[2] step > 150): ${predictedJumps}`);
const byBranch = new Map<string, number>();
for (const r of bad) {
  const b = branch(r);
  byBranch.set(b, (byBranch.get(b) ?? 0) + 1);
}
for (const [b, n] of byBranch) console.log(`  ${n}  ${b}`);
for (const r of bad.slice(0, 25)) {
  console.log(
    `  seq=${r.seq} msec=${r.msec} buttons=${r.buttons} oldbtn=${r.oldbuttonsBefore}->${r.oldbuttonsAfter} ` +
      `onground=${r.onground} gap=${r.gap.toFixed(5)} originZ=${r.originZ.toFixed(5)} ` +
      `wl=${r.waterlevel} wj=${r.waterjumptime} flags=${r.flags} lastFlags=${r.lastFlags} ` +
      `vz ${r.velBefore[2].toFixed(2)}->${r.velAfter[2].toFixed(2)} :: ${branch(r)}`,
  );
}

// gap distribution over every command that had BUTTON_JUMP set and was
// standing still enough to be a jump attempt
const gaps = recs.filter((r) => r.buttons & 2).map((r) => r.gap);
gaps.sort((a, b) => a - b);
if (gaps.length) {
  const q = (f: number): string => gaps[Math.min(gaps.length - 1, Math.floor(f * gaps.length))].toFixed(5);
  console.log(`gap over ${gaps.length} BUTTON_JUMP cmds: min ${q(0)} p25 ${q(0.25)} p50 ${q(0.5)} p75 ${q(0.75)} max ${q(0.999)}`);
}

console.log(`log: ${LOG}`);
process.exit(bad.length === 0 ? 0 : 2);
