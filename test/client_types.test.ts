import { describe, expect, test } from "bun:test";

import { MAX_EDICTS, MAX_LIGHTSTYLES, MAX_MODELS, MAX_SOUNDS } from "../src/common/quakedef";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import { SysError } from "../src/platform/sys";
import {
  CactiveT,
  cl,
  cl_beams,
  cl_dlights,
  cl_efrags,
  cl_entities,
  cl_lightstyle,
  cl_static_entities,
  cl_temp_entities,
  cl_visedicts,
  clState,
  cls,
  CSHIFT_BONUS,
  CSHIFT_CONTENTS,
  CSHIFT_DAMAGE,
  CSHIFT_POWERUP,
  KbuttonT,
  MAX_BEAMS,
  MAX_DEMOS,
  MAX_DLIGHTS,
  MAX_EFRAGS,
  MAX_STATIC_ENTITIES,
  MAX_TEMP_ENTITIES,
  MAX_VISEDICTS,
  NAME_LENGTH,
  NUM_CSHIFTS,
  SIGNONS,
  ScoreboardT,
} from "../src/client/client";
import {
  BOTTOM_RANGE,
  EntityT,
  ParticleT,
  PtypeT,
  RefdefT,
  getRenderer,
  r_origin,
  r_refdef,
  re,
  TOP_RANGE,
  vpn,
  vright,
  vup,
  type Renderer,
} from "../src/client/render";
import { VID_CBITS, VID_GRADES, ViddefT, VrectT, d_8to16table, d_8to24table, vid, vidBackend, vidMenuHooks } from "../src/client/vid";
import { scrState, scr_vrect } from "../src/client/screen_types";
import { inputBackend } from "../src/client/input";
import { cdAudio } from "../src/client/cdaudio";

// A do-nothing Renderer. Writing it out in full is the compile-time proof that
// the interface in render.ts is implementable and self-consistent: adding a
// member there without a body here fails `bun run check`.
function makeFakeRenderer(): Renderer {
  const hooks: ModelLoaderHooks = {
    notexture: new TextureT(),
    textureLoaded(): void {},
    Mod_LoadLighting(): void {},
    Mod_LoadAliasModel(): void {},
    Mod_LoadSpriteModel(): void {},
  };
  return {
    modelHooks: hooks,

    R_Init(): void {},
    R_InitTextures(): void {},
    R_InitEfrags(): void {},
    R_RenderView(): void {},
    R_ViewChanged(_pvrect: VrectT, _lineadj: number, _aspect: number): void {},
    R_InitSky(_mt: TextureT): void {},
    R_AddEfrags(_ent: EntityT): void {},
    R_RemoveEfrags(_ent: EntityT): void {},
    R_NewMap(): void {},
    R_PushDlights(): void {},

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
    Draw_Character(_x: number, _y: number, _num: number): void {},
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

    V_CalcBlend(): void {},
    V_UpdatePalette(): void {},
    V_DrawCrosshair(): void {},

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
}

describe("client.h constants", () => {
  test("cshift indices and counts match client.h", () => {
    expect(CSHIFT_CONTENTS).toBe(0);
    expect(CSHIFT_DAMAGE).toBe(1);
    expect(CSHIFT_BONUS).toBe(2);
    expect(CSHIFT_POWERUP).toBe(3);
    expect(NUM_CSHIFTS).toBe(4);
    expect(NAME_LENGTH).toBe(64);
    expect(SIGNONS).toBe(4);
    expect(MAX_DLIGHTS).toBe(32);
    expect(MAX_BEAMS).toBe(24);
    expect(MAX_EFRAGS).toBe(640);
    expect(MAX_DEMOS).toBe(8);
    expect(MAX_TEMP_ENTITIES).toBe(64);
    expect(MAX_STATIC_ENTITIES).toBe(128);
    expect(MAX_VISEDICTS).toBe(256);
  });

  test("cactive_t values", () => {
    expect(CactiveT.ca_dedicated).toBe(0);
    expect(CactiveT.ca_disconnected).toBe(1);
    expect(CactiveT.ca_connected).toBe(2);
  });
});

describe("client singletons", () => {
  test("cls starts in ca_dedicated with an empty demo list", () => {
    expect(cls.state).toBe(CactiveT.ca_dedicated);
    expect(cls.demos.length).toBe(MAX_DEMOS);
    expect(cls.demos.every((d) => d === "")).toBe(true);
    expect(cls.netcon).toBe(null);
    expect(cls.demofile).toBe(null);
    expect(cls.message.cursize).toBe(0);
  });

  test("cl's sized fields match the C array bounds", () => {
    expect(cl.stats.length).toBe(32); // MAX_CL_STATS
    expect(cl.item_gettime.length).toBe(32);
    expect(cl.mtime.length).toBe(2);
    expect(cl.cshifts.length).toBe(NUM_CSHIFTS);
    expect(cl.prev_cshifts.length).toBe(NUM_CSHIFTS);
    expect(cl.model_precache.length).toBe(MAX_MODELS);
    expect(cl.sound_precache.length).toBe(MAX_SOUNDS);
    expect(cl.cshifts[0]).not.toBe(cl.cshifts[1]);
    expect(cl.cshifts[0]).not.toBe(cl.prev_cshifts[0]);
    expect(cl.mviewangles[0]).not.toBe(cl.mviewangles[1]);
    expect(cl.mvelocity[0]).not.toBe(cl.mvelocity[1]);
  });

  test("cl.clear() zeroes every mutated field, as memset(&cl,0,sizeof(cl)) does", () => {
    cl.movemessages = 7;
    cl.cmd.forwardmove = 400;
    cl.cmd.viewangles[1] = 90;
    cl.stats[0] = 100;
    cl.items = 0xffff;
    cl.item_gettime[3] = 12.5;
    cl.faceanimtime = 4;
    cl.cshifts[CSHIFT_DAMAGE].percent = 200;
    cl.cshifts[CSHIFT_DAMAGE].destcolor[0] = 255;
    cl.prev_cshifts[CSHIFT_BONUS].percent = 50;
    cl.mviewangles[1][2] = 30;
    cl.viewangles[0] = 12;
    cl.mvelocity[0][1] = -5;
    cl.velocity[2] = 3;
    cl.punchangle[0] = 2;
    cl.idealpitch = 9;
    cl.pitchvel = 1;
    cl.nodrift = true;
    cl.driftmove = 6;
    cl.laststop = 1.5;
    cl.viewheight = 22;
    cl.crouch = -3;
    cl.paused = true;
    cl.onground = true;
    cl.inwater = true;
    cl.intermission = 2;
    cl.completed_time = 88;
    cl.mtime[0] = 3.25;
    cl.mtime[1] = 3.0;
    cl.time = 3.1;
    cl.oldtime = 3.0;
    cl.last_received_message = 99;
    cl.levelname = "the slipgate complex";
    cl.viewentity = 1;
    cl.maxclients = 8;
    cl.gametype = 1;
    cl.num_entities = 40;
    cl.num_statics = 5;
    cl.cdtrack = 4;
    cl.looptrack = 4;
    cl.scores = [new ScoreboardT()];
    cl.viewent.frame = 3;
    cl.viewent.origin[0] = 64;

    cl.clear();

    expect(cl.movemessages).toBe(0);
    expect(cl.cmd.forwardmove).toBe(0);
    expect(cl.cmd.viewangles[1]).toBe(0);
    expect(cl.stats[0]).toBe(0);
    expect(cl.items).toBe(0);
    expect(cl.item_gettime[3]).toBe(0);
    expect(cl.faceanimtime).toBe(0);
    expect(cl.cshifts[CSHIFT_DAMAGE].percent).toBe(0);
    expect(cl.cshifts[CSHIFT_DAMAGE].destcolor[0]).toBe(0);
    expect(cl.prev_cshifts[CSHIFT_BONUS].percent).toBe(0);
    expect(cl.mviewangles[1][2]).toBe(0);
    expect(cl.viewangles[0]).toBe(0);
    expect(cl.mvelocity[0][1]).toBe(0);
    expect(cl.velocity[2]).toBe(0);
    expect(cl.punchangle[0]).toBe(0);
    expect(cl.idealpitch).toBe(0);
    expect(cl.pitchvel).toBe(0);
    expect(cl.nodrift).toBe(false);
    expect(cl.driftmove).toBe(0);
    expect(cl.laststop).toBe(0);
    expect(cl.viewheight).toBe(0);
    expect(cl.crouch).toBe(0);
    expect(cl.paused).toBe(false);
    expect(cl.onground).toBe(false);
    expect(cl.inwater).toBe(false);
    expect(cl.intermission).toBe(0);
    expect(cl.completed_time).toBe(0);
    expect(cl.mtime[0]).toBe(0);
    expect(cl.mtime[1]).toBe(0);
    expect(cl.time).toBe(0);
    expect(cl.oldtime).toBe(0);
    expect(cl.last_received_message).toBe(0);
    expect(cl.levelname).toBe("");
    expect(cl.viewentity).toBe(0);
    expect(cl.maxclients).toBe(0);
    expect(cl.gametype).toBe(0);
    expect(cl.worldmodel).toBe(null);
    expect(cl.free_efrags).toBe(null);
    expect(cl.num_entities).toBe(0);
    expect(cl.num_statics).toBe(0);
    expect(cl.cdtrack).toBe(0);
    expect(cl.looptrack).toBe(0);
    expect(cl.scores.length).toBe(0);
    expect(cl.viewent.frame).toBe(0);
    expect(cl.viewent.origin[0]).toBe(0);
  });
});

describe("client.h data arrays", () => {
  test("array lengths match the C bounds", () => {
    expect(cl_efrags.length).toBe(MAX_EFRAGS);
    expect(cl_entities.length).toBe(MAX_EDICTS);
    expect(cl_static_entities.length).toBe(MAX_STATIC_ENTITIES);
    expect(cl_lightstyle.length).toBe(MAX_LIGHTSTYLES);
    expect(cl_dlights.length).toBe(MAX_DLIGHTS);
    expect(cl_temp_entities.length).toBe(MAX_TEMP_ENTITIES);
    expect(cl_beams.length).toBe(MAX_BEAMS);
    expect(cl_visedicts.length).toBe(MAX_VISEDICTS);
    expect(clState.cl_numvisedicts).toBe(0);
  });

  test("every entity is a distinct object with its own vectors", () => {
    expect(cl_entities[0]).not.toBe(cl_entities[1]);
    expect(cl_entities[0].origin).not.toBe(cl_entities[1].origin);
    expect(cl_entities[0].angles).not.toBe(cl_entities[1].angles);
    expect(cl_entities[0].msg_origins[0]).not.toBe(cl_entities[0].msg_origins[1]);
    expect(cl_entities[0].baseline).not.toBe(cl_entities[1].baseline);

    cl_entities[0].origin[0] = 12;
    expect(cl_entities[1].origin[0]).toBe(0);
    cl_entities[0].origin[0] = 0;

    expect(cl_dlights[0]).not.toBe(cl_dlights[1]);
    expect(cl_dlights[0].origin).not.toBe(cl_dlights[1].origin);
    expect(cl_beams[0].start).not.toBe(cl_beams[1].start);
    expect(cl_efrags[0]).not.toBe(cl_efrags[1]);
    expect(cl_lightstyle[0]).not.toBe(cl_lightstyle[1]);
  });

  test("scoreboard translations are VID_GRADES*256 bytes", () => {
    const sb = new ScoreboardT();
    expect(sb.translations.length).toBe(VID_GRADES * 256);
    expect(new ScoreboardT().translations).not.toBe(sb.translations);
  });

  test("kbutton_t has its own two-slot down array", () => {
    const a = new KbuttonT();
    const b = new KbuttonT();
    expect(a.down.length).toBe(2);
    expect(a.down).not.toBe(b.down);
    expect(a.state).toBe(0);
  });
});

describe("render.h", () => {
  test("TOP_RANGE / BOTTOM_RANGE", () => {
    expect(TOP_RANGE).toBe(16);
    expect(BOTTOM_RANGE).toBe(96);
  });

  test("refdef_t defaults are all zero and its two vrects are distinct", () => {
    const rd = new RefdefT();
    expect(rd.vrect).not.toBe(rd.aliasvrect);
    expect(rd.vrect.x).toBe(0);
    expect(rd.vrect.pnext).toBe(null);
    expect(rd.vrectright).toBe(0);
    expect(rd.vrectbottom).toBe(0);
    expect(rd.aliasvrectright).toBe(0);
    expect(rd.aliasvrectbottom).toBe(0);
    expect(rd.fov_x).toBe(0);
    expect(rd.fov_y).toBe(0);
    expect(rd.ambientlight).toBe(0);
    expect(rd.horizontalFieldOfView).toBe(0);
    expect(rd.vieworg.length).toBe(3);
    expect(rd.viewangles.length).toBe(3);
    expect(rd.vieworg).not.toBe(rd.viewangles);
  });

  test("the r_refdef and view-axis singletons exist and are separate", () => {
    expect(r_refdef).toBeInstanceOf(RefdefT);
    expect(r_origin.length).toBe(3);
    expect(vpn).not.toBe(vright);
    expect(vright).not.toBe(vup);
    expect(vup).not.toBe(r_origin);
  });

  test("entity_t defaults and clear()", () => {
    const e = new EntityT();
    expect(e.forcelink).toBe(false);
    expect(e.model).toBe(null);
    expect(e.efrag).toBe(null);
    expect(e.colormap).toBe(null);
    expect(e.topnode).toBe(null);
    expect(e.msg_origins[0]).not.toBe(e.msg_angles[0]);

    e.forcelink = true;
    e.frame = 5;
    e.syncbase = 1.5;
    e.effects = 3;
    e.angles[1] = 90;
    e.baseline.modelindex = 4;
    e.clear();
    expect(e.forcelink).toBe(false);
    expect(e.frame).toBe(0);
    expect(e.syncbase).toBe(0);
    expect(e.effects).toBe(0);
    expect(e.angles[1]).toBe(0);
    expect(e.baseline.modelindex).toBe(0);
  });

  test("particle_t / ptype_t match d_iface.h", () => {
    expect(PtypeT.pt_static).toBe(0);
    expect(PtypeT.pt_grav).toBe(1);
    expect(PtypeT.pt_slowgrav).toBe(2);
    expect(PtypeT.pt_fire).toBe(3);
    expect(PtypeT.pt_explode).toBe(4);
    expect(PtypeT.pt_explode2).toBe(5);
    expect(PtypeT.pt_blob).toBe(6);
    expect(PtypeT.pt_blob2).toBe(7);
    const p = new ParticleT();
    expect(p.next).toBe(null);
    expect(p.org).not.toBe(p.vel);
    expect(p.type).toBe(PtypeT.pt_static);
  });

  test("getRenderer() errors with no renderer and returns the installed one", () => {
    const saved = re.current;
    re.current = null;
    expect(() => getRenderer()).toThrow(SysError);

    const fake = makeFakeRenderer();
    re.current = fake;
    expect(getRenderer()).toBe(fake);
    // and the interface is callable through the holder
    getRenderer().R_RenderView();
    expect(getRenderer().D_SurfaceCacheForRes(320, 200)).toBe(0);
    expect(getRenderer().Draw_CachePic("gfx/pause.lmp")).toBe(null);

    re.current = saved;
  });
});

describe("vid.h", () => {
  test("VID_CBITS / VID_GRADES", () => {
    expect(VID_CBITS).toBe(6);
    expect(VID_GRADES).toBe(64);
  });

  test("viddef_t defaults", () => {
    const v = new ViddefT();
    expect(v.buffer).toBe(null);
    expect(v.colormap).toBe(null);
    expect(v.colormap16).toBe(null);
    expect(v.direct).toBe(null);
    expect(v.conbuffer).toBe(null);
    expect(v.fullbright).toBe(0);
    expect(v.rowbytes).toBe(0);
    expect(v.width).toBe(0);
    expect(v.height).toBe(0);
    expect(v.aspect).toBe(0);
    expect(v.numpages).toBe(0);
    expect(v.recalc_refdef).toBe(0);
    expect(v.conrowbytes).toBe(0);
    expect(v.conwidth).toBe(0);
    expect(v.conheight).toBe(0);
    expect(v.maxwarpwidth).toBe(0);
    expect(v.maxwarpheight).toBe(0);
  });

  test("the vid singleton and the palette tables", () => {
    expect(vid).toBeInstanceOf(ViddefT);
    expect(d_8to16table.length).toBe(256);
    expect(d_8to24table.length).toBe(256);
    // vidBackend.current cannot be asserted "uninstalled" here: like
    // sndDma.current/cdAudio.current (see main_boot.test.ts's file header),
    // src/platform/vid.ts installs it at module load, and that module is
    // reachable from many other suites' own imports (a renderer module,
    // src/platform/sdl.ts, or src/main.ts) sharing this one bun process --
    // once any of them has loaded, the holder never goes back to null. Assert
    // its shape instead of assuming a pristine, never-imported process.
    expect(vidBackend.current === null || typeof vidBackend.current.VID_Init === "function").toBe(true);
    expect(vidMenuHooks.vid_menudrawfn).toBe(null);
    expect(vidMenuHooks.vid_menukeyfn).toBe(null);
  });

  test("vrect_t is a linkable node", () => {
    const a = new VrectT();
    const b = new VrectT();
    expect(a.pnext).toBe(null);
    a.pnext = b;
    expect(a.pnext).toBe(b);
    a.pnext = null;
  });
});

describe("screen.h data, input.h and cdaudio.h holders", () => {
  test("scrState and scr_vrect start zeroed", () => {
    expect(scr_vrect).toBeInstanceOf(VrectT);
    expect(scrState.scr_con_current).toBe(0);
    expect(scrState.scr_conlines).toBe(0);
    expect(scrState.scr_fullupdate).toBe(0);
    expect(scrState.sb_lines).toBe(0);
    expect(scrState.clearnotify).toBe(0);
    expect(scrState.scr_disabled_for_loading).toBe(false);
    expect(scrState.scr_skipupdate).toBe(false);
    expect(scrState.scr_copytop).toBe(0);
    expect(scrState.scr_copyeverything).toBe(0);
    expect(scrState.block_drawing).toBe(false);
  });

  test("the input and cd audio backends are either uninstalled or a real platform implementation", () => {
    // Same reasoning as vidBackend.current above: src/platform/sdl.ts and
    // src/platform/cd_ogg.ts install inputBackend.current/cdAudio.current at
    // module load (mirrors sndDma.current -- see main_boot.test.ts's file
    // header), and both modules are reachable from many other suites'
    // imports (platform/vid.ts imports platform/sdl.ts; src/main.ts imports
    // both platform/sdl.ts and platform/cd_ogg.ts transitively). Once any
    // suite sharing this bun process has loaded either module, the holder
    // stays installed for the rest of the process, so "uninstalled" is not
    // an assertion this file can make.
    expect(inputBackend.current === null || typeof inputBackend.current.IN_Init === "function").toBe(true);
    expect(cdAudio.current === null || typeof cdAudio.current.CDAudio_Init === "function").toBe(true);
  });
});
