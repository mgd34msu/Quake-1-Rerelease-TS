// W2: Multiplayer menus, real key events -- the Bots page (U40), the Start
// Server (GameOptions) screen's ruleset/protocol/bot rows and the server
// they actually start, and the Join screen's Protocol row.
// `bun test/e2e/w_multiplayer.ts`
import { boot, frames, exec, tap, check, summary, results, menuState, MStateT, asMState, asDest, Cvar_VariableString, Cvar_VariableValue, keyState, com_gamedir, W_HOMEDIR, conHas } from "./w_lib";
import { K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, KeydestT } from "../../src/client/keys";
import { LoadContentModel, RULESETS, SV_PROTOCOLS, CL_PROTOCOLS, BotsMenuAvailable, BuildBotsPageModel, AvailableBotSkillNames } from "../../src/client/menu_content";
import { tcpipAvailable } from "../../src/common/net_main";
import { sv, svs } from "../../src/server/server";
import { Bot_Slots, Bot_Count } from "../../src/bots";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;
const S = (n: number) => MStateT[n];

function esc(): void {
  tap(K_ESCAPE);
  frames(2);
}
function enter(n = 3): void {
  tap(K_ENTER);
  frames(n);
}
function down(n = 1): void {
  for (let i = 0; i < n; i++) tap(K_DOWNARROW);
  frames(1);
}
function left(): void {
  tap(K_LEFTARROW);
  frames(1);
}
function right(): void {
  tap(K_RIGHTARROW);
  frames(1);
}

// -homedir is REQUIRED here (see w_lib.ts's own header): the Start Server
// (GameOptions) screen's CTF game type queues a `game ctf` command, which
// without -homedir would point every subsequent write at the REAL retail
// ctf/ directory under Q1TS_DATA instead of scratch.
boot(["-basedir", BASE, "-ctf", "-game", "e2e_w", "-homedir", W_HOMEDIR, "-nosound"]);
frames(5);
exec("disconnect", 3);

// ============================================================================
// Part A: the Bots page (Multiplayer -> Bots), U40. bots/*.txt ships inside
// the real re-release id1/pak0.pak (verified: test/lib_botdata.test.ts's own
// retail survey), so a plain rerelease-root boot already has it mounted --
// no extra flag needed, unlike mg1/mg3/dopa/ctf's own separate gamedirs.
// ============================================================================
console.log("[W] === Bots page ===");
exec("maxplayers 8", 2);
exec("map dm1", 60); // id1's dm1 -- mapdb.json flags it bots:true (verified against the real file)
check("dm1 is up as a listen server", sv.active && sv.name === "dm1", `sv.active=${sv.active} sv.name=${sv.name}`);
keyState.key_dest = KeydestT.key_game;
frames(3);

check("BotsMenuAvailable() is true with a rerelease root mounted", BotsMenuAvailable(), "bots/*.txt ships in id1/pak0.pak");

esc();
check("ESC opens the main menu", asDest(keyState.key_dest) === KeydestT.key_menu && asMState(menuState.m_state) === MStateT.m_main, S(menuState.m_state));
menuState.m_main_cursor = 1;
enter();
check("main -> Multiplayer", asMState(menuState.m_state) === MStateT.m_multiplayer, S(menuState.m_state));

menuState.m_multiplayer_cursor = 0;
down(3); // real arrow-key navigation: only wraps past 3 back to 0 when the 4th (Bots) row exists
check("Multiplayer menu grows a 4th (Bots) row when bots/ is mounted", menuState.m_multiplayer_cursor === 3, `cursor=${menuState.m_multiplayer_cursor} (would be 0 with no bots data)`);

enter();
check("Multiplayer -> Bots page", asMState(menuState.m_state) === MStateT.m_qex_bots, S(menuState.m_state));

let model = BuildBotsPageModel("dm1");
check("Bots page: dm1 is flagged for bots (mapdb.json)", model.available && model.mapAllowsBots, `available=${model.available} mapAllowsBots=${model.mapAllowsBots}`);
check("Bots page: roster is read from characters.txt", model.roster.length > 0, `roster.length=${model.roster.length}`);
console.log(`  roster sample: ${JSON.stringify(model.roster.slice(0, 3))}`);

// Bot Count row (cursor 0): RIGHT increments the real `bot_count` cvar.
menuState.qexBotsCursor = 0;
const countBefore = Cvar_VariableValue("bot_count");
right();
right();
right();
check("Bots page: Bot Count row RIGHT changes bot_count", Cvar_VariableValue("bot_count") === countBefore + 3, `bot_count ${countBefore} -> ${Cvar_VariableValue("bot_count")}`);

// Bot Skill row (cursor 1): cycles bot_skill through the real skill names.
menuState.qexBotsCursor = 1;
model = BuildBotsPageModel("dm1");
const skillBefore = model.skillNames[model.skillIndex];
right();
model = BuildBotsPageModel("dm1");
const skillAfter = model.skillNames[model.skillIndex];
check("Bots page: Bot Skill row RIGHT changes bot_skill", skillAfter !== skillBefore, `bot_skill ${skillBefore} -> ${skillAfter} (cvar=${Cvar_VariableString("bot_skill")})`);

// Roster row: Add, then Kick, the first character.
model = BuildBotsPageModel("dm1");
const firstRow = model.roster[0]!;
menuState.qexBotsCursor = 2; // first roster row
const slotsBefore = Bot_Slots().size;
enter();
frames(20);
let slotsAfterAdd = Bot_Slots().size;
check(`Bots page: ENTER on "${firstRow.funName}" (Add) adds a bot`, slotsAfterAdd === slotsBefore + 1, `slots ${slotsBefore} -> ${slotsAfterAdd}`);
let anyNamed = [...Bot_Slots().values()].some((s) => s.name.toLowerCase() === firstRow.funName.toLowerCase());
check(`Bots page: the added bot is named "${firstRow.funName}" (characters.txt fun_name)`, anyNamed, `slots=${JSON.stringify([...Bot_Slots().values()].map((s) => s.name))}`);

model = BuildBotsPageModel("dm1"); // rebuild -- roster row 0's `active` should now read true
check("Bots page: roster row now shows Kick (active=true) after Add", model.roster[0]!.active, JSON.stringify(model.roster[0]));
menuState.qexBotsCursor = 2;
enter(); // same row, now issues kickbot
frames(20);
let slotsAfterKick = Bot_Slots().size;
check("Bots page: ENTER again (Kick) removes the bot", slotsAfterKick === slotsBefore, `slots ${slotsAfterAdd} -> ${slotsAfterKick}`);

// Add Random row (last row).
model = BuildBotsPageModel("dm1");
const addRandomRow = model.roster.length + 2;
menuState.qexBotsCursor = addRandomRow;
const beforeRandom = Bot_Count();
enter();
frames(20);
check("Bots page: Add Random row adds a bot", Bot_Count() === beforeRandom + 1, `Bot_Count ${beforeRandom} -> ${Bot_Count()}`);

esc();

// ============================================================================
// Part B: the Start Server (GameOptions) screen -- ruleset/protocol/bot rows
// change the cvars they claim to, Apply/Start uses them.
// ============================================================================
console.log("[W] === Start Server (GameOptions) ===");
exec("disconnect", 3);
exec("map start", 30);
keyState.key_dest = KeydestT.key_game;
frames(3);

function enterGameOptions(): boolean {
  esc();
  menuState.m_main_cursor = 1;
  enter();
  check("main -> Multiplayer (for GameOptions)", asMState(menuState.m_state) === MStateT.m_multiplayer, S(menuState.m_state));
  if (!tcpipAvailable) {
    check("tcpipAvailable is true on this host (required to reach GameOptions)", false, "tcpipAvailable=false -- Start Server/Join screens are unreachable in this environment; see report");
    return false;
  }
  menuState.m_multiplayer_cursor = 1; // New Game (StartingGame)
  enter();
  check("Multiplayer -> New Game opens the Net menu", asMState(menuState.m_state) === MStateT.m_net, S(menuState.m_state));
  enter(); // Net menu auto-selects tcpip on entry (M_Menu_Net_f's own down-arrow trick); ENTER opens LanConfig
  check("Net -> LanConfig", asMState(menuState.m_state) === MStateT.m_lanconfig, S(menuState.m_state));
  enter(); // LanConfig auto-selects "OK" for StartingGame; ENTER opens GameOptions
  check("LanConfig -> GameOptions (Start Server screen)", asMState(menuState.m_state) === MStateT.m_gameoptions, S(menuState.m_state));
  return asMState(menuState.m_state) === MStateT.m_gameoptions;
}

if (enterGameOptions()) {
  const content = LoadContentModel();
  check("GameOptions: content model is loaded (Episode/Level rows go mapdb-driven)", content.mapdbPresent, `mapdbPresent=${content.mapdbPresent}`);

  // Ruleset row (9)
  menuState.gameoptions_cursor = 9;
  const rulesetBefore = menuState.gameoptionsRulesetIndex;
  right();
  check("GameOptions Ruleset row RIGHT cycles gameoptionsRulesetIndex", menuState.gameoptionsRulesetIndex !== rulesetBefore, `${rulesetBefore} -> ${menuState.gameoptionsRulesetIndex}`);
  const targetRuleset = RULESETS[menuState.gameoptionsRulesetIndex]!.id;

  // Protocol row (10)
  menuState.gameoptions_cursor = 10;
  const protoBefore = menuState.gameoptionsProtocolIndex;
  right();
  check("GameOptions Protocol row RIGHT cycles gameoptionsProtocolIndex", menuState.gameoptionsProtocolIndex !== protoBefore, `${protoBefore} -> ${menuState.gameoptionsProtocolIndex}`);
  const targetProtocol = SV_PROTOCOLS[menuState.gameoptionsProtocolIndex]!;

  // Game Type row (2): Deathmatch -> Cooperative -> CTF (ctf gamedir mounted via -ctf)
  menuState.gameoptions_cursor = 2;
  right(); // Deathmatch -> Cooperative
  check("GameOptions Game Type: Deathmatch -> Cooperative sets coop=1", Cvar_VariableValue("coop") === 1, `coop=${Cvar_VariableValue("coop")}`);
  right(); // Cooperative -> CTF
  check("GameOptions Game Type: Cooperative -> CTF (ctf gamedir mounted)", menuState.gameoptionsCtf === true && Cvar_VariableValue("coop") === 0, `gameoptionsCtf=${menuState.gameoptionsCtf} coop=${Cvar_VariableValue("coop")}`);

  // Bot Count row (11)
  menuState.gameoptions_cursor = 11;
  menuState.gameoptionsBotCount = 0;
  right();
  right();
  check("GameOptions Bot Count row RIGHT changes gameoptionsBotCount", menuState.gameoptionsBotCount === 2, `gameoptionsBotCount=${menuState.gameoptionsBotCount}`);

  // Bot Skill row (12)
  menuState.gameoptions_cursor = 12;
  const botSkillBefore = menuState.gameoptionsBotSkillIndex;
  right();
  check("GameOptions Bot Skill row RIGHT changes gameoptionsBotSkillIndex", menuState.gameoptionsBotSkillIndex !== botSkillBefore, `${botSkillBefore} -> ${menuState.gameoptionsBotSkillIndex}`);
  const targetBotSkill = AvailableBotSkillNames()[menuState.gameoptionsBotSkillIndex]!;

  // Begin Game (row 0)
  menuState.gameoptions_cursor = 0;
  const svActiveBefore = sv.active;
  enter(3);
  frames(100);

  check("GameOptions Begin Game: a server starts", sv.active, `sv.active=${sv.active} (before=${svActiveBefore})`);
  // KNOWN DEFECT, same one w_newgame.ts's New Game screen hits and documents
  // in full (src/client/menu_content.ts's Content_PerformLaunch): the SERVER
  // prints the right ruleset/protocol at spawn (checked below via the
  // console line) but M_GameOptions_Key's own ENTER handler (src/client/
  // menu.ts) has the identical ordering bug -- it queues `sv_ruleset <id>`/
  // `sv_protocol <val>` as Cbuf command TEXT (not even a synchronous
  // Cvar_Set this time) ahead of `game <dir>`, whose own Host_Game_f queues
  // `exec quake.rc` by appending to the SAME buffer's tail; that exec chain
  // runs after every other line already queued in this batch (including
  // `map`) and re-execs the target gamedir's own archived config.cfg,
  // reverting both cvars a few frames after spawn.
  check("GameOptions Begin Game: server printed the requested ruleset at spawn", conHas(`Server ruleset ${targetRuleset}`), `expected console line "Server ruleset ${targetRuleset}"`);
  check("GameOptions Begin Game: server printed the requested protocol at spawn", conHas(`Server protocol ${targetProtocol}`), `expected console line "Server protocol ${targetProtocol}"`);
  check(
    "GameOptions Begin Game: sv_ruleset cvar still reads the choice after quake.rc's config.cfg re-exec (KNOWN DEFECT, see comment above)",
    Cvar_VariableString("sv_ruleset") === targetRuleset,
    `sv_ruleset=${Cvar_VariableString("sv_ruleset")} want=${targetRuleset}`,
  );
  check(
    "GameOptions Begin Game: sv_protocol cvar still reads the choice after quake.rc's config.cfg re-exec (KNOWN DEFECT, see comment above)",
    Cvar_VariableString("sv_protocol") === targetProtocol,
    `sv_protocol=${Cvar_VariableString("sv_protocol")} want=${targetProtocol}`,
  );
  check("GameOptions Begin Game: game dir switched to ctf (CTF game type)", com_gamedir.toLowerCase().endsWith("/ctf"), `com_gamedir=${com_gamedir}`);
  check("GameOptions Begin Game: teamplay 1 (CTF)", Cvar_VariableValue("teamplay") === 1, `teamplay=${Cvar_VariableValue("teamplay")}`);
  check("GameOptions Begin Game: bot_count cvar matches the Bot Count row", Cvar_VariableValue("bot_count") === 2, `bot_count=${Cvar_VariableValue("bot_count")}`);
  check("GameOptions Begin Game: bot_skill cvar matches the Bot Skill row", Cvar_VariableString("bot_skill") === targetBotSkill, `bot_skill=${Cvar_VariableString("bot_skill")} want=${targetBotSkill}`);
  console.log(`  post-launch: sv.name=${sv.name} sv.protocol=${sv.protocol} maxclients=${svs.maxclients} bot slots=${Bot_Slots().size}`);
  check("GameOptions Begin Game: the started server actually uses bot_count (auto-fill spawned bots)", Bot_Slots().size === 2, `Bot_Slots().size=${Bot_Slots().size} want=2 (deathmatch-off under ctf teamplay is a defect candidate -- see report)`);
}

// ============================================================================
// Part C: Join screen's Protocol row sets cl_protocol.
// ============================================================================
console.log("[W] === Join screen Protocol row ===");
exec("disconnect", 3);
exec("map start", 20);
keyState.key_dest = KeydestT.key_game;
frames(3);

esc();
menuState.m_main_cursor = 1;
enter();
if (tcpipAvailable) {
  menuState.m_multiplayer_cursor = 0; // Join a Game (JoiningGame)
  enter();
  check("Multiplayer -> Join opens the Net menu", asMState(menuState.m_state) === MStateT.m_net, S(menuState.m_state));
  enter();
  check("Net -> LanConfig (Join)", asMState(menuState.m_state) === MStateT.m_lanconfig, S(menuState.m_state));

  const protoRow = 3; // LANCONFIG_PROTOCOL_ROW, Join-only
  menuState.lanConfig_cursor = protoRow;
  const before = Cvar_VariableString("cl_protocol").trim().toLowerCase() || "auto";
  right();
  const after = Cvar_VariableString("cl_protocol").trim().toLowerCase() || "auto";
  check("Join screen Protocol row RIGHT cycles cl_protocol", after !== before, `cl_protocol ${before} -> ${after}`);
  check("cl_protocol lands on a value from CL_PROTOCOLS", CL_PROTOCOLS.includes(after), `cl_protocol=${after} CL_PROTOCOLS=${CL_PROTOCOLS.join(",")}`);
} else {
  check("tcpipAvailable is true (required for the Join screen's Protocol row)", false, "tcpipAvailable=false in this environment; see report");
}

summary("W2 multiplayer");
process.exit(results.some((r) => !r.pass) ? 1 : 0);
