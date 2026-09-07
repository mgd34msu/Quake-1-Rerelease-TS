/*
E9 (family Y, unit E9): the software mixer end to end, per .orch/briefs/
E9-audio.md item 1.

  bun test/e2e/y_mixer.ts --tree <classic-id1|id1|mg1>

This file plays two roles, chosen by `--child`:
  - parent (no --child): spawns itself twice as a child process, once at
    `-sndspeed 44100` and once at `-sndspeed 11025` (SNDDMA_Init reads the
    speed once at boot -- src/platform/snd.ts's `pickSpeed()` -- so the two
    speeds need two separate OS processes, each with its own
    SDL_AUDIODRIVER=disk capture file, the same "spawn a fresh harness per
    scenario" shape test/e2e/c_run.ts uses for family C). Aggregates the
    children's own RESULT lines.
  - child (--child --speed N): boots the requested tree/speed, runs the
    scenario, and asserts on the captured PCM. Every assertion name is
    prefixed "[<tree>/<speed>]" so the parent's combined log reads clearly.

Scenario (child): boot, load the tree's own short single-player map,
  1. fire a weapon (`impulse 2` -- the shotgun, the one weapon every tree
     spawns the player with already loaded, so this needs no `give`) ->
     capture is non-silent.
  2. `volume 0`, fire again -> capture stays silent.
  3. stereo panning: a fixed-position sound is started directly via
     S_StartSound (bypassing QuakeC entirely, the same technique
     test/e2e/j_ambient.ts already uses for its own distance-spatialization
     probe), at a world point 150 units to the player's current right. The
     player then turns ~160 degrees via the real `+right`/`-right` console
     commands (src/client/*'s CL_AdjustAngles path) and the same fixed point
     is played again: SND_Spatialize's left/right split (snd_dma.ts) should
     now report the opposite side, which this driver reads back from the
     capture's own left/right channel RMS (test/e2e/y_lib.ts's
     `leftRightWindows`, c_analyzer.ts's own WindowStat only carries a
     combined-channel RMS and cannot see this).
     NOTE: this is deliberately NOT the leaf-based NUM_AMBIENTS "ambient
     sound" (water/sky/slime/lava) family Y's own y_ambient.ts covers --
     snd_dma.ts's S_UpdateAmbientSounds sets `chan.leftvol = chan.rightvol =
     chan.master_vol` unconditionally (no panning at all, by original design:
     those channels represent an area's general ambiance, not a point
     source), so a leaf ambient could never show the panning this item asks
     for. "an ambient source" here is read as a positional sound source, and
     a direct S_StartSound call is used so the point is faithfully fixed in
     world space regardless of which tree/map is under test.
  4. resampling fidelity (id1/mg1 only -- classic-id1's own sound/*.wav are
     natively 11025 Hz, so there is nothing 44.1kHz to check there): loads
     the tree's own `sound/ambience/*hum*.wav` directly from the pak
     (COM_LoadTempFile, never through the mixer), parses its RIFF/WAVE header
     (test/e2e/y_lib.ts's own parser -- this port's src/ is never touched)
     and measures the SOURCE's own dominant frequency by zero-crossing, then
     plays that same file through S_StartSound and measures the CAPTURED
     dominant frequency the same way (c_analyzer.ts's
     `dominantFreqZeroCrossing`). A resampling bug (wrong ratio, aliasing)
     would show up as a gross frequency mismatch between the two.
  5. `soundinfo` reports the speed the tree was booted at.
*/
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sv } from "../../src/server/server";
import { listener_origin, listener_right, type SfxT } from "../../src/client/sound";
import { S_StartSound, S_PrecacheSound } from "../../src/client/snd_dma";
import { vec3 } from "../../src/common/mathlib";
import { COM_LoadTempFile } from "../../src/common/common";
import { rmsWindows, dominantFreqZeroCrossing, type WindowStat } from "./c_analyzer";
import {
  Y_SCRATCH,
  arg,
  flag,
  check,
  summary,
  parseResultLine,
  boot,
  pump,
  frames,
  exec,
  execNow,
  conTail,
  homedirArgs,
  gameName,
  treeConfig,
  DISK_RATE,
  readRawPcmSync,
  leftRightWindows,
  windowsInRange,
  parseWav,
  monoDominantFreq,
  turnPlayerDegrees,
  type LRWindow,
} from "./y_lib";

const SUPPORTED_TREES = ["classic-id1", "id1", "mg1"] as const;
type MixerTree = (typeof SUPPORTED_TREES)[number];

function isMixerTree(s: string): s is MixerTree {
  return (SUPPORTED_TREES as readonly string[]).includes(s);
}

function inRange<T extends { tStartSec: number; tEndSec: number }>(ws: readonly T[], a: number, b: number): T[] {
  return ws.filter((w) => w.tEndSec > a && w.tStartSec < b);
}

function precacheFirst(names: readonly string[]): { name: string; sfx: SfxT } | null {
  for (const name of names) {
    const sfx = S_PrecacheSound(name);
    if (sfx) return { name, sfx };
  }
  return null;
}

async function runChild(tree: MixerTree, speed: number): Promise<void> {
  const label = `${tree}/${speed}`;
  const cfg = treeConfig(tree);
  const game = gameName("mixer", tree, String(speed));

  boot(["-basedir", cfg.basedir, ...cfg.flags, ...homedirArgs(game), "-game", game, "-vid_ref", "soft", "-sndspeed", String(speed)]);
  execNow("disconnect"); // stop quake.rc's own startdemos before it makes any sound of its own
  const t0 = Date.now();
  const elapsed = (): number => (Date.now() - t0) / 1000;

  await pump(0.5);
  exec("volume 1");

  execNow(`map ${cfg.map}`);
  await pump(6.0);
  check(`[${label}] server active on ${cfg.map}`, sv.active && sv.name === cfg.map, `sv.active=${sv.active} sv.name=${sv.name}`);
  // A re-release map's own worldspawn CD track auto-starts here (svc_cdtrack,
  // see test/e2e/y_music.ts) -- `volume` only gates the SFX mixer, not CD
  // music (that is `bgmvolume`, a separate cvar/device entirely per
  // src/platform/cd_ogg.ts), so a still-playing track would otherwise
  // confound every silence assertion below. This driver is about the SFX
  // mixer only; music has its own family Y coverage in y_music.ts.
  exec("bgmvolume 0");
  await pump(0.3);

  // ---- 1: firing a weapon is audible ------------------------------------
  exec("impulse 2"); // shotgun -- every tree's player spawns with it loaded
  await pump(0.3);
  const attackStart = elapsed();
  execNow("+attack");
  await pump(1.0);
  execNow("-attack");
  const attackEnd = elapsed();
  await pump(0.5);

  // ---- 2: volume 0 silences it -------------------------------------------
  exec("volume 0");
  await pump(0.2);
  const silentStart = elapsed();
  execNow("+attack");
  await pump(2.0);
  execNow("-attack");
  const silentEnd = elapsed();
  await pump(0.5);
  exec("volume 1");
  await pump(0.3);

  // ---- 3: stereo panning with a fixed source + player turn ---------------
  const panSfx = precacheFirst(["sgun1.wav", "rocket1i.wav", "rocket1.wav"].map((n) => `weapons/${n}`));
  check(`[${label}] a weapon sfx precached for the panning probe`, panSfx !== null, panSfx?.name ?? "no candidate resolved");

  const rightX = listener_right[0];
  const rightY = listener_right[1];
  const rightZ = listener_right[2];
  const src = vec3();
  src[0] = listener_origin[0] + rightX * 150;
  src[1] = listener_origin[1] + rightY * 150;
  src[2] = listener_origin[2] + rightZ * 150;

  let pan1Start = 0;
  let pan1End = 0;
  let pan2Start = 0;
  let pan2End = 0;
  let turnedDeg = 0;
  if (panSfx) {
    pan1Start = elapsed();
    S_StartSound(9101, 1, panSfx.sfx, src, 1.0, 0);
    await pump(1.0);
    pan1End = elapsed();
    await pump(0.4);

    turnedDeg = await turnPlayerDegrees(160, 4.0);
    await pump(0.2);

    pan2Start = elapsed();
    S_StartSound(9102, 1, panSfx.sfx, src, 1.0, 0);
    await pump(1.0);
    pan2End = elapsed();
    await pump(0.3);
  }

  // ---- 4: resampling fidelity (id1/mg1 only) -----------------------------
  const wavCandidates = tree === "classic-id1" ? [] : ["ambience/hum1.wav", "ambience/comp_hum1.wav", "ambience/fl_hum1.wav"];
  let freqWav = "";
  let freqStart = 0;
  let freqEnd = 0;
  let sourceFreq = 0;
  let sourceRate = 0;
  for (const rel of wavCandidates) {
    // COM_FindFilePath only walks "dir" search-path entries (it hands a real
    // filesystem path to libvorbisfile's ov_fopen in cd_ogg.ts, which cannot
    // open a byte range inside a .pak) -- these sound/*.wav files live INSIDE
    // pak0.pak, so COM_LoadTempFile (COM_LoadFile's full search, same path
    // S_LoadSound itself uses) is the right call here, not COM_FindFilePath.
    const pakPath = `sound/${rel}`;
    const raw = COM_LoadTempFile(pakPath);
    if (!raw) continue;
    const wav = parseWav(raw);
    if (!wav) continue;
    const sfx = S_PrecacheSound(rel);
    if (!sfx) continue;
    freqWav = pakPath;
    sourceRate = wav.sampleRate;
    sourceFreq = monoDominantFreq(wav.samples, wav.sampleRate, 0, Math.min(wav.samples.length, wav.sampleRate));
    freqStart = elapsed();
    S_StartSound(9201, 1, sfx, listener_origin, 1.0, 0);
    await pump(1.5);
    freqEnd = elapsed();
    break;
  }
  await pump(0.3);

  execNow("soundinfo");
  frames(2);
  const soundinfoText = conTail(30);

  execNow("disconnect");
  await pump(0.3);

  // ---- analysis: one capture-file load, then windowed per phase ---------
  const capturePath = process.env.SDL_DISKAUDIOFILE;
  check(`[${label}] a capture path was set (SDL_DISKAUDIOFILE)`, !!capturePath, String(capturePath));
  if (!capturePath || !existsSync(capturePath)) {
    summary(`y_mixer_child_${tree}_${speed}`);
    return;
  }
  const pcm = readRawPcmSync(capturePath);
  const rmsW: WindowStat[] = rmsWindows(pcm, 0.25);
  const lrW: LRWindow[] = leftRightWindows(pcm, 0.25);

  const attackWindows = inRange(rmsW, attackStart, attackEnd + 0.3);
  check(
    `[${label}] firing a weapon produces non-silent capture`,
    attackWindows.some((w) => !w.silent),
    `${attackWindows.filter((w) => !w.silent).length}/${attackWindows.length} windows audible in [${attackStart.toFixed(2)},${(attackEnd + 0.3).toFixed(2)}]s`,
  );

  // +1.0s guard: the ring buffer/device queue can still hold audio painted
  // moments before `volume 0` took effect (the same buffering-lead-time
  // reasoning test/e2e/y_ambient.ts's and y_music.ts's own stop probes need).
  const silentWindows = inRange(rmsW, silentStart + 1.0, silentEnd + 0.3);
  check(
    `[${label}] volume 0 silences the capture`,
    silentWindows.length > 0 && silentWindows.every((w) => w.silent),
    `${silentWindows.filter((w) => w.silent).length}/${silentWindows.length} windows silent in [${(silentStart + 1.0).toFixed(2)},${(silentEnd + 0.3).toFixed(2)}]s`,
  );

  if (panSfx) {
    check(`[${label}] the turn commands actually rotated the view`, Math.abs(turnedDeg) >= 100, `turned ${turnedDeg.toFixed(1)} deg (target 160)`);
    const w1 = windowsInRange(lrW, pan1Start, pan1End);
    const w2 = windowsInRange(lrW, pan2Start, pan2End);
    const bias = (ws: readonly LRWindow[]): number => {
      let l = 0;
      let r = 0;
      for (const w of ws) {
        l += w.rmsL;
        r += w.rmsR;
      }
      return r - l; // positive: panned right
    };
    const bias1 = bias(w1);
    const bias2 = bias(w2);
    check(`[${label}] the fixed sound source is audible before the turn`, w1.some((w) => !w.silent), `bias1=${bias1.toFixed(0)} (${w1.length} windows)`);
    check(
      `[${label}] stereo panning flips sign after the player turns ~180 deg`,
      bias1 !== 0 && bias2 !== 0 && Math.sign(bias1) !== Math.sign(bias2),
      `bias1=${bias1.toFixed(0)} bias2=${bias2.toFixed(0)} (turned ${turnedDeg.toFixed(1)} deg)`,
    );
  }

  if (freqWav && freqEnd > freqStart) {
    const capWindow = inRange(rmsW, freqStart + 0.1, freqEnd);
    check(`[${label}] the resampling probe sound is audible in the capture`, capWindow.some((w) => !w.silent), `${freqWav} (source ${sourceRate} Hz)`);
    const startFrame = Math.round((freqStart + 0.15) * DISK_RATE);
    const endFrame = Math.round(freqEnd * DISK_RATE);
    const capturedFreq = dominantFreqZeroCrossing(pcm, startFrame, endFrame);
    const rel = sourceFreq > 0 ? Math.abs(capturedFreq - sourceFreq) / sourceFreq : 1;
    check(
      `[${label}] ${freqWav} plays at its own pitch (no gross resampling artefact)`,
      sourceFreq > 0 && rel < 0.25,
      `source=${sourceFreq.toFixed(1)}Hz(native ${sourceRate}Hz) captured=${capturedFreq.toFixed(1)}Hz rel_diff=${(rel * 100).toFixed(1)}%`,
    );
  } else if (tree !== "classic-id1") {
    check(`[${label}] a 44.1kHz-native re-release wav was found for the resampling probe`, false, `none of ${wavCandidates.map((c) => `sound/${c}`).join(", ")} resolved via COM_LoadTempFile`);
  }

  check(`[${label}] soundinfo reports the configured speed`, soundinfoText.includes(`${speed} speed`), soundinfoText.replace(/\n/g, " | "));

  summary(`y_mixer_child_${tree}_${speed}`);
}

async function runParent(tree: MixerTree): Promise<void> {
  mkdirSync(Y_SCRATCH, { recursive: true });
  const speeds = [44100, 11025];
  let totalPass = 0;
  let totalFail = 0;

  for (const speed of speeds) {
    const capturePath = join(Y_SCRATCH, `y_mixer_${tree}_${speed}.raw`);
    if (existsSync(capturePath)) rmSync(capturePath);
    console.log(`[y_mixer] tree=${tree} speed=${speed} -> child, capture -> ${capturePath}`);

    const proc = Bun.spawn(["bun", "test/e2e/y_mixer.ts", "--tree", tree, "--speed", String(speed), "--child"], {
      cwd: join(import.meta.dir, "..", ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SDL_VIDEODRIVER: "dummy",
        SDL_AUDIODRIVER: "disk",
        SDL_DISKAUDIOFILE: capturePath,
        // the disk driver otherwise sleeps a full buffer between writes; 0
        // keeps it paced by the audio callback alone (c_run.ts's own note).
        SDL_DISKAUDIODELAY: "0",
      },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    const combined = out + err;
    console.log(`----- y_mixer child tree=${tree} speed=${speed} (exit ${exitCode}) -----`);
    console.log(combined);
    console.log(`----- end child output -----`);

    const parsed = parseResultLine(combined);
    if (parsed) {
      totalPass += parsed.pass;
      totalFail += parsed.fail;
    } else {
      totalFail += 1;
      console.log(`[FAIL] y_mixer_${tree}_${speed}_ran :: child produced no RESULT line (exit=${exitCode})`);
    }
  }

  console.log(`\n===SUMMARY y_mixer ${tree}=== ${totalPass}/${totalPass + totalFail} passed`);
  console.log(`RESULT ${totalPass} ${totalFail}`);
  process.exit(totalFail > 0 ? 1 : 0);
}

async function main(): Promise<void> {
  const treeArg = arg("tree", "");
  if (!isMixerTree(treeArg)) {
    console.log(`[FAIL] tree-argument :: unknown/unsupported tree "${treeArg}" (expected one of ${SUPPORTED_TREES.join("|")})`);
    console.log("RESULT 0 1");
    process.exit(2);
  }
  if (flag("child")) {
    await runChild(treeArg, Number(arg("speed", "44100")));
    return;
  }
  await runParent(treeArg);
}

await main();
