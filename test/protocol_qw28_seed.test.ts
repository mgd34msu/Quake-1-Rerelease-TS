// Protocol 28 regression: the qw28 codec must emit exactly the bytes the seed
// emitted before the codec seam reached the QuakeWorld track.
//
// The functions named `seed*` below are the pre-seam encoders, transcribed
// literally out of the versions of src/qw/server/sv_ents.ts, sv_send.ts,
// sv_init.ts, sv_user.ts, pr_cmds.ts and src/qw/common.ts that this unit
// replaced -- same order, same comparisons, same MSG_Write* calls. QW's own
// MSG_WriteAngle / MSG_WriteAngle16 are transcribed too (they are exactly what
// moved into the codec), so this file's expectations do not depend on the code
// under test for anything.
//
// They take plain field bags instead of an edict, a ClientT or a QwEdictT, so
// this file needs no progs.dat, no server, no client and no singletons at all.
//
// Every case below is encoded twice -- once through `seed*`, once through
// `qw28Codec` -- and the two byte strings are compared. A difference is a
// protocol-28 regression, whatever else protocol 29 gained.
//
// Self-sufficiency (standing order 13): this file touches no shared singleton.
// Every SizeBuf it writes to is freshly allocated per call, nothing here reads
// net_message, a cvar, cl/cls/sv/svs or a builtin table, and every codec op
// exercised is a WRITE (the read side needs net_message, and is covered by
// test/protocol_qw29.test.ts, which saves and restores it).

import { describe, expect, test } from "bun:test";
import { MSG_WriteByte, MSG_WriteCoord, MSG_WriteLong, MSG_WriteShort, SizeBuf } from "../src/common/sizebuf";
import { EntityStateT } from "../src/common/quakedef";
import { vec3, type Vec3 } from "../src/common/mathlib";
import {
  CM_ANGLE1,
  CM_ANGLE2,
  CM_ANGLE3,
  CM_BUTTONS,
  CM_FORWARD,
  CM_IMPULSE,
  CM_SIDE,
  CM_UP,
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  PF_COMMAND,
  PF_EFFECTS,
  PF_MODEL,
  PF_MSEC,
  PF_SKINNUM,
  PF_VELOCITY1,
  PF_WEAPONFRAME,
  PROTOCOL_VERSION,
  QwEntityStateT,
  QwUsercmdT,
  SND_ATTENUATION,
  SND_VOLUME,
  SvcOpsT,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_FRAME,
  U_MODEL,
  U_MOREBITS,
  U_ORIGIN1,
  U_REMOVE,
  U_SKIN,
  U_SOLID,
} from "../src/qw/protocol";
import { SoundMessageT } from "../src/common/protocol/codec";
import { qw28Codec } from "../src/common/protocol/qw28";

function buf(): SizeBuf {
  const sb = new SizeBuf();
  sb.data = new Uint8Array(1024);
  sb.maxsize = sb.data.length;
  sb.cursize = 0;
  return sb;
}

function bytes(sb: SizeBuf): number[] {
  return Array.from(sb.data.subarray(0, sb.cursize));
}

//============================================================================
// The seed's encoders, transcribed.

// src/qw/common.ts's MSG_WriteAngle: QuakeWorld truncates AFTER the multiply,
// where WinQuake truncates the float first.
function seedWriteAngle(sb: SizeBuf, f: number): void {
  MSG_WriteByte(sb, Math.trunc((f * 256) / 360) & 255);
}

function seedWriteAngle16(sb: SizeBuf, f: number): void {
  MSG_WriteShort(sb, Math.trunc((f * 65536) / 360) & 65535);
}

// src/qw/server/sv_ents.ts's SV_WriteDelta, from `let bits = 0` to the last
// MSG_WriteAngle. The two SV_Error guards (`!to.number`, `to.number >= 512`)
// are server-state checks, not bytes, and are not transcribed; no case below
// trips either.
function seedWriteDelta(from: QwEntityStateT, to: QwEntityStateT, msg: SizeBuf, force: boolean): void {
  let bits = 0;

  for (let i = 0; i < 3; i++) {
    const miss = to.origin[i] - from.origin[i];
    if (miss < -0.1 || miss > 0.1) bits |= U_ORIGIN1 << i;
  }

  if (to.angles[0] !== from.angles[0]) bits |= U_ANGLE1;

  if (to.angles[1] !== from.angles[1]) bits |= U_ANGLE2;

  if (to.angles[2] !== from.angles[2]) bits |= U_ANGLE3;

  if (to.colormap !== from.colormap) bits |= U_COLORMAP;

  if (to.skinnum !== from.skinnum) bits |= U_SKIN;

  if (to.frame !== from.frame) bits |= U_FRAME;

  if (to.effects !== from.effects) bits |= U_EFFECTS;

  if (to.modelindex !== from.modelindex) bits |= U_MODEL;

  if (bits & 511) bits |= U_MOREBITS;

  if (to.flags & U_SOLID) bits |= U_SOLID;

  if (!bits && !force) return; // nothing to send!
  const i = to.number | (bits & ~511);
  MSG_WriteShort(msg, i);

  if (bits & U_MOREBITS) MSG_WriteByte(msg, bits & 255);
  if (bits & U_MODEL) MSG_WriteByte(msg, to.modelindex);
  if (bits & U_FRAME) MSG_WriteByte(msg, to.frame);
  if (bits & U_COLORMAP) MSG_WriteByte(msg, to.colormap);
  if (bits & U_SKIN) MSG_WriteByte(msg, to.skinnum);
  if (bits & U_EFFECTS) MSG_WriteByte(msg, to.effects);
  if (bits & U_ORIGIN1) MSG_WriteCoord(msg, to.origin[0]);
  if (bits & U_ANGLE1) seedWriteAngle(msg, to.angles[0]);
  if (bits & (U_ORIGIN1 << 1)) MSG_WriteCoord(msg, to.origin[1]);
  if (bits & U_ANGLE2) seedWriteAngle(msg, to.angles[1]);
  if (bits & (U_ORIGIN1 << 2)) MSG_WriteCoord(msg, to.origin[2]);
  if (bits & U_ANGLE3) seedWriteAngle(msg, to.angles[2]);
}

// src/qw/common.ts's MSG_WriteDeltaUsercmd.
function seedWriteDeltaUsercmd(buffer: SizeBuf, from: QwUsercmdT, cmd: QwUsercmdT): void {
  let bits = 0;
  if (cmd.angles[0] !== from.angles[0]) bits |= CM_ANGLE1;
  if (cmd.angles[1] !== from.angles[1]) bits |= CM_ANGLE2;
  if (cmd.angles[2] !== from.angles[2]) bits |= CM_ANGLE3;
  if (cmd.forwardmove !== from.forwardmove) bits |= CM_FORWARD;
  if (cmd.sidemove !== from.sidemove) bits |= CM_SIDE;
  if (cmd.upmove !== from.upmove) bits |= CM_UP;
  if (cmd.buttons !== from.buttons) bits |= CM_BUTTONS;
  if (cmd.impulse !== from.impulse) bits |= CM_IMPULSE;

  MSG_WriteByte(buffer, bits);

  if (bits & CM_ANGLE1) seedWriteAngle16(buffer, cmd.angles[0]);
  if (bits & CM_ANGLE2) seedWriteAngle16(buffer, cmd.angles[1]);
  if (bits & CM_ANGLE3) seedWriteAngle16(buffer, cmd.angles[2]);

  if (bits & CM_FORWARD) MSG_WriteShort(buffer, cmd.forwardmove);
  if (bits & CM_SIDE) MSG_WriteShort(buffer, cmd.sidemove);
  if (bits & CM_UP) MSG_WriteShort(buffer, cmd.upmove);

  if (bits & CM_BUTTONS) MSG_WriteByte(buffer, cmd.buttons);
  if (bits & CM_IMPULSE) MSG_WriteByte(buffer, cmd.impulse);
  MSG_WriteByte(buffer, cmd.msec);
}

// src/qw/server/sv_ents.ts's SV_WritePlayersToClient, from the
// MSG_WriteByte(svc_playerinfo) to the last field. The pflags computation
// above it reads svs.clients and the client's edict and is server logic, not
// wire; `pflags` is a parameter here for the same reason the nq15 seed test
// passes a field bag.
interface SeedPlayerVars {
  origin: Vec3;
  frame: number;
  msec: number;
  cmd: QwUsercmdT;
  velocity: Vec3;
  modelindex: number;
  skin: number;
  effects: number;
  weaponframe: number;
}

function seedWritePlayerinfo(msg: SizeBuf, j: number, pflags: number, v: SeedPlayerVars, nullcmd: QwUsercmdT): void {
  MSG_WriteByte(msg, SvcOpsT.svc_playerinfo);
  MSG_WriteByte(msg, j);
  MSG_WriteShort(msg, pflags);

  for (let i = 0; i < 3; i++) MSG_WriteCoord(msg, v.origin[i]);

  MSG_WriteByte(msg, v.frame);

  if (pflags & PF_MSEC) {
    let msec = v.msec;
    if (msec > 255) msec = 255;
    MSG_WriteByte(msg, msec);
  }

  if (pflags & PF_COMMAND) seedWriteDeltaUsercmd(msg, nullcmd, v.cmd);

  for (let i = 0; i < 3; i++) {
    if (pflags & (PF_VELOCITY1 << i)) MSG_WriteShort(msg, v.velocity[i]);
  }

  if (pflags & PF_MODEL) MSG_WriteByte(msg, v.modelindex);

  if (pflags & PF_SKINNUM) MSG_WriteByte(msg, v.skin);

  if (pflags & PF_EFFECTS) MSG_WriteByte(msg, v.effects);

  if (pflags & PF_WEAPONFRAME) MSG_WriteByte(msg, v.weaponframe);
}

// src/qw/server/sv_send.ts's SV_StartSound, from the MSG_WriteByte(svc_sound)
// to the last coordinate. The precache lookup, the PHS decision and the
// bmodel-origin adjustment above it are server logic, not wire.
function seedWriteSound(
  msg: SizeBuf,
  ent: number,
  channel: number,
  sound_num: number,
  volume: number,
  attenuation: number,
  origin: Vec3,
): void {
  let chan = (ent << 3) | channel;

  if (volume !== DEFAULT_SOUND_PACKET_VOLUME) chan |= SND_VOLUME;
  if (attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) chan |= SND_ATTENUATION;

  MSG_WriteByte(msg, SvcOpsT.svc_sound);
  MSG_WriteShort(msg, chan);
  if (chan & SND_VOLUME) MSG_WriteByte(msg, volume);
  if (chan & SND_ATTENUATION) MSG_WriteByte(msg, attenuation * 64);
  MSG_WriteByte(msg, sound_num);
  for (let i = 0; i < 3; i++) MSG_WriteCoord(msg, origin[i]);
}

// src/qw/server/sv_user.ts's SV_New_f, the two lines the codec now owns.
function seedWriteServerdata(msg: SizeBuf, spawncount: number): void {
  MSG_WriteByte(msg, SvcOpsT.svc_serverdata);
  MSG_WriteLong(msg, PROTOCOL_VERSION);
  MSG_WriteLong(msg, spawncount);
}

// src/qw/server/sv_init.ts's SV_CreateBaseline, "add to the message" block.
function seedWriteBaseline(signon: SizeBuf, entnum: number, baseline: QwEntityStateT): void {
  MSG_WriteByte(signon, SvcOpsT.svc_spawnbaseline);
  MSG_WriteShort(signon, entnum);

  MSG_WriteByte(signon, baseline.modelindex);
  MSG_WriteByte(signon, baseline.frame);
  MSG_WriteByte(signon, baseline.colormap);
  MSG_WriteByte(signon, baseline.skinnum);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(signon, baseline.origin[i]);
    seedWriteAngle(signon, baseline.angles[i]);
  }
}

// src/qw/server/pr_cmds.ts's PF_makestatic.
function seedWriteStatic(signon: SizeBuf, modelindex: number, frame: number, colormap: number, skin: number, origin: Vec3, angles: Vec3): void {
  MSG_WriteByte(signon, SvcOpsT.svc_spawnstatic);

  MSG_WriteByte(signon, modelindex);

  MSG_WriteByte(signon, frame);
  MSG_WriteByte(signon, colormap);
  MSG_WriteByte(signon, skin);
  for (let i = 0; i < 3; i++) {
    MSG_WriteCoord(signon, origin[i]);
    seedWriteAngle(signon, angles[i]);
  }
}

// src/qw/server/pr_cmds.ts's PF_ambientsound.
function seedWriteStaticSound(signon: SizeBuf, pos: Vec3, soundnum: number, vol: number, attenuation: number): void {
  MSG_WriteByte(signon, SvcOpsT.svc_spawnstaticsound);
  for (let i = 0; i < 3; i++) MSG_WriteCoord(signon, pos[i]);

  MSG_WriteByte(signon, soundnum);

  MSG_WriteByte(signon, vol * 255);
  MSG_WriteByte(signon, attenuation * 64);
}

//============================================================================
// Helpers for building states without a server.

function state(fields: Partial<{ number: number; flags: number; origin: Vec3; angles: Vec3; modelindex: number; frame: number; colormap: number; skinnum: number; effects: number }>): QwEntityStateT {
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
  return es;
}

function cmd(fields: Partial<{ msec: number; angles: Vec3; forwardmove: number; sidemove: number; upmove: number; buttons: number; impulse: number }>): QwUsercmdT {
  const c = new QwUsercmdT();
  if (fields.msec !== undefined) c.msec = fields.msec;
  if (fields.angles !== undefined) for (let i = 0; i < 3; i++) c.angles[i] = fields.angles[i];
  if (fields.forwardmove !== undefined) c.forwardmove = fields.forwardmove;
  if (fields.sidemove !== undefined) c.sidemove = fields.sidemove;
  if (fields.upmove !== undefined) c.upmove = fields.upmove;
  if (fields.buttons !== undefined) c.buttons = fields.buttons;
  if (fields.impulse !== undefined) c.impulse = fields.impulse;
  return c;
}

//============================================================================

describe("qw28 entity deltas are the seed's bytes", () => {
  const cases: Array<[string, QwEntityStateT, QwEntityStateT, boolean]> = [
    ["nothing changed, not forced", state({ number: 5 }), state({ number: 5 }), false],
    ["nothing changed, forced (the baseline case)", state({ number: 5 }), state({ number: 5 }), true],
    [
      "every field changed",
      state({ number: 12 }),
      state({
        number: 12,
        origin: vec3(64.5, -128.25, 16),
        angles: vec3(45, 90, 180),
        modelindex: 7,
        frame: 3,
        colormap: 2,
        skinnum: 1,
        effects: 8,
      }),
      false,
    ],
    [
      "origin moved less than the 0.1 deadband on one axis",
      state({ number: 9, origin: vec3(10, 20, 30) }),
      state({ number: 9, origin: vec3(10.05, 20, 30.5) }),
      false,
    ],
    ["only the frame changed (no U_MOREBITS)", state({ number: 3, frame: 1 }), state({ number: 3, frame: 2 }), false],
    ["only the model changed (forces U_MOREBITS)", state({ number: 3 }), state({ number: 3, modelindex: 4 }), false],
    ["U_SOLID rides in from to.flags", state({ number: 40 }), state({ number: 40, flags: U_SOLID, frame: 1 }), false],
    ["the highest entity number protocol 28 can name", state({ number: 511 }), state({ number: 511, frame: 9 }), false],
    [
      "negative coordinates and angles",
      state({ number: 6 }),
      state({ number: 6, origin: vec3(-4095.875, -1, -0.125), angles: vec3(-45, 359, -180) }),
      false,
    ],
  ];

  for (const [name, from, to, force] of cases) {
    test(name, () => {
      const seed = buf();
      seedWriteDelta(from, to, seed, force);

      const codec = buf();
      expect(qw28Codec.writeDeltaEntity(codec, from, to, force, 0)).toBe(true);

      expect(bytes(codec)).toEqual(bytes(seed));
    });
  }

  test("an entity number protocol 28 cannot name writes nothing and reports it", () => {
    const codec = buf();
    expect(qw28Codec.writeDeltaEntity(codec, state({ number: 512 }), state({ number: 512, frame: 1 }), true, 0)).toBe(false);
    expect(codec.cursize).toBe(0);
    expect(qw28Codec.maxEntityNumber).toBe(512);
  });

  test("the U_REMOVE record and the terminator are the seed's shorts", () => {
    const seed = buf();
    MSG_WriteShort(seed, 40 | U_REMOVE);
    MSG_WriteShort(seed, 0);

    const codec = buf();
    qw28Codec.writeRemoveEntity(codec, 40);
    qw28Codec.writePacketEntitiesEnd(codec);

    expect(bytes(codec)).toEqual(bytes(seed));
  });
});

describe("qw28 svc_playerinfo is the seed's bytes", () => {
  const nullcmd = new QwUsercmdT();

  const vars: SeedPlayerVars = {
    origin: vec3(100.5, -200.25, 24),
    frame: 12,
    msec: 33,
    cmd: cmd({ msec: 17, angles: vec3(10, 200, -30), forwardmove: 400, sidemove: -200, upmove: 0 }),
    velocity: vec3(320, -110, 0),
    modelindex: 6,
    skin: 3,
    effects: 16,
    weaponframe: 5,
  };

  const cases: Array<[string, number]> = [
    ["a plain other player", PF_MSEC | PF_COMMAND],
    ["the view player (no msec, no command, weaponframe)", PF_WEAPONFRAME],
    ["a spectator (velocity only)", PF_VELOCITY1 | (PF_VELOCITY1 << 1)],
    [
      "every flag at once",
      PF_MSEC | PF_COMMAND | PF_VELOCITY1 | (PF_VELOCITY1 << 1) | (PF_VELOCITY1 << 2) | PF_MODEL | PF_SKINNUM | PF_EFFECTS | PF_WEAPONFRAME,
    ],
  ];

  for (const [name, pflags] of cases) {
    test(name, () => {
      const seed = buf();
      seedWritePlayerinfo(seed, 2, pflags, vars, nullcmd);

      // What sv_ents.ts writes now: the opcode/slot/pflags/frame and the
      // velocity shorts stay plain MSG_Write* calls (they are byte-identical
      // on both protocols); the coordinates, the delta usercmd and the model
      // index go through the codec.
      const codec = buf();
      MSG_WriteByte(codec, SvcOpsT.svc_playerinfo);
      MSG_WriteByte(codec, 2);
      MSG_WriteShort(codec, pflags);
      for (let i = 0; i < 3; i++) qw28Codec.writeCoord(codec, vars.origin[i], 0);
      MSG_WriteByte(codec, vars.frame);
      if (pflags & PF_MSEC) MSG_WriteByte(codec, vars.msec);
      if (pflags & PF_COMMAND) qw28Codec.writeDeltaUsercmd(codec, nullcmd, vars.cmd);
      for (let i = 0; i < 3; i++) if (pflags & (PF_VELOCITY1 << i)) MSG_WriteShort(codec, vars.velocity[i]);
      if (pflags & PF_MODEL) qw28Codec.writeModelIndex(codec, vars.modelindex);
      if (pflags & PF_SKINNUM) MSG_WriteByte(codec, vars.skin);
      if (pflags & PF_EFFECTS) MSG_WriteByte(codec, vars.effects);
      if (pflags & PF_WEAPONFRAME) MSG_WriteByte(codec, vars.weaponframe);

      expect(bytes(codec)).toEqual(bytes(seed));
    });
  }
});

describe("qw28 delta usercmds are the seed's bytes", () => {
  const cases: Array<[string, QwUsercmdT, QwUsercmdT]> = [
    ["no change at all (just the bits byte and msec)", cmd({}), cmd({ msec: 13 })],
    ["every field changed", cmd({}), cmd({ msec: 20, angles: vec3(15, 270, -45), forwardmove: 800, sidemove: -800, upmove: 200, buttons: 3, impulse: 7 })],
    ["only yaw changed", cmd({ angles: vec3(1, 2, 3) }), cmd({ angles: vec3(1, 99, 3), msec: 8 })],
    ["negative movement shorts", cmd({}), cmd({ forwardmove: -32768, sidemove: 32767, upmove: -1, msec: 255 })],
  ];

  for (const [name, from, to] of cases) {
    test(name, () => {
      const seed = buf();
      seedWriteDeltaUsercmd(seed, from, to);

      const codec = buf();
      qw28Codec.writeDeltaUsercmd(codec, from, to);

      expect(bytes(codec)).toEqual(bytes(seed));
    });
  }
});

describe("qw28 sounds are the seed's bytes", () => {
  const cases: Array<[string, number, number, number, number, number]> = [
    // ent, channel, soundNum, volume, attenuation
    ["default volume and attenuation", 12, 3, 40, DEFAULT_SOUND_PACKET_VOLUME, DEFAULT_SOUND_PACKET_ATTENUATION],
    ["a quieter sound", 12, 3, 40, 100, DEFAULT_SOUND_PACKET_ATTENUATION],
    ["a farther-carrying sound", 12, 3, 40, DEFAULT_SOUND_PACKET_VOLUME, 0.5],
    ["both fields", 700, 7, 255, 60, 2],
    ["channel 0, entity 0 (a world sound)", 0, 0, 1, DEFAULT_SOUND_PACKET_VOLUME, DEFAULT_SOUND_PACKET_ATTENUATION],
  ];

  const origin = vec3(-64.125, 512, 8.5);

  for (const [name, ent, channel, soundNum, volume, attenuation] of cases) {
    test(name, () => {
      const seed = buf();
      seedWriteSound(seed, ent, channel, soundNum, volume, attenuation, origin);

      const s = new SoundMessageT();
      s.ent = ent;
      s.channel = channel;
      s.soundNum = soundNum;
      s.volume = volume;
      s.attenuation = attenuation;
      for (let i = 0; i < 3; i++) s.origin[i] = origin[i];

      const codec = buf();
      expect(qw28Codec.writeSound(codec, s, 0)).toBe(true);

      expect(bytes(codec)).toEqual(bytes(seed));
    });
  }

  test("svc_spawnstaticsound is the seed's bytes", () => {
    const pos = vec3(16, -32.5, 4);
    const seed = buf();
    seedWriteStaticSound(seed, pos, 9, 0.7, 1.5);

    const codec = buf();
    expect(qw28Codec.writeStaticSound(codec, pos, 9, 0.7, 1.5, 0)).toBe(true);

    expect(bytes(codec)).toEqual(bytes(seed));
  });
});

describe("qw28 serverdata, baselines and statics are the seed's bytes", () => {
  test("svc_serverdata's protocol long", () => {
    const seed = buf();
    seedWriteServerdata(seed, 1234);

    const codec = buf();
    MSG_WriteByte(codec, SvcOpsT.svc_serverdata);
    qw28Codec.writeProtocol(codec, 0);
    MSG_WriteLong(codec, 1234);

    expect(bytes(codec)).toEqual(bytes(seed));
    expect(qw28Codec.protocol).toBe(28);
    expect(qw28Codec.defaultFlags).toBe(0);
  });

  test("svc_spawnbaseline", () => {
    const es = state({
      origin: vec3(-1000.5, 24, 3.375),
      angles: vec3(0, 270, 0),
      modelindex: 33,
      frame: 2,
      colormap: 4,
      skinnum: 1,
    });

    const seed = buf();
    seedWriteBaseline(seed, 77, es);

    const codec = buf();
    MSG_WriteByte(codec, SvcOpsT.svc_spawnbaseline);
    MSG_WriteShort(codec, 77);
    qw28Codec.writeQwBaseline(codec, es, 0);

    expect(bytes(codec)).toEqual(bytes(seed));
  });

  test("svc_spawnstatic", () => {
    const origin = vec3(8, 9, 10);
    const angles = vec3(0, 45, 0);

    const seed = buf();
    seedWriteStatic(seed, 21, 1, 0, 2, origin, angles);

    const es = new EntityStateT();
    es.modelindex = 21;
    es.frame = 1;
    es.colormap = 0;
    es.skin = 2;
    for (let i = 0; i < 3; i++) {
      es.origin[i] = origin[i];
      es.angles[i] = angles[i];
    }

    const codec = buf();
    expect(qw28Codec.writeStatic(codec, es, 0)).toBe(true);

    expect(bytes(codec)).toEqual(bytes(seed));
  });

  test("svc_modellist / svc_soundlist counts are bytes, and 255 is the last index 28 can name", () => {
    const seed = buf();
    MSG_WriteByte(seed, 0);
    MSG_WriteByte(seed, 200);

    const codec = buf();
    qw28Codec.writePrecacheCount(codec, 0);
    qw28Codec.writePrecacheCount(codec, 200);

    expect(bytes(codec)).toEqual(bytes(seed));
    expect(qw28Codec.maxPrecache).toBe(256);
  });
});

describe("qw28 coordinates and angles are the seed's bytes", () => {
  test("MSG_WriteCoord is unchanged and MSG_WriteAngle keeps QuakeWorld's truncation order", () => {
    const values = [0, 1, -1, 45, 90, 179.9, 180, 270, 359.5, -45, -180.5, 4095.875, -4095.875];

    const seed = buf();
    for (const f of values) {
      MSG_WriteCoord(seed, f);
      seedWriteAngle(seed, f);
    }

    const codec = buf();
    for (const f of values) {
      qw28Codec.writeCoord(codec, f, 0);
      qw28Codec.writeAngle(codec, f, 0);
    }

    expect(bytes(codec)).toEqual(bytes(seed));
  });

  test("QuakeWorld's angle byte differs from WinQuake's for a fractional angle", () => {
    // WinQuake truncates the float first: ((int)179.9 * 256) / 360 == 127.
    // QuakeWorld truncates after: (int)(179.9 * 256 / 360) == 127 too, but at
    // 0.9 the two part company: ((int)0.9*256)/360 == 0 vs (int)(0.9*256/360)
    // == 0 ... the case that separates them is an angle whose fractional part
    // carries the product past an integer boundary.
    const winquake = (f: number): number => Math.trunc((Math.trunc(f) * 256) / 360) & 255;
    const quakeworld = (f: number): number => Math.trunc((f * 256) / 360) & 255;

    let differing = -1;
    for (let f = 0; f < 360; f += 0.25) {
      if (winquake(f) !== quakeworld(f)) {
        differing = f;
        break;
      }
    }
    expect(differing).toBeGreaterThanOrEqual(0);

    const codec = buf();
    qw28Codec.writeAngle(codec, differing, 0);
    expect(bytes(codec)).toEqual([quakeworld(differing)]);
    expect(bytes(codec)).not.toEqual([winquake(differing)]);
  });
});
