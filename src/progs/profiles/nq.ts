/*
Copyright (C) 1996-1997 Id Software, Inc.
Derived from WinQuake/pr_edict.c and WinQuake/pr_exec.c (GNU GPL v2 or later).

The NetQuake host profile: everything WinQuake's progs host does that
QuakeWorld's does differently, bound to WinQuake's own server (src/server),
host (src/common/host.ts, host_cmd.ts) and filesystem (src/common/common.ts).
The VM itself is progs_core.ts / pr_edict_core.ts / pr_exec_core.ts; this file
is the table of differences, plus the eleven cvars WinQuake's `PR_Init`
registers (src/progs/pr_edict.ts re-exports them under their C names, where
the C declared them).

Deviations from the C source:
- `PRRunError`, `pr_builtin` and `SV_UnlinkEdict` are reached through lazy
  `require`s rather than module-scope imports: src/progs/pr_exec.ts,
  src/progs/pr_cmds.ts and src/server/world.ts all lead back to this module,
  and PORTING.md's cycle rule resolves such a pair at the less fundamental
  side. Nothing in this module's body touches them, so the deferral costs one
  property lookup per call at most.
- `MAX_EDICTS` and `MOVETYPE_STEP` are getters rather than plain fields for
  the same reason: they are read from modules this one is imported *by*, and a
  getter defers the read to call time.
*/

import { COM_LoadHunkFile } from "../../common/common";
import { CRC_Init, CRC_ProcessByte } from "../../common/crc";
import { CvarT, Cvar_RegisterVariable } from "../../common/cvar";
import { Con_Printf } from "../../client/console";
import { Sys_Error, SysError } from "../../platform/sys";
import { Com_sprintf } from "../../common/sprintf";

import { deathmatch, Host_MaxEdicts } from "../../common/host";
import { hostCmdState } from "../../common/host_cmd";
import {
  MOVETYPE_STEP,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_MEDIUM,
  ServerStateT,
  sv,
  svs,
} from "../../server/server";
import type { BuiltinT, EdictBaseT } from "../progs_core";
import { EdictT, pr } from "../progs";
import { GlobalVars, NQ_ENTVARS_LAYOUT, NQ_GLOBALS_LAYOUT, PROGHEADER_CRC } from "../progdefs";
import type { ProgsProfileT } from "./profile";
import type * as PrCmdsModule from "../pr_cmds";
import type * as PrExecModule from "../pr_exec";
import type * as WorldModule from "../../server/world";
import type * as QexModule from "../ext/qex";

// see the file header's lazy-require note
function prCmdsMod(): typeof PrCmdsModule {
  return require("../pr_cmds");
}

function prExecMod(): typeof PrExecModule {
  return require("../pr_exec");
}

function worldMod(): typeof WorldModule {
  return require("../../server/world");
}

// src/progs/ext/qex.ts reaches src/server/sv_main.ts (through server.ts and
// the protocol modules), which imports this file to select the profile, so it
// is deferred exactly like the three above.
function qexMod(): typeof QexModule {
  return require("../ext/qex");
}

export const nomonsters = new CvarT("nomonsters", "0");
export const gamecfg = new CvarT("gamecfg", "0");
export const scratch1 = new CvarT("scratch1", "0");
export const scratch2 = new CvarT("scratch2", "0");
export const scratch3 = new CvarT("scratch3", "0");
export const scratch4 = new CvarT("scratch4", "0");
export const savedgamecfg = new CvarT("savedgamecfg", "0", true);
export const saved1 = new CvarT("saved1", "0", true);
export const saved2 = new CvarT("saved2", "0", true);
export const saved3 = new CvarT("saved3", "0", true);
export const saved4 = new CvarT("saved4", "0", true);

function requireEdictT(ed: EdictBaseT): EdictT {
  if (!(ed instanceof EdictT)) throw new SysError("nq progs profile: edict is not an EdictT");
  return ed;
}

export const nqProfile: ProgsProfileT = {
  name: "nq",
  state: pr,

  systemCrcs: new Set([PROGHEADER_CRC]),
  globalsLayout: NQ_GLOBALS_LAYOUT,
  entvarsLayout: NQ_ENTVARS_LAYOUT,
  makeGlobalVars(f: Float32Array, i: Int32Array) {
    return new GlobalVars(f, i);
  },
  makeEdict(index: number, entityfields: number) {
    return new EdictT(index, entityfields);
  },

  progsFiles: ["progs.dat"],
  loadProgsFile(name: string) {
    return COM_LoadHunkFile(name);
  },
  crcErrorMessage: "progs.dat system vars have been modified, progdefs.h is out of date",
  loadChecksum(data: Uint8Array, size: number) {
    let crc = CRC_Init();
    for (let i = 0; i < size; i++) crc = CRC_ProcessByte(crc, data[i]);
    return crc;
  },
  optionalFunctions: [],

  numberedBuiltins(): readonly BuiltinT[] {
    return prCmdsMod().pr_builtin;
  },
  // the re-release's `= #0:ex_*` set and the extension registry it answers
  // from, both from src/progs/ext/qex.ts. `extensions` is a getter because the
  // answer depends on the behaviour profile in force (SV_Ruleset), which is
  // only known once a progs has been loaded.
  get namedBuiltins(): ReadonlyMap<string, BuiltinT> {
    return qexMod().QEX_NamedBuiltins();
  },
  get extensions(): ReadonlySet<string> {
    return qexMod().QEX_Extensions();
  },

  get maxEdicts(): number {
    // U3: quakedef.h's MAX_EDICTS is now only the ceiling on the `max_edicts`
    // cvar; the live cap is the table SV_SpawnServer allocated (Ironwail's
    // `qcvm->max_edicts`). Before a server has allocated one -- a bare
    // PR_LoadProgs in a test, or a savegame load before SV_SpawnServer -- the
    // clamped cvar value is the answer, which is exactly what SV_SpawnServer
    // is about to allocate.
    return sv.max_edicts > 0 ? sv.max_edicts : Host_MaxEdicts();
  },
  edictAllocStart() {
    return svs.maxclients + 1;
  },
  allocEdicts(max: number, entityfields: number) {
    const edicts: EdictT[] = [];
    for (let i = 0; i < max; i++) edicts.push(new EdictT(i, entityfields));
    sv.edicts = edicts;
    sv.max_edicts = max;
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
    worldMod().SV_UnlinkEdict(requireEdictT(ed));
  },
  allocOverflow(): never {
    return Sys_Error("ED_Alloc: no free edicts");
  },
  inhibitEntity(ent: EdictBaseT) {
    const current_skill = hostCmdState.current_skill;
    const spawnflags = ent.v.spawnflags | 0;
    if (deathmatch.value) return (spawnflags & SPAWNFLAG_NOT_DEATHMATCH) !== 0;
    return (
      (current_skill === 0 && (spawnflags & SPAWNFLAG_NOT_EASY) !== 0) ||
      (current_skill === 1 && (spawnflags & SPAWNFLAG_NOT_MEDIUM) !== 0) ||
      (current_skill >= 2 && (spawnflags & SPAWNFLAG_NOT_HARD) !== 0)
    );
  },
  afterSpawnEntity() {
    // WinQuake's ED_LoadFromFile calls nothing here
  },
  registerCvars() {
    Cvar_RegisterVariable(nomonsters);
    Cvar_RegisterVariable(gamecfg);
    Cvar_RegisterVariable(scratch1);
    Cvar_RegisterVariable(scratch2);
    Cvar_RegisterVariable(scratch3);
    Cvar_RegisterVariable(scratch4);
    Cvar_RegisterVariable(savedgamecfg);
    Cvar_RegisterVariable(saved1);
    Cvar_RegisterVariable(saved2);
    Cvar_RegisterVariable(saved3);
    Cvar_RegisterVariable(saved4);
  },
  get movetypeStep(): number {
    return MOVETYPE_STEP;
  },

  // another hack to fix heynames with trailing spaces
  parseKeyname(token: string) {
    let keyname = token;
    let n = keyname.length;
    while (n && keyname[n - 1] === " ") {
      keyname = keyname.slice(0, n - 1);
      n--;
    }
    return keyname;
  },
  unknownKeyQuote: "'",
  printEdictHeader(index: number) {
    Con_Printf("\nEDICT %i:\n", index);
  },
  printEdictListHeader() {
    // WinQuake's ED_PrintEdicts prints no per-entry header; ED_Print does
  },
  beginEdictCommand(index: number) {
    if (index >= sv.num_edicts) {
      Con_Printf("Bad edict number\n");
      return false;
    }
    return true;
  },

  sysError(error: string, ...args: Array<string | number>): never {
    return Sys_Error(error, ...args);
  },
  hostError(error: string, ...args: Array<string | number>): never {
    // Host_Error: pr_exec.ts's PRRunError carries the formatted message, which
    // host.ts catches where it catches a HostError
    throw new (prExecMod().PRRunError)(Com_sprintf(error, ...args));
  },
  runError(message: string): never {
    throw new (prExecMod().PRRunError)(message); // Host_Error ("Program error")
  },
};
