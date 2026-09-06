/*
QuakeWorld protocol 28 (id's QW 2.33 wire format).

Like nq15.ts this codec is an EXTRACTION, not a rewrite: every encoder and
decoder below is the seed's own QuakeWorld code, moved out of
src/qw/server/sv_ents.ts, sv_send.ts, sv_user.ts, pr_cmds.ts and
src/qw/client/cl_ents.ts, cl_parse.ts, cl_input.ts unchanged, so protocol 28's
bytes are exactly what this engine emitted before the codec seam reached the
QuakeWorld track. test/protocol_qw28_seed.test.ts pins that with byte vectors
produced by the pre-seam encoders written out literally.

Three QuakeWorld shapes have no NetQuake counterpart and live in the optional
half of ProtocolCodec (see codec.ts's header):

- the packet-entities envelope. QW deltas an entity against the last state the
  client acknowledged, not against its baseline, and packs nine bits of entity
  number into the same short as seven of the flags. `writeDeltaEntity` /
  `readDeltaEntityHeader` + `readDeltaEntity` / `writeRemoveEntity` /
  `writePacketEntitiesEnd` are that envelope.
- the delta usercmd (`clc_move`, and `svc_playerinfo`'s PF_COMMAND block).
- `svc_spawnbaseline` over QW's own entity_state_t, and the byte-wide
  model/sound precache indices and svc_modellist/svc_soundlist counts.

`maxEntityNumber` is 512, which is protocol 28's own limit and not the
server's: the entity number field in the leading short is nine bits wide. The
seed made that an `SV_Error ("Entity number >= 512")`, which killed the whole
server the first time a map's edict count crossed it. It is a wire limit, so
this codec expresses it the way nq15.ts expresses protocol 15's byte-wide
model index -- `writeDeltaEntity` returns false and the entity is left out of
the packet -- and src/qw/server/sv_ents.ts warns through Con_DPrintf. Protocol
29 (qw29.ts) is the variant that can name those entities.

`maxPrecache` is 256 for the same reason: `svc_modellist`/`svc_soundlist`
carry byte counts and `U_MODEL` carries a byte index, so index 255 is the last
one protocol 28 can name, however large MAX_MODELS/MAX_SOUNDS have become.

MSG_WriteAngle's truncation order is QuakeWorld's, not WinQuake's
(`(int)(f*256/360)` versus WinQuake's `((int)f*256/360)`) -- a real wire-byte
difference between the two trees, which is why writeAngle is a codec op here
and src/qw/common.ts's own MSG_WriteAngle forwards to it rather than keeping a
second copy.
*/

import {
  MSG_ReadByte,
  MSG_ReadCoord,
  MSG_ReadAngle,
  MSG_ReadShort,
  MSG_WriteByte,
  MSG_WriteCoord,
  MSG_WriteLong,
  MSG_WriteShort,
  type SizeBuf,
} from "../sizebuf";
import type { Vec3 } from "../mathlib";
import type { EntityStateT } from "../quakedef";
import { Sys_Error } from "../../platform/sys";
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
  MAX_PACKET_ENTITIES,
  PROTOCOL_VERSION,
  type QwEntityStateT,
  type QwUsercmdT,
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
  U_ORIGIN2,
  U_ORIGIN3,
  U_REMOVE,
  U_SKIN,
  U_SOLID,
} from "../../qw/protocol";
import { MAX_DATAGRAM, MAX_MSGLEN } from "../../qw/bothdefs";
import type {
  ClientdataT,
  ClientdataTailT,
  EntityUpdateT,
  EntityUpdateTailT,
  QwEntityWordT,
  QwProtocolCodec,
  SoundHeaderT,
  SoundMessageT,
} from "./codec";

// The nine-bit entity number field in a packetentities record's leading short.
export const QW28_MAX_ENTITY_NUMBER = 512;

// svc_modellist / svc_soundlist counts and U_MODEL are bytes.
export const QW28_MAX_PRECACHE = 256;

// The message-set members NetQuake has and QuakeWorld does not. Reaching one
// means a NetQuake caller was handed a QuakeWorld codec, which is a wiring
// bug, not a wire condition -- see codec.ts's header.
export function qwNoNetQuakeOp(protocol: number, op: string): never {
  return Sys_Error("protocol %i (QuakeWorld) has no %s", protocol, op);
}

//============================================================================
// QuakeWorld's own MSG_WriteAngle / MSG_WriteAngle16 / MSG_ReadAngle16
// (QW/client/common.c). src/qw/common.ts forwards to these.

export function qwWriteAngle(sb: SizeBuf, f: number): void {
  // (int)(f*256/360) & 255 -- QW truncates AFTER the multiply, WinQuake before
  MSG_WriteByte(sb, Math.trunc((f * 256) / 360) & 255);
}

export function qwWriteAngle16(sb: SizeBuf, f: number): void {
  MSG_WriteShort(sb, Math.trunc((f * 65536) / 360) & 65535);
}

export function qwReadAngle16(): number {
  return MSG_ReadShort() * (360.0 / 65536);
}

//============================================================================
// The delta usercmd (QW/client/common.c MSG_WriteDeltaUsercmd /
// MSG_ReadDeltaUsercmd). Identical on 28 and 29, so qw29 inherits it.

export function qwWriteDeltaUsercmd(buf: SizeBuf, from: QwUsercmdT, cmd: QwUsercmdT): void {
  //
  // send the movement message
  //
  let bits = 0;
  if (cmd.angles[0] !== from.angles[0]) bits |= CM_ANGLE1;
  if (cmd.angles[1] !== from.angles[1]) bits |= CM_ANGLE2;
  if (cmd.angles[2] !== from.angles[2]) bits |= CM_ANGLE3;
  if (cmd.forwardmove !== from.forwardmove) bits |= CM_FORWARD;
  if (cmd.sidemove !== from.sidemove) bits |= CM_SIDE;
  if (cmd.upmove !== from.upmove) bits |= CM_UP;
  if (cmd.buttons !== from.buttons) bits |= CM_BUTTONS;
  if (cmd.impulse !== from.impulse) bits |= CM_IMPULSE;

  MSG_WriteByte(buf, bits);

  if (bits & CM_ANGLE1) qwWriteAngle16(buf, cmd.angles[0]);
  if (bits & CM_ANGLE2) qwWriteAngle16(buf, cmd.angles[1]);
  if (bits & CM_ANGLE3) qwWriteAngle16(buf, cmd.angles[2]);

  if (bits & CM_FORWARD) MSG_WriteShort(buf, cmd.forwardmove);
  if (bits & CM_SIDE) MSG_WriteShort(buf, cmd.sidemove);
  if (bits & CM_UP) MSG_WriteShort(buf, cmd.upmove);

  if (bits & CM_BUTTONS) MSG_WriteByte(buf, cmd.buttons);
  if (bits & CM_IMPULSE) MSG_WriteByte(buf, cmd.impulse);
  MSG_WriteByte(buf, cmd.msec);
}

export function qwReadDeltaUsercmd(from: QwUsercmdT, move: QwUsercmdT): void {
  move.msec = from.msec;
  move.angles[0] = from.angles[0];
  move.angles[1] = from.angles[1];
  move.angles[2] = from.angles[2];
  move.forwardmove = from.forwardmove;
  move.sidemove = from.sidemove;
  move.upmove = from.upmove;
  move.buttons = from.buttons;
  move.impulse = from.impulse;

  const bits = MSG_ReadByte();

  // read current angles
  if (bits & CM_ANGLE1) move.angles[0] = qwReadAngle16();
  if (bits & CM_ANGLE2) move.angles[1] = qwReadAngle16();
  if (bits & CM_ANGLE3) move.angles[2] = qwReadAngle16();

  // read movement
  if (bits & CM_FORWARD) move.forwardmove = MSG_ReadShort();
  if (bits & CM_SIDE) move.sidemove = MSG_ReadShort();
  if (bits & CM_UP) move.upmove = MSG_ReadShort();

  // read buttons
  if (bits & CM_BUTTONS) move.buttons = MSG_ReadByte();
  if (bits & CM_IMPULSE) move.impulse = MSG_ReadByte();

  // read time to run command
  move.msec = MSG_ReadByte();
}

//============================================================================

export const qw28Codec: QwProtocolCodec = {
  protocol: PROTOCOL_VERSION,
  name: "QuakeWorld",
  maxMsglen: MAX_MSGLEN,
  maxDatagram: MAX_DATAGRAM,
  maxPrecache: QW28_MAX_PRECACHE,
  defaultFlags: 0,

  maxEntityNumber: QW28_MAX_ENTITY_NUMBER,
  maxPacketEntities: MAX_PACKET_ENTITIES,

  //-- coordinates and angles -------------------------------------------------

  writeCoord(sb: SizeBuf, f: number): void {
    MSG_WriteCoord(sb, f);
  },

  writeAngle(sb: SizeBuf, f: number): void {
    qwWriteAngle(sb, f);
  },

  readCoord(): number {
    return MSG_ReadCoord();
  },

  readAngle(): number {
    return MSG_ReadAngle();
  },

  //-- server writes ----------------------------------------------------------

  writeProtocol(sb: SizeBuf): void {
    MSG_WriteLong(sb, PROTOCOL_VERSION);
  },

  writeStatic(sb: SizeBuf, state: EntityStateT): boolean {
    if (state.modelindex >= QW28_MAX_PRECACHE || state.frame & 0xff00) return false;

    MSG_WriteByte(sb, SvcOpsT.svc_spawnstatic);

    MSG_WriteByte(sb, state.modelindex);

    MSG_WriteByte(sb, state.frame);
    MSG_WriteByte(sb, state.colormap);
    MSG_WriteByte(sb, state.skin);
    for (let i = 0; i < 3; i++) {
      MSG_WriteCoord(sb, state.origin[i]);
      qwWriteAngle(sb, state.angles[i]);
    }

    return true;
  },

  writeStaticSound(sb: SizeBuf, org: Vec3, soundNum: number, vol: number, atten: number): boolean {
    if (soundNum >= QW28_MAX_PRECACHE) return false;

    MSG_WriteByte(sb, SvcOpsT.svc_spawnstaticsound);
    for (let i = 0; i < 3; i++) MSG_WriteCoord(sb, org[i]);

    MSG_WriteByte(sb, soundNum);

    MSG_WriteByte(sb, vol * 255);
    MSG_WriteByte(sb, atten * 64);

    return true;
  },

  // QW's svc_sound packs the two field bits into the top of the same short as
  // the entity/channel pair (SND_VOLUME 1<<15, SND_ATTENUATION 1<<14), where
  // NetQuake sends a separate leading mask byte -- so `s.ent` has thirteen
  // bits, not sixteen. `s.volume` is already 0..255 here (QW's PF_sound does
  // the *255 before SV_StartSound, WinQuake's does it on the wire).
  writeSound(sb: SizeBuf, s: SoundMessageT): boolean {
    if (s.ent >= 8192 || s.channel >= 8) return false;
    if (s.soundNum >= QW28_MAX_PRECACHE) return false;

    let chan = (s.ent << 3) | s.channel;
    if (s.volume !== DEFAULT_SOUND_PACKET_VOLUME) chan |= SND_VOLUME;
    if (s.attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) chan |= SND_ATTENUATION;

    MSG_WriteByte(sb, SvcOpsT.svc_sound);
    MSG_WriteShort(sb, chan);
    if (chan & SND_VOLUME) MSG_WriteByte(sb, s.volume);
    if (chan & SND_ATTENUATION) MSG_WriteByte(sb, s.attenuation * 64);
    MSG_WriteByte(sb, s.soundNum);
    for (let i = 0; i < 3; i++) MSG_WriteCoord(sb, s.origin[i]);

    return true;
  },

  writeEntityUpdate(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "svc_update (use writeDeltaEntity)");
  },

  writeBaseline(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "a NetQuake svc_spawnbaseline (use writeQwBaseline)");
  },

  writeClientdata(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "svc_clientdata (use svc_playerinfo)");
  },

  //-- client reads -----------------------------------------------------------

  readProtocolFlags(): number {
    return 0;
  },

  readEntityBits(): number {
    return qwNoNetQuakeOp(PROTOCOL_VERSION, "svc_update (use readDeltaEntityHeader)");
  },

  readEntityUpdateTail(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "svc_update (use readDeltaEntity)");
  },

  readBaseline(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "a NetQuake svc_spawnbaseline (use readQwBaseline)");
  },

  readClientdataBits(): number {
    return qwNoNetQuakeOp(PROTOCOL_VERSION, "svc_clientdata");
  },

  readClientdataTail(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "svc_clientdata");
  },

  // QW reads the volume and attenuation bytes BETWEEN the channel short and
  // the sound index, and takes the field mask from the channel short itself,
  // so the NetQuake-shaped "mask first, then this triple" split does not fit.
  readSoundHeader(): void {
    qwNoNetQuakeOp(PROTOCOL_VERSION, "NetQuake's svc_sound layout");
  },

  readStaticSoundIndex(): number {
    return MSG_ReadByte();
  },

  //-- QuakeWorld ops ---------------------------------------------------------

  writeDeltaUsercmd(sb: SizeBuf, from: QwUsercmdT, cmd: QwUsercmdT): void {
    qwWriteDeltaUsercmd(sb, from, cmd);
  },

  readDeltaUsercmd(from: QwUsercmdT, move: QwUsercmdT): void {
    qwReadDeltaUsercmd(from, move);
  },

  writeDeltaEntity(sb: SizeBuf, from: QwEntityStateT, to: QwEntityStateT, force: boolean): boolean {
    // send an update
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

    // the nine-bit entity number field cannot name this entity at all
    if (to.number >= QW28_MAX_ENTITY_NUMBER) return false;

    //
    // write the message
    //
    if (!bits && !force) return true; // nothing to send!
    const i = to.number | (bits & ~511);
    if (i & U_REMOVE) Sys_Error("U_REMOVE");
    MSG_WriteShort(sb, i);

    if (bits & U_MOREBITS) MSG_WriteByte(sb, bits & 255);
    if (bits & U_MODEL) MSG_WriteByte(sb, to.modelindex);
    if (bits & U_FRAME) MSG_WriteByte(sb, to.frame);
    if (bits & U_COLORMAP) MSG_WriteByte(sb, to.colormap);
    if (bits & U_SKIN) MSG_WriteByte(sb, to.skinnum);
    if (bits & U_EFFECTS) MSG_WriteByte(sb, to.effects);
    if (bits & U_ORIGIN1) MSG_WriteCoord(sb, to.origin[0]);
    if (bits & U_ANGLE1) qwWriteAngle(sb, to.angles[0]);
    if (bits & U_ORIGIN2) MSG_WriteCoord(sb, to.origin[1]);
    if (bits & U_ANGLE2) qwWriteAngle(sb, to.angles[1]);
    if (bits & U_ORIGIN3) MSG_WriteCoord(sb, to.origin[2]);
    if (bits & U_ANGLE3) qwWriteAngle(sb, to.angles[2]);

    return true;
  },

  writeRemoveEntity(sb: SizeBuf, entnum: number): void {
    MSG_WriteShort(sb, entnum | U_REMOVE);
  },

  writePacketEntitiesEnd(sb: SizeBuf): void {
    MSG_WriteShort(sb, 0); // end of packetentities
  },

  readDeltaEntityHeader(word: number, out: QwEntityWordT): void {
    out.clear();
    out.number = word & 511;

    let bits = word & ~511;

    if (bits & U_MOREBITS) {
      // read in the low order bits
      const i = MSG_ReadByte();
      bits |= i;
    }

    out.bits = bits;
    out.remove = (bits & U_REMOVE) !== 0;
  },

  readDeltaEntity(from: QwEntityStateT, to: QwEntityStateT, hdr: QwEntityWordT): void {
    // set everything to the state we are delta'ing from
    to.copyFrom(from);

    to.number = hdr.number;
    const bits = hdr.bits;
    to.flags = bits;

    if (bits & U_MODEL) to.modelindex = MSG_ReadByte();

    if (bits & U_FRAME) to.frame = MSG_ReadByte();

    if (bits & U_COLORMAP) to.colormap = MSG_ReadByte();

    if (bits & U_SKIN) to.skinnum = MSG_ReadByte();

    if (bits & U_EFFECTS) to.effects = MSG_ReadByte();

    if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadCoord();

    if (bits & U_ANGLE1) to.angles[0] = MSG_ReadAngle();

    if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadCoord();

    if (bits & U_ANGLE2) to.angles[1] = MSG_ReadAngle();

    if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadCoord();

    if (bits & U_ANGLE3) to.angles[2] = MSG_ReadAngle();

    // if (bits & U_SOLID)
    // {
    //	 FIXME
    // }
  },

  writeQwBaseline(sb: SizeBuf, es: QwEntityStateT): void {
    MSG_WriteByte(sb, es.modelindex);
    MSG_WriteByte(sb, es.frame);
    MSG_WriteByte(sb, es.colormap);
    MSG_WriteByte(sb, es.skinnum);
    for (let i = 0; i < 3; i++) {
      MSG_WriteCoord(sb, es.origin[i]);
      qwWriteAngle(sb, es.angles[i]);
    }
  },

  readQwBaseline(es: QwEntityStateT): void {
    es.modelindex = MSG_ReadByte();
    es.frame = MSG_ReadByte();
    es.colormap = MSG_ReadByte();
    es.skinnum = MSG_ReadByte();
    for (let i = 0; i < 3; i++) {
      es.origin[i] = MSG_ReadCoord();
      es.angles[i] = MSG_ReadAngle();
    }
  },

  writeModelIndex(sb: SizeBuf, n: number): void {
    MSG_WriteByte(sb, n);
  },

  readModelIndex(): number {
    return MSG_ReadByte();
  },

  writeSoundIndex(sb: SizeBuf, n: number): void {
    MSG_WriteByte(sb, n);
  },

  readSoundIndex(): number {
    return MSG_ReadByte();
  },

  writePrecacheCount(sb: SizeBuf, n: number): void {
    MSG_WriteByte(sb, n);
  },

  readPrecacheCount(): number {
    return MSG_ReadByte();
  },
};
