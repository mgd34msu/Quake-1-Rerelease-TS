// Self-sufficient test for src/client/cl_main.ts (WinQuake cl_main.c),
// its hostClientHooks registrations (host.ts), and the Cmd_ForwardToServer
// body it installs into cmd.ts.
//
// cl_main.ts's own top-level imports reach several concurrently-written
// sibling units (cl_parse.ts, cl_demo.ts, screen.ts, r_part.ts, snd_dma.ts)
// that this coordinator wave is writing at the same time. If any of them are
// missing when this file runs, the whole file fails to load with "Cannot
// find module" -- that is the concurrency model working as intended, not a
// bug here; see this unit's own final report for the exact list.
//
// The loopback-connect recipe (NET_Init/setNetHostHooks/NET_CheckNewConnections
// over net_loop.ts's Loop_Connect/CheckNewConnections) is copied from
// test/sv_user.test.ts's own file header, including its reasoning: bun runs
// every test file in one shared process against one shared module instance,
// so the qsocket pool is process-wide and each file must set up (and tear
// down) its own hooks/driver state rather than assume another file already
// did.
//
// None of this file's CL_RelinkEntities scenarios put an entity through the
// "empty slot, forcelink" branch (the only one that reaches into the
// renderer, via getRenderer().R_RemoveEfrags), so unlike
// test/client_types.test.ts this file needs no fake Renderer.

import { describe, test, expect, afterAll } from "bun:test";
import {
  CL_AllocDlight,
  CL_ClearState,
  CL_DecayLights,
  CL_Disconnect,
  CL_EstablishConnection,
  CL_LerpPoint,
  CL_RelinkEntities,
  CL_SendCmd,
  cl_nolerp,
} from "../src/client/cl_main";
import {
  CactiveT,
  MAX_EFRAGS,
  cl,
  cl_dlights,
  cl_efrags,
  cl_entities,
  cl_visedicts,
  clState,
  cls,
} from "../src/client/client";
import { chase_active } from "../src/client/chase";
import { ModelT } from "../src/common/model";
import { EF_BRIGHTLIGHT, sv } from "../src/server/server";
import { hostClientHooks } from "../src/common/host";
import { SZ_Alloc, SZ_Print } from "../src/common/sizebuf";
import { NET_Init, NET_CheckNewConnections, setNetHostHooks, type NetHostHooks } from "../src/common/net_main";
import { netLoopDriver } from "../src/common/net_loop";
import type { QsocketT } from "../src/common/net";

//============================================================================
// hostClientHooks -- registered by cl_main.ts's own registerClMainHooks() as
// a side effect of the import above, at module load, not inside CL_Init.

describe("hostClientHooks registration", () => {
  test("cl_main.ts's module-load registration installs every hook cl_main.c owns", () => {
    expect(typeof hostClientHooks.clDisconnect).toBe("function");
    expect(typeof hostClientHooks.clDisconnectF).toBe("function");
    expect(typeof hostClientHooks.clEstablishConnection).toBe("function");
    expect(typeof hostClientHooks.clNextDemo).toBe("function");
    expect(typeof hostClientHooks.clSendCmd).toBe("function");
    expect(typeof hostClientHooks.clReadFromServer).toBe("function");
    expect(typeof hostClientHooks.clDecayLights).toBe("function");
    expect(typeof hostClientHooks.clInit).toBe("function");
    expect(typeof hostClientHooks.flushCaches).toBe("function"); // D_FlushCaches -- the coordinator placeholder's hook
    expect(typeof hostClientHooks.clearClient).toBe("function"); // cls.signon = 0; cl.clear()
    expect(typeof hostClientHooks.clsStateConnected).toBe("function");
    expect(typeof hostClientHooks.clsSignonComplete).toBe("function");
    expect(typeof hostClientHooks.clNameString).toBe("function");
    expect(typeof hostClientHooks.clColorValue).toBe("function");
  });
});

//============================================================================
// CL_ClearState

describe("CL_ClearState", () => {
  test("wipes cl, cls.message, and the other client arrays, and rebuilds the efrag free chain", () => {
    sv.active = false; // exercise the !sv.active -> Host_ClearMemory() branch, deterministically

    cl.movemessages = 7;
    cl.time = 12.5;
    cl.viewentity = 3;
    cl_entities[2].model = new ModelT();
    cl_dlights[1].radius = 99;
    cl_dlights[1].key = 42;
    SZ_Alloc(cls.message, 1024); // cls.message starts unallocated (maxsize 0) until CL_Init or a test allocates it
    SZ_Print(cls.message, "leftover");

    CL_ClearState();

    expect(cl.movemessages).toBe(0);
    expect(cl.time).toBe(0);
    expect(cl.viewentity).toBe(0);
    expect(cl_entities[2].model).toBeNull();
    expect(cl_dlights[1].radius).toBe(0);
    expect(cl_dlights[1].key).toBe(0);
    expect(cls.message.cursize).toBe(0);

    // the free list starts at cl_efrags[0] and chains every entry but the
    // last, which terminates it (CL_ClearState's own "allocate the efrags
    // and chain together into a free list" loop).
    expect(cl.free_efrags).toBe(cl_efrags[0]);
    let e = cl.free_efrags;
    let count = 0;
    while (e !== null) {
      count++;
      e = e.entnext;
    }
    expect(count).toBe(MAX_EFRAGS);
    expect(cl_efrags[MAX_EFRAGS - 1].entnext).toBe(null);
  });
});

//============================================================================
// CL_AllocDlight

describe("CL_AllocDlight", () => {
  test("exact key match, expiry reuse, and first-free fallback", () => {
    sv.active = false;
    CL_ClearState(); // every cl_dlights[i]: key=0, die=0, radius=0
    cl.time = 10;

    // no existing key===5, so it falls to "anything expired": every die (0)
    // is < cl.time (10), so the very first slot is handed back.
    const first = CL_AllocDlight(5);
    expect(first).toBe(cl_dlights[0]);
    expect(first.key).toBe(5);

    // a second call with the same key now finds the exact match and reuses
    // (and re-clears) that same slot instead of walking to a new one.
    cl_dlights[0].radius = 123;
    const second = CL_AllocDlight(5);
    expect(second).toBe(cl_dlights[0]);
    expect(second.radius).toBe(0); // clearDlight re-zeroed it
    expect(second.key).toBe(5);

    // expiry reuse: slot 0 is still alive (die >= cl.time), slot 1 is
    // expired (die < cl.time). key 0 is falsy, so the exact-match search is
    // skipped entirely and the first expired slot -- slot 1 -- comes back.
    cl_dlights[0].die = 100;
    cl_dlights[1].die = -5;
    const third = CL_AllocDlight(0);
    expect(third).toBe(cl_dlights[1]);
    expect(third.key).toBe(0);

    // first-free fallback: with every slot marked alive, CL_AllocDlight
    // falls back to cl_dlights[0] unconditionally.
    for (const dl of cl_dlights) dl.die = 1000;
    const fourth = CL_AllocDlight(7);
    expect(fourth).toBe(cl_dlights[0]);
    expect(fourth.key).toBe(7);
  });
});

//============================================================================
// CL_DecayLights

describe("CL_DecayLights", () => {
  test("decays every live radius by (cl.time-cl.oldtime)*decay, skips expired/zero-radius, clamps at 0", () => {
    sv.active = false;
    CL_ClearState();
    cl.time = 10;
    cl.oldtime = 9; // delta = 1

    cl_dlights[0].die = 20; // alive
    cl_dlights[0].radius = 50;
    cl_dlights[0].decay = 10;

    cl_dlights[1].die = 5; // already expired -- must be skipped despite a nonzero radius
    cl_dlights[1].radius = 999;
    cl_dlights[1].decay = 1;

    cl_dlights[2].die = 20; // alive, but radius already 0 -- must be skipped
    cl_dlights[2].radius = 0;
    cl_dlights[2].decay = 5;

    cl_dlights[3].die = 20; // decays past 0 and clamps there
    cl_dlights[3].radius = 5;
    cl_dlights[3].decay = 100;

    CL_DecayLights();

    expect(cl_dlights[0].radius).toBe(40);
    expect(cl_dlights[1].radius).toBe(999);
    expect(cl_dlights[2].radius).toBe(0);
    expect(cl_dlights[3].radius).toBe(0);
  });
});

//============================================================================
// CL_LerpPoint

describe("CL_LerpPoint", () => {
  test("cl_nolerp forces frac=1 and snaps cl.time to the newest message", () => {
    sv.active = false;
    cls.timedemo = false;
    cl_nolerp.value = 1;
    cl.mtime[0] = 5;
    cl.mtime[1] = 3;
    cl.time = 3.5;

    expect(CL_LerpPoint()).toBe(1);
    expect(cl.time).toBe(5);

    cl_nolerp.value = 0; // reset for the tests below
  });

  test("cls.timedemo forces frac=1 and snaps cl.time to the newest message", () => {
    sv.active = false;
    cl_nolerp.value = 0;
    cls.timedemo = true;
    cl.mtime[0] = 8;
    cl.mtime[1] = 6;
    cl.time = 6.5;

    expect(CL_LerpPoint()).toBe(1);
    expect(cl.time).toBe(8);

    cls.timedemo = false; // reset
  });

  test("sv.active forces frac=1 and snaps cl.time to the newest message", () => {
    sv.active = true;
    cl_nolerp.value = 0;
    cls.timedemo = false;
    cl.mtime[0] = 2;
    cl.mtime[1] = 1;
    cl.time = 1.5;

    expect(CL_LerpPoint()).toBe(1);
    expect(cl.time).toBe(2);

    sv.active = false; // reset
  });

  test("ordinary interpolation returns the fraction between mtime[1] and mtime[0], leaving cl.time alone", () => {
    sv.active = false;
    cl_nolerp.value = 0;
    cls.timedemo = false;
    cl.mtime[0] = 1.0;
    cl.mtime[1] = 0.95;
    cl.time = 0.975;

    expect(CL_LerpPoint()).toBeCloseTo(0.5, 6);
    expect(cl.time).toBeCloseTo(0.975, 6);
  });
});

//============================================================================
// CL_RelinkEntities

describe("CL_RelinkEntities", () => {
  test("lerps a normal entity, snaps a >100-unit teleport, allocates an EF_BRIGHTLIGHT dlight, skips the view entity, and fills visedicts in cl_entities order", () => {
    sv.active = false;
    CL_ClearState(); // clean cl_entities / cl_dlights / clState.cl_numvisedicts

    cl_nolerp.value = 0;
    cls.timedemo = false;
    cls.demoplayback = false;
    cl.mtime[0] = 1.0;
    cl.mtime[1] = 0.95;
    cl.time = 0.975; // CL_LerpPoint() -> frac === 0.5, per the CL_LerpPoint tests above

    chase_active.value = 0;
    cl.viewentity = 4;
    cl.num_entities = 5; // world (index 0, untouched) + four test entities

    const plainModel = new ModelT(); // flags=0 -- no EF_ROTATE/trail side effects to worry about

    // ent 1: ordinary lerp, delta within +-100 on every axis
    const ent1 = cl_entities[1];
    ent1.model = plainModel;
    ent1.msgtime = cl.mtime[0];
    ent1.msg_origins[1][0] = 0;
    ent1.msg_origins[1][1] = 0;
    ent1.msg_origins[1][2] = 0;
    ent1.msg_origins[0][0] = 10;
    ent1.msg_origins[0][1] = 20;
    ent1.msg_origins[0][2] = 30;
    ent1.msg_angles[1][0] = 0;
    ent1.msg_angles[0][0] = 10;

    // ent 2: a >100-unit jump on X assumes a teleport -- no lerp, f forced to 1
    const ent2 = cl_entities[2];
    ent2.model = plainModel;
    ent2.msgtime = cl.mtime[0];
    ent2.msg_origins[1][0] = 0;
    ent2.msg_origins[1][1] = 0;
    ent2.msg_origins[1][2] = 0;
    ent2.msg_origins[0][0] = 200;
    ent2.msg_origins[0][1] = 0;
    ent2.msg_origins[0][2] = 0;

    // ent 3: EF_BRIGHTLIGHT, no origin delta -- isolates the dlight alloc
    const ent3 = cl_entities[3];
    ent3.model = plainModel;
    ent3.msgtime = cl.mtime[0];
    ent3.effects = EF_BRIGHTLIGHT;
    ent3.msg_origins[1][0] = 50;
    ent3.msg_origins[1][1] = 60;
    ent3.msg_origins[1][2] = 70;
    ent3.msg_origins[0][0] = 50;
    ent3.msg_origins[0][1] = 60;
    ent3.msg_origins[0][2] = 70;

    // ent 4: the view entity itself -- relinked like any other entity, but
    // excluded from cl_visedicts because chase_active is 0
    const ent4 = cl_entities[4];
    ent4.model = plainModel;
    ent4.msgtime = cl.mtime[0];

    CL_RelinkEntities();

    // ent1: origin = msg_origins[1] + 0.5*(msg_origins[0]-msg_origins[1])
    expect(ent1.origin[0]).toBeCloseTo(5, 2);
    expect(ent1.origin[1]).toBeCloseTo(10, 2);
    expect(ent1.origin[2]).toBeCloseTo(15, 2);
    expect(ent1.angles[0]).toBeCloseTo(5, 2);

    // ent2: teleport snap -- lands exactly at msg_origins[0], not the 0.5
    // lerp the global frac would otherwise give it
    expect(ent2.origin[0]).toBeCloseTo(200, 2);
    expect(ent2.origin[1]).toBeCloseTo(0, 2);
    expect(ent2.origin[2]).toBeCloseTo(0, 2);

    // ent3: EF_BRIGHTLIGHT allocates a dlight keyed to its cl_entities
    // index (3), radius 400 + rand()&31, origin raised 16 on Z, die =
    // cl.time + 0.001 -- landing at cl_dlights[0] since CL_ClearState left
    // every slot's die at 0 (< cl.time), the first-expired match.
    const dl = cl_dlights[0];
    expect(dl.key).toBe(3);
    expect(dl.radius).toBeGreaterThanOrEqual(400);
    expect(dl.radius).toBeLessThan(432);
    expect(dl.origin[0]).toBeCloseTo(50, 2);
    expect(dl.origin[1]).toBeCloseTo(60, 2);
    expect(dl.origin[2]).toBeCloseTo(86, 2);
    expect(dl.die).toBeCloseTo(cl.time + 0.001, 5);

    // viewentity + visedicts: ent4 (the view entity, chase_active===0) is
    // excluded; ent1/ent2/ent3 are included, in cl_entities order.
    expect(clState.cl_numvisedicts).toBe(3);
    expect(cl_visedicts[0]).toBe(ent1);
    expect(cl_visedicts[1]).toBe(ent2);
    expect(cl_visedicts[2]).toBe(ent3);
  });

  test("demoplayback lerps cl.viewangles across the 180-degree wrap using CL_LerpPoint's frac", () => {
    sv.active = false;
    CL_ClearState();

    cl_nolerp.value = 0;
    cls.timedemo = false;
    cls.demoplayback = true;
    cl.mtime[0] = 1.0;
    cl.mtime[1] = 0.95;
    cl.time = 0.975; // frac === 0.5

    cl.mviewangles[0][1] = 170; // YAW
    cl.mviewangles[1][1] = -170;
    cl.num_entities = 1; // no entities to relink; only the angle lerp matters here

    CL_RelinkEntities();

    // d = 170 - (-170) = 340 > 180 -> d -= 360 = -20
    // viewangles[YAW] = -170 + 0.5*(-20) = -180
    expect(cl.viewangles[1]).toBeCloseTo(-180, 2);

    cls.demoplayback = false; // reset
  });
});

//============================================================================
// CL_EstablishConnection / CL_Disconnect / CL_SendCmd -- a real loopback
// QsocketT pair, exactly as test/sv_user.test.ts drives SV_ReadClientMessage.
// setNetHostHooks/NET_Init are called here too, self-sufficiently: bun runs
// every test file in one shared process against one shared module instance.

const fakeNetHostHooks: NetHostHooks = {
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
setNetHostHooks(fakeNetHostHooks);
NET_Init(); // idempotent across test files sharing this process, see file header

const openLoopSockets: QsocketT[] = [];

// This file's only cls.state test drives CL_EstablishConnection/
// CL_Disconnect, whose real bodies leave cls.state at ca_disconnected, not
// the pristine ca_dedicated default -- snapshotted before that test runs,
// restored below (rule 15).
const savedClsState = cls.state;

afterAll(() => {
  for (const sock of openLoopSockets) netLoopDriver.Close(sock);
  cls.state = savedClsState;
});

// A plain read through a function, not a bare `cls.state` reference: TS's
// control-flow narrowing otherwise remembers this test's own literal
// assignments to `cls.state` and rejects a later `toBe()` against a
// different CactiveT member as an impossible comparison.
function currentClsState(): CactiveT {
  return cls.state;
}

describe("CL_EstablishConnection / CL_Disconnect / CL_SendCmd", () => {
  test("establishes a loopback connection, flushes a queued message below SIGNONS, then disconnects cleanly", () => {
    cls.state = CactiveT.ca_disconnected; // simulate a non-dedicated client boot
    cls.demoplayback = false;
    cls.demorecording = false;
    SZ_Alloc(cls.message, 1024); // CL_Init's own allocation -- done directly, since this test does not call CL_Init

    CL_EstablishConnection("local");

    expect(currentClsState()).toBe(CactiveT.ca_connected);
    expect(cls.netcon).not.toBe(null);
    expect(cls.demonum).toBe(-1);
    expect(cls.signon).toBe(0);

    const client = cls.netcon;
    if (client === null) throw new Error("expected CL_EstablishConnection to set cls.netcon");
    // net_loop.ts's `loop_client`/`loop_server` are module-level singletons
    // Loop_Connect reuses rather than reallocating, and Loop_Connect/
    // Loop_CheckNewConnections reset every field on them EXCEPT
    // `disconnected` -- so another test file that marks a loopback socket
    // `disconnected = true` directly (instead of routing it through
    // NET_Close, which would null out the singleton for a fresh future
    // allocation) leaves that flag stuck on the shared object this
    // `NET_Connect("local")` call goes on to hand back. Cleared explicitly
    // here so this test's own pass/fail never depends on whether some
    // other file in the same process already touched the loopback pair.
    client.disconnected = false;
    // the loopback pair's server side, picked up the way SV_Init's frame
    // loop would (net_driverlevel doesn't need `listening` for the loop
    // driver at index 0 -- see net_main.ts's NET_CheckNewConnections).
    const server = NET_CheckNewConnections();
    if (server === null) throw new Error("expected a server-side socket from the loopback pair");
    server.disconnected = false;
    openLoopSockets.push(client, server);

    // below SIGNONS: CL_BaseMove/IN_Move/CL_SendMove are skipped, but a
    // queued reliable message (e.g. one of CL_SignonReply's stages) still
    // gets flushed to the wire.
    cls.signon = 1;
    SZ_Print(cls.message, "prespawn");
    expect(cls.message.cursize).toBeGreaterThan(0);

    CL_SendCmd();

    expect(cls.message.cursize).toBe(0);

    CL_Disconnect();

    expect(currentClsState()).toBe(CactiveT.ca_disconnected);
    expect(cls.demoplayback).toBe(false);
    expect(cls.timedemo).toBe(false);
    expect(cls.signon).toBe(0);
  });
});
