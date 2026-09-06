/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_edict.c (GNU GPL v2 or later).

sv_edict.c -- entity dictionary

Deviations from PORTING.md / the C source:
- The `pr_*` globals this file defines in C (`pr_functions`, `pr_strings`,
  `pr_globaldefs`, `pr_fielddefs`, `pr_statements`, `pr_global_struct`,
  `pr_globals`, `pr_edict_size`, `pr_crc`) already live on progs.ts's `pr`
  holder, which PR_LoadProgs below fills; only `dprograms_t *progs` has no
  slot there, so it stays here as `progs`. `progs->numglobaldefs` /
  `numfielddefs` / `numfunctions` are read as `pr.globaldefs.length` etc.,
  which are the same numbers.
- `pr_edict_size` is "in bytes" in the C because EDICT_NUM does pointer
  arithmetic over one flat `sv.edicts` block. This port's edicts are separate
  objects indexed by array position (progs.ts's EDICT_TO_PROG ruling), so the
  only remaining use of the value is the `progs->entityfields * 4` memset
  width in ED_ClearEdict/ED_ParseEdict. `pr.edict_size` therefore holds
  `progs->entityfields` -- the per-edict field count in *words*, which is
  what `EdictT`'s constructor and `fields.i.fill(0)` need.
- `eval_t` (the C union pr_edict.c hands around as `eval_t *`, i.e. a raw
  pointer to one global word or one edict field word) is not ported; see
  progs.ts's note. Every C site that builds one is `base + ofs`, so
  PR_ValueString/PR_UglyValueString/ED_ParseEpair take that pair directly:
  a `{ f: Float32Array; i: Int32Array }` view pair plus a word offset. The
  two callers pass `pr.globals` (pr_globals) or `ed.fields` (`&ed->v`),
  exactly as the C does.
- `GetEdictFieldValue` returns the field's word offset, or -1 when the field
  does not exist, instead of an `eval_t *`; callers read the word through
  E_FLOAT/E_INT/E_VECTOR/E_STRING (progs.ts). The two-entry lookup cache is
  kept as-is, including the C's caching of negative results.
- `ED_NewString` returns a `string_t` (PR_SetEngineString's engine string
  index, at or above progs.ts's `ENGINE_STRING_BASE`) rather than a `char *`
  into the hunk; ED_ParseEpair's
  `ED_NewString (s) - pr_strings` therefore becomes a plain assignment. This
  is PORTING.md's engine string table ruling.
- `ED_Write`/`ED_WriteGlobals` take a `TextFileWriter` (`{ write(s) }`)
  instead of a `FILE *`, matching cvar.ts's already-landed
  `Cvar_WriteVariables (f: { write(s: string): void })`. Output is byte for
  byte what `fprintf` produced.
- `ED_ParseEdict`/`ED_ParseGlobals`/`ED_LoadFromFile` take common.ts's
  `ParseState` instead of a `char *data`, and return void: the C's returned
  "new position" is `ps.index`. `com_token` becomes COM_Parse's return value;
  because COM_Parse returns null at end of data without touching com_token,
  the last non-null token is kept in a local so the C's
  `if (com_token[0] == '}') break;`-before-`if (!data)` order still holds.
- `deathmatch` is host.ts's cvar and `current_skill` is host_cmd.ts's
  `hostCmdState.current_skill`, exactly the C's globals.
- `PR_AllocEdicts` has no C counterpart: SV_SpawnServer's
  `sv.edicts = Hunk_AllocName (MAX_EDICTS*pr_edict_size, "edicts")` allocates
  one flat block that EDICT_NUM slices. Here the edict table is an array of
  `EdictT` objects, so building it -- and assigning `sv.edicts`/
  `sv.max_edicts` and registering the table with progs.ts's `setEdictTable`,
  which stands in for `sv.edicts` inside EDICT_NUM -- is one function
  SV_SpawnServer calls in that allocation's place.
- Little-endian only, per PORTING.md: PR_LoadProgs's five `LittleLong`/
  `LittleShort` byte-swap loops (header, statements, functions, globaldefs,
  fielddefs, globals) are dropped; pr_comp.ts's readers already decode
  little-endian. The fielddefs loop's `DEF_SAVEGLOBAL` Sys_Error is kept.
- PR_ValueString's `%5.1f` (ev_float) and `'%5.1f %5.1f %5.1f'` (ev_vector)
  round half away from zero, because Com_sprintf's %f is
  Number.prototype.toFixed; C's printf rounds half to even. They differ only
  when the float32 value is an exact tie at one decimal place (e.g. -12.25:
  C "-12.2", here "-12.3"). PR_ValueString feeds only ED_Print and
  PR_GlobalString (console debug output); the savegame writer goes through
  PR_UglyValueString's `%f`, where no float32 value can be an exact tie at
  six decimals (a tie needs a denominator with a factor of 5^6), so ED_Write
  output stays byte-identical.
- PR_ValueString's `ev_field` case dereferences ED_FieldAtOfs's result
  without a null check and segfaults when no field def has that offset;
  here that is a SysError naming the offset.
- `Host_Error ("ED_ParseGlobals: parse error")` / `Host_Error
  ("ED_ParseEdict: parse error")`: host.c is U035 and `HostError` does not
  exist yet. This unit follows pr_exec.ts's landed ruling for the same
  problem and throws its `PRRunError` with the C's message; host.ts catches
  it where it catches `HostError`, and the coordinator unifies the classes
  when host.ts lands.
- `PR_Profile_f` is pr_exec.c's (U022); PR_Init registers it from there.
*/

import { Q_atof, Q_atoi, COM_Parse, COM_LoadHunkFile, com_filesize, type ParseState } from "../common/common";
import { CRC_Init, CRC_ProcessByte } from "../common/crc";
import { VectorCopy, vec3_origin } from "../common/mathlib";
import { Cmd_AddCommand, Cmd_Argv } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import { deathmatch } from "../common/host";
import { hostCmdState } from "../common/host_cmd";
import { Com_sprintf } from "../common/sprintf";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { Sys_Error, SysError } from "../platform/sys";
import { MAX_EDICTS } from "../common/quakedef";
import {
  MOVETYPE_STEP,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_MEDIUM,
  sv,
  svs,
} from "../server/server";
import { SV_UnlinkEdict } from "../server/world";
import { PRRunError, PR_ExecuteProgram, PR_Profile_f } from "./pr_exec";
import {
  DEF_SAVEGLOBAL,
  EtypeT,
  PROG_VERSION,
  readDdef,
  readDfunction,
  readDprograms,
  readDstatement,
  DDEF_T_SIZE,
  DFUNCTION_T_SIZE,
  DSTATEMENT_T_SIZE,
  type DdefT,
  type DfunctionT,
  type DprogramsT,
  type StringT,
} from "./pr_comp";
import { GlobalVars, PROGHEADER_CRC } from "./progdefs";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  EdictT,
  G_INT,
  NUM_FOR_EDICT,
  PROG_TO_EDICT,
  PR_ClearEngineStrings,
  PR_GetString,
  PR_SetEngineString,
  TYPE_SIZE,
  pr,
  setEdictTable,
} from "./progs";

// dprograms_t *progs; the rest of pr_edict.c's `pr_*` globals live on
// progs.ts's `pr` holder (see file header).
export let progs: DprogramsT | null = null;

// one global word or one edict field word, addressed as `base + ofs` -- the
// C's `eval_t *` (see file header)
export interface ValueRef {
  f: Float32Array;
  i: Int32Array;
}

// `fprintf (f, ...)` destination for ED_Write/ED_WriteGlobals
export interface TextFileWriter {
  write(s: string): void;
}

export const nomonsters = new CvarT("nomonsters", "0");
export const gamecfg = new CvarT("gamecfg", "0");
export const scratch1 = new CvarT("scratch1", "0");
export const scratch2 = new CvarT("scratch2", "0");
export const scratch3 = new CvarT("scratch3", "0");
export const scratch4 = new CvarT("scratch4", "0");
export const savedgamecfg = new CvarT("savedgamecfg", "0", true);
export const saved1 = new CvarT("saved1", "0", true);
export const saved2 = new CvarT("saved2", "0", true);
export const saved3 = new CvarT("saved3", "0", true);
export const saved4 = new CvarT("saved4", "0", true);

const MAX_FIELD_LEN = 64;
const GEFV_CACHESIZE = 2;

class GefvCache {
  pcache: DdefT | null = null;
  field = "";
}

const gefvCache: GefvCache[] = [new GefvCache(), new GefvCache()];

function requireProgs(): DprogramsT {
  if (progs === null) throw new SysError("pr_edict.ts: progs not loaded (PR_LoadProgs not called)");
  return progs;
}

function requireGlobals(): ValueRef {
  if (pr.globals === null) throw new SysError("pr_edict.ts: pr.globals not set (PR_LoadProgs not called)");
  return pr.globals;
}

function requireGlobalStruct(): GlobalVars {
  if (pr.global_struct === null) {
    throw new SysError("pr_edict.ts: pr.global_struct not set (PR_LoadProgs not called)");
  }
  return pr.global_struct;
}

/*
=================
ED_ClearEdict

Sets everything to NULL
=================
*/
export function ED_ClearEdict(e: EdictT): void {
  e.fields.i.fill(0); // memset (&e->v, 0, progs->entityfields * 4)
  e.free = false;
}

/*
=================
ED_Alloc

Either finds a free edict, or allocates a new one.
Try to avoid reusing an entity that was recently freed, because it
can cause the client to think the entity morphed into something else
instead of being removed and recreated, which can cause interpolated
angles and bad trails.
=================
*/
export function ED_Alloc(): EdictT {
  let i: number;
  let e: EdictT;

  for (i = svs.maxclients + 1; i < sv.num_edicts; i++) {
    e = EDICT_NUM(i);
    // the first couple seconds of server time can involve a lot of
    // freeing and allocating, so relax the replacement policy
    if (e.free && (e.freetime < 2 || sv.time - e.freetime > 0.5)) {
      ED_ClearEdict(e);
      return e;
    }
  }

  if (i === MAX_EDICTS) Sys_Error("ED_Alloc: no free edicts");

  sv.num_edicts++;
  e = EDICT_NUM(i);
  ED_ClearEdict(e);

  return e;
}

/*
=================
ED_Free

Marks the edict as free
FIXME: walk all entities and NULL out references to this entity
=================
*/
export function ED_Free(ed: EdictT): void {
  SV_UnlinkEdict(ed); // unlink from world bsp

  ed.free = true;
  ed.v.model = 0;
  ed.v.takedamage = 0;
  ed.v.modelindex = 0;
  ed.v.colormap = 0;
  ed.v.skin = 0;
  ed.v.frame = 0;
  VectorCopy(vec3_origin, ed.v.origin);
  VectorCopy(vec3_origin, ed.v.angles);
  ed.v.nextthink = -1;
  ed.v.solid = 0;

  ed.freetime = sv.time;
}

//===========================================================================

/*
============
ED_GlobalAtOfs
============
*/
export function ED_GlobalAtOfs(ofs: number): DdefT | null {
  for (let i = 0; i < pr.globaldefs.length; i++) {
    const def = pr.globaldefs[i];
    if (def.ofs === ofs) return def;
  }
  return null;
}

/*
============
ED_FieldAtOfs
============
*/
export function ED_FieldAtOfs(ofs: number): DdefT | null {
  for (let i = 0; i < pr.fielddefs.length; i++) {
    const def = pr.fielddefs[i];
    if (def.ofs === ofs) return def;
  }
  return null;
}

/*
============
ED_FindField
============
*/
export function ED_FindField(name: string): DdefT | null {
  for (let i = 0; i < pr.fielddefs.length; i++) {
    const def = pr.fielddefs[i];
    if (PR_GetString(def.s_name) === name) return def;
  }
  return null;
}

/*
============
ED_FindGlobal
============
*/
export function ED_FindGlobal(name: string): DdefT | null {
  for (let i = 0; i < pr.globaldefs.length; i++) {
    const def = pr.globaldefs[i];
    if (PR_GetString(def.s_name) === name) return def;
  }
  return null;
}

/*
============
ED_FindFunction
============
*/
export function ED_FindFunction(name: string): DfunctionT | null {
  for (let i = 0; i < pr.functions.length; i++) {
    const func = pr.functions[i];
    if (PR_GetString(func.s_name) === name) return func;
  }
  return null;
}

// `func - pr_functions`, the func_t index PR_ExecuteProgram takes
function functionIndex(func: DfunctionT): number {
  return pr.functions.indexOf(func);
}

let gefvRep = 0; // static int rep = 0;

export function GetEdictFieldValue(ed: EdictT, field: string): number {
  let def: DdefT | null = null;
  let found = false;

  for (let i = 0; i < GEFV_CACHESIZE; i++) {
    if (field === gefvCache[i].field) {
      def = gefvCache[i].pcache;
      found = true;
      break; // goto Done
    }
  }

  if (!found) {
    def = ED_FindField(field);

    if (field.length < MAX_FIELD_LEN) {
      gefvCache[gefvRep].pcache = def;
      gefvCache[gefvRep].field = field;
      gefvRep ^= 1;
    }
  }

  if (def === null) return -1;

  return def.ofs;
}

/*
============
PR_ValueString

Returns a string describing *data in a type specific manner
=============
*/
export function PR_ValueString(type: number, base: ValueRef, ofs: number): string {
  let line: string;

  type &= ~DEF_SAVEGLOBAL;

  switch (type) {
    case EtypeT.ev_string:
      line = Com_sprintf("%s", PR_GetString(base.i[ofs]));
      break;
    case EtypeT.ev_entity:
      line = Com_sprintf("entity %i", NUM_FOR_EDICT(PROG_TO_EDICT(base.i[ofs])));
      break;
    case EtypeT.ev_function: {
      const f = pr.functions[base.i[ofs]];
      line = Com_sprintf("%s()", PR_GetString(f.s_name));
      break;
    }
    case EtypeT.ev_field: {
      const def = ED_FieldAtOfs(base.i[ofs]);
      if (def === null) throw new SysError(`PR_ValueString: no field def at ofs ${base.i[ofs]}`);
      line = Com_sprintf(".%s", PR_GetString(def.s_name));
      break;
    }
    case EtypeT.ev_void:
      line = "void";
      break;
    case EtypeT.ev_float:
      line = Com_sprintf("%5.1f", base.f[ofs]);
      break;
    case EtypeT.ev_vector:
      line = Com_sprintf("'%5.1f %5.1f %5.1f'", base.f[ofs], base.f[ofs + 1], base.f[ofs + 2]);
      break;
    case EtypeT.ev_pointer:
      line = "pointer";
      break;
    default:
      line = Com_sprintf("bad type %i", type);
      break;
  }

  return line;
}

// printf writes the sign of -0.0 ("-0.000000"); Number.prototype.toFixed,
// which Com_sprintf's %f uses, drops it. ED_Write reaches this case because
// its zero-field skip tests the raw bits, and -0.0f's bits are not zero.
function uglyFloat(value: number): string {
  const s = Com_sprintf("%f", value);
  return Object.is(value, -0) ? `-${s}` : s;
}

/*
============
PR_UglyValueString

Returns a string describing *data in a type specific manner
Easier to parse than PR_ValueString
=============
*/
export function PR_UglyValueString(type: number, base: ValueRef, ofs: number): string {
  let line: string;

  type &= ~DEF_SAVEGLOBAL;

  switch (type) {
    case EtypeT.ev_string:
      line = Com_sprintf("%s", PR_GetString(base.i[ofs]));
      break;
    case EtypeT.ev_entity:
      line = Com_sprintf("%i", NUM_FOR_EDICT(PROG_TO_EDICT(base.i[ofs])));
      break;
    case EtypeT.ev_function: {
      const f = pr.functions[base.i[ofs]];
      line = Com_sprintf("%s", PR_GetString(f.s_name));
      break;
    }
    case EtypeT.ev_field: {
      const def = ED_FieldAtOfs(base.i[ofs]);
      if (def === null) throw new SysError(`PR_UglyValueString: no field def at ofs ${base.i[ofs]}`);
      line = Com_sprintf("%s", PR_GetString(def.s_name));
      break;
    }
    case EtypeT.ev_void:
      line = "void";
      break;
    case EtypeT.ev_float:
      line = uglyFloat(base.f[ofs]);
      break;
    case EtypeT.ev_vector:
      line = `${uglyFloat(base.f[ofs])} ${uglyFloat(base.f[ofs + 1])} ${uglyFloat(base.f[ofs + 2])}`;
      break;
    default:
      line = Com_sprintf("bad type %i", type);
      break;
  }

  return line;
}

/*
============
PR_GlobalString

Returns a string with a description and the contents of a global,
padded to 20 field width
============
*/
export function PR_GlobalString(ofs: number): string {
  const globals = requireGlobals();
  let line: string;

  const def = ED_GlobalAtOfs(ofs);
  if (def === null) line = Com_sprintf("%i(???)", ofs);
  else {
    const s = PR_ValueString(def.type, globals, ofs);
    line = Com_sprintf("%i(%s)%s", ofs, PR_GetString(def.s_name), s);
  }

  let i = line.length;
  for (; i < 20; i++) line += " ";
  line += " ";

  return line;
}

export function PR_GlobalStringNoContents(ofs: number): string {
  let line: string;

  const def = ED_GlobalAtOfs(ofs);
  if (def === null) line = Com_sprintf("%i(???)", ofs);
  else line = Com_sprintf("%i(%s)", ofs, PR_GetString(def.s_name));

  let i = line.length;
  for (; i < 20; i++) line += " ";
  line += " ";

  return line;
}

/*
=============
ED_Print

For debugging
=============
*/
export function ED_Print(ed: EdictT): void {
  if (ed.free) {
    Con_Printf("FREE\n");
    return;
  }

  Con_Printf("\nEDICT %i:\n", NUM_FOR_EDICT(ed));
  for (let i = 1; i < pr.fielddefs.length; i++) {
    const d = pr.fielddefs[i];
    const name = PR_GetString(d.s_name);
    if (name[name.length - 2] === "_") continue; // skip _x, _y, _z vars

    const v = ed.fields.i;

    // if the value is still all 0, skip the field
    const type = d.type & ~DEF_SAVEGLOBAL;

    let j: number;
    for (j = 0; j < TYPE_SIZE[type]; j++) if (v[d.ofs + j]) break;
    if (j === TYPE_SIZE[type]) continue;

    Con_Printf("%s", name);
    let l = name.length;
    while (l++ < 15) Con_Printf(" ");

    Con_Printf("%s\n", PR_ValueString(d.type, ed.fields, d.ofs));
  }
}

/*
=============
ED_Write

For savegames
=============
*/
export function ED_Write(f: TextFileWriter, ed: EdictT): void {
  f.write("{\n");

  if (ed.free) {
    f.write("}\n");
    return;
  }

  for (let i = 1; i < pr.fielddefs.length; i++) {
    const d = pr.fielddefs[i];
    const name = PR_GetString(d.s_name);
    if (name[name.length - 2] === "_") continue; // skip _x, _y, _z vars

    const v = ed.fields.i;

    // if the value is still all 0, skip the field
    const type = d.type & ~DEF_SAVEGLOBAL;
    let j: number;
    for (j = 0; j < TYPE_SIZE[type]; j++) if (v[d.ofs + j]) break;
    if (j === TYPE_SIZE[type]) continue;

    f.write(Com_sprintf('"%s" ', name));
    f.write(Com_sprintf('"%s"\n', PR_UglyValueString(d.type, ed.fields, d.ofs)));
  }

  f.write("}\n");
}

export function ED_PrintNum(ent: number): void {
  ED_Print(EDICT_NUM(ent));
}

/*
=============
ED_PrintEdicts

For debugging, prints all the entities in the current server
=============
*/
export function ED_PrintEdicts(): void {
  Con_Printf("%i entities\n", sv.num_edicts);
  for (let i = 0; i < sv.num_edicts; i++) ED_PrintNum(i);
}

/*
=============
ED_PrintEdict_f

For debugging, prints a single edicy
=============
*/
export function ED_PrintEdict_f(): void {
  const i = Q_atoi(Cmd_Argv(1));
  if (i >= sv.num_edicts) {
    Con_Printf("Bad edict number\n");
    return;
  }
  ED_PrintNum(i);
}

/*
=============
ED_Count

For debugging
=============
*/
export function ED_Count(): void {
  let active = 0;
  let models = 0;
  let solid = 0;
  let step = 0;

  for (let i = 0; i < sv.num_edicts; i++) {
    const ent = EDICT_NUM(i);
    if (ent.free) continue;
    active++;
    if (ent.v.solid) solid++;
    if (ent.v.model) models++;
    if (ent.v.movetype === MOVETYPE_STEP) step++;
  }

  Con_Printf("num_edicts:%3i\n", sv.num_edicts);
  Con_Printf("active    :%3i\n", active);
  Con_Printf("view      :%3i\n", models);
  Con_Printf("touch     :%3i\n", solid);
  Con_Printf("step      :%3i\n", step);
}

/*
==============================================================================

					ARCHIVING GLOBALS

FIXME: need to tag constants, doesn't really work
==============================================================================
*/

/*
=============
ED_WriteGlobals
=============
*/
export function ED_WriteGlobals(f: TextFileWriter): void {
  const globals = requireGlobals();

  f.write("{\n");
  for (let i = 0; i < pr.globaldefs.length; i++) {
    const def = pr.globaldefs[i];
    let type = def.type;
    if (!(def.type & DEF_SAVEGLOBAL)) continue;
    type &= ~DEF_SAVEGLOBAL;

    if (type !== EtypeT.ev_string && type !== EtypeT.ev_float && type !== EtypeT.ev_entity) continue;

    const name = PR_GetString(def.s_name);
    f.write(Com_sprintf('"%s" ', name));
    f.write(Com_sprintf('"%s"\n', PR_UglyValueString(type, globals, def.ofs)));
  }
  f.write("}\n");
}

/*
=============
ED_ParseGlobals
=============
*/
export function ED_ParseGlobals(ps: ParseState): void {
  const globals = requireGlobals();
  let com_token = "";

  while (true) {
    // parse key
    let token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (com_token[0] === "}") break;
    if (token === null) Sys_Error("ED_ParseEntity: EOF without closing brace");

    const keyname = com_token;

    // parse value
    token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (token === null) Sys_Error("ED_ParseEntity: EOF without closing brace");

    if (com_token[0] === "}") Sys_Error("ED_ParseEntity: closing brace without data");

    const key = ED_FindGlobal(keyname);
    if (key === null) {
      Con_Printf("'%s' is not a global\n", keyname);
      continue;
    }

    if (!ED_ParseEpair(globals, key, com_token)) throw new PRRunError("ED_ParseGlobals: parse error");
  }
}

//============================================================================

/*
=============
ED_NewString
=============
*/
export function ED_NewString(string: string): StringT {
  const l = string.length + 1;
  let new_p = "";

  for (let i = 0; i < l; i++) {
    if (string[i] === "\\" && i < l - 1) {
      i++;
      if (string[i] === "n") new_p += "\n";
      else new_p += "\\";
    } else if (i < string.length) {
      new_p += string[i];
    }
  }

  return PR_SetEngineString(new_p);
}

/*
=============
ED_ParseEval

Can parse either fields or globals
returns false if error
=============
*/
export function ED_ParseEpair(base: ValueRef, key: DdefT, s: string): boolean {
  const d = key.ofs;

  switch (key.type & ~DEF_SAVEGLOBAL) {
    case EtypeT.ev_string:
      base.i[d] = ED_NewString(s);
      break;

    case EtypeT.ev_float:
      base.f[d] = Q_atof(s);
      break;

    case EtypeT.ev_vector: {
      let v = 0;
      let w = 0;
      for (let i = 0; i < 3; i++) {
        while (v < s.length && s[v] !== " ") v++;
        base.f[d + i] = Q_atof(s.slice(w, v));
        v = v + 1;
        w = v;
      }
      break;
    }

    case EtypeT.ev_entity:
      base.i[d] = EDICT_TO_PROG(EDICT_NUM(Q_atoi(s)));
      break;

    case EtypeT.ev_field: {
      const def = ED_FindField(s);
      if (def === null) {
        Con_Printf("Can't find field %s\n", s);
        return false;
      }
      // the C reads the *global* word at the field def's offset here, not
      // the offset itself; ported as written
      base.i[d] = G_INT(def.ofs);
      break;
    }

    case EtypeT.ev_function: {
      const func = ED_FindFunction(s);
      if (func === null) {
        Con_Printf("Can't find function %s\n", s);
        return false;
      }
      base.i[d] = functionIndex(func);
      break;
    }

    default:
      break;
  }
  return true;
}

/*
====================
ED_ParseEdict

Parses an edict out of the given string, returning the new position
ed should be a properly initialized empty edict.
Used for initial level load and for savegames.
====================
*/
export function ED_ParseEdict(ps: ParseState, ent: EdictT): void {
  let anglehack: boolean;
  let init = false;
  let com_token = "";

  // clear it
  if (ent !== sv.edicts[0]) ent.fields.i.fill(0); // hack

  // go through all the dictionary pairs
  while (true) {
    // parse key
    let token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (com_token[0] === "}") break;
    if (token === null) Sys_Error("ED_ParseEntity: EOF without closing brace");

    // anglehack is to allow QuakeEd to write single scalar angles
    // and allow them to be turned into vectors. (FIXME...)
    if (com_token === "angle") {
      com_token = "angles";
      anglehack = true;
    } else anglehack = false;

    // FIXME: change light to _light to get rid of this hack
    if (com_token === "light") com_token = "light_lev"; // hack for single light def

    let keyname = com_token;

    // another hack to fix heynames with trailing spaces
    let n = keyname.length;
    while (n && keyname[n - 1] === " ") {
      keyname = keyname.slice(0, n - 1);
      n--;
    }

    // parse value
    token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (token === null) Sys_Error("ED_ParseEntity: EOF without closing brace");

    if (com_token[0] === "}") Sys_Error("ED_ParseEntity: closing brace without data");

    init = true;

    // keynames with a leading underscore are used for utility comments,
    // and are immediately discarded by quake
    if (keyname[0] === "_") continue;

    const key = ED_FindField(keyname);
    if (key === null) {
      Con_Printf("'%s' is not a field\n", keyname);
      continue;
    }

    if (anglehack) {
      const temp = com_token;
      com_token = Com_sprintf("0 %s 0", temp);
    }

    if (!ED_ParseEpair(ent.fields, key, com_token)) throw new PRRunError("ED_ParseEdict: parse error");
  }

  if (!init) ent.free = true;
}

/*
================
ED_LoadFromFile

The entities are directly placed in the array, rather than allocated with
ED_Alloc, because otherwise an error loading the map would have entity
number references out of order.

Creates a server's entity / program execution context by
parsing textual entity definitions out of an ent file.

Used for both fresh maps and savegame loads.  A fresh map would also need
to call ED_CallSpawnFunctions () to let the objects initialize themselves.
================
*/
export function ED_LoadFromFile(ps: ParseState): void {
  let ent: EdictT | null = null;
  let inhibit = 0;
  const globalStruct = requireGlobalStruct();
  globalStruct.time = sv.time;

  // parse ents
  while (true) {
    // parse the opening brace
    const com_token = COM_Parse(ps);
    if (com_token === null) break;
    if (com_token[0] !== "{") Sys_Error("ED_LoadFromFile: found %s when expecting {", com_token);

    if (ent === null) ent = EDICT_NUM(0);
    else ent = ED_Alloc();
    ED_ParseEdict(ps, ent);

    // remove things from different skill levels or deathmatch
    const current_skill = hostCmdState.current_skill;
    if (deathmatch.value) {
      if ((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_DEATHMATCH) {
        ED_Free(ent);
        inhibit++;
        continue;
      }
    } else if (
      (current_skill === 0 && (ent.v.spawnflags | 0) & SPAWNFLAG_NOT_EASY) ||
      (current_skill === 1 && (ent.v.spawnflags | 0) & SPAWNFLAG_NOT_MEDIUM) ||
      (current_skill >= 2 && (ent.v.spawnflags | 0) & SPAWNFLAG_NOT_HARD)
    ) {
      ED_Free(ent);
      inhibit++;
      continue;
    }

    //
    // immediately call spawn function
    //
    if (!ent.v.classname) {
      Con_Printf("No classname for:\n");
      ED_Print(ent);
      ED_Free(ent);
      continue;
    }

    // look for the spawn function
    const func = ED_FindFunction(PR_GetString(ent.v.classname));

    if (func === null) {
      Con_Printf("No spawn function for:\n");
      ED_Print(ent);
      ED_Free(ent);
      continue;
    }

    globalStruct.self = EDICT_TO_PROG(ent);
    PR_ExecuteProgram(functionIndex(func));
  }

  Con_DPrintf("%i entities inhibited\n", inhibit);
}

/*
===============
PR_LoadProgs
===============
*/
export function PR_LoadProgs(): void {
  // flush the non-C variable lookup cache
  for (let i = 0; i < GEFV_CACHESIZE; i++) gefvCache[i].field = "";

  pr.crc = CRC_Init();

  const data = COM_LoadHunkFile("progs.dat");
  if (data === null) Sys_Error("PR_LoadProgs: couldn't load progs.dat");
  Con_DPrintf("Programs occupy %iK.\n", (com_filesize / 1024) | 0);

  for (let i = 0; i < com_filesize; i++) pr.crc = CRC_ProcessByte(pr.crc, data[i]);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = readDprograms(view, 0);
  progs = header;

  if (header.version !== PROG_VERSION) {
    Sys_Error("progs.dat has wrong version number (%i should be %i)", header.version, PROG_VERSION);
  }
  if (header.crc !== PROGHEADER_CRC) {
    Sys_Error("progs.dat system vars have been modified, progdefs.h is out of date");
  }

  PR_ClearEngineStrings();

  pr.functions = [];
  for (let i = 0; i < header.numfunctions; i++) {
    pr.functions.push(readDfunction(view, header.ofs_functions + i * DFUNCTION_T_SIZE));
  }
  pr.strings = data.subarray(header.ofs_strings);
  pr.globaldefs = [];
  for (let i = 0; i < header.numglobaldefs; i++) {
    pr.globaldefs.push(readDdef(view, header.ofs_globaldefs + i * DDEF_T_SIZE));
  }
  pr.fielddefs = [];
  for (let i = 0; i < header.numfielddefs; i++) {
    const def = readDdef(view, header.ofs_fielddefs + i * DDEF_T_SIZE);
    if (def.type & DEF_SAVEGLOBAL) Sys_Error("PR_LoadProgs: pr_fielddefs[i].type & DEF_SAVEGLOBAL");
    pr.fielddefs.push(def);
  }

  const statements = {
    op: new Int16Array(header.numstatements),
    a: new Int16Array(header.numstatements),
    b: new Int16Array(header.numstatements),
    c: new Int16Array(header.numstatements),
  };
  for (let i = 0; i < header.numstatements; i++) {
    const st = readDstatement(view, header.ofs_statements + i * DSTATEMENT_T_SIZE);
    statements.op[i] = st.op;
    statements.a[i] = st.a;
    statements.b[i] = st.b;
    statements.c[i] = st.c;
  }
  pr.statements = statements;

  // pr_globals is `pr_global_struct` seen as float[]; the C aliases the
  // loaded file image in place, which a DataView-parsed load cannot do
  // (alignment of ofs_globals within the file buffer is not guaranteed), so
  // the block is copied into its own ArrayBuffer here and the two views and
  // the globalvars_t accessor are built over that.
  const globalsBuffer = new ArrayBuffer(header.numglobals * 4);
  const globalBytes = new Uint8Array(globalsBuffer);
  globalBytes.set(data.subarray(header.ofs_globals, header.ofs_globals + header.numglobals * 4));
  const globals = { f: new Float32Array(globalsBuffer), i: new Int32Array(globalsBuffer) };
  pr.globals = globals;
  pr.global_struct = new GlobalVars(globals.f, globals.i);

  pr.edict_size = header.entityfields; // in words; see file header
}

/*
===============
PR_AllocEdicts

SV_SpawnServer's `sv.edicts = Hunk_AllocName (MAX_EDICTS*pr_edict_size,
"edicts")`, as an array of EdictT objects (see file header). Registers the
new table with progs.ts so EDICT_NUM/PROG_TO_EDICT resolve against it.
===============
*/
export function PR_AllocEdicts(max: number): EdictT[] {
  const edicts: EdictT[] = [];
  for (let i = 0; i < max; i++) edicts.push(new EdictT(i, pr.edict_size));
  sv.edicts = edicts;
  sv.max_edicts = max;
  setEdictTable(edicts);
  return edicts;
}

/*
===============
PR_Init
===============
*/
export function PR_Init(): void {
  Cmd_AddCommand("edict", ED_PrintEdict_f);
  Cmd_AddCommand("edicts", ED_PrintEdicts);
  Cmd_AddCommand("edictcount", ED_Count);
  Cmd_AddCommand("profile", PR_Profile_f);
  Cvar_RegisterVariable(nomonsters);
  Cvar_RegisterVariable(gamecfg);
  Cvar_RegisterVariable(scratch1);
  Cvar_RegisterVariable(scratch2);
  Cvar_RegisterVariable(scratch3);
  Cvar_RegisterVariable(scratch4);
  Cvar_RegisterVariable(savedgamecfg);
  Cvar_RegisterVariable(saved1);
  Cvar_RegisterVariable(saved2);
  Cvar_RegisterVariable(saved3);
  Cvar_RegisterVariable(saved4);
}

export { EDICT_NUM, NUM_FOR_EDICT };

// requireProgs is progs.h's `extern dprograms_t *progs` guard for callers
// that need the header after load (entityfields, numstrings, ...).
export function PR_Progs(): DprogramsT {
  return requireProgs();
}
