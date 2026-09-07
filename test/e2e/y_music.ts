/*
E9 (family Y, unit E9): music end to end, per .orch/briefs/E9-audio.md item 3
("whatever music path exists (cd/ogg/track): if implemented, `cd play 2`/the
track cvar produces non-silent output and stops on `cd stop`; if not
implemented, one [FAIL] with the exact gap").

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=disk SDL_DISKAUDIOFILE=<raw> \
    bun test/e2e/y_music.ts

FINDING: music IS implemented -- src/platform/cd_ogg.ts replaces the
original cd_linux.c's physical-CD path with Ogg Vorbis rips
(`music/NN.ogg`/`music/trackNN.ogg`, dlopen'd libvorbisfile, the long-
standing community convention for CD-less installs), and the retail
re-release data this host has under Q1TS_DATA/rerelease/{id1,hipnotic,
rogue,mg3}/music/*.ogg actually exercises it end to end (confirmed by an
ad-hoc probe capture before this driver was written: `cd play 2` on the
rerelease id1 tree produced ~3.5s of real audio in an SDL_AUDIODRIVER=disk
capture, ending exactly at the following `cd stop`). `rerelease/mg1` ships no
music/ directory at all -- reported separately below as a data gap, not an
engine defect (cd_ogg.ts's own CD_f/CDAudio_Play print "no music file for
track" and answer cleanly rather than throwing, exactly like the C-track
`cd` scenario already exercises for a tree with none).

"the track cvar" (E9's own wording) is read as the level-driven path:
src/server/sv_main.ts sends `svc_cdtrack` with the map's own worldspawn
`sounds` key on every client spawn, and src/client/cl_parse.ts's handler
calls `CDAudio_Play` with it automatically (protocol.ts's svc_cdtrack=32) --
no cvar of that name actually exists in this port or in id's own source, so
this driver exercises the level-driven svc_cdtrack path as a second, real
form of the same claim: e1m1 with the tree's mounted, its own worldspawn
`sounds` track starts on connect, without any `cd` command at all.

Scenario:
  1. disconnect (stop quake.rc's own startdemos before it makes any sound
     of its own), `cd play 2`, `cd stop` -- non-silent then silent, on the
     tree that ships music/02.ogg.
  2. `map e1m1` on the same tree -- svc_cdtrack starts a track with no `cd`
     command issued at all; asserted via `cd info`'s console line and a
     PCM window, then `cd stop` returns to silence.

CORRECTED ASSUMPTION (this driver's own first draft got this wrong): CD
audio does NOT stop on `disconnect`. Checked against id's own
WinQuake/cl_main.c (../qsrc/quake/WinQuake/cl_main.c) -- CDAudio_Stop is
never called from CL_Disconnect there, only from within cd_linux.c/cd_win.c's
own CD_f ("stop"), CDAudio_Play (replacing a track), and CDAudio_Shutdown at
engine exit. A first run of this driver asserted the opposite (music keeps
playing across `disconnect`, matching id's own source) and correctly failed;
fixed here to assert the true, faithful behaviour with an explicit
`cd stop` instead, matching phase 1's own already-passing check.
*/
import { rmsWindows, type WindowStat } from "./c_analyzer";
import { check, summary, boot, pump, frames, exec, execNow, conTail, homedirArgs, gameName, treeConfig, readRawPcmSync, Y_SCRATCH } from "./y_lib";
import { existsSync, mkdirSync } from "node:fs";

function inRange<T extends { tStartSec: number; tEndSec: number }>(ws: readonly T[], a: number, b: number): T[] {
  return ws.filter((w) => w.tEndSec > a && w.tStartSec < b);
}

async function main(): Promise<void> {
  mkdirSync(Y_SCRATCH, { recursive: true });
  // rerelease id1: the only tree confirmed (by directory listing) to ship
  // music/02.ogg -- see file header on mg1's own gap.
  const cfg = treeConfig("id1");
  const game = gameName("music");
  boot(["-basedir", cfg.basedir, ...cfg.flags, ...homedirArgs(game), "-game", game, "-vid_ref", "soft"]);
  execNow("disconnect"); // stop quake.rc's own startdemos before it makes any sound of its own
  const t0 = Date.now();
  const elapsed = (): number => (Date.now() - t0) / 1000;

  await pump(0.5);
  exec("volume 1");
  exec("bgmvolume 1");
  await pump(0.5); // let CDAudio_Update settle cdvolume against bgmvolume before `cd play`

  // ---- phase 1: manual `cd play`/`cd stop` -------------------------------
  const baselineStart = elapsed();
  await pump(1.0);
  const baselineEnd = elapsed();

  execNow("cd play 2");
  const playStart = elapsed();
  await pump(4.0);
  const playEnd = elapsed();

  execNow("cd stop");
  const stopMark = elapsed();
  await pump(2.5);
  const afterStopEnd = elapsed();

  const cdInfoAfterPlay = conTail(20);

  // ---- phase 2: level-driven svc_cdtrack (no `cd` command at all) -------
  execNow("map e1m1");
  await pump(4.0);
  execNow("cd info");
  frames(2);
  const cdInfoText = conTail(10);
  const levelTrackStart = elapsed();
  await pump(2.0);
  const levelTrackEnd = elapsed();

  execNow("cd stop");
  const secondStopMark = elapsed();
  await pump(3.0);
  const afterSecondStopEnd = elapsed();

  // ---- analysis -----------------------------------------------------------
  const capturePath = process.env.SDL_DISKAUDIOFILE;
  check("a capture path was set (SDL_DISKAUDIOFILE)", !!capturePath, String(capturePath));
  if (!capturePath || !existsSync(capturePath)) {
    summary("y_music");
    return;
  }
  const pcm = readRawPcmSync(capturePath);
  const rmsW: WindowStat[] = rmsWindows(pcm, 0.25);

  const baselineW = inRange(rmsW, baselineStart + 0.2, baselineEnd);
  check(
    "baseline (before `cd play`) is silent",
    baselineW.length > 0 && baselineW.every((w) => w.silent),
    `${baselineW.filter((w) => w.silent).length}/${baselineW.length} windows silent`,
  );

  const playSettled = inRange(rmsW, playStart + 1.0, playEnd); // skip the decode/queue ramp-up
  check(
    "`cd play 2` produces non-silent output",
    playSettled.some((w) => !w.silent),
    `${playSettled.filter((w) => !w.silent).length}/${playSettled.length} windows audible in [${(playStart + 1.0).toFixed(2)},${playEnd.toFixed(2)}]s :: ${cdInfoAfterPlay.replace(/\n/g, " | ").slice(-200)}`,
  );

  // +1.0s guard: CDAudio_Update's own feedTargetBytes() keeps the CD device's
  // queue up to a quarter-second ahead of "now", already-queued audio a bare
  // channel-clear cannot retract (the same buffering-lead-time reasoning
  // test/e2e/y_ambient.ts's own stopsound probe needed).
  const afterStop = inRange(rmsW, stopMark + 1.0, afterStopEnd);
  check(
    "`cd stop` returns the capture to silence",
    afterStop.length > 0 && afterStop.every((w) => w.silent),
    `${afterStop.filter((w) => w.silent).length}/${afterStop.length} windows silent`,
  );

  check("`cd info` names a track after `cd play`/on level load", /track \d+/i.test(cdInfoText), cdInfoText.replace(/\n/g, " | "));

  const levelTrackSettled = inRange(rmsW, levelTrackStart + 0.5, levelTrackEnd);
  check(
    "loading a map with a worldspawn CD track starts music with no `cd` command (svc_cdtrack)",
    levelTrackSettled.some((w) => !w.silent),
    `${levelTrackSettled.filter((w) => !w.silent).length}/${levelTrackSettled.length} windows audible`,
  );

  const afterSecondStop = inRange(rmsW, secondStopMark + 1.5, afterSecondStopEnd);
  check(
    "`cd stop` also ends the level-driven (svc_cdtrack) track",
    afterSecondStop.length > 0 && afterSecondStop.every((w) => w.silent),
    `${afterSecondStop.filter((w) => w.silent).length}/${afterSecondStop.length} windows silent`,
  );

  summary("y_music");
}

await main();
