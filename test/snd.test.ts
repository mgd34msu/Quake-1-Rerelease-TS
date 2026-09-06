/*
Not a ported C file -- test for U054 (sound.ts/snd_dma.ts/snd_mem.ts/snd_mix.ts).

Self-sufficient per standing order 13: builds its own scratch `-path` pak
fixture (test/support/pak_builder.ts) and its own synthetic WAV byte blocks,
and registers a fake `SndDma` driver directly (no src/platform/snd.ts exists
yet -- that is unit U056). Every process-wide flag this file touches
(cmdHost.initialized, sndDma.current, host_parms.memsize, cl.viewentity) is
captured before and restored in afterAll, since `bun test` runs every file
in one process (test/main_boot.test.ts's own header note).
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, host_parms } from "../src/common/common";
import { cmdHost, Cmd_Exists } from "../src/common/cmd";
import { Cvar_FindVar } from "../src/common/cvar";
import { Cache_Alloc, Cache_Check } from "../src/common/zone";
import { DotProduct, vec3, VectorNormalize, type Vec3 } from "../src/common/mathlib";
import { cl } from "../src/client/client";
import {
  ChannelT,
  DmaT,
  MAX_CHANNELS,
  MAX_DYNAMIC_CHANNELS,
  NUM_AMBIENTS,
  SfxT,
  SfxcacheT,
  channels,
  listener_origin,
  listener_right,
  paintedtime,
  setShm,
  setTotalChannels,
  shm,
  sndDma,
  total_channels,
  type SndDma,
} from "../src/client/sound";
import {
  S_FindName,
  S_Init,
  S_StartSound,
  S_StaticSound,
  S_StopAllSounds,
  S_Update_,
  SND_Spatialize,
  sound_started,
} from "../src/client/snd_dma";
import { GetWavinfo, ResampleSfx, S_LoadSound } from "../src/client/snd_mem";
import { SND_InitScaletable, Snd_WriteLinearBlastStereo16, snd_scaletable } from "../src/client/snd_mix";
import { ensureDir, writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "snd-test-"));

//============================================================================
// synthetic WAV byte-block builder (RIFF/WAVE/fmt /cue /LIST/data), built by
// hand rather than imported since this is test-only infrastructure with no
// C source of its own.

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

// one cue point; dwSampleOffset (at tag-relative offset 32) is what
// GetWavinfo reads as `loopstart`.
function buildCueChunk(loopstart: number): number[] {
  const out: number[] = [];
  tag(out, "cue ");
  u32(out, 28); // dwCuePoints(4) + one 24-byte cue point
  u32(out, 1); // dwCuePoints
  u32(out, 0); // dwName
  u32(out, 0); // dwPosition
  tag(out, "data"); // fccChunk
  u32(out, 0); // dwChunkStart
  u32(out, 0); // dwBlockStart
  u32(out, loopstart); // dwSampleOffset
  return out;
}

// Shaped so GetWavinfo's cooledit-specific probe matches: tag-relative byte
// 24 holds the loop-length int32, byte 28 holds "mark".
function buildListMarkChunk(loopLength: number): number[] {
  const out: number[] = [];
  tag(out, "LIST");
  u32(out, 24); // chunk data length
  tag(out, "adtl");
  tag(out, "ltxt"); // filler, unread by GetWavinfo
  u32(out, 0); // filler
  u32(out, 0); // filler
  u32(out, loopLength); // tag-relative offset 24
  tag(out, "mark"); // tag-relative offset 28
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
  u32(out, 4 + chunks.length); // "WAVE" + all chunks
  tag(out, "WAVE");
  out.push(...chunks);

  return new Uint8Array(out);
}

//============================================================================
// fake SndDma driver (src/platform/snd.ts, U056, does not exist yet)

const FAKE_SAMPLES = 8192; // mono sample slots (4096 stereo frames)
const FAKE_DMA_ADVANCE = 1024;
let fakeDmaPos = 0;

const fakeSndDma: SndDma = {
  SNDDMA_Init(): boolean {
    fakeDmaPos = 0;
    return true;
  },
  SNDDMA_GetDMAPos(): number {
    fakeDmaPos = (fakeDmaPos + FAKE_DMA_ADVANCE) % FAKE_SAMPLES;
    return fakeDmaPos;
  },
  SNDDMA_Shutdown(): void {},
  SNDDMA_Submit(): void {},
};

// This unit's `SndDma` interface only returns a boolean from SNDDMA_Init
// (see sound.ts's file header on why `shm`/`sn` are not part of the
// interface); this fake driver fills `shm` itself the way a real platform
// driver would, by calling sound.ts's setter directly.
function installFakeDriver(): void {
  const dma = new DmaT();
  dma.samplebits = 16;
  dma.channels = 2;
  dma.speed = 11025;
  dma.samples = FAKE_SAMPLES;
  dma.submission_chunk = 1;
  dma.samplepos = 0;
  dma.soundalive = true;
  dma.gamealive = true;
  dma.buffer = new Uint8Array((dma.samples * dma.samplebits) / 8);
  setShm(dma);
}

//============================================================================
// filesystem fixture: one pak with "sound/test.wav" (plain 8-bit mono
// 11025 Hz, matching the fake driver's shm.speed so ResampleSfx's fast path
// runs with stepscale === 1)

// long enough to still be playing after S_Update_'s first GetSoundtime()
// jump (paintedtime catches up to whatever the fake driver's first
// SNDDMA_GetDMAPos() implies, which can be well past a very short sound's
// end -- see the "picks a channel and paints" test below).
const TEST_WAV_SAMPLES = 4000;
const testWavPcm = new Uint8Array(TEST_WAV_SAMPLES);
for (let i = 0; i < TEST_WAV_SAMPLES; i++) testWavPcm[i] = i; // arbitrary, non-silent values (wraps as a byte)

const testWavBytes = buildWav({ channels: 1, rate: 11025, widthBytes: 1, pcm: testWavPcm });

const savedCmdInitialized = cmdHost.initialized;
const savedMemsize = host_parms.memsize;
const savedViewentity = cl.viewentity;
// src/platform/snd.ts installs the real SndDma at module load (a
// side-effect import reached through src/main.ts); this suite installs its
// own fake driver for the duration of its own tests. Hard-nulling it in
// afterAll (instead of restoring this snapshot) would permanently wipe out
// that real installation for the rest of this bun process (rule 15).
const savedSndDma = sndDma.current;

const baseDir = join(scratchDir, "snd-fs");
const pakPath = join(baseDir, "id1", "pak0.pak");

afterAll(() => {
  cmdHost.initialized = savedCmdInitialized;
  host_parms.memsize = savedMemsize;
  cl.viewentity = savedViewentity;
  sndDma.current = savedSndDma;
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writePakToDisk(pakPath, [{ name: "sound/test.wav", data: testWavBytes }]);
});

// This unit registers hostClientHooks.sShutdown = S_Shutdown (correctly --
// it is how a real Host_Shutdown reaches this module). Other test files in
// this shared bun process legitimately call the real Host_Shutdown()
// (test/main_boot.test.ts does, twice), which now also resets THIS module's
// sound_started/shm to their shutdown state as a side effect, since bun
// runs every file in one process -- and bun's test scheduler does not
// guarantee that another file's test cannot run between this file's own
// `beforeEach` and its `test` callback. So this is called as the FIRST
// LINE of every test body below (one synchronous call, not a separate
// lifecycle hook), guaranteeing setup and assertions happen inside the same
// uninterruptible synchronous callback -- self-sufficient per standing
// order 13, extended here to also survive a sibling file's legitimate use
// of the shared hostClientHooks wiring.
function resetSoundState(): void {
  // `-path <pakfile>` (rather than `-basedir`) so COM_InitFilesystem resets
  // com_searchpaths to just this one pak every call (common.ts's own
  // ruling: "-path" is the one argv flag that clears the list first) instead
  // of prepending a fresh "id1" dir + re-opened pak0.pak on top of whatever
  // 12 earlier calls in this file already left there.
  COM_InitArgv(["quake", "-path", pakPath]);
  COM_InitFilesystem();

  // >= 0x800000 so S_Init does not force loadas8bit to "1" as a side effect
  // (this file wants to control that cvar explicitly per test).
  host_parms.memsize = 0x1000000;

  cmdHost.initialized = false; // a previous suite in this process may have set it (see main_boot.test.ts)

  sndDma.current = fakeSndDma;
  installFakeDriver(); // sndDma.current.SNDDMA_Init() would only return a boolean; fill shm the way a real driver does

  S_Init();
}

//============================================================================

describe("S_Init", () => {
  test("registers the cvars/commands and marks sound_started", () => {
    resetSoundState();

    expect(sound_started).toBe(1);

    expect(Cvar_FindVar("volume")).not.toBeNull();
    expect(Cvar_FindVar("bgmvolume")).not.toBeNull();
    expect(Cvar_FindVar("loadas8bit")).not.toBeNull();
    expect(Cvar_FindVar("_snd_mixahead")?.value).toBeCloseTo(0.1, 5);

    expect(Cmd_Exists("play")).toBe(true);
    expect(Cmd_Exists("playvol")).toBe(true);
    expect(Cmd_Exists("stopsound")).toBe(true);
    expect(Cmd_Exists("soundlist")).toBe(true);
    expect(Cmd_Exists("soundinfo")).toBe(true);

    expect(shm).not.toBeNull();
    expect(shm?.samplebits).toBe(16);
    expect(shm?.channels).toBe(2);
    expect(shm?.speed).toBe(11025);
  });
});

describe("GetWavinfo", () => {
  test("8-bit mono 11025 Hz WAV with a cue/LIST loop yields samples/loopstart/width", () => {
    resetSoundState();

    const pcm = new Uint8Array(100);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i;

    const bytes = buildWav({
      channels: 1,
      rate: 11025,
      widthBytes: 1,
      pcm,
      loop: { loopstart: 10, loopLength: 50 },
    });

    const info = GetWavinfo("looped.wav", bytes, bytes.length);

    expect(info.channels).toBe(1);
    expect(info.rate).toBe(11025);
    expect(info.width).toBe(1);
    expect(info.loopstart).toBe(10);
    expect(info.samples).toBe(60); // loopstart(10) + loopLength(50), from the cue/LIST path
  });

  test("a WAV with no cue chunk reports loopstart -1 and samples from the data chunk", () => {
    resetSoundState();

    const info = GetWavinfo("test.wav", testWavBytes, testWavBytes.length);

    expect(info.loopstart).toBe(-1);
    expect(info.samples).toBe(TEST_WAV_SAMPLES);
    expect(info.width).toBe(1);
    expect(info.channels).toBe(1);
  });
});

describe("S_LoadSound", () => {
  test("through a pak fixture caches an SfxcacheT with the resampled length", () => {
    resetSoundState();

    const sfx = S_FindName("test.wav");
    const sc = S_LoadSound(sfx);

    expect(sc).not.toBeNull();
    // shm.speed (11025) matches the WAV's own rate, so stepscale === 1 and
    // the fast resample path leaves the sample count unchanged.
    expect(sc?.length).toBe(TEST_WAV_SAMPLES);
    expect(sc?.width).toBe(1);
    expect(sc?.loopstart).toBe(-1);

    // second call hits Cache_Check and returns the same object
    const again = S_LoadSound(sfx);
    expect(again).toBe(sc);
  });
});

describe("ResampleSfx", () => {
  test("22050 -> 11025 halves the sample count and converts 8-bit to a -128 offset", () => {
    resetSoundState();

    const sfx = new SfxT();
    sfx.name = "resample-test.wav";

    const cacheData = new SfxcacheT();
    cacheData.length = 10; // 10 samples at the source rate (22050)
    cacheData.loopstart = -1;
    cacheData.data = new Uint8Array(5); // pre-sized for the halved output

    Cache_Alloc(sfx.cache, 5 + 20, sfx.name, cacheData);
    expect(Cache_Check(sfx.cache)).toBe(cacheData);

    // unsigned 8-bit source samples; 128 is silence (0 after the -128 offset)
    const srcData = new Uint8Array([128, 138, 148, 158, 168, 178, 188, 198, 208, 218]);

    ResampleSfx(sfx, 22050, 1, srcData);

    expect(cacheData.length).toBe(5); // halved
    expect(cacheData.width).toBe(1);
    // fast path: sc.data[i] = data[i] - 128 (as an unsigned byte)
    expect(cacheData.data[0]).toBe((128 - 128) & 0xff);
    expect(cacheData.data[1]).toBe((148 - 128) & 0xff);
    expect(cacheData.data[2]).toBe((168 - 128) & 0xff);
  });
});

describe("SND_Spatialize", () => {
  test("gives full volume for the viewentity", () => {
    resetSoundState();

    cl.viewentity = 42;

    const ch = new ChannelT();
    ch.entnum = 42;
    ch.master_vol = 200;

    SND_Spatialize(ch);

    expect(ch.leftvol).toBe(200);
    expect(ch.rightvol).toBe(200);
  });

  test("attenuates l/r for a source to the right", () => {
    resetSoundState();

    cl.viewentity = 42;

    listener_origin[0] = 0;
    listener_origin[1] = 0;
    listener_origin[2] = 0;
    listener_right[0] = 1;
    listener_right[1] = 0;
    listener_right[2] = 0;

    const ch = new ChannelT();
    ch.entnum = 7; // not the viewentity
    ch.master_vol = 200;
    ch.origin[0] = 100; // directly to the right of the listener
    ch.origin[1] = 0;
    ch.origin[2] = 0;
    ch.dist_mult = 0.001; // dist = 100 * 0.001 = 0.1

    SND_Spatialize(ch);

    // a source directly along +listener_right pans hard right: dot === 1,
    // so lscale === 1-dot === 0 (left silent) and rscale === 1+dot === 2.
    expect(ch.leftvol).toBe(0);
    expect(ch.rightvol).toBeGreaterThan(ch.leftvol);
    expect(ch.rightvol).toBe(Math.trunc(200 * (1 - 0.1) * 2));

    // sanity-check the geometry this relies on, independent of SND_Spatialize
    const src: Vec3 = vec3(100, 0, 0);
    const dist = VectorNormalize(src);
    expect(dist).toBeCloseTo(100, 5);
    expect(DotProduct(listener_right, src)).toBeCloseTo(1, 5);
  });
});

describe("S_StartSound / S_Update_ / S_PaintChannels", () => {
  test("picks a channel and paints non-zero samples into shm.buffer", () => {
    resetSoundState();

    S_StopAllSounds(true); // baseline: total_channels back to MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS

    const sfx = S_FindName("test.wav");
    cl.viewentity = 1;

    S_StartSound(cl.viewentity, 0, sfx, listener_origin, 1.0, 1.0);

    // SND_PickChannel put it somewhere in [NUM_AMBIENTS, NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS)
    let found = false;
    for (let i = NUM_AMBIENTS; i < NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS; i++) {
      if (channels[i].sfx === sfx) found = true;
    }
    expect(found).toBe(true);

    const paintedBefore = paintedtime;
    S_Update_();
    expect(paintedtime).toBeGreaterThan(paintedBefore);

    if (!shm?.buffer) throw new Error("expected shm.buffer to be set");
    const view = new Int16Array(shm.buffer.buffer, shm.buffer.byteOffset, shm.buffer.byteLength / 2);
    let energy = 0;
    for (let i = 0; i < view.length; i++) energy += Math.abs(view[i]);
    expect(energy).toBeGreaterThan(0);
  });
});

describe("S_StopAllSounds", () => {
  test("clears every channel and resets total_channels", () => {
    resetSoundState();

    const sfx = S_FindName("test.wav");
    S_StartSound(999, 0, sfx, listener_origin, 1.0, 1.0);

    S_StopAllSounds(true);

    expect(total_channels).toBe(MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS);
    for (let i = 0; i < MAX_CHANNELS; i++) expect(channels[i].sfx).toBeNull();
  });
});

describe("S_StaticSound", () => {
  test("overflow at MAX_CHANNELS prints and returns without adding a channel", () => {
    resetSoundState();

    setTotalChannels(MAX_CHANNELS);

    const sfx = S_FindName("test.wav");
    expect(() => S_StaticSound(sfx, listener_origin, 1, 1)).not.toThrow();

    expect(total_channels).toBe(MAX_CHANNELS); // unchanged: the overflow guard returned early

    S_StopAllSounds(true); // restore baseline for any later test
  });
});

describe("SND_InitScaletable", () => {
  test("values match (signed char)j * i * 8", () => {
    resetSoundState();

    SND_InitScaletable();

    expect(snd_scaletable[0][200]).toBe(0); // row 0 is always silent
    expect(snd_scaletable[5][0]).toBe(0); // column 0 (j=0) is always silent
    expect(snd_scaletable[1][1]).toBe(1 * 1 * 8); // j <= 127: signed char == j
    expect(snd_scaletable[2][200]).toBe((200 - 256) * 2 * 8); // j > 127: signed char == j - 256
  });
});

describe("Snd_WriteLinearBlastStereo16", () => {
  test("clamps to the int16 range", () => {
    resetSoundState();

    const snd_p = new Int32Array([1000000 << 8, -1000000 << 8]); // >>8 in the function undoes this scale
    const snd_out = new Int16Array(2);

    Snd_WriteLinearBlastStereo16(snd_p, snd_out, 2, 256);

    expect(snd_out[0]).toBe(0x7fff);
    expect(snd_out[1]).toBe(-0x8000);
  });

  test("passes values inside range through unclamped", () => {
    resetSoundState();

    const snd_p = new Int32Array([100, -100]);
    const snd_out = new Int16Array(2);

    Snd_WriteLinearBlastStereo16(snd_p, snd_out, 2, 256); // vol=256 -> (100*256)>>8 == 100

    expect(snd_out[0]).toBe(100);
    expect(snd_out[1]).toBe(-100);
  });
});
