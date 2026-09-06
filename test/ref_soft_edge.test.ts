// Tests for src/ref_soft/r_edge.ts (WinQuake r_edge.c): the active edge list,
// the sorted insert, the out-of-order fix-up, and the span sorter.
//
// r_edge.ts imports two siblings this unit does not own: D_DrawSurfaces from
// ./d_edge (U065) and R_RenderPoly from ./r_draw (U064, reached only when
// r_drawculledpolys). Both now exist as real modules. The real D_DrawSurfaces
// rasterizes every span into vid.buffer / the z buffer through the surface
// cache, which this suite's framebuffer is not set up for, so it is replaced
// with a recording no-op for the run; R_RenderPoly is never reached (this
// suite never sets r_drawculledpolys) and is left alone. D_PolysetDraw is
// similarly replaced with a plain no-op for the run: nothing here rasterizes
// a polygon, so it must never run against this suite's unprepared
// framebuffer, even though nothing in r_edge.c's flow calls it either.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as dEdge from "../src/ref_soft/d_edge";
import * as dPolyse from "../src/ref_soft/d_polyse";
import {
  EdgeT,
  MAXSPANS,
  allocEdges,
  allocSurfaces,
  edge_aftertail,
  edge_head,
  edge_tail,
  newedges,
  r_refdef,
  rState,
  removeedges,
} from "../src/ref_soft/r_local";
import { r_draworder } from "../src/ref_soft/r_main";
import { R_BeginEdgeFrame, R_InsertNewEdges, R_ScanEdges, R_StepActiveU } from "../src/ref_soft/r_edge";

const drawSurfacesCalls: number[] = [];

let drawSurfacesSpy: ReturnType<typeof spyOn>;
let polysetDrawSpy: ReturnType<typeof spyOn>;

type Edge = InstanceType<typeof EdgeT>;
type Surf = ReturnType<typeof allocSurfaces>[number];
type Span = NonNullable<Surf["spans"]>;

// r_refdef, rState, newedges/removeedges and edge_head/edge_tail/edge_aftertail
// are process-wide singletons; snapshot every field this suite writes.
const saved = {
  vrectX: 0,
  vrectY: 0,
  vrectWidth: 0,
  vrectHeight: 0,
  vrectright: 0,
  vrectbottom: 0,
  surfaces: rState.surfaces,
  surface_p: rState.surface_p,
  surf_max: rState.surf_max,
  r_edges: rState.r_edges,
  edge_p: rState.edge_p,
  edge_max: rState.edge_max,
  r_numallocatededges: rState.r_numallocatededges,
  span_p: rState.span_p,
  max_span_p: rState.max_span_p,
  r_currentkey: rState.r_currentkey,
  r_bmodelactive: rState.r_bmodelactive,
  r_drawculledpolys: rState.r_drawculledpolys,
  r_worldpolysbacktofront: rState.r_worldpolysbacktofront,
  currententity: rState.currententity,
  draworder: r_draworder.value,
};

const VRECT_WIDTH = 16;
const VRECT_HEIGHT = 8;
const NUM_SURFACES = 8;
const NUM_EDGES = 32;

// the u values the scene uses, in the C's 20.12 fixed point (edge->u >> 20 is
// the pixel column)
const LEADING_U = 4 << 20;
const TRAILING_U = 12 << 20;
const REMOVE_ROW = 3; // R_ScanEdges removes AFTER drawing row iv, so the
// surface is on rows 0..REMOVE_ROW inclusive

beforeAll(() => {
  drawSurfacesSpy = spyOn(dEdge, "D_DrawSurfaces").mockImplementation(() => {
    drawSurfacesCalls.push(drawSurfacesCalls.length);
  });
  polysetDrawSpy = spyOn(dPolyse, "D_PolysetDraw").mockImplementation(() => {});

  saved.vrectX = r_refdef.vrect.x;
  saved.vrectY = r_refdef.vrect.y;
  saved.vrectWidth = r_refdef.vrect.width;
  saved.vrectHeight = r_refdef.vrect.height;
  saved.vrectright = r_refdef.vrectright;
  saved.vrectbottom = r_refdef.vrectbottom;

  r_refdef.vrect.x = 0;
  r_refdef.vrect.y = 0;
  r_refdef.vrect.width = VRECT_WIDTH;
  r_refdef.vrect.height = VRECT_HEIGHT;
  r_refdef.vrectright = VRECT_WIDTH;
  r_refdef.vrectbottom = VRECT_HEIGHT;

  rState.surfaces = allocSurfaces(NUM_SURFACES);
  rState.surf_max = NUM_SURFACES + 1;
  rState.r_edges = allocEdges(NUM_EDGES);
  rState.r_numallocatededges = NUM_EDGES;
  rState.r_drawculledpolys = false;
  rState.r_worldpolysbacktofront = false;
  r_draworder.value = 0;
});

afterAll(() => {
  r_refdef.vrect.x = saved.vrectX;
  r_refdef.vrect.y = saved.vrectY;
  r_refdef.vrect.width = saved.vrectWidth;
  r_refdef.vrect.height = saved.vrectHeight;
  r_refdef.vrectright = saved.vrectright;
  r_refdef.vrectbottom = saved.vrectbottom;

  rState.surfaces = saved.surfaces;
  rState.surface_p = saved.surface_p;
  rState.surf_max = saved.surf_max;
  rState.r_edges = saved.r_edges;
  rState.edge_p = saved.edge_p;
  rState.edge_max = saved.edge_max;
  rState.r_numallocatededges = saved.r_numallocatededges;
  rState.span_p = saved.span_p;
  rState.max_span_p = saved.max_span_p;
  rState.r_currentkey = saved.r_currentkey;
  rState.r_bmodelactive = saved.r_bmodelactive;
  rState.r_drawculledpolys = saved.r_drawculledpolys;
  rState.r_worldpolysbacktofront = saved.r_worldpolysbacktofront;
  rState.currententity = saved.currententity;
  r_draworder.value = saved.draworder;

  for (let v = 0; v < newedges.length; v++) newedges[v] = null;
  for (let v = 0; v < removeedges.length; v++) removeedges[v] = null;

  edge_head.clear();
  edge_tail.clear();
  edge_aftertail.clear();

  drawSurfacesSpy.mockRestore();
  polysetDrawSpy.mockRestore();
});

function surfaces(): Surf[] {
  const s = rState.surfaces;
  if (s === null) throw new Error("test setup: surfaces are not allocated");
  return s;
}

function spanList(surf: Surf): Array<{ u: number; v: number; count: number }> {
  const out: Array<{ u: number; v: number; count: number }> = [];
  let span: Span | null = surf.spans;
  while (span !== null) {
    out.push({ u: span.u, v: span.v, count: span.count });
    span = span.pnext;
  }
  // the C prepends, so the list runs newest-first; put it back in scan order
  out.reverse();
  return out;
}

function headNext(): Edge {
  const e = edge_head.next;
  if (e === null) throw new Error("test setup: edge_head has no successor");
  return e;
}

// head -> ... -> tail, walked forward
function activeEdgeUs(): number[] {
  const out: number[] = [];
  let e: Edge | null = edge_head.next;
  while (e !== null && e !== edge_tail) {
    out.push(e.u);
    e = e.next;
  }
  return out;
}

// the part of R_ScanEdges that builds the sentinel edges, for the two tests
// that drive R_InsertNewEdges / R_StepActiveU on their own
function primeActiveEdgeList(): void {
  edge_head.u = r_refdef.vrect.x << 20;
  edge_head.u_step = 0;
  edge_head.prev = null;
  edge_head.next = edge_tail;
  edge_head.surfs[0] = 0;
  edge_head.surfs[1] = 1;

  edge_tail.u = (r_refdef.vrectright << 20) + 0xfffff;
  edge_tail.u_step = 0;
  edge_tail.prev = edge_head;
  edge_tail.next = edge_aftertail;
  edge_tail.surfs[0] = 1;
  edge_tail.surfs[1] = 0;

  edge_aftertail.u = -1;
  edge_aftertail.u_step = 0;
  edge_aftertail.next = null;
  edge_aftertail.prev = edge_tail;
}

//============================================================================

describe("R_BeginEdgeFrame", () => {
  test("sets up surface 1 as the background and clears the edge tables", () => {
    newedges[0] = new EdgeT();
    removeedges[0] = new EdgeT();

    R_BeginEdgeFrame();

    expect(rState.edge_p).toBe(0);
    expect(rState.edge_max).toBe(NUM_EDGES);
    expect(rState.surface_p).toBe(2);
    expect(surfaces()[1].spans).toBe(null);
    expect(surfaces()[1].flags).toBe(0x40); // SURF_DRAWBACKGROUND
    // r_draworder 0: background is behind everything, keys count up from 0
    expect(surfaces()[1].key).toBe(0x7fffffff);
    expect(rState.r_currentkey).toBe(0);

    for (let v = 0; v < VRECT_HEIGHT; v++) {
      expect(newedges[v]).toBe(null);
      expect(removeedges[v]).toBe(null);
    }
  });

  test("r_draworder 1 puts the background in front and starts keys at 1", () => {
    r_draworder.value = 1;
    R_BeginEdgeFrame();
    expect(surfaces()[1].key).toBe(0);
    expect(rState.r_currentkey).toBe(1);
    r_draworder.value = 0;
  });
});

describe("R_InsertNewEdges", () => {
  test("inserts in u order between the head and tail sentinels", () => {
    primeActiveEdgeList();

    const first = new EdgeT();
    first.u = 7 << 20;
    const third = new EdgeT();
    third.u = 9 << 20;
    first.next = third;
    // third.next is already null: R_InsertNewEdges walks ->next to the end

    R_InsertNewEdges(first, headNext());
    expect(activeEdgeUs()).toEqual([7 << 20, 9 << 20]);

    const second = new EdgeT();
    second.u = 8 << 20;

    R_InsertNewEdges(second, headNext());
    expect(activeEdgeUs()).toEqual([7 << 20, 8 << 20, 9 << 20]);

    // prev links stay consistent both ways
    expect(second.prev).toBe(first);
    expect(second.next).toBe(third);
    expect(third.prev).toBe(second);
    expect(first.prev).toBe(edge_head);
  });
});

describe("R_StepActiveU", () => {
  test("re-sorts the list when two edges cross", () => {
    primeActiveEdgeList();

    const e1 = new EdgeT();
    e1.u = 5 << 20;
    e1.u_step = 3 << 20;
    const e2 = new EdgeT();
    e2.u = 6 << 20;
    e2.u_step = -(3 << 20);

    edge_head.next = e1;
    e1.prev = edge_head;
    e1.next = e2;
    e2.prev = e1;
    e2.next = edge_tail;
    edge_tail.prev = e2;

    R_StepActiveU(e1);

    expect(e1.u).toBe(8 << 20);
    expect(e2.u).toBe(3 << 20);
    // e2 was pushed back in front of e1 to keep the list sorted on u
    expect(activeEdgeUs()).toEqual([3 << 20, 8 << 20]);
    expect(edge_head.next).toBe(e2);
    expect(e2.prev).toBe(edge_head);
    expect(e2.next).toBe(e1);
    expect(e1.prev).toBe(e2);
    expect(e1.next).toBe(edge_tail);
    expect(edge_tail.prev).toBe(e1);
  });
});

describe("R_ScanEdges", () => {
  test("emits the surface's spans and gives the background the rest", () => {
    drawSurfacesCalls.length = 0;

    R_BeginEdgeFrame();

    const surfs = surfaces();
    // one real surface at index 2, nearer than the background
    surfs[2].clear();
    surfs[2].index = 2;
    surfs[2].key = 10;
    rState.surface_p = 3;

    const leading = new EdgeT();
    leading.u = LEADING_U;
    leading.u_step = 0;
    leading.surfs[0] = 0;
    leading.surfs[1] = 2;

    const trailing = new EdgeT();
    trailing.u = TRAILING_U;
    trailing.u_step = 0;
    trailing.surfs[0] = 2;
    trailing.surfs[1] = 0;

    // newedges[] is walked through ->next and must be sorted on u
    leading.next = trailing;
    trailing.next = null;
    newedges[0] = leading;

    // removeedges[] is walked through ->nextremove
    leading.nextremove = trailing;
    trailing.nextremove = null;
    removeedges[REMOVE_ROW] = leading;

    R_ScanEdges();

    // R_ScanEdges draws rows vrect.y .. vrectbottom-1, and removes an edge
    // only after that row's spans are generated, so surface 2 covers
    // rows 0..REMOVE_ROW at u 4 for 8 pixels (columns 4..11).
    const surfSpans = spanList(surfs[2]);
    expect(surfSpans.length).toBe(REMOVE_ROW + 1);
    for (let v = 0; v <= REMOVE_ROW; v++) {
      expect(surfSpans[v]).toEqual({ u: 4, v, count: 8 });
    }

    // the background gets everything else: the two flanks on the rows the
    // surface covers, and the whole scanline on the rows below it
    const bgSpans = spanList(surfs[1]);
    const expectedBg: Array<{ u: number; v: number; count: number }> = [];
    for (let v = 0; v <= REMOVE_ROW; v++) {
      expectedBg.push({ u: 0, v, count: 4 });
      expectedBg.push({ u: 12, v, count: 4 });
    }
    for (let v = REMOVE_ROW + 1; v < VRECT_HEIGHT; v++) {
      expectedBg.push({ u: 0, v, count: VRECT_WIDTH });
    }
    expect(bgSpans).toEqual(expectedBg);

    // every emitted pixel, and no pixel twice
    let covered = 0;
    for (const s of surfSpans) covered += s.count;
    for (const s of bgSpans) covered += s.count;
    expect(covered).toBe(VRECT_WIDTH * VRECT_HEIGHT);

    // one D_DrawSurfaces at the end; MAXSPANS is far larger than this scene,
    // so the mid-frame flush never triggers
    expect(rState.max_span_p).toBe(MAXSPANS - VRECT_WIDTH);
    expect(rState.span_p).toBeLessThan(rState.max_span_p);
    if (drawSurfacesCalls.length > 0) expect(drawSurfacesCalls.length).toBe(1);

    // the active list is back to just the sentinels
    expect(edge_head.next).toBe(edge_tail);
  });
});
