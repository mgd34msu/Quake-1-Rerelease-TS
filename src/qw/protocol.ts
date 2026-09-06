/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/protocol.h (GNU GPL v2 or later).

protocol.h -- communications protocols (QuakeWorld, protocol 28)

This is a separate wire protocol from WinQuake's (src/common/protocol.ts,
protocol 15): different svc_/clc_ numbering, a different entity_state_t and
usercmd_t shape, and a two-byte U_* entity-update bitfield instead of one.
Nothing here is re-exported from src/common/protocol.ts except the two
DEFAULT_SOUND_PACKET_* constants, which the C keeps byte-for-byte identical
between sound.h (WinQuake) and protocol.h (QW).

Deviations from PORTING.md / the C source:
- `MAX_CLIENTS`, `UPDATE_BACKUP`, `UPDATE_MASK`, and `PORT_CLIENT`/`PORT_MASTER`/
  `PORT_SERVER` are declared in QW/client/protocol.h, not bothdefs.h (checked
  against the actual header; the unit brief's placement of them under
  bothdefs.ts does not match the source). They are ported here, where the C
  actually declares them; src/qw/bothdefs.ts does not redefine them.
- `svc_*`/`clc_*` are `#define`s with no typedef, same as WinQuake's. Per
  PORTING.md and the sibling module's precedent (src/common/protocol.ts), they
  become TS enums (`SvcOpsT`/`ClcOpsT`) with every member given its exact C
  value explicitly, including the gaps the C leaves commented out
  (svc_version=4, svc_updatename=13, svc_clientdata=15, svc_updatecolors=17,
  svc_particle=18, svc_spawnbinary=21, svc_signonnum=25, clc_doublemove=2 are
  all absent from the C and are not members here).
- `PRINT_LOW`/`PRINT_MEDIUM`/`PRINT_HIGH`/`PRINT_CHAT` are defined twice in the
  C, byte-identical, in both protocol.h and bothdefs.h. This module is their
  canonical home (svc_print's argument); src/qw/bothdefs.ts's file header notes
  the duplication rather than re-exporting from here, so both foundation
  modules stay leaf-level (neither imports the other), exactly mirroring how
  the two C headers each carry their own copy of the macro.
- `TE_SPIKE`..`TE_TELEPORT` (0-11) are numerically identical to WinQuake's, but
  slots 12/13 are reused for different meanings (`TE_BLOOD`/`TE_LIGHTNINGBLOOD`
  here vs `TE_EXPLOSION2`/`TE_BEAM` in protocol 15). All fourteen are defined
  fresh in this module rather than partially re-exported, since the wire value
  is the same number with a different meaning depending on which protocol is
  active -- reusing src/common/protocol.ts's constants here would be silently
  wrong for 12/13 and redundant-but-harmless for 0-11; defining all of them
  locally keeps the module self-contained and avoids that trap entirely.
- `entity_state_t` (QW) has different fields from WinQuake's `EntityStateT`
  (adds `number`/`flags`, renames `skin` to `skinnum`) and is ported as a new
  class `QwEntityStateT`, not a re-export or subclass of the common one.
- `usercmd_t` (QW) is a different shape from src/server/server.ts's `UsercmdT`
  (msec/angles/forwardmove/sidemove/upmove/buttons/impulse vs WinQuake's
  viewangles/forwardmove/sidemove/upmove) and is ported as `QwUsercmdT`. QW's
  `common.c` MSG_ReadDeltaUsercmd/WriteDeltaUsercmd (Q002, src/qw/common.ts) is
  the module that reads/writes it over the wire.
*/

import { type Vec3, vec3 } from "../common/mathlib";
import { DEFAULT_SOUND_PACKET_VOLUME, DEFAULT_SOUND_PACKET_ATTENUATION } from "../common/protocol";

export { DEFAULT_SOUND_PACKET_VOLUME, DEFAULT_SOUND_PACKET_ATTENUATION };

export const PROTOCOL_VERSION = 28;

export const QW_CHECK_HASH = 0x5157;

//=========================================

export const PORT_CLIENT = 27001;
export const PORT_MASTER = 27000;
export const PORT_SERVER = 27500;

//=========================================

// out of band message id bytes
// M = master, S = server, C = client, A = any
export const S2C_CHALLENGE = "c";
export const S2C_CONNECTION = "j";
export const A2A_PING = "k"; // respond with an A2A_ACK
export const A2A_ACK = "l"; // general acknowledgement without info
export const A2A_NACK = "m"; // [+ comment] general failure
export const A2A_ECHO = "e"; // for echoing
export const A2C_PRINT = "n"; // print a message on client

export const S2M_HEARTBEAT = "a"; // + serverinfo + userlist + fraglist
export const A2C_CLIENT_COMMAND = "B"; // + command line
export const S2M_SHUTDOWN = "C";

//==================
// note that there are some defs.qc that mirror to these numbers
// also related to svc_strings[] in cl_parse
//==================

//
// server to client
//
export enum SvcOpsT {
  svc_bad = 0,
  svc_nop = 1,
  svc_disconnect = 2,
  svc_updatestat = 3, // [byte] [byte]
  svc_setview = 5, // [short] entity number
  svc_sound = 6, // <see code>
  svc_print = 8, // [byte] id [string] null terminated string
  svc_stufftext = 9, // [string] stuffed into client's console buffer
  // the string should be \n terminated
  svc_setangle = 10, // [angle3] set the view angle to this absolute value

  svc_serverdata = 11, // [long] protocol ...
  svc_lightstyle = 12, // [byte] [string]
  svc_updatefrags = 14, // [byte] [short]
  svc_stopsound = 16, // <see code>
  svc_damage = 19,

  svc_spawnstatic = 20,
  //	svc_spawnbinary		21
  svc_spawnbaseline = 22,

  svc_temp_entity = 23, // variable
  svc_setpause = 24, // [byte] on / off
  //	svc_signonnum		25	// [byte]  used for the signon sequence

  svc_centerprint = 26, // [string] to put in center of the screen

  svc_killedmonster = 27,
  svc_foundsecret = 28,

  svc_spawnstaticsound = 29, // [coord3] [byte] samp [byte] vol [byte] aten

  svc_intermission = 30, // [vec3_t] origin [vec3_t] angle
  svc_finale = 31, // [string] text

  svc_cdtrack = 32, // [byte] track
  svc_sellscreen = 33,

  svc_smallkick = 34, // set client punchangle to 2
  svc_bigkick = 35, // set client punchangle to 4

  svc_updateping = 36, // [byte] [short]
  svc_updateentertime = 37, // [byte] [float]

  svc_updatestatlong = 38, // [byte] [long]

  svc_muzzleflash = 39, // [short] entity

  svc_updateuserinfo = 40, // [byte] slot [long] uid
  // [string] userinfo

  svc_download = 41, // [short] size [size bytes]
  svc_playerinfo = 42, // variable
  svc_nails = 43, // [byte] num [48 bits] xyzpy 12 12 12 4 8
  svc_chokecount = 44, // [byte] packets choked
  svc_modellist = 45, // [strings]
  svc_soundlist = 46, // [strings]
  svc_packetentities = 47, // [...]
  svc_deltapacketentities = 48, // [...]
  svc_maxspeed = 49, // maxspeed change, for prediction
  svc_entgravity = 50, // gravity change, for prediction
  svc_setinfo = 51, // setinfo on a client
  svc_serverinfo = 52, // serverinfo
  svc_updatepl = 53, // [byte] [byte]
}

//
// client to server
//
export enum ClcOpsT {
  clc_bad = 0,
  clc_nop = 1,
  //	clc_doublemove	2
  clc_move = 3, // [[usercmd_t]
  clc_stringcmd = 4, // [string] message
  clc_delta = 5, // [byte] sequence number, requests delta compression of message
  clc_tmove = 6, // teleport request, spectator only
  clc_upload = 7, // teleport request, spectator only
}

//==============================================

// playerinfo flags from server
// playerinfo allways sends: playernum, flags, origin[] and framenumber
export const PF_MSEC = 1 << 0;
export const PF_COMMAND = 1 << 1;
export const PF_VELOCITY1 = 1 << 2;
export const PF_VELOCITY2 = 1 << 3;
export const PF_VELOCITY3 = 1 << 4;
export const PF_MODEL = 1 << 5;
export const PF_SKINNUM = 1 << 6;
export const PF_EFFECTS = 1 << 7;
export const PF_WEAPONFRAME = 1 << 8; // only sent for view player
export const PF_DEAD = 1 << 9; // don't block movement any more
export const PF_GIB = 1 << 10; // offset the view height differently
export const PF_NOGRAV = 1 << 11; // don't apply gravity for prediction

//==============================================

// if the high bit of the client to server byte is set, the low bits are
// client move cmd bits
// ms and angle2 are allways sent, the others are optional
export const CM_ANGLE1 = 1 << 0;
export const CM_ANGLE3 = 1 << 1;
export const CM_FORWARD = 1 << 2;
export const CM_SIDE = 1 << 3;
export const CM_UP = 1 << 4;
export const CM_BUTTONS = 1 << 5;
export const CM_IMPULSE = 1 << 6;
export const CM_ANGLE2 = 1 << 7;

//==============================================

// the first 16 bits of a packetentities update holds 9 bits
// of entity number and 7 bits of flags
export const U_ORIGIN1 = 1 << 9;
export const U_ORIGIN2 = 1 << 10;
export const U_ORIGIN3 = 1 << 11;
export const U_ANGLE2 = 1 << 12;
export const U_FRAME = 1 << 13;
export const U_REMOVE = 1 << 14; // REMOVE this entity, don't add it
export const U_MOREBITS = 1 << 15;

// if MOREBITS is set, these additional flags are read in next
export const U_ANGLE1 = 1 << 0;
export const U_ANGLE3 = 1 << 1;
export const U_MODEL = 1 << 2;
export const U_COLORMAP = 1 << 3;
export const U_SKIN = 1 << 4;
export const U_EFFECTS = 1 << 5;
export const U_SOLID = 1 << 6; // the entity should be solid for prediction

//==============================================

// a sound with no channel is a local only sound
// the sound field has bits 0-2: channel, 3-12: entity
export const SND_VOLUME = 1 << 15; // a byte
export const SND_ATTENUATION = 1 << 14; // a byte

// svc_print messages have an id, so messages can be filtered
export const PRINT_LOW = 0;
export const PRINT_MEDIUM = 1;
export const PRINT_HIGH = 2;
export const PRINT_CHAT = 3; // also go to chat buffer

//
// temp entity events
//
export const TE_SPIKE = 0;
export const TE_SUPERSPIKE = 1;
export const TE_GUNSHOT = 2;
export const TE_EXPLOSION = 3;
export const TE_TAREXPLOSION = 4;
export const TE_LIGHTNING1 = 5;
export const TE_LIGHTNING2 = 6;
export const TE_WIZSPIKE = 7;
export const TE_KNIGHTSPIKE = 8;
export const TE_LIGHTNING3 = 9;
export const TE_LAVASPLASH = 10;
export const TE_TELEPORT = 11;
export const TE_BLOOD = 12;
export const TE_LIGHTNINGBLOOD = 13;

/*
==========================================================

  ELEMENTS COMMUNICATED ACROSS THE NET

==========================================================
*/

export const MAX_CLIENTS = 32;

export const UPDATE_BACKUP = 64; // copies of entity_state_t to keep buffered
// must be power of two
export const UPDATE_MASK = UPDATE_BACKUP - 1;

// entity_state_t is the information conveyed from the server
// in an update message
export class QwEntityStateT {
  number = 0; // edict index

  flags = 0; // nolerp, etc
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
  modelindex = 0;
  frame = 0;
  colormap = 0;
  skinnum = 0;
  effects = 0;

  clear(): void {
    this.number = 0;
    this.flags = 0;
    this.origin[0] = this.origin[1] = this.origin[2] = 0;
    this.angles[0] = this.angles[1] = this.angles[2] = 0;
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skinnum = 0;
    this.effects = 0;
  }
}

export const MAX_PACKET_ENTITIES = 64; // doesn't count nails

export class PacketEntitiesT {
  num_entities = 0;
  entities: QwEntityStateT[] = makeArray(MAX_PACKET_ENTITIES, () => new QwEntityStateT());
}

export class QwUsercmdT {
  msec = 0; // byte
  angles: Vec3 = vec3();
  forwardmove = 0; // short
  sidemove = 0; // short
  upmove = 0; // short
  buttons = 0; // byte
  impulse = 0; // byte
}

function makeArray<T>(n: number, make: () => T): T[] {
  const a: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}
