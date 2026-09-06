/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/nonintel.c (GNU GPL v2 or later).

//
// nonintel.c: code for non-Intel processors only
//

nonintel.c is the `#if !id386` half of the self-modifying-code patchers whose
Intel halves live in surf8.s / surf16.s / r_edgea.s: on x86 the renderer
rewrites the mip-level constants inside the surface block drawers at run time,
and on every other processor there is nothing to rewrite. PORTING.md ports the
`id386 == 0` path, so all three bodies are the C's empty ones.

Deviations from PORTING.md / the C source:
- None. The three functions keep their C names, their `void (void)`
  signatures, and their empty bodies with the C's comment.
- Dropped `#if id386` branch: the whole file is inside `#if !id386`; the
  Intel counterparts are in the .s files PORTING.md does not port.
*/

/*
================
R_Surf8Patch
================
*/
export function R_Surf8Patch(): void {
  // we only patch code on Intel
}

/*
================
R_Surf16Patch
================
*/
export function R_Surf16Patch(): void {
  // we only patch code on Intel
}

/*
================
R_SurfacePatch
================
*/
export function R_SurfacePatch(): void {
  // we only patch code on Intel
}
