/*
Self-sufficient test for src/common/net_main.ts (WinQuake net_main.c, plus
the net_bsd.c driver-table pieces this unit ported alongside it).

Sets up its own `NetHostHooks` fake and calls the real `NET_Init()` once as
bootstrap -- the only sanctioned way to populate the shared qsocket pool
(`net_freeSockets`/`net_activeSockets` are exported `let`s; an importing
module can read them but cannot reassign another module's `let` binding) and
to register the cvars/commands this file asserts on. bun runs every test
file in one process against one shared module instance (see
test/net_loop.test.ts's file header for the measured proof), so `NET_Init`'s
other side effects (cvar/command registration) are guarded to be idempotent
no-ops on a second call from another file, per cvar.ts's/cmd.ts's own
"already defined" duplicate guards -- this file's assertions only rely on
"is it registered at all", never on being the first or only registrant.
*/

import { describe, test, expect } from "bun:test";
import { QsocketT, PollProcedureT } from "../src/common/net";
import {
  NET_NewQSocket,
  NET_FreeQSocket,
  net_activeSockets,
  net_freeSockets,
  NET_Init,
  setNetHostHooks,
  NET_Connect,
  NET_SendToAll,
  NET_Poll,
  SchedulePollProcedure,
  hostname,
  type NetHostHooks,
} from "../src/common/net_main";
import { netLoopDriver } from "../src/common/net_loop";
import { Cvar_FindVar } from "../src/common/cvar";
import { Cmd_Exists } from "../src/common/cmd";
import { SizeBuf, SZ_Alloc, SZ_Write, net_message } from "../src/common/sizebuf";

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

setNetHostHooks(fakeHooks);
NET_Init();

describe("NET_NewQSocket / NET_FreeQSocket pool", () => {
  test("NewQSocket draws from net_freeSockets, resets fields, and prepends to net_activeSockets", () => {
    const before = net_activeSockets;
    const sock = NET_NewQSocket();
    expect(sock).not.toBeNull();
    if (!sock) throw new Error("unreachable");

    expect(sock.disconnected).toBe(false);
    expect(sock.canSend).toBe(true);
    expect(sock.sendNext).toBe(false);
    expect(sock.ackSequence).toBe(0);
    expect(sock.sendSequence).toBe(0);
    expect(sock.unreliableSendSequence).toBe(0);
    expect(sock.sendMessageLength).toBe(0);
    expect(sock.receiveSequence).toBe(0);
    expect(sock.unreliableReceiveSequence).toBe(0);
    expect(sock.receiveMessageLength).toBe(0);
    expect(sock.address).toBe("UNSET ADDRESS");
    expect(sock.driverdata).toBeNull();

    // pushed onto the front of net_activeSockets
    expect(net_activeSockets).toBe(sock);
    expect(sock.next).toBe(before);

    NET_FreeQSocket(sock);
    expect(sock.disconnected).toBe(true);
    expect(net_freeSockets).toBe(sock);
    expect(net_activeSockets).toBe(before);
  });

  test("FreeQSocket throws (Sys_Error) if the socket isn't in the active list", () => {
    const orphan = new QsocketT();
    expect(() => NET_FreeQSocket(orphan)).toThrow();
  });

  test("NewQSocket returns null once net_activeconnections has reached svsMaxclients()", () => {
    const restrictiveHooks: NetHostHooks = { ...fakeHooks, svsMaxclients: () => 0 };
    setNetHostHooks(restrictiveHooks);
    expect(NET_NewQSocket()).toBeNull();
    setNetHostHooks(fakeHooks);
  });

  test("NewQSocket returns null once net_freeSockets is exhausted", () => {
    // draw down whatever remains, then confirm one more draw fails cleanly
    const drawn: QsocketT[] = [];
    for (let sock = NET_NewQSocket(); sock !== null; sock = NET_NewQSocket()) drawn.push(sock);
    expect(NET_NewQSocket()).toBeNull();
    // give them back so later tests (and other files sharing this pool) still have sockets to draw
    for (const s of drawn) NET_FreeQSocket(s);
  });
});

describe("SchedulePollProcedure / NET_Poll", () => {
  test("a procedure does not fire before its scheduled time, fires once it has passed, and fires in nextTime order", async () => {
    const order: string[] = [];
    const pSlow = new PollProcedureT(() => order.push("slow"));
    const pFast = new PollProcedureT(() => order.push("fast"));

    // scheduled out of nextTime order -- SchedulePollProcedure's insertion
    // sort is what makes NET_Poll fire "fast" before "slow" regardless.
    SchedulePollProcedure(pSlow, 0.05);
    SchedulePollProcedure(pFast, 0.01);

    NET_Poll();
    expect(order.includes("fast")).toBe(false);
    expect(order.includes("slow")).toBe(false);

    await Bun.sleep(150);
    NET_Poll();

    expect(order).toContain("fast");
    expect(order).toContain("slow");
    expect(order.indexOf("fast")).toBeLessThan(order.indexOf("slow"));

    const callsAfterFirstPoll = order.length;
    NET_Poll();
    expect(order.length).toBe(callsAfterFirstPoll); // each procedure fires exactly once
  });

  test("a procedure scheduled far in the future never fires from a poll taken well before it", () => {
    let fired = false;
    const pLate = new PollProcedureT(() => {
      fired = true;
    });
    SchedulePollProcedure(pLate, 30);
    NET_Poll();
    expect(fired).toBe(false);
  });
});

describe("NET_Init registration", () => {
  test("registers the hostname cvar", () => {
    expect(Cvar_FindVar("hostname")).not.toBeNull();
    expect(Cvar_FindVar("hostname")).toBe(hostname);
  });

  test("registers the slist/listen/maxplayers/port commands", () => {
    expect(Cmd_Exists("slist")).toBe(true);
    expect(Cmd_Exists("listen")).toBe(true);
    expect(Cmd_Exists("maxplayers")).toBe(true);
    expect(Cmd_Exists("port")).toBe(true);
  });
});

describe("NET_SendToAll over the loop driver", () => {
  test("a client on driver 0 (loop) is delivered to directly on the first pass, returning 0", () => {
    const client = NET_Connect("local");
    expect(client).not.toBeNull();
    if (!client) throw new Error("unreachable");
    expect(client.driver).toBe(0);

    const server = netLoopDriver.CheckNewConnections();
    expect(server).not.toBeNull();
    if (!server) throw new Error("unreachable");

    const sendToAllHooks: NetHostHooks = {
      ...fakeHooks,
      svsMaxclients: () => 1,
      svsClients: () => [{ active: true, name: "p1", colors: 0, frags: 0, netconnection: client }],
    };
    setNetHostHooks(sendToAllHooks);

    const payload = new Uint8Array([10, 20, 30, 40]);
    const msg = new SizeBuf();
    SZ_Alloc(msg, 64);
    SZ_Write(msg, payload, payload.length);

    const count = NET_SendToAll(msg, 0.5);
    expect(count).toBe(0);

    const ret = netLoopDriver.QGetMessage(server);
    expect(ret).toBe(1);
    expect(Array.from(net_message.data.subarray(0, net_message.cursize))).toEqual(Array.from(payload));

    setNetHostHooks(fakeHooks);
    netLoopDriver.Close(client);
    netLoopDriver.Close(server);
  });

  test("an empty client slot (no netconnection) is skipped and does not block the call", () => {
    const sendToAllHooks: NetHostHooks = {
      ...fakeHooks,
      svsMaxclients: () => 1,
      svsClients: () => [{ active: false, name: "", colors: 0, frags: 0, netconnection: null }],
    };
    setNetHostHooks(sendToAllHooks);

    const msg = new SizeBuf();
    SZ_Alloc(msg, 16);

    const count = NET_SendToAll(msg, 0.5);
    expect(count).toBe(0);

    setNetHostHooks(fakeHooks);
  });
});
