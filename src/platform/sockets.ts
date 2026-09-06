/*
Copyright (C) 1996-1997 Id Software, Inc.

Not a WinQuake/QW source file: it is the per-OS half of net_udp.c that the C
gets from its headers and its linker. WinQuake ships three copies of the same
LAN driver -- net_udp.c (BSD sockets, `errno`, `close`, `ioctl`), net_wins.c
(Winsock, `WSAGetLastError`, `closesocket`, `ioctlsocket`, LoadLibrary'd entry
points) and net_bsd.c's driver table -- and QW ships two, QW/client/net_udp.c
and QW/client/net_wins.c. PORTING.md's platform mapping folds those onto one
LAN driver per tree (src/platform/net_udp.ts, src/qw/net_udp.ts), both written
from the unix files. This module supplies what those two cannot share with
each other and cannot get from libc directly on a non-Linux host:

  - which library the socket calls live in (libc.so.6 / libSystem.B.dylib /
    ws2_32.dll), through libs.ts;
  - the entry-point names, which differ on Windows (`closesocket` not `close`,
    `ioctlsocket` not `ioctl`) and where the socket handle is a pointer-sized
    HANDLE rather than an int fd;
  - `errno`, which is `*__errno_location()` on glibc, `*__error()` on macOS
    and `WSAGetLastError()` on Windows;
  - `struct sockaddr_in`'s first two bytes, which are a 16-bit `sin_family` on
    Linux and Windows but a `sin_len` byte followed by a `sin_family` byte on
    the BSD-derived macOS;
  - the numeric constants (FIONBIO/FIONREAD, SOL_SOCKET/SO_BROADCAST) and the
    errno values, none of which agree across the three;
  - the errno classifications the C spells out per platform: net_udp.c's
    `if (errno == EWOULDBLOCK || errno == ECONNREFUSED) return 0;` in UDP_Read
    is net_wins.c:405-407's `if (errno == WSAEWOULDBLOCK || errno ==
    WSAECONNREFUSED) return 0;`, and QW/client/net_udp.c's NET_GetPacket
    branches are QW/client/net_wins.c:175-190's.

Everything above the FFI boundary (`SocketApi`) is a pure function of the
target OS, so the whole table can be unit-tested from Linux for all three.

Deviations from the C, all in the Windows branch (this port has no Windows
host to test on -- see docs/PLATFORMS.md):
- net_wins.c calls WSAStartup(MAKEWORD(1,1)); this asks for 2.2. Winsock 1.1
  is a compatibility mode on every Windows this port can run on at all, and
  the datagram calls used here behave identically under both.
- QW/client/net_wins.c's NET_GetPacket ends an unrecognised error in
  `Sys_Error ("NET_GetPacket: %s", strerror(errno))` -- fatal, and printing a
  C errno string for a Winsock error code, which is meaningless. This port
  keeps QW/client/net_udp.c's unix behaviour on every OS (Sys_Printf, then
  return false) and reports Winsock codes numerically.
- WSAECONNRESET is added to the "silent" set. It is the Winsock spelling of
  the condition the unix files spell ECONNREFUSED: an ICMP port-unreachable
  for an earlier datagram, surfaced on the next recvfrom. net_wins.c predates
  Windows reporting it that way, so the C has no branch for it; without one, a
  QuakeWorld client whose server went away would take the "unrecognised error"
  path on every frame.
- net_wins.c's WSAEMSGSIZE branch in QW's NET_GetPacket (an oversize datagram
  is truncated and reported, not returned) is ported as its own disposition;
  the unix files have no such branch because unix recvfrom truncates silently.
*/

import { read, type Pointer } from "bun:ffi";
import { currentLibrarySearch, openLibrary } from "./libs";

// process.platform's values this port distinguishes. Anything else (freebsd,
// openbsd, ...) takes the linux branch, which is what the pre-existing
// libc.so.6/libc.so candidate list already assumed.
export type SockTarget = "linux" | "win32" | "darwin";

export function sockTargetOf(platform: string): SockTarget {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

export function currentSockTarget(): SockTarget {
  return sockTargetOf(process.platform);
}

//=============================================================================
// <sys/socket.h>, <netinet/in.h>, <sys/ioctl.h>, <errno.h> / winsock2.h

export interface SockConstants {
  readonly AF_INET: number;
  readonly PF_INET: number;
  readonly SOCK_DGRAM: number;
  readonly IPPROTO_UDP: number;
  readonly SOL_SOCKET: number;
  readonly SO_BROADCAST: number;
  readonly FIONBIO: number;
  readonly FIONREAD: number;
  readonly EWOULDBLOCK: number;
  readonly ECONNREFUSED: number;
  readonly ECONNRESET: number;
  readonly EMSGSIZE: number;
  readonly EADDRNOTAVAIL: number;
}

// AF_INET/PF_INET/SOCK_DGRAM/IPPROTO_UDP are 2/2/2/17 on all three.
const linuxConstants: SockConstants = {
  AF_INET: 2,
  PF_INET: 2,
  SOCK_DGRAM: 2,
  IPPROTO_UDP: 17,
  SOL_SOCKET: 1,
  SO_BROADCAST: 6,
  FIONBIO: 0x5421,
  FIONREAD: 0x541b,
  EWOULDBLOCK: 11, // EAGAIN
  ECONNREFUSED: 111,
  ECONNRESET: 104,
  EMSGSIZE: 90,
  EADDRNOTAVAIL: 99,
};

// BSD: SOL_SOCKET/SO_BROADCAST are the historic 0xffff/0x20, and the ioctls
// are the _IOW('f',126,int)/_IOR('f',127,int) encodings.
const darwinConstants: SockConstants = {
  AF_INET: 2,
  PF_INET: 2,
  SOCK_DGRAM: 2,
  IPPROTO_UDP: 17,
  SOL_SOCKET: 0xffff,
  SO_BROADCAST: 0x20,
  FIONBIO: 0x8004667e,
  FIONREAD: 0x4004667f,
  EWOULDBLOCK: 35, // EAGAIN
  ECONNREFUSED: 61,
  ECONNRESET: 54,
  EMSGSIZE: 40,
  EADDRNOTAVAIL: 47,
};

// Winsock inherited the BSD ioctl/sockopt encodings and offsets its error
// codes by WSABASEERR (10000).
const win32Constants: SockConstants = {
  AF_INET: 2,
  PF_INET: 2,
  SOCK_DGRAM: 2,
  IPPROTO_UDP: 17,
  SOL_SOCKET: 0xffff,
  SO_BROADCAST: 0x20,
  FIONBIO: 0x8004667e,
  FIONREAD: 0x4004667f,
  EWOULDBLOCK: 10035, // WSAEWOULDBLOCK
  ECONNREFUSED: 10061, // WSAECONNREFUSED
  ECONNRESET: 10054, // WSAECONNRESET
  EMSGSIZE: 10040, // WSAEMSGSIZE
  EADDRNOTAVAIL: 10049, // WSAEADDRNOTAVAIL
};

export function sockConstants(target: SockTarget): SockConstants {
  switch (target) {
    case "win32":
      return win32Constants;
    case "darwin":
      return darwinConstants;
    case "linux":
      return linuxConstants;
  }
}

// sizeof(struct qsockaddr) == sizeof(struct sockaddr_in) == 16 on all three.
export const SOCKADDR_SIZE = 16;

//=============================================================================
// struct sockaddr_in, byte by byte.
//
// Linux/Windows:  u16 sin_family (host order) | u16 sin_port (net order) |
//                 4 bytes sin_addr | 8 bytes sin_zero
// macOS (BSD):    u8 sin_len | u8 sin_family  | u16 sin_port (net order) |
//                 4 bytes sin_addr | 8 bytes sin_zero
//
// Only the first two bytes differ, so everything the engine stores in
// `qsockaddr.sa_data` (port at [0..1], address at [2..5]) is identical on all
// three and never needs a per-OS branch of its own.

export function writeSockaddrFamily(target: SockTarget, out: Uint8Array, family: number): void {
  if (target === "darwin") {
    out[0] = SOCKADDR_SIZE;
    out[1] = family & 0xff;
    return;
  }
  out[0] = family & 0xff;
  out[1] = (family >> 8) & 0xff;
}

export function readSockaddrFamily(target: SockTarget, src: Uint8Array): number {
  if (target === "darwin") return src[1] ?? 0;
  return (src[0] ?? 0) | ((src[1] ?? 0) << 8);
}

// The whole 16-byte struct: family, htons(port), sin_addr, zeroed sin_zero.
export function writeSockaddrIn(target: SockTarget, out: Uint8Array, family: number, port: number, ip: Uint8Array): void {
  out.fill(0);
  writeSockaddrFamily(target, out, family);
  out[2] = (port >> 8) & 0xff;
  out[3] = port & 0xff;
  out[4] = ip[0] ?? 0;
  out[5] = ip[1] ?? 0;
  out[6] = ip[2] ?? 0;
  out[7] = ip[3] ?? 0;
}

export interface DecodedSockaddrIn {
  readonly family: number;
  readonly port: number;
  readonly ip: Uint8Array;
}

export function readSockaddrIn(target: SockTarget, src: Uint8Array): DecodedSockaddrIn {
  return {
    family: readSockaddrFamily(target, src),
    port: ((src[2] ?? 0) << 8) | (src[3] ?? 0),
    ip: new Uint8Array([src[4] ?? 0, src[5] ?? 0, src[6] ?? 0, src[7] ?? 0]),
  };
}

//=============================================================================
// errno classification. One function per C branch, so each one can be read
// next to the C it comes from.

// net_udp.c's UDP_Read: `if (errno == EWOULDBLOCK || errno == ECONNREFUSED)
// return 0;` == net_wins.c:405-407's WSAEWOULDBLOCK/WSAECONNREFUSED pair.
export function nqReadErrnoIsSilent(target: SockTarget, e: number): boolean {
  const c = sockConstants(target);
  if (e === c.EWOULDBLOCK || e === c.ECONNREFUSED) return true;
  return target === "win32" && e === c.ECONNRESET; // see file header
}

// net_udp.c's UDP_Write / net_wins.c:458's WINS_Write: only EWOULDBLOCK.
export function nqWriteErrnoIsSilent(target: SockTarget, e: number): boolean {
  return e === sockConstants(target).EWOULDBLOCK;
}

// "silent"  -> return false with no output (the C's bare `return false;`)
// "oversize"-> Con_Printf's the oversize-packet warning, then false
//              (QW/client/net_wins.c's WSAEMSGSIZE branch; no unix equivalent)
// "report"  -> Sys_Printf's the error text, then false
export type PacketErrnoDisposition = "silent" | "oversize" | "report";

// QW/client/net_udp.c's NET_GetPacket, with net_wins.c's WSAEMSGSIZE branch
// folded in on Windows.
export function qwGetPacketDisposition(target: SockTarget, e: number): PacketErrnoDisposition {
  const c = sockConstants(target);
  if (e === c.EWOULDBLOCK || e === c.ECONNREFUSED) return "silent";
  if (target === "win32") {
    if (e === c.ECONNRESET) return "silent"; // see file header
    if (e === c.EMSGSIZE) return "oversize";
  }
  return "report";
}

// QW/client/net_udp.c's NET_SendPacket: EWOULDBLOCK and ECONNREFUSED are
// silent, everything else prints. net_wins.c downgrades WSAEADDRNOTAVAIL to a
// Con_DPrintf in the client build only; this port prints it like any other.
export function qwSendPacketDisposition(target: SockTarget, e: number): PacketErrnoDisposition {
  const c = sockConstants(target);
  if (e === c.EWOULDBLOCK || e === c.ECONNREFUSED) return "silent";
  if (target === "win32" && e === c.ECONNRESET) return "silent"; // see file header
  return "report";
}

//=============================================================================
// The FFI boundary.

// struct hostent's h_addr_list offset. x86-64 and arm64 agree on all three
// targets: char *h_name (0), char **h_aliases (8), h_addrtype (16),
// h_length (20 -- `short` on Windows, `int` elsewhere; both leave the next
// pointer at the same place after padding), char **h_addr_list (24).
export const HOSTENT_H_ADDR_LIST = 24;

export interface SocketApi {
  readonly target: SockTarget;
  readonly c: SockConstants;
  readonly libraryName: string;
  socket(domain: number, type: number, protocol: number): number;
  bind(s: number, addr: Pointer, addrlen: number): number;
  close(s: number): number;
  sendto(s: number, buf: Pointer, len: number, flags: number, addr: Pointer, addrlen: number): number;
  recvfrom(s: number, buf: Pointer, len: number, flags: number, addr: Pointer, addrlen: Pointer): number;
  getsockname(s: number, addr: Pointer, addrlen: Pointer): number;
  setsockopt(s: number, level: number, optname: number, optval: Pointer, optlen: number): number;
  ioctl(s: number, request: number, arg: Pointer): number;
  gethostname(name: Pointer, len: number): number;
  // bun:ffi hands back a bigint rather than its branded Pointer number when
  // an address does not fit a JS double; every reader here (bun:ffi's own
  // `read.*`) accepts either.
  gethostbyname(name: Pointer): Pointer | bigint | null;
  errno(): number;
  strerror(e: number): string;
}

const posixSymbols = {
  socket: { args: ["i32", "i32", "i32"], returns: "i32" },
  bind: { args: ["i32", "ptr", "u32"], returns: "i32" },
  close: { args: ["i32"], returns: "i32" },
  sendto: { args: ["i32", "ptr", "u64", "i32", "ptr", "u32"], returns: "i32" },
  recvfrom: { args: ["i32", "ptr", "u64", "i32", "ptr", "ptr"], returns: "i32" },
  getsockname: { args: ["i32", "ptr", "ptr"], returns: "i32" },
  setsockopt: { args: ["i32", "i32", "i32", "ptr", "u32"], returns: "i32" },
  ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
  gethostname: { args: ["ptr", "u64"], returns: "i32" },
  gethostbyname: { args: ["ptr"], returns: "ptr" },
  strerror: { args: ["i32"], returns: "cstring" },
} as const;

const linuxSymbols = { ...posixSymbols, __errno_location: { args: [], returns: "ptr" } } as const;
const darwinSymbols = { ...posixSymbols, __error: { args: [], returns: "ptr" } } as const;

// SOCKET is UINT_PTR, so 64 bits wide on x64; INVALID_SOCKET is (SOCKET)(~0),
// which read back as a signed 64-bit value is -1 -- the same sentinel the C's
// `== -1` comparisons already use, and the same one the int-fd unix branch
// produces. `long` is 32 bits on Windows, so ioctlsocket's cmd is u32 there
// and u64 (unsigned long) on the unix branch.
const win32Symbols = {
  WSAStartup: { args: ["u16", "ptr"], returns: "i32" },
  WSACleanup: { args: [], returns: "i32" },
  WSAGetLastError: { args: [], returns: "i32" },
  socket: { args: ["i32", "i32", "i32"], returns: "i64" },
  bind: { args: ["i64", "ptr", "i32"], returns: "i32" },
  closesocket: { args: ["i64"], returns: "i32" },
  sendto: { args: ["i64", "ptr", "i32", "i32", "ptr", "i32"], returns: "i32" },
  recvfrom: { args: ["i64", "ptr", "i32", "i32", "ptr", "ptr"], returns: "i32" },
  getsockname: { args: ["i64", "ptr", "ptr"], returns: "i32" },
  setsockopt: { args: ["i64", "i32", "i32", "ptr", "i32"], returns: "i32" },
  ioctlsocket: { args: ["i64", "u32", "ptr"], returns: "i32" },
  gethostname: { args: ["ptr", "i32"], returns: "i32" },
  gethostbyname: { args: ["ptr"], returns: "ptr" },
} as const;

// MAKEWORD(2, 2) -- see the file header's deviation note.
const WINSOCK_VERSION = 0x0202;
// sizeof(WSADATA) is 408 on x64 (two WORDs, two u_shorts, a pointer, then
// szDescription[257] and szSystemStatus[129]); over-allocated, and only ever
// written by WSAStartup.
const WSADATA_SIZE = 1024;

// The C's `errno` is not readable through bun:ffi as a variable, only through
// the per-libc accessor function each platform provides.
function readErrnoThrough(location: Pointer | bigint | null): number {
  if (location === null) return 0;
  return read.i32(location, 0);
}

let api: SocketApi | null = null;
let apiTried = false;
let apiFailure = "";

// Description of the failed search, for the caller that wants to print it.
export function socketApiFailure(): string {
  return apiFailure;
}

/*
Opens the OS's socket library and adapts it to one interface. Returns null
(once, then remembers) when it cannot be opened; both net_udp modules treat
that the way the C treats `-noudp`.
*/
export function openSocketApi(): SocketApi | null {
  if (apiTried) return api;
  apiTried = true;

  const target = currentSockTarget();
  const c = sockConstants(target);
  const search = currentLibrarySearch("sockets");

  if (target === "win32") {
    const opened = openLibrary(search, win32Symbols);
    if (!opened.ok) {
      apiFailure = opened.message;
      return null;
    }
    const s = opened.lib.symbols;

    // net_wins.c:170's `r = pWSAStartup (MAKEWORD(1,1), &winsockdata); if (r)
    // ... return -1;` -- Winsock refuses every other call until this succeeds.
    const wsadata = new Uint8Array(WSADATA_SIZE);
    const started = s.WSAStartup(WINSOCK_VERSION, wsadata);
    if (started !== 0) {
      apiFailure = `WSAStartup failed with error ${started}`;
      opened.lib.close();
      return null;
    }

    api = {
      target,
      c,
      libraryName: opened.name,
      socket: (domain, type, protocol) => Number(s.socket(domain, type, protocol)),
      bind: (sock, addr, addrlen) => s.bind(BigInt(sock), addr, addrlen),
      close: (sock) => s.closesocket(BigInt(sock)),
      sendto: (sock, buf, len, flags, addr, addrlen) => s.sendto(BigInt(sock), buf, len, flags, addr, addrlen),
      recvfrom: (sock, buf, len, flags, addr, addrlen) => s.recvfrom(BigInt(sock), buf, len, flags, addr, addrlen),
      getsockname: (sock, addr, addrlen) => s.getsockname(BigInt(sock), addr, addrlen),
      setsockopt: (sock, level, optname, optval, optlen) => s.setsockopt(BigInt(sock), level, optname, optval, optlen),
      ioctl: (sock, request, arg) => s.ioctlsocket(BigInt(sock), request, arg),
      gethostname: (name, len) => s.gethostname(name, len),
      gethostbyname: (name) => s.gethostbyname(name),
      errno: () => s.WSAGetLastError(),
      // ws2_32.dll has no strerror, and the C runtime's would decode a WSA
      // code as an unrelated errno -- see the file header.
      strerror: (e) => `Winsock error ${e}`,
    };
    return api;
  }

  if (target === "darwin") {
    const opened = openLibrary(search, darwinSymbols);
    if (!opened.ok) {
      apiFailure = opened.message;
      return null;
    }
    const s = opened.lib.symbols;
    api = {
      target,
      c,
      libraryName: opened.name,
      socket: (domain, type, protocol) => s.socket(domain, type, protocol),
      bind: (sock, addr, addrlen) => s.bind(sock, addr, addrlen),
      close: (sock) => s.close(sock),
      sendto: (sock, buf, len, flags, addr, addrlen) => s.sendto(sock, buf, len, flags, addr, addrlen),
      recvfrom: (sock, buf, len, flags, addr, addrlen) => s.recvfrom(sock, buf, len, flags, addr, addrlen),
      getsockname: (sock, addr, addrlen) => s.getsockname(sock, addr, addrlen),
      setsockopt: (sock, level, optname, optval, optlen) => s.setsockopt(sock, level, optname, optval, optlen),
      ioctl: (sock, request, arg) => s.ioctl(sock, request, arg),
      gethostname: (name, len) => s.gethostname(name, len),
      gethostbyname: (name) => s.gethostbyname(name),
      errno: () => readErrnoThrough(s.__error()),
      strerror: (e) => s.strerror(e) ?? "",
    };
    return api;
  }

  const opened = openLibrary(search, linuxSymbols);
  if (!opened.ok) {
    apiFailure = opened.message;
    return null;
  }
  const s = opened.lib.symbols;
  api = {
    target,
    c,
    libraryName: opened.name,
    socket: (domain, type, protocol) => s.socket(domain, type, protocol),
    bind: (sock, addr, addrlen) => s.bind(sock, addr, addrlen),
    close: (sock) => s.close(sock),
    sendto: (sock, buf, len, flags, addr, addrlen) => s.sendto(sock, buf, len, flags, addr, addrlen),
    recvfrom: (sock, buf, len, flags, addr, addrlen) => s.recvfrom(sock, buf, len, flags, addr, addrlen),
    getsockname: (sock, addr, addrlen) => s.getsockname(sock, addr, addrlen),
    setsockopt: (sock, level, optname, optval, optlen) => s.setsockopt(sock, level, optname, optval, optlen),
    ioctl: (sock, request, arg) => s.ioctl(sock, request, arg),
    gethostname: (name, len) => s.gethostname(name, len),
    gethostbyname: (name) => s.gethostbyname(name),
    errno: () => readErrnoThrough(s.__errno_location()),
    strerror: (e) => s.strerror(e) ?? "",
  };
  return api;
}
