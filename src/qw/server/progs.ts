/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/progs.h + QW/server/pr_comp.h (GNU GPL v2 or later).

progs.h -- QuakeWorld server's own progs VM header. PORTING.md's QuakeWorld
ruling ("The QW server is its own progs host") is what this module is: qwsv is
a standalone binary built from its own copy of pr_edict.c/pr_exec.c/pr_cmds.c,
with its own `pr_functions`/`pr_strings`/.../`pr_global_struct` externs (all
defined by its own pr_edict.c, never the WinQuake one -- one process runs
either the NQ server or the QW server, never both). `qwpr` below is that
separate progs state.

What is no longer separate is the *code*: `pr_comp.h` is byte-identical to
WinQuake's (checked: `diff` against ../qsrc/quake/WinQuake/pr_comp.h produces
no output), and so are `link_t`, `MAX_ENT_LEAFS`, `type_size[]` and the whole
`G_*`/`E_*`/`EDICT_*` accessor family. src/progs/progs_core.ts holds all of it
once over an explicit VM state, and this module is QuakeWorld's binding of it,
exactly as src/progs/progs.ts is WinQuake's. See progs_core.ts's header for
every deviation from the C.

Deviations this file adds, beyond progs_core.ts's:
- `QwEdictT` is the shared `EdictBaseT` plus QuakeWorld's own
  `entity_state_t baseline` (protocol.ts's `QwEntityStateT`, which carries
  `number` and `flags` and spells the skin field `skinnum`); the baseline is
  the only member of `edict_t` the two trees do not share.
- `EDICT_NUM`/`PROG_TO_EDICT`/`G_EDICT` narrow the core's `EdictBaseT` back to
  `QwEdictT` with `instanceof`, so qwsv's server code keeps the exact edict
  type it had.
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
  progs_core.ts's engine string table is the same shape (offset into the
  strings block, plus a separate engine-string index space) with three
  C-specific quirks this port does not reproduce: the table dedups by raw
  pointer identity, not string content (JS has no pointer identity for
  strings); the scan is off-by-one (`pr_strtbl[0]` is never populated); and
  the table index is *negative* in the C, which a float-view copy of the
  shared globals/entvars buffer would canonicalise into a NaN (see
  progs_core.ts's full derivation). `PR_SetString` below is the core's
  content-deduplicating `PR_SetEngineString`, and the `MAX_PRSTR - 1`
  usable-slot cap stays on `PR_SetStringRef`, which is the true `pr_strtbl`
  analogue:
  `num_prstr` counts only pointers *below* pr_strings (pr_exec.c:684's
  `if (s - pr_strings < 0)`) and dedups them by address, so in the C
  ED_NewString (hunk memory, above pr_strings, so a plain offset),
  PF_setmodel and PF_precache_* cost zero slots, while pr_string_temp and
  Info_ValueForKey's four rotating buffers cost one apiece -- about forty in
  total against the 1024 cap. A content-keyed table holds that whole
  population and would trip the cap on maps and mods the real qwsv runs
  indefinitely (PF_infokey's "ping" alone mints a fresh string per distinct
  value), so only the ref entries are capped.
  One consequence of the C storing a `char *` needs its own entry kind.
  SV_Spawn_f does `ent->v.netname = PR_SetString(host_client->name)`, and
  `host_client->name` is a char array *inside* client_t: SV_ExtractFromUserinfo
  later overwrites those same bytes, so every later `PR_GetString(netname)`
  reads the new name and QuakeC obituaries follow a rename with no further
  engine call. A JS string is a value, so `PR_SetStringRef(owner, get)` is
  that aliasing: the table entry holds the reader instead of a snapshot,
  `PR_GetString` calls it on resolve, and the entry dedups on `owner` identity
  the way the C's scan dedups on pointer identity (so repeated renames reuse
  one slot instead of consuming `MAX_PRSTR`).
  `PR_ClearEngineStrings` has no C name (num_prstr is just reset to 0 inline
  inside PR_LoadProgs) -- it is this port's reload hook.
*/

import type { Vec3 } from "../../common/mathlib";
import { SysError } from "../../platform/sys";
import type { FuncT, StringT } from "../../progs/pr_comp";
import {
  EdictBaseT,
  ENGINE_STRING_BASE,
  LinkT,
  MAX_ENT_LEAFS,
  ProgsStateT,
  TYPE_SIZE,
} from "../../progs/progs_core";
import * as core from "../../progs/progs_core";
import { QwEntVars } from "./progdefs";
import { QwEntityStateT } from "../protocol";

export { LinkT, MAX_ENT_LEAFS, TYPE_SIZE, ENGINE_STRING_BASE };

export class QwEdictT extends EdictBaseT {
  baseline: QwEntityStateT = new QwEntityStateT();

  constructor(index: number, entityfields: number) {
    super(index, entityfields, (f, i) => new QwEntVars(f, i));
  }
}

//============================================================================

// The qwsv `pr_*` externs, all defined by QW/server/pr_edict.c in the C; here
// one mutable singleton pr_edict.ts fills at PR_LoadProgs time and every
// reader below (and pr_exec.ts/pr_cmds.ts) reads through. It is also the
// QuakeWorld host profile's VM state (src/progs/profiles/qw.ts).
export const qwpr = new ProgsStateT();

//============================================================================
// edict table (stands in for `sv.edicts`, per progs_core.ts's EDICT_TO_PROG/
// PROG_TO_EDICT deviation note; src/qw/server/server.ts's `sv` singleton
// does not hold the live table itself, same split as the NQ port)

export function setEdictTable(edicts: QwEdictT[]): void {
  core.setEdictTable(qwpr, edicts);
}

function requireQwEdictT(ed: EdictBaseT): QwEdictT {
  if (!(ed instanceof QwEdictT)) throw new SysError("qw/server/progs.ts: edict is not a QwEdictT");
  return ed;
}

export function EDICT_NUM(n: number): QwEdictT {
  return requireQwEdictT(core.EDICT_NUM(qwpr, n));
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
  return core.G_FLOAT(qwpr, o);
}

export function G_INT(o: number): number {
  return core.G_INT(qwpr, o);
}

export function G_EDICT(o: number): QwEdictT {
  return requireQwEdictT(core.G_EDICT(qwpr, o));
}

export function G_EDICTNUM(o: number): number {
  return core.G_EDICTNUM(qwpr, o);
}

export function G_VECTOR(o: number): Vec3 {
  return core.G_VECTOR(qwpr, o);
}

export function G_STRING(o: number): string {
  return core.G_STRING(qwpr, o);
}

export function G_FUNCTION(o: number): FuncT {
  return core.G_FUNCTION(qwpr, o);
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
  return core.E_STRING(qwpr, ed, o);
}

export function RETURN_EDICT(e: QwEdictT): void {
  core.RETURN_EDICT(qwpr, e);
}

//============================================================================
// string_t resolution (see the file header's PR_GetString/PR_SetString note)

export const MAX_PRSTR = 1024;

export function PR_GetString(n: StringT): string {
  return core.PR_GetString(qwpr, n);
}

export function PR_SetString(s: string): StringT {
  return core.PR_SetEngineString(qwpr, s);
}

// The `char *` the C stores in pr_strtbl[] when that pointer aims at a buffer
// the engine keeps rewriting (client_t's `name`) -- see this file's header.
export function PR_SetStringRef(owner: object, get: () => string): StringT {
  if (core.PR_EngineStringCount(qwpr) >= MAX_PRSTR - 1) throw new SysError("PR_SetString: MAX_PRSTR");
  return core.PR_SetEngineStringRef(qwpr, owner, get);
}

export function PR_ClearEngineStrings(): void {
  core.PR_ClearEngineStrings(qwpr);
}

// QW's `int num_prstr` (pr_edict.c/pr_exec.c) has no function of its own in
// the C -- it is a plain global other files (sv_ccmds.c's SV_Status_f) read
// directly. This port keeps the count on the engine string table's length
// instead of a separate counter, so this accessor is that count's public read,
// named after the C global for callers outside this module.
export function num_prstr(): number {
  return core.PR_EngineStringCount(qwpr);
}
