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

import { EDICT_TO_PROG, pr, type EdictT } from "../progs/progs";
import { SV_StepDirection } from "../server/sv_move";
import { FL_FLY, FL_SWIM, sv, svs } from "../server/server";
import { MOVE_NOMONSTERS, SV_Move, SV_PointContents } from "../server/world";
import { CONTENTS_LAVA, CONTENTS_SLIME } from "../common/bspfile";
import { anglemod, vec3, type Vec3 } from "../common/mathlib";
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
  /** Calls in a row that answered PATH_MOVE_BLOCKED on this plan. */
  blocked: number;
  /** Calls in a row spent turning onto the current segment. */
  turning: number;
  /** Server time until which the QuakeC's own movetogoal has the monster. */
  yieldUntil: number;
}

const monsterPaths = new Map<number, MonsterPathT>();

/** How far the goal may drift before the path is thrown away. */
const MONSTER_GOAL_DRIFT = 128;
/** How long a monster path survives before it is re-planned regardless. */
const MONSTER_REPLAN_SECONDS = 10;
/** Within this of a path point, move on to the next. */
const MONSTER_POINT_REACHED = 40;
/**
 * How many blocked calls in a row throw the plan away. SV_StepDirection can
 * refuse the same segment for as long as whatever is in the way stays there,
 * and a monster that keeps answering PATH_MOVE_BLOCKED off one stale plan
 * never gets a route round the obstruction.
 */
const MONSTER_BLOCKED_REPLAN = 4;
/** Under this much movement in one call the step did not happen. */
const MONSTER_MOVED_EPSILON = 0.5;
/**
 * SV_StepDirection undoes a step the monster has not turned far enough to
 * take, so a segment that needs a big turn costs `yaw_speed`-sized ticks
 * before any ground is covered. Those are progress, not a blockage -- but
 * only for as long as a monster turning at the stock 10-20 degrees a tick
 * would still be turning.
 */
const MONSTER_TURN_TICKS = 12;
/**
 * Yaw offsets tried around the straight line to the next path point, in
 * order. 45 is the widest that SV_StepDirection's "not turned far enough"
 * test still takes in one call.
 */
const STEP_FAN: readonly number[] = [0, 45, -45, 22.5, -22.5];
/** How many points past the current one may be steered toward directly. */
const MONSTER_LOOKAHEAD = 4;
/** How long a blocked segment leaves the monster to the QuakeC's movetogoal. */
const MONSTER_YIELD_SECONDS = 0.3;
/** sv_phys.c's STEPSIZE: how far up a walking monster may step in one move. */
const STEP_HEIGHT = 18;

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

    // String-pulling asks "could this monster walk straight from here to
    // there", so the trace is the monster's own box lifted by the step
    // height it can walk up -- a zero-width line clears door frames and
    // stair rails a 32-unit-wide grunt cannot, and every shortcut it takes
    // becomes a segment SV_movestep then refuses.
    const boxMins = vec3(self.v.mins[0]!, self.v.mins[1]!, self.v.mins[2]! + STEP_HEIGHT);
    const boxMaxs = vec3(self.v.maxs[0]!, self.v.maxs[1]!, self.v.maxs[2]!);
    const visible = (from: BotVec3, to: BotVec3): boolean =>
      SV_Move(vec3(from.x, from.y, from.z), boxMins, boxMaxs, vec3(to.x, to.y, to.z), MOVE_NOMONSTERS, self).fraction >= 1;

    const path = nav.planPath(origin, goal, { caps, visible });
    if (path === null || path.points.length === 0) {
      monsterPaths.delete(self.index);
      return PATH_ERROR; // "no nav nodes, no nearby nodes, no path"
    }
    // The blocked tally survives a re-plan on purpose: a monster that cannot
    // get moving must reach the give-up threshold, and re-planning is one of
    // the escalation steps rather than a reason to start counting again.
    cached = { path, index: 0, goal, plannedAt: sv.time, blocked: previous?.blocked ?? 0, turning: 0, yieldUntil: previous?.yieldUntil ?? 0 };
    monsterPaths.set(self.index, cached);
  }

  // Retire reached points. A point the monster is standing directly under or
  // over is retired too: walking cannot close a purely vertical gap, and
  // holding it as the steering point answers PATH_IN_PROGRESS with a zero
  // move vector for as long as the monster lives.
  while (cached.index < cached.path.points.length) {
    const point = cached.path.points[cached.index]!;
    const flat = bvecDistance2D(origin, point);
    if (flat <= MONSTER_POINT_REACHED && Math.abs(origin.z - point.z) <= 72) {
      cached.index++;
      continue;
    }
    if (flat <= MONSTER_MOVED_EPSILON) {
      cached.index++;
      continue;
    }
    break;
  }

  // And retire a point the monster has already walked past. A fresh plan
  // starts at the graph node nearest the monster, which is as often behind
  // it as in front, and walking back to it only to turn round again is the
  // whole of the "walked 4000 units and closed 0" case.
  while (cached.index + 1 < cached.path.points.length) {
    const here = cached.path.points[cached.index]!;
    const next = cached.path.points[cached.index + 1]!;
    const back = (here.x - origin.x) * (next.x - origin.x) + (here.y - origin.y) * (next.y - origin.y);
    if (back >= 0) break;
    cached.index++;
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

  // A blocked segment hands the monster to movetogoal for a short window
  // rather than for one tick: alternating between the two every tick has
  // each undo the other's step, and SV_MoveToGoal's own chase direction
  // needs a few ticks in a row to be worth anything.
  if (sv.time < cached.yieldUntil) return PATH_MOVE_BLOCKED;

  // SV_StepDirection turns the monster with PF_changeyaw, which reads the
  // `self` global rather than taking an entity: a caller that reaches this
  // builtin without `self` set to the monster turns some other entity and
  // leaves this one facing its spawn angle, where SV_StepDirection's own
  // "not turned far enough, so don't take the step" test undoes every step.
  const gs = pr.global_struct;
  const saveSelf = gs === null ? 0 : gs.self;
  const saveIdealYaw = self.v.ideal_yaw;
  const saveAngleYaw = self.v.angles[1]!;
  if (gs !== null) gs.self = EDICT_TO_PROG(self);

  // The straight line to the next path point, then a fan either side of it,
  // then the same for the point after that: a string-pulled segment is a
  // zero-width line and a monster is 32 units wide, so the door frame the
  // line clears is one SV_movestep refuses, and the point past it is often
  // reachable when the point itself is not. SV_NewChaseDir fans the same
  // way around its own straight line; this one stays biased toward the plan.
  let moved = 0;
  let turning = false;
  let reached = cached.index;
  // Never as far as the last point: that one IS the goal, and stepping onto
  // it is what PATH_REACHED_PATH_END means. Only the retire loop, which asks
  // where the monster actually is, may claim that.
  const last = Math.min(cached.index + MONSTER_LOOKAHEAD, cached.path.points.length - 2);
  for (let candidate = cached.index; candidate <= last && moved <= MONSTER_MOVED_EPSILON && !turning; candidate++) {
    const point = cached.path.points[candidate]!;
    const yaw = (Math.atan2(point.y - origin.y, point.x - origin.x) * 180) / Math.PI;
    for (const offset of STEP_FAN) {
      const before = toBotVec(self.v.origin);
      const wanted = anglemod(yaw + offset);
      const stepped = SV_StepDirection(self, wanted, movedist);
      moved = bvecDistance(before, toBotVec(self.v.origin));
      if (moved > MONSTER_MOVED_EPSILON) {
        reached = candidate;
        break;
      }
      // SV_StepDirection's own "not turned far enough, so don't take the
      // step": on the straight line to the next point that is the monster
      // turning onto the segment, which is progress and keeps its turn.
      const facing = anglemod(self.v.angles[1]! - wanted);
      if (candidate === cached.index && offset === 0 && stepped && facing > 45 && facing < 315) {
        turning = true;
        break;
      }
    }
  }
  if (gs !== null) gs.self = saveSelf;

  if (moved > MONSTER_MOVED_EPSILON) {
    cached.index = reached;
    cached.blocked = 0;
    cached.turning = 0;
    return PATH_IN_PROGRESS;
  }

  if (turning && cached.turning < MONSTER_TURN_TICKS) {
    cached.turning++;
    return PATH_IN_PROGRESS;
  }
  cached.turning = 0;

  // "something ( or someone ) is in our way". A step that was refused -- or
  // one SV_StepDirection took and then undid -- must not be reported as
  // progress, or ai.qc never gets its movetogoal fallback and the monster
  // stands still for the rest of the level. The facing this function was
  // handed goes back exactly as it was, because movetogoal steers off
  // `ideal_yaw` and reuses it for three ticks out of four: a blocked
  // walkpathtogoal that leaves its own dead-end direction behind makes the
  // fallback worse than no path at all. Every few of those the plan is
  // thrown away as well, so the route round the obstruction gets a chance.
  self.v.ideal_yaw = saveIdealYaw;
  self.v.angles[1] = saveAngleYaw;
  cached.blocked++;
  cached.yieldUntil = sv.time + MONSTER_YIELD_SECONDS;
  // A point the monster cannot step toward from here is one to give up on:
  // the next point along is a different direction, and the plan as a whole
  // is thrown away every few blocked calls anyway.
  if (cached.index + 1 < cached.path.points.length) cached.index++;
  if (cached.blocked % MONSTER_BLOCKED_REPLAN === 0) cached.plannedAt = Number.NEGATIVE_INFINITY;
  return PATH_MOVE_BLOCKED;
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
