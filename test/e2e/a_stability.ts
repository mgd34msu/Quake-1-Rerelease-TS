// Scenario 8: long-run stability. --mode idle (3 min of scripted movement on
// a map with monsters) or --mode demoloop (delegated to a_demos.ts).
import { boot, cmd, pump, waitInGame, shot, state, jlog, svPlayerOrigin } from "./a_lib";
import { sv } from "../../src/server/server";

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
await shot("stability_end", out);
jlog("stabEnd", { elapsedS: Math.round((Date.now() - t0) / 1000), frames, mem: mem(), state: state() });
console.log("[A] DONE");
process.exit(0);
