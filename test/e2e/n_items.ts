// N sweep, category 3 (pickups) and 6 (weapons).
import { cl } from "../../src/client/client";
import { PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import {
  STAT_HEALTH, STAT_SHELLS, STAT_NAILS, STAT_ROCKETS, STAT_CELLS,
  STAT_ARMOR, STAT_ACTIVEWEAPON, STAT_WEAPONFRAME,
  IT_SHOTGUN, IT_SUPER_SHOTGUN, IT_NAILGUN, IT_QUAD,
} from "../../src/common/quakedef";
import {
  boot, cmd, frames, waitInGame, loadMap, liveEdicts, classOf, edictIndex,
  check, info, summary, giveAll, player, standAt, insideSpot, center, aim,
  qcFloat, losSpot, place, freeze,
} from "./n_lib";

function byClass(cn: string): EdictT[] {
  return liveEdicts().filter((e) => classOf(e) === cn);
}

/**
 * items.qc's DropBackpack spawns the pack with spawn() and never assigns a
 * classname, so dropped backpacks are identified by their model.
 */
function backpacks(): EdictT[] {
  return liveEdicts().filter((e) => PR_GetString(e.v.model) === "progs/backpack.mdl");
}

/** Stand on an item until it is taken (goes SOLID_NOT / model cleared). */
function pickUp(item: EdictT, nframes = 30): boolean {
  const spot = insideSpot(item) ?? center(item);
  standAt(spot, nframes);
  frames(4);
  return item.free || item.v.solid === 0 || item.v.modelindex === 0;
}

boot(["+map", "e1m1"]);
if (waitInGame() < 0) { console.log("##N FATAL boot"); process.exit(1); }
cmd("god"); frames(10);
const p = player();

/* ================= category 3: pickups ================================== */

/* -------- 3a/3b: item_health, each healtype ----------------------------- */
// items.qc: healamount 25 (healtype 1, normal), 15 (healtype 0, rotten),
// 100 (healtype 2, megahealth, ignores max_health and rots afterwards).
{
  const heals = byClass("item_health");
  const kinds = new Map<number, EdictT[]>();
  for (const h of heals) {
    const t = qcFloat(h, "healtype");
    kinds.set(t, [...(kinds.get(t) ?? []), h]);
  }
  info("3a", `e1m1 item_health=${heals.length}; healtypes present: ` +
    Array.from(kinds.entries()).map(([t, v]) => `${t}x${v.length}`).join(" "));

  for (const [type, list] of Array.from(kinds.entries()).sort((a, b) => a[0] - b[0])) {
    let done = false;
    for (const h of list) {
      if (h.free || h.v.solid === 0) continue;
      const amount = qcFloat(h, "healamount");
      p.v.health = type === 2 ? 100 : 40;
      frames(2);
      const before = cl.stats[STAT_HEALTH];
      const taken = pickUp(h, 30);
      frames(4);
      const after = cl.stats[STAT_HEALTH];
      info("3a", `healtype=${type} #${edictIndex(h)} spawnflags=${h.v.spawnflags} healamount=${amount} ` +
        `taken=${taken} health ${before} -> ${after}`);
      if (!taken || after === before) continue;
      if (type === 2) {
        check("3b-mega", after > 100 && after === before + amount,
          `megahealth pushed health past max_health (${before} -> ${after}, healamount=${amount})`);
      } else {
        check(`3a-health-${type}`, after - before === amount,
          `item_health (healtype ${type}) healed exactly its healamount (${before} -> ${after}, healamount=${amount})`);
      }
      done = true;
      break;
    }
    if (!done) check(type === 2 ? "3b-mega" : `3a-health-${type}`, false,
      `no usable item_health of healtype ${type} on e1m1`);
  }
}

/* -------- 3c: item_shells ----------------------------------------------- */
{
  const shells = byClass("item_shells");
  info("3c", `e1m1 item_shells=${shells.length}`);
  let done = false;
  for (const s of shells) {
    p.v.ammo_shells = 0;
    frames(2);
    const before = cl.stats[STAT_SHELLS];
    const taken = pickUp(s, 30);
    frames(4);
    const after = cl.stats[STAT_SHELLS];
    info("3c", `#${edictIndex(s)} spawnflags=${s.v.spawnflags} taken=${taken} shells ${before} -> ${after}`);
    if (taken && after > before) {
      check("3c-shells", after === 20 || after === 40, `item_shells gave the standard 20 (or 40 for BIG): ${before} -> ${after}`);
      done = true;
      break;
    }
  }
  if (!done) check("3c-shells", false, "no item_shells could be picked up on e1m1");
}

/* -------- 3d: item_armor1 ----------------------------------------------- */
{
  const armors = byClass("item_armor1");
  info("3d", `e1m1 item_armor1=${armors.length}`);
  let done = false;
  for (const a of armors) {
    p.v.armorvalue = 0;
    p.v.armortype = 0;
    frames(2);
    const before = cl.stats[STAT_ARMOR];
    const taken = pickUp(a, 30);
    frames(4);
    const after = cl.stats[STAT_ARMOR];
    info("3d", `#${edictIndex(a)} taken=${taken} armor ${before} -> ${after} armortype=${p.v.armortype}`);
    if (taken && after > before) {
      check("3d-armor", after === 100 && Math.abs(p.v.armortype - 0.3) < 0.01,
        `item_armor1 (green) gave 100 armour at armortype 0.3 (got ${after} / ${p.v.armortype.toFixed(2)})`);
      done = true;
      break;
    }
  }
  if (!done) check("3d-armor", false, "no item_armor1 could be picked up on e1m1");
}

/* -------- 3e: weapon pickups set the cl.items bit ----------------------- */
{
  for (const [cn, bit, label] of [
    ["weapon_supershotgun", IT_SUPER_SHOTGUN, "IT_SUPER_SHOTGUN"],
    ["weapon_nailgun", IT_NAILGUN, "IT_NAILGUN"],
  ] as const) {
    const ws = byClass(cn);
    let done = false;
    for (const w of ws) {
      p.v.items = p.v.items & ~bit;
      frames(2);
      const before = cl.items & bit;
      const taken = pickUp(w, 30);
      frames(6);
      const after = cl.items & bit;
      info("3e", `${cn} #${edictIndex(w)} taken=${taken} cl.items&${label} ${before} -> ${after}`);
      if (taken && after !== 0) {
        check(`3e-${cn}`, before === 0 && after !== 0, `${cn} pickup set ${label} in cl.items`);
        done = true;
        break;
      }
    }
    if (!done) check(`3e-${cn}`, false, `no ${cn} could be picked up on e1m1`);
  }
}

/* -------- 3f: quad damage and its 30 s timer ---------------------------- */
{
  const quads = byClass("item_artifact_super_damage");
  info("3f", `e1m1 quads=${quads.length}`);
  let done = false;
  for (const q of quads) {
    p.v.items = p.v.items & ~IT_QUAD;
    frames(2);
    const taken = pickUp(q, 30);
    frames(6);
    const on = (cl.items & IT_QUAD) !== 0;
    const finish = qcFloat(p, "super_damage_finished");
    info("3f", `#${edictIndex(q)} taken=${taken} IT_QUAD=${on} super_damage_finished=${finish.toFixed(1)}`);
    if (!on) continue;
    // let the 30 s run out
    let offAt = -1;
    for (let i = 0; i < 800; i++) {
      frames(1);
      if ((cl.items & IT_QUAD) === 0) { offAt = i * 0.05; break; }
    }
    info("3f", `IT_QUAD cleared after ${offAt.toFixed(1)} s of game time`);
    check("3f-quad", on, "item_artifact_super_damage set IT_QUAD in cl.items");
    check("3f-quad-timer", offAt > 25 && offAt < 35,
      `quad expired after ~30 s (${offAt.toFixed(1)} s)`);
    done = true;
    break;
  }
  if (!done) check("3f-quad", false, "no quad could be picked up on e1m1");
}

/* -------- 3g: backpacks dropped by killed monsters ---------------------- */
// soldier.qc's army_die sets self.ammo_shells = 5 and calls DropBackpack().
if (loadMap("e1m1")) {
  cmd("god"); frames(10); giveAll();
  const soldiers = byClass("monster_army");
  let done = false;
  for (const m of soldiers) {
    const spot = losSpot(m, 64, 400);
    if (!spot) continue;
    const packsBefore = backpacks().length;
    place(spot.stand, spot.yaw, spot.pitch);
    freeze();
    frames(4);
    cmd("impulse 3"); frames(6);
    cmd("+attack");
    for (let i = 0; i < 60; i++) { aim(spot.yaw, spot.pitch); frames(1); if (m.free || m.v.health <= 0) break; }
    cmd("-attack");
    frames(60);
    const packs = backpacks();
    info("3g", `killed monster_army #${edictIndex(m)}; backpacks ${packsBefore} -> ${packs.length}`);
    if (packs.length > packsBefore) {
      const pack = packs[packs.length - 1];
      const shellsBefore = cl.stats[STAT_SHELLS];
      player().v.ammo_shells = 0;
      frames(2);
      const taken = pickUp(pack, 40);
      frames(6);
      info("3g", `backpack #${edictIndex(pack)} taken=${taken} shells ${shellsBefore} -> ${cl.stats[STAT_SHELLS]}`);
      check("3g-backpack", packs.length > packsBefore,
        `a killed monster_army dropped a backpack (progs/backpack.mdl; DropBackpack leaves classname empty)`);
      check("3g-backpack-pickup", taken && cl.stats[STAT_SHELLS] > 0,
        `the backpack was picked up and gave ammo (shells now ${cl.stats[STAT_SHELLS]})`);
      done = true;
      break;
    }
  }
  if (!done) check("3g-backpack", false, "no killed monster_army dropped a backpack on e1m1");
}

/* ================= category 6: weapons ================================== */

if (loadMap("e1m1")) {
  cmd("god"); frames(10);
  const before9 = cl.items;
  giveAll();
  frames(10);
  info("6", `impulse 9: cl.items 0x${before9.toString(16)} -> 0x${cl.items.toString(16)}, ` +
    `shells=${cl.stats[STAT_SHELLS]} nails=${cl.stats[STAT_NAILS]} rockets=${cl.stats[STAT_ROCKETS]} cells=${cl.stats[STAT_CELLS]}`);
  check("6-impulse9", (cl.items & IT_SHOTGUN) !== 0 && (cl.items & IT_SUPER_SHOTGUN) !== 0 &&
    cl.stats[STAT_NAILS] > 0 && cl.stats[STAT_ROCKETS] > 0 && cl.stats[STAT_CELLS] > 0,
    `impulse 9 granted every weapon and ammo (nails=${cl.stats[STAT_NAILS]} rockets=${cl.stats[STAT_ROCKETS]} cells=${cl.stats[STAT_CELLS]})`);

  // stand in the open, facing a wall, and fire each weapon in turn
  const pp = player();
  const home: [number, number, number] = [pp.v.origin[0], pp.v.origin[1], pp.v.origin[2]];
  const weapons: { n: number; name: string; ammo: number | null; projectile: string | null }[] = [
    { n: 1, name: "axe", ammo: null, projectile: null },
    { n: 2, name: "shotgun", ammo: STAT_SHELLS, projectile: null },
    { n: 3, name: "super shotgun", ammo: STAT_SHELLS, projectile: null },
    { n: 4, name: "nailgun", ammo: STAT_NAILS, projectile: "spike" },
    { n: 5, name: "super nailgun", ammo: STAT_NAILS, projectile: "spike" },
    { n: 6, name: "grenade launcher", ammo: STAT_ROCKETS, projectile: "grenade" },
    { n: 7, name: "rocket launcher", ammo: STAT_ROCKETS, projectile: "missile" },
    { n: 8, name: "lightning", ammo: STAT_CELLS, projectile: null },
  ];
  for (const w of weapons) {
    giveAll();
    frames(10);
    place(home, 0, 0);
    freeze();
    frames(4);
    cmd(`impulse ${w.n}`);
    frames(10);
    const active = cl.stats[STAT_ACTIVEWEAPON];
    const ammoBefore = w.ammo === null ? 0 : cl.stats[w.ammo];
    const framesSeen = new Set<number>();
    let projSeen = 0;
    cmd("+attack");
    for (let i = 0; i < 30; i++) {
      aim(0, 0);
      pp.v.origin[0] = home[0]; pp.v.origin[1] = home[1]; pp.v.origin[2] = home[2];
      pp.v.velocity[0] = pp.v.velocity[1] = pp.v.velocity[2] = 0;
      frames(1);
      framesSeen.add(cl.stats[STAT_WEAPONFRAME]);
      if (w.projectile) {
        const n = byClass(w.projectile).length;
        if (n > projSeen) projSeen = n;
      }
    }
    cmd("-attack");
    frames(6);
    const ammoAfter = w.ammo === null ? 0 : cl.stats[w.ammo];
    info("6", `impulse ${w.n} (${w.name}): STAT_ACTIVEWEAPON=${active} ammo ${ammoBefore} -> ${ammoAfter} ` +
      `weaponframes seen=${Array.from(framesSeen).sort((a, b) => a - b).join(",")} ` +
      `${w.projectile ? `peak live '${w.projectile}' entities=${projSeen}` : ""}`);
    check(`6-fire-${w.n}`, framesSeen.size > 1,
      `${w.name} animated (STAT_WEAPONFRAME took ${framesSeen.size} distinct values)`);
    if (w.ammo !== null) {
      check(`6-ammo-${w.n}`, ammoAfter < ammoBefore, `${w.name} consumed ammo (${ammoBefore} -> ${ammoAfter})`);
    }
    if (w.projectile !== null) {
      check(`6-proj-${w.n}`, projSeen > 0, `${w.name} spawned '${w.projectile}' entities (peak ${projSeen})`);
    }
  }

  // impulse 255 = QuadCheat
  place(home, 0, 0); freeze(); frames(4);
  player().v.items = player().v.items & ~IT_QUAD;
  frames(4);
  cmd("impulse 255");
  frames(10);
  info("6", `impulse 255: IT_QUAD=${(cl.items & IT_QUAD) !== 0} super_damage_finished=${qcFloat(player(), "super_damage_finished").toFixed(1)}`);
  check("6-impulse255", (cl.items & IT_QUAD) !== 0, "impulse 255 (QuadCheat) set IT_QUAD");
}

summary("items+weapons");
process.exit(0);
