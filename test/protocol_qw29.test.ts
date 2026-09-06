// Protocol 29 (src/common/protocol/qw29.ts) -- this engine's own wide
// QuakeWorld wire. Nothing outside this tree defines it, so this file IS its
// specification: every op that differs from protocol 28 is pinned here by
// byte vector and round-tripped back through the decoder.
//
// Self-sufficiency (standing order 13): the read side needs a message to read
// from, so this file drives src/common/sizebuf.ts's `net_message` and
// `msgState` directly. Both are process-wide singletons; their contents are
// saved in beforeAll and restored in afterAll, and every write goes to a
// freshly allocated SizeBuf. Nothing else shared is touched -- no cvar, no
// cl/cls/sv/svs, no builtin table, no renderer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MSG_BeginReading, MSG_ReadByte, MSG_ReadShort, MSG_WriteByte, SizeBuf, msgState, net_message } from "../src/common/sizebuf";
import { EntityStateT } from "../src/common/quakedef";
import { PRFL_INT32COORD, PRFL_SHORTANGLE, Q_rint } from "../src/common/protocol";
import { vec3 } from "../src/common/mathlib";
import { QwEntityStateT, QwUsercmdT, SvcOpsT, U_FRAME, U_MODEL, U_MOREBITS, U_REMOVE, U_SOLID } from "../src/qw/protocol";
import { QwEntityWordT, SoundMessageT } from "../src/common/protocol/codec";
import { qw28Codec } from "../src/common/protocol/qw28";
import {
  PROTOCOL_QW_WIDE,
  QW29_DEFAULT_FLAGS,
  U_ALPHA,
  U_ENTITY2,
  U_EXTEND,
  U_FRAME2,
  U_MODEL2,
  U_SCALE,
  qw29Codec,
} from "../src/common/protocol/qw29";

const FLAGS = QW29_DEFAULT_FLAGS;

function buf(): SizeBuf {
  const sb = new SizeBuf();
  sb.data = new Uint8Array(4096);
  sb.maxsize = sb.data.length;
  sb.cursize = 0;
  return sb;
}

function bytes(sb: SizeBuf): number[] {
  return Array.from(sb.data.subarray(0, sb.cursize));
}

// PRFL_SHORTANGLE decodes through MSG_ReadShort, which is SIGNED (the shared
// src/common/sizebuf.ts behavior RMQ 999 already relies on), so 270 degrees
// comes back as -90. Compare angles modulo a full turn.
function turn(f: number): number {
  return ((f % 360) + 360) % 360;
}

// Point net_message at what `sb` holds and rewind the read cursor, so the
// decode side reads exactly the bytes the encode side just produced.
function readFrom(sb: SizeBuf): void {
  net_message.data = sb.data.subarray(0, sb.cursize);
  net_message.cursize = sb.cursize;
  net_message.maxsize = sb.cursize;
  MSG_BeginReading();
}

let savedData: Uint8Array;
let savedCursize: number;
let savedMaxsize: number;
let savedReadcount: number;
let savedBadread: boolean;

beforeAll(() => {
  savedData = net_message.data;
  savedCursize = net_message.cursize;
  savedMaxsize = net_message.maxsize;
  savedReadcount = msgState.readcount;
  savedBadread = msgState.badread;
});

afterAll(() => {
  net_message.data = savedData;
  net_message.cursize = savedCursize;
  net_message.maxsize = savedMaxsize;
  msgState.readcount = savedReadcount;
  msgState.badread = savedBadread;
});

function state(fields: Partial<QwEntityStateT>): QwEntityStateT {
  const es = new QwEntityStateT();
  if (fields.number !== undefined) es.number = fields.number;
  if (fields.flags !== undefined) es.flags = fields.flags;
  if (fields.origin !== undefined) for (let i = 0; i < 3; i++) es.origin[i] = fields.origin[i];
  if (fields.angles !== undefined) for (let i = 0; i < 3; i++) es.angles[i] = fields.angles[i];
  if (fields.modelindex !== undefined) es.modelindex = fields.modelindex;
  if (fields.frame !== undefined) es.frame = fields.frame;
  if (fields.colormap !== undefined) es.colormap = fields.colormap;
  if (fields.skinnum !== undefined) es.skinnum = fields.skinnum;
  if (fields.effects !== undefined) es.effects = fields.effects;
  if (fields.alpha !== undefined) es.alpha = fields.alpha;
  if (fields.scale !== undefined) es.scale = fields.scale;
  return es;
}

// The whole packetentities record, encode then decode.
function roundTrip(from: QwEntityStateT, to: QwEntityStateT): { out: QwEntityStateT; hdr: QwEntityWordT; wire: number[] } {
  const sb = buf();
  expect(qw29Codec.writeDeltaEntity(sb, from, to, true, FLAGS)).toBe(true);
  const wire = bytes(sb);

  readFrom(sb);
  const word = MSG_ReadShort() & 0xffff;
  const hdr = new QwEntityWordT();
  qw29Codec.readDeltaEntityHeader(word, hdr);
  const out = new QwEntityStateT();
  qw29Codec.readDeltaEntity(from, out, hdr, FLAGS);
  expect(msgState.badread).toBe(false);
  expect(msgState.readcount).toBe(wire.length);
  return { out, hdr, wire };
}

describe("protocol 29 identity", () => {
  test("its number, name and flag word", () => {
    expect(PROTOCOL_QW_WIDE).toBe(29);
    expect(qw29Codec.protocol).toBe(29);
    expect(qw29Codec.defaultFlags).toBe(PRFL_INT32COORD | PRFL_SHORTANGLE);
    expect(qw29Codec.maxEntityNumber).toBe(65536);
    expect(qw29Codec.maxPrecache).toBe(8192);
    // The packet still carries protocol.h's MAX_PACKET_ENTITIES states; what
    // 29 widens is which entity NUMBERS can appear, not how many fit.
    expect(qw29Codec.maxPacketEntities).toBe(qw28Codec.maxPacketEntities);
  });

  test("the extend byte's flag values", () => {
    expect(U_EXTEND).toBe(1 << 7);
    expect(U_ENTITY2).toBe(1 << 0);
    expect(U_MODEL2).toBe(1 << 1);
    expect(U_FRAME2).toBe(1 << 2);
    expect(U_ALPHA).toBe(1 << 3);
    expect(U_SCALE).toBe(1 << 4);
    // U_EXTEND has to be free in protocol 28's U_MOREBITS byte, which uses
    // bits 0-6 (U_ANGLE1 .. U_SOLID).
    expect(U_SOLID).toBe(1 << 6);
  });
});

describe("protocol 29 svc_serverdata", () => {
  test("the protocol long is followed by the PRFL_* flag word", () => {
    const sb = buf();
    MSG_WriteByte(sb, SvcOpsT.svc_serverdata);
    qw29Codec.writeProtocol(sb, FLAGS);

    expect(bytes(sb)).toEqual([
      SvcOpsT.svc_serverdata,
      29,
      0,
      0,
      0, // [long] 29
      FLAGS & 0xff,
      (FLAGS >> 8) & 0xff,
      (FLAGS >> 16) & 0xff,
      (FLAGS >> 24) & 0xff,
    ]);

    readFrom(sb);
    expect(MSG_ReadByte()).toBe(SvcOpsT.svc_serverdata);
    expect(MSG_ReadShort() | (MSG_ReadShort() << 16)).toBe(29);
    expect(qw29Codec.readProtocolFlags()).toBe(FLAGS);
  });

  test("protocol 28 sends no flag word, so the two differ from the fifth byte on", () => {
    const wide = buf();
    qw29Codec.writeProtocol(wide, FLAGS);
    const narrow = buf();
    qw28Codec.writeProtocol(narrow, 0);

    expect(narrow.cursize).toBe(4);
    expect(wide.cursize).toBe(8);
  });
});

describe("protocol 29 coordinates and angles", () => {
  test("coordinates are 32-bit 16ths and reach past protocol 28's +-4096", () => {
    const values = [0, 1.0625, -1.0625, 4096, -4096, 32000.5, -32000.5];

    const sb = buf();
    for (const f of values) qw29Codec.writeCoord(sb, f, FLAGS);
    expect(sb.cursize).toBe(values.length * 4); // a long each, not a short

    readFrom(sb);
    for (const f of values) expect(qw29Codec.readCoord(FLAGS)).toBeCloseTo(f, 4);
  });

  test("angles are 16 bit", () => {
    const values = [0, 45, 90, 180, 270, 359.75];

    const sb = buf();
    for (const f of values) qw29Codec.writeAngle(sb, f, FLAGS);
    expect(sb.cursize).toBe(values.length * 2); // a short each, not a byte

    readFrom(sb);
    for (const f of values) expect(turn(qw29Codec.readAngle(FLAGS))).toBeCloseTo(turn(f), 1);
  });

  test("a coordinate protocol 28 cannot express survives 29 exactly", () => {
    const far = 20000.5;

    const wide = buf();
    qw29Codec.writeCoord(wide, far, FLAGS);
    readFrom(wide);
    expect(qw29Codec.readCoord(FLAGS)).toBeCloseTo(far, 4);

    // protocol 28 writes (int)(f*8) into a short, which wraps
    const narrow = buf();
    qw28Codec.writeCoord(narrow, far, 0);
    readFrom(narrow);
    expect(qw28Codec.readCoord(0)).not.toBeCloseTo(far, 1);
  });
});

describe("protocol 29 packet entities", () => {
  test("a record with no extension is protocol 28's leading short and MOREBITS byte", () => {
    const from = state({ number: 40 });
    const to = state({ number: 40, frame: 3, modelindex: 5 });

    const { out, hdr, wire } = roundTrip(from, to);

    // the leading short: number in the low nine bits, U_FRAME | U_MOREBITS above
    const word = wire[0] | (wire[1] << 8);
    expect(word & 511).toBe(40);
    expect(word & U_FRAME).toBe(U_FRAME);
    expect(word & U_MOREBITS).toBe(U_MOREBITS);
    // the MOREBITS byte carries U_MODEL and NOT U_EXTEND
    expect(wire[2] & U_MODEL).toBe(U_MODEL);
    expect(wire[2] & U_EXTEND).toBe(0);
    expect(hdr.ext).toBe(0);

    expect(out.number).toBe(40);
    expect(out.frame).toBe(3);
    expect(out.modelindex).toBe(5);
  });

  test("an entity above 511 gets U_EXTEND, U_ENTITY2 and a high byte", () => {
    const from = state({ number: 5000 });
    const to = state({ number: 5000, frame: 1 });

    const { out, hdr, wire } = roundTrip(from, to);

    const word = wire[0] | (wire[1] << 8);
    expect(word & 511).toBe(5000 & 511);
    expect(word & U_MOREBITS).toBe(U_MOREBITS);
    expect(wire[2] & U_EXTEND).toBe(U_EXTEND);
    expect(wire[3] & U_ENTITY2).toBe(U_ENTITY2);
    expect(wire[4]).toBe(5000 >> 9);

    expect(hdr.number).toBe(5000);
    expect(out.number).toBe(5000);
    expect(out.frame).toBe(1);
  });

  test("the highest entity number 29 can name round-trips", () => {
    const { out } = roundTrip(state({ number: 65535 }), state({ number: 65535, effects: 4 }));
    expect(out.number).toBe(65535);
    expect(out.effects).toBe(4);
  });

  test("an entity at or above 65536 is refused, and nothing is written", () => {
    const sb = buf();
    expect(qw29Codec.writeDeltaEntity(sb, state({ number: 65536 }), state({ number: 65536, frame: 1 }), true, FLAGS)).toBe(false);
    expect(sb.cursize).toBe(0);
  });

  test("a silent entity above 511 still costs nothing when it is not forced", () => {
    const sb = buf();
    const same = state({ number: 5000, frame: 2 });
    expect(qw29Codec.writeDeltaEntity(sb, same, state({ number: 5000, frame: 2 }), false, FLAGS)).toBe(true);
    expect(sb.cursize).toBe(0);
  });

  test("a model index above 255 gets U_MODEL2 and a high byte", () => {
    const { out, wire } = roundTrip(state({ number: 3 }), state({ number: 3, modelindex: 1234 }));

    expect(wire[2] & U_EXTEND).toBe(U_EXTEND);
    expect(wire[3] & U_MODEL2).toBe(U_MODEL2);
    expect(out.modelindex).toBe(1234);
  });

  test("a frame above 255 gets U_FRAME2 and a high byte", () => {
    const { out, wire } = roundTrip(state({ number: 3 }), state({ number: 3, frame: 999 }));

    expect(wire[3] & U_FRAME2).toBe(U_FRAME2);
    expect(out.frame).toBe(999);
  });

  test("alpha and scale ride in the extend byte", () => {
    const { out, wire } = roundTrip(state({ number: 3 }), state({ number: 3, alpha: 128, scale: 200 }));

    expect(wire[3] & U_ALPHA).toBe(U_ALPHA);
    expect(wire[3] & U_SCALE).toBe(U_SCALE);
    expect(out.alpha).toBe(128);
    expect(out.scale).toBe(200);
  });

  test("everything at once round-trips", () => {
    const from = state({ number: 40000 });
    const to = state({
      number: 40000,
      origin: vec3(9000.5, -9000.5, 1234.25),
      angles: vec3(45, 200.5, -30),
      modelindex: 4000,
      frame: 700,
      colormap: 9,
      skinnum: 3,
      effects: 32,
      alpha: 64,
      scale: 33,
      flags: U_SOLID,
    });

    const { out } = roundTrip(from, to);

    expect(out.number).toBe(40000);
    expect(out.modelindex).toBe(4000);
    expect(out.frame).toBe(700);
    expect(out.colormap).toBe(9);
    expect(out.skinnum).toBe(3);
    expect(out.effects).toBe(32);
    expect(out.alpha).toBe(64);
    expect(out.scale).toBe(33);
    expect(out.flags & U_SOLID).toBe(U_SOLID);
    for (let i = 0; i < 3; i++) expect(out.origin[i]).toBeCloseTo(to.origin[i], 4);
    for (let i = 0; i < 3; i++) expect(turn(out.angles[i])).toBeCloseTo(turn(to.angles[i]), 1);
  });

  test("a removal below 512 is protocol 28's bare short; above it, the extend chain", () => {
    const narrow = buf();
    qw29Codec.writeRemoveEntity(narrow, 40);
    const narrow28 = buf();
    qw28Codec.writeRemoveEntity(narrow28, 40);
    expect(bytes(narrow)).toEqual(bytes(narrow28));

    const wide = buf();
    qw29Codec.writeRemoveEntity(wide, 5000);
    const w = bytes(wide);
    expect(w.length).toBe(5);

    readFrom(wide);
    const word = MSG_ReadShort() & 0xffff;
    const hdr = new QwEntityWordT();
    qw29Codec.readDeltaEntityHeader(word, hdr);
    expect(hdr.remove).toBe(true);
    expect(hdr.number).toBe(5000);
    expect(word & U_REMOVE).toBe(U_REMOVE);
  });

  test("the terminator is still a zero short", () => {
    const sb = buf();
    qw29Codec.writePacketEntitiesEnd(sb);
    expect(bytes(sb)).toEqual([0, 0]);
  });
});

describe("protocol 29 baselines, statics, sounds and precache counts", () => {
  test("svc_spawnbaseline carries 16-bit model and frame plus alpha and scale", () => {
    const es = state({
      origin: vec3(12000.5, -12000.5, 64),
      angles: vec3(0, 135, 0),
      modelindex: 3000,
      frame: 400,
      colormap: 5,
      skinnum: 2,
      alpha: 90,
      scale: 44,
    });

    const sb = buf();
    qw29Codec.writeQwBaseline(sb, es, FLAGS);
    // short model + short frame + colormap + skin + alpha + scale + 3*(long coord + short angle)
    expect(sb.cursize).toBe(2 + 2 + 1 + 1 + 1 + 1 + 3 * (4 + 2));

    readFrom(sb);
    const out = new QwEntityStateT();
    qw29Codec.readQwBaseline(out, FLAGS);
    expect(out.modelindex).toBe(3000);
    expect(out.frame).toBe(400);
    expect(out.colormap).toBe(5);
    expect(out.skinnum).toBe(2);
    expect(out.alpha).toBe(90);
    expect(out.scale).toBe(44);
    for (let i = 0; i < 3; i++) expect(out.origin[i]).toBeCloseTo(es.origin[i], 4);
  });

  test("svc_spawnstatic's body is exactly svc_spawnbaseline's, so CL_ParseStatic can keep calling CL_ParseBaseline", () => {
    const es = state({
      origin: vec3(5000.5, 1, 2),
      angles: vec3(0, 90, 0),
      modelindex: 900,
      frame: 300,
      colormap: 1,
      skinnum: 2,
      alpha: 77,
      scale: 88,
    });

    const asStatic = buf();
    const wire = new EntityStateT();
    wire.modelindex = es.modelindex;
    wire.frame = es.frame;
    wire.colormap = es.colormap;
    wire.skin = es.skinnum;
    wire.alpha = es.alpha;
    wire.scale = es.scale;
    for (let i = 0; i < 3; i++) {
      wire.origin[i] = es.origin[i];
      wire.angles[i] = es.angles[i];
    }
    expect(qw29Codec.writeStatic(asStatic, wire, FLAGS)).toBe(true);

    const asBaseline = buf();
    qw29Codec.writeQwBaseline(asBaseline, es, FLAGS);

    // the static carries one extra leading byte: the opcode
    expect(bytes(asStatic).slice(1)).toEqual(bytes(asBaseline));
  });

  test("svc_spawnstatic carries 16-bit model and frame", () => {
    const es = new EntityStateT();
    es.modelindex = 900;
    es.frame = 300;
    es.colormap = 1;
    es.skin = 2;
    es.origin[0] = 5000.5;

    const sb = buf();
    expect(qw29Codec.writeStatic(sb, es, FLAGS)).toBe(true);
    expect(sb.data[0]).toBe(SvcOpsT.svc_spawnstatic);
    expect(sb.data[1] | (sb.data[2] << 8)).toBe(900);
    expect(sb.data[3] | (sb.data[4] << 8)).toBe(300);
  });

  test("svc_sound and svc_spawnstaticsound carry a 16-bit sound index", () => {
    const s = new SoundMessageT();
    s.ent = 12;
    s.channel = 3;
    s.soundNum = 1000;
    s.volume = 255;
    s.attenuation = 1;

    const sb = buf();
    expect(qw29Codec.writeSound(sb, s, FLAGS)).toBe(true);
    // svc_sound, the ent/channel short, then the sound short (no volume or
    // attenuation byte: both are the defaults)
    expect(sb.data[0]).toBe(SvcOpsT.svc_sound);
    expect(sb.data[3] | (sb.data[4] << 8)).toBe(1000);

    const st = buf();
    expect(qw29Codec.writeStaticSound(st, vec3(0, 0, 0), 1500, 1, 1, FLAGS)).toBe(true);
    readFrom(st);
    expect(MSG_ReadByte()).toBe(SvcOpsT.svc_spawnstaticsound);
    for (let i = 0; i < 3; i++) qw29Codec.readCoord(FLAGS);
    expect(qw29Codec.readStaticSoundIndex(1)).toBe(1500);
  });

  test("svc_modellist / svc_soundlist counts are shorts", () => {
    const sb = buf();
    qw29Codec.writePrecacheCount(sb, 0);
    qw29Codec.writePrecacheCount(sb, 4000);
    expect(sb.cursize).toBe(4);

    readFrom(sb);
    expect(qw29Codec.readPrecacheCount()).toBe(0);
    expect(qw29Codec.readPrecacheCount()).toBe(4000);
  });

  test("a model index protocol 28 cannot name round-trips on 29", () => {
    const sb = buf();
    qw29Codec.writeModelIndex(sb, 8000);
    readFrom(sb);
    expect(qw29Codec.readModelIndex()).toBe(8000);

    const narrow = buf();
    qw28Codec.writeModelIndex(narrow, 8000);
    readFrom(narrow);
    expect(qw28Codec.readModelIndex()).not.toBe(8000); // a byte: 8000 & 255
  });
});

describe("the two QuakeWorld codecs agree wherever 29 did not change anything", () => {
  test("the delta usercmd is byte-identical", () => {
    const from = new QwUsercmdT();
    const to = new QwUsercmdT();
    to.msec = 20;
    to.angles[0] = 15;
    to.angles[1] = 270;
    to.forwardmove = 800;
    to.buttons = 3;
    to.impulse = 7;

    const a = buf();
    qw28Codec.writeDeltaUsercmd(a, from, to);
    const b = buf();
    qw29Codec.writeDeltaUsercmd(b, from, to);

    expect(bytes(b)).toEqual(bytes(a));
  });

  test("Q_rint is what 29's coordinate encoding rounds with", () => {
    const sb = buf();
    qw29Codec.writeCoord(sb, 1.03125, FLAGS);
    const raw = sb.data[0] | (sb.data[1] << 8) | (sb.data[2] << 16) | (sb.data[3] << 24);
    expect(raw).toBe(Q_rint(1.03125 * 16));
  });
});
