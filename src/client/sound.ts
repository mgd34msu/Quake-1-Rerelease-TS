/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/sound.h (GNU GPL v2 or later).

sound.h -- client sound i/o functions

Deviations from PORTING.md / the C source:
- DEFAULT_SOUND_PACKET_VOLUME/DEFAULT_SOUND_PACKET_ATTENUATION are declared in
  this header in the C, but the landed src/common/protocol.ts already defines
  them (sv_main.ts/cl_parse.c need the wire defaults before this unit existed)
  and its own header comment says client/sound.ts must import rather than
  redeclare them. Re-exported here so callers of this header still see them.
- `sfx_t` -> `class SfxT { name; cache }`, `cache_user_t` -> `CacheUser<SfxcacheT>`
  per PORTING.md's zone.ts ruling (Cache_Alloc(c, size, name, data)/Cache_Check).
- `sfxcache_t.data` is `byte data[1]` (a variable-sized C flexible array member,
  the sound's raw sample bytes back to back). Ruling (unit brief): kept as the
  raw byte block, `Uint8Array`, with `width` (1 or 2) telling a reader whether
  to treat it as signed 8-bit samples or little-endian signed 16-bit samples
  via a DataView -- matching the C's `(signed char *)sc->data` / `(short
  *)sc->data` casts exactly, just made explicit instead of implicit through a
  pointer cast. snd_mix.ts's SND_PaintChannelFrom8/16 are the two readers.
- `channel_t.looping`: kept for structural fidelity with the C struct, but
  grep of snd_dma.c/snd_mix.c/snd_win.c/snd_linux.c shows no reader or writer
  of `ch->looping` anywhere in this port's scope -- it is dead C state (looping
  is actually driven by `sfxcache_t.loopstart`, not this field). Never
  assigned outside the class's own default.
- `dma_t *shm` (a nullable pointer, reassigned between `null`, `&sn`, and a
  fakedma Hunk struct) and `dma_t sn` (the real-driver-backed instance the
  platform layer points `shm` at, exactly as snd_linux.c's `shm = &sn;` does)
  are both `extern` in the C header, so both live here per PORTING.md's
  header-module rule; `shm` gets a setter since it is a reassigned pointer.
  `dma_t.buffer` (`unsigned char *buffer`) is `Uint8Array | null`.
- The five SNDDMA_* platform entry points (SNDDMA_Init/GetDMAPos/Shutdown/
  Submit here, per this unit's brief; `SNDDMA_BeginPainting` has no caller
  anywhere in the v1.09 WinQuake tree per grep and is not ported) become one
  `SndDma` interface plus a `sndDma.current` holder; src/platform/snd.ts
  (U056) implements it and assigns `sndDma.current`. With no implementation
  registered, `SNDDMA_Init()` is never called and S_Startup's "no driver"
  path (`sound_started = 0`) is exactly what the C's failed
  `SNDDMA_Init()==0` branch does.
- Of sound.h's `extern` globals, this file hosts `shm`, `sn`, `paintedtime`,
  `snd_blocked`, `snd_initialized`, `channels`, `total_channels`,
  `listener_origin/forward/right/up`, `sound_nominal_clip_dist`, and the two
  `extern cvar_t` (`bgmvolume`, `volume`) plus `loadas8bit` (also `extern
  cvar_t` in the header, needed by snd_mem.ts's ResampleSfx). `fakedma` and
  `fakedma_updates` are also `extern cvar_t`-adjacent globals in the header,
  but grep of this port's scope shows no reader outside snd_dma.c itself (the
  C's only other reader, menu.c's "-simsound" perf harness, is unported), so
  they stay private module state in snd_dma.ts; hoist them here if a future
  unit needs them.
- `MAX_SFX` (snd_dma.c's own `#define`, not in sound.h) and `PAINTBUFFER_SIZE`
  (snd_mix.c's own `#define`) are collected here alongside `MAX_CHANNELS`/
  `MAX_DYNAMIC_CHANNELS` per this unit's brief, so every numeric constant the
  four files share lives in one place instead of being re-declared per file.
- `known_sfx` (a Hunk-allocated `sfx_t[MAX_SFX]` in the C) and the fakedma
  path's `shm = Hunk_AllocName(sizeof(*shm), "shm")` are NOT ported as
  `Hunk_AllocName` byte-block calls: PORTING.md's Hunk_Alloc* ruling is
  "allocate the typed array or object the caller needs", and there is no way
  to get a typed `SfxT[]`/`DmaT` out of a `Uint8Array`. This mirrors
  model.ts's `mod_known` (also a Hunk-allocated `model_t[]` in the C, ported
  as a plain array of objects with no Hunk_AllocName call). `shm.buffer`
  (a genuine byte block, `Hunk_AllocName(1<<16, "shmbuf")`) IS ported as a
  real `Hunk_AllocName` call in snd_dma.ts, since its C type already is a
  byte pointer.
*/

import { CacheUser } from "../common/zone";
import { type Vec3, vec3 } from "../common/mathlib";
import { NUM_AMBIENTS } from "../common/bspfile";
import { CvarT } from "../common/cvar";

export { DEFAULT_SOUND_PACKET_VOLUME, DEFAULT_SOUND_PACKET_ATTENUATION } from "../common/protocol";

// !!! if this is changed, it must be changed in asm_i386.h too !!!
export class PortableSamplepairT {
  left = 0;
  right = 0;
}

export class SfxT {
  name = ""; // char name[MAX_QPATH]
  cache: CacheUser<SfxcacheT> = new CacheUser<SfxcacheT>();
}

// !!! if this is changed, it must be changed in asm_i386.h too !!!
export class SfxcacheT {
  length = 0;
  loopstart = 0;
  speed = 0;
  width = 0;
  stereo = 0;
  data: Uint8Array = new Uint8Array(0); // variable sized in C (`byte data[1]`)
}

export class DmaT {
  gamealive = false;
  soundalive = false;
  splitbuffer = false;
  channels = 0;
  samples = 0; // mono samples in buffer
  submission_chunk = 0; // don't mix less than this #
  samplepos = 0; // in mono samples
  samplebits = 0;
  speed = 0;
  buffer: Uint8Array | null = null;
}

// !!! if this is changed, it must be changed in asm_i386.h too !!!
export class ChannelT {
  sfx: SfxT | null = null; // sfx number
  leftvol = 0; // 0-255 volume
  rightvol = 0; // 0-255 volume
  end = 0; // end time in global paintsamples
  pos = 0; // sample position in sfx
  looping = 0; // where to loop, -1 = no looping -- see file header, dead field
  entnum = 0; // to allow overriding a specific sound
  entchannel = 0;
  origin: Vec3 = vec3(); // origin of sound effect
  dist_mult = 0; // distance multiplier (attenuation/clipK)
  master_vol = 0; // 0-255 master volume

  // S_StartSound's `memset (target_chan, 0, sizeof(*target_chan))`
  clear(): void {
    this.sfx = null;
    this.leftvol = 0;
    this.rightvol = 0;
    this.end = 0;
    this.pos = 0;
    this.looping = 0;
    this.entnum = 0;
    this.entchannel = 0;
    this.origin[0] = this.origin[1] = this.origin[2] = 0;
    this.dist_mult = 0;
    this.master_vol = 0;
  }
}

export class WavinfoT {
  rate = 0;
  width = 0;
  channels = 0;
  loopstart = 0;
  samples = 0;
  dataofs = 0; // chunk starts this many bytes from file start
}

// ====================================================================
// User-setable variables
// ====================================================================

export const MAX_CHANNELS = 128;
export const MAX_DYNAMIC_CHANNELS = 8;

// snd_dma.c: `#define MAX_SFX 512`
export const MAX_SFX = 512;

// snd_mix.c: `#define PAINTBUFFER_SIZE 512`
export const PAINTBUFFER_SIZE = 512;

// 0 to MAX_DYNAMIC_CHANNELS-1 = normal entity sounds
// MAX_DYNAMIC_CHANNELS to MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS -1 = water, etc
// MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS to total_channels = static sounds
export const channels: ChannelT[] = Array.from({ length: MAX_CHANNELS }, () => new ChannelT());

export let total_channels = 0;
export function setTotalChannels(v: number): void {
  total_channels = v;
}

//
// Fake dma is a synchronous faking of the DMA progress used for
// isolating performance in the renderer. The fakedma_updates is
// number of times S_Update() is called per second.
//
// (kept here per the header's `extern`, though nothing in this port's scope
// reads them outside snd_dma.ts -- see the file header)

export let paintedtime = 0; // sample PAIRS
export function setPaintedtime(v: number): void {
  paintedtime = v;
}

export const listener_origin: Vec3 = vec3();
export const listener_forward: Vec3 = vec3();
export const listener_right: Vec3 = vec3();
export const listener_up: Vec3 = vec3();

// pointer should go away
export let shm: DmaT | null = null;
export function setShm(v: DmaT | null): void {
  shm = v;
}
export const sn: DmaT = new DmaT();

export const sound_nominal_clip_dist = 1000.0;

export const loadas8bit = new CvarT("loadas8bit", "0");
export const bgmvolume = new CvarT("bgmvolume", "1", true);
export const volume = new CvarT("volume", "0.7", true);

export let snd_initialized = false;
export function setSndInitialized(v: boolean): void {
  snd_initialized = v;
}

export let snd_blocked = 0;
export function setSndBlocked(v: number): void {
  snd_blocked = v;
}

// initializes cycling through a DMA buffer and returns information on it;
// gets the current DMA position; shuts down the DMA xfer; sends sound to
// device if buffer isn't really the dma buffer. Implemented by
// src/platform/snd.ts (U056); `SNDDMA_BeginPainting` is declared in some
// platform backends but has no caller anywhere in this tree and is dropped.
export interface SndDma {
  SNDDMA_Init(): boolean;
  SNDDMA_GetDMAPos(): number;
  SNDDMA_Shutdown(): void;
  SNDDMA_Submit(): void;
}

export const sndDma: { current: SndDma | null } = { current: null };

// re-exported so NUM_AMBIENTS-shaped callers (S_UpdateAmbientSounds's
// ambient_sfx[NUM_AMBIENTS]) can import it alongside everything else sound.ts
// already re-exports, without a second import from bspfile.ts.
export { NUM_AMBIENTS };
