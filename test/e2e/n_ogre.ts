// N: focused diagnostic for monster_ogre's grenade attack (ai.qc CheckAttack ->
// th_missile = ogre_nail1 -> OgreFireGrenade).
import { PR_GetString } from "../../src/progs/progs";
import { FL_GODMODE } from "../../src/server/server";
import {
  boot, frames, waitInGame, liveEdicts, classOf, edictIndex, info,
  player, place, freeze, losSpot, aim, qcFloat,
} from "./n_lib";

const map = process.argv[2] ?? "e1m4";
boot(["+map", map]);
if (waitInGame() < 0) { console.log("FATAL"); process.exit(1); }
frames(20);
const pl = player();
pl.v.flags = (pl.v.flags | 0) | FL_GODMODE;

const ogres = liveEdicts().filter((e) => classOf(e) === "monster_ogre");
info("ogre", `${map}: ${ogres.length} ogres`);

for (const o of ogres.slice(0, 3)) {
  const spot = losSpot(o, 250, 700);
  if (!spot) { info("ogre", `#${edictIndex(o)} no line of sight`); continue; }
  pl.v.health = 100;
  place(spot.stand, spot.yaw, spot.pitch);
  freeze();
  const framesSeen = new Set<number>();
  const classesSeen = new Set<string>();
  let dist = spot.dist;
  let minDist = dist;
  let grenades = 0;
  let modelGrenades = 0;
  for (let i = 0; i < 400; i++) {
    aim(spot.yaw, spot.pitch);
    pl.v.origin[0] = spot.stand[0];
    pl.v.origin[1] = spot.stand[1];
    pl.v.origin[2] = spot.stand[2];
    pl.v.velocity[0] = pl.v.velocity[1] = pl.v.velocity[2] = 0;
    frames(1);
    if (o.free) break;
    framesSeen.add(o.v.frame);
    dist = Math.hypot(
      o.v.origin[0] - pl.v.origin[0], o.v.origin[1] - pl.v.origin[1], o.v.origin[2] - pl.v.origin[2]);
    if (dist < minDist) minDist = dist;
    for (const e of liveEdicts()) {
      const cn = classOf(e);
      if (cn === "grenade") { grenades++; classesSeen.add(cn); }
      if (PR_GetString(e.v.model) === "progs/grenade.mdl") modelGrenades++;
    }
  }
  info("ogre", `#${edictIndex(o)} enemy=#${o.v.enemy | 0} th_missile=${qcFloat(o, "th_missile")} th_melee=${qcFloat(o, "th_melee")} ` +
    `attack_finished=${qcFloat(o, "attack_finished").toFixed(1)} ` +
    `start dist=${Math.round(spot.dist)} min dist=${Math.round(minDist)} ` +
    `frames seen=[${Array.from(framesSeen).sort((a, b) => a - b).join(",")}] ` +
    `grenade-classname sightings=${grenades} grenade-model sightings=${modelGrenades}`);
}
process.exit(0);
