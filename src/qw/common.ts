/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/common.c and QW/client/common.h (GNU GPL v2 or later).

common.c -- misc functions used in client and server, and the QuakeWorld
filesystem, for the QuakeWorld track (qwcl/qwsv). Diffed against
WinQuake/common.c and WinQuake/common.h (`diff -w`, both fully read) to
identify every changed line; the ~1072-line difference the unit brief cites
is real but concentrated in a handful of functions -- see the table below.

CORRECTED 2026-09-05 (Task 1, "one filesystem state"): this file used to keep
its OWN copies of `com_argc`/`com_argv`/`com_searchpaths`/`com_gamedir`/
`com_modified`/`static_registered`/`com_filesize`, on the reasoning (see the
file's original header) that src/common/common.ts's own bindings are
read-only `export let`s an importer cannot reassign. That reasoning was
sound as far as it went, but the fix it reached -- a second, parallel copy of
the search path / gamedir / registration state -- was wrong at runtime:
every shared module that walks the filesystem (src/common/model.ts's
Mod_ForName, src/common/wad.ts, src/common/cmd.ts's Cmd_Exec_f, the sound
loader, screenshot paths, ...) calls src/common/common.ts's own
COM_FindFile/COM_LoadFile against src/common/common.ts's own `com_searchpaths`
-- never this module's copy -- so a QW binary that only ever updated this
module's own state would have those shared consumers find nothing at all
once COM_Gamedir ran. Fixed by adding exported setters to
src/common/common.ts (`setComArgc`, `setComArgv`, `setComSearchpaths`,
`setComGamedir`, `setComModified`, `setStaticRegistered`, `setComFilesize`)
that this module's own filesystem functions now call, reassigning THE SAME
state every shared module already reads. `com_base_searchpaths` is not one of
the shared fields -- it has no WinQuake counterpart at all (COM_Gamedir, the
function that reads it, is itself QW-only) -- so it stays a plain module-
local `let` here, same as `com_basedir`/`gamedirfile`/`file_from_pak`.

RE-EXPORTED FROM THE LANDED WINQUAKE MODULES (byte-identical or trivially
identical in the QW source; not duplicated here):
  src/common/common.ts   -- Q_atoi, Q_atof, Q_strcasecmp, Q_strncasecmp
                             (see deviation below), BigShort, LittleShort,
                             BigLong, LittleLong, BigFloat, LittleFloat,
                             bigendien, COM_SkipPath, COM_StripExtension,
                             COM_FileExtension, COM_FileBase,
                             COM_DefaultExtension, COM_CreatePath, va, pop,
                             host_parms, ParseState (type), PAK0_COUNT,
                             MAX_FILES_IN_PACK, DPACKHEADER_T_SIZE,
                             DPACKFILE_T_SIZE, readDpackheader, readDpackfile,
                             PackFileT/PackT/SearchPathT (types), and now
                             (Task 1) COM_CheckParm plus the shared state
                             reads com_argc/com_argv/com_searchpaths/
                             com_gamedir/com_modified/static_registered/
                             com_filesize -- see the decision list below.
  src/common/crc.ts      -- CRC_Init, CRC_ProcessByte, and (now, Task 1
                             cleanup: CRC_Block landed in src/common/crc.ts as
                             a concurrent unit after this file's original
                             header was written, which is why it used to
                             carry a private duplicate) CRC_Block itself.
  src/common/sizebuf.ts  -- SizeBuf (type), net_message, msgState,
                             MSG_BeginReading, MSG_WriteChar, MSG_WriteByte,
                             MSG_WriteShort, MSG_WriteLong, MSG_WriteFloat,
                             MSG_WriteString, MSG_WriteCoord, MSG_ReadChar,
                             MSG_ReadByte, MSG_ReadShort, MSG_ReadLong,
                             MSG_ReadFloat, MSG_ReadString, MSG_ReadCoord,
                             MSG_ReadAngle, SZ_Clear, SZ_GetSpace, SZ_Write,
                             SZ_Print
  src/common/cvar.ts     -- CvarT (type), Cvar_RegisterVariable, Cvar_Set
  src/common/cmd.ts      -- Cmd_AddCommand
  src/common/zone.ts     -- Cache_Flush
  src/common/quakedef.ts -- MAX_NUM_ARGVS
  src/client/console.ts  -- Con_Printf
  src/platform/sys.ts    -- Sys_Error, Sys_Printf, Sys_FileOpenRead,
                             Sys_FileOpenWrite, Sys_FileClose, Sys_FileSeek,
                             Sys_FileRead, Sys_FileWrite, Sys_FileTime,
                             Sys_mkdir
  src/qw/protocol.ts     -- QwUsercmdT (type), CM_ANGLE1, CM_ANGLE2,
                             CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP,
                             CM_BUTTONS, CM_IMPULSE
  src/common/mathlib.ts  -- Vec3 (type), vec3, VectorCopy
src/qw/bothdefs.ts is not imported: nothing this file needs (MAX_MSGLEN,
CM_* etc.) is actually declared there -- see below.

QW-SPECIFIC PORTS (written fresh in this file; a genuinely new/changed
function, or one that must operate over this module's own copy of QW-only
state -- `com_basedir`/`gamedirfile`/`com_base_searchpaths`/`file_from_pak`,
which have no WinQuake counterpart to share):
  COM_Parse (drops the WinQuake single-char-token special case), COM_InitArgv,
  COM_AddParm, COM_Init, COM_Path_f, COM_WriteFile, COM_CopyFile,
  COM_FOpenFile, COM_LoadFile (private) + COM_LoadHunkFile/LoadTempFile/
  LoadCacheFile/LoadStackFile, COM_LoadPackFile, COM_AddGameDirectory,
  COM_Gamedir, COM_InitFilesystem, COM_CheckRegistered, Info_ValueForKey,
  Info_RemoveKey, Info_RemovePrefixedKeys, Info_SetValueForStarKey,
  Info_SetValueForKey, Info_Print, chktbl, COM_BlockSequenceCRCByte,
  MSG_WriteAngle (different truncation order, see below), MSG_WriteAngle16,
  MSG_ReadAngle16, MSG_WriteDeltaUsercmd, MSG_ReadDeltaUsercmd,
  MSG_ReadStringLine, MSG_GetReadCount, nullcmd, and this module's own
  QW-only state (com_basedir/gamedirfile/com_base_searchpaths/file_from_pak/
  standard_quake/rogue/hipnotic/msg_suppress_1/registered (cvar)/
  MAX_INFO_STRING/MAX_SERVERINFO_STRING/MAX_LOCALINFO_STRING).

Decision list for Task 1 (each function that duplicated a shared-state
consumer, and why it is re-exported vs. kept as its own QW port over the now-
shared state):
  - COM_CheckParm: identical body in both C files (loop over com_argc/
    com_argv, no other state touched) -- RE-EXPORTED from src/common/common.ts
    once its state reads resolve to the shared bindings.
  - COM_InitArgv: genuinely differs (QW's own 6-entry safeargvs list, drops
    "-dibonly"; no cmdline-text reconstruction, since QW has no `cmdline`
    cvar; no `-rogue`/`-hipnotic` toggling, since QW's COM_InitArgv never had
    that check at all) -- KEPT as its own port, now calling
    `setComArgc`/`setComArgv` instead of reassigning a module-local `let`.
  - COM_AddParm: QW-only, no WinQuake counterpart at all -- KEPT, now via
    `setComArgc`.
  - COM_FindFile/COM_OpenFile/COM_CloseFile: QW's common.c has no functions
    of these names or shapes at all (grepped) -- QW's filesystem model is a
    single COM_FOpenFile that always opens a fresh fd (even for a pack hit,
    via Sys_FileOpenRead), so there is no "handle small enough to share, so
    don't really close it" pack-fd bookkeeping to port; nothing to re-export
    or fork here.
  - COM_FOpenFile: genuinely differs from src/common/common.ts's COM_FindFile
    (no com_cachedir/-cachedir support at all in QW; sets the QW-only
    `file_from_pak` flag; does NOT set com_filesize on the non-pack branch,
    a preserved C bug already documented below; single "handle" mode only,
    no "file" mode) -- KEPT as its own port, over the shared com_searchpaths/
    static_registered (reads) and com_filesize (via `setComFilesize`).
  - COM_LoadFile (private) + the Hunk/Temp/Cache/Stack family: differ because
    they call QW's own COM_FOpenFile, which (per the point above) does not
    always set com_filesize itself, so this wrapper must -- KEPT, via
    `setComFilesize`.
  - COM_LoadPackFile: differs (QW's PAK0_CRC is 52883, not WinQuake's 32981;
    uses Sys_File* primitives rather than node:fs directly) -- KEPT as its
    own port, over the shared com_modified (via `setComModified`).
  - COM_AddGameDirectory: differs (extracts `gamedirfile`, a QW-only global)
    -- KEPT, over the shared com_gamedir/com_searchpaths (via
    `setComGamedir`/`setComSearchpaths`).
  - COM_Gamedir: QW-only, no WinQuake counterpart -- KEPT, over the shared
    com_gamedir/com_searchpaths and this module's own com_basedir/
    gamedirfile/com_base_searchpaths.
  - COM_InitFilesystem: differs completely (id1+qw only; no -cachedir/-rogue/
    -hipnotic/-game/-path handling, all genuinely absent from the QW source,
    not merely dropped by this port) -- KEPT, calling COM_AddGameDirectory
    (which itself now writes the shared state) and reading the shared
    com_searchpaths once, at the end, into this module's own
    com_base_searchpaths.
  - COM_CheckRegistered: differs (no `cmdline` cvar handling since QW has
    none; different Sys_Error text; the com_modified gate is client-only,
    `#ifndef SERVERONLY` in the C) -- KEPT, over the shared com_modified
    (read) and static_registered (via `setStaticRegistered`).
  - COM_WriteFile: differs (QW retries via Sys_mkdir on a failed open, where
    the shared version in src/common/common.ts does not) -- KEPT, reading
    the shared com_gamedir directly (never reassigned here, so no setter
    needed).
  - COM_CopyFile/COM_CreatePath: COM_CreatePath has no state dependency at
    all and is byte-identical -- RE-EXPORTED (already was). COM_CopyFile
    also has no direct dependency on the shared state (it only takes
    explicit netpath/cachepath parameters) but differs in its I/O primitives
    (Sys_File* vs. node:fs) and failure handling from src/common/common.ts's
    own COM_CopyFile -- KEPT as its own port; this difference is orthogonal
    to the state consolidation this task is about.

Deviations from PORTING.md / the C source:
- Q_strcasecmp/Q_strncasecmp: QW/client/common.h reduces these to macros
  calling libc's real `strcasecmp`/`strncasecmp` (a true lexicographic
  comparator, can return positive), whereas WinQuake's common.c hand-rolls
  them as an equality-only test (-1/0, per src/common/common.ts's own
  header). QW's common.c has no function body of its own to port for these
  names (they are header macros only); every call site in this file
  (Info_SetValueForStarKey's "name"/"team" checks) only tests `== 0` vs
  `!= 0`, so the landed WinQuake behavior is observably identical for actual
  usage here. Re-exported rather than reimplemented.
- chktbl[1024+4]: the C's aggregate initializer supplies only 516 explicit
  byte values (32 rows of 16, plus a trailing `0x00,0x00,0x00,0x00` commented
  "// map checksum goes here") for a 1028-element array; C zero-fills every
  element past the last explicit one. The comment's placement is misleading
  (it lands the 4 explicit zeros at indices 512-515, not 1024-1027, since the
  initializer never explicitly reaches index 1024), but the *observable*
  array is identical either way: indices 512-1027 (516 bytes) are all zero,
  whether by the 4 explicit zeros or by C's implicit zero-fill, because both
  produce the same value. Ported as the 512 explicit bytes (extracted
  mechanically from the source, not hand-transcribed, and spot-checked
  against the printed source) followed by 516 zero bytes. Only
  COM_BlockSequenceCRCByte reads this table live; the function that would
  write real map-checksum bytes into chktbl[1024..1027]
  (COM_BlockSequenceCheckByte) is `#if 0`'d out in the C itself (dead code,
  not merely out of scope) and is not ported, matching PORTING.md's `#if 0`
  rule.
- COM_BlockSequenceCRCByte's divisor is `sizeof(chktbl) - 8` (1028-8=1020) in
  the actual C source (QW/client/common.c line ~2239: `p = chktbl +
  (sequence % (sizeof(chktbl) - 8));`), not `- 4` as the unit brief's
  paraphrase states; the source, read directly, is what is ported.
- MSG_WriteAngle's truncation order differs from WinQuake's, a real wire-byte
  difference, not a cosmetic one: WinQuake writes
  `((int)f*256/360) & 255` (cast-then-multiply-then-integer-divide, i.e.
  `Math.trunc((Math.trunc(f) * 256) / 360)`, already ported that way in
  src/common/sizebuf.ts); QW writes `(int)(f*256/360) & 255`
  (multiply-and-divide in floating point, cast once at the end). These give
  different results for many non-integer inputs (e.g. f=1.9: WinQuake's
  order yields (int)1.9=1, 1*256/360=0 by integer division; QW's order
  yields 1.9*256/360=1.351, truncated to 1). Ported fresh as
  `Math.trunc((f * 256) / 360) & 255`. MSG_ReadAngle (8-bit read side) and
  MSG_WriteCoord/MSG_ReadCoord are unchanged from WinQuake's and re-exported.
- MAX_INFO_KEY (named in the unit brief, "the MAX_INFO_KEY 64 limits") does
  not exist anywhere in the QW 2.33 GPL release -- grepped the whole
  QW/client and QW/server trees, no hits outside the QW/qwfwd tree (already
  ruled out of scope). The actual C buffers in Info_ValueForKey/
  Info_RemoveKey/Info_RemovePrefixedKeys/Info_Print are plain 512-byte
  scratch buffers with no named length constant; this port's string-return
  idiom needs no fixed-size buffer at all, so no such constant is declared.
  src/qw/bothdefs.ts's own header independently confirms this same
  not-found result for MAX_INFO_KEY.
- Q_Malloc, named in the unit brief, does not appear anywhere in
  QW/client/common.c or common.h (grepped both); only `Z_Malloc` appears
  (COM_LoadFile's usehunk==0 case, COM_LoadPackFile's directory/pack
  allocations, COM_Gamedir/COM_AddGameDirectory's searchpath_t nodes), which
  PORTING.md's Memory section already collapses to plain allocation with no
  observable behavior beyond the allocation itself -- object literals and
  typed arrays are used directly, no zone.ts import.
- build_number() (QW/client/common.c's own function, returns "days since Oct
  24 1996" for display in menus) is not ported: its only input is `__DATE__`,
  a C-compiler-supplied build-date macro with no TypeScript/bun equivalent,
  and no unit brief bullet asks for it. Dropped per the "a function you
  cannot port faithfully is a reported deviation" rule, not stubbed.
- COM_AddGameDirectory's gamedirfile extraction: the C is
  `if ((p = strrchr(dir, '/')) != NULL) strcpy(gamedirfile, ++p); else
  strcpy(gamedirfile, p);` -- the else branch strcpy's the NULL pointer `p`,
  undefined behavior in the C. It is unreachable in practice: every call site
  in this file (COM_InitFilesystem's `${com_basedir}/id1`/`${com_basedir}/qw`)
  always supplies a `dir` containing at least one '/'. Ported as: fall back to
  the whole string when no '/' is present, rather than replicate a crash.
- COM_FOpenFile's directory-tree (non-pack) branch does not assign
  com_filesize in the C (only the pack branch does -- read directly from the
  source, lines ~1510-1528: the non-pack branch's `return COM_filelength
  (*file);` never touches the `com_filesize` global). This is preserved
  exactly as the original: COM_FOpenFile itself only sets com_filesize on a pack hit.
  COM_LoadFile (this file's private wrapper, matching `len = com_filesize =
  COM_FOpenFile(path, &h);` in the C) separately assigns com_filesize from
  its own captured return value regardless of which branch matched, exactly
  as the C's call site does.
- COM_FOpenFile's non-pack branch has no failure check on the actual file
  open in the C (`Sys_FileTime` succeeding is trusted, then `fopen` is called
  unconditionally and its result returned uninspected) -- if the open then
  failed, `COM_filelength(NULL)` would be undefined behavior. This port
  checks Sys_FileOpenRead's result and continues the search on failure
  instead of crashing: a disclosed, safer substitute for unreachable-in-
  practice C undefined behavior, the same idiom src/common/sizebuf.ts's
  MSG_ReadFloat header already uses for a similar case.
- COM_WriteFile's C tries `fopen` for write, and only on failure calls
  `Sys_mkdir` then retries, `Sys_Error`ing if that also fails. Ported as a
  try/catch around src/platform/sys.ts's Sys_FileOpenWrite, since that
  function throws (via Sys_Error) on failure rather than returning a NULL-
  equivalent sentinel the way `fopen` does -- the catch stands in for the
  C's `if (!f)` check. The final Sys_Error's message text (if the retry also
  fails) is Sys_FileOpenWrite's own ("Error opening %s: %s"), not the C's
  ("Error opening %s", using `filename` rather than the full `name` path);
  sys.ts is out of this unit's SCOPE to adjust.
- COM_InitFilesystem: QW's version (read directly, lines 1829-1851) only
  handles `-basedir`; there is no `-cachedir`, `-rogue`, `-hipnotic`, `-game`,
  or `-path` handling at all (all absent from the QW source, not merely
  dropped by this port) -- confirmed by grep: `com_cachedir`/`CMDLINE_LENGTH`/
  `com_cmdline` do not appear anywhere in QW/client/common.c or common.h.
  `standard_quake`/`rogue`/`hipnotic` stay declared (QW/client/common.c line
  57) but are never toggled by anything in this file (the `-rogue`/`-hipnotic`
  COM_InitArgv checks that toggle them in WinQuake are simply absent from
  QW's COM_InitArgv) and are ported as fixed constants.
- COM_CheckRegistered: QW's version does not register/set a `cmdline` cvar
  (QW has none -- see above) and its Sys_Error text differs ("You must have
  the registered version to play QuakeWorld" vs WinQuake's "...to use
  modified games"). The `com_modified` gate is wrapped in `#ifndef
  SERVERONLY` in the C: ported as the client path (RULINGS: port CLIENT,
  list SERVERONLY alternatives) -- under SERVERONLY (qwsv), a modified game
  with no gfx/pop.lmp does NOT Sys_Error here at all; it silently proceeds as
  shareware/unregistered. Q017 (qwsv) may need to call this with that
  difference in mind; reported for that unit. The `#if WINDED` dedicated-
  server-only branch WinQuake's COM_CheckRegistered had is entirely absent
  from QW's version (not merely dropped).
- Info_ValueForKey/Info_RemoveKey/Info_RemovePrefixedKeys/
  Info_SetValueForStarKey/Info_SetValueForKey: per RULINGS, the C mutates a
  caller-owned `char *s` buffer in place (Info_ValueForKey excepted, which
  only reads); ported to return a new string instead. Callers (cls.qw.userinfo
  etc., Q001/Q021, not this unit) must assign the return value back into
  their holder field. Info_SetValueForStarKey's SERVERONLY branch
  (`extern cvar_t sv_highchars; ... if (!sv_highchars.value) strip high bits`)
  is dropped per RULINGS (port CLIENT path: unconditionally strip high bits
  unless the key is "name"); Q017 (qwsv) may need `sv_highchars`-gated
  behavior and is expected to override this function or add its own.
- Info_SetValueForStarKey's `strlen(value) - strlen(v) + strlen(s) > maxsize`
  check: in C this is unsigned (size_t) arithmetic, so `strlen(value) -
  strlen(v)` can wrap to a huge value when `v` is longer than `value` before
  `+ strlen(s)` is added back. Unsigned modular addition/subtraction is
  commutative and associative mod 2^64, and since `v` is always a substring
  of `s` (returned by Info_ValueForKey(s, key) on the same `s`), the
  "true" mathematical result `strlen(s) + strlen(value) - strlen(v)` is
  always >= 0 and small, so the wrapped C computation always lands on the
  same bit pattern as that non-negative expression. Ported as ordinary
  (non-wrapping) arithmetic: `value.length - v.length + s.length > maxsize`,
  provably equal to the C's result under that invariant.
- SZ_Alloc/SZ_Free do not exist in QW/client/common.c or common.h at all
  (grepped both; the C's own sizebuf_t allocation now happens elsewhere,
  outside this file's scope -- not ported, not re-exported).
- CvarT's `registered` cvar (`cvar_t registered = {"registered","0"};` in
  QW/client/common.c) has no archive/server/info word set, unlike
  WinQuake's `registered`; QW never registers a `cmdline` cvar (see above).
*/

import { Sys_Error, Sys_Printf, Sys_FileOpenRead, Sys_FileOpenWrite, Sys_FileClose, Sys_FileSeek, Sys_FileRead, Sys_FileWrite, Sys_FileTime, Sys_mkdir, Sys_ResolveCase } from "../platform/sys";
import { Con_Printf } from "../client/console";
import { Cache_Flush } from "../common/zone";
import { Cmd_AddCommand } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { CRC_Block } from "../common/crc";
import { type Vec3, vec3, VectorCopy } from "../common/mathlib";
import { MAX_NUM_ARGVS } from "../common/quakedef";
import {
  Q_atoi,
  Q_atof,
  Q_strcasecmp,
  Q_strncasecmp,
  BigShort,
  LittleShort,
  BigLong,
  LittleLong,
  BigFloat,
  LittleFloat,
  bigendien,
  type ParseState,
  COM_SkipPath,
  COM_StripExtension,
  COM_FileExtension,
  COM_FileBase,
  COM_DefaultExtension,
  COM_CreatePath,
  va,
  pop,
  host_parms,
  PAK0_COUNT,
  MAX_FILES_IN_PACK,
  DPACKHEADER_T_SIZE,
  DPACKFILE_T_SIZE,
  readDpackheader,
  readDpackfile,
  type PackFileT,
  type PackT,
  type SearchPathT,
  COM_CheckParm,
  com_argc,
  com_argv,
  com_searchpaths,
  com_gamedir,
  com_modified,
  static_registered,
  com_filesize,
  setComArgc,
  setComArgv,
  setComSearchpaths,
  setComGamedir,
  setComModified,
  setStaticRegistered,
  setComFilesize,
} from "../common/common";
import {
  SizeBuf,
  net_message,
  msgState,
  MSG_BeginReading,
  MSG_WriteChar,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteFloat,
  MSG_WriteString,
  MSG_WriteCoord,
  MSG_ReadChar,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadFloat,
  MSG_ReadString,
  MSG_ReadCoord,
  MSG_ReadAngle,
  SZ_Clear,
  SZ_GetSpace,
  SZ_Write,
  SZ_Print,
} from "../common/sizebuf";
import { QwUsercmdT, CM_ANGLE1, CM_ANGLE2, CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP, CM_BUTTONS, CM_IMPULSE } from "./protocol";

export {
  Q_atoi,
  Q_atof,
  Q_strcasecmp,
  Q_strncasecmp,
  BigShort,
  LittleShort,
  BigLong,
  LittleLong,
  BigFloat,
  LittleFloat,
  bigendien,
  COM_SkipPath,
  COM_StripExtension,
  COM_FileExtension,
  COM_FileBase,
  COM_DefaultExtension,
  COM_CreatePath,
  va,
  pop,
  host_parms,
  COM_CheckParm,
  com_argc,
  com_argv,
  com_searchpaths,
  com_gamedir,
  com_modified,
  static_registered,
  com_filesize,
  MAX_NUM_ARGVS,
  SizeBuf,
  net_message,
  msgState,
  MSG_BeginReading,
  MSG_WriteChar,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteFloat,
  MSG_WriteString,
  MSG_WriteCoord,
  MSG_ReadChar,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadFloat,
  MSG_ReadString,
  MSG_ReadCoord,
  MSG_ReadAngle,
  SZ_Clear,
  SZ_GetSpace,
  SZ_Write,
  SZ_Print,
};
export type { ParseState };

//============================================================================
//
//                      LIBRARY REPLACEMENT FUNCTIONS
//
//============================================================================
// (Q_atoi/Q_atof/Q_strcasecmp/Q_strncasecmp re-exported above, see file header)

//============================================================================
//
//                      BYTE ORDER FUNCTIONS
//
//============================================================================
// (re-exported above, see file header)

//============================================================================
// COM_Parse -- QW drops the WinQuake single-char-token special case ('{' '}'
// ')' '(' '\'' ':'); that branch is gated on !qw.active in the shared
// src/common/common.ts COM_Parse, re-exported below.


export { COM_Parse } from "../common/common";

//============================================================================
//
// state: com_argc/com_argv/com_searchpaths/com_gamedir/com_modified/
// static_registered/com_filesize are src/common/common.ts's shared bindings
// now (Task 1) -- re-exported above, reassigned through its setters below.
// com_basedir/gamedirfile/com_base_searchpaths/file_from_pak have no
// WinQuake counterpart at all and stay this module's own state.
//
//============================================================================

export const NUM_SAFE_ARGVS = 6; // QW: 6, not WinQuake's 7 (drops "-dibonly")

const argvdummy = " ";
const safeargvs: readonly string[] = ["-stdvid", "-nolan", "-nosound", "-nocdaudio", "-nojoy", "-nomouse"];

const largv: string[] = new Array<string>(MAX_NUM_ARGVS + NUM_SAFE_ARGVS + 1);

export function COM_InitArgv(argv: string[]): void {
  const argc = argv.length;
  let safe = false;

  // com_argc is the shared binding now; a local counter builds the final
  // value, which is committed once via setComArgc below, matching the C's
  // observable end state (nothing else runs between the first and last
  // write in this synchronous function).
  let n = 0;
  while (n < MAX_NUM_ARGVS && n < argc) {
    largv[n] = argv[n];
    if (argv[n] === "-safe") safe = true;
    n++;
  }

  if (safe) {
    // force all the safe-mode switches. Note that we reserved extra space in
    // case we need to add these, so we don't need an overflow check
    for (let i = 0; i < NUM_SAFE_ARGVS; i++) {
      largv[n] = safeargvs[i];
      n++;
    }
  }

  largv[n] = argvdummy;
  setComArgc(n);
  setComArgv(largv);
}

// Adds the given string at the end of the current argument list
export function COM_AddParm(parm: string): void {
  largv[com_argc] = parm;
  setComArgc(com_argc + 1);
}

//============================================================================
//
//                            QUAKEWORLD FILESYSTEM
//
//============================================================================

export const PAK0_CRC = 52883; // QW: differs from WinQuake's 32981, see file header
export { PAK0_COUNT, MAX_FILES_IN_PACK };

export let file_from_pak = 0; // global indicating file came from pack file ZOID

export let com_basedir = "";
export let gamedirfile = "";

export let com_base_searchpaths: SearchPathT | null = null; // without gamedirs

// QW keeps these declared but nothing in this file (or COM_InitArgv) ever
// toggles them -- see file header.
export const standard_quake = true;
export const rogue = false;
export const hipnotic = false;

export const msg_suppress_1 = false;

// prettier-ignore
const chktblExplicit: readonly number[] = [
  0x78, 0xd2, 0x94, 0xe3, 0x41, 0xec, 0xd6, 0xd5, 0xcb, 0xfc, 0xdb, 0x8a, 0x4b, 0xcc, 0x85, 0x01,
  0x23, 0xd2, 0xe5, 0xf2, 0x29, 0xa7, 0x45, 0x94, 0x4a, 0x62, 0xe3, 0xa5, 0x6f, 0x3f, 0xe1, 0x7a,
  0x64, 0xed, 0x5c, 0x99, 0x29, 0x87, 0xa8, 0x78, 0x59, 0x0d, 0xaa, 0x0f, 0x25, 0x0a, 0x5c, 0x58,
  0xfb, 0x00, 0xa7, 0xa8, 0x8a, 0x1d, 0x86, 0x80, 0xc5, 0x1f, 0xd2, 0x28, 0x69, 0x71, 0x58, 0xc3,
  0x51, 0x90, 0xe1, 0xf8, 0x6a, 0xf3, 0x8f, 0xb0, 0x68, 0xdf, 0x95, 0x40, 0x5c, 0xe4, 0x24, 0x6b,
  0x29, 0x19, 0x71, 0x3f, 0x42, 0x63, 0x6c, 0x48, 0xe7, 0xad, 0xa8, 0x4b, 0x91, 0x8f, 0x42, 0x36,
  0x34, 0xe7, 0x32, 0x55, 0x59, 0x2d, 0x36, 0x38, 0x38, 0x59, 0x9b, 0x08, 0x16, 0x4d, 0x8d, 0xf8,
  0x0a, 0xa4, 0x52, 0x01, 0xbb, 0x52, 0xa9, 0xfd, 0x40, 0x18, 0x97, 0x37, 0xff, 0xc9, 0x82, 0x27,
  0xb2, 0x64, 0x60, 0xce, 0x00, 0xd9, 0x04, 0xf0, 0x9e, 0x99, 0xbd, 0xce, 0x8f, 0x90, 0x4a, 0xdd,
  0xe1, 0xec, 0x19, 0x14, 0xb1, 0xfb, 0xca, 0x1e, 0x98, 0x0f, 0xd4, 0xcb, 0x80, 0xd6, 0x05, 0x63,
  0xfd, 0xa0, 0x74, 0xa6, 0x86, 0xf6, 0x19, 0x98, 0x76, 0x27, 0x68, 0xf7, 0xe9, 0x09, 0x9a, 0xf2,
  0x2e, 0x42, 0xe1, 0xbe, 0x64, 0x48, 0x2a, 0x74, 0x30, 0xbb, 0x07, 0xcc, 0x1f, 0xd4, 0x91, 0x9d,
  0xac, 0x55, 0x53, 0x25, 0xb9, 0x64, 0xf7, 0x58, 0x4c, 0x34, 0x16, 0xbc, 0xf6, 0x12, 0x2b, 0x65,
  0x68, 0x25, 0x2e, 0x29, 0x1f, 0xbb, 0xb9, 0xee, 0x6d, 0x0c, 0x8e, 0xbb, 0xd2, 0x5f, 0x1d, 0x8f,
  0xc1, 0x39, 0xf9, 0x8d, 0xc0, 0x39, 0x75, 0xcf, 0x25, 0x17, 0xbe, 0x96, 0xaf, 0x98, 0x9f, 0x5f,
  0x65, 0x15, 0xc4, 0x62, 0xf8, 0x55, 0xfc, 0xab, 0x54, 0xcf, 0xdc, 0x14, 0x06, 0xc8, 0xfc, 0x42,
  0xd3, 0xf0, 0xad, 0x10, 0x08, 0xcd, 0xd4, 0x11, 0xbb, 0xca, 0x67, 0xc6, 0x48, 0x5f, 0x9d, 0x59,
  0xe3, 0xe8, 0x53, 0x67, 0x27, 0x2d, 0x34, 0x9e, 0x9e, 0x24, 0x29, 0xdb, 0x69, 0x99, 0x86, 0xf9,
  0x20, 0xb5, 0xbb, 0x5b, 0xb0, 0xf9, 0xc3, 0x67, 0xad, 0x1c, 0x9c, 0xf7, 0xcc, 0xef, 0xce, 0x69,
  0xe0, 0x26, 0x8f, 0x79, 0xbd, 0xca, 0x10, 0x17, 0xda, 0xa9, 0x88, 0x57, 0x9b, 0x15, 0x24, 0xba,
  0x84, 0xd0, 0xeb, 0x4d, 0x14, 0xf5, 0xfc, 0xe6, 0x51, 0x6c, 0x6f, 0x64, 0x6b, 0x73, 0xec, 0x85,
  0xf1, 0x6f, 0xe1, 0x67, 0x25, 0x10, 0x77, 0x32, 0x9e, 0x85, 0x6e, 0x69, 0xb1, 0x83, 0x00, 0xe4,
  0x13, 0xa4, 0x45, 0x34, 0x3b, 0x40, 0xff, 0x41, 0x82, 0x89, 0x79, 0x57, 0xfd, 0xd2, 0x8e, 0xe8,
  0xfc, 0x1d, 0x19, 0x21, 0x12, 0x00, 0xd7, 0x66, 0xe5, 0xc7, 0x10, 0x1d, 0xcb, 0x75, 0xe8, 0xfa,
  0xb6, 0xee, 0x7b, 0x2f, 0x1a, 0x25, 0x24, 0xb9, 0x9f, 0x1d, 0x78, 0xfb, 0x84, 0xd0, 0x17, 0x05,
  0x71, 0xb3, 0xc8, 0x18, 0xff, 0x62, 0xee, 0xed, 0x53, 0xab, 0x78, 0xd3, 0x65, 0x2d, 0xbb, 0xc7,
  0xc1, 0xe7, 0x70, 0xa2, 0x43, 0x2c, 0x7c, 0xc7, 0x16, 0x04, 0xd2, 0x45, 0xd5, 0x6b, 0x6c, 0x7a,
  0x5e, 0xa1, 0x50, 0x2e, 0x31, 0x5b, 0xcc, 0xe8, 0x65, 0x8b, 0x16, 0x85, 0xbf, 0x82, 0x83, 0xfb,
  0xde, 0x9f, 0x36, 0x48, 0x32, 0x79, 0xd6, 0x9b, 0xfb, 0x52, 0x45, 0xbf, 0x43, 0xf7, 0x0b, 0x0b,
  0x19, 0x19, 0x31, 0xc3, 0x85, 0xec, 0x1d, 0x8c, 0x20, 0xf0, 0x3a, 0xfa, 0x80, 0x4d, 0x2c, 0x7d,
  0xac, 0x60, 0x09, 0xc0, 0x40, 0xee, 0xb9, 0xeb, 0x13, 0x5b, 0xe8, 0x2b, 0xb1, 0x20, 0xf0, 0xce,
  0x4c, 0xbd, 0xc6, 0x04, 0x86, 0x70, 0xc6, 0x33, 0xc3, 0x15, 0x0f, 0x65, 0x19, 0xfd, 0xc2, 0xd3,
];
const CHKTBL_SIZE = 1024 + 4;
// C zero-fills every element past the last explicit initializer -- see file header
const chktbl: readonly number[] = [...chktblExplicit, ...new Array<number>(CHKTBL_SIZE - chktblExplicit.length).fill(0)];

//============================================================
//
// COM_Path_f
//
//============================================================

export function COM_Path_f(): void {
  Con_Printf("Current search path:\n");
  for (let s = com_searchpaths; s; s = s.next) {
    if (s === com_base_searchpaths) Con_Printf("----------\n");
    if (s.kind === "pack") Con_Printf("%s (%i files)\n", s.pack.filename, s.pack.numfiles);
    else Con_Printf("%s\n", s.filename);
  }
}

//============================================================
//
// COM_WriteFile
//
// The filename will be prefixed by the current game directory
//============================================================

export function COM_WriteFile(filename: string, data: Uint8Array): void {
  const name = `${com_gamedir}/${filename}`;

  let handle: number;
  try {
    handle = Sys_FileOpenWrite(name);
  } catch {
    // fopen returned NULL in the C; Sys_FileOpenWrite throws instead -- see file header
    Sys_mkdir(com_gamedir);
    handle = Sys_FileOpenWrite(name); // a second failure propagates, matching the C's Sys_Error
  }

  Sys_Printf("COM_WriteFile: %s\n", name);
  Sys_FileWrite(handle, data, data.length);
  Sys_FileClose(handle);
}

//===========================================================
//
// COM_CopyFile
//
// Copies a file over from the net to the local cache, creating any
// directories needed. This is for the convenience of developers using ISDN
// from home.
//===========================================================

export function COM_CopyFile(netpath: string, cachepath: string): void {
  const { handle: inHandle, length } = Sys_FileOpenRead(netpath);
  let remaining = length;

  COM_CreatePath(cachepath); // create directories up to the cache file
  const outHandle = Sys_FileOpenWrite(cachepath); // throws on failure, matching the C's Sys_Error

  const buf = new Uint8Array(4096);
  while (remaining > 0) {
    const count = remaining < buf.length ? remaining : buf.length;
    Sys_FileRead(inHandle, buf, count);
    Sys_FileWrite(outHandle, buf, count);
    remaining -= count;
  }

  Sys_FileClose(inHandle);
  Sys_FileClose(outHandle);
}

//===========================================================
//
// COM_FOpenFile
//
// Finds the file in the search path.
// Sets com_filesize and returns a handle.
//===========================================================

export function COM_FOpenFile(filename: string): { handle: number; length: number } {
  file_from_pak = 0;

  for (let search = com_searchpaths; search; search = search.next) {
    if (search.kind === "pack") {
      // is the element a pak file? look through all the pak file elements
      const pak = search.pack;
      for (let i = 0; i < pak.numfiles; i++) {
        if (pak.files[i].name !== filename) continue;

        // found it!
        Sys_Printf("PackFile: %s : %s\n", pak.filename, filename);

        // open a new file on the pakfile
        const { handle } = Sys_FileOpenRead(pak.filename);
        if (handle === -1) Sys_Error("Couldn't reopen %s", pak.filename);
        Sys_FileSeek(handle, pak.files[i].filepos);
        setComFilesize(pak.files[i].filelen);
        file_from_pak = 1;
        return { handle, length: pak.files[i].filelen };
      }
    } else {
      // check a file in the directory tree
      if (!static_registered) {
        // if not a registered version, don't ever go beyond base
        if (filename.includes("/") || filename.includes("\\")) continue;
      }

      const netpath = `${search.filename}/${filename}`;

      const findtime = Sys_FileTime(netpath);
      if (findtime === -1) continue;

      Sys_Printf("FindFile: %s\n", netpath);

      // com_filesize is NOT set here in the C -- see file header
      const { handle, length } = Sys_FileOpenRead(netpath);
      if (handle === -1) continue; // see file header: safer substitute for the C's unchecked fopen
      return { handle, length };
    }
  }

  Sys_Printf("FindFile: can't find %s\n", filename);

  setComFilesize(-1);
  return { handle: -1, length: -1 };
}

//============================================================
//
// COM_LoadFile
//
// Filenames are relative to the quake directory.
// Always appends a 0 byte.
//============================================================

export interface CacheUserT {
  data: Uint8Array | null;
}

let loadcache: CacheUserT | null = null;

function COM_LoadFile(path: string, usehunk: 1 | 2 | 3): Uint8Array | null {
  // look for it in the filesystem or pack files
  const { handle: h, length: len } = COM_FOpenFile(path);
  setComFilesize(len); // len = com_filesize = COM_FOpenFile(...) in the C, unconditionally

  if (h === -1) return null;

  const buf = new Uint8Array(len + 1);
  if (usehunk === 3 && loadcache) loadcache.data = buf;

  buf[len] = 0;

  Sys_FileRead(h, buf, len);
  Sys_FileClose(h);

  return buf;
}

export function COM_LoadHunkFile(path: string): Uint8Array | null {
  return COM_LoadFile(path, 1);
}

export function COM_LoadTempFile(path: string): Uint8Array | null {
  return COM_LoadFile(path, 2);
}

export function COM_LoadCacheFile(path: string, cu: CacheUserT): void {
  loadcache = cu;
  COM_LoadFile(path, 3);
}

// see src/common/common.ts's own COM_LoadStackFile header note: the stack-
// buffer-reuse distinction has no meaning once usehunk collapses to plain
// allocation, so this drops the buffer/bufsize parameters the same way.
export function COM_LoadStackFile(path: string): Uint8Array | null {
  return COM_LoadFile(path, 2);
}

//=================
//
// COM_LoadPackFile
//
// Takes an explicit (not game tree related) path to a pak file.
//
// Loads the header and directory, adding the files at the beginning
// of the list so they override previous pack files.
//=================

export function COM_LoadPackFile(packfile: string): PackT | null {
  const { handle: packhandle } = Sys_FileOpenRead(packfile);
  if (packhandle === -1) return null;

  const headerBuf = new Uint8Array(DPACKHEADER_T_SIZE);
  Sys_FileRead(packhandle, headerBuf, DPACKHEADER_T_SIZE);
  const header = readDpackheader(headerBuf);

  if (header.id !== "PACK") Sys_Error("%s is not a packfile", packfile);

  const numpackfiles = Math.trunc(header.dirlen / DPACKFILE_T_SIZE);

  if (numpackfiles > MAX_FILES_IN_PACK) Sys_Error("%s has %i files", packfile, numpackfiles);

  if (numpackfiles !== PAK0_COUNT) setComModified(true); // not the original file

  Sys_FileSeek(packhandle, header.dirofs);
  const info = new Uint8Array(header.dirlen);
  Sys_FileRead(packhandle, info, header.dirlen);

  // crc the directory to check for modifications (QW: CRC_Block, not the
  // byte-by-byte CRC_Init/CRC_ProcessByte loop WinQuake's version still uses)
  const crc = CRC_Block(info, header.dirlen);
  if (crc !== PAK0_CRC) setComModified(true);

  // parse the directory
  const files: PackFileT[] = [];
  for (let i = 0; i < numpackfiles; i++) {
    const rec = readDpackfile(info, i * DPACKFILE_T_SIZE);
    files.push({ name: rec.name, filepos: rec.filepos, filelen: rec.filelen });
  }

  const pack: PackT = { filename: packfile, handle: packhandle, numfiles: numpackfiles, files };

  Con_Printf("Added packfile %s (%i files)\n", packfile, numpackfiles);
  return pack;
}

//================
//
// COM_AddGameDirectory
//
// Sets com_gamedir, adds the directory to the head of the path,
// then loads and adds pak1.pak pak2.pak ...
//================

export function COM_AddGameDirectory(dir: string): void {
  // char *p; if ((p = strrchr(dir,'/')) != NULL) strcpy(gamedirfile,++p); else
  // strcpy(gamedirfile,p) -- the else branch strcpy's a NULL pointer in the C
  // (unreachable here, every call site passes a dir containing '/'); see file header
  const slashIdx = dir.lastIndexOf("/");
  gamedirfile = slashIdx === -1 ? dir : dir.slice(slashIdx + 1);

  // Port deviation (Linux target): the C relies on a case-insensitive filesystem
  dir = Sys_ResolveCase(dir);
  setComGamedir(dir);

  // add the directory to the search path
  setComSearchpaths({ kind: "dir", filename: dir, next: com_searchpaths });

  // add any pak files in the format pak0.pak pak1.pak, ...
  for (let i = 0; ; i++) {
    // Port deviation (Linux target): the C relies on a case-insensitive filesystem
    const pakfile = Sys_ResolveCase(`${dir}/pak${i}.pak`);
    const pak = COM_LoadPackFile(pakfile);
    if (!pak) break;
    setComSearchpaths({ kind: "pack", pack: pak, next: com_searchpaths });
  }
}

//================
//
// COM_Gamedir
//
// Sets the gamedir and path to a different directory.
//================

export function COM_Gamedir(dir: string): void {
  if (dir.includes("..") || dir.includes("/") || dir.includes("\\") || dir.includes(":")) {
    Con_Printf("Gamedir should be a single filename, not a path\n");
    return;
  }

  if (gamedirfile === dir) return; // still the same
  gamedirfile = dir;

  //
  // free up any current game dir info
  //
  while (com_searchpaths !== com_base_searchpaths) {
    if (!com_searchpaths) break; // structurally unreachable: com_base_searchpaths is always an ancestor
    if (com_searchpaths.kind === "pack") Sys_FileClose(com_searchpaths.pack.handle);
    setComSearchpaths(com_searchpaths.next);
  }

  //
  // flush all data, so it will be forced to reload
  //
  Cache_Flush();

  if (dir === "id1" || dir === "qw") return;

  // Port deviation (Linux target): the C relies on a case-insensitive filesystem
  setComGamedir(Sys_ResolveCase(`${com_basedir}/${dir}`));

  //
  // add the directory to the search path
  //
  setComSearchpaths({ kind: "dir", filename: com_gamedir, next: com_searchpaths });

  //
  // add any pak files in the format pak0.pak pak1.pak, ...
  //
  for (let i = 0; ; i++) {
    // Port deviation (Linux target): the C relies on a case-insensitive filesystem
    const pakfile = Sys_ResolveCase(`${com_gamedir}/pak${i}.pak`);
    const pak = COM_LoadPackFile(pakfile);
    if (!pak) break;
    setComSearchpaths({ kind: "pack", pack: pak, next: com_searchpaths });
  }
}

//================
//
// COM_InitFilesystem
//
//================

export function COM_InitFilesystem(): void {
  // -basedir <path>
  // Overrides the system supplied base directory (under id1)
  const i = COM_CheckParm("-basedir");
  com_basedir = i && i < com_argc - 1 ? com_argv[i + 1] : host_parms.basedir;

  //
  // start up with id1 by default
  //
  COM_AddGameDirectory(`${com_basedir}/id1`);
  COM_AddGameDirectory(`${com_basedir}/qw`);

  // any set gamedirs will be freed up to here
  com_base_searchpaths = com_searchpaths;
}

//================
//
// COM_CheckRegistered
//
// Looks for the pop.txt file and verifies it.
// Sets the "registered" cvar.
//================

export function COM_CheckRegistered(): void {
  const { handle: h } = COM_FOpenFile("gfx/pop.lmp");
  setStaticRegistered(0);

  if (h === -1) {
    Con_Printf("Playing shareware version.\n");
    // #ifndef SERVERONLY -- client-only gate; qwsv does not error here, see file header
    if (com_modified) Sys_Error("You must have the registered version to play QuakeWorld");
    return;
  }

  const check = new Uint8Array(256); // unsigned short check[128]
  Sys_FileRead(h, check, 256);
  Sys_FileClose(h);

  const checkView = new DataView(check.buffer);
  for (let i = 0; i < 128; i++) {
    const raw = checkView.getUint16(i * 2, true); // native (LE) combine of the two file bytes
    if (pop[i] !== (BigShort(raw) & 0xffff)) Sys_Error("Corrupted data file.");
  }

  Cvar_Set("registered", "1");
  setStaticRegistered(1);
  Con_Printf("Playing registered version.\n");
}

//================
//
// COM_Init
//
//================

// cvar_t registered = {"registered","0"}; -- no archive/server/info, see file header
export const registered: CvarT = new CvarT("registered", "0");

export function COM_Init(): void {
  Cvar_RegisterVariable(registered);
  Cmd_AddCommand("path", COM_Path_f);

  COM_InitFilesystem();
  COM_CheckRegistered();
}

//=====================================================================
//
//  INFO STRINGS
//
//=====================================================================

export const MAX_INFO_STRING = 196;
export const MAX_SERVERINFO_STRING = 512;
export const MAX_LOCALINFO_STRING = 32768;

/*
===============
Info_ValueForKey

Searches the string for the given
key and returns the associated value, or an empty string.
===============
*/
export function Info_ValueForKey(s: string, key: string): string {
  let i = 0;
  if (s[i] === "\\") i++;

  for (;;) {
    let pkey = "";
    while (s[i] !== "\\") {
      if (i >= s.length) return "";
      pkey += s[i];
      i++;
    }
    i++;

    let value = "";
    while (i < s.length && s[i] !== "\\") {
      value += s[i];
      i++;
    }

    if (key === pkey) return value;

    if (i >= s.length) return "";
    i++;
  }
}

// RULINGS: returns a new string rather than mutating `s` in place -- see file header
export function Info_RemoveKey(s: string, key: string): string {
  if (key.includes("\\")) {
    Con_Printf("Can't use a key with a \\\n");
    return s;
  }

  let i = 0;
  for (;;) {
    const start = i;
    if (s[i] === "\\") i++;

    let pkey = "";
    while (s[i] !== "\\") {
      if (i >= s.length) return s;
      pkey += s[i];
      i++;
    }
    i++;

    while (i < s.length && s[i] !== "\\") i++;

    if (key === pkey) return s.slice(0, start) + s.slice(i); // strcpy(start, s) -- remove this part

    if (i >= s.length) return s;
  }
}

export function Info_RemovePrefixedKeys(start: string, prefix: string): string {
  let s = start;
  let i = 0;

  for (;;) {
    if (s[i] === "\\") i++;

    let pkey = "";
    while (s[i] !== "\\") {
      if (i >= s.length) return s;
      pkey += s[i];
      i++;
    }
    i++;

    while (i < s.length && s[i] !== "\\") i++;

    if (pkey[0] === prefix) {
      s = Info_RemoveKey(s, pkey);
      i = 0; // s = start (the same, now-shortened, buffer in the C)
    }

    if (i >= s.length) return s;
  }
}

function toLowerAscii(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

// RULINGS: SERVERONLY's sv_highchars-gated high-bit stripping is dropped
// (client path ported); see file header.
export function Info_SetValueForStarKey(s: string, key: string, value: string, maxsize: number): string {
  if (key.includes("\\") || value.includes("\\")) {
    Con_Printf("Can't use keys or values with a \\\n");
    return s;
  }

  if (key.includes('"') || value.includes('"')) {
    Con_Printf('Can\'t use keys or values with a "\n');
    return s;
  }

  if (key.length > 63 || value.length > 63) {
    Con_Printf("Keys and values must be < 64 characters.\n");
    return s;
  }

  // this next line is kinda trippy
  const v = Info_ValueForKey(s, key);
  if (v.length > 0) {
    // key exists, make sure we have enough room for new value, if we don't,
    // don't change it! (see file header re: the C's unsigned-wraparound check)
    if (value.length - v.length + s.length > maxsize) {
      Con_Printf("Info string length exceeded\n");
      return s;
    }
  }

  let result = Info_RemoveKey(s, key);
  if (value.length === 0) return result;

  const newPart = `\\${key}\\${value}`;

  if (newPart.length + result.length > maxsize) {
    Con_Printf("Info string length exceeded\n");
    return result;
  }

  // only copy ascii values
  let appendix = "";
  for (let vi = 0; vi < newPart.length; vi++) {
    let c = newPart.charCodeAt(vi) & 0xff; // (unsigned char)
    // client only allows highbits on name
    if (Q_strcasecmp(key, "name") !== 0) {
      c &= 127;
      if (c < 32 || c > 127) continue;
      // auto lowercase team
      if (Q_strcasecmp(key, "team") === 0) c = toLowerAscii(c);
    }
    if (c > 13) appendix += String.fromCharCode(c);
  }

  return result + appendix;
}

export function Info_SetValueForKey(s: string, key: string, value: string, maxsize: number): string {
  if (key[0] === "*") {
    Con_Printf("Can't set * keys\n");
    return s;
  }

  return Info_SetValueForStarKey(s, key, value, maxsize);
}

export function Info_Print(s: string): void {
  let i = 0;
  if (s[i] === "\\") i++;

  while (i < s.length) {
    let key = "";
    while (i < s.length && s[i] !== "\\") {
      key += s[i];
      i++;
    }

    if (key.length < 20) key = key + " ".repeat(20 - key.length);
    Con_Printf("%s", key);

    if (i >= s.length) {
      Con_Printf("MISSING VALUE\n");
      return;
    }

    let value = "";
    i++; // s++, skip the backslash
    while (i < s.length && s[i] !== "\\") {
      value += s[i];
      i++;
    }

    if (i < s.length) i++; // s++, skip the trailing backslash

    Con_Printf("%s\n", value);
  }
}

//============================================================================
//
// COM_BlockSequenceCRCByte
//
// For proxy protecting
//============================================================================

export function COM_BlockSequenceCRCByte(base: Uint8Array, length: number, sequence: number): number {
  const pIndex = sequence % (chktbl.length - 8);

  if (length > 60) length = 60;

  const chkb = new Uint8Array(60 + 4);
  chkb.set(base.subarray(0, length), 0);

  chkb[length] = (sequence & 0xff) ^ chktbl[pIndex];
  chkb[length + 1] = chktbl[pIndex + 1];
  chkb[length + 2] = ((sequence >> 8) & 0xff) ^ chktbl[pIndex + 2];
  chkb[length + 3] = chktbl[pIndex + 3];

  length += 4;

  let crc = CRC_Block(chkb, length);
  crc &= 0xff;

  return crc;
}

//============================================================================
//
// MSG_* additions/changes over src/common/sizebuf.ts (QW-only or
// differently-truncated wire encoding; see file header)
//
//============================================================================

export function MSG_WriteAngle(sb: SizeBuf, f: number): void {
  // f*256/360 computed in floating point, THEN truncated -- differs from
  // WinQuake's truncation order, see file header
  MSG_WriteByte(sb, Math.trunc((f * 256) / 360) & 255);
}

export function MSG_WriteAngle16(sb: SizeBuf, f: number): void {
  MSG_WriteShort(sb, Math.trunc((f * 65536) / 360) & 65535);
}

export function MSG_ReadAngle16(): number {
  return MSG_ReadShort() * (360.0 / 65536);
}

export function MSG_GetReadCount(): number {
  return msgState.readcount;
}

export function MSG_ReadStringLine(): string {
  let s = "";
  let l = 0;

  do {
    const c = MSG_ReadChar();
    if (c === -1 || c === 0 || c === 10 /* '\n' */) break;
    s += String.fromCharCode(c & 0xff);
    l++;
  } while (l < 2048 - 1);

  return s;
}

// usercmd_t nullcmd; // guarenteed to be zero
export const nullcmd: QwUsercmdT = new QwUsercmdT();

export function MSG_WriteDeltaUsercmd(buf: SizeBuf, from: QwUsercmdT, cmd: QwUsercmdT): void {
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

  if (bits & CM_ANGLE1) MSG_WriteAngle16(buf, cmd.angles[0]);
  if (bits & CM_ANGLE2) MSG_WriteAngle16(buf, cmd.angles[1]);
  if (bits & CM_ANGLE3) MSG_WriteAngle16(buf, cmd.angles[2]);

  if (bits & CM_FORWARD) MSG_WriteShort(buf, cmd.forwardmove);
  if (bits & CM_SIDE) MSG_WriteShort(buf, cmd.sidemove);
  if (bits & CM_UP) MSG_WriteShort(buf, cmd.upmove);

  if (bits & CM_BUTTONS) MSG_WriteByte(buf, cmd.buttons);
  if (bits & CM_IMPULSE) MSG_WriteByte(buf, cmd.impulse);
  MSG_WriteByte(buf, cmd.msec);
}

export function MSG_ReadDeltaUsercmd(from: QwUsercmdT, move: QwUsercmdT): void {
  // memcpy (move, from, sizeof(*move));
  VectorCopy(from.angles, move.angles);
  move.forwardmove = from.forwardmove;
  move.sidemove = from.sidemove;
  move.upmove = from.upmove;
  move.buttons = from.buttons;
  move.impulse = from.impulse;
  move.msec = from.msec;

  const bits = MSG_ReadByte();

  // read current angles
  if (bits & CM_ANGLE1) move.angles[0] = MSG_ReadAngle16();
  if (bits & CM_ANGLE2) move.angles[1] = MSG_ReadAngle16();
  if (bits & CM_ANGLE3) move.angles[2] = MSG_ReadAngle16();

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

// re-exported for callers that only need the type/constructor, not the wire helpers
export { type Vec3, vec3 };
