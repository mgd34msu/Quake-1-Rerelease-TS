/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net_vcr.h and WinQuake/net_vcr.c (GNU GPL v2 or later).

net_vcr.c -- the playback half of the VCR (`-playback`/`-record` command line
switches). It reads the file the recording side (net_main.ts's `vcrState`,
`vcrRecordConnect`/`vcrRecordGetMessage`/`vcrRecordSendResult`) writes, and
plays it back to the host so a captured game can be replayed frame-for-frame
without a real network driver underneath.

Deviations from PORTING.md / the C source:
- `net_drivers[0].Init = VCR_Init;` .. `net_drivers[0].Shutdown = VCR_Shutdown;`:
  VCR_Init overwrites `Init`/`SearchForHosts`/`Connect`/`CheckNewConnections`/
  `QGetMessage`/`QSendMessage`/`CanSendMessage`/`Close`/`Shutdown` on
  `net_drivers[0]` -- ported as the same nine assignments, in the same order.
  The C's `VCR_Listen` exists (declared in net_vcr.h, defined below) but is
  never one of the nine slots VCR_Init reassigns, so `net_drivers[0].Listen`
  keeps pointing at the loop driver's `Loop_Listen` (a no-op either way) for
  the whole of a playback run; same for `SendUnreliableMessage`/
  `CanSendUnreliableMessage`, which stay `Loop_SendUnreliableMessage`/
  `Loop_CanSendUnreliableMessage`. This looks like an oversight in the
  original engine (every other driver method got a VCR_* replacement) but
  it is exactly what the shipped C does, so it is kept.
- `static struct { double time; int op; long session; } next;` -> a module-
  level `next` object with the same three fields, read with a `DataView`
  at fixed little-endian offsets (`time` 8 bytes, `op` 4 bytes, `session`
  4 bytes -- 16 bytes total, this port's only target being a 32-bit-`long`
  x86 layout, matching net_main.ts's recording side). `Sys_FileRead`
  (`src/platform/sys.ts`) is used verbatim for both the unconditional read
  in `VCR_Init` (return value ignored, exactly as the C ignores it there)
  and the validated read in `VCR_ReadNext`.
- `int vcrFile`: net_main.c's own global, read by both net_main.c and
  net_vcr.c. This unit's recording side already collapsed it into
  `vcrState` (see net_main.ts's file header); the playback side reuses the
  same object's `playbackHandle` field (a raw `platform/sys.ts` file handle
  number, since `Sys_FileRead` needs one) -- host.c is the C unit that opens
  `quake.vcr` for reading before `NET_Init` runs, and it has not landed yet,
  so nothing in this port currently sets `playbackHandle`; whichever unit
  ports host.c's `-playback` block is expected to call
  `Sys_FileOpenRead("quake.vcr")` and assign the result there. With no
  handle set, `Sys_FileRead` reads zero bytes (its documented behavior on an
  unknown handle), which this file's `VCR_ReadNext` already treats as
  "end of playback".
- `*(long *)(&sock->driverdata) = next.session;` / `next.session !=
  *(long *)(&sock->driverdata)`: the C reinterprets the `void *driverdata`
  pointer slot's bit pattern as a `long` to stash/compare the recorded
  session id. `driverdata` is typed `unknown` on `QsocketT` (net.ts) for
  exactly this kind of per-driver reuse; this driver stores the session id
  in it as a plain `number` and narrows with `typeof === "number"` at every
  read site (no `as` casts), per the standing orders.
- `sock = NET_NewQSocket ();` in `VCR_CheckNewConnections` is followed
  immediately by `*(long *)(&sock->driverdata) = next.session;` with no
  NULL check -- if the qsocket pool were exhausted this would be an
  unchecked NULL dereference in the C. This port cannot dereference `null`,
  so (matching net_loop.ts's `Loop_CheckNewConnections` precedent for the
  same class of C-side unchecked-pointer assumption) it is ported as an
  explicit `Sys_Error` instead of silently returning `null` (which would
  desync playback by skipping a recorded record) or crashing.
- `VCR_GetMessage`'s asymmetry with the recording side is kept as-is: the
  recorder (net_main.ts's `vcrRecordGetMessage`) writes the extra
  `ret`+`len`+message-data trio whenever `NET_GetMessage` returned a value
  greater than 0 (both `ret == 1` and `ret == 2`), but `VCR_GetMessage`
  here only reads that trio back `if (ret == 1)` -- for a recorded `ret == 2`
  (an unreliable message), it falls straight to `VCR_ReadNext()` after
  reading just the 4-byte `ret`, leaving the recorded `len`+data bytes
  unconsumed in the stream. This is a latent bug in the shipped engine
  (the same one PORTING.md's "exactly as the original" rule preserves elsewhere in this
  unit); it is reproduced literally, not fixed.
- `qboolean`-typed `ret` in `VCR_CanSendMessage` is read with the same
  `sizeof(int)`-wide `Sys_FileRead` the C uses (`qboolean` is a plain `enum`
  the same size as `int` in this codebase), then compared `!== 0` for the
  `boolean` return this port's `NetDriverT.CanSendMessage` requires.
- `host_time` (host.c's frame-clock global, read by every one of this
  file's `VCR missmatch` checks) is reached through net_main.ts's
  `getNetHostHooks().hostTime()`, the same hook net_main.ts's own recording
  side uses for the identical field -- see net_main.ts's file header for
  the full `NetHostHooks` contract this unit shares with net_loop.ts and
  net_dgrm.ts.
*/

import { QsocketT, NET_NAMELEN } from "./net";
import type { SizeBuf } from "./sizebuf";
import { net_message } from "./sizebuf";
import { Sys_Error, Sys_FileRead } from "../platform/sys";
import { net_drivers, NET_NewQSocket, vcrState, getNetHostHooks } from "./net_main";

export const VCR_OP_CONNECT = 1;
export const VCR_OP_GETMESSAGE = 2;
export const VCR_OP_SENDMESSAGE = 3;
export const VCR_OP_CANSENDMESSAGE = 4;
export const VCR_MAX_MESSAGE = 4;

// This is the playback portion of the VCR.  It reads the file produced
// by the recorder and plays it back to the host.  The recording contains
// everything necessary (events, timestamps, and data) to duplicate the game
// from the viewpoint of everything above the network layer.
const next = {
  time: 0,
  op: 0,
  session: 0,
};

function vcrHandle(): number {
  // see file header: -1 is "no handle registered", which Sys_FileRead
  // already reports as a zero-byte read.
  return vcrState.playbackHandle ?? -1;
}

function readRecord(dest: { time: number; op: number; session: number }): number {
  const buf = new Uint8Array(16);
  const n = Sys_FileRead(vcrHandle(), buf, 16);
  if (n > 0) {
    const v = new DataView(buf.buffer);
    dest.time = v.getFloat64(0, true);
    dest.op = v.getInt32(8, true);
    dest.session = v.getInt32(12, true);
  }
  return n;
}

function sessionOf(sock: QsocketT): number {
  return typeof sock.driverdata === "number" ? sock.driverdata : 0;
}

function hostTime(): number {
  return getNetHostHooks()?.hostTime() ?? 0;
}

export function VCR_Init(): number {
  net_drivers[0].Init = VCR_Init;

  net_drivers[0].SearchForHosts = VCR_SearchForHosts;
  net_drivers[0].Connect = VCR_Connect;
  net_drivers[0].CheckNewConnections = VCR_CheckNewConnections;
  net_drivers[0].QGetMessage = VCR_GetMessage;
  net_drivers[0].QSendMessage = VCR_SendMessage;
  net_drivers[0].CanSendMessage = VCR_CanSendMessage;
  net_drivers[0].Close = VCR_Close;
  net_drivers[0].Shutdown = VCR_Shutdown;

  readRecord(next); // Sys_FileRead(vcrFile, &next, sizeof(next)); return value ignored, exactly as the C
  return 0;
}

function VCR_ReadNext(): void {
  if (readRecord(next) === 0) {
    next.op = 255;
    Sys_Error("=== END OF PLAYBACK===\n");
  }
  if (next.op < 1 || next.op > VCR_MAX_MESSAGE) Sys_Error("VCR_ReadNext: bad op");
}

export function VCR_Listen(_state: boolean): void {
  //
}

export function VCR_Shutdown(): void {
  //
}

export function VCR_GetMessage(sock: QsocketT): number {
  if (hostTime() !== next.time || next.op !== VCR_OP_GETMESSAGE || next.session !== sessionOf(sock)) Sys_Error("VCR missmatch");

  const retBuf = new Uint8Array(4);
  Sys_FileRead(vcrHandle(), retBuf, 4);
  const ret = new DataView(retBuf.buffer).getInt32(0, true);
  if (ret !== 1) {
    VCR_ReadNext();
    return ret;
  }

  const lenBuf = new Uint8Array(4);
  Sys_FileRead(vcrHandle(), lenBuf, 4);
  net_message.cursize = new DataView(lenBuf.buffer).getInt32(0, true);
  Sys_FileRead(vcrHandle(), net_message.data, net_message.cursize);

  VCR_ReadNext();

  return 1;
}

export function VCR_SendMessage(sock: QsocketT, _data: SizeBuf): number {
  if (hostTime() !== next.time || next.op !== VCR_OP_SENDMESSAGE || next.session !== sessionOf(sock)) Sys_Error("VCR missmatch");

  const retBuf = new Uint8Array(4);
  Sys_FileRead(vcrHandle(), retBuf, 4);
  const ret = new DataView(retBuf.buffer).getInt32(0, true);

  VCR_ReadNext();

  return ret;
}

export function VCR_CanSendMessage(sock: QsocketT): boolean {
  if (hostTime() !== next.time || next.op !== VCR_OP_CANSENDMESSAGE || next.session !== sessionOf(sock)) Sys_Error("VCR missmatch");

  const retBuf = new Uint8Array(4);
  Sys_FileRead(vcrHandle(), retBuf, 4);
  const ret = new DataView(retBuf.buffer).getInt32(0, true) !== 0;

  VCR_ReadNext();

  return ret;
}

export function VCR_Close(_sock: QsocketT): void {
  //
}

export function VCR_SearchForHosts(_xmit: boolean): void {
  //
}

export function VCR_Connect(_host: string | null): QsocketT | null {
  return null;
}

export function VCR_CheckNewConnections(): QsocketT | null {
  if (hostTime() !== next.time || next.op !== VCR_OP_CONNECT) Sys_Error("VCR missmatch");

  if (!next.session) {
    VCR_ReadNext();
    return null;
  }

  const sock = NET_NewQSocket();
  // see file header: the C dereferences an unchecked NULL here.
  if (sock === null) Sys_Error("VCR_CheckNewConnections: no qsocket available");
  sock.driverdata = next.session;

  const addrBuf = new Uint8Array(NET_NAMELEN);
  Sys_FileRead(vcrHandle(), addrBuf, NET_NAMELEN);
  let end = addrBuf.indexOf(0);
  if (end === -1) end = addrBuf.length;
  let address = "";
  for (let i = 0; i < end; i++) address += String.fromCharCode(addrBuf[i]);
  sock.address = address;

  VCR_ReadNext();

  return sock;
}
