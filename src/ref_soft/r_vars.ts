/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_vars.c (GNU GPL v2 or later).

r_vars.c: global refresh variables

// all global and static refresh variables are collected in a contiguous block
// to avoid cache conflicts.

// FIXME: make into one big structure, like cl or sv
// FIXME: do separately for refresh engine and driver

r_vars.c's whole body is one definition -- `int r_bmodelactive;` -- wrapped in
`#if !id386`; the "contiguous block" the header comment describes is what is
left of a file whose other variables had already migrated into r_shared.h's
externs by v1.09. `r_bmodelactive` is REASSIGNED (r_bsp.c's R_RotateBmodel and
r_edge.c's R_ScanEdges both write it), so PORTING.md's holder rule already put
it on `rState` when src/ref_soft/r_shared.ts landed, under the `// r_vars.c`
heading there.

So this module has nothing of its own to define: it is a documented re-export
of the holder that carries r_vars.c's one global, kept so that a module that
ported a C file reaching `r_bmodelactive` can import it from the basename
PORTING.md's file table maps r_vars.c to. Reading and writing it is
`rState.r_bmodelactive`, exactly as every other reassigned software-renderer
global in this port.

Deviations from PORTING.md / the C source:
- No `export let r_bmodelactive`: an ESM import binding is read-only to the
  importer and two other modules write this one, which is the case PORTING.md
  rules on with "C globals that are reassigned ... become fields on their
  owning singleton or a small exported holder".
- The cache-line packing the file header is about has no meaning in this port
  (there is no control over object layout), so the C's grouping intent is
  recorded here as a comment and nothing more.
- Dropped `#if id386` branch: the whole file is inside `#if !id386`; the
  id386 half of r_vars.c is empty (the variables live in the .s files
  PORTING.md does not port).
*/

// r_vars.c: `int r_bmodelactive;` -> rState.r_bmodelactive
export { rState, type RStateT } from "./r_shared";
