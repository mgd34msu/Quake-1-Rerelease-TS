/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/screen.c, QW/client/gl_screen.c and QW/client/screen.h
(GNU GPL v2 or later).

screen.c -- master for refresh, status bar, console, chat, notify, etc

Ruling (Q023b): `diff -w WinQuake/screen.c QW/client/screen.c` is 423 changed
lines of WinQuake's 991 (~43%); `diff -w WinQuake/gl_screen.c QW/client/gl_screen.c`
is 375 of 923 (~41%); combined, 798 of 1914 (~42%), over the ~40% fold
threshold, and the changes are not additive (SCR_RSShot_f, MipColor,
SCR_DrawCharToSnap/SCR_DrawStringToSnap are wholly new; SCR_UpdateScreen drops
the entire loading-plaque scaffolding; SCR_SetUpToDrawConsole's guard is a
different condition entirely). So this is a wholesale module, mirroring
src/client/screen.ts's own idioms (renderer seam via getRenderer(), a
scrState/scr_vrect shared-state module, module-private file-scope statics)
rather than folding into it.

Like the landed WinQuake module, this one file ports both screen.c and
gl_screen.c: the software body is the baseline (screen.c has no
`Cmd_AddCommand`/behavior gl_screen.c lacks other than the seam-crossed
pieces), and every renderer difference goes through src/client/render.ts's
existing `Renderer` interface -- no new seam methods were added (render.ts is
out of this unit's SCOPE). The exact mapping, matching src/client/screen.ts's
own header table:
  * SCR_CalcRefdef, BeginFrame/EndFrame, D_Enable/DisableBackBufferAccess,
    GL_Set2D, SCR_TileClear, SCR_DrawCrosshair, D_UpdateRects -> called
    exactly where the landed WinQuake screen.ts calls them; their renderer
    bodies (ref_soft/ref_gl, Q024's scope) are unmodified by this unit.
  * SCR_ScreenShot_f forwards to `Renderer.SCR_ScreenShot_f()`, exactly as
    the landed WinQuake screen.ts does. screen.c and gl_screen.c each define
    the command -- a PCX of `vid.buffer` in a software build, a TGA of
    `glReadPixels` in a GLQUAKE one -- and QW's gl_screen.c body is
    byte-identical to WinQuake's while QW's screen.c body differs from
    WinQuake's only in the "Couldn't create a PCX" text, so both live behind
    the seam already (src/ref_soft/ref_soft.ts, src/ref_gl/ref_gl.ts). A
    second software-only copy here wrote an all-black PCX under
    `-vid_ref gl`, since this port allocates `vid.buffer` for both renderers.
  * SCR_RSShot_f (the `snap` command, QW-only) is NOT on the seam: its body
    needs CL_StartUpload and cls/name, client state no renderer module owns,
    and its GL twin's `glReadPixels` capture would need a new render.ts
    method. screen.c's software body is ported here, with
    WritePCXfile/MipColor/SCR_DrawCharToSnap/SCR_DrawStringToSnap as this
    module's own private helpers and
    `getRenderer().D_EnableBackBufferAccess()`/`D_DisableBackBufferAccess()`
    exactly where the C calls them. Under a GL renderer `vid.buffer` holds no
    rendered pixels, so `snap` captures a black frame there; reported as a
    render.ts gap (a pixel-readback method), the same shape as the WinQuake
    module's own "Four Draw_TileClear sites... reported as a render.ts gap"
    note.
  * `ctime()`'s exact glibc format ("Www Mmm dd hh:mm:ss yyyy") is
    approximated by a small local formatter (day/month names, zero-padded
    fields) rather than `Date.prototype.toString()`'s locale/engine-dependent
    shape; this only affects the cosmetic timestamp string
    SCR_DrawStringToSnap burns into the corner of a `snap` screenshot.

Cvars declared in screen.c/gl_screen.c themselves stay here (`scr_conspeed`,
`scr_centertime`, `scr_showram`,
`scr_showturtle`, `scr_showpause`, `scr_printspeed`, `scr_allowsnap` -- new in
QW, default "1", not archived), except `scr_viewsize` and `scr_fov`, which are
one shared object each with WinQuake's screen.ts (see the comment on their
re-export below). `cl_sbar` and `show_fps` are cl_main.c's
(imported from src/qw/client/cl_main.ts, already landed).

Deviations from PORTING.md / the C source:
- `scr_ram`/`scr_net`/`scr_turtle` are loaded with `W_GetQpic("ram")` etc
  (src/common/wad.ts) directly, not through a renderer seam call: QW's own
  SCR_Init calls `W_GetLumpName` directly too (`scr_ram = W_GetLumpName
  ("ram");`, a raw `qpic_t*` cast in the C), where WinQuake's screen.c calls
  `Draw_PicFromWad` (a renderer-owned loader). `W_GetQpic` is this port's own
  "the cast, made explicit" helper (see its doc comment in wad.ts) and never
  returns null (`Sys_Error`s on a missing lump, matching the C), so
  `scr_ram`/`scr_net`/`scr_turtle` are typed `QpicT` here, not `QpicT | null`
  -- one fewer null-guard than the WinQuake module needs for the same three
  pictures. `Draw_Pic` itself (drawing them) still crosses the seam.
- Every `Con_*` name and `conState` come from src/qw/client/console.ts
  (QW/client/console.c's own console), not WinQuake's src/client/console.ts:
  QW's `Con_DrawConsole (int lines)` drops WinQuake's `drawinput` second
  argument and always draws the input line, and `conState` is QW's holder
  shape (no `con_backscroll`; the two fields read here, `con_notifylines` and
  `con_initialized`, exist under the same names).
- `SCR_ModalMessage`'s `cls.state == ca_dedicated` early return (WinQuake
  only) is dropped: QW/client/screen.c's own `SCR_ModalMessage` never checks
  it (qwcl has no dedicated-server mode -- `sv_dedicated`'s branch is
  `QW/qwsv`, an entirely separate binary/tree per PORTING.md).
- `SCR_BeginLoadingPlaque`/`SCR_EndLoadingPlaque`/`SCR_DrawLoading` are NOT
  ported: grepped across every QW/client/*.c and QW/client/*.h, there is no
  definition or call site anywhere in the tree (screen.h itself drops their
  declarations too). `scr_drawloading` survives only as gl_screen.c's own
  dead branch in `SCR_UpdateScreen` (nothing ever sets it true, since the
  function that would -- SCR_BeginLoadingPlaque -- doesn't exist); screen.c's
  (software) `SCR_UpdateScreen`, this module's baseline, drops the branch
  outright, so this module drops it too.
- `SCR_SetUpToDrawConsole`'s full-console guard is `cls.state !== ca_active`
  (compared by name, per PORTING.md's CactiveT-numbering warning), not
  WinQuake's `!cl.worldmodel || cls.signon !== SIGNONS`; `conState.con_forcedup`
  is never written by this module (QW's own client.h/screen.c never reference
  it in this context -- V_RenderView's own qw.active branch, src/client/view.ts,
  likewise gates on `cls.state`, not `con_forcedup`).
- `scr_skipupdate`/`block_drawing` and `scr_disabled_for_loading`'s simple
  early return (no 60-second retry-then-"load failed." timeout: QW's own
  software `SCR_UpdateScreen` has no such retry at all -- gl_screen.c's
  version keeps one, dead code for the reason above) are ported from
  screen.c's own body, the same "software is the baseline" rule as the rest
  of this file.
- `oldlcd_x`/`lcd_x` and the `#ifdef _WIN32 Minimized` guard: dropped. `lcd_x`
  is a dead cvar in QW (src/client/view.ts's own qw.active fold already
  reports this); `Minimized` is a WinQuake-only Win32 concern PORTING.md
  already rules out (`#ifdef _WIN32/__linux__` -> "take the portable,
  non-asm path").
- `r_netgraph`/`R_NetGraph()` (gl_screen.c:1145) is ported at the C's own
  call site, through `Renderer.R_NetGraph` -- an optional seam member,
  because QW's two renderers call R_NetGraph from different places: only
  gl_screen.c calls it from a client file, while r_main.c calls the software
  R_NetGraph (r_misc.c) at the end of R_RenderView, inside the renderer.
  The software renderer therefore leaves the member undefined and this call
  is a no-op there, so the graph is drawn exactly once under either
  renderer. `r_netgraph` itself lives in src/client/render.ts's shared-cvar
  block (both renderers declare it with the same initializer, and no client
  module may import a renderer).
*/

import { Cmd_AddCommand } from "../../common/cmd";
import { COM_WriteFile } from "../../common/common";
import { CvarT, Cvar_RegisterVariable, Cvar_SetValue } from "../../common/cvar";
import { M_PI } from "../../common/mathlib";
import { host } from "../../common/host";
import { MSG_WriteByte, SZ_Print } from "../../common/sizebuf";
import { QpicT, W_GetLumpName, W_GetQpic } from "../../common/wad";
import { Sys_Error, Sys_SendKeyEvents } from "../../platform/sys";
import { CactiveT, cl, cls } from "../../client/client";
import { Con_CheckResize, Con_ClearNotify, Con_DrawConsole, Con_DrawNotify, Con_Printf, conState } from "./console";
import { K_ESCAPE, KeydestT, keyState, key_lastpress } from "../../client/keys";
import { M_Draw } from "./menu"; // QW/client/screen.c:1119 links QW/client/menu.c, not WinQuake's
import { getRenderer, r_netgraph } from "../../client/render";
import { scr_fov, scr_viewsize } from "../../client/screen"; // one object per cvar name -- see the block below
import { scrState, scr_vrect } from "../../client/screen_types";
import { S_ClearBuffer, S_StopAllSounds } from "../../client/snd_dma";
import { V_RenderView, V_UpdatePalette } from "../../client/view";
import { VrectT, vid, vidBackend } from "../../client/vid";
import { ClcOpsT, UPDATE_BACKUP } from "../protocol";
import { cl_sbar, clMainState, host_basepal, name, show_fps } from "./cl_main";
import { CL_IsUploading, CL_StartUpload } from "./cl_parse";
import { Sbar_Changed, Sbar_Draw, Sbar_FinaleOverlay, Sbar_IntermissionOverlay } from "./sbar";
import { PCX_DATA_OFS } from "./client";

let oldscreensize = 0;
let oldfov = 0;
let oldsbar = 0; // QW-only: SCR_UpdateScreen's `oldsbar != cl_sbar.value` recalc trigger

// cvar_t scr_viewsize = {"viewsize","100", true}; / cvar_t scr_fov =
// {"fov","90"}; -- declared with those exact values by BOTH screen.c files
// (WinQuake/screen.c:84-85 and QW/client/screen.c), and the C links only one
// of the two per binary. This port links both modules into every binary, and
// the renderers read WinQuake's objects directly (src/ref_soft/r_main.ts:120,
// src/ref_soft/ref_soft.ts:119, src/ref_gl/ref_gl.ts:147), so a second pair
// here would leave the pair the renderers read unregistered -- `value` stays
// 0 until Cvar_RegisterVariable runs -- and SCR_CalcRefdef would Sys_Error
// with "Bad fov: 0.000000" on the first qwcl frame. One object per name,
// registered by whichever binary's SCR_Init runs.
export { scr_fov, scr_viewsize };
export const scr_conspeed = new CvarT("scr_conspeed", "300");
export const scr_centertime = new CvarT("scr_centertime", "2");
export const scr_showram = new CvarT("showram", "1");
export const scr_showturtle = new CvarT("showturtle", "0");
export const scr_showpause = new CvarT("showpause", "1");
export const scr_printspeed = new CvarT("scr_printspeed", "8");
export const scr_allowsnap = new CvarT("scr_allowsnap", "1"); // QW-only

let scr_initialized = false; // ready to draw

let scr_ram: QpicT = new QpicT();
let scr_net: QpicT = new QpicT();
let scr_turtle: QpicT = new QpicT();

let clearconsole = 0;

let pconupdate: VrectT | null = null;

/*
===============================================================================

CENTER PRINTING

===============================================================================
*/

let scr_centerstring = ""; // char scr_centerstring[1024]
let scr_centertime_start = 0;
let scr_centertime_off = 0;
let scr_center_lines = 0;
let scr_erase_lines = 0;
let scr_erase_center = 0;

function strAt(s: string, i: number): number {
  return i < s.length ? s.charCodeAt(i) : 0;
}

export function SCR_CenterPrint(str: string): void {
  scr_centerstring = str.slice(0, 1023);
  scr_centertime_off = scr_centertime.value;
  scr_centertime_start = cl.time;

  scr_center_lines = 1;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 10) scr_center_lines++;
  }
}

export function SCR_EraseCenterString(): void {
  let y: number;

  if (scr_erase_center++ > vid.numpages) {
    scr_erase_lines = 0;
    return;
  }

  if (scr_center_lines <= 4) y = (vid.height * 0.35) | 0;
  else y = 48;

  scrState.scr_copytop = 1;
  // QW clamps the clear height to the screen bottom; WinQuake's does not.
  getRenderer().SCR_SoftwareTileClear(0, y, vid.width, Math.min(8 * scr_erase_lines, vid.height - y - 1));
}

export function SCR_DrawCenterString(): void {
  let l: number;
  let x: number;
  let y: number;
  let remaining: number;

  if (cl.intermission) remaining = (scr_printspeed.value * (cl.time - scr_centertime_start)) | 0;
  else remaining = 9999;

  scr_erase_center = 0;
  let start = 0;

  if (scr_center_lines <= 4) y = (vid.height * 0.35) | 0;
  else y = 48;

  const re = getRenderer();

  for (;;) {
    for (l = 0; l < 40; l++) {
      const c = strAt(scr_centerstring, start + l);
      if (c === 10 || c === 0) break;
    }
    x = ((vid.width - l * 8) / 2) | 0;
    for (let j = 0; j < l; j++, x += 8) {
      re.Draw_Character(x, y, strAt(scr_centerstring, start + j));
      if (remaining-- === 0) return;
    }

    y += 8;

    while (strAt(scr_centerstring, start) !== 0 && strAt(scr_centerstring, start) !== 10) start++;

    if (strAt(scr_centerstring, start) === 0) break;
    start++;
  }
}

export function SCR_CheckDrawCenterString(): void {
  scrState.scr_copytop = 1;
  if (scr_center_lines > scr_erase_lines) scr_erase_lines = scr_center_lines;

  scr_centertime_off -= host.frametime;

  if (scr_centertime_off <= 0 && !cl.intermission) return;
  if (keyState.key_dest !== KeydestT.key_game) return;

  SCR_DrawCenterString();
}

//=============================================================================

export function CalcFov(fov_x: number, width: number, height: number): number {
  let a: number;
  let x: number;

  if (fov_x < 1 || fov_x > 179) Sys_Error("Bad fov: %f", fov_x);

  x = width / Math.tan((fov_x / 360) * M_PI);
  a = Math.atan(height / x);
  a = (a * 360) / M_PI;

  return a;
}

export function SCR_SizeUp_f(): void {
  // QW guards this (WinQuake does not; it relies on SCR_CalcRefdef's own clamp)
  if (scr_viewsize.value < 120) {
    Cvar_SetValue("viewsize", scr_viewsize.value + 10);
    vid.recalc_refdef = 1;
  }
}

export function SCR_SizeDown_f(): void {
  Cvar_SetValue("viewsize", scr_viewsize.value - 10);
  vid.recalc_refdef = 1;
}

//============================================================================

export function SCR_Init(): void {
  Cvar_RegisterVariable(scr_fov);
  Cvar_RegisterVariable(scr_viewsize);
  Cvar_RegisterVariable(scr_conspeed);
  Cvar_RegisterVariable(scr_showram);
  Cvar_RegisterVariable(scr_showturtle);
  Cvar_RegisterVariable(scr_showpause);
  Cvar_RegisterVariable(scr_centertime);
  Cvar_RegisterVariable(scr_printspeed);
  Cvar_RegisterVariable(scr_allowsnap);

  Cmd_AddCommand("screenshot", SCR_ScreenShot_f);
  Cmd_AddCommand("snap", SCR_RSShot_f);
  Cmd_AddCommand("sizeup", SCR_SizeUp_f);
  Cmd_AddCommand("sizedown", SCR_SizeDown_f);

  scr_ram = W_GetQpic("ram");
  scr_net = W_GetQpic("net");
  scr_turtle = W_GetQpic("turtle");

  scr_initialized = true;
}

export function SCR_DrawRam(): void {
  if (!scr_showram.value) return;

  const re = getRenderer();
  if (!re.r_cache_thrash) return;

  re.Draw_Pic(scr_vrect.x + 32, scr_vrect.y, scr_ram);
}

let drawTurtleCount = 0; // static int count

export function SCR_DrawTurtle(): void {
  if (!scr_showturtle.value) return;

  if (host.frametime < 0.1) {
    drawTurtleCount = 0;
    return;
  }

  drawTurtleCount++;
  if (drawTurtleCount < 3) return;

  getRenderer().Draw_Pic(scr_vrect.x, scr_vrect.y, scr_turtle);
}

export function SCR_DrawNet(): void {
  if (cls.qw.netchan.outgoing_sequence - cls.qw.netchan.incoming_acknowledged < UPDATE_BACKUP - 1) return;
  if (cls.demoplayback) return;

  getRenderer().Draw_Pic(scr_vrect.x + 64, scr_vrect.y, scr_net);
}

let lastframetime = 0; // static double lastframetime
let lastfps = 0; // static int lastfps

export function SCR_DrawFPS(): void {
  if (!show_fps.value) return;

  // `t = Sys_DoubleTime();` -- this port has no separate Sys_DoubleTime;
  // host.realtime is the same monotonic wall clock (src/platform/sys.ts's
  // Sys_FloatTime), read once per frame by Host_Frame.
  const t = host.realtime;
  if (t - lastframetime >= 1.0) {
    lastfps = clMainState.fps_count;
    clMainState.fps_count = 0;
    lastframetime = t;
  }

  const st = `${lastfps}`.padStart(3) + " FPS"; // sprintf("%3d FPS", lastfps)
  const x = vid.width - st.length * 8 - 8;
  const y = vid.height - scrState.sb_lines - 8;
  getRenderer().Draw_String(x, y, st);
}

export function SCR_DrawPause(): void {
  if (!scr_showpause.value) return; // turn off for screenshots
  if (!cl.paused) return;

  const re = getRenderer();
  const pic = re.Draw_CachePic("gfx/pause.lmp");
  if (!pic) return;
  re.Draw_Pic(((vid.width - pic.width) / 2) | 0, ((vid.height - 48 - pic.height) / 2) | 0, pic);
}

//=============================================================================

export function SCR_SetUpToDrawConsole(): void {
  Con_CheckResize();

  // QW's full-console condition is `cls.state !== ca_active`, compared by
  // name (never a literal, per PORTING.md's CactiveT-numbering warning);
  // `conState.con_forcedup` is never written here -- see file header.
  if (cls.state !== CactiveT.ca_active) {
    scrState.scr_conlines = vid.height; // full screen
    scrState.scr_con_current = scrState.scr_conlines;
  } else if (keyState.key_dest === KeydestT.key_console) {
    scrState.scr_conlines = (vid.height / 2) | 0; // half screen
  } else {
    scrState.scr_conlines = 0; // none visible
  }

  if (scrState.scr_conlines < scrState.scr_con_current) {
    scrState.scr_con_current -= scr_conspeed.value * host.frametime;
    if (scrState.scr_conlines > scrState.scr_con_current) scrState.scr_con_current = scrState.scr_conlines;
  } else if (scrState.scr_conlines > scrState.scr_con_current) {
    scrState.scr_con_current += scr_conspeed.value * host.frametime;
    if (scrState.scr_conlines < scrState.scr_con_current) scrState.scr_con_current = scrState.scr_conlines;
  }

  if (clearconsole++ < vid.numpages) {
    scrState.scr_copytop = 1;
    getRenderer().SCR_SoftwareTileClear(
      0,
      scrState.scr_con_current | 0,
      vid.width,
      vid.height - (scrState.scr_con_current | 0),
    );
    Sbar_Changed();
  } else if (scrState.clearnotify++ < vid.numpages) {
    scrState.scr_copytop = 1;
    getRenderer().SCR_SoftwareTileClear(0, 0, vid.width, conState.con_notifylines);
  } else {
    conState.con_notifylines = 0;
  }
}

export function SCR_DrawConsole(): void {
  if (scrState.scr_con_current) {
    scrState.scr_copyeverything = 1;
    Con_DrawConsole(scrState.scr_con_current);
    clearconsole = 0;
  } else {
    if (keyState.key_dest === KeydestT.key_game || keyState.key_dest === KeydestT.key_message) {
      Con_DrawNotify();
    }
  }
}

/*
==============================================================================

						SCREEN SHOTS

==============================================================================
*/

// pcx_t's on-disk layout, as in src/qw/client/client.ts's PCX_DATA_OFS (128)
function writePCXfile(
  filename: string,
  data: Uint8Array,
  width: number,
  height: number,
  rowbytes: number,
  palette: Uint8Array,
  upload: boolean,
): void {
  const buf = new Uint8Array(width * height * 2 + 1000);
  if (buf.length < PCX_DATA_OFS + 1) {
    Con_Printf("SCR_ScreenShot_f: not enough memory\n");
    return;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf[0] = 0x0a; // manufacturer -- PCX id
  buf[1] = 5; // version -- 256 color
  buf[2] = 1; // encoding -- uncompressed
  buf[3] = 8; // bits_per_pixel -- 256 color
  view.setUint16(4, 0, true); // xmin
  view.setUint16(6, 0, true); // ymin
  view.setUint16(8, width - 1, true); // xmax
  view.setUint16(10, height - 1, true); // ymax
  view.setUint16(12, width, true); // hres
  view.setUint16(14, height, true); // vres
  // palette (48 bytes at offset 16) left zero (Q_memset)
  buf[64] = 0; // reserved
  buf[65] = 1; // color_planes -- chunky image
  view.setUint16(66, width, true); // bytes_per_line
  view.setUint16(68, 2, true); // palette_type -- not a grey scale
  // filler (58 bytes at offset 70) left zero

  let pack = PCX_DATA_OFS;

  let srcIdx = 0;
  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const b = data[srcIdx] ?? 0;
      srcIdx++;
      if ((b & 0xc0) !== 0xc0) {
        buf[pack++] = b;
      } else {
        buf[pack++] = 0xc1;
        buf[pack++] = b;
      }
    }

    srcIdx += rowbytes - width;
  }

  buf[pack++] = 0x0c; // palette ID byte
  for (let i = 0; i < 768; i++) buf[pack++] = palette[i] ?? 0;

  const length = pack;
  if (upload) CL_StartUpload(buf, length);
  else COM_WriteFile(filename, buf.subarray(0, length));
}

export function SCR_ScreenShot_f(): void {
  // screen.c and gl_screen.c each define this command: the software build
  // writes quake00.pcx out of vid.buffer, the GLQUAKE build writes
  // quake00.tga out of glReadPixels. That is exactly the split PORTING.md's
  // renderer seam owns, and both bodies already live behind it
  // (src/ref_soft/ref_soft.ts, src/ref_gl/ref_gl.ts, ported from WinQuake's
  // identical pair -- QW's gl_screen.c body is byte-identical to WinQuake's,
  // and QW's screen.c body differs from WinQuake's only in the
  // "Couldn't create a PCX" text), so this forwards the same way
  // src/client/screen.ts does instead of carrying a second software-only
  // copy that renders black under -vid_ref gl.
  getRenderer().SCR_ScreenShot_f();
}

//=============================================================================
// SCR_RSShot_f's own helpers (screen.c-only: MipColor, SCR_DrawCharToSnap,
// SCR_DrawStringToSnap; see file header)

let mipLr = -1;
let mipLg = -1;
let mipLb = -1;
let mipLastBest = 0;

function mipColor(r: number, g: number, b: number): number {
  if (r === mipLr && g === mipLg && b === mipLb) return mipLastBest;

  let bestdist = 256 * 256 * 3;
  let best = 0;
  const pal = host_basepal.data;
  if (pal) {
    for (let i = 0; i < 256; i++) {
      const r1 = pal[i * 3] - r;
      const g1 = pal[i * 3 + 1] - g;
      const b1 = pal[i * 3 + 2] - b;
      const dist = r1 * r1 + g1 * g1 + b1 * b1;
      if (dist < bestdist) {
        bestdist = dist;
        best = i;
      }
    }
  }

  mipLr = r;
  mipLg = g;
  mipLb = b;
  mipLastBest = best;
  return best;
}

let drawCharsCache: Uint8Array | null = null;

// "from gl_draw.c: byte *draw_chars;" -- both screen.c and draw.c/gl_draw.c
// populate this the same way (`W_GetLumpName("conchars")`); loaded directly
// here rather than through the renderer (see file header).
function getDrawChars(): Uint8Array {
  if (!drawCharsCache) drawCharsCache = W_GetLumpName("conchars");
  return drawCharsCache;
}

function scrDrawCharToSnap(num: number, dest: Uint8Array, destOfsIn: number, width: number): void {
  const chars = getDrawChars();
  const row = num >> 4;
  const col = num & 15;
  let source = (row << 10) + (col << 3);
  let destOfs = destOfsIn;

  let drawline = 8;
  while (drawline--) {
    for (let x = 0; x < 8; x++) {
      const c = chars[source + x] ?? 0;
      dest[destOfs + x] = c !== 0 ? c : 98;
    }
    source += 128;
    destOfs += width;
  }
}

function scrDrawStringToSnap(s: string, buf: Uint8Array, x: number, y: number, width: number): void {
  let destOfs = y * width + x;
  for (let i = 0; i < s.length; i++) {
    scrDrawCharToSnap(s.charCodeAt(i), buf, destOfs, width);
    destOfs += 8;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// `ctime()`'s format (see file header: not a byte-identical glibc port)
function ctimeLike(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${d.getFullYear()}`;
}

const RSSHOT_WIDTH = 320; // QW/client/client.h
const RSSHOT_HEIGHT = 200;

export function SCR_RSShot_f(): void {
  if (CL_IsUploading()) return; // already one pending

  if (cls.state < CactiveT.ca_onserver) return; // gotta be connected

  if (!scr_allowsnap.value) {
    MSG_WriteByte(cls.qw.netchan.message, ClcOpsT.clc_stringcmd);
    SZ_Print(cls.qw.netchan.message, "snap\n");
    Con_Printf("Refusing remote screen shot request.\n");
    return;
  }

  Con_Printf("Remote screen shot requested.\n");

  if (!vid.buffer) {
    Con_Printf("snap: not supported without the software framebuffer (see file header)\n");
    return;
  }

  const re = getRenderer();
  re.D_EnableBackBufferAccess();

  const w = Math.min(vid.width, RSSHOT_WIDTH);
  const h = Math.min(vid.height, RSSHOT_HEIGHT);
  const fracw = vid.width / w;
  const frach = vid.height / h;

  const newbuf = new Uint8Array(w * h);
  const pal = host_basepal.data;
  const buffer = vid.buffer;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      const dx = Math.trunc(x * fracw);
      let dex = Math.trunc((x + 1) * fracw);
      if (dex === dx) dex++; // at least one
      const dy0 = Math.trunc(y * frach);
      let dey = Math.trunc((y + 1) * frach);
      if (dey === dy0) dey++; // at least one

      for (let dy = dy0; dy < dey; dy++) {
        let srcIdx = vid.rowbytes * dy + dx;
        for (let nx = dx; nx < dex; nx++) {
          const p = buffer[srcIdx] ?? 0;
          if (pal) {
            r += pal[p * 3] ?? 0;
            g += pal[p * 3 + 1] ?? 0;
            b += pal[p * 3 + 2] ?? 0;
          }
          srcIdx++;
          count++;
        }
      }
      if (count > 0) {
        r = Math.trunc(r / count);
        g = Math.trunc(g / count);
        b = Math.trunc(b / count);
      }
      newbuf[y * w + x] = mipColor(r, g, b);
    }
  }

  const st1 = ctimeLike(new Date());
  scrDrawStringToSnap(st1, newbuf, w - st1.length * 8, 0, w);

  const st2 = cls.qw.servername.slice(0, 79);
  scrDrawStringToSnap(st2, newbuf, w - st2.length * 8, 10, w);

  const st3 = name.string.slice(0, 79);
  scrDrawStringToSnap(st3, newbuf, w - st3.length * 8, 20, w);

  writePCXfile("", newbuf, w, h, w, pal ?? new Uint8Array(768), true);

  re.D_DisableBackBufferAccess();

  Con_Printf("Sending shot to server...\n");
}

//=============================================================================

let scr_notifystring = "";
let scr_drawdialog = false;

export function SCR_DrawNotifyString(): void {
  let l: number;
  let x: number;
  let y: number;

  let start = 0;

  y = (vid.height * 0.35) | 0;

  const re = getRenderer();

  for (;;) {
    for (l = 0; l < 40; l++) {
      const c = strAt(scr_notifystring, start + l);
      if (c === 10 || c === 0) break;
    }
    x = ((vid.width - l * 8) / 2) | 0;
    for (let j = 0; j < l; j++, x += 8) re.Draw_Character(x, y, strAt(scr_notifystring, start + j));

    y += 8;

    while (strAt(scr_notifystring, start) !== 0 && strAt(scr_notifystring, start) !== 10) start++;

    if (strAt(scr_notifystring, start) === 0) break;
    start++;
  }
}

export function SCR_ModalMessage(text: string): boolean {
  // QW: no `cls.state === ca_dedicated` early return (see file header)
  scr_notifystring = text;

  scrState.scr_fullupdate = 0;
  scr_drawdialog = true;
  SCR_UpdateScreen();
  scr_drawdialog = false;

  S_ClearBuffer();

  do {
    keyState.key_count = -1;
    Sys_SendKeyEvents();
  } while (key_lastpress !== 121 /* 'y' */ && key_lastpress !== 110 /* 'n' */ && key_lastpress !== K_ESCAPE);

  scrState.scr_fullupdate = 0;
  SCR_UpdateScreen();

  return key_lastpress === 121;
}

//=============================================================================

export function SCR_BringDownConsole(): void {
  scr_centertime_off = 0;

  for (let i = 0; i < 20 && scrState.scr_conlines !== scrState.scr_con_current; i++) SCR_UpdateScreen();

  cl.cshifts[0].percent = 0;
  if (host_basepal.data) vidBackend.current?.VID_SetPalette(host_basepal.data);
}

/*
==================
SCR_UpdateScreen
==================
*/
let oldscr_viewsize = 0;

export function SCR_UpdateScreen(): void {
  if (scrState.scr_skipupdate || scrState.block_drawing) return;

  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;

  // QW: no 60-second retry-then-"load failed." timeout (see file header)
  if (scrState.scr_disabled_for_loading) return;

  if (!scr_initialized || !conState.con_initialized) return;

  const re = getRenderer();

  re.BeginFrame();

  if (scr_viewsize.value !== oldscr_viewsize) {
    oldscr_viewsize = scr_viewsize.value;
    vid.recalc_refdef = 1;
  }

  if (oldfov !== scr_fov.value) {
    oldfov = scr_fov.value;
    vid.recalc_refdef = 1;
  }

  if (oldscreensize !== scr_viewsize.value) {
    oldscreensize = scr_viewsize.value;
    vid.recalc_refdef = 1;
  }

  if (oldsbar !== cl_sbar.value) {
    oldsbar = cl_sbar.value;
    vid.recalc_refdef = 1;
  }

  if (vid.recalc_refdef) {
    re.SCR_CalcRefdef();
  }

  re.D_EnableBackBufferAccess();

  if (scrState.scr_fullupdate++ < vid.numpages) {
    scrState.scr_copyeverything = 1;
    re.SCR_SoftwareTileClear(0, 0, vid.width, vid.height);
    Sbar_Changed();
  }

  pconupdate = null;

  SCR_SetUpToDrawConsole();
  SCR_EraseCenterString();

  re.D_DisableBackBufferAccess();

  vidBackend.current?.VID_LockBuffer();
  V_RenderView();
  vidBackend.current?.VID_UnlockBuffer();

  re.D_EnableBackBufferAccess();

  re.GL_Set2D();
  re.SCR_TileClear();

  if (r_netgraph.value) re.R_NetGraph?.();

  if (scr_drawdialog) {
    Sbar_Draw();
    re.Draw_FadeScreen();
    SCR_DrawNotifyString();
    scrState.scr_copyeverything = 1;
  } else if (cl.intermission === 1 && keyState.key_dest === KeydestT.key_game) {
    Sbar_IntermissionOverlay();
  } else if (cl.intermission === 2 && keyState.key_dest === KeydestT.key_game) {
    Sbar_FinaleOverlay();
    SCR_CheckDrawCenterString();
  } else {
    re.SCR_DrawCrosshair();

    SCR_DrawRam();
    SCR_DrawNet();
    SCR_DrawTurtle();
    SCR_DrawPause();
    SCR_DrawFPS();
    SCR_CheckDrawCenterString();
    Sbar_Draw();
    SCR_DrawConsole();
    M_Draw();
  }

  re.D_DisableBackBufferAccess();
  if (pconupdate) {
    re.D_UpdateRects(pconupdate);
  }

  V_UpdatePalette();

  re.EndFrame();
}

export function SCR_UpdateWholeScreen(): void {
  scrState.scr_fullupdate = 0;
  SCR_UpdateScreen();
}
