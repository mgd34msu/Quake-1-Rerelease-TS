/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_exec.c and QW/server/pr_exec.c (GNU GPL v2 or later).

The QuakeC bytecode interpreter: `PR_ExecuteProgram` and its opcode switch,
the `pr_stack`/`localstack` call machinery, and the trace/profile/error
printers. Retail progs.dat runs on this, so every opcode keeps the C's exact
integer/float behaviour, including which ops write `_float` and which write
`_int`.

QuakeWorld's pr_exec.c is WinQuake's with a 61-line delta (`diff -w`): every
`pr_strings + ofs` dereference becomes `PR_GetString(ofs)` (which this port
already did in both), every abort becomes `SV_Error` instead of
`Host_Error`/`Sys_Error`, `OP_STATE`'s `#ifdef FPS_20` branch is dropped (as
WinQuake's is), and `if (--runaway == 0)` replaces `if (!--runaway)` (the same
check, spelled differently). The error paths are the host profile's
`sysError`/`hostError`/`runError` hooks; everything else is identical and
lives here once.

Per-opcode write target (the C's `c->_float` vs `c->_int` vs `b->_int`),
because it is the one thing progs.dat can observe bit-for-bit:
  _float (state.globals.f): ADD_F, ADD_V, SUB_F, SUB_V, MUL_F, MUL_V, MUL_FV,
    MUL_VF, DIV_F, BITAND, BITOR, GE, LE, GT, LT, AND, OR, NOT_F, NOT_V,
    NOT_S, NOT_FNC, NOT_ENT, EQ_F, EQ_V, EQ_S, EQ_E, EQ_FNC, NE_F, NE_V,
    NE_S, NE_E, NE_FNC, STORE_V (into b), STOREP_V (into the edict field),
    LOAD_V (into c)
  _int (state.globals.i / the edict's int view): STORE_F, STORE_ENT,
    STORE_FLD, STORE_S, STORE_FNC (all into b), STOREP_F/ENT/FLD/S/FNC,
    ADDRESS, LOAD_F/FLD/ENT/S/FNC
Comparison and boolean results are C ints assigned to a `float` field, so
they land as 1.0/0.0 in the float view; OP_NE_S is the exception -- it stores
`strcmp`'s return value itself, not a 0/1.

Deviations from the C source:
- `pr_stack`, `pr_depth`, `pr_trace`, `pr_xfunction`, `pr_xstatement`,
  `pr_argc`, `localstack` and `pr_builtins` are C file-scope globals; here
  they live on the active profile's `ProgsStateT` (progs_core.ts), one set per
  host exactly as the two C binaries each had their own. pr_cmds.c reaches
  `pr_trace`/`pr_argc`/`pr_xfunction` through progs.h's `extern`s; ES modules
  have no writable cross-module binding, so each host's pr_exec.ts exports its
  state's `exec` holder as `prExec` and pr_cmds.ts mutates it in place.
- `PR_PrintStatement` takes a statement *index*, not a `dstatement_t *`:
  progs_core.ts stores the statements as four parallel `Int16Array`s per
  PORTING.md, so there is no per-statement object to pass.
- `pr_stack` is allocated with `MAX_STACK_DEPTH + 1` entries; see
  progs_core.ts's note on ProgsStateT.stack.
- `PR_RunError`'s `Host_Error ("Program error")` / `SV_Error`: the class thrown
  is the host's own `PRRunError` (WinQuake's extends `HostError`, so host.ts
  catches it where it catches a host error; QuakeWorld's extends `SysError`
  and is raised through sv_main.ts's `SV_Error`), reached through the
  profile's `runError` hook. The C prints the formatted message through
  Con_Printf and then hands Host_Error the fixed string "Program error"; both
  ports carry the formatted message on the exception instead.
- "Pointers" (OP_ADDRESS / OP_STOREP_*): the C computes a byte offset from
  `sv.edicts` (`(byte *)((int *)&ed->v + b->_int) - (byte *)sv.edicts`) and
  OP_STOREP_* dereferences `(byte *)sv.edicts + b->_int`. This port's edicts
  are separate objects with their own field buffers and no `edict_t` header
  inside that buffer, so byte offsets into one flat edict array have no
  meaning. Ruling (PORTING.md's edict-index scheme, extended): a pointer is
  `PR_MakePointer(ed, ofs) = ed.index * state.edict_size + ofs` and
  `PR_ResolvePointer(p) = { ed: EDICT_NUM(trunc(p / state.edict_size)),
  ofs: p % state.edict_size }`, with `ofs` a *field word* index. Only the
  stride's consistency matters. Values produced this way are NOT the C's byte
  offsets and must never be compared against a savegame or network value;
  pr_cmds.ts's `PF_` builtins never touch pointers, so this encoding stays
  private to this file.
- OP_NOT_S reads the string through `PR_GetString` instead of indexing
  `pr_strings` directly, so that engine strings (progs_core.ts's `string_t`
  ruling, indices at or above `ENGINE_STRING_BASE`) test as non-empty rather
  than reading past the end of the string block.
- OP_NE_S stores libc `strcmp`'s return value, whose exact magnitude is
  implementation-defined in C. The local `strcmp` below returns the
  difference of the first differing bytes (glibc's observable behaviour);
  QuakeC only ever tests it for zero/nonzero.
- OP_DONE/OP_RETURN copy the three return words through the *int* view. The
  C copies `pr_globals[]`, i.e. through `float`, which is a bit-exact move
  for every value progs.dat produces; going through JS numbers is not
  bit-exact for NaN payloads, and the int view is.
- `PR_GlobalString`/`PR_GlobalStringNoContents`/`ED_Print` live in
  pr_edict.c, whose `PR_Init` in turn registers this file's `PR_Profile_f`.
  That is a real import cycle, so per PORTING.md's cycle rule this (the less
  fundamental of the two -- pr_edict_core.ts owns the load-time state this
  file only reads) resolves it lazily through `require`.
- `#ifdef PARANOID`'s `NUM_FOR_EDICT(ed)` range assertions in OP_ADDRESS,
  OP_LOAD_* and OP_LOAD_V are dropped (they are pure bounds checks;
  `PROG_TO_EDICT` -> `EDICT_NUM` already range-checks here). `#ifdef FPS_20`'s
  0.05 nextthink in OP_STATE is dropped for the shipped 0.1.
- `PR_LeaveFunction`'s second, TS-only defensive check (the C dereferences
  `pr_xfunction` unchecked once `pr_depth` has passed the first guard) stays
  `Sys_Error` in both hosts: it guards a state this port's type system, not
  the C, requires proving.
*/

import { Con_Printf } from "../client/console";
import { Com_sprintf } from "../common/sprintf";
import { Sys_Error, SysError } from "../platform/sys";
import { OFS_PARM0, OFS_RETURN, OpT, type DfunctionT, type FuncT } from "./pr_comp";
import {
  EDICT_NUM,
  MAX_STACK_DEPTH,
  LOCALSTACK_SIZE,
  PROG_TO_EDICT,
  PR_GetString,
  requireGlobalStruct,
  type BuiltinT,
  type EdictBaseT,
  type ProgsStateT,
} from "./progs_core";
import type { ProgsGlobalVarsT } from "./progdefs_layout";
import { PR_ActiveProfile, PR_ActiveState } from "./profiles/profile";
import type * as PrEdictCoreModule from "./pr_edict_core";

// pr_edict_core.ts imports PR_ExecuteProgram and PR_Profile_f from this
// module, so a module-scope import back is a cycle. See the file header.
function prEdictMod(): typeof PrEdictCoreModule {
  return require("./pr_edict_core");
}

export { MAX_STACK_DEPTH, LOCALSTACK_SIZE };
export type { BuiltinT };

// pr_cmds.c's `builtin_t *pr_builtins` / `int pr_numbuiltins`; each host's
// pr_cmds.ts hands its `pr_builtin[]` table over at init time.
export function setBuiltins(table: BuiltinT[]): void {
  PR_ActiveState().builtins = table;
}

// Read side of the seam, so a suite that installs a stand-in table can put the
// previous one back in afterAll (rule 15).
export function getBuiltins(): BuiltinT[] {
  return PR_ActiveState().builtins;
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

function globals(state: ProgsStateT): { f: Float32Array; i: Int32Array } {
  if (state.globals === null) throw new SysError("pr_exec.ts: pr.globals not set (PR_LoadProgs not called)");
  return state.globals;
}

function globalStruct(state: ProgsStateT): ProgsGlobalVarsT {
  return requireGlobalStruct(state);
}

// libc strcmp: OP_EQ_S only needs its zero/nonzero-ness, but OP_NE_S stores
// the value itself into a float global. See the file header.
function strcmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  if (a.length !== b.length) return a.length - b.length;
  return 0;
}

//=============================================================================
// edict "pointers" (OP_ADDRESS / OP_STOREP_*), see the file header

export interface PrPointer {
  ed: EdictBaseT;
  ofs: number;
}

export function PR_MakePointer(ed: EdictBaseT, ofs: number): number {
  return ed.index * PR_ActiveState().edict_size + ofs;
}

export function PR_ResolvePointer(p: number): PrPointer {
  const state = PR_ActiveState();
  const stride = state.edict_size;
  return { ed: EDICT_NUM(state, Math.trunc(p / stride)), ofs: p % stride };
}

/*
=================
PR_PrintStatement
=================
*/
export function PR_PrintStatement(sIndex: number): void {
  const st = PR_ActiveState().statements;
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
  const state = PR_ActiveState();
  const prExec = state.exec;
  if (prExec.depth === 0) {
    Con_Printf("<NO STACK>\n");
    return;
  }

  state.stack[prExec.depth].f = prExec.xfunction;
  for (let i = prExec.depth; i >= 0; i--) {
    const f = state.stack[i].f;

    if (!f) {
      Con_Printf("<NO FUNCTION>\n");
    } else {
      Con_Printf("%12s : %s\n", PR_GetString(state, f.s_file), PR_GetString(state, f.s_name));
    }
  }
}

/*
============
PR_Profile_f

============
*/
export function PR_Profile_f(): void {
  const state = PR_ActiveState();
  let best: DfunctionT | null;
  let num = 0;
  do {
    let max = 0;
    best = null;
    for (let i = 0; i < state.functions.length; i++) {
      const f = state.functions[i];
      if (f.profile > max) {
        max = f.profile;
        best = f;
      }
    }
    if (best) {
      if (num < 10) Con_Printf("%7i %s\n", best.profile, PR_GetString(state, best.s_name));
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
  const profile = PR_ActiveProfile();
  const string = Com_sprintf(error, ...args);

  PR_PrintStatement(profile.state.exec.xstatement);
  PR_StackTrace();
  Con_Printf("%s\n", string);

  profile.state.exec.depth = 0; // dump the stack so host_error can shutdown functions

  return profile.runError(string); // Host_Error ("Program error") / SV_Error
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
  const state = PR_ActiveState();
  const prExec = state.exec;

  state.stack[prExec.depth].s = prExec.xstatement;
  state.stack[prExec.depth].f = prExec.xfunction;
  prExec.depth++;
  if (prExec.depth >= MAX_STACK_DEPTH) PR_RunError("stack overflow");

  // save off any locals that the new function steps on
  const c = f.locals;
  if (state.localstack_used + c > LOCALSTACK_SIZE) PR_RunError("PR_ExecuteProgram: locals stack overflow\n");

  const g = globals(state);
  for (let i = 0; i < c; i++) state.localstack[state.localstack_used + i] = g.i[f.parm_start + i];
  state.localstack_used += c;

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
  const profile = PR_ActiveProfile();
  const state = profile.state;
  const prExec = state.exec;

  if (prExec.depth <= 0) profile.sysError("prog stack underflow");

  const xf = prExec.xfunction;
  if (xf === null) Sys_Error("prog stack underflow"); // the C dereferences pr_xfunction unchecked here

  // restore locals from the stack
  const c = xf.locals;
  state.localstack_used -= c;
  if (state.localstack_used < 0) PR_RunError("PR_ExecuteProgram: locals stack underflow\n");

  const g = globals(state);
  for (let i = 0; i < c; i++) g.i[xf.parm_start + i] = state.localstack[state.localstack_used + i];

  // up stack
  prExec.depth--;
  prExec.xfunction = state.stack[prExec.depth].f;
  return state.stack[prExec.depth].s;
}

/*
====================
PR_ExecuteProgram
====================
*/
export function PR_ExecuteProgram(fnum: FuncT): void {
  const profile = PR_ActiveProfile();
  const state = profile.state;
  const prExec = state.exec;

  if (!fnum || fnum >= state.functions.length) {
    const gs = globalStruct(state);
    if (gs.self) prEdictMod().ED_Print(PROG_TO_EDICT(state, gs.self));
    profile.hostError("PR_ExecuteProgram: NULL function");
  }

  const f = state.functions[fnum];

  let runaway = 100000;
  prExec.trace = false;

  // make a stack frame
  const exitdepth = prExec.depth;

  let s = PR_EnterFunction(f);

  const stOp = state.statements.op;
  const stA = state.statements.a;
  const stB = state.statements.b;
  const stC = state.statements.c;
  const g = globals(state);
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
        gf[c] = gi[a] === 0 || PR_GetString(state, gi[a]) === "" ? 1 : 0;
        break;
      case OpT.OP_NOT_FNC:
        gf[c] = gi[a] === 0 ? 1 : 0;
        break;
      case OpT.OP_NOT_ENT:
        gf[c] = PROG_TO_EDICT(state, gi[a]) === EDICT_NUM(state, 0) ? 1 : 0;
        break;

      case OpT.OP_EQ_F:
        gf[c] = gf[a] === gf[b] ? 1 : 0;
        break;
      case OpT.OP_EQ_V:
        gf[c] = gf[a] === gf[b] && gf[a + 1] === gf[b + 1] && gf[a + 2] === gf[b + 2] ? 1 : 0;
        break;
      case OpT.OP_EQ_S:
        gf[c] = strcmp(PR_GetString(state, gi[a]), PR_GetString(state, gi[b])) === 0 ? 1 : 0;
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
        gf[c] = strcmp(PR_GetString(state, gi[a]), PR_GetString(state, gi[b]));
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
        const ed = PROG_TO_EDICT(state, gi[a]);
        if (ed === EDICT_NUM(state, 0) && profile.serverActive()) {
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
        const ed = PROG_TO_EDICT(state, gi[a]);
        gi[c] = ed.fields.i[gi[b]];
        break;
      }

      case OpT.OP_LOAD_V: {
        const ed = PROG_TO_EDICT(state, gi[a]);
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

        const newf = state.functions[gi[a]];

        if (newf.first_statement < 0) {
          // negative statements are built in functions
          const i = -newf.first_statement;
          if (i >= state.builtins.length) PR_RunError("Bad builtin call number");
          state.builtins[i]();
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
        const gs = globalStruct(state);
        const ed = PROG_TO_EDICT(state, gs.self);
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
