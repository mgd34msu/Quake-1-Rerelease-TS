/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/net_udp.h and WinQuake/net_udp.c (GNU GPL v2 or later),
folding in win32/net_wins.c's `-ip` command-line override (linux/net_udp.c
itself has no `-ip` handling; the unit brief for this port explicitly rules
it in here) -- net_wins.c/net_bsd.c themselves are not separately ported
(PORTING.md's platform mapping: one LAN driver).

This module implements one `net_landriver_t` (net.h) directly on the same
BSD-socket calls net_udp.c itself uses -- socket/bind/close/sendto/recvfrom/
getsockname/setsockopt/ioctl/gethostname/gethostbyname plus `errno` -- reached
through `src/platform/sockets.ts`, which binds them out of the host OS's own
library (libc.so.6 / libSystem.B.dylib / ws2_32.dll) and supplies the per-OS
constants, entry-point names and errno values. `struct sockaddr_in` is laid
out by hand in a 16-byte `Uint8Array` (sin_family, sin_port big-endian u16,
sin_addr 4 bytes, 8 bytes of padding) -- byte-for-byte the layout the C
reinterprets `struct qsockaddr` as; `inet_addr`/`inet_ntoa`/`htons`/`ntohs`
are done in TS on those bytes. Only sin_family's encoding differs across the
three targets (macOS's BSD `sin_len`/`sin_family` byte pair), and that is
sockets.ts's `writeSockaddrFamily`/`readSockaddrFamily`.

Why libc and not `Bun.udpSocket`: net_dgrm.c's `_Datagram_Connect` sends
CCREQ_CONNECT and then busy-waits in a synchronous `do { dfunc.Read(...) }
while (... < 2.5)` loop for the reply (net_dgrm.c:1097-1134 in this port's
net_dgrm.ts), and `Datagram_CheckNewConnections`/`Datagram_GetMessage` poll
the same way. That idiom requires `recvfrom` to be a synchronous call the
engine thread can make at any moment, which is exactly what net_udp.c's
non-blocking sockets give it. `Bun.udpSocket` only ever delivers a datagram
through an event-loop `data()` callback, so nothing could arrive while the
engine spun and every real (non-loopback) client connect reported "No
Response" (.orch/e2e/D.md, Defect A). The sockets below are real file
descriptors put in non-blocking mode with `ioctl(FIONBIO)` exactly as
UDP_OpenSocket does, so `int` socket handles, the `net_broadcastsocket == 0`
sentinel and the C's whole polling structure all carry over unchanged.

Deviations from the C:
- `struct qsockaddr { short sa_family; unsigned char sa_data[14]; }` ->
  `QsockaddrT { sa_family: number; sa_data: Uint8Array (14) }` (net.ts).
  Every place the C hands a `struct qsockaddr *` straight to a socket call,
  this file marshals that object into/out of a 16-byte scratch buffer
  (`qsockaddrToNative`/`nativeToQsockaddr`) at the identical offsets.
- Socket-library load failure: there is no equivalent in the C (libc is
  linked in). If it cannot be opened, `UDP_Init` returns -1 -- the same result
  `-noudp` produces, so the engine runs with the loopback driver only --
  and every other entry point returns its own "no socket" error value
  instead of throwing.
- UDP_GetNameFromAddr: the C's `gethostbyaddr` reverse lookup is dropped
  (unit brief). It always returns UDP_AddrToString's dotted string, which is
  the C's own fallback when the lookup finds nothing.
- UDP_GetAddrFromName: the C falls through to a blocking `gethostbyname` for
  any name that does not start with a digit. Per the unit brief this port
  resolves digit-leading names through PartialIPAddress (ported exactly) and
  the literal name "localhost" to 127.0.0.1 on net_hostport, and returns -1
  for anything else rather than blocking the engine on a DNS lookup.
  `gethostbyname` is bound below (UDP_Init needs it) if this is ever revisited.
- UDP_Init's `gethostbyname(buff)` result is NULL-checked before
  `local->h_addr_list[0]` is dereferenced; the C dereferences unconditionally
  and segfaults on a machine whose own hostname does not resolve. myAddr
  keeps its 127.0.0.1 default in that case.
- UDP_CheckNewConnections' `ioctl(FIONREAD, &available)` writes 4 bytes into
  the C's 8-byte `unsigned long available`, leaving its top 4 bytes as
  whatever was on the stack. The buffer here is zeroed first and only its
  low 32 bits are read, which is what the C's `if (available)` test means on
  every input FIONREAD can actually produce.
- UDP_Read/UDP_Write clamp the caller's `len` to the JS buffer's own length
  before handing its pointer to recvfrom/sendto. The C has no such clamp;
  no caller in the tree passes a `len` past the end of its buffer, so this
  is unobservable, but a native write past a JS-owned buffer is not
  recoverable the way a C stack smash is.
- `net_hostport`, `my_tcpip_address` and `tcpipAvailable` are net_main.c
  globals net_udp.c reaches by `extern`. They are imported from net_main.ts
  here (`net_hostport` as an ES live binding, the other two written through
  net_main.ts's `setMyTcpipAddress`/`setTcpipAvailable`, since only the
  defining module may reassign an exported `let`) -- the same way net_loop.ts
  already imports `hostname`. `udpState` stays exported as a read-only view
  of those three for callers that already read it.
- PartialIPAddress is ported at byte granularity (this port's IPs are plain
  4-byte arrays, not a raw `sockaddr_in.s_addr` int) instead of literally
  reproducing the C's `mask <<= 8` / `htonl` bit tricks; the two are
  equivalent for every input the function accepts (".56" keeps myAddr's
  high 3 octets, replaces the low 1; "12.34" keeps the high 2, replaces the
  low 2; a full "a.b.c.d" replaces all 4). More than 4 dotted groups is a
  32-bit-shift-past-width UB corner in the original C with no defined
  result to match; this port returns -1 for that input instead (documented
  new behavior for an input class the original never defined).
- UDP_StringToAddr: `sscanf("%d.%d.%d.%d:%d", ...)` always returns 0 in the
  C even on a partial/failed match, leaving the unfilled `int`s as whatever
  was already on the stack (undefined behavior, not reproducible in JS).
  Ported as a regex anchored the same way as the format string; unfilled
  fields read as 0, and the function still always returns 0, matching the
  C's observable return value (never -1).
*/

import { ptr, read } from "bun:ffi";
import { COM_CheckParm, Q_atoi, com_argc, com_argv } from "../common/common";
import { Cvar_Set } from "../common/cvar";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "./sys";
import {
  hostname,
  my_tcpip_address,
  net_hostport,
  setMyTcpipAddress,
  setTcpipAvailable,
  tcpipAvailable,
} from "../common/net_main";
import type { NetLandriverT, QsockaddrT } from "../common/net";
import {
  HOSTENT_H_ADDR_LIST,
  SOCKADDR_SIZE,
  currentSockTarget,
  nqReadErrnoIsSilent,
  nqWriteErrnoIsSilent,
  openSocketApi,
  readSockaddrFamily,
  sockConstants,
  socketApiFailure,
  writeSockaddrFamily,
  writeSockaddrIn,
  type SocketApi,
} from "./sockets";

export type { NetLandriverT, QsockaddrT } from "../common/net";

//=============================================================================
// <sys/socket.h>, <netinet/in.h>, <sys/ioctl.h>, <errno.h> -- see sockets.ts
// for the per-OS values behind these names.

const target = currentSockTarget();
const { AF_INET, PF_INET, SOCK_DGRAM, IPPROTO_UDP, SOL_SOCKET, SO_BROADCAST, FIONBIO, FIONREAD } = sockConstants(target);

// <sys/param.h>
const MAXHOSTNAMELEN = 64;

//=============================================================================

let reportedLibFailure = false;

function lib(): SocketApi | null {
  const api = openSocketApi();
  if (api === null && !reportedLibFailure) {
    reportedLibFailure = true;
    Con_Printf("UDP_Init: %s\n", socketApiFailure());
  }
  return api;
}

//=============================================================================
// scratch buffers, one per call site that needs one live at the same time as
// another -- the C's equivalents are function-local stack structs and this
// module, like the C, is single-threaded and never re-enters itself.

const readSockaddr = new Uint8Array(SOCKADDR_SIZE);
const writeSockaddr = new Uint8Array(SOCKADDR_SIZE);
const getnameSockaddr = new Uint8Array(SOCKADDR_SIZE);
const socklenBuf = new Uint32Array(1);
const optvalBuf = new Int32Array(1);
const availableBuf = new Int32Array(2); // the C's `unsigned long available`
const INADDR_ANY = new Uint8Array(4);

function qsockaddrToNative(addr: QsockaddrT, out: Uint8Array): void {
  writeSockaddrFamily(target, out, addr.sa_family);
  out.set(addr.sa_data.subarray(0, 14), 2);
}

function nativeToQsockaddr(src: Uint8Array, addr: QsockaddrT): void {
  addr.sa_family = readSockaddrFamily(target, src);
  addr.sa_data.set(src.subarray(2, SOCKADDR_SIZE), 0);
}

//=============================================================================
// address byte helpers

function stringToIpBytes(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function fillSockaddr(addr: QsockaddrT, ipBytes: Uint8Array, port: number): void {
  addr.sa_family = AF_INET;
  addr.sa_data.fill(0);
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  addr.sa_data[2] = ipBytes[0] ?? 0;
  addr.sa_data[3] = ipBytes[1] ?? 0;
  addr.sa_data[4] = ipBytes[2] ?? 0;
  addr.sa_data[5] = ipBytes[3] ?? 0;
}

function cstringOf(buf: Uint8Array): string {
  let end = buf.indexOf(0);
  if (end < 0) end = buf.length;
  let s = "";
  for (let i = 0; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}

//=============================================================================
// net_main.c's globals this driver reaches through `extern` -- see header.

export const udpState = {
  get net_hostport(): number {
    return net_hostport;
  },
  get my_tcpip_address(): string {
    return my_tcpip_address;
  },
  get tcpipAvailable(): boolean {
    return tcpipAvailable;
  },
};

//=============================================================================

let net_acceptsocket = -1; // socket for fielding new connections
let net_controlsocket = 0;
let net_broadcastsocket = 0;
const broadcastaddr: QsockaddrT = { sa_family: AF_INET, sa_data: new Uint8Array(14) };

let myAddr: Uint8Array = new Uint8Array([127, 0, 0, 1]);

function UDP_Init(): number {
  if (COM_CheckParm("-noudp")) return -1;

  const l = lib();
  if (!l) return -1; // see header

  // determine my name & address
  const buff = new Uint8Array(MAXHOSTNAMELEN);
  l.gethostname(ptr(buff), MAXHOSTNAMELEN);
  const local = l.gethostbyname(ptr(buff));
  if (local !== null) {
    const addrList = read.ptr(local, HOSTENT_H_ADDR_LIST);
    if (addrList !== 0) {
      const first = read.ptr(addrList, 0);
      if (first !== 0) {
        myAddr = new Uint8Array([read.u8(first, 0), read.u8(first, 1), read.u8(first, 2), read.u8(first, 3)]);
      }
    }
  }

  // net_wins.c's `-ip` override -- see header
  const ipParm = COM_CheckParm("-ip");
  if (ipParm) {
    if (ipParm < com_argc - 1) {
      const parsed = stringToIpBytes(com_argv[ipParm + 1]);
      if (!parsed) Sys_Error("%s is not a valid IP address", com_argv[ipParm + 1]);
      else myAddr = parsed;
    } else {
      Sys_Error("NET_Init: you must specify an IP address after -ip");
    }
  }

  // if the quake hostname isn't set, set it to the machine name
  if (hostname.string === "UNNAMED") {
    Cvar_Set("hostname", cstringOf(buff).slice(0, 15));
  }

  net_controlsocket = UDP_OpenSocket(0);
  if (net_controlsocket === -1) Sys_Error("UDP_Init: Unable to open control socket\n");

  fillSockaddr(broadcastaddr, new Uint8Array([255, 255, 255, 255]), net_hostport);

  const addr: QsockaddrT = { sa_family: 0, sa_data: new Uint8Array(14) };
  UDP_GetSocketAddr(net_controlsocket, addr);
  const withPort = UDP_AddrToString(addr);
  const colon = withPort.lastIndexOf(":");
  setMyTcpipAddress(colon >= 0 ? withPort.slice(0, colon) : withPort);

  Con_Printf("UDP Initialized\n");
  setTcpipAvailable(true);

  return net_controlsocket;
}

function UDP_Shutdown(): void {
  UDP_Listen(false);
  UDP_CloseSocket(net_controlsocket);
}

function UDP_Listen(state: boolean): void {
  // enable listening
  if (state) {
    if (net_acceptsocket !== -1) return;
    net_acceptsocket = UDP_OpenSocket(net_hostport);
    if (net_acceptsocket === -1) Sys_Error("UDP_Listen: Unable to open accept socket\n");
    return;
  }

  // disable listening
  if (net_acceptsocket === -1) return;
  UDP_CloseSocket(net_acceptsocket);
  net_acceptsocket = -1;
}

function UDP_OpenSocket(port: number): number {
  const l = lib();
  if (!l) return -1;

  const newsocket = l.socket(PF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (newsocket === -1) return -1;

  optvalBuf[0] = 1; // qboolean _true = true
  if (l.ioctl(newsocket, FIONBIO, ptr(optvalBuf)) === -1) {
    l.close(newsocket);
    return -1;
  }

  // sin_addr.s_addr = INADDR_ANY; sin_port = htons(port)
  const address = new Uint8Array(SOCKADDR_SIZE);
  writeSockaddrIn(target, address, AF_INET, port, INADDR_ANY);
  if (l.bind(newsocket, ptr(address), SOCKADDR_SIZE) === -1) {
    l.close(newsocket);
    return -1;
  }

  return newsocket;
}

function UDP_CloseSocket(socket: number): number {
  const l = lib();
  if (!l) return -1;

  if (socket === net_broadcastsocket) net_broadcastsocket = 0;
  return l.close(socket);
}

//=============================================================================
/*
============
PartialIPAddress

this lets you type only as much of the net address as required, using
the local network components to fill in the rest
============
*/
// Exported only for the test suite: static in the C (net_udp.c has no
// header declaration for it) and reached in this port the same way, through
// UDP_GetAddrFromName's `name[0]` digit gate below -- which a leading-dot
// input like ".56" never passes, in the C as much as here, so a call
// through the public UDP_GetAddrFromName entry point alone cannot exercise
// that case even though PartialIPAddress itself supports it.
export function PartialIPAddress(input: string, hostaddr: QsockaddrT): number {
  const buff = "." + input;
  let i = buff.charAt(1) === "." ? 1 : 0;

  const octets: number[] = [];
  while (buff.charAt(i) === ".") {
    i++;
    let num = 0;
    let run = 0;
    while (buff.charAt(i) >= "0" && buff.charAt(i) <= "9") {
      num = num * 10 + (buff.charCodeAt(i) - 48);
      i++;
      run++;
      if (run > 3) return -1;
    }
    const next = buff.charAt(i);
    if (next !== "" && next !== "." && next !== ":" && !(next >= "0" && next <= "9")) return -1;
    if (num < 0 || num > 255) return -1;
    octets.push(num);
  }

  if (octets.length === 0 || octets.length > 4) return -1; // see header: >4 groups is UB in the C, not ported

  let port = net_hostport;
  if (buff.charAt(i) === ":") {
    port = Q_atoi(buff.slice(i + 1));
  }

  const addrBytes = new Uint8Array(4);
  const fixed = 4 - octets.length;
  for (let k = 0; k < fixed; k++) addrBytes[k] = myAddr[k] ?? 0;
  for (let k = 0; k < octets.length; k++) {
    const octet = octets[k];
    if (octet !== undefined) addrBytes[fixed + k] = octet;
  }

  fillSockaddr(hostaddr, addrBytes, port);
  return 0;
}

//=============================================================================

function UDP_Connect(_socket: number, _addr: QsockaddrT): number {
  return 0;
}

//=============================================================================

function UDP_CheckNewConnections(): number {
  if (net_acceptsocket === -1) return -1;

  const l = lib();
  if (!l) return -1;

  availableBuf[0] = 0;
  availableBuf[1] = 0;
  if (l.ioctl(net_acceptsocket, FIONREAD, ptr(availableBuf)) === -1)
    Sys_Error("UDP: ioctlsocket (FIONREAD) failed\n");
  if (availableBuf[0]) return net_acceptsocket;
  return -1;
}

//=============================================================================

function UDP_Read(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number {
  const l = lib();
  if (!l) return -1;

  const n = len < buf.length ? len : buf.length; // see header
  socklenBuf[0] = SOCKADDR_SIZE;
  readSockaddr.fill(0);
  const ret = l.recvfrom(socket, ptr(buf), n, 0, ptr(readSockaddr), ptr(socklenBuf));
  if (ret === -1) {
    if (nqReadErrnoIsSilent(target, l.errno())) return 0;
    return -1;
  }

  nativeToQsockaddr(readSockaddr, addr);
  return ret;
}

//=============================================================================

function UDP_MakeSocketBroadcastCapable(socket: number): number {
  const l = lib();
  if (!l) return -1;

  optvalBuf[0] = 1;
  // make this socket broadcast capable
  if (l.setsockopt(socket, SOL_SOCKET, SO_BROADCAST, ptr(optvalBuf), 4) < 0) return -1;
  net_broadcastsocket = socket;

  return 0;
}

//=============================================================================

function UDP_Broadcast(socket: number, buf: Uint8Array, len: number): number {
  if (socket !== net_broadcastsocket) {
    if (net_broadcastsocket !== 0) Sys_Error("Attempted to use multiple broadcasts sockets\n");
    const ret = UDP_MakeSocketBroadcastCapable(socket);
    if (ret === -1) {
      Con_Printf("Unable to make socket broadcast capable\n");
      return ret;
    }
  }

  return UDP_Write(socket, buf, len, broadcastaddr);
}

//=============================================================================

function UDP_Write(socket: number, buf: Uint8Array, len: number, addr: QsockaddrT): number {
  const l = lib();
  if (!l) return -1;

  const n = len < buf.length ? len : buf.length; // see header
  qsockaddrToNative(addr, writeSockaddr);
  const ret = l.sendto(socket, ptr(buf), n, 0, ptr(writeSockaddr), SOCKADDR_SIZE);
  if (ret === -1 && nqWriteErrnoIsSilent(target, l.errno())) return 0;
  return ret;
}

//=============================================================================

function UDP_AddrToString(addr: QsockaddrT): string {
  const port = (addr.sa_data[0] << 8) | addr.sa_data[1];
  return `${addr.sa_data[2]}.${addr.sa_data[3]}.${addr.sa_data[4]}.${addr.sa_data[5]}:${port}`;
}

//=============================================================================

function UDP_StringToAddr(s: string, addr: QsockaddrT): number {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+):(\d+)/.exec(s);
  const ha1 = m ? Number(m[1]) & 0xff : 0;
  const ha2 = m ? Number(m[2]) & 0xff : 0;
  const ha3 = m ? Number(m[3]) & 0xff : 0;
  const ha4 = m ? Number(m[4]) & 0xff : 0;
  const hp = m ? Number(m[5]) : 0;

  fillSockaddr(addr, new Uint8Array([ha1, ha2, ha3, ha4]), hp);
  return 0;
}

//=============================================================================

function UDP_GetSocketAddr(socket: number, addr: QsockaddrT): number {
  addr.sa_family = 0;
  addr.sa_data.fill(0); // Q_memset (addr, 0, sizeof(struct qsockaddr))

  const l = lib();
  if (!l) return 0;

  getnameSockaddr.fill(0);
  socklenBuf[0] = SOCKADDR_SIZE;
  l.getsockname(socket, ptr(getnameSockaddr), ptr(socklenBuf));
  nativeToQsockaddr(getnameSockaddr, addr);

  const a0 = addr.sa_data[2];
  const a1 = addr.sa_data[3];
  const a2 = addr.sa_data[4];
  const a3 = addr.sa_data[5];
  const isAny = a0 === 0 && a1 === 0 && a2 === 0 && a3 === 0;
  const isLoopback = a0 === 127 && a1 === 0 && a2 === 0 && a3 === 1; // inet_addr("127.0.0.1")
  if (isAny || isLoopback) {
    addr.sa_data[2] = myAddr[0] ?? 0;
    addr.sa_data[3] = myAddr[1] ?? 0;
    addr.sa_data[4] = myAddr[2] ?? 0;
    addr.sa_data[5] = myAddr[3] ?? 0;
  }

  return 0;
}

//=============================================================================

function UDP_GetNameFromAddr(addr: QsockaddrT): string {
  return UDP_AddrToString(addr); // no gethostbyaddr reverse lookup -- see header
}

//=============================================================================

function UDP_GetAddrFromName(name: string, addr: QsockaddrT): number {
  if (name.length > 0 && name.charAt(0) >= "0" && name.charAt(0) <= "9") return PartialIPAddress(name, addr);

  // see header: no blocking gethostbyname; "localhost" is resolved locally
  if (name === "localhost") {
    fillSockaddr(addr, new Uint8Array([127, 0, 0, 1]), net_hostport);
    return 0;
  }

  return -1;
}

//=============================================================================

function UDP_AddrCompare(addr1: QsockaddrT, addr2: QsockaddrT): number {
  if (addr1.sa_family !== addr2.sa_family) return -1;

  for (let i = 2; i <= 5; i++) if (addr1.sa_data[i] !== addr2.sa_data[i]) return -1;

  if (addr1.sa_data[0] !== addr2.sa_data[0] || addr1.sa_data[1] !== addr2.sa_data[1]) return 1;

  return 0;
}

//=============================================================================

function UDP_GetSocketPort(addr: QsockaddrT): number {
  return (addr.sa_data[0] << 8) | addr.sa_data[1];
}

function UDP_SetSocketPort(addr: QsockaddrT, port: number): number {
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  return 0;
}

//=============================================================================
// net_bsd.c:66-92's net_landrivers[] initializer, one entry.

export const udpLandriver: NetLandriverT = {
  name: "UDP",
  initialized: false,
  controlSock: 0,
  Init: UDP_Init,
  Shutdown: UDP_Shutdown,
  Listen: UDP_Listen,
  OpenSocket: UDP_OpenSocket,
  CloseSocket: UDP_CloseSocket,
  Connect: UDP_Connect,
  CheckNewConnections: UDP_CheckNewConnections,
  Read: UDP_Read,
  Write: UDP_Write,
  Broadcast: UDP_Broadcast,
  AddrToString: UDP_AddrToString,
  StringToAddr: UDP_StringToAddr,
  GetSocketAddr: UDP_GetSocketAddr,
  GetNameFromAddr: UDP_GetNameFromAddr,
  GetAddrFromName: UDP_GetAddrFromName,
  AddrCompare: UDP_AddrCompare,
  GetSocketPort: UDP_GetSocketPort,
  SetSocketPort: UDP_SetSocketPort,
};
