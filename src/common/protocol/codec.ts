/*
Protocol codec seam (ARCHITECTURE.md "Protocol layer"), modeled on
quake-2-re-ts's `src/qcommon/protocol/codec.ts`, which is in turn modeled on
q2proto's per-protocol function table: one interface holding ONLY the
operations that actually differ between the protocols this engine speaks, with
byte-identical operations staying plain shared functions.

Codecs: `nq15.ts` (NetQuake 15, extracted verbatim from the seed's own
sv_main.ts/cl_parse.ts/sizebuf.ts code -- an extraction, not a rewrite),
`fitz666.ts` (FitzQuake 666), `rmq999.ts` (RMQ 999 = 666 plus the `PRFL_*`
flag word), `qw28.ts` (QuakeWorld 28, extracted the same way out of
src/qw/server/sv_ents.ts, sv_send.ts, sv_user.ts and src/qw/client/cl_ents.ts,
cl_parse.ts, cl_input.ts) and `qw29.ts` (this engine's own wide QuakeWorld
variant).

QuakeWorld's message set is not NetQuake's: it has no `svc_clientdata`, its
entity updates are a delta between two *sent* states inside an
`svc_packetentities` envelope rather than a delta against a baseline inside
`svc_update`, and it carries two ops NetQuake has no equivalent of at all
(`clc_move`'s delta usercmd, `svc_playerinfo`). The ops the two wires do
share -- coordinates, angles, the protocol number, `svc_sound`,
`svc_spawnstatic`, `svc_spawnstaticsound` -- keep the members already declared
below, and the QuakeWorld-only ops are declared as OPTIONAL members at the end
of the interface, so nothing an existing NetQuake caller reaches changes
shape. The NetQuake-only members a QuakeWorld codec cannot honestly implement
(`writeEntityUpdate`, `writeBaseline`, `writeClientdata`, `readEntityBits`,
`readEntityUpdateTail`, `readBaseline`, `readClientdataBits`,
`readClientdataTail`, `readSoundHeader`) throw in qw28.ts/qw29.ts rather than
pretend; no QuakeWorld caller reaches them, and a NetQuake caller can only
reach a QuakeWorld codec by asking `getCodec` for 28 or 29, which
`CL_ParseServerInfo`/`SV_Protocol_f` never do.

---------------------------------------------------------------------------
Op inventory vs Ironwail
---------------------------------------------------------------------------

INCLUDED (the ops whose bytes differ between 15, 666 and 999):

  writeProtocol          <- SV_SendServerinfo's `MSG_WriteLong (sv.protocol)`
                            plus RMQ's extra `MSG_WriteLong (sv.protocolflags)`
                            (sv_main.c:418-420)
  writeEntityUpdate      <- SV_WriteEntitiesToClient's per-entity body
                            (sv_main.c:826-953): the bits word AND its payload,
                            because 666/999 add U_ALPHA/U_SCALE/U_FRAME2/
                            U_MODEL2/U_LERPFINISH/U_EXTEND1/U_EXTEND2
  writeBaseline          <- SV_CreateBaseline's per-entity body (svc_spawnbaseline
                            vs svc_spawnbaseline2 + B_* flags)
  writeStatic            <- PF_makestatic (svc_spawnstatic vs svc_spawnstatic2)
  writeStaticSound       <- PF_ambientsound (svc_spawnstaticsound vs ...sound2)
  writeSound             <- SV_StartSound (SND_LARGEENTITY/SND_LARGESOUND)
  writeClientdata        <- SV_WriteClientdataToMessage (SU_EXTEND1/2 and the
                            eight *2 high-byte fields)
  writeCoord/writeAngle  <- MSG_WriteCoord/MSG_WriteAngle by protocolflags
                            (common.c:762-797)
  readProtocolFlags      <- CL_ParseServerInfo's RMQ flag word (cl_parse.c:315-327)
  readEntityBits         <- CL_ParseUpdate's U_EXTEND1/U_EXTEND2 bytes
  readEntityUpdateTail   <- CL_ParseUpdate's alpha/scale/frame2/model2/lerpfinish
  readBaseline           <- CL_ParseBaseline(ent, version)
  readClientdataBits     <- CL_ParseClientdata's `bits` short + SU_EXTEND1/2
  readClientdataTail     <- CL_ParseClientdata's SU_*2 high bytes + SU_WEAPONALPHA
  readSoundHeader        <- CL_ParseStartSoundPacket's entity/channel/soundnum
  readCoord/readAngle    <- MSG_ReadCoord/MSG_ReadAngle by protocolflags

  maxMsglen / maxDatagram / maxPrecache: the per-protocol WIRE sizes. Protocol
  15 keeps WinQuake's 8000/1024 and its 256-entry precache tables; 666/999 use
  the wide 64000/64000 and the full MAX_MODELS/MAX_SOUNDS tables.

EXCLUDED (identical on every protocol here, so no seam):
  svc_time, svc_print, svc_stufftext, svc_setangle (the angles go through
  writeAngle, the opcode does not), svc_lightstyle, svc_updatename,
  svc_updatefrags, svc_updatecolors, svc_particle, svc_damage, svc_temp_entity,
  svc_setpause, svc_signonnum, svc_centerprint, svc_killedmonster,
  svc_foundsecret, svc_intermission, svc_finale, svc_cdtrack, svc_sellscreen,
  svc_cutscene, svc_nop, svc_disconnect, svc_updatestat, svc_setview,
  svc_stopsound, and every clc_* the client sends. Each is a fixed byte layout
  in Ironwail's sv_main.c/host_cmd.c/cl_input.c with no `sv.protocol` test
  around it (grepped); routing them through a codec would add a seam with three
  identical implementations.

---------------------------------------------------------------------------
Flags are a parameter, not codec state
---------------------------------------------------------------------------
Every codec is a stateless singleton, so the `PRFL_*` word travels as an
explicit argument exactly as it does in Ironwail (`MSG_WriteCoord (sb, f,
sv.protocolflags)`). Only rmq999 ever reads it; nq15 and fitz666 ignore it,
matching `sv.protocolflags = 0` for those protocols.
*/

import type { SizeBuf } from "../sizebuf";
import type { Vec3 } from "../mathlib";
import { vec3 } from "../mathlib";
import { EntityStateT } from "../quakedef";
import { ENTALPHA_DEFAULT, ENTSCALE_DEFAULT } from "../protocol";
import type { QwEntityStateT, QwUsercmdT } from "../../qw/protocol";

//============================================================================
// Data carriers. Callers fill a reused instance and hand it to the codec, so
// no per-entity allocation happens on the send path.

// One entity's current server-side state, as SV_WriteEntitiesToClient reads it
// off the edict, plus the baseline it is delta'd against.
export class EntityUpdateT {
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
  modelindex = 0;
  frame = 0;
  colormap = 0;
  skin = 0;
  effects = 0;
  alpha: number = ENTALPHA_DEFAULT; // already ENTALPHA_ENCODE'd
  scale: number = ENTSCALE_DEFAULT; // already ENTSCALE_ENCODE'd
  movetypeStep = false; // ent->v.movetype == MOVETYPE_STEP
  sendinterval = false; // Ironwail's ent->sendinterval (U_LERPFINISH gate)
  lerpfinish = 0; // ent->v.nextthink - sv.time
  baseline: EntityStateT = new EntityStateT();
}

// SV_WriteClientdataToMessage's view of the player edict.
export class ClientdataT {
  viewheight = 0;
  idealpitch = 0;
  punchangle: Vec3 = vec3();
  velocity: Vec3 = vec3();
  items = 0;
  onground = false;
  inwater = false;
  weaponframe = 0;
  armorvalue = 0;
  weaponmodelindex = 0;
  health = 0;
  currentammo = 0;
  ammo_shells = 0;
  ammo_nails = 0;
  ammo_rockets = 0;
  ammo_cells = 0;
  weapon = 0;
  standardQuake = true;
  alpha: number = ENTALPHA_DEFAULT; // the player entity's alpha, reused as weaponalpha
}

// SV_StartSound's message, after the precache lookup.
export class SoundMessageT {
  ent = 0;
  channel = 0;
  soundNum = 0;
  volume = 0;
  attenuation = 0;
  origin: Vec3 = vec3();
}

// What CL_ParseUpdate's protocol-varying tail decodes.
export class EntityUpdateTailT {
  hasAlpha = false;
  alpha: number = ENTALPHA_DEFAULT;
  hasScale = false;
  scale: number = ENTSCALE_DEFAULT;
  hasFrame2 = false;
  frameHigh = 0; // the byte, not yet shifted
  hasModel2 = false;
  modelHigh = 0;
  hasLerpfinish = false;
  lerpfinish = 0; // the raw byte / 255, added to ent.msgtime by the caller

  clear(): void {
    this.hasAlpha = false;
    this.alpha = ENTALPHA_DEFAULT;
    this.hasScale = false;
    this.scale = ENTSCALE_DEFAULT;
    this.hasFrame2 = false;
    this.frameHigh = 0;
    this.hasModel2 = false;
    this.modelHigh = 0;
    this.hasLerpfinish = false;
    this.lerpfinish = 0;
  }
}

// What CL_ParseClientdata's protocol-varying tail decodes: the high byte of
// each widened stat, and the weapon-model alpha.
export class ClientdataTailT {
  weaponHigh = 0;
  armorHigh = 0;
  ammoHigh = 0;
  shellsHigh = 0;
  nailsHigh = 0;
  rocketsHigh = 0;
  cellsHigh = 0;
  weaponframeHigh = 0;
  weaponalpha: number = ENTALPHA_DEFAULT;

  clear(): void {
    this.weaponHigh = 0;
    this.armorHigh = 0;
    this.ammoHigh = 0;
    this.shellsHigh = 0;
    this.nailsHigh = 0;
    this.rocketsHigh = 0;
    this.cellsHigh = 0;
    this.weaponframeHigh = 0;
    this.weaponalpha = ENTALPHA_DEFAULT;
  }
}

// CL_ParseStartSoundPacket's entity/channel/soundnum triple.
export class SoundHeaderT {
  ent = 0;
  channel = 0;
  soundNum = 0;
}

// One record's header inside an `svc_packetentities`/`svc_deltapacketentities`
// envelope, after every bits word the protocol puts in front of the payload
// has been consumed: QuakeWorld 28's single short, or 29's short plus its
// U_MOREBITS byte plus its U_EXTEND byte plus the high byte of a wide entity
// number. `bits` is the protocol's own flag word with the entity-number field
// masked out, which is what CL_ParseDelta stores in `to.flags`.
export class QwEntityWordT {
  bits = 0;
  ext = 0; // the protocol-29 extend byte; always 0 on 28
  number = 0;
  remove = false;

  clear(): void {
    this.bits = 0;
    this.ext = 0;
    this.number = 0;
    this.remove = false;
  }
}

//============================================================================

export interface ProtocolCodec {
  // The number that goes on the wire in svc_serverinfo / svc_version.
  readonly protocol: number;
  readonly name: string;

  // Wire sizes. `maxPrecache` is the highest model/sound precache index this
  // protocol can name (256 for 15: the index is a byte).
  readonly maxMsglen: number;
  readonly maxDatagram: number;
  readonly maxPrecache: number;

  // The `PRFL_*` word a server running this protocol advertises.
  readonly defaultFlags: number;

  //-- coordinates and angles -------------------------------------------------
  writeCoord(sb: SizeBuf, f: number, flags: number): void;
  writeAngle(sb: SizeBuf, f: number, flags: number): void;
  readCoord(flags: number): number;
  readAngle(flags: number): number;

  //-- server writes ----------------------------------------------------------
  // svc_serverinfo's protocol number (and, for 999, the flag word after it).
  writeProtocol(sb: SizeBuf, flags: number): void;
  // One entity's delta update, opening byte through the last payload byte.
  writeEntityUpdate(sb: SizeBuf, e: number, u: EntityUpdateT, flags: number): void;
  // svc_spawnbaseline / svc_spawnbaseline2 for one edict. `baseline` is
  // normalized in place first for protocol 15 (see nq15.ts).
  writeBaseline(sb: SizeBuf, entnum: number, baseline: EntityStateT, flags: number): void;
  // svc_spawnstatic / svc_spawnstatic2 (PF_makestatic). Returns false when the
  // protocol cannot name this model or frame, which is Ironwail's "can't
  // display the correct model & frame, so don't show it at all" early return.
  writeStatic(sb: SizeBuf, state: EntityStateT, flags: number): boolean;
  // svc_spawnstaticsound / svc_spawnstaticsound2 (PF_ambientsound). Returns
  // false when the protocol cannot name this sound index.
  writeStaticSound(sb: SizeBuf, org: Vec3, soundNum: number, vol: number, atten: number, flags: number): boolean;
  // svc_sound. Returns false when the protocol cannot name this entity or
  // sound at all, which is Ironwail's "don't send any info protocol can't
  // support" early return.
  writeSound(sb: SizeBuf, s: SoundMessageT, flags: number): boolean;
  // svc_clientdata.
  writeClientdata(sb: SizeBuf, cd: ClientdataT, flags: number): void;

  //-- client reads -----------------------------------------------------------
  // The `PRFL_*` word after the protocol number in svc_serverinfo (0 unless 999).
  readProtocolFlags(): number;
  // Extends the low 16 bits of an entity update's bit word with U_EXTEND1/2.
  readEntityBits(bits: number): number;
  // The alpha/scale/frame2/model2/lerpfinish tail of an entity update.
  readEntityUpdateTail(bits: number, out: EntityUpdateTailT): void;
  // svc_spawnbaseline (version 1) / svc_spawnbaseline2 (version 2).
  readBaseline(baseline: EntityStateT, version: number, flags: number): void;
  // svc_clientdata's bit word, including the SU_EXTEND1/2 bytes.
  readClientdataBits(): number;
  // The SU_*2 high bytes and SU_WEAPONALPHA at the end of svc_clientdata.
  readClientdataTail(bits: number, out: ClientdataTailT): void;
  // svc_sound's entity/channel/soundnum, given the already-read field mask.
  readSoundHeader(fieldMask: number, out: SoundHeaderT): void;
  // svc_spawnstaticsound (version 1) / svc_spawnstaticsound2 (version 2).
  readStaticSoundIndex(version: number): number;

  //==========================================================================
  // QuakeWorld-only ops. Optional so the three NetQuake codecs stay exactly
  // what they were; qw28.ts and qw29.ts implement every one of them.

  // The first entity number this protocol CANNOT name in a packetentities
  // record (512 on 28: nine bits in the leading short). An entity at or above
  // it is not sent.
  readonly maxEntityNumber?: number;
  // protocol.h's MAX_PACKET_ENTITIES: how many entity states one
  // svc_packetentities can carry.
  readonly maxPacketEntities?: number;

  // clc_move's / svc_playerinfo's delta usercmd (QW common.c).
  writeDeltaUsercmd?(sb: SizeBuf, from: QwUsercmdT, cmd: QwUsercmdT): void;
  readDeltaUsercmd?(from: QwUsercmdT, move: QwUsercmdT): void;

  // One record inside svc_packetentities (SV_WriteDelta). Returns false when
  // the protocol cannot name this entity, which is the wire's own limit and
  // not an error: the entity is left out of the packet.
  writeDeltaEntity?(sb: SizeBuf, from: QwEntityStateT, to: QwEntityStateT, force: boolean, flags: number): boolean;
  // "this entity is gone", SV_EmitPacketEntities' `oldnum | U_REMOVE`.
  writeRemoveEntity?(sb: SizeBuf, entnum: number): void;
  // The zero word that closes an svc_packetentities.
  writePacketEntitiesEnd?(sb: SizeBuf): void;
  // Given the leading short already read (nonzero: zero ends the packet),
  // consume the rest of the record's header and fill `out`.
  readDeltaEntityHeader?(word: number, out: QwEntityWordT): void;
  // The payload after that header, delta'd from `from`.
  readDeltaEntity?(from: QwEntityStateT, to: QwEntityStateT, hdr: QwEntityWordT, flags: number): void;

  // svc_spawnbaseline over a QW entity_state_t (SV_CreateBaseline /
  // CL_ParseBaseline). The opcode byte and the entity number are the caller's.
  writeQwBaseline?(sb: SizeBuf, es: QwEntityStateT, flags: number): void;
  readQwBaseline?(es: QwEntityStateT, flags: number): void;

  // A model precache index on the wire (svc_playerinfo's PF_MODEL,
  // svc_spawnstatic): a byte on 28, a short on 29.
  writeModelIndex?(sb: SizeBuf, n: number): void;
  readModelIndex?(): number;
  // A sound precache index (svc_sound, svc_spawnstaticsound).
  writeSoundIndex?(sb: SizeBuf, n: number): void;
  readSoundIndex?(): number;
  // svc_modellist / svc_soundlist's leading "first index" and trailing "next
  // index" counts: a byte on 28, a short on 29.
  writePrecacheCount?(sb: SizeBuf, n: number): void;
  readPrecacheCount?(): number;
}

// A codec that speaks QuakeWorld: every optional member above, required. The
// two QuakeWorld codecs declare themselves as this, so a QuakeWorld caller
// asking `getQwCodec` for one reaches the ops directly instead of narrowing a
// possibly-undefined member at every call.
export type QwProtocolCodec = ProtocolCodec &
  Required<
    Pick<
      ProtocolCodec,
      | "maxEntityNumber"
      | "maxPacketEntities"
      | "writeDeltaUsercmd"
      | "readDeltaUsercmd"
      | "writeDeltaEntity"
      | "writeRemoveEntity"
      | "writePacketEntitiesEnd"
      | "readDeltaEntityHeader"
      | "readDeltaEntity"
      | "writeQwBaseline"
      | "readQwBaseline"
      | "writeModelIndex"
      | "readModelIndex"
      | "writeSoundIndex"
      | "readSoundIndex"
      | "writePrecacheCount"
      | "readPrecacheCount"
    >
  >;
