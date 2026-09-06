// N: find an open standing spot from which a traceline reaches the shootable trigger.
import { sv } from "../../src/server/server";
import { SV_Move, MOVE_NORMAL, SV_PointContents } from "../../src/server/world";
import { vec3 } from "../../src/common/mathlib";
import { boot, waitInGame, liveEdicts, classOf, center, edictIndex, info } from "./n_lib";

boot(["+map", process.argv[2] ?? "start"]);
if (waitInGame() < 0) { console.log("FATAL"); process.exit(1); }

const shootables = liveEdicts().filter((e) => e.v.health > 0 && e.v.takedamage > 0 && classOf(e).startsWith("trigger"));
const trig = shootables[0];
if (!trig) { console.log("no shootable trigger"); process.exit(1); }
const c = center(trig);
info("trigger", `#${edictIndex(trig)} centre=[${c.map(Math.round)}] absmin=[${Array.from(trig.v.absmin)}] absmax=[${Array.from(trig.v.absmax)}]`);

const p = sv.edicts[1];
const target = vec3();
target[0] = c[0]; target[1] = c[1]; target[2] = c[2];

const hits: string[] = [];
for (let dx = -256; dx <= 256; dx += 32) {
  for (let dy = -256; dy <= 256; dy += 32) {
    for (let dz = -64; dz <= 96; dz += 16) {
      const s = vec3();
      s[0] = c[0] + dx; s[1] = c[1] + dy; s[2] = c[2] + dz;
      if (SV_PointContents(s) !== -1) continue; // want CONTENTS_EMPTY
      const dir = [target[0] - s[0], target[1] - s[1], target[2] - s[2]];
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      if (len < 8) continue;
      const end = vec3();
      for (let i = 0; i < 3; i++) end[i] = s[i] + (dir[i] / len) * 2048;
      const tr = SV_Move(s, vec3(), vec3(), end, MOVE_NORMAL, p);
      if (tr.ent === trig) {
        hits.push(`[${Math.round(s[0])},${Math.round(s[1])},${Math.round(s[2])}] dist=${Math.round(len)} frac=${tr.fraction.toFixed(3)}`);
      }
    }
  }
}
console.log(`##N hits=${hits.length}`);
for (const h of hits.slice(0, 40)) console.log("  " + h);
process.exit(0);
