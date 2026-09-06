/*
Self-sufficient test for src/platform/sockets.ts -- the per-OS half of
net_udp.c that src/platform/net_udp.ts (NetQuake) and src/qw/net_udp.ts
(QuakeWorld) both sit on.

Every function under test takes its `SockTarget` as an argument rather than
reading `process.platform`, so this Linux run pins the Windows and macOS
tables too. That is the whole point: the port has no Windows or macOS host,
so the struct layouts, the constants and the errno classifications are what
can be verified from here, and the live syscalls are not (see
docs/PLATFORMS.md).

The C references for each classification are named in each test.
*/

import { describe, expect, test } from "bun:test";
import {
  SOCKADDR_SIZE,
  nqReadErrnoIsSilent,
  nqWriteErrnoIsSilent,
  qwGetPacketDisposition,
  qwSendPacketDisposition,
  readSockaddrFamily,
  readSockaddrIn,
  sockConstants,
  sockTargetOf,
  writeSockaddrFamily,
  writeSockaddrIn,
  type SockTarget,
} from "../src/platform/sockets";

const targets: SockTarget[] = ["linux", "win32", "darwin"];

describe("sockTargetOf", () => {
  test("maps process.platform's three interesting values", () => {
    expect(sockTargetOf("linux")).toBe("linux");
    expect(sockTargetOf("win32")).toBe("win32");
    expect(sockTargetOf("darwin")).toBe("darwin");
  });

  test("every other platform takes the Linux branch, as the pre-existing libc.so.6 code already assumed", () => {
    expect(sockTargetOf("freebsd")).toBe("linux");
    expect(sockTargetOf("openbsd")).toBe("linux");
  });
});

describe("sockConstants", () => {
  test("the address-family constants agree on all three, which is why nothing branches on them", () => {
    for (const target of targets) {
      const c = sockConstants(target);
      expect(c.AF_INET).toBe(2);
      expect(c.PF_INET).toBe(2);
      expect(c.SOCK_DGRAM).toBe(2);
      expect(c.IPPROTO_UDP).toBe(17);
    }
  });

  test("Linux: the glibc/asm-generic values net_udp.ts used before this module existed", () => {
    const c = sockConstants("linux");
    expect(c.SOL_SOCKET).toBe(1);
    expect(c.SO_BROADCAST).toBe(6);
    expect(c.FIONBIO).toBe(0x5421);
    expect(c.FIONREAD).toBe(0x541b);
    expect(c.EWOULDBLOCK).toBe(11); // EAGAIN
    expect(c.ECONNREFUSED).toBe(111);
  });

  test("macOS: the BSD ioctl encodings and the historic 0xffff/0x20 socket options", () => {
    const c = sockConstants("darwin");
    expect(c.SOL_SOCKET).toBe(0xffff);
    expect(c.SO_BROADCAST).toBe(0x20);
    expect(c.FIONBIO).toBe(0x8004667e);
    expect(c.FIONREAD).toBe(0x4004667f);
    expect(c.EWOULDBLOCK).toBe(35);
    expect(c.ECONNREFUSED).toBe(61);
    expect(c.ECONNRESET).toBe(54);
  });

  test("Windows: the BSD encodings Winsock inherited, and errors offset by WSABASEERR", () => {
    const c = sockConstants("win32");
    expect(c.SOL_SOCKET).toBe(0xffff);
    expect(c.SO_BROADCAST).toBe(0x20);
    expect(c.FIONBIO).toBe(0x8004667e);
    expect(c.FIONREAD).toBe(0x4004667f);
    expect(c.EWOULDBLOCK).toBe(10035); // WSAEWOULDBLOCK
    expect(c.ECONNREFUSED).toBe(10061); // WSAECONNREFUSED
    expect(c.ECONNRESET).toBe(10054); // WSAECONNRESET
    expect(c.EMSGSIZE).toBe(10040); // WSAEMSGSIZE
    expect(c.EADDRNOTAVAIL).toBe(10049); // WSAEADDRNOTAVAIL
  });

  test("Windows and macOS share every constant except the errno values", () => {
    const w = sockConstants("win32");
    const d = sockConstants("darwin");
    expect(w.SOL_SOCKET).toBe(d.SOL_SOCKET);
    expect(w.SO_BROADCAST).toBe(d.SO_BROADCAST);
    expect(w.FIONBIO).toBe(d.FIONBIO);
    expect(w.FIONREAD).toBe(d.FIONREAD);
    expect(w.EWOULDBLOCK).not.toBe(d.EWOULDBLOCK);
  });
});

describe("struct sockaddr_in -- the family field", () => {
  test("Linux and Windows write a 16-bit little-endian sin_family", () => {
    for (const target of ["linux", "win32"] as const) {
      const buf = new Uint8Array(SOCKADDR_SIZE);
      writeSockaddrFamily(target, buf, 2);
      expect(buf[0]).toBe(2);
      expect(buf[1]).toBe(0);
    }
  });

  test("macOS writes the BSD sin_len byte first, then a one-byte sin_family", () => {
    const buf = new Uint8Array(SOCKADDR_SIZE);
    writeSockaddrFamily("darwin", buf, 2);
    expect(buf[0]).toBe(16); // sin_len == sizeof(struct sockaddr_in)
    expect(buf[1]).toBe(2); // sin_family
  });

  test("each platform reads back what it wrote, and the two layouts disagree on the same bytes", () => {
    for (const target of targets) {
      const buf = new Uint8Array(SOCKADDR_SIZE);
      writeSockaddrFamily(target, buf, 2);
      expect(readSockaddrFamily(target, buf)).toBe(2);
    }

    // A macOS sockaddr read with the Linux rule is 0x0210, not 2 -- the bug
    // this layout split exists to prevent.
    const bsd = new Uint8Array(SOCKADDR_SIZE);
    writeSockaddrFamily("darwin", bsd, 2);
    expect(readSockaddrFamily("linux", bsd)).toBe(0x0210);
  });
});

describe("struct sockaddr_in -- the whole 16 bytes", () => {
  test("port is big-endian (htons) and the address is four bytes at offset 4 on every platform", () => {
    for (const target of targets) {
      const buf = new Uint8Array(SOCKADDR_SIZE);
      writeSockaddrIn(target, buf, 2, 26000, new Uint8Array([192, 246, 40, 70]));
      expect(buf[2]).toBe(26000 >> 8);
      expect(buf[3]).toBe(26000 & 0xff);
      expect(Array.from(buf.subarray(4, 8))).toEqual([192, 246, 40, 70]);
      // sin_zero
      expect(Array.from(buf.subarray(8, 16))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
  });

  test("round-trips through readSockaddrIn on every platform", () => {
    for (const target of targets) {
      const buf = new Uint8Array(SOCKADDR_SIZE);
      writeSockaddrIn(target, buf, 2, 27500, new Uint8Array([127, 0, 0, 1]));
      const decoded = readSockaddrIn(target, buf);
      expect(decoded.family).toBe(2);
      expect(decoded.port).toBe(27500);
      expect(Array.from(decoded.ip)).toEqual([127, 0, 0, 1]);
    }
  });

  test("a previously used buffer is fully cleared, so no stale address leaks into the next send", () => {
    const buf = new Uint8Array(SOCKADDR_SIZE).fill(0xee);
    writeSockaddrIn("linux", buf, 2, 0, new Uint8Array(4));
    expect(Array.from(buf)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("the port's low byte survives a value above 255, matching htons of an unsigned short", () => {
    const buf = new Uint8Array(SOCKADDR_SIZE);
    writeSockaddrIn("linux", buf, 2, 0xabcd, new Uint8Array(4));
    expect(buf[2]).toBe(0xab);
    expect(buf[3]).toBe(0xcd);
    expect(readSockaddrIn("linux", buf).port).toBe(0xabcd);
  });
});

describe("UDP_Read's errno classification (net_udp.c's UDP_Read == net_wins.c:405-407's WINS_Read)", () => {
  test("EWOULDBLOCK and ECONNREFUSED are the silent pair on every platform", () => {
    for (const target of targets) {
      const c = sockConstants(target);
      expect(nqReadErrnoIsSilent(target, c.EWOULDBLOCK)).toBe(true);
      expect(nqReadErrnoIsSilent(target, c.ECONNREFUSED)).toBe(true);
    }
  });

  test("anything else is a read error", () => {
    for (const target of targets) {
      expect(nqReadErrnoIsSilent(target, sockConstants(target).EADDRNOTAVAIL)).toBe(false);
      expect(nqReadErrnoIsSilent(target, 0)).toBe(false);
    }
  });

  test("Windows also treats WSAECONNRESET as silent -- the Winsock spelling of the ICMP port-unreachable the unix files call ECONNREFUSED", () => {
    expect(nqReadErrnoIsSilent("win32", 10054)).toBe(true);
    // Not on the unix targets: there the same condition already arrives as
    // ECONNREFUSED, and a real ECONNRESET on a datagram socket does not occur.
    expect(nqReadErrnoIsSilent("linux", sockConstants("linux").ECONNRESET)).toBe(false);
    expect(nqReadErrnoIsSilent("darwin", sockConstants("darwin").ECONNRESET)).toBe(false);
  });

  test("the platforms' numbers do not collide: a Linux EWOULDBLOCK is not silent under the Windows table", () => {
    expect(nqReadErrnoIsSilent("win32", 11)).toBe(false);
    expect(nqReadErrnoIsSilent("linux", 10035)).toBe(false);
  });
});

describe("UDP_Write's errno classification (net_udp.c's UDP_Write == net_wins.c:458's WINS_Write)", () => {
  test("only EWOULDBLOCK is silent -- ECONNREFUSED is not, unlike the read path", () => {
    for (const target of targets) {
      const c = sockConstants(target);
      expect(nqWriteErrnoIsSilent(target, c.EWOULDBLOCK)).toBe(true);
      expect(nqWriteErrnoIsSilent(target, c.ECONNREFUSED)).toBe(false);
    }
  });
});

describe("QW NET_GetPacket's errno classification (QW/client/net_udp.c, with net_wins.c's WSAEMSGSIZE branch)", () => {
  test("EWOULDBLOCK and ECONNREFUSED return false with no output", () => {
    for (const target of targets) {
      const c = sockConstants(target);
      expect(qwGetPacketDisposition(target, c.EWOULDBLOCK)).toBe("silent");
      expect(qwGetPacketDisposition(target, c.ECONNREFUSED)).toBe("silent");
    }
  });

  test("Windows adds WSAEMSGSIZE's oversize-packet warning and treats WSAECONNRESET as silent", () => {
    expect(qwGetPacketDisposition("win32", 10040)).toBe("oversize");
    expect(qwGetPacketDisposition("win32", 10054)).toBe("silent");
  });

  test("the unix targets have no oversize branch -- unix recvfrom truncates silently", () => {
    expect(qwGetPacketDisposition("linux", sockConstants("linux").EMSGSIZE)).toBe("report");
    expect(qwGetPacketDisposition("darwin", sockConstants("darwin").EMSGSIZE)).toBe("report");
  });

  test("everything else prints; nothing is fatal, unlike net_wins.c's Sys_Error", () => {
    for (const target of targets) {
      expect(qwGetPacketDisposition(target, sockConstants(target).EADDRNOTAVAIL)).toBe("report");
    }
  });
});

describe("QW NET_SendPacket's errno classification (QW/client/net_udp.c)", () => {
  test("EWOULDBLOCK and ECONNREFUSED are silent, everything else prints", () => {
    for (const target of targets) {
      const c = sockConstants(target);
      expect(qwSendPacketDisposition(target, c.EWOULDBLOCK)).toBe("silent");
      expect(qwSendPacketDisposition(target, c.ECONNREFUSED)).toBe("silent");
      expect(qwSendPacketDisposition(target, c.EADDRNOTAVAIL)).toBe("report");
    }
  });

  test("an oversize datagram is a receive-side condition only: the send path never reports one", () => {
    for (const target of targets) {
      expect(qwSendPacketDisposition(target, sockConstants(target).EMSGSIZE)).not.toBe("oversize");
    }
  });
});
