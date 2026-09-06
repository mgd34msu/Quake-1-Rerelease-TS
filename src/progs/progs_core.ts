/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/progs.h and QW/server/progs.h (GNU GPL v2 or later).

The one copy of progs.h's machinery, shared by both host profiles. WinQuake's
progs.h and QuakeWorld's differ only in the string_t mechanism they extern
(WinQuake stores engine strings as pointer differences from `pr_strings`; QW
keeps a bounded `pr_strtbl[MAX_PRSTR]` side table with its own `PR_SetString`)
and in the edict type each names; the `edict_t` header fields, `link_t`,
`MAX_ENT_LEAFS`, `type_size[]` and the whole `G_*`/`E_*`/`EDICT_*` accessor
family are identical in both trees. This module holds all of it once, over an
explicit `ProgsStateT` so the two hosts stay separate values rather than
separate copies of the code: src/progs/progs.ts binds it to WinQuake's `pr`
and `EdictT`, src/qw/server/progs.ts to QuakeWorld's `qwpr` and `QwEdictT`.

`ED_Alloc`/`ED_Free`/`ED_NewString`/`ED_Print`/`ED_Write`/`ED_ParseEdict`/
`ED_WriteGlobals`/`ED_ParseGlobals`/`ED_LoadFromFile`/`PR_Init`/
`PR_ExecuteProgram`/`PR_LoadProgs`/`PR_Profile_f`/`PR_RunError`/
`GetEdictFieldValue`/`ED_PrintEdicts`/`ED_PrintNum` are pr_edict.c's and
pr_exec.c's own functions and live in pr_edict_core.ts / pr_exec_core.ts.

Deviations from the C source:
- `eval_t` is a C `union` used only by `GetEdictFieldValue` to hand back a raw
  field pointer typed by the caller's context. This port has no untyped-union
  equivalent and no pointer aliasing; every read goes through
  `E_FLOAT`/`E_INT`/`E_VECTOR`/`E_STRING` below, which read the same bytes
  through the `f`/`i` views directly. `eval_t` itself is not ported;
  `GetEdictFieldValue` returns a field word offset instead.
- `EDICT_TO_PROG`/`PROG_TO_EDICT`: the C stores a byte offset from
  `sv.edicts`. PORTING.md's ruling for this VM stores the edict's array index
  instead (`EdictBaseT.index`), so both functions below are index round-trips,
  not pointer arithmetic. The on-disk/savegame format is unaffected
  (`NUM_FOR_EDICT` is the value written either way).
- `EDICT_NUM`'s C range check is against `sv.max_edicts` and
  `NUM_FOR_EDICT`'s against `sv.num_edicts`; here `setEdictTable` registers
  the live edict array on the state and `EDICT_NUM` range-checks against its
  length, while `NUM_FOR_EDICT` is a direct field read (`e.index`) since an
  `EdictBaseT` reference is already known-valid by construction.
- `string_t` (`char *pr_strings`, WinQuake's pointer-difference engine strings
  like `host_client->name - pr_strings`; QW's `pr_strtbl`/`num_prstr` side
  table) has no TS equivalent: `PR_GetString(state, n)` resolves either a
  progs-string offset (`0 <= n < ENGINE_STRING_BASE`) or an engine string
  (`n >= ENGINE_STRING_BASE`, deduplicated by content) allocated through
  `PR_SetEngineString`/cleared by `PR_ClearEngineStrings`.
  Engine string indices are *positive* and based at `ENGINE_STRING_BASE`
  rather than negative (both C mechanisms' original shape) because the globals
  and entvars blocks are one ArrayBuffer viewed as both Int32Array and
  Float32Array: every negative int32 in [-0x7FFFFF, -1] has all float32
  exponent bits set with a non-zero mantissa, i.e. it *is* a NaN bit pattern,
  and JavaScript does not preserve NaN payloads across a float read/write
  (`f[b] = f[a]` canonicalises to 0x7FC00000). qcc moves every builtin
  argument with `OP_STORE_V` -- a three-word float copy -- so a negative
  string_t passed to `setmodel`/`find`/`precache_sound` was destroyed on the
  way in (proven at pr_exec_core.ts's OP_STORE_V against retail doors.qc:
  `OP_LOAD_S self.model -> t`, `OP_STORE_V t -> OFS_PARM1`, `OP_CALL2
  setmodel`). `ENGINE_STRING_BASE` is above every progs string offset and
  below 0x7F800000, the first NaN bit pattern, so every string_t this port
  hands to progs is an ordinary finite float32 that round-trips a float copy
  exactly. This matches the C's own semantics: there the value is a plain
  integer nobody interprets as a float, and `pr_strings + n` is simply a
  pointer outside the loaded string block.
  QW's C dedups `pr_strtbl` by raw pointer identity, not string content; its
  scan is off-by-one (`pr_strtbl[0]` is never populated); and its cap is
  `MAX_PRSTR`. Content dedup replaces pointer dedup here (JS has no pointer
  identity for strings), and the cap stays on the *ref* entries, which are the
  true `pr_strtbl` analogue -- see src/qw/server/progs.ts.
- `PR_SetEngineStringRef`: `host_client->name - pr_strings` and
  `pr_string_temp - pr_strings` are pointers at engine buffers the engine
  keeps rewriting, so every later write to the buffer is what a QuakeC read of
  that string_t sees. A JS string is a value, so the pointer becomes a live
  getter, keyed on the owning object the way the C keys on the buffer's
  address.
- `LinkT` gains an `owner: EdictBaseT | null` field with no C counterpart, so
  `STRUCT_FROM_LINK`/`EDICT_FROM_AREA(l)` become `l.owner` at call sites
  instead of pointer arithmetic. `common.h`'s `STRUCT_FROM_LINK` macro and
  `link_t` itself are ported once here rather than in a `common.ts`-owned
  header, because `edict_t.area`/`EDICT_FROM_AREA` are progs.h's only use of
  the type. Both hosts' world.ts narrow `owner` back to their own edict class
  with `instanceof`.
- `edict_t` splits into `EdictBaseT` here and one subclass per host, because
  `edict_t.baseline` is `entity_state_t` -- a genuinely different struct in
  the two trees (QW's carries `number` and `flags` and spells the skin field
  `skinnum`). Everything else about the two edict types is identical and lives
  on the base.
- `ProgsStateT` is the C's `pr_functions`/`pr_strings`/`pr_globaldefs`/
  `pr_fielddefs`/`pr_statements`/`pr_global_struct`/`pr_globals`/
  `pr_edict_size`/`pr_crc` file-scope globals plus, below the divider, the
  rest of the per-host VM state the two C binaries each owned their own copy
  of (`pr_builtins`, `pr_argc` and the pr_exec.c stack, the GetEdictFieldValue
  cache, `sv.edicts`, the engine string table). One instance per host profile,
  so the WinQuake and QuakeWorld VMs stay as separate at runtime as the two C
  binaries were, while the code that walks them exists once.
- `pr_global_struct`'s accessor type is the *union* of the two hosts'
  `globalvars_t` fields (progdefs_layout.ts), since one state class cannot
  carry two field sets; reaching for a field the loaded layout does not
  declare throws there, naming the field.
*/

import type { Vec3 } from "../common/mathlib";
import { SysError } from "../platform/sys";
import { EtypeT, OFS_RETURN, type DdefT, type DfunctionT, type DprogramsT, type FuncT, type StringT } from "./pr_comp";
import type { ProgsEntVarsT, ProgsGlobalVarsT } from "./progdefs_layout";

// common.h's `link_t` (`struct link_s { struct link_s *prev, *next; }`),
// used for the doubly linked area lists in world.c and embedded in
// edict_t.area. `owner` is this port's STRUCT_FROM_LINK back-reference
// (see file header); it is null for the free-standing area-node sentinels
// world.c allocates, and set once by an edict's constructor for edict.area.
export class LinkT {
  prev: LinkT | null = null;
  next: LinkT | null = null;
  owner: EdictBaseT | null = null;
}

export const MAX_ENT_LEAFS = 16;

export class EdictBaseT {
  free = false;
  area: LinkT = new LinkT(); // linked to a division node or leaf

  num_leafs = 0;
  leafnums: Int16Array = new Int16Array(MAX_ENT_LEAFS);

  freetime = 0; // sv.time when the object was freed

  // johnfitz -- sv_phys.c's SV_RunThink/SV_Physics lerp-timing capture:
  // oldthinktime/oldframe are the thinktime/v.frame at the entity's last
  // think, and sendinterval is SV_Physics's per-frame gate for whether the
  // wire's U_LERPFINISH byte (nextthink - sv.time, scaled to 0-255) is worth
  // sending. All three are progs.h's edict_t fields, not QuakeC-visible.
  oldthinktime = 0;
  oldframe = 0;
  sendinterval = false;

  // entvars_t (C-exported fields from progs) is the head of `fields`;
  // fields beyond it (QuakeC-declared) follow immediately, exactly as the
  // C's `// other fields from progs come immediately after` comment says --
  // here that means the rest of the same buffer, reached via E_FLOAT/E_INT/
  // E_VECTOR/E_STRING below instead of C's `edict_t` struct-tail layout.
  v: ProgsEntVarsT;
  fields: { f: Float32Array; i: Int32Array };

  index: number; // this edict's NUM_FOR_EDICT number

  constructor(index: number, entityfields: number, makeVars: (f: Float32Array, i: Int32Array) => ProgsEntVarsT) {
    this.index = index;
    const buffer = new ArrayBuffer(entityfields * 4);
    const f = new Float32Array(buffer);
    const i = new Int32Array(buffer);
    this.fields = { f, i };
    this.v = makeVars(f, i);
    this.area.owner = this;
  }
}

// pr_edict.c's `type_size[8]`, indexed by etype_t; declared `extern int
// type_size[8]` in progs.h. sizeof(string_t)/sizeof(func_t)/sizeof(void*)
// are all 4 bytes on the 32-bit engine, i.e. 1 word, so every entry but
// ev_vector's 3 is 1.
export const TYPE_SIZE: readonly number[] = [1, 1, 1, 3, 1, 1, 1, 1];
if (TYPE_SIZE.length !== 8 || TYPE_SIZE[EtypeT.ev_vector] !== 3) {
  throw new SysError("progs_core.ts: TYPE_SIZE table is malformed");
}

// pr_cmds.c's `builtin_t`
export type BuiltinT = () => void;

//============================================================================

export interface EngineStringRefT {
  readonly get: () => string;
}

// pr_exec.c's `pr_stack[]` entries
export interface PrstackT {
  s: number;
  f: DfunctionT | null;
}

export const MAX_STACK_DEPTH = 32;
export const LOCALSTACK_SIZE = 2048;

// pr_exec.c's `pr_trace`/`pr_xfunction`/`pr_xstatement`/`pr_argc`/`pr_depth`.
// ES modules have no writable cross-module binding, so the five mutable ones
// live on one holder pr_cmds.ts mutates in place.
export interface PrExecStateT {
  trace: boolean; // pr_trace
  xfunction: DfunctionT | null; // pr_xfunction
  xstatement: number; // pr_xstatement
  argc: number; // pr_argc
  depth: number; // pr_depth
}

// pr_edict.c's `gefv_cache` entry
export class GefvCacheT {
  pcache: DdefT | null = null;
  field = "";
}

export const GEFV_CACHESIZE = 2;

export class ProgsStateT {
  functions: DfunctionT[] = [];
  strings: Uint8Array | null = null; // the raw string block; pr_strings was `char *`
  globaldefs: DdefT[] = [];
  fielddefs: DdefT[] = [];
  // dstatement_t's four fields as parallel arrays rather than an array of
  // small objects, per PORTING.md ("statements as four Int16Arrays (or one
  // interleaved)"): PR_ExecuteProgram's op-dispatch loop is the hottest path
  // in the VM and this avoids one object dereference per field per
  // instruction. `op` is `unsigned short` in the C; Int16Array holds it
  // exactly because no OP_* value exceeds 65.
  statements: { op: Int16Array; a: Int16Array; b: Int16Array; c: Int16Array } = {
    op: new Int16Array(0),
    a: new Int16Array(0),
    b: new Int16Array(0),
    c: new Int16Array(0),
  };
  globals: { f: Float32Array; i: Int32Array } | null = null; // same bytes as global_struct
  global_struct: ProgsGlobalVarsT | null = null;
  edict_size = 0; // pr_edict_size, in words (see pr_edict_core.ts)
  crc = 0; // pr_crc

  //--------------------------------------------------------------------------
  // the rest of the per-host VM state (see file header)

  progs: DprogramsT | null = null; // dprograms_t *progs

  // sv.edicts, registered by setEdictTable
  edicts: EdictBaseT[] | null = null;

  // the engine string table (see file header)
  engineStrings: (string | EngineStringRefT)[] = [];
  engineStringIndex = new Map<string, number>();
  engineStringRefIndex = new Map<object, number>();

  // pr_exec.c's execution state
  exec: PrExecStateT = { trace: false, xfunction: null, xstatement: 0, argc: 0, depth: 0 };
  // MAX_STACK_DEPTH + 1 entries: PR_StackTrace writes pr_stack[pr_depth], and
  // PR_EnterFunction calls PR_RunError (hence PR_StackTrace) with
  // pr_depth == MAX_STACK_DEPTH; in C that one write runs off the end of the
  // array, here it would be a store to `undefined`. The extra slot preserves
  // the observable behaviour of the overrun without the crash.
  stack: PrstackT[] = [];
  localstack: Int32Array = new Int32Array(LOCALSTACK_SIZE);
  localstack_used = 0;

  // pr_cmds.c's `builtin_t *pr_builtins` / `int pr_numbuiltins`, as installed
  // by setBuiltins (the numbered table) or rebuilt by PR_LoadProgs (the
  // numbered table plus the name-bound extension slots)
  builtins: BuiltinT[] = [];

  // pr_edict.c's GetEdictFieldValue lookup cache
  gefvCache: GefvCacheT[] = [new GefvCacheT(), new GefvCacheT()];
  gefvRep = 0; // static int rep = 0;

  // functions the profile asks to resolve by name after load, e.g.
  // QuakeWorld's SpectatorConnect/SpectatorThink/SpectatorDisconnect
  optional = new Map<string, FuncT>();

  constructor() {
    for (let i = 0; i <= MAX_STACK_DEPTH; i++) this.stack.push({ s: 0, f: null });
  }
}

function requireGlobals(state: ProgsStateT): { f: Float32Array; i: Int32Array } {
  if (state.globals === null) throw new SysError("progs_core.ts: pr.globals not set (PR_LoadProgs not called)");
  return state.globals;
}

export function requireGlobalStruct(state: ProgsStateT): ProgsGlobalVarsT {
  if (state.global_struct === null) {
    throw new SysError("progs_core.ts: pr.global_struct not set (PR_LoadProgs not called)");
  }
  return state.global_struct;
}

//============================================================================
// edict table (stands in for `sv.edicts`, per the EDICT_TO_PROG/PROG_TO_EDICT
// deviation note above)

export function setEdictTable(state: ProgsStateT, edicts: EdictBaseT[]): void {
  state.edicts = edicts;
}

function requireEdictTable(state: ProgsStateT): EdictBaseT[] {
  if (state.edicts === null) throw new SysError("progs_core.ts: edict table not set (setEdictTable not called)");
  return state.edicts;
}

export function EDICT_NUM(state: ProgsStateT, n: number): EdictBaseT {
  const table = requireEdictTable(state);
  if (n < 0 || n >= table.length) throw new SysError(`EDICT_NUM: bad number ${n}`);
  return table[n];
}

export function NUM_FOR_EDICT(e: EdictBaseT): number {
  return e.index;
}

export function PROG_TO_EDICT(state: ProgsStateT, n: number): EdictBaseT {
  return EDICT_NUM(state, n);
}

export function EDICT_TO_PROG(e: EdictBaseT): number {
  return e.index;
}

//============================================================================

export function G_FLOAT(state: ProgsStateT, o: number): number {
  return requireGlobals(state).f[o];
}

export function G_INT(state: ProgsStateT, o: number): number {
  return requireGlobals(state).i[o];
}

export function G_EDICT(state: ProgsStateT, o: number): EdictBaseT {
  return PROG_TO_EDICT(state, G_INT(state, o));
}

export function G_EDICTNUM(state: ProgsStateT, o: number): number {
  return NUM_FOR_EDICT(G_EDICT(state, o));
}

// Allocates a fresh `subarray` view every call -- the C macro is just
// pointer arithmetic (`&pr_globals[o]`), which has no allocation-free TS
// equivalent over a shared array; hot call sites in pr_cmds.ts should cache
// the view rather than call this per-instruction.
export function G_VECTOR(state: ProgsStateT, o: number): Vec3 {
  return requireGlobals(state).f.subarray(o, o + 3);
}

export function G_STRING(state: ProgsStateT, o: number): string {
  return PR_GetString(state, G_INT(state, o));
}

export function G_FUNCTION(state: ProgsStateT, o: number): FuncT {
  return G_INT(state, o);
}

export function E_FLOAT(ed: EdictBaseT, o: number): number {
  return ed.fields.f[o];
}

export function E_INT(ed: EdictBaseT, o: number): number {
  return ed.fields.i[o];
}

export function E_VECTOR(ed: EdictBaseT, o: number): Vec3 {
  return ed.fields.f.subarray(o, o + 3);
}

export function E_STRING(state: ProgsStateT, ed: EdictBaseT, o: number): string {
  return PR_GetString(state, ed.fields.i[o]);
}

export function RETURN_EDICT(state: ProgsStateT, e: EdictBaseT): void {
  requireGlobals(state).i[OFS_RETURN] = EDICT_TO_PROG(e);
}

//============================================================================
// string_t resolution (see file header's string_t deviation note)

// First engine-string index. Every progs-string offset is below it (the
// string block is a few tens of KB at most), and it is far below 0x7F800000,
// the smallest int32 whose float32 reinterpretation is a NaN -- so no
// string_t this module hands out can be canonicalised by a float-view copy
// of the shared globals/entvars buffer.
export const ENGINE_STRING_BASE = 0x40000000;

function readNulTerminated(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let s = "";
  for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function PR_GetString(state: ProgsStateT, n: StringT): string {
  if (n >= ENGINE_STRING_BASE) {
    const index = n - ENGINE_STRING_BASE;
    if (index >= state.engineStrings.length) throw new SysError(`PR_GetString: bad engine string index ${n}`);
    const entry = state.engineStrings[index];
    return typeof entry === "string" ? entry : entry.get();
  }
  if (n < 0) throw new SysError(`PR_GetString: bad string offset ${n}`);
  if (state.strings === null) throw new SysError("PR_GetString: pr.strings not set (PR_LoadProgs not called)");
  if (n >= state.strings.length) throw new SysError(`PR_GetString: bad string offset ${n}`);
  return readNulTerminated(state.strings, n);
}

export function PR_SetEngineString(state: ProgsStateT, s: string): StringT {
  const existing = state.engineStringIndex.get(s);
  if (existing !== undefined) return existing;
  const index = ENGINE_STRING_BASE + state.engineStrings.length;
  if (index >= 0x7f800000) throw new SysError("PR_SetEngineString: engine string table overflow");
  state.engineStrings.push(s);
  state.engineStringIndex.set(s, index);
  return index;
}

export function PR_SetEngineStringRef(state: ProgsStateT, owner: object, get: () => string): StringT {
  const existing = state.engineStringRefIndex.get(owner);
  if (existing !== undefined) return existing;
  const index = ENGINE_STRING_BASE + state.engineStrings.length;
  if (index >= 0x7f800000) throw new SysError("PR_SetEngineString: engine string table overflow");
  state.engineStrings.push({ get });
  state.engineStringRefIndex.set(owner, index);
  return index;
}

export function PR_ClearEngineStrings(state: ProgsStateT): void {
  state.engineStrings.length = 0;
  state.engineStringIndex.clear();
  state.engineStringRefIndex.clear();
}

// QW's `int num_prstr`, which sv_ccmds.c's SV_Status_f reads directly. This
// port keeps the count on the table's length instead of a separate counter.
export function PR_EngineStringCount(state: ProgsStateT): number {
  return state.engineStrings.length;
}
