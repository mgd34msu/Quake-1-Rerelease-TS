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
