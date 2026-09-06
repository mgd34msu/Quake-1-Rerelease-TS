// Scenario 3 (features): mission-pack progs-specific weapons via give/impulse.
import { boot, cmd, pump, waitInGame, shot, state, jlog, check, summary } from "./a_lib";
import { cl } from "../../src/client/client";
import { sv } from "../../src/server/server";

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
check(`${tag}: ${map} loads under its own progs`, f >= 0 && sv.name === map, `waitFrames=${f} sv.name=${sv.name}`);
await pump(40);

cmd("give all");
await pump(10);
jlog("giveAll", { pack: tag, items: cl.items, health: cl.stats[0] });
cmd("impulse 9");
await pump(20);
jlog("impulse9", { pack: tag, items: cl.items, health: cl.stats[0], armor: cl.stats[4] });
// impulse 9 is the mission packs' all-weapons cheat too: the eight id1
// weapon bits plus the pack's own extras, and 200 of every ammo type.
check(`${tag}: impulse 9 gives the id1 weapon set`, (cl.items & 0x7f) === 0x7f && (cl.items & 4096) !== 0, `cl.items=${cl.items}`);
check(`${tag}: impulse 9 fills the ammo counters`, cl.stats[6] > 0 && cl.stats[7] > 0 && cl.stats[8] > 0 && cl.stats[9] > 0, `shells=${cl.stats[6]} nails=${cl.stats[7]} rockets=${cl.stats[8]} cells=${cl.stats[9]}`);
// CheatCommand grants both keys as well (IT_KEY1 131072, IT_KEY2 262144);
// it grants no armor, in id1 or in either mission pack.
check(`${tag}: impulse 9 gives both keys`, (cl.items & 131072) !== 0 && (cl.items & 262144) !== 0, `cl.items=${cl.items}`);
const base = await shot(`${tag}_impulse9`, out);
jlog("impulse9Shot", { pack: tag, shot: base });
check(`${tag}: screenshot after impulse 9`, base !== null, String(base));

const seen = new Set<number>();
for (const i of impulses) {
  cmd(`impulse ${i}`);
  await pump(15);
  const p = await shot(`${tag}_w${i}`, out);
  const w = sv.edicts?.[1]?.v.weapon ?? -1;
  seen.add(w);
  jlog("mpWeapon", { pack: tag, impulse: i, weapon: w, items: cl.items, ammo: cl.stats[3], shot: p });
  check(`${tag}: impulse ${i} selects a weapon the player owns`, w > 0 && (cl.items & w) !== 0, `self.weapon=${w} cl.items=${cl.items}`);
  check(`${tag}: impulse ${i} screenshot written`, p !== null, String(p));
}
check(`${tag}: the weapon impulses select ${impulses.length} distinct weapons`, seen.size === impulses.length, `selected ${seen.size} of ${impulses.length}: [${Array.from(seen).join(",")}]`);
console.log("[A] DONE");
summary(`A mpfeat ${tag}`);
