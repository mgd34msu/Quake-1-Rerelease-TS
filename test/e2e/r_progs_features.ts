/*
Family R, driver 2: the re-release ex_* builtin surface on retail maps, and
the two ruleset crossovers.

  bun test/e2e/r_progs_features.ts --phase rerelease [--vid gl]
  bun test/e2e/r_progs_features.ts --phase ctf       [--vid gl]
  bun test/e2e/r_progs_features.ts --phase classic   [--vid gl]

Three phases because each needs its own engine boot and the engine mounts its
filesystem once per process:

  rerelease -- the re-release id1 tree: ruleset detection, `give all`, the
               weapon switch, a loc'd bprint reaching the console as text, and
               re-release content played under `sv_ruleset classic`.
  ctf       -- the ctf tree: quakec_ctf's ex_prompt/ex_promptchoice menu, a
               choice accepted through the real key handler, the setcolor
               builtin observable on the player entity, the loc'd bprint the
               team join broadcasts, and a loc'd centerprint.
  classic   -- the 1999 id1 tree under `sv_ruleset rerelease`.

"Plays" means the same four things in both crossover directions: the player
spawns, moves, shoots a monster, and the monster's death moves the kill count.

test/e2e/n_lib.ts's line-of-sight search and instrumented shot are reused
rather than re-derived (that family already proved them against retail maps);
that file belongs to another unit and is imported, never edited.
*/

import {
  arg,
  bootTree,
  check,
  cl,
  classicConfig,
  cmd,
  conMark,
  conSince,
  finish,
  frames,
  homedirFor,
  isGL,
  centerprintText,
  shot,
  treeConfig,
  waitInGame,
} from "./r_lib";
import { center, findByClass, losSpot, player, shootAndWatch } from "./n_lib";
import { sv, svs } from "../../src/server/server";
import { SV_Ruleset, SV_RulesetIsRerelease } from "../../src/progs/ext/ruleset";
import { QEX_Extensions } from "../../src/progs/ext/qex";
import { STAT_ACTIVEWEAPON, STAT_MONSTERS } from "../../src/common/quakedef";
import { Key_Event, keyState, KeydestT } from "../../src/client/keys";

const phase = arg("phase", "rerelease");
const vid = arg("vid", "soft");
const tag = `progs_${phase}_${vid}`;
const home = homedirFor(tag);

// ---------------------------------------------------------------------------
// shared steps
// ---------------------------------------------------------------------------

/** `+forward` for `n` frames; returns how far the player edict actually moved. */
function walk(n = 60): number {
  const p = player();
  const from: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
  cmd("+forward", 1);
  frames(n);
  cmd("-forward", 1);
  frames(10);
  const to = player().v.origin;
  return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
}

/** Finds any live, damageable monster with a line of sight, shoots it, and reports the kill count move. */
function killAMonster(label: string): void {
  const monsters = findByClass("monster_army")
    .concat(findByClass("monster_dog"))
    .concat(findByClass("monster_ogre"))
    .concat(findByClass("monster_knight"))
    .filter((m) => m.v.health > 0 && m.v.takedamage > 0);
  check(`${label}/monsters-present`, monsters.length > 0, `${monsters.length} shootable monsters on the map`);

  for (const m of monsters) {
    const spot = losSpot(m, 64, 400);
    if (spot === null) continue;
    const hp = m.v.health;
    const killsBefore = cl.stats[STAT_MONSTERS];
    const r = shootAndWatch(m, 3, [], 60, 60, spot);
    const killsAfter = cl.stats[STAT_MONSTERS];
    check(`${label}/shoot`, r.minHealth < hp, `monster health ${hp} -> ${r.minHealth} from ${Math.round(spot.dist)} units`);
    check(`${label}/monster-dies`, r.minHealth <= 0, `monster health floor ${r.minHealth}`);
    check(`${label}/kill-count`, killsAfter > killsBefore, `killed_monsters ${killsBefore} -> ${killsAfter}`);
    return;
  }
  check(`${label}/shoot`, false, "no monster with a line of sight from any probed stand point");
}

/** spawn + move + shoot + kill count, the brief's "must play" set. */
function playsThrough(label: string): void {
  const p = player();
  check(`${label}/spawn`, p !== undefined && p.v.health > 0, `player health ${p?.v.health ?? "n/a"} at ${center(p).map((n) => Math.round(n)).join(",")}`);
  cmd("god", 2);
  const moved = walk(60);
  check(`${label}/move`, moved > 16, `player moved ${moved.toFixed(1)} units under +forward`);
  killAMonster(label);
}

// ---------------------------------------------------------------------------

if (phase === "rerelease") {
  bootTree({ cfg: treeConfig("id1"), vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  cmd("map e1m1", 2);
  check(`${tag}/map`, waitInGame(700) >= 0, "re-release id1 e1m1 reached in-game");
  keyState.key_dest = KeydestT.key_game;
  frames(40);

  check(`${tag}/ruleset-auto`, SV_RulesetIsRerelease(), `sv_ruleset auto detected "${SV_Ruleset()}" for the re-release progs`);
  check(
    `${tag}/extensions`,
    QEX_Extensions().has("EX_PROMPT") && QEX_Extensions().has("DP_SV_SETCOLOR"),
    Array.from(QEX_Extensions()).join(" "),
  );

  // --- give all ----------------------------------------------------------
  const itemsBefore = player().v.items | 0;
  cmd("give all", 8);
  const itemsAfterGive = player().v.items | 0;
  check(
    `${tag}/give-all`,
    (itemsAfterGive & ~itemsBefore) !== 0,
    `player.items 0x${itemsBefore.toString(16)} -> 0x${itemsAfterGive.toString(16)}`,
  );

  // --- weapon switch -----------------------------------------------------
  cmd("impulse 9", 10);
  const seen = new Set<number>();
  for (let i = 1; i <= 8; i++) {
    cmd(`impulse ${i}`, 12);
    seen.add(cl.stats[STAT_ACTIVEWEAPON]);
  }
  check(`${tag}/weapon-switch`, seen.size >= 5, `impulse 1..8 selected ${seen.size} distinct weapons: ${Array.from(seen).join(",")}`);
  shot(`${tag}_weapons`);

  // --- a loc'd bprint reaching the console as text -----------------------
  // quakec/client.qc's ClientObituary broadcasts a "$qc_suicide_*" key on a
  // self-kill; the server resolves it through QEX_VarString before it goes on
  // the wire, so the console must show the English sentence, not the key.
  const mark = conMark();
  cmd("kill", 2);
  frames(60);
  const printed = conSince(mark).filter((l) => l.trim().length > 0);
  const bprint = printed.find(
    (l) => /becomes bored with life|checks if his weapon is loaded|tries to put the pin back in|suicides/.test(l),
  );
  check(
    `${tag}/locd-bprint`,
    bprint !== undefined && !bprint.includes("$qc_"),
    bprint !== undefined ? `console: "${bprint.trim()}"` : `no localized obituary line; console tail: ${printed.slice(-6).join(" | ")}`,
  );

  // --- re-release content under sv_ruleset classic -----------------------
  cmd("sv_ruleset classic", 2);
  cmd("map e1m1", 2);
  check(`${tag}/classic-on-rerelease/map`, waitInGame(700) >= 0, "re-release e1m1 reloaded under sv_ruleset classic");
  keyState.key_dest = KeydestT.key_game;
  frames(40);
  check(`${tag}/classic-on-rerelease/ruleset`, SV_Ruleset() === "classic", `SV_Ruleset()="${SV_Ruleset()}"`);
  playsThrough(`${tag}/classic-on-rerelease`);
  shot(`${tag}_classic_on_rerelease`);

  finish(tag);
}

if (phase === "classic") {
  bootTree({ cfg: classicConfig("id1"), vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  cmd("sv_ruleset rerelease", 2);
  cmd("map e1m1", 2);
  check(`${tag}/map`, waitInGame(700) >= 0, "classic id1 e1m1 reached in-game under sv_ruleset rerelease");
  keyState.key_dest = KeydestT.key_game;
  frames(40);
  check(`${tag}/ruleset`, SV_Ruleset() === "rerelease", `SV_Ruleset()="${SV_Ruleset()}" over the 1999 progs`);
  playsThrough(`${tag}/rerelease-on-classic`);
  shot(`${tag}_rerelease_on_classic`);

  finish(tag);
}

if (phase === "ctf") {
  bootTree({ cfg: treeConfig("ctf"), vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  // quakec_ctf/client.qc:1345 only puts a connecting player into the observer
  // state that triggers MOTD_ChooseTeam's prompt when teamplay carries
  // TEAM_CAPTURE_SELECT_TEAM (teamplay.qc:55, bit 1024); without it the mod
  // assigns a team silently and no prompt is ever sent.
  cmd("deathmatch 1", 2);
  cmd("teamplay 1025", 2);
  const joinMark = conMark();
  cmd("map ctf1", 2);
  check(`${tag}/map`, waitInGame(700) >= 0, "ctf1 reached in-game");
  keyState.key_dest = KeydestT.key_game;
  frames(120);

  // --- the ex_prompt menu ------------------------------------------------
  // quakec_ctf/status.qc calls prompt("$qc_ctf_intro", 4) then four
  // promptchoice() lines carrying impulses 101..104.
  check(
    `${tag}/prompt-shown`,
    cl.promptText.length > 0 && !cl.promptText.startsWith("$"),
    `promptText="${cl.promptText.replace(/\n/g, "\\n")}" wanted=${cl.promptWanted} choices=${cl.promptChoices.length}`,
  );
  check(
    `${tag}/prompt-choices`,
    cl.promptChoices.length === cl.promptWanted && cl.promptChoices.length > 0 && cl.promptChoices.every((c) => c.text.length > 0 && !c.text.startsWith("$")),
    cl.promptChoices.map((c) => `${c.impulse}:${c.text}`).join(" | "),
  );
  shot(`${tag}_prompt`);

  const redIndex = cl.promptChoices.findIndex((c) => /red/i.test(c.text));
  const pickIndex = redIndex >= 0 ? redIndex : 0;
  const pickImpulse = cl.promptChoices[pickIndex]?.impulse ?? -1;
  const colorsBefore = svs.clients[0]?.colors ?? -1;
  const teamBefore = player().v.team | 0;

  // The real key handler: src/client/keys.ts turns '1'..'9' into the chosen
  // line's impulse while a prompt is up.
  Key_Event(0x31 + pickIndex, true);
  Key_Event(0x31 + pickIndex, false);
  frames(90);

  check(
    `${tag}/prompt-accepted`,
    cl.promptText === "" && cl.promptChoices.length === 0,
    `chose line ${pickIndex + 1} (impulse ${pickImpulse}); promptText now "${cl.promptText}"`,
  );

  // --- setcolor observable on the player entity --------------------------
  // quakec_ctf/teamplay.qc's TeamSetColor calls setcolor(e, color) once
  // checkextension("DP_SV_SETCOLOR") answers true; src/progs/ext/qex.ts's
  // PF_setcolor writes client.colors and edict.v.team.
  const colorsAfter = svs.clients[0]?.colors ?? -1;
  const teamAfter = player().v.team | 0;
  check(
    `${tag}/setcolor`,
    colorsAfter !== colorsBefore && teamAfter !== teamBefore && teamAfter > 0,
    `client.colors ${colorsBefore} -> ${colorsAfter}, player.team ${teamBefore} -> ${teamAfter}`,
  );

  // --- the loc'd bprint the join broadcasts ------------------------------
  const joined = conSince(joinMark).find((l) => /joined the (RED|BLUE) team/i.test(l));
  check(
    `${tag}/locd-bprint`,
    joined !== undefined && !joined.includes("$qc_"),
    joined !== undefined ? `console: "${joined.trim()}"` : "no \"joined the ... team\" line on the console",
  );

  // --- a loc'd centerprint ------------------------------------------------
  // teamplay bit 64 is quakec_ctf/teamplay.qc's TEAM_STATIC_TEAMS; with it
  // set, observ.qc's DoObserverImpulse answers impulse 100 with
  // centerprint(self, "$qc_ctf_teams_locked").
  cmd("teamplay 1089", 2);
  cmd("impulse 100", 2);
  // Sampled rather than read once: scr_centertime is 2 seconds of game time
  // and each frame here is 50 ms, so a single read after a fixed pump can
  // land either side of the window.
  let centered = "";
  for (let i = 0; i < 40 && centered === ""; i++) {
    frames(1);
    centered = centerprintText();
  }
  check(
    `${tag}/locd-centerprint`,
    centered.length > 0 && !centered.includes("$qc_") && /changing teams is disabled/i.test(centered),
    `drawn centerprint: "${centered.replace(/\n/g, "\\n")}"`,
  );
  shot(`${tag}_centerprint`);

  // quakec_ctf/status.qc's SendCTFScoresUpdate stuffcmds
  // "ctfscores <red> <blue> <flagstatus>" to every client on every status
  // update: the mod's only channel for the team scores and flag state the CTF
  // HUD draws. An engine with no such command answers every update with
  // "Unknown command".
  const stuffed = conSince(joinMark).filter((l) => l.includes("Unknown command"));
  check(
    `${tag}/client-commands`,
    stuffed.length === 0,
    stuffed.length === 0 ? "no unknown stuffcmd from the ctf progs" : `${stuffed.length} unknown-command lines, e.g. ${stuffed[0].trim()}`,
  );

  check(`${tag}/edicts`, sv.num_edicts > 16, `${sv.num_edicts} edicts on ctf1`);
  finish(tag);
}

console.log(`[FAIL] ${tag}/phase :: unknown --phase "${phase}" (rerelease|ctf|classic)`);
console.log("RESULT 0 1");
process.exit(1);
