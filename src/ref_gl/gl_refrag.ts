/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_refrag.c (GNU GPL v2 or later).

r_efrag.c: entity fragment (efrag_t) linkage between world leafs and the
entities visible through them -- R_AddEfrags splits an entity's bounding box
down the world BSP and threads one efrag per leaf it touches onto both the
entity's own chain (`entity->efrag`) and that leaf's chain (`leaf->efrags`);
R_StoreEfrags (called per visible leaf by gl_rsurf.c, U073) walks a leaf's
chain to populate `cl_visedicts`.

gl_refrag.c differs from its software twin r_efrag.c in exactly two ways, both
preserved here:
- R_AddEfrags has NO `if (ent == cl_entities) return; // never add the world`
  guard. The GL build really does efrag the world entity if something calls
  R_AddEfrags on it.
- There is no R_SplitEntityOnNode2 at all (r_efrag.c has one, called by
  r_bsp.c's R_StoreEfrags path). Nothing in the GL tree needs it.

Deviations from PORTING.md / the C source:
- `mnode_t *r_pefragtopnode` is a gl_refrag.c file-scope global the C
  REASSIGNS. glquake.ts's `glState` names it in its OWNERSHIP block but carries
  no field for it, so PORTING.md's globals rule gives it the "small exported
  holder" shape here: `refragState`. Its C type is `mnode_t *` but the leaf
  branches store a leaf pointer in it, so it (and `EntityT.topnode`) is typed
  `MnodeT | MleafT | null`, the same ruling src/ref_soft/r_efrag.ts carries.
- `efrag_t **lastlink` is a pointer to the slot the next linked efrag should be
  written into (`&ent->efrag` initially, `&ef->entnext` after each link). This
  port has no pointer-to-a-field, so `lastEfrag` tracks the same progression as
  a plain value: `null` means "the next efrag goes into r_addent.efrag", any
  other value means "the next efrag goes into lastEfrag.entnext" -- `linkEfrag`
  below is the single write site covering both cases, exactly as
  `*lastlink = ef; lastlink = &ef->entnext;` does.
- `R_RemoveEfrags`'s `efrag_t **prev` walk of `leaf->efrags` becomes
  `unlinkEfragFromLeaf`, a plain linked-list splice over
  `leaf.efrags`/`.leafnext` doing the same patch.
- `r_addent`, `lastlink`, `r_emins`, `r_emaxs` are gl_refrag.c file scope, read
  by no other .c file, so they stay module-private here.
- `R_StoreEfrags(efrag_t **ppefrag)` takes a pointer to the caller's cursor slot
  only so it can advance through the list (`ppefrag = &pefrag->leafnext`); it
  never rewrites anything through it. Ported as
  `R_StoreEfrags(leafEfrags: EfragT | null)` taking the list head directly (a
  leaf's `.efrags`) and walking `.leafnext` locally -- same reads, same order,
  no list mutation either way.
*/

import { BOX_ON_PLANE_SIDE, type Vec3, vec3 } from "../common/mathlib";
import { CONTENTS_SOLID } from "../common/bspfile";
import { ModtypeT, type MleafT, type MnodeT, isMleaf } from "../common/model";
import { Con_Printf } from "../client/console";
import { Sys_Error } from "../platform/sys";
import { MAX_VISEDICTS, cl, cl_visedicts, clState } from "../client/client";
import { qw } from "../common/quakedef";
import type { EfragT, EntityT } from "../client/render";
import { glState } from "./glquake";

export const refragState: { r_pefragtopnode: MnodeT | MleafT | null } = { r_pefragtopnode: null };

//===========================================================================

/*
===============================================================================

					ENTITY FRAGMENT FUNCTIONS

===============================================================================
*/

let lastEfrag: EfragT | null = null; // null => next link target is r_addent.efrag

const r_emins: Vec3 = vec3();
const r_emaxs: Vec3 = vec3();

let r_addent: EntityT | null = null;

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
    if (refragState.r_pefragtopnode === null) refragState.r_pefragtopnode = node;

    const leaf = node;

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
    ef.leaf = leaf;
    ef.leafnext = leaf.efrags;
    leaf.efrags = ef;

    return;
  }

  // NODE_MIXED

  const splitplane = node.plane;
  if (splitplane === null) Sys_Error("R_SplitEntityOnNode: bad node");
  const sides = BOX_ON_PLANE_SIDE(r_emins, r_emaxs, splitplane);

  if (sides === 3) {
    // split on this plane
    // if this is the first splitter of this bmodel, remember it
    if (refragState.r_pefragtopnode === null) refragState.r_pefragtopnode = node;
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
===========
R_AddEfrags
===========
*/
export function R_AddEfrags(ent: EntityT): void {
  if (ent.model === null) return;

  r_addent = ent;

  lastEfrag = null;
  refragState.r_pefragtopnode = null;

  const entmodel = ent.model;

  for (let i = 0; i < 3; i++) {
    r_emins[i] = ent.origin[i] + entmodel.mins[i];
    r_emaxs[i] = ent.origin[i] + entmodel.maxs[i];
  }

  if (cl.worldmodel === null || cl.worldmodel.nodes.length === 0) Sys_Error("R_AddEfrags: no worldmodel");
  R_SplitEntityOnNode(cl.worldmodel.nodes[0]);

  ent.topnode = refragState.r_pefragtopnode;
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
        if (pent.visframe !== glState.r_framecount && clState.cl_numvisedicts < MAX_VISEDICTS) {
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
          pent.visframe = glState.r_framecount;
        }

        pefrag = pefrag.leafnext;
        break;

      default:
        Sys_Error("R_StoreEfrags: Bad entity type %d\n", clmodel.type);
    }
  }
}
