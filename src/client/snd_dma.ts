/*
Copyright (C) 1996-1997 Id Software, Inc.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

Ported from WinQuake/snd_dma.c (GNU GPL v2 or later).

snd_dma.c -- main control for any streaming sound output device

Deviations from PORTING.md / the C source:
- `sound_started`, `snd_ambient`, `soundtime`, `known_sfx`/`num_sfx`,
  `ambient_sfx`, `fakedma`/`fakedma_updates`, and the `nosound`/`precache`/
  `bgmbuffer`/`ambient_level`/`ambient_fade`/`snd_noextraupdate`/`snd_show`/
  `_snd_mixahead` cvars are file-static in the C (none is `extern` in
  sound.h) and stay module-private state here, per this unit's brief (the
  extern globals live in sound.ts instead). `sound_started` is exported
  anyway, purely so tests can observe S_Init's result -- sound.h never
  declared it `extern` either, so nothing outside this file reads it in the
  C.
- `desired_speed`/`desired_bits` (`int desired_speed=11025; int
  desired_bits=16;`) are dropped entirely: grep of the whole WinQuake tree
  shows their only reader is snd_next.c (the NeXT platform backend), which
  PORTING.md's dropped-platform list already excludes. They have zero
  consumers in this port.
- `known_sfx` (`sfx_t known_sfx[MAX_SFX]`, Hunk-allocated) is a plain,
  reassignable array of `SfxT` objects rather than a `Hunk_AllocName` byte
  block -- see sound.ts's file header for the reasoning (mirrors model.ts's
  `mod_known`). S_Init rebuilds it fresh each call (`known_sfx =
  Array.from(...)`), matching what a second real `Hunk_AllocName` call would
  give the C (a fresh zeroed block) if S_Init ever ran twice -- which it does
  not in real gameplay, but this port's test suite calls S_Init once per
  fixture and must not see sfx state leak from an earlier module-level call.
- The fakedma path's `shm = Hunk_AllocName(sizeof(*shm), "shm")` builds a
  `new DmaT()` object directly instead (no byte-block Hunk_AllocName call --
  same reasoning); `shm->buffer = Hunk_AllocName(1<<16, "shmbuf")` IS a real
  `Hunk_AllocName` call, since that field really is a byte block.
- `Con_Printf ("Sound sampling rate: %i\n", shm->speed)` unconditionally
  dereferences `shm` in the C, which is safe there because every real
  SNDDMA_Init implementation (snd_linux.c, snd_win.c, ...) sets `shm = &sn`
  as its very first act, before any hardware negotiation that might fail --
  so `shm` is never null by this point even when initialization fails. This
  port's `SndDma` interface has no equivalent guarantee (`SNDDMA_Init()`
  returns only a `boolean`), and the deliberate "no platform driver
  registered" path (`sndDma.current === null`) never calls anything that
  could set `shm`. The print is therefore guarded on `shm` being non-null;
  the guard is unreachable whenever a real driver is registered (S_Startup's
  init either fails cleanly with `sound_started = 0` after a driver call, or
  the driver has already set `shm`), matching the C's real-world behaviour
  exactly except for this port's own "no driver at all" test path, which the
  original could never express (one platform sound backend always linked).
- `S_SoundInfo_f`'s `"0x%x dma buffer\n", shm->buffer` prints a raw pointer
  address, which has no TypeScript equivalent; ported as `1`/`0` for
  present/absent in the same `%x` slot, since only presence is meaningful
  here.
- `SND_Spatialize`'s C declares `sfx_t *snd; ... snd = ch->sfx;` and never
  reads `snd` again afterward (dead local); dropped.
- `rand()` (S_StartSound's "offset the pos" jitter) has no libc equivalent;
  ported with the same `Math.floor(Math.random()*0x8000)&0x7fff` shape
  pr_cmds.ts's PF_random already uses for the same C function, per
  PORTING.md's rand()/random() idiom-map entry.
- `S_Update`'s "search for one" combine loop: the C's `for (j=start; j<i;
  j++, combine++) if (...) break;` leaves `combine` one slot PAST the last
  index it actually tested when no match is found (the `for` loop's
  post-increment still runs on the failing final check), and the C then
  compares that leftover `j` against `total_channels` -- not `i`, the loop's
  own bound -- which is almost always false, so `combine` is left pointing
  at `channels[i]` itself (the same channel as `ch`) whenever the search
  fails, and the subsequent `if (combine != ch)` silently no-ops. This is
  reproduced exactly with a `while` loop that increments `j`/`combineIdx` in
  lockstep the same way, preserving the C's `j === total_channels` check
  exactly as the original rather than "fixing" it to `j === i`.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/snd_dma.c against WinQuake/snd_dma.c):
- `#define viewentity playernum+1`: a file-scope textual rename, so every
  bare `viewentity` (including `cl.viewentity`) becomes `cl.playernum+1` --
  `cl.qw.playernum + 1` in this port. Folded through the `sndViewentity()`
  helper below, used at S_PickChannel's "don't let monster sounds override
  player sounds" check, SND_Spatialize's view-entity full-volume check, and
  S_LocalSound's S_StartSound call -- the same three C call sites.
- S_Init's sound-init banner and S_Startup's sample-rate print are both
  commented out under qw.active.
- The unused `ldist`/`rdist` locals SND_Spatialize's C drops, and the
  `#ifdef __sun__` branch around `soundtime = SNDDMA_GetSamples()`, are
  already excluded from this port (not our platform, no unused locals here)
  -- no-op, verified.
*/

import { Cache_Check, Hunk_AllocName } from "../common/zone";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { COM_CheckParm, Q_atof } from "../common/common";
import { Con_Printf } from "./console";
import { host, host_parms, hostClientHooks } from "../common/host";
import { DotProduct, VectorCopy, VectorNormalize, VectorSubtract, vec3, vec3_origin, type Vec3 } from "../common/mathlib";
import { MAX_QPATH, qw } from "../common/quakedef";
import { AMBIENT_SKY, AMBIENT_WATER } from "../common/bspfile";
import { Mod_PointInLeaf } from "../common/model";
import { Sys_Error } from "../platform/sys";
import { cl } from "./client";
import { S_LoadSound } from "./snd_mem";
import { S_PaintChannels, SND_InitScaletable } from "./snd_mix";
import {
  ChannelT,
  DmaT,
  MAX_CHANNELS,
  MAX_DYNAMIC_CHANNELS,
  MAX_SFX,
  NUM_AMBIENTS,
  SfxT,
  bgmvolume,
  channels,
  listener_forward,
  listener_origin,
  listener_right,
  listener_up,
  loadas8bit,
  paintedtime,
  setPaintedtime,
  setShm,
  setSndInitialized,
  setTotalChannels,
  shm,
  snd_blocked,
  snd_initialized,
  sndDma,
  sound_nominal_clip_dist,
  total_channels,
  volume,
} from "./sound";

let sound_started = 0;
export { sound_started };

let snd_ambient = true;

let fakedma = false;
const fakedma_updates = 15;

const nosound = new CvarT("nosound", "0");
const precache = new CvarT("precache", "1");
const bgmbuffer = new CvarT("bgmbuffer", "4096");
const ambient_level = new CvarT("ambient_level", "0.3");
const ambient_fade = new CvarT("ambient_fade", "100");
const snd_noextraupdate = new CvarT("snd_noextraupdate", "0");
const snd_show = new CvarT("snd_show", "0");
const _snd_mixahead = new CvarT("_snd_mixahead", "0.1", true);

let known_sfx: SfxT[] = [];
let num_sfx = 0;

const ambient_sfx: Array<SfxT | null> = new Array<SfxT | null>(NUM_AMBIENTS).fill(null);

let soundtime = 0; // sample PAIRS

function S_StopAllSoundsC(): void {
  S_StopAllSounds(true);
}

export function S_AmbientOff(): void {
  snd_ambient = false;
}

export function S_AmbientOn(): void {
  snd_ambient = true;
}

export function S_SoundInfo_f(): void {
  if (!sound_started || !shm) {
    Con_Printf("sound system not started\n");
    return;
  }

  Con_Printf("%5d stereo\n", shm.channels - 1);
  Con_Printf("%5d samples\n", shm.samples);
  Con_Printf("%5d samplepos\n", shm.samplepos);
  Con_Printf("%5d samplebits\n", shm.samplebits);
  Con_Printf("%5d submission_chunk\n", shm.submission_chunk);
  Con_Printf("%5d speed\n", shm.speed);
  Con_Printf("0x%x dma buffer\n", shm.buffer ? 1 : 0); // no raw pointer address in this port; see file header
  Con_Printf("%5d total_channels\n", total_channels);
}

/*
================
S_Startup
================
*/
export function S_Startup(): void {
  if (!snd_initialized) return;

  if (!fakedma) {
    const rc = sndDma.current ? sndDma.current.SNDDMA_Init() : false;

    if (!rc) {
      Con_Printf("S_Startup: SNDDMA_Init failed.\n"); // #ifndef _WIN32; the _WIN32 branch prints nothing
      sound_started = 0;
      return;
    }
  }

  sound_started = 1;
}

// QW snd_dma.c: `// QuakeWorld hack... #define viewentity playernum+1` --
// every bare `viewentity` token in this file (including as `cl.viewentity`)
// is textually replaced, so `cl.viewentity` becomes `cl.playernum+1`, i.e.
// `cl.qw.playernum + 1`. WinQuake's own `cl.viewentity` field is read
// otherwise.
function sndViewentity(): number {
  return qw.active ? cl.qw.playernum + 1 : cl.viewentity;
}

/*
================
S_Init
================
*/
export function S_Init(): void {
  // QW snd_dma.c comments out this banner print.
  if (!qw.active) Con_Printf("\nSound Initialization\n");

  if (COM_CheckParm("-nosound")) return;

  if (COM_CheckParm("-simsound")) fakedma = true;

  Cmd_AddCommand("play", S_Play);
  Cmd_AddCommand("playvol", S_PlayVol);
  Cmd_AddCommand("stopsound", S_StopAllSoundsC);
  Cmd_AddCommand("soundlist", S_SoundList);
  Cmd_AddCommand("soundinfo", S_SoundInfo_f);

  Cvar_RegisterVariable(nosound);
  Cvar_RegisterVariable(volume);
  Cvar_RegisterVariable(precache);
  Cvar_RegisterVariable(loadas8bit);
  Cvar_RegisterVariable(bgmvolume);
  Cvar_RegisterVariable(bgmbuffer);
  Cvar_RegisterVariable(ambient_level);
  Cvar_RegisterVariable(ambient_fade);
  Cvar_RegisterVariable(snd_noextraupdate);
  Cvar_RegisterVariable(snd_show);
  Cvar_RegisterVariable(_snd_mixahead);

  if (host_parms.memsize < 0x800000) {
    Cvar_Set("loadas8bit", "1");
    Con_Printf("loading all sounds as 8bit\n");
  }

  setSndInitialized(true);

  S_Startup();

  SND_InitScaletable();

  known_sfx = Array.from({ length: MAX_SFX }, () => new SfxT());
  num_sfx = 0;

  // create a piece of DMA memory

  if (fakedma) {
    const fake = new DmaT();
    fake.splitbuffer = false;
    fake.samplebits = 16;
    fake.speed = 22050;
    fake.channels = 2;
    fake.samples = 32768;
    fake.samplepos = 0;
    fake.soundalive = true;
    fake.gamealive = true;
    fake.submission_chunk = 1;
    fake.buffer = Hunk_AllocName(1 << 16, "shmbuf");
    setShm(fake);
  }

  // QW snd_dma.c comments out this print (see file header: also guarded
  // against a null shm, this port's own addition).
  if (!qw.active && shm) Con_Printf("Sound sampling rate: %i\n", shm.speed);

  // provides a tick sound until washed clean

  ambient_sfx[AMBIENT_WATER] = S_PrecacheSound("ambience/water1.wav");
  ambient_sfx[AMBIENT_SKY] = S_PrecacheSound("ambience/wind2.wav");

  S_StopAllSounds(true);
}

// =======================================================================
// Shutdown sound engine
// =======================================================================

export function S_Shutdown(): void {
  if (!sound_started) return;

  if (shm) shm.gamealive = false;

  setShm(null);
  sound_started = 0;

  if (!fakedma) {
    sndDma.current?.SNDDMA_Shutdown();
  }
}

// =======================================================================
// Load a sound
// =======================================================================

/*
==================
S_FindName

==================
*/
export function S_FindName(name: string): SfxT {
  // C also checks `!name`; TS's `string` parameter type already excludes
  // null/undefined, so that check has nothing left to guard against.
  if (name.length >= MAX_QPATH) Sys_Error("Sound name too long: %s", name);

  // see if already loaded
  for (let i = 0; i < num_sfx; i++) {
    if (known_sfx[i].name === name) return known_sfx[i];
  }

  if (num_sfx === MAX_SFX) Sys_Error("S_FindName: out of sfx_t");

  const sfx = known_sfx[num_sfx];
  sfx.name = name;

  num_sfx++;

  return sfx;
}

/*
==================
S_TouchSound

==================
*/
export function S_TouchSound(name: string): void {
  if (!sound_started) return;

  const sfx = S_FindName(name);
  Cache_Check(sfx.cache);
}

/*
==================
S_PrecacheSound

==================
*/
export function S_PrecacheSound(name: string): SfxT | null {
  if (!sound_started || nosound.value) return null;

  const sfx = S_FindName(name);

  // cache it in
  if (precache.value) S_LoadSound(sfx);

  return sfx;
}

//=============================================================================

/*
=================
SND_PickChannel
=================
*/
export function SND_PickChannel(entnum: number, entchannel: number): ChannelT | null {
  // Check for replacement sound, or find the best one to replace
  let first_to_die = -1;
  let life_left = 0x7fffffff;
  for (let ch_idx = NUM_AMBIENTS; ch_idx < NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS; ch_idx++) {
    const c = channels[ch_idx];

    if (entchannel !== 0 && c.entnum === entnum && (c.entchannel === entchannel || entchannel === -1)) {
      // allways override sound from same entity
      first_to_die = ch_idx;
      break;
    }

    // don't let monster sounds override player sounds
    if (c.entnum === sndViewentity() && entnum !== sndViewentity() && c.sfx) continue;

    if (c.end - paintedtime < life_left) {
      life_left = c.end - paintedtime;
      first_to_die = ch_idx;
    }
  }

  if (first_to_die === -1) return null;

  const ch = channels[first_to_die];
  if (ch.sfx) ch.sfx = null;

  return ch;
}

/*
=================
SND_Spatialize
=================
*/
export function SND_Spatialize(ch: ChannelT): void {
  // anything coming from the view entity will allways be full volume
  if (ch.entnum === sndViewentity()) {
    ch.leftvol = ch.master_vol;
    ch.rightvol = ch.master_vol;
    return;
  }

  if (!shm) return; // C dereferences shm unconditionally; guarded for TS null-safety (see sound.ts's file header)

  // calculate stereo seperation and distance attenuation

  const source_vec: Vec3 = vec3();
  VectorSubtract(ch.origin, listener_origin, source_vec);

  const dist = VectorNormalize(source_vec) * ch.dist_mult;

  const dot = DotProduct(listener_right, source_vec);

  let rscale: number;
  let lscale: number;
  if (shm.channels === 1) {
    rscale = 1.0;
    lscale = 1.0;
  } else {
    rscale = 1.0 + dot;
    lscale = 1.0 - dot;
  }

  // add in distance effect
  let scale = (1.0 - dist) * rscale;
  ch.rightvol = Math.trunc(ch.master_vol * scale);
  if (ch.rightvol < 0) ch.rightvol = 0;

  scale = (1.0 - dist) * lscale;
  ch.leftvol = Math.trunc(ch.master_vol * scale);
  if (ch.leftvol < 0) ch.leftvol = 0;
}

// =======================================================================
// Start a sound effect
// =======================================================================

export function S_StartSound(entnum: number, entchannel: number, sfx: SfxT | null, origin: Vec3, fvol: number, attenuation: number): void {
  if (!sound_started) return;

  if (!sfx) return;

  if (nosound.value) return;

  const vol = Math.trunc(fvol * 255);

  // pick a channel to play on
  const target_chan = SND_PickChannel(entnum, entchannel);
  if (!target_chan) return;

  // spatialize
  target_chan.clear();
  VectorCopy(origin, target_chan.origin);
  target_chan.dist_mult = attenuation / sound_nominal_clip_dist;
  target_chan.master_vol = vol;
  target_chan.entnum = entnum;
  target_chan.entchannel = entchannel;
  SND_Spatialize(target_chan);

  if (!target_chan.leftvol && !target_chan.rightvol) return; // not audible at all

  // new channel
  const sc = S_LoadSound(sfx);
  if (!sc) {
    target_chan.sfx = null;
    return; // couldn't load the sound's data
  }

  target_chan.sfx = sfx;
  target_chan.pos = 0;
  target_chan.end = paintedtime + sc.length;

  // if an identical sound has also been started this frame, offset the pos
  // a bit to keep it from just making the first one louder
  for (let ch_idx = NUM_AMBIENTS; ch_idx < NUM_AMBIENTS + MAX_DYNAMIC_CHANNELS; ch_idx++) {
    const check = channels[ch_idx];
    if (check === target_chan) continue;
    if (check.sfx === sfx && !check.pos) {
      if (!shm) break;
      // rand() has no libc equivalent; see file header's ruling
      const r = Math.floor(Math.random() * 0x8000) & 0x7fff;
      let skip = r % Math.trunc(0.1 * shm.speed);
      if (skip >= target_chan.end) skip = target_chan.end - 1;
      target_chan.pos += skip;
      target_chan.end -= skip;
      break;
    }
  }
}

export function S_StopSound(entnum: number, entchannel: number): void {
  for (let i = 0; i < MAX_DYNAMIC_CHANNELS; i++) {
    const c = channels[i];
    if (c.entnum === entnum && c.entchannel === entchannel) {
      c.end = 0;
      c.sfx = null;
      return;
    }
  }
}

export function S_StopAllSounds(clear: boolean): void {
  if (!sound_started) return;

  setTotalChannels(MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS); // no statics

  for (let i = 0; i < MAX_CHANNELS; i++) {
    if (channels[i].sfx) channels[i].sfx = null;
  }

  for (let i = 0; i < MAX_CHANNELS; i++) channels[i].clear();

  if (clear) S_ClearBuffer();
}

export function S_ClearBuffer(): void {
  if (!sound_started || !shm || !shm.buffer) return;

  const clear = shm.samplebits === 8 ? 0x80 : 0;

  shm.buffer.fill(clear, 0, Math.trunc((shm.samples * shm.samplebits) / 8));
}

/*
=================
S_StaticSound
=================
*/
export function S_StaticSound(sfx: SfxT | null, origin: Vec3, vol: number, attenuation: number): void {
  if (!sfx) return;

  if (total_channels === MAX_CHANNELS) {
    Con_Printf("total_channels == MAX_CHANNELS\n");
    return;
  }

  const ss = channels[total_channels];
  setTotalChannels(total_channels + 1);

  const sc = S_LoadSound(sfx);
  if (!sc) return;

  if (sc.loopstart === -1) {
    Con_Printf("Sound %s not looped\n", sfx.name);
    return;
  }

  ss.sfx = sfx;
  VectorCopy(origin, ss.origin);
  ss.master_vol = vol;
  ss.dist_mult = attenuation / 64 / sound_nominal_clip_dist;
  ss.end = paintedtime + sc.length;

  SND_Spatialize(ss);
}

//=============================================================================

/*
===================
S_UpdateAmbientSounds
===================
*/
export function S_UpdateAmbientSounds(): void {
  if (!snd_ambient) return;

  // calc ambient sound levels
  if (!cl.worldmodel) return;

  const l = Mod_PointInLeaf(listener_origin, cl.worldmodel);
  // Mod_PointInLeaf never actually returns a falsy value in this port (it
  // throws on a bad model instead); `!l` is kept for structural fidelity
  // with the C's `if (!l || ...)`.
  if (!l || !ambient_level.value) {
    for (let ambient_channel = 0; ambient_channel < NUM_AMBIENTS; ambient_channel++) channels[ambient_channel].sfx = null;
    return;
  }

  for (let ambient_channel = 0; ambient_channel < NUM_AMBIENTS; ambient_channel++) {
    const chan = channels[ambient_channel];
    chan.sfx = ambient_sfx[ambient_channel];

    let vol = ambient_level.value * l.ambient_sound_level[ambient_channel];
    if (vol < 8) vol = 0;

    // don't adjust volume too fast
    if (chan.master_vol < vol) {
      chan.master_vol += host.frametime * ambient_fade.value;
      if (chan.master_vol > vol) chan.master_vol = vol;
    } else if (chan.master_vol > vol) {
      chan.master_vol -= host.frametime * ambient_fade.value;
      if (chan.master_vol < vol) chan.master_vol = vol;
    }

    chan.leftvol = chan.rightvol = chan.master_vol;
  }
}

/*
============
S_Update

Called once each time through the main loop
============
*/
export function S_Update(origin: Vec3, forward: Vec3, right: Vec3, up: Vec3): void {
  if (!sound_started || snd_blocked > 0) return;

  VectorCopy(origin, listener_origin);
  VectorCopy(forward, listener_forward);
  VectorCopy(right, listener_right);
  VectorCopy(up, listener_up);

  // update general area ambient sound sources
  S_UpdateAmbientSounds();

  let combine: ChannelT | null = null;

  // update spatialization for static and dynamic sounds
  for (let i = NUM_AMBIENTS; i < total_channels; i++) {
    const ch = channels[i];
    if (!ch.sfx) continue;
    SND_Spatialize(ch); // respatialize channel
    if (!ch.leftvol && !ch.rightvol) continue;

    // try to combine static sounds with a previous channel of the same
    // sound effect so we don't mix five torches every frame

    if (i >= MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS) {
      // see if it can just use the last one
      if (combine && combine.sfx === ch.sfx) {
        combine.leftvol += ch.leftvol;
        combine.rightvol += ch.rightvol;
        ch.leftvol = ch.rightvol = 0;
        continue;
      }

      // search for one -- see the file header for the exact (buggy, kept)
      // `j === total_channels` comparison this reproduces
      let j = MAX_DYNAMIC_CHANNELS + NUM_AMBIENTS;
      let combineIdx = j;
      while (j < i) {
        if (channels[combineIdx].sfx === ch.sfx) break;
        j++;
        combineIdx++;
      }

      if (j === total_channels) {
        combine = null;
      } else {
        combine = channels[combineIdx];
        if (combineIdx !== i) {
          combine.leftvol += ch.leftvol;
          combine.rightvol += ch.rightvol;
          ch.leftvol = ch.rightvol = 0;
        }
        continue;
      }
    }
  }

  //
  // debugging output
  //
  if (snd_show.value) {
    let total = 0;
    for (let i = 0; i < total_channels; i++) {
      const ch = channels[i];
      if (ch.sfx && (ch.leftvol || ch.rightvol)) total++;
    }

    Con_Printf("----(%i)----\n", total);
  }

  // mix some sound
  S_Update_();
}

let gs_buffers = 0;
let gs_oldsamplepos = 0;

export function GetSoundtime(): void {
  if (!shm) return; // C dereferences shm unconditionally; called only when shm is set in practice

  const fullsamples = Math.trunc(shm.samples / shm.channels);

  // it is possible to miscount buffers if it has wrapped twice between
  // calls to S_Update. Oh well.
  // (`#ifdef __sun__`'s SNDDMA_GetSamples() branch is dropped)
  const samplepos = sndDma.current ? sndDma.current.SNDDMA_GetDMAPos() : 0;

  if (samplepos < gs_oldsamplepos) {
    gs_buffers++; // buffer wrapped

    if (paintedtime > 0x40000000) {
      // time to chop things off to avoid 32 bit limits
      gs_buffers = 0;
      setPaintedtime(fullsamples);
      S_StopAllSounds(true);
    }
  }
  gs_oldsamplepos = samplepos;

  soundtime = gs_buffers * fullsamples + Math.trunc(samplepos / shm.channels);
}

export function S_ExtraUpdate(): void {
  // `#ifdef _WIN32`'s IN_Accumulate() is dropped (not this port's input path)

  if (snd_noextraupdate.value) return; // don't pollute timings
  S_Update_();
}

export function S_Update_(): void {
  if (!sound_started || snd_blocked > 0) return;

  // Updates DMA time
  GetSoundtime();

  // check to make sure that we haven't overshot
  if (paintedtime < soundtime) {
    //Con_Printf ("S_Update_ : overflow\n");
    setPaintedtime(soundtime);
  }

  if (!shm) return; // C dereferences shm unconditionally past this point; guarded for TS null-safety

  // mix ahead of current position
  let endtime = Math.trunc(soundtime + _snd_mixahead.value * shm.speed);
  const samps = shm.samples >> (shm.channels - 1);
  if (endtime - soundtime > samps) endtime = soundtime + samps;

  // (the `_WIN32` buffer-lost/restore/replay branch is dropped -- DirectSound only)

  S_PaintChannels(endtime);

  sndDma.current?.SNDDMA_Submit();
}

/*
===============================================================================

console functions

===============================================================================
*/

let playHash = 345;

export function S_Play(): void {
  let i = 1;
  while (i < Cmd_Argc()) {
    const arg = Cmd_Argv(i);
    const name = arg.includes(".") ? arg : `${arg}.wav`;
    const sfx = S_PrecacheSound(name);
    S_StartSound(playHash++, 0, sfx, listener_origin, 1.0, 1.0);
    i++;
  }
}

let playVolHash = 543;

export function S_PlayVol(): void {
  let i = 1;
  while (i < Cmd_Argc()) {
    const arg = Cmd_Argv(i);
    const name = arg.includes(".") ? arg : `${arg}.wav`;
    const sfx = S_PrecacheSound(name);
    const vol = Q_atof(Cmd_Argv(i + 1));
    S_StartSound(playVolHash++, 0, sfx, listener_origin, vol, 1.0);
    i += 2;
  }
}

export function S_SoundList(): void {
  let total = 0;
  for (let i = 0; i < num_sfx; i++) {
    const sfx = known_sfx[i];
    const sc = Cache_Check(sfx.cache);
    if (!sc) continue;
    const size = sc.length * sc.width * (sc.stereo + 1);
    total += size;
    Con_Printf(sc.loopstart >= 0 ? "L" : " ");
    Con_Printf("(%2db) %6i : %s\n", sc.width * 8, size, sfx.name);
  }
  Con_Printf("Total resident: %i\n", total);
}

export function S_LocalSound(sound: string): void {
  if (nosound.value) return;
  if (!sound_started) return;

  const sfx = S_PrecacheSound(sound);
  if (!sfx) {
    Con_Printf("S_LocalSound: can't cache %s\n", sound);
    return;
  }
  S_StartSound(sndViewentity(), -1, sfx, vec3_origin, 1, 1);
}

export function S_ClearPrecache(): void {}

export function S_BeginPrecaching(): void {}

export function S_EndPrecaching(): void {}

// Register hostClientHooks -- see host.ts's file header on the client seam.
hostClientHooks.sInit = S_Init;
hostClientHooks.sUpdate = S_Update;
hostClientHooks.sShutdown = S_Shutdown;
