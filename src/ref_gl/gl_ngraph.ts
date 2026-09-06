/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/gl_ngraph.c (GNU GPL v2 or later). This file has no
WinQuake counterpart -- it is entirely new in QuakeWorld, per PORTING.md's
QuakeWorld track ("Wholesale-different and new files"). This unit's brief
places it here (src/ref_gl, new) because it draws the net-timing graph
through the GL renderer's own texture upload path, exactly as the C does.

gl_ngraph.c -- draws a scrolling per-packet latency/lossage graph
(`r_netgraph` cvar) as a small GL texture, built one pixel row at a time from
`cls.qw.netchan`/`packet_latency[]` and blitted with the 2D GL_QUADS path
every other 2D draw in this renderer uses.

Call site: QW's own call site is gl_screen.c:1145's SCR_UpdateScreen (`if
(r_netgraph.value) R_NetGraph();`), a file outside this unit's SCOPE (owned
by the screen.ts unit). R_NetGraph is exported here for that unit to import
and gate on `qw.active && r_netgraph.value`, mirroring gl_rmain.ts's header
note on the same gap. `r_netgraph` itself is declared in gl_rmain.ts and
registered by gl_rmisc.ts's R_Init under qw.active. This module itself has
no internal qw.active branch: every function here is QW-only and only ever
reached through that gated call site.

Cross-unit dependency this file could not verify against a landed export:
- `draw_chars` (the 8x8 console font bitmap `Draw_CharToNetGraph` reads) is
  a module-private `let` in src/ref_gl/gl_draw.ts (out of this unit's SCOPE
  beyond what it already exports). Imported by name; the gl_draw.ts owner
  needs to export it for this import to resolve.
`netgraphtexture`'s allocation (`texture_extension_number++`, one slot) is
wired from gl_rmisc.ts's R_Init (this unit's other file) into
`ngraphState.texture` below, matching gl_rmisc.c:216-218's placement right
after R_InitParticleTexture and before the playertextures reservation.

Deviations from PORTING.md / the C source:
- `netgraphtexture` (a C file-scope `int` gl_rmisc.c's R_Init reassigns) is
  the exported `ngraphState.texture` holder, PORTING.md's "small exported
  holder" shape for a reassigned global living outside its owning .c file's
  storage class.
- `ngraph_texels[NET_GRAPHHEIGHT][NET_TIMINGS]`/`ngraph_pixels[...]` are flat
  Uint8Array(32*256)/Uint32Array(32*256) here, indexed `[y*NET_TIMINGS+x]`
  for the C's `[y][x]`.
*/

import { d_8to24table, vid } from "../client/vid";
import { scrState } from "../client/screen_types";
import { M_DrawTextBox } from "../client/menu";
import { cls } from "../client/client";
import { NET_TIMINGS, NET_TIMINGSMASK } from "../qw/client/client";
import { CL_CalcNet, packet_latency } from "../qw/client/cl_parse";
import { GL_Bind, Draw_String, draw_chars, gl_alpha_format } from "./gl_draw";
import { Sys_Error } from "../platform/sys";
import {
  GL_QUADS,
  GL_RGBA,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_LINEAR,
  GL_MODULATE,
  GL_UNSIGNED_BYTE,
  qgl,
} from "./qgl";

export const NET_GRAPHHEIGHT = 32;

// gl_rmisc.c's R_Init assigns this a fresh texture id (see file header).
export const ngraphState: { texture: number } = { texture: 0 };

const ngraph_texels = new Uint8Array(NET_GRAPHHEIGHT * NET_TIMINGS);

/*
================
R_LineGraph
================
*/
function R_LineGraph(x: number, h: number): void {
  const s = NET_GRAPHHEIGHT;
  let color: number;

  if (h === 10000) color = 0x6f; // yellow
  else if (h === 9999) color = 0x4f; // red
  else if (h === 9998) color = 0xd0; // blue
  else color = 0xfe; // white

  if (h > s) h = s;

  let i = 0;
  for (; i < h; i++) {
    if (i & 1) ngraph_texels[(NET_GRAPHHEIGHT - i - 1) * NET_TIMINGS + x] = 0xff;
    else ngraph_texels[(NET_GRAPHHEIGHT - i - 1) * NET_TIMINGS + x] = color & 0xff;
  }

  for (; i < s; i++) ngraph_texels[(NET_GRAPHHEIGHT - i - 1) * NET_TIMINGS + x] = 0xff;
}

export function Draw_CharToNetGraph(x: number, y: number, num: number): void {
  if (draw_chars === null) Sys_Error("Draw_CharToNetGraph: draw_chars not loaded");
  const chars = draw_chars;
  const row = num >> 4;
  const col = num & 15;
  let sourceOfs = (row << 10) + (col << 3);

  for (let drawline = 8; drawline; drawline--, y++) {
    for (let nx = 0; nx < 8; nx++) {
      const px = chars[sourceOfs + nx];
      if (px !== 255) ngraph_texels[y * NET_TIMINGS + (nx + x)] = 0x60 + px;
    }
    sourceOfs += 128;
  }
}

/*
==============
R_NetGraph
==============
*/
export function R_NetGraph(): void {
  const ngraph_pixels = new Uint32Array(NET_GRAPHHEIGHT * NET_TIMINGS);

  const lost = CL_CalcNet();
  for (let a = 0; a < NET_TIMINGS; a++) {
    const i = (cls.qw.netchan.outgoing_sequence - a) & NET_TIMINGSMASK;
    R_LineGraph(NET_TIMINGS - 1 - a, packet_latency[i]);
  }

  // now load the netgraph texture into gl and draw it
  for (let y = 0; y < NET_GRAPHHEIGHT; y++)
    for (let x = 0; x < NET_TIMINGS; x++) ngraph_pixels[y * NET_TIMINGS + x] = d_8to24table[ngraph_texels[y * NET_TIMINGS + x]];

  let x = -((vid.width - 320) >> 1);
  let y = vid.height - scrState.sb_lines - 24 - NET_GRAPHHEIGHT - 1;

  M_DrawTextBox(x, y, (NET_TIMINGS / 8) | 0, ((NET_GRAPHHEIGHT / 8) | 0) + 1);
  y += 8;

  Draw_String(8, y, `${lost}% packet loss`);
  y += 8;

  GL_Bind(ngraphState.texture);

  qgl().qglTexImage2D(GL_TEXTURE_2D, 0, gl_alpha_format, NET_TIMINGS, NET_GRAPHHEIGHT, 0, GL_RGBA, GL_UNSIGNED_BYTE, ngraph_pixels);

  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

  x = 8;
  qgl().qglColor3f(1, 1, 1);
  qgl().qglBegin(GL_QUADS);
  qgl().qglTexCoord2f(0, 0);
  qgl().qglVertex2f(x, y);
  qgl().qglTexCoord2f(1, 0);
  qgl().qglVertex2f(x + NET_TIMINGS, y);
  qgl().qglTexCoord2f(1, 1);
  qgl().qglVertex2f(x + NET_TIMINGS, y + NET_GRAPHHEIGHT);
  qgl().qglTexCoord2f(0, 1);
  qgl().qglVertex2f(x, y + NET_GRAPHHEIGHT);
  qgl().qglEnd();
}
