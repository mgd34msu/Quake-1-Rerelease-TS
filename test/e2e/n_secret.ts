// N-repro: the reported "secret door does not open when shot" on the start map.
// The start map's one shootable entity is a trigger_multiple (health 1,
// takedamage 1, solid SOLID_BBOX) at 927..937 x 2031..2097 x -65..1.
import { sv } from "../../src/server/server";
import { PR_GetString } from "../../src/progs/progs";
import { cl } from "../../src/client/client";
import { SV_Move, MOVE_NORMAL, SV_PointContents } from "../../src/server/world";
import { vec3 } from "../../src/common/mathlib";

import {
  boot, cmd, frames, waitInGame, liveEdicts, classOf, center, place, freeze,
  fire, yawTo, pitchTo, edictIndex, check, info, summary, centerText, aim, player, unfreeze,
} from "./n_lib";
import { SV_LinkEdict } from "../../src/server/world";

boot(["+map", "start"]);
if (waitInGame() < 0) { console.log("##N FATAL could not reach start"); process.exit(1); }

// ---- find the shootable trigger ---------------------------------------
const shootables = liveEdicts().filter(
  (e) => e.v.health > 0 && e.v.takedamage > 0 && classOf(e).startsWith("trigger"),
);
for (const t of shootables) {
  info("trigger", `#${edictIndex(t)} ${classOf(t)} solid=${t.v.solid} movetype=${t.v.movetype} ` +
    `health=${t.v.health} takedamage=${t.v.takedamage} ` +
    `absmin=[${Array.from(t.v.absmin).map(Math.round)}] absmax=[${Array.from(t.v.absmax).map(Math.round)}] ` +
    `target='${PR_GetString(t.v.target)}' message='${PR_GetString(t.v.message).replace(/\n/g, "\\n")}'`);
}
check("N0-found", shootables.length === 1, `shootable trigger count = ${shootables.length}`);
const trig = shootables[0];
if (!trig) { summary("secret"); process.exit(1); }

const target = PR_GetString(trig.v.target);
const targets = target === "" ? [] : liveEdicts().filter((e) => PR_GetString(e.v.targetname) === target);
info("target", `target='${target}' -> ${targets.length} edict(s)`);

// ---- probe an open spot that can actually see the trigger --------------
const c = center(trig);
const tgt = vec3(); tgt[0] = c[0]; tgt[1] = c[1]; tgt[2] = c[2];
const p = sv.edicts[1];
let stand: [number, number, number] | null = null;
let standDist = 0;
for (let r = 64; r <= 256 && !stand; r += 16) {
  for (let a = 0; a < 360 && !stand; a += 15) {
    const s = vec3();
    s[0] = c[0] + Math.cos((a * Math.PI) / 180) * r;
    s[1] = c[1] + Math.sin((a * Math.PI) / 180) * r;
    s[2] = c[2];
    if (SV_PointContents(s) !== -1) continue;
    const src = vec3(); src[0] = s[0]; src[1] = s[1]; src[2] = s[2] + 16;
    const d = [tgt[0] - src[0], tgt[1] - src[1], tgt[2] - src[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const end = vec3();
    for (let i = 0; i < 3; i++) end[i] = src[i] + (d[i] / len) * 2048;
    const tr = SV_Move(src, vec3(), vec3(), end, MOVE_NORMAL, p);
    if (tr.ent === trig) { stand = [s[0], s[1], s[2]]; standDist = len; }
  }
}
check("N1-los", stand !== null, `found an open spot with line of sight to the trigger: ${stand ? `[${stand.map(Math.round)}] dist=${Math.round(standDist)}` : "none"}`);
if (!stand) { summary("secret"); process.exit(1); }

const eye: [number, number, number] = [stand[0], stand[1], stand[2] + 16];
const yaw = yawTo(eye, c);
const pitch = pitchTo(eye, c);
info("setup", `standing [${stand.map(Math.round)}] yaw=${yaw.toFixed(1)} pitch=${pitch.toFixed(1)} dist=${Math.round(standDist)}`);

place(stand, yaw, pitch);
freeze();
frames(5);

// re-probe from the placed player, exactly the way FireBullets computes src
const src2 = vec3();
src2[0] = p.v.origin[0]; src2[1] = p.v.origin[1];
src2[2] = p.v.absmin[2] + (p.v.maxs[2] - p.v.mins[2]) * 0.7;
const d2 = [c[0] - src2[0], c[1] - src2[1], c[2] - src2[2]];
const l2 = Math.hypot(d2[0], d2[1], d2[2]);
const e2 = vec3();
for (let i = 0; i < 3; i++) e2[i] = src2[i] + (d2[i] / l2) * 2048;
const tr2 = SV_Move(src2, vec3(), vec3(), e2, MOVE_NORMAL, p);
info("probe", `SV_Move from FireBullets src: frac=${tr2.fraction.toFixed(4)} ent=#${tr2.ent ? edictIndex(tr2.ent) : -1} ` +
  `class='${tr2.ent ? classOf(tr2.ent) : "?"}' startsolid=${tr2.startsolid} allsolid=${tr2.allsolid}`);
check("N2-trace", tr2.ent === trig, `SV_Move hits the SOLID_BBOX trigger (got #${tr2.ent ? edictIndex(tr2.ent) : -1})`);

// ---- fire the shotgun --------------------------------------------------
cmd("impulse 2");
frames(5);
const shellsBefore = cl.stats[6];
const healthBefore = trig.v.health;
const targetBefore = targets.map((d) => Array.from(d.v.origin));
info("pre", `shells=${shellsBefore} trigger.health=${healthBefore} activeweapon=${cl.stats[10]}`);

// sample the trigger's state every frame while firing, so multi_wait's
// 3-second reset (self.wait == 3) can't hide the kill
let minHealth = trig.v.health;
let sawTakedamageOff = false;
let sawMessage = false;
cmd("+attack");
for (let i = 0; i < 40; i++) {
  aim(yaw, pitch);
  p.v.origin[0] = stand[0]; p.v.origin[1] = stand[1]; p.v.origin[2] = stand[2];
  p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
  SV_LinkEdict(p, false);
  frames(1);
  if (trig.v.health < minHealth) minHealth = trig.v.health;
  if (trig.v.takedamage === 0) sawTakedamageOff = true;
  if (centerText().includes("Well of Wishes")) sawMessage = true;
}
cmd("-attack");
frames(4);
info("sampled", `minHealth=${minHealth} sawTakedamageOff=${sawTakedamageOff} sawMessage=${sawMessage}`);
frames(80); // let multi_wait (wait 3) reset it, as the QC intends

info("post", `shells=${cl.stats[6]} trigger.free=${trig.free} trigger.health=${trig.v.health} ` +
  `centerstring='${centerText().replace(/\n/g, "\\n").slice(0, 80)}'`);

check("N3-fired", cl.stats[6] < shellsBefore, `shells ${shellsBefore} -> ${cl.stats[6]}`);
check("N4-damaged", minHealth <= 0 || sawTakedamageOff,
  `trigger took damage and multi_killed ran (minHealth=${minHealth}, takedamage cleared=${sawTakedamageOff})`);
check("N5-message", sawMessage,
  `multi_trigger's centerprint reached the client: '${centerText().replace(/\n/g, "\\n").slice(0, 60)}'`);
if (targets.length > 0) {
  const moved = targets.some((d, i) => Array.from(d.v.origin).some((v, j) => Math.abs(v - targetBefore[i][j]) > 0.5));
  check("N6-target-moved", moved, `targeted entity moved: ${moved}`);
}

check("N6-reset", trig.v.health === 1 && trig.v.takedamage === 1,
  `multi_wait restored the trigger after wait=3 (health=${trig.v.health}, takedamage=${trig.v.takedamage})`);

// ---- N7: point blank, walked right up to the SOLID_BBOX face ----------
// (the user's screenshot was muzzle-against-the-wall). The trigger is
// SOLID_BBOX so it blocks the player; walk into it and fire from there.
frames(20);
const approach: [number, number, number] = [c[0] + 40, c[1], c[2]];
place(approach, 180, 0);
unfreeze(); // MOVETYPE_WALK, so the bbox actually stops us
frames(2);
cmd("+forward");
for (let i = 0; i < 30; i++) { aim(180, 0); frames(1); }
cmd("-forward");
frames(4);
const pbDist = p.v.origin[0] - trig.v.absmax[0];
freeze();
{
  const s3 = vec3();
  s3[0] = p.v.origin[0]; s3[1] = p.v.origin[1];
  s3[2] = p.v.absmin[2] + (p.v.maxs[2] - p.v.mins[2]) * 0.7;
  const e3 = vec3(); e3[0] = s3[0] - 2048; e3[1] = s3[1]; e3[2] = s3[2];
  const t3 = SV_Move(s3, vec3(), vec3(), e3, MOVE_NORMAL, p);
  info("pb-probe", `player origin=[${Array.from(p.v.origin).map((v) => v.toFixed(1))}] ` +
    `FireBullets src=[${Array.from(s3).map((v) => v.toFixed(1))}] ` +
    `trigger box x ${trig.v.mins[0]}..${trig.v.maxs[0]} z ${trig.v.mins[2]}..${trig.v.maxs[2]} ` +
    `| straight-ahead trace frac=${t3.fraction.toFixed(5)} ent=#${t3.ent ? edictIndex(t3.ent) : -1} ` +
    `class='${t3.ent ? classOf(t3.ent) : "?"}' startsolid=${t3.startsolid} endpos=[${Array.from(t3.endpos).map((v) => v.toFixed(1))}]`);
}
const pbEye: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.absmin[2] + (p.v.maxs[2] - p.v.mins[2]) * 0.7];
const pbYaw = yawTo(pbEye, c);
const pbPitch = pitchTo(pbEye, c);
let pbMin = trig.v.health;
let pbMsg = false;
const pbBase = centerText();
const pbHold: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
cmd("+attack");
for (let i = 0; i < 40; i++) {
  aim(pbYaw, pbPitch);
  p.v.origin[0] = pbHold[0]; p.v.origin[1] = pbHold[1]; p.v.origin[2] = pbHold[2];
  p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
  SV_LinkEdict(p, false);
  frames(1);
  if (trig.v.health < pbMin) pbMin = trig.v.health;
  if (trig.v.takedamage === 0) pbMsg = true;
}
cmd("-attack");
frames(4);
info("pointblank", `player x=${p.v.origin[0].toFixed(1)} gap to trigger face = ${pbDist.toFixed(1)} units, aim yaw=${pbYaw.toFixed(1)} pitch=${pbPitch.toFixed(1)}`);
check("N7-pointblank", pbMin <= 0 || pbMsg,
  `point-blank shot registers (minHealth=${pbMin}, multi_trigger ran=${pbMsg}, gap=${pbDist.toFixed(1)}, base=${JSON.stringify(pbBase.slice(0,20))})`);

summary("secret");
process.exit(0);
