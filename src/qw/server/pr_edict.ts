/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/pr_edict.c (GNU GPL v2 or later), which is WinQuake's
pr_edict.c with a delta (171 changed lines, `diff -w` against
WinQuake/pr_edict.c). Every one of those differences is now a host-profile
hook (src/progs/profiles/qw.ts, whose header lists them all, each verified
against the C), so the entity dictionary itself lives once in
src/progs/pr_edict_core.ts and this module is qwsv's binding of it: it selects
the QuakeWorld host profile before delegating and narrows the core's
`EdictBaseT` back to `QwEdictT` where a function hands one out.

Deviations from PORTING.md / the C source, beyond the ones
src/progs/pr_edict_core.ts and src/qw/server/progs.ts already document:
- `prSpectator` ("Zoid, find the spectator functions") has no WinQuake
  counterpart. The names are declared on the profile as its
  `optionalFunctions`, the core resolves them at load into the VM state's
  optional-function map, and PR_LoadProgs below republishes them here as the
  three plain `func_t` fields sv_user.ts and sv_main.ts read.
- `setSvFlushSignonHook` is re-exported from the profile, which owns the hook
  ED_LoadFromFile calls after each spawn function; src/qw/main_sv.ts registers
  sv_send.ts's real `SV_FlushSignon` through it at boot.
- `progs` (`dprograms_t *progs`) is a live `let` here rather than a read of the
  VM state, because that is its shape in the C; PR_LoadProgs republishes it
  after each load.
*/

import type { ParseState } from "../common";
import { SysError } from "../../platform/sys";
import type { DdefT, DfunctionT, DprogramsT, FuncT, StringT } from "../../progs/pr_comp";
import { EDICT_NUM, NUM_FOR_EDICT, QwEdictT, qwpr } from "./progs";
import type { EdictBaseT } from "../../progs/progs_core";
import { PR_SetProfile } from "../../progs/profiles/profile";
import { qwProfile, setSvFlushSignonHook, type SvFlushSignonHook } from "../../progs/profiles/qw";
import * as core from "../../progs/pr_edict_core";
import { sv } from "./server";

export { EDICT_NUM, NUM_FOR_EDICT, setSvFlushSignonHook };
export type { SvFlushSignonHook };
export type ValueRef = core.ValueRef;
export type TextFileWriter = core.TextFileWriter;

// dprograms_t *progs; the rest of pr_edict.c's `pr_*` globals live on
// progs.ts's `qwpr` holder (see file header).
export let progs: DprogramsT | null = null;

// Zoid, find the spectator functions: QW-only, resolved at PR_LoadProgs time,
// consumed by sv_user.ts and sv_main.ts.
export const prSpectator: { connect: FuncT; think: FuncT; disconnect: FuncT } = {
  connect: 0,
  think: 0,
  disconnect: 0,
};

function requireQwEdictT(ed: EdictBaseT): QwEdictT {
  if (!(ed instanceof QwEdictT)) throw new SysError("pr_edict.ts: edict is not a QwEdictT");
  return ed;
}

export function ED_ClearEdict(e: QwEdictT): void {
  core.ED_ClearEdict(e);
}

export function ED_Alloc(): QwEdictT {
  PR_SetProfile(qwProfile);
  return requireQwEdictT(core.ED_Alloc());
}

export function ED_Free(ed: QwEdictT): void {
  PR_SetProfile(qwProfile);
  core.ED_Free(ed);
}

export function ED_GlobalAtOfs(ofs: number): DdefT | null {
  PR_SetProfile(qwProfile);
  return core.ED_GlobalAtOfs(ofs);
}

export function ED_FieldAtOfs(ofs: number): DdefT | null {
  PR_SetProfile(qwProfile);
  return core.ED_FieldAtOfs(ofs);
}

export function ED_FindField(name: string): DdefT | null {
  PR_SetProfile(qwProfile);
  return core.ED_FindField(name);
}

export function ED_FindGlobal(name: string): DdefT | null {
  PR_SetProfile(qwProfile);
  return core.ED_FindGlobal(name);
}

export function ED_FindFunction(name: string): DfunctionT | null {
  PR_SetProfile(qwProfile);
  return core.ED_FindFunction(name);
}

export function GetEdictFieldValue(ed: QwEdictT, field: string): number {
  PR_SetProfile(qwProfile);
  return core.GetEdictFieldValue(ed, field);
}

export function PR_ValueString(type: number, base: core.ValueRef, ofs: number): string {
  PR_SetProfile(qwProfile);
  return core.PR_ValueString(type, base, ofs);
}

export function PR_UglyValueString(type: number, base: core.ValueRef, ofs: number): string {
  PR_SetProfile(qwProfile);
  return core.PR_UglyValueString(type, base, ofs);
}

export function PR_GlobalString(ofs: number): string {
  PR_SetProfile(qwProfile);
  return core.PR_GlobalString(ofs);
}

export function PR_GlobalStringNoContents(ofs: number): string {
  PR_SetProfile(qwProfile);
  return core.PR_GlobalStringNoContents(ofs);
}

export function ED_Print(ed: QwEdictT): void {
  PR_SetProfile(qwProfile);
  core.ED_Print(ed);
}

export function ED_Write(f: core.TextFileWriter, ed: QwEdictT): void {
  PR_SetProfile(qwProfile);
  core.ED_Write(f, ed);
}

export function ED_PrintNum(ent: number): void {
  PR_SetProfile(qwProfile);
  core.ED_PrintNum(ent);
}

export function ED_PrintEdicts(): void {
  PR_SetProfile(qwProfile);
  core.ED_PrintEdicts();
}

export function ED_PrintEdict_f(): void {
  PR_SetProfile(qwProfile);
  core.ED_PrintEdict_f();
}

export function ED_Count(): void {
  PR_SetProfile(qwProfile);
  core.ED_Count();
}

export function ED_WriteGlobals(f: core.TextFileWriter): void {
  PR_SetProfile(qwProfile);
  core.ED_WriteGlobals(f);
}

export function ED_ParseGlobals(ps: ParseState): void {
  PR_SetProfile(qwProfile);
  core.ED_ParseGlobals(ps);
}

export function ED_NewString(string: string): StringT {
  PR_SetProfile(qwProfile);
  return core.ED_NewString(string);
}

export function ED_ParseEpair(base: core.ValueRef, key: DdefT, s: string): boolean {
  PR_SetProfile(qwProfile);
  return core.ED_ParseEpair(base, key, s);
}

export function ED_ParseEdict(ps: ParseState, ent: QwEdictT): void {
  PR_SetProfile(qwProfile);
  core.ED_ParseEdict(ps, ent);
}

export function ED_LoadFromFile(ps: ParseState): void {
  PR_SetProfile(qwProfile);
  core.ED_LoadFromFile(ps);
}

export function PR_LoadProgs(): void {
  PR_SetProfile(qwProfile);
  core.PR_LoadProgs();
  progs = qwpr.progs;

  // Zoid, find the spectator functions
  prSpectator.connect = core.PR_OptionalFunction("SpectatorConnect");
  prSpectator.think = core.PR_OptionalFunction("SpectatorThink");
  prSpectator.disconnect = core.PR_OptionalFunction("SpectatorDisconnect");
}

export function PR_AllocEdicts(max: number): QwEdictT[] {
  PR_SetProfile(qwProfile);
  core.PR_AllocEdicts(max); // the profile's allocEdicts sets sv.edicts
  return sv.edicts;
}

export function PR_Init(): void {
  PR_SetProfile(qwProfile);
  core.PR_Init();
}

// progs.h's `extern dprograms_t *progs` guard for callers that need the
// header after load (entityfields, numstrings, ...).
export function PR_Progs(): DprogramsT {
  PR_SetProfile(qwProfile);
  return core.PR_Progs();
}
