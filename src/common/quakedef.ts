/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/quakedef.h (GNU GPL v2 or later).

quakedef.h -- primary header for client

Deviations from PORTING.md / the C source:
- quakedef.h is mostly `#include` lines pulling in every other header; those are
  dropped (PORTING.md: one module per C file, `#include` lines are dropped). The
  `extern` declarations at the bottom (host_parms, host_frametime, realtime,
  isDedicated, the Host_ and Chase_ prototypes, the sys_ticrate/developer cvars)
  belong to host.ts, chase.ts and platform/sys.ts and are declared there, not here.
- `byte` is `typedef unsigned char byte` in common.h, not quakedef.h; the unit
  brief places the alias here. common.ts should import it rather than redeclare.
  `qboolean` becomes plain `boolean` per PORTING.md and gets no alias.
- The compile-time-only defines are resolved rather than exported: `QUAKE_GAME`
  is a bare marker whose only effect is gating bspfile.h's utility-only block
  (dropped in bspfile.ts); `id386` and `UNALIGNED_OK` are 0 in this port because
  PORTING.md takes the portable non-asm path, so the branches they gate
  (r_sky.c's unaligned reads, every `#if !id386` fallback) are the ported ones;
  `GLTEST`, `PARANOID`, `IDGODS` and `WINDED` are undefined; `VID_LockBuffer`/
  `VID_UnlockBuffer` are the non-_WIN32 empty macros. `UNUSED(x)` has no TS
  meaning. The `#ifdef QUAKE2` GAMENAME branch is dropped per PORTING.md
  (both branches are "id1" anyway).
- `IT_SIGIL1..4` keep the C's `1<<28`..`1<<31` expressions, so IT_SIGIL4 is
  -2147483648 exactly as C's signed `int` yields; `&` against it behaves
  identically. RIT_SUPERHEALTH keeps the C's decimal 2147483648 literal (the C
  constant is `unsigned int`); JS `&` coerces it to the same bit pattern.
*/

import type { Vec3 } from "./mathlib";

export type Byte = number;

export const VERSION = 1.09;
export const GLQUAKE_VERSION = 1.0;
export const D3DQUAKE_VERSION = 0.01;
export const WINQUAKE_VERSION = 0.996;
export const LINUX_VERSION = 1.3;
export const X11_VERSION = 1.1;

export const GAMENAME = "id1"; // directory to look in by default

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const CACHE_SIZE = 32; // used to align key data structures

export const MINIMUM_MEMORY = 0x550000;
export const MINIMUM_MEMORY_LEVELPAK = MINIMUM_MEMORY + 0x100000;

export const MAX_NUM_ARGVS = 50;

// up / down
export const PITCH = 0;

// left / right
export const YAW = 1;

// fall over
export const ROLL = 2;

export const MAX_QPATH = 64; // max length of a quake game pathname
export const MAX_OSPATH = 128; // max length of a filesystem pathname

export const ON_EPSILON = 0.1; // point on plane side epsilon

export const MAX_MSGLEN = 8000; // max length of a reliable message
export const MAX_DATAGRAM = 1024; // max length of unreliable message

//
// per-level limits
//
export const MAX_EDICTS = 600; // FIXME: ouch! ouch! ouch!
export const MAX_LIGHTSTYLES = 64;
export const MAX_MODELS = 256; // these are sent over the net as bytes
export const MAX_SOUNDS = 256; // so they cannot be blindly increased

export const SAVEGAME_COMMENT_LENGTH = 39;

export const MAX_STYLESTRING = 64;

//
// stats are integers communicated to the client by the server
//
export const MAX_CL_STATS = 32;
export const STAT_HEALTH = 0;
export const STAT_FRAGS = 1;
export const STAT_WEAPON = 2;
export const STAT_AMMO = 3;
export const STAT_ARMOR = 4;
export const STAT_WEAPONFRAME = 5;
export const STAT_SHELLS = 6;
export const STAT_NAILS = 7;
export const STAT_ROCKETS = 8;
export const STAT_CELLS = 9;
export const STAT_ACTIVEWEAPON = 10;
export const STAT_TOTALSECRETS = 11;
export const STAT_TOTALMONSTERS = 12;
export const STAT_SECRETS = 13; // bumped on client side by svc_foundsecret
export const STAT_MONSTERS = 14; // bumped by svc_killedmonster

// stock defines

export const IT_SHOTGUN = 1;
export const IT_SUPER_SHOTGUN = 2;
export const IT_NAILGUN = 4;
export const IT_SUPER_NAILGUN = 8;
export const IT_GRENADE_LAUNCHER = 16;
export const IT_ROCKET_LAUNCHER = 32;
export const IT_LIGHTNING = 64;
export const IT_SUPER_LIGHTNING = 128;
export const IT_SHELLS = 256;
export const IT_NAILS = 512;
export const IT_ROCKETS = 1024;
export const IT_CELLS = 2048;
export const IT_AXE = 4096;
export const IT_ARMOR1 = 8192;
export const IT_ARMOR2 = 16384;
export const IT_ARMOR3 = 32768;
export const IT_SUPERHEALTH = 65536;
export const IT_KEY1 = 131072;
export const IT_KEY2 = 262144;
export const IT_INVISIBILITY = 524288;
export const IT_INVULNERABILITY = 1048576;
export const IT_SUIT = 2097152;
export const IT_QUAD = 4194304;
export const IT_SIGIL1 = 1 << 28;
export const IT_SIGIL2 = 1 << 29;
export const IT_SIGIL3 = 1 << 30;
export const IT_SIGIL4 = 1 << 31;

//===========================================
//rogue changed and added defines

export const RIT_SHELLS = 128;
export const RIT_NAILS = 256;
export const RIT_ROCKETS = 512;
export const RIT_CELLS = 1024;
export const RIT_AXE = 2048;
export const RIT_LAVA_NAILGUN = 4096;
export const RIT_LAVA_SUPER_NAILGUN = 8192;
export const RIT_MULTI_GRENADE = 16384;
export const RIT_MULTI_ROCKET = 32768;
export const RIT_PLASMA_GUN = 65536;
export const RIT_ARMOR1 = 8388608;
export const RIT_ARMOR2 = 16777216;
export const RIT_ARMOR3 = 33554432;
export const RIT_LAVA_NAILS = 67108864;
export const RIT_PLASMA_AMMO = 134217728;
export const RIT_MULTI_ROCKETS = 268435456;
export const RIT_SHIELD = 536870912;
export const RIT_ANTIGRAV = 1073741824;
export const RIT_SUPERHEALTH = 2147483648;

//MED 01/04/97 added hipnotic defines
//===========================================
//hipnotic added defines
export const HIT_PROXIMITY_GUN_BIT = 16;
export const HIT_MJOLNIR_BIT = 7;
export const HIT_LASER_CANNON_BIT = 23;
export const HIT_PROXIMITY_GUN = 1 << HIT_PROXIMITY_GUN_BIT;
export const HIT_MJOLNIR = 1 << HIT_MJOLNIR_BIT;
export const HIT_LASER_CANNON = 1 << HIT_LASER_CANNON_BIT;
export const HIT_WETSUIT = 1 << (23 + 2);
export const HIT_EMPATHY_SHIELDS = 1 << (23 + 3);

//===========================================

export const MAX_SCOREBOARD = 16;
export const MAX_SCOREBOARDNAME = 32;

export const SOUND_CHANNELS = 8;

export class EntityStateT {
  origin: Vec3 = new Float32Array(3);
  angles: Vec3 = new Float32Array(3);
  modelindex = 0;
  frame = 0;
  colormap = 0;
  skin = 0;
  effects = 0;

  clear(): void {
    this.origin[0] = this.origin[1] = this.origin[2] = 0;
    this.angles[0] = this.angles[1] = this.angles[2] = 0;
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
  }

  // `*a = *b` on an entity_state_t.
  copyFrom(src: EntityStateT): void {
    this.origin[0] = src.origin[0];
    this.origin[1] = src.origin[1];
    this.origin[2] = src.origin[2];
    this.angles[0] = src.angles[0];
    this.angles[1] = src.angles[1];
    this.angles[2] = src.angles[2];
    this.modelindex = src.modelindex;
    this.frame = src.frame;
    this.colormap = src.colormap;
    this.skin = src.skin;
    this.effects = src.effects;
  }
}

//=============================================================================

// the host system specifies the base of the directory tree, the
// command line parms passed to the program, and the amount of memory
// available for the program to use

export class QuakeParmsT {
  basedir = "";
  cachedir: string | null = null; // for development over ISDN lines
  argc = 0;
  argv: string[] = [];
  membase: ArrayBuffer | null = null;
  memsize = 0;
}

// PORTING.md's QuakeWorld track ruling: "Small deltas fold into the landed
// module under a runtime flag `qw.active`... set true by the QW entry points
// (src/qw/main_cl.ts, src/qw/main_sv.ts) before Host_Init." This is the port's
// equivalent of the `#ifdef QUAKEWORLD` id never wrote -- the C keeps two
// separate source trees (WinQuake and QW/client / QW/server) instead. No C
// source line: this flag exists only in this port.
// `serveronly`: QW's own `#ifndef SERVERONLY` compile-time split (qwcl links
// without it, qwsv's Makefile defines it) between the two QW binaries that
// share this file's `qw.active`-gated deltas. Same "no C source line" idiom
// as `active` above; default false (qwcl), set true by src/qw/main_sv.ts
// (qwsv) before Host_Init/SV_Init.
export const qw = { active: false, serveronly: false };
