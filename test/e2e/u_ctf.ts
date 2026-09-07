/*
Family U scenario 3: the re-release CTF tree with bots on both teams.

    bun test/e2e/u_ctf.ts
    bun test/e2e/u_ctf.ts --maps ctf2 --seconds 60 --bots 8

The flags are watched as entities, not only as console text: ThreeWave's
item_flag_team1 / item_flag_team2 sit at their base as SOLID_TRIGGER pickups
and stop being one the moment a carrier takes them, so a flag that never
leaves SOLID_TRIGGER for the whole match is a flag nobody touched. The
console is read as well, because a capture is announced there and the
LOG lines (FLAG-PICKUP / FLAG-CAPTURE / FLAG-DROP / FLAG-RECOVERY) name the
event precisely.
*/

import { Bot_Nav } from "../../src/bots";
import { EDICT_NUM, PR_GetString } from "../../src/progs/progs";
import { SOLID_TRIGGER, sv, svs } from "../../src/server/server";
import { BotWatch, PORT_BASE, SEED, boot, check, conMark, conSince, consoleErrors, ensureBots, exec, finish, frames, liveBots, navMaps, pumpGuarded, row } from "./u_lib";

const DT = 0.05;
const PORT = PORT_BASE + 20;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const seconds = Number(argOf("--seconds") ?? "60");
const wantBots = Number(argOf("--bots") ?? "8");
const only = argOf("--maps");
const onlySet = only === undefined ? null : new Set(only.split(",").map((s) => s.trim().toLowerCase()));

const all = navMaps("ctf");
const maps = onlySet === null ? all : all.filter((m) => onlySet.has(m.map));

console.log(`## u_ctf maps=${maps.length}/${all.length} bots=${wantBots} seconds=${seconds} seed=${SEED}`);
if (maps.length === 0) {
  check("ctf: has .nav maps", false, "the ctf tree ships no bots/navigation/*.nav with a matching .bsp");
  finish();
}

boot("ctf", 12, PORT);
exec("deathmatch 1", 2);
exec("bot_skill 3", 2);
exec(`bot_count ${wantBots}`, 2);

const FLAG_CLASSNAMES = ["item_flag_team1", "item_flag_team2"];

interface FlagT {
  index: number;
  classname: string;
  home: [number, number, number];
}

function findFlags(): FlagT[] {
  const out: FlagT[] = [];
  for (let i = 1; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free || ent.v.classname === 0) continue;
    const classname = PR_GetString(ent.v.classname);
    if (!FLAG_CLASSNAMES.includes(classname)) continue;
    out.push({ index: i, classname, home: [ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!] });
  }
  return out;
}

/** Frags summed per QuakeC team value: ThreeWave's scoreboard is per team. */
function teamScores(): Map<number, number> {
  const scores = new Map<number, number>();
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i]!;
    if (!client.active || client.edict === null) continue;
    const team = client.edict.v.team | 0;
    scores.set(team, (scores.get(team) ?? 0) + client.edict.v.frags);
  }
  return scores;
}

function teamCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const clientnum of liveBots()) {
    const team = svs.clients[clientnum]!.edict!.v.team | 0;
    counts.set(team, (counts.get(team) ?? 0) + 1);
  }
  return counts;
}

const ctfScoresUnknown: string[] = [];
const rowWidths = [8, 6, 5, 10, 8, 8, 7, 8];
console.log(row(["map", "nodes", "bots", "teams", "flags", "touched", "capped", "score"], rowWidths));

for (const entry of maps) {
  const mark = conMark();
  exec(`map ${entry.map}`, 20);
  const roster = ensureBots(wantBots);
  frames(10, DT);

  const navNodes = Bot_Nav()?.nodeCount ?? 0;
  const flags = findFlags();
  const counts = teamCounts();
  const scoresBefore = teamScores();

  // Two unambiguous signals that a flag was taken: it left the spot it spawned
  // on, or it acquired an owner (ThreeWave sets the carrier as the flag's
  // owner). A flag standing at home as a SOLID_TRIGGER pickup is untouched.
  const moved = new Set<number>();
  const carried = new Set<number>();
  const watch = new BotWatch(DT);
  const error = pumpGuarded(Math.round(seconds / DT), DT, () => {
    watch.sample();
    for (const flag of flags) {
      const ent = EDICT_NUM(flag.index);
      if (ent.free) continue;
      if (ent.v.owner !== 0) carried.add(flag.index);
      const away = Math.hypot(ent.v.origin[0]! - flag.home[0], ent.v.origin[1]! - flag.home[1], ent.v.origin[2]! - flag.home[2]);
      if (away > 32) moved.add(flag.index);
      if (ent.v.solid !== SOLID_TRIGGER && away > 32) moved.add(flag.index);
    }
  });

  const lines = conSince(mark);
  const logTouch = lines.filter((l) => l.includes("FLAG-PICKUP") || l.includes("FLAG-DROP") || l.includes("FLAG-RECOVERY"));
  const logCapture = lines.filter((l) => l.includes("FLAG-CAPTURE"));
  const capturedSaid = lines.filter((l) => l.toLowerCase().includes("captured the"));
  const scoresAfter = teamScores();
  const obs = watch.report();
  if (lines.some((l) => l.includes('Unknown command "ctfscores"'))) ctfScoresUnknown.push(entry.map);

  const teamList = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const scoreText = [...scoresAfter.entries()].sort((a, b) => a[0] - b[0]).map(([t, s]) => `${t}:${s}`).join(",");

  console.log(
    row(
      [entry.map, navNodes, roster.live, teamList.map(([t, n]) => `${t}x${n}`).join("/"), flags.length, moved.size + carried.size, logCapture.length + capturedSaid.length, scoreText],
      rowWidths,
    ),
  );

  check(`${entry.map}: .nav loads`, navNodes > 0, `nodeCount=${navNodes}`);
  check(`${entry.map}: ${wantBots} bots in the game`, roster.live === wantBots, `live=${roster.live}`);
  check(`${entry.map}: no engine error in ${seconds}s`, error === null && consoleErrors(lines).length === 0, error ?? consoleErrors(lines)[0] ?? "clean");
  check(`${entry.map}: the map has both team flags`, flags.length === 2, flags.map((f) => f.classname).join(", "));

  check(
    `${entry.map}: bots are split across two teams`,
    teamList.length === 2,
    teamList.map(([t, n]) => `team ${t}: ${n}`).join(", "),
  );
  if (teamList.length === 2) {
    const sizes = teamList.map(([, n]) => n);
    check(`${entry.map}: the teams are balanced`, Math.abs(sizes[0]! - sizes[1]!) <= 1, `${sizes[0]} vs ${sizes[1]}`);
  }

  check(
    `${entry.map}: a flag is touched within ${seconds}s`,
    carried.size > 0 || moved.size > 0 || logTouch.length > 0,
    `flags carried=${carried.size}/${flags.length}, flags off their base=${moved.size}/${flags.length}, FLAG-PICKUP/DROP/RECOVERY lines=${logTouch.length}; bots walked ${obs.reduce((a, o) => a + Math.round(o.distance), 0)} units and fragged ${obs.reduce((a, o) => a + o.frags, 0)} times, so they were playing`,
  );

  check(
    `${entry.map}: a flag is captured within ${seconds}s`,
    logCapture.length > 0 || capturedSaid.length > 0,
    `FLAG-CAPTURE lines=${logCapture.length}, "captured the" prints=${capturedSaid.length}`,
  );

  const changed = [...scoresAfter.entries()].some(([team, score]) => score !== (scoresBefore.get(team) ?? 0));
  check(
    `${entry.map}: team scores move during the match`,
    changed,
    `before=${[...scoresBefore.entries()].map(([t, s]) => `${t}:${s}`).join(",")} after=${scoreText}`,
  );
}

//============================================================================
// the scoreboard command the CTF progs stuffs at every client

check(
  "the `ctfscores` command the CTF progs stuffs at each client exists",
  ctfScoresUnknown.length === 0,
  ctfScoresUnknown.length === 0
    ? "no complaint on any map"
    : `quakec_ctf/status.qc stuffs "ctfscores " at every client and the engine answers Unknown command on ${ctfScoresUnknown.length} maps: ${ctfScoresUnknown.join(" ")}`,
);

finish();
