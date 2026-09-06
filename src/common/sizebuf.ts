/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/common.h and WinQuake/common.c (GNU GPL v2 or later).

sizebuf_t and the SZ_ / MSG_ halves of common.h/common.c -- PORTING.md's
directory map splits these into their own module; the rest of common.c is
src/common/common.ts.

Deviations from PORTING.md / the C source:
- SZ_Alloc's `Hunk_AllocName` call becomes a plain `new Uint8Array(startsize)`.
  zone.ts (Hunk_, Cache_, Z_, U007) is concurrent and out of this unit's
  scope; PORTING.md's own Memory section says the finished Hunk_AllocName is
  itself just an "allocation-free wrapper" around a fresh typed array, so a
  direct allocation here is the same observable behavior. SZ_Free's body is
  the C's own commented-out `Z_Free` call plus `cursize = 0`; nothing to drop.
- `net_message` is `extern sizebuf_t net_message;` in net_main.c, not
  common.c/common.h, but MSG_Read* read it and common.h forward-declares the
  sizebuf_t type it needs. The unit brief places the singleton here so
  net_main.ts (not yet landed) imports it rather than redeclaring it.
- `msg_readcount`/`msg_badread` are separate reassignable globals in the C
  (not sizebuf_t fields, unlike the sibling Quake 2 port's SizeBuf.readcount).
  The unit brief packs them into one exported holder object, `msgState`,
  since a bare `export let` binding cannot be reassigned through another
  module's import the way C's `extern int` can.
- MSG_WriteFloat/MSG_ReadFloat's C implementation reinterprets the same 4
  bytes through a `union { float f; int l; }` and then runs the bits through
  LittleLong (a no-op on the little-endian hosts this port targets --
  BigLong/LittleLong live in common.ts, fixed at little-endian per its own
  unit brief). `DataView#setFloat32`/`getFloat32` with the little-endian flag
  forced true reproduces the exact same 4 bytes without needing to import
  anything from common.ts.
- MSG_ReadFloat has no bounds check in the C (unlike ReadChar/Byte/Short/
  Long, which all set msg_badread and return -1 past cursize) -- ported
  exactly as the original: no check here either. Where the C would then read whatever
  bytes happen to sit past cursize (still inside the allocated buffer, since
  SZ_Alloc's allocation is `maxsize` bytes), this port reads the same way but
  substitutes 0 for indices past `net_message.data`'s own length (JS typed
  arrays return `undefined` for an out-of-range index rather than aliasing
  adjacent memory), which is a strictly safer, disclosed substitute for the
  C's undefined behavior in the case where readcount+4 exceeds even maxsize.
- `#ifdef PARANOID` range checks in MSG_WriteChar/WriteByte/WriteShort are
  undefined in a normal WinQuake build (PARANOID is never defined) and are
  dropped, per PORTING.md's "take the portable, non-asm path" / dead-define
  rule.
- SZ_Print's `if (buf->data[buf->cursize-1])` reads one byte before the
  allocated buffer when cursize==0 -- undefined behavior in the C. This port
  takes the same branch a nonzero (garbage) read would have taken: cursize==0
  means there is no prior trailing NUL to overwrite, so it always appends
  fresh in that case.
- MSG_ReadString's `if (c == -1 || c == 0) break;` (c from MSG_ReadChar,
  which returns `(signed char)` of the raw byte) means a string byte whose
  raw value is 0xFF reads back as -1 and is indistinguishable from "no more
  data" -- MSG_ReadString stops there. This is the C's actual behavior, not
  a porting bug, and is preserved exactly as the C has it; see test/sizebuf.test.ts.
*/

import { Sys_Error } from "../platform/sys";
import { Con_Printf } from "../client/console";

export class SizeBuf {
  allowoverflow = false; // if false, do a Sys_Error
  overflowed = false; // set to true if the buffer size failed
  data: Uint8Array = new Uint8Array(0);
  maxsize = 0;
  cursize = 0;
}

export function SZ_Alloc(buf: SizeBuf, startsize: number): void {
  if (startsize < 256) startsize = 256;
  buf.data = new Uint8Array(startsize);
  buf.maxsize = startsize;
  buf.cursize = 0;
}

export function SZ_Free(buf: SizeBuf): void {
  //      Z_Free (buf->data);
  //      buf->data = NULL;
  //      buf->maxsize = 0;
  buf.cursize = 0;
}

export function SZ_Clear(buf: SizeBuf): void {
  buf.cursize = 0;
}

// Returns the byte offset the caller should write `length` bytes at,
// mirroring the C `void *SZ_GetSpace` return value (buf->data + buf->cursize).
export function SZ_GetSpace(buf: SizeBuf, length: number): number {
  if (buf.cursize + length > buf.maxsize) {
    if (!buf.allowoverflow) Sys_Error("SZ_GetSpace: overflow without allowoverflow set");

    if (length > buf.maxsize) Sys_Error("SZ_GetSpace: %i is > full buffer size", length);

    buf.overflowed = true;
    Con_Printf("SZ_GetSpace: overflow");
    SZ_Clear(buf);
  }

  const offset = buf.cursize;
  buf.cursize += length;

  return offset;
}

export function SZ_Write(buf: SizeBuf, data: Uint8Array, length: number): void {
  const offset = SZ_GetSpace(buf, length);
  buf.data.set(data.subarray(0, length), offset);
}

// strcats onto the sizebuf
export function SZ_Print(buf: SizeBuf, data: string): void {
  const bytes = stringToBytesNulTerminated(data);
  const len = bytes.length; // Q_strlen(data)+1

  // byte * cast to keep VC++ happy
  //
  // buf->data[buf->cursize-1] is undefined behavior in the C when
  // cursize==0 (it reads one byte before the allocated buffer). This port
  // takes the same branch a nonzero read would have taken -- there is no
  // prior trailing NUL to overwrite, so append fresh.
  if (buf.cursize === 0 || buf.data[buf.cursize - 1]) {
    const offset = SZ_GetSpace(buf, len); // no trailing 0
    buf.data.set(bytes, offset);
  } else {
    const offset = SZ_GetSpace(buf, len - 1) - 1; // write over trailing 0
    buf.data.set(bytes, offset);
  }
}

//============================================================================
// byte <-> string helpers (C treats these as raw bytes, not UTF-8; Quake's
// text uses the high-bit colored character set, so this is Latin-1, never
// TextEncoder/TextDecoder)

function stringToBytesNulTerminated(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  out[s.length] = 0;
  return out;
}

//============================================================================
// writing functions

export function MSG_WriteChar(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 1);
  sb.data[offset] = c & 0xff;
}

export function MSG_WriteByte(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 1);
  sb.data[offset] = c & 0xff;
}

export function MSG_WriteShort(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 2);
  sb.data[offset] = c & 0xff;
  sb.data[offset + 1] = (c >> 8) & 0xff;
}

export function MSG_WriteLong(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 4);
  sb.data[offset] = c & 0xff;
  sb.data[offset + 1] = (c >> 8) & 0xff;
  sb.data[offset + 2] = (c >> 16) & 0xff;
  sb.data[offset + 3] = c >> 24;
}

const writeFloatScratch = new Uint8Array(4);
const writeFloatScratchView = new DataView(writeFloatScratch.buffer);

export function MSG_WriteFloat(sb: SizeBuf, f: number): void {
  writeFloatScratchView.setFloat32(0, f, true); // dat.f = f; dat.l = LittleLong(dat.l);
  SZ_Write(sb, writeFloatScratch, 4);
}

export function MSG_WriteString(sb: SizeBuf, s: string | null): void {
  if (!s) {
    SZ_Write(sb, new Uint8Array([0]), 1);
  } else {
    const bytes = stringToBytesNulTerminated(s);
    SZ_Write(sb, bytes, bytes.length);
  }
}

export function MSG_WriteCoord(sb: SizeBuf, f: number): void {
  MSG_WriteShort(sb, Math.trunc(f * 8)); // (int)(f*8)
}

export function MSG_WriteAngle(sb: SizeBuf, f: number): void {
  // ((int)f*256/360) & 255
  const t = Math.trunc(f);
  MSG_WriteByte(sb, Math.trunc((t * 256) / 360) & 255);
}

//
// reading functions
//

// net_message is declared in net_main.c in the original source; the reading
// side of MSG_* reads it, so it lives here (see file header).
export const net_message = new SizeBuf();

// msg_readcount/msg_badread packed into one holder (see file header).
export const msgState = { readcount: 0, badread: false };

export function MSG_BeginReading(): void {
  msgState.readcount = 0;
  msgState.badread = false;
}

// returns -1 and sets msg_badread if no more characters are available
export function MSG_ReadChar(): number {
  if (msgState.readcount + 1 > net_message.cursize) {
    msgState.badread = true;
    return -1;
  }

  const b = net_message.data[msgState.readcount];
  const c = (b << 24) >> 24; // (signed char)
  msgState.readcount++;

  return c;
}

export function MSG_ReadByte(): number {
  if (msgState.readcount + 1 > net_message.cursize) {
    msgState.badread = true;
    return -1;
  }

  const c = net_message.data[msgState.readcount]; // (unsigned char)
  msgState.readcount++;

  return c;
}

export function MSG_ReadShort(): number {
  if (msgState.readcount + 2 > net_message.cursize) {
    msgState.badread = true;
    return -1;
  }

  const b0 = net_message.data[msgState.readcount];
  const b1 = net_message.data[msgState.readcount + 1];
  const c = ((b0 + (b1 << 8)) << 16) >> 16; // (short)

  msgState.readcount += 2;

  return c;
}

export function MSG_ReadLong(): number {
  if (msgState.readcount + 4 > net_message.cursize) {
    msgState.badread = true;
    return -1;
  }

  const b0 = net_message.data[msgState.readcount];
  const b1 = net_message.data[msgState.readcount + 1];
  const b2 = net_message.data[msgState.readcount + 2];
  const b3 = net_message.data[msgState.readcount + 3];
  const c = (b0 + (b1 << 8) + (b2 << 16) + (b3 << 24)) | 0;

  msgState.readcount += 4;

  return c;
}

const readFloatScratch = new Uint8Array(4);
const readFloatScratchView = new DataView(readFloatScratch.buffer);

// No bounds check in the C -- see file header.
export function MSG_ReadFloat(): number {
  readFloatScratch[0] = net_message.data[msgState.readcount] ?? 0;
  readFloatScratch[1] = net_message.data[msgState.readcount + 1] ?? 0;
  readFloatScratch[2] = net_message.data[msgState.readcount + 2] ?? 0;
  readFloatScratch[3] = net_message.data[msgState.readcount + 3] ?? 0;
  msgState.readcount += 4;

  return readFloatScratchView.getFloat32(0, true); // dat.l = LittleLong(dat.l); return dat.f;
}

export function MSG_ReadString(): string {
  let s = "";
  let l = 0;

  do {
    const c = MSG_ReadChar();
    if (c === -1 || c === 0) break;
    s += String.fromCharCode(c & 0xff);
    l++;
  } while (l < 2048 - 1);

  return s;
}

export function MSG_ReadCoord(): number {
  return MSG_ReadShort() * (1.0 / 8);
}

export function MSG_ReadAngle(): number {
  return MSG_ReadChar() * (360.0 / 256);
}
