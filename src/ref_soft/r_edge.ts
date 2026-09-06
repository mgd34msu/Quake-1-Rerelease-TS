/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_edge.c (GNU GPL v2 or later).

r_edge.c -- the active edge list and the span sorter: R_ScanEdges walks the
screen a scanline at a time, keeping `edge_head`'s list sorted on `u`, and
R_GenerateSpans / R_GenerateSpansBackward turn each crossing into a span on
the surface that is on top there.

OWNERSHIP -- r_edge.c defines these; r_shared.h / r_local.h declare them and
this port already holds them, so they are written here rather than
redeclared:
  auxedges, r_edges, edge_p, edge_max, surfaces, surface_p, surf_max,
  span_p, max_span_p, r_currentkey                      ... rState
  newedges, removeedges, edge_head, edge_tail, edge_aftertail
                                                        ... r_local.ts
`current_iv`, `edge_head_u_shift20`, `edge_tail_u_shift20`, `fv`,
`pdrawfunc` and `edge_sentinel` are r_edge.c file globals that no other
non-asm .c reads (quakeasm.h externs the first three for the x86 code only),
so they are module-private here.

Deviations from PORTING.md / the C source:
- `espan_t *span_p, *max_span_p` and R_ScanEdges's stack-local `basespans`
  byte array become one module-level `EspanT[]` pool (`allocSpans(MAXSPANS)`,
  built on first use) with `rState.span_p` / `rState.max_span_p` as indexes
  into it; `span = span_p++` is `spanPool[rState.span_p++]`.
- `surf_t *`/`edge_t *` cursors into `surfaces[]`/`r_edges[]` are indexes on
  `rState` (r_shared.ts's ruling); `edge->surfs[]` holds surface INDEXES and
  is resolved through `surfaces[idx]`. The active edge and surface lists stay
  object references, because that is all the C does with them.
- The four-way unrolled `goto edgesearch` / `goto nextedge` loops in
  R_InsertNewEdges and R_StepActiveU are written as plain loops. The unroll
  is a pure micro-optimization: the sequence of comparisons and pointer
  advances is identical.
- `edge->prev` / `surf->next` are nullable in this port (`edge_head.prev` is
  set to NULL by R_ScanEdges), while the C dereferences them unconditionally
  and relies on `edge_head.u` / `edge_tail.u` being the extremes to make that
  safe. `edgePrev`/`edgeNext`/`surfNext`/`surfPrev` below throw instead of
  dereferencing NULL, so a corrupt list is an exception rather than the C's
  undefined behaviour.
- Preserved C quirk: `edge_sentinel.u = 2000 << 24` overflows a 32-bit int to
  a NEGATIVE value (-805306368). Nothing sorts past edge_sentinel anyway,
  because edge_tail.u is the largest value any real edge can reach, so the
  overflow is inert -- JS's `<<` wraps identically, so the value is kept.
- `D_DrawSurfaces` is d_edge.c's (U065), `R_RenderPoly` is r_draw.c's (U064),
  the `r_draworder` cvar is r_main.c's (U062), `S_ExtraUpdate` is
  src/client/snd_dma.ts's, and `VID_LockBuffer`/`VID_UnlockBuffer` go through
  src/client/vid.ts's `vidBackend`.
- Dropped `#if 0` block: the "FIXME / have a sentinal at both ends?" note at
  the top of r_edge.c. Dropped `#if id386` alternates: R_InsertNewEdges,
  R_RemoveEdges, R_StepActiveU, R_LeadingEdge and R_GenerateSpans each have
  an asm version; the `!id386` C bodies are the ones ported.
*/

import { SURF_DRAWBACKGROUND, type MsurfaceT } from "../common/model";
import { S_ExtraUpdate } from "../client/snd_dma";
import { vidBackend } from "../client/vid";
import { Sys_Error } from "../platform/sys";
import { cl_entities } from "../client/client";
import {
  EdgeT,
  EspanT,
  MAXSPANS,
  SurfT,
  allocSpans,
  edge_aftertail,
  edge_head,
  edge_tail,
  newedges,
  r_refdef,
  rState,
  removeedges,
} from "./r_local";
import { r_draworder } from "./r_main";
import { R_RenderPoly } from "./r_draw";
import { D_DrawSurfaces } from "./d_edge";

let current_iv = 0;

let edge_head_u_shift20 = 0;
let edge_tail_u_shift20 = 0;

let pdrawfunc: (() => void) | null = null;

// r_local.h declares edge_head/edge_tail/edge_aftertail extern (r_local.ts
// owns them); edge_sentinel is r_edge.c's alone.
const edge_sentinel: EdgeT = new EdgeT();

let fv = 0;

// R_ScanEdges's `basespans` stack array; see this file's header.
let spanPool: EspanT[] | null = null;

function spans(): EspanT[] {
  let pool = spanPool;
  if (pool === null) {
    pool = allocSpans(MAXSPANS);
    spanPool = pool;
  }
  return pool;
}

function activeSurfaces(): SurfT[] {
  const s = rState.surfaces;
  if (s === null) Sys_Error("r_edge: surfaces are not allocated");
  return s;
}

function allocSpan(): EspanT {
  const pool = spans();
  const span = pool[rState.span_p];
  rState.span_p++;
  return span;
}

function edgeNext(e: EdgeT): EdgeT {
  const n = e.next;
  if (n === null) Sys_Error("r_edge: active edge list is not terminated");
  return n;
}

function edgePrev(e: EdgeT): EdgeT {
  const p = e.prev;
  if (p === null) Sys_Error("r_edge: active edge list has no predecessor");
  return p;
}

function surfNext(s: SurfT): SurfT {
  const n = s.next;
  if (n === null) Sys_Error("r_edge: active surface stack is corrupt");
  return n;
}

function surfPrev(s: SurfT): SurfT {
  const p = s.prev;
  if (p === null) Sys_Error("r_edge: active surface stack is corrupt");
  return p;
}

//=============================================================================

/*
==============
R_DrawCulledPolys
==============
*/
export function R_DrawCulledPolys(): void {
  const surfaces = activeSurfaces();

  rState.currententity = cl_entities[0];

  if (rState.r_worldpolysbacktofront) {
    for (let s = rState.surface_p - 1; s > 1; s--) {
      if (surfaces[s].spans === null) continue;

      if ((surfaces[s].flags & SURF_DRAWBACKGROUND) === 0) {
        const pface: MsurfaceT | null = surfaces[s].data;
        if (pface === null) continue;
        R_RenderPoly(pface, 15);
      }
    }
  } else {
    for (let s = 1; s < rState.surface_p; s++) {
      if (surfaces[s].spans === null) continue;

      if ((surfaces[s].flags & SURF_DRAWBACKGROUND) === 0) {
        const pface: MsurfaceT | null = surfaces[s].data;
        if (pface === null) continue;
        R_RenderPoly(pface, 15);
      }
    }
  }
}

/*
==============
R_BeginEdgeFrame
==============
*/
export function R_BeginEdgeFrame(): void {
  const surfaces = activeSurfaces();

  rState.edge_p = 0;
  rState.edge_max = rState.r_numallocatededges;

  rState.surface_p = 2; // background is surface 1,
  //  surface 0 is a dummy
  surfaces[1].spans = null; // no background spans yet
  surfaces[1].flags = SURF_DRAWBACKGROUND;

  // put the background behind everything in the world
  if (r_draworder.value) {
    pdrawfunc = R_GenerateSpansBackward;
    surfaces[1].key = 0;
    rState.r_currentkey = 1;
  } else {
    pdrawfunc = R_GenerateSpans;
    surfaces[1].key = 0x7fffffff;
    rState.r_currentkey = 0;
  }

  // FIXME: set with memset
  for (let v = r_refdef.vrect.y; v < r_refdef.vrectbottom; v++) {
    newedges[v] = removeedges[v] = null;
  }
}

/*
==============
R_InsertNewEdges

Adds the edges in the linked list edgestoadd, adding them to the edges in the
linked list edgelist.  edgestoadd is assumed to be sorted on u, and non-empty (this is actually newedges[v]).  edgelist is assumed to be sorted on u, with a
sentinel at the end (actually, this is the active edge table starting at
edge_head.next).
==============
*/
export function R_InsertNewEdges(edgestoaddIn: EdgeT, edgelistIn: EdgeT): void {
  let edgestoadd: EdgeT | null = edgestoaddIn;
  let edgelist = edgelistIn;

  do {
    const next_edge: EdgeT | null = edgestoadd.next;

    while (edgelist.u < edgestoadd.u) {
      edgelist = edgeNext(edgelist);
    }

    // insert edgestoadd before edgelist
    edgestoadd.next = edgelist;
    edgestoadd.prev = edgelist.prev;
    edgePrev(edgelist).next = edgestoadd;
    edgelist.prev = edgestoadd;

    edgestoadd = next_edge;
  } while (edgestoadd !== null);
}

/*
==============
R_RemoveEdges
==============
*/
export function R_RemoveEdges(pedgeIn: EdgeT): void {
  let pedge: EdgeT | null = pedgeIn;

  do {
    edgeNext(pedge).prev = pedge.prev;
    edgePrev(pedge).next = pedge.next;
    pedge = pedge.nextremove;
  } while (pedge !== null);
}

/*
==============
R_StepActiveU
==============
*/
export function R_StepActiveU(pedgeIn: EdgeT): void {
  let pedge = pedgeIn;

  for (;;) {
    for (;;) {
      pedge.u += pedge.u_step;
      if (pedge.u < edgePrev(pedge).u) break; // pushback
      pedge = edgeNext(pedge);
    }

    if (pedge === edge_aftertail) return;

    // push it back to keep it sorted
    const pnext_edge = edgeNext(pedge);

    // pull the edge out of the edge list
    edgeNext(pedge).prev = pedge.prev;
    edgePrev(pedge).next = pedge.next;

    // find out where the edge goes in the edge list
    let pwedge = edgePrev(edgePrev(pedge));

    while (pwedge.u > pedge.u) {
      pwedge = edgePrev(pwedge);
    }

    // put the edge back into the edge list
    pedge.next = pwedge.next;
    pedge.prev = pwedge;
    edgeNext(pedge).prev = pedge;
    pwedge.next = pedge;

    pedge = pnext_edge;
    if (pedge === edge_tail) return;
  }
}

/*
==============
R_CleanupSpan
==============
*/
function R_CleanupSpan(): void {
  const surfaces = activeSurfaces();

  // now that we've reached the right edge of the screen, we're done with any
  // unfinished surfaces, so emit a span for whatever's on top
  let surf = surfNext(surfaces[1]);
  const iu = edge_tail_u_shift20;
  if (iu > surf.last_u) {
    const span = allocSpan();
    span.u = surf.last_u;
    span.count = iu - span.u;
    span.v = current_iv;
    span.pnext = surf.spans;
    surf.spans = span;
  }

  // reset spanstate for all surfaces in the surface stack
  do {
    surf.spanstate = 0;
    surf = surfNext(surf);
  } while (surf !== surfaces[1]);
}

/*
==============
R_LeadingEdgeBackwards
==============
*/
function R_LeadingEdgeBackwards(edge: EdgeT): void {
  const surfaces = activeSurfaces();

  // it's adding a new surface in, so find the correct place
  const surf = surfaces[edge.surfs[1]];

  // don't start a span if this is an inverted span, with the end
  // edge preceding the start edge (that is, we've already seen the
  // end edge)
  surf.spanstate++;
  if (surf.spanstate === 1) {
    let surf2 = surfNext(surfaces[1]);

    let newtop = false;

    if (surf.key > surf2.key) {
      newtop = true;
    } else if (surf.insubmodel && surf.key === surf2.key) {
      // if it's two surfaces on the same plane, the one that's already
      // active is in front, so keep going unless it's a bmodel
      // must be two bmodels in the same leaf; don't care, because they'll
      // never be farthest anyway
      newtop = true;
    }

    if (!newtop) {
      // continue_search
      for (;;) {
        do {
          surf2 = surfNext(surf2);
        } while (surf.key < surf2.key);

        if (surf.key === surf2.key) {
          // if it's two surfaces on the same plane, the one that's already
          // active is in front, so keep going unless it's a bmodel
          if (!surf.insubmodel) continue;

          // must be two bmodels in the same leaf; don't care which is really
          // in front, because they'll never be farthest anyway
        }

        break;
      }
    } else {
      // emit a span (obscures current top)
      const iu = edge.u >> 20;

      if (iu > surf2.last_u) {
        const span = allocSpan();
        span.u = surf2.last_u;
        span.count = iu - span.u;
        span.v = current_iv;
        span.pnext = surf2.spans;
        surf2.spans = span;
      }

      // set last_u on the new span
      surf.last_u = iu;
    }

    // insert before surf2
    surf.next = surf2;
    surf.prev = surf2.prev;
    surfPrev(surf2).next = surf;
    surf2.prev = surf;
  }
}

/*
==============
R_TrailingEdge
==============
*/
function R_TrailingEdge(surf: SurfT, edge: EdgeT): void {
  const surfaces = activeSurfaces();

  // don't generate a span if this is an inverted span, with the end
  // edge preceding the start edge (that is, we haven't seen the
  // start edge yet)
  surf.spanstate--;
  if (surf.spanstate === 0) {
    if (surf.insubmodel) rState.r_bmodelactive--;

    if (surf === surfaces[1].next) {
      // emit a span (current top going away)
      const iu = edge.u >> 20;
      if (iu > surf.last_u) {
        const span = allocSpan();
        span.u = surf.last_u;
        span.count = iu - span.u;
        span.v = current_iv;
        span.pnext = surf.spans;
        surf.spans = span;
      }

      // set last_u on the surface below
      surfNext(surf).last_u = iu;
    }

    surfPrev(surf).next = surf.next;
    surfNext(surf).prev = surf.prev;
  }
}

/*
==============
R_LeadingEdge
==============
*/
function R_LeadingEdge(edge: EdgeT): void {
  if (edge.surfs[1]) {
    const surfaces = activeSurfaces();

    // it's adding a new surface in, so find the correct place
    const surf = surfaces[edge.surfs[1]];

    // don't start a span if this is an inverted span, with the end
    // edge preceding the start edge (that is, we've already seen the
    // end edge)
    surf.spanstate++;
    if (surf.spanstate === 1) {
      if (surf.insubmodel) rState.r_bmodelactive++;

      let surf2 = surfNext(surfaces[1]);

      let newtop = false;

      if (surf.key < surf2.key) {
        newtop = true;
      } else if (surf.insubmodel && surf.key === surf2.key) {
        // if it's two surfaces on the same plane, the one that's already
        // active is in front, so keep going unless it's a bmodel
        // must be two bmodels in the same leaf; sort on 1/z
        const fu = (edge.u - 0xfffff) * (1.0 / 0x100000);
        const newzi = surf.d_ziorigin + fv * surf.d_zistepv + fu * surf.d_zistepu;
        const newzibottom = newzi * 0.99;

        const testzi = surf2.d_ziorigin + fv * surf2.d_zistepv + fu * surf2.d_zistepu;

        if (newzibottom >= testzi) {
          newtop = true;
        } else {
          const newzitop = newzi * 1.01;
          if (newzitop >= testzi) {
            if (surf.d_zistepu >= surf2.d_zistepu) {
              newtop = true;
            }
          }
        }
      }

      if (!newtop) {
        // continue_search
        for (;;) {
          do {
            surf2 = surfNext(surf2);
          } while (surf.key > surf2.key);

          if (surf.key === surf2.key) {
            // if it's two surfaces on the same plane, the one that's already
            // active is in front, so keep going unless it's a bmodel
            if (!surf.insubmodel) continue;

            // must be two bmodels in the same leaf; sort on 1/z
            const fu = (edge.u - 0xfffff) * (1.0 / 0x100000);
            const newzi = surf.d_ziorigin + fv * surf.d_zistepv + fu * surf.d_zistepu;
            const newzibottom = newzi * 0.99;

            const testzi = surf2.d_ziorigin + fv * surf2.d_zistepv + fu * surf2.d_zistepu;

            if (newzibottom >= testzi) {
              break; // gotposition
            }

            const newzitop = newzi * 1.01;
            if (newzitop >= testzi) {
              if (surf.d_zistepu >= surf2.d_zistepu) {
                break; // gotposition
              }
            }

            continue;
          }

          break; // gotposition
        }
      } else {
        // emit a span (obscures current top)
        const iu = edge.u >> 20;

        if (iu > surf2.last_u) {
          const span = allocSpan();
          span.u = surf2.last_u;
          span.count = iu - span.u;
          span.v = current_iv;
          span.pnext = surf2.spans;
          surf2.spans = span;
        }

        // set last_u on the new span
        surf.last_u = iu;
      }

      // insert before surf2
      surf.next = surf2;
      surf.prev = surf2.prev;
      surfPrev(surf2).next = surf;
      surf2.prev = surf;
    }
  }
}

/*
==============
R_GenerateSpans
==============
*/
function R_GenerateSpans(): void {
  const surfaces = activeSurfaces();

  rState.r_bmodelactive = 0;

  // clear active surfaces to just the background surface
  surfaces[1].next = surfaces[1].prev = surfaces[1];
  surfaces[1].last_u = edge_head_u_shift20;

  // generate spans
  for (let edge: EdgeT = edgeNext(edge_head); edge !== edge_tail; edge = edgeNext(edge)) {
    if (edge.surfs[0]) {
      // it has a left surface, so a surface is going away for this span
      const surf = surfaces[edge.surfs[0]];

      R_TrailingEdge(surf, edge);

      if (!edge.surfs[1]) continue;
    }

    R_LeadingEdge(edge);
  }

  R_CleanupSpan();
}

/*
==============
R_GenerateSpansBackward
==============
*/
function R_GenerateSpansBackward(): void {
  const surfaces = activeSurfaces();

  rState.r_bmodelactive = 0;

  // clear active surfaces to just the background surface
  surfaces[1].next = surfaces[1].prev = surfaces[1];
  surfaces[1].last_u = edge_head_u_shift20;

  // generate spans
  for (let edge: EdgeT = edgeNext(edge_head); edge !== edge_tail; edge = edgeNext(edge)) {
    if (edge.surfs[0]) R_TrailingEdge(surfaces[edge.surfs[0]], edge);

    if (edge.surfs[1]) R_LeadingEdgeBackwards(edge);
  }

  R_CleanupSpan();
}

/*
==============
R_ScanEdges

Input:
newedges[] array
	this has links to edges, which have links to surfaces

Output:
Each surface has a linked list of its visible spans
==============
*/
export function R_ScanEdges(): void {
  const surfaces = activeSurfaces();

  spans();
  rState.max_span_p = MAXSPANS - r_refdef.vrect.width;
  rState.span_p = 0;

  // clear active edges to just the background edges around the whole screen
  // FIXME: most of this only needs to be set up once
  edge_head.u = r_refdef.vrect.x << 20;
  edge_head_u_shift20 = edge_head.u >> 20;
  edge_head.u_step = 0;
  edge_head.prev = null;
  edge_head.next = edge_tail;
  edge_head.surfs[0] = 0;
  edge_head.surfs[1] = 1;

  edge_tail.u = (r_refdef.vrectright << 20) + 0xfffff;
  edge_tail_u_shift20 = edge_tail.u >> 20;
  edge_tail.u_step = 0;
  edge_tail.prev = edge_head;
  edge_tail.next = edge_aftertail;
  edge_tail.surfs[0] = 1;
  edge_tail.surfs[1] = 0;

  edge_aftertail.u = -1; // force a move
  edge_aftertail.u_step = 0;
  edge_aftertail.next = edge_sentinel;
  edge_aftertail.prev = edge_tail;

  // FIXME: do we need this now that we clamp x in r_draw.c?
  edge_sentinel.u = 2000 << 24; // make sure nothing sorts past this
  edge_sentinel.prev = edge_aftertail;

  //
  // process all scan lines
  //
  const bottom = r_refdef.vrectbottom - 1;

  let iv = r_refdef.vrect.y;
  for (; iv < bottom; iv++) {
    current_iv = iv;
    fv = iv;

    // mark that the head (background start) span is pre-included
    surfaces[1].spanstate = 1;

    const pnew = newedges[iv];
    if (pnew !== null) {
      R_InsertNewEdges(pnew, edgeNext(edge_head));
    }

    const draw = pdrawfunc;
    if (draw === null) Sys_Error("R_ScanEdges: R_BeginEdgeFrame was not called");
    draw();

    // flush the span list if we can't be sure we have enough spans left for
    // the next scan
    if (rState.span_p >= rState.max_span_p) {
      const backend = vidBackend.current;
      if (backend !== null) backend.VID_UnlockBuffer();
      S_ExtraUpdate(); // don't let sound get messed up if going slow
      if (backend !== null) backend.VID_LockBuffer();

      if (rState.r_drawculledpolys) {
        R_DrawCulledPolys();
      } else {
        D_DrawSurfaces();
      }

      // clear the surface span pointers
      for (let s = 1; s < rState.surface_p; s++) surfaces[s].spans = null;

      rState.span_p = 0;
    }

    const premove = removeedges[iv];
    if (premove !== null) R_RemoveEdges(premove);

    if (edge_head.next !== edge_tail) R_StepActiveU(edgeNext(edge_head));
  }

  // do the last scan (no need to step or sort or remove on the last scan)

  current_iv = iv;
  fv = iv;

  // mark that the head (background start) span is pre-included
  surfaces[1].spanstate = 1;

  const pnew = newedges[iv];
  if (pnew !== null) R_InsertNewEdges(pnew, edgeNext(edge_head));

  const lastdraw = pdrawfunc;
  if (lastdraw === null) Sys_Error("R_ScanEdges: R_BeginEdgeFrame was not called");
  lastdraw();

  // draw whatever's left in the span list
  if (rState.r_drawculledpolys) R_DrawCulledPolys();
  else D_DrawSurfaces();
}
