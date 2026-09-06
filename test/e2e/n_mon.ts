// N sweep, category 5: monster behaviour.
import { cl } from "../../src/client/client";
import { PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import { FL_NOTARGET, FL_GODMODE } from "../../src/server/server";
import { STAT_HEALTH, STAT_TOTALMONSTERS } from "../../src/common/quakedef";
import {
  boot, cmd, frames, waitInGame, loadMap, liveEdicts, classOf, edictIndex,
  check, info, summary, giveAll, player, place, freeze, losSpot, aim, qcFloat, center,
} from "./n_lib";
import { SV_Move, MOVE_NORMAL } from "../../src/server/world";

function byClass(cn: string): EdictT[] {
  return liveEdicts().filter((e) => classOf(e) === cn);
}

/**
 * ogre.qc's OgreFireGrenade never assigns missile.classname (unlike
 * weapons.qc's W_FireGrenade), so an ogre's grenade is identified by model.
 */
function liveGrenadeModels(): number {
  return liveEdicts().filter((e) => PR_GetString(e.v.model) === "progs/grenade.mdl").length;
}

function god(on: boolean): void {
  const pl = player();
  if (on) pl.v.flags = (pl.v.flags | 0) | FL_GODMODE;
  else pl.v.flags = (pl.v.flags | 0) & ~FL_GODMODE;
}

function notarget(on: boolean): void {
  const pl = player();
  if (on) pl.v.flags = (pl.v.flags | 0) | FL_NOTARGET;
  else pl.v.flags = (pl.v.flags | 0) & ~FL_NOTARGET;
}

/**
 * Stand in a monster's line of sight (frozen so it stays a stationary target)
 * and report what happened to the player over `nframes`.
 */
function faceOff(m: EdictT, nframes: number, minR = 200, maxR = 600): {
  ok: boolean; minHp: number; enemy: number; dist: number; proj: number; inflictor: number;
} {
  const spot = losSpot(m, minR, maxR);
  if (!spot) return { ok: false, minHp: NaN, enemy: 0, dist: NaN, proj: 0, inflictor: 0 };
  const pl = player();
  pl.v.health = 100;
  place(spot.stand, spot.yaw, spot.pitch);
  freeze();
  let minHp = 100;
  let enemy = 0;
  let proj = 0;
  let inflictor = 0;
  const target = edictIndex(m);
  for (let i = 0; i < nframes; i++) {
    aim(spot.yaw, spot.pitch);
    pl.v.origin[0] = spot.stand[0];
    pl.v.origin[1] = spot.stand[1];
    pl.v.origin[2] = spot.stand[2];
    pl.v.velocity[0] = pl.v.velocity[1] = pl.v.velocity[2] = 0;
    frames(1);
    if (m.free) break;
    if ((m.v.enemy | 0) !== 0) enemy = m.v.enemy | 0;
    if (cl.stats[STAT_HEALTH] < minHp) {
      minHp = cl.stats[STAT_HEALTH];
      const inf = pl.v.dmg_inflictor | 0;
      if (inf !== 0) inflictor = inf;
    }
    const n = liveGrenadeModels();
    if (n > proj) proj = n;
    if (inflictor === target && minHp < 100) break;
  }
  return { ok: true, minHp, enemy, dist: spot.dist, proj, inflictor };
}

boot(["+map", "e1m1"]);
if (waitInGame() < 0) { console.log("##N FATAL boot"); process.exit(1); }
frames(20);

/* -------- 5a: monster_army sees the player and shoots ------------------- */
{
  god(false); notarget(false);
  const soldiers = byClass("monster_army");
  info("5a", `e1m1 monster_army=${soldiers.length}`);
  let done = false;
  for (const m of soldiers) {
    const r = faceOff(m, 200);
    if (!r.ok) continue;
    info("5a", `#${edictIndex(m)} at ${Math.round(r.dist)} units: monster.enemy=#${r.enemy}, ` +
      `player health 100 -> ${r.minHp}, player.dmg_inflictor=#${r.inflictor}`);
    if (r.enemy !== 0) {
      check("5a-sight", true, `monster_army acquired the player as its enemy (self.enemy = #${r.enemy})`);
      check("5a-shoots", r.minHp < 100, `its fire cost the player health (100 -> ${r.minHp}) at ${Math.round(r.dist)} units`);
      done = true;
      break;
    }
  }
  if (!done) check("5a-sight", false, "no monster_army acquired the player on e1m1");
}

/* -------- 5d: notarget stops them --------------------------------------- */
{
  if (loadMap("e1m1")) {
    frames(20);
    god(false); notarget(true);
    const soldiers = byClass("monster_army");
    let worst = 100;
    let anyEnemy = 0;
    let tried = 0;
    for (const m of soldiers.slice(0, 4)) {
      const r = faceOff(m, 120);
      if (!r.ok) continue;
      tried++;
      if (r.enemy !== 0) anyEnemy = r.enemy;
      if (r.minHp < worst) worst = r.minHp;
    }
    info("5d", `notarget on: ${tried} monster_army faced, any enemy acquired=#${anyEnemy}, worst player health=${worst}`);
    check("5d-notarget", tried > 0 && anyEnemy === 0 && worst === 100,
      `with FL_NOTARGET set, ${tried} monster_army never acquired the player and did no damage (health stayed ${worst})`);
    notarget(false);
  } else check("5d-notarget", false, "e1m1 failed to load");
}

/* -------- 5b: monster_dog bites ----------------------------------------- */
// A dog has no ranged attack, so the evidence is the player's dmg_inflictor
// naming this dog after it closes the distance.
{
  let done = false;
  for (const map of ["e1m1", "e2m1", "e3m1", "e4m1"]) {
    if (done) break;
    if (!loadMap(map)) continue;
    frames(20);
    god(false); notarget(false);
    const dogs = byClass("monster_dog");
    info("5b", `${map} monster_dog=${dogs.length}`);
    for (const d of dogs) {
      const idx = edictIndex(d);
      const r = faceOff(d, 300, 100, 450);
      if (!r.ok) continue;
      info("5b", `${map} #${idx} at ${Math.round(r.dist)} units: enemy=#${r.enemy}, ` +
        `player health 100 -> ${r.minHp}, dmg_inflictor=#${r.inflictor}`);
      if (r.inflictor === idx) {
        check("5b-dog", true,
          `monster_dog #${idx} on ${map} closed and bit the player (dmg_inflictor names it; health 100 -> ${r.minHp})`);
        done = true;
        break;
      }
      if (player().v.health <= 0) { // died to something else -- start clean
        if (!loadMap(map)) break;
        frames(20);
        god(false); notarget(false);
      }
    }
  }
  if (!done) check("5b-dog", false, "no monster_dog was recorded as the player's damage inflictor on e1m1/e2m1/e3m1/e4m1");
}

/* -------- 5c: monster_ogre throws grenades ------------------------------ */
{
  let done = false;
  for (const map of ["e1m2", "e1m4", "e1m5", "e2m3"]) {
    if (done) break;
    if (!loadMap(map)) continue;
    frames(20);
    god(true); notarget(false); // survive long enough to watch it throw
    const ogres = byClass("monster_ogre");
    info("5c", `${map} monster_ogre=${ogres.length}`);
    for (const o of ogres) {
      const spot = losSpot(o, 250, 700);
      if (!spot) continue;
      const pl = player();
      pl.v.health = 100;
      place(spot.stand, spot.yaw, spot.pitch);
      freeze();
      let proj = 0;
      let enemy = 0;
      for (let i = 0; i < 700; i++) { // 35 s
        aim(spot.yaw, spot.pitch);
        pl.v.origin[0] = spot.stand[0];
        pl.v.origin[1] = spot.stand[1];
        pl.v.origin[2] = spot.stand[2];
        pl.v.velocity[0] = pl.v.velocity[1] = pl.v.velocity[2] = 0;
        frames(1);
        if (o.free) break;
        if ((o.v.enemy | 0) !== 0) enemy = o.v.enemy | 0;
        const n = liveGrenadeModels();
        if (n > proj) proj = n;
        if (proj > 0) break;
      }
      info("5c", `${map} #${edictIndex(o)} at ${Math.round(spot.dist)} units: enemy=#${enemy}, ` +
        `peak live progs/grenade.mdl entities=${proj}`);
      if (proj > 0) {
        check("5c-ogre", true,
          `monster_ogre #${edictIndex(o)} on ${map} lobbed grenades at the player ` +
          `(peak ${proj} live progs/grenade.mdl entities; OgreFireGrenade leaves classname empty)`);
        done = true;
        break;
      }
    }
  }
  if (!done) check("5c-ogre", false, "no monster_ogre threw a grenade on e1m2/e1m4/e1m5/e2m3");
}

/* -------- 5f: zombies go down and get back up --------------------------- */
// zombie.qc's zombie_pain always resets health to 60, so a hit shows up as
// inpain (a QuakeC field), not as a health drop: 25+ damage sets inpain 2 and
// runs zombie_paine1 (knocked flat); it stands up a few seconds later.
{
  let done = false;
  for (const map of ["start", "e1m3", "e2m2"]) {
    if (done) break;
    if (!loadMap(map)) continue;
    frames(20);
    god(true); giveAll(); frames(10);
    const zombies = byClass("monster_zombie");
    // SPAWN_CRUCIFIED zombies skip walkmonster_start, so they never get
    // takedamage = DAMAGE_AIM: they are scenery and cannot be hurt.
    const cruc = zombies.filter((z) => z.v.takedamage === 0);
    info("5f", `${map} monster_zombie=${zombies.length}, of which ${cruc.length} are crucified ` +
      `(takedamage 0, spawnflags ${Array.from(new Set(cruc.map((z) => z.v.spawnflags))).join(",")})`);
    for (const z of zombies) {
      if (z.v.takedamage === 0) continue; // crucified scenery
      const spot = losSpot(z, 100, 500);
      if (!spot) continue;
      const pl = player();
      place(spot.stand, spot.yaw, spot.pitch);
      freeze();
      frames(4);
      cmd("impulse 3"); frames(8);

      // confirm the shot geometry before pulling the trigger
      const src = Float32Array.of(
        pl.v.origin[0], pl.v.origin[1], pl.v.absmin[2] + (pl.v.maxs[2] - pl.v.mins[2]) * 0.7);
      const c = center(z);
      const d = [c[0] - src[0], c[1] - src[1], c[2] - src[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const end = Float32Array.of(
        src[0] + (d[0] / len) * 2048, src[1] + (d[1] / len) * 2048, src[2] + (d[2] / len) * 2048);
      const tr = SV_Move(src, Float32Array.of(0, 0, 0), Float32Array.of(0, 0, 0), end, MOVE_NORMAL, pl);
      const hitsZombie = tr.ent === z;

      let sawDown = false;
      let gotUp = false;
      const inpainSeen = new Set<number>();
      const framesSeen = new Set<number>();
      const shells0 = cl.stats[6];
      cmd("+attack");
      for (let i = 0; i < 60; i++) {
        aim(spot.yaw, spot.pitch);
        pl.v.origin[0] = spot.stand[0]; pl.v.origin[1] = spot.stand[1]; pl.v.origin[2] = spot.stand[2];
        pl.v.velocity[0] = pl.v.velocity[1] = pl.v.velocity[2] = 0;
        frames(1);
        if (z.free) break;
        inpainSeen.add(qcFloat(z, "inpain"));
        framesSeen.add(z.v.frame);
        if (qcFloat(z, "inpain") === 2) sawDown = true;
      }
      cmd("-attack");
      for (let i = 0; i < 300 && sawDown && !gotUp; i++) {
        frames(1);
        if (z.free) break;
        if (qcFloat(z, "inpain") !== 2) gotUp = true;
      }
      info("5f", `${map} #${edictIndex(z)} at ${Math.round(spot.dist)} units: ` +
        `pre-shot trace hits the zombie=${hitsZombie} (hit #${tr.ent ? edictIndex(tr.ent) : -1} ` +
        `'${tr.ent ? classOf(tr.ent) : "?"}' frac=${tr.fraction.toFixed(3)}), ` +
        `shells ${shells0} -> ${cl.stats[6]}, inpain seen=${Array.from(inpainSeen).join(",")}, ` +
        `distinct frames=${framesSeen.size}, health=${z.free ? "freed" : z.v.health}, ` +
        `down=${sawDown} up=${gotUp}`);
      if (sawDown) {
        check("5f-zombie-down", true,
          `a super-shotgun burst knocked the zombie flat on ${map} (inpain reached 2 -> zombie_paine1)`);
        check("5f-zombie-up", gotUp, `it stood back up afterwards (inpain left 2)`);
        check("5f-zombie-alive", !z.free && z.v.health === 60,
          `zombie_pain reset its health to 60 and gunfire alone did not kill it (health=${z.free ? "freed" : z.v.health})`);
        done = true;
        break;
      }
    }
  }
  if (!done) check("5f-zombie-down", false, "no zombie was knocked down on start/e1m3/e2m2");
}

/* -------- 5e: skill 0 vs skill 3 ---------------------------------------- */
{
  const counts: Record<string, number> = {};
  let errors = 0;
  for (const sk of ["0", "3"]) {
    cmd(`skill ${sk}`);
    frames(6);
    if (!loadMap("e1m1")) { errors++; continue; }
    frames(30);
    const monsters = liveEdicts().filter((e) => ((e.v.flags | 0) & 32) !== 0); // FL_MONSTER
    counts[sk] = monsters.length;
    info("5e", `skill ${sk}: ${monsters.length} live monsters, STAT_TOTALMONSTERS=${cl.stats[STAT_TOTALMONSTERS]}`);
  }
  check("5e-skill", errors === 0 && counts["0"] !== undefined && counts["3"] !== undefined,
    `e1m1 loaded and ran cleanly on skill 0 (${counts["0"]} monsters) and skill 3 (${counts["3"]} monsters); ` +
    `${counts["0"] === counts["3"] ? "e1m1 has no skill-gated monsters, so the counts match" : "skill-gated monsters changed the count"}`);
  cmd("skill 1"); frames(4);
}

summary("monsters");
process.exit(0);
