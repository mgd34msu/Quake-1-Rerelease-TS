/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_local.h (GNU GPL v2 or later).

r_local.h -- private refresh defs

r_local.h is `#include "r_shared.h"` plus the refresh side's own private
types, constants and externs. This module does the same: it re-exports every
r_shared.ts name so a module that ported a `#include "r_local.h"` .c file
needs only this one import, and adds r_local.h's own declarations.

OWNERSHIP -- r_local.h declares these; the C file that DEFINES each, and the
port unit that owns it:
  alight_t, bedge_t, auxvert_t, clipplane_t, btofpoly_t, and every #define
                                             ... here (types/constants)
  screenedge, view_clipplanes, r_frustum_indexes, pfrustum_indexes,
  entity_rotation, newedges, removeedges, edge_head/edge_tail/edge_aftertail,
  r_emins/r_emaxs, r_entorigin, r_worldmodelorg
                                             ... here (mutated-in-place
                                                 singletons, per PORTING.md)
  cvar_t r_draworder, r_speeds, r_timegraph, r_graphheight, r_clearcolor,
  r_waterwarp, r_fullbright, r_drawentities, r_drawviewmodel, r_aliasstats,
  r_dspeeds, r_drawflat, r_ambient, r_reportsurfout, r_maxsurfs, r_numsurfs,
  r_reportedgeout, r_maxedges, r_numedges, r_aliastransbase, r_aliastransadj
       ... DEFINED in r_main.c with the initializers listed below, so they are
           r_main.ts's (U062), NOT this module's. r_local.h only declares them
           `extern`; PORTING.md keeps a cvar in the module that defines it.
           r_main.c's initializers, for U062:
             r_draworder "0"        r_speeds "0"        r_timegraph "0"
             r_graphheight "10"     r_clearcolor "2"    r_waterwarp "1"
             r_fullbright "0"       r_drawentities "1"  r_drawviewmodel "1"
             r_aliasstats -> the cvar NAME is "r_polymodelstats", value "0"
             r_dspeeds "0"          r_drawflat "0"      r_ambient "0"
             r_reportsurfout "0"    r_maxsurfs "0"      r_numsurfs "0"
             r_reportedgeout "0"    r_maxedges "0"      r_numedges "0"
             r_aliastransbase "200" r_aliastransadj "100"
           d_init.c additionally defines d_subdiv16 "1", d_mipcap "0",
           d_mipscale "1" (declared in d_local.h) -> U065.
  R_RenderWorld, R_ClearPolyList, R_DrawPolyList, R_DrawSprite,
  R_RenderFace, R_RenderPoly, R_RenderBmodelFace, R_TransformPlane,
  R_TransformFrustum, R_SetSkyFrame, R_DrawSurfaceBlock8/16, R_GenSkyTile,
  R_DrawSubmodelPolygons, R_DrawSolidClippedSubmodelPolygons,
  R_AddPolygonEdges, R_GetSurf, R_BeginEdgeFrame, R_ScanEdges,
  R_InsertNewEdges, R_StepActiveU, R_RemoveEdges, R_RotateBmodel,
  R_ZDrawSubmodelPolys, R_EmitEdge, R_ClipEdge, R_SplitEntityOnNode2,
  R_SurfacePatch                     ... r_bsp.ts/r_edge.ts/r_draw.ts (U063,
                                         U066)
  R_TextureAnimation, R_AliasDrawModel, R_AliasCheckBBox, R_AliasClipTriangle,
  R_InitTurb, R_MakeSky, R_MarkLights, R_LightPoint, R_AnimateLight,
  R_StoreEfrags                      ... r_surf.ts/r_alias.ts/r_aclip.ts/
                                         r_sky.ts/r_light.ts/r_efrag.ts
                                         (U064, U066)
  R_SetupFrame, R_TimeRefresh_f, R_TimeGraph, R_PrintAliasStats,
  R_PrintTimes, R_PrintDSpeeds, R_cshift_f  ... r_main.ts/r_misc.ts (U062)
  D_DrawSurfaces                     ... d_edge.ts (U065)
  cshift_t cshift_water              ... view.c -> src/client/view.ts (landed)
  R_Surf8Start/End, R_Surf16Start/End, R_EdgeCodeStart/End, R_Surf8Patch,
  R_Surf16Patch, R_DrawSurfaceBlock8_mip0..3
                                     ... x86-asm-only symbols; not ported
                                         (PORTING.md drops the .s files and
                                         the headers that exist only for them)

Deviations from PORTING.md / the C source:
- `MAXALIASVERTS` is 2000 here, the value in r_local.h (model.c's
  Mod_LoadAliasModel is the only reader and rejects any model with more
  vertexes). It is NOT 1024.
- `ALIAS_Z_CLIP_PLANE` is 5 in Quake 1 (Quake 2's is 4).
- `MAXCLIPPLANES` (11) is declared in render.h, but its only use is r_local.h's
  clipping budget, so src/client/render.ts left it here (see that file's
  header).
- `clipplane_t`'s `byte reserved[2]` is struct padding for asm_draw.h and is
  dropped. Its `next` stays an object reference: r_draw.c chains
  `view_clipplanes` and `world_clipplanes` through it.
- `bedge_t.v[2]` is `mvertex_t *v[2]`, kept as two object references.
- `pfrustum_indexes[4]` is `int *pfrustum_indexes[4]` pointing into
  `r_frustum_indexes[4*6]`; R_ViewChanged (r_misc.c) is the only writer and
  sets each to a moving cursor inside that array, so here they are
  `Int32Array` subarray VIEWS assigned by U062. They start as the four
  6-element slices, the layout R_ViewChanged produces for a 4-plane frustum.
- Declared by r_local.h but DEFINED and READ by no non-asm .c in v1.09, so
  kept as inert exports with the C's zero value (they exist for asm_draw.h /
  d_ifacea.h offsets, or are leftovers): `cl_worldmodel`, `r_ptverts`,
  `r_ptvertsmax`, `sbaseaxis`, `tbaseaxis`, `numverts`, `numtriangles`,
  `r_acliptype`, `leftclip`, `topclip`, `rightclip`, `bottomclip`,
  `r_maxvalidedgeoffset`, `MAXBVERTINDEXES`. They are grouped at the bottom.
- r_local.h declares no `sbuf` and no `r_planes`; Quake 1 has neither.
  Likewise it has no `r_skyframe`, `r_skytime` or `r_skyspeed`: r_sky.c's
  names are `r_skymade`, `r_skydirect`, `r_skysource`, `skyspeed`,
  `skyspeed2` and `skytime`, all on `rState`.
- Dropped `#if id386` branch: the four R_DrawSurfaceBlock8_mipN prototypes.
- The whole header sits inside `#ifndef GLQUAKE`.
*/

import { MplaneT, type Vec3, vec3 } from "../common/mathlib";
import type { MsurfaceT, ModelT, MvertexT } from "../common/model";
import { EdgeT, MAXHEIGHT } from "./r_shared";

export * from "./r_shared";

export const ALIAS_BASE_SIZE_RATIO = 1.0 / 11.0;
// normalizing factor so player model works out to about
//  1 pixel per triangle

export const BMODEL_FULLY_CLIPPED = 0x10; // value returned by R_BmodelCheckBBox ()
//  if bbox is trivially rejected

// render.h's, but used only by the r_local.h clipping code
export const MAXCLIPPLANES = 11;

//===========================================================================
// viewmodel lighting

export class AlightT {
  ambientlight = 0;
  shadelight = 0;
  plightvec: Vec3 | null = null;
}

//===========================================================================
// clipped bmodel edges

export class BedgeT {
  v: [MvertexT | null, MvertexT | null] = [null, null];
  pnext: BedgeT | null = null;

  clear(): void {
    this.v[0] = null;
    this.v[1] = null;
    this.pnext = null;
  }
}

export class AuxvertT {
  fv: Float32Array = new Float32Array(3); // viewspace x, y

  clear(): void {
    this.fv[0] = 0;
    this.fv[1] = 0;
    this.fv[2] = 0;
  }
}

export function allocAuxverts(n: number): AuxvertT[] {
  const a: AuxvertT[] = new Array<AuxvertT>(n);
  for (let i = 0; i < n; i++) a[i] = new AuxvertT();
  return a;
}

//===========================================================================

export const XCENTERING = 1.0 / 2.0;
export const YCENTERING = 1.0 / 2.0;

export const CLIP_EPSILON = 0.001;

export const BACKFACE_EPSILON = 0.01;

//===========================================================================

export const DIST_NOT_SET = 98765;

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class ClipplaneT {
  normal: Vec3 = vec3();
  dist = 0;
  next: ClipplaneT | null = null;
  leftedge = 0;
  rightedge = 0;

  clear(): void {
    this.normal[0] = this.normal[1] = this.normal[2] = 0;
    this.dist = 0;
    this.next = null;
    this.leftedge = 0;
    this.rightedge = 0;
  }
}

export const view_clipplanes: [ClipplaneT, ClipplaneT, ClipplaneT, ClipplaneT] = [
  new ClipplaneT(),
  new ClipplaneT(),
  new ClipplaneT(),
  new ClipplaneT(),
];

//=============================================================================

export const screenedge: [MplaneT, MplaneT, MplaneT, MplaneT] = [
  new MplaneT(),
  new MplaneT(),
  new MplaneT(),
  new MplaneT(),
];

export const r_entorigin: Vec3 = vec3();

//=============================================================================

//
// current entity info
//
export const r_worldmodelorg: Vec3 = vec3();

export const r_frustum_indexes: Int32Array = new Int32Array(4 * 6);
export const pfrustum_indexes: [Int32Array, Int32Array, Int32Array, Int32Array] = [
  r_frustum_indexes.subarray(0, 6),
  r_frustum_indexes.subarray(6, 12),
  r_frustum_indexes.subarray(12, 18),
  r_frustum_indexes.subarray(18, 24),
];

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export const NEAR_CLIP = 0.01;

export const MAXBVERTINDEXES = 1000; // new clipped vertices when clipping bmodels
//  to the world BSP

export const sbaseaxis: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];
export const tbaseaxis: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];

export const entity_rotation: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];

export class BtofpolyT {
  clipflags = 0;
  psurf: MsurfaceT | null = null;

  clear(): void {
    this.clipflags = 0;
    this.psurf = null;
  }
}

export const MAX_BTOFPOLYS = 5000; // FIXME: tune this

export function allocBtofpolys(n: number): BtofpolyT[] {
  const a: BtofpolyT[] = new Array<BtofpolyT>(n);
  for (let i = 0; i < n; i++) a[i] = new BtofpolyT();
  return a;
}

//=========================================================
// Alias models
//=========================================================

export const MAXALIASVERTS = 2000; // TODO: tune this
export const ALIAS_Z_CLIP_PLANE = 5;

//=========================================================
// turbulence stuff

export const AMP = 8 * 0x10000;
export const AMP2 = 3;
export const SPEED = 20;

//=========================================================
// particle stuff
//
// R_DrawParticles / R_InitParticles / R_ClearParticles / R_ReadPointFile_f
// are declared here but PORTING.md keeps r_part.c client-side: they are
// src/client/r_part.ts's. Each renderer's R_Init calls R_InitParticles and
// registers the "pointfile" command.

export const newedges: Array<EdgeT | null> = new Array<EdgeT | null>(MAXHEIGHT).fill(null);
export const removeedges: Array<EdgeT | null> = new Array<EdgeT | null>(MAXHEIGHT).fill(null);

// FIXME: make stack vars when debugging done
export const edge_head: EdgeT = new EdgeT();
export const edge_tail: EdgeT = new EdgeT();
export const edge_aftertail: EdgeT = new EdgeT();

export const r_emins: Vec3 = vec3();
export const r_emaxs: Vec3 = vec3();

//=============================================================================
//
// Declared by r_local.h, defined and read by no non-asm .c file in v1.09.
// Kept so this module exports everything the header declared.
//
export const rDeadState: {
  cl_worldmodel: ModelT | null;
  r_ptverts: MvertexT[] | null;
  r_ptvertsmax: MvertexT[] | null;
  numverts: number;
  numtriangles: number;
  r_acliptype: number;
  leftclip: number;
  topclip: number;
  rightclip: number;
  bottomclip: number;
  r_maxvalidedgeoffset: number;
} = {
  cl_worldmodel: null,
  r_ptverts: null,
  r_ptvertsmax: null,
  numverts: 0,
  numtriangles: 0,
  r_acliptype: 0,
  leftclip: 0,
  topclip: 0,
  rightclip: 0,
  bottomclip: 0,
  r_maxvalidedgeoffset: 0,
};
