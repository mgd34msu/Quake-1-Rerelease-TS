/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_main.c (GNU GPL v2 or later).

r_main.c -- the software renderer's entry point and frame driver.

Deviations from PORTING.md / the C source:
- Every r_main.c global that the C REASSIGNS lives on `rState`
  (src/ref_soft/r_shared.ts), which r_local.ts re-exports; this module writes
  them by their C names through that holder. The two r_main.c globals that are
  only ever mutated in place (`viewlightvec`, `r_viewlighting`) stay exported
  singletons here, as does every cvar r_main.c defines.
- `r_worldentity` is NOT an r_main.c global: it is defined in gl_rmain.c and
  declared in glquake.h, so the GL renderer owns it. The software R_NewMap has
  no `r_worldentity.model = cl.worldmodel` and no `d_lightstylevalue[i] = 264`
  loop either -- both of those are gl_rmisc.c's R_NewMap. This module ports
  r_main.c's R_NewMap verbatim instead.
- `screenwidth` is defined in d_edge.c, not r_main.c (r_shared.h only declares
  it), so d_edge.ts (U065) owns it even though r_shared.ts's ownership table
  lists it under r_main.c. Likewise `d_pix_min`/`d_pix_max`/`d_pix_shift` are
  d_modech.c's and `r_pedge` is r_draw.c's; none of the four is written here.
- `R_SurfacePatch` is nonintel.c's, whose `!id386` body is empty ("we only
  patch code on Intel"); it is imported from src/ref_soft/nonintel.ts, which
  PORTING.md maps that file to, so both C call sites keep their shape.
- `r_stack_start` and R_RenderView's four alignment tests around it
  (`R_RenderView: called without enough stack`, `Hunk is missaligned`,
  `Stack is missaligned`, `Globals are missaligned`) read raw addresses of
  stack and global storage. Nothing in TS has an address, so all four are
  dropped and R_RenderView is the call to R_RenderView_ that remains.
- `R_RenderView_`'s `byte warpbuffer[WARP_WIDTH * WARP_HEIGHT]` is a stack
  array whose address outlives nothing but the call; here it is one
  module-level Uint8Array allocated at load, per this unit's ruling. Same for
  R_EdgeDrawing's `ledges[]`/`lsurfs[]` stack pools: they are module-level
  pools built by allocEdges/allocSurfaces, and the
  `((CACHE_SIZE - 1) / sizeof(edge_t)) + 1` overshoot plus the
  `(((long)&ledges[0] + CACHE_SIZE - 1) & ~(CACHE_SIZE - 1))` alignment that
  consumes it are dropped: they exist only to cache-line-align a stack
  address.
- `surfaces--` after allocation is r_shared.ts's `allocSurfaces(n)` convention
  (n + 1 entries, element 0 the dummy that index 0 means "no surface"), so
  `surf_max - surfaces == r_cnumsurfs + 1` and `rState.surf_max` is set to
  `r_cnumsurfs + 1` at both C `surf_max = &surfaces[r_cnumsurfs]` sites.
- `cl.worldmodel`, `currententity->model` and `rState.r_viewleaf` are
  `... | null` in this port where the C dereferences them unconditionally.
  Each is narrowed at the point of use; every guard added this way covers only
  a case in which the C would have dereferenced NULL (R_NewMap and R_MarkLeaves
  run after CL_ParseServerInfo has set cl.worldmodel, R_SetupFrame always
  reassigns r_viewleaf from Mod_PointInLeaf, which cannot return NULL in this
  port, and cl_visedicts only ever holds entities with a model).
- `r_draworder.value = 0` in r_misc.ts's R_SetupFrame writes the cvar's
  numeric field without touching its string, exactly as the C does. Kept.
- `alight_t.plightvec` is a pointer in C; R_DrawViewModel's shipped behaviour
  of building `viewlightvec` from `vup` and then overwriting
  `r_viewlighting.plightvec` with the function-local `lightvec` a few lines
  later (so `viewlightvec` never reaches the rasterizer) is preserved.
- Dropped `#if id386` branches: R_Init's `Sys_MakeCodeWriteable
  (R_EdgeCodeStart...)`, R_ViewChanged's `R_Surf8Patch`/`R_Surf16Patch` +
  `colormap = vid.colormap` block. Dropped `#ifdef PASSAGES`: the
  `CreatePassages`/`SetVisibilityByPassages` prototypes, R_NewMap's
  `CreatePassages ()` and R_RenderView_'s `SetVisibilityByPassages ()` (the
  `#else` half, `R_MarkLeaves ()`, is what ships). Dropped `#ifdef QUAKE2`:
  R_DrawViewModel's `cl.light_level = r_viewlighting.ambientlight;`.
- `viewmodname` and `modcount` are defined by r_main.c and read by nothing in
  v1.09; they are kept on the documented `rMainDeadState` holder below so this
  module still exports everything the C file defined.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/r_main.c against WinQuake/r_main.c):
- `r_worldentity` (new, QW-only in the SOFTWARE r_main.c -- distinct from
  gl_rmain.c's own r_worldentity, which both WinQuake and QW's GL renderer
  already share unchanged): cleared and pointed at `cl.worldmodel` in
  R_NewMap; R_RenderView_'s NULL-worldmodel guard reads it instead of
  `cl_entities[0].model` under qw.active.
- `r_netgraph`/`r_zgraph` cvars (new) and their R_Init registration, and the
  R_RenderView_ call sites for R_NetGraph/R_ZGraph (r_misc.ts), are gated
  qw.active-only, matching WinQuake's R_Init having no such registration.
  `r_graphheight`'s default is 15 under qw.active (10 otherwise); both trees
  register the one shared cvar object, only the post-registration
  Cvar_SetValue differs.
- `R_SetVrect` gains QW's `full`-viewport logic (viewsize>=100 or
  intermission fills the screen; `cl_sbar.value`, src/qw/client/cl_main.ts,
  changes whether the statusbar height is subtracted) and drops the
  `lcd_x.value` halving block entirely.
- `R_DrawViewModel` adds `|| !Cam_DrawViewModel()` (src/qw/client/cl_cam.ts)
  to the suppression check, and reads the invisibility bit from
  `cl.stats[STAT_ITEMS]` (src/qw/bothdefs.ts) instead of `cl.items`.
- `R_InitTurb`'s loop bound is the literal 1280 under qw.active instead of
  `SIN_BUFFER_SIZE` (1408 in this tree) -- a QW bug, kept exactly as the C has it: see the
  comment at the call site.
- `currententity = cl_visedicts[i]` vs `&cl_visedicts[i]`: a C
  pointer-vs-value representation detail with no TS-observable difference
  (`cl_visedicts[i]` is already a reference either way) -- no-op, verified,
  not folded.
- `Sys_FloatTime` -> `Sys_DoubleTime` renames in R_EdgeDrawing/R_RenderView_'s
  r_dspeeds timers: see r_misc.ts's header for why this is a no-op in this
  port (both read a double-precision "current time in seconds").
*/

import { Cmd_AddCommand } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable, Cvar_SetValue } from "../common/cvar";
import { Con_Printf } from "../client/console";
// cvars gl_rmain.c also registers under the same name (render.ts's shared
// block); imported, not redefined, so a Cvar_Set reaches both renderers'
// objects because there is only one object. Re-exported below so existing
// `from "./r_main"` imports (r_surf.ts) keep working.
import { r_drawentities, r_drawviewmodel, r_fullbright, r_netgraph, r_speeds, EntityT } from "../client/render";
export { r_drawentities, r_drawviewmodel, r_fullbright, r_speeds };
import { Sys_Error, Sys_FloatTime, Sys_HighFPPrecision, Sys_LowFPPrecision } from "../platform/sys";
import { DotProduct, Length, M_PI, PLANE_ANYZ, type Vec3, VectorCopy, VectorInverse, VectorNormalize, VectorSubtract, vec3 } from "../common/mathlib";
import { Mod_LeafPVS } from "../common/model";
import type { MleafT, MnodeBaseT, MnodeT, ModelT } from "../common/model";
import { ModtypeT } from "../common/model";
import { MAX_DLIGHTS, cl, cl_dlights, cl_entities, cl_visedicts, clState } from "../client/client";
import { IT_INVISIBILITY, STAT_HEALTH } from "../common/quakedef";
import { qw } from "../common/quakedef";
import { STAT_ITEMS } from "../qw/bothdefs";
import { Cam_DrawViewModel } from "../qw/client/cl_cam";
import { cl_sbar } from "../qw/client/cl_main";
import { vidBackend, VrectT } from "../client/vid";
import { scr_fov, scr_viewsize } from "../client/screen";
import { lcd_x, V_SetContentsColor } from "../client/view";
import { R_ClearParticles, R_DrawParticles, R_InitParticles, R_ReadPointFile_f } from "../client/r_part";
import type * as QwRPartModule from "../qw/client/r_part";
import { S_ExtraUpdate } from "../client/snd_dma";
import {
  AlightT,
  AMP,
  AMP2,
  BMODEL_FULLY_CLIPPED,
  MINEDGES,
  MINSURFACES,
  NUMSTACKEDGES,
  NUMSTACKSURFACES,
  SIN_BUFFER_SIZE,
  XCENTERING,
  YCENTERING,
  allocEdges,
  allocSurfaces,
  base_modelorg,
  base_vpn,
  base_vright,
  base_vup,
  intsintable,
  modelorg,
  pfrustum_indexes,
  r_emaxs,
  r_emins,
  r_entorigin,
  r_origin,
  r_refdef,
  r_worldmodelorg,
  rState,
  screenedge,
  sintable,
  view_clipplanes,
  vpn,
  vright,
  vup,
} from "./r_local";
import { CYCLE, WARP_HEIGHT, WARP_WIDTH } from "./d_iface";
// siblings, each imported by its C name from the module its .c file maps to
import { D_Init, D_TurnZOn } from "./d_init";
import { R_SurfacePatch } from "./nonintel";
import { D_ViewChanged } from "./d_modech";
import { D_WarpScreen } from "./d_scan";
import { R_BeginEdgeFrame, R_ScanEdges } from "./r_edge";
import { R_DrawSolidClippedSubmodelPolygons, R_DrawSubmodelPolygons, R_RenderWorld, R_RotateBmodel } from "./r_bsp";
import { R_ZDrawSubmodelPolys } from "./r_draw";
import { R_SplitEntityOnNode2 } from "./r_efrag";
import { R_LightPoint, R_MarkLights } from "./r_light";
import { R_DrawSprite } from "./r_sprite";
import { R_AliasCheckBBox, R_AliasDrawModel } from "./r_alias";
import { R_NetGraph, R_PrintAliasStats, R_PrintDSpeeds, R_PrintTimes, R_SetupFrame, R_TimeGraph, R_TimeRefresh_f, R_TransformFrustum, R_ZGraph } from "./r_misc";

//define	PASSAGES

export const viewlightvec: Vec3 = vec3();
export const r_viewlighting: AlightT = new AlightT();
r_viewlighting.ambientlight = 128;
r_viewlighting.shadelight = 192;
r_viewlighting.plightvec = viewlightvec;

export const VIEWMODNAME_LENGTH = 256;

/*
Defined by r_main.c, read by no .c file in v1.09. Kept so this module exports
everything r_main.c defined; nothing in the port writes them.
*/
export const rMainDeadState: { viewmodname: string; modcount: number } = {
  viewmodname: "",
  modcount: 0,
};

export const r_draworder = new CvarT("r_draworder", "0");
export const r_timegraph = new CvarT("r_timegraph", "0");
export const r_graphheight = new CvarT("r_graphheight", "10");
export const r_clearcolor = new CvarT("r_clearcolor", "2");
export const r_waterwarp = new CvarT("r_waterwarp", "1");
export const r_aliasstats = new CvarT("r_polymodelstats", "0");
export const r_dspeeds = new CvarT("r_dspeeds", "0");
export const r_drawflat = new CvarT("r_drawflat", "0");
export const r_ambient = new CvarT("r_ambient", "0");
export const r_reportsurfout = new CvarT("r_reportsurfout", "0");
export const r_maxsurfs = new CvarT("r_maxsurfs", "0");
export const r_numsurfs = new CvarT("r_numsurfs", "0");
export const r_reportedgeout = new CvarT("r_reportedgeout", "0");
export const r_maxedges = new CvarT("r_maxedges", "0");
export const r_numedges = new CvarT("r_numedges", "0");
export const r_aliastransbase = new CvarT("r_aliastransbase", "200");
export const r_aliastransadj = new CvarT("r_aliastransadj", "100");

// QW r_main.c (new): registered/used only under qw.active; see R_Init/R_NewMap/
// R_RenderView_ below. `r_netgraph` is declared identically by gl_rmain.c and
// is read from outside both renderers (src/qw/client/screen.ts, gl_screen.c's
// call site), so it lives in src/client/render.ts's shared-cvar block and is
// re-exported here under its C name; `r_zgraph` is r_main.c's alone.
export { r_netgraph };
export const r_zgraph = new CvarT("r_zgraph", "0");

// QW r_main.c (new): `entity_t r_worldentity;`, distinct from gl_rmain.c's own
// r_worldentity (this file's header explains why the two renderers each own
// their own copy). Set from R_NewMap, read from R_RenderView_, both under
// qw.active.
export const r_worldentity = new EntityT();

// QW/client/r_part.c is a wholesale-different file (see src/qw/client/r_part.ts's
// own Q023b ruling): its own particle pool, `host_frametime` where WinQuake's
// R_DrawParticles reads `cl.time - cl.oldtime`, and a literal 800 gravity.
// r_main.c is compiled once per tree and linked against the r_part.c of its own
// tree, so under qw.active every particle entry point below has to reach the QW
// module -- the pool QW's cl_tent.c/cl_ents.c fill is otherwise not the pool
// this renderer initializes, clears and draws. Resolved lazily with Bun's
// synchronous require() rather than a static import, the same mechanism
// src/ref_soft/r_alias.ts uses for src/qw/client/skin.ts.
function qwRPartMod(): typeof QwRPartModule {
  return require("../qw/client/r_part");
}

/*
===============
R_Init
===============
*/
export function R_Init(): void {
  R_InitTurb();

  Cmd_AddCommand("timerefresh", R_TimeRefresh_f);
  Cmd_AddCommand("pointfile", qw.active ? qwRPartMod().R_ReadPointFile_f : R_ReadPointFile_f);

  Cvar_RegisterVariable(r_draworder);
  Cvar_RegisterVariable(r_speeds);
  Cvar_RegisterVariable(r_timegraph);
  Cvar_RegisterVariable(r_graphheight);
  Cvar_RegisterVariable(r_drawflat);
  Cvar_RegisterVariable(r_ambient);
  Cvar_RegisterVariable(r_clearcolor);
  Cvar_RegisterVariable(r_waterwarp);
  Cvar_RegisterVariable(r_fullbright);
  Cvar_RegisterVariable(r_drawentities);
  Cvar_RegisterVariable(r_drawviewmodel);
  Cvar_RegisterVariable(r_aliasstats);
  Cvar_RegisterVariable(r_dspeeds);
  Cvar_RegisterVariable(r_reportsurfout);
  Cvar_RegisterVariable(r_maxsurfs);
  Cvar_RegisterVariable(r_numsurfs);
  Cvar_RegisterVariable(r_reportedgeout);
  Cvar_RegisterVariable(r_maxedges);
  Cvar_RegisterVariable(r_numedges);
  Cvar_RegisterVariable(r_aliastransbase);
  Cvar_RegisterVariable(r_aliastransadj);

  // QW r_main.c registers these two unconditionally; WinQuake's R_Init has no
  // such call, so the registration itself is gated to keep WinQuake behavior
  // byte-identical when the flag is off.
  if (qw.active) {
    Cvar_RegisterVariable(r_netgraph);
    Cvar_RegisterVariable(r_zgraph);
    // QW r_main.c: `cvar_t r_graphheight = {"r_graphheight","15"};` (WinQuake:
    // "10"). r_graphheight itself is registered once, above, by both trees;
    // only the default differs.
    Cvar_SetValue("r_graphheight", 15);
  }

  Cvar_SetValue("r_maxedges", NUMSTACKEDGES);
  Cvar_SetValue("r_maxsurfs", NUMSTACKSURFACES);

  view_clipplanes[0].leftedge = 1;
  view_clipplanes[1].rightedge = 1;
  view_clipplanes[1].leftedge = view_clipplanes[2].leftedge = view_clipplanes[3].leftedge = 0;
  view_clipplanes[0].rightedge = view_clipplanes[2].rightedge = view_clipplanes[3].rightedge = 0;

  r_refdef.xOrigin = XCENTERING;
  r_refdef.yOrigin = YCENTERING;

  if (qw.active) qwRPartMod().R_InitParticles();
  else R_InitParticles();

  D_Init();
}

/*
===============
R_NewMap
===============
*/
export function R_NewMap(): void {
  let i: number;

  const worldmodel = cl.worldmodel;
  if (!worldmodel) Sys_Error("R_NewMap: NULL worldmodel");

  // QW r_main.c (new): `memset(&r_worldentity, 0, sizeof(r_worldentity));
  // r_worldentity.model = cl.worldmodel;`
  if (qw.active) {
    r_worldentity.clear();
    r_worldentity.model = worldmodel;
  }

  // clear out efrags in case the level hasn't been reloaded
  // FIXME: is this one short?
  for (i = 0; i < worldmodel.numleafs; i++) worldmodel.leafs[i].efrags = null;

  rState.r_viewleaf = null;
  if (qw.active) qwRPartMod().R_ClearParticles();
  else R_ClearParticles();

  rState.r_cnumsurfs = r_maxsurfs.value | 0;

  if (rState.r_cnumsurfs <= MINSURFACES) rState.r_cnumsurfs = MINSURFACES;

  if (rState.r_cnumsurfs > NUMSTACKSURFACES) {
    rState.surfaces = allocSurfaces(rState.r_cnumsurfs);
    rState.surface_p = 1;
    rState.surf_max = rState.r_cnumsurfs + 1;
    rState.r_surfsonstack = false;
    // surface 0 doesn't really exist; it's just a dummy because index 0
    // is used to indicate no edge attached to surface
    R_SurfacePatch();
  } else {
    rState.r_surfsonstack = true;
  }

  rState.r_maxedgesseen = 0;
  rState.r_maxsurfsseen = 0;

  rState.r_numallocatededges = r_maxedges.value | 0;

  if (rState.r_numallocatededges < MINEDGES) rState.r_numallocatededges = MINEDGES;

  if (rState.r_numallocatededges <= NUMSTACKEDGES) {
    rState.auxedges = null;
  } else {
    rState.auxedges = allocEdges(rState.r_numallocatededges);
  }

  rState.r_dowarpold = false;
  rState.r_viewchanged = false;
}

/*
===============
R_SetVrect
===============
*/
export function R_SetVrect(pvrectin: VrectT, pvrect: VrectT, lineadj: number): void {
  let h: number;
  let size: number;
  // QW r_main.c: `qboolean full`, tracks whether the view fills the screen
  // (viewsize>=100 or intermission) so the statusbar-visible height/position
  // rules below can special-case it. WinQuake has no such flag.
  let full = false;

  if (qw.active) {
    if (scr_viewsize.value >= 100.0) {
      size = 100.0;
      full = true;
    } else {
      size = scr_viewsize.value;
    }
  } else {
    size = scr_viewsize.value > 100 ? 100 : scr_viewsize.value;
  }

  if (cl.intermission) {
    if (qw.active) full = true;
    size = 100;
    lineadj = 0;
  }
  size /= 100;

  if (qw.active) {
    h = !cl_sbar.value && full ? pvrectin.height : pvrectin.height - lineadj;
  } else {
    h = pvrectin.height - lineadj;
  }

  if (qw.active && full) {
    pvrect.width = pvrectin.width;
  } else {
    pvrect.width = (pvrectin.width * size) | 0;
  }
  if (pvrect.width < 96) {
    size = 96.0 / pvrectin.width;
    pvrect.width = 96; // min for icons
  }
  pvrect.width &= ~7;
  pvrect.height = (pvrectin.height * size) | 0;
  if (qw.active) {
    if (cl_sbar.value || !full) {
      if (pvrect.height > pvrectin.height - lineadj) pvrect.height = pvrectin.height - lineadj;
    } else if (pvrect.height > pvrectin.height) {
      pvrect.height = pvrectin.height;
    }
  } else {
    if (pvrect.height > pvrectin.height - lineadj) pvrect.height = pvrectin.height - lineadj;
  }

  pvrect.height &= ~1;

  pvrect.x = ((pvrectin.width - pvrect.width) / 2) | 0;
  if (qw.active && full) {
    pvrect.y = 0;
  } else {
    pvrect.y = ((h - pvrect.height) / 2) | 0;
  }

  // QW r_main.c drops this `lcd_x` block entirely (it never existed in that
  // file's R_SetVrect).
  if (!qw.active) {
    if (lcd_x.value) {
      pvrect.y >>= 1;
      pvrect.height >>= 1;
    }
  }
}

/*
===============
R_ViewChanged

Called every time the vid structure or r_refdef changes.
Guaranteed to be called before the first refresh
===============
*/
export function R_ViewChanged(pvrect: VrectT, lineadj: number, aspect: number): void {
  let i: number;
  let res_scale: number;

  rState.r_viewchanged = true;

  R_SetVrect(pvrect, r_refdef.vrect, lineadj);

  r_refdef.horizontalFieldOfView = 2.0 * Math.tan((r_refdef.fov_x / 360) * M_PI);
  r_refdef.fvrectx = r_refdef.vrect.x;
  r_refdef.fvrectx_adj = r_refdef.vrect.x - 0.5;
  r_refdef.vrect_x_adj_shift20 = ((r_refdef.vrect.x << 20) + (1 << 19) - 1) | 0;
  r_refdef.fvrecty = r_refdef.vrect.y;
  r_refdef.fvrecty_adj = r_refdef.vrect.y - 0.5;
  r_refdef.vrectright = r_refdef.vrect.x + r_refdef.vrect.width;
  r_refdef.vrectright_adj_shift20 = ((r_refdef.vrectright << 20) + (1 << 19) - 1) | 0;
  r_refdef.fvrectright = r_refdef.vrectright;
  r_refdef.fvrectright_adj = r_refdef.vrectright - 0.5;
  r_refdef.vrectrightedge = r_refdef.vrectright - 0.99;
  r_refdef.vrectbottom = r_refdef.vrect.y + r_refdef.vrect.height;
  r_refdef.fvrectbottom = r_refdef.vrectbottom;
  r_refdef.fvrectbottom_adj = r_refdef.vrectbottom - 0.5;

  r_refdef.aliasvrect.x = (r_refdef.vrect.x * rState.r_aliasuvscale) | 0;
  r_refdef.aliasvrect.y = (r_refdef.vrect.y * rState.r_aliasuvscale) | 0;
  r_refdef.aliasvrect.width = (r_refdef.vrect.width * rState.r_aliasuvscale) | 0;
  r_refdef.aliasvrect.height = (r_refdef.vrect.height * rState.r_aliasuvscale) | 0;
  r_refdef.aliasvrectright = r_refdef.aliasvrect.x + r_refdef.aliasvrect.width;
  r_refdef.aliasvrectbottom = r_refdef.aliasvrect.y + r_refdef.aliasvrect.height;

  rState.pixelAspect = aspect;
  rState.xOrigin = r_refdef.xOrigin;
  rState.yOrigin = r_refdef.yOrigin;

  rState.screenAspect = (r_refdef.vrect.width * rState.pixelAspect) / r_refdef.vrect.height;
  // 320*200 1.0 pixelAspect = 1.6 screenAspect
  // 320*240 1.0 pixelAspect = 1.3333 screenAspect
  // proper 320*200 pixelAspect = 0.8333333

  rState.verticalFieldOfView = r_refdef.horizontalFieldOfView / rState.screenAspect;

  // values for perspective projection
  // if math were exact, the values would range from 0.5 to to range+0.5
  // hopefully they wll be in the 0.000001 to range+.999999 and truncate
  // the polygon rasterization will never render in the first row or column
  // but will definately render in the [range] row and column, so adjust the
  // buffer origin to get an exact edge to edge fill
  rState.xcenter = r_refdef.vrect.width * XCENTERING + r_refdef.vrect.x - 0.5;
  rState.aliasxcenter = rState.xcenter * rState.r_aliasuvscale;
  rState.ycenter = r_refdef.vrect.height * YCENTERING + r_refdef.vrect.y - 0.5;
  rState.aliasycenter = rState.ycenter * rState.r_aliasuvscale;

  rState.xscale = r_refdef.vrect.width / r_refdef.horizontalFieldOfView;
  rState.aliasxscale = rState.xscale * rState.r_aliasuvscale;
  rState.xscaleinv = 1.0 / rState.xscale;
  rState.yscale = rState.xscale * rState.pixelAspect;
  rState.aliasyscale = rState.yscale * rState.r_aliasuvscale;
  rState.yscaleinv = 1.0 / rState.yscale;
  rState.xscaleshrink = (r_refdef.vrect.width - 6) / r_refdef.horizontalFieldOfView;
  rState.yscaleshrink = rState.xscaleshrink * rState.pixelAspect;

  // left side clip
  screenedge[0].normal[0] = -1.0 / (rState.xOrigin * r_refdef.horizontalFieldOfView);
  screenedge[0].normal[1] = 0;
  screenedge[0].normal[2] = 1;
  screenedge[0].type = PLANE_ANYZ;

  // right side clip
  screenedge[1].normal[0] = 1.0 / ((1.0 - rState.xOrigin) * r_refdef.horizontalFieldOfView);
  screenedge[1].normal[1] = 0;
  screenedge[1].normal[2] = 1;
  screenedge[1].type = PLANE_ANYZ;

  // top side clip
  screenedge[2].normal[0] = 0;
  screenedge[2].normal[1] = -1.0 / (rState.yOrigin * rState.verticalFieldOfView);
  screenedge[2].normal[2] = 1;
  screenedge[2].type = PLANE_ANYZ;

  // bottom side clip
  screenedge[3].normal[0] = 0;
  screenedge[3].normal[1] = 1.0 / ((1.0 - rState.yOrigin) * rState.verticalFieldOfView);
  screenedge[3].normal[2] = 1;
  screenedge[3].type = PLANE_ANYZ;

  for (i = 0; i < 4; i++) VectorNormalize(screenedge[i].normal);

  res_scale = Math.sqrt((r_refdef.vrect.width * r_refdef.vrect.height) / (320.0 * 152.0)) * (2.0 / r_refdef.horizontalFieldOfView);
  rState.r_aliastransition = r_aliastransbase.value * res_scale;
  rState.r_resfudge = r_aliastransadj.value * res_scale;

  if (scr_fov.value <= 90.0) rState.r_fov_greater_than_90 = false;
  else rState.r_fov_greater_than_90 = true;

  D_ViewChanged();
}

/*
===============
R_MarkLeaves
===============
*/
export function R_MarkLeaves(): void {
  let vis: Uint8Array;
  let node: MnodeBaseT | null;
  let i: number;

  if (rState.r_oldviewleaf === rState.r_viewleaf) return;

  rState.r_visframecount++;
  rState.r_oldviewleaf = rState.r_viewleaf;

  const r_viewleaf = rState.r_viewleaf;
  const worldmodel = cl.worldmodel;
  if (!r_viewleaf || !worldmodel) return;

  vis = Mod_LeafPVS(r_viewleaf, worldmodel);

  for (i = 0; i < worldmodel.numleafs; i++) {
    if (vis[i >> 3] & (1 << (i & 7))) {
      node = worldmodel.leafs[i + 1];
      do {
        if (node.visframe === rState.r_visframecount) break;
        node.visframe = rState.r_visframecount;
        node = node.parent;
      } while (node);
    }
  }
}

/*
=============
R_DrawEntitiesOnList
=============
*/
export function R_DrawEntitiesOnList(): void {
  let i: number;
  let j: number;
  let lnum: number;
  const lighting = new AlightT();
  // FIXME: remove and do real lighting
  const lightvec: Vec3 = vec3(-1, 0, 0);
  const dist: Vec3 = vec3();
  let add: number;

  if (!r_drawentities.value) return;

  for (i = 0; i < clState.cl_numvisedicts; i++) {
    const currententity = cl_visedicts[i];
    rState.currententity = currententity;

    if (!currententity) continue;
    if (currententity === cl_entities[cl.viewentity]) continue; // don't draw the player

    const model = currententity.model;
    if (!model) continue;

    switch (model.type) {
      case ModtypeT.mod_sprite:
        VectorCopy(currententity.origin, r_entorigin);
        VectorSubtract(r_origin, r_entorigin, modelorg);
        R_DrawSprite();
        break;

      case ModtypeT.mod_alias:
        VectorCopy(currententity.origin, r_entorigin);
        VectorSubtract(r_origin, r_entorigin, modelorg);

        // see if the bounding box lets us trivially reject, also sets
        // trivial accept status
        if (R_AliasCheckBBox()) {
          j = R_LightPoint(currententity.origin);

          lighting.ambientlight = j;
          lighting.shadelight = j;

          lighting.plightvec = lightvec;

          for (lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
            if (cl_dlights[lnum].die >= cl.time) {
              VectorSubtract(currententity.origin, cl_dlights[lnum].origin, dist);
              add = cl_dlights[lnum].radius - Length(dist);

              if (add > 0) lighting.ambientlight += add;
            }
          }

          // clamp lighting so it doesn't overbright as much
          if (lighting.ambientlight > 128) lighting.ambientlight = 128;
          if (lighting.ambientlight + lighting.shadelight > 192) lighting.shadelight = 192 - lighting.ambientlight;

          R_AliasDrawModel(lighting);
        }

        break;

      default:
        break;
    }
  }
}

/*
=============
R_DrawViewModel
=============
*/
export function R_DrawViewModel(): void {
  // FIXME: remove and do real lighting
  const lightvec: Vec3 = vec3(-1, 0, 0);
  let j: number;
  let lnum: number;
  const dist: Vec3 = vec3();
  let add: number;

  // QW r_main.c adds `|| !Cam_DrawViewModel()` (spectator/chase-cam suppresses
  // the view model; src/qw/client/cl_cam.ts).
  if (!r_drawviewmodel.value || rState.r_fov_greater_than_90 || (qw.active && !Cam_DrawViewModel())) return;

  // QW reads the invisibility bit from the stats array (`cl.stats[STAT_ITEMS]`,
  // how QW's cl_parse.c delivers item flags) instead of WinQuake's `cl.items`.
  if (qw.active ? cl.stats[STAT_ITEMS] & IT_INVISIBILITY : cl.items & IT_INVISIBILITY) return;

  if (cl.stats[STAT_HEALTH] <= 0) return;

  const currententity = cl.viewent;
  rState.currententity = currententity;
  if (!currententity.model) return;

  VectorCopy(currententity.origin, r_entorigin);
  VectorSubtract(r_origin, r_entorigin, modelorg);

  VectorCopy(vup, viewlightvec);
  VectorInverse(viewlightvec);

  j = R_LightPoint(currententity.origin);

  if (j < 24) j = 24; // allways give some light on gun
  r_viewlighting.ambientlight = j;
  r_viewlighting.shadelight = j;

  // add dynamic lights
  for (lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
    const dl = cl_dlights[lnum];
    if (!dl.radius) continue;
    if (!dl.radius) continue;
    if (dl.die < cl.time) continue;

    VectorSubtract(currententity.origin, dl.origin, dist);
    add = dl.radius - Length(dist);
    if (add > 0) r_viewlighting.ambientlight += add;
  }

  // clamp lighting so it doesn't overbright as much
  if (r_viewlighting.ambientlight > 128) r_viewlighting.ambientlight = 128;
  if (r_viewlighting.ambientlight + r_viewlighting.shadelight > 192) r_viewlighting.shadelight = 192 - r_viewlighting.ambientlight;

  r_viewlighting.plightvec = lightvec;

  R_AliasDrawModel(r_viewlighting);
}

/*
=============
R_BmodelCheckBBox
=============
*/
export function R_BmodelCheckBBox(clmodel: ModelT, minmaxs: Float32Array): number {
  let i: number;
  let pindex: Int32Array;
  let clipflags: number;
  const acceptpt: Vec3 = vec3();
  const rejectpt: Vec3 = vec3();
  let d: number;

  clipflags = 0;

  const currententity = rState.currententity;
  if (!currententity) return clipflags;

  if (currententity.angles[0] || currententity.angles[1] || currententity.angles[2]) {
    for (i = 0; i < 4; i++) {
      d = DotProduct(currententity.origin, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;

      if (d <= -clmodel.radius) return BMODEL_FULLY_CLIPPED;

      if (d <= clmodel.radius) clipflags |= 1 << i;
    }
  } else {
    for (i = 0; i < 4; i++) {
      // generate accept and reject points
      // FIXME: do with fast look-ups or integer tests based on the sign bit
      // of the floating point values

      pindex = pfrustum_indexes[i];

      rejectpt[0] = minmaxs[pindex[0]];
      rejectpt[1] = minmaxs[pindex[1]];
      rejectpt[2] = minmaxs[pindex[2]];

      d = DotProduct(rejectpt, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;

      if (d <= 0) return BMODEL_FULLY_CLIPPED;

      acceptpt[0] = minmaxs[pindex[3 + 0]];
      acceptpt[1] = minmaxs[pindex[3 + 1]];
      acceptpt[2] = minmaxs[pindex[3 + 2]];

      d = DotProduct(acceptpt, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;

      if (d <= 0) clipflags |= 1 << i;
    }
  }

  return clipflags;
}

/*
TypeScript narrows `rState.r_pefragtopnode` to `null` from the assignment in
R_DrawBEntitiesOnList and does not widen it again across the
R_SplitEntityOnNode2 call that actually sets it, so the read goes through this
helper, where the declared type stands.
*/
function readPefragTopnode(): MnodeT | MleafT | null {
  return rState.r_pefragtopnode;
}

/*
=============
R_DrawBEntitiesOnList
=============
*/
export function R_DrawBEntitiesOnList(): void {
  let i: number;
  let j: number;
  let k: number;
  let clipflags: number;
  const oldorigin: Vec3 = vec3();
  let clmodel: ModelT;
  const minmaxs = new Float32Array(6);

  if (!r_drawentities.value) return;

  const worldmodel = cl.worldmodel;
  if (!worldmodel) return;

  VectorCopy(modelorg, oldorigin);
  rState.insubmodel = true;
  rState.r_dlightframecount = rState.r_framecount;

  for (i = 0; i < clState.cl_numvisedicts; i++) {
    const currententity = cl_visedicts[i];
    rState.currententity = currententity;

    if (!currententity) continue;
    const model = currententity.model;
    if (!model) continue;

    switch (model.type) {
      case ModtypeT.mod_brush:
        clmodel = model;

        // see if the bounding box lets us trivially reject, also sets
        // trivial accept status
        for (j = 0; j < 3; j++) {
          minmaxs[j] = currententity.origin[j] + clmodel.mins[j];
          minmaxs[3 + j] = currententity.origin[j] + clmodel.maxs[j];
        }

        clipflags = R_BmodelCheckBBox(clmodel, minmaxs);

        if (clipflags !== BMODEL_FULLY_CLIPPED) {
          VectorCopy(currententity.origin, r_entorigin);
          VectorSubtract(r_origin, r_entorigin, modelorg);
          // FIXME: is this needed?
          VectorCopy(modelorg, r_worldmodelorg);

          rState.r_pcurrentvertbase = clmodel.vertexes;

          // FIXME: stop transforming twice
          R_RotateBmodel();

          // calculate dynamic lighting for bmodel if it's not an
          // instanced model
          if (clmodel.firstmodelsurface !== 0) {
            for (k = 0; k < MAX_DLIGHTS; k++) {
              if (cl_dlights[k].die < cl.time || !cl_dlights[k].radius) {
                continue;
              }

              R_MarkLights(cl_dlights[k], 1 << k, clmodel.nodes[clmodel.hulls[0].firstclipnode]);
            }
          }

          // if the driver wants polygons, deliver those. Z-buffering is on
          // at this point, so no clipping to the world tree is needed, just
          // frustum clipping
          if (rState.r_drawpolys || rState.r_drawculledpolys) {
            R_ZDrawSubmodelPolys(clmodel);
          } else {
            rState.r_pefragtopnode = null;

            for (j = 0; j < 3; j++) {
              r_emins[j] = minmaxs[j];
              r_emaxs[j] = minmaxs[3 + j];
            }

            R_SplitEntityOnNode2(worldmodel.nodes[0]);

            const topnode = readPefragTopnode();
            if (topnode) {
              currententity.topnode = topnode;

              if (topnode.contents >= 0) {
                // not a leaf; has to be clipped to the world BSP
                rState.r_clipflags = clipflags;
                R_DrawSolidClippedSubmodelPolygons(clmodel);
              } else {
                // falls entirely in one leaf, so we just put all the
                // edges in the edge list and let 1/z sorting handle
                // drawing order
                R_DrawSubmodelPolygons(clmodel, clipflags);
              }

              currententity.topnode = null;
            }
          }

          // put back world rotation and frustum clipping
          // FIXME: R_RotateBmodel should just work off base_vxx
          VectorCopy(base_vpn, vpn);
          VectorCopy(base_vup, vup);
          VectorCopy(base_vright, vright);
          VectorCopy(base_modelorg, modelorg);
          VectorCopy(oldorigin, modelorg);
          R_TransformFrustum();
        }

        break;

      default:
        break;
    }
  }

  rState.insubmodel = false;
}

/*
================
R_EdgeDrawing
================
*/
// C: two stack arrays in R_EdgeDrawing, sized NUMSTACKEDGES / NUMSTACKSURFACES
// plus a cache-line's worth of alignment slack. See this file's header.
const ledges = allocEdges(NUMSTACKEDGES);
const lsurfs = allocSurfaces(NUMSTACKSURFACES);

export function R_EdgeDrawing(): void {
  if (rState.auxedges) {
    rState.r_edges = rState.auxedges;
  } else {
    rState.r_edges = ledges;
  }

  if (rState.r_surfsonstack) {
    rState.surfaces = lsurfs;
    rState.surf_max = rState.r_cnumsurfs + 1;
    // surface 0 doesn't really exist; it's just a dummy because index 0
    // is used to indicate no edge attached to surface
    R_SurfacePatch();
  }

  R_BeginEdgeFrame();

  if (r_dspeeds.value) {
    rState.rw_time1 = Sys_FloatTime();
  }

  R_RenderWorld();

  if (rState.r_drawculledpolys) R_ScanEdges();

  // only the world can be drawn back to front with no z reads or compares, just
  // z writes, so have the driver turn z compares on now
  D_TurnZOn();

  if (r_dspeeds.value) {
    rState.rw_time2 = Sys_FloatTime();
    rState.db_time1 = rState.rw_time2;
  }

  R_DrawBEntitiesOnList();

  if (r_dspeeds.value) {
    rState.db_time2 = Sys_FloatTime();
    rState.se_time1 = rState.db_time2;
  }

  if (!r_dspeeds.value) {
    vidBackend.current?.VID_UnlockBuffer();
    S_ExtraUpdate(); // don't let sound get messed up if going slow
    vidBackend.current?.VID_LockBuffer();
  }

  if (!(rState.r_drawpolys || rState.r_drawculledpolys)) R_ScanEdges();
}

/*
================
R_RenderView

r_refdef must be set before the first call
================
*/
// C: `byte warpbuffer[WARP_WIDTH * WARP_HEIGHT];` on R_RenderView_'s stack
const warpbuffer = new Uint8Array(WARP_WIDTH * WARP_HEIGHT);

export function R_RenderView_(): void {
  rState.r_warpbuffer = warpbuffer;

  if (r_timegraph.value || r_speeds.value || r_dspeeds.value) rState.r_time1 = Sys_FloatTime();

  R_SetupFrame();

  R_MarkLeaves(); // done here so we know if we're in water

  // make FDIV fast. This reduces timing precision after we've been running for a
  // while, so we don't do it globally.  This also sets chop mode, and we do it
  // here so that setup stuff like the refresh area calculations match what's
  // done in screen.c
  Sys_LowFPPrecision();

  // QW r_main.c checks `r_worldentity.model` (this file's own, set in
  // R_NewMap) instead of `cl_entities[0].model`.
  if ((qw.active ? !r_worldentity.model : !cl_entities[0].model) || !cl.worldmodel) Sys_Error("R_RenderView: NULL worldmodel");

  if (!r_dspeeds.value) {
    vidBackend.current?.VID_UnlockBuffer();
    S_ExtraUpdate(); // don't let sound get messed up if going slow
    vidBackend.current?.VID_LockBuffer();
  }

  R_EdgeDrawing();

  if (!r_dspeeds.value) {
    vidBackend.current?.VID_UnlockBuffer();
    S_ExtraUpdate(); // don't let sound get messed up if going slow
    vidBackend.current?.VID_LockBuffer();
  }

  if (r_dspeeds.value) {
    rState.se_time2 = Sys_FloatTime();
    rState.de_time1 = rState.se_time2;
  }

  R_DrawEntitiesOnList();

  if (r_dspeeds.value) {
    rState.de_time2 = Sys_FloatTime();
    rState.dv_time1 = rState.de_time2;
  }

  R_DrawViewModel();

  if (r_dspeeds.value) {
    rState.dv_time2 = Sys_FloatTime();
    rState.dp_time1 = Sys_FloatTime();
  }

  if (qw.active) qwRPartMod().R_DrawParticles();
  else R_DrawParticles();

  if (r_dspeeds.value) rState.dp_time2 = Sys_FloatTime();

  if (rState.r_dowarp) D_WarpScreen();

  const r_viewleaf = rState.r_viewleaf;
  if (r_viewleaf) V_SetContentsColor(r_viewleaf.contents);

  if (r_timegraph.value) R_TimeGraph();

  if (r_aliasstats.value) R_PrintAliasStats();

  if (r_speeds.value) R_PrintTimes();

  if (r_dspeeds.value) R_PrintDSpeeds();

  if (r_reportsurfout.value && rState.r_outofsurfaces) Con_Printf("Short %d surfaces\n", rState.r_outofsurfaces);

  if (r_reportedgeout.value && rState.r_outofedges) Con_Printf("Short roughly %d edges\n", ((rState.r_outofedges * 2) / 3) | 0);

  // QW r_main.c (new): the r_netgraph/r_zgraph debug overlays.
  if (qw.active && r_netgraph.value) R_NetGraph();
  if (qw.active && r_zgraph.value) R_ZGraph();

  // back to high floating-point precision
  Sys_HighFPPrecision();
}

export function R_RenderView(): void {
  R_RenderView_();
}

/*
================
R_InitTurb
================
*/
export function R_InitTurb(): void {
  let i: number;

  // QW r_main.c hardcodes the loop bound to the literal 1280 instead of
  // SIN_BUFFER_SIZE (1280 + CYCLE = 1408 in this tree's r_shared.h/.ts, which
  // is unchanged between WinQuake and QW): a genuine QW bug that leaves
  // sintable/intsintable[1280..1407] at their zero-initialized value. Kept
  // exactly as the original per PORTING.md.
  const bound = qw.active ? 1280 : SIN_BUFFER_SIZE;
  for (i = 0; i < bound; i++) {
    sintable[i] = (AMP + Math.sin((i * 3.14159 * 2) / CYCLE) * AMP) | 0;
    intsintable[i] = (AMP2 + Math.sin((i * 3.14159 * 2) / CYCLE) * AMP2) | 0; // AMP2, not 20
  }
}
