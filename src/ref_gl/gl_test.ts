/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_test.c (GNU GPL v2 or later).

gl_test.c's ENTIRE body -- `Test_Init`, `HitPlane`, `Test_Spawn`, `DrawPuff`,
`Test_Draw`, the file-scope `puff_t puffs[MAX_PUFFS]` and `plane_t junk` -- is
wrapped in one `#ifdef GLTEST / #endif` (WinQuake/gl_test.c:23-181). GLTEST is
never defined by this build (src/common/quakedef.ts's file header rules it
undefined alongside PARANOID/IDGODS/WINDED), so none of gl_test.c's code is
ever compiled into v1.09, and this is a documented-empty module per this
unit's RULING.

Confirmed by grep, every real call site is ALSO `#ifdef GLTEST`-gated and
takes the `#else`/no-op path in this port:
  - cl_tent.c:149 TE_SPIKE:      `#ifdef GLTEST Test_Spawn(pos); #else
    R_RunParticleEffect(pos, vec3_origin, 0, 10); #endif` -- src/client/cl_tent.ts
    takes the `#else` branch (R_RunParticleEffect), never Test_Spawn.
  - gl_rmain.c:971 (R_RenderView's tail): `#ifdef GLTEST Test_Draw(); #endif`
    -- gl_rmain.ts (U072, not yet landed) has no call to Test_Draw.
  - gl_rmisc.c:215 (R_Init):     `#ifdef GLTEST Test_Init(); #endif` --
    gl_rmisc.ts (U072, not yet landed) has no call to Test_Init.

RULING (this unit's brief): ported as a documented empty module with the
three externally-visible functions present as empty stubs (matching this
port's existing precedent for a declared-but-never-compiled/never-called C
function, e.g. render.ts's `R_InitEfrags`/`D_DeleteSurfaceCache`, ref_soft's
`V_CalcBlend`), rather than transliterating `#ifdef GLTEST`'s dead bodies --
those bodies read `cl.worldmodel->hulls` through `SV_RecursiveHullCheck`
(a server-side call from a client-rendering file, itself only sensible
because WinQuake is a single link unit) and mutate file-scope `puff_t`
state that no other translation unit ever reads. Since nothing in this port
(or the original engine, under any real build) ever calls these three
functions, their bodies have no observable behavior to preserve; keeping
them as empty exports keeps the module's public surface intact for a
future GLTEST-style debug build without carrying dead server-coupling code
into the ref_gl tree. `HitPlane`, `DrawPuff` and the `puffs`/`junk` module
state are gl_test.c-internal helpers with no external caller even when
GLTEST is defined, and are not ported at all.

Deviations from PORTING.md / the C source:
- `Test_Spawn` is exported here as `Test_Spawn` taking a `Vec3` (matching the
  C's `void Test_Spawn (vec3_t origin)`), not `Test_Spawn_f` -- there is no
  `Test_Spawn_f` anywhere in WinQuake/gl_test.c (confirmed by reading the
  file in full); no `Cmd_AddCommand` registration exists for it either,
  since the whole file compiles out.
*/

import type { Vec3 } from "../common/mathlib";

/*
================
Test_Init

#ifdef GLTEST only (see file header) -- never called in this port.
================
*/
export function Test_Init(): void {}

/*
================
Test_Spawn

#ifdef GLTEST only (see file header) -- never called in this port.
================
*/
export function Test_Spawn(_origin: Vec3): void {}

/*
================
Test_Draw

#ifdef GLTEST only (see file header) -- never called in this port.
================
*/
export function Test_Draw(): void {}
