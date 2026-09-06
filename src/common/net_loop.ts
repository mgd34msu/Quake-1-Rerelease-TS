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
- `loop_client`/`loop_server`/`localconnectpending` become a table of
  connection pairs and a queue of not-yet-accepted server sockets; see the
  note above that table for why, and for why one connection behaves exactly
  as the C's does.
- Loop_Connect stamps both sockets with this driver's own index in
  `net_drivers` rather than leaving NET_NewQSocket's `net_driverlevel`
  snapshot; see loop_driverIndex below for the case that distinguishes them.
- `IntAlign`'s C body is `(value + (sizeof(int) - 1)) & (~(sizeof(int) - 1))`;
  ported as the unit brief's `(value + 3) & ~3` (`sizeof(int) == 4` on this
  port's only target).
*/

import { QsocketT, NetDriverT, NET_MAXMESSAGE } from "./net";
import { SizeBuf, net_message, SZ_Clear, SZ_Write } from "./sizebuf";
import { NET_NewQSocket, NET_FreeQSocket, net_activeconnections, net_driverlevel, net_drivers, hostcache, setHostCacheCount, hostname, getNetHostHooks } from "./net_main";
import { Sys_Error } from "../platform/sys";
import { Con_Printf } from "../client/console";

/*
U43 (local splitscreen): WinQuake's loopback driver holds exactly ONE pair of
qsockets (`loop_client`/`loop_server`) plus a single `localconnectpending`
flag, because a WinQuake process has exactly one client. A splitscreen
session is N local clients on one listen server, each with a full connection
of its own (src/client/splitscreen.ts), so the pair becomes a table of pairs
and the flag becomes the queue of server-side sockets Loop_CheckNewConnections
has not handed to SV_ConnectClient yet. With one seat the table holds one
pair and every function below behaves exactly as the C's does; the only
observable change for a single connection is that a reconnect allocates a
fresh qsocket from net_main's free list instead of reusing the previous one,
which nothing outside this file can see (NET_NewQSocket hands back a socket
that Loop_Connect resets in full either way).
*/
interface LoopPairT {
  client: QsocketT;
  server: QsocketT;
}

const loop_pairs: LoopPairT[] = [];
const loop_pending: QsocketT[] = [];

/*
The index THIS driver occupies in net_main's `net_drivers`, which is what
NET_Close/NET_GetMessage/NET_SendMessage dispatch a socket on (`sfunc(sock)`
is `net_drivers[sock.driver]`).

NET_NewQSocket stamps a new socket with the CURRENT `net_driverlevel`, which
is correct while NET_Connect is walking the driver table -- and wrong for
anyone who calls this driver's `Connect` directly, because every one of
net_main's driver loops leaves `net_driverlevel` sitting at `net_numdrivers`,
one past the end. A socket stamped with that index dispatches to
`net_drivers[net_numdrivers]`, which is `undefined`, and the next NET_Close of
it -- NET_Shutdown's sweep of `net_activeSockets`, say -- throws instead of
closing. Stamping the socket with the index this driver actually occupies is
identical on the engine's own path (there `net_driverlevel` IS this index) and
correct on every other, so a loopback socket is always closable.
*/
function loop_driverIndex(): number {
  const i = net_drivers.indexOf(netLoopDriver);
  return i >= 0 ? i : net_driverlevel;
}

function loop_pairOf(sock: QsocketT): LoopPairT | null {
  for (const pair of loop_pairs) {
    if (pair.client === sock || pair.server === sock) return pair;
  }
  return null;
}

function Loop_Init(): number {
  if (getNetHostHooks()?.clsStateDedicated() ?? false) return -1;
  return 0;
}

function Loop_Shutdown(): void {
  // The C's body is empty; the pair table (see the header note above) is
  // dropped here so a re-Init does not inherit sockets from the last run.
  loop_pairs.length = 0;
  loop_pending.length = 0;
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

  const client = NET_NewQSocket();
  if (client === null) {
    Con_Printf("Loop_Connect: no qsocket available\n");
    return null;
  }
  const server = NET_NewQSocket();
  if (server === null) {
    Con_Printf("Loop_Connect: no qsocket available\n");
    // Half a pair is no pair: hand the client side back rather than leaving
    // it on the active list with nothing on the other end of it.
    NET_FreeQSocket(client);
    return null;
  }

  const driver = loop_driverIndex();
  client.driver = driver;
  server.driver = driver;

  client.address = "localhost";
  client.receiveMessageLength = 0;
  client.sendMessageLength = 0;
  client.canSend = true;

  server.address = "LOCAL";
  server.receiveMessageLength = 0;
  server.sendMessageLength = 0;
  server.canSend = true;

  client.driverdata = server;
  server.driverdata = client;

  loop_pairs.push({ client, server });
  loop_pending.push(server);

  return client;
}

function Loop_CheckNewConnections(): QsocketT | null {
  const server = loop_pending.shift();
  if (server === undefined) return null;

  const pair = loop_pairOf(server);
  if (pair === null) return null;

  pair.server.sendMessageLength = 0;
  pair.server.receiveMessageLength = 0;
  pair.server.canSend = true;
  pair.client.sendMessageLength = 0;
  pair.client.receiveMessageLength = 0;
  pair.client.canSend = true;
  return pair.server;
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

  const pair = loop_pairOf(sock);
  if (pair === null) return;
  const pendingAt = loop_pending.indexOf(pair.server);
  if (pendingAt >= 0) loop_pending.splice(pendingAt, 1);
  loop_pairs.splice(loop_pairs.indexOf(pair), 1);
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
