/*
The Quake 1 binding of the bot brain: the composition root pulls this in
(src/common/host.ts, at the end of its imports, the same way it pulls in
src/server/compat_spawn.ts) and everything wires itself up on import.

Three registrations, and no other engine surface:

  - `svMainHooks.isBot` / `.botThink` / `.spawnServer`, which is how
    SV_RunClients, SV_SendClientMessages and SV_SpawnServer learn that a
    client slot with no socket is a bot rather than a broken connection.
  - `qexBotHooks` / `qexNavHooks`, the three re-release navigation builtins.
  - the `addbot` / `kickbot` commands and the `bot_skill` / `bot_count`
    cvars.
*/

import { svMainHooks } from "../server/sv_main";
import { Bot_IsBotClient, Bot_RegisterCommands, Bot_SpawnServer, Bot_Think } from "./bot_client";
import { Bot_ClearMonsterPaths, Bot_RegisterHooks } from "./bot_hooks";

export { Bot_Add, Bot_Count, Bot_IsBotClient, Bot_Remove, Bot_RemoveAll, Bot_Slots, Bot_SkillName, Bot_MapAllowsBots, Bot_ForgetMapdb, bot_count, bot_skill } from "./bot_client";
export { Bot_ClearNav, Bot_ForgetKnowledge, Bot_Knowledge, Bot_LoadNav, Bot_Nav } from "./bot_data";
export { Bot_ClearMonsterPaths, Bot_GoalBuiltins, Bot_MonsterPath, Bot_RegisterHooks, Bot_UnregisterHooks, Bot_WalkPathToGoal } from "./bot_hooks";
export { BotServerWorld, FL_ISBOT, edictIsBot } from "./bot_world";

svMainHooks.isBot = Bot_IsBotClient;
svMainHooks.botThink = Bot_Think;
svMainHooks.spawnServer = (mapname: string): void => {
  Bot_ClearMonsterPaths();
  Bot_SpawnServer(mapname);
};

Bot_RegisterHooks();
Bot_RegisterCommands();
