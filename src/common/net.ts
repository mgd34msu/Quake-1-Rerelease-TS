/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net.h (GNU GPL v2 or later).

net.h -- quake's interface to the networking layer

This is the header module for unit U009 (net.h, net_main.c, net_loop.c/h,
net_dgrm.c/h, net_vcr.c/h -> net.ts, net_main.ts, net_loop.ts, net_dgrm.ts,
net_vcr.ts). It holds only the types and constants net.h declares; the
globals net.h `extern`-declares but that net_main.c actually defines
(net_activeSockets, net_freeSockets, net_numsockets, net_time,
net_activeconnections, hostname/net_messagetimeout, messagesSent/Received,
hostCacheCount, hostcache[], my_tcpip_address, net_drivers[]/net_landrivers[],
...) live in net_main.ts, per PORTING.md's "Globals and module structure":
"declared in the module that owns them in C". Other modules import them from
net_main.ts, mirroring the C's single-definition-plus-extern-declaration
pattern with ES module live bindings.

Deviations from PORTING.md / the C source:
- `struct qsockaddr` -> `QsockaddrT`, a plain class: `sa_family` (originally
  a C `short`) plus the 14-byte `sa_data` payload. The two IP-driver fields
  the landrivers pack into `sa_data` (port, then address) are documented on
  the class itself rather than modeled as named fields, since `net.h` itself
  only ever sees the opaque 16-byte struct; net_udp.ts (U010) is the module
  that actually interprets those bytes as a `sockaddr_in`.
- `qsocket_t` -> `QsocketT`, a class with every field the C struct has, in
  the same order. `driverdata` is `void *driverdata` in the C -- each driver
  stashes something different there (net_loop.c: the peer `qsocket_t *`;
  net_dgrm.c: never used; net_vcr.c: a `long` session id read back out of
  the pointer's bit pattern). No `void *` equivalent exists without `any`,
  so it is typed `unknown`; each driver narrows it with `instanceof`/
  `typeof` at its own call sites (no `as` casts), per the standing orders.
  `sendMessage`/`receiveMessage` are fixed `Uint8Array(NET_MAXMESSAGE)`
  buffers per the unit brief, matching the C's `byte foo[NET_MAXMESSAGE]`.
- `net_driver_t`/`net_landriver_t` -> `NetDriverT`/`NetLandriverT` interfaces.
  Function-pointer members keep their C names and parameter order; `char *`
  returns become `string` returns, and `struct qsockaddr *` out-parameters
  stay as `QsockaddrT` in-place-mutated objects (the caller owns the
  allocation, exactly as the C caller owns the stack `struct qsockaddr`
  passed by address) except `GetNameFromAddr`, whose C signature is an
  awkward `char *name` out-parameter -- ruled (unit brief) to return `string`
  directly, the natural TS shape. `net_driver_t.controlSock` and
  `net_landriver_t.controlSock`/`initialized`/`name` are plain data fields on
  the interface, not functions, matching the C struct layout exactly (the
  unit brief's NetDriverT member list omitted `controlSock`, but net.h's
  actual `net_driver_t` has it and net_main.c's `NET_Init` writes it, so it
  is kept).
- `PollProcedure` -> `PollProcedureT`, a class holding `next`/`nextTime`/
  `procedure`/`arg`. `void (*procedure)()` becomes `procedure: () => void`
  (nothing in this unit ever uses the C's `void *arg` payload through a
  function-pointer call with an argument -- every real `PollProcedure` in
  net_main.c/net_dgrm.c has a zero-argument `procedure`, so `arg` is kept as
  an `unknown` field for structural fidelity but is never read). The actual
  `SchedulePollProcedure` function and the `pollProcedureList` it walks are
  defined in net_main.c, not net.h, so they live in net_main.ts.
- `hostcache_t` -> `HostcacheT`, a class; `name`/`map`/`cname` (fixed `char`
  arrays in C) become plain `string` fields (PORTING.md: Q_strcpy/friends
  have no meaning once strings are JS values), truncated exactly where the
  C's `Q_strcpy` into a fixed buffer would truncate (net_dgrm.ts documents
  the one call site that relies on that, the 14-char name-collision suffix).
- `#if !defined(_WIN32) && !defined(__linux__) && !defined(__sun__)` guards a
  hand-rolled `htonl`/`htons`/`ntohl`/`ntohs` declaration block for platforms
  with no BSD sockets headers; the Linux build this port targets never takes
  that branch, so it is dropped, per PORTING.md's "take the portable,
  non-asm path" rule.
- `#ifdef IDGODS` (`idgods` cvar, `IsID`) is never defined in a normal build
  and is dropped, per PORTING.md's dead-`#ifdef` rule.
- `playername`/`playercolor` are `extern`-declared in net.h but defined in
  cl_main.c (client.ts, out of this unit's scope) and never referenced by
  net_main.c/net_loop.c/net_dgrm.c/net_vcr.c; not ported here.
- `serialAvailable`/`ipxAvailable`/`my_ipx_address` and the
  `GetComPortConfig`/`SetComPortConfig`/`GetModemConfig`/`SetModemConfig`
  function-pointer globals exist only to support the serial/IPX drivers
  PORTING.md explicitly drops ("the DOS/VESA/Sun/serial/IPX/Bangware
  platform files"); not ported. `tcpipAvailable`/`my_tcpip_address` (the
  UDP/TCP-IP equivalents net_udp.ts, U010, still needs) live in net_main.ts.
*/

import { MAX_DATAGRAM } from "./quakedef";
import type { SizeBuf } from "./sizebuf";

export const NET_NAMELEN = 64;

export const NET_MAXMESSAGE = 8192;
export const NET_HEADERSIZE = 2 * 4; // 2 * sizeof(unsigned int)
export const NET_DATAGRAMSIZE = MAX_DATAGRAM + NET_HEADERSIZE;

// NetHeader flags
export const NETFLAG_LENGTH_MASK = 0x0000ffff;
export const NETFLAG_DATA = 0x00010000;
export const NETFLAG_ACK = 0x00020000;
export const NETFLAG_NAK = 0x00040000;
export const NETFLAG_EOM = 0x00080000;
export const NETFLAG_UNRELIABLE = 0x00100000;
export const NETFLAG_CTL = 0x80000000 | 0; // stored/compared as a signed 32-bit int throughout this port

export const NET_PROTOCOL_VERSION = 3;

export const CCREQ_CONNECT = 0x01;
export const CCREQ_SERVER_INFO = 0x02;
export const CCREQ_PLAYER_INFO = 0x03;
export const CCREQ_RULE_INFO = 0x04;

export const CCREP_ACCEPT = 0x81;
export const CCREP_REJECT = 0x82;
export const CCREP_SERVER_INFO = 0x83;
export const CCREP_PLAYER_INFO = 0x84;
export const CCREP_RULE_INFO = 0x85;

// struct qsockaddr -- 16 bytes total (2-byte sa_family + 14-byte sa_data).
// The landrivers (net_udp.ts, U010) pack an IPv4 sockaddr_in into sa_data
// exactly as the C does: sa_data[0..1] port (big-endian), sa_data[2..5]
// address, matching struct sockaddr_in's layout starting right after
// sin_family.
export class QsockaddrT {
  sa_family = 0;
  sa_data: Uint8Array = new Uint8Array(14);
}

export class QsocketT {
  next: QsocketT | null = null;
  connecttime = 0;
  lastMessageTime = 0;
  lastSendTime = 0;

  disconnected = false;
  canSend = false;
  sendNext = false;

  driver = 0;
  landriver = 0;
  socket = 0;
  driverdata: unknown = null;

  ackSequence = 0;
  sendSequence = 0;
  unreliableSendSequence = 0;
  sendMessageLength = 0;
  sendMessage: Uint8Array = new Uint8Array(NET_MAXMESSAGE);

  receiveSequence = 0;
  unreliableReceiveSequence = 0;
  receiveMessageLength = 0;
  receiveMessage: Uint8Array = new Uint8Array(NET_MAXMESSAGE);

  addr: QsockaddrT = new QsockaddrT();
  address = "";
}

export const MAX_NET_DRIVERS = 8;

export interface NetLandriverT {
  name: string;
  initialized: boolean;
  controlSock: number;
  Init(): number;
  Shutdown(): void;
  Listen(state: boolean): void;
  OpenSocket(port: number): number;
  CloseSocket(socket: number): number;
  Connect(socket: number, addr: QsockaddrT): number;
  CheckNewConnections(): number;
  Read(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number;
  Write(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number;
  Broadcast(socket: number, buf: Uint8Array, len: number): number;
  AddrToString(addr: QsockaddrT): string;
  StringToAddr(s: string, addr: QsockaddrT): number;
  GetSocketAddr(socket: number, addr: QsockaddrT): number;
  GetNameFromAddr(addr: QsockaddrT): string;
  GetAddrFromName(name: string, addr: QsockaddrT): number;
  AddrCompare(addr1: QsockaddrT, addr2: QsockaddrT): number;
  GetSocketPort(addr: QsockaddrT): number;
  SetSocketPort(addr: QsockaddrT, port: number): number;
}

export interface NetDriverT {
  name: string;
  initialized: boolean;
  controlSock: number;
  Init(): number;
  Listen(state: boolean): void;
  SearchForHosts(xmit: boolean): void;
  Connect(host: string | null): QsocketT | null;
  CheckNewConnections(): QsocketT | null;
  QGetMessage(sock: QsocketT): number;
  QSendMessage(sock: QsocketT, data: SizeBuf): number;
  SendUnreliableMessage(sock: QsocketT, data: SizeBuf): number;
  CanSendMessage(sock: QsocketT): boolean;
  CanSendUnreliableMessage(sock: QsocketT): boolean;
  Close(sock: QsocketT): void;
  Shutdown(): void;
}

export const HOSTCACHESIZE = 8;

export class HostcacheT {
  name = ""; // char name[16]
  map = ""; // char map[16]
  cname = ""; // char cname[32]
  users = 0;
  maxusers = 0;
  driver = 0;
  ldriver = 0;
  addr: QsockaddrT = new QsockaddrT();
}

// PollProcedure -- see file header for `arg`'s unused status.
export class PollProcedureT {
  next: PollProcedureT | null = null;
  nextTime = 0;
  procedure: () => void;
  arg: unknown = null;

  constructor(procedure: () => void) {
    this.procedure = procedure;
  }
}
