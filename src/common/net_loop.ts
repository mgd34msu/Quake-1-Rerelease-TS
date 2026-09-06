/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net_loop.h and WinQuake/net_loop.c (GNU GPL v2 or later).

net_loop.c -- the loopback network driver, used for single-player and
listen-server local play (a client and server talking to each other inside
the same process, with no real socket in between).

Deviations from PORTING.md / the C source:
- `qsocket_t *driverdata` (a `void *` in the C, cast back to `qsocket_t *`
  everywhere this driver uses it to reach the peer socket) is typed
  `unknown` on `QsocketT` (net.ts); every read here narrows it with
  `instanceof QsocketT`, per the standing orders (no `as` casts).
- `sv.active`/`sv.name`/`svs.maxclients`/`cls.state == ca_dedicated` are
  reached through net_main.ts's `getNetHostHooks()` (see that file's header
  for the full hook contract this unit shares with net_dgrm.ts/net_vcr.ts).
- `Loop_CheckNewConnections`'s C trusts `loop_server`/`loop_client` to be
  non-NULL once `localconnectpending` is true (only `Loop_Connect` sets that
  flag, and only after allocating both). This port's `loop_server`/
  `loop_client` are typed `QsocketT | null`, so the same invariant is
  expressed as an explicit (in practice unreachable) null check instead of
  an unchecked dereference.
- `IntAlign`'s C body is `(value + (sizeof(int) - 1)) & (~(sizeof(int) - 1))`;
  ported as the unit brief's `(value + 3) & ~3` (`sizeof(int) == 4` on this
  port's only target).
*/

import { QsocketT, NetDriverT, NET_MAXMESSAGE } from "./net";
import { SizeBuf, net_message, SZ_Clear, SZ_Write } from "./sizebuf";
import { NET_NewQSocket, net_activeconnections, net_driverlevel, hostcache, setHostCacheCount, hostname, getNetHostHooks } from "./net_main";
import { Sys_Error } from "../platform/sys";
import { Con_Printf } from "../client/console";

let localconnectpending = false;
let loop_client: QsocketT | null = null;
let loop_server: QsocketT | null = null;

function Loop_Init(): number {
  if (getNetHostHooks()?.clsStateDedicated() ?? false) return -1;
  return 0;
}

function Loop_Shutdown(): void {
  //
}

function Loop_Listen(_state: boolean): void {
  //
}

function Loop_SearchForHosts(_xmit: boolean): void {
  const hooks = getNetHostHooks();
  if (!(hooks?.svActive() ?? false)) return;

  setHostCacheCount(1);
  if (hostname.string === "UNNAMED") hostcache[0].name = "local";
  else hostcache[0].name = hostname.string;
  hostcache[0].map = hooks?.svName() ?? "";
  hostcache[0].users = net_activeconnections;
  hostcache[0].maxusers = hooks?.svsMaxclients() ?? 0;
  hostcache[0].driver = net_driverlevel;
  hostcache[0].cname = "local";
}

function Loop_Connect(host: string | null): QsocketT | null {
  if (host !== "local") return null;

  localconnectpending = true;

  if (!loop_client) {
    const s = NET_NewQSocket();
    if (s === null) {
      Con_Printf("Loop_Connect: no qsocket available\n");
      return null;
    }
    loop_client = s;
    loop_client.address = "localhost";
  }
  loop_client.receiveMessageLength = 0;
  loop_client.sendMessageLength = 0;
  loop_client.canSend = true;

  if (!loop_server) {
    const s = NET_NewQSocket();
    if (s === null) {
      Con_Printf("Loop_Connect: no qsocket available\n");
      return null;
    }
    loop_server = s;
    loop_server.address = "LOCAL";
  }
  loop_server.receiveMessageLength = 0;
  loop_server.sendMessageLength = 0;
  loop_server.canSend = true;

  loop_client.driverdata = loop_server;
  loop_server.driverdata = loop_client;

  return loop_client;
}

function Loop_CheckNewConnections(): QsocketT | null {
  if (!localconnectpending) return null;
  if (!loop_server || !loop_client) return null; // see file header

  localconnectpending = false;
  loop_server.sendMessageLength = 0;
  loop_server.receiveMessageLength = 0;
  loop_server.canSend = true;
  loop_client.sendMessageLength = 0;
  loop_client.receiveMessageLength = 0;
  loop_client.canSend = true;
  return loop_server;
}

function IntAlign(value: number): number {
  return (value + 3) & ~3;
}

function Loop_GetMessage(sock: QsocketT): number {
  if (sock.receiveMessageLength === 0) return 0;

  const ret = sock.receiveMessage[0];
  let length = sock.receiveMessage[1] + (sock.receiveMessage[2] << 8);
  // alignment byte skipped here
  SZ_Clear(net_message);
  SZ_Write(net_message, sock.receiveMessage.subarray(4), length);

  length = IntAlign(length + 4);
  sock.receiveMessageLength -= length;

  if (sock.receiveMessageLength) sock.receiveMessage.set(sock.receiveMessage.subarray(length, length + sock.receiveMessageLength), 0);

  if (sock.driverdata instanceof QsocketT && ret === 1) sock.driverdata.canSend = true;

  return ret;
}

function Loop_SendMessage(sock: QsocketT, data: SizeBuf): number {
  const peer = sock.driverdata;
  if (!(peer instanceof QsocketT)) return -1;

  if (peer.receiveMessageLength + data.cursize + 4 > NET_MAXMESSAGE) Sys_Error("Loop_SendMessage: overflow\n");

  const base = peer.receiveMessageLength;

  // message type
  peer.receiveMessage[base] = 1;

  // length
  peer.receiveMessage[base + 1] = data.cursize & 0xff;
  peer.receiveMessage[base + 2] = data.cursize >> 8;

  // buffer[base + 3] is the alignment byte, left untouched

  // message
  peer.receiveMessage.set(data.data.subarray(0, data.cursize), base + 4);
  peer.receiveMessageLength = IntAlign(base + data.cursize + 4);

  sock.canSend = false;
  return 1;
}

function Loop_SendUnreliableMessage(sock: QsocketT, data: SizeBuf): number {
  const peer = sock.driverdata;
  if (!(peer instanceof QsocketT)) return -1;

  // sizeof(byte) + sizeof(short) == 3, not 4 -- the C's own threshold here
  // differs from Loop_SendMessage's, and is kept as-is.
  if (peer.receiveMessageLength + data.cursize + 3 > NET_MAXMESSAGE) return 0;

  const base = peer.receiveMessageLength;

  // message type
  peer.receiveMessage[base] = 2;

  // length
  peer.receiveMessage[base + 1] = data.cursize & 0xff;
  peer.receiveMessage[base + 2] = data.cursize >> 8;

  // buffer[base + 3] is the alignment byte, left untouched

  // message
  peer.receiveMessage.set(data.data.subarray(0, data.cursize), base + 4);
  peer.receiveMessageLength = IntAlign(base + data.cursize + 4);

  return 1;
}

function Loop_CanSendMessage(sock: QsocketT): boolean {
  if (!(sock.driverdata instanceof QsocketT)) return false;
  return sock.canSend;
}

function Loop_CanSendUnreliableMessage(_sock: QsocketT): boolean {
  return true;
}

function Loop_Close(sock: QsocketT): void {
  if (sock.driverdata instanceof QsocketT) sock.driverdata.driverdata = null;
  sock.receiveMessageLength = 0;
  sock.sendMessageLength = 0;
  sock.canSend = true;
  if (sock === loop_client) loop_client = null;
  else loop_server = null;
}

export const netLoopDriver: NetDriverT = {
  name: "Loopback",
  initialized: false,
  controlSock: 0,
  Init: Loop_Init,
  Listen: Loop_Listen,
  SearchForHosts: Loop_SearchForHosts,
  Connect: Loop_Connect,
  CheckNewConnections: Loop_CheckNewConnections,
  QGetMessage: Loop_GetMessage,
  QSendMessage: Loop_SendMessage,
  SendUnreliableMessage: Loop_SendUnreliableMessage,
  CanSendMessage: Loop_CanSendMessage,
  CanSendUnreliableMessage: Loop_CanSendUnreliableMessage,
  Close: Loop_Close,
  Shutdown: Loop_Shutdown,
};
