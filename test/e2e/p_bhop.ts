// Bunny-hop / air-control measurement driver. Not a bun:test suite.
//
//   SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/p_bhop.ts [map] [hops]
//
// Same instrumented qwsv as p_jump.ts (test/e2e/p_jump_sv.ts). Drives a
// classic QuakeWorld strafe-jump: +forward held, +moveleft/+moveright
// alternated every hop with the view turning the same way, and +jump tapped
// every third frame so a press lands on the frame the player touches down.
//
// Prints the horizontal speed at the top of each hop, plus the msec the
// client actually put in each usercmd.
//
// Caveat: a blind scripted bot walks into geometry within a few hops on every
// retail map, so the speed column here mostly measures how long it took to
// hit a wall. The load-bearing air-control measurement is the deterministic
// one on a synthetic infinite floor in test/qw_pmove.test.ts ("strafe jumping
// gains speed past movevars.maxspeed"), which reaches ~400 from a 200 run.
// This driver is for confirming the msec/cadence half of the pipeline against
// a real server.
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

const MAP = process.argv[2] ?? "dm6";
const HOPS = Number(process.argv[3] ?? 30);
const PORT = Number(process.env.P_PORT ?? 27741);

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}/bhop_${MAP}.jsonl`;
rmSync(LOG, { force: true });

const proc = Bun.spawn(
  ["bun", `${REPO}/test/e2e/p_jump_sv.ts`, "-basedir", BASEDIR, "-port", String(PORT), "-jumplog", LOG, "+map", MAP],
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

Sys_Main_Init(["qwcl", "-basedir", BASEDIR, "-nosound", "+connect", `127.0.0.1:${PORT}`]);
await NET_Ready();

const FRAME = 0.014;
function exec(s: string): void {
  Cbuf_AddText(s + "\n");
}
async function pump(frames: number, sleepMs = 2): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await Bun.sleep(sleepMs);
    runFrames(1, FRAME);
  }
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

let yaw = 0;
exec("+forward");
for (let i = 0; i < 60; i++) {
  cl.viewangles[0] = 0;
  cl.viewangles[1] = yaw;
  cl.viewangles[2] = 0;
  await pump(1);
}

// One "hop" = 42 frames of held strafe + view turn, jump tapped every third
// frame so one press always lands on the touchdown frame.
let left = true;
let jumpDown = false;
for (let h = 0; h < HOPS; h++) {
  exec(left ? "+moveleft" : "+moveright");
  exec(left ? "-moveright" : "-moveleft");
  for (let f = 0; f < 42; f++) {
    yaw += left ? 0.55 : -0.55;
    cl.viewangles[0] = 0;
    cl.viewangles[1] = yaw;
    cl.viewangles[2] = 0;
    if (f % 3 === 0) {
      exec("+jump");
      jumpDown = true;
    } else if (jumpDown) {
      exec("-jump");
      jumpDown = false;
    }
    await pump(1);
  }
  left = !left;
}
exec("-jump");
exec("-forward");
exec("-moveleft");
exec("-moveright");
await pump(30);

proc.kill();
await Bun.sleep(400);

const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
interface Row {
  seq: number;
  msec: number;
  onground: number;
  ongroundAfter: number;
  buttons: number;
  speed: number;
  vz: number;
}
const rows: Row[] = [];
for (const l of lines) {
  const v: unknown = JSON.parse(l);
  if (typeof v !== "object" || v === null) continue;
  const o: Record<string, unknown> = { ...v };
  const va = o.velAfter;
  const vel: number[] = Array.isArray(va) ? va.map((x) => (typeof x === "number" ? x : 0)) : [0, 0, 0];
  const g = (k: string): number => (typeof o[k] === "number" ? Number(o[k]) : 0);
  rows.push({
    seq: g("seq"),
    msec: g("msec"),
    onground: g("onground"),
    ongroundAfter: g("ongroundAfter"),
    buttons: g("buttons"),
    speed: Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]),
    vz: vel[2],
  });
}

// speed at the top of each hop (the frame where vz crosses from + to -)
const peaks: number[] = [];
for (let i = 1; i < rows.length; i++) {
  if (rows[i - 1].vz > 0 && rows[i].vz <= 0 && rows[i].ongroundAfter === -1) peaks.push(rows[i].speed);
}
const msecs = rows.map((r) => r.msec);
console.log(`\n=== bhop ${MAP}: ${rows.length} commands, msec min ${Math.min(...msecs)} max ${Math.max(...msecs)}`);
console.log(`airborne apex speeds (${peaks.length}):`);
console.log(peaks.map((s) => s.toFixed(1)).join(" "));
const maxSpeed = rows.reduce((a, r) => Math.max(a, r.speed), 0);
console.log(`max horizontal speed over the run: ${maxSpeed.toFixed(2)} (sv_maxspeed is 320)`);
console.log(`log: ${LOG}`);
process.exit(0);
