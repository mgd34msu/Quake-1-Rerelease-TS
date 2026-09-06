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
// Determinism: every random decision goes through the injected
// `BotRandomT`. Two brains with the same seed, fed the same worlds, emit
// the same usercmds.

import type { BotSkillSettings, CharacterEntry } from "../botdata";
import { aimError, aimLeadPoint, aimStep, newAimState, type BotAimStateT } from "./aim";
import { angleMod, bvec, bvecAdd, bvecDistance, bvecSub, type BotVec3 } from "./math";
import { BotGameType, chooseWeapon, itemValue, type BotGameModeT, type BotKnowledge, type BotWeaponT } from "./knowledge";
import { defaultTraverseCaps, type NavPathT, type NavTraverseCapsT } from "./nav_graph";
import { BotPathStatus, clearPath, followPath, newPathState, rollCombatJump, setPath, steerDirect, type BotPathStateT } from "./path_follow";
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

const STUCK_SECONDS = 1.0;
const REPLAN_SECONDS = 2.0;
/** Give up on a goal after this many consecutive stuck trips. */
const STUCK_GIVE_UP = 3;
/** How far a roaming bot is willing to be sent. */
const ROAM_RADIUS = 4096;

export class BotBrain {
  readonly config: BotBrainConfigT;
  readonly settings: BotSkillSettings;

  private readonly aim: BotAimStateT = newAimState();
  private readonly pathState: BotPathStateT = newPathState();
  private readonly awareness = new Map<number, BotAwarenessT>();

  private targetId = -1;
  private goalPoint: BotVec3 | null = null;
  private explicitGoal: ExplicitGoalT | null = null;
  private explicitGoalDone = false;
  private explicitGoalFailed = false;

  private checkSixUntil = 0;
  private checkSixNextAt = 0;
  private roamPoint: BotVec3 | null = null;
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
    this.roamPoint = null;
    this.deadSince = -1;
    this.lastWeaponNumber = 0;
    this.lastCmd = emptyUsercmd();
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
    const target = this.selectTarget(entities, self.team);
    this.targetId = target === null ? -1 : target.id;

    //---- 3: goal ------------------------------------------------------------
    const goal = this.selectGoal(world, entities, target, now);

    //---- 4/5: movement ------------------------------------------------------
    let moveTarget: BotVec3 | null = null;
    if (goal !== null) {
      this.ensurePath(world, goal, now);
      const follow = followPath(this.pathState, { origin: self.origin, pitch: this.aim.pitch, yaw: this.aim.yaw, onGround: self.onGround, now, stuckTime: STUCK_SECONDS }, this.settings.movement, this.config.rng);

      if (follow.status === BotPathStatus.Stuck) {
        if (this.pathState.stuckCount >= STUCK_GIVE_UP) {
          this.abandonGoal();
        } else {
          clearPath(this.pathState);
        }
      } else if (follow.status === BotPathStatus.Arrived) {
        this.reachGoal();
      } else if (follow.status === BotPathStatus.Moving) {
        cmd.forwardmove = follow.forwardmove;
        cmd.sidemove = follow.sidemove;
        if (follow.jump) cmd.buttons |= BOT_BUTTON_JUMP;
        moveTarget = follow.target;
      } else if (follow.status === BotPathStatus.NoPath) {
        // No graph, or none needed: walk straight at it.
        const direct = steerDirect(self.origin, this.aim.yaw, goal, this.settings.movement.walkOnly);
        cmd.forwardmove = direct.forwardmove;
        cmd.sidemove = direct.sidemove;
        moveTarget = goal;
        if (bvecDistance(self.origin, goal) < 48) this.reachGoal();
      }
    }

    if (target !== null && rollCombatJump(this.pathState, this.settings.movement, this.config.rng, now, self.onGround)) {
      cmd.buttons |= BOT_BUTTON_JUMP;
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

  private selectGoal(world: BotWorldT, entities: readonly BotEntityT[], target: BotEntityT | null, now: number): BotVec3 | null {
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

    const inCombat = target !== null;

    if (inCombat) {
      const aw = this.awareness.get(target.id);
      this.goalPoint = aw !== undefined ? aw.lastKnownOrigin : target.origin;
      // In combat the bot may still detour for an item, if the skill allows.
      if (this.settings.behaviors.allowGrabItemsInCombat) {
        const item = this.bestItem(world, entities);
        if (item !== null && bvecDistance(world.self().origin, item.origin) < 512) return item.origin;
      }
      return this.goalPoint;
    }

    if (this.settings.behaviors.allowGrabItems) {
      const item = this.bestItem(world, entities);
      if (item !== null) {
        this.goalPoint = item.origin;
        return this.goalPoint;
      }
    }

    return this.roamGoal(world, now);
  }

  private bestItem(world: BotWorldT, entities: readonly BotEntityT[]): BotEntityT | null {
    const self = world.self();
    const knowledge = this.config.knowledge;
    const deferPower = this.settings.behaviors.deferPowerItemsToHumans && (this.config.humanTeammateNear?.() ?? false);

    let best: BotEntityT | null = null;
    let bestScore = 0;

    for (const ent of entities) {
      if (ent.kind !== BotEntityKind.Item) continue;
      const item = knowledge.item(ent.classname);
      if (item === undefined) continue;
      if ((item.isPowerup || item.isMega) && deferPower) continue;

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
    if (nav === null || nav.nodeCount === 0) {
      this.roamPoint = null;
      return null;
    }
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

  private abandonGoal(): void {
    clearPath(this.pathState);
    this.roamPoint = null;
    this.goalPoint = null;
    if (this.explicitGoal !== null) this.explicitGoalFailed = true;
  }

  private reachGoal(): void {
    clearPath(this.pathState);
    this.roamPoint = null;
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
      hasProtection: false,
      targetInWater: false,
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
