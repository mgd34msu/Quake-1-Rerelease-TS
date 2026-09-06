// N sweep, category 2: touch / use interactions.
import { cl } from "../../src/client/client";
import { PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import { sv } from "../../src/server/server";
import { SV_PointContents as SVPointContents } from "../../src/server/world";
import { STAT_HEALTH, STAT_SECRETS, STAT_TOTALSECRETS, IT_KEY1, IT_KEY2 } from "../../src/common/quakedef";
import {
  boot, cmd, frames, waitInGame, loadMap, liveEdicts, classOf, center,
  edictIndex, check, info, summary, giveAll, player, place, freeze, unfreeze,
  nearSpot, insideSpot, standAt, watchOrigins, centerText, qcFloat, triggerFieldOf,
  walkInto, activate, targetedBy,
} from "./n_lib";

function byClass(cn: string): EdictT[] {
  return liveEdicts().filter((e) => classOf(e) === cn);
}

boot(["+map", "e1m1"]);
if (waitInGame() < 0) { console.log("##N FATAL boot"); process.exit(1); }

/* -------- 2a: func_door opens on approach ------------------------------- */
{
  cmd("god"); frames(4);
  // an ordinary door: classname "door", no key flags, not a secret (health 0)
  const doors = byClass("door").filter((d) => d.v.health === 0 && (d.v.spawnflags & 24) === 0);
  info("2a", `e1m1 ordinary doors=${doors.length}`);
  let done = false;
  for (const d of doors) {
    const field = triggerFieldOf(d);
    const spot = (field ? insideSpot(field) : null) ?? nearSpot(d, 40, 140);
    if (!spot) continue;
    place(spot, 0, 0);
    freeze();
    frames(4);
    const moved = watchOrigins([d], 80)[0];
    info("2a", `#${edictIndex(d)} field=#${field ? edictIndex(field) : -1} standing at [${spot.map(Math.round)}] -> peak displacement ${moved.toFixed(1)}`);
    if (moved > 1) {
      check("2a-door-approach", true, `func_door opened when the player approached (moved ${moved.toFixed(1)} units)`);
      done = true;
      break;
    }
  }
  if (!done) check("2a-door-approach", false, "no ordinary func_door opened on approach on e1m1");
}

/* -------- 2b: a door with wait -1 stays open ---------------------------- */
// doors.qc's LinkDoors spawns the proximity field (door_trigger_touch) only
// for a door with no health, no targetname and no key, so a targeted wait=-1
// door is opened by its trigger, never by bumping into it.
{
  const doors = byClass("door").filter((d) => qcFloat(d, "wait") === -1);
  const allWaits = Array.from(new Set(byClass("door").map((d) => qcFloat(d, "wait"))));
  info("2b", `e1m1 doors with wait=-1: ${doors.length} of ${byClass("door").length} (waits seen: ${allWaits.join(",")})`);
  let done = false;
  for (const d of doors) {
    const start = Array.from(d.v.origin);
    const field = triggerFieldOf(d);
    const tn = PR_GetString(d.v.targetname);
    let how = "";
    if (field) {
      const inside = insideSpot(field);
      if (!inside) continue;
      standAt(inside, 40);
      how = `stood in its trigger field #${edictIndex(field)}`;
    } else {
      const starters = targetedBy(tn).filter((e) => e !== d);
      if (starters.length === 0) continue;
      const hows: string[] = [];
      for (const st of starters) {
        hows.push(`#${edictIndex(st)} ${classOf(st)}:${activate(st)}`);
        frames(20);
        const mv = Math.hypot(
          d.v.origin[0] - start[0], d.v.origin[1] - start[1], d.v.origin[2] - start[2]);
        if (mv > 1) break;
      }
      how = `fired its trigger(s) ${hows.join(", ")}`;
    }
    const opened = Math.max(
      Math.hypot(d.v.origin[0] - start[0], d.v.origin[1] - start[1], d.v.origin[2] - start[2]),
      watchOrigins([d], 60)[0]);
    if (opened <= 1) continue;
    // leave the area and wait well past a normal door's 3 s auto-close
    const far = nearSpot(d, 600, 1600);
    if (far) { place(far, 0, 0); freeze(); }
    frames(240); // 12 seconds
    const stillOpen = Math.hypot(
      d.v.origin[0] - start[0], d.v.origin[1] - start[1], d.v.origin[2] - start[2]);
    info("2b", `#${edictIndex(d)} targetname='${tn}' field=#${field ? edictIndex(field) : -1}; ${how}; ` +
      `opened ${opened.toFixed(1)}; 12 s later displacement ${stillOpen.toFixed(1)}`);
    check("2b-wait-neg1", stillOpen > 1,
      `wait=-1 door stayed open 12 s after being opened (${stillOpen.toFixed(1)} units from closed)`);
    done = true;
    break;
  }
  if (!done) check("2b-wait-neg1", false, `no wait=-1 door could be opened on e1m1 (${doors.length} candidates tried)`);
}

/* -------- 2c: func_plat rises when the player steps on it --------------- */
{
  const plats = byClass("plat");
  info("2c", `e1m1 plats=${plats.length}`);
  let done = false;
  for (const p of plats) {
    const c = center(p);
    const spot: [number, number, number] = [c[0], c[1], p.v.absmax[2] + 30];
    place(spot, 0, 0);
    freeze();
    frames(4);
    const moved = watchOrigins([p], 120)[0];
    info("2c", `#${edictIndex(p)} standing above at [${spot.map(Math.round)}] -> peak displacement ${moved.toFixed(1)}`);
    if (moved > 1) {
      check("2c-plat", true, `func_plat moved when the player stood on it (${moved.toFixed(1)} units)`);
      done = true;
      break;
    }
  }
  if (!done) check("2c-plat", false, "no func_plat moved on e1m1");
}

/* -------- 2e: trigger_teleport moves the player ------------------------- */
{
  const tps = byClass("trigger_teleport");
  info("2e", `e1m1 trigger_teleport=${tps.length}`);
  let done = false;
  for (const t of tps) {
    const inside = insideSpot(t);
    if (!inside) continue;
    const p = player();
    unfreeze();
    place(inside, 0, 0);
    p.v.movetype = 3;
    const before = Array.from(p.v.origin);
    frames(20);
    const after = Array.from(p.v.origin);
    const d = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    const dest = PR_GetString(t.v.target);
    info("2e", `#${edictIndex(t)} target='${dest}' player [${before.map(Math.round)}] -> [${after.map(Math.round)}] moved ${d.toFixed(1)}`);
    if (d > 64) {
      check("2e-teleport", true, `trigger_teleport moved the player ${d.toFixed(0)} units to its '${dest}' destination`);
      done = true;
      break;
    }
  }
  if (!done) check("2e-teleport", false, "no trigger_teleport moved the player on e1m1");
}

/* -------- 2i: trigger_secret bumps STAT_SECRETS + prints ---------------- */
{
  const secrets = byClass("trigger_secret");
  info("2i", `e1m1 trigger_secret=${secrets.length}, STAT_TOTALSECRETS=${cl.stats[STAT_TOTALSECRETS]}`);
  let done = false;
  for (const s of secrets) {
    const inside = insideSpot(s);
    if (!inside) continue;
    const before = cl.stats[STAT_SECRETS];
    standAt(inside, 20);
    frames(10);
    const after = cl.stats[STAT_SECRETS];
    const txt = centerText();
    info("2i", `#${edictIndex(s)} secrets ${before} -> ${after}; centerprint='${txt.replace(/\n/g, "\\n").slice(0, 60)}'`);
    if (after > before) {
      check("2i-secret-stat", true, `svc_foundsecret bumped STAT_SECRETS ${before} -> ${after}`);
      check("2i-secret-msg", /secret/i.test(txt), `the secret message reached the client: '${txt.replace(/\n/g, "\\n").slice(0, 50)}'`);
      done = true;
      break;
    }
  }
  if (!done) { check("2i-secret-stat", false, "no trigger_secret fired on e1m1"); }
}

/* -------- 2h: trigger_once / trigger_multiple with a message ------------ */
{
  const msgTrigs = liveEdicts().filter(
    (e) => (classOf(e) === "trigger_once" || classOf(e) === "trigger_multiple") &&
      PR_GetString(e.v.message) !== "" && e.v.health === 0,
  );
  info("2h", `e1m1 message triggers=${msgTrigs.length}`);
  let done = false;
  for (const t of msgTrigs) {
    const want = PR_GetString(t.v.message);
    const inside = insideSpot(t);
    if (!inside) continue;
    standAt(inside, 20);
    frames(6);
    const txt = centerText();
    info("2h", `#${edictIndex(t)} ${classOf(t)} message='${want.replace(/\n/g, "\\n").slice(0, 40)}' got='${txt.replace(/\n/g, "\\n").slice(0, 40)}'`);
    if (txt.trim().length > 0 && want.replace(/\n/g, " ").includes(txt.split("\n")[0].trim().slice(0, 8))) {
      check("2h-message", true, `trigger message centerprinted: '${txt.replace(/\n/g, "\\n").slice(0, 50)}'`);
      done = true;
      break;
    }
  }
  if (!done) check("2h-message", false, "no message trigger centerprinted on e1m1");
}

/* -------- 2j: trigger_counter ------------------------------------------- */
{
  const counters = byClass("trigger_counter");
  info("2j", `e1m1 trigger_counter=${counters.length}`);
  let done = false;
  for (const t of counters) {
    const cnt0 = qcFloat(t, "count");
    const tn = PR_GetString(t.v.target);
    const feeders = targetedBy(PR_GetString(t.v.targetname)).filter((e) => e !== t);
    const tgts = liveEdicts().filter((e) => PR_GetString(e.v.targetname) === tn);
    info("2j", `#${edictIndex(t)} count=${cnt0} target='${tn}' (${tgts.length} ents) ` +
      `targetname='${PR_GetString(t.v.targetname)}' feeders=${feeders.map((f) => `#${edictIndex(f)} ${classOf(f)} solid=${f.v.solid}`).join(", ")}`);
    const before = tgts.map((d) => Array.from(d.v.origin));
    const seq: string[] = [];
    for (const f of feeders) {
      const how = activate(f);
      seq.push(`${classOf(f)}:${how}->count=${qcFloat(t, "count")}`);
      frames(10);
    }
    const moved = tgts.map((d, i) =>
      Math.hypot(d.v.origin[0] - before[i][0], d.v.origin[1] - before[i][1], d.v.origin[2] - before[i][2]));
    const cnt1 = qcFloat(t, "count");
    info("2j", `sequence: ${seq.join(" | ")}; final count=${cnt1}; target displacement=${moved.map((v) => v.toFixed(1)).join(",")}`);
    check("2j-counter", cnt1 < cnt0 || moved.some((v) => v > 1),
      `trigger_counter counted down ${cnt0} -> ${cnt1} and/or fired its target (displacement ${moved.map((v) => v.toFixed(1)).join(",")})`);
    done = true;
    break;
  }
  if (!done) check("2j-counter", false, "no trigger_counter on e1m1");
}

/* -------- 2g: lava / slime hurt the player ------------------------------ */
{
  // start's lava pit under the episode-4 gate. Damage comes from client.qc's
  // WaterMove via self.watertype, not from a trigger_hurt entity.
  if (loadMap("start")) {
    frames(20);
    const p = player();
    // find a point whose contents are CONTENTS_LAVA
    let lava: [number, number, number] | null = null;
    const CONTENTS_LAVA = -5;
    const wm = sv.worldmodel;
    if (wm) {
      const lo = wm.mins, hi = wm.maxs;
      outer:
      for (let x = lo[0]; x <= hi[0] && !lava; x += 32) {
        for (let y = lo[1]; y <= hi[1]; y += 32) {
          for (let z = lo[2]; z <= hi[2]; z += 32) {
            const s = new Float32Array(3); s[0] = x; s[1] = y; s[2] = z;
            if (SVPointContents(s) === CONTENTS_LAVA) { lava = [x, y, z + 8]; break outer; }
          }
        }
      }
    }
    info("2g", `start lava point: ${lava ? `[${lava.map(Math.round)}]` : "none found"}`);
    if (lava) {
      unfreeze();
      place(lava, 0, 0);
      p.v.movetype = 3;
      const hpBefore = cl.stats[STAT_HEALTH];
      let minHp = hpBefore;
      for (let i = 0; i < 60; i++) {
        p.v.origin[0] = lava[0]; p.v.origin[1] = lava[1]; p.v.origin[2] = lava[2];
        p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
        frames(1);
        if (cl.stats[STAT_HEALTH] < minHp) minHp = cl.stats[STAT_HEALTH];
      }
      info("2g", `health ${hpBefore} -> min ${minHp} after 3 s in lava, watertype=${p.v.watertype} waterlevel=${p.v.waterlevel}`);
      check("2g-lava", minHp < hpBefore, `standing in lava cost health (${hpBefore} -> ${minHp})`);
    } else check("2g-lava", false, "no CONTENTS_LAVA point found on start");
  } else check("2g-lava", false, "start failed to load");
}

/* -------- 2f: trigger_push (e3m5 wind tunnels) -------------------------- */
if (loadMap("e3m5")) {
  cmd("god"); frames(4);
  const pushes = byClass("trigger_push");
  info("2f", `e3m5 trigger_push=${pushes.length}`);
  let done = false;
  const p = player();
  for (const t of pushes) {
    const inside = insideSpot(t);
    if (!inside) continue;
    unfreeze();
    place(inside, 0, 0);
    p.v.movetype = 3;
    p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      frames(1);
      const s = Math.hypot(p.v.velocity[0], p.v.velocity[1], p.v.velocity[2]);
      if (s > peak) peak = s;
    }
    info("2f", `#${edictIndex(t)} speed=${qcFloat(t, "speed")} movedir=[${Array.from(t.v.movedir).map((v) => v.toFixed(2))}] peak player speed=${peak.toFixed(1)}`);
    if (peak > 200) {
      check("2f-push", true, `trigger_push accelerated the player to ${peak.toFixed(0)} u/s (speed=${qcFloat(t, "speed")})`);
      done = true;
      break;
    }
  }
  if (!done) check("2f-push", false, "no trigger_push accelerated the player on e3m5");
} else check("2f-push", false, "e3m5 failed to load");

/* -------- 2d: func_train moves along its path_corners ------------------- */
// plats.qc's func_train_find starts a train immediately only when it has no
// targetname; every retail train is targeted, so set off whatever targets it.
{
  let done = false;
  for (const map of ["e1m2", "e1m3", "e2m5", "e3m4", "e1m4"]) {
    if (done) break;
    if (!loadMap(map)) { info("2d", `${map} failed to load`); continue; }
    cmd("god"); frames(20); giveAll();
    const trains = byClass("train");
    info("2d", `${map} trains=${trains.length} targetnames=${trains.map((t) => `'${PR_GetString(t.v.targetname)}'`).join(",")}`);
    for (const t of trains) {
      const tn = PR_GetString(t.v.targetname);
      const start = Array.from(t.v.origin);
      if (tn === "") {
        frames(200);
      } else {
        const starters = targetedBy(tn).filter((e) => e !== t);
        if (starters.length === 0) continue;
        const hows: string[] = [];
        for (const st of starters) {
          hows.push(`#${edictIndex(st)} ${classOf(st)}:${activate(st)}`);
          const moved0 = Math.hypot(
            t.v.origin[0] - start[0], t.v.origin[1] - start[1], t.v.origin[2] - start[2]);
          if (moved0 > 8) break;
        }
        info("2d", `${map} train #${edictIndex(t)} started via ${hows.join(", ")}`);
        frames(200); // 10 seconds of travel
      }
      const moved = Math.hypot(
        t.v.origin[0] - start[0], t.v.origin[1] - start[1], t.v.origin[2] - start[2]);
      info("2d", `${map} train #${edictIndex(t)} displacement=${moved.toFixed(1)} after 10 s`);
      if (moved > 8) {
        check("2d-train", true,
          `func_train travelled along its path_corners on ${map} (${moved.toFixed(1)} units in 10 s)`);
        done = true;
        break;
      }
    }
  }
  if (!done) check("2d-train", false, "no func_train moved in 10 s on e1m2/e1m3/e2m5/e3m4/e1m4");
}

/* -------- 2k: key-locked doors ------------------------------------------ */
// A keyed door has self.items set, so LinkDoors spawns no proximity field and
// door_touch on the brush itself is the only way in: it refuses (and
// centerprints "You need the ... key") unless other.items carries the key.
// Each phase runs on a freshly loaded map so the first phase's 2 s
// attack_finished cooldown and consumed key cannot colour the second.
{
  let done = false;
  const phase = (withKeys: boolean): { moved: number; text: string; door: number; flags: number } => {
    if (!loadMap("e1m2")) return { moved: -1, text: "", door: -1, flags: 0 };
    frames(20);
    cmd("god"); frames(4);
    const p = player();
    if (withKeys) { giveAll(); frames(20); }
    else p.v.items = p.v.items & ~(IT_KEY1 | IT_KEY2);
    const locked = byClass("door").filter((d) => (d.v.spawnflags & 24) !== 0);
    for (const d of locked) {
      const start = Array.from(d.v.origin);
      if (!walkInto(d, 50)) continue;
      const moved = Math.max(
        Math.hypot(d.v.origin[0] - start[0], d.v.origin[1] - start[1], d.v.origin[2] - start[2]),
        watchOrigins([d], 60)[0]);
      return { moved, text: centerText(), door: edictIndex(d), flags: d.v.spawnflags };
    }
    return { moved: -1, text: "", door: -1, flags: 0 };
  };

  const noKey = phase(false);
  const withKey = phase(true);
  info("2k", `no key: door #${noKey.door} spawnflags=${noKey.flags} displacement=${noKey.moved.toFixed(1)} ` +
    `centerprint='${noKey.text.replace(/\n/g, "\\n").slice(0, 50)}'`);
  info("2k", `with keys: door #${withKey.door} displacement=${withKey.moved.toFixed(1)} ` +
    `centerprint='${withKey.text.replace(/\n/g, "\\n").slice(0, 50)}'`);
  check("2k-locked", noKey.moved >= 0 && noKey.moved <= 1 && /need the .*key/i.test(noKey.text),
    `the key door stayed shut without a key and said so ('${noKey.text.replace(/\n/g, " ").slice(0, 40)}', moved ${noKey.moved.toFixed(1)})`);
  check("2k-unlocks", withKey.moved > 1,
    `it opened once impulse 9 granted IT_KEY1|IT_KEY2 (moved ${withKey.moved.toFixed(1)} units)`);
  done = withKey.moved > 1;
  if (!done) info("2k", "with-keys phase did not open any keyed door on e1m2");
}

summary("touch");
process.exit(0);
