// Scenario 4: gameplay commands on e1m1 (soft renderer).
import { boot, cmd, pump, waitInGame, shot, state, jlog, playerOrigin, svPlayerOrigin } from "./a_lib";
import { cl } from "../../src/client/client";
import { sv } from "../../src/server/server";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const out = arg("out", "/tmp/a_shots_gp");
const startMap = arg("map", "e1m1");
const doKill = process.argv.indexOf("--nokill") < 0;

function step(name: string, extra: Record<string, unknown> = {}): void {
  jlog("step", { step: name, state: state(), origin: playerOrigin(), svorigin: svPlayerOrigin(), num_edicts: sv.num_edicts, ...extra });
}

boot(["-vid_ref", "soft"]);
await pump(20);

console.log(`[A] === load ${startMap} ===`);
cmd(`map ${startMap}`);
const f = await waitInGame(500);
step(`map ${startMap}`, { waitFrames: f });
await pump(40);

// --- cheats ---
for (const c of ["god", "notarget", "fly"]) {
  console.log(`[A] === ${c} ===`);
  cmd(c);
  await pump(10);
  step(c);
}
cmd("fly"); // toggle back off
await pump(5);

// --- noclip + movement ---
console.log("[A] === noclip + forward ===");
cmd("noclip");
await pump(10);
const beforeMove = svPlayerOrigin();
cmd("+forward");
await pump(60);
cmd("-forward");
await pump(10);
const afterMove = svPlayerOrigin();
const dist = Math.hypot(afterMove[0] - beforeMove[0], afterMove[1] - beforeMove[1], afterMove[2] - beforeMove[2]);
step("noclip+forward", { beforeMove, afterMove, dist });
await shot("noclip_moved", out);
cmd("noclip");
await pump(10);

// --- give / impulses ---
console.log("[A] === give all + weapons ===");
cmd("impulse 9"); // all weapons + ammo cheat
await pump(10);
step("impulse 9", { items: cl.items, stats: [cl.stats[6] ?? null] });
cmd("give h 100");
await pump(10);
step("give h 100", { health: cl.stats[0] });
cmd("give 7");
await pump(10);
step("give 7");

for (let i = 1; i <= 8; i++) {
  cmd(`impulse ${i}`);
  await pump(12);
  const p = await shot(`weapon${i}`, out);
  step(`impulse ${i}`, { shot: p, weapon: cl.stats[7] ?? null, items: cl.items });
}

// --- kill / respawn ---
if (doKill) {
console.log("[A] === kill ===");
cmd("kill");
await pump(40);
step("kill", { health: cl.stats[0] });
await shot("dead", out);
cmd("+attack");
await pump(30);
cmd("-attack");
await pump(40);
step("respawn", { health: cl.stats[0] });
await shot("respawn", out);
}

// --- restart ---
console.log("[A] === restart ===");
cmd("restart");
const rf = await waitInGame(400);
await pump(40);
step("restart", { waitFrames: rf });
await shot("restart", out);

// --- changelevel ---
console.log("[A] === changelevel e1m2 ===");
cmd("changelevel e1m2");
const cf = await waitInGame(400);
await pump(40);
step("changelevel e1m2", { waitFrames: cf, mapname: cl.levelname });
await shot("changelevel_e1m2", out);

// --- skill ---
for (const s of ["0", "3"]) {
  console.log(`[A] === skill ${s} + restart ===`);
  cmd(`skill ${s}`);
  cmd("restart");
  const sf = await waitInGame(400);
  await pump(60);
  step(`skill ${s}`, { waitFrames: sf, num_edicts: sv.num_edicts });
  await shot(`skill${s}`, out);
}

// --- deathmatch ---
console.log("[A] === deathmatch 1 + map dm1 ===");
cmd("deathmatch 1");
cmd("map dm1");
const df = await waitInGame(400);
await pump(60);
step("deathmatch dm1", { waitFrames: df, num_edicts: sv.num_edicts });
await shot("dm1_deathmatch", out);

// --- coop ---
console.log("[A] === coop 1 + map e1m1 ===");
cmd("deathmatch 0");
cmd("coop 1");
cmd("map e1m1");
const cof = await waitInGame(400);
await pump(60);
step("coop e1m1", { waitFrames: cof, num_edicts: sv.num_edicts });
await shot("coop_e1m1", out);

console.log("[A] DONE");
process.exit(0);
