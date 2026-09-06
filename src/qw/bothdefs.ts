/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/bothdefs.h (GNU GPL v2 or later).

bothdefs.h -- defs common to client and server (QuakeWorld)

Where a name already exists in src/common/quakedef.ts with the same C value,
it is re-exported rather than redefined; where the value differs, the QW
value is defined here under the C name, with a comment on the collision. QW
modules import these from here, not from src/common/quakedef.ts.

Deviations from PORTING.md / the C source:
- `GLQUAKE_VERSION`/`VERSION`/`LINUX_VERSION` are the only version macros
  bothdefs.h declares (QW dropped `D3DQUAKE_VERSION`/`WINQUAKE_VERSION`/
  `X11_VERSION`, which are WinQuake-quakedef.h-only and stay there).
  `VERSION` (2.40) and `LINUX_VERSION` (0.98) both differ from WinQuake's
  (1.09 / 1.30) and are defined fresh here; `GLQUAKE_VERSION` (1.00) is
  unchanged and re-exported.
- `id386`/`UNALIGNED_OK`/`SERVERONLY`-gating and `UNUSED(x)` carry no TS
  meaning, same rationale as src/common/quakedef.ts's own header comment
  (portable non-asm path, no compiler-warning workaround needed) -- dropped.
- `MAX_CLIENTS`, `UPDATE_BACKUP`, `UPDATE_MASK`, and `PORT_CLIENT`/
  `PORT_MASTER`/`PORT_SERVER` are declared in QW/client/protocol.h, not
  bothdefs.h (checked against the actual header, which does not mention them
  at all) -- ported in src/qw/protocol.ts instead, not re-declared here. This
  corrects the unit brief's guess at their location.
- `PRINT_LOW`/`PRINT_MEDIUM`/`PRINT_HIGH`/`PRINT_CHAT` are declared twice in
  the C, byte-identical, in both bothdefs.h and protocol.h. src/qw/protocol.ts
  is their canonical home (svc_print's argument); not re-declared here, so
  this module stays a leaf import (no dependency on protocol.ts) exactly as
  bothdefs.h itself has no #include of protocol.h.
- `STAT_FRAGS` (1), `STAT_WEAPONFRAME` (5) and `STAT_VIEWHEIGHT` (16) are all
  `//define`-commented-out in the C (i.e. removed from the QW stat set) and
  are not ported; `STAT_ITEMS` (15) is new in QW and is defined here.
- `MAX_INFO_STRING`, `MAX_SERVERINFO_STRING`, `MAX_LOCALINFO_STRING` are
  declared in QW/client/common.h (comndef.h), not bothdefs.h, but are needed
  now by src/qw/client/client.ts's ext types (player_info_t.userinfo,
  client_static_t.userinfo, client_state_t.serverinfo) and src/qw/common.ts
  (Q002, common.c's Info_* functions) has not landed yet. Ported here as a
  stand-in, same idiom as src/client/client.ts's SfxT forward-declaration:
  when src/qw/common.ts lands it should export these and this module should
  re-export from there instead.
- `MAX_SCOREBOARD` (16, max numbers of players in the WinQuake solo/coop
  scoreboard sense) is unchanged from src/common/quakedef.ts's own
  `MAX_SCOREBOARD` and is re-exported; it is unrelated to QW's `MAX_CLIENTS`
  (32, protocol.ts), which is the QW analogue for the same "how many players"
  concept under a different name and a different, larger value.
- `MAX_SCOREBOARDNAME` is not re-exported: QW/client/client.h separately
  `#define`s its own `MAX_SCOREBOARDNAME 16` (for `player_info_t.name`),
  distinct from bothdefs.h and from src/common/quakedef.ts's `MAX_SCOREBOARDNAME`
  (32, for WinQuake's `ScoreboardT.name`). That QW-local redefinition is
  ported in src/qw/client/client.ts, next to `PlayerInfoT`, not here.
- Not found anywhere in the QW/client source tree (grepped the whole tree),
  despite being named in the unit brief, and therefore not ported: `GAMENAME`,
  `DEFAULT_VIEWHEIGHT`, `MAX_INFO_KEY`, `ANGLE2SHORT`/`SHORT2ANGLE`. QW's
  client never declares a `GAMENAME` macro (Host_Init's use of the game
  directory string is common.c's concern, not bothdefs.h's, and is out of
  this unit's scope); `DEFAULT_VIEWHEIGHT` has no QW equivalent (player_state_t
  carries no view-height field -- pmove.c computes it); `ANGLE2SHORT`/
  `SHORT2ANGLE` do not exist under those names in this GPL release at all.
- `qboolean`/`byte` aliases are skipped per PORTING.md (`qboolean` -> `boolean`
  with no alias; `byte` is already `src/common/quakedef.ts`'s `Byte`).
*/

import {
  GLQUAKE_VERSION,
  CACHE_SIZE,
  MINIMUM_MEMORY,
  PITCH,
  YAW,
  ROLL,
  MAX_SCOREBOARD,
  SOUND_CHANNELS,
  MAX_QPATH,
  MAX_OSPATH,
  ON_EPSILON,
  MAX_LIGHTSTYLES,
  MAX_MODELS,
  MAX_SOUNDS,
  SAVEGAME_COMMENT_LENGTH,
  MAX_STYLESTRING,
  MAX_CL_STATS,
  STAT_HEALTH,
  STAT_WEAPON,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_SHELLS,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_CELLS,
  STAT_ACTIVEWEAPON,
  STAT_TOTALSECRETS,
  STAT_TOTALMONSTERS,
  STAT_SECRETS,
  STAT_MONSTERS,
  IT_SHOTGUN,
  IT_SUPER_SHOTGUN,
  IT_NAILGUN,
  IT_SUPER_NAILGUN,
  IT_GRENADE_LAUNCHER,
  IT_ROCKET_LAUNCHER,
  IT_LIGHTNING,
  IT_SUPER_LIGHTNING,
  IT_SHELLS,
  IT_NAILS,
  IT_ROCKETS,
  IT_CELLS,
  IT_AXE,
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_SUPERHEALTH,
  IT_KEY1,
  IT_KEY2,
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_SUIT,
  IT_QUAD,
  IT_SIGIL1,
  IT_SIGIL2,
  IT_SIGIL3,
  IT_SIGIL4,
} from "../common/quakedef";

export {
  GLQUAKE_VERSION,
  CACHE_SIZE,
  MINIMUM_MEMORY,
  PITCH,
  YAW,
  ROLL,
  MAX_SCOREBOARD,
  SOUND_CHANNELS,
  MAX_QPATH,
  MAX_OSPATH,
  ON_EPSILON,
  MAX_LIGHTSTYLES,
  MAX_MODELS,
  MAX_SOUNDS,
  SAVEGAME_COMMENT_LENGTH,
  MAX_STYLESTRING,
  MAX_CL_STATS,
  STAT_HEALTH,
  STAT_WEAPON,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_SHELLS,
  STAT_NAILS,
  STAT_ROCKETS,
  STAT_CELLS,
  STAT_ACTIVEWEAPON,
  STAT_TOTALSECRETS,
  STAT_TOTALMONSTERS,
  STAT_SECRETS,
  STAT_MONSTERS,
  IT_SHOTGUN,
  IT_SUPER_SHOTGUN,
  IT_NAILGUN,
  IT_SUPER_NAILGUN,
  IT_GRENADE_LAUNCHER,
  IT_ROCKET_LAUNCHER,
  IT_LIGHTNING,
  IT_SUPER_LIGHTNING,
  IT_SHELLS,
  IT_NAILS,
  IT_ROCKETS,
  IT_CELLS,
  IT_AXE,
  IT_ARMOR1,
  IT_ARMOR2,
  IT_ARMOR3,
  IT_SUPERHEALTH,
  IT_KEY1,
  IT_KEY2,
  IT_INVISIBILITY,
  IT_INVULNERABILITY,
  IT_SUIT,
  IT_QUAD,
  IT_SIGIL1,
  IT_SIGIL2,
  IT_SIGIL3,
  IT_SIGIL4,
};

// value collision: WinQuake's VERSION is 1.09
export const VERSION = 2.4;
// value collision: WinQuake's LINUX_VERSION is 1.30
export const LINUX_VERSION = 0.98;

// value collision: WinQuake's MAX_MSGLEN is 8000
export const MAX_MSGLEN = 1450; // max length of a reliable message
// value collision: WinQuake's MAX_DATAGRAM is 1024
export const MAX_DATAGRAM = 1450; // max length of unreliable message

// value collision: WinQuake's MAX_EDICTS is 600
export const MAX_EDICTS = 768; // FIXME: ouch! ouch! ouch!

// new in QW (commented out of WinQuake's stat list, see file header)
export const STAT_ITEMS = 15;

// declared in QW/client/common.h (comndef.h), not bothdefs.h -- see file header
export const MAX_INFO_STRING = 196;
export const MAX_SERVERINFO_STRING = 512;
export const MAX_LOCALINFO_STRING = 32768;
