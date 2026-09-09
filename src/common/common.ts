/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/common.h and WinQuake/common.c (GNU GPL v2 or later).

common.c -- misc functions used in client and server, and the Quake
filesystem (searchpath_t/pack_t/PAK parsing, COM_LoadFile family). The
sizebuf_t and SZ_ / MSG_ half of common.h/common.c is src/common/sizebuf.ts.

Deviations from PORTING.md / the C source:
- `Q_memset/Q_memcpy/Q_memcmp/Q_strcpy/Q_strncpy/Q_strlen/Q_strrchr/Q_strcat/
  Q_strcmp/Q_strncmp` are libc-replacement wrappers with no meaning once
  strings are JS strings and buffers are typed arrays; dropped per the unit
  brief. `Q_strcasecmp`/`Q_strncasecmp` are kept but, ported bit-for-bit, the
  C implementation only ever returns -1 (not equal) or 0 (equal) -- it is an
  equality test, never a lexicographic ordering, so it never returns +1
  despite the general "-1/0/1 comparator" shorthand.
- `com_token`/`com_eof`: COM_Parse's ruling replaces the 1024-byte static
  `com_token` buffer and implicit cursor with an explicit `ParseState { data,
  index }` object; callers hold the returned token instead of reading a
  global. `com_eof` is declared `extern` in common.h but is never assigned
  anywhere in common.c (its producer, if any, lives in a file outside this
  unit's scope) and is not ported.
- `bigendien`/`BigShort`/`LittleShort`/`BigLong`/`LittleLong`/`BigFloat`/
  `LittleFloat` are C function pointers assigned at runtime in COM_Init from
  a byte-order self-test. This port only targets little-endian hosts (Bun's
  supported platforms), so they are fixed top-level functions instead:
  LittleX is the identity, BigX is the swap (ShortSwap/LongSwap/FloatSwap
  ported directly); COM_Init no longer runs the swaptest.
- `CRC_Init`/`CRC_ProcessByte` (crc.c -> src/common/crc.ts) are a separate,
  concurrent unit (not declared as an allowed sibling-fallback import for
  this brief) that landed while this one was in flight; imported directly.
- File I/O primitives the C reaches through sys.h (Sys_FileOpenRead/
  Sys_FileRead/Sys_FileWrite/Sys_FileOpenWrite/Sys_FileClose/Sys_FileSeek/
  Sys_FileTime/Sys_mkdir) are imported from src/platform/sys.ts, which is
  where the C's own common.c reaches them: COM_FindFile's loose-file branch
  is `com_filesize = Sys_FileOpenRead (netpath, &i)`, COM_LoadPackFile opens
  its pak with Sys_FileOpenRead, COM_LoadFile reads with Sys_FileRead, and
  COM_CloseFile ends in Sys_FileClose (common.c:1452, 1630, 1574, 1518).
  There is therefore ONE handle table for `int` handles in this port, the
  one src/platform/sys.ts owns (fd + read/write cursor, since node has no
  bare lseek), and a pak's shared fd (pack_t.handle) behaves exactly like
  the C's shared-descriptor reads -- including its "two simultaneous readers
  into the same pak clobber each other's position" quirk. This file kept a
  second, private table of its own until Q026, from before src/platform/sys.ts
  had file I/O (its own header note said to replace it once that landed);
  the two tables were both keyed by the real fd, so a handle opened by
  src/qw/common.ts (which always used sys.ts's) landed in neither this
  module's table nor its reads. `node:fs` is still used directly for the
  handle-less paths the C also does by hand (COM_CopyFile, COM_WriteFile's
  Sys_FileOpenWrite companion helpers, COM_FOpenFile's `FILE*` stand-in).
- `host_parms` (host.c's quakeparms_t, populated from argv before
  COM_InitFilesystem runs) has no owner yet (host.ts is U035). A local
  `QuakeParmsT` instance is declared here as a placeholder default source for
  -basedir/-cachedir fallback; when host.ts lands it should populate this
  same singleton (or common.ts should import its real one) before calling
  COM_InitFilesystem.
- `registered`/`cmdline` cvars, `Cvar_RegisterVariable`/`Cvar_Set`, and
  `Cmd_AddCommand` are reached from "./cvar" (U005) and "./cmd" (U004),
  concurrent units that landed while this one was in flight. `Cmd_AddCommand`
  is imported statically (it is a hoisted function declaration, safe under
  the cvar.ts <-> common.ts <-> cmd.ts cycle described at `cvarMod()` below).
  `CvarT` is a type-only import; `Cvar_RegisterVariable`/`Cvar_Set` are
  reached through `cvarMod()`'s lazy `require("./cvar")`, both to break that
  same cycle -- see the comment there. Had cvar.ts/cmd.ts not existed yet,
  `bun run check` would have failed with "Cannot find module './cvar'" /
  "'./cmd'" and errors on the imported names, the only acceptable failures
  per the unit brief; neither happened since both modules were already
  present when this unit ran its gate.
- `#if WINDED` in COM_CheckRegistered (a dedicated-Windows-server-only
  build define, distinct from this port's `-dedicated`/isDedicated flag,
  which PORTING.md does not provide an equivalent for) is dropped, matching
  the "#ifdef ... take the portable path" rule.
- `#ifdef _WIN32` path-separator/drive-letter handling in COM_FindFile's
  cache-path construction is dropped; the non-_WIN32 branch is the one kept.
- `Draw_BeginDisc`/`Draw_EndDisc` (loading-disc icon, draw.c) bracket the
  file read in COM_LoadFile; draw.ts is not part of the client render seam
  yet, so both calls are dropped (no observable behavior besides a UI icon).
- COM_LoadFile's `usehunk` distinction (0..4, i.e. Z_Malloc/Hunk_AllocName/
  Hunk_TempAlloc/Cache_Alloc/stack-buffer-or-temp) collapses to plain
  `Uint8Array` allocation, per PORTING.md's Memory section; the four public
  names (COM_LoadHunkFile/LoadTempFile/LoadCacheFile/LoadStackFile) stay
  exported, COM_LoadFile itself stays private (common.h never declared it
  either). COM_LoadCacheFile takes `cu: CacheUserT` (`{ data: Uint8Array |
  null }`) per the unit brief and sets `cu.data`; zone.ts is not imported.
  The C's `if (!buf) Sys_Error("not enough space")` guard against allocator
  failure has no equivalent (this port's allocation cannot fail) and is
  dropped. COM_LoadStackFile drops its `buffer`/`bufsize` parameters (the
  usehunk==4 stack-buffer-reuse path collapses to the same plain allocation
  as usehunk==2 once there is no allocator to economize on) -- cmd.ts's
  already-landed Cmd_Exec_f calls `COM_LoadStackFile(Cmd_Argv(1))` with just
  a path, which this signature matches.
- COM_WriteFile drops its `len` parameter: the caller passes a `Uint8Array`,
  which already carries its own length.
- COM_InitArgv takes `argv: string[]` (no separate `argc`; a JS array already
  knows its own length) instead of the C's `(argc, argv)` pair.
- COM_FindFile's C signature takes two mutually-exclusive out-parameters
  (`int *handle`, `FILE **file`) guarded by a runtime Sys_Error if both or
  neither are set; ported as an overloaded function keyed on a `"handle" |
  "file"` mode argument, so the exclusivity is enforced by the type system
  instead of a runtime check.
- MAX_QPATH/MAX_OSPATH (fixed C buffer sizes) are not needed: nothing here
  copies into a fixed-size buffer, so no length enforcement applies to JS
  strings. MAX_NUM_ARGVS already lives in quakedef.ts and is imported rather
  than redeclared.
- QuakeWorld track (Task 1, 2026-09-05): `setComArgc`/`setComArgv`/
  `setComSearchpaths`/`setComGamedir`/`setComModified`/`setStaticRegistered`/
  `setComFilesize` are exported setters, with no C counterpart, so that
  src/qw/common.ts's own filesystem functions can reassign this module's
  shared `com_argc`/`com_argv`/`com_searchpaths`/`com_gamedir`/`com_modified`/
  `static_registered`/`com_filesize` instead of keeping (and never being
  found through) a second parallel copy of this state -- see the "state"
  comment just above these bindings' declarations.
*/

import { GAMENAME, MAX_NUM_ARGVS, QuakeParmsT, qw } from "./quakedef";
import { activeProfile } from "./profile";
import { CRC_Init, CRC_ProcessByte } from "./crc";
import { Con_Printf } from "../client/console";
import {
  Sys_Error,
  Sys_FileClose,
  Sys_FileOpenMemory,
  Sys_FileOpenRead,
  Sys_FileRead,
  Sys_FileSeek,
  Sys_Printf,
  Sys_ResolveCase,
} from "../platform/sys";
import { Com_sprintf } from "./sprintf";
import type { CvarT } from "./cvar";
import type * as CvarModule from "./cvar";
import { Cmd_AddCommand } from "./cmd";
import { openSync, closeSync, readSync, writeSync, statSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { ZipArchive } from "../lib/zipfile";

// cvar.ts statically imports Q_atof from this module (real cycle: cvar.ts
// <-> common.ts <-> cmd.ts, all three reach into each other). Every other
// cross-reference between the three is used only inside function bodies, so
// the live-binding cycle resolves fine regardless of load order -- except
// this module's own top-level construction of the `registered`/`cmdline`
// singletons below, which needs the real `CvarT` class before cvar.ts is
// necessarily done initializing (whichever of the three modules a test
// enters through). `import type` above is erased at runtime and creates no
// edge; `cvarMod()` below reaches the real class lazily, exactly like
// wad.ts's/zone.ts's already-landed `./common` lazy-require pattern.
function cvarMod(): typeof CvarModule {
  return require("./cvar");
}

//============================================================================
//
//                      LIBRARY REPLACEMENT FUNCTIONS
//
//============================================================================

export function Q_strncasecmp(s1: string, s2: string, n: number): number {
  let i = 0;
  let count = n;

  while (true) {
    const c1raw = i < s1.length ? s1.charCodeAt(i) : 0;
    const c2raw = i < s2.length ? s2.charCodeAt(i) : 0;
    i++;

    if (count === 0) return 0; // strings are equal until end point
    count--;

    let c1 = c1raw;
    let c2 = c2raw;
    if (c1 !== c2) {
      if (c1 >= 97 && c1 <= 122) c1 -= 32; // 'a'-'A'
      if (c2 >= 97 && c2 <= 122) c2 -= 32;
      if (c1 !== c2) return -1; // strings not equal
    }
    if (!c1) return 0; // strings are equal
  }
}

export function Q_strcasecmp(s1: string, s2: string): number {
  return Q_strncasecmp(s1, s2, 99999);
}

export function Q_atoi(str: string): number {
  let i = 0;
  let sign: number;

  if (str[i] === "-") {
    sign = -1;
    i++;
  } else {
    sign = 1;
  }

  let val = 0;

  // check for hex
  if (str[i] === "0" && (str[i + 1] === "x" || str[i + 1] === "X")) {
    i += 2;
    while (true) {
      const ch = str[i];
      i++;
      const c = ch === undefined ? -1 : ch.charCodeAt(0);
      if (c >= 48 && c <= 57) val = (val << 4) + (c - 48);
      else if (c >= 97 && c <= 102) val = (val << 4) + (c - 97 + 10);
      else if (c >= 65 && c <= 70) val = (val << 4) + (c - 65 + 10);
      else return val * sign;
    }
  }

  // check for character
  if (str[i] === "'") {
    const next = str.charCodeAt(i + 1);
    return sign * (Number.isNaN(next) ? 0 : next);
  }

  // assume decimal
  while (true) {
    const ch = str[i];
    i++;
    const c = ch === undefined ? -1 : ch.charCodeAt(0);
    if (c < 48 || c > 57) return val * sign;
    val = val * 10 + (c - 48);
  }
}

export function Q_atof(str: string): number {
  let i = 0;
  let sign: number;

  if (str[i] === "-") {
    sign = -1;
    i++;
  } else {
    sign = 1;
  }

  let val = 0;

  // check for hex
  if (str[i] === "0" && (str[i + 1] === "x" || str[i + 1] === "X")) {
    i += 2;
    while (true) {
      const ch = str[i];
      i++;
      const c = ch === undefined ? -1 : ch.charCodeAt(0);
      if (c >= 48 && c <= 57) val = val * 16 + (c - 48);
      else if (c >= 97 && c <= 102) val = val * 16 + (c - 97 + 10);
      else if (c >= 65 && c <= 70) val = val * 16 + (c - 65 + 10);
      else return val * sign;
    }
  }

  // check for character
  if (str[i] === "'") {
    const next = str.charCodeAt(i + 1);
    return sign * (Number.isNaN(next) ? 0 : next);
  }

  // assume decimal
  let decimal = -1;
  let total = 0;
  while (true) {
    const ch = str[i];
    i++;
    if (ch === ".") {
      decimal = total;
      continue;
    }
    const c = ch === undefined ? -1 : ch.charCodeAt(0);
    if (c < 48 || c > 57) break;
    val = val * 10 + (c - 48);
    total++;
  }

  if (decimal === -1) return val * sign;
  while (total > decimal) {
    val /= 10;
    total--;
  }

  return val * sign;
}

//============================================================================
//
//                      BYTE ORDER FUNCTIONS
//
//============================================================================

// This port only targets little-endian hosts; see file header.
export const bigendien = false;

function shortSwap(l: number): number {
  const b1 = l & 255;
  const b2 = (l >> 8) & 255;
  return (b1 << 8) + b2;
}

function longSwap(l: number): number {
  const b1 = l & 255;
  const b2 = (l >> 8) & 255;
  const b3 = (l >> 16) & 255;
  const b4 = (l >> 24) & 255;
  return ((b1 << 24) + (b2 << 16) + (b3 << 8) + b4) | 0;
}

const floatSwapBuf = new ArrayBuffer(4);
const floatSwapView = new DataView(floatSwapBuf);
function floatSwap(f: number): number {
  floatSwapView.setFloat32(0, f, true);
  return floatSwapView.getFloat32(0, false);
}

export function BigShort(l: number): number {
  return shortSwap(l);
}
export function LittleShort(l: number): number {
  return l;
}
export function BigLong(l: number): number {
  return longSwap(l);
}
export function LittleLong(l: number): number {
  return l;
}
export function BigFloat(f: number): number {
  return floatSwap(f);
}
export function LittleFloat(f: number): number {
  return f;
}

//============================================================================
// COM_Parse

export interface ParseState {
  data: string;
  index: number;
}

function byteAt(data: string, i: number): number {
  return i < data.length ? data.charCodeAt(i) & 0xff : 0;
}
function signedByteAt(data: string, i: number): number {
  const b = byteAt(data, i);
  return b >= 128 ? b - 256 : b;
}

const SINGLE_CHAR_TOKENS = new Set([123, 125, 41, 40, 39, 58]); // { } ) ( ' :

export function COM_Parse(ps: ParseState): string | null {
  const data = ps.data;
  let i = ps.index;

  for (;;) {
    // skip whitespace
    let c = signedByteAt(data, i);
    while (c <= 32) {
      if (c === 0) {
        ps.index = i;
        return null; // end of file
      }
      i++;
      c = signedByteAt(data, i);
    }

    // skip // comments
    if (byteAt(data, i) === 47 && byteAt(data, i + 1) === 47) {
      while (byteAt(data, i) !== 0 && byteAt(data, i) !== 10) i++;
      continue; // goto skipwhite
    }

    break;
  }

  const c0 = byteAt(data, i);

  // handle quoted strings specially
  if (c0 === 34 /* '"' */) {
    i++;
    let token = "";
    for (;;) {
      const c = byteAt(data, i);
      i++;
      if (c === 34 || c === 0) {
        ps.index = i;
        return token;
      }
      token += String.fromCharCode(c);
    }
  }

  // parse single characters (QW/client/common.c has no such branch:
  // folded under qw.active per PORTING.md)
  if (activeProfile() !== "qw" && SINGLE_CHAR_TOKENS.has(c0)) {
    ps.index = i + 1;
    return String.fromCharCode(c0);
  }

  // parse a regular word
  let token = "";
  let c = c0;
  do {
    token += String.fromCharCode(c);
    i++;
    c = byteAt(data, i);
    if (activeProfile() !== "qw" && SINGLE_CHAR_TOKENS.has(c)) break;
  } while (signedByteAt(data, i) > 32);

  ps.index = i;
  return token;
}

//============================================================================

export const NUM_SAFE_ARGVS = 7;
export const CMDLINE_LENGTH = 256;

const argvdummy = " ";
const safeargvs = ["-stdvid", "-nolan", "-nosound", "-nocdaudio", "-nojoy", "-nomouse", "-dibonly"];

export function COM_CheckParm(parm: string): number {
  for (let i = 1; i < com_argc; i++) {
    if (!com_argv[i]) continue; // NEXTSTEP sometimes clears appkit vars.
    if (com_argv[i] === parm) return i;
  }
  return 0;
}

// does a varargs printf into a temp buffer, so I don't need to have
// varargs versions of all text functions.
export function va(format: string, ...args: Array<string | number>): string {
  return Com_sprintf(format, ...args);
}

//============================================================================

export function COM_SkipPath(pathname: string): string {
  const idx = pathname.lastIndexOf("/");
  return idx === -1 ? pathname : pathname.slice(idx + 1);
}

export function COM_StripExtension(inPath: string): string {
  const idx = inPath.indexOf(".");
  return idx === -1 ? inPath : inPath.slice(0, idx);
}

export function COM_FileExtension(inPath: string): string {
  const idx = inPath.indexOf(".");
  if (idx === -1) return "";
  return inPath.slice(idx + 1, idx + 1 + 7);
}

export function COM_FileBase(inPath: string): string {
  let dotIdx = inPath.lastIndexOf(".");
  if (dotIdx === -1) dotIdx = 0;
  const s2 = inPath.lastIndexOf("/", dotIdx);
  if (dotIdx - s2 < 2) return "?model?";
  return inPath.slice(s2 + 1, dotIdx);
}

export function COM_DefaultExtension(path: string, extension: string): string {
  let i = path.length - 1;
  while (i !== 0 && path[i] !== "/") {
    if (path[i] === ".") return path; // it has an extension
    i--;
  }
  return path + extension;
}

//============================================================================
//
// state: the C globals reassigned by COM_InitArgv/COM_Init/COM_InitFilesystem
// /COM_CheckRegistered/COM_LoadPackFile/COM_AddGameDirectory. PORTING.md's
// own rule for these is "a small exported holder with a setter"; they are
// plain top-level `export let` bindings instead (ES module live bindings
// give every importer the current value on each read, the same effect),
// matching cmd.ts's and zone.ts's already-landed `com_argc`/`com_argv`
// imports from this module -- a holder object would not satisfy those.
//
//============================================================================

export interface PackFileT {
  name: string;
  filepos: number;
  filelen: number;
}

export interface PackT {
  filename: string;
  handle: number;
  numfiles: number;
  files: PackFileT[];
}

// Re-release addition (U10): a KEX-era `.kpf`/`.pk3` mount (QuakeEX.kpf, or
// a mod's own zip dropped into a gamedir). Not a port of any classic C
// struct -- see src/lib/zipfile.ts's own header for why this is a
// from-scratch reader, and quake-2-re-ts's src/qcommon/files.ts ZipPackT for
// the shape this mirrors.
export interface ZipT {
  filename: string;
  archive: ZipArchive;
  numfiles: number;
}

// "only one of filename / pack will be used" (searchpath_t's C comment)
// becomes a discriminated union, matching ../quake-2-ts/src/qcommon/files.ts.
export type SearchPathT =
  | { kind: "dir"; filename: string; next: SearchPathT | null }
  | { kind: "pack"; pack: PackT; next: SearchPathT | null }
  | { kind: "zip"; zip: ZipT; next: SearchPathT | null };

export let com_argc = 0;
export let com_argv: string[] = [];
export let com_cmdline = "";
export let com_filesize = -1;
export let com_modified = false; // set true if using non-id files
export let msg_suppress_1 = false;
export let static_registered = 1; // only for startup check, then set
export let com_gamedir = "";
export let com_cachedir = "";
// -homedir <dir> / -nohomedir (re-release addition, no WinQuake equivalent):
// "" means "write into com_gamedir" -- the unmodified behaviour, which is
// what -nohomedir selects. With neither parameter given this defaults to
// COM_DefaultHomeDir() below. See COM_AddGameDirectory's own comment at the
// mount site for the write-target and search-priority effect this has once
// it's non-empty.
export let com_homedir = "";
export let standard_quake = true;
export let rogue = false;
export let hipnotic = false;
// Re-release mission-pack-style episode flags (U10): -mg1/-mg3/-dopa/-ctf,
// exported next to hipnotic/rogue the same way, set in COM_InitArgv below
// and consulted by COM_InitFilesystem/COM_ResetGameDirectories to decide
// which directory under the active episode root (see episodeRoot() below)
// to mount.
export let mg1 = false;
export let mg3 = false;
export let dopa = false;
export let ctf = false;
export let proghack = false;
export let com_searchpaths: SearchPathT | null = null;
// The search path exactly as of the end of the BASE tier (classic id1
// and/or a re-release root's QuakeEX.kpf + id1 -- see COM_InitFilesystem):
// everything mounted above this is what COM_ResetGameDirectories/the
// runtime "game" command tear down and rebuild, mirroring Ironwail's own
// com_base_searchpaths (common.c:3209).
let com_base_searchpaths: SearchPathT | null = null;
// The gamedir names mounted above the base tier since boot or the last
// "game" switch, in mount order -- COM_GetGameNames()'s source, and how
// COM_ResetGameDirectories skips a name that's already loaded.
let com_gamenames: string[] = [];
// com_gamedir as the boot left it once the base tier was pinned (the id1 home
// mirror, or <basedir>/id1 under -nohomedir). COM_ResetGameDirectories starts
// from it: without this, `game id1` after a mod left com_gamedir -- and so
// config.cfg, saves and screenshots -- in the mod's directory (found 2026-09-07
// while checking P8 from the player's side).
let com_base_gamedir = "";
// The content root generic (non-mission-pack) gamedir mounts -- -game
// <dir>, and any plain directory name passed to the "game" command -- are
// resolved against as the FIRST preference (episodeRoot() also uses this
// for mission-pack dirs). Set once per COM_InitFilesystem call.
let com_basedir = "";
// resolveGameDir's FALLBACK root: the plain content root, deliberately
// excluding the re-release-root preference com_basedir carries (checking
// "<com_basedir>/<name>" again when <rereleaseroot>/<name> already failed
// to exist would just repeat the same failed lookup whenever com_basedir
// IS the re-release root). classicRoot when one was mounted, else the same
// basedir com_basedir falls back to.
let com_plain_basedir = "";
// "" when no re-release root was mounted; otherwise the directory that
// holds QuakeEX.kpf/id1 for the active install (the basedir itself, or its
// "rerelease" subdirectory in the nested-classic-root case). Backs
// COM_IsRereleaseRoot()/COM_RereleaseDir() and episodeRoot() below.
let com_rerelease_root = "";
// "" when no classic root was mounted (a pure re-release-only install);
// otherwise the directory holding the classic id1. Exposed via
// COM_ClassicDir() for the menu unit's future New Game scan, alongside
// COM_RereleaseDir().
let com_classic_root = "";

// QuakeWorld track (Task 1, 2026-09-05): src/qw/common.ts's own filesystem
// functions (COM_InitFilesystem, COM_Gamedir, COM_AddGameDirectory,
// COM_LoadPackFile, COM_CheckRegistered, COM_InitArgv, COM_AddParm) differ
// from these bodies but must reassign this module's shared state -- every
// consumer of COM_FindFile/COM_LoadFile (model.ts's Mod_ForName, wad.ts,
// cmd.ts's Cmd_Exec_f, ...) reads com_searchpaths/com_gamedir/etc. through
// THIS module, so a QW binary that kept its own parallel copies (as it used
// to) would never actually be found by any of them. ES module named imports
// are read-only bindings (TS2540, "Cannot assign to '...' because it is a
// read-only property"), so a same-module setter is the only way another
// module can reassign an `export let` here; see src/qw/common.ts's own
// header for exactly which of its functions call each of these and why.
export function setComArgc(n: number): void {
  com_argc = n;
}
export function setComArgv(argv: string[]): void {
  com_argv = argv;
}
export function setComSearchpaths(p: SearchPathT | null): void {
  com_searchpaths = p;
}
export function setComGamedir(s: string): void {
  com_gamedir = s;
}
// com_homedir is normally set once, by COM_InitFilesystem's -homedir/
// -nohomedir/COM_DefaultHomeDir chain. This setter exists for the same
// reason the ones above it do -- an `export let` cannot be assigned through
// a named import -- and is what a caller reaching COM_AddGameDirectory
// WITHOUT going through COM_InitFilesystem uses to pick its write tier.
export function setComHomedir(s: string): void {
  com_homedir = s;
}
export function setComModified(b: boolean): void {
  com_modified = b;
}
export function setStaticRegistered(n: number): void {
  static_registered = n;
}
export function setComFilesize(n: number): void {
  com_filesize = n;
}
// Re-release addition (U10): hipnotic/rogue/mg1/mg3/dopa/ctf/standard_quake
// are sticky exactly like com_modified (COM_InitArgv/COM_InitFilesystem only
// ever sets them true; nothing but the runtime "game" command's
// COM_ResetGameDirectories ever sets them back false, matching Ironwail's
// own COM_InitArgv/COM_ResetGameDirectories) -- test files that exercise
// -hipnotic/-mg1/etc or the "game" command need a way to restore the
// pre-test value afterward, the same reason setComModified/
// setStaticRegistered exist above.
export function setHipnotic(b: boolean): void {
  hipnotic = b;
}
export function setRogue(b: boolean): void {
  rogue = b;
}
export function setMg1(b: boolean): void {
  mg1 = b;
}
export function setMg3(b: boolean): void {
  mg3 = b;
}
export function setDopa(b: boolean): void {
  dopa = b;
}
export function setCtf(b: boolean): void {
  ctf = b;
}
export function setStandardQuake(b: boolean): void {
  standard_quake = b;
}

export const host_parms = new QuakeParmsT();

export function COM_InitArgv(argv: string[]): void {
  const argc = argv.length;

  // reconstitute the command line for the cmdline externally visible cvar
  let n = 0;
  let cmdlineText = "";
  for (let j = 0; j < MAX_NUM_ARGVS && j < argc; j++) {
    const a = argv[j];
    let i = 0;
    while (n < CMDLINE_LENGTH - 1 && i < a.length) {
      cmdlineText += a[i];
      n++;
      i++;
    }
    if (n < CMDLINE_LENGTH - 1) {
      cmdlineText += " ";
      n++;
    } else break;
  }
  com_cmdline = cmdlineText;

  let safe = false;
  const largv: string[] = [];
  let argc2 = 0;
  for (; argc2 < MAX_NUM_ARGVS && argc2 < argc; argc2++) {
    largv[argc2] = argv[argc2];
    if (argv[argc2] === "-safe") safe = true;
  }

  if (safe) {
    // force all the safe-mode switches. Note that we reserved extra space in
    // case we need to add these, so we don't need an overflow check
    for (let i = 0; i < NUM_SAFE_ARGVS; i++) {
      largv[argc2] = safeargvs[i];
      argc2++;
    }
  }

  largv[argc2] = argvdummy;
  com_argc = argc2;
  com_argv = largv;

  if (COM_CheckParm("-rogue")) {
    rogue = true;
    standard_quake = false;
  }
  if (COM_CheckParm("-hipnotic")) {
    hipnotic = true;
    standard_quake = false;
  }
  // Re-release mission-pack-style episodes (U10): same pattern as
  // -rogue/-hipnotic above.
  if (COM_CheckParm("-mg1")) {
    mg1 = true;
    standard_quake = false;
  }
  if (COM_CheckParm("-mg3")) {
    mg3 = true;
    standard_quake = false;
  }
  if (COM_CheckParm("-dopa")) {
    dopa = true;
    standard_quake = false;
  }
  if (COM_CheckParm("-ctf")) {
    ctf = true;
    standard_quake = false;
  }
}

// cvar_t registered = {"registered","0"};
// cvar_t cmdline = {"cmdline","0", false, true};
// Plain object literals (structurally a CvarT) rather than `new CvarT(...)`
// -- see cvarMod()'s comment above.
export const registered: CvarT = {
  name: "registered",
  string: "0",
  defaultString: "0",
  archive: false,
  server: false,
  info: false,
  value: 0,
  next: null,
};
export const cmdline: CvarT = {
  name: "cmdline",
  string: "0",
  defaultString: "0",
  archive: false,
  server: true,
  info: false,
  value: 0,
  next: null,
};

export function COM_Init(basedir: string): void {
  // basedir is unused in the C too -- host_parms.basedir is what
  // COM_InitFilesystem actually reads.
  void basedir;

  const { Cvar_RegisterVariable } = cvarMod();
  Cvar_RegisterVariable(registered);
  Cvar_RegisterVariable(cmdline);
  Cmd_AddCommand("path", COM_Path_f);

  COM_InitFilesystem();
  COM_CheckRegistered();
}

//============================================================================
//
//                            QUAKE FILESYSTEM
//
//============================================================================

// if a packfile directory differs from this, it is assumed to be hacked
export const PAK0_COUNT = 339;
export const PAK0_CRC = 32981;
export const MAX_FILES_IN_PACK = 2048;

//
// on disk
//
export const DPACKHEADER_T_SIZE = 12; // id[4] + dirofs(4) + dirlen(4)
const DPACKFILE_NAME_LEN = 56;
export const DPACKFILE_T_SIZE = DPACKFILE_NAME_LEN + 4 + 4; // 64

export interface DpackheaderT {
  id: string;
  dirofs: number;
  dirlen: number;
}
export interface DpackfileT {
  name: string;
  filepos: number;
  filelen: number;
}

export function readDpackheader(buf: Uint8Array, offset = 0): DpackheaderT {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, DPACKHEADER_T_SIZE);
  const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
  return { id, dirofs: view.getInt32(4, true), dirlen: view.getInt32(8, true) };
}

export function readDpackfile(buf: Uint8Array, offset = 0): DpackfileT {
  let name = "";
  for (let i = 0; i < DPACKFILE_NAME_LEN; i++) {
    const c = buf[offset + i];
    if (c === 0) break;
    name += String.fromCharCode(c);
  }
  const view = new DataView(buf.buffer, buf.byteOffset + offset + DPACKFILE_NAME_LEN, 8);
  return { name, filepos: view.getInt32(0, true), filelen: view.getInt32(4, true) };
}

// this graphic needs to be in the pak file to use registered features
// prettier-ignore
const pop: readonly number[] = [
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x6600, 0x0000, 0x0000, 0x0000, 0x6600, 0x0000,
  0x0000, 0x0066, 0x0000, 0x0000, 0x0000, 0x0000, 0x0067, 0x0000,
  0x0000, 0x6665, 0x0000, 0x0000, 0x0000, 0x0000, 0x0065, 0x6600,
  0x0063, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6563,
  0x0064, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6564,
  0x0064, 0x6564, 0x0000, 0x6469, 0x6969, 0x6400, 0x0064, 0x6564,
  0x0063, 0x6568, 0x6200, 0x0064, 0x6864, 0x0000, 0x6268, 0x6563,
  0x0000, 0x6567, 0x6963, 0x0064, 0x6764, 0x0063, 0x6967, 0x6500,
  0x0000, 0x6266, 0x6769, 0x6a68, 0x6768, 0x6a69, 0x6766, 0x6200,
  0x0000, 0x0062, 0x6566, 0x6666, 0x6666, 0x6666, 0x6562, 0x0000,
  0x0000, 0x0000, 0x0062, 0x6364, 0x6664, 0x6362, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0062, 0x6662, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0061, 0x6661, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x6500, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x6400, 0x0000, 0x0000, 0x0000,
];
export { pop };

//============================================================================

function sysFileTime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return -1;
  }
}

function sysMkdir(dir: string): void {
  try {
    mkdirSync(dir);
  } catch {
    // Sys_mkdir in the C also ignores mkdir() failures (e.g. EEXIST)
  }
}

// COM_FRead/COM_FClose are this port's stand-ins for fread()/fclose() on the
// FILE* handles COM_FOpenFile hands back (see file header). `data`, when
// set, is a re-release addition (U10): a zip mount's entry has already been
// fully inflated into a JS buffer by the time COM_FindFile hands one back
// (see src/lib/zipfile.ts's header on why DEFLATE entries can't be streamed
// incrementally through a bare fd the way a .pak's stored bytes can), so
// `fd` is meaningless for such a handle (left -1) and reads/close are
// served out of `data` instead.
export class FileHandle {
  fd: number;
  pos: number;
  data: Uint8Array | null;
  constructor(fd: number, pos: number, data: Uint8Array | null = null) {
    this.fd = fd;
    this.pos = pos;
    this.data = data;
  }
}

export function COM_FRead(f: FileHandle, buf: Uint8Array, len: number): number {
  if (f.data) {
    const n = Math.min(len, f.data.length - f.pos);
    if (n <= 0) return 0;
    buf.set(f.data.subarray(f.pos, f.pos + n), 0);
    f.pos += n;
    return n;
  }
  const n = readSync(f.fd, buf, 0, len, f.pos);
  f.pos += n;
  return n;
}

export function COM_FClose(f: FileHandle): void {
  if (f.data) return; // memory-backed: no real fd to close
  closeSync(f.fd);
}

//============================================================
//
// COM_Path_f
//
//============================================================

export function COM_Path_f(): void {
  Con_Printf("Current search path:\n");
  for (let s = com_searchpaths; s; s = s.next) {
    if (s.kind === "pack") Con_Printf("%s (%i files)\n", s.pack.filename, s.pack.numfiles);
    else if (s.kind === "zip") Con_Printf("%s (%i files)\n", s.zip.filename, s.zip.numfiles);
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

  let fd: number;
  try {
    fd = openSync(name, "w");
  } catch {
    Sys_Printf("COM_WriteFile: failed on %s\n", name);
    return;
  }

  Sys_Printf("COM_WriteFile: %s\n", name);
  writeSync(fd, data, 0, data.length);
  closeSync(fd);
}

//============================================================
//
// COM_CreatePath
//
// Only used for CopyFile
//============================================================

export function COM_CreatePath(path: string): void {
  for (let i = 1; i < path.length; i++) {
    if (path[i] === "/") sysMkdir(path.slice(0, i));
  }
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
  let inFd: number;
  let remaining: number;
  try {
    inFd = openSync(netpath, "r");
    remaining = statSync(netpath).size;
  } catch {
    return;
  }

  COM_CreatePath(cachepath); // create directories up to the cache file
  const outFd = openSync(cachepath, "w");

  const buf = new Uint8Array(4096);
  let pos = 0;
  while (remaining) {
    const count = remaining < buf.length ? remaining : buf.length;
    readSync(inFd, buf, 0, count, pos);
    writeSync(outFd, buf, 0, count);
    pos += count;
    remaining -= count;
  }

  closeSync(inFd);
  closeSync(outFd);
}

//===========================================================
//
// COM_FindFile
//
// Finds the file in the search path.
// Sets com_filesize and returns either a handle or a FileHandle.
//===========================================================

export function COM_FindFile(filename: string, mode: "handle"): { handle: number; length: number };
export function COM_FindFile(filename: string, mode: "file"): { file: FileHandle | null; length: number };
export function COM_FindFile(
  filename: string,
  mode: "handle" | "file",
): { handle: number; length: number } | { file: FileHandle | null; length: number } {
  let search = com_searchpaths;

  if (proghack && filename === "progs.dat" && search) {
    // gross hack to use quake 1 progs with quake 2 maps
    search = search.next;
  }

  for (; search; search = search.next) {
    if (search.kind === "pack") {
      // is the element a pak file? look through all the pak file elements
      const pak = search.pack;
      for (let i = 0; i < pak.numfiles; i++) {
        if (pak.files[i].name !== filename) continue;

        // found it!
        Sys_Printf("PackFile: %s : %s\n", pak.filename, filename);
        com_filesize = pak.files[i].filelen;

        if (mode === "handle") {
          Sys_FileSeek(pak.handle, pak.files[i].filepos);
          return { handle: pak.handle, length: com_filesize };
        }

        // open a new file on the pakfile
        try {
          const fd = openSync(pak.filename, "r");
          return { file: new FileHandle(fd, pak.files[i].filepos), length: com_filesize };
        } catch {
          return { file: null, length: com_filesize };
        }
      }
    } else if (search.kind === "zip") {
      // Re-release addition (U10): look through the zip archive's entries
      // (case-insensitive -- see src/lib/zipfile.ts's ZipArchive.readFile).
      const data = search.zip.archive.readFile(filename);
      if (data === null) continue;

      Sys_Printf("PackFile: %s : %s\n", search.zip.filename, filename);
      com_filesize = data.length;

      if (mode === "handle") return { handle: Sys_FileOpenMemory(data), length: com_filesize };

      return { file: new FileHandle(-1, 0, data), length: com_filesize };
    } else {
      // check a file in the directory tree
      if (!static_registered) {
        // if not a registered version, don't ever go beyond base
        if (filename.includes("/") || filename.includes("\\")) continue;
      }

      const netpath = `${search.filename}/${filename}`;

      const findtime = sysFileTime(netpath);
      if (findtime === -1) continue;

      // see if the file needs to be updated in the cache
      let finalPath: string;
      if (!com_cachedir) {
        finalPath = netpath;
      } else {
        const cachepath = `${com_cachedir}${netpath}`;
        const cachetime = sysFileTime(cachepath);
        if (cachetime < findtime) COM_CopyFile(netpath, cachepath);
        finalPath = cachepath;
      }

      Sys_Printf("FindFile: %s\n", finalPath);

      let length: number;
      try {
        length = statSync(finalPath).size;
      } catch {
        continue;
      }
      com_filesize = length;

      if (mode === "handle") {
        // `com_filesize = Sys_FileOpenRead (netpath, &i); ... *handle = i;`
        // (the fstat'd size Sys_FileOpenRead returns is the same number the
        // statSync above produced; the C reads com_filesize off this call,
        // and -1 from it means "open failed" for both fields.)
        const { handle, length: openLength } = Sys_FileOpenRead(finalPath);
        com_filesize = openLength;
        return { handle, length: openLength };
      }

      const fd = openSync(finalPath, "r");
      return { file: new FileHandle(fd, 0), length };
    }
  }

  Sys_Printf("FindFile: can't find %s\n", filename);

  com_filesize = -1;
  if (mode === "handle") return { handle: -1, length: -1 };
  return { file: null, length: -1 };
}

//===========================================================
//
// COM_FindFileTier (U4 addition, re-release map support)
//
// Ironwail's COM_LoadHunkFile/COM_FOpenFile return a `path_id` alongside
// the file, and gl_model.c's Mod_LoadLighting/Mod_LoadEntities compare an
// external .lit/.ent file's path_id against the bsp's own to decide whether
// to trust it ("use the file only from the same gamedir as the map itself
// or from a searchpath with higher priority"). Nothing in this port's
// COM_FindFile/COM_LoadFile family exposes which search-path node a lookup
// resolved in, so src/common/model.ts's own port of that rule needs the
// smallest addition that does: which node of com_searchpaths (0 = the
// highest-priority node, i.e. the head of the list) a filename would
// resolve against, without opening it or touching com_filesize the way an
// actual COM_FindFile call does. Returns -1 if the file is not found in any
// search path (mirrors COM_FindFile's own walk, including the proghack
// skip and the not-statically-registered loose-path restriction).
//===========================================================

export function COM_FindFileTier(filename: string): number {
  let search = com_searchpaths;
  let tier = 0;

  if (proghack && filename === "progs.dat" && search) search = search.next;

  for (; search; search = search.next, tier++) {
    if (search.kind === "pack") {
      const pak = search.pack;
      for (let i = 0; i < pak.numfiles; i++) {
        if (pak.files[i].name === filename) return tier;
      }
    } else if (search.kind === "zip") {
      if (search.zip.archive.findEntry(filename)) return tier;
    } else {
      if (!static_registered && (filename.includes("/") || filename.includes("\\"))) continue;

      const netpath = `${search.filename}/${filename}`;
      if (sysFileTime(netpath) !== -1) return tier;
    }
  }

  return -1;
}

//===========================================================
//
// COM_FindFilePath (re-release addition, U10)
//
// Resolves `filename` to a real on-disk path by walking com_searchpaths'
// "dir" entries only, highest priority first -- "pack"/"zip" mounts have no
// bare filesystem path a foreign library can open directly (a zip entry in
// particular has already been decompressed into memory by the time anything
// here would see it). Used by src/platform/cd_ogg.ts, which hands a path to
// libvorbisfile's ov_fopen rather than reading through COM_FindFile itself.
// A pure probe like COM_FindFileTier: nothing is opened, com_filesize is
// untouched, and nothing is printed.
//===========================================================

export function COM_FindFilePath(filename: string): string | null {
  for (let search = com_searchpaths; search; search = search.next) {
    if (search.kind !== "dir") continue;
    const netpath = `${search.filename}/${filename}`;
    if (sysFileTime(netpath) !== -1) return netpath;
  }
  return null;
}

//===========================================================
//
// COM_LoadAllFiles (additive, U30: localization mod-file overlays)
//
// COM_FindFile/COM_LoadFile only ever return the highest-priority match for
// a name. The re-release's `loc_<lang>_mod.txt` overlay convention (a mod
// directory's own mod-specific loc terms, meant to be layered on top of the
// base language file rather than replace it -- see src/lib/loc.ts's
// Loc_MergeFile) needs every match across the whole search path, not just
// the first, so the engine can apply them in priority order itself.
//
// Mirrors COM_FindFile's own per-node walk (pack directory scan, zip
// archive lookup, on-disk dir probe with the same not-statically-registered
// loose-path restriction and cache-dir mirroring) but collects every match
// instead of stopping at the first one. Returns each match's bytes ordered
// from LOWEST priority (the tail of com_searchpaths, e.g. id1) to HIGHEST
// (the head, e.g. a mod directory mounted with -game) -- the order a caller
// applies them in so the highest-priority one is merged, and therefore
// wins, last. Like COM_FindFileTier/COM_FindFilePath above, this never
// touches com_filesize and never prints.
//===========================================================

export function COM_LoadAllFiles(filename: string): Uint8Array[] {
  const matches: Uint8Array[] = [];

  for (let search = com_searchpaths; search; search = search.next) {
    if (search.kind === "pack") {
      const pak = search.pack;
      for (let i = 0; i < pak.numfiles; i++) {
        if (pak.files[i].name !== filename) continue;
        // Shared pak descriptor, same seek-then-read convention as
        // COM_FindFile's own "handle" branch -- see this file's header note
        // on the one shared-descriptor handle table.
        Sys_FileSeek(pak.handle, pak.files[i].filepos);
        const buf = new Uint8Array(pak.files[i].filelen);
        Sys_FileRead(pak.handle, buf, pak.files[i].filelen);
        matches.push(buf);
        break;
      }
    } else if (search.kind === "zip") {
      const data = search.zip.archive.readFile(filename);
      if (data !== null) matches.push(data);
    } else {
      if (!static_registered && (filename.includes("/") || filename.includes("\\"))) continue;

      const netpath = `${search.filename}/${filename}`;
      const findtime = sysFileTime(netpath);
      if (findtime === -1) continue;

      let finalPath = netpath;
      if (com_cachedir) {
        const cachepath = `${com_cachedir}${netpath}`;
        const cachetime = sysFileTime(cachepath);
        if (cachetime < findtime) COM_CopyFile(netpath, cachepath);
        finalPath = cachepath;
      }

      let length: number;
      try {
        length = statSync(finalPath).size;
      } catch {
        continue;
      }

      const buf = new Uint8Array(length);
      const { handle: fd } = Sys_FileOpenRead(finalPath);
      Sys_FileRead(fd, buf, length);
      Sys_FileClose(fd);
      matches.push(buf);
    }
  }

  return matches.reverse();
}

//===========================================================
//
// COM_OpenFile
//
// filename never has a leading slash, but may contain directory walks
// returns a handle and a length. It may actually be inside a pak file.
//===========================================================

export function COM_OpenFile(filename: string): { handle: number; length: number } {
  return COM_FindFile(filename, "handle");
}

//===========================================================
//
// COM_FOpenFile
//
// If the requested file is inside a packfile, a new fd will be opened into
// the file.
//===========================================================

export function COM_FOpenFile(filename: string): { file: FileHandle | null; length: number } {
  return COM_FindFile(filename, "file");
}

//============================================================
//
// COM_CloseFile
//
// If it is a pak file handle, don't really close it
//============================================================

export function COM_CloseFile(h: number): void {
  for (let s = com_searchpaths; s; s = s.next) {
    if (s.kind === "pack" && s.pack.handle === h) return;
  }

  Sys_FileClose(h);
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

function COM_LoadFile(path: string, usehunk: 0 | 1 | 2 | 3): Uint8Array | null {
  // look for it in the filesystem or pack files
  const { handle: h, length: len } = COM_OpenFile(path);
  if (h === -1) return null;

  const buf = new Uint8Array(len + 1);
  if (usehunk === 3) {
    if (loadcache) loadcache.data = buf;
  }

  buf[len] = 0;

  Sys_FileRead(h, buf, len);
  COM_CloseFile(h);

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

// The C's usehunk==4 path (COM_LoadStackFile) takes a caller-supplied stack
// buffer and only falls back to a temp allocation when the file is larger
// than it; that stack-buffer optimization has no meaning once usehunk
// collapses to plain allocation (this unit's own ruling), and cmd.ts's
// already-landed Cmd_Exec_f calls this with just a path (no buffer/bufsize),
// so those parameters are dropped here to match.
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
  const { handle: fd } = Sys_FileOpenRead(packfile);
  if (fd === -1) {
    //              Con_Printf ("Couldn't open %s\n", packfile);
    return null;
  }

  const headerBuf = new Uint8Array(DPACKHEADER_T_SIZE);
  Sys_FileRead(fd, headerBuf, DPACKHEADER_T_SIZE);
  const header = readDpackheader(headerBuf);

  if (header.id !== "PACK") Sys_Error("%s is not a packfile", packfile);

  const numpackfiles = Math.trunc(header.dirlen / DPACKFILE_T_SIZE);

  if (numpackfiles > MAX_FILES_IN_PACK) Sys_Error("%s has %i files", packfile, numpackfiles);

  if (numpackfiles !== PAK0_COUNT) com_modified = true; // not the original file

  const info = new Uint8Array(header.dirlen);
  Sys_FileSeek(fd, header.dirofs);
  Sys_FileRead(fd, info, header.dirlen);

  // crc the directory to check for modifications
  let crc = CRC_Init();
  for (let i = 0; i < header.dirlen; i++) crc = CRC_ProcessByte(crc, info[i]);
  if (crc !== PAK0_CRC) com_modified = true;

  // parse the directory
  const files: PackFileT[] = [];
  for (let i = 0; i < numpackfiles; i++) {
    const rec = readDpackfile(info, i * DPACKFILE_T_SIZE);
    files.push({ name: rec.name, filepos: rec.filepos, filelen: rec.filelen });
  }

  const pack: PackT = { filename: packfile, handle: fd, numfiles: numpackfiles, files };

  Con_Printf("Added packfile %s (%i files)\n", packfile, numpackfiles);
  return pack;
}

//=================
//
// peekPackFileNames (re-release addition, U10)
//
// Reads a pak's header and directory ONLY -- never its file contents --
// and returns the bare list of entry names, or null if `packfile` doesn't
// open or isn't a well-formed PACK. Used by COM_IsRereleaseRootDir to check
// for mapdb.json inside id1/pak0.pak without loading the (200+ MB) pak
// itself, and without COM_LoadPackFile's side effects (com_modified, the
// CRC check, mounting it) -- this is a probe, not a load.
//=================

function peekPackFileNames(packfile: string): string[] | null {
  const { handle: fd } = Sys_FileOpenRead(packfile);
  if (fd === -1) return null;

  const headerBuf = new Uint8Array(DPACKHEADER_T_SIZE);
  Sys_FileRead(fd, headerBuf, DPACKHEADER_T_SIZE);
  const header = readDpackheader(headerBuf);

  if (header.id !== "PACK") {
    Sys_FileClose(fd);
    return null;
  }

  const numpackfiles = Math.trunc(header.dirlen / DPACKFILE_T_SIZE);
  const info = new Uint8Array(header.dirlen);
  Sys_FileSeek(fd, header.dirofs);
  Sys_FileRead(fd, info, header.dirlen);
  Sys_FileClose(fd);

  const names: string[] = [];
  for (let i = 0; i < numpackfiles; i++) names.push(readDpackfile(info, i * DPACKFILE_T_SIZE).name);
  return names;
}

//=================
//
// COM_LoadZipFile (re-release addition, U10)
//
// Takes an explicit path to a `.kpf`/`.pk3` archive (QuakeEX.kpf, or a mod's
// own zip dropped into a gamedir) and reads the whole file so
// ZipArchive.open can parse its central directory. Unlike COM_LoadPackFile,
// there is no "modified" CRC check to run -- a zip's own per-entry CRC32
// is not validated by src/lib/zipfile.ts (see that file's header).
//=================

export function COM_LoadZipFile(zipfile: string): ZipT | null {
  const { handle: fd, length } = Sys_FileOpenRead(zipfile);
  if (fd === -1) return null;

  const buf = new Uint8Array(length);
  Sys_FileRead(fd, buf, length);
  Sys_FileClose(fd);

  const archive = ZipArchive.open(buf);
  if (!archive) return null;

  Con_Printf("Added packfile %s (%i files)\n", zipfile, archive.entries.length);
  return { filename: zipfile, archive, numfiles: archive.entries.length };
}

// Every `.kpf`/`.pk3` directly inside `dir`, sorted, as full paths.
function listZipFilesInDir(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.endsWith(".kpf") || lower.endsWith(".pk3");
    })
    .sort()
    .map((name) => `${dir}/${name}`);
}

//================
//
// COM_AddGameDirectory
//
// Sets com_gamedir, adds the directory to the head of the path,
// then loads and adds pak1.pak pak2.pak ...
//================

export function COM_AddGameDirectory(dir: string): void {
  // Port deviation (Linux target): the C relies on a case-insensitive filesystem
  dir = Sys_ResolveCase(dir);
  com_gamedir = dir;

  // add the directory to the search path
  com_searchpaths = { kind: "dir", filename: dir, next: com_searchpaths };

  // add any pak files in the format pak0.pak pak1.pak, ...
  for (let i = 0; ; i++) {
    // Port deviation (Linux target): the C relies on a case-insensitive filesystem
    const pakfile = Sys_ResolveCase(`${dir}/pak${i}.pak`);
    const pak = COM_LoadPackFile(pakfile);
    if (!pak) break;
    com_searchpaths = { kind: "pack", pack: pak, next: com_searchpaths };
  }

  // Re-release addition (U10): mount every .kpf/.pk3 sitting directly inside
  // this gamedir, after the paks -- higher search priority than this
  // gamedir's own paks (a mod's zip content overrides its own paks, the same
  // relative order QuakeEX.kpf's own per-root mount uses -- see
  // COM_MountRereleaseRoot below, which mounts QuakeEX.kpf BEFORE calling
  // this function for id1 so it ends up lower priority than id1's paks
  // instead).
  for (const zipfile of listZipFilesInDir(dir)) {
    const zip = COM_LoadZipFile(zipfile);
    if (zip) com_searchpaths = { kind: "zip", zip, next: com_searchpaths };
  }

  // Home directory tier (-homedir addition, U10): mounted LAST so it ends up
  // at the head of the search path -- the highest priority, searched before
  // this gamedir's own tree/paks/zips -- and is also where com_gamedir (and
  // therefore COM_WriteFile, Host_WriteConfiguration's config.cfg, savegames,
  // screenshots, ...) now points. A no-op under -nohomedir, which leaves
  // com_gamedir pointing at `dir` itself the way WinQuake always did.
  if (com_homedir) {
    const homeDir = `${com_homedir}/${homedirBaseName(dir)}`;
    sysMkdirRecursive(homeDir);
    const resolvedHomeDir = Sys_ResolveCase(homeDir);
    com_gamedir = resolvedHomeDir;

    com_searchpaths = { kind: "dir", filename: resolvedHomeDir, next: com_searchpaths };

    for (let i = 0; ; i++) {
      const pakfile = Sys_ResolveCase(`${resolvedHomeDir}/pak${i}.pak`);
      const pak = COM_LoadPackFile(pakfile);
      if (!pak) break;
      com_searchpaths = { kind: "pack", pack: pak, next: com_searchpaths };
    }
  }

  // add the contents of the parms.txt file to the end of the command line
}

// The directory name the default home tier lives under, in whichever
// user-data root COM_DefaultHomeDir picks.
export const HOMEDIR_APPNAME = "q1rets";

/*
================
COM_DefaultHomeDir (re-release addition, F3)

The writable root used when neither -homedir nor -nohomedir is given: the
same QoL rule QuakeSpasm and Ironwail follow on Linux, so a retail install
(often read-only, and never the right place for one user's saves) is left
untouched and config.cfg/savegames/demos/screenshots/qconsole.log land under
the user's own data directory instead. $XDG_DATA_HOME when the environment
sets it, else $HOME/.local/share, per the XDG base directory spec's own
default. Returns "" when neither variable is set -- there is no sensible
per-user location then, so the engine falls back to writing into the
basedir exactly as -nohomedir does.
================
*/
/**
 * The home tier for this boot: `-homedir <dir>`, or nothing under
 * `-nohomedir`, or COM_DefaultHomeDir(). Shared with the QuakeWorld track's
 * own COM_InitFilesystem so a `-dedicated -qw` boot honours the parameter the
 * same way (it used to ignore it and write into <basedir>/qw).
 */
export function COM_ResolveHomeDir(): string {
  const i = COM_CheckParm("-homedir");
  if (i && i < com_argc - 1) return stripTrailingSlash(com_argv[i + 1]!);
  if (COM_CheckParm("-nohomedir")) return "";
  return COM_DefaultHomeDir();
}

export function COM_DefaultHomeDir(): string {
  // Q1TS_NOHOMEDIR=1 is the test harness's -nohomedir: `bun test` and the
  // e2e runner export it so a boot with no explicit -homedir/-nohomedir never
  // reads or writes the real per-user directory (one archived config.cfg
  // there would leak into every later test that boots the same gamedir name).
  const noHome = process.env["Q1TS_NOHOMEDIR"];
  if (noHome !== undefined && noHome !== "" && noHome !== "0") return "";
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.length > 0) return `${stripTrailingSlash(xdg)}/${HOMEDIR_APPNAME}`;
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0) return `${stripTrailingSlash(home)}/.local/share/${HOMEDIR_APPNAME}`;
  return "";
}

function stripTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && (path[end - 1] === "/" || path[end - 1] === "\\")) end--;
  return path.slice(0, end);
}

// The last path component of a mounted gamedir ("id1", "hipnotic", a mod
// name, ...) -- what a homedir mount recreates the write tree under.
/**
 * The one config.cfg a player's settings live in when a per-user directory is
 * in use: `<homedir>/config.cfg`, shared by every game directory. WinQuake
 * kept one config per game directory, which was fine when a mod was a thing
 * you launched once; the re-release's New Game / Multiplayer screens switch
 * game directories every session, and a per-directory config meant the keys
 * bound while playing CTF were gone in id1 and back again in CTF (2026-09-08,
 * Mike: "I had to rebind my keys again"). The QuakeWorld client keeps its own
 * config and is not part of this. Empty when no home directory is in use
 * (-nohomedir): the classic per-gamedir file then.
 */
export function COM_UserConfigPath(): string {
  return com_homedir ? `${com_homedir}/config.cfg` : "";
}

/**
 * Where `exec config.cfg` reads from under a home directory: the shared file
 * when it exists; otherwise the most recently written of the per-game-directory
 * configs an earlier build left (so the bindings the player saved last are the
 * ones carried into the shared file), or "" to fall through to the search path
 * (a mod's own config.cfg, then default.cfg) for a first run.
 */
export function COM_UserConfigReadPath(): string {
  const shared = COM_UserConfigPath();
  if (shared === "") return "";
  if (existsSync(shared)) return shared;
  let newest = "";
  let newestTime = -1;
  let entries: string[];
  try {
    entries = readdirSync(com_homedir);
  } catch {
    return "";
  }
  for (const entry of entries) {
    const candidate = `${com_homedir}/${entry}/config.cfg`;
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      if (st.mtimeMs > newestTime) {
        newestTime = st.mtimeMs;
        newest = candidate;
      }
    } catch {
      // not a game directory with a config
    }
  }
  return newest;
}

function homedirBaseName(dir: string): string {
  const idx = dir.lastIndexOf("/");
  return idx === -1 ? dir : dir.slice(idx + 1);
}

function sysMkdirRecursive(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Sys_mkdir in the C also ignores mkdir() failures (e.g. EEXIST)
  }
}

//=================
//
// COM_IsRereleaseRootDir / COM_MountRereleaseRoot (re-release addition, U10)
//
// A base directory is a re-release root when it holds QuakeEX.kpf, or an
// id1/pak0.pak whose directory contains mapdb.json (checked via
// peekPackFileNames -- the pak's directory only, never its 200+ MB of file
// contents). COM_MountRereleaseRoot mounts QuakeEX.kpf (when present) as the
// LOWEST-priority node of the pair, added before id1 itself so id1's own
// paks -- and any of id1's own .kpf/.pk3 mounts -- end up with higher
// priority: retail data wins over kpf duplicates (fonts/pics/etc that also
// ship loose or in a pak).
//=================

function COM_IsRereleaseRootDir(root: string): boolean {
  const kpfPath = Sys_ResolveCase(`${root}/QuakeEX.kpf`);
  if (existsSync(kpfPath)) return true;

  const pakPath = Sys_ResolveCase(`${root}/${GAMENAME}/pak0.pak`);
  const names = peekPackFileNames(pakPath);
  return names !== null && names.some((n) => n.toLowerCase() === "mapdb.json");
}

function COM_MountRereleaseRoot(root: string): void {
  const kpfPath = Sys_ResolveCase(`${root}/QuakeEX.kpf`);
  if (existsSync(kpfPath)) {
    const zip = COM_LoadZipFile(kpfPath);
    if (zip) com_searchpaths = { kind: "zip", zip, next: com_searchpaths };
  }
  COM_AddGameDirectory(`${root}/${GAMENAME}`);
}

// COM_IsRereleaseRoot()/COM_RereleaseDir()/COM_ClassicDir() (re-release
// addition, U10): for the menu unit's future New Game / mapdb.json scan,
// same purpose as quake-2-re-ts's DataTreeId roots.
export function COM_IsRereleaseRoot(): boolean {
  return com_rerelease_root.length > 0;
}
export function COM_RereleaseDir(): string {
  return com_rerelease_root;
}
export function COM_ClassicDir(): string {
  return com_classic_root;
}

// Where mission-pack-style episode directories (-hipnotic/-rogue/-mg1/-mg3/
// -dopa/-ctf, and the "game" command's own equivalents) are resolved
// against: the re-release root when one is mounted (so -hipnotic/-rogue
// under a re-release root use the re-release copies, per the unit brief),
// else the plain content root.
function episodeRoot(): string {
  return com_rerelease_root || com_basedir;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Where a GENERIC (non-mission-pack) gamedir name -- -game <dir>, and any
// plain name the "game" command is given -- resolves against: the
// re-release root first, when one is mounted AND it actually holds a
// directory of that name on disk (e.g. "-game mg1" on a classic root with a
// nested rerelease/ subdirectory should reach rerelease/mg1, not fail
// looking for a nonexistent classic-root/mg1); otherwise the plain content
// root, exactly as before this unit.
function resolveGameDir(name: string): string {
  if (com_rerelease_root) {
    const candidate = Sys_ResolveCase(`${com_rerelease_root}/${name}`);
    if (directoryExists(candidate)) return candidate;
  }
  return `${com_plain_basedir}/${name}`;
}

const MISSION_PACK_DIRS: ReadonlySet<string> = new Set(["hipnotic", "rogue", "mg1", "mg3", "dopa", "ctf"]);

function setMissionPackFlag(name: string, value: boolean): void {
  switch (name) {
    case "hipnotic":
      hipnotic = value;
      break;
    case "rogue":
      rogue = value;
      break;
    case "mg1":
      mg1 = value;
      break;
    case "mg3":
      mg3 = value;
      break;
    case "dopa":
      dopa = value;
      break;
    case "ctf":
      ctf = value;
      break;
    default:
      break;
  }
}

//================
//
// COM_GetGameNames / COM_ResetGameDirectories / COM_SwitchGame
// (re-release addition, U10: the runtime "game" command's underlying
// machinery, mirroring Ironwail's COM_GetGameNames/COM_ResetGameDirectories/
// COM_SwitchGame, common.c:2565/2670).
//
//================

export function COM_GetGameNames(): string {
  return com_gamenames.length > 0 ? com_gamenames.join(";") : GAMENAME;
}

/**
 * Whether `newgamedirs` names exactly the gamedir layer that is mounted now,
 * after the same normalisation COM_ResetGameDirectories applies (id1 is the
 * base and never counts, repeats are dropped, names compare case-blind).
 * Host_Game_f uses it the way Ironwail's COM_Game_f does: a `game` for the
 * layer already active is a no-op, NOT a teardown and quake.rc re-exec --
 * that re-exec runs default.cfg (unbindall, every default) and then the
 * config.cfg of the last clean shutdown, which threw away every bind, option
 * and console setting made since boot each time the menus started a new game
 * in the same content.
 */
export function COM_GameNamesEqual(newgamedirs: readonly string[]): boolean {
  const wanted: string[] = [];
  for (const raw of newgamedirs) {
    if (Q_strcasecmp(raw, GAMENAME) === 0) continue;
    if (wanted.some((g) => Q_strcasecmp(g, raw) === 0)) continue;
    wanted.push(raw);
  }
  if (wanted.length !== com_gamenames.length) return false;
  for (let i = 0; i < wanted.length; i++) if (Q_strcasecmp(wanted[i]!, com_gamenames[i]!) !== 0) return false;
  return true;
}

// Tears down every search-path entry mounted above the base tier
// (com_base_searchpaths) and mounts `newgamedirs` fresh -- src/common/
// host_cmd.ts's "game" command (Host_Game_f) is the only caller today.
export function COM_ResetGameDirectories(newgamedirs: readonly string[]): void {
  com_searchpaths = com_base_searchpaths;
  if (com_base_gamedir !== "") com_gamedir = com_base_gamedir;
  for (const name of MISSION_PACK_DIRS) setMissionPackFlag(name, false);
  standard_quake = true;
  com_gamenames = [];

  for (const raw of newgamedirs) {
    if (Q_strcasecmp(raw, GAMENAME) === 0) continue; // id1 is already the base
    if (com_gamenames.some((g) => Q_strcasecmp(g, raw) === 0)) continue; // already loaded

    com_gamenames.push(raw);
    const lower = raw.toLowerCase();
    if (MISSION_PACK_DIRS.has(lower)) {
      setMissionPackFlag(lower, true);
      standard_quake = false;
      COM_AddGameDirectory(`${episodeRoot()}/${raw}`);
    } else {
      COM_AddGameDirectory(resolveGameDir(raw));
    }
  }
}

export function COM_SwitchGame(newgamedirs: readonly string[]): void {
  com_modified = true;
  COM_ResetGameDirectories(newgamedirs);
}

//================
//
// COM_InitFilesystem
//
//================

export function COM_InitFilesystem(): void {
  // -basedir <path>
  // Overrides the system supplied base directory (under GAMENAME)
  let i = COM_CheckParm("-basedir");
  let basedir = i && i < com_argc - 1 ? com_argv[i + 1] : host_parms.basedir;

  if (basedir.length > 0) {
    const last = basedir[basedir.length - 1];
    if (last === "\\" || last === "/") basedir = basedir.slice(0, -1);
  }

  // -cachedir <path>
  // Overrides the system supplied cache directory (NULL or /qcache)
  // -cachedir - will disable caching.
  i = COM_CheckParm("-cachedir");
  if (i && i < com_argc - 1) {
    com_cachedir = com_argv[i + 1][0] === "-" ? "" : com_argv[i + 1];
  } else if (host_parms.cachedir) {
    com_cachedir = host_parms.cachedir;
  } else {
    com_cachedir = "";
  }

  // -homedir <path> / -nohomedir (re-release addition, U10; default changed
  // in F3): see com_homedir's own comment, COM_DefaultHomeDir, and
  // COM_AddGameDirectory's home-directory-tier mount.
  com_homedir = COM_ResolveHomeDir();

  // -classic <dir> / -rerelease <dir> (re-release addition, U10): override
  // COM_IsRereleaseRootDir's auto-detection instead of deriving both roots
  // from -basedir/host_parms.basedir.
  i = COM_CheckParm("-classic");
  let classicRoot: string | null = i && i < com_argc - 1 ? com_argv[i + 1] : null;
  i = COM_CheckParm("-rerelease");
  let rereleaseRoot: string | null = i && i < com_argc - 1 ? com_argv[i + 1] : null;

  // -norerelease (re-release addition): mount the classic tree alone even when
  // a rerelease/ subdirectory exists -- the sweep's classic rows and anyone
  // who wants the 1999 content untouched by the re-release overlay.
  const noRerelease = COM_CheckParm("-norerelease") !== 0;

  if (classicRoot === null && rereleaseRoot === null) {
    // Auto-detect from basedir: either basedir itself is a re-release root
    // (e.g. -basedir pointing directly at a "rerelease" install), or it's a
    // classic root that may or may not have a nested "rerelease"
    // subdirectory (the retail Steam/GOG/EGS layout -- Ironwail common.c:3209).
    if (COM_IsRereleaseRootDir(basedir)) {
      rereleaseRoot = basedir;
    } else {
      classicRoot = basedir;
      const nested = `${basedir}/rerelease`;
      if (!noRerelease && COM_IsRereleaseRootDir(nested)) rereleaseRoot = nested;
    }
  } else if (classicRoot !== null && rereleaseRoot === null) {
    // Only -classic given: still auto-detect a nested rerelease/ under it.
    const nested = `${classicRoot}/rerelease`;
    if (!noRerelease && COM_IsRereleaseRootDir(nested)) rereleaseRoot = nested;
  }
  // Only -rerelease given (with or without -classic): trust it as-is, no
  // further auto-detection.

  if (classicRoot !== null) COM_AddGameDirectory(`${classicRoot}/${GAMENAME}`); // classic id1, mounted first (lowest priority so far)
  if (rereleaseRoot !== null) COM_MountRereleaseRoot(rereleaseRoot); // QuakeEX.kpf (if present) + id1, above the classic tier

  if (classicRoot === null && rereleaseRoot === null) {
    // Unreachable given the auto-detect branch above always sets one of the
    // two; kept so a future refactor can't silently leave id1 unmounted.
    COM_AddGameDirectory(`${basedir}/${GAMENAME}`);
  }

  com_classic_root = classicRoot ?? "";
  com_rerelease_root = rereleaseRoot ?? "";
  com_basedir = rereleaseRoot ?? classicRoot ?? basedir;
  com_plain_basedir = classicRoot ?? basedir;

  // Everything mounted so far is the BASE tier: COM_ResetGameDirectories/the
  // runtime "game" command tear down and rebuild everything ABOVE this,
  // never this itself (Ironwail common.c:3209's com_base_searchpaths).
  com_base_searchpaths = com_searchpaths;
  com_base_gamedir = com_gamedir;
  com_gamenames = [];

  // add mission pack requests (only one should normally be specified) --
  // under a re-release root these resolve against episodeRoot() so
  // -hipnotic/-rogue there use the re-release copies, per the unit brief.
  if (COM_CheckParm("-rogue")) {
    com_gamenames.push("rogue");
    COM_AddGameDirectory(`${episodeRoot()}/rogue`);
  }
  if (COM_CheckParm("-hipnotic")) {
    com_gamenames.push("hipnotic");
    COM_AddGameDirectory(`${episodeRoot()}/hipnotic`);
  }
  if (COM_CheckParm("-mg1")) {
    com_gamenames.push("mg1");
    COM_AddGameDirectory(`${episodeRoot()}/mg1`);
  }
  if (COM_CheckParm("-mg3")) {
    com_gamenames.push("mg3");
    COM_AddGameDirectory(`${episodeRoot()}/mg3`);
  }
  if (COM_CheckParm("-dopa")) {
    com_gamenames.push("dopa");
    COM_AddGameDirectory(`${episodeRoot()}/dopa`);
  }
  if (COM_CheckParm("-ctf")) {
    com_gamenames.push("ctf");
    COM_AddGameDirectory(`${episodeRoot()}/ctf`);
  }

  // -game <gamedir>
  // Adds basedir/gamedir as an override game -- resolveGameDir() prefers the
  // re-release root when one is mounted and it actually has that directory
  // (e.g. "-game mg1" on a classic root with a nested rerelease/).
  i = COM_CheckParm("-game");
  if (i && i < com_argc - 1) {
    com_modified = true;
    const gamedirName = com_argv[i + 1];
    com_gamenames.push(gamedirName);
    COM_AddGameDirectory(resolveGameDir(gamedirName));
  }

  // -path <dir or packfile> [<dir or packfile>] ...
  // Fully specifies the exact search path, overriding the generated one
  i = COM_CheckParm("-path");
  if (i) {
    com_modified = true;
    com_searchpaths = null;
    let j = i;
    while (++j < com_argc) {
      const arg = com_argv[j];
      if (!arg || arg[0] === "+" || arg[0] === "-") break;

      if (COM_FileExtension(arg) === "pak") {
        const pack = COM_LoadPackFile(arg);
        if (!pack) Sys_Error("Couldn't load packfile: %s", arg);
        com_searchpaths = { kind: "pack", pack, next: com_searchpaths };
      } else {
        com_searchpaths = { kind: "dir", filename: arg, next: com_searchpaths };
      }
    }
    // -path fully replaces the generated search path, base tier included --
    // there is no more "mission pack layer" left to distinguish it from.
    com_base_searchpaths = com_searchpaths;
  com_base_gamedir = com_gamedir;
  }

  if (COM_CheckParm("-proghack")) proghack = true;
}

//================
//
// COM_CheckRegistered
//
// Looks for the pop.txt file and verifies it.
// Sets the "registered" cvar.
// Immediately exits out if an alternate game was attempted to be started
// without being registered.
//================

export function COM_CheckRegistered(): void {
  const { handle: h } = COM_OpenFile("gfx/pop.lmp");
  static_registered = 0;

  if (h === -1) {
    Con_Printf("Playing shareware version.\n");
    if (com_modified) Sys_Error("You must have the registered version to use modified games");
    return;
  }

  const check = new Uint8Array(256); // unsigned short check[128]
  Sys_FileRead(h, check, 256);
  COM_CloseFile(h);

  const checkView = new DataView(check.buffer);
  for (let i = 0; i < 128; i++) {
    const raw = checkView.getUint16(i * 2, true); // native (LE) combine of the two file bytes
    if (pop[i] !== (BigShort(raw) & 0xffff)) Sys_Error("Corrupted data file.");
  }

  const { Cvar_Set } = cvarMod();
  Cvar_Set("cmdline", com_cmdline);
  Cvar_Set("registered", "1");
  static_registered = 1;
  Con_Printf("Playing registered version.\n");
}
