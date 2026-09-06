/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/render.h and WinQuake/draw.h (GNU GPL v2 or later).

refresh.h -- public interface to refresh functions

This module is the renderer seam PORTING.md's "Renderer seam" section rules on:
`interface Renderer` is this port's `refexport_t`. WinQuake has no such
interface -- it links either the r_*.c/d_*.c software renderer or the gl_*.c
OpenGL renderer and resolves every call at link time. This port compiles both
in and picks one at runtime from the `vid_ref` cvar, so every function a client
module calls that has two C bodies (or one body under `#ifdef GLQUAKE`) becomes
a method here. `re.current` holds the active renderer; `getRenderer()` is the
accessor. Nothing outside src/ref_soft and src/ref_gl imports either renderer,
except src/platform/vid.ts, which installs one.

Where each Renderer method comes from, and which C file implements it:

  render.h prototypes
    R_Init                  r_main.c        / gl_rmisc.c
    R_InitTextures          r_main.c        / gl_rmisc.c
    R_InitEfrags            (declared in render.h; NO .c in v1.09 defines it.
                             Kept so the interface is render.h's full surface;
                             both renderers implement it empty.)
    R_RenderView            r_main.c        / gl_rmain.c
    R_ViewChanged           r_main.c        / (GL has none: empty)
    R_InitSky               r_sky.c         / gl_warp.c
    R_AddEfrags             r_efrag.c       / gl_refrag.c
    R_RemoveEfrags          r_efrag.c       / gl_refrag.c
    R_NewMap                r_main.c        / gl_rmisc.c
    R_PushDlights           r_light.c       / gl_rlight.c
    R_SetVrect              r_main.c        / (GL has none: empty)
    r_cache_thrash          r_misc.c        / gl_rmain.c  (SCR_DrawRam reads it)
    D_SurfaceCacheForRes    d_surf.c        / (GL has none: returns 0)
    D_InitCaches            d_surf.c        / (GL has none: empty)
    D_FlushCaches           d_surf.c        / gl_rmisc.c
    D_DeleteSurfaceCache    d_surf.c        / (GL has none: empty)

  draw.h prototypes
    Draw_Init               draw.c          / gl_draw.c
    Draw_Character          draw.c          / gl_draw.c
    Draw_DebugChar          draw.c          / gl_draw.c
    Draw_Pic                draw.c          / gl_draw.c
    Draw_TransPic           draw.c          / gl_draw.c
    Draw_TransPicTranslate  draw.c          / gl_draw.c
    Draw_ConsoleBackground  draw.c          / gl_draw.c
    Draw_BeginDisc          draw.c          / gl_draw.c
    Draw_EndDisc            draw.c          / gl_draw.c
    Draw_TileClear          draw.c          / gl_draw.c
    Draw_Fill               draw.c          / gl_draw.c
    Draw_FadeScreen         draw.c          / gl_draw.c
    Draw_String             draw.c          / gl_draw.c
    Draw_PicFromWad         draw.c          / gl_draw.c
    Draw_CachePic           draw.c          / gl_draw.c
    draw_disc               draw.c          / gl_draw.c  (sbar.c reads it)

  d_iface.h prototypes r_part.c's R_DrawParticles calls (see the GLQUAKE table)
    D_StartParticles        d_part.c        / gl (the R_DrawParticles prologue)
    D_DrawParticle          d_part.c        / gl (the per-particle triangle)
    D_EndParticles          d_part.c        / gl (the R_DrawParticles epilogue)

  every `#ifdef GLQUAKE` site in a client .c file, and the method that absorbs
  it (all of these are ADDITIONS beyond render.h/draw.h):

    view.c:481  V_CalcBlend             -> V_CalcBlend
                (GL-only. Builds gl_rmain.c's `v_blend[4]`, which R_PolyBlend
                 reads; both live entirely inside ref_gl. Software: empty.)
    view.c:526  V_UpdatePalette (GL)    -> V_UpdatePalette
    view.c:613  V_UpdatePalette (!GL)   -> V_UpdatePalette
                (Two full C bodies sharing a prologue. One method, one body per
                 renderer, exactly as the C duplicates it; view.ts (U045)
                 exports the shared V_CalcPowerupCshift / V_CheckGamma /
                 gammatable that both bodies call.)
    view.c:1056 the !GLQUAKE crosshair  -> V_DrawCrosshair
                (V_RenderView's tail: `Draw_Character(scr_vrect.x +
                 scr_vrect.width/2 + cl_crossx.value, ... , '+')`. GL: empty.)
    gl_screen.c:906 the GL crosshair    -> SCR_DrawCrosshair
                (SCR_UpdateScreen's else-branch: same '+' with no cl_crossx /
                 cl_crossy offset. Software: empty. Two methods, because the
                 two C call sites are in different functions and drawing at
                 both would draw the crosshair twice.)
    cl_parse.c:394,418,643 R_TranslatePlayerSkin -> R_TranslatePlayerSkin
                (gl_rmisc.c. Software: empty.)
    screen.c:219 / gl_screen.c:255 SCR_CalcRefdef -> SCR_CalcRefdef
                (`static` in both, and the two bodies diverge past the viewsize
                 and fov bounds: software calls R_SetVrect + R_ViewChanged, GL
                 computes r_refdef.vrect inline with its own `full` and 96-pixel
                 minimum rules and copies it into scr_vrect.)
    screen.c:869/886/903/936 D_EnableBackBufferAccess /
                D_DisableBackBufferAccess -> the same two names
                (d_vars.c. GL: empty.)
    screen.c:940 D_UpdateRects(pconupdate) -> D_UpdateRects
                (d_edge.c. GL: empty. `pconupdate` is screen.c's own vrect_t*
                 and is only ever NULL in v1.09; the call is ported anyway.)
    gl_screen.c:823,848 `vid.numpages = 2 + gl_triplebuffer.value;` and
                GL_BeginRendering -> BeginFrame
    gl_screen.c:934 GL_EndRendering / screen.c:945-981 the
                scr_copyeverything / scr_copytop / scr_vrect three-way
                `VID_Update (&vrect)` -> EndFrame
                (the frame bracketing PORTING.md names. Software's EndFrame
                 reads screen_types.ts's scrState and calls the vid backend's
                 VID_Update; GL's calls GL_EndRendering.)
    gl_screen.c:873 GL_Set2D            -> GL_Set2D
                (gl_draw.c. Software: empty.)
    gl_screen.c:879 SCR_TileClear       -> SCR_TileClear
                (gl_screen.c's four border rects. screen.c has no equivalent --
                 it clears through Draw_TileClear inside its own
                 `scr_fullupdate++ < vid.numpages` branch -- so software: empty.)
    screen.c:613 / gl_screen.c:592 SCR_ScreenShot_f -> SCR_ScreenShot_f
                (software writes a PCX off vid.buffer, GL a TGA off
                 glReadPixels.)
    host.c:899  `#ifdef GLQUAKE S_Init();` -- DROPPED, not a seam method. It
                sits inside `#if defined(_WIN32)`, and PORTING.md's rule is to
                take the non-_WIN32 path, where S_Init is called
                unconditionally a few lines above.
    r_part.c:659,712,792 the three GLQUAKE halves of R_DrawParticles ->
                D_StartParticles / D_DrawParticle / D_EndParticles
                (PORTING.md: "Particle *simulation* stays in
                 src/client/r_part.ts; only drawing crosses the seam.")

Deviations from PORTING.md / the C source:
- `efrag_t` -> `EfragT` is defined HERE (render.h declares it), not in
  src/common/model.ts. model.ts landed first and had no entity_t to point at,
  so it types `MleafT.efrags` as `export type EfragT = unknown`. Follow-up:
  model.ts should drop its placeholder and `import type { EfragT } from
  "../client/render"`; until it does, r_bsp.ts/gl_rsurf.ts must narrow
  `pleaf.efrags` before calling R_StoreEfrags on it.
- `particle_t`/`ptype_t` are defined here as `ParticleT`/`PtypeT`. In the C
  they are in d_iface.h and glquake.h -- byte-identical copies, one per
  renderer -- but they are the argument type of a seam method
  (`D_DrawParticle`) and src/client/r_part.ts (U053) owns the particle list, so
  a renderer header cannot own them in this port. r_part.ts imports them here.
- `Renderer.modelHooks` is the `ModelLoaderHooks` object src/common/model.ts
  already declares (PORTING.md, "Model loading"). Carrying it on the Renderer
  means src/platform/vid.ts installs the loader hooks and the renderer together
  in one step, so a mid-session `vid_ref` switch cannot leave the model loader
  pointing at the renderer that was just torn down.
- `R_SetVrect`'s parameters are `(vrect_t *pvrect, vrect_t *pvrectin, int
  lineadj)` in render.h but `(vrect_t *pvrectin, vrect_t *pvrect, int lineadj)`
  in r_main.c's definition, and screen.c calls it with (in, out, lineadj). The
  .c order is the one ported.
- `r_notexture_mip` (render.h) is NOT a member here: model.ts's
  `ModelLoaderHooks.notexture` already is it, reachable as
  `re.current.modelHooks.notexture`.
- Not ported here, with the module that owns each:
  * R_ParseParticleEffect, R_RunParticleEffect, R_RocketTrail,
    R_EntityParticles, R_BlobExplosion, R_ParticleExplosion,
    R_ParticleExplosion2, R_LavaSplash, R_TeleportSplash, R_InitParticles,
    R_ClearParticles, R_ReadPointFile_f, R_DrawParticles -- render.h declares
    the first nine, but all thirteen are r_part.c, which PORTING.md keeps
    client-side: src/client/r_part.ts (U053). Both renderers' R_Init and
    R_RenderView call into it.
  * R_TimeRefresh_f (r_misc.c / gl_rmisc.c) and R_CheckVariables (r_misc.c):
    renderer-internal. R_TimeRefresh_f is only ever reached through the
    `timerefresh` command each renderer's own R_Init registers, and
    R_CheckVariables only through the software R_SetupFrame.
  * `reinit_surfcache` (r_main.c) and `r_worldentity` (gl_rmain.c): read by no
    client file, so each stays inside its renderer.
  * MAXCLIPPLANES (render.h) is r_local.h's clipping budget, used only by
    r_bsp.c/r_edge.c: src/ref_soft/r_local.ts.
  * `V_UpdatePalette`'s helpers (V_CalcPowerupCshift, V_CheckGamma,
    BuildGammaTable, gammatable, v_gamma, gl_cshiftpercent, crosshair,
    cl_crossx, cl_crossy): src/client/view.ts (U045).
- Dropped `#ifdef QUAKE2` blocks: render.h's `R_DarkFieldParticles`.
- `EntityT.keynum` / `EntityT.scoreboard` are QW/client/render.h's two extra
  entity_t members (frame-to-frame entity matching for the particle trails,
  and the player_info_t the QW renderers read for a custom skin). WinQuake's
  entity_t has neither; both are inert on the WinQuake path (nothing outside
  src/qw writes them) and carried here so src/ref_soft/r_alias.ts,
  src/ref_gl/gl_rmain.ts and src/qw/client/cl_ents.ts all read one store
  instead of a parallel side table. `PlayerInfoT` is a type-only import, so
  no src/qw module is loaded by importing this one.
- `Renderer.isGL` is this port's runtime stand-in for the C's compile-time
  `#ifdef GLQUAKE` in a *client* file. WinQuake and QW both build two
  binaries whose client .c files branch on that macro; this port compiles
  both renderers in and picks one at runtime, so the client files ask the
  installed renderer. The GLQUAKE sites already ported as seam *methods* stay
  methods (a method has two bodies); `isGL` covers the sites whose GL branch
  reads a GL-renderer-private cvar with no method to hang it on
  (src/qw/client/cl_ents.ts's and cl_parse.ts's `gl_flashblend`,
  src/qw/client/skin.ts's `sc->skin = NULL`).
- `Renderer.R_NetGraph` is optional because QW's two renderers call it from
  different places: r_main.c calls it at the end of R_RenderView (renderer-
  internal, wired inside src/ref_soft/r_main.ts) while gl_screen.c calls it
  from SCR_UpdateScreen, a client file (src/qw/client/screen.ts). Only the GL
  renderer implements the member; the software renderer leaves it undefined,
  so the client-side call site is a no-op there and the graph is drawn
  exactly once under either renderer.
*/

import { CvarT } from "../common/cvar";
import { EntityStateT } from "../common/quakedef";
import type { MleafT, ModelLoaderHooks, ModelT, MnodeT, TextureT } from "../common/model";
import type { QpicT } from "../common/wad";
import type { PlayerInfoT } from "../qw/client/client";
import { type Vec3, vec3 } from "../common/mathlib";
import { Sys_Error } from "../platform/sys";
import { VrectT } from "./vid";

export const TOP_RANGE = 16; // soldier uniform colors
export const BOTTOM_RANGE = 96;

//=============================================================================

export class EfragT {
  leaf: MleafT | null = null;
  leafnext: EfragT | null = null;
  entity: EntityT | null = null;
  entnext: EfragT | null = null;
}

export class EntityT {
  forcelink = false; // model changed

  update_type = 0;

  baseline: EntityStateT = new EntityStateT(); // to fill in defaults in updates

  msgtime = 0; // time of last update
  msg_origins: [Vec3, Vec3] = [vec3(), vec3()]; // last two updates (0 is newest)
  origin: Vec3 = vec3();
  msg_angles: [Vec3, Vec3] = [vec3(), vec3()]; // last two updates (0 is newest)
  angles: Vec3 = vec3();
  model: ModelT | null = null; // NULL = no model
  efrag: EfragT | null = null; // linked list of efrags
  frame = 0;
  syncbase = 0; // for client-side animations
  colormap: Uint8Array | null = null;
  effects = 0; // light, particals, etc
  skinnum = 0; // for Alias models

  keynum = 0; // for matching entities in different frames

  scoreboard: PlayerInfoT | null = null; // identify player

  visframe = 0; // last frame this entity was
  //  found in an active leaf

  dlightframe = 0; // dynamic lighting
  dlightbits = 0;

  // FIXME: could turn these into a union
  trivial_accept = 0;
  topnode: MnodeT | MleafT | null = null; // for bmodels, first world node (mnode_t * in C, but a leaf when the bbox never straddles a plane)
  //  that splits bmodel, or NULL if
  //  not split

  clear(): void {
    this.forcelink = false;
    this.update_type = 0;
    this.baseline.clear();
    this.msgtime = 0;
    this.msg_origins[0][0] = this.msg_origins[0][1] = this.msg_origins[0][2] = 0;
    this.msg_origins[1][0] = this.msg_origins[1][1] = this.msg_origins[1][2] = 0;
    this.origin[0] = this.origin[1] = this.origin[2] = 0;
    this.msg_angles[0][0] = this.msg_angles[0][1] = this.msg_angles[0][2] = 0;
    this.msg_angles[1][0] = this.msg_angles[1][1] = this.msg_angles[1][2] = 0;
    this.angles[0] = this.angles[1] = this.angles[2] = 0;
    this.model = null;
    this.efrag = null;
    this.frame = 0;
    this.syncbase = 0;
    this.colormap = null;
    this.effects = 0;
    this.skinnum = 0;
    this.keynum = 0;
    this.scoreboard = null;
    this.visframe = 0;
    this.dlightframe = 0;
    this.dlightbits = 0;
    this.trivial_accept = 0;
    this.topnode = null;
  }

  // QW/client/client.h:367 declares `entity_t cl_visedicts_list[2][MAX_VISEDICTS]`
  // by VALUE, so QW/client/r_efrag.c:261's `cl_visedicts[cl_numvisedicts++] =
  // *pent;` is a whole-struct copy where WinQuake/r_efrag.c:261 stores a bare
  // pointer into its `entity_t *cl_visedicts[MAX_VISEDICTS]`. This is that copy.
  copyFrom(src: EntityT): void {
    this.forcelink = src.forcelink;
    this.update_type = src.update_type;
    this.baseline.copyFrom(src.baseline);
    this.msgtime = src.msgtime;
    for (let i = 0; i < 3; i++) {
      this.msg_origins[0][i] = src.msg_origins[0][i];
      this.msg_origins[1][i] = src.msg_origins[1][i];
      this.origin[i] = src.origin[i];
      this.msg_angles[0][i] = src.msg_angles[0][i];
      this.msg_angles[1][i] = src.msg_angles[1][i];
      this.angles[i] = src.angles[i];
    }
    this.model = src.model;
    this.efrag = src.efrag;
    this.frame = src.frame;
    this.syncbase = src.syncbase;
    this.colormap = src.colormap;
    this.effects = src.effects;
    this.skinnum = src.skinnum;
    this.keynum = src.keynum;
    this.scoreboard = src.scoreboard;
    this.visframe = src.visframe;
    this.dlightframe = src.dlightframe;
    this.dlightbits = src.dlightbits;
    this.trivial_accept = src.trivial_accept;
    this.topnode = src.topnode;
  }
}

// !!! if this is changed, it must be changed in asm_draw.h too !!!
export class RefdefT {
  vrect: VrectT = new VrectT(); // subwindow in video for refresh
  // FIXME: not need vrect next field here?
  aliasvrect: VrectT = new VrectT(); // scaled Alias version
  vrectright = 0; // right & bottom screen coords
  vrectbottom = 0;
  aliasvrectright = 0; // scaled Alias versions
  aliasvrectbottom = 0;
  vrectrightedge = 0; // rightmost right edge we care about,
  //  for use in edge list
  fvrectx = 0; // for floating-point compares
  fvrecty = 0;
  fvrectx_adj = 0; // left and top edges, for clamping
  fvrecty_adj = 0;
  vrect_x_adj_shift20 = 0; // (vrect.x + 0.5 - epsilon) << 20
  vrectright_adj_shift20 = 0; // (vrectright + 0.5 - epsilon) << 20
  fvrectright_adj = 0;
  fvrectbottom_adj = 0;
  // right and bottom edges, for clamping
  fvrectright = 0; // rightmost edge, for Alias clamping
  fvrectbottom = 0; // bottommost edge, for Alias clamping
  horizontalFieldOfView = 0; // at Z = 1.0, this many X is visible
  // 2.0 = 90 degrees
  xOrigin = 0; // should probably allways be 0.5
  yOrigin = 0; // between be around 0.3 to 0.5

  vieworg: Vec3 = vec3();
  viewangles: Vec3 = vec3();

  fov_x = 0;
  fov_y = 0;

  ambientlight = 0;
}

//
// refresh
//

export const r_refdef = new RefdefT();

export const r_origin: Vec3 = vec3();
export const vpn: Vec3 = vec3();
export const vright: Vec3 = vec3();
export const vup: Vec3 = vec3();

//=============================================================================
// cvars both renderers define under the same name; one object, imported by
// both r_main.ts and gl_rmain.ts, so Cvar_Set updates reach whichever
// renderer is active. In the C only one renderer is linked, so the name is
// registered once; here both R_Init functions still call
// Cvar_RegisterVariable on this same object (the second call prints the C's
// "Can't register variable, allready defined" message and is harmless).
// r_main.c and gl_rmain.c agree on every initializer below.
export const r_fullbright = new CvarT("r_fullbright", "0");
export const r_drawentities = new CvarT("r_drawentities", "1");
export const r_drawviewmodel = new CvarT("r_drawviewmodel", "1");
export const r_speeds = new CvarT("r_speeds", "0");
// QW-only (r_main.c:119 / gl_rmain.c:87, same initializer in both). Shared
// here rather than declared twice because src/qw/client/screen.ts reads it
// at gl_screen.c:1145's call site and no client module may import a
// renderer.
export const r_netgraph = new CvarT("r_netgraph", "0");

//=============================================================================
// d_iface.h / glquake.h

export enum PtypeT {
  pt_static = 0,
  pt_grav = 1,
  pt_slowgrav = 2,
  pt_fire = 3,
  pt_explode = 4,
  pt_explode2 = 5,
  pt_blob = 6,
  pt_blob2 = 7,
}

// !!! if this is changed, it must be changed in d_ifacea.h too !!!
export class ParticleT {
  // driver-usable fields
  org: Vec3 = vec3();
  color = 0;
  // drivers never touch the following fields
  next: ParticleT | null = null;
  vel: Vec3 = vec3();
  ramp = 0;
  die = 0;
  type: PtypeT = PtypeT.pt_static;
}

export const PARTICLE_Z_CLIP = 8.0;

//=============================================================================

export interface Renderer {
  // model.c / gl_model.c's renderer half, installed with the renderer so a
  // vid_ref switch can never leave the loader on the torn-down renderer
  readonly modelHooks: ModelLoaderHooks;

  //
  // render.h
  //
  R_Init(): void;
  R_InitTextures(): void;
  R_InitEfrags(): void;
  R_RenderView(): void; // must set r_refdef first
  // called whenever r_refdef or vid change
  R_ViewChanged(pvrect: VrectT, lineadj: number, aspect: number): void;
  R_InitSky(mt: TextureT): void; // called at level load

  R_AddEfrags(ent: EntityT): void;
  R_RemoveEfrags(ent: EntityT): void;

  R_NewMap(): void;

  R_PushDlights(): void;

  //
  // surface cache related
  //
  r_cache_thrash: boolean; // set if thrashing the surface cache

  D_SurfaceCacheForRes(width: number, height: number): number;
  D_FlushCaches(): void;
  D_DeleteSurfaceCache(): void;
  D_InitCaches(buffer: Uint8Array, size: number): void;
  R_SetVrect(pvrectin: VrectT, pvrect: VrectT, lineadj: number): void;

  //
  // draw.h -- these are the only functions outside the refresh allowed
  // to touch the vid buffer
  //
  draw_disc: QpicT | null; // also used on sbar

  Draw_Init(): void;
  Draw_Character(x: number, y: number, num: number): void;
  Draw_DebugChar(num: number): void;
  Draw_Pic(x: number, y: number, pic: QpicT): void;
  Draw_TransPic(x: number, y: number, pic: QpicT): void;
  Draw_TransPicTranslate(x: number, y: number, pic: QpicT, translation: Uint8Array): void;
  Draw_ConsoleBackground(lines: number): void;
  Draw_BeginDisc(): void;
  Draw_EndDisc(): void;
  Draw_TileClear(x: number, y: number, w: number, h: number): void;
  Draw_Fill(x: number, y: number, w: number, h: number, c: number): void;
  Draw_FadeScreen(): void;
  Draw_String(x: number, y: number, str: string): void;
  Draw_PicFromWad(name: string): QpicT | null;
  Draw_CachePic(path: string): QpicT | null;

  // QW/client/draw.c + gl_draw.c additions (not in WinQuake's draw.h):
  // sbar.c's Sbar_DrawSubPic and Sbar_DeathmatchOverlay read both.
  Draw_SubPic(x: number, y: number, pic: QpicT, srcx: number, srcy: number, width: number, height: number): void;
  Draw_Alt_String(x: number, y: number, str: string): void;

  //
  // the particle drawing half of r_part.c's R_DrawParticles
  //
  D_StartParticles(): void;
  D_DrawParticle(pparticle: ParticleT): void;
  D_EndParticles(): void;

  //
  // view.c's GLQUAKE branches
  //
  V_CalcBlend(): void;
  V_UpdatePalette(): void;
  V_DrawCrosshair(): void;

  //
  // cl_parse.c's GLQUAKE branches
  //
  R_TranslatePlayerSkin(playernum: number): void;

  //
  // screen.c / gl_screen.c
  //
  SCR_CalcRefdef(): void;
  BeginFrame(): void;
  EndFrame(): void;
  D_EnableBackBufferAccess(): void;
  D_DisableBackBufferAccess(): void;
  D_UpdateRects(rects: VrectT | null): void;
  GL_Set2D(): void;
  SCR_TileClear(): void;
  // The four screen.c Draw_TileClear sites that gl_screen.c has no
  // counterpart for (SCR_UpdateScreen's scr_fullupdate clear,
  // SCR_EraseCenterString, SCR_SetUpToDrawConsole's two clears). The
  // software renderer forwards to Draw_TileClear; the GL renderer's body is
  // empty, matching gl_screen.c dropping them.
  SCR_SoftwareTileClear(x: number, y: number, w: number, h: number): void;
  SCR_DrawCrosshair(): void;
  SCR_ScreenShot_f(): void;

  // This port's own addition, not from render.h: the client files' own
  // `#ifdef GLQUAKE` discriminator. See this file's header.
  readonly isGL: boolean;

  // QW gl_ngraph.c's R_NetGraph, called from gl_screen.c's SCR_UpdateScreen.
  // Optional: the software renderer's own R_NetGraph (r_misc.c) is called
  // from r_main.c instead, inside the renderer. See this file's header.
  R_NetGraph?(): void;

  // This port's own addition, not from render.h: Quake links exactly one
  // renderer, so it never unloads one. The vid_ref switch this port adds
  // (PORTING.md's "Runtime and build" section) needs somewhere to release
  // whatever the outgoing renderer holds onto (a GL context's function
  // table, masked palette state, ...) before the next renderer installs
  // itself. Optional because ref_soft has nothing to release.
  Shutdown?(): void;
}

export const re: { current: Renderer | null } = { current: null };

export function getRenderer(): Renderer {
  const r = re.current;
  if (!r) Sys_Error("No renderer is loaded");
  return r;
}
