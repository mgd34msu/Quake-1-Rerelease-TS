/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_exec.c (GNU GPL v2 or later).

WinQuake's binding of the shared QuakeC bytecode interpreter. The interpreter
itself -- `PR_ExecuteProgram` and its opcode switch, the `pr_stack`/
`localstack` call machinery, and the trace/profile/error printers -- is
pr_exec_core.ts, which QuakeWorld's own pr_exec.ts binds the same way; see
that file's header for the per-opcode write targets and every deviation from
the C. This module selects the NetQuake host profile before delegating, and
owns the two things that are genuinely WinQuake's:

- `PRRunError` extends `HostError`, so host.ts catches a QuakeC program error
  exactly where it catches a host error. (QuakeWorld's own `PRRunError`
  extends `SysError` instead: qwsvdef.ts rules host.c out of the qwsv binary
  entirely, and sv_main.ts's `SV_Error` raises it.) The C prints the formatted
  message through Con_Printf and then hands `Host_Error` the fixed string
  "Program error"; this port carries the formatted message on the exception.
- `prExec` (`pr_trace`/`pr_xfunction`/`pr_xstatement`/`pr_argc`/`pr_depth`) and
  the `setBuiltins`/`getBuiltins` seam address WinQuake's VM state directly,
  since that state is `pr` and needs no profile lookup.

`traceon`/`traceoff` are QuakeC *builtins* in pr_cmds.c, not console commands,
so this file registers none; `profile` is registered by pr_edict.ts's PR_Init.
*/

import { HostError } from "../common/host";
import type { DfunctionT, FuncT } from "./pr_comp";
import { pr } from "./progs";
import type { BuiltinT, EdictBaseT } from "./progs_core";
import { LOCALSTACK_SIZE, MAX_STACK_DEPTH } from "./progs_core";
import { PR_SetProfile } from "./profiles/profile";
import { nqProfile } from "./profiles/nq";
import * as core from "./pr_exec_core";

export { MAX_STACK_DEPTH, LOCALSTACK_SIZE };
export type { BuiltinT };
export const pr_opnames = core.pr_opnames;

export class PRRunError extends HostError {
  constructor(message: string) {
    super(message);
    this.name = "PRRunError";
  }
}

// pr_exec.c's `pr_trace`/`pr_xfunction`/`pr_xstatement`/`pr_argc`/`pr_depth`,
// which pr_cmds.c reaches through progs.h's `extern`s. ES modules have no
// writable cross-module binding, so the five live on one holder pr_cmds.ts
// mutates in place, per PORTING.md's "shared mutable globals" rule.
export const prExec = pr.exec;

// pr_cmds.c's `builtin_t *pr_builtins` / `int pr_numbuiltins`; pr_cmds.ts
// hands its `pr_builtin[]` table over at init time.
export function setBuiltins(table: BuiltinT[]): void {
  pr.builtins = table;
}

// Test-only getter: pr_builtins has no other reader outside the VM, so a suite
// that calls setBuiltins with its own stand-in table has no way to snapshot the
// real table (installed at module load by src/progs/pr_cmds.ts's own
// side-effect import) before overwriting it, and no way to restore it
// afterward (rule 15).
export function getBuiltins(): BuiltinT[] {
  return pr.builtins;
}

export type PrPointer = core.PrPointer;

export function PR_MakePointer(ed: EdictBaseT, ofs: number): number {
  PR_SetProfile(nqProfile);
  return core.PR_MakePointer(ed, ofs);
}

export function PR_ResolvePointer(p: number): core.PrPointer {
  PR_SetProfile(nqProfile);
  return core.PR_ResolvePointer(p);
}

export function PR_PrintStatement(sIndex: number): void {
  PR_SetProfile(nqProfile);
  core.PR_PrintStatement(sIndex);
}

export function PR_StackTrace(): void {
  PR_SetProfile(nqProfile);
  core.PR_StackTrace();
}

export function PR_Profile_f(): void {
  PR_SetProfile(nqProfile);
  core.PR_Profile_f();
}

export function PR_RunError(error: string, ...args: Array<string | number>): never {
  PR_SetProfile(nqProfile);
  return core.PR_RunError(error, ...args);
}

export function PR_EnterFunction(f: DfunctionT): number {
  PR_SetProfile(nqProfile);
  return core.PR_EnterFunction(f);
}

export function PR_LeaveFunction(): number {
  PR_SetProfile(nqProfile);
  return core.PR_LeaveFunction();
}

export function PR_ExecuteProgram(fnum: FuncT): void {
  PR_SetProfile(nqProfile);
  core.PR_ExecuteProgram(fnum);
}
