// Self-sufficient test for src/client/cl_parse.ts (WinQuake cl_parse.c,
// unit U042).
//
// cl_parse.ts imports from ./snd_dma (S_PrecacheSound/S_StartSound/
// S_StopSound/S_StaticSound/S_TouchSound/S_BeginPrecaching/S_EndPrecaching),
// a concurrent unit that has not landed yet. This whole file therefore fails
// to import until snd_dma.ts exists (an acceptable, expected failure -- see
// test/cmd.test.ts's own header for the same situation and the same ruling:
// no bun:test `mock.module` stand-in is used, because its typings need `any`
// under this project's strict gate). It is written against the ruled
// signatures (protocol.h/sound.h) so it runs correctly once snd_dma.ts lands.
//
// Every other sibling cl_parse.ts reaches (cl_main.ts, cl_tent.ts, cl_demo.ts,
// screen.ts, sbar.ts, view.ts, r_part.ts, console.ts) is landed and used for
// real; only a fake Renderer (render.ts's seam) is substituted, the same
// pattern test/client_types.test.ts uses.
//
// This file initializes every global it reads: it builds its own scratch
// -basedir with id1/pak0.pak (gfx/pop.lmp + maps/world.bsp, per
// test/host.test.ts's fixture recipe), calls COM_InitArgv/COM_InitFilesystem/
// COM_CheckRegistered/Mod_Init once in beforeAll, and never depends on
// another test file having run first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop, setStaticRegistered, static_registered } from "../src/common/common";
import { HostEndGame, HostError } from "../src/common/host";
import { Mod_Init, TextureT, setModelLoaderHooks, type ModelLoaderHooks } from "../src/common/model";
import { ClcOpsT, PROTOCOL_VERSION, SU_ITEMS, SU_VIEWHEIGHT, SvcOpsT, U_FRAME, U_MOREBITS, U_ORIGIN1 } from "../src/common/protocol";
import {
  MSG_WriteAngle,
  MSG_WriteByte,
  MSG_WriteChar,
  MSG_WriteCoord,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  SZ_Alloc,
  SZ_Clear,
  SizeBuf,
  net_message,
} from "../src/common/sizebuf";
import { STAT_ACTIVEWEAPON, STAT_AMMO, STAT_CELLS, STAT_HEALTH, STAT_NAILS, STAT_ROCKETS, STAT_SHELLS } from "../src/common/quakedef";
import { sysState } from "../src/platform/sys";
import { sv } from "../src/server/server";

import { ScoreboardT, cl, cl_entities, cl_lightstyle, cl_static_entities, cls } from "../src/client/client";
import { CL_KeepaliveMessage, CL_ParseServerMessage } from "../src/client/cl_parse";
import type { EntityT, ParticleT, Renderer } from "../src/client/render";
import { BOTTOM_RANGE, TOP_RANGE, re } from "../src/client/render";
import { VID_GRADES, VrectT, vid } from "../src/client/vid";
import type { QpicT } from "../src/common/wad";

import { buildBsp, ensureDir } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "cl_parse-test-"));
const baseDir = join(scratchDir, "quake");

// A do-nothing Renderer with a few counters, the same shape
// test/client_types.test.ts's makeFakeRenderer uses.
function makeFakeRenderer(): Renderer & { newMapCalls: number; addEfragsCalls: EntityT[]; translateSkinCalls: number[] } {
  const hooks: ModelLoaderHooks = {
    notexture: new TextureT(),
    textureLoaded(): void {},
    Mod_LoadLighting(): void {},
    Mod_LoadAliasModel(): void {},
    Mod_LoadSpriteModel(): void {},
  };
  return {
    modelHooks: hooks,
    newMapCalls: 0,
    addEfragsCalls: [],
    translateSkinCalls: [],

    R_Init(): void {},
    R_InitTextures(): void {},
    R_InitEfrags(): void {},
    R_RenderView(): void {},
    R_ViewChanged(_pvrect: VrectT, _lineadj: number, _aspect: number): void {},
    R_InitSky(): void {},
    R_AddEfrags(ent: EntityT): void {
      this.addEfragsCalls.push(ent);
    },
    R_RemoveEfrags(): void {},
    R_NewMap(): void {
      this.newMapCalls++;
    },
    R_PushDlights(): void {},

    r_cache_thrash: false,

    D_SurfaceCacheForRes(): number {
      return 0;
    },
    D_FlushCaches(): void {},
    D_DeleteSurfaceCache(): void {},
    D_InitCaches(): void {},
    R_SetVrect(): void {},

    draw_disc: null,

    Draw_Init(): void {},
    Draw_Character(): void {},
    Draw_DebugChar(): void {},
    Draw_Pic(): void {},
    Draw_TransPic(): void {},
    Draw_TransPicTranslate(): void {},
    Draw_ConsoleBackground(): void {},
    Draw_BeginDisc(): void {},
    Draw_EndDisc(): void {},
    Draw_TileClear(): void {},
    Draw_Fill(): void {},
    Draw_FadeScreen(): void {},
    Draw_String(): void {},
    Draw_PicFromWad(): QpicT | null {
      return null;
    },
    Draw_CachePic(): QpicT | null {
      return null;
    },

    D_StartParticles(): void {},
    D_DrawParticle(_p: ParticleT): void {},
    D_EndParticles(): void {},

    V_CalcBlend(): void {},
    V_UpdatePalette(): void {},
    V_DrawCrosshair(): void {},

    R_TranslatePlayerSkin(playernum: number): void {
      this.translateSkinCalls.push(playernum);
    },

    SCR_CalcRefdef(): void {},
    BeginFrame(): void {},
    EndFrame(): void {},
    D_EnableBackBufferAccess(): void {},
    D_DisableBackBufferAccess(): void {},
    D_UpdateRects(): void {},
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

let fakeRenderer: ReturnType<typeof makeFakeRenderer>;

// static_registered (src/common/common.ts) is sticky module state: this
// suite's COM_CheckRegistered() call below sets it from the fixture's
// gfx/pop.lmp, and nothing else in this process resets it afterward
// (rule 15), so save/restore it around the suite ourselves.
const savedStaticRegistered = static_registered;

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));

  // gfx/pop.lmp + maps/world.bsp both inside id1/pak0.pak: a pak is always
  // searched regardless of registered/shareware state (see
  // test/support/dedicated_fixture.ts's and test/model.test.ts's own notes),
  // so this fixture does not depend on COM_CheckRegistered's outcome.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "maps/world.bsp", data: buildBsp() },
  ]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  fakeRenderer = makeFakeRenderer();
  re.current = fakeRenderer;

  // vid.colormap: a synthetic ramp (byte i%256 == i within any 256-byte
  // block) so CL_NewTranslation's translation rows are checkable against
  // exact expected values instead of opaque real game art.
  const colormap = new Uint8Array(VID_GRADES * 256);
  for (let i = 0; i < colormap.length; i++) colormap[i] = i & 0xff;
  vid.colormap = colormap;

  sysState.isDedicated = false;
  SZ_Alloc(cls.message, 1024); // CL_Init's own allocation -- CL_SignonReply writes here
});

afterAll(() => {
  setModelLoaderHooks(null);
  re.current = null;
  rmSync(scratchDir, { recursive: true, force: true });
  // The svc_signonnum test below writes a queued "prespawn" clc_stringcmd
  // into cls.message and nothing clears it afterward, leaking a nonzero
  // cursize into the rest of this bun process (rule 15).
  SZ_Clear(cls.message);
  setStaticRegistered(savedStaticRegistered);
});

// Builds a message via MSG_Write* into a scratch SizeBuf, then copies it
// into net_message the way a received packet would land there, ready for
// MSG_BeginReading()/CL_ParseServerMessage to read back.
function buildMessage(build: (sb: SizeBuf) => void): void {
  const sb = new SizeBuf();
  SZ_Alloc(sb, 8192);
  build(sb);
  net_message.data = new Uint8Array(sb.data);
  net_message.maxsize = sb.maxsize;
  net_message.cursize = sb.cursize;
}

//============================================================================

describe("svc_strings", () => {
  test("35 entries, svc_bad=0 through svc_cutscene=34", () => {
    expect(SvcOpsT.svc_cutscene).toBe(34);
  });
});

describe("CL_ParseServerMessage: svc_serverinfo", () => {
  test("loads maxclients, levelname, and cl.worldmodel from a small precache list", () => {
    const savedSvActive = sv.active;
    sv.active = true; // keeps CL_KeepaliveMessage's per-model call a no-op (see CL_KeepaliveMessage's own tests below)

    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_serverinfo);
      MSG_WriteLong(sb, PROTOCOL_VERSION);
      MSG_WriteByte(sb, 4); // maxclients
      MSG_WriteByte(sb, 0); // gametype: GAME_COOP
      MSG_WriteString(sb, "the slipgate complex");
      MSG_WriteString(sb, "maps/world.bsp"); // model precache 1
      MSG_WriteString(sb, ""); // end of model list
      MSG_WriteString(sb, ""); // end of sound list
    });

    fakeRenderer.newMapCalls = 0;
    CL_ParseServerMessage();

    expect(cl.maxclients).toBe(4);
    expect(cl.scores.length).toBe(4);
    expect(cl.levelname).toBe("the slipgate complex");
    expect(cl.worldmodel).not.toBeNull();
    expect(cl.worldmodel?.name).toBe("maps/world.bsp");
    expect(cl_entities[0].model).toBe(cl.worldmodel);
    expect(fakeRenderer.newMapCalls).toBe(1);

    sv.active = savedSvActive;
  });

  test("bad protocol version leaves cl state untouched beyond CL_ClearState", () => {
    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_serverinfo);
      MSG_WriteLong(sb, PROTOCOL_VERSION + 1);
    });

    CL_ParseServerMessage();

    expect(cl.maxclients).toBe(0); // CL_ClearState ran, but the version check returned before setting it
  });
});

describe("CL_ParseServerMessage: fast update (U_MOREBITS|U_ORIGIN1|U_FRAME)", () => {
  test("updates entity fields and sets forcelink for a never-before-updated entity", () => {
    const num = 50;
    cl_entities[num].clear();
    cl_entities[num].msgtime = 999; // deliberately different from cl.mtime[1] (0)

    const bits = U_MOREBITS | U_ORIGIN1 | U_FRAME;

    buildMessage((sb) => {
      MSG_WriteByte(sb, (bits | 128) & 0xff); // fast-update cmd byte (high bit set)
      MSG_WriteByte(sb, 0); // U_MOREBITS extra byte: no additional high bits
      MSG_WriteByte(sb, num); // entity number (U_LONGENTITY not set)
      MSG_WriteByte(sb, 7); // U_FRAME
      MSG_WriteCoord(sb, 64); // U_ORIGIN1
    });

    CL_ParseServerMessage();

    const ent = cl_entities[num];
    expect(ent.frame).toBe(7);
    expect(ent.forcelink).toBe(true);
    expect(ent.origin[0]).toBeCloseTo(64, 5);
    expect(ent.origin[1]).toBe(0);
    expect(ent.origin[2]).toBe(0);
    expect(ent.colormap).toBe(vid.colormap);
  });
});

describe("CL_ParseServerMessage: svc_clientdata (SU_VIEWHEIGHT|SU_ITEMS)", () => {
  test("updates viewheight, items, and the always-sent stat fields", () => {
    cl.stats.fill(0);
    cl.items = 0;
    cl.viewheight = 0;
    cl.item_gettime.fill(0);
    cl.time = 12.5;

    const bits = SU_VIEWHEIGHT | SU_ITEMS;

    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_clientdata);
      MSG_WriteShort(sb, bits);
      MSG_WriteChar(sb, 20); // SU_VIEWHEIGHT
      MSG_WriteLong(sb, 3); // items (always sent): bits 0 and 1 newly set
      MSG_WriteShort(sb, 55); // health (always sent)
      MSG_WriteByte(sb, 6); // ammo (always sent)
      MSG_WriteByte(sb, 1); // shells
      MSG_WriteByte(sb, 2); // nails
      MSG_WriteByte(sb, 3); // rockets
      MSG_WriteByte(sb, 4); // cells
      MSG_WriteByte(sb, 2); // active weapon selector (standard_quake: used verbatim)
    });

    CL_ParseServerMessage();

    expect(cl.viewheight).toBe(20);
    expect(cl.items).toBe(3);
    expect(cl.item_gettime[0]).toBe(12.5);
    expect(cl.item_gettime[1]).toBe(12.5);
    expect(cl.onground).toBe(false);
    expect(cl.inwater).toBe(false);
    expect(cl.stats[STAT_HEALTH]).toBe(55);
    expect(cl.stats[STAT_AMMO]).toBe(6);
    expect(cl.stats[STAT_SHELLS]).toBe(1);
    expect(cl.stats[STAT_NAILS]).toBe(2);
    expect(cl.stats[STAT_ROCKETS]).toBe(3);
    expect(cl.stats[STAT_CELLS]).toBe(4);
    expect(cl.stats[STAT_ACTIVEWEAPON]).toBe(2);
  });
});

describe("CL_ParseServerMessage: svc_lightstyle", () => {
  test("sets the style's map and length", () => {
    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_lightstyle);
      MSG_WriteByte(sb, 5);
      MSG_WriteString(sb, "aaazzzzz");
    });

    CL_ParseServerMessage();

    expect(cl_lightstyle[5].map).toBe("aaazzzzz");
    expect(cl_lightstyle[5].length).toBe(8);
  });
});

describe("CL_ParseServerMessage: svc_updatename / svc_updatefrags / svc_updatecolors", () => {
  test("updates the scoreboard slot and CL_NewTranslation recomputes its translation rows", () => {
    cl.maxclients = 4;
    cl.scores = [new ScoreboardT(), new ScoreboardT(), new ScoreboardT(), new ScoreboardT()];

    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_updatename);
      MSG_WriteByte(sb, 2);
      MSG_WriteString(sb, "Ranger");

      MSG_WriteByte(sb, SvcOpsT.svc_updatefrags);
      MSG_WriteByte(sb, 2);
      MSG_WriteShort(sb, 7);

      MSG_WriteByte(sb, SvcOpsT.svc_updatecolors);
      MSG_WriteByte(sb, 2);
      MSG_WriteByte(sb, 0x31); // top nibble 3 (0x30), bottom nibble 1 -> bottom<<4 = 0x10
    });

    CL_ParseServerMessage();

    expect(cl.scores[2].name).toBe("Ranger");
    expect(cl.scores[2].frags).toBe(7);
    expect(cl.scores[2].colors).toBe(0x31);

    const t = cl.scores[2].translations;
    // top = 0x30 (48) < 128 -> straight memcpy from source+top
    expect(Array.from(t.subarray(TOP_RANGE, TOP_RANGE + 16))).toEqual(Array.from({ length: 16 }, (_, i) => 48 + i));
    // bottom = 0x10 (16) < 128 -> straight memcpy from source+bottom
    expect(Array.from(t.subarray(BOTTOM_RANGE, BOTTOM_RANGE + 16))).toEqual(Array.from({ length: 16 }, (_, i) => 16 + i));
    // untouched bytes still carry the initial whole-block memcpy from vid.colormap
    expect(t[0]).toBe(0);
    expect(t[200]).toBe(200);
  });
});

describe("CL_ParseServerMessage: svc_setangle", () => {
  test("sets cl.viewangles from three angle bytes", () => {
    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_setangle);
      MSG_WriteAngle(sb, 90);
      MSG_WriteAngle(sb, 45);
      MSG_WriteAngle(sb, 0);
    });

    CL_ParseServerMessage();

    expect(cl.viewangles[0]).toBeCloseTo(90, 5);
    expect(cl.viewangles[1]).toBeCloseTo(45, 5);
    expect(cl.viewangles[2]).toBeCloseTo(0, 5);
  });
});

describe("CL_ParseServerMessage: svc_spawnbaseline / svc_spawnstatic", () => {
  test("svc_spawnbaseline forces cl.num_entities up and fills the baseline", () => {
    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_spawnbaseline);
      MSG_WriteShort(sb, 10); // entity number
      MSG_WriteByte(sb, 0); // modelindex
      MSG_WriteByte(sb, 2); // frame
      MSG_WriteByte(sb, 0); // colormap
      MSG_WriteByte(sb, 0); // skin
      MSG_WriteCoord(sb, 1);
      MSG_WriteAngle(sb, 0);
      MSG_WriteCoord(sb, 2);
      MSG_WriteAngle(sb, 0);
      MSG_WriteCoord(sb, 3);
      MSG_WriteAngle(sb, 0);
    });

    CL_ParseServerMessage();

    expect(cl.num_entities).toBeGreaterThan(10);
    expect(cl_entities[10].baseline.frame).toBe(2);
    expect(cl_entities[10].baseline.origin[0]).toBeCloseTo(1, 5);
    expect(cl_entities[10].baseline.origin[1]).toBeCloseTo(2, 5);
    expect(cl_entities[10].baseline.origin[2]).toBeCloseTo(3, 5);
  });

  test("svc_spawnstatic appends a static entity and calls R_AddEfrags", () => {
    const before = cl.num_statics;
    fakeRenderer.addEfragsCalls = [];

    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_spawnstatic);
      MSG_WriteByte(sb, 0); // modelindex
      MSG_WriteByte(sb, 1); // frame
      MSG_WriteByte(sb, 0); // colormap
      MSG_WriteByte(sb, 0); // skin
      MSG_WriteCoord(sb, 5);
      MSG_WriteAngle(sb, 0);
      MSG_WriteCoord(sb, 6);
      MSG_WriteAngle(sb, 0);
      MSG_WriteCoord(sb, 7);
      MSG_WriteAngle(sb, 0);
    });

    CL_ParseServerMessage();

    expect(cl.num_statics).toBe(before + 1);
    const ent = cl_static_entities[before];
    expect(ent.frame).toBe(1);
    expect(ent.origin[0]).toBeCloseTo(5, 5);
    expect(ent.origin[1]).toBeCloseTo(6, 5);
    expect(ent.origin[2]).toBeCloseTo(7, 5);
    expect(ent.colormap).toBe(vid.colormap);
    expect(fakeRenderer.addEfragsCalls).toEqual([ent]);
  });
});

describe("CL_ParseServerMessage: svc_signonnum", () => {
  test("signon 1 writes clc_stringcmd \"prespawn\" into cls.message", () => {
    cls.signon = 0;
    SZ_Clear(cls.message);

    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_signonnum);
      MSG_WriteByte(sb, 1);
    });

    CL_ParseServerMessage();

    expect(cls.signon).toBe(1);
    const bytes = Array.from(cls.message.data.subarray(0, cls.message.cursize));
    expect(bytes[0]).toBe(ClcOpsT.clc_stringcmd);
    const str = bytes
      .slice(1, -1)
      .map((b) => String.fromCharCode(b))
      .join("");
    expect(str).toBe("prespawn");
    expect(bytes[bytes.length - 1]).toBe(0); // MSG_WriteString's trailing NUL
  });
});

describe("CL_ParseServerMessage: svc_disconnect / bad opcode", () => {
  test("svc_disconnect throws HostEndGame", () => {
    sv.active = false;
    sysState.isDedicated = false;

    buildMessage((sb) => {
      MSG_WriteByte(sb, SvcOpsT.svc_disconnect);
    });

    expect(() => CL_ParseServerMessage()).toThrow(HostEndGame);
  });

  test("an opcode outside svc_strings' range throws HostError (\"Illegible\")", () => {
    sv.active = false;
    sysState.isDedicated = false;

    buildMessage((sb) => {
      MSG_WriteByte(sb, 100); // not a fast update (bit 7 clear), not a valid svc_* value
    });

    let caught: unknown = null;
    try {
      CL_ParseServerMessage();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostError);
    expect((caught as Error).message).toContain("Illegible");
  });
});

describe("CL_KeepaliveMessage", () => {
  test("returns immediately when sv.active is true", () => {
    const saved = sv.active;
    sv.active = true;
    expect(() => CL_KeepaliveMessage()).not.toThrow();
    sv.active = saved;
  });

  test("returns immediately when cls.demoplayback is true", () => {
    const savedActive = sv.active;
    const savedDemo = cls.demoplayback;
    sv.active = false;
    cls.demoplayback = true;
    expect(() => CL_KeepaliveMessage()).not.toThrow();
    sv.active = savedActive;
    cls.demoplayback = savedDemo;
  });
});
