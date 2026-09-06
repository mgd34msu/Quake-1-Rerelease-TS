/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/protocol.h (GNU GPL v2 or later).

protocol.h -- communications protocols

Deviations from the C source:
- `svc_*` and `clc_*` are `#define`s in the C with no typedef name. They cross
  the wire, so PORTING.md makes them TS enums; the enum names `SvcOpsT`/`ClcOpsT`
  follow Quake 2's `svc_ops_e`/`clc_ops_e` and the sibling port's naming, and
  every member keeps its exact C name and value. Value 21 (`svc_spawnbinary`) is
  commented out in the C and is therefore absent, so every member is given its
  value explicitly. TE_* stay `export const` (PORTING.md: `#define` constants
  become `export const`); the C gives them no enum either.
- DEFAULT_SOUND_PACKET_VOLUME and DEFAULT_SOUND_PACKET_ATTENUATION are declared
  in WinQuake/sound.h, not protocol.h. The unit brief places them here because
  they are the wire defaults SV_StartSound omits and CL_ParseStartSoundPacket
  substitutes (sv_main.c:155, cl_parse.c:116). src/client/sound.ts must import
  them from here rather than redeclare them.
- The `#ifdef QUAKE2` TE_IMPLOSION/TE_RAILTRAIL pair is dropped: PORTING.md drops
  the QUAKE2 prototype blocks, and protocol 15 never carries those codes.
*/

export const PROTOCOL_VERSION = 15;

// if the high bit of the servercmd is set, the low bits are fast update flags:
export const U_MOREBITS = 1 << 0;
export const U_ORIGIN1 = 1 << 1;
export const U_ORIGIN2 = 1 << 2;
export const U_ORIGIN3 = 1 << 3;
export const U_ANGLE2 = 1 << 4;
export const U_NOLERP = 1 << 5; // don't interpolate movement
export const U_FRAME = 1 << 6;
export const U_SIGNAL = 1 << 7; // just differentiates from other updates

// svc_update can pass all of the fast update bits, plus more
export const U_ANGLE1 = 1 << 8;
export const U_ANGLE3 = 1 << 9;
export const U_MODEL = 1 << 10;
export const U_COLORMAP = 1 << 11;
export const U_SKIN = 1 << 12;
export const U_EFFECTS = 1 << 13;
export const U_LONGENTITY = 1 << 14;

export const SU_VIEWHEIGHT = 1 << 0;
export const SU_IDEALPITCH = 1 << 1;
export const SU_PUNCH1 = 1 << 2;
export const SU_PUNCH2 = 1 << 3;
export const SU_PUNCH3 = 1 << 4;
export const SU_VELOCITY1 = 1 << 5;
export const SU_VELOCITY2 = 1 << 6;
export const SU_VELOCITY3 = 1 << 7;
//define	SU_AIMENT		(1<<8)  AVAILABLE BIT
export const SU_ITEMS = 1 << 9;
export const SU_ONGROUND = 1 << 10; // no data follows, the bit is it
export const SU_INWATER = 1 << 11; // no data follows, the bit is it
export const SU_WEAPONFRAME = 1 << 12;
export const SU_ARMOR = 1 << 13;
export const SU_WEAPON = 1 << 14;

// a sound with no channel is a local only sound
export const SND_VOLUME = 1 << 0; // a byte
export const SND_ATTENUATION = 1 << 1; // a byte
export const SND_LOOPING = 1 << 2; // a long

// defaults for clientinfo messages
export const DEFAULT_VIEWHEIGHT = 22;

export const DEFAULT_SOUND_PACKET_VOLUME = 255;
export const DEFAULT_SOUND_PACKET_ATTENUATION = 1.0;

// game types sent by serverinfo
// these determine which intermission screen plays
export const GAME_COOP = 0;
export const GAME_DEATHMATCH = 1;

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
  svc_updatestat = 3, // [byte] [long]
  svc_version = 4, // [long] server version
  svc_setview = 5, // [short] entity number
  svc_sound = 6, // <see code>
  svc_time = 7, // [float] server time
  svc_print = 8, // [string] null terminated string
  svc_stufftext = 9, // [string] stuffed into client's console buffer
  // the string should be \n terminated
  svc_setangle = 10, // [angle3] set the view angle to this absolute value

  svc_serverinfo = 11, // [long] version
  // [string] signon string
  // [string]..[0]model cache
  // [string]...[0]sounds cache
  svc_lightstyle = 12, // [byte] [string]
  svc_updatename = 13, // [byte] [string]
  svc_updatefrags = 14, // [byte] [short]
  svc_clientdata = 15, // <shortbits + data>
  svc_stopsound = 16, // <see code>
  svc_updatecolors = 17, // [byte] [byte]
  svc_particle = 18, // [vec3] <variable>
  svc_damage = 19,

  svc_spawnstatic = 20,
  //	svc_spawnbinary		21
  svc_spawnbaseline = 22,

  svc_temp_entity = 23,

  svc_setpause = 24, // [byte] on / off
  svc_signonnum = 25, // [byte]  used for the signon sequence

  svc_centerprint = 26, // [string] to put in center of the screen

  svc_killedmonster = 27,
  svc_foundsecret = 28,

  svc_spawnstaticsound = 29, // [coord3] [byte] samp [byte] vol [byte] aten

  svc_intermission = 30, // [string] music
  svc_finale = 31, // [string] music [string] text

  svc_cdtrack = 32, // [byte] track [byte] looptrack
  svc_sellscreen = 33,

  svc_cutscene = 34,
}

//
// client to server
//
export enum ClcOpsT {
  clc_bad = 0,
  clc_nop = 1,
  clc_disconnect = 2,
  clc_move = 3, // [usercmd_t]
  clc_stringcmd = 4, // [string] message
}

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
export const TE_EXPLOSION2 = 12;

// PGM 01/21/97
export const TE_BEAM = 13;
// PGM 01/21/97

//============================================================================
// U3 additions: FitzQuake 666 / RMQ 999 (Ironwail Quake/protocol.h). Protocol
// 15's own constants above are untouched; everything below is only read by a
// wide codec.

export const PROTOCOL_NETQUAKE = 15;
export const PROTOCOL_FITZQUAKE = 666;
export const PROTOCOL_RMQ = 999;

// PROTOCOL_RMQ protocol flags
export const PRFL_SHORTANGLE = 1 << 1;
export const PRFL_FLOATANGLE = 1 << 2;
export const PRFL_24BITCOORD = 1 << 3;
export const PRFL_FLOATCOORD = 1 << 4;
export const PRFL_EDICTSCALE = 1 << 5;
export const PRFL_ALPHASANITY = 1 << 6; // cleanup insanity with alpha
export const PRFL_INT32COORD = 1 << 7;
export const PRFL_MOREFLAGS = 1 << 31; // not supported

// The set an RMQ client accepts (cl_parse.c's `supportedflags`).
export const PRFL_SUPPORTED = PRFL_SHORTANGLE | PRFL_FLOATANGLE | PRFL_24BITCOORD | PRFL_FLOATCOORD | PRFL_EDICTSCALE | PRFL_INT32COORD;

// U_NOLERP under its FitzQuake name: the bit is only ever set for
// MOVETYPE_STEP, and 666/999 give it lerp meaning on the client.
export const U_STEP = U_NOLERP;

export const U_EXTEND1 = 1 << 15;
export const U_ALPHA = 1 << 16; // 1 byte, uses ENTALPHA_ENCODE, not sent if equal to baseline
export const U_FRAME2 = 1 << 17; // 1 byte, this is .frame & 0xFF00 (second byte)
export const U_MODEL2 = 1 << 18; // 1 byte, this is .modelindex & 0xFF00 (second byte)
export const U_LERPFINISH = 1 << 19; // 1 byte, 0.0-1.0 maps to 0-255, this is ent->v.nextthink - sv.time
export const U_SCALE = 1 << 20; // 1 byte, for PROTOCOL_RMQ PRFL_EDICTSCALE
export const U_UNUSED21 = 1 << 21;
export const U_UNUSED22 = 1 << 22;
export const U_EXTEND2 = 1 << 23; // another byte to follow, future expansion

export const SU_EXTEND1 = 1 << 15; // another byte to follow
export const SU_WEAPON2 = 1 << 16; // 1 byte, this is .weaponmodel & 0xFF00 (second byte)
export const SU_ARMOR2 = 1 << 17; // 1 byte, this is .armorvalue & 0xFF00 (second byte)
export const SU_AMMO2 = 1 << 18; // 1 byte, this is .currentammo & 0xFF00 (second byte)
export const SU_SHELLS2 = 1 << 19; // 1 byte, this is .ammo_shells & 0xFF00 (second byte)
export const SU_NAILS2 = 1 << 20; // 1 byte, this is .ammo_nails & 0xFF00 (second byte)
export const SU_ROCKETS2 = 1 << 21; // 1 byte, this is .ammo_rockets & 0xFF00 (second byte)
export const SU_CELLS2 = 1 << 22; // 1 byte, this is .ammo_cells & 0xFF00 (second byte)
export const SU_EXTEND2 = 1 << 23; // another byte to follow
export const SU_WEAPONFRAME2 = 1 << 24; // 1 byte, this is .weaponframe & 0xFF00 (second byte)
export const SU_WEAPONALPHA = 1 << 25; // 1 byte, alpha for weaponmodel, uses ENTALPHA_ENCODE
export const SU_EXTEND3 = 1 << 31; // another byte to follow, future expansion

export const SND_LARGEENTITY = 1 << 3; // a short + byte (instead of just a short)
export const SND_LARGESOUND = 1 << 4; // a short soundindex (instead of a byte)

// flags for entity baseline messages
export const B_LARGEMODEL = 1 << 0; // modelindex is short instead of byte
export const B_LARGEFRAME = 1 << 1; // frame is short instead of byte
export const B_ALPHA = 1 << 2; // 1 byte, uses ENTALPHA_ENCODE, not sent if ENTALPHA_DEFAULT
export const B_SCALE = 1 << 3;

// alpha encoding
export const ENTALPHA_DEFAULT = 0; // entity's alpha is "default" (i.e. water obeys r_wateralpha)
export const ENTALPHA_ZERO = 1; // entity is invisible (lowest possible alpha)
export const ENTALPHA_ONE = 255; // entity is fully opaque (highest possible alpha)

// server convert to byte to send to client
export function ENTALPHA_ENCODE(a: number): number {
  if (a === 0) return ENTALPHA_DEFAULT;
  const v = a * 254 + 1;
  return Q_rint(v < 1 ? 1 : v > 255 ? 255 : v);
}

// client convert to float for rendering
export function ENTALPHA_DECODE(a: number): number {
  return a === ENTALPHA_DEFAULT ? 1.0 : (a - 1) / 254;
}

// server convert to float for savegame
export function ENTALPHA_TOSAVE(a: number): number {
  return a === ENTALPHA_DEFAULT ? 0.0 : a === ENTALPHA_ZERO ? -1.0 : (a - 1) / 254;
}

export const ENTSCALE_DEFAULT = 16; // equivalent to float 1.0 due to byte packing

export function ENTSCALE_ENCODE(a: number): number {
  return a ? a * ENTSCALE_DEFAULT : ENTSCALE_DEFAULT;
}

export function ENTSCALE_DECODE(a: number): number {
  return a / ENTSCALE_DEFAULT;
}

// mathlib.h's `Q_rint` (round half away from zero for positives, the C's
// `(x > 0 ? (int)(x + 0.5) : (int)(x - 0.5))`). mathlib.ts has no port of it;
// only the protocol encoders below need it, so it lives here.
export function Q_rint(x: number): number {
  return x > 0 ? Math.trunc(x + 0.5) : Math.trunc(x - 0.5);
}

// FitzQuake / re-release server messages. The enum above holds protocol 15's
// own opcodes exactly as protocol.h does; these are the codes 666/999 add,
// kept as `export const` because SvcOpsT's members must stay the 15 set (a
// value outside it is not a member of the enum and cl_parse's svc_strings
// table is indexed by the 15 set).
export const svc_skybox = 37; // [string] name
export const svc_bf = 40;
export const svc_fog = 41; // [byte] density [byte] red [byte] green [byte] blue [float] time
export const svc_spawnbaseline2 = 42; // support for large modelindex, large framenum, alpha, using flags
export const svc_spawnstatic2 = 43; // support for large modelindex, large framenum, alpha, using flags
export const svc_spawnstaticsound2 = 44; // [coord3] [short] samp [byte] vol [byte] aten
