// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
U25: colored lighting in the software renderer (src/ref_soft/r_coloredlight.ts,
ARCHITECTURE.md ruling R3). Not a ported C file -- test-only.

What each group proves:
  - a surface whose three light channels carry the same value renders into
    vid.buffer32 as the classic 8-bit frame expanded through d_8to24table,
    BYTE FOR BYTE. That is the whole safety argument for the design: the
    colored path is the 8-bit path run three times, so it cannot drift away
    from the classic look on a map without color.
  - a surface lit red comes out red, with the other two channels dark.
  - r_coloredlight 0 renders the same 8-bit bytes a map with no RGB data at
    all renders, so the cvar really is an off switch.
  - lightstyle values scale each channel independently.
  - the 2D overlay (Draw_Character, Draw_Pic) lands in buffer32 as the same
    8-bit pixels expanded through the palette, with index 255 still
    transparent.
  - the palette-shift blend V_UpdatePalette applies to the 8-bit palette is
    the same transform swimp.ts's present applies to a true-color pixel.
  - guarded real data: one frame of the re-release's e1m1 at 320x200, in both
    paths.

Self-sufficient per standing order 13: this file initializes the filesystem,
the renderer, the video mode, the palette table and every cvar it reads, and
restores every process-wide singleton it touches (vid.*, d_8to24table,
vidBackend.current, re.current, rState.*, the model-loader hooks, the
platform renderer registry, scrState, cl/clState/cl.cshifts, cl_lightstyle[0],
d_lightstylevalue[0], qw.active, r_drawsurf, swimp.ts's staging buffers).
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { hostClientHooks, hostBasepal, setHostBasepal } from "../src/common/host";
import { qw } from "../src/common/quakedef";
import { CMP_NONE, LUMPINFO_T_SIZE, QpicT, TYP_NONE, TYP_QPIC, WADINFO_T_SIZE, W_LoadWadFromBytes } from "../src/common/wad";
import { NUM_CSHIFTS, cl, cl_entities, cl_lightstyle, clState } from "../src/client/client";
import { r_refdef, re } from "../src/client/render";
import { VID_GRADES, d_8to24table, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { gammatable, lcd_x } from "../src/client/view";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer } from "../src/platform/vid";
import { SWimp_ExpandFrame32, SWimp_QuantizeFrame32, SWimp_ResetForTests, SWimp_ShiftedPalette } from "../src/platform/swimp";
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
} from "../src/ref_soft/r_main";
import { d_lightstylevalue, rState } from "../src/ref_soft/r_local";
import { R_BuildLightMap, R_BuildLightMapRGB, blocklights, blocklights_rgb } from "../src/ref_soft/r_surf";
import { R_BuildShiftRamps, r_coloredlight } from "../src/ref_soft/r_coloredlight";
import { Draw_Character, Draw_Init, Draw_Pic } from "../src/ref_soft/draw";
import { r_drawsurf } from "../src/ref_soft/d_iface";
import { BSP_FACE_LIGHTMAP_SAMPLES, BSP_NUMFACES, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-colored-light-test-"));
const baseDir = join(scratchDir, "quake");

// the greyscale lightmap sample every face carries, as in
// test/ref_soft_world_render.test.ts
const MID_LIGHT = 128;
const RGB_BYTES = BSP_NUMFACES * BSP_FACE_LIGHTMAP_SAMPLES * 3;

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
gfx/colormap.lmp's shape, as test/ref_soft_world_render.test.ts builds it:
VID_GRADES rows of 256, row 0 the identity and row 63 all index 0.
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
A palette whose three channels differ per index (so a pixel that took its
green byte from the red channel's lookup is visible), whose entry 0 is black
(so the colormap's all-dark row 63 really produces a dark channel), and whose
red byte is the index itself (so the expansion is injective).
src/platform/vid.ts's VID_SetPalette packs it exactly this way.
*/
function fillPaletteTable(): void {
  for (let i = 0; i < 256; i++) {
    const r = i;
    const g = i >> 1;
    const b = i >> 2;
    d_8to24table[i] = ((255 << 24) + (r << 0) + (g << 8) + (b << 16)) >>> 0;
  }
}

function setCvar(cv: { string: string; value: number }, v: number): void {
  cv.string = String(v);
  cv.value = v;
}

function setMode(width: number, height: number): void {
  vid.width = width;
  vid.height = height;
  vid.rowbytes = width;
  vid.buffer = new Uint8Array(width * height);
  vid.buffer32 = new Uint32Array(width * height);
  vid.conbuffer = vid.buffer;
  vid.conrowbytes = width;
  vid.conwidth = width;
  vid.conheight = height;
  vid.maxwarpwidth = 320;
  vid.maxwarpheight = 200;
  vid.aspect = (vid.height / vid.width) * (320.0 / 240.0);
  vid.numpages = 1;
}

//============================================================================
// the synthetic gfx.wad Draw_Init reads (same shape as
// test/ref_soft_draw2d.test.ts's, trimmed to what this file draws)

const CONCHARS_W = 128;
const CONCHARS_H = 128;
// num 65 ('A'): row = 65>>4 = 4, col = 65&15 = 1
const A_GLYPH_OFFSET = (4 << 10) + (1 << 3);
const A_ROW_PATTERN = [10, 0, 20, 0, 30, 0, 40, 0];

function buildQpicBytes(width: number, height: number, pixel: (i: number) => number): Uint8Array {
  const bytes = new Uint8Array(8 + width * height);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  for (let i = 0; i < width * height; i++) bytes[8 + i] = pixel(i) & 0xff;
  return bytes;
}

function writeLumpName(bytes: Uint8Array, offset: number, name: string): void {
  for (let i = 0; i < 16; i++) bytes[offset + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0;
}

function buildGfxWad(): Uint8Array {
  const conchars = new Uint8Array(CONCHARS_W * CONCHARS_H).fill(7);
  for (let r = 0; r < 8; r++) {
    const off = A_GLYPH_OFFSET + r * 128;
    for (let i = 0; i < 8; i++) conchars[off + i] = A_ROW_PATTERN[i] ?? 0;
  }
  const disc = buildQpicBytes(24, 24, (i) => i);
  const backtile = buildQpicBytes(64, 64, (i) => i);

  const headerSize = WADINFO_T_SIZE;
  const concharsFilepos = headerSize;
  const discFilepos = concharsFilepos + conchars.length;
  const backtileFilepos = discFilepos + disc.length;
  const infotableofs = backtileFilepos + backtile.length;
  const total = infotableofs + 3 * LUMPINFO_T_SIZE;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 3, true);
  view.setInt32(8, infotableofs, true);
  bytes.set(conchars, concharsFilepos);
  bytes.set(disc, discFilepos);
  bytes.set(backtile, backtileFilepos);

  const entries = [
    { filepos: concharsFilepos, size: conchars.length, type: TYP_NONE, name: "conchars" },
    { filepos: discFilepos, size: disc.length, type: TYP_QPIC, name: "disc" },
    { filepos: backtileFilepos, size: backtile.length, type: TYP_QPIC, name: "backtile" },
  ];
  let o = infotableofs;
  for (const e of entries) {
    view.setInt32(o, e.filepos, true);
    view.setInt32(o + 4, e.size, true);
    view.setInt32(o + 8, e.size, true);
    view.setInt8(o + 12, e.type);
    view.setInt8(o + 13, CMP_NONE);
    view.setInt8(o + 14, 0);
    view.setInt8(o + 15, 0);
    writeLumpName(bytes, o + 16, e.name);
    o += LUMPINFO_T_SIZE;
  }
  return bytes;
}

//============================================================================

let world: ModelT | null = null;
const colormap = realShapedColormap();

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
const savedBuffer32 = vid.buffer32;
const savedConbuffer = vid.conbuffer;
const savedConrowbytes = vid.conrowbytes;
const savedConwidth = vid.conwidth;
const savedConheight = vid.conheight;
const savedPalette = new Uint32Array(d_8to24table);
const savedBlockDrawing = scrState.block_drawing;
const savedSbLines = scrState.sb_lines;
const savedZbuffer = rState.d_pzbuffer;
const savedTruecolor = rState.r_truecolor;
const savedViewbuffer32 = rState.d_viewbuffer32;
const savedShiftramp = rState.d_shiftramp;
const savedQwActive = qw.active;
const savedRInit = hostClientHooks.rInit;
const savedRInitTextures = hostClientHooks.rInitTextures;
const savedDrawInit = hostClientHooks.drawInit;
const savedRViewVectors = hostClientHooks.rViewVectors;
const savedLightstyleLength = cl_lightstyle[0].length;
const savedLightstyleMap = cl_lightstyle[0].map;
const savedLightstyleValue = d_lightstylevalue[0];
const savedCshifts = cl.cshifts.map((c) => ({ percent: c.percent, destcolor: Int32Array.from(c.destcolor) }));
// view.c's gammatable is built by V_CheckGamma, which nothing in this suite
// calls; the ramp tests want a known transform, so it is the identity here
const savedGammatable = Uint8Array.from(gammatable);
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;
const savedComModified = com_modified;
const savedStaticRegistered = static_registered;

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/refsoftcolored.bsp", buildBsp({ lightLevel: MID_LIGHT }));

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
  W_LoadWadFromBytes("gfx.wad", buildGfxWad());

  scrState.block_drawing = true;

  setCvar(scr_viewsize, 100);
  setCvar(scr_fov, 90);
  setCvar(lcd_x, 0);

  vidBackend.current = fakeVid;
  registerRenderer("soft", () => softRenderer);
  re.current = softRenderer;
  setModelLoaderHooks(softRenderer.modelHooks);

  R_Init();
  Draw_Init();
  setCvar(r_ambient, 0);
  setCvar(r_fullbright, 0);
  setCvar(r_drawflat, 0);
  setCvar(r_drawentities, 0);
  setCvar(r_drawviewmodel, 0);
  setCvar(r_coloredlight, 1);

  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  fillPaletteTable();
  for (let i = 0; i < 256; i++) gammatable[i] = i;
  setMode(320, 200);
  vid.colormap = colormap;
  vid.fullbright = 256;

  const mod = Mod_ForName("maps/refsoftcolored.bsp", true);
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
  vid.buffer32 = savedBuffer32;
  vid.conbuffer = savedConbuffer;
  vid.conrowbytes = savedConrowbytes;
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  d_8to24table.set(savedPalette);
  rState.d_pzbuffer = savedZbuffer;
  rState.r_truecolor = savedTruecolor;
  rState.d_viewbuffer32 = savedViewbuffer32;
  rState.cacheblock32 = null;
  rState.d_shiftramp = savedShiftramp;
  rState.r_alias_tint_r = 256;
  rState.r_alias_tint_g = 256;
  rState.r_alias_tint_b = 256;
  qw.active = savedQwActive;
  cl_entities[0].model = null;
  cl.viewentity = 0;
  cl.maxclients = 0;
  cl.worldmodel = null;
  clState.cl_numvisedicts = 0;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;
  d_lightstylevalue[0] = savedLightstyleValue;
  for (let i = 0; i < NUM_CSHIFTS; i++) {
    cl.cshifts[i].percent = savedCshifts[i].percent;
    cl.cshifts[i].destcolor.set(savedCshifts[i].destcolor);
  }
  gammatable.set(savedGammatable);
  r_drawsurf.clear();
  SWimp_ResetForTests();
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

// every face's RGB samples set to one color
function setWorldRgb(r: number, g: number, b: number): void {
  const bytes = new Uint8Array(RGB_BYTES);
  for (let i = 0; i < RGB_BYTES; i += 3) {
    bytes[i] = r;
    bytes[i + 1] = g;
    bytes[i + 2] = b;
  }
  if (world) world.lightdata_rgb = bytes;
}

interface Frame {
  px8: Uint8Array;
  px32: Uint32Array;
  width: number;
  height: number;
}

/*
One frame from directly above the synthetic map's two quads -- the same view
test/ref_soft_world_render.test.ts renders -- with both framebuffers cleared
to the same color first, so an untouched pixel compares equal across the two
paths.
*/
function renderFrame(clearcolor: number): Frame {
  setCvar(r_clearcolor, clearcolor);

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
  const buffer32 = vid.buffer32;
  expect(buffer).not.toBeNull();
  expect(buffer32).not.toBeNull();
  if (!buffer || !buffer32) return { px8: new Uint8Array(0), px32: new Uint32Array(0), width: 0, height: 0 };
  buffer.fill(0);
  buffer32.fill(d_8to24table[0]);

  R_RenderView();

  const vrect = r_refdef.vrect;
  const px8 = new Uint8Array(vrect.width * vrect.height);
  const px32 = new Uint32Array(vrect.width * vrect.height);
  for (let row = 0; row < vrect.height; row++) {
    const src = (vrect.y + row) * vid.rowbytes + vrect.x;
    px8.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
    px32.set(buffer32.subarray(src, src + vrect.width), row * vrect.width);
  }
  return { px8, px32, width: vrect.width, height: vrect.height };
}

function countDistinct(px: Uint32Array): number {
  const seen = new Set<number>();
  for (const p of px) seen.add(p);
  return seen.size;
}

//============================================================================

describe("an equal-channel .lit renders as the classic frame expanded through the palette", () => {
  test("every pixel of the true-color frame is d_8to24table[the 8-bit pixel]", () => {
    setWorldRgb(MID_LIGHT, MID_LIGHT, MID_LIGHT);

    setCvar(r_coloredlight, 1);
    const colored = renderFrame(2);
    expect(rState.r_truecolor).toBe(true);

    setCvar(r_coloredlight, 0);
    const classic = renderFrame(2);
    expect(rState.r_truecolor).toBe(false);

    expect(colored.width).toBe(classic.width);
    expect(colored.height).toBe(classic.height);
    expect(colored.px32.length).toBeGreaterThan(0);

    // the frame really has content, not just the background surface
    expect(countDistinct(colored.px32)).toBeGreaterThan(4);

    let mismatch = -1;
    for (let i = 0; i < classic.px8.length; i++) {
      if (colored.px32[i] !== d_8to24table[classic.px8[i]]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  });

  test("the true-color frame left the 8-bit framebuffer untouched", () => {
    setWorldRgb(MID_LIGHT, MID_LIGHT, MID_LIGHT);
    setCvar(r_coloredlight, 1);
    const colored = renderFrame(2);
    // renderFrame clears vid.buffer to 0 and the whole 3D pass writes only
    // vid.buffer32 while rState.r_truecolor is set
    for (const p of colored.px8) expect(p).toBe(0);
  });
});

describe("r_coloredlight 0 is a real off switch", () => {
  test("the 8-bit frame is byte-for-byte the frame a map with no RGB data renders", () => {
    setWorldRgb(255, 0, 0); // as different from grey as the fixture gets
    setCvar(r_coloredlight, 0);
    const withRgbData = renderFrame(2);

    if (world) world.lightdata_rgb = null;
    const withoutRgbData = renderFrame(2);

    expect(withRgbData.px8.length).toBe(withoutRgbData.px8.length);
    let mismatch = -1;
    for (let i = 0; i < withRgbData.px8.length; i++) {
      if (withRgbData.px8[i] !== withoutRgbData.px8[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
    expect(rState.r_truecolor).toBe(false);
  });

  test("with no RGB data at all the true-color path never turns on", () => {
    if (world) world.lightdata_rgb = null;
    setCvar(r_coloredlight, 1);
    renderFrame(2);
    expect(rState.r_truecolor).toBe(false);
  });
});

describe("a red-lit surface comes out red", () => {
  test("drawn pixels keep their red byte and lose green and blue", () => {
    setWorldRgb(255, 0, 0);
    setCvar(r_coloredlight, 1);
    const frame = renderFrame(0);
    expect(rState.r_truecolor).toBe(true);

    const bg = d_8to24table[0]; // r_clearcolor 0 and the cleared buffer
    let lit = 0;
    let reddish = 0;
    for (const p of frame.px32) {
      if (p === bg) continue;
      lit++;
      const r = p & 0xff;
      const g = (p >>> 8) & 0xff;
      const b = (p >>> 16) & 0xff;
      // the green and blue channels sampled colormap row 63, which is
      // palette index 0 -- black in this file's palette
      if (r > 0 && g === 0 && b === 0) reddish++;
    }

    expect(lit).toBeGreaterThan(frame.px32.length / 100);
    expect(reddish).toBe(lit);
  });

  test("the same geometry lit blue comes out blue", () => {
    setWorldRgb(0, 0, 255);
    setCvar(r_coloredlight, 1);
    const frame = renderFrame(0);

    const bg = d_8to24table[0];
    let lit = 0;
    let blueish = 0;
    for (const p of frame.px32) {
      if (p === bg) continue;
      lit++;
      const r = p & 0xff;
      const g = (p >>> 8) & 0xff;
      const b = (p >>> 16) & 0xff;
      if (b > 0 && r === 0 && g === 0) blueish++;
    }

    expect(lit).toBeGreaterThan(frame.px32.length / 100);
    expect(blueish).toBe(lit);
  });
});

describe("R_BuildLightMapRGB", () => {
  /*
  r_surf.c's R_BuildLightMap does `t = (255*256 - blocklights[i]) >>
  (8 - VID_CBITS)`, clamped up to 1<<6, per texel. R_BuildLightMapRGB does
  exactly that per channel, from the .lit samples.
  */
  function expectedLight(sample: number, scale: number): number {
    let t = (255 * 256 - sample * scale) >> 2;
    if (t < 1 << 6) t = 1 << 6;
    return t;
  }

  function buildFor(r: number, g: number, b: number, scale: number): void {
    expect(world).not.toBeNull();
    if (!world) return;
    setWorldRgb(r, g, b);
    const surf = world.surfaces[0];
    r_drawsurf.surf = surf;
    r_drawsurf.lightadj[0] = scale;
    r_drawsurf.lightadj[1] = 0;
    r_drawsurf.lightadj[2] = 0;
    r_drawsurf.lightadj[3] = 0;
    r_refdef.ambientlight = 0;
    setCvar(r_fullbright, 0);
    R_BuildLightMapRGB();
  }

  test("each channel takes its own .lit byte", () => {
    buildFor(200, 100, 50, 256);
    for (let i = 0; i < BSP_FACE_LIGHTMAP_SAMPLES; i++) {
      expect(blocklights_rgb[i * 3 + 0]).toBe(expectedLight(200, 256));
      expect(blocklights_rgb[i * 3 + 1]).toBe(expectedLight(100, 256));
      expect(blocklights_rgb[i * 3 + 2]).toBe(expectedLight(50, 256));
    }
    // and they really are three different light levels
    expect(blocklights_rgb[0]).not.toBe(blocklights_rgb[1]);
    expect(blocklights_rgb[1]).not.toBe(blocklights_rgb[2]);
  });

  test("the lightstyle value scales every channel", () => {
    buildFor(200, 100, 50, 128);
    for (let i = 0; i < BSP_FACE_LIGHTMAP_SAMPLES; i++) {
      expect(blocklights_rgb[i * 3 + 0]).toBe(expectedLight(200, 128));
      expect(blocklights_rgb[i * 3 + 1]).toBe(expectedLight(100, 128));
      expect(blocklights_rgb[i * 3 + 2]).toBe(expectedLight(50, 128));
    }
  });

  test("an equal-channel .lit gives every channel the 8-bit blocklights value", () => {
    buildFor(MID_LIGHT, MID_LIGHT, MID_LIGHT, 256);
    const rgb = Uint32Array.from(blocklights_rgb.subarray(0, BSP_FACE_LIGHTMAP_SAMPLES * 3));

    // the 8-bit builder over the same surface and the same scale
    R_BuildLightMap();
    const grey = Uint32Array.from(blocklights.subarray(0, BSP_FACE_LIGHTMAP_SAMPLES));

    for (let i = 0; i < BSP_FACE_LIGHTMAP_SAMPLES; i++) {
      expect(rgb[i * 3 + 0]).toBe(grey[i]);
      expect(rgb[i * 3 + 1]).toBe(grey[i]);
      expect(rgb[i * 3 + 2]).toBe(grey[i]);
    }
  });
});

describe("the 2D overlay in true color", () => {
  function drawBoth(draw: () => void): { px8: Uint8Array; px32: Uint32Array } {
    const buffer = vid.buffer;
    const buffer32 = vid.buffer32;
    expect(buffer).not.toBeNull();
    expect(buffer32).not.toBeNull();
    if (!buffer || !buffer32) return { px8: new Uint8Array(0), px32: new Uint32Array(0) };

    buffer.fill(0);
    buffer32.fill(d_8to24table[0]);
    rState.r_truecolor = true;
    draw();
    const px32 = Uint32Array.from(buffer32);

    buffer.fill(0);
    buffer32.fill(d_8to24table[0]);
    rState.r_truecolor = false;
    draw();
    const px8 = Uint8Array.from(buffer);

    return { px8, px32 };
  }

  test("Draw_Character lands in buffer32 as the 8-bit glyph expanded", () => {
    const { px8, px32 } = drawBoth(() => Draw_Character(16, 24, "A".charCodeAt(0)));
    let mismatch = -1;
    let drawn = 0;
    for (let i = 0; i < px8.length; i++) {
      if (px8[i] !== 0) drawn++;
      if (px32[i] !== d_8to24table[px8[i]]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
    // the 'A' glyph's non-transparent half really did draw
    expect(drawn).toBe(8 * 4);
  });

  test("Draw_Pic lands in buffer32 as the 8-bit pic expanded", () => {
    const pic = new QpicT();
    pic.width = 16;
    pic.height = 8;
    pic.data = new Uint8Array(16 * 8);
    for (let i = 0; i < pic.data.length; i++) pic.data[i] = (i * 7 + 3) & 0xff;

    const { px8, px32 } = drawBoth(() => Draw_Pic(32, 48, pic));
    let mismatch = -1;
    for (let i = 0; i < px8.length; i++) {
      if (px32[i] !== d_8to24table[px8[i]]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
    // and the pic's own bytes really landed
    expect(px8[48 * vid.rowbytes + 32]).toBe(pic.data[0]);
  });
});

describe("the palette-shift blend", () => {
  /*
  view.c's V_UpdatePalette blends each palette entry toward every cshift's
  destcolor and runs the result through gammatable. R_BuildShiftRamps is that
  same transform over the whole 0..255 range, and swimp.ts's
  SWimp_ExpandFrame32 applies it to a true-color pixel.
  */
  test("a ramped channel equals V_UpdatePalette's own arithmetic on that value", () => {
    for (let i = 0; i < NUM_CSHIFTS; i++) {
      cl.cshifts[i].percent = 0;
      cl.cshifts[i].destcolor[0] = 0;
      cl.cshifts[i].destcolor[1] = 0;
      cl.cshifts[i].destcolor[2] = 0;
    }
    // a damage flash: 40% toward red
    cl.cshifts[1].percent = 102;
    cl.cshifts[1].destcolor[0] = 255;
    cl.cshifts[1].destcolor[1] = 0;
    cl.cshifts[1].destcolor[2] = 0;

    const ramp = new Uint8Array(3 * 256);
    R_BuildShiftRamps(gammatable, ramp);

    for (const probe of [0, 1, 63, 128, 200, 255]) {
      for (let ch = 0; ch < 3; ch++) {
        let c = probe;
        for (let j = 0; j < NUM_CSHIFTS; j++) {
          c += (cl.cshifts[j].percent * (cl.cshifts[j].destcolor[ch] - c)) >> 8;
        }
        expect(ramp[ch * 256 + probe]).toBe(gammatable[c]);
      }
    }

    // a neutral channel is untouched by a red-only shift
    expect(ramp[256 + 128]).toBe(gammatable[128 + ((102 * (0 - 128)) >> 8)]);
    // and red really moved
    expect(ramp[0 + 128]).toBeGreaterThan(ramp[256 + 128]);
  });

  test("SWimp_ExpandFrame32 applies the ramps per channel and forces alpha opaque", () => {
    const ramp = new Uint8Array(3 * 256);
    for (let i = 0; i < 256; i++) {
      ramp[i] = 255 - i; // r inverted
      ramp[256 + i] = i >> 1; // g halved
      ramp[512 + i] = i; // b identity
    }

    const src = new Uint32Array(4);
    src[0] = ((255 << 24) + (10 << 0) + (20 << 8) + (30 << 16)) >>> 0;
    src[1] = ((255 << 24) + (0 << 0) + (0 << 8) + (0 << 16)) >>> 0;
    src[2] = ((255 << 24) + (255 << 0) + (255 << 8) + (255 << 16)) >>> 0;
    src[3] = ((255 << 24) + (7 << 0) + (9 << 8) + (11 << 16)) >>> 0;

    const out = new Uint8Array(4 * 4);
    SWimp_ExpandFrame32(src, 4, 4, 1, ramp, out);

    expect(Array.from(out.subarray(0, 4))).toEqual([245, 10, 30, 255]);
    expect(Array.from(out.subarray(4, 8))).toEqual([255, 0, 0, 255]);
    expect(Array.from(out.subarray(8, 12))).toEqual([0, 127, 255, 255]);
    expect(Array.from(out.subarray(12, 16))).toEqual([248, 4, 11, 255]);

    // a null ramp is the identity
    const plain = new Uint8Array(4 * 4);
    SWimp_ExpandFrame32(src, 4, 4, 1, null, plain);
    expect(Array.from(plain.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  // P20 (2026-09-08, Mike: "died in lava, now shadows are bright"): in true
  // colour the shift used to be applied twice -- baked into d_8to24table by
  // VID_ShiftPalette (which the surface cache then expands texels through,
  // keeping a lava tint on cached surfaces after the shift ended) and again
  // by the present ramp. The table now stays at the base palette; the ramp
  // is the whole shift. The classic 8-bit path keeps the shifted palette.
  test("in true colour V_UpdatePalette hands VID_ShiftPalette the BASE palette; only the ramp carries the shift", () => {
    const basepal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { basepal[i * 3] = i; basepal[i * 3 + 1] = i >> 1; basepal[i * 3 + 2] = i >> 2; }
    const savedBasepal = hostBasepal();
    const savedShift = fakeVid.VID_ShiftPalette;
    const savedTruecolor = rState.r_truecolor;
    let handed: Uint8Array | null = null;
    fakeVid.VID_ShiftPalette = (p: Uint8Array): void => { handed = new Uint8Array(p); };
    try {
      setHostBasepal(basepal);
      for (let i = 0; i < NUM_CSHIFTS; i++) { cl.cshifts[i].percent = 0; cl.prev_cshifts[i].percent = 0; }
      cl.cshifts[1].percent = 102; // a damage flash, 40% toward red
      cl.cshifts[1].destcolor[0] = 255; cl.cshifts[1].destcolor[1] = 0; cl.cshifts[1].destcolor[2] = 0;

      rState.r_truecolor = true;
      softRenderer.V_UpdatePalette();
      expect(handed).not.toBeNull();
      expect(Array.from(handed!.subarray(128 * 3, 128 * 3 + 3))).toEqual([128, 64, 32]); // entry 128 untinted
      // the shift is in the ramp: the same builder over the live gamma table
      // (whatever an earlier suite left it at) must reproduce it, and it must
      // differ from the unshifted value
      const ramp = rState.d_shiftramp!;
      const expected = new Uint8Array(3 * 256);
      R_BuildShiftRamps(gammatable, expected);
      expect(ramp[128]).toBe(expected[128]);
      expect(ramp[256 + 128]).toBe(expected[256 + 128]);
      expect(ramp[128]).not.toBe(ramp[256 + 128]); // red moved, green did not

      // the classic 8-bit path still receives the shifted palette: entry 128
      // moved toward red (its own blend arithmetic, integer, so it is not
      // compared byte-for-byte against the ramp's float build -- the two
      // round differently once an earlier suite has left gamma off 1)
      cl.prev_cshifts[1].percent = 0; // make the change "new" again
      rState.r_truecolor = false;
      softRenderer.V_UpdatePalette();
      expect(handed![128 * 3]).toBeGreaterThan(handed![128 * 3 + 1]); // red pulled up, green pulled down
      expect(handed![128 * 3]).not.toBe(128); // not the base entry
      expect(handed![128 * 3 + 1]).toBeLessThan(64);
    } finally {
      fakeVid.VID_ShiftPalette = savedShift;
      rState.r_truecolor = savedTruecolor;
      setHostBasepal(savedBasepal);
      for (let i = 0; i < NUM_CSHIFTS; i++) { cl.cshifts[i].percent = 0; cl.prev_cshifts[i].percent = 0; }
    }
  });

  test("SWimp_ShiftedPalette tints a base RGBA palette through the ramp, per channel, alpha kept", () => {
    const base = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { base[i * 4] = i; base[i * 4 + 1] = i >> 1; base[i * 4 + 2] = i >> 2; base[i * 4 + 3] = 255; }
    const ramp = new Uint8Array(3 * 256);
    for (let i = 0; i < 256; i++) { ramp[i] = 255 - i; ramp[256 + i] = i >> 1; ramp[512 + i] = i; }
    const out = SWimp_ShiftedPalette(base, ramp);
    expect(Array.from(out.subarray(200 * 4, 200 * 4 + 4))).toEqual([55, 50, 50, 255]);
    expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(out).not.toBe(base); // the live table is never rewritten
  });

  test("SWimp_QuantizeFrame32 finds the palette index nearest each pixel", () => {
    // this file's palette is (r = i, g = i>>1, b = i>>2), so an exact
    // palette color must quantize back to its own index
    const src = new Uint32Array(3);
    src[0] = d_8to24table[0];
    src[1] = d_8to24table[128];
    src[2] = d_8to24table[248]; // 5-bit-exact red
    const out = new Uint8Array(3);
    SWimp_QuantizeFrame32(src, 3, 3, 1, out);
    // black is exact; the other two land within one 5:5:5 cell of their own
    // index, since the search rounds the low three bits of every channel away
    expect(out[0]).toBe(0);
    expect(Math.abs(out[1] - 128)).toBeLessThanOrEqual(8);
    expect(Math.abs(out[2] - 248)).toBeLessThanOrEqual(8);
  });
});

//============================================================================
// timing (printed, never asserted -- standing order: no perf assertions)

describe("640x480 frame cost", () => {
  test("true-color vs 8-bit milliseconds per frame", () => {
    const FRAMES = 12;
    setMode(640, 480);

    setWorldRgb(MID_LIGHT, 64, 200);
    setCvar(r_coloredlight, 1);
    renderFrame(2); // warm the JIT and the surface cache
    let t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) renderFrame(2);
    const coloredMs = (performance.now() - t0) / FRAMES;

    setCvar(r_coloredlight, 0);
    renderFrame(2);
    t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) renderFrame(2);
    const classicMs = (performance.now() - t0) / FRAMES;

    // Sys_Printf is the port's only console seam, but this is a test harness
    // note, not engine output
    process.stdout.write(
      `\n[U25] 640x480 software frame: 8-bit ${classicMs.toFixed(2)} ms, true-color ${coloredMs.toFixed(2)} ms ` +
        `(${(coloredMs / classicMs).toFixed(2)}x)\n`,
    );

    expect(coloredMs).toBeGreaterThan(0);
    expect(classicMs).toBeGreaterThan(0);

    setMode(320, 200);
    setCvar(r_coloredlight, 1);
  });
});

//============================================================================
// Guarded real-data: one frame of the re-release's e1m1, which ships colored
// light data, at 320x200.

const REAL_Q1_DIR = process.env.Q1TS_REAL_DATA ?? "/home/buzzkill/Projects/qfiles/q1";
const HAVE_REAL_Q1 = existsSync(join(REAL_Q1_DIR, "id1")) && existsSync(join(REAL_Q1_DIR, "rerelease"));

describe.skipIf(!HAVE_REAL_Q1)("real data: rerelease/id1 e1m1", () => {
  test("renders one 320x200 frame in both paths, with color in the true-color one", () => {
    COM_InitArgv(["quake", "-basedir", REAL_Q1_DIR]);
    COM_InitFilesystem();
    COM_CheckRegistered();

    const mod = Mod_ForName("maps/e1m1.bsp", true);
    expect(mod).not.toBeNull();
    if (!mod) return;

    cl.worldmodel = mod;
    cl_entities[0].model = mod;
    R_NewMap();

    setMode(320, 200);
    // stand at e1m1's info_player_start, looking down the corridor
    setCvar(r_coloredlight, mod.lightdata_rgb !== null ? 1 : 0);

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

    r_refdef.vieworg[0] = 480;
    r_refdef.vieworg[1] = -352;
    r_refdef.vieworg[2] = 88;
    r_refdef.viewangles[0] = 0;
    r_refdef.viewangles[1] = 90;
    r_refdef.viewangles[2] = 0;

    const buffer = vid.buffer;
    const buffer32 = vid.buffer32;
    expect(buffer).not.toBeNull();
    expect(buffer32).not.toBeNull();
    if (!buffer || !buffer32) return;

    buffer.fill(0);
    buffer32.fill(0);
    R_RenderView();

    const hasRgb = mod.lightdata_rgb !== null;
    const colored32 = Uint32Array.from(buffer32);
    if (hasRgb) {
      expect(rState.r_truecolor).toBe(true);
      let drawn = 0;
      let nonGrey = 0;
      for (const p of colored32) {
        if (p === 0) continue;
        drawn++;
        const r = p & 0xff;
        const g = (p >>> 8) & 0xff;
        const b = (p >>> 16) & 0xff;
        if (r !== g || g !== b) nonGrey++;
      }
      expect(drawn).toBeGreaterThan(colored32.length / 100);
      expect(nonGrey).toBeGreaterThan(0);
    }

    // and the classic path still draws the same map
    setCvar(r_coloredlight, 0);
    softRenderer.D_FlushCaches();
    softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);
    buffer.fill(0);
    R_RenderView();
    expect(rState.r_truecolor).toBe(false);
    let drawn8 = 0;
    for (const p of buffer) if (p !== 0) drawn8++;
    expect(drawn8).toBeGreaterThan(buffer.length / 100);

    if (hasRgb) {
      // the colored frame is not merely the classic frame expanded: the .lit
      // data really changed pixels
      let differing = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (colored32[i] !== d_8to24table[buffer[i]]) differing++;
      }
      process.stdout.write(`\n[U25] e1m1 320x200: ${differing} of ${buffer.length} pixels differ from the classic frame\n`);
      expect(differing).toBeGreaterThan(0);
    }

    cl.worldmodel = null;
    cl_entities[0].model = null;
  });
});
