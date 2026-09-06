/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cd_linux.c (GNU GPL v2 or later): the `CdAudio`
interface (cdaudio.h) that file implements over a physical `/dev/cdrom`,
replaced here with Ogg Vorbis rips (`music/NN.ogg`, the long-standing
community convention for CD-less Quake installs) decoded via the system
libvorbisfile through bun:ffi -- one bun implementation per PORTING.md's
platform-track rule. Adapted from ../quake-2-ts/src/platform/cd_ogg.ts's
libvorbisfile bindings (dlopen table, `OggVorbis_File` handling, `ov_read`
decode loop), re-pointed at Quake 1's six-entry `CdAudio` interface and
cd_linux.c's actual state machine (`remap[]`, `playing`/`wasPlaying`,
`cdvolume` tied to `bgmvolume`), which this port's C source makes available
in full, unlike quake-2-ts's own template (whose linux cd_linux.c-equivalent
was not part of that port's reference tree, per that file's own header).

Deviations from PORTING.md / the C source:
- cd_linux.c's decoded audio path IS the analog CD output: physically wired
  straight from the drive to the sound card, never touching the software
  mixer at all (no ioctl in this file ever writes samples anywhere -- it only
  starts/stops/pauses the drive). This port's Ogg replacement therefore does
  NOT feed decoded PCM through client/snd_dma.ts's mixer ring the way
  quake-2-ts's own cd_ogg.ts feeds cinematic audio through `S_RawSamples`
  (Quake 1 has no such raw-injection entry point in its sound engine at all
  -- grepped snd_dma.ts/snd_mix.ts: no `S_RawSamples`, confirming this isn't
  an oversight). Instead this file opens a SECOND, independent SDL audio
  device (sdl.ts's `SDLCD_*` family) and queues decoded samples directly into
  it -- the same "physically separate path" the real hardware had, just
  replacing the analog cable with a second digital output.
- `cdvolume`'s odd-looking logic in `CDAudio_Update` (comparing against the
  PREVIOUS cached value, not testing `bgmvolume.value == 0` directly) is
  ported exactly as written: it is not a bug, it is how the C tells "the user
  just muted" from "the user just unmuted" apart using only one stored float
  -- see the function's own comment.
- No `cd_volume`/software-gain cvar (quake-2-ts's own addition, "there is no
  hardware volume knob to point at here" per that file's comment) is added:
  cd_linux.c never scales decoded samples at all -- CDROMVOLCTRL is never
  called anywhere in this file, only CDROMPAUSE/CDROMRESUME -- so the
  bgmvolume-driven pause/resume above is the ONLY volume behavior this port
  needs to be faithful to, per PORTING.md's "do not improve ... rebalance
  values" rule.
- `CDAudio_Eject`/`CDAudio_CloseDoor` (the `close`/`eject` subcommands) and
  `remap`'s `maxTrack`/`cdValid` bounds (real disc TOC concepts) have no
  equivalent for a file-based backend: `close`/`eject` print a message
  instead of silently doing nothing, and track validity is simply "does
  `music/NN.ogg` exist", checked by attempting to open it.
- `cd_dev`/`-cddev` (the physical device path) is not ported: there is no
  device to point at.
- `CDAudio_Init`'s `cls.state == ca_dedicated` check is `sysState.isDedicated`
  (PORTING.md's dedicated-server mapping, host.ts's own header note); in
  practice this file is only ever reached through
  `hostClientHooks.cdaudioInit`, which host.ts already gates the same way, so
  this is interface-parity, not a load-bearing guard.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/cd_linux.c against WinQuake/cd_linux.c): the
dedicated-state early return is `#if 0`'d out under QW -- folded onto the
`sysState.isDedicated` check above. The GNU.txt license-comment wording
change is not functional.
*/

import { ptr, read as ffiRead, type Library, type Pointer } from "bun:ffi";
import { currentLibrarySearch, openLibrary } from "./libs";
import { Con_Printf, Con_DPrintf } from "../client/console";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { COM_CheckParm, Q_atoi, Q_strcasecmp, com_gamedir } from "../common/common";
import { Cvar_SetValue } from "../common/cvar";
import { bgmvolume } from "../client/sound";
import { cdAudio, type CdAudio } from "../client/cdaudio";
import { hostClientHooks } from "../common/host";
import { sysState } from "./sys";
import { qw } from "../common/quakedef";
import { SDLCD_Active, SDLCD_Close, SDLCD_Open, SDLCD_Queue, SDLCD_QueuedBytes } from "./sdl";

const vorbisSymbols = {
  ov_fopen: { args: ["cstring", "ptr"], returns: "i32" },
  ov_read: { args: ["ptr", "ptr", "i32", "i32", "i32", "i32", "ptr"], returns: "i64" },
  ov_info: { args: ["ptr", "i32"], returns: "ptr" },
  ov_clear: { args: ["ptr"], returns: "i32" },
  ov_pcm_seek: { args: ["ptr", "i64"], returns: "i32" },
} as const;

type VorbisLib = Library<typeof vorbisSymbols>;

let vorbis: VorbisLib | null = null;
let vorbisTried = false;

// CD audio is optional: cd_linux.c's CDAudio_Init returns -1 when it cannot
// open /dev/cdrom and every CDAudio_* entry point then early-returns on
// `!cdValid`/`!initialized`. A missing libvorbisfile is this port's
// equivalent, so the failure is a Con_DPrintf and a null table, never a
// throw -- the per-OS file names and the Q1TS_VORBISFILE_LIB override live
// in src/platform/libs.ts.
function lib(): VorbisLib | null {
  if (vorbisTried) return vorbis;
  vorbisTried = true;
  const opened = openLibrary(currentLibrarySearch("vorbisfile"), vorbisSymbols);
  if (!opened.ok) {
    Con_DPrintf("cd_ogg: %s\n", opened.message);
    Con_DPrintf("cd_ogg: CD audio is silent\n");
    return null;
  }
  vorbis = opened.lib;
  return vorbis;
}

// OggVorbis_File is ~944 bytes on x86-64; over-allocate for safety. The
// struct is opaque to us -- only libvorbisfile reads it.
const OV_FILE_SIZE = 2048;

function cstr(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

function readI32(p: Pointer, off: number): number {
  return ffiRead.i32(p, off);
}
function readI64(p: Pointer, off: number): bigint {
  return ffiRead.i64(p, off);
}

//=============================================================================
// cd_linux.c's file-scope statics

let cdValid = false; // a music/NN.ogg for the current track opened successfully
let playing = false;
let wasPlaying = false;
let initialized = false;
let enabled = true;
let playLooping = false;
let cdvolume = 0;
const remap: number[] = Array.from({ length: 100 }, (_, i) => i);
let playTrack = 0;

let vf: Uint8Array | null = null; // live OggVorbis_File storage
let trackRate = 0;
let trackChannels = 0;
let deviceRate = 0;
let deviceChannels = 0;

const bitstream = new Int32Array(1);
const decodeBuf = new Uint8Array(8192);

function closeTrack(): void {
  const l = lib();
  if (l && vf) l.symbols.ov_clear(ptr(vf));
  vf = null;
  cdValid = false;
}

// keep the device queue this many bytes ahead of "now" -- a quarter second,
// comfortably past one host frame's worth of CDAudio_Update calls.
function feedTargetBytes(): number {
  return ((trackRate * trackChannels * 2) / 4) | 0; // 2 bytes/sample (16-bit)
}

/*
====================
CDAudio_Play

cd_linux.c:96. `track = remap[track]` first (this port clamps an
out-of-range index instead of the C's unchecked `remap[track]` read past a
100-entry array, which is undefined behavior for track >= 100 in the
original -- see this file's header on why there is no `maxTrack` TOC bound
to check track validity against instead: "does music/NN.ogg exist" replaces
it).
====================
*/
export function CDAudio_Play(track: number, looping: boolean): void {
  if (!enabled) return;

  const remapped = track >= 0 && track < remap.length ? remap[track] : track;

  if (playing) {
    if (playTrack === remapped) return;
    CDAudio_Stop();
  }

  if (remapped < 1) return; // track 0/1 = data track / silence, like the CD

  const l = lib();
  if (!l) return;

  const pad = remapped < 10 ? `0${remapped}` : `${remapped}`;
  const candidates = [`${com_gamedir}/music/${pad}.ogg`, `${com_gamedir}/music/track${pad}.ogg`];

  const storage = new Uint8Array(OV_FILE_SIZE);
  let opened = false;
  for (const path of candidates) {
    if (l.symbols.ov_fopen(cstr(path), ptr(storage)) === 0) {
      opened = true;
      break;
    }
  }
  if (!opened) {
    Con_DPrintf("CDAudio: no music file for track %u.\n", remapped);
    return;
  }

  const info = l.symbols.ov_info(ptr(storage), -1);
  // bun:ffi ptr returns can be bigint for high addresses; vorbis_info lives
  // in normal heap on every platform bun targets.
  if (info === null || typeof info === "bigint") {
    l.symbols.ov_clear(ptr(storage));
    return;
  }
  // vorbis_info: int version; int channels; long rate; (LP64: rate at +8)
  const channels = readI32(info, 4);
  const rate = Number(readI64(info, 8));
  if (channels < 1 || channels > 2 || rate <= 0) {
    l.symbols.ov_clear(ptr(storage));
    Con_Printf("CDAudio: unsupported format for track %u (%ich @ %iHz)\n", remapped, channels, rate);
    return;
  }

  vf = storage;
  trackChannels = channels;
  trackRate = rate;
  cdValid = true;
  playLooping = looping;
  playTrack = remapped;
  playing = true;

  if (cdvolume === 0.0) CDAudio_Pause();
}

/*
====================
CDAudio_Stop

cd_linux.c:163.
====================
*/
export function CDAudio_Stop(): void {
  if (!playing) return;
  wasPlaying = false;
  playing = false;
  closeTrack();
}

/*
====================
CDAudio_Pause

cd_linux.c:178.
====================
*/
export function CDAudio_Pause(): void {
  if (!playing) return;
  wasPlaying = playing;
  playing = false;
}

/*
====================
CDAudio_Resume

cd_linux.c:194.
====================
*/
export function CDAudio_Resume(): void {
  if (!cdValid) return;
  if (!wasPlaying) return;
  playing = true;
}

/*
====================
CDAudio_Update

cd_linux.c:328. The bgmvolume-driven pause/resume toggle: see this file's
header comment on why comparing against the stashed `cdvolume` (not
`bgmvolume.value == 0`) is exactly the C's own logic, not a bug.
====================
*/
export function CDAudio_Update(): void {
  if (!enabled) return;

  if (bgmvolume.value !== cdvolume) {
    if (cdvolume) {
      Cvar_SetValue("bgmvolume", 0.0);
      cdvolume = bgmvolume.value;
      CDAudio_Pause();
    } else {
      Cvar_SetValue("bgmvolume", 1.0);
      cdvolume = bgmvolume.value;
      CDAudio_Resume();
    }
  }

  if (!playing || !vf) return;

  const l = lib();
  if (!l) return;

  if (deviceRate !== trackRate || deviceChannels !== trackChannels) {
    SDLCD_Close();
    const opened = SDLCD_Open(trackRate, trackChannels);
    if (!opened) return;
    deviceRate = opened.freq;
    deviceChannels = opened.channels;
  }

  while (SDLCD_Active() && SDLCD_QueuedBytes() < feedTargetBytes()) {
    const n = Number(l.symbols.ov_read(ptr(vf), ptr(decodeBuf), decodeBuf.length, 0, 2, 1, ptr(bitstream)));
    if (n > 0) {
      SDLCD_Queue(decodeBuf.subarray(0, n));
      continue;
    }
    if (n === 0) {
      // end of track
      if (playLooping && l.symbols.ov_pcm_seek(ptr(vf), 0n) === 0) continue;
      playing = false;
      closeTrack();
      return;
    }
    if (n === -3) continue; // OV_HOLE: skip and keep going, like every player does
    Con_DPrintf("cd_ogg: decode error %i on track %u\n", n, playTrack);
    playing = false;
    closeTrack();
    return;
  }
}

/*
====================
CD_f

cd_linux.c:210's "cd" console command. on/off/reset/remap/close/play/loop/
stop/pause/resume/eject/info, ported verbatim except close/eject (no
physical drive to point at -- see file header).
====================
*/
function CD_f(): void {
  if (Cmd_Argc() < 2) return;
  const command = Cmd_Argv(1);

  if (Q_strcasecmp(command, "on") === 0) {
    enabled = true;
    return;
  }

  if (Q_strcasecmp(command, "off") === 0) {
    if (playing) CDAudio_Stop();
    enabled = false;
    return;
  }

  if (Q_strcasecmp(command, "reset") === 0) {
    enabled = true;
    if (playing) CDAudio_Stop();
    for (let n = 0; n < 100; n++) remap[n] = n;
    return;
  }

  if (Q_strcasecmp(command, "remap") === 0) {
    const ret = Cmd_Argc() - 2;
    if (ret <= 0) {
      for (let n = 1; n < 100; n++) if (remap[n] !== n) Con_Printf("  %u -> %u\n", n, remap[n]);
      return;
    }
    for (let n = 1; n <= ret; n++) remap[n] = Q_atoi(Cmd_Argv(n + 1));
    return;
  }

  if (Q_strcasecmp(command, "close") === 0) {
    Con_Printf("cd close: not available -- this port has no physical CD-ROM device (cd_linux.c:261)\n");
    return;
  }

  if (Q_strcasecmp(command, "play") === 0) {
    CDAudio_Play(Q_atoi(Cmd_Argv(2)), false);
    return;
  }

  if (Q_strcasecmp(command, "loop") === 0) {
    CDAudio_Play(Q_atoi(Cmd_Argv(2)), true);
    return;
  }

  if (Q_strcasecmp(command, "stop") === 0) {
    CDAudio_Stop();
    return;
  }

  if (Q_strcasecmp(command, "pause") === 0) {
    CDAudio_Pause();
    return;
  }

  if (Q_strcasecmp(command, "resume") === 0) {
    CDAudio_Resume();
    return;
  }

  if (Q_strcasecmp(command, "eject") === 0) {
    if (playing) CDAudio_Stop();
    Con_Printf("cd eject: not available -- this port has no physical CD-ROM device (cd_linux.c:307)\n");
    return;
  }

  if (Q_strcasecmp(command, "info") === 0) {
    // cd_linux.c also prints "%u tracks" (the disc's table of contents),
    // which has no counterpart for a file-based backend (there is no TOC,
    // only whichever music/NN.ogg files happen to exist).
    if (playing) Con_Printf("Currently %s track %u\n", playLooping ? "looping" : "playing", playTrack);
    else if (wasPlaying) Con_Printf("Paused %s track %u\n", playLooping ? "looping" : "playing", playTrack);
    Con_Printf("Volume is %f\n", cdvolume);
    return;
  }
}

/*
====================
CDAudio_Init

cd_linux.c:369.
====================
*/
export function CDAudio_Init(): number {
  // QW cd_linux.c wraps this check in `#if 0` -- qwcl's CDAudio_Init never
  // early-returns for a dedicated state (already non-load-bearing here per
  // this file's header: host.ts gates the call before it happens).
  if (!qw.active && sysState.isDedicated) return -1;

  if (COM_CheckParm("-nocdaudio")) return -1;

  for (let i = 0; i < 100; i++) remap[i] = i;
  initialized = true;
  enabled = true;

  Cmd_AddCommand("cd", CD_f);

  Con_Printf("CD Audio Initialized\n");

  return 0;
}

/*
====================
CDAudio_Shutdown

cd_linux.c:409.
====================
*/
export function CDAudio_Shutdown(): void {
  if (!initialized) return;
  CDAudio_Stop();
  SDLCD_Close();
  deviceRate = 0;
  deviceChannels = 0;
  initialized = false;
}

const cdAudioImpl: CdAudio = { CDAudio_Init, CDAudio_Play, CDAudio_Stop, CDAudio_Pause, CDAudio_Resume, CDAudio_Shutdown, CDAudio_Update };
cdAudio.current = cdAudioImpl;
hostClientHooks.cdaudioInit = CDAudio_Init;
hostClientHooks.cdaudioUpdate = CDAudio_Update;
hostClientHooks.cdaudioShutdown = CDAudio_Shutdown;
