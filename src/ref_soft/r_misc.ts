/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/r_misc.c (GNU GPL v2 or later).

r_misc.c -- the software refresh's per-frame setup, the frustum transforms,
and the r_speeds/r_timegraph instrumentation.

Deviations from PORTING.md / the C source:
- `TransformVector (vec3_t in, vec3_t out)`'s first parameter is renamed
  `vin`: `in` is a JavaScript keyword. src/common/mathlib.ts already renames
  the same parameter for `_VectorCopy`.
- `R_TransformPlane (mplane_t *p, float *normal, float *dist)` writes its
  second and third arguments through pointers. `normal` stays an out-param
  (it is a vec3, which this port passes as a Float32Array) but `dist` is a
  single float and is RETURNED instead, since TS has no address-of. No .c file
  in v1.09 calls R_TransformPlane -- only r_local.h declares it -- so no call
  site is affected.
- `R_LineGraph` writes single bytes at `vid.buffer + vid.rowbytes*y + x` and
  walks BACKWARDS by `vid.rowbytes*2` per iteration. `vid.buffer` is a
  `Uint8Array | null` here, so the byte pointer becomes an index into it and
  the function returns early when there is no buffer (a case in which the C
  would have written through a NULL pointer). The two colors it writes are
  0xff and 0x30, as in the C.
- `static` function-scope C variables become module-private `let`s /
  typed arrays with the C's initial values: R_CheckVariables's `oldbright`,
  R_TimeGraph's `timex` and `r_timings[MAX_TIMINGS]`.
- `int startangle = r_refdef.viewangles[1];` in R_TimeRefresh_f is a float
  truncated into an int by the C's declaration, so the port keeps the `| 0`.
  Same for `int a = (r_time2-r_time1)/0.01;` in R_TimeGraph and the two
  `int`-typed screen-x computations there.
- R_SetupFrame's `r_draworder.value = 0;` writes the cvar's numeric field
  without updating its string, exactly as the C does. It is a cheat guard
  (`don't let cheaters look behind walls`), not a Cvar_Set, and is kept
  exactly as the original.
- `VID_Update`/`VID_LockBuffer`/`VID_UnlockBuffer`/`VID_ShiftPalette` are
  members of src/client/vid.ts's `VidBackend`, reached through
  `vidBackend.current?.`, because this port picks the video backend at
  runtime.
- `r_cache_thrash` lives on `dState` (src/ref_soft/d_local.ts), not `rState`:
  d_local.h declares it and d_surf.c defines it.
- `extern float mouse_x, mouse_y;` above R_TimeGraph is dead: the only lines
  that read it are the commented-out debug expressions right below it, which
  are kept as comments. The extern itself is dropped.
- `Show()` is r_misc.c's own debugging helper ("Debugging use") with no caller
  in v1.09. Ported as written.
- `WarpPalette()` likewise has no caller in v1.09 (r_waterwarp goes through
  D_WarpScreen, not a palette shift). Ported as written.
- Dropped `#if !id386` guard around TransformVector: the `!id386` body is the
  one this port takes everywhere (PORTING.md drops the .s files).
- Dropped `#if 0` block: R_SetupFrame's hard-coded debugging vieworg /
  viewangles. Its neighbouring commented-out lines inside R_TimeGraph are
  kept, since they are `//` comments in the C rather than a preprocessor
  branch.

QuakeWorld fold (PORTING.md's "QuakeWorld track", `qw.active`; see
../qsrc/quake/QW/client/r_misc.c against WinQuake/r_misc.c):
- `R_CheckVariables`'s whole body is `#if 0`'d out in QW: under qw.active the
  function is a no-op (no surface-cache flush on an r_fullbright change).
- `R_LineGraph` drops the vrect-relative x/y offset under qw.active (QW's
  R_NetGraph/R_ZGraph callers already pass absolute screen coordinates), and
  gains a 4-color sentinel scheme (10000/9999/9998/else) used by the new
  R_NetGraph, replacing the WinQuake two-tone (0xff foreground / 0x30 shadow)
  bar with a single solid color per column.
- `R_TimeGraph` gains `a = graphval;` after the same commented-out debug
  expressions WinQuake has -- `graphval` is a QW file-scope `int`, exported
  here, never assigned by any QW v2.33 client file (dead debug hook, kept
  exactly as the original, always reads 0).
- `R_NetGraph`/`R_ZGraph` are QW-only additions (no WinQuake counterpart in
  this file). Call site and `r_netgraph`/`r_zgraph` cvar registration are in
  r_main.ts's R_Init/R_RenderView_, matching where QW's r_main.c puts them.
  `R_NetGraph` needs `CL_CalcNet()`/`packet_latency[]` from QW's cl_parse.c;
  src/client/cl_parse.ts does not export them yet (checked at fold time) --
  the import below names them directly rather than stubbing a local copy.
  `cls.qw.netchan` is `unknown` (client.ts's own forward-declaration, stale:
  src/qw/net_chan.ts has since landed with a real `NetchanT`); narrowed here
  with `instanceof NetchanT` rather than `as`.
- `R_SetupFrame`'s multiplayer cheat-guard (`cl.maxclients > 1`) writes the
  four cvars' `.value` fields directly under qw.active instead of going
  through `Cvar_Set` (WinQuake's path, kept when the flag is off).
- `R_SetupFrame`'s `if (!sv.active) r_draworder.value = 0` is commented out
  entirely in QW (there is no local `sv` to be active in a QW client) --
  folded so the check only fires when `qw.active` is false.
- `R_SetupFrame`'s dowarp-changed condition drops the `|| lcd_x.value` half
  under qw.active.
- `Sys_FloatTime` -> `Sys_DoubleTime` (R_TimeRefresh_f, R_TimeGraph,
  R_PrintTimes, R_PrintDSpeeds): a QW rename with no TS-observable delta --
  both read "current time in seconds" and this port's `Sys_FloatTime` already
  returns a JS number (float64/double precision), so no second import was
  threaded through (`src/platform/sys.ts` is out of this unit's SCOPE and
  gains nothing from a same-value alias). Kept as `Sys_FloatTime` on both
  branches.
*/

import { Con_Printf } from "../client/console";
import { Cvar_Set } from "../common/cvar";
import { Sys_FloatTime } from "../platform/sys";
import { AngleVectors, DotProduct, MplaneT, type Vec3, VectorCopy, vec3 } from "../common/mathlib";
import { Mod_PointInLeaf } from "../common/model";
import { CONTENTS_WATER } from "../common/bspfile";
import { cl, cls } from "../client/client";
import { sv } from "../server/server";
import { hostBasepal } from "../common/host";
import { vid, vidBackend, VrectT } from "../client/vid";
import { scrState } from "../client/screen_types";
import { lcd_x } from "../client/view";
import { qw } from "../common/quakedef";
import { NetchanT } from "../qw/net_chan";
// QW cl_parse.c: CL_CalcNet/packet_latency (R_NetGraph's packet-loss source).
// cl_parse.c is one of the wholesale-different QW client files (client-side
// prediction/download logic with no WinQuake counterpart worth folding), so
// it lives at src/qw/client/cl_parse.ts, not folded into src/client/cl_parse.ts.
import { CL_CalcNet, packet_latency } from "../qw/client/cl_parse";
import { M_DrawTextBox } from "../client/menu";
import { Draw_String } from "./draw";
import {
  base_modelorg,
  base_vpn,
  base_vright,
  base_vup,
  modelorg,
  pfrustum_indexes,
  r_frustum_indexes,
  r_origin,
  r_refdef,
  rState,
  screenedge,
  view_clipplanes,
  vpn,
  vright,
  vup,
} from "./r_local";
import { dState } from "./d_local";
import {
  R_ViewChanged,
  r_ambient,
  r_draworder,
  r_drawflat,
  r_fullbright,
  r_graphheight,
  r_numedges,
  r_numsurfs,
  r_waterwarp,
  R_RenderView,
} from "./r_main";
// siblings, each imported by its C name from the module its .c file maps to
import { D_SetupFrame } from "./d_init";
import { D_FlushCaches } from "./d_surf";
import { R_AnimateLight } from "./r_light";
import { R_SetSkyFrame } from "./r_sky";

export const NET_TIMINGS = 256;
export const NET_TIMINGSMASK = 255;

/*
===============
R_CheckVariables
===============
*/
let oldbright = 0; // static float oldbright

export function R_CheckVariables(): void {
  // QW r_misc.c: R_CheckVariables's whole body is #if 0'd out -- QW never
  // flushes the surface cache on an r_fullbright change.
  if (qw.active) return;
  if (r_fullbright.value !== oldbright) {
    oldbright = r_fullbright.value;
    D_FlushCaches(); // so all lighting changes
  }
}

/*
============
Show

Debugging use
============
*/
export function Show(): void {
  const vr = new VrectT();

  vr.x = vr.y = 0;
  vr.width = vid.width;
  vr.height = vid.height;
  vr.pnext = null;
  vidBackend.current?.VID_Update(vr);
}

/*
====================
R_TimeRefresh_f

For program optimization
====================
*/
export function R_TimeRefresh_f(): void {
  let i: number;
  let start: number;
  let stop: number;
  let time: number;
  let startangle: number;
  const vr = new VrectT();

  startangle = r_refdef.viewangles[1] | 0;

  start = Sys_FloatTime();
  for (i = 0; i < 128; i++) {
    r_refdef.viewangles[1] = (i / 128.0) * 360.0;

    vidBackend.current?.VID_LockBuffer();

    R_RenderView();

    vidBackend.current?.VID_UnlockBuffer();

    vr.x = r_refdef.vrect.x;
    vr.y = r_refdef.vrect.y;
    vr.width = r_refdef.vrect.width;
    vr.height = r_refdef.vrect.height;
    vr.pnext = null;
    vidBackend.current?.VID_Update(vr);
  }
  stop = Sys_FloatTime();
  time = stop - start;
  Con_Printf("%f seconds (%f fps)\n", time, 128 / time);

  r_refdef.viewangles[1] = startangle;
}

/*
================
R_LineGraph

Only called by R_DisplayTime
================
*/
export function R_LineGraph(x: number, y: number, h: number): void {
  let i: number;
  let dest: number;
  let s: number;
  let color: number;

  // FIXME: should be disabled on no-buffer adapters, or should be in the driver

  const buffer = vid.buffer;
  if (!buffer) return;

  // QW r_misc.c: the vrect offset is commented out (netgraph/zgraph pass
  // already-absolute screen coordinates); WinQuake's R_TimeGraph still wants
  // the vrect-relative offset.
  if (!qw.active) {
    x += r_refdef.vrect.x;
    y += r_refdef.vrect.y;
  }

  dest = vid.rowbytes * y + x;

  s = r_graphheight.value | 0;

  // QW r_misc.c: R_NetGraph/R_ZGraph pass special sentinel heights (dropped
  // packet, choked packet, invalid delta) that pick a fixed color instead of
  // drawing the WinQuake two-tone (0xff/0x30) bar.
  if (qw.active) {
    if (h === 10000) color = 0x6f; // yellow
    else if (h === 9999) color = 0x4f; // red
    else if (h === 9998) color = 0xd0; // blue
    else color = 0xff; // pink
  } else {
    color = 0xff;
  }

  if (h > s) h = s;

  if (qw.active) {
    for (i = 0; i < h; i++, dest -= vid.rowbytes * 2) {
      buffer[dest] = color;
    }
    for (; i < s; i++, dest -= vid.rowbytes * 2) {
      buffer[dest] = color;
    }
  } else {
    for (i = 0; i < h; i++, dest -= vid.rowbytes * 2) {
      buffer[dest] = 0xff;
      buffer[dest - vid.rowbytes] = 0x30;
    }
    for (; i < s; i++, dest -= vid.rowbytes * 2) {
      buffer[dest] = 0x30;
      buffer[dest - vid.rowbytes] = 0x30;
    }
  }
}

/*
==============
R_NetGraph

QW r_misc.c (new). Software counterpart of gl_ngraph.c's R_NetGraph: draws
packet_latency[] as a strip of R_LineGraph bars plus a packet-loss percentage,
above the status bar.
==============
*/
export function R_NetGraph(): void {
  let a: number;
  let x: number;
  let y: number;
  let y2: number;
  let w: number;
  let i: number;

  if (vid.width - 16 <= NET_TIMINGS) w = vid.width - 16;
  else w = NET_TIMINGS;

  x = -((vid.width - 320) >> 1);
  y = vid.height - scrState.sb_lines - 24 - (r_graphheight.value | 0) * 2 - 2;

  M_DrawTextBox(x, y, ((w + 7) / 8) | 0, (((r_graphheight.value | 0) * 2 + 7) / 8 + 1) | 0);
  y2 = y + 8;
  y = vid.height - scrState.sb_lines - 8 - 2;

  x = 8;
  const lost = CL_CalcNet();
  const netchan = cls.qw.netchan;
  const outgoing_sequence = netchan instanceof NetchanT ? netchan.outgoing_sequence : 0;
  for (a = NET_TIMINGS - w; a < w; a++) {
    i = (outgoing_sequence - a) & NET_TIMINGSMASK;
    R_LineGraph(x + w - 1 - a, y, packet_latency[i]);
  }
  Draw_String(8, y2, `${lost}% packet loss`);
}

/*
==============
R_ZGraph

QW r_misc.c (new). Plots r_origin[2] (view Z) history as a graph, one sample
per rendered frame.
==============
*/
const zgraphHeight = new Int32Array(256); // static int height[256]

export function R_ZGraph(): void {
  let a: number;
  let x: number;
  let w: number;
  let i: number;

  if (r_refdef.vrect.width <= 256) w = r_refdef.vrect.width;
  else w = 256;

  zgraphHeight[rState.r_framecount & 255] = (r_origin[2] | 0) & 31;

  x = 0;
  for (a = 0; a < w; a++) {
    i = (rState.r_framecount - a) & 255;
    R_LineGraph(x + w - 1 - a, r_refdef.vrect.height - 2, zgraphHeight[i]);
  }
}

/*
==============
R_TimeGraph

Performance monitoring tool
==============
*/
const MAX_TIMINGS = 100;

let timex = 0; // static int timex
const r_timings = new Uint8Array(MAX_TIMINGS); // static byte r_timings[MAX_TIMINGS]
// QW r_misc.c: `int graphval;`, file-scope, never assigned anywhere in QW
// v2.33's client tree -- dead debug hook (a = graphval; always reads 0), kept
// exactly as the original since PORTING.md doesn't let a worker "improve" a C oddity.
export let graphval = 0;

export function R_TimeGraph(): void {
  let a: number;
  let r_time2: number;
  let x: number;

  r_time2 = Sys_FloatTime();

  a = ((r_time2 - rState.r_time1) / 0.01) | 0;
  //a = fabs(mouse_y * 0.05);
  //a = (int)((r_refdef.vieworg[2] + 1024)/1)%(int)r_graphheight.value;
  //a = fabs(velocity[0])/20;
  //a = ((int)fabs(origin[0])/8)%20;
  //a = (cl.idealpitch + 30)/5;
  // QW r_misc.c adds `a = graphval;` after the same commented-out debug
  // expressions WinQuake has, unconditionally overwriting the elapsed-time
  // sample above.
  if (qw.active) a = graphval;
  r_timings[timex] = a;
  a = timex;

  if (r_refdef.vrect.width <= MAX_TIMINGS) x = r_refdef.vrect.width - 1;
  else x = r_refdef.vrect.width - (((r_refdef.vrect.width - MAX_TIMINGS) / 2) | 0);
  do {
    R_LineGraph(x, r_refdef.vrect.height - 2, r_timings[a]);
    if (x === 0) break; // screen too small to hold entire thing
    x--;
    a--;
    if (a === -1) a = MAX_TIMINGS - 1;
  } while (a !== timex);

  timex = (timex + 1) % MAX_TIMINGS;
}

/*
=============
R_PrintTimes
=============
*/
export function R_PrintTimes(): void {
  let r_time2: number;
  let ms: number;

  r_time2 = Sys_FloatTime();

  ms = 1000 * (r_time2 - rState.r_time1);

  Con_Printf("%5.1f ms %3i/%3i/%3i poly %3i surf\n", ms, rState.c_faceclip, rState.r_polycount, rState.r_drawnpolycount, rState.c_surf);
  rState.c_surf = 0;
}

/*
=============
R_PrintDSpeeds
=============
*/
export function R_PrintDSpeeds(): void {
  let ms: number;
  let dp_time: number;
  let r_time2: number;
  let rw_time: number;
  let db_time: number;
  let se_time: number;
  let de_time: number;
  let dv_time: number;

  r_time2 = Sys_FloatTime();

  dp_time = (rState.dp_time2 - rState.dp_time1) * 1000;
  rw_time = (rState.rw_time2 - rState.rw_time1) * 1000;
  db_time = (rState.db_time2 - rState.db_time1) * 1000;
  se_time = (rState.se_time2 - rState.se_time1) * 1000;
  de_time = (rState.de_time2 - rState.de_time1) * 1000;
  dv_time = (rState.dv_time2 - rState.dv_time1) * 1000;
  ms = (r_time2 - rState.r_time1) * 1000;

  Con_Printf("%3i %4.1fp %3iw %4.1fb %3is %4.1fe %4.1fv\n", ms | 0, dp_time, rw_time | 0, db_time, se_time | 0, de_time, dv_time);
}

/*
=============
R_PrintAliasStats
=============
*/
export function R_PrintAliasStats(): void {
  Con_Printf("%3i polygon model drawn\n", rState.r_amodels_drawn);
}

export function WarpPalette(): void {
  let i: number;
  let j: number;
  const newpalette = new Uint8Array(768);
  const basecolor = new Int32Array(3);

  basecolor[0] = 130;
  basecolor[1] = 80;
  basecolor[2] = 50;

  const basepal = hostBasepal();
  if (!basepal) return;

  // pull the colors halfway to bright brown
  for (i = 0; i < 256; i++) {
    for (j = 0; j < 3; j++) {
      newpalette[i * 3 + j] = ((basepal[i * 3 + j] + basecolor[j]) / 2) | 0;
    }
  }

  vidBackend.current?.VID_ShiftPalette(newpalette);
}

/*
===================
R_TransformFrustum
===================
*/
export function R_TransformFrustum(): void {
  let i: number;
  const v: Vec3 = vec3();
  const v2: Vec3 = vec3();

  for (i = 0; i < 4; i++) {
    v[0] = screenedge[i].normal[2];
    v[1] = -screenedge[i].normal[0];
    v[2] = screenedge[i].normal[1];

    v2[0] = v[1] * vright[0] + v[2] * vup[0] + v[0] * vpn[0];
    v2[1] = v[1] * vright[1] + v[2] * vup[1] + v[0] * vpn[1];
    v2[2] = v[1] * vright[2] + v[2] * vup[2] + v[0] * vpn[2];

    VectorCopy(v2, view_clipplanes[i].normal);

    view_clipplanes[i].dist = DotProduct(modelorg, v2);
  }
}

/*
================
TransformVector
================
*/
export function TransformVector(vin: Vec3, out: Vec3): void {
  out[0] = DotProduct(vin, vright);
  out[1] = DotProduct(vin, vup);
  out[2] = DotProduct(vin, vpn);
}

/*
================
R_TransformPlane
================
*/
export function R_TransformPlane(p: MplaneT, normal: Vec3): number {
  let d: number;

  d = DotProduct(r_origin, p.normal);
  const dist = p.dist - d;
  // TODO: when we have rotating entities, this will need to use the view matrix
  TransformVector(p.normal, normal);

  return dist;
}

/*
===============
R_SetUpFrustumIndexes
===============
*/
export function R_SetUpFrustumIndexes(): void {
  let i: number;
  let j: number;
  let pindex: number;

  pindex = 0;

  for (i = 0; i < 4; i++) {
    for (j = 0; j < 3; j++) {
      if (view_clipplanes[i].normal[j] < 0) {
        r_frustum_indexes[pindex + j] = j;
        r_frustum_indexes[pindex + j + 3] = j + 3;
      } else {
        r_frustum_indexes[pindex + j] = j + 3;
        r_frustum_indexes[pindex + j + 3] = j;
      }
    }

    // FIXME: do just once at start
    pfrustum_indexes[i] = r_frustum_indexes.subarray(pindex, pindex + 6);
    pindex += 6;
  }
}

/*
===============
R_SetupFrame
===============
*/
export function R_SetupFrame(): void {
  let edgecount: number;
  const vrect = new VrectT();
  let w: number;
  let h: number;

  // don't allow cheats in multiplayer
  if (cl.maxclients > 1) {
    // QW r_misc.c writes the cvars' numeric fields directly, bypassing
    // Cvar_Set (and whatever userinfo-propagation side effect Cvar_Set
    // carries under qw.active -- see src/common/cvar.ts's qw fold).
    if (qw.active) {
      r_draworder.value = 0;
      r_fullbright.value = 0;
      r_ambient.value = 0;
      r_drawflat.value = 0;
    } else {
      Cvar_Set("r_draworder", "0");
      Cvar_Set("r_fullbright", "0");
      Cvar_Set("r_ambient", "0");
      Cvar_Set("r_drawflat", "0");
    }
  }

  if (r_numsurfs.value) {
    if (rState.surface_p > rState.r_maxsurfsseen) rState.r_maxsurfsseen = rState.surface_p;

    Con_Printf("Used %d of %d surfs; %d max\n", rState.surface_p, rState.surf_max, rState.r_maxsurfsseen);
  }

  if (r_numedges.value) {
    edgecount = rState.edge_p;

    if (edgecount > rState.r_maxedgesseen) rState.r_maxedgesseen = edgecount;

    Con_Printf("Used %d of %d edges; %d max\n", edgecount, rState.r_numallocatededges, rState.r_maxedgesseen);
  }

  r_refdef.ambientlight = r_ambient.value;

  if (r_refdef.ambientlight < 0) r_refdef.ambientlight = 0;

  // QW r_misc.c: this whole check is commented out -- qwcl never zeroes
  // r_draworder here (there is no local sv to be active in a QW client).
  if (!qw.active && !sv.active) r_draworder.value = 0; // don't let cheaters look behind walls

  R_CheckVariables();

  R_AnimateLight();

  rState.r_framecount++;

  rState.numbtofpolys = 0;

  // build the transformation matrix for the given view angles
  VectorCopy(r_refdef.vieworg, modelorg);
  VectorCopy(r_refdef.vieworg, r_origin);

  AngleVectors(r_refdef.viewangles, vpn, vright, vup);

  // current viewleaf
  rState.r_oldviewleaf = rState.r_viewleaf;
  rState.r_viewleaf = Mod_PointInLeaf(r_origin, cl.worldmodel);

  rState.r_dowarpold = rState.r_dowarp;
  rState.r_dowarp = r_waterwarp.value !== 0 && rState.r_viewleaf.contents <= CONTENTS_WATER;

  // QW r_misc.c drops the `|| lcd_x.value` disjunct entirely.
  if (rState.r_dowarp !== rState.r_dowarpold || rState.r_viewchanged || (!qw.active && lcd_x.value)) {
    if (rState.r_dowarp) {
      if (vid.width <= vid.maxwarpwidth && vid.height <= vid.maxwarpheight) {
        vrect.x = 0;
        vrect.y = 0;
        vrect.width = vid.width;
        vrect.height = vid.height;

        R_ViewChanged(vrect, scrState.sb_lines, vid.aspect);
      } else {
        w = vid.width;
        h = vid.height;

        if (w > vid.maxwarpwidth) {
          h *= vid.maxwarpwidth / w;
          w = vid.maxwarpwidth;
        }

        if (h > vid.maxwarpheight) {
          h = vid.maxwarpheight;
          w *= vid.maxwarpheight / h;
        }

        vrect.x = 0;
        vrect.y = 0;
        vrect.width = w | 0;
        vrect.height = h | 0;

        R_ViewChanged(vrect, (scrState.sb_lines * (h / vid.height)) | 0, vid.aspect * (h / w) * (vid.width / vid.height));
      }
    } else {
      vrect.x = 0;
      vrect.y = 0;
      vrect.width = vid.width;
      vrect.height = vid.height;

      R_ViewChanged(vrect, scrState.sb_lines, vid.aspect);
    }

    rState.r_viewchanged = false;
  }

  // start off with just the four screen edge clip planes
  R_TransformFrustum();

  // save base values
  VectorCopy(vpn, base_vpn);
  VectorCopy(vright, base_vright);
  VectorCopy(vup, base_vup);
  VectorCopy(modelorg, base_modelorg);

  R_SetSkyFrame();

  R_SetUpFrustumIndexes();

  dState.r_cache_thrash = false;

  // clear frame counts
  rState.c_faceclip = 0;
  rState.d_spanpixcount = 0;
  rState.r_polycount = 0;
  rState.r_drawnpolycount = 0;
  rState.r_wholepolycount = 0;
  rState.r_amodels_drawn = 0;
  rState.r_outofsurfaces = 0;
  rState.r_outofedges = 0;

  D_SetupFrame();
}
