/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/snd_linux.c (GNU GPL v2 or later): the five
"SYSTEM SPECIFIC FUNCTIONS" sound.h declares (four of which survive this
port's scope -- see sound.ts's own header on why `SNDDMA_BeginPainting` is
not one of them), replaced with SDL2's push-mode audio queue instead of
/dev/dsp's mmap'd OSS ring, per PORTING.md's one-bun-implementation rule.
Adapted from ../quake-2-ts/src/platform/snd.ts's SDL-queue shape, simplified
because this port's `SndDma`/`DmaT` (sound.ts) has no null-driver fallback to
support -- see the deviation note below on why.

Deviations from PORTING.md / the C source:
- snd_linux.c opens `/dev/dsp` and, on failure, `return 0` before `shm = &sn`
  is ever assigned (S_Startup then leaves `sound_started = 0`). This file
  preserves that exact contract: SNDDMA_Init returns `false` (and never calls
  `setShm`) if SDLSND_Open fails, rather than quake-2-ts's own template,
  which invents a simulated-clock "null driver" so a headless boot still
  reports sound as started. That divergence exists there because q2's own
  snd.ts is asked to make S_StartSound/S_Update's pacing math exercisable
  with no device at all; this port's brief only asks that "SNDDMA_Init under
  the dummy audio driver fills sn and GetDMAPos advances after Submit" --
  SDL's own "dummy" audio driver (SDL_AUDIODRIVER=dummy) opens successfully
  through SDL_OpenAudioDevice like any other driver, so that contract is met
  without a second code path, and dedicated servers never call SNDDMA_Init at
  all (host.ts gates `hostClientHooks.sInit` behind `!sysState.isDedicated`).
- `-sndbits`/`-sndspeed`/`-sndmono`/`-sndstereo` are command-line parms
  (`COM_CheckParm`), exactly as snd_linux.c reads them -- not cvars (this
  port has no `s_khz`-style cvar; that is quake-2-ts's own addition). The
  `QUAKE_SOUND_SAMPLEBITS`/`_SPEED`/`_CHANNELS` environment-variable
  overrides snd_linux.c also checks have no equivalent here and are dropped
  (undocumented debug knobs with no other reader in this port).
- snd_linux.c's `tryrates[] = {11025, 22051, 44100, 8000}` loop (probe the
  OSS device with each rate via `ioctl(SNDCTL_DSP_SPEED)` until one is
  accepted) has no SDL equivalent: `SDL_OpenAudioDevice`'s `desired` spec
  is a single requested rate, and its `obtained` spec reports whatever the
  driver actually gave back (mirrored into `sn.speed` below, exactly as
  snd_linux.c copies `shm->speed = tryrates[i]` after its own ioctl
  succeeds). Requesting 11025 (the C loop's first, and typically only,
  candidate that any real OSS driver of that era accepted) and trusting
  `obtained.freq` is this file's equivalent.
- `SNDDMA_Submit`'s ring-read-and-queue loop, `SNDDMA_GetDMAPos`'s
  consumed-bytes math, and the `0x10000`-byte ring size are carried over
  unchanged from quake-2-ts's own snd.ts (there is no OSS/mmap equivalent to
  port instead -- see that file's own header for the reasoning); this port's
  own contribution is only re-pointing every read/write at `sound.ts`'s
  `sn`/`setShm`/`paintedtime` instead of `snd_loc.ts`'s `dma`.
- snd_linux.c's `SNDDMA_Submit` is a literal no-op (the mmap'd OSS buffer is
  read directly by the hardware; there is nothing to "send"). This file's
  `SNDDMA_Submit` is NOT a no-op: it is what actually pushes painted samples
  into SDL's queue, playing the mmap'd-hardware role snd_linux.c never
  needed a software equivalent for. Documented rather than silently
  diverging from "the C's body is empty".
*/

import { COM_CheckParm, Q_atoi, com_argv } from "../common/common";
import { sn, setShm, paintedtime, sndDma, type SndDma } from "../client/sound";
import { SDLSND_Active, SDLSND_Close, SDLSND_ConsumedBytes, SDLSND_Open, SDLSND_Queue } from "./sdl";

// 0x10000 bytes: the same fixed ring size DirectSound's secondary buffer
// used in quake-2-ts's win32/snd_win.c-derived snd.ts. At samplebits=16
// that's 32768 interleaved samples, a power of two, which
// SNDDMA_Submit's `sn.samples - 1` ring mask requires.
const RING_BUFFER_BYTES = 0x10000;

let initialized = false;
let submitted = 0; // paintedtime (sample frames) of everything already handed to the device

function pickSamplebits(): number {
  const i = COM_CheckParm("-sndbits");
  if (i) {
    const v = Q_atoi(com_argv[i + 1]);
    if (v === 16 || v === 8) return v;
  }
  return 16;
}

function pickSpeed(): number {
  const i = COM_CheckParm("-sndspeed");
  if (i) return Q_atoi(com_argv[i + 1]);
  return 11025; // snd_linux.c's tryrates[0] -- see file header
}

function pickChannels(): number {
  if (COM_CheckParm("-sndmono")) return 1;
  if (COM_CheckParm("-sndstereo")) return 2;
  return 2; // snd_linux.c's own default when neither parm is given
}

export function SNDDMA_Init(): boolean {
  submitted = 0;

  const channels = pickChannels();
  const samplebits = pickSamplebits();
  const speed = pickSpeed();

  const obtained = SDLSND_Open(speed, channels, samplebits);
  if (!obtained) return false; // see file header: no shm assignment on failure, matching snd_linux.c's early `return 0`

  sn.splitbuffer = false;
  sn.channels = obtained.channels;
  sn.samplebits = samplebits;
  sn.speed = obtained.freq;
  sn.samples = (RING_BUFFER_BYTES / (sn.samplebits / 8)) | 0;
  sn.submission_chunk = 1;
  sn.buffer = new Uint8Array(RING_BUFFER_BYTES);
  sn.samplepos = 0;
  sn.gamealive = true;
  sn.soundalive = true;

  setShm(sn); // snd_linux.c: `shm = &sn;`

  initialized = true;
  return true;
}

function bytesPerFrame(): number {
  return sn.channels * (sn.samplebits / 8);
}

export function SNDDMA_GetDMAPos(): number {
  if (!initialized || !SDLSND_Active()) return 0;

  const framesPlayed = Math.floor(SDLSND_ConsumedBytes() / bytesPerFrame());
  sn.samplepos = (framesPlayed * sn.channels) % sn.samples;
  return sn.samplepos;
}

export function SNDDMA_Shutdown(): void {
  initialized = false;
  submitted = 0;
  SDLSND_Close();
  sn.buffer = null;
  sn.gamealive = false;
  sn.soundalive = false;
  setShm(null);
}

/*
See file header: snd_linux.c's own SNDDMA_Submit is empty (the mmap'd OSS
buffer is read by the hardware directly); this is the real "hand the newly
painted span to the device" implementation a queue-based backend needs.
*/
export function SNDDMA_Submit(): void {
  if (!initialized || !SDLSND_Active() || sn.buffer === null) return;

  const frameBytes = bytesPerFrame();
  const totalFrames = sn.samples / sn.channels;

  // paintedtime went backwards (S_Init/S_StopAllSounds reset it), or the gap
  // exceeds one ring (a restart resynced paintedtime past what the old
  // cursor ever saw): resync and send NOTHING stale, rather than pinning a
  // permanent ring's worth of latency onto every subsequent sound.
  if (paintedtime < submitted) submitted = paintedtime;
  if (paintedtime - submitted > totalFrames) submitted = paintedtime;

  let frames = paintedtime - submitted;
  if (frames <= 0) return;

  let offset = ((submitted * sn.channels) & (sn.samples - 1)) * (sn.samplebits / 8);
  while (frames > 0) {
    const framesToEnd = Math.min(frames, (RING_BUFFER_BYTES - offset) / frameBytes);
    const length = framesToEnd * frameBytes;
    SDLSND_Queue(sn.buffer.subarray(offset, offset + length));
    frames -= framesToEnd;
    offset = 0;
  }

  submitted = paintedtime;
}

const sndDmaImpl: SndDma = { SNDDMA_Init, SNDDMA_GetDMAPos, SNDDMA_Shutdown, SNDDMA_Submit };
sndDma.current = sndDmaImpl;
