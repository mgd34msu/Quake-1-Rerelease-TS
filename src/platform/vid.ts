/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/vid_x.c and WinQuake/gl_vidlinuxglx.c (GNU GPL v2 or
later): VID_Init/VID_Shutdown/VID_Update/VID_SetPalette/VID_ShiftPalette/
VID_SetMode/D_BeginDirectRect/D_EndDirectRect -- the `VidBackend`
implementation src/client/vid.ts declares -- plus the one thing neither C
file has at all: a runtime switch between the software and OpenGL
refreshes (`vid_ref`, PORTING.md's "Runtime and build" section, the one
added cvar) and the mode table/fullscreen-fit machinery that switch needs.
Adapted from ../quake-2-ts/src/platform/vid.ts's VID_CheckChanges/
VID_LoadRefresh shape, re-pointed at this engine's `Renderer`/`ModelLoaderHooks`
seam instead of a dlopen'd refresh DLL (both refreshes are statically linked
here, same as quake-2-ts's).

Folds in what quake-2-ts calls swimp.ts (the 8-bit-buffer-to-SDL-texture
surface): this unit's brief says fold it into vid.ts or say so -- SWimp_* in
quake-2-ts is a five-function file (Init/SetMode/SetPalette/Shutdown/
BeginFrame/EndFrame) that exists only because that port's refresh loads
through a `refimport_t`/`refexport_t` boundary neither renderer here needs;
VID_Init/VID_Update/VID_SetPalette below do that surface's whole job.

THE REGISTRY (what ref_soft/U060 and ref_gl/U071 must call):

  import { registerRenderer } from "../platform/vid";
  registerRenderer("soft", () => mySoftRenderer as Renderer);   // ref_soft
  registerRenderer("gl", () => myGlRenderer as Renderer);       // ref_gl, reads glimp.ts's glimpHolder.current for its GL context

Neither renderer is landed yet, so the registry starts empty: `vid_ref soft`
(the default) with nothing registered fails VID_CheckChanges with
`Sys_Error("vid_ref %s not available (registered: %s)", ...)`, listing
whatever IS registered (nothing, in a build with neither renderer linked).
Every test in this unit registers a fake renderer under "soft" to exercise
the switch without a real one; `Sys_Error` throws `SysError`, so a test can
assert it rather than crash the process.

WHY THERE IS NO Renderer.Shutdown (a documented gap, not an oversight):
render.ts's `Renderer` interface has no teardown method -- Quake 1 never
switches refreshes at runtime in the original engine (GLQUAKE is a
compile-time #define), so no C file ever needed one. A live vid_ref switch
here therefore cannot ask the outgoing renderer to free anything; it only
(a) tears down this file's own platform resources (the SDL window/texture,
or glimp.ts's GL context) and (b) drops the `re.current`/model-hook
references. Any Hunk memory the outgoing renderer allocated (surface cache,
GL texture handles the driver itself must still free through the OS/driver
process teardown) is simply abandoned -- which is exactly what already
happens to every OTHER Hunk allocation in this port between one
Host_ClearMemory and the next (PORTING.md's zone.c ruling: `Hunk_Alloc*`
never frees piecemeal). A vid_ref switch is therefore no less "leaky" than a
level change already is; it is a documented follow-up for whichever unit
lands second (ref_soft or ref_gl) to note anything genuinely OS-owned (e.g.
a GL texture name) that would want an explicit free on the way out.

Deviations from PORTING.md / the C source:
- The mode table (`VID_MODES`) has no vid_x.c/gl_vidlinuxglx.c equivalent at
  all (X11's window is created once at a fixed size; gl_vidlinuxglx.c reads
  a numeric width/height off `-width`/`-height` with no table). Per this
  unit's brief ("RULING: adopt q2ts's flat mode table ... exposed through
  vidMenuHooks"), `VID_MODES` is quake-2-ts's own 21-entry table verbatim
  (320x240 through 3840x2160); `vid_mode` (index into it) and
  `vid_fullscreen` are this port's own added cvars alongside `vid_ref` --
  three new cvars total, all necessary for `vid_ref` to have anything to
  select a resolution/window state from. vid_x.c's own `-width`/`-height`/
  `-winsize` command-line parms still override the table's pick for this
  session, exactly as vid_x.c: `if ((pnum=COM_CheckParm("-width"))) ...`.
  `-window` (gl_vidlinuxglx.c's parm; vid_x.c has none, being always
  windowed) forces windowed regardless of `vid_fullscreen`'s value.
  `-mode` does not exist in either C file and is not invented here.
- `vid.conwidth`/`vid.conheight`: vid_x.c's software path sets both equal to
  `vid.width`/`vid.height` (no `-conwidth`/`-conheight` parms in that file --
  those are gl_vidlinuxglx.c-only, and that file's own version additionally
  clamps to a multiple of 8 and a 320x200 floor for the GL console/HUD
  resolution). This port keeps vid_x.c's simpler always-equal assignment for
  both renderers; `-conwidth`/`-conheight` are not ported (documented gap,
  follow-up for whichever GL unit wants console/HUD decoupled from render
  resolution).
- `vid.fullbright = 256 - LittleLong(*((int*)vid.colormap + 2048))` (both C
  files, identical line): the colormap byte block is little-endian already
  (COM_LoadHunkFile has no endian-swap step of its own in this port), so
  this reads as a plain `DataView.getInt32(8192, true)` at the fixed byte
  offset `2048 * 4`.
- `d_8to24table`'s packing (gl_vidlinuxglx.c's VID_SetPalette: `v = (255<<24)
  + (r<<0) + (g<<8) + (b<<16)`) is R,G,B,A in increasing byte address on a
  little-endian host -- exactly `SDL_PIXELFORMAT_ABGR8888`'s memory layout
  (sdl.ts's texture format) and exactly the padded-xRGB shape
  `SDLVID_ExpandFrame` already expects, so `d_8to24table`'s own
  `ArrayBuffer` is reused as that palette directly (`new Uint8Array(
  d_8to24table.buffer)`) rather than building a second copy. Unlike
  gl_vidlinuxglx.c, index 255's alpha byte is NOT masked to 0 here: that
  mask exists only so a GL *texture* using palette index 255 as a chroma-key
  color reads as transparent, which is ref_gl's own texture-upload path
  (not landed), not this file's framebuffer-to-window blit, which always
  wants every index opaque.
- `st2d_8to16table`/`xlib_rgb16`/the X11 `XStoreColors`/8-bit `PseudoColor`
  path, and the `d_15to8table` nearest-color search gl_vidlinuxglx.c builds
  for 3dfx paletted-texture emulation, have no counterpart: this port's
  window is always presented through an RGBA streaming texture (sdl.ts),
  never an indexed X11 visual, so no 15/16-bit intermediate table is needed.
- `VID_SetMode(modenum, palette)`: render.h/vid.h declare it for "resetting
  to mode 0 ... on memory allocation failures", but grepping the whole
  WinQuake tree shows no caller outside vid_win.c/vid_dos.c/vid_svgalib.c
  themselves (DOS/Win32/SVGAlib's own low-memory recovery path) -- vid_x.c
  and gl_vidlinuxglx.c never define or call it, and no client/server file
  calls it either. Implemented here as a thin re-run of the mode-table
  lookup + platform re-init (so the interface member is not silently absent),
  but unreached in this port's call graph; documented rather than dropped,
  since VidBackend declares it.
- `VID_HandlePause`: "called only on Win32, when pause happens" (vid.h) --
  no-op, matching every non-Win32 backend.
- `VID_LockBuffer`/`VID_UnlockBuffer`: "real functions on Win32, empty macros
  everywhere else" (quakedef.h) -- no-ops.
- `D_BeginDirectRect`/`D_EndDirectRect`: vid_x.c's own bodies are empty
  ("direct drawing of the 'accessing disk' icon isn't supported under
  Linux") -- ported as the same no-ops, not invented.
- SDL is armed (`SDL_SetBackendEnabled(true)`) from inside this file's own
  `VID_Init`, not from src/main.ts (out of this unit's SCOPE): `VID_Init` is
  only ever reached through `hostClientHooks.vidInit`, which host.ts already
  calls only `if (!sysState.isDedicated)`, so a dedicated server never arms
  the backend regardless. Follow-up: main.ts could additionally arm it
  earlier for symmetry with quake-2-ts's own main.ts, but nothing in this
  port's call graph needs that today.
*/

import { d_8to24table, vid, vidBackend, type VidBackend, vidMenuHooks, VrectT } from "../client/vid";
import { Sys_Error } from "./sys";
import { qw } from "../common/quakedef";
import { S_Init } from "../client/snd_dma";
import { hostClientHooks, hostColormap } from "../common/host";
import type * as QwClMainModule from "../qw/client/cl_main";
import type * as QwScreenModule from "../qw/client/screen";
import type * as QwSbarModule from "../qw/client/sbar";

function qwClMainMod(): typeof QwClMainModule {
  return require("../qw/client/cl_main");
}
function qwScreenMod(): typeof QwScreenModule {
  return require("../qw/client/screen");
}
function qwSbarMod(): typeof QwSbarModule {
  return require("../qw/client/sbar");
}
import { COM_CheckParm, Q_atoi, com_argc, com_argv } from "../common/common";
import { CvarT, Cvar_RegisterVariable, Cvar_Set } from "../common/cvar";
import { Cmd_AddCommand, cmdHost } from "../common/cmd";
import { Con_Printf } from "../client/console";
import { scrState } from "../client/screen_types";
import { getRenderer, re, type Renderer } from "../client/render";
import { Mod_ClearAll, Mod_ForName, setModelLoaderHooks } from "../common/model";
import { cl, cl_static_entities } from "../client/client";
import { Cache_Flush } from "../common/zone";
import { inputBackend } from "../client/input";
import { SDL_BackendEnabled, SDL_SetBackendEnabled, SDL_SetWindowSizeChangedHandler, SDLVID_Init, SDLVID_Present, SDLVID_Resize, SDLVID_SetWindowTitle, SDLVID_Shutdown, SDL_SetFullscreenHint } from "./sdl";
import { CreateGLimp, glimpHolder } from "./glimp";
import { VID_MenuDraw, VID_MenuKey } from "./vid_menu";
// ref_soft's own r_main.ts (R_Init, registerRenderer, hostClientHooks.rInit)
// has not landed; this one import is a live exception to this unit's
// original "do not import from src/ref_soft" scoping, made explicit by
// .orch/followups.md's own directive to this unit ("allocate
// rState.d_pzbuffer ... and the surface-cache heap, call D_InitCaches(heap,
// size) as vid_x.c does"): d_local.ts's own header table says exactly this
// -- "D_InitCaches by src/platform/vid.ts" -- there is no other module that
// can hand the software rasterizer its z-buffer/surface-cache memory the
// way vid_x.c's ResetFrameBuffer does. r_shared.ts is a pure types/state
// leaf (no imports back into src/platform), so this creates no cycle.
import { rState } from "../ref_soft/r_shared";

// d_iface.h: `#define WARP_WIDTH 320` / `#define WARP_HEIGHT 200`. Neither
// ref_soft/ref_gl has landed to own d_iface.h's port yet; declared here
// since VID_Init is the one C function that assigns them.
const WARP_WIDTH = 320;
const WARP_HEIGHT = 200;

//=============================================================================
// the flat mode table -- see file header ("RULING: adopt q2ts's flat mode
// table"). Index order matches quake-2-ts's own table exactly.

class VidmodeT {
  constructor(
    public description: string,
    public width: number,
    public height: number,
  ) {}
}

export const VID_MODES: readonly VidmodeT[] = [
  new VidmodeT("Mode 0: 320x240", 320, 240),
  new VidmodeT("Mode 1: 400x300", 400, 300),
  new VidmodeT("Mode 2: 512x384", 512, 384),
  new VidmodeT("Mode 3: 640x480", 640, 480),
  new VidmodeT("Mode 4: 800x600", 800, 600),
  new VidmodeT("Mode 5: 960x720", 960, 720),
  new VidmodeT("Mode 6: 1024x768", 1024, 768),
  new VidmodeT("Mode 7: 1152x864", 1152, 864),
  new VidmodeT("Mode 8: 1280x720", 1280, 720),
  new VidmodeT("Mode 9: 1280x960", 1280, 960),
  new VidmodeT("Mode 10: 1366x768", 1366, 768),
  new VidmodeT("Mode 11: 1440x900", 1440, 900),
  new VidmodeT("Mode 12: 1600x900", 1600, 900),
  new VidmodeT("Mode 13: 1600x1200", 1600, 1200),
  new VidmodeT("Mode 14: 1920x1080", 1920, 1080),
  new VidmodeT("Mode 15: 1920x1200", 1920, 1200),
  new VidmodeT("Mode 16: 2048x1536", 2048, 1536),
  new VidmodeT("Mode 17: 2560x1080", 2560, 1080),
  new VidmodeT("Mode 18: 2560x1440", 2560, 1440),
  new VidmodeT("Mode 19: 3440x1440", 3440, 1440),
  new VidmodeT("Mode 20: 3840x2160", 3840, 2160),
];

export function VID_GetModeInfo(mode: number): { width: number; height: number } | null {
  if (mode < 0 || mode >= VID_MODES.length) return null;
  return { width: VID_MODES[mode].width, height: VID_MODES[mode].height };
}

// PORTING.md's "Runtime and build" cvar, plus the two this port needs to
// give it a resolution/window state to select (see file header).
export const vid_ref = new CvarT("vid_ref", "soft", true);
export const vid_mode = new CvarT("vid_mode", "3", true); // index 3 = 640x480
export const vid_fullscreen = new CvarT("vid_fullscreen", "0", true);

//=============================================================================
// the renderer registry

type RendererName = "soft" | "gl";

// keyed by plain string (not RendererName) so a lookup against the
// free-form vid_ref.string needs no `as` cast; registerRenderer/
// unregisterRenderer are the only writers and narrow their own `name`
// parameter to RendererName for every future caller (ref_soft/ref_gl).
const registry = new Map<string, () => Renderer>();

export function registerRenderer(name: RendererName, factory: () => Renderer): void {
  registry.set(name, factory);
}

// test seam: undo a test's own registerRenderer("soft", ...) call so later
// suites see the same empty registry this file starts with.
export function unregisterRenderer(name: RendererName): void {
  registry.delete(name);
}

// test seam: read back whatever is registered under `name` (real or a
// test's fake) before a test overwrites the entry, so it can restore the
// exact previous factory afterward instead of deleting a real registration
// a real renderer module (main.ts imports both) may have made earlier in
// this same process.
export function getRegisteredRenderer(name: RendererName): (() => Renderer) | null {
  return registry.get(name) ?? null;
}

let activeRendererKind: RendererName | null = null;

//=============================================================================
// VID_SetPalette / VID_ShiftPalette

export function VID_SetPalette(palette: Uint8Array): void {
  const table = d_8to24table;
  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3 + 0];
    const g = palette[i * 3 + 1];
    const b = palette[i * 3 + 2];
    table[i] = (255 << 24) + (r << 0) + (g << 8) + (b << 16);
  }
  // gl_vidlinuxglx.c's VID_SetPalette ends with `d_8to24table[255] &=
  // 0xffffff;  // 255 is transparent`, which is what makes GL_Upload8's alpha
  // pass produce alpha-0 texels for index 255 so GL_Set2D's alpha test throws
  // them away. vid_x.c's VID_SetPalette has no such line -- the software
  // present path needs entry 255's real alpha byte -- so the mask belongs to
  // the GL build only. This one function serves both, hence the check.
  if (activeRendererKind === "gl") table[255] &= 0xffffff;
}

export function VID_ShiftPalette(palette: Uint8Array): void {
  // gl_vidlinuxglx.c's VID_ShiftPalette is an empty body (its one statement,
  // `VID_SetPalette(p);`, is commented out); only vid_x.c's reloads the
  // palette. Reloading it under GL would undo the `& 0xffffff` above on every
  // V_UpdatePalette.
  if (activeRendererKind === "gl") return;
  VID_SetPalette(palette);
}

//=============================================================================
// mode selection: the table lookup plus vid_x.c's -width/-height/-winsize
// command-line overrides and gl_vidlinuxglx.c's -window.

function resolveMode(): { width: number; height: number; fullscreen: boolean } {
  const info = VID_GetModeInfo(Math.trunc(vid_mode.value)) ?? { width: VID_MODES[3].width, height: VID_MODES[3].height };
  let width = info.width;
  let height = info.height;
  let fullscreen = vid_fullscreen.value !== 0;

  let pnum = COM_CheckParm("-winsize");
  if (pnum) {
    if (pnum >= com_argc - 2) Sys_Error("VID: -winsize <width> <height>\n");
    width = Q_atoi(com_argv[pnum + 1]);
    height = Q_atoi(com_argv[pnum + 2]);
    if (!width || !height) Sys_Error("VID: Bad window width/height\n");
  }
  pnum = COM_CheckParm("-width");
  if (pnum) {
    if (pnum >= com_argc - 1) Sys_Error("VID: -width <width>\n");
    width = Q_atoi(com_argv[pnum + 1]);
    if (!width) Sys_Error("VID: Bad window width\n");
  }
  pnum = COM_CheckParm("-height");
  if (pnum) {
    if (pnum >= com_argc - 1) Sys_Error("VID: -height <height>\n");
    height = Q_atoi(com_argv[pnum + 1]);
    if (!height) Sys_Error("VID: Bad window height\n");
  }
  if (COM_CheckParm("-window")) fullscreen = false;

  return { width, height, fullscreen };
}

//=============================================================================
// `-vid_ref <name>` stickiness. `+vid_ref gl` on the command line cannot pick
// the renderer: the "+" arguments only run once something executes
// `stuffcmds`, which quake.rc does long after Host_Init has called VID_Init
// and a renderer has already been created. `-vid_ref <name>` is the
// pre-init parm form WinQuake uses for every option VID_Init/Host_Init must
// see before the console exists (`-dedicated`, `-mem`, and vid_x.c's own
// `-width`/`-height`/`-winsize` resolveMode() reads above); vid_ref is this
// port's own added cvar, so the parm that seeds it is the port's own
// convention too.
//
// Reading it once at boot is not enough, though: `vid_ref` is archived
// (`new CvarT("vid_ref", "soft", true)` above), so config.cfg's own
// `vid_ref "soft"` line re-executes on every boot and overwrites whatever
// `-vid_ref gl` just selected -- the live renderer stays GL (VID_Init has
// already created it by the time config.cfg runs), but the cvar now says
// "soft", so the video menu shows the wrong renderer and a `vid_restart` (or
// menu Apply) tears GL down and switches to soft out from under the parm.
// resolveMode() already treats `-width`/`-height`/`-window` as winning over
// whatever the mode/fullscreen cvars say every single time the mode is
// resolved, not just at boot; `-vid_ref` gets the same treatment here, called
// from both VID_Init and every VID_CheckChanges so the parm always wins back.
function applyVidRefParm(): void {
  const refParm = COM_CheckParm("-vid_ref");
  if (refParm) {
    if (refParm >= com_argc - 1) Sys_Error("VID: -vid_ref <name>\n");
    Cvar_Set("vid_ref", com_argv[refParm + 1]);
  }
}

//=============================================================================
// VID_Update -- the software framebuffer's own presentation path (the
// GL renderer, when it lands, presents through glimp.ts's EndFrame instead;
// see render.ts's header table on why VID_Update is a software-only call
// site: screen.c's SCR_UpdateScreen calls it, gl_screen.c calls
// GL_EndRendering).

export function VID_Update(rects: VrectT | null): void {
  void rects; // vid_x.c's own VID_Update also ignores the rect list under MITSHM and always blits the whole framebuffer
  if (!vid.buffer) return;
  const palette = new Uint8Array(d_8to24table.buffer);
  SDLVID_Present(vid.buffer, vid.rowbytes, vid.width, vid.height, palette);
}

//=============================================================================
// VID_CheckChanges -- this unit's own addition (see file header): apply the
// current vid_ref/vid_mode/vid_fullscreen cvars, switching renderers if
// vid_ref changed and/or the window if the mode/fullscreen state changed.
// Called once from VID_Init and again by `vid_restart`/the video menu's
// Apply action -- there is no per-frame poll of `vid_ref.modified` anywhere
// in this port yet (screen.ts/host.ts, both outside this unit's SCOPE, would
// need to add one); until one exists, a change only takes effect through
// one of those two explicit call sites, not merely by setting the cvar.

function teardownActiveRenderer(): void {
  // vid_x.c's ResetFrameBuffer: `if (d_pzbuffer) { D_FlushCaches();
  // Hunk_FreeToHighMark(...); d_pzbuffer = NULL; }` before allocating the
  // next mode's buffers.
  re.current?.D_FlushCaches();
  rState.d_pzbuffer = null;

  // render.ts's Renderer.Shutdown -- this port's own addition (see its
  // doc comment): lets the outgoing renderer release what it owns (the GL
  // renderer's qgl function table and masked palette byte) before this
  // function drops re.current and tears down the platform-level context.
  re.current?.Shutdown?.();

  if (activeRendererKind === "gl") {
    glimpHolder.current?.Shutdown();
    glimpHolder.current = null;
  } else if (activeRendererKind === "soft") {
    SDLVID_Shutdown();
  }
  activeRendererKind = null;
  re.current = null;
}

/*
`runRInit` defaults true (vid_restart, the video menu's Apply, and the
gl-fallback recursion below all want it) but is passed false from VID_Init:
host.ts's Host_Init calls `hostClientHooks.vidInit` and, several lines
later, `hostClientHooks.rInit` itself as two separate steps (matching
vid_x.c's VID_Init and r_main.c's R_Init being two separate C functions
Host_Init calls in sequence) -- if VID_Init's own call into this function
also triggered R_Init, the very first boot would run it twice.
*/
export function VID_CheckChanges(runRInit: boolean = true): void {
  // see applyVidRefParm's own comment: re-applied on every call (vid_restart,
  // the video menu's Apply, and VID_Init's own call below) so a session
  // started with `-vid_ref <name>` cannot be silently overridden by
  // config.cfg's archived `vid_ref` cvar re-executing under it. Not called
  // from VID_CheckChanges_'s own gl-fallback recursion below: that recursion
  // is what sets the cvar to "soft" after a `-vid_ref gl` attempt fails, and
  // re-applying the parm there would immediately undo the fallback.
  applyVidRefParm();
  // Both screen.c's (WinQuake screen.c:SCR_UpdateScreen, QW screen.c/
  // gl_screen.c likewise) return early while `scr_disabled_for_loading` is
  // set, which is how the C keeps a Con_Printf issued mid-mode-change from
  // recursing into a refresh that is not there. This function has exactly
  // that window: `teardownActiveRenderer()` below drops `re.current`, and
  // glimp.ts's GLimp_SetMode Con_Printf's the mode it is about to try before
  // it can know whether the attempt fails -- with the console initialized and
  // the client not signed on, console.ts's Con_Printf calls SCR_UpdateScreen,
  // whose getRenderer() would throw "No renderer is loaded". Set for the whole
  // switch and restored to whatever a real loading plaque had left it as.
  const savedScrDisabled = scrState.scr_disabled_for_loading;
  scrState.scr_disabled_for_loading = true;
  // see Cmd_AddCommand: the incoming renderer's R_Init registers its
  // console commands after host_initialized on a runtime switch.
  const savedRendererSwitch = cmdHost.rendererSwitch;
  cmdHost.rendererSwitch = cmdHost.initialized;
  try {
    // A renderer switch with a level already up has to reload it (see
    // VID_RestartLevel). Decided HERE, not inside VID_CheckChanges_: that
    // function drops re.current before it is done and re-enters itself on the
    // gl-mode-set fallback below, by which point neither the outgoing
    // renderer nor its answer to "was a level loaded" is still around.
    const restartLevel = runRInit && re.current !== null && cl.worldmodel !== null;
    if (restartLevel) {
      // cl_parse.c's CL_ParseUpdate does exactly this before an entity's
      // links are rebuilt, and it has to happen while the mleaf_t the efrags
      // are threaded through are still the ones they were built from.
      // Skipping it strands one efrag per static entity on the world model
      // that is about to be thrown away, and cl.free_efrags (a fixed
      // MAX_EFRAGS pool, refilled only by CL_ClearState) never gets them
      // back -- a few switches in, R_SplitEntityOnNode starts printing
      // "Too many efrags!" and the statics stop appearing.
      const outgoing = getRenderer();
      for (let i = 0; i < cl.num_statics; i++) outgoing.R_RemoveEfrags(cl_static_entities[i]);
    }
    VID_CheckChanges_(runRInit, restartLevel);
  } finally {
    scrState.scr_disabled_for_loading = savedScrDisabled;
    cmdHost.rendererSwitch = savedRendererSwitch;
  }
}

/*
VID_RestartLevel -- the port's own stand-in for the model re-registration
Quake 2's `vid_restart` gets for free (ref.c's R_BeginRegistration plus every
re.RegisterModel/RegisterSkin call CL_PrepRefresh makes a second time).

Quake 1 has no registration pass at all: model.c/gl_model.c bake the
renderer's own data straight into model_t while the file is being read --
textures through `ModelLoaderHooks.textureLoaded` (model.c's R_InitSky for
"sky*", gl_model.c's R_InitSky + GL_LoadTexture for everything), alias and
sprite data into `mod->cache` in that renderer's own layout, and lightmaps in
gl_rmisc.c's R_NewMap. GLQUAKE being a compile-time #define, no C file ever
has to hand a level it did not load to a different refresh. So the only way
to do it here is to read every model again with the incoming renderer's hooks
installed, which is exactly what the C's own two map-change primitives do:

  Cache_Flush()   zone.c's "flush" command -- drops every cache_user_t block
                  (alias and sprite data, draw.c's Draw_CachePic pics, QW's
                  Skin_Cache skins), so Mod_LoadModel's `Cache_Check` early
                  return misses and an alias model really is read again.
  Mod_ClearAll()  model.c's own; sets needload on the brush and sprite models
                  so Mod_LoadModel's `needload == NL_PRESENT` early return
                  misses too.

Mod_ForName then reloads INTO THE SAME model_t: Mod_FindName matches on
mod->name before it ever considers an unreferenced slot, and
Mod_LoadBrushModel's submodel loop copies over the "*1".."*N" model_t that
are already in mod_known. That in-place reload is what keeps cl.worldmodel,
cl_entities[0].model, cl.model_precache[], cl_static_entities[].model and the
server's sv.worldmodel/sv.models[] -- the same objects SV_Move walks for
hulls and clipnodes -- valid across the switch, rather than pointing at an
abandoned copy while the renderer draws a different one.
*/
function VID_RestartLevel(): void {
  Cache_Flush();
  Mod_ClearAll();

  for (let i = 1; i < cl.model_precache.length; i++) {
    const mod = cl.model_precache[i];
    if (mod === null) continue;
    Mod_ForName(mod.name, true);
  }

  const r = getRenderer();

  // cl_parse.c's CL_ParseServerInfo tail, minus the parts that only a signon
  // message can supply: the world is loaded, so the refresh gets its
  // per-level setup (gl_rmisc.c's R_NewMap is where r_worldentity.model,
  // GL_BuildLightmaps and skytexturenum come from; r_main.c's is where the
  // surface and edge pools come from).
  r.R_NewMap();

  // ... and then CL_ParseStatic's own tail for the statics that were parsed
  // before the switch. R_NewMap has just cleared every leaf->efrags on the
  // freshly loaded world, so without this the torches and flames stop being
  // walked by R_StoreEfrags entirely.
  for (let i = 0; i < cl.num_statics; i++) r.R_AddEfrags(cl_static_entities[i]);

  // cl_parse.c's CL_NewTranslation, whose gl_rmisc.c half is the only thing
  // that ever uploads playertextures[playernum]; nothing re-sends the
  // svc_updatecolors messages that normally drive it, so a player model would
  // otherwise draw through a texture name the destroyed context minted.
  // r_main.c's software half is an empty body, so this costs nothing there.
  // QW reaches R_TranslatePlayerSkin from gl_rmain.c's own per-frame
  // `if (!sc->skin)` branch instead, so it needs no help here.
  if (!qw.active) {
    const players = Math.min(cl.maxclients, cl.scores.length);
    for (let i = 0; i < players; i++) r.R_TranslatePlayerSkin(i);
  }

  // screen.c's SCR_UpdateScreen reads both: the refdef is sized off a mode
  // that may have changed, and the new renderer has drawn nothing yet.
  vid.recalc_refdef = 1;
  scrState.scr_fullupdate = 0;
}

function VID_CheckChanges_(runRInit: boolean, restartLevel: boolean): void {
  const name = vid_ref.string;
  const factory = registry.get(name);
  if (!factory) {
    const registered = Array.from(registry.keys()).join(", ") || "(none)";
    Sys_Error("vid_ref %s not available (registered: %s)", vid_ref.string, registered);
  }

  const { width, height, fullscreen } = resolveMode();

  teardownActiveRenderer();
  inputBackend.current?.IN_ModeChanged();

  vid.width = width;
  vid.height = height;
  vid.rowbytes = width;
  vid.buffer = new Uint8Array(width * height);
  // vid_x.c: `vid.conbuffer = vid.buffer;` (ResetFrameBuffer) and
  // `vid.conrowbytes = vid.rowbytes;` (VID_Init). draw.c's Draw_Character /
  // Draw_String / Draw_ConsoleBackground / Draw_Pixel write through these,
  // not through vid.buffer.
  vid.conbuffer = vid.buffer;
  vid.conrowbytes = vid.rowbytes;
  vid.conwidth = width; // vid_x.c: `vid.conwidth = vid.width; vid.conheight = vid.height;`
  vid.conheight = height;
  // vid_x.c:668 and gl_vidlinuxglx.c:890, identically. R_ViewChanged takes
  // this through screen.c's `R_ViewChanged (&vrect, sb_lines, vid.aspect)`
  // as pixelAspect, and the software rasterizer's yscale is
  // `xscale * pixelAspect`: leaving it 0 collapses every projected vertex
  // onto ycenter, so every edge is horizontal and no span is ever drawn.
  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);

  if (name === "gl") {
    SDL_SetFullscreenHint(fullscreen);
    const glimp = CreateGLimp();
    if (!glimp.Init() || !glimp.SetMode(width, height, fullscreen)) {
      glimp.Shutdown();
      if (vid_ref.string === "soft") Sys_Error("Couldn't fall back to software refresh!");
      Con_Printf("vid_ref gl: mode set failed, falling back to soft\n");
      // quake-2-ts's VID_CheckChanges does the same thing on a failed
      // refresh load: print, put the cvar back to "soft", keep running.
      // Cvar_Set is a no-op with a "variable not found" print if vid_ref has
      // not been linked into cvar_vars yet -- VID_Init always registers it
      // before any switch can happen in normal use, but the direct field
      // write covers that case anyway, so a silent no-op can never turn this
      // into an infinite VID_CheckChanges recursion.
      Cvar_Set("vid_ref", "soft");
      if (vid_ref.string !== "soft") {
        vid_ref.string = "soft";
        vid_ref.value = 0;
      }
      VID_CheckChanges_(runRInit, restartLevel);
      return;
    }
    glimpHolder.current = glimp;
    activeRendererKind = "gl";
  } else {
    SDL_SetFullscreenHint(fullscreen);
    if (!SDLVID_Init(width, height, fullscreen) && SDL_BackendEnabled()) {
      if (vid_ref.string === "soft") Sys_Error("Couldn't fall back to software refresh!");
      Con_Printf("vid_ref soft: window/texture creation failed, falling back to soft\n");
    }
    activeRendererKind = "soft";
  }

  re.current = factory();
  setModelLoaderHooks(re.current.modelHooks);

  // vid_x.c's ResetFrameBuffer/ResetSharedFrameBuffers: the z-buffer and
  // surface-cache heap are sized off the mode's resolution and handed to
  // the rasterizer through D_InitCaches, which vid_x.c calls directly (not
  // through R_Init) -- see the file header and this file's rState import
  // comment. gl_vidlinuxglx.c's own VID_Init has no equivalent call at all
  // (GL uses hardware depth buffering, no software z-buffer/surface cache),
  // so this is software-only, unlike the buffer/window setup above it.
  if (name !== "gl") {
    rState.d_pzbuffer = new Int16Array(width * height);
    const cacheSize = re.current.D_SurfaceCacheForRes(width, height);
    re.current.D_InitCaches(new Uint8Array(cacheSize), cacheSize);
  }

  if (runRInit) {
    // host.c's Host_Init runs R_InitTextures, then Draw_Init/SCR_Init/R_Init
    // and Sbar_Init, right around its VID_Init call. Every one of them hands
    // out an object only the renderer that made it can draw -- gl_rmisc.c's
    // r_notexture_mip, gl_draw.c's char_texture/conback/draw_backtile, and
    // the qpic_t * SCR_Init and Sbar_Init take from Draw_PicFromWad -- so on
    // a live renderer switch they all have to run again against the incoming
    // one. Same order as Host_Init: Draw_Init first, because SCR_Init's and
    // Sbar_Init's Draw_PicFromWad calls need gl_draw.c's scrap atlas.
    hostClientHooks.rInitTextures?.(); // R_InitTextures
    hostClientHooks.drawInit?.(); // Draw_Init
    // screen.c and sbar.c are two of the files this port has BOTH trees'
    // copies of, and only WinQuake's install themselves into
    // `hostClientHooks.scrInit`/`sbarInit` (src/client/screen.ts's and
    // src/client/sbar.ts's module-load side effects). Both trees load into
    // one module registry here, so QW's own copies deliberately do not
    // register -- src/qw/client/sbar.ts's header flags exactly this as a
    // follow-up ("a future qw.active-gated second hook slot") and qwcl's
    // Host_Init calls SCR_Init/Sbar_Init directly at boot instead.
    //
    // A renderer switch is the one place that boot-time call is not enough:
    // the hooks are what re-run them, so qwcl was re-running WINQUAKE's
    // SCR_Init and Sbar_Init -- which re-registered a second set of
    // scr_conspeed/showram/showturtle/showpause/scr_centertime/
    // scr_printspeed cvar_t objects over QW's (the "Can't register variable
    // X, allready defined" flood, since these are different objects under
    // the same names, not the same-object re-link Cvar_RegisterVariable's
    // rendererSwitch branch forgives) and, worse, left QW's OWN screen and
    // status-bar qpic_t pointing into the renderer that was just destroyed.
    // Routed here rather than by adding a second hook slot, matching this
    // file's own `qw.active ? qwClMainMod().host_colormap.data : ...`.
    if (qw.active) qwScreenMod().SCR_Init();
    else hostClientHooks.scrInit?.(); // SCR_Init
    hostClientHooks.rInit?.(); // R_Init
    if (qw.active) qwSbarMod().Sbar_Init();
    else hostClientHooks.sbarInit?.(); // Sbar_Init
    if (restartLevel) VID_RestartLevel();
  }
}

export function VID_Restart_f(): void {
  VID_CheckChanges();
}

/*
VID_SizeChanged -- the window was resized out from under the running mode
(SDL_WINDOWEVENT_SIZE_CHANGED; src/platform/sdl.ts's pump decodes it and
calls this through the handler it registers below).

There is no C precedent to port: vid_x.c never asks for a resizable window
and ignores ConfigureNotify, and gl_vidlinuxglx.c's window is likewise
created once at the size VID_Init picked, so neither file has any code path
that reacts to the window changing size. On a compositor that resizes the
window anyway (the Wayland report this was written for: a 640x480 mode left
rendering into an 1181x502 drawable, so the frame was cropped and the status
bar and weapon fell off the bottom), the faithful-to-nothing options are to
letterbox or to adopt the new size; this port adopts it, which is the same
thing vid_restart to a new mode already does -- minus the parts of
VID_CheckChanges that cannot be justified here:

  - the renderer is NOT torn down and re-created. The window and, under GL,
    the context are the same objects they were a moment ago, so every
    texture name, every cached pic and the loaded level all stay valid.
    That is what makes this cheap enough to run on the (many) SIZE_CHANGED
    events a drag-resize delivers.
  - `vid_mode` is NOT rewritten. It stays the mode the USER asked for, so
    the video menu keeps showing that selection and the next `vid_restart`
    (or menu Apply) goes back to it. The live size may differ from the
    cvar's, exactly as it already may under SDL_WINDOW_FULLSCREEN_DESKTOP.

What IS redone is everything VID_CheckChanges_ derives from the resolution:
the 8-bit framebuffer and its con* aliases, `vid.aspect`, and -- software
only, matching vid_x.c's ResetFrameBuffer, which is the one C function that
does re-allocate these for a new resolution -- the z-buffer and the surface
cache through D_FlushCaches/D_InitCaches. `vid.recalc_refdef` then makes
screen.c's SCR_UpdateScreen re-run SCR_CalcRefdef (which re-derives
r_refdef.vrect and calls Con_CheckResize, so the console reformats to the new
width) and `scr_fullupdate = 0` makes it clear and re-draw the whole screen,
status bar included, instead of leaving the old frame's pixels around the
edges.
*/
export function VID_SizeChanged(width: number, height: number): void {
  if (width < 1 || height < 1) return;
  // nothing is up yet (VID_Init has not run, or the renderer was torn down):
  // the next VID_CheckChanges will size everything from the cvars anyway.
  const renderer = re.current;
  if (renderer === null || activeRendererKind === null) return;
  // SDL sends SIZE_CHANGED once for the window's creation too, and once more
  // per compositor frame during a drag; anything that does not actually
  // change the resolution is dropped rather than re-allocating the world.
  if (width === vid.width && height === vid.height) return;

  vid.width = width;
  vid.height = height;
  vid.rowbytes = width;
  vid.buffer = new Uint8Array(width * height);
  vid.conbuffer = vid.buffer;
  vid.conrowbytes = vid.rowbytes;
  vid.conwidth = width;
  vid.conheight = height;
  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);

  if (activeRendererKind === "soft") {
    // vid_x.c's ResetFrameBuffer, in order: flush the caches that are sized
    // for the old resolution, then re-allocate the z-buffer and hand the
    // rasterizer a surface-cache heap sized for the new one.
    renderer.D_FlushCaches();
    rState.d_pzbuffer = new Int16Array(width * height);
    const cacheSize = renderer.D_SurfaceCacheForRes(width, height);
    renderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);
    // and the SDL streaming texture the framebuffer is presented through,
    // whose dimensions are fixed at creation (SDLVID_Present drops any frame
    // that does not match them).
    SDLVID_Resize(width, height);
  }

  /*
  ref_gl's `conback` (gl_draw.ts) is the one renderer-owned object whose SIZE
  is baked in at Draw_Init -- `conback.width = vid.conwidth; conback.height =
  vid.conheight` -- rather than read back per draw, and gl_draw.c's
  Draw_ConsoleBackground then draws it at exactly that size. So after a resize
  the full console (the whole screen, whenever cls.state != ca_active) painted
  only the OLD mode's rectangle and every pixel outside it kept whatever the
  renderer last drew there: the reported "ghosting when the client can't
  render", which a tiling compositor makes the default case by handing a
  640x480 mode a desktop-sized window the moment it is mapped. Measured on a
  live 640x480 -> 1280x720 resize before this call existed: the console
  covered the top-left 640x480 and the remaining 67% of the frame was never
  written.

  ref_soft's Draw_ConsoleBackground re-reads vid.conwidth on every call and
  needs nothing, so this is a GL-only staleness -- but Draw_Init is a
  per-renderer hook (ref_soft.ts installs `() => re.current?.Draw_Init()` for
  both), so re-running it simply re-derives the size against whichever
  renderer is live, with no teardown: the window, the context and every
  loaded model stay exactly as they are, which is what keeps this cheap
  enough for the size events a drag-resize delivers (VID_SizeChanged has
  already dropped every event that does not actually change the resolution).

  Draw_Init registers its own cvars and commands (gl_draw.ts's gl_nobind /
  gl_max_size / gl_picmip / `gl_texturemode`), so the same two windows
  VID_CheckChanges opens around its own re-init have to be open here too, or
  a resize prints the "allready defined" flood and trips Cmd_AddCommand's
  after-host_initialized guard.
  */
  const savedScrDisabled = scrState.scr_disabled_for_loading;
  const savedRendererSwitch = cmdHost.rendererSwitch;
  scrState.scr_disabled_for_loading = true;
  cmdHost.rendererSwitch = cmdHost.initialized;
  try {
    hostClientHooks.drawInit?.();
  } finally {
    scrState.scr_disabled_for_loading = savedScrDisabled;
    cmdHost.rendererSwitch = savedRendererSwitch;
  }

  vid.recalc_refdef = 1;
  scrState.scr_fullupdate = 0;
}

//=============================================================================
// VidBackend

export function VID_Init(palette: Uint8Array): void {
  SDL_SetBackendEnabled(true);

  Cvar_RegisterVariable(vid_ref);
  Cvar_RegisterVariable(vid_mode);
  Cvar_RegisterVariable(vid_fullscreen);
  Cmd_AddCommand("vid_restart", VID_Restart_f);

  // see applyVidRefParm's own comment. `vid_restart` after setting the cvar
  // stays the runtime path; VID_CheckChanges(false) below re-applies this
  // same parm anyway, but it also has to be resolved here, before it, so the
  // cvar (and thus resolveMode/the video menu) already agree with it on this
  // very first call.
  applyVidRefParm();

  vid.maxwarpwidth = WARP_WIDTH;
  vid.maxwarpheight = WARP_HEIGHT;
  // QW/client/vid_x.c:379 reads the same `host_colormap` global, but in
  // the qwcl binary that global lives in QW's cl_main.c (cl_main.ts's
  // holder), not host.c's.
  vid.colormap = hostColormap();
  if (vid.colormap) {
    const view = new DataView(vid.colormap.buffer, vid.colormap.byteOffset, vid.colormap.byteLength);
    vid.fullbright = 256 - view.getInt32(2048 * 4, true);
  }
  vid.numpages = 2;

  VID_SetPalette(palette);

  vidMenuHooks.vid_menudrawfn = VID_MenuDraw;
  vidMenuHooks.vid_menukeyfn = VID_MenuKey;

  SDLVID_SetWindowTitle("Quake");

  VID_CheckChanges(false); // see VID_CheckChanges's own header comment on `runRInit`

  // QW's linux video drivers (vid_x.c:371, gl_vidlinuxglx.c:606,
  // gl_vidlinux_svga.c:600) call S_Init() from inside VID_Init, which is why
  // QW's own Host_Init has `// S_Init (); // S_Init is now done as part of
  // VID. Sigh.` where WinQuake's Host_Init calls it. This one VID_Init serves
  // both binaries, so the call is made here only when qw.active; WinQuake's
  // Host_Init keeps making it itself. The C makes it the first statement of
  // VID_Init; here it is the last, because the audio device this port opens
  // lives behind the same SDL backend `SDL_SetBackendEnabled(true)` above
  // arms. Ordering against Draw_Init/SCR_Init/R_Init -- the only ordering
  // either Host_Init depends on -- is unchanged: all three still follow.
  if (qw.active) S_Init();
}

export function VID_Shutdown(): void {
  Con_Printf("VID_Shutdown\n");
  teardownActiveRenderer();
  vid.buffer = null;
  vid.conbuffer = null;
  vid.width = 0;
  vid.height = 0;
  vid.rowbytes = 0;
  vid.conrowbytes = 0;
}

// see file header: unreached in this port's call graph, ported for
// interface parity only.
export function VID_SetMode(modenum: number, palette: Uint8Array): number {
  const info = VID_GetModeInfo(modenum);
  if (!info) return 0;
  vid_mode.value = modenum;
  vid_mode.string = String(modenum);
  VID_SetPalette(palette);
  VID_CheckChanges();
  return 1;
}

export function VID_HandlePause(pause: boolean): void {
  void pause; // "called only on Win32" -- vid.h
}

export function VID_LockBuffer(): void {
  // real function on Win32, empty macro everywhere else -- quakedef.h
}

export function VID_UnlockBuffer(): void {
  // real function on Win32, empty macro everywhere else -- quakedef.h
}

export function D_BeginDirectRect(x: number, y: number, pbitmap: Uint8Array, width: number, height: number): void {
  void x;
  void y;
  void pbitmap;
  void width;
  void height;
  // "direct drawing of the 'accessing disk' icon isn't supported under Linux" -- vid_x.c
}

export function D_EndDirectRect(x: number, y: number, width: number, height: number): void {
  void x;
  void y;
  void width;
  void height;
  // see D_BeginDirectRect
}

const vidBackendImpl: VidBackend = {
  VID_SetPalette,
  VID_ShiftPalette,
  VID_Init,
  VID_Shutdown,
  VID_Update,
  VID_SetMode,
  VID_HandlePause,
  VID_LockBuffer,
  VID_UnlockBuffer,
  D_BeginDirectRect,
  D_EndDirectRect,
};
vidBackend.current = vidBackendImpl;
hostClientHooks.vidInit = VID_Init;
hostClientHooks.vidShutdown = VID_Shutdown;
SDL_SetWindowSizeChangedHandler(VID_SizeChanged);

// test seam: undo everything VID_Init/VID_CheckChanges armed, so a suite can
// exercise a fresh vid_ref switch without a real renderer registered.
export function VID_ResetForTests(): void {
  teardownActiveRenderer();
  vid.buffer = null;
  vid.conbuffer = null;
  vid.width = 0;
  vid.height = 0;
  vid.rowbytes = 0;
  vid.conrowbytes = 0;
  vid.colormap = null;
  vid.conwidth = 0;
  vid.conheight = 0;
  vid.fullbright = 0;
  rState.d_pzbuffer = null;
}
