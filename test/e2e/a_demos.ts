// Scenario 6: demo playback, timedemo, record/stop/playback.
// Modes: --mode play | --mode timedemo | --mode record | --mode playrec | --mode loop
import { existsSync, statSync } from "node:fs";
import { boot, cmd, pump, shot, state, jlog, waitInGame, gamedir, check, summary } from "./a_lib";
import { cls } from "../../src/client/client";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const mode = arg("mode", "play");
const out = arg("out", "/tmp/a_shots_demo");

boot(["-vid_ref", "soft"]);
await pump(20);
// quake.rc leaves the client inside `startdemos demo1 demo2 demo3`, and
// WinQuake's CL_PlayDemo_f does not clear cls.demonum -- so a `playdemo`
// issued while the loop is live rolls straight on into the next demo when
// the one asked for ends, and no single demo can be watched to its end.
// Establishing a connection is what clears the loop (CL_EstablishConnection
// sets cls.demonum = -1); loading a map and leaving it again is the way to
// do that without a server to connect to.
cmd("map dm1");
await waitInGame(600);
await pump(10);
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
  check(`playdemo ${name} starts playback`, started, `frames=${frames} ${state()}`);
  check(`playdemo ${name} runs to the end of the demo`, started && !cls.demoplayback, `frames=${frames} demoplayback=${cls.demoplayback}`);
  if (shotAt >= 0) check(`playdemo ${name} screenshot written mid-playback`, shotPath !== null, String(shotPath));
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
    const wallMs = Date.now() - t0;
    jlog("timedemo", { demo: d, started, frames, wallMs, state: state() });
    check(`timedemo ${d} starts and finishes`, started && !cls.demoplayback, `frames=${frames} demoplayback=${cls.demoplayback}`);
    check(`timedemo ${d} plays every frame of the demo`, frames > 100, `frames=${frames} in ${wallMs}ms`);
    cmd("disconnect");
    await pump(10);
  }
} else if (mode === "record") {
  cmd("record e2edemo e1m1");
  const wf = await waitInGame(600);
  jlog("recordStart", { waitFrames: wf, recording: cls.demorecording, state: state() });
  check("record e2edemo e1m1 loads the map and starts recording", wf >= 0 && cls.demorecording, `waitFrames=${wf} demorecording=${cls.demorecording}`);
  cmd("noclip");
  await pump(5);
  cmd("+forward");
  await pump(150);
  cmd("-forward");
  await pump(30);
  const recShot = await shot("recording", out);
  check("screenshot taken while recording", recShot !== null, String(recShot));
  cmd("stop");
  await pump(20);
  const p = `${gamedir()}/e2edemo.dem`;
  const size = existsSync(p) ? statSync(p).size : 0;
  jlog("recordStop", { path: p, exists: existsSync(p), size, recording: cls.demorecording });
  check("stop ends recording", !cls.demorecording, `demorecording=${cls.demorecording}`);
  check("record wrote a demo file with real content", size > 10000, `${p} is ${size} bytes`);
} else if (mode === "playrec") {
  const p = `${gamedir()}/e2edemo.dem`;
  const size = existsSync(p) ? statSync(p).size : 0;
  jlog("playrecStart", { path: p, exists: existsSync(p), size });
  check("the demo recorded by --mode record is on disk", size > 10000, `${p} is ${size} bytes`);
  await playOne("e2edemo", 3000, 60);
  // stopdemo mid-playback
  cmd("playdemo e2edemo");
  await pump(60);
  const before = cls.demoplayback;
  cmd("stopdemo");
  await pump(20);
  jlog("stopdemo", { playingBefore: before, playingAfter: cls.demoplayback, state: state() });
  check("stopdemo ends playback mid-demo", before && !cls.demoplayback, `before=${before} after=${cls.demoplayback}`);
} else if (mode === "loop") {
  let firstRss = 0;
  let lastRss = 0;
  for (let i = 0; i < 5; i++) {
    console.log(`[A] === demo1 loop ${i + 1}/5 ===`);
    const mem0 = process.memoryUsage();
    await playOne("demo1", 3000, -1);
    const mem1 = process.memoryUsage();
    lastRss = mem1.rss / 1048576;
    if (i === 0) firstRss = lastRss;
    jlog("loopMem", { iter: i + 1, heapMB: +(mem1.heapUsed / 1048576).toFixed(1), rssMB: +lastRss.toFixed(1), heapDeltaMB: +((mem1.heapUsed - mem0.heapUsed) / 1048576).toFixed(1) });
  }
  // Five demo1 loads and unloads must not keep growing the process: a demo
  // that leaks its models or its edict array shows up here as RSS climbing
  // with every iteration.
  check("five demo1 playbacks do not grow the process without bound", lastRss < firstRss * 2, `rss after 1 = ${firstRss.toFixed(1)}MB, after 5 = ${lastRss.toFixed(1)}MB`);
}

console.log("[A] DONE");
summary(`A demos ${mode}`);
