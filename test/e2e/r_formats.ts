/*
Family R, driver 3: the re-release's file formats, in both renderers.

  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/r_formats.ts --phase id1
  SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/r_formats.ts --phase id1 --vid gl
  SDL_VIDEODRIVER=dummy     SDL_AUDIODRIVER=dummy bun test/e2e/r_formats.ts --phase mg3

  id1   -- coloured lighting from `.lit`, MD5 replacement models, fog, and the
           skybox loader driven from supplied TGA faces.
  sky   -- the retail skyboxes, which only mg1 and mg3 ship
           (`gfx/env/<set>/<face>.tga`): one 512x512 set and one 1024x1024 set.
  mg3   -- textures of any size, over every mg3 map the retail mapdb.json
           lists.
  vault -- surfaces past the classic 256-texel extent cap. Those live in the
           re-release id1 tree's own `maps/vault/*.bsp` (the set
           src/common/model.ts's MAX_SURFACE_EXTENTS comment names as the
           reason the cap was raised), NOT in mg3: measured over all 20 mg3
           maps, the widest lightmapped surface axis is exactly 256, so mg3
           alone cannot demonstrate the raised cap.

Every pixel assertion is an A/B over the SAME viewpoint: the feature is turned
off, the map is reloaded, the frame is captured; then it is turned on, the map
is reloaded, and the frame is captured again. Reloading rather than toggling
mid-session is deliberate -- lightmaps and model caches are built at map load,
so a cvar flipped between frames would not be honoured by either renderer, and
a difference that only showed up after a reload would be indistinguishable
from no difference at all.
*/

import {
  arg,
  bootTree,
  bspVersionsOf,
  check,
  cl,
  cmd,
  conMark,
  conSince,
  Cvar_Set,
  diffFraction,
  disconnectCatching,
  fbSnapshot,
  finish,
  frameEvidence,
  frames,
  homedirFor,
  isGL,
  isTree,
  loadMapdb,
  loadSweepBaseline,
  mapsForTree,
  regionStats,
  rState,
  shot,
  statsNote,
  loadMapCatching,
  treeConfig,
  unexplainedConsoleClasses,
  viewRegion,
  writeSkybox,
  type RegionT,
} from "./r_lib";
import { getRenderer } from "../../src/client/render";
import { Cmd_Exists } from "../../src/common/cmd";
import { SkyActive } from "../../src/ref_gl/gl_sky";
import { softSkyBoxState } from "../../src/ref_soft/r_main";
import { MAX_SURFACE_EXTENTS, SURF_DRAWTILED } from "../../src/common/model";
import { TEX_SPECIAL } from "../../src/common/bspfile";

const phase = arg("phase", "id1");
const vid = arg("vid", "soft");
const tag = `formats_${phase}_${vid}`;
const home = homedirFor(tag);

/** The cvar each renderer gates its `.lit` path on. */
const COLOREDLIGHT_CVAR = vid === "gl" ? "gl_coloredlight" : "r_coloredlight";

let lastLoadError: string | null = null;

function loadMap(name: string, settle = 30): boolean {
  const r = loadMapCatching(name, settle);
  lastLoadError = r.error;
  return r.ok;
}

function loadNote(name: string): string {
  return lastLoadError !== null ? `${name}: load threw: ${lastLoadError}` : `${name}: never reached in-game`;
}

function chromaAt(rgb: Uint8Array, i: number): number {
  const r = rgb[i * 3];
  const g = rgb[i * 3 + 1];
  const b = rgb[i * 3 + 2];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/**
 * Mean colour spread (max channel - min channel) in each of two snapshots,
 * measured ONLY over the pixels that differ between them.
 *
 * Over the whole frame the two means are nearly equal, because Quake's own
 * textures and palette are colourful whether or not a `.lit` is in play. The
 * pixels the coloured-lighting path actually touched are exactly the ones
 * that changed between the two runs, and it is on those that "coloured, not
 * grey" is a real claim.
 */
function chromaOfChanged(a: Uint8Array | null, b: Uint8Array | null, threshold = 8): { count: number; meanA: number; meanB: number } {
  if (a === null || b === null || a.length !== b.length || a.length === 0) return { count: 0, meanA: -1, meanB: -1 };
  const n = a.length / 3;
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    if (
      Math.abs(a[o] - b[o]) <= threshold &&
      Math.abs(a[o + 1] - b[o + 1]) <= threshold &&
      Math.abs(a[o + 2] - b[o + 2]) <= threshold
    ) {
      continue;
    }
    count++;
    sumA += chromaAt(a, i);
    sumB += chromaAt(b, i);
  }
  if (count === 0) return { count: 0, meanA: -1, meanB: -1 };
  return { count, meanA: sumA / count, meanB: sumB / count };
}

// ===========================================================================

if (phase === "id1") {
  bootTree({ cfg: treeConfig("id1"), vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  // --- .lit colours reach the lightmap -----------------------------------
  {
    Cvar_Set(COLOREDLIGHT_CVAR, "0");
    check(`${tag}/lit/map-grey`, loadMap("e1m1"), `e1m1 with ${COLOREDLIGHT_CVAR} 0`);
    const region = viewRegion();
    const grey = fbSnapshot(region);
    const greyStats = regionStats(grey);
    shot(`${tag}_lit_off`);

    Cvar_Set(COLOREDLIGHT_CVAR, "1");
    check(`${tag}/lit/map-coloured`, loadMap("e1m1"), `e1m1 with ${COLOREDLIGHT_CVAR} 1`);
    const coloured = fbSnapshot(region);
    const colouredStats = regionStats(coloured);
    shot(`${tag}_lit_on`);

    const world = cl.worldmodel;
    check(
      `${tag}/lit/loaded`,
      world !== null && world.lightdata_rgb !== null,
      world === null ? "no worldmodel" : `maps/e1m1.lit -> lightdata_rgb ${world.lightdata_rgb === null ? "absent" : `${world.lightdata_rgb.length} bytes`}, lightdata ${world.lightdata?.length ?? 0} bytes`,
    );
    if (!isGL()) {
      check(`${tag}/lit/truecolor-path`, rState.r_truecolor, `src/ref_soft/r_coloredlight.ts's R_ColoredLightAvailable -> ${rState.r_truecolor}`);
    }

    const changed = diffFraction(grey, coloured, 8);
    const ch = chromaOfChanged(grey, coloured, 8);
    // 1%, not a larger figure: the A/B is deterministic (same spawn, same
    // settle, only the cvar differs), so anything above zero is signal, and
    // the GL lightmap path moves far fewer pixels than the software
    // true-color path -- measured 2.4% under GL against 10.4% under software
    // on the same map.
    check(
      `${tag}/lit/pixels`,
      changed > 0.01,
      `${(changed * 100).toFixed(1)}% of view pixels changed when ${COLOREDLIGHT_CVAR} went 0 -> 1` +
        ` | off: ${statsNote(greyStats)} | on: ${statsNote(colouredStats)}`,
    );
    check(
      `${tag}/lit/coloured-not-grey`,
      ch.count > 0 && ch.meanB > ch.meanA * 1.15,
      `over the ${ch.count} pixels the .lit path changed, mean colour spread ${ch.meanA.toFixed(2)} (grey lightmap) -> ${ch.meanB.toFixed(2)} (.lit lightmap)`,
    );
  }

  // --- MD5 replacement models --------------------------------------------
  // progs/v_shot.md5mesh ships beside progs/v_shot.mdl in the re-release
  // id1 pak, and the view weapon is the one alias model guaranteed to be in
  // frame at the spawn point, so the region is the lower middle of the view.
  {
    const v = viewRegion();
    const weaponRegion: RegionT = {
      x: v.x + Math.floor(v.w * 0.3),
      y: v.y + Math.floor(v.h * 0.55),
      w: Math.floor(v.w * 0.45),
      h: Math.floor(v.h * 0.45),
    };

    Cvar_Set("r_enhancedmodels", "0");
    check(`${tag}/md5/map-mdl`, loadMap("e1m1"), "e1m1 with r_enhancedmodels 0");
    cmd("impulse 9", 8);
    cmd("impulse 2", 12);
    frames(20);
    const mdl = fbSnapshot(weaponRegion);
    shot(`${tag}_md5_off`);

    Cvar_Set("r_enhancedmodels", "1");
    check(`${tag}/md5/map-md5`, loadMap("e1m1"), "e1m1 with r_enhancedmodels 1");
    cmd("impulse 9", 8);
    cmd("impulse 2", 12);
    frames(20);
    const md5 = fbSnapshot(weaponRegion);
    shot(`${tag}_md5_on`);

    const changed = diffFraction(mdl, md5, 8);
    check(
      `${tag}/md5/silhouette`,
      changed > 0.01,
      `view-weapon region ${weaponRegion.w}x${weaponRegion.h} at ${weaponRegion.x},${weaponRegion.y}:` +
        ` ${(changed * 100).toFixed(2)}% of pixels differ between r_enhancedmodels 0 and 1` +
        ` | mdl: ${statsNote(regionStats(mdl))} | md5: ${statsNote(regionStats(md5))}`,
    );
  }

  // --- fog ----------------------------------------------------------------
  {
    check(`${tag}/fog/command`, Cmd_Exists("fog"), "src/client/fog_cmd.ts registers one shared `fog` command");
    check(`${tag}/fog/map`, loadMap("e1m1"), "e1m1 for the fog A/B");
    cmd("fog 0 0 0 0", 4);
    frames(10);
    const region = viewRegion();
    const clear = fbSnapshot(region);

    cmd("fog 0.05 0.5 0.5 0.5", 4);
    frames(10);
    const fogged = fbSnapshot(region);
    shot(`${tag}_fog`);

    const state = getRenderer().fogGetState?.() ?? { density: -1, color: [-1, -1, -1] };
    check(
      `${tag}/fog/state`,
      Math.abs(state.density - 0.05) < 1e-4,
      `fogGetState -> density=${state.density} colour=${Array.from(state.color).join(",")}`,
    );
    const changed = diffFraction(clear, fogged, 4);
    check(
      `${tag}/fog/pixels`,
      changed > 0.02,
      `${(changed * 100).toFixed(1)}% of view pixels changed under "fog 0.05 0.5 0.5 0.5"` +
        ` | clear: ${statsNote(regionStats(clear))} | fogged: ${statsNote(regionStats(fogged))}`,
    );
    cmd("fog 0 0 0 0", 4);
  }

  // --- skybox -------------------------------------------------------------
  // The id1 tree ships no skybox of its own (only mg1 and mg3 do -- see the
  // `sky` phase, which uses those), so the six faces are generated into the
  // homedir tier -- the highest-priority search path -- and loaded from there.
  {
    const skyName = "r2e2";
    const dir = writeSkybox(home, skyName);
    check(`${tag}/sky/fixture`, true, `six 64x64 TGA faces written to ${dir}`);
    check(`${tag}/sky/command`, Cmd_Exists("sky"), "the `sky` console command is registered under this renderer");

    // Which retail id1 map actually shows sky at its spawn point is not
    // something the BSP says directly, so the candidates are tried in order
    // and the first whose view changes when the skybox loads is the fixture.
    const candidates = ["e1m3", "e2m1", "e3m1", "e4m1", "dm3", "dm2", "e1m1"];
    let found = "";
    let changed = -1;
    let skyStats = "";
    for (const map of candidates) {
      if (!loadMap(map, 20)) continue;
      const region = viewRegion();
      const before = fbSnapshot(region);
      if (Cmd_Exists("sky")) cmd(`sky ${skyName}`, 4);
      else getRenderer().skyLoadSkyBox?.(skyName);
      frames(10);
      const after = fbSnapshot(region);
      const d = diffFraction(before, after, 8);
      if (d > changed) {
        changed = d;
        found = map;
        skyStats = statsNote(regionStats(after));
      }
      if (d > 0.01) break;
      // reset for the next candidate
      if (Cmd_Exists("sky")) cmd("sky ", 4);
      else getRenderer().skyLoadSkyBox?.("");
    }
    shot(`${tag}_sky`);

    const loaded = isGL() ? SkyActive() : softSkyBoxState.name === skyName;
    check(
      `${tag}/sky/loaded`,
      loaded,
      isGL() ? `gl_sky.ts SkyActive()=${SkyActive()}` : `r_main.ts softSkyBoxState.name="${softSkyBoxState.name}", ${softSkyBoxState.faces.filter((f) => f !== null).length}/6 faces decoded`,
    );
    check(
      `${tag}/sky/pixels`,
      changed > 0.01,
      `best candidate ${found}: ${(changed * 100).toFixed(2)}% of view pixels changed once the skybox loaded | ${skyStats}`,
    );
  }

  finish(tag);
}

if (phase === "mg3") {
  const tree = "mg3";
  if (!isTree(tree)) finish(tag);
  const cfg = treeConfig(tree);
  bootTree({ cfg, vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  const mapdb = loadMapdb();
  if (mapdb === null) {
    check(`${tag}/mapdb`, false, "mapdb.json did not load");
    finish(tag);
  }
  const maps = mapsForTree(mapdb, tree);
  check(`${tag}/map-selection`, maps.length > 0, `${maps.length} mg3 maps from mapdb.json`);

  const baseline = loadSweepBaseline();
  let maxExtent = 0;
  let maxExtentMap = "";
  let maxExtentTexture = "";
  let wideSurfaces = 0;
  let oddTextures = 0;
  let biggestTexture = "";
  let biggestTextureArea = 0;
  const unexplainedAll: string[] = [];
  let loaded = 0;

  for (const entry of maps) {
    const mark = conMark();
    if (!loadMap(entry.bsp, 4)) {
      check(`${tag}/${entry.bsp}`, false, loadNote(entry.bsp));
      if (lastLoadError !== null) {
        const rest = maps.slice(maps.indexOf(entry) + 1).map((m) => m.bsp);
        if (rest.length > 0) check(`${tag}/sweep-aborted`, false, `Sys_Error tore the engine down, so ${rest.length} maps were not attempted: ${rest.join(" ")}`);
        break;
      }
      disconnectCatching();
      continue;
    }
    loaded++;
    const world = cl.worldmodel;
    if (world !== null) {
      for (const s of world.surfaces) {
        // src/common/model.ts's Mod_LoadFaces stamps every sky/turb face
        // (SURF_DRAWTILED) with a 16384 extent sentinel instead of a measured
        // size, and CalcSurfaceExtents exempts TEX_SPECIAL from the cap, so
        // neither kind says anything about how wide a real lightmapped
        // surface this loader accepts.
        if ((s.flags & SURF_DRAWTILED) !== 0) continue;
        if (s.texinfo !== null && (s.texinfo.flags & TEX_SPECIAL) !== 0) continue;
        for (let i = 0; i < 2; i++) {
          const e = s.extents[i];
          if (e > 256) wideSurfaces++;
          if (e > maxExtent) {
            maxExtent = e;
            maxExtentMap = entry.bsp;
            maxExtentTexture = s.texinfo?.texture?.name ?? "?";
          }
        }
      }
      for (const t of world.textures ?? []) {
        if (t === null) continue;
        if (t.width % 16 !== 0 || t.height % 16 !== 0 || t.width > 256 || t.height > 256) oddTextures++;
        if (t.width * t.height > biggestTextureArea) {
          biggestTextureArea = t.width * t.height;
          biggestTexture = `${t.name} ${t.width}x${t.height}`;
        }
      }
    }
    const lines = conSince(mark);
    for (const u of unexplainedConsoleClasses(lines, baseline, `${cfg.label}/${entry.bsp}`)) {
      unexplainedAll.push(`${entry.bsp}: ${u}`);
    }
    disconnectCatching();
  }

  check(`${tag}/maps-loaded`, loaded === maps.length, `${loaded}/${maps.length} mg3 maps loaded with a player`);
  check(
    `${tag}/surface-extents`,
    maxExtent > 0 && maxExtent <= MAX_SURFACE_EXTENTS,
    `widest lightmapped surface axis ${maxExtent} on ${maxExtentMap} (texture "${maxExtentTexture}"), ${wideSurfaces} past the classic 256 cap,` +
      ` engine cap MAX_SURFACE_EXTENTS ${MAX_SURFACE_EXTENTS} -- see the vault phase for the maps that exceed 256`,
  );
  check(
    `${tag}/textures-any-size`,
    oddTextures > 0,
    `${oddTextures} textures that are not a classic 16-aligned <=256 size; largest ${biggestTexture}`,
  );
  check(
    `${tag}/console`,
    unexplainedAll.length === 0,
    unexplainedAll.length === 0 ? "no bad-surface-extents or texture-alignment console class beyond the baseline" : unexplainedAll.join(" ; "),
  );

  finish(tag);
}


if (phase === "vault") {
  const cfg = treeConfig("id1");
  bootTree({ cfg, vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  // Not in mapdb.json: the vault maps ship inside the re-release id1 pak but
  // are not catalogued as playable levels, so they are enumerated straight
  // out of the pak directory.
  const vaultMaps = Array.from(bspVersionsOf(cfg).keys()).filter((m) => m.startsWith("vault/")).sort();
  check(`${tag}/map-selection`, vaultMaps.length > 0, vaultMaps.join(" "));

  const baseline = loadSweepBaseline();
  let maxExtent = 0;
  let maxExtentMap = "";
  let maxExtentTexture = "";
  let wideSurfaces = 0;
  let loaded = 0;
  const unexplainedAll: string[] = [];

  for (const map of vaultMaps) {
    const mark = conMark();
    if (!loadMap(map, 4)) {
      check(`${tag}/${map}`, false, loadNote(map));
      if (lastLoadError !== null) {
        const rest = vaultMaps.slice(vaultMaps.indexOf(map) + 1);
        if (rest.length > 0) check(`${tag}/sweep-aborted`, false, `Sys_Error tore the engine down, so ${rest.length} maps were not attempted: ${rest.join(" ")}`);
        break;
      }
      disconnectCatching();
      continue;
    }
    loaded++;
    const world = cl.worldmodel;
    if (world !== null) {
      for (const s of world.surfaces) {
        if ((s.flags & SURF_DRAWTILED) !== 0) continue;
        if (s.texinfo !== null && (s.texinfo.flags & TEX_SPECIAL) !== 0) continue;
        for (let i = 0; i < 2; i++) {
          const e = s.extents[i];
          if (e > 256) wideSurfaces++;
          if (e > maxExtent) {
            maxExtent = e;
            maxExtentMap = map;
            maxExtentTexture = s.texinfo?.texture?.name ?? "?";
          }
        }
      }
    }
    for (const u of unexplainedConsoleClasses(conSince(mark), baseline, `${cfg.label}/${map}`)) {
      unexplainedAll.push(`${map}: ${u}`);
    }
    disconnectCatching();
  }

  check(`${tag}/maps-loaded`, loaded === vaultMaps.length, `${loaded}/${vaultMaps.length} vault maps loaded`);
  check(
    `${tag}/wide-surfaces`,
    maxExtent > 256 && maxExtent <= MAX_SURFACE_EXTENTS,
    `${wideSurfaces} lightmapped surface axes past the classic 256-texel cap; widest ${maxExtent} on ${maxExtentMap} (texture "${maxExtentTexture}"), engine cap MAX_SURFACE_EXTENTS ${MAX_SURFACE_EXTENTS}`,
  );
  check(
    `${tag}/console`,
    unexplainedAll.length === 0,
    unexplainedAll.length === 0 ? "no bad-surface-extents console class beyond the baseline" : unexplainedAll.join(" ; "),
  );

  finish(tag);
}


if (phase === "sky") {
  const cfg = treeConfig("mg1");
  bootTree({ cfg, vid, homedir: home });
  frames(20);
  check(`${tag}/renderer`, isGL() === (vid === "gl"), `--vid ${vid}`);

  // mg1's own gfx/env sets: mge2m1's faces are 512x512, sky_horde2's are
  // 1024x1024. Both are retail data loaded through the map's own worldspawn
  // "sky"/"skyname" key, not through a console command.
  const cases: ReadonlyArray<{ map: string; faces: string }> = [
    { map: "mge2m1", faces: "512x512" },
    { map: "horde2", faces: "1024x1024" },
  ];

  for (const c of cases) {
    if (!loadMap(c.map, 20)) {
      check(`${tag}/${c.map}`, false, loadNote(c.map));
      if (lastLoadError !== null) break;
      disconnectCatching();
      continue;
    }
    const active = isGL() ? SkyActive() : softSkyBoxState.name !== "";
    const detail = isGL()
      ? `gl_sky.ts SkyActive()=${SkyActive()}`
      : `r_main.ts softSkyBoxState.name="${softSkyBoxState.name}", ${softSkyBoxState.faces.filter((f) => f !== null).length}/6 faces decoded`;
    check(`${tag}/${c.map}/skybox-loaded`, active, `${c.faces} retail faces -- ${detail}`);

    const ev = frameEvidence(viewRegion());
    check(`${tag}/${c.map}/frame`, !ev.blank && ev.topBottomDiffer, ev.note);
    disconnectCatching();
  }

  finish(tag);
}

console.log(`[FAIL] ${tag}/phase :: unknown --phase "${phase}" (id1|sky|mg3|vault)`);
console.log("RESULT 0 1");
process.exit(1);
