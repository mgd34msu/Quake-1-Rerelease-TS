// Tests for src/lib/botdata.ts (a clean-room reader for the 2021
// re-release's bots/*.txt knowledge-file family -- see that file's header
// comment for the shared grammar and the exact key tables). Self-sufficient
// per PORTING.md rule 13: section 1 builds every fixture inline. Section 2
// is a guarded smoke test against the REAL retail files (id1, ctf),
// extracted with test/support/pak_reader.ts.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  parseCharacters,
  parseWeapons,
  parseItems,
  parseMonsters,
  parseInteractables,
  parseGameRules,
  parseTeams,
  parseChats,
  parseBotSettings,
} from "../src/lib/botdata";
import { PakFile } from "./support/pak_reader";

// ---------------------------------------------------------------------------
// Section 1: synthetic input, one grammar feature / error path per file
// ---------------------------------------------------------------------------

describe("botdata.ts -- characters.txt", () => {
  test("parses a character block, quoted multi-word fun_name included", () => {
    const result = parseCharacters(`{\n  fun_name "Florida Man"\n  name florida\n  shirt_color 2\n  pants_color 5\n}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([{ funName: "Florida Man", name: "florida", shirtColor: 2, pantsColor: 5 }]);
  });

  test("an unknown key is reported, not thrown", () => {
    const result = parseCharacters(`{\n  fun_name Bob\n  name bob\n  shirt_color 0\n  pants_color 0\n  voice bob_voice\n}\n`);
    expect(result.entries.length).toBe(1);
    expect(result.errors.some((e) => e.includes('unknown key "voice"'))).toBe(true);
  });
});

describe("botdata.ts -- weapons.txt", () => {
  test("parses a weapon block, \"|\"-separated flags become a list", () => {
    const result = parseWeapons(
      `{\n  name "shotgun"\n  number 1\n  damage 24\n  min_range 0\n  max_range 4096\n  min_height 0\n  max_height 0\n  priority 2\n  ammo shells\n  ammo_name "ammo_shells"\n  min_ammo 1\n  max_ammo 100\n  flags starting | hitscan | initial\n  aim_point center\n}\n`,
    );
    expect(result.errors).toEqual([]);
    const w = result.entries[0]!;
    expect(w.name).toBe("shotgun");
    expect(w.number).toBe(1);
    expect(w.flags).toEqual(["starting", "hitscan", "initial"]);
    expect(w.aimPoint).toBe("center");
  });

  test("a single-flag entry (no pipes) still yields a one-element list", () => {
    const result = parseWeapons(`{\n  name axe\n  flags melee\n}\n`);
    expect(result.entries[0]!.flags).toEqual(["melee"]);
  });
});

describe("botdata.ts -- items.txt", () => {
  test("a repeated \"spawnflags BIT = name\" key accumulates one entry per occurrence", () => {
    const result = parseItems(`{\n  name "item_weapon"\n  spawnflags 1 = shells\n  spawnflags 2 = rockets\n  spawnflags 4 = nails\n  flags ammo\n}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries[0]!.spawnflags).toEqual([
      { bit: 1, name: "shells" },
      { bit: 2, name: "rockets" },
      { bit: 4, name: "nails" },
    ]);
  });

  test("team is undefined when absent (only ctf's items.txt sets it)", () => {
    const result = parseItems(`{\n  name "item_armor1"\n  flags armor\n}\n`);
    expect(result.entries[0]!.team).toBeUndefined();
  });

  test("team is set when present", () => {
    const result = parseItems(`{\n  name "item_flag_team1"\n  team 5\n  flags objective\n}\n`);
    expect(result.entries[0]!.team).toBe(5);
  });

  test("a malformed \"spawnflags\" value (not \"BIT = name\") is reported, not thrown", () => {
    const result = parseItems(`{\n  name "item_health"\n  spawnflags 2\n}\n`);
    expect(result.entries[0]!.spawnflags).toEqual([]);
    expect(result.errors.some((e) => e.includes('"spawnflags" expects "BIT = name"'))).toBe(true);
  });
});

describe("botdata.ts -- monsters.txt", () => {
  test("parses classname + flag list", () => {
    const result = parseMonsters(`{\n  classname "monster_shambler"\n  flags melee | ranged | tank\n}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries[0]).toEqual({ classname: "monster_shambler", flags: ["melee", "ranged", "tank"] });
  });
});

describe("botdata.ts -- interactables.txt", () => {
  test("spawnflags here is a plain integer, not items.txt's \"BIT = name\" form", () => {
    const result = parseInteractables(`{\n  name func_door_secret\n  interaction shoot\n  spawnflags 16\n  targetname false\n  logic_op or\n}\n`);
    expect(result.errors).toEqual([]);
    const e = result.entries[0]!;
    expect(e.spawnflags).toBe(16);
    expect(e.targetname).toBe(false);
    expect(e.logicOp).toBe("or");
    expect(e.health).toBeUndefined();
  });

  test("bareword true/false parses as a real boolean", () => {
    const result = parseInteractables(`{\n  name func_button\n  interaction shoot\n  health true\n}\n`);
    expect(result.entries[0]!.health).toBe(true);
  });

  test("a boolean field with a non-true/false value is reported, not thrown", () => {
    const result = parseInteractables(`{\n  name func_button\n  interaction shoot\n  health yes\n}\n`);
    expect(result.entries[0]!.health).toBeUndefined();
    expect(result.errors.some((e) => e.includes('"health" expects "true" or "false"'))).toBe(true);
  });
});

describe("botdata.ts -- game_rules.txt", () => {
  test("parses cvar/value/weapon_stay/game_type", () => {
    const result = parseGameRules(`{\n  cvar deathmatch\n  value 2\n  weapon_stay true\n  game_type deathmatch\n}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries[0]).toEqual({ cvar: "deathmatch", value: 2, weaponStay: true, gameType: "deathmatch" });
  });
});

describe("botdata.ts -- teams.txt", () => {
  test("parses value + name, in file order", () => {
    const result = parseTeams(`{\n  value 0\n  name "Red Team"\n}\n\n{\n  value 1\n  name "Blue Team"\n}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { value: 0, name: "Red Team" },
      { value: 1, name: "Blue Team" },
    ]);
  });
});

describe("botdata.ts -- chats.txt", () => {
  test("parses locstring/type/time/chance/team", () => {
    const result = parseChats(`{\n\tlocstring \t"m_bot_chat_connected"\n\ttype \t\t"connected"\n\ttime\t900\n\tchance\t\t50\n\tteam\t\tfalse\n}\n`);
    expect(result.errors).toEqual([]);
    expect(result.entries[0]).toEqual({ locstring: "m_bot_chat_connected", type: "connected", time: 900, chance: 50, team: false });
  });
});

describe("botdata.ts -- settings_*.txt", () => {
  test("parses a \"skill <name> { dotted.key value }\" block into its typed groups", () => {
    const text = `skill practice // comment\n{\n  aiming.max_acceleration 180 // comment\n  behaviors.allow_combat false\n  movement.walk_only true\n  senses.fov_angle 120\n  weapons.decay_time 1\n}\n`;
    const result = parseBotSettings(text);
    expect(result.errors).toEqual([]);
    expect(result.skills.length).toBe(1);
    const s = result.skills[0]!;
    expect(s.skill).toBe("practice");
    expect(s.aiming.maxAcceleration).toBe(180);
    expect(s.behaviors.allowCombat).toBe(false);
    expect(s.movement.walkOnly).toBe(true);
    expect(s.senses.fovAngle).toBe(120);
    expect(s.weapons.decayTime).toBe(1);
  });

  test("a three-segment dotted key (aiming.modifier.*) resolves to its flattened field", () => {
    const result = parseBotSettings(`skill easy\n{\n  aiming.modifier.max_angle 60\n  aiming.modifier.apply_time 1.5\n}\n`);
    expect(result.skills[0]!.aiming.modifierMaxAngle).toBe(60);
    expect(result.skills[0]!.aiming.modifierApplyTime).toBe(1.5);
  });

  test("multiple skill blocks parse in file order", () => {
    const result = parseBotSettings(`skill practice\n{\n  aiming.damping 5\n}\n\nskill nightmare\n{\n  aiming.damping 500\n}\n`);
    expect(result.skills.map((s) => s.skill)).toEqual(["practice", "nightmare"]);
    expect(result.skills[0]!.aiming.damping).toBe(5);
    expect(result.skills[1]!.aiming.damping).toBe(500);
  });

  test("an unknown dotted key is kept verbatim and reported, not thrown", () => {
    const result = parseBotSettings(`skill practice\n{\n  future.new_field 1 2\n}\n`);
    expect(result.skills[0]!.unknown).toEqual({ "future.new_field": ["1", "2"] });
    expect(result.errors.some((e) => e.includes('unknown key "future.new_field"'))).toBe(true);
  });

  test("a header that isn't \"skill <name>\" is reported and the block is skipped", () => {
    const result = parseBotSettings(`difficulty practice\n{\n  aiming.damping 5\n}\n`);
    expect(result.skills).toEqual([]);
    expect(result.errors.some((e) => e.includes('not "skill <name>"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 2: guarded retail-file tests
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;

function pakGuard(dir: string): { pakPath: string; have: boolean } {
  const pakPath = `${RERELEASE_DATA_DIR}/${dir}/pak0.pak`;
  return { pakPath, have: existsSync(pakPath) };
}

const id1 = pakGuard("id1");
const ctf = pakGuard("ctf");

describe.skipIf(!id1.have)("botdata.ts -- real retail id1 bots/*.txt", () => {
  const pak = id1.have ? new PakFile(id1.pakPath) : null;

  test("characters.txt: 173 characters, no parse errors", () => {
    const result = parseCharacters(pak!.readText("bots/characters.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(173);
  });

  test("weapons.txt: 8 weapons (base id1 loadout), no parse errors", () => {
    const result = parseWeapons(pak!.readText("bots/weapons.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.map((w) => w.name)).toEqual([
      "axe",
      "shotgun",
      "super_shotgun",
      "nailgun",
      "super_nailgun",
      "grenade_launcher",
      "rocket_launcher",
      "lightning_gun",
    ]);
  });

  test("items.txt: 20 items, 4 total spawnflags entries, no parse errors", () => {
    const result = parseItems(pak!.readText("bots/items.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(20);
    expect(result.entries.flatMap((i) => i.spawnflags).length).toBe(4);
    expect(result.entries.every((i) => i.team === undefined)).toBe(true);
  });

  test("monsters.txt: 14 monsters, no parse errors", () => {
    const result = parseMonsters(pak!.readText("bots/monsters.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(14);
  });

  test("interactables.txt: 11 entries, no parse errors", () => {
    const result = parseInteractables(pak!.readText("bots/interactables.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(11);
  });

  test("game_rules.txt: 4 rules, no parse errors", () => {
    const result = parseGameRules(pak!.readText("bots/game_rules.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(4);
  });

  test("teams.txt: 4 teams, no parse errors", () => {
    const result = parseTeams(pak!.readText("bots/teams.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(4);
  });

  test("chats.txt: 15 chats, no parse errors", () => {
    const result = parseChats(pak!.readText("bots/chats.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(15);
  });

  test("settings_PC.txt: 6 skill blocks (practice/easy/medium/hard/expert/nightmare), no parse errors", () => {
    const result = parseBotSettings(pak!.readText("bots/settings_PC.txt"));
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => s.skill)).toEqual(["practice", "easy", "medium", "hard", "expert", "nightmare"]);
    expect(result.skills[0]!.aiming.maxAcceleration).toBe(180);
    expect(result.skills[result.skills.length - 1]!.senses.fovAngle).toBe(180);
  });

  test("settings_Consoles.txt and settings_Nintendo.txt are byte-identical to settings_PC.txt in retail id1", () => {
    const pc = pak!.readText("bots/settings_PC.txt");
    expect(pak!.readText("bots/settings_Consoles.txt")).toBe(pc);
    expect(pak!.readText("bots/settings_Nintendo.txt")).toBe(pc);
  });
});

describe.skipIf(!ctf.have)("botdata.ts -- real retail ctf bots/*.txt (per-mod key reuse)", () => {
  const pak = ctf.have ? new PakFile(ctf.pakPath) : null;

  test("game_rules.txt: 5 rules (ctf adds a ctf-cvar rule ahead of id1's 4), no parse errors", () => {
    const result = parseGameRules(pak!.readText("bots/game_rules.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(5);
    expect(result.entries[0]!.gameType).toBe("ctf");
  });

  test("teams.txt: 2 teams with QuakeC values 5 and 14 (not 0/1 like id1's teams.txt)", () => {
    const result = parseTeams(pak!.readText("bots/teams.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { value: 5, name: "Red Team" },
      { value: 14, name: "Blue Team" },
    ]);
  });

  test("items.txt: 26 items, exactly 2 carry a team (the two flag entities)", () => {
    const result = parseItems(pak!.readText("bots/items.txt"));
    expect(result.errors).toEqual([]);
    expect(result.entries.length).toBe(26);
    expect(result.entries.filter((i) => i.team !== undefined).length).toBe(2);
  });
});
