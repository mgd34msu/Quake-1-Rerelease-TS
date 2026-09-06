// The seam between the brain and whatever game it is thinking for.
//
// ARCHITECTURE.md's "Bots and navigation" ruling: the brain is a
// game-agnostic module so it can be fed back into quake-2-re-ts, which has a
// nav loader and a game-side adapter but no decision-making. Everything the
// brain is allowed to know about the world arrives through `BotWorldT`, and
// everything it decides leaves as one `BotUsercmdT` per frame. Quake 1 binds
// it in src/bots/bot_world.ts; a Quake II binding would implement the same
// interface over its own edicts and nothing in this directory would change.
//
// The interface deliberately speaks in the vocabulary of the shipped
// bots/*.txt knowledge files (item flags, weapon numbers, monster
// classnames) rather than in either game's engine types, because those files
// are the design the bots were tuned against.

import type { BotVec3 } from "./math";
import type { NavGraph } from "./nav_graph";

//============================================================================
// what the brain can see

export const BotEntityKind = {
  Player: 0,
  Monster: 1,
  Item: 2,
  Interactable: 3,
} as const;
export type BotEntityKindT = number;

export interface BotEntityT {
  /** Stable for as long as the entity lives; the brain uses it to remember targets across frames. */
  id: number;
  kind: BotEntityKindT;
  /** The game's own classname, which is the key every bots/*.txt file is written against. */
  classname: string;
  origin: BotVec3;
  /** The point a weapon should be aimed at for a "center" aim point. */
  center: BotVec3;
  /** The top of the bounding box, for a "head" aim point. */
  head: BotVec3;
  /** The bottom of the bounding box, for a "feet" aim point. */
  feet: BotVec3;
  velocity: BotVec3;
  health: number;
  /** Zero when the entity has no team. */
  team: number;
  /** True for a player or monster that is out of the fight. */
  dead: boolean;
  /** True while the entity is invisible (Ring of Shadows, or the game's equivalent). */
  invisible: boolean;
  /** Set on a bot-controlled player so bots can tell each other apart from humans. */
  isBot: boolean;
  /** The entity's spawnflags, which items.txt and interactables.txt both test. */
  spawnflags: number;
  /** Non-zero when the entity has health the bot could shoot off (interactables.txt's `health` condition). */
  hasHealth: boolean;
  /** True when the entity carries a targetname (interactables.txt's `targetname` condition). */
  hasTargetname: boolean;
}

/** One noise the bot could have heard this frame. */
export interface BotSoundT {
  origin: BotVec3;
  /** The entity that made it, when the game knows; -1 otherwise. */
  sourceId: number;
  /** Server time the sound was made. */
  time: number;
  /** Louder sounds carry further; the brain scales senses.sound_range by this. */
  loudness: number;
}

//============================================================================
// the bot's own state

export interface BotSelfT {
  id: number;
  origin: BotVec3;
  velocity: BotVec3;
  /** (pitch, yaw, roll) in degrees, Quake's convention. */
  viewAngles: BotVec3;
  /** Eye position -- origin plus the game's view offset. */
  eye: BotVec3;
  health: number;
  armor: number;
  /** The QuakeC `items` bitmask, which weapons.txt's `number` field indexes into. */
  items: number;
  /** Keyed by weapons.txt's `ammo_name` ("ammo_shells", "ammo_nails", ...). */
  ammo: Readonly<Record<string, number>>;
  /** The QuakeC `weapon` field: the bit of `items` for the weapon in hand. */
  currentWeapon: number;
  onGround: boolean;
  /** 0 dry, 1 feet wet, 2 waist, 3 fully submerged -- the QuakeC waterlevel. */
  waterLevel: number;
  team: number;
  dead: boolean;
}

//============================================================================
// traces

export interface BotTraceT {
  /** 1 when nothing was hit. */
  fraction: number;
  endpos: BotVec3;
  /** True when the trace started inside a solid. */
  startsolid: boolean;
  /** The entity that was hit, when the trace hit one of the entities of interest. */
  hitId: number;
}

/** Point-contents answers the brain needs; the binding maps its own numbering onto these. */
export const BotContents = {
  Empty: 0,
  Solid: 1,
  Water: 2,
  Slime: 3,
  Lava: 4,
  Sky: 5,
} as const;
export type BotContentsT = number;

//============================================================================
// what the brain produces

export interface BotUsercmdT {
  forwardmove: number;
  sidemove: number;
  upmove: number;
  /** Bit 0 is attack, bit 1 is jump, bit 2 is use -- the QuakeC button0/button2/button1 order. */
  buttons: number;
  /** 0 for none; otherwise the impulse to send this frame (weapon selection). */
  impulse: number;
  /** (pitch, yaw, roll) in degrees. */
  viewAngles: BotVec3;
}

export const BOT_BUTTON_ATTACK = 1;
export const BOT_BUTTON_JUMP = 2;
export const BOT_BUTTON_USE = 4;

export function emptyUsercmd(): BotUsercmdT {
  return { forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0, impulse: 0, viewAngles: { x: 0, y: 0, z: 0 } };
}

//============================================================================

/**
 * The world as the brain is allowed to see it. Every method is a query the
 * game answers from its own state; the brain caches nothing across frames
 * except what it explicitly remembers (targets, paths, awareness levels).
 */
export interface BotWorldT {
  /** Server time in seconds. */
  time(): number;
  /** The length of the frame about to be simulated, in seconds. */
  frameTime(): number;

  /** This bot's own state, re-read every frame. */
  self(): BotSelfT;

  /** A point trace against the world and against solid entities. */
  traceLine(start: BotVec3, end: BotVec3): BotTraceT;
  /** A box trace, for "can I actually walk from here to there". */
  traceBox(start: BotVec3, mins: BotVec3, maxs: BotVec3, end: BotVec3): BotTraceT;
  /** What kind of medium a point is in. */
  pointContents(p: BotVec3): BotContentsT;

  /**
   * Everything within reach that the brain might act on this frame: other
   * players, monsters, pickups on the ground, and the buttons/plats/doors
   * interactables.txt describes. The binding is free to cull; the brain
   * treats what it gets as the whole world.
   */
  entities(): readonly BotEntityT[];

  /** The noises made since the last call, oldest first. */
  hearing(): readonly BotSoundT[];

  /** The navigation graph for this map, or null when the map has none. */
  nav(): NavGraph | null;
}
