/*
Self-sufficient test for Q024: the QuakeWorld `qw.active` deltas folded into
the WinQuake renderer/sound/cd/common modules (src/ref_soft/*, src/ref_gl/*,
src/common/{model,zone,mathlib}.ts, src/client/{snd_dma,snd_mem,cdaudio}.ts,
src/platform/cd_ogg.ts) plus the new src/ref_gl/gl_ngraph.ts.

Per standing order 13, everything this file reads is initialized here:
- Its own scratch `-basedir` with `id1/` and `qw/` (COM_InitFilesystem's two
  required directories), built the same way test/qwcl_parse.test.ts builds
  its own fixture, torn down in afterAll.
- `qw.active` is toggled per-describe-block (never left mutated across
  blocks) and restored to its module-load value in the outermost afterAll.
- `cl`/`cls`/`cl_entities[0]`/`re.current` are snapshotted before this file's
  tests run and restored afterward; nothing is assumed left clean by another
  suite (this suite does not assume it runs first or alone).
- GL tests install a fresh `QGLRecording` (test/ref_gl_draw.test.ts's own
  established pattern) as `qglHolder.current` and restore the prior value.
- `Con_Printf`/`Draw_Character` are wrapped with bare call-through `spyOn`s
  (test hygiene rule 15: call-through only, restored in afterAll).

`ref_soft.ts`'s `V_DrawCrosshair` now routes into `draw.ts`'s
`Draw_Crosshair` under `qw.active` (and `ref_gl.ts`'s `SCR_DrawCrosshair`
into `gl_draw.ts`'s); both branches of the software one are asserted below.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { qw } from "../src/common/quakedef";
import { COM_InitArgv, COM_InitFilesystem, com_filesize, setComFilesize, setComModified, setComSearchpaths } from "../src/common/common";
import { Memory_Init, Z_Print } from "../src/common/zone";
import { ModelT, ModtypeT } from "../src/common/model";
import { CRC_Block } from "../src/common/crc";

import { cl, cls, cl_entities } from "../src/client/client";
import { CactiveT } from "../src/client/client";
import * as consoleModule from "../src/client/console";
import { crosshair, cl_crossx, cl_crossy, crosshaircolor } from "../src/client/view";
import { scr_vrect } from "../src/client/screen_types";
import { sysState } from "../src/platform/sys";
import { SysError } from "../src/platform/sys";
import { re, type Renderer } from "../src/client/render";
import { QpicT } from "../src/common/wad";

import { modelNames, Host_FixupModelNames } from "../src/qw/client/cl_main";
import { Info_ValueForKey } from "../src/qw/common";
import { NetchanT } from "../src/qw/net_chan";
import { CL_CalcNet } from "../src/qw/client/cl_parse";

import * as drawModule from "../src/ref_soft/draw";
import { Draw_Crosshair as Draw_Crosshair_Soft } from "../src/ref_soft/draw";
import { R_BuildLightMap, r_drawsurf, blocklights } from "../src/ref_soft/r_surf";
import { R_AliasSetupSkin } from "../src/ref_soft/r_alias";
import { r_affinetridesc } from "../src/ref_soft/d_iface";
import { rState } from "../src/ref_soft/r_shared";
import { AliashdrT, MaliasskindescT } from "../src/ref_soft/model_types";
import { AliasskintypeT, MdlT } from "../src/common/modelgen";
import { EntityT } from "../src/client/render";
import { PlayerInfoT } from "../src/qw/client/client";
import { r_fullbright, r_origin, r_refdef } from "../src/client/render";
import { DlightT } from "../src/client/client";
import { VID_CBITS } from "../src/client/vid";
import { Mod_LoadAliasModel as Mod_LoadAliasModel_Soft } from "../src/ref_soft/model";

import { Draw_Crosshair as Draw_Crosshair_GL } from "../src/ref_gl/gl_draw";
import { QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { R_NetGraph, ngraphState } from "../src/ref_gl/gl_ngraph";
import { R_TranslatePlayerSkin } from "../src/ref_gl/gl_rmisc";
import { R_InitBubble, R_RenderDlight } from "../src/ref_gl/gl_rlight";
import { cnttextures, glState } from "../src/ref_gl/glquake";
import { Mod_LoadAliasModel as Mod_LoadAliasModel_GL } from "../src/ref_gl/gl_model";

import { CDAudio_Init } from "../src/platform/cd_ogg";
import { SND_Spatialize } from "../src/client/snd_dma";
import type { ChannelT } from "../src/client/sound";

const baseDir = mkdtempSync(join(tmpdir(), "qwcl-render-"));
const savedQwActive = qw.active;
const savedRenderer = re.current;
// The GL describe blocks below (R_NetGraph, Draw_Crosshair GL,
// R_RenderDlight, R_TranslatePlayerSkin, R_AliasSetupSkin) call real
// GL_Bind/GL_LoadTexture-shaped code that mutates src/ref_gl/glquake.ts's
// process-wide `glState` (currenttexture, texture_extension_number,
// playertextures, ...) and `cnttextures` (GL_SelectTexture's per-unit
// cache) in place; nothing else in this file restores them (rule 15).
const savedGlState = { ...glState };
const savedCntTextures = Array.from(cnttextures);

function initFilesystem(): void {
  setComSearchpaths(null);
  setComModified(false);
  COM_InitArgv(["qwcl-render-test", "-basedir", baseDir]);
  COM_InitFilesystem();
}

beforeAll(() => {
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  mkdirSync(join(baseDir, "qw"), { recursive: true });
  initFilesystem();
  // modelNames.pmodel_name/emodel_name are XORed at rest and decoded once by
  // Host_Init in the real engine (test/qwcl_parse.test.ts's own established
  // precedent for this exact call). The XOR is its own inverse and this is a
  // shared singleton across every test file in the process (bun runs the
  // whole suite in one module registry, rule 15) -- guard so running after
  // another suite that already fixed it up doesn't re-XOR it back to gibberish.
  if (modelNames.pmodel_name !== "pmodel") Host_FixupModelNames();
});

afterAll(() => {
  qw.active = savedQwActive;
  re.current = savedRenderer;
  Object.assign(glState, savedGlState);
  cnttextures.set(savedCntTextures);
  setComSearchpaths(null);
  setComModified(false);
  rmSync(baseDir, { recursive: true, force: true });
});

//=============================================================================
// gl_ngraph.ts: R_NetGraph's data-preparation half (packet_latency -> texel
// rows -> the qglTexImage2D payload). No real GL context under SDL dummy, so
// this only asserts the texture upload's *pixel data*, not GL_Bind's effect.
//=============================================================================

describe("gl_ngraph.ts R_NetGraph (QW gl_ngraph.c, new file)", () => {
  let rec: QGLRecording;
  const savedNetchan = cls.qw.netchan;
  const savedRe = re.current;

  beforeAll(() => {
    qw.active = true;
    rec = new QGLRecording();
    SetQGL(rec);
    // R_NetGraph calls menu.ts's M_DrawTextBox, which needs a renderer for
    // Draw_CachePic ("gfx/box_*.lmp"); a synthetic 8x8 QpicT is enough --
    // this test asserts the qgl-recorded texture upload, not the text box.
    re.current = makeMinimalRenderer();
    cls.qw.netchan = new NetchanT();
    cls.qw.netchan.outgoing_sequence = 10;

    // CL_CalcNet walks exactly UPDATE_BACKUP (64) consecutive sequence
    // numbers ending at outgoing_sequence, indexing cl.qw.frames[i &
    // UPDATE_MASK] -- since UPDATE_MASK is 63 and cl.qw.frames.length is 64,
    // that span touches every element of the ring exactly once regardless of
    // outgoing_sequence's value.
    for (let idx = 0; idx < cl.qw.frames.length; idx++) {
      const frame = cl.qw.frames[idx];
      frame.receivedtime = 0;
      frame.senttime = 0;
      frame.invalid = false;
    }
    // sequence 10 (this frame, 10 & 63 === 10): a normal, fast round trip.
    cl.qw.frames[10].senttime = 1.0;
    cl.qw.frames[10].receivedtime = 1.02;
    // sequence 9 (9 & 63 === 9): receivedtime === -1 is CL_CalcNet's
    // "dropped" case (packet_latency 9999, counted as lost).
    cl.qw.frames[9].senttime = 1.0;
    cl.qw.frames[9].receivedtime = -1;
  });

  afterAll(() => {
    SetQGL(null);
    cls.qw.netchan = savedNetchan;
    re.current = savedRe;
  });

  beforeEach(() => rec.clear());

  test("uploads a NET_TIMINGS x NET_GRAPHHEIGHT RGBA texture reflecting packet_latency", () => {
    CL_CalcNet(); // populates packet_latency[] from cl.qw.frames, per QW cl_parse.c
    R_NetGraph();

    const upload = rec.calls.find((c) => c.name === "qglTexImage2D");
    expect(upload).toBeDefined();
    if (!upload) return;
    // (target, level, internalformat, width, height, border, format, type, pixels)
    expect(upload.args[3]).toBe(256); // NET_TIMINGS
    expect(upload.args[4]).toBe(32); // NET_GRAPHHEIGHT
    const pixels = upload.args[8];
    expect(pixels).toBeInstanceOf(Uint32Array);
  });

  test("binds the reserved netgraph texture slot and draws one textured quad", () => {
    // GL_Bind (gl_draw.ts) memoizes glState.currenttexture and skips a
    // redundant qglBindTexture if that texture is already "bound" -- force a
    // miss so this test observes the bind, the way a real frame's prior draw
    // call (a different texture) would.
    const savedCurrentTexture = glState.currenttexture;
    glState.currenttexture = -1;

    CL_CalcNet();
    R_NetGraph();

    const bound = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(bound.length).toBeGreaterThan(0);
    expect(bound[bound.length - 1]?.args[1]).toBe(ngraphState.texture);

    // gl_ngraph.ts's R_NetGraph calls gl_draw.ts's real Draw_String (not the
    // fake renderer's no-op -- it's imported directly, not through the
    // Renderer interface) BEFORE its own texture upload/quad, and Draw_String
    // may itself draw one quad per character. Isolate the calls after the
    // upload to look at only R_NetGraph's own final quad.
    const uploadIdx = rec.calls.findIndex((c) => c.name === "qglTexImage2D");
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    const afterUpload = rec.calls.slice(uploadIdx + 1);

    const begins = afterUpload.filter((c) => c.name === "qglBegin");
    const ends = afterUpload.filter((c) => c.name === "qglEnd");
    expect(begins.length).toBe(1);
    expect(ends.length).toBe(1);
    const verts = afterUpload.filter((c) => c.name === "qglVertex2f");
    expect(verts.length).toBe(4); // one GL_QUADS quad

    glState.currenttexture = savedCurrentTexture;
  });
});

//=============================================================================
// draw.ts / gl_draw.ts: Draw_Crosshair position math (QW draw.c/gl_draw.c,
// new function).
//=============================================================================

describe("Draw_Crosshair (QW draw.c / gl_draw.c, new function)", () => {
  const savedCrosshair = crosshair.value;
  const savedCrossx = cl_crossx.value;
  const savedCrossy = cl_crossy.value;
  const savedCrosshaircolor = crosshaircolor.value;
  const savedVrect = { x: scr_vrect.x, y: scr_vrect.y, width: scr_vrect.width, height: scr_vrect.height };

  beforeAll(() => {
    scr_vrect.x = 0;
    scr_vrect.y = 0;
    scr_vrect.width = 320;
    scr_vrect.height = 200;
  });

  afterAll(() => {
    crosshair.value = savedCrosshair;
    cl_crossx.value = savedCrossx;
    cl_crossy.value = savedCrossy;
    crosshaircolor.value = savedCrosshaircolor;
    scr_vrect.x = savedVrect.x;
    scr_vrect.y = savedVrect.y;
    scr_vrect.width = savedVrect.width;
    scr_vrect.height = savedVrect.height;
  });

  test("soft: crosshair.value 1 draws a '+' Draw_Character offset by cl_crossx/cl_crossy", () => {
    const spy = spyOn(drawModule, "Draw_Character");
    crosshair.value = 1;
    cl_crossx.value = 5;
    cl_crossy.value = -3;

    Draw_Crosshair_Soft();

    expect(spy).toHaveBeenCalledTimes(1);
    const [x, y, num] = spy.mock.calls[0] as [number, number, number];
    expect(x).toBe(0 + 160 - 4 + 5);
    expect(y).toBe(0 + 100 - 4 + (-3));
    expect(num).toBe("+".charCodeAt(0));
    spy.mockRestore();
  });

  test("soft: crosshair.value 2 draws 8 colored pixels around center instead of a character", () => {
    const spy = spyOn(drawModule, "Draw_Character");
    crosshair.value = 2;
    cl_crossx.value = 0;
    cl_crossy.value = 0;
    crosshaircolor.value = 79;

    Draw_Crosshair_Soft();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("GL: crosshair.value 2 draws one textured quad centered on scr_vrect with cl_crossx/cl_crossy offset", () => {
    const rec = new QGLRecording();
    const prior = qglHolder.current;
    SetQGL(rec);

    crosshair.value = 2;
    cl_crossx.value = 4;
    cl_crossy.value = 2;
    crosshaircolor.value = 79;

    Draw_Crosshair_GL();

    const verts = rec.calls.filter((c) => c.name === "qglVertex2f");
    expect(verts.length).toBe(4);
    const expectedX = 0 + 160 - 3 + 4;
    const expectedY = 0 + 100 - 3 + 2;
    expect(verts[0]?.args).toEqual([expectedX - 4, expectedY - 4]);

    SetQGL(prior);
  });

  test("qw.active=false: soft V_DrawCrosshair keeps view.c's inline WinQuake crosshair", async () => {
    const spy = spyOn(drawModule, "Draw_Character");
    const wasActive = qw.active;
    qw.active = false;
    crosshair.value = 1;
    cl_crossx.value = 2;
    cl_crossy.value = 1;

    const { softRenderer } = await import("../src/ref_soft/ref_soft");
    softRenderer.V_DrawCrosshair();

    expect(spy).toHaveBeenCalledTimes(1);
    const [x, y, num] = spy.mock.calls[0] as [number, number, number];
    expect(x).toBe(0 + 160 + 2);
    expect(y).toBe(0 + 100 + 1);
    expect(num).toBe("+".charCodeAt(0));

    qw.active = wasActive;
    spy.mockRestore();
  });

  test("qw.active=true: soft V_DrawCrosshair routes into draw.c's Draw_Crosshair (-4 centering)", async () => {
    const spy = spyOn(drawModule, "Draw_Character");
    const wasActive = qw.active;
    qw.active = true;
    crosshair.value = 1;
    cl_crossx.value = 2;
    cl_crossy.value = 1;

    const { softRenderer } = await import("../src/ref_soft/ref_soft");
    softRenderer.V_DrawCrosshair();

    expect(spy).toHaveBeenCalledTimes(1);
    const [x, y, num] = spy.mock.calls[0] as [number, number, number];
    expect(x).toBe(0 + 160 - 4 + 2);
    expect(y).toBe(0 + 100 - 4 + 1);
    expect(num).toBe("+".charCodeAt(0));

    qw.active = wasActive;
    spy.mockRestore();
  });
});

//=============================================================================
// common/model.ts + ref_soft/model.ts + ref_gl/gl_model.ts: the player.mdl /
// eyes.mdl CRC -> cls.qw.userinfo "pmodel"/"emodel" fold (QW model.c /
// gl_model.c's Mod_LoadAliasModel addition). The CRC/userinfo write happens
// before any MDL body parsing, so a synthetic (invalid) buffer is enough:
// the call is expected to throw afterward on the version check, which this
// test tolerates -- only the userinfo side effect is under test.
//=============================================================================

//=============================================================================
// gl_rlight.ts's R_RenderDlight fan color: QW/client/gl_rlight.c replaces
// WinQuake's fixed glColor3f(0.2,0.1,0.0) with glColor4f(light->color[0..3]),
// reading DlightT.color (src/client/client.ts).

describe("R_RenderDlight fan color (QW gl_rlight.c)", () => {
  const savedQw = qw.active;

  function renderOne(): QGLRecording {
    const rec = new QGLRecording();
    const prior = qglHolder.current;
    SetQGL(rec);
    R_InitBubble();

    const dl = new DlightT();
    dl.origin[0] = 1000; // well outside rad, so the AddLightBlend early-out
    dl.origin[1] = 0; //   is not taken
    dl.origin[2] = 0;
    dl.radius = 100;
    dl.color[0] = 0.5;
    dl.color[1] = 0.25;
    dl.color[2] = 0.125;
    dl.color[3] = 0.7;

    r_origin[0] = r_origin[1] = r_origin[2] = 0;

    R_RenderDlight(dl);
    SetQGL(prior);
    return rec;
  }

  afterAll(() => {
    qw.active = savedQw;
  });

  test("qw.active=true: glColor4f carries the dlight's own color[4]", () => {
    qw.active = true;
    const rec = renderOne();
    const color4 = rec.calls.filter((c) => c.name === "qglColor4f");
    expect(color4.length).toBe(1);
    const args = color4[0]?.args ?? [];
    expect(args.length).toBe(4);
    // dl.color is a Float32Array, so 0.7 comes back as the float32 nearest it
    expect(args[0]).toBeCloseTo(0.5, 6);
    expect(args[1]).toBeCloseTo(0.25, 6);
    expect(args[2]).toBeCloseTo(0.125, 6);
    expect(args[3]).toBeCloseTo(0.7, 6);
    expect(rec.calls.filter((c) => c.name === "qglColor3f").map((c) => c.args)).toEqual([[0, 0, 0]]);
  });

  test("qw.active=false: WinQuake's fixed glColor3f(0.2,0.1,0.0) is unchanged", () => {
    qw.active = false;
    const rec = renderOne();
    expect(rec.calls.filter((c) => c.name === "qglColor4f").length).toBe(0);
    expect(rec.calls.filter((c) => c.name === "qglColor3f").map((c) => c.args)).toEqual([
      [0.2, 0.1, 0.0],
      [0, 0, 0],
    ]);
  });
});

//=============================================================================
// The two Renderer members render.ts added for this wave's client-side
// GLQUAKE sites: `isGL` (the compile-time macro's runtime stand-in) and the
// optional `R_NetGraph` (gl_screen.c calls it from a client file; r_main.c
// calls the software one from inside the renderer, so only ref_gl implements
// the member).

describe("Renderer.isGL / Renderer.R_NetGraph", () => {
  test("softRenderer: isGL false, no R_NetGraph member", async () => {
    const { softRenderer } = await import("../src/ref_soft/ref_soft");
    expect(softRenderer.isGL).toBe(false);
    expect(softRenderer.R_NetGraph).toBeUndefined();
  });

  test("glRenderer: isGL true, R_NetGraph is gl_ngraph.c's", async () => {
    const { glRenderer } = await import("../src/ref_gl/ref_gl");
    expect(glRenderer.isGL).toBe(true);
    expect(glRenderer.R_NetGraph).toBe(R_NetGraph);
  });
});

describe("player.mdl/eyes.mdl CRC -> cls.qw.userinfo pmodel/emodel (QW model.c/gl_model.c)", () => {
  const savedUserinfo = cls.qw.userinfo;
  const savedComFilesize = com_filesize;

  beforeEach(() => {
    cls.qw.userinfo = "";
    // ref_soft/model.ts's/ref_gl's Mod_LoadAliasModel_* CRCs `com_filesize`
    // bytes of the buffer (mirrors the real engine's CRC_Block(buffer,
    // com_filesize), fed by COM_LoadFile before Mod_LoadAliasModel ever
    // runs) -- this suite calls the loader directly, skipping COM_LoadFile,
    // so it must set com_filesize itself (rule 13) rather than read whatever
    // an earlier suite's own COM_LoadFile happened to leave in the shared
    // global. garbageMdlBuffer() is always 128 bytes.
    setComFilesize(128);
  });

  afterAll(() => {
    cls.qw.userinfo = savedUserinfo;
    setComFilesize(savedComFilesize);
  });

  function garbageMdlBuffer(): Uint8Array {
    // Deliberately NOT a valid alias model, but large enough (mdl_t's header
    // is 84 bytes) that readMdl's fixed-offset reads stay in bounds: the
    // version check fails on garbage and throws a SysError once control
    // reaches it, well after the CRC/userinfo fold this test is checking.
    return new Uint8Array(128).fill(0xaa);
  }

  test("soft loader: progs/player.mdl sets pmodel to CRC_Block(buffer)", () => {
    const wasActive = qw.active;
    qw.active = true;
    const mod = new ModelT();
    mod.name = "progs/player.mdl";
    const buffer = garbageMdlBuffer();
    const expectedCrc = CRC_Block(buffer);

    try {
      Mod_LoadAliasModel_Soft(mod, buffer);
    } catch (e) {
      if (!(e instanceof SysError)) throw e;
    }

    expect(Info_ValueForKey(cls.qw.userinfo, modelNames.pmodel_name)).toBe(String(expectedCrc));
    qw.active = wasActive;
  });

  test("soft loader: progs/eyes.mdl sets emodel, and does nothing when qw.active is false", () => {
    const mod = new ModelT();
    mod.name = "progs/eyes.mdl";
    const buffer = garbageMdlBuffer();
    const expectedCrc = CRC_Block(buffer);

    const wasActive = qw.active;
    qw.active = false;
    cls.qw.userinfo = "";
    try {
      Mod_LoadAliasModel_Soft(mod, buffer);
    } catch (e) {
      if (!(e instanceof SysError)) throw e;
    }
    expect(Info_ValueForKey(cls.qw.userinfo, modelNames.emodel_name)).toBe("");

    qw.active = true;
    cls.qw.userinfo = "";
    try {
      Mod_LoadAliasModel_Soft(mod, buffer);
    } catch (e) {
      if (!(e instanceof SysError)) throw e;
    }
    expect(Info_ValueForKey(cls.qw.userinfo, modelNames.emodel_name)).toBe(String(expectedCrc));
    qw.active = wasActive;
  });

  test("GL loader: progs/player.mdl sets pmodel identically to the soft loader", () => {
    const wasActive = qw.active;
    qw.active = true;
    const mod = new ModelT();
    mod.name = "progs/player.mdl";
    const buffer = garbageMdlBuffer();
    const expectedCrc = CRC_Block(buffer);
    cls.qw.userinfo = "";

    try {
      Mod_LoadAliasModel_GL(mod, buffer);
    } catch (e) {
      if (!(e instanceof SysError)) throw e;
    }

    expect(Info_ValueForKey(cls.qw.userinfo, modelNames.pmodel_name)).toBe(String(expectedCrc));
    qw.active = wasActive;
  });
});

//=============================================================================
// gl_rmisc.ts: R_TranslatePlayerSkin selecting cl.qw.players[n] colors (QW
// gl_rmisc.c's rewrite over cl.players[]/player_info_t).
//=============================================================================

describe("R_TranslatePlayerSkin selects cl.qw.players[n] colors (QW gl_rmisc.c)", () => {
  const PLAYERNUM = 3;
  const savedPlayer = cl.qw.players[PLAYERNUM];

  beforeAll(() => {
    qw.active = true;
  });

  afterAll(() => {
    qw.active = savedQwActive;
    cl.qw.players[PLAYERNUM] = savedPlayer;
  });

  test("uploads to glState.playertextures + playernum and records the color-derived translate for a new player", () => {
    const rec = new QGLRecording();
    const prior = qglHolder.current;
    SetQGL(rec);

    const player = cl.qw.players[PLAYERNUM];
    player.name = "qwcl-render-test-player";
    player.userinfo = `\\skin\\qwcl_render_test_unique_${PLAYERNUM}`;
    player.topcolor = 4;
    player.bottomcolor = 9;
    player._topcolor = -1; // force the "colors changed" branch
    player._bottomcolor = -1;
    player.skin = null;

    R_TranslatePlayerSkin(PLAYERNUM);

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(binds.length).toBeGreaterThan(0);
    expect(binds[0]?.args[1]).toBe(glState.playertextures + PLAYERNUM);

    // the fold records the new colors onto _topcolor/_bottomcolor so a
    // second call with unchanged colors is a no-op, matching the C.
    expect(player._topcolor).toBe(4);
    expect(player._bottomcolor).toBe(9);

    SetQGL(prior);
  });

  test("a player with no name is skipped entirely (no GL calls)", () => {
    const rec = new QGLRecording();
    const prior = qglHolder.current;
    SetQGL(rec);

    const player = cl.qw.players[PLAYERNUM];
    player.name = "";

    R_TranslatePlayerSkin(PLAYERNUM);

    expect(rec.calls.length).toBe(0);
    SetQGL(prior);
  });
});

//=============================================================================
// r_alias.ts's R_AliasSetupSkin tail: QW/client/r_alias.c overrides the
// model's own skin with the connected player's downloaded one, reached
// through EntityT.scoreboard and skin.c's Skin_Find/Skin_Cache.

describe("R_AliasSetupSkin scoreboard skin override (QW r_alias.c)", () => {
  const savedEnt = rState.currententity;
  const savedMdl = rState.pmdl;
  const savedHdr = rState.paliashdr;

  function setUpSingleSkinModel(): Uint8Array {
    const mdl = new MdlT();
    mdl.numskins = 1;
    mdl.skinwidth = 64;
    mdl.skinheight = 32;

    const skinBytes = new Uint8Array(64 * 32);
    const desc = new MaliasskindescT();
    desc.type = AliasskintypeT.ALIAS_SKIN_SINGLE;
    desc.skin = skinBytes;

    const hdr = new AliashdrT();
    hdr.model = mdl;
    hdr.skindesc = [desc];

    rState.pmdl = mdl;
    rState.paliashdr = hdr;
    return skinBytes;
  }

  afterAll(() => {
    rState.currententity = savedEnt;
    rState.pmdl = savedMdl;
    rState.paliashdr = savedHdr;
    qw.active = savedQwActive;
  });

  test("qw.active=true with a scoreboard: Skin_Find runs; a cache miss leaves the model's own skin in place", () => {
    qw.active = true;
    const skinBytes = setUpSingleSkinModel();

    const ent = new EntityT();
    ent.skinnum = 0;
    const sc = new PlayerInfoT();
    sc.name = "qwcl-render-alias-player";
    sc.userinfo = "\\skin\\qwcl_render_alias_missing";
    sc.skin = null;
    ent.scoreboard = sc;
    rState.currententity = ent;

    R_AliasSetupSkin();

    // Skin_Find always assigns a skin_t slot, whether or not the .pcx loads
    expect(sc.skin).not.toBeNull();
    // no skins/*.pcx in this suite's scratch basedir, so Skin_Cache misses
    // and r_affinetridesc keeps the model's own skin and dimensions
    expect(r_affinetridesc.pskin).toBe(skinBytes);
    expect(r_affinetridesc.skinwidth).toBe(64);
    expect(r_affinetridesc.skinheight).toBe(32);
  });

  test("qw.active=false: the scoreboard is ignored entirely", () => {
    qw.active = false;
    const skinBytes = setUpSingleSkinModel();

    const ent = new EntityT();
    ent.skinnum = 0;
    const sc = new PlayerInfoT();
    sc.name = "qwcl-render-alias-player2";
    sc.skin = null;
    ent.scoreboard = sc;
    rState.currententity = ent;

    R_AliasSetupSkin();

    expect(sc.skin).toBeNull();
    expect(r_affinetridesc.pskin).toBe(skinBytes);
  });
});

//=============================================================================
// One "qw.active=false is unchanged" assertion per remaining folded file.
//=============================================================================

describe("qw.active=false leaves WinQuake behavior byte-identical, per folded file", () => {
  test("common/zone.ts: Memory_Init sizes the dynamic zone at WinQuake's 0xc000, not QW's 0x20000", () => {
    const spy = spyOn(consoleModule, "Con_Printf");
    const wasActive = qw.active;

    qw.active = false;
    Memory_Init(1024 * 1024);
    Z_Print();
    const winMsg = spy.mock.calls.at(-1)?.[1] as string | undefined;
    expect(winMsg).toContain("49152"); // 0xc000

    qw.active = true;
    Memory_Init(1024 * 1024);
    Z_Print();
    const qwMsg = spy.mock.calls.at(-1)?.[1] as string | undefined;
    expect(qwMsg).toContain("131072"); // 0x20000

    qw.active = wasActive;
    spy.mockRestore();
  });

  test("ref_soft/r_surf.ts: R_BuildLightMap still gates on r_fullbright when qw.active is false", () => {
    const savedFullbright = r_fullbright.value;
    const savedWorldmodel = cl.worldmodel;
    const savedAmbient = r_refdef.ambientlight;
    const savedSurf = r_drawsurf.surf;

    const worldmodel = new ModelT();
    worldmodel.lightdata = new Uint8Array(4);
    cl.worldmodel = worldmodel;
    r_refdef.ambientlight = 32;
    r_fullbright.value = 1;

    const dummySurf = makeMinimalSurf();
    r_drawsurf.surf = dummySurf;

    qw.active = false;
    blocklights.fill(0xffffffff);
    R_BuildLightMap();
    expect(blocklights[0]).toBe(0); // early-return path: r_fullbright wins when off

    // The C's final "bound, invert, and shift" pass runs unconditionally
    // (not part of the qw.active-gated guard), so the "on" branch's blocklights
    // entry is that transform applied to the ambient fill, not the raw fill.
    const ambient = 32 << 8;
    let expectedOn = (255 * 256 - ambient) >> (8 - VID_CBITS);
    if (expectedOn < 1 << 6) expectedOn = 1 << 6;

    qw.active = true;
    blocklights.fill(0xffffffff);
    R_BuildLightMap();
    expect(blocklights[0]).toBe(expectedOn); // ambient fill: r_fullbright ignored when on

    r_fullbright.value = savedFullbright;
    cl.worldmodel = savedWorldmodel;
    r_refdef.ambientlight = savedAmbient;
    r_drawsurf.surf = savedSurf;
  });

  test("src/client/snd_dma.ts: SND_Spatialize still keys off cl.viewentity (not cl.qw.playernum+1) when qw.active is false", () => {
    const savedViewentity = cl.viewentity;
    const savedPlayernum = cl.qw.playernum;

    cl.viewentity = 1;
    cl.qw.playernum = 7; // cl.qw.playernum + 1 = 8, deliberately different from cl.viewentity

    const ch = makeMinimalChannel(1);

    qw.active = false;
    ch.leftvol = 0;
    ch.rightvol = 0;
    SND_Spatialize(ch);
    expect(ch.leftvol).toBe(ch.master_vol); // matched cl.viewentity -> full volume, WinQuake path

    const ch8 = makeMinimalChannel(8);
    qw.active = true;
    ch8.leftvol = 0;
    ch8.rightvol = 0;
    SND_Spatialize(ch8);
    expect(ch8.leftvol).toBe(ch8.master_vol); // matched cl.qw.playernum+1 -> full volume, QW path

    cl.viewentity = savedViewentity;
    cl.qw.playernum = savedPlayernum;
  });

  test("src/platform/cd_ogg.ts: CDAudio_Init still refuses to init on a dedicated server when qw.active is false", () => {
    const savedDedicated = sysState.isDedicated;
    const wasActive = qw.active;

    sysState.isDedicated = true;
    qw.active = false;
    expect(CDAudio_Init()).toBe(-1);

    sysState.isDedicated = savedDedicated;
    qw.active = wasActive;
  });
});

// Helpers -- kept minimal and file-local (this file writes no src/ code).

function makeMinimalSurf(): import("../src/common/model").MsurfaceT {
  const { MsurfaceT } = require("../src/common/model") as typeof import("../src/common/model");
  const surf = new MsurfaceT();
  surf.extents[0] = 0;
  surf.extents[1] = 0;
  surf.samples = new Uint8Array(4).fill(255); // styles read from cached_light/styles below, not samples directly
  surf.styles.fill(255); // MAXLIGHTMAPS worth of "no style" markers: skips the per-lightmap add loop
  return surf;
}

function makeMinimalChannel(entnum: number): ChannelT {
  const { ChannelT } = require("../src/client/sound") as typeof import("../src/client/sound");
  const ch = new ChannelT();
  ch.entnum = entnum;
  ch.master_vol = 200;
  return ch;
}

// A do-nothing Renderer, following test/cl_parse.test.ts's own
// makeFakeRenderer shape, except Draw_CachePic returns a synthetic 8x8 QpicT
// instead of null -- R_NetGraph's call into menu.ts's M_DrawTextBox needs
// SOME pic back or it Sys_Errors; this test does not care what the box looks
// like, only that R_NetGraph reaches its own qgl* calls.
function makeMinimalRenderer(): Renderer {
  const pic = new QpicT();
  pic.width = 8;
  pic.height = 8;
  pic.data = new Uint8Array(64);
  return {
    modelHooks: {
      notexture: new (require("../src/common/model") as typeof import("../src/common/model")).TextureT(),
      textureLoaded(): void {},
      Mod_LoadLighting(): void {},
      Mod_LoadAliasModel(): void {},
      Mod_LoadSpriteModel(): void {},
    },
    R_Init(): void {},
    R_InitTextures(): void {},
    R_InitEfrags(): void {},
    R_RenderView(): void {},
    R_ViewChanged(): void {},
    R_InitSky(): void {},
    R_AddEfrags(): void {},
    R_RemoveEfrags(): void {},
    R_NewMap(): void {},
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
      return pic;
    },
    D_StartParticles(): void {},
    D_DrawParticle(): void {},
    D_EndParticles(): void {},
    V_CalcBlend(): void {},
    V_UpdatePalette(): void {},
    V_DrawCrosshair(): void {},
    R_TranslatePlayerSkin(): void {},
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

void cl_entities;
void ModtypeT;
