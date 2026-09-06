/*
Copyright (C) 1996-1997 Id Software, Inc.
Derived from QW/server/pr_edict.c and QW/server/pr_exec.c (GNU GPL v2 or later).

The QuakeWorld host profile: every place QW/server/pr_edict.c and
QW/server/pr_exec.c differ from WinQuake's (171 and 61 changed lines by
`diff -w`), bound to the qwsv server (src/qw/server), QuakeWorld's own
filesystem (src/qw/common.ts) and QuakeWorld's protocol limits
(src/qw/bothdefs.ts, src/qw/protocol.ts). The VM itself is progs_core.ts /
pr_edict_core.ts / pr_exec_core.ts.

Real QW deltas this profile carries (verified against the C, not guessed):
- `PR_LoadProgs` tries `qwprogs.dat` first, then falls back to `progs.dat`
  (WinQuake only ever loads `progs.dat`). It computes a whole-file CRC with
  `CRC_Block` (src/common/crc.ts, a QW/client/crc.c addition) and stores it
  into the server's serverinfo string (`svs.info`) under the `*progs` key via
  `Info_SetValueForStarKey` -- a real, different mechanism from WinQuake's
  persistent `pr_crc` global (computed byte-by-byte with `CRC_Init`/
  `CRC_ProcessByte` and kept around for later reads). QW's C in fact keeps NO
  persistent `pr_crc` variable at all (checked: the top-of-file
  `unsigned short pr_crc;` declaration WinQuake has is simply gone, and
  nothing else assigns one); the VM state still carries a `crc` field, so this
  port fills it with the same `CRC_Block` result rather than leave a dead
  field or duplicate the computation. `progs->crc != PROGHEADER_CRC` (the qcc
  system-vars checksum baked into the progs.dat header itself, unrelated to
  the whole-file `CRC_Block` above) fails with QW's own message, not
  WinQuake's.
- `ED_Alloc` scans from `MAX_CLIENTS+1` (a compile-time constant, protocol.h)
  rather than `svs.maxclients+1` -- confirmed against both C sources;
  `server_static_t` doesn't even have a `maxclients` field in QW (it's a cvar
  in sv_main.c). The "no free edicts" path is completely rewritten: WinQuake
  `Sys_Error`s; QW instead prints a warning, steps back onto the last edict
  (`i--`), force-unlinks it, and reuses it, only incrementing `sv.num_edicts`
  on the normal (room-left) path. `MAX_EDICTS` is QW's own bothdefs.h value
  (768), not WinQuake's quakedef.h one (600).
- `ED_LoadFromFile` drops WinQuake's `deathmatch`/skill-level filtering
  entirely (checked side by side: the `if (deathmatch.value) {...} else if
  (current_skill...) {...}` block is gone, not narrowed) and keeps only the
  unconditional `SPAWNFLAG_NOT_DEATHMATCH` check. It also calls
  `SV_FlushSignon()` (sv_send.c) after every `PR_ExecuteProgram`, reached here
  through a registrable hook (`setSvFlushSignonHook`, re-exported by
  src/qw/server/pr_edict.ts, which src/qw/main_sv.ts calls at boot) rather
  than a module-scope import that would close a load-time cycle.
- `PR_Init` registers none of WinQuake's eleven scratch/saved cvars (checked --
  the whole block is gone, not trimmed).
- `SV_Error`, not `Sys_Error`/`Host_Error`, is what every abort calls
  (`ED_ParseGlobals`/`ED_ParseEdict`'s three "EOF"/"closing brace"/"parse
  error" throws each, `ED_LoadFromFile`'s "found %s when expecting {",
  `PR_LoadProgs`'s four checks, `PR_LeaveFunction`'s stack underflow, and
  `PR_ExecuteProgram`'s NULL function).
- Two `Con_Printf` messages drop WinQuake's single quotes around the key name:
  `"%s is not a global\n"` / `"%s is not a field\n"`.
- `ED_ParseEdict` has no "another hack to fix heynames with trailing spaces"
  loop.
- `ED_Print` no longer prints its own `"\nEDICT %i:\n"` header line (WinQuake
  does, at the top of the function); QW moves that responsibility to its two
  callers instead: `ED_PrintEdicts` prints `"\nEDICT %i:\n"` before each
  `ED_PrintNum` in its loop, and `ED_PrintEdict_f` prints `"\n EDICT %i:\n"`
  (one leading space, no blank-line-first) before its single call -- verified
  as genuinely different wording, not a copy-paste of the same string.
  `ED_PrintEdict_f` also drops WinQuake's own `i >= sv.num_edicts` "Bad edict
  number" guard entirely; an out-of-range index now reaches `EDICT_NUM`
  itself, which throws.
- "Zoid, find the spectator functions": `SpectatorConnect`/`SpectatorThink`/
  `SpectatorDisconnect` are resolved at load and left at 0 when absent.

Deviations from the C source:
- `SV_Error`, `PRRunError`, `pr_builtin` and `SV_UnlinkEdict` are reached
  through lazy `require`s: src/qw/server/sv_main.ts, pr_exec.ts, pr_cmds.ts
  and world.ts all lead back to this module, and PORTING.md's cycle rule
  resolves such a pair at the less fundamental side. Nothing in this module's
  body touches them.
- `MAX_EDICTS` and `MOVETYPE_STEP` are getters rather than plain fields for
  the same reason.
- `pr_edict_size = progs->entityfields * 4 + sizeof(edict_t) - sizeof(entvars_t)`
  (QW) vs WinQuake's plain `progs->entityfields * 4`: both are C-only byte
  offsets for pointer arithmetic this port does not do (see pr_exec_core.ts's
  pointer-encoding ruling) -- only the stride's self-consistency matters, so
  the shared core stores `header.entityfields` (a word count) for both hosts.
*/

import { CRC_Block } from "../../common/crc";
import { Con_Printf } from "../../client/console";
import { Com_sprintf } from "../../common/sprintf";
import { COM_LoadHunkFile, Info_SetValueForStarKey, MAX_SERVERINFO_STRING } from "../../qw/common";
import { MAX_EDICTS } from "../../qw/bothdefs";
import { MAX_CLIENTS } from "../../qw/protocol";
import { MOVETYPE_STEP, SPAWNFLAG_NOT_DEATHMATCH, ServerStateT, sv, svs } from "../../qw/server/server";
import { EDICT_NUM, QwEdictT, qwpr } from "../../qw/server/progs";
import { QW_ENTVARS_LAYOUT, QW_GLOBALS_LAYOUT, QwGlobalVars, PROGHEADER_CRC } from "../../qw/server/progdefs";
import { SysError } from "../../platform/sys";
import type { BuiltinT, EdictBaseT } from "../progs_core";
import type { ProgsProfileT } from "./profile";
import type * as PrCmdsModule from "../../qw/server/pr_cmds";
import type * as PrExecModule from "../../qw/server/pr_exec";
import type * as SvMainModule from "../../qw/server/sv_main";
import type * as WorldModule from "../../qw/server/world";

// see the file header's lazy-require note
function prCmdsMod(): typeof PrCmdsModule {
  return require("../../qw/server/pr_cmds");
}

function prExecMod(): typeof PrExecModule {
  return require("../../qw/server/pr_exec");
}

function svMainMod(): typeof SvMainModule {
  return require("../../qw/server/sv_main");
}

function worldMod(): typeof WorldModule {
  return require("../../qw/server/world");
}

// SV_FlushSignon (sv_send.c); src/qw/main_sv.ts registers the real one at boot
export type SvFlushSignonHook = () => void;
let svFlushSignonHook: SvFlushSignonHook = () => {};
export function setSvFlushSignonHook(fn: SvFlushSignonHook): void {
  svFlushSignonHook = fn;
}

function requireQwEdictT(ed: EdictBaseT): QwEdictT {
  if (!(ed instanceof QwEdictT)) throw new SysError("qw progs profile: edict is not a QwEdictT");
  return ed;
}

export const qwProfile: ProgsProfileT = {
  name: "qw",
  state: qwpr,

  systemCrcs: new Set([PROGHEADER_CRC]),
  globalsLayout: QW_GLOBALS_LAYOUT,
  entvarsLayout: QW_ENTVARS_LAYOUT,
  makeGlobalVars(f: Float32Array, i: Int32Array) {
    return new QwGlobalVars(f, i);
  },
  makeEdict(index: number, entityfields: number) {
    return new QwEdictT(index, entityfields);
  },

  progsFiles: ["qwprogs.dat", "progs.dat"],
  loadProgsFile(name: string) {
    return COM_LoadHunkFile(name);
  },
  crcErrorMessage: "You must have the progs.dat from QuakeWorld installed",
  loadChecksum(data: Uint8Array, size: number) {
    // add prog crc to the serverinfo
    const crc = CRC_Block(data, size);
    svs.info = Info_SetValueForStarKey(svs.info, "*progs", Com_sprintf("%i", crc), MAX_SERVERINFO_STRING);
    return crc;
  },
  optionalFunctions: ["SpectatorConnect", "SpectatorThink", "SpectatorDisconnect"],

  numberedBuiltins(): readonly BuiltinT[] {
    return prCmdsMod().pr_builtin;
  },
  namedBuiltins: new Map<string, BuiltinT>(),
  extensions: new Set<string>(),

  get maxEdicts(): number {
    return MAX_EDICTS;
  },
  edictAllocStart() {
    return MAX_CLIENTS + 1;
  },
  allocEdicts(max: number, entityfields: number) {
    const edicts: QwEdictT[] = [];
    for (let i = 0; i < max; i++) edicts.push(new QwEdictT(i, entityfields));
    sv.edicts = edicts;
    return edicts;
  },
  numEdicts() {
    return sv.num_edicts;
  },
  setNumEdicts(value: number) {
    sv.num_edicts = value;
  },
  serverTime() {
    return sv.time;
  },
  serverActive() {
    return sv.state === ServerStateT.ss_active;
  },
  unlinkEdict(ed: EdictBaseT) {
    worldMod().SV_UnlinkEdict(requireQwEdictT(ed));
  },
  allocOverflow(index: number) {
    Con_Printf("WARNING: ED_Alloc: no free edicts\n");
    const i = index - 1; // step on whatever is the last edict
    worldMod().SV_UnlinkEdict(EDICT_NUM(i));
    return i;
  },
  inhibitEntity(ent: EdictBaseT) {
    return ((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_DEATHMATCH) !== 0;
  },
  afterSpawnEntity() {
    svFlushSignonHook(); // SV_FlushSignon ()
  },
  registerCvars() {
    // QW registers no cvars here (see file header)
  },
  get movetypeStep(): number {
    return MOVETYPE_STEP;
  },

  parseKeyname(token: string) {
    return token; // QW has no trailing-space trim
  },
  unknownKeyQuote: "",
  printEdictHeader() {
    // QW's ED_Print prints no header; its two callers do
  },
  printEdictListHeader(index: number) {
    Con_Printf("\nEDICT %i:\n", index);
  },
  beginEdictCommand(index: number) {
    Con_Printf("\n EDICT %i:\n", index);
    return true;
  },

  sysError(error: string, ...args: Array<string | number>): never {
    return svMainMod().SV_Error(error, ...args);
  },
  hostError(error: string, ...args: Array<string | number>): never {
    return svMainMod().SV_Error(error, ...args);
  },
  runError(message: string): never {
    throw new (prExecMod().PRRunError)(message); // SV_Error ("Program error")
  },
};
