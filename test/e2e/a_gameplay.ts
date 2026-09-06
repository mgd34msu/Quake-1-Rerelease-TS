// Scenario 4: gameplay commands on e1m1 (soft renderer).
import { boot, cmd, pump, waitInGame, shot, state, jlog, playerOrigin, svPlayerOrigin, check, summary } from "./a_lib";
import { cl } from "../../src/client/client";
import { sv } from "../../src/server/server";
import { Cvar_VariableValue } from "../../src/common/cvar";

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
check(`map ${startMap} reaches the level`, f >= 0, `waitFrames=${f} ${state()}`);
await pump(40);
check(`${startMap} spawned a full entity set`, sv.num_edicts > 32, `sv.num_edicts=${sv.num_edicts}`);
const spawnOrigin = svPlayerOrigin();

// --- cheats ---
// The cheat commands flip flags on the player edict, which is what "the
// cheat took" actually means: defs.qc's FL_GODMODE is 64 and FL_NOTARGET is
// 128, and `fly` sets MOVETYPE_FLY (5).
for (const [c, want] of [["god", 64], ["notarget", 128]] as const) {
  console.log(`[A] === ${c} ===`);
  cmd(c);
  await pump(10);
  step(c);
  const flags = sv.edicts?.[1]?.v.flags ?? 0;
  check(`${c} sets its flag on the player edict`, (flags & want) !== 0, `flags=${flags} want bit ${want}`);
}
console.log("[A] === fly ===");
cmd("fly");
await pump(10);
step("fly");
check("fly switches the player to MOVETYPE_FLY", (sv.edicts?.[1]?.v.movetype ?? 0) === 5, `movetype=${sv.edicts?.[1]?.v.movetype}`);
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
check("noclip + +forward moves the player", dist > 100, `moved ${dist.toFixed(1)} units`);
const noclipShot = await shot("noclip_moved", out);
check("screenshot after the noclip move", noclipShot !== null, String(noclipShot));
cmd("noclip");
await pump(10);

// --- give / impulses ---
console.log("[A] === give all + weapons ===");
cmd("impulse 9"); // all weapons + ammo cheat
await pump(10);
step("impulse 9", { items: cl.items, stats: [cl.stats[6] ?? null] });
// The eight id1 weapon bits are IT_SHOTGUN 1 .. IT_LIGHTNING 64 plus
// IT_AXE 4096; impulse 9 (QuakeC's cheat) hands out all of them.
check("impulse 9 gives every weapon", (cl.items & 0x7f) === 0x7f && (cl.items & 4096) !== 0, `cl.items=${cl.items}`);
cmd("give h 100");
await pump(10);
step("give h 100", { health: cl.stats[0] });
check("give h 100 raises health to 100", cl.stats[0] >= 100, `health=${cl.stats[0]}`);
cmd("give 7");
await pump(10);
step("give 7");

// Impulse 1 is the axe (IT_AXE 4096); impulses 2..8 are the shotgun through
// the thunderbolt, IT_ bit 1<<(N-2). The server's own `self.weapon` carries
// the whole bit; the CLIENT's STAT_ACTIVEWEAPON is only the low byte of it
// under protocol 15, which writes the field with MSG_WriteByte (see
// src/common/protocol/nq15.ts) -- so the axe reads back as 0 on the client
// there, exactly as it does in WinQuake.
const WANT_WEAPON = [4096, 1, 2, 4, 8, 16, 32, 64];
for (let i = 1; i <= 8; i++) {
  cmd(`impulse ${i}`);
  await pump(12);
  const p = await shot(`weapon${i}`, out);
  const svWeapon = sv.edicts?.[1]?.v.weapon ?? -1;
  step(`impulse ${i}`, { shot: p, weapon: cl.stats[10] ?? null, svWeapon, items: cl.items });
  check(`impulse ${i} selects weapon ${i} on the server`, svWeapon === WANT_WEAPON[i - 1], `self.weapon=${svWeapon} want=${WANT_WEAPON[i - 1]}`);
  check(
    `impulse ${i} reaches the client's STAT_ACTIVEWEAPON`,
    cl.stats[10] === (WANT_WEAPON[i - 1] & 0xff),
    `STAT_ACTIVEWEAPON=${cl.stats[10]} want=${WANT_WEAPON[i - 1] & 0xff} (protocol 15 sends this field as a byte)`,
  );
  check(`impulse ${i} screenshot written`, p !== null, String(p));
}

// --- kill / respawn ---
if (doKill) {
console.log("[A] === kill ===");
// Single player: QuakeC's ClientKill calls respawn(), which in a
// non-deathmatch, non-coop game is `localcmd("restart\n")` -- the level
// reloads and the player is back at its spawn point at full health. (In
// deathmatch it would instead be a corpse waiting on +attack; that path is
// the deathmatch scenario further down, not this one.)
const beforeKill = svPlayerOrigin();
cmd("kill");
await pump(60);
step("kill", { health: cl.stats[0] });
const afterKill = svPlayerOrigin();
const backToSpawn = Math.hypot(afterKill[0] - spawnOrigin[0], afterKill[1] - spawnOrigin[1], afterKill[2] - spawnOrigin[2]);
check(
  "kill restarts the level and puts the player back at its spawn point",
  backToSpawn < 4,
  `spawn=[${spawnOrigin.map((n) => Math.round(n)).join(",")}] beforeKill=[${beforeKill.map((n) => Math.round(n)).join(",")}] afterKill=[${afterKill.map((n) => Math.round(n)).join(",")}] delta=${backToSpawn.toFixed(1)}`,
);
check("the player is alive again after kill", cl.stats[0] === 100, `health=${cl.stats[0]}`);
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
check("restart reloads the same level", rf >= 0 && sv.name === startMap, `waitFrames=${rf} sv.name=${sv.name}`);
check("restart resets the player to full health", cl.stats[0] === 100, `health=${cl.stats[0]}`);
await shot("restart", out);

// --- changelevel ---
console.log("[A] === changelevel e1m2 ===");
cmd("changelevel e1m2");
const cf = await waitInGame(400);
await pump(40);
step("changelevel e1m2", { waitFrames: cf, mapname: cl.levelname });
check("changelevel e1m2 puts the client on e1m2", cf >= 0 && sv.name === "e1m2", `waitFrames=${cf} sv.name=${sv.name}`);
check("changelevel e1m2 shows e1m2's level name", String(cl.levelname).includes("Castle of the Damned"), `levelname=${JSON.stringify(cl.levelname)}`);
await shot("changelevel_e1m2", out);

// --- skill ---
const skillEdicts: Record<string, number> = {};
for (const s of ["0", "3"]) {
  console.log(`[A] === skill ${s} + restart ===`);
  cmd(`skill ${s}`);
  cmd("restart");
  const sf = await waitInGame(400);
  await pump(60);
  step(`skill ${s}`, { waitFrames: sf, num_edicts: sv.num_edicts });
  check(`skill ${s} + restart reaches the level`, sf >= 0, `waitFrames=${sf}`);
  check(`skill ${s} reaches the server's "skill" global`, Cvar_VariableValue("skill") === Number(s), `skill=${Cvar_VariableValue("skill")}`);
  skillEdicts[s] = sv.num_edicts;
  await shot(`skill${s}`, out);
}
// The !easy/!normal/!hard spawnflags remove a different set of entities at
// each skill, so what "skill took" looks like on the server is that the two
// restarts spawned different entity counts on the same map.
check("skill 0 and skill 3 spawn different entity sets", skillEdicts["3"] !== skillEdicts["0"], `skill0=${skillEdicts["0"]} skill3=${skillEdicts["3"]}`);

// --- deathmatch ---
console.log("[A] === deathmatch 1 + map dm1 ===");
cmd("deathmatch 1");
cmd("map dm1");
const df = await waitInGame(400);
await pump(60);
step("deathmatch dm1", { waitFrames: df, num_edicts: sv.num_edicts });
check("deathmatch 1 + map dm1 reaches dm1", df >= 0 && sv.name === "dm1", `waitFrames=${df} sv.name=${sv.name}`);
check("the deathmatch cvar reached the server", Cvar_VariableValue("deathmatch") === 1, `deathmatch=${Cvar_VariableValue("deathmatch")}`);
await shot("dm1_deathmatch", out);

// --- coop ---
console.log("[A] === coop 1 + map e1m1 ===");
cmd("deathmatch 0");
cmd("coop 1");
cmd("map e1m1");
const cof = await waitInGame(400);
await pump(60);
step("coop e1m1", { waitFrames: cof, num_edicts: sv.num_edicts });
check("coop 1 + map e1m1 reaches e1m1", cof >= 0 && sv.name === "e1m1", `waitFrames=${cof} sv.name=${sv.name}`);
check("the coop cvar reached the server", Cvar_VariableValue("coop") === 1, `coop=${Cvar_VariableValue("coop")}`);
await shot("coop_e1m1", out);

console.log("[A] DONE");
summary(`A gameplay ${startMap}`);
