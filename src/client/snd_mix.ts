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

Ported from WinQuake/snd_mix.c (GNU GPL v2 or later).

snd_mix.c -- portable code to mix sounds for snd_dma.c

The `#if !id386` C versions are what this port takes (PORTING.md: asm
fallbacks are not ported); DirectSound (`_WIN32`) lock/unlock branches are
dropped, matching the platform-mapping rule that Windows-only branches are
not ported.

Deviations from PORTING.md / the C source:
- `portable_samplepair_t paintbuffer[PAINTBUFFER_SIZE]` -> two parallel
  `Int32Array(PAINTBUFFER_SIZE)`s, `paintbufferLeft`/`paintbufferRight`,
  per this unit's brief and the reference Quake 2 port's idiom (paintbuffer
  as Int32Array pairs), rather than an array of `PortableSamplepairT`
  objects -- one allocation instead of PAINTBUFFER_SIZE, and every C site
  that reads/writes `paintbuffer[i].left`/`.right` becomes
  `paintbufferLeft[i]`/`paintbufferRight[i]`.
- `int *snd_p, snd_linear_count, snd_vol; short *snd_out;` (file-static
  pseudo-pointers the C swings across `Snd_WriteLinearBlastStereo16`/
  `S_TransferStereo16`/`S_TransferPaintBuffer`) have no meaning once there is
  no pointer arithmetic: `snd_p`'s int-pair walk over paintbuffer becomes the
  explicit index helper `pget(p)` below (even p = paintbufferLeft[p>>1], odd
  p = paintbufferRight[p>>1]), and `snd_out`/`snd_vol`/`snd_linear_count`
  become ordinary parameters/locals. This is a data-flow restructuring in
  the same spirit as PORTING.md's sanctioned `goto` control-flow
  restructuring: the mixing order and arithmetic are unchanged, only the
  bookkeeping that used to ride on pointer identity is now explicit.
- `shm->buffer` (`unsigned char *`) is written through a `DataView` for the
  16-bit paths (`Int16Array` alignment on a plain `Uint8Array` is not
  guaranteed) and directly for the 8-bit path.
- `SND_PaintChannelFrom8`'s `unsigned char *sfx` is declared unsigned char
  but assigned `(signed char *)sc->data + ch->pos` in the C; the dereference
  still goes through the declared (unsigned char) pointer type, so `data`
  ends up a plain 0-255 byte used directly as the `snd_scaletable` row
  index -- the signed cast on the right-hand side has no effect on the read.
  Ported as a direct 0-255 byte read, matching the C's actual (not
  apparent) behaviour.
- Both `SND_PaintChannelFrom8`/`From16` write into `paintbuffer[0..count)`
  in the C regardless of how far `ltime` has already advanced past
  `paintedtime` within one `S_PaintChannels` buffer chunk (no `ltime -
  paintedtime` offset anywhere in the C). When a channel loops and restarts
  mid-chunk, a second inner-loop pass therefore overwrites the start of the
  paint buffer instead of continuing where the first pass left off -- a
  latent bug in the original (unreachable in practice, since real loop
  lengths vastly exceed one `PAINTBUFFER_SIZE` chunk) that this port
  preserves exactly as the original rather than silently fixing with an offset.
*/

import {
  MAX_CHANNELS,
  PAINTBUFFER_SIZE,
  channels,
  paintedtime,
  setPaintedtime,
  shm,
  total_channels,
  volume,
  type ChannelT,
  type SfxcacheT,
} from "./sound";
import { S_LoadSound } from "./snd_mem";

const paintbufferLeft = new Int32Array(PAINTBUFFER_SIZE);
const paintbufferRight = new Int32Array(PAINTBUFFER_SIZE);

// index p even -> paintbufferLeft[p>>1], odd -> paintbufferRight[p>>1];
// stands in for the C's `int *snd_p` walking paintbuffer as flat int pairs
// (left0, right0, left1, right1, ...). See the file header.
function pget(p: number): number {
  const idx = p >> 1;
  return (p & 1) === 0 ? (paintbufferLeft[idx] ?? 0) : (paintbufferRight[idx] ?? 0);
}

export const snd_scaletable: Int32Array[] = Array.from({ length: 32 }, () => new Int32Array(256));

function clampShort(val: number): number {
  if (val > 0x7fff) return 0x7fff;
  if (val < -0x8000) return -0x8000;
  return val;
}

/*
#if !id386
void Snd_WriteLinearBlastStereo16 (void)
#endif

`snd_p`/`snd_out`/`snd_linear_count`/`snd_vol` are explicit parameters here
instead of file-static globals (see the file header); `snd_p` is a flat int
array of interleaved (left, right) pairs, matching the C's cast of
paintbuffer to `int *`.
*/
export function Snd_WriteLinearBlastStereo16(snd_p: Int32Array, snd_out: Int16Array, snd_linear_count: number, snd_vol: number): void {
  for (let i = 0; i < snd_linear_count; i += 2) {
    let val = ((snd_p[i] ?? 0) * snd_vol) >> 8;
    if (val > 0x7fff) snd_out[i] = 0x7fff;
    else if (val < -0x8000) snd_out[i] = -0x8000;
    else snd_out[i] = val;

    val = ((snd_p[i + 1] ?? 0) * snd_vol) >> 8;
    if (val > 0x7fff) snd_out[i + 1] = 0x7fff;
    else if (val < -0x8000) snd_out[i + 1] = -0x8000;
    else snd_out[i + 1] = val;
  }
}

function S_TransferStereo16(endtime: number): void {
  if (!shm || !shm.buffer) return; // C dereferences shm->buffer unconditionally; guarded for TS null-safety

  const snd_vol = Math.trunc(volume.value * 256);

  const snd_out = new Int16Array(shm.buffer.buffer, shm.buffer.byteOffset, Math.trunc(shm.buffer.byteLength / 2));

  let lpaintedtime = paintedtime;

  while (lpaintedtime < endtime) {
    // handle recirculating buffer issues
    const lpos = lpaintedtime & ((shm.samples >> 1) - 1);

    let snd_linear_count = (shm.samples >> 1) - lpos;
    if (lpaintedtime + snd_linear_count > endtime) snd_linear_count = endtime - lpaintedtime;

    // gather this segment's (left, right) pairs out of the paintbuffer,
    // starting at the offset already consumed from `paintedtime`
    const base = lpaintedtime - paintedtime;
    const snd_p = new Int32Array(snd_linear_count * 2);
    for (let f = 0; f < snd_linear_count; f++) {
      snd_p[f * 2] = paintbufferLeft[base + f] ?? 0;
      snd_p[f * 2 + 1] = paintbufferRight[base + f] ?? 0;
    }

    // write a linear blast of samples
    Snd_WriteLinearBlastStereo16(snd_p, snd_out.subarray(lpos << 1), snd_linear_count << 1, snd_vol);

    lpaintedtime += snd_linear_count;
  }
}

export function S_TransferPaintBuffer(endtime: number): void {
  if (!shm || !shm.buffer) return; // see file header: guarded for TS null-safety

  if (shm.samplebits === 16 && shm.channels === 2) {
    S_TransferStereo16(endtime);
    return;
  }

  let count = (endtime - paintedtime) * shm.channels;
  const out_mask = shm.samples - 1;
  let out_idx = (paintedtime * shm.channels) & out_mask;
  const step = 3 - shm.channels;
  const snd_vol = Math.trunc(volume.value * 256);
  let p = 0;

  if (shm.samplebits === 16) {
    const view = new DataView(shm.buffer.buffer, shm.buffer.byteOffset, shm.buffer.byteLength);
    while (count-- > 0) {
      let val = (pget(p) * snd_vol) >> 8;
      p += step;
      val = clampShort(val);
      view.setInt16(out_idx * 2, val, true);
      out_idx = (out_idx + 1) & out_mask;
    }
  } else if (shm.samplebits === 8) {
    const out = shm.buffer;
    while (count-- > 0) {
      let val = (pget(p) * snd_vol) >> 8;
      p += step;
      val = clampShort(val);
      out[out_idx] = ((val >> 8) + 128) & 0xff;
      out_idx = (out_idx + 1) & out_mask;
    }
  }
}

/*
===============================================================================

CHANNEL MIXING

===============================================================================
*/

// C declares `unsigned char *sfx` but assigns it `(signed char *)sc->data +
// ch->pos` and reads through the declared (unsigned char) type -- see the
// file header. Ported as a direct 0-255 byte read.
function SND_PaintChannelFrom8(ch: ChannelT, sc: SfxcacheT, count: number): void {
  if (ch.leftvol > 255) ch.leftvol = 255;
  if (ch.rightvol > 255) ch.rightvol = 255;

  const lscale = snd_scaletable[ch.leftvol >> 3] ?? new Int32Array(256);
  const rscale = snd_scaletable[ch.rightvol >> 3] ?? new Int32Array(256);

  for (let i = 0; i < count; i++) {
    const data = sc.data[ch.pos + i] ?? 0;
    paintbufferLeft[i] = (paintbufferLeft[i] ?? 0) + (lscale[data] ?? 0);
    paintbufferRight[i] = (paintbufferRight[i] ?? 0) + (rscale[data] ?? 0);
  }

  ch.pos += count;
}

function readSfxInt16LE(buf: Uint8Array, sampleIndex: number): number {
  const byteOffset = sampleIndex * 2;
  const v = (buf[byteOffset] ?? 0) | ((buf[byteOffset + 1] ?? 0) << 8);
  return (v << 16) >> 16;
}

function SND_PaintChannelFrom16(ch: ChannelT, sc: SfxcacheT, count: number): void {
  const leftvol = ch.leftvol;
  const rightvol = ch.rightvol;

  for (let i = 0; i < count; i++) {
    const data = readSfxInt16LE(sc.data, ch.pos + i);
    const left = (data * leftvol) >> 8;
    const right = (data * rightvol) >> 8;
    paintbufferLeft[i] = (paintbufferLeft[i] ?? 0) + left;
    paintbufferRight[i] = (paintbufferRight[i] ?? 0) + right;
  }

  ch.pos += count;
}

export function S_PaintChannels(endtime: number): void {
  while (paintedtime < endtime) {
    // if paintbuffer is smaller than DMA buffer
    let end = endtime;
    if (endtime - paintedtime > PAINTBUFFER_SIZE) end = paintedtime + PAINTBUFFER_SIZE;

    // clear the paint buffer
    const span = end - paintedtime;
    for (let i = 0; i < span; i++) {
      paintbufferLeft[i] = 0;
      paintbufferRight[i] = 0;
    }

    // paint in the channels.
    for (let ci = 0; ci < total_channels && ci < MAX_CHANNELS; ci++) {
      const ch = channels[ci];
      if (!ch) continue;
      if (!ch.sfx) continue;
      if (!ch.leftvol && !ch.rightvol) continue;

      const sc = S_LoadSound(ch.sfx);
      if (!sc) continue;

      let ltime = paintedtime;

      while (ltime < end) {
        // paint up to end
        const count = ch.end < end ? ch.end - ltime : end - ltime;

        if (count > 0) {
          if (sc.width === 1) SND_PaintChannelFrom8(ch, sc, count);
          else SND_PaintChannelFrom16(ch, sc, count);

          ltime += count;
        }

        // if at end of loop, restart
        if (ltime >= ch.end) {
          if (sc.loopstart >= 0) {
            ch.pos = sc.loopstart;
            ch.end = ltime + sc.length - ch.pos;
          } else {
            // channel just stopped
            ch.sfx = null;
            break;
          }
        }
      }
    }

    // transfer out according to DMA format
    S_TransferPaintBuffer(end);
    setPaintedtime(end);
  }
}

export function SND_InitScaletable(): void {
  for (let i = 0; i < 32; i++) {
    const row = snd_scaletable[i];
    if (!row) continue;
    for (let j = 0; j < 256; j++) {
      const signedJ = j > 127 ? j - 256 : j; // (signed char) j
      row[j] = signedJ * i * 8;
    }
  }
}
