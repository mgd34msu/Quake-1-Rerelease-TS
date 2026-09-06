/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_exec.c (GNU GPL v2 or later).

The QuakeC bytecode interpreter: `PR_ExecuteProgram` and its opcode switch,
the `pr_stack`/`localstack` call machinery, and the trace/profile/error
printers. Retail progs.dat runs on this, so every opcode keeps the C's exact
integer/float behaviour, including which ops write `_float` and which write
`_int`.

Per-opcode write target (the C's `c->_float` vs `c->_int` vs `b->_int`),
because it is the one thing progs.dat can observe bit-for-bit:
  _float (pr.globals.f): ADD_F, ADD_V, SUB_F, SUB_V, MUL_F, MUL_V, MUL_FV,
    MUL_VF, DIV_F, BITAND, BITOR, GE, LE, GT, LT, AND, OR, NOT_F, NOT_V,
    NOT_S, NOT_FNC, NOT_ENT, EQ_F, EQ_V, EQ_S, EQ_E, EQ_FNC, NE_F, NE_V,
    NE_S, NE_E, NE_FNC, STORE_V (into b), STOREP_V (into the edict field),
    LOAD_V (into c)
  _int (pr.globals.i / the edict's int view): STORE_F, STORE_ENT, STORE_FLD,
    STORE_S, STORE_FNC (all into b), STOREP_F/ENT/FLD/S/FNC, ADDRESS,
    LOAD_F/FLD/ENT/S/FNC
Comparison and boolean results are C ints assigned to a `float` field, so
they land as 1.0/0.0 in the float view; OP_NE_S is the exception -- it stores
`strcmp`'s return value itself, not a 0/1.

Deviations from the C source:
- `pr_stack`, `pr_depth`, `pr_trace`, `pr_xfunction`, `pr_xstatement` and
  `pr_argc` are C file-scope globals that pr_cmds.c reaches through progs.h's
  `extern`s (`PF_traceon`/`PF_traceoff` write pr_trace; the `G_*` parameter
  macros and `PF_Fixme`/`PF_error` read pr_argc and pr_xfunction). ES modules
  have no writable cross-module binding, so the five mutable ones live on one
  exported holder, `prExec` (`trace`/`xfunction`/`xstatement`/`argc`/`depth`),
  mutated in place exactly as PORTING.md's "shared mutable globals" rule
  prescribes. `pr_stack` and `localstack` stay module-private, as in the C.
- `PR_PrintStatement` takes a statement *index*, not a `dstatement_t *`:
  progs.ts stores the statements as four parallel `Int16Array`s per
  PORTING.md, so there is no per-statement object to pass.
- `pr_stack` is allocated with `MAX_STACK_DEPTH + 1` entries. `PR_StackTrace`
  writes `pr_stack[pr_depth]`, and `PR_EnterFunction` calls `PR_RunError`
  (hence `PR_StackTrace`) with `pr_depth == MAX_STACK_DEPTH`; in C that one
  write runs off the end of the array, here it would be a store to
  `undefined`. The extra slot preserves the observable behaviour of the
  overrun without the crash.
- `PR_RunError`'s `Host_Error ("Program error")` and the NULL-function
  `Host_Error` in `PR_ExecuteProgram`: host.c is U035 and `HostError` does
  not exist yet. Ruling: this module defines and throws `PRRunError`, which
  carries the *formatted* message (the C prints that message through
  Con_Printf and then hands Host_Error the fixed string "Program error").
  host.ts catches `PRRunError` in the same place it catches `HostError`; the
  coordinator unifies the two classes when host.ts lands.
- "Pointers" (OP_ADDRESS / OP_STOREP_*): the C computes a byte offset from
  `sv.edicts` (`(byte *)((int *)&ed->v + b->_int) - (byte *)sv.edicts`) and
  OP_STOREP_* dereferences `(byte *)sv.edicts + b->_int`. This port's edicts
  are separate `EdictT` objects with their own field buffers and no
  `edict_t` header inside that buffer, so byte offsets into one flat edict
  array have no meaning. Ruling (PORTING.md's edict-index scheme, extended):
  a pointer is `PR_MakePointer(ed, ofs) = ed.index * pr.edict_size + ofs`
  and `PR_ResolvePointer(p) = { ed: EDICT_NUM(trunc(p / pr.edict_size)),
  ofs: p % pr.edict_size }`, with `ofs` a *field word* index into
  `ed.fields.f`/`ed.fields.i`. Only the stride's consistency matters (any
  `pr.edict_size` at least as large as the per-edict field-word count round
  trips), so this works whether pr_edict.ts sets `pr.edict_size` in bytes,
  as the C's `pr_edict_size` is, or in words. Values produced this way are
  NOT the C's byte offsets and must never be compared against a savegame or
  network value; pr_cmds.ts's `PF_` builtins never touch pointers, so this
  encoding stays private to this file.
- OP_NOT_S reads the string through `PR_GetString` instead of indexing
  `pr_strings` directly, so that engine strings (progs.ts's `string_t`
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
- `pr_builtins`/`pr_numbuiltins` live in pr_cmds.c (U023), which is written
  after this unit and imports from it. The table is registered here through
  `setBuiltins`, and `pr_numbuiltins` is that array's length.
- `PR_EnterFunction`/`PR_LeaveFunction`/`PR_PrintStatement`/`PR_StackTrace`
  are exported (they are non-`static` in the C but declared in no header);
  pr_edict.ts needs `PR_Profile_f` for the "profile" command its `PR_Init`
  registers. This file registers no console commands: `traceon`/`traceoff`
  are QuakeC *builtins* in pr_cmds.c, not commands.
- `PR_GlobalString`/`PR_GlobalStringNoContents`/`ED_Print` live in
  pr_edict.c, whose `PR_Init` in turn registers this file's `PR_Profile_f`.
  That is a real import cycle, so per PORTING.md's cycle rule this (the less
  fundamental of the two -- pr_edict.ts owns the `pr` state this file only
  reads) resolves it lazily through `require`. That is this file's one lazy
  resolution; `sv`/`ServerStateT` (read by OP_ADDRESS) are imported normally,
  because server.ts imports nothing that leads back here -- world.ts, not
  server.ts, is the server-side module that calls `PR_ExecuteProgram`.
- `#ifdef PARANOID`'s `NUM_FOR_EDICT(ed)` range assertions in OP_ADDRESS,
  OP_LOAD_* and OP_LOAD_V are dropped (they are pure bounds checks;
  `PROG_TO_EDICT` -> `EDICT_NUM` already range-checks here). `#ifdef FPS_20`'s
  0.05 nextthink in OP_STATE is dropped for the shipped 0.1.
*/

import { HostError } from "../common/host";
import { Con_Printf } from "../client/console";
import { Com_sprintf } from "../common/sprintf";
import { Sys_Error, SysError } from "../platform/sys";
import { OFS_PARM0, OFS_RETURN, OpT, type DfunctionT, type FuncT } from "./pr_comp";
import { EDICT_NUM, PROG_TO_EDICT, PR_GetString, pr, type EdictT } from "./progs";
import type { GlobalVars } from "./progdefs";
import type * as PrEdictModule from "./pr_edict";
import { ServerStateT, sv } from "../server/server";

// pr_edict.ts imports PR_ExecuteProgram and PR_Profile_f from this module,
// so a module-scope import back is a cycle. See the file header.
function prEdictMod(): typeof PrEdictModule {
  return require("./pr_edict");
}

interface PrstackT {
  s: number;
  f: DfunctionT | null;
}

export const MAX_STACK_DEPTH = 32;
// MAX_STACK_DEPTH + 1 entries: see the pr_stack note in the file header.
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

// pr_cmds.c's `builtin_t *pr_builtins` / `int pr_numbuiltins`; pr_cmds.ts
// (U023) hands its `pr_builtin[]` table over at init time.
export function setBuiltins(table: BuiltinT[]): void {
  pr_builtins = table;
}

// Test-only getter: pr_builtins has no other reader outside this module, so
// a suite that calls setBuiltins with its own stand-in table (test/pr_exec.test.ts's
// hand-built bytecode programs) has no way to snapshot the real table
// (installed at module load by src/progs/pr_cmds.ts's own side-effect
// import) before overwriting it, and no way to restore it afterward
// (rule 15).
export function getBuiltins(): BuiltinT[] {
  return pr_builtins;
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
  if (pr.globals === null) throw new SysError("pr_exec.ts: pr.globals not set (PR_LoadProgs not called)");
  return pr.globals;
}

function globalStruct(): GlobalVars {
  if (pr.global_struct === null) {
    throw new SysError("pr_exec.ts: pr.global_struct not set (PR_LoadProgs not called)");
  }
  return pr.global_struct;
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

export class PRRunError extends HostError {
  constructor(message: string) {
    super(message);
    this.name = "PRRunError";
  }
}

//=============================================================================
// edict "pointers" (OP_ADDRESS / OP_STOREP_*), see the file header

export interface PrPointer {
  ed: EdictT;
  ofs: number;
}

export function PR_MakePointer(ed: EdictT, ofs: number): number {
  return ed.index * pr.edict_size + ofs;
}

export function PR_ResolvePointer(p: number): PrPointer {
  const stride = pr.edict_size;
  return { ed: EDICT_NUM(Math.trunc(p / stride)), ofs: p % stride };
}

//=============================================================================

/*
=================
PR_PrintStatement
=================
*/
export function PR_PrintStatement(sIndex: number): void {
  const st = pr.statements;
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
    for (let i = 0; i < pr.functions.length; i++) {
      const f = pr.functions[i];
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

  prExec.depth = 0; // dump the stack so host_error can shutdown functions

  throw new PRRunError(string); // Host_Error ("Program error")
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
  if (prExec.depth <= 0) Sys_Error("prog stack underflow");

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
  if (!fnum || fnum >= pr.functions.length) {
    const gs = globalStruct();
    if (gs.self) prEdictMod().ED_Print(PROG_TO_EDICT(gs.self));
    throw new PRRunError("PR_ExecuteProgram: NULL function"); // Host_Error
  }

  const f = pr.functions[fnum];

  let runaway = 100000;
  prExec.trace = false;

  // make a stack frame
  const exitdepth = prExec.depth;

  let s = PR_EnterFunction(f);

  const stOp = pr.statements.op;
  const stA = pr.statements.a;
  const stB = pr.statements.b;
  const stC = pr.statements.c;
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

        const newf = pr.functions[gi[a]];

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
