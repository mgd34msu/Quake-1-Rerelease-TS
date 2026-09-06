/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/pr_edict.c (GNU GPL v2 or later), which is WinQuake's
pr_edict.c with a delta (171 changed lines, `diff -w` against
WinQuake/pr_edict.c). Structure, names, and comments mirror
src/progs/pr_edict.ts (the WinQuake port); this header documents only what
differs. Every deviation src/progs/pr_edict.ts's own header already explains
(the `pr_*` globals living on a state holder, `eval_t` not being ported,
`GetEdictFieldValue` returning a word offset instead of a pointer, `ED_Write`/
`ED_WriteGlobals` taking a `TextFileWriter`, `ED_ParseEdict`/`ED_ParseGlobals`/
`ED_LoadFromFile` taking a `ParseState`, little-endian-only, `PR_ValueString`'s
rounding note) applies here unmodified, just over `qwpr`/`QwEdictT`
(src/qw/server/progs.ts) and QW's own `sv`/`svs` (src/qw/server/server.ts)
instead of WinQuake's `pr`/`sv`.

Real QW deltas applied (verified against the C, not guessed):
- Every `pr_strings + ofs` becomes `PR_GetString(ofs)` (QW's own engine-string
  mechanism, already ported at src/qw/server/progs.ts -- see that file's
  header). `ED_NewString` returns a `string_t` via `PR_SetString` (QW's own
  name for the function WinQuake has no equivalent of at all) instead of
  WinQuake's `PR_SetEngineString`; the call site in `ED_ParseEpair` needs no
  further change either way, since this port's `ED_NewString` already
  encapsulates the string_t conversion the C's caller does inline with
  `PR_SetString(ED_NewString(s))` (WinQuake's caller does the equivalent with
  raw pointer arithmetic, `ED_NewString(s) - pr_strings`).
- No scratch/saved cvars, no `nomonsters`/`gamecfg`: QW's `PR_Init` registers
  none of WinQuake's eleven cvars (checked -- the whole block is gone, not
  trimmed) and this file declares none of them.
- `ED_Alloc` scans from `MAX_CLIENTS+1` (a compile-time constant, `protocol.h`
  = 32 here from src/qw/protocol.ts), not `svs.maxclients+1` -- confirmed
  against both C sources; `server.h`'s own `server_static_t` doesn't even
  have a `maxclients` field in QW (it's a cvar in sv_main.c per
  src/qw/server/server.ts's file header), so there is nothing to read there
  anyway. The "no free edicts" path is completely rewritten: WinQuake
  `Sys_Error`s; QW instead prints a warning, steps back onto the last edict
  (`i--`), force-unlinks it, and reuses it, only incrementing `sv.num_edicts`
  on the normal (room-left) path. `MAX_EDICTS` itself is QW's own bothdefs.ts
  value (768), not WinQuake's quakedef.ts one (600).
- `ED_Free`/`ED_Alloc` call `SV_UnlinkEdict`, QW/server/world.c's function
  (unchanged from WinQuake's world.c -- diffed, no output). `src/qw/server/
  world.ts` has since landed and is this file's canonical import for it
  (no load-time cycle: world.ts does not import pr_edict.ts at module top,
  so this is a plain, non-lazy import, exactly as pr_edict.ts (WinQuake)
  already does for its own world.ts).
- `ED_LoadFromFile` drops WinQuake's `deathmatch`/skill-level filtering
  entirely (checked side by side: the `if (deathmatch.value) {...} else if
  (current_skill...) {...}` block is gone, not narrowed) and keeps only the
  unconditional `SPAWNFLAG_NOT_DEATHMATCH` check. It also calls
  `SV_FlushSignon()` (sv_send.c, not yet landed) after every
  `PR_ExecuteProgram` -- ported below through a registrable hook
  (`setSvFlushSignonHook`), the same missing-sibling pattern `SV_UnlinkEdict`
  used before world.ts landed, but for a function this file has no safe
  local copy of (sv_send.c's signon-buffer bookkeeping is not
  host-independent), so
  the seam is exposed instead of stubbed; a later unit (sv_send.ts) must
  call `setSvFlushSignonHook(SV_FlushSignon)` at boot.
- `PR_LoadProgs` tries `qwprogs.dat` first, then falls back to `progs.dat`
  (WinQuake only ever loads `progs.dat`). It computes a whole-file CRC with
  `CRC_Block` (src/common/crc.ts, a QW/client/crc.c addition) and stores it
  into the server's serverinfo string (`svs.info`) under the `*progs` key via
  `Info_SetValueForStarKey` -- this is a real, different mechanism from
  WinQuake's persistent `pr_crc` global (computed byte-by-byte with
  `CRC_Init`/`CRC_ProcessByte` and kept around for later reads). QW's C in
  fact keeps NO persistent `pr_crc` variable at all (checked: the top-of-file
  `unsigned short pr_crc;` declaration WinQuake has is simply gone, and
  nothing else assigns one) -- `src/qw/server/progs.ts`'s `QwProgsState`
  still carries a `crc` field for exactly this purpose, though, so this port
  fills it with the same `CRC_Block` result used for the serverinfo key
  rather than leave a dead field or duplicate the computation.
  `progs->crc != PROGHEADER_CRC` (the qcc system-vars checksum baked into the
  progs.dat header itself, unrelated to the whole-file `CRC_Block` above)
  fails with QW's own message ("You must have the progs.dat from QuakeWorld
  installed"), not WinQuake's ("progs.dat system vars have been modified,
  progdefs.h is out of date"). It also resolves and caches QW's three
  spectator entry points (`SpectatorConnect`/`SpectatorThink`/
  `SpectatorDisconnect`, "Zoid" -- QW's spectator-mode QuakeC hooks, new in
  this track and consumed by a later sv_user.ts/pr_cmds.ts unit) on
  `prSpectator` below, a fresh state holder with no WinQuake counterpart.
- `SV_Error`, not `Sys_Error`/`Host_Error`, is what every abort in this file
  calls in the C (`ED_ParseGlobals`/`ED_ParseEdict`'s three "EOF"/"closing
  brace"/"parse error" throws each, `ED_LoadFromFile`'s "found %s when
  expecting {", and `PR_LoadProgs`'s four checks). `SV_Error` is
  QW/server/sv_main.c's (Q014, not yet landed); per this unit's brief this
  file imports the `SV_Error` stand-in pr_exec.ts (this same track) now
  exports -- see that file's header for the ruling. `EDICT_NUM`/
  `NUM_FOR_EDICT`'s own `SV_Error` calls in the C are unaffected here: this
  port re-exports them from src/qw/server/progs.ts unchanged, which already
  throws `SysError` for a bad index (an earlier, already-landed ruling this
  unit does not revisit).
- Two `Con_Printf` messages drop WinQuake's single-quotes around the key
  name: `"%s is not a global\n"` / `"%s is not a field\n"`, not `"'%s' is not
  a global\n"` / `"'%s' is not a field\n"`.
- `ED_Print` no longer prints its own `"\nEDICT %i:\n"` header line (WinQuake
  does, at the top of the function); QW moves that responsibility to its two
  callers instead: `ED_PrintEdicts` prints `"\nEDICT %i:\n"` before each
  `ED_PrintNum` in its loop, and `ED_PrintEdict_f` prints `"\n EDICT %i:\n"`
  (one leading space, no blank-line-first) before its single call -- verified
  as genuinely different wording, not a copy-paste of the same string.
  `ED_PrintEdict_f` also drops WinQuake's own `i >= sv.num_edicts` "Bad edict
  number" guard entirely; an out-of-range index now reaches `EDICT_NUM`
  itself, which throws.
- `type_size[8]`'s `sizeof(void *)/4` entries (QW) vs WinQuake's
  `sizeof(string_t)/4`/`sizeof(func_t)/4`: numerically identical (every type
  in this table is one 32-bit word on this architecture either way), so
  src/progs/progs.ts's already-landed `TYPE_SIZE` is reused unchanged, per
  that file's own file header ruling.
- `pr_edict_size = progs->entityfields * 4 + sizeof(edict_t) - sizeof(entvars_t)`
  (QW) vs WinQuake's plain `progs->entityfields * 4`: both are C-only byte
  offsets for pointer arithmetic this port doesn't do (see src/progs/
  pr_exec.ts's pointer-encoding ruling, mirrored by this track's own
  `PR_MakePointer`/`PR_ResolvePointer` in pr_exec.ts) -- only the *stride*'s
  self-consistency matters. `qwpr.edict_size` is set to `header.entityfields`
  (word count), matching `QwEdictT`'s own constructor parameter and this
  port's WinQuake precedent, even though progs.ts's own field comment says
  "in bytes" (a guess by whichever unit wrote that comment before this one
  landed; nothing else reads the field, so this is a safe, documented choice
  rather than a fix to a file outside this unit's scope).
*/

import { Q_atof, Q_atoi, COM_Parse, COM_LoadHunkFile, com_filesize, MAX_SERVERINFO_STRING, Info_SetValueForStarKey, type ParseState } from "../common";
import { CRC_Block } from "../../common/crc";
import { VectorCopy, vec3_origin } from "../../common/mathlib";
import { Cmd_AddCommand, Cmd_Argv } from "../../common/cmd";
import { Com_sprintf } from "../../common/sprintf";
import { Con_DPrintf, Con_Printf } from "../../client/console";
import { SysError } from "../../platform/sys";
import { SV_UnlinkEdict } from "./world";
import { TYPE_SIZE } from "../../progs/progs";
import { MAX_EDICTS } from "../bothdefs";
import { MAX_CLIENTS } from "../protocol";
import { MOVETYPE_STEP, SPAWNFLAG_NOT_DEATHMATCH, sv, svs } from "./server";
import { PRRunError, PR_ExecuteProgram, PR_Profile_f, SV_Error } from "./pr_exec";
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
  type FuncT,
  type StringT,
} from "../../progs/pr_comp";
import { PROGHEADER_CRC, QwGlobalVars } from "./progdefs";
import {
  EDICT_NUM,
  EDICT_TO_PROG,
  QwEdictT,
  G_INT,
  NUM_FOR_EDICT,
  PROG_TO_EDICT,
  PR_ClearEngineStrings,
  PR_GetString,
  PR_SetString,
  qwpr,
  setEdictTable,
} from "./progs";

// dprograms_t *progs; the rest of pr_edict.c's `pr_*` globals live on
// progs.ts's `qwpr` holder (see file header).
export let progs: DprogramsT | null = null;

// one global word or one edict field word, addressed as `base + ofs` -- the
// C's `eval_t *` (see src/progs/pr_edict.ts's identical note)
export interface ValueRef {
  f: Float32Array;
  i: Int32Array;
}

// `fprintf (f, ...)` destination for ED_Write/ED_WriteGlobals
export interface TextFileWriter {
  write(s: string): void;
}

const MAX_FIELD_LEN = 64;
const GEFV_CACHESIZE = 2;

class GefvCache {
  pcache: DdefT | null = null;
  field = "";
}

const gefvCache: GefvCache[] = [new GefvCache(), new GefvCache()];

// Zoid, find the spectator functions: QW-only, resolved at PR_LoadProgs
// time, consumed by a later sv_user.ts/pr_cmds.ts unit.
export const prSpectator: { connect: FuncT; think: FuncT; disconnect: FuncT } = {
  connect: 0,
  think: 0,
  disconnect: 0,
};

// SV_FlushSignon (sv_send.c) does not exist yet -- see file header.
export type SvFlushSignonHook = () => void;
let svFlushSignonHook: SvFlushSignonHook = () => {};
export function setSvFlushSignonHook(fn: SvFlushSignonHook): void {
  svFlushSignonHook = fn;
}

function requireProgs(): DprogramsT {
  if (progs === null) throw new SysError("pr_edict.ts: progs not loaded (PR_LoadProgs not called)");
  return progs;
}

function requireGlobals(): ValueRef {
  if (qwpr.globals === null) throw new SysError("pr_edict.ts: qwpr.globals not set (PR_LoadProgs not called)");
  return qwpr.globals;
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) {
    throw new SysError("pr_edict.ts: qwpr.global_struct not set (PR_LoadProgs not called)");
  }
  return qwpr.global_struct;
}

/*
=================
ED_ClearEdict

Sets everything to NULL
=================
*/
export function ED_ClearEdict(e: QwEdictT): void {
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
export function ED_Alloc(): QwEdictT {
  let i: number;
  let e: QwEdictT;

  for (i = MAX_CLIENTS + 1; i < sv.num_edicts; i++) {
    e = EDICT_NUM(i);
    // the first couple seconds of server time can involve a lot of
    // freeing and allocating, so relax the replacement policy
    if (e.free && (e.freetime < 2 || sv.time - e.freetime > 0.5)) {
      ED_ClearEdict(e);
      return e;
    }
  }

  if (i === MAX_EDICTS) {
    Con_Printf("WARNING: ED_Alloc: no free edicts\n");
    i--; // step on whatever is the last edict
    e = EDICT_NUM(i);
    SV_UnlinkEdict(e);
  } else {
    sv.num_edicts++;
  }
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
export function ED_Free(ed: QwEdictT): void {
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
  for (let i = 0; i < qwpr.globaldefs.length; i++) {
    const def = qwpr.globaldefs[i];
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
  for (let i = 0; i < qwpr.fielddefs.length; i++) {
    const def = qwpr.fielddefs[i];
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
  for (let i = 0; i < qwpr.fielddefs.length; i++) {
    const def = qwpr.fielddefs[i];
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
  for (let i = 0; i < qwpr.globaldefs.length; i++) {
    const def = qwpr.globaldefs[i];
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
  for (let i = 0; i < qwpr.functions.length; i++) {
    const func = qwpr.functions[i];
    if (PR_GetString(func.s_name) === name) return func;
  }
  return null;
}

// `func - pr_functions`, the func_t index PR_ExecuteProgram takes
function functionIndex(func: DfunctionT): number {
  return qwpr.functions.indexOf(func);
}

let gefvRep = 0; // static int rep = 0;

export function GetEdictFieldValue(ed: QwEdictT, field: string): number {
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
      const f = qwpr.functions[base.i[ofs]];
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
      const f = qwpr.functions[base.i[ofs]];
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
export function ED_Print(ed: QwEdictT): void {
  if (ed.free) {
    Con_Printf("FREE\n");
    return;
  }

  for (let i = 1; i < qwpr.fielddefs.length; i++) {
    const d = qwpr.fielddefs[i];
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
export function ED_Write(f: TextFileWriter, ed: QwEdictT): void {
  f.write("{\n");

  if (ed.free) {
    f.write("}\n");
    return;
  }

  for (let i = 1; i < qwpr.fielddefs.length; i++) {
    const d = qwpr.fielddefs[i];
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
  for (let i = 0; i < sv.num_edicts; i++) {
    Con_Printf("\nEDICT %i:\n", i);
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
  const i = Q_atoi(Cmd_Argv(1));
  Con_Printf("\n EDICT %i:\n", i);
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
  for (let i = 0; i < qwpr.globaldefs.length; i++) {
    const def = qwpr.globaldefs[i];
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
    if (token === null) SV_Error("ED_ParseEntity: EOF without closing brace");

    const keyname = com_token;

    // parse value
    token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (token === null) SV_Error("ED_ParseEntity: EOF without closing brace");

    if (com_token[0] === "}") SV_Error("ED_ParseEntity: closing brace without data");

    const key = ED_FindGlobal(keyname);
    if (key === null) {
      Con_Printf("%s is not a global\n", keyname);
      continue;
    }

    if (!ED_ParseEpair(globals, key, com_token)) SV_Error("ED_ParseGlobals: parse error");
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

  return PR_SetString(new_p);
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
export function ED_ParseEdict(ps: ParseState, ent: QwEdictT): void {
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
    if (token === null) SV_Error("ED_ParseEntity: EOF without closing brace");

    // anglehack is to allow QuakeEd to write single scalar angles
    // and allow them to be turned into vectors. (FIXME...)
    if (com_token === "angle") {
      com_token = "angles";
      anglehack = true;
    } else anglehack = false;

    // FIXME: change light to _light to get rid of this hack
    if (com_token === "light") com_token = "light_lev"; // hack for single light def

    const keyname = com_token;

    // parse value
    token = COM_Parse(ps);
    if (token !== null) com_token = token;
    if (token === null) SV_Error("ED_ParseEntity: EOF without closing brace");

    if (com_token[0] === "}") SV_Error("ED_ParseEntity: closing brace without data");

    init = true;

    // keynames with a leading underscore are used for utility comments,
    // and are immediately discarded by quake
    if (keyname[0] === "_") continue;

    const key = ED_FindField(keyname);
    if (key === null) {
      Con_Printf("%s is not a field\n", keyname);
      continue;
    }

    if (anglehack) {
      const temp = com_token;
      com_token = Com_sprintf("0 %s 0", temp);
    }

    if (!ED_ParseEpair(ent.fields, key, com_token)) SV_Error("ED_ParseEdict: parse error");
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
  let ent: QwEdictT | null = null;
  let inhibit = 0;
  const globalStruct = requireGlobalStruct();
  globalStruct.time = sv.time;

  // parse ents
  while (true) {
    // parse the opening brace
    const com_token = COM_Parse(ps);
    if (com_token === null) break;
    if (com_token[0] !== "{") SV_Error("ED_LoadFromFile: found %s when expecting {", com_token);

    if (ent === null) ent = EDICT_NUM(0);
    else ent = ED_Alloc();
    ED_ParseEdict(ps, ent);

    // remove things from different skill levels or deathmatch
    if ((ent.v.spawnflags | 0) & SPAWNFLAG_NOT_DEATHMATCH) {
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
    svFlushSignonHook(); // SV_FlushSignon() -- sv_send.c, not yet landed; see file header
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

  let data = COM_LoadHunkFile("qwprogs.dat");
  if (data === null) data = COM_LoadHunkFile("progs.dat");
  if (data === null) SV_Error("PR_LoadProgs: couldn't load progs.dat");
  Con_DPrintf("Programs occupy %iK.\n", (com_filesize / 1024) | 0);

  // add prog crc to the serverinfo
  const crc = CRC_Block(data, com_filesize);
  svs.info = Info_SetValueForStarKey(svs.info, "*progs", Com_sprintf("%i", crc), MAX_SERVERINFO_STRING);
  qwpr.crc = crc; // see file header: the C keeps no persistent pr_crc at all

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = readDprograms(view, 0);
  progs = header;

  if (header.version !== PROG_VERSION) {
    SV_Error("progs.dat has wrong version number (%i should be %i)", header.version, PROG_VERSION);
  }
  if (header.crc !== PROGHEADER_CRC) {
    SV_Error("You must have the progs.dat from QuakeWorld installed");
  }

  PR_ClearEngineStrings();

  qwpr.functions = [];
  for (let i = 0; i < header.numfunctions; i++) {
    qwpr.functions.push(readDfunction(view, header.ofs_functions + i * DFUNCTION_T_SIZE));
  }
  qwpr.strings = data.subarray(header.ofs_strings);
  qwpr.globaldefs = [];
  for (let i = 0; i < header.numglobaldefs; i++) {
    qwpr.globaldefs.push(readDdef(view, header.ofs_globaldefs + i * DDEF_T_SIZE));
  }
  qwpr.fielddefs = [];
  for (let i = 0; i < header.numfielddefs; i++) {
    const def = readDdef(view, header.ofs_fielddefs + i * DDEF_T_SIZE);
    if (def.type & DEF_SAVEGLOBAL) SV_Error("PR_LoadProgs: pr_fielddefs[i].type & DEF_SAVEGLOBAL");
    qwpr.fielddefs.push(def);
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
  qwpr.statements = statements;

  // pr_globals is `pr_global_struct` seen as float[]; the C aliases the
  // loaded file image in place, which a DataView-parsed load cannot do
  // (alignment of ofs_globals within the file buffer is not guaranteed), so
  // the block is copied into its own ArrayBuffer here and the two views and
  // the globalvars_t accessor are built over that.
  const globalsBuffer = new ArrayBuffer(header.numglobals * 4);
  const globalBytes = new Uint8Array(globalsBuffer);
  globalBytes.set(data.subarray(header.ofs_globals, header.ofs_globals + header.numglobals * 4));
  const globals = { f: new Float32Array(globalsBuffer), i: new Int32Array(globalsBuffer) };
  qwpr.globals = globals;
  qwpr.global_struct = new QwGlobalVars(globals.f, globals.i);

  qwpr.edict_size = header.entityfields; // in words; see file header

  // Zoid, find the spectator functions
  prSpectator.connect = 0;
  prSpectator.think = 0;
  prSpectator.disconnect = 0;

  let f = ED_FindFunction("SpectatorConnect");
  if (f !== null) prSpectator.connect = functionIndex(f);
  f = ED_FindFunction("SpectatorThink");
  if (f !== null) prSpectator.think = functionIndex(f);
  f = ED_FindFunction("SpectatorDisconnect");
  if (f !== null) prSpectator.disconnect = functionIndex(f);
}

/*
===============
PR_AllocEdicts

SV_SpawnServer's `sv.edicts = Hunk_AllocName (MAX_EDICTS*pr_edict_size,
"edicts")`, as an array of QwEdictT objects (see src/progs/pr_edict.ts's
identical note). Registers the new table with progs.ts so EDICT_NUM/
PROG_TO_EDICT resolve against it.
===============
*/
export function PR_AllocEdicts(max: number): QwEdictT[] {
  const edicts: QwEdictT[] = [];
  for (let i = 0; i < max; i++) edicts.push(new QwEdictT(i, qwpr.edict_size));
  sv.edicts = edicts;
  setEdictTable(edicts);
  return edicts;
}

/*
===============
PR_Init

QW registers no cvars here (see file header) -- WinQuake's eleven
scratch/saved cvars are gone entirely, not trimmed.
===============
*/
export function PR_Init(): void {
  Cmd_AddCommand("edict", ED_PrintEdict_f);
  Cmd_AddCommand("edicts", ED_PrintEdicts);
  Cmd_AddCommand("edictcount", ED_Count);
  Cmd_AddCommand("profile", PR_Profile_f);
}

export { EDICT_NUM, NUM_FOR_EDICT };

// requireProgs is progs.h's `extern dprograms_t *progs` guard for callers
// that need the header after load (entityfields, numstrings, ...).
export function PR_Progs(): DprogramsT {
  return requireProgs();
}
