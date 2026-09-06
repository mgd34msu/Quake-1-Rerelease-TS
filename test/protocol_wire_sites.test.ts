// Per-site byte vectors for every coordinate and angle that crosses the wire
// OUTSIDE the codec's own entity/baseline/static/sound/clientdata messages.
//
// The defect these pin: under PROTOCOL_RMQ's `PRFL_INT32COORD|PRFL_SHORTANGLE`
// (0x82) a coordinate is four bytes and an angle is two, but the seed's
// `MSG_WriteCoord`/`MSG_ReadCoord`/`MSG_WriteAngle`/`MSG_ReadAngle` are fixed
// at two and one. Any site that kept the fixed-width call desynced the whole
// stream from that byte on -- observed on e3m5 as two phantom `svc_setangle`
// messages followed by "Illegible server message".
//
// Sites covered, all against Ironwail's own threading of sv.protocolflags /
// cl.protocolflags:
//   svc_setangle          cl_parse.ts (read)      <- cl_parse.c:1183
//                         host_cmd.ts (write)     <- host_cmd.c:3159-3162
//                         sv_main.ts (write)      <- sv_main.c:1024
//   svc_particle          sv_main.ts (write)      <- sv_main.c:230-232
//                         r_part.ts (read)        <- r_part.c:202
//   svc_damage            sv_main.ts (write)      <- sv_main.c:1008
//                         view.ts (read)          <- view.c:296
//   svc_temp_entity       pr_cmds.ts PF_WriteCoord/PF_WriteAngle (write)
//                                                 <- pr_cmds.c:1573,1578
//                         cl_tent.ts (read)       <- cl_tent.c:68-247
//   clc_move viewangles   cl_input.ts (write)     <- cl_input.c:408-412
//                         sv_user.ts (read)       <- sv_user.c:451-455
//
// Group 1 proves protocol 15 keeps the seed's exact bytes at every one of them.
// Group 2 drives the real client parsers over hand-built 0x82 streams, with a
// negative control showing the pre-fix width would have desynced. Group 3 is
// the server->client round trip through the real functions.
//
// Self-sufficiency: `net_message`, `msgState`, `cl.protocol`/`protocolflags`,
// `sv.protocol`/`protocolflags`, `cl.viewentity`, `cl.viewangles`,
// `sv.datagram`, `svs.maxclients`/`clients` and `sysState.nostdout` are all
// snapshotted and restored. The PF_Write* group builds its own scratch basedir
// and is skipped without progs106/progs.dat.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { Mod_Init } from "../src/common/model";
import { HostError } from "../src/common/host";
import {
  MSG_BeginReading,
  MSG_ReadAngle,
  MSG_ReadAngleFlags,
  MSG_ReadCoord,
  MSG_ReadCoordFlags,
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteCoord,
  MSG_WriteFloat,
  MSG_WriteShort,
  SZ_Alloc,
  SZ_Clear,
  SizeBuf,
  msgState,
  net_message,
} from "../src/common/sizebuf";
import {
  PRFL_INT32COORD,
  PRFL_SHORTANGLE,
  PROTOCOL_FITZQUAKE,
  PROTOCOL_NETQUAKE,
  PROTOCOL_RMQ,
  SvcOpsT,
  TE_EXPLOSION2,
  TE_LAVASPLASH,
  TE_TELEPORT,
} from "../src/common/protocol";
import { nq15Codec } from "../src/common/protocol/nq15";
import { getCodec } from "../src/common/protocol/registry";
import { sysState } from "../src/platform/sys";
import { ClientT, UsercmdT, sv, svState, svs } from "../src/server/server";
import { SV_Init, SV_StartParticle } from "../src/server/sv_main";
import { SV_ReadClientMove } from "../src/server/sv_user";
import { cl, cls } from "../src/client/client";
import { CL_ParseServerMessage } from "../src/client/cl_parse";
import { EdictT, pr } from "../src/progs/progs";
import { ENTVARS_SIZE_WORDS } from "../src/progs/progdefs";
import { PR_LoadProgs } from "../src/progs/pr_edict";
import { pr_builtin } from "../src/progs/pr_cmds";
import { OFS_PARM0, OFS_PARM1 } from "../src/progs/pr_comp";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { HAVE_PROGS106, PROGS106_DAT } from "./support/fixture_availability";

const RMQ_FLAGS = PRFL_INT32COORD | PRFL_SHORTANGLE; // 0x82

//============================================================================
// saved singletons

const savedNostdout = sysState.nostdout;
const savedClProtocol = cl.protocol;
const savedClProtocolFlags = cl.protocolflags;
const savedClViewentity = cl.viewentity;
const savedClNumEntities = cl.num_entities;
const savedSvProtocol = sv.protocol;
const savedSvProtocolFlags = sv.protocolflags;
const savedSvTime = sv.time;
const savedMaxclients = svs.maxclients;
const savedClients = svs.clients;
const savedHostClient = svState.host_client;
const savedDemoplayback = cls.demoplayback;
const savedNetMessage = {
  data: net_message.data,
  maxsize: net_message.maxsize,
  cursize: net_message.cursize,
  allowoverflow: net_message.allowoverflow,
  overflowed: net_message.overflowed,
};
const savedNetBytes = net_message.data.slice(0, net_message.cursize);
const savedMsgState = { readcount: msgState.readcount, badread: msgState.badread };

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "protocol-wire-"));
const baseDir = join(scratchDir, "quake");

beforeAll(() => {
  sysState.nostdout = 1;
  if (!HAVE_PROGS106) return;

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  ensureDir(join(baseDir, "id1"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: new Uint8Array(readFileSync(PROGS106_DAT)) },
  ]);
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();
  PR_LoadProgs();
  SV_Init(); // points sv.datagram at sv.datagram_buf
});

afterAll(() => {
  sysState.nostdout = savedNostdout;
  cl.protocol = savedClProtocol;
  cl.protocolflags = savedClProtocolFlags;
  cl.viewentity = savedClViewentity;
  cl.num_entities = savedClNumEntities;
  sv.protocol = savedSvProtocol;
  sv.protocolflags = savedSvProtocolFlags;
  sv.time = savedSvTime;
  svs.maxclients = savedMaxclients;
  svs.clients = savedClients;
  svState.host_client = savedHostClient;
  cls.demoplayback = savedDemoplayback;
  net_message.data = savedNetMessage.data;
  net_message.maxsize = savedNetMessage.maxsize;
  net_message.cursize = savedNetMessage.cursize;
  net_message.allowoverflow = savedNetMessage.allowoverflow;
  net_message.overflowed = savedNetMessage.overflowed;
  net_message.data.set(savedNetBytes);
  msgState.readcount = savedMsgState.readcount;
  msgState.badread = savedMsgState.badread;
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================
// helpers

function buf(): SizeBuf {
  const sb = new SizeBuf();
  sb.data = new Uint8Array(512);
  sb.maxsize = sb.data.length;
  sb.cursize = 0;
  return sb;
}

function bytes(sb: SizeBuf): number[] {
  return Array.from(sb.data.subarray(0, sb.cursize));
}

// Fills net_message with `write`'s bytes and rewinds the reader, exactly as
// NET_GetMessage followed by MSG_BeginReading does on the receive path.
function buildMessage(write: (sb: SizeBuf) => void): void {
  SZ_Alloc(net_message, 2048);
  SZ_Clear(net_message);
  write(net_message);
  MSG_BeginReading();
}

// Puts the client on `protocol` and returns a writer that encodes coordinates
// and angles the way a server on that protocol would.
function asClient(protocol: number): { flags: number; coord(sb: SizeBuf, f: number): void; angle(sb: SizeBuf, f: number): void } {
  const codec = getCodec(protocol);
  const flags = codec.defaultFlags;
  cl.protocol = protocol;
  cl.protocolflags = flags;
  return {
    flags,
    coord: (sb, f) => codec.writeCoord(sb, f, flags),
    angle: (sb, f) => codec.writeAngle(sb, f, flags),
  };
}

//============================================================================

describe("protocol 15 keeps the seed's bytes at every newly-flagged site", () => {
  // The fix replaced fixed-width calls with flag-driven ones at ten sites.
  // Six are reads (cl_parse's svc_setangle, cl_tent's every TE_*, r_part's
  // svc_particle, view's svc_damage, sv_user's clc_move) and go through
  // MSG_ReadCoordFlags/MSG_ReadAngleFlags; four are writes (pr_cmds'
  // PF_WriteCoord/PF_WriteAngle, host_cmd's signon svc_setangle, cl_input's
  // clc_move) and go through the codec. These two tests are the proof that
  // none of them moved a protocol-15 byte.

  test("MSG_ReadCoordFlags(0) and MSG_ReadAngleFlags(0) are MSG_ReadCoord and MSG_ReadAngle", () => {
    // Every 16-bit pattern a coordinate can hold, and every byte an angle can.
    for (let raw = -32768; raw < 32768; raw += 7) {
      const sb = buf();
      MSG_WriteShort(sb, raw);
      MSG_WriteShort(sb, raw);
      buildMessage((m) => {
        m.data.set(sb.data.subarray(0, sb.cursize));
        m.cursize = sb.cursize;
      });
      const viaFlags = MSG_ReadCoordFlags(0);
      const viaPlain = MSG_ReadCoord();
      expect(viaFlags).toBe(viaPlain);
      expect(msgState.readcount).toBe(4); // two bytes each, not four
    }

    for (let raw = 0; raw < 256; raw++) {
      buildMessage((m) => {
        MSG_WriteByte(m, raw);
        MSG_WriteByte(m, raw);
      });
      expect(MSG_ReadAngleFlags(0)).toBe(MSG_ReadAngle());
      expect(msgState.readcount).toBe(2); // one byte each, not two
    }
  });

  test("nq15Codec.writeCoord/writeAngle are MSG_WriteCoord/MSG_WriteAngle", () => {
    // Includes the fractional values where Ironwail's rounding encoders would
    // differ from WinQuake's truncating ones (1.94 -> 15 vs 16).
    const values = [0, 1, -1, 0.5, -0.5, 1.9, 1.94, -1.94, 16, -32, 64, 4095.875, -4096, 90, 180, 270, 359.9, -90];
    for (const v of values) {
      const a = buf();
      nq15Codec.writeCoord(a, v, 0);
      const b = buf();
      MSG_WriteCoord(b, v);
      expect(bytes(a)).toEqual(bytes(b));
      expect(a.cursize).toBe(2);

      const c = buf();
      nq15Codec.writeAngle(c, v, 0);
      const d = buf();
      MSG_WriteAngle(d, v);
      expect(bytes(c)).toEqual(bytes(d));
      expect(c.cursize).toBe(1);
    }
  });
});

describe("svc_setangle under flags 0x82", () => {
  // The reported e3m5 crash. Under PRFL_SHORTANGLE the server writes three
  // shorts (six bytes); the seed's client read three chars (three bytes) and
  // resumed inside the payload, which is how a phantom second svc_setangle at
  // +4 and then an illegible opcode at +8 appeared in the cl_shownet trace.

  test("a 999 svc_setangle is seven bytes and parses to completion", () => {
    const w = asClient(PROTOCOL_RMQ);
    expect(w.flags).toBe(0x82);

    buildMessage((m) => {
      MSG_WriteByte(m, SvcOpsT.svc_setangle);
      w.angle(m, 45);
      w.angle(m, 90);
      w.angle(m, -135);
    });
    // 1 opcode + 3 * 2 (PRFL_SHORTANGLE)
    expect(net_message.cursize).toBe(7);

    CL_ParseServerMessage();

    // The whole message was consumed: had the reader taken three bytes, byte 4
    // would have been read as another opcode.
    expect(msgState.readcount).toBe(7);
    expect(cl.viewangles[0]).toBeCloseTo(45, 2);
    expect(cl.viewangles[1]).toBeCloseTo(90, 2);
    expect(cl.viewangles[2]).toBeCloseTo(-135, 2);
  });

  test("the same message read at protocol 15's width desyncs -- the pre-fix behavior", () => {
    // Negative control: it is the READER's width that was wrong, so pointing a
    // protocol-15 client at a 999 stream reproduces the original failure.
    const rmq = getCodec(PROTOCOL_RMQ);
    buildMessage((m) => {
      MSG_WriteByte(m, SvcOpsT.svc_setangle);
      rmq.writeAngle(m, 45, RMQ_FLAGS);
      rmq.writeAngle(m, 90, RMQ_FLAGS);
      rmq.writeAngle(m, -135, RMQ_FLAGS);
    });

    cl.protocol = PROTOCOL_NETQUAKE;
    cl.protocolflags = 0;
    let threw: unknown = null;
    try {
      CL_ParseServerMessage();
    } catch (e) {
      threw = e;
    }
    // Either it throws (illegible opcode) or it stops short of the payload --
    // both are the desync this unit fixed. It must NOT consume all seven
    // bytes and produce the right angles.
    const consumedAll = threw === null && msgState.readcount === 7;
    expect(consumedAll).toBe(false);
    if (threw !== null) expect(threw instanceof HostError).toBe(true);
  });

  test("protocol 15 and 666 keep the one-byte angle", () => {
    for (const protocol of [PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE]) {
      const w = asClient(protocol);
      expect(w.flags).toBe(0);
      buildMessage((m) => {
        MSG_WriteByte(m, SvcOpsT.svc_setangle);
        w.angle(m, 45);
        w.angle(m, 90);
        w.angle(m, 180);
      });
      expect(net_message.cursize).toBe(4); // 1 + 3 * 1

      CL_ParseServerMessage();
      expect(msgState.readcount).toBe(4);
      expect(Math.abs(cl.viewangles[0] - 45)).toBeLessThan(360 / 256);
      expect(Math.abs(cl.viewangles[1] - 90)).toBeLessThan(360 / 256);
    }
  });
});

describe("svc_particle under flags 0x82", () => {
  test("a 999 svc_particle is eighteen bytes and r_part reads all of them", () => {
    const w = asClient(PROTOCOL_RMQ);
    buildMessage((m) => {
      MSG_WriteByte(m, SvcOpsT.svc_particle);
      w.coord(m, 128); // origin
      w.coord(m, -64);
      w.coord(m, 32);
      MSG_WriteChar(m, 16); // dir * 16
      MSG_WriteChar(m, -16);
      MSG_WriteChar(m, 0);
      MSG_WriteByte(m, 10); // count
      MSG_WriteByte(m, 73); // color
    });
    // 1 opcode + 3 * 4 (PRFL_INT32COORD) + 3 + 1 + 1
    expect(net_message.cursize).toBe(18);

    CL_ParseServerMessage();
    expect(msgState.readcount).toBe(18);
  });

  test("protocol 15's svc_particle stays twelve bytes", () => {
    const w = asClient(PROTOCOL_NETQUAKE);
    buildMessage((m) => {
      MSG_WriteByte(m, SvcOpsT.svc_particle);
      w.coord(m, 128);
      w.coord(m, -64);
      w.coord(m, 32);
      MSG_WriteChar(m, 16);
      MSG_WriteChar(m, -16);
      MSG_WriteChar(m, 0);
      MSG_WriteByte(m, 10);
      MSG_WriteByte(m, 73);
    });
    expect(net_message.cursize).toBe(12); // 1 + 3 * 2 + 3 + 1 + 1
    CL_ParseServerMessage();
    expect(msgState.readcount).toBe(12);
  });
});

describe("svc_damage under flags 0x82", () => {
  test("a 999 svc_damage is fifteen bytes and view.ts reads all of them", () => {
    const w = asClient(PROTOCOL_RMQ);
    cl.viewentity = 0; // cl_entities[0] always exists
    buildMessage((m) => {
      MSG_WriteByte(m, SvcOpsT.svc_damage);
      MSG_WriteByte(m, 10); // armor
      MSG_WriteByte(m, 20); // blood
      w.coord(m, 256); // inflictor origin
      w.coord(m, -128);
      w.coord(m, 64);
    });
    // 1 opcode + 2 + 3 * 4
    expect(net_message.cursize).toBe(15);

    CL_ParseServerMessage();
    expect(msgState.readcount).toBe(15);
  });

  test("protocol 15's svc_damage stays nine bytes", () => {
    const w = asClient(PROTOCOL_NETQUAKE);
    cl.viewentity = 0;
    buildMessage((m) => {
      MSG_WriteByte(m, SvcOpsT.svc_damage);
      MSG_WriteByte(m, 10);
      MSG_WriteByte(m, 20);
      w.coord(m, 256);
      w.coord(m, -128);
      w.coord(m, 64);
    });
    expect(net_message.cursize).toBe(9); // 1 + 2 + 3 * 2
    CL_ParseServerMessage();
    expect(msgState.readcount).toBe(9);
  });
});

describe("svc_temp_entity under flags 0x82", () => {
  // TE_LAVASPLASH / TE_TELEPORT are one position and nothing else;
  // TE_EXPLOSION2 adds two bytes. All three go through cl_tent.ts's coord
  // reads, which is the same code path every other TE_* uses.
  const cases: Array<{ name: string; te: number; extra: number }> = [
    { name: "TE_LAVASPLASH", te: TE_LAVASPLASH, extra: 0 },
    { name: "TE_TELEPORT", te: TE_TELEPORT, extra: 0 },
    { name: "TE_EXPLOSION2", te: TE_EXPLOSION2, extra: 2 },
  ];

  for (const c of cases) {
    test(`${c.name} reads a 4-byte coordinate on 999 and a 2-byte one on 15`, () => {
      for (const protocol of [PROTOCOL_RMQ, PROTOCOL_NETQUAKE]) {
        const w = asClient(protocol);
        const coordSize = protocol === PROTOCOL_RMQ ? 4 : 2;
        buildMessage((m) => {
          MSG_WriteByte(m, SvcOpsT.svc_temp_entity);
          MSG_WriteByte(m, c.te);
          w.coord(m, 512);
          w.coord(m, -256);
          w.coord(m, 128);
          for (let i = 0; i < c.extra; i++) MSG_WriteByte(m, 0);
        });
        expect(net_message.cursize).toBe(2 + 3 * coordSize + c.extra);

        CL_ParseServerMessage();
        expect(msgState.readcount).toBe(net_message.cursize);
      }
    });
  }
});

describe("clc_move's viewangles", () => {
  // Ironwail cl_input.c:408-412 / sv_user.c:451-455: the test is on the
  // PROTOCOL, not the flag word -- 666 and 999 always send a 16-bit angle
  // here, whether or not PRFL_SHORTANGLE is set.
  function readMove(protocol: number, angles: readonly [number, number, number]): { angle: number[]; consumed: number } {
    const client = new ClientT();
    const player = new EdictT(1, ENTVARS_SIZE_WORDS);
    client.edict = player;
    svState.host_client = client;
    sv.protocol = protocol;
    sv.protocolflags = getCodec(protocol).defaultFlags;
    sv.time = 10;

    buildMessage((m) => {
      MSG_WriteFloat(m, 3);
      for (const a of angles) {
        if (protocol === PROTOCOL_NETQUAKE) MSG_WriteAngle(m, a);
        else {
          // MSG_WriteAngle16, spelled out: Q_rint(f * 65536 / 360) & 65535
          MSG_WriteShort(m, Math.trunc((a * 65536.0) / 360.0 + (a > 0 ? 0.5 : -0.5)) & 65535);
        }
      }
      MSG_WriteShort(m, 100);
      MSG_WriteShort(m, -50);
      MSG_WriteShort(m, 5);
      MSG_WriteByte(m, 0);
      MSG_WriteByte(m, 0);
    });

    const move = new UsercmdT();
    SV_ReadClientMove(move);
    return { angle: [player.v.v_angle[0], player.v.v_angle[1], player.v.v_angle[2]], consumed: msgState.readcount };
  }

  test("protocol 15 reads three one-byte angles", () => {
    const r = readMove(PROTOCOL_NETQUAKE, [0, 90, 0]);
    // 4 (ping float) + 3 * 1 + 3 * 2 + 1 + 1
    expect(r.consumed).toBe(15);
    expect(r.angle[1]).toBeCloseTo(90, 5);
  });

  test("666 and 999 read three two-byte angles", () => {
    for (const protocol of [PROTOCOL_FITZQUAKE, PROTOCOL_RMQ]) {
      const r = readMove(protocol, [10, 90, -45]);
      // 4 + 3 * 2 + 3 * 2 + 1 + 1
      expect(r.consumed).toBe(18);
      expect(r.angle[0]).toBeCloseTo(10, 2);
      expect(r.angle[1]).toBeCloseTo(90, 2);
      expect(r.angle[2]).toBeCloseTo(-45, 2);
    }
  });

  test("a 16-bit angle survives a full precision round trip that a byte cannot", () => {
    // 10.008 degrees is inside one 16-bit step (360/65536 = 0.0055) but not
    // one 8-bit step (360/256 = 1.4).
    const wide = readMove(PROTOCOL_RMQ, [10.008, 0, 0]);
    expect(Math.abs(wide.angle[0] - 10.008)).toBeLessThan(360 / 65536);

    const narrow = readMove(PROTOCOL_NETQUAKE, [10.008, 0, 0]);
    expect(Math.abs(narrow.angle[0] - 10.008)).toBeGreaterThan(360 / 65536);
  });
});

describe("SV_StartParticle writes what r_part reads", () => {
  test("server to client round trip at 15, 666 and 999", () => {
    for (const protocol of [PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ]) {
      sv.protocol = protocol;
      sv.protocolflags = getCodec(protocol).defaultFlags;
      sv.datagram.maxsize = sv.datagram_buf.length;
      sv.datagram.data = sv.datagram_buf;
      SZ_Clear(sv.datagram);

      const org = new Float32Array([128, -64, 32]);
      const dir = new Float32Array([1, -1, 0]);
      SV_StartParticle(org, dir, 73, 10);

      const coordSize = protocol === PROTOCOL_RMQ ? 4 : 2;
      expect(sv.datagram.cursize).toBe(1 + 3 * coordSize + 3 + 1 + 1);

      // ...and the client, on the same protocol, consumes exactly that.
      asClient(protocol);
      buildMessage((m) => {
        m.data.set(sv.datagram.data.subarray(0, sv.datagram.cursize));
        m.cursize = sv.datagram.cursize;
      });
      CL_ParseServerMessage();
      expect(msgState.readcount).toBe(sv.datagram.cursize);
    }
  });
});

describe.skipIf(!HAVE_PROGS106)("PF_WriteCoord and PF_WriteAngle", () => {
  // Every WinQuake svc_temp_entity payload is built in QuakeC through these
  // two builtins, so they are the write half of the cl_tent.ts read sites.
  const coordIndex = pr_builtin.findIndex((f) => f.name === "PF_WriteCoord");
  const angleIndex = pr_builtin.findIndex((f) => f.name === "PF_WriteAngle");

  function callWrite(index: number, value: number): number[] {
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");
    globals.f[OFS_PARM0] = 0; // MSG_BROADCAST -> sv.datagram
    globals.f[OFS_PARM1] = value;
    sv.datagram.maxsize = sv.datagram_buf.length;
    sv.datagram.data = sv.datagram_buf;
    SZ_Clear(sv.datagram);
    pr_builtin[index]();
    return Array.from(sv.datagram.data.subarray(0, sv.datagram.cursize));
  }

  test("the builtin table holds both", () => {
    expect(coordIndex).toBeGreaterThan(0);
    expect(angleIndex).toBe(coordIndex + 1); // WriteCoord then WriteAngle
  });

  test("protocol 15 writes two bytes for a coordinate and one for an angle", () => {
    sv.protocol = PROTOCOL_NETQUAKE;
    sv.protocolflags = 0;
    // (int)(64 * 8) = 512 -> 00 02
    expect(callWrite(coordIndex, 64)).toEqual([0x00, 0x02]);
    // ((int)90 * 256) / 360 = 64 -> 40
    expect(callWrite(angleIndex, 90)).toEqual([0x40]);
  });

  test("666 keeps the same widths but rounds the coordinate", () => {
    sv.protocol = PROTOCOL_FITZQUAKE;
    sv.protocolflags = 0;
    expect(callWrite(coordIndex, 64)).toEqual([0x00, 0x02]);
    // Q_rint(1.94 * 8) = Q_rint(15.52) = 16 -> 10 00, where 15 truncates to 15
    expect(callWrite(coordIndex, 1.94)).toEqual([0x10, 0x00]);
    expect(callWrite(angleIndex, 90)).toEqual([0x40]);
  });

  test("999 writes four bytes for a coordinate and two for an angle", () => {
    sv.protocol = PROTOCOL_RMQ;
    sv.protocolflags = RMQ_FLAGS;
    // Q_rint(64 * 16) = 1024 -> 00 04 00 00
    expect(callWrite(coordIndex, 64)).toEqual([0x00, 0x04, 0x00, 0x00]);
    // Q_rint(-32 * 16) = -512 -> 00 FE FF FF
    expect(callWrite(coordIndex, -32)).toEqual([0x00, 0xfe, 0xff, 0xff]);
    // Q_rint(90 * 65536 / 360) = 16384 -> 00 40
    expect(callWrite(angleIndex, 90)).toEqual([0x00, 0x40]);
  });

  test("a QuakeC-built TE_TELEPORT round-trips through cl_tent at 999", () => {
    sv.protocol = PROTOCOL_RMQ;
    sv.protocolflags = RMQ_FLAGS;
    sv.datagram.maxsize = sv.datagram_buf.length;
    sv.datagram.data = sv.datagram_buf;
    SZ_Clear(sv.datagram);

    // What the QuakeC does: WriteByte(svc_temp_entity), WriteByte(TE_TELEPORT),
    // WriteCoord x3 -- the last three through the builtin under test.
    MSG_WriteByte(sv.datagram, SvcOpsT.svc_temp_entity);
    MSG_WriteByte(sv.datagram, TE_TELEPORT);
    const globals = pr.globals;
    if (globals === null) throw new Error("pr.globals not set");
    for (const v of [512, -256, 128]) {
      globals.f[OFS_PARM0] = 0;
      globals.f[OFS_PARM1] = v;
      pr_builtin[coordIndex]();
    }
    expect(sv.datagram.cursize).toBe(2 + 3 * 4);

    asClient(PROTOCOL_RMQ);
    buildMessage((m) => {
      m.data.set(sv.datagram.data.subarray(0, sv.datagram.cursize));
      m.cursize = sv.datagram.cursize;
    });
    CL_ParseServerMessage();
    expect(msgState.readcount).toBe(14);
  });
});
