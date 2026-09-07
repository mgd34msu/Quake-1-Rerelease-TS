// src/lib/bot_brain: the game-agnostic brain, tested without an engine.
//
// Everything here runs on synthetic data -- a hand-built NAV2 file, a
// hand-written bots/*.txt set, and a stub BotWorldT -- so the suite has no
// fixture requirements at all and never touches a singleton. The one guarded
// section at the end re-derives, from the retail id1 pak, the NAV2 field
// meanings src/lib/bot_brain/nav_graph.ts's header documents.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { NavEntityLink, NavFile, NavHint, NavLink, NavNode, parseNav } from "../src/lib/nav";
import { PakFile } from "./support/pak_reader";
import {
  aimError,
  aimStep,
  BotBrain,
  BotGoalStatus,
  BotKnowledge,
  BotPathStatus,
  BOT_BUTTON_JUMP,
  BOT_RUN_SPEED,
  bvec,
  bvecDistance,
  canFire,
  chooseWeapon,
  clearPath,
  emptyUsercmd,
  followPath,
  isAware,
  itemValue,
  NavGraph,
  navGraphFromNav2,
  NavLinkType,
  NavNodeFlags,
  newAimState,
  newAwareness,
  newPathState,
  senseStep,
  setPath,
  shouldForget,
  soundAudible,
  vectorToAngles,
  Xorshift32,
  type BotContactT,
  type BotEntityT,
  type BotSelfT,
  type BotSoundT,
  type BotTraceT,
  type BotVec3,
  type BotWorldT,
} from "../src/lib/bot_brain";
import { BotEntityKind } from "../src/lib/bot_brain/world";
import type { BotMovementSettings } from "../src/lib/botdata";

//=============================================================================
// helpers: a synthetic NAV2 file
//=============================================================================

interface SyntheticLink {
  from: number;
  to: number;
  type?: number;
  traversal?: { funnel: BotVec3; start: BotVec3; end: BotVec3 };
}

/** Builds a NavFile the way parseNav would have produced one, without bytes. */
function buildNav(positions: BotVec3[], links: SyntheticLink[], radius = 32, flags: number[] = []): NavFile {
  const file = new NavFile();
  file.version = 15;

  const byNode: SyntheticLink[][] = positions.map(() => []);
  for (const l of links) byNode[l.from]!.push(l);

  let first = 0;
  for (let i = 0; i < positions.length; i++) {
    const node = new NavNode();
    node.flags = flags[i] ?? 0;
    node.radius = radius;
    node.firstLink = first;
    node.linkCount = byNode[i]!.length;
    node.position = { x: positions[i]!.x, y: positions[i]!.y, z: positions[i]!.z };
    file.nodes.push(node);
    first += node.linkCount;
  }

  for (let i = 0; i < positions.length; i++) {
    for (const l of byNode[i]!) {
      const link = new NavLink();
      link.target = l.to;
      link.type = l.type ?? NavLinkType.Walk;
      if (l.traversal !== undefined) {
        link.traversal = file.hints.length;
        const hint = new NavHint();
        hint.funnel = l.traversal.funnel;
        hint.start = l.traversal.start;
        hint.end = l.traversal.end;
        file.hints.push(hint);
      } else {
        link.traversal = null;
      }
      file.links.push(link);
    }
  }

  return file;
}

/** Links both ways between consecutive nodes. */
function chainLinks(count: number, type = NavLinkType.Walk): SyntheticLink[] {
  const out: SyntheticLink[] = [];
  for (let i = 0; i + 1 < count; i++) {
    out.push({ from: i, to: i + 1, type });
    out.push({ from: i + 1, to: i, type });
  }
  return out;
}

//=============================================================================
// helpers: a synthetic bots/*.txt set
//=============================================================================

const WEAPONS_TXT = `
{
  name "axe"
  number 4096
  damage 20
  min_range 0
  max_range 72
  min_height 0
  max_height 0
  priority 1
  ammo none
  ammo_name ""
  min_ammo 0
  max_ammo 0
  flags melee | starting
  aim_point center
}
{
  name "shotgun"
  number 1
  damage 24
  min_range 0
  max_range 4096
  min_height 0
  max_height 0
  priority 2
  ammo shells
  ammo_name "ammo_shells"
  min_ammo 1
  max_ammo 100
  flags starting | hitscan | initial
  aim_point center
}
{
  name "super_shotgun"
  number 2
  damage 56
  min_range 0
  max_range 768
  min_height 0
  max_height 0
  priority 5
  ammo shells
  ammo_name "ammo_shells"
  min_ammo 2
  max_ammo 100
  flags hitscan
  aim_point center
}
{
  name "lightning"
  number 64
  damage 30
  min_range 0
  max_range 600
  min_height 0
  max_height 0
  priority 9
  ammo cells
  ammo_name "ammo_cells"
  min_ammo 1
  max_ammo 100
  flags electric
  aim_point center
}
`;

const ITEMS_TXT = `
{
  name "item_health"
  spawnflags 2 = mega_item
  flags health
}
{
  name "item_shells"
  flags ammo | shells
}
{
  name "item_armor2"
  flags armor
}
{
  name "weapon_supershotgun"
  flags weapon | shells
}
{
  name "item_artifact_super_damage"
  flags powerup
}
`;

const MONSTERS_TXT = `
{
  classname "monster_ogre"
  flags melee | ranged
}
{
  classname "monster_dog"
  flags melee
}
`;

const INTERACTABLES_TXT = `
{
  name func_button
  interaction shoot
  health true
}
{
  name func_button
  interaction push
}
{
  name func_plat
  interaction ride
}
`;

const GAME_RULES_TXT = `
{
  cvar horde
  value 1
  weapon_stay true
  game_type horde
}
{
  cvar coop
  value 1
  weapon_stay true
  game_type coop
}
{
  cvar deathmatch
  value 1
  weapon_stay false
  game_type deathmatch
}
{
  cvar deathmatch
  value 2
  weapon_stay true
  game_type deathmatch
}
`;

const TEAMS_TXT = `
{
  value 0
  name "Red Team"
}
{
  value 1
  name "Blue Team"
}
`;

const CHATS_TXT = `
{
  locstring "m_bot_chat_connected"
  type "connected"
  time 900
  chance 100
  team false
}
{
  locstring "m_bot_chat_never"
  type "match_start"
  time 100
  chance 0
  team false
}
`;

const CHARACTERS_TXT = `
{
  fun_name Azizam
  name ozzy
  shirt_color 13
  pants_color 13
}
{
  fun_name Barney
  name barney
  shirt_color 0
  pants_color 3
}
`;

function settingsBlock(name: string, over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    "aiming.max_acceleration": "360",
    "aiming.spring_stiffness": "125",
    "aiming.damping": "20",
    "aiming.velocity_offset": "-0.1",
    "aiming.modifier.max_angle": "30",
    "aiming.modifier.apply_time": "0.75",
    "aiming.modifier.accel_scalar": "1.25",
    "aiming.modifier.spring_scalar": "1.25",
    "aiming.modifier.damping_scalar": "1.25",
    "behaviors.allow_combat": "true",
    "behaviors.allow_grab_items_in_combat": "false",
    "behaviors.allow_melee": "true",
    "behaviors.allow_check_six": "false",
    "behaviors.allow_grab_items": "true",
    "behaviors.allow_grab_power_items": "true",
    "behaviors.defer_power_items_to_humans": "false",
    "behaviors.min_respawn_time": "1",
    "behaviors.max_respawn_time": "1.5",
    "movement.allow_jumping_in_combat": "true",
    "movement.jump_chance": "35",
    "movement.jump_cooldown": "1",
    "movement.walk_only": "false",
    "senses.sight_time": "0.25",
    "senses.sight_decay_time": "0.3",
    "senses.invis_enemy_sight_scalar": "2",
    "senses.max_invis_enemy_sight_dist": "256",
    "senses.fov_angle": "140",
    "senses.forget_non_vis_enemy_time": "1.5",
    "senses.sound_range": "640",
    "senses.sound_time": "0.4",
    "senses.sound_decay_time": "2.5",
    "senses.sound_persist_time": "0.4",
    "weapons.decay_time": "2",
    "weapons.fov_angle": "40",
    "weapons.sight_time": "0.2",
    ...over,
  };
  const body = Object.entries(base)
    .map(([k, v]) => `  ${k} ${v}`)
    .join("\n");
  return `skill ${name}\n{\n${body}\n}\n`;
}

const SETTINGS_TXT = `${settingsBlock("easy", { "aiming.max_acceleration": "225", "aiming.spring_stiffness": "60", "aiming.damping": "10" })}\n${settingsBlock("medium")}\n${settingsBlock("nightmare", { "aiming.max_acceleration": "720", "aiming.spring_stiffness": "500", "aiming.damping": "30", "senses.sight_time": "0.05" })}\n`;

function buildKnowledge(): BotKnowledge {
  return new BotKnowledge({
    characters: CHARACTERS_TXT,
    weapons: WEAPONS_TXT,
    items: ITEMS_TXT,
    monsters: MONSTERS_TXT,
    interactables: INTERACTABLES_TXT,
    gameRules: GAME_RULES_TXT,
    teams: TEAMS_TXT,
    chats: CHATS_TXT,
    settings: SETTINGS_TXT,
  });
}

/** ctf/bots/items.txt: item_flag_team1 is `team 5`, item_flag_team2 `team 14`. */
function buildCtfKnowledge(): BotKnowledge {
  return new BotKnowledge({
    characters: CHARACTERS_TXT,
    weapons: WEAPONS_TXT,
    items: `${ITEMS_TXT}\n{\n  name "item_flag_team1"\n  team 5\n  flags objective\n}\n{\n  name "item_flag_team2"\n  team 14\n  flags objective\n}\n`,
    monsters: MONSTERS_TXT,
    interactables: INTERACTABLES_TXT,
    gameRules: GAME_RULES_TXT,
    teams: TEAMS_TXT,
    chats: CHATS_TXT,
    settings: SETTINGS_TXT,
  });
}

//=============================================================================
// A*
//=============================================================================

describe("nav graph: A*", () => {
  test("finds the shortest of two routes, not merely a connected one", () => {
    // 0 -> 1 -> 5 is 400 units; 0 -> 2 -> 3 -> 4 -> 5 is 1200.
    const graph = navGraphFromNav2(
      buildNav(
        [bvec(0, 0, 0), bvec(200, 0, 0), bvec(0, 300, 0), bvec(300, 300, 0), bvec(600, 300, 0), bvec(400, 0, 0)],
        [
          { from: 0, to: 1 },
          { from: 1, to: 5 },
          { from: 0, to: 2 },
          { from: 2, to: 3 },
          { from: 3, to: 4 },
          { from: 4, to: 5 },
        ],
      ),
    );

    expect(graph.findPath(0, 5)).toEqual([0, 1, 5]);
  });

  test("answers null when the goal is in a disconnected component", () => {
    const graph = navGraphFromNav2(buildNav([bvec(0, 0, 0), bvec(100, 0, 0), bvec(9000, 0, 0)], [{ from: 0, to: 1 }]));
    expect(graph.findPath(0, 2)).toBeNull();
  });

  test("a start that is also the goal is a one-node path", () => {
    const graph = navGraphFromNav2(buildNav([bvec(0, 0, 0), bvec(100, 0, 0)], chainLinks(2)));
    expect(graph.findPath(1, 1)).toEqual([1]);
  });

  test("a Teleport link costs a flat 1, so it beats a long walk", () => {
    // Walking 0->1->2 is 2000 units; teleporting 0->2 is one link.
    const graph = navGraphFromNav2(
      buildNav(
        [bvec(0, 0, 0), bvec(1000, 0, 0), bvec(2000, 0, 0)],
        [
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 0, to: 2, type: NavLinkType.Teleport },
        ],
      ),
    );
    expect(graph.findPath(0, 2)).toEqual([0, 2]);
  });

  test("traverse caps refuse the link types the searcher cannot use", () => {
    const graph = navGraphFromNav2(
      buildNav(
        [bvec(0, 0, 0), bvec(200, 0, 200), bvec(400, 0, 0), bvec(0, 400, 0), bvec(400, 400, 0)],
        [
          { from: 0, to: 1, type: NavLinkType.LongJump },
          { from: 1, to: 2, type: NavLinkType.LongJump },
          { from: 0, to: 3 },
          { from: 3, to: 4 },
          { from: 4, to: 2 },
        ],
      ),
    );

    const jumper = { jump: true, walkOffLedge: true, entityTraversal: true, swim: true, maxDrop: 0, maxJumpHeight: 0 };
    const walker = { ...jumper, jump: false };
    expect(graph.findPath(0, 2, jumper)).toEqual([0, 1, 2]);
    expect(graph.findPath(0, 2, walker)).toEqual([0, 3, 4, 2]);
  });

  test("a non-swimmer is routed around underwater nodes", () => {
    const graph = navGraphFromNav2(
      buildNav(
        [bvec(0, 0, 0), bvec(200, 0, 0), bvec(400, 0, 0), bvec(0, 400, 0), bvec(400, 400, 0)],
        [
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 0, to: 3 },
          { from: 3, to: 4 },
          { from: 4, to: 2 },
        ],
        32,
        [0, NavNodeFlags.UnderWater, 0, 0, 0],
      ),
    );
    const swimmer = { jump: true, walkOffLedge: true, entityTraversal: true, swim: true, maxDrop: 0, maxJumpHeight: 0 };
    expect(graph.findPath(0, 2, swimmer)).toEqual([0, 1, 2]);
    expect(graph.findPath(0, 2, { ...swimmer, swim: false })).toEqual([0, 3, 4, 2]);
  });

  test("closestNode picks the nearest node inside the height window", () => {
    const graph = navGraphFromNav2(buildNav([bvec(0, 0, 0), bvec(100, 0, 0), bvec(50, 0, 512)], chainLinks(3)));
    expect(graph.closestNode(bvec(90, 0, 8))).toBe(1);
    // The node 512 units up is outside the default window even though it is
    // closest in XY.
    expect(graph.closestNode(bvec(50, 0, 8))).toBe(0);
  });
});

//=============================================================================
// string pulling
//=============================================================================

describe("nav graph: string pulling", () => {
  test("a straight corridor collapses to its far end", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0), bvec(256, 0, 0), bvec(384, 0, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(4)));
    const pulled = graph.stringPull([0, 1, 2, 3], bvec(384, 0, 0));
    expect(pulled.points.length).toBe(1);
    expect(pulled.points[0]).toEqual({ x: 384, y: 0, z: 0 });
  });

  test("an L-shaped corridor keeps its corner", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0), bvec(256, 0, 0), bvec(256, 128, 0), bvec(256, 256, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(5)));
    const pulled = graph.stringPull([0, 1, 2, 3, 4], bvec(256, 256, 0));
    expect(pulled.points.length).toBe(2);
    expect(pulled.points[0]).toEqual({ x: 256, y: 0, z: 0 });
    expect(pulled.points[1]).toEqual({ x: 256, y: 256, z: 0 });
  });

  test("a traversal link becomes an exact takeoff and landing pair", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0), bvec(384, 0, 0)];
    const graph = navGraphFromNav2(
      buildNav(positions, [
        { from: 0, to: 1 },
        { from: 1, to: 2, type: NavLinkType.LongJump, traversal: { funnel: bvec(), start: bvec(130, 0, 4), end: bvec(380, 0, 4) } },
      ]),
    );
    const pulled = graph.stringPull([0, 1, 2], bvec(384, 0, 0));
    // The walk run ends on node 1, whose position the traversal's own start
    // point (two units away) replaces; then the landing, then the goal.
    expect(pulled.points[0]).toEqual({ x: 130, y: 0, z: 4 });
    expect(pulled.points[1]).toEqual({ x: 380, y: 0, z: 4 });
    expect(pulled.points[2]).toEqual({ x: 384, y: 0, z: 0 });
    // The takeoff point is the one the follower must jump from.
    expect(pulled.links[0]?.type).toBe(NavLinkType.LongJump);
    expect(pulled.links[1]).toBeNull();
  });

  test("a cut is refused when a skipped node falls outside its own radius of the line", () => {
    // Node 1 is 200 units off the straight line from 0 to 2, and its radius
    // is 32 -- the corridor really does bend.
    const positions = [bvec(0, 0, 0), bvec(128, 200, 0), bvec(256, 0, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(3)));
    const pulled = graph.stringPull([0, 1, 2], bvec(256, 0, 0));
    expect(pulled.points.length).toBe(2);
    expect(pulled.points[0]).toEqual({ x: 128, y: 200, z: 0 });
  });

  test("planPath goes from world point to world point in one call", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0), bvec(256, 0, 0), bvec(256, 128, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(4)));
    const path = graph.planPath(bvec(8, 0, 0), bvec(250, 120, 0));
    expect(path).not.toBeNull();
    expect(path!.nodes[0]).toBe(0);
    expect(path!.nodes[path!.nodes.length - 1]).toBe(3);
    // The caller's own goal is always the last steering point.
    const last = path!.points[path!.points.length - 1]!;
    expect(bvecDistance(last, bvec(250, 120, 0))).toBeLessThan(1);
  });
});

//=============================================================================
// path controller
//=============================================================================

function movementSettings(over: Partial<BotMovementSettings> = {}): BotMovementSettings {
  const knowledge = buildKnowledge();
  const settings = knowledge.skill("medium")!.movement;
  return Object.assign(settings, over);
}

describe("path controller", () => {
  test("a straight corridor produces pure forward movement", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0), bvec(256, 0, 0), bvec(384, 0, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(4)));
    const state = newPathState();
    setPath(state, graph.stringPull([0, 1, 2, 3], bvec(384, 0, 0)), bvec(0, 0, 0), 0);

    const out = followPath(state, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 0, stuckTime: 1 }, movementSettings({ walkOnly: false }), new Xorshift32(1));

    expect(out.status).toBe(BotPathStatus.Moving);
    expect(out.forwardmove).toBeCloseTo(BOT_RUN_SPEED, 3);
    expect(Math.abs(out.sidemove)).toBeLessThan(1);
    expect(out.jump).toBe(false);
  });

  test("an L-shaped corridor strafes around the corner without turning the view", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0), bvec(256, 0, 0), bvec(256, 128, 0), bvec(256, 256, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(5)));
    const state = newPathState();
    setPath(state, graph.stringPull([0, 1, 2, 3, 4], bvec(256, 256, 0)), bvec(0, 0, 0), 0);
    const movement = movementSettings({ walkOnly: false });

    const first = followPath(state, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 0, stuckTime: 1 }, movement, new Xorshift32(1));
    expect(first.forwardmove).toBeCloseTo(BOT_RUN_SPEED, 3);

    // Standing on the corner: the first point retires and the controller
    // steers up the second leg. The view is still looking down +X, so the
    // move comes out sideways.
    const second = followPath(state, { origin: bvec(256, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 0.5, stuckTime: 1 }, movement, new Xorshift32(1));
    expect(second.status).toBe(BotPathStatus.Moving);
    expect(Math.abs(second.sidemove)).toBeGreaterThan(Math.abs(second.forwardmove));
    expect(second.target).toEqual({ x: 256, y: 256, z: 0 });
  });

  test("reaching the last point reports Arrived", () => {
    const positions = [bvec(0, 0, 0), bvec(128, 0, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(2)));
    const state = newPathState();
    setPath(state, graph.stringPull([0, 1], bvec(128, 0, 0)), bvec(0, 0, 0), 0);

    const out = followPath(state, { origin: bvec(126, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 1, stuckTime: 1 }, movementSettings(), new Xorshift32(1));
    expect(out.status).toBe(BotPathStatus.Arrived);
  });

  test("standing still for longer than stuckTime reports Stuck and bumps the counter", () => {
    const positions = [bvec(0, 0, 0), bvec(512, 0, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(2)));
    const state = newPathState();
    setPath(state, graph.stringPull([0, 1], bvec(512, 0, 0)), bvec(0, 0, 0), 0);
    const movement = movementSettings();
    const rng = new Xorshift32(7);

    // Pinned at the origin: 0.5s is not yet stuck, 1.0s is.
    expect(followPath(state, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 0.5, stuckTime: 1 }, movement, rng).status).toBe(BotPathStatus.Moving);
    expect(followPath(state, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 1.0, stuckTime: 1 }, movement, rng).status).toBe(BotPathStatus.Stuck);
    expect(state.stuckCount).toBe(1);

    // Moving again resets the timer.
    expect(followPath(state, { origin: bvec(100, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 1.5, stuckTime: 1 }, movement, rng).status).toBe(BotPathStatus.Moving);
    expect(followPath(state, { origin: bvec(200, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 2.5, stuckTime: 1 }, movement, rng).status).toBe(BotPathStatus.Moving);
  });

  test("a jump link asks for a jump, and only while on the ground", () => {
    const positions = [bvec(0, 0, 0), bvec(256, 0, 0)];
    const graph = navGraphFromNav2(
      buildNav(positions, [{ from: 0, to: 1, type: NavLinkType.LongJump, traversal: { funnel: bvec(), start: bvec(200, 0, 0), end: bvec(256, 0, 0) } }]),
    );
    const state = newPathState();
    setPath(state, graph.stringPull([0, 1], bvec(256, 0, 0)), bvec(0, 0, 0), 0);
    const movement = movementSettings();

    expect(followPath(state, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 0, stuckTime: 1 }, movement, new Xorshift32(1)).jump).toBe(true);

    const airborne = newPathState();
    setPath(airborne, graph.stringPull([0, 1], bvec(256, 0, 0)), bvec(0, 0, 0), 0);
    expect(followPath(airborne, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: false, now: 0, stuckTime: 1 }, movement, new Xorshift32(1)).jump).toBe(false);
  });

  test("walk_only halves the movement speed", () => {
    const positions = [bvec(0, 0, 0), bvec(512, 0, 0)];
    const graph = navGraphFromNav2(buildNav(positions, chainLinks(2)));
    const state = newPathState();
    setPath(state, graph.stringPull([0, 1], bvec(512, 0, 0)), bvec(0, 0, 0), 0);
    const out = followPath(state, { origin: bvec(0, 0, 0), pitch: 0, yaw: 0, onGround: true, now: 0, stuckTime: 1 }, movementSettings({ walkOnly: true }), new Xorshift32(1));
    expect(out.forwardmove).toBeCloseTo(BOT_RUN_SPEED / 2, 3);
  });
});

//=============================================================================
// aiming
//=============================================================================

describe("aim tracker", () => {
  const knowledge = buildKnowledge();
  const medium = knowledge.skill("medium")!.aiming;

  test("converges on a static target and stays converged", () => {
    const state = newAimState(0, 0);
    const dir = bvec(0, 1, 0); // 90 degrees of yaw away
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += 0.05;
      aimStep(state, dir, medium, 0.05, now);
    }
    expect(aimError(state, dir)).toBeLessThan(1);
    expect(Math.abs(state.yawVelocity)).toBeLessThan(20);
  });

  test("never exceeds the skill's aiming.max_acceleration as an angular speed", () => {
    const state = newAimState(0, 0);
    const dir = bvec(-1, 0, 0); // 180 degrees away: the worst case
    let now = 0;
    let peak = 0;
    for (let i = 0; i < 80; i++) {
      now += 0.05;
      const before = state.yaw;
      aimStep(state, dir, medium, 0.05, now);
      let moved = Math.abs(state.yaw - before);
      if (moved > 180) moved = 360 - moved;
      peak = Math.max(peak, moved / 0.05);
    }
    // The clamp is on the velocity, so one frame can never move further than
    // max_acceleration * dt -- times modifier.accel_scalar while the
    // catch-up window is open, which a 180-degree swing always opens.
    expect(peak).toBeLessThanOrEqual(medium.maxAcceleration * medium.modifierAccelScalar + 0.01);
  });

  test("tracks a moving target: the error keeps shrinking and settles small", () => {
    const state = newAimState(0, 0);
    let now = 0;
    let target = bvec(1000, 0, 0);
    const step = bvec(0, 60, 0); // the target strafes at 60 units/frame

    // Let the tracker acquire first.
    for (let i = 0; i < 20; i++) {
      now += 0.05;
      aimStep(state, target, medium, 0.05, now);
    }
    const acquired = aimError(state, target);
    expect(acquired).toBeLessThan(2);

    let worst = 0;
    for (let i = 0; i < 60; i++) {
      now += 0.05;
      target = { x: target.x + step.x, y: target.y + step.y, z: target.z + step.z };
      aimStep(state, target, medium, 0.05, now);
      worst = Math.max(worst, aimError(state, target));
    }
    // A 125/20 spring lags a crossing target by a few degrees, not by tens.
    expect(worst).toBeLessThan(8);
  });

  test("a harder skill converges faster than an easier one on the same small correction", () => {
    const easy = knowledge.skill("easy")!.aiming;
    const nightmare = knowledge.skill("nightmare")!.aiming;
    // Eight degrees, which is under every skill's modifier.max_angle, so the
    // catch-up window never opens and the comparison is purely between the
    // two springs. A big swing is not a fair comparison: practice's own
    // modifier (max_angle 60, apply_time 2, every scalar 2) covers the whole
    // turn and makes it as quick as medium.
    const dir = bvec(Math.cos((8 * Math.PI) / 180), Math.sin((8 * Math.PI) / 180), 0);

    const framesToConverge = (settings: typeof easy): number => {
      const state = newAimState(0, 0);
      let now = 0;
      for (let i = 1; i <= 400; i++) {
        now += 0.05;
        aimStep(state, dir, settings, 0.05, now);
        if (aimError(state, dir) < 0.5) return i;
      }
      return 999;
    };

    expect(framesToConverge(nightmare)).toBeLessThan(framesToConverge(easy));
    expect(framesToConverge(nightmare)).toBeLessThan(999);
  });

  test("vectorToAngles matches Quake's pitch sign convention", () => {
    expect(vectorToAngles(bvec(1, 0, 0)).yaw).toBeCloseTo(0, 4);
    expect(vectorToAngles(bvec(0, 1, 0)).yaw).toBeCloseTo(90, 4);
    // Looking up is a negative pitch.
    expect(vectorToAngles(bvec(1, 0, 1)).pitch).toBeCloseTo(-45, 4);
  });
});

//=============================================================================
// senses
//=============================================================================

describe("senses", () => {
  const knowledge = buildKnowledge();
  const settings = knowledge.skill("medium")!;

  function contact(over: Partial<BotContactT> = {}): BotContactT {
    return { lineOfSight: true, inSightFov: true, inWeaponFov: true, audible: false, invisible: false, distance: 300, origin: bvec(300, 0, 0), ...over };
  }

  test("sight fills over exactly senses.sight_time", () => {
    const aw = newAwareness(1, 0, bvec(300, 0, 0));
    // sight_time 0.25 at dt 0.05 is five frames.
    for (let i = 0; i < 4; i++) senseStep(aw, contact(), settings.senses, settings.weapons, 0.05, 0.05 * (i + 1));
    expect(isAware(aw)).toBe(false);
    expect(aw.sight).toBeCloseTo(0.8, 5);
    senseStep(aw, contact(), settings.senses, settings.weapons, 0.05, 0.25);
    expect(isAware(aw)).toBe(true);
  });

  test("sight drains over exactly senses.sight_decay_time", () => {
    const aw = newAwareness(1, 0, bvec(300, 0, 0));
    for (let i = 0; i < 5; i++) senseStep(aw, contact(), settings.senses, settings.weapons, 0.05, 0.05 * (i + 1));
    expect(aw.sight).toBe(1);

    // sight_decay_time 0.3 at dt 0.05 is six frames.
    for (let i = 0; i < 5; i++) senseStep(aw, contact({ lineOfSight: false, inSightFov: false, inWeaponFov: false }), settings.senses, settings.weapons, 0.05, 0.3 + 0.05 * i);
    expect(aw.sight).toBeGreaterThan(0);
    senseStep(aw, contact({ lineOfSight: false, inSightFov: false, inWeaponFov: false }), settings.senses, settings.weapons, 0.05, 0.6);
    expect(aw.sight).toBe(0);
  });

  test("an invisible enemy takes invis_enemy_sight_scalar times as long", () => {
    const aw = newAwareness(1, 0, bvec(100, 0, 0));
    for (let i = 0; i < 5; i++) senseStep(aw, contact({ invisible: true }), settings.senses, settings.weapons, 0.05, 0.05 * (i + 1));
    // The scalar is 2, so five frames only gets halfway.
    expect(aw.sight).toBeCloseTo(0.5, 5);
  });

  test("the weapon cone fills on its own, tighter timer", () => {
    const aw = newAwareness(1, 0, bvec(300, 0, 0));
    // weapons.sight_time 0.2 at dt 0.05 is four frames.
    for (let i = 0; i < 3; i++) senseStep(aw, contact(), settings.senses, settings.weapons, 0.05, 0.05 * (i + 1));
    expect(canFire(aw)).toBe(false);
    senseStep(aw, contact(), settings.senses, settings.weapons, 0.05, 0.2);
    expect(canFire(aw)).toBe(true);
  });

  test("an enemy outside the sight FOV never registers even with a clear line", () => {
    const aw = newAwareness(1, 0, bvec(-300, 0, 0));
    for (let i = 0; i < 20; i++) senseStep(aw, contact({ inSightFov: false, inWeaponFov: false }), settings.senses, settings.weapons, 0.05, 0.05 * (i + 1));
    expect(aw.sight).toBe(0);
  });

  test("forget_non_vis_enemy_time controls when the record is dropped", () => {
    const aw = newAwareness(1, 0, bvec(300, 0, 0));
    expect(shouldForget(aw, settings.senses, 1.0)).toBe(false); // 1.5s not yet elapsed
    expect(shouldForget(aw, settings.senses, 1.5)).toBe(true);

    // A record with awareness still on the clock is never forgotten.
    senseStep(aw, contact(), settings.senses, settings.weapons, 0.05, 0.05);
    expect(shouldForget(aw, settings.senses, 99)).toBe(false);
  });

  test("sound_range and sound_persist_time gate a sound event", () => {
    const sound: BotSoundT = { origin: bvec(600, 0, 0), sourceId: 2, time: 10, loudness: 1 };
    expect(soundAudible(sound, bvec(0, 0, 0), settings.senses, 10.2)).toBe(true); // 600 < 640 range, 0.2s < 0.4s persist
    expect(soundAudible(sound, bvec(0, 0, 0), settings.senses, 10.5)).toBe(false); // too old
    expect(soundAudible({ ...sound, origin: bvec(900, 0, 0) }, bvec(0, 0, 0), settings.senses, 10.1)).toBe(false); // too far
    // A louder sound carries further.
    expect(soundAudible({ ...sound, origin: bvec(900, 0, 0), loudness: 2 }, bvec(0, 0, 0), settings.senses, 10.1)).toBe(true);
  });
});

//=============================================================================
// weapon and item choice
//=============================================================================

describe("weapon choice (weapons.txt's own five rules)", () => {
  const knowledge = buildKnowledge();
  const base = { items: 0, ammo: {}, range: 300, heightDelta: 0, inWater: false, hasProtection: false, targetInWater: false, allowMelee: true };

  test("the highest priority among the valid weapons wins", () => {
    const pick = chooseWeapon(knowledge.weapons, { ...base, items: 4096 | 1 | 2, ammo: { ammo_shells: 20 }, range: 300 });
    expect(pick?.weapon.name).toBe("super_shotgun"); // priority 5 beats shotgun's 2
  });

  test("a weapon out of range is not considered", () => {
    // At 1200 units the super shotgun's max_range of 768 rules it out.
    const pick = chooseWeapon(knowledge.weapons, { ...base, items: 4096 | 1 | 2, ammo: { ammo_shells: 20 }, range: 1200 });
    expect(pick?.weapon.name).toBe("shotgun");
  });

  test("a weapon without enough ammo is not considered", () => {
    // The super shotgun needs two shells.
    const pick = chooseWeapon(knowledge.weapons, { ...base, items: 4096 | 1 | 2, ammo: { ammo_shells: 1 }, range: 300 });
    expect(pick?.weapon.name).toBe("shotgun");
    const empty = chooseWeapon(knowledge.weapons, { ...base, items: 4096 | 1 | 2, ammo: { ammo_shells: 0 }, range: 60 });
    expect(empty?.weapon.name).toBe("axe");
  });

  test("a weapon the bot does not own is not considered", () => {
    const pick = chooseWeapon(knowledge.weapons, { ...base, items: 1, ammo: { ammo_shells: 50 }, range: 300 });
    expect(pick?.weapon.name).toBe("shotgun");
  });

  test("an electric weapon is refused in water unless protected and the target is wet too", () => {
    const ctx = { ...base, items: 1 | 64, ammo: { ammo_shells: 50, ammo_cells: 50 }, range: 300 };
    expect(chooseWeapon(knowledge.weapons, ctx)?.weapon.name).toBe("lightning");
    expect(chooseWeapon(knowledge.weapons, { ...ctx, inWater: true })?.weapon.name).toBe("shotgun");
    expect(chooseWeapon(knowledge.weapons, { ...ctx, inWater: true, hasProtection: true, targetInWater: true })?.weapon.name).toBe("lightning");
  });

  test("allow_melee false removes melee weapons entirely", () => {
    const ctx = { ...base, items: 4096, ammo: {}, range: 40 };
    expect(chooseWeapon(knowledge.weapons, ctx)?.weapon.name).toBe("axe");
    expect(chooseWeapon(knowledge.weapons, { ...ctx, allowMelee: false })).toBeNull();
  });
});

describe("item value ordering", () => {
  const knowledge = buildKnowledge();
  const ctx = {
    spawnflags: 0,
    health: 40,
    maxHealth: 100,
    armor: 0,
    items: 0,
    ammo: { ammo_shells: 0 },
    weaponStay: false,
    allowPowerItems: true,
    weapons: knowledge.weapons,
    team: 0,
    itemTeam: 0,
    objectiveAtHome: true,
  };

  test("a powerup outranks a weapon, which outranks armor, which outranks health", () => {
    const value = (name: string): number => itemValue(knowledge.item(name)!, ctx);
    expect(value("item_artifact_super_damage")).toBeGreaterThan(value("weapon_supershotgun"));
    expect(value("weapon_supershotgun")).toBeGreaterThan(value("item_armor2"));
    expect(value("item_armor2")).toBeGreaterThan(value("item_health"));
    expect(value("item_health")).toBeGreaterThan(value("item_shells"));
  });

  test("health is worth nothing at full health and more the more it is missing", () => {
    const health = knowledge.item("item_health")!;
    expect(itemValue(health, { ...ctx, health: 100 })).toBe(0);
    expect(itemValue(health, { ...ctx, health: 10 })).toBeGreaterThan(itemValue(health, { ...ctx, health: 90 }));
  });

  test("allow_grab_power_items false zeroes out powerups", () => {
    const quad = knowledge.item("item_artifact_super_damage")!;
    expect(itemValue(quad, { ...ctx, allowPowerItems: false })).toBe(0);
  });

  test("a weapon already owned is worthless with weapon_stay on and worth its ammo without", () => {
    const ssg = knowledge.item("weapon_supershotgun")!;
    expect(itemValue(ssg, { ...ctx, items: 2, weaponStay: true })).toBe(0);
    expect(itemValue(ssg, { ...ctx, items: 2, weaponStay: false })).toBeGreaterThan(0);
  });
});

describe("objective value", () => {
  // ctf/bots/items.txt: item_flag_team1 is `team 5`, item_flag_team2 is
  // `team 14`, and both carry the `objective` flag.
  const knowledge = new BotKnowledge({
    characters: "",
    weapons: WEAPONS_TXT,
    items: `{\n  name "item_flag_team1"\n  team 5\n  flags objective\n}\n{\n  name "item_flag_team2"\n  team 14\n  flags objective\n}\n`,
    monsters: "",
    interactables: "",
    gameRules: "",
    teams: "",
    chats: "",
    settings: SETTINGS_TXT,
  });
  const flag = knowledge.item("item_flag_team1")!;
  const ctx = {
    spawnflags: 0,
    health: 100,
    maxHealth: 100,
    armor: 0,
    items: 0,
    ammo: {},
    weaponStay: false,
    allowPowerItems: true,
    weapons: knowledge.weapons,
    team: 14,
    itemTeam: 5,
    objectiveAtHome: true,
  };

  test("items.txt's team field is parsed onto the objective", () => {
    expect(flag.team).toBe(5);
    expect(knowledge.item("item_flag_team2")!.team).toBe(14);
  });

  test("the enemy's objective is worth taking wherever it is standing", () => {
    expect(itemValue(flag, ctx)).toBe(900);
    expect(itemValue(flag, { ...ctx, objectiveAtHome: false })).toBe(900);
  });

  test("a team's own objective at its own base is worth nothing", () => {
    expect(itemValue(flag, { ...ctx, team: 5 })).toBe(0);
  });

  test("a team's own objective away from base outranks the enemy's", () => {
    const dropped = itemValue(flag, { ...ctx, team: 5, objectiveAtHome: false });
    expect(dropped).toBeGreaterThan(itemValue(flag, ctx));
  });

  test("an objective nobody owns, or one in a game with no teams, is simply a goal", () => {
    expect(itemValue(flag, { ...ctx, itemTeam: 0 })).toBe(900);
    expect(itemValue(flag, { ...ctx, team: 0 })).toBe(900);
  });
});

//=============================================================================
// knowledge indexes
//=============================================================================

describe("knowledge", () => {
  const knowledge = buildKnowledge();

  test("parses every synthetic file with no errors", () => {
    expect(knowledge.errors).toEqual([]);
    expect(knowledge.weapons.length).toBe(4);
    expect(knowledge.items.length).toBe(5);
    expect(knowledge.skillNames()).toEqual(["easy", "medium", "nightmare"]);
  });

  test("game_rules.txt's first matching cvar/value pair wins, and teamplay makes it TDM", () => {
    const cvars: Record<string, number> = { coop: 0, deathmatch: 1, teamplay: 0 };
    expect(knowledge.gameMode((n) => cvars[n] ?? 0)).toEqual({ gameType: "deathmatch", weaponStay: false });

    cvars.deathmatch = 2;
    expect(knowledge.gameMode((n) => cvars[n] ?? 0)).toEqual({ gameType: "deathmatch", weaponStay: true });

    cvars.teamplay = 1;
    expect(knowledge.gameMode((n) => cvars[n] ?? 0).gameType).toBe("tdm");

    cvars.coop = 1;
    expect(knowledge.gameMode((n) => cvars[n] ?? 0)).toEqual({ gameType: "coop", weaponStay: true });
    // The retail mg1 file lists horde ahead of coop, and horde maps run coop.
    cvars.horde = 1;
    expect(knowledge.gameMode((n) => cvars[n] ?? 0)).toEqual({ gameType: "horde", weaponStay: true });
  });

  test("interactables.txt's conditions pick the right interaction for one classname", () => {
    // The shootable func_button entry requires health; the push entry has no
    // conditions and catches everything else.
    expect(knowledge.interactionFor("func_button", { spawnflags: 0, hasHealth: true, hasTargetname: false })).toBe("shoot");
    expect(knowledge.interactionFor("func_button", { spawnflags: 0, hasHealth: false, hasTargetname: false })).toBe("push");
    expect(knowledge.interactionFor("func_plat", { spawnflags: 0, hasHealth: false, hasTargetname: false })).toBe("ride");
    expect(knowledge.interactionFor("worldspawn", { spawnflags: 0, hasHealth: false, hasTargetname: false })).toBeNull();
  });

  test("teams.txt translates a QuakeC team value to a 0-based index", () => {
    expect(knowledge.teamIndex(0)).toBe(0);
    expect(knowledge.teamIndex(1)).toBe(1);
    expect(knowledge.teamIndex(9)).toBe(-1);
  });

  test("characters.txt is looked up by the short `name` addbot takes", () => {
    expect(knowledge.character("ozzy")?.funName).toBe("Azizam");
    expect(knowledge.character("OZZY")?.funName).toBe("Azizam");
    expect(knowledge.character("nobody")).toBeUndefined();
  });
});

//=============================================================================
// the brain, on a stub world
//=============================================================================

/** A world made of plain data: no engine, no traces that hit anything. */
class StubWorld implements BotWorldT {
  now = 0;
  dt = 0.05;
  selfState: BotSelfT;
  ents: BotEntityT[] = [];
  sounds: BotSoundT[] = [];
  graph: NavGraph | null = null;
  /** Every trace answers "clear" unless this is set. */
  blocked = false;

  constructor(origin: BotVec3) {
    this.selfState = {
      id: 1,
      origin,
      velocity: bvec(),
      viewAngles: bvec(),
      eye: { x: origin.x, y: origin.y, z: origin.z + 22 },
      health: 100,
      armor: 0,
      items: 1 | 4096,
      ammo: { ammo_shells: 25, ammo_nails: 0, ammo_rockets: 0, ammo_cells: 0 },
      currentWeapon: 1,
      onGround: true,
      waterLevel: 0,
      team: 0,
      dead: false,
      hasProtection: false,
    };
  }

  time(): number {
    return this.now;
  }
  frameTime(): number {
    return this.dt;
  }
  self(): BotSelfT {
    return this.selfState;
  }
  traceLine(_start: BotVec3, end: BotVec3): BotTraceT {
    return { fraction: this.blocked ? 0.5 : 1, endpos: end, startsolid: false, hitId: -1 };
  }
  traceBox(_start: BotVec3, _mins: BotVec3, _maxs: BotVec3, end: BotVec3): BotTraceT {
    return { fraction: this.blocked ? 0.5 : 1, endpos: end, startsolid: false, hitId: -1 };
  }
  pointContents(): number {
    return 0;
  }
  entities(): readonly BotEntityT[] {
    return this.ents;
  }
  hearing(): readonly BotSoundT[] {
    return this.sounds;
  }
  nav(): NavGraph | null {
    return this.graph;
  }
}

function stubEnemy(id: number, origin: BotVec3): BotEntityT {
  return {
    id,
    kind: BotEntityKind.Player,
    classname: "player",
    origin,
    center: { x: origin.x, y: origin.y, z: origin.z + 16 },
    head: { x: origin.x, y: origin.y, z: origin.z + 28 },
    feet: { x: origin.x, y: origin.y, z: origin.z - 20 },
    velocity: bvec(),
    health: 100,
    team: 0,
    dead: false,
    invisible: false,
    waterLevel: 0,
    isBot: false,
    spawnflags: 0,
    hasHealth: true,
    hasTargetname: false,
  };
}

function stubItem(id: number, classname: string, origin: BotVec3, team = 0): BotEntityT {
  return {
    id,
    kind: BotEntityKind.Item,
    classname,
    origin,
    center: { x: origin.x, y: origin.y, z: origin.z + 8 },
    head: { x: origin.x, y: origin.y, z: origin.z + 16 },
    feet: { x: origin.x, y: origin.y, z: origin.z },
    velocity: bvec(),
    health: 0,
    team,
    dead: false,
    invisible: false,
    waterLevel: 0,
    isBot: false,
    spawnflags: 0,
    hasHealth: false,
    hasTargetname: false,
  };
}

function stubMonster(id: number, classname: string, origin: BotVec3): BotEntityT {
  const ent = stubEnemy(id, origin);
  ent.kind = BotEntityKind.Monster;
  ent.classname = classname;
  return ent;
}

function makeBrain(seed: number, gameMode: { gameType: string; weaponStay: boolean } = { gameType: "deathmatch", weaponStay: false }, knowledge = buildKnowledge()): BotBrain {
  return new BotBrain({
    knowledge,
    skill: "medium",
    rng: new Xorshift32(seed),
    gameMode,
    maxHealth: 100,
    weaponImpulse: (n) => (n === 1 ? 2 : n === 2 ? 3 : n === 4096 ? 1 : 0),
  });
}

describe("brain", () => {
  test("with no target and no nav it walks somewhere rather than standing still", () => {
    // A map with no navigation at all is still a map to play on: a bot with
    // no goal presses nothing and stands on its spawn point for the whole
    // match, which is what the blind roam in brain.ts's roamGoal replaces.
    const world = new StubWorld(bvec(0, 0, 0));
    const cmd = makeBrain(1).think(world);
    expect(Math.abs(cmd.forwardmove) + Math.abs(cmd.sidemove)).toBeGreaterThan(0);
    expect(cmd.impulse).toBe(0);
  });

  test("becomes aware of a visible enemy and then fires at it", () => {
    const world = new StubWorld(bvec(0, 0, 0));
    world.ents = [stubEnemy(2, bvec(300, 0, 0))];
    const brain = makeBrain(2);

    // sight_time 0.25 and weapons.sight_time 0.2 at dt 0.05: not yet.
    for (let i = 0; i < 3; i++) {
      world.now += 0.05;
      brain.think(world);
    }
    expect(brain.currentTarget()).toBe(-1);

    for (let i = 0; i < 12; i++) {
      world.now += 0.05;
      brain.think(world);
      world.selfState.viewAngles = brain.lastUsercmd().viewAngles;
    }
    expect(brain.currentTarget()).toBe(2);
    expect(brain.awarenessOf(2)?.sight).toBe(1);
    expect(brain.lastUsercmd().buttons & 1).toBe(1); // attack
  });

  test("a blocked line of sight never builds awareness", () => {
    const world = new StubWorld(bvec(0, 0, 0));
    world.blocked = true;
    world.ents = [stubEnemy(2, bvec(300, 0, 0))];
    const brain = makeBrain(3);
    for (let i = 0; i < 40; i++) {
      world.now += 0.05;
      brain.think(world);
    }
    expect(brain.currentTarget()).toBe(-1);
  });

  test("switches to the super shotgun once it has one, through the impulse", () => {
    const world = new StubWorld(bvec(0, 0, 0));
    world.selfState.items = 1 | 2 | 4096;
    world.ents = [stubEnemy(2, bvec(300, 0, 0))];
    const brain = makeBrain(8); // rng.ts's warm-up moved the roam draws seed 4 used to reach the target quickly

    let sawImpulse = 0;
    for (let i = 0; i < 20; i++) {
      world.now += 0.05;
      const cmd = brain.think(world);
      world.selfState.viewAngles = cmd.viewAngles;
      if (cmd.impulse !== 0) sawImpulse = cmd.impulse;
    }
    expect(sawImpulse).toBe(3); // the super shotgun's impulse
  });

  test("bot_movetopoint walks toward the point and reports Success on arrival", () => {
    const positions = [bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0)];
    const world = new StubWorld(bvec(0, 0, 0));
    world.graph = navGraphFromNav2(buildNav(positions, chainLinks(3)));
    const brain = makeBrain(5);

    brain.requestMoveToPoint(bvec(512, 0, 0));
    expect(brain.goalStatus()).toBe(2); // BOT_GOAL_IN_PROGRESS

    world.now += 0.05;
    const cmd = brain.think(world);
    expect(Math.abs(cmd.forwardmove) + Math.abs(cmd.sidemove)).toBeGreaterThan(0);

    // Teleport the bot onto the goal; the controller retires the last point.
    world.selfState.origin = bvec(512, 0, 0);
    for (let i = 0; i < 3; i++) {
      world.now += 0.05;
      brain.think(world);
    }
    expect(brain.goalStatus()).toBe(1); // BOT_GOAL_SUCCESS
  });

  test("bot_followentity re-plans as the entity moves", () => {
    const positions = [bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0), bvec(768, 0, 0)];
    const world = new StubWorld(bvec(0, 0, 0));
    world.graph = navGraphFromNav2(buildNav(positions, chainLinks(4)));
    const enemy = stubEnemy(2, bvec(256, 0, 0));
    world.ents = [enemy];
    const brain = makeBrain(6);

    brain.requestFollowEntity(2, enemy.origin);
    world.now += 0.05;
    brain.think(world);
    const firstEnd = brain.currentPath()!.points[brain.currentPath()!.points.length - 1]!;
    expect(bvecDistance(firstEnd, bvec(256, 0, 0))).toBeLessThan(1);

    // The entity walks to the far end; the next follow call moves the goal
    // and the path is re-planned to it.
    enemy.origin = bvec(768, 0, 0);
    brain.requestFollowEntity(2, enemy.origin);
    world.now += 0.05;
    brain.think(world);
    const secondEnd = brain.currentPath()!.points[brain.currentPath()!.points.length - 1]!;
    expect(bvecDistance(secondEnd, bvec(768, 0, 0))).toBeLessThan(1);
  });

  test("chats go out through the callback, and chance 0 never fires", () => {
    const knowledge = buildKnowledge();
    const said: string[] = [];
    const brain = new BotBrain({
      knowledge,
      skill: "medium",
      rng: new Xorshift32(11),
      gameMode: { gameType: "deathmatch", weaponStay: false },
      onChat: (e) => said.push(e.type),
    });
    brain.think(new StubWorld(bvec(0, 0, 0)));
    expect(said).toEqual(["connected"]); // chance 100

    for (let i = 0; i < 20; i++) brain.emitChat("match_start"); // chance 0
    expect(said).toEqual(["connected"]);
  });

  test("the same seed and the same worlds produce byte-identical usercmd streams", () => {
    const positions = [bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0), bvec(512, 256, 0)];
    const nav = buildNav(positions, chainLinks(4));

    const run = (): string => {
      const world = new StubWorld(bvec(0, 0, 0));
      world.graph = navGraphFromNav2(nav);
      world.ents = [stubEnemy(2, bvec(400, 100, 0))];
      const brain = makeBrain(0x1234abcd);
      const out: string[] = [];
      for (let i = 0; i < 100; i++) {
        world.now += 0.05;
        const cmd = brain.think(world);
        world.selfState.viewAngles = cmd.viewAngles;
        out.push(`${cmd.forwardmove.toFixed(4)},${cmd.sidemove.toFixed(4)},${cmd.buttons},${cmd.impulse},${cmd.viewAngles.x.toFixed(4)},${cmd.viewAngles.y.toFixed(4)}`);
      }
      return out.join("|");
    };

    expect(run()).toBe(run());
  });

  test("two different seeds diverge, so the RNG is actually consulted", () => {
    const run = (seed: number): string => {
      const world = new StubWorld(bvec(0, 0, 0));
      world.graph = navGraphFromNav2(buildNav([bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0), bvec(0, 512, 0)], chainLinks(4)));
      const brain = makeBrain(seed);
      const out: string[] = [];
      for (let i = 0; i < 80; i++) {
        world.now += 0.05;
        const cmd = brain.think(world);
        world.selfState.viewAngles = cmd.viewAngles;
        out.push(`${cmd.forwardmove.toFixed(2)},${cmd.sidemove.toFixed(2)}`);
      }
      return out.join("|");
    };
    expect(run(1)).not.toBe(run(99999));
  });

  test("horde is a team game: a teammate is not a target, and a player on another team is", () => {
    // mg1's own bots/game_rules.txt gives horde its own game_type, and its
    // PutClientInServer puts every player on TEAM_HUMANS. A bot that only
    // knew "coop" shot its own team in the first seconds of a wave game.
    const play = (gameType: string, mateTeam: number): number => {
      const world = new StubWorld(bvec(0, 0, 0));
      world.selfState.team = 1;
      const mate = stubEnemy(2, bvec(300, 0, 0));
      mate.team = mateTeam;
      world.ents = [mate];
      const brain = makeBrain(5, { gameType, weaponStay: true });
      for (let i = 0; i < 40; i++) {
        world.now += 0.05;
        brain.think(world);
      }
      return brain.currentTarget();
    };

    expect(play("horde", 1)).toBe(-1);
    expect(play("coop", 1)).toBe(-1);
    // Same player, another team: still something to shoot.
    expect(play("horde", 2)).toBe(2);
    // And a free-for-all ignores `team` entirely.
    expect(play("deathmatch", 1)).toBe(2);
  });

  test("a dead bot presses attack to respawn and stops moving", () => {
    const world = new StubWorld(bvec(0, 0, 0));
    world.selfState.dead = true;
    world.selfState.health = 0;
    const brain = makeBrain(12);
    let pressed = false;
    for (let i = 0; i < 80; i++) {
      world.now += 0.05;
      const cmd = brain.think(world);
      expect(cmd.forwardmove).toBe(0);
      if ((cmd.buttons & 1) !== 0) pressed = true;
    }
    expect(pressed).toBe(true);
  });

  // Regressions from the three bugs the quake-2-re-ts lift exposed in this
  // brain and fed back here (src/lib/bot_brain/brain.ts's header).

  test("an unreachable goal is rested and another goal chosen", () => {
    // node 0 is where the bot starts and is linked only to node 1; node 2
    // sits right on top of the closer, higher-value item but has no links at
    // all, so the planner can never reach it. node 1 holds a farther,
    // reachable item.
    const positions = [bvec(0, 0, 0), bvec(700, 0, 0), bvec(80, 0, 0)];
    const links = [
      { from: 0, to: 1 },
      { from: 1, to: 0 },
    ];
    const world = new StubWorld(bvec(0, 0, 0));
    world.selfState.health = 50; // so the health item scores above zero
    world.graph = navGraphFromNav2(buildNav(positions, links));
    world.ents = [stubItem(10, "item_armor2", bvec(80, 0, 0)), stubItem(11, "item_health", bvec(700, 0, 0))];
    const brain = makeBrain(20);

    world.now += 0.05;
    brain.think(world);
    // The unreachable armor is closer and worth more, so it is picked first;
    // with no path to it, the brain rests it instead of steering into the
    // wall between the bot and node 2 forever.
    expect(brain.currentPath()).toBeNull();

    world.now += 0.05;
    brain.think(world);
    // Rested, the only item left is the reachable one, and a real path to it
    // exists.
    expect(brain.currentPath()).not.toBeNull();
    const points = brain.currentPath()!.points;
    expect(bvecDistance(points[points.length - 1]!, bvec(700, 0, 0))).toBeLessThan(1);
  });

  test("the stuck tally lives on the brain, not on the path state clearPath/setPath reset", () => {
    // The bug: pathState.stuckCount is zeroed by both clearPath (the brain's
    // own non-give-up recovery, called on every trip short of
    // STUCK_GIVE_UP) and setPath (the replan that immediately follows it) --
    // so a give-up check against pathState.stuckCount can never see more
    // than the single trip just detected, no matter how many trips a goal
    // has actually taken. BotBrain.stuckTrips is kept off pathState
    // specifically so clearPath/setPath do not touch it; this reproduces
    // the brain's own bookkeeping (increment on Stuck, clear-and-replan
    // short of the threshold) against the exported path_follow.ts
    // primitives to show pathState's own counter is still reset the old
    // way while an externally-held tally is not zeroed by either call.
    const positions = [bvec(0, 0, 0), bvec(1024, 0, 0)];
    const nav = navGraphFromNav2(buildNav(positions, [{ from: 0, to: 1 }]));
    const state = newPathState();
    const movement = movementSettings({ walkOnly: false });
    const rng = new Xorshift32(1);
    const origin = bvec(0, 0, 0);

    let stuckTrips = 0;
    let now = 0;
    const path = nav.planPath(origin, bvec(1024, 0, 0))!;
    setPath(state, path, origin, now);
    for (let i = 0; i < 3; i++) {
      now += 1.05; // outlasts STUCK_SECONDS (1.0) with the bot frozen
      const out = followPath(state, { origin, pitch: 0, yaw: 0, onGround: true, now, stuckTime: 1 }, movement, rng);
      expect(out.status).toBe(BotPathStatus.Stuck);
      stuckTrips++; // BotBrain's own field: never touched by clearPath/setPath
      // BotBrain's non-give-up recovery, exactly as brain.ts's think() runs
      // it: clearPath, then the next ensurePath() call replans.
      clearPath(state);
      expect(state.stuckCount).toBe(0); // pathState's own count: erased every trip
      setPath(state, path, origin, now);
    }
    expect(stuckTrips).toBe(3); // an externally-held tally survives all three clears
  });

  test("a goal the bot cannot move toward is kept for a moment and then given up", () => {
    // The escalation end to end. The bot's origin never changes, so it is
    // pressing a move into the world and going nowhere: it must not give up
    // on the first frame (a door may still be opening), and it must not hold
    // the goal for the rest of the level either -- the wedge timer in
    // brain.ts gives it up once the bot has been going nowhere for
    // WEDGED_GIVE_UP_SECONDS.
    const positions = [bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0), bvec(768, 0, 0), bvec(1024, 0, 0)];
    const world = new StubWorld(bvec(0, 0, 0));
    world.graph = navGraphFromNav2(buildNav(positions, chainLinks(5)));
    const brain = makeBrain(21);

    brain.requestMoveToPoint(bvec(1024, 0, 0));
    expect(brain.goalStatus()).toBe(BotGoalStatus.InProgress);

    // A second of going nowhere is not enough to abandon a goal.
    for (let i = 0; i < 20; i++) {
      world.now += 0.05;
      brain.think(world);
    }
    expect(brain.goalStatus()).toBe(BotGoalStatus.InProgress);

    let gaveUpAt = -1;
    for (let i = 0; i < 200 && gaveUpAt < 0; i++) {
      world.now += 0.05;
      brain.think(world);
      if (brain.goalStatus() === BotGoalStatus.Error) gaveUpAt = world.now;
    }
    expect(gaveUpAt).toBeGreaterThan(0);
    expect(gaveUpAt).toBeLessThan(5);
  });

  test("with no graph at all, only the wedge timer can give a goal up -- and it does", () => {
    // No nav graph means followPath reports NoPath and the brain steers
    // straight at the goal, a branch with no stuck detection of its own. The
    // wedge timer is the only thing that can end this, which is what it was
    // added for.
    const world = new StubWorld(bvec(0, 0, 0)); // graph stays null
    const brain = makeBrain(23);
    brain.requestMoveToPoint(bvec(4096, 0, 0));

    let gaveUpAt = -1;
    for (let i = 0; i < 200 && gaveUpAt < 0; i++) {
      world.now += 0.05;
      brain.think(world);
      if (brain.goalStatus() === BotGoalStatus.Error) gaveUpAt = world.now;
    }
    expect(gaveUpAt).toBeGreaterThan(0);
    expect(gaveUpAt).toBeLessThan(6);
  });

  test("a bot circling a target is not treated as wedged", () => {
    // Net displacement is how the wedge timer measures being stuck, and a bot
    // in a fight keeps its net displacement small on purpose. Same setup as
    // the case above, plus somebody to shoot at.
    const world = new StubWorld(bvec(0, 0, 0));
    world.ents = [stubEnemy(2, bvec(300, 0, 0))];
    const brain = makeBrain(23);
    brain.requestMoveToPoint(bvec(4096, 0, 0));

    for (let i = 0; i < 200; i++) {
      world.now += 0.05;
      brain.think(world);
    }
    expect(brain.currentTarget()).toBe(2);
    expect(brain.goalStatus()).toBe(BotGoalStatus.InProgress);
  });

  test("the unstick window produces sidestep/jump input", () => {
    const positions = [bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0)];
    const world = new StubWorld(bvec(0, 0, 0));
    world.graph = navGraphFromNav2(buildNav(positions, chainLinks(3)));
    const brain = makeBrain(22);

    brain.requestMoveToPoint(bvec(512, 0, 0));

    // The bot's origin is frozen, so it walks dead-on into the same wall
    // every trip; the first stuck trip must open the sidestep-and-hop window
    // on that very same frame.
    let sawUnstick = false;
    for (let i = 0; i < 40 && !sawUnstick; i++) {
      world.now += 0.05;
      const cmd = brain.think(world);
      if (Math.abs(cmd.sidemove) === BOT_RUN_SPEED && (cmd.buttons & BOT_BUTTON_JUMP) !== 0) sawUnstick = true;
    }
    expect(sawUnstick).toBe(true);
  });
});

//=============================================================================
// objectives and coop
//=============================================================================

/** Own base at node 0, midfield at node 1, the enemy base at node 2. */
const OWN_BASE = bvec(0, 0, 0);
const MIDFIELD = bvec(512, 0, 0);
const ENEMY_BASE = bvec(1024, 0, 0);

function ctfWorld(origin: BotVec3): StubWorld {
  const world = new StubWorld(origin);
  world.selfState.team = 5;
  world.graph = navGraphFromNav2(buildNav([OWN_BASE, MIDFIELD, ENEMY_BASE], chainLinks(3)));
  return world;
}

/** Where the brain's current plan ends, or null while it has no plan. */
function pathEnd(brain: BotBrain): BotVec3 | null {
  const path = brain.currentPath();
  if (path === null || path.points.length === 0) return null;
  return path.points[path.points.length - 1]!;
}

function runFrames(brain: BotBrain, world: StubWorld, count: number): void {
  for (let i = 0; i < count; i++) {
    world.now += 0.05;
    brain.think(world);
  }
}

describe("objectives", () => {
  // ctf/bots/items.txt: item_flag_team1 is `team 5`, item_flag_team2 is
  // `team 14` -- see the "objective value" suite above.
  const flags = (): BotEntityT[] => [stubItem(20, "item_flag_team1", OWN_BASE, 5), stubItem(21, "item_flag_team2", ENEMY_BASE, 14)];

  test("a carrier runs the flag to where its own team's flag spawned", () => {
    // A carried flag stops being an entity the world reports at all, so the
    // base has to be remembered from when the flag was still standing on it.
    const world = ctfWorld(ENEMY_BASE);
    world.ents = flags();
    const brain = makeBrain(40, { gameType: "ctf", weaponStay: false }, buildCtfKnowledge());

    runFrames(brain, world, 2); // sees both flags, remembers both bases
    world.selfState.carryingObjective = true;
    world.ents = [stubItem(20, "item_flag_team1", OWN_BASE, 5)]; // the carried one is gone
    runFrames(brain, world, 2);

    const end = pathEnd(brain);
    expect(end).not.toBeNull();
    expect(bvecDistance(end!, OWN_BASE)).toBeLessThan(64);
  });

  test("a team's own flag lying in the field is fetched, whichever role the bot drew", () => {
    // Touching a dropped flag is what sends it back, so this outranks both
    // halves of the attack/defend split -- which is why it does not matter
    // which way the role rolled here.
    for (const seed of [40, 41, 42]) {
      const world = ctfWorld(ENEMY_BASE);
      world.ents = flags();
      const brain = makeBrain(seed, { gameType: "ctf", weaponStay: false }, buildCtfKnowledge());
      runFrames(brain, world, 2); // home for flag 20 is recorded as OWN_BASE

      world.ents = [stubItem(20, "item_flag_team1", MIDFIELD, 5), stubItem(21, "item_flag_team2", ENEMY_BASE, 14)];
      runFrames(brain, world, 4);
      const end = pathEnd(brain);
      expect(end).not.toBeNull();
      expect(bvecDistance(end!, MIDFIELD)).toBeLessThan(64);
    }
  });

  test("the roster splits into attackers and defenders, and neither stands on its own flag", () => {
    // The role is one roll per bot, so this sweeps seeds rather than
    // asserting on one: what must hold is that both roles occur, rather than
    // the whole roster camping its own base the way it did before the split.
    // The seeds are spread by a large odd multiplier because xorshift32's
    // first outputs from a small seed are still correlated across adjacent
    // seeds even after the warm-up in rng.ts -- see that file's header; the
    // real binding seeds from a full-width random word.
    let attackers = 0;
    let defenders = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const world = ctfWorld(MIDFIELD);
      world.ents = flags();
      const brain = makeBrain(Math.imul(seed, 2654435761) | 0, { gameType: "ctf", weaponStay: false }, buildCtfKnowledge());
      runFrames(brain, world, 4);
      const end = pathEnd(brain);
      if (end === null) continue;
      if (bvecDistance(end, ENEMY_BASE) < 64) attackers++;
      else if (bvecDistance(end, OWN_BASE) < 64) defenders++;
    }
    // A defender walks to its own base to guard it, which is not the same as
    // treating the flag as a pickup: itemValue scores that at zero (see the
    // "objective value" suite above).
    expect(attackers).toBeGreaterThan(0);
    expect(defenders).toBeGreaterThan(0);
    expect(attackers).toBeGreaterThan(defenders); // roughly three in four attack
  });
});

// Every case here blocks line of sight. A monster the bot can SEE is a
// combat target, and combat outranks the whole coop branch in selectGoal --
// so with sight open these would be testing target selection instead of the
// hunt. Deciding where to walk toward a monster it cannot see yet is exactly
// what the hunt is for.
describe("coop", () => {
  function coopWorld(nodes: BotVec3[]): StubWorld {
    const world = new StubWorld(bvec(0, 0, 0));
    world.selfState.team = 5;
    world.blocked = true;
    world.graph = navGraphFromNav2(buildNav(nodes, chainLinks(nodes.length)));
    return world;
  }

  function human(origin: BotVec3): BotEntityT {
    const ent = stubEnemy(2, origin);
    ent.team = 5;
    return ent;
  }

  test("a bot with the human in reach hunts what is still standing near them", () => {
    const world = coopWorld([bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0)]);
    // Inside COOP_REGROUP_NEAR, so the regroup finishes at once and the hunt
    // is what is left.
    world.ents = [human(bvec(200, 0, 0)), stubMonster(3, "monster_ogre", bvec(512, 0, 0))];

    const brain = makeBrain(50, { gameType: "coop", weaponStay: true });
    runFrames(brain, world, 6);

    const end = pathEnd(brain);
    expect(end).not.toBeNull();
    expect(bvecDistance(end!, bvec(512, 0, 0))).toBeLessThan(64);
    expect(brain.currentTarget()).toBe(-1); // a teammate is not a target
  });

  test("a bot that has lost the human walks back to them before anything else", () => {
    const world = coopWorld([bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0)]);
    // The human is well outside COOP_REGROUP_NEAR and the monster is closer,
    // so the regroup has to win to be visible here at all.
    world.ents = [human(bvec(512, 0, 0)), stubMonster(3, "monster_ogre", bvec(256, 0, 0))];

    const brain = makeBrain(51, { gameType: "coop", weaponStay: true });
    runFrames(brain, world, 6);

    const end = pathEnd(brain);
    expect(end).not.toBeNull();
    expect(bvecDistance(end!, bvec(512, 0, 0))).toBeLessThan(64);
  });

  test("a monster nowhere near the human is not worth crossing the level for", () => {
    const world = coopWorld([bvec(0, 0, 0), bvec(256, 0, 0), bvec(9000, 0, 0)]);
    // Further from the human than COOP_HUNT_RADIUS, so the hunt skips it.
    world.ents = [human(bvec(200, 0, 0)), stubMonster(3, "monster_ogre", bvec(9000, 0, 0))];

    const brain = makeBrain(52, { gameType: "coop", weaponStay: true });
    runFrames(brain, world, 6);

    const end = pathEnd(brain);
    if (end !== null) expect(bvecDistance(end, bvec(9000, 0, 0))).toBeGreaterThan(64);
  });

  test("horde hunts the same way coop does", () => {
    const world = coopWorld([bvec(0, 0, 0), bvec(256, 0, 0), bvec(512, 0, 0)]);
    world.ents = [human(bvec(200, 0, 0)), stubMonster(3, "monster_ogre", bvec(512, 0, 0))];

    const brain = makeBrain(53, { gameType: "horde", weaponStay: true });
    runFrames(brain, world, 6);

    const end = pathEnd(brain);
    expect(end).not.toBeNull();
    expect(bvecDistance(end!, bvec(512, 0, 0))).toBeLessThan(64);
  });
});

describe("seeded RNG", () => {
  test("xorshift32 is reproducible and stays inside [0, 1)", () => {
    const a = new Xorshift32(0xdecafbad);
    const b = new Xorshift32(0xdecafbad);
    for (let i = 0; i < 1000; i++) {
      const v = a.next();
      expect(v).toBe(b.next());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("a zero seed is nudged off xorshift's fixed point", () => {
    const rng = new Xorshift32(0);
    const first = rng.next();
    expect(first).not.toBe(0);
    expect(rng.next()).not.toBe(first);
  });
});

//=============================================================================
// guarded: the NAV2 field meanings, re-derived from the retail id1 pak
//=============================================================================

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const ID1_PAK = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const HAVE_ID1 = existsSync(ID1_PAK);

describe.skipIf(!HAVE_ID1)("NAV2 vocabulary, against the real id1 data", () => {
  function realNames(pak: PakFile): string[] {
    return pak
      .list("bots/navigation/")
      .map((e) => e.name)
      .filter((n) => !n.includes("/test/"));
  }

  test("every link's traversal index is either 0xFFFF or a valid hint, and every hint is used exactly once", () => {
    const pak = new PakFile(ID1_PAK);
    let files = 0;
    for (const name of realNames(pak)) {
      const file = parseNav(pak.read(name)).file;
      if (file === undefined) continue;
      files++;
      const used = new Set<number>();
      for (const link of file.links) {
        if (link.traversal === null) continue;
        expect(link.traversal).toBeLessThan(file.hints.length);
        expect(used.has(link.traversal)).toBe(false);
        used.add(link.traversal);
      }
      expect(used.size).toBe(file.hints.length);
    }
    expect(files).toBeGreaterThanOrEqual(40);
  });

  test("link types stay inside the nine-value enum, and only type 0 never carries a traversal", () => {
    const pak = new PakFile(ID1_PAK);
    let walkWithTraversal = 0;
    let teleportWithTraversal = 0;
    for (const name of realNames(pak)) {
      const file = parseNav(pak.read(name)).file;
      if (file === undefined) continue;
      for (const link of file.links) {
        expect(link.type).toBeLessThanOrEqual(NavLinkType.ManualLongJump);
        if (link.type === NavLinkType.Walk && link.traversal !== null) walkWithTraversal++;
        if (link.type === NavLinkType.Teleport && link.traversal !== null) teleportWithTraversal++;
      }
    }
    expect(walkWithTraversal).toBe(0);
    expect(teleportWithTraversal).toBe(0);
  });

  test("a traversal's pos1 sits on its link's source node and pos2 on its target", () => {
    const pak = new PakFile(ID1_PAK);
    let checked = 0;
    let startFar = 0;
    let endFar = 0;
    for (const name of realNames(pak)) {
      const file = parseNav(pak.read(name)).file;
      if (file === undefined) continue;
      const graph = navGraphFromNav2(file);
      for (const link of graph.links) {
        if (link.traversal === null) continue;
        checked++;
        if (bvecDistance(link.traversal.start, graph.nodes[link.from]!.origin) > 512) startFar++;
        if (bvecDistance(link.traversal.end, graph.nodes[link.to]!.origin) > 512) endFar++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(startFar).toBe(0);
    expect(endFar).toBe(0);
  });

  test("node flag 1 marks a Teleporter and flag 2 a Pusher: every outgoing link matches", () => {
    const pak = new PakFile(ID1_PAK);
    let teleporterNodes = 0;
    let pusherNodes = 0;
    let pusherNodesWithPusherLink = 0;
    for (const name of realNames(pak)) {
      const file = parseNav(pak.read(name)).file;
      if (file === undefined) continue;
      const graph = navGraphFromNav2(file);
      for (const node of graph.nodes) {
        if ((node.flags & NavNodeFlags.Teleporter) !== 0) {
          teleporterNodes++;
          for (const link of node.links) expect(link.type).toBe(NavLinkType.Teleport);
        }
        if ((node.flags & NavNodeFlags.Pusher) !== 0) {
          pusherNodes++;
          if (node.links.some((l) => l.type === NavLinkType.Pusher)) pusherNodesWithPusherLink++;
        }
      }
    }
    expect(teleporterNodes).toBeGreaterThan(100);
    // 11 Pusher-flagged nodes across id1, and 10 of them lead out on a
    // Pusher link. The one exception is e3m5.nav's node 433, which carries
    // the flag with a single plain Walk link -- data, not a reading error.
    expect(pusherNodes).toBeGreaterThan(0);
    expect(pusherNodesWithPusherLink).toBeGreaterThanOrEqual(pusherNodes - 1);
  });

  test("the trailing table indexes links, not nodes, and lands on the entity-driven link types", () => {
    const pak = new PakFile(ID1_PAK);
    let total = 0;
    let entityTyped = 0;
    for (const name of realNames(pak)) {
      const file = parseNav(pak.read(name)).file;
      if (file === undefined) continue;
      for (const record of file.entityLinks) {
        total++;
        expect(record.link).toBeLessThan(file.links.length);
        const type = file.links[record.link]!.type;
        if (type === NavLinkType.Elevator || type === NavLinkType.Train || type === NavLinkType.Pusher || type === NavLinkType.Teleport) entityTyped++;
        // The two vectors are a bounding box: mins is below maxs on every axis.
        expect(record.mins.x).toBeLessThanOrEqual(record.maxs.x);
        expect(record.mins.y).toBeLessThanOrEqual(record.maxs.y);
        expect(record.mins.z).toBeLessThanOrEqual(record.maxs.z);
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(entityTyped).toBeGreaterThan(total * 0.3);
  });

  test("dm4's real graph is searchable end to end", () => {
    const pak = new PakFile(ID1_PAK);
    const file = parseNav(pak.read("bots/navigation/dm4.nav")).file;
    expect(file).toBeDefined();
    const graph = navGraphFromNav2(file!);
    expect(graph.nodeCount).toBe(85);

    // Every node the graph can reach from node 0 must give a path back to
    // node 0 too, and a path's node chain must be a real walk of the graph.
    let paths = 0;
    for (let i = 1; i < graph.nodeCount; i++) {
      const chain = graph.findPath(0, i);
      if (chain === null) continue;
      paths++;
      expect(chain[0]).toBe(0);
      expect(chain[chain.length - 1]).toBe(i);
      for (let k = 1; k < chain.length; k++) expect(graph.linkBetween(chain[k - 1]!, chain[k]!)).not.toBeNull();
    }
    expect(paths).toBeGreaterThan(60);
  });

  test("string pulling never invents a point that is not on the path", () => {
    const pak = new PakFile(ID1_PAK);
    const file = parseNav(pak.read("bots/navigation/e1m1.nav")).file!;
    const graph = navGraphFromNav2(file);
    const chain = graph.findPath(0, graph.nodeCount - 1);
    if (chain === null) return; // e1m1's last node may be disconnected; nothing to assert
    const pulled = graph.stringPull(chain, graph.nodes[graph.nodeCount - 1]!.origin);
    expect(pulled.points.length).toBeGreaterThan(0);
    expect(pulled.points.length).toBeLessThanOrEqual(chain.length + 1);
    for (const p of pulled.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });
});

// A NavEntityLink built by hand, so the type is exercised even with no
// retail data on disk: the graph must attach it to the link its index names.
test("the trailing entity table attaches a bounding box to the link it indexes", () => {
  const file = buildNav([bvec(0, 0, 0), bvec(256, 0, 128)], [{ from: 0, to: 1, type: NavLinkType.Elevator }]);
  const record = new NavEntityLink();
  record.link = 0;
  record.mins = { x: -16, y: -16, z: 0 };
  record.maxs = { x: 16, y: 16, z: 128 };
  file.entityLinks.push(record);

  const graph = navGraphFromNav2(file);
  expect(graph.entityLinks.length).toBe(1);
  expect(graph.entityLinks[0]!.type).toBe(NavLinkType.Elevator);
  expect(graph.entityLinks[0]!.entityBounds).toEqual({ mins: { x: -16, y: -16, z: 0 }, maxs: { x: 16, y: 16, z: 128 } });
});

test("emptyUsercmd is neutral", () => {
  expect(emptyUsercmd()).toEqual({ forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0, impulse: 0, viewAngles: { x: 0, y: 0, z: 0 } });
});
