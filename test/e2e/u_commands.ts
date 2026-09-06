/*
Family U scenario 2: what `addbot`, `kickbot`, `bot_count` and `bot_skill`
actually do.

    bun test/e2e/u_commands.ts

Names and colours come out of bots/characters.txt, so this asserts against the
parsed knowledge rather than against a hardcoded roster. Everything else is
read off the server (svs.clients / the bot's edict) and off the local client's
own scoreboard, which is the only place a human sees a bot join or leave.
*/

import { Bot_Knowledge, Bot_Nav, Bot_SkillName, Bot_Slots, FL_ISBOT, bot_count, bot_skill } from "../../src/bots";
import { cl } from "../../src/client/client";
import { net_activeconnections } from "../../src/common/net_main";
import { svs } from "../../src/server/server";
import { BotWatch, PORT_BASE, boot, bootProbe, check, conMark, conSince, ensureBots, exec, execGuarded, finish, frames, liveBots, pumpGuarded } from "./u_lib";

const DT = 0.05;
const PORT = PORT_BASE + 10;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

boot("id1", 12, PORT);

// Host_Init leaves `exec quake.rc` in the command buffer; Cbuf_InsertText
// prepends the file's text with no separator of its own, so if the file has no
// trailing newline its last line and the caller's first queued line become one
// token and the caller's line never runs. The re-release id1 quake.rc ends
// `alias switch_left "switchweapon 6 7"` with no newline.
check(
  "a console command queued before Host_Init's `exec quake.rc` still runs",
  bootProbe.first,
  `first queued echo survived=${bootProbe.first}, second=${bootProbe.second} (src/common/cmd.ts Cbuf_InsertText / Cmd_Exec_f)`,
);

exec("deathmatch 1", 2);
exec("bot_count 0", 2);
exec("bot_skill medium", 2);
exec("map dm4", 20);

const knowledge = Bot_Knowledge();
if (knowledge === null) {
  check("bots/*.txt load from the re-release id1 tree", false, "Bot_Knowledge() is null; bots/weapons.txt or settings_*.txt did not load");
  finish();
}

check("bots/characters.txt parsed", knowledge.characters.length > 0, `${knowledge.characters.length} characters, ${knowledge.skills.length} skills`);

//============================================================================
// addbot: names and colours out of characters.txt

function slotOf(name: string): number {
  for (const [clientnum, slot] of Bot_Slots()) if (slot.name === name) return clientnum;
  return -1;
}

function colorsFor(shirt: number, pants: number): number {
  return ((shirt & 15) << 4) | (pants & 15);
}

exec("addbot", 6);
const randomNums = liveBots();
check("addbot with no argument puts one bot in the game", randomNums.length === 1, `live bots=${randomNums.length}`);

if (randomNums.length === 1) {
  const clientnum = randomNums[0]!;
  const client = svs.clients[clientnum]!;
  const entry = knowledge.characters.find((c) => c.funName === client.name);
  check(`addbot name "${client.name}" is a characters.txt fun_name`, entry !== undefined, entry === undefined ? `not one of the ${knowledge.characters.length} entries` : `matches "${entry.name}"`);
  if (entry !== undefined) {
    check(`addbot colours match characters.txt`, client.colors === colorsFor(entry.shirtColor, entry.pantsColor), `colors=${client.colors} expected=${colorsFor(entry.shirtColor, entry.pantsColor)} (shirt ${entry.shirtColor} pants ${entry.pantsColor})`);
  }
  const ent = client.edict;
  check("the bot's edict carries FL_ISBOT", ent !== null && ((ent.v.flags | 0) & FL_ISBOT) !== 0, ent === null ? "no edict" : `flags=${ent.v.flags | 0}`);
  // Bot_PutInServer writes `team` from the shirt colour before it runs
  // PutClientInServer, and the QuakeC then writes TEAM_NONE (-1) over it in a
  // free-for-all -- which is what a human client gets too. `colormap` is the
  // engine-owned half and has to survive.
  check("the bot's colormap is its client slot", ent !== null && ent.v.colormap === clientnum + 1, ent === null ? "no edict" : `colormap=${ent.v.colormap} slot=${clientnum}`);
  console.log(`## free-for-all deathmatch: the QuakeC left ${client.name}'s team at ${ent === null ? "n/a" : ent.v.team} (TEAM_NONE); u_ctf.ts covers real team assignment`);

  const score = cl.scores[clientnum];
  check("the local client's scoreboard shows the bot", score !== undefined && score.name === client.name, score === undefined ? "no scoreboard row" : `row ${clientnum} name="${score.name}" colors=${score.colors}`);
  check("the scoreboard row carries the bot's colours", score !== undefined && score.colors === client.colors, score === undefined ? "no scoreboard row" : `row colors=${score.colors} client colors=${client.colors}`);
}

// A `name` from characters.txt selects that character; its fun_name is what
// everyone sees.
const named = knowledge.characters.find((c) => c.name !== "" && c.funName !== "");
if (named !== undefined) {
  exec(`addbot ${named.name} hard`, 6);
  const clientnum = slotOf(named.funName);
  check(`addbot ${named.name} spawns "${named.funName}"`, clientnum >= 0, clientnum < 0 ? `no bot named "${named.funName}"` : `slot ${clientnum}`);
  if (clientnum >= 0) {
    check(`addbot ${named.name} takes that entry's colours`, svs.clients[clientnum]!.colors === colorsFor(named.shirtColor, named.pantsColor), `colors=${svs.clients[clientnum]!.colors} expected=${colorsFor(named.shirtColor, named.pantsColor)}`);
  }
}

exec("addbot Zaphod", 6);
const verbatim = slotOf("Zaphod");
check("addbot with a name characters.txt does not have uses it verbatim", verbatim >= 0, verbatim < 0 ? "no bot named Zaphod" : `slot ${verbatim} colors=${svs.clients[verbatim]!.colors}`);

//============================================================================
// kickbot

if (verbatim >= 0) {
  const before = liveBots().length;
  const edict = svs.clients[verbatim]!.edict;
  exec("kickbot Zaphod", 6);
  check("kickbot removes exactly one bot", liveBots().length === before - 1, `${before} -> ${liveBots().length}`);
  check("kickbot frees the client slot", !svs.clients[verbatim]!.active, `active=${svs.clients[verbatim]!.active}`);
  check("kickbot clears FL_ISBOT on the body", edict !== null && ((edict.v.flags | 0) & FL_ISBOT) === 0, edict === null ? "no edict" : `flags=${edict.v.flags | 0}`);
  const score = cl.scores[verbatim];
  check("kickbot clears the scoreboard row", score !== undefined && score.name === "", score === undefined ? "no scoreboard row" : `row ${verbatim} name="${score.name}"`);
}

{
  const mark = conMark();
  exec("kickbot nosuchbot", 4);
  check("kickbot names a bot it cannot find", conSince(mark).some((l) => l.includes('kickbot: no bot named "nosuchbot"')), conSince(mark).slice(-3).join(" | "));
}

exec("kickbot all", 6);
check("kickbot all empties the roster", liveBots().length === 0 && Bot_Slots().size === 0, `live=${liveBots().length} slots=${Bot_Slots().size}`);

//============================================================================
// bot_skill

check("bot_skill 0 selects the first skill in settings_*.txt", Bot_SkillName("0") === knowledge.skillNames()[0], `${Bot_SkillName("0")} vs ${knowledge.skillNames()[0]}`);
check("bot_skill 3 selects the fourth", Bot_SkillName("3") === knowledge.skillNames()[3], `${Bot_SkillName("3")} vs ${knowledge.skillNames()[3]}`);
check("bot_skill by name is honoured", Bot_SkillName("nightmare") === "nightmare", Bot_SkillName("nightmare"));
check("a skill number past the end clamps to the hardest", Bot_SkillName("99") === knowledge.skillNames()[knowledge.skillNames().length - 1], Bot_SkillName("99"));
exec("bot_skill hard", 2);
check("bot_skill is a registered archived cvar", bot_skill.string === "hard" && bot_skill.archive, `string="${bot_skill.string}" archive=${bot_skill.archive}`);

//============================================================================
// bot_count across a map change, and whether the roster survives one

exec("kickbot all", 4);
exec("bot_count 6", 2);
exec("map dm4", 20);
check("bot_count 6 auto-fills six bots on a map that mapdb flags for bots", liveBots().length === 6, `live=${liveBots().length} bot_count=${bot_count.value}`);

exec("kickbot all", 4);
exec("bot_count 2", 2);
exec("map dm6", 20);
check("bot_count 2 auto-fills two", liveBots().length === 2, `live=${liveBots().length}`);

exec("kickbot all", 4);
exec("bot_count 4", 2);
exec("map dm4", 20);
const beforeChange = liveBots().map((n) => svs.clients[n]!.name);
const connectionsBefore = net_activeconnections;
check("bot_count 4 auto-fills four", beforeChange.length === 4, beforeChange.join(", "));

exec("map dm6", 20);
const afterChange = liveBots();
check(
  "the bots survive a `map` change with bot_count set",
  afterChange.length === 4,
  `before=${beforeChange.length} (${beforeChange.join(", ")}) after=${afterChange.length}; Bot_Slots() still holds ${Bot_Slots().size} slots`,
);

check(
  "a map change with bots on the server leaves net_activeconnections alone",
  net_activeconnections >= connectionsBefore,
  `net_activeconnections ${connectionsBefore} -> ${net_activeconnections} across one map change with ${beforeChange.length} bots`,
);

//============================================================================
// bot_count while a level is already running

{
  ensureBots(4);
  frames(4, DT);
  const before = liveBots().length;
  exec("bot_count 6", 2);
  frames(60, DT);
  const after = liveBots().length;
  console.log(`## bot_count raised from ${before} to 6 mid-level: live bots ${before} -> ${after} (auto-fill runs at SV_SpawnServer, see src/bots/bot_client.ts Bot_AutoFill)`);
  check("bot_count mid-level is at least not destructive", after >= before, `${before} -> ${after}`);
  exec("bot_count 4", 2);
}

//============================================================================
// skill 0 vs skill 3: aim and speed have to show up in the play

interface RunResultT {
  skill: string;
  frags: number;
  attackFrames: number;
  distance: number;
  deaths: number;
}

function playOneMatch(skill: string, seconds: number): RunResultT {
  exec("kickbot all", 4);
  exec(`bot_skill ${skill}`, 2);
  exec("bot_count 0", 2);
  exec("map dm4", 20);
  ensureBots(4);
  frames(10, DT);
  const watch = new BotWatch(DT);
  pumpGuarded(Math.round(seconds / DT), DT, () => watch.sample());
  const obs = watch.report();
  return {
    skill,
    frags: obs.reduce((a, o) => a + o.frags, 0),
    attackFrames: obs.reduce((a, o) => a + o.attackFrames, 0),
    distance: obs.reduce((a, o) => a + o.distance, 0),
    deaths: obs.reduce((a, o) => a + o.deaths, 0),
  };
}

const MATCH_SECONDS = Number(argOf("--match-seconds") ?? "90");
const easy = playOneMatch("0", MATCH_SECONDS);
const hard = playOneMatch("3", MATCH_SECONDS);
function perShot(r: RunResultT): string {
  return r.attackFrames === 0 ? "n/a" : (r.frags / r.attackFrames).toFixed(4);
}
console.log(`## skill 0 (${easy.skill}): frags=${easy.frags} attackFrames=${easy.attackFrames} frags/attackFrame=${perShot(easy)} distance=${Math.round(easy.distance)} deaths=${easy.deaths}`);
console.log(`## skill 3 (${hard.skill}): frags=${hard.frags} attackFrames=${hard.attackFrames} frags/attackFrame=${perShot(hard)} distance=${Math.round(hard.distance)} deaths=${hard.deaths}`);

check(
  `kills per minute differ between bot_skill 0 and bot_skill 3`,
  easy.frags !== hard.frags,
  `skill 0 = ${easy.frags} frags/${MATCH_SECONDS}s, skill 3 = ${hard.frags} frags/${MATCH_SECONDS}s`,
);
check(
  `the harder skill frags more often`,
  hard.frags > easy.frags,
  `skill 0 = ${easy.frags}, skill 3 = ${hard.frags}`,
);
check(
  `the two skills do not move identically`,
  Math.round(easy.distance) !== Math.round(hard.distance),
  `skill 0 = ${Math.round(easy.distance)} units, skill 3 = ${Math.round(hard.distance)} units`,
);

//============================================================================
// a map with no navigation at all

const NO_NAV_CANDIDATES = ["vault/jrbase5", "vault/tim", "vault/jrwiz3", "test/test_nodes", "test/mals_combatbox"];
let noNavMap = "";
let noNavMark = 0;
for (const candidate of NO_NAV_CANDIDATES) {
  exec("kickbot all", 4);
  exec("bot_count 0", 2);
  const mark = conMark();
  const error = execGuarded(`map ${candidate}`, 20);
  if (error !== null) continue;
  if (liveBots().length !== 0) continue;
  if (Bot_Nav() !== null) continue;
  noNavMap = candidate;
  noNavMark = mark;
  break;
}

if (noNavMap === "") {
  check("a map with no usable .nav was found to test on", false, `none of ${NO_NAV_CANDIDATES.join(", ")} loaded with a null nav graph`);
} else {
  console.log(`## no-nav map: ${noNavMap}`);
  const added = ensureBots(3);
  frames(10, DT);
  check(`addbot works on ${noNavMap}, which has no usable navigation`, added.live === 3, `live=${added.live}`);
  const watch = new BotWatch(DT);
  const error = pumpGuarded(400, DT, () => watch.sample());
  const obs = watch.report();
  const moved = obs.filter((o) => o.distance > 100);
  const lines = conSince(noNavMark);
  const said = lines.some((l) => l.includes("no navigation for") || l.includes("could not be read"));
  console.log(`## ${noNavMap} with no nav: ${obs.map((o) => `${o.name}=${Math.round(o.distance)}u still=${o.longestStillSeconds.toFixed(1)}s`).join(" ")}`);
  check(`no engine error running bots on ${noNavMap}`, error === null, error ?? "clean");
  check(
    `bots on ${noNavMap} either wander without navigation or the engine says the nav is missing`,
    moved.length === obs.length || said,
    `moved=${moved.length}/${obs.length}, console said nav missing=${said}`,
  );
}

finish();
