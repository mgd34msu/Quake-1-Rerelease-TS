/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_rmisc.c (GNU GPL v2 or later).

r_misc.c -- the GL renderer's one-time init (cvars, commands, the 8x8 particle
dot texture, the 16 reserved player-skin texture names), the per-level R_NewMap
reset, the runtime player-skin colour translation cl_parse.c drives, and the
`envmap` / `timerefresh` console commands.

Deviations from PORTING.md / the C source:
- R_InitTextures is gl_rmisc.c's in the C, but this port files it with the
  renderer's model loader, exactly as the software side already does
  (src/ref_soft/model.ts owns r_main.c's R_InitTextures and ref_soft.ts imports
  it from there): it builds the `notexture` checkerboard the
  ModelLoaderHooks object must carry. It is DEFINED in src/ref_gl/gl_model.ts
  (U071) and RE-EXPORTED here, so U075's ref_gl.ts can keep importing it from
  the module its .c file maps to.
- gl_rmisc.c calls GL_BeginRendering / GL_EndRendering / VID_Is8bit, all
  gl_vidlinuxglx.c's (U075's src/ref_gl/gl_vid.ts). U075's ref_gl.ts imports
  THIS module, and gl_vid.ts sits inside the gl_vid -> gl_rmain -> gl_rsurf ->
  gl_vid cycle U075 documents, so importing them back here is not available.
  Ruling (unit brief): they are registrable hooks --
  `setGLBeginRendering`, `setGLEndRendering`, `setVIDIs8bit` -- which U075's
  ref_gl.ts sets once at renderer construction. With no hook set the two
  rendering hooks are no-ops and VID_Is8bit reads false (the 32-bit upload
  path, which is what a driver without GL_EXT_shared_texture_palette gives).
- `byte data[8][8][4]` in R_InitParticleTexture becomes a flat Uint8Array
  indexed `(y*8 + x)*4 + c`; `byte dottexture[8][8]` likewise, indexed
  `[x*8 + y]` at the one site that reads it (the C writes
  `data[y][x][3] = dottexture[x][y]*255`).
- `unsigned pixels[512*256]` in R_TranslatePlayerSkin is a Uint32Array; the
  8-bit branch's `byte *out2 = (byte *)pixels` is a Uint8Array VIEW over the
  same ArrayBuffer, which is that cast. `original`/`inrow` are indexes into the
  skin's `Uint8Array` rather than pointers (aliashdr_t's `texels[]` are direct
  Uint8Array references in gl_model_types.ts, not byte offsets).
- `unsigned scaled_width = gl_max_size.value < 512 ? gl_max_size.value : 512;`
  assigns a float cvar into an unsigned int, i.e. truncates; the `| 0` keeps
  that. `frac >>> 16` keeps the C's unsigned shift.
- R_TimeRefresh_f's `int startangle;` and `vrect_t vr;` locals are declared and
  never used in the C; they are dropped with no behaviour change.
- Dropped `#ifdef GLTEST`: R_Init's `Test_Init ()`. Dropped `#ifdef QUAKE2`:
  R_NewMap's `R_LoadSkys ()`. Dropped the `#if 0` block in
  R_TranslatePlayerSkin (the `byte translated[320*200]` + GL_Upload8 path the
  `#else` replaces).

QuakeWorld deltas (QW/client/gl_rmisc.c vs WinQuake/gl_rmisc.c), folded
under qw.active:
- R_Init registers `r_netgraph` (gl_rmain.ts, see that file's header) and
  calls `R_InitBubble()` (gl_rlight.ts). `netgraphtexture` (gl_ngraph.ts) is
  assigned a fresh texture id the same way `char_texture`/`translate_texture`
  are in gl_draw.ts (`texture_extension_number++`), one call after
  R_InitParticleTexture, matching gl_rmisc.c:216's placement.
- `playertextures` reserves `MAX_CLIENTS` (32, src/qw/protocol.ts) texture
  slots instead of WinQuake's fixed 16 (gl_rmain.c's R_Init, see that file's
  header).
- `gl_keeptjunctions`'s default is "1" under QW vs "0" under WinQuake (the
  cvar_t static initializer differs at compile time in the C; this port's
  CvarT is constructed once at module load before qw.active is necessarily
  set, so -- following the established idiom in src/common/cvar.ts/cmd.ts,
  which never bake qw.active into a top-level initializer -- the QW default
  is applied here as a runtime override right after registration, which is
  itself after Host_Init has set qw.active).
- R_TranslatePlayerSkin is QW's `cl.players[]`/`player_info_t` rewrite (skin
  files via Info_ValueForKey(userinfo,"skin"), Skin_Find/Skin_Cache, a
  296x194 `tinwidth`/`tinheight` real-model size vs a 320x200 skin-data size,
  and a `player_8bit_texels` fallback bitmap when no skin is cached) in place
  of WinQuake's `cl.scores[]`/paliashdr-texels translation. `Skin_Find`/
  `Skin_Cache` (src/qw/client/skin.ts) landed during this unit's run and are
  imported directly; `player_8bit_texels` is imported from ./gl_model (the
  model-loading unit's file, per QW/client/gl_model.c:1270's definition site)
  -- unverified against that unit's final export shape, since it is a
  concurrent unit's file this unit does not own. `player.userinfo`/color
  fields come from `cl.qw.players[playernum]` (`PlayerInfoT`, already
  landed). Skin_Cache's landed signature takes a non-null SkinT, so the
  qw.active branch below only calls it when `player.skin` is non-null after
  Skin_Find, falling back to `player_8bit_texels` otherwise -- the same
  observable branch the C's `Skin_Cache(...) != NULL` check produces.
- R_TimeRefresh_f's Sys_DoubleTime calls are this port's Sys_FloatTime
  (src/qw/client/cl_main.ts's header note already rules this); no change.
- No other functional delta found in R_NewMap; the `r_viewleaf` handling the
  unit brief flagged is byte-identical between the two trees.
*/

import { Cmd_AddCommand } from "../common/cmd";
import { Cvar_RegisterVariable, Cvar_SetValue } from "../common/cvar";
import { COM_StripExtension, COM_WriteFile, Q_atoi } from "../common/common";
import { Con_Printf } from "../client/console";
import { Sys_Error, Sys_FloatTime } from "../platform/sys";
import { Mod_Extradata, ModtypeT } from "../common/model";
import { cl, cl_entities } from "../client/client";
import { BOTTOM_RANGE, TOP_RANGE, r_refdef } from "../client/render";
import { d_8to24table } from "../client/vid";
import { qw } from "../common/quakedef";
import { MAX_CLIENTS } from "../qw/protocol";
import { Info_ValueForKey } from "../qw/common";
import { Skin_Cache, Skin_Find } from "../qw/client/skin";
import { player_8bit_texels } from "./gl_model";
import { R_InitBubble } from "./gl_rlight";
import { ngraphState } from "./gl_ngraph";
import { R_ClearParticles, R_InitParticles, R_ReadPointFile_f } from "../client/r_part";
import type * as QwRPartModule from "../qw/client/r_part";
import { d_lightstylevalue, glState, r_worldentity } from "./glquake";
import { AliashdrT } from "./gl_model_types";
import {
  GL_BACK,
  GL_FRONT,
  GL_LINEAR,
  GL_MODULATE,
  GL_RGBA,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_UNSIGNED_BYTE,
  qgl,
} from "./qgl";
import { GL_Bind, GL_ClearTextureCaches, GL_Upload8_EXT, gl_alpha_format, gl_max_size, gl_solid_format } from "./gl_draw";
import { GL_BuildLightmaps, GL_ClearLightmapState, GL_DisableMultitexture } from "./gl_rsurf";
import { glWarpState } from "./gl_warp";

// gl_rmisc.c's R_InitTextures, defined in gl_model.ts with the notexture it
// builds (see the header note); re-exported so this module still carries every
// name gl_rmisc.c does.
export { R_InitTextures } from "./gl_model";

// gl_vidlinuxglx.c entry points this file calls, registered by U075's ref_gl.ts
// to keep the import graph acyclic (see the header note).
let glBeginRenderingHook: (() => void) | null = null;
let glEndRenderingHook: (() => void) | null = null;
let vidIs8bitHook: (() => boolean) | null = null;

export function setGLBeginRendering(fn: (() => void) | null): void {
  glBeginRenderingHook = fn;
}

export function setGLEndRendering(fn: (() => void) | null): void {
  glEndRenderingHook = fn;
}

export function setVIDIs8bit(fn: (() => boolean) | null): void {
  vidIs8bitHook = fn;
}

function GL_BeginRendering(): void {
  glBeginRenderingHook?.();
}

function GL_EndRendering(): void {
  glEndRenderingHook?.();
}

function VID_Is8bit(): boolean {
  return vidIs8bitHook !== null ? vidIs8bitHook() : false;
}
import {
  R_RenderView,
  gl_affinemodels,
  gl_clear,
  gl_cull,
  gl_doubleeyes,
  gl_finish,
  gl_flashblend,
  gl_keeptjunctions,
  gl_nocolors,
  gl_playermip,
  gl_polyblend,
  gl_reporttjunctions,
  gl_smoothmodels,
  gl_texsort,
  r_drawentities,
  r_drawviewmodel,
  r_dynamic,
  r_fullbright,
  r_lightmap,
  r_mirroralpha,
  r_netgraph,
  r_norefresh,
  r_novis,
  r_shadows,
  r_speeds,
  r_wateralpha,
} from "./gl_rmain";

// prettier-ignore
export const dottexture: Uint8Array = new Uint8Array([
  0,1,1,0,0,0,0,0,
  1,1,1,1,0,0,0,0,
  1,1,1,1,0,0,0,0,
  0,1,1,0,0,0,0,0,
  0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,
]);

export function R_InitParticleTexture(): void {
  const data = new Uint8Array(8 * 8 * 4);

  //
  // particle texture
  //
  glState.particletexture = glState.texture_extension_number++;
  GL_Bind(glState.particletexture);

  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      data[(y * 8 + x) * 4 + 0] = 255;
      data[(y * 8 + x) * 4 + 1] = 255;
      data[(y * 8 + x) * 4 + 2] = 255;
      data[(y * 8 + x) * 4 + 3] = dottexture[x * 8 + y] * 255;
    }
  }
  qgl().qglTexImage2D(GL_TEXTURE_2D, 0, gl_alpha_format, 8, 8, 0, GL_RGBA, GL_UNSIGNED_BYTE, data);

  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);

  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
}

/*
===============
R_Envmap_f

Grab six views for environment mapping tests
===============
*/
export function R_Envmap_f(): void {
  const buffer = new Uint8Array(256 * 256 * 4);

  qgl().qglDrawBuffer(GL_FRONT);
  qgl().qglReadBuffer(GL_FRONT);
  glState.envmap = true;

  r_refdef.vrect.x = 0;
  r_refdef.vrect.y = 0;
  r_refdef.vrect.width = 256;
  r_refdef.vrect.height = 256;

  r_refdef.viewangles[0] = 0;
  r_refdef.viewangles[1] = 0;
  r_refdef.viewangles[2] = 0;
  GL_BeginRendering();
  R_RenderView();
  qgl().qglReadPixels(0, 0, 256, 256, GL_RGBA, GL_UNSIGNED_BYTE, buffer);
  COM_WriteFile("env0.rgb", buffer);

  r_refdef.viewangles[1] = 90;
  GL_BeginRendering();
  R_RenderView();
  qgl().qglReadPixels(0, 0, 256, 256, GL_RGBA, GL_UNSIGNED_BYTE, buffer);
  COM_WriteFile("env1.rgb", buffer);

  r_refdef.viewangles[1] = 180;
  GL_BeginRendering();
  R_RenderView();
  qgl().qglReadPixels(0, 0, 256, 256, GL_RGBA, GL_UNSIGNED_BYTE, buffer);
  COM_WriteFile("env2.rgb", buffer);

  r_refdef.viewangles[1] = 270;
  GL_BeginRendering();
  R_RenderView();
  qgl().qglReadPixels(0, 0, 256, 256, GL_RGBA, GL_UNSIGNED_BYTE, buffer);
  COM_WriteFile("env3.rgb", buffer);

  r_refdef.viewangles[0] = -90;
  r_refdef.viewangles[1] = 0;
  GL_BeginRendering();
  R_RenderView();
  qgl().qglReadPixels(0, 0, 256, 256, GL_RGBA, GL_UNSIGNED_BYTE, buffer);
  COM_WriteFile("env4.rgb", buffer);

  r_refdef.viewangles[0] = 90;
  r_refdef.viewangles[1] = 0;
  GL_BeginRendering();
  R_RenderView();
  qgl().qglReadPixels(0, 0, 256, 256, GL_RGBA, GL_UNSIGNED_BYTE, buffer);
  COM_WriteFile("env5.rgb", buffer);

  glState.envmap = false;
  qgl().qglDrawBuffer(GL_BACK);
  qgl().qglReadBuffer(GL_BACK);
  GL_EndRendering();
}


// QW/client/r_part.c is a wholesale-different file (see src/qw/client/r_part.ts's
// own Q023b ruling): its own particle pool, `host_frametime` where WinQuake's
// R_DrawParticles reads `cl.time - cl.oldtime`, and a literal 800 gravity.
// gl_rmisc.c is compiled once per tree and linked against the r_part.c of its own
// tree, so under qw.active the particle entry points below have to reach the QW
// module -- the pool QW's cl_tent.c/cl_ents.c fill is otherwise not the pool
// this renderer initializes, clears and draws. Resolved lazily with Bun's
// synchronous require() rather than a static import, the same mechanism
// src/ref_soft/r_alias.ts uses for src/qw/client/skin.ts.
function qwRPartMod(): typeof QwRPartModule {
  return require("../qw/client/r_part");
}

/*
===============
R_Init
===============
*/
export function R_Init(): void {
  Cmd_AddCommand("timerefresh", R_TimeRefresh_f);
  Cmd_AddCommand("envmap", R_Envmap_f);
  Cmd_AddCommand("pointfile", qw.active ? qwRPartMod().R_ReadPointFile_f : R_ReadPointFile_f);

  Cvar_RegisterVariable(r_norefresh);
  Cvar_RegisterVariable(r_lightmap);
  Cvar_RegisterVariable(r_fullbright);
  Cvar_RegisterVariable(r_drawentities);
  Cvar_RegisterVariable(r_drawviewmodel);
  Cvar_RegisterVariable(r_shadows);
  Cvar_RegisterVariable(r_mirroralpha);
  Cvar_RegisterVariable(r_wateralpha);
  Cvar_RegisterVariable(r_dynamic);
  Cvar_RegisterVariable(r_novis);
  Cvar_RegisterVariable(r_speeds);
  // QW/client/gl_rmisc.c / r_misc.c: r_netgraph (see gl_rmain.ts's header).
  if (qw.active) Cvar_RegisterVariable(r_netgraph);

  Cvar_RegisterVariable(gl_finish);
  Cvar_RegisterVariable(gl_clear);
  Cvar_RegisterVariable(gl_texsort);

  if (glState.gl_mtexable) Cvar_SetValue("gl_texsort", 0.0);

  Cvar_RegisterVariable(gl_cull);
  Cvar_RegisterVariable(gl_smoothmodels);
  Cvar_RegisterVariable(gl_affinemodels);
  Cvar_RegisterVariable(gl_polyblend);
  Cvar_RegisterVariable(gl_flashblend);
  Cvar_RegisterVariable(gl_playermip);
  Cvar_RegisterVariable(gl_nocolors);

  Cvar_RegisterVariable(gl_keeptjunctions);
  // QW/client/gl_rmain.c: gl_keeptjunctions defaults to 1, not 0 (see
  // gl_rmain.ts's header note on why this is a post-registration override
  // rather than a different construction-time default).
  if (qw.active) gl_keeptjunctions.value = 1;
  Cvar_RegisterVariable(gl_reporttjunctions);

  Cvar_RegisterVariable(gl_doubleeyes);

  if (qw.active) qwRPartMod().R_InitParticles();
  else R_InitParticles();
  R_InitParticleTexture();

  if (qw.active) {
    // QW/client/gl_rmisc.c:207 (see gl_rlight.ts's header note).
    R_InitBubble();
    // QW/client/gl_rmisc.c:216-218: netgraphtexture gets its own slot before
    // the playertextures reservation.
    ngraphState.texture = glState.texture_extension_number;
    glState.texture_extension_number++;
  }

  glState.playertextures = glState.texture_extension_number;
  // QW reserves MAX_CLIENTS (32) player-skin texture slots; WinQuake reserves
  // a fixed 16 (gl_rmain.c's R_Init, see gl_rmain.ts's header note).
  glState.texture_extension_number += qw.active ? MAX_CLIENTS : 16;
}

/*
===============
R_TranslatePlayerSkin

Translates a skin texture by the per-player color lookup
===============
*/
export function R_TranslatePlayerSkin(playernum: number): void {
  const translate = new Uint8Array(256);
  const translate32 = new Uint32Array(256);
  const pixels = new Uint32Array(512 * 256);
  let i: number;
  let j: number;

  GL_DisableMultitexture();

  if (qw.active) {
    // QW/client/gl_rmisc.c's full rewrite (see file header): cl.players[]
    // instead of cl.scores[], Skin_Find/Skin_Cache instead of the alias
    // model's own texels, a 296x194 real-model size distinct from the
    // 320x200 skin-data size, and a player_8bit_texels fallback bitmap.
    const player = cl.qw.players[playernum];
    if (!player.name) return;

    const skinKey = Info_ValueForKey(player.userinfo, "skin");
    const s = COM_StripExtension(skinKey);
    if (player.skin !== null && s.toLowerCase() === player.skin.name.toLowerCase()) player.skin = null;

    if (player.topcolor !== player._topcolor || player.bottomcolor !== player._bottomcolor || !player.skin) {
      player._topcolor = player.topcolor;
      player._bottomcolor = player.bottomcolor;

      let top = player.topcolor;
      let bottom = player.bottomcolor;
      top = top < 0 ? 0 : top > 13 ? 13 : top;
      bottom = bottom < 0 ? 0 : bottom > 13 ? 13 : bottom;
      top *= 16;
      bottom *= 16;

      for (i = 0; i < 256; i++) translate[i] = i;
      for (i = 0; i < 16; i++) {
        if (top < 128) translate[TOP_RANGE + i] = top + i;
        else translate[TOP_RANGE + i] = top + 15 - i;

        if (bottom < 128) translate[BOTTOM_RANGE + i] = bottom + i;
        else translate[BOTTOM_RANGE + i] = bottom + 15 - i;
      }

      //
      // locate the original skin pixels
      //
      const tinwidth = 296; // real model width
      const tinheight = 194;

      if (!player.skin) Skin_Find(player);
      let original: Uint8Array | null = player.skin !== null ? Skin_Cache(player.skin) : null;
      let inwidth: number;
      let inheight: number;
      if (original !== null) {
        // skin data width
        inwidth = 320;
        inheight = 200;
      } else {
        original = player_8bit_texels;
        inwidth = 296;
        inheight = 194;
      }

      // because this happens during gameplay, do it fast
      // instead of sending it through gl_upload 8
      GL_Bind(glState.playertextures + playernum);

      let scaled_width = (gl_max_size.value < 512 ? gl_max_size.value : 512) | 0;
      let scaled_height = (gl_max_size.value < 256 ? gl_max_size.value : 256) | 0;
      // allow users to crunch sizes down even more if they want
      scaled_width >>= gl_playermip.value | 0;
      scaled_height >>= gl_playermip.value | 0;

      let frac: number;
      let fracstep: number;
      let inrow: number;

      if (VID_Is8bit()) {
        // 8bit texture upload
        const out2 = new Uint8Array(pixels.buffer);
        pixels.fill(0);
        fracstep = ((tinwidth * 0x10000) / scaled_width) | 0;
        let out2Ofs = 0;
        for (i = 0; i < scaled_height; i++, out2Ofs += scaled_width) {
          inrow = inwidth * (((i * tinheight) / scaled_height) | 0);
          frac = fracstep >> 1;
          for (j = 0; j < scaled_width; j += 4) {
            out2[out2Ofs + j] = translate[original[inrow + (frac >>> 16)]];
            frac += fracstep;
            out2[out2Ofs + j + 1] = translate[original[inrow + (frac >>> 16)]];
            frac += fracstep;
            out2[out2Ofs + j + 2] = translate[original[inrow + (frac >>> 16)]];
            frac += fracstep;
            out2[out2Ofs + j + 3] = translate[original[inrow + (frac >>> 16)]];
            frac += fracstep;
          }
        }

        GL_Upload8_EXT(out2, scaled_width, scaled_height, false, false);
        return;
      }

      for (i = 0; i < 256; i++) translate32[i] = d_8to24table[translate[i]];

      let outOfs = 0;
      pixels.fill(0);
      fracstep = ((tinwidth * 0x10000) / scaled_width) | 0;
      for (i = 0; i < scaled_height; i++, outOfs += scaled_width) {
        inrow = inwidth * (((i * tinheight) / scaled_height) | 0);
        frac = fracstep >> 1;
        for (j = 0; j < scaled_width; j += 4) {
          pixels[outOfs + j] = translate32[original[inrow + (frac >>> 16)]];
          frac += fracstep;
          pixels[outOfs + j + 1] = translate32[original[inrow + (frac >>> 16)]];
          frac += fracstep;
          pixels[outOfs + j + 2] = translate32[original[inrow + (frac >>> 16)]];
          frac += fracstep;
          pixels[outOfs + j + 3] = translate32[original[inrow + (frac >>> 16)]];
          frac += fracstep;
        }
      }
      qgl().qglTexImage2D(GL_TEXTURE_2D, 0, gl_solid_format, scaled_width, scaled_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);

      qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
      qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    }
    return;
  }

  const top = cl.scores[playernum].colors & 0xf0;
  const bottom = (cl.scores[playernum].colors & 15) << 4;

  for (i = 0; i < 256; i++) translate[i] = i;

  for (i = 0; i < 16; i++) {
    if (top < 128)
      // the artists made some backwards ranges.  sigh.
      translate[TOP_RANGE + i] = top + i;
    else translate[TOP_RANGE + i] = top + 15 - i;

    if (bottom < 128) translate[BOTTOM_RANGE + i] = bottom + i;
    else translate[BOTTOM_RANGE + i] = bottom + 15 - i;
  }

  //
  // locate the original skin pixels
  //
  const currententity = cl_entities[1 + playernum];
  glState.currententity = currententity;
  const model = currententity.model;
  if (!model) return; // player doesn't have a model yet
  if (model.type !== ModtypeT.mod_alias) return; // only translate skins on alias models

  const extradata = Mod_Extradata(model);
  if (!(extradata instanceof AliashdrT)) Sys_Error("R_TranslatePlayerSkin: not an alias model");
  const paliashdr = extradata;
  const s = paliashdr.skinwidth * paliashdr.skinheight;
  let original: Uint8Array | null;
  if (currententity.skinnum < 0 || currententity.skinnum >= paliashdr.numskins) {
    Con_Printf("(%d): Invalid player skin #%d\n", playernum, currententity.skinnum);
    original = paliashdr.texels[0];
  } else original = paliashdr.texels[currententity.skinnum];
  if (s & 3) Sys_Error("R_TranslateSkin: s&3");
  if (original === null) Sys_Error("R_TranslateSkin: no skin texels");

  const inwidth = paliashdr.skinwidth;
  const inheight = paliashdr.skinheight;

  // because this happens during gameplay, do it fast
  // instead of sending it through gl_upload 8
  GL_Bind(glState.playertextures + playernum);

  let scaled_width = (gl_max_size.value < 512 ? gl_max_size.value : 512) | 0;
  let scaled_height = (gl_max_size.value < 256 ? gl_max_size.value : 256) | 0;

  // allow users to crunch sizes down even more if they want
  scaled_width >>= gl_playermip.value | 0;
  scaled_height >>= gl_playermip.value | 0;

  let frac: number;
  let fracstep: number;
  let inrow: number;

  if (VID_Is8bit()) {
    // 8bit texture upload
    const out2 = new Uint8Array(pixels.buffer);

    pixels.fill(0);
    fracstep = ((inwidth * 0x10000) / scaled_width) | 0;
    let out2Ofs = 0;
    for (i = 0; i < scaled_height; i++, out2Ofs += scaled_width) {
      inrow = inwidth * (((i * inheight) / scaled_height) | 0);
      frac = fracstep >> 1;
      for (j = 0; j < scaled_width; j += 4) {
        out2[out2Ofs + j] = translate[original[inrow + (frac >>> 16)]];
        frac += fracstep;
        out2[out2Ofs + j + 1] = translate[original[inrow + (frac >>> 16)]];
        frac += fracstep;
        out2[out2Ofs + j + 2] = translate[original[inrow + (frac >>> 16)]];
        frac += fracstep;
        out2[out2Ofs + j + 3] = translate[original[inrow + (frac >>> 16)]];
        frac += fracstep;
      }
    }

    GL_Upload8_EXT(out2, scaled_width, scaled_height, false, false);
    return;
  }

  for (i = 0; i < 256; i++) translate32[i] = d_8to24table[translate[i]];

  let outOfs = 0;
  fracstep = ((inwidth * 0x10000) / scaled_width) | 0;
  for (i = 0; i < scaled_height; i++, outOfs += scaled_width) {
    inrow = inwidth * (((i * inheight) / scaled_height) | 0);
    frac = fracstep >> 1;
    for (j = 0; j < scaled_width; j += 4) {
      pixels[outOfs + j] = translate32[original[inrow + (frac >>> 16)]];
      frac += fracstep;
      pixels[outOfs + j + 1] = translate32[original[inrow + (frac >>> 16)]];
      frac += fracstep;
      pixels[outOfs + j + 2] = translate32[original[inrow + (frac >>> 16)]];
      frac += fracstep;
      pixels[outOfs + j + 3] = translate32[original[inrow + (frac >>> 16)]];
      frac += fracstep;
    }
  }
  qgl().qglTexImage2D(GL_TEXTURE_2D, 0, gl_solid_format, scaled_width, scaled_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);

  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl().qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
}

/*
===============
R_NewMap
===============
*/
export function R_NewMap(): void {
  let i: number;

  for (i = 0; i < 256; i++) d_lightstylevalue[i] = 264; // normal light value

  r_worldentity.clear();
  r_worldentity.model = cl.worldmodel;

  // clear out efrags in case the level hasn't been reloaded
  // FIXME: is this one short?
  if (cl.worldmodel === null) Sys_Error("R_NewMap: no worldmodel");
  const worldmodel = cl.worldmodel;
  for (i = 0; i < worldmodel.numleafs; i++) worldmodel.leafs[i].efrags = null;

  glState.r_viewleaf = null;
  if (qw.active) qwRPartMod().R_ClearParticles();
  else R_ClearParticles();

  GL_BuildLightmaps();

  // identify sky texture
  glState.skytexturenum = -1;
  glState.mirrortexturenum = -1;
  const textures = worldmodel.textures;
  if (textures === null) return;
  for (i = 0; i < worldmodel.numtextures; i++) {
    const tex = textures[i];
    if (!tex) continue;
    if (tex.name.startsWith("sky")) glState.skytexturenum = i;
    if (tex.name.startsWith("window02_1")) glState.mirrortexturenum = i;
    tex.texturechain = null;
  }
}

/*
====================
R_TimeRefresh_f

For program optimization
====================
*/
export function R_TimeRefresh_f(): void {
  qgl().qglDrawBuffer(GL_FRONT);
  qgl().qglFinish();

  const start = Sys_FloatTime();
  for (let i = 0; i < 128; i++) {
    r_refdef.viewangles[1] = (i / 128.0) * 360.0;
    R_RenderView();
  }

  qgl().qglFinish();
  const stop = Sys_FloatTime();
  const time = stop - start;
  Con_Printf("%f seconds (%f fps)\n", time, 128 / time);

  qgl().qglDrawBuffer(GL_BACK);
  GL_EndRendering();
}

export function D_FlushCaches(): void {}

/*
===============
GL_ClearTextureState

This port's own addition (there is no C counterpart: GLQUAKE is a
compile-time #define, so no build of it ever tears its own refresh down).
Called from ref_gl.ts's Renderer.Shutdown, i.e. from vid.ts's
teardownActiveRenderer, on `vid_restart`, on a vid_ref switch, and on the
video menu's Apply.

THE CONTEXT REALLY IS DESTROYED. teardownActiveRenderer calls
glimpHolder.current.Shutdown() -> glimp.ts's GLimp_Shutdown -> sdl.ts's
SDLGL_Shutdown, which is SDL_GL_DeleteContext followed by SDLVID_Shutdown's
SDL_DestroyWindow; GLimp_SetMode then makes a new window and a new context.
Every texture object in the old context dies with it, so every texture id
this renderer minted is dangling afterwards and everything has to be
uploaded again.

The ids are not all in gl_draw.c's caches. GLQuake mints several ONCE and
keeps them in file-scope storage guarded by an `if (!x)`, precisely so a
level change does not re-mint them:

  gl_rsurf.c  GL_BuildLightmaps   if (!lightmap_textures) { lightmap_textures
                                  = texture_extension_number;
                                  texture_extension_number += MAX_LIGHTMAPS; }
  gl_warp.c   R_InitSky           if (!solidskytexture) solidskytexture =
                                  texture_extension_number++;   (and alphasky)

Those two guards are the whole defect this function exists to fix. With the
caches cleared and the counter rewound but lightmap_textures and
solidskytexture/alphaskytexture retained, the freshly uploaded world textures
were handed the very numbers the retained statics still pointed at, so
binding a wall sampled the lightmap atlas and binding the sky sampled
whatever had landed on the sky's old number.

The contract, which holds whether or not the context is recreated:

 1. Zero every retained texture id, so each `if (!x)` guard allocates a new
    one and the R_InitSky / GL_BuildLightmaps / Draw_Init / R_Init /
    R_InitParticleTexture / R_TranslatePlayerSkin upload that follows the
    guard writes into a name this context has actually been given. The ids
    R_Init assigns unconditionally (particletexture, netgraphtexture,
    playertextures) are zeroed too, so nothing can bind a dead id in the
    window between Shutdown and the next R_Init.
 2. Leave glState.texture_extension_number alone. Names stay monotonic
    across the restart, exactly as a single GLQuake process's do across
    level loads. Rewinding it to 1 is what makes a missed static fatal: a
    rewound counter re-issues numbers that something else may still be
    holding, while a monotonic one can never hand the same name out twice.
    Together with (1) that is collision-free in both directions -- with the
    context recreated nothing survives to collide with, and with the context
    kept (a future GLimp_SetMode that only resizes) a name issued after the
    restart is still one no live object has.
 3. Reset GL_Bind's `currenttexture` and GL_SelectTexture's cnttextures[]
    (in GL_ClearTextureCaches) so the first bind after the restart really
    issues its glBindTexture instead of short-circuiting on a cached id.

Draw_Init, SCR_Init, R_Init and Sbar_Init are re-run by vid.ts's
VID_CheckChanges_, and VID_RestartLevel's Cache_Flush/Mod_ClearAll/
Mod_ForName + R_NewMap re-upload the world, sky, lightmaps and model skins,
so every id zeroed here is re-minted before the next frame.
===============
*/
export function GL_ClearTextureState(): void {
  // gl_rsurf.c's GL_BuildLightmaps guard
  glState.lightmap_textures = 0;
  GL_ClearLightmapState();

  // gl_warp.c's R_InitSky guards
  glWarpState.solidskytexture = 0;
  glWarpState.alphaskytexture = 0;

  // gl_rmisc.c's R_InitParticleTexture / R_Init (netgraphtexture is QW's)
  glState.particletexture = 0;
  glState.playertextures = 0;
  ngraphState.texture = 0;

  // gl_rmisc.c's R_NewMap re-derives both from the reloaded worldmodel.
  glState.skytexturenum = 0;
  glState.mirrortexturenum = 0;

  // gl_draw.c's own ids and caches, plus currenttexture/cnttextures.
  GL_ClearTextureCaches();
}
