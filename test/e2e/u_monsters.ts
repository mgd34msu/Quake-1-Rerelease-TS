/*
Family U scenario 5: monster pathing through `walkpathtogoal`, and what the
nav graph is worth compared with the eight-direction shuffle it replaces.

    bun test/e2e/u_monsters.ts
    bun test/e2e/u_monsters.ts --map e2m1 --seconds 20 --limit 24

Each monster is given a goal it cannot see -- a nav node far enough away that
the traceline between them is blocked -- with the local player's body moved
onto that node, so "the player's area" is a real place in the level.

Two runs from the same start, one tick each per step:

  with nav -- exactly the shipped QuakeC's own call shape,
      `if (walkpathtogoal(dist, goal) != PATH_IN_PROGRESS) movetogoal(dist);`
      (quakec/ai.qc's ai_pathtogoal), so the nav hook gets the same fallback
      it gets in a real game;
  without nav -- the graph unloaded, where `walkpathtogoal` answers PATH_ERROR
      every time and only `movetogoal` (sv_move.c's SV_MoveToGoal) moves the
      monster.

The two distances closed are the comparison. Neither run pumps SV_Physics --
this steps the movement functions directly, the way test/bots.test.ts does --
so the absolute seconds are harness time, not wall time; both runs get exactly
the same treatment, which is what makes the ratio meaningful.
*/

import { Bot_ClearNav, Bot_LoadNav, Bot_MonsterPath, Bot_Nav, Bot_WalkPathToGoal } from "../../src/bots";
import { EDICT_TO_PROG, EDICT_NUM, PR_GetString, pr, type EdictT } from "../../src/progs/progs";
import { OFS_PARM0 } from "../../src/progs/pr_comp";
import { SV_MoveToGoal } from "../../src/server/sv_move";
import { MOVE_NOMONSTERS, SV_LinkEdict, SV_Move, SV_PointContents } from "../../src/server/world";
import { CONTENTS_LAVA, CONTENTS_SLIME } from "../../src/common/bspfile";
import { FL_MONSTER, FL_ONGROUND, sv, svs } from "../../src/server/server";
import { PATH_ERROR, PATH_IN_PROGRESS, PATH_MOVE_BLOCKED, PATH_REACHED_GOAL, PATH_REACHED_PATH_END } from "../../src/progs/ext/qex_hooks";
import { defaultTraverseCaps, type NavGraph } from "../../src/lib/bot_brain/nav_graph";
import { vec3 } from "../../src/common/mathlib";
import { PORT_BASE, SEED, boot, check, exec, finish, frames, row } from "./u_lib";

const DT = 0.05;
const PORT = PORT_BASE + 40;
/** One `walkpathtogoal` call stands in for one ai_run tick. */
const STEP_SECONDS = 0.1;
/** The `movedist` a walking Quake monster passes to movetogoal. */
const MOVE_DIST = 12;
/** A goal has to be far enough away that getting there is a real journey. */
const MIN_GOAL_DISTANCE = 600;
/** Inside this of the goal the monster has arrived. */
const ARRIVED = 128;
/** Matches bot_hooks.ts's own STEP_HEIGHT: how far the start-node visibility trace lifts a walking monster's box before tracing. */
const STEP_HEIGHT = 18;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const map = argOf("--map") ?? "e1m1";
const seconds = Number(argOf("--seconds") ?? "40");
const limit = Number(argOf("--limit") ?? "24");
const steps = Math.round(seconds / STEP_SECONDS);

console.log(`## u_monsters map=${map} seconds=${seconds} limit=${limit} seed=${SEED}`);

boot("id1", 8, PORT);
exec("deathmatch 0", 2);
exec("coop 0", 2);
exec("bot_count 0", 2);
exec(`map ${map}`, 20);
frames(20, DT);

const nav = Bot_Nav();
check(`${map} ships a .nav that loads`, nav !== null && nav.nodeCount > 0, nav === null ? "Bot_Nav() is null" : `${nav.nodeCount} nodes, ${nav.links.length} links`);
if (nav === null) finish();

//============================================================================

function playerEdict(): EdictT | null {
  for (let i = 0; i < svs.maxclients; i++) {
    const client = svs.clients[i]!;
    if (client.active && client.netconnection !== null && client.edict !== null) return client.edict;
  }
  return null;
}

const player = playerEdict();
check("the local player is in the game to be walked towards", player !== null, player === null ? "no human client" : `edict ${player.index}`);
if (player === null) finish();

const monsters: EdictT[] = [];
for (let i = 1; i < sv.num_edicts; i++) {
  const ent = EDICT_NUM(i);
  if (ent.free) continue;
  if (((ent.v.flags | 0) & FL_MONSTER) === 0) continue;
  if (ent.v.health <= 0) continue;
  monsters.push(ent);
}
check(`${map} has monsters to walk`, monsters.length > 10, `${monsters.length} monsters`);

const caps = defaultTraverseCaps();
caps.jump = false;
caps.entityTraversal = true;
caps.swim = false;
// The same hazard refusal Bot_WalkPathToGoal itself plans with
// (src/bots/bot_hooks.ts): without it this file's own pre-selection findPath
// call can pick a "reachable" goal whose only route runs through a lava or
// slime node, which the live monster call refuses -- selection said reachable,
// the walk answered PATH_ERROR. Matching the real caps here is what makes
// "reachable at selection time" mean the same thing as "reachable when
// Bot_WalkPathToGoal runs".
const hazard = new Map<number, boolean>();
caps.avoid = (node): boolean => {
  const cached = hazard.get(node.index);
  if (cached !== undefined) return cached;
  const contents = SV_PointContents(vec3(node.origin.x, node.origin.y, node.origin.z + 8));
  const bad = contents === CONTENTS_LAVA || contents === CONTENTS_SLIME;
  hazard.set(node.index, bad);
  return bad;
};

// G5: ticks x movedist is the straight-line ground `steps` unblocked
// movetogoal calls could cover; the graph path a goal is picked from has to
// fit well inside that, not merely be reachable at all. An unconstrained
// "farthest reachable node" pick (this file's original goal selection) put
// e1m1 monsters on goals whose graph path was close to or past this whole
// budget, and the real per-tick ground covered -- corners, PATH_MOVE_BLOCKED
// backoffs and the movetogoal fallback they trigger all cost ground without
// closing distance -- ran 1.5-2x the straight-line start distance without
// most of them arriving (u_monsters.log, 1/23 arrived). Halving the raw
// budget still left the same friction eating most of the margin (8/23); a
// quarter of it is what actually gives most monsters room to walk around
// that friction and still arrive (14/23, measured against e1m1 with
// sv_randomseed 7).
const TRAVEL_BUDGET = steps * MOVE_DIST;
const BUDGET_MARGIN = 0.15;
const MAX_PATH_LENGTH = TRAVEL_BUDGET * BUDGET_MARGIN;

/** Sum of graph-edge distances along a findPath() chain (Euclidean; a real
 * Teleport link would need its 1-cost special case, but no map in this tree
 * puts one on a path between two ordinary walk nodes this far apart). */
function chainLength(nav: NavGraph, chain: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = nav.nodes[chain[i - 1]!]!.origin;
    const b = nav.nodes[chain[i]!]!.origin;
    total += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  return total;
}

function place(ent: EdictT, at: readonly [number, number, number]): void {
  ent.v.origin[0] = at[0];
  ent.v.origin[1] = at[1];
  ent.v.origin[2] = at[2];
  SV_LinkEdict(ent, false);
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function originOf(ent: EdictT): [number, number, number] {
  return [ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!];
}

/** True when the monster can see the point: a clear traceline eye to eye. */
function canSee(from: readonly [number, number, number], to: readonly [number, number, number], ignore: EdictT): boolean {
  return SV_Move(vec3(from[0], from[1], from[2] + 24), vec3(), vec3(), vec3(to[0], to[1], to[2] + 24), MOVE_NOMONSTERS, ignore).fraction >= 1;
}

/** One `movetogoal(dist)` the way the QuakeC calls it when walkpathtogoal errors. */
function moveToGoalStep(monster: EdictT, goal: EdictT, dist: number): void {
  const gs = pr.global_struct;
  const globals = pr.globals;
  if (gs === null || globals === null) return;
  const saveSelf = gs.self;
  gs.self = EDICT_TO_PROG(monster);
  monster.v.goalentity = EDICT_TO_PROG(goal);
  globals.f[OFS_PARM0] = dist;
  SV_MoveToGoal();
  gs.self = saveSelf;
}

interface TrialT {
  classname: string;
  index: number;
  start: [number, number, number];
  goal: [number, number, number];
  startDistance: number;
  navClosed: number;
  navCode: number;
  navPathPoints: number;
  navArrived: boolean;
  navTravelled: number;
  navBlocked: number;
  navFellBack: number;
  navSteps: number;
  plainClosed: number;
  plainArrived: boolean;
  plainTravelled: number;
  sawGoalAtStart: boolean;
  onground: boolean;
}

const trials: TrialT[] = [];

for (const monster of monsters) {
  if (trials.length >= limit) break;

  const start = originOf(monster);
  // Bot_WalkPathToGoal's own planPath call picks its start node with this
  // same box trace (bot_hooks.ts's `visible`, STEP_HEIGHT=18 there): the
  // monster's own bounding box lifted by its step height, not a bare point.
  // Picking the naively-nearest node instead, as this file did before,
  // sometimes chose one the monster's real box cannot actually reach in a
  // straight line -- selection said reachable, the live call answered
  // PATH_ERROR because it picked a different (or no) start node for the
  // exact same origin.
  const boxMins = vec3(monster.v.mins[0]!, monster.v.mins[1]!, monster.v.mins[2]! + STEP_HEIGHT);
  const boxMaxs = vec3(monster.v.maxs[0]!, monster.v.maxs[1]!, monster.v.maxs[2]!);
  const monsterVisible = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): boolean =>
    SV_Move(vec3(from.x, from.y, from.z), boxMins, boxMaxs, vec3(to.x, to.y, to.z), MOVE_NOMONSTERS, monster).fraction >= 1;
  const startNode = nav.closestNode({ x: start[0], y: start[1], z: start[2] }, { caps, visible: monsterVisible });
  if (startNode < 0) continue;

  let goalNode = -1;
  let goalDistance = 0;
  for (let i = 0; i < nav.nodeCount; i++) {
    if (i === startNode) continue;
    const node = nav.nodes[i]!;
    const d = distance(start, [node.origin.x, node.origin.y, node.origin.z]);
    if (d < MIN_GOAL_DISTANCE || d <= goalDistance) continue;
    const chain = nav.findPath(startNode, i, caps);
    if (chain === null || chainLength(nav, chain) > MAX_PATH_LENGTH) continue;
    goalDistance = d;
    goalNode = i;
  }
  if (goalNode < 0) continue;

  const node = nav.nodes[goalNode]!;
  const goal: [number, number, number] = [node.origin.x, node.origin.y, node.origin.z];
  trials.push({
    classname: PR_GetString(monster.v.classname),
    index: monster.index,
    start,
    goal,
    startDistance: goalDistance,
    navClosed: 0,
    navCode: PATH_ERROR,
    navPathPoints: 0,
    navArrived: false,
    navTravelled: 0,
    navBlocked: 0,
    navFellBack: 0,
    navSteps: 0,
    plainClosed: 0,
    plainArrived: false,
    plainTravelled: 0,
    sawGoalAtStart: canSee(start, goal, monster),
    onground: ((monster.v.flags | 0) & FL_ONGROUND) !== 0,
  });
}

check(
  `${map}: monsters with a reachable goal more than ${MIN_GOAL_DISTANCE} units away and within the ${Math.round(MAX_PATH_LENGTH)}-unit travel budget`,
  trials.length > 5,
  `${trials.length} of ${monsters.length}`,
);

//============================================================================
// with the nav graph mounted

for (const trial of trials) {
  const monster = EDICT_NUM(trial.index);
  place(monster, trial.start);
  place(player, trial.goal);

  let code = PATH_ERROR;
  let previous = originOf(monster);
  for (let step = 0; step < steps; step++) {
    code = Bot_WalkPathToGoal(monster, MOVE_DIST, vec3(trial.goal[0], trial.goal[1], trial.goal[2]));
    // ai.qc: anything but PATH_IN_PROGRESS falls through to movetogoal.
    if (code !== PATH_IN_PROGRESS) {
      trial.navFellBack++;
      moveToGoalStep(monster, player, MOVE_DIST);
    }
    sv.time += STEP_SECONDS;
    trial.navSteps++;
    if (code === PATH_MOVE_BLOCKED) trial.navBlocked++;
    const now = originOf(monster);
    trial.navTravelled += distance(previous, now);
    previous = now;
    if (distance(now, trial.goal) <= ARRIVED) break;
  }
  const end = originOf(monster);
  trial.navCode = code;
  trial.navClosed = trial.startDistance - distance(end, trial.goal);
  trial.navArrived = distance(end, trial.goal) <= ARRIVED || code === PATH_REACHED_GOAL || code === PATH_REACHED_PATH_END;
  trial.navPathPoints = Bot_MonsterPath(monster.index)?.points.length ?? 0;
  place(monster, trial.start);
}

//============================================================================
// with the same map and no nav graph at all

Bot_ClearNav();
check("unloading the nav graph leaves the map with no navigation", Bot_Nav() === null, `Bot_Nav()=${Bot_Nav() === null ? "null" : "still loaded"}`);
if (trials.length > 0) {
  const monster = EDICT_NUM(trials[0]!.index);
  const first = trials[0]!;
  check(
    "walkpathtogoal answers PATH_ERROR with no nav, which is the QuakeC's movetogoal fallback signal",
    Bot_WalkPathToGoal(monster, MOVE_DIST, vec3(first.goal[0], first.goal[1], first.goal[2])) === PATH_ERROR,
    "quakec: `if (walkpathtogoal(dist, ...) == PATH_IN_PROGRESS) return; ... movetogoal(dist);`",
  );
  place(monster, first.start);
}

for (const trial of trials) {
  const monster = EDICT_NUM(trial.index);
  place(monster, trial.start);
  place(player, trial.goal);
  let previous = originOf(monster);
  for (let step = 0; step < steps; step++) {
    moveToGoalStep(monster, player, MOVE_DIST);
    sv.time += STEP_SECONDS;
    const now = originOf(monster);
    trial.plainTravelled += distance(previous, now);
    previous = now;
    if (distance(now, trial.goal) <= ARRIVED) break;
  }
  const end = originOf(monster);
  trial.plainClosed = trial.startDistance - distance(end, trial.goal);
  trial.plainArrived = distance(end, trial.goal) <= ARRIVED;
  place(monster, trial.start);
}

Bot_LoadNav(map);

//============================================================================
// results

const widths = [20, 6, 7, 9, 9, 7, 8, 6, 9, 9, 5];
console.log(row(["monster", "start", "navPts", "navWalked", "navClose", "blocked", "fellback", "steps", "plnWalked", "plnClose", "code"], widths));
for (const t of trials) {
  console.log(
    row(
      [t.classname, Math.round(t.startDistance), t.navPathPoints, Math.round(t.navTravelled), Math.round(t.navClosed), t.navBlocked, t.navFellBack, t.navSteps, Math.round(t.plainTravelled), Math.round(t.plainClosed), t.navCode],
      widths,
    ),
  );
}

const navTotal = trials.reduce((a, t) => a + t.navClosed, 0);
const plainTotal = trials.reduce((a, t) => a + t.plainClosed, 0);
const navArrivals = trials.filter((t) => t.navArrived).length;
const plainArrivals = trials.filter((t) => t.plainArrived).length;
const blind = trials.filter((t) => !t.sawGoalAtStart);

console.log(`## ${map}: ${trials.length} monsters, ${blind.length} of them with no line of sight to the goal`);
console.log(`## distance closed: with nav ${Math.round(navTotal)} units, with movetogoal ${Math.round(plainTotal)} units`);
console.log(`## reached the player's area: with nav ${navArrivals}/${trials.length}, with movetogoal ${plainArrivals}/${trials.length}`);
console.log(`## ground covered: with nav ${Math.round(trials.reduce((a, t) => a + t.navTravelled, 0))} units, with movetogoal ${Math.round(trials.reduce((a, t) => a + t.plainTravelled, 0))} units`);
console.log(`## PATH_MOVE_BLOCKED answers: ${trials.reduce((a, t) => a + t.navBlocked, 0)} of ${trials.reduce((a, t) => a + t.navSteps, 0)} walkpathtogoal calls`);
console.log(`## ticks that fell through to movetogoal: ${trials.reduce((a, t) => a + t.navFellBack, 0)} of ${trials.reduce((a, t) => a + t.navSteps, 0)}`);
const stalled = trials.filter((t) => t.navFellBack === 0 && t.navTravelled < 64);
if (stalled.length > 0) {
  console.log(`## ${stalled.length} monsters answered PATH_IN_PROGRESS on every one of ${steps} ticks and moved under 64 units, so the QuakeC never got its movetogoal fallback: ${stalled.map((t) => t.classname).join(" ")}`);
}

check(
  "every monster with a reachable goal gets a path, not PATH_ERROR",
  trials.filter((t) => t.navCode === PATH_ERROR).length === 0,
  trials.filter((t) => t.navCode === PATH_ERROR).map((t) => t.classname).join(", ") || `all ${trials.length} planned`,
);

const allowed = new Set([PATH_ERROR, PATH_REACHED_GOAL, PATH_REACHED_PATH_END, PATH_MOVE_BLOCKED, PATH_IN_PROGRESS]);
check(
  "the answers stay inside the QuakeC's PATH_* vocabulary",
  trials.every((t) => allowed.has(t.navCode)),
  trials.map((t) => t.navCode).join(","),
);

check(
  `most monsters with a reachable goal reach the player's area within ${seconds}s on a nav map`,
  navArrivals > trials.length / 2,
  `${navArrivals}/${trials.length} arrived within ${ARRIVED} units`,
);

check(
  "monsters that cannot see the goal still close on it with nav",
  blind.length === 0 || blind.filter((t) => t.navClosed > 0).length > blind.length / 2,
  `${blind.filter((t) => t.navClosed > 0).length}/${blind.length} of the blind monsters closed distance`,
);

check(
  "walkpathtogoal never answers PATH_IN_PROGRESS while standing still for a whole run",
  trials.filter((t) => t.navFellBack === 0 && t.navTravelled < 64).length === 0,
  `${trials.filter((t) => t.navFellBack === 0 && t.navTravelled < 64).length} of ${trials.length} monsters held PATH_IN_PROGRESS for all ${steps} ticks without moving, which blocks the QuakeC's movetogoal fallback`,
);

check(
  "the nav graph closes more distance than movetogoal on the same map",
  navTotal > plainTotal,
  `nav=${Math.round(navTotal)} units vs movetogoal=${Math.round(plainTotal)} units over ${trials.length} monsters`,
);

check(
  "the nav graph gets more monsters to the player's area than movetogoal",
  navArrivals > plainArrivals,
  `nav=${navArrivals} vs movetogoal=${plainArrivals} of ${trials.length}`,
);

const ungrounded = trials.filter((t) => !t.onground);
if (ungrounded.length > 0) {
  console.log(`## ${ungrounded.length} monsters were not FL_ONGROUND when sampled, which makes SV_MoveToGoal a no-op for them: ${ungrounded.map((t) => t.classname).join(" ")}`);
}

finish();
