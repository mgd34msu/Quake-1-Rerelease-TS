/*
Regression suite for the QuakeWorld visedict aliasing defect found by the
pointer-semantics audit (.orch/audit_aliasing.md, pattern C).

WinQuake/client.h:308 declares `entity_t *cl_visedicts[MAX_VISEDICTS]` -- an
array of POINTERS -- so WinQuake/r_efrag.c:261's
`cl_visedicts[cl_numvisedicts++] = pent;` stores a pointer.

QW/client/client.h:366-367 declares `entity_t *cl_visedicts` aiming into
`entity_t cl_visedicts_list[2][MAX_VISEDICTS]` -- an array BY VALUE -- so
QW/client/r_efrag.c:261's `cl_visedicts[cl_numvisedicts++] = *pent;` copies the
whole struct into the slot.

The port shares one r_efrag/gl_refrag between both tracks, and both stored the
pointer. Under QuakeWorld that left cl_visedicts_list[list][n] holding
two-frame-old packet-entity data in exactly the trailing slots the C fills with
static-entity copies, so CL_LinkPacketEntities' keynum scan over
cl_oldvisedicts could match a stale entry and draw a projectile trail from a
stale origin.

Self-sufficient per rule 13: builds its own EfragT chain and EntityT slots and
resets qw.active, clState.cl_numvisedicts, cl_visedicts, rState.r_framecount and
glState.r_framecount itself.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EntityT, EfragT } from "../src/client/render";
import { cl_visedicts, clState, MAX_VISEDICTS } from "../src/client/client";
import { ModelT, ModtypeT } from "../src/common/model";
import { qw } from "../src/common/quakedef";
import { R_StoreEfrags as R_StoreEfrags_soft } from "../src/ref_soft/r_efrag";
import { R_StoreEfrags as R_StoreEfrags_gl } from "../src/ref_gl/gl_refrag";
import { rState } from "../src/ref_soft/r_local";
import { glState } from "../src/ref_gl/glquake";

const savedQwActive = qw.active;
const savedNumvisedicts = clState.cl_numvisedicts;
const savedSoftFrame = rState.r_framecount;
const savedGlFrame = glState.r_framecount;
const savedSlots: Array<EntityT | null> = [];

beforeEach(() => {
  for (let i = 0; i < MAX_VISEDICTS; i++) savedSlots[i] = cl_visedicts[i];
  clState.cl_numvisedicts = 0;
  rState.r_framecount = 1;
  glState.r_framecount = 1;
});

afterEach(() => {
  qw.active = savedQwActive;
  clState.cl_numvisedicts = savedNumvisedicts;
  rState.r_framecount = savedSoftFrame;
  glState.r_framecount = savedGlFrame;
  for (let i = 0; i < MAX_VISEDICTS; i++) cl_visedicts[i] = savedSlots[i];
});

// A static entity of the kind CL_ParseStatic hands to R_AddEfrags: it carries a
// model and an origin but never gets a keynum.
function makeStatic(originX: number): EntityT {
  const ent = new EntityT();
  const mod = new ModelT();
  mod.type = ModtypeT.mod_alias;
  ent.model = mod;
  ent.origin[0] = originX;
  ent.frame = 3;
  ent.skinnum = 2;
  ent.visframe = 0;
  return ent;
}

function makeChain(ent: EntityT): EfragT {
  const ef = new EfragT();
  ef.entity = ent;
  ef.leafnext = null;
  return ef;
}

// The stale packet entity CL_EmitEntities left in the slot last frame: it has a
// real keynum, which is what makes the leak observable.
function makeStalePacketEntity(): EntityT {
  const slot = new EntityT();
  slot.keynum = 42;
  slot.origin[0] = 999;
  slot.frame = 77;
  return slot;
}

describe("alias_ QW R_StoreEfrags copies the entity into the visedict slot", () => {
  for (const [name, store, setFrame] of [
    ["software", R_StoreEfrags_soft, (n: number) => (rState.r_framecount = n)],
    ["GL", R_StoreEfrags_gl, (n: number) => (glState.r_framecount = n)],
  ] as const) {
    test(`${name}: the slot object is reused and its fields overwritten`, () => {
      qw.active = true;
      setFrame(5);

      const slot = makeStalePacketEntity();
      cl_visedicts[0] = slot;

      const ent = makeStatic(11);
      store(makeChain(ent));

      expect(clState.cl_numvisedicts).toBe(1);
      // The slot keeps its identity -- it is cl_visedicts_list[list][0].
      expect(cl_visedicts[0]).toBe(slot);
      expect(cl_visedicts[0]).not.toBe(ent);
      // and now holds the static entity's values, not the stale packet ones.
      expect(slot.origin[0]).toBe(11);
      expect(slot.frame).toBe(3);
      expect(slot.skinnum).toBe(2);
      // keynum is copied too, so the stale 42 is gone and the C's keynum scan
      // over cl_oldvisedicts can no longer match it.
      expect(slot.keynum).toBe(0);
      // the copy carries the entity's OLD visframe, as the C's `= *pent`
      // before `pent->visframe = r_framecount` does.
      expect(slot.visframe).toBe(0);
      expect(ent.visframe).toBe(5);
    });

    test(`${name}: WinQuake still stores the pointer`, () => {
      qw.active = false;
      setFrame(5);

      const slot = makeStalePacketEntity();
      cl_visedicts[0] = slot;

      const ent = makeStatic(11);
      store(makeChain(ent));

      expect(clState.cl_numvisedicts).toBe(1);
      expect(cl_visedicts[0]).toBe(ent);
      // the previous occupant is untouched
      expect(slot.keynum).toBe(42);
    });

    test(`${name}: an empty QW slot falls back to the pointer store`, () => {
      qw.active = true;
      setFrame(5);
      let idx = 0; // a widened index: the slot starts empty
      cl_visedicts[idx] = null;

      const ent = makeStatic(11);
      store(makeChain(ent));

      idx = 0;
      expect(cl_visedicts[idx]).toBe(ent);
    });
  }
});

describe("alias_ EntityT.copyFrom is a full struct copy", () => {
  test("every field is copied and no array is shared", () => {
    const src = new EntityT();
    src.forcelink = true;
    src.update_type = 2;
    src.baseline.origin[1] = 7;
    src.baseline.modelindex = 9;
    src.baseline.frame = 4;
    src.msgtime = 1.5;
    src.msg_origins[0][0] = 10;
    src.msg_origins[1][2] = 20;
    src.origin[1] = 30;
    src.msg_angles[0][1] = 40;
    src.msg_angles[1][0] = 50;
    src.angles[2] = 60;
    src.frame = 5;
    src.syncbase = 0.25;
    src.effects = 3;
    src.skinnum = 6;
    src.keynum = 8;
    src.visframe = 11;
    src.dlightframe = 12;
    src.dlightbits = 13;
    src.trivial_accept = 14;

    const dst = new EntityT();
    dst.copyFrom(src);

    expect(dst.forcelink).toBe(true);
    expect(dst.update_type).toBe(2);
    expect(dst.baseline.origin[1]).toBe(7);
    expect(dst.baseline.modelindex).toBe(9);
    expect(dst.baseline.frame).toBe(4);
    expect(dst.msgtime).toBe(1.5);
    expect(dst.msg_origins[0][0]).toBe(10);
    expect(dst.msg_origins[1][2]).toBe(20);
    expect(dst.origin[1]).toBe(30);
    expect(dst.msg_angles[0][1]).toBe(40);
    expect(dst.msg_angles[1][0]).toBe(50);
    expect(dst.angles[2]).toBe(60);
    expect(dst.frame).toBe(5);
    expect(dst.syncbase).toBe(0.25);
    expect(dst.effects).toBe(3);
    expect(dst.skinnum).toBe(6);
    expect(dst.keynum).toBe(8);
    expect(dst.visframe).toBe(11);
    expect(dst.dlightframe).toBe(12);
    expect(dst.dlightbits).toBe(13);
    expect(dst.trivial_accept).toBe(14);

    // the vectors are copies, not shared views
    expect(dst.origin).not.toBe(src.origin);
    expect(dst.baseline.origin).not.toBe(src.baseline.origin);
    src.origin[1] = 999;
    src.baseline.origin[1] = 999;
    expect(dst.origin[1]).toBe(30);
    expect(dst.baseline.origin[1]).toBe(7);
  });
});
