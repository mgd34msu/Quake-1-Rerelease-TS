/*
QuakeWorld protocol 29 -- THIS ENGINE'S OWN EXTENSION, not id's.

Protocol 28 is the only QuakeWorld wire id shipped, and it is narrow in
exactly the places the wide NetQuake protocols (666/999) already fixed on
their side: nine bits of entity number (so no edict above 511 can ever be sent
to a client), byte-wide model and frame indices, byte counts in
`svc_modellist`/`svc_soundlist`, and 13.3 fixed-point coordinates bounded to
+-4096. There is no GPLv2 open reference for a wider QuakeWorld protocol in
this project's reference set (FTEQW is excluded by the charter), so everything
below is our own design, given its own protocol number so vanilla 28 stays
byte-identical, and negotiated rather than assumed.

Negotiation (see src/qw/client/cl_main.ts, src/qw/server/sv_main.ts and
sv_user.ts):

- The QuakeWorld `getchallenge`/`connect` handshake is untouched: the client
  still sends `connect 28 <qport> <challenge> "<userinfo>"`, so a vanilla
  server still accepts our client and a vanilla client still reaches ours.
- A wide-capable client advertises one extra userinfo key,
  `*wide 1`, through `Info_SetValueForStarKey`. A vanilla client sends no such
  key, and a vanilla server ignores it.
- The server's `sv_qwprotocol` cvar is `28`, `29` or `auto` (default `auto`).
  `28` always answers 28. `29` always answers 29. `auto` answers 29 when the
  loaded map actually needs the width -- more edicts than 28 can name, or more
  than 255 models or sounds precached -- and 28 otherwise.
- `svc_serverdata` then carries `29` where it carried `28`, followed by one
  extra long: the `PRFL_*` flag word, exactly as RMQ 999 does on the NetQuake
  side. A protocol-29 server sends `PRFL_INT32COORD | PRFL_SHORTANGLE`.
- A `.qwd` demo re-derives all of this from its recorded `svc_serverdata`,
  the same rule NetQuake demos follow.

Every op that differs from 28 (nothing else does):

  svc_serverdata     [long 29] then [long protocolflags]
  coordinates        [long] Q_rint(f*16)          (PRFL_INT32COORD)
  angles             [short] Q_rint(f*65536/360)  (PRFL_SHORTANGLE)
  packetentities     the leading short is 28's exactly; bit 7 of the
                     U_MOREBITS byte is new and means U_EXTEND: one more byte
                     of flags follows
  U_EXTEND byte      U_ENTITY2 1<<0, U_MODEL2 1<<1, U_FRAME2 1<<2,
                     U_ALPHA 1<<3, U_SCALE 1<<4 (bits 5-7 reserved, sent 0)
  entity number      nine bits in the short plus, with U_ENTITY2, a high byte
                     holding bits 9-15 -- 65535 instead of 511
  modelindex         a byte plus, with U_MODEL2, a high byte -- 65535
  frame              a byte plus, with U_FRAME2, a high byte -- 65535
  alpha / scale      one byte each, U_ALPHA / U_SCALE, in 666's ENTALPHA /
                     ENTSCALE encoding
  entity removal     28's `num | U_REMOVE` short when num < 512; above that,
                     the same short plus a U_MOREBITS byte carrying U_EXTEND,
                     an extend byte carrying U_ENTITY2, and the high byte
  svc_spawnbaseline  [short] model [short] frame [byte] colormap [byte] skin
                     [byte] alpha [byte] scale, then 3x(coord, angle)
  svc_spawnstatic    the same body as svc_spawnbaseline (QuakeWorld's
                     CL_ParseStatic literally calls CL_ParseBaseline)
  svc_spawnstaticsound  the sound index is a short
  svc_sound          the sound index is a short (the entity/channel short is
                     unchanged: 13 bits of entity, 3 of channel, two flag bits)
  svc_playerinfo     PF_MODEL's model index is a short
  svc_modellist      the leading "first index" and trailing "next index"
  svc_soundlist      counts are shorts
  maxPrecache        MAX_MODELS (8192) instead of 256
  maxEntityNumber    65536 instead of 512

The wide entity-number, model and frame fields are the reason 29 exists.
`alpha` and `scale` ride along because the state class carries them and the
NetQuake side already spends them; QuakeWorld's own progdefs (CRC 54730) has
no entvar to source either from, so a 29 server never sets them today and the
bits are never seen on the wire -- the encoding is pinned by
test/protocol_qw29.test.ts rather than by traffic.
*/

import {
  MSG_ReadByte,
  MSG_ReadCoordFlags,
  MSG_ReadAngleFlags,
  MSG_ReadLong,
  MSG_ReadShort,
  MSG_WriteByte,
  MSG_WriteCoordFlags,
  MSG_WriteAngleFlags,
  MSG_WriteLong,
  MSG_WriteShort,
  type SizeBuf,
} from "../sizebuf";
import type { Vec3 } from "../mathlib";
import type { EntityStateT } from "../quakedef";
import { Sys_Error } from "../../platform/sys";
import { PRFL_INT32COORD, PRFL_SHORTANGLE } from "../protocol";
import {
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  type QwEntityStateT,
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
import { MAX_MODELS } from "../../common/quakedef";
import type { QwEntityWordT, QwProtocolCodec, SoundMessageT } from "./codec";
import { qw28Codec, qwNoNetQuakeOp } from "./qw28";

export const PROTOCOL_QW_WIDE = 29;

// What a protocol-29 server advertises in svc_serverdata's flag word: the same
// pair Ironwail/vkQuake/QuakeSpasm choose for RMQ 999.
export const QW29_DEFAULT_FLAGS = PRFL_INT32COORD | PRFL_SHORTANGLE;

// Bit 7 of the U_MOREBITS byte, free in protocol 28 (28 defines U_ANGLE1
// through U_SOLID, bits 0-6, and bit 8 is swallowed by `bits & ~511` before
// the byte is written).
export const U_EXTEND = 1 << 7;

// The extend byte's own flags.
export const U_ENTITY2 = 1 << 0; // a high byte of entity number follows
export const U_MODEL2 = 1 << 1; // a high byte of modelindex follows
export const U_FRAME2 = 1 << 2; // a high byte of frame follows
export const U_ALPHA = 1 << 3;
export const U_SCALE = 1 << 4;

export const QW29_MAX_ENTITY_NUMBER = 65536;

function writeEntityHeader(sb: SizeBuf, entnum: number, bitsIn: number, ext: number): void {
  let bits = bitsIn;
  if (ext) bits |= U_EXTEND;
  if (bits & 511) bits |= U_MOREBITS;

  MSG_WriteShort(sb, (entnum & 511) | (bits & ~511));
  if (bits & U_MOREBITS) MSG_WriteByte(sb, bits & 255);
  if (bits & U_EXTEND) MSG_WriteByte(sb, ext);
  if (ext & U_ENTITY2) MSG_WriteByte(sb, (entnum >> 9) & 255);
}

export const qw29Codec: QwProtocolCodec = {
  ...qw28Codec,

  protocol: PROTOCOL_QW_WIDE,
  name: "QuakeWorld wide",
  maxPrecache: MAX_MODELS,
  defaultFlags: QW29_DEFAULT_FLAGS,
  maxEntityNumber: QW29_MAX_ENTITY_NUMBER,

  //-- coordinates and angles -------------------------------------------------

  writeCoord(sb: SizeBuf, f: number, flags: number): void {
    MSG_WriteCoordFlags(sb, f, flags);
  },

  writeAngle(sb: SizeBuf, f: number, flags: number): void {
    MSG_WriteAngleFlags(sb, f, flags);
  },

  readCoord(flags: number): number {
    return MSG_ReadCoordFlags(flags);
  },

  readAngle(flags: number): number {
    return MSG_ReadAngleFlags(flags);
  },

  //-- server writes ----------------------------------------------------------

  writeProtocol(sb: SizeBuf, flags: number): void {
    MSG_WriteLong(sb, PROTOCOL_QW_WIDE);
    MSG_WriteLong(sb, flags);
  },

  // QuakeWorld's CL_ParseStatic IS CL_ParseBaseline plus the opcode
  // (QW/client/cl_parse.c), so svc_spawnstatic's body has to stay
  // byte-identical to svc_spawnbaseline's on 29 the way it is on 28 --
  // alpha and scale included.
  writeStatic(sb: SizeBuf, state: EntityStateT, flags: number): boolean {
    if (state.modelindex >= MAX_MODELS || state.frame & 0xffff0000) return false;

    MSG_WriteByte(sb, SvcOpsT.svc_spawnstatic);

    MSG_WriteShort(sb, state.modelindex);
    MSG_WriteShort(sb, state.frame);
    MSG_WriteByte(sb, state.colormap);
    MSG_WriteByte(sb, state.skin);
    MSG_WriteByte(sb, state.alpha);
    MSG_WriteByte(sb, state.scale);
    for (let i = 0; i < 3; i++) {
      MSG_WriteCoordFlags(sb, state.origin[i], flags);
      MSG_WriteAngleFlags(sb, state.angles[i], flags);
    }

    return true;
  },

  writeStaticSound(sb: SizeBuf, org: Vec3, soundNum: number, vol: number, atten: number, flags: number): boolean {
    if (soundNum > 65535) return false;

    MSG_WriteByte(sb, SvcOpsT.svc_spawnstaticsound);
    for (let i = 0; i < 3; i++) MSG_WriteCoordFlags(sb, org[i], flags);

    MSG_WriteShort(sb, soundNum);

    MSG_WriteByte(sb, vol * 255);
    MSG_WriteByte(sb, atten * 64);

    return true;
  },

  writeSound(sb: SizeBuf, s: SoundMessageT, flags: number): boolean {
    if (s.ent >= 8192 || s.channel >= 8) return false;
    if (s.soundNum > 65535) return false;

    let chan = (s.ent << 3) | s.channel;
    if (s.volume !== DEFAULT_SOUND_PACKET_VOLUME) chan |= SND_VOLUME;
    if (s.attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) chan |= SND_ATTENUATION;

    MSG_WriteByte(sb, SvcOpsT.svc_sound);
    MSG_WriteShort(sb, chan);
    if (chan & SND_VOLUME) MSG_WriteByte(sb, s.volume);
    if (chan & SND_ATTENUATION) MSG_WriteByte(sb, s.attenuation * 64);
    MSG_WriteShort(sb, s.soundNum);
    for (let i = 0; i < 3; i++) MSG_WriteCoordFlags(sb, s.origin[i], flags);

    return true;
  },

  //-- client reads -----------------------------------------------------------

  readProtocolFlags(): number {
    return MSG_ReadLong();
  },

  readStaticSoundIndex(): number {
    return MSG_ReadShort() & 0xffff;
  },

  //-- QuakeWorld ops ---------------------------------------------------------

  writeDeltaEntity(sb: SizeBuf, from: QwEntityStateT, to: QwEntityStateT, force: boolean, flags: number): boolean {
    let bits = 0;
    let ext = 0;

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

    if (bits & U_MODEL && (to.modelindex & 0xff00) !== 0) ext |= U_MODEL2;
    if (bits & U_FRAME && (to.frame & 0xff00) !== 0) ext |= U_FRAME2;
    if (to.alpha !== from.alpha) ext |= U_ALPHA;
    if (to.scale !== from.scale) ext |= U_SCALE;

    if (to.flags & U_SOLID) bits |= U_SOLID;

    if (to.number >= QW29_MAX_ENTITY_NUMBER) return false;

    if (!bits && !ext && !force) return true; // nothing to send!

    // only once the record is actually going out, so a silent entity above
    // 511 still costs nothing
    if (to.number >= 512) ext |= U_ENTITY2;

    if (bits & U_REMOVE) Sys_Error("U_REMOVE");
    writeEntityHeader(sb, to.number, bits, ext);

    if (bits & U_MODEL) MSG_WriteByte(sb, to.modelindex & 255);
    if (bits & U_FRAME) MSG_WriteByte(sb, to.frame & 255);
    if (bits & U_COLORMAP) MSG_WriteByte(sb, to.colormap);
    if (bits & U_SKIN) MSG_WriteByte(sb, to.skinnum);
    if (bits & U_EFFECTS) MSG_WriteByte(sb, to.effects);
    if (bits & U_ORIGIN1) MSG_WriteCoordFlags(sb, to.origin[0], flags);
    if (bits & U_ANGLE1) MSG_WriteAngleFlags(sb, to.angles[0], flags);
    if (bits & U_ORIGIN2) MSG_WriteCoordFlags(sb, to.origin[1], flags);
    if (bits & U_ANGLE2) MSG_WriteAngleFlags(sb, to.angles[1], flags);
    if (bits & U_ORIGIN3) MSG_WriteCoordFlags(sb, to.origin[2], flags);
    if (bits & U_ANGLE3) MSG_WriteAngleFlags(sb, to.angles[2], flags);

    if (ext & U_MODEL2) MSG_WriteByte(sb, (to.modelindex >> 8) & 255);
    if (ext & U_FRAME2) MSG_WriteByte(sb, (to.frame >> 8) & 255);
    if (ext & U_ALPHA) MSG_WriteByte(sb, to.alpha);
    if (ext & U_SCALE) MSG_WriteByte(sb, to.scale);

    return true;
  },

  writeRemoveEntity(sb: SizeBuf, entnum: number): void {
    writeEntityHeader(sb, entnum, U_REMOVE, entnum >= 512 ? U_ENTITY2 : 0);
  },

  writePacketEntitiesEnd(sb: SizeBuf): void {
    MSG_WriteShort(sb, 0); // end of packetentities
  },

  readDeltaEntityHeader(word: number, out: QwEntityWordT): void {
    out.clear();
    let number = word & 511;

    let bits = word & ~511;

    if (bits & U_MOREBITS) bits |= MSG_ReadByte();

    let ext = 0;
    if (bits & U_EXTEND) {
      ext = MSG_ReadByte();
      if (ext & U_ENTITY2) number |= MSG_ReadByte() << 9;
    }

    out.bits = bits;
    out.ext = ext;
    out.number = number;
    out.remove = (bits & U_REMOVE) !== 0;
  },

  readDeltaEntity(from: QwEntityStateT, to: QwEntityStateT, hdr: QwEntityWordT, flags: number): void {
    to.copyFrom(from);

    to.number = hdr.number;
    const bits = hdr.bits;
    const ext = hdr.ext;
    to.flags = bits;

    if (bits & U_MODEL) to.modelindex = MSG_ReadByte();

    if (bits & U_FRAME) to.frame = MSG_ReadByte();

    if (bits & U_COLORMAP) to.colormap = MSG_ReadByte();

    if (bits & U_SKIN) to.skinnum = MSG_ReadByte();

    if (bits & U_EFFECTS) to.effects = MSG_ReadByte();

    if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadCoordFlags(flags);

    if (bits & U_ANGLE1) to.angles[0] = MSG_ReadAngleFlags(flags);

    if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadCoordFlags(flags);

    if (bits & U_ANGLE2) to.angles[1] = MSG_ReadAngleFlags(flags);

    if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadCoordFlags(flags);

    if (bits & U_ANGLE3) to.angles[2] = MSG_ReadAngleFlags(flags);

    if (ext & U_MODEL2) to.modelindex |= MSG_ReadByte() << 8;
    if (ext & U_FRAME2) to.frame |= MSG_ReadByte() << 8;
    if (ext & U_ALPHA) to.alpha = MSG_ReadByte();
    if (ext & U_SCALE) to.scale = MSG_ReadByte();
  },

  writeQwBaseline(sb: SizeBuf, es: QwEntityStateT, flags: number): void {
    MSG_WriteShort(sb, es.modelindex);
    MSG_WriteShort(sb, es.frame);
    MSG_WriteByte(sb, es.colormap);
    MSG_WriteByte(sb, es.skinnum);
    MSG_WriteByte(sb, es.alpha);
    MSG_WriteByte(sb, es.scale);
    for (let i = 0; i < 3; i++) {
      MSG_WriteCoordFlags(sb, es.origin[i], flags);
      MSG_WriteAngleFlags(sb, es.angles[i], flags);
    }
  },

  readQwBaseline(es: QwEntityStateT, flags: number): void {
    es.modelindex = MSG_ReadShort() & 0xffff;
    es.frame = MSG_ReadShort() & 0xffff;
    es.colormap = MSG_ReadByte();
    es.skinnum = MSG_ReadByte();
    es.alpha = MSG_ReadByte();
    es.scale = MSG_ReadByte();
    for (let i = 0; i < 3; i++) {
      es.origin[i] = MSG_ReadCoordFlags(flags);
      es.angles[i] = MSG_ReadAngleFlags(flags);
    }
  },

  writeModelIndex(sb: SizeBuf, n: number): void {
    MSG_WriteShort(sb, n);
  },

  readModelIndex(): number {
    return MSG_ReadShort() & 0xffff;
  },

  writeSoundIndex(sb: SizeBuf, n: number): void {
    MSG_WriteShort(sb, n);
  },

  readSoundIndex(): number {
    return MSG_ReadShort() & 0xffff;
  },

  writePrecacheCount(sb: SizeBuf, n: number): void {
    MSG_WriteShort(sb, n);
  },

  readPrecacheCount(): number {
    return MSG_ReadShort() & 0xffff;
  },

  //-- the NetQuake half, as in qw28.ts ---------------------------------------

  writeEntityUpdate(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "svc_update (use writeDeltaEntity)");
  },

  writeBaseline(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "a NetQuake svc_spawnbaseline (use writeQwBaseline)");
  },

  writeClientdata(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "svc_clientdata (use svc_playerinfo)");
  },

  readEntityBits(): number {
    return qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "svc_update (use readDeltaEntityHeader)");
  },

  readEntityUpdateTail(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "svc_update (use readDeltaEntity)");
  },

  readBaseline(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "a NetQuake svc_spawnbaseline (use readQwBaseline)");
  },

  readClientdataBits(): number {
    return qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "svc_clientdata");
  },

  readClientdataTail(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "svc_clientdata");
  },

  readSoundHeader(): void {
    qwNoNetQuakeOp(PROTOCOL_QW_WIDE, "NetQuake's svc_sound layout");
  },
};
