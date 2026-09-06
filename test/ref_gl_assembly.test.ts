// Force headless SDL before ANY import can reach the FFI layer -- sdl.ts
// dlopen()s lazily, so as long as no SDL entry point is called above this
// assignment, SDL reads these on its first SDL_Init.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U075: src/ref_gl/ref_gl.ts (the GL `Renderer` assembly and the
gl_screen.c / view.c seam bodies) and src/ref_gl/gl_vid.ts (gl_vidlinuxglx.c's
GL half -- GL_Init, CheckMultiTextureExtensions, GL_BeginRendering,
GL_EndRendering, VID_Init8bitPalette, VID_SetPalette's d_15to8table build).

Every GL call goes through a QGLRecording installed as `qglHolder.current`, so
"GL correctness" here is "the recorded qgl* call sequence matches
gl_vidlinuxglx.c's". `TestQGL` extends it with the two entry points that must
return data rather than record: qglGetString (a real C string pointer, so
GL_Init has something to store in glState.gl_vendor and friends) and
qglReadPixels (fills the caller's buffer, so SCR_ScreenShot_f has pixels to
BGR-swap).

Self-sufficient per standing order 13: qglHolder.current, glimpHolder.current,
re.current, vidBackend.current, every `vid` and `glState` field, `scr_vrect`,
`scrState`, `r_refdef`, the cvars each case sets, cl's cshifts/items/
intermission, host.frametime and d_8to24table are all captured before and
restored in afterAll. Per standing order 15 the two gl_draw spies are
`mockImplementation` overrides installed in beforeAll and restored in afterAll.

One gap, stated plainly: V_UpdatePalette's final `VID_ShiftPalette (pal)` is
NOT exercised, because `host_basepal` is host.c's own `byte *host_basepal`
and src/common/host.ts assigns it only inside a non-dedicated Host_Init
(COM_LoadHunkFile("gfx/palette.lmp")); there is no exported seam that sets it,
and booting a client host from this suite would register every client cvar and
command process-wide. The cases below pin everything up to that line -- the
cshift new-detection, the two decays, the V_CheckGamma gate and the
V_CalcBlend call whose `v_blend` output feeds the `ramps` build -- and the
early return at the null basepal. Reported as a follow-up.
*/

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ptr, type Pointer } from "bun:ffi";

import { COM_InitArgv, COM_InitFilesystem } from "../src/common/common";
import * as common from "../src/common/common";
import { host } from "../src/common/host";
import { CvarT } from "../src/common/cvar";
import { cl, CSHIFT_BONUS, CSHIFT_CONTENTS, CSHIFT_DAMAGE, CSHIFT_POWERUP, NUM_CSHIFTS } from "../src/client/client";
import { IT_INVISIBILITY } from "../src/common/quakedef";
import { getRenderer, r_refdef, re, type Renderer } from "../src/client/render";
import { d_8to24table, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scr_vrect, scrState } from "../src/client/screen_types";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { crosshair, gl_cshiftpercent, V_CheckGamma, v_gamma } from "../src/client/view";
import { glimpHolder, type GLimp } from "../src/platform/glimp";
import { vid_ref, VID_CheckChanges } from "../src/platform/vid";
import { glState } from "../src/ref_gl/glquake";
import {
  GL_ALPHA_TEST,
  GL_EXTENSIONS,
  GL_FILL,
  GL_FLAT,
  GL_FRONT,
  GL_FRONT_AND_BACK,
  GL_GREATER,
  GL_NEAREST,
  GL_ONE_MINUS_SRC_ALPHA,
  GL_RENDERER,
  GL_REPEAT,
  GL_REPLACE,
  GL_RGB,
  GL_SHARED_TEXTURE_PALETTE_EXT,
  GL_SRC_ALPHA,
  GL_TEXTURE_2D,
  GL_TEXTURE_ENV,
  GL_TEXTURE_ENV_MODE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_WRAP_S,
  GL_TEXTURE_WRAP_T,
  GL_UNSIGNED_BYTE,
  GL_VENDOR,
  GL_VERSION,
  QGLRecording,
  qglHolder,
  type GLPointer,
  type QGL,
} from "../src/ref_gl/qgl";
import {
  CheckMultiTextureExtensions,
  d_15to8table,
  GL_BeginRendering,
  GL_EndRendering,
  GL_Init,
  isPermedia,
  VID_Init8bitPalette,
  VID_Is8bit,
  VID_Reset8bitForTests,
  VID_SetPalette,
} from "../src/ref_gl/gl_vid";
import { v_blend } from "../src/ref_gl/gl_rmain";
import * as gl_draw from "../src/ref_gl/gl_draw";
import { glRenderer, gl_triplebuffer } from "../src/ref_gl/ref_gl";

//============================================================================
// the fake GL table

function cstring(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

// held at module scope so the pointers handed to qglGetString stay valid
const glStringBuffers = new Map<number, Uint8Array>();

class TestQGL extends QGLRecording {
  // set by the SCR_ScreenShot_f case; every other case leaves the buffer
  // untouched, which is what a glReadPixels with no context would do
  readPixelsFill: ((pixels: GLPointer) => void) | null = null;

  override qglGetString(name: number): Pointer | null {
    super.qglGetString(name);
    const buf = glStringBuffers.get(name);
    return buf ? ptr(buf) : null;
  }

  override qglReadPixels(x: number, y: number, width: number, height: number, format: number, type: number, pixels: GLPointer): void {
    super.qglReadPixels(x, y, width, height, format, type, pixels);
    this.readPixelsFill?.(pixels);
  }
}

const qglRec = new TestQGL();

// The three vendor-extension members are `| null` on the QGL interface but
// non-null class fields on QGLRecording; a QGL-typed reference is how a case
// nulls one out without an `as` cast.
const qglTable: QGL = qglRec;

function names(): string[] {
  return qglRec.calls.map((c) => c.name);
}

//============================================================================
// the fake GLimp (glimp.ts's SDL_GL_SwapWindow half) and video backend

let swapCount = 0;

const fakeGlimp: GLimp = {
  Init: () => true,
  SetMode: () => true,
  Shutdown: () => {},
  BeginFrame: () => {},
  EndFrame: () => {
    swapCount++;
  },
  AppActivate: () => {},
  EnableLogging: () => {},
  LogNewFrame: () => {},
  GetProcAddress: () => null,
};

const shiftedPalettes: Uint8Array[] = [];

const fakeVid: VidBackend = {
  VID_SetPalette(): void {},
  VID_ShiftPalette(palette: Uint8Array): void {
    shiftedPalettes.push(palette.slice());
  },
  VID_Init(): void {},
  VID_Shutdown(): void {},
  VID_Update(): void {},
  VID_SetMode(): number {
    return 1;
  },
  VID_HandlePause(): void {},
  VID_LockBuffer(): void {},
  VID_UnlockBuffer(): void {},
  D_BeginDirectRect(): void {},
  D_EndDirectRect(): void {},
};

//============================================================================
// gl_draw.c's two entry points the seam bodies call directly

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Char {
  x: number;
  y: number;
  num: number;
}

const tileClears: Rect[] = [];
const drawnChars: Char[] = [];

const tileClearSpy = spyOn(gl_draw, "Draw_TileClear");
const drawCharacterSpy = spyOn(gl_draw, "Draw_Character");

//============================================================================

function setCvar(cvar: CvarT, value: number): void {
  cvar.value = value;
  cvar.string = String(value);
}

// A `{string, value}` pair, not just `.value`: this suite's own module-load
// snapshot below runs before test/screen.test.ts's own SCR_Init() (or any
// other suite's) call ever registers scr_viewsize/scr_fov for real, so
// `.value` reads 0 (CvarT's own "a cvar is 0 until registered, same as the
// C" default) while `.string` already carries the real default ("100"/"90")
// from the CvarT constructor. Restoring through `setCvar(cvar, n)` (which
// re-derives `.string` from the number `n`) would overwrite that correct
// "100"/"90" string with "0", and once some suite finally does call the
// real SCR_Init(), Cvar_RegisterVariable parses that clobbered "0" as if it
// were the shipped default, permanently, since it only ever registers a
// name once (rule 15).
function savedCvar(cvar: CvarT): { string: string; value: number } {
  return { string: cvar.string, value: cvar.value };
}
function restoreCvar(cvar: CvarT, saved: { string: string; value: number }): void {
  cvar.string = saved.string;
  cvar.value = saved.value;
}

const scratchDir = join(import.meta.dir, ".scratch-ref-gl-assembly");
const baseDir = join(scratchDir, "quake");

// saved process-wide state
const savedQgl = qglHolder.current;
const savedGlimp = glimpHolder.current;
const savedRenderer = re.current;
const savedVidBackend = vidBackend.current;
const savedPalette = new Uint32Array(d_8to24table);
const savedGlState = {
  gl_vendor: glState.gl_vendor,
  gl_renderer: glState.gl_renderer,
  gl_version: glState.gl_version,
  gl_extensions: glState.gl_extensions,
  gl_mtexable: glState.gl_mtexable,
  glx: glState.glx,
  gly: glState.gly,
  glwidth: glState.glwidth,
  glheight: glState.glheight,
};
const savedVid = {
  width: vid.width,
  height: vid.height,
  rowbytes: vid.rowbytes,
  buffer: vid.buffer,
  conwidth: vid.conwidth,
  conheight: vid.conheight,
  numpages: vid.numpages,
  aspect: vid.aspect,
  recalc_refdef: vid.recalc_refdef,
};
const savedScr = {
  sb_lines: scrState.sb_lines,
  scr_fullupdate: scrState.scr_fullupdate,
  block_drawing: scrState.block_drawing,
};
const savedCvars = {
  viewsize: savedCvar(scr_viewsize),
  fov: savedCvar(scr_fov),
  crosshair: savedCvar(crosshair),
  triplebuffer: savedCvar(gl_triplebuffer),
  cshiftpercent: savedCvar(gl_cshiftpercent),
  gamma: savedCvar(v_gamma),
  vid_ref: vid_ref.string,
};
const savedCl = {
  intermission: cl.intermission,
  items: cl.items,
  frametime: host.frametime,
};

beforeAll(() => {
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();

  /*
  GL_Init's four Con_Printf calls re-enter SCR_UpdateScreen whenever
  console.c's Con_Printf sees `cls.signon != SIGNONS &&
  !scr_disabled_for_loading` -- and with `re.current` set to glRenderer below,
  that would run a whole GL frame through the recording table in the middle of
  the call-sequence assertions. `block_drawing` is screen.c's own first-line
  guard against exactly that; ref_soft_main.test.ts sets it for the same
  reason, rather than depending on some other suite having left
  scr_initialized false.
  */
  scrState.block_drawing = true;

  qglHolder.current = qglRec;
  glimpHolder.current = fakeGlimp;
  vidBackend.current = fakeVid;
  re.current = glRenderer;

  vid.width = 640;
  vid.height = 480;
  vid.rowbytes = 640;
  vid.conwidth = 640;
  vid.conheight = 480;

  tileClearSpy.mockImplementation((x: number, y: number, w: number, h: number): void => {
    tileClears.push({ x, y, w, h });
  });
  drawCharacterSpy.mockImplementation((x: number, y: number, num: number): void => {
    drawnChars.push({ x, y, num });
  });
});

afterAll(() => {
  tileClearSpy.mockRestore();
  drawCharacterSpy.mockRestore();

  qglHolder.current = savedQgl;
  glimpHolder.current = savedGlimp;
  re.current = savedRenderer;
  vidBackend.current = savedVidBackend;
  d_8to24table.set(savedPalette);
  d_15to8table.fill(0);
  VID_Reset8bitForTests();

  glState.gl_vendor = savedGlState.gl_vendor;
  glState.gl_renderer = savedGlState.gl_renderer;
  glState.gl_version = savedGlState.gl_version;
  glState.gl_extensions = savedGlState.gl_extensions;
  glState.gl_mtexable = savedGlState.gl_mtexable;
  glState.glx = savedGlState.glx;
  glState.gly = savedGlState.gly;
  glState.glwidth = savedGlState.glwidth;
  glState.glheight = savedGlState.glheight;

  vid.width = savedVid.width;
  vid.height = savedVid.height;
  vid.rowbytes = savedVid.rowbytes;
  vid.buffer = savedVid.buffer;
  vid.conwidth = savedVid.conwidth;
  vid.conheight = savedVid.conheight;
  vid.numpages = savedVid.numpages;
  vid.aspect = savedVid.aspect;
  vid.recalc_refdef = savedVid.recalc_refdef;

  scrState.sb_lines = savedScr.sb_lines;
  scrState.scr_fullupdate = savedScr.scr_fullupdate;
  scrState.block_drawing = savedScr.block_drawing;
  scr_vrect.x = scr_vrect.y = scr_vrect.width = scr_vrect.height = 0;
  r_refdef.vrect.x = r_refdef.vrect.y = r_refdef.vrect.width = r_refdef.vrect.height = 0;
  r_refdef.fov_x = 0;
  r_refdef.fov_y = 0;

  restoreCvar(scr_viewsize, savedCvars.viewsize);
  restoreCvar(scr_fov, savedCvars.fov);
  restoreCvar(crosshair, savedCvars.crosshair);
  restoreCvar(gl_triplebuffer, savedCvars.triplebuffer);
  restoreCvar(gl_cshiftpercent, savedCvars.cshiftpercent);
  restoreCvar(v_gamma, savedCvars.gamma);
  vid_ref.string = savedCvars.vid_ref;

  cl.intermission = savedCl.intermission;
  cl.items = savedCl.items;
  host.frametime = savedCl.frametime;
  for (let i = 0; i < NUM_CSHIFTS; i++) {
    cl.cshifts[i].percent = 0;
    cl.prev_cshifts[i].percent = 0;
    for (let j = 0; j < 3; j++) {
      cl.cshifts[i].destcolor[j] = 0;
      cl.prev_cshifts[i].destcolor[j] = 0;
    }
  }
  v_blend[0] = v_blend[1] = v_blend[2] = v_blend[3] = 0;

  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================

describe("glRenderer -- the Renderer assembly", () => {
  test("is a complete Renderer and reachable through re.current", () => {
    const asRenderer: Renderer = glRenderer;
    expect(asRenderer).toBe(glRenderer);

    re.current = glRenderer;
    expect(getRenderer()).toBe(glRenderer);
  });

  test("the members no gl_*.c file defines are present and empty", () => {
    // render.h prototypes with no GLQUAKE body: a GL build has no software
    // surface cache and no R_SetVrect/R_ViewChanged
    expect(glRenderer.R_InitEfrags()).toBeUndefined();
    expect(glRenderer.R_ViewChanged(new VrectT(), 0, 0)).toBeUndefined();
    expect(glRenderer.R_SetVrect(new VrectT(), new VrectT(), 0)).toBeUndefined();
    expect(glRenderer.D_SurfaceCacheForRes(640, 480)).toBe(0);
    expect(glRenderer.D_InitCaches(new Uint8Array(0), 0)).toBeUndefined();
    expect(glRenderer.D_DeleteSurfaceCache()).toBeUndefined();

    // the seam methods whose only body is in screen.c / view.c / a d_*.c
    expect(glRenderer.D_EnableBackBufferAccess()).toBeUndefined();
    expect(glRenderer.D_DisableBackBufferAccess()).toBeUndefined();
    expect(glRenderer.D_UpdateRects(null)).toBeUndefined();
    expect(glRenderer.SCR_SoftwareTileClear(0, 0, 1, 1)).toBeUndefined();
    expect(glRenderer.V_DrawCrosshair()).toBeUndefined();
  });

  test("r_cache_thrash and draw_disc forward to the modules that own them", () => {
    expect(typeof glRenderer.r_cache_thrash).toBe("boolean");
    expect(glRenderer.r_cache_thrash).toBe(glState.r_cache_thrash);

    // gl_draw.c's `qpic_t *draw_disc` -- null until Draw_Init caches it
    expect(glRenderer.draw_disc).toBe(gl_draw.draw_disc);
  });

  test('registerRenderer("gl") ran at module load', () => {
    // src/platform/vid.ts exports no registry accessor; its Sys_Error for an
    // unknown vid_ref lists every registered name, which is the observation.
    // The lookup is VID_CheckChanges's first statement, so nothing is torn
    // down or reallocated on this path.
    const saved = vid_ref.string;
    vid_ref.string = "test_nonesuch";
    try {
      expect(() => {
        VID_CheckChanges(false);
      }).toThrow(/vid_ref test_nonesuch not available \(registered: .*gl.*\)/);
    } finally {
      vid_ref.string = saved;
    }
  });
});

describe("BeginFrame / EndFrame -- gl_screen.c's frame bracketing", () => {
  test("BeginFrame publishes vid.numpages and the glx/gly/glwidth/glheight window", () => {
    setCvar(gl_triplebuffer, 1);
    glState.glx = 99;
    glState.gly = 99;

    glRenderer.BeginFrame();

    expect(vid.numpages).toBe(3); // gl_screen.c:829 `vid.numpages = 2 + gl_triplebuffer.value;`
    expect(glState.glx).toBe(0);
    expect(glState.gly).toBe(0);
    expect(glState.glwidth).toBe(vid.width);
    expect(glState.glheight).toBe(vid.height);

    setCvar(gl_triplebuffer, 0);
    glRenderer.BeginFrame();
    expect(vid.numpages).toBe(2);
  });

  test("EndFrame is glFlush then the buffer swap", () => {
    qglRec.clear();
    const before = swapCount;

    glRenderer.EndFrame();

    expect(names()).toEqual(["qglFlush"]);
    expect(swapCount).toBe(before + 1);
  });

  test("GL_BeginRendering / GL_EndRendering are callable on their own", () => {
    vid.width = 320;
    vid.height = 240;
    GL_BeginRendering();
    expect(glState.glwidth).toBe(320);
    expect(glState.glheight).toBe(240);
    vid.width = 640;
    vid.height = 480;

    qglRec.clear();
    const before = swapCount;
    GL_EndRendering();
    expect(names()).toEqual(["qglFlush"]);
    expect(swapCount).toBe(before + 1);
  });
});

describe("SCR_CalcRefdef -- gl_screen.c:255", () => {
  function calc(viewsize: number, fov: number, intermission: number): void {
    setCvar(scr_viewsize, viewsize);
    setCvar(scr_fov, fov);
    cl.intermission = intermission;
    vid.width = 640;
    vid.height = 480;
    vid.recalc_refdef = 1;
    glRenderer.SCR_CalcRefdef();
  }

  test("viewsize 100 is `full`: the rect spans the width and stops at the status bar", () => {
    calc(100, 90, 0);

    expect(scrState.sb_lines).toBe(24 + 16 + 8); // size 100 is below both 120 and 110
    expect(r_refdef.vrect.width).toBe(640);
    // `full` only pins y to 0; the height still clamps to vid.height - sb_lines
    expect(r_refdef.vrect.height).toBe(480 - 48);
    expect(r_refdef.vrect.x).toBe(0);
    expect(r_refdef.vrect.y).toBe(0);

    expect(r_refdef.fov_x).toBe(90);
    expect(r_refdef.fov_y).toBe(CalcFov(90, 640, 432));

    // `scr_vrect = r_refdef.vrect;`
    expect(scr_vrect.x).toBe(r_refdef.vrect.x);
    expect(scr_vrect.y).toBe(r_refdef.vrect.y);
    expect(scr_vrect.width).toBe(r_refdef.vrect.width);
    expect(scr_vrect.height).toBe(r_refdef.vrect.height);

    expect(vid.recalc_refdef).toBe(0);
    expect(scrState.scr_fullupdate).toBe(0);
  });

  test("viewsize 80 centers a 512x384 rect above the status bar", () => {
    calc(80, 90, 0);

    expect(scrState.sb_lines).toBe(48);
    expect(r_refdef.vrect.width).toBe(512); // 640 * 0.8
    expect(r_refdef.vrect.height).toBe(384); // 480 * 0.8, under the 432 clamp
    expect(r_refdef.vrect.x).toBe(64); // (640 - 512) / 2
    expect(r_refdef.vrect.y).toBe(24); // ((480 - 48) - 384) / 2
  });

  test("viewsize 110 drops the inventory, 120 the whole status bar", () => {
    calc(110, 90, 0);
    expect(scrState.sb_lines).toBe(24);
    expect(r_refdef.vrect.height).toBe(480 - 24);

    calc(120, 90, 0);
    expect(scrState.sb_lines).toBe(0);
    expect(r_refdef.vrect.height).toBe(480);
    expect(r_refdef.vrect.y).toBe(0);
  });

  test("intermission is always full screen with no status bar", () => {
    calc(80, 90, 1);

    expect(scrState.sb_lines).toBe(0);
    expect(r_refdef.vrect.width).toBe(640);
    expect(r_refdef.vrect.height).toBe(480);
    expect(r_refdef.vrect.x).toBe(0);
    expect(r_refdef.vrect.y).toBe(0);

    cl.intermission = 0;
  });

  test("the 96-pixel minimum width kicks in on a narrow mode", () => {
    // gl_screen.c: `if (r_refdef.vrect.width < 96) { size = 96.0 /
    // r_refdef.vrect.width; r_refdef.vrect.width = 96; }` -- the rescale
    // divides by the ALREADY truncated width, which is the shipped behaviour
    setCvar(scr_viewsize, 30);
    setCvar(scr_fov, 90);
    cl.intermission = 0;
    vid.width = 200;
    vid.height = 150;
    vid.recalc_refdef = 1;

    glRenderer.SCR_CalcRefdef();

    expect(r_refdef.vrect.width).toBe(96); // 200 * 0.3 = 60 -> clamped up
    // size becomes 96/60 = 1.6, so the height computes off the RESCALED size
    // and then clamps to vid.height - sb_lines
    expect(r_refdef.vrect.height).toBe(150 - 48);

    vid.width = 640;
    vid.height = 480;
  });
});

describe("SCR_TileClear -- gl_screen.c:786", () => {
  test("clears the four border rects, bugs included", () => {
    r_refdef.vrect.x = 64;
    r_refdef.vrect.y = 24;
    r_refdef.vrect.width = 512;
    r_refdef.vrect.height = 384;
    scrState.sb_lines = 48;
    tileClears.length = 0;

    glRenderer.SCR_TileClear();

    expect(tileClears.length).toBe(4);
    // left
    expect(tileClears[0]).toEqual({ x: 0, y: 0, w: 64, h: 480 - 48 });
    // right -- `vid.width - r_refdef.vrect.x + r_refdef.vrect.width`, the
    // shipped missing-parentheses width
    expect(tileClears[1]).toEqual({ x: 64 + 512, y: 0, w: 640 - 64 + 512, h: 480 - 48 });
    // top -- the shipped `x + width` passed as a WIDTH
    expect(tileClears[2]).toEqual({ x: 64, y: 0, w: 64 + 512, h: 24 });
    // bottom
    expect(tileClears[3]).toEqual({ x: 64, y: 24 + 384, w: 512, h: 480 - 48 - (384 + 24) });
  });

  test("a full-width rect clears nothing", () => {
    r_refdef.vrect.x = 0;
    r_refdef.vrect.y = 0;
    r_refdef.vrect.width = 640;
    r_refdef.vrect.height = 432;
    tileClears.length = 0;

    glRenderer.SCR_TileClear();

    expect(tileClears.length).toBe(0);
  });
});

describe("SCR_DrawCrosshair -- gl_screen.c:906", () => {
  test("draws '+' at the centre of scr_vrect when crosshair is set", () => {
    scr_vrect.x = 64;
    scr_vrect.y = 24;
    scr_vrect.width = 512;
    scr_vrect.height = 384;

    setCvar(crosshair, 0);
    drawnChars.length = 0;
    glRenderer.SCR_DrawCrosshair();
    expect(drawnChars.length).toBe(0);

    setCvar(crosshair, 1);
    glRenderer.SCR_DrawCrosshair();
    expect(drawnChars.length).toBe(1);
    // gl_screen.c has NO cl_crossx/cl_crossy offset here (that is view.c's
    // !GLQUAKE crosshair, i.e. the software V_DrawCrosshair)
    expect(drawnChars[0]).toEqual({ x: 64 + 256, y: 24 + 192, num: "+".charCodeAt(0) });

    setCvar(crosshair, 0);
  });
});

describe("SCR_ScreenShot_f -- gl_screen.c's TGA writer", () => {
  test("writes quake00.tga with an 18-byte header and BGR-swapped pixels", () => {
    glState.glx = 0;
    glState.gly = 0;
    glState.glwidth = 4;
    glState.glheight = 2;

    // a known pattern the BGR swap is visible in
    qglRec.readPixelsFill = (pixels: GLPointer): void => {
      if (!(pixels instanceof Uint8Array)) return;
      for (let i = 0; i < pixels.length; i++) pixels[i] = i & 0xff;
    };
    qglRec.clear();

    glRenderer.SCR_ScreenShot_f();

    qglRec.readPixelsFill = null;

    const readPixels = qglRec.calls.find((c) => c.name === "qglReadPixels");
    expect(readPixels).toBeDefined();
    expect(readPixels?.args.slice(0, 6)).toEqual([0, 0, 4, 2, GL_RGB, GL_UNSIGNED_BYTE]);

    const path = join(common.com_gamedir, "quake00.tga");
    expect(existsSync(path)).toBe(true);
    const file = readFileSync(path);

    expect(file.length).toBe(4 * 2 * 3 + 18);
    expect(file[0]).toBe(0); // id_length
    expect(file[1]).toBe(0); // colormap_type
    expect(file[2]).toBe(2); // uncompressed type
    expect(file[12]).toBe(4); // width & 255
    expect(file[13]).toBe(0); // width >> 8
    expect(file[14]).toBe(2); // height & 255
    expect(file[15]).toBe(0); // height >> 8
    expect(file[16]).toBe(24); // pixel size

    // glReadPixels wrote 0,1,2, 3,4,5, ... and the swap exchanges each
    // triple's first and third byte
    for (let p = 0; p < 4 * 2; p++) {
      expect(file[18 + p * 3 + 0]).toBe(p * 3 + 2);
      expect(file[18 + p * 3 + 1]).toBe(p * 3 + 1);
      expect(file[18 + p * 3 + 2]).toBe(p * 3 + 0);
    }
  });

  test("the free-name scan skips a name that already exists", () => {
    glState.glwidth = 1;
    glState.glheight = 1;
    qglRec.readPixelsFill = null;

    glRenderer.SCR_ScreenShot_f();

    expect(existsSync(join(common.com_gamedir, "quake01.tga"))).toBe(true);
  });
});

describe("V_UpdatePalette -- view.c's GLQUAKE body", () => {
  function zeroCshifts(): void {
    for (let i = 0; i < NUM_CSHIFTS; i++) {
      cl.cshifts[i].percent = 0;
      cl.prev_cshifts[i].percent = 0;
      for (let j = 0; j < 3; j++) {
        cl.cshifts[i].destcolor[j] = 0;
        cl.prev_cshifts[i].destcolor[j] = 0;
      }
    }
  }

  beforeAll(() => {
    // V_CheckGamma latches a module-private `oldgammavalue`; settle it so
    // `force` is deterministic no matter which suite ran first
    setCvar(v_gamma, 1);
    V_CheckGamma();
    setCvar(gl_cshiftpercent, 100);
    host.frametime = 0;
    cl.items = 0;
  });

  test("no cshift change and no gamma change returns before V_CalcBlend", () => {
    zeroCshifts();
    v_blend[0] = v_blend[1] = v_blend[2] = v_blend[3] = -1;
    shiftedPalettes.length = 0;

    glRenderer.V_UpdatePalette(); // syncs prev_cshifts
    v_blend[0] = v_blend[1] = v_blend[2] = v_blend[3] = -1;

    glRenderer.V_UpdatePalette(); // nothing changed since

    expect(v_blend[3]).toBe(-1); // V_CalcBlend never ran
    expect(shiftedPalettes.length).toBe(0);
  });

  test("a new cshift runs V_CalcBlend and the ramps build", () => {
    zeroCshifts();
    glRenderer.V_UpdatePalette(); // sync

    // view.c's cshift_bonus
    cl.cshifts[CSHIFT_BONUS].destcolor[0] = 215;
    cl.cshifts[CSHIFT_BONUS].destcolor[1] = 186;
    cl.cshifts[CSHIFT_BONUS].destcolor[2] = 69;
    cl.cshifts[CSHIFT_BONUS].percent = 50;

    glRenderer.V_UpdatePalette();

    // only CSHIFT_BONUS contributes, so a = (50 * 100/100)/255
    expect(v_blend[3]).toBeCloseTo(50 / 255, 6);
    expect(v_blend[0]).toBeCloseTo(215 / 255, 6);
    expect(v_blend[1]).toBeCloseTo(186 / 255, 6);
    expect(v_blend[2]).toBeCloseTo(69 / 255, 6);

    // the prologue copied the new values into prev_cshifts
    expect(cl.prev_cshifts[CSHIFT_BONUS].destcolor[0]).toBe(215);
    expect(cl.prev_cshifts[CSHIFT_BONUS].percent).toBe(50);

    // host_basepal is null in this suite -- see the file header
    expect(shiftedPalettes.length).toBe(0);
  });

  test("the damage and bonus percentages decay by host.frametime", () => {
    zeroCshifts();
    glRenderer.V_UpdatePalette();

    cl.cshifts[CSHIFT_DAMAGE].percent = 150;
    cl.cshifts[CSHIFT_BONUS].percent = 100;
    host.frametime = 0.5;

    glRenderer.V_UpdatePalette();

    expect(cl.cshifts[CSHIFT_DAMAGE].percent).toBe(150 - 75); // -= frametime*150
    expect(cl.cshifts[CSHIFT_BONUS].percent).toBe(100 - 50); // -= frametime*100

    host.frametime = 4; // drives both past zero
    glRenderer.V_UpdatePalette();
    expect(cl.cshifts[CSHIFT_DAMAGE].percent).toBe(0);
    expect(cl.cshifts[CSHIFT_BONUS].percent).toBe(0);

    host.frametime = 0;
  });

  test("V_CalcPowerupCshift runs first, so a powerup counts as a new cshift", () => {
    zeroCshifts();
    cl.items = 0;
    glRenderer.V_UpdatePalette();

    cl.items = IT_INVISIBILITY;
    v_blend[3] = -1;
    glRenderer.V_UpdatePalette();

    expect(cl.cshifts[CSHIFT_POWERUP].percent).toBe(100);
    expect(v_blend[3]).not.toBe(-1);

    cl.items = 0;
    expect(cl.cshifts[CSHIFT_CONTENTS].percent).toBe(0);
  });
});

describe("GL_Init -- gl_vidlinuxglx.c:572", () => {
  test("stores the four GL strings and issues the state-setup sequence", () => {
    glStringBuffers.set(GL_VENDOR, cstring("TestVendor"));
    glStringBuffers.set(GL_RENDERER, cstring("TestRenderer"));
    glStringBuffers.set(GL_VERSION, cstring("1.1 Test"));
    glStringBuffers.set(GL_EXTENSIONS, cstring("GL_EXT_nothing "));
    glState.gl_mtexable = false;
    qglRec.clear();

    GL_Init();

    expect(glState.gl_vendor).toBe("TestVendor");
    expect(glState.gl_renderer).toBe("TestRenderer");
    expect(glState.gl_version).toBe("1.1 Test");
    expect(glState.gl_extensions).toBe("GL_EXT_nothing ");

    expect(names()).toEqual([
      "qglGetString",
      "qglGetString",
      "qglGetString",
      "qglGetString",
      "qglClearColor",
      "qglCullFace",
      "qglEnable",
      "qglEnable",
      "qglAlphaFunc",
      "qglPolygonMode",
      "qglShadeModel",
      "qglTexParameterf",
      "qglTexParameterf",
      "qglTexParameterf",
      "qglTexParameterf",
      "qglBlendFunc",
      "qglTexEnvf",
    ]);

    const byName = (n: string): ReadonlyArray<readonly unknown[]> => qglRec.calls.filter((c) => c.name === n).map((c) => c.args);

    expect(byName("qglClearColor")[0]).toEqual([1, 0, 0, 0]);
    expect(byName("qglCullFace")[0]).toEqual([GL_FRONT]);
    expect(byName("qglEnable")).toEqual([[GL_TEXTURE_2D], [GL_ALPHA_TEST]]);
    expect(byName("qglAlphaFunc")[0]).toEqual([GL_GREATER, 0.666]);
    expect(byName("qglPolygonMode")[0]).toEqual([GL_FRONT_AND_BACK, GL_FILL]);
    expect(byName("qglShadeModel")[0]).toEqual([GL_FLAT]);
    expect(byName("qglTexParameterf")).toEqual([
      [GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST],
      [GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST],
      [GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT],
      [GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT],
    ]);
    expect(byName("qglBlendFunc")[0]).toEqual([GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA]);
    expect(byName("qglTexEnvf")[0]).toEqual([GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE]);
  });

  test("a NULL glGetString leaves the strings empty rather than crashing", () => {
    glStringBuffers.clear();
    glState.gl_vendor = "stale";
    GL_Init();
    expect(glState.gl_vendor).toBe("");
    expect(glState.gl_extensions).toBe("");
  });
});

describe("CheckMultiTextureExtensions -- gl_vidlinuxglx.c:542", () => {
  function check(extensions: string, haveMTex: boolean, haveSelect: boolean): boolean {
    glState.gl_extensions = extensions;
    glState.gl_mtexable = false;
    const savedMTex = qglTable.qglMTexCoord2fSGIS;
    const savedSelect = qglTable.qglSelectTextureSGIS;
    if (!haveMTex) qglTable.qglMTexCoord2fSGIS = null;
    if (!haveSelect) qglTable.qglSelectTextureSGIS = null;
    try {
      CheckMultiTextureExtensions();
    } finally {
      qglTable.qglMTexCoord2fSGIS = savedMTex;
      qglTable.qglSelectTextureSGIS = savedSelect;
    }
    return glState.gl_mtexable;
  }

  test("both entry points plus the extension string sets gl_mtexable", () => {
    expect(check("GL_ARB_x GL_SGIS_multitexture GL_EXT_y", true, true)).toBe(true);
  });

  test("either entry point missing disables it", () => {
    expect(check("GL_SGIS_multitexture ", false, true)).toBe(false);
    expect(check("GL_SGIS_multitexture ", true, false)).toBe(false);
  });

  test("the C's trailing space in the strstr matters", () => {
    // gl_vidlinuxglx.c greps for "GL_SGIS_multitexture " WITH the space, so a
    // driver whose list ends in the bare name is not matched
    expect(check("GL_EXT_a GL_SGIS_multitexture", true, true)).toBe(false);
  });

  test("no multitexture in the extension list leaves it false", () => {
    expect(check("GL_EXT_nothing ", true, true)).toBe(false);
  });
});

describe("VID_Init8bitPalette -- gl_vidlinuxglx.c:641", () => {
  test("skips when qglColorTableEXT is null", () => {
    VID_Reset8bitForTests();
    glState.gl_extensions = "GL_EXT_shared_texture_palette ";
    const saved = qglTable.qglColorTableEXT;
    qglTable.qglColorTableEXT = null;
    qglRec.clear();
    try {
      VID_Init8bitPalette();
    } finally {
      qglTable.qglColorTableEXT = saved;
    }
    expect(VID_Is8bit()).toBe(false);
    expect(names()).toEqual([]);
  });

  test("skips when the extension is not advertised", () => {
    VID_Reset8bitForTests();
    glState.gl_extensions = "GL_EXT_nothing ";
    qglRec.clear();
    VID_Init8bitPalette();
    expect(VID_Is8bit()).toBe(false);
    expect(names()).toEqual([]);
  });

  test("uploads the 768-byte shared palette off d_8to24table and latches is8bit", () => {
    VID_Reset8bitForTests();
    glState.gl_extensions = "GL_EXT_shared_texture_palette ";
    for (let i = 0; i < 256; i++) d_8to24table[i] = (255 << 24) + (i << 0) + ((255 - i) << 8) + (128 << 16);
    qglRec.clear();

    VID_Init8bitPalette();

    expect(VID_Is8bit()).toBe(true);
    expect(names()).toEqual(["qglEnable", "qglColorTableEXT"]);
    expect(qglRec.calls[0].args).toEqual([GL_SHARED_TEXTURE_PALETTE_EXT]);

    const args = qglRec.calls[1].args;
    expect(args.slice(0, 5)).toEqual([GL_SHARED_TEXTURE_PALETTE_EXT, GL_RGB, 256, GL_RGB, GL_UNSIGNED_BYTE]);
    const table = args[5];
    expect(table instanceof Uint8Array).toBe(true);
    if (!(table instanceof Uint8Array)) return;
    expect(table.length).toBe(768);
    // the C copies three of every four bytes, dropping the alpha
    for (let i = 0; i < 256; i++) {
      expect(table[i * 3 + 0]).toBe(i);
      expect(table[i * 3 + 1]).toBe(255 - i);
      expect(table[i * 3 + 2]).toBe(128);
    }

    VID_Reset8bitForTests();
  });
});

describe("VID_SetPalette -- gl_vidlinuxglx.c:487", () => {
  test("packs d_8to24table, masks index 255's alpha and builds d_15to8table", () => {
    // a two-colour palette: index 0 black, every other index white, so the
    // nearest-colour search resolves to 0 or to 1 (the first white)
    const palette = new Uint8Array(768);
    for (let i = 1; i < 256; i++) {
      palette[i * 3 + 0] = 255;
      palette[i * 3 + 1] = 255;
      palette[i * 3 + 2] = 255;
    }

    VID_SetPalette(palette);

    expect(d_8to24table[0]).toBe((255 << 24) >>> 0); // r=g=b=0, a=255
    expect(d_8to24table[1] >>> 0).toBe(0xffffffff);
    expect(d_8to24table[255] >>> 0).toBe(0x00ffffff); // "255 is transparent"

    // 15-bit 0 is (r,g,b) = (4,4,4) after the C's +4 bias: nearer black
    expect(d_15to8table[0]).toBe(0);
    // 15-bit 0x7fff is (252,252,252): nearer white, and white's first index
    // is 1 because the search keeps the first strictly-closer match
    expect(d_15to8table[0x7fff]).toBe(1);

    // the midpoint: r=g=b=(15<<3)+4 = 124, closer to black than to white
    const mid = 15 | (15 << 5) | (15 << 10);
    expect(d_15to8table[mid]).toBe(0);
    const above = 16 | (16 << 5) | (16 << 10); // 132
    expect(d_15to8table[above]).toBe(1);

    // the C fills only the low 32768 entries of a 65536-byte table
    expect(d_15to8table.length).toBe(65536);
    expect(d_15to8table[0x8000]).toBe(0);
  });
});

describe("gl_vidlinuxglx.c's remaining globals", () => {
  test("isPermedia is false (only gl_vidnt.c ever sets it)", () => {
    expect(isPermedia).toBe(false);
  });
});

describe("glRenderer.Shutdown -- render.ts's Renderer.Shutdown addition", () => {
  // Runs last in this file: it nulls the shared qglHolder.current every
  // other case in this suite depends on, so it restores it itself rather
  // than leaning on the file's own afterAll (which only guarantees the
  // state is clean for suites that run after this file, per standing
  // order 15).
  test("clears qglHolder.current and restores d_8to24table[255]'s pre-mask alpha", () => {
    // VID_SetPalette's mask (`d_8to24table[255] &= 0xffffff`) stashes the
    // pre-mask value in glVidPaletteState; a distinctive RGB for index 255
    // makes the restored value unambiguous.
    const palette = new Uint8Array(768);
    palette[255 * 3 + 0] = 10;
    palette[255 * 3 + 1] = 20;
    palette[255 * 3 + 2] = 30;
    VID_SetPalette(palette);

    const preMaskAlpha255 = ((255 << 24) + 10 + (20 << 8) + (30 << 16)) >>> 0;
    expect(d_8to24table[255] >>> 0).toBe(preMaskAlpha255 & 0xffffff); // masked, no alpha

    expect(qglHolder.current).not.toBeNull();

    try {
      glRenderer.Shutdown?.();

      expect(qglHolder.current).toBeNull();
      expect(d_8to24table[255] >>> 0).toBe(preMaskAlpha255);
    } finally {
      qglHolder.current = qglRec;
    }
  });
});
