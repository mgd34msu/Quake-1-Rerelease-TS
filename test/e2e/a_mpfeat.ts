// Scenario 3 (features): mission-pack progs-specific weapons via give/impulse.
import { boot, cmd, pump, waitInGame, shot, state, jlog } from "./a_lib";
import { cl } from "../../src/client/client";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const out = arg("out", "/tmp/a_mpfeat");
const map = arg("map", "hip1m1");
const tag = arg("tag", "hip");
const extra = arg("extra", "").split(" ").filter((s) => s.length > 0);
const impulses = arg("impulses", "1,2,3,4,5,6,7,8").split(",");

boot(["-vid_ref", "soft", ...extra]);
await pump(20);
cmd(`map ${map}`);
const f = await waitInGame(600);
jlog("mpMap", { pack: tag, map, waitFrames: f, state: state() });
await pump(40);

cmd("give all");
await pump(10);
jlog("giveAll", { pack: tag, items: cl.items, health: cl.stats[0] });
cmd("impulse 9");
await pump(20);
jlog("impulse9", { pack: tag, items: cl.items, health: cl.stats[0], armor: cl.stats[4] });
const base = await shot(`${tag}_impulse9`, out);
jlog("impulse9Shot", { pack: tag, shot: base });

for (const i of impulses) {
  cmd(`impulse ${i}`);
  await pump(15);
  const p = await shot(`${tag}_w${i}`, out);
  jlog("mpWeapon", { pack: tag, impulse: i, items: cl.items, ammo: cl.stats[3], shot: p });
}
console.log("[A] DONE");
process.exit(0);
