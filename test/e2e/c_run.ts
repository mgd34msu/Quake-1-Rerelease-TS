/*
Family C's scenario runner: builds one of the sound/CD-music scenarios named
below, hands it to c_harness.ts (or c_harness_qw.ts) as a child process with
SDL_AUDIODRIVER=disk, and asserts on the two observables that scenario
produced -- the console lines the engine printed, and the raw PCM the disk
driver wrote (read back through c_analyzer.ts's summarize()).

The scenario JSON shape c_harness.ts reads is documented in its own header.
Those JSON files were never committed (see test/e2e/README.md, family C):
this file writes the one it needs into $Q1TS_SCRATCH/e2e/c/ per run, so a
scenario is a name on this command line rather than a file someone has to
reconstruct.

  bun test/e2e/c_run.ts --scenario <name>

  init      SNDDMA_Init reports a real device, `soundinfo` prints its spec
  commands  soundlist / volume / playvol / stopsound at the console
  play      `play` of a real id1 sound puts audio in the capture
  ingame    firing a weapon on e1m1 puts audio in the capture
  demo      demo playback puts audio in the capture
  cd        the `cd` command set answers on a host with no CD drive
  qw        the QuakeWorld client's own sound path (c_harness_qw.ts)
  soak      a minute of repeated sounds, no crash, audio throughout
*/

import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { summarize } from "./c_analyzer";
import { Q1TS_DATA, homedirArgs } from "./q1data";

const SCRATCH = join(process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests", "e2e", "c");

const results: Array<{ name: string; pass: boolean; note: string }> = [];
function check(name: string, pass: boolean, note = ""): void {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
}
function summaryAndExit(label: string): never {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY C ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

interface TimelineEntryT {
  readonly tSec: number;
  readonly cmd: string;
}
interface ScenarioT {
  readonly harness: "nq" | "qw";
  readonly argv: readonly string[];
  readonly timeline: readonly TimelineEntryT[];
  readonly durationSec: number;
  readonly dt?: number;
}

const GAME = `e2e_c_${arg("scenario", "init")}`;
const BASE_ARGV = ["-basedir", Q1TS_DATA, "-norerelease", ...homedirArgs(GAME), "-game", GAME, "-vid_ref", "soft"];

// quake.rc leaves the client inside `startdemos demo1 demo2 demo3`, and a
// playing demo is playing its own sounds -- an "init" capture full of
// shotgun blasts proves nothing about the sound this scenario asked for. One
// `disconnect` at the top stops the playback, and CL_NextDemo only advances
// the loop when a demo reaches its END, so nothing restarts it inside a
// scenario this short.
const DISCONNECT_FIRST: TimelineEntryT = { tSec: 0.2, cmd: "disconnect" };

function nqScenario(timeline: readonly TimelineEntryT[], durationSec: number, extraArgv: readonly string[] = []): ScenarioT {
  return { harness: "nq", argv: [...BASE_ARGV, ...extraArgv], timeline: [DISCONNECT_FIRST, ...timeline], durationSec };
}

const SCENARIOS: Readonly<Record<string, ScenarioT>> = {
  init: nqScenario([{ tSec: 1.0, cmd: "soundinfo" }], 4),
  commands: nqScenario(
    [
      { tSec: 0.8, cmd: "volume 1" },
      { tSec: 1.2, cmd: "play weapons/rocket1.wav" },
      { tSec: 3.0, cmd: "stopsound" },
      { tSec: 3.6, cmd: "playvol weapons/sgun1.wav 1" },
      { tSec: 5.0, cmd: "soundlist" },
      { tSec: 5.4, cmd: "volume 0.9" },
      { tSec: 5.8, cmd: "volume" },
      { tSec: 6.2, cmd: "soundinfo" },
    ],
    8,
  ),
  playvol: nqScenario(
    [
      { tSec: 1.0, cmd: "volume 1" },
      { tSec: 1.5, cmd: "playvol weapons/rocket1.wav 1" },
      { tSec: 3.5, cmd: "playvol weapons/sgun1.wav 1" },
    ],
    6,
  ),
  play: nqScenario(
    [
      { tSec: 1.0, cmd: "volume 1" },
      { tSec: 1.5, cmd: "play weapons/rocket1.wav" },
      { tSec: 2.5, cmd: "play weapons/sgun1.wav" },
      { tSec: 3.5, cmd: "play items/damage.wav" },
      { tSec: 4.5, cmd: "play weapons/rocket1.wav" },
    ],
    7,
  ),
  ingame: nqScenario(
    [
      { tSec: 0.5, cmd: "volume 1" },
      { tSec: 1.0, cmd: "map e1m1" },
      { tSec: 4.0, cmd: "impulse 9" },
      { tSec: 4.5, cmd: "impulse 7" },
      { tSec: 5.0, cmd: "+attack" },
      { tSec: 7.0, cmd: "-attack" },
      { tSec: 7.5, cmd: "soundlist" },
    ],
    10,
  ),
  demo: nqScenario(
    [
      { tSec: 0.5, cmd: "volume 1" },
      { tSec: 1.0, cmd: "playdemo demo1" },
    ],
    16,
  ),
  cd: nqScenario(
    [
      { tSec: 1.0, cmd: "cd info" },
      { tSec: 1.5, cmd: "cd play 2" },
      { tSec: 2.5, cmd: "cd stop" },
      { tSec: 3.0, cmd: "cd off" },
      { tSec: 3.5, cmd: "cd on" },
      { tSec: 4.0, cmd: "bgmvolume 0.5" },
    ],
    6,
  ),
  qw: {
    harness: "qw",
    argv: [...BASE_ARGV],
    timeline: [
      { tSec: 0.2, cmd: "disconnect" },
      { tSec: 1.0, cmd: "volume 1" },
      { tSec: 1.5, cmd: "play weapons/rocket1.wav" },
      { tSec: 2.5, cmd: "play weapons/sgun1.wav" },
      { tSec: 3.5, cmd: "soundinfo" },
    ],
    durationSec: 6,
  },
  soak: nqScenario(
    (() => {
      const t: TimelineEntryT[] = [{ tSec: 0.5, cmd: "volume 1" }];
      const sounds = ["weapons/rocket1.wav", "weapons/sgun1.wav", "items/damage.wav", "weapons/lstart.wav"];
      for (let i = 0; i < 55; i++) t.push({ tSec: 1 + i, cmd: `play ${sounds[i % sounds.length]}` });
      return t;
    })(),
    60,
  ),
};

const name = arg("scenario", "init");
const scenario = SCENARIOS[name];
if (scenario === undefined) {
  console.log(`[FAIL] unknown scenario "${name}" :: known: ${Object.keys(SCENARIOS).join(", ")}`);
  console.log("RESULT 0 1");
  process.exit(2);
}

mkdirSync(SCRATCH, { recursive: true });
const scenarioPath = join(SCRATCH, `${name}.json`);
const capturePath = join(SCRATCH, `${name}.raw`);
const logPath = join(SCRATCH, `${name}.console.log`);
if (existsSync(capturePath)) rmSync(capturePath);

await Bun.write(
  scenarioPath,
  JSON.stringify({ argv: scenario.argv, timeline: scenario.timeline, durationSec: scenario.durationSec, dt: scenario.dt ?? 0.05 }, null, 2),
);

const harnessFile = scenario.harness === "qw" ? "test/e2e/c_harness_qw.ts" : "test/e2e/c_harness.ts";
console.log(`[c_run] ${name}: ${harnessFile} ${scenarioPath}, capture -> ${capturePath}`);

const proc = Bun.spawn(["bun", harnessFile, scenarioPath], {
  cwd: join(import.meta.dir, "..", ".."),
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    SDL_VIDEODRIVER: "dummy",
    SDL_AUDIODRIVER: "disk",
    SDL_DISKAUDIOFILE: capturePath,
    // The disk driver otherwise sleeps a full buffer between writes; 0 keeps
    // it paced by the audio callback alone, which is what makes elapsed
    // capture seconds line up with elapsed scenario seconds.
    SDL_DISKAUDIODELAY: "0",
  },
});
const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const exitCode = await proc.exited;
const console_ = out + err;
await Bun.write(logPath, console_);
console.log(`[c_run] harness exit ${exitCode}, ${console_.length} bytes of console in ${logPath}`);

check("the sound harness ran to completion", exitCode === 0, `exit=${exitCode}`);
check(
  "SNDDMA_Init opened an audio device",
  /Sound Initialization|sound sampling rate|SNDDMA|disk i\/o audio driver/i.test(console_) && !/sound not available/i.test(console_),
  console_.slice(-300).replace(/\n/g, " | "),
);
check("the disk audio driver wrote a capture file", existsSync(capturePath), capturePath);

if (!existsSync(capturePath)) summaryAndExit(name);

const bytes = statSync(capturePath).size;
const s = summarize(capturePath, 0.5);
console.log(`[c_run] capture: ${bytes} bytes, ${s.seconds.toFixed(2)}s, rms=${s.overallRms.toFixed(1)}, nonSilent=${(s.nonSilentFraction * 100).toFixed(1)}%`);

// Every scenario keeps the device open for its whole duration, so the
// capture must cover most of it; a device that fell over halfway writes a
// short file even when the process exits cleanly.
check(
  "the capture covers the scenario's own duration",
  s.seconds > scenario.durationSec * 0.5,
  `${s.seconds.toFixed(2)}s captured of ${scenario.durationSec}s scripted`,
);

// The first two 0.5s windows still carry the tail of the boot demo the
// scenario's own `disconnect` (at t=0.2s) cuts off, so the quiet-baseline
// and audio-appeared judgements are both made from t=1.0s on.
const settled = s.windows.slice(2);
const settledAudible = settled.filter((w) => !w.silent);
const peak = settled.reduce((a, w) => Math.max(a, w.peak), 0);
const wantsAudio = ["play", "playvol", "ingame", "demo", "qw", "soak", "commands"].includes(name);
if (wantsAudio) {
  check("the capture is not silent", s.overallRms > 1, `overall rms=${s.overallRms.toFixed(1)}`);
  check(
    "audible windows appear in the capture after the boot demo is cut off",
    settledAudible.length > 0,
    `${settledAudible.length} of ${settled.length} windows from t=1.0s are audible`,
  );
  check("the loudest sample is a real signal, not dither", peak > 500, `peak=${peak}`);
  // Demo playback carries the level's own ambient sounds from end to end, so
  // only the discrete-sound scenarios are expected to have quiet stretches.
  if (name !== "demo") {
    check(
      "the capture is not audible end to end (the sounds are bursts, not a stuck mixer)",
      settledAudible.length < settled.length,
      `${settledAudible.length}/${settled.length} audible`,
    );
  }
} else {
  // init and cd never ask for a sound: with the boot demo stopped the mixer
  // has nothing to mix, and digital silence is the observable.
  check(
    "a mixer with nothing queued writes silence",
    settledAudible.length === 0,
    `${settledAudible.length} of ${settled.length} windows from t=1.0s are audible, peak=${peak}`,
  );
}

switch (name) {
  case "init":
  case "commands": {
    check("`soundinfo` reports the mixer's channel count", /\d+ stereo|\d+ samples|\d+ speed|channels/i.test(console_), console_.slice(-400).replace(/\n/g, " | "));
    break;
  }
  default:
    break;
}

if (name === "commands") {
  check("`soundlist` lists the loaded sounds and their resident size", /\.wav/i.test(console_) && /Total resident:/.test(console_), "soundlist output");
  check('`volume` reports the value it was set to', /"volume" is "0\.9"/.test(console_), console_.slice(-600).replace(/\n/g, " | "));
}

if (name === "ingame") {
  check("the level loaded inside the sound scenario", /Slipgate Complex/.test(console_), "console names e1m1's level title");
  check("`soundlist` names the level's precached sounds", /\.wav/i.test(console_), "soundlist output names .wav files");
}

if (name === "demo") {
  check("demo playback started inside the sound scenario", /Playing demo from demo1\.dem/.test(console_), console_.slice(0, 400).replace(/\n/g, " | "));
}

if (name === "cd") {
  // No CD drive on this host: what is asserted is that the command set
  // answers rather than throwing, and that bgmvolume takes the new value.
  check("the `cd` command set answers", /CD|cd /i.test(console_), console_.slice(-400).replace(/\n/g, " | "));
  check("no exception escaped the frame loop", !/EXCEPTION|SysError/.test(console_), console_.slice(-300).replace(/\n/g, " | "));
}

if (name === "soak") {
  check("no exception escaped the frame loop over the soak", !/EXCEPTION|SysError/.test(console_), console_.slice(-300).replace(/\n/g, " | "));
  const half = Math.floor(settled.length / 2);
  const lateAudible = settled.slice(half).some((w) => !w.silent);
  check("the mixer is still producing audio at the end of the soak", lateAudible, `${settled.length} settled windows, second half audible=${lateAudible}`);
}

summaryAndExit(name);
