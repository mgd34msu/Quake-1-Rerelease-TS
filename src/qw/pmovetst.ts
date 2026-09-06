/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/pmovetst.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- pmovetst.c is the client/server-shared copy of the hull walk that
  WinQuake's world.c also carries. It is ported here as its own module, not
  routed through src/server/world.ts, because that is what the C does: qwcl
  links pmovetst.c and never links world.c.
- `#if 1` / `#else` inside PM_RecursiveHullCheck keeps the `#if 1` half (the
  `#else` DIST_EPSILON-fringe variant is dead code in the shipped source);
  `#ifdef PARANOID` inside the same function is dropped (never defined).
- `PM_PointContents` dereferences `pmove.physents[0].model` with no null
  check in the C, so a missing world model is a segfault there. This port
  raises `Sys_Error ("PM_PointContents: no world model")` instead.
- `PM_HullForBox` returns `hull_t *` pointing at the single file-scope
  `box_hull`, so the returned hull is invalidated by the next call. The TS
  returns the same shared `HullT` object with the same aliasing, matching
  src/server/world.ts's `SV_HullForBox`.
- `box_clipnodes` is `dclipnode_t[6]`; model.ts's `MclipnodeT` is an alias of
  bspfile.ts's `DclipnodeT`, so the array is `DclipnodeT[]` and drops into
  `HullT.clipnodes` unchanged.
*/

import { HullT } from "../common/model";
import { CONTENTS_EMPTY, CONTENTS_SOLID, DclipnodeT } from "../common/bspfile";
import {
  type Vec3,
  MplaneT,
  vec3,
  vec3_origin,
  DotProduct,
  VectorAdd,
  VectorCopy,
  VectorSubtract,
} from "../common/mathlib";
import { Sys_Error } from "../platform/sys";
import { Con_DPrintf } from "../client/console";
import { PmtraceT, pmove, player_mins, player_maxs } from "./pmove_types";

const box_hull = new HullT();
const box_clipnodes: DclipnodeT[] = Array.from({ length: 6 }, () => new DclipnodeT());
const box_planes: MplaneT[] = Array.from({ length: 6 }, () => new MplaneT());

/*
===================
PM_InitBoxHull

Set up the planes and clipnodes so that the six floats of a bounding box
can just be stored out and get a proper hull_t structure.
===================
*/
export function PM_InitBoxHull(): void {
  box_hull.clipnodes = box_clipnodes;
  box_hull.planes = box_planes;
  box_hull.firstclipnode = 0;
  box_hull.lastclipnode = 5;

  for (let i = 0; i < 6; i++) {
    box_clipnodes[i].planenum = i;

    const side = i & 1;

    box_clipnodes[i].children[side] = CONTENTS_EMPTY;
    if (i !== 5) box_clipnodes[i].children[side ^ 1] = i + 1;
    else box_clipnodes[i].children[side ^ 1] = CONTENTS_SOLID;

    box_planes[i].type = i >> 1;
    box_planes[i].normal[i >> 1] = 1;
  }
}

/*
===================
PM_HullForBox

To keep everything totally uniform, bounding boxes are turned into small
BSP trees instead of being compared directly.
===================
*/
export function PM_HullForBox(mins: Vec3, maxs: Vec3): HullT {
  box_planes[0].dist = maxs[0];
  box_planes[1].dist = mins[0];
  box_planes[2].dist = maxs[1];
  box_planes[3].dist = mins[1];
  box_planes[4].dist = maxs[2];
  box_planes[5].dist = mins[2];

  return box_hull;
}

/*
==================
PM_HullPointContents

==================
*/
export function PM_HullPointContents(hull: HullT, startnum: number, p: Vec3): number {
  let num = startnum;

  while (num >= 0) {
    if (num < hull.firstclipnode || num > hull.lastclipnode) Sys_Error("PM_HullPointContents: bad node number");

    const node = hull.clipnodes[num];
    const plane = hull.planes[node.planenum];

    let d: number;
    if (plane.type < 3) d = p[plane.type] - plane.dist;
    else d = DotProduct(plane.normal, p) - plane.dist;

    if (d < 0) num = node.children[1];
    else num = node.children[0];
  }

  return num;
}

/*
==================
PM_PointContents

==================
*/
export function PM_PointContents(p: Vec3): number {
  const model = pmove.physents[0].model;
  if (model === null) Sys_Error("PM_PointContents: no world model");

  const hull = model.hulls[0];

  let num = hull.firstclipnode;

  while (num >= 0) {
    if (num < hull.firstclipnode || num > hull.lastclipnode) Sys_Error("PM_HullPointContents: bad node number");

    const node = hull.clipnodes[num];
    const plane = hull.planes[node.planenum];

    let d: number;
    if (plane.type < 3) d = p[plane.type] - plane.dist;
    else d = DotProduct(plane.normal, p) - plane.dist;

    if (d < 0) num = node.children[1];
    else num = node.children[0];
  }

  return num;
}

/*
===============================================================================

LINE TESTING IN HULLS

===============================================================================
*/

// 1/32 epsilon to keep floating point happy
const DIST_EPSILON = 0.03125;

/*
==================
PM_RecursiveHullCheck

==================
*/
export function PM_RecursiveHullCheck(
  hull: HullT,
  num: number,
  p1f: number,
  p2f: number,
  p1: Vec3,
  p2: Vec3,
  trace: PmtraceT,
): boolean {
  // check for empty
  if (num < 0) {
    if (num !== CONTENTS_SOLID) {
      trace.allsolid = false;
      if (num === CONTENTS_EMPTY) trace.inopen = true;
      else trace.inwater = true;
    } else trace.startsolid = true;
    return true; // empty
  }

  if (num < hull.firstclipnode || num > hull.lastclipnode) Sys_Error("PM_RecursiveHullCheck: bad node number");

  //
  // find the point distances
  //
  const node = hull.clipnodes[num];
  const plane = hull.planes[node.planenum];

  let t1: number;
  let t2: number;
  if (plane.type < 3) {
    t1 = p1[plane.type] - plane.dist;
    t2 = p2[plane.type] - plane.dist;
  } else {
    t1 = DotProduct(plane.normal, p1) - plane.dist;
    t2 = DotProduct(plane.normal, p2) - plane.dist;
  }

  if (t1 >= 0 && t2 >= 0) return PM_RecursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
  if (t1 < 0 && t2 < 0) return PM_RecursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);

  // put the crosspoint DIST_EPSILON pixels on the near side
  let frac: number;
  if (t1 < 0) frac = (t1 + DIST_EPSILON) / (t1 - t2);
  else frac = (t1 - DIST_EPSILON) / (t1 - t2);
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  let midf = p1f + (p2f - p1f) * frac;
  const mid = vec3();
  for (let i = 0; i < 3; i++) mid[i] = p1[i] + frac * (p2[i] - p1[i]);

  const side = t1 < 0 ? 1 : 0;

  // move up to the node
  if (!PM_RecursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace)) return false;

  if (PM_HullPointContents(hull, node.children[side ^ 1], mid) !== CONTENTS_SOLID)
    // go past the node
    return PM_RecursiveHullCheck(hull, node.children[side ^ 1], midf, p2f, mid, p2, trace);

  if (trace.allsolid) return false; // never got out of the solid area

  //==================
  // the other side of the node is solid, this is the impact point
  //==================
  if (!side) {
    VectorCopy(plane.normal, trace.plane.normal);
    trace.plane.dist = plane.dist;
  } else {
    VectorSubtract(vec3_origin, plane.normal, trace.plane.normal);
    trace.plane.dist = -plane.dist;
  }

  while (PM_HullPointContents(hull, hull.firstclipnode, mid) === CONTENTS_SOLID) {
    // shouldn't really happen, but does occasionally
    frac -= 0.1;
    if (frac < 0) {
      trace.fraction = midf;
      VectorCopy(mid, trace.endpos);
      Con_DPrintf("backup past 0\n");
      return false;
    }
    midf = p1f + (p2f - p1f) * frac;
    for (let i = 0; i < 3; i++) mid[i] = p1[i] + frac * (p2[i] - p1[i]);
  }

  trace.fraction = midf;
  VectorCopy(mid, trace.endpos);

  return false;
}

/*
================
PM_TestPlayerPosition

Returns false if the given player position is not valid (in solid)
================
*/
export function PM_TestPlayerPosition(pos: Vec3): boolean {
  const mins = vec3();
  const maxs = vec3();
  const test = vec3();

  for (let i = 0; i < pmove.numphysent; i++) {
    const pe = pmove.physents[i];
    // get the clipping hull
    let hull: HullT;
    const model = pe.model;
    if (model !== null) hull = model.hulls[1];
    else {
      VectorSubtract(pe.mins, player_maxs, mins);
      VectorSubtract(pe.maxs, player_mins, maxs);
      hull = PM_HullForBox(mins, maxs);
    }

    VectorSubtract(pos, pe.origin, test);

    if (PM_HullPointContents(hull, hull.firstclipnode, test) === CONTENTS_SOLID) return false;
  }

  return true;
}

/*
================
PM_PlayerMove
================
*/
export function PM_PlayerMove(start: Vec3, end: Vec3): PmtraceT {
  const offset = vec3();
  const start_l = vec3();
  const end_l = vec3();
  const mins = vec3();
  const maxs = vec3();

  // fill in a default trace
  let total = new PmtraceT();
  total.fraction = 1;
  total.ent = -1;
  VectorCopy(end, total.endpos);

  for (let i = 0; i < pmove.numphysent; i++) {
    const pe = pmove.physents[i];
    // get the clipping hull
    let hull: HullT;
    const model = pe.model;
    if (model !== null) hull = model.hulls[1];
    else {
      VectorSubtract(pe.mins, player_maxs, mins);
      VectorSubtract(pe.maxs, player_mins, maxs);
      hull = PM_HullForBox(mins, maxs);
    }

    // PM_HullForEntity (ent, mins, maxs, offset);
    VectorCopy(pe.origin, offset);

    VectorSubtract(start, offset, start_l);
    VectorSubtract(end, offset, end_l);

    // fill in a default trace
    const trace = new PmtraceT();
    trace.fraction = 1;
    trace.allsolid = true;
    //		trace.startsolid = true;
    VectorCopy(end, trace.endpos);

    // trace a line through the apropriate clipping hull
    PM_RecursiveHullCheck(hull, hull.firstclipnode, 0, 1, start_l, end_l, trace);

    if (trace.allsolid) trace.startsolid = true;
    if (trace.startsolid) trace.fraction = 0;

    // did we clip the move?
    if (trace.fraction < total.fraction) {
      // fix trace up by the offset
      VectorAdd(trace.endpos, offset, trace.endpos);
      total = trace;
      total.ent = i;
    }
  }

  return total;
}
