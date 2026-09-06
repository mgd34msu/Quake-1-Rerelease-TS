/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/progs.h + QW/server/pr_comp.h (GNU GPL v2 or later).

progs.h -- QuakeWorld server's own progs VM header. PORTING.md's QuakeWorld
ruling ("The QW server is its own progs host") and this unit's brief settle
the one open design question progs.h/pr_comp.h raise: qwsv is a standalone
binary built from its own copy of pr_edict.c/pr_exec.c/pr_cmds.c, with its own
`pr_functions`/`pr_strings`/.../`pr_global_struct` externs (all defined by its
own pr_edict.c, never the WinQuake one -- one process runs either the NQ
server or the QW server, never both). This module is that separate progs
state, `qwpr`, mirroring src/progs/progs.ts's `pr` mechanics field-for-field
but over QW's `QwGlobalVars`/`QwEntVars` (progdefs.ts, different offsets) and
QW's `entity_state_t` (protocol.ts, different shape). Q011 (pr_edict.ts for
qwsv) fills `qwpr` at load time and reads/writes edicts through the
EDICT_NUM-family functions below, exactly as src/progs/pr_edict.ts does
against src/progs/progs.ts's `pr`.

`pr_comp.h` is byte-identical to WinQuake's (checked: `diff` against
../qsrc/quake/WinQuake/pr_comp.h produces no output), so this module imports
its types (`DdefT`, `DfunctionT`, `FuncT`, `StringT`, `OFS_RETURN`) directly
from src/progs/pr_comp.ts rather than duplicating a second copy; Q011-Q016
should do the same rather than declaring a src/qw/server/pr_comp.ts that
would just re-export the same file. `LinkT` and `MAX_ENT_LEAFS` are likewise
identical (common.h's `link_t`/`STRUCT_FROM_LINK` and progs.h's
`#define MAX_ENT_LEAFS 16` are the same in both trees) and are re-exported
from src/progs/progs.ts below rather than redeclared.

Deviations from PORTING.md / the C source, beyond the ones src/progs/progs.ts
already documents for the mechanics this file duplicates (EDICT_TO_PROG/
PROG_TO_EDICT store an edict index, not a byte offset; `eval_t` is not
ported; G_VECTOR/E_VECTOR allocate a fresh subarray view per call):

- `QwEdictT.area` is a `LinkT` (re-exported from src/progs/progs.ts, see
  above). Its `owner` back-reference was typed `EdictT | null` there --
  NQ's edict type, not QW's -- until Task 3 (2026-09-05) widened it to
  `EdictT | QwEdictT | null` (a type-only `import type { QwEdictT }` in
  progs.ts, erased at runtime, so no runtime cycle even though this file
  imports the real `LinkT`/`MAX_ENT_LEAFS` values from there). `QwEdictT`'s
  constructor now sets `this.area.owner = this`, the same as `EdictT`'s does;
  a future QW world.ts's own `EDICT_FROM_AREA` needs a real (non-type-only)
  `import { QwEdictT }` to narrow with `instanceof QwEdictT` and `Sys_Error`
  on the other type, mirroring src/server/world.ts's own `EDICT_FROM_AREA`
  (which narrows with `instanceof EdictT` instead, never needing to name
  `QwEdictT` at all since a WinQuake-server `LinkT` is never given one).
- `eval_t GetEdictFieldValue`: not declared here for the same reason
  src/progs/progs.ts doesn't declare it -- it is pr_edict.c's own function
  (Q011), returning a field word offset instead of an `eval_t *` per that
  file's already-landed ruling.
- `string_t` / engine strings: QW's progs.h externs a *different* mechanism
  than WinQuake's pointer-difference one -- a bounded side table
  (`#define MAX_PRSTR 1024`, `char *pr_strtbl[MAX_PRSTR]`, `int num_prstr`)
  with its own named setter, `PR_SetString` (not `PR_SetEngineString`; QW's
  C really does call it that, unlike WinQuake which has no such function at
  all). Read from QW/server/pr_exec.c (where it's actually defined, not
  pr_edict.c despite progs.h's placement):
    char *PR_GetString(int num) {
      if (num < 0) return pr_strtbl[-num];
      return pr_strings + num;
    }
    int PR_SetString(char *s) {
      if (s - pr_strings < 0) {
        for (i = 0; i <= num_prstr; i++) if (pr_strtbl[i] == s) break;
        if (i < num_prstr) return -i;
        if (num_prstr == MAX_PRSTR - 1) Sys_Error("MAX_PRSTR");
        num_prstr++; pr_strtbl[num_prstr] = s;
        return -num_prstr;
      }
      return (int)(s - pr_strings);
    }
  This is the same shape as PORTING.md's string_t ruling (offset into the
  strings block, plus a separate engine-string table index space) with three
  C-specific quirks this port does not reproduce: the table dedups by
  raw pointer identity, not string content (JS has no pointer identity for
  strings, and two calls with equal content are the same value here); the
  scan is off-by-one (`pr_strtbl[0]` is never populated; `num_prstr`
  starts at 0 and is pre-incremented); and the table index is *negative* in
  the C. `PR_SetString` below dedups by content instead (a
  `Map<string, number>`, same as src/progs/progs.ts's `PR_SetEngineString`)
  and enforces the same `MAX_PRSTR - 1` usable-slot cap with a
  `SysError("PR_SetString: MAX_PRSTR")` in place of `Sys_Error`.
  The negative index does not survive this port. QW's C stores `-num_prstr`
  in `int`-typed union slots and never copies one through a float, but this
  port's globals and entvars are one ArrayBuffer viewed as both Int32Array
  and Float32Array, and qcc moves every builtin argument with `OP_STORE_V`
  -- a three-word float copy. Every negative int32 in [-0x7FFFFF, -1] is a
  float32 NaN bit pattern, and JavaScript does not preserve NaN payloads
  across a float read/write (`f[b] = f[a]` canonicalises to 0x7FC00000), so
  a negative string_t is destroyed in transit. Engine strings therefore get
  *positive* indices based at `ENGINE_STRING_BASE`, above every progs string
  offset and below 0x7F800000 (the first NaN bit pattern), exactly as
  src/progs/progs.ts does and for the same reason -- see that file's header
  for the full derivation and the retail-data proof.
  `PR_ClearEngineStrings` has no C name (num_prstr is just reset to 0 inline
  inside PR_LoadProgs) -- it is this port's reload hook, named to match
  src/progs/progs.ts's identical-purpose function.
  One consequence of the C storing a `char *` needs its own entry kind here.
  SV_Spawn_f does `ent->v.netname = PR_SetString(host_client->name)`, and
  `host_client->name` is a char array *inside* client_t: SV_ExtractFromUserinfo
  later overwrites those same bytes, so every later `PR_GetString(netname)`
  reads the new name and QuakeC obituaries follow a rename with no further
  engine call. A JS string is a value, so `PR_SetStringRef(owner, get)` below
  is that aliasing: the table entry holds the reader instead of a snapshot,
  `PR_GetString` calls it on resolve, and the entry dedups on `owner` identity
  the way the C's scan dedups on pointer identity (so repeated renames reuse
  one slot instead of consuming `MAX_PRSTR`).
- `TYPE_SIZE` (pr_edict.c's `type_size[8]`) is not re-declared: it is
  identical to src/progs/progs.ts's copy (both read the same pr_comp.h
  `etype_t`), and Q011 can import it from there directly.
*/

import type { Vec3 } from "../../common/mathlib";
import { SysError } from "../../platform/sys";
import { LinkT, MAX_ENT_LEAFS } from "../../progs/progs";
import { OFS_RETURN, type DdefT, type DfunctionT, type FuncT, type StringT } from "../../progs/pr_comp";
import { QwEntVars, QwGlobalVars } from "./progdefs";
import { QwEntityStateT } from "../protocol";

export { LinkT, MAX_ENT_LEAFS };

export class QwEdictT {
  free = false;
  area: LinkT = new LinkT(); // linked to a division node or leaf; owner set below

  num_leafs = 0;
  leafnums: Int16Array = new Int16Array(MAX_ENT_LEAFS);

  baseline: QwEntityStateT = new QwEntityStateT();

  freetime = 0; // sv.time when the object was freed

  // entvars_t (QW's own) is the head of `fields`; fields beyond it
  // (QuakeC-declared) follow immediately, same layout idiom as
  // src/progs/progs.ts's EdictT.
  v: QwEntVars;
  fields: { f: Float32Array; i: Int32Array };

  index: number; // this edict's NUM_FOR_EDICT number

  constructor(index: number, entityfields: number) {
    this.index = index;
    const buffer = new ArrayBuffer(entityfields * 4);
    const f = new Float32Array(buffer);
    const i = new Int32Array(buffer);
    this.fields = { f, i };
    this.v = new QwEntVars(f, i);
    this.area.owner = this;
  }
}

//============================================================================

class QwProgsState {
  functions: DfunctionT[] = [];
  strings: Uint8Array | null = null; // the raw string block; pr_strings was `char *`
  globaldefs: DdefT[] = [];
  fielddefs: DdefT[] = [];
  statements: { op: Int16Array; a: Int16Array; b: Int16Array; c: Int16Array } = {
    op: new Int16Array(0),
    a: new Int16Array(0),
    b: new Int16Array(0),
    c: new Int16Array(0),
  };
  globals: { f: Float32Array; i: Int32Array } | null = null; // same bytes as global_struct
  global_struct: QwGlobalVars | null = null;
  edict_size = 0; // pr_edict_size, in bytes
  crc = 0; // pr_crc
}

// The qwsv `pr_*` externs, all defined by QW/server/pr_edict.c in the C;
// here one mutable singleton Q011 fills at PR_LoadProgs time and every
// reader below (and Q012/Q013's pr_exec.ts/pr_cmds.ts) reads through.
export const qwpr = new QwProgsState();

function requireGlobals(): { f: Float32Array; i: Int32Array } {
  if (qwpr.globals === null) throw new SysError("qw/server/progs.ts: qwpr.globals not set (PR_LoadProgs not called)");
  return qwpr.globals;
}

//============================================================================
// edict table (stands in for `sv.edicts`, per progs.ts's EDICT_TO_PROG/
// PROG_TO_EDICT deviation note; src/qw/server/server.ts's `sv` singleton
// does not hold the live table itself, same split as the NQ port)

let edictTable: QwEdictT[] | null = null;

export function setEdictTable(edicts: QwEdictT[]): void {
  edictTable = edicts;
}

function requireEdictTable(): QwEdictT[] {
  if (edictTable === null) throw new SysError("qw/server/progs.ts: edict table not set (setEdictTable not called)");
  return edictTable;
}

export function EDICT_NUM(n: number): QwEdictT {
  const table = requireEdictTable();
  if (n < 0 || n >= table.length) throw new SysError(`EDICT_NUM: bad number ${n}`);
  return table[n];
}

export function NUM_FOR_EDICT(e: QwEdictT): number {
  return e.index;
}

export function PROG_TO_EDICT(n: number): QwEdictT {
  return EDICT_NUM(n);
}

export function EDICT_TO_PROG(e: QwEdictT): number {
  return e.index;
}

//============================================================================

export function G_FLOAT(o: number): number {
  return requireGlobals().f[o];
}

export function G_INT(o: number): number {
  return requireGlobals().i[o];
}

export function G_EDICT(o: number): QwEdictT {
  return PROG_TO_EDICT(G_INT(o));
}

export function G_EDICTNUM(o: number): number {
  return NUM_FOR_EDICT(G_EDICT(o));
}

// Allocates a fresh `subarray` view every call -- see src/progs/progs.ts's
// identical note; hot call sites in Q013's pr_cmds.ts should cache the view.
export function G_VECTOR(o: number): Vec3 {
  return requireGlobals().f.subarray(o, o + 3);
}

export function G_STRING(o: number): string {
  return PR_GetString(G_INT(o));
}

export function G_FUNCTION(o: number): FuncT {
  return G_INT(o);
}

export function E_FLOAT(ed: QwEdictT, o: number): number {
  return ed.fields.f[o];
}

export function E_INT(ed: QwEdictT, o: number): number {
  return ed.fields.i[o];
}

export function E_VECTOR(ed: QwEdictT, o: number): Vec3 {
  return ed.fields.f.subarray(o, o + 3);
}

export function E_STRING(ed: QwEdictT, o: number): string {
  return PR_GetString(ed.fields.i[o]);
}

export function RETURN_EDICT(e: QwEdictT): void {
  requireGlobals().i[OFS_RETURN] = EDICT_TO_PROG(e);
}

//============================================================================
// string_t resolution (see file header's PR_GetString/PR_SetString deviation
// note): `n` below `ENGINE_STRING_BASE` is an offset into `qwpr.strings`;
// `n` at or above it is an index into this module's own engine-string table,
// content-deduplicated instead of the C's pointer-identity scan, and
// positive rather than the C's `-num_prstr` so that a float-view copy of the
// shared globals/entvars buffer cannot canonicalise it into a NaN.

export const MAX_PRSTR = 1024;

// See src/progs/progs.ts's identically-named constant; the two hosts never
// run in the same process, but they share the hazard and the reasoning.
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
  if (qwpr.strings === null) throw new SysError("PR_GetString: qwpr.strings not set (PR_LoadProgs not called)");
  if (n >= qwpr.strings.length) throw new SysError(`PR_GetString: bad string offset ${n}`);
  return readNulTerminated(qwpr.strings, n);
}

export function PR_SetString(s: string): StringT {
  const existing = engineStringIndex.get(s);
  if (existing !== undefined) return existing;
  // No MAX_PRSTR guard here, deliberately. `num_prstr` counts only pointers
  // *below* pr_strings (pr_exec.c:684's `if (s - pr_strings < 0)`) and dedups
  // them by address, so in the C, ED_NewString (hunk memory, which sits above
  // pr_strings and so returns a plain offset), PF_setmodel and PF_precache_*
  // cost zero slots, while pr_string_temp and Info_ValueForKey's four rotating
  // buffers cost one apiece -- about forty in total against the 1024 cap. This
  // table is keyed on content, not address, so it holds that whole population
  // and would trip the cap on maps and mods the real qwsv runs indefinitely
  // (PF_infokey's "ping" alone mints a fresh string per distinct value). The
  // cap stays on PR_SetStringRef below, which is the true pr_strtbl analogue.
  const index = ENGINE_STRING_BASE + engineStrings.length;
  engineStrings.push(s);
  engineStringIndex.set(s, index);
  return index;
}

// The `char *` the C stores in pr_strtbl[] when that pointer aims at a buffer
// the engine keeps rewriting (client_t's `name`) -- see this file's header.
export function PR_SetStringRef(owner: object, get: () => string): StringT {
  const existing = engineStringRefIndex.get(owner);
  if (existing !== undefined) return existing;
  if (engineStrings.length >= MAX_PRSTR - 1) throw new SysError("PR_SetString: MAX_PRSTR");
  const index = ENGINE_STRING_BASE + engineStrings.length;
  engineStrings.push({ get });
  engineStringRefIndex.set(owner, index);
  return index;
}

export function PR_ClearEngineStrings(): void {
  engineStrings.length = 0;
  engineStringIndex.clear();
  engineStringRefIndex.clear();
}

// QW's `int num_prstr` (pr_edict.c/pr_exec.c) has no function of its own in
// the C -- it is a plain global other files (sv_ccmds.c's SV_Status_f) read
// directly. This port keeps the count on `engineStrings.length` instead of a
// separate counter (see file header), so this accessor is that count's
// public read, named after the C global for callers outside this module.
export function num_prstr(): number {
  return engineStrings.length;
}
