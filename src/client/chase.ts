/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/chase.c (GNU GPL v2 or later).

chase.c -- chase camera code

Deviations from PORTING.md / the C source:
- `TraceLine`'s `memset (&trace, 0, sizeof(trace))` is preserved exactly as the C has it.
  Every other trace_t caller this port has ported so far (SV_ClipMoveToEntity
  in src/server/world.ts, and gl_test.c's identical prologue) sets
  `trace.fraction = 1; trace.allsolid = true; VectorCopy (end, trace.endpos)`
  before calling SV_RecursiveHullCheck; chase.c's TraceLine does not -- it
  only zeroes the struct. Two observable consequences follow from that, and
  both are kept: `trace.allsolid` starts `false`, so
  SV_RecursiveHullCheck's "if (trace.allsolid) return false" early-out (never
  got out of the solid area) can never fire on the very first solid leaf the
  ray starts inside; and `trace.endpos` is never pre-seeded with `end`, so if
  the ray never crosses into solid ground, TraceLine's `impact` out-param
  comes back (0,0,0), not `end`. This module's `TraceLine` reproduces both by
  constructing the trace with `new TraceT(); trace.clear()` and nothing else,
  matching the C's plain `memset`.
- `SV_RecursiveHullCheck`'s second argument: the C passes the literal `0`
  (`SV_RecursiveHullCheck (cl.worldmodel->hulls, 0, 0, 1, start, end,
  &trace)`), not `hull.firstclipnode` the way every other call site in this
  port writes it. Hull 0 (the BSP world hull Mod_MakeHull0 builds) always has
  firstclipnode 0, so this is not a divergence -- it is written as the C's
  literal `0` to keep the port line-for-line with the source.
- `cl.worldmodel` is a possibly-null `ModelT | null` field in this port
  (src/client/client.ts); the C dereferences `cl.worldmodel->hulls`
  unconditionally, which would be undefined behavior on a null pointer.
  `TraceLine` throws `SysError` instead, following the `requireWorldmodel`
  pattern src/server/world.ts / src/server/sv_main.ts / src/progs/pr_cmds.ts
  already use for the same C dereference on `sv.worldmodel`.
- `rand()` has no port-wide helper (mathlib.ts owns no `rand`/`random`; see
  src/progs/pr_cmds.ts's file header, which rules each call site implements
  its own) -- chase.c does not call `rand()` at all, so this note is only
  here because cl_main.ts (this wave's sibling unit) needed the same ruling.
- `Chase_Init` is called from exactly one place in the C, `Host_Init`
  (host.c), which this port reaches only through host.ts's `hostClientHooks`
  indirection (host.ts cannot import this module without the import-cycle
  host.c's own hooks exist to avoid -- see host.ts's file header). This
  module registers `hostClientHooks.chaseInit = Chase_Init` at module load,
  the same pattern cl_main.ts uses for the hooks it owns. `Chase_Reset` is
  never called anywhere in the C (a stub with only comments in its body,
  confirmed against every WinQuake .c file) and needs no hook.
*/

import type { Vec3 } from "../common/mathlib";
import { vec3, AngleVectors, DotProduct, M_PI, VectorCopy, VectorMA, VectorSubtract } from "../common/mathlib";
import { PITCH } from "../common/quakedef";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import type { ModelT } from "../common/model";
import { SV_RecursiveHullCheck, TraceT } from "../server/world";
import { SysError } from "../platform/sys";
import { hostClientHooks } from "../common/host";
import { cl } from "./client";
import { r_refdef } from "./render";

export const chase_back = new CvarT("chase_back", "100");
export const chase_up = new CvarT("chase_up", "16");
export const chase_right = new CvarT("chase_right", "0");
export const chase_active = new CvarT("chase_active", "0");

export const chase_pos: Vec3 = vec3();
export const chase_angles: Vec3 = vec3();

export const chase_dest: Vec3 = vec3();
export const chase_dest_angles: Vec3 = vec3();

export function Chase_Init(): void {
  Cvar_RegisterVariable(chase_back);
  Cvar_RegisterVariable(chase_up);
  Cvar_RegisterVariable(chase_right);
  Cvar_RegisterVariable(chase_active);
}

export function Chase_Reset(): void {
  // for respawning and teleporting
  //	start position 12 units behind head
}

function requireWorldmodel(): ModelT {
  if (cl.worldmodel === null) throw new SysError("chase: cl.worldmodel not set");
  return cl.worldmodel;
}

export function TraceLine(start: Vec3, end: Vec3, impact: Vec3): void {
  const worldmodel = requireWorldmodel();

  const trace = new TraceT();
  trace.clear(); // see file header: chase.c's TraceLine really does just memset, unlike every other trace_t caller
  SV_RecursiveHullCheck(worldmodel.hulls[0], 0, 0, 1, start, end, trace);

  VectorCopy(trace.endpos, impact);
}

export function Chase_Update(): void {
  const forward = vec3();
  const up = vec3();
  const right = vec3();
  const dest = vec3();
  const stop = vec3();

  // if can't see player, reset
  AngleVectors(cl.viewangles, forward, right, up);

  // calc exact destination
  for (let i = 0; i < 3; i++) chase_dest[i] = r_refdef.vieworg[i] - forward[i] * chase_back.value - right[i] * chase_right.value;
  chase_dest[2] = r_refdef.vieworg[2] + chase_up.value;

  // find the spot the player is looking at
  VectorMA(r_refdef.vieworg, 4096, forward, dest);
  TraceLine(r_refdef.vieworg, dest, stop);

  // calculate pitch to look at the same spot from camera
  VectorSubtract(stop, r_refdef.vieworg, stop);
  let dist = DotProduct(stop, forward);
  if (dist < 1) dist = 1;
  r_refdef.viewangles[PITCH] = (-Math.atan(stop[2] / dist) / M_PI) * 180;

  // move towards destination
  VectorCopy(chase_dest, r_refdef.vieworg);
}

//=============================================================================
// hostClientHooks.chaseInit registration -- see file header's deviation note.

hostClientHooks.chaseInit = Chase_Init;
