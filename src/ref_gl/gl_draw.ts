/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_draw.c (GNU GPL v2 or later). `GL_Set2D` is also
gl_draw.c's own (render.ts's seam table cites gl_screen.c:873 for the CALL
site inside SCR_UpdateScreen, but the DEFINITION -- confirmed by reading
gl_draw.c directly -- is gl_draw.c:836, alongside every other Draw_ and GL_
function here). `is8bit`/`d_15to8table` are gl_vidlinuxglx.c/gl_vidnt.c
globals; U075's src/ref_gl/gl_vid.ts landed concurrently with this unit and
already owns them for real (`VID_Is8bit()`, `d_15to8table`), so this file
imports them from there directly -- see the RULING below, updated from this
unit's original brief (written before U075 had landed).

draw.c -- this is the only file outside the refresh that touches the vid
buffer

RULINGS (reported per this unit's brief):

- glpic_t / QpicT association: the C overlays `glpic_t { texnum; sl,tl,sh,th }`
  directly onto a qpic_t's `data` bytes (`gl = (glpic_t *)p->data`), so a
  qpic_t IS its own GL handle in memory. src/common/wad.ts's `QpicT` (out of
  this unit's SCOPE) has no field for that overlay and none was added, so
  RULING: a private `class GlpicT { texnum; sl; tl; sh; th }` plus a private
  `Map<QpicT, GlpicT>` (`picGl`) associates a QpicT with its GL info. This
  works because every QpicT this file hands out (Draw_PicFromWad,
  Draw_CachePic, the module-private `conback`) is a distinct, stable object
  identity that callers keep and pass back in (draw_disc, draw_backtile,
  Draw_ConsoleBackground's use of `conback`, a cache hit's `&pic->pic`) --
  the same identity discipline the C's pointer overlay relies on. Chosen over
  a `glpic` field on QpicT because wad.ts is out of SCOPE for this unit.
- `is8bit`/`d_15to8table[65536]`: owned by gl_vidlinuxglx.c/gl_vidnt.c
  (confirmed absent from glquake.ts's `glState` -- glquake.ts's OWNERSHIP
  block files both under gl_vidlinuxglx.c). This unit's original brief
  predates U075's landing and ruled a local placeholder holder here
  (`drawState`) for exactly this reason; U075's src/ref_gl/gl_vid.ts has
  since landed (concurrently with this unit) and exports the real
  `VID_Is8bit(): boolean` accessor and the real, populated
  `d_15to8table: Uint8Array` (filled by gl_vid.ts's `VID_SetPalette`).
  Updated RULING: import both directly from "./gl_vid" rather than keep a
  duplicate placeholder -- confirmed acyclic (gl_vid.ts's own imports are
  only ../client/*, ../common/*, ../platform/*, ./glquake and ./qgl; it
  never imports this file).
- `hostClientHooks.drawInit` is NOT registered here. src/ref_soft/ref_soft.ts
  already installs `hostClientHooks.drawInit = () => { re.current?.Draw_Init(); }`,
  which dispatches through whichever renderer `vid_ref` has selected; the GL
  Renderer object's own `Draw_Init` member (assembled by U075, wrapping this
  file's `Draw_Init`) is what actually runs. A second registration here would
  either be redundant or clobber ref_soft's, so it is intentionally omitted,
  per this unit's brief.
- GL_EnableMultitexture / GL_DisableMultitexture / `mtexenabled`: confirmed
  by reading WinQuake/gl_rsurf.c (lines 282-300) that these are gl_rsurf.c's
  (U073), not gl_draw.c's -- gl_draw.c never defines or calls them. Not
  ported here; glquake.ts's OWNERSHIP block already files them under
  gl_rsurf.c. `GL_SelectTexture`, by contrast, IS gl_draw.c's own (confirmed
  at gl_draw.c:1287, the last function in the file) and is ported here.

Deviations from PORTING.md / the C source:
- GL_LoadTexture's identifier cache has a real, reproducible bug in the
  shipped C, ported here VERBATIM (exactly as the original, per PORTING.md/preferences
  rule 4): when `identifier` is non-empty and NOT found in the existing
  `[0, numgltextures)` range, the C's search loop ends with
  `glt == &gltextures[numgltextures]` (i and glt both walked in lockstep to
  the loop bound) and falls through to fill that slot -- but only the
  `identifier == ""` branch's `else` arm increments `numgltextures`. So every
  named (non-"") load that misses the cache reuses/overwrites
  `gltextures[numgltextures]` without the count ever advancing, and the next
  named load does the same to the same slot, until an anonymous ("") load
  (from GL_LoadPicTexture) finally increments the count and moves on. This is
  why named loads ("charset", "conback") never dead-end -- the GL texture
  object itself is still created via `texture_extension_number`, which always
  advances; only the *identifier* bookkeeping is broken, exactly as it is in
  the original engine. Ported as-is: `numgltextures++` appears only in the
  `identifier === ""` branch.
- GL_ResampleTexture / GL_Resample8BitTexture: the C's inner loop
  (`for (j=0; j<outwidth; j+=4) { out[j]=...; out[j+1]=...; out[j+2]=...;
  out[j+3]=...; }`) assumes `outwidth` is a multiple of 4 (true whenever
  `outwidth >= 4`, since it is always a power of two); for `outwidth` in
  {1, 2} it would read/write up to 3 slots past the row end -- into the next
  row of the SAME shared static scratch buffer in the C (harmless there,
  since the buffer is far larger than any single texture). This port
  allocates the output buffer sized exactly `outwidth*outheight`, so the
  same overrun is a genuine out-of-bounds typed-array access: reads return
  `undefined` (coerced to 0 on write, since a typed array element assignment
  passes through ToNumber) rather than the C's adjacent-row garbage, and
  writes past the end are silently dropped. This only affects the last one
  or two output pixels of a texture resampled down to width 1 or 2 (an
  extremely rare mip level), never observed by this unit's tests.
- GL_Upload8_EXT: the C's alpha/`noalpha` scan (`for (i=0;i<s;i++) if
  (data[i]==255) noalpha=false; if (alpha && noalpha) alpha=false;`) computes
  a value that is never read again anywhere else in the function -- `alpha`
  is not passed to either glTexImage2D call, nor examined by any later
  branch. Dropped as provably inert (PORTING.md's precedent for dead,
  zero-observable-effect computation, e.g. ref_soft/draw.ts's dropped 8-wide
  unrolled branch). Likewise the C's unused locals `samples` (computed,
  never read -- both glTexImage2D calls hardcode GL_COLOR_INDEX8_EXT/
  GL_COLOR_INDEX) and `static unsigned j` (declared, never referenced) are
  not ported.
- Draw_TransPicTranslate: `dest[u] = p;` (the C's `p == 255` branch) assigns
  the raw int 255 into an `unsigned` (32-bit RGBA) slot -- byte 0 (R) becomes
  255 and bytes 1-3 (G,B,A) become 0, NOT an opaque white/transparent pixel.
  Ported literally: `trans[v*64+u] = p` when `p === 255`, not an expanded
  four-byte write.
- `#if 0` blocks dropped silently, per PORTING.md: Draw_Init's scaled-conback
  resize block (the console background is always used at its loaded
  resolution, `ncdata = cb->data`, matching the `#else` branch actually
  compiled); GL_Upload32/GL_Upload8_EXT's commented-out
  `gluBuild2DMipmaps`/`gluScaleImage` alternative upload path.
- `#ifdef _WIN32 bindTexFunc(...)` in GL_Bind dropped; the portable
  `glBindTexture` path (already unconditional in a non-_WIN32 build) is the
  one ported, per PORTING.md's "take the portable, non-asm path".
- Draw_AlphaPic's two already-commented-out C lines (`// glBlendFunc(...)`,
  `// glCullFace(GL_FRONT)`) are not ported -- they were never compiled in
  the original either.
- GL_FindTexture is ported (gl_draw.c defines it non-static) even though
  grepping the full WinQuake tree shows no call site anywhere, in this file
  or any other -- dead but shipped code, kept for fidelity and exported for
  this unit's test seam.
- `gl_lightmap_format` is `extern`-declared in glquake.h (unlike
  `gl_filter_min`/`gl_filter_max`/`texels`/`numgltextures`/`gltextures`/
  `draw_chars`/`draw_disc`(*)/`draw_backtile`/`translate_texture`/
  `char_texture`/the scrap block, none of which glquake.h declares extern;
  (*) `draw_disc` is declared extern by draw.h, not glquake.h) and is
  REASSIGNED by gl_rsurf.c's GL_BuildLightmaps even though gl_draw.c
  defines/initializes it. gl_rsurf.ts (U073) landed concurrently with this
  unit and already documents this exact cross-module-reassignment problem
  in its own header, with a RULING this file must satisfy: it imports
  `glDrawState` from here and reads/writes `glDrawState.gl_lightmap_format`
  directly. This file therefore exports `glDrawState` as a holder object
  (not a plain `let` + setter, which is what this unit's own brief had
  proposed before gl_rsurf.ts landed) carrying that one field, initialized
  to 4 exactly where gl_draw.c's `int gl_lightmap_format = 4;` does.
  `gl_solid_format`/`gl_alpha_format` are never reassigned anywhere else in
  the tree and stay plain `const`.
- `texels`, `pic_texels`, `pic_count`, `scrap_uploads` are incremented but,
  confirmed by grep, never read by any other C file (or, for `pic_texels`/
  `pic_count`/`scrap_uploads`, anywhere else in gl_draw.c itself either) --
  dead instrumentation counters, kept module-private and still incremented
  for fidelity, matching the C's own dead-but-harmless bookkeeping.
- `conback` (the C's `qpic_t *conback = (qpic_t *)&conback_buffer;`, a
  20-byte buffer sized only for the glpic_t overlay, never real pixel data)
  becomes a private, persistent `QpicT` here with an empty `data`
  (`new Uint8Array(0)`) -- nothing in the GL renderer ever reads a pic's
  `.data` for drawing (only its associated GlpicT + width/height), so no
  real bytes are needed. `cb` (the actual loaded gfx/conback.lmp pixels,
  `COM_LoadTempFile` + `SwapPic`) is the separate, ephemeral QpicT that DOES
  carry real bytes, exactly as the C's `cb` and `conback` are two distinct
  objects.
- `menu_cachepics[]`/`menu_numcachepics`/`menuplyr_pixels[4096]` keep the
  C's persistent-slot identity semantics: a repeat `Draw_CachePic(path)` call
  with the same path returns the SAME `QpicT` object (not a freshly parsed
  one), matching the C's `return &pic->pic` returning the same struct
  address every time. Unlike src/ref_soft/draw.ts's Draw_CachePic (which has
  no persistent cachepic_t table and re-parses through `zone.ts`'s
  `CacheUser` on every call), the GL version genuinely never reloads a
  path once cached, exactly as gl_draw.c's `Draw_CachePic` does.
- No `#ifdef PARANOID`/`#ifdef GLTEST` branches exist in gl_draw.c to drop
  (unlike draw.c); no `#if id386` branches either.

TESTS (test/ref_gl_draw.test.ts, SCOPE): every exported Draw_ and GL_ function
is exercised there per this unit's test brief; QGLRecording installed in
beforeAll/afterAll, glState/glDrawState/qglHolder fields restored.
*/

import { Sys_Error } from "../platform/sys";
import { Com_sprintf } from "../common/sprintf";
import { GLQUAKE_VERSION, LINUX_VERSION, VERSION, qw } from "../common/quakedef";
import { QpicT, SwapPic, W_GetLumpName, W_GetQpic } from "../common/wad";
import { COM_LoadHunkFile, COM_LoadTempFile, Q_strcasecmp, Q_strncasecmp } from "../common/common";
import { cls } from "../client/client";
import { scr_vrect } from "../client/screen_types";
// QW/client/gl_draw.c:27 `extern cvar_t crosshair, cl_crossx, cl_crossy, crosshaircolor;`
// -- crosshair/cl_crossx/cl_crossy already exported by view.ts; crosshaircolor
// is QW-only and NOT YET exported there (polled, still absent as of this
// writing) -- imported by name anyway, matching draw.ts's identical note.
import { cl_crossx, cl_crossy, crosshair, crosshaircolor } from "../client/view";
import { Hunk_FreeToLowMark, Hunk_LowMark } from "../common/zone";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../common/cmd";
import { Con_Printf } from "../client/console";
import { d_8to24table, vid } from "../client/vid";
import { hostBasepal } from "../common/host";
// host.c's `byte *host_basepal` is one global; this port has two holders for
// it -- src/common/host.ts on the WinQuake track, and src/qw/client/cl_main.ts
// on the qwcl one, whose own Host_Init is what loads gfx/palette.lmp there.
// Resolved exactly as src/ref_gl/gl_vid.ts and src/ref_gl/ref_gl.ts resolve it.
import { Sbar_Changed } from "../client/sbar";
import { cnttextures, glState, GltextureT, MAX_GLTEXTURES, TEXTURE0_SGIS } from "./glquake";
import {
  GL_ALPHA_TEST,
  GL_BACK,
  GL_BLEND,
  GL_COLOR_INDEX,
  GL_COLOR_INDEX8_EXT,
  GL_CULL_FACE,
  GL_DEPTH_TEST,
  GL_FRONT,
  GL_LINEAR,
  GL_LINEAR_MIPMAP_NEAREST,
  GL_MODELVIEW,
  GL_NEAREST,
  GL_NEAREST_MIPMAP_LINEAR,
  GL_NEAREST_MIPMAP_NEAREST,
  GL_LINEAR_MIPMAP_LINEAR,
  GL_PROJECTION,
  GL_MODULATE,
  GL_QUADS,
  GL_REPLACE,
  GL_RGBA,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_UNSIGNED_BYTE,
  qgl,
} from "./qgl";
import { d_15to8table, VID_Is8bit } from "./gl_vid";

// cvar_t gl_nobind = {"gl_nobind", "0"}; etc.
export const gl_nobind = new CvarT("gl_nobind", "0");
export const gl_max_size = new CvarT("gl_max_size", "1024");
export const gl_picmip = new CvarT("gl_picmip", "0");

// QW/client/gl_ngraph.c (new file, not in this unit's SCOPE) declares
// `extern byte *draw_chars;` itself to read the loaded charset for
// Draw_CharToNetGraph -- exported for that cross-file need even though this
// file's own header (above) predates gl_ngraph.c and calls it module-private.
export let draw_chars: Uint8Array | null = null; // 8*8 graphic characters
export let draw_disc: QpicT | null = null; // also used on sbar
let draw_backtile: QpicT | null = null;

let translate_texture = 0;
let char_texture = 0;
// QW/client/gl_draw.c addition -- crosshair dot texture (crosshair.value==2),
// no WinQuake counterpart. Only loaded/used under qw.active.
let cs_texture = 0;
const cs_data: Uint8Array = Uint8Array.from([
  0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xfe, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xfe, 0xff, 0xfe, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

// see file header RULING on GlpicT/picGl
class GlpicT {
  texnum = 0;
  sl = 0;
  tl = 0;
  sh = 0;
  th = 0;
}
const picGl = new Map<QpicT, GlpicT>();

// qpic_t *conback = (qpic_t *)&conback_buffer -- see file header
const conback = new QpicT();

// int gl_lightmap_format = 4; -- reassigned cross-module by gl_rsurf.c's
// GL_BuildLightmaps, so it is a holder field (glDrawState.gl_lightmap_format),
// not a plain let; see file header, updated to match gl_rsurf.ts's landed
// contract.
export const glDrawState: { gl_lightmap_format: number } = { gl_lightmap_format: 4 };
export const gl_solid_format = 3;
export const gl_alpha_format = 4;

let gl_filter_min = GL_LINEAR_MIPMAP_NEAREST;
let gl_filter_max = GL_LINEAR;

let texels = 0;

const gltextures: GltextureT[] = Array.from({ length: MAX_GLTEXTURES }, () => new GltextureT());
let numgltextures = 0;

/*
================
GL_Bind
================
*/
export function GL_Bind(texnum: number): void {
  let tex = texnum;
  if (gl_nobind.value) tex = char_texture;
  if (glState.currenttexture === tex) return;
  glState.currenttexture = tex;
  qgl().qglBindTexture(GL_TEXTURE_2D, tex);
}

/*
=============================================================================

  scrap allocation

  Allocate all the little status bar obejcts into a single texture
  to crutch up stupid hardware / drivers

=============================================================================
*/

// gl_draw.c's OWN BLOCK_WIDTH/BLOCK_HEIGHT (256), distinct from
// glquake.ts's lightmap-block BLOCK_WIDTH/BLOCK_HEIGHT (128) -- both stay
// file-local to their own translation unit, exactly as the two C #defines do.
const MAX_SCRAPS = 2;
const BLOCK_WIDTH = 256;
const BLOCK_HEIGHT = 256;

const scrap_allocated: Int32Array[] = Array.from({ length: MAX_SCRAPS }, () => new Int32Array(BLOCK_WIDTH));
const scrap_texels: Uint8Array[] = Array.from({ length: MAX_SCRAPS }, () => new Uint8Array(BLOCK_WIDTH * BLOCK_HEIGHT * 4));
let scrap_dirty = false;
let scrap_texnum = 0;

// returns a texture number and the position inside it
export function Scrap_AllocBlock(w: number, h: number): { texnum: number; x: number; y: number } {
  // see Scrap_Upload's note: QW only ever uploads/binds scrap texture 0.
  const scraps = qw.active ? 1 : MAX_SCRAPS;
  for (let texnum = 0; texnum < scraps; texnum++) {
    let best = BLOCK_HEIGHT;
    let x = 0;

    for (let i = 0; i < BLOCK_WIDTH - w; i++) {
      let best2 = 0;
      let j = 0;
      for (; j < w; j++) {
        if (scrap_allocated[texnum][i + j] >= best) break;
        if (scrap_allocated[texnum][i + j] > best2) best2 = scrap_allocated[texnum][i + j];
      }
      if (j === w) {
        // this is a valid spot
        x = i;
        best = best2;
      }
    }

    if (best + h > BLOCK_HEIGHT) continue;

    for (let i = 0; i < w; i++) scrap_allocated[texnum][x + i] = best + h;

    return { texnum, x, y: best };
  }

  return Sys_Error("Scrap_AllocBlock: full");
}

let scrap_uploads = 0;

export function Scrap_Upload(): void {
  scrap_uploads++;

  // QW/client/gl_draw.c redefines MAX_SCRAPS to 1 (one status-bar scrap
  // texture instead of two); this port keeps MAX_SCRAPS==2 (both blocks
  // still allocated, harmless) and only narrows the upload/alloc loop bound
  // under qw.active, since qw.active cannot gate a module-load-time const
  // (see this unit's report).
  const scraps = qw.active ? 1 : MAX_SCRAPS;
  for (let texnum = 0; texnum < scraps; texnum++) {
    GL_Bind(scrap_texnum + texnum);
    GL_Upload8(scrap_texels[texnum], BLOCK_WIDTH, BLOCK_HEIGHT, false, true);
  }
  scrap_dirty = false;
}

//=============================================================================
/* Support Routines */

class CachepicT {
  name = ""; // char name[MAX_QPATH]
  pic: QpicT = new QpicT();
}

const MAX_CACHED_PICS = 128;
const menu_cachepics: CachepicT[] = Array.from({ length: MAX_CACHED_PICS }, () => new CachepicT());
let menu_numcachepics = 0;

const menuplyr_pixels = new Uint8Array(4096);

let pic_texels = 0;
let pic_count = 0;

export function Draw_PicFromWad(name: string): QpicT | null {
  const p = W_GetQpic(name);
  const gl = new GlpicT();
  picGl.set(p, gl);

  // load little ones into the scrap
  if (p.width < 64 && p.height < 64) {
    const alloc = Scrap_AllocBlock(p.width, p.height);
    scrap_dirty = true;
    let k = 0;
    for (let i = 0; i < p.height; i++) {
      for (let j = 0; j < p.width; j++, k++) {
        scrap_texels[alloc.texnum][(alloc.y + i) * BLOCK_WIDTH + alloc.x + j] = p.data[k];
      }
    }
    const texnum = alloc.texnum + scrap_texnum;
    gl.texnum = texnum;
    gl.sl = (alloc.x + 0.01) / BLOCK_WIDTH;
    gl.sh = (alloc.x + p.width - 0.01) / BLOCK_WIDTH;
    gl.tl = (alloc.y + 0.01) / BLOCK_WIDTH;
    gl.th = (alloc.y + p.height - 0.01) / BLOCK_WIDTH;

    pic_count++;
    pic_texels += p.width * p.height;
  } else {
    gl.texnum = GL_LoadPicTexture(p);
    gl.sl = 0;
    gl.sh = 1;
    gl.tl = 0;
    gl.th = 1;
  }
  return p;
}

/*
================
Draw_CachePic
================
*/
export function Draw_CachePic(path: string): QpicT | null {
  let i = 0;
  for (; i < menu_numcachepics; i++) {
    if (path === menu_cachepics[i].name) return menu_cachepics[i].pic;
  }

  if (menu_numcachepics === MAX_CACHED_PICS) return Sys_Error("menu_numcachepics == MAX_CACHED_PICS");
  menu_numcachepics++;
  const pic = menu_cachepics[i];
  pic.name = path;

  // load the pic from disk
  const raw = COM_LoadTempFile(path);
  if (!raw) return Sys_Error("Draw_CachePic: failed to load %s", path);
  const dat = SwapPic(raw);

  // HACK HACK HACK --- we need to keep the bytes for
  // the translatable player picture just for the menu
  // configuration dialog
  if (path === "gfx/menuplyr.lmp") {
    menuplyr_pixels.set(dat.data.subarray(0, dat.width * dat.height));
  }

  pic.pic.width = dat.width;
  pic.pic.height = dat.height;

  const gl = new GlpicT();
  gl.texnum = GL_LoadPicTexture(dat);
  gl.sl = 0;
  gl.sh = 1;
  gl.tl = 0;
  gl.th = 1;
  picGl.set(pic.pic, gl);

  return pic.pic;
}

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
      if (chars[sourceOfs + x] !== 255) dest[d + x] = 0x60 + chars[sourceOfs + x];
    }
    sourceOfs += 128;
    d += 320;
  }
}

const modes: ReadonlyArray<{ name: string; minimize: number; maximize: number }> = [
  { name: "GL_NEAREST", minimize: GL_NEAREST, maximize: GL_NEAREST },
  { name: "GL_LINEAR", minimize: GL_LINEAR, maximize: GL_LINEAR },
  { name: "GL_NEAREST_MIPMAP_NEAREST", minimize: GL_NEAREST_MIPMAP_NEAREST, maximize: GL_NEAREST },
  { name: "GL_LINEAR_MIPMAP_NEAREST", minimize: GL_LINEAR_MIPMAP_NEAREST, maximize: GL_LINEAR },
  { name: "GL_NEAREST_MIPMAP_LINEAR", minimize: GL_NEAREST_MIPMAP_LINEAR, maximize: GL_NEAREST },
  { name: "GL_LINEAR_MIPMAP_LINEAR", minimize: GL_LINEAR_MIPMAP_LINEAR, maximize: GL_LINEAR },
];

/*
===============
Draw_TextureMode_f
===============
*/
export function Draw_TextureMode_f(): void {
  if (Cmd_Argc() === 1) {
    for (const m of modes) {
      if (gl_filter_min === m.minimize) {
        Con_Printf("%s\n", m.name);
        return;
      }
    }
    Con_Printf("current filter is unknown???\n");
    return;
  }

  let i = 0;
  for (; i < modes.length; i++) {
    if (Q_strcasecmp(modes[i].name, Cmd_Argv(1)) === 0) break;
  }
  if (i === modes.length) {
    Con_Printf("bad filter name\n");
    return;
  }

  gl_filter_min = modes[i].minimize;
  gl_filter_max = modes[i].maximize;

  // change all the existing mipmap texture objects
  for (let j = 0; j < numgltextures; j++) {
    const glt = gltextures[j];
    if (glt.mipmap) {
      GL_Bind(glt.texnum);
      qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_min);
      qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
    }
  }
}

/*
===============
Draw_Init
===============
*/
export function Draw_Init(): void {
  Cvar_RegisterVariable(gl_nobind);
  Cvar_RegisterVariable(gl_max_size);
  Cvar_RegisterVariable(gl_picmip);

  // 3dfx can only handle 256 wide textures -- QW/client/gl_draw.c checks for
  // "Mesa" instead of the WinQuake "Glide" substring match.
  if (
    Q_strncasecmp(glState.gl_renderer, "3dfx", 4) === 0 ||
    (qw.active ? Q_strncasecmp(glState.gl_renderer, "Mesa", 4) === 0 : glState.gl_renderer.includes("Glide"))
  ) {
    Cvar_Set("gl_max_size", "256");
  }

  Cmd_AddCommand("gl_texturemode", Draw_TextureMode_f);

  // load the console background and the charset
  // by hand, because we need to write the version
  // string into the background before turning
  // it into a texture
  const chars = W_GetLumpName("conchars");
  for (let i = 0; i < 256 * 64; i++) {
    if (chars[i] === 0) chars[i] = 255; // proper transparent color
  }
  draw_chars = chars;

  // now turn them into textures
  char_texture = GL_LoadTexture("charset", 128, 128, draw_chars, false, true);

  // QW/client/gl_draw.c addition: a second small texture for the
  // crosshair.value==2 colored-dot crosshair; no WinQuake counterpart.
  if (qw.active) {
    cs_texture = GL_LoadTexture("crosshair", 8, 8, cs_data, false, true);
  }

  const start = Hunk_LowMark();

  // QW/client/gl_draw.c reads gfx/conback.lmp with COM_LoadHunkFile instead
  // of WinQuake's COM_LoadTempFile (both then Hunk_FreeToLowMark it a few
  // lines below either way, so this is not observable).
  const cbRaw = qw.active ? COM_LoadHunkFile("gfx/conback.lmp") : COM_LoadTempFile("gfx/conback.lmp");
  if (!cbRaw) return Sys_Error("Couldn't load gfx/conback.lmp");
  const cb = SwapPic(cbRaw);

  // hack the version number directly into the pic
  const ver = qw.active
    ? Com_sprintf("%4.2f", VERSION)
    : // #if defined(__linux__) branch (RULING; see draw.ts's precedent for the same choice)
      Com_sprintf("(Linux %2.2f, gl %4.2f) %4.2f", LINUX_VERSION, GLQUAKE_VERSION, VERSION);
  const verDestBase = qw.active ? 320 + 320 * 186 - 11 - 8 * ver.length : 320 * 186 + 320 - 11 - 8 * ver.length;
  for (let x = 0; x < ver.length; x++) {
    Draw_CharToConback(ver.charCodeAt(x), cb.data, verDestBase + (x << 3));
  }

  // #if 0 scaled-console block dropped (see file header); #else branch:
  conback.width = cb.width;
  conback.height = cb.height;
  const ncdata = cb.data;

  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

  const gl = new GlpicT();
  gl.texnum = GL_LoadTexture("conback", conback.width, conback.height, ncdata, false, false);
  gl.sl = 0;
  gl.sh = 1;
  gl.tl = 0;
  gl.th = 1;
  picGl.set(conback, gl);
  // QW/client/gl_draw.c uses vid.conwidth/conheight here instead of
  // WinQuake's vid.width/height.
  conback.width = qw.active ? vid.conwidth : vid.width;
  conback.height = qw.active ? vid.conheight : vid.height;

  // free loaded console
  Hunk_FreeToLowMark(start);

  // save a texture slot for translated picture
  translate_texture = glState.texture_extension_number++;

  // save slots for scraps
  scrap_texnum = glState.texture_extension_number;
  glState.texture_extension_number += MAX_SCRAPS;

  //
  // get the other pics we need
  //
  draw_disc = Draw_PicFromWad("disc");
  draw_backtile = Draw_PicFromWad("backtile");
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

  if (num === 32) return; // space

  num &= 255;

  if (y <= -8) return; // totally off screen

  const row = num >> 4;
  const col = num & 15;

  const frow = row * 0.0625;
  const fcol = col * 0.0625;
  const size = 0.0625;

  GL_Bind(char_texture);

  const q = qgl();
  q.qglBegin(GL_QUADS);
  q.qglTexCoord2f(fcol, frow);
  q.qglVertex2f(x, y);
  q.qglTexCoord2f(fcol + size, frow);
  q.qglVertex2f(x + 8, y);
  q.qglTexCoord2f(fcol + size, frow + size);
  q.qglVertex2f(x + 8, y + 8);
  q.qglTexCoord2f(fcol, frow + size);
  q.qglVertex2f(x, y + 8);
  q.qglEnd();
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

QW/client/gl_draw.c addition (also draw.c) -- high-bit-set variant of
Draw_String, not in WinQuake's gl_draw.c/draw.h.
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
Draw_Crosshair

QW/client/gl_draw.c addition. WinQuake draws its crosshair inline at gl_screen.c's
SCR_UpdateScreen else-branch (ref_gl.ts's SCR_DrawCrosshair, out of this unit's
SCOPE); QW factors it out into this shared function instead, still called from
the same place. Ported here so ref_gl.ts's SCR_DrawCrosshair can call it under
qw.active -- see this unit's report for the exact one-line wiring that file
(out of SCOPE) still needs.
================
*/
export function Draw_Crosshair(): void {
  if (crosshair.value === 2) {
    const x = scr_vrect.x + ((scr_vrect.width / 2) | 0) - 3 + cl_crossx.value;
    const y = scr_vrect.y + ((scr_vrect.height / 2) | 0) - 3 + cl_crossy.value;

    const q = qgl();
    q.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    // `pColor = (unsigned char *) &d_8to24table[(byte) crosshaircolor.value];
    // glColor4ubv(pColor);` in the C -- qgl.ts has no qglColor4ub/qglColor4ubv
    // binding (out of this unit's SCOPE to add), so the same RGBA palette
    // entry is set via qglColor4f with its four bytes normalized to [0,1]:
    // numerically identical GL color state.
    const packed = d_8to24table[crosshaircolor.value & 255] >>> 0;
    q.qglColor4f(((packed >>> 0) & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, ((packed >>> 16) & 0xff) / 255, ((packed >>> 24) & 0xff) / 255);
    GL_Bind(cs_texture);

    q.qglBegin(GL_QUADS);
    q.qglTexCoord2f(0, 0);
    q.qglVertex2f(x - 4, y - 4);
    q.qglTexCoord2f(1, 0);
    q.qglVertex2f(x + 12, y - 4);
    q.qglTexCoord2f(1, 1);
    q.qglVertex2f(x + 12, y + 12);
    q.qglTexCoord2f(0, 1);
    q.qglVertex2f(x - 4, y + 12);
    q.qglEnd();

    q.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
  } else if (crosshair.value) {
    Draw_Character(
      scr_vrect.x + ((scr_vrect.width / 2) | 0) - 4 + cl_crossx.value,
      scr_vrect.y + ((scr_vrect.height / 2) | 0) - 4 + cl_crossy.value,
      "+".charCodeAt(0),
    );
  }
}

/*
================
Draw_SubPic

QW/client/gl_draw.c addition -- blits a sub-rectangle of a scrap-backed pic
(glpic_t's sl/tl/sh/th remapped to the requested sub-rectangle).
================
*/
export function Draw_SubPic(x: number, y: number, pic: QpicT, srcx: number, srcy: number, width: number, height: number): void {
  if (scrap_dirty) Scrap_Upload();
  const gl = picGl.get(pic);
  if (!gl) return; // Draw_PicFromWad/Draw_CachePic/Draw_Init not yet run for this pic

  const oldglwidth = gl.sh - gl.sl;
  const oldglheight = gl.th - gl.tl;

  const newsl = gl.sl + (srcx * oldglwidth) / pic.width;
  const newsh = newsl + (width * oldglwidth) / pic.width;

  const newtl = gl.tl + (srcy * oldglheight) / pic.height;
  const newth = newtl + (height * oldglheight) / pic.height;

  const q = qgl();
  q.qglColor4f(1, 1, 1, 1);
  GL_Bind(gl.texnum);
  q.qglBegin(GL_QUADS);
  q.qglTexCoord2f(newsl, newtl);
  q.qglVertex2f(x, y);
  q.qglTexCoord2f(newsh, newtl);
  q.qglVertex2f(x + width, y);
  q.qglTexCoord2f(newsh, newth);
  q.qglVertex2f(x + width, y + height);
  q.qglTexCoord2f(newsl, newth);
  q.qglVertex2f(x, y + height);
  q.qglEnd();
}

/*
================
Draw_DebugChar

Draws a single character directly to the upper right corner of the screen.
This is for debugging lockups by drawing different chars in different parts
of the code.
================
*/
export function Draw_DebugChar(_num: number): void {}

/*
=============
Draw_AlphaPic
=============
*/
export function Draw_AlphaPic(x: number, y: number, pic: QpicT, alpha: number): void {
  if (scrap_dirty) Scrap_Upload();
  const gl = picGl.get(pic);
  if (!gl) return; // Draw_PicFromWad/Draw_CachePic/Draw_Init not yet run for this pic

  const q = qgl();
  q.qglDisable(GL_ALPHA_TEST);
  q.qglEnable(GL_BLEND);
  // QW/client/gl_draw.c addition: `glCullFace(GL_FRONT);` (WinQuake has none here).
  if (qw.active) q.qglCullFace(GL_FRONT);
  q.qglColor4f(1, 1, 1, alpha);
  GL_Bind(gl.texnum);
  q.qglBegin(GL_QUADS);
  q.qglTexCoord2f(gl.sl, gl.tl);
  q.qglVertex2f(x, y);
  q.qglTexCoord2f(gl.sh, gl.tl);
  q.qglVertex2f(x + pic.width, y);
  q.qglTexCoord2f(gl.sh, gl.th);
  q.qglVertex2f(x + pic.width, y + pic.height);
  q.qglTexCoord2f(gl.sl, gl.th);
  q.qglVertex2f(x, y + pic.height);
  q.qglEnd();
  q.qglColor4f(1, 1, 1, 1);
  q.qglEnable(GL_ALPHA_TEST);
  q.qglDisable(GL_BLEND);
}

/*
=============
Draw_Pic
=============
*/
export function Draw_Pic(x: number, y: number, pic: QpicT): void {
  x = x | 0;
  y = y | 0;

  if (scrap_dirty) Scrap_Upload();
  const gl = picGl.get(pic);
  if (!gl) return; // Draw_PicFromWad/Draw_CachePic/Draw_Init not yet run for this pic

  const q = qgl();
  q.qglColor4f(1, 1, 1, 1);
  GL_Bind(gl.texnum);
  q.qglBegin(GL_QUADS);
  q.qglTexCoord2f(gl.sl, gl.tl);
  q.qglVertex2f(x, y);
  q.qglTexCoord2f(gl.sh, gl.tl);
  q.qglVertex2f(x + pic.width, y);
  q.qglTexCoord2f(gl.sh, gl.th);
  q.qglVertex2f(x + pic.width, y + pic.height);
  q.qglTexCoord2f(gl.sl, gl.th);
  q.qglVertex2f(x, y + pic.height);
  q.qglEnd();
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

  Draw_Pic(x, y, pic);
}

/*
=============
Draw_TransPicTranslate

Only used for the player color selection menu
=============
*/
export function Draw_TransPicTranslate(x: number, y: number, pic: QpicT, translation: Uint8Array): void {
  x = x | 0;
  y = y | 0;

  GL_Bind(translate_texture);

  // unsigned trans[64*64] -- see file header: `dest[u] = p` when p==255
  // assigns the raw int 255 into the 32-bit RGBA slot (R=255,G=B=A=0), not
  // an expanded opaque/transparent pixel; ported literally.
  const trans = new Uint32Array(64 * 64);
  for (let v = 0; v < 64; v++) {
    const srcRowBase = ((v * pic.height) >> 6) * pic.width;
    for (let u = 0; u < 64; u++) {
      const p = menuplyr_pixels[srcRowBase + ((u * pic.width) >> 6)];
      trans[v * 64 + u] = p === 255 ? p : d_8to24table[translation[p]];
    }
  }

  const q = qgl();
  q.qglTexImage2D(GL_TEXTURE_2D, 0, gl_alpha_format, 64, 64, 0, GL_RGBA, GL_UNSIGNED_BYTE, trans);

  q.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  q.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

  q.qglColor3f(1, 1, 1);
  q.qglBegin(GL_QUADS);
  q.qglTexCoord2f(0, 0);
  q.qglVertex2f(x, y);
  q.qglTexCoord2f(1, 0);
  q.qglVertex2f(x + pic.width, y);
  q.qglTexCoord2f(1, 1);
  q.qglVertex2f(x + pic.width, y + pic.height);
  q.qglTexCoord2f(0, 1);
  q.qglVertex2f(x, y + pic.height);
  q.qglEnd();
}

/*
================
Draw_ConsoleBackground

================
*/
export function Draw_ConsoleBackground(lines: number): void {
  lines = lines | 0;
  const y = (vid.height * 3) >> 2;

  if (lines > y) Draw_Pic(0, lines - vid.height, conback);
  else Draw_AlphaPic(0, lines - vid.height, conback, (1.2 * lines) / y);

  // QW/client/gl_draw.c addition: hack the version number directly onto the
  // screen (not into the pic, unlike draw.ts's soft path) when not
  // downloading. No WinQuake counterpart.
  if (qw.active && !cls.qw.download) {
    const ver = Com_sprintf("Linux (%4.2f) QuakeWorld", LINUX_VERSION); // #ifdef __linux__ branch, RULING per this unit's precedent
    const overlayY = lines - 14;
    const x = vid.conwidth - (ver.length * 8 + 11) - (((vid.conwidth * 8) / 320) | 0) * 7;
    for (let i = 0; i < ver.length; i++) {
      Draw_Character(x + i * 8, overlayY, ver.charCodeAt(i) | 0x80);
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

  const backtile = draw_backtile;
  if (!backtile) return; // Draw_Init not yet run
  const gl = picGl.get(backtile);
  if (!gl) return;

  const q = qgl();
  q.qglColor3f(1, 1, 1);
  // *(int *)draw_backtile->data reads the glpic_t overlay's texnum straight
  // out of the pic's data bytes in the C; this port keeps that association
  // in picGl instead (see file header), so gl.texnum is the same read.
  GL_Bind(gl.texnum);
  q.qglBegin(GL_QUADS);
  q.qglTexCoord2f(x / 64.0, y / 64.0);
  q.qglVertex2f(x, y);
  q.qglTexCoord2f((x + w) / 64.0, y / 64.0);
  q.qglVertex2f(x + w, y);
  q.qglTexCoord2f((x + w) / 64.0, (y + h) / 64.0);
  q.qglVertex2f(x + w, y + h);
  q.qglTexCoord2f(x / 64.0, (y + h) / 64.0);
  q.qglVertex2f(x, y + h);
  q.qglEnd();
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

  const q = qgl();
  q.qglDisable(GL_TEXTURE_2D);

  const pal = hostBasepal();
  if (pal) {
    q.qglColor3f(pal[c * 3] / 255.0, pal[c * 3 + 1] / 255.0, pal[c * 3 + 2] / 255.0);
  }

  q.qglBegin(GL_QUADS);
  q.qglVertex2f(x, y);
  q.qglVertex2f(x + w, y);
  q.qglVertex2f(x + w, y + h);
  q.qglVertex2f(x, y + h);
  q.qglEnd();
  q.qglColor3f(1, 1, 1);
  q.qglEnable(GL_TEXTURE_2D);
}

//=============================================================================

/*
================
Draw_FadeScreen

================
*/
export function Draw_FadeScreen(): void {
  const q = qgl();
  q.qglEnable(GL_BLEND);
  q.qglDisable(GL_TEXTURE_2D);
  q.qglColor4f(0, 0, 0, 0.8);
  q.qglBegin(GL_QUADS);

  q.qglVertex2f(0, 0);
  q.qglVertex2f(vid.width, 0);
  q.qglVertex2f(vid.width, vid.height);
  q.qglVertex2f(0, vid.height);

  q.qglEnd();
  q.qglColor4f(1, 1, 1, 1);
  q.qglEnable(GL_TEXTURE_2D);
  q.qglDisable(GL_BLEND);

  Sbar_Changed();
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
  if (!draw_disc) return;
  qgl().qglDrawBuffer(GL_FRONT);
  Draw_Pic(vid.width - 24, 0, draw_disc);
  qgl().qglDrawBuffer(GL_BACK);
}

/*
================
Draw_EndDisc

Erases the disc icon.
Call after completing any disc IO
================
*/
export function Draw_EndDisc(): void {}

/*
================
GL_Set2D

Setup as if the screen was 320*200
================
*/
export function GL_Set2D(): void {
  const q = qgl();
  q.qglViewport(glState.glx, glState.gly, glState.glwidth, glState.glheight);

  q.qglMatrixMode(GL_PROJECTION);
  q.qglLoadIdentity();
  q.qglOrtho(0, vid.width, vid.height, 0, -99999, 99999);

  q.qglMatrixMode(GL_MODELVIEW);
  q.qglLoadIdentity();

  q.qglDisable(GL_DEPTH_TEST);
  q.qglDisable(GL_CULL_FACE);
  q.qglDisable(GL_BLEND);
  q.qglEnable(GL_ALPHA_TEST);

  q.qglColor4f(1, 1, 1, 1);
}

//====================================================================

/*
================
GL_FindTexture
================
*/
export function GL_FindTexture(identifier: string): number {
  for (let i = 0; i < numgltextures; i++) {
    if (identifier === gltextures[i].identifier) return gltextures[i].texnum;
  }

  return -1;
}

/*
================
GL_ResampleTexture
================
*/
export function GL_ResampleTexture(inData: Uint32Array, inwidth: number, inheight: number, out: Uint32Array, outwidth: number, outheight: number): void {
  const fracstep = Math.floor((inwidth * 0x10000) / outwidth) >>> 0;
  let outRow = 0;
  for (let i = 0; i < outheight; i++, outRow += outwidth) {
    const inrow = inwidth * Math.floor((i * inheight) / outheight);
    let frac = fracstep >>> 1;
    for (let j = 0; j < outwidth; j += 4) {
      out[outRow + j] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
      out[outRow + j + 1] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
      out[outRow + j + 2] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
      out[outRow + j + 3] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
    }
  }
}

/*
================
GL_Resample8BitTexture -- JACK
================
*/
export function GL_Resample8BitTexture(inData: Uint8Array, inwidth: number, inheight: number, out: Uint8Array, outwidth: number, outheight: number): void {
  const fracstep = Math.floor((inwidth * 0x10000) / outwidth) >>> 0;
  let outRow = 0;
  for (let i = 0; i < outheight; i++, outRow += outwidth) {
    const inrow = inwidth * Math.floor((i * inheight) / outheight);
    let frac = fracstep >>> 1;
    for (let j = 0; j < outwidth; j += 4) {
      out[outRow + j] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
      out[outRow + j + 1] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
      out[outRow + j + 2] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
      out[outRow + j + 3] = inData[inrow + (frac >>> 16)];
      frac = (frac + fracstep) >>> 0;
    }
  }
}

/*
================
GL_MipMap

Operates in place, quartering the size of the texture
================
*/
export function GL_MipMap(data: Uint8Array, width: number, height: number): void {
  const w = width << 2;
  const h = height >> 1;
  let inOfs = 0;
  let outOfs = 0; // out = in
  for (let i = 0; i < h; i++, inOfs += w) {
    for (let j = 0; j < w; j += 8, outOfs += 4, inOfs += 8) {
      data[outOfs + 0] = (data[inOfs + 0] + data[inOfs + 4] + data[inOfs + w + 0] + data[inOfs + w + 4]) >> 2;
      data[outOfs + 1] = (data[inOfs + 1] + data[inOfs + 5] + data[inOfs + w + 1] + data[inOfs + w + 5]) >> 2;
      data[outOfs + 2] = (data[inOfs + 2] + data[inOfs + 6] + data[inOfs + w + 2] + data[inOfs + w + 6]) >> 2;
      data[outOfs + 3] = (data[inOfs + 3] + data[inOfs + 7] + data[inOfs + w + 3] + data[inOfs + w + 7]) >> 2;
    }
  }
}

/*
================
GL_MipMap8Bit

Mipping for 8 bit textures
================
*/
export function GL_MipMap8Bit(data: Uint8Array, width: number, height: number): void {
  const paletteBytes = new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength);

  const h = height >> 1;
  let inOfs = 0;
  let outOfs = 0;
  for (let i = 0; i < h; i++, inOfs += width) {
    for (let j = 0; j < width; j += 2, outOfs += 1, inOfs += 2) {
      const i0 = data[inOfs + 0] * 4;
      const i1 = data[inOfs + 1] * 4;
      const i2 = data[inOfs + width + 0] * 4;
      const i3 = data[inOfs + width + 1] * 4;

      const r = (paletteBytes[i0 + 0] + paletteBytes[i1 + 0] + paletteBytes[i2 + 0] + paletteBytes[i3 + 0]) >> 5;
      const g = (paletteBytes[i0 + 1] + paletteBytes[i1 + 1] + paletteBytes[i2 + 1] + paletteBytes[i3 + 1]) >> 5;
      const b = (paletteBytes[i0 + 2] + paletteBytes[i1 + 2] + paletteBytes[i2 + 2] + paletteBytes[i3 + 2]) >> 5;

      data[outOfs] = d_15to8table[(r << 0) + (g << 5) + (b << 10)];
    }
  }
}

// gl_draw.c's `static unsigned scaled[1024*512]` -- sizeof(scaled)/4 elements.
const UPLOAD32_SCRATCH_LIMIT = 1024 * 512;
// gl_draw.c's `static unsigned char scaled[1024*512]` -- sizeof(scaled) bytes.
const UPLOAD8_EXT_SCRATCH_LIMIT = 1024 * 512;

function setUploadTexParams(mipmap: boolean): void {
  const q = qgl();
  if (mipmap) {
    q.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_min);
    q.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
  } else {
    q.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_max);
    q.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
  }
}

/*
===============
GL_Upload32
===============
*/
export function GL_Upload32(data: Uint32Array, width: number, height: number, mipmap: boolean, alpha: boolean): void {
  let scaled_width = 1;
  while (scaled_width < width) scaled_width <<= 1;
  let scaled_height = 1;
  while (scaled_height < height) scaled_height <<= 1;

  scaled_width = scaled_width >> (gl_picmip.value | 0);
  scaled_height = scaled_height >> (gl_picmip.value | 0);

  if (scaled_width > gl_max_size.value) scaled_width = gl_max_size.value | 0;
  if (scaled_height > gl_max_size.value) scaled_height = gl_max_size.value | 0;

  if (scaled_width * scaled_height > UPLOAD32_SCRATCH_LIMIT) return Sys_Error("GL_LoadTexture: too big");

  const samples = alpha ? gl_alpha_format : gl_solid_format;

  texels += scaled_width * scaled_height;

  const q = qgl();
  let scaled: Uint32Array;

  if (scaled_width === width && scaled_height === height) {
    if (!mipmap) {
      q.qglTexImage2D(GL_TEXTURE_2D, 0, samples, scaled_width, scaled_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, data);
      setUploadTexParams(mipmap);
      return;
    }
    scaled = data.slice(0, width * height); // memcpy (scaled, data, width*height*4)
  } else {
    scaled = new Uint32Array(scaled_width * scaled_height);
    GL_ResampleTexture(data, width, height, scaled, scaled_width, scaled_height);
  }

  q.qglTexImage2D(GL_TEXTURE_2D, 0, samples, scaled_width, scaled_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, scaled);
  if (mipmap) {
    let miplevel = 0;
    const scaledBytes = new Uint8Array(scaled.buffer, scaled.byteOffset, scaled.byteLength);
    let sw = scaled_width;
    let sh = scaled_height;
    while (sw > 1 || sh > 1) {
      GL_MipMap(scaledBytes, sw, sh);
      sw >>= 1;
      sh >>= 1;
      if (sw < 1) sw = 1;
      if (sh < 1) sh = 1;
      miplevel++;
      q.qglTexImage2D(GL_TEXTURE_2D, miplevel, samples, sw, sh, 0, GL_RGBA, GL_UNSIGNED_BYTE, scaled);
    }
  }

  setUploadTexParams(mipmap);
}

/*
GL_Upload8_EXT -- the is8bit paletted-texture upload path
*/
export function GL_Upload8_EXT(data: Uint8Array, width: number, height: number, mipmap: boolean, _alpha: boolean): void {
  let scaled_width = 1;
  while (scaled_width < width) scaled_width <<= 1;
  let scaled_height = 1;
  while (scaled_height < height) scaled_height <<= 1;

  scaled_width = scaled_width >> (gl_picmip.value | 0);
  scaled_height = scaled_height >> (gl_picmip.value | 0);

  if (scaled_width > gl_max_size.value) scaled_width = gl_max_size.value | 0;
  if (scaled_height > gl_max_size.value) scaled_height = gl_max_size.value | 0;

  if (scaled_width * scaled_height > UPLOAD8_EXT_SCRATCH_LIMIT) return Sys_Error("GL_LoadTexture: too big");

  texels += scaled_width * scaled_height;

  const q = qgl();
  let scaled: Uint8Array;

  if (scaled_width === width && scaled_height === height) {
    if (!mipmap) {
      q.qglTexImage2D(GL_TEXTURE_2D, 0, GL_COLOR_INDEX8_EXT, scaled_width, scaled_height, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, data);
      setUploadTexParams(mipmap);
      return;
    }
    scaled = data.slice(0, width * height); // memcpy (scaled, data, width*height)
  } else {
    scaled = new Uint8Array(scaled_width * scaled_height);
    GL_Resample8BitTexture(data, width, height, scaled, scaled_width, scaled_height);
  }

  q.qglTexImage2D(GL_TEXTURE_2D, 0, GL_COLOR_INDEX8_EXT, scaled_width, scaled_height, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, scaled);
  if (mipmap) {
    let miplevel = 0;
    let sw = scaled_width;
    let sh = scaled_height;
    while (sw > 1 || sh > 1) {
      GL_MipMap8Bit(scaled, sw, sh);
      sw >>= 1;
      sh >>= 1;
      if (sw < 1) sw = 1;
      if (sh < 1) sh = 1;
      miplevel++;
      q.qglTexImage2D(GL_TEXTURE_2D, miplevel, GL_COLOR_INDEX8_EXT, sw, sh, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, scaled);
    }
  }

  setUploadTexParams(mipmap);
}

/*
===============
GL_Upload8
===============
*/
export function GL_Upload8(data: Uint8Array, width: number, height: number, mipmap: boolean, alpha: boolean): void {
  const s = width * height;
  const trans = new Uint32Array(s);

  // if there are no transparent pixels, make it a 3 component
  // texture even if it was specified as otherwise
  if (alpha) {
    let noalpha = true;
    for (let i = 0; i < s; i++) {
      const p = data[i];
      if (p === 255) noalpha = false;
      trans[i] = d_8to24table[p];
    }

    if (alpha && noalpha) alpha = false;
  } else {
    if (s & 3) return Sys_Error("GL_Upload8: s&3");
    for (let i = 0; i < s; i += 4) {
      trans[i] = d_8to24table[data[i]];
      trans[i + 1] = d_8to24table[data[i + 1]];
      trans[i + 2] = d_8to24table[data[i + 2]];
      trans[i + 3] = d_8to24table[data[i + 3]];
    }
  }

  if (VID_Is8bit() && !alpha && data !== scrap_texels[0]) {
    GL_Upload8_EXT(data, width, height, mipmap, alpha);
    return;
  }
  GL_Upload32(trans, width, height, mipmap, alpha);
}

/*
================
GL_LoadTexture
================
*/
export function GL_LoadTexture(identifier: string, width: number, height: number, data: Uint8Array, mipmap: boolean, alpha: boolean): number {
  let glt: GltextureT;

  // see if the texture is allready present
  if (identifier !== "") {
    let i = 0;
    for (; i < numgltextures; i++) {
      if (identifier === gltextures[i].identifier) {
        if (width !== gltextures[i].width || height !== gltextures[i].height) {
          return Sys_Error("GL_LoadTexture: cache mismatch");
        }
        return gltextures[i].texnum;
      }
    }
    // BUG, preserved verbatim from the C for WinQuake -- see file header: on
    // a miss the loop above leaves i === numgltextures, and this branch
    // reuses that slot WITHOUT incrementing numgltextures (only the
    // identifier === "" branch below does). QW/client/gl_draw.c FIXES this:
    // its GL_LoadTexture increments numgltextures unconditionally right
    // after the if/else, for both branches -- folded here as the one extra
    // increment the named-miss branch needs under qw.active; the
    // identifier === "" branch below already increments unconditionally in
    // both trees, so it is unchanged.
    glt = gltextures[i];
    if (qw.active) numgltextures++;
  } else {
    glt = gltextures[numgltextures];
    numgltextures++;
  }

  glt.identifier = identifier;
  glt.texnum = glState.texture_extension_number;
  glt.width = width;
  glt.height = height;
  glt.mipmap = mipmap;

  GL_Bind(glState.texture_extension_number);

  GL_Upload8(data, width, height, mipmap, alpha);

  glState.texture_extension_number++;

  return glState.texture_extension_number - 1;
}

/*
================
GL_LoadPicTexture
================
*/
export function GL_LoadPicTexture(pic: QpicT): number {
  return GL_LoadTexture("", pic.width, pic.height, pic.data, false, true);
}

/****************************************/

export function GL_SelectTexture(target: number): void {
  if (!glState.gl_mtexable) return;
  // QW/client/gl_draw.c wraps this call in `#ifndef __linux__ // no
  // multitexture under Linux yet` -- this port targets Linux only (PORTING.md:
  // "take the portable, non-asm path"), so under qw.active that call is
  // compiled out entirely, exactly as it would be for a real QW Linux build.
  if (!qw.active) qgl().qglSelectTextureSGIS?.(target);
  if (target === glState.oldtarget) return;
  cnttextures[glState.oldtarget - TEXTURE0_SGIS] = glState.currenttexture;
  glState.currenttexture = cnttextures[target - TEXTURE0_SGIS];
  glState.oldtarget = target;
}

/*
================
GL_ClearTextureCaches

This port's own addition (see ref_gl.ts's Renderer.Shutdown and
gl_rmisc.ts's GL_ClearTextureState, which calls this one), with no C
counterpart because GLQUAKE is a compile-time #define and no build of it ever
tears its refresh down: `vid_restart` here runs sdl.ts's SDLGL_Shutdown
(SDL_GL_DeleteContext plus SDL_DestroyWindow) and glimp.ts's GLimp_SetMode
then builds a brand new window and context, so every texture OBJECT the names
in gltextures[]/menu_cachepics[]/picGl refer to is gone. Left alone, the next
`vid_ref gl; vid_restart` would find "conchars" already in gltextures[] and
"gfx/box_tl.lmp" already in menu_cachepics[] and hand back the dead names
instead of uploading anything.

This half clears the caches and the texture ids gl_draw.c itself keeps
(char_texture, translate_texture, QW's cs_texture, scrap_texnum, and the
picGl side table that stands in for the C's glpic_t-over-qpic_t->data
overlay). gl_rmisc.ts's GL_ClearTextureState clears the rest of the renderer's
retained ids and is the function ref_gl.ts's Shutdown actually calls.

glState.texture_extension_number is deliberately NOT put back to its
glquake.ts initializer -- see GL_ClearTextureState's own comment for why.
gl_filter_min/gl_filter_max are not reset either: they are the live
`gl_texturemode` setting, not a texture id, and every reload reads them in
GL_Upload32/GL_Upload8, so keeping them is what carries the user's choice
across the restart.
================
*/
export function GL_ClearTextureCaches(): void {
  for (const glt of gltextures) {
    glt.identifier = "";
    glt.texnum = 0;
    glt.width = 0;
    glt.height = 0;
    glt.mipmap = false;
  }
  numgltextures = 0;
  texels = 0;

  for (const cp of menu_cachepics) cp.name = "";
  menu_numcachepics = 0;
  pic_texels = 0;
  pic_count = 0;

  // Every GlpicT here holds a texnum minted against the destroyed context,
  // and the QpicT keys are reachable from sbar.ts/screen.ts/menu.ts until
  // their own Sbar_Init/SCR_Init run again.
  picGl.clear();

  for (const a of scrap_allocated) a.fill(0);
  for (const t of scrap_texels) t.fill(0);
  scrap_dirty = false;
  scrap_texnum = 0;
  scrap_uploads = 0;

  // Draw_Init reassigns all four unconditionally; zeroing them means nothing
  // can bind a dead id in the window between Shutdown and the next Draw_Init.
  translate_texture = 0;
  char_texture = 0;
  cs_texture = 0;
  conback.width = 0;
  conback.height = 0;

  glState.currenttexture = -1; // GL_Bind's "already bound" short-circuit
  // GL_SelectTexture's own cache of the per-unit binding, glquake.ts's
  // initializers: a fresh context has neither unit bound to anything.
  glState.oldtarget = TEXTURE0_SGIS;
  cnttextures[0] = -1;
  cnttextures[1] = -1;
}
