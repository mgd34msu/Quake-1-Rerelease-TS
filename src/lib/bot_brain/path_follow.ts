// The "move along a path" controller: turns a string-pulled point list into
// forward/side/jump for one frame, and notices when the bot has stopped
// making progress so the brain can re-plan.
//
// The controller steers in the bot's OWN frame, not the world's: it projects
// the direction to the next point onto the view's forward and right vectors
// and emits forwardmove/sidemove from that, so a bot that is looking at an
// enemy strafes around a corner instead of turning its back on the fight.
// `movement.walk_only` halves the speed to Quake's walk rate.

import { angleVectors, bvecDistance, bvecDistance2D, clamp, type BotVec3 } from "./math";
import type { BotMovementSettings } from "../botdata";
import { navLinkIsJump, NavLinkType, steerDirection, type NavGraphLinkT, type NavPathT } from "./nav_graph";
import { randomChance, type BotRandomT } from "./rng";

/**
 * Quake's own run and walk speeds; a usercmd is in units per second.
 *
 * `BotFollowInputT.runSpeed`/`walkSpeed` and `steerDirect`'s last two
 * arguments override these for a game whose move clamp differs (Quake II's
 * `sv_maxspeed` is 300, not 320), so a caller with no opinion behaves exactly
 * as the Quake 1 binding does.
 */
export const BOT_RUN_SPEED = 320;
export const BOT_WALK_SPEED = 160;

/** How close to a steering point counts as reaching it. */
export const BOT_POINT_REACHED = 32;
/** A jump takeoff or teleporter mouth has to be hit tighter than a walk point. */
export const BOT_TRAVERSAL_REACHED = 20;

export interface BotPathStateT {
  path: NavPathT | null;
  /** Index into `path.points` of the point being walked to. */
  index: number;
  /** Where the bot was when the stuck timer last reset. */
  stuckOrigin: BotVec3;
  /** Server time the stuck timer last reset. */
  stuckSince: number;
  /** How many times in a row this path has failed to make progress. */
  stuckCount: number;
  /** Server time the next jump is allowed (movement.jump_cooldown). */
  jumpReadyAt: number;
  /** Server time the path was planned, for re-plan pacing. */
  plannedAt: number;
}

export function newPathState(): BotPathStateT {
  return { path: null, index: 0, stuckOrigin: { x: 0, y: 0, z: 0 }, stuckSince: 0, stuckCount: 0, jumpReadyAt: 0, plannedAt: 0 };
}

export function setPath(state: BotPathStateT, path: NavPathT | null, origin: BotVec3, now: number): void {
  state.path = path;
  state.index = 0;
  state.stuckOrigin = { x: origin.x, y: origin.y, z: origin.z };
  state.stuckSince = now;
  state.stuckCount = 0;
  state.plannedAt = now;
}

export function clearPath(state: BotPathStateT): void {
  state.path = null;
  state.index = 0;
  state.stuckCount = 0;
}

export const BotPathStatus = {
  /** No path, or the path ran out of points. */
  NoPath: 0,
  /** Walking toward a point. */
  Moving: 1,
  /** The last point was reached. */
  Arrived: 2,
  /** No progress for long enough that the caller should re-plan. */
  Stuck: 3,
} as const;
export type BotPathStatusT = number;

export interface BotMoveOutputT {
  status: BotPathStatusT;
  forwardmove: number;
  sidemove: number;
  jump: boolean;
  /** The point currently being steered toward, for a caller that wants to look at it. */
  target: BotVec3 | null;
  /** The link being traversed to reach `target`, when there is one. */
  link: NavGraphLinkT | null;
}

export interface BotFollowInputT {
  origin: BotVec3;
  /** The view the movement is expressed relative to. */
  pitch: number;
  yaw: number;
  onGround: boolean;
  now: number;
  /** Seconds of no meaningful progress before the controller reports Stuck. */
  stuckTime: number;
  /** Units per second at a run; `BOT_RUN_SPEED` when the caller has no opinion. */
  runSpeed?: number;
  /** Units per second under `movement.walk_only`; `BOT_WALK_SPEED` by default. */
  walkSpeed?: number;
}

/**
 * One frame of path following.
 *
 * Stuck detection is a distance-over-time test rather than a velocity test,
 * because a bot pinned against a doorframe by another bot still has a
 * non-zero velocity every frame. If the bot has not moved 24 units from
 * where the timer started within `stuckTime` seconds, the timer trips; each
 * trip bumps `stuckCount`, which the brain uses to escalate (re-plan, then
 * pick a different goal).
 */
export function followPath(state: BotPathStateT, input: BotFollowInputT, movement: BotMovementSettings, rng: BotRandomT): BotMoveOutputT {
  const idle: BotMoveOutputT = { status: BotPathStatus.NoPath, forwardmove: 0, sidemove: 0, jump: false, target: null, link: null };

  const path = state.path;
  if (path === null || path.points.length === 0) return idle;

  // Retire every point already reached, so a bot that overshoots a corner
  // does not walk back to it.
  while (state.index < path.points.length) {
    const point = path.points[state.index]!;
    const link = path.links[state.index] ?? null;
    const tolerance = link !== null && link.type !== NavLinkType.Walk ? BOT_TRAVERSAL_REACHED : BOT_POINT_REACHED;
    // Height is checked loosely: a steering point sits at node height and
    // the bot's origin sits at its own, and a plat ride moves it a long way.
    if (bvecDistance2D(input.origin, point) <= tolerance && Math.abs(input.origin.z - point.z) <= 64) {
      state.index++;
      state.stuckOrigin = { x: input.origin.x, y: input.origin.y, z: input.origin.z };
      state.stuckSince = input.now;
      state.stuckCount = 0;
      continue;
    }
    break;
  }

  if (state.index >= path.points.length) {
    return { status: BotPathStatus.Arrived, forwardmove: 0, sidemove: 0, jump: false, target: null, link: null };
  }

  const target = path.points[state.index]!;
  const link = path.links[state.index] ?? null;

  // Progress check.
  if (bvecDistance(input.origin, state.stuckOrigin) > 24) {
    state.stuckOrigin = { x: input.origin.x, y: input.origin.y, z: input.origin.z };
    state.stuckSince = input.now;
  } else if (input.now - state.stuckSince >= input.stuckTime) {
    state.stuckCount++;
    state.stuckOrigin = { x: input.origin.x, y: input.origin.y, z: input.origin.z };
    state.stuckSince = input.now;
    return { status: BotPathStatus.Stuck, forwardmove: 0, sidemove: 0, jump: false, target, link };
  }

  const dir = steerDirection(input.origin, target);
  const speed = movement.walkOnly ? (input.walkSpeed ?? BOT_WALK_SPEED) : (input.runSpeed ?? BOT_RUN_SPEED);
  const { forward, right } = angleVectors(0, input.yaw, 0);

  const forwardmove = clamp((dir.x * forward.x + dir.y * forward.y) * speed, -speed, speed);
  const sidemove = clamp((dir.x * right.x + dir.y * right.y) * speed, -speed, speed);

  // Jump when the link says to, or when the next point is a step up the bot
  // cannot walk onto. A traversal link names its own takeoff point, and the
  // bot is standing on it by the time this runs.
  let jump = false;
  if (input.onGround) {
    const needsJump = link !== null && navLinkIsJump(link.type);
    const stepUp = target.z - input.origin.z > 24 && bvecDistance2D(input.origin, target) < 96;
    if (needsJump || stepUp) jump = true;
  }

  return { status: BotPathStatus.Moving, forwardmove, sidemove, jump, target, link };
}

/**
 * The combat jump: `movement.jump_chance` out of 100, no more often than
 * `movement.jump_cooldown` seconds apart, and only when
 * `movement.allow_jumping_in_combat` is on. Rolls through the injected RNG,
 * so a seeded bot jumps on exactly the same frames every replay.
 */
export function rollCombatJump(state: BotPathStateT, movement: BotMovementSettings, rng: BotRandomT, now: number, onGround: boolean): boolean {
  if (!movement.allowJumpingInCombat) return false;
  if (!onGround) return false;
  if (now < state.jumpReadyAt) return false;
  state.jumpReadyAt = now + movement.jumpCooldown;
  return randomChance(rng, movement.jumpChance);
}

/** Straight-line steering with no path at all, for a target the bot can see. */
export function steerDirect(origin: BotVec3, yaw: number, target: BotVec3, walkOnly: boolean, runSpeed = BOT_RUN_SPEED, walkSpeed = BOT_WALK_SPEED): { forwardmove: number; sidemove: number } {
  const dir = steerDirection(origin, target);
  const speed = walkOnly ? walkSpeed : runSpeed;
  const { forward, right } = angleVectors(0, yaw, 0);
  return {
    forwardmove: clamp((dir.x * forward.x + dir.y * forward.y) * speed, -speed, speed),
    sidemove: clamp((dir.x * right.x + dir.y * right.y) * speed, -speed, speed),
  };
}
