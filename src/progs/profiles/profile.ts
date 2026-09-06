/*
Copyright (C) 1996-1997 Id Software, Inc.
Derived from WinQuake/pr_edict.c, WinQuake/pr_exec.c, QW/server/pr_edict.c and
QW/server/pr_exec.c (GNU GPL v2 or later).

The host profile: everything the two C progs hosts do differently, in one
declaration. ARCHITECTURE.md's "Core model" commits the engine to **one
QuakeC VM with a host profile** -- `nq` (WinQuake's numbered builtin table,
PROGHEADER_CRC 5927) or `qw` (QuakeWorld's table, 54730) -- so that every
extension is written once. The VM core (progs_core.ts, pr_edict_core.ts,
pr_exec_core.ts) reads the active profile through `PR_ActiveProfile`; each
host's own modules (src/progs/pr_edict.ts, src/qw/server/pr_edict.ts and
their siblings) select theirs before delegating, and the two entry points
(src/server/sv_main.ts's SV_SpawnServer, src/qw/server/sv_init.ts's
SV_SpawnServer) call `PR_SetProfile` before `PR_LoadProgs` so the choice is
explicit in the boot path rather than implied by an import.

A profile owns its own `ProgsStateT`, so the WinQuake VM and the QuakeWorld
VM stay as separate at runtime as the C's `quake` and `qwsv` binaries were
(each C binary compiled its own copy of every pr_*.c file-scope global).

Extension points:
- `namedBuiltins` binds `= #0:name` builtins after load, the way Ironwail's
  PR_InitBuiltins (Quake/pr_edict.c:1858-1900) remaps functions whose
  first_statement, parm_start and locals are all zero. The NetQuake profile
  fills it from src/progs/ext/qex.ts with the 2021 re-release's `ex_*` set;
  the QuakeWorld profile's is empty. An unbound name still fails loudly.
- `extensions` is the set `checkextension` (builtin 99) answers 1 for. The
  NetQuake profile answers the re-release's four names under the `rerelease`
  behaviour profile and nothing under `classic`.
*/

import { SysError } from "../../platform/sys";
import type { BuiltinT, EdictBaseT, ProgsStateT } from "../progs_core";
import type { ProgsGlobalVarsT, ProgsLayoutT } from "../progdefs_layout";

export interface ProgsProfileT {
  // "nq" or "qw"; appears in diagnostics only
  readonly name: string;

  // this host's VM state (progs.h's pr_* externs and the per-host runtime
  // state that went with them)
  readonly state: ProgsStateT;

  //--------------------------------------------------------------------------
  // progdefs: the qcc-generated system-defs layout this host's progs.dat must
  // have been compiled against

  // the progs.dat header CRCs this host accepts. An unknown CRC is an error;
  // a future compat progs with a wider progdefs is added here with its own
  // layout, never by relaxing the check (ARCHITECTURE.md).
  readonly systemCrcs: ReadonlySet<number>;
  readonly globalsLayout: ProgsLayoutT; // globalvars_t
  readonly entvarsLayout: ProgsLayoutT; // entvars_t
  makeGlobalVars(f: Float32Array, i: Int32Array): ProgsGlobalVarsT;
  makeEdict(index: number, entityfields: number): EdictBaseT;

  //--------------------------------------------------------------------------
  // loading

  // the names PR_LoadProgs tries, in order (WinQuake: progs.dat; QuakeWorld:
  // qwprogs.dat then progs.dat)
  readonly progsFiles: readonly string[];
  // COM_LoadHunkFile: a different function in the two trees, since WinQuake's
  // filesystem and QuakeWorld's are separate ports
  loadProgsFile(name: string): Uint8Array | null;
  // the message the C prints when progs->crc is not in systemCrcs
  readonly crcErrorMessage: string;
  // WinQuake accumulates pr_crc byte by byte and keeps it; QuakeWorld computes
  // a whole-file CRC_Block and puts it in serverinfo under "*progs". Returns
  // the value stored in state.crc.
  loadChecksum(data: Uint8Array, size: number): number;
  // functions resolved by name after load and left at 0 when absent
  // (QuakeWorld's SpectatorConnect/SpectatorThink/SpectatorDisconnect)
  readonly optionalFunctions: readonly string[];

  //--------------------------------------------------------------------------
  // builtins

  // the numbered `pr_builtin[]` table, as this host's pr_cmds.ts declares it
  numberedBuiltins(): readonly BuiltinT[];
  // `= #0:name` bindings, applied after load
  readonly namedBuiltins: ReadonlyMap<string, BuiltinT>;
  // what `checkextension` (builtin 99) answers 1 for
  readonly extensions: ReadonlySet<string>;

  //--------------------------------------------------------------------------
  // host bindings: the server state and helpers the VM reaches for, which are
  // different modules in the two trees

  readonly maxEdicts: number; // quakedef.h's MAX_EDICTS / QW's bothdefs.h one
  edictAllocStart(): number; // ED_Alloc's scan start: svs.maxclients+1 / MAX_CLIENTS+1
  allocEdicts(max: number, entityfields: number): EdictBaseT[];
  numEdicts(): number; // sv.num_edicts
  setNumEdicts(value: number): void;
  serverTime(): number; // sv.time
  serverActive(): boolean; // sv.state == ss_active, for OP_ADDRESS
  unlinkEdict(ed: EdictBaseT): void; // SV_UnlinkEdict
  // ED_Alloc with no free edict left: WinQuake Sys_Errors, QuakeWorld warns
  // and steps back onto the last edict. Returns the index to reuse.
  allocOverflow(index: number): number;
  // ED_LoadFromFile's "remove things from different skill levels or
  // deathmatch" filter
  inhibitEntity(ent: EdictBaseT): boolean;
  // ED_LoadFromFile after each spawn function: QuakeWorld's SV_FlushSignon
  afterSpawnEntity(): void;
  // PR_Init's cvar registrations (WinQuake has eleven; QuakeWorld has none)
  registerCvars(): void;
  // server.h's MOVETYPE_STEP, read by ED_Count
  readonly movetypeStep: number;

  //--------------------------------------------------------------------------
  // diagnostics whose exact wording differs between the two trees

  // ED_ParseEdict's "another hack to fix heynames with trailing spaces":
  // WinQuake trims them, QuakeWorld does not
  parseKeyname(token: string): string;
  // WinQuake quotes the key in "'%s' is not a global/field"; QuakeWorld does
  // not
  readonly unknownKeyQuote: string;
  // ED_Print's own "\nEDICT %i:\n" header (WinQuake only)
  printEdictHeader(index: number): void;
  // ED_PrintEdicts' per-entry "\nEDICT %i:\n" header (QuakeWorld only)
  printEdictListHeader(index: number): void;
  // ED_PrintEdict_f's preamble: WinQuake's "Bad edict number" range guard
  // (returning false to stop), QuakeWorld's "\n EDICT %i:\n" header
  beginEdictCommand(index: number): boolean;

  //--------------------------------------------------------------------------
  // error paths

  // the C's Sys_Error (WinQuake) / SV_Error (QuakeWorld)
  sysError(error: string, ...args: Array<string | number>): never;
  // the C's Host_Error (WinQuake) / SV_Error (QuakeWorld)
  hostError(error: string, ...args: Array<string | number>): never;
  // what PR_RunError throws once it has printed the statement and stack
  runError(message: string): never;
}

let activeProfile: ProgsProfileT | null = null;

export function PR_SetProfile(profile: ProgsProfileT): void {
  activeProfile = profile;
}

export function PR_ActiveProfile(): ProgsProfileT {
  if (activeProfile === null) throw new SysError("PR_ActiveProfile: no progs host profile selected");
  return activeProfile;
}

export function PR_ProfileSelected(): boolean {
  return activeProfile !== null;
}

export function PR_ActiveState(): ProgsStateT {
  return PR_ActiveProfile().state;
}
