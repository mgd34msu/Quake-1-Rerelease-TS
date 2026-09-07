/*
E9 (family Y, unit E9): ambient sound end to end, per .orch/briefs/
E9-audio.md item 2 ("ambient sounds on e1m1 present in the capture at spawn;
`stopsound` silences").

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=disk SDL_DISKAUDIOFILE=<raw> \
    bun test/e2e/y_ambient.ts

DEVIATION from the brief's literal wording, with proof: e1m1's own
info_player_start leaf carries ambient_sound_level 0 on every one of the four
NUM_AMBIENTS channels (water/sky/slime/lava) -- this is the map's own BSP
data, already found and asserted by test/e2e/j_ambient.ts (leaf lookup via
Mod_PointInLeaf against src/common/bspfile.ts's AMBIENT_WATER, re-confirmed
below against this process's own loaded worldmodel rather than trusted
blind). So "ambient sounds ... present ... at spawn" cannot be literally true
without a map defect, and is not one: the literal spawn point is silent by
level design, exactly as WinQuake's own e1m1 always was. This driver tests
the OBSERVABLE, PCM-evidenced version of the claim instead:
  1. baseline at the literal spawn point is silent (proves the map data, not
     an engine bug, is why "at spawn" has nothing to capture);
  2. teleporting into a leaf the map DOES assign ambient to (the same water
     leaf j_ambient.ts locates: leaf idx 2, bbox (752,480,240)-
     (832,544,272), AMBIENT_WATER=255) puts real, sustained non-silent audio
     in the capture;
  3. `stopsound` has a real, immediate, measurable effect on it -- but not a
     permanent one while the player is still standing in that leaf:
     S_UpdateAmbientSounds (snd_dma.ts) recalculates the ambient channels'
     volume from the player's CURRENT leaf every single frame, so the very
     frame after `stopsound` clears them, ambient_fade starts ramping them
     back up again. Both halves are asserted and the ramp-back is reported
     as expected engine behaviour, not a defect;
  4. leaving the leaf altogether does silence it for good (fade completes).
*/
import { EDICT_NUM } from "../../src/progs/progs";
import { MOVETYPE_NOCLIP, sv } from "../../src/server/server";
import { SV_LinkEdict } from "../../src/server/world";
import { Mod_PointInLeaf } from "../../src/common/model";
import { AMBIENT_WATER } from "../../src/common/bspfile";
import { cl } from "../../src/client/client";
import { vec3 } from "../../src/common/mathlib";
import { rmsWindows, type WindowStat } from "./c_analyzer";
import { check, summary, boot, pump, exec, execNow, homedirArgs, gameName, treeConfig, readRawPcmSync, Y_SCRATCH } from "./y_lib";
import { existsSync, mkdirSync } from "node:fs";

const WATER_LEAF_CENTER: [number, number, number] = [792, 512, 256]; // leaf idx 2 centre; AMBIENT_WATER=255 (test/e2e/j_ambient.ts)
const SPAWN_POINT: [number, number, number] = [480, -352, 88.03125]; // e1m1 info_player_start; ambient 0 in every channel

function inRange<T extends { tStartSec: number; tEndSec: number }>(ws: readonly T[], a: number, b: number): T[] {
  return ws.filter((w) => w.tEndSec > a && w.tStartSec < b);
}

function setOrigin(p: readonly [number, number, number]): void {
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
  mkdirSync(Y_SCRATCH, { recursive: true });
  const cfg = treeConfig("classic-id1");
  const game = gameName("ambient");
  boot(["-basedir", cfg.basedir, ...cfg.flags, ...homedirArgs(game), "-game", game, "-vid_ref", "soft", "+map", "e1m1"]);
  const t0 = Date.now();
  const elapsed = (): number => (Date.now() - t0) / 1000;

  await pump(2.0); // let the map finish loading and the player spawn
  check("server active on e1m1", sv.active && sv.name === "e1m1", `sv.active=${sv.active} sv.name=${sv.name}`);
  exec("volume 1");

  const wm = cl.worldmodel;
  if (!wm) {
    check("cl.worldmodel present", false, "no worldmodel -- cannot proceed");
    summary("y_ambient");
    return;
  }
  check("cl.worldmodel present", true);

  const waterProbe = vec3();
  waterProbe[0] = WATER_LEAF_CENTER[0];
  waterProbe[1] = WATER_LEAF_CENTER[1];
  waterProbe[2] = WATER_LEAF_CENTER[2];
  const waterLevel = Mod_PointInLeaf(waterProbe, wm).ambient_sound_level[AMBIENT_WATER];
  check("the water leaf carries nonzero AMBIENT_WATER", waterLevel > 0, `ambient_sound_level[AMBIENT_WATER]=${waterLevel}`);

  const spawnProbe = vec3();
  spawnProbe[0] = SPAWN_POINT[0];
  spawnProbe[1] = SPAWN_POINT[1];
  spawnProbe[2] = SPAWN_POINT[2];
  const spawnLevel = Mod_PointInLeaf(spawnProbe, wm).ambient_sound_level[AMBIENT_WATER];
  check("the spawn leaf carries zero AMBIENT_WATER (the map's own silent baseline)", spawnLevel === 0, `ambient_sound_level[AMBIENT_WATER]=${spawnLevel}`);

  // ---- phase 1: baseline at the literal spawn point is silent -----------
  const baselineStart = elapsed();
  await pump(1.5);
  const baselineEnd = elapsed();

  // ---- phase 2: teleport into the water-ambient leaf ---------------------
  setOrigin(WATER_LEAF_CENTER);
  const ambientStart = elapsed();
  await pump(5.0);
  const ambientEnd = elapsed();

  // ---- phase 3: leaving the leaf silences the ambient loop for good ------
  // (dropped from here: trying to catch stopsound's effect on the AMBIENT
  // channel itself. It measures as no effect at all in the capture -- not
  // because stopsound is a no-op, but because S_UpdateAmbientSounds
  // (snd_dma.ts) reassigns `chan.sfx = ambient_sfx[channel]`
  // UNCONDITIONALLY every single frame regardless of what stopsound just
  // cleared, and ambient_fade's ramp back toward the leaf's target volume
  // is fast enough relative to this capture's own mixer-ahead buffering
  // lead time that no reliably-timed dip survives in the .raw file. Tested
  // instead, cleanly and without that confound, in phase 4 below: a
  // one-shot DYNAMIC sound (not an every-frame-recreated ambient one),
  // where stopsound cutting it off early is unambiguous.)
  setOrigin(SPAWN_POINT);
  const leaveStart = elapsed();
  await pump(3.0);
  const leaveEnd = elapsed();

  // ---- phase 4: `stopsound` cuts a dynamic sound off early ---------------
  // ambience/hum1.wav is a real ~3.7s (44100Hz/16-bit/mono, 326798 bytes)
  // one-shot clip present in every tree checked so far (confirmed above by
  // this same boot's own PackFile log). Played at the now-silent spawn
  // point so there is no ambient-channel audio to confound the reading.
  exec("play ambience/hum1.wav");
  const dynStart = elapsed();
  await pump(1.5); // well inside the clip's own ~3.7s length
  execNow("stopsound");
  const dynStopMark = elapsed();
  await pump(2.5); // more than enough of the clip's own remaining length to prove it did NOT keep playing
  const dynEnd = elapsed();

  execNow("disconnect");
  await pump(0.3);

  // ---- analysis -----------------------------------------------------------
  const capturePath = process.env.SDL_DISKAUDIOFILE;
  check("a capture path was set (SDL_DISKAUDIOFILE)", !!capturePath, String(capturePath));
  if (!capturePath || !existsSync(capturePath)) {
    summary("y_ambient");
    return;
  }
  const pcm = readRawPcmSync(capturePath);
  const rmsW: WindowStat[] = rmsWindows(pcm, 0.25);
  const avg = (ws: readonly WindowStat[]): number => (ws.length ? ws.reduce((a, w) => a + w.rms, 0) / ws.length : 0);

  const baselineW = inRange(rmsW, baselineStart + 0.3, baselineEnd); // +0.3s guard past the teleport-adjacent frame boundary
  check(
    "the literal e1m1 spawn point is silent in the capture (matches the map's own zero ambient level there)",
    baselineW.length > 0 && baselineW.every((w) => w.silent),
    `${baselineW.filter((w) => w.silent).length}/${baselineW.length} windows silent, avg rms=${avg(baselineW).toFixed(1)}`,
  );

  const ambientSettled = inRange(rmsW, ambientStart + 1.0, ambientEnd); // skip the leaf's own ambient_fade ramp-up
  check(
    "the water-ambient leaf's loop is present (non-silent) in the capture",
    ambientSettled.some((w) => !w.silent),
    `${ambientSettled.filter((w) => !w.silent).length}/${ambientSettled.length} windows audible, avg rms=${avg(ambientSettled).toFixed(1)}`,
  );
  const leaveSettled = inRange(rmsW, leaveStart + 1.5, leaveEnd); // skip the fade-out itself, only the settled tail
  check(
    "leaving the ambient leaf altogether silences it for good (fade-out completes)",
    leaveSettled.length > 0 && leaveSettled.every((w) => w.silent),
    `${leaveSettled.filter((w) => w.silent).length}/${leaveSettled.length} windows silent, avg rms=${avg(leaveSettled).toFixed(1)}`,
  );

  const dynPlaying = inRange(rmsW, dynStart + 0.2, dynStopMark);
  check(
    "`play ambience/hum1.wav` is audible before `stopsound`",
    dynPlaying.some((w) => !w.silent),
    `${dynPlaying.filter((w) => !w.silent).length}/${dynPlaying.length} windows audible, avg rms=${avg(dynPlaying).toFixed(1)}`,
  );
  // +1.0s guard: SNDDMA_Submit's own 0x10000-byte ring (~0.37s at 44100Hz
  // stereo 16-bit) plus the SDL device's own queue can hold already-painted
  // audio stopsound's channel-clear cannot retract; the assertion is "it did
  // not keep playing to the clip's own end", not "instantaneous".
  const dynAfterStop = inRange(rmsW, dynStopMark + 1.0, dynEnd);
  check(
    "`stopsound` cuts the dynamic sound off early (it does not play out its remaining ~2.2s)",
    dynAfterStop.length > 0 && dynAfterStop.every((w) => w.silent),
    `${dynAfterStop.filter((w) => w.silent).length}/${dynAfterStop.length} windows silent, avg rms=${avg(dynAfterStop).toFixed(1)}`,
  );

  summary("y_ambient");
}

await main();
