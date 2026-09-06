import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop } from "../src/common/common";
import { Cmd_Exists } from "../src/common/cmd";
import { Cvar_FindVar } from "../src/common/cvar";
import { AngleVectors, vec3 } from "../src/common/mathlib";
import { Mod_ForName, Mod_Init, type MleafT, ModelT, setModelLoaderHooks } from "../src/common/model";
import { hostClientHooks, type RViewVectors } from "../src/common/host";
import { cl, cl_entities, clState } from "../src/client/client";
import { getRenderer, r_refdef, re, type Renderer, vpn, vright, vup } from "../src/client/render";
import { VID_GRADES, vid, vidBackend, type VidBackend, VrectT } from "../src/client/vid";
import { scr_vrect, scrState } from "../src/client/screen_types";
import { getRegisteredRenderer, registerRenderer, unregisterRenderer } from "../src/platform/vid";
import { CalcFov, scr_fov, scr_viewsize } from "../src/client/screen";
import { lcd_x } from "../src/client/view";
import { AMP, AMP2, SIN_BUFFER_SIZE, intsintable, modelorg, r_frustum_indexes, rState, screenedge, sintable, view_clipplanes } from "../src/ref_soft/r_local";
import { dState } from "../src/ref_soft/d_local";
import {
  R_Init,
  R_InitTurb,
  R_MarkLeaves,
  R_NewMap,
  R_RenderView,
  R_SetVrect,
  R_ViewChanged,
  r_aliastransadj,
  r_aliastransbase,
  r_ambient,
  r_clearcolor,
  r_draworder,
  r_drawentities,
  r_drawflat,
  r_drawviewmodel,
  r_dspeeds,
  r_fullbright,
  r_graphheight,
  r_maxedges,
  r_maxsurfs,
  r_numedges,
  r_numsurfs,
  r_reportedgeout,
  r_reportsurfout,
  r_speeds,
  r_timegraph,
  r_waterwarp,
  r_aliasstats,
} from "../src/ref_soft/r_main";
import { R_SetUpFrustumIndexes, R_TransformFrustum } from "../src/ref_soft/r_misc";
import { r_worldentity } from "../src/ref_soft/r_main";
import { qw } from "../src/common/quakedef";
import * as winRPart from "../src/client/r_part";
import * as qwRPart from "../src/qw/client/r_part";
import { softRenderer } from "../src/ref_soft/ref_soft";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "ref-soft-main-test-"));
const baseDir = join(scratchDir, "quake");

//============================================================================
// a recording VidBackend: the software renderer only ever reaches the video
// backend through vidBackend.current

const updates: VrectT[] = [];
const shifted: Uint8Array[] = [];
const lockCalls: string[] = [];

const fakeVid: VidBackend = {
  VID_SetPalette(_palette: Uint8Array): void {},
  VID_ShiftPalette(palette: Uint8Array): void {
    shifted.push(palette.slice());
  },
  VID_Init(_palette: Uint8Array): void {},
  VID_Shutdown(): void {},
  VID_Update(rects: VrectT | null): void {
    if (rects) {
      const copy = new VrectT();
      copy.x = rects.x;
      copy.y = rects.y;
      copy.width = rects.width;
      copy.height = rects.height;
      updates.push(copy);
    }
  },
  VID_SetMode(_modenum: number, _palette: Uint8Array): number {
    return 0;
  },
  VID_HandlePause(_pause: boolean): void {},
  VID_LockBuffer(): void {
    lockCalls.push("lock");
  },
  VID_UnlockBuffer(): void {
    lockCalls.push("unlock");
  },
  D_BeginDirectRect(_x: number, _y: number, _pbitmap: Uint8Array, _width: number, _height: number): void {},
  D_EndDirectRect(_x: number, _y: number, _width: number, _height: number): void {},
};

const savedBackend = vidBackend.current;
const savedBlockDrawing = scrState.block_drawing;
const savedColormap = vid.colormap;
const savedFullbright = vid.fullbright;
const savedRenderer = re.current;
// importing src/ref_soft/ref_soft.ts installs these four at module load
const savedRInit = hostClientHooks.rInit;
const savedRInitTextures = hostClientHooks.rInitTextures;
const savedDrawInit = hostClientHooks.drawInit;
const savedRViewVectors = hostClientHooks.rViewVectors;
// The "R_RenderView" describe block below drives a real R_Init/R_ViewChanged/
// R_RenderView frame, which mutates most of r_shared.ts's `rState` (bumps
// r_framecount, sets xcenter/yscale/r_viewleaf/..., allocates d_pzbuffer) and
// d_local.ts's `dState` (D_InitCaches fills in sc_heap/sc_base/sc_rover/
// sc_size) in place -- both are process-wide singletons every other ref_soft
// suite reads (test/ref_soft_types.test.ts's own "every field carries its C
// initial value" check in particular), so restore both fully rather than
// picking individual fields (rule 15).
const savedRState = { ...rState };
const savedDState = { ...dState };
const savedSoftFactory = getRegisteredRenderer("soft");

/*
A cvar's `value` is 0 until Cvar_RegisterVariable or Cvar_Set fills it in, the
same as the C. host.c registers viewsize/fov (SCR_Init) and lcd_x (V_Init)
before it ever calls R_Init, so this suite sets the three R_SetVrect /
R_ViewChanged read to their C defaults itself rather than depending on another
suite having registered them.
*/
function setCvar(cv: { string: string; value: number }, v: number): void {
  cv.string = String(v);
  cv.value = v;
}

// vid_x.c's own numbers for a 320x200 mode
function setMode320x200(): void {
  vid.width = 320;
  vid.height = 200;
  vid.rowbytes = 320;
  vid.buffer = new Uint8Array(320 * 200);
  vid.conwidth = 320;
  vid.conheight = 200;
  vid.maxwarpwidth = 320;
  vid.maxwarpheight = 200;
  vid.aspect = (200 / 320) * (320 / 240);
  vid.numpages = 1;
}

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/refsoft.bsp", buildBsp());

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

  /*
  D_InitCaches and R_NewMap print through Con_Printf, and console.c's
  Con_Printf re-enters SCR_UpdateScreen whenever `cls.signon != SIGNONS &&
  !scr_disabled_for_loading`. In the real engine that reaches a screen with
  gfx/conback.lmp loaded; here it would reach Draw_ConsoleBackground with this
  suite's synthetic gamedir and Sys_Error. `block_drawing` is screen.c's own
  first-line guard against exactly that, so it is set for the whole suite
  rather than depending on some other suite having left scr_initialized false.
  */
  scrState.block_drawing = true;

  setCvar(scr_viewsize, 100); // screen.c: cvar_t scr_viewsize = {"viewsize", "100", true}
  setCvar(scr_fov, 90); // screen.c: cvar_t scr_fov = {"fov", "90"}
  setCvar(lcd_x, 0); // view.c: cvar_t lcd_x = {"lcd_x", "0"}

  setMode320x200();
  vidBackend.current = fakeVid;
  re.current = softRenderer;
});

afterAll(() => {
  scrState.block_drawing = savedBlockDrawing;
  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;
  scrState.sb_lines = 0;
  vid.colormap = savedColormap;
  vid.fullbright = savedFullbright;
  Object.assign(rState, savedRState);
  Object.assign(dState, savedDState);
  cl_entities[0].model = null;
  cl.viewentity = 0;
  cl.maxclients = 0;
  clState.cl_numvisedicts = 0;
  vidBackend.current = savedBackend;
  re.current = savedRenderer;
  hostClientHooks.rInit = savedRInit;
  hostClientHooks.rInitTextures = savedRInitTextures;
  hostClientHooks.drawInit = savedDrawInit;
  hostClientHooks.rViewVectors = savedRViewVectors;
  if (savedSoftFactory) registerRenderer("soft", savedSoftFactory);
  else unregisterRenderer("soft");
  setModelLoaderHooks(null);
  cl.worldmodel = null;
  rmSync(scratchDir, { recursive: true, force: true });
});

//============================================================================

describe("R_Init", () => {
  test("registers r_main.c's 21 cvars and the two commands", () => {
    R_Init();

    expect(Cmd_Exists("timerefresh")).toBe(true);
    expect(Cmd_Exists("pointfile")).toBe(true);

    const registered = [
      r_draworder,
      r_speeds,
      r_timegraph,
      r_graphheight,
      r_drawflat,
      r_ambient,
      r_clearcolor,
      r_waterwarp,
      r_fullbright,
      r_drawentities,
      r_drawviewmodel,
      r_aliasstats,
      r_dspeeds,
      r_reportsurfout,
      r_maxsurfs,
      r_numsurfs,
      r_reportedgeout,
      r_maxedges,
      r_numedges,
      r_aliastransbase,
      r_aliastransadj,
    ];
    expect(registered.length).toBe(21);
    for (const cvar of registered) expect(Cvar_FindVar(cvar.name)).toBe(cvar);
  });

  // r_main.c: `cvar_t r_aliasstats = {"r_polymodelstats","0"};`
  test("r_aliasstats is registered under the name r_polymodelstats", () => {
    expect(r_aliasstats.name).toBe("r_polymodelstats");
    expect(Cvar_FindVar("r_aliasstats")).toBeNull();
  });

  test("Cvar_SetValue seeds r_maxedges/r_maxsurfs with the stack pool sizes", () => {
    expect(r_maxedges.value).toBe(2400); // NUMSTACKEDGES
    expect(r_maxsurfs.value).toBe(800); // NUMSTACKSURFACES
  });

  test("sets the view_clipplanes edge flags and r_refdef's origin", () => {
    expect(view_clipplanes[0].leftedge).toBe(1);
    expect(view_clipplanes[1].rightedge).toBe(1);
    expect(view_clipplanes[1].leftedge).toBe(0);
    expect(view_clipplanes[2].leftedge).toBe(0);
    expect(view_clipplanes[3].leftedge).toBe(0);
    expect(view_clipplanes[0].rightedge).toBe(0);
    expect(view_clipplanes[2].rightedge).toBe(0);
    expect(view_clipplanes[3].rightedge).toBe(0);

    expect(r_refdef.xOrigin).toBeCloseTo(0.5, 10);
    expect(r_refdef.yOrigin).toBeCloseTo(0.5, 10);
  });
});

describe("R_InitTurb", () => {
  test("sintable[0] is AMP and intsintable[0] is AMP2", () => {
    R_InitTurb();
    expect(sintable.length).toBe(SIN_BUFFER_SIZE);
    expect(intsintable.length).toBe(SIN_BUFFER_SIZE);
    expect(sintable[0]).toBe(AMP);
    expect(intsintable[0]).toBe(AMP2);
  });

  /*
  sintable[i] = AMP + sin(i*3.14159*2/CYCLE)*AMP. The C uses 3.14159, not M_PI,
  so a full CYCLE is short of 2*pi by 2*(M_PI - 3.14159) == 5.307e-6 radians
  and the table drifts by up to AMP * 5.307e-6 == 2.8 counts per cycle. The
  tolerances below are that drift, not slack.
  */
  test("peaks at a quarter cycle and repeats every CYCLE entries", () => {
    expect(Math.abs(sintable[32] - 2 * AMP)).toBeLessThanOrEqual(2);
    expect(Math.abs(sintable[128] - sintable[0])).toBeLessThanOrEqual(3);
    expect(Math.abs(sintable[160] - sintable[32])).toBeLessThanOrEqual(3);
  });
});

describe("R_SetVrect", () => {
  test("viewsize 100 with sb_lines 24 on 320x200 gives the C's vrect", () => {
    const vrectin = new VrectT();
    vrectin.x = 0;
    vrectin.y = 0;
    vrectin.width = 320;
    vrectin.height = 200;

    const out = new VrectT();
    cl.intermission = 0;
    R_SetVrect(vrectin, out, 24);

    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.width).toBe(320);
    expect(out.height).toBe(176);
  });

  test("viewsize is clamped to 100 and the width rounded down to a multiple of 8", () => {
    const vrectin = new VrectT();
    vrectin.width = 320;
    vrectin.height = 200;

    const out = new VrectT();

    setCvar(scr_viewsize, 70);
    cl.intermission = 0;
    R_SetVrect(vrectin, out, 24);
    // 320*0.7 = 224, already a multiple of 8; 200*0.7 = 140, height &= ~1
    expect(out.width).toBe(224);
    expect(out.height).toBe(140);
    expect(out.x).toBe(48);
    expect(out.y).toBe(18);

    setCvar(scr_viewsize, 100);
  });

  test("intermission forces a full-screen view with no status bar", () => {
    const vrectin = new VrectT();
    vrectin.width = 320;
    vrectin.height = 200;

    const out = new VrectT();
    cl.intermission = 1;
    R_SetVrect(vrectin, out, 24);
    cl.intermission = 0;

    expect(out.width).toBe(320);
    expect(out.height).toBe(200);
  });
});

describe("R_ViewChanged", () => {
  const vrectin = new VrectT();

  function viewChanged90(): void {
    vrectin.x = 0;
    vrectin.y = 0;
    vrectin.width = 320;
    vrectin.height = 200;
    r_refdef.fov_x = 90;
    cl.intermission = 0;
    R_ViewChanged(vrectin, 24, vid.aspect);
  }

  test("fov 90 gives horizontalFieldOfView 2 and the C's centers and scales", () => {
    viewChanged90();

    // 2 * tan(90/360 * PI) == 2 * tan(45 deg) == 2
    expect(r_refdef.horizontalFieldOfView).toBeCloseTo(2.0, 10);

    // xcenter = width*0.5 + vrect.x - 0.5, ycenter = height*0.5 + vrect.y - 0.5
    expect(rState.xcenter).toBeCloseTo(159.5, 10);
    expect(rState.ycenter).toBeCloseTo(87.5, 10);

    // xscale = vrect.width / horizontalFieldOfView
    expect(rState.xscale).toBeCloseTo(160.0, 10);
    expect(rState.xscaleinv).toBeCloseTo(1 / 160, 10);
    expect(rState.yscale).toBeCloseTo(160 * vid.aspect, 10);
    expect(rState.pixelAspect).toBeCloseTo(vid.aspect, 10);
    expect(rState.xscaleshrink).toBeCloseTo((320 - 6) / 2, 10);

    expect(r_refdef.vrect.width).toBe(320);
    expect(r_refdef.vrect.height).toBe(176);
    expect(r_refdef.vrectright).toBe(320);
    expect(r_refdef.vrectbottom).toBe(176);
    expect(r_refdef.fvrectright_adj).toBeCloseTo(319.5, 6);
    expect(r_refdef.vrectrightedge).toBeCloseTo(319.01, 4);
    expect(rState.r_viewchanged).toBe(true);
  });

  test("the four screenedge planes are the normalized frustum sides", () => {
    viewChanged90();

    // left: (-1/(xOrigin*hFOV), 0, 1) == (-1, 0, 1), normalized
    expect(screenedge[0].normal[0]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(screenedge[0].normal[1]).toBeCloseTo(0, 6);
    expect(screenedge[0].normal[2]).toBeCloseTo(Math.SQRT1_2, 5);

    // right: (1/((1-xOrigin)*hFOV), 0, 1) == (1, 0, 1), normalized
    expect(screenedge[1].normal[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(screenedge[1].normal[2]).toBeCloseTo(Math.SQRT1_2, 5);

    // top is -y, bottom is +y, both with a +z of the same sign
    expect(screenedge[2].normal[0]).toBeCloseTo(0, 6);
    expect(screenedge[2].normal[1]).toBeLessThan(0);
    expect(screenedge[2].normal[2]).toBeGreaterThan(0);
    expect(screenedge[3].normal[1]).toBeGreaterThan(0);
    expect(screenedge[3].normal[2]).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) {
      const n = screenedge[i].normal;
      expect(Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])).toBeCloseTo(1, 5);
      expect(screenedge[i].type).toBe(5); // PLANE_ANYZ
    }
  });

  test("r_aliastransition / r_resfudge scale with the resolution", () => {
    viewChanged90();
    const res_scale = Math.sqrt((320 * 176) / (320.0 * 152.0)) * (2.0 / 2.0);
    expect(rState.r_aliastransition).toBeCloseTo(200 * res_scale, 6);
    expect(rState.r_resfudge).toBeCloseTo(100 * res_scale, 6);
    expect(rState.r_fov_greater_than_90).toBe(false);
  });
});

describe("R_TransformFrustum / R_SetUpFrustumIndexes", () => {
  function frustumForIdentityView(): void {
    const vrectin = new VrectT();
    vrectin.width = 320;
    vrectin.height = 200;
    r_refdef.fov_x = 90;
    cl.intermission = 0;
    R_ViewChanged(vrectin, 24, vid.aspect);

    AngleVectors(vec3(0, 0, 0), vpn, vright, vup);
    modelorg[0] = modelorg[1] = modelorg[2] = 0;
    R_TransformFrustum();
  }

  test("viewangles 0 rotates the left/right screen edges into world space", () => {
    frustumForIdentityView();

    // vpn = (1,0,0), vright = (0,-1,0), vup = (0,0,1)
    expect(view_clipplanes[0].normal[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(view_clipplanes[0].normal[1]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(view_clipplanes[0].normal[2]).toBeCloseTo(0, 5);

    expect(view_clipplanes[1].normal[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(view_clipplanes[1].normal[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(view_clipplanes[1].normal[2]).toBeCloseTo(0, 5);

    // dist = DotProduct(modelorg, normal), and modelorg is the origin here
    for (let i = 0; i < 4; i++) expect(view_clipplanes[i].dist).toBeCloseTo(0, 6);
  });

  test("the frustum indexes are the per-plane min/max component picks", () => {
    frustumForIdentityView();
    R_SetUpFrustumIndexes();

    expect(Array.from(r_frustum_indexes.subarray(0, 6))).toEqual([3, 1, 5, 0, 4, 2]);
    expect(Array.from(r_frustum_indexes.subarray(6, 12))).toEqual([3, 4, 5, 0, 1, 2]);
    expect(Array.from(r_frustum_indexes.subarray(12, 18))).toEqual([3, 4, 2, 0, 1, 5]);
    expect(Array.from(r_frustum_indexes.subarray(18, 24))).toEqual([3, 4, 5, 0, 1, 2]);
  });
});

// TypeScript keeps the `rState.r_oldviewleaf = null` narrowing across the
// R_MarkLeaves() call that reassigns it, so the read goes through here
function oldViewleaf(): MleafT | null {
  return rState.r_oldviewleaf;
}

describe("R_NewMap / R_MarkLeaves", () => {
  let world: ModelT;

  test("R_NewMap clears the viewleaf and sizes the surface and edge pools", () => {
    setModelLoaderHooks(softRenderer.modelHooks);
    const mod = Mod_ForName("maps/refsoft.bsp", true);
    expect(mod).not.toBeNull();
    if (!mod) return;
    world = mod;
    cl.worldmodel = world;

    R_NewMap();

    expect(rState.r_viewleaf).toBeNull();
    // r_maxsurfs/r_maxedges are NUMSTACKSURFACES/NUMSTACKEDGES after R_Init,
    // so both pools stay on the "stack"
    expect(rState.r_cnumsurfs).toBe(800);
    expect(rState.r_surfsonstack).toBe(true);
    expect(rState.r_numallocatededges).toBe(2400);
    expect(rState.auxedges).toBeNull();
    expect(rState.r_dowarpold).toBe(false);
    expect(rState.r_viewchanged).toBe(false);
  });

  test("marks the viewleaf and every node up its parent chain", () => {
    expect(cl.worldmodel).not.toBeNull();
    if (!cl.worldmodel) return;

    rState.r_oldviewleaf = null;
    rState.r_viewleaf = cl.worldmodel.leafs[1];
    const before = rState.r_visframecount;

    R_MarkLeaves();

    expect(rState.r_visframecount).toBe(before + 1);
    expect(oldViewleaf()).toBe(cl.worldmodel.leafs[1]);
    expect(cl.worldmodel.leafs[1].visframe).toBe(rState.r_visframecount);

    // every node from the leaf up to the root carries the same visframe
    let node = cl.worldmodel.leafs[1].parent;
    let seen = 0;
    while (node) {
      expect(node.visframe).toBe(rState.r_visframecount);
      seen++;
      node = node.parent;
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("a second call with the same viewleaf is a no-op", () => {
    const before = rState.r_visframecount;
    R_MarkLeaves();
    expect(rState.r_visframecount).toBe(before);
  });
});

describe("softRenderer", () => {
  test("implements every member of the Renderer interface", () => {
    const asRenderer: Renderer = softRenderer;
    expect(asRenderer).toBe(softRenderer);

    re.current = softRenderer;
    expect(getRenderer()).toBe(softRenderer);

    // the members r_main.ts / r_misc.ts own are wired to the ported functions
    expect(asRenderer.R_Init).toBe(R_Init);
    expect(asRenderer.R_NewMap).toBe(R_NewMap);
    expect(asRenderer.R_SetVrect).toBe(R_SetVrect);
    expect(asRenderer.R_ViewChanged).toBe(R_ViewChanged);

    // r_cache_thrash forwards to d_surf.c's flag
    expect(typeof asRenderer.r_cache_thrash).toBe("boolean");

    // the seam methods with no software body are present and empty
    expect(asRenderer.R_InitEfrags()).toBeUndefined();
    expect(asRenderer.D_DeleteSurfaceCache()).toBeUndefined();
    expect(asRenderer.V_CalcBlend()).toBeUndefined();
    expect(asRenderer.GL_Set2D()).toBeUndefined();
    expect(asRenderer.SCR_TileClear()).toBeUndefined();
    expect(asRenderer.SCR_DrawCrosshair()).toBeUndefined();
    expect(asRenderer.R_TranslatePlayerSkin(0)).toBeUndefined();
  });

  test("installs host.c's R_Init / R_InitTextures / Draw_Init / view-vector hooks", () => {
    expect(hostClientHooks.rInit).not.toBeNull();
    expect(hostClientHooks.rInitTextures).not.toBeNull();
    expect(hostClientHooks.drawInit).not.toBeNull();

    const v: RViewVectors | undefined = hostClientHooks.rViewVectors?.();
    expect(v).toBeDefined();
    if (!v) return;
    expect(v.forward).toBe(vpn);
    expect(v.right).toBe(vright);
    expect(v.up).toBe(vup);
  });
});

/*
The one full-frame test. R_RenderView reaches every module in src/ref_soft, so
it only exists because U061-U066 had all landed when this suite was written;
the setup below is what vid_x.c's VID_Init and src/platform/vid.ts's
VID_CheckChanges hand the rasterizer (a z buffer, a surface-cache heap and a
colormap) plus a viewpoint above the synthetic map's two quads.
*/
describe("R_RenderView", () => {
  test("draws one frame of the synthetic map into vid.buffer", () => {
    const world = cl.worldmodel;
    expect(world).not.toBeNull();
    if (!world) return;

    cl_entities[0].model = world;
    cl.viewentity = 0;
    cl.maxclients = 1;
    cl.intermission = 0;
    clState.cl_numvisedicts = 0;

    // gfx/colormap.lmp is 256 * VID_GRADES bytes; this stand-in maps every
    // (color, light level) pair to a non-zero index so a drawn pixel is
    // distinguishable from the cleared buffer
    const colormap = new Uint8Array(256 * VID_GRADES);
    for (let i = 0; i < colormap.length; i++) colormap[i] = (i % 255) + 1;
    vid.colormap = colormap;
    vid.fullbright = 256;

    // vid_x.c's ResetFrameBuffer, as src/platform/vid.ts does it
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

    // the two faces are 64x64 quads on the z = 0 plane, in the empty leaf
    // above it; stand over them and look straight down
    r_refdef.vieworg[0] = 32;
    r_refdef.vieworg[1] = 32;
    r_refdef.vieworg[2] = 64;
    r_refdef.viewangles[0] = 90; // PITCH: looking down
    r_refdef.viewangles[1] = 0;
    r_refdef.viewangles[2] = 0;

    const buffer = vid.buffer;
    expect(buffer).not.toBeNull();
    if (!buffer) return;
    buffer.fill(0);

    R_RenderView();

    let drawn = 0;
    for (let i = 0; i < buffer.length; i++) if (buffer[i] !== 0) drawn++;
    expect(drawn).toBeGreaterThan(0);
  });
});

describe("EndFrame", () => {
  function endFrame(): void {
    updates.length = 0;
    softRenderer.EndFrame();
  }

  test("scr_copyeverything updates the whole screen", () => {
    scrState.scr_copyeverything = 1;
    scrState.scr_copytop = 0;
    endFrame();

    expect(updates.length).toBe(1);
    expect(updates[0].x).toBe(0);
    expect(updates[0].y).toBe(0);
    expect(updates[0].width).toBe(vid.width);
    expect(updates[0].height).toBe(vid.height);
  });

  test("scr_copytop updates everything above the status bar", () => {
    scrState.scr_copyeverything = 0;
    scrState.scr_copytop = 1;
    scrState.sb_lines = 24;
    endFrame();

    expect(updates.length).toBe(1);
    expect(updates[0].width).toBe(vid.width);
    expect(updates[0].height).toBe(vid.height - 24);
  });

  test("otherwise only scr_vrect is updated", () => {
    scrState.scr_copyeverything = 0;
    scrState.scr_copytop = 0;
    scr_vrect.x = 8;
    scr_vrect.y = 12;
    scr_vrect.width = 304;
    scr_vrect.height = 152;
    endFrame();

    expect(updates.length).toBe(1);
    expect(updates[0].x).toBe(8);
    expect(updates[0].y).toBe(12);
    expect(updates[0].width).toBe(304);
    expect(updates[0].height).toBe(152);
  });
});

/*
Q026: r_main.c is compiled once per tree and linked against the r_part.c of
its own tree; under qw.active the particle entry points must reach
src/qw/client/r_part.ts (its own pool, its own gravity/frametime), not
src/client/r_part.ts. Both modules are spied so "the QW one ran" and "the
WinQuake one did not" are both real assertions (rule 15: mockImplementation
spies installed in beforeAll, restored in afterAll; qw.active restored too).
*/
describe("particle entry points under qw.active", () => {
  const qwClearSpy = spyOn(qwRPart, "R_ClearParticles");
  const qwDrawSpy = spyOn(qwRPart, "R_DrawParticles");
  const winClearSpy = spyOn(winRPart, "R_ClearParticles");
  const winDrawSpy = spyOn(winRPart, "R_DrawParticles");
  const savedQwActive = qw.active;

  beforeAll(() => {
    qwClearSpy.mockImplementation(() => {});
    qwDrawSpy.mockImplementation(() => {});
    winClearSpy.mockImplementation(() => {});
    winDrawSpy.mockImplementation(() => {});
  });

  afterAll(() => {
    qwClearSpy.mockRestore();
    qwDrawSpy.mockRestore();
    winClearSpy.mockRestore();
    winDrawSpy.mockRestore();
    qw.active = savedQwActive;
    r_worldentity.model = null;
  });

  test("R_NewMap calls the QW module's R_ClearParticles, not WinQuake's", () => {
    const world = cl.worldmodel;
    expect(world).not.toBeNull();
    if (!world) return;

    qwClearSpy.mockClear();
    winClearSpy.mockClear();
    qw.active = true;
    try {
      R_NewMap();
    } finally {
      qw.active = false;
    }

    expect(qwClearSpy).toHaveBeenCalledTimes(1);
    expect(winClearSpy).not.toHaveBeenCalled();
  });

  test("R_NewMap without qw.active still calls WinQuake's", () => {
    qwClearSpy.mockClear();
    winClearSpy.mockClear();

    R_NewMap();

    expect(winClearSpy).toHaveBeenCalledTimes(1);
    expect(qwClearSpy).not.toHaveBeenCalled();
  });

  test("a full R_RenderView frame calls the QW module's R_DrawParticles, not WinQuake's", () => {
    const world = cl.worldmodel;
    expect(world).not.toBeNull();
    if (!world) return;

    // QW r_main.c's R_RenderView_ checks r_worldentity.model, not
    // cl_entities[0].model (r_main.ts's own qw.active fold)
    r_worldentity.model = world;
    cl_entities[0].model = world;
    cl.viewentity = 0;
    cl.maxclients = 1;
    cl.intermission = 0;
    clState.cl_numvisedicts = 0;

    qwDrawSpy.mockClear();
    winDrawSpy.mockClear();
    qw.active = true;
    try {
      R_RenderView();
    } finally {
      qw.active = false;
    }

    expect(qwDrawSpy).toHaveBeenCalledTimes(1);
    expect(winDrawSpy).not.toHaveBeenCalled();
  });
});
