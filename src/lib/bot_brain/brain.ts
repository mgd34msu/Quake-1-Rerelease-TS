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
import { angleMod, bvec, bvecAdd, bvecDistance, bvecSub, type BotVec3 } from "./math";
import { BotGameType, ITEM_FLAG, chooseWeapon, itemValue, type BotGameModeT, type BotKnowledge, type BotWeaponT } from "./knowledge";
import { defaultTraverseCaps, type NavPathT, type NavTraverseCapsT } from "./nav_graph";
import { BOT_RUN_SPEED, BotPathStatus, clearPath, followPath, newPathState, rollCombatJump, setPath, steerDirect, type BotPathStateT } from "./path_follow";
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
  /** Which way that sidestep goes, +1 right or -1 left. */
  private unstickSide = 0;
  private explicitGoal: ExplicitGoalT | null = null;
  private explicitGoalDone = false;
  private explicitGoalFailed = false;

  /** Where the bot was when the wedge timer last reset, and when that was. */
  private wedgeOrigin: BotVec3 | null = null;
  private wedgeSince = -1;

  /** Where each objective was standing the first time this level showed it. */
  private readonly objectiveHome = new Map<number, BotVec3>();
  private ownObjectiveHome: BotVec3 | null = null;
  private enemyObjectiveHome: BotVec3 | null = null;
  /** "attack" or "defend" in a game with objectives; "" everywhere else. */
  private objectiveRole = "";
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
    this.roamPoint = null;
    this.roamUntil = 0;
    this.deadSince = -1;
    this.lastWeaponNumber = 0;
    this.lastCmd = emptyUsercmd();
    this.wedgeOrigin = null;
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
    const target = this.selectTarget(entities, self.team);
    this.targetId = target === null ? -1 : target.id;

    // Pressing into geometry without moving, whether or not there is a path
    // to blame. See the file header.
    const wedged = this.updateWedge(self.origin, now);

    //---- 3: goal ------------------------------------------------------------
    const goal = this.selectGoal(world, entities, target, now);

    //---- 4/5: movement ------------------------------------------------------
    let moveTarget: BotVec3 | null = null;
    if (goal !== null) {
      this.ensurePath(world, goal, now);

      // A goal with a nav graph in the level and no plan to it is one this
      // bot cannot walk to. Remembered, so the next frame picks something
      // else instead of steering straight at the wall in front of it -- see
      // the file header.
      if (this.pathState.path === null && world.nav() !== null && this.goalEntityId >= 0) {
        this.unreachableUntil.set(this.goalEntityId, now + this.unreachableRest());
        this.abandonGoal();
      }

      const follow = followPath(
        this.pathState,
        { origin: self.origin, pitch: this.aim.pitch, yaw: this.aim.yaw, onGround: self.onGround, now, stuckTime: STUCK_SECONDS, runSpeed: this.config.runSpeed, walkSpeed: this.config.walkSpeed },
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
        this.unstickSide = randomChance(this.config.rng, 50) ? 1 : -1;
        if (this.stuckTrips >= STUCK_GIVE_UP) {
          // Three trips in a row with no progress: this is not a route the
          // bot can actually walk, whatever the graph says. The goal gets the
          // same rest an unplannable one gets, so the next frame picks
          // something else instead of re-planning into the same wall.
          if (this.goalEntityId >= 0) this.unreachableUntil.set(this.goalEntityId, now + this.unreachableRest());
          this.abandonGoal();
          this.stuckTrips = 0;
        } else {
          clearPath(this.pathState);
        }
      } else if (follow.status === BotPathStatus.Arrived) {
        this.reachGoal();
      } else if (follow.status === BotPathStatus.Moving) {
        this.stuckTrips = 0; // real progress retires the tally
        cmd.forwardmove = follow.forwardmove;
        cmd.sidemove = follow.sidemove;
        if (follow.jump) cmd.buttons |= BOT_BUTTON_JUMP;
        moveTarget = follow.target;
      } else if (follow.status === BotPathStatus.NoPath) {
        // No graph, or none needed: walk straight at it.
        const direct = steerDirect(self.origin, this.aim.yaw, goal, this.settings.movement.walkOnly, this.config.runSpeed, this.config.walkSpeed);
        cmd.forwardmove = direct.forwardmove;
        cmd.sidemove = direct.sidemove;
        moveTarget = goal;
        if (bvecDistance(self.origin, goal) < 48) this.reachGoal();
      }
    }

    if (target !== null && rollCombatJump(this.pathState, this.settings.movement, this.config.rng, now, self.onGround)) {
      cmd.buttons |= BOT_BUTTON_JUMP;
    }

    if (wedged) {
      if (this.unstickUntil <= now) {
        this.unstickUntil = now + UNSTICK_SECONDS;
        this.unstickSide = randomChance(this.config.rng, 50) ? 1 : -1;
        clearPath(this.pathState);
      }
      if (now - this.wedgeSince >= WEDGED_GIVE_UP_SECONDS) {
        if (this.goalEntityId >= 0) this.unreachableUntil.set(this.goalEntityId, now + this.unreachableRest());
        this.abandonGoal();
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

    //---- 6: aim -------------------------------------------------------------
    let aimAt: BotVec3 | null = null;
    if (target !== null) {
      const aw = this.awareness.get(target.id);
      const point = this.aimPointFor(target, self.origin);
      const lead = aimLeadPoint(point, target.velocity, this.settings.aiming);
      aimAt = bvecSub(lead, self.eye);
      if (aw !== undefined && aw.lastSeen < now) aimAt = bvecSub(aw.lastKnownOrigin, self.eye);
    } else if (this.shouldCheckSix(now)) {
      const { forward } = { forward: bvec(Math.cos(((this.aim.yaw + 180) * Math.PI) / 180), Math.sin(((this.aim.yaw + 180) * Math.PI) / 180), 0) };
      aimAt = forward;
    } else if (moveTarget !== null) {
      aimAt = bvecSub(moveTarget, self.origin);
      aimAt.z = 0;
    }

    if (aimAt !== null) aimStep(this.aim, aimAt, this.settings.aiming, dt, now);
    cmd.viewAngles = bvec(this.aim.pitch, angleMod(this.aim.yaw), 0);

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

  private selectTarget(entities: readonly BotEntityT[], team: number): BotEntityT | null {
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

      // Prefer whatever is closest and already lined up; a player outranks a
      // monster of the same distance because a player shoots back.
      let score = 4096 - bvecDistance(aw.lastKnownOrigin, aw.lastKnownOrigin);
      score -= bvecDistance(ent.center, ent.origin);
      if (ent.kind === BotEntityKind.Player) score += 512;
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
    return type === BotGameType.TeamDeathmatch || type === BotGameType.Ctf || type === BotGameType.Coop;
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
   */
  private updateWedge(origin: BotVec3, now: number): boolean {
    const cmd = this.lastCmd;
    const pressing = cmd.forwardmove !== 0 || cmd.sidemove !== 0;
    if (this.wedgeOrigin === null || !pressing || bvecDistance(origin, this.wedgeOrigin) > WEDGED_DISPLACEMENT) {
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
  private objectiveGoal(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, target: BotEntityT | null): BotVec3 | null {
    if (this.ownObjectiveHome === null && this.enemyObjectiveHome === null) return null;
    const knowledge = this.config.knowledge;

    // Carrying the enemy's: nothing else matters until it is home.
    if (self.carryingObjective === true && this.ownObjectiveHome !== null) {
      this.emitChatOnce("ctf_delivering_flag");
      this.goalEntityId = -1;
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

    if (this.objectiveRole === "defend") {
      if (target !== null) return null; // an enemy in the base outranks the base
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
    // Somebody is carrying it: their base is where it has to come back to.
    if (this.enemyObjectiveHome === null) return null;
    this.goalEntityId = -1;
    return this.enemyObjectiveHome;
  }

  /** In coop, the human the bot regroups with. See COOP_REGROUP_SECONDS. */
  private coopRegroupGoal(entities: readonly BotEntityT[], self: ReturnType<BotWorldT["self"]>, now: number): BotVec3 | null {
    if (this.config.gameMode.gameType !== BotGameType.Coop) return null;
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
    if (this.config.gameMode.gameType !== BotGameType.Coop) return null;

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
    const objective = this.objectiveGoal(entities, self, target);
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

    const visible = (from: BotVec3, to: BotVec3): boolean => world.traceLine(bvecAdd(from, bvec(0, 0, 16)), bvecAdd(to, bvec(0, 0, 16))).fraction >= 1;
    const path = nav.planPath(self.origin, goal, { caps: this.traverseCaps(world), visible });
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
    return true;
  }

  private wantsUse(world: BotWorldT, entities: readonly BotEntityT[], origin: BotVec3): boolean {
    const knowledge = this.config.knowledge;
    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Interactable) continue;
      if (bvecDistance(origin, ent.origin) > 96) continue;
      const how = knowledge.interactionFor(ent.classname, ent);
      if (how === "use" || how === "push") return true;
    }
    return false;
  }
}
