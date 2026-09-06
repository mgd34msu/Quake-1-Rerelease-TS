// Test infrastructure only (not a ported C file). Analyzes the raw PCM file
// SDL's "disk" audio driver writes when SDL_AUDIODRIVER=disk is set.
//
// Empirically verified against this host's SDL build (sdl2-compat 2.32.70
// over SDL3 0.4.14, see .orch/e2e/C.md "How audio was captured"): regardless
// of the samplerate/channels/bits the application actually opened
// (SDL_OpenAudioDevice's `obtained` spec -- what src/platform/snd.ts's
// SNDDMA_Init copies into `sn.speed`/`sn.channels`), SDL3's disk driver
// resamples/converts everything internally and always writes 44100 Hz,
// 2-channel, signed 16-bit little-endian interleaved PCM to the file named
// by SDL_DISKAUDIOFILE. A controlled test (2s of an 11025 Hz mono 440 Hz
// tone queued through the real SDL API) produced a file matching that fixed
// format almost exactly (2.020s of output, ~435.6 Hz measured back via zero
// crossings) -- so this analyzer hardcodes 44100/2/16 rather than reading it
// from the engine's own -sndspeed/-sndbits choice.
//
// The disk driver also paces writes to real wall-clock time (it behaves like
// a real device's callback timer, not an instant dump of whatever was
// queued), confirmed by two probes that queued the same amount of data but
// only produced output proportional to how long the device stayed open and
// unpaused. So "file size grows over time" is meaningful evidence of
// sustained real-time audio activity, not an artifact of queue depth.

export const DISK_RATE = 44100;
export const DISK_CHANNELS = 2;
export const DISK_BYTES_PER_FRAME = DISK_CHANNELS * 2; // 16-bit

export interface RawPcm {
  bytes: number;
  frames: number;
  seconds: number;
  // Interleaved L,R,L,R... Int16 samples.
  samples: Int16Array;
}

export function readRawPcmSync(path: string): RawPcm {
  const fs = require("node:fs") as typeof import("node:fs");
  const data = fs.readFileSync(path);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return fromArrayBuffer(ab);
}

function fromArrayBuffer(ab: ArrayBuffer): RawPcm {
  const usableBytes = ab.byteLength - (ab.byteLength % DISK_BYTES_PER_FRAME);
  const samples = new Int16Array(ab, 0, usableBytes / 2);
  const frames = usableBytes / DISK_BYTES_PER_FRAME;
  return { bytes: usableBytes, frames, seconds: frames / DISK_RATE, samples };
}

export interface WindowStat {
  tStartSec: number;
  tEndSec: number;
  rms: number; // 0..32768-ish, combined L/R
  peak: number;
  silent: boolean;
}

// windowSec: analysis window size. silenceRmsThreshold: below this RMS (on a
// 16-bit signed scale) a window counts as silent -- the disk driver's own
// "no audio queued yet" gaps write actual zero samples, so a tight threshold
// (e.g. 8-32) safely separates true silence from a real, quiet, decoded wav.
export function rmsWindows(pcm: RawPcm, windowSec: number, silenceRmsThreshold = 24): WindowStat[] {
  const windowFrames = Math.max(1, Math.round(windowSec * DISK_RATE));
  const out: WindowStat[] = [];
  for (let start = 0; start < pcm.frames; start += windowFrames) {
    const end = Math.min(pcm.frames, start + windowFrames);
    let sumSq = 0;
    let peak = 0;
    let n = 0;
    for (let f = start; f < end; f++) {
      const l = pcm.samples[f * 2];
      const r = pcm.samples[f * 2 + 1];
      sumSq += l * l + r * r;
      n += 2;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    out.push({
      tStartSec: start / DISK_RATE,
      tEndSec: end / DISK_RATE,
      rms,
      peak,
      silent: rms < silenceRmsThreshold,
    });
  }
  return out;
}

// Dominant frequency of one window via zero-crossing rate on the summed
// (mono-folded) signal -- coarse, but adequate to confirm "roughly 440 Hz" or
// to compare two windows' pitch is unchanged (spatialization changes
// amplitude, not pitch, so this also doubles as a sanity check that
// attenuation isn't accidentally resampling anything).
export function dominantFreqZeroCrossing(pcm: RawPcm, startFrame: number, endFrame: number): number {
  let crossings = 0;
  let prev = 0;
  let first = true;
  for (let f = startFrame; f < endFrame && f < pcm.frames; f++) {
    const mono = pcm.samples[f * 2] + pcm.samples[f * 2 + 1];
    if (!first && (prev < 0) !== (mono < 0) && mono !== 0) crossings++;
    if (mono !== 0) prev = mono;
    first = false;
  }
  const seconds = (endFrame - startFrame) / DISK_RATE;
  return seconds > 0 ? crossings / 2 / seconds : 0;
}

export interface Summary {
  path: string;
  bytes: number;
  seconds: number;
  overallRms: number;
  nonSilentFraction: number;
  windows: WindowStat[];
}

export function summarize(path: string, windowSec = 0.5): Summary {
  const pcm = readRawPcmSync(path);
  const windows = rmsWindows(pcm, windowSec);
  const nonSilent = windows.filter((w) => !w.silent).length;
  let sumSq = 0;
  for (let i = 0; i < pcm.samples.length; i++) sumSq += pcm.samples[i] * pcm.samples[i];
  const overallRms = Math.sqrt(sumSq / Math.max(1, pcm.samples.length));
  return {
    path,
    bytes: pcm.bytes,
    seconds: pcm.frames / DISK_RATE,
    overallRms,
    nonSilentFraction: windows.length ? nonSilent / windows.length : 0,
    windows,
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  const windowSec = process.argv[3] ? Number(process.argv[3]) : 0.5;
  if (!path) {
    console.error("usage: bun c_analyzer.ts <rawfile> [windowSec]");
    process.exit(1);
  }
  const s = summarize(path, windowSec);
  console.log(
    JSON.stringify(
      {
        path: s.path,
        bytes: s.bytes,
        seconds: Number(s.seconds.toFixed(3)),
        overallRms: Number(s.overallRms.toFixed(1)),
        nonSilentFraction: Number(s.nonSilentFraction.toFixed(3)),
        windowCount: s.windows.length,
        windows: s.windows.map((w) => ({
          t: Number(w.tStartSec.toFixed(2)),
          rms: Number(w.rms.toFixed(1)),
          peak: w.peak,
          silent: w.silent,
        })),
      },
      null,
      2,
    ),
  );
}
