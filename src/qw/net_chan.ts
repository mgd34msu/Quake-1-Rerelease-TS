/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/net_chan.c and its half of QW/client/net.h (the
netchan_t struct, Netchan_* prototypes, net_drop, OLD_AVG, MAX_LATENT --
GNU GPL v2 or later).

Q003. Adapted from ../quake-2-ts/src/qcommon/net_chan.ts for the general
module shape (a NetchanT class plus the Netchan_* free functions, cvars via
Cvar_RegisterVariable-style registration, a showpackets/showdrop print
style) -- QW/server's own net_chan.c does not exist; QW/server/makefile
compiles ../client/net_chan.c directly with SERVERONLY defined, so this one
module (like the C) serves both qwcl and qwsv. Confirmed by reading
QW/server/makefile and finding no server-side net_chan.c.

Deviations from the brief / from Quake 2's net_chan.ts:
- MAX_MSGLEN is imported from './bothdefs' (value 1450, bothdefs.h:71).
  src/qw/bothdefs.ts did not exist when this unit started (no src/qw/
  directory existed at all), which would have been the SCOPE-sanctioned
  acceptable-missing-module situation the brief anticipates -- a concurrent
  unit landed it during this session, confirmed to export the same value
  read directly from bothdefs.h, so the import is used as originally
  intended rather than kept as a local fallback.
- netchan_t's field names and Netchan_Process's drop bookkeeping are ported
  exactly as read from net.h/net_chan.c, which differ from what the brief's
  hedged prose guessed: there is no `chan->dropped` field (the brief's TESTS
  section says "dropped counts a gap", but the real struct only has
  `drop_count`, incremented by exactly 1 per drop event -- never by the gap
  size). The gap size itself lands in `net_drop`, a *module-level* global
  (`extern int net_drop;` in net.h), not a per-channel field. Ported
  exactly as the original: `net_drop` is this module's exported mutable binding;
  `chan.drop_count` only ever counts events. Likewise the two ring-buffer
  fields are named `outgoing_size`/`outgoing_time` in the real struct (the
  brief guessed "incoming_size/incoming_time"); both are written in
  Netchan_Transmit and read only inside the C's own `#if 0` rate-estimator
  block in Netchan_Process, which is dropped per PORTING.md's dead-code rule.
- `#ifndef SERVERONLY`/`#ifdef SERVERONLY` (net_chan.c is compiled twice,
  once per binary, with opposite senses of this define) becomes the runtime
  flag `netchanState.isClient`, per the brief's own ruling. It, plus
  `netchanState.demoplayback` (stands in for `cls.demoplayback`) and
  `netchanState.realtime` (stands in for the bare global `realtime` this
  file reads directly), are set by the QW entry points (src/qw/main_cl.ts /
  src/qw/main_sv.ts) once per frame -- neither is landed yet, so this module
  starts with isClient defaulting true (qwcl's sense) and realtime at 0;
  every exported function reads these fresh on each call, so a caller
  driving them by hand (as the tests do) sees an accurate result.
- `MSG_WriteShort (&send, cls.qport)` reads `qport.value` (this module's own
  registered cvar) instead of a `cls.qport` field. QW/client/cl_main.c:214
  sets `cls.qport = Cvar_VariableValue("qport")` once and never reassigns
  it, so the cvar is the authoritative source cls.qport merely mirrors;
  ClientStaticT's QW extension is not landed, so there is no `cls.qport`
  field to read regardless.
- `#ifdef SERVERONLY if (ServerPaused()) chan->cleartime = realtime;` has no
  home yet (ServerPaused lives in QW/server/sv_main.c, far outside this
  unit's scope). Ported via a registrable hook, `setNetchanServerHooks`,
  matching the existing `setCvarServerHooks` precedent in src/common/
  cvar.ts; with no hook installed (the current state) this branch is simply
  never taken, which is a correct no-op until sv_main.ts lands and installs
  one.
- CvarT is src/common/cvar.ts's class (name, string, archive, server, value,
  next, plus the QuakeWorld-track `flags` field a concurrent unit added
  during this session). showpackets/showdrop/qport are constructed with the
  plain four-arg constructor (no `flags` argument), matching the real C's
  `cvar_t showpackets = {"showpackets", "0"}` initializer, which likewise
  leaves every field but name/string at its zero default.
- Netchan_Init's port RNG (`((int)(getpid()+getuid()*1000) * time(NULL)) &
  0xffff` on Linux, `timeGetTime()*1000 * time(NULL)) & 0xffff` on Windows)
  becomes `Math.floor(Math.random() * 0x10000)`, per the brief's own ruling:
  same 0-65535 output range, no seeded-determinism requirement.
*/

import { NetadrT, copyNetadr, net_from, NET_SendPacket, NET_AdrToString, NET_CompareAdr } from "./net_udp";
import { SizeBuf, SZ_Write, MSG_WriteLong, MSG_WriteShort, MSG_BeginReading, MSG_ReadLong, MSG_ReadShort, net_message } from "../common/sizebuf";
import { CvarT, Cvar_RegisterVariable, Cvar_SetValue } from "../common/cvar";
import { Con_Printf } from "../client/console";
import { Com_sprintf } from "../common/sprintf";
import { MAX_MSGLEN } from "./bothdefs";

const PACKET_HEADER = 8;

const OLD_AVG = 0.99; // total = oldtotal*OLD_AVG + new*(1-OLD_AVG)
const MAX_LATENT = 32;

/*

packet header
-------------
31	sequence
1	does this message contain a reliable payload
31	acknowledge sequence
1	acknowledge receipt of even/odd message
16  qport

The remote connection never knows if it missed a reliable message, the
local side detects that it has been dropped by seeing a sequence acknowledge
higher thatn the last reliable sequence, but without the correct evon/odd
bit for the reliable set.

If the sender notices that a reliable message has been dropped, it will be
retransmitted.  It will not be retransmitted again until a message after
the retransmit has been acknowledged and the reliable still failed to get there.

if the sequence number is -1, the packet should be handled without a netcon

The reliable message can be added to at any time by doing
MSG_Write* (&netchan->message, <data>).

If the message buffer is overflowed, either by a single message, or by
multiple frames worth piling up while the last reliable transmit goes
unacknowledged, the netchan signals a fatal error.

Reliable messages are allways placed first in a packet, then the unreliable
message is included if there is sufficient room.

To the receiver, there is no distinction between the reliable and unreliable
parts of the message, they are just processed out as a single larger message.

Illogical packet sequence numbers cause the packet to be dropped, but do
not kill the connection.  This, combined with the tight window of valid
reliable acknowledgement numbers provides protection against malicious
address spoofing.

The qport field is a workaround for bad address translating routers that
sometimes remap the client's source port on a packet during gameplay.

If the base part of the net address matches and the qport matches, then the
channel matches even if the IP port differs.  The IP port should be updated
to the new value before sending out any replies.

*/

// #ifndef SERVERONLY / #ifdef SERVERONLY, and the globals net_chan.c reads
// directly (realtime, cls.demoplayback) -- see file header.
export const netchanState = {
  isClient: true,
  demoplayback: false,
  realtime: 0,
};

export interface NetchanServerHooks {
  isPaused(): boolean;
}

let serverHooks: NetchanServerHooks | null = null;
export function setNetchanServerHooks(h: NetchanServerHooks | null): void {
  serverHooks = h;
}

export let net_drop = 0; // packets dropped before this one

// net_drop is an exported `let`: TS forbids assigning to an imported binding
// from another module, but QW/server/sv_user.c's replay loop
// (`while (net_drop > 2) { ...; net_drop--; }`) decrements the real global
// in place, not a local copy. This setter lets sv_user.ts do the same.
export function setNetDrop(n: number): void {
  net_drop = n;
}

export const showpackets = new CvarT("showpackets", "0");
export const showdrop = new CvarT("showdrop", "0");
export const qport = new CvarT("qport", "0");

// netchan_t
export class NetchanT {
  fatal_error = false;

  last_received = 0; // for timeouts

  // the statistics are cleared at each client begin, because
  // the server connecting process gives a bogus picture of the data
  frame_latency = 0; // rolling average
  frame_rate = 0;

  drop_count = 0; // dropped packets, cleared each level
  good_count = 0; // cleared each level

  remote_address: NetadrT = new NetadrT();
  qport = 0;

  // bandwidth estimator
  cleartime = 0; // if realtime > nc->cleartime, free to go
  rate = 0; // seconds / byte

  // sequencing variables
  incoming_sequence = 0;
  incoming_acknowledged = 0;
  incoming_reliable_acknowledged = 0; // single bit

  incoming_reliable_sequence = 0; // single bit, maintained local

  outgoing_sequence = 0;
  reliable_sequence = 0; // single bit
  last_reliable_sequence = 0; // sequence number of last send

  // reliable staging and holding areas
  message: SizeBuf = new SizeBuf(); // writing buffer to send to server
  message_buf: Uint8Array = new Uint8Array(MAX_MSGLEN);

  reliable_length = 0;
  reliable_buf: Uint8Array = new Uint8Array(MAX_MSGLEN); // unacked reliable message

  // time and size data to calculate bandwidth
  outgoing_size: number[] = new Array(MAX_LATENT).fill(0);
  outgoing_time: number[] = new Array(MAX_LATENT).fill(0);
}

function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/*
===============
Netchan_Init

===============
*/
export function Netchan_Init(): void {
  // pick a port value that should be nice and random -- see file header
  const port = Math.floor(Math.random() * 0x10000);

  Cvar_RegisterVariable(showpackets);
  Cvar_RegisterVariable(showdrop);
  Cvar_RegisterVariable(qport);
  Cvar_SetValue("qport", port);
}

/*
===============
Netchan_OutOfBand

Sends an out-of-band datagram
================
*/
export function Netchan_OutOfBand(adr: NetadrT, length: number, data: Uint8Array): void {
  const send = new SizeBuf();
  const send_buf = new Uint8Array(MAX_MSGLEN + PACKET_HEADER);

  // write the packet header
  send.data = send_buf;
  send.maxsize = send_buf.length;
  send.cursize = 0;

  MSG_WriteLong(send, -1); // -1 sequence means out of band
  SZ_Write(send, data, length);

  // send the datagram
  // zoid, no input in demo playback mode
  if (!(netchanState.isClient && netchanState.demoplayback)) {
    NET_SendPacket(send.cursize, send.data, adr);
  }
}

/*
===============
Netchan_OutOfBandPrint

Sends a text message in an out-of-band datagram
================
*/
export function Netchan_OutOfBandPrint(adr: NetadrT, format: string, ...args: Array<string | number>): void {
  const s = Com_sprintf(format, ...args);
  Netchan_OutOfBand(adr, s.length, stringToBytes(s));
}

/*
==============
Netchan_Setup

called to open a channel to a remote system
==============
*/
export function Netchan_Setup(chan: NetchanT, adr: NetadrT, qportNum: number): void {
  // memset (chan, 0, sizeof(*chan));
  chan.fatal_error = false;
  chan.last_received = 0;
  chan.frame_latency = 0;
  chan.frame_rate = 0;
  chan.drop_count = 0;
  chan.good_count = 0;
  chan.qport = 0;
  chan.cleartime = 0;
  chan.rate = 0;
  chan.incoming_sequence = 0;
  chan.incoming_acknowledged = 0;
  chan.incoming_reliable_acknowledged = 0;
  chan.incoming_reliable_sequence = 0;
  chan.outgoing_sequence = 0;
  chan.reliable_sequence = 0;
  chan.last_reliable_sequence = 0;
  chan.reliable_length = 0;
  // message_buf/reliable_buf are inline arrays in netchan_t and message is an
  // inline sizebuf_t, so the memset zeroes them where they are: their addresses
  // survive the call and anything holding one stays pointed at the live buffer.
  // src/qw/cmd.ts caches this SizeBuf as qwCmdHooks.netchanMessage and
  // CL_PlayDemo_f's Netchan_Setup call does not re-point it, so replacing the
  // objects here would leave that hook aimed at a detached buffer.
  chan.message_buf.fill(0);
  chan.reliable_buf.fill(0);
  chan.outgoing_size.fill(0);
  chan.outgoing_time.fill(0);

  // `chan->remote_address = adr;` is a struct copy in the C -- see
  // net_udp.ts's copyNetadr
  chan.remote_address = copyNetadr(adr);
  chan.last_received = netchanState.realtime;

  chan.message.data = chan.message_buf;
  chan.message.allowoverflow = true;
  chan.message.maxsize = chan.message_buf.length;
  chan.message.cursize = 0;
  chan.message.overflowed = false;

  chan.qport = qportNum;

  chan.rate = 1.0 / 2500;
}

/*
===============
Netchan_CanPacket

Returns true if the bandwidth choke isn't active
================
*/
const MAX_BACKUP = 200;
export function Netchan_CanPacket(chan: NetchanT): boolean {
  return chan.cleartime < netchanState.realtime + MAX_BACKUP * chan.rate;
}

/*
===============
Netchan_CanReliable

Returns true if the bandwidth choke isn't
================
*/
export function Netchan_CanReliable(chan: NetchanT): boolean {
  if (chan.reliable_length) return false; // waiting for ack
  return Netchan_CanPacket(chan);
}

/*
===============
Netchan_Transmit

tries to send an unreliable message to a connection, and handles the
transmition / retransmition of the reliable messages.

A 0 length will still generate a packet and deal with the reliable messages.
================
*/
export function Netchan_Transmit(chan: NetchanT, length: number, data: Uint8Array): void {
  // check for message overflow
  if (chan.message.overflowed) {
    chan.fatal_error = true;
    Con_Printf("%s:Outgoing message overflow\n", NET_AdrToString(chan.remote_address));
    return;
  }

  // if the remote side dropped the last reliable message, resend it
  let send_reliable = false;

  if (chan.incoming_acknowledged > chan.last_reliable_sequence && chan.incoming_reliable_acknowledged !== chan.reliable_sequence) {
    send_reliable = true;
  }

  // if the reliable transmit buffer is empty, copy the current message out
  if (!chan.reliable_length && chan.message.cursize) {
    chan.reliable_buf.set(chan.message_buf.subarray(0, chan.message.cursize));
    chan.reliable_length = chan.message.cursize;
    chan.message.cursize = 0;
    chan.reliable_sequence ^= 1;
    send_reliable = true;
  }

  // write the packet header
  const send = new SizeBuf();
  const send_buf = new Uint8Array(MAX_MSGLEN + PACKET_HEADER);
  send.data = send_buf;
  send.maxsize = send_buf.length;
  send.cursize = 0;

  const w1 = (chan.outgoing_sequence | (send_reliable ? 1 << 31 : 0)) | 0;
  const w2 = (chan.incoming_sequence | (chan.incoming_reliable_sequence << 31)) | 0;

  chan.outgoing_sequence++;

  MSG_WriteLong(send, w1);
  MSG_WriteLong(send, w2);

  // send the qport if we are a client
  if (netchanState.isClient) {
    MSG_WriteShort(send, qport.value); // cls.qport -- see file header
  }

  // copy the reliable message to the packet first
  if (send_reliable) {
    SZ_Write(send, chan.reliable_buf, chan.reliable_length);
    chan.last_reliable_sequence = chan.outgoing_sequence;
  }

  // add the unreliable part if space is available
  if (send.maxsize - send.cursize >= length) {
    SZ_Write(send, data, length);
  }

  // send the datagram
  const i = chan.outgoing_sequence & (MAX_LATENT - 1);
  chan.outgoing_size[i] = send.cursize;
  chan.outgoing_time[i] = netchanState.realtime;

  // zoid, no input in demo playback mode
  if (!(netchanState.isClient && netchanState.demoplayback)) {
    NET_SendPacket(send.cursize, send.data, chan.remote_address);
  }

  if (chan.cleartime < netchanState.realtime) {
    chan.cleartime = netchanState.realtime + send.cursize * chan.rate;
  } else {
    chan.cleartime += send.cursize * chan.rate;
  }

  // #ifdef SERVERONLY if (ServerPaused()) chan->cleartime = realtime; -- see file header
  if (!netchanState.isClient && serverHooks && serverHooks.isPaused()) {
    chan.cleartime = netchanState.realtime;
  }

  if (showpackets.value) {
    Con_Printf(
      "--> s=%i(%i) a=%i(%i) %i\n",
      chan.outgoing_sequence,
      send_reliable ? 1 : 0,
      chan.incoming_sequence,
      chan.incoming_reliable_sequence,
      send.cursize,
    );
  }
}

/*
=================
Netchan_Process

called when the current net_message is from remote_address
modifies net_message so that it points to the packet payload
=================
*/
export function Netchan_Process(chan: NetchanT): boolean {
  // #ifndef SERVERONLY if (!cls.demoplayback && !NET_CompareAdr(...)) return false;
  // #ifdef SERVERONLY (the compiled server build) always does the plain
  // compare. RULING (unit brief): one expression covers both senses of the
  // define -- see file header for how netchanState substitutes for cls.
  if (!(netchanState.isClient && netchanState.demoplayback) && !NET_CompareAdr(net_from, chan.remote_address)) {
    return false;
  }

  // get sequence numbers
  MSG_BeginReading();
  let sequence = MSG_ReadLong();
  let sequence_ack = MSG_ReadLong();

  // read the qport if we are a server
  if (!netchanState.isClient) {
    MSG_ReadShort(); // qport -- read and discarded; see file header
  }

  const reliable_message = (sequence >>> 31) & 1;
  const reliable_ack = (sequence_ack >>> 31) & 1;

  sequence = sequence & ~(1 << 31);
  sequence_ack = sequence_ack & ~(1 << 31);

  if (showpackets.value) {
    Con_Printf("<-- s=%i(%i) a=%i(%i) %i\n", sequence, reliable_message, sequence_ack, reliable_ack, net_message.cursize);
  }

  // get a rate estimation -- #if 0'd out in the C; dropped, per PORTING.md

  //
  // discard stale or duplicated packets
  //
  if (sequence <= chan.incoming_sequence) {
    if (showdrop.value) {
      Con_Printf("%s:Out of order packet %i at %i\n", NET_AdrToString(chan.remote_address), sequence, chan.incoming_sequence);
    }
    return false;
  }

  //
  // dropped packets don't keep the message from being used
  //
  net_drop = sequence - (chan.incoming_sequence + 1);
  if (net_drop > 0) {
    chan.drop_count += 1;

    if (showdrop.value) {
      Con_Printf("%s:Dropped %i packets at %i\n", NET_AdrToString(chan.remote_address), sequence - (chan.incoming_sequence + 1), sequence);
    }
  }

  //
  // if the current outgoing reliable message has been acknowledged
  // clear the buffer to make way for the next
  //
  if (reliable_ack === chan.reliable_sequence) {
    chan.reliable_length = 0; // it has been received
  }

  //
  // if this message contains a reliable message, bump incoming_reliable_sequence
  //
  chan.incoming_sequence = sequence;
  chan.incoming_acknowledged = sequence_ack;
  chan.incoming_reliable_acknowledged = reliable_ack;
  if (reliable_message) {
    chan.incoming_reliable_sequence ^= 1;
  }

  //
  // the message can now be read from the current message pointer
  // update statistics counters
  //
  chan.frame_latency = chan.frame_latency * OLD_AVG + (chan.outgoing_sequence - sequence_ack) * (1.0 - OLD_AVG);
  chan.frame_rate = chan.frame_rate * OLD_AVG + (netchanState.realtime - chan.last_received) * (1.0 - OLD_AVG);
  chan.good_count += 1;

  chan.last_received = netchanState.realtime;

  return true;
}
