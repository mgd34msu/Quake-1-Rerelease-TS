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

Ported from WinQuake/snd_mem.c (GNU GPL v2 or later).

snd_mem.c: sound caching

Deviations from PORTING.md / the C source:
- `data_p`/`iff_end`/`last_chunk`/`iff_data`/`iff_chunk_len` (file-static
  globals in the C, a raw pointer walking the WAV byte block) become module-
  private state indexing into `wavBuf` (a plain array offset stands in for
  the C's pointer arithmetic); `-1` stands in for `NULL`. `GetLittleShort`
  reads a `(short *)` cast, which sign-extends on dereference in the C, so
  the byte pair is explicitly sign-extended here too.
- `S_LoadSound`'s `char namebuffer[256]`/`byte stackbuf[1024]` (the C's
  stack-buffer optimization for `COM_LoadStackFile`) have no meaning: this
  port's `COM_LoadStackFile(path)` (src/common/common.ts) takes just a path,
  per that unit's own ruling, so those two locals are dropped along with the
  buffer-size argument.
- `sc = Cache_Alloc(&s->cache, len + sizeof(sfxcache_t), s->name)` builds the
  cache object first (this port has no `void *` for the caller to fill in
  after the fact -- zone.ts's Cache_Alloc ruling) and hands it to Cache_Alloc,
  which stores and returns it. `sizeof(sfxcache_t)`'s header contribution
  (5 `int` fields before the flexible array member) is approximated as a
  fixed 20-byte constant; it is purely a bookkeeping number Cache_Report/
  Cache_Print display and never affects behaviour.
- `info = GetWavinfo(s->name, data, com_filesize)`: `com_filesize` is
  `data.length` here (COM_LoadStackFile's return already IS the exact file
  content with a trailing NUL per common.ts's COM_LoadFile; GetWavinfo never
  reads that last byte as WAV data, so the extra byte is harmless, exactly
  as it is in the C where com_filesize also includes it).

QuakeWorld fold: ../qsrc/quake/QW/client/snd_mem.c's only difference is
wrapping `DumpChunks` in `#if 0` (never compiled under QW). WinQuake compiles
it but nothing calls it (this file's own commented-out call site is the only
reference in either tree) -- an unused function either way, so there is no
runtime-observable difference between the two trees. No-op, not folded;
`DumpChunks` stays exported unconditionally.
*/

import { Cache_Alloc, Cache_Check } from "../common/zone";
import { COM_LoadStackFile } from "../common/common";
import { Con_Printf } from "./console";
import { Sys_Error } from "../platform/sys";
import { loadas8bit, shm, type SfxT, SfxcacheT, WavinfoT } from "./sound";

// approximates `sizeof(sfxcache_t)`'s fixed header (length/loopstart/speed/
// width/stereo, five 4-byte ints) ahead of the flexible `data` member; see
// the file header.
const SFXCACHE_HEADER_BYTES = 20;

// C reads a little-endian 16-bit sample out of a raw byte buffer via a
// `(short *)` cast, which sign-extends on dereference; this port's bytes are
// plain unsigned Uint8Array entries, so the sign-extension is made explicit.
function readInt16LE(buf: Uint8Array, byteOffset: number): number {
  const v = (buf[byteOffset] ?? 0) | ((buf[byteOffset + 1] ?? 0) << 8);
  return (v << 16) >> 16;
}

/*
================
ResampleSfx
================
*/
export function ResampleSfx(sfx: SfxT, inrate: number, inwidth: number, data: Uint8Array): void {
  const sc = Cache_Check(sfx.cache);
  if (!sc) return;

  // shm is guaranteed non-null whenever this runs in the C (S_LoadSound only
  // calls ResampleSfx after S_Startup has set it); guarded here for TS's
  // strict null checking rather than dereferencing unconditionally.
  if (!shm) return;

  const stepscale = inrate / shm.speed; // this is usually 0.5, 1, or 2

  const outcount = Math.trunc(sc.length / stepscale);
  sc.length = outcount;
  if (sc.loopstart !== -1) sc.loopstart = Math.trunc(sc.loopstart / stepscale);

  sc.speed = shm.speed;
  if (loadas8bit.value) sc.width = 1;
  else sc.width = inwidth;
  sc.stereo = 0;

  // resample / decimate to the current source rate

  if (stepscale === 1 && inwidth === 1 && sc.width === 1) {
    // fast special case
    for (let i = 0; i < outcount; i++) {
      sc.data[i] = ((data[i] ?? 0) - 128) & 0xff;
    }
  } else {
    // general case
    let samplefrac = 0;
    const fracstep = Math.trunc(stepscale * 256);
    for (let i = 0; i < outcount; i++) {
      const srcsample = samplefrac >> 8;
      samplefrac = (samplefrac + fracstep) | 0;
      let sample: number;
      if (inwidth === 2) sample = readInt16LE(data, srcsample * 2);
      else sample = ((data[srcsample] ?? 0) - 128) << 8;
      if (sc.width === 2) {
        sc.data[i * 2] = sample & 0xff;
        sc.data[i * 2 + 1] = (sample >> 8) & 0xff;
      } else {
        sc.data[i] = (sample >> 8) & 0xff;
      }
    }
  }
}

//=============================================================================

/*
==============
S_LoadSound
==============
*/
export function S_LoadSound(s: SfxT): SfxcacheT | null {
  // see if still in memory
  let sc = Cache_Check(s.cache);
  if (sc) return sc;

  // load it in
  const namebuffer = `sound/${s.name}`;

  const data = COM_LoadStackFile(namebuffer);

  if (!data) {
    Con_Printf("Couldn't load %s\n", namebuffer);
    return null;
  }

  const info = GetWavinfo(s.name, data, data.length);
  if (info.channels !== 1) {
    Con_Printf("%s is a stereo sample\n", s.name);
    return null;
  }

  if (!shm) return null; // see file header: guarded for TS null-safety

  const stepscale = info.rate / shm.speed;
  let len = Math.trunc(info.samples / stepscale);

  len = len * info.width * info.channels;

  const cacheData = new SfxcacheT();
  cacheData.data = new Uint8Array(len);
  sc = Cache_Alloc(s.cache, len + SFXCACHE_HEADER_BYTES, s.name, cacheData);
  if (!sc) return null;

  sc.length = info.samples;
  sc.loopstart = info.loopstart;
  sc.speed = info.rate;
  sc.width = info.width;
  sc.stereo = info.channels;

  ResampleSfx(s, sc.speed, sc.width, data.subarray(info.dataofs));

  return sc;
}

/*
===============================================================================

WAV loading

===============================================================================
*/

// file-private "pointer" state, mirroring snd_mem.c's own file-static
// globals (data_p/iff_end/last_chunk/iff_data/iff_chunk_len). All offsets
// are indices into `wavBuf`, standing in for the C's raw byte pointers.
let wavBuf: Uint8Array = new Uint8Array(0);
let iffEnd = 0;
let iffDataOfs = 0;
let lastChunk = 0;
let dataP = -1; // -1 == NULL
let iffChunkLen = 0;

function matchTag(offset: number, tag: string): boolean {
  if (offset < 0) return false;
  for (let i = 0; i < 4; i++) {
    if (wavBuf[offset + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

function GetLittleShort(): number {
  const val = readInt16LE(wavBuf, dataP);
  dataP += 2;
  return val;
}

function GetLittleLong(): number {
  const b0 = wavBuf[dataP] ?? 0;
  const b1 = wavBuf[dataP + 1] ?? 0;
  const b2 = wavBuf[dataP + 2] ?? 0;
  const b3 = wavBuf[dataP + 3] ?? 0;
  const val = (b0 + (b1 << 8) + (b2 << 16) + (b3 << 24)) | 0;
  dataP += 4;
  return val;
}

function FindNextChunk(name: string): void {
  for (;;) {
    dataP = lastChunk;

    if (dataP >= iffEnd) {
      // didn't find the chunk
      dataP = -1;
      return;
    }

    dataP += 4;
    iffChunkLen = GetLittleLong();
    if (iffChunkLen < 0) {
      dataP = -1;
      return;
    }
    dataP -= 8;
    lastChunk = dataP + 8 + ((iffChunkLen + 1) & ~1);
    if (matchTag(dataP, name)) return;
  }
}

function FindChunk(name: string): void {
  lastChunk = iffDataOfs;
  FindNextChunk(name);
}

/*
============
DumpChunks
============
*/
export function DumpChunks(): void {
  dataP = iffDataOfs;
  do {
    let str = "";
    for (let i = 0; i < 4; i++) str += String.fromCharCode(wavBuf[dataP + i] ?? 0);
    dataP += 4;
    iffChunkLen = GetLittleLong();
    Con_Printf("0x%x : %s (%d)\n", dataP - 4, str, iffChunkLen);
    dataP += (iffChunkLen + 1) & ~1;
  } while (dataP < iffEnd);
}

/*
============
GetWavinfo
============
*/
export function GetWavinfo(name: string, wav: Uint8Array, wavlength: number): WavinfoT {
  const info = new WavinfoT();

  wavBuf = wav;
  iffEnd = wavlength;
  iffDataOfs = 0;
  lastChunk = 0;
  dataP = -1;

  // find "RIFF" chunk
  FindChunk("RIFF");
  if (!(dataP >= 0 && matchTag(dataP + 8, "WAVE"))) {
    Con_Printf("Missing RIFF/WAVE chunks\n");
    return info;
  }

  // get "fmt " chunk
  iffDataOfs = dataP + 12;
  // DumpChunks();

  FindChunk("fmt ");
  if (dataP < 0) {
    Con_Printf("Missing fmt chunk\n");
    return info;
  }
  dataP += 8;
  const format = GetLittleShort();
  if (format !== 1) {
    Con_Printf("Microsoft PCM format only\n");
    return info;
  }

  info.channels = GetLittleShort();
  info.rate = GetLittleLong();
  dataP += 4 + 2;
  info.width = Math.trunc(GetLittleShort() / 8);

  // get cue chunk
  FindChunk("cue ");
  if (dataP >= 0) {
    dataP += 32;
    info.loopstart = GetLittleLong();

    // if the next chunk is a LIST chunk, look for a cue length marker
    FindNextChunk("LIST");
    if (dataP >= 0) {
      if (matchTag(dataP + 28, "mark")) {
        // this is not a proper parse, but it works with cooledit...
        dataP += 24;
        const i = GetLittleLong(); // samples in loop
        info.samples = info.loopstart + i;
      }
    }
  } else {
    info.loopstart = -1;
  }

  // find data chunk
  FindChunk("data");
  if (dataP < 0) {
    Con_Printf("Missing data chunk\n");
    return info;
  }

  dataP += 4;
  const samples = Math.trunc(GetLittleLong() / info.width);

  if (info.samples) {
    if (samples < info.samples) Sys_Error("Sound %s has a bad loop length", name);
  } else {
    info.samples = samples;
  }

  info.dataofs = dataP;

  return info;
}
