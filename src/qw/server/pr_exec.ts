/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/pr_exec.c (GNU GPL v2 or later), which is WinQuake's
pr_exec.c with a small delta (61 changed lines, `diff -w` against
WinQuake/pr_exec.c): every `pr_strings + ofs` string dereference becomes
`PR_GetString(ofs)`; every `Host_Error`/`Sys_Error` that aborts the running
QuakeC program becomes `SV_Error` (QW server's error path, sv_main.c);
`OP_STATE`'s `#ifdef FPS_20` branch is dropped, same as WinQuake's; and QW adds
`PR_GetString`/`PR_SetString` themselves at the bottom of this file (progs.h
places their prototypes with the rest of the string_t declarations, but they
are actually *defined* here, not in pr_edict.c -- see src/qw/server/progs.ts's
file header, which ports them there since progs.ts is where every other qwsv
module reaches `pr_strtbl`/`num_prstr` through).

Those differences are all host-profile hooks now, so the interpreter itself --
`PR_ExecuteProgram` and its opcode switch, the `pr_stack`/`localstack` call
machinery, the trace/profile/error printers -- is src/progs/pr_exec_core.ts,
shared with WinQuake's own pr_exec.ts. This module is qwsv's binding of it: it
selects the QuakeWorld host profile before delegating and owns the two things
that are genuinely QuakeWorld's.

- `PRRunError` extends `SysError`, not src/common/host.ts's `HostError` (which
  is what WinQuake's own `PRRunError` extends): qwsvdef.ts's file header rules
  that module's `host`/`developer` singleton out of the qwsv binary entirely
  (`SERVERONLY` links no host.c at all). It carries the formatted message the
  C prints via `Con_Printf` before handing the fixed string "Program error" to
  `SV_Error`.
- `SV_Error` is re-exported here because pr_edict.ts, pr_cmds.ts, sv_phys.ts
  and this file's own C call sites all reach for it under that name. It is a
  lazy delegate to sv_main.ts's real implementation (a `require`, not a
  module-scope import: sv_main.ts imports `PRRunError`/`PR_ExecuteProgram`
  from this module, so a module-scope import back would be a cycle).

`prExec` (`pr_trace`/`pr_xfunction`/`pr_xstatement`/`pr_argc`/`pr_depth`) and
the `setBuiltins`/`getBuiltins` seam address `qwpr` directly, since that state
needs no profile lookup: two separate progs VMs, two separate sets of mutable
globals, exactly as the C's `qwsv` and `winquake` binaries each have their own
copy of every file-scope global pr_exec.c declares.
*/

import { SysError } from "../../platform/sys";
import type { DfunctionT, FuncT } from "../../progs/pr_comp";
import { qwpr } from "./progs";
import type { BuiltinT, EdictBaseT } from "../../progs/progs_core";
import { LOCALSTACK_SIZE, MAX_STACK_DEPTH } from "../../progs/progs_core";
import { PR_SetProfile } from "../../progs/profiles/profile";
import { qwProfile } from "../../progs/profiles/qw";
import * as core from "../../progs/pr_exec_core";
import type * as SvMainModule from "./sv_main";

// sv_main.ts imports PRRunError and PR_ExecuteProgram from this module, so a
// module-scope import back is a cycle. See the file header.
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

export { MAX_STACK_DEPTH, LOCALSTACK_SIZE };
export type { BuiltinT };
export const pr_opnames = core.pr_opnames;

export class PRRunError extends SysError {
  constructor(message: string) {
    super(message);
    this.name = "PRRunError";
  }
}

export function SV_Error(error: string, ...args: Array<string | number>): never {
  return svMainMod().SV_Error(error, ...args);
}

export const prExec = qwpr.exec;

export function setBuiltins(table: BuiltinT[]): void {
  qwpr.builtins = table;
}

// Read side of the seam, so a suite that installs a stand-in table can put the
// previous one back in afterAll (rule 15).
export function getBuiltins(): BuiltinT[] {
  return qwpr.builtins;
}

export type PrPointer = core.PrPointer;

export function PR_MakePointer(ed: EdictBaseT, ofs: number): number {
  PR_SetProfile(qwProfile);
  return core.PR_MakePointer(ed, ofs);
}

export function PR_ResolvePointer(p: number): core.PrPointer {
  PR_SetProfile(qwProfile);
  return core.PR_ResolvePointer(p);
}

export function PR_PrintStatement(sIndex: number): void {
  PR_SetProfile(qwProfile);
  core.PR_PrintStatement(sIndex);
}

export function PR_StackTrace(): void {
  PR_SetProfile(qwProfile);
  core.PR_StackTrace();
}

export function PR_Profile_f(): void {
  PR_SetProfile(qwProfile);
  core.PR_Profile_f();
}

export function PR_RunError(error: string, ...args: Array<string | number>): never {
  PR_SetProfile(qwProfile);
  return core.PR_RunError(error, ...args);
}

export function PR_EnterFunction(f: DfunctionT): number {
  PR_SetProfile(qwProfile);
  return core.PR_EnterFunction(f);
}

export function PR_LeaveFunction(): number {
  PR_SetProfile(qwProfile);
  return core.PR_LeaveFunction();
}

export function PR_ExecuteProgram(fnum: FuncT): void {
  PR_SetProfile(qwProfile);
  core.PR_ExecuteProgram(fnum);
}
