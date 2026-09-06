/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/progs.h (GNU GPL v2 or later).

`edict_t`, `link_t`, `eval_t`, `MAX_ENT_LEAFS`, and the `G_*`/`E_*` accessor
macros pr_exec.ts and pr_cmds.ts read progs.dat bytecode through. The
`pr_*` extern globals (`pr_functions`, `pr_strings`, `pr_globaldefs`,
`pr_fielddefs`, `pr_statements`, `pr_global_struct`, `pr_globals`,
`pr_edict_size`, `pr_crc`) are defined in pr_edict.c in the C, so here they
are one mutable holder, `pr`, that pr_edict.ts (U021) fills at load time;
everything in this file reads through it rather than owning the data.

`ED_Alloc`/`ED_Free`/`ED_NewString`/`ED_Print`/`ED_Write`/`ED_ParseEdict`/
`ED_WriteGlobals`/`ED_ParseGlobals`/`ED_LoadFromFile`/`PR_Init`/
`PR_ExecuteProgram`/`PR_LoadProgs`/`PR_Profile_f`/`PR_RunError`/
`GetEdictFieldValue`/`ED_PrintEdicts`/`ED_PrintNum` are pr_edict.c's and
pr_exec.c's own functions (U021/U022) and are not declared here.
`pr_builtins`/`pr_numbuiltins`/`pr_argc`/`pr_trace`/`pr_xfunction`/
`pr_xstatement` are pr_exec.c/pr_cmds.c (U022/U023) execution state and are
not declared here either -- progs.h groups them with the rest of this file's
externs, but PORTING.md's module split puts them with the code that owns
them.

Deviations from the C source:
- `eval_t` is a C `union` (`string`/`_float`/`vector[3]`/`function`/`_int`/
  `edict` aliased over the same 4 (or 12) bytes) used only by
  `GetEdictFieldValue` (pr_edict.c) to hand back a raw field pointer typed
  by the caller's context. This port has no untyped-union equivalent and no
  pointer aliasing; every read goes through `E_FLOAT`/`E_INT`/`E_VECTOR`/
  `E_STRING` below, which read the same bytes through the `f`/`i` views
  directly. `eval_t` itself is not ported; `GetEdictFieldValue` (U021) will
  return a discriminated read instead.
- `EDICT_TO_PROG`/`PROG_TO_EDICT`: the C stores a byte offset from
  `sv.edicts`. PORTING.md's ruling for this VM stores the edict's array
  index instead (`EdictT.index`), so both functions below are index
  round-trips, not pointer arithmetic. The on-disk/savegame format is
  unaffected (`NUM_FOR_EDICT` is the value written either way).
- `EDICT_NUM`'s C range check is against `sv.max_edicts`, and
  `NUM_FOR_EDICT`'s is against `sv.num_edicts`; `sv` does not exist yet
  (server.ts is a later unit). `setEdictTable(edicts)` below lets pr_edict.ts
  register the live edict array; `EDICT_NUM` range-checks against its length,
  and `NUM_FOR_EDICT` is now a direct field read (`e.index`) since an
  `EdictT` reference is already known-valid by construction, so it needs no
  range check of its own.
- `string_t` (`char *pr_strings`, C pointer-difference engine strings like
  `host_client->name - pr_strings`) has no TS equivalent: this port ports
  PORTING.md's engine string table ruling here -- `PR_GetString(n)` resolves
  either a progs-string offset (`0 <= n < ENGINE_STRING_BASE`) or an engine
  string (`n >= ENGINE_STRING_BASE`, deduplicated by content) allocated
  through `PR_SetEngineString`/cleared by `PR_ClearEngineStrings`.
  Engine string indices are *positive* and based at `ENGINE_STRING_BASE`
  rather than negative (the ruling's original shape) because the globals and
  entvars blocks are one ArrayBuffer viewed as both Int32Array and
  Float32Array: every negative int32 in [-0x7FFFFF, -1] has all float32
  exponent bits set with a non-zero mantissa, i.e. it *is* a NaN bit pattern,
  and JavaScript does not preserve NaN payloads across a float read/write
  (`f[b] = f[a]` canonicalises to 0x7FC00000). qcc moves every builtin
  argument with `OP_STORE_V` -- a three-word float copy -- so a negative
  string_t passed to `setmodel`/`find`/`precache_sound` was destroyed on the
  way in (proven at pr_exec.ts's OP_STORE_V against retail doors.qc:
  `OP_LOAD_S self.model -> t`, `OP_STORE_V t -> OFS_PARM1`, `OP_CALL2
  setmodel`). `ENGINE_STRING_BASE` is above every progs string offset and
  below 0x7F800000, the first NaN bit pattern, so every string_t this port
  hands to progs is an ordinary finite float32 that round-trips a float copy
  exactly. This matches the C's own semantics: there the value is a plain
  integer nobody interprets as a float, and `pr_strings + n` is simply a
  pointer outside the loaded string block.
- `LinkT` gains an `owner: EdictT | QwEdictT | null` field with no C
  counterpart, so `STRUCT_FROM_LINK`/`EDICT_FROM_AREA(l)` become `l.owner` at
  call sites instead of pointer arithmetic (`common.h`'s `STRUCT_FROM_LINK`
  macro and `link_t` itself are ported once here rather than in a
  `common.ts`-owned header, because `edict_t.area`/`EDICT_FROM_AREA` are
  progs.h's only use of the type and no `LinkT` exists yet in model.ts or
  elsewhere -- reported as the ruling PORTING.md already calls for). QW's own
  progs host (src/qw/server/progs.ts) reuses this same `LinkT` for its own
  `QwEdictT.area` rather than declaring a second link type (PORTING.md: QW's
  `common.h`/`link_t` is identical to WinQuake's) -- `owner` is a union of
  both edict types so `QwEdictT`'s constructor can set `this.area.owner =
  this` the same way `EdictT`'s does (Task 3, 2026-09-05; QwEdictT used to
  leave `area.owner` null because this field was typed `EdictT | null` only).
  `QwEdictT` is reached with `import type` only (erased at runtime, so this
  creates no runtime edge / import cycle even though src/qw/server/progs.ts
  itself imports `LinkT` from this file).
*/

import type { Vec3 } from "../common/mathlib";
import { EntityStateT } from "../common/quakedef";
import { SysError } from "../platform/sys";
import { EtypeT, OFS_RETURN, type DdefT, type DfunctionT, type FuncT, type StringT } from "./pr_comp";
import { EntVars, GlobalVars } from "./progdefs";
import type { QwEdictT } from "../qw/server/progs";

// common.h's `link_t` (`struct link_s { struct link_s *prev, *next; }`),
// used for the doubly linked area lists in world.c and embedded in
// edict_t.area. `owner` is this port's STRUCT_FROM_LINK back-reference
// (see file header); it is null for the free-standing area-node sentinels
// world.c allocates, and set once by EdictT's (or QW's own QwEdictT's)
// constructor for edict.area.
export class LinkT {
  prev: LinkT | null = null;
  next: LinkT | null = null;
  owner: EdictT | QwEdictT | null = null;
}

export const MAX_ENT_LEAFS = 16;

export class EdictT {
  free = false;
  area: LinkT = new LinkT(); // linked to a division node or leaf

  num_leafs = 0;
  leafnums: Int16Array = new Int16Array(MAX_ENT_LEAFS);

  baseline: EntityStateT = new EntityStateT();

  freetime = 0; // sv.time when the object was freed

  // entvars_t (C-exported fields from progs) is the head of `fields`;
  // fields beyond it (QuakeC-declared) follow immediately, exactly as the
  // C's `// other fields from progs come immediately after` comment says --
  // here that means the rest of the same buffer, reached via E_FLOAT/E_INT/
  // E_VECTOR/E_STRING below instead of C's `edict_t` struct-tail layout.
  v: EntVars;
  fields: { f: Float32Array; i: Int32Array };

  index: number; // this edict's NUM_FOR_EDICT number

  constructor(index: number, entityfields: number) {
    this.index = index;
    const buffer = new ArrayBuffer(entityfields * 4);
    const f = new Float32Array(buffer);
    const i = new Int32Array(buffer);
    this.fields = { f, i };
    this.v = new EntVars(f, i);
    this.area.owner = this;
  }
}

// pr_edict.c's `type_size[8]`, indexed by etype_t; declared `extern int
// type_size[8]` in progs.h. sizeof(string_t)/sizeof(func_t)/sizeof(void*)
// are all 4 bytes on the 32-bit engine, i.e. 1 word, so every entry but
// ev_vector's 3 is 1.
export const TYPE_SIZE: readonly number[] = [1, 1, 1, 3, 1, 1, 1, 1];
if (TYPE_SIZE.length !== 8 || TYPE_SIZE[EtypeT.ev_vector] !== 3) {
  throw new SysError("progs.ts: TYPE_SIZE table is malformed");
}

//============================================================================

class ProgsState {
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
  global_struct: GlobalVars | null = null;
  edict_size = 0; // pr_edict_size, in bytes
  crc = 0; // pr_crc
}

// The `pr_*` externs of progs.h, all defined by pr_edict.c in the C; here
// one mutable singleton pr_edict.ts (U021) fills at PR_LoadProgs time and
// every reader below (and pr_exec.ts/pr_cmds.ts) reads through.
export const pr = new ProgsState();

function requireGlobals(): { f: Float32Array; i: Int32Array } {
  if (pr.globals === null) throw new SysError("progs.ts: pr.globals not set (PR_LoadProgs not called)");
  return pr.globals;
}

//============================================================================
// edict table (stands in for `sv.edicts`, per the EDICT_TO_PROG/PROG_TO_EDICT
// deviation note above; sv.ts does not exist yet)

let edictTable: EdictT[] | null = null;

export function setEdictTable(edicts: EdictT[]): void {
  edictTable = edicts;
}

function requireEdictTable(): EdictT[] {
  if (edictTable === null) throw new SysError("progs.ts: edict table not set (setEdictTable not called)");
  return edictTable;
}

export function EDICT_NUM(n: number): EdictT {
  const table = requireEdictTable();
  if (n < 0 || n >= table.length) throw new SysError(`EDICT_NUM: bad number ${n}`);
  return table[n];
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
  return requireGlobals().f[o];
}

export function G_INT(o: number): number {
  return requireGlobals().i[o];
}

export function G_EDICT(o: number): EdictT {
  return PROG_TO_EDICT(G_INT(o));
}

export function G_EDICTNUM(o: number): number {
  return NUM_FOR_EDICT(G_EDICT(o));
}

// Allocates a fresh `subarray` view every call -- the C macro is just
// pointer arithmetic (`&pr_globals[o]`), which has no allocation-free TS
// equivalent over a shared array; hot call sites in pr_cmds.ts (U023)
// should cache the view rather than call this per-instruction.
export function G_VECTOR(o: number): Vec3 {
  return requireGlobals().f.subarray(o, o + 3);
}

export function G_STRING(o: number): string {
  return PR_GetString(G_INT(o));
}

export function G_FUNCTION(o: number): FuncT {
  return G_INT(o);
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
  return PR_GetString(ed.fields.i[o]);
}

export function RETURN_EDICT(e: EdictT): void {
  requireGlobals().i[OFS_RETURN] = EDICT_TO_PROG(e);
}

//============================================================================
// string_t resolution (see file header's string_t deviation note)

// First engine-string index. Every progs-string offset is below it (the
// string block is a few tens of KB at most), and it is far below 0x7F800000,
// the smallest int32 whose float32 reinterpretation is a NaN -- so no
// string_t this module hands out can be canonicalised by a float-view copy
// of the shared globals/entvars buffer.
export const ENGINE_STRING_BASE = 0x40000000;

interface EngineStringRefT {
  readonly get: () => string;
}

const engineStrings: (string | EngineStringRefT)[] = [];
const engineStringIndex = new Map<string, number>();
const engineStringRefIndex = new Map<object, number>();

function readNulTerminated(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let s = "";
  for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function PR_GetString(n: StringT): string {
  if (n >= ENGINE_STRING_BASE) {
    const index = n - ENGINE_STRING_BASE;
    if (index >= engineStrings.length) throw new SysError(`PR_GetString: bad engine string index ${n}`);
    const entry = engineStrings[index];
    return typeof entry === "string" ? entry : entry.get();
  }
  if (n < 0) throw new SysError(`PR_GetString: bad string offset ${n}`);
  if (pr.strings === null) throw new SysError("PR_GetString: pr.strings not set (PR_LoadProgs not called)");
  if (n >= pr.strings.length) throw new SysError(`PR_GetString: bad string offset ${n}`);
  return readNulTerminated(pr.strings, n);
}

export function PR_SetEngineString(s: string): StringT {
  const existing = engineStringIndex.get(s);
  if (existing !== undefined) return existing;
  const index = ENGINE_STRING_BASE + engineStrings.length;
  if (index >= 0x7f800000) throw new SysError("PR_SetEngineString: engine string table overflow");
  engineStrings.push(s);
  engineStringIndex.set(s, index);
  return index;
}

// `host_client->name - pr_strings` (host_cmd.c:939, host_cmd.c:1311) and
// `pr_string_temp - pr_strings` (pr_cmds.c:934, pr_cmds.c:947) are pointers at
// engine buffers the engine keeps rewriting, so every later write to the buffer
// is what a QuakeC read of that string_t sees. A JS string is a value, so the
// pointer becomes a live getter, keyed on the owning object the way the C keys
// on the buffer's address. QW's progs.ts carries the same PR_SetStringRef.
export function PR_SetEngineStringRef(owner: object, get: () => string): StringT {
  const existing = engineStringRefIndex.get(owner);
  if (existing !== undefined) return existing;
  const index = ENGINE_STRING_BASE + engineStrings.length;
  if (index >= 0x7f800000) throw new SysError("PR_SetEngineString: engine string table overflow");
  engineStrings.push({ get });
  engineStringRefIndex.set(owner, index);
  return index;
}

export function PR_ClearEngineStrings(): void {
  engineStrings.length = 0;
  engineStringIndex.clear();
  engineStringRefIndex.clear();
}
