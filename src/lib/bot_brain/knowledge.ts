// The shipped bots/*.txt knowledge files, compiled into the lookups the
// brain actually asks questions of.
//
// src/lib/botdata.ts parses those files into faithful records of what is on
// disk. This module turns them into indexes (classname -> item, weapon
// number -> weapon, skill name -> settings) and applies the selection rules
// the files themselves document in their own header comments. The rules
// below are quoted from the retail text, not invented:
//
//   weapons.txt, "For A Weapon To Be Considered, The Following Must Be
//   True": (1) the bot has the weapon in inventory, with enough ammo;
//   (2) the target is within the weapon's min/max range; (3) if min and/or
//   max height is defined, bot and enemy must be within that distance on Z;
//   (4) if the weapon is electric, the bot must not be in water; (5) of
//   everything that passes, the highest `priority` wins. A priority of 0
//   means "never choose this weapon".
//
//   game_rules.txt, "NOTE: the first cvar/value pair that matches will be
//   the game_type that's used", and "this will become TDM if the teamplay
//   cvar is 1".
//
//   teams.txt, "This translates non-zero based teams set in QuakeC, into 0
//   based team numbers internally", capped at four teams.
//
//   items.txt / monsters.txt / interactables.txt carry "|"-separated flag
//   lists whose vocabulary is listed in each file's own header; the flag
//   name sets below are those lists.

import {
  parseBotSettings,
  parseChats,
  parseCharacters,
  parseGameRules,
  parseInteractables,
  parseItems,
  parseMonsters,
  parseTeams,
  parseWeapons,
  type BotSkillSettings,
  type ChatEntry,
  type CharacterEntry,
  type GameRuleEntry,
  type InteractableEntry,
  type ItemEntry,
  type MonsterEntry,
  type TeamEntry,
  type WeaponEntry,
} from "../botdata";

//============================================================================
// flag vocabularies (each file's own header comment lists these)

export const ITEM_FLAG = {
  health: "health",
  ammo: "ammo",
  armor: "armor",
  weapon: "weapon",
  powerup: "powerup",
  dropped: "dropped",
  megaItem: "mega_item",
  backpack: "backpack",
  zapProof: "zap_proof",
  checkItems: "check_items",
  objective: "objective",
  rune: "rune",
} as const;

export const WEAPON_FLAG = {
  melee: "melee",
  hitscan: "hitscan",
  projectile: "projectile",
  parabolic: "parabolic",
  explosive: "explosive",
  sticky: "sticky",
  electric: "electric",
  starting: "starting",
  initial: "initial",
} as const;

export const MONSTER_FLAG = {
  melee: "melee",
  ranged: "ranged",
  aquatic: "aquatic",
  flyer: "flyer",
  tank: "tank",
  sponge: "sponge",
} as const;

export const INTERACTION = {
  push: "push",
  shoot: "shoot",
  use: "use",
  ride: "ride",
} as const;

//============================================================================
// the raw text of the nine files, as the game hands them over

export interface BotDataFilesT {
  characters: string;
  weapons: string;
  items: string;
  monsters: string;
  interactables: string;
  gameRules: string;
  teams: string;
  chats: string;
  settings: string;
}

//============================================================================

export interface BotWeaponT extends WeaponEntry {
  /** weapons.txt's flags, hoisted for the tests every frame does. */
  readonly isMelee: boolean;
  readonly isElectric: boolean;
  readonly needsAmmo: boolean;
}

export interface BotItemT extends ItemEntry {
  readonly isHealth: boolean;
  readonly isArmor: boolean;
  readonly isAmmo: boolean;
  readonly isWeapon: boolean;
  readonly isPowerup: boolean;
  /** True when the item is a "mega item" unconditionally, by its own flag list. */
  readonly isMega: boolean;
  /**
   * The spawnflag bit that turns this entity into a mega item, or 0 when it
   * has none. items.txt's `spawnflags 2 = mega_item` on item_health means
   * "this pickup is the Megahealth when its spawnflags carry bit 2", not
   * "every item_health is a mega item" -- so this is a per-entity test, and
   * `itemValue` takes the entity's own spawnflags to make it.
   */
  readonly megaSpawnflag: number;
}

export const BotGameType = {
  Deathmatch: "deathmatch",
  TeamDeathmatch: "tdm",
  Coop: "coop",
  Horde: "horde",
  Ctf: "ctf",
} as const;
export type BotGameTypeT = string;

export interface BotGameModeT {
  gameType: BotGameTypeT;
  weaponStay: boolean;
}

/**
 * Every bots/*.txt file, indexed. One instance is shared by every bot on a
 * server: it holds no per-bot state.
 */
export class BotKnowledge {
  readonly characters: CharacterEntry[] = [];
  readonly weapons: BotWeaponT[] = [];
  readonly items: BotItemT[] = [];
  readonly monsters: MonsterEntry[] = [];
  readonly interactables: InteractableEntry[] = [];
  readonly gameRules: GameRuleEntry[] = [];
  readonly teams: TeamEntry[] = [];
  readonly chats: ChatEntry[] = [];
  readonly skills: BotSkillSettings[] = [];
  /** Every parse error from every file, so a caller can log a malformed mod's data instead of guessing. */
  readonly errors: string[] = [];

  private readonly itemsByName = new Map<string, BotItemT>();
  private readonly monstersByClass = new Map<string, MonsterEntry>();
  private readonly interactablesByName = new Map<string, InteractableEntry[]>();
  private readonly skillsByName = new Map<string, BotSkillSettings>();
  private readonly weaponsByNumber = new Map<number, BotWeaponT>();

  constructor(files: BotDataFilesT) {
    const take = (label: string, errors: string[]): void => {
      for (const e of errors) this.errors.push(`${label}: ${e}`);
    };

    const chars = parseCharacters(files.characters);
    this.characters = chars.entries;
    take("characters.txt", chars.errors);

    const weapons = parseWeapons(files.weapons);
    take("weapons.txt", weapons.errors);
    for (const w of weapons.entries) {
      const flags = new Set(w.flags);
      const compiled: BotWeaponT = Object.assign(w, {
        isMelee: flags.has(WEAPON_FLAG.melee),
        isElectric: flags.has(WEAPON_FLAG.electric),
        needsAmmo: w.ammo !== "" && w.ammo !== "none",
      });
      this.weapons.push(compiled);
      this.weaponsByNumber.set(w.number, compiled);
    }

    const items = parseItems(files.items);
    take("items.txt", items.errors);
    for (const it of items.entries) {
      const flags = new Set(it.flags);
      const compiled: BotItemT = Object.assign(it, {
        isHealth: flags.has(ITEM_FLAG.health),
        isArmor: flags.has(ITEM_FLAG.armor),
        isAmmo: flags.has(ITEM_FLAG.ammo),
        isWeapon: flags.has(ITEM_FLAG.weapon),
        isPowerup: flags.has(ITEM_FLAG.powerup),
        isMega: flags.has(ITEM_FLAG.megaItem),
        megaSpawnflag: it.spawnflags.find((sf) => sf.name === ITEM_FLAG.megaItem)?.bit ?? 0,
      });
      this.items.push(compiled);
      this.itemsByName.set(it.name, compiled);
    }

    const monsters = parseMonsters(files.monsters);
    this.monsters = monsters.entries;
    take("monsters.txt", monsters.errors);
    for (const m of monsters.entries) this.monstersByClass.set(m.classname, m);

    const inter = parseInteractables(files.interactables);
    this.interactables = inter.entries;
    take("interactables.txt", inter.errors);
    for (const e of inter.entries) {
      const list = this.interactablesByName.get(e.name);
      if (list === undefined) this.interactablesByName.set(e.name, [e]);
      else list.push(e);
    }

    const rules = parseGameRules(files.gameRules);
    this.gameRules = rules.entries;
    take("game_rules.txt", rules.errors);

    const teams = parseTeams(files.teams);
    this.teams = teams.entries;
    take("teams.txt", teams.errors);

    const chats = parseChats(files.chats);
    this.chats = chats.entries;
    take("chats.txt", chats.errors);

    const settings = parseBotSettings(files.settings);
    this.skills = settings.skills;
    take("settings.txt", settings.errors);
    for (const s of settings.skills) this.skillsByName.set(s.skill, s);
  }

  //--------------------------------------------------------------------------

  skill(name: string): BotSkillSettings | undefined {
    return this.skillsByName.get(name);
  }

  /** The skill names in file order, which is the order they get harder. */
  skillNames(): string[] {
    return this.skills.map((s) => s.skill);
  }

  item(classname: string): BotItemT | undefined {
    return this.itemsByName.get(classname);
  }

  monster(classname: string): MonsterEntry | undefined {
    return this.monstersByClass.get(classname);
  }

  weaponByNumber(number: number): BotWeaponT | undefined {
    return this.weaponsByNumber.get(number);
  }

  character(name: string): CharacterEntry | undefined {
    const lower = name.toLowerCase();
    for (const c of this.characters) if (c.name.toLowerCase() === lower) return c;
    return undefined;
  }

  /** teams.txt's own translation of a QuakeC team value to a 0-based index, capped at four. */
  teamIndex(quakecTeamValue: number): number {
    for (let i = 0; i < this.teams.length && i < 4; i++) if (this.teams[i]!.value === quakecTeamValue) return i;
    return -1;
  }

  chatsOfType(type: string): ChatEntry[] {
    return this.chats.filter((c) => c.type === type);
  }

  //--------------------------------------------------------------------------

  /**
   * game_rules.txt's own rule: the first cvar/value pair that matches wins,
   * and a matching deathmatch becomes TDM when `teamplay` is 1.
   */
  gameMode(cvarValue: (name: string) => number): BotGameModeT {
    for (const rule of this.gameRules) {
      if (rule.cvar === "") continue;
      if (cvarValue(rule.cvar) !== rule.value) continue;
      let type: BotGameTypeT = rule.gameType;
      if (type === BotGameType.Deathmatch && cvarValue("teamplay") === 1) type = BotGameType.TeamDeathmatch;
      return { gameType: type, weaponStay: rule.weaponStay };
    }
    return { gameType: BotGameType.Deathmatch, weaponStay: false };
  }

  /**
   * How the bot can act on an entity, per interactables.txt. An entry's
   * conditions (spawnflags, health, targetname) are combined with its
   * `logic_op`; a `spawnflags` condition is a mask test, matching the file's
   * "the value the edicts spawnflags must have" wording, and the two boolean
   * conditions are presence tests.
   */
  interactionFor(classname: string, ent: { spawnflags: number; hasHealth: boolean; hasTargetname: boolean }): string | null {
    const entries = this.interactablesByName.get(classname);
    if (entries === undefined) return null;

    for (const entry of entries) {
      const conditions: boolean[] = [];
      if (entry.spawnflags !== undefined) conditions.push((ent.spawnflags & entry.spawnflags) === entry.spawnflags);
      if (entry.health !== undefined) conditions.push(entry.health === ent.hasHealth);
      if (entry.targetname !== undefined) conditions.push(entry.targetname === ent.hasTargetname);

      if (conditions.length === 0) return entry.interaction;
      const ok = entry.logicOp === "or" ? conditions.some((c) => c) : conditions.every((c) => c);
      if (ok) return entry.interaction;
    }
    return null;
  }
}

//============================================================================
// weapon choice

export interface BotWeaponPickT {
  weapon: BotWeaponT;
  /** The impulse the game should send to select it, when the binding maps weapon numbers to impulses. */
  number: number;
}

export interface BotWeaponContextT {
  items: number;
  ammo: Readonly<Record<string, number>>;
  /** Straight-line distance to the target. */
  range: number;
  /** target.z - bot.z; positive when the target is above. */
  heightDelta: number;
  /** True when the bot is standing in water. */
  inWater: boolean;
  /** True when the bot has the Pentagram, which weapons.txt's rule 4 exempts from the water ban. */
  hasProtection: boolean;
  /** True when the target is also in water, the other half of rule 4's exemption. */
  targetInWater: boolean;
  /** False turns off melee weapons entirely (behaviors.allow_melee). */
  allowMelee: boolean;
}

/**
 * weapons.txt's own five-step rule, in order. Returns null when nothing in
 * the bot's inventory is valid for this target, which is the caller's cue to
 * keep whatever is in hand.
 */
export function chooseWeapon(weapons: readonly BotWeaponT[], ctx: BotWeaponContextT): BotWeaponPickT | null {
  let best: BotWeaponT | null = null;

  for (const w of weapons) {
    if (w.priority <= 0) continue; // "0 = never choose this weapon"
    if (w.isMelee && !ctx.allowMelee) continue;

    // 1. in inventory, with enough ammo
    if ((ctx.items & w.number) === 0) continue;
    if (w.needsAmmo) {
      const have = ctx.ammo[w.ammoName] ?? 0;
      if (have < Math.max(1, w.minAmmo)) continue;
    }

    // 2. within the weapon's range band
    if (ctx.range < w.minRange) continue;
    if (w.maxRange > 0 && ctx.range > w.maxRange) continue;

    // 3. height window, "0 if don't care"
    if (w.maxHeight > 0 && ctx.heightDelta > w.maxHeight) continue;
    if (w.minHeight > 0 && -ctx.heightDelta > w.minHeight) continue;

    // 4. electric weapons are suicide in water, unless protected and the
    //    target is the one getting wet
    if (w.isElectric && ctx.inWater && !(ctx.hasProtection && ctx.targetInWater)) continue;

    // 5. highest priority wins
    if (best === null || w.priority > best.priority) best = w;
  }

  return best === null ? null : { weapon: best, number: best.number };
}

//============================================================================
// item choice

export interface BotItemContextT {
  /** The pickup entity's own spawnflags, for items.txt's "BIT = mega_item" test. */
  spawnflags: number;
  health: number;
  maxHealth: number;
  armor: number;
  items: number;
  ammo: Readonly<Record<string, number>>;
  /** game_rules.txt's weapon_stay for the current mode: a weapon already held is worthless without it. */
  weaponStay: boolean;
  allowPowerItems: boolean;
  /** The weapon table, for scoring a weapon pickup by what it would unlock. */
  weapons: readonly BotWeaponT[];
}

/**
 * How much this bot wants this item right now, in arbitrary units. Zero or
 * less means "walk past it". The ordering is what matters, not the scale:
 * a powerup outranks anything, a weapon the bot does not own outranks
 * health, and health scales with how hurt the bot is.
 */
export function itemValue(item: BotItemT, ctx: BotItemContextT): number {
  const mega = item.isMega || (item.megaSpawnflag !== 0 && (ctx.spawnflags & item.megaSpawnflag) === item.megaSpawnflag);
  if (item.isPowerup || mega) {
    if (!ctx.allowPowerItems) return 0;
    return item.isPowerup ? 1000 : 700;
  }

  if (item.isWeapon) {
    const weapon = weaponForItem(ctx.weapons, item.name);
    const number = weapon?.number ?? 0;
    const owned = number !== 0 && (ctx.items & number) !== 0;
    if (owned && !ctx.weaponStay) return 200; // still worth it for the ammo it carries
    if (owned) return 0;
    return 600 + (weapon?.priority ?? 0) * 10;
  }

  if (item.isHealth) {
    const missing = Math.max(0, ctx.maxHealth - ctx.health);
    if (missing <= 0) return 0;
    return 100 + missing * 4;
  }

  if (item.isArmor) {
    if (ctx.armor >= 200) return 0;
    return 300 + (200 - ctx.armor);
  }

  if (item.isAmmo) {
    // Worth more the emptier the bot is; ammo it has no weapon for is worth
    // a little, because it may pick the weapon up later.
    let want = 0;
    for (const w of ctx.weapons) {
      if (!w.needsAmmo) continue;
      if (!item.flags.includes(w.ammo)) continue;
      const have = ctx.ammo[w.ammoName] ?? 0;
      const room = Math.max(0, w.maxAmmo - have);
      const owned = (ctx.items & w.number) !== 0;
      want = Math.max(want, (owned ? 150 : 40) * (w.maxAmmo > 0 ? room / w.maxAmmo : 0));
    }
    return want;
  }

  if (item.flags.includes(ITEM_FLAG.backpack)) return 120;
  if (item.flags.includes(ITEM_FLAG.objective) || item.flags.includes(ITEM_FLAG.rune)) return 900;

  return 0;
}

/**
 * The weapons.txt entry a `weapon_*` pickup grants. The two files do not
 * share a key: items.txt writes `weapon_supershotgun` and `weapon_lightning`
 * while weapons.txt writes `super_shotgun` and `lightning_gun`. Dropping the
 * `weapon_` prefix and the underscores makes them comparable, and the match
 * is "one is a prefix of the other, longest wins" so `shotgun` cannot claim
 * `weapon_supershotgun` and `nailgun` cannot claim `weapon_supernailgun`.
 */
export function weaponForItem(weapons: readonly BotWeaponT[], itemName: string): BotWeaponT | undefined {
  const key = itemName.replace(/^weapon_/, "").replace(/_/g, "");
  let best: BotWeaponT | undefined;
  for (const w of weapons) {
    if (w.name === "") continue;
    const name = w.name.replace(/_/g, "");
    if (!key.startsWith(name) && !name.startsWith(key)) continue;
    if (best === undefined || name.length > best.name.replace(/_/g, "").length) best = w;
  }
  return best;
}
