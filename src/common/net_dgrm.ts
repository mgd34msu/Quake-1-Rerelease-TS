/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net_dgrm.h and WinQuake/net_dgrm.c (GNU GPL v2 or later).

net_dgrm.c -- the "Datagram" network driver: reliable/unreliable messaging
and the CCREQ_* / CCREP_* connection handshake, layered over whichever LAN
drivers are registered in net_main.ts's `net_landrivers[]` (net_udp.ts, U010,
registers the one this port ships).

Deviations from PORTING.md / the C source:
- `#define BAN_TEST` is unconditional at the top of net_dgrm.c, and its
  `#ifdef BAN_TEST` block's `#else` branch (neither `_WIN32` nor `NeXT`) is
  the one a Linux build takes -- hand-rolled `AF_INET`/`in_addr`/
  `sockaddr_in` declarations plus `inet_ntoa`/`inet_addr` prototypes, used
  only so `NET_Ban_f` and the ban check in `_Datagram_CheckNewConnections`
  can read/format a raw IPv4 address without pulling in real socket headers.
  Ported as `AF_INET = 2`, a `sockaddrInAddr` helper that reads the 4 address
  bytes out of a `QsockaddrT`'s `sa_data[2..5]` (net.ts's documented layout),
  and small local `inet_ntoa`/`inet_addr` (dotted-quad string <-> `number`)
  functions -- this port has no socket headers to fall back on either way.
  The BAN_TEST feature itself (`banAddr`/`banMask`, `NET_Ban_f`, the ban
  check) is kept, per the unit brief: it is compiled into every real Linux
  build of this engine.
- `sv.active`, `sv.name`, `svs.maxclients`, `svs.clients[]`,
  `pr_global_struct->deathmatch`, `host_client->privileged`,
  `SV_ClientPrintf`, `SCR_UpdateScreen`, and the menu globals reached from
  `_Datagram_Connect`'s error path are all reached through net_main.ts's
  `getNetHostHooks()` -- see that file's header for the full hook contract
  this module shares with net_loop.ts and net_vcr.ts.
- `int *((int *)net_message.data) = BigLong(NETFLAG_CTL | ...)`: every one
  of this file's many "go back and patch the 4-byte header now that the
  message body is known" sites (there is no equivalent single spot to do it
  up front, since the length isn't known until the body is written) uses one
  local helper, `writeControlHeader`, and the paired
  `control = BigLong(*((int *)net_message.data)); MSG_ReadLong();` read
  sites (advance the cursor by 4 *without* using `MSG_ReadLong`'s
  little-endian return value -- the control header is transmitted
  big-endian) use `peekControlHeader`.
- `struct { unsigned int length; unsigned int sequence; byte
  data[MAX_DATAGRAM]; } packetBuffer` -> `PacketBufferT`, a class over one
  `Uint8Array(NET_DATAGRAMSIZE)` with `length`/`sequence` accessor
  properties that apply `BigLong` on the way in and out (so call sites read
  exactly like the C: `packetBuffer.length = packetLen | flags;` stores the
  big-endian wire bytes) and a `data` getter returning the
  `NET_HEADERSIZE`-offset subarray view.
- `qsocket_t *driverdata`/`void *driverdata` is not used by this driver
  (only net_loop.c and net_vcr.c use it); nothing here reads or writes it.
- `NET_Ban_f`'s `void (*print)(char *fmt, ...)` C-function-pointer-to-either-
  `Con_Printf`-or-`SV_ClientPrintf` becomes a plain
  `(fmt: string, ...args: Array<string | number>) => void` local variable,
  the same shape both functions already have.
- The hostcache name-collision loop (`_Datagram_SearchForHosts`'s trailing
  `for` loop) mutates the C's fixed `char name[16]` buffer in place,
  including a deliberate no-carry quirk: colliding with an existing name
  appends a `'0'` digit if there's room and the current last character is
  past `'8'` (which is true for `'9'` *and* every letter, since letters sort
  higher in ASCII), otherwise it just increments the last character's ASCII
  value by one (no carry into the next digit on a `'9'`). Ported literally
  via an explicit char-array split/join, preserving the same quirk, and the
  same `i = -1` restart-the-whole-scan-from-0 idiom the C uses after each
  rename (a fresh suffix can collide with an entry the scan already passed).
- `Q_strlen`/`Q_strcpy`/`Q_strcat`/`Q_memcpy` (dropped, no meaning for JS
  strings/typed arrays -- see common.ts's file header) are replaced with
  plain string ops / `Uint8Array.set`/`.subarray` throughout.
*/

import {
  QsocketT,
  QsockaddrT,
  NetDriverT,
  NetLandriverT,
  PollProcedureT,
  HOSTCACHESIZE,
  NET_HEADERSIZE,
  NET_DATAGRAMSIZE,
  NETFLAG_LENGTH_MASK,
  NETFLAG_DATA,
  NETFLAG_ACK,
  NETFLAG_EOM,
  NETFLAG_UNRELIABLE,
  NETFLAG_CTL,
  NET_PROTOCOL_VERSION,
  CCREQ_CONNECT,
  CCREQ_SERVER_INFO,
  CCREQ_PLAYER_INFO,
  CCREQ_RULE_INFO,
  CCREP_ACCEPT,
  CCREP_REJECT,
  CCREP_SERVER_INFO,
  CCREP_PLAYER_INFO,
  CCREP_RULE_INFO,
} from "./net";
import { MAX_DATAGRAM, MAX_SCOREBOARD } from "./quakedef";
import { SizeBuf, net_message, SZ_Clear, SZ_Write, MSG_BeginReading, MSG_ReadLong, MSG_ReadByte, MSG_ReadString, MSG_WriteLong, MSG_WriteByte, MSG_WriteString } from "./sizebuf";
import { BigLong, COM_CheckParm, Q_atoi, Q_strcasecmp } from "./common";
import { CvarT, Cvar_FindVar, cvar_vars } from "./cvar";
import { Cmd_Argc, Cmd_Argv, Cmd_AddCommand, cmdState, CmdSourceT, Cmd_ForwardToServer } from "./cmd";
import {
  NET_NewQSocket,
  NET_FreeQSocket,
  NET_Close,
  net_time,
  net_driverlevel,
  hostname,
  hostCacheCount,
  setHostCacheCount,
  hostcache,
  net_activeconnections,
  net_activeSockets,
  net_freeSockets,
  messagesSent,
  messagesReceived,
  unreliableMessagesSent,
  unreliableMessagesReceived,
  net_landrivers,
  net_numlandrivers,
  getNetHostHooks,
  SchedulePollProcedure,
  SetNetTime,
} from "./net_main";
import { Sys_Error } from "../platform/sys";
import { Con_Printf, Con_DPrintf } from "../client/console";

// these two "macros" are to make the code more readable
function sfunc(sock: QsocketT): NetLandriverT {
  return net_landrivers[sock.landriver];
}
function dfunc(): NetLandriverT {
  return net_landrivers[net_landriverlevel];
}

let net_landriverlevel = 0;

/* statistic counters */
let packetsSent = 0;
let packetsReSent = 0;
let packetsReceived = 0;
let receivedDuplicateCount = 0;
let shortPacketCount = 0;
let droppedDatagrams = 0;

let myDriverLevel = 0;

class PacketBufferT {
  bytes: Uint8Array = new Uint8Array(NET_DATAGRAMSIZE);

  get length(): number {
    return BigLong(readUint32LE(this.bytes, 0));
  }
  set length(v: number) {
    writeUint32LE(this.bytes, 0, BigLong(v));
  }

  get sequence(): number {
    return BigLong(readUint32LE(this.bytes, 4));
  }
  set sequence(v: number) {
    writeUint32LE(this.bytes, 4, BigLong(v));
  }

  get data(): Uint8Array {
    return this.bytes.subarray(NET_HEADERSIZE);
  }
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] + (buf[offset + 1] << 8) + (buf[offset + 2] << 16) + (buf[offset + 3] << 24)) | 0;
}
function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

const packetBuffer = new PacketBufferT();

// net_message's raw 4-byte control header -- see file header.
function peekControlHeader(buf: Uint8Array): number {
  return BigLong(readUint32LE(buf, 0));
}
function writeControlHeader(msg: SizeBuf, value: number): void {
  writeUint32LE(msg.data, 0, BigLong(value));
}

//============================================================================
// BAN_TEST -- see file header

const AF_INET = 2;
let banAddr = 0;
let banMask = 0xffffffff;

function sockaddrInAddr(addr: QsockaddrT): number {
  const d = addr.sa_data;
  return (d[2] | (d[3] << 8) | (d[4] << 16) | (d[5] << 24)) >>> 0;
}

function inet_ntoa(addr: number): string {
  return `${addr & 0xff}.${(addr >>> 8) & 0xff}.${(addr >>> 16) & 0xff}.${(addr >>> 24) & 0xff}`;
}

function inet_addr(s: string): number {
  const parts = s.split(".");
  if (parts.length !== 4) return 0xffffffff;
  const b = parts.map((p) => Q_atoi(p) & 0xff);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

function NET_Ban_f(): void {
  let print: (fmt: string, ...args: Array<string | number>) => void;

  if (cmdState.source === CmdSourceT.src_command) {
    if (!(getNetHostHooks()?.svActive() ?? false)) {
      Cmd_ForwardToServer();
      return;
    }
    print = Con_Printf;
  } else {
    const hooks = getNetHostHooks();
    if ((hooks?.deathmatch() ?? false) && !(hooks?.hostClientPrivileged() ?? false)) return;
    print = hooks ? hooks.svClientPrintf.bind(hooks) : Con_Printf;
  }

  switch (Cmd_Argc()) {
    case 1:
      if (banAddr) {
        print("Banning %s [%s]\n", inet_ntoa(banAddr), inet_ntoa(banMask));
      } else {
        print("Banning not active\n");
      }
      break;

    case 2:
      if (Q_strcasecmp(Cmd_Argv(1), "off") === 0) banAddr = 0;
      else banAddr = inet_addr(Cmd_Argv(1));
      banMask = 0xffffffff;
      break;

    case 3:
      banAddr = inet_addr(Cmd_Argv(1));
      banMask = inet_addr(Cmd_Argv(2));
      break;

    default:
      print("BAN ip_address [mask]\n");
      break;
  }
}

//============================================================================

function Datagram_SendMessage(sock: QsocketT, data: SizeBuf): number {
  sock.sendMessage.set(data.data.subarray(0, data.cursize), 0);
  sock.sendMessageLength = data.cursize;

  let dataLen: number;
  let eom: number;
  if (data.cursize <= MAX_DATAGRAM) {
    dataLen = data.cursize;
    eom = NETFLAG_EOM;
  } else {
    dataLen = MAX_DATAGRAM;
    eom = 0;
  }
  const packetLen = NET_HEADERSIZE + dataLen;

  packetBuffer.length = packetLen | (NETFLAG_DATA | eom);
  packetBuffer.sequence = sock.sendSequence++;
  packetBuffer.data.set(sock.sendMessage.subarray(0, dataLen), 0);

  sock.canSend = false;

  if (sfunc(sock).Write(sock.socket, packetBuffer.bytes, packetLen, sock.addr) === -1) return -1;

  sock.lastSendTime = net_time;
  packetsSent++;
  return 1;
}

function SendMessageNext(sock: QsocketT): number {
  let dataLen: number;
  let eom: number;
  if (sock.sendMessageLength <= MAX_DATAGRAM) {
    dataLen = sock.sendMessageLength;
    eom = NETFLAG_EOM;
  } else {
    dataLen = MAX_DATAGRAM;
    eom = 0;
  }
  const packetLen = NET_HEADERSIZE + dataLen;

  packetBuffer.length = packetLen | (NETFLAG_DATA | eom);
  packetBuffer.sequence = sock.sendSequence++;
  packetBuffer.data.set(sock.sendMessage.subarray(0, dataLen), 0);

  sock.sendNext = false;

  if (sfunc(sock).Write(sock.socket, packetBuffer.bytes, packetLen, sock.addr) === -1) return -1;

  sock.lastSendTime = net_time;
  packetsSent++;
  return 1;
}

function ReSendMessage(sock: QsocketT): number {
  let dataLen: number;
  let eom: number;
  if (sock.sendMessageLength <= MAX_DATAGRAM) {
    dataLen = sock.sendMessageLength;
    eom = NETFLAG_EOM;
  } else {
    dataLen = MAX_DATAGRAM;
    eom = 0;
  }
  const packetLen = NET_HEADERSIZE + dataLen;

  packetBuffer.length = packetLen | (NETFLAG_DATA | eom);
  packetBuffer.sequence = sock.sendSequence - 1;
  packetBuffer.data.set(sock.sendMessage.subarray(0, dataLen), 0);

  sock.sendNext = false;

  if (sfunc(sock).Write(sock.socket, packetBuffer.bytes, packetLen, sock.addr) === -1) return -1;

  sock.lastSendTime = net_time;
  packetsReSent++;
  return 1;
}

function Datagram_CanSendMessage(sock: QsocketT): boolean {
  if (sock.sendNext) SendMessageNext(sock);

  return sock.canSend;
}

function Datagram_CanSendUnreliableMessage(_sock: QsocketT): boolean {
  return true;
}

function Datagram_SendUnreliableMessage(sock: QsocketT, data: SizeBuf): number {
  const packetLen = NET_HEADERSIZE + data.cursize;

  packetBuffer.length = packetLen | NETFLAG_UNRELIABLE;
  packetBuffer.sequence = sock.unreliableSendSequence++;
  packetBuffer.data.set(data.data.subarray(0, data.cursize), 0);

  if (sfunc(sock).Write(sock.socket, packetBuffer.bytes, packetLen, sock.addr) === -1) return -1;

  packetsSent++;
  return 1;
}

function Datagram_GetMessage(sock: QsocketT): number {
  let ret = 0;
  const readaddr = new QsockaddrT();

  if (!sock.canSend) {
    if (net_time - sock.lastSendTime > 1.0) ReSendMessage(sock);
  }

  while (true) {
    let length = sfunc(sock).Read(sock.socket, packetBuffer.bytes, NET_DATAGRAMSIZE, readaddr);

    if (length === 0) break;

    if (length === -1) {
      Con_Printf("Read error\n");
      return -1;
    }

    if (sfunc(sock).AddrCompare(readaddr, sock.addr) !== 0) continue;

    if (length < NET_HEADERSIZE) {
      shortPacketCount++;
      continue;
    }

    length = packetBuffer.length;
    const flags = length & ~NETFLAG_LENGTH_MASK;
    length &= NETFLAG_LENGTH_MASK;

    if (flags & NETFLAG_CTL) continue;

    const sequence = packetBuffer.sequence;
    packetsReceived++;

    if (flags & NETFLAG_UNRELIABLE) {
      if (sequence < sock.unreliableReceiveSequence) {
        Con_DPrintf("Got a stale datagram\n");
        ret = 0;
        break;
      }
      if (sequence !== sock.unreliableReceiveSequence) {
        const count = sequence - sock.unreliableReceiveSequence;
        droppedDatagrams += count;
        Con_DPrintf("Dropped %u datagram(s)\n", count);
      }
      sock.unreliableReceiveSequence = sequence + 1;

      length -= NET_HEADERSIZE;

      SZ_Clear(net_message);
      SZ_Write(net_message, packetBuffer.data, length);

      ret = 2;
      break;
    }

    if (flags & NETFLAG_ACK) {
      if (sequence !== sock.sendSequence - 1) {
        Con_DPrintf("Stale ACK received\n");
        continue;
      }
      if (sequence === sock.ackSequence) {
        sock.ackSequence++;
        if (sock.ackSequence !== sock.sendSequence) Con_DPrintf("ack sequencing error\n");
      } else {
        Con_DPrintf("Duplicate ACK received\n");
        continue;
      }
      sock.sendMessageLength -= MAX_DATAGRAM;
      if (sock.sendMessageLength > 0) {
        sock.sendMessage.set(sock.sendMessage.subarray(MAX_DATAGRAM, MAX_DATAGRAM + sock.sendMessageLength), 0);
        sock.sendNext = true;
      } else {
        sock.sendMessageLength = 0;
        sock.canSend = true;
      }
      continue;
    }

    if (flags & NETFLAG_DATA) {
      packetBuffer.length = NET_HEADERSIZE | NETFLAG_ACK;
      packetBuffer.sequence = sequence;
      sfunc(sock).Write(sock.socket, packetBuffer.bytes, NET_HEADERSIZE, readaddr);

      if (sequence !== sock.receiveSequence) {
        receivedDuplicateCount++;
        continue;
      }
      sock.receiveSequence++;

      length -= NET_HEADERSIZE;

      if (flags & NETFLAG_EOM) {
        SZ_Clear(net_message);
        SZ_Write(net_message, sock.receiveMessage, sock.receiveMessageLength);
        SZ_Write(net_message, packetBuffer.data, length);
        sock.receiveMessageLength = 0;

        ret = 1;
        break;
      }

      sock.receiveMessage.set(packetBuffer.data.subarray(0, length), sock.receiveMessageLength);
      sock.receiveMessageLength += length;
      continue;
    }
  }

  if (sock.sendNext) SendMessageNext(sock);

  return ret;
}

function PrintStats(s: QsocketT): void {
  Con_Printf("canSend = %4u   \n", s.canSend ? 1 : 0);
  Con_Printf("sendSeq = %4u   ", s.sendSequence);
  Con_Printf("recvSeq = %4u   \n", s.receiveSequence);
  Con_Printf("\n");
}

function NET_Stats_f(): void {
  if (Cmd_Argc() === 1) {
    Con_Printf("unreliable messages sent   = %i\n", unreliableMessagesSent);
    Con_Printf("unreliable messages recv   = %i\n", unreliableMessagesReceived);
    Con_Printf("reliable messages sent     = %i\n", messagesSent);
    Con_Printf("reliable messages received = %i\n", messagesReceived);
    Con_Printf("packetsSent                = %i\n", packetsSent);
    Con_Printf("packetsReSent              = %i\n", packetsReSent);
    Con_Printf("packetsReceived            = %i\n", packetsReceived);
    Con_Printf("receivedDuplicateCount     = %i\n", receivedDuplicateCount);
    Con_Printf("shortPacketCount           = %i\n", shortPacketCount);
    Con_Printf("droppedDatagrams           = %i\n", droppedDatagrams);
  } else if (Cmd_Argv(1) === "*") {
    for (let s = net_activeSockets; s; s = s.next) PrintStats(s);
    for (let s = net_freeSockets; s; s = s.next) PrintStats(s);
  } else {
    let s = net_activeSockets;
    for (; s; s = s.next) if (Q_strcasecmp(Cmd_Argv(1), s.address) === 0) break;
    if (s === null) {
      s = net_freeSockets;
      for (; s; s = s.next) if (Q_strcasecmp(Cmd_Argv(1), s.address) === 0) break;
    }
    if (s === null) return;
    PrintStats(s);
  }
}

//============================================================================
// "test"/"test2" debug console commands

let testInProgress = false;
let testPollCount = 0;
let testDriver = 0;
let testSocket = 0;

function Test_Poll(): void {
  const clientaddr = new QsockaddrT();

  net_landriverlevel = testDriver;

  while (true) {
    const len = dfunc().Read(testSocket, net_message.data, net_message.maxsize, clientaddr);
    if (len < 4) break;

    net_message.cursize = len;

    MSG_BeginReading();
    const control = peekControlHeader(net_message.data);
    MSG_ReadLong();
    if (control === -1) break;
    if ((control & ~NETFLAG_LENGTH_MASK) !== NETFLAG_CTL) break;
    if ((control & NETFLAG_LENGTH_MASK) !== len) break;

    if (MSG_ReadByte() !== CCREP_PLAYER_INFO) Sys_Error("Unexpected repsonse to Player Info request\n");

    MSG_ReadByte(); // playerNumber -- read but never used, per the C
    const name = MSG_ReadString();
    const colors = MSG_ReadLong();
    const frags = MSG_ReadLong();
    const connectTime = MSG_ReadLong();
    const address = MSG_ReadString();

    Con_Printf("%s\n  frags:%3i  colors:%u %u  time:%u\n  %s\n", name, frags, colors >> 4, colors & 0x0f, Math.trunc(connectTime / 60), address);
  }

  testPollCount--;
  if (testPollCount) {
    SchedulePollProcedure(testPollProcedure, 0.1);
  } else {
    dfunc().CloseSocket(testSocket);
    testInProgress = false;
  }
}

const testPollProcedure = new PollProcedureT(Test_Poll);

function Test_f(): void {
  if (testInProgress) return;

  const host = Cmd_Argv(1);
  let max = MAX_SCOREBOARD;
  const sendaddr = new QsockaddrT();

  const justDoIt = (): void => {
    testSocket = dfunc().OpenSocket(0);
    if (testSocket === -1) return;

    testInProgress = true;
    testPollCount = 20;
    testDriver = net_landriverlevel;

    for (let n = 0; n < max; n++) {
      SZ_Clear(net_message);
      // save space for the header, filled in later
      MSG_WriteLong(net_message, 0);
      MSG_WriteByte(net_message, CCREQ_PLAYER_INFO);
      MSG_WriteByte(net_message, n);
      writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
      dfunc().Write(testSocket, net_message.data, net_message.cursize, sendaddr);
    }
    SZ_Clear(net_message);
    SchedulePollProcedure(testPollProcedure, 0.1);
  };

  // Cmd_Argv never returns NULL in this port (empty string for a missing
  // arg, matching cmd.c's cmd_null_string) -- see file header on
  // `if (host && hostCacheCount)`'s always-true pointer check in the C.
  if (hostCacheCount) {
    let n = 0;
    for (; n < hostCacheCount; n++) {
      if (Q_strcasecmp(host, hostcache[n].name) === 0) {
        if (hostcache[n].driver !== myDriverLevel) continue;
        net_landriverlevel = hostcache[n].ldriver;
        max = hostcache[n].maxusers;
        sendaddr.sa_family = hostcache[n].addr.sa_family;
        sendaddr.sa_data.set(hostcache[n].addr.sa_data);
        break;
      }
    }
    if (n < hostCacheCount) {
      justDoIt();
      return;
    }
  }

  for (net_landriverlevel = 0; net_landriverlevel < net_numlandrivers; net_landriverlevel++) {
    if (!net_landrivers[net_landriverlevel].initialized) continue;
    if (dfunc().GetAddrFromName(host, sendaddr) !== -1) break;
  }
  if (net_landriverlevel === net_numlandrivers) return;

  justDoIt();
}

let test2InProgress = false;
let test2Driver = 0;
let test2Socket = 0;

function Test2_Poll(): void {
  const clientaddr = new QsockaddrT();
  net_landriverlevel = test2Driver;

  const reschedule = (): void => {
    SchedulePollProcedure(test2PollProcedure, 0.05);
  };
  const done = (): void => {
    dfunc().CloseSocket(test2Socket);
    test2InProgress = false;
  };
  const errorOut = (): void => {
    Con_Printf("Unexpected repsonse to Rule Info request\n");
    done();
  };

  const len = dfunc().Read(test2Socket, net_message.data, net_message.maxsize, clientaddr);
  if (len < 4) {
    reschedule();
    return;
  }

  net_message.cursize = len;

  MSG_BeginReading();
  const control = peekControlHeader(net_message.data);
  MSG_ReadLong();
  if (control === -1) return errorOut();
  if ((control & ~NETFLAG_LENGTH_MASK) !== NETFLAG_CTL) return errorOut();
  if ((control & NETFLAG_LENGTH_MASK) !== len) return errorOut();

  if (MSG_ReadByte() !== CCREP_RULE_INFO) return errorOut();

  const name = MSG_ReadString();
  if (name.length === 0) {
    done();
    return;
  }
  const value = MSG_ReadString();

  Con_Printf("%-16.16s  %-16.16s\n", name, value);

  SZ_Clear(net_message);
  // save space for the header, filled in later
  MSG_WriteLong(net_message, 0);
  MSG_WriteByte(net_message, CCREQ_RULE_INFO);
  MSG_WriteString(net_message, name);
  writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
  dfunc().Write(test2Socket, net_message.data, net_message.cursize, clientaddr);
  SZ_Clear(net_message);

  reschedule();
}

const test2PollProcedure = new PollProcedureT(Test2_Poll);

function Test2_f(): void {
  if (test2InProgress) return;

  const host = Cmd_Argv(1);
  const sendaddr = new QsockaddrT();

  const justDoIt = (): void => {
    test2Socket = dfunc().OpenSocket(0);
    if (test2Socket === -1) return;

    test2InProgress = true;
    test2Driver = net_landriverlevel;

    SZ_Clear(net_message);
    // save space for the header, filled in later
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, CCREQ_RULE_INFO);
    MSG_WriteString(net_message, "");
    writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
    dfunc().Write(test2Socket, net_message.data, net_message.cursize, sendaddr);
    SZ_Clear(net_message);
    SchedulePollProcedure(test2PollProcedure, 0.05);
  };

  if (hostCacheCount) {
    let n = 0;
    for (; n < hostCacheCount; n++) {
      if (Q_strcasecmp(host, hostcache[n].name) === 0) {
        if (hostcache[n].driver !== myDriverLevel) continue;
        net_landriverlevel = hostcache[n].ldriver;
        sendaddr.sa_family = hostcache[n].addr.sa_family;
        sendaddr.sa_data.set(hostcache[n].addr.sa_data);
        break;
      }
    }
    if (n < hostCacheCount) {
      justDoIt();
      return;
    }
  }

  for (net_landriverlevel = 0; net_landriverlevel < net_numlandrivers; net_landriverlevel++) {
    if (!net_landrivers[net_landriverlevel].initialized) continue;
    if (dfunc().GetAddrFromName(host, sendaddr) !== -1) break;
  }
  if (net_landriverlevel === net_numlandrivers) return;

  justDoIt();
}

//============================================================================

function Datagram_Init(): number {
  myDriverLevel = net_driverlevel;
  Cmd_AddCommand("net_stats", NET_Stats_f);

  if (COM_CheckParm("-nolan")) return -1;

  for (let i = 0; i < net_numlandrivers; i++) {
    const csock = net_landrivers[i].Init();
    if (csock === -1) continue;
    net_landrivers[i].initialized = true;
    net_landrivers[i].controlSock = csock;
  }

  // BAN_TEST -- see file header
  Cmd_AddCommand("ban", NET_Ban_f);
  Cmd_AddCommand("test", Test_f);
  Cmd_AddCommand("test2", Test2_f);

  return 0;
}

function Datagram_Shutdown(): void {
  // shutdown the lan drivers
  for (let i = 0; i < net_numlandrivers; i++) {
    if (net_landrivers[i].initialized) {
      net_landrivers[i].Shutdown();
      net_landrivers[i].initialized = false;
    }
  }
}

function Datagram_Close(sock: QsocketT): void {
  sfunc(sock).CloseSocket(sock.socket);
}

function Datagram_Listen(state: boolean): void {
  for (let i = 0; i < net_numlandrivers; i++) if (net_landrivers[i].initialized) net_landrivers[i].Listen(state);
}

function sendReject(acceptsock: number, clientaddr: QsockaddrT, reason: string): QsocketT | null {
  SZ_Clear(net_message);
  // save space for the header, filled in later
  MSG_WriteLong(net_message, 0);
  MSG_WriteByte(net_message, CCREP_REJECT);
  MSG_WriteString(net_message, reason);
  writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
  dfunc().Write(acceptsock, net_message.data, net_message.cursize, clientaddr);
  SZ_Clear(net_message);
  return null;
}

function _Datagram_CheckNewConnections(): QsocketT | null {
  const acceptsock = dfunc().CheckNewConnections();
  if (acceptsock === -1) return null;

  const clientaddr = new QsockaddrT();

  SZ_Clear(net_message);

  const len = dfunc().Read(acceptsock, net_message.data, net_message.maxsize, clientaddr);
  if (len < 4) return null;
  net_message.cursize = len;

  MSG_BeginReading();
  const control = peekControlHeader(net_message.data);
  MSG_ReadLong();
  if (control === -1) return null;
  if ((control & ~NETFLAG_LENGTH_MASK) !== NETFLAG_CTL) return null;
  if ((control & NETFLAG_LENGTH_MASK) !== len) return null;

  const command = MSG_ReadByte();
  const hooks = getNetHostHooks();

  if (command === CCREQ_SERVER_INFO) {
    if (MSG_ReadString() !== "QUAKE") return null;

    SZ_Clear(net_message);
    // save space for the header, filled in later
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, CCREP_SERVER_INFO);
    const newaddr = new QsockaddrT();
    dfunc().GetSocketAddr(acceptsock, newaddr);
    MSG_WriteString(net_message, dfunc().AddrToString(newaddr));
    MSG_WriteString(net_message, hostname.string);
    MSG_WriteString(net_message, hooks?.svName() ?? "");
    MSG_WriteByte(net_message, net_activeconnections);
    MSG_WriteByte(net_message, hooks?.svsMaxclients() ?? 0);
    MSG_WriteByte(net_message, NET_PROTOCOL_VERSION);
    writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
    dfunc().Write(acceptsock, net_message.data, net_message.cursize, clientaddr);
    SZ_Clear(net_message);
    return null;
  }

  if (command === CCREQ_PLAYER_INFO) {
    const playerNumber = MSG_ReadByte();
    const clients = hooks?.svsClients() ?? [];
    const maxclients = hooks?.svsMaxclients() ?? 0;

    let activeNumber = -1;
    let clientNumber = 0;
    let client = null as (typeof clients)[number] | null;
    for (; clientNumber < maxclients; clientNumber++) {
      const c = clients[clientNumber];
      if (c.active) {
        activeNumber++;
        if (activeNumber === playerNumber) {
          client = c;
          break;
        }
      }
    }
    if (client === null) return null;

    SZ_Clear(net_message);
    // save space for the header, filled in later
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, CCREP_PLAYER_INFO);
    MSG_WriteByte(net_message, playerNumber);
    MSG_WriteString(net_message, client.name);
    MSG_WriteLong(net_message, client.colors);
    MSG_WriteLong(net_message, client.frags);
    MSG_WriteLong(net_message, client.netconnection ? Math.trunc(net_time - client.netconnection.connecttime) : 0);
    MSG_WriteString(net_message, client.netconnection ? client.netconnection.address : "");
    writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
    dfunc().Write(acceptsock, net_message.data, net_message.cursize, clientaddr);
    SZ_Clear(net_message);

    return null;
  }

  if (command === CCREQ_RULE_INFO) {
    const prevCvarName = MSG_ReadString();
    let v: CvarT | null;
    if (prevCvarName.length > 0) {
      const found = Cvar_FindVar(prevCvarName);
      if (!found) return null;
      v = found.next;
    } else {
      v = cvar_vars;
    }

    // search for the next server cvar
    while (v) {
      if (v.server) break;
      v = v.next;
    }

    // send the response
    SZ_Clear(net_message);
    // save space for the header, filled in later
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, CCREP_RULE_INFO);
    if (v) {
      MSG_WriteString(net_message, v.name);
      MSG_WriteString(net_message, v.string);
    }
    writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
    dfunc().Write(acceptsock, net_message.data, net_message.cursize, clientaddr);
    SZ_Clear(net_message);

    return null;
  }

  if (command !== CCREQ_CONNECT) return null;

  if (MSG_ReadString() !== "QUAKE") return null;

  if (MSG_ReadByte() !== NET_PROTOCOL_VERSION) return sendReject(acceptsock, clientaddr, "Incompatible version.\n");

  // BAN_TEST -- see file header
  if (clientaddr.sa_family === AF_INET) {
    const testAddr = sockaddrInAddr(clientaddr);
    if (((testAddr & banMask) >>> 0) === banAddr) return sendReject(acceptsock, clientaddr, "You have been banned.\n");
  }

  // see if this guy is already connected
  for (let s = net_activeSockets; s; s = s.next) {
    if (s.driver !== net_driverlevel) continue;
    const ret = dfunc().AddrCompare(clientaddr, s.addr);
    if (ret >= 0) {
      // is this a duplicate connection reqeust?
      if (ret === 0 && net_time - s.connecttime < 2.0) {
        // yes, so send a duplicate reply
        SZ_Clear(net_message);
        // save space for the header, filled in later
        MSG_WriteLong(net_message, 0);
        MSG_WriteByte(net_message, CCREP_ACCEPT);
        const newaddr = new QsockaddrT();
        dfunc().GetSocketAddr(s.socket, newaddr);
        MSG_WriteLong(net_message, dfunc().GetSocketPort(newaddr));
        writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
        dfunc().Write(acceptsock, net_message.data, net_message.cursize, clientaddr);
        SZ_Clear(net_message);
        return null;
      }
      // it's somebody coming back in from a crash/disconnect
      // so close the old qsocket and let their retry get them back in
      NET_Close(s);
      return null;
    }
  }

  // allocate a QSocket
  const sock = NET_NewQSocket();
  if (sock === null) return sendReject(acceptsock, clientaddr, "Server is full.\n");

  // allocate a network socket
  const newsock = dfunc().OpenSocket(0);
  if (newsock === -1) {
    NET_FreeQSocket(sock);
    return null;
  }

  // connect to the client
  if (dfunc().Connect(newsock, clientaddr) === -1) {
    dfunc().CloseSocket(newsock);
    NET_FreeQSocket(sock);
    return null;
  }

  // everything is allocated, just fill in the details
  sock.socket = newsock;
  sock.landriver = net_landriverlevel;
  sock.addr.sa_family = clientaddr.sa_family;
  sock.addr.sa_data.set(clientaddr.sa_data);
  sock.address = dfunc().AddrToString(clientaddr);

  // send him back the info about the server connection he has been allocated
  SZ_Clear(net_message);
  // save space for the header, filled in later
  MSG_WriteLong(net_message, 0);
  MSG_WriteByte(net_message, CCREP_ACCEPT);
  const newaddr = new QsockaddrT();
  dfunc().GetSocketAddr(newsock, newaddr);
  MSG_WriteLong(net_message, dfunc().GetSocketPort(newaddr));
  writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
  dfunc().Write(acceptsock, net_message.data, net_message.cursize, clientaddr);
  SZ_Clear(net_message);

  return sock;
}

function Datagram_CheckNewConnections(): QsocketT | null {
  let ret: QsocketT | null = null;

  for (net_landriverlevel = 0; net_landriverlevel < net_numlandrivers; net_landriverlevel++)
    if (net_landrivers[net_landriverlevel].initialized) {
      ret = _Datagram_CheckNewConnections();
      if (ret !== null) break;
    }

  return ret;
}

function _Datagram_SearchForHosts(xmit: boolean): void {
  const myaddr = new QsockaddrT();
  dfunc().GetSocketAddr(dfunc().controlSock, myaddr);

  if (xmit) {
    SZ_Clear(net_message);
    // save space for the header, filled in later
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, CCREQ_SERVER_INFO);
    MSG_WriteString(net_message, "QUAKE");
    MSG_WriteByte(net_message, NET_PROTOCOL_VERSION);
    writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
    dfunc().Broadcast(dfunc().controlSock, net_message.data, net_message.cursize);
    SZ_Clear(net_message);
  }

  const readaddr = new QsockaddrT();
  let ret: number;
  while ((ret = dfunc().Read(dfunc().controlSock, net_message.data, net_message.maxsize, readaddr)) > 0) {
    if (ret < 4) continue;
    net_message.cursize = ret;

    // don't answer our own query
    if (dfunc().AddrCompare(readaddr, myaddr) >= 0) continue;

    // is the cache full?
    if (hostCacheCount === HOSTCACHESIZE) continue;

    MSG_BeginReading();
    const control = peekControlHeader(net_message.data);
    MSG_ReadLong();
    if (control === -1) continue;
    if ((control & ~NETFLAG_LENGTH_MASK) !== NETFLAG_CTL) continue;
    if ((control & NETFLAG_LENGTH_MASK) !== ret) continue;

    if (MSG_ReadByte() !== CCREP_SERVER_INFO) continue;

    dfunc().GetAddrFromName(MSG_ReadString(), readaddr);
    // search the cache for this server
    let n = 0;
    for (; n < hostCacheCount; n++) if (dfunc().AddrCompare(readaddr, hostcache[n].addr) === 0) break;

    // is it already there?
    if (n < hostCacheCount) continue;

    // add it
    setHostCacheCount(hostCacheCount + 1);
    hostcache[n].name = MSG_ReadString();
    hostcache[n].map = MSG_ReadString();
    hostcache[n].users = MSG_ReadByte();
    hostcache[n].maxusers = MSG_ReadByte();
    if (MSG_ReadByte() !== NET_PROTOCOL_VERSION) {
      hostcache[n].cname = hostcache[n].name.slice(0, 14);
      hostcache[n].name = "*" + hostcache[n].cname;
    }
    hostcache[n].addr.sa_family = readaddr.sa_family;
    hostcache[n].addr.sa_data.set(readaddr.sa_data);
    hostcache[n].driver = net_driverlevel;
    hostcache[n].ldriver = net_landriverlevel;
    hostcache[n].cname = dfunc().AddrToString(readaddr);

    // check for a name conflict -- see file header for the no-carry quirk
    for (let i = 0; i < hostCacheCount; i++) {
      if (i === n) continue;
      if (Q_strcasecmp(hostcache[n].name, hostcache[i].name) === 0) {
        const chars = hostcache[n].name.split("");
        const nameLen = chars.length;
        if (nameLen < 15 && chars[nameLen - 1].charCodeAt(0) > 0x38) {
          chars[nameLen] = "0";
        } else {
          chars[nameLen - 1] = String.fromCharCode(chars[nameLen - 1].charCodeAt(0) + 1);
        }
        hostcache[n].name = chars.join("");
        i = -1;
      }
    }
  }
}

function Datagram_SearchForHosts(xmit: boolean): void {
  for (net_landriverlevel = 0; net_landriverlevel < net_numlandrivers; net_landriverlevel++) {
    if (hostCacheCount === HOSTCACHESIZE) break;
    if (net_landrivers[net_landriverlevel].initialized) _Datagram_SearchForHosts(xmit);
  }
}

function errorReturn(sock: QsocketT | null, newsock: number): null {
  if (sock) NET_FreeQSocket(sock);
  dfunc().CloseSocket(newsock);
  getNetHostHooks()?.menuHandleConnectError();
  return null;
}

function _Datagram_Connect(host: string): QsocketT | null {
  const sendaddr = new QsockaddrT();
  const readaddr = new QsockaddrT();

  // see if we can resolve the host name
  if (dfunc().GetAddrFromName(host, sendaddr) === -1) return null;

  const newsock = dfunc().OpenSocket(0);
  if (newsock === -1) return null;

  const sock = NET_NewQSocket();
  if (sock === null) return errorReturn(null, newsock);
  sock.socket = newsock;
  sock.landriver = net_landriverlevel;

  // connect to the host
  if (dfunc().Connect(newsock, sendaddr) === -1) return errorReturn(sock, newsock);

  // send the connection request
  Con_Printf("trying...\n");
  getNetHostHooks()?.scrUpdateScreen();
  let start_time = net_time;

  let ret = 0;
  for (let reps = 0; reps < 3; reps++) {
    SZ_Clear(net_message);
    // save space for the header, filled in later
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, CCREQ_CONNECT);
    MSG_WriteString(net_message, "QUAKE");
    MSG_WriteByte(net_message, NET_PROTOCOL_VERSION);
    writeControlHeader(net_message, NETFLAG_CTL | (net_message.cursize & NETFLAG_LENGTH_MASK));
    dfunc().Write(newsock, net_message.data, net_message.cursize, sendaddr);
    SZ_Clear(net_message);

    do {
      ret = dfunc().Read(newsock, net_message.data, net_message.maxsize, readaddr);
      // if we got something, validate it
      if (ret > 0) {
        // is it from the right place?
        if (sfunc(sock).AddrCompare(readaddr, sendaddr) !== 0) {
          ret = 0;
          continue;
        }

        if (ret < 4) {
          ret = 0;
          continue;
        }

        net_message.cursize = ret;
        MSG_BeginReading();

        const control = peekControlHeader(net_message.data);
        MSG_ReadLong();
        if (control === -1) {
          ret = 0;
          continue;
        }
        if ((control & ~NETFLAG_LENGTH_MASK) !== NETFLAG_CTL) {
          ret = 0;
          continue;
        }
        if ((control & NETFLAG_LENGTH_MASK) !== ret) {
          ret = 0;
          continue;
        }
      }
    } while (ret === 0 && SetNetTime() - start_time < 2.5);
    if (ret) break;
    Con_Printf("still trying...\n");
    getNetHostHooks()?.scrUpdateScreen();
    start_time = SetNetTime();
  }

  if (ret === 0) {
    const reason = "No Response";
    Con_Printf("%s\n", reason);
    getNetHostHooks()?.menuSetReturnReason(reason);
    return errorReturn(sock, newsock);
  }

  if (ret === -1) {
    const reason = "Network Error";
    Con_Printf("%s\n", reason);
    getNetHostHooks()?.menuSetReturnReason(reason);
    return errorReturn(sock, newsock);
  }

  const acceptCode = MSG_ReadByte();
  if (acceptCode === CCREP_REJECT) {
    const reason = MSG_ReadString();
    Con_Printf(reason);
    getNetHostHooks()?.menuSetReturnReason(reason.slice(0, 31));
    return errorReturn(sock, newsock);
  }

  if (acceptCode === CCREP_ACCEPT) {
    sock.addr.sa_family = sendaddr.sa_family;
    sock.addr.sa_data.set(sendaddr.sa_data);
    dfunc().SetSocketPort(sock.addr, MSG_ReadLong());
  } else {
    const reason = "Bad Response";
    Con_Printf("%s\n", reason);
    getNetHostHooks()?.menuSetReturnReason(reason);
    return errorReturn(sock, newsock);
  }

  sock.address = dfunc().GetNameFromAddr(sendaddr);

  Con_Printf("Connection accepted\n");
  sock.lastMessageTime = SetNetTime();

  // switch the connection to the specified address
  if (dfunc().Connect(newsock, sock.addr) === -1) {
    const reason = "Connect to Game failed";
    Con_Printf("%s\n", reason);
    getNetHostHooks()?.menuSetReturnReason(reason);
    return errorReturn(sock, newsock);
  }

  getNetHostHooks()?.menuConnectSucceeded();
  return sock;
}

function Datagram_Connect(host: string | null): QsocketT | null {
  // GetAddrFromName needs a real string; see file header (host is never
  // actually NULL by the time NET_Connect reaches a driver's Connect).
  if (host === null) return null;

  let ret: QsocketT | null = null;
  for (net_landriverlevel = 0; net_landriverlevel < net_numlandrivers; net_landriverlevel++)
    if (net_landrivers[net_landriverlevel].initialized) {
      ret = _Datagram_Connect(host);
      if (ret !== null) break;
    }
  return ret;
}

export const netDatagramDriver: NetDriverT = {
  name: "Datagram",
  initialized: false,
  controlSock: 0,
  Init: Datagram_Init,
  Listen: Datagram_Listen,
  SearchForHosts: Datagram_SearchForHosts,
  Connect: Datagram_Connect,
  CheckNewConnections: Datagram_CheckNewConnections,
  QGetMessage: Datagram_GetMessage,
  QSendMessage: Datagram_SendMessage,
  SendUnreliableMessage: Datagram_SendUnreliableMessage,
  CanSendMessage: Datagram_CanSendMessage,
  CanSendUnreliableMessage: Datagram_CanSendUnreliableMessage,
  Close: Datagram_Close,
  Shutdown: Datagram_Shutdown,
};
