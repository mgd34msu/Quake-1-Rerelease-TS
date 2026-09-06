// Scenario 8: long-run stability. --mode idle (3 min of scripted movement on
// a map with monsters) or --mode demoloop (delegated to a_demos.ts).
import { boot, cmd, pump, waitInGame, shot, state, jlog, svPlayerOrigin, check, summary, engineErrors } from "./a_lib";
import { sv } from "../../src/server/server";
import { inGame } from "./a_lib";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const out = arg("out", "/tmp/a_stab");
const map = arg("map", "e1m1");
const seconds = Number(arg("seconds", "180"));

function mem(): Record<string, number> {
  const m = process.memoryUsage();
  return { rssMB: +(m.rss / 1048576).toFixed(1), heapMB: +(m.heapUsed / 1048576).toFixed(1), extMB: +(m.external / 1048576).toFixed(1) };
}

boot(["-vid_ref", "soft"]);
await pump(20);
cmd(`map ${map}`);
const f = await waitInGame(600);
jlog("stabStart", { map, waitFrames: f, mem: mem(), state: state() });
check(`${map} loads for the soak`, f >= 0, `waitFrames=${f} ${state()}`);
const startMem = mem();
await pump(30);
cmd("god");
cmd("noclip");
await pump(10);

const t0 = Date.now();
const moves = ["+forward", "+left", "+back", "+right"];
let mi = 0;
let frames = 0;
let lastReport = 0;
while ((Date.now() - t0) / 1000 < seconds) {
  const m = moves[mi % moves.length];
  cmd(m);
  await pump(40);
  cmd(m.replace("+", "-"));
  await pump(5);
  cmd(`impulse ${(mi % 8) + 1}`);
  frames += 45;
  mi++;
  const elapsed = (Date.now() - t0) / 1000;
  if (elapsed - lastReport >= 30) {
    lastReport = elapsed;
    jlog("stabTick", { elapsedS: Math.round(elapsed), frames, mem: mem(), origin: svPlayerOrigin(), num_edicts: sv.num_edicts, state: state() });
  }
}
const endShot = await shot("stability_end", out);
const endMem = mem();
const elapsed = Math.round((Date.now() - t0) / 1000);
jlog("stabEnd", { elapsedS: elapsed, frames, mem: endMem, state: state() });
check(`the soak ran the full ${seconds}s`, elapsed >= seconds, `elapsed=${elapsed}s`);
check("no exception escaped Host_Frame during the soak", engineErrors.length === 0, engineErrors.slice(0, 3).join(" | "));
check("the client is still in the level at the end of the soak", inGame() && sv.active, state());
check("the server did not leak entities over the soak", sv.num_edicts < 600, `sv.num_edicts=${sv.num_edicts}`);
// A soak that leaks the frame's allocations shows up as RSS climbing without
// bound; three minutes of play must not multiply it.
check("resident memory did not grow without bound", endMem.rssMB < startMem.rssMB * 3 + 128, `rss ${startMem.rssMB}MB -> ${endMem.rssMB}MB`);
check("screenshot at the end of the soak", endShot !== null, String(endShot));
console.log("[A] DONE");
summary(`A stability ${map} ${seconds}s`);
