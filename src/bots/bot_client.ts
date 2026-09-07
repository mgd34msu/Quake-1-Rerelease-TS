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
    own teardown here rather than borrowing that function, and host.ts's own
    SV_DropClient only gives a connection back when there was one.

A BOT IS NOT ITS CLIENT SLOT. Host_ShutdownServer runs between every pair of
levels: it drops every client and then replaces svs.clients wholesale. So the
thing that says a bot is meant to be playing cannot live in that array. The
ROSTER below does -- one entry per bot, with the name, colours and skill it
was created with -- and `Bot_Suspend` (from Host_ShutdownServer) takes the
bots out of the client array while keeping it, so `Bot_SpawnServer` seats the
same bots into the next map.

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
import { CvarT, Cvar_RegisterVariable, Cvar_SetValue, Cvar_VariableValue } from "../common/cvar";
import { COM_LoadTempFile } from "../common/common";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteString, SZ_Clear } from "../common/sizebuf";
import { SvcOpsT } from "../common/protocol";
import { EDICT_TO_PROG, EDICT_NUM, PROG_TO_EDICT, PR_GetString, PR_SetEngineStringRef, pr, type EdictT } from "../progs/progs";
import { PR_ExecuteProgram } from "../progs/pr_exec";
import { FL_MONSTER, NUM_SPAWN_PARMS, sv, svs, svState, type ClientT } from "../server/server";
import { SV_ConnectClient } from "../server/sv_main";
import { GLOBAL_OFS, type GlobalVars } from "../progs/progdefs";
import { coop, deathmatch, host } from "../common/host";
import { QEX_LocGetString } from "../progs/ext/qex_print";
import { parseMapdb } from "../lib/mapdb";
import {
  BOT_BUTTON_ATTACK,
  BOT_BUTTON_JUMP,
  BOT_BUTTON_USE,
  BOT_RUN_SPEED,
  BOT_WALK_SPEED,
  BotBrain,
  ITEM_FLAG,
  Xorshift32,
  randomIndex,
  type BotChatEventT,
  type BotGameModeT,
} from "../lib/bot_brain";
import { IT_AXE, IT_GRENADE_LAUNCHER, IT_LIGHTNING, IT_NAILGUN, IT_ROCKET_LAUNCHER, IT_SHOTGUN, IT_SUPER_NAILGUN, IT_SUPER_SHOTGUN } from "../common/quakedef";
import { Bot_ClearNav, Bot_Knowledge, Bot_LoadNav } from "./bot_data";
import { BotServerWorld, FL_ISBOT, toEngineVec } from "./bot_world";

//============================================================================

export const bot_skill = new CvarT("bot_skill", "medium", true);
export const bot_count = new CvarT("bot_count", "0", true);
/** 0 silences bot chat entirely; 1 is the shipped behaviour. */
export const bot_chat = new CvarT("bot_chat", "1", true);

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
  /** The frag count, death state and view offset the last frame left behind. */
  lastFrags = 0;
  spawnedFrags = false;
  wasDead = false;
  sawIntermission = false;

  constructor(clientnum: number, name: string, colors: number, brain: BotBrain, world: BotServerWorld) {
    this.clientnum = clientnum;
    this.name = name;
    this.colors = colors;
    this.brain = brain;
    this.world = world;
  }
}

/**
 * One bot as the server operator asked for it, kept for as long as that bot
 * is meant to be playing. Host_ShutdownServer drops every client and
 * replaces svs.clients wholesale between levels, so the client slot cannot
 * be what remembers a bot; this can, and Bot_SpawnServer seats the same
 * names, colours and skills into the next map.
 */
export interface BotRosterEntryT {
  /** characters.txt `name`, or "" for a name the operator invented. */
  character: string;
  /** The fun_name every other client sees. */
  name: string;
  colors: number;
  skill: string;
  /**
   * True for a bot `bot_count`'s auto-fill put there. Only those are taken
   * away again when `bot_count` drops: a bot an operator asked for by hand
   * with `addbot` stays until they say `kickbot`.
   */
  auto: boolean;
}

const botState: {
  slots: Map<number, BotSlot>;
  roster: BotRosterEntryT[];
  nextSeed: number;
  usedCharacters: Set<string>;
  registered: boolean;
  /** Server time the live roster was last reconciled against `bot_count`. */
  reconciledAt: number;
} = { slots: new Map<number, BotSlot>(), roster: [], nextSeed: 0x5eed1234, usedCharacters: new Set<string>(), registered: false, reconciledAt: -1 };

/** The bots that are meant to be playing, whether or not a level is running. */
export function Bot_Roster(): readonly BotRosterEntryT[] {
  return botState.roster;
}

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

/**
 * game_rules.txt's own rule, over a cvar reader that answers one question the
 * shipped data asks and this engine has no cvar for. ctf/bots/game_rules.txt
 * selects `game_type ctf` on `ctf 1`, but nothing here registers a `ctf`
 * cvar: the CTF gamedir is chosen with `game ctf` and the New Game menu sets
 * `teamplay 1` beside it. The level itself is the honest answer -- a map
 * running the team-owned objectives ctf's own items.txt describes, on two
 * different teams, is a capture-the-flag match -- and an operator who does
 * set a `ctf` cvar still wins, because a real value is used as it stands.
 */
export function Bot_GameMode(): BotGameModeT {
  const knowledge = Bot_Knowledge();
  if (knowledge === null) return { gameType: "deathmatch", weaponStay: false };
  return knowledge.gameMode((name) => {
    const value = Cvar_VariableValue(name);
    if (name === "ctf" && value === 0 && Bot_LevelHasTeamObjectives()) return 1;
    return value;
  });
}

/** Two or more team-owned `objective` items, per the loaded items.txt. */
function Bot_LevelHasTeamObjectives(): boolean {
  const knowledge = Bot_Knowledge();
  if (knowledge === null || !sv.active) return false;
  const teams = new Set<number>();
  for (let i = 1; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free || ent.v.classname === 0) continue;
    const item = knowledge.item(PR_GetString(ent.v.classname));
    if (item === undefined || !item.flags.includes(ITEM_FLAG.objective)) continue;
    const team = item.team ?? (ent.v.team | 0);
    if (team > 0) teams.add(team);
  }
  return teams.size >= 2;
}

//============================================================================

function pickCharacter(request: string): { character: string; funName: string; colors: number } {
  const knowledge = Bot_Knowledge();
  if (knowledge === null || knowledge.characters.length === 0) {
    return { character: "", funName: request !== "" && request !== "random" ? request : `bot${botState.slots.size + 1}`, colors: 0 };
  }

  if (request !== "" && request !== "random") {
    const named = knowledge.character(request);
    if (named !== undefined) {
      botState.usedCharacters.add(named.name);
      return { character: named.name, funName: named.funName, colors: ((named.shirtColor & 15) << 4) | (named.pantsColor & 15) };
    }
    // A name that is not in characters.txt is used verbatim, so a server
    // operator can call a bot whatever they like.
    return { character: "", funName: request, colors: 0 };
  }

  const unused = knowledge.characters.filter((c) => !botState.usedCharacters.has(c.name));
  const pool = unused.length > 0 ? unused : knowledge.characters;
  const pick = pool[Math.floor(seedRandom() * pool.length) % pool.length]!;
  botState.usedCharacters.add(pick.name);
  return { character: pick.name, funName: pick.funName, colors: ((pick.shirtColor & 15) << 4) | (pick.pantsColor & 15) };
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
 * Seats one roster entry in a free client slot. Returns the slot number, or
 * -1 when there is no room, no server, or no bots/ data in this game
 * directory.
 */
function botSeat(entry: BotRosterEntryT): number {
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
    // The auto-fill runs every server frame, so a `bot_count` larger than
    // the free slots would print this once a frame forever; only an
    // operator's own `addbot` gets told.
    if (!entry.auto) Con_Printf("addbot: server is full\n");
    return -1;
  }

  const client = svs.clients[clientnum]!;

  // The C's own connect path, with a null socket. SV_ConnectClient resets
  // every client_t field, runs SetNewParms and stages the serverinfo; a bot
  // has nobody to send that to, so it is thrown away below.
  client.netconnection = null;
  SV_ConnectClient(clientnum);
  SZ_Clear(client.message);
  client.sendsignon = false;

  client.name = entry.name;
  client.colors = entry.colors;

  const world = new BotServerWorld(clientnum + 1);
  const brain = new BotBrain({
    knowledge,
    skill: entry.skill,
    rng: new Xorshift32(Math.floor(seedRandom() * 0x7fffffff) ^ (clientnum * 2654435761)),
    gameMode: Bot_GameMode(),
    character: entry.character === "" ? undefined : knowledge.character(entry.character),
    maxHealth: 100,
    weaponImpulse,
    // BotBrainConfigT.runSpeed/walkSpeed default to these anyway; passed
    // explicitly since this is the binding that pins the game's own values.
    runSpeed: BOT_RUN_SPEED,
    walkSpeed: BOT_WALK_SPEED,
    onChat: (event) => Bot_QueueChat(clientnum, event),
    humanTeammateNear: () => Bot_HumanTeammateNear(clientnum),
  });

  const slot = new BotSlot(clientnum, entry.name, entry.colors, brain, world);
  botState.slots.set(clientnum, slot);

  Bot_PutInServer(clientnum);
  return clientnum;
}

/**
 * Puts a bot into a free client slot and onto the roster, so it comes back
 * on the next level too. Returns the slot number, or -1.
 */
export function Bot_Add(nameRequest: string, skillRequest: string, auto = false): number {
  const character = pickCharacter(nameRequest);
  const entry: BotRosterEntryT = {
    character: character.character,
    name: character.funName,
    colors: character.colors,
    skill: Bot_SkillName(skillRequest === "" ? undefined : skillRequest),
    auto,
  };
  const clientnum = botSeat(entry);
  if (clientnum < 0) return -1;
  botState.roster.push(entry);
  Con_Printf("%s entered the game (bot, %s)\n", entry.name, entry.skill);
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
export function Bot_Remove(clientnum: number, forget = true): boolean {
  const slot = botState.slots.get(clientnum);
  if (slot === undefined) return false;
  const client = svs.clients[clientnum];
  if (client === undefined) return false;

  if (forget) {
    const at = botState.roster.findIndex((e) => e.name === slot.name);
    if (at >= 0) botState.roster.splice(at, 1);
  }

  if (client.edict !== null && client.spawned) {
    const saveSelf = globalStruct().self;
    globalStruct().self = EDICT_TO_PROG(client.edict);
    svState.host_client = client;
    svState.sv_player = client.edict;
    PR_ExecuteProgram(globalStruct().ClientDisconnect);
    globalStruct().self = saveSelf;
  }

  if (client.edict !== null) client.edict.v.flags = (client.edict.v.flags | 0) & ~FL_ISBOT;

  if (forget) Con_Printf("%s removed (bot)\n", client.name);

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

/** Drops every bot and forgets the roster: `kickbot all`. */
export function Bot_RemoveAll(): void {
  for (const clientnum of [...botState.slots.keys()]) Bot_Remove(clientnum);
  botState.roster.length = 0;
  botState.usedCharacters.clear();
}

/**
 * Takes every bot out of svs.clients but keeps the roster. Host_ShutdownServer
 * calls this before it drops the human clients and replaces the client array:
 * a bot left in that array is dropped by SV_DropClient (which closes a socket
 * it never had) and then replaced by a fresh, empty client_t, while the slot
 * map still points at the old one -- so Bot_SpawnServer skipped it as
 * inactive and `bot_count`'s auto-fill saw a full roster and added nothing,
 * which is how a `map` change used to lose every bot on the server.
 */
export function Bot_Suspend(): void {
  for (const clientnum of [...botState.slots.keys()]) Bot_Remove(clientnum, false);
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
 * Once per server frame, from SV_CheckForNewClients (svMainHooks.serverFrame).
 *
 * `bot_count` applies while the level is running, not only at the next
 * SV_SpawnServer: raising it seats bots now, lowering it kicks the ones
 * added last. This ran off the first bot to think until F13, which meant a
 * `bot_count` raised from zero with no bot in the game had nobody to run it
 * and took effect only at the next map load.
 *
 * What it counts is the auto-filled part of the roster, not the whole of it.
 * Counting the whole roster made every `addbot` a swap: the operator's bot
 * took a slot, the next frame saw one bot too many and kicked an auto-filled
 * one back out, and the server ended the exchange with exactly as many bots
 * as it started with -- which is what the Bots page's Add row did.
 */
export function Bot_Frame(): void {
  if (!sv.active) return;
  if (botState.reconciledAt === sv.time) return;
  botState.reconciledAt = sv.time;
  const want = Math.trunc(bot_count.value);
  if (want < 0) return;
  const have = Bot_AutoCount();
  if (want === have) return;
  if (!Bot_MultiplayerRuleset()) return;
  if (want > have && !Bot_MapAllowsBots(sv.name)) return;
  Bot_Reconcile();
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

  Bot_ChatEvents(slot, ent);

  // FL_ISBOT is the engine's bit, and every QuakeC PutClientInServer opens
  // with `self.flags = FL_CLIENT` (quakec/client.qc, and every other tree's):
  // the flag survives the seating in Bot_PutInServer, which sets it after
  // that call, and is then wiped by the first respawn -- by
  // PlayerDeathThink's, and under mg1 by horde.qc's RespawnAllPlayers, which
  // calls PutClientInServer straight out of the QuakeC. Re-asserting it here
  // is what keeps the QuakeC's own three bot checks firing for the rest of
  // the level.
  ent.v.flags = (ent.v.flags | 0) | FL_ISBOT;

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
  if (bot_chat.value === 0) return;
  const slot = botState.slots.get(clientnum);
  if (slot === undefined) return;
  slot.pendingChats.push({ at: sv.time + event.delayMs / 1000, event });
}

/**
 * The loc table's value for one key, or null when the table does not have it.
 * Loc_Localize answers the key text without its leading '$' on a miss and
 * QEX_LocGetString hands the whole `$key` back when no table is loaded at
 * all (src/progs/ext/qex_print.ts), so both of those are the miss.
 */
function locValue(key: string): string | null {
  const resolved = QEX_LocGetString(`$${key}`);
  if (resolved === `$${key}` || resolved === key) return null;
  return resolved;
}

/** No chats.txt key has more numbered variants than this in the retail loc. */
const MAX_CHAT_VARIANTS = 64;

/**
 * What a bot actually says. chats.txt names one `locstring` per chat type and
 * localization/loc_english.txt holds a numbered family under it --
 * `m_bot_chat_connected_0` .. `_10`, eleven ways of saying hello -- so the
 * key itself is never in the table and picking one of the variants is what
 * makes two bots greet each other differently. A mod whose loc has the plain
 * key and no variants gets the plain key's value; a tree with no loc table at
 * all gets the key text, which is what the print path would have shown anyway.
 */
function Bot_ChatText(slot: BotSlot, locstring: string): string {
  const key = locstring.startsWith("$") ? locstring.slice(1) : locstring;
  const variants: string[] = [];
  for (let i = 0; i < MAX_CHAT_VARIANTS; i++) {
    const value = locValue(`${key}_${i}`);
    if (value === null) break;
    variants.push(value);
  }
  if (variants.length > 0) return variants[randomIndex(slot.brain.config.rng, variants.length)]!;
  return locValue(key) ?? key;
}

function Bot_FlushChats(slot: BotSlot): void {
  if (slot.pendingChats.length === 0) return;
  const due = slot.pendingChats.filter((c) => c.at <= sv.time);
  if (due.length === 0) return;
  slot.pendingChats = slot.pendingChats.filter((c) => c.at > sv.time);

  for (const c of due) {
    // The server resolves the loc, exactly as PF_bprint does through
    // QEX_VarString: no svc_print handler in any engine localizes anything,
    // so a `$key` put on the wire reaches the player as a `$key`.
    const line = `${slot.name}: ${Bot_ChatText(slot, c.event.locstring)}\n`;
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

/**
 * The chats a bot says about what just happened to it, read off the same
 * entvars a scoreboard is read off:
 *
 *   - `frags` going up is a kill; the weapon in hand says whether it was the
 *     axe, which chats.txt gives its own type to.
 *   - `frags` going down is the QuakeC's own suicide penalty (client.qc's
 *     ClientObituary, "killed self").
 *   - dying names its killer through `dmg_inflictor`, which T_Damage writes
 *     on every client it hurts (combat.qc). A missile's `owner` is the player
 *     who fired it; everything else is the attacker itself.
 *   - `view_ofs` going to the origin is the QuakeC putting the player into
 *     the intermission camera (client.qc's intermission loop), which is the
 *     end of the match.
 */
function Bot_ChatEvents(slot: BotSlot, ent: EdictT): void {
  const dead = ent.v.health <= 0 || ent.v.deadflag !== 0;
  const frags = ent.v.frags;

  if (slot.lastFrags !== frags && slot.spawnedFrags) {
    if (frags > slot.lastFrags) slot.brain.emitChat((ent.v.weapon | 0) === IT_AXE ? "axe_murder" : "fragged_enemy");
    else slot.brain.emitChat("fragged_self");
  }
  slot.lastFrags = frags;
  slot.spawnedFrags = true;

  if (dead && !slot.wasDead) slot.brain.emitChat(Bot_DeathChatType(ent));
  slot.wasDead = dead;

  const intermission = ent.v.view_ofs[0] === 0 && ent.v.view_ofs[1] === 0 && ent.v.view_ofs[2] === 0;
  if (intermission && !slot.sawIntermission) slot.brain.emitChat("match_end");
  slot.sawIntermission = intermission;
}

function Bot_DeathChatType(ent: EdictT): string {
  let killer = PROG_TO_EDICT(ent.v.dmg_inflictor);
  if (killer.index === 0 || killer === ent) return "fragged_self";
  if (killer.index > svs.maxclients && killer.v.owner !== 0) {
    const owner = PROG_TO_EDICT(killer.v.owner);
    if (owner.index !== 0) killer = owner;
  }
  if (killer === ent) return "fragged_self";
  if (((killer.v.flags | 0) & FL_MONSTER) !== 0) return "kia_monster";
  if (killer.index >= 1 && killer.index <= svs.maxclients) {
    const team = ent.v.team | 0;
    if (team > 0 && (killer.v.team | 0) === team) return "kia_friendly";
    return "kia_human";
  }
  return "fragged_self";
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

/**
 * Called at the end of SV_SpawnServer: reload the nav, re-seat every bot the
 * roster still holds, and let `bot_count` top the roster up.
 */
export function Bot_SpawnServer(mapname: string): void {
  Bot_ClearNav();
  Bot_LoadNav(mapname);

  // A pinned run is pinned for the bots too: a non-zero `sv_randomseed`
  // (src/server/sv_main.ts) reseeds the stream `addbot`'s own choices come
  // from -- which character, and the seed that character's brain rolls its
  // dice with -- so the same seed on the same map seats the same bots making
  // the same decisions. Unseeded, which is the default, the chain runs on
  // from wherever the session left it, and two matches in one session get
  // different bots.
  const seed = Math.trunc(Cvar_VariableValue("sv_randomseed"));
  if (seed !== 0) {
    botState.nextSeed = seed;
    botState.usedCharacters.clear();
  }

  const mode = Bot_GameMode();
  for (const [clientnum, slot] of botState.slots) {
    const client = svs.clients[clientnum];
    if (client === undefined || !client.active) continue;
    // The old level's nav graph and entity ids are gone.
    slot.brain.setGameMode(mode);
    slot.brain.resetForLevel();
    slot.pendingChats.length = 0;
    Bot_PutInServer(clientnum);
  }

  // Anything on the roster that lost its client slot to Host_ShutdownServer
  // comes back with the name, colours and skill it had.
  const seated = new Set<string>();
  for (const slot of botState.slots.values()) seated.add(slot.name);
  for (const entry of botState.roster) {
    if (seated.has(entry.name)) continue;
    if (botSeat(entry) < 0) break;
  }

  Bot_AutoFill(mapname);
  botState.reconciledAt = sv.time;
}

/**
 * `bot_count` auto-fill. Only on a multiplayer server, and only on a map
 * mapdb.json flags `bots` -- a map with no nav gives bots nothing to walk
 * along, and mapdb's own flag is the retail data's statement of which maps
 * were authored for them. `addbot` is not gated by either: an operator who
 * asks for a bot by hand gets one on any map.
 */
export function Bot_AutoFill(mapname: string): void {
  const want = Math.trunc(bot_count.value);
  if (want <= 0) return;
  if (!Bot_MultiplayerRuleset()) return;
  if (!Bot_MapAllowsBots(mapname)) {
    Con_Printf("bot_count: %s is not flagged for bots in mapdb.json\n", mapname);
    return;
  }
  Bot_Reconcile();
}

/**
 * Brings the auto-filled part of the roster to whatever `bot_count` says
 * right now: raising it puts bots in this frame, lowering it kicks the ones
 * added last. Bots an operator asked for by hand are neither counted nor
 * taken away, so `addbot` adds a bot on a server `bot_count` governs.
 */
export function Bot_Reconcile(): void {
  const want = Math.trunc(bot_count.value);
  if (want < 0) return;
  while (Bot_AutoCount() < want) {
    if (Bot_Add("random", "", true) < 0) break;
  }
  while (Bot_AutoCount() > want) {
    let at = -1;
    for (let i = botState.roster.length - 1; i >= 0; i--) {
      if (botState.roster[i]!.auto) {
        at = i;
        break;
      }
    }
    if (at < 0) return; // nothing left but bots an operator asked for
    const entry = botState.roster[at]!;
    let clientnum = -1;
    for (const [num, slot] of botState.slots) if (slot.name === entry.name) clientnum = num;
    if (clientnum < 0) {
      botState.roster.splice(at, 1);
      continue;
    }
    Bot_Remove(clientnum);
  }
}

/** How many of the roster `bot_count`'s auto-fill is responsible for. */
function Bot_AutoCount(): number {
  let n = 0;
  for (const e of botState.roster) if (e.auto) n++;
  return n;
}

/**
 * A server bots may fill: deathmatch, coop or horde. Single player (both
 * cvars 0) is the one ruleset the auto-fill leaves alone -- `addbot` still
 * works there. Coop and horde count because that is where the re-release's
 * own bots play: mapdb.json flags every horde map `bots`, and horde is coop
 * (see Bot_PrepareLevel).
 */
export function Bot_MultiplayerRuleset(): boolean {
  return deathmatch.value !== 0 || coop.value !== 0;
}

const mapdbCache: { loaded: boolean; bots: Set<string>; horde: Set<string> } = { loaded: false, bots: new Set<string>(), horde: new Set<string>() };

function loadMapdb(): void {
  if (mapdbCache.loaded) return;
  mapdbCache.loaded = true;
  const bytes = COM_LoadTempFile("mapdb.json");
  if (bytes === null) return;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const result = parseMapdb(new TextDecoder().decode(bytes.subarray(0, end)));
  for (const m of result.mapdb.maps) {
    if (m.bots) mapdbCache.bots.add(m.bsp.toLowerCase());
    if (m.horde) mapdbCache.horde.add(m.bsp.toLowerCase());
  }
}

export function Bot_MapAllowsBots(mapname: string): boolean {
  loadMapdb();
  // No mapdb at all (a classic install) means no statement either way, and
  // the operator's explicit `addbot` still works; only the auto-fill defers.
  if (mapdbCache.bots.size === 0) return false;
  return mapdbCache.bots.has(mapname.toLowerCase());
}

/** mapdb.json's own `"horde": true`, the retail data's list of horde maps. */
export function Bot_MapIsHorde(mapname: string): boolean {
  loadMapdb();
  return mapdbCache.horde.has(mapname.toLowerCase());
}

/** What Bot_PrepareLevel forced on, and what it puts back afterwards. */
const hordeMode: { forced: boolean; deathmatch: number; coop: number } = { forced: false, deathmatch: 0, coop: 0 };

/**
 * Horde is coop (addition, F13).
 *
 * mg1's horde maps carry `info_player_coop` spawn points and no
 * `info_player_deathmatch` at all, and quakec_mg1/client.qc:1135's
 * `info_player_coop` removes itself at load when `coop` is 0. So a horde map
 * started on a deathmatch server has no spawn point anyone can use:
 * SelectSpawnPoint (quakec_mg1/client.qc:684) answers `world`, and
 * PutClientInServer parks every client -- human and bot alike -- at the
 * intermission camera with `deadflag = DEAD_DEAD`, `SOLID_NOT` and
 * `MOVETYPE_NONE`, retrying every five seconds forever. The QuakeC's own
 * `horde_manager` says the same thing from the other side: it turns the
 * `horde` cvar on itself, but only `if (!cvar("horde") && !deathmatch)`
 * (quakec_mg1/horde.qc:1911).
 *
 * The retail engine's launcher picks the mode for the map -- mapdb.json's
 * `"horde": true` is that statement in the shipped data -- so this does the
 * same: a map the mapdb flags `horde` spawns with `coop 1` (SV_SpawnServer
 * then clears `deathmatch` itself, and `horde_manager` sets `horde 1`),
 * and the operator's own deathmatch/coop settings come back at the next
 * non-horde map, along with `horde 0`. Without the restore the QuakeC's
 * `horde` cvar would stay 1 into the next level, where SelectSpawnPoint's
 * horde branch finds no `info_player_coop` and drops every player onto one
 * `info_player_start`.
 */
export function Bot_PrepareLevel(mapname: string): void {
  if (Bot_MapIsHorde(mapname)) {
    if (coop.value !== 0) return;
    hordeMode.forced = true;
    hordeMode.deathmatch = deathmatch.value;
    hordeMode.coop = coop.value;
    Cvar_SetValue("coop", 1);
    Con_Printf("%s is a horde map (mapdb.json): coop 1\n", mapname);
    return;
  }
  if (!hordeMode.forced) return;
  hordeMode.forced = false;
  Cvar_SetValue("coop", hordeMode.coop);
  Cvar_SetValue("deathmatch", hordeMode.deathmatch);
  Cvar_SetValue("horde", 0);
}


export function Bot_ForgetMapdb(): void {
  mapdbCache.loaded = false;
  mapdbCache.bots.clear();
  mapdbCache.horde.clear();
  hordeMode.forced = false;
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
  Cvar_RegisterVariable(bot_chat);
  Cmd_AddCommand("addbot", Bot_AddBot_f);
  Cmd_AddCommand("kickbot", Bot_KickBot_f);
}
