/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/server/world.h and QW/server/world.c (GNU GPL v2 or later).

world.c -- world query functions

entities never clip against themselves, or their owner

line of sight checks trace->crosscontent, but bullets don't

QW/server/world.c is a 182-changed-line delta of WinQuake/world.c (`diff -w`
against ../qsrc/quake/WinQuake/world.c confirms), landed at src/server/world.ts.
This module mirrors that file's structure/names/comments and applies every
delta the diff shows, verified against both C sources directly (not just the
diff):

- `#include "quakedef.h"` -> `#include "qwsvdef.h"`: no TS effect, this
  module simply imports QW's own `sv`/`QwEdictT`/`qwpr` instead of WinQuake's.
- `Sys_Error` -> `SV_Error` at five call sites (SV_HullForEntity x2,
  SV_HullPointContents, SV_RecursiveHullCheck, SV_ClipToLinks's "Trigger in
  clipping list"). QW's `SV_Error` (QW/server/sv_main.c) prints via
  `Con_Printf` and then calls `Sys_Error` to abort; sv_main.ts has since
  landed and exports the real thing. Call sites below read `SV_Error(...)`
  literally, matching the C, resolving through a local `SV_Error` wrapper
  that delegates to sv_main.ts's export via a lazy `require("./sv_main")`:
  sv_main.ts imports pr_edict.ts, which imports this module (SV_UnlinkEdict),
  so a module-scope import back would be a cycle.
- `Con_DPrintf ("backup past 0\n")` -> `Con_Printf (...)` inside
  SV_RecursiveHullCheck: a real print-level change the C makes (this is why
  SV_RecursiveHullCheck is its own copy here rather than reused from
  src/server/world.ts -- see the reuse note below). qwsv has no console.c of
  its own (qwsvdef.ts's file header already documents this: it reuses
  sys_unix.c's stdio-based implementation). This module routes the one QW
  `Con_Printf` call site through a local wrapper that delegates to
  sv_send.ts's real `Con_Printf` export, again via a lazy
  `require("./sv_send")`: sv_send.ts also imports pr_edict.ts, so the same
  cycle applies.
- The `typedef struct areanode_s {...} areanode_t;` plus `AREA_DEPTH`/
  `AREA_NODES` and `static areanode_t sv_areanodes[AREA_NODES]; static int
  sv_numareanodes;` move out of QW's world.c into a header (this port has no
  separate world.h TS module, per qwsvdef.ts's table, so `AreanodeT`/
  `AREA_DEPTH`/`AREA_NODES` stay declared here, same as src/server/world.ts
  does for WinQuake) -- QW's `sv_areanodes`/`sv_numareanodes` themselves drop
  `static` and become genuine externs in the C (unlike WinQuake's, which stay
  file-local). Both are exported below for that reason: this is QW's actual
  linkage, not merely a test-convenience deviation the way src/server/
  world.ts's file header has to justify it for WinQuake.
- The `#ifdef QUAKE2` rotated-bmodel branches in SV_LinkEdict and
  SV_ClipMoveToEntity are dropped per PORTING.md's "#ifdef... QUAKE2... take
  the portable path" rule, same as src/server/world.ts.
- `SV_PointContents` drops the `CONTENTS_CURRENT_0`/`CONTENTS_CURRENT_DOWN` ->
  `CONTENTS_WATER` remapping WinQuake's version does, and `SV_TruePointContents`
  is not defined at all in QW's world.c (checked: no such symbol anywhere in
  the file) -- neither is ported here.
- `SV_TestEntityPosition`'s doc comment changes from "This could be a lot more
  efficient..." to "A small wrapper around SV_BoxInSolidEntity that never
  clips against the supplied entity." (no `SV_BoxInSolidEntity` function
  exists anywhere in this file or QW/server -- a stale comment inherited from
  an earlier revision of id's own source, kept verbatim per standing order 7).
- `SV_TestPlayerPosition` is new in QW (ported in full below): used by
  pmove/sv_user (SV_TryUnstick/PM_TestPlayerPosition analogues), a genuinely
  different function from src/qw/pmovetst.ts's own `PM_TestPlayerPosition`
  (that one clips against pmove's own physents list; this one walks
  `sv.edicts` through `SV_HullForEntity`, exactly as world.c's other
  functions do).

Reuse decisions (brief: "re-export [SV_RecursiveHullCheck, SV_HullPointContents]
rather than duplicating, but only after checking they don't read WinQuake sv"):
- `SV_HullPointContents`: re-exported from src/server/world.ts unchanged.
  Checked: it only touches its `hull`/`num`/`p` parameters plus `Sys_Error`,
  never WinQuake's `sv` singleton or any other host-specific state -- a pure
  function over hull/plane data. QW's own copy differs from WinQuake's only
  by the `Sys_Error`/`SV_Error` rename, which (per the SV_Error note above)
  resolves to the identical thrown `SysError` either way, so reusing it is
  bit-for-bit faithful, not just close enough.
- `SV_RecursiveHullCheck`: NOT reused, despite passing the same "only touches
  hull/plane/trace data" test for everything except one line -- it also calls
  `Con_DPrintf` (src/client/console.ts, WinQuake's client print boundary),
  and QW's C deliberately swaps that call to `Con_Printf` (a real behavior
  change, not a rename). Reusing WinQuake's copy would make a fatal edge case
  print through the wrong host's console instead of the print boundary a
  headless qwsv actually has (Sys_Printf); it is ported here as its own copy
  with that swap applied, and with `SV_Error` used at its "bad node number"
  abort (matching QW's own call-site text) exactly as the C does.
- `SV_InitBoxHull`/`SV_HullForBox`/`SV_HullForEntity`: NOT reused. These
  share one module-private `box_hull`/`box_clipnodes`/`box_planes` singleton
  triplet, and `SV_HullForEntity` reads `sv.models` directly -- WinQuake's
  `sv`, a different singleton than QW's own `sv` (src/qw/server/server.ts).
  In the original engine these are two separate compiled binaries, each with
  its own `static` copies of this state; re-exporting WinQuake's functions
  here would either read the wrong `sv.models` (a bug) or require threading
  QW's `sv` through WinQuake's module (a layering violation neither file's
  brief asked for). Ported here as QW's own copies, exactly mirroring the
  C's own per-binary duplication.
- `ClearLink`/`RemoveLink`/`InsertLinkBefore`/`InsertLinkAfter`: QW's
  `common.c` (QW/client/common.c, shared into the SERVERONLY qwsv build)
  defines these identically to WinQuake's `common.c`, but src/qw/common.ts
  (Q002, landed) does not yet export them -- the same situation
  src/server/world.ts's own file header documents for WinQuake's common.c
  ("declared and defined in common.h/common.c, not world.h/world.c... ported
  here over LinkT per the brief rather than in a not-yet-existing common.ts
  corner"). Ported here for the same reason, byte-identical to src/server/
  world.ts's versions (they don't reference `sv` at all).

Other deviations from PORTING.md / the C source (mirroring src/server/
world.ts's own documented set, which applies identically here):
- `plane_t` -> `PlaneT`, `trace_t` -> `TraceT` with a `clear()` mirroring
  `memset (&trace, 0, sizeof(trace_t))`.
- `moveclip_t` -> unexported `MoveClipT` class; `mins`/`maxs`/`start`/`end`
  alias the caller's `Vec3`s exactly as the C's raw pointers do.
- `EDICT_FROM_AREA(l)` (progs.h's `STRUCT_FROM_LINK` macro) becomes `l.owner`
  narrowed with `instanceof QwEdictT`, `SV_Error`ing on any other type --
  this server's own `LinkT.owner` should never hold a WinQuake `EdictT`, and
  if it ever did that is a bug, not a case to handle silently.
- `SV_FindTouchedLeafs`'s `leaf - sv.worldmodel->leafs - 1` pointer
  difference becomes `worldmodel.leafs.indexOf(node) - 1`, same as
  src/server/world.ts.
- `#if !id386` / `#else` (SV_HullPointContents' `d_hull.s` half) and
  `#ifdef PARANOID` (never defined) are dropped per PORTING.md's asm/dead-
  branch rules -- moot here since SV_HullPointContents is reused rather than
  re-ported.
- `PR_ExecuteProgram` (QW/server/pr_exec.c): only SV_TouchLinks needs it, to
  run a trigger's `touch` function. pr_exec.ts has landed and is imported
  directly (`import { PR_ExecuteProgram } from "./pr_exec"`) -- no cycle:
  pr_exec.ts's own static imports never lead back to this module.
- `player_mins`/`player_maxs` (src/qw/pmove_types.ts): checked QW/server/
  world.c for any reference -- there is none (`grep` confirms). Nothing to
  reuse here; SV_TestPlayerPosition takes its box from the caller's own
  `ent->v.mins/maxs`, not a hardcoded player box.
*/

import { QwEdictT, LinkT, MAX_ENT_LEAFS, NUM_FOR_EDICT, EDICT_TO_PROG, PROG_TO_EDICT, qwpr } from "./progs";
import type { QwGlobalVars } from "./progdefs";
import { sv, MOVETYPE_PUSH, SOLID_NOT, SOLID_TRIGGER, SOLID_BSP, SOLID_BBOX, SOLID_SLIDEBOX, FL_ITEM, FL_MONSTER } from "./server";
import { type ModelT, HullT, type MnodeT, type MleafT, isMleaf, mod_brush } from "../../common/model";
import { CONTENTS_EMPTY, CONTENTS_SOLID, DclipnodeT } from "../../common/bspfile";
import { type Vec3, MplaneT, vec3, vec3_origin, DotProduct, VectorAdd, VectorSubtract, VectorCopy, BOX_ON_PLANE_SIDE } from "../../common/mathlib";
import { SysError } from "../../platform/sys";
import { SV_HullPointContents } from "../../server/world";
import { PR_ExecuteProgram } from "./pr_exec";
import type * as SvMainModule from "./sv_main";
import type * as SvSendModule from "./sv_send";

export { SV_HullPointContents };

// sv_main.ts imports pr_edict.ts, which imports this module (SV_UnlinkEdict),
// so a module-scope import of sv_main.ts here would be a cycle; see file
// header's SV_Error deviation note.
function svMainMod(): typeof SvMainModule {
  return require("./sv_main");
}

// sv_send.ts imports pr_edict.ts, which imports this module, so a
// module-scope import of sv_send.ts here would be a cycle; see file header's
// Con_Printf deviation note.
function svSendMod(): typeof SvSendModule {
  return require("./sv_send");
}

// See file header's SV_Error deviation note: now the real sv_main.ts SV_Error.
function SV_Error(error: string, ...args: Array<string | number>): never {
  return svMainMod().SV_Error(error, ...args);
}

// See file header's Con_Printf deviation note: now the real sv_send.ts Con_Printf.
function Con_Printf(fmt: string, ...args: Array<string | number>): void {
  svSendMod().Con_Printf(fmt, ...args);
}

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
  ent: QwEdictT | null = null; // entity the surface is on

  // memset (&trace, 0, sizeof(trace_t)) -- see src/server/world.ts's note.
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

function EDICT_FROM_AREA(l: LinkT): QwEdictT {
  if (l.owner === null) throw new SysError("EDICT_FROM_AREA: link has no owner");
  if (!(l.owner instanceof QwEdictT)) throw new SysError("EDICT_FROM_AREA: link owner is not a QwEdictT");
  return l.owner;
}

function requireWorldmodel(): ModelT {
  if (sv.worldmodel === null) throw new SysError("world: sv.worldmodel not set");
  return sv.worldmodel;
}

function requireGlobalStruct(): QwGlobalVars {
  if (qwpr.global_struct === null) throw new SysError("world: progs not loaded");
  return qwpr.global_struct;
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
export function SV_HullForEntity(ent: QwEdictT, mins: Vec3, maxs: Vec3, offset: Vec3): HullT {
  let hull: HullT;

  // decide which clipping hull to use, based on the size
  if (ent.v.solid === SOLID_BSP) {
    // explicit hulls in the BSP model
    if (ent.v.movetype !== MOVETYPE_PUSH) SV_Error("SOLID_BSP without MOVETYPE_PUSH");

    const model = sv.models[ent.v.modelindex | 0];

    if (!model || model.type !== mod_brush) SV_Error("MOVETYPE_PUSH with a non bsp model");

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
// common.c's link_t functions -- see file header's deviation note.

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
export function SV_UnlinkEdict(ent: QwEdictT): void {
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
export function SV_TouchLinks(ent: QwEdictT, node: AreanodeT): void {
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
export function SV_FindTouchedLeafs(ent: QwEdictT, node: MnodeT | MleafT): void {
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
export function SV_LinkEdict(ent: QwEdictT, touch_triggers: boolean): void {
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
SV_PointContents

==================
*/
export function SV_PointContents(p: Vec3): number {
  return SV_HullPointContents(requireWorldmodel().hulls[0], 0, p);
}

//===========================================================================

/*
============
SV_TestEntityPosition

A small wrapper around SV_BoxInSolidEntity that never clips against the
supplied entity.
============
*/
export function SV_TestEntityPosition(ent: QwEdictT): QwEdictT | null {
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

  if (num < hull.firstclipnode || num > hull.lastclipnode) SV_Error("SV_RecursiveHullCheck: bad node number");

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
      Con_Printf("backup past 0\n");
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
export function SV_ClipMoveToEntity(ent: QwEdictT, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): TraceT {
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
  passedict: QwEdictT | null = null;
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
    if (touch.v.solid === SOLID_TRIGGER) SV_Error("Trigger in clipping list");

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
export function SV_Move(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, type: number, passedict: QwEdictT | null): TraceT {
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

//=============================================================================

/*
============
SV_TestPlayerPosition

============
*/
export function SV_TestPlayerPosition(ent: QwEdictT, origin: Vec3): QwEdictT | null {
  // check world first
  let hull: HullT = requireWorldmodel().hulls[1];
  if (SV_HullPointContents(hull, hull.firstclipnode, origin) !== CONTENTS_EMPTY) return sv.edicts[0];

  // check all entities
  const boxmins = vec3();
  const boxmaxs = vec3();
  VectorAdd(origin, ent.v.mins, boxmins);
  VectorAdd(origin, ent.v.maxs, boxmaxs);

  for (let e = 1; e < sv.num_edicts; e++) {
    const check = sv.edicts[e];
    if (check.free) continue;
    if (check.v.solid !== SOLID_BSP && check.v.solid !== SOLID_BBOX && check.v.solid !== SOLID_SLIDEBOX) continue;

    if (
      boxmins[0] > check.v.absmax[0] ||
      boxmins[1] > check.v.absmax[1] ||
      boxmins[2] > check.v.absmax[2] ||
      boxmaxs[0] < check.v.absmin[0] ||
      boxmaxs[1] < check.v.absmin[1] ||
      boxmaxs[2] < check.v.absmin[2]
    )
      continue;

    if (check === ent) continue;

    // get the clipping hull
    const offset = vec3();
    hull = SV_HullForEntity(check, ent.v.mins, ent.v.maxs, offset);

    VectorSubtract(origin, offset, offset);

    // test the point
    if (SV_HullPointContents(hull, hull.firstclipnode, offset) !== CONTENTS_EMPTY) return check;
  }

  return null;
}
