/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_efrag.c (GNU GPL v2 or later).

r_efrag.c: entity fragment (efrag_t) linkage between world leafs and the
entities visible through them -- R_AddEfrags splits an entity's bounding
box down the world BSP and threads one efrag per leaf it touches onto both
the entity's own chain (`entity->efrag`) and that leaf's chain
(`leaf->efrags`); R_StoreEfrags (called per visible leaf by r_bsp.c/
r_edge.c, U063) walks a leaf's chain to populate `cl_visedicts`.

Deviations from PORTING.md / the C source:
- `efrag_t **lastlink` is a pointer to the slot the next linked efrag should
  be written into (`&ent->efrag` initially, `&ef->entnext` after each link).
  This port has no pointer-to-a-field, so `lastEfrag` tracks the same
  progression as a plain value: `null` means "the next efrag goes into
  r_addent.efrag", any other value means "the next efrag goes into
  lastEfrag.entnext" -- `linkEfrag` below is the single write site that
  captures both cases, exactly as `*lastlink = ef; lastlink = &ef->entnext;`
  does.
- `R_RemoveEfrags`'s `efrag_t **prev` walk of `leaf->efrags` (find `ef`,
  patch out the pointer that referenced it) becomes `unlinkEfragFromLeaf`,
  a plain linked-list splice over `leaf.efrags`/`.leafnext` doing the same
  patch without needing a pointer-to-a-slot.
- `r_pefragtopnode`'s C type is `mnode_t *`, but the leaf branches store a
  leaf pointer in it; `RStateT.r_pefragtopnode` and `EntityT.topnode` are
  typed `MnodeT | MleafT | null` for exactly that, and consumers narrow with
  `isMleaf`/`contents` as the C does.

- `r_addent` (module-private `EntityT | null`, the entity R_SplitEntityOnNode
  is currently splitting) is r_efrag.c file scope, read by no other .c file,
  so it is not on `rState` (not present in r_shared.ts's ownership list for
  this file).
- `R_StoreEfrags(efrag_t **ppefrag)` takes a pointer to the caller's cursor
  slot only so it can advance through the list (`ppefrag = &pefrag->
  leafnext`); it never rewrites anything through it. Ported as
  `R_StoreEfrags(leafEfrags: EfragT | null)` taking the list head directly
  (a leaf's `.efrags`) and walking `.leafnext` locally -- same reads, same
  order, no list mutation either way.
*/

import { BOX_ON_PLANE_SIDE } from "../common/mathlib";
import { CONTENTS_SOLID } from "../common/bspfile";
import { ModtypeT, type MleafT, type MnodeT, isMleaf } from "../common/model";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import { cl, cl_entities, cl_visedicts, clState, MAX_VISEDICTS } from "../client/client";
import { qw } from "../common/quakedef";
import type { EfragT, EntityT } from "../client/render";
import { r_emins, r_emaxs } from "./r_local";
import { rState } from "./r_shared";

let r_addent: EntityT | null = null;
let lastEfrag: EfragT | null = null; // null => next link target is r_addent.efrag

function linkEfrag(ef: EfragT): void {
  if (lastEfrag === null) {
    if (r_addent === null) Sys_Error("R_SplitEntityOnNode: no current entity");
    r_addent.efrag = ef;
  } else {
    lastEfrag.entnext = ef;
  }
  ef.entnext = null;
  lastEfrag = ef;
}

function unlinkEfragFromLeaf(leaf: MleafT, ef: EfragT): void {
  if (leaf.efrags === ef) {
    leaf.efrags = ef.leafnext;
    return;
  }
  let walk = leaf.efrags;
  while (walk !== null) {
    if (walk.leafnext === ef) {
      walk.leafnext = ef.leafnext;
      return;
    }
    walk = walk.leafnext;
  }
}

/*
================
R_RemoveEfrags

Call when removing an object from the world or moving it to another position
================
*/
export function R_RemoveEfrags(ent: EntityT): void {
  let ef = ent.efrag;

  while (ef !== null) {
    if (ef.leaf === null) Sys_Error("R_RemoveEfrags: efrag has no leaf");
    unlinkEfragFromLeaf(ef.leaf, ef);

    const old = ef;
    ef = ef.entnext;

    // put it on the free list
    old.entnext = cl.free_efrags;
    cl.free_efrags = old;
  }

  ent.efrag = null;
}

/*
===================
R_SplitEntityOnNode
===================
*/
function R_SplitEntityOnNode(node: MnodeT | MleafT): void {
  if (node.contents === CONTENTS_SOLID) {
    return;
  }

  // add an efrag if the node is a leaf
  if (isMleaf(node)) {
    if (rState.r_pefragtopnode === null) rState.r_pefragtopnode = node;

    // grab an efrag off the free list
    const ef = cl.free_efrags;
    if (ef === null) {
      Con_Printf("Too many efrags!\n");
      return; // no free fragments...
    }
    cl.free_efrags = ef.entnext;

    ef.entity = r_addent;

    // add the entity link
    linkEfrag(ef);

    // set the leaf links
    ef.leaf = node;
    ef.leafnext = node.efrags;
    node.efrags = ef;

    return;
  }

  // NODE_MIXED
  const splitplane = node.plane;
  if (splitplane === null) Sys_Error("R_SplitEntityOnNode: bad node");
  const sides = BOX_ON_PLANE_SIDE(r_emins, r_emaxs, splitplane);

  if (sides === 3) {
    // split on this plane
    // if this is the first splitter of this bmodel, remember it
    if (rState.r_pefragtopnode === null) rState.r_pefragtopnode = node;
  }

  // recurse down the contacted sides
  if (sides & 1) {
    const child = node.children[0];
    if (child === null) Sys_Error("R_SplitEntityOnNode: bad model");
    R_SplitEntityOnNode(child);
  }

  if (sides & 2) {
    const child = node.children[1];
    if (child === null) Sys_Error("R_SplitEntityOnNode: bad model");
    R_SplitEntityOnNode(child);
  }
}

/*
===================
R_SplitEntityOnNode2
===================
*/
export function R_SplitEntityOnNode2(node: MnodeT | MleafT): void {
  if (node.visframe !== rState.r_visframecount) return;

  if (isMleaf(node)) {
    if (node.contents !== CONTENTS_SOLID) {
      // we've reached a non-solid leaf, so it's visible and not BSP clipped
      rState.r_pefragtopnode = node;
    }
    return;
  }

  const splitplane = node.plane;
  if (splitplane === null) Sys_Error("R_SplitEntityOnNode2: bad node");
  const sides = BOX_ON_PLANE_SIDE(r_emins, r_emaxs, splitplane);

  if (sides === 3) {
    // remember first splitter
    rState.r_pefragtopnode = node;
    return;
  }

  // not split yet; recurse down the contacted side
  if (sides & 1) {
    const child = node.children[0];
    if (child === null) Sys_Error("R_SplitEntityOnNode2: bad model");
    R_SplitEntityOnNode2(child);
  } else {
    const child = node.children[1];
    if (child === null) Sys_Error("R_SplitEntityOnNode2: bad model");
    R_SplitEntityOnNode2(child);
  }
}

/*
===========
R_AddEfrags
===========
*/
export function R_AddEfrags(ent: EntityT): void {
  if (ent.model === null) return;

  if (ent === cl_entities[0]) return; // never add the world

  r_addent = ent;
  lastEfrag = null;
  rState.r_pefragtopnode = null;

  const entmodel = ent.model;

  for (let i = 0; i < 3; i++) {
    r_emins[i] = ent.origin[i] + entmodel.mins[i];
    r_emaxs[i] = ent.origin[i] + entmodel.maxs[i];
  }

  if (cl.worldmodel === null || cl.worldmodel.nodes.length === 0) Sys_Error("R_AddEfrags: no worldmodel");
  R_SplitEntityOnNode(cl.worldmodel.nodes[0]);

  ent.topnode = rState.r_pefragtopnode;
}

/*
================
R_StoreEfrags

// FIXME: a lot of this goes away with edge-based
================
*/
export function R_StoreEfrags(leafEfrags: EfragT | null): void {
  let pefrag = leafEfrags;

  while (pefrag !== null) {
    const pent = pefrag.entity;
    if (pent === null) Sys_Error("R_StoreEfrags: efrag has no entity");
    const clmodel = pent.model;
    if (clmodel === null) Sys_Error("R_StoreEfrags: entity has no model");

    switch (clmodel.type) {
      case ModtypeT.mod_alias:
      case ModtypeT.mod_brush:
      case ModtypeT.mod_sprite:
        if (pent.visframe !== rState.r_framecount && clState.cl_numvisedicts < MAX_VISEDICTS) {
          // QW's cl_visedicts points into `entity_t cl_visedicts_list[2][]`
          // (QW/client/client.h:366-367), declared by value, so QW's
          // r_efrag.c:261 copies the whole struct here; WinQuake's
          // cl_visedicts is an array of pointers and its r_efrag.c:261 stores
          // one. Under qw.active the slot already aliases
          // cl_visedicts_list[visState.list][n], which CL_EmitEntities
          // republishes every frame, so copying into it is the C's `= *pent`
          // and leaves no stale packet-entity data behind it.
          const slot = cl_visedicts[clState.cl_numvisedicts];
          if (qw.active && slot !== null) slot.copyFrom(pent);
          else cl_visedicts[clState.cl_numvisedicts] = pent;
          clState.cl_numvisedicts++;

          // mark that we've recorded this entity for this frame
          pent.visframe = rState.r_framecount;
        }

        pefrag = pefrag.leafnext;
        break;

      default:
        Sys_Error("R_StoreEfrags: Bad entity type %d", clmodel.type);
    }
  }
}
