/*
Family U scenario 4: bots in coop, alongside the local player, on the
re-release e1m1.

    bun test/e2e/u_coop.ts
    bun test/e2e/u_coop.ts --map e1m2 --seconds 120

`bot_count`'s auto-fill is deathmatch-only by construction (src/bots/
bot_client.ts's Bot_AutoFill), so a coop roster is built with `addbot`, which
is the operator path the same file documents. What is asserted afterwards is
coop behaviour: the monsters e1m1 spawns get killed, the bots shoot, and none
of them is still standing on its spawn point when the first ten seconds are up.
*/

import { Bot_Knowledge } from "../../src/bots";
import { EDICT_NUM, PR_GetString } from "../../src/progs/progs";
import { FL_MONSTER, sv, svs } from "../../src/server/server";
import { BotWatch, PORT_BASE, boot, check, conMark, conSince, consoleErrors, ensureBots, exec, finish, frames, liveBots, pumpGuarded } from "./u_lib";

const DT = 0.05;
const PORT = PORT_BASE + 30;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const map = argOf("--map") ?? "e1m1";
// 120 s: on the untouched brain the two combat checks were a coin flip per
// seed inside 60 s (bots walk 8-9k units on e1m1 but their routes face a
// monster in only a handful of frames at some seeds); two minutes gives
// every seeded match the encounter the checks are about.
const seconds = Number(argOf("--seconds") ?? "120");
const wantBots = Number(argOf("--bots") ?? "3");

boot("id1", 8, PORT);
exec("deathmatch 0", 2);
exec("coop 1", 2);
exec("bot_count 0", 2);
exec("bot_skill 3", 2);

const mark = conMark();
exec(`map ${map}`, 20);

/** Monsters that are alive right now, by edict index. */
function liveMonsters(): number[] {
  const out: number[] = [];
  for (let i = 1; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free) continue;
    if (((ent.v.flags | 0) & FL_MONSTER) === 0) continue;
    if (ent.v.health <= 0 || ent.v.deadflag !== 0) continue;
    out.push(i);
  }
  return out;
}

function playerOrigin(): [number, number, number] | null {
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i]!;
    if (!client.active || client.edict === null) continue;
    if (client.netconnection === null) continue; // a bot
    const o = client.edict.v.origin;
    return [o[0]!, o[1]!, o[2]!];
  }
  return null;
}

// walkmonster_start's think chain is what sets FL_MONSTER, so give it a few
// frames before counting.
frames(20, DT);
const monstersAtStart = liveMonsters().length;

const roster = ensureBots(wantBots);
frames(10, DT);

check("the coop server accepted bots alongside the player", roster.live === wantBots, `live bots=${roster.live}, human clients=${playerOrigin() === null ? 0 : 1}`);
check(`${map} in coop still spawns its monsters`, monstersAtStart > 10, `${monstersAtStart} monsters alive after the spawn chain`);

const player = playerOrigin();
check("the local player is in the game", player !== null, player === null ? "no client with a netconnection" : `origin ${player.map((v) => Math.round(v)).join(" ")}`);

//============================================================================
// ten seconds: nobody may still be standing where they spawned

const early = new BotWatch(DT);
const earlyError = pumpGuarded(Math.round(10 / DT), DT, () => early.sample());
const earlyObs = early.report();
check("no engine error in the first ten seconds of coop", earlyError === null, earlyError ?? "clean");
const stuckAtStart = earlyObs.filter((o) => o.distance <= 150);
check(
  "no bot is stuck at the start of the level",
  stuckAtStart.length === 0 && earlyObs.length > 0,
  earlyObs.map((o) => `${o.name}=${Math.round(o.distance)}u still=${o.longestStillSeconds.toFixed(1)}s`).join(" "),
);

//============================================================================
// the rest of the match

const watch = new BotWatch(DT);
let closestApproach = Number.POSITIVE_INFINITY;
const error = pumpGuarded(Math.round((seconds - 10) / DT), DT, () => {
  watch.sample();
  const p = playerOrigin();
  if (p === null) return;
  for (const clientnum of liveBots()) {
    const o = svs.clients[clientnum]!.edict!.v.origin;
    const d = Math.hypot(o[0]! - p[0], o[1]! - p[1], o[2]! - p[2]);
    if (d < closestApproach) closestApproach = d;
  }
});

const obs = watch.report();
const monstersAtEnd = liveMonsters().length;
const lines = conSince(mark);
const killed = monstersAtStart - monstersAtEnd;

console.log(`## coop ${map}: monsters ${monstersAtStart} -> ${monstersAtEnd} (${killed} died)`);
console.log(`## bots: ${obs.map((o) => `${o.name} dist=${Math.round(o.distance)} shots=${o.attackFrames} target frames=${o.targetFrames} frags=${o.frags} deaths=${o.deaths}`).join(" | ")}`);
for (const clientnum of liveBots()) {
  const ent = svs.clients[clientnum]!.edict!;
  console.log(`## ${svs.clients[clientnum]!.name}: items=0x${(ent.v.items | 0).toString(16)} weapon=${ent.v.weapon} shells=${ent.v.ammo_shells} nails=${ent.v.ammo_nails} health=${ent.v.health} team=${ent.v.team}`);
}
console.log(`## closest a bot came to the player: ${Number.isFinite(closestApproach) ? Math.round(closestApproach) : "n/a"} units`);

// Whether the brain would even call these monsters hostile: brain.ts's
// friendly() treats a monster the knowledge file does not list as scenery.
{
  const knowledge = Bot_Knowledge();
  const classes = [...new Set(liveMonsters().map((i) => PR_GetString(EDICT_NUM(i).v.classname)))];
  const known = classes.filter((c) => knowledge !== null && knowledge.monster(c) !== undefined);
  console.log(`## monster classes on the level: ${classes.join(" ")}`);
  console.log(`## of those, listed in bots/monsters.txt: ${known.join(" ") || "none"}`);
  check(
    "every monster class on the level is one bots/monsters.txt describes",
    knowledge !== null && known.length === classes.length,
    `${known.length}/${classes.length} known; brain.ts friendly() treats an unlisted monster as scenery and never targets it`,
  );
}

check(`no engine error in ${seconds}s of coop`, error === null && consoleErrors(lines).length === 0, error ?? consoleErrors(lines)[0] ?? "clean");
check(
  "the bots fight: they pressed the attack button",
  obs.reduce((a, o) => a + o.attackFrames, 0) > 0,
  `attack frames=${obs.reduce((a, o) => a + o.attackFrames, 0)}, frames holding a target=${obs.reduce((a, o) => a + o.targetFrames, 0)}`,
);
check(
  "the bots take a monster as a combat target in coop",
  obs.reduce((a, o) => a + o.targetFrames, 0) > 0,
  `frames holding a target=${obs.reduce((a, o) => a + o.targetFrames, 0)} over ${monstersAtStart} monsters on the level`,
);
check("monsters die during the coop run", killed > 0, `${monstersAtStart} -> ${monstersAtEnd}`);
check(
  "the bots move through the level rather than milling on the spawn",
  obs.every((o) => o.distance > 15 * seconds),
  obs.map((o) => `${o.name}=${Math.round(o.distance)}`).join(" "),
);
// 1024, not 512: the driver's human never moves off its spawn, and once the
// bots have cleared the start yard they leave it through e1m1's one-way floor
// slab (G12) and cannot come back; the yard is about a thousand units across,
// so this is "the bots worked the same area as the human" in practice.
check(
  "at least one bot came within 1024 units of the player",
  closestApproach <= 1024,
  `closest approach=${Number.isFinite(closestApproach) ? Math.round(closestApproach) : "never measured"} units`,
);

const obituaries = lines.filter((l) => l.includes(" was ") || l.includes(" ate ") || l.includes(" chewed ") || l.includes("bit the dust"));
console.log(`## obituaries seen: ${obituaries.length}${obituaries.length > 0 ? " e.g. " + obituaries[0] : ""}`);

//============================================================================
// which monsters actually died, for the report

const byClass = new Map<string, number>();
for (let i = 1; i < sv.num_edicts; i++) {
  const ent = EDICT_NUM(i);
  if (ent.free || ent.v.classname === 0) continue;
  if (((ent.v.flags | 0) & FL_MONSTER) === 0 && ent.v.health > 0) continue;
  const classname = PR_GetString(ent.v.classname);
  if (!classname.startsWith("monster_")) continue;
  if (ent.v.health > 0 && ent.v.deadflag === 0) continue;
  byClass.set(classname, (byClass.get(classname) ?? 0) + 1);
}
console.log(`## dead monsters by class: ${[...byClass.entries()].map(([c, n]) => `${c}=${n}`).join(" ") || "none"}`);

finish();
