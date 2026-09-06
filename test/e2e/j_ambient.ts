// J-track e2e agent: closes the two gaps from the C-track and B-track
// reports (.orch/e2e/C.md "Ambient/spatialization gap", .orch/e2e/B.md
// "B-G3 intermission/finale not reachable"). This file: ambient loops +
// direct spatialization. See j_intermission.ts for the second gap.
//
// Run under SDL_VIDEODRIVER=dummy, SDL_AUDIODRIVER=disk,
// SDL_DISKAUDIOFILE=<raw file>. Analyze the raw file afterwards with
// test/e2e/c_analyzer.ts (imported read-only here, never modified) or its
// CLI: `bun test/e2e/c_analyzer.ts <raw> 0.3`.
//
// Scenario:
//  1. Boot `+map e1m1`, let the player spawn (baseline: spawn leaf has
//     ambient_sound_level 0 for every channel, matching C.md's finding).
//  2. Locate a leaf with a nonzero AMBIENT_WATER level by scanning
//     cl.worldmodel.leafs (there are 41 such leafs in e1m1; leaf index 2,
//     bbox (752,480,240)-(832,544,272), contents CONTENTS_EMPTY, was picked
//     because it carries only the water ambient (no sky), keeping the
//     result unambiguous).
//  3. Teleport the player (EDICT_NUM(1).v.origin) to that leaf's bbox
//     centre, set MOVETYPE_NOCLIP directly (bypassing the "noclip" console
//     command's src_command forwarding indirection) and zero velocity, then
//     SV_LinkEdict(ed, false) per the brief (no touch-trigger pass needed
//     for a plain position update).
//  4. Run 5s of real-time-paced frames with `snd_show 1` active; the
//     ambient channel's contribution shows up both in snd_show's per-frame
//     active-channel count and in the disk-audio RMS trace.
//  5. Move the player back to the (silent) spawn leaf and run a few more
//     seconds to observe S_UpdateAmbientSounds' ambient_fade ramp-down.
//  6. Spatialization: call S_StartSound directly (bypassing QuakeC/svc_sound
//     entirely) twice, at 100 and 1500 units from the current
//     listener_origin with attenuation 1 -- 1500 > sound_nominal_clip_dist
//     (1000) so SND_Spatialize's `dist = distance * attenuation /
//     sound_nominal_clip_dist` exceeds 1 and clips volume to exactly 0; 100
//     units stays audible. Same sfx both times so only distance differs.
import { EDICT_NUM } from "../../src/progs/progs";
import { MOVETYPE_NOCLIP, sv } from "../../src/server/server";
import { SV_LinkEdict } from "../../src/server/world";
import { Mod_PointInLeaf } from "../../src/common/model";
import { AMBIENT_WATER } from "../../src/common/bspfile";
import { cl } from "../../src/client/client";
import { listener_origin } from "../../src/client/sound";
import { S_PrecacheSound, S_StartSound } from "../../src/client/snd_dma";
import { vec3 } from "../../src/common/mathlib";
import { boot, pump, exec, check, summary, maxSndShowCount, conLines, BASEDIR, GAMEDIR_NAME } from "./j_lib";

const WATER_LEAF_CENTER: [number, number, number] = [792, 512, 256]; // leaf idx 2 centre, confirmed AMBIENT_WATER=255, AMBIENT_SKY=0
const SPAWN_POINT: [number, number, number] = [480, -352, 88.03125]; // e1m1 info_player_start, confirmed ambient 0 in every channel

function setOrigin(p: [number, number, number]): void {
  const player = EDICT_NUM(1);
  player.v.origin[0] = p[0];
  player.v.origin[1] = p[1];
  player.v.origin[2] = p[2];
  player.v.velocity[0] = 0;
  player.v.velocity[1] = 0;
  player.v.velocity[2] = 0;
  player.v.movetype = MOVETYPE_NOCLIP;
  SV_LinkEdict(player, false);
}

async function main(): Promise<void> {
  boot(["-basedir", BASEDIR, "-game", GAMEDIR_NAME, "+map", "e1m1"]);

  const t0 = Date.now();
  const mark = (label: string): void => console.log(`[j_ambient t=${((Date.now() - t0) / 1000).toFixed(2)}s] ${label}`);

  await pump(2.0); // let the map finish loading and the player spawn

  check("server active on e1m1", sv.active && sv.name === "e1m1", `sv.active=${sv.active} sv.name=${sv.name}`);

  exec("snd_show 1");

  const wm = cl.worldmodel;
  if (!wm) {
    check("cl.worldmodel present", false, "no worldmodel -- cannot proceed");
    summary("j_ambient");
    process.exit(1);
  }
  check("cl.worldmodel present", true);

  // Sanity re-check of the hardcoded leaf pick against this process's own
  // loaded model (guards against relying on a value only verified in a
  // throwaway exploration script).
  const probe = vec3();
  probe[0] = WATER_LEAF_CENTER[0];
  probe[1] = WATER_LEAF_CENTER[1];
  probe[2] = WATER_LEAF_CENTER[2];
  const waterLeaf = Mod_PointInLeaf(probe, wm);
  const waterLevel = waterLeaf.ambient_sound_level[AMBIENT_WATER];
  check("target leaf carries nonzero AMBIENT_WATER", waterLevel > 0, `ambient_sound_level[AMBIENT_WATER]=${waterLevel}`);

  const spawnProbe = vec3();
  spawnProbe[0] = SPAWN_POINT[0];
  spawnProbe[1] = SPAWN_POINT[1];
  spawnProbe[2] = SPAWN_POINT[2];
  const spawnLeaf = Mod_PointInLeaf(spawnProbe, wm);
  const spawnLevel = spawnLeaf.ambient_sound_level[AMBIENT_WATER];
  check("spawn leaf carries zero AMBIENT_WATER (silent baseline)", spawnLevel === 0, `ambient_sound_level[AMBIENT_WATER]=${spawnLevel}`);

  mark("TELEPORT to water-ambient leaf (792,512,256), noclip on");
  setOrigin(WATER_LEAF_CENTER);
  const waterFrames = await pump(5.0);
  mark("end of water-ambient window");
  const waterWindowMax = maxSndShowCount(conLines().slice(-waterFrames));
  check("snd_show reports an active channel while in the water-ambient leaf", waterWindowMax >= 1, `max N seen = ${waterWindowMax}`);

  mark("MOVE back to spawn leaf (ambient 0), still noclip");
  setOrigin(SPAWN_POINT);
  const fadeFrames = await pump(3.0);
  mark("end of fade-out window");
  const fadeLines = conLines().slice(-fadeFrames);
  const fadeWindowMax = maxSndShowCount(fadeLines);
  const fadeEndsAtZero = fadeLines.length > 0 && fadeLines[fadeLines.length - 1].trim() === "----(0)----";
  check(
    "snd_show drops back to 0 active channels after leaving the ambient leaf (fade complete)",
    fadeEndsAtZero,
    `window max N=${fadeWindowMax} (nonzero while ramping down is expected), last line="${fadeLines[fadeLines.length - 1]?.trim()}"`,
  );

  // ---- spatialization: direct S_StartSound at two distances ----
  mark("PRECACHE weapons/rocket1i.wav for the spatialization probe");
  const sfx = S_PrecacheSound("weapons/rocket1i.wav");
  check("S_PrecacheSound returned a sfx handle", sfx !== null);

  const lx = listener_origin[0];
  const ly = listener_origin[1];
  const lz = listener_origin[2];
  mark(`listener_origin = (${lx.toFixed(1)},${ly.toFixed(1)},${lz.toFixed(1)})`);

  const nearOrigin = vec3();
  nearOrigin[0] = lx + 100;
  nearOrigin[1] = ly;
  nearOrigin[2] = lz;
  const farOrigin = vec3();
  farOrigin[0] = lx + 1500;
  farOrigin[1] = ly;
  farOrigin[2] = lz;

  mark("FIRE near S_StartSound, distance=100, atten=1");
  S_StartSound(9001, 1, sfx, nearOrigin, 1.0, 1.0);
  await pump(1.0);

  await pump(0.5); // silent gap between the two bursts for clean RMS windows

  mark("FIRE far S_StartSound, distance=1500 (> sound_nominal_clip_dist=1000), atten=1");
  S_StartSound(9002, 1, sfx, farOrigin, 1.0, 1.0);
  await pump(1.0);

  mark("done");
  summary("j_ambient");
  process.exit(0);
}

await main();
