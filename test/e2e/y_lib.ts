// E2E family Y (unit E9) -- sound and music end to end, with captured audio
// evidence for every scenario. Shared helpers for the y_*.ts drivers, modeled
// on test/e2e/j_lib.ts's shape (boot/frame-pump/console-ring helpers) plus
// test/e2e/c_analyzer.ts's raw-PCM analysis (imported read-only, never
// edited -- same rule j_ambient.ts already follows for c_harness.ts/
// c_analyzer.ts: those files, and test/e2e/s_lib.ts's per-tree `treeConfig`
// table this file re-exports below, belong to sibling agents' units and are
// only ever read from here).
//
// Every y_*.ts driver is a standalone script run as `bun test/e2e/y_<name>.ts
// [args...]`, never a bun:test suite (test/e2e/README.md's "Headless
// recipe"). Each one captures PCM with SDL_AUDIODRIVER=disk (per
// .orch/briefs/E9-audio.md's driver contract) and analyses it with
// c_analyzer.ts's summarize()/dominantFreqZeroCrossing() plus this file's own
// left/right-channel split (needed for the stereo-panning assertion, which
// summarize()'s combined-channel RMS cannot see) and WAV-header parser (for
// the resampling-fidelity assertion, which needs the SOURCE file's own
// dominant frequency to compare the capture against).
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute } from "../../src/common/cmd";
import { conState } from "../../src/client/console";
import * as consoleMod from "../../src/client/console";
import { cl } from "../../src/client/client";
import { YAW } from "../../src/common/quakedef";
import { Q1TS_DATA, homedirArgs, homedirRoot } from "./q1data";
import { readRawPcmSync, DISK_RATE, type RawPcm } from "./c_analyzer";
export { treeConfig, isTreeName, type TreeName, type TreeConfig } from "./s_lib";
export { Q1TS_DATA };

export const Q1TS_SCRATCH = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
/** This unit's own scratch tree, separate from every other family's. */
export const Y_SCRATCH = join(Q1TS_SCRATCH, "e2e", "y");

// ---- PASS/FAIL/RESULT contract (test/e2e/README.md, E2E-COMMON.md) -------

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

export function summary(label: string): void {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n===SUMMARY ${label}=== ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - bad.length} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

/** Parses a trailing "RESULT <pass> <fail>" line out of a child driver's combined console text. */
export function parseResultLine(consoleText: string): { pass: number; fail: number } | null {
  const m = /^RESULT (\d+) (\d+)\s*$/m.exec(consoleText);
  if (!m) return null;
  return { pass: Number(m[1]), fail: Number(m[2]) };
}

export function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function gameName(...parts: string[]): string {
  return ["e2e_y", ...parts].join("_");
}

// ---- boot / frame pump ----------------------------------------------------

export function boot(argv: string[]): void {
  Sys_Main_Init(["q1ts", ...argv]);
}

export function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

export function exec(text: string, n = 2): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n);
}

export function execNow(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  Cbuf_Execute();
}

/*
A real-time-paced frame pump: SDL's disk audio driver paces its writes to
wall-clock time (c_analyzer.ts's header, confirmed empirically by the C-track
unit), so any scenario whose captured .raw file's timing is to mean anything
must advance frames in step with real elapsed time, not a tight synchronous
loop. tSec is wall-clock time since this call's own start; onTick (if given)
runs once per iteration before the frame step, receiving that elapsed time.
Returns the number of frames actually run.
*/
export async function pump(durationSec: number, dt = 0.05, onTick?: (elapsedSec: number) => void): Promise<number> {
  const start = Date.now();
  let n = 0;
  while ((Date.now() - start) / 1000 < durationSec) {
    const elapsed = (Date.now() - start) / 1000;
    if (onTick) onTick(elapsed);
    runFrames(1, dt);
    n++;
    await Bun.sleep(Math.max(1, Math.round(dt * 1000)));
  }
  return n;
}

// ---- console ring buffer ---------------------------------------------------

export function conLines(): string[] {
  const t = consoleMod.con_text;
  if (!t) return [];
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  const out: string[] = [];
  for (let i = conState.con_current - total + 1; i <= conState.con_current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(t[row * w + x] & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}
export function conHas(needle: string | RegExp): boolean {
  return conLines().some((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));
}
export function conTail(n = 12): string {
  return conLines()
    .filter((l) => l.length > 0)
    .slice(-n)
    .join("\n");
}

/** Extracts the highest N seen in a "----(N)----" snd_show line (snd_dma.ts's S_Update, gated on `snd_show 1`). */
export function maxSndShowCount(lines: string[]): number {
  let max = -1;
  const re = /^----\((\d+)\)----$/;
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

// ---- raw-PCM left/right split (for stereo panning) ------------------------
// c_analyzer.ts's own WindowStat only carries a combined-channel RMS; the
// panning assertion needs the two channels separately.

export { readRawPcmSync, DISK_RATE, type RawPcm };

export interface LRWindow {
  tStartSec: number;
  tEndSec: number;
  rmsL: number;
  rmsR: number;
  peakL: number;
  peakR: number;
  silent: boolean;
}

export function leftRightWindows(pcm: RawPcm, windowSec: number, silenceRmsThreshold = 24): LRWindow[] {
  const windowFrames = Math.max(1, Math.round(windowSec * DISK_RATE));
  const out: LRWindow[] = [];
  for (let start = 0; start < pcm.frames; start += windowFrames) {
    const end = Math.min(pcm.frames, start + windowFrames);
    let sumL = 0;
    let sumR = 0;
    let peakL = 0;
    let peakR = 0;
    let n = 0;
    for (let f = start; f < end; f++) {
      const l = pcm.samples[f * 2];
      const r = pcm.samples[f * 2 + 1];
      sumL += l * l;
      sumR += r * r;
      n++;
      if (Math.abs(l) > peakL) peakL = Math.abs(l);
      if (Math.abs(r) > peakR) peakR = Math.abs(r);
    }
    const rmsL = Math.sqrt(sumL / Math.max(1, n));
    const rmsR = Math.sqrt(sumR / Math.max(1, n));
    out.push({ tStartSec: start / DISK_RATE, tEndSec: end / DISK_RATE, rmsL, rmsR, peakL, peakR, silent: Math.max(rmsL, rmsR) < silenceRmsThreshold });
  }
  return out;
}

export function windowsInRange(ws: readonly LRWindow[], tStartSec: number, tEndSec: number): LRWindow[] {
  return ws.filter((w) => w.tEndSec > tStartSec && w.tStartSec < tEndSec);
}

// ---- WAV header parsing (for the resampling-fidelity comparison) ---------
// Standard RIFF/WAVE chunk walk (fmt /data, skipping any other chunk by its
// own declared size, e.g. Quake's wavs sometimes carry a "cue " chunk) --
// this port's own COM_LoadTempFile hands back the pak-resident file's raw
// bytes; nothing here touches src/.

export interface WavPcm {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Int16Array; // interleaved if channels > 1
}

export function parseWav(bytes: Uint8Array): WavPcm | null {
  if (bytes.length < 12) return null;
  const id4 = (o: number): string => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (id4(0) !== "RIFF" || id4(8) !== "WAVE") return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = id4(offset);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bitsPerSample = dv.getUint16(body + 14, true);
    } else if (chunkId === "data") {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2); // chunks are word-padded
  }
  if (dataOffset < 0 || sampleRate === 0 || bitsPerSample !== 16) return null;

  const frameCount = Math.trunc(Math.min(dataSize, bytes.length - dataOffset) / 2);
  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) samples[i] = dv.getInt16(dataOffset + i * 2, true);
  return { sampleRate, channels: channels || 1, bitsPerSample, samples };
}

/** Dominant frequency via zero-crossing rate, generalized from c_analyzer.ts's interleaved-stereo version to a plain mono buffer at an arbitrary sample rate. */
export function monoDominantFreq(samples: Int16Array, sampleRate: number, startFrame = 0, endFrame = samples.length): number {
  let crossings = 0;
  let prev = 0;
  let first = true;
  for (let i = startFrame; i < endFrame && i < samples.length; i++) {
    const v = samples[i];
    if (!first && (prev < 0) !== (v < 0) && v !== 0) crossings++;
    if (v !== 0) prev = v;
    first = false;
  }
  const seconds = (Math.min(endFrame, samples.length) - startFrame) / sampleRate;
  return seconds > 0 ? crossings / 2 / seconds : 0;
}

/*
Rotates the player's view by driving the real `+left`/`+right` turn commands
(bindable console commands, always registered regardless of key bindings --
CL_AdjustAngles applies cl_yawspeed * frametime while `in_left`/`in_right` is
held) rather than writing cl.viewangles directly, so the panning assertion
also exercises the turn commands themselves. Polls cl.viewangles[YAW] every
frame and stops once the accumulated turn reaches targetDeg (or maxSec
elapses); returns the actual signed delta turned, normalized to (-180,180].
*/
export async function turnPlayerDegrees(targetDeg: number, maxSec = 4): Promise<number> {
  const startYaw = cl.viewangles[YAW];
  execNow(targetDeg >= 0 ? "+right" : "+left");
  const t0 = Date.now();
  let delta = 0;
  while ((Date.now() - t0) / 1000 < maxSec) {
    runFrames(1, 0.05);
    await Bun.sleep(50);
    const raw = cl.viewangles[YAW] - startYaw;
    delta = ((raw + 540) % 360) - 180;
    if (Math.abs(delta) >= Math.abs(targetDeg)) break;
  }
  execNow(targetDeg >= 0 ? "-right" : "-left");
  return delta;
}

// ---- misc -------------------------------------------------------------

export { homedirArgs, homedirRoot };

/**
 * Waits until nothing is listening on a UDP port, per E9's brief: QuakeWorld's
 * client port (`PORT_CLIENT` in src/qw/protocol.ts) is a hardcoded 27001 with
 * no `-port` override, and unit F20 runs short QuakeWorld unit tests
 * concurrently with this unit's own y_qw.ts -- both cannot bind it at once.
 * Uses `ss -lun` (UDP listeners) rather than trying to bind and catching the
 * error, so a driver that only checks and never itself opens the socket
 * early can retry cleanly.
 */
export async function waitForUdpPortFree(port: number, maxWaitSec: number, pollSec = 2): Promise<boolean> {
  const t0 = Date.now();
  const needle = new RegExp(`:${port}(\\s|$)`);
  for (;;) {
    const proc = Bun.spawnSync(["ss", "-lun"]);
    const out = new TextDecoder().decode(proc.stdout);
    const busy = out.split("\n").some((line) => needle.test(line.trim()));
    if (!busy) return true;
    if ((Date.now() - t0) / 1000 >= maxWaitSec) return false;
    await Bun.sleep(pollSec * 1000);
  }
}

/** Every quake*.pcx/.tga screenshot currently in a game directory (unused by most y_ drivers; kept for parity with the other families' shot() helpers if a future scenario needs one). */
export function shotFiles(gamedir: string): Set<string> {
  if (!existsSync(gamedir)) return new Set();
  return new Set(readdirSync(gamedir).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}
