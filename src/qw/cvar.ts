/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/cvar.h and QW/client/cvar.c (GNU GPL v2 or later),
diffed against the landed WinQuake/cvar.h and WinQuake/cvar.c port
(src/common/cvar.ts).

Corrected 2026-09-05 (Task 2, QuakeWorld cvar `info` correction): Q001's
original ruling gave `CvarT` a synthesized `flags` bitmask
(`CVAR_ARCHIVE`/`CVAR_USERINFO`/`CVAR_SERVERINFO`) that this file's own
original header already flagged as wrong -- QW 2.33's actual `cvar_t` has a
single `info: boolean`, not a flags word (see src/common/cvar.ts's file
header). Every behavioral difference QW cvar.c actually has from the landed
WinQuake cvar.c (`Cvar_Set`'s info propagation, `Cvar_RegisterVariable`'s
post-link `Cvar_Set` call, `Cvar_CompleteVariable`'s exact-match-first check)
is additive and small, so all three are now folded into src/common/cvar.ts
under the `qw.active` runtime flag instead of being duplicated here (that
file's own header documents each fold with the QW C line it mirrors).
`Cvar_SetValue` was already textually identical in both C files (both do
`sprintf (val, "%f", value); Cvar_Set (var_name, val);`), so it needed no
fold either.

This module is now entirely re-exports: every one of QW cvar.c's functions
now has a byte-identical (once qw.active is set) counterpart in
src/common/cvar.ts. `qwCvarHooks` is kept as a thin adapter over
src/common/cvar.ts's `setCvarInfoHook` so that Q005's own tests (and this
port's qwcl/qwsv entry points, not yet landed) can keep addressing separate
userinfo/serverinfo callbacks -- QW's own `cvar_t` carries only one `info`
bit, read differently depending on which binary is compiled, so at most one
of the two callbacks is ever populated by a real qwcl/qwsv process; the
adapter dispatches to whichever is set.
*/

import {
  CvarT,
  cvar_vars,
  Cvar_FindVar,
  Cvar_VariableValue,
  Cvar_VariableString,
  Cvar_WriteVariables,
  Cvar_Set,
  Cvar_SetValue,
  Cvar_RegisterVariable,
  Cvar_Command,
  Cvar_CompleteVariable,
  setCvarInfoHook,
} from "../common/cvar";

// re-exported unchanged -- see file header
export {
  CvarT,
  cvar_vars,
  Cvar_FindVar,
  Cvar_VariableValue,
  Cvar_VariableString,
  Cvar_WriteVariables,
  Cvar_Set,
  Cvar_SetValue,
  Cvar_RegisterVariable,
  Cvar_Command,
  Cvar_CompleteVariable,
};

export interface QwCvarHooks {
  userinfoChanged: ((name: string, value: string) => void) | null;
  serverinfoChanged: ((name: string, value: string) => void) | null;
}

// set by the qwcl/qwsv entry points (src/qw/main_cl.ts, src/qw/main_sv.ts) --
// see file header's deviation note. A thin adapter over
// src/common/cvar.ts's single `cvarInfoHook` slot.
export const qwCvarHooks: QwCvarHooks = {
  userinfoChanged: null,
  serverinfoChanged: null,
};

setCvarInfoHook((name, value) => {
  if (qwCvarHooks.userinfoChanged) qwCvarHooks.userinfoChanged(name, value);
  if (qwCvarHooks.serverinfoChanged) qwCvarHooks.serverinfoChanged(name, value);
});
