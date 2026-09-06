/*
The retail bots/ data, loaded off the running game's filesystem.

Nine text files (bots/characters.txt, weapons.txt, items.txt, monsters.txt,
interactables.txt, game_rules.txt, teams.txt, chats.txt and one of the three
settings_*.txt) and one .nav per map. Each mod tree ships its own copy, so
these go through COM_LoadTempFile like every other game asset and pick up
whatever the active game directory shadows them with -- ctf's items.txt has
the flag entries id1's does not, and mg1's weapons.txt has the mission-pack
ammo types.

A map with no .nav is normal, not an error: only the maps mapdb.json flags
`bots` ship one, and the QuakeC's own PATH_ERROR fallback covers the rest.
*/

import { COM_LoadTempFile } from "../common/common";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { parseNav } from "../lib/nav";
import { BotKnowledge, type BotDataFilesT } from "../lib/bot_brain/knowledge";
import { navGraphFromNav2, type NavGraph } from "../lib/bot_brain/nav_graph";

function loadText(path: string): string | null {
  const bytes = COM_LoadTempFile(path);
  if (bytes === null) return null;
  // COM_LoadFile pads every load with a trailing NUL; trim it before the
  // tokenizer sees it (src/client/menu_content.ts does the same for
  // mapdb.json).
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return Buffer.from(bytes.subarray(0, end)).toString("latin1");
}



/**
 * Settings are per platform in the retail data. All three files are
 * byte-identical in id1 (see src/lib/botdata.ts's header), so this prefers
 * the PC one and falls back rather than making the caller choose.
 */
const SETTINGS_FILES = ["bots/settings_PC.txt", "bots/settings_Consoles.txt", "bots/settings_Nintendo.txt"];

const botDataState: { knowledge: BotKnowledge | null; nav: NavGraph | null; navMap: string } = {
  knowledge: null,
  nav: null,
  navMap: "",
};

/**
 * Loads (once per game directory change) every bots/*.txt file. Returns null
 * when the tree has no bots/ directory at all, which is every classic
 * install.
 */
export function Bot_Knowledge(): BotKnowledge | null {
  if (botDataState.knowledge !== null) return botDataState.knowledge;

  const weapons = loadText("bots/weapons.txt");
  if (weapons === null) return null; // no bot data in this tree

  let settings: string | null = null;
  for (const path of SETTINGS_FILES) {
    settings = loadText(path);
    if (settings !== null) break;
  }
  if (settings === null) {
    Con_Printf("bots: bots/weapons.txt found but no settings_*.txt; bots disabled\n");
    return null;
  }

  const files: BotDataFilesT = {
    characters: loadText("bots/characters.txt") ?? "",
    weapons,
    items: loadText("bots/items.txt") ?? "",
    monsters: loadText("bots/monsters.txt") ?? "",
    interactables: loadText("bots/interactables.txt") ?? "",
    gameRules: loadText("bots/game_rules.txt") ?? "",
    teams: loadText("bots/teams.txt") ?? "",
    chats: loadText("bots/chats.txt") ?? "",
    settings,
  };

  const knowledge = new BotKnowledge(files);
  for (const e of knowledge.errors) Con_DPrintf("bots: %s\n", e);
  Con_DPrintf("bots: %i characters, %i weapons, %i items, %i skills\n", knowledge.characters.length, knowledge.weapons.length, knowledge.items.length, knowledge.skills.length);

  botDataState.knowledge = knowledge;
  return knowledge;
}

/** Drops the cached knowledge so a `game` change re-reads the new tree's files. */
export function Bot_ForgetKnowledge(): void {
  botDataState.knowledge = null;
}

//============================================================================

/**
 * Loads `bots/navigation/<map>.nav` and builds the searchable graph. Called
 * once per SV_SpawnServer; a map with no nav file leaves the graph null and
 * every path request answers PATH_ERROR, which is exactly what the QuakeC's
 * `ai_pathtogoal` expects when it falls back to `movetogoal`.
 */
export function Bot_LoadNav(mapname: string): NavGraph | null {
  if (botDataState.navMap === mapname) return botDataState.nav;

  botDataState.navMap = mapname;
  botDataState.nav = null;

  const bytes = COM_LoadTempFile(`bots/navigation/${mapname}.nav`);
  if (bytes === null) {
    // A tree with bots/ data is one where navigation is expected, so the
    // absence of it is worth saying out loud: bots on such a map wander
    // rather than path, and an operator who typed `addbot` deserves to know
    // why. A classic install has no bots/ data at all and says nothing.
    if (Bot_Knowledge() === null) Con_DPrintf("bots: no navigation for %s\n", mapname);
    else Con_Printf("bots: no navigation for %s; bots will wander instead of pathing\n", mapname);
    return null;
  }

  // COM_LoadFile "always appends a 0 byte" (common.ts), and parseNav insists
  // that its computed end offset lands EXACTLY on end-of-file -- so the pad
  // byte has to come off first or every real .nav is rejected as truncated.
  const result = parseNav(bytes.length > 0 ? bytes.subarray(0, bytes.length - 1) : bytes);
  for (const e of result.errors) Con_DPrintf("bots: %s.nav: %s\n", mapname, e);
  if (result.file === undefined) {
    Con_Printf("bots: %s.nav could not be read; bots will not path on this map\n", mapname);
    return null;
  }

  const graph = navGraphFromNav2(result.file);
  Con_DPrintf("bots: %s.nav v%i, %i nodes, %i links, %i entity links\n", mapname, result.file.version, graph.nodeCount, graph.links.length, graph.entityLinks.length);
  botDataState.nav = graph;
  return graph;
}

/** The graph for the map currently running, or null. */
export function Bot_Nav(): NavGraph | null {
  return botDataState.nav;
}

/** Forgets the loaded graph; the next SV_SpawnServer re-reads one. */
export function Bot_ClearNav(): void {
  botDataState.nav = null;
  botDataState.navMap = "";
}
