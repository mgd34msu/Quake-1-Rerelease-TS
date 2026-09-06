// N: focused diagnostic for doors that have no trigger field and so must be
// opened by walking into them (SV_Impact -> door_touch).
import { PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import {
  boot, cmd, frames, waitInGame, loadMap, liveEdicts, classOf, center, edictIndex,
  info, giveAll, player, place, unfreeze, aim, qcFloat, triggerFieldOf, faceSpots,
  losSpots, playerFits, yawTo,
} from "./n_lib";

const map = process.argv[2] ?? "e1m2";
const mode = process.argv[3] ?? "keys";

boot(["+map", map]);
if (waitInGame() < 0) { console.log("FATAL"); process.exit(1); }
cmd("god"); frames(10); giveAll(); frames(10);

const doors = liveEdicts().filter((e) => classOf(e) === "door");
const picks: EdictT[] = mode === "keys"
  ? doors.filter((d) => (d.v.spawnflags & 24) !== 0)
  : doors.filter((d) => qcFloat(d, "wait") === -1 && d.v.health === 0);

info("diag", `${map}: ${doors.length} doors, ${picks.length} picks (mode=${mode})`);

for (const d of picks.slice(0, 6)) {
  const owner = d.v.owner | 0;
  const faces = faceSpots(d);
  const los = losSpots(d, 4, 40, 260);
  info("door", `#${edictIndex(d)} spawnflags=${d.v.spawnflags} items=${d.v.items} wait=${qcFloat(d, "wait")} ` +
    `targetname='${PR_GetString(d.v.targetname)}' health=${d.v.health} solid=${d.v.solid} ` +
    `touch=${d.v.touch} owner=#${owner} field=#${triggerFieldOf(d) ? edictIndex(triggerFieldOf(d) as EdictT) : -1} ` +
    `absmin=[${Array.from(d.v.absmin).map(Math.round)}] absmax=[${Array.from(d.v.absmax).map(Math.round)}] ` +
    `faceSpots=${faces.length} losSpots=${los.length}`);

  const start = Array.from(d.v.origin);
  const cands: [number, number, number][] = [...faces, ...los.map((s) => s.stand)];
  let best = "";
  for (const spot of cands) {
    if (!playerFits(spot)) continue;
    const c = center(d);
    let yaw = yawTo(spot, c);
    place(spot, yaw, 0);
    unfreeze();
    frames(16);
    const p = player();
    yaw = yawTo([p.v.origin[0], p.v.origin[1], p.v.origin[2]], c);
    const af0 = qcFloat(d, "attack_finished");
    cmd("+forward");
    let touched = false;
    for (let i = 0; i < 40; i++) {
      aim(yaw, 0);
      frames(1);
      if (qcFloat(d, "attack_finished") !== af0) touched = true;
      const mv = Math.hypot(d.v.origin[0] - start[0], d.v.origin[1] - start[1], d.v.origin[2] - start[2]);
      if (mv > 1) { best = `MOVED ${mv.toFixed(1)}`; break; }
    }
    cmd("-forward");
    frames(4);
    const p2 = player();
    const gap = Math.max(
      d.v.absmin[0] - p2.v.origin[0], p2.v.origin[0] - d.v.absmax[0],
      d.v.absmin[1] - p2.v.origin[1], p2.v.origin[1] - d.v.absmax[1], 0);
    info("try", `  from [${spot.map(Math.round)}] -> player [${Array.from(p2.v.origin).map(Math.round)}] ` +
      `gap=${gap.toFixed(1)} door_touch ran=${touched} ${best}`);
    if (best) break;
  }
  if (!best) info("try", `  #${edictIndex(d)} never moved`);
}
process.exit(0);
