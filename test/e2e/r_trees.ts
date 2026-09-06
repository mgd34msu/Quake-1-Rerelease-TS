/*
Family R, driver 1: every re-release content tree, end to end, in one renderer.

  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/r_trees.ts --tree mg1
  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/r_trees.ts --tree mg1 --vid gl

Boots the re-release root with the tree's own episode flag (r_lib.ts's
treeConfig, straight out of test/support/sweep_lib.ts's table), then loads the
maps r_lib.ts's mapsForTree picks out of the retail mapdb.json -- the first map
of every episode for id1/hipnotic/rogue, every map for mg1/mg3/dopa/ctf -- and
for each one asserts, with a player spawned and 60 frames run:

  - the level title the status bar draws is loc-resolved, not a raw "$key"
  - the level is populated (edicts above a floor; monsters and/or pickups)
  - the frame is not blank and its top band differs from its bottom band
  - no console class beyond test/support/sweep_baseline.json's known residue
  - a map whose file is BSP2/2PSB really loaded through the wide reader

Every write lands under `-homedir <scratch>/r/<tag>`; nothing is written into
the retail directories.
*/

import {
  arg,
  bootTree,
  bspVersionOfLoadedMap,
  bspVersionsOf,
  check,
  cl,
  cmd,
  conMark,
  conSince,
  consoleClassCounts,
  disconnectCatching,
  entityCensus,
  finish,
  frameEvidence,
  frames,
  homedirFor,
  isGL,
  isTree,
  loadMapCatching,
  loadMapdb,
  loadSweepBaseline,
  mapsForTree,
  populationVerdict,
  shot,
  treeConfig,
  unexplainedConsoleClasses,
  viewRegion,
} from "./r_lib";
import { CL_LocalizeKey } from "../../src/client/kfont_text";

const treeArg = arg("tree", "id1");
if (!isTree(treeArg)) {
  console.log(`[FAIL] tree-argument :: unknown tree "${treeArg}"`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const tree = treeArg;
const vid = arg("vid", "soft");
const settle = Number(arg("frames", "60"));
const tag = `trees_${tree}_${vid}`;

const cfg = treeConfig(tree);
const diskVersions = bspVersionsOf(cfg);
const home = homedirFor(tag);

bootTree({ cfg, vid, homedir: home });
frames(20);

check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}, qgl ${isGL() ? "present" : "absent"}`);

const mapdb = loadMapdb();
if (mapdb === null) {
  check(`${tag}/mapdb`, false, "mapdb.json did not load from the mounted re-release root");
  finish(tag);
}
check(`${tag}/mapdb`, mapdb.maps.length > 0, `${mapdb.episodes.length} episodes, ${mapdb.maps.length} maps`);

const wanted = mapsForTree(mapdb, tree);
check(`${tag}/map-selection`, wanted.length > 0, wanted.map((m) => m.bsp).join(" "));

const baseline = loadSweepBaseline();
let bsp2Seen = 0;
let bsp2Loaded = 0;

for (const entry of wanted) {
  const map = entry.bsp;
  const label = `${tag}/${map}`;
  const recordKey = `${cfg.label}/${map}`;
  const diskVersion = diskVersions.get(map) ?? "unlisted";

  // mapdb's own `horde` flag: those maps are horde mode's, and the re-release
  // QuakeC gates their spawn logic on the `horde` cvar (src/progs/ext/ruleset.ts
  // registers it). Set it from the catalog rather than from a name list.
  cmd(`horde ${entry.horde ? 1 : 0}`, 2);

  const mark = conMark();
  const load = loadMapCatching(map, settle);
  if (!load.ok) {
    check(
      label,
      false,
      load.error !== null
        ? `load threw: ${load.error} (disk bsp ${diskVersion})`
        : `never reached in-game (disk bsp ${diskVersion}); console: ${conSince(mark).filter((l) => l.length > 0).slice(-6).join(" | ")}`,
    );
    // Since F15 a Sys_Error throws without tearing the host down, so a map
    // whose load threw is reported and the sweep carries on to the next one
    // after the disconnect below resets the server.
    disconnectCatching();
    continue;
  }

  // --- level title -------------------------------------------------------
  const raw = cl.levelname;
  const drawn = CL_LocalizeKey(raw);
  check(
    `${label}/title`,
    drawn.length > 0 && !drawn.startsWith("$"),
    `raw="${raw}" drawn="${drawn}"`,
  );

  // --- population --------------------------------------------------------
  const census = entityCensus();
  const verdict = populationVerdict(census);
  check(
    `${label}/entities`,
    verdict.ok,
    `${verdict.kind} edicts=${census.edicts} monsters=${census.monsters} pickups=${census.pickups}` +
      ` changelevels=${census.changelevels} players=${census.players}`,
  );

  // --- pixels ------------------------------------------------------------
  const ev = frameEvidence(viewRegion());
  check(`${label}/frame`, !ev.blank && ev.topBottomDiffer, ev.note);

  // --- BSP2 --------------------------------------------------------------
  const loadedVersion = bspVersionOfLoadedMap(map);
  if (diskVersion === "BSP2" || diskVersion === "2PSB") {
    bsp2Seen++;
    const ok = loadedVersion === diskVersion && census.edicts >= 8;
    if (ok) bsp2Loaded++;
    check(`${label}/bsp2`, ok, `disk=${diskVersion} resolved=${loadedVersion} edicts=${census.edicts}`);
  }

  // --- console -----------------------------------------------------------
  const lines = conSince(mark);
  const unexplained = unexplainedConsoleClasses(lines, baseline, recordKey);
  check(
    `${label}/console`,
    unexplained.length === 0,
    unexplained.length === 0 ? `${consoleClassCounts(lines)} (bsp ${diskVersion})` : unexplained.join(" ; "),
  );

  shot(`${tag}_${map.replace(/\//g, "_")}`);
  disconnectCatching();
}

check(
  `${tag}/bsp2-coverage`,
  bsp2Seen === 0 || bsp2Loaded === bsp2Seen,
  bsp2Seen === 0 ? "no BSP2/2PSB map in this tree's selection" : `${bsp2Loaded}/${bsp2Seen} wide-format maps loaded as their on-disk width`,
);

finish(tag);
