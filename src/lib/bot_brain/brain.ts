// The bot brain proper: one instance per bot, one `think()` per server
// frame, one usercmd out.
//
// Everything it knows about the world arrives through `BotWorldT`
// (world.ts); everything it knows about how to behave arrives through
// `BotKnowledge` (knowledge.ts, the shipped bots/*.txt files) and the
// per-skill `settings_*.txt` block. Nothing in this file imports from
// src/ outside src/lib, so a second game binds it by implementing
// `BotWorldT` and nothing else.
//
// One frame, in order:
//
//   1. read self, and decay every awareness record with senses.ts
//   2. pick a target, if behaviors.allow_combat and the bot is aware of one
//   3. pick a goal -- the caller's explicit goal first (the QuakeC's
//      bot_movetopoint / bot_followentity), then the target, then the best
//      item behaviors.allow_grab_items lets it want, then a roam
//   4. plan or re-plan a nav path to that goal when the straight line is
//      not good enough
//   5. run the path controller for forward/side/jump
//   6. run the aim tracker toward the target, or toward where the bot is
//      walking when there is no target
//   7. choose a weapon by weapons.txt's own rule and fire when the weapon
//      cone has settled
//
// A GOAL THE NAV GRAPH CANNOT REACH. Picking the nearest valuable item and
// then failing to plan a path to it used to wedge the bot permanently: with
// no path, movement fell into the straight-line steering branch below --
// which has no stuck detection -- and the bot walked into the wall between
// it and the item for the rest of the match, re-picking the same item every
// frame. `unreachableUntil` remembers a goal entity the planner could not
// reach and stops choosing it for a while.
//
// THE "GIVE UP AFTER STUCK_GIVE_UP TRIPS" ESCALATION. This used to count
// trips on `pathState.stuckCount`, which both `clearPath` and `setPath`
// zero -- and the stuck branch below calls `clearPath` on every trip short
// of giving up, so the tally could never reach `STUCK_GIVE_UP` and a bot
// walled off from a reachable goal re-planned the same blocked route
// forever. The tally now lives on the brain itself, as `stuckTrips`.
//
// THE UNSTICK WINDOW. A bot that walked dead-on into a wall has no
// tangential velocity to slide along it with, so it presses forwardmove at
// full speed and does not move a unit -- and re-planning produces the same
// route into the same wall. Every stuck trip opens a short sidestep-and-hop
// window (`unstickUntil`/`unstickSide`) to break contact with the wall.
//
// THE WEDGE TIMER. The unstick window above is opened by the path follower,
// which only watches a path -- and forgives itself every time a point is
// retired or a plan is replaced. A bot bouncing between two points, or one
// steering straight at a goal with no path at all, therefore never tripped it
// and leaned on the same wall for the rest of the level. `wedgeOrigin` is a
// second, plainer test that belongs to the brain: displacement over time,
// whatever the path state is. An oscillation is as stuck as a standstill.
// It is held off while the bot has a target, because a bot circling one has
// small net displacement by design -- see `updateWedge`.
//
// OBJECTIVES. In a game with team-owned `objective` items (Quake 1's CTF
// flags), the enemy's is a goal, a team's own is one only when it has been
// dropped, and a bot carrying one runs it home to where its own objective
// spawned -- which has to be REMEMBERED, because a carried flag stops being
// an entity the world reports at all. Bots split into attackers and
// defenders at the level's start.
//
// COOP. A bot that wanders off never meets the monsters the human is
// fighting, and one pinned to them never clears anything: so it hunts what is
// still standing near the human, and regroups with them on a clock. What it
// may SHOOT is still gated by senses.ts; the hunt only decides where it walks.
//
// Determinism: every random decision goes through the injected
// `BotRandomT`. Two brains with the same seed, fed the same worlds, emit
// the same usercmds.

import type { BotSkillSettings, CharacterEntry } from "../botdata";
import { aimError, aimLeadPoint, aimStep, newAimState, type BotAimStateT } from "./aim";
import { angleBetween, angleMod, angleVectors, bvec, bvecAdd, bvecDistance, bvecSub, type BotVec3 } from "./math";
import { BotGameType, INTERACTION, ITEM_FLAG, chooseWeapon, itemValue, type BotGameModeT, type BotKnowledge, type BotWeaponT } from "./knowledge";
import { PLAN_START_ABOVE, defaultTraverseCaps, type NavPathT, type NavTraverseCapsT, NavLinkType } from "./nav_graph";
import { BOT_RUN_SPEED, BOT_WALK_SPEED, BotPathStatus, clearPath, followPath, newPathState, rollCombatJump, setPath, steerDirect, type BotPathStateT } from "./path_follow";
import { canFire, evaluateSightGeometry, isAware, newAwareness, senseStep, shouldForget, soundAudible, type BotAwarenessT, type BotContactT } from "./senses";
import { randomChance, randomIndex, randomRange, type BotRandomT } from "./rng";
import {
  BOT_BUTTON_ATTACK,
  BOT_BUTTON_JUMP,
  BOT_BUTTON_USE,
  BotContents,
  BotEntityKind,
  emptyUsercmd,
  type BotEntityT,
  type BotUsercmdT,
  type BotWorldT,
  type BotContentsT,
} from "./world";

//============================================================================

/** What the QuakeC's BOT_GOAL_* codes mean, in the brain's own vocabulary. */
export const BotGoalStatus = {
  Error: 0,
  Success: 1,
  InProgress: 2,
} as const;
export type BotGoalStatusT = number;

/** One chat line the brain wants said, resolved by the binding. */
export interface BotChatEventT {
  /** chats.txt's `locstring` -- a `$key` the game's own localization resolves. */
  locstring: string;
  /** chats.txt's `type`. */
  type: string;
  /** chats.txt's `time`, in milliseconds: how long to wait before saying it. */
  delayMs: number;
  /** chats.txt's `team`: true when only teammates should see it. */
  teamOnly: boolean;
}

export interface BotBrainConfigT {
  knowledge: BotKnowledge;
  /** A skill name from settings_*.txt: practice, easy, medium, hard, expert, nightmare. */
  skill: string;
  rng: BotRandomT;
  gameMode: BotGameModeT;
  /** characters.txt entry, for the name and colours the binding applies. */
  character?: CharacterEntry;
  /** The game's own max health, for scoring health pickups. */
  maxHealth?: number;
  /** Chat lines the brain decided to say. */
  onChat?: (event: BotChatEventT) => void;
  /** Turns a weapons.txt `number` into the impulse that selects it. Quake 1's mapping lives in src/bots. */
  weaponImpulse?: (weaponNumber: number) => number;
  /**
   * An alternative to `weaponImpulse` for a game with no impulse-driven
   * selection at all (Quake II's game module takes a direct weapon-select
   * call instead). `weaponImpulse` wins when both are present, so the
   * Quake 1 binding is untouched.
   */
  onWeaponSelect?: (weaponNumber: number) => void;
  /** Units per second at a run. Defaults to path_follow.ts's `BOT_RUN_SPEED`. */
  runSpeed?: number;
  /** Units per second under `movement.walk_only`. Defaults to `BOT_WALK_SPEED`. */
  walkSpeed?: number;
  /** True when a human teammate is nearby, for behaviors.defer_power_items_to_humans. */
  humanTeammateNear?: () => boolean;
}

/** The goal the caller set explicitly, through the QuakeC's bot builtins. */
interface ExplicitGoalT {
  kind: "point" | "entity";
  point: BotVec3;
  entityId: number;
}

//============================================================================

const STUCK_SECONDS = 0.6;
const REPLAN_SECONDS = 2.0;
/** Give up on a goal after this many consecutive stuck trips. */
const STUCK_GIVE_UP = 3;
/** How far a roaming bot is willing to be sent. */
const ROAM_RADIUS = 4096;
/** How far ahead of the bot the floor is checked for lava before a step is taken, plus the stopping distance at its speed. */
const EDGE_LOOKAHEAD = 32;
/**
 * Seconds of travel added to the look-ahead. Ground friction (sv_friction 4)
 * stops a 320 u/s run in about 0.25 s over some 40 u; 0.3 s looked 144 u
 * ahead, past every bend of ctf6's lava walkways, and carriers stood at the
 * rim for 30 s (P17 arrival regression).
 */
const EDGE_STOP_SECONDS = 0.15;
/** Spacing of the floor probes between the bot and the look-ahead point. */
const EDGE_PROBE_STEP = 16;
/**
 * How far below a probe point the floor is looked for. 160 u let every ledge
 * higher than that over lava pass as "too deep to see the bottom of": on
 * ctf8 seven of eighteen lava deaths were bots walking or running off the
 * upper level (z 216-280) into pools 250 u below. A fall onto ground is a
 * few points of damage at worst; a fall into lava is death at any depth.
 */
const EDGE_DROP_CHECK = 1024;
/** Seconds a jump keeps a bot in the air at run speed (270 u/s up under 800 u/s^2 gravity lands in ~0.7 s). */
const JUMP_AIR_SECONDS = 0.7;
/** The engine's jump: velocity_z 270 under sv_gravity 800 (client.qc PlayerJump). */
const JUMP_VELOCITY = 270;
const GRAVITY = 800;
/** How far past a hazard's start a landing is looked for. */
const GAP_LANDING_SEARCH = 320;
/** How much higher than the bot's floor a landing may be (a jump clears 45 u; keep a margin). */
const GAP_LANDING_RISE = 40;
/** A jump is pressed once the hazard's start is this close (about 6 frames at a run). */
const GAP_JUMP_TRIGGER = 32;
/** Fraction of the computed jump reach the landing must fit in: speed and take-off timing are not exact. */
const GAP_REACH_MARGIN = 0.85;
/**
 * Whether what lies under a point is lava or slime: a line is traced down
 * EDGE_DROP_CHECK units to the first solid thing -- world OR a brush entity,
 * so a lift, a bridge plate or a door over a pit is floor (point contents
 * see the world only, and a 24-unit point scan skipped plates thinner than
 * that: bots on ctf6's lowest floor and on lifts over lava refused every
 * step) -- and the contents just above where it stopped decide. Nothing
 * within reach means a drop too deep to see the bottom of; only lava at
 * the end of it counts.
 */
function hazardBelow(world: BotWorldT, x: number, y: number, z: number): boolean {
  const trace = world.traceLine({ x, y, z }, { x, y, z: z - EDGE_DROP_CHECK });
  const c = world.pointContents({ x, y, z: trace.endpos.z + 2 });
  return c === BotContents.Lava || c === BotContents.Slime;
}

/** Directions sampled for a way out when the bot is already in lava and has no safe ground remembered. */
const LAVA_EXIT_SAMPLES = 12;
const LAVA_EXIT_REACH = 96;
/** How long a static point the bot has reached is left alone before it is worth walking to again. */
const POINT_REST_SECONDS = 8;
/** How close an escort keeps to the teammate carrying the objective. */
const ESCORT_DISTANCE = 160;
/**
 * How long a goal the nav graph could not reach is left alone. Long enough
 * that the bot stops thrashing against it, short enough that a door or plat
 * opening a route later puts it back in play.
 */
const UNREACHABLE_SECONDS = 20;
/**
 * The same, for a goal that is alive. A pickup that could not be reached sits
 * exactly where it was and will still be unreachable in a second's time; a
 * monster walks about, wakes up, opens the door it is standing behind, and is
 * worth another try soon.
 */
const UNREACHABLE_LIVE_SECONDS = 4;
/** How long the sidestep-and-hop that breaks a wall contact runs for. */
const UNSTICK_SECONDS = 0.5;
/**
 * A route the bot cannot walk is very often a route something has to be
 * opened for. interactables.txt names the entities worth touching and how
 * each one is worked, and a bot that never goes to one of them cannot finish
 * a level that gates its only exit behind a button. e1m1 is such a level: the
 * floor of the walkway out of the start yard is a func_door and the button
 * that lowers it is on the wall at the west end. Bots that "played" that map
 * before did it by walking into that button by accident while sidestepping
 * out of a wall, which is why the same match came out differently at
 * different server seeds.
 *
 * The search is opened by giving up on a goal as unreachable and it runs for
 * INTERACT_SECONDS; it is not a standing errand, so a bot with a route does
 * not go and press things instead of playing.
 */
const INTERACT_RADIUS = 1024;
const INTERACT_SECONDS = 8;
/**
 * How close counts as having touched the thing. A button is pushed by walking
 * into it, and a bot walking into one never reaches the middle of its
 * bounding box -- that is a few units inside the brush -- so an errand that
 * waited for an arrival would never end, and the bot would lean on the button
 * it had already pushed until the clock ran out.
 */
const INTERACT_REACHED = 40;
/**
 * How long a bot may press a move without getting anywhere before the unstick
 * window is opened regardless of what the path follower thinks. The follower
 * only watches a path, and it forgives itself every time a point is retired
 * or a plan is replaced -- so a bot bouncing between two points, or steering
 * straight at a goal with no path at all, never trips it and leans on the
 * same wall for the rest of the level. This is displacement over time, not a
 * per-frame step: an oscillation is as stuck as a standstill.
 */
const WEDGED_SECONDS = 1.2;
/** And how long before the goal itself is given up as unreachable. */
const WEDGED_GIVE_UP_SECONDS = 2.5;
/** Getting this far from where the timer started counts as going somewhere. */
const WEDGED_DISPLACEMENT = 96;
/** How far a roaming bot is sent when the map has no navigation to roam over. */
const BLIND_ROAM_RADIUS = 640;
/** And how long it walks at one blind roam point before picking another. */
const BLIND_ROAM_SECONDS = 4;
/**
 * Coop regrouping. A bot pinned to the human never meets the monsters the
 * team is there to kill, and one that never comes back is not playing coop
 * either -- so instead of a leash it works on a clock: every
 * COOP_REGROUP_SECONDS it walks back to the human, and once it is within
 * COOP_REGROUP_NEAR it goes back to clearing the level. A regroup it cannot
 * finish inside COOP_REGROUP_GIVE_UP is abandoned rather than retried
 * forever, because the human may be somewhere the bot cannot walk to.
 */
const COOP_REGROUP_SECONDS = 15;
const COOP_REGROUP_NEAR = 250;
const COOP_REGROUP_GIVE_UP = 12;
/**
 * How far from the human a monster may be and still be worth going after. A
 * coop bot with nothing else to do hunts, rather than walking the map at
 * random and meeting a monster by accident: clearing the level is what the
 * team is there for. Kept inside the follow distance so hunting never fights
 * the "get back to the player" rule.
 */
const COOP_HUNT_RADIUS = 2000;
/** How close to a team's own objective base counts as defending it. */
const OBJECTIVE_GUARD_RADIUS = 384;
/**
 * How close to its own flag stand a carrier stays while its own flag is out.
 * Touching the stand only scores while the team's own flag is standing on it
 * (ThreeWave's FLAG_AT_BASE test), so a carrier that gets home to an empty
 * stand waits there for its team to bring the flag back rather than wander
 * off after items and die 400 units away -- which is what every carrier on
 * ctf1 did once both flags were out, and both flags were out nearly always.
 */
const CARRIER_HOLD_RADIUS = 192;
/** The body swept along a candidate corner cut: a standing player, with the step height cut off the bottom. */
const PATH_BODY_MINS: BotVec3 = { x: -16, y: -16, z: -24 + 18 };
const PATH_BODY_MAXS: BotVec3 = { x: 16, y: 16, z: 32 };
/** The unstick sidestep is checked this far to the side, with the player's body, for a floor within UNSTICK_MAX_DROP. */
const UNSTICK_STEP = 40;
const UNSTICK_MAX_DROP = 96;
const UNSTICK_BOX_MINS: BotVec3 = { x: -16, y: -16, z: -24 };
const UNSTICK_BOX_MAXS: BotVec3 = { x: 16, y: 16, z: 32 };
/** How far above a submerged bot's eye the contents are tested for a surface worth swimming up to. */
const SURFACE_REACH = 96;
/** The arrival radius for a goal that has to be touched (the flag stand), not merely reached. */
const TOUCH_RADIUS = 12;
/** How far from a shootable gate on its route a bot starts shooting at it, and how well aimed it has to be. */
const GATE_SHOOT_RANGE = 768;
const GATE_AIM_DEGREES = 5;
const GATE_SHOT_SECONDS = 0.7;
/** How far an objective has to be from where it spawned to count as dropped. */
const OBJECTIVE_AWAY = 96;

export class BotBrain {
  readonly config: BotBrainConfigT;
  readonly settings: BotSkillSettings;

  private readonly aim: BotAimStateT = newAimState();
  private readonly pathState: BotPathStateT = newPathState();
  private readonly awareness = new Map<number, BotAwarenessT>();

  private targetId = -1;
  private goalPoint: BotVec3 | null = null;
  /** The entity the current goal belongs to, or -1 for a point goal. */
  private goalEntityId = -1;
  /** Entity id -> the server time it becomes choosable again. See the file header. */
  private readonly unreachableUntil = new Map<number, number>();
  /** Consecutive stuck trips on the current goal. See the file header. */
  private stuckTrips = 0;
  /** True when the current goal entity is something alive rather than a pickup. */
  private goalIsLive = false;
  /** Server time the sidestep-and-hop that breaks a wall contact expires. */
  private unstickUntil = 0;
  /** While `now` is under this, a blocked bot is looking for something to open. See INTERACT_SECONDS. */
  private pressUntil = 0;
  /** Which way that sidestep goes, +1 right or -1 left. */
  private unstickSide = 0;
  private explicitGoal: ExplicitGoalT | null = null;
  private explicitGoalDone = false;
  private explicitGoalFailed = false;

  /** Where the bot was when the wedge timer last reset, and when that was. */
  private wedgeOrigin: BotVec3 | null = null;
  private wedgeSince = -1;
  /** The last spot the bot stood on dry, solid ground: where a bot in lava heads back to (P17). */
  private lastSafeOrigin: BotVec3 | null = null;
  /** A static point the bot has reached, resting until `restUntil` so it roams instead of standing on it (P17). */
  private restPoint: BotVec3 | null = null;
  private restUntil = 0;
  /** Counters a driver or diagnostic can read: steps the edge guard refused, frames spent escaping lava (P17). */
  guardRefusals = 0;
  /** Whether the edge guard zeroed the last frame's move: the wedge detector reads that as pressing into a wall. */
  private lastGuardRefused = false;
  /** Diagnostic: jumps pressed to cross a gap (P17). */
  gapJumps = 0;
  hazardFrames = 0;

  /** Where each objective was standing the first time this level showed it. */
  private readonly objectiveHome = new Map<number, BotVec3>();
  private ownObjectiveHome: BotVec3 | null = null;
  private enemyObjectiveHome: BotVec3 | null = null;
  /** "attack" or "defend" in a game with objectives; "" everywhere else. */
  private objectiveRole = "";
  /** Set by objectiveGoal for the frame: the goal must be touched, so arrival is TOUCH_RADIUS, not 48. */
  private touchGoal = false;
  /** Set by objectiveGoal for the frame: stand here (a carrier at an empty stand). */
  private holdPosition = false;
  /** The point to shoot to open the gate on the route's current link (a shootable secret door), for this frame. */
  private gateShootAt: BotVec3 | null = null;
  private gateFiredAt = -1;
  /** True while a coop bot is on its way back to the human it plays with. */
  private coopRegrouping = false;
  /** Server time the next regroup becomes due, and when this one gives up. */
  private coopRegroupAt = 0;
  private coopRegroupUntil = 0;
  /** Chat types already said once this level. */
  private readonly saidThisLevel = new Set<string>();
  private levelStarted = false;

  private checkSixUntil = 0;
  private checkSixNextAt = 0;
  /**
   * The direction the current look-behind window aims at, captured when that
   * window opened. See `shouldCheckSix`.
   */
  private roamPoint: BotVec3 | null = null;
  /** Server time the current no-navigation roam point expires. */
  private roamUntil = 0;
  private lastCmd: BotUsercmdT = emptyUsercmd();
  private spawnedOnce = false;
  private lastWeaponNumber = 0;
  private deadSince = -1;
  private respawnWait = 0;
  private respawnPress = false;

  constructor(config: BotBrainConfigT) {
    this.config = config;
    const settings = config.knowledge.skill(config.skill) ?? config.knowledge.skills[0];
    if (settings === undefined) throw new Error(`bot_brain: no skill settings available (asked for "${config.skill}")`);
    this.settings = settings;
  }

  //--------------------------------------------------------------------------
  // the QuakeC's own goal API

  /** `bot_movetopoint`: path to a world point. */
  requestMoveToPoint(point: BotVec3): void {
    const same = this.explicitGoal !== null && this.explicitGoal.kind === "point" && bvecDistance(this.explicitGoal.point, point) < 8;
    if (same) return;
    this.explicitGoal = { kind: "point", point: { x: point.x, y: point.y, z: point.z }, entityId: -1 };
    this.explicitGoalDone = false;
    this.explicitGoalFailed = false;
    clearPath(this.pathState);
  }

  /** `bot_followentity`: path to an entity, re-planned as it moves. */
  requestFollowEntity(entityId: number, origin: BotVec3): void {
    if (this.explicitGoal !== null && this.explicitGoal.kind === "entity" && this.explicitGoal.entityId === entityId) {
      this.explicitGoal.point = { x: origin.x, y: origin.y, z: origin.z };
      return;
    }
    this.explicitGoal = { kind: "entity", point: { x: origin.x, y: origin.y, z: origin.z }, entityId };
    this.explicitGoalDone = false;
    this.explicitGoalFailed = false;
    clearPath(this.pathState);
  }

  /** The state of the goal the last `think()` left the explicit goal in. */
  goalStatus(): BotGoalStatusT {
    if (this.explicitGoal === null) return BotGoalStatus.Error;
    if (this.explicitGoalFailed) return BotGoalStatus.Error;
    if (this.explicitGoalDone) return BotGoalStatus.Success;
    return BotGoalStatus.InProgress;
  }

  clearExplicitGoal(): void {
    this.explicitGoal = null;
    this.explicitGoalDone = false;
    this.explicitGoalFailed = false;
  }

  /**
   * Forgets everything that belonged to the last level: the path holds nav
   * points from a graph that no longer exists, and the awareness map is keyed
   * by entity ids the new level has reassigned. Called when the bot is put
   * back into a freshly spawned server.
   */
  resetForLevel(): void {
    clearPath(this.pathState);
    this.awareness.clear();
    this.clearExplicitGoal();
    this.targetId = -1;
    this.goalPoint = null;
    this.goalEntityId = -1;
    this.unreachableUntil.clear();
    this.stuckTrips = 0;
    this.unstickUntil = 0;
    this.pressUntil = 0;
    this.roamPoint = null;
    this.roamUntil = 0;
    this.checkSixUntil = 0;
    this.checkSixNextAt = 0;
    this.deadSince = -1;
    this.lastWeaponNumber = 0;
    this.lastCmd = emptyUsercmd();
    this.wedgeOrigin = null;
    this.lastSafeOrigin = null;
    this.restPoint = null;
    this.restUntil = 0;
    this.wedgeSince = -1;
    this.objectiveHome.clear();
    this.ownObjectiveHome = null;
    this.enemyObjectiveHome = null;
    this.objectiveRole = "";
    this.coopRegrouping = false;
    this.coopRegroupAt = 0;
    this.coopRegroupUntil = 0;
    this.saidThisLevel.clear();
    this.levelStarted = false;
  }

  /**
   * The game mode the brain is playing under. The binding re-reads its own
   * rules at every level change (a `game ctf` server does not become a CTF
   * server until a map with the flags on it is running), so this is settable
   * rather than fixed at construction.
   */
  setGameMode(mode: BotGameModeT): void {
    this.config.gameMode = mode;
  }

  //--------------------------------------------------------------------------

  /** The awareness record for one entity, for tests and debugging. */
  awarenessOf(id: number): BotAwarenessT | undefined {
    return this.awareness.get(id);
  }

  /** The enemy the brain is currently fighting, or -1. */
  currentTarget(): number {
    return this.targetId;
  }

  /** The path the brain is currently following, or null. */
  currentPath(): NavPathT | null {
    return this.pathState.path;
  }

  /** The index of the point the follower is steering at, for a trace or a debugger. */
  currentPathIndex(): number {
    return this.pathState.index;
  }

  //--------------------------------------------------------------------------

  /** Says one of this type's lines the first time in a level, and no more. */
  private emitChatOnce(type: string): void {
    if (this.saidThisLevel.has(type)) return;
    this.saidThisLevel.add(type);
    this.emitChat(type);
  }

  /** Says one of the chats.txt lines of this type, if its `chance` rolls true. */
  emitChat(type: string): void {
    const onChat = this.config.onChat;
    if (onChat === undefined) return;
    const candidates = this.config.knowledge.chatsOfType(type);
    if (candidates.length === 0) return;
    const chat = candidates[randomIndex(this.config.rng, candidates.length)]!;
    if (!randomChance(this.config.rng, chat.chance)) return;
    onChat({ locstring: chat.locstring, type: chat.type, delayMs: chat.time, teamOnly: chat.team });
  }

  //--------------------------------------------------------------------------

  think(world: BotWorldT): BotUsercmdT {
    const self = world.self();
    const now = world.time();
    const dt = world.frameTime();
    const cmd = emptyUsercmd();

    if (!this.spawnedOnce) {
      this.spawnedOnce = true;
      this.emitChat("connected");
    }
    if (!this.levelStarted) {
      this.levelStarted = true;
      this.emitChat("match_start");
    }

    this.aim.pitch = self.viewAngles.x;
    this.aim.yaw = self.viewAngles.y;

    if (self.dead) {
      cmd.viewAngles = bvec(this.aim.pitch, this.aim.yaw, 0);
      if (this.deadSince < 0) {
        this.deadSince = now;
        this.respawnWait = randomRange(this.config.rng, this.settings.behaviors.minRespawnTime, this.settings.behaviors.maxRespawnTime);
        this.respawnPress = false;
      }
      // The QuakeC's PlayerDeathThink wants the attack button RELEASED and
      // then PRESSED: it moves a DEAD_DEAD player to DEAD_RESPAWNABLE only on
      // a frame with no buttons down, and respawns on the next frame with one
      // down. A bot that simply holds attack never respawns at all, so this
      // toggles it after the skill's own respawn pause.
      if (now - this.deadSince >= this.respawnWait) {
        this.respawnPress = !this.respawnPress;
        if (this.respawnPress) cmd.buttons |= BOT_BUTTON_ATTACK;
      }
      clearPath(this.pathState);
      this.targetId = -1;
      this.awareness.clear();
      this.lastCmd = cmd;
      return cmd;
    }
    this.deadSince = -1;

    const entities = world.entities();
    const sounds = world.hearing();

    //---- 1/2: senses and target selection -----------------------------------
    this.updateSenses(world, self, entities, sounds, dt, now);
    this.updateObjectives(entities, self, now);
    const target = this.selectTarget(entities, self.team, self.origin);
    this.targetId = target === null ? -1 : target.id;

    // Pressing into geometry without moving, whether or not there is a path
    // to blame. See the file header.
    const wedged = this.updateWedge(self.origin, now, target !== null);

    //---- 3: goal ------------------------------------------------------------
    const goal = this.selectGoal(world, entities, target, now);

    //---- 4/5: movement ------------------------------------------------------
    let moveTarget: BotVec3 | null = null;
    let ridingLift = false;
    let hazardFace: BotVec3 | null = null; // in lava: the exit the view is held on (the water-jump needs it)
    let inHazardNow = false;
    if (goal !== null && this.holdPosition) {
      // Standing where the goal says to stand: no plan, no steering, and the
      // wedge timer is told this stillness is intended.
      clearPath(this.pathState);
      this.wedgeOrigin = { x: self.origin.x, y: self.origin.y, z: self.origin.z };
      this.wedgeSince = now;
    } else if (goal !== null) {
      this.ensurePath(world, goal, now);

      // A goal with a nav graph in the level and no plan to it is one this
      // bot cannot walk to. Remembered, so the next frame picks something
      // else instead of steering straight at the wall in front of it -- see
      // the file header.
      if (this.pathState.path === null && world.nav() !== null && this.goalEntityId >= 0) {
        this.unreachableUntil.set(this.goalEntityId, now + this.unreachableRest());
        this.abandonGoal();
        this.pressUntil = now + INTERACT_SECONDS;
      }

      const follow = followPath(
        this.pathState,
        { origin: self.origin, pitch: this.aim.pitch, yaw: this.aim.yaw, onGround: self.onGround, waterLevel: self.waterLevel, airSeconds: self.airSeconds, airAbove: self.waterLevel >= 3 ? this.airAbove(world, self) : undefined, velocity: self.velocity, now, stuckTime: STUCK_SECONDS, runSpeed: this.config.runSpeed, walkSpeed: this.config.walkSpeed },
        this.settings.movement,
        this.config.rng,
      );

      if (follow.status === BotPathStatus.Stuck) {
        this.stuckTrips++;
        // A bot that walked dead-on into a wall has no tangential velocity to
        // slide along it with, so it presses there with forwardmove at full
        // speed and does not move a unit -- and re-planning produces the same
        // route into the same wall, forever. Breaking contact sideways (and
        // hopping, for a step the follower misjudged) is what gets it back
        // onto a route it can walk. See the file header.
        this.unstickUntil = now + UNSTICK_SECONDS;
        this.unstickSide = this.pickUnstickSide(world, self);
        if (this.stuckTrips >= STUCK_GIVE_UP) {
          // Three trips in a row with no progress: this is not a route the
          // bot can actually walk, whatever the graph says. The goal gets the
          // same rest an unplannable one gets, so the next frame picks
          // something else instead of re-planning into the same wall.
          if (this.goalEntityId >= 0) this.unreachableUntil.set(this.goalEntityId, now + this.unreachableRest());
          this.abandonGoal();
          this.pressUntil = now + INTERACT_SECONDS;
          this.stuckTrips = 0;
        } else {
          clearPath(this.pathState);
        }
      } else if (follow.status === BotPathStatus.Arrived) {
        if (this.touchGoal && bvecDistance(self.origin, goal) >= TOUCH_RADIUS) {
          // The route ends at the graph node by the flag stand; the last few
          // units onto the stand itself are walked straight.
          const direct = steerDirect(self.origin, this.aim.yaw, goal, this.settings.movement.walkOnly, this.config.runSpeed, this.config.walkSpeed);
          cmd.forwardmove = direct.forwardmove;
          cmd.sidemove = direct.sidemove;
          moveTarget = goal;
        } else {
          this.restStaticGoal(goal, now);
          this.reachGoal();
        }
      } else if (follow.status === BotPathStatus.Moving) {
        this.stuckTrips = 0; // real progress retires the tally
        cmd.forwardmove = follow.forwardmove;
        cmd.sidemove = follow.sidemove;
        cmd.upmove = follow.upmove;
        if (follow.jump) cmd.buttons |= BOT_BUTTON_JUMP;
        ridingLift = follow.riding === true;
        moveTarget = follow.target;
        this.gateShootAt = this.gateToShoot(world, entities, self, follow.link?.entityBounds ?? null);
      } else if (follow.status === BotPathStatus.NoPath) {
        // No graph, or none needed: walk straight at it.
        const reach = this.touchGoal ? TOUCH_RADIUS : 48;
        if (bvecDistance(self.origin, goal) < reach) {
          // At the point: no press. A camper pressing at a goal it already
          // stands on read as wedged, and the unstick hops that followed
          // walked it off ledges (ctf1's flag room has a pit beside it).
          this.restStaticGoal(goal, now);
          this.reachGoal();
        } else {
          const direct = steerDirect(self.origin, this.aim.yaw, goal, this.settings.movement.walkOnly, this.config.runSpeed, this.config.walkSpeed);
          cmd.forwardmove = direct.forwardmove;
          cmd.sidemove = direct.sidemove;
          moveTarget = goal;
        }
      }
    }

    // P17 (2026-09-08, ctf6/ctf8): bots walked into lava on a route -- off a
    // ledge beside a teleporter, past a walk-off-ledge landing, across a
    // corner cut over a pit -- and then kept following the path while it
    // burned them (9 of 17 deaths on ctf6 were lava). Two rules, both from
    // what the world says is under the bot:
    //  - in lava or slime, nothing else matters: drop the plan, FACE the
    //    last dry ground the bot stood on (or the nearest non-lava spot
    //    around it) and push straight at it. The climb out is the engine's
    //    water-jump, which fires only for a player whose view faces a wall
    //    within 24 units with its origin in the liquid: measured on ctf8's
    //    central channel (banks 16 u above the lava), facing the bank and
    //    pushing forward is out in 0.5 s, facing an enemy and strafing at
    //    the bank is pinned on it until dead, and pressing move-up lifts
    //    the origin above the surface where neither swimming nor the
    //    water-jump works. So: aim at the exit over any enemy, no jump, no
    //    move-up unless fully under (then swim up to the surface first);
    //  - on the ground, a step whose floor ahead is lava is not taken; a
    //    planned long jump is the one exception.
    if (this.inHazard(world, self)) {
      this.hazardFrames++;
      inHazardNow = true;
      clearPath(this.pathState);
      const exit = this.lastSafeOrigin ?? this.hazardExit(world, self);
      if (exit !== null) {
        this.aim.yaw = (Math.atan2(exit.y - self.origin.y, exit.x - self.origin.x) * 180) / Math.PI;
        this.aim.pitch = 0;
        hazardFace = exit;
        const direct = steerDirect(self.origin, this.aim.yaw, exit, false, this.config.runSpeed, this.config.walkSpeed);
        cmd.forwardmove = direct.forwardmove;
        cmd.sidemove = direct.sidemove;
        moveTarget = exit;
      }
      cmd.upmove = self.waterLevel >= 3 ? (this.config.runSpeed ?? BOT_RUN_SPEED) : 0;
      cmd.buttons &= ~BOT_BUTTON_JUMP;
      this.wedgeOrigin = { x: self.origin.x, y: self.origin.y, z: self.origin.z };
      this.wedgeSince = now;
    } else if (self.onGround && self.waterLevel === 0) {
      this.lastSafeOrigin = { x: self.origin.x, y: self.origin.y, z: self.origin.z };
    }

    // Nothing above this point knows what is actually in front of the bot:
    // the follower steers at a point and the direct branch steers at a goal,
    // and both do it through whatever geometry lies between.
    if (target !== null && rollCombatJump(this.pathState, this.settings.movement, this.config.rng, now, self.onGround)) {
      cmd.buttons |= BOT_BUTTON_JUMP;
    }

    if (wedged) {
      if (this.unstickUntil <= now) {
        this.unstickUntil = now + UNSTICK_SECONDS;
        this.unstickSide = this.pickUnstickSide(world, self);
        clearPath(this.pathState);
      }
      if (now - this.wedgeSince >= WEDGED_GIVE_UP_SECONDS) {
        if (this.goalEntityId >= 0) this.unreachableUntil.set(this.goalEntityId, now + this.unreachableRest());
        this.abandonGoal();
        this.pressUntil = now + INTERACT_SECONDS;
        this.wedgeOrigin = { x: self.origin.x, y: self.origin.y, z: self.origin.z };
        this.wedgeSince = now;
      }
    }

    // The unstick window opened by a stuck trip, above.
    if (now < this.unstickUntil) {
      const speed = this.config.runSpeed ?? BOT_RUN_SPEED;
      cmd.sidemove = this.unstickSide * speed;
      cmd.forwardmove *= 0.5;
      if (self.onGround) cmd.buttons |= BOT_BUTTON_JUMP;
    }

    // The edge guard (P17) has the last word on a step: it runs after the
    // combat-jump roll and the unstick hop, which add a jump and a sideways
    // move of their own -- run before them it zeroed the follower's step
    // and the hop then carried the bot off the rim anyway. A step whose
    // floor ahead is lava is not taken; a planned long jump is the one
    // exception. The plan is kept: the follower's own no-progress timer
    // trips the unstick and, after STUCK_GIVE_UP trips, rests the goal
    // (clearing the plan here re-planned the same route every frame and
    // bots stood at a rim for a whole match).
    this.lastGuardRefused = false;
    if (!inHazardNow && self.onGround) {
      const link = this.pathState.path?.links[this.pathState.index] ?? null;
      const plannedJump = link !== null && (link.type === NavLinkType.LongJump || link.type === NavLinkType.ManualLongJump);
      let gapJumpPressed = false;
      if (!plannedJump && (cmd.forwardmove !== 0 || cmd.sidemove !== 0)) {
        let gap = this.gapAhead(world, self, cmd, moveTarget);
        if (gap !== null && gap.crossable && now < this.unstickUntil) gap = { ...gap, crossable: false }; // no gap jumps out of an unstick hop
        if (gap !== null && !gap.crossable && now < this.unstickUntil) {
          // The unstick hop's side is the pit: the other side, or back off.
          cmd.sidemove = -cmd.sidemove;
          this.unstickSide = -this.unstickSide;
          gap = this.gapAhead(world, self, cmd, moveTarget);
          if (gap !== null && !gap.crossable) {
            cmd.sidemove = 0;
            cmd.forwardmove = -(this.config.runSpeed ?? BOT_RUN_SPEED);
            cmd.buttons &= ~BOT_BUTTON_JUMP;
            gap = this.gapAhead(world, self, cmd, moveTarget);
          }
        }
        if (gap !== null && gap.crossable) {
          // A gap the route crosses (ctf8: 64 u of lava between the central
          // channel's banks, 112-128 u of lava off the upper level onto a
          // floor 64-224 u lower): run at it and jump at the rim, as a
          // player does. Refusing these held bots at the rim for 40 s.
          if (gap.hazardAt <= GAP_JUMP_TRIGGER) {
            cmd.buttons |= BOT_BUTTON_JUMP;
            this.gapJumps++;
            gapJumpPressed = true;
          }
        } else if (gap !== null) {
          this.guardRefusals++;
          this.lastGuardRefused = true;
          cmd.forwardmove = 0;
          cmd.sidemove = 0;
          cmd.buttons &= ~BOT_BUTTON_JUMP;
          // Direct steering at a roam point with no route: the point is
          // across a pit with no landing. Drop it now instead of standing
          // until it rests (7 s stalls on ctf6).
          if (this.pathState.path === null && this.roamPoint !== null && this.goalEntityId < 0 && !this.touchGoal && !this.holdPosition) this.abandonGoal();
        }
      }
      if ((cmd.buttons & BOT_BUTTON_JUMP) !== 0 && !plannedJump && !gapJumpPressed && this.jumpLandsInHazard(world, self, cmd)) {
        // A jump (combat hop, unstick hop) carries the bot a run's worth of
        // air past the step guard's look: five of ctf8's eighteen lava
        // deaths took off from a rim at jump speed. The walk stays, the
        // jump does not.
        this.guardRefusals++;
        cmd.buttons &= ~BOT_BUTTON_JUMP;
      }
    }

    if (this.holdPosition) {
      cmd.forwardmove = 0;
      cmd.sidemove = 0;
      cmd.upmove = 0;
    }

    // Nobody camps on a lift. A bot standing still on a plat at the top keeps
    // it there (plat_center_touch re-arms its return every second), and every
    // bot below waits for a ride that never comes -- ctf4's flag platforms
    // sit on exactly such lifts. A bot with no movement of its own on a lift
    // walks forward off it, unless it is the rider waiting to go up.
    if (self.onLift === true && !ridingLift && cmd.forwardmove === 0 && cmd.sidemove === 0) {
      cmd.forwardmove = this.config.walkSpeed ?? BOT_WALK_SPEED;
    }

    //---- 6: aim -------------------------------------------------------------
    let aimAt: BotVec3 | null = null;
    if (hazardFace !== null) {
      // held by the escape above: the yaw is already on the exit
    } else if (target !== null) {
      const aw = this.awareness.get(target.id);
      const point = this.aimPointFor(target, self.origin);
      const lead = aimLeadPoint(point, target.velocity, this.settings.aiming);
      aimAt = bvecSub(lead, self.eye);
      if (aw !== undefined && aw.lastSeen < now) aimAt = bvecSub(aw.lastKnownOrigin, self.eye);
    } else if (this.gateShootAt !== null) {
      aimAt = bvecSub(this.gateShootAt, self.eye);
    } else if (this.shouldCheckSix(now)) {
      const { forward } = { forward: bvec(Math.cos(((this.aim.yaw + 180) * Math.PI) / 180), Math.sin(((this.aim.yaw + 180) * Math.PI) / 180), 0) };
      aimAt = forward;
    } else if (moveTarget !== null) {
      aimAt = bvecSub(moveTarget, self.origin);
      aimAt.z = 0;
    }

    if (aimAt !== null) aimStep(this.aim, aimAt, this.settings.aiming, dt, now);
    cmd.viewAngles = bvec(this.aim.pitch, angleMod(this.aim.yaw), 0);

    // A shot at the gate once the view has come round to it. One press per
    // GATE_SHOT_SECONDS: a secret door swings on the first hit, and the
    // route through it stops naming the gate as soon as it has moved.
    if (this.gateShootAt !== null && target === null && now - this.gateFiredAt >= GATE_SHOT_SECONDS) {
      if (angleBetween(this.aim.pitch, this.aim.yaw, bvecSub(this.gateShootAt, self.eye)) <= GATE_AIM_DEGREES) {
        cmd.buttons |= BOT_BUTTON_ATTACK;
        this.gateFiredAt = now;
      }
    }

    // forwardmove/sidemove above were projected onto the view the bot held
    // when the frame began, but the usercmd carries the view it holds NOW,
    // and the server moves the bot with the angles in that same command --
    // exactly as a human client does, projecting onto the angles it is about
    // to send. Left uncorrected the world direction comes out rotated by
    // however far the tracker turned this frame: a few degrees while it is
    // settling, hundreds while it is not. A bot in the middle of a turn then
    // walks into the wall beside its route instead of along it.

    //---- 7: weapon and trigger ----------------------------------------------
    if (target !== null) {
      const pick = this.selectWeapon(self, target);
      if (pick !== null && pick !== self.currentWeapon && pick !== this.lastWeaponNumber) {
        const impulse = this.config.weaponImpulse?.(pick) ?? 0;
        if (impulse > 0) {
          cmd.impulse = impulse;
          this.lastWeaponNumber = pick;
        } else if (this.config.onWeaponSelect !== undefined) {
          this.config.onWeaponSelect(pick);
          this.lastWeaponNumber = pick;
        }
      } else if (pick === self.currentWeapon) {
        this.lastWeaponNumber = 0;
      }

      const aw = this.awareness.get(target.id);
      if (aw !== undefined && canFire(aw) && aimAt !== null && aimError(this.aim, aimAt) < this.settings.weapons.fovAngle / 2) {
        cmd.buttons |= BOT_BUTTON_ATTACK;
      }
    }

    // Interactables that only need a nudge: press use when standing on one.
    if (this.wantsUse(world, entities, self.origin)) cmd.buttons |= BOT_BUTTON_USE;

    this.lastCmd = cmd;
    return cmd;
  }

  /** The last usercmd `think()` produced. */
  lastUsercmd(): BotUsercmdT {
    return this.lastCmd;
  }

  //--------------------------------------------------------------------------

  private updateSenses(world: BotWorldT, self: ReturnType<BotWorldT["self"]>, entities: readonly BotEntityT[], sounds: readonly { origin: BotVec3; sourceId: number; time: number; loudness: number }[], dt: number, now: number): void {
    const senses = this.settings.senses;
    const weapons = this.settings.weapons;

    for (const ent of entities) {
      if (ent.id === self.id) continue;
      if (ent.kind !== BotEntityKind.Player && ent.kind !== BotEntityKind.Monster) continue;
      if (ent.dead) {
        this.awareness.delete(ent.id);
        continue;
      }

      const geom = evaluateSightGeometry(self.eye, this.aim.pitch, this.aim.yaw, ent.center, ent.invisible, senses, weapons);
      const clear = geom.withinInvisRange && world.traceLine(self.eye, ent.center).fraction >= 1;

      let audible = false;
      for (const s of sounds) {
        if (s.sourceId !== ent.id) continue;
        if (soundAudible(s, self.origin, senses, now)) {
          audible = true;
          break;
        }
      }

      const contact: BotContactT = {
        lineOfSight: clear,
        inSightFov: geom.inSightFov,
        inWeaponFov: geom.inWeaponFov,
        audible,
        invisible: ent.invisible,
        distance: geom.distance,
        origin: ent.center,
      };

      let aw = this.awareness.get(ent.id);
      if (aw === undefined) {
        aw = newAwareness(ent.id, now, ent.center);
        this.awareness.set(ent.id, aw);
      }
      senseStep(aw, contact, senses, weapons, dt, now);
    }

    for (const [id, aw] of [...this.awareness]) {
      if (shouldForget(aw, senses, now)) this.awareness.delete(id);
    }
  }

  private selectTarget(entities: readonly BotEntityT[], team: number, selfOrigin: BotVec3): BotEntityT | null {
    if (!this.settings.behaviors.allowCombat) {
      // "False = bot fights stupidly": it still shoots at whatever it is
      // fully aware of, it just does not choose between enemies.
      for (const ent of entities) {
        const aw = this.awareness.get(ent.id);
        if (aw !== undefined && isAware(aw) && !this.friendly(ent, team)) return ent;
      }
      return null;
    }

    let best: BotEntityT | null = null;
    let bestScore = -Infinity;
    for (const ent of entities) {
      const aw = this.awareness.get(ent.id);
      if (aw === undefined || !isAware(aw)) continue;
      if (this.friendly(ent, team)) continue;

      // Prefer whatever is closest; a player outranks a monster of the same
      // distance because a player shoots back, and an enemy carrying our
      // flag outranks everything within reach: killing the carrier is what
      // gets the flag back, and a team whose flag is out cannot score.
      let score = 4096 - bvecDistance(selfOrigin, aw.lastKnownOrigin);
      if (ent.kind === BotEntityKind.Player) score += 512;
      if (ent.carryingObjective === true) score += 1536;
      score += aw.weapon * 256;
      if (ent.id === this.targetId) score += 128; // hysteresis: do not flip-flop
      if (score > bestScore) {
        bestScore = score;
        best = ent;
      }
    }
    return best;
  }

  /**
   * Teams only exist in a team game. game_rules.txt's own `game_type` is what
   * says whether this is one, and outside those modes every other player is a
   * target however the QuakeC has filled in `team` -- the re-release's
   * PutClientInServer writes TEAM_NONE as -1 and progs106 writes 0, so a
   * plain "same value means teammate" test makes every bot in a free-for-all
   * refuse to fight anyone.
   */
  private teamGame(): boolean {
    const type = this.config.gameMode.gameType;
    return type === BotGameType.TeamDeathmatch || type === BotGameType.Ctf || this.coopGame();
  }

  /**
   * Coop and horde are the same game to a bot: one team, and everything that
   * has to be killed is a monster. game_rules.txt gives horde its own
   * `game_type` (the re-release's own mg1/bots/game_rules.txt has
   * `horde 1 -> horde` ahead of `coop 1 -> coop`), so a bot that only knew
   * about coop treated every other player in a horde game as something to
   * shoot -- which, with the QuakeC's own player friendly fire, is four bots
   * killing each other in the first five seconds of a wave game.
   */
  private coopGame(): boolean {
    const type = this.config.gameMode.gameType;
    return type === BotGameType.Coop || type === BotGameType.Horde;
  }

  private friendly(ent: BotEntityT, team: number): boolean {
    if (ent.kind === BotEntityKind.Monster) {
      // Monsters are hostile unless the knowledge file does not know them at
      // all, in which case they are scenery.
      return this.config.knowledge.monster(ent.classname) === undefined;
    }
    if (ent.kind !== BotEntityKind.Player) return true;
    if (!this.teamGame()) return false;
    if (team <= 0 || ent.team <= 0) return false;
    return ent.team === team;
  }

  //--------------------------------------------------------------------------

  /**
   * True when the bot has spent `WEDGED_SECONDS` pressing a move into the
   * world without going anywhere. The path follower's own stuck test only
   * watches a path, and the branch that steers straight at a goal with no
   * path has none at all.
   *
   * NOT WHILE FIGHTING. A bot in a fight circles its target on purpose, so
   * its NET displacement stays small however fast it is actually moving --
   * which this timer, measuring displacement, reads as a wedge. Combat
   * steering is not pathing, so a wedge says nothing about it; the two
   * states the timer exists for -- bouncing between two path points, and
   * leaning on a wall with no path -- are both out of combat anyway.
   */
  private updateWedge(origin: BotVec3, now: number, inCombat: boolean): boolean {
    const cmd = this.lastCmd;
    // A move the edge guard zeroed was a move the bot wanted: without this
    // a bot refused at a rim reads as "not pressing", the timer resets every
    // frame and the unstick / give-up escalation never runs (P17: 14-40 s
    // stalls at lava rims).
    const pressing = cmd.forwardmove !== 0 || cmd.sidemove !== 0 || this.lastGuardRefused;
    if (inCombat || this.wedgeOrigin === null || !pressing || bvecDistance(origin, this.wedgeOrigin) > WEDGED_DISPLACEMENT) {
      this.wedgeOrigin = { x: origin.x, y: origin.y, z: origin.z };
      this.wedgeSince = now;
      return false;
    }
    return now - this.wedgeSince >= WEDGED_SECONDS;
  }

  /**
   * Where each objective on this level lives, and which side of it this bot
   * is on. A carried flag stops being an entity the world reports at all, so
   * where it spawned has to be remembered rather than looked up: that point
   * is the base a carrier runs to, a defender guards, and an attacker camps.
   */
  private updateObjectives(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, now: number): void {
    const knowledge = this.config.knowledge;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Item) continue;
      const item = knowledge.item(ent.classname);
      if (item === undefined || !item.flags.includes(ITEM_FLAG.objective)) continue;
      if (!this.objectiveHome.has(ent.id)) this.objectiveHome.set(ent.id, { x: ent.origin.x, y: ent.origin.y, z: ent.origin.z });
      const team = item.team ?? ent.team;
      if (team <= 0 || self.team <= 0) continue;
      const home = this.objectiveHome.get(ent.id)!;
      if (team === self.team) this.ownObjectiveHome = home;
      else this.enemyObjectiveHome = home;
    }

    if (this.objectiveRole === "" && this.ownObjectiveHome !== null && this.enemyObjectiveHome !== null) {
      // A quarter of the roster stays home; the rest go for the enemy flag.
      this.objectiveRole = randomChance(this.config.rng, 25) ? "defend" : "attack";
      this.emitChatOnce(this.objectiveRole === "defend" ? "ctf_on_defense" : "ctf_on_offense");
    }

    if (this.objectiveRole === "attack" && this.enemyObjectiveHome !== null && now > 0) {
      if (bvecDistance(self.origin, this.enemyObjectiveHome) < OBJECTIVE_GUARD_RADIUS) this.emitChatOnce("ctf_camping_enemy_base");
    }
  }

  /** The objective entity the bot should be walking to, or null. */
  private objectiveGoal(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, target: BotEntityT | null, now: number): BotVec3 | null {
    if (this.ownObjectiveHome === null && this.enemyObjectiveHome === null) return null;
    const knowledge = this.config.knowledge;

    // Carrying the enemy's: nothing else matters until it is home. A capture
    // is touching our own flag while it stands at home, so when it does the
    // goal is the flag itself, walked onto rather than stopped short of; when
    // it is out (carried or dropped) the carrier goes home and waits there.
    if (self.carryingObjective === true && this.ownObjectiveHome !== null) {
      this.emitChatOnce("ctf_delivering_flag");
      this.goalEntityId = -1;
      for (const ent of entities) {
        if (ent.kind !== BotEntityKind.Item) continue;
        const item = knowledge.item(ent.classname);
        if (item === undefined || !item.flags.includes(ITEM_FLAG.objective)) continue;
        if ((item.team ?? ent.team) !== self.team) continue;
        if (bvecDistance(ent.origin, this.ownObjectiveHome) > OBJECTIVE_AWAY) continue;
        this.touchGoal = true;
        return ent.origin;
      }
      if (bvecDistance(self.origin, this.ownObjectiveHome) < CARRIER_HOLD_RADIUS) this.holdPosition = true;
      return this.ownObjectiveHome;
    }

    let enemyFlag: BotEntityT | null = null;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Item) continue;
      const item = knowledge.item(ent.classname);
      if (item === undefined || !item.flags.includes(ITEM_FLAG.objective)) continue;
      const team = item.team ?? ent.team;
      if (team <= 0 || self.team <= 0) continue;
      const home = this.objectiveHome.get(ent.id);
      if (team === self.team) {
        // Ours, lying in the field: touching it is what sends it back.
        if (home !== undefined && bvecDistance(ent.origin, home) > OBJECTIVE_AWAY) {
          this.emitChatOnce("ctf_returning_dropped_flag");
          this.goalEntityId = ent.id;
          return ent.origin;
        }
        continue;
      }
      enemyFlag = ent;
    }

    // Who is carrying what. An enemy carrying OURS decides the match (our
    // carrier cannot score until it is back); our own carrier is worth
    // escorting while it is still on its way home.
    let ourCarrier: BotEntityT | null = null;
    let enemyCarrier: BotEntityT | null = null;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Player || ent.carryingObjective !== true || ent.id === self.id || ent.dead) continue;
      if (ent.team !== self.team) enemyCarrier = ent;
      else ourCarrier = ent;
    }
    const huntEnemyCarrier = (): BotVec3 => {
      this.emitChatOnce("ctf_attacking_enemy_carrier");
      this.goalEntityId = enemyCarrier!.id;
      this.goalIsLive = true;
      return enemyCarrier!.origin;
    };

    if (this.objectiveRole === "defend") {
      if (target !== null) return null; // an enemy in the base outranks the base
      // Our flag is on an enemy: the defender's job is that enemy (P17: the
      // two-carriers-waiting stalemate, ctf8).
      if (enemyCarrier !== null) return huntEnemyCarrier();
      if (this.ownObjectiveHome === null) return null;
      if (bvecDistance(self.origin, this.ownObjectiveHome) < OBJECTIVE_GUARD_RADIUS) return null;
      this.goalEntityId = -1;
      return this.ownObjectiveHome;
    }

    if (target !== null && target.kind === BotEntityKind.Player && target.team > 0 && target.team !== self.team) {
      this.emitChatOnce("ctf_attacking_enemy_carrier");
    }

    if (enemyFlag !== null) {
      this.goalEntityId = enemyFlag.id;
      return enemyFlag.origin;
    }
    // The enemy flag is on our carrier: escort it while it is still on its
    // way home. Once it holds at the stand (waiting for our own flag) there
    // is nothing to escort, and the attacker goes after the enemy carrier
    // that is holding the match up -- or, with none known, fights, picks up
    // and roams. Standing on the enemy's empty stand until their flag came
    // back is what the bots did before (P17: 10-25 s dead still, ctf6/ctf8);
    // hunting the enemy carrier with EVERY attacker was the other extreme
    // (no carrier survived the trip on ctf6).
    if (ourCarrier !== null) {
      const carrierHome = this.ownObjectiveHome !== null && bvecDistance(ourCarrier.origin, this.ownObjectiveHome) < CARRIER_HOLD_RADIUS;
      if (carrierHome) return enemyCarrier !== null ? huntEnemyCarrier() : null;
      this.goalEntityId = ourCarrier.id;
      this.goalIsLive = true;
      if (bvecDistance(self.origin, ourCarrier.origin) < ESCORT_DISTANCE) return null; // close enough: fight, pick up, roam
      return ourCarrier.origin;
    }
    // Nobody on our side has it and it is not lying about: whoever holds it
    // must bring it here. A point already reached rests, so the bot roams
    // the area instead of standing on the stand.
    if (this.enemyObjectiveHome === null) return null;
    if (this.restPoint !== null && bvecDistance(this.restPoint, this.enemyObjectiveHome) < 1 && now < this.restUntil) return null;
    this.goalEntityId = -1;
    return this.enemyObjectiveHome;
  }

  /**
   * The gate on the route's current link, when it is one the bot has to
   * shoot open. NAV2 records, per gated link, the bounds of the brush entity
   * that gates it; the interactable whose centre lies inside those bounds is
   * the gate, and interactables.txt says what opens it. A shootable secret
   * door (ctf1 has six, in the underpasses beside each base) opens on the
   * first hit and stops matching the bounds once it has swung, so a bot that
   * used to press against it for the rest of the level now fires once and
   * walks through. Pushable gates need nothing here: the route walks into
   * them. Plats and trains have their own link types.
   */
  private gateToShoot(world: BotWorldT, entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, bounds: { mins: BotVec3; maxs: BotVec3 } | null): BotVec3 | null {
    if (bounds === null) return null;
    const knowledge = this.config.knowledge;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Interactable) continue;
      const c = ent.center;
      if (c.x < bounds.mins.x - 8 || c.x > bounds.maxs.x + 8 || c.y < bounds.mins.y - 8 || c.y > bounds.maxs.y + 8 || c.z < bounds.mins.z - 8 || c.z > bounds.maxs.z + 8) continue;
      if (knowledge.interactionFor(ent.classname, ent) !== INTERACTION.shoot) return null;
      if (bvecDistance(self.eye, c) > GATE_SHOOT_RANGE) return null;
      if (world.traceLine(self.eye, c).fraction < 1 && world.traceLine(self.eye, c).hitId !== ent.id) return null;
      return c;
    }
    return null;
  }

  /**
   * Which way to sidestep out of a wedge: a random side, unless the floor
   * that way ends within a step (a pit, a ledge, a shaft), in which case the
   * other side, or none. The blind sidestep walked wedged and camping bots
   * off the edge beside ctf1's flag room into the pit below it.
   */
  private pickUnstickSide(world: BotWorldT, self: ReturnType<BotWorldT["self"]>): number {
    const first = randomChance(this.config.rng, 50) ? 1 : -1;
    const { right } = angleVectors(0, this.aim.yaw, 0);
    let dropSides = 0;
    for (const side of [first, -first]) {
      const at = { x: self.origin.x + right.x * side * UNSTICK_STEP, y: self.origin.y + right.y * side * UNSTICK_STEP, z: self.origin.z + 8 };
      const down = world.traceBox(at, UNSTICK_BOX_MINS, UNSTICK_BOX_MAXS, { x: at.x, y: at.y, z: at.z - UNSTICK_MAX_DROP });
      if (down.startsolid) continue; // a wall that way: the other side, if any
      if (down.fraction < 1) return side; // floor within reach
      dropSides++;
    }
    // Both sides open with no floor in reach: a bot on a narrow beam, or a
    // world whose traces do not model the floor (the unit tests' stub). The
    // random side is the better bet than no sidestep at all.
    return dropSides === 2 ? first : 0;
  }

  /** A static point (no entity, not a flag to touch or a stand to hold) the bot has just reached rests for a while. */
  private restStaticGoal(goal: BotVec3, now: number): void {
    if (this.goalEntityId >= 0 || this.touchGoal || this.holdPosition) return;
    this.restPoint = { x: goal.x, y: goal.y, z: goal.z };
    this.restUntil = now + POINT_REST_SECONDS;
  }

  /**
   * Whether lava or slime lies under the straight line from `a` to `b`: the
   * floor under points along it is probed downwards; solid before lava is
   * ground, lava before solid is the pit. A drop with no floor within reach
   * is not lava.
   */
  private hazardUnderSegment(world: BotWorldT, a: BotVec3, b: BotVec3): boolean {
    const len = bvecDistance(a, b);
    const steps = Math.max(1, Math.ceil(len / 64));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (hazardBelow(world, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f)) return true;
    }
    return false;
  }

  /** Lava or slime at the bot's centre or feet. */
  private inHazard(world: BotWorldT, self: ReturnType<BotWorldT["self"]>): boolean {
    const isBad = (c: BotContentsT): boolean => c === BotContents.Lava || c === BotContents.Slime;
    return isBad(world.pointContents(self.origin)) || isBad(world.pointContents({ x: self.origin.x, y: self.origin.y, z: self.origin.z - 20 }));
  }

  /** The nearest spot around a bot in lava whose floor is not lava, or null when every direction is. */
  private hazardExit(world: BotWorldT, self: ReturnType<BotWorldT["self"]>): BotVec3 | null {
    for (let i = 0; i < LAVA_EXIT_SAMPLES; i++) {
      const a = (i / LAVA_EXIT_SAMPLES) * Math.PI * 2;
      const p = { x: self.origin.x + Math.cos(a) * LAVA_EXIT_REACH, y: self.origin.y + Math.sin(a) * LAVA_EXIT_REACH, z: self.origin.z };
      const c = world.pointContents(p);
      if (c === BotContents.Lava || c === BotContents.Slime || c === BotContents.Solid) continue;
      const below = world.pointContents({ x: p.x, y: p.y, z: p.z - 24 });
      if (below === BotContents.Lava || below === BotContents.Slime) continue;
      return p;
    }
    return null;
  }

  /**
   * What the move the command presses would carry the bot over. The floor
   * under the points between the bot and EDGE_LOOKAHEAD (plus its stopping
   * distance) ahead is probed; the look is cut at the point the bot is
   * steering for (it turns there). Null when nothing ahead is lava or
   * slime. Otherwise where the hazard starts, and -- looking further, up to
   * GAP_LANDING_SEARCH past it -- whether a floor the bot can land on lies
   * within its jump reach at the speed it will have (ground acceleration is
   * near-instant in Quake, so a bot pressing forward is at its cap by the
   * rim): a crossable gap, or a pit.
   */
  private gapAhead(world: BotWorldT, self: ReturnType<BotWorldT["self"]>, cmd: BotUsercmdT, steerAt: BotVec3 | null): { hazardAt: number; crossable: boolean } | null {
    const dir = this.moveDirection(cmd);
    if (dir === null) return null;
    const { x: mx, y: my } = dir;
    const speed = Math.hypot(self.velocity.x, self.velocity.y);
    let ahead = EDGE_LOOKAHEAD + speed * EDGE_STOP_SECONDS;
    if (steerAt !== null) {
      const along = (steerAt.x - self.origin.x) * mx + (steerAt.y - self.origin.y) * my;
      if (along > EDGE_PROBE_STEP && along < ahead) ahead = along;
    }
    let hazardAt = -1;
    for (let d = EDGE_PROBE_STEP; d <= ahead + 0.01; d += EDGE_PROBE_STEP) {
      if (hazardBelow(world, self.origin.x + mx * d, self.origin.y + my * d, self.origin.z)) {
        hazardAt = d;
        break;
      }
    }
    if (hazardAt < 0) return null;
    // the landing: the first floor past the hazard that is not itself over lava and not a wall
    const floorZ = self.origin.z - 24;
    const cap = this.settings.movement.walkOnly ? (this.config.walkSpeed ?? BOT_WALK_SPEED) : (this.config.runSpeed ?? BOT_RUN_SPEED);
    const runSpeed = Math.max(speed, cap);
    // A landing is two probes in a row (the box is 32 wide) of floor at
    // one height: a single 16-u probe of "floor" past the lava was a rail
    // at chest height on ctf6, and bots jumped onto it and into the lava.
    let landingStart = -1, landingZ = 0;
    for (let d = hazardAt + EDGE_PROBE_STEP; d <= hazardAt + GAP_LANDING_SEARCH; d += EDGE_PROBE_STEP) {
      const x = self.origin.x + mx * d, y = self.origin.y + my * d;
      const trace = world.traceLine({ x, y, z: self.origin.z }, { x, y, z: self.origin.z - EDGE_DROP_CHECK });
      if (trace.startsolid) return { hazardAt, crossable: false }; // a wall past the pit
      const landZ = trace.endpos.z;
      const c = trace.fraction < 1 ? world.pointContents({ x, y, z: landZ + 2 }) : BotContents.Lava;
      const floorHere = trace.fraction < 1 && c !== BotContents.Lava && c !== BotContents.Slime;
      if (!floorHere) { landingStart = -1; continue; } // no floor, or still the pit
      if (landZ > floorZ + GAP_LANDING_RISE) return { hazardAt, crossable: false }; // too high to jump onto
      if (landingStart < 0 || Math.abs(landZ - landingZ) > 8) { landingStart = d; landingZ = landZ; continue; }
      // the second probe of a landing: within reach? The jump's air time
      // over a drop of h: t = (v_jump + sqrt(v_jump^2 + 2 g h)) / g; the box
      // must land fully on the floor, so the centre needs 16 more than the
      // landing's edge.
      const drop = Math.max(0, floorZ - landingZ);
      const airtime = (JUMP_VELOCITY + Math.sqrt(JUMP_VELOCITY * JUMP_VELOCITY + 2 * GRAVITY * drop)) / GRAVITY;
      const reach = runSpeed * airtime * GAP_REACH_MARGIN;
      return { hazardAt, crossable: landingStart + 16 <= reach };
    }
    return { hazardAt, crossable: false };
  }

  /** The world-space horizontal direction the command's move presses, or null for no move. */
  private moveDirection(cmd: BotUsercmdT): { x: number; y: number } | null {
    const yaw = (this.aim.yaw * Math.PI) / 180;
    const fx = Math.cos(yaw), fy = Math.sin(yaw);
    const rx = Math.sin(yaw), ry = -Math.cos(yaw);
    const mx = fx * cmd.forwardmove + rx * cmd.sidemove;
    const my = fy * cmd.forwardmove + ry * cmd.sidemove;
    const ml = Math.hypot(mx, my);
    if (ml < 1) return null;
    return { x: mx / ml, y: my / ml };
  }

  /**
   * Whether a jump pressed now would land the bot over lava or slime: the
   * ground under the run it makes in the air (its current velocity, or the
   * move it presses, for JUMP_AIR_SECONDS) is probed every EDGE_PROBE_STEP.
   */
  private jumpLandsInHazard(world: BotWorldT, self: ReturnType<BotWorldT["self"]>, cmd: BotUsercmdT): boolean {
    let vx = self.velocity.x, vy = self.velocity.y;
    let speed = Math.hypot(vx, vy);
    if (speed < 1) {
      const dir = this.moveDirection(cmd);
      if (dir === null) return false;
      speed = this.config.runSpeed ?? BOT_RUN_SPEED;
      vx = dir.x * speed;
      vy = dir.y * speed;
    }
    const reach = speed * JUMP_AIR_SECONDS;
    const ux = vx / speed, uy = vy / speed;
    for (let d = EDGE_PROBE_STEP; d <= reach + 0.01; d += EDGE_PROBE_STEP) {
      if (hazardBelow(world, self.origin.x + ux * d, self.origin.y + uy * d, self.origin.z)) return true;
    }
    return false;
  }

  /** Whether a submerged bot has a water surface within SURFACE_REACH straight above its head, rather than a ceiling. */
  private airAbove(world: BotWorldT, self: ReturnType<BotWorldT["self"]>): boolean {
    const above = { x: self.eye.x, y: self.eye.y, z: self.eye.z + SURFACE_REACH };
    return world.pointContents(above) === BotContents.Empty;
  }

  /** In coop, the human the bot regroups with. See COOP_REGROUP_SECONDS. */
  /**
   * The nearest thing worth opening, while the bot is blocked. See
   * INTERACT_RADIUS. A brush entity's `origin` is the world origin, so the
   * point walked to is the middle of its bounding box: for a button that is
   * its face, and walking into a button is what pushes it.
   */
  private interactableGoal(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, now: number): BotVec3 | null {
    if (now >= this.pressUntil) return null;
    // A game with objectives has its own reasons to be somewhere; a defender
    // or roamer wandering off to press the nearest button costs the team more
    // than a blocked route does (measured on u_ctf: two lost checks).
    if (this.ownObjectiveHome !== null || this.enemyObjectiveHome !== null) return null;
    const knowledge = this.config.knowledge;

    let best: BotEntityT | null = null;
    let bestRange = Infinity;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Interactable) continue;
      // Buttons only, and only ones nothing else is holding the key to. The
      // point walked to is the middle of the entity's bounding box, which is
      // the right place for a button -- a few units thick, so its middle is
      // its face and walking into it is what pushes it -- and the wrong place
      // for anything large: the middle of a plat or of a door slab is inside
      // the brush, and a bot sent there presses on the outside of it for as
      // long as the errand lasts. An entity with a targetname is opened by
      // whatever targets it, so touching it does nothing either.
      if (knowledge.interactionFor(ent.classname, ent) !== "push") continue;
      if (ent.hasTargetname) continue;
      const blocked = this.unreachableUntil.get(ent.id);
      if (blocked !== undefined) {
        if (blocked > now) continue;
        this.unreachableUntil.delete(ent.id);
      }
      const range = bvecDistance(self.origin, ent.center);
      if (range > INTERACT_RADIUS || range >= bestRange) continue;
      bestRange = range;
      best = ent;
    }
    if (best === null) return null;
    if (bestRange <= INTERACT_REACHED) {
      // Close enough to have walked into it: the errand is over whether or
      // not anything opened, and the bot goes back to playing.
      this.pressUntil = 0;
      return null;
    }
    this.goalEntityId = best.id;
    return best.center;
  }

  private coopRegroupGoal(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, now: number): BotVec3 | null {
    if (!this.coopGame()) return null;
    let nearest: BotEntityT | null = null;
    let best = Infinity;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Player || ent.isBot || ent.dead) continue;
      const d = bvecDistance(self.origin, ent.origin);
      if (d < best) {
        best = d;
        nearest = ent;
      }
    }
    if (nearest === null) {
      this.coopRegrouping = false;
      return null;
    }

    if (!this.coopRegrouping && now >= this.coopRegroupAt) {
      this.coopRegrouping = true;
      this.coopRegroupUntil = now + COOP_REGROUP_GIVE_UP;
    }
    if (this.coopRegrouping && (best <= COOP_REGROUP_NEAR || now >= this.coopRegroupUntil)) {
      this.coopRegrouping = false;
      this.coopRegroupAt = now + COOP_REGROUP_SECONDS;
    }
    if (!this.coopRegrouping) return null;

    this.goalEntityId = -1;
    return nearest.origin;
  }

  /**
   * In coop, the monster to go and kill. Only monsters near the human count,
   * so the bots clear the ground the team is actually on. What the bot may
   * SHOOT is still gated by senses.ts -- this only decides where it walks.
   */
  private coopHuntGoal(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, now: number): BotVec3 | null {
    if (!this.coopGame()) return null;

    let human: BotEntityT | null = null;
    let humanRange = Infinity;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Player || ent.isBot || ent.dead) continue;
      const d = bvecDistance(self.origin, ent.origin);
      if (d < humanRange) {
        humanRange = d;
        human = ent;
      }
    }

    let best: BotEntityT | null = null;
    let bestRange = Infinity;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Monster || ent.dead) continue;
      if (this.friendly(ent, self.team)) continue;
      const blocked = this.unreachableUntil.get(ent.id);
      if (blocked !== undefined) {
        if (blocked > now) continue;
        this.unreachableUntil.delete(ent.id);
      }
      if (human !== null && bvecDistance(human.origin, ent.origin) > COOP_HUNT_RADIUS) continue;
      const d = bvecDistance(self.origin, ent.origin);
      if (d < bestRange) {
        bestRange = d;
        best = ent;
      }
    }
    if (best === null) return null;
    this.goalEntityId = best.id;
    this.goalIsLive = true;
    return best.origin;
  }

  private selectGoal(world: BotWorldT, entities: readonly BotEntityT[], target: BotEntityT | null, now: number): BotVec3 | null {
    this.goalEntityId = -1;
    this.goalIsLive = false;
    this.touchGoal = false;
    this.holdPosition = false;

    // The QuakeC's own goal wins over everything the brain would pick.
    if (this.explicitGoal !== null && !this.explicitGoalDone && !this.explicitGoalFailed) {
      if (this.explicitGoal.kind === "entity") {
        const ent = entities.find((e) => e.id === this.explicitGoal!.entityId);
        if (ent === undefined) {
          this.explicitGoalFailed = true;
        } else {
          this.explicitGoal.point = { x: ent.origin.x, y: ent.origin.y, z: ent.origin.z };
          this.goalPoint = this.explicitGoal.point;
          return this.goalPoint;
        }
      } else {
        this.goalPoint = this.explicitGoal.point;
        return this.goalPoint;
      }
    }

    const self = world.self();

    // An objective is the whole point of the game it belongs to, so it wins
    // over the item run -- and over the fight, for a bot carrying one.
    const objective = this.objectiveGoal(entities, self, target, now);
    if (objective !== null) {
      this.goalPoint = objective;
      return this.goalPoint;
    }

    const inCombat = target !== null;

    if (inCombat) {
      const aw = this.awareness.get(target.id);
      this.goalPoint = aw !== undefined ? aw.lastKnownOrigin : target.origin;
      // In combat the bot may still detour for an item, if the skill allows.
      if (this.settings.behaviors.allowGrabItemsInCombat) {
        const item = this.bestItem(world, entities, now);
        if (item !== null && bvecDistance(self.origin, item.origin) < 512) {
          this.goalEntityId = item.id;
          return item.origin;
        }
      }
      return this.goalPoint;
    }

    // Coop is one team clearing one level. Killing what is still standing
    // near the human comes first, then keeping up with them, and the item run
    // is what a bot does when there is nothing left to do either of those on
    // -- an ammo box the bot has room for is always worth something, so an
    // item run that outranks the fight is an item run that never ends.
    // Blocked comes first: nothing else the bot wants is reachable until
    // whatever is in the way has been opened.
    const unblock = this.interactableGoal(entities, self, now);
    if (unblock !== null) {
      this.goalPoint = unblock;
      return this.goalPoint;
    }

    const regroup = this.coopRegroupGoal(entities, self, now);
    if (regroup !== null) {
      this.goalPoint = regroup;
      return this.goalPoint;
    }

    const hunt = this.coopHuntGoal(entities, self, now);
    if (hunt !== null) {
      this.goalPoint = hunt;
      return this.goalPoint;
    }

    if (this.settings.behaviors.allowGrabItems) {
      const item = this.bestItem(world, entities, now);
      if (item !== null) {
        this.goalEntityId = item.id;
        this.goalPoint = item.origin;
        return this.goalPoint;
      }
    }

    return this.roamGoal(world, now);
  }

  private bestItem(world: BotWorldT, entities: readonly BotEntityT[], now: number): BotEntityT | null {
    const self = world.self();
    const knowledge = this.config.knowledge;
    const deferPower = this.settings.behaviors.deferPowerItemsToHumans && (this.config.humanTeammateNear?.() ?? false);

    let best: BotEntityT | null = null;
    let bestScore = 0;

    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Item) continue;
      const blockedUntil = this.unreachableUntil.get(ent.id);
      if (blockedUntil !== undefined) {
        if (blockedUntil > now) continue;
        this.unreachableUntil.delete(ent.id);
      }
      const item = knowledge.item(ent.classname);
      if (item === undefined) continue;
      if ((item.isPowerup || item.isMega) && deferPower) continue;

      const home = this.objectiveHome.get(ent.id);
      const value = itemValue(item, {
        spawnflags: ent.spawnflags,
        health: self.health,
        maxHealth: this.config.maxHealth ?? 100,
        armor: self.armor,
        items: self.items,
        ammo: self.ammo,
        weaponStay: this.config.gameMode.weaponStay,
        allowPowerItems: this.settings.behaviors.allowGrabPowerItems,
        weapons: knowledge.weapons,
        team: self.team,
        itemTeam: item.team ?? ent.team,
        objectiveAtHome: home === undefined || bvecDistance(ent.origin, home) <= OBJECTIVE_AWAY,
      });
      if (value <= 0) continue;

      // Nearer is better: divide the want by the distance it costs to get.
      const dist = Math.max(64, bvecDistance(self.origin, ent.origin));
      const score = (value * 1024) / dist;
      if (score > bestScore) {
        bestScore = score;
        best = ent;
      }
    }
    return best;
  }

  private roamGoal(world: BotWorldT, now: number): BotVec3 | null {
    const nav = world.nav();
    if (nav === null || nav.nodeCount === 0) return this.blindRoamGoal(world, now);
    const self = world.self();
    if (this.roamPoint !== null && bvecDistance(self.origin, this.roamPoint) > 64 && this.pathState.path !== null) return this.roamPoint;

    for (let tries = 0; tries < 8; tries++) {
      const node = nav.nodes[randomIndex(this.config.rng, nav.nodeCount)];
      if (node === undefined) continue;
      if (bvecDistance(self.origin, node.origin) > ROAM_RADIUS) continue;
      this.roamPoint = node.origin;
      this.pathState.plannedAt = now - REPLAN_SECONDS; // force a fresh plan
      return this.roamPoint;
    }
    return this.roamPoint;
  }

  /**
   * Roaming on a map with no navigation at all. A bot with no goal presses no
   * movement key and stands on its spawn point for the whole match, which is
   * worse than walking into a wall: the wedge timer at least gets a bot that
   * is trying somewhere. The point is re-picked when it is reached, when it
   * expires, and whenever the goal is given up.
   */
  private blindRoamGoal(world: BotWorldT, now: number): BotVec3 | null {
    const self = world.self();
    if (this.roamPoint !== null && now < this.roamUntil && bvecDistance(self.origin, this.roamPoint) > 64) return this.roamPoint;

    const angle = (randomIndex(this.config.rng, 360) * Math.PI) / 180;
    const reach = BLIND_ROAM_RADIUS / 2 + randomIndex(this.config.rng, BLIND_ROAM_RADIUS / 2);
    this.roamPoint = { x: self.origin.x + Math.cos(angle) * reach, y: self.origin.y + Math.sin(angle) * reach, z: self.origin.z };
    this.roamUntil = now + BLIND_ROAM_SECONDS;
    return this.roamPoint;
  }

  /** How long the goal just given up on is left alone. */
  private unreachableRest(): number {
    return this.goalIsLive ? UNREACHABLE_LIVE_SECONDS : UNREACHABLE_SECONDS;
  }

  private abandonGoal(): void {
    clearPath(this.pathState);
    this.roamPoint = null;
    this.roamUntil = 0;
    this.goalPoint = null;
    this.goalEntityId = -1;
    if (this.explicitGoal !== null) this.explicitGoalFailed = true;
  }

  private reachGoal(): void {
    clearPath(this.pathState);
    this.stuckTrips = 0;
    this.pressUntil = 0;
    this.roamPoint = null;
    this.roamUntil = 0;
    if (this.explicitGoal !== null) this.explicitGoalDone = true;
  }

  //--------------------------------------------------------------------------

  /**
   * What this bot is willing to walk through. The `avoid` predicate is where
   * hazards get refused: a nav node standing in lava or slime is a node the
   * mapper connected for a monster that does not care, and a bot that paths
   * through one dies within seconds. The contents lookup is memoised per
   * plan because A* visits the same node many times.
   */
  private traverseCaps(world: BotWorldT): NavTraverseCapsT {
    const caps = defaultTraverseCaps();
    caps.jump = !this.settings.movement.walkOnly || this.settings.movement.allowJumpingInCombat;

    const hazard = new Map<number, boolean>();
    caps.avoid = (node): boolean => {
      const cached = hazard.get(node.index);
      if (cached !== undefined) return cached;
      const contents = world.pointContents({ x: node.origin.x, y: node.origin.y, z: node.origin.z + 8 });
      const bad = contents === BotContents.Lava || contents === BotContents.Slime;
      hazard.set(node.index, bad);
      return bad;
    };
    // The mapper's own links are trusted even where their straight line
    // clips a pit (ctf6's rim links do): refusing them isolated whole spawn
    // platforms and two bots never moved for a match. The corner cut that
    // walks a bot into lava is string pulling's, and ensurePath's visibility
    // test is where it is refused (P17).
    return caps;
  }

  private ensurePath(world: BotWorldT, goal: BotVec3, now: number): void {
    const self = world.self();
    const nav = world.nav();
    if (nav === null) {
      clearPath(this.pathState);
      return;
    }

    const stale = this.pathState.path === null || now - this.pathState.plannedAt > REPLAN_SECONDS;
    if (!stale) {
      // A followed entity that has walked away from the path's end needs a
      // fresh plan even before the timer runs out.
      const points = this.pathState.path?.points;
      const end = points === undefined ? undefined : points[points.length - 1];
      if (end === undefined || bvecDistance(end, goal) < 96) return;
    }

    // The corner-cut test sweeps the bot's own body, not a line: a line at
    // chest height passes through a railing gap, over a knee-high wall and
    // across a pit a player cannot, and every such cut became a segment the
    // bot then pushed at for the rest of the level (ctf1's base yards). The
    // box is the player's, so the engine's clip hull is the player's own.
    const visible = (from: BotVec3, to: BotVec3): boolean => {
      const t = world.traceBox(from, PATH_BODY_MINS, PATH_BODY_MAXS, to);
      if (t.fraction < 1 || t.startsolid) return false;
      // P17: a clear body sweep still crosses a pit; a pulled segment with
      // lava under it is one the bot would walk straight into.
      return !this.hazardUnderSegment(world, from, to);
    };
    const path = nav.planPath(self.origin, goal, { caps: this.traverseCaps(world), visible, startAbove: PLAN_START_ABOVE });
    setPath(this.pathState, path, self.origin, now);
    if (path === null) this.pathState.plannedAt = now;
  }

  //--------------------------------------------------------------------------

  private aimPointFor(target: BotEntityT, from: BotVec3): BotVec3 {
    const weapon = this.config.knowledge.weaponByNumber(this.lastWeaponNumber);
    const point = weapon?.aimPoint ?? "center";
    if (point === "head") return target.head;
    if (point === "feet") return target.feet;
    if (point === "best") {
      // "let the bot choose the aim point based on skill level, dist to
      // target, type of weapon". An explosive weapon is worth aiming at the
      // feet of a target on the same level; everything else takes centre
      // mass, and only the hardest skills go for the head.
      if (weapon !== undefined && weapon.flags.includes("explosive") && Math.abs(target.origin.z - from.z) < 32) return target.feet;
      const names = this.config.knowledge.skillNames();
      const rank = names.indexOf(this.settings.skill);
      if (rank >= names.length - 2) return target.head;
    }
    return target.center;
  }

  private selectWeapon(self: ReturnType<BotWorldT["self"]>, target: BotEntityT): number | null {
    const pick = chooseWeapon(this.config.knowledge.weapons, {
      items: self.items,
      ammo: self.ammo,
      range: bvecDistance(self.origin, target.origin),
      heightDelta: target.origin.z - self.origin.z,
      inWater: self.waterLevel >= 2,
      hasProtection: self.hasProtection,
      targetInWater: target.waterLevel >= 2,
      allowMelee: this.settings.behaviors.allowMelee,
    });
    return pick === null ? null : pick.number;
  }

  //--------------------------------------------------------------------------

  private shouldCheckSix(now: number): boolean {
    if (!this.settings.behaviors.allowCheckSix) return false;
    if (now < this.checkSixUntil) return true;
    if (now < this.checkSixNextAt) return false;
    // Roll roughly every few seconds; the window itself is short.
    this.checkSixNextAt = now + randomRange(this.config.rng, 3, 8);
    if (!randomChance(this.config.rng, 35)) return false;
    this.checkSixUntil = now + 0.5;
    // Captured ONCE, here. Recomputing "180 degrees from where I am facing"
    // on every frame of the window makes the ideal angle run away from the
    // tracker exactly as fast as the tracker turns, so the bot pirouettes at
    // several hundred degrees a second for the whole window instead of
    // looking behind itself -- and a pirouette is a bot that is not steering.
    return true;
  }

  private wantsUse(world: BotWorldT, entities: readonly BotEntityT[], origin: BotVec3): boolean {
    const knowledge = this.config.knowledge;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Interactable) continue;
      if (bvecDistance(origin, ent.center) > 96) continue;
      const how = knowledge.interactionFor(ent.classname, ent);
      if (how === "use" || how === "push") return true;
    }
    return false;
  }
}
