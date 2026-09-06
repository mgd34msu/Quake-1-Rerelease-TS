// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
The software renderer's world path against a LIT map and a real-shaped
64-row colormap, which test/ref_soft_main.test.ts's one full-frame test
cannot cover: that suite sets vid.aspect itself and gives every
(color, light) pair a non-zero colormap entry, so it stayed green while the
real engine drew nothing but r_clearcolor.

What broke: src/platform/vid.ts's VID_CheckChanges set vid.width/height/
rowbytes/conwidth/conheight but not vid.aspect (vid_x.c:668 --
gl_vid.ts's GL_VidInit had its own copy, which is why only the software
renderer was affected). screen.c hands vid.aspect to R_ViewChanged as
pixelAspect, and r_main.c computes `yscale = xscale * pixelAspect`, so a
zero aspect made yscale 0, collapsed every projected vertex onto ycenter,
turned every edge horizontal in R_EmitEdge, and left the background surface
as the only one with spans.

Self-sufficient per standing order 13: this file initializes the filesystem,
the renderer, the video mode and every cvar it reads, and restores each
process-wide singleton it touches (vid.*, vidBackend.current, re.current,
rState.d_pzbuffer, the model-loader hooks, the platform renderer registry,
scrState, cl/clState, cl_lightstyle[0], d_lightstylevalue[0], qw.active,
r_drawsurf).
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  COM_CheckRegistered,
  COM_InitArgv,
  COM_InitFilesystem,
  com_gamedir,
  com_modified,
  com_searchpaths,
  pop,
  setComGamedir,
  setComModified,
  setComSearchpaths,
  setStaticRegistered,
  static_registered,
} from "../src/common/common";
import { Mod_ForName, Mod_Init, type ModelT, getModelLoaderHooks, setModelLoaderHooks } from "../src/common/model";
import { hostClientHooks } from "../src/common/host";
import { qw } from "../src/common/quakedef";
import { cl, cl_entities, cl_lightstyle, clState } from "../src/client/client";
import { r_refdef, re } from "../src/client/render";
import { VID_GRADES, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import {
  getRegisteredRenderer,
  registerRenderer,
  unregisterRenderer,
  VID_CheckChanges,
} from "../src/platform/vid";
import { softRenderer } from "../src/ref_soft/ref_soft";
import {
  R_Init,
  R_NewMap,
  R_RenderView,
  R_ViewChanged,
  r_ambient,
  r_clearcolor,
  r_drawentities,
  r_drawflat,
  r_drawviewmodel,
  r_fullbright,
  r_worldentity,
} from "../src/ref_soft/r_main";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import { R_BeginEdgeFrame } from "../src/ref_soft/r_edge";
import { R_RenderWorld } from "../src/ref_soft/r_bsp";
import { R_BuildLightMap, blocklights } from "../src/ref_soft/r_surf";
import { r_drawsurf } from "../src/ref_soft/d_iface";
import { BSP_FACE_LIGHTMAP_SAMPLES, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-world-render-test-"));
const baseDir = join(scratchDir, "quake");

// the lightmap sample every face carries. With style 0 unmapped,
// R_AnimateLight leaves d_lightstylevalue[0] at 256 (r_light.c:45), so
// R_BuildLightMap's blocklights is MID_LIGHT*256 and the colormap row it
// picks is ((255*256 - MID_LIGHT*256) >> (8 - VID_CBITS)) >> 8.
const MID_LIGHT = 128;
const EXPECTED_LIGHT_ROW = ((255 * 256 - MID_LIGHT * 256) >> 2) >> 8; // 31

//============================================================================

const fakeVid: VidBackend = {
  VID_SetPalette(_palette: Uint8Array): void {},
  VID_ShiftPalette(_palette: Uint8Array): void {},
  VID_Init(_palette: Uint8Array): void {},
  VID_Shutdown(): void {},
  VID_Update(_rects: VrectT | null): void {},
  VID_SetMode(_modenum: number, _palette: Uint8Array): number {
    return 0;
  },
  VID_HandlePause(_pause: boolean): void {},
  VID_LockBuffer(): void {},
  VID_UnlockBuffer(): void {},
  D_BeginDirectRect(_x: number, _y: number, _pbitmap: Uint8Array, _width: number, _height: number): void {},
  D_EndDirectRect(_x: number, _y: number, _width: number, _height: number): void {},
};

/*
gfx/colormap.lmp's shape: VID_GRADES rows of 256, row 0 the identity (full
brightness leaves the palette index alone) and row 63 all index 0 (fully
dark). The rows in between dim monotonically, so a pixel drawn through a mid
row keeps the texture's variation instead of collapsing to one value.
*/
function realShapedColormap(): Uint8Array {
  const cm = new Uint8Array(256 * VID_GRADES);
  const last = VID_GRADES - 1;
  for (let row = 0; row < VID_GRADES; row++) {
    for (let p = 0; p < 256; p++) {
      cm[row * 256 + p] = row === last ? 0 : Math.round((p * (last - row)) / last);
    }
  }
  return cm;
}

/*
The same 64x256 shape, but every entry in row r is r+1 (and row 63 is 0, as
in the real file), so the value of a drawn pixel names the colormap row the
light level selected.
*/
function rowProbeColormap(): Uint8Array {
  const cm = new Uint8Array(256 * VID_GRADES);
  const last = VID_GRADES - 1;
  for (let row = 0; row < VID_GRADES; row++) {
    cm.fill(row === last ? 0 : row + 1, row * 256, row * 256 + 256);
  }
  return cm;
}

function setCvar(cv: { string: string; value: number }, v: number): void {
  cv.string = String(v);
  cv.value = v;
}

// vid_x.c's own numbers for a 320x200 mode, including the vid.aspect line
// (vid_x.c:668) this suite exists to keep in place
function setMode320x200(): void {
  vid.width = 320;
  vid.height = 200;
  vid.rowbytes = 320;
  vid.buffer = new Uint8Array(320 * 200);
  vid.conwidth = 320;
  vid.conheight = 200;
  vid.maxwarpwidth = 320;
  vid.maxwarpheight = 200;
  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);
  vid.numpages = 1;
}

let world: ModelT | null = null;

const savedBackend = vidBackend.current;
const savedRenderer = re.current;
const savedModelHooks = getModelLoaderHooks();
const savedSoftFactory = getRegisteredRenderer("soft");
const savedColormap = vid.colormap;
const savedFullbright = vid.fullbright;
const savedAspect = vid.aspect;
const savedWidth = vid.width;
const savedHeight = vid.height;
const savedRowbytes = vid.rowbytes;
const savedBuffer = vid.buffer;
const savedConwidth = vid.conwidth;
const savedConheight = vid.conheight;
const savedBlockDrawing = scrState.block_drawing;
const savedSbLines = scrState.sb_lines;
const savedZbuffer = rState.d_pzbuffer;
const savedQwActive = qw.active;
const savedRInit = hostClientHooks.rInit;
const savedRInitTextures = hostClientHooks.rInitTextures;
const savedDrawInit = hostClientHooks.drawInit;
const savedRViewVectors = hostClientHooks.rViewVectors;
const savedLightstyleLength = cl_lightstyle[0].length;
const savedLightstyleMap = cl_lightstyle[0].map;
const savedLightstyleValue = d_lightstylevalue[0];
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;
const savedComModified = com_modified;
const savedStaticRegistered = static_registered;

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/refsoftlit.bsp", buildBsp({ lightLevel: MID_LIGHT }));

  // see test/model.test.ts: COM_FindFile hides loose slash paths until
  // COM_CheckRegistered has seen gfx/pop.lmp inside a pak
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  // console.c's Con_Printf re-enters SCR_UpdateScreen while the client is not
  // signed on; D_InitCaches and R_NewMap both print. block_drawing is
  // screen.c's own first-line guard against that.
  scrState.block_drawing = true;

  setCvar(scr_viewsize, 100); // screen.c: cvar_t scr_viewsize = {"viewsize", "100", true}
  setCvar(scr_fov, 90); // screen.c: cvar_t scr_fov = {"fov", "90"}
  setCvar(lcd_x, 0); // view.c: cvar_t lcd_x = {"lcd_x", "0"}

  vidBackend.current = fakeVid;
  registerRenderer("soft", () => softRenderer);
  re.current = softRenderer;
  setModelLoaderHooks(softRenderer.modelHooks);

  // Cmd_AddCommand only throws on an already-*initialized* cmd registry
  // (cmdHost.initialized), not on a re-registered name -- a name collision
  // just prints "already defined" and returns, per test/ref_soft_main.test.ts's
  // own unconditional R_Init() call. Guarding this call on
  // Cmd_Exists("timerefresh") is actively wrong: src/ref_gl/gl_rmisc.ts's
  // *own*, different R_Init registers a command with the exact same name,
  // so once any GL suite in this process has run its own R_Init first, this
  // guard would skip ref_soft's R_Init entirely -- silently dropping its
  // r_refdef.xOrigin/yOrigin assignment, view_clipplanes setup, and
  // r_maxedges/r_maxsurfs Cvar_SetValue calls, none of which have anything
  // to do with command registration.
  R_Init();
  setCvar(r_ambient, 0); // r_main.c: cvar_t r_ambient = {"r_ambient", "0"}
  setCvar(r_fullbright, 0);
  setCvar(r_drawflat, 0);
  setCvar(r_drawentities, 0);
  setCvar(r_drawviewmodel, 0);

  // style 0 unmapped -> r_light.c's R_AnimateLight leaves it at 256
  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  setMode320x200();

  const mod = Mod_ForName("maps/refsoftlit.bsp", true);
  expect(mod).not.toBeNull();
  world = mod;
  cl.worldmodel = mod;
  cl_entities[0].model = mod;
  cl.viewentity = 0;
  cl.maxclients = 1;
  cl.intermission = 0;
  clState.cl_numvisedicts = 0;

  R_NewMap();
});

afterAll(() => {
  scrState.block_drawing = savedBlockDrawing;
  scrState.sb_lines = savedSbLines;
  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;
  vid.colormap = savedColormap;
  vid.fullbright = savedFullbright;
  vid.aspect = savedAspect;
  vid.width = savedWidth;
  vid.height = savedHeight;
  vid.rowbytes = savedRowbytes;
  vid.buffer = savedBuffer;
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  rState.d_pzbuffer = savedZbuffer;
  qw.active = savedQwActive;
  cl_entities[0].model = null;
  cl.viewentity = 0;
  cl.maxclients = 0;
  cl.worldmodel = null;
  clState.cl_numvisedicts = 0;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;
  d_lightstylevalue[0] = savedLightstyleValue;
  r_drawsurf.clear();
  vidBackend.current = savedBackend;
  re.current = savedRenderer;
  hostClientHooks.rInit = savedRInit;
  hostClientHooks.rInitTextures = savedRInitTextures;
  hostClientHooks.drawInit = savedDrawInit;
  hostClientHooks.rViewVectors = savedRViewVectors;
  setModelLoaderHooks(savedModelHooks);
  if (savedSoftFactory) registerRenderer("soft", savedSoftFactory);
  else unregisterRenderer("soft");
  setComSearchpaths(savedComSearchpaths);
  setComGamedir(savedComGamedir);
  setComModified(savedComModified);
  setStaticRegistered(savedStaticRegistered);
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================

/*
Renders one frame of the lit synthetic map from directly above its two
64-unit quads, the way test/ref_soft_main.test.ts's full-frame test stands
over them, and hands back the view rect's pixels.
*/
function renderFrame(colormap: Uint8Array, clearcolor: number): Uint8Array {
  vid.colormap = colormap;
  vid.fullbright = 256;
  setCvar(r_clearcolor, clearcolor);

  // vid_x.c's ResetFrameBuffer, as src/platform/vid.ts does it. D_InitCaches
  // does not clear the msurface_t cachespots the old heap owned (neither does
  // the C's), so a surface cached under a previous colormap would be handed
  // back unchanged -- D_FlushCaches is what drops those owners.
  softRenderer.D_FlushCaches();
  rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
  const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
  softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

  const vrectin = new VrectT();
  vrectin.width = vid.width;
  vrectin.height = vid.height;
  r_refdef.fov_x = 90;
  r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
  scrState.sb_lines = 24;
  R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

  r_refdef.vieworg[0] = -26;
  r_refdef.vieworg[1] = 5;
  r_refdef.vieworg[2] = 64;
  r_refdef.viewangles[0] = 45;
  r_refdef.viewangles[1] = 25;
  r_refdef.viewangles[2] = 0;

  const buffer = vid.buffer;
  expect(buffer).not.toBeNull();
  if (!buffer) return new Uint8Array(0);
  buffer.fill(0);

  R_RenderView();

  const vrect = r_refdef.vrect;
  const out = new Uint8Array(vrect.width * vrect.height);
  for (let row = 0; row < vrect.height; row++) {
    const src = (vrect.y + row) * vid.rowbytes + vrect.x;
    out.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
  }
  return out;
}

function histogram(pixels: Uint8Array): Map<number, number> {
  const h = new Map<number, number>();
  for (const p of pixels) h.set(p, (h.get(p) ?? 0) + 1);
  return h;
}

//============================================================================

describe("vid.aspect", () => {
  /*
  The root cause. vid_x.c:668 and gl_vidlinuxglx.c:890 both end their
  VID_Init with this line; src/platform/vid.ts's VID_CheckChanges is where
  this port sets the rest of that block, so it has to set this too --
  src/ref_gl/gl_vid.ts's GL_VidInit copy only covers the GL renderer.
  */
  test("VID_CheckChanges sets it from the mode it just selected", () => {
    VID_CheckChanges(false);

    expect(vid.width).toBeGreaterThan(0);
    expect(vid.height).toBeGreaterThan(0);
    expect(vid.aspect).toBe((vid.height / vid.width) * (320.0 / 240.0));
    expect(vid.aspect).toBeGreaterThan(0);

    // the mode switch replaced the buffer and the renderer instance; put the
    // suite's own 320x200 mode back for the frames below
    re.current = softRenderer;
    setModelLoaderHooks(softRenderer.modelHooks);
    setMode320x200();
  });

  // r_main.c: `yscale = xscale * pixelAspect;`. A zero pixelAspect is what
  // made every projected vertex land on ycenter.
  test("R_ViewChanged turns it into a non-zero yscale", () => {
    const vrectin = new VrectT();
    vrectin.width = vid.width;
    vrectin.height = vid.height;
    r_refdef.fov_x = 90;
    r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
    scrState.sb_lines = 24;

    R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

    expect(rState.pixelAspect).toBe(vid.aspect);
    expect(rState.yscale).toBe(rState.xscale * vid.aspect);
    expect(rState.yscale).toBeGreaterThan(0);
    expect(Number.isFinite(rState.verticalFieldOfView)).toBe(true);
  });
});

describe("R_RenderView on a lit map with a real-shaped colormap", () => {
  test("fills the view rect with textured pixels instead of r_clearcolor", () => {
    const pixels = renderFrame(realShapedColormap(), 2);
    const h = histogram(pixels);

    // the pre-fix frame was one value: r_clearcolor, from the background
    // surface, because no world surface ever got a span
    expect(h.size).toBeGreaterThan(4);

    let textured = 0;
    for (const [value, count] of h) if (value !== 2 && value !== 0) textured += count;
    expect(textured).toBeGreaterThan(pixels.length / 100);
  });

  test("draws no pixel through the colormap's all-black last row", () => {
    // row 63 of gfx/colormap.lmp is index 0 for every color; a lit surface
    // that lands there is the "everything textured is black" symptom
    const pixels = renderFrame(realShapedColormap(), 0);
    let nonzero = 0;
    for (const p of pixels) if (p !== 0) nonzero++;
    expect(nonzero).toBeGreaterThan(pixels.length / 100);
  });
});

describe("a mid-lit wall lands on a mid colormap row", () => {
  test("R_BuildLightMap turns a mid lightmap sample into a mid row", () => {
    expect(world).not.toBeNull();
    if (!world) return;

    const surf = world.surfaces[0];
    expect(surf.samples).not.toBeNull();
    expect(surf.styles[0]).toBe(0);

    const smax = (surf.extents[0] >> 4) + 1;
    const tmax = (surf.extents[1] >> 4) + 1;
    expect(smax * tmax).toBe(BSP_FACE_LIGHTMAP_SAMPLES);

    r_drawsurf.surf = surf;
    r_drawsurf.lightadj[0] = 256; // d_lightstylevalue[0] with style 0 unmapped
    r_drawsurf.lightadj[1] = 0;
    r_drawsurf.lightadj[2] = 0;
    r_drawsurf.lightadj[3] = 0;
    r_refdef.ambientlight = 0;

    R_BuildLightMap();

    for (let i = 0; i < smax * tmax; i++) {
      // R_DrawSurfaceBlock8_mipN indexes the colormap with `light & 0xff00`
      expect(blocklights[i] >> 8).toBe(EXPECTED_LIGHT_ROW);
    }
    expect(EXPECTED_LIGHT_ROW).toBeGreaterThan(0);
    expect(EXPECTED_LIGHT_ROW).toBeLessThan(VID_GRADES - 1);
  });

  test("every drawn wall pixel comes from that row of the colormap", () => {
    const pixels = renderFrame(rowProbeColormap(), 0);
    const h = histogram(pixels);

    // with r_clearcolor 0 and row 63 mapping to 0, any non-zero pixel is a
    // lit texel and its value is the colormap row + 1
    const rows = new Set<number>();
    let drawn = 0;
    for (const [value, count] of h) {
      if (value === 0) continue;
      rows.add(value - 1);
      drawn += count;
    }

    expect(drawn).toBeGreaterThan(pixels.length / 100);
    expect(Array.from(rows)).toEqual([EXPECTED_LIGHT_ROW]);
  });
});

describe("R_RenderWorld under qw.active", () => {
  /*
  QW/client/r_bsp.c:656 has `currententity = &r_worldentity;` where
  WinQuake/r_bsp.c has `currententity = &cl_entities[0];`: QW's cl_parse
  never fills cl_entities[0].model, and its R_NewMap sets r_worldentity.model
  from cl.worldmodel instead.
  */
  test("walks r_worldentity's model, not cl_entities[0]'s", () => {
    expect(world).not.toBeNull();
    if (!world) return;

    // a frame first, so the edge/surface pools and the view transform the
    // world walk reads are the ones R_RenderView set up
    renderFrame(realShapedColormap(), 2);

    const savedEntityModel = cl_entities[0].model;
    const savedWorldentityModel = r_worldentity.model;
    qw.active = true;
    cl_entities[0].model = null; // as QW's cl_parse leaves it
    r_worldentity.model = world;
    try {
      R_BeginEdgeFrame();
      R_RenderWorld();
      expect(rState.currententity).toBe(r_worldentity);
    } finally {
      qw.active = savedQwActive;
      cl_entities[0].model = savedEntityModel;
      r_worldentity.model = savedWorldentityModel;
    }
  });

  test("without qw.active it still walks cl_entities[0]", () => {
    expect(world).not.toBeNull();
    if (!world) return;

    R_BeginEdgeFrame();
    R_RenderWorld();
    expect(rState.currententity).toBe(cl_entities[0]);
  });
});
