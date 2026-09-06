// Reader for the 2021 re-release's bots/*.txt knowledge-file family:
// characters.txt, weapons.txt, items.txt, monsters.txt,
// interactables.txt, game_rules.txt, teams.txt, chats.txt and the
// per-platform settings_PC.txt/settings_Consoles.txt/settings_Nintendo.txt.
// Not a ported C file -- the engine that reads these is closed; this is a
// clean-room reader for the shared brace-block grammar (see
// src/lib/blockparse.ts's header) built from the shipped retail files (see
// test/lib_botdata.test.ts's guarded cases, which also carry the key-set
// tables reproduced below).
//
// Every file in this family is a flat list of anonymous `{ ... }` blocks
// (a leading "// comment" is legal right after the brace, e.g.
// "{ // Health/Mega-Health"), except the three settings_*.txt files, whose
// blocks are headed by "skill <name>" (retail id1 ships SIX skill blocks
// -- practice, easy, medium, hard, expert, nightmare -- not the five the
// brief's own overview lists; "expert" between hard and nightmare is real
// retail data, confirmed by grep against all three settings_*.txt, which
// are byte-identical to each other in the retail id1 pak).
//
// Key sets extracted 2026-09-06 from id1 (cross-checked against mg1, mg3,
// ctf, hipnotic, rogue, dopa -- every mod tree uses exactly these same key
// sets, just more or fewer blocks):
//
//   characters.txt:    fun_name, name, shirt_color, pants_color
//   weapons.txt:       name, number, damage, min_range, max_range,
//                      min_height, max_height, priority, ammo, ammo_name,
//                      min_ammo, max_ammo, flags ("|"-list), aim_point
//   items.txt:         name, flags ("|"-list), spawnflags (repeatable,
//                      "BIT = name" triples), team (ctf only, integer)
//   monsters.txt:      classname, flags ("|"-list)
//   interactables.txt: name, interaction, spawnflags (plain integer, NOT
//                      the "BIT = name" form items.txt uses), health
//                      (bool), targetname (bool), logic_op
//   game_rules.txt:    cvar, value, weapon_stay (bool), game_type
//   teams.txt:         value, name
//   chats.txt:         locstring, type, time, chance, team (bool)
//   settings_*.txt:    "skill <name> { dotted.key value }" blocks; 35
//                      dotted keys per skill (aiming.*: 9, behaviors.*: 9,
//                      movement.*: 4, senses.*: 10, weapons.*: 3), see
//                      SETTINGS_FIELDS below for the exact list.
//
// Every per-file parser below reports an unknown key in `errors` (via
// `unknownKey`) and stashes its raw tokens rather than throwing or
// silently dropping it, per this unit's brief.

import { parseBlocks, fieldBool, fieldFlagList, fieldNumber, fieldString, type Block } from "./blockparse";

function unknownKey(errors: string[], key: string, line: number): void {
  errors.push(`line ${line}: unknown key "${key}"`);
}

function expectString(errors: string[], key: string, values: string[], line: number): string | undefined {
  const s = fieldString(values);
  if (s === undefined) errors.push(`line ${line}: "${key}" expects a single string`);
  return s;
}

function expectNumber(errors: string[], key: string, values: string[], line: number): number | undefined {
  const n = fieldNumber(values);
  if (n === undefined) errors.push(`line ${line}: "${key}" expects a single number`);
  return n;
}

function expectBool(errors: string[], key: string, values: string[], line: number): boolean | undefined {
  const b = fieldBool(values);
  if (b === undefined) errors.push(`line ${line}: "${key}" expects "true" or "false"`);
  return b;
}

//=============================================================================
// characters.txt
//=============================================================================

export class CharacterEntry {
  funName = "";
  name = "";
  shirtColor = 0;
  pantsColor = 0;
}

export interface CharactersResult {
  entries: CharacterEntry[];
  errors: string[];
}

export function parseCharacters(text: string): CharactersResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: CharacterEntry[] = [];

  for (const block of blocks) {
    const entry = new CharacterEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "fun_name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.funName = s;
          break;
        }
        case "name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.name = s;
          break;
        }
        case "shirt_color": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.shirtColor = n;
          break;
        }
        case "pants_color": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.pantsColor = n;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// weapons.txt
//=============================================================================

export class WeaponEntry {
  name = "";
  number = 0;
  damage = 0;
  minRange = 0;
  maxRange = 0;
  minHeight = 0;
  maxHeight = 0;
  priority = 0;
  ammo = "";
  ammoName = "";
  minAmmo = 0;
  maxAmmo = 0;
  flags: string[] = [];
  aimPoint = "";
}

export interface WeaponsResult {
  entries: WeaponEntry[];
  errors: string[];
}

export function parseWeapons(text: string): WeaponsResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: WeaponEntry[] = [];

  for (const block of blocks) {
    const entry = new WeaponEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.name = s;
          break;
        }
        case "number": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.number = n;
          break;
        }
        case "damage": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.damage = n;
          break;
        }
        case "min_range": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.minRange = n;
          break;
        }
        case "max_range": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.maxRange = n;
          break;
        }
        case "min_height": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.minHeight = n;
          break;
        }
        case "max_height": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.maxHeight = n;
          break;
        }
        case "priority": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.priority = n;
          break;
        }
        case "ammo": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.ammo = s;
          break;
        }
        case "ammo_name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.ammoName = s;
          break;
        }
        case "min_ammo": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.minAmmo = n;
          break;
        }
        case "max_ammo": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.maxAmmo = n;
          break;
        }
        case "flags":
          entry.flags = fieldFlagList(f.values);
          break;
        case "aim_point": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.aimPoint = s;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// items.txt
//=============================================================================

/** One "spawnflags BIT = name" pair; items.txt allows repeating the key to list several. */
export class ItemSpawnflag {
  bit = 0;
  name = "";
}

export class ItemEntry {
  name = "";
  spawnflags: ItemSpawnflag[] = [];
  flags: string[] = [];
  /** Only set in ctf's items.txt (item_flag_team1/2); absent everywhere else. */
  team: number | undefined = undefined;
}

export interface ItemsResult {
  entries: ItemEntry[];
  errors: string[];
}

export function parseItems(text: string): ItemsResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: ItemEntry[] = [];

  for (const block of blocks) {
    const entry = new ItemEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.name = s;
          break;
        }
        case "flags":
          entry.flags = fieldFlagList(f.values);
          break;
        case "spawnflags": {
          if (f.values.length === 3 && f.values[1] === "=") {
            const bit = Number(f.values[0]);
            const name = f.values[2]!;
            if (!Number.isInteger(bit)) {
              errors.push(`line ${f.line}: "spawnflags" bit "${f.values[0]}" is not an integer`);
            } else {
              const flag = new ItemSpawnflag();
              flag.bit = bit;
              flag.name = name;
              entry.spawnflags.push(flag);
            }
          } else {
            errors.push(`line ${f.line}: "spawnflags" expects "BIT = name"`);
          }
          break;
        }
        case "team": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.team = n;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// monsters.txt
//=============================================================================

export class MonsterEntry {
  classname = "";
  flags: string[] = [];
}

export interface MonstersResult {
  entries: MonsterEntry[];
  errors: string[];
}

export function parseMonsters(text: string): MonstersResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: MonsterEntry[] = [];

  for (const block of blocks) {
    const entry = new MonsterEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "classname": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.classname = s;
          break;
        }
        case "flags":
          entry.flags = fieldFlagList(f.values);
          break;
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// interactables.txt
//=============================================================================

export class InteractableEntry {
  name = "";
  interaction = "";
  /** Plain integer here -- NOT items.txt's "BIT = name" form. */
  spawnflags: number | undefined = undefined;
  health: boolean | undefined = undefined;
  targetname: boolean | undefined = undefined;
  logicOp: string | undefined = undefined;
}

export interface InteractablesResult {
  entries: InteractableEntry[];
  errors: string[];
}

export function parseInteractables(text: string): InteractablesResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: InteractableEntry[] = [];

  for (const block of blocks) {
    const entry = new InteractableEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.name = s;
          break;
        }
        case "interaction": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.interaction = s;
          break;
        }
        case "spawnflags": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.spawnflags = n;
          break;
        }
        case "health": {
          const b = expectBool(errors, f.key, f.values, f.line);
          if (b !== undefined) entry.health = b;
          break;
        }
        case "targetname": {
          const b = expectBool(errors, f.key, f.values, f.line);
          if (b !== undefined) entry.targetname = b;
          break;
        }
        case "logic_op": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.logicOp = s;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// game_rules.txt
//=============================================================================

export class GameRuleEntry {
  cvar = "";
  value = 0;
  weaponStay = false;
  gameType = "";
}

export interface GameRulesResult {
  entries: GameRuleEntry[];
  errors: string[];
}

export function parseGameRules(text: string): GameRulesResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: GameRuleEntry[] = [];

  for (const block of blocks) {
    const entry = new GameRuleEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "cvar": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.cvar = s;
          break;
        }
        case "value": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.value = n;
          break;
        }
        case "weapon_stay": {
          const b = expectBool(errors, f.key, f.values, f.line);
          if (b !== undefined) entry.weaponStay = b;
          break;
        }
        case "game_type": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.gameType = s;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// teams.txt
//=============================================================================

export class TeamEntry {
  value = 0;
  name = "";
}

export interface TeamsResult {
  entries: TeamEntry[];
  errors: string[];
}

export function parseTeams(text: string): TeamsResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: TeamEntry[] = [];

  for (const block of blocks) {
    const entry = new TeamEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "value": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.value = n;
          break;
        }
        case "name": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.name = s;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// chats.txt
//=============================================================================

export class ChatEntry {
  locstring = "";
  type = "";
  time = 0;
  chance = 0;
  team = false;
}

export interface ChatsResult {
  entries: ChatEntry[];
  errors: string[];
}

export function parseChats(text: string): ChatsResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const entries: ChatEntry[] = [];

  for (const block of blocks) {
    const entry = new ChatEntry();
    for (const f of block.fields) {
      switch (f.key) {
        case "locstring": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.locstring = s;
          break;
        }
        case "type": {
          const s = expectString(errors, f.key, f.values, f.line);
          if (s !== undefined) entry.type = s;
          break;
        }
        case "time": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.time = n;
          break;
        }
        case "chance": {
          const n = expectNumber(errors, f.key, f.values, f.line);
          if (n !== undefined) entry.chance = n;
          break;
        }
        case "team": {
          const b = expectBool(errors, f.key, f.values, f.line);
          if (b !== undefined) entry.team = b;
          break;
        }
        default:
          unknownKey(errors, f.key, f.line);
      }
    }
    entries.push(entry);
  }

  return { entries, errors };
}

//=============================================================================
// settings_PC.txt / settings_Consoles.txt / settings_Nintendo.txt
//=============================================================================

export class BotAimingSettings {
  maxAcceleration = 0;
  springStiffness = 0;
  damping = 0;
  velocityOffset = 0;
  modifierMaxAngle = 0;
  modifierApplyTime = 0;
  modifierAccelScalar = 0;
  modifierSpringScalar = 0;
  modifierDampingScalar = 0;
}

export class BotBehaviorSettings {
  allowCombat = false;
  allowGrabItemsInCombat = false;
  allowMelee = false;
  allowCheckSix = false;
  allowGrabItems = false;
  allowGrabPowerItems = false;
  deferPowerItemsToHumans = false;
  minRespawnTime = 0;
  maxRespawnTime = 0;
}

export class BotMovementSettings {
  allowJumpingInCombat = false;
  jumpChance = 0;
  jumpCooldown = 0;
  walkOnly = false;
}

export class BotSensesSettings {
  sightTime = 0;
  sightDecayTime = 0;
  invisEnemySightScalar = 0;
  maxInvisEnemySightDist = 0;
  fovAngle = 0;
  forgetNonVisEnemyTime = 0;
  soundRange = 0;
  soundTime = 0;
  soundDecayTime = 0;
  soundPersistTime = 0;
}

export class BotWeaponSenseSettings {
  decayTime = 0;
  fovAngle = 0;
  sightTime = 0;
}

export class BotSkillSettings {
  skill = "";
  aiming = new BotAimingSettings();
  behaviors = new BotBehaviorSettings();
  movement = new BotMovementSettings();
  senses = new BotSensesSettings();
  weapons = new BotWeaponSenseSettings();
  /** Dotted keys this reader doesn't recognize, kept verbatim rather than dropped. */
  unknown: Record<string, string[]> = {};
}

export interface BotSettingsResult {
  skills: BotSkillSettings[];
  errors: string[];
}

function applySkillField(settings: BotSkillSettings, key: string, values: string[], line: number, errors: string[]): void {
  const num = (): number | undefined => expectNumber(errors, key, values, line);
  const bool = (): boolean | undefined => expectBool(errors, key, values, line);

  switch (key) {
    case "aiming.max_acceleration": {
      const n = num();
      if (n !== undefined) settings.aiming.maxAcceleration = n;
      break;
    }
    case "aiming.spring_stiffness": {
      const n = num();
      if (n !== undefined) settings.aiming.springStiffness = n;
      break;
    }
    case "aiming.damping": {
      const n = num();
      if (n !== undefined) settings.aiming.damping = n;
      break;
    }
    case "aiming.velocity_offset": {
      const n = num();
      if (n !== undefined) settings.aiming.velocityOffset = n;
      break;
    }
    case "aiming.modifier.max_angle": {
      const n = num();
      if (n !== undefined) settings.aiming.modifierMaxAngle = n;
      break;
    }
    case "aiming.modifier.apply_time": {
      const n = num();
      if (n !== undefined) settings.aiming.modifierApplyTime = n;
      break;
    }
    case "aiming.modifier.accel_scalar": {
      const n = num();
      if (n !== undefined) settings.aiming.modifierAccelScalar = n;
      break;
    }
    case "aiming.modifier.spring_scalar": {
      const n = num();
      if (n !== undefined) settings.aiming.modifierSpringScalar = n;
      break;
    }
    case "aiming.modifier.damping_scalar": {
      const n = num();
      if (n !== undefined) settings.aiming.modifierDampingScalar = n;
      break;
    }
    case "behaviors.allow_combat": {
      const b = bool();
      if (b !== undefined) settings.behaviors.allowCombat = b;
      break;
    }
    case "behaviors.allow_grab_items_in_combat": {
      const b = bool();
      if (b !== undefined) settings.behaviors.allowGrabItemsInCombat = b;
      break;
    }
    case "behaviors.allow_melee": {
      const b = bool();
      if (b !== undefined) settings.behaviors.allowMelee = b;
      break;
    }
    case "behaviors.allow_check_six": {
      const b = bool();
      if (b !== undefined) settings.behaviors.allowCheckSix = b;
      break;
    }
    case "behaviors.allow_grab_items": {
      const b = bool();
      if (b !== undefined) settings.behaviors.allowGrabItems = b;
      break;
    }
    case "behaviors.allow_grab_power_items": {
      const b = bool();
      if (b !== undefined) settings.behaviors.allowGrabPowerItems = b;
      break;
    }
    case "behaviors.defer_power_items_to_humans": {
      const b = bool();
      if (b !== undefined) settings.behaviors.deferPowerItemsToHumans = b;
      break;
    }
    case "behaviors.min_respawn_time": {
      const n = num();
      if (n !== undefined) settings.behaviors.minRespawnTime = n;
      break;
    }
    case "behaviors.max_respawn_time": {
      const n = num();
      if (n !== undefined) settings.behaviors.maxRespawnTime = n;
      break;
    }
    case "movement.allow_jumping_in_combat": {
      const b = bool();
      if (b !== undefined) settings.movement.allowJumpingInCombat = b;
      break;
    }
    case "movement.jump_chance": {
      const n = num();
      if (n !== undefined) settings.movement.jumpChance = n;
      break;
    }
    case "movement.jump_cooldown": {
      const n = num();
      if (n !== undefined) settings.movement.jumpCooldown = n;
      break;
    }
    case "movement.walk_only": {
      const b = bool();
      if (b !== undefined) settings.movement.walkOnly = b;
      break;
    }
    case "senses.sight_time": {
      const n = num();
      if (n !== undefined) settings.senses.sightTime = n;
      break;
    }
    case "senses.sight_decay_time": {
      const n = num();
      if (n !== undefined) settings.senses.sightDecayTime = n;
      break;
    }
    case "senses.invis_enemy_sight_scalar": {
      const n = num();
      if (n !== undefined) settings.senses.invisEnemySightScalar = n;
      break;
    }
    case "senses.max_invis_enemy_sight_dist": {
      const n = num();
      if (n !== undefined) settings.senses.maxInvisEnemySightDist = n;
      break;
    }
    case "senses.fov_angle": {
      const n = num();
      if (n !== undefined) settings.senses.fovAngle = n;
      break;
    }
    case "senses.forget_non_vis_enemy_time": {
      const n = num();
      if (n !== undefined) settings.senses.forgetNonVisEnemyTime = n;
      break;
    }
    case "senses.sound_range": {
      const n = num();
      if (n !== undefined) settings.senses.soundRange = n;
      break;
    }
    case "senses.sound_time": {
      const n = num();
      if (n !== undefined) settings.senses.soundTime = n;
      break;
    }
    case "senses.sound_decay_time": {
      const n = num();
      if (n !== undefined) settings.senses.soundDecayTime = n;
      break;
    }
    case "senses.sound_persist_time": {
      const n = num();
      if (n !== undefined) settings.senses.soundPersistTime = n;
      break;
    }
    case "weapons.decay_time": {
      const n = num();
      if (n !== undefined) settings.weapons.decayTime = n;
      break;
    }
    case "weapons.fov_angle": {
      const n = num();
      if (n !== undefined) settings.weapons.fovAngle = n;
      break;
    }
    case "weapons.sight_time": {
      const n = num();
      if (n !== undefined) settings.weapons.sightTime = n;
      break;
    }
    default:
      settings.unknown[key] = values;
      unknownKey(errors, key, line);
  }
}

function parseSkillBlock(block: Block, errors: string[]): BotSkillSettings | undefined {
  if (block.header[0] !== "skill" || block.header.length !== 2) {
    errors.push(`line ${block.line}: block header is not "skill <name>" (got ${JSON.stringify(block.header)})`);
    return undefined;
  }
  const settings = new BotSkillSettings();
  settings.skill = block.header[1]!;
  for (const f of block.fields) applySkillField(settings, f.key, f.values, f.line, errors);
  return settings;
}

/**
 * Parses one of settings_PC.txt/settings_Consoles.txt/settings_Nintendo.txt
 * (all three are byte-identical in the retail id1 pak, but this reader
 * doesn't assume that -- it parses whichever text it's given).
 */
export function parseBotSettings(text: string): BotSettingsResult {
  const { blocks, errors: blockErrors } = parseBlocks(text);
  const errors = blockErrors.map((e) => `line ${e.line}: ${e.message}`);
  const skills: BotSkillSettings[] = [];

  for (const block of blocks) {
    const settings = parseSkillBlock(block, errors);
    if (settings !== undefined) skills.push(settings);
  }

  return { skills, errors };
}
