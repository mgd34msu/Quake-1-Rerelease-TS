/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_edict.c and QW/server/pr_edict.c (GNU GPL v2 or later).

sv_edict.c -- entity dictionary

QuakeWorld's pr_edict.c is WinQuake's with a 171-line delta (`diff -w`).
Every one of those differences is a host-profile hook here, so the file exists
once:
  - `Sys_Error` becomes `SV_Error` (profile.sysError) and `Host_Error` becomes
    `SV_Error` (profile.hostError);
  - PR_Init registers WinQuake's eleven scratch/saved cvars and none of
    QuakeWorld's (profile.registerCvars);
  - ED_Alloc scans from `svs.maxclients+1` rather than `MAX_CLIENTS+1`
    (profile.edictAllocStart) and, with no edict left, WinQuake `Sys_Error`s
    while QuakeWorld warns, steps back onto the last edict and force-unlinks
    it (profile.allocOverflow);
  - ED_LoadFromFile filters by deathmatch *and* skill in WinQuake and by
    `SPAWNFLAG_NOT_DEATHMATCH` alone in QuakeWorld (profile.inhibitEntity),
    and calls `SV_FlushSignon` after every spawn function in QuakeWorld
    (profile.afterSpawnEntity);
  - PR_LoadProgs tries `qwprogs.dat` before `progs.dat` in QuakeWorld
    (profile.progsFiles), computes a whole-file `CRC_Block` for the `*progs`
    serverinfo key instead of WinQuake's byte-by-byte `pr_crc`
    (profile.loadChecksum), reports a bad system-defs CRC with its own message
    (profile.crcErrorMessage) and resolves `SpectatorConnect`/
    `SpectatorThink`/`SpectatorDisconnect` afterwards
    (profile.optionalFunctions);
  - ED_ParseEdict trims trailing spaces off a key name in WinQuake only
    (profile.parseKeyname);
  - ED_Print prints its own `"\nEDICT %i:\n"` header in WinQuake, while
    QuakeWorld moves that to ED_PrintEdicts' loop and gives ED_PrintEdict_f a
    differently worded one and no "Bad edict number" guard
    (profile.printEdictHeader / printEdictListHeader / beginEdictCommand).

Deviations from PORTING.md / the C source:
- The `pr_*` globals this file defines in C (`pr_functions`, `pr_strings`,
  `pr_globaldefs`, `pr_fielddefs`, `pr_statements`, `pr_global_struct`,
  `pr_globals`, `pr_edict_size`, `pr_crc`, and `dprograms_t *progs`) live on
  progs_core.ts's `ProgsStateT`, one instance per host profile, which
  PR_LoadProgs below fills. `progs->numglobaldefs`/`numfielddefs`/
  `numfunctions` are read as `state.globaldefs.length` etc., the same numbers.
- `pr_edict_size` is "in bytes" in the C because EDICT_NUM does pointer
  arithmetic over one flat `sv.edicts` block. This port's edicts are separate
  objects indexed by array position (progs_core.ts's EDICT_TO_PROG ruling), so
  the only remaining use of the value is the `progs->entityfields * 4` memset
  width in ED_ClearEdict/ED_ParseEdict and pr_exec_core.ts's pointer stride.
  `state.edict_size` therefore holds `progs->entityfields` -- the per-edict
  field count in *words*. (QW's C adds `sizeof(edict_t) - sizeof(entvars_t)`
  to its own value; that is a C-only byte offset for pointer arithmetic this
  port does not do, and only the stride's self-consistency matters.)
- `eval_t` (the C union pr_edict.c hands around as `eval_t *`, i.e. a raw
  pointer to one global word or one edict field word) is not ported; see
  progs_core.ts's note. Every C site that builds one is `base + ofs`, so
  PR_ValueString/PR_UglyValueString/ED_ParseEpair take that pair directly:
  a `{ f: Float32Array; i: Int32Array }` view pair plus a word offset. The
  two callers pass `state.globals` (pr_globals) or `ed.fields` (`&ed->v`),
  exactly as the C does.
- `GetEdictFieldValue` returns the field's word offset, or -1 when the field
  does not exist, instead of an `eval_t *`; callers read the word through
  E_FLOAT/E_INT/E_VECTOR/E_STRING (progs_core.ts). The two-entry lookup cache
  is kept as-is, including the C's caching of negative results.
- `ED_NewString` returns a `string_t` (the engine string index, at or above
  progs_core.ts's `ENGINE_STRING_BASE`) rather than a `char *` into the hunk;
  ED_ParseEpair's `ED_NewString (s) - pr_strings` therefore becomes a plain
  assignment. WinQuake's C has no `PR_SetString` at all and QW's does this
  conversion at the call site; both collapse to the same thing here.
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
- `COM_LoadHunkFile` is a different function in the two trees (WinQuake's
  filesystem and QuakeWorld's are separate ports), so PR_LoadProgs reads the
  file through `profile.loadProgsFile`; `com_filesize` is one shared live
  binding in src/common/common.ts, which QW's own common.ts re-exports and
  writes through `setComFilesize`, so it is read directly here.
- `PR_AllocEdicts` has no C counterpart: SV_SpawnServer's
  `sv.edicts = Hunk_AllocName (MAX_EDICTS*pr_edict_size, "edicts")` allocates
  one flat block that EDICT_NUM slices. Here the edict table is an array of
  edict objects, so building it -- and assigning `sv.edicts`/`sv.max_edicts`
  -- is `profile.allocEdicts`, which this function calls in that allocation's
  place before registering the table with progs_core.ts's `setEdictTable`.
- Little-endian only, per PORTING.md: PR_LoadProgs's five `LittleLong`/
  `LittleShort` byte-swap loops are dropped; pr_comp.ts's readers already
  decode little-endian. The fielddefs loop's `DEF_SAVEGLOBAL` error is kept.
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
- `PR_Profile_f` is pr_exec.c's; PR_Init registers it from there.

Additions (no C counterpart; ARCHITECTURE.md's "Core model"):
- After load, every function whose `first_statement`, `parm_start` and
  `locals` are all zero is looked up by name in `profile.namedBuiltins` and
  bound by setting `first_statement` to the negative index of a slot appended
  after the numbered builtin table -- Ironwail's PR_InitBuiltins
  (Quake/pr_edict.c:1858-1900) does the same remap for the re-release progs'
  `= #0:ex_name` builtins. Ironwail leaves an unmatched name at
  `first_statement == 0`, where calling it silently executes whatever
  statement sits at index 0; here an unmatched name is bound to a builtin that
  raises `PR_RunError` naming the function, so a missing extension fails
  loudly. Functions with an empty name are skipped, which is how the null
  function at index 0 (all-zero by construction in every progs.dat) stays
  untouched.
- `checkextension` is installed at builtin 99 and answers from
  `profile.extensions`. The numbered table is padded up to that slot with a
  builtin that raises the C's own "Bad builtin call number", so calling an
  unassigned number below 99 still fails exactly as `i >= pr_numbuiltins` did.
*/

import { Q_atof, Q_atoi, COM_Parse, com_filesize, type ParseState } from "../common/common";
import { VectorCopy, vec3_origin } from "../common/mathlib";
import { Cmd_AddCommand, Cmd_Argv } from "../common/cmd";
import { Com_sprintf } from "../common/sprintf";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { SysError } from "../platform/sys";
import {
  DEF_SAVEGLOBAL,
  EtypeT,
  OFS_PARM0,
  OFS_RETURN,
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
  type FuncT,
  type StringT,
} from "./pr_comp";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  GEFV_CACHESIZE,
  G_INT,
  NUM_FOR_EDICT,
  PROG_TO_EDICT,
  PR_ClearEngineStrings,
  PR_GetString,
  PR_SetEngineString,
  TYPE_SIZE,
  requireGlobalStruct,
  setEdictTable,
  type BuiltinT,
  type EdictBaseT,
  type ProgsStateT,
} from "./progs_core";
import { PR_ActiveProfile, PR_ActiveState, type ProgsProfileT } from "./profiles/profile";
import { PR_ExecuteProgram, PR_Profile_f, PR_RunError } from "./pr_exec_core";

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

const MAX_FIELD_LEN = 64;

// `checkextension` is builtin 99 in every engine that has it (Ironwail,
// vkQuake, QuakeSpasm), and the re-release progs ask for it there.
export const CHECKEXTENSION_BUILTIN = 99;

function requireProgs(state: ProgsStateT): DprogramsT {
  if (state.progs === null) throw new SysError("pr_edict.ts: progs not loaded (PR_LoadProgs not called)");
  return state.progs;
}

function requireGlobals(state: ProgsStateT): ValueRef {
  if (state.globals === null) throw new SysError("pr_edict.ts: pr.globals not set (PR_LoadProgs not called)");
  return state.globals;
}

/*
=================
ED_ClearEdict

Sets everything to NULL
=================
*/
export function ED_ClearEdict(e: EdictBaseT): void {
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
export function ED_Alloc(): EdictBaseT {
  const profile = PR_ActiveProfile();
  const state = profile.state;
  let i: number;
  let e: EdictBaseT;

  const num_edicts = profile.numEdicts();
  const time = profile.serverTime();
  for (i = profile.edictAllocStart(); i < num_edicts; i++) {
    e = EDICT_NUM(state, i);
    // the first couple seconds of server time can involve a lot of
    // freeing and allocating, so relax the replacement policy
    if (e.free && (e.freetime < 2 || time - e.freetime > 0.5)) {
      ED_ClearEdict(e);
      return e;
    }
  }

  if (i === profile.maxEdicts) i = profile.allocOverflow(i);
  else profile.setNumEdicts(num_edicts + 1);

  e = EDICT_NUM(state, i);
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
export function ED_Free(ed: EdictBaseT): void {
  const profile = PR_ActiveProfile();
  profile.unlinkEdict(ed); // unlink from world bsp

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

  ed.freetime = profile.serverTime();
}

//===========================================================================

/*
============
ED_GlobalAtOfs
============
*/
export function ED_GlobalAtOfs(ofs: number): DdefT | null {
  const state = PR_ActiveState();
  for (let i = 0; i < state.globaldefs.length; i++) {
    const def = state.globaldefs[i];
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
  const state = PR_ActiveState();
  for (let i = 0; i < state.fielddefs.length; i++) {
    const def = state.fielddefs[i];
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
  const state = PR_ActiveState();
  for (let i = 0; i < state.fielddefs.length; i++) {
    const def = state.fielddefs[i];
    if (PR_GetString(state, def.s_name) === name) return def;
  }
  return null;
}

/*
============
ED_FindGlobal
============
*/
export function ED_FindGlobal(name: string): DdefT | null {
  const state = PR_ActiveState();
  for (let i = 0; i < state.globaldefs.length; i++) {
    const def = state.globaldefs[i];
    if (PR_GetString(state, def.s_name) === name) return def;
  }
  return null;
}

/*
============
ED_FindFunction
============
*/
export function ED_FindFunction(name: string): DfunctionT | null {
  const state = PR_ActiveState();
  for (let i = 0; i < state.functions.length; i++) {
    const func = state.functions[i];
    if (PR_GetString(state, func.s_name) === name) return func;
  }
  return null;
}

// `func - pr_functions`, the func_t index PR_ExecuteProgram takes
export function functionIndex(func: DfunctionT): number {
  return PR_ActiveState().functions.indexOf(func);
}

export function GetEdictFieldValue(ed: EdictBaseT, field: string): number {
  const state = PR_ActiveState();
  let def: DdefT | null = null;
  let found = false;

  for (let i = 0; i < GEFV_CACHESIZE; i++) {
    if (field === state.gefvCache[i].field) {
      def = state.gefvCache[i].pcache;
      found = true;
      break; // goto Done
    }
  }

  if (!found) {
    def = ED_FindField(field);

    if (field.length < MAX_FIELD_LEN) {
      state.gefvCache[state.gefvRep].pcache = def;
      state.gefvCache[state.gefvRep].field = field;
      state.gefvRep ^= 1;
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
  const state = PR_ActiveState();
  let line: string;

  type &= ~DEF_SAVEGLOBAL;

  switch (type) {
    case EtypeT.ev_string:
      line = Com_sprintf("%s", PR_GetString(state, base.i[ofs]));
      break;
    case EtypeT.ev_entity:
      line = Com_sprintf("entity %i", NUM_FOR_EDICT(PROG_TO_EDICT(state, base.i[ofs])));
      break;
    case EtypeT.ev_function: {
      const f = state.functions[base.i[ofs]];
      line = Com_sprintf("%s()", PR_GetString(state, f.s_name));
      break;
    }
    case EtypeT.ev_field: {
      const def = ED_FieldAtOfs(base.i[ofs]);
      if (def === null) throw new SysError(`PR_ValueString: no field def at ofs ${base.i[ofs]}`);
      line = Com_sprintf(".%s", PR_GetString(state, def.s_name));
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
  const state = PR_ActiveState();
  let line: string;

  type &= ~DEF_SAVEGLOBAL;

  switch (type) {
    case EtypeT.ev_string:
      line = Com_sprintf("%s", PR_GetString(state, base.i[ofs]));
      break;
    case EtypeT.ev_entity:
      line = Com_sprintf("%i", NUM_FOR_EDICT(PROG_TO_EDICT(state, base.i[ofs])));
      break;
    case EtypeT.ev_function: {
      const f = state.functions[base.i[ofs]];
      line = Com_sprintf("%s", PR_GetString(state, f.s_name));
      break;
    }
    case EtypeT.ev_field: {
      const def = ED_FieldAtOfs(base.i[ofs]);
      if (def === null) throw new SysError(`PR_UglyValueString: no field def at ofs ${base.i[ofs]}`);
      line = Com_sprintf("%s", PR_GetString(state, def.s_name));
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
  const state = PR_ActiveState();
  const globals = requireGlobals(state);
  let line: string;

  const def = ED_GlobalAtOfs(ofs);
  if (def === null) line = Com_sprintf("%i(???)", ofs);
  else {
    const s = PR_ValueString(def.type, globals, ofs);
    line = Com_sprintf("%i(%s)%s", ofs, PR_GetString(state, def.s_name), s);
  }

  let i = line.length;
  for (; i < 20; i++) line += " ";
  line += " ";

  return line;
}

export function PR_GlobalStringNoContents(ofs: number): string {
  const state = PR_ActiveState();
  let line: string;

  const def = ED_GlobalAtOfs(ofs);
  if (def === null) line = Com_sprintf("%i(???)", ofs);
  else line = Com_sprintf("%i(%s)", ofs, PR_GetString(state, def.s_name));

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
export function ED_Print(ed: EdictBaseT): void {
  const profile = PR_ActiveProfile();
  const state = profile.state;

  if (ed.free) {
    Con_Printf("FREE\n");
    return;
  }

  profile.printEdictHeader(NUM_FOR_EDICT(ed));
  for (let i = 1; i < state.fielddefs.length; i++) {
    const d = state.fielddefs[i];
    const name = PR_GetString(state, d.s_name);
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
export function ED_Write(f: TextFileWriter, ed: EdictBaseT): void {
  const state = PR_ActiveState();

  f.write("{\n");

  if (ed.free) {
    f.write("}\n");
    return;
  }

  for (let i = 1; i < state.fielddefs.length; i++) {
    const d = state.fielddefs[i];
    const name = PR_GetString(state, d.s_name);
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
  ED_Print(EDICT_NUM(PR_ActiveState(), ent));
}

/*
=============
ED_PrintEdicts

For debugging, prints all the entities in the current server
=============
*/
export function ED_PrintEdicts(): void {
  const profile = PR_ActiveProfile();
  const num_edicts = profile.numEdicts();
  Con_Printf("%i entities\n", num_edicts);
  for (let i = 0; i < num_edicts; i++) {
    profile.printEdictListHeader(i);
    ED_PrintNum(i);
  }
}

/*
=============
ED_PrintEdict_f

For debugging, prints a single edicy
=============
*/
export function ED_PrintEdict_f(): void {
  const profile = PR_ActiveProfile();
  const i = Q_atoi(Cmd_Argv(1));
  if (!profile.beginEdictCommand(i)) return;
  ED_PrintNum(i);
}

/*
=============
ED_Count

For debugging
=============
*/
export function ED_Count(): void {
  const profile = PR_ActiveProfile();
  const state = profile.state;
  let active = 0;
  let models = 0;
  let solid = 0;
  let step = 0;

  const num_edicts = profile.numEdicts();
  for (let i = 0; i < num_edicts; i++) {
    const ent = EDICT_NUM(state, i);
    if (ent.free) continue;
    active++;
    if (ent.v.solid) solid++;
    if (ent.v.model) models++;
    if (ent.v.movetype === profile.movetypeStep) step++;
  }

  Con_Printf("num_edicts:%3i\n", num_edicts);
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
  const state = PR_ActiveState();
  const globals = requireGlobals(state);

  f.write("{\n");
  for (let i = 0; i < state.globaldefs.length; i++) {
    const def = state.globaldefs[i];
    let type = def.type;
    if (!(def.type & DEF_SAVEGLOBAL)) continue;
    type &= ~DEF_SAVEGLOBAL;

    if (type !== EtypeT.ev_string && type !== EtypeT.ev_float && type !== EtypeT.ev_entity) continue;

    const name = PR_GetString(state, def.s_name);
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
  const profile = PR_ActiveProfile();
  const globals = requireGlobals(profile.state);
  let com_token = "";

  while (true) {
    // parse key
    let token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (com_token[0] === "}") break;
    if (token === null) profile.sysError("ED_ParseEntity: EOF without closing brace");

    const keyname = com_token;

    // parse value
    token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (token === null) profile.sysError("ED_ParseEntity: EOF without closing brace");

    if (com_token[0] === "}") profile.sysError("ED_ParseEntity: closing brace without data");

    const key = ED_FindGlobal(keyname);
    if (key === null) {
      const q = profile.unknownKeyQuote;
      Con_Printf("%s is not a global\n", q + keyname + q);
      continue;
    }

    if (!ED_ParseEpair(globals, key, com_token)) profile.hostError("ED_ParseGlobals: parse error");
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

  return PR_SetEngineString(PR_ActiveState(), new_p);
}

/*
=============
ED_ParseEval

Can parse either fields or globals
returns false if error
=============
*/
export function ED_ParseEpair(base: ValueRef, key: DdefT, s: string): boolean {
  const state = PR_ActiveState();
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
      base.i[d] = EDICT_TO_PROG(EDICT_NUM(state, Q_atoi(s)));
      break;

    case EtypeT.ev_field: {
      const def = ED_FindField(s);
      if (def === null) {
        Con_Printf("Can't find field %s\n", s);
        return false;
      }
      // the C reads the *global* word at the field def's offset here, not
      // the offset itself; ported as written
      base.i[d] = G_INT(state, def.ofs);
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
export function ED_ParseEdict(ps: ParseState, ent: EdictBaseT): void {
  const profile = PR_ActiveProfile();
  const state = profile.state;
  let anglehack: boolean;
  let init = false;
  let com_token = "";

  // clear it
  const table = state.edicts;
  if (table === null || ent !== table[0]) ent.fields.i.fill(0); // hack

  // go through all the dictionary pairs
  while (true) {
    // parse key
    let token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (com_token[0] === "}") break;
    if (token === null) profile.sysError("ED_ParseEntity: EOF without closing brace");

    // anglehack is to allow QuakeEd to write single scalar angles
    // and allow them to be turned into vectors. (FIXME...)
    if (com_token === "angle") {
      com_token = "angles";
      anglehack = true;
    } else anglehack = false;

    // FIXME: change light to _light to get rid of this hack
    if (com_token === "light") com_token = "light_lev"; // hack for single light def

    const keyname = profile.parseKeyname(com_token);

    // parse value
    token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (token === null) profile.sysError("ED_ParseEntity: EOF without closing brace");

    if (com_token[0] === "}") profile.sysError("ED_ParseEntity: closing brace without data");

    init = true;

    // keynames with a leading underscore are used for utility comments,
    // and are immediately discarded by quake
    if (keyname[0] === "_") continue;

    const key = ED_FindField(keyname);
    if (key === null) {
      const q = profile.unknownKeyQuote;
      Con_Printf("%s is not a field\n", q + keyname + q);
      continue;
    }

    if (anglehack) {
      const temp = com_token;
      com_token = Com_sprintf("0 %s 0", temp);
    }

    if (!ED_ParseEpair(ent.fields, key, com_token)) profile.hostError("ED_ParseEdict: parse error");
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
  const profile = PR_ActiveProfile();
  const state = profile.state;
  let ent: EdictBaseT | null = null;
  let inhibit = 0;
  const globalStruct = requireGlobalStruct(state);
  globalStruct.time = profile.serverTime();

  // parse ents
  while (true) {
    // parse the opening brace
    const com_token = COM_Parse(ps);
    if (com_token === null) break;
    if (com_token[0] !== "{") profile.sysError("ED_LoadFromFile: found %s when expecting {", com_token);

    if (ent === null) ent = EDICT_NUM(state, 0);
    else ent = ED_Alloc();
    ED_ParseEdict(ps, ent);

    // remove things from different skill levels or deathmatch
    if (profile.inhibitEntity(ent)) {
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
    const func = ED_FindFunction(PR_GetString(state, ent.v.classname));

    if (func === null) {
      Con_Printf("No spawn function for:\n");
      ED_Print(ent);
      ED_Free(ent);
      continue;
    }

    globalStruct.self = EDICT_TO_PROG(ent);
    PR_ExecuteProgram(functionIndex(func));
    profile.afterSpawnEntity();
  }

  Con_DPrintf("%i entities inhibited\n", inhibit);
}

//============================================================================
// builtin table assembly (see the file header's Additions note)

function PF_BadBuiltin(): void {
  PR_RunError("Bad builtin call number");
}

function PF_checkextension(): void {
  const profile = PR_ActiveProfile();
  const state = profile.state;
  const globals = requireGlobals(state);
  const name = PR_GetString(state, globals.i[OFS_PARM0]);
  globals.f[OFS_RETURN] = profile.extensions.has(name) ? 1 : 0;
}

function makeUnboundBuiltin(name: string): BuiltinT {
  return () => {
    PR_RunError("unbound builtin \"%s\": this progs.dat needs an engine extension this build does not have", name);
  };
}

function PR_InitBuiltins(profile: ProgsProfileT): void {
  const state = profile.state;
  const numbered = profile.numberedBuiltins();

  const table: BuiltinT[] = [];
  for (let i = 0; i < numbered.length; i++) table.push(numbered[i]);
  while (table.length < CHECKEXTENSION_BUILTIN) table.push(PF_BadBuiltin);
  if (table.length === CHECKEXTENSION_BUILTIN) table.push(PF_checkextension);

  // remap progs functions with id 0 (Ironwail pr_edict.c:1880-1898)
  for (let i = 0; i < state.functions.length; i++) {
    const func = state.functions[i];
    if (func.first_statement || func.parm_start || func.locals) continue;

    const name = PR_GetString(state, func.s_name);
    if (name === "") continue; // the null function at index 0

    const bound = profile.namedBuiltins.get(name);
    const slot = table.length;
    table.push(bound ?? makeUnboundBuiltin(name));
    func.first_statement = -slot;
  }

  state.builtins = table;
}

/*
===============
PR_LoadProgs
===============
*/
export function PR_LoadProgs(): void {
  const profile: ProgsProfileT = PR_ActiveProfile();
  const state = profile.state;

  // flush the non-C variable lookup cache
  for (let i = 0; i < GEFV_CACHESIZE; i++) state.gefvCache[i].field = "";

  // The C leaves pr_stack/pr_depth/pr_xfunction as PR_LoadProgs found them,
  // and every entry still points into the *previous* progs' function table.
  // In C that is harmless -- PR_StackTrace prints whatever those pointers now
  // name -- but here `PR_GetString(f->s_name)` resolves that offset against
  // the new, shorter string block and raises. PR_LoadProgs only ever runs with
  // the VM idle, so clearing the frame is the C's observable behaviour minus
  // the stale read.
  state.exec.trace = false;
  state.exec.xfunction = null;
  state.exec.xstatement = 0;
  state.exec.argc = 0;
  state.exec.depth = 0;
  for (const frame of state.stack) {
    frame.s = 0;
    frame.f = null;
  }
  state.localstack_used = 0;

  let data: Uint8Array | null = null;
  for (const name of profile.progsFiles) {
    data = profile.loadProgsFile(name);
    if (data !== null) break;
  }
  if (data === null) profile.sysError("PR_LoadProgs: couldn't load progs.dat");
  Con_DPrintf("Programs occupy %iK.\n", (com_filesize / 1024) | 0);

  const image: Uint8Array = data;
  state.crc = profile.loadChecksum(image, com_filesize);

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const header = readDprograms(view, 0);
  state.progs = header;

  if (header.version !== PROG_VERSION) {
    profile.sysError("progs.dat has wrong version number (%i should be %i)", header.version, PROG_VERSION);
  }
  if (!profile.systemCrcs.has(header.crc)) {
    profile.sysError(profile.crcErrorMessage);
  }

  PR_ClearEngineStrings(state);

  state.functions = [];
  for (let i = 0; i < header.numfunctions; i++) {
    state.functions.push(readDfunction(view, header.ofs_functions + i * DFUNCTION_T_SIZE));
  }
  state.strings = image.subarray(header.ofs_strings);
  state.globaldefs = [];
  for (let i = 0; i < header.numglobaldefs; i++) {
    state.globaldefs.push(readDdef(view, header.ofs_globaldefs + i * DDEF_T_SIZE));
  }
  state.fielddefs = [];
  for (let i = 0; i < header.numfielddefs; i++) {
    const def = readDdef(view, header.ofs_fielddefs + i * DDEF_T_SIZE);
    if (def.type & DEF_SAVEGLOBAL) profile.sysError("PR_LoadProgs: pr_fielddefs[i].type & DEF_SAVEGLOBAL");
    state.fielddefs.push(def);
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
  state.statements = statements;

  // pr_globals is `pr_global_struct` seen as float[]; the C aliases the
  // loaded file image in place, which a DataView-parsed load cannot do
  // (alignment of ofs_globals within the file buffer is not guaranteed), so
  // the block is copied into its own ArrayBuffer here and the two views and
  // the globalvars_t accessor are built over that.
  const globalsBuffer = new ArrayBuffer(header.numglobals * 4);
  const globalBytes = new Uint8Array(globalsBuffer);
  globalBytes.set(image.subarray(header.ofs_globals, header.ofs_globals + header.numglobals * 4));
  const globals = { f: new Float32Array(globalsBuffer), i: new Int32Array(globalsBuffer) };
  state.globals = globals;
  state.global_struct = profile.makeGlobalVars(globals.f, globals.i);

  state.edict_size = header.entityfields; // in words; see file header

  // the profile's optional entry points, e.g. QuakeWorld's
  // "Zoid, find the spectator functions"
  state.optional.clear();
  for (const name of profile.optionalFunctions) {
    const f = ED_FindFunction(name);
    state.optional.set(name, f === null ? 0 : functionIndex(f));
  }

  PR_InitBuiltins(profile);
}

/*
===============
PR_AllocEdicts

SV_SpawnServer's `sv.edicts = Hunk_AllocName (MAX_EDICTS*pr_edict_size,
"edicts")`, as an array of edict objects (see file header). Registers the
new table with progs_core.ts so EDICT_NUM/PROG_TO_EDICT resolve against it.
===============
*/
export function PR_AllocEdicts(max: number): EdictBaseT[] {
  const profile = PR_ActiveProfile();
  const edicts = profile.allocEdicts(max, profile.state.edict_size);
  setEdictTable(profile.state, edicts);
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
  PR_ActiveProfile().registerCvars();
}

// requireProgs is progs.h's `extern dprograms_t *progs` guard for callers
// that need the header after load (entityfields, numstrings, ...).
export function PR_Progs(): DprogramsT {
  return requireProgs(PR_ActiveState());
}

export function PR_OptionalFunction(name: string): FuncT {
  return PR_ActiveState().optional.get(name) ?? 0;
}
