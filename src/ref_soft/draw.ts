/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/draw.c and WinQuake/draw.h (GNU GPL v2 or later).

draw.c -- this is the only file outside the refresh that touches the vid
buffer

Deviations from PORTING.md / the C source:
- The brief that opened this unit described a "`draw_chars[i] == 0 -> 255`
  transparency fixup loop in Draw_Init". No such loop exists in
  WinQuake/draw.c's `Draw_Init` (its body is exactly three `W_GetLumpName`
  calls plus the `r_rectdesc` assignment, with an unused `int i;` local and
  nothing that reads it). That loop is gl_draw.c's `Draw_Init`
  (`for (i=0 ; i<256*64 ; i++) if (draw_chars[i]==0) draw_chars[i]=255;`,
  confirmed in both WinQuake/gl_draw.c and QW/client/gl_draw.c), which exists
  because GL textures need a real alpha-equivalent transparent byte value
  and belongs to the OpenGL renderer's own draw unit, not this one. It is not
  ported here. Draw_Character's 8-bit path already treats a raw 0 byte as
  "don't draw" (`if (source[0]) dest[0] = source[0]`), so no such fixup has
  any observable effect in the software renderer regardless.
- `draw_chars` is `Uint8Array | null` (the raw "conchars" lump bytes --
  `W_GetLumpName`'s return type per wad.ts's ruling -- not a `QpicT`, since
  conchars has no qpic_t header: it is a flat 128x128 byte grid indexed
  directly by row/col, exactly as the C's `byte *draw_chars` and
  `W_GetLumpName`'s untyped `void *` return). `draw_backtile` is `QpicT |
  null`, read through wad.ts's `W_GetQpic` (the port's explicit `(qpic_t *)`
  cast helper, per wad.ts's file header and this unit's RULING).
- `draw_chars`/`draw_backtile` are module-private `let`s: draw.h does not
  declare them `extern` (only `draw_disc` is), and no other .c file in
  v1.09 reads them, so PORTING.md's "reassigned pointer -> shared holder"
  rule does not apply -- nothing outside this module needs to see them.
  `draw_disc` is `export let` because render.ts's `Renderer.draw_disc`
  member is exactly this global (draw.h: "also used on sbar"); the render.ts
  seam assembly unit reads it from here when it builds the software
  `Renderer` object.
- `r_rectdesc` (`static rectdesc_t r_rectdesc;` in the C) is ported per this
  unit's RULING as `{ width, height, ptexbytes, rowbytes }` only, dropping
  the C's `rect: vrect_t` sub-field. `rect` is write-only within
  `Draw_TileClear` in the C (assigned from that function's own x/y/w/h
  parameters, then immediately read back into locals a few lines later,
  never touched by any other function) -- a pointless round trip once the
  values are already sitting in `Draw_TileClear`'s own parameters, so this
  port reads x/y/w/h from the parameters directly instead of bouncing them
  through `r_rectdesc.rect` first. Observably identical.
- `r_pixbytes == 2` (16-bit framebuffer) branches are dropped everywhere in
  this file (Draw_Character, Draw_Pic, Draw_TransPic,
  Draw_TransPicTranslate, Draw_ConsoleBackground, R_DrawRect16): this port's
  software renderer is 8-bit only (r_shared.ts's `rState.r_pixbytes` is
  always 1; see r_shared.ts's file header). `R_DrawRect16` itself is not
  ported -- `Draw_TileClear`'s only caller of the pair always takes the
  8-bit branch in this port.
- `#ifdef PARANOID` range-assertions (Draw_Character's `y > vid.height - 8 ||
  x < 0 || x > vid.width - 8` / `num < 0 || num > 255` Sys_Errors) are
  dropped: PARANOID is never defined in a normal build (quakedef.ts's file
  header already documents this port-wide ruling; sizebuf.ts, world.ts,
  cl_tent.ts and pr_exec.ts drop the same guard for the same reason).
- Draw_TransPic / Draw_TransPicTranslate: the C's `pic->width & 7` branch
  chooses between a plain per-pixel loop and an 8-wide manually unrolled
  loop that does the same comparisons in the same order -- an optimization
  with no observable difference. This unit's brief rules that only the plain
  loop is ported; the unrolled branch is dropped as behaviorally identical.
- Draw_Character / Draw_Pic / Draw_TransPic / Draw_TransPicTranslate /
  Draw_Fill / Draw_FadeScreen / R_DrawRect8: `vid.buffer` / `vid.conbuffer`
  are `Uint8Array | null` here (vid.ts). Each function reads the field once
  into a local and returns early if it is null -- the case in which the C
  would have written through a NULL pointer -- matching r_misc.ts's
  `R_LineGraph` precedent for the same situation.
- Draw_FadeScreen drops the C's `VID_UnlockBuffer(); S_ExtraUpdate();
  VID_LockBuffer();` bracketing (both calls, before and after the fade
  loop). `VID_LockBuffer`/`VID_UnlockBuffer` are the non-_WIN32 empty macros
  (quakedef.ts's file header), so they have no effect in this port either
  way; `S_ExtraUpdate` is snd_dma.ts's sound-mixing pump, a client-audio
  concern outside this renderer-only unit's scope (and outside draw.c's own
  job of touching only the vid buffer) that does not affect anything
  Draw_FadeScreen writes.
- Draw_CachePic: `cachepic_t.cache` (`cache_user_t`) is `CacheUser<Uint8Array>`
  here, holding the raw loaded file bytes exactly as `COM_LoadCacheFile`
  (common.ts) fills it in the C (`Cache_Alloc`'s buffer, later reinterpreted
  through a `(qpic_t *)` cast) -- not a `CacheUser<QpicT>`, so the same
  object satisfies both `Cache_Check`/`zone.ts` and `COM_LoadCacheFile`'s
  `CacheUserT` (`{ data: Uint8Array | null }`) without a cast. One
  consequence: the C's cache-hit path (`dat = Cache_Check(&pic->cache); if
  (dat) return dat;`) returns the qpic_t* immediately, never re-running
  `SwapPic` on a hit (only the freshly-loaded path calls it) because the C's
  cast just reinterprets the same in-memory bytes it already swapped once.
  This port's `QpicT` is a freshly parsed view object, not a reinterpreted
  pointer, so `SwapPic` runs on every `Draw_CachePic` call, hit or miss.
  `SwapPic` is a little-endian identity parse (this port targets
  little-endian hosts only, per wad.ts/common.ts), so this produces
  bit-identical results to the C's single-swap-then-reuse -- no behavior
  change, just where the (idempotent) parse happens.
- Draw_CachePic: `cachepic_t.name` is `char name[MAX_QPATH]` in the C,
  silently truncated by `strcpy`. This port stores the untruncated JS
  string; every real call site (`Draw_ConsoleBackground`'s
  "gfx/conback.lmp", menu.c's pic paths) is well under 64 characters, so
  this is not observable.
- Draw_DebugChar: the C's body past its `if (!vid.direct) return;` guard
  draws into `vid.direct`, the direct-framebuffer pointer only a DOS
  mode-13h video backend (vid_dos.c) ever assigns -- not ported by
  PORTING.md's file table (`src/platform/vid.ts` + `swimp.ts`, the SDL
  backend, never sets `vid.direct`). That code is therefore permanently
  unreachable in this port; RULING: kept as the empty function the brief
  calls for, with just the (always-true) guard for documentation.
- `Draw_ConsoleBackground`'s version-string hack: the C's `#if
  defined(_WIN32) / elif X11 / elif __linux__ / else` chain is resolved to
  the `__linux__` branch per this unit's RULING
  (`"(Linux Quake %2.2f) %4.2f"`, `LINUX_VERSION`/`VERSION` from
  quakedef.ts). The other three branches are dropped.
- `Draw_Init` does not itself register `hostClientHooks.drawInit`:
  ref_soft.ts installs a dispatching `hostClientHooks.drawInit = () =>
  re.current?.Draw_Init()` alongside its other three `re.current`-routed
  hooks, so a GL build swapped into `re.current` at runtime still gets its
  own `Draw_Init` called instead of this module's.
- `R_DrawRect8`'s `byte *psrc` (an already-offset pointer into
  `r_rectdesc.ptexbytes`) becomes a base `Uint8Array` plus a separate
  `psrcOfs: number` parameter, since this port has no pointer arithmetic.
  `R_DrawRect16` is not ported (16-bit, dropped above).
- Not exported (module-private, matching the C's file-scope `static`/
  non-`extern` visibility): `r_rectdesc`, `draw_chars`, `draw_backtile`,
  `R_DrawRect8`, `Draw_CharToConback`. `draw_disc` and every draw.h function
  are exported, matching render.ts's `Renderer` member list.
*/

import { Sys_Error } from "../platform/sys";
import { Com_sprintf } from "../common/sprintf";
import { LINUX_VERSION, VERSION, qw } from "../common/quakedef";
import { QpicT, W_GetLumpName, W_GetQpic, SwapPic } from "../common/wad";
import { CacheUser, Cache_Check } from "../common/zone";
import { COM_LoadCacheFile } from "../common/common";
import { vid, vidBackend, VrectT } from "../client/vid";
import { TRANSPARENT_COLOR } from "./d_iface";
import { cls } from "../client/client";
import { scr_vrect } from "../client/screen_types";
// QW/client/draw.c:274 `extern cvar_t crosshair, cl_crossx, cl_crossy, crosshaircolor;`
// -- crosshair/cl_crossx/cl_crossy are already exported by view.ts (WinQuake's
// own crosshair cvars, read by ref_soft.ts's V_DrawCrosshair). crosshaircolor
// is QW-only and NOT YET exported by view.ts as of this writing (polled
// `timeout 300 sleep 60` x3, still absent) -- imported by name anyway per
// PORTING.md's cross-unit-dependency idiom; this import will type-error until
// view.ts (Q023b) adds `export const crosshaircolor = new CvarT(...)`.
import { cl_crossx, cl_crossy, crosshair, crosshaircolor } from "../client/view";
import { Con_Printf } from "../client/console";

//=============================================================================
/* Support Routines */

class CachepicT {
  name = ""; // char name[MAX_QPATH]
  cache: CacheUser<Uint8Array> = new CacheUser<Uint8Array>();
}

export const MAX_CACHED_PICS = 128;
export const menu_cachepics: CachepicT[] = Array.from({ length: MAX_CACHED_PICS }, () => new CachepicT());
export let menu_numcachepics = 0;

let draw_chars: Uint8Array | null = null; // 8*8 graphic characters
export let draw_disc: QpicT | null = null; // also used on sbar
let draw_backtile: QpicT | null = null;

class RectdescT {
  width = 0;
  height = 0;
  ptexbytes: Uint8Array | null = null;
  rowbytes = 0;
}
const r_rectdesc = new RectdescT();

/*
=============
Draw_PicFromWad
=============
*/
export function Draw_PicFromWad(name: string): QpicT | null {
  return W_GetQpic(name);
}

/*
================
Draw_CachePic
================
*/
export function Draw_CachePic(path: string): QpicT | null {
  let i = 0;
  for (; i < menu_numcachepics; i++) {
    if (path === menu_cachepics[i].name) break;
  }

  let pic: CachepicT;
  if (i === menu_numcachepics) {
    if (menu_numcachepics === MAX_CACHED_PICS) return Sys_Error("menu_numcachepics == MAX_CACHED_PICS");
    menu_numcachepics++;
    pic = menu_cachepics[i];
    pic.name = path;
  } else {
    pic = menu_cachepics[i];
  }

  const cached = Cache_Check(pic.cache);
  if (cached) return SwapPic(cached); // see file header: cache hits re-parse, never re-swap real memory

  // load the pic from disk
  COM_LoadCacheFile(path, pic.cache);

  const dat = pic.cache.data;
  if (!dat) {
    return Sys_Error("Draw_CachePic: failed to load %s", path);
  }

  return SwapPic(dat);
}

/*
===============
Draw_Init
===============
*/
export function Draw_Init(): void {
  draw_chars = W_GetLumpName("conchars");
  draw_disc = W_GetQpic("disc");
  draw_backtile = W_GetQpic("backtile");

  r_rectdesc.width = draw_backtile.width;
  r_rectdesc.height = draw_backtile.height;
  r_rectdesc.ptexbytes = draw_backtile.data;
  r_rectdesc.rowbytes = draw_backtile.width;
}

/*
================
Draw_Character

Draws one 8*8 graphics character with 0 being transparent.
It can be clipped to the top of the screen to allow the console to be
smoothly scrolled off.
================
*/
export function Draw_Character(x: number, y: number, num: number): void {
  x = x | 0;
  y = y | 0;
  num = num | 0;
  num &= 255;

  if (y <= -8) return; // totally off screen

  const chars = draw_chars;
  if (!chars) return; // Draw_Init not yet run -- guards TS's null draw_chars where the C's global pointer would already be set

  const row = num >> 4;
  const col = num & 15;
  let sourceOfs = (row << 10) + (col << 3);

  let drawline: number;
  if (y < 0) {
    // clipped
    drawline = 8 + y;
    sourceOfs -= 128 * y;
    y = 0;
  } else {
    drawline = 8;
  }

  // r_pixbytes == 1 only -- see file header
  const conbuffer = vid.conbuffer;
  if (!conbuffer) return;

  let destOfs = y * vid.conrowbytes + x;

  while (drawline--) {
    if (chars[sourceOfs + 0]) conbuffer[destOfs + 0] = chars[sourceOfs + 0];
    if (chars[sourceOfs + 1]) conbuffer[destOfs + 1] = chars[sourceOfs + 1];
    if (chars[sourceOfs + 2]) conbuffer[destOfs + 2] = chars[sourceOfs + 2];
    if (chars[sourceOfs + 3]) conbuffer[destOfs + 3] = chars[sourceOfs + 3];
    if (chars[sourceOfs + 4]) conbuffer[destOfs + 4] = chars[sourceOfs + 4];
    if (chars[sourceOfs + 5]) conbuffer[destOfs + 5] = chars[sourceOfs + 5];
    if (chars[sourceOfs + 6]) conbuffer[destOfs + 6] = chars[sourceOfs + 6];
    if (chars[sourceOfs + 7]) conbuffer[destOfs + 7] = chars[sourceOfs + 7];
    sourceOfs += 128;
    destOfs += vid.conrowbytes;
  }
}

/*
================
Draw_String
================
*/
export function Draw_String(x: number, y: number, str: string): void {
  let cx = x | 0;
  const cy = y | 0;

  for (let i = 0; i < str.length; i++) {
    Draw_Character(cx, cy, str.charCodeAt(i));
    cx += 8;
  }
}

/*
================
Draw_Alt_String

QW/client/draw.c addition (also gl_draw.c) -- high-bit-set variant of
Draw_String, not in WinQuake's draw.c/draw.h.
================
*/
export function Draw_Alt_String(x: number, y: number, str: string): void {
  let cx = x | 0;
  const cy = y | 0;

  for (let i = 0; i < str.length; i++) {
    Draw_Character(cx, cy, str.charCodeAt(i) | 0x80);
    cx += 8;
  }
}

/*
================
Draw_Pixel

QW/client/draw.c addition, module-private (not in draw.h) -- Draw_Crosshair's
crosshair.value==2 dot renderer. r_pixbytes == 1 only, see file header.
================
*/
function Draw_Pixel(x: number, y: number, color: number): void {
  const conbuffer = vid.conbuffer;
  if (!conbuffer) return;
  conbuffer[y * vid.conrowbytes + x] = color;
}

/*
================
Draw_Crosshair

QW/client/draw.c addition. WinQuake draws its crosshair inline at the end of
view.c's V_RenderView (ref_soft.ts's V_DrawCrosshair, out of this unit's
SCOPE); QW factors it out into this shared function instead, still called
from the same place. Ported here so ref_soft.ts's V_DrawCrosshair can call it
under qw.active -- see this unit's report for the exact one-line wiring that
file (out of SCOPE) still needs.
================
*/
export function Draw_Crosshair(): void {
  const c = crosshaircolor.value | 0;

  if (crosshair.value === 2) {
    const x = (scr_vrect.x + ((scr_vrect.width / 2) | 0) + cl_crossx.value) | 0;
    const y = (scr_vrect.y + ((scr_vrect.height / 2) | 0) + cl_crossy.value) | 0;
    Draw_Pixel(x - 1, y, c);
    Draw_Pixel(x - 3, y, c);
    Draw_Pixel(x + 1, y, c);
    Draw_Pixel(x + 3, y, c);
    Draw_Pixel(x, y - 1, c);
    Draw_Pixel(x, y - 3, c);
    Draw_Pixel(x, y + 1, c);
    Draw_Pixel(x, y + 3, c);
  } else if (crosshair.value) {
    Draw_Character(
      (scr_vrect.x + ((scr_vrect.width / 2) | 0) - 4 + cl_crossx.value) | 0,
      (scr_vrect.y + ((scr_vrect.height / 2) | 0) - 4 + cl_crossy.value) | 0,
      "+".charCodeAt(0),
    );
  }
}

/*
================
Draw_SubPic

QW/client/draw.c addition -- blits a sub-rectangle of a pic without going
through the scrap. r_pixbytes == 1 only, see file header.
================
*/
export function Draw_SubPic(x: number, y: number, pic: QpicT, srcx: number, srcy: number, width: number, height: number): void {
  x = x | 0;
  y = y | 0;

  if (x < 0 || x + width > vid.width || y < 0 || y + height > vid.height) {
    return Sys_Error("Draw_Pic: bad coordinates");
  }

  const buffer = vid.buffer;
  if (!buffer) return;

  let destOfs = y * vid.rowbytes + x;
  let sourceOfs = srcy * pic.width + srcx;

  for (let v = 0; v < height; v++) {
    buffer.set(pic.data.subarray(sourceOfs, sourceOfs + width), destOfs);
    destOfs += vid.rowbytes;
    sourceOfs += pic.width;
  }
}

/*
================
Draw_DebugChar

Draws a single character directly to the upper right corner of the screen.
This is for debugging lockups by drawing different chars in different parts
of the code.
================
*/
export function Draw_DebugChar(num: number): void {
  // don't have direct FB access, so no debugchars... -- vid.direct is never
  // assigned by this port's video backend (src/platform/vid.ts + swimp.ts,
  // no DOS mode-13h path), so the C body past this guard is permanently
  // unreachable and is not ported. RULING: empty in Linux.
  void num;
  if (!vid.direct) return;
}

/*
=============
Draw_Pic
=============
*/
export function Draw_Pic(x: number, y: number, pic: QpicT): void {
  x = x | 0;
  y = y | 0;

  if (x < 0 || x + pic.width > vid.width || y < 0 || y + pic.height > vid.height) {
    return Sys_Error("Draw_Pic: bad coordinates");
  }

  const buffer = vid.buffer;
  if (!buffer) return;

  const source = pic.data;
  let destOfs = y * vid.rowbytes + x;
  let sourceOfs = 0;

  for (let v = 0; v < pic.height; v++) {
    buffer.set(source.subarray(sourceOfs, sourceOfs + pic.width), destOfs);
    destOfs += vid.rowbytes;
    sourceOfs += pic.width;
  }
}

/*
=============
Draw_TransPic
=============
*/
export function Draw_TransPic(x: number, y: number, pic: QpicT): void {
  x = x | 0;
  y = y | 0;

  if (x < 0 || x + pic.width > vid.width || y < 0 || y + pic.height > vid.height) {
    return Sys_Error("Draw_TransPic: bad coordinates");
  }

  const buffer = vid.buffer;
  if (!buffer) return;

  const source = pic.data;
  let destOfs = y * vid.rowbytes + x;
  let sourceOfs = 0;

  // see file header: the C's width&7 unrolled-by-8 branch is dropped as
  // behaviorally identical to this plain per-pixel loop
  for (let v = 0; v < pic.height; v++) {
    for (let u = 0; u < pic.width; u++) {
      const tbyte = source[sourceOfs + u];
      if (tbyte !== TRANSPARENT_COLOR) buffer[destOfs + u] = tbyte;
    }
    destOfs += vid.rowbytes;
    sourceOfs += pic.width;
  }
}

/*
=============
Draw_TransPicTranslate
=============
*/
export function Draw_TransPicTranslate(x: number, y: number, pic: QpicT, translation: Uint8Array): void {
  x = x | 0;
  y = y | 0;

  // the C's Draw_TransPicTranslate reuses Draw_TransPic's error text verbatim
  if (x < 0 || x + pic.width > vid.width || y < 0 || y + pic.height > vid.height) {
    return Sys_Error("Draw_TransPic: bad coordinates");
  }

  const buffer = vid.buffer;
  if (!buffer) return;

  const source = pic.data;
  let destOfs = y * vid.rowbytes + x;
  let sourceOfs = 0;

  for (let v = 0; v < pic.height; v++) {
    for (let u = 0; u < pic.width; u++) {
      const tbyte = source[sourceOfs + u];
      if (tbyte !== TRANSPARENT_COLOR) buffer[destOfs + u] = translation[tbyte];
    }
    destOfs += vid.rowbytes;
    sourceOfs += pic.width;
  }
}

/*
Draw_CharToConback -- not in draw.h, module-private, same name as the C
*/
function Draw_CharToConback(num: number, dest: Uint8Array, destOfs: number): void {
  const chars = draw_chars;
  if (!chars) return;

  const row = num >> 4;
  const col = num & 15;
  let sourceOfs = (row << 10) + (col << 3);

  let drawline = 8;
  let d = destOfs;

  while (drawline--) {
    for (let x = 0; x < 8; x++) {
      if (chars[sourceOfs + x]) dest[d + x] = 0x60 + chars[sourceOfs + x];
    }
    sourceOfs += 128;
    d += 320;
  }
}

/*
================
Draw_ConsoleBackground

================
*/
// QW/client/draw.c: `static char saveback[320*8]` -- Draw_ConsoleBackground's
// own scratch buffer, see below.
const conback_saveback = new Uint8Array(320 * 8);

export function Draw_ConsoleBackground(lines: number): void {
  const conback = Draw_CachePic("gfx/conback.lmp");
  if (!conback) return; // Draw_CachePic Sys_Errors on failure in the C; guards TS's nullable return

  let ver: string;
  let verDestBase: number;

  if (qw.active) {
    // QW/client/draw.c:661-671 -- the version-string hack branches on
    // cls.download, and (unlike WinQuake's Draw_Init, which bakes the string
    // into the pic once at load time) writes it into the shared conback
    // cache bytes on EVERY call, so it saves and restores the row range it
    // overwrites (`saveback`) to avoid stacking garbage from a differently
    // sized string next call.
    if (cls.qw.download) {
      ver = Com_sprintf("%4.2f", VERSION);
      verDestBase = 320 + 320 * 186 - 11 - 8 * ver.length;
    } else {
      // #if defined(__linux__) branch (RULING; see file header's precedent)
      ver = Com_sprintf("Linux (%4.2f) QuakeWorld %4.2f", LINUX_VERSION, VERSION);
      verDestBase = 320 - (ver.length * 8 + 11) + 320 * 186;
    }
    conback_saveback.set(conback.data.subarray(320 * 186, 320 * 186 + conback_saveback.length));
  } else {
    // hack the version number directly into the pic -- #ifdef __linux__ branch
    // (RULING; see file header)
    ver = Com_sprintf("(Linux Quake %2.2f) %4.2f", LINUX_VERSION, VERSION);
    verDestBase = 320 * 186 + 320 - 11 - 8 * ver.length;
  }

  for (let x = 0; x < ver.length; x++) {
    Draw_CharToConback(ver.charCodeAt(x), conback.data, verDestBase + (x << 3));
  }

  // draw the pic -- r_pixbytes == 1 only, see file header
  const conbuffer = vid.conbuffer;
  if (!conbuffer) return;

  let destOfs = 0;
  for (let y = 0; y < lines; y++, destOfs += vid.conrowbytes) {
    const v = ((vid.conheight - lines + y) * 200) / vid.conheight;
    const srcOfs = (v | 0) * 320;

    if (vid.conwidth === 320) {
      conbuffer.set(conback.data.subarray(srcOfs, srcOfs + vid.conwidth), destOfs);
    } else {
      let f = 0;
      const fstep = ((320 * 0x10000) / vid.conwidth) | 0;
      for (let x = 0; x < vid.conwidth; x += 4) {
        conbuffer[destOfs + x] = conback.data[srcOfs + (f >> 16)];
        f += fstep;
        conbuffer[destOfs + x + 1] = conback.data[srcOfs + (f >> 16)];
        f += fstep;
        conbuffer[destOfs + x + 2] = conback.data[srcOfs + (f >> 16)];
        f += fstep;
        conbuffer[destOfs + x + 3] = conback.data[srcOfs + (f >> 16)];
        f += fstep;
      }
    }
  }

  // QW/client/draw.c: `memcpy(conback->data + 320*186, saveback, 320*8);` --
  // put the pre-hack bytes back so the shared cache data isn't left mutated
  // for the next Draw_CachePic caller.
  if (qw.active) {
    conback.data.set(conback_saveback, 320 * 186);
  }
}

/*
==============
R_DrawRect8

Not in draw.h, module-private, same name as the C. R_DrawRect16 (16-bit) is
not ported -- see file header.
==============
*/
function R_DrawRect8(prect: VrectT, rowbytes: number, psrc: Uint8Array, psrcOfs: number, transparent: boolean): void {
  const buffer = vid.buffer;
  if (!buffer) return;

  let pdestOfs = prect.y * vid.rowbytes + prect.x;

  const srcdelta = rowbytes - prect.width;
  const destdelta = vid.rowbytes - prect.width;

  let srcOfs = psrcOfs;

  if (transparent) {
    for (let i = 0; i < prect.height; i++) {
      for (let j = 0; j < prect.width; j++) {
        const t = psrc[srcOfs];
        if (t !== TRANSPARENT_COLOR) buffer[pdestOfs] = t;

        srcOfs++;
        pdestOfs++;
      }

      srcOfs += srcdelta;
      pdestOfs += destdelta;
    }
  } else {
    for (let i = 0; i < prect.height; i++) {
      buffer.set(psrc.subarray(srcOfs, srcOfs + prect.width), pdestOfs);
      srcOfs += rowbytes;
      pdestOfs += vid.rowbytes;
    }
  }
}

/*
=============
Draw_TileClear

This repeats a 64*64 tile graphic to fill the screen around a sized down
refresh window.
=============
*/
export function Draw_TileClear(x: number, y: number, w: number, h: number): void {
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;

  const ptexbytes = r_rectdesc.ptexbytes;
  if (!ptexbytes) return; // Draw_Init not yet run

  // see file header: r_rectdesc.rect is dropped, x/y/w/h read directly
  const vr = new VrectT();
  vr.y = y;
  let height = h;

  let tileoffsety = vr.y % r_rectdesc.height;

  while (height > 0) {
    vr.x = x;
    let width = w;

    if (tileoffsety !== 0) vr.height = r_rectdesc.height - tileoffsety;
    else vr.height = r_rectdesc.height;

    if (vr.height > height) vr.height = height;

    let tileoffsetx = vr.x % r_rectdesc.width;

    while (width > 0) {
      if (tileoffsetx !== 0) vr.width = r_rectdesc.width - tileoffsetx;
      else vr.width = r_rectdesc.width;

      if (vr.width > width) vr.width = width;

      const psrcOfs = tileoffsety * r_rectdesc.rowbytes + tileoffsetx;

      R_DrawRect8(vr, r_rectdesc.rowbytes, ptexbytes, psrcOfs, false);

      vr.x += vr.width;
      width -= vr.width;
      tileoffsetx = 0; // only the left tile can be left-clipped
    }

    vr.y += vr.height;
    height -= vr.height;
    tileoffsety = 0; // only the top tile can be top-clipped
  }
}

/*
=============
Draw_Fill

Fills a box of pixels with a single color
=============
*/
export function Draw_Fill(x: number, y: number, w: number, h: number, c: number): void {
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  c = c | 0;

  // QW/client/draw.c adds this bounds check (WinQuake's Draw_Fill has none);
  // dropped silently when qw.active is false, matching WinQuake exactly.
  if (qw.active && (x < 0 || x + w > vid.width || y < 0 || y + h > vid.height)) {
    Con_Printf("Bad Draw_Fill(%d, %d, %d, %d, %c)\n", x, y, w, h, c);
    return;
  }

  const buffer = vid.buffer;
  if (!buffer) return;

  let destOfs = y * vid.rowbytes + x;
  for (let v = 0; v < h; v++, destOfs += vid.rowbytes) {
    for (let u = 0; u < w; u++) buffer[destOfs + u] = c;
  }
}

//=============================================================================

/*
================
Draw_FadeScreen

================
*/
export function Draw_FadeScreen(): void {
  // see file header: VID_UnlockBuffer/S_ExtraUpdate/VID_LockBuffer bracketing dropped
  const buffer = vid.buffer;
  if (!buffer) return;

  for (let y = 0; y < vid.height; y++) {
    const pbufOfs = vid.rowbytes * y;
    const t = (y & 1) << 1;

    for (let x = 0; x < vid.width; x++) {
      if ((x & 3) !== t) buffer[pbufOfs + x] = 0;
    }
  }
}

//=============================================================================

/*
================
Draw_BeginDisc

Draws the little blue disc in the corner of the screen.
Call before beginning any disc IO.
================
*/
export function Draw_BeginDisc(): void {
  if (!draw_disc) return; // Draw_Init not yet run
  vidBackend.current?.D_BeginDirectRect(vid.width - 24, 0, draw_disc.data, 24, 24);
}

/*
================
Draw_EndDisc

Erases the disc icon.
Call after completing any disc IO
================
*/
export function Draw_EndDisc(): void {
  vidBackend.current?.D_EndDirectRect(vid.width - 24, 0, 24, 24);
}

