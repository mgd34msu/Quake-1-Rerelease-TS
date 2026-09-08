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
/** A turn sharper than this at the next point is taken at walking pace once within CORNER_SLOW_DISTANCE of it. */
export const CORNER_TURN_DEGREES = 60;
export const CORNER_SLOW_DISTANCE = 96;
/** How close to an elevator link's start (the plat's resting top) counts as aboard. */
export const LIFT_BOARD_RADIUS = 48;
/** How long a bot stands on a lift that has not started to carry it before it stops waiting. */
export const LIFT_WAIT_SECONDS = 4;
/** How far past a walk-off-ledge landing point's shadow a grounded bot keeps walking to find the edge. */
export const LEDGE_OVERSHOOT = 128;
/** Below this much breath a swimming bot heads for the surface before anything else. */
export const SWIM_AIR_RESERVE = 5;
/** The share of its speed a short-of-breath swimmer puts into rising. */
export const SWIM_SURFACE_PUSH = 0.7;

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
  /** Server time the bot began waiting on a lift, and its height then; -1 when not waiting. */
  liftWaitSince: number;
  liftWaitZ: number;
  /** Server time the next jump is allowed (movement.jump_cooldown). */
  jumpReadyAt: number;
  /** Server time the path was planned, for re-plan pacing. */
  plannedAt: number;
}

export function newPathState(): BotPathStateT {
  return { path: null, index: 0, stuckOrigin: { x: 0, y: 0, z: 0 }, stuckSince: 0, stuckCount: 0, jumpReadyAt: 0, plannedAt: 0, liftWaitSince: -1, liftWaitZ: 0 };
}

export function setPath(state: BotPathStateT, path: NavPathT | null, origin: BotVec3, now: number): void {
  state.path = path;
  state.index = 0;
  // Skip the points the bot has already walked past. A fresh plan starts at
  // the graph node nearest the bot, which is as often behind it as in front,
  // and every stuck trip throws the old plan away and makes a new one -- so a
  // bot that trips near the far end of a path used to be sent back to the
  // beginning of it, walk forward again, trip again, and oscillate between
  // two points for the rest of the level.
  if (path !== null) {
    while (state.index + 1 < path.points.length) {
      const here = path.points[state.index]!;
      const next = path.points[state.index + 1]!;
      const back = (here.x - origin.x) * (next.x - origin.x) + (here.y - origin.y) * (next.y - origin.y);
      if (back >= 0) break;
      // Only a point at the bot's own level can be "behind" it. The bottom of
      // a flooded shaft sits directly under a bot floating at its top, which
      // the flat test above reads as already passed -- and the bot then swims
      // at the next tunnel node straight through the shaft wall.
      if (Math.abs(here.z - origin.z) > 64) break;
      state.index++;
    }
  }
  state.stuckOrigin = { x: origin.x, y: origin.y, z: origin.z };
  state.stuckSince = now;
  state.stuckCount = 0;
  state.plannedAt = now;
}

export function clearPath(state: BotPathStateT): void {
  state.path = null;
  state.index = 0;
  state.stuckCount = 0;
  state.liftWaitSince = -1;
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
  /** Vertical swim component, non-zero only while the bot is in deep enough water to swim. */
  upmove: number;
  jump: boolean;
  /** True while the bot is standing still on a lift waiting for the ride. */
  riding?: boolean;
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
  /** 0 dry, 1 feet wet, 2 waist deep, 3 submerged -- Quake's waterlevel. Swimming starts at 2. */
  waterLevel?: number;
  /** Breath left while submerged, in seconds, when known. */
  airSeconds?: number;
  /** True when there is air within reach straight above the bot's head (the caller's own contents test). */
  airAbove?: boolean;
  /** The bot's current velocity, when known: the steering then corrects for it instead of assuming the bot moves where it presses. */
  velocity?: BotVec3;
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
  const idle: BotMoveOutputT = { status: BotPathStatus.NoPath, forwardmove: 0, sidemove: 0, upmove: 0, jump: false, target: null, link: null };

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
    return { status: BotPathStatus.Arrived, forwardmove: 0, sidemove: 0, upmove: 0, jump: false, target: null, link: null };
  }

  let target = path.points[state.index]!;
  const link = path.links[state.index] ?? null;

  // A walk-off-ledge link names where the bot lands, not where it steps off.
  // On ctf4 the landing node sits under a grated bridge, straight below the
  // point the bot reaches on the bridge, so steering at the landing point
  // stopped it dead on the grate. While the bot is still on the ground well
  // above the landing point, it keeps walking past that point's shadow along
  // its approach direction until the floor ends and it drops.
  if (link !== null && link.type === NavLinkType.WalkOffLedge && input.onGround && input.origin.z - target.z > 64) {
    const prev = state.index > 0 ? path.points[state.index - 1]! : input.origin;
    let ax = target.x - prev.x, ay = target.y - prev.y;
    let al = Math.hypot(ax, ay);
    if (al < 1 && input.velocity !== undefined) {
      ax = input.velocity.x;
      ay = input.velocity.y;
      al = Math.hypot(ax, ay);
    }
    if (al >= 1) target = { x: target.x + (ax / al) * LEDGE_OVERSHOOT, y: target.y + (ay / al) * LEDGE_OVERSHOOT, z: target.z };
  }

  // Riding a lift: the elevator link's start is the plat's resting top and
  // its end the landing far above (ctf4's flag platforms sit 360 units over
  // their lifts). Standing on the plat is what raises it, so once the bot
  // has reached the start it stands still until the ride has brought it near
  // the end's height; pressing toward the end walked it off the plat's edge
  // into the shaft wall, where the rising plat then jammed on its own rider.
  // (The traversal's end point is pushed with a null link, so the link that
  // led to it is the one to look at once the start has been retired.)
  const prevLink = state.index > 0 ? (path.links[state.index - 1] ?? null) : null;
  const lift = link !== null && link.type === NavLinkType.Elevator ? link : prevLink !== null && prevLink.type === NavLinkType.Elevator ? prevLink : null;
  if (lift !== null && lift.traversal !== null && input.onGround) {
    const ride = lift.traversal;
    const belowEnd = ride.end.z - input.origin.z > 64;
    if (belowEnd && bvecDistance2D(input.origin, ride.start) <= LIFT_BOARD_RADIUS) {
      // A plat that never comes (someone is camping on it at the top) is
      // not worth more than LIFT_WAIT_SECONDS: after that the wait ends and
      // the ordinary stuck handling replans or gives the goal up.
      if (state.liftWaitSince < 0 || Math.abs(input.origin.z - state.liftWaitZ) > 8) {
        state.liftWaitSince = input.now;
        state.liftWaitZ = input.origin.z;
      }
      if (input.now - state.liftWaitSince <= LIFT_WAIT_SECONDS) {
        state.stuckOrigin = { x: input.origin.x, y: input.origin.y, z: input.origin.z };
        state.stuckSince = input.now;
        return { status: BotPathStatus.Moving, forwardmove: 0, sidemove: 0, upmove: 0, jump: false, riding: true, target, link };
      }
    } else {
      state.liftWaitSince = -1;
    }
  } else {
    state.liftWaitSince = -1;
  }

  // Progress check.
  if (bvecDistance(input.origin, state.stuckOrigin) > 24) {
    state.stuckOrigin = { x: input.origin.x, y: input.origin.y, z: input.origin.z };
    state.stuckSince = input.now;
  } else if (input.now - state.stuckSince >= input.stuckTime) {
    state.stuckCount++;
    state.stuckOrigin = { x: input.origin.x, y: input.origin.y, z: input.origin.z };
    state.stuckSince = input.now;
    return { status: BotPathStatus.Stuck, forwardmove: 0, sidemove: 0, upmove: 0, jump: false, target, link };
  }

  const speed = movement.walkOnly ? (input.walkSpeed ?? BOT_WALK_SPEED) : (input.runSpeed ?? BOT_RUN_SPEED);
  const { forward, right } = angleVectors(0, input.yaw, 0);

  // On land the steering direction is flat: the ground carries the bot up and
  // down steps and slopes. Swimming, the direction is the full 3-D vector to
  // the point, and its vertical part goes out as upmove -- Quake's water move
  // (SV_WaterMove) adds upmove straight onto the wish velocity, which is the
  // only way a bot ever dives down a flooded shaft or surfaces from one. Yaw
  // alone can never do it, and the bot's pitch belongs to its aim.
  const swimming = (input.waterLevel ?? 0) >= 2;
  let dir: BotVec3;
  let upmove = 0;
  if (swimming) {
    const dx = target.x - input.origin.x;
    const dy = target.y - input.origin.y;
    const dz = target.z - input.origin.z;
    const len = Math.hypot(dx, dy, dz);
    dir = len > 0 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 0 };
    upmove = clamp(dir.z * speed, -speed, speed);
    // Short of breath, swim for the surface first: a flooded passage longer
    // than one lungful (ctf1's tunnel is 5700 units of it) drowns a bot that
    // hugs the nav nodes along its floor. Pressing up in a sealed tunnel
    // costs nothing; wherever the passage opens the bot comes up for air.
    // Only where a surface exists: in a sealed tunnel the push pinned a
    // carrier against the ceiling short of a low arch it had to dive under
    // (ctf1's tunnel at x -1080), and it drowned there pressing upward.
    if (input.airSeconds !== undefined && input.airSeconds < SWIM_AIR_RESERVE && input.airAbove === true && dir.z > -0.5) {
      upmove = Math.max(upmove, SWIM_SURFACE_PUSH * speed);
    }
  } else {
    dir = steerDirection(input.origin, target);
  }

  // Slow for a sharp corner. A player at full run slides sixty-odd units
  // through a right-angle turn before friction and acceleration bring the
  // velocity round, and on ctf1 the flag room's door has a pit that far past
  // the corner node: every carrier that ran the corner fell in.
  let wishSpeed = speed;
  const next = path.points[state.index + 1];
  if (next !== undefined && bvecDistance2D(input.origin, target) < CORNER_SLOW_DISTANCE) {
    const ax = target.x - input.origin.x, ay = target.y - input.origin.y;
    const bx = next.x - target.x, by = next.y - target.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 1 && lb > 1) {
      const cos = (ax * bx + ay * by) / (la * lb);
      if (cos < Math.cos((CORNER_TURN_DEGREES * Math.PI) / 180)) wishSpeed = Math.min(wishSpeed, input.walkSpeed ?? BOT_WALK_SPEED);
    }
  }

  // Cancel the sideways slide the bot already has: the part of its velocity
  // across the direction to the point is pressed against, so a bot rounding
  // a corner at speed tracks the route instead of the engine's acceleration
  // deciding where it goes. Only the lateral part -- braking along the
  // route made a slow bot reverse and dither between close points.
  let wx = dir.x * wishSpeed, wy = dir.y * wishSpeed;
  if (input.velocity !== undefined) {
    const along = input.velocity.x * dir.x + input.velocity.y * dir.y;
    const lateralX = input.velocity.x - along * dir.x;
    const lateralY = input.velocity.y - along * dir.y;
    wx -= lateralX;
    wy -= lateralY;
    const wl = Math.hypot(wx, wy);
    if (wl > speed) {
      wx *= speed / wl;
      wy *= speed / wl;
    }
  }

  const forwardmove = clamp(wx * forward.x + wy * forward.y, -speed, speed);
  const sidemove = clamp(wx * right.x + wy * right.y, -speed, speed);

  // Jump when the link says to, or when the next point is a step up the bot
  // cannot walk onto. A traversal link names its own takeoff point, and the
  // bot is standing on it by the time this runs.
  let jump = false;
  if (input.onGround) {
    const needsJump = link !== null && navLinkIsJump(link.type);
    const stepUp = target.z - input.origin.z > 24 && bvecDistance2D(input.origin, target) < 96;
    if (needsJump || stepUp) jump = true;
  }

  return { status: BotPathStatus.Moving, forwardmove, sidemove, upmove, jump, target, link };
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
