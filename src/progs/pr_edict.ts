/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/pr_edict.c (GNU GPL v2 or later).

sv_edict.c -- entity dictionary

WinQuake's binding of the shared entity dictionary. The functions themselves
are pr_edict_core.ts, which QuakeWorld's own pr_edict.ts binds the same way;
see that file's header for the C deltas between the two hosts and for every
deviation from the C. This module selects the NetQuake host profile before
delegating, narrows the core's `EdictBaseT` back to WinQuake's `EdictT` where
a function hands one out, and re-exports the eleven cvars `PR_Init` registers
(declared on the profile, which owns the difference from QuakeWorld's empty
set) under the names pr_edict.c gives them.

`progs` (`dprograms_t *progs`) is a live `let` here rather than a read of the
VM state, because that is its shape in the C and callers import the binding
itself; PR_LoadProgs republishes it after each load.
*/

import type { ParseState } from "../common/common";
import { SysError } from "../platform/sys";
import type { DdefT, DfunctionT, DprogramsT, StringT } from "./pr_comp";
import { EDICT_NUM, EdictT, NUM_FOR_EDICT, pr } from "./progs";
import { sv } from "../server/server";
import type { EdictBaseT } from "./progs_core";
import { PR_SetProfile } from "./profiles/profile";
import {
  gamecfg,
  nomonsters,
  nqProfile,
  saved1,
  saved2,
  saved3,
  saved4,
  savedgamecfg,
  scratch1,
  scratch2,
  scratch3,
  scratch4,
} from "./profiles/nq";
import * as core from "./pr_edict_core";

export { EDICT_NUM, NUM_FOR_EDICT };
export {
  nomonsters,
  gamecfg,
  scratch1,
  scratch2,
  scratch3,
  scratch4,
  savedgamecfg,
  saved1,
  saved2,
  saved3,
  saved4,
};
export type ValueRef = core.ValueRef;
export type TextFileWriter = core.TextFileWriter;

// dprograms_t *progs; the rest of pr_edict.c's `pr_*` globals live on
// progs.ts's `pr` holder (see file header).
export let progs: DprogramsT | null = null;

function requireEdictT(ed: EdictBaseT): EdictT {
  if (!(ed instanceof EdictT)) throw new SysError("pr_edict.ts: edict is not an EdictT");
  return ed;
}

export function ED_ClearEdict(e: EdictT): void {
  core.ED_ClearEdict(e);
}

export function ED_Alloc(): EdictT {
  PR_SetProfile(nqProfile);
  return requireEdictT(core.ED_Alloc());
}

export function ED_Free(ed: EdictT): void {
  PR_SetProfile(nqProfile);
  core.ED_Free(ed);
}

export function ED_GlobalAtOfs(ofs: number): DdefT | null {
  PR_SetProfile(nqProfile);
  return core.ED_GlobalAtOfs(ofs);
}

export function ED_FieldAtOfs(ofs: number): DdefT | null {
  PR_SetProfile(nqProfile);
  return core.ED_FieldAtOfs(ofs);
}

export function ED_FindField(name: string): DdefT | null {
  PR_SetProfile(nqProfile);
  return core.ED_FindField(name);
}

export function ED_FindGlobal(name: string): DdefT | null {
  PR_SetProfile(nqProfile);
  return core.ED_FindGlobal(name);
}

export function ED_FindFunction(name: string): DfunctionT | null {
  PR_SetProfile(nqProfile);
  return core.ED_FindFunction(name);
}

export function GetEdictFieldValue(ed: EdictT, field: string): number {
  PR_SetProfile(nqProfile);
  return core.GetEdictFieldValue(ed, field);
}

export function PR_ValueString(type: number, base: core.ValueRef, ofs: number): string {
  PR_SetProfile(nqProfile);
  return core.PR_ValueString(type, base, ofs);
}

export function PR_UglyValueString(type: number, base: core.ValueRef, ofs: number): string {
  PR_SetProfile(nqProfile);
  return core.PR_UglyValueString(type, base, ofs);
}

export function PR_GlobalString(ofs: number): string {
  PR_SetProfile(nqProfile);
  return core.PR_GlobalString(ofs);
}

export function PR_GlobalStringNoContents(ofs: number): string {
  PR_SetProfile(nqProfile);
  return core.PR_GlobalStringNoContents(ofs);
}

export function ED_Print(ed: EdictT): void {
  PR_SetProfile(nqProfile);
  core.ED_Print(ed);
}

export function ED_Write(f: core.TextFileWriter, ed: EdictT): void {
  PR_SetProfile(nqProfile);
  core.ED_Write(f, ed);
}

export function ED_PrintNum(ent: number): void {
  PR_SetProfile(nqProfile);
  core.ED_PrintNum(ent);
}

export function ED_PrintEdicts(): void {
  PR_SetProfile(nqProfile);
  core.ED_PrintEdicts();
}

export function ED_PrintEdict_f(): void {
  PR_SetProfile(nqProfile);
  core.ED_PrintEdict_f();
}

export function ED_Count(): void {
  PR_SetProfile(nqProfile);
  core.ED_Count();
}

export function ED_WriteGlobals(f: core.TextFileWriter): void {
  PR_SetProfile(nqProfile);
  core.ED_WriteGlobals(f);
}

export function ED_ParseGlobals(ps: ParseState): void {
  PR_SetProfile(nqProfile);
  core.ED_ParseGlobals(ps);
}

export function ED_NewString(string: string): StringT {
  PR_SetProfile(nqProfile);
  return core.ED_NewString(string);
}

export function ED_ParseEpair(base: core.ValueRef, key: DdefT, s: string): boolean {
  PR_SetProfile(nqProfile);
  return core.ED_ParseEpair(base, key, s);
}

export function ED_ParseEdict(ps: ParseState, ent: EdictT): void {
  PR_SetProfile(nqProfile);
  core.ED_ParseEdict(ps, ent);
}

export function ED_LoadFromFile(ps: ParseState): void {
  PR_SetProfile(nqProfile);
  core.ED_LoadFromFile(ps);
}

export function PR_LoadProgs(): void {
  PR_SetProfile(nqProfile);
  core.PR_LoadProgs();
  progs = pr.progs;
}

export function PR_AllocEdicts(max: number): EdictT[] {
  PR_SetProfile(nqProfile);
  core.PR_AllocEdicts(max); // the profile's allocEdicts sets sv.edicts/sv.max_edicts
  return sv.edicts;
}

export function PR_Init(): void {
  PR_SetProfile(nqProfile);
  core.PR_Init();
}

// progs.h's `extern dprograms_t *progs` guard for callers that need the
// header after load (entityfields, numstrings, ...).
export function PR_Progs(): DprogramsT {
  PR_SetProfile(nqProfile);
  return core.PR_Progs();
}
