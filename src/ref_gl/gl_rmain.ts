/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/gl_rmain.c (GNU GPL v2 or later), plus two GLQUAKE-only
bodies that belong to gl_rmain.c's storage and are ruled into this module by
the unit brief:
  - r_part.c's three `#ifdef GLQUAKE` halves of R_DrawParticles (the prologue,
    the per-particle triangle, the epilogue). PORTING.md's renderer seam turns
    them into D_StartParticles / D_DrawParticle / D_EndParticles, and
    src/client/r_part.ts calls them through `getRenderer()`.
  - view.c's `#ifdef GLQUAKE` V_CalcBlend and the `float v_blend[4]` it fills.
    v_blend has exactly two readers -- that function and R_PolyBlend below --
    and render.ts's GLQUAKE-site table puts both inside src/ref_gl. U075's
    Renderer.V_CalcBlend delegates to the V_CalcBlend exported here.

r_main.c -- the GL renderer's frame driver: the frustum, the modelview/
projection setup, entity drawing (alias models off gl_mesh.c's display-list
commands, sprites), the view model, the polyblend, the mirror pass and the PVS
leaf marking.

Deviations from PORTING.md / the C source:
- R_MarkLeaves is defined in gl_rsurf.c (gl_rmain.c:74 only forward-declares
  it); this module imports it from ./gl_rsurf for its R_RenderScene call and
  does not define its own copy.
- gl_rmain.c's `float *shadedots`, `float shadelight, ambientlight` and `int
  lastposenum` are file-scope globals the C REASSIGNS every frame, and
  glquake.ts's `glState` does not carry them (glquake.h does not declare them:
  they are gl_rmain.c-private). PORTING.md's globals rule gives them the
  "small exported holder" shape instead: `rmainState`. `shadevector` is
  mutated in place, so it stays an exported `const` vec3.
- `shadedots` is `r_avertexnormal_dots[row]`, a `float *` into a
  [SHADEDOT_QUANT][256] table. anorm_dots.ts holds that table flat, so a row
  is `subarray(row * ANORM_DOTS_ROW, (row + 1) * ANORM_DOTS_ROW)` -- a view
  over the same storage, exactly what the C's row pointer is.
- aliashdr_t's `commands` is an Int32Array here (gl_model_types.ts), and
  gl_mesh.c stores the texture coordinates into it as raw float bits
  (`*(float *)&commands[numcommands++] = s`). GL_DrawAliasFrame therefore
  builds a Float32Array VIEW over the same ArrayBuffer
  (`new Float32Array(order.buffer, order.byteOffset, order.length)`) and reads
  the two texcoord slots through it, which is the C's `((float *)order)[0]`
  aliasing with no reinterpret cast.
- `glColor3ubv ((byte *)&d_8to24table[(int)p->color])` (r_part.c's GL half) has
  no QGL member: glColor3ubv is not in qgl.ts's table. GL defines the ubyte
  form as the float form scaled by 1/255, so the call becomes
  `qglColor3f(r/255, g/255, b/255)` off the same packed d_8to24table entry
  (`(255<<24) | r | (g<<8) | (b<<16)`, per src/platform/vid.ts's VID_SetPalette).
- `up`/`right` in R_DrawParticles are locals that live across the whole
  particle loop. The seam splits that loop's prologue, body and epilogue into
  three methods, so they become the module-private `particleUp`/`particleRight`
  vectors D_StartParticles fills.
- `i = currententity - cl_entities;` is pointer subtraction against the
  cl_entities array. It becomes `cl_entities.indexOf(...)`, which returns -1
  for an entity that is not in that array (cl.viewent, the mirror's temporary)
  where the C computes an out-of-range offset; both fail the `i >= 1 && i <=
  cl.maxclients` test the value exists for.
- `msprite_t *psprite = currententity->model->cache.data;` reads the cache
  slot directly. `CacheUser<RendererModelData>.data` is `unknown`, so an
  `instanceof MspriteT` narrowing stands in for the C's implicit `void *`
  conversion; likewise `instanceof AliashdrT` for Mod_Extradata's result.
- `static int trickframe` inside R_Clear becomes a module-private `let` with
  the C's zero initializer.
- `byte solid[4096]` inside R_MarkLeaves is a function-scope array the C
  refills every call; it becomes a module-private Uint8Array of the same size
  (only the first `(numleafs+7)>>3` bytes are ever written or read, as in C).
- R_SetupGL's `glx/gly/glwidth/glheight` are gl_vidlinuxglx.c/gl_screen.c
  globals; they live on `glState` (glquake.ts) and are read from there.
- `gl_ztrick` is externed by gl_rmain.c and DEFINED by gl_vidlinuxglx.c
  (U075's src/ref_gl/gl_vid.ts). Defining it there and importing it here would
  close an import cycle (gl_vid.ts -> gl_rmain.ts -> gl_rsurf.ts -> gl_vid.ts,
  for `isPermedia`), so the unit brief rules the cvar_t is defined HERE, where
  its only reader (R_Clear) is. U075's ref_gl.ts imports it from here for the
  one `Cvar_RegisterVariable (&gl_ztrick)` line gl_vidlinuxglx.c's VID_Init
  has -- gl_rmisc.c's R_Init does not register it.
- `gl_doubleeyes`'s cvar NAME is "gl_doubleeys" in the C (gl_rmain.c:99, a
  shipped typo). Kept exactly as the original.
- The `GLfloat colors[4]` local in R_RenderView exists only for the
  commented-out "Experimental silly looking fog" block; the block stays a
  comment and the local is dropped with it.
- Dropped `#ifdef GLTEST`: R_RenderScene's `Test_Draw ()`.

QuakeWorld deltas (QW/client/gl_rmain.c vs WinQuake/gl_rmain.c), folded under
qw.active:
- `r_netgraph` cvar: NOT declared here. r_main.c and gl_rmain.c each declare
  it with the same initializer, and src/qw/client/screen.ts (gl_screen.c's
  SCR_UpdateScreen) has to read it from outside both renderers, so it lives
  in src/client/render.ts's shared-cvar block with r_fullbright and friends
  and is re-exported here under its C name. gl_rmisc.ts's R_Init registers
  it under qw.active. gl_rmain.c itself never calls R_NetGraph -- the GL
  call site is gl_screen.c:1145, reached through the optional
  `Renderer.R_NetGraph` member ref_gl.ts implements from gl_ngraph.ts.
- `gl_keeptjunctions`'s default is "1" in QW vs "0" in WinQuake (gl_rmain.c
  cvar_t initializer). The override is applied in gl_rmisc.ts's R_Init (this
  file only declares the cvar), see that file's header.
- `gl_doubleeyes` (this port's `gl_doubleeys`, a shipped typo already kept
  exactly as the original) is dropped from QW entirely -- both its declaration and its
  read at R_DrawAliasModel's eyes.mdl special case
  (`if (!strcmp(clmodel->name,"progs/eyes.mdl"))`, no cvar guard). Folded at
  the read site below; the cvar itself stays declared and registered (QW
  simply never reads it, same observable effect as ignoring its value).
- R_DrawAliasModel's "never allow players to go totally black" / torch
  full-light special cases: WinQuake uses two independent `if`s (an
  entity-index-range check the C's own live code already narrows to
  `i>=1 && i<=cl.maxclients`, string-compare commented out; then a separate
  flame-name check). QW replaces both with one if/else-if keyed entirely on
  `clmodel->name`: `"progs/player.mdl"` for the never-black case, else
  `"progs/flame2.mdl"`/`"progs/flame.mdl"` for full light -- mutually
  exclusive in QW where WinQuake's two ifs are not. Folded below.
- The player-skin recolor block right after (`currententity->colormap !=
  vid.colormap` -> `GL_Bind(playertextures-1+i)`) becomes, in QW,
  `currententity->scoreboard` (the `player_info_t *` field QW's entity_t
  gains, now `EntityT.scoreboard`) driving `Skin_Find`/
  `R_TranslatePlayerSkin`/`GL_Bind(playertextures+i)`. Both branches are
  ported below. `i = currententity->scoreboard - cl.players` is pointer
  arithmetic over the `cl.players[]` array, so it is
  `cl.qw.players.indexOf(ent.scoreboard)` here; the C's own `i >= 0 && i <
  MAX_CLIENTS` guard already covers the not-found case.
- R_SetupFrame: WinQuake's `if (cl.maxclients>1) Cvar_Set("r_fullbright","0")`
  becomes QW's unconditional `r_fullbright.value=0; r_lightmap.value=0; if
  (!atoi(Info_ValueForKey(cl.serverinfo,"watervis"))) r_wateralpha.value=1;`.
  `cl.serverinfo` is QW-only (`cl.qw.serverinfo`, QwClientStateExtT).
  `atoi`/`Info_ValueForKey` are Q_atoi (src/common/common.ts) and
  Info_ValueForKey (src/qw/common.ts, landed).
- R_RenderView: QW's own gl_rmain.c wraps its entire R_Mirror function body
  in `#if 0 //!!! FIXME, Zoid, mirror is disabled for now` (dead code, never
  compiled) and comments out the `R_Mirror();` call site. Folded as skipping
  the call when qw.active; R_Mirror's body itself is untouched (unreachable
  either way once the call is skipped, so no second implementation needed).
  `Sys_DoubleTime` (R_RenderView/R_TimeRefresh_f's timing calls) is this
  port's `Sys_FloatTime` (src/qw/client/cl_main.ts's header note already
  rules this); no change needed at the call sites.
- R_DrawViewModel: WinQuake's separate `!r_drawviewmodel.value` and
  `chase_active.value` early-returns become one QW check,
  `!r_drawviewmodel.value || !Cam_DrawViewModel()` (src/qw/client/cl_cam.ts,
  landed). Its invisibility check also switches from `cl.items` to
  `cl.stats[STAT_ITEMS]` (src/qw/bothdefs.ts's STAT_ITEMS=15, QW-only --
  WinQuake has no STAT_ITEMS at all).
- R_DrawSpriteModel: QW's gl_rmain.c has `glEnable(GL_ALPHA_TEST);
  glBegin(GL_QUADS);` twice in a row (a shipped duplicate-statement bug, not
  a functional QW feature). Kept exactly as the original under qw.active per PORTING.md
  rule 4 (faithful, exactly as the original) -- the redundant pair is harmless GL state
  (re-entering an already-enabled cap, re-beginning inside no other GL call).
- `R_Init`'s `playertextures` reservation: WinQuake reserves a fixed 16
  texture slots (`texture_extension_number += 16`); QW reserves
  `MAX_CLIENTS` (32, src/qw/protocol.ts). Folded in gl_rmisc.ts's R_Init
  (this file only declares/uses the cvars/globals R_Init touches).
*/

import { CvarT, Cvar_Set } from "../common/cvar";
import { Con_DPrintf, Con_Printf } from "../client/console";
import { Sys_Error, Sys_FloatTime } from "../platform/sys";
import {
  AngleVectors,
  BoxOnPlaneSide,
  DotProduct,
  Length,
  M_PI,
  PLANE_ANYZ,
  RotatePointAroundVector,
  type Vec3,
  VectorAdd,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSubtract,
  vec3,
} from "../common/mathlib";
import { MplaneT } from "../common/mathlib";
import { Mod_Extradata, Mod_PointInLeaf, ModtypeT } from "../common/model";
import { SPR_ORIENTED, SpriteframetypeT } from "../common/spritegn";
import { IT_INVISIBILITY, STAT_HEALTH, qw } from "../common/quakedef";
import { Q_atoi } from "../common/common";
import { Info_ValueForKey } from "../qw/common";
import { STAT_ITEMS } from "../qw/bothdefs";
import { Cam_DrawViewModel } from "../qw/client/cl_cam";
import { MAX_CLIENTS } from "../qw/protocol";
import type * as SkinModule from "../qw/client/skin";
import type * as GlRmiscModule from "./gl_rmisc";

// Both resolved lazily with Bun's synchronous require(), the same mechanism
// src/common/host.ts uses. gl_rmisc.ts imports this module's cvars, so a
// static import would close a cycle; QW skin.c reaches the whole QuakeWorld
// client (skin.c -> cl_parse.c -> cl_main.c -> ...), which has no business
// in the renderer's load graph. Both are only reached with qw.active.
function skinMod(): typeof SkinModule {
  return require("../qw/client/skin");
}
function glRmiscMod(): typeof GlRmiscModule {
  return require("./gl_rmisc");
}
import { MAX_DLIGHTS, MAX_VISEDICTS, NUM_CSHIFTS, cl, cl_dlights, cl_entities, cl_visedicts, clState } from "../client/client";
import type { EntityT, ParticleT } from "../client/render";
// r_drawentities/r_drawviewmodel/r_fullbright/r_speeds: r_main.c also
// registers these under the same name (render.ts's shared block); imported,
// not redefined, so a Cvar_Set reaches both renderers' objects because there
// is only one object. Re-exported below so existing `from "./gl_rmain"`
// imports (gl_rmisc.ts, test/ref_gl_rsurf.test.ts) keep working.
import { r_drawentities, r_drawviewmodel, r_fullbright, r_netgraph, r_origin, r_refdef, r_speeds, vpn, vright, vup } from "../client/render";
export { r_netgraph };
export { r_drawentities, r_drawviewmodel, r_fullbright, r_speeds };
import { d_8to24table, vid } from "../client/vid";
import { chase_active } from "../client/chase";
import { gl_cshiftpercent, V_SetContentsColor } from "../client/view";
import { R_DrawParticles } from "../client/r_part";
import type * as QwRPartModule from "../qw/client/r_part";
import { S_ExtraUpdate } from "../client/snd_dma";
import {
  ANORM_DOTS_ROW,
  SHADEDOT_QUANT,
  frustum,
  glState,
  modelorg,
  r_avertexnormal_dots,
  r_base_world_matrix,
  r_entorigin,
  r_world_matrix,
  r_worldentity,
} from "./glquake";
import { AliashdrT, MspriteT, MspriteframeT, MspritegroupT } from "./gl_model_types";
import {
  GL_ALPHA_TEST,
  GL_BLEND,
  GL_COLOR_BUFFER_BIT,
  GL_CULL_FACE,
  GL_DEPTH_BUFFER_BIT,
  GL_DEPTH_TEST,
  GL_FASTEST,
  GL_FLAT,
  GL_FRONT,
  GL_GEQUAL,
  GL_LEQUAL,
  GL_MODELVIEW,
  GL_MODELVIEW_MATRIX,
  GL_MODULATE,
  GL_NICEST,
  GL_PERSPECTIVE_CORRECTION_HINT,
  GL_PROJECTION,
  GL_QUADS,
  GL_REPLACE,
  GL_SMOOTH,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TRIANGLES,
  GL_TRIANGLE_FAN,
  GL_TRIANGLE_STRIP,
  GL_BACK,
  qgl,
} from "./qgl";
import { GL_Bind } from "./gl_draw";
import { GL_DisableMultitexture, R_DrawBrushModel, R_DrawWaterSurfaces, R_DrawWorld, R_MarkLeaves, R_RenderBrushPoly } from "./gl_rsurf";
import { R_AnimateLight, R_LightPoint, R_RenderDlights, lightspot } from "./gl_rlight";

// gl_vidlinuxglx.c:75's `cvar_t gl_ztrick = {"gl_ztrick","1"};` (see the
// header note on why the definition lives here and not in gl_vid.ts).
export const gl_ztrick = new CvarT("gl_ztrick", "1");

export const r_norefresh = new CvarT("r_norefresh", "0");
export const r_lightmap = new CvarT("r_lightmap", "0");
export const r_shadows = new CvarT("r_shadows", "0");
export const r_mirroralpha = new CvarT("r_mirroralpha", "1");
export const r_wateralpha = new CvarT("r_wateralpha", "1");
export const r_dynamic = new CvarT("r_dynamic", "1");
export const r_novis = new CvarT("r_novis", "0");
// QW/client/gl_rmain.c / QW/client/r_main.c -- registered by gl_rmisc.ts's
// R_Init under qw.active (see this file's header note).

export const gl_finish = new CvarT("gl_finish", "0");
export const gl_clear = new CvarT("gl_clear", "0");
export const gl_cull = new CvarT("gl_cull", "1");
export const gl_texsort = new CvarT("gl_texsort", "1");
export const gl_smoothmodels = new CvarT("gl_smoothmodels", "1");
export const gl_affinemodels = new CvarT("gl_affinemodels", "0");
export const gl_polyblend = new CvarT("gl_polyblend", "1");
export const gl_flashblend = new CvarT("gl_flashblend", "1");
export const gl_playermip = new CvarT("gl_playermip", "0");
export const gl_nocolors = new CvarT("gl_nocolors", "0");
export const gl_keeptjunctions = new CvarT("gl_keeptjunctions", "0");
export const gl_reporttjunctions = new CvarT("gl_reporttjunctions", "0");
// gl_rmain.c:99 -- the cvar NAME really is "gl_doubleeys" in the shipped source
export const gl_doubleeyes = new CvarT("gl_doubleeys", "1");

// view.c's `float v_blend[4]`, defined under #ifdef GLQUAKE
export const v_blend: Float32Array = new Float32Array(4);

/*
=================
R_CullBox

Returns true if the box is completely outside the frustom
=================
*/
export function R_CullBox(mins: Vec3, maxs: Vec3): boolean {
  for (let i = 0; i < 4; i++) if (BoxOnPlaneSide(mins, maxs, frustum[i]) === 2) return true;
  return false;
}

export function R_RotateForEntity(e: EntityT): void {
  qgl().qglTranslatef(e.origin[0], e.origin[1], e.origin[2]);

  qgl().qglRotatef(e.angles[1], 0, 0, 1);
  qgl().qglRotatef(-e.angles[0], 0, 1, 0);
  qgl().qglRotatef(e.angles[2], 1, 0, 0);
}

/*
=============================================================

  SPRITE MODELS

=============================================================
*/

/*
================
R_GetSpriteFrame
================
*/
export function R_GetSpriteFrame(currententity: EntityT): MspriteframeT {
  if (currententity.model === null) Sys_Error("R_GetSpriteFrame: NULL model");
  const psprite = currententity.model.cache.data;
  if (!(psprite instanceof MspriteT)) Sys_Error("R_GetSpriteFrame: not a sprite");
  let frame = currententity.frame;

  if (frame >= psprite.numframes || frame < 0) {
    Con_Printf("R_DrawSprite: no such frame %d\n", frame);
    frame = 0;
  }

  let pspriteframe: MspriteframeT;

  if (psprite.frames[frame].type === SpriteframetypeT.SPR_SINGLE) {
    const frameptr = psprite.frames[frame].frameptr;
    if (!(frameptr instanceof MspriteframeT)) Sys_Error("R_GetSpriteFrame: bad single frame");
    pspriteframe = frameptr;
  } else {
    const pspritegroup = psprite.frames[frame].frameptr;
    if (!(pspritegroup instanceof MspritegroupT)) Sys_Error("R_GetSpriteFrame: bad frame group");
    const pintervals = pspritegroup.intervals;
    const numframes = pspritegroup.numframes;
    const fullinterval = pintervals[numframes - 1];

    const time = cl.time + currententity.syncbase;

    // when loading in Mod_LoadSpriteGroup, we guaranteed all interval values
    // are positive, so we don't have to worry about division by 0
    const targettime = time - ((time / fullinterval) | 0) * fullinterval;

    let i = 0;
    for (; i < numframes - 1; i++) {
      if (pintervals[i] > targettime) break;
    }

    pspriteframe = pspritegroup.frames[i];
  }

  return pspriteframe;
}

const spriteForward: Vec3 = vec3();
const spriteRight: Vec3 = vec3();
const spriteUp: Vec3 = vec3();
const spritePoint: Vec3 = vec3();

/*
=================
R_DrawSpriteModel

=================
*/
export function R_DrawSpriteModel(e: EntityT): void {
  // don't even bother culling, because it's just a single
  // polygon without a surface cache
  const frame = R_GetSpriteFrame(e);
  const currententity = glState.currententity;
  if (currententity === null || currententity.model === null) Sys_Error("R_DrawSpriteModel: NULL model");
  const psprite = currententity.model.cache.data;
  if (!(psprite instanceof MspriteT)) Sys_Error("R_DrawSpriteModel: not a sprite");

  let up: Vec3;
  let right: Vec3;

  if (psprite.type === SPR_ORIENTED) {
    // bullet marks on walls
    AngleVectors(currententity.angles, spriteForward, spriteRight, spriteUp);
    up = spriteUp;
    right = spriteRight;
  } else {
    // normal sprite
    up = vup;
    right = vright;
  }

  qgl().qglColor3f(1, 1, 1);

  GL_DisableMultitexture();

  GL_Bind(frame.gl_texturenum);

  qgl().qglEnable(GL_ALPHA_TEST);
  qgl().qglBegin(GL_QUADS);
  if (qw.active) {
    // QW/client/gl_rmain.c has this pair twice in a row -- a shipped
    // duplicate-statement bug (see file header), kept exactly as the C has it.
    qgl().qglEnable(GL_ALPHA_TEST);
    qgl().qglBegin(GL_QUADS);
  }

  qgl().qglTexCoord2f(0, 1);
  VectorMA(e.origin, frame.down, up, spritePoint);
  VectorMA(spritePoint, frame.left, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglTexCoord2f(0, 0);
  VectorMA(e.origin, frame.up, up, spritePoint);
  VectorMA(spritePoint, frame.left, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglTexCoord2f(1, 0);
  VectorMA(e.origin, frame.up, up, spritePoint);
  VectorMA(spritePoint, frame.right, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglTexCoord2f(1, 1);
  VectorMA(e.origin, frame.down, up, spritePoint);
  VectorMA(spritePoint, frame.right, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglEnd();

  qgl().qglDisable(GL_ALPHA_TEST);
}

/*
=============================================================

  ALIAS MODELS

=============================================================
*/

export const shadevector: Vec3 = vec3();

// gl_rmain.c's reassigned alias-lighting globals (see the header note).
// `shadedots` starts at r_avertexnormal_dots[0], as the C's initializer does.
export const rmainState: {
  shadelight: number;
  ambientlight: number;
  shadedots: Float32Array;
  lastposenum: number;
} = {
  shadelight: 0,
  ambientlight: 0,
  shadedots: r_avertexnormal_dots.subarray(0, ANORM_DOTS_ROW),
  lastposenum: 0,
};

/*
=============
GL_DrawAliasFrame
=============
*/
export function GL_DrawAliasFrame(paliashdr: AliashdrT, posenum: number): void {
  rmainState.lastposenum = posenum;

  const posedata = paliashdr.posedata;
  let vertnum = posenum * paliashdr.poseverts;
  const order = paliashdr.commands;
  // the texture coordinates gl_mesh.c stored into the command list as raw
  // float bits (`*(float *)&commands[n] = s`), read back through the C's
  // `((float *)order)[0]` aliasing
  const orderf = new Float32Array(order.buffer, order.byteOffset, order.length);
  let o = 0;

  for (;;) {
    // get the vertex count and primitive type
    let count = order[o++];
    if (!count) break; // done
    if (count < 0) {
      count = -count;
      qgl().qglBegin(GL_TRIANGLE_FAN);
    } else qgl().qglBegin(GL_TRIANGLE_STRIP);

    do {
      // texture coordinates come from the draw list
      qgl().qglTexCoord2f(orderf[o], orderf[o + 1]);
      o += 2;

      // normals and vertexes come from the frame list
      const verts = posedata[vertnum];
      const l = rmainState.shadedots[verts.lightnormalindex] * rmainState.shadelight;
      qgl().qglColor3f(l, l, l);
      qgl().qglVertex3f(verts.v[0], verts.v[1], verts.v[2]);
      vertnum++;
    } while (--count);

    qgl().qglEnd();
  }
}

const shadowPoint: Vec3 = vec3();

/*
=============
GL_DrawAliasShadow
=============
*/
export function GL_DrawAliasShadow(paliashdr: AliashdrT, posenum: number): void {
  const currententity = glState.currententity;
  if (currententity === null) Sys_Error("GL_DrawAliasShadow: no current entity");

  const lheight = currententity.origin[2] - lightspot[2];

  const posedata = paliashdr.posedata;
  let vertnum = posenum * paliashdr.poseverts;
  const order = paliashdr.commands;
  let o = 0;

  const height = -lheight + 1.0;

  for (;;) {
    // get the vertex count and primitive type
    let count = order[o++];
    if (!count) break; // done
    if (count < 0) {
      count = -count;
      qgl().qglBegin(GL_TRIANGLE_FAN);
    } else qgl().qglBegin(GL_TRIANGLE_STRIP);

    do {
      // texture coordinates come from the draw list
      // (skipped for shadows) glTexCoord2fv ((float *)order);
      o += 2;

      // normals and vertexes come from the frame list
      const verts = posedata[vertnum];
      shadowPoint[0] = verts.v[0] * paliashdr.scale[0] + paliashdr.scale_origin[0];
      shadowPoint[1] = verts.v[1] * paliashdr.scale[1] + paliashdr.scale_origin[1];
      shadowPoint[2] = verts.v[2] * paliashdr.scale[2] + paliashdr.scale_origin[2];

      shadowPoint[0] -= shadevector[0] * (shadowPoint[2] + lheight);
      shadowPoint[1] -= shadevector[1] * (shadowPoint[2] + lheight);
      shadowPoint[2] = height;
      //			height -= 0.001;
      qgl().qglVertex3fv(shadowPoint);

      vertnum++;
    } while (--count);

    qgl().qglEnd();
  }
}

/*
=================
R_SetupAliasFrame

=================
*/
export function R_SetupAliasFrame(frame: number, paliashdr: AliashdrT): void {
  if (frame >= paliashdr.numframes || frame < 0) {
    Con_DPrintf("R_AliasSetupFrame: no such frame %d\n", frame);
    frame = 0;
  }

  let pose = paliashdr.frames[frame].firstpose;
  const numposes = paliashdr.frames[frame].numposes;

  if (numposes > 1) {
    const interval = paliashdr.frames[frame].interval;
    pose += ((cl.time / interval) | 0) % numposes;
  }

  GL_DrawAliasFrame(paliashdr, pose);
}

const aliasDist: Vec3 = vec3();
const aliasMins: Vec3 = vec3();
const aliasMaxs: Vec3 = vec3();

/*
=================
R_DrawAliasModel

=================
*/
export function R_DrawAliasModel(e: EntityT): void {
  const currententity = glState.currententity;
  if (currententity === null) Sys_Error("R_DrawAliasModel: no current entity");

  const clmodel = currententity.model;
  if (clmodel === null) Sys_Error("R_DrawAliasModel: NULL model");

  VectorAdd(currententity.origin, clmodel.mins, aliasMins);
  VectorAdd(currententity.origin, clmodel.maxs, aliasMaxs);

  if (R_CullBox(aliasMins, aliasMaxs)) return;

  VectorCopy(currententity.origin, r_entorigin);
  VectorSubtract(r_origin, r_entorigin, modelorg);

  //
  // get lighting information
  //

  rmainState.ambientlight = rmainState.shadelight = R_LightPoint(currententity.origin);

  // allways give the gun some light
  if (e === cl.viewent && rmainState.ambientlight < 24) rmainState.ambientlight = rmainState.shadelight = 24;

  for (let lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
    if (cl_dlights[lnum].die >= cl.time) {
      VectorSubtract(currententity.origin, cl_dlights[lnum].origin, aliasDist);
      const add = cl_dlights[lnum].radius - Length(aliasDist);

      if (add > 0) {
        rmainState.ambientlight += add;
        //ZOID models should be affected by dlights as well
        rmainState.shadelight += add;
      }
    }
  }

  // clamp lighting so it doesn't overbright as much
  if (rmainState.ambientlight > 128) rmainState.ambientlight = 128;
  if (rmainState.ambientlight + rmainState.shadelight > 192) rmainState.shadelight = 192 - rmainState.ambientlight;

  // ZOID: never allow players to go totally black
  let i = cl_entities.indexOf(currententity);
  if (qw.active) {
    // QW/client/gl_rmain.c: one if/else-if keyed on the model name (see file
    // header) instead of WinQuake's index-range + separate flame check.
    if (clmodel.name === "progs/player.mdl") {
      if (rmainState.ambientlight < 8) rmainState.ambientlight = rmainState.shadelight = 8;
    } else if (clmodel.name === "progs/flame2.mdl" || clmodel.name === "progs/flame.mdl") {
      // HACK HACK HACK -- no fullbright colors, so make torches full light
      rmainState.ambientlight = rmainState.shadelight = 256;
    }
  } else {
    if (i >= 1 && i <= cl.maxclients /* && !strcmp (currententity->model->name, "progs/player.mdl") */) {
      if (rmainState.ambientlight < 8) rmainState.ambientlight = rmainState.shadelight = 8;
    }

    // HACK HACK HACK -- no fullbright colors, so make torches full light
    if (clmodel.name === "progs/flame2.mdl" || clmodel.name === "progs/flame.mdl") rmainState.ambientlight = rmainState.shadelight = 256;
  }

  const shaderow = ((e.angles[1] * (SHADEDOT_QUANT / 360.0)) | 0) & (SHADEDOT_QUANT - 1);
  rmainState.shadedots = r_avertexnormal_dots.subarray(shaderow * ANORM_DOTS_ROW, (shaderow + 1) * ANORM_DOTS_ROW);
  rmainState.shadelight = rmainState.shadelight / 200.0;

  const an = (e.angles[1] / 180) * M_PI;
  shadevector[0] = Math.cos(-an);
  shadevector[1] = Math.sin(-an);
  shadevector[2] = 1;
  VectorNormalize(shadevector);

  //
  // locate the proper data
  //
  // C: Mod_Extradata (currententity->model) -- clmodel is that same pointer,
  // already narrowed non-null above
  const extradata = Mod_Extradata(clmodel);
  if (!(extradata instanceof AliashdrT)) Sys_Error("R_DrawAliasModel: not an alias model");
  const paliashdr = extradata;

  glState.c_alias_polys += paliashdr.numtris;

  //
  // draw all the triangles
  //

  GL_DisableMultitexture();

  qgl().qglPushMatrix();
  R_RotateForEntity(e);

  // QW/client/gl_rmain.c drops the gl_doubleeyes guard entirely (see file
  // header) -- the eyes.mdl special case always applies when qw.active.
  if (clmodel.name === "progs/eyes.mdl" && (qw.active || gl_doubleeyes.value)) {
    qgl().qglTranslatef(paliashdr.scale_origin[0], paliashdr.scale_origin[1], paliashdr.scale_origin[2] - (22 + 8));
    // double size of eyes, since they are really hard to see in gl
    qgl().qglScalef(paliashdr.scale[0] * 2, paliashdr.scale[1] * 2, paliashdr.scale[2] * 2);
  } else {
    qgl().qglTranslatef(paliashdr.scale_origin[0], paliashdr.scale_origin[1], paliashdr.scale_origin[2]);
    qgl().qglScalef(paliashdr.scale[0], paliashdr.scale[1], paliashdr.scale[2]);
  }

  const anim = ((cl.time * 10) | 0) & 3;
  GL_Bind(paliashdr.gl_texturenum[currententity.skinnum * 4 + anim]);

  // we can't dynamically colormap textures, so they are cached
  // seperately for the players.  Heads are just uncolored.
  if (qw.active) {
    // QW/client/gl_rmain.c replaces this whole block's condition and body
    // (see file header)
    if (currententity.scoreboard !== null && !gl_nocolors.value) {
      const sc = currententity.scoreboard;
      i = cl.qw.players.indexOf(sc);
      if (!sc.skin) {
        skinMod().Skin_Find(sc);
        glRmiscMod().R_TranslatePlayerSkin(i);
      }
      if (i >= 0 && i < MAX_CLIENTS) GL_Bind(glState.playertextures + i);
    }
  } else if (currententity.colormap !== vid.colormap && !gl_nocolors.value) {
    i = cl_entities.indexOf(currententity);
    if (i >= 1 && i <= cl.maxclients /* && !strcmp (currententity->model->name, "progs/player.mdl") */)
      GL_Bind(glState.playertextures - 1 + i);
  }

  if (gl_smoothmodels.value) qgl().qglShadeModel(GL_SMOOTH);
  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);

  if (gl_affinemodels.value) qgl().qglHint(GL_PERSPECTIVE_CORRECTION_HINT, GL_FASTEST);

  R_SetupAliasFrame(currententity.frame, paliashdr);

  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);

  qgl().qglShadeModel(GL_FLAT);
  if (gl_affinemodels.value) qgl().qglHint(GL_PERSPECTIVE_CORRECTION_HINT, GL_NICEST);

  qgl().qglPopMatrix();

  if (r_shadows.value) {
    qgl().qglPushMatrix();
    R_RotateForEntity(e);
    qgl().qglDisable(GL_TEXTURE_2D);
    qgl().qglEnable(GL_BLEND);
    qgl().qglColor4f(0, 0, 0, 0.5);
    GL_DrawAliasShadow(paliashdr, rmainState.lastposenum);
    qgl().qglEnable(GL_TEXTURE_2D);
    qgl().qglDisable(GL_BLEND);
    qgl().qglColor4f(1, 1, 1, 1);
    qgl().qglPopMatrix();
  }
}

//==================================================================================

/*
=============
R_DrawEntitiesOnList
=============
*/
export function R_DrawEntitiesOnList(): void {
  let i: number;

  if (!r_drawentities.value) return;

  // draw sprites seperately, because of alpha blending
  for (i = 0; i < clState.cl_numvisedicts; i++) {
    const currententity = cl_visedicts[i];
    glState.currententity = currententity;
    if (!currententity) continue;
    if (!currententity.model) continue;

    switch (currententity.model.type) {
      case ModtypeT.mod_alias:
        R_DrawAliasModel(currententity);
        break;

      case ModtypeT.mod_brush:
        R_DrawBrushModel(currententity);
        break;

      default:
        break;
    }
  }

  for (i = 0; i < clState.cl_numvisedicts; i++) {
    const currententity = cl_visedicts[i];
    glState.currententity = currententity;
    if (!currententity) continue;
    if (!currententity.model) continue;

    switch (currententity.model.type) {
      case ModtypeT.mod_sprite:
        R_DrawSpriteModel(currententity);
        break;
    }
  }
}

const viewmodelDist: Vec3 = vec3();

/*
=============
R_DrawViewModel
=============
*/
export function R_DrawViewModel(): void {
  const ambient: Float32Array = new Float32Array(4);
  const diffuse: Float32Array = new Float32Array(4);

  // QW/client/gl_rmain.c folds the chase_active check into
  // `!Cam_DrawViewModel()` (cl_cam.c, spectator/chase camera logic) instead
  // of reading chase_active directly.
  if (qw.active) {
    if (!r_drawviewmodel.value || !Cam_DrawViewModel()) return;
  } else {
    if (!r_drawviewmodel.value) return;

    if (chase_active.value) return;
  }

  if (glState.envmap) return;

  if (!r_drawentities.value) return;

  // QW/client/gl_rmain.c reads cl.stats[STAT_ITEMS] instead of cl.items
  // (cl.items is not maintained under QW; STAT_ITEMS mirrors the server's
  // stat array both ways, see src/qw/bothdefs.ts).
  if (qw.active ? cl.stats[STAT_ITEMS] & IT_INVISIBILITY : cl.items & IT_INVISIBILITY) return;

  if (cl.stats[STAT_HEALTH] <= 0) return;

  const currententity = cl.viewent;
  glState.currententity = currententity;
  if (!currententity.model) return;

  let j = R_LightPoint(currententity.origin);

  if (j < 24) j = 24; // allways give some light on gun
  let ambientlight = j;
  const shadelight = j;

  // add dynamic lights
  for (let lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
    const dl = cl_dlights[lnum];
    if (!dl.radius) continue;
    if (!dl.radius) continue;
    if (dl.die < cl.time) continue;

    VectorSubtract(currententity.origin, dl.origin, viewmodelDist);
    const add = dl.radius - Length(viewmodelDist);
    if (add > 0) ambientlight += add;
  }

  ambient[0] = ambient[1] = ambient[2] = ambient[3] = ambientlight / 128;
  diffuse[0] = diffuse[1] = diffuse[2] = diffuse[3] = shadelight / 128;

  // hack the depth range to prevent view model from poking into walls
  qgl().qglDepthRange(glState.gldepthmin, glState.gldepthmin + 0.3 * (glState.gldepthmax - glState.gldepthmin));
  R_DrawAliasModel(currententity);
  qgl().qglDepthRange(glState.gldepthmin, glState.gldepthmax);
}

/*
============
R_PolyBlend
============
*/
export function R_PolyBlend(): void {
  if (!gl_polyblend.value) return;
  if (!v_blend[3]) return;

  GL_DisableMultitexture();

  qgl().qglDisable(GL_ALPHA_TEST);
  qgl().qglEnable(GL_BLEND);
  qgl().qglDisable(GL_DEPTH_TEST);
  qgl().qglDisable(GL_TEXTURE_2D);

  qgl().qglLoadIdentity();

  qgl().qglRotatef(-90, 1, 0, 0); // put Z going up
  qgl().qglRotatef(90, 0, 0, 1); // put Z going up

  qgl().qglColor4fv(v_blend);

  qgl().qglBegin(GL_QUADS);

  qgl().qglVertex3f(10, 100, 100);
  qgl().qglVertex3f(10, -100, 100);
  qgl().qglVertex3f(10, -100, -100);
  qgl().qglVertex3f(10, 100, -100);
  qgl().qglEnd();

  qgl().qglDisable(GL_BLEND);
  qgl().qglEnable(GL_TEXTURE_2D);
  qgl().qglEnable(GL_ALPHA_TEST);
}

export function SignbitsForPlane(out: MplaneT): number {
  // for fast box on planeside test

  let bits = 0;
  for (let j = 0; j < 3; j++) {
    if (out.normal[j] < 0) bits |= 1 << j;
  }
  return bits;
}

export function R_SetFrustum(): void {
  if (r_refdef.fov_x === 90) {
    // front side is visible

    VectorAdd(vpn, vright, frustum[0].normal);
    VectorSubtract(vpn, vright, frustum[1].normal);

    VectorAdd(vpn, vup, frustum[2].normal);
    VectorSubtract(vpn, vup, frustum[3].normal);
  } else {
    // rotate VPN right by FOV_X/2 degrees
    RotatePointAroundVector(frustum[0].normal, vup, vpn, -(90 - r_refdef.fov_x / 2));
    // rotate VPN left by FOV_X/2 degrees
    RotatePointAroundVector(frustum[1].normal, vup, vpn, 90 - r_refdef.fov_x / 2);
    // rotate VPN up by FOV_X/2 degrees
    RotatePointAroundVector(frustum[2].normal, vright, vpn, 90 - r_refdef.fov_y / 2);
    // rotate VPN down by FOV_X/2 degrees
    RotatePointAroundVector(frustum[3].normal, vright, vpn, -(90 - r_refdef.fov_y / 2));
  }

  for (let i = 0; i < 4; i++) {
    frustum[i].type = PLANE_ANYZ;
    frustum[i].dist = DotProduct(r_origin, frustum[i].normal);
    frustum[i].signbits = SignbitsForPlane(frustum[i]);
  }
}

/*
===============
R_SetupFrame
===============
*/
export function R_SetupFrame(): void {
  if (qw.active) {
    // QW/client/gl_rmain.c: unconditional, plus r_lightmap and a
    // serverinfo-driven r_wateralpha default (see file header).
    r_fullbright.value = 0;
    r_lightmap.value = 0;
    if (!Q_atoi(Info_ValueForKey(cl.qw.serverinfo, "watervis"))) r_wateralpha.value = 1;
  } else {
    // don't allow cheats in multiplayer
    if (cl.maxclients > 1) Cvar_Set("r_fullbright", "0");
  }

  R_AnimateLight();

  glState.r_framecount++;

  // build the transformation matrix for the given view angles
  VectorCopy(r_refdef.vieworg, r_origin);

  AngleVectors(r_refdef.viewangles, vpn, vright, vup);

  // current viewleaf
  glState.r_oldviewleaf = glState.r_viewleaf;
  glState.r_viewleaf = Mod_PointInLeaf(r_origin, cl.worldmodel);

  V_SetContentsColor(glState.r_viewleaf.contents);
  V_CalcBlend();

  glState.r_cache_thrash = false;

  glState.c_brush_polys = 0;
  glState.c_alias_polys = 0;
}

export function MYgluPerspective(fovy: number, aspect: number, zNear: number, zFar: number): void {
  const ymax = zNear * Math.tan((fovy * M_PI) / 360.0);
  const ymin = -ymax;

  const xmin = ymin * aspect;
  const xmax = ymax * aspect;

  qgl().qglFrustum(xmin, xmax, ymin, ymax, zNear, zFar);
}

/*
=============
R_SetupGL
=============
*/
export function R_SetupGL(): void {
  //
  // set up viewpoint
  //
  qgl().qglMatrixMode(GL_PROJECTION);
  qgl().qglLoadIdentity();
  let x = ((r_refdef.vrect.x * glState.glwidth) / vid.width) | 0;
  let x2 = (((r_refdef.vrect.x + r_refdef.vrect.width) * glState.glwidth) / vid.width) | 0;
  let y = (((vid.height - r_refdef.vrect.y) * glState.glheight) / vid.height) | 0;
  let y2 = (((vid.height - (r_refdef.vrect.y + r_refdef.vrect.height)) * glState.glheight) / vid.height) | 0;

  // fudge around because of frac screen scale
  if (x > 0) x--;
  if (x2 < glState.glwidth) x2++;
  if (y2 < 0) y2--;
  if (y < glState.glheight) y++;

  let w = x2 - x;
  let h = y - y2;

  if (glState.envmap) {
    x = y2 = 0;
    w = h = 256;
  }

  qgl().qglViewport(glState.glx + x, glState.gly + y2, w, h);
  const screenaspect = r_refdef.vrect.width / r_refdef.vrect.height;
  //	yfov = 2*atan((float)r_refdef.vrect.height/r_refdef.vrect.width)*180/M_PI;
  MYgluPerspective(r_refdef.fov_y, screenaspect, 4, 4096);

  if (glState.mirror) {
    if (glState.mirror_plane === null) Sys_Error("R_SetupGL: no mirror plane");
    if (glState.mirror_plane.normal[2]) qgl().qglScalef(1, -1, 1);
    else qgl().qglScalef(-1, 1, 1);
    qgl().qglCullFace(GL_BACK);
  } else qgl().qglCullFace(GL_FRONT);

  qgl().qglMatrixMode(GL_MODELVIEW);
  qgl().qglLoadIdentity();

  qgl().qglRotatef(-90, 1, 0, 0); // put Z going up
  qgl().qglRotatef(90, 0, 0, 1); // put Z going up
  qgl().qglRotatef(-r_refdef.viewangles[2], 1, 0, 0);
  qgl().qglRotatef(-r_refdef.viewangles[0], 0, 1, 0);
  qgl().qglRotatef(-r_refdef.viewangles[1], 0, 0, 1);
  qgl().qglTranslatef(-r_refdef.vieworg[0], -r_refdef.vieworg[1], -r_refdef.vieworg[2]);

  qgl().qglGetFloatv(GL_MODELVIEW_MATRIX, r_world_matrix);

  //
  // set drawing parms
  //
  if (gl_cull.value) qgl().qglEnable(GL_CULL_FACE);
  else qgl().qglDisable(GL_CULL_FACE);

  qgl().qglDisable(GL_BLEND);
  qgl().qglDisable(GL_ALPHA_TEST);
  qgl().qglEnable(GL_DEPTH_TEST);
}

// QW/client/r_part.c is a wholesale-different file (see src/qw/client/r_part.ts's
// own Q023b ruling): its own particle pool, `host_frametime` where WinQuake's
// R_DrawParticles reads `cl.time - cl.oldtime`, and a literal 800 gravity.
// gl_rmain.c is compiled once per tree and linked against the r_part.c of its
// own tree, so under qw.active the call below has to reach the QW module -- the
// pool QW's cl_tent.c/cl_ents.c fill is otherwise not the pool this renderer
// draws. Resolved lazily with Bun's synchronous require() rather than a static
// import, the same mechanism src/ref_soft/r_alias.ts uses for
// src/qw/client/skin.ts.
function qwRPartMod(): typeof QwRPartModule {
  return require("../qw/client/r_part");
}

/*
================
R_RenderScene

r_refdef must be set before the first call
================
*/
export function R_RenderScene(): void {
  R_SetupFrame();

  R_SetFrustum();

  R_SetupGL();

  R_MarkLeaves(); // done here so we know if we're in water

  R_DrawWorld(); // adds static entities to the list

  S_ExtraUpdate(); // don't let sound get messed up if going slow

  R_DrawEntitiesOnList();

  GL_DisableMultitexture();

  R_RenderDlights();

  if (qw.active) qwRPartMod().R_DrawParticles();
  else R_DrawParticles();
}

let trickframe = 0;

/*
=============
R_Clear
=============
*/
export function R_Clear(): void {
  if (r_mirroralpha.value !== 1.0) {
    if (gl_clear.value) qgl().qglClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    else qgl().qglClear(GL_DEPTH_BUFFER_BIT);
    glState.gldepthmin = 0;
    glState.gldepthmax = 0.5;
    qgl().qglDepthFunc(GL_LEQUAL);
  } else if (gl_ztrick.value) {
    if (gl_clear.value) qgl().qglClear(GL_COLOR_BUFFER_BIT);

    trickframe++;
    if (trickframe & 1) {
      glState.gldepthmin = 0;
      glState.gldepthmax = 0.49999;
      qgl().qglDepthFunc(GL_LEQUAL);
    } else {
      glState.gldepthmin = 1;
      glState.gldepthmax = 0.5;
      qgl().qglDepthFunc(GL_GEQUAL);
    }
  } else {
    if (gl_clear.value) qgl().qglClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    else qgl().qglClear(GL_DEPTH_BUFFER_BIT);
    glState.gldepthmin = 0;
    glState.gldepthmax = 1;
    qgl().qglDepthFunc(GL_LEQUAL);
  }

  qgl().qglDepthRange(glState.gldepthmin, glState.gldepthmax);
}

/*
=============
R_Mirror
=============
*/
export function R_Mirror(): void {
  if (!glState.mirror) return;
  const mirror_plane = glState.mirror_plane;
  if (mirror_plane === null) Sys_Error("R_Mirror: no mirror plane");

  r_base_world_matrix.set(r_world_matrix);

  let d = DotProduct(r_refdef.vieworg, mirror_plane.normal) - mirror_plane.dist;
  VectorMA(r_refdef.vieworg, -2 * d, mirror_plane.normal, r_refdef.vieworg);

  d = DotProduct(vpn, mirror_plane.normal);
  VectorMA(vpn, -2 * d, mirror_plane.normal, vpn);

  r_refdef.viewangles[0] = (-Math.asin(vpn[2]) / M_PI) * 180;
  r_refdef.viewangles[1] = (Math.atan2(vpn[1], vpn[0]) / M_PI) * 180;
  r_refdef.viewangles[2] = -r_refdef.viewangles[2];

  const ent = cl_entities[cl.viewentity];
  if (clState.cl_numvisedicts < MAX_VISEDICTS) {
    cl_visedicts[clState.cl_numvisedicts] = ent;
    clState.cl_numvisedicts++;
  }

  glState.gldepthmin = 0.5;
  glState.gldepthmax = 1;
  qgl().qglDepthRange(glState.gldepthmin, glState.gldepthmax);
  qgl().qglDepthFunc(GL_LEQUAL);

  R_RenderScene();
  R_DrawWaterSurfaces();

  glState.gldepthmin = 0;
  glState.gldepthmax = 0.5;
  qgl().qglDepthRange(glState.gldepthmin, glState.gldepthmax);
  qgl().qglDepthFunc(GL_LEQUAL);

  // blend on top
  qgl().qglEnable(GL_BLEND);
  qgl().qglMatrixMode(GL_PROJECTION);
  if (mirror_plane.normal[2]) qgl().qglScalef(1, -1, 1);
  else qgl().qglScalef(-1, 1, 1);
  qgl().qglCullFace(GL_FRONT);
  qgl().qglMatrixMode(GL_MODELVIEW);

  qgl().qglLoadMatrixf(r_base_world_matrix);

  qgl().qglColor4f(1, 1, 1, r_mirroralpha.value);
  if (cl.worldmodel === null || cl.worldmodel.textures === null) Sys_Error("R_Mirror: no worldmodel");
  const mirrortexture = cl.worldmodel.textures[glState.mirrortexturenum];
  if (mirrortexture === null) Sys_Error("R_Mirror: no mirror texture");
  let s = mirrortexture.texturechain;
  for (; s; s = s.texturechain) R_RenderBrushPoly(s);
  mirrortexture.texturechain = null;
  qgl().qglDisable(GL_BLEND);
  qgl().qglColor4f(1, 1, 1, 1);
}

/*
================
R_RenderView

r_refdef must be set before the first call
================
*/
export function R_RenderView(): void {
  let time1 = 0;
  let time2: number;

  if (r_norefresh.value) return;

  if (!r_worldentity.model || !cl.worldmodel) Sys_Error("R_RenderView: NULL worldmodel");

  if (r_speeds.value) {
    qgl().qglFinish();
    time1 = Sys_FloatTime();
    glState.c_brush_polys = 0;
    glState.c_alias_polys = 0;
  }

  glState.mirror = false;

  if (gl_finish.value) qgl().qglFinish();

  R_Clear();

  // render normal view

  /***** Experimental silly looking fog ******
  ****** Use r_fullbright if you enable ******
	glFogi(GL_FOG_MODE, GL_LINEAR);
	glFogfv(GL_FOG_COLOR, colors);
	glFogf(GL_FOG_END, 512.0);
	glEnable(GL_FOG);
********************************************/

  R_RenderScene();
  R_DrawViewModel();
  R_DrawWaterSurfaces();

  //  More fog right here :)
  //	glDisable(GL_FOG);
  //  End of all fog code...

  // render mirror view
  // QW/client/gl_rmain.c: R_Mirror's whole body is #if 0'd out and this call
  // is commented out (see file header) -- mirrors are disabled under QW.
  if (!qw.active) R_Mirror();

  R_PolyBlend();

  if (r_speeds.value) {
    //		glFinish ();
    time2 = Sys_FloatTime();
    Con_Printf("%3i ms  %4i wpoly %4i epoly\n", ((time2 - time1) * 1000) | 0, glState.c_brush_polys, glState.c_alias_polys);
  }
}

/*
=============================================================================

  the GLQUAKE half of r_part.c's R_DrawParticles (see the header note)

=============================================================================
*/

const particleUp: Vec3 = vec3();
const particleRight: Vec3 = vec3();

export function D_StartParticles(): void {
  GL_Bind(glState.particletexture);
  qgl().qglEnable(GL_BLEND);
  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
  qgl().qglBegin(GL_TRIANGLES);

  VectorScale(vup, 1.5, particleUp);
  VectorScale(vright, 1.5, particleRight);
}

export function D_DrawParticle(p: ParticleT): void {
  // hack a scale up to keep particles from disapearing
  let scale = (p.org[0] - r_origin[0]) * vpn[0] + (p.org[1] - r_origin[1]) * vpn[1] + (p.org[2] - r_origin[2]) * vpn[2];
  if (scale < 20) scale = 1;
  else scale = 1 + scale * 0.004;

  // glColor3ubv ((byte *)&d_8to24table[(int)p->color]) -- see the header note
  const packed = d_8to24table[p.color | 0];
  qgl().qglColor3f((packed & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, ((packed >>> 16) & 0xff) / 255);
  qgl().qglTexCoord2f(0, 0);
  qgl().qglVertex3fv(p.org);
  qgl().qglTexCoord2f(1, 0);
  qgl().qglVertex3f(p.org[0] + particleUp[0] * scale, p.org[1] + particleUp[1] * scale, p.org[2] + particleUp[2] * scale);
  qgl().qglTexCoord2f(0, 1);
  qgl().qglVertex3f(p.org[0] + particleRight[0] * scale, p.org[1] + particleRight[1] * scale, p.org[2] + particleRight[2] * scale);
}

export function D_EndParticles(): void {
  qgl().qglEnd();
  qgl().qglDisable(GL_BLEND);
  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
}

/*
=============
V_CalcBlend

view.c's #ifdef GLQUAKE body (see the header note)
=============
*/
export function V_CalcBlend(): void {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let a2: number;

  for (let j = 0; j < NUM_CSHIFTS; j++) {
    if (!gl_cshiftpercent.value) continue;

    a2 = (cl.cshifts[j].percent * gl_cshiftpercent.value) / 100.0 / 255.0;

    //		a2 = cl.cshifts[j].percent/255.0;
    if (!a2) continue;
    a = a + a2 * (1 - a);
    //Con_Printf ("j:%i a:%f\n", j, a);
    a2 = a2 / a;
    r = r * (1 - a2) + cl.cshifts[j].destcolor[0] * a2;
    g = g * (1 - a2) + cl.cshifts[j].destcolor[1] * a2;
    b = b * (1 - a2) + cl.cshifts[j].destcolor[2] * a2;
  }

  v_blend[0] = r / 255.0;
  v_blend[1] = g / 255.0;
  v_blend[2] = b / 255.0;
  v_blend[3] = a;
  if (v_blend[3] > 1) v_blend[3] = 1;
  if (v_blend[3] < 0) v_blend[3] = 0;
}
