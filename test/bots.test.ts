/*
src/bots: bot client slots, the nav binding and the three re-release
navigation builtins, against a real running server.

Self-sufficient per standing order 13: this file builds its own scratch
basedir (id1/pak0.pak with progs106's progs.dat, the synthetic maps/world.bsp,
a hand-written bots/*.txt set and a hand-encoded NAV2 file), boots a real
`-dedicated` host with Host_Init, and restores every process-wide singleton
it touches in afterAll.

The second half is guarded on the retail 2021 tree being reachable
(Q1TS_RERELEASE_DATA, or ../qfiles/q1/rerelease): it boots a second host
straight out of the retail paks and runs bots on dm4 and monsters on e1m1
with their real .nav files.
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_InitArgv, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Cmd_ExecuteString, CmdSourceT, cmdHost } from "../src/common/cmd";
import { Cvar_SetValue, setCvarServerHooks } from "../src/common/cvar";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../src/common/wad";
import { QuakeParmsT } from "../src/common/quakedef";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { getNetHostHooks, net_activeconnections, setNetActiveConnections, setNetHostHooks } from "../src/common/net_main";
import { FL_MONSTER, sv, svState, svs } from "../src/server/server";
import { EDICT_NUM, PR_GetString } from "../src/progs/progs";
import { ED_FindFunction } from "../src/progs/pr_edict";
import { pr_builtin } from "../src/progs/pr_cmds";
import { setBuiltins } from "../src/progs/pr_exec";
import { Host_Init, host } from "../src/common/host";
import { SV_Physics } from "../src/server/sv_phys";
import { SV_RunClients } from "../src/server/sv_user";
import { SV_ClientIsBot, SV_SendClientMessages } from "../src/server/sv_main";
import { vec3 } from "../src/common/mathlib";
import { HAVE_PROGS106, PROGS106_DAT } from "./support/fixture_availability";
import { WORLDSPAWN_MODELS } from "./support/dedicated_fixture";
import {
  Bot_Add,
  Bot_ClearMonsterPaths,
  Bot_ClearNav,
  Bot_Count,
  Bot_ForgetKnowledge,
  Bot_ForgetMapdb,
  Bot_GoalBuiltins,
  Bot_Knowledge,
  Bot_MonsterPath,
  Bot_Nav,
  Bot_RemoveAll,
  Bot_SkillName,
  Bot_Slots,
  Bot_WalkPathToGoal,
  FL_ISBOT,
} from "../src/bots";
import { PATH_ERROR, PATH_IN_PROGRESS, PATH_MOVE_BLOCKED, PATH_REACHED_GOAL, PATH_REACHED_PATH_END, BOT_GOAL_ERROR, BOT_GOAL_IN_PROGRESS } from "../src/progs/ext/qex_hooks";
import { defaultTraverseCaps } from "../src/lib/bot_brain/nav_graph";

//=============================================================================
// process-wide state this file changes, captured for afterAll
//=============================================================================

const savedNostdout = sysState.nostdout;
const savedIsDedicated = sysState.isDedicated;
const savedCmdInitialized = cmdHost.initialized;
const savedNetHooks = getNetHostHooks();
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
const savedActiveConnections = net_activeconnections;

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "bots-test-"));
const baseDir = join(scratchDir, "quake");

afterAll(() => {
  Bot_RemoveAll();
  Bot_ClearNav();
  Bot_ClearMonsterPaths();
  Bot_ForgetKnowledge();
  Bot_ForgetMapdb();

  sysState.nostdout = savedNostdout;
  sysState.isDedicated = savedIsDedicated;
  cmdHost.initialized = savedCmdInitialized;
  setNetHostHooks(savedNetHooks);
  setHostShutdown(null);
  setCvarServerHooks(null);
  setNetActiveConnections(savedActiveConnections);
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;
  svState.host_client = null;
  svState.sv_player = null;
  sv.clear();
  rmSync(scratchDir, { recursive: true, force: true });
});

//=============================================================================
// the synthetic basedir
//=============================================================================

// The smallest legal WAD2 -- Host_Init calls W_LoadWadFile("gfx.wad")
// unconditionally, dedicated or not.
function buildWad2(): Uint8Array {
  const lumpData = new Uint8Array([1, 2, 3, 4]);
  const infotableofs = WADINFO_T_SIZE + lumpData.length;
  const buf = new ArrayBuffer(infotableofs + LUMPINFO_T_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 1, true);
  view.setInt32(8, infotableofs, true);
  bytes.set(lumpData, WADINFO_T_SIZE);
  view.setInt32(infotableofs, WADINFO_T_SIZE, true);
  view.setInt32(infotableofs + 4, lumpData.length, true);
  view.setInt32(infotableofs + 8, lumpData.length, true);
  const name = "CONCHARS";
  for (let i = 0; i < name.length; i++) bytes[infotableofs + 16 + i] = name.charCodeAt(i);
  return bytes;
}

/**
 * buildBsp()'s synthetic map ships one info_player_start and nothing else,
 * and progs106's SelectSpawnPoint spins forever looking for an
 * info_player_deathmatch when `deathmatch` is on -- the VM answers that with
 * "runaway loop error", which is the real game's behaviour on a map with no
 * deathmatch spawns, not a bug here. Rather than teach the shared builder a
 * new option, this appends a replacement entity lump to the end of the file
 * and repoints lump 0 at it: every other lump's offset is unchanged, because
 * a BSP locates its lumps by offset and length.
 */
function withDeathmatchSpawns(bsp: Uint8Array, spawns: Array<[number, number, number]>): Uint8Array {
  const LUMP_ENTITIES = 0;
  const view = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  const oldOfs = view.getInt32(4 + LUMP_ENTITIES * 8, true);
  const oldLen = view.getInt32(4 + LUMP_ENTITIES * 8 + 4, true);

  let text = "";
  for (let i = 0; i < oldLen; i++) {
    const c = bsp[oldOfs + i]!;
    if (c === 0) break;
    text += String.fromCharCode(c);
  }
  for (const [x, y, z] of spawns) text += `{\n"classname" "info_player_deathmatch"\n"origin" "${x} ${y} ${z}"\n"angle" "0"\n}\n`;

  const tail = latin1Bytes(text + "\0");
  const padded = (bsp.length + 3) & ~3;
  const out = new Uint8Array(padded + tail.length);
  out.set(bsp, 0);
  out.set(tail, padded);
  const outView = new DataView(out.buffer);
  outView.setInt32(4 + LUMP_ENTITIES * 8, padded, true);
  outView.setInt32(4 + LUMP_ENTITIES * 8 + 4, tail.length, true);
  return out;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * A version-15 NAV2 file, encoded exactly the way src/lib/nav.ts's header
 * documents the layout: header, node records, positions, link records, hint
 * records, then a uint32 entity-table count.
 */
function buildNavFile(positions: Array<[number, number, number]>, edges: Array<[number, number]>): Uint8Array {
  const byNode: number[][] = positions.map(() => []);
  for (const [from, to] of edges) byNode[from]!.push(to);

  const nodeCount = positions.length;
  const linkCount = edges.length;
  const size = 20 + nodeCount * 8 + nodeCount * 12 + linkCount * 6 + 4;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);

  bytes[0] = "N".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "V".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 15, true);
  view.setInt32(8, nodeCount, true);
  view.setInt32(12, linkCount, true);
  view.setInt32(16, 0, true); // no traversals

  let first = 0;
  for (let i = 0; i < nodeCount; i++) {
    const base = 20 + i * 8;
    view.setUint16(base, 0, true); // flags
    view.setUint16(base + 2, byNode[i]!.length, true);
    view.setUint16(base + 4, first, true);
    view.setUint16(base + 6, 32, true); // radius
    first += byNode[i]!.length;
  }

  const posOff = 20 + nodeCount * 8;
  for (let i = 0; i < nodeCount; i++) {
    const base = posOff + i * 12;
    view.setFloat32(base, positions[i]![0], true);
    view.setFloat32(base + 4, positions[i]![1], true);
    view.setFloat32(base + 8, positions[i]![2], true);
  }

  const linkOff = posOff + nodeCount * 12;
  let k = 0;
  for (let i = 0; i < nodeCount; i++) {
    for (const target of byNode[i]!) {
      const base = linkOff + k * 6;
      view.setUint16(base, target, true);
      view.setUint16(base + 2, 0, true); // Walk
      view.setUint16(base + 4, 0xffff, true); // no traversal
      k++;
    }
  }

  view.setUint32(linkOff + linkCount * 6, 0, true); // no entity-bound links
  return bytes;
}

const SYNTH_WEAPONS = `
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
`;

const SYNTH_SETTINGS = `
skill medium
{
  aiming.max_acceleration 360
  aiming.spring_stiffness 125
  aiming.damping 20
  aiming.velocity_offset -0.1
  aiming.modifier.max_angle 30
  aiming.modifier.apply_time 0.75
  aiming.modifier.accel_scalar 1.25
  aiming.modifier.spring_scalar 1.25
  aiming.modifier.damping_scalar 1.25
  behaviors.allow_combat true
  behaviors.allow_grab_items_in_combat false
  behaviors.allow_melee true
  behaviors.allow_check_six false
  behaviors.allow_grab_items true
  behaviors.allow_grab_power_items true
  behaviors.defer_power_items_to_humans false
  behaviors.min_respawn_time 1
  behaviors.max_respawn_time 1.5
  movement.allow_jumping_in_combat true
  movement.jump_chance 35
  movement.jump_cooldown 1
  movement.walk_only false
  senses.sight_time 0.25
  senses.sight_decay_time 0.3
  senses.invis_enemy_sight_scalar 2
  senses.max_invis_enemy_sight_dist 256
  senses.fov_angle 140
  senses.forget_non_vis_enemy_time 1.5
  senses.sound_range 640
  senses.sound_time 0.4
  senses.sound_decay_time 2.5
  senses.sound_persist_time 0.4
  weapons.decay_time 2
  weapons.fov_angle 40
  weapons.sight_time 0.2
}
`;

const SYNTH_CHARACTERS = `
{
  fun_name Testbot
  name testbot
  shirt_color 4
  pants_color 11
}
{
  fun_name Otherbot
  name otherbot
  shirt_color 2
  pants_color 6
}
`;

const SYNTH_ITEMS = `
{
  name "item_health"
  spawnflags 2 = mega_item
  flags health
}
`;

const SYNTH_GAME_RULES = `
{
  cvar deathmatch
  value 1
  weapon_stay false
  game_type deathmatch
}
`;

const SYNTH_MAPDB = JSON.stringify({
  episodes: [{ dir: "id1", name: "Test" }],
  maps: [{ title: "World", bsp: "world", episode: "id1", game: "id1", sp: true, dm: true, coop: false, bots: true, ctf: false, horde: false }],
});

//=============================================================================
// synthetic-server suite
//=============================================================================

describe.skipIf(!HAVE_PROGS106)("bot client slots on a synthetic dedicated server", () => {
  beforeAll(() => {
    sysState.nostdout = 1;
    setBuiltins(pr_builtin);

    const popLmp = new Uint8Array(256);
    for (let i = 0; i < 128; i++) {
      popLmp[i * 2] = (pop[i] >> 8) & 0xff;
      popLmp[i * 2 + 1] = pop[i] & 0xff;
    }

    const entries: Array<{ name: string; data: Uint8Array }> = [
      { name: "gfx/pop.lmp", data: popLmp },
      { name: "progs.dat", data: new Uint8Array(readFileSync(PROGS106_DAT)) },
      { name: "gfx.wad", data: buildWad2() },
      { name: "bots/weapons.txt", data: latin1Bytes(SYNTH_WEAPONS) },
      { name: "bots/settings_PC.txt", data: latin1Bytes(SYNTH_SETTINGS) },
      { name: "bots/characters.txt", data: latin1Bytes(SYNTH_CHARACTERS) },
      { name: "bots/items.txt", data: latin1Bytes(SYNTH_ITEMS) },
      { name: "bots/monsters.txt", data: latin1Bytes("\n") },
      { name: "bots/interactables.txt", data: latin1Bytes("\n") },
      { name: "bots/game_rules.txt", data: latin1Bytes(SYNTH_GAME_RULES) },
      { name: "bots/teams.txt", data: latin1Bytes("\n") },
      { name: "bots/chats.txt", data: latin1Bytes("\n") },
      { name: "mapdb.json", data: latin1Bytes(SYNTH_MAPDB) },
      // A four-node square inside the synthetic world.bsp's own -256..256
      // bounds, linked both ways all the way round.
      {
        name: "bots/navigation/world.nav",
        data: buildNavFile(
          [
            [-128, -128, 0],
            [128, -128, 0],
            [128, 128, 0],
            [-128, 128, 0],
          ],
          [
            [0, 1],
            [1, 0],
            [1, 2],
            [2, 1],
            [2, 3],
            [3, 2],
            [3, 0],
            [0, 3],
          ],
        ),
      },
    ];
    for (const m of WORLDSPAWN_MODELS) entries.push({ name: m, data: m.endsWith(".spr") ? buildSpr() : buildMdl({ numframes: 2 }) });

    ensureDir(join(baseDir, "id1"));
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), entries);
    writeGameFile(
      baseDir,
      "id1/maps/world.bsp",
      withDeathmatchSpawns(buildBsp(), [
        [-96, -96, 24],
        [96, -96, 24],
        [96, 96, 24],
        [-96, 96, 24],
      ]),
    );
    writeGameFile(baseDir, "id1/quake.rc", latin1Bytes("exec default.cfg\nstuffcmds\n"));
    writeGameFile(baseDir, "id1/default.cfg", new Uint8Array(0));

    // -dedicated 4: four client slots, so several bots fit. Host_FindMaxClients
    // turns deathmatch on by itself once maxclients > 1, exactly as WinQuake does.
    const argv = ["quake", "-basedir", baseDir, "-dedicated", "4"];
    COM_InitArgv(argv);
    cmdHost.initialized = false;

    const parms = new QuakeParmsT();
    parms.basedir = baseDir;
    parms.argc = argv.length;
    parms.argv = argv;
    parms.memsize = 16 * 1024 * 1024;
    Host_Init(parms);

    Bot_ForgetKnowledge();
    Bot_ForgetMapdb();
    Bot_ClearNav();
    Cmd_ExecuteString("map world", CmdSourceT.src_command);
  });

  test("the map's own .nav is loaded at SV_SpawnServer", () => {
    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
    const nav = Bot_Nav();
    expect(nav).not.toBeNull();
    expect(nav!.nodeCount).toBe(4);
    expect(nav!.links.length).toBe(8);
  });

  test("the bots/*.txt set is read off the game filesystem", () => {
    const knowledge = Bot_Knowledge();
    expect(knowledge).not.toBeNull();
    expect(knowledge!.weapons.length).toBe(2);
    expect(knowledge!.characters.map((c) => c.name)).toEqual(["testbot", "otherbot"]);
    expect(knowledge!.skillNames()).toEqual(["medium"]);
  });

  test("bot_skill falls back to what settings_PC.txt actually ships", () => {
    // The synthetic file has one skill block, so every request resolves to it.
    expect(Bot_SkillName("medium")).toBe("medium");
    expect(Bot_SkillName("nightmare")).toBe("medium");
    expect(Bot_SkillName("3")).toBe("medium");
  });

  test("addbot creates a client slot with no socket, and the QuakeC sees it enter", () => {
    const clientnum = Bot_Add("testbot", "medium");
    expect(clientnum).toBeGreaterThanOrEqual(0);

    const client = svs.clients[clientnum]!;
    expect(client.active).toBe(true);
    expect(client.spawned).toBe(true);
    // The whole trick: an ordinary client slot with a null netconnection.
    expect(client.netconnection).toBeNull();
    expect(SV_ClientIsBot(client)).toBe(true);
    expect(client.name).toBe("Testbot");
    expect(client.colors).toBe((4 << 4) | 11);

    const ent = client.edict!;
    // PutClientInServer ran: the QuakeC gave the edict a classname, a model
    // and health, and the engine set FL_ISBOT on it.
    expect(PR_GetString(ent.v.classname)).toBe("player");
    expect(PR_GetString(ent.v.netname)).toBe("Testbot");
    expect(ent.v.health).toBeGreaterThan(0);
    expect((ent.v.flags | 0) & FL_ISBOT).toBe(FL_ISBOT);
    expect(ent.v.colormap).toBe(clientnum + 1);

    Bot_RemoveAll();
  });

  test("a usercmd is produced for the bot every server frame", () => {
    const clientnum = Bot_Add("testbot", "medium");
    const client = svs.clients[clientnum]!;
    const ent = client.edict!;

    host.frametime = 0.05;
    const angleSamples: number[] = [];
    let movedFrames = 0;

    for (let f = 0; f < 40; f++) {
      sv.time += 0.05;
      // The bot's own cmd is cleared first, so anything found afterwards was
      // produced this frame rather than left over from the last one.
      client.cmd.forwardmove = 0;
      client.cmd.sidemove = 0;
      SV_RunClients();
      SV_Physics();
      angleSamples.push(ent.v.v_angle[1]!);
      if (client.cmd.forwardmove !== 0 || client.cmd.sidemove !== 0) movedFrames++;
    }

    // A finite view angle written every frame, and real movement asked for on
    // most of them: the bot has a nav graph and a roam goal.
    for (const a of angleSamples) expect(Number.isFinite(a)).toBe(true);
    expect(movedFrames).toBeGreaterThan(20);

    Bot_RemoveAll();
  });

  test("SV_RunClients never drops a bot even though NET_GetMessage would answer -1", () => {
    const clientnum = Bot_Add("testbot", "medium");
    host.frametime = 0.05;
    for (let f = 0; f < 20; f++) {
      sv.time += 0.05;
      SV_RunClients();
    }
    expect(svs.clients[clientnum]!.active).toBe(true);
    expect(Bot_Count()).toBe(1);
    Bot_RemoveAll();
  });

  test("SV_SendClientMessages skips bots instead of failing their send", () => {
    const clientnum = Bot_Add("testbot", "medium");
    const client = svs.clients[clientnum]!;
    // Something in the message buffer would, for a real client, be handed to
    // NET_SendMessage(null) and drop the slot.
    client.message.cursize = 1;
    client.message.data[0] = 0;

    SV_SendClientMessages();

    expect(client.active).toBe(true);
    expect(Bot_Count()).toBe(1);
    Bot_RemoveAll();
  });

  test("addbot random picks unused characters, and the server fills up", () => {
    const a = Bot_Add("random", "");
    const b = Bot_Add("random", "");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(a).not.toBe(b);
    const names = [...Bot_Slots().values()].map((s) => s.name).sort();
    expect(names).toEqual(["Otherbot", "Testbot"]);

    // Four slots, four bots; the fifth has nowhere to go.
    Bot_Add("random", "");
    Bot_Add("random", "");
    expect(Bot_Count()).toBe(4);
    expect(Bot_Add("random", "")).toBe(-1);

    Bot_RemoveAll();
    expect(Bot_Count()).toBe(0);
  });

  test("kickbot by name removes exactly that bot, and `kickbot all` removes the rest", () => {
    Bot_Add("testbot", "");
    Bot_Add("otherbot", "");
    expect(Bot_Count()).toBe(2);

    Cmd_ExecuteString("kickbot Testbot", CmdSourceT.src_command);
    expect(Bot_Count()).toBe(1);
    expect([...Bot_Slots().values()][0]!.name).toBe("Otherbot");

    // The freed slot is genuinely free again.
    const freed = svs.clients.findIndex((c) => !c.active);
    expect(freed).toBeGreaterThanOrEqual(0);

    Cmd_ExecuteString("kickbot all", CmdSourceT.src_command);
    expect(Bot_Count()).toBe(0);
    for (const c of svs.clients) expect(c.active).toBe(false);
  });

  test("kicking a bot runs ClientDisconnect and clears FL_ISBOT", () => {
    const clientnum = Bot_Add("testbot", "");
    const ent = svs.clients[clientnum]!.edict!;
    expect((ent.v.flags | 0) & FL_ISBOT).toBe(FL_ISBOT);

    Cmd_ExecuteString("kickbot all", CmdSourceT.src_command);
    expect((ent.v.flags | 0) & FL_ISBOT).toBe(0);
    expect(svs.clients[clientnum]!.active).toBe(false);
  });

  test("bot_count auto-fills a map mapdb.json flags for bots, and only in deathmatch", () => {
    Bot_RemoveAll();
    Cvar_SetValue("bot_count", 2);
    Cvar_SetValue("deathmatch", 1);
    Cmd_ExecuteString("map world", CmdSourceT.src_command);
    expect(Bot_Count()).toBe(2);

    Bot_RemoveAll();
    Cvar_SetValue("deathmatch", 0);
    Cmd_ExecuteString("map world", CmdSourceT.src_command);
    expect(Bot_Count()).toBe(0);

    Cvar_SetValue("bot_count", 0);
    Cvar_SetValue("deathmatch", 1);
    Bot_RemoveAll();
  });

  test("progs106 has no Bot_PreThink/Bot_PostThink, and the bots run anyway", () => {
    // ARCHITECTURE.md: "under 1.06 progs they still path and fight, without
    // the hook calls".
    expect(ED_FindFunction("Bot_PreThink")).toBeNull();
    expect(ED_FindFunction("Bot_PostThink")).toBeNull();

    Cmd_ExecuteString("map world", CmdSourceT.src_command);
    const clientnum = Bot_Add("testbot", "");
    host.frametime = 0.05;
    for (let f = 0; f < 20; f++) {
      sv.time += 0.05;
      SV_RunClients();
      SV_Physics();
    }
    expect(svs.clients[clientnum]!.active).toBe(true);
    Bot_RemoveAll();
  });

  test("bot_movetopoint and bot_followentity answer BOT_GOAL_* for a bot and ERROR for anything else", () => {
    const clientnum = Bot_Add("testbot", "");
    const bot = svs.clients[clientnum]!.edict!;

    expect(Bot_GoalBuiltins.moveToPoint(bot, vec3(120, 120, 0))).toBe(BOT_GOAL_IN_PROGRESS);
    // The world edict is not a bot slot.
    expect(Bot_GoalBuiltins.moveToPoint(EDICT_NUM(0), vec3(0, 0, 0))).toBe(BOT_GOAL_ERROR);
    expect(Bot_GoalBuiltins.followEntity(bot, EDICT_NUM(0))).toBe(BOT_GOAL_ERROR);

    Bot_RemoveAll();
  });

  test("walkpathtogoal answers PATH_ERROR when the map has no navigation at all", () => {
    Bot_ClearNav();
    const monster = EDICT_NUM(0);
    expect(Bot_WalkPathToGoal(monster, 12, vec3(100, 100, 0))).toBe(PATH_ERROR);
    // Put the graph back for anything that runs after this.
    Cmd_ExecuteString("map world", CmdSourceT.src_command);
    expect(Bot_Nav()).not.toBeNull();
    Bot_RemoveAll();
  });
});

//=============================================================================
// guarded: the retail 2021 tree
//=============================================================================

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const HAVE_RERELEASE = existsSync(`${RERELEASE_DATA_DIR}/id1/pak0.pak`);

function bootRetail(maxclients: string): void {
  const argv = ["quake", "-basedir", RERELEASE_DATA_DIR, "-dedicated", maxclients];
  COM_InitArgv(argv);
  cmdHost.initialized = false;
  const parms = new QuakeParmsT();
  parms.basedir = RERELEASE_DATA_DIR;
  parms.argc = argv.length;
  parms.argv = argv;
  parms.memsize = 32 * 1024 * 1024;
  Host_Init(parms);
  Bot_ForgetKnowledge();
  Bot_ForgetMapdb();
  Bot_ClearNav();
  Bot_ClearMonsterPaths();
}

describe.skipIf(!HAVE_RERELEASE)("retail: two bots on dm4 with its real .nav", () => {
  interface Observation {
    clientnum: number;
    name: string;
    pathLength: number;
    attackFrames: number;
    itemsGained: number;
    frags: number;
    targetFrames: number;
  }
  let observations: Observation[] = [];
  let navNodes = 0;
  let runError: unknown = null;

  beforeAll(() => {
    sysState.nostdout = 1;
    setBuiltins(pr_builtin);
    Bot_RemoveAll();
    bootRetail("4");

    Cvar_SetValue("bot_count", 0);
    Cvar_SetValue("deathmatch", 1);
    Cmd_ExecuteString("map dm4", CmdSourceT.src_command);
    navNodes = Bot_Nav()?.nodeCount ?? 0;

    Bot_Add("random", "medium");
    Bot_Add("random", "medium");

    const nums = [...Bot_Slots().keys()];
    const state = nums.map((n) => {
      const ent = svs.clients[n]!.edict!;
      return { clientnum: n, name: Bot_Slots().get(n)!.name, pathLength: 0, attackFrames: 0, itemsGained: 0, frags: 0, targetFrames: 0, items0: ent.v.items | 0, prev: [ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!] };
    });

    // 20 seconds of server time at the classic 20Hz tick.
    host.frametime = 0.05;
    try {
      for (let f = 0; f < 400; f++) {
        sv.time += 0.05;
        SV_RunClients();
        SV_Physics();
        for (const s of state) {
          const ent = svs.clients[s.clientnum]!.edict!;
          if (ent.v.button0) s.attackFrames++;
          if ((Bot_Slots().get(s.clientnum)?.brain.currentTarget() ?? -1) >= 0) s.targetFrames++;
          const o: [number, number, number] = [ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!];
          const step = Math.hypot(o[0] - s.prev[0]!, o[1] - s.prev[1]!, o[2] - s.prev[2]!);
          // A respawn teleports the body across the map; that jump is not
          // walking and must not be counted as distance travelled.
          if (step < 200) s.pathLength += step;
          s.prev = o;
        }
      }
    } catch (e) {
      runError = e;
    }

    observations = state.map((s) => {
      const ent = svs.clients[s.clientnum]!.edict!;
      return { clientnum: s.clientnum, name: s.name, pathLength: s.pathLength, attackFrames: s.attackFrames, itemsGained: (ent.v.items | 0) & ~s.items0, frags: ent.v.frags, targetFrames: s.targetFrames };
    });
  });

  afterAll(() => {
    Bot_RemoveAll();
  });

  test("dm4's real .nav loads into a searchable graph", () => {
    expect(navNodes).toBe(85);
  });

  test("twenty seconds of frames run with no PR_RunError and no host error", () => {
    expect(runError).toBeNull();
  });

  test("both bots are still in the game and named from characters.txt", () => {
    expect(observations.length).toBe(2);
    for (const o of observations) {
      expect(svs.clients[o.clientnum]!.active).toBe(true);
      expect(o.name.length).toBeGreaterThan(0);
    }
  });

  test("both bots walked more than 200 units", () => {
    for (const o of observations) expect([o.name, Math.round(o.pathLength)]).toEqual([o.name, expect.any(Number)]);
    for (const o of observations) expect(o.pathLength).toBeGreaterThan(200);
  });

  test("the bots found each other: at least one held the other as a target", () => {
    const targeted = observations.reduce((a, o) => a + o.targetFrames, 0);
    expect(targeted).toBeGreaterThan(0);
  });

  test("the bots either shot at something or picked something up", () => {
    const shots = observations.reduce((a, o) => a + o.attackFrames, 0);
    const items = observations.reduce((a, o) => a + (o.itemsGained !== 0 ? 1 : 0), 0);
    expect(shots + items).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAVE_RERELEASE)("retail: monster walkpathtogoal on e1m1 with its real .nav", () => {
  interface MonsterResult {
    classname: string;
    goalDistance: number;
    pathPoints: number;
    moved: number;
    lastCode: number;
  }
  let results: MonsterResult[] = [];
  let navNodes = 0;
  let monsterCount = 0;

  beforeAll(() => {
    sysState.nostdout = 1;
    setBuiltins(pr_builtin);
    Bot_RemoveAll();
    bootRetail("1");

    // Monsters are removed at spawn time in deathmatch, so this half runs a
    // cooperative-rules level.
    Cvar_SetValue("deathmatch", 0);
    Cvar_SetValue("bot_count", 0);
    Cmd_ExecuteString("map e1m1", CmdSourceT.src_command);

    const nav = Bot_Nav();
    navNodes = nav?.nodeCount ?? 0;
    if (nav === null) return;

    // Let walkmonster_start's think chain run, which is what sets FL_MONSTER.
    host.frametime = 0.05;
    for (let f = 0; f < 10; f++) {
      sv.time += 0.05;
      SV_Physics();
    }

    const monsters = [];
    for (let i = 1; i < sv.num_edicts; i++) {
      const ent = EDICT_NUM(i);
      if (ent.free) continue;
      if (((ent.v.flags | 0) & FL_MONSTER) === 0) continue;
      monsters.push(ent);
    }
    monsterCount = monsters.length;

    // The same capabilities bot_hooks.ts gives a walking monster, used here
    // only to choose a goal the graph really can reach -- the test is about
    // walkpathtogoal stepping the monster, not about e1m1's connectivity.
    const caps = defaultTraverseCaps();
    caps.jump = false;
    caps.entityTraversal = true;
    caps.swim = false;

    for (const monster of monsters) {
      const origin = { x: monster.v.origin[0]!, y: monster.v.origin[1]!, z: monster.v.origin[2]! };
      const startNode = nav.closestNode(origin, { caps });
      if (startNode < 0) continue;

      let goalNode = -1;
      let goalDistance = 0;
      for (let i = 0; i < nav.nodeCount; i++) {
        if (i === startNode) continue;
        const node = nav.nodes[i]!;
        const d = Math.hypot(node.origin.x - origin.x, node.origin.y - origin.y, node.origin.z - origin.z);
        if (d < 600 || d <= goalDistance) continue;
        if (nav.findPath(startNode, i, caps) === null) continue;
        goalDistance = d;
        goalNode = i;
      }
      if (goalNode < 0) continue;

      const goal = nav.nodes[goalNode]!.origin;
      const before: [number, number, number] = [monster.v.origin[0]!, monster.v.origin[1]!, monster.v.origin[2]!];
      let code = PATH_ERROR;
      for (let step = 0; step < 60; step++) {
        code = Bot_WalkPathToGoal(monster, 12, vec3(goal.x, goal.y, goal.z));
        if (code === PATH_ERROR || code === PATH_REACHED_GOAL || code === PATH_REACHED_PATH_END) break;
      }
      const after = monster.v.origin;
      results.push({
        classname: PR_GetString(monster.v.classname),
        goalDistance,
        pathPoints: Bot_MonsterPath(monster.index)?.points.length ?? 0,
        moved: Math.hypot(after[0]! - before[0], after[1]! - before[1]),
        lastCode: code,
      });
    }
  });

  afterAll(() => {
    Bot_ClearMonsterPaths();
  });

  test("e1m1's real .nav loads, and the map really has monsters to walk", () => {
    expect(navNodes).toBe(318);
    expect(monsterCount).toBeGreaterThan(10);
  });

  test("every monster more than 600 units from a reachable goal gets a path, not PATH_ERROR", () => {
    expect(results.length).toBeGreaterThan(10);
    const errored = results.filter((r) => r.lastCode === PATH_ERROR);
    expect(errored.map((r) => r.classname)).toEqual([]);
  });

  test("the answers stay inside the QuakeC's own PATH_* vocabulary", () => {
    const allowed = new Set([PATH_ERROR, PATH_REACHED_GOAL, PATH_REACHED_PATH_END, PATH_MOVE_BLOCKED, PATH_IN_PROGRESS]);
    for (const r of results) expect(allowed.has(r.lastCode)).toBe(true);
  });

  test("monsters actually step along the path they were given", () => {
    const moved = results.filter((r) => r.moved > 64);
    // Not every monster clears its first step: SV_StepDirection refuses a
    // move until the monster has turned far enough, and a few start pressed
    // against geometry. Most of them walk.
    expect(moved.length).toBeGreaterThan(results.length / 2);
    expect(Math.max(...results.map((r) => r.moved))).toBeGreaterThan(200);
  });

  test("a monster standing on its goal reports PATH_REACHED_GOAL", () => {
    const monster = EDICT_NUM(0);
    for (let i = 1; i < sv.num_edicts; i++) {
      const ent = EDICT_NUM(i);
      if (ent.free) continue;
      if (((ent.v.flags | 0) & FL_MONSTER) === 0) continue;
      const here = vec3(ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!);
      expect(Bot_WalkPathToGoal(ent, 12, here)).toBe(PATH_REACHED_GOAL);
      return;
    }
    expect(monster).toBeDefined();
  });
});
