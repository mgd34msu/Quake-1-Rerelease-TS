// W1: New Game from the main menu, real key events, mapdb-driven episode/
// level/ruleset/difficulty picker, mission-pack episode, and Add-Ons.
// `bun test/e2e/w_newgame.ts`
import { boot, frames, exec, tap, check, summary, results, menuState, MStateT, asMState, Cvar_VariableString, Cvar_VariableValue, com_gamedir, conHas, W_HOMEDIR } from "./w_lib";
import { K_ESCAPE, K_ENTER, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW } from "../../src/client/keys";
import { LoadContentModel, LocalizedEpisodeName, LoadMenuLocalization, RULESETS, DIFFICULTIES, CtfMaps, type ContentEpisode } from "../../src/client/menu_content";
import { sv } from "../../src/server/server";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;

// plain `-basedir` (no -norerelease) auto-detects the nested rerelease/ root
// (see test/e2e/README.md's "Retail data" and E2E-COMMON.md) -- this family
// is entirely about the re-release's mapdb-driven menus, so that is exactly
// the mode every w_*.ts driver wants. `-homedir` is REQUIRED here (see
// w_lib.ts's own header on this): New Game's mission-pack episodes and
// Add-Ons both queue a `game <dir>` command, which without `-homedir` would
// point every subsequent write (autosave, config.cfg) at the REAL retail
// hipnotic/mg1/mg3/dopa/ctf directories under Q1TS_DATA instead of scratch.
boot(["-basedir", BASE, "-game", "e2e_w", "-homedir", W_HOMEDIR]);
frames(5);
exec("disconnect", 3);

const model = LoadContentModel();
check("rerelease mapdb.json is mounted", model.mapdbPresent, `episodes=${model.episodes.map((e) => e.dir).join(",")}`);
check("at least one sp episode is available", model.episodes.length > 0, `count=${model.episodes.length}`);

function openEpisodePicker(): void {
  exec("menu_singleplayer", 3);
  menuState.m_singleplayer_cursor = 0;
  tap(K_ENTER);
  frames(3);
}

function pickEpisodeAndLevel(episodeIndex: number, levelIndex: number, rulesetId: "classic" | "rerelease", skill: number, label: string): ContentEpisode {
  openEpisodePicker();
  check(`${label}: New Game opens the episode picker`, asMState(menuState.m_state) === MStateT.m_qex_episodes, `m_state=${menuState.m_state}`);

  const episodes = LoadContentModel().episodes;
  const episode = episodes[episodeIndex];
  if (!episode) throw new Error(`${label}: no episode at index ${episodeIndex}`);

  menuState.qexEpisodeCursor = episodeIndex;
  tap(K_ENTER);
  frames(2);
  check(`${label}: picking the episode opens the level screen`, asMState(menuState.m_state) === MStateT.m_qex_levels, `m_state=${menuState.m_state}`);

  const maps = episode.maps;
  const rulesetRow = maps.length;
  const difficultyRow = maps.length + 1;
  const startRow = maps.length + 2;

  // pick the level
  menuState.qexLevelCursor = levelIndex;
  tap(K_ENTER);
  frames(1);
  check(`${label}: level ${levelIndex} selected`, menuState.qexSelectedLevel === levelIndex, `qexSelectedLevel=${menuState.qexSelectedLevel}`);

  // ruleset row: cycle RIGHT until it reads the requested ruleset
  menuState.qexLevelCursor = rulesetRow;
  for (let i = 0; i < RULESETS.length && RULESETS[menuState.qexRulesetIndex]!.id !== rulesetId; i++) {
    tap(K_RIGHTARROW);
    frames(1);
  }
  check(`${label}: ruleset row reads ${rulesetId}`, RULESETS[menuState.qexRulesetIndex]!.id === rulesetId, `got=${RULESETS[menuState.qexRulesetIndex]!.id}`);

  // difficulty row: cycle RIGHT until it reads the requested skill
  menuState.qexLevelCursor = difficultyRow;
  for (let i = 0; i < DIFFICULTIES.length && menuState.qexSkill !== skill; i++) {
    tap(K_RIGHTARROW);
    frames(1);
  }
  check(`${label}: difficulty row reads ${DIFFICULTIES[skill]}`, menuState.qexSkill === skill, `got=${DIFFICULTIES[menuState.qexSkill]}`);

  // Start
  menuState.qexLevelCursor = startRow;
  tap(K_ENTER);
  frames(30);

  const wantBsp = maps[levelIndex]!.bsp;
  check(`${label}: the map that loads is the one picked (${wantBsp})`, sv.name === wantBsp, `sv.name=${sv.name}`);
  check(`${label}: skill matches the choice`, Cvar_VariableValue("skill") === skill, `skill=${Cvar_VariableValue("skill")}`);
  // DEFECT (confirmed by this driver, exact repro below): the SERVER prints
  // the correct ruleset at spawn ("Server ruleset <id>", src/progs/ext/
  // ruleset.ts:269, called from QEX_AfterLoadProgs during SV_SpawnServer) --
  // checked here via the console line, not just the cvar -- but the
  // `sv_ruleset` CVAR itself reads back "auto" moments later. Root cause:
  // src/client/menu_content.ts's Content_PerformLaunch does a SYNCHRONOUS
  // `Cvar_Set("sv_ruleset", plan.ruleset)` and then QUEUES (Cbuf_AddText)
  // `game <dir>` before `skill`/`map`; Host_Game_f (src/common/host_cmd.ts
  // Host_Game_f) itself queues `exec quake.rc`, which Cbuf_AddText appends
  // to the TAIL of the same buffer -- so it runs AFTER the already-queued
  // `skill`/`map` lines, not before them. quake.rc execs default.cfg then
  // the NEWLY MOUNTED gamedir's own config.cfg, an archived-cvar dump from
  // that content's last clean shutdown; this repo's own retail data already
  // has one on disk with `sv_ruleset "auto"` at rerelease/id1/config.cfg
  // line 54 (a real install that ever quit cleanly writes one), so picking
  // a ruleset in the New Game screen
  // is silently reverted a few frames after the level spawns, and any LATER
  // changelevel/restart/reconnect in the same session re-reads `SV_Ruleset()`
  // and gets "auto" instead of the user's explicit choice.
  check(`${label}: server printed the requested ruleset at spawn`, conHas(`Server ruleset ${rulesetId}`), `expected console line "Server ruleset ${rulesetId}"`);
  check(
    `${label}: sv_ruleset cvar still reads the choice after quake.rc's config.cfg re-exec (KNOWN DEFECT, see comment above)`,
    Cvar_VariableString("sv_ruleset") === rulesetId,
    `sv_ruleset=${Cvar_VariableString("sv_ruleset")} -- clobbered back to the target gamedir's archived config.cfg value by Host_Game_f's queued "exec quake.rc"`,
  );

  exec("disconnect", 3);
  return episode;
}

// ---- id1, rerelease ruleset -----------------------------------------------
const id1Index = model.episodes.findIndex((e) => e.dir === "id1");
check("id1 is one of the mounted episodes", id1Index >= 0, `dirs=${model.episodes.map((e) => e.dir).join(",")}`);
if (id1Index >= 0) pickEpisodeAndLevel(id1Index, 0, "rerelease", 1, "id1/rerelease");

// ---- id1, classic ruleset (same content, forced classic profile) ---------
if (id1Index >= 0) pickEpisodeAndLevel(id1Index, 1 % Math.max(1, model.episodes[id1Index]!.maps.length), "classic", 0, "id1/classic");

// ---- a mission-pack episode ------------------------------------------------
const mpIndex = model.episodes.findIndex((e) => e.dir !== "id1");
check("a mission-pack episode is mounted", mpIndex >= 0, `dirs=${model.episodes.map((e) => e.dir).join(",")}`);
if (mpIndex >= 0) {
  const ep = pickEpisodeAndLevel(mpIndex, 0, "rerelease", 2, `mission-pack (${model.episodes[mpIndex]!.dir})`);
  check("mission-pack launch used its own gamedir", com_gamedir.toLowerCase().endsWith(`/${ep.dir}`), `com_gamedir=${com_gamedir}`);
}

// ---- Add-Ons ----------------------------------------------------------------
exec("disconnect", 3);
exec("menu_main", 3);
menuState.m_main_cursor = 2;
tap(K_ENTER);
frames(2);
check("main -> Options", asMState(menuState.m_state) === MStateT.m_options, `m_state=${menuState.m_state}`);

menuState.options_cursor = 19;
tap(K_ENTER);
frames(2);
check("Options -> Add-Ons", asMState(menuState.m_state) === MStateT.m_qex_addons, `m_state=${menuState.m_state}`);

const addonModel = LoadContentModel();
console.log(`  addonDirs = ${addonModel.addonDirs.join(",")}`);
for (const wanted of ["mg1", "mg3", "dopa"]) {
  const rowIndex = addonModel.addonDirs.indexOf(wanted);
  if (rowIndex < 0) {
    check(`Add-Ons row for "${wanted}" (skipped: not mounted)`, true, "not mounted in this Q1TS_DATA");
    continue;
  }
  exec("menu_addons", 3);
  menuState.qexAddonsCursor = rowIndex + 1; // +1: row 0 is the synthetic "Base Game"
  tap(K_ENTER);
  frames(3);

  const ep = LoadContentModel().episodes.find((e) => e.dir === wanted);
  check(`Add-Ons: choosing "${wanted}" switches the active gamedir`, com_gamedir.toLowerCase().endsWith(`/${wanted}`), `com_gamedir=${com_gamedir}`);
  if (ep) {
    exec(`map ${ep.maps[0]!.bsp}`, 25);
    check(`Add-Ons: "${wanted}"'s first map loads`, sv.name === ep.maps[0]!.bsp, `sv.name=${sv.name} want=${ep.maps[0]!.bsp}`);
  }
  exec("disconnect", 3);
}

// ctf: an addon with no sp campaign of its own (menu_content.ts's own header:
// every ctf map is `episode: "id1", game: "ctf"`, not a seventh episodes[]
// row) -- "choosing one loads its first map" here means its first CTF map.
{
  const rawMapdb = addonModel.rawMapdb;
  const ctfRowIndex = addonModel.addonDirs.indexOf("ctf");
  if (ctfRowIndex < 0 || rawMapdb === null) {
    check("Add-Ons row for ctf (skipped: not mounted)", true, "not mounted in this Q1TS_DATA");
  } else {
    exec("menu_addons", 3);
    menuState.qexAddonsCursor = ctfRowIndex + 1;
    tap(K_ENTER);
    frames(3);
    check("Add-Ons: choosing ctf switches the active gamedir", com_gamedir.toLowerCase().endsWith("/ctf"), `com_gamedir=${com_gamedir}`);

    const ctfMaps = CtfMaps(rawMapdb);
    check("ctf has at least one map", ctfMaps.length > 0, `count=${ctfMaps.length}`);
    if (ctfMaps.length > 0) {
      exec(`map ${ctfMaps[0]!.bsp}`, 25);
      check("Add-Ons: ctf's first map loads", sv.name === ctfMaps[0]!.bsp, `sv.name=${sv.name} want=${ctfMaps[0]!.bsp}`);
    }
    exec("disconnect", 3);
  }
}

// ---- episode name localization sanity (loc coverage lives in w_loc.ts) ---
{
  const locCount = LoadMenuLocalization();
  const id1Episode = LoadContentModel().episodes.find((e) => e.dir === "id1");
  if (id1Episode) {
    console.log(`  id1 episode nameKey=${id1Episode.nameKey} localized=${LocalizedEpisodeName(id1Episode.nameKey, locCount > 0)}`);
  }
}

summary("W1 newgame");
process.exit(results.some((r) => !r.pass) ? 1 : 0);
