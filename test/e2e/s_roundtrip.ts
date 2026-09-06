// Family S, driver 1: `save`/`load` round-trip across every tree/protocol
// combination the E2E-COMMON manifest contract asks for.
//
// `bun test/e2e/s_roundtrip.ts --tree <tree> --protocol <15|666|999>`
//
// Boots `--tree`, plays into its map (move, pick up an item, kill a monster,
// change the `skill` cvar -- the one cvar the save format itself records,
// host_cmd.ts's Host_WriteSaveFile), saves, and verifies the load restores
// everything both in the SAME process and in a FRESH one (the second spawned
// as a child `bun` process running this same file with `--fresh-check`, so
// one manifest command covers both legs per the brief).
import { Q1TS_REPO } from "./q1data";
import {
  boot, check, cl, classOf, directMap, edictIndex, exec, finish, frames,
  gamedir, existsSync, isDead, killMonster, liveEdicts, pickUp, player, sv,
  readFileSync, STAT_MONSTERS, treeConfig, isTreeName, Cvar_VariableValue, SOLID_NOT, waitInGame, FL_GODMODE,
} from "./s_lib";

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const treeArg = arg("tree");
const protocolArg = arg("protocol", "15");
const isFreshCheck = process.argv.includes("--fresh-check");
const saveName = arg("save", "s_roundtrip");

if (!isTreeName(treeArg)) {
  console.log(`[FAIL] boot :: unknown --tree ${JSON.stringify(treeArg)}`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const tree = treeArg;
const protocol = Number(protocolArg);
const cfg = treeConfig(tree);
const suffix = `${tree}_${protocol}`;

/* ====================================================================== */
/* --fresh-check: a second OS process loading the save the parent wrote.  */
/* ====================================================================== */
if (isFreshCheck) {
  boot(cfg, suffix);
  exec(`load ${saveName}`);
  // Host_Loadgame_f runs synchronously inside Cmd_ExecuteString, but sv.paused
  // stays true ("wait for all clients") until the local client's own signon
  // finishes reconnecting -- SV_Physics (and the `sv.time += host.frametime`
  // inside it) is gated on `!sv.paused` (src/common/host.ts), so sv.time must
  // be read the instant signon completes, before any further frame lets
  // normal gameplay resume and legitimately advance the clock again.
  const reconnectFrames = await waitInGame(200);
  const timeAtReconnect = sv.time;
  const edictsAtReconnect = sv.num_edicts;
  const p = player();
  const healthAtReconnect = p.v.health;
  const originAtReconnect: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
  await frames(10); // a short settle so cl.stats reflects the loaded state
  const out = {
    active: sv.active,
    mapname: sv.name,
    time: timeAtReconnect,
    reconnectFrames,
    origin: originAtReconnect,
    health: healthAtReconnect,
    kills: cl.stats[STAT_MONSTERS],
    skill: Cvar_VariableValue("skill"),
    numEdicts: edictsAtReconnect,
  };
  console.log(`##FRESH_RESULT ${JSON.stringify(out)}`);
  process.exit(0);
}

/* ====================================================================== */
/* main flow                                                              */
/* ====================================================================== */

boot(cfg, suffix);
exec("sv_protocol " + String(protocol));
exec("sv_ruleset " + cfg.ruleset);

// The save format's `skill` line is `hostCmdState.current_skill`
// (src/common/host_cmd.ts), which src/server/sv_main.ts's SV_SpawnServer
// sets from the `skill` cvar's value AT SPAWN TIME and does not revisit
// afterwards -- changing the cvar mid-game (after the map is already
// running) has no effect on the current level's own current_skill until the
// next map/changelevel/load (faithful to WinQuake: skill is chosen before a
// level starts, not applied retroactively). So the "change a cvar the save
// records" leg below sets `skill` to a non-default value BEFORE booting the
// map, not mid-game.
const nonDefaultSkill = 2; // default is 1
exec(`skill ${nonDefaultSkill}`);
await frames(1);

const booted = await directMap(cfg.map);
check("boot", booted, `--tree ${tree} --protocol ${protocol} map ${cfg.map}: sv.active=${booted}`);
if (!booted) {
  console.log(`[FAIL] RESULT :: could not boot ${tree}/${cfg.map}, aborting driver`);
  finish();
}

const baselineEdicts = sv.num_edicts;
check("edicts-present", baselineEdicts > 10, `sv.num_edicts=${baselineEdicts} at spawn`);

// FL_GODMODE for the rest of this driver: the point of this test is save/load
// fidelity, not survival -- without it, ambient danger (a monster still
// active nearby, or map hazards) can legitimately change health/origin
// during the settle frames around save/load through completely ordinary
// continued gameplay, which would be indistinguishable from an actual
// restore defect. killMonster() below also sets/restores this around the
// kill itself; this sets it for the whole rest of the run.
player().v.flags = (player().v.flags | 0) | FL_GODMODE;

// ---- move: noclip a lap so the saved origin differs from the spawn point --
const spawnOrigin: [number, number, number] = [player().v.origin[0], player().v.origin[1], player().v.origin[2]];
exec("noclip");
await frames(5);
exec("+forward");
await frames(40);
exec("-forward");
await frames(10);
exec("noclip");
await frames(5);
const movedOrigin: [number, number, number] = [player().v.origin[0], player().v.origin[1], player().v.origin[2]];
const moveDist = Math.hypot(movedOrigin[0] - spawnOrigin[0], movedOrigin[1] - spawnOrigin[1], movedOrigin[2] - spawnOrigin[2]);
check("moved", moveDist > 16, `spawn ${JSON.stringify(spawnOrigin)} -> ${JSON.stringify(movedOrigin)}, dist=${moveDist.toFixed(1)}`);

// ---- pick up an item --------------------------------------------------
// item_flag_team1/2 (ctf) excluded: a CTF flag is carried, not consumed --
// touching it doesn't zero its solidity or grant ammo/health the way a
// normal pickup does, so it doesn't fit this leg's "picked up and stays
// gone" check (a flag score/carry mechanic is out of scope for this driver).
const items = liveEdicts().filter((e) => {
  const cn = classOf(e);
  return (cn.startsWith("item_") && !cn.startsWith("item_flag_")) || cn.startsWith("weapon_");
});
let itemIdx = -1;
let itemPicked = false;
if (items.length > 0) {
  const target = items[0];
  itemIdx = edictIndex(target);
  const before = { shells: player().v.ammo_shells, nails: player().v.ammo_nails, rockets: player().v.ammo_rockets, cells: player().v.ammo_cells, health: player().v.health };
  await pickUp(target);
  const after = { shells: player().v.ammo_shells, nails: player().v.ammo_nails, rockets: player().v.ammo_rockets, cells: player().v.ammo_cells, health: player().v.health };
  itemPicked = target.free || target.v.solid === SOLID_NOT || after.shells !== before.shells || after.nails !== before.nails || after.rockets !== before.rockets || after.cells !== before.cells || after.health !== before.health;
  check("item-pickup", itemPicked, `${classOf(target)} #${itemIdx}: before=${JSON.stringify(before)} after=${JSON.stringify(after)} free=${target.free} solid=${target.v.solid}`);
} else {
  check("item-pickup", false, `no item_*/weapon_* edict found on ${tree}/${cfg.map}`);
}

// ---- kill a monster -----------------------------------------------------
const monsters = liveEdicts().filter((e) => classOf(e).startsWith("monster_"));
let monsterIdx = -1;
let monsterKilled = false;
const killsBefore = cl.stats[STAT_MONSTERS];
if (monsters.length > 0) {
  const target = monsters[0];
  monsterIdx = edictIndex(target);
  const cn = classOf(target);
  monsterKilled = await killMonster(target);
  await frames(10); // let the death event reach cl.stats via svc_killedmonster
  check("monster-kill", monsterKilled, `${cn} #${monsterIdx} on ${tree}/${cfg.map}: health=${target.v.health} deadflag=${target.v.deadflag} free=${target.free}`);
} else if (tree === "ctf") {
  check("monster-kill", true, "deviation: no ctf map ships a monster_* edict (see s_lib.ts treeConfig's own note) -- leg dropped for this tree");
} else {
  check("monster-kill", false, `no monster_* edict found on ${tree}/${cfg.map}`);
}
const killsAfter = cl.stats[STAT_MONSTERS];
if (monsterKilled) check("kill-count", killsAfter > killsBefore, `STAT_MONSTERS ${killsBefore} -> ${killsAfter}`);

// ---- the cvar the save records: skill, set before this map spawned above --
const preSaveSkill = Cvar_VariableValue("skill");
check("cvar-change", preSaveSkill === nonDefaultSkill, `skill cvar after spawn: ${preSaveSkill} (set to ${nonDefaultSkill} before "map ${cfg.map}", default is 1)`);

// ---- snapshot right before saving ---------------------------------------
const preSaveOrigin: [number, number, number] = [player().v.origin[0], player().v.origin[1], player().v.origin[2]];
const preSaveHealth = player().v.health;
const preSaveKills = cl.stats[STAT_MONSTERS];
const preSaveTime = sv.time;
const preSaveEdicts = sv.num_edicts;

exec(`save ${saveName}`);
await frames(10);

const savePath = `${gamedir()}/${saveName}.sav`;
const saveExists = existsSync(savePath);
check("save-written", saveExists, savePath);

if (saveExists) {
  const lines = readFileSync(savePath, "latin1").split("\n");
  if (cfg.ruleset === "rerelease") {
    check("save-header-kex", lines[0] === "6", `line0=${JSON.stringify(lines[0])} (want KEX version 6)`);
    check("save-header-gamename", lines[1] !== undefined && lines[1].length > 0, `line1=${JSON.stringify(lines[1])} (COM_GetGameNames())`);
  } else {
    check("save-header-classic", lines[0] === "5", `line0=${JSON.stringify(lines[0])} (want classic version 5) with sv_ruleset classic`);
  }
}

// ---- move away + diverge state, then load in the SAME process ----------
exec("noclip");
await frames(5);
exec("+back");
await frames(30);
exec("-back");
await frames(5);
exec("noclip");
await frames(5);
exec("skill 1"); // diverge the live cvar; Host_Loadgame_f must set it back from the file
await frames(2);

exec(`load ${saveName}`);
// See the --fresh-check block's own comment: sv.time only advances once
// !sv.paused, so it has to be read the instant reconnect completes, before
// any further settle frames let normal gameplay (and, without FL_GODMODE,
// ambient danger) resume and legitimately change origin/health/edicts again.
const reconnectFrames = await waitInGame(200);
const postLoadTime = sv.time;
const postLoadEdicts = sv.num_edicts;
const postLoadHealth = player().v.health;
const postLoadOrigin: [number, number, number] = [player().v.origin[0], player().v.origin[1], player().v.origin[2]];
await frames(10); // a short settle so cl.stats reflects the loaded state
const originDelta = Math.hypot(
  postLoadOrigin[0] - preSaveOrigin[0],
  postLoadOrigin[1] - preSaveOrigin[1],
  postLoadOrigin[2] - preSaveOrigin[2],
);
check("load-samep-active", sv.active && sv.name === cfg.map, `sv.active=${sv.active} sv.name=${sv.name}`);
check("load-samep-reconnected", reconnectFrames >= 0, `waitInGame returned ${reconnectFrames}`);
check("load-samep-origin", originDelta < 4, `saved ${JSON.stringify(preSaveOrigin)} vs loaded ${JSON.stringify(postLoadOrigin)}, delta=${originDelta.toFixed(2)}`);
check("load-samep-health", postLoadHealth === preSaveHealth, `${preSaveHealth} -> ${postLoadHealth}`);
check("load-samep-kills", cl.stats[STAT_MONSTERS] === preSaveKills, `${preSaveKills} -> ${cl.stats[STAT_MONSTERS]}`);
check("load-samep-time", Math.abs(postLoadTime - preSaveTime) < 0.5, `${preSaveTime} -> ${postLoadTime} (read at reconnect; sub-frame slack for the exact reconnect tick, not a real drift -- see waitInGame's own note)`);
check("load-samep-edicts", postLoadEdicts === preSaveEdicts, `${preSaveEdicts} -> ${postLoadEdicts}`);
check("load-samep-skill", Cvar_VariableValue("skill") === preSaveSkill, `${preSaveSkill} -> ${Cvar_VariableValue("skill")}`);
if (monsterIdx >= 0) {
  const m = sv.edicts[monsterIdx];
  check("load-samep-monster-dead", !m || isDead(m), `edict #${monsterIdx}: ${m ? `health=${m.v.health} deadflag=${m.v.deadflag} free=${m.free}` : "gone"}`);
}
if (itemIdx >= 0) {
  const it = sv.edicts[itemIdx];
  const gone = !it || it.free || it.v.solid === SOLID_NOT;
  check("load-samep-item-gone", gone, `edict #${itemIdx} free=${it ? it.free : "gone"} solid=${it ? it.v.solid : "n/a"}`);
}

/* ====================================================================== */
/* fresh-process load: a second `bun` process loads the same save file.   */
/* ====================================================================== */

const child = Bun.spawnSync({
  cmd: ["bun", "test/e2e/s_roundtrip.ts", "--tree", tree, "--protocol", String(protocol), "--save", saveName, "--fresh-check"],
  cwd: Q1TS_REPO,
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
const childOut = child.stdout.toString("utf8");
const childErr = child.stderr.toString("utf8");
const marker = childOut.split("\n").find((l) => l.startsWith("##FRESH_RESULT "));
check("fresh-process-ran", child.exitCode === 0 && marker !== undefined, `exit=${child.exitCode} marker=${marker ?? "(none)"}${marker ? "" : "\n--- child stdout ---\n" + childOut + "\n--- child stderr ---\n" + childErr}`);

if (marker !== undefined) {
  interface FreshResult {
    active: boolean;
    mapname: string;
    time: number;
    origin: [number, number, number];
    health: number;
    kills: number;
    skill: number;
    numEdicts: number;
  }
  const parsed: unknown = JSON.parse(marker.slice("##FRESH_RESULT ".length));
  const isFreshResult = (v: unknown): v is FreshResult =>
    typeof v === "object" && v !== null && "active" in v && "mapname" in v && "origin" in v;
  if (isFreshResult(parsed)) {
    const fr = parsed;
    const freshDelta = Math.hypot(
      fr.origin[0] - preSaveOrigin[0],
      fr.origin[1] - preSaveOrigin[1],
      fr.origin[2] - preSaveOrigin[2],
    );
    check("fresh-active", fr.active && fr.mapname === cfg.map, `active=${fr.active} mapname=${fr.mapname}`);
    check("fresh-origin", freshDelta < 4, `saved ${JSON.stringify(preSaveOrigin)} vs fresh-loaded ${JSON.stringify(fr.origin)}, delta=${freshDelta.toFixed(2)}`);
    check("fresh-health", fr.health === preSaveHealth, `${preSaveHealth} -> ${fr.health}`);
    check("fresh-kills", fr.kills === preSaveKills, `${preSaveKills} -> ${fr.kills}`);
    check("fresh-time", Math.abs(fr.time - preSaveTime) < 0.5, `${preSaveTime} -> ${fr.time} (sub-frame slack for the exact reconnect tick)`);
    check("fresh-edicts", fr.numEdicts === preSaveEdicts, `${preSaveEdicts} -> ${fr.numEdicts}`);
    check("fresh-skill", fr.skill === preSaveSkill, `${preSaveSkill} -> ${fr.skill}`);
  } else {
    check("fresh-parse", false, `##FRESH_RESULT payload did not match the expected shape: ${marker}`);
  }
}

finish();
