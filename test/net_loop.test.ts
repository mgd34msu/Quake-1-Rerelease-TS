/*
Self-sufficient test for src/common/net_loop.ts (WinQuake net_loop.c).

Drives `netLoopDriver`'s methods directly (Init/Listen/Connect/
CheckNewConnections/QGetMessage/QSendMessage/SendUnreliableMessage/
CanSendMessage/Close), not net_main.ts's NET_Connect/NET_GetMessage/
NET_SendMessage wrappers, per the unit brief.

net_loop.ts's Loop_Connect calls the real net_main.ts `NET_NewQSocket`,
which needs a non-empty `net_freeSockets` pool -- there is no exported way
to seed that pool other than calling the real `NET_Init()` (net_main.ts's
`net_freeSockets`/`net_activeSockets`/`net_numsockets` are exported `let`s;
an importing module can read them but, per ES module semantics, cannot
reassign another module's `let` binding). `NET_Init()` is called once below,
with a fake `NetHostHooks` sized generously (`svsMaxclientslimit` 32) so
this file's assertions hold regardless of how many sockets any other test
file sharing this same process's module registry has already drawn from the
pool (bun runs every test file in one process against one shared module
instance -- confirmed empirically: a plain module-level counter observed
from two different *.test.ts files keeps counting up across files, it does
not reset). `NET_Init()`'s other side effects (cvar/command registration,
initializing the loop and datagram drivers) are idempotent no-ops on a
second call from another file, per cvar.ts's/cmd.ts's own "already defined"
duplicate guards.
*/

import { describe, test, expect } from "bun:test";
import { netLoopDriver } from "../src/common/net_loop";
import { QsocketT } from "../src/common/net";
import { SizeBuf, SZ_Alloc, SZ_Write, net_message } from "../src/common/sizebuf";
import { NET_Init, setNetHostHooks, type NetHostHooks } from "../src/common/net_main";

const fakeHooks: NetHostHooks = {
  svActive: () => false,
  svName: () => "",
  svsMaxclients: () => 32,
  svsMaxclientslimit: () => 32,
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

setNetHostHooks(fakeHooks);
NET_Init(); // see file header: the only sanctioned way to populate net_main.ts's qsocket pool

function makeSizeBuf(bytes: number[]): SizeBuf {
  const sb = new SizeBuf();
  SZ_Alloc(sb, 2048);
  SZ_Write(sb, new Uint8Array(bytes), bytes.length);
  return sb;
}

describe("Loop_Init / Loop_Listen", () => {
  test("Init returns 0 when not a dedicated server; Listen is a no-op that never throws", () => {
    expect(netLoopDriver.Init()).toBe(0);
    expect(() => netLoopDriver.Listen(true)).not.toThrow();
    expect(() => netLoopDriver.Listen(false)).not.toThrow();
  });
});

describe("Loop_Connect with a non-\"local\" host", () => {
  test("returns null without touching loop_client/loop_server", () => {
    expect(netLoopDriver.Connect("somewhere.else")).toBeNull();
    expect(netLoopDriver.Connect(null)).toBeNull();
  });
});

describe("Loop driver end-to-end: connect, message exchange, close", () => {
  let client: QsocketT;
  let server: QsocketT;

  test("Connect(\"local\") returns the client socket; CheckNewConnections returns the paired server socket", () => {
    const c = netLoopDriver.Connect("local");
    expect(c).not.toBeNull();
    expect(c).toBeInstanceOf(QsocketT);
    if (!c) throw new Error("unreachable");
    client = c;

    const s = netLoopDriver.CheckNewConnections();
    expect(s).not.toBeNull();
    expect(s).toBeInstanceOf(QsocketT);
    if (!s) throw new Error("unreachable");
    server = s;

    expect(server).not.toBe(client);
    // Loop_Connect wires each side's driverdata to the other's qsocket.
    expect(client.driverdata).toBe(server);
    expect(server.driverdata).toBe(client);
    expect(client.address).toBe("localhost");
    expect(server.address).toBe("LOCAL");
  });

  test("a reliable message sent by the client is received byte-exact on the server side, returning 1", () => {
    const payload = [1, 2, 3, 4, 5, 250, 251, 0, 42];
    const msg = makeSizeBuf(payload);

    expect(netLoopDriver.QSendMessage(client, msg)).toBe(1);
    // Loop_SendMessage clears the sender's own canSend until the peer
    // reads the message back (ret === 1 in Loop_GetMessage sets it again).
    expect(netLoopDriver.CanSendMessage(client)).toBe(false);

    const ret = netLoopDriver.QGetMessage(server);
    expect(ret).toBe(1);
    expect(Array.from(net_message.data.subarray(0, net_message.cursize))).toEqual(payload);

    expect(netLoopDriver.CanSendMessage(client)).toBe(true);
  });

  test("an unreliable message is received on the other side with return 2", () => {
    const payload = [9, 9, 9, 7];
    const msg = makeSizeBuf(payload);

    expect(netLoopDriver.SendUnreliableMessage(server, msg)).toBe(1);

    const ret = netLoopDriver.QGetMessage(client);
    expect(ret).toBe(2);
    expect(Array.from(net_message.data.subarray(0, net_message.cursize))).toEqual(payload);
  });

  test("CanSendMessage is false while a reliable message the peer hasn't read yet is pending", () => {
    const payload = [7, 7];
    const msg = makeSizeBuf(payload);

    expect(netLoopDriver.QSendMessage(client, msg)).toBe(1);
    expect(netLoopDriver.CanSendMessage(client)).toBe(false);

    // drain it so it doesn't affect the next test
    const ret = netLoopDriver.QGetMessage(server);
    expect(ret).toBe(1);
    expect(netLoopDriver.CanSendMessage(client)).toBe(true);
  });

  test("Loop_Close disconnects both sides", () => {
    netLoopDriver.Close(client);
    expect(client.receiveMessageLength).toBe(0);
    expect(client.sendMessageLength).toBe(0);
    expect(client.canSend).toBe(true);
    // Loop_Close nulls the *peer's* driverdata, not its own.
    expect(server.driverdata).toBeNull();

    netLoopDriver.Close(server);
    expect(server.receiveMessageLength).toBe(0);
    expect(server.sendMessageLength).toBe(0);
    expect(server.canSend).toBe(true);
  });
});
