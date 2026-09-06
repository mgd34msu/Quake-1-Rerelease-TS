// Byte vectors for the three NetQuake protocol codecs (src/common/protocol/
// nq15.ts, fitz666.ts, rmq999.ts), plus round-trips back through each codec's
// read side.
//
// Every expected byte string below is derived BY HAND from Ironwail's own
// encoders -- Quake/sv_main.c (SV_WriteEntitiesToClient, SV_CreateBaseline,
// SV_WriteClientdataToMessage, SV_StartSound), Quake/pr_cmds.c (PF_makestatic,
// PF_ambientsound) and Quake/common.c:762-809 (MSG_WriteCoord/MSG_WriteAngle by
// protocol flags) -- and the derivation is written out beside it. Nothing here
// is a snapshot of what this engine happens to emit.
//
// Self-sufficiency: the only shared singleton these suites touch is
// `net_message` (the read side reads through it, exactly as the C's MSG_Read*
// do). Its fields and bytes are snapshotted in beforeAll and restored in
// afterAll. No cvar, no cl/cls/sv/svs, no renderer, no builtin table.

import { describe, expect, test, afterAll } from "bun:test";
import { MSG_BeginReading, SizeBuf, net_message, msgState } from "../src/common/sizebuf";
import { EntityStateT } from "../src/common/quakedef";
import { vec3 } from "../src/common/mathlib";
import {
  ENTALPHA_DEFAULT,
  ENTSCALE_DEFAULT,
  PRFL_INT32COORD,
  PRFL_SHORTANGLE,
  PROTOCOL_FITZQUAKE,
  PROTOCOL_NETQUAKE,
  PROTOCOL_RMQ,
  SND_ATTENUATION,
  SND_LARGEENTITY,
  SND_LARGESOUND,
  SND_VOLUME,
} from "../src/common/protocol";
import { ClientdataT, ClientdataTailT, EntityUpdateT, EntityUpdateTailT, SoundHeaderT, SoundMessageT } from "../src/common/protocol/codec";
import { getCodec, nq15Codec, fitz666Codec, rmq999Codec, protocolSupported, PROTOCOLS } from "../src/common/protocol/registry";
import { RMQ_DEFAULT_FLAGS } from "../src/common/protocol/rmq999";

const savedNetMessage = {
  data: net_message.data,
  maxsize: net_message.maxsize,
  cursize: net_message.cursize,
  allowoverflow: net_message.allowoverflow,
  overflowed: net_message.overflowed,
};
const savedNetBytes = net_message.data.slice(0, net_message.cursize);
const savedMsgState = { readcount: msgState.readcount, badread: msgState.badread };

afterAll(() => {
  net_message.data = savedNetMessage.data;
  net_message.maxsize = savedNetMessage.maxsize;
  net_message.cursize = savedNetMessage.cursize;
  net_message.allowoverflow = savedNetMessage.allowoverflow;
  net_message.overflowed = savedNetMessage.overflowed;
  net_message.data.set(savedNetBytes);
  msgState.readcount = savedMsgState.readcount;
  msgState.badread = savedMsgState.badread;
});

// A fresh write buffer per call, so no test can see another's bytes.
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

// Points net_message at `data` and rewinds the reader, the way NET_GetMessage
// followed by MSG_BeginReading does on the real receive path.
function readFrom(data: number[]): void {
  net_message.data = new Uint8Array(data);
  net_message.maxsize = data.length;
  net_message.cursize = data.length;
  MSG_BeginReading();
}

const RMQ_FLAGS = RMQ_DEFAULT_FLAGS; // PRFL_INT32COORD | PRFL_SHORTANGLE

describe("the codec registry", () => {
  test("maps each protocol number to its codec and rejects everything else", () => {
    expect(PROTOCOLS).toEqual([PROTOCOL_NETQUAKE, PROTOCOL_FITZQUAKE, PROTOCOL_RMQ]);
    expect(getCodec(PROTOCOL_NETQUAKE)).toBe(nq15Codec);
    expect(getCodec(PROTOCOL_FITZQUAKE)).toBe(fitz666Codec);
    expect(getCodec(PROTOCOL_RMQ)).toBe(rmq999Codec);

    expect(protocolSupported(15)).toBe(true);
    expect(protocolSupported(666)).toBe(true);
    expect(protocolSupported(999)).toBe(true);
    expect(protocolSupported(16)).toBe(false);
    expect(protocolSupported(28)).toBe(false); // QuakeWorld is a separate track
  });

  test("each codec reports its own wire sizes", () => {
    // WinQuake quakedef.h:97-98 and its byte-indexed precache tables.
    expect(nq15Codec.maxMsglen).toBe(8000);
    expect(nq15Codec.maxDatagram).toBe(1024);
    expect(nq15Codec.maxPrecache).toBe(256);
    expect(nq15Codec.defaultFlags).toBe(0);

    // Ironwail quakedef.h:97-98.
    expect(fitz666Codec.maxMsglen).toBe(64000);
    expect(fitz666Codec.maxDatagram).toBe(64000);
    expect(fitz666Codec.defaultFlags).toBe(0);

    expect(rmq999Codec.maxMsglen).toBe(64000);
    // Ironwail sv_main.c:1962: sv.protocolflags = PRFL_INT32COORD | PRFL_SHORTANGLE
    expect(rmq999Codec.defaultFlags).toBe(PRFL_INT32COORD | PRFL_SHORTANGLE);
    expect(rmq999Codec.defaultFlags).toBe(0x82);
  });
});

describe("coordinates and angles", () => {
  test("protocol 15 writes WinQuake's 13.3 fixed point with truncation", () => {
    // WinQuake common.c: MSG_WriteCoord -> MSG_WriteShort ((int)(f*8)).
    //   64.0   -> (int)512.0  = 512    -> 0x0200 little endian -> 00 02
    //   -32.0  -> (int)-256.0 = -256   -> 0xFF00 little endian -> 00 FF
    //   1.9    -> (int)15.2   = 15     -> 0x000F                -> 0F 00
    // MSG_WriteAngle -> MSG_WriteByte (((int)f*256/360) & 255), all integer:
    //   90.0   -> ((int)90 * 256)/360 = 23040/360 = 64          -> 40
    //   -90.0  -> (-23040)/360 = -64, & 255                     -> C0
    let sb = buf();
    nq15Codec.writeCoord(sb, 64.0, 0);
    nq15Codec.writeCoord(sb, -32.0, 0);
    nq15Codec.writeCoord(sb, 1.9, 0);
    expect(bytes(sb)).toEqual([0x00, 0x02, 0x00, 0xff, 0x0f, 0x00]);

    sb = buf();
    nq15Codec.writeAngle(sb, 90.0, 0);
    nq15Codec.writeAngle(sb, -90.0, 0);
    expect(bytes(sb)).toEqual([0x40, 0xc0]);
  });

  test("protocol 666 writes the same 13.3 fixed point but rounds", () => {
    // Ironwail common.c:762: MSG_WriteCoord16 -> MSG_WriteShort (Q_rint(f*8)).
    //   64.0 -> Q_rint(512.0) = 512 -> 00 02  (identical to 15)
    //   1.9  -> Q_rint(15.2)  = 15  -> 0F 00  (identical here; 1.94 would not be)
    //   1.94 -> Q_rint(15.52) = 16  -> 10 00, where 15 truncates to 15
    let sb = buf();
    fitz666Codec.writeCoord(sb, 64.0, 0);
    fitz666Codec.writeCoord(sb, 1.9, 0);
    fitz666Codec.writeCoord(sb, 1.94, 0);
    expect(bytes(sb)).toEqual([0x00, 0x02, 0x0f, 0x00, 0x10, 0x00]);

    sb = buf();
    nq15Codec.writeCoord(sb, 1.94, 0);
    expect(bytes(sb)).toEqual([0x0f, 0x00]); // (int)15.52 = 15

    // Ironwail common.c:790: MSG_WriteByte (Q_rint(f * 256.0 / 360.0) & 255).
    //   90.0 -> Q_rint(64.0) = 64 -> 40
    sb = buf();
    fitz666Codec.writeAngle(sb, 90.0, 0);
    expect(bytes(sb)).toEqual([0x40]);
  });

  test("protocol 999 with PRFL_INT32COORD|PRFL_SHORTANGLE writes 32-bit 16ths and 16-bit angles", () => {
    // Ironwail common.c:783: MSG_WriteLong (Q_rint (f * 16)).
    //   64.0   -> 1024   -> 00 04 00 00
    //   -32.0  -> -512   -> 0xFFFFFE00 little endian -> 00 FE FF FF
    //   8192.0 -> 131072 -> 0x00020000 little endian -> 00 00 02 00
    //            (8192 is outside protocol 15's +-4096 reach, which is why
    //             `sv_protocol auto` picks 999 for a map this large)
    let sb = buf();
    rmq999Codec.writeCoord(sb, 64.0, RMQ_FLAGS);
    rmq999Codec.writeCoord(sb, -32.0, RMQ_FLAGS);
    rmq999Codec.writeCoord(sb, 8192.0, RMQ_FLAGS);
    expect(bytes(sb)).toEqual([0x00, 0x04, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xff, 0x00, 0x00, 0x02, 0x00]);

    // Ironwail common.c:795: MSG_WriteShort (Q_rint(f * 65536.0 / 360.0) & 65535).
    //   90.0 -> Q_rint(16384.0) = 16384 -> 0x4000 -> 00 40
    //   1.0  -> Q_rint(182.044) = 182   -> 0x00B6 -> B6 00
    sb = buf();
    rmq999Codec.writeAngle(sb, 90.0, RMQ_FLAGS);
    rmq999Codec.writeAngle(sb, 1.0, RMQ_FLAGS);
    expect(bytes(sb)).toEqual([0x00, 0x40, 0xb6, 0x00]);
  });

  test("every flag combination round-trips through its own reader", () => {
    for (const flags of [0, PRFL_SHORTANGLE, PRFL_INT32COORD, PRFL_INT32COORD | PRFL_SHORTANGLE]) {
      const sb = buf();
      rmq999Codec.writeCoord(sb, 1234.5, flags);
      rmq999Codec.writeAngle(sb, 90.0, flags);
      readFrom(bytes(sb));
      // 13.3 fixed point resolves to 1/8, INT32COORD to 1/16.
      expect(rmq999Codec.readCoord(flags)).toBeCloseTo(1234.5, 2);
      expect(rmq999Codec.readAngle(flags)).toBeCloseTo(90.0, 1);
    }
  });
});

describe("svc_serverinfo's protocol field", () => {
  test("15 and 666 write the number alone; 999 follows it with the flag word", () => {
    // Ironwail sv_main.c:417-420.
    let sb = buf();
    nq15Codec.writeProtocol(sb, 0);
    expect(bytes(sb)).toEqual([15, 0, 0, 0]); // MSG_WriteLong(15)

    sb = buf();
    fitz666Codec.writeProtocol(sb, 0);
    expect(bytes(sb)).toEqual([0x9a, 0x02, 0x00, 0x00]); // 666 = 0x29A

    sb = buf();
    rmq999Codec.writeProtocol(sb, RMQ_FLAGS);
    // 999 = 0x3E7, then 0x82 = PRFL_INT32COORD|PRFL_SHORTANGLE
    expect(bytes(sb)).toEqual([0xe7, 0x03, 0x00, 0x00, 0x82, 0x00, 0x00, 0x00]);

    // The client reads the flag word back only on 999.
    readFrom([0x82, 0x00, 0x00, 0x00]);
    expect(rmq999Codec.readProtocolFlags()).toBe(0x82);
    readFrom([0x82, 0x00, 0x00, 0x00]);
    expect(fitz666Codec.readProtocolFlags()).toBe(0);
    readFrom([0x82, 0x00, 0x00, 0x00]);
    expect(nq15Codec.readProtocolFlags()).toBe(0);
  });
});

// A plain entity: a model index and frame that fit in a byte, no alpha, no
// scale, one non-baseline angle, three non-baseline origins.
function plainUpdate(): EntityUpdateT {
  const u = new EntityUpdateT();
  u.origin[0] = 64;
  u.origin[1] = -32;
  u.origin[2] = 16;
  u.angles[0] = 0;
  u.angles[1] = 90;
  u.angles[2] = 0;
  u.modelindex = 5;
  u.frame = 3;
  u.colormap = 0;
  u.skin = 0;
  u.effects = 0;
  u.movetypeStep = false;
  u.sendinterval = false;
  u.baseline = new EntityStateT(); // all zero, alpha 0, scale 16
  return u;
}

describe("entity updates", () => {
  test("a plain entity encodes identically under 15 and 666", () => {
    // bits, from SV_WriteEntitiesToClient:
    //   origin[0..2] all differ from the baseline's 0 by > 0.1
    //                                  -> U_ORIGIN1|U_ORIGIN2|U_ORIGIN3 = 0x000E
    //   angles[1] 90 != baseline 0     -> U_ANGLE2                      = 0x0010
    //   frame 3 != baseline 0          -> U_FRAME                       = 0x0040
    //   modelindex 5 != baseline 0     -> U_MODEL                       = 0x0400
    //   colormap/skin/effects all match the baseline; movetype is not STEP
    //   666 adds nothing: alpha 0 == baseline 0, scale 16 == baseline 16,
    //   frame & 0xFF00 == 0, modelindex & 0xFF00 == 0, no send interval
    //   subtotal 0x045E; >= 256 so U_MOREBITS                            = 0x0001
    //   entity number 1 < 256, so no U_LONGENTITY
    //   bits = 0x045F
    // bytes:
    //   (bits | U_SIGNAL) & 0xFF = 0x5F | 0x80 = 0xDF
    //   U_MOREBITS: bits >> 8    = 0x04
    //   entity byte              = 0x01
    //   U_MODEL byte 5           = 0x05
    //   U_FRAME byte 3           = 0x03
    //   U_ORIGIN1 coord 64       = 00 02   ((int)(64*8) = 512)
    //   (U_ANGLE1 not set)
    //   U_ORIGIN2 coord -32      = 00 FF   ((int)(-32*8) = -256)
    //   U_ANGLE2  angle 90       = 40
    //   U_ORIGIN3 coord 16       = 80 00   ((int)(16*8) = 128)
    const expected = [0xdf, 0x04, 0x01, 0x05, 0x03, 0x00, 0x02, 0x00, 0xff, 0x40, 0x80, 0x00];

    const a = buf();
    nq15Codec.writeEntityUpdate(a, 1, plainUpdate(), 0);
    expect(bytes(a)).toEqual(expected);

    // 666 rounds instead of truncating, but every value here is exact, and
    // none of its extra bits apply -- so the bytes are the same.
    const b = buf();
    fitz666Codec.writeEntityUpdate(b, 1, plainUpdate(), 0);
    expect(bytes(b)).toEqual(expected);
  });

  test("the same entity under 999 widens only its coordinates and angles", () => {
    //   header/bits are identical (0x045F): DF 04 01 05 03
    //   U_ORIGIN1 coord 64  -> Q_rint(64*16)  = 1024  -> 00 04 00 00
    //   U_ORIGIN2 coord -32 -> Q_rint(-32*16) = -512  -> 00 FE FF FF
    //   U_ANGLE2  angle 90  -> Q_rint(90*65536/360) = 16384 -> 00 40
    //   U_ORIGIN3 coord 16  -> Q_rint(16*16)  = 256   -> 00 01 00 00
    const sb = buf();
    rmq999Codec.writeEntityUpdate(sb, 1, plainUpdate(), RMQ_FLAGS);
    expect(bytes(sb)).toEqual([
      0xdf, 0x04, 0x01, 0x05, 0x03,
      0x00, 0x04, 0x00, 0x00,
      0x00, 0xfe, 0xff, 0xff,
      0x00, 0x40,
      0x00, 0x01, 0x00, 0x00,
    ]);
  });

  test("666 carries a 16-bit model and frame, alpha, scale and a long entity number", () => {
    const u = new EntityUpdateT();
    u.modelindex = 261; // 0x0105
    u.frame = 258; // 0x0102
    u.alpha = 200;
    u.scale = 32;
    u.baseline = new EntityStateT(); // modelindex 0, frame 0, alpha 0, scale 16

    // bits:
    //   frame 258 != 0                 -> U_FRAME     = 0x000040
    //   modelindex 261 != 0            -> U_MODEL     = 0x000400
    //   alpha 200 != baseline 0        -> U_ALPHA     = 0x010000
    //   scale 32 != baseline 16        -> U_SCALE     = 0x100000
    //   U_FRAME set and 258 & 0xFF00   -> U_FRAME2    = 0x020000
    //   U_MODEL set and 261 & 0xFF00   -> U_MODEL2    = 0x040000
    //   subtotal 0x170440; >= 65536    -> U_EXTEND1   = 0x008000
    //   not >= 16777216, so no U_EXTEND2
    //   entity 300 >= 256              -> U_LONGENTITY= 0x004000
    //   subtotal >= 256                -> U_MOREBITS  = 0x000001
    //   bits = 0x17C441
    // bytes:
    //   (bits | U_SIGNAL) & 0xFF = 0x41 | 0x80 = 0xC1
    //   U_MOREBITS  bits >> 8  & 0xFF = 0xC4
    //   U_EXTEND1   bits >> 16 & 0xFF = 0x17
    //   U_LONGENTITY short 300        = 2C 01
    //   U_MODEL  byte 261 & 0xFF      = 05
    //   U_FRAME  byte 258 & 0xFF      = 02
    //   U_ALPHA  byte 200             = C8
    //   U_SCALE  byte 32              = 20
    //   U_FRAME2 byte 258 >> 8        = 01
    //   U_MODEL2 byte 261 >> 8        = 01
    const expected = [0xc1, 0xc4, 0x17, 0x2c, 0x01, 0x05, 0x02, 0xc8, 0x20, 0x01, 0x01];

    const a = buf();
    fitz666Codec.writeEntityUpdate(a, 300, u, 0);
    expect(bytes(a)).toEqual(expected);

    // No coordinate or angle is sent here, so 999 emits the same bytes.
    const b = buf();
    rmq999Codec.writeEntityUpdate(b, 300, u, RMQ_FLAGS);
    expect(bytes(b)).toEqual(expected);
  });

  test("666 sends U_LERPFINISH as the think interval scaled to 0-255", () => {
    const u = new EntityUpdateT();
    u.baseline = new EntityStateT();
    u.sendinterval = true;
    u.lerpfinish = 0.2; // 0.2s to the next think

    // bits: U_LERPFINISH = 0x080000, >= 65536 -> U_EXTEND1 = 0x008000,
    //       >= 256 -> U_MOREBITS = 0x000001. bits = 0x088001.
    // bytes: (0x01 | 0x80) = 0x81, bits>>8 = 0x80, bits>>16 = 0x08,
    //        entity byte 7, then Q_rint(0.2 * 255) = Q_rint(51) = 51 = 0x33
    const sb = buf();
    fitz666Codec.writeEntityUpdate(sb, 7, u, 0);
    expect(bytes(sb)).toEqual([0x81, 0x80, 0x08, 0x07, 0x33]);
  });

  test("protocol 15 never emits an extend byte, whatever alpha and scale hold", () => {
    const u = plainUpdate();
    u.alpha = 200; // nq15 ignores both
    u.scale = 32;
    const sb = buf();
    nq15Codec.writeEntityUpdate(sb, 1, u, 0);
    // exactly the plain-entity vector: no U_ALPHA, no U_SCALE, no U_EXTEND1
    expect(bytes(sb)).toEqual([0xdf, 0x04, 0x01, 0x05, 0x03, 0x00, 0x02, 0x00, 0xff, 0x40, 0x80, 0x00]);
  });

  test("the wide bit word round-trips through readEntityBits and readEntityUpdateTail", () => {
    // The stream the client sees after the leading command byte of the
    // 0x17C441 vector above: MOREBITS byte, EXTEND1 byte, then the payload.
    readFrom([0xc4, 0x17, 0x2c, 0x01, 0x05, 0x02, 0xc8, 0x20, 0x01, 0x01]);

    // CL_ParseUpdate has already taken (cmd & 127) as the low seven bits and
    // read the U_MOREBITS byte itself.
    let bits = 0x41 & 127;
    bits |= 0xc4 << 8; // the MOREBITS byte the reader below will consume
    // Re-point at the stream from the EXTEND1 byte on.
    readFrom([0x17, 0x2c, 0x01, 0x05, 0x02, 0xc8, 0x20, 0x01, 0x01]);
    bits = fitz666Codec.readEntityBits(bits);
    expect(bits).toBe(0x17c441);

    // ...the caller then reads the entity number, model and frame bytes...
    expect(net_message.data[msgState.readcount]).toBe(0x2c);
    msgState.readcount += 4; // short 300, byte 5, byte 2

    const tail = new EntityUpdateTailT();
    fitz666Codec.readEntityUpdateTail(bits, tail);
    expect(tail.hasAlpha).toBe(true);
    expect(tail.alpha).toBe(200);
    expect(tail.hasScale).toBe(true);
    expect(tail.scale).toBe(32);
    expect(tail.hasFrame2).toBe(true);
    expect(tail.frameHigh).toBe(1);
    expect(tail.hasModel2).toBe(true);
    expect(tail.modelHigh).toBe(1);
    expect(tail.hasLerpfinish).toBe(false);
  });

  test("protocol 15's tail reader consumes nothing", () => {
    readFrom([0xaa, 0xbb]);
    const tail = new EntityUpdateTailT();
    nq15Codec.readEntityBits(0x1ffff); // no extend bytes on 15
    nq15Codec.readEntityUpdateTail(0x1ffff, tail);
    expect(msgState.readcount).toBe(0);
    expect(tail.hasAlpha).toBe(false);
    expect(tail.alpha).toBe(ENTALPHA_DEFAULT);
    expect(tail.scale).toBe(ENTSCALE_DEFAULT);
  });
});

describe("baselines", () => {
  function smallBaseline(): EntityStateT {
    const b = new EntityStateT();
    b.modelindex = 3;
    b.frame = 2;
    b.colormap = 1;
    b.skin = 0;
    b.origin[0] = 16;
    return b;
  }

  test("protocol 15 writes svc_spawnbaseline with byte model and frame", () => {
    //   svc_spawnbaseline = 22        -> 16
    //   short entnum 5                -> 05 00
    //   byte modelindex 3             -> 03
    //   byte frame 2                  -> 02
    //   byte colormap 1               -> 01
    //   byte skin 0                   -> 00
    //   coord 16 / angle 0            -> 80 00 / 00
    //   coord 0  / angle 0            -> 00 00 / 00   (twice)
    const sb = buf();
    nq15Codec.writeBaseline(sb, 5, smallBaseline(), 0);
    expect(bytes(sb)).toEqual([0x16, 0x05, 0x00, 0x03, 0x02, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  test("protocol 15 zeroes a model or frame it cannot name", () => {
    // Ironwail sv_main.c:1578-1585: "still want to send baseline in
    // PROTOCOL_NETQUAKE, so reset these values". A truncated index would name
    // a different model on the client; zero names none.
    const b = smallBaseline();
    b.modelindex = 300; // 0x012C
    b.frame = 258; // 0x0102
    const sb = buf();
    nq15Codec.writeBaseline(sb, 5, b, 0);
    expect(bytes(sb).slice(0, 5)).toEqual([0x16, 0x05, 0x00, 0x00, 0x00]);
    expect(b.modelindex).toBe(0); // normalized in place, so the server's copy agrees
    expect(b.frame).toBe(0);
  });

  test("666 writes svc_spawnbaseline2 with B_LARGEMODEL and B_ALPHA", () => {
    const b = smallBaseline();
    b.modelindex = 300; // 0x012C -> B_LARGEMODEL
    b.alpha = 128; // != ENTALPHA_DEFAULT -> B_ALPHA
    //   bits = B_LARGEMODEL(1) | B_ALPHA(4) = 5
    //   svc_spawnbaseline2 = 42       -> 2A
    //   short entnum 5                -> 05 00
    //   byte bits                     -> 05
    //   short modelindex 300          -> 2C 01
    //   byte frame 2                  -> 02
    //   byte colormap 1 / skin 0      -> 01 00
    //   coord 16 / angle 0            -> 80 00 / 00
    //   coord 0 / angle 0             -> 00 00 / 00  (twice)
    //   byte alpha 128                -> 80
    const sb = buf();
    fitz666Codec.writeBaseline(sb, 5, b, 0);
    expect(bytes(sb)).toEqual([
      0x2a, 0x05, 0x00, 0x05, 0x2c, 0x01, 0x02, 0x01, 0x00,
      0x80, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x80,
    ]);
  });

  test("666 falls back to svc_spawnbaseline when no B_ bit is needed", () => {
    const sb = buf();
    fitz666Codec.writeBaseline(sb, 5, smallBaseline(), 0);
    // Byte-identical to the protocol-15 vector above: no flag byte at all.
    expect(bytes(sb)).toEqual([0x16, 0x05, 0x00, 0x03, 0x02, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  test("999 adds B_SCALE and widens the coordinates", () => {
    const b = smallBaseline();
    b.scale = 32; // != ENTSCALE_DEFAULT -> B_SCALE (8)
    const sb = buf();
    rmq999Codec.writeBaseline(sb, 5, b, RMQ_FLAGS);
    expect(bytes(sb)).toEqual([
      0x2a, 0x05, 0x00, 0x08, // svc_spawnbaseline2, entnum 5, bits B_SCALE
      0x03, 0x02, 0x01, 0x00, // model 3, frame 2, colormap 1, skin 0
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // coord 16 -> 256, angle 0 -> 0000
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x20, // scale 32
    ]);
  });

  test("every baseline round-trips through its own reader", () => {
    for (const [codec, flags, version] of [
      [nq15Codec, 0, 1],
      [fitz666Codec, 0, 1],
      [rmq999Codec, RMQ_FLAGS, 1],
    ] as const) {
      const sb = buf();
      codec.writeBaseline(sb, 5, smallBaseline(), flags);
      const encoded = bytes(sb);
      readFrom(encoded.slice(3)); // past the opcode and the entity number
      const out = new EntityStateT();
      codec.readBaseline(out, version, flags);
      expect(out.modelindex).toBe(3);
      expect(out.frame).toBe(2);
      expect(out.colormap).toBe(1);
      expect(out.origin[0]).toBeCloseTo(16, 3);
    }

    // ...and the version-2 form, flag byte and all.
    const b = smallBaseline();
    b.modelindex = 300;
    b.alpha = 128;
    const sb = buf();
    fitz666Codec.writeBaseline(sb, 5, b, 0);
    readFrom(bytes(sb).slice(3));
    const out = new EntityStateT();
    fitz666Codec.readBaseline(out, 2, 0);
    expect(out.modelindex).toBe(300);
    expect(out.frame).toBe(2);
    expect(out.alpha).toBe(128);
    expect(out.scale).toBe(ENTSCALE_DEFAULT);
  });
});

describe("static entities and ambient sounds", () => {
  test("protocol 15 refuses a static entity it cannot name, and 666 widens it", () => {
    const state = new EntityStateT();
    state.modelindex = 300;
    state.frame = 1;

    // Ironwail pr_cmds.c PF_makestatic: on protocol 15 a model index that does
    // not fit in a byte means "can't display the correct model & frame, so
    // don't show it at all" -- nothing is written and the edict is freed.
    const a = buf();
    expect(nq15Codec.writeStatic(a, state, 0)).toBe(false);
    expect(a.cursize).toBe(0);

    //   bits = B_LARGEMODEL(1)
    //   svc_spawnstatic2 = 43 -> 2B, byte bits 01, short model 300 -> 2C 01,
    //   byte frame 1, byte colormap 0, byte skin 0, then coord/angle x3 at 0
    const b = buf();
    expect(fitz666Codec.writeStatic(b, state, 0)).toBe(true);
    expect(bytes(b)).toEqual([0x2b, 0x01, 0x2c, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  test("a small static entity is svc_spawnstatic on every protocol", () => {
    const state = new EntityStateT();
    state.modelindex = 4;
    state.frame = 1;
    state.colormap = 0;
    state.skin = 2;
    //   svc_spawnstatic = 20 -> 14, model 4, frame 1, colormap 0, skin 2,
    //   then three coord(0)/angle(0) pairs -- 5 + 3 * 3 = 14 bytes
    const expected = [0x14, 0x04, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    const a = buf();
    expect(nq15Codec.writeStatic(a, state, 0)).toBe(true);
    expect(bytes(a)).toEqual(expected);

    const b = buf();
    expect(fitz666Codec.writeStatic(b, state, 0)).toBe(true);
    expect(bytes(b)).toEqual(expected);
  });

  test("ambient sounds pick svc_spawnstaticsound2 past index 255", () => {
    // PF_ambientsound: svc_spawnstaticsound = 29 -> 1D, coord x3, byte index,
    // byte vol*255, byte atten*64.
    const a = buf();
    expect(nq15Codec.writeStaticSound(a, vec3(), 7, 1.0, 1.0, 0)).toBe(true);
    expect(bytes(a)).toEqual([0x1d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0xff, 0x40]);

    // Protocol 15 has no way to name index 300 at all.
    const b = buf();
    expect(nq15Codec.writeStaticSound(b, vec3(), 300, 1.0, 1.0, 0)).toBe(false);
    expect(b.cursize).toBe(0);

    // svc_spawnstaticsound2 = 44 -> 2C, coord x3, short index 300 -> 2C 01
    const c = buf();
    expect(fitz666Codec.writeStaticSound(c, vec3(), 300, 1.0, 1.0, 0)).toBe(true);
    expect(bytes(c)).toEqual([0x2c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x01, 0xff, 0x40]);

    readFrom([0x2c, 0x01]);
    expect(fitz666Codec.readStaticSoundIndex(2)).toBe(300);
    readFrom([0x07]);
    expect(nq15Codec.readStaticSoundIndex(1)).toBe(7);
  });
});

describe("svc_sound", () => {
  function sound(): SoundMessageT {
    const s = new SoundMessageT();
    s.ent = 5;
    s.channel = 2;
    s.soundNum = 7;
    s.volume = 255; // DEFAULT_SOUND_PACKET_VOLUME
    s.attenuation = 1.0; // DEFAULT_SOUND_PACKET_ATTENUATION
    return s;
  }

  test("a default-volume sound is the same eleven bytes on 15 and 666", () => {
    //   field_mask 0 (both values are the wire defaults)
    //   svc_sound = 6 -> 06, mask 00,
    //   short (ent << 3) | channel = (5 << 3) | 2 = 42 -> 2A 00,
    //   byte soundnum 7 -> 07, then three coord(0) pairs -> 00 00 x3
    const expected = [0x06, 0x00, 0x2a, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    const a = buf();
    expect(nq15Codec.writeSound(a, sound(), 0)).toBe(true);
    expect(bytes(a)).toEqual(expected);

    const b = buf();
    expect(fitz666Codec.writeSound(b, sound(), 0)).toBe(true);
    expect(bytes(b)).toEqual(expected);
  });

  test("666 sets SND_LARGEENTITY and SND_LARGESOUND where 15 gives up", () => {
    const s = sound();
    s.ent = 9000; // >= 8192
    s.soundNum = 300; // >= 256
    s.volume = 200; // != 255 -> SND_VOLUME
    s.attenuation = 0.5; // != 1.0 -> SND_ATTENUATION

    expect(nq15Codec.writeSound(buf(), s, 0)).toBe(false); // Ironwail sv_main.c:302-315

    //   field_mask = SND_VOLUME(1)|SND_ATTENUATION(2)|SND_LARGEENTITY(8)
    //                |SND_LARGESOUND(16) = 27 = 0x1B
    //   06, 1B, vol 200 = C8, atten 0.5*64 = 32 = 20,
    //   short ent 9000 = 0x2328 -> 28 23, byte channel 2 -> 02,
    //   short soundnum 300 -> 2C 01, then three coord(0) pairs
    const sb = buf();
    expect(fitz666Codec.writeSound(sb, s, 0)).toBe(true);
    expect(bytes(sb)).toEqual([0x06, 0x1b, 0xc8, 0x20, 0x28, 0x23, 0x02, 0x2c, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    // ...and the client reads that header back.
    readFrom([0x28, 0x23, 0x02, 0x2c, 0x01]);
    const header = new SoundHeaderT();
    fitz666Codec.readSoundHeader(SND_VOLUME | SND_ATTENUATION | SND_LARGEENTITY | SND_LARGESOUND, header);
    expect(header.ent).toBe(9000);
    expect(header.channel).toBe(2);
    expect(header.soundNum).toBe(300);
  });

  test("the packed entity/channel short round-trips on protocol 15", () => {
    readFrom([0x2a, 0x00, 0x07]);
    const header = new SoundHeaderT();
    nq15Codec.readSoundHeader(0, header);
    expect(header.ent).toBe(5);
    expect(header.channel).toBe(2);
    expect(header.soundNum).toBe(7);
  });
});

describe("svc_clientdata", () => {
  function clientdata(): ClientdataT {
    const cd = new ClientdataT();
    cd.viewheight = 22; // DEFAULT_VIEWHEIGHT
    cd.idealpitch = 0;
    cd.items = 0;
    cd.weaponmodelindex = 3;
    cd.health = 100;
    cd.weapon = 8;
    cd.standardQuake = true;
    return cd;
  }

  test("a quiet frame is sixteen bytes on protocol 15", () => {
    //   bits = SU_ITEMS(0x0200) | SU_WEAPON(0x4000) = 0x4200
    //   svc_clientdata = 15 -> 0F, short bits -> 00 42,
    //   (no viewheight: 22 is DEFAULT_VIEWHEIGHT; no idealpitch; no punch or
    //    velocity components),
    //   long items 0 -> 00 00 00 00,
    //   SU_WEAPON byte weaponmodelindex 3 -> 03,
    //   short health 100 -> 64 00,
    //   bytes currentammo/shells/nails/rockets/cells -> 00 00 00 00 00,
    //   byte weapon 8 -> 08
    const expected = [0x0f, 0x00, 0x42, 0x00, 0x00, 0x00, 0x00, 0x03, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08];

    const a = buf();
    nq15Codec.writeClientdata(a, clientdata(), 0);
    expect(bytes(a)).toEqual(expected);

    // 666 adds no bit here: every widened field is zero and alpha is default.
    const b = buf();
    fitz666Codec.writeClientdata(b, clientdata(), 0);
    expect(bytes(b)).toEqual(expected);
  });

  test("666 sends the high byte of every stat that overflows a byte", () => {
    const cd = clientdata();
    cd.armorvalue = 300; // 0x012C
    cd.currentammo = 400; // 0x0190
    cd.weaponmodelindex = 258; // 0x0102
    cd.weaponframe = 257; // 0x0101
    cd.alpha = 128; // != ENTALPHA_DEFAULT

    //   base bits: SU_ITEMS(0x0200) | SU_WEAPONFRAME(0x1000)
    //              | SU_ARMOR(0x2000) | SU_WEAPON(0x4000) = 0x7200
    //   SU_WEAPON2      (0x00010000)  weaponmodelindex 258 & 0xFF00
    //   SU_ARMOR2       (0x00020000)  armorvalue 300 & 0xFF00
    //   SU_AMMO2        (0x00040000)  currentammo 400 & 0xFF00
    //   SU_WEAPONFRAME2 (0x01000000)  weaponframe 257 & 0xFF00
    //   SU_WEAPONALPHA  (0x02000000)  alpha 128 != default
    //   subtotal 0x0307F200; >= 65536    -> SU_EXTEND1 (0x00008000)
    //                        >= 16777216 -> SU_EXTEND2 (0x00800000)
    //   bits = 0x0387F200
    // bytes:
    //   0F, short bits & 0xFFFF -> 00 F2,
    //   SU_EXTEND1 byte bits >> 16 & 0xFF -> 87,
    //   SU_EXTEND2 byte bits >> 24 & 0xFF -> 03,
    //   long items 0 -> 00 00 00 00,
    //   SU_WEAPONFRAME byte 257 & 0xFF -> 01,
    //   SU_ARMOR       byte 300 & 0xFF -> 2C,
    //   SU_WEAPON      byte 258 & 0xFF -> 02,
    //   short health 100 -> 64 00,
    //   byte currentammo 400 & 0xFF -> 90, then shells/nails/rockets/cells 0,
    //   byte weapon 8 -> 08,
    //   then the high bytes, in order: weapon 01, armor 01, ammo 01,
    //   weaponframe 01, and the weapon alpha 80
    const sb = buf();
    fitz666Codec.writeClientdata(sb, cd, 0);
    expect(bytes(sb)).toEqual([
      0x0f, 0x00, 0xf2, 0x87, 0x03,
      0x00, 0x00, 0x00, 0x00,
      0x01, 0x2c, 0x02,
      0x64, 0x00,
      0x90, 0x00, 0x00, 0x00, 0x00,
      0x08,
      0x01, 0x01, 0x01, 0x01, 0x80,
    ]);

    // The client reads the same bit word back and picks up the high bytes.
    readFrom(bytes(sb).slice(1));
    expect(fitz666Codec.readClientdataBits()).toBe(0x0387f200);
    readFrom([0x01, 0x01, 0x01, 0x01, 0x80]);
    const tail = new ClientdataTailT();
    fitz666Codec.readClientdataTail(0x0387f200, tail);
    expect(tail.weaponHigh).toBe(1);
    expect(tail.armorHigh).toBe(1);
    expect(tail.ammoHigh).toBe(1);
    expect(tail.shellsHigh).toBe(0);
    expect(tail.weaponframeHigh).toBe(1);
    expect(tail.weaponalpha).toBe(128);
  });

  test("protocol 15's clientdata reader takes exactly the two bit bytes", () => {
    readFrom([0x00, 0x42, 0xaa]);
    expect(nq15Codec.readClientdataBits()).toBe(0x4200);
    expect(msgState.readcount).toBe(2);
    const tail = new ClientdataTailT();
    nq15Codec.readClientdataTail(0xffffffff, tail);
    expect(msgState.readcount).toBe(2); // nothing more consumed
    expect(tail.weaponalpha).toBe(ENTALPHA_DEFAULT);
  });
});
