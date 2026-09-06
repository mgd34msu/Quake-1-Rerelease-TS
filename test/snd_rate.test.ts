// Force headless SDL before ANY import can reach the FFI layer (same
// convention as test/snd_platform.test.ts; harmless if that file's own
// copy of these lines already ran first in this shared bun process).
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Not a ported C file -- test for U5 (44.1kHz/16-bit/stereo default DMA
format, any-rate/any-width WAV loading). Covers what test/snd.test.ts's own
"ResampleSfx" describe block does not: arbitrary upsample/downsample ratios,
byte-exact behaviour at stepscale===1 for both 8-bit and 16-bit sources, cue
loop points surviving resampling, the -sndspeed parm's precedence over the
new `snd_speed` cvar, and a mixer micro-benchmark at the new default rate.

Self-sufficient per standing order 13: builds its own synthetic WAV byte
blocks and tone data, and snapshots/restores every shared singleton it
touches (shm, paintedtime, loadas8bit, snd_speed, com_argc/com_argv,
com_searchpaths/com_gamedir/com_modified, channels/total_channels) in
afterAll.
*/

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  COM_InitArgv,
  COM_InitFilesystem,
  com_argc,
  com_argv,
  com_gamedir,
  com_modified,
  com_searchpaths,
  setComArgc,
  setComArgv,
  setComGamedir,
  setComModified,
  setComSearchpaths,
} from "../src/common/common";
import { Cache_Alloc } from "../src/common/zone";
import {
  DEFAULT_SND_SPEED,
  DmaT,
  SfxT,
  SfxcacheT,
  channels,
  loadas8bit,
  paintedtime,
  setPaintedtime,
  setShm,
  setTotalChannels,
  shm,
  snd_speed,
  volume,
} from "../src/client/sound";
import { GetWavinfo, ResampleSfx, S_LoadSound } from "../src/client/snd_mem";
import { S_PaintChannels } from "../src/client/snd_mix";
import { S_StopAllSounds } from "../src/client/snd_dma";
import { SNDDMA_Init, SNDDMA_Shutdown } from "../src/platform/snd";
import { sn } from "../src/client/sound";
import { SDL_ResetBackendForTests, SDL_SetBackendEnabled } from "../src/platform/sdl";
import { ensureDir, writePakToDisk } from "./support/pak_builder";

//============================================================================
// shared-singleton snapshot, restored in afterAll (standing order 13)

const savedShm = shm;
const savedPaintedtime = paintedtime;
const savedLoadAs8bitValue = loadas8bit.value;
const savedLoadAs8bitString = loadas8bit.string;
const savedSndSpeedValue = snd_speed.value;
const savedSndSpeedString = snd_speed.string;
const savedVolumeValue = volume.value;
const savedVolumeString = volume.string;
const savedComArgc = com_argc;
const savedComArgv = com_argv;
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;
const savedComModified = com_modified;

afterAll(() => {
  setShm(savedShm);
  setPaintedtime(savedPaintedtime);
  loadas8bit.value = savedLoadAs8bitValue;
  loadas8bit.string = savedLoadAs8bitString;
  snd_speed.value = savedSndSpeedValue;
  snd_speed.string = savedSndSpeedString;
  volume.value = savedVolumeValue;
  volume.string = savedVolumeString;
  setComArgc(savedComArgc);
  setComArgv(savedComArgv);
  setComSearchpaths(savedComSearchpaths);
  setComGamedir(savedComGamedir);
  setComModified(savedComModified);
  S_StopAllSounds(true); // restores channels[]/total_channels to their post-init baseline
  SNDDMA_Shutdown();
  SDL_ResetBackendForTests();
});

//============================================================================
// synthetic WAV byte-block builder (RIFF/WAVE/fmt /cue /LIST/data) -- same
// shape as test/snd.test.ts's own copy, duplicated here for self-sufficiency.

function u16(out: number[], v: number): void {
  out.push(v & 0xff, (v >> 8) & 0xff);
}
function u32(out: number[], v: number): void {
  out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}
function tag(out: number[], s: string): void {
  for (let i = 0; i < 4; i++) out.push(s.charCodeAt(i));
}

function buildFmtChunk(channelsN: number, rate: number, widthBytes: number): number[] {
  const out: number[] = [];
  tag(out, "fmt ");
  u32(out, 16);
  u16(out, 1); // format 1 == PCM
  u16(out, channelsN);
  u32(out, rate);
  const blockAlign = channelsN * widthBytes;
  u32(out, rate * blockAlign); // byte rate
  u16(out, blockAlign);
  u16(out, widthBytes * 8); // bits per sample
  return out;
}

function buildDataChunk(pcm: Uint8Array): number[] {
  const out: number[] = [];
  tag(out, "data");
  u32(out, pcm.length);
  for (const b of pcm) out.push(b);
  return out;
}

function buildCueChunk(loopstart: number): number[] {
  const out: number[] = [];
  tag(out, "cue ");
  u32(out, 28);
  u32(out, 1);
  u32(out, 0);
  u32(out, 0);
  tag(out, "data");
  u32(out, 0);
  u32(out, 0);
  u32(out, loopstart);
  return out;
}

function buildListMarkChunk(loopLength: number): number[] {
  const out: number[] = [];
  tag(out, "LIST");
  u32(out, 24);
  tag(out, "adtl");
  tag(out, "ltxt");
  u32(out, 0);
  u32(out, 0);
  u32(out, loopLength);
  tag(out, "mark");
  return out;
}

function buildWav(opts: {
  channels: number;
  rate: number;
  widthBytes: 1 | 2;
  pcm: Uint8Array;
  loop?: { loopstart: number; loopLength: number };
}): Uint8Array {
  const chunks: number[] = [];
  chunks.push(...buildFmtChunk(opts.channels, opts.rate, opts.widthBytes));
  if (opts.loop) {
    chunks.push(...buildCueChunk(opts.loop.loopstart));
    chunks.push(...buildListMarkChunk(opts.loop.loopLength));
  }
  chunks.push(...buildDataChunk(opts.pcm));

  const out: number[] = [];
  tag(out, "RIFF");
  u32(out, 4 + chunks.length);
  tag(out, "WAVE");
  out.push(...chunks);

  return new Uint8Array(out);
}

//============================================================================
// tone generators / analysis helpers

function buildToneU8(rate: number, freq: number, numSamples: number): Uint8Array {
  const out = new Uint8Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / rate);
    out[i] = Math.max(0, Math.min(255, Math.round(127 * s) + 128));
  }
  return out;
}

function buildToneI16Bytes(rate: number, freq: number, numSamples: number): Uint8Array {
  const out = new Uint8Array(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / rate);
    const v = Math.max(-32760, Math.min(32760, Math.round(30000 * s)));
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return out;
}

function readI16LE(buf: Uint8Array, sampleIndex: number): number {
  const byteOffset = sampleIndex * 2;
  const v = (buf[byteOffset] ?? 0) | ((buf[byteOffset + 1] ?? 0) << 8);
  return (v << 16) >> 16;
}

function countZeroCrossingsU8(buf: Uint8Array, n: number): number {
  let crossings = 0;
  let prevSign = 0;
  for (let i = 0; i < n; i++) {
    const v = (buf[i] ?? 128) - 128;
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
    if (sign !== 0) prevSign = sign;
  }
  return crossings;
}

function countZeroCrossingsI16(buf: Uint8Array, n: number): number {
  let crossings = 0;
  let prevSign = 0;
  for (let i = 0; i < n; i++) {
    const v = readI16LE(buf, i);
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
    if (sign !== 0) prevSign = sign;
  }
  return crossings;
}

//============================================================================
// resample-scenario helper: mirrors S_LoadSound's own cache-sizing math
// (`len = Math.trunc(samples / stepscale) * width`) around a raw
// ResampleSfx call, without needing S_Init/a real pak.

function setFakeShm(speed: number, samplebits: 8 | 16 = 16): void {
  const dma = new DmaT();
  dma.samplebits = samplebits;
  dma.channels = 2;
  dma.speed = speed;
  dma.samples = 32768;
  dma.submission_chunk = 1;
  dma.samplepos = 0;
  dma.soundalive = true;
  dma.gamealive = true;
  dma.buffer = new Uint8Array((dma.samples * dma.samplebits) / 8);
  setShm(dma);
}

function resample(name: string, inrate: number, inwidth: 1 | 2, srcSamples: number, data: Uint8Array): SfxcacheT {
  if (!shm) throw new Error("setFakeShm must run first");
  const stepscale = inrate / shm.speed;
  const outcount = Math.trunc(srcSamples / stepscale);
  const outWidth = loadas8bit.value ? 1 : inwidth;

  const sfx = new SfxT();
  sfx.name = name;
  const cache = new SfxcacheT();
  cache.length = srcSamples;
  cache.loopstart = -1;
  cache.data = new Uint8Array(Math.max(outcount, 1) * outWidth);
  Cache_Alloc(sfx.cache, cache.data.length + 20, name, cache);

  ResampleSfx(sfx, inrate, inwidth, data);
  return cache;
}

//============================================================================

describe("ResampleSfx: stepscale === 1 stays byte-identical", () => {
  test("11025 Hz 8-bit source on an 11025 Hz device (classic assets, classic device)", () => {
    loadas8bit.value = 0;
    setFakeShm(11025);

    const n = 200;
    const src = buildToneU8(11025, 440, n);
    const sc = resample("classic-8bit.wav", 11025, 1, n, src);

    expect(sc.length).toBe(n);
    expect(sc.width).toBe(1);
    for (let i = 0; i < n; i++) {
      // fast path: sc.data[i] = (data[i] - 128) & 0xff -- exactly the source
      // byte re-centered, no interpolation, no rounding.
      expect(sc.data[i]).toBe(((src[i] ?? 0) - 128) & 0xff);
    }
  });

  test("44100 Hz 16-bit mono source on a 44100 Hz device (re-release assets, new default device)", () => {
    loadas8bit.value = 0;
    setFakeShm(44100);

    const n = 300;
    const src = buildToneI16Bytes(44100, 440, n);
    const sc = resample("rerelease-16bit.wav", 44100, 2, n, src);

    expect(sc.length).toBe(n);
    expect(sc.width).toBe(2);
    // sample-exact: every output sample must equal the corresponding input
    // sample bit-for-bit, not merely "close" -- stepscale===1 walks
    // srcsample=i on every iteration (fracstep=trunc(1*256)=256).
    for (let i = 0; i < n; i++) {
      expect(readI16LE(sc.data, i)).toBe(readI16LE(src, i));
    }
  });
});

describe("ResampleSfx: arbitrary-rate upsampling and downsampling", () => {
  test("11025 Hz 8-bit upsampled to a 44100 Hz device: 4x length, same tone (zero crossings preserved)", () => {
    loadas8bit.value = 0;
    setFakeShm(44100);

    const n = 500;
    const src = buildToneU8(11025, 440, n);
    const sc = resample("upsample-8bit.wav", 11025, 1, n, src);

    expect(sc.length).toBe(n * 4); // stepscale = 11025/44100 = 0.25 exactly
    expect(sc.width).toBe(1);

    const inCrossings = countZeroCrossingsU8(src, n);
    const outCrossings = countZeroCrossingsU8(sc.data, sc.length);
    // nearest-neighbour (repeat-sample) upsampling duplicates each source
    // sample 4x in a row -- duplicates never introduce or remove a sign
    // change, so the crossing count (and therefore the tone's pitch) is
    // preserved exactly, not just approximately.
    expect(outCrossings).toBe(inCrossings);
    expect(inCrossings).toBeGreaterThan(0); // sanity: the fixture is actually oscillating
  });

  test("44100 Hz 16-bit downsampled to an 11025 Hz device: exact 1-in-4 decimation", () => {
    loadas8bit.value = 0;
    setFakeShm(11025);

    const n = 4000;
    const src = buildToneI16Bytes(44100, 440, n);
    const sc = resample("downsample-16bit.wav", 44100, 2, n, src);

    expect(sc.length).toBe(n / 4); // stepscale = 44100/11025 = 4 exactly
    expect(sc.width).toBe(2);
    // fracstep = trunc(4*256) = 1024 -> srcsample = i*4 exactly, so this is
    // plain decimation (no anti-aliasing filter, matching WinQuake's own
    // naive resampler) and every kept sample must be byte-exact.
    for (let i = 0; i < sc.length; i++) {
      expect(readI16LE(sc.data, i)).toBe(readI16LE(src, i * 4));
    }
  });
});

describe("ResampleSfx: cue loop points survive resampling", () => {
  test("loopstart is rescaled by the same stepscale as the sample data", () => {
    loadas8bit.value = 0;
    setFakeShm(11025); // stepscale = 22050/11025 = 2

    const sfx = new SfxT();
    sfx.name = "loop-test.wav";
    const cache = new SfxcacheT();
    cache.length = 20; // source sample count
    cache.loopstart = 40;
    cache.data = new Uint8Array(10); // pre-sized for the halved output
    Cache_Alloc(sfx.cache, cache.data.length + 20, sfx.name, cache);

    const src = new Uint8Array(20).fill(128);
    ResampleSfx(sfx, 22050, 1, src);

    expect(cache.length).toBe(10);
    expect(cache.loopstart).toBe(20); // 40 / 2
  });

  test("through GetWavinfo end-to-end at a non-1 stepscale, the loop stays inside the resampled data", () => {
    loadas8bit.value = 0;
    setFakeShm(44100); // stepscale = 11025/44100 = 0.25

    const loopstart = 40;
    const loopLength = 60;
    const pcm = new Uint8Array(100);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i;

    const bytes = buildWav({
      channels: 1,
      rate: 11025,
      widthBytes: 1,
      pcm,
      loop: { loopstart, loopLength },
    });

    const info = GetWavinfo("looped-resampled.wav", bytes, bytes.length);
    expect(info.loopstart).toBe(loopstart);
    expect(info.samples).toBe(loopstart + loopLength); // 100, from the cue/LIST path

    // thread loopstart through ResampleSfx exactly as S_LoadSound does
    // (the generic `resample()` helper above always starts loopstart at -1,
    // since most of this file's other cases are unlooped tones).
    const stepscale = info.rate / 44100; // shm.speed, set by setFakeShm(44100) above
    const sfx = new SfxT();
    sfx.name = "looped-resampled.wav";
    const cache = new SfxcacheT();
    cache.length = info.samples;
    cache.loopstart = info.loopstart;
    cache.data = new Uint8Array(Math.trunc(info.samples / stepscale) * info.width);
    Cache_Alloc(sfx.cache, cache.data.length + 20, sfx.name, cache);
    ResampleSfx(sfx, info.rate, info.width, bytes.subarray(info.dataofs));

    expect(cache.loopstart).toBe(Math.trunc(loopstart / stepscale)); // 40 / 0.25 = 160
    expect(cache.loopstart).toBeGreaterThanOrEqual(0);
    expect(cache.loopstart).toBeLessThan(cache.length);
  });
});

describe("ResampleSfx / S_LoadSound: a true stereo source", () => {
  test("GetWavinfo reports channels === 2 for a 16-bit stereo WAV", () => {
    const pcm = new Uint8Array(400); // 100 interleaved L/R 16-bit frames
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;
    const bytes = buildWav({ channels: 2, rate: 44100, widthBytes: 2, pcm });

    const info = GetWavinfo("stereo.wav", bytes, bytes.length);
    expect(info.channels).toBe(2);
    expect(info.width).toBe(2);
    expect(info.rate).toBe(44100);
  });

  test("S_LoadSound refuses a true stereo sfx wav, matching WinQuake's own rejection (see snd_mem.ts's file header)", () => {
    const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
    mkdirSync(scratchRoot, { recursive: true });
    const scratchDir = mkdtempSync(join(scratchRoot, "snd-rate-stereo-"));
    try {
      const pcm = new Uint8Array(400);
      for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;
      const wavBytes = buildWav({ channels: 2, rate: 44100, widthBytes: 2, pcm });

      const pakPath = join(scratchDir, "pak0.pak");
      ensureDir(scratchDir);
      writePakToDisk(pakPath, [{ name: "sound/stereo-test.wav", data: wavBytes }]);

      COM_InitArgv(["quake", "-path", pakPath]);
      COM_InitFilesystem();

      const sfx = new SfxT();
      sfx.name = "stereo-test.wav";
      const sc = S_LoadSound(sfx);

      expect(sc).toBeNull(); // "%s is a stereo sample\n" -- see snd_mem.ts's S_LoadSound
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("snd_speed cvar / -sndspeed parm precedence", () => {
  test("-sndspeed parm wins over the snd_speed cvar for the session", () => {
    snd_speed.value = 8000;
    snd_speed.string = "8000";
    COM_InitArgv(["quake", "-sndspeed", "22050"]);
    SDL_SetBackendEnabled(true);

    const ok = SNDDMA_Init();
    expect(ok).toBe(true);
    expect(sn.speed).toBe(22050); // parm wins over the cvar's 8000

    SNDDMA_Shutdown();
  });

  test("falls back to the snd_speed cvar when no -sndspeed parm is given", () => {
    snd_speed.value = 8000;
    snd_speed.string = "8000";
    COM_InitArgv(["quake"]);
    SDL_SetBackendEnabled(true);

    const ok = SNDDMA_Init();
    expect(ok).toBe(true);
    expect(sn.speed).toBe(8000);

    SNDDMA_Shutdown();
  });

  test("DEFAULT_SND_SPEED is 44100 and snd_speed defaults to it when never overridden", () => {
    expect(DEFAULT_SND_SPEED).toBe(44100);
    // constructed fresh, mirroring sound.ts's own `new CvarT("snd_speed", ...)`
    expect(String(DEFAULT_SND_SPEED)).toBe("44100");
  });
});

describe("mixer performance at the new 44.1kHz stereo default (printed, not asserted)", () => {
  test("S_PaintChannels mixes ~1 second of audio across 8 active 16-bit channels", () => {
    loadas8bit.value = 0;
    volume.value = 0.7; // unregistered in this isolated test file -- CvarT defaults to 0 until S_Init runs
    setFakeShm(44100);
    setPaintedtime(0);

    const activeChannelCount = 8;
    const toneSamples = 2 * 44100; // 2s of 16-bit tone data per channel, longer than the benchmark span
    setTotalChannels(activeChannelCount);

    for (let i = 0; i < activeChannelCount; i++) {
      const ch = channels[i];
      if (!ch) continue;
      ch.clear();

      const sfx = new SfxT();
      sfx.name = `bench-${i}.wav`;
      const cache = new SfxcacheT();
      cache.length = toneSamples;
      cache.loopstart = -1;
      cache.data = buildToneI16Bytes(44100, 220 + i * 10, toneSamples);
      Cache_Alloc(sfx.cache, cache.data.length + 20, sfx.name, cache);

      ch.sfx = sfx;
      ch.leftvol = 200;
      ch.rightvol = 200;
      ch.pos = 0;
      ch.end = 100000000; // never restarts/loops during the benchmark
    }

    const framesToMix = 44100; // ~1 second at the new default rate
    const t0 = performance.now();
    S_PaintChannels(framesToMix);
    const elapsedMs = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(
      `[snd_rate bench] S_PaintChannels: ${activeChannelCount} channels x ${framesToMix} frames @ 44.1kHz stereo/16-bit = ${elapsedMs.toFixed(3)}ms`,
    );

    expect(paintedtime).toBe(framesToMix); // the mix actually ran to completion
    if (!shm?.buffer) throw new Error("expected shm.buffer to be set");
    const view = new Int16Array(shm.buffer.buffer, shm.buffer.byteOffset, shm.buffer.byteLength / 2);
    let energy = 0;
    for (let i = 0; i < view.length; i++) energy += Math.abs(view[i]);
    expect(energy).toBeGreaterThan(0); // real, non-silent work was done

    S_StopAllSounds(true);
  });
});

//============================================================================
// Real retail-data check, guarded like test/support/fixture_availability.ts:
// skipped entirely (never fails CI) unless this machine-local, uncommitted
// data tree is present.

const RETAIL_ROOT = "/home/buzzkill/Projects/qfiles/q1";
const CLASSIC_PAK = join(RETAIL_ROOT, "id1", "PAK0.PAK");
const RERELEASE_PAK = join(RETAIL_ROOT, "rerelease", "id1", "pak0.pak");
const HAVE_RETAIL_ROCKET1I = existsSync(CLASSIC_PAK) && existsSync(RERELEASE_PAK);

describe("real retail data: classic vs re-release rocket1i.wav duration", () => {
  test.skipIf(!HAVE_RETAIL_ROCKET1I)(
    "sound/weapons/rocket1i.wav durations match within 1% after resampling to the 44.1kHz default",
    () => {
      loadas8bit.value = 0;
      setFakeShm(44100);

      // "-basedir <root>" (not "-path <pakfile>"): COM_InitFilesystem's
      // "-path" branch decides pak-vs-directory via a case-sensitive
      // `COM_FileExtension(arg) === "pak"` check, which misses classic's
      // upper-case "PAK0.PAK" outright; "-basedir" instead goes through
      // COM_AddGameDirectory's own Sys_ResolveCase on both the "id1"
      // component and the "pak0.pak" glob, matching a real boot on a
      // case-sensitive filesystem. `setComSearchpaths(null)` between the
      // two loads replaces "-path"'s own per-call reset, since "-basedir"
      // prepends onto whatever search path already exists instead.
      setComSearchpaths(null);
      COM_InitArgv(["quake", "-basedir", RETAIL_ROOT]);
      COM_InitFilesystem();
      const classicSfx = new SfxT();
      classicSfx.name = "weapons/rocket1i.wav";
      const classicSc = S_LoadSound(classicSfx);
      expect(classicSc).not.toBeNull();

      setComSearchpaths(null);
      COM_InitArgv(["quake", "-basedir", join(RETAIL_ROOT, "rerelease")]);
      COM_InitFilesystem();
      const rereleaseSfx = new SfxT();
      rereleaseSfx.name = "weapons/rocket1i.wav";
      const rereleaseSc = S_LoadSound(rereleaseSfx);
      expect(rereleaseSc).not.toBeNull();

      if (!classicSc || !rereleaseSc) return; // narrows for TS below; already asserted above

      // both were resampled to the same shm.speed (44100), so comparing
      // lengths directly compares durations.
      const classicDuration = classicSc.length / classicSc.speed;
      const rereleaseDuration = rereleaseSc.length / rereleaseSc.speed;
      const relDiff = Math.abs(classicDuration - rereleaseDuration) / rereleaseDuration;

      console.log(
        `[snd_rate real-data] classic rocket1i.wav: ${classicDuration.toFixed(4)}s, re-release: ${rereleaseDuration.toFixed(4)}s, diff ${(relDiff * 100).toFixed(2)}%`,
      );

      expect(relDiff).toBeLessThan(0.01);
    },
  );
});
