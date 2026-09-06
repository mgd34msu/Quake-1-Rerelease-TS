/*
Self-sufficient test for Q021: src/qw/client/cl_main.ts, cl_parse.ts and
cl_demo.ts (QW/client/cl_main.c, cl_parse.c, cl_demo.c).

Everything this file reads is initialized here, per standing order 13:

- Its own scratch -basedir with id1/ and qw/ (the two directories QW's
  COM_InitFilesystem always adds), built the same way test/qw_common.test.ts
  builds its fixture, plus COM_InitArgv/COM_InitFilesystem in beforeAll.
- `com_searchpaths`/`com_modified` are process-wide singletons shared with
  every WinQuake-track suite (src/qw/common.ts's "one filesystem state"
  note), so beforeEach resets com_searchpaths to null and rebuilds this
  file's own search path, and afterAll restores the module-load default.
- `re.current` gets a do-nothing Renderer (the same fake
  test/cl_parse.test.ts uses) and is restored to null.
- `vid.colormap` gets a synthetic ramp and is restored.
- `net_message`'s data/maxsize/cursize are saved and restored.
- `cl`/`cls`/`movevars`/`msgState`/`clMainState`/`qw.active` are reset by
  this suite before every test and restored afterward.
- `setHostShutdown(null)` is installed for the whole file: Host_Error ends in
  Sys_Error, which invokes the registered host-shutdown callback, and a
  callback another suite left behind would run a real Host_Shutdown (writing
  config.cfg, closing sockets) from inside a test. It is restored to null,
  the module-load default.

Test hygiene rule 15: `S_StartSound` and `NET_SendPacket` are wrapped with
bare call-through `spyOn`s at module scope (real behavior preserved, only
observed); nothing under src/ is `mock.module`'d.

Registry state (Cvar_RegisterVariable / Cmd_AddCommand) is never asserted:
this process also loads the WinQuake client, which registers many of the
same names.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { qw } from "../src/common/quakedef";
import { setComModified, setComSearchpaths } from "../src/common/common";
import { SZ_Alloc, SizeBuf, net_message } from "../src/common/sizebuf";
import { setHostShutdown, SysError } from "../src/platform/sys";
import {
  COM_InitArgv,
  COM_InitFilesystem,
  MSG_BeginReading,
  MSG_WriteByte,
  MSG_WriteCoord,
  MSG_WriteFloat,
  MSG_WriteLong,
  MSG_WriteShort,
  MSG_WriteString,
  com_gamedir,
  msgState,
} from "../src/qw/common";
import { MAX_CL_STATS, STAT_ITEMS } from "../src/qw/bothdefs";
import { Cmd_TokenizeString } from "../src/qw/cmd";
import { qwCmdHooks } from "../src/qw/cmd";
import { PROTOCOL_VERSION, SND_ATTENUATION, SND_VOLUME, SvcOpsT, S2C_CHALLENGE, S2C_CONNECTION } from "../src/qw/protocol";
import { movevars } from "../src/qw/pmove_types";
import { NetadrT, net_from } from "../src/qw/net_udp";
import * as netUdp from "../src/qw/net_udp";
import { Netchan_Setup, netchanState } from "../src/qw/net_chan";

import { CactiveT, cl, cls } from "../src/client/client";
import { re } from "../src/client/render";
import type { EntityT, ParticleT, Renderer } from "../src/client/render";
import { VID_GRADES, VrectT, vid } from "../src/client/vid";
import { TextureT, type ModelLoaderHooks } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import * as sndDma from "../src/client/snd_dma";

import {
  CL_ConnectionlessPacket,
  Host_Error,
  Host_FixupModelNames,
  clMainState,
  modelNames,
} from "../src/qw/client/cl_main";
import {
  CL_ParseDownload,
  CL_ParseModellist,
  CL_ParseServerData,
  CL_ParseSoundlist,
  CL_ParseStartSoundPacket,
  CL_ProcessUserInfo,
  CL_SetStat,
  CL_UpdateUserinfo,
  parseState,
} from "../src/qw/client/cl_parse";
import {
  CL_GetDemoMessage,
  CL_PlayDemo_f,
  CL_Record_f,
  CL_Stop_f,
  CL_WriteDemoMessage,
} from "../src/qw/client/cl_demo";
import { DownloadTypeT } from "../src/qw/client/client";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwcl-parse-test-"));
const baseDir = join(scratchDir, "quake");

const startSoundSpy = spyOn(sndDma, "S_StartSound");
const sendPacketSpy = spyOn(netUdp, "NET_SendPacket");

// This file's header claims cls is "restored afterward", but its own
// afterAll (below) never puts cls.state back -- beforeEach parks it at
// ca_disconnected and individual tests move it to ca_active, so the last
// test to run here leaks that value into the rest of this bun process (rule
// 15). Snapshot captured before any beforeEach/test runs, restored below.
const savedClsState = cls.state;

// A do-nothing Renderer with a few counters, the same shape
// test/cl_parse.test.ts's makeFakeRenderer uses.
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

const savedNetMessage = { data: net_message.data, maxsize: net_message.maxsize, cursize: net_message.cursize };
const savedColormap = vid.colormap;
const savedQwActive = qw.active;

function initFilesystem(): void {
  setComSearchpaths(null);
  setComModified(false);
  COM_InitArgv(["qwcl", "-basedir", baseDir]);
  COM_InitFilesystem();
}

beforeAll(() => {
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  mkdirSync(join(baseDir, "qw"), { recursive: true });

  qw.active = true;
  setHostShutdown(null);

  fakeRenderer = makeFakeRenderer();
  re.current = fakeRenderer;

  const colormap = new Uint8Array(VID_GRADES * 256);
  for (let i = 0; i < colormap.length; i++) colormap[i] = i & 0xff;
  vid.colormap = colormap;

  // net_message is a shared singleton; NET_Init (never called here) is what
  // normally hands it a buffer.
  net_message.data = new Uint8Array(8192);
  net_message.maxsize = 8192;
  net_message.cursize = 0;

  // the five obfuscated command names are XORed at rest and decoded once by
  // Host_Init; this suite reads soundlist/modellist/prespawn through them.
  // The XOR is its own inverse and modelNames is a shared singleton across
  // every test file in this bun process (rule 15) -- guarded, per
  // test/qwcl_render.test.ts's own precedent, so running after another suite
  // that already fixed it up doesn't re-XOR it back to gibberish.
  if (modelNames.soundlist_name !== "soundlist %i %i") Host_FixupModelNames();
});

afterAll(() => {
  re.current = null;
  vid.colormap = savedColormap;
  net_message.data = savedNetMessage.data;
  net_message.maxsize = savedNetMessage.maxsize;
  net_message.cursize = savedNetMessage.cursize;
  qw.active = savedQwActive;
  setHostShutdown(null);
  setComSearchpaths(null);
  setComModified(false);
  startSoundSpy.mockRestore();
  sendPacketSpy.mockRestore();
  rmSync(scratchDir, { recursive: true, force: true });
  cls.state = savedClsState;
});

beforeEach(() => {
  initFilesystem();

  cl.clear();
  cl.qw.clear();

  cls.state = CactiveT.ca_disconnected;
  cls.demoplayback = false;
  cls.demorecording = false;
  cls.timedemo = false;
  cls.demofile = null;
  cls.demonum = -1;
  cls.td_lastframe = 0;
  cls.td_startframe = 0;
  cls.td_starttime = 0;
  cls.qw.userinfo = "";
  cls.qw.servername = "";
  cls.qw.download = null;
  cls.qw.downloadname = "";
  cls.qw.downloadtempname = "";
  cls.qw.downloadnumber = 0;
  cls.qw.downloadtype = DownloadTypeT.dl_none;
  cls.qw.downloadpercent = 0;
  cls.qw.challenge = 0;
  cls.qw.qport = 0;
  cls.qw.latency = 0;

  clMainState.realtime = 0;
  clMainState.oldrealtime = 0;
  clMainState.host_framecount = 0;
  clMainState.host_frametime = 0;
  clMainState.host_initialized = false;
  clMainState.host_hunklevel = 0;
  clMainState.connect_time = -1;
  clMainState.server_version = 0;
  netchanState.realtime = 0;

  parseState.oldparsecountmod = 0;
  parseState.parsecountmod = 0;
  parseState.parsecounttime = 0;
  parseState.cl_spikeindex = 0;
  parseState.cl_playerindex = 0;
  parseState.cl_flagindex = 0;

  movevars.gravity = 0;
  movevars.stopspeed = 0;
  movevars.maxspeed = 0;
  movevars.spectatormaxspeed = 0;
  movevars.accelerate = 0;
  movevars.airaccelerate = 0;
  movevars.wateraccelerate = 0;
  movevars.friction = 0;
  movevars.waterfriction = 0;
  movevars.entgravity = 0;

  net_from.ip.set([0, 0, 0, 0]);
  net_from.port = 0;
  Netchan_Setup(cls.qw.netchan, new NetadrT(), 0);
  qwCmdHooks.netchanMessage = cls.qw.netchan.message;

  startSoundSpy.mockClear();
  sendPacketSpy.mockClear();

  msgState.readcount = 0;
  msgState.badread = false;
});

// Builds a message via MSG_Write* into a scratch SizeBuf, then copies it
// into net_message the way a received packet would land there, ready for
// MSG_BeginReading() and a parse function to read back.
function buildMessage(build: (sb: SizeBuf) => void): void {
  const sb = new SizeBuf();
  SZ_Alloc(sb, 8192);
  build(sb);
  net_message.data.fill(0);
  net_message.data.set(sb.data.subarray(0, sb.cursize));
  net_message.cursize = sb.cursize;
  MSG_BeginReading();
}

// cls.state is narrowed by TS after an assignment in the same test body;
// reading it through a widened accessor keeps the expectations comparable
// against any CactiveT member.
function clsState(): CactiveT {
  return cls.state;
}

function netchanText(): string {
  const m = cls.qw.netchan.message;
  let s = "";
  for (let i = 0; i < m.cursize; i++) s += String.fromCharCode(m.data[i]);
  return s;
}

//============================================================================

describe("CL_ParseServerData", () => {
  test("fills cl/cl.qw/movevars and switches gamedir", () => {
    buildMessage((sb) => {
      MSG_WriteLong(sb, PROTOCOL_VERSION);
      MSG_WriteLong(sb, 4242); // servercount
      MSG_WriteString(sb, "fortress"); // gamedir
      MSG_WriteByte(sb, 3 | 128); // playernum, high bit = spectator
      MSG_WriteString(sb, "The Abandoned Base");
      MSG_WriteFloat(sb, 800); // gravity
      MSG_WriteFloat(sb, 100); // stopspeed
      MSG_WriteFloat(sb, 320); // maxspeed
      MSG_WriteFloat(sb, 500); // spectatormaxspeed
      MSG_WriteFloat(sb, 10); // accelerate
      MSG_WriteFloat(sb, 0.7); // airaccelerate
      MSG_WriteFloat(sb, 10); // wateraccelerate
      MSG_WriteFloat(sb, 4); // friction
      MSG_WriteFloat(sb, 4); // waterfriction
      MSG_WriteFloat(sb, 1); // entgravity
    });

    CL_ParseServerData();

    expect(cl.qw.servercount).toBe(4242);
    expect(cl.qw.playernum).toBe(3);
    expect(cl.qw.spectator).toBe(1);
    expect(cl.levelname).toBe("The Abandoned Base");

    expect(movevars.gravity).toBe(800);
    expect(movevars.stopspeed).toBe(100);
    expect(movevars.maxspeed).toBe(320);
    expect(movevars.spectatormaxspeed).toBe(500);
    expect(movevars.accelerate).toBe(10);
    expect(movevars.airaccelerate).toBeCloseTo(0.7, 5);
    expect(movevars.wateraccelerate).toBe(10);
    expect(movevars.friction).toBe(4);
    expect(movevars.waterfriction).toBe(4);
    expect(movevars.entgravity).toBe(1);

    expect(clsState()).toBe(CactiveT.ca_onserver);

    // COM_Gamedir switched the shared filesystem state
    expect(com_gamedir).toBe(`${baseDir}/fortress`);

    // and it asked for the sound list
    expect(netchanText()).toContain(`soundlist 4242 0`);
  });
});

describe("CL_ParseSoundlist / CL_ParseModellist", () => {
  test("soundlist stores names and requests the continuation when n != 0", () => {
    cl.qw.servercount = 7;
    buildMessage((sb) => {
      MSG_WriteByte(sb, 0); // numsounds so far
      MSG_WriteString(sb, "items/itembk2.wav");
      MSG_WriteString(sb, "weapons/r_exp3.wav");
      MSG_WriteString(sb, ""); // end of this batch
      MSG_WriteByte(sb, 2); // continuation index
    });

    CL_ParseSoundlist();

    expect(cl.qw.sound_name[1]).toBe("items/itembk2.wav");
    expect(cl.qw.sound_name[2]).toBe("weapons/r_exp3.wav");
    expect(netchanText()).toContain("soundlist 7 2");
  });

  test("modellist stores names, notes the default indexes, and continues", () => {
    cl.qw.servercount = 9;
    buildMessage((sb) => {
      MSG_WriteByte(sb, 0);
      MSG_WriteString(sb, "maps/e1m1.bsp");
      MSG_WriteString(sb, "progs/player.mdl");
      MSG_WriteString(sb, "progs/spike.mdl");
      MSG_WriteString(sb, "progs/flag.mdl");
      MSG_WriteString(sb, "");
      MSG_WriteByte(sb, 4);
    });

    CL_ParseModellist();

    expect(cl.qw.model_name[1]).toBe("maps/e1m1.bsp");
    expect(parseState.cl_playerindex).toBe(2);
    expect(parseState.cl_spikeindex).toBe(3);
    expect(parseState.cl_flagindex).toBe(4);
    expect(netchanText()).toContain("modellist 9 4");
  });

  test("the obfuscated command names decode to the real ones", () => {
    expect(modelNames.soundlist_name).toBe("soundlist %i %i");
    expect(modelNames.modellist_name).toBe("modellist %i %i");
    expect(modelNames.prespawn_name).toBe("prespawn %i 0 %i");
    expect(modelNames.emodel_name).toBe("emodel");
    expect(modelNames.pmodel_name).toBe("pmodel");
  });
});

describe("CL_ParseStartSoundPacket", () => {
  test("decodes entity, channel, volume and attenuation", () => {
    const ent = 42;
    const channel = 3;
    buildMessage((sb) => {
      MSG_WriteShort(sb, SND_VOLUME | SND_ATTENUATION | (ent << 3) | channel);
      MSG_WriteByte(sb, 128); // volume
      MSG_WriteByte(sb, 64); // attenuation * 64
      MSG_WriteByte(sb, 5); // sound_num
      MSG_WriteCoord(sb, 16);
      MSG_WriteCoord(sb, -32);
      MSG_WriteCoord(sb, 8);
    });

    CL_ParseStartSoundPacket();

    expect(startSoundSpy).toHaveBeenCalledTimes(1);
    const args = startSoundSpy.mock.calls[0];
    expect(args[0]).toBe(ent);
    expect(args[1]).toBe(channel);
    expect(args[2]).toBe(null); // cl.sound_precache[5]
    expect(Array.from(args[3])).toEqual([16, -32, 8]);
    expect(args[4]).toBeCloseTo(128 / 255, 6);
    expect(args[5]).toBe(1);
  });

  test("defaults volume and attenuation when the bits are absent", () => {
    buildMessage((sb) => {
      MSG_WriteShort(sb, (1 << 3) | 0);
      MSG_WriteByte(sb, 2); // sound_num
      MSG_WriteCoord(sb, 0);
      MSG_WriteCoord(sb, 0);
      MSG_WriteCoord(sb, 0);
    });

    CL_ParseStartSoundPacket();

    const args = startSoundSpy.mock.calls[0];
    expect(args[4]).toBeCloseTo(255 / 255, 6);
    expect(args[5]).toBe(1);
  });
});

describe("CL_UpdateUserinfo / CL_ProcessUserInfo", () => {
  test("svc_updateuserinfo fills cl.qw.players[slot]", () => {
    buildMessage((sb) => {
      MSG_WriteByte(sb, 2); // slot
      MSG_WriteLong(sb, 8675309); // userid
      MSG_WriteString(sb, "\\name\\ranger\\topcolor\\3\\bottomcolor\\11");
    });

    CL_UpdateUserinfo();

    const p = cl.qw.players[2];
    expect(p.userid).toBe(8675309);
    expect(p.name).toBe("ranger");
    expect(p.topcolor).toBe(3);
    expect(p.bottomcolor).toBe(11);
    expect(p.spectator).toBe(0);
    expect(fakeRenderer.translateSkinCalls).toContain(2);
  });

  test("CL_ProcessUserInfo marks spectators from *spectator", () => {
    const p = cl.qw.players[5];
    p.userinfo = "\\name\\watcher\\*spectator\\1";
    CL_ProcessUserInfo(5, p);
    expect(p.name).toBe("watcher");
    expect(p.spectator).toBe(1);
  });
});

describe("CL_SetStat", () => {
  test("stores the value and latches item flash times for STAT_ITEMS", () => {
    cl.time = 3.5;
    CL_SetStat(STAT_ITEMS, (1 << 0) | (1 << 2));
    expect(cl.stats[STAT_ITEMS]).toBe(5);
    expect(cl.item_gettime[0]).toBeCloseTo(3.5, 5);
    expect(cl.item_gettime[2]).toBeCloseTo(3.5, 5);
    expect(cl.item_gettime[1]).toBe(0);

    // only newly set bits get a fresh time
    cl.time = 7.25;
    CL_SetStat(STAT_ITEMS, (1 << 0) | (1 << 3));
    expect(cl.item_gettime[0]).toBeCloseTo(3.5, 5);
    expect(cl.item_gettime[3]).toBeCloseTo(7.25, 5);
  });

  test("a non-item stat just stores", () => {
    CL_SetStat(1, 99);
    expect(cl.stats[1]).toBe(99);
    expect(MAX_CL_STATS).toBeGreaterThan(1);
  });
});

describe("CL_ConnectionlessPacket", () => {
  test("S2C_CHALLENGE records the challenge and sends a connect packet", () => {
    cls.qw.servername = "127.0.0.1:27500";
    cls.state = CactiveT.ca_disconnected;

    buildMessage((sb) => {
      MSG_WriteLong(sb, -1);
      MSG_WriteByte(sb, S2C_CHALLENGE.charCodeAt(0));
      MSG_WriteString(sb, "1234");
    });

    CL_ConnectionlessPacket();

    expect(cls.qw.challenge).toBe(1234);
    expect(sendPacketSpy).toHaveBeenCalledTimes(1);
    const call = sendPacketSpy.mock.calls[0];
    const bytes = call[1];
    expect(Array.from(bytes.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    let text = "";
    for (let i = 4; i < call[0]; i++) text += String.fromCharCode(bytes[i]);
    expect(text.startsWith(`connect ${PROTOCOL_VERSION} `)).toBe(true);
    expect(text).toContain("1234");
  });

  test("S2C_CONNECTION sets up the netchan and goes to ca_connected", () => {
    cls.state = CactiveT.ca_disconnected;
    net_from.ip.set([127, 0, 0, 1]);
    net_from.port = 27500;

    buildMessage((sb) => {
      MSG_WriteLong(sb, -1);
      MSG_WriteByte(sb, S2C_CONNECTION.charCodeAt(0));
    });

    CL_ConnectionlessPacket();

    expect(clsState()).toBe(CactiveT.ca_connected);
    expect(qwCmdHooks.netchanMessage).toBe(cls.qw.netchan.message);
    expect(netchanText()).toContain("new");
    expect(cls.qw.netchan.remote_address.port).toBe(27500);
  });

  test("a duplicate connection while already connected is ignored", () => {
    cls.state = CactiveT.ca_active;
    const before = cls.qw.netchan.message.cursize;

    buildMessage((sb) => {
      MSG_WriteLong(sb, -1);
      MSG_WriteByte(sb, S2C_CONNECTION.charCodeAt(0));
    });

    CL_ConnectionlessPacket();

    expect(clsState()).toBe(CactiveT.ca_active);
    expect(cls.qw.netchan.message.cursize).toBe(before);
  });
});

describe("CL_ParseDownload", () => {
  test("writes a .tmp file and renames it when the transfer completes", () => {
    const dir = join(baseDir, "qw");
    const finalPath = join(dir, "sound/newsound.wav");
    const tmpPath = join(dir, "sound/newsound.tmp");
    rmSync(join(dir, "sound"), { recursive: true, force: true });

    cls.qw.downloadname = "sound/newsound.wav";
    cls.qw.downloadtempname = "sound/newsound.tmp";
    cls.qw.downloadtype = DownloadTypeT.dl_single;

    const first = new Uint8Array([1, 2, 3, 4]);
    buildMessage((sb) => {
      MSG_WriteShort(sb, first.length);
      MSG_WriteByte(sb, 50); // percent
      for (const b of first) MSG_WriteByte(sb, b);
    });

    CL_ParseDownload();

    expect(cls.qw.downloadpercent).toBe(50);
    expect(cls.qw.download).not.toBe(null);
    expect(netchanText()).toContain("nextdl");
    expect(existsSync(tmpPath)).toBe(true);

    const second = new Uint8Array([5, 6]);
    buildMessage((sb) => {
      MSG_WriteShort(sb, second.length);
      MSG_WriteByte(sb, 100);
      for (const b of second) MSG_WriteByte(sb, b);
    });

    CL_ParseDownload();

    expect(cls.qw.download).toBe(null);
    expect(cls.qw.downloadpercent).toBe(0);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(true);
    expect(Array.from(readFileSync(finalPath))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("demo record / playback round trip", () => {
  test("CL_WriteDemoMessage messages come back out of CL_GetDemoMessage", () => {
    cls.state = CactiveT.ca_active;
    cl.qw.servercount = 11;
    clMainState.realtime = 5.5;

    Cmd_TokenizeString("record roundtrip");
    CL_Record_f();
    expect(cls.demorecording).toBe(true);

    const payloadA = new SizeBuf();
    SZ_Alloc(payloadA, 64);
    MSG_WriteByte(payloadA, SvcOpsT.svc_nop);
    MSG_WriteByte(payloadA, SvcOpsT.svc_setpause);
    MSG_WriteByte(payloadA, 1);
    CL_WriteDemoMessage(payloadA);

    const payloadB = new SizeBuf();
    SZ_Alloc(payloadB, 64);
    MSG_WriteByte(payloadB, SvcOpsT.svc_killedmonster);
    MSG_WriteByte(payloadB, SvcOpsT.svc_foundsecret);
    CL_WriteDemoMessage(payloadB);

    CL_Stop_f();
    expect(cls.demorecording).toBe(false);

    // play it back: at ca_demostart every call grabs the next message and
    // warps realtime to that message's demotime.
    clMainState.realtime = 0;
    Cmd_TokenizeString("playdemo roundtrip");
    CL_PlayDemo_f();
    expect(cls.demoplayback).toBe(true);
    expect(clsState()).toBe(CactiveT.ca_demostart);

    const messages: number[][] = [];
    const times: number[] = [];
    for (let guard = 0; guard < 200 && cls.demoplayback; guard++) {
      if (!CL_GetDemoMessage()) break;
      messages.push(Array.from(net_message.data.subarray(0, net_message.cursize)));
      times.push(clMainState.realtime);
    }

    const wantA = [SvcOpsT.svc_nop, SvcOpsT.svc_setpause, 1];
    const wantB = [SvcOpsT.svc_killedmonster, SvcOpsT.svc_foundsecret];
    const idxA = messages.findIndex((m) => m.length === wantA.length && m.every((v, i) => v === wantA[i]));
    const idxB = messages.findIndex((m) => m.length === wantB.length && m.every((v, i) => v === wantB[i]));

    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBe(idxA + 1);
    // every record carries the realtime it was written at
    expect(times[idxA]).toBeCloseTo(5.5, 4);
    expect(times[idxB]).toBeCloseTo(5.5, 4);

    if (cls.demofile !== null) {
      cls.demoplayback = false;
      cls.demofile = null;
    }
  });
});

describe("Host_Error", () => {
  test("throws after disconnecting and stopping the demo loop", () => {
    cls.demonum = 3;
    let thrown: unknown = null;
    try {
      Host_Error("test %s %i", "failure", 7);
    } catch (err) {
      thrown = err;
    }
    // QW's Host_Error is fatal (it ends in Sys_Error), unlike WinQuake's
    // longjmp-based one -- see src/qw/client/cl_main.ts's file header.
    expect(thrown).toBeInstanceOf(SysError);
    expect(String(thrown)).toContain("test failure 7");
    expect(cls.demonum).toBe(-1);
    expect(clsState()).toBe(CactiveT.ca_disconnected);
  });
});
