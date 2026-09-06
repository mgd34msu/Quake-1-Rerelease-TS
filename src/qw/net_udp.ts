/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/net_udp.c and QW/client/net.h (GNU GPL v2 or later).

Q003. QW/client/net_udp.c's own top-of-file comment reads "// net_main.c" --
the file on disk in the QW/client tree is a copy of NetQuake's net_main.c
(the driver-independent half of the UDP transport: the netadr_t helpers,
NET_GetPacket/NET_SendPacket, NET_Init/NET_Shutdown, the module-owned
net_local_adr/net_from/net_message/net_message_buffer/net_socket globals),
not a renamed net_udp.c/net_wins.c driver file. Ported here anyway under the
net_udp.ts name per the unit brief's file mapping.

The socket layer is the same BSD-socket set the C calls -- socket/bind/close/
sendto/recvfrom/getsockname/ioctl, with `errno` and `strerror()` -- reached
through `src/platform/sockets.ts`, which binds them out of the host OS's own
library (libc.so.6 / libSystem.B.dylib / ws2_32.dll) and supplies the per-OS
constants, entry-point names and errno values. `struct sockaddr_in` is laid
out by hand in a 16-byte Uint8Array (sin_family, sin_port big-endian u16,
sin_addr 4 bytes), so NetadrToSockadr/SockadrToNetadr port literally; only
sin_family's encoding differs across the three targets (macOS's BSD
`sin_len`/`sin_family` byte pair), and that lives in sockets.ts.

Why libc and not `Bun.udpSocket` (which this module used first): the C's
NET_SendPacket and NET_GetPacket both branch on errno --
EWOULDBLOCK/ECONNREFUSED are silent, anything else prints -- and
`Bun.udpSocket` exposes no errno. Its `send()` throws ECONNREFUSED
synchronously instead, which unwound out of Host_Frame and killed qwcl
whenever a server went away and qwsv on a `heartbeat` to an unreachable
master (.orch/e2e/E.md, Defects A and F), while its `error` callback printed
"NET_GetPacket: undefined" once per frame where the C is silent (Defect D).
With real non-blocking file descriptors both functions are the C's, errno
switch included.

Deviations from the brief / from Quake 2's net_udp.ts:
- netadr_t here is QW's actual struct, confirmed by direct reading of
  QW/client/net.h: `{ byte ip[4]; unsigned short port; unsigned short pad; }`
  -- no `type` discriminant, no NA_LOOPBACK/NA_BROADCAST/NA_IP enum, no ipx
  field. QW has no single-player mode and no loopback network driver -- even
  a locally hosted game connects over a real UDP socket to 127.0.0.1 -- so
  there is nothing for a type tag to distinguish. This is a deliberate
  departure from the brief's suggestion to reuse Quake 2's netadr_t shape
  (PORTING.md: "the netadr_t shape as in Quake 2's port"); "port QW's
  exactly" (the brief's own words) wins where the two directives conflict,
  since the real header has no such field to carry over.
- UDP_OpenSocket does not set SO_BROADCAST. The brief anticipated it, but
  QW/client/net_udp.c's UDP_OpenSocket (unlike some other id UDP drivers)
  never calls setsockopt(SO_BROADCAST) -- confirmed by direct reading.
  Nothing here calls it either.
- NET_Init is synchronous again, exactly as the C is: UDP_OpenSocket's
  socket()/ioctl()/bind() all complete before NET_Init returns, and a bind
  failure reaches Sys_Error from inside NET_Init the way the C's does, so a
  second qwcl on a busy port dies inside main(). `NET_Ready()` is kept as an
  export (src/qw/main_cl.ts and src/qw/main_sv.ts await it, as do tests) but
  is now trivially resolved: by the time NET_Init has returned there is
  nothing left to wait for.
- The C's UDP_OpenSocket Sys_Error calls read `Sys_Error ("UDP_OpenSocket:
  socket:", strerror(errno))` -- a format string with no %s, so the
  strerror() argument is silently dropped. Ported literally, argument
  included, so the message reads the same as the C's.
- A socket-library load failure has no equivalent in the C (libc is linked
  in). If it cannot be opened, UDP_OpenSocket takes the same Sys_Error path
  a failed socket() takes.
- NET_GetPacket's recvfrom is bounded by net_message_buffer's own length at
  the syscall, exactly as the C's is, so a datagram larger than the buffer
  is truncated by the kernel rather than needing a JS-side bounds check.
- `net_message` is the same SizeBuf singleton object exported by
  src/common/sizebuf.ts. That module's MSG_Read* functions are hardwired to
  read from their own singleton (matching the real C prototypes, e.g.
  `int MSG_ReadLong (void)` -- no sizebuf_t parameter, unlike Quake 2's
  MSG_ReadLong(sizebuf_t*)), so there is no way to give QW an independent
  net_message object and still use those functions. Since qwcl/qwsv/quake
  never run in the same process, reusing the one singleton as QW's own
  process-global net_message is exactly the WinQuake net_main.c ownership
  model sizebuf.ts's own header comment describes, just reused for a second
  binary. NET_Init resizes its `.data`/`.maxsize` to MAX_UDP_PACKET (8192)
  bytes; test suites that call NET_Init must restore the original
  data/maxsize/cursize afterward (rule 15 -- shared singleton).
- net_send_socket (declared, never read or assigned anywhere in net_chan.c,
  net_main.c, or any other QW/client file -- confirmed by a repo-wide grep)
  is vestigial in the reference engine itself; not ported, matching the
  PORTING.md idiom of dropping dead globals rather than preserving unused
  ones for their own sake. Reported nonetheless since the brief's struct
  list mentions the field.
- NET_GetLocalAddress calls the C's `gethostname()` + `NET_StringToAdr()`
  pair, but this port's NET_StringToAdr resolves dotted quads and
  "localhost" only (the ruling below), never a machine name through
  gethostbyname, so net_local_adr's IP stays 127.0.0.1 unless a `-ip`
  command-line parameter gives a dotted quad -- as the brief rules, and what
  the e2e harness's two-clients-on-one-host `-ip 127.0.0.1`/`127.0.0.2`
  arrangement depends on. getsockname() supplies the bound port exactly as
  in the C.
- NET_StringToAdr: RULING per brief -- dotted quads only; a leading
  non-digit character (the C's gethostbyname path) returns false rather than
  attempting any DNS lookup.
*/

import { ptr } from "bun:ffi";
import { Q_atoi, COM_CheckParm, com_argv } from "../common/common";
import { net_message } from "../common/sizebuf";
import { Sys_Error, Sys_Printf } from "../platform/sys";
import { Con_Printf } from "../client/console";
import {
  SOCKADDR_SIZE,
  currentSockTarget,
  openSocketApi,
  qwGetPacketDisposition,
  qwSendPacketDisposition,
  sockConstants,
  socketApiFailure,
  writeSockaddrIn,
  type SocketApi,
} from "../platform/sockets";

// net.h
export const PORT_ANY = -1;

export class NetadrT {
  ip: Uint8Array = new Uint8Array(4);
  port = 0;
  pad = 0;
}

// `netadr_t` is a plain struct in the C, so every `a = b` on one is a copy.
// It is a class here, so the copies the C gets for free are explicit; this is
// the one helper both net_chan.ts's Netchan_Setup and server/sv_main.ts's
// stored-address assignments use, so no stored address ever aliases the
// `net_from` singleton. Not a QW/client/net_udp.c function.
export function copyNetadr(src: NetadrT): NetadrT {
  const a = new NetadrT();
  a.ip.set(src.ip);
  a.port = src.port;
  a.pad = src.pad;
  return a;
}

export const net_local_adr: NetadrT = new NetadrT();
export const net_from: NetadrT = new NetadrT(); // address of who sent the packet
export { net_message }; // sizebuf_t net_message -- see file header

const MAX_UDP_PACKET = 8192;
export const net_message_buffer: Uint8Array = new Uint8Array(MAX_UDP_PACKET);

// net_send_socket -- vestigial, not ported (see file header)

//=============================================================================
// address helpers (NetadrToSockadr/SockadrToNetadr have no Bun equivalent;
// see file header)

function stringToIpBytes(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

export function NET_CompareBaseAdr(a: NetadrT, b: NetadrT): boolean {
  return a.ip[0] === b.ip[0] && a.ip[1] === b.ip[1] && a.ip[2] === b.ip[2] && a.ip[3] === b.ip[3];
}

export function NET_CompareAdr(a: NetadrT, b: NetadrT): boolean {
  return a.ip[0] === b.ip[0] && a.ip[1] === b.ip[1] && a.ip[2] === b.ip[2] && a.ip[3] === b.ip[3] && a.port === b.port;
}

export function NET_AdrToString(a: NetadrT): string {
  // sprintf (s, "%i.%i.%i.%i:%i", ..., ntohs(a.port)) -- port kept host-order
  // throughout this port (see brief); the ntohs() call in the C undoes the
  // network-byte-order storage this port never adopts, so it is simply
  // absent here rather than becoming a no-op call.
  return `${a.ip[0]}.${a.ip[1]}.${a.ip[2]}.${a.ip[3]}:${a.port}`;
}

export function NET_BaseAdrToString(a: NetadrT): string {
  return `${a.ip[0]}.${a.ip[1]}.${a.ip[2]}.${a.ip[3]}`;
}

/*
=============
NET_StringToAdr

idnewt
idnewt:28000
192.246.40.70
192.246.40.70:28000
=============
*/
export function NET_StringToAdr(s: string, a: NetadrT): boolean {
  let host = s;
  let port = 0;

  // strip off a trailing :port if present -- the C's char-by-char loop
  // truncates at the first colon it finds and parses the port from
  // whatever follows the last one; realistic input (an IPv4 dotted quad,
  // never containing a colon) only ever has at most one, so lastIndexOf
  // reproduces both without needing the C's exact quirky double-role loop.
  const colon = s.lastIndexOf(":");
  if (colon !== -1) {
    host = s.slice(0, colon);
    port = Q_atoi(s.slice(colon + 1)) & 0xffff;
  }

  if (host.length === 0) return false;

  const firstChar = host.charCodeAt(0);
  if (firstChar < 48 || firstChar > 57) {
    // gethostbyname path: Bun has no synchronous resolver, so only the
    // loopback name resolves here (see file header); other names fail as
    // the C does for an unknown host.
    if (host !== "localhost") return false;
    host = "127.0.0.1";
  }

  const ip = stringToIpBytes(host);
  if (!ip) return false;

  a.ip.set(ip);
  a.port = port;
  a.pad = 0;

  return true;
}

// Returns true if we can't bind the address locally--in other words,
// the IP is NOT one of our interfaces.
//
// The C body is entirely `#if 0`'d out (a bind-probe against a real
// sockaddr_in) with `#else return true; #endif` selecting the always-true
// path in every real build -- dropped per PORTING.md's "#if 0 is dropped
// silently" rule; only the compiled `return true;` survives.
export function NET_IsClientLegal(_adr: NetadrT): boolean {
  return true;
}

//=============================================================================

// BSD sockets through src/platform/sockets.ts -- see file header.

function lib(): SocketApi | null {
  return openSocketApi();
}

// <sys/socket.h>, <netinet/in.h>, <sys/ioctl.h>, <errno.h> -- see sockets.ts
// for the per-OS values behind these names.
const target = currentSockTarget();
const { AF_INET, PF_INET, SOCK_DGRAM, IPPROTO_UDP, FIONBIO } = sockConstants(target);

//=============================================================================

// The C's own two helpers, now that there is a real sockaddr_in to fill.
// `netadr_t.port` is kept in host order throughout this port (see
// NET_AdrToString), so the htons()/ntohs() the C leaves implicit in
// `s->sin_port = a->port` is done explicitly here at the byte level.
function NetadrToSockadr(a: NetadrT, s: Uint8Array): void {
  writeSockaddrIn(target, s, AF_INET, a.port, a.ip);
}

function SockadrToNetadr(s: Uint8Array, a: NetadrT): void {
  a.ip[0] = s[4];
  a.ip[1] = s[5];
  a.ip[2] = s[6];
  a.ip[3] = s[7];
  a.port = (s[2] << 8) | s[3];
  a.pad = 0;
}

//=============================================================================

let net_socket = -1; // non blocking, for receives

// Scratch sockaddr buffers -- the C's are function-local stack structs, and
// this module, like the C, is single-threaded and never re-enters itself.
const fromSockaddr = new Uint8Array(SOCKADDR_SIZE);
const toSockaddr = new Uint8Array(SOCKADDR_SIZE);
const socklenBuf = new Uint32Array(1);
const optvalBuf = new Int32Array(1);
const INADDR_ANY = new Uint8Array(4);

// Test/caller seam kept from the Bun.udpSocket implementation this replaced:
// UDP_OpenSocket's bind is synchronous again, so by the time NET_Init has
// returned there is nothing to wait for and this is already resolved. Not
// part of net.h. src/qw/main_cl.ts and src/qw/main_sv.ts still await it.
export function NET_Ready(): Promise<void> {
  return Promise.resolve();
}

function UDP_OpenSocket(port: number): number {
  const l = lib();
  if (!l) Sys_Error("UDP_OpenSocket: socket:", socketApiFailure());

  const newsocket = l.socket(PF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (newsocket === -1) Sys_Error("UDP_OpenSocket: socket:", l.strerror(l.errno()));

  optvalBuf[0] = 1; // qboolean _true = true
  if (l.ioctl(newsocket, FIONBIO, ptr(optvalBuf)) === -1) Sys_Error("UDP_OpenSocket: ioctl FIONBIO:", l.strerror(l.errno()));

  const address = new Uint8Array(SOCKADDR_SIZE);
  writeSockaddrIn(target, address, AF_INET, 0, INADDR_ANY);

  //ZOID -- check for interface binding option
  const ipParm = COM_CheckParm("-ip");
  if (ipParm !== 0 && ipParm < com_argv.length - 1) {
    const parmIp = com_argv[ipParm + 1];
    const bytes = parmIp === undefined ? null : stringToIpBytes(parmIp);
    if (bytes) {
      address[4] = bytes[0];
      address[5] = bytes[1];
      address[6] = bytes[2];
      address[7] = bytes[3];
      Con_Printf(`Binding to IP Interface Address of ${parmIp}\n`);
    }
  }
  // else address.sin_addr.s_addr = INADDR_ANY -- the buffer is already zeroed

  if (port !== PORT_ANY) {
    address[2] = (port >> 8) & 0xff; // htons((short)port)
    address[3] = port & 0xff;
  }

  if (l.bind(newsocket, ptr(address), SOCKADDR_SIZE) === -1) Sys_Error("UDP_OpenSocket: bind: %s", l.strerror(l.errno()));

  return newsocket;
}

function NET_GetLocalAddress(): void {
  // gethostname(buff, MAXHOSTNAMELEN) + NET_StringToAdr(buff): this port's
  // NET_StringToAdr never resolves a machine name (see file header), so the
  // `-ip` interface address, or 127.0.0.1, stands in for it.
  const ipParm = COM_CheckParm("-ip");
  let ipStr = "127.0.0.1";
  if (ipParm !== 0 && ipParm < com_argv.length - 1) {
    const parmIp = com_argv[ipParm + 1];
    if (parmIp !== undefined) ipStr = parmIp;
  }

  NET_StringToAdr(ipStr, net_local_adr);

  const l = lib();
  if (l) {
    const address = new Uint8Array(SOCKADDR_SIZE);
    socklenBuf[0] = SOCKADDR_SIZE;
    if (l.getsockname(net_socket, ptr(address), ptr(socklenBuf)) === -1) Sys_Error("NET_Init: getsockname:", l.strerror(l.errno()));
    net_local_adr.port = (address[2] << 8) | address[3];
  }

  Con_Printf(`IP address ${NET_AdrToString(net_local_adr)}\n`);
}

/*
====================
NET_Init
====================
*/
export function NET_Init(port: number): void {
  //
  // open the single socket to be used for all communications
  //
  net_socket = UDP_OpenSocket(port);

  //
  // init the message buffer
  //
  net_message.maxsize = net_message_buffer.length;
  net_message.data = net_message_buffer;
  net_message.cursize = 0;

  //
  // determine my name & address
  //
  NET_GetLocalAddress();

  Con_Printf("UDP Initialized\n");
}

/*
====================
NET_Shutdown
====================
*/
export function NET_Shutdown(): void {
  const l = lib();
  if (l && net_socket !== -1) l.close(net_socket);
  net_socket = -1;
}

export function NET_GetPacket(): boolean {
  const l = lib();
  if (!l || net_socket === -1) return false;

  socklenBuf[0] = SOCKADDR_SIZE;
  fromSockaddr.fill(0);
  const ret = l.recvfrom(net_socket, ptr(net_message_buffer), net_message_buffer.length, 0, ptr(fromSockaddr), ptr(socklenBuf));
  if (ret === -1) {
    const e = l.errno();
    const disposition = qwGetPacketDisposition(target, e);
    if (disposition === "silent") return false;
    if (disposition === "oversize") {
      // QW/client/net_wins.c's WSAEMSGSIZE branch -- see sockets.ts's header
      SockadrToNetadr(fromSockaddr, net_from);
      Con_Printf(`Warning:  Oversize packet from ${NET_AdrToString(net_from)}\n`);
      return false;
    }
    Sys_Printf("NET_GetPacket: %s\n", l.strerror(e));
    return false;
  }

  net_message.cursize = ret;
  SockadrToNetadr(fromSockaddr, net_from);

  return ret !== 0;
}

export function NET_SendPacket(length: number, data: Uint8Array, to: NetadrT): void {
  const l = lib();
  if (!l || net_socket === -1) return;

  NetadrToSockadr(to, toSockaddr);

  const n = length < data.length ? length : data.length;
  const ret = l.sendto(net_socket, ptr(data), n, 0, ptr(toSockaddr), SOCKADDR_SIZE);
  if (ret === -1) {
    const e = l.errno();
    if (qwSendPacketDisposition(target, e) === "silent") return;
    Sys_Printf("NET_SendPacket: %s\n", l.strerror(e));
  }
}
