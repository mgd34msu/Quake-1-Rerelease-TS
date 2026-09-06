/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/qwsvdef.h (GNU GPL v2 or later).

quakedef.h -- primary header for server (qwsvdef.h's own top comment; the
file itself is named qwsvdef.h in the QW tree, distinct from the client's
quakedef.h and from WinQuake's, to avoid a header-name clash when both are
on an include path during the original build).

qwsvdef.h is almost entirely `#include` lines pulling in the rest of the
qwsv header set; each maps to an already-ported or concurrently-ported TS
module, so nothing is re-declared here for them:

| qwsvdef.h #include | TS module |
|---|---|
| bothdefs.h | src/qw/bothdefs.ts (Q001) |
| common.h | src/qw/common.ts (Q002, not yet landed) |
| bspfile.h | src/common/bspfile.ts |
| sys.h | src/platform/sys.ts |
| zone.h | src/common/zone.ts |
| mathlib.h | src/common/mathlib.ts |
| cvar.h | src/common/cvar.ts (src/qw/cvar.ts adds QW's flags, per PORTING.md) |
| net.h | src/qw/net_chan.ts + src/qw/net_udp.ts (Q003, not yet landed) |
| protocol.h | src/qw/protocol.ts (Q001) |
| cmd.h | src/common/cmd.ts |
| model.h | src/common/model.ts |
| crc.h | src/common/crc.ts |
| progs.h | src/qw/server/progs.ts (this unit) |
| server.h | src/qw/server/server.ts (this unit) |
| world.h | src/qw/server/world.ts (Q013, not yet landed) |
| pmove.h | src/qw/pmove.ts (PORTING.md's QW common track) |

Deviations from PORTING.md / the C source:
- `#define QUAKE_GAME` (as opposed to utilities -- qcc/qbsp/light link the
  same headers without it) and `#define SERVERONLY` carry no meaning in this
  port: nothing here branches on either, per PORTING.md's "`#ifdef`... take
  the portable path" rule. `SERVERONLY`'s only real implication is that qwsv
  is a standalone binary with no client subsystems compiled in at all (not
  even the WinQuake client, unlike NQ's `-dedicated` flag which still links
  client.c's stubs) -- src/qw/main_sv.ts (a later unit, per PORTING.md's "one
  engine, two extra entry points" ruling) is where that boundary actually
  lives, not this header.
- `quakeparms_t` is byte-for-byte the same shape as
  src/common/quakedef.ts's `QuakeParmsT` (`basedir`/`cachedir`/`argc`/`argv`/
  `membase`/`memsize`) -- re-exported below rather than redeclared.
- `host_parms`, `sys_nostdout`, `developer`, `host_initialized`,
  `host_frametime`, `realtime` are qwsvdef.h's own externs, but (unlike
  WinQuake, where host.c defines all of these) qwsv's copies are defined by
  QW/server/sv_main.c, a `SERVERONLY` binary with no host.c linked at all.
  src/common/host.ts's `host` singleton and `developer` cvar are the
  WinQuake client/server's; qwsv does not import them. Per this unit's
  brief ("host_* externs... comment block"), these are not defined here --
  sv_main.ts (a later unit) is where they land, exactly as
  src/server/server.ts's own file header defers `SV_*` function prototypes
  to sv_main.ts/sv_phys.ts/sv_move.ts/sv_user.ts rather than declaring
  placeholders for them.
- `void SV_Error (char *error, ...)` / `void SV_Init (quakeparms_t *parms)`:
  sv_main.c's/sv_init.c's own functions, not declared here for the same
  reason.
- `void Con_Printf (char *fmt, ...)` / `void Con_DPrintf (char *fmt, ...)`:
  qwsv has no console.c of its own in the QW/server directory listing (it
  reuses sys_unix.c's stdio-based implementation); not declared here --
  whichever later unit ports sys_unix.c's console output owns these names.
- No constants are declared by qwsvdef.h itself beyond `quakeparms_t` --
  checked the full 95-line file; the unit brief's guess at "constants unique
  to qwsv" here does not match the source, so none are invented.
*/

export { QuakeParmsT } from "../../common/quakedef";
