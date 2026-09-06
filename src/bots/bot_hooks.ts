/*
The three re-release navigation builtins, answered for real.

`bot_movetopoint(entity bot, vector point)` and `bot_followentity(entity bot,
entity goal)` set a bot's goal and report a BOT_GOAL_* code. Neither is
called by any shipped progs (they are declared in every tree's defs.qc and
called from none), but they are the documented way a mod drives a bot from
`Bot_PreThink`, so they behave the way the constants describe: the first call
starts the goal and answers IN_PROGRESS, later calls answer IN_PROGRESS until
the bot arrives (SUCCESS) or the goal becomes unreachable (ERROR).

`walkpathtogoal(float movedist, vector goal)` is the monster one, and `self`
is the monster, not a bot. It replaces the eight-direction shuffle of
SV_MoveToGoal with a real path: A* over the map's nav graph, then one
SV_StepDirection along the current segment. Its PATH_* answers are the
QuakeC's own contract (quakec/defs.qc:452-456), and PATH_ERROR is the signal
the QuakeC uses to fall back:

    if ( walkpathtogoal( dist, self.enemy.origin ) == PATH_IN_PROGRESS )
        return;
    ...
    movetogoal( dist ); // fall back to normal Quake movement behavior.

A NOTE ON WHERE THIS IS REACHED FROM. The shipped id1 progs does contain
`ai_pathtogoal` with three `walkpathtogoal` call sites, but `ai_run` guards
the only call to it with `#ifdef USE_ADVANCED_PATHING`, and that symbol is
defined nowhere in any of the six quakec trees -- so under id1, ctf, hipnotic
and rogue the builtin is compiled-out dead code and monsters keep using
`movetogoal`. mg1 and mg3 replaced that `#ifdef` with a runtime test on their
own `isHordeMode` flag, so under those two progs this is live code whenever
Horde is running. The implementation below is written for both, and is
exercised directly by test/bots.test.ts rather than through a progs that
cannot reach it.
*/

import type { EdictT } from "../progs/progs";
import { SV_StepDirection } from "../server/sv_move";
import { FL_FLY, FL_SWIM, sv, svs } from "../server/server";
import { MOVE_NOMONSTERS, SV_Move, SV_PointContents } from "../server/world";
import { CONTENTS_LAVA, CONTENTS_SLIME } from "../common/bspfile";
import { vec3, type Vec3 } from "../common/mathlib";
import {
  BOT_GOAL_ERROR,
  BOT_GOAL_IN_PROGRESS,
  BOT_GOAL_SUCCESS,
  PATH_ERROR,
  PATH_IN_PROGRESS,
  PATH_MOVE_BLOCKED,
  PATH_REACHED_GOAL,
  PATH_REACHED_PATH_END,
  qexBotHooks,
  qexNavHooks,
} from "../progs/ext/qex_hooks";
import { bvecDistance, bvecDistance2D, type BotVec3 } from "../lib/bot_brain/math";
import { defaultTraverseCaps, type NavPathT } from "../lib/bot_brain/nav_graph";
import { Bot_Nav } from "./bot_data";
import { Bot_Slots } from "./bot_client";
import { toBotVec } from "./bot_world";

//============================================================================
// bot_movetopoint / bot_followentity

function slotForEdict(ent: EdictT) {
  const clientnum = ent.index - 1;
  if (clientnum < 0 || clientnum >= svs.maxclients) return undefined;
  return Bot_Slots().get(clientnum);
}

function botMoveToPoint(bot: EdictT, point: Vec3): number {
  const slot = slotForEdict(bot);
  if (slot === undefined) return BOT_GOAL_ERROR;
  slot.brain.requestMoveToPoint(toBotVec(point));
  const status = slot.brain.goalStatus();
  return status === 0 ? BOT_GOAL_ERROR : status === 1 ? BOT_GOAL_SUCCESS : BOT_GOAL_IN_PROGRESS;
}

function botFollowEntity(bot: EdictT, goal: EdictT): number {
  const slot = slotForEdict(bot);
  if (slot === undefined) return BOT_GOAL_ERROR;
  if (goal.free || goal.index === 0) return BOT_GOAL_ERROR;
  slot.brain.requestFollowEntity(goal.index, toBotVec(goal.v.origin));
  const status = slot.brain.goalStatus();
  return status === 0 ? BOT_GOAL_ERROR : status === 1 ? BOT_GOAL_SUCCESS : BOT_GOAL_IN_PROGRESS;
}

//============================================================================
// walkpathtogoal

interface MonsterPathT {
  path: NavPathT;
  index: number;
  goal: BotVec3;
  plannedAt: number;
}

const monsterPaths = new Map<number, MonsterPathT>();

/** How far the goal may drift before the path is thrown away. */
const MONSTER_GOAL_DRIFT = 128;
/** How long a monster path survives before it is re-planned regardless. */
const MONSTER_REPLAN_SECONDS = 3;
/** Within this of a path point, move on to the next. */
const MONSTER_POINT_REACHED = 40;

export function Bot_ClearMonsterPaths(): void {
  monsterPaths.clear();
}

/** The cached path for one monster, for tests. */
export function Bot_MonsterPath(edictIndex: number): NavPathT | null {
  return monsterPaths.get(edictIndex)?.path ?? null;
}

function walkPathToGoal(self: EdictT, movedist: number, goalVec: Vec3): number {
  const nav = Bot_Nav();
  if (nav === null || nav.nodeCount === 0) return PATH_ERROR;
  if (movedist <= 0) return PATH_ERROR;

  const origin = toBotVec(self.v.origin);
  const goal = toBotVec(goalVec);

  // Already there: the QuakeC's own "reached whatever we were trying to get
  // to". movedist is the step the monster was about to take, so anything
  // inside it is arrival.
  if (bvecDistance(origin, goal) <= Math.max(movedist, 32)) {
    monsterPaths.delete(self.index);
    return PATH_REACHED_GOAL;
  }

  const previous = monsterPaths.get(self.index);
  const stale =
    previous === undefined ||
    sv.time - previous.plannedAt > MONSTER_REPLAN_SECONDS ||
    bvecDistance(previous.goal, goal) > MONSTER_GOAL_DRIFT ||
    previous.index >= previous.path.points.length;

  let cached: MonsterPathT;
  if (!stale && previous !== undefined) {
    cached = previous;
  } else {
    const flags = self.v.flags | 0;
    const caps = defaultTraverseCaps();
    // A Quake monster cannot jump a gap (a fiend's leap is a scripted attack,
    // not locomotion), but it does walk through doors and ride plats -- the
    // stock QuakeC's own ai_run does exactly that -- so entity traversals
    // stay on. Only a flyer or a swimmer may be routed through water.
    caps.jump = false;
    caps.entityTraversal = true;
    caps.swim = (flags & (FL_SWIM | FL_FLY)) !== 0;
    // Same hazard refusal the bots use: a nav node standing in lava is not a
    // node anything that can be hurt should be routed through.
    const hazard = new Map<number, boolean>();
    caps.avoid = (node): boolean => {
      const cached = hazard.get(node.index);
      if (cached !== undefined) return cached;
      const contents = SV_PointContents(vec3(node.origin.x, node.origin.y, node.origin.z + 8));
      const bad = contents === CONTENTS_LAVA || contents === CONTENTS_SLIME;
      hazard.set(node.index, bad);
      return bad;
    };

    const visible = (from: BotVec3, to: BotVec3): boolean =>
      SV_Move(vec3(from.x, from.y, from.z + 16), vec3(), vec3(), vec3(to.x, to.y, to.z + 16), MOVE_NOMONSTERS, self).fraction >= 1;

    const path = nav.planPath(origin, goal, { caps, visible });
    if (path === null || path.points.length === 0) {
      monsterPaths.delete(self.index);
      return PATH_ERROR; // "no nav nodes, no nearby nodes, no path"
    }
    cached = { path, index: 0, goal, plannedAt: sv.time };
    monsterPaths.set(self.index, cached);
  }

  // Retire reached points.
  while (cached.index < cached.path.points.length) {
    const point = cached.path.points[cached.index]!;
    if (bvecDistance2D(origin, point) <= MONSTER_POINT_REACHED && Math.abs(origin.z - point.z) <= 72) {
      cached.index++;
      continue;
    }
    break;
  }

  if (cached.index >= cached.path.points.length) {
    monsterPaths.delete(self.index);
    return PATH_REACHED_PATH_END; // "can now move directly to target"
  }

  // The last point IS the goal (stringPull always appends it), so standing
  // on the second-to-last point means the rest is a straight walk and the
  // QuakeC should take over with its own movetogoal.
  if (cached.index === cached.path.points.length - 1) {
    monsterPaths.delete(self.index);
    return PATH_REACHED_PATH_END;
  }

  const target = cached.path.points[cached.index]!;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  if (dx === 0 && dy === 0) return PATH_IN_PROGRESS;

  const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (!SV_StepDirection(self, yaw, movedist)) return PATH_MOVE_BLOCKED; // "something ( or someone ) is in our way"

  return PATH_IN_PROGRESS;
}

//============================================================================

/** Fills src/progs/ext/qex_hooks.ts's three hook slots. Called once, from src/bots/index.ts. */
export function Bot_RegisterHooks(): void {
  qexBotHooks.movetopoint = botMoveToPoint;
  qexBotHooks.followentity = botFollowEntity;
  qexNavHooks.walkpathtogoal = walkPathToGoal;
}

/** Unregisters them again; tests use this to restore the pre-bots behaviour. */
export function Bot_UnregisterHooks(): void {
  qexBotHooks.movetopoint = null;
  qexBotHooks.followentity = null;
  qexNavHooks.walkpathtogoal = null;
}

/** Exposed for tests that drive the monster pathing without going through the VM. */
export function Bot_WalkPathToGoal(self: EdictT, movedist: number, goal: Vec3): number {
  return walkPathToGoal(self, movedist, goal);
}

/** Exposed for tests that drive the two bot goal builtins without going through the VM. */
export const Bot_GoalBuiltins = { moveToPoint: botMoveToPoint, followEntity: botFollowEntity };
