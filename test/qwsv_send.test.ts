/*
Self-sufficient test for Q015: src/qw/server/sv_init.ts, sv_ccmds.ts,
sv_ents.ts, sv_nchan.ts, sv_send.ts (QW/server/sv_init.c, sv_ccmds.c,
sv_ents.c, sv_nchan.c, sv_send.c). Exercises the pure-data parts that don't
need a live UDP socket, per the unit brief:
  - sv_nchan.ts: ClientReliableWrite_* and ClientReliableCheckBlock's
    back-buffer rollover and the MAX_BACK_BUFFERS overflow path.
  - sv_ents.ts: SV_WriteDelta's U_* bit computation and SV_EmitPacketEntities'
    delta/baseline/remove encoding against a synthetic "from" frame.
  - sv_send.ts: SV_Multicast (MULTICAST_ALL) into a fake spawned client's
    unreliable datagram, and SV_UpdateClientStats' delta-only-on-change
    behavior.
  - sv_init.ts: SV_CalcPHS against a tiny synthetic BSP (test/support/
    bsp_builder's one-real-leaf fixture, the same recipe test/qwsv_world.test.ts
    uses).

Standing order 13 (never rely on another test file having run first) and
rule 15 (shared singletons get reset by your own suite): `sv`/`svs`/`qwpr`
are process-wide singletons other suites (test/qwsv_world.test.ts,
test/qwsv_progs.test.ts) also touch. This file initializes every piece of
that state itself in its own beforeAll/beforeEach and restores it in
afterEach/afterAll, rather than assuming a particular starting point.
*/

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/qw/common";
import { setComSearchpaths, setComModified } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Mod_Init, Mod_ForName } from "../src/qw/server/model";
import { QwEdictT, setEdictTable, EDICT_NUM, qwpr } from "../src/qw/server/progs";
import { QW_ENTVARS_SIZE_WORDS, QW_NUM_GLOBAL_WORDS, QwGlobalVars } from "../src/qw/server/progdefs";
import { ClientFrameT, ClientStateT, ClientT, MAX_BACK_BUFFERS, MulticastT, RedirectT, sv, svs } from "../src/qw/server/server";
import { MAX_CLIENTS, MAX_PACKET_ENTITIES, PacketEntitiesT, QwEntityStateT, UPDATE_MASK, U_ANGLE1, U_COLORMAP, U_EFFECTS, U_FRAME, U_MODEL, U_MOREBITS, U_ORIGIN1, U_ORIGIN2, U_REMOVE, U_SKIN } from "../src/qw/protocol";
import { MAX_CL_STATS, STAT_HEALTH, STAT_SHELLS } from "../src/qw/bothdefs";
import { MSG_WriteByte, SizeBuf } from "../src/common/sizebuf";
import { vec3 } from "../src/common/mathlib";

import {
  ClientReliableCheckBlock,
  ClientReliableWrite_Begin,
  ClientReliableWrite_Byte,
  ClientReliable_FinishWrite,
} from "../src/qw/server/sv_nchan";
import { SV_EmitPacketEntities, SV_WriteDelta } from "../src/qw/server/sv_ents";
import { SV_Multicast, SV_UpdateClientStats } from "../src/qw/server/sv_send";
import { SV_CalcPHS } from "../src/qw/server/sv_init";
import { svErrorState } from "../src/qw/server/sv_main";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-send-test-"));
const baseDir = join(scratchDir, "quake");

// see file header: com_searchpaths/com_modified are shared, process-wide
// singletons (src/common/common.ts) -- reset before/after every test so no
// other suite's search path or registration state leaks in or out.
beforeEach(() => {
  setComSearchpaths(null);
  setComModified(false);
});
afterAll(() => {
  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================
// helpers

function makeClient(): ClientT {
  const cl = new ClientT();
  // netchan.message/datagram default to an empty (maxsize=0) SizeBuf --
  // give both real backing storage, matching what Netchan_Setup/connection
  // handling would have done in the real server.
  cl.netchan.message.data = new Uint8Array(64);
  cl.netchan.message.maxsize = 64;
  cl.netchan.message.cursize = 0;
  cl.datagram.data = cl.datagram_buf;
  cl.datagram.maxsize = cl.datagram_buf.length;
  cl.datagram.cursize = 0;
  return cl;
}

function bytesOf(msg: SizeBuf): number[] {
  return Array.from(msg.data.subarray(0, msg.cursize));
}

//============================================================================
// sv_nchan.ts: ClientReliableWrite_* back-buffer rollover / overflow

describe("sv_nchan.ts: ClientReliableCheckBlock / ClientReliableWrite_*", () => {
  test("writes go straight to netchan.message when there is no back buffer", () => {
    const cl = makeClient();
    ClientReliableWrite_Byte(cl, 0x42);
    expect(cl.num_backbuf).toBe(0);
    expect(bytesOf(cl.netchan.message)).toEqual([0x42]);
  });

  test("a write that would overflow netchan.message rotates into backbuf[0]", () => {
    const cl = makeClient();
    cl.netchan.message.cursize = 60; // 64 - 60 = 4 bytes free

    // maxsize=10 > the 4 bytes free -> ClientReliableCheckBlock must rotate
    ClientReliableWrite_Begin(cl, 0x99, 10);

    expect(cl.num_backbuf).toBe(1);
    expect(cl.backbuf.data).toBe(cl.backbuf_data[0]);
    expect(cl.backbuf.maxsize).toBe(cl.backbuf_data[0].length);
    expect(bytesOf(cl.backbuf)).toEqual([0x99]);
    // netchan.message itself is untouched (the byte went to backbuf instead)
    expect(cl.netchan.message.cursize).toBe(60);
    // ClientReliable_FinishWrite mirrors backbuf.cursize into backbuf_size[0]
    expect(cl.backbuf_size[0]).toBe(1);
  });

  test("further small writes stay in the same backbuf slot once one is open", () => {
    const cl = makeClient();
    cl.netchan.message.cursize = 60;

    ClientReliableWrite_Begin(cl, 1, 10);
    ClientReliableWrite_Byte(cl, 2);
    ClientReliableWrite_Byte(cl, 3);

    expect(cl.num_backbuf).toBe(1);
    expect(bytesOf(cl.backbuf)).toEqual([1, 2, 3]);
  });

  test("rotates to a new backbuf slot once the current one is also nearly full", () => {
    const cl = makeClient();
    cl.netchan.message.cursize = 60; // always "would overflow" against netchan.message

    ClientReliableCheckBlock(cl, 10);
    expect(cl.num_backbuf).toBe(1);

    // pretend backbuf[0] itself is now nearly full -> the next check must rotate
    cl.backbuf.cursize = cl.backbuf.maxsize;
    ClientReliableCheckBlock(cl, 10);
    expect(cl.num_backbuf).toBe(2);
    expect(cl.backbuf.data).toBe(cl.backbuf_data[1]);
  });

  test("exceeding MAX_BACK_BUFFERS overflows netchan.message and clears the current backbuf", () => {
    const cl = makeClient();
    cl.netchan.message.cursize = 60;

    ClientReliableCheckBlock(cl, 10); // slot 0
    for (let slot = 1; slot < MAX_BACK_BUFFERS; slot++) {
      cl.backbuf.cursize = cl.backbuf.maxsize; // force rotation to the next slot
      ClientReliableCheckBlock(cl, 10);
      expect(cl.num_backbuf).toBe(slot + 1);
    }
    expect(cl.num_backbuf).toBe(MAX_BACK_BUFFERS);

    // one more rotation attempt: all MAX_BACK_BUFFERS slots exist and the
    // last one is full -> WARNING path, netchan.message.overflowed = true
    cl.backbuf.cursize = cl.backbuf.maxsize;
    ClientReliableCheckBlock(cl, 10);

    expect(cl.netchan.message.overflowed).toBe(true);
    expect(cl.backbuf.cursize).toBe(0); // "don't overflow without allowoverflow set"
  });

  test("ClientReliable_FinishWrite marks netchan.message.overflowed if the backbuf itself overflows", () => {
    const cl = makeClient();
    cl.netchan.message.cursize = 60;
    ClientReliableCheckBlock(cl, 10); // opens backbuf[0]

    cl.backbuf.overflowed = true; // simulate MSG_Write* having overflowed the backbuf
    ClientReliable_FinishWrite(cl);

    expect(cl.netchan.message.overflowed).toBe(true);
  });
});

//============================================================================
// sv_ents.ts: SV_WriteDelta / SV_EmitPacketEntities

describe("sv_ents.ts: SV_WriteDelta", () => {
  function makeMsg(size = 64): SizeBuf {
    const msg = new SizeBuf();
    msg.data = new Uint8Array(size);
    msg.maxsize = size;
    msg.cursize = 0;
    return msg;
  }

  test("no change and force=false writes nothing", () => {
    const msg = makeMsg();
    const from = new QwEntityStateT();
    from.number = 5;
    const to = new QwEntityStateT();
    to.number = 5;

    SV_WriteDelta(from, to, msg, false);

    expect(msg.cursize).toBe(0);
  });

  test("no change but force=true still writes the bare entity number", () => {
    const msg = makeMsg();
    const from = new QwEntityStateT();
    from.number = 5;
    const to = new QwEntityStateT();
    to.number = 5;

    SV_WriteDelta(from, to, msg, true);

    expect(bytesOf(msg)).toEqual([5, 0]); // short(5), no more-bits, no fields
  });

  test("an origin[0] change sets U_ORIGIN1 and writes the entity short + one coord", () => {
    const msg = makeMsg();
    const from = new QwEntityStateT();
    from.number = 7;
    const to = new QwEntityStateT();
    to.number = 7;
    to.origin[0] = 100; // miss = 100, well past the +-0.1 threshold

    SV_WriteDelta(from, to, msg, false);

    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
    const header = view.getUint16(0, true);
    expect(header & 0x1ff).toBe(7); // low 9 bits: entity number
    expect(header & U_ORIGIN1).toBe(U_ORIGIN1);
    expect(header & U_MOREBITS).toBe(0); // U_ORIGIN1 alone is within the low 511 bits, but MOREBITS only covers bits 0-6 (the "extra" byte)
    const coord = view.getInt16(2, true);
    expect(coord).toBe(800); // MSG_WriteCoord: (int)(100*8)
    expect(msg.cursize).toBe(4);
  });

  test("model/skin/colormap/frame/effects changes set U_MOREBITS and every matching bit", () => {
    const msg = makeMsg();
    const from = new QwEntityStateT();
    from.number = 9;
    from.modelindex = 1;
    from.frame = 0;
    from.colormap = 0;
    from.skinnum = 0;
    from.effects = 0;

    const to = new QwEntityStateT();
    to.number = 9;
    to.modelindex = 2;
    to.frame = 3;
    to.colormap = 4;
    to.skinnum = 5;
    to.effects = 6;

    SV_WriteDelta(from, to, msg, false);

    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
    const header = view.getUint16(0, true);
    expect(header & U_MOREBITS).toBe(U_MOREBITS);
    const moreBits = view.getUint8(2);
    expect(moreBits & U_MODEL).toBe(U_MODEL);
    expect(moreBits & U_COLORMAP).toBe(U_COLORMAP);
    expect(moreBits & U_SKIN).toBe(U_SKIN);
    expect(moreBits & U_EFFECTS).toBe(U_EFFECTS);
    // U_FRAME (bit 13, part of the first short, not the morebits byte)
    expect(header & U_FRAME).toBe(U_FRAME);

    // field order after morebits: model, frame, colormap, skin, effects
    expect(view.getUint8(3)).toBe(2); // modelindex
    expect(view.getUint8(4)).toBe(3); // frame
    expect(view.getUint8(5)).toBe(4); // colormap
    expect(view.getUint8(6)).toBe(5); // skinnum
    expect(view.getUint8(7)).toBe(6); // effects
  });

  test("angle change alone sets U_ANGLE1 with no U_MOREBITS (bit 0 is within the morebits byte, but the byte itself isn't emitted unless bits 0-8 are nonzero)", () => {
    const msg = makeMsg();
    const from = new QwEntityStateT();
    from.number = 3;
    const to = new QwEntityStateT();
    to.number = 3;
    to.angles[0] = 45;

    SV_WriteDelta(from, to, msg, false);

    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
    const header = view.getUint16(0, true);
    // U_ANGLE1 is bit 0 of the "morebits" byte (values 0-511), so bits&511
    // is nonzero and U_MOREBITS IS set here.
    expect(header & U_MOREBITS).toBe(U_MOREBITS);
    const moreBits = view.getUint8(2);
    expect(moreBits & U_ANGLE1).toBe(U_ANGLE1);
    const angle = view.getUint8(3);
    // MSG_WriteAngle: Math.trunc((f*256)/360) & 255, f=45 -> 32
    expect(angle).toBe(32);
  });

  test("throws when to.number is 0 (SV_Error: Unset entity number)", () => {
    const msg = makeMsg();
    const from = new QwEntityStateT();
    const to = new QwEntityStateT();
    to.number = 0;
    // SV_Error's real implementation (sv_main.ts) now runs for real, tripping
    // its `static qboolean inerror` reentrancy guard (a process-wide
    // singleton, rule 15) -- reset it so a later test file that also
    // provokes SV_Error does not inherit a recursive-entry state from here.
    svErrorState.inerror = false;
    expect(() => SV_WriteDelta(from, to, msg, true)).toThrow();
    svErrorState.inerror = false;
  });
});

describe("sv_ents.ts: SV_EmitPacketEntities", () => {
  function makeMsg(size = 256): SizeBuf {
    const msg = new SizeBuf();
    msg.data = new Uint8Array(size);
    msg.maxsize = size;
    msg.cursize = 0;
    return msg;
  }

  interface PackEntry {
    number?: number;
    modelindex?: number;
    origin?: readonly [number, number, number];
  }

  function packOf(entries: PackEntry[]): PacketEntitiesT {
    const pack = new PacketEntitiesT();
    pack.num_entities = entries.length;
    entries.forEach((e, i) => {
      const state = pack.entities[i];
      state.number = e.number ?? 0;
      if (e.origin) state.origin.set(e.origin);
      state.modelindex = e.modelindex ?? 0;
    });
    return pack;
  }

  let savedEdicts: QwEdictT[] | null = null;
  beforeAll(() => {
    // EDICT_NUM(newnum) is used for the "new entity, send from baseline"
    // path; give the table enough slots for entity numbers used below.
    const edicts: QwEdictT[] = [];
    for (let i = 0; i < 32; i++) edicts.push(new QwEdictT(i, QW_ENTVARS_SIZE_WORDS));
    edicts[20].baseline.number = 20; // any nonzero baseline.number != 0 (SV_WriteDelta's guard)
    edicts[20].baseline.modelindex = 7;
    setEdictTable(edicts);
    savedEdicts = edicts;
  });
  afterAll(() => {
    if (savedEdicts) setEdictTable(savedEdicts);
  });

  test("svc_packetentities (no prior delta) with one matching entity round-trips with no bits set", () => {
    const client = new ClientT();
    client.delta_sequence = -1;

    const to = packOf([{ number: 20, modelindex: 7 }]);
    const msg = makeMsg();

    SV_EmitPacketEntities(client, to, msg);

    // svc_packetentities(no delta), then baseline-delta for entity 20
    // (force=true since it's new to this client), then terminator 0.
    expect(msg.data[0]).toBe(47); // SvcOpsT.svc_packetentities
    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
    // header short at offset 1: entity 20, force=true but modelindex matches
    // baseline (7===7) and origin/angles/etc all zero -> bits stay 0, but
    // force=true means the number is still emitted with bits=0.
    const header = view.getUint16(1, true);
    expect(header & 0x1ff).toBe(20);
    // terminator: MSG_WriteShort(msg, 0) at the very end
    expect(view.getUint16(msg.cursize - 2, true)).toBe(0);
  });

  test("svc_deltapacketentities with a matching entity number encodes only the changed fields", () => {
    const client = new ClientT();
    client.delta_sequence = 3;
    const fromFrame = client.frames[3 & UPDATE_MASK];
    fromFrame.entities.num_entities = 1;
    fromFrame.entities.entities[0].number = 20;
    fromFrame.entities.entities[0].modelindex = 7;
    fromFrame.entities.entities[0].origin[0] = 0;

    const to = packOf([{ number: 20, modelindex: 7, origin: [64, 0, 0] }]);
    const msg = makeMsg();

    SV_EmitPacketEntities(client, to, msg);

    expect(msg.data[0]).toBe(48); // SvcOpsT.svc_deltapacketentities
    expect(msg.data[1]).toBe(3); // client.delta_sequence
    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
    const header = view.getUint16(2, true);
    expect(header & 0x1ff).toBe(20);
    expect(header & U_ORIGIN1).toBe(U_ORIGIN1);
    const coord = view.getInt16(4, true);
    expect(coord).toBe(64 * 8);
    // terminator
    expect(view.getUint16(msg.cursize - 2, true)).toBe(0);
  });

  test("an old entity absent from `to` is written as a U_REMOVE short", () => {
    const client = new ClientT();
    client.delta_sequence = 5;
    const fromFrame = client.frames[5 & UPDATE_MASK];
    fromFrame.entities.num_entities = 1;
    fromFrame.entities.entities[0].number = 21;

    const to = packOf([]); // entity 21 no longer present
    const msg = makeMsg();

    SV_EmitPacketEntities(client, to, msg);

    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.cursize);
    const removeShort = view.getUint16(2, true);
    expect(removeShort & 0x1ff).toBe(21);
    expect(removeShort & U_REMOVE).toBe(U_REMOVE);
  });

  test("MAX_PACKET_ENTITIES is the array's own capacity", () => {
    expect(new PacketEntitiesT().entities.length).toBe(MAX_PACKET_ENTITIES);
  });
});

//============================================================================
// sv_send.ts: SV_Multicast / SV_UpdateClientStats

describe("sv_send.ts: SV_Multicast", () => {
  beforeAll(() => {
    ensureDir(join(baseDir, "id1"));
    ensureDir(join(baseDir, "qw"));

    const bspBytes = buildBsp();
    writeGameFile(baseDir, "id1/maps/world.bsp", bspBytes);

    const popLmp = new Uint8Array(256);
    for (let i = 0; i < 128; i++) {
      popLmp[i * 2] = (pop[i] >> 8) & 0xff;
      popLmp[i * 2 + 1] = pop[i] & 0xff;
    }
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

    COM_InitArgv(["qwsv", "-basedir", baseDir]);
    COM_InitFilesystem();
    COM_CheckRegistered();
    Mod_Init();

    const mod = Mod_ForName("maps/world.bsp", true);
    if (mod === null) throw new Error("expected maps/world.bsp to load");
    sv.worldmodel = mod;
    sv.models[1] = mod;

    // SV_CalcPHS's own loop only ever reads worldmodel.leafs[0] (leaf 0, the
    // solid dummy leaf) for this 1-real-leaf fixture -- see this file's own
    // reasoning in the unit's report. Mod_LeafPVS(leafs[0], ...) always
    // returns the dedicated all-0xff `mod_novis` singleton, so sv.pvs ends
    // up fully populated and deterministic regardless of any other suite's
    // prior use of the shared decompression scratch buffer.
    SV_CalcPHS();
  });

  afterEach(() => {
    for (const cl of svs.clients) {
      cl.state = ClientStateT.cs_free;
      cl.edict = null;
      cl.datagram = new SizeBuf();
    }
  });

  afterAll(() => {
    sv.clear();
  });

  test("SV_CalcPHS produces the all-visible mod_novis row for this 1-leaf fixture", () => {
    expect(sv.pvs).not.toBeNull();
    expect(sv.phs).not.toBeNull();
    expect(Array.from(sv.pvs ?? new Uint8Array())).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(Array.from(sv.phs ?? new Uint8Array())).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  test("MULTICAST_ALL delivers sv.multicast's bytes to every spawned client's unreliable datagram", () => {
    const client = svs.clients[0];
    client.state = ClientStateT.cs_spawned;
    const edict = new QwEdictT(1, QW_ENTVARS_SIZE_WORDS);
    edict.v.origin[2] = 100; // front child of node 0 -> the one real (empty) leaf
    client.edict = edict;
    client.datagram.data = client.datagram_buf;
    client.datagram.maxsize = client.datagram_buf.length;
    client.datagram.cursize = 0;

    sv.multicast.data = new Uint8Array(64);
    sv.multicast.maxsize = 64;
    sv.multicast.cursize = 0;
    MSG_WriteByte(sv.multicast, 0xab);
    MSG_WriteByte(sv.multicast, 0xcd);

    SV_Multicast(vec3(0, 0, 100), MulticastT.MULTICAST_ALL);

    expect(Array.from(client.datagram.data.subarray(0, client.datagram.cursize))).toEqual([0xab, 0xcd]);
    expect(sv.multicast.cursize).toBe(0); // cleared after multicast, per SZ_Clear
  });

  test("a non-spawned client is skipped entirely", () => {
    const client = svs.clients[1];
    client.state = ClientStateT.cs_connected; // not cs_spawned
    client.datagram.data = client.datagram_buf;
    client.datagram.maxsize = client.datagram_buf.length;
    client.datagram.cursize = 0;

    sv.multicast.data = new Uint8Array(64);
    sv.multicast.maxsize = 64;
    sv.multicast.cursize = 0;
    MSG_WriteByte(sv.multicast, 0x11);

    SV_Multicast(vec3(0, 0, 100), MulticastT.MULTICAST_ALL);

    expect(client.datagram.cursize).toBe(0);
  });
});

describe("sv_send.ts: SV_UpdateClientStats", () => {
  beforeAll(() => {
    // minimal qwpr.global_struct/globals so SV_UpdateClientStats' `<<28`
    // serverflags read (and SV_ModelIndex(PR_GetString(weaponmodel))'s empty-
    // string fast path) both resolve without a full PR_LoadProgs fixture.
    const buf = new ArrayBuffer(QW_NUM_GLOBAL_WORDS * 4);
    const f = new Float32Array(buf);
    const i = new Int32Array(buf);
    qwpr.globals = { f, i };
    qwpr.global_struct = new QwGlobalVars(f, i);
    qwpr.strings = new Uint8Array([0]); // offset 0 == "" (weaponmodel defaults to 0)
  });

  afterAll(() => {
    qwpr.globals = null;
    qwpr.global_struct = null;
    qwpr.strings = null;
  });

  test("first call writes a delta for every nonzero stat; a repeat call with no changes writes nothing", () => {
    const client = makeClient();
    const edict = new QwEdictT(2, QW_ENTVARS_SIZE_WORDS);
    edict.v.health = 100;
    edict.v.ammo_shells = 25;
    client.edict = edict;

    SV_UpdateClientStats(client);

    expect(client.stats[STAT_HEALTH]).toBe(100);
    expect(client.stats[STAT_SHELLS]).toBe(25);
    expect(client.netchan.message.cursize).toBeGreaterThan(0);

    const firstCursize = client.netchan.message.cursize;

    // second call, nothing changed -> no new bytes written
    SV_UpdateClientStats(client);
    expect(client.netchan.message.cursize).toBe(firstCursize);
  });

  test("a changed stat after the baseline call writes exactly one svc_updatestat entry for it", () => {
    const client = makeClient();
    const edict = new QwEdictT(3, QW_ENTVARS_SIZE_WORDS);
    edict.v.health = 50;
    client.edict = edict;

    SV_UpdateClientStats(client); // establishes the baseline (client.stats[...] = 50)
    const baseline = client.netchan.message.cursize;

    edict.v.health = 75;
    SV_UpdateClientStats(client);

    expect(client.stats[STAT_HEALTH]).toBe(75);
    expect(client.netchan.message.cursize).toBeGreaterThan(baseline);
  });

  test("MAX_CL_STATS matches the stats array length", () => {
    const client = makeClient();
    expect(client.stats.length).toBe(MAX_CL_STATS);
  });
});
