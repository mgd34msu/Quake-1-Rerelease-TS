/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_bsp.c (GNU GPL v2 or later).

r_bsp.c -- the BSP walk that feeds the edge list: the world tree recursion
(R_RecursiveWorldNode / R_RenderWorld) and the two submodel paths
(R_DrawSubmodelPolygons for a bmodel that falls in one leaf,
R_DrawSolidClippedSubmodelPolygons + R_RecursiveClipBPoly for one that must
be clipped to the world tree).

OWNERSHIP -- r_bsp.c defines these globals; r_shared.h / r_local.h declare
them and this port already holds them in `rState` / r_local.ts, so they are
written here rather than redeclared:
  insubmodel, currententity, r_currentbkey     ... rState (r_shared.ts)
  modelorg, base_modelorg                      ... r_shared.ts singletons
  r_entorigin, r_worldmodelorg, entity_rotation ... r_local.ts singletons

Deviations from PORTING.md / the C source:
- `mvertex_t bverts[MAX_BMODEL_VERTS]` and `bedge_t bedges[MAX_BMODEL_EDGES]`
  are stack arrays in R_DrawSolidClippedSubmodelPolygons, and
  `btofpoly_t btofpolys[MAX_BTOFPOLYS]` is one in R_RenderWorld. JS has no
  stack arrays, so all three are module-level object pools allocated once;
  `pbverts` / `pbedges` / `rState.pbtofpolys` are set to them exactly where
  the C sets them, and every element is fully written before it is read, as
  in the C.
- `pbedge = &bedges[numbedges]` is a pointer into that pool, so it becomes
  the base INDEX `pbedgeBase` and `pbedge[j]` is `pbedges[pbedgeBase + j]`.
- `pmodel->surfaces[pmodel->firstmodelsurface]` and
  `cl.worldmodel->surfaces + node->firstsurface` are `msurface_t *` cursors;
  here they are indexes into the model's `surfaces[]` array.
- `&r_pcurrentvertbase[pedge->v[0]]` indexes `rState.r_pcurrentvertbase`
  (an `MvertexT[]`) and hands the object over, since bedge_t.v[] holds
  `mvertex_t *`.
- `node->contents < 0` / `((mleaf_t *)node)` is `isMleaf()` from
  src/common/model.ts (a type guard, not a cast). `entity_t.topnode` is typed
  `MnodeT` there, so the two places the C casts it to `mleaf_t *` narrow
  through the same guard.
- `pfrustum_indexes[i]` is an `Int32Array` view of `r_frustum_indexes`, so
  `pindex[0..5]` reads exactly as the C's `int *`.
- `typedef enum {touchessolid, drawnode, nodrawnode} solidstate_t;` is
  declared in r_bsp.c and used by nothing in v1.09; it is kept below.
- `R_RenderPoly` / `R_RenderFace` / `R_RenderBmodelFace` are r_draw.c's
  (U064), `R_StoreEfrags` is r_efrag.c's (U064) and `R_TransformFrustum` is
  r_misc.c's (U062); all are imported by name.
- Dropped: nothing. r_bsp.c has no #ifdef branches.
*/

import {
  DotProduct,
  M_PI,
  MplaneT,
  PLANE_X,
  PLANE_Y,
  PLANE_Z,
  R_ConcatRotations,
  VectorCopy,
  type Mat3,
  type Vec3,
  vec3,
} from "../common/mathlib";
import { PITCH, ROLL, YAW } from "../common/quakedef";
import { CONTENTS_SOLID } from "../common/bspfile";
import {
  MvertexT,
  SURF_PLANEBACK,
  isMleaf,
  type MleafT,
  type ModelT,
  type MnodeT,
  type MsurfaceT,
} from "../common/model";
import { cl, cl_entities } from "../client/client";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import {
  BACKFACE_EPSILON,
  BedgeT,
  MAX_BTOFPOLYS,
  allocBtofpolys,
  entity_rotation,
  modelorg,
  pfrustum_indexes,
  r_entorigin,
  r_origin,
  rState,
  view_clipplanes,
  vpn,
  vright,
  vup,
} from "./r_local";
import { R_TransformFrustum } from "./r_misc";
import { R_RenderBmodelFace, R_RenderFace, R_RenderPoly } from "./r_draw";
import { R_StoreEfrags } from "./r_efrag";
import { r_worldentity } from "./r_main";
import { qw } from "../common/quakedef";

export enum SolidstateT {
  touchessolid = 0,
  drawnode = 1,
  nodrawnode = 2,
}

export const MAX_BMODEL_VERTS = 500; // 6K
export const MAX_BMODEL_EDGES = 1000; // 12K

// R_DrawSolidClippedSubmodelPolygons's `bverts`/`bedges` stack arrays and
// R_RenderWorld's `btofpolys`; see this file's header.
const bverts: MvertexT[] = (() => {
  const a: MvertexT[] = new Array<MvertexT>(MAX_BMODEL_VERTS);
  for (let i = 0; i < MAX_BMODEL_VERTS; i++) a[i] = new MvertexT();
  return a;
})();
const bedges: BedgeT[] = (() => {
  const a: BedgeT[] = new Array<BedgeT>(MAX_BMODEL_EDGES);
  for (let i = 0; i < MAX_BMODEL_EDGES; i++) a[i] = new BedgeT();
  return a;
})();
const btofpolys = allocBtofpolys(MAX_BTOFPOLYS);

let pbverts: MvertexT[] = bverts;
let pbedges: BedgeT[] = bedges;
let numbverts = 0;
let numbedges = 0;

let pfrontenter: MvertexT | null = null;
let pfrontexit: MvertexT | null = null;

let makeclippededge = false;

//===========================================================================

/*
================
R_EntityRotate
================
*/
export function R_EntityRotate(vec: Vec3): void {
  const tvec: Vec3 = vec3();

  VectorCopy(vec, tvec);
  vec[0] = DotProduct(entity_rotation[0], tvec);
  vec[1] = DotProduct(entity_rotation[1], tvec);
  vec[2] = DotProduct(entity_rotation[2], tvec);
}

/*
================
R_RotateBmodel
================
*/
export function R_RotateBmodel(): void {
  const currententity = rState.currententity;
  if (currententity === null) Sys_Error("R_RotateBmodel: no currententity");

  const temp1: Mat3 = [vec3(), vec3(), vec3()];
  const temp2: Mat3 = [vec3(), vec3(), vec3()];
  const temp3: Mat3 = [vec3(), vec3(), vec3()];

  // TODO: should use a look-up table
  // TODO: should really be stored with the entity instead of being reconstructed
  // TODO: could cache lazily, stored in the entity
  // TODO: share work with R_SetUpAliasTransform

  // yaw
  let angle = currententity.angles[YAW];
  angle = (angle * M_PI * 2) / 360;
  let s = Math.sin(angle);
  let c = Math.cos(angle);

  temp1[0][0] = c;
  temp1[0][1] = s;
  temp1[0][2] = 0;
  temp1[1][0] = -s;
  temp1[1][1] = c;
  temp1[1][2] = 0;
  temp1[2][0] = 0;
  temp1[2][1] = 0;
  temp1[2][2] = 1;

  // pitch
  angle = currententity.angles[PITCH];
  angle = (angle * M_PI * 2) / 360;
  s = Math.sin(angle);
  c = Math.cos(angle);

  temp2[0][0] = c;
  temp2[0][1] = 0;
  temp2[0][2] = -s;
  temp2[1][0] = 0;
  temp2[1][1] = 1;
  temp2[1][2] = 0;
  temp2[2][0] = s;
  temp2[2][1] = 0;
  temp2[2][2] = c;

  R_ConcatRotations(temp2, temp1, temp3);

  // roll
  angle = currententity.angles[ROLL];
  angle = (angle * M_PI * 2) / 360;
  s = Math.sin(angle);
  c = Math.cos(angle);

  temp1[0][0] = 1;
  temp1[0][1] = 0;
  temp1[0][2] = 0;
  temp1[1][0] = 0;
  temp1[1][1] = c;
  temp1[1][2] = s;
  temp1[2][0] = 0;
  temp1[2][1] = -s;
  temp1[2][2] = c;

  R_ConcatRotations(temp1, temp3, entity_rotation);

  //
  // rotate modelorg and the transformation matrix
  //
  R_EntityRotate(modelorg);
  R_EntityRotate(vpn);
  R_EntityRotate(vright);
  R_EntityRotate(vup);

  R_TransformFrustum();
}

/*
================
R_RecursiveClipBPoly
================
*/
export function R_RecursiveClipBPoly(pedgesIn: BedgeT | null, pnode: MnodeT, psurf: MsurfaceT): void {
  const psideedges: [BedgeT | null, BedgeT | null] = [null, null];
  let ptedge: BedgeT;
  const tplane = new MplaneT();

  makeclippededge = false;

  // transform the BSP plane into model space
  // FIXME: cache these?
  const splitplane = pnode.plane;
  if (splitplane === null) Sys_Error("R_RecursiveClipBPoly: node has no plane");
  tplane.dist = splitplane.dist - DotProduct(r_entorigin, splitplane.normal);
  tplane.normal[0] = DotProduct(entity_rotation[0], splitplane.normal);
  tplane.normal[1] = DotProduct(entity_rotation[1], splitplane.normal);
  tplane.normal[2] = DotProduct(entity_rotation[2], splitplane.normal);

  // clip edges to BSP plane
  for (let pedges = pedgesIn; pedges !== null; ) {
    const pnextedge = pedges.pnext;

    // set the status for the last point as the previous point
    // FIXME: cache this stuff somehow?
    const plastvert = pedges.v[0];
    const pvert = pedges.v[1];
    if (plastvert === null || pvert === null) Sys_Error("R_RecursiveClipBPoly: bedge with no vertexes");

    const lastdist = DotProduct(plastvert.position, tplane.normal) - tplane.dist;

    let lastside: number;
    if (lastdist > 0) lastside = 0;
    else lastside = 1;

    const dist = DotProduct(pvert.position, tplane.normal) - tplane.dist;

    let side: number;
    if (dist > 0) side = 0;
    else side = 1;

    if (side !== lastside) {
      // clipped
      if (numbverts >= MAX_BMODEL_VERTS) return;

      // generate the clipped vertex
      const frac = lastdist / (lastdist - dist);
      const ptvert = pbverts[numbverts++];
      ptvert.position[0] = plastvert.position[0] + frac * (pvert.position[0] - plastvert.position[0]);
      ptvert.position[1] = plastvert.position[1] + frac * (pvert.position[1] - plastvert.position[1]);
      ptvert.position[2] = plastvert.position[2] + frac * (pvert.position[2] - plastvert.position[2]);

      // split into two edges, one on each side, and remember entering
      // and exiting points
      // FIXME: share the clip edge by having a winding direction flag?
      if (numbedges >= MAX_BMODEL_EDGES - 1) {
        Con_Printf("Out of edges for bmodel\n");
        return;
      }

      ptedge = pbedges[numbedges];
      ptedge.pnext = psideedges[lastside];
      psideedges[lastside] = ptedge;
      ptedge.v[0] = plastvert;
      ptedge.v[1] = ptvert;

      ptedge = pbedges[numbedges + 1];
      ptedge.pnext = psideedges[side];
      psideedges[side] = ptedge;
      ptedge.v[0] = ptvert;
      ptedge.v[1] = pvert;

      numbedges += 2;

      if (side === 0) {
        // entering for front, exiting for back
        pfrontenter = ptvert;
        makeclippededge = true;
      } else {
        pfrontexit = ptvert;
        makeclippededge = true;
      }
    } else {
      // add the edge to the appropriate side
      pedges.pnext = psideedges[side];
      psideedges[side] = pedges;
    }

    pedges = pnextedge;
  }

  // if anything was clipped, reconstitute and add the edges along the clip
  // plane to both sides (but in opposite directions)
  if (makeclippededge) {
    if (numbedges >= MAX_BMODEL_EDGES - 2) {
      Con_Printf("Out of edges for bmodel\n");
      return;
    }

    ptedge = pbedges[numbedges];
    ptedge.pnext = psideedges[0];
    psideedges[0] = ptedge;
    ptedge.v[0] = pfrontexit;
    ptedge.v[1] = pfrontenter;

    ptedge = pbedges[numbedges + 1];
    ptedge.pnext = psideedges[1];
    psideedges[1] = ptedge;
    ptedge.v[0] = pfrontenter;
    ptedge.v[1] = pfrontexit;

    numbedges += 2;
  }

  // draw or recurse further
  for (let i = 0; i < 2; i++) {
    const side = psideedges[i];
    if (side !== null) {
      // draw if we've reached a non-solid leaf, done if all that's left is a
      // solid leaf, and continue down the tree if it's not a leaf
      const pn = pnode.children[i];
      if (pn === null) continue;

      // we're done with this branch if the node or leaf isn't in the PVS
      if (pn.visframe === rState.r_visframecount) {
        if (isMleaf(pn)) {
          if (pn.contents !== CONTENTS_SOLID) {
            rState.r_currentbkey = pn.key;
            R_RenderBmodelFace(side, psurf);
          }
        } else {
          R_RecursiveClipBPoly(side, pn, psurf);
        }
      }
    }
  }
}

/*
================
R_DrawSolidClippedSubmodelPolygons
================
*/
export function R_DrawSolidClippedSubmodelPolygons(pmodel: ModelT): void {
  const currententity = rState.currententity;
  if (currententity === null) Sys_Error("R_DrawSolidClippedSubmodelPolygons: no currententity");
  const r_pcurrentvertbase = rState.r_pcurrentvertbase;
  if (r_pcurrentvertbase === null) Sys_Error("R_DrawSolidClippedSubmodelPolygons: no r_pcurrentvertbase");

  // FIXME: use bounding-box-based frustum clipping info?

  const psurfBase = pmodel.firstmodelsurface;
  const numsurfaces = pmodel.nummodelsurfaces;
  const pedges = pmodel.edges;

  for (let i = 0; i < numsurfaces; i++) {
    const psurf = pmodel.surfaces[psurfBase + i];

    // find which side of the node we are on
    const pplane = psurf.plane;
    if (pplane === null) Sys_Error("R_DrawSolidClippedSubmodelPolygons: surface has no plane");

    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if (
      ((psurf.flags & SURF_PLANEBACK) !== 0 && dot < -BACKFACE_EPSILON) ||
      ((psurf.flags & SURF_PLANEBACK) === 0 && dot > BACKFACE_EPSILON)
    ) {
      // FIXME: use bounding-box-based frustum clipping info?

      // copy the edges to bedges, flipping if necessary so always
      // clockwise winding
      // FIXME: if edges and vertices get caches, these assignments must move
      // outside the loop, and overflow checking must be done here
      pbverts = bverts;
      pbedges = bedges;
      numbverts = numbedges = 0;

      if (psurf.numedges > 0) {
        const pbedgeBase = numbedges;
        numbedges += psurf.numedges;

        let j = 0;
        for (j = 0; j < psurf.numedges; j++) {
          let lindex = pmodel.surfedges[psurf.firstedge + j];

          if (lindex > 0) {
            const pedge = pedges[lindex];
            pbedges[pbedgeBase + j].v[0] = r_pcurrentvertbase[pedge.v[0]];
            pbedges[pbedgeBase + j].v[1] = r_pcurrentvertbase[pedge.v[1]];
          } else {
            lindex = -lindex;
            const pedge = pedges[lindex];
            pbedges[pbedgeBase + j].v[0] = r_pcurrentvertbase[pedge.v[1]];
            pbedges[pbedgeBase + j].v[1] = r_pcurrentvertbase[pedge.v[0]];
          }

          pbedges[pbedgeBase + j].pnext = pbedges[pbedgeBase + j + 1];
        }

        pbedges[pbedgeBase + j - 1].pnext = null; // mark end of edges

        const topnode = currententity.topnode;
        if (topnode === null) Sys_Error("R_DrawSolidClippedSubmodelPolygons: no topnode");
        if (isMleaf(topnode)) Sys_Error("R_DrawSolidClippedSubmodelPolygons: topnode is a leaf"); // r_main.c only takes this path when contents >= 0
        R_RecursiveClipBPoly(pbedges[pbedgeBase], topnode, psurf);
      } else {
        Sys_Error("no edges in bmodel");
      }
    }
  }
}

/*
================
R_DrawSubmodelPolygons
================
*/
export function R_DrawSubmodelPolygons(pmodel: ModelT, clipflags: number): void {
  const currententity = rState.currententity;
  if (currententity === null) Sys_Error("R_DrawSubmodelPolygons: no currententity");

  // FIXME: use bounding-box-based frustum clipping info?

  const psurfBase = pmodel.firstmodelsurface;
  const numsurfaces = pmodel.nummodelsurfaces;

  for (let i = 0; i < numsurfaces; i++) {
    const psurf = pmodel.surfaces[psurfBase + i];

    // find which side of the node we are on
    const pplane = psurf.plane;
    if (pplane === null) Sys_Error("R_DrawSubmodelPolygons: surface has no plane");

    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if (
      ((psurf.flags & SURF_PLANEBACK) !== 0 && dot < -BACKFACE_EPSILON) ||
      ((psurf.flags & SURF_PLANEBACK) === 0 && dot > BACKFACE_EPSILON)
    ) {
      const topnode = currententity.topnode;
      if (topnode === null) Sys_Error("R_DrawSubmodelPolygons: no topnode");
      if (!isMleaf(topnode)) Sys_Error("R_DrawSubmodelPolygons: topnode is not a leaf");
      rState.r_currentkey = topnode.key;

      // FIXME: use bounding-box-based frustum clipping info?
      R_RenderFace(psurf, clipflags);
    }
  }
}

/*
================
R_RecursiveWorldNode
================
*/
export function R_RecursiveWorldNode(node: MnodeT | MleafT, clipflagsIn: number): void {
  let clipflags = clipflagsIn;
  const acceptpt: Vec3 = vec3();
  const rejectpt: Vec3 = vec3();

  if (node.contents === CONTENTS_SOLID) return; // solid

  if (node.visframe !== rState.r_visframecount) return;

  // cull the clipping planes if not trivial accept
  // FIXME: the compiler is doing a lousy job of optimizing here; it could be
  //  twice as fast in ASM
  if (clipflags !== 0) {
    for (let i = 0; i < 4; i++) {
      if ((clipflags & (1 << i)) === 0) continue; // don't need to clip against it

      // generate accept and reject points
      // FIXME: do with fast look-ups or integer tests based on the sign bit
      // of the floating point values

      const pindex = pfrustum_indexes[i];

      rejectpt[0] = node.minmaxs[pindex[0]];
      rejectpt[1] = node.minmaxs[pindex[1]];
      rejectpt[2] = node.minmaxs[pindex[2]];

      let d = DotProduct(rejectpt, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;

      if (d <= 0) return;

      acceptpt[0] = node.minmaxs[pindex[3 + 0]];
      acceptpt[1] = node.minmaxs[pindex[3 + 1]];
      acceptpt[2] = node.minmaxs[pindex[3 + 2]];

      d = DotProduct(acceptpt, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;

      if (d >= 0) clipflags &= ~(1 << i); // node is entirely on screen
    }
  }

  // if a leaf node, draw stuff
  if (isMleaf(node)) {
    const pleaf = node;

    let mark = pleaf.firstmarksurface;
    let c = pleaf.nummarksurfaces;

    if (c !== 0) {
      do {
        pleaf.marksurfaces[mark].visframe = rState.r_framecount;
        mark++;
      } while (--c);
    }

    // deal with model fragments in this leaf
    if (pleaf.efrags !== null) {
      R_StoreEfrags(pleaf.efrags);
    }

    pleaf.key = rState.r_currentkey;
    rState.r_currentkey++; // all bmodels in a leaf share the same key
  } else {
    // node is just a decision point, so go down the apropriate sides

    // find which side of the node we are on
    const plane = node.plane;
    if (plane === null) Sys_Error("R_RecursiveWorldNode: node has no plane");

    let dot: number;
    switch (plane.type) {
      case PLANE_X:
        dot = modelorg[0] - plane.dist;
        break;
      case PLANE_Y:
        dot = modelorg[1] - plane.dist;
        break;
      case PLANE_Z:
        dot = modelorg[2] - plane.dist;
        break;
      default:
        dot = DotProduct(modelorg, plane.normal) - plane.dist;
        break;
    }

    let side: number;
    if (dot >= 0) side = 0;
    else side = 1;

    // recurse down the children, front side first
    const front = node.children[side];
    if (front !== null) R_RecursiveWorldNode(front, clipflags);

    // draw stuff
    let c = node.numsurfaces;

    if (c !== 0) {
      const worldmodel = cl.worldmodel;
      if (worldmodel === null) Sys_Error("R_RecursiveWorldNode: no worldmodel");
      let surfIndex = node.firstsurface;

      if (dot < -BACKFACE_EPSILON) {
        do {
          const surf = worldmodel.surfaces[surfIndex];
          if ((surf.flags & SURF_PLANEBACK) !== 0 && surf.visframe === rState.r_framecount) {
            if (rState.r_drawpolys) {
              if (rState.r_worldpolysbacktofront) {
                if (rState.numbtofpolys < MAX_BTOFPOLYS) {
                  const pbtofpolys = rState.pbtofpolys;
                  if (pbtofpolys === null) Sys_Error("R_RecursiveWorldNode: no pbtofpolys");
                  pbtofpolys[rState.numbtofpolys].clipflags = clipflags;
                  pbtofpolys[rState.numbtofpolys].psurf = surf;
                  rState.numbtofpolys++;
                }
              } else {
                R_RenderPoly(surf, clipflags);
              }
            } else {
              R_RenderFace(surf, clipflags);
            }
          }

          surfIndex++;
        } while (--c);
      } else if (dot > BACKFACE_EPSILON) {
        do {
          const surf = worldmodel.surfaces[surfIndex];
          if ((surf.flags & SURF_PLANEBACK) === 0 && surf.visframe === rState.r_framecount) {
            if (rState.r_drawpolys) {
              if (rState.r_worldpolysbacktofront) {
                if (rState.numbtofpolys < MAX_BTOFPOLYS) {
                  const pbtofpolys = rState.pbtofpolys;
                  if (pbtofpolys === null) Sys_Error("R_RecursiveWorldNode: no pbtofpolys");
                  pbtofpolys[rState.numbtofpolys].clipflags = clipflags;
                  pbtofpolys[rState.numbtofpolys].psurf = surf;
                  rState.numbtofpolys++;
                }
              } else {
                R_RenderPoly(surf, clipflags);
              }
            } else {
              R_RenderFace(surf, clipflags);
            }
          }

          surfIndex++;
        } while (--c);
      }

      // all surfaces on the same node share the same sequence number
      rState.r_currentkey++;
    }

    // recurse down the back side
    const back = node.children[side === 0 ? 1 : 0];
    if (back !== null) R_RecursiveWorldNode(back, clipflags);
  }
}

/*
================
R_RenderWorld
================
*/
export function R_RenderWorld(): void {
  rState.pbtofpolys = btofpolys;

  // QW r_bsp.c:656 has `currententity = &r_worldentity;` where WinQuake
  // r_bsp.c has `currententity = &cl_entities[0];` -- QW's cl_parse never
  // fills cl_entities[0].model, and its R_NewMap sets r_worldentity.model
  // from cl.worldmodel instead.
  rState.currententity = qw.active ? r_worldentity : cl_entities[0];
  VectorCopy(r_origin, modelorg);
  const clmodel = rState.currententity.model;
  if (clmodel === null) Sys_Error("R_RenderWorld: no world model");
  rState.r_pcurrentvertbase = clmodel.vertexes;

  R_RecursiveWorldNode(clmodel.nodes[0], 15);

  // if the driver wants the polygons back to front, play the visible ones back
  // in that order
  if (rState.r_worldpolysbacktofront) {
    for (let i = rState.numbtofpolys - 1; i >= 0; i--) {
      const psurf = btofpolys[i].psurf;
      if (psurf === null) continue;
      R_RenderPoly(psurf, btofpolys[i].clipflags);
    }
  }
}
