/*
Self-sufficient test for src/common/net_dgrm.ts (WinQuake net_dgrm.c).

A fake in-memory `NetLandriverT` stands in for net_udp.ts (a sibling unit,
not this unit's to import): each "socket" is a plain port number, packets
are queued per destination port instead of going over a real UDP socket,
and AddrToString/StringToAddr/SetSocketPort/GetSocketPort/AddrCompare are
implemented over `sa_data` the same way net_udp.ts's UDP_* functions are
(port big-endian at sa_data[0..1], a loopback-shaped address at
sa_data[2..5]). Every packet `Write()` sends is also appended to `sentLog`
so tests can assert on the raw wire bytes (headers, sequence numbers)
without racing the delivery queue Datagram_GetMessage itself drains.

Two halves:
  - The CCREQ_CONNECT -> CCREP_ACCEPT handshake is driven through
    `NET_CheckNewConnections()` (net_main.ts's public wrapper -- required so
    `net_driverlevel`/`net_drivers[1].initialized` end up correct; see the
    note above `hookUpFakeLandriver` below) with a hand-built CCREQ_CONNECT
    packet dropped straight into the fake accept socket's queue, standing in
    for the client half instead of calling `_Datagram_Connect`
    (net_main.ts's `NET_Connect`/net_dgrm.ts's `_Datagram_Connect`) directly:
    that function blocks on real wall-clock retries waiting for a reply from
    a *different process* in the real engine, which this single-process test
    has no way to answer while the call is still on the stack. Handing it a
    pre-built request and reading back the raw CCREP_ACCEPT bytes exercises
    exactly the same `_Datagram_CheckNewConnections` code path (ban check,
    duplicate-connection scan, qsocket allocation, reply framing) -- this is
    the "pump both ends" the unit brief asks for, just without the blocking
    client state machine in the loop.
  - The resulting server-side `QsocketT` (from the pool) and a hand-built
    client-side `QsocketT` (wired to the same fake ports the handshake
    established, since nothing beyond this driver's own Send/Get/CanSend
    functions -- called directly, not through net_main.ts's NET_SendMessage/
    NET_GetMessage wrappers -- needs it to come from the pool) drive the
    fragmentation/ack/duplicate/unreliable assertions.
*/

import { describe, test, expect } from "bun:test";
import { QsocketT, QsockaddrT, NetLandriverT, CCREQ_CONNECT, CCREP_ACCEPT, NET_PROTOCOL_VERSION, NETFLAG_CTL, NETFLAG_LENGTH_MASK, NETFLAG_DATA, NETFLAG_ACK, NETFLAG_EOM, NET_HEADERSIZE } from "../src/common/net";
import { netDatagramDriver } from "../src/common/net_dgrm";
import { NET_Init, registerLandriver, setNetHostHooks, NET_CheckNewConnections, type NetHostHooks } from "../src/common/net_main";
import { Cmd_ExecuteString, CmdSourceT } from "../src/common/cmd";
import { SizeBuf, SZ_Alloc, SZ_Write, SZ_Clear, net_message, MSG_WriteByte, MSG_WriteLong, MSG_WriteString, MSG_BeginReading, MSG_ReadByte, MSG_ReadLong } from "../src/common/sizebuf";

//============================================================================
// fake in-memory landriver -- see file header

const AF_INET = 2;

interface FakePacket {
  data: Uint8Array;
  fromPort: number;
}

interface SentEntry {
  fromSocket: number;
  toPort: number;
  bytes: Uint8Array;
}

let nextFakePort = 40000;
const fakeQueues = new Map<number, FakePacket[]>();
const sentLog: SentEntry[] = [];
let fakeAcceptPort = -1;

function newFakeAddr(): QsockaddrT {
  return new QsockaddrT();
}

function fakeFillAddr(addr: QsockaddrT, port: number): void {
  addr.sa_family = AF_INET;
  addr.sa_data.fill(0);
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  addr.sa_data[2] = 127;
  addr.sa_data[3] = 0;
  addr.sa_data[4] = 0;
  addr.sa_data[5] = 1;
}

function fakePortOf(addr: QsockaddrT): number {
  return (addr.sa_data[0] << 8) | addr.sa_data[1];
}

function Fake_Init(): number {
  const p = nextFakePort++;
  fakeQueues.set(p, []);
  return p;
}

function Fake_Shutdown(): void {
  //
}

function Fake_Listen(state: boolean): void {
  if (state) {
    if (fakeAcceptPort !== -1) return;
    fakeAcceptPort = nextFakePort++;
    fakeQueues.set(fakeAcceptPort, []);
  } else {
    if (fakeAcceptPort === -1) return;
    fakeQueues.delete(fakeAcceptPort);
    fakeAcceptPort = -1;
  }
}

function Fake_OpenSocket(port: number): number {
  const p = port !== 0 ? port : nextFakePort++;
  fakeQueues.set(p, []);
  return p;
}

function Fake_CloseSocket(socket: number): number {
  fakeQueues.delete(socket);
  return 0;
}

function Fake_Connect(_socket: number, _addr: QsockaddrT): number {
  return 0; // connectionless, exactly like net_udp.ts's UDP_Connect -- see its file header
}

function Fake_CheckNewConnections(): number {
  if (fakeAcceptPort === -1) return -1;
  const q = fakeQueues.get(fakeAcceptPort);
  return q && q.length > 0 ? fakeAcceptPort : -1;
}

function Fake_Read(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number {
  const q = fakeQueues.get(socket);
  if (!q) return -1;
  const pkt = q.shift();
  if (!pkt) return 0;
  const n = Math.min(len, pkt.data.length);
  buf.set(pkt.data.subarray(0, n), 0);
  fakeFillAddr(addr, pkt.fromPort);
  return n;
}

function Fake_Write(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number {
  const destPort = fakePortOf(addr);
  const bytes = buf.slice(0, len);
  sentLog.push({ fromSocket: socket, toPort: destPort, bytes });
  const q = fakeQueues.get(destPort);
  if (!q) return -1;
  q.push({ data: bytes, fromPort: socket });
  return len;
}

function Fake_Broadcast(socket: number, buf: Uint8Array, len: number): number {
  // not exercised by this suite (no _Datagram_SearchForHosts scenario)
  void socket;
  void buf;
  void len;
  return len;
}

function Fake_AddrToString(addr: QsockaddrT): string {
  return `127.0.0.1:${fakePortOf(addr)}`;
}

function Fake_StringToAddr(s: string, addr: QsockaddrT): number {
  const m = /:(\d+)$/.exec(s);
  fakeFillAddr(addr, m ? Number(m[1]) : 0);
  return 0;
}

function Fake_GetSocketAddr(socket: number, addr: QsockaddrT): number {
  fakeFillAddr(addr, socket);
  return 0;
}

function Fake_GetNameFromAddr(addr: QsockaddrT): string {
  return Fake_AddrToString(addr);
}

function Fake_GetAddrFromName(name: string, addr: QsockaddrT): number {
  const port = Number(name);
  if (!Number.isFinite(port) || port <= 0) return -1;
  fakeFillAddr(addr, port);
  return 0;
}

function Fake_AddrCompare(addr1: QsockaddrT, addr2: QsockaddrT): number {
  if (addr1.sa_family !== addr2.sa_family) return -1;
  for (let i = 2; i <= 5; i++) if (addr1.sa_data[i] !== addr2.sa_data[i]) return -1;
  if (addr1.sa_data[0] !== addr2.sa_data[0] || addr1.sa_data[1] !== addr2.sa_data[1]) return 1;
  return 0;
}

function Fake_GetSocketPort(addr: QsockaddrT): number {
  return (addr.sa_data[0] << 8) | addr.sa_data[1];
}

function Fake_SetSocketPort(addr: QsockaddrT, port: number): number {
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  return 0;
}

const fakeLandriver: NetLandriverT = {
  name: "FakeLan",
  initialized: false,
  controlSock: 0,
  Init: Fake_Init,
  Shutdown: Fake_Shutdown,
  Listen: Fake_Listen,
  OpenSocket: Fake_OpenSocket,
  CloseSocket: Fake_CloseSocket,
  Connect: Fake_Connect,
  CheckNewConnections: Fake_CheckNewConnections,
  Read: Fake_Read,
  Write: Fake_Write,
  Broadcast: Fake_Broadcast,
  AddrToString: Fake_AddrToString,
  StringToAddr: Fake_StringToAddr,
  GetSocketAddr: Fake_GetSocketAddr,
  GetNameFromAddr: Fake_GetNameFromAddr,
  GetAddrFromName: Fake_GetAddrFromName,
  AddrCompare: Fake_AddrCompare,
  GetSocketPort: Fake_GetSocketPort,
  SetSocketPort: Fake_SetSocketPort,
};

//============================================================================
// bring-up -- see file header for why NET_Init()+"listen 1" (not driving
// Datagram_Init/Datagram_Listen's object methods directly) is what reliably
// gets `net_drivers[1].initialized`/`listening` into the state
// NET_CheckNewConnections needs, on a shared module registry other test
// files also touch (net_main.ts's own qsocket pool, `net_drivers`, and
// `listening` flag are process-wide singletons -- see net_loop.test.ts's
// file header for the measured proof bun shares module state across files).

const fakeHooks: NetHostHooks = {
  svActive: () => false,
  svName: () => "",
  svsMaxclients: () => 8,
  svsMaxclientslimit: () => 8,
  setSvsMaxclients: () => {},
  clsStateDedicated: () => false,
  svsClients: () => [],
  deathmatch: () => false,
  hostClientPrivileged: () => false,
  svClientPrintf: () => {},
  scrUpdateScreen: () => {},
  menuSetReturnReason: () => {},
  menuHandleConnectError: () => {},
  menuConnectSucceeded: () => {},
  hostTime: () => 0,
};

registerLandriver(fakeLandriver); // net_bsd.c's net_landrivers[] static init equivalent
setNetHostHooks(fakeHooks);
NET_Init(); // registers "listen" (among others), inits Datagram_Init -> fakeLandriver.Init()
Cmd_ExecuteString("listen 1", CmdSourceT.src_command); // flips `listening`; opens the fake accept socket via Datagram_Listen(true)

//============================================================================
// wire helpers

function readBigEndianU32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function patchControlHeader(len: number, flags: number): void {
  const value = (flags | (len & NETFLAG_LENGTH_MASK)) >>> 0;
  net_message.data[0] = (value >>> 24) & 0xff;
  net_message.data[1] = (value >>> 16) & 0xff;
  net_message.data[2] = (value >>> 8) & 0xff;
  net_message.data[3] = value & 0xff;
}

function buildCcreqConnect(): Uint8Array {
  SZ_Clear(net_message);
  MSG_WriteLong(net_message, 0); // reserve header space, patched below -- matches _Datagram_Connect
  MSG_WriteByte(net_message, CCREQ_CONNECT);
  MSG_WriteString(net_message, "QUAKE");
  MSG_WriteByte(net_message, NET_PROTOCOL_VERSION);
  patchControlHeader(net_message.cursize, NETFLAG_CTL);
  const out = net_message.data.slice(0, net_message.cursize);
  SZ_Clear(net_message);
  return out;
}

function loadIntoNetMessage(bytes: Uint8Array): void {
  SZ_Clear(net_message);
  net_message.data.set(bytes, 0);
  net_message.cursize = bytes.length;
}

function makeSizeBuf(bytes: Uint8Array): SizeBuf {
  const sb = new SizeBuf();
  SZ_Alloc(sb, 4096);
  SZ_Write(sb, bytes, bytes.length);
  return sb;
}

//============================================================================

describe("CCREQ_CONNECT -> CCREP_ACCEPT handshake", () => {
  test("Datagram_CheckNewConnections accepts a well-formed request and replies with CCREP_ACCEPT", () => {
    const clientSocket = fakeLandriver.OpenSocket(0);
    const acceptAddr = newFakeAddr();
    fakeFillAddr(acceptAddr, fakeAcceptPort);

    const request = buildCcreqConnect();
    expect(fakeLandriver.Write(clientSocket, request, request.length, acceptAddr)).toBe(request.length);

    sentLog.length = 0;
    const serverSock = NET_CheckNewConnections();
    expect(serverSock).not.toBeNull();
    expect(serverSock).toBeInstanceOf(QsocketT);
    if (!serverSock) throw new Error("unreachable");

    // the reply landed in the client's own queue, addressed back to it
    expect(sentLog.length).toBe(1);
    expect(sentLog[0].toPort).toBe(clientSocket);

    const reply = sentLog[0].bytes;
    const header = readBigEndianU32(reply, 0);
    expect(header & NETFLAG_CTL).not.toBe(0);
    expect(header & NETFLAG_LENGTH_MASK).toBe(reply.length);

    loadIntoNetMessage(reply);
    MSG_BeginReading();
    MSG_ReadLong(); // advance past the big-endian control header; see net_dgrm.ts's own peekControlHeader/MSG_ReadLong() pairing
    expect(MSG_ReadByte()).toBe(CCREP_ACCEPT);
    const acceptedPort = MSG_ReadLong();
    expect(acceptedPort).toBe(serverSock.socket);

    // stash the pair for the message-exchange tests below
    handshakeClientSocket = clientSocket;
    handshakeServerSock = serverSock;
    handshakeAcceptedPort = acceptedPort;
  });
});

let handshakeClientSocket = -1;
let handshakeServerSock: QsocketT | null = null;
let handshakeAcceptedPort = -1;

describe("reliable fragmentation, ack sequencing, duplicate rejection, unreliable delivery", () => {
  test("a 2000-byte reliable message splits into two NETFLAG_DATA fragments; acks drive ackSequence", () => {
    expect(handshakeServerSock).not.toBeNull();
    if (!handshakeServerSock) throw new Error("handshake test must run first");
    const serverSock = handshakeServerSock;

    // hand-built client-side qsocket, wired to the same fake ports the
    // handshake established -- see file header.
    const clientSock = new QsocketT();
    clientSock.socket = handshakeClientSocket;
    clientSock.landriver = 0;
    clientSock.driver = 1;
    fakeFillAddr(clientSock.addr, handshakeAcceptedPort);

    const payload = new Uint8Array(2000);
    for (let i = 0; i < 2000; i++) payload[i] = i & 0xff;
    const msg = makeSizeBuf(payload);

    sentLog.length = 0;
    expect(netDatagramDriver.QSendMessage(clientSock, msg)).toBe(1);
    expect(clientSock.sendSequence).toBe(1);
    expect(clientSock.canSend).toBe(false);

    expect(sentLog.length).toBe(1);
    const frag1 = sentLog[0].bytes;
    const header1 = readBigEndianU32(frag1, 0);
    expect(header1 & NETFLAG_LENGTH_MASK).toBe(NET_HEADERSIZE + 1024);
    expect((header1 & NETFLAG_DATA) !== 0).toBe(true);
    expect((header1 & NETFLAG_EOM) !== 0).toBe(false);
    expect(readBigEndianU32(frag1, 4)).toBe(0); // first fragment's sequence
    expect(Array.from(frag1.subarray(NET_HEADERSIZE))).toEqual(Array.from(payload.subarray(0, 1024)));

    // server receives fragment 1: not the final fragment, so QGetMessage
    // returns 0 (buffered) but still sends an ack.
    sentLog.length = 0;
    expect(netDatagramDriver.QGetMessage(serverSock)).toBe(0);
    expect(sentLog.length).toBe(1);
    const ack1 = sentLog[0].bytes;
    const ackHeader1 = readBigEndianU32(ack1, 0);
    expect(ackHeader1 & NETFLAG_LENGTH_MASK).toBe(NET_HEADERSIZE);
    expect((ackHeader1 & NETFLAG_ACK) !== 0).toBe(true);
    expect(readBigEndianU32(ack1, 4)).toBe(0); // acks sequence 0

    // client processes the ack: ackSequence advances, and since more of the
    // message remains (2000 - 1024 = 976 bytes), Datagram_GetMessage's
    // sock.sendNext handling auto-sends fragment 2 in the same call.
    sentLog.length = 0;
    expect(netDatagramDriver.QGetMessage(clientSock)).toBe(0);
    expect(clientSock.ackSequence).toBe(1);
    expect(sentLog.length).toBe(1);
    const frag2 = sentLog[0].bytes;
    const header2 = readBigEndianU32(frag2, 0);
    expect(header2 & NETFLAG_LENGTH_MASK).toBe(NET_HEADERSIZE + 976);
    expect((header2 & NETFLAG_EOM) !== 0).toBe(true);
    expect(readBigEndianU32(frag2, 4)).toBe(1); // second fragment's sequence
    expect(Array.from(frag2.subarray(NET_HEADERSIZE))).toEqual(Array.from(payload.subarray(1024, 2000)));

    // server receives fragment 2 (EOM): the full 2000-byte message
    // assembles and QGetMessage returns 1, plus a second ack goes out.
    sentLog.length = 0;
    expect(netDatagramDriver.QGetMessage(serverSock)).toBe(1);
    expect(net_message.cursize).toBe(2000);
    expect(Array.from(net_message.data.subarray(0, 2000))).toEqual(Array.from(payload));
    expect(sentLog.length).toBe(1);
    expect(readBigEndianU32(sentLog[0].bytes, 4)).toBe(1); // acks sequence 1

    // client processes the second ack: ackSequence reaches sendSequence,
    // the message is fully drained, and canSend returns to true.
    sentLog.length = 0;
    expect(netDatagramDriver.QGetMessage(clientSock)).toBe(0);
    expect(clientSock.ackSequence).toBe(2);
    expect(clientSock.sendMessageLength).toBe(0);
    expect(clientSock.canSend).toBe(true);

    savedClientSock = clientSock;
  });

  let savedClientSock: QsocketT | null = null;

  test("a duplicate/out-of-order reliable packet is acked but not delivered, and does not advance receiveSequence", () => {
    expect(handshakeServerSock).not.toBeNull();
    if (!handshakeServerSock) throw new Error("handshake test must run first");
    const serverSock = handshakeServerSock;
    const clientSock = savedClientSock;
    expect(clientSock).not.toBeNull();
    if (!clientSock) throw new Error("prior test must run first");

    const receiveSequenceBefore = serverSock.receiveSequence;

    const payload = new Uint8Array([1, 2, 3, 4]);
    const packetLen = NET_HEADERSIZE + payload.length;
    const bogusSequence = receiveSequenceBefore + 99;

    const raw = new Uint8Array(packetLen);
    const headerValue = (NETFLAG_DATA | NETFLAG_EOM | packetLen) >>> 0;
    raw[0] = (headerValue >>> 24) & 0xff;
    raw[1] = (headerValue >>> 16) & 0xff;
    raw[2] = (headerValue >>> 8) & 0xff;
    raw[3] = headerValue & 0xff;
    raw[4] = (bogusSequence >>> 24) & 0xff;
    raw[5] = (bogusSequence >>> 16) & 0xff;
    raw[6] = (bogusSequence >>> 8) & 0xff;
    raw[7] = bogusSequence & 0xff;
    raw.set(payload, NET_HEADERSIZE);

    const destAddr = newFakeAddr();
    fakeFillAddr(destAddr, serverSock.socket);
    // deliver it as if it arrived from the client's socket, addressed to the server's per-connection socket
    fakeLandriver.Write(clientSock.socket, raw, raw.length, destAddr);

    sentLog.length = 0;
    expect(netDatagramDriver.QGetMessage(serverSock)).toBe(0); // rejected, no application data surfaces
    expect(serverSock.receiveSequence).toBe(receiveSequenceBefore); // did not advance

    // it is still acked, per the C (the ack write happens before the
    // sequence check) -- with the bogus packet's own sequence number.
    expect(sentLog.length).toBe(1);
    const ackHeader = readBigEndianU32(sentLog[0].bytes, 0);
    expect(ackHeader & NETFLAG_LENGTH_MASK).toBe(NET_HEADERSIZE);
    expect((ackHeader & NETFLAG_ACK) !== 0).toBe(true);
    expect(readBigEndianU32(sentLog[0].bytes, 4)).toBe(bogusSequence);
  });

  test("an unreliable message arrives on the other side with return 2", () => {
    expect(handshakeServerSock).not.toBeNull();
    if (!handshakeServerSock) throw new Error("handshake test must run first");
    const serverSock = handshakeServerSock;
    const clientSock = savedClientSock;
    expect(clientSock).not.toBeNull();
    if (!clientSock) throw new Error("prior test must run first");

    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const msg = makeSizeBuf(payload);

    sentLog.length = 0;
    expect(netDatagramDriver.SendUnreliableMessage(serverSock, msg)).toBe(1);
    // unreliable delivery is never acked
    expect(sentLog.length).toBe(1);
    expect((readBigEndianU32(sentLog[0].bytes, 0) & NETFLAG_ACK) !== 0).toBe(false);

    const ret = netDatagramDriver.QGetMessage(clientSock);
    expect(ret).toBe(2);
    expect(Array.from(net_message.data.subarray(0, net_message.cursize))).toEqual(Array.from(payload));
  });
});
