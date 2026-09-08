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
  mutated in place, so it stays an exported `const` vec3. U16 (QuakeSpasm/
  Ironwail's own two-pose lerp) splits `lastposenum` into `lastpose1`/
  `lastpose2`/`lastblend`, since GL_DrawAliasShadow now needs the same two
  poses and blend fraction the main draw used, not one posenum.
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

U15 (colored lighting for alias models -- QuakeSpasm's `lightcolor`, no C
original for the per-channel shading path itself): R_DrawAliasModel's
scalar `rmainState.ambientlight`/`shadelight` computation (from
R_LightPoint's returned average) is UNCHANGED, still exactly the classic
clamp/hack sequence, since every other consumer of a single brightness
number still reads it. Immediately after, the same clamp/hack sequence is
replayed once per channel, seeded from gl_rlight.ts's `lightcolor` (which
R_LightPoint just filled as a side effect of the call above) instead of the
scalar average, writing `rmainState.shadelightColor`. GL_DrawAliasFrame
reads `shadelightColor` instead of the scalar `shadelight` for its
`qglColor3f` call. Classic maps and gl_coloredlight 0 give `lightcolor`
identical values in all three channels (see gl_rlight.ts's header), so
`shadelightColor` ends up `[shadelight, shadelight, shadelight]` and the
rendered color is byte-identical to before -- the per-channel replay is
pure duplication of the classic arithmetic, not a different curve. The
per-dlight `add` term does not depend on channel (classic dlights stay
white), so it is recomputed identically in each of the three passes rather
than cached, trading a few redundant additions for a smaller diff.

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
  VectorCompare,
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
import { IT_INVISIBILITY, STAT_HEALTH } from "../common/quakedef";
import { qwActive } from "../common/profile";
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
import { MAX_DLIGHTS, MAX_VISEDICTS, NUM_CSHIFTS, cl, cl_dlights, cl_entities, cl_static_entities, cl_visedicts, clState } from "../client/client";
import type { EntityT, ParticleT } from "../client/render";
import { LERP_FINISH, LERP_MOVESTEP, LERP_RESETANIM, LERP_RESETANIM2, LERP_RESETMOVE } from "../client/render";
import { ENTALPHA_DECODE, ENTSCALE_DECODE } from "../common/protocol";
// r_drawentities/r_drawviewmodel/r_fullbright/r_speeds: r_main.c also
// registers these under the same name (render.ts's shared block); imported,
// not redefined, so a Cvar_Set reaches both renderers' objects because there
// is only one object. Re-exported below so existing `from "./gl_rmain"`
// imports (gl_rmisc.ts, test/ref_gl_rsurf.test.ts) keep working.
import { r_drawentities, r_drawviewmodel, r_fullbright, r_lerpmodels, r_lerpmove, r_netgraph, r_origin, r_refdef, r_speeds, vpn, vright, vup } from "../client/render";
export { r_netgraph };
export { r_drawentities, r_drawviewmodel, r_fullbright, r_speeds };
export { r_lerpmodels, r_lerpmove };
// r_wateralpha and its per-content-type overrides moved to
// src/common/render_cvars.ts (U44 -- see that module's header); re-exported
// below so existing `from "./gl_rmain"` imports (gl_rsurf.ts) keep working.
import { r_lavaalpha, r_slimealpha, r_telealpha, r_wateralpha } from "../common/render_cvars";
import { lerpFraction } from "../common/lerp_blend";
export { r_lavaalpha, r_slimealpha, r_telealpha, r_wateralpha };
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
  r_nolerp_list,
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
import { GL_Bind, gl_overbright_models } from "./gl_draw";
// U29: re-release MD5 replacement models -- see gl_md5.ts's own header.
import { GL_DrawMd5AliasFrame, GL_DrawMd5Shadow, GL_Md5PlayerSkin, getMd5GlPayload, r_enhancedmodels } from "./gl_md5";
import { GL_DisableMultitexture, R_DrawBrushModel, R_DrawWaterSurfaces, R_DrawWorld, R_MarkLeaves, R_RenderBrushPoly } from "./gl_rsurf";
import { R_AnimateLight, R_LightPoint, R_RenderDlights, lightcolor, lightspot } from "./gl_rlight";
import { Fog_DisableGFog, Fog_EnableGFog, Fog_SetupFrame } from "./gl_fog";
import { Sky_DrawSkyBox } from "./gl_sky";

// gl_vidlinuxglx.c:75's `cvar_t gl_ztrick = {"gl_ztrick","1"};` (see the
// header note on why the definition lives here and not in gl_vid.ts).
export const gl_ztrick = new CvarT("gl_ztrick", "1");

export const r_norefresh = new CvarT("r_norefresh", "0");
export const r_lightmap = new CvarT("r_lightmap", "0");
export const r_shadows = new CvarT("r_shadows", "0");
export const r_mirroralpha = new CvarT("r_mirroralpha", "1");
// r_wateralpha and its U21 per-content-type overrides (r_lavaalpha/
// r_slimealpha/r_telealpha -- 0 means "not overridden, fall back to
// r_wateralpha"; see R_WaterAlphaForTextureName below, this file's own port
// of QuakeSpasm's GL_WaterAlphaForTextureType) moved to
// src/common/render_cvars.ts (U44 -- see that module's header and this
// file's own import block above). Re-exported under their original names so
// existing `from "./gl_rmain"` imports (gl_rsurf.ts) keep working.
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

// U21 addition, no WinQuake counterpart: QuakeSpasm/Ironwail's
// GL_WaterAlphaForTextureType, ported against a texture NAME rather than a
// dedicated SURF_DRAWLAVA/SURF_DRAWSLIME/SURF_DRAWTELE surface flag --
// src/common/model.ts (out of this unit's SCOPE) only ever sets
// SURF_DRAWTURB for a `*`-prefixed texture, so the lava/slime/teleport
// split has to be read back off the texture's own name at draw time
// instead, exactly the string this port's SURF_DRAWTURB classification
// itself keys on. A cvar of 0 means "not overridden" (QuakeSpasm's own
// convention), so every plain `*`-prefixed water texture and every
// lava/slime/tele texture whose override cvar is 0 falls back to
// r_wateralpha.
export function R_WaterAlphaForTextureName(name: string): number {
  if (name.length > 0 && name[0] === "*") {
    const body = name.slice(1).toLowerCase();
    if (body.includes("lava") && r_lavaalpha.value > 0) return r_lavaalpha.value;
    if (body.includes("slime") && r_slimealpha.value > 0) return r_slimealpha.value;
    if (body.includes("tele") && r_telealpha.value > 0) return r_telealpha.value;
  }
  return r_wateralpha.value;
}

// U21 addition, no WinQuake counterpart: the re-release entity-alpha
// extension (src/common/protocol.ts's ENTALPHA_*). U3 parked the decoded
// byte in a cl_entity_ext/cl_static_entity_ext side table because EntityT
// (src/client/render.ts) had no consumer yet; U16 folds `alpha` onto EntityT
// directly (cl.viewent included, since it is an EntityT too), so this is now
// a one-line decode of the entity's own field.
export function R_EntityAlpha(e: EntityT): number {
  return ENTALPHA_DECODE(e.alpha);
}

// U16 addition, no WinQuake counterpart: nameInList's exact-match,
// comma-separated scan (gl_model.c's Mod_SetExtraFlags), ported at draw time
// instead of as a load-time ModelT flag -- see glquake.ts's r_nolerp_list
// header note on why. Named to match the C for anyone cross-referencing it.
function nameInList(list: string, name: string): boolean {
  return list.split(",").includes(name);
}

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

// U16: johnfitz -- modified to take origin, angles and scale directly
// instead of an entity pointer, matching QuakeSpasm/Ironwail's
// R_RotateForEntity exactly -- callers that need the raw, unlerped
// entity transform still pass e.origin/e.angles (R_DrawBrushModel,
// R_DrawSpriteModel's own orientation math), while R_DrawAliasModel passes
// the lerped transform R_SetupEntityTransform computed. `scale` is the raw
// ENTSCALE_ENCODE byte (0 means "use ENTSCALE_DEFAULT", matching
// ENTSCALE_DECODE's own convention); a decoded scale of 1.0 skips the
// qglScalef call entirely, so every existing test that never sets an
// entity's scale keeps seeing the exact same GL call sequence.
export function R_RotateForEntity(origin: Vec3, angles: Vec3, scale: number): void {
  const scalefactor = ENTSCALE_DECODE(scale);
  qgl().qglTranslatef(origin[0], origin[1], origin[2]);

  qgl().qglRotatef(angles[1], 0, 0, 1);
  qgl().qglRotatef(-angles[0], 0, 1, 0);
  qgl().qglRotatef(angles[2], 1, 0, 0);
  if (scalefactor !== 1.0) qgl().qglScalef(scalefactor, scalefactor, scalefactor);
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

  // U21 addition, no WinQuake counterpart: see R_EntityAlpha's header note.
  // entAlpha === 1 keeps the original qglColor3f every existing test pins.
  const entAlpha = R_EntityAlpha(currententity);
  if (entAlpha === 1) qgl().qglColor3f(1, 1, 1);
  else qgl().qglColor4f(1, 1, 1, entAlpha);

  // U16 addition, no WinQuake counterpart: the re-release entity-scale
  // extension (QuakeSpasm/Ironwail r_sprite.c's R_DrawSpriteModel). A scale
  // of 1 (ENTSCALE_DEFAULT, the overwhelming common case) multiplies every
  // offset by 1, keeping the exact corner coordinates every existing test
  // pins.
  const entScale = ENTSCALE_DECODE(currententity.scale);

  GL_DisableMultitexture();

  GL_Bind(frame.gl_texturenum);

  qgl().qglEnable(GL_ALPHA_TEST);
  if (entAlpha < 1) qgl().qglEnable(GL_BLEND);
  qgl().qglBegin(GL_QUADS);
  if (qwActive()) {
    // QW/client/gl_rmain.c has this pair twice in a row -- a shipped
    // duplicate-statement bug (see file header), kept exactly as the C has it.
    qgl().qglEnable(GL_ALPHA_TEST);
    qgl().qglBegin(GL_QUADS);
  }

  qgl().qglTexCoord2f(0, 1);
  VectorMA(e.origin, frame.down * entScale, up, spritePoint);
  VectorMA(spritePoint, frame.left * entScale, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglTexCoord2f(0, 0);
  VectorMA(e.origin, frame.up * entScale, up, spritePoint);
  VectorMA(spritePoint, frame.left * entScale, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglTexCoord2f(1, 0);
  VectorMA(e.origin, frame.up * entScale, up, spritePoint);
  VectorMA(spritePoint, frame.right * entScale, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglTexCoord2f(1, 1);
  VectorMA(e.origin, frame.down * entScale, up, spritePoint);
  VectorMA(spritePoint, frame.right * entScale, right, spritePoint);
  qgl().qglVertex3fv(spritePoint);

  qgl().qglEnd();

  if (entAlpha < 1) qgl().qglDisable(GL_BLEND);
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
  // U16: the two poses and the blend fraction R_SetupAliasFrame last handed
  // to GL_DrawAliasFrame, read by R_DrawAliasModel to draw a lerped shadow
  // through the same two poses (replaces the single-pose `lastposenum`).
  lastpose1: number;
  lastpose2: number;
  lastblend: number;
  // U15: per-channel shadelight (see this file's header note); what
  // GL_DrawAliasFrame actually reads.
  shadelightColor: Vec3;
  // U21 addition, no WinQuake counterpart: the entity alpha R_DrawAliasModel
  // resolved for `currententity` this call, read by GL_DrawAliasFrame so a
  // translucent alias model's per-vertex qglColor4f carries the same alpha
  // its qglEnable(GL_BLEND) bracket promised. 1 (opaque) reduces to the
  // classic qglColor3f the existing tests already pin -- see this file's
  // header on why GL_DrawAliasFrame branches on it instead of always
  // emitting qglColor4f.
  alpha: number;
} = {
  shadelight: 0,
  ambientlight: 0,
  shadedots: r_avertexnormal_dots.subarray(0, ANORM_DOTS_ROW),
  lastpose1: 0,
  lastpose2: 0,
  lastblend: 0,
  shadelightColor: vec3(),
  alpha: 1,
};

// U16 addition: R_SetupAliasFrame's two-pose result (QuakeSpasm/Ironwail's
// `lerpdata_t`, the alias-frame half). One reusable object -- R_DrawAliasModel
// is never reentrant, matching this file's other scratch-vector globals
// (aliasDist, aliasMins, ...).
interface AliasFrameLerpT {
  pose1: number;
  pose2: number;
  blend: number;
}
const aliasFrameLerp: AliasFrameLerpT = { pose1: 0, pose2: 0, blend: 0 };

// U16 addition: R_SetupEntityTransform's result (`lerpdata_t`'s transform
// half): the origin/angles to actually draw the model at this frame, which
// for a MOVETYPE_STEP entity under r_lerpmove differ from the entity's own
// (unlerped) origin/angles.
interface EntityTransformLerpT {
  origin: Vec3;
  angles: Vec3;
}
const entityTransformLerp: EntityTransformLerpT = { origin: vec3(), angles: vec3() };
const entityLerpDelta: Vec3 = vec3();

/*
=============
GL_DrawAliasFrame
=============
*/
// U16: rewritten to support lerping (QuakeSpasm/Ironwail's r_alias.c
// GL_DrawAliasFrame, ported into this file's immediate-mode structure --
// see this file's header). `pose1 === pose2` (paused animation, or lerping
// disabled for this model/r_lerpmodels 0) skips the blend entirely and
// reduces to the previous single-pose body every existing test pins.
export function GL_DrawAliasFrame(paliashdr: AliashdrT, pose1: number, pose2: number, blend: number): void {
  rmainState.lastpose1 = pose1;
  rmainState.lastpose2 = pose2;
  rmainState.lastblend = blend;

  const lerping = pose1 !== pose2;
  const iblend = 1.0 - blend;

  const posedata = paliashdr.posedata;
  let vertnum1 = pose1 * paliashdr.poseverts;
  let vertnum2 = pose2 * paliashdr.poseverts;
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
      const verts1 = posedata[vertnum1];
      const verts2 = posedata[vertnum2];
      // U15: per-channel shadelight (see this file's header note); reduces
      // to the classic `qglColor3f(l, l, l)` whenever color is not active.
      const dot = lerping ? rmainState.shadedots[verts1.lightnormalindex] * iblend + rmainState.shadedots[verts2.lightnormalindex] * blend : rmainState.shadedots[verts1.lightnormalindex];
      if (rmainState.alpha === 1) qgl().qglColor3f(dot * rmainState.shadelightColor[0], dot * rmainState.shadelightColor[1], dot * rmainState.shadelightColor[2]);
      else qgl().qglColor4f(dot * rmainState.shadelightColor[0], dot * rmainState.shadelightColor[1], dot * rmainState.shadelightColor[2], rmainState.alpha);
      if (lerping) qgl().qglVertex3f(verts1.v[0] * iblend + verts2.v[0] * blend, verts1.v[1] * iblend + verts2.v[1] * blend, verts1.v[2] * iblend + verts2.v[2] * blend);
      else qgl().qglVertex3f(verts1.v[0], verts1.v[1], verts1.v[2]);
      vertnum1++;
      vertnum2++;
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
// U16: reads the same two poses and blend fraction GL_DrawAliasFrame's main
// draw used for this entity this frame (rmainState.lastpose1/2/blend), so
// the shadow follows the lerped animation instead of snapping between poses.
// QuakeSpasm/Ironwail's own GL_DrawAliasShadow shares GL_DrawAliasFrame's
// vertex loop outright (`shading = false`) and lets its shadow MATRIX do the
// skew; this port's GL_DrawAliasShadow has always computed the skewed point
// by hand per vertex (WinQuake/original GLQuake style), so the two-pose
// blend is folded into that same per-vertex computation instead.
export function GL_DrawAliasShadow(paliashdr: AliashdrT, pose1: number, pose2: number, blend: number): void {
  const currententity = glState.currententity;
  if (currententity === null) Sys_Error("GL_DrawAliasShadow: no current entity");

  const lheight = currententity.origin[2] - lightspot[2];
  const lerping = pose1 !== pose2;
  const iblend = 1.0 - blend;

  const posedata = paliashdr.posedata;
  let vertnum1 = pose1 * paliashdr.poseverts;
  let vertnum2 = pose2 * paliashdr.poseverts;
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
      const verts1 = posedata[vertnum1];
      const verts2 = posedata[vertnum2];
      const vx = lerping ? verts1.v[0] * iblend + verts2.v[0] * blend : verts1.v[0];
      const vy = lerping ? verts1.v[1] * iblend + verts2.v[1] * blend : verts1.v[1];
      const vz = lerping ? verts1.v[2] * iblend + verts2.v[2] * blend : verts1.v[2];

      shadowPoint[0] = vx * paliashdr.scale[0] + paliashdr.scale_origin[0];
      shadowPoint[1] = vy * paliashdr.scale[1] + paliashdr.scale_origin[1];
      shadowPoint[2] = vz * paliashdr.scale[2] + paliashdr.scale_origin[2];

      shadowPoint[0] -= shadevector[0] * (shadowPoint[2] + lheight);
      shadowPoint[1] -= shadevector[1] * (shadowPoint[2] + lheight);
      shadowPoint[2] = height;
      //			height -= 0.001;
      qgl().qglVertex3fv(shadowPoint);

      vertnum1++;
      vertnum2++;
    } while (--count);

    qgl().qglEnd();
  }
}

/*
=================
R_SetupAliasFrame -- U16: johnfitz -- rewritten to support lerping
(QuakeSpasm/Ironwail r_alias.c). Updates `e`'s lerp bookkeeping fields and
fills `lerpdata` with the two poses and blend fraction GL_DrawAliasFrame /
GL_DrawAliasShadow should draw through.
=================
*/
export function R_SetupAliasFrame(e: EntityT, frameIn: number, paliashdr: AliashdrT, noLerp: boolean, lerpdata: AliasFrameLerpT): void {
  let frame = frameIn;
  if (frame >= paliashdr.numframes || frame < 0) {
    Con_DPrintf("R_AliasSetupFrame: no such frame %d\n", frame);
    frame = 0;
  }

  const numposes = paliashdr.frames[frame].numposes;
  let posenum = paliashdr.frames[frame].firstpose;

  if (numposes > 1) {
    e.lerptime = paliashdr.frames[frame].interval;
    posenum += ((cl.time / e.lerptime) | 0) % numposes;
  } else {
    e.lerptime = 0.1;
  }

  // A previouspose/currentpose left over from a DIFFERENT model (the entity
  // slot was reused, or cl.viewent switched weapons) indexes paliashdr's
  // posedata out of range, which GL_DrawAliasFrame would read as undefined
  // verts. Treat it exactly as LERP_RESETANIM does below.
  const staleposes =
    e.previouspose < 0 || e.previouspose >= paliashdr.numposes || e.currentpose < 0 || e.currentpose >= paliashdr.numposes;

  if (e.lerpflags & LERP_RESETANIM || staleposes) {
    // kill any lerp in progress
    e.lerpstart = 0;
    e.previouspose = posenum;
    e.currentpose = posenum;
    e.lerpflags &= ~LERP_RESETANIM;
  } else if (e.currentpose !== posenum) {
    // pose changed, start a new lerp
    if (e.lerpflags & LERP_RESETANIM2) {
      // defer lerping one more time
      e.lerpstart = 0;
      e.previouspose = posenum;
      e.currentpose = posenum;
      e.lerpflags &= ~LERP_RESETANIM2;
    } else {
      e.lerpstart = cl.time;
      e.previouspose = e.currentpose;
      e.currentpose = posenum;
    }
  }

  if (r_lerpmodels.value && !(noLerp && r_lerpmodels.value !== 2)) {
    if (e.lerpflags & LERP_FINISH && numposes === 1) lerpdata.blend = lerpFraction(cl.time, e.lerpstart, e.lerpfinish);
    else lerpdata.blend = lerpFraction(cl.time, e.lerpstart, e.lerpstart + e.lerptime);
    if (lerpdata.blend === 1.0) e.previouspose = e.currentpose;
    lerpdata.pose1 = e.previouspose;
    lerpdata.pose2 = e.currentpose;
  } else {
    // poses the same means either 1. the entity has paused its animation, or
    // 2. r_lerpmodels is disabled
    lerpdata.blend = 1;
    lerpdata.pose1 = e.currentpose;
    lerpdata.pose2 = e.currentpose;
  }
}

/*
=================
R_SetupEntityTransform -- U16: johnfitz -- set up the transform half of
lerpdata (QuakeSpasm/Ironwail r_alias.c). Under r_lerpmove, a MOVETYPE_STEP
entity (LERP_MOVESTEP, set by CL_ParseUpdate's U_STEP bit) draws at a
position blended between the last two origins/angles CL_RelinkEntities
recorded into `e.currentorigin`/`e.previousorigin`, instead of at `e.origin`
directly; every other entity (and cl.viewent, which this never lerps) draws
at its own raw origin/angles, unchanged.
=================
*/
export function R_SetupEntityTransform(e: EntityT, lerpdata: EntityTransformLerpT): void {
  if (e.lerpflags & LERP_RESETMOVE) {
    // kill any lerps in progress
    e.movelerpstart = 0;
    VectorCopy(e.origin, e.previousorigin);
    VectorCopy(e.origin, e.currentorigin);
    VectorCopy(e.angles, e.previousangles);
    VectorCopy(e.angles, e.currentangles);
    e.lerpflags &= ~LERP_RESETMOVE;
  } else if (!VectorCompare(e.origin, e.currentorigin) || !VectorCompare(e.angles, e.currentangles)) {
    // origin/angles changed, start a new lerp
    e.movelerpstart = cl.time;
    VectorCopy(e.currentorigin, e.previousorigin);
    VectorCopy(e.origin, e.currentorigin);
    VectorCopy(e.currentangles, e.previousangles);
    VectorCopy(e.angles, e.currentangles);
  }

  // set up values
  if (r_lerpmove.value && e !== cl.viewent && e.lerpflags & LERP_MOVESTEP) {
    let blend: number;
    if (e.lerpflags & LERP_FINISH) blend = lerpFraction(cl.time, e.movelerpstart, e.lerpfinish);
    else blend = lerpFraction(cl.time, e.movelerpstart, e.movelerpstart + 0.1);

    // translation
    VectorSubtract(e.currentorigin, e.previousorigin, entityLerpDelta);
    lerpdata.origin[0] = e.previousorigin[0] + entityLerpDelta[0] * blend;
    lerpdata.origin[1] = e.previousorigin[1] + entityLerpDelta[1] * blend;
    lerpdata.origin[2] = e.previousorigin[2] + entityLerpDelta[2] * blend;

    // rotation
    VectorSubtract(e.currentangles, e.previousangles, entityLerpDelta);
    for (let i = 0; i < 3; i++) {
      if (entityLerpDelta[i] > 180) entityLerpDelta[i] -= 360;
      if (entityLerpDelta[i] < -180) entityLerpDelta[i] += 360;
    }
    lerpdata.angles[0] = e.previousangles[0] + entityLerpDelta[0] * blend;
    lerpdata.angles[1] = e.previousangles[1] + entityLerpDelta[1] * blend;
    lerpdata.angles[2] = e.previousangles[2] + entityLerpDelta[2] * blend;
  } else {
    // don't lerp
    VectorCopy(e.origin, lerpdata.origin);
    VectorCopy(e.angles, lerpdata.angles);
  }
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

  // U21 addition, no WinQuake counterpart: see this file's header note on
  // R_EntityAlpha / rmainState.alpha.
  const entAlpha = R_EntityAlpha(currententity);

  const clmodel = currententity.model;
  if (clmodel === null) Sys_Error("R_DrawAliasModel: NULL model");

  // U16: set up pose/lerp data first, before culling -- QuakeSpasm/Ironwail's
  // R_DrawAliasModel does the same ("so we don't miss updates due to
  // culling"): R_SetupAliasFrame/R_SetupEntityTransform mutate `e`'s own
  // lerp bookkeeping (lerpstart/previouspose/currentorigin/...), and an
  // early return below must not skip that or the entity's lerp desyncs the
  // next time it is actually drawn.
  const extradataForLerp = Mod_Extradata(clmodel);
  if (!(extradataForLerp instanceof AliashdrT)) Sys_Error("R_DrawAliasModel: not an alias model");
  const noLerpModel = nameInList(r_nolerp_list.string, clmodel.name);
  R_SetupAliasFrame(currententity, currententity.frame, extradataForLerp, noLerpModel, aliasFrameLerp);
  R_SetupEntityTransform(currententity, entityTransformLerp);

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
  if (qwActive()) {
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

  // U15: replay the exact same clamp/hack sequence per channel, seeded from
  // gl_rlight.ts's `lightcolor` (the RGB sample the R_LightPoint call above
  // just took, or the grey value replicated across all three channels when
  // gl_coloredlight is off or the map carries no RGB data -- see this
  // file's header note).
  for (let c = 0; c < 3; c++) {
    let ambientc = lightcolor[c];
    let shadec = lightcolor[c];

    if (e === cl.viewent && ambientc < 24) ambientc = shadec = 24;

    for (let lnum = 0; lnum < MAX_DLIGHTS; lnum++) {
      if (cl_dlights[lnum].die >= cl.time) {
        VectorSubtract(currententity.origin, cl_dlights[lnum].origin, aliasDist);
        const add = cl_dlights[lnum].radius - Length(aliasDist);
        if (add > 0) {
          ambientc += add;
          shadec += add;
        }
      }
    }

    if (ambientc > 128) ambientc = 128;
    if (ambientc + shadec > 192) shadec = 192 - ambientc;

    if (qwActive()) {
      if (clmodel.name === "progs/player.mdl") {
        if (ambientc < 8) ambientc = shadec = 8;
      } else if (clmodel.name === "progs/flame2.mdl" || clmodel.name === "progs/flame.mdl") {
        ambientc = shadec = 256;
      }
    } else {
      if (i >= 1 && i <= cl.maxclients) {
        if (ambientc < 8) ambientc = shadec = 8;
      }
      if (clmodel.name === "progs/flame2.mdl" || clmodel.name === "progs/flame.mdl") ambientc = shadec = 256;
    }

    rmainState.shadelightColor[c] = shadec / 200.0;
    // QuakeSpasm/Ironwail gl_overbright_models (default on, as in the
    // re-release's own look): GLQuake's models sit at a third of the room's
    // brightness on a lit floor ("bright room, dark model", P9 2026-09-07);
    // the modern engines double the model light and let the framebuffer
    // clamp. The cvar was registered but never read before this.
    if (gl_overbright_models.value) rmainState.shadelightColor[c] *= 2;
  }

  const an = (e.angles[1] / 180) * M_PI;
  shadevector[0] = Math.cos(-an);
  shadevector[1] = Math.sin(-an);
  shadevector[2] = 1;
  VectorNormalize(shadevector);

  //
  // locate the proper data
  //
  // C: Mod_Extradata (currententity->model) -- already fetched above, before
  // culling, as `extradataForLerp`.
  const paliashdr = extradataForLerp;

  glState.c_alias_polys += paliashdr.numtris;

  // U29: an attached MD5 replacement takes over the "translate/scale +
  // bind + draw" portion of this function once the classic setup above
  // (lerp bookkeeping, culling, lighting, shadevector) is in place -- see
  // gl_md5.ts's header (TRANSFORM) for why the scale_origin/scale
  // decompression pair below is skipped for it. U35 gives it a shadow too --
  // see gl_md5.ts's header (SHADOW) and this function's own r_shadows block
  // below.
  const md5Payload = r_enhancedmodels.value ? getMd5GlPayload(paliashdr) : null;

  //
  // draw all the triangles
  //

  GL_DisableMultitexture();

  qgl().qglPushMatrix();
  // U16: the lerped transform (raw origin/angles for everything but a
  // MOVETYPE_STEP entity under r_lerpmove -- see R_SetupEntityTransform's
  // header), with the entity's own ENTSCALE_DECODE scale applied on top.
  R_RotateForEntity(entityTransformLerp.origin, entityTransformLerp.angles, currententity.scale);

  if (md5Payload) {
    // md5Skin's output is already real model-space floats -- no
    // scale_origin/scale byte-decompression translate/scale on top (see
    // this function's own U29 comment above).
  } else if (clmodel.name === "progs/eyes.mdl" && (qwActive() || gl_doubleeyes.value)) {
    // QW/client/gl_rmain.c drops the gl_doubleeyes guard entirely (see file
    // header) -- the eyes.mdl special case always applies when qw.active.
    qgl().qglTranslatef(paliashdr.scale_origin[0], paliashdr.scale_origin[1], paliashdr.scale_origin[2] - (22 + 8));
    // double size of eyes, since they are really hard to see in gl
    qgl().qglScalef(paliashdr.scale[0] * 2, paliashdr.scale[1] * 2, paliashdr.scale[2] * 2);
  } else {
    qgl().qglTranslatef(paliashdr.scale_origin[0], paliashdr.scale_origin[1], paliashdr.scale_origin[2]);
    qgl().qglScalef(paliashdr.scale[0], paliashdr.scale[1], paliashdr.scale[2]);
  }

  if (!md5Payload) {
    const anim = ((cl.time * 10) | 0) & 3;
    GL_Bind(paliashdr.gl_texturenum[currententity.skinnum * 4 + anim]);

    // we can't dynamically colormap textures, so they are cached
    // seperately for the players.  Heads are just uncolored. (MD5
    // replacements carry no player-recolor concept -- r_md5.ts's own skin
    // rule loads exactly mdl.numskins .lmp files and nothing else -- so
    // this whole block, and its own texture bind, is skipped on that path;
    // GL_DrawMd5AliasFrame below binds the MD5 skin unconditionally.)
    if (qwActive()) {
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
  }

  if (gl_smoothmodels.value) qgl().qglShadeModel(GL_SMOOTH);
  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);

  if (gl_affinemodels.value) qgl().qglHint(GL_PERSPECTIVE_CORRECTION_HINT, GL_FASTEST);

  // U21 addition, no WinQuake counterpart: entAlpha === 1 (the overwhelming
  // common case) takes the untouched original path -- qglDepthMask/
  // GL_BLEND never toggle, and GL_DrawAliasFrame's rmainState.alpha === 1
  // branch keeps emitting the classic qglColor3f every existing test pins.
  if (entAlpha < 1) {
    qgl().qglDepthMask(false);
    qgl().qglEnable(GL_BLEND);
  }
  rmainState.alpha = entAlpha;

  if (md5Payload) {
    // the classic playertextures rule (the `!md5Payload` block above) for a
    // player-slot entity drawn through its MD5 replacement: bind that slot's
    // colour-translated copy of the MD5 skin (P14).
    let playerSkin: number | null = null;
    if (!qwActive() && currententity.colormap !== vid.colormap && !gl_nocolors.value) {
      const slot = cl_entities.indexOf(currententity);
      if (slot >= 1 && slot <= cl.maxclients) playerSkin = GL_Md5PlayerSkin(md5Payload, currententity.skinnum, slot - 1, cl.scores[slot - 1]?.colors ?? 0);
    }
    GL_DrawMd5AliasFrame(md5Payload, currententity, aliasFrameLerp.pose1, aliasFrameLerp.pose2, aliasFrameLerp.blend, shadevector, rmainState.shadelightColor, rmainState.alpha, playerSkin);
    rmainState.lastpose1 = aliasFrameLerp.pose1;
    rmainState.lastpose2 = aliasFrameLerp.pose2;
    rmainState.lastblend = aliasFrameLerp.blend;
  } else {
    GL_DrawAliasFrame(paliashdr, aliasFrameLerp.pose1, aliasFrameLerp.pose2, aliasFrameLerp.blend);
  }

  rmainState.alpha = 1;
  if (entAlpha < 1) {
    qgl().qglDisable(GL_BLEND);
    qgl().qglDepthMask(true);
  }

  qgl().qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);

  qgl().qglShadeModel(GL_FLAT);
  if (gl_affinemodels.value) qgl().qglHint(GL_PERSPECTIVE_CORRECTION_HINT, GL_NICEST);

  qgl().qglPopMatrix();

  // U35: an MD5 replacement now gets a shadow too -- gl_md5.ts's own
  // GL_DrawMd5Shadow projects the SAME already-model-space skinned/blended
  // positions GL_DrawMd5AliasFrame just drew above (reusing its scratch, no
  // re-skin), through the identical skew GL_DrawAliasShadow applies to a
  // classic TrivertxT -- see gl_md5.ts's header (SHADOW). The matrix this
  // block sets up (R_RotateForEntity, no scale_origin/scale) is already the
  // correct one for both: the classic path bakes scale_origin/scale into
  // GL_DrawAliasShadow's own per-vertex math instead of a glScalef here (see
  // that function), and MD5 needs no such step at all (TRANSFORM, above).
  if (r_shadows.value) {
    qgl().qglPushMatrix();
    R_RotateForEntity(entityTransformLerp.origin, entityTransformLerp.angles, currententity.scale);
    qgl().qglDisable(GL_TEXTURE_2D);
    qgl().qglEnable(GL_BLEND);
    qgl().qglColor4f(0, 0, 0, 0.5);
    if (md5Payload) GL_DrawMd5Shadow(md5Payload, currententity, shadevector);
    else GL_DrawAliasShadow(paliashdr, rmainState.lastpose1, rmainState.lastpose2, rmainState.lastblend);
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
    // U21 addition: deferred to the alphapass below (see this function's
    // tail note).
    if (R_EntityAlpha(currententity) !== 1) continue;

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
    if (R_EntityAlpha(currententity) !== 1) continue;

    switch (currententity.model.type) {
      case ModtypeT.mod_sprite:
        R_DrawSpriteModel(currententity);
        break;
    }
  }

  // U21 addition, no WinQuake counterpart: QuakeSpasm's R_DrawEntitiesOnList
  // alphapass -- every entity with a non-default alpha draws last, sorted
  // back-to-front by distance from the viewer, so a translucent model
  // correctly shows whatever opaque geometry sits behind it. Mixed model
  // types (alias/brush/sprite) share one back-to-front order here, unlike
  // the two opaque passes above which are split by type for the classic
  // "sprites need their own alpha-blend pass" reason those passes'
  // original comment gives -- translucent draws already carry their own
  // GL_BLEND bracket per model type, so there is no equivalent reason to
  // split this pass by type too.
  const translucent: EntityT[] = [];
  for (i = 0; i < clState.cl_numvisedicts; i++) {
    const currententity = cl_visedicts[i];
    if (!currententity) continue;
    if (!currententity.model) continue;
    if (R_EntityAlpha(currententity) === 1) continue;
    translucent.push(currententity);
  }

  translucent.sort((a, b) => {
    const da = VectorLengthSquared(a.origin, r_refdef.vieworg);
    const db = VectorLengthSquared(b.origin, r_refdef.vieworg);
    return db - da; // far to near
  });

  for (const currententity of translucent) {
    glState.currententity = currententity;
    if (!currententity.model) continue;

    switch (currententity.model.type) {
      case ModtypeT.mod_alias:
        R_DrawAliasModel(currententity);
        break;

      case ModtypeT.mod_brush:
        R_DrawBrushModel(currententity);
        break;

      case ModtypeT.mod_sprite:
        R_DrawSpriteModel(currententity);
        break;

      default:
        break;
    }
  }
}

const alphaSortDist: Vec3 = vec3();

function VectorLengthSquared(a: Vec3, b: Vec3): number {
  VectorSubtract(a, b, alphaSortDist);
  return alphaSortDist[0] * alphaSortDist[0] + alphaSortDist[1] * alphaSortDist[1] + alphaSortDist[2] * alphaSortDist[2];
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
  if (qwActive()) {
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
  if (qwActive() ? cl.stats[STAT_ITEMS] & IT_INVISIBILITY : cl.items & IT_INVISIBILITY) return;

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
  if (qwActive()) {
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

  // U21: fog (Fog_SetupFrame/Fog_EnableGFog/Fog_DisableGFog) and the skybox
  // draw (Sky_DrawSkyBox) bracket this call from R_RenderView instead of
  // from here, so the fog bracket also covers R_DrawWaterSurfaces (called
  // from R_RenderView right after this function returns) -- see
  // R_RenderView's own comment for the exact QuakeSpasm call-site match.
  R_MarkLeaves(); // done here so we know if we're in water

  R_DrawWorld(); // adds static entities to the list

  S_ExtraUpdate(); // don't let sound get messed up if going slow

  R_DrawEntitiesOnList();

  GL_DisableMultitexture();

  R_RenderDlights();

  if (qwActive()) qwRPartMod().R_DrawParticles();
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

  // U21: this is exactly the "Experimental silly looking fog" spot the
  // original comment below marked -- QuakeSpasm's gl_fog.c fills it in for
  // real. Bracketed here (not inside R_RenderScene) so the fog also covers
  // R_DrawWaterSurfaces below, matching QuakeSpasm's R_RenderScene (its own
  // Fog_EnableGFog/Fog_DisableGFog bracket spans R_DrawWorld through
  // R_DrawWorld_Water); R_DrawViewModel is drawn fogged too here, a
  // documented deviation from QuakeSpasm (whose R_DrawViewModel call sits
  // OUTSIDE its own Fog_DisableGFog, i.e. never fogged) traded for not
  // having to reorder this port's existing R_DrawViewModel/
  // R_DrawWaterSurfaces call sequence. Sky_DrawSkyBox draws before the
  // world, outside the fog bracket (it tints its own quads via
  // Fog_GetColor/r_skyfog instead of GL_FOG, since GL_FOG is range-based
  // and a skybox has no meaningful depth -- see gl_sky.ts).
  Sky_DrawSkyBox();
  Fog_SetupFrame();
  Fog_EnableGFog();

  R_RenderScene();
  R_DrawViewModel();
  R_DrawWaterSurfaces();

  Fog_DisableGFog();
  //  End of all fog code...

  // render mirror view
  // QW/client/gl_rmain.c: R_Mirror's whole body is #if 0'd out and this call
  // is commented out (see file header) -- mirrors are disabled under QW.
  if (!qwActive()) R_Mirror();

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
