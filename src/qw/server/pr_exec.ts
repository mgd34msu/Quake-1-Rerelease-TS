/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/pr_exec.c (GNU GPL v2 or later), which is WinQuake's
pr_exec.c with a small delta (61 changed lines, `diff -w` against
WinQuake/pr_exec.c): every `pr_strings + ofs` string dereference becomes
`PR_GetString(ofs)`; every `Host_Error`/`Sys_Error` that aborts the running
QuakeC program becomes `SV_Error` (QW server's error path, sv_main.c, not
yet landed -- see below); `OP_STATE`'s `#ifdef FPS_20` branch is dropped, same
as WinQuake's (this port already takes the non-`FPS_20` path); and QW adds
`PR_GetString`/`PR_SetString` themselves at the bottom of this file (progs.h
places their prototypes with the rest of the string_t declarations, but they
are actually *defined* here, not in pr_edict.c -- see src/qw/server/progs.ts's
file header, which already ports them there since progs.ts is where every
other qwsv module reaches `pr_strtbl`/`num_prstr` through).

This is the QuakeC bytecode interpreter for the standalone qwsv binary:
`PR_ExecuteProgram` and its opcode switch are otherwise byte-for-byte
WinQuake's (per-opcode `_float` vs `_int` write targets unchanged; see
src/progs/pr_exec.ts's file header for that table, which applies here
unmodified), now running over `qwpr`/`QwEdictT` (src/qw/server/progs.ts) and
QW's own `sv`/`ServerStateT` (src/qw/server/server.ts) instead of WinQuake's.

Deviations from PORTING.md / the C source, mirroring src/progs/pr_exec.ts's
own deviations (see that file's header for the reasoning, not repeated here)
plus the ones specific to this being a second, standalone progs host:
- `pr_stack`/`pr_depth`/`pr_trace`/`pr_xfunction`/`pr_xstatement`/`pr_argc`
  live on this file's own `prExec` holder, a fresh singleton -- NOT
  src/progs/pr_exec.ts's `prExec` (two separate progs VMs, two separate sets
  of mutable globals, exactly as the C's `qwsv` and `quake`/`winquake`
  binaries each have their own copy of every file-scope global pr_exec.c
  declares).
- `PR_PrintStatement` takes a statement index, not a `dstatement_t *`, same
  reason as src/progs/pr_exec.ts (statements are four parallel `Int16Array`s
  on `qwpr.statements`).
- Pointers (`OP_ADDRESS`/`OP_STOREP_*`): `PR_MakePointer`/`PR_ResolvePointer`
  below are this module's own copy of src/progs/pr_exec.ts's edict-index
  encoding (`ed.index * qwpr.edict_size + ofs`), over `QwEdictT` and
  `qwpr.edict_size` instead of `EdictT`/`pr.edict_size`. Values it produces
  are private to this file, exactly as that file's ruling states.
- `SV_Error` (QW/server/sv_main.c) has landed (Q014). This file still defines
  its own `PRRunError` (same name and shape as src/progs/pr_exec.ts's --
  carries the formatted message the C prints via `Con_Printf` before handing
  the fixed string "Program error" to `SV_Error`) extending `SysError`, not
  imported from src/progs/pr_exec.ts and not extending src/common/host.ts's
  `HostError`: qwsvdef.ts's own file header rules that module's
  `host`/`developer` singleton out of the qwsv binary entirely (`SERVERONLY`
  links no host.c at all), and this progs host is otherwise self-contained
  per PORTING.md's "QW server is its own progs host" ruling, so it does not
  reach into src/common/host.ts either. This file's own `SV_Error` export is
  now a lazy delegate to sv_main.ts's real implementation (a `require`, not a
  module-scope import: sv_main.ts imports `PRRunError`/`PR_ExecuteProgram`
  from this module, so a module-scope import back would be a cycle). Every
  `SV_Error(...)` call site in this file and in pr_edict.ts throws
  `PRRunError` via that delegate; src/common/host.ts catches
  `PRRunError` from src/progs/pr_exec.ts the same way sv_main.ts catches it
  from this module wherever the C's `SV_Error` would longjmp out of the
  server frame.
- `PR_LeaveFunction`'s first check (`pr_depth <= 0`) is `SV_Error` in the C
  (a real delta from WinQuake's `Sys_Error`) and is ported as `PRRunError`
  here; the *second*, TS-only defensive check this port adds beneath it (the
  C dereferences `pr_xfunction` unchecked once `pr_depth` has passed that
  guard) stays `Sys_Error`, matching src/progs/pr_exec.ts's own precedent --
  it guards a state this port's type system, not the C, requires proving.
- `if (--runaway == 0)` (QW) vs WinQuake's `if (!--runaway)`: cosmetic only,
  identical runtime behaviour (`--runaway` decrements to zero on the same
  iteration either way); ported as `if (!--runaway)` to match this port's
  existing WinQuake idiom rather than introduce a second spelling of the
  same check.
- `pr_builtins`/`pr_numbuiltins` live in this track's own pr_cmds.c (Q012,
  not yet landed), registered here through `setBuiltins`, same seam
  src/progs/pr_exec.ts exposes.
- `PR_GlobalString`/`PR_GlobalStringNoContents`/`ED_Print` live in
  pr_edict.ts, whose `PR_Init` in turn needs this file's `PR_Profile_f`; the
  same import cycle src/progs/pr_exec.ts documents exists here too, resolved
  the same way (a lazy `require("./pr_edict")`, this file being the less
  fundamental of the two since pr_edict.ts owns `qwpr`'s load-time state).
  `sv`/`ServerStateT` (read by `OP_ADDRESS`) are this track's own
  `src/qw/server/server.ts` and are imported normally, for the same reason
  src/progs/pr_exec.ts imports WinQuake's `server.ts` normally: nothing that
  module imports leads back here.
*/

import { Con_Printf } from "../../client/console";
import { Com_sprintf } from "../../common/sprintf";
import { Sys_Error, SysError } from "../../platform/sys";
import { OFS_PARM0, OFS_RETURN, OpT, type DfunctionT, type FuncT } from "../../progs/pr_comp";
import { EDICT_NUM, PROG_TO_EDICT, PR_GetString, qwpr, type QwEdictT } from "./progs";
import type { QwGlobalVars } from "./progdefs";
import type * as PrEdictModule from "./pr_edict";
import { ServerStateT, sv } from "./server";
import type * as SvMainModule from "./sv_main";

// pr_edict.ts imports PR_ExecuteProgram and PR_Profile_f from this module,
// so a module-scope import back is a cycle. See the file header.
function prEdictMod(): typeof PrEdictModule {
  return require("./pr_edict");
}

// sv_main.ts imports PRRunError and PR_ExecuteProgram from this module, so a
// module-scope import back is a cycle; see the file header's SV_Error note.
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

interface PrstackT {
  s: number;
  f: DfunctionT | null;
}

export const MAX_STACK_DEPTH = 32;
// MAX_STACK_DEPTH + 1 entries: see src/progs/pr_exec.ts's identical pr_stack note.
const pr_stack: PrstackT[] = [];
for (let i = 0; i <= MAX_STACK_DEPTH; i++) pr_stack.push({ s: 0, f: null });

export const LOCALSTACK_SIZE = 2048;
const localstack = new Int32Array(LOCALSTACK_SIZE);
let localstack_used = 0;

interface PrExecState {
  trace: boolean; // pr_trace
  xfunction: DfunctionT | null; // pr_xfunction
  xstatement: number; // pr_xstatement
  argc: number; // pr_argc
  depth: number; // pr_depth
}

export const prExec: PrExecState = {
  trace: false,
  xfunction: null,
  xstatement: 0,
  argc: 0,
  depth: 0,
};

export type BuiltinT = () => void;

let pr_builtins: BuiltinT[] = [];

// pr_cmds.c's `builtin_t *pr_builtins` / `int pr_numbuiltins`; Q012's
// pr_cmds.ts hands its `pr_builtin[]` table over at init time.
export function setBuiltins(table: BuiltinT[]): void {
  pr_builtins = table;
}

export const pr_opnames: readonly string[] = [
  "DONE",

  "MUL_F",
  "MUL_V",
  "MUL_FV",
  "MUL_VF",

  "DIV",

  "ADD_F",
  "ADD_V",

  "SUB_F",
  "SUB_V",

  "EQ_F",
  "EQ_V",
  "EQ_S",
  "EQ_E",
  "EQ_FNC",

  "NE_F",
  "NE_V",
  "NE_S",
  "NE_E",
  "NE_FNC",

  "LE",
  "GE",
  "LT",
  "GT",

  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",
  "INDIRECT",

  "ADDRESS",

  "STORE_F",
  "STORE_V",
  "STORE_S",
  "STORE_ENT",
  "STORE_FLD",
  "STORE_FNC",

  "STOREP_F",
  "STOREP_V",
  "STOREP_S",
  "STOREP_ENT",
  "STOREP_FLD",
  "STOREP_FNC",

  "RETURN",

  "NOT_F",
  "NOT_V",
  "NOT_S",
  "NOT_ENT",
  "NOT_FNC",

  "IF",
  "IFNOT",

  "CALL0",
  "CALL1",
  "CALL2",
  "CALL3",
  "CALL4",
  "CALL5",
  "CALL6",
  "CALL7",
  "CALL8",

  "STATE",

  "GOTO",

  "AND",
  "OR",

  "BITAND",
  "BITOR",
];

//=============================================================================

function globals(): { f: Float32Array; i: Int32Array } {
  if (qwpr.globals === null) throw new SysError("qw/server/pr_exec.ts: qwpr.globals not set (PR_LoadProgs not called)");
  return qwpr.globals;
}

function globalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) {
    throw new SysError("qw/server/pr_exec.ts: qwpr.global_struct not set (PR_LoadProgs not called)");
  }
  return qwpr.global_struct;
}

// libc strcmp: OP_EQ_S only needs its zero/nonzero-ness, but OP_NE_S stores
// the return value itself into c->_float, so the value is observable.
function strcmp(s1: string, s2: string): number {
  const n = s1.length > s2.length ? s1.length : s2.length;
  for (let i = 0; i < n; i++) {
    const c1 = i < s1.length ? s1.charCodeAt(i) : 0;
    const c2 = i < s2.length ? s2.charCodeAt(i) : 0;
    if (c1 !== c2) return c1 - c2;
  }
  return 0;
}

export class PRRunError extends SysError {
  constructor(message: string) {
    super(message);
    this.name = "PRRunError";
  }
}

// SV_Error now lives in sv_main.ts (Q014 landed it); delegate through a lazy
// require to avoid the load-time cycle documented above (sv_main.ts imports
// PRRunError/PR_ExecuteProgram from this module). Every call site below and
// in pr_edict.ts that calls `SV_Error(...)` directly goes through here.
export function SV_Error(error: string, ...args: Array<string | number>): never {
  const svMain = svMainMod();
  return svMain.SV_Error(error, ...args);
}

//=============================================================================
// edict "pointers" (OP_ADDRESS / OP_STOREP_*), see the file header

export interface PrPointer {
  ed: QwEdictT;
  ofs: number;
}

export function PR_MakePointer(ed: QwEdictT, ofs: number): number {
  return ed.index * qwpr.edict_size + ofs;
}

export function PR_ResolvePointer(p: number): PrPointer {
  const stride = qwpr.edict_size;
  return { ed: EDICT_NUM(Math.trunc(p / stride)), ofs: p % stride };
}

//=============================================================================

/*
=================
PR_PrintStatement
=================
*/
export function PR_PrintStatement(sIndex: number): void {
  const st = qwpr.statements;
  const op = st.op[sIndex];
  const sa = st.a[sIndex];
  const sb = st.b[sIndex];
  const sc = st.c[sIndex];
  let i: number;

  if (op >>> 0 < pr_opnames.length) {
    Con_Printf("%s ", pr_opnames[op]);
    i = pr_opnames[op].length;
    for (; i < 10; i++) Con_Printf(" ");
  }

  if (op === OpT.OP_IF || op === OpT.OP_IFNOT) {
    Con_Printf("%sbranch %i", prEdictMod().PR_GlobalString(sa), sb);
  } else if (op === OpT.OP_GOTO) {
    Con_Printf("branch %i", sa);
  } else if ((op - OpT.OP_STORE_F) >>> 0 < 6) {
    Con_Printf("%s", prEdictMod().PR_GlobalString(sa));
    Con_Printf("%s", prEdictMod().PR_GlobalStringNoContents(sb));
  } else {
    if (sa) Con_Printf("%s", prEdictMod().PR_GlobalString(sa));
    if (sb) Con_Printf("%s", prEdictMod().PR_GlobalString(sb));
    if (sc) Con_Printf("%s", prEdictMod().PR_GlobalStringNoContents(sc));
  }
  Con_Printf("\n");
}

/*
============
PR_StackTrace
============
*/
export function PR_StackTrace(): void {
  if (prExec.depth === 0) {
    Con_Printf("<NO STACK>\n");
    return;
  }

  pr_stack[prExec.depth].f = prExec.xfunction;
  for (let i = prExec.depth; i >= 0; i--) {
    const f = pr_stack[i].f;

    if (!f) {
      Con_Printf("<NO FUNCTION>\n");
    } else {
      Con_Printf("%12s : %s\n", PR_GetString(f.s_file), PR_GetString(f.s_name));
    }
  }
}

/*
============
PR_Profile_f

============
*/
export function PR_Profile_f(): void {
  let best: DfunctionT | null;
  let num = 0;
  do {
    let max = 0;
    best = null;
    for (let i = 0; i < qwpr.functions.length; i++) {
      const f = qwpr.functions[i];
      if (f.profile > max) {
        max = f.profile;
        best = f;
      }
    }
    if (best) {
      if (num < 10) Con_Printf("%7i %s\n", best.profile, PR_GetString(best.s_name));
      num++;
      best.profile = 0;
    }
  } while (best);
}

/*
============
PR_RunError

Aborts the currently executing function
============
*/
export function PR_RunError(error: string, ...args: Array<string | number>): never {
  const string = Com_sprintf(error, ...args);

  PR_PrintStatement(prExec.xstatement);
  PR_StackTrace();
  Con_Printf("%s\n", string);

  prExec.depth = 0; // dump the stack so SV_Error can shutdown functions

  throw new PRRunError(string); // SV_Error ("Program error")
}

/*
============================================================================
PR_ExecuteProgram

The interpretation main loop
============================================================================
*/

/*
====================
PR_EnterFunction

Returns the new program statement counter
====================
*/
export function PR_EnterFunction(f: DfunctionT): number {
  pr_stack[prExec.depth].s = prExec.xstatement;
  pr_stack[prExec.depth].f = prExec.xfunction;
  prExec.depth++;
  if (prExec.depth >= MAX_STACK_DEPTH) PR_RunError("stack overflow");

  // save off any locals that the new function steps on
  const c = f.locals;
  if (localstack_used + c > LOCALSTACK_SIZE) PR_RunError("PR_ExecuteProgram: locals stack overflow\n");

  const g = globals();
  for (let i = 0; i < c; i++) localstack[localstack_used + i] = g.i[f.parm_start + i];
  localstack_used += c;

  // copy parameters
  let o = f.parm_start;
  for (let i = 0; i < f.numparms; i++) {
    for (let j = 0; j < f.parm_size[i]; j++) {
      g.i[o] = g.i[OFS_PARM0 + i * 3 + j];
      o++;
    }
  }

  prExec.xfunction = f;
  return f.first_statement - 1; // offset the s++
}

/*
====================
PR_LeaveFunction
====================
*/
export function PR_LeaveFunction(): number {
  if (prExec.depth <= 0) SV_Error("prog stack underflow"); // a real QW delta from WinQuake's Sys_Error here

  const xf = prExec.xfunction;
  if (xf === null) Sys_Error("prog stack underflow"); // the C dereferences pr_xfunction unchecked here

  // restore locals from the stack
  const c = xf.locals;
  localstack_used -= c;
  if (localstack_used < 0) PR_RunError("PR_ExecuteProgram: locals stack underflow\n");

  const g = globals();
  for (let i = 0; i < c; i++) g.i[xf.parm_start + i] = localstack[localstack_used + i];

  // up stack
  prExec.depth--;
  prExec.xfunction = pr_stack[prExec.depth].f;
  return pr_stack[prExec.depth].s;
}

/*
====================
PR_ExecuteProgram
====================
*/
export function PR_ExecuteProgram(fnum: FuncT): void {
  if (!fnum || fnum >= qwpr.functions.length) {
    const gs = globalStruct();
    if (gs.self) prEdictMod().ED_Print(PROG_TO_EDICT(gs.self));
    SV_Error("PR_ExecuteProgram: NULL function");
  }

  const f = qwpr.functions[fnum];

  let runaway = 100000;
  prExec.trace = false;

  // make a stack frame
  const exitdepth = prExec.depth;

  let s = PR_EnterFunction(f);

  const stOp = qwpr.statements.op;
  const stA = qwpr.statements.a;
  const stB = qwpr.statements.b;
  const stC = qwpr.statements.c;
  const g = globals();
  const gf = g.f;
  const gi = g.i;

  for (;;) {
    s++; // next statement

    const op = stOp[s];
    const a = stA[s];
    const b = stB[s];
    const c = stC[s];

    if (!--runaway) PR_RunError("runaway loop error");

    // pr_xfunction is non-null for the whole loop (PR_EnterFunction set it,
    // and OP_DONE/OP_RETURN returns before it could be unwound past the
    // entry frame); the C dereferences it unchecked.
    const xf = prExec.xfunction;
    if (xf === null) Sys_Error("PR_ExecuteProgram: pr_xfunction is NULL");
    xf.profile++;
    prExec.xstatement = s;

    if (prExec.trace) PR_PrintStatement(s);

    switch (op) {
      case OpT.OP_ADD_F:
        gf[c] = gf[a] + gf[b];
        break;
      case OpT.OP_ADD_V:
        gf[c] = gf[a] + gf[b];
        gf[c + 1] = gf[a + 1] + gf[b + 1];
        gf[c + 2] = gf[a + 2] + gf[b + 2];
        break;

      case OpT.OP_SUB_F:
        gf[c] = gf[a] - gf[b];
        break;
      case OpT.OP_SUB_V:
        gf[c] = gf[a] - gf[b];
        gf[c + 1] = gf[a + 1] - gf[b + 1];
        gf[c + 2] = gf[a + 2] - gf[b + 2];
        break;

      case OpT.OP_MUL_F:
        gf[c] = gf[a] * gf[b];
        break;
      case OpT.OP_MUL_V:
        gf[c] = gf[a] * gf[b] + gf[a + 1] * gf[b + 1] + gf[a + 2] * gf[b + 2];
        break;
      case OpT.OP_MUL_FV:
        gf[c] = gf[a] * gf[b];
        gf[c + 1] = gf[a] * gf[b + 1];
        gf[c + 2] = gf[a] * gf[b + 2];
        break;
      case OpT.OP_MUL_VF:
        gf[c] = gf[b] * gf[a];
        gf[c + 1] = gf[b] * gf[a + 1];
        gf[c + 2] = gf[b] * gf[a + 2];
        break;

      case OpT.OP_DIV_F:
        gf[c] = gf[a] / gf[b];
        break;

      case OpT.OP_BITAND:
        gf[c] = (gf[a] | 0) & (gf[b] | 0);
        break;

      case OpT.OP_BITOR:
        gf[c] = (gf[a] | 0) | (gf[b] | 0);
        break;

      case OpT.OP_GE:
        gf[c] = gf[a] >= gf[b] ? 1 : 0;
        break;
      case OpT.OP_LE:
        gf[c] = gf[a] <= gf[b] ? 1 : 0;
        break;
      case OpT.OP_GT:
        gf[c] = gf[a] > gf[b] ? 1 : 0;
        break;
      case OpT.OP_LT:
        gf[c] = gf[a] < gf[b] ? 1 : 0;
        break;
      case OpT.OP_AND:
        gf[c] = gf[a] !== 0 && gf[b] !== 0 ? 1 : 0;
        break;
      case OpT.OP_OR:
        gf[c] = gf[a] !== 0 || gf[b] !== 0 ? 1 : 0;
        break;

      case OpT.OP_NOT_F:
        gf[c] = gf[a] === 0 ? 1 : 0;
        break;
      case OpT.OP_NOT_V:
        gf[c] = gf[a] === 0 && gf[a + 1] === 0 && gf[a + 2] === 0 ? 1 : 0;
        break;
      case OpT.OP_NOT_S:
        gf[c] = gi[a] === 0 || PR_GetString(gi[a]) === "" ? 1 : 0;
        break;
      case OpT.OP_NOT_FNC:
        gf[c] = gi[a] === 0 ? 1 : 0;
        break;
      case OpT.OP_NOT_ENT:
        gf[c] = PROG_TO_EDICT(gi[a]) === EDICT_NUM(0) ? 1 : 0;
        break;

      case OpT.OP_EQ_F:
        gf[c] = gf[a] === gf[b] ? 1 : 0;
        break;
      case OpT.OP_EQ_V:
        gf[c] = gf[a] === gf[b] && gf[a + 1] === gf[b + 1] && gf[a + 2] === gf[b + 2] ? 1 : 0;
        break;
      case OpT.OP_EQ_S:
        gf[c] = strcmp(PR_GetString(gi[a]), PR_GetString(gi[b])) === 0 ? 1 : 0;
        break;
      case OpT.OP_EQ_E:
        gf[c] = gi[a] === gi[b] ? 1 : 0;
        break;
      case OpT.OP_EQ_FNC:
        gf[c] = gi[a] === gi[b] ? 1 : 0;
        break;

      case OpT.OP_NE_F:
        gf[c] = gf[a] !== gf[b] ? 1 : 0;
        break;
      case OpT.OP_NE_V:
        gf[c] = gf[a] !== gf[b] || gf[a + 1] !== gf[b + 1] || gf[a + 2] !== gf[b + 2] ? 1 : 0;
        break;
      case OpT.OP_NE_S:
        gf[c] = strcmp(PR_GetString(gi[a]), PR_GetString(gi[b]));
        break;
      case OpT.OP_NE_E:
        gf[c] = gi[a] !== gi[b] ? 1 : 0;
        break;
      case OpT.OP_NE_FNC:
        gf[c] = gi[a] !== gi[b] ? 1 : 0;
        break;

      //==================
      case OpT.OP_STORE_F:
      case OpT.OP_STORE_ENT:
      case OpT.OP_STORE_FLD: // integers
      case OpT.OP_STORE_S:
      case OpT.OP_STORE_FNC: // pointers
        gi[b] = gi[a];
        break;
      case OpT.OP_STORE_V:
        gf[b] = gf[a];
        gf[b + 1] = gf[a + 1];
        gf[b + 2] = gf[a + 2];
        break;

      case OpT.OP_STOREP_F:
      case OpT.OP_STOREP_ENT:
      case OpT.OP_STOREP_FLD: // integers
      case OpT.OP_STOREP_S:
      case OpT.OP_STOREP_FNC: {
        // pointers
        const ptr = PR_ResolvePointer(gi[b]);
        ptr.ed.fields.i[ptr.ofs] = gi[a];
        break;
      }
      case OpT.OP_STOREP_V: {
        const ptr = PR_ResolvePointer(gi[b]);
        ptr.ed.fields.f[ptr.ofs] = gf[a];
        ptr.ed.fields.f[ptr.ofs + 1] = gf[a + 1];
        ptr.ed.fields.f[ptr.ofs + 2] = gf[a + 2];
        break;
      }

      case OpT.OP_ADDRESS: {
        const ed = PROG_TO_EDICT(gi[a]);
        if (ed === EDICT_NUM(0) && sv.state === ServerStateT.ss_active) {
          PR_RunError("assignment to world entity");
        }
        gi[c] = PR_MakePointer(ed, gi[b]);
        break;
      }

      case OpT.OP_LOAD_F:
      case OpT.OP_LOAD_FLD:
      case OpT.OP_LOAD_ENT:
      case OpT.OP_LOAD_S:
      case OpT.OP_LOAD_FNC: {
        const ed = PROG_TO_EDICT(gi[a]);
        gi[c] = ed.fields.i[gi[b]];
        break;
      }

      case OpT.OP_LOAD_V: {
        const ed = PROG_TO_EDICT(gi[a]);
        const o = gi[b];
        gf[c] = ed.fields.f[o];
        gf[c + 1] = ed.fields.f[o + 1];
        gf[c + 2] = ed.fields.f[o + 2];
        break;
      }

      //==================

      case OpT.OP_IFNOT:
        if (!gi[a]) s += b - 1; // offset the s++
        break;

      case OpT.OP_IF:
        if (gi[a]) s += b - 1; // offset the s++
        break;

      case OpT.OP_GOTO:
        s += a - 1; // offset the s++
        break;

      case OpT.OP_CALL0:
      case OpT.OP_CALL1:
      case OpT.OP_CALL2:
      case OpT.OP_CALL3:
      case OpT.OP_CALL4:
      case OpT.OP_CALL5:
      case OpT.OP_CALL6:
      case OpT.OP_CALL7:
      case OpT.OP_CALL8: {
        prExec.argc = op - OpT.OP_CALL0;
        if (!gi[a]) PR_RunError("NULL function");

        const newf = qwpr.functions[gi[a]];

        if (newf.first_statement < 0) {
          // negative statements are built in functions
          const i = -newf.first_statement;
          if (i >= pr_builtins.length) PR_RunError("Bad builtin call number");
          pr_builtins[i]();
          break;
        }

        s = PR_EnterFunction(newf);
        break;
      }

      case OpT.OP_DONE:
      case OpT.OP_RETURN:
        gi[OFS_RETURN] = gi[a];
        gi[OFS_RETURN + 1] = gi[a + 1];
        gi[OFS_RETURN + 2] = gi[a + 2];

        s = PR_LeaveFunction();
        if (prExec.depth === exitdepth) return; // all done
        break;

      case OpT.OP_STATE: {
        const gs = globalStruct();
        const ed = PROG_TO_EDICT(gs.self);
        ed.v.nextthink = gs.time + 0.1;
        if (gf[a] !== ed.v.frame) {
          ed.v.frame = gf[a];
        }
        ed.v.think = gi[b];
        break;
      }

      default:
        PR_RunError("Bad opcode %i", op);
    }
  }
}
