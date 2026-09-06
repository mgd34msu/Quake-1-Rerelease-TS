import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { ModelLoaderHooks, TextureT } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import type { EntityT, ParticleT, Renderer } from "../src/client/render";
import type { VrectT } from "../src/client/vid";

// This suite exercises the Q023b QuakeWorld deltas: view.ts's qw.active fold
// (src/client/view.ts) and the two wholesale QW modules
// (src/qw/client/screen.ts, src/qw/client/r_part.ts). A fake Renderer records
// its own call names into `calls`, the same recipe test/screen.test.ts and
// test/view.test.ts already use, so this file never touches ref_soft/ref_gl
// (neither is landed).
const calls: string[] = [];

import * as modelMod from "../src/common/model";
import * as hostMod from "../src/common/host";
import * as mathMod from "../src/common/mathlib";
import * as quakedefMod from "../src/common/quakedef";
import * as sizebufMod from "../src/common/sizebuf";
import * as bothdefsMod from "../src/qw/bothdefs";
import * as protocolMod from "../src/qw/protocol";
import * as pmoveTypesMod from "../src/qw/pmove_types";
import * as clientMod from "../src/client/client";
import * as renderMod from "../src/client/render";
import * as vidMod from "../src/client/vid";
import * as keysMod from "../src/client/keys";
import * as consoleMod from "../src/client/console";
import * as screenTypesMod from "../src/client/screen_types";
import * as viewMod from "../src/client/view";
import * as screenMod from "../src/qw/client/screen";
import * as rPartMod from "../src/qw/client/r_part";

const { qw } = quakedefMod;
const { vec3 } = mathMod;
const { IT_QUAD, IT_INVULNERABILITY } = quakedefMod;
const { STAT_ITEMS } = bothdefsMod;
const { PF_DEAD, UPDATE_BACKUP } = protocolMod;
const { pmState } = pmoveTypesMod;
const { CSHIFT_DAMAGE, CSHIFT_POWERUP, CactiveT, cl, cls } = clientMod;
const { re } = renderMod;
const { vid } = vidMod;
const { KeydestT, keyState } = keysMod;
const { conState } = consoleMod;
const { scrState } = screenTypesMod;
const { MSG_BeginReading, net_message } = sizebufMod;
const { host } = hostMod;

const { V_CalcBob, V_CalcRoll, V_CalcPowerupCshift, V_ParseDamage } = viewMod;

// resetState()'s own beforeEach baseline (below) parks cls.state at
// ca_active for every test in this file, but nothing ever puts it back
// afterward -- the last test to run here leaves cls.state at whatever it set
// beyond that baseline for the rest of this bun process (rule 15). Snapshot
// captured before any beforeEach/test runs, restored in this file's afterAll.
const savedClsState = cls.state;

//=============================================================================
// A recording Renderer, same shape as test/screen.test.ts / test/view.test.ts.

const hooks: ModelLoaderHooks = {
  notexture: new modelMod.TextureT(),
  textureLoaded(): void {},
  Mod_LoadLighting(): void {},
  Mod_LoadAliasModel(): void {},
  Mod_LoadSpriteModel(): void {},
};

const tileClears: Array<{ x: number; y: number; w: number; h: number }> = [];

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
  Draw_Pic(_x: number, _y: number, _pic: QpicT): void {
    calls.push("Draw_Pic");
  },
  Draw_TransPic(_x: number, _y: number, _pic: QpicT): void {},
  Draw_TransPicTranslate(_x: number, _y: number, _pic: QpicT, _translation: Uint8Array): void {},
  Draw_ConsoleBackground(_lines: number): void {},
  Draw_BeginDisc(): void {},
  Draw_EndDisc(): void {},
  Draw_TileClear(_x: number, _y: number, _w: number, _h: number): void {},
  Draw_Fill(_x: number, _y: number, _w: number, _h: number, _c: number): void {},
  Draw_FadeScreen(): void {},
  Draw_String(_x: number, _y: number, _str: string): void {
    calls.push("Draw_String");
  },
  Draw_PicFromWad(_name: string): QpicT | null {
    return null;
  },
  Draw_CachePic(_path: string): QpicT | null {
    return null;
  },

  D_StartParticles(): void {
    calls.push("D_StartParticles");
  },
  D_DrawParticle(_pparticle: ParticleT): void {
    calls.push("D_DrawParticle");
  },
  D_EndParticles(): void {
    calls.push("D_EndParticles");
  },

  V_CalcBlend(): void {},
  V_UpdatePalette(): void {
    calls.push("V_UpdatePalette");
  },
  V_DrawCrosshair(): void {
    calls.push("V_DrawCrosshair");
  },

  R_TranslatePlayerSkin(_playernum: number): void {},

  SCR_CalcRefdef(): void {
    calls.push("SCR_CalcRefdef");
  },
  BeginFrame(): void {},
  EndFrame(): void {},
  D_EnableBackBufferAccess(): void {},
  D_DisableBackBufferAccess(): void {},
  D_UpdateRects(_rects: VrectT | null): void {},
  GL_Set2D(): void {},
  SCR_TileClear(): void {},
  SCR_SoftwareTileClear(x: number, y: number, w: number, h: number): void {
    calls.push(`SCR_SoftwareTileClear(${x},${y},${w},${h})`);
    tileClears.push({ x, y, w, h });
  },
  SCR_DrawCrosshair(): void {},
  Draw_SubPic(): void {},
  Draw_Alt_String(): void {},
  isGL: false,
  SCR_ScreenShot_f(): void {
    calls.push("SCR_ScreenShot_f");
  },
};

beforeAll(() => {
  qw.active = true;
  viewMod.V_Init(); // registers cl_rollspeed/cl_rollangle/cl_bob*/v_kick*/etc (a cvar's
  // .value is 0 until Cvar_RegisterVariable runs, same as the C -- see cvar.ts)
  screenMod.scr_conspeed.value = 300; // screenMod.SCR_Init() is not called (needs a loaded WAD)
});

afterAll(() => {
  qw.active = false;
  cls.state = savedClsState;
});

function resetState(): void {
  calls.length = 0;
  tileClears.length = 0;

  re.current = fake;
  fake.r_cache_thrash = false;

  cl.clear();
  cl.qw.clear();
  cls.qw.netchan.outgoing_sequence = 0;
  cls.qw.netchan.incoming_acknowledged = 0;
  cls.qw.netchan.incoming_sequence = 0;
  cls.demoplayback = false;
  cls.state = CactiveT.ca_active;

  keyState.key_dest = KeydestT.key_game;
  conState.con_initialized = true;
  conState.con_notifylines = 0;

  host.frametime = 0.1;
  host.realtime = 0;

  vid.width = 320;
  vid.height = 200;
  vid.numpages = 2;
  vid.recalc_refdef = 0;

  pmState.onground = -1;

  scrState.scr_con_current = 0;
  scrState.scr_conlines = 0;
  scrState.scr_fullupdate = 0;
  scrState.sb_lines = 0;
  scrState.clearnotify = 0;
  scrState.scr_disabled_for_loading = false;
  scrState.scr_skipupdate = false;
  scrState.scr_copytop = 0;
  scrState.scr_copyeverything = 0;
  scrState.block_drawing = false;

  // cl_rollspeed/cl_rollangle/cl_bob*/v_kick*/scr_conspeed: registered by
  // V_Init()/set directly in beforeAll with their C defaults, which every
  // test below relies on; re-asserted here as plain values (not by name,
  // Cvar_Set_style) since resetting them is this suite's own job (rule 15)
  // and nothing here needs to change them from default.
  viewMod.cl_rollspeed.value = 200;
  viewMod.cl_rollangle.value = 2.0;
  viewMod.cl_bob.value = 0.02;
  viewMod.cl_bobcycle.value = 0.6;
  viewMod.cl_bobup.value = 0.5;
  viewMod.v_kicktime.value = 0.5;
  viewMod.v_kickroll.value = 0.6;
  viewMod.v_kickpitch.value = 0.6;
  screenMod.scr_conspeed.value = 300;

  screenMod.scr_allowsnap.value = 1;

  rPartMod.R_InitParticles();
  rPartMod.R_ClearParticles();
}

beforeEach(() => {
  resetState();
});

describe("SCR_SetUpToDrawConsole (qw)", () => {
  test("cls.state !== ca_active forces a full-screen console, by name (not con_forcedup)", () => {
    cls.state = CactiveT.ca_connected; // any non-ca_active state
    conState.con_forcedup = false; // QW never writes this -- must stay untouched
    screenMod.SCR_SetUpToDrawConsole();

    expect(scrState.scr_conlines).toBe(vid.height);
    expect(scrState.scr_con_current).toBe(vid.height);
    expect(conState.con_forcedup).toBe(false);
  });

  test("ca_active with key_console approaches half screen", () => {
    cls.state = CactiveT.ca_active;
    keyState.key_dest = KeydestT.key_console;
    scrState.scr_con_current = 0;
    screenMod.SCR_SetUpToDrawConsole();
    expect(scrState.scr_conlines).toBe(100);
    expect(scrState.scr_con_current).toBeCloseTo(30, 10); // 300*0.1
  });

  test("ca_active with key_game shows no console", () => {
    cls.state = CactiveT.ca_active;
    keyState.key_dest = KeydestT.key_game;
    scrState.scr_con_current = 20;
    screenMod.SCR_SetUpToDrawConsole();
    expect(scrState.scr_conlines).toBe(0);
  });
});

describe("SCR_DrawNet (qw)", () => {
  test("stays hidden while the connection is current (< UPDATE_BACKUP-1 behind)", () => {
    cls.qw.netchan.outgoing_sequence = 5;
    cls.qw.netchan.incoming_acknowledged = 5;
    screenMod.SCR_DrawNet();
    expect(calls).not.toContain("Draw_Pic");
  });

  test("shows once the gap reaches UPDATE_BACKUP-1", () => {
    cls.qw.netchan.outgoing_sequence = UPDATE_BACKUP - 1;
    cls.qw.netchan.incoming_acknowledged = 0;
    screenMod.SCR_DrawNet();
    expect(calls).toContain("Draw_Pic");
  });

  test("demo playback always hides it", () => {
    cls.qw.netchan.outgoing_sequence = UPDATE_BACKUP + 10;
    cls.qw.netchan.incoming_acknowledged = 0;
    cls.demoplayback = true;
    screenMod.SCR_DrawNet();
    expect(calls).not.toContain("Draw_Pic");
  });
});

describe("SCR_ScreenShot_f / SCR_RSShot_f (qw)", () => {
  // screen.c writes a PCX of vid.buffer, gl_screen.c writes a TGA of
  // glReadPixels; both bodies live behind the renderer seam, so this command
  // has to forward instead of carrying its own software-only copy (which
  // captured an all-black PCX under -vid_ref gl, since this port allocates
  // vid.buffer for both renderers).
  test("forwards to Renderer.SCR_ScreenShot_f", () => {
    screenMod.SCR_ScreenShot_f();
    expect(calls).toContain("SCR_ScreenShot_f");
  });

  test("forwards even when vid.buffer is null, i.e. it does not gate on the software framebuffer", () => {
    const savedBuffer = vid.buffer;
    vid.buffer = null;
    try {
      screenMod.SCR_ScreenShot_f();
      expect(calls).toContain("SCR_ScreenShot_f");
    } finally {
      vid.buffer = savedBuffer;
    }
  });

  test("SCR_RSShot_f (snap) keeps screen.c's own software body and does not reach the seam", () => {
    const savedBuffer = vid.buffer;
    vid.buffer = null; // no software framebuffer to sample
    cls.state = CactiveT.ca_active;
    try {
      screenMod.SCR_RSShot_f();
      expect(calls).not.toContain("SCR_ScreenShot_f");
    } finally {
      vid.buffer = savedBuffer;
    }
  });
});

describe("V_CalcRefdef (qw): where the eye and the view weapon end up", () => {
  // QW/client/view.c V_CalcRefdef: r_refdef.vieworg is cl.simorg + bob +
  // 1/16 on every axis + 22 (view height); cl.viewent.origin is cl.simorg +
  // 22 + forward*bob*0.4 + bob, plus the scr_viewsize fudge (+2 at 100).
  // With bob 0 that puts the gun 2 units above the eye minus the 1/16 nudge,
  // NOT above the top of the screen.
  function settleRefdef(simorg: [number, number, number], simangles: [number, number, number]): void {
    cls.state = CactiveT.ca_active;
    cls.demoplayback = false;
    cls.qw.netchan.incoming_sequence = 0;
    cl.qw.playernum = 0;
    cl.qw.spectator = 1; // V_CalcBob returns 0 for a spectator, so bob is exactly 0
    cl.qw.punchangle = 0;
    for (let i = 0; i < 3; i++) {
      cl.qw.simorg[i] = simorg[i];
      cl.qw.simangles[i] = simangles[i];
      cl.qw.simvel[i] = 0;
    }
    const ps = cl.qw.frames[0].playerstate[0];
    ps.flags = 0;
    ps.onground = -1; // V_DriftPitch returns early; no stair-step smoothing
    ps.weaponframe = 0;
    screenMod.scr_viewsize.value = 100;

    // several frames so view.c's damage-kick timer (v_dmg_time) and
    // CalcGunAngle's oldyaw/oldpitch statics have settled, whatever an
    // earlier suite left behind
    for (let i = 0; i < 10; i++) viewMod.V_RenderView();
  }

  test("the eye is 22 above cl.simorg and the gun is 2 above the eye (viewsize 100)", () => {
    settleRefdef([100, 200, 50], [0, 90, 0]);

    expect(renderMod.r_refdef.vieworg[0]).toBeCloseTo(100 + 1 / 16, 5);
    expect(renderMod.r_refdef.vieworg[1]).toBeCloseTo(200 + 1 / 16, 5);
    expect(renderMod.r_refdef.vieworg[2]).toBeCloseTo(50 + 22 + 1 / 16, 5);

    expect(cl.viewent.origin[0]).toBeCloseTo(100, 5);
    expect(cl.viewent.origin[1]).toBeCloseTo(200, 5);
    expect(cl.viewent.origin[2]).toBeCloseTo(50 + 22 + 2, 5);

    // the gun sits just above the eye, never a screen-height away from it
    expect(cl.viewent.origin[2] - renderMod.r_refdef.vieworg[2]).toBeCloseTo(2 - 1 / 16, 5);
  });

  test("the gun's pitch is the negated view pitch and its yaw matches (CalcGunAngle)", () => {
    settleRefdef([0, 0, 0], [10, 90, 0]);

    expect(renderMod.r_refdef.viewangles[0]).toBeCloseTo(10, 5);
    expect(renderMod.r_refdef.viewangles[1]).toBeCloseTo(90, 5);
    expect(cl.viewent.angles[0]).toBeCloseTo(-10, 5);
    expect(cl.viewent.angles[1]).toBeCloseTo(90, 5);
    expect(cl.viewent.angles[2]).toBeCloseTo(0, 5); // V_RenderView zeroes cl.simangles[ROLL]
  });

  test("PF_DEAD drops the eye 16 below cl.simorg instead of raising it 22", () => {
    cls.state = CactiveT.ca_active;
    cls.demoplayback = false;
    cls.qw.netchan.incoming_sequence = 0;
    cl.qw.playernum = 0;
    cl.qw.spectator = 1;
    cl.qw.punchangle = 0;
    for (let i = 0; i < 3; i++) {
      cl.qw.simorg[i] = 0;
      cl.qw.simangles[i] = 0;
      cl.qw.simvel[i] = 0;
    }
    cl.qw.simorg[2] = 50;
    const ps = cl.qw.frames[0].playerstate[0];
    ps.flags = PF_DEAD;
    ps.onground = -1;
    for (let i = 0; i < 10; i++) viewMod.V_RenderView();

    expect(renderMod.r_refdef.vieworg[2]).toBeCloseTo(50 - 16 + 1 / 16, 5);
    expect(renderMod.r_refdef.viewangles[2]).toBeCloseTo(80, 5); // dead view angle
    expect(cl.viewent.model).toBe(null);
  });
});

describe("V_CalcRoll (qw, shared body -- no qw.active change)", () => {
  test("is linear below cl_rollspeed and clamps to cl_rollangle above it", () => {
    const angles = vec3(0, 0, 0);
    expect(V_CalcRoll(angles, vec3(0, -100, 0))).toBeCloseTo(1.0, 6);
    expect(V_CalcRoll(angles, vec3(0, -200, 0))).toBeCloseTo(2.0, 6);
    expect(V_CalcRoll(angles, vec3(0, 100000, 0))).toBeCloseTo(-2.0, 6);
  });
});

describe("V_CalcBob (qw)", () => {
  test("spectator never bobs", () => {
    cl.qw.spectator = 1;
    expect(V_CalcBob()).toBe(0);
  });

  test("onground === -1 (airborne) returns the last computed bob unchanged", () => {
    cl.qw.spectator = 0;
    pmState.onground = 0; // grounded, so this call integrates bobtime
    cl.qw.simvel[0] = 200;
    cl.qw.simvel[1] = 0;
    const grounded = V_CalcBob();

    pmState.onground = -1; // airborne now
    const airborne = V_CalcBob();
    expect(airborne).toBe(grounded);
  });

  test("bob is proportional to cl.qw.simvel in the xy plane", () => {
    cl.qw.spectator = 0;
    pmState.onground = 0;
    cl.qw.simvel[0] = 200;
    cl.qw.simvel[1] = 0;
    cl.qw.simvel[2] = 5000; // Z not counted
    const bob = V_CalcBob();
    expect(bob).toBeGreaterThan(0);
    expect(bob).toBeLessThanOrEqual(4);
  });
});

describe("V_ParseDamage (qw)", () => {
  function feed(bytes: number[]): void {
    net_message.data = new Uint8Array(bytes);
    net_message.maxsize = bytes.length;
    net_message.cursize = bytes.length;
    MSG_BeginReading();
  }

  test("reads the view kick off cl.qw.simorg/simangles, not cl_entities", () => {
    cl.time = 3;
    cl.qw.simorg[0] = 0;
    cl.qw.simorg[1] = 0;
    cl.qw.simorg[2] = 0;
    cl.qw.simangles[0] = 0;
    cl.qw.simangles[1] = 0;
    cl.qw.simangles[2] = 0;
    cl.cshifts[CSHIFT_DAMAGE].percent = 0;

    // armor 100, blood 10, from = (100, 100, 0) -- MSG_ReadCoord is short/8
    feed([100, 10, 0x20, 0x03, 0x20, 0x03, 0x00, 0x00]);
    V_ParseDamage();

    expect(cl.faceanimtime).toBeCloseTo(3.2, 6);
    expect(cl.cshifts[CSHIFT_DAMAGE].percent).toBe(150);
    expect(Array.from(cl.cshifts[CSHIFT_DAMAGE].destcolor)).toEqual([200, 100, 100]);

    const s = Math.SQRT1_2;
    expect(viewMod.v_dmg_roll).toBeCloseTo(55 * -s * 0.6, 4);
    expect(viewMod.v_dmg_pitch).toBeCloseTo(55 * s * 0.6, 4);
  });
});

describe("V_CalcPowerupCshift (qw) -- reads cl.stats[STAT_ITEMS]", () => {
  test("quad", () => {
    cl.items = 0; // WinQuake field must NOT be read under qw.active
    cl.stats[STAT_ITEMS] = IT_QUAD;
    V_CalcPowerupCshift();
    expect(Array.from(cl.cshifts[CSHIFT_POWERUP].destcolor)).toEqual([0, 0, 255]);
    expect(cl.cshifts[CSHIFT_POWERUP].percent).toBe(30);
  });

  test("pentagram (invulnerability)", () => {
    cl.items = 0;
    cl.stats[STAT_ITEMS] = IT_INVULNERABILITY;
    V_CalcPowerupCshift();
    expect(Array.from(cl.cshifts[CSHIFT_POWERUP].destcolor)).toEqual([255, 255, 0]);
    expect(cl.cshifts[CSHIFT_POWERUP].percent).toBe(30);
  });

  test("cl.items alone (WinQuake field) has no effect under qw.active", () => {
    cl.items = IT_QUAD;
    cl.stats[STAT_ITEMS] = 0;
    V_CalcPowerupCshift();
    expect(cl.cshifts[CSHIFT_POWERUP].percent).toBe(0);
  });
});

describe("R_RocketTrail (qw)", () => {
  function countActive(): number {
    let n = 0;
    for (let p = rPartMod.active_particles; p; p = p.next) n++;
    return n;
  }

  test("type 0 (rocket trail) spawns one particle per 3 units of length", () => {
    cl.time = 0;
    const start = vec3(0, 0, 0);
    const end = vec3(30, 0, 0);
    rPartMod.R_RocketTrail(start, end, 0);
    // len=30, decremented by 3 each iteration -> 10 particles
    expect(countActive()).toBe(10);
    for (let p = rPartMod.active_particles; p; p = p.next) {
      expect(p.type).toBe(renderMod.PtypeT.pt_fire);
    }
  });

  test("type 2 (blood) spawns pt_slowgrav particles", () => {
    cl.time = 0;
    rPartMod.R_RocketTrail(vec3(0, 0, 0), vec3(9, 0, 0), 2);
    expect(countActive()).toBe(3);
    for (let p = rPartMod.active_particles; p; p = p.next) {
      expect(p.type).toBe(renderMod.PtypeT.pt_slowgrav);
    }
  });

  test("type 4 (slight blood) decrements len by an extra 3 per particle, so fewer spawn", () => {
    cl.time = 0;
    rPartMod.R_RocketTrail(vec3(0, 0, 0), vec3(30, 0, 0), 4);
    // each iteration: len -= 3 (loop) then len -= 3 again (type 4's own extra)
    expect(countActive()).toBe(5);
  });
});

describe("R_DrawParticles (qw) -- gravity is a literal 800, not movevars.gravity", () => {
  test("pt_grav integrates vel[2] -= frametime*800*0.05, independent of movevars.gravity", () => {
    pmoveTypesMod.movevars.gravity = 12345; // must NOT affect the result (see r_part.ts header)
    cl.time = 10;
    cl.oldtime = 9.9; // WinQuake reads this; qw reads host.frametime instead
    host.frametime = 0.1;

    rPartMod.R_RocketTrail(vec3(0, 0, 0), vec3(3, 0, 0), 0); // spawns 1 pt_fire particle
    const p = rPartMod.active_particles;
    expect(p).not.toBe(null);
    if (!p) throw new Error("expected a particle");
    p.vel[2] = 0;

    rPartMod.R_DrawParticles();

    expect(p.vel[2]).toBeCloseTo(0.1 * 800 * 0.05, 6);
    expect(calls).toContain("D_StartParticles");
    expect(calls).toContain("D_DrawParticle");
    expect(calls).toContain("D_EndParticles");
  });
});
