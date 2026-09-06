/*
The Quake 1 binding of the bot brain: the composition root pulls this in
(src/common/host.ts, at the end of its imports, the same way it pulls in
src/server/compat_spawn.ts) and everything wires itself up on import.

Three registrations, and no other engine surface:

  - `svMainHooks.isBot` / `.botThink` / `.serverFrame` / `.prepareLevel` /
    `.spawnServer` / `.shutdownServer`,
    which is how SV_RunClients, SV_SendClientMessages, SV_SpawnServer and
    Host_ShutdownServer learn that a client slot with no socket is a bot
    rather than a broken connection, and where the roster is taken out of
    svs.clients between levels and put back into the next one.
    `.serverFrame` is the once-a-frame roster reconcile, which has to run
    whether or not a bot exists to run it; `.prepareLevel` is the ruleset a
    map needs before its entities are spawned (Bot_PrepareLevel).
  - `qexBotHooks` / `qexNavHooks`, the three re-release navigation builtins.
  - the `addbot` / `kickbot` commands and the `bot_skill` / `bot_count` /
    `bot_chat` cvars.
*/

import { svMainHooks } from "../server/sv_main";
import { Bot_Frame, Bot_IsBotClient, Bot_PrepareLevel, Bot_RegisterCommands, Bot_SpawnServer, Bot_Suspend, Bot_Think } from "./bot_client";
import { Bot_ClearMonsterPaths, Bot_RegisterHooks } from "./bot_hooks";

export { Bot_Add, Bot_Count, Bot_Frame, Bot_GameMode, Bot_IsBotClient, Bot_MultiplayerRuleset, Bot_PrepareLevel, Bot_Reconcile, Bot_Remove, Bot_RemoveAll, Bot_Roster, Bot_Slots, Bot_SkillName, Bot_Suspend, Bot_MapAllowsBots, Bot_MapIsHorde, Bot_ForgetMapdb, bot_chat, bot_count, bot_skill, type BotRosterEntryT } from "./bot_client";
export { Bot_ClearNav, Bot_ForgetKnowledge, Bot_Knowledge, Bot_LoadNav, Bot_Nav } from "./bot_data";
export { Bot_ClearMonsterPaths, Bot_GoalBuiltins, Bot_MonsterPath, Bot_RegisterHooks, Bot_UnregisterHooks, Bot_WalkPathToGoal } from "./bot_hooks";
export { BotServerWorld, FL_ISBOT, edictIsBot } from "./bot_world";

svMainHooks.isBot = Bot_IsBotClient;
svMainHooks.serverFrame = Bot_Frame;
svMainHooks.prepareLevel = Bot_PrepareLevel;
svMainHooks.botThink = Bot_Think;
svMainHooks.spawnServer = (mapname: string): void => {
  Bot_ClearMonsterPaths();
  Bot_SpawnServer(mapname);
};
svMainHooks.shutdownServer = (): void => {
  Bot_ClearMonsterPaths();
  Bot_Suspend();
};

Bot_RegisterHooks();
Bot_RegisterCommands();
