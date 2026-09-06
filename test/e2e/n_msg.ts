// N sweep, category 7: server -> client messages.
import { cl } from "../../src/client/client";
import type { EdictT } from "../../src/progs/progs";
import { FL_GODMODE } from "../../src/server/server";
import {
  STAT_HEALTH, STAT_SECRETS, STAT_MONSTERS, STAT_TOTALSECRETS, STAT_TOTALMONSTERS,
} from "../../src/common/quakedef";
import {
  boot, cmd, frames, waitInGame, loadMap, liveEdicts, classOf, edictIndex,
  check, info, summary, giveAll, player, place, freeze, losSpot, aim, centerText,
  conLines, conTail, insideSpot, standAt, qcGlobals, center, qcString,
} from "./n_lib";

function byClass(cn: string): EdictT[] {
  return liveEdicts().filter((e) => classOf(e) === cn);
}

function god(on: boolean): void {
  const pl = player();
  if (on) pl.v.flags = (pl.v.flags | 0) | FL_GODMODE;
  else pl.v.flags = (pl.v.flags | 0) & ~FL_GODMODE;
}

boot(["+map", "e1m1"]);
if (waitInGame() < 0) { console.log("##N FATAL boot"); process.exit(1); }
frames(30);

/* -------- 7a: svc_updatestat -- level totals reach the client ----------- */
{
  const g = qcGlobals();
  info("7a", `server total_secrets=${g.total_secrets} total_monsters=${g.total_monsters}; ` +
    `client STAT_TOTALSECRETS=${cl.stats[STAT_TOTALSECRETS]} STAT_TOTALMONSTERS=${cl.stats[STAT_TOTALMONSTERS]}`);
  check("7a-totals", cl.stats[STAT_TOTALSECRETS] === g.total_secrets &&
    cl.stats[STAT_TOTALMONSTERS] === g.total_monsters && g.total_monsters > 0,
    `svc_updatestat carried the level totals to the client (secrets ${cl.stats[STAT_TOTALSECRETS]}/${g.total_secrets}, ` +
    `monsters ${cl.stats[STAT_TOTALMONSTERS]}/${g.total_monsters})`);
}

/* -------- 7b: svc_print -- item pickup text reaches the console --------- */
{
  god(true); frames(4);
  const before = conLines().length;
  let taken = "";
  for (const w of [...byClass("weapon_supershotgun"), ...byClass("weapon_nailgun"), ...byClass("item_shells")]) {
    const spot = insideSpot(w) ?? center(w);
    player().v.items = 0;
    player().v.ammo_shells = 0;
    frames(2);
    standAt(spot, 30);
    frames(6);
    if (w.free || w.v.solid === 0 || w.v.modelindex === 0) { taken = classOf(w); break; }
  }
  const got = conLines().filter((l) => /You got the|You receive/i.test(l));
  info("7b", `picked up ${taken || "nothing"}; console lines ${before} -> ${conLines().length}; ` +
    `matches=${JSON.stringify(got.slice(-3))}`);
  check("7b-svcprint", got.length > 0,
    `svc_print delivered the pickup text to the console (${JSON.stringify(got.slice(-1))})`);
}

/* -------- 7c: svc_killedmonster -> STAT_MONSTERS ------------------------ */
{
  if (loadMap("e1m1")) {
    frames(20);
    god(true); giveAll();
    const g = qcGlobals();
    const before = cl.stats[STAT_MONSTERS];
    let killed = false;
    for (const m of byClass("monster_army")) {
      const spot = losSpot(m, 64, 400);
      if (!spot) continue;
      const pl = player();
      place(spot.stand, spot.yaw, spot.pitch);
      freeze();
      frames(4);
      cmd("impulse 3"); frames(8);
      cmd("+attack");
      for (let i = 0; i < 60; i++) {
        aim(spot.yaw, spot.pitch);
        pl.v.origin[0] = spot.stand[0]; pl.v.origin[1] = spot.stand[1]; pl.v.origin[2] = spot.stand[2];
        pl.v.velocity[0] = pl.v.velocity[1] = pl.v.velocity[2] = 0;
        frames(1);
        if (m.free || m.v.health <= 0) { killed = true; break; }
      }
      cmd("-attack");
      frames(20);
      break;
    }
    const after = cl.stats[STAT_MONSTERS];
    info("7c", `killed=${killed}; server killed_monsters=${g.killed_monsters}; client STAT_MONSTERS ${before} -> ${after}`);
    check("7c-killedmonster", after > before && after === g.killed_monsters,
      `svc_killedmonster bumped STAT_MONSTERS to ${after}, matching the server's killed_monsters=${g.killed_monsters}`);
  } else check("7c-killedmonster", false, "e1m1 failed to load");
}

/* -------- 7d: svc_foundsecret -> STAT_SECRETS + centerprint ------------- */
{
  if (loadMap("e1m1")) {
    frames(20);
    god(true);
    const g = qcGlobals();
    let done = false;
    for (const s of byClass("trigger_secret")) {
      const inside = insideSpot(s);
      if (!inside) continue;
      const before = cl.stats[STAT_SECRETS];
      standAt(inside, 20);
      frames(10);
      const after = cl.stats[STAT_SECRETS];
      if (after <= before) continue;
      const txt = centerText();
      info("7d", `trigger_secret #${edictIndex(s)}: STAT_SECRETS ${before} -> ${after}, ` +
        `server found_secrets=${g.found_secrets}, centerprint='${txt.replace(/\n/g, "\\n").slice(0, 50)}'`);
      check("7d-foundsecret", after === g.found_secrets,
        `svc_foundsecret bumped STAT_SECRETS to ${after}, matching the server's found_secrets=${g.found_secrets}`);
      check("7d-secret-text", /secret/i.test(txt),
        `its centerprint reached the client: '${txt.replace(/\n/g, " ").slice(0, 45)}'`);
      done = true;
      break;
    }
    if (!done) check("7d-foundsecret", false, "no trigger_secret fired on e1m1");
  } else check("7d-foundsecret", false, "e1m1 failed to load");
}

/* -------- 7e: obituary / death print ------------------------------------ */
{
  if (loadMap("start")) {
    frames(20);
    god(false);
    const pl = player();
    // drop into the start map's lava and die
    let lava: [number, number, number] | null = null;
    for (const e of liveEdicts()) void e;
    // reuse the known lava column from the touch sweep
    const probe: [number, number, number] = [704, 848, -144];
    lava = probe;
    pl.v.health = 30;
    place(lava, 0, 0);
    pl.v.movetype = 3;
    let died = false;
    for (let i = 0; i < 200; i++) {
      pl.v.origin[0] = lava[0]; pl.v.origin[1] = lava[1]; pl.v.origin[2] = lava[2];
      pl.v.velocity[0] = pl.v.velocity[1] = pl.v.velocity[2] = 0;
      frames(1);
      if (cl.stats[STAT_HEALTH] <= 0) { died = true; break; }
    }
    frames(20);
    // client.qc's ClientObituary bprints one of these for an environment death
    const obit = conLines().filter((l) =>
      /turned into hot slag|burst into flames|sleeps with the fishes|was squished|turned into slime|fell to his death|died/i.test(l));
    info("7e", `player died=${died} health=${cl.stats[STAT_HEALTH]}; obituary matches=${JSON.stringify(obit.slice(-2))}`);
    info("7e", `console tail: ${conTail(6)}`);
    check("7e-obituary", died && obit.length > 0,
      `ClientObituary's bprint reached the console when the player died in lava (${JSON.stringify(obit.slice(-1))})`);
  } else check("7e-obituary", false, "start failed to load");
}

/* -------- 7f: intermission ---------------------------------------------- */
{
  if (loadMap("e1m1")) {
    frames(20);
    god(true);
    const exits = byClass("trigger_changelevel");
    info("7f", `e1m1 trigger_changelevel=${exits.length}`);
    let done = false;
    for (const t of exits) {
      const inside = insideSpot(t);
      if (!inside) continue;
      standAt(inside, 30);
      frames(40);
      info("7f", `#${edictIndex(t)} map='${qcString(t, "map")}': cl.intermission=${cl.intermission} ` +
        `completed_time=${cl.completed_time.toFixed(1)} ` +
        `stats: secrets ${cl.stats[STAT_SECRETS]}/${cl.stats[STAT_TOTALSECRETS]} ` +
        `monsters ${cl.stats[STAT_MONSTERS]}/${cl.stats[STAT_TOTALMONSTERS]}`);
      if (cl.intermission > 0) {
        check("7f-intermission", true,
          `trigger_changelevel put the client into intermission (cl.intermission=${cl.intermission}, ` +
          `completed_time=${cl.completed_time.toFixed(1)}) with the level stats intact ` +
          `(${cl.stats[STAT_SECRETS]}/${cl.stats[STAT_TOTALSECRETS]} secrets, ` +
          `${cl.stats[STAT_MONSTERS]}/${cl.stats[STAT_TOTALMONSTERS]} monsters)`);
        done = true;
        break;
      }
    }
    if (!done) check("7f-intermission", false, "no trigger_changelevel reached intermission on e1m1");
  } else check("7f-intermission", false, "e1m1 failed to load");
}

summary("messages");
process.exit(0);
