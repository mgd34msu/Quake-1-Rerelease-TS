// N sweep, category 1: shooting things.
// NOTE on classnames: doors.qc's func_door AND func_door_secret both set
// self.classname = "door" at spawn, plats.qc sets "plat"/"train". So runtime
// scans use those names, not the map's editor classnames.
import { cl } from "../../src/client/client";
import { PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import {
  boot, cmd, frames, waitInGame, loadMap, findByClass, liveEdicts, classOf,
  center, edictIndex, check, info, summary, losSpot, giveAll, player,
  shootAndWatch, qcFloat, qcVec,
} from "./n_lib";
import { STAT_MONSTERS, STAT_TOTALMONSTERS } from "../../src/common/quakedef";

function targetsOf(name: string): EdictT[] {
  if (name === "") return [];
  return liveEdicts().filter((e) => PR_GetString(e.v.targetname) === name);
}

function shootable(cn: string): EdictT[] {
  return liveEdicts().filter((e) => classOf(e) === cn && e.v.health > 0 && e.v.takedamage > 0);
}

boot(["+map", "e1m1"]);
if (waitInGame() < 0) { console.log("##N FATAL boot"); process.exit(1); }
cmd("god"); frames(4);

/* -------- 1a: monster_army takes damage, dies, bumps killed_monsters ---- */
{
  giveAll();
  const soldiers = findByClass("monster_army");
  info("1a", `e1m1 live monster_army=${soldiers.length}, STAT_TOTALMONSTERS=${cl.stats[STAT_TOTALMONSTERS]}`);
  let done = false;
  for (const m of soldiers) {
    const spot = losSpot(m, 64, 400);
    if (!spot) continue;
    const before = cl.stats[STAT_MONSTERS];
    const hp = m.v.health;
    const r = shootAndWatch(m, 3, [], 60, 40, spot);
    const after = cl.stats[STAT_MONSTERS];
    info("1a", `#${edictIndex(m)} health ${hp} -> ${r.minHealth}; killed_monsters ${before} -> ${after}; dist=${Math.round(spot.dist)}`);
    check("1a-damage", r.minHealth < hp, `monster_army took damage (${hp} -> ${r.minHealth})`);
    check("1a-death", r.minHealth <= 0, `monster_army died (minHealth=${r.minHealth})`);
    check("1a-stat", after > before, `killed_monsters stat ${before} -> ${after}`);
    done = true;
    break;
  }
  if (!done) check("1a-damage", false, "no monster_army with line of sight on e1m1");
}

/* -------- 1b: misc_explobox --------------------------------------------- */
{
  const boxes = findByClass("misc_explobox");
  info("1b", `e1m1 misc_explobox=${boxes.length}`);
  let done = false;
  for (const b of boxes) {
    const spot = losSpot(b, 96, 400);
    if (!spot) continue;
    const bc = center(b);
    const witness = liveEdicts().find(
      (e) => e.v.health > 0 && e.v.takedamage > 0 && e !== b && e !== player() &&
        Math.hypot(center(e)[0] - bc[0], center(e)[1] - bc[1], center(e)[2] - bc[2]) < 180,
    ) ?? null;
    const wHp = witness ? witness.v.health : NaN;
    const hp = b.v.health;
    const r = shootAndWatch(b, 3, [], 40, 60, spot);
    info("1b", `#${edictIndex(b)} health ${hp} -> ${r.minHealth}, freed=${b.free}; ` +
      `witness=${witness ? `#${edictIndex(witness)} ${classOf(witness)} ${wHp} -> ${witness.free ? "freed" : witness.v.health}` : "none"}`);
    check("1b-explode", b.free || r.minHealth <= 0, `misc_explobox destroyed (free=${b.free}, minHealth=${r.minHealth})`);
    if (witness) {
      check("1b-splash", witness.free || witness.v.health < wHp,
        `nearby entity took splash damage (${wHp} -> ${witness.free ? "freed" : witness.v.health})`);
    }
    done = true;
    break;
  }
  if (!done) check("1b-explode", false, "no misc_explobox with line of sight on e1m1");
}

/* -------- 1e: shootable trigger_multiple with a target (e1m1) ----------- */
{
  const trigs = liveEdicts().filter(
    (e) => classOf(e) === "trigger_multiple" && e.v.health > 0 && e.v.takedamage > 0 && PR_GetString(e.v.target) !== "",
  );
  info("1e", `e1m1 shootable trigger_multiple with target=${trigs.length}`);
  let done = false;
  for (const t of trigs) {
    const tn = PR_GetString(t.v.target);
    const tgts = targetsOf(tn);
    if (tgts.length === 0) continue;
    const spot = losSpot(t, 48, 320);
    if (!spot) continue;
    const r = shootAndWatch(t, 3, tgts, 40, 100, spot);
    info("1e", `#${edictIndex(t)} target='${tn}' -> ${tgts.map((d) => `#${edictIndex(d)} ${classOf(d)}`).join(",")}; ` +
      `minHealth=${r.minHealth}; peak displacement=${r.moved.map((v) => v.toFixed(1)).join(",")}`);
    check("1e-damage", r.minHealth <= 0, `shootable trigger_multiple killed (minHealth=${r.minHealth})`);
    check("1e-opens", r.moved.some((v) => v > 1), `its targeted door moved (peak ${Math.max(...r.moved).toFixed(1)} units)`);
    done = true;
    break;
  }
  if (!done) check("1e-opens", false, "no shootable trigger_multiple with a resolvable target on e1m1");
}

/* -------- 1g: func_door_secret with health (untargeted secret doors) ----- */
// doors.qc's func_door_secret gives every secret door with no targetname
// health 10000 + th_pain/th_die = fd_secret_use, so any damage opens it.
{
  const secrets = liveEdicts().filter(
    (e) => classOf(e) === "door" && e.v.health >= 10000 && e.v.takedamage > 0,
  );
  info("1g", `e1m1 shootable secret doors (health>=10000)=${secrets.length}`);
  let done = false;
  for (const d of secrets) {
    const spot = losSpot(d, 48, 320);
    if (!spot) continue;
    const r = shootAndWatch(d, 3, [d], 30, 120, spot);
    info("1g", `#${edictIndex(d)} health=${d.v.health} peak displacement=${r.moved[0].toFixed(1)} ` +
      `origin now [${Array.from(d.v.origin).map(Math.round)}]`);
    check("1g-secret", r.moved[0] > 1, `func_door_secret opened when shot (moved ${r.moved[0].toFixed(1)} units)`);
    done = true;
    break;
  }
  if (!done) check("1g-secret", false, "no shootable func_door_secret with line of sight on e1m1");
}

/* -------- 1c: func_button with health (e1m2) ---------------------------- */
// buttons.qc's button_killed immediately restores self.health = self.max_health
// and sets takedamage = DAMAGE_NO, so the kill shows up as takedamage going
// to 0 and the target moving, not as health reaching 0.
if (loadMap("e1m2")) {
  cmd("god"); frames(4); giveAll();
  const buttons = shootable("func_button");
  info("1c", `e1m2 shootable func_button=${buttons.length}`);
  let done = false;
  for (const b of buttons) {
    const tn = PR_GetString(b.v.target);
    const tgts = targetsOf(tn);
    const spot = losSpot(b, 48, 320);
    if (!spot) continue;
    const pos1 = qcVec(b, "pos1");
    const pos2 = qcVec(b, "pos2");
    const lip = qcFloat(b, "lip");
    info("1c", `#${edictIndex(b)} pos1=[${pos1.map((v) => v.toFixed(1))}] pos2=[${pos2.map((v) => v.toFixed(1))}] ` +
      `lip=${lip} size=[${Array.from(b.v.size).map(Math.round)}] movedir=[${Array.from(b.v.movedir).map((v) => v.toFixed(2))}] ` +
      `travel=${Math.hypot(pos2[0] - pos1[0], pos2[1] - pos1[1], pos2[2] - pos1[2]).toFixed(2)}`);
    const r = shootAndWatch(b, 3, [b, ...tgts], 40, 60, spot);
    info("1c", `#${edictIndex(b)} target='${tn}' (${tgts.length} ents) minHealth=${r.minHealth} ` +
      `takedamageCleared=${r.sawTakedamageOff} peak displacement button=${r.moved[0].toFixed(1)} ` +
      `targets=${r.moved.slice(1).map((v) => v.toFixed(1)).join(",")}`);
    check("1c-shot", r.sawTakedamageOff, `func_button registered the hit (button_killed cleared takedamage=${r.sawTakedamageOff})`);
    const travel = Math.hypot(pos2[0] - pos1[0], pos2[1] - pos1[1], pos2[2] - pos1[2]);
    check("1c-fires", travel < 1 ? true : r.moved[0] > 1,
      travel < 1
        ? `this button's own travel is 0 by map data (pos1 == pos2, lip=${lip} vs size), so no movement is expected; the fire path is proved by the target instead`
        : `the button itself moved in (${r.moved[0].toFixed(1)} of ${travel.toFixed(1)} units)`);
    check("1c-target", r.moved.slice(1).some((v) => v > 1),
      `its target moved (${r.moved.slice(1).map((v) => v.toFixed(1)).join(",")})`);
    done = true;
    break;
  }
  if (!done) check("1c-fires", false, "no shootable func_button with line of sight on e1m2");
} else check("1c-fires", false, "e1m2 failed to load");

/* -------- 1d: func_door with health (e3m2 / e4m5) ----------------------- */
{
  let done = false;
  for (const map of ["e3m2", "e4m5", "e4m7"]) {
    if (done) break;
    if (!loadMap(map)) { info("1d", `${map} failed to load`); continue; }
    cmd("god"); frames(4); giveAll();
    // a shoot-to-open func_door: classname "door", health set, but not a
    // secret door's 10000
    const doors = liveEdicts().filter(
      (e) => classOf(e) === "door" && e.v.takedamage > 0 && e.v.health > 0 && e.v.health < 10000,
    );
    info("1d", `${map} shootable func_door=${doors.length}`);
    for (const d of doors) {
      const spot = losSpot(d, 48, 320);
      if (!spot) continue;
      const r = shootAndWatch(d, 3, [d], 30, 120, spot);
      info("1d", `${map} #${edictIndex(d)} health=${d.v.health} minHealth=${r.minHealth} ` +
        `peak displacement=${r.moved[0].toFixed(1)} spawnflags=${d.v.spawnflags}`);
      check("1d-shot", r.minHealth <= 0 || r.sawTakedamageOff, `func_door registered the hit (minHealth=${r.minHealth})`);
      check("1d-opens", r.moved[0] > 1, `shot-to-open func_door moved (${r.moved[0].toFixed(1)} units) on ${map}`);
      done = true;
      break;
    }
  }
  if (!done) check("1d-opens", false, "no shootable func_door with line of sight on e3m2/e4m5/e4m7");
}

summary("shoot");
process.exit(0);
