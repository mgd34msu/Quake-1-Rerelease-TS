/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/glquake.h (GNU GPL v2 or later).

glquake.h is the GL renderer's private header, the counterpart of
src/ref_soft/r_local.ts: quakedef.h:262 pulls it in for the whole GLQUAKE
build, and every gl_*.c reads its constants, shared types and globals from
here. This module is that header, so U071-U075 (gl_model, gl_rmain/gl_rmisc/
gl_rlight/gl_refrag, gl_rsurf/gl_warp/gl_mesh, gl_draw/gl_test and the GL
screen seam) import their shared state from one place.

glquake2.h in the same directory is a stale variant of this header (Win32
include paths, an extra `modulate` argument on GL_Upload8/GL_Upload32/
GL_LoadTexture, `gl_fogblend`, `MAXALIASVERTS 2000`, and no multitexture
block). No .c file includes it -- `#include "glquake.h"` in quakedef.h:262 is
the only include of either -- so it is not ported.

OWNERSHIP: which C file defines each global/cvar this header only declares,
and which port unit therefore owns it.

  gl_rmain.c (U072):
    r_worldentity, r_cache_thrash, modelorg, r_entorigin, currententity,
    r_visframecount, r_framecount, frustum[4], c_brush_polys, c_alias_polys,
    envmap, currenttexture, cnttextures[2], particletexture, playertextures,
    mirrortexturenum, mirror, mirror_plane, vup/vpn/vright/r_origin,
    r_world_matrix[16], r_base_world_matrix[16], r_refdef, r_viewleaf,
    r_oldviewleaf, r_notexture_mip, d_lightstylevalue[256], and the cvars
    r_norefresh r_drawentities r_drawviewmodel r_speeds r_fullbright
    r_lightmap r_shadows r_mirroralpha r_wateralpha r_dynamic r_novis
    gl_finish gl_clear gl_cull gl_texsort gl_smoothmodels gl_affinemodels
    gl_polyblend gl_flashblend gl_playermip gl_nocolors gl_keeptjunctions
    gl_reporttjunctions gl_doubleeyes.
    (gl_rmisc.c's R_Init is what Cvar_RegisterVariable's all of them.)
  gl_draw.c (U074):
    gl_nobind, gl_max_size, gl_picmip cvars; gltextures[MAX_GLTEXTURES],
    numgltextures, texels, draw_chars, translate_texture, char_texture,
    gl_filter_min, gl_filter_max, gl_lightmap_format, gl_solid_format,
    gl_alpha_format, the scrap_* block, GL_SelectTexture's static
    `oldtarget`.
  gl_rsurf.c (U073):
    skytexturenum (a tentative definition in both gl_rsurf.c and gl_warp.c;
    the C linker merges them into one), lightmap_bytes, lightmap_textures,
    blocklights[18*18], active_lightmaps, lightmap_polys[MAX_LIGHTMAPS],
    lightmap_modified[], lightmap_rectchange[], allocated[][BLOCK_WIDTH],
    lightmaps[], skychain, waterchain, qglMTexCoord2fSGIS/
    qglSelectTextureSGIS (the two function pointers -- QGL members here),
    mtexenabled, currentmodel, nColinElim.
  gl_warp.c (U073):
    solidskytexture, alphaskytexture, speedscale, warpface, skymins/skymaxs,
    st_to_vec/vec_to_st, skytexorder, c_sky, turbsin (gl_warp_sin.ts).
  gl_mesh.c (U073):
    commands[8192], numcommands, vertexorder[8192], numorder, used[8192],
    allverts/alltris, stripverts[128]/striptris[128]/stripcount,
    aliasmodel, paliashdr.
  gl_model.c (U071):
    gl_subdivide_size cvar; loadmodel, mod_known, pheader,
    stverts[MAXALIASVERTS], triangles[MAXALIASTRIS],
    poseverts[MAXALIASFRAMES].
  gl_rlight.c (U072): r_dlightframecount, lightplane, lightspot.
  gl_refrag.c (U072): r_addent, lastlink, r_pefragtopnode.
  gl_screen.c (U075 GL screen seam):
    glx, gly, glwidth, glheight, gl_triplebuffer cvar (the scr_* cvars and
    the rest of gl_screen.c's globals are screen.ts's, already landed in
    U051).
  gl_vidlinuxglx.c (U075 GL BeginFrame/EndFrame seam):
    texture_extension_number, texture_mode, gldepthmin, gldepthmax,
    gl_mtexable, gl_vendor/gl_renderer/gl_version/gl_extensions,
    gl_ztrick cvar, vid_mode cvar, is8bit, isPermedia.

Deviations from PORTING.md / the C source:
- glquake.h externs three cvars no GLQUAKE translation unit defines --
  `r_drawworld`, `r_waterwarp`, `gl_poly` (leftovers from r_local.h, whose
  GLQUAKE-side replacement this header is). They are dropped: a `cvar_t`
  here with no definer would be a cvar this port has and the C does not.
- glquake.h also carries verbatim copies of r_local.h's `surfcache_t` and
  `drawsurf_t` (both referencing the software-only `pixel_t`/`fixed8_t`) and
  of `particle_t`/`ptype_t`. No gl_*.c reads surfcache_t or drawsurf_t, so
  they are dropped for the same reason; particle_t/ptype_t are render.ts's
  (`ParticleT`/`PtypeT`) and are re-exported below rather than redeclared.
- `refdef_t r_refdef` and `vup/vpn/vright/r_origin` are declared here and
  defined in gl_rmain.c, but this port's renderer seam already owns them in
  src/client/render.ts (PORTING.md's render.h row). Re-exported, not
  redeclared -- the same thing r_local.ts does on the software side.
- PORTING.md's globals rule splits this header's `extern` block two ways, as
  src/ref_soft/r_shared.ts already does for the software renderer: globals
  the C REASSIGNS (scalars, pointers) become fields on the one exported
  `glState` holder; globals the C only mutates in place (arrays, structs)
  become exported `const` singletons. `glState` is deliberately SEPARATE from
  ref_soft's `rState`: the two renderers are separate translation units in
  C and share no storage.
- `gltexture_t` and `MAX_GLTEXTURES` are gl_draw.c-local in the C, not part
  of glquake.h. They are hoisted here because U074's gl_draw.ts, the GL
  model loader and this unit's tests all need the shape, and because
  glquake.h is where every other GL-wide type in this port lives.
- glquake.h's `#ifdef _WIN32` blocks (windows.h, the texture-object
  extension typedefs ARETEXRESFUNCPTR/BINDTEXFUNCPTR/DELTEXFUNCPTR/
  GENTEXFUNCPTR/ISTEXFUNCPTR/PRIORTEXFUNCPTR/TEXSUBIMAGEPTR with their
  bindTexFunc/delTexFunc/TexSubImage2DFunc pointers, and the four `PROC
  gl*PointerEXT` externs) are dropped along with the `#pragma warning`
  lines and the `#ifndef _WIN32 #define APIENTRY` shim, per PORTING.md's
  "take the portable, non-asm path". The `*PointerEXT` family survives as
  QGL members in qgl.ts, per PORTING.md's ref_gl mapping row.
- `lpMTexFUNC`/`lpSelTexFUNC` (the two GL extension function-pointer
  typedefs) and the GL_Upload32/GL_Upload8/GL_LoadTexture/GL_FindTexture/GL_Bind/
  GL_DisableMultitexture/GL_EnableMultitexture/R_TimeRefresh_f/
  R_ReadPointFile_f/R_TextureAnimation/R_TranslatePlayerSkin/
  GL_BeginRendering/GL_EndRendering prototypes are not reproduced: TS has no
  forward declarations, and each function is exported by the module that
  defines it (U071-U075).
*/

import { MplaneT, type Vec3, vec3 } from "../common/mathlib";
import type { MleafT, MsurfaceT, TextureT } from "../common/model";
import { EntityT } from "../client/render";
import { GlpolyT } from "./gl_model_types";
import { GL_LINEAR } from "./qgl";

export { EntityT, ParticleT, PtypeT, RefdefT, r_refdef, r_origin, vpn, vright, vup } from "../client/render";

// gl_model.h's, re-exported here because glquake.h is what the gl_*.c tree
// includes: BuildSurfaceDisplayList/SubdividePolygon build GlpolyT, and
// gl_rsurf.c/gl_warp.c/gl_rmain.c walk it.
export { GlpolyT, VERTEXSIZE, MAX_SKINS } from "./gl_model_types";

// gl_rmain.c:275's SHADEDOT_QUANT and the anorm_dots.h table it indexes.
// anorm_dots.h is filed under src/ref_soft per PORTING.md's file table, but
// gl_rmain.c is the only .c in the tree that reads it; re-exported here so
// no gl_*.ts has to reach into the other renderer's directory.
export { SHADEDOT_QUANT, ANORM_DOTS_ROW, r_avertexnormal_dots } from "../ref_soft/anorm_dots";

// r_local.h -- private refresh defs

export const ALIAS_BASE_SIZE_RATIO = 1.0 / 11.0;
// normalizing factor so player model works out to about
//  1 pixel per triangle

export const MAX_LBM_HEIGHT = 480;

export const TILE_SIZE = 128; // size of textures generated by R_GenTiledSurf

export const SKYSHIFT = 7;
export const SKYSIZE = 1 << SKYSHIFT;
export const SKYMASK = SKYSIZE - 1;

export const BACKFACE_EPSILON = 0.01;

// Multitexture
export const TEXTURE0_SGIS = 0x835e;
export const TEXTURE1_SGIS = 0x835f;

// gl_draw.c's texture table (see the header note on why it lives here).
export const MAX_GLTEXTURES = 1024;

export class GltextureT {
  texnum = 0;
  identifier = "";
  width = 0;
  height = 0;
  mipmap = false;
}

// gl_rsurf.c's lightmap block dimensions. gl_draw.c has its own, unrelated
// BLOCK_WIDTH/BLOCK_HEIGHT of 256 for the scrap atlas; those stay private to
// gl_draw.ts, exactly as the two file-scope #defines stay private to their
// translation units in the C.
export const MAX_LIGHTMAPS = 64;
export const BLOCK_WIDTH = 128;
export const BLOCK_HEIGHT = 128;

// gl_vidnt.c:104's `glvert_t glv`, the GL_EXT_vertex_array staging vertex.
export class GlvertT {
  x = 0;
  y = 0;
  z = 0;
  s = 0;
  t = 0;
  r = 0;
  g = 0;
  b = 0;
}

export const glv = new GlvertT();

//====================================================

export const r_worldentity = new EntityT();

export const modelorg: Vec3 = vec3();
export const r_entorigin: Vec3 = vec3();

export const frustum: [MplaneT, MplaneT, MplaneT, MplaneT] = [new MplaneT(), new MplaneT(), new MplaneT(), new MplaneT()];

export const cnttextures: Int32Array = new Int32Array([-1, -1]); // cached

export const r_world_matrix: Float32Array = new Float32Array(16);
export const r_base_world_matrix: Float32Array = new Float32Array(16);

export const d_lightstylevalue: Int32Array = new Int32Array(256); // 8.8 fraction of base light value

// Every glquake.h global the C reassigns rather than mutating in place.
// SEPARATE from src/ref_soft/r_shared.ts's rState -- see the header note.
export type GlStateT = {
  // gl_rmain.c
  r_cache_thrash: boolean; // compatability
  currententity: EntityT | null;
  r_visframecount: number; // bumped when going to a new PVS
  r_framecount: number; // used for dlight push checking
  c_brush_polys: number;
  c_alias_polys: number;
  envmap: boolean; // true during envmap command capture
  currenttexture: number; // to avoid unnecessary texture sets
  particletexture: number; // little dot for particles
  playertextures: number; // up to 16 color translated skins
  mirrortexturenum: number; // quake texturenum, not gltexturenum
  mirror: boolean;
  mirror_plane: MplaneT | null;
  r_viewleaf: MleafT | null;
  r_oldviewleaf: MleafT | null;
  r_notexture_mip: TextureT | null;

  // gl_rsurf.c / gl_warp.c
  skytexturenum: number; // index in cl.loadmodel, not gl texture object
  lightmap_textures: number;

  // gl_draw.c
  oldtarget: number; // GL_SelectTexture's static

  // gl_vidlinuxglx.c (U075's GL BeginFrame/EndFrame seam)
  texture_extension_number: number;
  texture_mode: number;
  gldepthmin: number;
  gldepthmax: number;
  gl_mtexable: boolean;
  gl_vendor: string;
  gl_renderer: string;
  gl_version: string;
  gl_extensions: string;

  // gl_screen.c (U075's GL screen seam)
  glx: number;
  gly: number;
  glwidth: number;
  glheight: number;
};

export const glState: GlStateT = {
  r_cache_thrash: false,
  currententity: null,
  r_visframecount: 0,
  r_framecount: 0,
  c_brush_polys: 0,
  c_alias_polys: 0,
  envmap: false,
  currenttexture: -1,
  particletexture: 0,
  playertextures: 0,
  mirrortexturenum: 0,
  mirror: false,
  mirror_plane: null,
  r_viewleaf: null,
  r_oldviewleaf: null,
  r_notexture_mip: null,

  skytexturenum: 0,
  lightmap_textures: 0,

  oldtarget: TEXTURE0_SGIS,

  texture_extension_number: 1,
  // gl_vidlinuxglx.c:86 `int texture_mode = GL_LINEAR;`
  texture_mode: GL_LINEAR,
  gldepthmin: 0,
  gldepthmax: 0,
  gl_mtexable: false,
  gl_vendor: "",
  gl_renderer: "",
  gl_version: "",
  gl_extensions: "",

  glx: 0,
  gly: 0,
  glwidth: 0,
  glheight: 0,
};

// src/common/model.ts types msurface_t's `glpoly_t *polys` as `unknown`,
// because glpoly_t is renderer-private and model.ts is shared with the
// server and the software renderer. These narrow it back out with
// `instanceof` (no `as` cast, per PORTING.md's type discipline); every
// gl_*.ts surface walk goes through them.
export function surfPolys(surf: MsurfaceT): GlpolyT | null {
  return surf.polys instanceof GlpolyT ? surf.polys : null;
}

export function setSurfPolys(surf: MsurfaceT, poly: GlpolyT | null): void {
  surf.polys = poly;
}
