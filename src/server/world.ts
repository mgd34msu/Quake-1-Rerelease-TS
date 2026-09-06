/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/world.h and WinQuake/world.c (GNU GPL v2 or later).

world.c -- world query functions

entities never clip against themselves, or their owner

line of sight checks trace->crosscontent, but bullets don't

Deviations from PORTING.md / the C source:
- `plane_t` -> `PlaneT` (local to this module; `world.h`'s own `plane_t` is
  unrelated to mathlib.ts's `MplaneT`, which additionally carries `type`/
  `signbits` for the BSP hull walk). `trace_t` -> `TraceT`, with a `clear()`
  mirroring the C's `memset (&trace, 0, sizeof(trace_t))` at
  SV_ClipMoveToEntity's default-trace setup; every field's declared default
  is already that same zero value, so `clear()` is idempotent with `new
  TraceT()` and exists to give SV_ClipMoveToEntity a call site that reads the
  same as the C line it replaces.
- `link_t`'s `ClearLink`/`RemoveLink`/`InsertLinkBefore`/`InsertLinkAfter` are
  actually declared and defined in common.h/common.c, not world.h/world.c
  (`grep` confirms), but `link_t` itself has no home anywhere else in this
  port (progs.ts's file header already reports adopting it there for
  `edict_t.area`/`EDICT_FROM_AREA`) and the unit brief places these four
  functions in this module specifically; ported here over `LinkT` per the
  brief rather than in a not-yet-existing common.ts corner. `RemoveLink`/
  `InsertLinkBefore`/`InsertLinkAfter` assume `prev`/`next` are already
  linked (non-null), exactly as the C's pointer dereferences do; this port
  makes that assumption an explicit `SysError` instead of null-pointer UB,
  which only changes behavior on a call sequence that would already have
  been a C crash.
- `EDICT_FROM_AREA(l)` (progs.h's macro over `STRUCT_FROM_LINK`) becomes
  `l.owner` with a null check -- see progs.ts's `LinkT.owner` deviation note.
  Task 3 (2026-09-05) widened `LinkT.owner` to `EdictT | QwEdictT | null` so
  QW's own progs host (src/qw/server/progs.ts) can back-reference its own
  edict type through the same `LinkT`; this module's world.c is the
  WinQuake/NQ server only, so `EDICT_FROM_AREA` narrows with `instanceof
  EdictT` and `Sys_Error`s if a `QwEdictT` ever turned up here (which would
  mean a QW edict got linked into this server's own area lists -- a bug, not
  a case to handle).
- `moveclip_t` is a plain local typedef in the C, declared and used only
  inside world.c with no world.h declaration; ported the same way here, as
  an unexported `MoveClipT` class. Its `mins`/`maxs`/`start`/`end` fields are
  raw pointers in the C that alias the caller's vectors (`clip.start = start`
  is pointer assignment, not a copy) -- SV_Move below assigns the same
  `Vec3` references into `MoveClipT`'s fields rather than copying, to match.
- `sv_areanodes`/`sv_numareanodes` are C `static` file-scope globals with no
  world.h declaration, so nothing outside world.c ever reads them. This port
  exports both anyway (deviation) because the unit brief's own test list asks
  for "SV_ClearWorld builds 32 area nodes" to be asserted directly; nothing
  but world.ts itself and test/world.test.ts read or write them.
- `SV_FindTouchedLeafs`'s C `leafnum = leaf - sv.worldmodel->leafs - 1`
  pointer-difference becomes `worldmodel.leafs.indexOf(node) - 1`: model.ts's
  `MleafT` carries no index field of its own (out of this unit's scope to
  add), and `indexOf` over the same array the C subtracts against recovers
  the identical index.
- The `#ifdef QUAKE2` rotated-bmodel branches in `SV_LinkEdict` and
  `SV_ClipMoveToEntity` are dropped per PORTING.md's "#ifdef... QUAKE2...
  take the portable path" rule: WinQuake's `SV_ClipMoveToEntity` rotates
  start/end into the model's frame of reference only under `#ifdef QUAKE2`,
  which a WinQuake build never defines, so the non-QUAKE2 path (offset only,
  no rotation) is the one this port runs unconditionally, matching the
  actual compiled WinQuake behavior for `SOLID_BSP`.
- `#if !id386` / `#else` around `SV_HullPointContents`: only the portable
  (`!id386`) C body exists; the `#else` half is `d_hull.s` assembly, dropped
  per PORTING.md's asm rule. `#if 1` / `#else` inside `SV_RecursiveHullCheck`
  keeps the `#if 1` half (the `#else` DIST_EPSILON-fringe variant is dead
  code in the shipped source). `#ifdef PARANOID` inside
  `SV_RecursiveHullCheck` is dropped (never defined).
- `PR_ExecuteProgram` is imported from "../progs/pr_exec" (U022, concurrent
  with this unit) with the signature `(fnum: number): void` the unit brief
  specifies. If that module is not yet landed, `bun run check`'s only
  failure from this file is `Cannot find module '../progs/pr_exec'`.
*/

import { EdictT, LinkT, MAX_ENT_LEAFS, NUM_FOR_EDICT, EDICT_TO_PROG, PROG_TO_EDICT, pr } from "../progs/progs";
import type { GlobalVars } from "../progs/progdefs";
import { PR_ExecuteProgram } from "../progs/pr_exec";
import {
  sv,
  MOVETYPE_PUSH,
  SOLID_NOT,
  SOLID_TRIGGER,
  SOLID_BSP,
  FL_ITEM,
  FL_MONSTER,
} from "./server";
import { type ModelT, HullT, type MnodeT, type MleafT, isMleaf, mod_brush } from "../common/model";
import { CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER, CONTENTS_CURRENT_0, CONTENTS_CURRENT_DOWN, DclipnodeT } from "../common/bspfile";
import {
  type Vec3,
  MplaneT,
  vec3,
  vec3_origin,
  DotProduct,
  VectorAdd,
  VectorSubtract,
  VectorCopy,
  BOX_ON_PLANE_SIDE,
} from "../common/mathlib";
import { Sys_Error, SysError } from "../platform/sys";
import { Con_DPrintf } from "../client/console";

//============================================================================
// world.h's plane_t / trace_t

export class PlaneT {
  normal: Vec3 = vec3();
  dist = 0;
}

export class TraceT {
  allsolid = false; // if true, plane is not valid
  startsolid = false; // if true, the initial point was in a solid area
  inopen = false;
  inwater = false;
  fraction = 0; // time completed, 1.0 = didn't hit anything
  endpos: Vec3 = vec3(); // final position
  plane: PlaneT = new PlaneT(); // surface normal at impact
  ent: EdictT | null = null; // entity the surface is on

  // memset (&trace, 0, sizeof(trace_t)) -- see file header's deviation note.
  clear(): void {
    this.allsolid = false;
    this.startsolid = false;
    this.inopen = false;
    this.inwater = false;
    this.fraction = 0;
    this.endpos = vec3();
    this.plane = new PlaneT();
    this.ent = null;
  }
}

export const MOVE_NORMAL = 0;
export const MOVE_NOMONSTERS = 1;
export const MOVE_MISSILE = 2;

function EDICT_FROM_AREA(l: LinkT): EdictT {
  if (l.owner === null) throw new SysError("EDICT_FROM_AREA: link has no owner");
  if (!(l.owner instanceof EdictT)) throw new SysError("EDICT_FROM_AREA: link owner is not an EdictT");
  return l.owner;
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("world: sv.worldmodel not set");
  return sv.worldmodel;
}

function requireGlobalStruct(): GlobalVars {
  if (pr.global_struct === null) throw new SysError("world: progs not loaded");
  return pr.global_struct;
}

/*
===============================================================================

HULL BOXES

===============================================================================
*/

const box_hull = new HullT();
const box_clipnodes: DclipnodeT[] = Array.from({ length: 6 }, () => new DclipnodeT());
const box_planes: MplaneT[] = Array.from({ length: 6 }, () => new MplaneT());

/*
===================
SV_InitBoxHull

Set up the planes and clipnodes so that the six floats of a bounding box
can just be stored out and get a proper hull_t structure.
===================
*/
export function SV_InitBoxHull(): void {
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
SV_HullForBox

To keep everything totally uniform, bounding boxes are turned into small
BSP trees instead of being compared directly.
===================
*/
export function SV_HullForBox(mins: Vec3, maxs: Vec3): HullT {
  box_planes[0].dist = maxs[0];
  box_planes[1].dist = mins[0];
  box_planes[2].dist = maxs[1];
  box_planes[3].dist = mins[1];
  box_planes[4].dist = maxs[2];
  box_planes[5].dist = mins[2];

  return box_hull;
}

/*
================
SV_HullForEntity

Returns a hull that can be used for testing or clipping an object of mins/maxs
size.
Offset is filled in to contain the adjustment that must be added to the
testing object's origin to get a point to use with the returned hull.
================
*/
export function SV_HullForEntity(ent: EdictT, mins: Vec3, maxs: Vec3, offset: Vec3): HullT {
  let hull: HullT;

  // decide which clipping hull to use, based on the size
  if (ent.v.solid === SOLID_BSP) {
    // explicit hulls in the BSP model
    if (ent.v.movetype !== MOVETYPE_PUSH) Sys_Error("SOLID_BSP without MOVETYPE_PUSH");

    const model = sv.models[ent.v.modelindex | 0];

    if (!model || model.type !== mod_brush) Sys_Error("MOVETYPE_PUSH with a non bsp model");

    const size = vec3();
    VectorSubtract(maxs, mins, size);
    if (size[0] < 3) hull = model.hulls[0];
    else if (size[0] <= 32) hull = model.hulls[1];
    else hull = model.hulls[2];

    // calculate an offset value to center the origin
    VectorSubtract(hull.clip_mins, mins, offset);
    VectorAdd(offset, ent.v.origin, offset);
  } else {
    // create a temp hull from bounding box sizes
    const hullmins = vec3();
    const hullmaxs = vec3();
    VectorSubtract(ent.v.mins, maxs, hullmins);
    VectorSubtract(ent.v.maxs, mins, hullmaxs);
    hull = SV_HullForBox(hullmins, hullmaxs);

    VectorCopy(ent.v.origin, offset);
  }

  return hull;
}

/*
===============================================================================

ENTITY AREA CHECKING

===============================================================================
*/

export class AreanodeT {
  axis = 0; // -1 = leaf node (0 is memset's zero-init before SV_CreateAreaNode assigns real values)
  dist = 0;
  children: [AreanodeT | null, AreanodeT | null] = [null, null];
  trigger_edicts: LinkT = new LinkT();
  solid_edicts: LinkT = new LinkT();
}

export const AREA_DEPTH = 4;
export const AREA_NODES = 32;

export const sv_areanodes: AreanodeT[] = Array.from({ length: AREA_NODES }, () => new AreanodeT());
export let sv_numareanodes = 0;

//============================================================================
// common.h's link_t functions -- see file header's deviation note.

export function ClearLink(l: LinkT): void {
  l.prev = l;
  l.next = l;
}

export function RemoveLink(l: LinkT): void {
  const next = l.next;
  const prev = l.prev;
  if (next === null || prev === null) throw new SysError("RemoveLink: link is not linked in");
  next.prev = prev;
  prev.next = next;
}

export function InsertLinkBefore(l: LinkT, before: LinkT): void {
  l.next = before;
  const prev = before.prev;
  if (prev === null) throw new SysError("InsertLinkBefore: before is not linked in");
  l.prev = prev;
  l.prev.next = l;
  l.next.prev = l;
}

export function InsertLinkAfter(l: LinkT, after: LinkT): void {
  const next = after.next;
  if (next === null) throw new SysError("InsertLinkAfter: after is not linked in");
  l.next = next;
  l.prev = after;
  l.prev.next = l;
  l.next.prev = l;
}

/*
===============
SV_CreateAreaNode

===============
*/
export function SV_CreateAreaNode(depth: number, mins: Vec3, maxs: Vec3): AreanodeT {
  const anode = sv_areanodes[sv_numareanodes];
  sv_numareanodes++;

  ClearLink(anode.trigger_edicts);
  ClearLink(anode.solid_edicts);

  if (depth === AREA_DEPTH) {
    anode.axis = -1;
    anode.children[0] = null;
    anode.children[1] = null;
    return anode;
  }

  const size = vec3();
  VectorSubtract(maxs, mins, size);
  if (size[0] > size[1]) anode.axis = 0;
  else anode.axis = 1;

  anode.dist = 0.5 * (maxs[anode.axis] + mins[anode.axis]);
  const mins1 = vec3();
  const mins2 = vec3();
  const maxs1 = vec3();
  const maxs2 = vec3();
  VectorCopy(mins, mins1);
  VectorCopy(mins, mins2);
  VectorCopy(maxs, maxs1);
  VectorCopy(maxs, maxs2);

  maxs1[anode.axis] = anode.dist;
  mins2[anode.axis] = anode.dist;

  anode.children[0] = SV_CreateAreaNode(depth + 1, mins2, maxs2);
  anode.children[1] = SV_CreateAreaNode(depth + 1, mins1, maxs1);

  return anode;
}

/*
===============
SV_ClearWorld

===============
*/
export function SV_ClearWorld(): void {
  SV_InitBoxHull();

  for (let i = 0; i < AREA_NODES; i++) sv_areanodes[i] = new AreanodeT();
  sv_numareanodes = 0;
  const worldmodel = requireWorldmodel();
  SV_CreateAreaNode(0, worldmodel.mins, worldmodel.maxs);
}

/*
===============
SV_UnlinkEdict

===============
*/
export function SV_UnlinkEdict(ent: EdictT): void {
  if (ent.area.prev === null) return; // not linked in anywhere
  RemoveLink(ent.area);
  ent.area.prev = null;
  ent.area.next = null;
}

/*
====================
SV_TouchLinks
====================
*/
export function SV_TouchLinks(ent: EdictT, node: AreanodeT): void {
  // touch linked edicts
  let next: LinkT | null = null;
  for (let l = node.trigger_edicts.next; l !== null && l !== node.trigger_edicts; l = next) {
    next = l.next;
    const touch = EDICT_FROM_AREA(l);
    if (touch === ent) continue;
    if (touch.v.touch === 0 || touch.v.solid !== SOLID_TRIGGER) continue;
    if (
      ent.v.absmin[0] > touch.v.absmax[0] ||
      ent.v.absmin[1] > touch.v.absmax[1] ||
      ent.v.absmin[2] > touch.v.absmax[2] ||
      ent.v.absmax[0] < touch.v.absmin[0] ||
      ent.v.absmax[1] < touch.v.absmin[1] ||
      ent.v.absmax[2] < touch.v.absmin[2]
    )
      continue;

    const globals = requireGlobalStruct();
    const old_self = globals.self;
    const old_other = globals.other;

    globals.self = EDICT_TO_PROG(touch);
    globals.other = EDICT_TO_PROG(ent);
    globals.time = sv.time;
    PR_ExecuteProgram(touch.v.touch);

    globals.self = old_self;
    globals.other = old_other;
  }

  // recurse down both sides
  if (node.axis === -1) return;

  const c0 = node.children[0];
  const c1 = node.children[1];
  if (ent.v.absmax[node.axis] > node.dist && c0 !== null) SV_TouchLinks(ent, c0);
  if (ent.v.absmin[node.axis] < node.dist && c1 !== null) SV_TouchLinks(ent, c1);
}

/*
===============
SV_FindTouchedLeafs

===============
*/
export function SV_FindTouchedLeafs(ent: EdictT, node: MnodeT | MleafT): void {
  if (node.contents === CONTENTS_SOLID) return;

  // add an efrag if the node is a leaf
  if (isMleaf(node)) {
    if (ent.num_leafs === MAX_ENT_LEAFS) return;

    const worldmodel = requireWorldmodel();
    const leafnum = worldmodel.leafs.indexOf(node) - 1;

    ent.leafnums[ent.num_leafs] = leafnum;
    ent.num_leafs++;
    return;
  }

  // NODE_MIXED
  const splitplane = node.plane;
  if (splitplane === null) throw new SysError("SV_FindTouchedLeafs: node has no plane");
  const sides = BOX_ON_PLANE_SIDE(ent.v.absmin, ent.v.absmax, splitplane);

  // recurse down the contacted sides
  const c0 = node.children[0];
  const c1 = node.children[1];
  if (sides & 1 && c0 !== null) SV_FindTouchedLeafs(ent, c0);

  if (sides & 2 && c1 !== null) SV_FindTouchedLeafs(ent, c1);
}

/*
===============
SV_LinkEdict

===============
*/
export function SV_LinkEdict(ent: EdictT, touch_triggers: boolean): void {
  if (ent.area.prev !== null) SV_UnlinkEdict(ent); // unlink from old position

  if (NUM_FOR_EDICT(ent) === 0) return; // don't add the world

  if (ent.free) return;

  // set the abs box

  VectorAdd(ent.v.origin, ent.v.mins, ent.v.absmin);
  VectorAdd(ent.v.origin, ent.v.maxs, ent.v.absmax);

  //
  // to make items easier to pick up and allow them to be grabbed off
  // of shelves, the abs sizes are expanded
  //
  if ((ent.v.flags | 0) & FL_ITEM) {
    ent.v.absmin[0] -= 15;
    ent.v.absmin[1] -= 15;
    ent.v.absmax[0] += 15;
    ent.v.absmax[1] += 15;
  } else {
    // because movement is clipped an epsilon away from an actual edge,
    // we must fully check even when bounding boxes don't quite touch
    ent.v.absmin[0] -= 1;
    ent.v.absmin[1] -= 1;
    ent.v.absmin[2] -= 1;
    ent.v.absmax[0] += 1;
    ent.v.absmax[1] += 1;
    ent.v.absmax[2] += 1;
  }

  // link to PVS leafs
  ent.num_leafs = 0;
  if (ent.v.modelindex) SV_FindTouchedLeafs(ent, requireWorldmodel().nodes[0]);

  if (ent.v.solid === SOLID_NOT) return;

  // find the first node that the ent's box crosses
  let node: AreanodeT = sv_areanodes[0];
  for (;;) {
    if (node.axis === -1) break;
    if (ent.v.absmin[node.axis] > node.dist) {
      const c = node.children[0];
      if (c === null) break;
      node = c;
    } else if (ent.v.absmax[node.axis] < node.dist) {
      const c = node.children[1];
      if (c === null) break;
      node = c;
    } else break; // crosses the node
  }

  // link it in

  if (ent.v.solid === SOLID_TRIGGER) InsertLinkBefore(ent.area, node.trigger_edicts);
  else InsertLinkBefore(ent.area, node.solid_edicts);

  // if touch_triggers, touch all entities at this node and decend for more
  if (touch_triggers) SV_TouchLinks(ent, sv_areanodes[0]);
}

/*
===============================================================================

POINT TESTING IN HULLS

===============================================================================
*/

/*
==================
SV_HullPointContents

==================
*/
export function SV_HullPointContents(hull: HullT, startnum: number, p: Vec3): number {
  let num = startnum;

  while (num >= 0) {
    if (num < hull.firstclipnode || num > hull.lastclipnode) Sys_Error("SV_HullPointContents: bad node number");

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
SV_PointContents

==================
*/
export function SV_PointContents(p: Vec3): number {
  let cont = SV_HullPointContents(requireWorldmodel().hulls[0], 0, p);
  if (cont <= CONTENTS_CURRENT_0 && cont >= CONTENTS_CURRENT_DOWN) cont = CONTENTS_WATER;
  return cont;
}

export function SV_TruePointContents(p: Vec3): number {
  return SV_HullPointContents(requireWorldmodel().hulls[0], 0, p);
}

//===========================================================================

/*
============
SV_TestEntityPosition

This could be a lot more efficient...
============
*/
export function SV_TestEntityPosition(ent: EdictT): EdictT | null {
  const trace = SV_Move(ent.v.origin, ent.v.mins, ent.v.maxs, ent.v.origin, MOVE_NORMAL, ent);

  if (trace.startsolid) return sv.edicts[0];

  return null;
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
SV_RecursiveHullCheck

==================
*/
export function SV_RecursiveHullCheck(hull: HullT, num: number, p1f: number, p2f: number, p1: Vec3, p2: Vec3, trace: TraceT): boolean {
  // check for empty
  if (num < 0) {
    if (num !== CONTENTS_SOLID) {
      trace.allsolid = false;
      if (num === CONTENTS_EMPTY) trace.inopen = true;
      else trace.inwater = true;
    } else trace.startsolid = true;
    return true; // empty
  }

  if (num < hull.firstclipnode || num > hull.lastclipnode) Sys_Error("SV_RecursiveHullCheck: bad node number");

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

  if (t1 >= 0 && t2 >= 0) return SV_RecursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
  if (t1 < 0 && t2 < 0) return SV_RecursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);

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
  if (!SV_RecursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace)) return false;

  if (SV_HullPointContents(hull, node.children[side ^ 1], mid) !== CONTENTS_SOLID)
    // go past the node
    return SV_RecursiveHullCheck(hull, node.children[side ^ 1], midf, p2f, mid, p2, trace);

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

  while (SV_HullPointContents(hull, hull.firstclipnode, mid) === CONTENTS_SOLID) {
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
==================
SV_ClipMoveToEntity

Handles selection or creation of a clipping hull, and offseting (and
eventually rotation) of the end points
==================
*/
export function SV_ClipMoveToEntity(ent: EdictT, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): TraceT {
  // fill in a default trace
  const trace = new TraceT();
  trace.clear();
  trace.fraction = 1;
  trace.allsolid = true;
  VectorCopy(end, trace.endpos);

  // get the clipping hull
  const offset = vec3();
  const hull = SV_HullForEntity(ent, mins, maxs, offset);

  const start_l = vec3();
  const end_l = vec3();
  VectorSubtract(start, offset, start_l);
  VectorSubtract(end, offset, end_l);

  // trace a line through the apropriate clipping hull
  SV_RecursiveHullCheck(hull, hull.firstclipnode, 0, 1, start_l, end_l, trace);

  // fix trace up by the offset
  if (trace.fraction !== 1) VectorAdd(trace.endpos, offset, trace.endpos);

  // did we clip the move?
  if (trace.fraction < 1 || trace.startsolid) trace.ent = ent;

  return trace;
}

//===========================================================================

// C's local `moveclip_t` (world.c, no world.h declaration) -- see file
// header's deviation note.
class MoveClipT {
  boxmins: Vec3 = vec3();
  boxmaxs: Vec3 = vec3(); // enclose the test object along entire move
  mins: Vec3 = vec3();
  maxs: Vec3 = vec3(); // size of the moving object
  mins2: Vec3 = vec3();
  maxs2: Vec3 = vec3(); // size when clipping against mosnters
  start: Vec3 = vec3();
  end: Vec3 = vec3();
  trace: TraceT = new TraceT();
  type = MOVE_NORMAL;
  passedict: EdictT | null = null;
}

/*
====================
SV_ClipToLinks

Mins and maxs enclose the entire area swept by the move
====================
*/
export function SV_ClipToLinks(node: AreanodeT, clip: MoveClipT): void {
  // touch linked edicts
  let next: LinkT | null = null;
  for (let l = node.solid_edicts.next; l !== null && l !== node.solid_edicts; l = next) {
    next = l.next;
    const touch = EDICT_FROM_AREA(l);

    if (touch.v.solid === SOLID_NOT) continue;
    if (touch === clip.passedict) continue;
    if (touch.v.solid === SOLID_TRIGGER) Sys_Error("Trigger in clipping list");

    if (clip.type === MOVE_NOMONSTERS && touch.v.solid !== SOLID_BSP) continue;

    if (
      clip.boxmins[0] > touch.v.absmax[0] ||
      clip.boxmins[1] > touch.v.absmax[1] ||
      clip.boxmins[2] > touch.v.absmax[2] ||
      clip.boxmaxs[0] < touch.v.absmin[0] ||
      clip.boxmaxs[1] < touch.v.absmin[1] ||
      clip.boxmaxs[2] < touch.v.absmin[2]
    )
      continue;

    if (clip.passedict !== null && clip.passedict.v.size[0] !== 0 && touch.v.size[0] === 0) continue; // points never interact

    // might intersect, so do an exact clip
    if (clip.trace.allsolid) return;
    if (clip.passedict !== null) {
      if (PROG_TO_EDICT(touch.v.owner) === clip.passedict) continue; // don't clip against own missiles
      if (PROG_TO_EDICT(clip.passedict.v.owner) === touch) continue; // don't clip against owner
    }

    let trace: TraceT;
    if ((touch.v.flags | 0) & FL_MONSTER) trace = SV_ClipMoveToEntity(touch, clip.start, clip.mins2, clip.maxs2, clip.end);
    else trace = SV_ClipMoveToEntity(touch, clip.start, clip.mins, clip.maxs, clip.end);

    if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
      trace.ent = touch;
      if (clip.trace.startsolid) {
        clip.trace = trace;
        clip.trace.startsolid = true;
      } else clip.trace = trace;
    } else if (trace.startsolid) clip.trace.startsolid = true;
  }

  // recurse down both sides
  if (node.axis === -1) return;

  const c0 = node.children[0];
  const c1 = node.children[1];
  if (clip.boxmaxs[node.axis] > node.dist && c0 !== null) SV_ClipToLinks(c0, clip);
  if (clip.boxmins[node.axis] < node.dist && c1 !== null) SV_ClipToLinks(c1, clip);
}

/*
==================
SV_MoveBounds
==================
*/
export function SV_MoveBounds(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, boxmins: Vec3, boxmaxs: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if (end[i] > start[i]) {
      boxmins[i] = start[i] + mins[i] - 1;
      boxmaxs[i] = end[i] + maxs[i] + 1;
    } else {
      boxmins[i] = end[i] + mins[i] - 1;
      boxmaxs[i] = start[i] + maxs[i] + 1;
    }
  }
}

/*
==================
SV_Move
==================
*/
export function SV_Move(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, type: number, passedict: EdictT | null): TraceT {
  const clip = new MoveClipT();

  // clip to world
  clip.trace = SV_ClipMoveToEntity(sv.edicts[0], start, mins, maxs, end);

  clip.start = start;
  clip.end = end;
  clip.mins = mins;
  clip.maxs = maxs;
  clip.type = type;
  clip.passedict = passedict;

  if (type === MOVE_MISSILE) {
    for (let i = 0; i < 3; i++) {
      clip.mins2[i] = -15;
      clip.maxs2[i] = 15;
    }
  } else {
    VectorCopy(mins, clip.mins2);
    VectorCopy(maxs, clip.maxs2);
  }

  // create the bounding box of the entire move
  SV_MoveBounds(start, clip.mins2, clip.maxs2, end, clip.boxmins, clip.boxmaxs);

  // clip to entities
  SV_ClipToLinks(sv_areanodes[0], clip);

  return clip.trace;
}
