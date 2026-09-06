/*
The wide NetQuake wire format shared by FitzQuake 666 and RMQ 999.

666 and 999 are the same encoding; 999 differs only in (a) the protocol number,
(b) the `PRFL_*` flag word that follows it in svc_serverinfo and then steers
every coordinate and angle, and (c) whether SV_CreateBaseline / PF_makestatic
look up an entity's `scale` field at all (Ironwail does that only for RMQ:
sv_main.c's SV_CreateBaseline and pr_cmds.c's PF_makestatic both wrap the
lookup in `if (sv.protocol == PROTOCOL_RMQ)`). `makeWideCodec` below is that
one encoding, with those three differences as parameters; `fitz666.ts` and
`rmq999.ts` are the two instantiations.

Reference: Ironwail Quake/sv_main.c (SV_SendServerinfo, SV_StartSound,
SV_WriteEntitiesToClient, SV_WriteClientdataToMessage, SV_CreateBaseline),
Quake/pr_cmds.c (PF_makestatic, PF_ambientsound), Quake/cl_parse.c
(CL_ParseServerInfo, CL_ParseUpdate, CL_ParseBaseline, CL_ParseClientdata,
CL_ParseStartSoundPacket, CL_ParseStaticSound), Quake/common.c:762-809 and
934-978 (the flag-driven coord/angle encoders).

Deliberately not ported from Ironwail:
- SV_WriteClientdataToMessage's trailing "Alkaline 1.1" re-send of
  STAT_ACTIVEWEAPON as an svc_updatestat (sv_main.c:1165-1172). It is an
  Ironwail workaround for one mod, not part of FitzQuake's 666, and it would
  put bytes on the wire that a byte-vector check against FitzQuake/QuakeSpasm
  would not expect.
- `qcvm->effects_mask`: the re-release effects mask is a ruleset question, not
  a protocol one; this engine's server writes `effects` whole, as FitzQuake
  and QuakeSpasm do.

Taken from QuakeSpasm rather than Ironwail:
- writeClientdata's non-`standard_quake` weapon field (`sv_main.c:970-986`,
  also vkQuake `sv_main.c:2456-2472`): the search for the lowest set bit of
  `.weapon` fills a local that is written unconditionally, where WinQuake and
  Ironwail (`sv_main.c:1128-1142`) `MSG_WriteByte` inside the loop and so emit
  NOTHING when `.weapon` is 0. The client reads that byte unconditionally, so
  the WinQuake form truncates svc_clientdata by one byte and every later byte
  in the packet is read at the wrong offset -- reached by mg1's Horde mode,
  which spawns the player with `.weapon` 0. `standard_quake` content is
  untouched, and for any `.weapon` with a bit set the bytes are identical.
*/

import {
  MSG_ReadAngleFlags,
  MSG_ReadByte,
  MSG_ReadCoordFlags,
  MSG_ReadLong,
  MSG_ReadShort,
  MSG_WriteAngleFlags,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteCoordFlags,
  MSG_WriteLong,
  MSG_WriteShort,
  type SizeBuf,
} from "../sizebuf";
import type { Vec3 } from "../mathlib";
import { EntityStateT } from "../quakedef";
import {
  B_ALPHA,
  B_LARGEFRAME,
  B_LARGEMODEL,
  B_SCALE,
  DEFAULT_SOUND_PACKET_ATTENUATION,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_VIEWHEIGHT,
  ENTALPHA_DEFAULT,
  ENTSCALE_DEFAULT,
  Q_rint,
  SND_ATTENUATION,
  SND_LARGEENTITY,
  SND_LARGESOUND,
  SND_VOLUME,
  SU_AMMO2,
  SU_ARMOR,
  SU_ARMOR2,
  SU_CELLS2,
  SU_EXTEND1,
  SU_EXTEND2,
  SU_IDEALPITCH,
  SU_INWATER,
  SU_ITEMS,
  SU_NAILS2,
  SU_ONGROUND,
  SU_PUNCH1,
  SU_ROCKETS2,
  SU_SHELLS2,
  SU_VELOCITY1,
  SU_VIEWHEIGHT,
  SU_WEAPON,
  SU_WEAPON2,
  SU_WEAPONALPHA,
  SU_WEAPONFRAME,
  SU_WEAPONFRAME2,
  SvcOpsT,
  U_ALPHA,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_COLORMAP,
  U_EFFECTS,
  U_EXTEND1,
  U_EXTEND2,
  U_FRAME,
  U_FRAME2,
  U_LERPFINISH,
  U_LONGENTITY,
  U_MODEL,
  U_MODEL2,
  U_MOREBITS,
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_SCALE,
  U_SIGNAL,
  U_SKIN,
  U_STEP,
  svc_spawnbaseline2,
  svc_spawnstatic2,
  svc_spawnstaticsound2,
} from "../protocol";
import {
  type ClientdataT,
  type ClientdataTailT,
  type EntityUpdateT,
  type EntityUpdateTailT,
  type ProtocolCodec,
  type SoundHeaderT,
  type SoundMessageT,
} from "./codec";

// Ironwail quakedef.h:97-98. DATAGRAM_MTU (1400) caps what actually goes out
// to a non-local client; sv_main.ts applies it, exactly as Ironwail's
// SV_SendClientDatagram does.
export const WIDE_MAX_MSGLEN = 64000;
export const WIDE_MAX_DATAGRAM = 64000;

// The highest precache index the wide wire can name: model and sound indices
// are 16-bit there (B_LARGEMODEL / SND_LARGESOUND / U_MODEL2), so the real cap
// is MAX_MODELS / MAX_SOUNDS, not the protocol.
export const WIDE_MAX_PRECACHE = 65536;

export function makeWideCodec(protocol: number, name: string, defaultFlags: number, isRmq: boolean): ProtocolCodec {
  return {
    protocol,
    name,
    maxMsglen: WIDE_MAX_MSGLEN,
    maxDatagram: WIDE_MAX_DATAGRAM,
    maxPrecache: WIDE_MAX_PRECACHE,
    defaultFlags,

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

    writeProtocol(sb: SizeBuf, flags: number): void {
      MSG_WriteLong(sb, protocol);
      // mh - now send protocol flags so that the client knows the protocol
      // features to expect
      if (isRmq) MSG_WriteLong(sb, flags);
    },

    writeEntityUpdate(sb: SizeBuf, e: number, u: EntityUpdateT, flags: number): void {
      let bits = 0;

      for (let i = 0; i < 3; i++) {
        const miss = u.origin[i] - u.baseline.origin[i];
        if (miss < -0.1 || miss > 0.1) bits |= U_ORIGIN1 << i;
      }

      if (u.angles[0] !== u.baseline.angles[0]) bits |= U_ANGLE1;

      if (u.angles[1] !== u.baseline.angles[1]) bits |= U_ANGLE2;

      if (u.angles[2] !== u.baseline.angles[2]) bits |= U_ANGLE3;

      if (u.movetypeStep) bits |= U_STEP; // don't mess up the step animation

      if (u.baseline.colormap !== u.colormap) bits |= U_COLORMAP;

      if (u.baseline.skin !== u.skin) bits |= U_SKIN;

      if (u.baseline.frame !== u.frame) bits |= U_FRAME;

      if (u.baseline.effects !== u.effects) bits |= U_EFFECTS;

      if (u.baseline.modelindex !== u.modelindex) bits |= U_MODEL;

      if (u.baseline.alpha !== u.alpha) bits |= U_ALPHA;
      if (u.baseline.scale !== u.scale) bits |= U_SCALE;
      if (bits & U_FRAME && u.frame & 0xff00) bits |= U_FRAME2;
      if (bits & U_MODEL && u.modelindex & 0xff00) bits |= U_MODEL2;
      if (u.sendinterval) bits |= U_LERPFINISH;
      if (bits >= 65536) bits |= U_EXTEND1;
      if (bits >= 16777216) bits |= U_EXTEND2;

      if (e >= 256) bits |= U_LONGENTITY;

      if (bits >= 256) bits |= U_MOREBITS;

      //
      // write the message
      //
      MSG_WriteByte(sb, bits | U_SIGNAL);

      if (bits & U_MOREBITS) MSG_WriteByte(sb, bits >> 8);

      if (bits & U_EXTEND1) MSG_WriteByte(sb, bits >> 16);
      if (bits & U_EXTEND2) MSG_WriteByte(sb, bits >> 24);

      if (bits & U_LONGENTITY) MSG_WriteShort(sb, e);
      else MSG_WriteByte(sb, e);

      if (bits & U_MODEL) MSG_WriteByte(sb, u.modelindex);
      if (bits & U_FRAME) MSG_WriteByte(sb, u.frame);
      if (bits & U_COLORMAP) MSG_WriteByte(sb, u.colormap);
      if (bits & U_SKIN) MSG_WriteByte(sb, u.skin);
      if (bits & U_EFFECTS) MSG_WriteByte(sb, u.effects);
      if (bits & U_ORIGIN1) MSG_WriteCoordFlags(sb, u.origin[0], flags);
      if (bits & U_ANGLE1) MSG_WriteAngleFlags(sb, u.angles[0], flags);
      if (bits & U_ORIGIN2) MSG_WriteCoordFlags(sb, u.origin[1], flags);
      if (bits & U_ANGLE2) MSG_WriteAngleFlags(sb, u.angles[1], flags);
      if (bits & U_ORIGIN3) MSG_WriteCoordFlags(sb, u.origin[2], flags);
      if (bits & U_ANGLE3) MSG_WriteAngleFlags(sb, u.angles[2], flags);

      if (bits & U_ALPHA) MSG_WriteByte(sb, u.alpha);
      if (bits & U_SCALE) MSG_WriteByte(sb, u.scale);
      if (bits & U_FRAME2) MSG_WriteByte(sb, u.frame >> 8);
      if (bits & U_MODEL2) MSG_WriteByte(sb, u.modelindex >> 8);
      if (bits & U_LERPFINISH) MSG_WriteByte(sb, Q_rint(u.lerpfinish * 255));
    },

    writeBaseline(sb: SizeBuf, entnum: number, baseline: EntityStateT, flags: number): void {
      // decide which extra data needs to be sent
      let bits = 0;
      if (baseline.modelindex & 0xff00) bits |= B_LARGEMODEL;
      if (baseline.frame & 0xff00) bits |= B_LARGEFRAME;
      if (baseline.alpha !== ENTALPHA_DEFAULT) bits |= B_ALPHA;
      if (baseline.scale !== ENTSCALE_DEFAULT) bits |= B_SCALE;

      if (bits) MSG_WriteByte(sb, svc_spawnbaseline2);
      else MSG_WriteByte(sb, SvcOpsT.svc_spawnbaseline);

      MSG_WriteShort(sb, entnum);

      if (bits) MSG_WriteByte(sb, bits);

      if (bits & B_LARGEMODEL) MSG_WriteShort(sb, baseline.modelindex);
      else MSG_WriteByte(sb, baseline.modelindex);

      if (bits & B_LARGEFRAME) MSG_WriteShort(sb, baseline.frame);
      else MSG_WriteByte(sb, baseline.frame);

      MSG_WriteByte(sb, baseline.colormap);
      MSG_WriteByte(sb, baseline.skin);
      for (let i = 0; i < 3; i++) {
        MSG_WriteCoordFlags(sb, baseline.origin[i], flags);
        MSG_WriteAngleFlags(sb, baseline.angles[i], flags);
      }

      if (bits & B_ALPHA) MSG_WriteByte(sb, baseline.alpha);
      if (bits & B_SCALE) MSG_WriteByte(sb, baseline.scale);
    },

    writeStatic(sb: SizeBuf, state: EntityStateT, flags: number): boolean {
      let bits = 0;
      if (state.modelindex & 0xff00) bits |= B_LARGEMODEL;
      if (state.frame & 0xff00) bits |= B_LARGEFRAME;
      if (state.alpha !== ENTALPHA_DEFAULT) bits |= B_ALPHA;
      if (isRmq && state.scale !== ENTSCALE_DEFAULT) bits |= B_SCALE;

      if (bits) {
        MSG_WriteByte(sb, svc_spawnstatic2);
        MSG_WriteByte(sb, bits);
      } else {
        MSG_WriteByte(sb, SvcOpsT.svc_spawnstatic);
      }

      if (bits & B_LARGEMODEL) MSG_WriteShort(sb, state.modelindex);
      else MSG_WriteByte(sb, state.modelindex);

      if (bits & B_LARGEFRAME) MSG_WriteShort(sb, state.frame);
      else MSG_WriteByte(sb, state.frame);

      MSG_WriteByte(sb, state.colormap);
      MSG_WriteByte(sb, state.skin);
      for (let i = 0; i < 3; i++) {
        MSG_WriteCoordFlags(sb, state.origin[i], flags);
        MSG_WriteAngleFlags(sb, state.angles[i], flags);
      }

      if (bits & B_ALPHA) MSG_WriteByte(sb, state.alpha);
      if (bits & B_SCALE) MSG_WriteByte(sb, state.scale);

      return true;
    },

    writeStaticSound(sb: SizeBuf, org: Vec3, soundNum: number, vol: number, atten: number, flags: number): boolean {
      const large = soundNum > 255;

      if (large) MSG_WriteByte(sb, svc_spawnstaticsound2);
      else MSG_WriteByte(sb, SvcOpsT.svc_spawnstaticsound);

      for (let i = 0; i < 3; i++) MSG_WriteCoordFlags(sb, org[i], flags);

      if (large) MSG_WriteShort(sb, soundNum);
      else MSG_WriteByte(sb, soundNum);

      MSG_WriteByte(sb, vol * 255);
      MSG_WriteByte(sb, atten * 64);

      return true;
    },

    writeSound(sb: SizeBuf, s: SoundMessageT, flags: number): boolean {
      let field_mask = 0;
      if (s.volume !== DEFAULT_SOUND_PACKET_VOLUME) field_mask |= SND_VOLUME;
      if (s.attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) field_mask |= SND_ATTENUATION;

      if (s.ent >= 8192) field_mask |= SND_LARGEENTITY;
      if (s.soundNum >= 256 || s.channel >= 8) field_mask |= SND_LARGESOUND;

      // directed messages go only to the entity the are targeted on
      MSG_WriteByte(sb, SvcOpsT.svc_sound);
      MSG_WriteByte(sb, field_mask);
      if (field_mask & SND_VOLUME) MSG_WriteByte(sb, s.volume);
      if (field_mask & SND_ATTENUATION) MSG_WriteByte(sb, s.attenuation * 64);

      if (field_mask & SND_LARGEENTITY) {
        MSG_WriteShort(sb, s.ent);
        MSG_WriteByte(sb, s.channel);
      } else {
        MSG_WriteShort(sb, (s.ent << 3) | s.channel);
      }
      if (field_mask & SND_LARGESOUND) MSG_WriteShort(sb, s.soundNum);
      else MSG_WriteByte(sb, s.soundNum);

      for (let i = 0; i < 3; i++) MSG_WriteCoordFlags(sb, s.origin[i], flags);

      return true;
    },

    writeClientdata(sb: SizeBuf, cd: ClientdataT): void {
      let bits = 0;

      if (cd.viewheight !== DEFAULT_VIEWHEIGHT) bits |= SU_VIEWHEIGHT;

      if (cd.idealpitch) bits |= SU_IDEALPITCH;

      bits |= SU_ITEMS;

      if (cd.onground) bits |= SU_ONGROUND;

      if (cd.inwater) bits |= SU_INWATER;

      for (let i = 0; i < 3; i++) {
        if (cd.punchangle[i]) bits |= SU_PUNCH1 << i;
        if (cd.velocity[i]) bits |= SU_VELOCITY1 << i;
      }

      if (cd.weaponframe) bits |= SU_WEAPONFRAME;

      if (cd.armorvalue) bits |= SU_ARMOR;

      //	if (ent->v.weapon)
      bits |= SU_WEAPON;

      if (bits & SU_WEAPON && cd.weaponmodelindex & 0xff00) bits |= SU_WEAPON2;
      if (cd.armorvalue & 0xff00) bits |= SU_ARMOR2;
      if (cd.currentammo & 0xff00) bits |= SU_AMMO2;
      if (cd.ammo_shells & 0xff00) bits |= SU_SHELLS2;
      if (cd.ammo_nails & 0xff00) bits |= SU_NAILS2;
      if (cd.ammo_rockets & 0xff00) bits |= SU_ROCKETS2;
      if (cd.ammo_cells & 0xff00) bits |= SU_CELLS2;
      if (bits & SU_WEAPONFRAME && cd.weaponframe & 0xff00) bits |= SU_WEAPONFRAME2;
      if (bits & SU_WEAPON && cd.alpha !== ENTALPHA_DEFAULT) bits |= SU_WEAPONALPHA; // for now, weaponalpha = client entity alpha
      if (bits >= 65536) bits |= SU_EXTEND1;
      if (bits >= 16777216) bits |= SU_EXTEND2;

      // send the data

      MSG_WriteByte(sb, SvcOpsT.svc_clientdata);
      MSG_WriteShort(sb, bits);

      if (bits & SU_EXTEND1) MSG_WriteByte(sb, bits >> 16);
      if (bits & SU_EXTEND2) MSG_WriteByte(sb, bits >> 24);

      if (bits & SU_VIEWHEIGHT) MSG_WriteChar(sb, cd.viewheight);

      if (bits & SU_IDEALPITCH) MSG_WriteChar(sb, cd.idealpitch);

      for (let i = 0; i < 3; i++) {
        if (bits & (SU_PUNCH1 << i)) MSG_WriteChar(sb, cd.punchangle[i]);
        if (bits & (SU_VELOCITY1 << i)) MSG_WriteChar(sb, cd.velocity[i] / 16);
      }

      // [always sent]	if (bits & SU_ITEMS)
      MSG_WriteLong(sb, cd.items);

      if (bits & SU_WEAPONFRAME) MSG_WriteByte(sb, cd.weaponframe);
      if (bits & SU_ARMOR) MSG_WriteByte(sb, cd.armorvalue);
      if (bits & SU_WEAPON) MSG_WriteByte(sb, cd.weaponmodelindex);

      MSG_WriteShort(sb, cd.health);
      MSG_WriteByte(sb, cd.currentammo);
      MSG_WriteByte(sb, cd.ammo_shells);
      MSG_WriteByte(sb, cd.ammo_nails);
      MSG_WriteByte(sb, cd.ammo_rockets);
      MSG_WriteByte(sb, cd.ammo_cells);

      if (cd.standardQuake) {
        MSG_WriteByte(sb, cd.weapon);
      } else {
        let weapon = 0;
        for (let i = 0; i < 32; i++) {
          if ((cd.weapon | 0) & (1 << i)) {
            weapon = i;
            break;
          }
        }
        MSG_WriteByte(sb, weapon);
      }

      if (bits & SU_WEAPON2) MSG_WriteByte(sb, cd.weaponmodelindex >> 8);
      if (bits & SU_ARMOR2) MSG_WriteByte(sb, cd.armorvalue >> 8);
      if (bits & SU_AMMO2) MSG_WriteByte(sb, cd.currentammo >> 8);
      if (bits & SU_SHELLS2) MSG_WriteByte(sb, cd.ammo_shells >> 8);
      if (bits & SU_NAILS2) MSG_WriteByte(sb, cd.ammo_nails >> 8);
      if (bits & SU_ROCKETS2) MSG_WriteByte(sb, cd.ammo_rockets >> 8);
      if (bits & SU_CELLS2) MSG_WriteByte(sb, cd.ammo_cells >> 8);
      if (bits & SU_WEAPONFRAME2) MSG_WriteByte(sb, cd.weaponframe >> 8);
      if (bits & SU_WEAPONALPHA) MSG_WriteByte(sb, cd.alpha); // for now, weaponalpha = client entity alpha
    },

    readProtocolFlags(): number {
      // Only RMQ carries a flag word; FitzQuake's serverinfo goes straight
      // from the protocol number to maxclients.
      return isRmq ? MSG_ReadLong() >>> 0 : 0;
    },

    readEntityBits(bitsIn: number): number {
      let bits = bitsIn;
      if (bits & U_EXTEND1) bits |= MSG_ReadByte() << 16;
      if (bits & U_EXTEND2) bits |= MSG_ReadByte() << 24;
      return bits;
    },

    readEntityUpdateTail(bits: number, out: EntityUpdateTailT): void {
      out.clear();
      if (bits & U_ALPHA) {
        out.hasAlpha = true;
        out.alpha = MSG_ReadByte();
      }
      if (bits & U_SCALE) {
        out.hasScale = true;
        out.scale = MSG_ReadByte();
      }
      if (bits & U_FRAME2) {
        out.hasFrame2 = true;
        out.frameHigh = MSG_ReadByte();
      }
      if (bits & U_MODEL2) {
        out.hasModel2 = true;
        out.modelHigh = MSG_ReadByte();
      }
      if (bits & U_LERPFINISH) {
        out.hasLerpfinish = true;
        out.lerpfinish = MSG_ReadByte() / 255;
      }
    },

    readBaseline(baseline: EntityStateT, version: number, flags: number): void {
      const bits = version === 2 ? MSG_ReadByte() : 0;
      baseline.modelindex = bits & B_LARGEMODEL ? MSG_ReadShort() : MSG_ReadByte();
      baseline.frame = bits & B_LARGEFRAME ? MSG_ReadShort() : MSG_ReadByte();

      baseline.colormap = MSG_ReadByte();
      baseline.skin = MSG_ReadByte();
      for (let i = 0; i < 3; i++) {
        baseline.origin[i] = MSG_ReadCoordFlags(flags);
        baseline.angles[i] = MSG_ReadAngleFlags(flags);
      }

      baseline.alpha = bits & B_ALPHA ? MSG_ReadByte() : ENTALPHA_DEFAULT;
      baseline.scale = bits & B_SCALE ? MSG_ReadByte() : ENTSCALE_DEFAULT;
    },

    readClientdataBits(): number {
      let bits = MSG_ReadShort() & 0xffff; // (unsigned short)MSG_ReadShort()
      if (bits & SU_EXTEND1) bits |= MSG_ReadByte() << 16;
      if (bits & SU_EXTEND2) bits |= MSG_ReadByte() << 24;
      return bits;
    },

    readClientdataTail(bits: number, out: ClientdataTailT): void {
      out.clear();
      if (bits & SU_WEAPON2) out.weaponHigh = MSG_ReadByte();
      if (bits & SU_ARMOR2) out.armorHigh = MSG_ReadByte();
      if (bits & SU_AMMO2) out.ammoHigh = MSG_ReadByte();
      if (bits & SU_SHELLS2) out.shellsHigh = MSG_ReadByte();
      if (bits & SU_NAILS2) out.nailsHigh = MSG_ReadByte();
      if (bits & SU_ROCKETS2) out.rocketsHigh = MSG_ReadByte();
      if (bits & SU_CELLS2) out.cellsHigh = MSG_ReadByte();
      if (bits & SU_WEAPONFRAME2) out.weaponframeHigh = MSG_ReadByte();
      out.weaponalpha = bits & SU_WEAPONALPHA ? MSG_ReadByte() : ENTALPHA_DEFAULT;
    },

    readSoundHeader(fieldMask: number, out: SoundHeaderT): void {
      if (fieldMask & SND_LARGEENTITY) {
        out.ent = MSG_ReadShort() & 0xffff;
        out.channel = MSG_ReadByte();
      } else {
        const channel = MSG_ReadShort() & 0xffff;
        out.ent = channel >> 3;
        out.channel = channel & 7;
      }

      out.soundNum = fieldMask & SND_LARGESOUND ? MSG_ReadShort() & 0xffff : MSG_ReadByte();
    },

    readStaticSoundIndex(version: number): number {
      return version === 2 ? MSG_ReadShort() : MSG_ReadByte();
    },
  };
}
