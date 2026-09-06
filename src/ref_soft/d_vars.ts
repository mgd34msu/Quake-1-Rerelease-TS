/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/d_vars.c (GNU GPL v2 or later).

// r_vars.c: global refresh variables

// all global and static refresh variables are collected in a contiguous block
// to avoid cache conflicts.

// FIXME: make into one big structure, like cl or sv
// FIXME: do separately for refresh engine and driver

d_vars.c's whole body is `#if !id386`-wrapped definitions with no code: the
gradient floats (`d_sdivzstepu` ... `d_ziorigin`), the four fixed16_t texture
adjusts (`sadjust`, `tadjust`, `bbextents`, `bbextentt`), `cacheblock` /
`cachewidth`, `d_viewbuffer`, and the z-buffer trio `d_pzbuffer` /
`d_zrowbytes` / `d_zwidth`. Every one of them is REASSIGNED -- D_CalcGradients
(d_edge.ts), D_SetupFrame (d_init.ts), D_ViewChanged (d_modech.ts) and
D_DrawSurfaces (d_edge.ts) all write them each frame -- so PORTING.md's holder
rule already put them on `rState` when src/ref_soft/r_shared.ts landed, under
the `// d_vars.c` heading there.

So this module has nothing of its own to define: it is a documented re-export
of the holder that carries d_vars.c's globals, kept so that a module that
ported a C file reaching `d_sdivzstepu` or `cacheblock` can import it from the
basename PORTING.md's file table maps d_vars.c to. Reading and writing each
one is `rState.<C name>`.

Deviations from PORTING.md / the C source:
- No `export let d_sdivzstepu` and friends: an ESM import binding is read-only
  to the importer and d_edge.ts / d_init.ts / d_modech.ts all write these,
  which is the case PORTING.md rules on with "C globals that are reassigned
  ... become fields on their owning singleton or a small exported holder".
- `pixel_t *cacheblock` / `pixel_t *d_viewbuffer` are `Uint8Array | null` and
  `short *d_pzbuffer` is `Int16Array | null`, per src/client/vid.ts's ruling
  that a `pixel_t *` is a `Uint8Array` (there is no `PixelT` alias).
- The cache-line packing the file header is about has no meaning in this port
  (there is no control over object layout), so the C's grouping intent is
  recorded here as a comment and nothing more.
- Dropped `#if id386` branch: the whole file is inside `#if !id386`; the
  id386 half of d_vars.c is empty (the variables live in the .s files
  PORTING.md does not port).
*/

// d_vars.c's globals -> rState.d_sdivzstepu, rState.sadjust, rState.cacheblock,
// rState.d_viewbuffer, rState.d_pzbuffer, rState.d_zwidth, ...
export { rState, type RStateT } from "./r_shared";
