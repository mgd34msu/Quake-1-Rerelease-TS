// Reader for the 2021 re-release's mapdb.json episode/level catalog
// (shipped only in id1/pak0.pak; mg1/mg3/ctf/hipnotic/rogue/dopa content is
// listed inside the SAME file via each map's "game" field, not a per-tree
// copy -- see this file's header evidence below). Not a ported C file --
// the KEX engine that reads this is closed; style reference only is
// quake-2-re-ts's src/qcommon/mapdb.ts (a different game's mapdb.json
// shape, ported from q2repro's mapdb.c/mapdb.h), read for how that port
// structures a JSON-catalog reader, not for field names -- Quake I's
// mapdb.json is a different, simpler schema entirely.
//
// REAL SCHEMA (extracted 2026-09-06 from
// ~/Projects/qfiles/q1/rerelease/id1/pak0.pak's mapdb.json -- 27836 bytes,
// 6 episodes, 143 maps -- the actual retail file, not a guess):
//
//   {
//     "episodes": [
//       { "dir": "id1", "name": "$m_quake" },
//       { "dir": "hipnotic", "name": "$m_scourge" },
//       { "dir": "rogue", "name": "$m_dissolution" },
//       { "dir": "dopa", "name": "$m_dopa" },
//       { "dir": "mg1", "name": "$m_mg1" },
//       { "dir": "mg3", "name": "$m_mg3" }
//     ],
//     "maps": [
//       { "title": "Place of Two Deaths", "bsp": "dm1", "episode": "id1",
//         "game": "id1", "dm": true, "coop": false, "bots": true,
//         "sp": false },
//       { "title": "McKinley Base", "bsp": "ctf1", "episode": "id1",
//         "game": "ctf", "bots": true, "ctf": true },
//       ...
//     ]
//   }
//
// Every map entry in the real file spells the field "bots" (plural) --
// unlike quake-2-re-ts's mapdb.json, whose real data disagreed with its own
// C source's field name (see that file's header note); Quake I's file and
// this port agree, nothing to reconcile.
//
// `game` distinguishes content ("id1", "hipnotic", "rogue", "dopa", "mg1",
// "mg3", "ctf" all occur) independently of `episode` (the UI grouping a map
// is listed under -- every one of the 9 ctf maps has `episode: "id1"` and
// `game: "ctf"`, so `episode` is not simply an alias for `game`).
//
// Every one of episodes[].dir/name and maps[].title/bsp/episode/game is a
// plain string in the real file; every one of maps[].sp/dm/coop/bots/ctf/
// horde is a plain boolean where present. None of the 143 real entries
// omits `title`, `bsp`, `episode` or `game`, but the brief's own field
// list marks the flags optional -- consistent with the real file, where
// most entries carry only 2-4 of the 6 flag keys and simply omit the
// rest -- so a missing flag defaults to `false` here (PORTING.md "C
// structs -> class with every field initialized", the same convention
// quake-2-re-ts's mapdb.ts applies to q2repro's mallocz-zeroed struct).
// `title` may itself be a `$key` localization key (see src/lib/loc.ts) in
// principle -- the field is read as a plain string either way, since
// resolving `$key` lookups is loc.ts's and its caller's job, not this
// module's; no `$`-prefixed title occurs in the real file (all 143 are
// plain display strings), so this is untested against retail data and
// documented here rather than asserted.

export interface MapdbEpisode {
  dir: string;
  name: string;
}

export class MapdbMap {
  title = "";
  bsp = "";
  episode = "";
  game = "";
  sp = false;
  dm = false;
  coop = false;
  bots = false;
  ctf = false;
  horde = false;
}

export interface Mapdb {
  episodes: MapdbEpisode[];
  maps: MapdbMap[];
}

export interface MapdbParseResult {
  mapdb: Mapdb;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function bool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return typeof v === "boolean" ? v : false;
}

function parseEpisode(v: unknown, index: number, errors: string[]): MapdbEpisode | undefined {
  if (!isRecord(v)) {
    errors.push(`episodes[${index}]: not an object`);
    return undefined;
  }
  const dir = str(v, "dir");
  const name = str(v, "name");
  if (dir === undefined) errors.push(`episodes[${index}]: missing or non-string "dir"`);
  if (name === undefined) errors.push(`episodes[${index}]: missing or non-string "name"`);
  if (dir === undefined || name === undefined) return undefined;
  return { dir, name };
}

function parseMap(v: unknown, index: number, errors: string[]): MapdbMap | undefined {
  if (!isRecord(v)) {
    errors.push(`maps[${index}]: not an object`);
    return undefined;
  }
  const title = str(v, "title");
  const bsp = str(v, "bsp");
  const episode = str(v, "episode");
  const game = str(v, "game");
  if (title === undefined) errors.push(`maps[${index}]: missing or non-string "title"`);
  if (bsp === undefined) errors.push(`maps[${index}]: missing or non-string "bsp"`);
  if (episode === undefined) errors.push(`maps[${index}]: missing or non-string "episode"`);
  if (game === undefined) errors.push(`maps[${index}]: missing or non-string "game"`);
  if (title === undefined || bsp === undefined || episode === undefined || game === undefined) return undefined;

  const map = new MapdbMap();
  map.title = title;
  map.bsp = bsp;
  map.episode = episode;
  map.game = game;
  map.sp = bool(v, "sp");
  map.dm = bool(v, "dm");
  map.coop = bool(v, "coop");
  map.bots = bool(v, "bots");
  map.ctf = bool(v, "ctf");
  map.horde = bool(v, "horde");
  return map;
}

/**
 * Parses mapdb.json's text content. Never throws: a malformed document (bad
 * JSON, wrong root shape, a malformed entry) is reported in `errors` and
 * that entry is skipped rather than aborting the whole parse -- entries
 * that DO parse are still returned, matching quake-2-re-ts's mapdb.ts's
 * "warn and continue" behavior for its own (different) mapdb.json.
 */
export function parseMapdb(text: string): MapdbParseResult {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { mapdb: { episodes: [], maps: [] }, errors: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  if (!isRecord(parsed)) {
    return { mapdb: { episodes: [], maps: [] }, errors: ["root value is not an object"] };
  }

  const episodesRaw = parsed["episodes"];
  const episodes: MapdbEpisode[] = [];
  if (Array.isArray(episodesRaw)) {
    episodesRaw.forEach((e, i) => {
      const parsedEpisode = parseEpisode(e, i, errors);
      if (parsedEpisode !== undefined) episodes.push(parsedEpisode);
    });
  } else {
    errors.push('"episodes" is missing or not an array');
  }

  const mapsRaw = parsed["maps"];
  const maps: MapdbMap[] = [];
  if (Array.isArray(mapsRaw)) {
    mapsRaw.forEach((m, i) => {
      const parsedMap = parseMap(m, i, errors);
      if (parsedMap !== undefined) maps.push(parsedMap);
    });
  } else {
    errors.push('"maps" is missing or not an array');
  }

  return { mapdb: { episodes, maps }, errors };
}
