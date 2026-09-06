import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { ModelLoaderHooks, TextureT } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import type { EntityT, ParticleT, Renderer } from "../src/client/render";
import type { VrectT } from "../src/client/vid";

// view.ts reaches console.c, menu.c and snd_dma.c through screen.ts (it
// imports scr_viewsize, and screen.ts itself statically imports
// Con_CheckResize/conState, M_Draw, and S_ClearBuffer/S_StopAllSounds). All
// three are landed, real modules now, so this suite drives them for real
// rather than stubbing any of the three: none of view.ts's own exports call
// into menu.ts or snd_dma.ts directly (screen.ts's own top-level module code
// never calls them either -- only functions this suite never invokes, like
// SCR_UpdateScreen, do), and `calls` below only ever records the fake
// Renderer's own methods.
const calls: string[] = [];

import * as modelMod from "../src/common/model";
import * as cmdMod from "../src/common/cmd";
import * as cvarMod from "../src/common/cvar";
import * as hostMod from "../src/common/host";
import * as mathMod from "../src/common/mathlib";
import * as quakedefMod from "../src/common/quakedef";
import * as bspMod from "../src/common/bspfile";
import * as sizebufMod from "../src/common/sizebuf";
import * as clientMod from "../src/client/client";
import * as renderMod from "../src/client/render";
import * as vidMod from "../src/client/vid";
import * as consoleMod from "../src/client/console";
import * as screenMod from "../src/client/screen";
import * as view from "../src/client/view";

const { TextureT: TextureTClass } = modelMod;
const { Cmd_Exists } = cmdMod;
const { Cvar_SetValue } = cvarMod;
const { host } = hostMod;
const { vec3 } = mathMod;
const { PITCH, ROLL, YAW, STAT_HEALTH } = quakedefMod;
const { CONTENTS_LAVA, CONTENTS_SLIME, CONTENTS_WATER } = bspMod;
const { MSG_BeginReading, net_message } = sizebufMod;
const { CSHIFT_CONTENTS, CSHIFT_DAMAGE, cl, cl_entities, cls } = clientMod;
const { r_refdef, re } = renderMod;
const { vid } = vidMod;
const { conState } = consoleMod;

const {
  BuildGammaTable,
  V_CalcBob,
  V_CalcRefdef,
  V_CalcRoll,
  V_CheckGamma,
  V_DriftPitch,
  V_Init,
  V_ParseDamage,
  V_RenderView,
  V_SetContentsColor,
  V_StartPitchDrift,
  V_StopPitchDrift,
  cshift_lava,
  gammatable,
} = view;

//=============================================================================

const hooks: ModelLoaderHooks = {
  notexture: new TextureTClass(),
  textureLoaded(): void {},
  Mod_LoadLighting(): void {},
  Mod_LoadAliasModel(): void {},
  Mod_LoadSpriteModel(): void {},
};

const fake: Renderer = {
  modelHooks: hooks,

  R_Init(): void {},
  R_InitTextures(): void {},
  R_InitEfrags(): void {},
  R_RenderView(): void {
    calls.push("R_RenderView");
  },
  R_ViewChanged(_pvrect: VrectT, _lineadj: number, _aspect: number): void {},
  R_InitSky(_mt: TextureT): void {},
  R_AddEfrags(_ent: EntityT): void {},
  R_RemoveEfrags(_ent: EntityT): void {},
  R_NewMap(): void {},
  R_PushDlights(): void {
    calls.push("R_PushDlights");
  },

  r_cache_thrash: false,

  D_SurfaceCacheForRes(_width: number, _height: number): number {
    return 0;
  },
  D_FlushCaches(): void {},
  D_DeleteSurfaceCache(): void {},
  D_InitCaches(_buffer: Uint8Array, _size: number): void {},
  R_SetVrect(_pvrectin: VrectT, _pvrect: VrectT, _lineadj: number): void {},

  draw_disc: null,

  Draw_Init(): void {},
  Draw_Character(_x: number, _y: number, _num: number): void {
    calls.push("Draw_Character");
  },
  Draw_DebugChar(_num: number): void {},
  Draw_Pic(_x: number, _y: number, _pic: QpicT): void {},
  Draw_TransPic(_x: number, _y: number, _pic: QpicT): void {},
  Draw_TransPicTranslate(_x: number, _y: number, _pic: QpicT, _translation: Uint8Array): void {},
  Draw_ConsoleBackground(_lines: number): void {},
  Draw_BeginDisc(): void {},
  Draw_EndDisc(): void {},
  Draw_TileClear(_x: number, _y: number, _w: number, _h: number): void {},
  Draw_Fill(_x: number, _y: number, _w: number, _h: number, _c: number): void {},
  Draw_FadeScreen(): void {},
  Draw_String(_x: number, _y: number, _str: string): void {},
  Draw_PicFromWad(_name: string): QpicT | null {
    return null;
  },
  Draw_CachePic(_path: string): QpicT | null {
    return null;
  },

  D_StartParticles(): void {},
  D_DrawParticle(_pparticle: ParticleT): void {},
  D_EndParticles(): void {},

  V_CalcBlend(): void {
    calls.push("V_CalcBlend");
  },
  V_UpdatePalette(): void {
    calls.push("V_UpdatePalette");
  },
  V_DrawCrosshair(): void {
    calls.push("V_DrawCrosshair");
  },

  R_TranslatePlayerSkin(_playernum: number): void {},

  SCR_CalcRefdef(): void {},
  BeginFrame(): void {},
  EndFrame(): void {},
  D_EnableBackBufferAccess(): void {},
  D_DisableBackBufferAccess(): void {},
  D_UpdateRects(_rects: VrectT | null): void {},
  GL_Set2D(): void {},
  SCR_TileClear(): void {},
  SCR_SoftwareTileClear(): void {},
  SCR_DrawCrosshair(): void {},
  Draw_SubPic(): void {},
  Draw_Alt_String(): void {},
  isGL: false,
  SCR_ScreenShot_f(): void {},
};

function forcedup(v: boolean): void {
  conState.con_forcedup = v;
}

beforeAll(() => {
  re.current = fake;
  V_Init();
  // V_CalcRefdef's weapon-height fudge reads screen.c's viewsize; register it
  // without running SCR_Init, which is test/screen.test.ts's subject
  cvarMod.Cvar_RegisterVariable(screenMod.scr_viewsize);
});

beforeEach(() => {
  calls.length = 0;
  re.current = fake;

  cl.clear();
  cls.demoplayback = false;
  cl.viewentity = 1;
  cl.maxclients = 1;
  cl.stats[STAT_HEALTH] = 100;
  cl_entities[1].origin[0] = 0;
  cl_entities[1].origin[1] = 0;
  cl_entities[1].origin[2] = 0;
  cl_entities[1].angles[0] = 0;
  cl_entities[1].angles[1] = 0;
  cl_entities[1].angles[2] = 0;

  host.frametime = 0.1;
  host.realtime = 0;

  vid.width = 320;
  vid.height = 200;
  vid.rowbytes = 320;
  vid.aspect = 320 / 200;
  vid.colormap = null;
  vid.buffer = null;
  vid.recalc_refdef = 0;

  r_refdef.vieworg[0] = r_refdef.vieworg[1] = r_refdef.vieworg[2] = 0;
  r_refdef.viewangles[0] = r_refdef.viewangles[1] = r_refdef.viewangles[2] = 0;
  r_refdef.vrect.height = 200;

  forcedup(false);

  Cvar_SetValue("lcd_x", 0);
  Cvar_SetValue("lcd_yaw", 0);
  Cvar_SetValue("v_idlescale", 0);
  Cvar_SetValue("scr_ofsx", 0);
  Cvar_SetValue("scr_ofsy", 0);
  Cvar_SetValue("scr_ofsz", 0);
  Cvar_SetValue("cl_rollspeed", 200);
  Cvar_SetValue("cl_rollangle", 2.0);
  Cvar_SetValue("cl_bob", 0.02);
  Cvar_SetValue("cl_bobcycle", 0.6);
  Cvar_SetValue("cl_bobup", 0.5);
  Cvar_SetValue("v_kicktime", 0.5);
  Cvar_SetValue("v_kickroll", 0.6);
  Cvar_SetValue("v_kickpitch", 0.6);
  Cvar_SetValue("v_centermove", 0.15);
  Cvar_SetValue("v_centerspeed", 500);
  Cvar_SetValue("viewsize", 100);
  Cvar_SetValue("gamma", 1);
  BuildGammaTable(1.0);
});

describe("V_Init", () => {
  test("registers v_cshift, bf and centerview", () => {
    expect(Cmd_Exists("v_cshift")).toBe(true);
    expect(Cmd_Exists("bf")).toBe(true);
    expect(Cmd_Exists("centerview")).toBe(true);
  });

  test("registers view.c's cvars with their C defaults", () => {
    expect(view.cl_rollspeed.name).toBe("cl_rollspeed");
    expect(view.cl_rollangle.name).toBe("cl_rollangle");
    expect(view.crosshair.archive).toBe(true);
    expect(view.v_gamma.name).toBe("gamma");
    expect(view.v_gamma.archive).toBe(true);
    expect(view.gl_cshiftpercent.name).toBe("gl_cshiftpercent");
    expect(view.v_idlescale.name).toBe("v_idlescale");
  });
});

describe("V_CalcRoll", () => {
  test("velocity to the player's left rolls negative, to the right positive", () => {
    const angles = vec3(0, 0, 0);
    // AngleVectors(0,0,0) puts `right` at (0,-1,0), so +Y velocity is to the left
    expect(V_CalcRoll(angles, vec3(0, 100, 0))).toBeCloseTo(-1.0, 6);
    expect(V_CalcRoll(angles, vec3(0, -100, 0))).toBeCloseTo(1.0, 6);
  });

  test("is linear below cl_rollspeed and clamps to cl_rollangle above it", () => {
    const angles = vec3(0, 0, 0);
    // 100 of 200 rollspeed -> half of the 2.0 rollangle
    expect(V_CalcRoll(angles, vec3(0, -100, 0))).toBeCloseTo(1.0, 6);
    expect(V_CalcRoll(angles, vec3(0, -200, 0))).toBeCloseTo(2.0, 6);
    expect(V_CalcRoll(angles, vec3(0, -100000, 0))).toBeCloseTo(2.0, 6);
    expect(V_CalcRoll(angles, vec3(0, 100000, 0))).toBeCloseTo(-2.0, 6);
  });

  test("velocity straight ahead induces no roll", () => {
    expect(V_CalcRoll(vec3(0, 0, 0), vec3(320, 0, 0))).toBe(0);
  });
});

describe("V_CalcBob", () => {
  test("at cycle 0 the bob is 0.3 of the speed*cl_bob term", () => {
    cl.time = 0;
    cl.velocity[0] = 200;
    cl.velocity[1] = 0;
    cl.velocity[2] = 0;
    // bob = 200*0.02 = 4; 4*0.3 + 4*0.7*sin(0) = 1.2
    expect(V_CalcBob()).toBeCloseTo(1.2, 6);
  });

  test("Z velocity is not counted", () => {
    cl.time = 0;
    cl.velocity[0] = 200;
    cl.velocity[1] = 0;
    cl.velocity[2] = 5000;
    expect(V_CalcBob()).toBeCloseTo(1.2, 6);
  });

  test("clamps to +4", () => {
    cl.time = 0;
    cl.velocity[0] = 100000;
    cl.velocity[1] = 0;
    expect(V_CalcBob()).toBe(4);
  });

  test("a quarter of the way up the cycle is a positive sine term", () => {
    // cycle 0.15 of cl_bobcycle 0.6 -> 0.25, below cl_bobup 0.5 -> PI/2
    cl.time = 0.15;
    cl.velocity[0] = 200;
    cl.velocity[1] = 0;
    cl.velocity[2] = 0;
    expect(V_CalcBob()).toBeCloseTo(4 * 0.3 + 4 * 0.7 * Math.sin(Math.PI / 2), 6);
  });
});

describe("pitch drifting", () => {
  test("V_StartPitchDrift arms the drift, V_StopPitchDrift disarms it", () => {
    cl.time = 5;
    cl.laststop = 0;
    cl.nodrift = true;
    cl.pitchvel = 0;
    V_StartPitchDrift();
    expect(cl.pitchvel).toBe(500); // v_centerspeed
    expect(cl.nodrift).toBe(false);
    expect(cl.driftmove).toBe(0);

    V_StopPitchDrift();
    expect(cl.laststop).toBe(5);
    expect(cl.nodrift).toBe(true);
    expect(cl.pitchvel).toBe(0);
  });

  test("V_StartPitchDrift is a no-op in the same frame something stopped the drift", () => {
    cl.time = 5;
    cl.laststop = 5;
    cl.nodrift = true;
    cl.pitchvel = 0;
    V_StartPitchDrift();
    expect(cl.pitchvel).toBe(0);
    expect(cl.nodrift).toBe(true);
  });

  test("V_DriftPitch moves viewangles toward cl.idealpitch when onground and drifting", () => {
    cl.onground = true;
    cl.nodrift = false;
    cl.pitchvel = 50;
    cl.idealpitch = 10;
    cl.viewangles[PITCH] = 0;

    V_DriftPitch();

    // move = host_frametime*pitchvel = 0.1*50 = 5, less than the 10 delta
    expect(cl.viewangles[PITCH]).toBeCloseTo(5, 6);
    // pitchvel accelerated by host_frametime*v_centerspeed
    expect(cl.pitchvel).toBeCloseTo(50 + 0.1 * 500, 6);
  });

  test("V_DriftPitch stops exactly at cl.idealpitch and zeroes pitchvel", () => {
    cl.onground = true;
    cl.nodrift = false;
    cl.pitchvel = 500;
    cl.idealpitch = 10;
    cl.viewangles[PITCH] = 0;

    V_DriftPitch(); // move = 50 > delta 10

    expect(cl.viewangles[PITCH]).toBeCloseTo(10, 6);
    expect(cl.pitchvel).toBe(0);
  });

  test("V_DriftPitch drifts downward for a negative delta", () => {
    cl.onground = true;
    cl.nodrift = false;
    cl.pitchvel = 50;
    cl.idealpitch = -10;
    cl.viewangles[PITCH] = 0;

    V_DriftPitch();

    expect(cl.viewangles[PITCH]).toBeCloseTo(-5, 6);
  });

  test("V_DriftPitch zeroes the drift in the air", () => {
    cl.onground = false;
    cl.pitchvel = 123;
    cl.driftmove = 4;
    V_DriftPitch();
    expect(cl.pitchvel).toBe(0);
    expect(cl.driftmove).toBe(0);
  });
});

describe("V_ParseDamage", () => {
  function feed(bytes: number[]): void {
    net_message.data = new Uint8Array(bytes);
    net_message.maxsize = bytes.length;
    net_message.cursize = bytes.length;
    MSG_BeginReading();
  }

  test("armor over blood gives the 200/100/100 shift, and the kick signs follow `from`", () => {
    cl.time = 3;
    cl.viewentity = 1;
    cl.cshifts[CSHIFT_DAMAGE].percent = 0;

    // armor 100, blood 10, from = (100, 100, 0) -- MSG_ReadCoord is short/8
    feed([100, 10, 0x20, 0x03, 0x20, 0x03, 0x00, 0x00]);
    V_ParseDamage();

    expect(cl.faceanimtime).toBeCloseTo(3.2, 6);

    // count = 10*0.5 + 100*0.5 = 55; percent += 165, clamped at 150
    expect(cl.cshifts[CSHIFT_DAMAGE].percent).toBe(150);
    expect(Array.from(cl.cshifts[CSHIFT_DAMAGE].destcolor)).toEqual([200, 100, 100]);

    // ent at the origin with zero angles: right = (0,-1,0), forward = (1,0,0),
    // from normalizes to (0.7071, 0.7071, 0)
    const s = Math.SQRT1_2;
    expect(view.v_dmg_roll).toBeCloseTo(55 * -s * 0.6, 4);
    expect(view.v_dmg_pitch).toBeCloseTo(55 * s * 0.6, 4);
    expect(view.v_dmg_time).toBeCloseTo(0.5, 6); // v_kicktime
  });

  test("armor with more blood gives 220/50/50, no armor at all gives 255/0/0", () => {
    cl.cshifts[CSHIFT_DAMAGE].percent = 0;
    feed([10, 100, 0, 0, 0, 0, 0, 0]);
    V_ParseDamage();
    expect(Array.from(cl.cshifts[CSHIFT_DAMAGE].destcolor)).toEqual([220, 50, 50]);

    cl.cshifts[CSHIFT_DAMAGE].percent = 0;
    feed([0, 100, 0, 0, 0, 0, 0, 0]);
    V_ParseDamage();
    expect(Array.from(cl.cshifts[CSHIFT_DAMAGE].destcolor)).toEqual([255, 0, 0]);
  });

  test("a tiny hit still counts as 10", () => {
    cl.cshifts[CSHIFT_DAMAGE].percent = 0;
    feed([0, 2, 0, 0, 0, 0, 0, 0]);
    V_ParseDamage();
    expect(cl.cshifts[CSHIFT_DAMAGE].percent).toBe(30); // 3 * 10
  });
});

describe("gamma", () => {
  test("BuildGammaTable(1.0) is the identity", () => {
    BuildGammaTable(1.0);
    for (let i = 0; i < 256; i++) expect(gammatable[i]).toBe(i);
  });

  test("BuildGammaTable(0.5) stays monotone and spans the range", () => {
    BuildGammaTable(0.5);
    for (let i = 1; i < 256; i++) expect(gammatable[i]).toBeGreaterThanOrEqual(gammatable[i - 1] ?? 0);
    expect(gammatable[255]).toBe(255);
    expect(gammatable[0]).toBeGreaterThan(0); // 0.5 brightens
    BuildGammaTable(1.0);
  });

  test("V_CheckGamma rebuilds only when the cvar moved, and forces a refdef recalc", () => {
    Cvar_SetValue("gamma", 0.5);
    vid.recalc_refdef = 0;
    expect(V_CheckGamma()).toBe(true);
    expect(vid.recalc_refdef).toBe(1);
    expect(gammatable[255]).toBe(255);

    vid.recalc_refdef = 0;
    expect(V_CheckGamma()).toBe(false);
    expect(vid.recalc_refdef).toBe(0);

    Cvar_SetValue("gamma", 1);
    V_CheckGamma();
  });
});

describe("V_SetContentsColor", () => {
  test("copies the cshift, it does not alias the shared one", () => {
    V_SetContentsColor(CONTENTS_LAVA);
    expect(cl.cshifts[CSHIFT_CONTENTS]).not.toBe(cshift_lava);
    expect(Array.from(cl.cshifts[CSHIFT_CONTENTS].destcolor)).toEqual([255, 80, 0]);
    expect(cl.cshifts[CSHIFT_CONTENTS].percent).toBe(150);

    // writing through cl.cshifts must not reach the module's cshift_lava
    cl.cshifts[CSHIFT_CONTENTS].percent = 0;
    expect(cshift_lava.percent).toBe(150);

    V_SetContentsColor(CONTENTS_SLIME);
    expect(Array.from(cl.cshifts[CSHIFT_CONTENTS].destcolor)).toEqual([0, 25, 5]);

    V_SetContentsColor(CONTENTS_WATER);
    expect(Array.from(cl.cshifts[CSHIFT_CONTENTS].destcolor)).toEqual([130, 80, 50]);
    expect(cl.cshifts[CSHIFT_CONTENTS].percent).toBe(128);
  });
});

describe("V_CalcRefdef", () => {
  test("vieworg is the entity origin plus viewheight plus bob plus the 1/32 epsilon", () => {
    cl.viewentity = 1;
    cl.onground = false; // latch the stair-step oldz at the entity's height
    cl.nodrift = true;
    cl.cmd.forwardmove = 0;
    cl.time = 0;
    cl.oldtime = 0;
    cl.viewheight = 22;
    cl.velocity[0] = 200;
    cl.velocity[1] = 0;
    cl.velocity[2] = 0;
    cl_entities[1].origin[0] = 10;
    cl_entities[1].origin[1] = 20;
    cl_entities[1].origin[2] = 30;

    V_CalcRefdef(); // priming pass: oldz = 30
    V_CalcRefdef();

    const bob = 1.2; // 200*0.02 = 4, cycle 0 -> 4*0.3
    expect(r_refdef.vieworg[0]).toBeCloseTo(10 + 1 / 32, 5);
    expect(r_refdef.vieworg[1]).toBeCloseTo(20 + 1 / 32, 5);
    expect(r_refdef.vieworg[2]).toBeCloseTo(30 + 22 + bob + 1 / 32, 5);
  });

  test("a step up is smoothed, and never lags the entity by more than 12", () => {
    cl.viewentity = 1;
    cl.nodrift = true;
    cl.cmd.forwardmove = 0;
    cl.time = 0;
    cl.oldtime = 0;
    cl.viewheight = 22;
    cl.velocity[0] = cl.velocity[1] = cl.velocity[2] = 0; // bob = 0
    cl_entities[1].origin[0] = 0;
    cl_entities[1].origin[1] = 0;

    cl.onground = false;
    cl_entities[1].origin[2] = 0;
    V_CalcRefdef(); // oldz = 0

    cl.onground = true;
    cl_entities[1].origin[2] = 30; // a 30-unit step, clamped to 12
    V_CalcRefdef();

    expect(r_refdef.vieworg[2]).toBeCloseTo(30 + 22 + 1 / 32 - 12, 5);
  });

  test("the gun entity follows the view", () => {
    cl.viewentity = 1;
    cl.nodrift = true;
    cl.onground = false;
    cl.time = 0;
    cl.oldtime = 0;
    cl.viewheight = 22;
    cl.velocity[0] = cl.velocity[1] = cl.velocity[2] = 0;
    cl_entities[1].origin[0] = 0;
    cl_entities[1].origin[1] = 0;
    cl_entities[1].origin[2] = 0;
    cl.viewangles[YAW] = 45;
    cl.viewangles[PITCH] = 10;
    cl.viewangles[ROLL] = 0;

    V_CalcRefdef();

    // the player model faces the view dir, pitch inverted
    expect(cl_entities[1].angles[YAW]).toBe(45);
    expect(cl_entities[1].angles[PITCH]).toBe(-10);
    // viewsize 100 lifts the gun 2 units above the eye height
    expect(cl.viewent.origin[2]).toBeCloseTo(22 + 2, 5);
    expect(cl.viewent.model).toBe(null);
  });
});

describe("V_RenderView", () => {
  test("returns before touching the renderer when the console is forced up", () => {
    forcedup(true);
    V_RenderView();
    expect(calls).toEqual([]);
  });

  test("renders once and draws the crosshair through the seam", () => {
    cl.paused = true; // skip V_CalcRefdef
    cl.intermission = 0;
    V_RenderView();
    expect(calls).toEqual(["R_PushDlights", "R_RenderView", "V_DrawCrosshair"]);
  });

  test("lcd_x renders two interleaved views and restores vid.buffer", () => {
    cl.paused = true;
    cl.intermission = 0;
    vid.rowbytes = 320;
    const buffer = new Uint8Array(320 * 200);
    vid.buffer = buffer;
    Cvar_SetValue("lcd_x", 1);

    V_RenderView();

    expect(calls.filter((c) => c === "R_RenderView").length).toBe(2);
    expect(calls.filter((c) => c === "R_PushDlights").length).toBe(2);
    expect(vid.buffer).toBe(buffer);
    expect(vid.rowbytes).toBe(320);

    Cvar_SetValue("lcd_x", 0);
    vid.buffer = null;
  });

  test("intermission uses V_CalcIntermissionRefdef and blanks the gun model", () => {
    cl.paused = false;
    cl.intermission = 1;
    cl.viewentity = 1;
    cl_entities[1].origin[0] = 7;
    cl_entities[1].origin[1] = 8;
    cl_entities[1].origin[2] = 9;
    cl.viewent.model = null;

    V_RenderView();

    expect(r_refdef.vieworg[0]).toBe(7);
    expect(r_refdef.vieworg[1]).toBe(8);
    expect(r_refdef.vieworg[2]).toBe(9);
    expect(cl.viewent.model).toBe(null);
  });

  test("multiplayer zeroes the scr_ofs cheats", () => {
    cl.paused = true;
    cl.intermission = 0;
    cl.maxclients = 2;
    Cvar_SetValue("scr_ofsx", 50);
    V_RenderView();
    expect(view.scr_ofsx.value).toBe(0);
    expect(view.scr_ofsy.value).toBe(0);
    expect(view.scr_ofsz.value).toBe(0);
  });
});

describe("V_CalcBlend / V_UpdatePalette", () => {
  test("both forward to the renderer", () => {
    view.V_CalcBlend();
    view.V_UpdatePalette();
    expect(calls).toEqual(["V_CalcBlend", "V_UpdatePalette"]);
  });
});

describe("V_CalcPowerupCshift", () => {
  test("quad, suit, ring and pentagram each get their C color and percent", () => {
    cl.items = quakedefMod.IT_QUAD;
    view.V_CalcPowerupCshift();
    expect(Array.from(cl.cshifts[3].destcolor)).toEqual([0, 0, 255]);
    expect(cl.cshifts[3].percent).toBe(30);

    cl.items = quakedefMod.IT_SUIT;
    view.V_CalcPowerupCshift();
    expect(Array.from(cl.cshifts[3].destcolor)).toEqual([0, 255, 0]);
    expect(cl.cshifts[3].percent).toBe(20);

    cl.items = quakedefMod.IT_INVISIBILITY;
    view.V_CalcPowerupCshift();
    expect(Array.from(cl.cshifts[3].destcolor)).toEqual([100, 100, 100]);
    expect(cl.cshifts[3].percent).toBe(100);

    cl.items = quakedefMod.IT_INVULNERABILITY;
    view.V_CalcPowerupCshift();
    expect(Array.from(cl.cshifts[3].destcolor)).toEqual([255, 255, 0]);
    expect(cl.cshifts[3].percent).toBe(30);

    cl.items = 0;
    view.V_CalcPowerupCshift();
    expect(cl.cshifts[3].percent).toBe(0);
  });
});

describe("V_BonusFlash_f", () => {
  test("sets the pickup flash", () => {
    view.V_BonusFlash_f();
    expect(Array.from(cl.cshifts[2].destcolor)).toEqual([215, 186, 69]);
    expect(cl.cshifts[2].percent).toBe(50);
  });
});
