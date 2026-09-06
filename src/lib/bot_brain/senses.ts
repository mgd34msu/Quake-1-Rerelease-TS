// The senses model: settings_PC.txt's `senses.*` and `weapons.*` blocks.
//
// A bot does not know about an enemy the instant it becomes visible. Each
// enemy carries an AWARENESS level in [0, 1] that fills while the enemy is
// seen or heard and drains while it is not, at rates the skill sets:
//
//   senses.sight_time        seconds to go from 0 to full on a visible enemy
//   senses.sight_decay_time  seconds to fall back to 0 on one that is not
//   senses.sound_time        the same, for an enemy that is audible
//   senses.sound_decay_time  the same, draining
//
// So awareness moves by dt/sight_time per frame while filling, dt/decay_time
// while draining -- the shipped values (0.3s to fill, 0.125s to drain on
// practice; 0.05s to fill, 0.5s to drain on nightmare) read directly as
// those rates and produce exactly the intended feel: a practice bot is slow
// to notice you and forgets almost immediately, a nightmare bot notices you
// in one frame and holds on.
//
// Two more timers sit on top of the level:
//
//   senses.forget_non_vis_enemy_time  how long a remembered enemy survives
//                                     with no fresh contact at all
//   senses.sound_persist_time         how long one sound event stays in
//                                     memory as "audible" for the fill rate
//
// And two modifiers for an invisible enemy: `invis_enemy_sight_scalar`
// multiplies the fill time (so it takes that many times longer to notice
// one), and `max_invis_enemy_sight_dist` is a hard cutoff beyond which an
// invisible enemy simply cannot be seen.
//
// `senses.fov_angle` gates sight: an enemy outside the cone is not visible
// no matter how clear the line is. `weapons.fov_angle` is a second, much
// tighter cone (10 to 50 degrees) that gates FIRING, with its own
// `weapons.sight_time` fill and `weapons.decay_time` drain, which is why a
// bot swings onto a target before it starts shooting.

import type { BotSensesSettings, BotWeaponSenseSettings } from "../botdata";
import { angleBetween, bvecDistance, bvecSub, clamp, type BotVec3 } from "./math";

export interface BotAwarenessT {
  /** The entity this awareness is about. */
  id: number;
  /** [0, 1]: how sure the bot is that this enemy is there right now. */
  sight: number;
  /** [0, 1]: the weapon-cone tracker, which gates the trigger. */
  weapon: number;
  /** Server time of the last confirmed contact of any kind. */
  lastContact: number;
  /** Server time of the last time the enemy was actually visible. */
  lastSeen: number;
  /** Server time of the last sound heard from this enemy. */
  lastHeard: number;
  /** Where the bot last knew this enemy to be. */
  lastKnownOrigin: BotVec3;
}

export function newAwareness(id: number, now: number, origin: BotVec3): BotAwarenessT {
  return { id, sight: 0, weapon: 0, lastContact: now, lastSeen: -1, lastHeard: -1, lastKnownOrigin: { x: origin.x, y: origin.y, z: origin.z } };
}

/** What a frame's contact with one enemy looked like. */
export interface BotContactT {
  /** True when a trace from the bot's eye to the enemy came back clear. */
  lineOfSight: boolean;
  /** True when the enemy also fell inside `senses.fov_angle`. */
  inSightFov: boolean;
  /** True when the enemy fell inside the tighter `weapons.fov_angle`. */
  inWeaponFov: boolean;
  /** True when the enemy made a noise inside `senses.sound_range` recently enough to still persist. */
  audible: boolean;
  invisible: boolean;
  distance: number;
  origin: BotVec3;
}

/** Whether an enemy is inside the sight cone and, if invisible, close enough to register at all. */
export function evaluateSightGeometry(
  eye: BotVec3,
  pitch: number,
  yaw: number,
  target: BotVec3,
  invisible: boolean,
  senses: BotSensesSettings,
  weapons: BotWeaponSenseSettings,
): { inSightFov: boolean; inWeaponFov: boolean; distance: number; withinInvisRange: boolean } {
  const dir = bvecSub(target, eye);
  const distance = bvecDistance(target, eye);
  const angle = angleBetween(pitch, yaw, dir);
  return {
    // fov_angle is the full cone width, so half of it is the limit either side.
    inSightFov: angle <= senses.fovAngle / 2,
    inWeaponFov: angle <= weapons.fovAngle / 2,
    distance,
    withinInvisRange: !invisible || senses.maxInvisEnemySightDist <= 0 || distance <= senses.maxInvisEnemySightDist,
  };
}

/**
 * Advances one enemy's awareness by a frame. Returns the record so a caller
 * can chain; it is mutated in place.
 */
export function senseStep(aw: BotAwarenessT, contact: BotContactT, senses: BotSensesSettings, weapons: BotWeaponSenseSettings, dt: number, now: number): BotAwarenessT {
  const visible = contact.lineOfSight && contact.inSightFov;

  // sight: fill while visible, drain otherwise. An invisible enemy takes
  // invis_enemy_sight_scalar times as long to register.
  let fillTime = senses.sightTime;
  if (contact.invisible && senses.invisEnemySightScalar > 0) fillTime *= senses.invisEnemySightScalar;

  if (visible) {
    aw.sight = fillTime > 0 ? clamp(aw.sight + dt / fillTime, 0, 1) : 1;
    aw.lastSeen = now;
    aw.lastContact = now;
    aw.lastKnownOrigin = { x: contact.origin.x, y: contact.origin.y, z: contact.origin.z };
  } else if (contact.audible) {
    // A heard enemy fills more slowly and never quite as far as a seen one;
    // sound_time is the fill rate, and the bot knows roughly where, not
    // exactly where.
    aw.sight = senses.soundTime > 0 ? clamp(aw.sight + dt / senses.soundTime, 0, 1) : 1;
    aw.lastHeard = now;
    aw.lastContact = now;
    aw.lastKnownOrigin = { x: contact.origin.x, y: contact.origin.y, z: contact.origin.z };
  } else {
    const decay = aw.lastSeen >= aw.lastHeard ? senses.sightDecayTime : senses.soundDecayTime;
    aw.sight = decay > 0 ? clamp(aw.sight - dt / decay, 0, 1) : 0;
  }

  // The weapon cone runs its own, tighter tracker.
  if (contact.lineOfSight && contact.inWeaponFov) {
    aw.weapon = weapons.sightTime > 0 ? clamp(aw.weapon + dt / weapons.sightTime, 0, 1) : 1;
  } else {
    aw.weapon = weapons.decayTime > 0 ? clamp(aw.weapon - dt / weapons.decayTime, 0, 1) : 0;
  }

  return aw;
}

/** True once the bot is sure enough of an enemy to act on it. */
export function isAware(aw: BotAwarenessT): boolean {
  return aw.sight >= 1;
}

/** True once the weapon cone has settled enough to pull the trigger. */
export function canFire(aw: BotAwarenessT): boolean {
  return aw.weapon >= 1;
}

/**
 * True when the bot should drop this enemy from memory entirely:
 * `forget_non_vis_enemy_time` has passed since the last contact of any kind
 * and awareness has drained away.
 */
export function shouldForget(aw: BotAwarenessT, senses: BotSensesSettings, now: number): boolean {
  if (aw.sight > 0) return false;
  return now - aw.lastContact >= senses.forgetNonVisEnemyTime;
}

/**
 * Whether a sound event is still in memory and close enough to hear.
 * `sound_persist_time` is how long one event lingers; `sound_range` is how
 * far a bot of this skill can hear at all, scaled by the sound's loudness.
 */
export function soundAudible(sound: { origin: BotVec3; time: number; loudness: number }, listener: BotVec3, senses: BotSensesSettings, now: number): boolean {
  if (now - sound.time > senses.soundPersistTime) return false;
  const range = senses.soundRange * (sound.loudness > 0 ? sound.loudness : 1);
  return bvecDistance(sound.origin, listener) <= range;
}
