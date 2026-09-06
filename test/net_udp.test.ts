/*
Self-sufficient test for src/platform/net_udp.ts (WinQuake net_udp.h/net_udp.c).

Drives real libc BSD sockets (socket/bind/sendto/recvfrom through bun:ffi)
over loopback on ports 26200-26206 -- no mocking of the transport.

The load-bearing case is "a datagram written on one socket is readable on
another with no turn of the event loop in between": net_dgrm.c's
_Datagram_Connect and Datagram_CheckNewConnections both poll `dfunc.Read`
from inside a synchronous loop, so a transport that can only deliver through
an event-loop callback makes every real client connect time out
(.orch/e2e/D.md, Defect A). Every read below is therefore driven either
straight-line or through a `Bun.sleepSync` spin, never an `await`.

Rule 15: net_main.ts's `net_hostport`, `my_tcpip_address` and
`tcpipAvailable` are process-wide singletons UDP_Init writes; all three are
captured here and restored in afterAll, as is the `hostname` cvar's string.
*/

import { describe, expect, test, afterAll } from "bun:test";
import { udpLandriver, PartialIPAddress, udpState, type QsockaddrT } from "../src/platform/net_udp";
import {
  hostname,
  my_tcpip_address,
  net_hostport,
  setMyTcpipAddress,
  setNetHostport,
  setTcpipAvailable,
  tcpipAvailable,
} from "../src/common/net_main";
import { Cvar_RegisterVariable } from "../src/common/cvar";

function newAddr(): QsockaddrT {
  return { sa_family: 0, sa_data: new Uint8Array(14) };
}

function loopbackAddr(port: number): QsockaddrT {
  const addr = newAddr();
  addr.sa_family = 2; // AF_INET
  addr.sa_data[0] = (port >> 8) & 0xff;
  addr.sa_data[1] = port & 0xff;
  addr.sa_data[2] = 127;
  addr.sa_data[3] = 0;
  addr.sa_data[4] = 0;
  addr.sa_data[5] = 1;
  return addr;
}

// Reads without ever yielding to the event loop -- see file header.
function readSpinning(socket: number, buf: Uint8Array, addr: QsockaddrT): number {
  let ret = udpLandriver.Read(socket, buf, buf.length, addr);
  for (let i = 0; ret === 0 && i < 200; i++) {
    Bun.sleepSync(1);
    ret = udpLandriver.Read(socket, buf, buf.length, addr);
  }
  return ret;
}

const PORT_A = 26200;
const PORT_B = 26201;
const PORT_BROADCAST = 26205;

const savedNetHostport = net_hostport;
const savedMyTcpipAddress = my_tcpip_address;
const savedTcpipAvailable = tcpipAvailable;
// UDP_Init's "if the quake hostname isn't set, set it to the machine name".
Cvar_RegisterVariable(hostname); // no-op if net_main.ts's NET_Init already did it
const savedHostname = hostname.string;

const socketA = udpLandriver.OpenSocket(PORT_A);
const socketB = udpLandriver.OpenSocket(PORT_B);

afterAll(() => {
  udpLandriver.CloseSocket(socketA);
  udpLandriver.CloseSocket(socketB);
  setNetHostport(savedNetHostport);
  setMyTcpipAddress(savedMyTcpipAddress);
  setTcpipAvailable(savedTcpipAvailable);
  hostname.string = savedHostname;
});

describe("UDP_OpenSocket", () => {
  test("both sockets are real file descriptors, bound and non-blocking", () => {
    expect(socketA).toBeGreaterThan(0);
    expect(socketB).toBeGreaterThan(0);
    expect(socketA).not.toBe(socketB);
  });

  test("a port already in use returns -1, as bind() does in the C", () => {
    const duplicate = udpLandriver.OpenSocket(PORT_A);
    expect(duplicate).toBe(-1);
  });

  test("UDP_GetSocketAddr reports the port the socket bound", () => {
    const addr = newAddr();
    expect(udpLandriver.GetSocketAddr(socketA, addr)).toBe(0);
    expect(addr.sa_family).toBe(2);
    expect(udpLandriver.GetSocketPort(addr)).toBe(PORT_A);
  });
});

describe("real loopback Write/Read round trip", () => {
  test("A writes to B and B reads it without any event-loop turn", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]);
    const written = udpLandriver.Write(socketA, payload, payload.length, loopbackAddr(PORT_B));
    expect(written).toBe(payload.length);

    const recvBuf = new Uint8Array(64);
    const fromAddr = newAddr();
    const received = readSpinning(socketB, recvBuf, fromAddr);

    expect(received).toBe(payload.length);
    expect(Array.from(recvBuf.subarray(0, received))).toEqual(Array.from(payload));

    // recvfrom's source address, as the C reads it back out of the same
    // struct qsockaddr it passed in.
    expect(fromAddr.sa_family).toBe(2);
    expect(udpLandriver.GetSocketPort(fromAddr)).toBe(PORT_A);
    expect(Array.from(fromAddr.sa_data.subarray(2, 6))).toEqual([127, 0, 0, 1]);
  });

  test("a reply on the address recvfrom reported gets back to the sender", () => {
    const request = new Uint8Array([1, 2, 3, 4]);
    udpLandriver.Write(socketA, request, request.length, loopbackAddr(PORT_B));

    const serverBuf = new Uint8Array(64);
    const clientAddr = newAddr();
    expect(readSpinning(socketB, serverBuf, clientAddr)).toBe(request.length);

    const reply = new Uint8Array([9, 9, 9]);
    expect(udpLandriver.Write(socketB, reply, reply.length, clientAddr)).toBe(reply.length);

    const clientBuf = new Uint8Array(64);
    const serverAddr = newAddr();
    expect(readSpinning(socketA, clientBuf, serverAddr)).toBe(reply.length);
    expect(Array.from(clientBuf.subarray(0, 3))).toEqual([9, 9, 9]);
    expect(udpLandriver.GetSocketPort(serverAddr)).toBe(PORT_B);
  });

  test("Read returns 0 when nothing is queued (the C's EWOULDBLOCK case)", () => {
    const buf = new Uint8Array(16);
    const addr = newAddr();
    expect(udpLandriver.Read(socketA, buf, buf.length, addr)).toBe(0);
    expect(udpLandriver.Read(socketB, buf, buf.length, addr)).toBe(0);
  });

  test("Read on a closed descriptor returns -1 (a real recvfrom error)", () => {
    const scratch = udpLandriver.OpenSocket(26202);
    expect(scratch).toBeGreaterThan(0);
    expect(udpLandriver.CloseSocket(scratch)).toBe(0);

    const buf = new Uint8Array(16);
    const addr = newAddr();
    expect(udpLandriver.Read(scratch, buf, buf.length, addr)).toBe(-1);
  });

  test("Write to a closed descriptor returns -1", () => {
    const scratch = udpLandriver.OpenSocket(26203);
    expect(udpLandriver.CloseSocket(scratch)).toBe(0);
    const buf = new Uint8Array([1]);
    expect(udpLandriver.Write(scratch, buf, 1, loopbackAddr(PORT_B))).toBe(-1);
  });
});

describe("UDP_Init / UDP_Broadcast", () => {
  // UDP_Init builds `broadcastaddr` from net_hostport, so the port has to be
  // set the way NET_Init would have set it from `-port` before Init runs.
  test("Init opens a control socket and publishes my_tcpip_address", () => {
    setNetHostport(PORT_BROADCAST);
    const control = udpLandriver.Init();
    try {
      expect(control).toBeGreaterThan(0);
      expect(udpState.tcpipAvailable).toBe(true);
      expect(udpState.my_tcpip_address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(udpState.net_hostport).toBe(PORT_BROADCAST);

      // UDP_MakeSocketBroadcastCapable's setsockopt(SO_BROADCAST) has to
      // succeed for this to be anything but -1; without it sendto() to
      // 255.255.255.255 fails with EACCES. Whether the datagram is then
      // delivered back to a socket on this same host is a routing property
      // of the box, not of this module, so only the send is asserted.
      const payload = new Uint8Array([0x80, 0x00, 0x00, 0x0c]);
      expect(udpLandriver.Broadcast(control, payload, payload.length)).toBe(payload.length);
    } finally {
      udpLandriver.Shutdown();
    }
  });
});

describe("AddrToString / StringToAddr / SetSocketPort / GetSocketPort round trip", () => {
  test("AddrToString formats %d.%d.%d.%d:%d", () => {
    const addr = newAddr();
    addr.sa_family = 2;
    addr.sa_data.set([0x65, 0x79, 192, 168, 1, 42]); // port 0x6579 = 25977
    expect(udpLandriver.AddrToString(addr)).toBe("192.168.1.42:25977");
  });

  test("StringToAddr parses the same format AddrToString produces", () => {
    const addr = newAddr();
    expect(udpLandriver.StringToAddr("10.20.30.40:5000", addr)).toBe(0);
    expect(udpLandriver.AddrToString(addr)).toBe("10.20.30.40:5000");
  });

  test("SetSocketPort / GetSocketPort round trip", () => {
    const addr = newAddr();
    expect(udpLandriver.SetSocketPort(addr, 26000)).toBe(0);
    expect(udpLandriver.GetSocketPort(addr)).toBe(26000);

    expect(udpLandriver.SetSocketPort(addr, 1)).toBe(0);
    expect(udpLandriver.GetSocketPort(addr)).toBe(1);
  });

  test("full AddrToString -> StringToAddr -> AddrToString round trip", () => {
    const original = "203.0.113.7:34567";
    const addr = newAddr();
    udpLandriver.StringToAddr(original, addr);
    expect(udpLandriver.AddrToString(addr)).toBe(original);
  });

  test("GetNameFromAddr returns the dotted string (no reverse lookup)", () => {
    const addr = newAddr();
    udpLandriver.StringToAddr("198.51.100.9:26000", addr);
    expect(udpLandriver.GetNameFromAddr(addr)).toBe("198.51.100.9:26000");
  });
});

describe("PartialIPAddress", () => {
  // "12.34" and "1.2.3.4:26001" both start with a digit, so they're
  // exercised through the public UDP_GetAddrFromName entry point (its
  // `name[0]` digit gate, ported straight from the C, routes them into
  // PartialIPAddress). ".56" starts with '.', which that same gate rejects
  // in the C as much as here -- net_udp.c's UDP_GetAddrFromName can never
  // reach PartialIPAddress with a leading-dot input even though
  // PartialIPAddress itself supports one, so that case is called directly.
  test('"1.2.3.4:26001" fully overrides the address and sets the given port', () => {
    const addr = newAddr();
    const ret = udpLandriver.GetAddrFromName("1.2.3.4:26001", addr);
    expect(ret).toBe(0);
    expect(Array.from(addr.sa_data.subarray(2, 6))).toEqual([1, 2, 3, 4]);
    expect(udpLandriver.GetSocketPort(addr)).toBe(26001);
  });

  test("a partial address keeps the leading octets of the local address", () => {
    const full = newAddr();
    udpLandriver.GetAddrFromName("1.2.3.4:26001", full); // any full address, to read myAddr back below
    const local = newAddr();
    expect(PartialIPAddress("9.9.9.9", local)).toBe(0);

    const partial = newAddr();
    expect(PartialIPAddress(".56", partial)).toBe(0);
    // ".56" replaces only the low octet; the high three come from myAddr,
    // whatever this machine's own address resolved to in UDP_Init.
    expect(partial.sa_data[5]).toBe(56);
    const twoOctets = newAddr();
    expect(PartialIPAddress("12.34", twoOctets)).toBe(0);
    expect(partial.sa_data[2]).toBe(twoOctets.sa_data[2]);
    expect(partial.sa_data[3]).toBe(twoOctets.sa_data[3]);
    expect(twoOctets.sa_data[4]).toBe(12);
    expect(twoOctets.sa_data[5]).toBe(34);
  });

  test("a partial address with no port uses net_hostport", () => {
    setNetHostport(26207);
    const addr = newAddr();
    expect(PartialIPAddress("1.2.3.4", addr)).toBe(0);
    expect(udpLandriver.GetSocketPort(addr)).toBe(26207);
  });

  test("more than four dotted groups returns -1", () => {
    const addr = newAddr();
    expect(PartialIPAddress("1.2.3.4.5", addr)).toBe(-1);
  });

  test('"localhost" resolves to 127.0.0.1 on net_hostport', () => {
    setNetHostport(26208);
    const addr = newAddr();
    expect(udpLandriver.GetAddrFromName("localhost", addr)).toBe(0);
    expect(Array.from(addr.sa_data.subarray(2, 6))).toEqual([127, 0, 0, 1]);
    expect(udpLandriver.GetSocketPort(addr)).toBe(26208);
  });

  test("any other name returns -1 (no blocking gethostbyname)", () => {
    const addr = newAddr();
    expect(udpLandriver.GetAddrFromName("some.hostname.example", addr)).toBe(-1);
  });
});

describe("AddrCompare", () => {
  test("identical address and port compare equal", () => {
    const a = newAddr();
    const b = newAddr();
    udpLandriver.StringToAddr("10.0.0.1:1000", a);
    udpLandriver.StringToAddr("10.0.0.1:1000", b);
    expect(udpLandriver.AddrCompare(a, b)).toBe(0);
  });

  test("same address, different port returns 1", () => {
    const a = newAddr();
    const b = newAddr();
    udpLandriver.StringToAddr("10.0.0.1:1000", a);
    udpLandriver.StringToAddr("10.0.0.1:2000", b);
    expect(udpLandriver.AddrCompare(a, b)).toBe(1);
  });

  test("different address returns -1", () => {
    const a = newAddr();
    const b = newAddr();
    udpLandriver.StringToAddr("10.0.0.1:1000", a);
    udpLandriver.StringToAddr("10.0.0.2:1000", b);
    expect(udpLandriver.AddrCompare(a, b)).toBe(-1);
  });

  test("different sa_family returns -1", () => {
    const a = newAddr();
    const b = newAddr();
    a.sa_family = 2;
    b.sa_family = 0;
    expect(udpLandriver.AddrCompare(a, b)).toBe(-1);
  });
});
