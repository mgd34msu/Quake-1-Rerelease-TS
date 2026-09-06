// Scenario 6: demo playback, timedemo, record/stop/playback.
// Modes: --mode play | --mode timedemo | --mode record | --mode playrec | --mode loop
import { existsSync, statSync } from "node:fs";
import { boot, cmd, pump, shot, state, jlog, waitInGame, gamedir } from "./a_lib";
import { cls } from "../../src/client/client";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const mode = arg("mode", "play");
const out = arg("out", "/tmp/a_shots_demo");

boot(["-vid_ref", "soft"]);
await pump(20);
cmd("disconnect");
await pump(10);

async function playOne(name: string, maxFrames: number, shotAt: number): Promise<void> {
  const t0 = Date.now();
  cmd(`playdemo ${name}`);
  let started = false;
  let frames = 0;
  let shotPath: string | null = null;
  for (let i = 0; i < maxFrames; i++) {
    await pump(1);
    frames++;
    if (cls.demoplayback) started = true;
    if (started && i === shotAt) shotPath = await shot(`demo_${name}`, out);
    if (started && !cls.demoplayback) break;
  }
  jlog("playdemo", {
    demo: name,
    started,
    finished: !cls.demoplayback,
    frames,
    shot: shotPath,
    ms: Date.now() - t0,
    state: state(),
  });
  cmd("disconnect");
  await pump(10);
}

if (mode === "play") {
  for (const d of ["demo1", "demo2", "demo3"]) await playOne(d, 3000, 120);
} else if (mode === "timedemo") {
  for (const d of ["demo1", "demo2", "demo3"]) {
    const t0 = Date.now();
    cmd(`timedemo ${d}`);
    let started = false;
    let frames = 0;
    for (let i = 0; i < 20000; i++) {
      await pump(1, 0.05, 0);
      frames++;
      if (cls.demoplayback) started = true;
      if (started && !cls.demoplayback) break;
    }
    jlog("timedemo", { demo: d, started, frames, wallMs: Date.now() - t0, state: state() });
    cmd("disconnect");
    await pump(10);
  }
} else if (mode === "record") {
  cmd("record e2edemo e1m1");
  const wf = await waitInGame(600);
  jlog("recordStart", { waitFrames: wf, recording: cls.demorecording, state: state() });
  cmd("noclip");
  await pump(5);
  cmd("+forward");
  await pump(150);
  cmd("-forward");
  await pump(30);
  await shot("recording", out);
  cmd("stop");
  await pump(20);
  const p = `${gamedir()}/e2edemo.dem`;
  jlog("recordStop", {
    path: p,
    exists: existsSync(p),
    size: existsSync(p) ? statSync(p).size : 0,
    recording: cls.demorecording,
  });
} else if (mode === "playrec") {
  const p = `${gamedir()}/e2edemo.dem`;
  jlog("playrecStart", { path: p, exists: existsSync(p), size: existsSync(p) ? statSync(p).size : 0 });
  await playOne("e2edemo", 3000, 60);
  // stopdemo mid-playback
  cmd("playdemo e2edemo");
  await pump(60);
  const before = cls.demoplayback;
  cmd("stopdemo");
  await pump(20);
  jlog("stopdemo", { playingBefore: before, playingAfter: cls.demoplayback, state: state() });
} else if (mode === "loop") {
  for (let i = 0; i < 5; i++) {
    console.log(`[A] === demo1 loop ${i + 1}/5 ===`);
    const mem0 = process.memoryUsage();
    await playOne("demo1", 3000, -1);
    const mem1 = process.memoryUsage();
    jlog("loopMem", { iter: i + 1, heapMB: +(mem1.heapUsed / 1048576).toFixed(1), rssMB: +(mem1.rss / 1048576).toFixed(1), heapDeltaMB: +((mem1.heapUsed - mem0.heapUsed) / 1048576).toFixed(1) });
  }
}

console.log("[A] DONE");
process.exit(0);
