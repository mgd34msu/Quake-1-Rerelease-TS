/*
Family X, driver 4: record a played level on a listen server, stop, then play
it back in a fresh process, at each protocol this engine's NetQuake side
speaks.

  bun test/e2e/x_record.ts --protocol 15  --port 26810
  bun test/e2e/x_record.ts --protocol 666 --port 26820
  bun test/e2e/x_record.ts --protocol 999 --port 26830

Standing order 19 (a live gate runs our own compiled binary in both seats):
every seat here is the compiled binary (test/e2e/t_lib.ts's BINARY, resolved
from Q1TS_BINARY when the runner already built one, or built fresh under this
family's own scratch tree otherwise), never `bun src/main.ts`. t_lib.ts
belongs to unit E3 (family T) and is only read here, never written; its
`startClient`/`killSeat`/`readLog`/`waitFor`/argv-substitution machinery and
its headless-env enforcement (SDL_VIDEODRIVER/SDL_AUDIODRIVER forced to
"dummy" in every spawned seat's environment, `-nosound` forced onto every
command line) are reused rather than re-derived.

A LISTEN server is simply a normal, non-dedicated boot with a `map` command --
`record <name> <map>` (src/client/cl_demo.ts's CL_Record_f, `c > 2` branch)
runs the map itself before opening the demo file, so the recording captures
the local loopback connect/signon handshake too, exactly as
test/e2e/a_demos.ts's own `record` mode does; the only thing new here is doing
it in a genuinely fresh, disposable OS process at each protocol, and playing
the result back in a SECOND fresh process with no server anywhere.

Every seat's timeline is one fixed `wait`-scripted console cfg (t_lib.ts's
`waits()`), not a wall-clock `sleep()`: `wait` delays the command buffer by
exactly one real Host_Frame of that seat's own live process, so the same
`wait` count run twice (once recording, once played back) reaches the same
point in the RECORDED MESSAGE STREAM in both cases for content that does not
itself depend on the exact rate frames arrive at -- the player's spawn
position and view angle immediately after signon, which is what this driver's
mid-demo screenshot targets, rather than a moving mid-action frame whose exact
pixels would depend on how the two fresh processes' real frame pacing
happened to line up with the demo's embedded server-tick timestamps (playback
paces itself off `cl.time` vs. the recorded snapshot times, not off `wait`
counts, so a LATER frame is not guaranteed to land on the same wall-clock/
demo-time relationship a second run would reach).

"Same length within tolerance" is read the same way test/e2e/x_timedemo.ts
reads it for a retail demo: two independent fresh-process `timedemo` runs of
the SAME recorded file must report the same frame count (within the small
slack CL_TimeDemo_f's own "first frame excluded" convention already costs) --
proof the recording is well-formed and plays back deterministically, not a
comparison against a wall-clock duration measured on the live (real-time,
non-deterministic) recording side, which is not a fact this engine's demo
format records at all.
*/

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { argValue, baseArgs, check, clientLevelTitle, contentById, killSeat, readLog, startClient, summary, waitFor, waits, type SeatT } from "./t_lib";
import { homedirRoot } from "./q1data";

const PROTOCOL_ARG = argValue("protocol", "666");
if (PROTOCOL_ARG !== "15" && PROTOCOL_ARG !== "666" && PROTOCOL_ARG !== "999") {
  console.log(`[FAIL] protocol-argument :: unknown protocol "${PROTOCOL_ARG}"`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const DEFAULT_PORT: Record<string, string> = { "15": "26810", "666": "26820", "999": "26830" };
const port = argValue("port", DEFAULT_PORT[PROTOCOL_ARG]);
const content = contentById("classic-id1");
const DEMO = `x_rec_${PROTOCOL_ARG}`;
const SPAWN_SETTLE = 90; // real Host_Frame ticks: long enough for a loopback signon to a small e1m1-sized map
const HOLD_FRAMES = 240; // real Host_Frame ticks the recording holds +forward/+attack, for a demo with real length

// ===========================================================================
// minimal PCX decoder (src/ref_soft/ref_soft.ts's WritePCXfile, read back)
// ===========================================================================

interface PcxImageT {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

function decodePcx(buf: Uint8Array): PcxImageT | null {
  if (buf.length < 128 + 769 || buf[0] !== 0x0a) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint16(8, true) + 1;
  const height = view.getUint16(10, true) + 1;
  const palette = buf.subarray(buf.length - 768);
  const indices = new Uint8Array(width * height);
  let src = 128;
  let dst = 0;
  for (let row = 0; row < height; row++) {
    let col = 0;
    while (col < width && src < buf.length) {
      const b = buf[src++];
      if ((b & 0xc0) === 0xc0) {
        const count = b & 0x3f;
        const value = buf[src++];
        for (let k = 0; k < count && col < width; k++) {
          indices[dst++] = value;
          col++;
        }
      } else {
        indices[dst++] = b;
        col++;
      }
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const idx = indices[i];
    rgb[i * 3] = palette[idx * 3];
    rgb[i * 3 + 1] = palette[idx * 3 + 1];
    rgb[i * 3 + 2] = palette[idx * 3 + 2];
  }
  return { width, height, rgb };
}

function findPcx(dir: string): PcxImageT | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^quake\d+\.pcx$/i.test(f));
  if (files.length === 0) return null;
  files.sort();
  const buf = readFileSync(`${dir}/${files[0]}`);
  return decodePcx(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

/** Mean absolute per-channel difference, 0..255; -1 if the two images are not directly comparable. */
function pcxMeanAbsDiff(a: PcxImageT, b: PcxImageT): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs(a.rgb[i] - b.rgb[i]);
  return sum / a.rgb.length;
}

// ===========================================================================
// recording: a listen server, one fixed wait-scripted cfg
// ===========================================================================

const RECORD_GAME = `e2e_x_rec_${PROTOCOL_ARG}`;
const recArgs = [...baseArgs(content, RECORD_GAME), "-port", port, "+sv_protocol", PROTOCOL_ARG];
const recScript = [
  "cl_shownet 0",
  `record ${DEMO} e1m1`,
  ...waits(SPAWN_SETTLE),
  "screenshot",
  "+forward",
  "+attack",
  ...waits(HOLD_FRAMES),
  "-forward",
  "-attack",
  "stop",
  ...waits(10),
];
const rec: SeatT = startClient(`x_rec_${PROTOCOL_ARG}_live`, RECORD_GAME, recArgs, recScript);

const recCompleted = await waitFor(rec, /Completed demo/, 120000);
check(`x_record_${PROTOCOL_ARG}/live-recording-completes`, recCompleted, recCompleted ? "" : readLog(rec).slice(-800));
const recText = readLog(rec);
const liveTitle = clientLevelTitle(recText);
check(`x_record_${PROTOCOL_ARG}/live-title-seen`, liveTitle !== null && liveTitle.length > 0, `title=${liveTitle ?? "(none)"}`);

const recGameDir = `${homedirRoot()}/${RECORD_GAME}`;
const liveShot = findPcx(recGameDir);
check(`x_record_${PROTOCOL_ARG}/live-screenshot-written`, liveShot !== null, liveShot === null ? `no quake*.pcx under ${recGameDir}` : `${liveShot.width}x${liveShot.height}`);

killSeat(rec);

const demoFile = `${recGameDir}/${DEMO}.dem`;
check(`x_record_${PROTOCOL_ARG}/demo-file-on-disk`, existsSync(demoFile), demoFile);

// ===========================================================================
// playback in a fresh process: title + mid-demo screenshot
// ===========================================================================

const PLAY_GAME = `e2e_x_rec_${PROTOCOL_ARG}_play`;
mkdirSync(`${homedirRoot()}/${PLAY_GAME}`, { recursive: true });
// COM_FindFile needs the recorded demo visible from the fresh process's own
// gamedir search path; copying it across keeps this a genuinely fresh
// process with no server anywhere, reading only the file the live seat wrote.
copyFileSync(demoFile, `${homedirRoot()}/${PLAY_GAME}/${DEMO}.dem`);
const playArgs = [...baseArgs(content, PLAY_GAME)];
const playScript = ["cl_shownet 0", "disconnect", `playdemo ${DEMO}`, ...waits(SPAWN_SETTLE), "screenshot", ...waits(10)];
const play: SeatT = startClient(`x_rec_${PROTOCOL_ARG}_play`, PLAY_GAME, playArgs, playScript);
await waitFor(play, /\[02\]/, 60000);
// The title appears right after signon, well before the script's own
// `screenshot` step (SPAWN_SETTLE waits later) has actually run and written
// its file -- wait for the renderer's own "Wrote quake00.pcx" line too (see
// src/ref_soft/ref_soft.ts's SCR_ScreenShot_f), the same way the live
// recording side's screenshot is only checked after that seat's whole
// scripted timeline (ending in "Completed demo") has finished.
await waitFor(play, /Wrote quake\d+\.pcx/, 60000);
const playText = readLog(play);
const playTitle = clientLevelTitle(playText);
check(`x_record_${PROTOCOL_ARG}/playback-title-matches`, playTitle !== null && liveTitle !== null && playTitle.trim() === liveTitle.trim(), `live="${liveTitle ?? ""}" play="${playTitle ?? ""}"`);

const playGameDir = `${homedirRoot()}/${PLAY_GAME}`;
const playShot = findPcx(playGameDir);
check(`x_record_${PROTOCOL_ARG}/playback-screenshot-written`, playShot !== null, playShot === null ? `no quake*.pcx under ${playGameDir}` : `${playShot.width}x${playShot.height}`);

if (liveShot !== null && playShot !== null) {
  const diff = pcxMeanAbsDiff(liveShot, playShot);
  // Generous on purpose: the spawn-frame view is the same server-authoritative
  // position/angle both times, but an animated world texture (a torch, lava)
  // can land on a different frame index between the two runs -- see file
  // header. A genuinely broken/blank/wrong-level screenshot differs by much
  // more than this (a black frame vs. a lit one is typically 60+).
  check(`x_record_${PROTOCOL_ARG}/screenshots-similar`, diff >= 0 && diff < 40, `meanAbsDiff=${diff.toFixed(2)} (${liveShot.width}x${liveShot.height} vs ${playShot.width}x${playShot.height})`);
} else {
  check(`x_record_${PROTOCOL_ARG}/screenshots-similar`, false, "one or both screenshots missing");
}

killSeat(play);

// ===========================================================================
// "same length within tolerance": two independent fresh-process timedemo runs
// ===========================================================================

function timedemoFrames(seat: SeatT): number | null {
  const text = readLog(seat);
  const m = /(\d+)\s+frames\s+([\d.]+)\s+seconds\s+([\d.]+)\s+fps/.exec(text);
  return m === null ? null : Number(m[1]);
}

const TIME_GAME_A = `e2e_x_rec_${PROTOCOL_ARG}_t1`;
const TIME_GAME_B = `e2e_x_rec_${PROTOCOL_ARG}_t2`;
for (const g of [TIME_GAME_A, TIME_GAME_B]) mkdirSync(`${homedirRoot()}/${g}`, { recursive: true });
copyFileSync(demoFile, `${homedirRoot()}/${TIME_GAME_A}/${DEMO}.dem`);
copyFileSync(demoFile, `${homedirRoot()}/${TIME_GAME_B}/${DEMO}.dem`);

const timedScript = ["cl_shownet 0", "disconnect", `timedemo ${DEMO}`, ...waits(20)];
const timedA = startClient(`x_rec_${PROTOCOL_ARG}_t1`, TIME_GAME_A, [...baseArgs(content, TIME_GAME_A)], timedScript);
const timedAok = await waitFor(timedA, /\d+ frames\s+[\d.]+ seconds/, 60000);
check(`x_record_${PROTOCOL_ARG}/timedemo-run-1-prints`, timedAok, timedAok ? "" : readLog(timedA).slice(-400));
const framesA = timedemoFrames(timedA);
killSeat(timedA);

const timedB = startClient(`x_rec_${PROTOCOL_ARG}_t2`, TIME_GAME_B, [...baseArgs(content, TIME_GAME_B)], timedScript);
const timedBok = await waitFor(timedB, /\d+ frames\s+[\d.]+ seconds/, 60000);
check(`x_record_${PROTOCOL_ARG}/timedemo-run-2-prints`, timedBok, timedBok ? "" : readLog(timedB).slice(-400));
const framesB = timedemoFrames(timedB);
killSeat(timedB);

if (framesA !== null && framesB !== null) {
  const delta = Math.abs(framesA - framesB);
  check(`x_record_${PROTOCOL_ARG}/length-reproducible`, delta <= 2, `run1=${framesA} run2=${framesB} delta=${delta}`);
  check(`x_record_${PROTOCOL_ARG}/length-nonzero`, framesA > 20 && framesB > 20, `run1=${framesA} run2=${framesB}`);
} else {
  check(`x_record_${PROTOCOL_ARG}/length-reproducible`, false, `run1=${String(framesA)} run2=${String(framesB)}`);
}

const allLogs = [recText, playText, readLog(timedA), readLog(timedB)].join("\n");
check(
  `x_record_${PROTOCOL_ARG}/no-fatal-engine-error`,
  !/Sys_Error|Fatal:|Host_Error/.test(allLogs),
  (allLogs.match(/.*(Sys_Error|Fatal:|Host_Error).*/g) ?? []).slice(0, 3).join(" | "),
);

summary(`x_record ${PROTOCOL_ARG}`);
