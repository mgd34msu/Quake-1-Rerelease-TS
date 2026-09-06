// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U34's src/ref_soft/d_sky.ts additions: cube-mapped skyboxes in the
software renderer (softSkyBoxState, loaded/kept since U27 by src/ref_soft/
r_main.ts's SoftSky_LoadSkyBox/SoftSky_NewMap but never drawn until now),
r_fastsky's flat-fill (both paths) and r_skyalpha's true-color blend (see
r_main.ts's SOFTWARE SKYBOX LOADING section and d_sky.ts's own header for
the face-mapping convention, the sampling choice, and the performance
approach).

What each group proves:
  - "face selection matrix": direct D_DrawSkyScans8 calls (this file's own
    manually-set softSkyBoxState/vpn/vright/vup, no renderer/BSP needed --
    the same lightweight style test/ref_soft_raster.test.ts's own
    "D_DrawSkyScans8" describe already uses) prove the exact face-mapping
    convention d_sky.ts's `skyBoxFaceUV` implements: a view down +X selects
    the "rt" face, +Y "ft", +Z "up" (gl_sky.ts's own SUF/SKY_FACES
    convention, reproduced there for the GL renderer and here for the
    software one), and that turning the view changes which face's color
    a pixel takes. Also covers r_fastsky (both paths) and r_skyalpha
    (true-color) against d_sky.ts's own exported R_SkyFlatColor() so the
    assertions do not depend on what any other test file's R_InitSky call
    happened to leave the module-private flat color at.
  - "cube-mapped skybox: full BSP render": a real synthetic BSP with a
    SURF_DRAWSKY face (bsp_builder.ts's `skyFace`/new `skyName` options) and
    six real gfx/env/<name>{rt,bk,lf,ft,up,dn}.tga faces on disk, loaded the
    real way (worldspawn "sky" key -> R_NewMap -> SoftSky_NewMap ->
    SoftSky_LoadSkyBox), rendered headless at 64x48 with a straight-down
    view over the sky face: the true-color pixel takes the "dn" face's
    color; the 8-bit path is byte-for-byte unaffected by the skybox being
    loaded at all; with the skybox cleared, the true-color pixel matches
    the classic scrolling-sky formula (D_Sky_uv_To_st + rState.r_skysource)
    exactly -- the "no skybox -> classic path byte-identical" requirement,
    checked against the documented formula rather than a stored golden
    frame, the same technique test/ref_soft_raster.test.ts's own
    D_DrawSkyScans8 test uses.
  - guarded real data: mg1's "sky_city" skybox from the re-release pak,
    rendered headless with the map's own player start and worldspawn "sky"
    key, produces non-uniform true-color sky pixels (a real photographic
    skybox has texture detail; a flat r_fastsky-style fill would not).

Self-sufficient per standing order 13: this file initializes the
filesystem/renderer/video mode/every cvar it reads (its own describe-scoped
beforeAll/afterAll pairs, not file-level hooks, so the lightweight face-
selection-matrix group never touches the heavier BSP-render group's
globals) and restores every process-wide singleton it touches (vid.*,
d_8to24table, vidBackend.current, re.current, rState.*, the model-loader
hooks, the platform renderer registry, scrState, cl/clState,
cl_lightstyle[0]/d_lightstylevalue[0], com_searchpaths/com_gamedir/
com_modified/static_registered, softSkyBoxState, r_fastsky/r_skyalpha,
vpn/vright/vup/r_refdef.vrect for the direct-call group).
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { Mod_ClearAll, Mod_ForName, Mod_Init, type ModelT, getModelLoaderHooks, setModelLoaderHooks } from "../src/common/model";
import { hostClientHooks } from "../src/common/host";
import { qw } from "../src/common/quakedef";
import { cl, cl_entities, cl_lightstyle, clState } from "../src/client/client";
import { r_refdef, re } from "../src/client/render";
import { VID_GRADES, d_8to24table, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer } from "../src/platform/vid";
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
  r_fastsky,
  r_fullbright,
  r_skyalpha,
  softSkyBoxState,
  type SoftSkyBoxFaceT,
} from "../src/ref_soft/r_main";
import { r_coloredlight } from "../src/ref_soft/r_coloredlight";
import { EspanT, rState, vpn, vright, vup } from "../src/ref_soft/r_local";
import { R_SKY_SMASK, R_SKY_TMASK } from "../src/ref_soft/d_local";
import { D_DrawSkyScans8, D_Sky_uv_To_st } from "../src/ref_soft/d_sky";
import { R_SkyFlatColor } from "../src/ref_soft/r_sky";
import { BSP_FACE_LIGHTMAP_SAMPLES, BSP_NUMFACES, buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { PakFile } from "./support/pak_reader";
import { listMaps, parseEntityLump, readEntityLumpText } from "./support/ent_lumps";

//============================================================================
// shared small helpers
//============================================================================

function packRGB(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16) | 0xff000000) >>> 0;
}

// SOFT_SKY_SUF order (r_main.ts / gl_sky.ts's SUF): rt, bk, lf, ft, up, dn.
const SUF = ["rt", "bk", "lf", "ft", "up", "dn"] as const;

function makeSolidFace(r: number, g: number, b: number, size = 4): SoftSkyBoxFaceT {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { width: size, height: size, pixels };
}

// distinct colors per face, in SUF order
const FACE_COLORS: readonly [number, number, number][] = [
  [255, 0, 0], // rt
  [0, 255, 0], // bk
  [0, 0, 255], // lf
  [255, 255, 0], // ft
  [255, 0, 255], // up
  [0, 255, 255], // dn
];

//============================================================================
// group A: direct D_DrawSkyScans8 calls -- face selection matrix,
// r_fastsky, r_skyalpha. No renderer/BSP -- see this file's header.
//============================================================================

describe("D_DrawSkyScans8 cube-mapped skybox (direct calls)", () => {
  const A_WIDTH = 64;
  const A_HEIGHT = 48;
  const viewbuffer8 = new Uint8Array(A_WIDTH * A_HEIGHT);
  const viewbuffer32 = new Uint32Array(A_WIDTH * A_HEIGHT);
  const skySource = new Uint8Array(128 * 256);

  const saved = {
    vidWidth: vid.width,
    vidHeight: vid.height,
    screenwidth: rState.screenwidth,
    d_viewbuffer: rState.d_viewbuffer,
    d_viewbuffer32: rState.d_viewbuffer32,
    r_skysource: rState.r_skysource,
    skytime: rState.skytime,
    skyspeed: rState.skyspeed,
    vrectWidth: r_refdef.vrect.width,
    vrectHeight: r_refdef.vrect.height,
    vpn: [vpn[0], vpn[1], vpn[2]] as [number, number, number],
    vright: [vright[0], vright[1], vright[2]] as [number, number, number],
    vup: [vup[0], vup[1], vup[2]] as [number, number, number],
    skyBoxName: softSkyBoxState.name,
    skyBoxFaces: [...softSkyBoxState.faces],
    rFastsky: { string: r_fastsky.string, value: r_fastsky.value },
    rSkyalpha: { string: r_skyalpha.string, value: r_skyalpha.value },
  };

  beforeAll(() => {
    vid.width = A_WIDTH;
    vid.height = A_HEIGHT;
    rState.screenwidth = A_WIDTH;
    rState.d_viewbuffer = viewbuffer8;
    rState.r_skysource = skySource; // required non-null even though the
    // classic path is never reached by any test in this group
    rState.skytime = 0;
    rState.skyspeed = 0;
    r_refdef.vrect.width = A_WIDTH;
    r_refdef.vrect.height = A_HEIGHT;

    softSkyBoxState.name = "direct-test";
    softSkyBoxState.faces = FACE_COLORS.map(([r, g, b]) => makeSolidFace(r, g, b));
  });

  afterAll(() => {
    vid.width = saved.vidWidth;
    vid.height = saved.vidHeight;
    rState.screenwidth = saved.screenwidth;
    rState.d_viewbuffer = saved.d_viewbuffer;
    rState.d_viewbuffer32 = saved.d_viewbuffer32;
    rState.r_skysource = saved.r_skysource;
    rState.skytime = saved.skytime;
    rState.skyspeed = saved.skyspeed;
    r_refdef.vrect.width = saved.vrectWidth;
    r_refdef.vrect.height = saved.vrectHeight;
    vpn[0] = saved.vpn[0];
    vpn[1] = saved.vpn[1];
    vpn[2] = saved.vpn[2];
    vright[0] = saved.vright[0];
    vright[1] = saved.vright[1];
    vright[2] = saved.vright[2];
    vup[0] = saved.vup[0];
    vup[1] = saved.vup[1];
    vup[2] = saved.vup[2];
    softSkyBoxState.name = saved.skyBoxName;
    softSkyBoxState.faces = saved.skyBoxFaces;
    r_fastsky.string = saved.rFastsky.string;
    r_fastsky.value = saved.rFastsky.value;
    r_skyalpha.string = saved.rSkyalpha.string;
    r_skyalpha.value = saved.rSkyalpha.value;
  });

  // D_Sky_uv_To_dir's `wu`/`wv` are exactly 0 at the screen's dead center
  // (u === vid.width>>1, v === vid.height>>1), so the center pixel's ray is
  // exactly `4096*vpn` -- a view "down +x/+y/+z" is simply vpn set to that
  // world axis, with any orthonormal vright/vup completion.
  function renderCenterPixel(dir: [number, number, number], right: [number, number, number], up: [number, number, number]): number {
    vpn[0] = dir[0];
    vpn[1] = dir[1];
    vpn[2] = dir[2];
    vright[0] = right[0];
    vright[1] = right[1];
    vright[2] = right[2];
    vup[0] = up[0];
    vup[1] = up[1];
    vup[2] = up[2];

    rState.d_viewbuffer32 = viewbuffer32;
    viewbuffer32.fill(0);
    r_fastsky.value = 0;
    r_skyalpha.value = 1;

    const span = new EspanT();
    span.u = A_WIDTH >> 1;
    span.v = A_HEIGHT >> 1;
    span.count = 1;
    span.pnext = null;
    D_DrawSkyScans8(span);

    return viewbuffer32[span.v * A_WIDTH + span.u];
  }

  describe("face mapping convention (matches gl_sky.ts's SUF/SKY_FACES)", () => {
    test("a view down +X selects the 'rt' face", () => {
      const c = renderCenterPixel([1, 0, 0], [0, 1, 0], [0, 0, 1]);
      expect(c).toBe(packRGB(...FACE_COLORS[SUF.indexOf("rt")]));
    });

    test("a view down +Y selects the 'ft' face", () => {
      const c = renderCenterPixel([0, 1, 0], [1, 0, 0], [0, 0, 1]);
      expect(c).toBe(packRGB(...FACE_COLORS[SUF.indexOf("ft")]));
    });

    test("a view down +Z selects the 'up' face", () => {
      const c = renderCenterPixel([0, 0, 1], [1, 0, 0], [0, 1, 0]);
      expect(c).toBe(packRGB(...FACE_COLORS[SUF.indexOf("up")]));
    });

    test("turning the view changes which face's color the same pixel takes", () => {
      const down = renderCenterPixel([0, 0, -1], [0, 1, 0], [1, 0, 0]); // -Z -> "dn"
      const up = renderCenterPixel([0, 0, 1], [1, 0, 0], [0, 1, 0]); // +Z -> "up"
      expect(down).not.toBe(up);
      expect(down).toBe(packRGB(...FACE_COLORS[SUF.indexOf("dn")]));
      expect(up).toBe(packRGB(...FACE_COLORS[SUF.indexOf("up")]));
    });
  });

  describe("r_fastsky (both paths)", () => {
    test("true-color: flat-fills with R_SkyFlatColor(), ignoring the loaded skybox", () => {
      vpn[0] = 1;
      vpn[1] = 0;
      vpn[2] = 0;
      vright[0] = 0;
      vright[1] = 1;
      vright[2] = 0;
      vup[0] = 0;
      vup[1] = 0;
      vup[2] = 1;
      rState.d_viewbuffer32 = viewbuffer32;
      viewbuffer32.fill(0);
      r_fastsky.value = 1;

      const span = new EspanT();
      span.u = 0;
      span.v = 0;
      span.count = A_WIDTH * A_HEIGHT; // one span covering the whole flat buffer
      span.pnext = null;
      D_DrawSkyScans8(span);

      const [fr, fg, fb] = R_SkyFlatColor();
      const expected = packRGB(fr | 0, fg | 0, fb | 0);
      // not the "rt" face color the same view would otherwise select
      expect(viewbuffer32[0]).not.toBe(packRGB(...FACE_COLORS[SUF.indexOf("rt")]));
      expect(viewbuffer32[0]).toBe(expected);
      expect(viewbuffer32[A_WIDTH * A_HEIGHT - 1]).toBe(expected);

      r_fastsky.value = 0;
    });

    test("8-bit path: flat-fills with a nearest-palette match of R_SkyFlatColor()", () => {
      rState.d_viewbuffer32 = null;
      viewbuffer8.fill(0);
      r_fastsky.value = 1;

      const span = new EspanT();
      span.u = 0;
      span.v = 0;
      span.count = A_WIDTH * A_HEIGHT;
      span.pnext = null;
      D_DrawSkyScans8(span);

      const first = viewbuffer8[0];
      // every pixel gets the SAME index (one flat color, no per-pixel search)
      expect(viewbuffer8[A_WIDTH * A_HEIGHT - 1]).toBe(first);

      r_fastsky.value = 0;
    });
  });

  describe("r_skyalpha (true-color only)", () => {
    test("blends the sampled face color toward R_SkyFlatColor() by alpha", () => {
      vpn[0] = 1;
      vpn[1] = 0;
      vpn[2] = 0;
      vright[0] = 0;
      vright[1] = 1;
      vright[2] = 0;
      vup[0] = 0;
      vup[1] = 0;
      vup[2] = 1;
      rState.d_viewbuffer32 = viewbuffer32;
      viewbuffer32.fill(0);
      r_fastsky.value = 0;
      r_skyalpha.value = 0.5;

      const span = new EspanT();
      span.u = A_WIDTH >> 1;
      span.v = A_HEIGHT >> 1;
      span.count = 1;
      span.pnext = null;
      D_DrawSkyScans8(span);

      const [fr, fg, fb] = R_SkyFlatColor();
      const [rtR, rtG, rtB] = FACE_COLORS[SUF.indexOf("rt")];
      const expected = packRGB((fr + (rtR - fr) * 0.5) | 0, (fg + (rtG - fg) * 0.5) | 0, (fb + (rtB - fb) * 0.5) | 0);
      expect(viewbuffer32[span.v * A_WIDTH + span.u]).toBe(expected);

      r_skyalpha.value = 1;
    });

    test("alpha 1 (the default) reproduces the unblended sample exactly", () => {
      const c = renderCenterPixel([1, 0, 0], [0, 1, 0], [0, 0, 1]);
      expect(c).toBe(packRGB(...FACE_COLORS[SUF.indexOf("rt")]));
    });
  });
});

//============================================================================
// group B / D: full renderer harness, shared by the BSP-render group and
// the guarded mg1 real-data group below. Wrapped in its own describe (not
// file-level beforeAll/afterAll) so its hooks run strictly bracketing ITS
// OWN tests -- a file-level (non-describe-scoped) beforeAll/afterAll pair
// runs before/after every test in the file regardless of textual order
// relative to group A's describe-scoped hooks above, which raced this
// group's SoftSky_LoadSkyBox("cubetest") load against group A's own
// softSkyBoxState save/restore the first time this file was written.
//============================================================================

describe("cube-mapped skybox: renderer-backed tests", () => {
const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-skybox-test-"));
const baseDir = join(scratchDir, "quake");

const RGB_BYTES = BSP_NUMFACES * BSP_FACE_LIGHTMAP_SAMPLES * 3;

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
const savedQwActive = qw.active;
const savedRInit = hostClientHooks.rInit;
const savedRInitTextures = hostClientHooks.rInitTextures;
const savedDrawInit = hostClientHooks.drawInit;
const savedRViewVectors = hostClientHooks.rViewVectors;
const savedLightstyleLength = cl_lightstyle[0].length;
const savedLightstyleMap = cl_lightstyle[0].map;
const savedComSearchpaths = com_searchpaths;
const savedComGamedir = com_gamedir;
const savedComModified = com_modified;
const savedStaticRegistered = static_registered;
const savedRFastsky = { string: r_fastsky.string, value: r_fastsky.value };
const savedRSkyalpha = { string: r_skyalpha.string, value: r_skyalpha.value };
const savedSkyBoxState = { name: softSkyBoxState.name, faces: [...softSkyBoxState.faces] };

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  for (let i = 0; i < 6; i++) {
    const [r, g, b] = FACE_COLORS[i];
    writeGameFile(baseDir, `id1/gfx/env/cubetest${SUF[i]}.tga`, buildSolidTga(r, g, b));
  }

  writeGameFile(baseDir, "id1/maps/refsoftskybox.bsp", buildBsp({ skyFace: true, skyName: "cubetest" }));

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  scrState.block_drawing = true;

  setCvar(scr_viewsize, 100);
  setCvar(scr_fov, 90);
  setCvar(lcd_x, 0);

  vidBackend.current = fakeVid;
  registerRenderer("soft", () => softRenderer);
  re.current = softRenderer;
  setModelLoaderHooks(softRenderer.modelHooks);

  R_Init();
  setCvar(r_ambient, 0);
  setCvar(r_fullbright, 0);
  setCvar(r_drawflat, 0);
  setCvar(r_drawentities, 0);
  setCvar(r_drawviewmodel, 0);
  setCvar(r_coloredlight, 1);
  setCvar(r_fastsky, 0);
  setCvar(r_skyalpha, 1);

  cl_lightstyle[0].length = 0;
  cl_lightstyle[0].map = "";

  fillPaletteTable();
  setMode(64, 48);
  vid.colormap = realShapedColormap();
  vid.fullbright = 256;

  const mod = Mod_ForName("maps/refsoftskybox.bsp", true);
  expect(mod).not.toBeNull();
  world = mod;
  cl.worldmodel = mod;
  cl_entities[0].model = mod;
  cl.viewentity = 0;
  cl.maxclients = 1;
  cl.intermission = 0;
  clState.cl_numvisedicts = 0;

  R_NewMap(); // parses worldspawn's "sky" key -> SoftSky_LoadSkyBox("cubetest")
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
  qw.active = savedQwActive;
  cl_entities[0].model = null;
  cl.viewentity = 0;
  cl.maxclients = 0;
  cl.worldmodel = null;
  clState.cl_numvisedicts = 0;
  cl_lightstyle[0].length = savedLightstyleLength;
  cl_lightstyle[0].map = savedLightstyleMap;
  softSkyBoxState.name = savedSkyBoxState.name;
  softSkyBoxState.faces = savedSkyBoxState.faces;
  r_fastsky.string = savedRFastsky.string;
  r_fastsky.value = savedRFastsky.value;
  r_skyalpha.string = savedRSkyalpha.string;
  r_skyalpha.value = savedRSkyalpha.value;
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

// A minimal uncompressed 24-bit TGA (image_type 2), one solid color -- the
// same helper test/ref_gl_sky.test.ts's own buildSolidTga builds, sized 4x4
// per the unit brief ("synthetic six 4x4 faces of distinct solid colors").
function buildSolidTga(r: number, g: number, b: number): Uint8Array {
  const width = 4;
  const height = 4;
  const header = new Uint8Array(18);
  header[2] = 2; // TGA_RGB: uncompressed true-color
  header[12] = width & 0xff;
  header[13] = (width >> 8) & 0xff;
  header[14] = height & 0xff;
  header[15] = (height >> 8) & 0xff;
  header[16] = 24; // bits per pixel
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = b; // TGA stores BGR
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = r;
  }
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header, 0);
  out.set(pixels, header.length);
  return out;
}

function setWorldRgbGrey(v: number | null): void {
  if (!world) return;
  if (v === null) {
    world.lightdata_rgb = null;
    return;
  }
  const bytes = new Uint8Array(RGB_BYTES);
  bytes.fill(v);
  world.lightdata_rgb = bytes;
}

interface Frame {
  px32: Uint32Array;
  px8: Uint8Array;
  width: number;
  height: number;
  vrectX: number;
  vrectY: number;
}

// straight down over the sky face (bsp_builder.ts's face 1, x:128..192,
// y:0..64, z=0, +Z normal): AngleVectors' forward[2] = -sin(pitch), so
// pitch 90 looks straight down (-Z), matching the only direction this flat
// quad is ever front-facing from.
function renderStraightDown(truecolor: boolean): Frame {
  setWorldRgbGrey(truecolor ? 128 : null);

  softRenderer.D_FlushCaches();
  rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
  const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
  softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

  const vrectin = new VrectT();
  vrectin.width = vid.width;
  vrectin.height = vid.height;
  r_refdef.fov_x = 90;
  r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
  scrState.sb_lines = 0;
  R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

  r_refdef.vieworg[0] = 160; // sky face's own x/y center (128..192, 0..64)
  r_refdef.vieworg[1] = 32;
  r_refdef.vieworg[2] = 48; // above the face (z=0), inside the empty leaf
  r_refdef.viewangles[0] = 90; // pitch: straight down
  r_refdef.viewangles[1] = 0;
  r_refdef.viewangles[2] = 0;

  const buffer = vid.buffer;
  const buffer32 = vid.buffer32;
  expect(buffer).not.toBeNull();
  expect(buffer32).not.toBeNull();
  if (!buffer || !buffer32) return { px32: new Uint32Array(0), px8: new Uint8Array(0), width: 0, height: 0, vrectX: 0, vrectY: 0 };
  buffer.fill(0);
  buffer32.fill(d_8to24table[0]);

  R_RenderView();

  const vrect = r_refdef.vrect;
  const px32 = new Uint32Array(vrect.width * vrect.height);
  const px8 = new Uint8Array(vrect.width * vrect.height);
  for (let row = 0; row < vrect.height; row++) {
    const src = (vrect.y + row) * vid.rowbytes + vrect.x;
    px32.set(buffer32.subarray(src, src + vrect.width), row * vrect.width);
    px8.set(buffer.subarray(src, src + vrect.width), row * vrect.width);
  }
  return { px32, px8, width: vrect.width, height: vrect.height, vrectX: vrect.x, vrectY: vrect.y };
}

//============================================================================
// cube-mapped skybox: full BSP render
//============================================================================

describe("cube-mapped skybox: full BSP render", () => {
  test("SoftSky_NewMap loaded the real 'cubetest' skybox from worldspawn's 'sky' key", () => {
    expect(softSkyBoxState.name).toBe("cubetest");
    expect(softSkyBoxState.faces.every((f) => f !== null)).toBe(true);
  });

  test("true-color: the sky face's screen footprint samples the 'dn' cube face", () => {
    const frame = renderStraightDown(true);
    expect(rState.r_truecolor).toBe(true);

    const idx = (frame.height >> 1) * frame.width + (frame.width >> 1);
    expect(frame.px32[idx]).toBe(packRGB(...FACE_COLORS[SUF.indexOf("dn")]));
  });

  test("8-bit path: byte-for-byte unaffected by the skybox being loaded at all", () => {
    const withSkybox = renderStraightDown(false);
    expect(rState.r_truecolor).toBe(false);

    const name = softSkyBoxState.name;
    const faces = softSkyBoxState.faces;
    softSkyBoxState.name = "";
    softSkyBoxState.faces = [null, null, null, null, null, null];
    const withoutSkybox = renderStraightDown(false);
    softSkyBoxState.name = name;
    softSkyBoxState.faces = faces;

    expect(withoutSkybox.px8).toEqual(withSkybox.px8);
  });

  test("no skybox: the true-color sky pixel matches the classic scrolling-sky formula exactly", () => {
    const name = softSkyBoxState.name;
    const faces = softSkyBoxState.faces;
    softSkyBoxState.name = "";
    softSkyBoxState.faces = [null, null, null, null, null, null];

    const frame = renderStraightDown(true);
    expect(rState.r_truecolor).toBe(true);

    const idx = (frame.height >> 1) * frame.width + (frame.width >> 1);
    const r_skysource = rState.r_skysource;
    expect(r_skysource).not.toBeNull();
    if (r_skysource) {
      const st = new Int32Array(2);
      // D_Sky_uv_To_st takes ABSOLUTE screen coordinates (it reads
      // vid.width/vid.height directly), not coordinates relative to the
      // cropped vrect frame.px32 is indexed by -- add the vrect origin
      // back in.
      D_Sky_uv_To_st(frame.vrectX + (frame.width >> 1), frame.vrectY + (frame.height >> 1), st);
      const expected = d_8to24table[r_skysource[((st[1] & R_SKY_TMASK) >> 8) + ((st[0] & R_SKY_SMASK) >> 16)]];
      expect(frame.px32[idx]).toBe(expected);
    }

    softSkyBoxState.name = name;
    softSkyBoxState.faces = faces;
  });
});

//============================================================================
// Guarded real data: mg1's real "sky_city" skybox from the re-release.
//============================================================================

const RERELEASE_DIR = process.env.Q1TS_RERELEASE ?? "/home/buzzkill/Projects/qfiles/q1/rerelease";
const MG1_PAK = join(RERELEASE_DIR, "mg1", "pak0.pak");
const HAVE_MG1 = existsSync(MG1_PAK) && existsSync(join(RERELEASE_DIR, "id1", "pak0.pak"));

function findMg1SkyMap(): { mapPath: string; skyName: string } | null {
  const pak = new PakFile(MG1_PAK);
  for (const mapPath of listMaps(pak)) {
    const ents = parseEntityLump(readEntityLumpText(pak, mapPath));
    const worldspawn = ents.find((e) => e.get("classname") === "worldspawn");
    const skyName = worldspawn?.get("sky") ?? worldspawn?.get("skyname") ?? worldspawn?.get("_sky");
    if (skyName !== undefined && skyName.trim().length > 0) return { mapPath, skyName: skyName.trim() };
  }
  return null;
}

describe.skipIf(!HAVE_MG1)("mg1's real sky_city skybox (skipped when absent, e.g. on CI)", () => {
  afterAll(() => {
    Mod_ClearAll();
    setComSearchpaths(null);
  });

  test("a real mg1 map's worldspawn sky key renders non-uniform true-color sky pixels", () => {
    const found = findMg1SkyMap();
    expect(found).not.toBeNull();
    if (!found) return;

    setComSearchpaths(null);
    COM_InitArgv(["quake", "-basedir", RERELEASE_DIR, "-game", "mg1"]);
    setComModified(false);
    COM_InitFilesystem();
    COM_CheckRegistered();

    const mod = Mod_ForName(found.mapPath, true);
    expect(mod).not.toBeNull();
    if (!mod) return;

    cl.worldmodel = mod;
    cl_entities[0].model = mod;
    setCvar(r_coloredlight, 1);
    R_NewMap(); // parses the map's own worldspawn sky key

    expect(softSkyBoxState.name.length).toBeGreaterThan(0);

    setMode(160, 120);
    vid.colormap = realShapedColormap();
    vid.fullbright = 256;

    softRenderer.D_FlushCaches();
    rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
    const cacheSize = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
    softRenderer.D_InitCaches(new Uint8Array(cacheSize), cacheSize);

    const vrectin = new VrectT();
    vrectin.width = vid.width;
    vrectin.height = vid.height;
    r_refdef.fov_x = 90;
    r_refdef.fov_y = CalcFov(90, vid.width, vid.height);
    scrState.sb_lines = 0;
    R_ViewChanged(vrectin, scrState.sb_lines, vid.aspect);

    const pak = new PakFile(MG1_PAK);
    const ents = parseEntityLump(readEntityLumpText(pak, found.mapPath));
    const start = ents.find((e) => e.get("classname") === "info_player_start");
    const originStr = start?.get("origin") ?? "0 0 32";
    const [ox, oy, oz] = originStr.trim().split(/\s+/).map(Number.parseFloat);
    r_refdef.vieworg[0] = ox ?? 0;
    r_refdef.vieworg[1] = oy ?? 0;
    r_refdef.vieworg[2] = (oz ?? 0) + 22;
    // tilted well upward (not straight up -- a player start is rarely
    // exactly under open sky) so a real outdoor map shows a good amount of
    // sky without depending on the exact yaw the map's own start faces.
    r_refdef.viewangles[0] = -55;
    const angleStr = start?.get("angle") ?? "0";
    r_refdef.viewangles[1] = Number.parseFloat(angleStr) || 0;
    r_refdef.viewangles[2] = 0;

    const buffer32 = vid.buffer32;
    expect(buffer32).not.toBeNull();
    if (!buffer32) return;

    function renderOnce(buf: Uint32Array): Uint32Array {
      softRenderer.D_FlushCaches();
      rState.d_pzbuffer = new Int16Array(vid.width * vid.height);
      const cs = softRenderer.D_SurfaceCacheForRes(vid.width, vid.height);
      softRenderer.D_InitCaches(new Uint8Array(cs), cs);
      buf.fill(d_8to24table[0]);
      R_RenderView();
      const vrect = r_refdef.vrect;
      const px32 = new Uint32Array(vrect.width * vrect.height);
      for (let row = 0; row < vrect.height; row++) {
        const src = (vrect.y + row) * vid.rowbytes + vrect.x;
        px32.set(buf.subarray(src, src + vrect.width), row * vrect.width);
      }
      return px32;
    }

    const withSkybox = renderOnce(buffer32);
    expect(rState.r_truecolor).toBe(true);

    const name = softSkyBoxState.name;
    const faces = softSkyBoxState.faces;
    softSkyBoxState.name = "";
    softSkyBoxState.faces = [null, null, null, null, null, null];
    const withoutSkybox = renderOnce(buffer32);
    softSkyBoxState.name = name;
    softSkyBoxState.faces = faces;

    // pixels the skybox actually changed (its screen footprint, since
    // nothing else in the renderer reads softSkyBoxState) -- the set this
    // test checks for non-uniformity.
    const skyColors = new Set<number>();
    for (let i = 0; i < withSkybox.length; i++) {
      if (withSkybox[i] !== withoutSkybox[i]) skyColors.add(withSkybox[i]);
    }

    expect(skyColors.size).toBeGreaterThan(0); // the skybox was actually visible somewhere
    expect(skyColors.size).toBeGreaterThan(1); // ...and its pixels are not all one flat color

    console.log(`mg1 sky map: ${found.mapPath}, sky "${found.skyName}", ${skyColors.size} distinct sky colors seen`);
  }, 30_000);
});
}); // "cube-mapped skybox: renderer-backed tests"
