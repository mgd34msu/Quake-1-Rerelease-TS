/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_shared.h (GNU GPL v2 or later).

r_shared.h: general refresh-related stuff shared between the refresh and the
driver

// FIXME: clean up and move into d_iface.h

This module is the whole software renderer's shared state: the edge/surface
span pipeline types, the pools they are allocated from, and `rState`, the
holder every reassigned C global lives on. `d_iface.ts` is below it (types
only) and `r_local.ts` / `d_local.ts` are above it, exactly as the C's
`#include "r_shared.h"` nesting.

OWNERSHIP -- r_shared.h declares these; the module that DEFINES each in C, and
the port unit that fills it in:
  espan_t, surf_t, edge_t, the MAX..., NUM... and ALIAS_... constants   ... here (types)
  surfaces / surface_p / surf_max, r_edges / edge_p / edge_max,
  newedges / removeedges, span_p / max_span_p, r_currentkey  ... r_edge.c ->
                                                     r_edge.ts (U063)
  cachewidth, cacheblock, sadjust, tadjust, bbextents, bbextentt,
  d_sdivz.../d_tdivz.../d_zi..., d_viewbuffer, d_pzbuffer, d_zrowbytes, d_zwidth
                                                     ... d_vars.c -> the
                                                     d_*.ts rasterizer (U065)
  screenwidth, pixelAspect, r_drawnpolycount, xcenter/ycenter/xscale/yscale/
  xscaleinv/yscaleinv/xscaleshrink/yscaleshrink, d_lightstylevalue,
  r_framecount, r_visframecount, d_spanpixcount, r_polycount,
  r_wholepolycount                                   ... r_main.c ->
                                                     r_main.ts (U062)
  ubasestep, errorterm, erroradjustup, erroradjustdown ... d_edge.c (U065)
  sintable, intsintable                              ... r_draw.c (U066)
  r_skymade                                          ... r_sky.c (U066)
  currententity, modelorg, base_modelorg             ... r_bsp.c (U063)
  vup / vpn / vright / r_origin / r_refdef           ... src/client/render.ts
                                                     (landed; re-exported)
  base_vup / base_vpn / base_vright                  ... r_main.c (U062)
  cvar_t r_clearcolor                                ... r_main.c (U062)
  R_DrawLine, TransformVector, SetUpForLineScan, R_MakeSky  ... U063/U065/U066

Deviations from PORTING.md / the C source:
- `anorms.h`'s `r_avertexnormals` is already src/client/r_part.ts's (r_part.c
  is the C file that defines it in a software build) and is re-exported here
  rather than duplicated, per this unit's brief.
- The C's `surf_t *`/`edge_t *`/`espan_t *` cursors are pointer arithmetic
  into one allocated block (`surface_p++`, `edge_p++`, `surf - surfaces`), so
  the pools are arrays of objects and the cursors are INDEXES on `rState`
  (`rState.surface_p`, `rState.edge_p`, `rState.span_p`). Every pooled object
  also carries `index`, its own position in its pool, because the C stores a
  surface's position in an `unsigned short` (`edge->surfs[0] = surface_p -
  surfaces`) and recovers the object from it later (`&surfaces[edge->surfs[1]]`).
  Links between pooled objects (`surf->next`, `edge->prev`, `span->pnext`)
  stay OBJECT references, because that is all the C ever does with them.
- `allocSurfaces(n)` returns an array of n + 1 SurfT. R_NewMap / R_EdgeDrawing
  allocate n surf_t and then do `surfaces--`, so that `surfaces[0]` is a dummy
  (index 0 means "no surface attached to this edge") and `surfaces[1]` is the
  background. Element 0 here is that dummy, `rState.surface_p` starts at 2
  after R_BeginEdgeFrame, and `rState.surf_max` is n + 1, one past the last
  usable slot -- the same values `surface_p - surfaces` and
  `surf_max - surfaces` produce in C.
- Fixed-point values (`fixed16_t u`, `fixed8_t`) stay plain `number`;
  callers keep the C's `| 0` / `>>` / `<< 20`.
- `int pad[2]` in surf_t is struct padding "to 64 bytes" for the x86 asm and
  is dropped, as is `byte reserved[2]` in clipplane_t (r_local.ts).
- Declared by r_shared.h but DEFINED by no non-asm .c in v1.09, so kept as
  inert exports with the C's zero value: `sxformaxis`, `txformaxis`. They
  exist only for asm_draw.h's offsets.
- The whole header sits inside `#ifndef GLQUAKE`; the GL build has no
  counterpart, so nothing is conditional here.
*/

import { type Vec3, vec3 } from "../common/mathlib";
import type { MedgeT, MsurfaceT, MvertexT } from "../common/model";
import type { EntityT } from "../client/render";
import { r_origin, r_refdef, vpn, vright, vup } from "../client/render";
import { r_avertexnormals } from "../client/r_part";
import { CYCLE } from "./d_iface";
import { FinalvertT, allocFinalverts } from "./d_iface";
import type { AliashdrT, MtriangleT } from "./model_types";
// r_local.h's types, used by two r_local.h globals that live on `rState`.
// Type-only, so nothing crosses at module-init time and this is not the
// import cycle PORTING.md rules on.
import type { AuxvertT, BtofpolyT } from "./r_local";
import type { MdlT } from "../common/modelgen";
import type { MnodeT, MleafT } from "../common/model";

export { r_origin, r_refdef, vpn, vright, vup };
export { r_avertexnormals };
// finalvert_t is declared in d_iface.h; r_shared.h's ALIAS_*_CLIP flags are
// its `flags` bits, so it is re-exported here alongside them.
export { FinalvertT, allocFinalverts };

export const MAXVERTS = 16; // max points in a surface polygon
export const MAXWORKINGVERTS = MAXVERTS + 4; // max points in an intermediate
//  polygon (while processing)
// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const MAXHEIGHT = 1024;
export const MAXWIDTH = 1280;
export const MAXDIMENSION = MAXHEIGHT > MAXWIDTH ? MAXHEIGHT : MAXWIDTH;

export const SIN_BUFFER_SIZE = MAXDIMENSION + CYCLE;

export const INFINITE_DISTANCE = 0x10000; // distance that's always guaranteed to
//  be farther away than anything in
//  the scene

//===================================================================

export const sintable: Int32Array = new Int32Array(SIN_BUFFER_SIZE);
export const intsintable: Int32Array = new Int32Array(SIN_BUFFER_SIZE);

export const base_vup: Vec3 = vec3();
export const base_vpn: Vec3 = vec3();
export const base_vright: Vec3 = vec3();

export const NUMSTACKEDGES = 2400;
export const MINEDGES = NUMSTACKEDGES;
export const NUMSTACKSURFACES = 800;
export const MINSURFACES = NUMSTACKSURFACES;
export const MAXSPANS = 3000;

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class EspanT {
  index = 0; // position in the pool allocSpans() built this from
  u = 0;
  v = 0;
  count = 0;
  pnext: EspanT | null = null;

  clear(): void {
    this.u = 0;
    this.v = 0;
    this.count = 0;
    this.pnext = null;
  }
}

export function allocSpans(n: number): EspanT[] {
  const a: EspanT[] = new Array<EspanT>(n);
  for (let i = 0; i < n; i++) {
    a[i] = new EspanT();
    a[i].index = i;
  }
  return a;
}

// FIXME: compress, make a union if that will help
// insubmodel is only 1, flags is fewer than 32, spanstate could be a byte
export class SurfT {
  index = 0; // C: `surf - surfaces`, stored in edge_t.surfs[]
  next: SurfT | null = null; // active surface stack in r_edge.c
  prev: SurfT | null = null; // used in r_edge.c for active surf stack
  spans: EspanT | null = null; // pointer to linked list of spans to draw
  key = 0; // sorting key (BSP order)
  last_u = 0; // set during tracing
  spanstate = 0; // 0 = not in span
  // 1 = in span
  // -1 = in inverted span (end before
  //  start)
  flags = 0; // currentface flags
  data: MsurfaceT | null = null; // associated data like msurface_t
  entity: EntityT | null = null;
  nearzi = 0; // nearest 1/z on surface, for mipmapping
  insubmodel = false;
  d_ziorigin = 0;
  d_zistepu = 0;
  d_zistepv = 0;

  clear(): void {
    this.next = null;
    this.prev = null;
    this.spans = null;
    this.key = 0;
    this.last_u = 0;
    this.spanstate = 0;
    this.flags = 0;
    this.data = null;
    this.entity = null;
    this.nearzi = 0;
    this.insubmodel = false;
    this.d_ziorigin = 0;
    this.d_zistepu = 0;
    this.d_zistepv = 0;
  }
}

// surfaces are generated in back to front order by the bsp, so if a surf
// pointer is greater than another one, it should be drawn in front
// surfaces[1] is the background, and is used as the active surface stack.
// surfaces[0] is a dummy, because index 0 is used to indicate no surface
//  attached to an edge_t
export function allocSurfaces(n: number): SurfT[] {
  const a: SurfT[] = new Array<SurfT>(n + 1);
  for (let i = 0; i <= n; i++) {
    a[i] = new SurfT();
    a[i].index = i;
  }
  return a;
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class EdgeT {
  index = 0; // C: `edge_p - r_edges`, the medge_t cache offset's basis
  u = 0; // fixed16_t
  u_step = 0; // fixed16_t
  prev: EdgeT | null = null;
  next: EdgeT | null = null;
  surfs: Uint16Array = new Uint16Array(2);
  nextremove: EdgeT | null = null;
  nearzi = 0;
  owner: MedgeT | null = null;

  clear(): void {
    this.u = 0;
    this.u_step = 0;
    this.prev = null;
    this.next = null;
    this.surfs[0] = 0;
    this.surfs[1] = 0;
    this.nextremove = null;
    this.nearzi = 0;
    this.owner = null;
  }
}

export function allocEdges(n: number): EdgeT[] {
  const a: EdgeT[] = new Array<EdgeT>(n);
  for (let i = 0; i < n; i++) {
    a[i] = new EdgeT();
    a[i].index = i;
  }
  return a;
}

//===================================================================

export const sxformaxis: [Vec3, Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3(), vec3()]; // s axis transformed into viewspace
export const txformaxis: [Vec3, Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3(), vec3()]; // t axis transformed into viewspac

export const modelorg: Vec3 = vec3();
export const base_modelorg: Vec3 = vec3();

export const d_lightstylevalue: Int32Array = new Int32Array(256); // 8.8 frac of base light value

// flags in finalvert_t.flags
export const ALIAS_LEFT_CLIP = 0x0001;
export const ALIAS_TOP_CLIP = 0x0002;
export const ALIAS_RIGHT_CLIP = 0x0004;
export const ALIAS_BOTTOM_CLIP = 0x0008;
export const ALIAS_Z_CLIP = 0x0010;
// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export const ALIAS_ONSEAM = 0x0020; // also defined in modelgen.h;
//  must be kept in sync
export const ALIAS_XY_CLIP_MASK = 0x000f;

//===================================================================

/*
`rState` is every C global the software renderer REASSIGNS: an imported ESM
binding is read-only to the importer, so these cannot be bare `export let`
(PORTING.md: "C globals that are reassigned pointers become fields on their
owning singleton or a small exported holder"). Each field keeps its C name and
its C initial value; the comment on each names the .c file that defines it.
Structs and buffers that are only ever mutated in place stay `export const`
singletons above and in r_local.ts / d_local.ts.
*/
export type RStateT = {
  // r_main.c
  colormap: Uint8Array | null;
  r_time1: number;
  r_numallocatededges: number;
  r_drawpolys: boolean;
  r_drawculledpolys: boolean;
  r_worldpolysbacktofront: boolean;
  r_recursiveaffinetriangles: boolean;
  r_pixbytes: number;
  r_aliasuvscale: number;
  r_outofsurfaces: number;
  r_outofedges: number;
  r_dowarp: boolean;
  r_dowarpold: boolean;
  r_viewchanged: boolean;
  numbtofpolys: number;
  pbtofpolys: BtofpolyT[] | null;
  r_pcurrentvertbase: MvertexT[] | null;
  c_surf: number;
  r_maxsurfsseen: number;
  r_maxedgesseen: number;
  r_cnumsurfs: number;
  r_surfsonstack: boolean;
  r_clipflags: number;
  r_warpbuffer: Uint8Array | null;
  r_fov_greater_than_90: boolean;
  xcenter: number;
  ycenter: number;
  xscale: number;
  yscale: number;
  xscaleinv: number;
  yscaleinv: number;
  xscaleshrink: number;
  yscaleshrink: number;
  aliasxscale: number;
  aliasyscale: number;
  aliasxcenter: number;
  aliasycenter: number;
  screenwidth: number;
  pixelAspect: number;
  screenAspect: number;
  verticalFieldOfView: number;
  xOrigin: number;
  yOrigin: number;
  r_framecount: number; // so frame counts initialized to 0 don't match
  r_visframecount: number;
  d_spanpixcount: number;
  r_polycount: number;
  r_drawnpolycount: number;
  r_wholepolycount: number;
  reinit_surfcache: number; // if 1, surface cache is currently empty and
  // must be reinitialized for current cache size
  r_viewleaf: MleafT | null;
  r_oldviewleaf: MleafT | null;
  r_aliastransition: number;
  r_resfudge: number;
  dp_time1: number;
  dp_time2: number;
  db_time1: number;
  db_time2: number;
  rw_time1: number;
  rw_time2: number;
  se_time1: number;
  se_time2: number;
  de_time1: number;
  de_time2: number;
  dv_time1: number;
  dv_time2: number;

  // r_bsp.c
  insubmodel: boolean;
  currententity: EntityT | null;
  r_currentbkey: number;

  // r_edge.c
  r_edges: EdgeT[] | null;
  edge_p: number; // index into r_edges
  edge_max: number; // index into r_edges, one past the last usable slot
  auxedges: EdgeT[] | null;
  surfaces: SurfT[] | null;
  surface_p: number; // index into surfaces
  surf_max: number; // index into surfaces, one past the last usable slot
  span_p: number; // index into R_ScanEdges's span pool
  max_span_p: number;
  r_currentkey: number;

  // r_draw.c
  c_faceclip: number; // number of faces clipped
  r_pedge: MedgeT | null;

  // r_alias.c
  r_amodels_drawn: number;
  a_skinwidth: number;
  ptriangles: MtriangleT[] | null;
  paliashdr: AliashdrT | null;
  pmdl: MdlT | null;
  pfinalverts: FinalvertT[] | null;
  pauxverts: AuxvertT[] | null;
  acolormap: Uint8Array | null; // FIXME: should go away
  r_ambientlight: number;
  r_shadelight: number;

  // r_light.c
  r_dlightframecount: number;

  // r_efrag.c
  r_pefragtopnode: MnodeT | MleafT | null;

  // r_sky.c
  r_skymade: number;
  r_skydirect: number; // not used?
  r_skysource: Uint8Array | null;
  skyspeed: number;
  skyspeed2: number;
  skytime: number;

  // r_vars.c
  r_bmodelactive: number;

  // d_edge.c
  scale_for_mip: number;
  ubasestep: number;
  errorterm: number;
  erroradjustup: number;
  erroradjustdown: number;
  vstartscan: number;

  // d_vars.c
  d_sdivzstepu: number;
  d_tdivzstepu: number;
  d_zistepu: number;
  d_sdivzstepv: number;
  d_tdivzstepv: number;
  d_zistepv: number;
  d_sdivzorigin: number;
  d_tdivzorigin: number;
  d_ziorigin: number;
  sadjust: number; // fixed16_t
  tadjust: number; // fixed16_t
  bbextents: number; // fixed16_t
  bbextentt: number; // fixed16_t
  cacheblock: Uint8Array | null;
  cachewidth: number;
  d_viewbuffer: Uint8Array | null; // aliases vid.buffer, or r_warpbuffer while r_dowarp
  d_pzbuffer: Int16Array | null;
  d_zrowbytes: number;
  d_zwidth: number;

  // d_modech.c
  d_vrectx: number;
  d_vrecty: number;
  d_vrectright_particle: number;
  d_vrectbottom_particle: number;
  d_y_aspect_shift: number;
  d_pix_min: number;
  d_pix_max: number;
  d_pix_shift: number;

  // d_init.c
  d_minmip: number;

};

export const rState: RStateT = {
  // r_main.c
  colormap: null,
  r_time1: 0,
  r_numallocatededges: 0,
  r_drawpolys: false,
  r_drawculledpolys: false,
  r_worldpolysbacktofront: false,
  r_recursiveaffinetriangles: true,
  r_pixbytes: 1,
  r_aliasuvscale: 1.0,
  r_outofsurfaces: 0,
  r_outofedges: 0,
  r_dowarp: false,
  r_dowarpold: false,
  r_viewchanged: false,
  numbtofpolys: 0,
  pbtofpolys: null,
  r_pcurrentvertbase: null,
  c_surf: 0,
  r_maxsurfsseen: 0,
  r_maxedgesseen: 0,
  r_cnumsurfs: 0,
  r_surfsonstack: false,
  r_clipflags: 0,
  r_warpbuffer: null,
  r_fov_greater_than_90: false,
  xcenter: 0,
  ycenter: 0,
  xscale: 0,
  yscale: 0,
  xscaleinv: 0,
  yscaleinv: 0,
  xscaleshrink: 0,
  yscaleshrink: 0,
  aliasxscale: 0,
  aliasyscale: 0,
  aliasxcenter: 0,
  aliasycenter: 0,
  screenwidth: 0,
  pixelAspect: 0,
  screenAspect: 0,
  verticalFieldOfView: 0,
  xOrigin: 0,
  yOrigin: 0,
  r_framecount: 1, // so frame counts initialized to 0 don't match
  r_visframecount: 0,
  d_spanpixcount: 0,
  r_polycount: 0,
  r_drawnpolycount: 0,
  r_wholepolycount: 0,
  reinit_surfcache: 1, // if 1, surface cache is currently empty and
  // must be reinitialized for current cache size
  r_viewleaf: null,
  r_oldviewleaf: null,
  r_aliastransition: 0,
  r_resfudge: 0,
  dp_time1: 0,
  dp_time2: 0,
  db_time1: 0,
  db_time2: 0,
  rw_time1: 0,
  rw_time2: 0,
  se_time1: 0,
  se_time2: 0,
  de_time1: 0,
  de_time2: 0,
  dv_time1: 0,
  dv_time2: 0,

  // r_bsp.c
  insubmodel: false,
  currententity: null,
  r_currentbkey: 0,

  // r_edge.c
  r_edges: null,
  edge_p: 0, // index into r_edges
  edge_max: 0, // index into r_edges, one past the last usable slot
  auxedges: null,
  surfaces: null,
  surface_p: 0, // index into surfaces
  surf_max: 0, // index into surfaces, one past the last usable slot
  span_p: 0, // index into R_ScanEdges's span pool
  max_span_p: 0,
  r_currentkey: 0,

  // r_draw.c
  c_faceclip: 0, // number of faces clipped
  r_pedge: null,

  // r_alias.c
  r_amodels_drawn: 0,
  a_skinwidth: 0,
  ptriangles: null,
  paliashdr: null,
  pmdl: null,
  pfinalverts: null,
  pauxverts: null,
  acolormap: null, // FIXME: should go away
  r_ambientlight: 0,
  r_shadelight: 0,

  // r_light.c
  r_dlightframecount: 0,

  // r_efrag.c
  r_pefragtopnode: null,

  // r_sky.c
  r_skymade: 0,
  r_skydirect: 0, // not used?
  r_skysource: null,
  skyspeed: 0,
  skyspeed2: 0,
  skytime: 0,

  // r_vars.c
  r_bmodelactive: 0,

  // d_edge.c
  scale_for_mip: 0,
  ubasestep: 0,
  errorterm: 0,
  erroradjustup: 0,
  erroradjustdown: 0,
  vstartscan: 0,

  // d_vars.c
  d_sdivzstepu: 0,
  d_tdivzstepu: 0,
  d_zistepu: 0,
  d_sdivzstepv: 0,
  d_tdivzstepv: 0,
  d_zistepv: 0,
  d_sdivzorigin: 0,
  d_tdivzorigin: 0,
  d_ziorigin: 0,
  sadjust: 0, // fixed16_t
  tadjust: 0, // fixed16_t
  bbextents: 0, // fixed16_t
  bbextentt: 0, // fixed16_t
  cacheblock: null,
  cachewidth: 0,
  d_viewbuffer: null, // aliases vid.buffer, or r_warpbuffer while r_dowarp
  d_pzbuffer: null,
  d_zrowbytes: 0,
  d_zwidth: 0,

  // d_modech.c
  d_vrectx: 0,
  d_vrecty: 0,
  d_vrectright_particle: 0,
  d_vrectbottom_particle: 0,
  d_y_aspect_shift: 0,
  d_pix_min: 0,
  d_pix_max: 0,
  d_pix_shift: 0,

  // d_init.c
  d_minmip: 0,

};

// r_alias.c's `vec3_t r_plightvec`: mutated in place, so not on rState.
export const r_plightvec: Vec3 = vec3();
