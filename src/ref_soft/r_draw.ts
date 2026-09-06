/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_draw.c (GNU GPL v2 or later).

r_draw.c: the edge-based rasterizer's front end -- R_EmitEdge/R_ClipEdge
walk a face's edges into the screen-space edge lists (`newedges`/
`removeedges`, r_local.ts) that R_ScanEdges (r_edge.c, U063) later sweeps;
R_RenderFace/R_RenderBmodelFace post one `SurfT` per visible face;
R_RenderPoly/R_ZDrawSubmodelPolys are the polygon-based (non-edge) debug/
z-fill path used for `r_drawpolys` and clipped submodel z-filling.

Deviations from PORTING.md / the C source:
- `cacheoffset`, `r_leftclipped`/`r_rightclipped`, `makeleftedge`/
  `makerightedge`, `r_nearzionly`, `r_emitted`, `r_nearzi`, `r_u1`/`r_v1`/
  `r_lzi1`, `r_ceilv1`, `r_lastvertvalid`, `r_leftenter`/`r_leftexit`/
  `r_rightenter`/`r_rightexit` are non-static C globals, but r_shared.ts's
  `RStateT` (out of this unit's SCOPE) lists only `c_faceclip` and
  `r_pedge` under "r_draw.c" -- no other unit's brief reads these, so they
  stay module-private state here rather than fields this unit would need to
  add to a landed file.
- `mvertex_t clipvert` inside R_ClipEdge is a fresh per-call stack local in
  C; every recursive call gets its own. Ported as `new MvertexT()` per
  branch (not a shared scratch object), for the same reason: a shared
  buffer would alias a still-live `pv0`/`pv1` argument one recursion level
  down.
- `edge->surfs[0] = surface_p - surfaces` (a pointer difference) and
  `cacheoffset = (byte *)edge_p - (byte *)r_edges` (ditto) are both INDEX
  values already in this port (`rState.surface_p`, `rState.edge_p`), per
  r_shared.ts's own documented pointer-to-index convention, so they are
  used directly with no arithmetic.
- `medge_t tedge` (R_RenderFace's and R_RenderBmodelFace's each own local,
  used only as a dummy `r_pedge` target for the two after-the-fact
  left/right-edge `R_ClipEdge` calls) is `new MedgeT()` per call, matching
  the C's fresh stack local.
- `TransformVector` (r_misc.c, U062) and `D_DrawPoly` (d_edge.c, U065 --
  d_polyse.c's ownership comment names it, but it landed in d_edge.ts)
  landed concurrently with this unit; imported by name.
- `mvertex_t verts[2][100]` / `polyvert_t pverts[100]` in R_RenderPoly (the
  C's own "FIXME: do real number" comments) become module-level pools sized
  100, matching the C array size; `verts[page][i].position` becomes a plain
  `Vec3` (only `.position` is ever read/written on these locals in the C).
- Dropped `#if id386` branch: R_EmitEdge's and R_ClipEdge's asm bodies (this
  file's own `#if !id386` guard names the portable fallback ported here as
  the only version).
- `R_EmitEdge`/`R_ClipEdge`/`R_EmitCachedEdge` are declared without `static`
  in the C (external linkage, even though r_local.h's own ownership summary
  only calls out R_RenderFace/R_RenderBmodelFace/R_RenderPoly/
  R_ZDrawSubmodelPolys by name); exported here so this unit's own
  ref_soft_draw.test.ts can drive them directly, which is at least as
  faithful to the C's actual visibility as leaving them file-private.
*/

import { DotProduct, PLANE_ANYX, PLANE_ANYY, PLANE_ANYZ, PLANE_X, PLANE_Y, PLANE_Z, VectorSubtract, type Vec3, vec3 } from "../common/mathlib";
import { MedgeT, MvertexT, SURF_PLANEBACK, type ModelT, type MsurfaceT } from "../common/model";
import { Sys_Error } from "../platform/sys";
import { PolyvertT, r_polydesc } from "./d_iface";
import { BACKFACE_EPSILON, BedgeT, ClipplaneT, NEAR_CLIP, modelorg, newedges, r_refdef, removeedges, rState, view_clipplanes } from "./r_local";
import { TransformVector } from "./r_misc";
import { D_DrawPoly } from "./d_edge";

// !!! if these are changed, they must be changed in asm_draw.h too !!!
const FULLY_CLIPPED_CACHED = 0x80000000 | 0;
const FRAMECOUNT_MASK = 0x7fffffff;

let cacheoffset = 0;

let r_leftclipped = false;
let r_rightclipped = false;
let makeleftedge = false;
let makerightedge = false;
let r_nearzionly = false;

let r_emitted = 0;
let r_nearzi = 0;
let r_u1 = 0;
let r_v1 = 0;
let r_lzi1 = 0;
let r_ceilv1 = 0;

let r_lastvertvalid = false;

const r_leftenter = new MvertexT();
const r_leftexit = new MvertexT();
const r_rightenter = new MvertexT();
const r_rightexit = new MvertexT();

function copyVertex(dst: MvertexT, src: MvertexT): void {
  dst.position[0] = src.position[0];
  dst.position[1] = src.position[1];
  dst.position[2] = src.position[2];
}

/*
================
R_EmitEdge
================
*/
export function R_EmitEdge(pv0: MvertexT, pv1: MvertexT): void {
  let u0: number;
  let v0: number;
  let lzi0: number;
  let ceilv0: number;

  if (r_lastvertvalid) {
    u0 = r_u1;
    v0 = r_v1;
    lzi0 = r_lzi1;
    ceilv0 = r_ceilv1;
  } else {
    const local0: Vec3 = vec3();
    const transformed0: Vec3 = vec3();

    // transform and project
    VectorSubtract(pv0.position, modelorg, local0);
    TransformVector(local0, transformed0);

    if (transformed0[2] < NEAR_CLIP) transformed0[2] = NEAR_CLIP;

    lzi0 = 1.0 / transformed0[2];

    // FIXME: build x/yscale into transform?
    let scale = rState.xscale * lzi0;
    u0 = rState.xcenter + scale * transformed0[0];
    if (u0 < r_refdef.fvrectx_adj) u0 = r_refdef.fvrectx_adj;
    if (u0 > r_refdef.fvrectright_adj) u0 = r_refdef.fvrectright_adj;

    scale = rState.yscale * lzi0;
    v0 = rState.ycenter - scale * transformed0[1];
    if (v0 < r_refdef.fvrecty_adj) v0 = r_refdef.fvrecty_adj;
    if (v0 > r_refdef.fvrectbottom_adj) v0 = r_refdef.fvrectbottom_adj;

    ceilv0 = Math.ceil(v0);
  }

  const local1: Vec3 = vec3();
  const transformed1: Vec3 = vec3();

  // transform and project
  VectorSubtract(pv1.position, modelorg, local1);
  TransformVector(local1, transformed1);

  if (transformed1[2] < NEAR_CLIP) transformed1[2] = NEAR_CLIP;

  r_lzi1 = 1.0 / transformed1[2];

  let scale = rState.xscale * r_lzi1;
  r_u1 = rState.xcenter + scale * transformed1[0];
  if (r_u1 < r_refdef.fvrectx_adj) r_u1 = r_refdef.fvrectx_adj;
  if (r_u1 > r_refdef.fvrectright_adj) r_u1 = r_refdef.fvrectright_adj;

  scale = rState.yscale * r_lzi1;
  r_v1 = rState.ycenter - scale * transformed1[1];
  if (r_v1 < r_refdef.fvrecty_adj) r_v1 = r_refdef.fvrecty_adj;
  if (r_v1 > r_refdef.fvrectbottom_adj) r_v1 = r_refdef.fvrectbottom_adj;

  if (r_lzi1 > lzi0) lzi0 = r_lzi1;

  if (lzi0 > r_nearzi) r_nearzi = lzi0; // for mipmap finding

  // for right edges, all we want is the effect on 1/z
  if (r_nearzionly) return;

  r_emitted = 1;

  r_ceilv1 = Math.ceil(r_v1);

  // create the edge
  if (ceilv0 === r_ceilv1) {
    // we cache unclipped horizontal edges as fully clipped
    if (cacheoffset !== 0x7fffffff) {
      cacheoffset = (FULLY_CLIPPED_CACHED | (rState.r_framecount & FRAMECOUNT_MASK)) | 0;
    }

    return; // horizontal edge
  }

  const side = ceilv0 > r_ceilv1 ? 1 : 0;

  if (rState.r_edges === null || rState.surfaces === null) Sys_Error("R_EmitEdge: pools not allocated");
  const edge = rState.r_edges[rState.edge_p];
  rState.edge_p++;

  edge.owner = rState.r_pedge;
  edge.nearzi = lzi0;

  let v: number;
  let v2: number;
  let u: number;
  let u_step: number;

  if (side === 0) {
    // trailing edge (go from p1 to p2)
    v = ceilv0;
    v2 = r_ceilv1 - 1;

    edge.surfs[0] = rState.surface_p;
    edge.surfs[1] = 0;

    u_step = (r_u1 - u0) / (r_v1 - v0);
    u = u0 + (v - v0) * u_step;
  } else {
    // leading edge (go from p2 to p1)
    v2 = ceilv0 - 1;
    v = r_ceilv1;

    edge.surfs[0] = 0;
    edge.surfs[1] = rState.surface_p;

    u_step = (u0 - r_u1) / (v0 - r_v1);
    u = r_u1 + (v - r_v1) * u_step;
  }

  edge.u_step = (u_step * 0x100000) | 0;
  edge.u = (u * 0x100000 + 0xfffff) | 0;

  // we need to do this to avoid stepping off the edges if a very nearly
  // horizontal edge is less than epsilon above a scan, and numeric error causes
  // it to incorrectly extend to the scan, and the extension of the line goes off
  // the edge of the screen
  // FIXME: is this actually needed?
  if (edge.u < r_refdef.vrect_x_adj_shift20) edge.u = r_refdef.vrect_x_adj_shift20;
  if (edge.u > r_refdef.vrectright_adj_shift20) edge.u = r_refdef.vrectright_adj_shift20;

  //
  // sort the edge in normally
  //
  let u_check = edge.u;
  if (edge.surfs[0]) u_check++; // sort trailers after leaders

  const head = newedges[v];
  if (head === null || head.u >= u_check) {
    edge.next = head;
    newedges[v] = edge;
  } else {
    let pcheck = head;
    while (pcheck.next !== null && pcheck.next.u < u_check) pcheck = pcheck.next;
    edge.next = pcheck.next;
    pcheck.next = edge;
  }

  edge.nextremove = removeedges[v2];
  removeedges[v2] = edge;
}

/*
================
R_ClipEdge
================
*/
export function R_ClipEdge(pv0: MvertexT, pv1: MvertexT, clip: ClipplaneT | null): void {
  if (clip !== null) {
    let c: ClipplaneT | null = clip;
    do {
      const d0 = DotProduct(pv0.position, c.normal) - c.dist;
      const d1 = DotProduct(pv1.position, c.normal) - c.dist;

      if (d0 >= 0) {
        if (d1 >= 0) {
          // both points are unclipped
          c = c.next;
          continue;
        }

        // only point 1 is clipped

        // we don't cache clipped edges
        cacheoffset = 0x7fffffff;

        const f = d0 / (d0 - d1);
        const clipvert = new MvertexT();
        clipvert.position[0] = pv0.position[0] + f * (pv1.position[0] - pv0.position[0]);
        clipvert.position[1] = pv0.position[1] + f * (pv1.position[1] - pv0.position[1]);
        clipvert.position[2] = pv0.position[2] + f * (pv1.position[2] - pv0.position[2]);

        if (c.leftedge) {
          r_leftclipped = true;
          copyVertex(r_leftexit, clipvert);
        } else if (c.rightedge) {
          r_rightclipped = true;
          copyVertex(r_rightexit, clipvert);
        }

        R_ClipEdge(pv0, clipvert, c.next);
        return;
      } else {
        // point 0 is clipped
        if (d1 < 0) {
          // both points are clipped
          // we do cache fully clipped edges
          if (!r_leftclipped) {
            cacheoffset = (FULLY_CLIPPED_CACHED | (rState.r_framecount & FRAMECOUNT_MASK)) | 0;
          }
          return;
        }

        // only point 0 is clipped
        r_lastvertvalid = false;

        // we don't cache partially clipped edges
        cacheoffset = 0x7fffffff;

        const f = d0 / (d0 - d1);
        const clipvert = new MvertexT();
        clipvert.position[0] = pv0.position[0] + f * (pv1.position[0] - pv0.position[0]);
        clipvert.position[1] = pv0.position[1] + f * (pv1.position[1] - pv0.position[1]);
        clipvert.position[2] = pv0.position[2] + f * (pv1.position[2] - pv0.position[2]);

        if (c.leftedge) {
          r_leftclipped = true;
          copyVertex(r_leftenter, clipvert);
        } else if (c.rightedge) {
          r_rightclipped = true;
          copyVertex(r_rightenter, clipvert);
        }

        R_ClipEdge(clipvert, pv1, c.next);
        return;
      }
    } while (c !== null);
  }

  // add the edge
  R_EmitEdge(pv0, pv1);
}

/*
================
R_EmitCachedEdge
================
*/
export function R_EmitCachedEdge(): void {
  if (rState.r_edges === null || rState.r_pedge === null) Sys_Error("R_EmitCachedEdge: not set up");

  const pedge_t = rState.r_edges[rState.r_pedge.cachededgeoffset];

  if (!pedge_t.surfs[0]) pedge_t.surfs[0] = rState.surface_p;
  else pedge_t.surfs[1] = rState.surface_p;

  if (pedge_t.nearzi > r_nearzi) r_nearzi = pedge_t.nearzi; // for mipmap finding

  r_emitted = 1;
}

/*
The "push the edges through" prologue shared verbatim by R_RenderFace and
R_RenderBmodelFace in r_draw.c: it resets this file's edge-emission statics
(r_emitted, r_nearzi, r_nearzionly, makeleftedge, makerightedge,
r_lastvertvalid). Factored so a test that drives R_ClipEdge/R_EmitEdge
directly can reset them through real code instead of reaching into statics.
*/
export function R_BeginFaceEdges(): void {
  r_emitted = 0;
  r_nearzi = 0;
  r_nearzionly = false;
  makeleftedge = false;
  makerightedge = false;
  r_lastvertvalid = false;
}

/*
================
R_RenderFace
================
*/
export function R_RenderFace(fa: MsurfaceT, clipflags: number): void {
  // skip out if no more surfs
  if (rState.surface_p >= rState.surf_max) {
    rState.r_outofsurfaces++;
    return;
  }

  // ditto if not enough edges left, or switch to auxedges if possible
  if (rState.edge_p + fa.numedges + 4 >= rState.edge_max) {
    rState.r_outofedges += fa.numedges;
    return;
  }

  rState.c_faceclip++;

  // set up clip planes
  let pclip: ClipplaneT | null = null;

  let mask = 0x08;
  for (let i = 3; i >= 0; i--, mask >>= 1) {
    if (clipflags & mask) {
      view_clipplanes[i].next = pclip;
      pclip = view_clipplanes[i];
    }
  }

  const ent = rState.currententity;
  if (ent === null || ent.model === null) Sys_Error("R_RenderFace: no current entity/model");
  const model = ent.model;
  const vertbase = rState.r_pcurrentvertbase;
  if (vertbase === null) Sys_Error("R_RenderFace: no vertex base");

  // push the edges through
  R_BeginFaceEdges();
  const pedges = model.edges;

  const tedge = new MedgeT();

  for (let i = 0; i < fa.numedges; i++) {
    let lindex = model.surfedges[fa.firstedge + i];

    let pedge: MedgeT;
    let v0: MvertexT;
    let v1: MvertexT;

    if (lindex > 0) {
      pedge = pedges[lindex];
      v0 = vertbase[pedge.v[0]];
      v1 = vertbase[pedge.v[1]];
    } else {
      lindex = -lindex;
      pedge = pedges[lindex];
      v0 = vertbase[pedge.v[1]];
      v1 = vertbase[pedge.v[0]];
    }

    rState.r_pedge = pedge;

    // if the edge is cached, we can just reuse the edge
    if (!rState.insubmodel) {
      if (pedge.cachededgeoffset & FULLY_CLIPPED_CACHED) {
        if ((pedge.cachededgeoffset & FRAMECOUNT_MASK) === rState.r_framecount) {
          r_lastvertvalid = false;
          continue;
        }
      } else if (rState.edge_p > pedge.cachededgeoffset && rState.r_edges !== null && rState.r_edges[pedge.cachededgeoffset].owner === pedge) {
        R_EmitCachedEdge();
        r_lastvertvalid = false;
        continue;
      }
    }

    // assume it's cacheable
    cacheoffset = rState.edge_p;
    r_leftclipped = false;
    r_rightclipped = false;
    R_ClipEdge(v0, v1, pclip);
    pedge.cachededgeoffset = cacheoffset;

    if (r_leftclipped) makeleftedge = true;
    if (r_rightclipped) makerightedge = true;
    r_lastvertvalid = true;
  }

  // if there was a clip off the left edge, add that edge too
  // FIXME: faster to do in screen space?
  // FIXME: share clipped edges?
  if (makeleftedge) {
    rState.r_pedge = tedge;
    r_lastvertvalid = false;
    if (pclip === null) Sys_Error("R_RenderFace: makeleftedge with no clip plane");
    R_ClipEdge(r_leftexit, r_leftenter, pclip.next);
  }

  // if there was a clip off the right edge, get the right r_nearzi
  if (makerightedge) {
    rState.r_pedge = tedge;
    r_lastvertvalid = false;
    r_nearzionly = true;
    R_ClipEdge(r_rightexit, r_rightenter, view_clipplanes[1].next);
  }

  // if no edges made it out, return without posting the surface
  if (!r_emitted) return;

  rState.r_polycount++;

  if (rState.surfaces === null) Sys_Error("R_RenderFace: no surface pool");
  const surf = rState.surfaces[rState.surface_p];
  surf.data = fa;
  surf.nearzi = r_nearzi;
  surf.flags = fa.flags;
  surf.insubmodel = rState.insubmodel;
  surf.spanstate = 0;
  surf.entity = ent;
  surf.key = rState.r_currentkey++;
  surf.spans = null;

  const pplane = fa.plane;
  if (pplane === null) Sys_Error("R_RenderFace: no plane");
  // FIXME: cache this?
  const p_normal: Vec3 = vec3();
  TransformVector(pplane.normal, p_normal);
  // FIXME: cache this?
  const distinv = 1.0 / (pplane.dist - DotProduct(modelorg, pplane.normal));

  surf.d_zistepu = p_normal[0] * rState.xscaleinv * distinv;
  surf.d_zistepv = -p_normal[1] * rState.yscaleinv * distinv;
  surf.d_ziorigin = p_normal[2] * distinv - rState.xcenter * surf.d_zistepu - rState.ycenter * surf.d_zistepv;

  // JDC  VectorCopy (r_worldmodelorg, surface_p->modelorg);
  rState.surface_p++;
}

/*
================
R_RenderBmodelFace
================
*/
export function R_RenderBmodelFace(pedgesHead: BedgeT | null, psurf: MsurfaceT): void {
  // skip out if no more surfs
  if (rState.surface_p >= rState.surf_max) {
    rState.r_outofsurfaces++;
    return;
  }

  // ditto if not enough edges left, or switch to auxedges if possible
  if (rState.edge_p + psurf.numedges + 4 >= rState.edge_max) {
    rState.r_outofedges += psurf.numedges;
    return;
  }

  rState.c_faceclip++;

  // this is a dummy to give the caching mechanism someplace to write to
  const tedge = new MedgeT();
  rState.r_pedge = tedge;

  // set up clip planes
  let pclip: ClipplaneT | null = null;

  let mask = 0x08;
  for (let i = 3; i >= 0; i--, mask >>= 1) {
    if (rState.r_clipflags & mask) {
      view_clipplanes[i].next = pclip;
      pclip = view_clipplanes[i];
    }
  }

  // push the edges through
  // FIXME: keep clipped bmodel edges in clockwise order so last vertex caching
  // can be used?
  R_BeginFaceEdges();

  for (let pedges = pedgesHead; pedges !== null; pedges = pedges.pnext) {
    r_leftclipped = false;
    r_rightclipped = false;
    if (pedges.v[0] === null || pedges.v[1] === null) Sys_Error("R_RenderBmodelFace: bad bedge");
    R_ClipEdge(pedges.v[0], pedges.v[1], pclip);

    if (r_leftclipped) makeleftedge = true;
    if (r_rightclipped) makerightedge = true;
  }

  // if there was a clip off the left edge, add that edge too
  // FIXME: faster to do in screen space?
  // FIXME: share clipped edges?
  if (makeleftedge) {
    rState.r_pedge = tedge;
    if (pclip === null) Sys_Error("R_RenderBmodelFace: makeleftedge with no clip plane");
    R_ClipEdge(r_leftexit, r_leftenter, pclip.next);
  }

  // if there was a clip off the right edge, get the right r_nearzi
  if (makerightedge) {
    rState.r_pedge = tedge;
    r_nearzionly = true;
    R_ClipEdge(r_rightexit, r_rightenter, view_clipplanes[1].next);
  }

  // if no edges made it out, return without posting the surface
  if (!r_emitted) return;

  rState.r_polycount++;

  if (rState.surfaces === null) Sys_Error("R_RenderBmodelFace: no surface pool");
  const surf = rState.surfaces[rState.surface_p];
  surf.data = psurf;
  surf.nearzi = r_nearzi;
  surf.flags = psurf.flags;
  surf.insubmodel = true;
  surf.spanstate = 0;
  surf.entity = rState.currententity;
  surf.key = rState.r_currentbkey;
  surf.spans = null;

  const pplane = psurf.plane;
  if (pplane === null) Sys_Error("R_RenderBmodelFace: no plane");
  // FIXME: cache this?
  const p_normal: Vec3 = vec3();
  TransformVector(pplane.normal, p_normal);
  // FIXME: cache this?
  const distinv = 1.0 / (pplane.dist - DotProduct(modelorg, pplane.normal));

  surf.d_zistepu = p_normal[0] * rState.xscaleinv * distinv;
  surf.d_zistepv = -p_normal[1] * rState.yscaleinv * distinv;
  surf.d_ziorigin = p_normal[2] * distinv - rState.xcenter * surf.d_zistepu - rState.ycenter * surf.d_zistepv;

  // JDC  VectorCopy (r_worldmodelorg, surface_p->modelorg);
  rState.surface_p++;
}

// R_RenderPoly's own "FIXME: do real number, safely" stack locals -- see
// file header comment.
const MAXPOLYVERTS = 100;
const rpolyVerts: [Vec3[], Vec3[]] = [
  Array.from({ length: MAXPOLYVERTS }, () => vec3()),
  Array.from({ length: MAXPOLYVERTS }, () => vec3()),
];
const rpolyPverts: PolyvertT[] = Array.from({ length: MAXPOLYVERTS }, () => new PolyvertT());

/*
================
R_RenderPoly
================
*/
export function R_RenderPoly(fa: MsurfaceT, clipflags: number): void {
  // FIXME: clean this up and make it faster
  // FIXME: guard against running out of vertices
  let s_axis = 0;
  let t_axis = 0; // keep compiler happy

  // set up clip planes
  let pclip: ClipplaneT | null = null;

  let mask = 0x08;
  for (let i = 3; i >= 0; i--, mask >>= 1) {
    if (clipflags & mask) {
      view_clipplanes[i].next = pclip;
      pclip = view_clipplanes[i];
    }
  }

  // reconstruct the polygon
  // FIXME: these should be precalculated and loaded off disk
  const ent = rState.currententity;
  if (ent === null || ent.model === null) Sys_Error("R_RenderPoly: no current entity/model");
  const model = ent.model;
  const pedges = model.edges;
  let lnumverts = fa.numedges;
  let vertpage = 0;

  const vertbase = rState.r_pcurrentvertbase;
  if (vertbase === null) Sys_Error("R_RenderPoly: no vertex base");

  for (let i = 0; i < lnumverts; i++) {
    const lindex = model.surfedges[fa.firstedge + i];

    const v = lindex > 0 ? vertbase[pedges[lindex].v[0]] : vertbase[pedges[-lindex].v[1]];

    rpolyVerts[0][i][0] = v.position[0];
    rpolyVerts[0][i][1] = v.position[1];
    rpolyVerts[0][i][2] = v.position[2];
  }

  // clip the polygon, done if not visible
  while (pclip !== null) {
    let lastvert = lnumverts - 1;
    let lastdist = DotProduct(rpolyVerts[vertpage][lastvert], pclip.normal) - pclip.dist;

    let visible = false;
    let newverts = 0;
    const newpage = vertpage ^ 1;

    for (let i = 0; i < lnumverts; i++) {
      const dist = DotProduct(rpolyVerts[vertpage][i], pclip.normal) - pclip.dist;

      if (lastdist > 0 !== dist > 0) {
        const frac = dist / (dist - lastdist);
        rpolyVerts[newpage][newverts][0] = rpolyVerts[vertpage][i][0] + (rpolyVerts[vertpage][lastvert][0] - rpolyVerts[vertpage][i][0]) * frac;
        rpolyVerts[newpage][newverts][1] = rpolyVerts[vertpage][i][1] + (rpolyVerts[vertpage][lastvert][1] - rpolyVerts[vertpage][i][1]) * frac;
        rpolyVerts[newpage][newverts][2] = rpolyVerts[vertpage][i][2] + (rpolyVerts[vertpage][lastvert][2] - rpolyVerts[vertpage][i][2]) * frac;
        newverts++;
      }

      if (dist >= 0) {
        rpolyVerts[newpage][newverts][0] = rpolyVerts[vertpage][i][0];
        rpolyVerts[newpage][newverts][1] = rpolyVerts[vertpage][i][1];
        rpolyVerts[newpage][newverts][2] = rpolyVerts[vertpage][i][2];
        newverts++;
        visible = true;
      }

      lastvert = i;
      lastdist = dist;
    }

    if (!visible || newverts < 3) return;

    lnumverts = newverts;
    vertpage ^= 1;
    pclip = pclip.next;
  }

  // transform and project, remembering the z values at the vertices and
  // r_nearzi, and extract the s and t coordinates at the vertices
  const pplane = fa.plane;
  if (pplane === null) Sys_Error("R_RenderPoly: no plane");

  switch (pplane.type) {
    case PLANE_X:
    case PLANE_ANYX:
      s_axis = 1;
      t_axis = 2;
      break;
    case PLANE_Y:
    case PLANE_ANYY:
      s_axis = 0;
      t_axis = 2;
      break;
    case PLANE_Z:
    case PLANE_ANYZ:
      s_axis = 0;
      t_axis = 1;
      break;
  }

  r_nearzi = 0;

  const local: Vec3 = vec3();
  const transformed: Vec3 = vec3();

  for (let i = 0; i < lnumverts; i++) {
    // transform and project
    VectorSubtract(rpolyVerts[vertpage][i], modelorg, local);
    TransformVector(local, transformed);

    if (transformed[2] < NEAR_CLIP) transformed[2] = NEAR_CLIP;

    const lzi = 1.0 / transformed[2];

    if (lzi > r_nearzi) r_nearzi = lzi; // for mipmap finding

    // FIXME: build x/yscale into transform?
    let scale = rState.xscale * lzi;
    let u = rState.xcenter + scale * transformed[0];
    if (u < r_refdef.fvrectx_adj) u = r_refdef.fvrectx_adj;
    if (u > r_refdef.fvrectright_adj) u = r_refdef.fvrectright_adj;

    scale = rState.yscale * lzi;
    let v = rState.ycenter - scale * transformed[1];
    if (v < r_refdef.fvrecty_adj) v = r_refdef.fvrecty_adj;
    if (v > r_refdef.fvrectbottom_adj) v = r_refdef.fvrectbottom_adj;

    rpolyPverts[i].u = u;
    rpolyPverts[i].v = v;
    rpolyPverts[i].zi = lzi;
    rpolyPverts[i].s = rpolyVerts[vertpage][i][s_axis];
    rpolyPverts[i].t = rpolyVerts[vertpage][i][t_axis];
  }

  // build the polygon descriptor, including fa, r_nearzi, and u, v, s, t, and z
  // for each vertex
  r_polydesc.numverts = lnumverts;
  r_polydesc.nearzi = r_nearzi;
  r_polydesc.pcurrentface = fa;
  r_polydesc.pverts = rpolyPverts;

  // draw the polygon
  D_DrawPoly();
}

/*
================
R_ZDrawSubmodelPolys
================
*/
export function R_ZDrawSubmodelPolys(pmodel: ModelT): void {
  const numsurfaces = pmodel.nummodelsurfaces;

  for (let i = 0; i < numsurfaces; i++) {
    const psurf = pmodel.surfaces[pmodel.firstmodelsurface + i];

    // find which side of the node we are on
    const pplane = psurf.plane;
    if (pplane === null) Sys_Error("R_ZDrawSubmodelPolys: no plane");

    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if ((psurf.flags & SURF_PLANEBACK && dot < -BACKFACE_EPSILON) || (!(psurf.flags & SURF_PLANEBACK) && dot > BACKFACE_EPSILON)) {
      // FIXME: use bounding-box-based frustum clipping info?
      R_RenderPoly(psurf, 15);
    }
  }
}
