// N sweep, category 4: player physics.
import { cl } from "../../src/client/client";
import { sv, FL_ONGROUND } from "../../src/server/server";
import { SV_PointContents } from "../../src/server/world";
import { STAT_HEALTH } from "../../src/common/quakedef";
import {
  boot, cmd, frames, waitInGame, loadMap, check, info, summary, player,
  place, freeze, unfreeze, aim, qcFloat, playerFits,
} from "./n_lib";
import { SV_Move, MOVE_NORMAL } from "../../src/server/world";
import { FL_GODMODE } from "../../src/server/server";
import { sv_gravity } from "../../src/server/sv_phys";

/** god mode as a state, not the console command's toggle. */
function god(on: boolean): void {
  const pl = player();
  if (on) pl.v.flags = (pl.v.flags | 0) | FL_GODMODE;
  else pl.v.flags = (pl.v.flags | 0) & ~FL_GODMODE;
}

const CONTENTS_EMPTY = -1;
const CONTENTS_WATER = -3;
const CONTENTS_SLIME = -4;

/** Scan the loaded world on a grid for the first point with these contents. */
function findContents(want: number, step = 48): [number, number, number] | null {
  const wm = sv.worldmodel;
  if (!wm) return null;
  const lo = wm.mins;
  const hi = wm.maxs;
  const probe = new Float32Array(3);
  for (let z = lo[2] + step; z < hi[2]; z += step) {
    for (let x = lo[0] + step; x < hi[0]; x += step) {
      for (let y = lo[1] + step; y < hi[1]; y += step) {
        probe[0] = x; probe[1] = y; probe[2] = z;
        if (SV_PointContents(probe) !== want) continue;
        // want somewhere the player actually fits
        if (!playerFits([x, y, z])) continue;
        return [x, y, z];
      }
    }
  }
  return null;
}

boot(["+map", "e1m1"]);
if (waitInGame() < 0) { console.log("##N FATAL boot"); process.exit(1); }
frames(20);
const p = player();

/* -------- 4a: jumping --------------------------------------------------- */
{
  god(true); frames(4);
  unfreeze();
  frames(40); // land
  const onGround = (p.v.flags | 0) & FL_ONGROUND;
  const z0 = p.v.origin[2];
  let peakVel = 0;
  let peakZ = z0;
  cmd("+jump");
  for (let i = 0; i < 30; i++) {
    frames(1);
    if (p.v.velocity[2] > peakVel) peakVel = p.v.velocity[2];
    if (p.v.origin[2] > peakZ) peakZ = p.v.origin[2];
  }
  cmd("-jump");
  frames(30);
  // client.qc's PlayerJump adds 270 to velocity_z, but the first velocity the
  // harness can observe is after that frame's SV_AddGravity, i.e. 270 minus
  // sv_gravity * frametime (800 * 0.05 = 40 here).
  const expect = 270 - sv_gravity.value * 0.05;
  info("4a", `onground before jump=${onGround !== 0}; z ${z0.toFixed(1)} -> peak ${peakZ.toFixed(1)} ` +
    `(gain ${(peakZ - z0).toFixed(1)}); peak velocity_z=${peakVel.toFixed(1)}; ` +
    `expected 270 - sv_gravity(${sv_gravity.value})*0.05 = ${expect.toFixed(1)}`);
  check("4a-jump", Math.abs(peakVel - expect) < 2 && peakZ - z0 > 20,
    `+jump gave the QC's 270 u/s kick (observed ${peakVel.toFixed(1)} = 270 - one frame of gravity ${expect.toFixed(1)}) ` +
    `and lifted the player ${(peakZ - z0).toFixed(1)} units`);
}

/* -------- 4b: walking up stairs ---------------------------------------- */
// SV_WalkMove's step-up (STEPSIZE 18) should let the player climb steps with
// no noclip and no jump.
{
  god(true); frames(4);
  let best = 0;
  let bestFrom: [number, number, number] = [0, 0, 0];
  let bestYaw = 0;
  const startOrigin: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
  for (let ring = 0; ring < 4 && best < 20; ring++) {
    for (let a = 0; a < 360 && best < 20; a += 30) {
      const r = ring * 96;
      const from: [number, number, number] = [
        startOrigin[0] + Math.cos((a * Math.PI) / 180) * r,
        startOrigin[1] + Math.sin((a * Math.PI) / 180) * r,
        startOrigin[2],
      ];
      if (!playerFits(from)) continue;
      for (let yaw = 0; yaw < 360 && best < 20; yaw += 45) {
        place(from, yaw, 0);
        unfreeze();
        frames(20); // settle onto the floor
        const z0 = p.v.origin[2];
        let gain = 0;
        cmd("+forward");
        for (let i = 0; i < 40; i++) {
          aim(yaw, 0);
          frames(1);
          if (((p.v.flags | 0) & FL_ONGROUND) !== 0) {
            const g = p.v.origin[2] - z0;
            if (g > gain) gain = g;
          }
        }
        cmd("-forward");
        frames(4);
        if (gain > best) { best = gain; bestFrom = from; bestYaw = yaw; }
      }
    }
  }
  info("4b", `best on-ground climb while walking: ${best.toFixed(1)} units from [${bestFrom.map(Math.round)}] yaw=${bestYaw}`);
  check("4b-stairs", best > 18,
    `the player walked up at least one step height (climbed ${best.toFixed(1)} units on the ground, no jump, no noclip)`);
}

/* -------- 4c: water -- waterlevel, +moveup, drowning -------------------- */
{
  const w = findContents(CONTENTS_WATER);
  info("4c", `e1m1 water point: ${w ? `[${w.map(Math.round)}]` : "none"}`);
  if (w) {
    god(true); frames(4);
    // stay under the surface: drop 48 units so waterlevel reaches 3
    const deep: [number, number, number] = [w[0], w[1], w[2]];
    place(deep, 0, 0);
    unfreeze();
    frames(30);
    info("4c", `waterlevel=${p.v.waterlevel} watertype=${p.v.watertype} flags&FL_INWATER=${((p.v.flags | 0) & 16) !== 0}`);
    check("4c-waterlevel", p.v.waterlevel >= 2,
      `the player is registered as in water (waterlevel=${p.v.waterlevel}, watertype=${p.v.watertype})`);

    // +moveup should swim upward
    const z0 = p.v.origin[2];
    cmd("+moveup");
    let rise = 0;
    for (let i = 0; i < 40; i++) {
      aim(0, 0);
      frames(1);
      if (p.v.origin[2] - z0 > rise) rise = p.v.origin[2] - z0;
    }
    cmd("-moveup");
    frames(4);
    info("4c", `+moveup raised the player ${rise.toFixed(1)} units`);
    check("4c-swim-up", rise > 8, `+moveup swam the player upward (${rise.toFixed(1)} units)`);

    // drowning: client.qc's WaterMove keeps air_finished = time + 12 while the
    // player has air, then damages once per second after it passes. Surface
    // first so the 12 s clock starts fresh, and take god mode off.
    god(false);
    p.v.health = 100;
    const dry: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
    for (let z = deep[2]; z < deep[2] + 512; z += 16) {
      if (playerFits([deep[0], deep[1], z]) && SV_PointContents(Float32Array.of(deep[0], deep[1], z)) === CONTENTS_EMPTY) {
        dry[0] = deep[0]; dry[1] = deep[1]; dry[2] = z;
        break;
      }
    }
    place(dry, 0, 0);
    freeze();
    frames(40); // breathe: air_finished resets to time + 12
    const airFresh = qcFloat(p, "air_finished");
    place(deep, 0, 0);
    unfreeze();
    frames(4);
    const air = airFresh;
    info("4c", `surfaced at [${dry.map(Math.round)}] waterlevel=${p.v.waterlevel}, air_finished refreshed to ${airFresh.toFixed(1)} (sv.time ${sv.time.toFixed(1)})`);
    let minHp = cl.stats[STAT_HEALTH];
    let drownAt = -1;
    for (let i = 0; i < 500; i++) { // 25 seconds
      p.v.origin[0] = deep[0]; p.v.origin[1] = deep[1]; p.v.origin[2] = deep[2];
      p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
      frames(1);
      if (cl.stats[STAT_HEALTH] < minHp) {
        if (drownAt < 0) drownAt = i * 0.05;
        minHp = cl.stats[STAT_HEALTH];
      }
      if (cl.stats[STAT_HEALTH] <= 0) break;
    }
    info("4c", `air_finished=${air.toFixed(1)}; first drowning damage ${drownAt.toFixed(1)} s after submerging; health 100 -> ${minHp}; godmode=${((p.v.flags | 0) & FL_GODMODE) !== 0}`);
    check("4c-drown", drownAt > 8 && drownAt < 18,
      `drowning damage started after ~12 s underwater (${drownAt.toFixed(1)} s), health 100 -> ${minHp}`);
  } else {
    check("4c-waterlevel", false, "no reachable CONTENTS_WATER point on e1m1");
  }
}

/* -------- 4d: slime ----------------------------------------------------- */
{
  let done = false;
  for (const map of ["e1m1", "e1m2", "e1m3", "e2m2", "e3m1"]) {
    if (done) break;
    if (!loadMap(map)) continue;
    frames(20);
    const s = findContents(CONTENTS_SLIME);
    info("4d", `${map} slime point: ${s ? `[${s.map(Math.round)}]` : "none"}`);
    if (!s) continue;
    const pp = player();
    pp.v.health = 100;
    place(s, 0, 0);
    unfreeze();
    let minHp = 100;
    for (let i = 0; i < 120; i++) {
      pp.v.origin[0] = s[0]; pp.v.origin[1] = s[1]; pp.v.origin[2] = s[2];
      pp.v.velocity[0] = pp.v.velocity[1] = pp.v.velocity[2] = 0;
      frames(1);
      if (cl.stats[STAT_HEALTH] < minHp) minHp = cl.stats[STAT_HEALTH];
    }
    info("4d", `${map} watertype=${pp.v.watertype} waterlevel=${pp.v.waterlevel} health 100 -> ${minHp}`);
    if (minHp < 100) {
      check("4d-slime", true, `standing in slime on ${map} cost health (100 -> ${minHp}, watertype=${pp.v.watertype})`);
      done = true;
    }
  }
  if (!done) check("4d-slime", false, "no CONTENTS_SLIME pool found on e1m1/e1m2/e1m3/e2m2/e3m1");
}

/* -------- 4e: falling damage -------------------------------------------- */
{
  if (loadMap("e1m1")) {
    frames(20);
    const pp = player();
    god(false);
    const wm = sv.worldmodel;
    // look for a spot with a long clear fall: player fits, and a downward
    // trace reaches a floor far below
    let bestDrop = 0;
    let bestFrom: [number, number, number] = [pp.v.origin[0], pp.v.origin[1], pp.v.origin[2]];
    if (wm) {
      const lo = wm.mins;
      const hi = wm.maxs;
      for (let x = lo[0] + 64; x < hi[0]; x += 128) {
        for (let y = lo[1] + 64; y < hi[1]; y += 128) {
          for (let z = hi[2] - 64; z > lo[2]; z -= 128) {
            if (!playerFits([x, y, z])) continue;
            const from = Float32Array.of(x, y, z);
            const to = Float32Array.of(x, y, z - 4096);
            const tr = SV_Move(from, pp.v.mins, pp.v.maxs, to, MOVE_NORMAL, pp);
            const fall = z - tr.endpos[2];
            if (tr.fraction < 1 && fall > bestDrop) { bestDrop = fall; bestFrom = [x, y, z]; }
            break; // only the highest fitting z per column
          }
        }
      }
    }
    info("4e", `longest clear fall found on e1m1: ${bestDrop.toFixed(0)} units from [${bestFrom.map(Math.round)}]`);
    pp.v.health = 100;
    place(bestFrom, 0, 0);
    unfreeze();
    let minVel = 0;
    let minHp = 100;
    for (let i = 0; i < 400; i++) {
      frames(1);
      if (pp.v.velocity[2] < minVel) minVel = pp.v.velocity[2];
      if (cl.stats[STAT_HEALTH] < minHp) minHp = cl.stats[STAT_HEALTH];
      if (((pp.v.flags | 0) & FL_ONGROUND) !== 0 && i > 10) break;
    }
    frames(10);
    info("4e", `impact speed=${minVel.toFixed(0)} u/s; health 100 -> ${minHp} ` +
      `(client.qc's PlayerPostThink damages when the landing speed passes -650)`);
    check("4e-falldamage", minVel < -650 ? minHp < 100 : false,
      minVel < -650
        ? `a ${bestDrop.toFixed(0)}-unit fall (impact ${minVel.toFixed(0)} u/s) cost health: 100 -> ${minHp}`
        : `no fall long enough to pass client.qc's -650 threshold was found (best impact ${minVel.toFixed(0)} u/s)`);
  } else check("4e-falldamage", false, "e1m1 failed to load");
}

summary("physics");
process.exit(0);
