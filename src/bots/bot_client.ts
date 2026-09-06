/*
Bot client slots, and the console surface that creates and removes them.

WHAT A BOT IS, ENGINE-SIDE. A bot is a `client_t` with `netconnection ==
NULL`: an otherwise ordinary client slot whose usercmd the engine fills in
each frame instead of reading it off a socket. That is the whole trick, and
it is why the three places the C reaches for the socket need to know:

  - SV_RunClients (sv_user.c) calls SV_ReadClientMessage, which calls
    NET_GetMessage(sock). net_main.ts's NET_GetMessage returns -1 for a null
    socket, and SV_RunClients treats -1 as "client misbehaved" and drops it.
    So a bot must not go down that branch: sv_user.ts asks
    `svMainHooks.isBot` first, calls `svMainHooks.botThink` to synthesize the
    usercmd, and then runs the same SV_ClientThink every player runs.
  - SV_SendClientMessages (sv_main.c) would call
    NET_SendUnreliableMessage(NULL) and drop the bot for the same reason.
    It skips bots instead; nothing needs sending to a client that is inside
    the process.
  - SV_DropClient (host.c) closes the socket and decrements
    net_activeconnections. A bot never incremented it, so `kickbot` does its
    own teardown here rather than borrowing that function.

Everything else about a bot is a player. ClientConnect and PutClientInServer
run for it exactly as they do for a human -- the QuakeC has no bot branch in
either (quakec/client.qc) -- `name` and `colors` come from
bots/characters.txt the way a human's come from userinfo, and `FL_ISBOT`
(quakec/defs.qc:260, 8192) is set on the edict so the QuakeC's own three bot
checks fire: no bot-on-human friendly fire in coop (combat.qc), no
autoswitch on weapon pickup (items.qc, "mal: let bots pick their own
weapon"), and CTF's auto team assignment (quakec_ctf/client.qc).

Bot_PreThink and Bot_PostThink (quakec/bots/bot.qc) are called around the
brain's update with `self` set to the bot, when the loaded progs defines
them. id1, ctf, hipnotic and rogue compile bots/bot.qc; mg1 and mg3 do not,
so those two run bots with no hook calls, which is what ARCHITECTURE.md's
"under 1.06 progs they still path and fight, without the hook calls" says.
*/

import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { Con_Printf } from "../client/console";
import { CvarT, Cvar_RegisterVariable, Cvar_VariableValue } from "../common/cvar";
import { COM_LoadTempFile } from "../common/common";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteString, SZ_Clear } from "../common/sizebuf";
import { SvcOpsT } from "../common/protocol";
import { EDICT_TO_PROG, EDICT_NUM, PR_GetString, PR_SetEngineStringRef, pr, type EdictT } from "../progs/progs";
import { PR_ExecuteProgram } from "../progs/pr_exec";
import { NUM_SPAWN_PARMS, sv, svs, svState, type ClientT } from "../server/server";
import { SV_ConnectClient } from "../server/sv_main";
import { GLOBAL_OFS, type GlobalVars } from "../progs/progdefs";
import { deathmatch, host } from "../common/host";
import { parseMapdb } from "../lib/mapdb";
import {
  BOT_BUTTON_ATTACK,
  BOT_BUTTON_JUMP,
  BOT_BUTTON_USE,
  BotBrain,
  Xorshift32,
  type BotChatEventT,
} from "../lib/bot_brain";
import { IT_AXE, IT_GRENADE_LAUNCHER, IT_LIGHTNING, IT_NAILGUN, IT_ROCKET_LAUNCHER, IT_SHOTGUN, IT_SUPER_NAILGUN, IT_SUPER_SHOTGUN } from "../common/quakedef";
import { Bot_ClearNav, Bot_Knowledge, Bot_LoadNav } from "./bot_data";
import { BotServerWorld, FL_ISBOT, toEngineVec } from "./bot_world";

//============================================================================

export const bot_skill = new CvarT("bot_skill", "medium", true);
export const bot_count = new CvarT("bot_count", "0", true);

/** The order settings_*.txt lists the skills in is the order they get harder. */
const DEFAULT_SKILLS = ["practice", "easy", "medium", "hard", "expert", "nightmare"] as const;

/** weapons.txt `number` -> the impulse that selects it, Quake 1's own mapping. */
const WEAPON_IMPULSE: ReadonlyArray<{ number: number; impulse: number }> = [
  { number: IT_AXE, impulse: 1 },
  { number: IT_SHOTGUN, impulse: 2 },
  { number: IT_SUPER_SHOTGUN, impulse: 3 },
  { number: IT_NAILGUN, impulse: 4 },
  { number: IT_SUPER_NAILGUN, impulse: 5 },
  { number: IT_GRENADE_LAUNCHER, impulse: 6 },
  { number: IT_ROCKET_LAUNCHER, impulse: 7 },
  { number: IT_LIGHTNING, impulse: 8 },
];

function weaponImpulse(weaponNumber: number): number {
  for (const entry of WEAPON_IMPULSE) if (entry.number === weaponNumber) return entry.impulse;
  return 0;
}

//============================================================================

export class BotSlot {
  readonly clientnum: number;
  readonly brain: BotBrain;
  readonly world: BotServerWorld;
  name: string;
  colors: number;
  /** Chat lines the brain asked for, with the server time they become due. */
  pendingChats: Array<{ at: number; event: BotChatEventT }> = [];

  constructor(clientnum: number, name: string, colors: number, brain: BotBrain, world: BotServerWorld) {
    this.clientnum = clientnum;
    this.name = name;
    this.colors = colors;
    this.brain = brain;
    this.world = world;
  }
}

const botState: {
  slots: Map<number, BotSlot>;
  nextSeed: number;
  usedCharacters: Set<string>;
  registered: boolean;
} = { slots: new Map<number, BotSlot>(), nextSeed: 0x5eed1234, usedCharacters: new Set<string>(), registered: false };

/** Every live bot, keyed by client slot number. */
export function Bot_Slots(): ReadonlyMap<number, BotSlot> {
  return botState.slots;
}

/** True when this client slot is an engine-driven bot. */
export function Bot_IsBotClient(client: ClientT): boolean {
  const index = svs.clients.indexOf(client);
  return index >= 0 && botState.slots.has(index);
}

export function Bot_Count(): number {
  return botState.slots.size;
}

//============================================================================

function globalStruct(): GlobalVars {
  const gs = pr.global_struct;
  if (gs === null) throw new Error("bots: progs not loaded");
  return gs;
}

function globalsF(): Float32Array {
  const g = pr.globals;
  if (g === null) throw new Error("bots: progs not loaded");
  return g.f;
}

/** ED_FindFunction's answer as the func_t index PR_ExecuteProgram takes; -1 when the progs has no such function. */
function functionIndexByName(name: string): number {
  for (let i = 0; i < pr.functions.length; i++) {
    const fn = pr.functions[i];
    if (fn === undefined) continue;
    if (PR_GetString(fn.s_name) === name) return i;
  }
  return -1;
}

//============================================================================

/** The skill name `bot_skill` currently names, clamped to what settings_*.txt actually has. */
export function Bot_SkillName(explicit?: string): string {
  const knowledge = Bot_Knowledge();
  const available = knowledge !== null && knowledge.skills.length > 0 ? knowledge.skillNames() : [...DEFAULT_SKILLS];
  const wanted = (explicit ?? bot_skill.string).toLowerCase();
  for (const s of available) if (s.toLowerCase() === wanted) return s;

  // A number selects by rank, so `bot_skill 3` works the way `skill 3` does.
  const asNumber = Number(wanted);
  if (Number.isFinite(asNumber) && available.length > 0) {
    const i = Math.max(0, Math.min(available.length - 1, Math.trunc(asNumber)));
    return available[i]!;
  }
  return available[Math.min(2, available.length - 1)] ?? "medium";
}

//============================================================================

function pickCharacter(request: string): { funName: string; colors: number } {
  const knowledge = Bot_Knowledge();
  if (knowledge === null || knowledge.characters.length === 0) {
    return { funName: request !== "" && request !== "random" ? request : `bot${botState.slots.size + 1}`, colors: 0 };
  }

  if (request !== "" && request !== "random") {
    const named = knowledge.character(request);
    if (named !== undefined) {
      botState.usedCharacters.add(named.name);
      return { funName: named.funName, colors: ((named.shirtColor & 15) << 4) | (named.pantsColor & 15) };
    }
    // A name that is not in characters.txt is used verbatim, so a server
    // operator can call a bot whatever they like.
    return { funName: request, colors: 0 };
  }

  const unused = knowledge.characters.filter((c) => !botState.usedCharacters.has(c.name));
  const pool = unused.length > 0 ? unused : knowledge.characters;
  const pick = pool[Math.floor(seedRandom() * pool.length) % pool.length]!;
  botState.usedCharacters.add(pick.name);
  return { funName: pick.funName, colors: ((pick.shirtColor & 15) << 4) | (pick.pantsColor & 15) };
}

/** A deterministic stream for the choices `addbot` itself makes, separate from each bot's own. */
function seedRandom(): number {
  let x = botState.nextSeed;
  x ^= x << 13;
  x |= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x |= 0;
  botState.nextSeed = x;
  return (x >>> 0) / 0x100000000;
}

//============================================================================

/**
 * Puts a bot into a free client slot. Returns the slot number, or -1 when
 * there is no room, no server, or no bots/ data in this game directory.
 */
export function Bot_Add(nameRequest: string, skillRequest: string): number {
  if (!sv.active) {
    Con_Printf("addbot: no server running\n");
    return -1;
  }

  const knowledge = Bot_Knowledge();
  if (knowledge === null) {
    Con_Printf("addbot: this game directory has no bots/ data\n");
    return -1;
  }

  let clientnum = -1;
  for (let i = 0; i < svs.maxclients; i++) {
    if (!svs.clients[i]!.active) {
      clientnum = i;
      break;
    }
  }
  if (clientnum < 0) {
    Con_Printf("addbot: server is full\n");
    return -1;
  }

  const client = svs.clients[clientnum]!;
  const character = pickCharacter(nameRequest);
  const skill = Bot_SkillName(skillRequest === "" ? undefined : skillRequest);

  // The C's own connect path, with a null socket. SV_ConnectClient resets
  // every client_t field, runs SetNewParms and stages the serverinfo; a bot
  // has nobody to send that to, so it is thrown away below.
  client.netconnection = null;
  SV_ConnectClient(clientnum);
  SZ_Clear(client.message);
  client.sendsignon = false;

  client.name = character.funName;
  client.colors = character.colors;

  const world = new BotServerWorld(clientnum + 1);
  const brain = new BotBrain({
    knowledge,
    skill,
    rng: new Xorshift32(Math.floor(seedRandom() * 0x7fffffff) ^ (clientnum * 2654435761)),
    gameMode: knowledge.gameMode((name) => Cvar_VariableValue(name)),
    character: knowledge.character(nameRequest),
    maxHealth: 100,
    weaponImpulse,
    onChat: (event) => Bot_QueueChat(clientnum, event),
    humanTeammateNear: () => Bot_HumanTeammateNear(clientnum),
  });

  const slot = new BotSlot(clientnum, character.funName, character.colors, brain, world);
  botState.slots.set(clientnum, slot);

  Bot_PutInServer(clientnum);

  Con_Printf("%s entered the game (bot, %s)\n", client.name, skill);
  return clientnum;
}

/**
 * The bot half of Host_Spawn_f: set the edict up, run ClientConnect and
 * PutClientInServer, and mark the slot spawned. No signon traffic, because
 * there is nobody to send it to.
 */
export function Bot_PutInServer(clientnum: number): void {
  const client = svs.clients[clientnum];
  if (client === undefined || !client.active) return;

  const ent = EDICT_NUM(clientnum + 1);
  client.edict = ent;

  ent.fields.i.fill(0); // the same memset Host_Spawn_f does
  ent.v.colormap = clientnum + 1;
  ent.v.team = (client.colors & 15) + 1;
  ent.v.netname = PR_SetEngineStringRef(client, () => client.name);

  for (let i = 0; i < NUM_SPAWN_PARMS; i++) globalsF()[GLOBAL_OFS.parm1 + i] = client.spawn_parms[i]!;

  const saveSelf = globalStruct().self;
  const saveOther = globalStruct().other;

  globalStruct().time = sv.time;
  globalStruct().self = EDICT_TO_PROG(ent);
  svState.host_client = client;
  svState.sv_player = ent;
  PR_ExecuteProgram(globalStruct().ClientConnect);
  PR_ExecuteProgram(globalStruct().PutClientInServer);

  globalStruct().self = saveSelf;
  globalStruct().other = saveOther;

  // quakec/defs.qc:260's FL_ISBOT, set after PutClientInServer so the
  // QuakeC's own spawn code cannot clear it.
  ent.v.flags = (ent.v.flags | 0) | FL_ISBOT;

  client.spawned = true;
  SZ_Clear(client.message);

  // Every human on the server still learns this slot's name and colour, the
  // same three messages Host_Spawn_f sends about a joining player.
  for (let i = 0; i < svs.maxclients; i++) {
    const other = svs.clients[i]!;
    if (!other.active || other.netconnection === null) continue;
    MSG_WriteByte(other.message, SvcOpsT.svc_updatename);
    MSG_WriteByte(other.message, clientnum);
    MSG_WriteString(other.message, client.name);
    MSG_WriteByte(other.message, SvcOpsT.svc_updatecolors);
    MSG_WriteByte(other.message, clientnum);
    MSG_WriteByte(other.message, client.colors);
    MSG_WriteByte(other.message, SvcOpsT.svc_updatefrags);
    MSG_WriteByte(other.message, clientnum);
    MSG_WriteShort(other.message, 0);
  }
}

/**
 * Removes a bot. This is SV_DropClient's work minus everything to do with a
 * socket: no svc_disconnect (nobody is listening), no NET_Close, and no
 * net_activeconnections decrement, because a bot never incremented it.
 */
export function Bot_Remove(clientnum: number): boolean {
  const slot = botState.slots.get(clientnum);
  if (slot === undefined) return false;
  const client = svs.clients[clientnum];
  if (client === undefined) return false;

  if (client.edict !== null && client.spawned) {
    const saveSelf = globalStruct().self;
    globalStruct().self = EDICT_TO_PROG(client.edict);
    svState.host_client = client;
    svState.sv_player = client.edict;
    PR_ExecuteProgram(globalStruct().ClientDisconnect);
    globalStruct().self = saveSelf;
  }

  if (client.edict !== null) client.edict.v.flags = (client.edict.v.flags | 0) & ~FL_ISBOT;

  Con_Printf("%s removed (bot)\n", client.name);

  client.active = false;
  client.spawned = false;
  client.name = "";
  client.old_frags = -999999;
  client.netconnection = null;
  SZ_Clear(client.message);

  botState.slots.delete(clientnum);

  for (let i = 0; i < svs.maxclients; i++) {
    const other = svs.clients[i]!;
    if (!other.active || other.netconnection === null) continue;
    MSG_WriteByte(other.message, SvcOpsT.svc_updatename);
    MSG_WriteByte(other.message, clientnum);
    MSG_WriteString(other.message, "");
    MSG_WriteByte(other.message, SvcOpsT.svc_updatefrags);
    MSG_WriteByte(other.message, clientnum);
    MSG_WriteShort(other.message, 0);
    MSG_WriteByte(other.message, SvcOpsT.svc_updatecolors);
    MSG_WriteByte(other.message, clientnum);
    MSG_WriteByte(other.message, 0);
  }

  return true;
}

/** Drops every bot; called when the server shuts down or changes level. */
export function Bot_RemoveAll(): void {
  for (const clientnum of [...botState.slots.keys()]) Bot_Remove(clientnum);
  botState.usedCharacters.clear();
}

//============================================================================
// the per-frame update

const botPreThinkName = "Bot_PreThink";
const botPostThinkName = "Bot_PostThink";
const hookIndex: { pre: number; post: number; forCrc: number } = { pre: -1, post: -1, forCrc: -1 };

function refreshHookIndices(): void {
  if (hookIndex.forCrc === pr.crc) return;
  hookIndex.forCrc = pr.crc;
  hookIndex.pre = functionIndexByName(botPreThinkName);
  hookIndex.post = functionIndexByName(botPostThinkName);
}

function callHook(index: number, ent: EdictT): void {
  if (index < 0) return;
  const gs = globalStruct();
  const saveSelf = gs.self;
  gs.self = EDICT_TO_PROG(ent);
  PR_ExecuteProgram(index);
  gs.self = saveSelf;
}

/**
 * Fills one bot's usercmd for this frame. sv_user.ts calls this in
 * SV_RunClients where a human client would be read off its socket, so the
 * SV_ClientThink that follows is the same one a player gets.
 */
export function Bot_Think(client: ClientT): void {
  const clientnum = svs.clients.indexOf(client);
  const slot = botState.slots.get(clientnum);
  if (slot === undefined) return;

  const ent = client.edict;
  if (ent === null) return;

  // `fixangle` is cleared by SV_WriteClientdataToMessage once the angle has
  // been sent to the client that owns the edict. A bot is skipped by
  // SV_SendClientMessages, so nothing ever clears it -- and SV_ClientThink
  // refuses to copy v_angle onto `angles` while it is set, which leaves the
  // bot walking in whatever direction PutClientInServer spawned it facing,
  // forever. Consuming it here is the same acknowledgement, for a client
  // that lives inside the process.
  ent.v.fixangle = 0;

  refreshHookIndices();
  callHook(hookIndex.pre, ent);

  slot.world.beginFrame(hostFrameTime());
  const cmd = slot.brain.think(slot.world);

  // The usercmd the engine would have read off the wire. SV_ReadClientMove
  // writes the view angles onto the edict and the movement onto client.cmd;
  // this writes exactly the same fields.
  toEngineVec(cmd.viewAngles, ent.v.v_angle);
  client.cmd.forwardmove = cmd.forwardmove;
  client.cmd.sidemove = cmd.sidemove;
  client.cmd.upmove = cmd.upmove;
  ent.v.button0 = (cmd.buttons & BOT_BUTTON_ATTACK) !== 0 ? 1 : 0;
  ent.v.button2 = (cmd.buttons & BOT_BUTTON_JUMP) !== 0 ? 1 : 0;
  ent.v.button1 = (cmd.buttons & BOT_BUTTON_USE) !== 0 ? 1 : 0;
  if (cmd.impulse !== 0) ent.v.impulse = cmd.impulse;

  callHook(hookIndex.post, ent);

  Bot_FlushChats(slot);
}

/** The frame length SV_Physics is about to run with; a zero would divide by zero in the aim tracker. */
function hostFrameTime(): number {
  return host.frametime > 0 ? host.frametime : 0.05;
}

//============================================================================
// chat

function Bot_QueueChat(clientnum: number, event: BotChatEventT): void {
  const slot = botState.slots.get(clientnum);
  if (slot === undefined) return;
  slot.pendingChats.push({ at: sv.time + event.delayMs / 1000, event });
}

function Bot_FlushChats(slot: BotSlot): void {
  if (slot.pendingChats.length === 0) return;
  const due = slot.pendingChats.filter((c) => c.at <= sv.time);
  if (due.length === 0) return;
  slot.pendingChats = slot.pendingChats.filter((c) => c.at > sv.time);

  for (const c of due) {
    // chats.txt gives a `$key`; the re-release's own `ex_bprint` resolves it
    // against the loc table, so this goes out the same way any server print
    // does and localizes on the client that has the table.
    const line = `${slot.name}: ${c.event.locstring}\n`;
    for (let i = 0; i < svs.maxclients; i++) {
      const other = svs.clients[i]!;
      if (!other.active || other.netconnection === null) continue;
      if (c.event.teamOnly && other.edict !== null && slot.clientnum >= 0) {
        const botEnt = svs.clients[slot.clientnum]!.edict;
        if (botEnt !== null && other.edict.v.team !== botEnt.v.team) continue;
      }
      MSG_WriteByte(other.message, SvcOpsT.svc_print);
      MSG_WriteString(other.message, line);
    }
  }
}

function Bot_HumanTeammateNear(clientnum: number): boolean {
  const botEnt = svs.clients[clientnum]?.edict;
  if (botEnt === undefined || botEnt === null) return false;
  for (let i = 0; i < svs.maxclients; i++) {
    if (i === clientnum) continue;
    const other = svs.clients[i]!;
    if (!other.active || other.netconnection === null || other.edict === null) continue;
    if (other.edict.v.team !== botEnt.v.team) continue;
    const dx = other.edict.v.origin[0]! - botEnt.v.origin[0]!;
    const dy = other.edict.v.origin[1]! - botEnt.v.origin[1]!;
    const dz = other.edict.v.origin[2]! - botEnt.v.origin[2]!;
    if (dx * dx + dy * dy + dz * dz < 768 * 768) return true;
  }
  return false;
}

//============================================================================
// level transitions

/** Called at the end of SV_SpawnServer: reload the nav, and re-seat every bot. */
export function Bot_SpawnServer(mapname: string): void {
  Bot_ClearNav();
  Bot_LoadNav(mapname);
  for (const clientnum of botState.slots.keys()) {
    const client = svs.clients[clientnum];
    if (client === undefined || !client.active) continue;
    // The old level's nav graph and entity ids are gone.
    botState.slots.get(clientnum)?.brain.resetForLevel();
    Bot_PutInServer(clientnum);
  }
  Bot_AutoFill(mapname);
}

/**
 * `bot_count` auto-fill. Only on a deathmatch server, and only on a map
 * mapdb.json flags `bots` -- a map with no nav gives bots nothing to walk
 * along, and mapdb's own flag is the retail data's statement of which maps
 * were authored for them.
 */
export function Bot_AutoFill(mapname: string): void {
  const want = Math.trunc(bot_count.value);
  if (want <= 0) return;
  if (deathmatch.value === 0) return;
  if (!Bot_MapAllowsBots(mapname)) {
    Con_Printf("bot_count: %s is not flagged for bots in mapdb.json\n", mapname);
    return;
  }

  while (botState.slots.size < want) {
    if (Bot_Add("random", "") < 0) break;
  }
  while (botState.slots.size > want) {
    const last = [...botState.slots.keys()].pop();
    if (last === undefined) break;
    Bot_Remove(last);
  }
}

const mapdbCache: { loaded: boolean; bots: Set<string> } = { loaded: false, bots: new Set<string>() };

export function Bot_MapAllowsBots(mapname: string): boolean {
  if (!mapdbCache.loaded) {
    mapdbCache.loaded = true;
    const bytes = COM_LoadTempFile("mapdb.json");
    if (bytes !== null) {
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end--;
      const result = parseMapdb(new TextDecoder().decode(bytes.subarray(0, end)));
      for (const m of result.mapdb.maps) if (m.bots) mapdbCache.bots.add(m.bsp.toLowerCase());
    }
  }
  // No mapdb at all (a classic install) means no statement either way, and
  // the operator's explicit `addbot` still works; only the auto-fill defers.
  if (mapdbCache.bots.size === 0) return false;
  return mapdbCache.bots.has(mapname.toLowerCase());
}

export function Bot_ForgetMapdb(): void {
  mapdbCache.loaded = false;
  mapdbCache.bots.clear();
}

//============================================================================
// console commands

function Bot_AddBot_f(): void {
  const name = Cmd_Argc() > 1 ? Cmd_Argv(1) : "random";
  const skill = Cmd_Argc() > 2 ? Cmd_Argv(2) : "";
  Bot_Add(name, skill);
}

function Bot_KickBot_f(): void {
  if (Cmd_Argc() < 2) {
    Con_Printf("usage: kickbot <name|all>\n");
    return;
  }
  const which = Cmd_Argv(1);
  if (which.toLowerCase() === "all") {
    Bot_RemoveAll();
    return;
  }

  for (const [clientnum, slot] of botState.slots) {
    if (slot.name.toLowerCase() === which.toLowerCase()) {
      Bot_Remove(clientnum);
      return;
    }
  }
  Con_Printf("kickbot: no bot named \"%s\"\n", which);
}

export function Bot_RegisterCommands(): void {
  if (botState.registered) return;
  botState.registered = true;
  Cvar_RegisterVariable(bot_skill);
  Cvar_RegisterVariable(bot_count);
  Cmd_AddCommand("addbot", Bot_AddBot_f);
  Cmd_AddCommand("kickbot", Bot_KickBot_f);
}
