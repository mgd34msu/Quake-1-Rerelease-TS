/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/cvar.h and WinQuake/cvar.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- `cvar_t` -> `CvarT`, a class with the same six fields (`name`, `string`,
  `archive`, `server`, `value`, `next`). The C's `qboolean archive`/`server`
  are plain `boolean`; `value` is computed by Q_atof exactly where the C
  computes it (Cvar_RegisterVariable, Cvar_Set), not in the constructor, so a
  freshly constructed CvarT reads `value === 0` until registered/set, same as
  a `cvar_t` literal with only name/string filled in.
- `cvar_t *cvar_vars` (the singly linked list head, `extern`) -> the module
  `let cvar_vars: CvarT | null`, mutated only by Cvar_RegisterVariable's
  prepend (`variable->next = cvar_vars; cvar_vars = variable;`), read
  everywhere else via the `next` chain exactly as the C walks it. New cvars
  land at the head, so Cvar_WriteVariables (and every other walk) visits
  newest-registered-first, matching the C's observable order.
- `cvar_null_string` -> Cvar_VariableString returns `""` directly; no shared
  string constant is needed since JS strings are values, not pointers.
- Z_Malloc/Z_Free string copies (Cvar_Set's free-old/copy-new, Cvar_
  RegisterVariable's off-copy so a later Z_Free doesn't clobber a caller's
  static buffer) are dropped: `string` is a plain immutable JS string field,
  assigned directly. No zone.ts import.
- `sv.active` / `SV_BroadcastPrintf` (server.ts/sv_main.ts, not yet ported):
  reached through a registrable hook, `setCvarServerHooks`. With no hook
  registered, Cvar_Set behaves as if `sv.active == false` (skips the
  broadcast), which is the correct behavior before any server unit lands.
  sv_main.ts (U031) is expected to call `setCvarServerHooks` once `sv` and
  `SV_BroadcastPrintf` exist.
- Cvar_WriteVariables takes `FILE *f` in C. Ruling (unit brief): a structural
  text sink `{ write(s: string): void }`; host.ts's Host_WriteConfiguration
  wraps a real file for it. Formats every archived cvar as `Com_sprintf('%s
  "%s"\n', var.name, var.string)`, matching the C's `fprintf (f, "%s \"%s\"\n"
  ...)` exactly, one `write` call per line.
- QuakeWorld track (Q001/Q005, PORTING.md's "Cvars gain flags" ruling,
  corrected 2026-09-05): the original ruling's premise was wrong. QW 2.33's
  actual `cvar.h` (QW/client/cvar.h) has no `CVAR_*` bitmask constants at all
  -- checked by reading the header and grepping the entire QW/ source tree
  for `CVAR_` (no hits outside .mak dependency-file noise). `cvar_t` there
  has exactly two `qboolean` fields, `archive` and `info` (a single flag
  meaning "propagate to userinfo" on the client binary and "propagate to
  serverinfo" on the server binary -- the same field, read differently
  depending on which binary is compiled; see QW/client/cvar.c's `Cvar_Set`,
  `#ifdef SERVERONLY`). `CVAR_NOSET` does not exist anywhere in this GPL
  release either; it is a later fork's addition (ProQuake/ezQuake-era
  engines), not QW 2.33's. The synthesized `flags` bitmask + `CVAR_ARCHIVE`/
  `CVAR_USERINFO`/`CVAR_SERVERINFO` Q001 added are removed; `CvarT` instead
  gains a plain `info: boolean` (5th constructor argument, default `false`),
  matching QW's actual `cvar_t` shape one-for-one. `archive`/`server` keep
  their exact prior meaning and are unaffected (WinQuake call sites, all
  existing tests).
- QW's `Cvar_Set` (QW/client/cvar.c) differs from WinQuake's landed one only
  by this `info` propagation (the `#ifndef SERVERONLY`/`#ifdef SERVERONLY`
  branches send to userinfo or serverinfo respectively); folded here under
  the `qw.active` runtime flag (PORTING.md: "small deltas fold into the
  landed module under qw.active") rather than kept as a second `Cvar_Set` in
  src/qw/cvar.ts. `cvarInfoHook`/`setCvarInfoHook` below is the registrable
  hook the qwcl entry point (userinfo + the setinfo network message) and the
  qwsv entry point (serverinfo) each install; those entry points are later
  units, so with no hook registered an info-flagged cvar still updates
  correctly and only the propagation side effect is a no-op, the same
  convention `CvarServerHooks` above already uses.
- QW's `Cvar_SetValue` is textually identical to WinQuake's
  (`sprintf (val, "%f", value); Cvar_Set (var_name, val);` in both
  QW/client/cvar.c and WinQuake/cvar.c) -- no fold needed, src/qw/cvar.ts
  re-exports this module's `Cvar_SetValue` unchanged.
- QW's `Cvar_RegisterVariable` links the cvar into `cvar_vars` and then calls
  `Cvar_Set (variable->name, value)` unconditionally (so an info-flagged cvar
  propagates immediately on registration too), where WinQuake's never calls
  `Cvar_Set` from here. This is additive and under the same `qw.active` fold.
- QW's `Cvar_CompleteVariable` checks for an exact name match before falling
  back to the same prefix-match loop WinQuake's uses; folded the same way.
*/

import { Q_atof } from "./common";
import { Cmd_Exists, Cmd_Argc, Cmd_Argv, cmdHost } from "./cmd";
import { Con_Printf } from "../client/console";
import { Com_sprintf } from "./sprintf";
import { qw } from "./quakedef";

export class CvarT {
  name: string;
  string: string;
  archive: boolean;
  server: boolean; // notifies players when changed
  info: boolean; // QuakeWorld track: propagate to userinfo (qwcl) / serverinfo (qwsv) when changed
  value: number;
  next: CvarT | null;

  constructor(name: string, string: string, archive = false, server = false, info = false) {
    this.name = name;
    this.string = string;
    this.archive = archive;
    this.server = server;
    this.info = info;
    this.value = 0; // set by Cvar_RegisterVariable/Cvar_Set; a cvar is 0 until registered, same as the C
    this.next = null;
  }
}

// QuakeWorld track: registrable hook for CvarT.info propagation -- see file
// header. The qwcl entry point installs the userinfo/setinfo-message
// behavior, the qwsv entry point the serverinfo behavior; only one is ever
// registered in a given process (qwcl and qwsv are separate binaries).
export type CvarInfoHook = (name: string, value: string) => void;
let cvarInfoHook: CvarInfoHook | null = null;
export function setCvarInfoHook(fn: CvarInfoHook | null): void {
  cvarInfoHook = fn;
}
// Test-only getter: a suite that temporarily swaps this process-wide
// singleton (e.g. to install its own binary's hook for a few tests, when
// both qwcl's and qwsv's modules happen to share this one test process)
// needs to restore whatever was ambient before it touched it, not assume
// null, per this project's test hygiene rule 15.
export function getCvarInfoHook(): CvarInfoHook | null {
  return cvarInfoHook;
}

// cvar_t *cvar_vars;
export let cvar_vars: CvarT | null = null;

export interface CvarServerHooks {
  active(): boolean;
  broadcastPrintf(fmt: string, ...args: Array<string | number>): void;
}

let serverHooks: CvarServerHooks | null = null;
export function setCvarServerHooks(h: CvarServerHooks | null): void {
  serverHooks = h;
}

/*
============
Cvar_FindVar
============
*/
export function Cvar_FindVar(var_name: string): CvarT | null {
  for (let v = cvar_vars; v !== null; v = v.next) if (var_name === v.name) return v;

  return null;
}

/*
============
Cvar_VariableValue
============
*/
export function Cvar_VariableValue(var_name: string): number {
  const v = Cvar_FindVar(var_name);
  if (!v) return 0;
  return Q_atof(v.string);
}

/*
============
Cvar_VariableString
============
*/
export function Cvar_VariableString(var_name: string): string {
  const v = Cvar_FindVar(var_name);
  if (!v) return ""; // cvar_null_string
  return v.string;
}

/*
============
Cvar_CompleteVariable
============
*/
export function Cvar_CompleteVariable(partial: string): string | null {
  const len = partial.length;

  if (!len) return null;

  // QW/client/cvar.c's Cvar_CompleteVariable checks for an exact match before
  // falling back to the prefix match below; folded under qw.active (see file
  // header). WinQuake's cvar.c has no such exact-match pass.
  if (qw.active) {
    for (let cvar = cvar_vars; cvar !== null; cvar = cvar.next) if (partial === cvar.name) return cvar.name;
  }

  // check functions
  for (let cvar = cvar_vars; cvar !== null; cvar = cvar.next) if (cvar.name.startsWith(partial)) return cvar.name;

  return null;
}

/*
============
Cvar_Set
============
*/
export function Cvar_Set(var_name: string, value: string): void {
  const v = Cvar_FindVar(var_name);
  if (!v) {
    // there is an error in C code if this happens
    Con_Printf("Cvar_Set: variable %s not found\n", var_name);
    return;
  }

  const changed = v.string !== value;

  v.string = value; // Z_Free the old value string, Z_Malloc + copy the new one -> plain assignment
  v.value = Q_atof(v.string);

  // QuakeWorld track (QW/client/cvar.c's Cvar_Set): propagate an info-flagged
  // cvar to userinfo (qwcl) or serverinfo (qwsv) -- see file header.
  if (qw.active && v.info && cvarInfoHook !== null) {
    cvarInfoHook(v.name, value);
  }

  if (v.server && changed) {
    if (serverHooks !== null && serverHooks.active()) {
      serverHooks.broadcastPrintf('"%s" changed to "%s"\n', v.name, v.string);
    }
  }
}

/*
============
Cvar_SetValue
============
*/
export function Cvar_SetValue(var_name: string, value: number): void {
  const val = Com_sprintf("%f", value);
  Cvar_Set(var_name, val);
}

/*
============
Cvar_RegisterVariable

Adds a freestanding variable to the variable list.
============
*/
export function Cvar_RegisterVariable(variable: CvarT): void {
  // first check to see if it has allready been defined
  const existing = Cvar_FindVar(variable.name);
  if (existing) {
    // Port deviation, the twin of Cmd_AddCommand's `cmdHost.rendererSwitch`
    // branch: a runtime renderer switch (`vid_restart`, the port's own
    // feature -- the C's renderers are separate binaries) re-runs
    // Draw_Init/SCR_Init/R_Init/Sbar_Init, and every cvar_t those register is
    // a C file-scope object that this second pass finds already linked into
    // cvar_vars. Re-linking THE SAME object is a no-op, not the double
    // definition this guard exists to catch, so inside VID_CheckChanges's
    // switch window it returns quietly. A DIFFERENT object under a name
    // already taken is still a real collision -- the second object would
    // never be reachable from the console -- and still prints.
    if (cmdHost.rendererSwitch && existing === variable) return;
    Con_Printf("Can't register variable %s, allready defined\n", variable.name);
    return;
  }

  // check for overlap with a command
  if (Cmd_Exists(variable.name)) {
    Con_Printf("Cvar_RegisterVariable: %s is a command\n", variable.name);
    return;
  }

  // copy the value off, because future sets will Z_Free it -- variable.string
  // is already a plain JS string owned by this CvarT, so no copy is needed
  variable.value = Q_atof(variable.string);

  // link the variable in
  variable.next = cvar_vars;
  cvar_vars = variable;

  // QW/client/cvar.c's Cvar_RegisterVariable calls Cvar_Set(variable->name,
  // value) right after linking, unconditionally, so an info-flagged cvar
  // propagates immediately on registration; WinQuake's never does this.
  // Folded under qw.active (see file header).
  if (qw.active) Cvar_Set(variable.name, variable.string);
}

/*
============
Cvar_Command

Handles variable inspection and changing from the console
============
*/
export function Cvar_Command(): boolean {
  // check variables
  const v = Cvar_FindVar(Cmd_Argv(0));
  if (!v) return false;

  // perform a variable print or set
  if (Cmd_Argc() === 1) {
    Con_Printf('"%s" is "%s"\n', v.name, v.string);
    return true;
  }

  Cvar_Set(v.name, Cmd_Argv(1));
  return true;
}

/*
============
Cvar_WriteVariables

Writes lines containing "set variable value" for all variables
with the archive flag set to true.
============
*/
export function Cvar_WriteVariables(f: { write(s: string): void }): void {
  for (let v = cvar_vars; v !== null; v = v.next) if (v.archive) f.write(Com_sprintf('%s "%s"\n', v.name, v.string));
}
