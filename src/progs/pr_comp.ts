/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_comp.h (GNU GPL v2 or later).

Definitions shared by the engine and qcc (the QuakeC compiler, not ported --
this file only carries the bytecode/def shapes the engine's VM reads).
Little-endian only; the `dstatement_t`/`ddef_t`/`dfunction_t`/`dprograms_t`
readers follow the same class + `*_T_SIZE` + `read*(view, offset)` pattern as
bspfile.ts, modelgen.ts and spritegn.ts.

Deviations from the C source: none. `string_t`/`func_t` are `int` in C
(offsets into the strings block / function table); here they are plain
`number` type aliases, per PORTING.md's `string_t` ruling in progs.ts.
*/

// this file is shared by quake and qcc

export type FuncT = number;
export type StringT = number;

export enum EtypeT {
  ev_void,
  ev_string,
  ev_float,
  ev_vector,
  ev_entity,
  ev_field,
  ev_function,
  ev_pointer,
}

export const OFS_NULL = 0;
export const OFS_RETURN = 1;
export const OFS_PARM0 = 4; // leave 3 ofs for each parm to hold vectors
export const OFS_PARM1 = 7;
export const OFS_PARM2 = 10;
export const OFS_PARM3 = 13;
export const OFS_PARM4 = 16;
export const OFS_PARM5 = 19;
export const OFS_PARM6 = 22;
export const OFS_PARM7 = 25;
export const RESERVED_OFS = 28;

export enum OpT {
  OP_DONE,
  OP_MUL_F,
  OP_MUL_V,
  OP_MUL_FV,
  OP_MUL_VF,
  OP_DIV_F,
  OP_ADD_F,
  OP_ADD_V,
  OP_SUB_F,
  OP_SUB_V,

  OP_EQ_F,
  OP_EQ_V,
  OP_EQ_S,
  OP_EQ_E,
  OP_EQ_FNC,

  OP_NE_F,
  OP_NE_V,
  OP_NE_S,
  OP_NE_E,
  OP_NE_FNC,

  OP_LE,
  OP_GE,
  OP_LT,
  OP_GT,

  OP_LOAD_F,
  OP_LOAD_V,
  OP_LOAD_S,
  OP_LOAD_ENT,
  OP_LOAD_FLD,
  OP_LOAD_FNC,

  OP_ADDRESS,

  OP_STORE_F,
  OP_STORE_V,
  OP_STORE_S,
  OP_STORE_ENT,
  OP_STORE_FLD,
  OP_STORE_FNC,

  OP_STOREP_F,
  OP_STOREP_V,
  OP_STOREP_S,
  OP_STOREP_ENT,
  OP_STOREP_FLD,
  OP_STOREP_FNC,

  OP_RETURN,
  OP_NOT_F,
  OP_NOT_V,
  OP_NOT_S,
  OP_NOT_ENT,
  OP_NOT_FNC,
  OP_IF,
  OP_IFNOT,
  OP_CALL0,
  OP_CALL1,
  OP_CALL2,
  OP_CALL3,
  OP_CALL4,
  OP_CALL5,
  OP_CALL6,
  OP_CALL7,
  OP_CALL8,
  OP_STATE,
  OP_GOTO,
  OP_AND,
  OP_OR,

  OP_BITAND,
  OP_BITOR,
}

export class DstatementT {
  op = 0; // unsigned short
  a = 0; // short
  b = 0; // short
  c = 0; // short
}
export const DSTATEMENT_T_SIZE = 8;

export function readDstatement(view: DataView, offset: number): DstatementT {
  const s = new DstatementT();
  s.op = view.getUint16(offset, true);
  s.a = view.getInt16(offset + 2, true);
  s.b = view.getInt16(offset + 4, true);
  s.c = view.getInt16(offset + 6, true);
  return s;
}

export class DdefT {
  type = 0; // unsigned short; if DEF_SAVEGLOBAL bit is set the variable needs to be saved in savegames
  ofs = 0; // unsigned short
  s_name = 0; // int
}
export const DDEF_T_SIZE = 8;
export const DEF_SAVEGLOBAL = 1 << 15;

export function readDdef(view: DataView, offset: number): DdefT {
  const d = new DdefT();
  d.type = view.getUint16(offset, true);
  d.ofs = view.getUint16(offset + 2, true);
  d.s_name = view.getInt32(offset + 4, true);
  return d;
}

export const MAX_PARMS = 8;

export class DfunctionT {
  first_statement = 0; // int; negative numbers are builtins
  parm_start = 0; // int
  locals = 0; // int; total ints of parms + locals

  profile = 0; // int; runtime

  s_name = 0; // int
  s_file = 0; // int; source file defined in

  numparms = 0; // int
  parm_size: Uint8Array = new Uint8Array(MAX_PARMS); // byte[MAX_PARMS]
}
export const DFUNCTION_T_SIZE = 36;

export function readDfunction(view: DataView, offset: number): DfunctionT {
  const f = new DfunctionT();
  f.first_statement = view.getInt32(offset, true);
  f.parm_start = view.getInt32(offset + 4, true);
  f.locals = view.getInt32(offset + 8, true);
  f.profile = view.getInt32(offset + 12, true);
  f.s_name = view.getInt32(offset + 16, true);
  f.s_file = view.getInt32(offset + 20, true);
  f.numparms = view.getInt32(offset + 24, true);
  for (let i = 0; i < MAX_PARMS; i++) f.parm_size[i] = view.getUint8(offset + 28 + i);
  return f;
}

export const PROG_VERSION = 6;

export class DprogramsT {
  version = 0; // int
  crc = 0; // int; check of header file

  ofs_statements = 0; // int
  numstatements = 0; // int; statement 0 is an error

  ofs_globaldefs = 0; // int
  numglobaldefs = 0; // int

  ofs_fielddefs = 0; // int
  numfielddefs = 0; // int

  ofs_functions = 0; // int
  numfunctions = 0; // int; function 0 is an empty

  ofs_strings = 0; // int
  numstrings = 0; // int; first string is a null string

  ofs_globals = 0; // int
  numglobals = 0; // int

  entityfields = 0; // int
}
export const DPROGRAMS_T_SIZE = 60;

export function readDprograms(view: DataView, offset: number): DprogramsT {
  const p = new DprogramsT();
  p.version = view.getInt32(offset, true);
  p.crc = view.getInt32(offset + 4, true);
  p.ofs_statements = view.getInt32(offset + 8, true);
  p.numstatements = view.getInt32(offset + 12, true);
  p.ofs_globaldefs = view.getInt32(offset + 16, true);
  p.numglobaldefs = view.getInt32(offset + 20, true);
  p.ofs_fielddefs = view.getInt32(offset + 24, true);
  p.numfielddefs = view.getInt32(offset + 28, true);
  p.ofs_functions = view.getInt32(offset + 32, true);
  p.numfunctions = view.getInt32(offset + 36, true);
  p.ofs_strings = view.getInt32(offset + 40, true);
  p.numstrings = view.getInt32(offset + 44, true);
  p.ofs_globals = view.getInt32(offset + 48, true);
  p.numglobals = view.getInt32(offset + 52, true);
  p.entityfields = view.getInt32(offset + 56, true);
  return p;
}
