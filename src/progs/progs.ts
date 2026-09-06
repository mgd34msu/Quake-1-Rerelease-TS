/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/progs.h (GNU GPL v2 or later).

`edict_t`, `link_t`, `eval_t`, `MAX_ENT_LEAFS`, and the `G_*`/`E_*` accessor
macros pr_exec.ts and pr_cmds.ts read progs.dat bytecode through. The
`pr_*` extern globals (`pr_functions`, `pr_strings`, `pr_globaldefs`,
`pr_fielddefs`, `pr_statements`, `pr_global_struct`, `pr_globals`,
`pr_edict_size`, `pr_crc`) are defined in pr_edict.c in the C, so here they
are one mutable holder, `pr`, that pr_edict.ts fills at load time.

The machinery itself is progs_core.ts, shared with QuakeWorld's own progs
host (src/qw/server/progs.ts) -- WinQuake's progs.h and QW's differ only in
the string_t mechanism and the edict type each names. This module is
WinQuake's binding of it: `pr` is the NetQuake profile's VM state, `EdictT`
is WinQuake's edict (the base plus `entity_state_t baseline`), and every
function below is the core's, narrowed to those two.

`ED_Alloc`/`ED_Free`/`ED_NewString`/`ED_Print`/`ED_Write`/`ED_ParseEdict`/
`ED_WriteGlobals`/`ED_ParseGlobals`/`ED_LoadFromFile`/`PR_Init`/
`PR_ExecuteProgram`/`PR_LoadProgs`/`PR_Profile_f`/`PR_RunError`/
`GetEdictFieldValue`/`ED_PrintEdicts`/`ED_PrintNum` are pr_edict.c's and
pr_exec.c's own functions and are not declared here.
`pr_builtins`/`pr_numbuiltins`/`pr_argc`/`pr_trace`/`pr_xfunction`/
`pr_xstatement` are pr_exec.c/pr_cmds.c execution state and are not declared
here either -- progs.h groups them with the rest of this file's externs, but
PORTING.md's module split puts them with the code that owns them.

Deviations from the C source: see progs_core.ts, which documents them all
(`eval_t` not ported, EDICT_TO_PROG/PROG_TO_EDICT storing an edict index, the
engine string table and its positive `ENGINE_STRING_BASE`, `LinkT.owner`).
The one this file adds:
- `EDICT_NUM`/`PROG_TO_EDICT`/`G_EDICT` narrow the core's `EdictBaseT` back to
  `EdictT` with `instanceof`, so WinQuake's server code keeps the exact edict
  type it had. The check can only fail if a QuakeWorld edict table were
  registered on WinQuake's VM state, which no code path does.
*/

import type { Vec3 } from "../common/mathlib";
import { EntityStateT } from "../common/quakedef";
import { SysError } from "../platform/sys";
import type { FuncT, StringT } from "./pr_comp";
import { EntVars } from "./progdefs";
import {
  EdictBaseT,
  ENGINE_STRING_BASE,
  LinkT,
  MAX_ENT_LEAFS,
  ProgsStateT,
  TYPE_SIZE,
} from "./progs_core";
import * as core from "./progs_core";

export { LinkT, MAX_ENT_LEAFS, TYPE_SIZE, ENGINE_STRING_BASE };

export class EdictT extends EdictBaseT {
  baseline: EntityStateT = new EntityStateT();

  constructor(index: number, entityfields: number) {
    super(index, entityfields, (f, i) => new EntVars(f, i));
  }
}

//============================================================================

// The `pr_*` externs of progs.h, all defined by pr_edict.c in the C; here
// one mutable singleton pr_edict.ts fills at PR_LoadProgs time and every
// reader below (and pr_exec.ts/pr_cmds.ts) reads through. It is also the
// NetQuake host profile's VM state (src/progs/profiles/nq.ts).
export const pr = new ProgsStateT();

//============================================================================
// edict table (stands in for `sv.edicts`, per progs_core.ts's
// EDICT_TO_PROG/PROG_TO_EDICT deviation note)

export function setEdictTable(edicts: EdictT[]): void {
  core.setEdictTable(pr, edicts);
}

function requireEdictT(ed: EdictBaseT): EdictT {
  if (!(ed instanceof EdictT)) throw new SysError("progs.ts: edict is not an EdictT");
  return ed;
}

export function EDICT_NUM(n: number): EdictT {
  return requireEdictT(core.EDICT_NUM(pr, n));
}

export function NUM_FOR_EDICT(e: EdictT): number {
  return e.index;
}

export function PROG_TO_EDICT(n: number): EdictT {
  return EDICT_NUM(n);
}

export function EDICT_TO_PROG(e: EdictT): number {
  return e.index;
}

//============================================================================

export function G_FLOAT(o: number): number {
  return core.G_FLOAT(pr, o);
}

export function G_INT(o: number): number {
  return core.G_INT(pr, o);
}

export function G_EDICT(o: number): EdictT {
  return requireEdictT(core.G_EDICT(pr, o));
}

export function G_EDICTNUM(o: number): number {
  return core.G_EDICTNUM(pr, o);
}

export function G_VECTOR(o: number): Vec3 {
  return core.G_VECTOR(pr, o);
}

export function G_STRING(o: number): string {
  return core.G_STRING(pr, o);
}

export function G_FUNCTION(o: number): FuncT {
  return core.G_FUNCTION(pr, o);
}

export function E_FLOAT(ed: EdictT, o: number): number {
  return ed.fields.f[o];
}

export function E_INT(ed: EdictT, o: number): number {
  return ed.fields.i[o];
}

export function E_VECTOR(ed: EdictT, o: number): Vec3 {
  return ed.fields.f.subarray(o, o + 3);
}

export function E_STRING(ed: EdictT, o: number): string {
  return core.E_STRING(pr, ed, o);
}

export function RETURN_EDICT(e: EdictT): void {
  core.RETURN_EDICT(pr, e);
}

//============================================================================
// string_t resolution (see progs_core.ts's string_t deviation note)

export function PR_GetString(n: StringT): string {
  return core.PR_GetString(pr, n);
}

export function PR_SetEngineString(s: string): StringT {
  return core.PR_SetEngineString(pr, s);
}

// `host_client->name - pr_strings` (host_cmd.c:939, host_cmd.c:1311) and
// `pr_string_temp - pr_strings` (pr_cmds.c:934, pr_cmds.c:947) are pointers at
// engine buffers the engine keeps rewriting, so every later write to the buffer
// is what a QuakeC read of that string_t sees. A JS string is a value, so the
// pointer becomes a live getter, keyed on the owning object the way the C keys
// on the buffer's address.
export function PR_SetEngineStringRef(owner: object, get: () => string): StringT {
  return core.PR_SetEngineStringRef(pr, owner, get);
}

export function PR_ClearEngineStrings(): void {
  core.PR_ClearEngineStrings(pr);
}
