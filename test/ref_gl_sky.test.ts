// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U21's src/ref_gl/gl_sky.ts: QuakeSpasm's skybox feature (no
WinQuake original -- see that file's header), ported here as a documented
quality-of-life addition for the 2021 re-release's maps (mg1's "sky_city"
skybox). Covers Sky_LoadSkyBox's six-face load-and-upload sequence (through
COM_LoadTempFile + src/lib/tga.ts + GL_Upload32, the logical GL_Bind/upload
pattern gl_draw.ts's other texture loaders already use), Sky_NewMap's
"sky"/"skyname" worldspawn key parsing, Sky_DrawSkyBox's six-quad draw with
r_fastsky/r_skyalpha, and SkyActive() suppressing the classic gl_warp.ts
warp path once a skybox is loaded.

Self-sufficient per standing order 13: every shared singleton this file
writes (qglHolder.current, glState.texture_extension_number, r_fastsky/
r_skyalpha/r_skyfog, r_refdef.vieworg, COM's search path/argv/registration
state, and the skybox itself, cleared back to "" via Sky_LoadSkyBox("") in
afterAll) is saved/reset.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem, pop, setComModified, setComSearchpaths } from "../src/common/common";
import { ensureDir, writeGameFile } from "./support/bsp_builder";
import { writePakToDisk } from "./support/pak_builder";
import { r_refdef } from "../src/client/render";
import { glState } from "../src/ref_gl/glquake";
import { GL_BLEND, GL_QUADS, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { gl_max_size, gl_picmip } from "../src/ref_gl/gl_draw";
import { Fog_ParseWorldspawn, Fog_Update } from "../src/ref_gl/gl_fog";
import { Sky_DrawSkyBox, Sky_Init, Sky_LoadSkyBox, Sky_NewMap, SkyActive, SkyTintColor, r_fastsky, r_skyalpha, r_skyfog } from "../src/ref_gl/gl_sky";
import { Cmd_Exists } from "../src/common/cmd";
import { cl } from "../src/client/client";

const rec = new QGLRecording();

const savedCvar = (c: { string: string; value: number }): { string: string; value: number } => ({ string: c.string, value: c.value });
const restoreCvar = (c: { string: string; value: number }, s: { string: string; value: number }): void => {
  c.string = s.string;
  c.value = s.value;
};

const saved = {
  qgl: qglHolder.current,
  texExt: glState.texture_extension_number,
  vieworg: [r_refdef.vieworg[0], r_refdef.vieworg[1], r_refdef.vieworg[2]],
  time: cl.time,
  cvars: {
    r_fastsky: savedCvar(r_fastsky),
    r_skyalpha: savedCvar(r_skyalpha),
    r_skyfog: savedCvar(r_skyfog),
    gl_picmip: savedCvar(gl_picmip),
    gl_max_size: savedCvar(gl_max_size),
  },
};

afterAll(() => {
  Sky_LoadSkyBox(""); // clear the skybox singleton back to its module default
  Fog_ParseWorldspawn(""); // reset gl_fog.ts's state too (this file drives it)
  SetQGL(saved.qgl);
  glState.texture_extension_number = saved.texExt;
  r_refdef.vieworg[0] = saved.vieworg[0];
  r_refdef.vieworg[1] = saved.vieworg[1];
  r_refdef.vieworg[2] = saved.vieworg[2];
  cl.time = saved.time;
  restoreCvar(r_fastsky, saved.cvars.r_fastsky);
  restoreCvar(r_skyalpha, saved.cvars.r_skyalpha);
  restoreCvar(r_skyfog, saved.cvars.r_skyfog);
  restoreCvar(gl_picmip, saved.cvars.gl_picmip);
  restoreCvar(gl_max_size, saved.cvars.gl_max_size);
  setComSearchpaths(null);
});

beforeEach(() => {
  rec.clear();
  SetQGL(rec);
  r_fastsky.value = 0;
  r_skyalpha.value = 1;
  r_skyfog.value = 0.5;
  r_refdef.vieworg[0] = 0;
  r_refdef.vieworg[1] = 0;
  r_refdef.vieworg[2] = 0;
  cl.time = 0;
  // GL_Upload32 (Sky_LoadSkyBox's upload path) shifts by gl_picmip and
  // clamps to gl_max_size; pin both to their construction defaults so this
  // file's tiny 2x2 synthetic faces upload at their real size regardless of
  // what an earlier test file left these shared cvars at.
  gl_picmip.value = 0;
  gl_max_size.value = 1024;
});

//============================================================================
// SkyActive() / Sky_LoadSkyBox("") default state
//============================================================================

describe("SkyActive default state", () => {
  test("no skybox loaded means SkyActive() is false and Sky_DrawSkyBox draws nothing", () => {
    Sky_LoadSkyBox("");
    expect(SkyActive()).toBe(false);

    Sky_DrawSkyBox();
    expect(rec.calls).toHaveLength(0);
  });
});

//============================================================================
// Sky_NewMap worldspawn key parsing (no real files needed: an unresolvable
// name simply fails to activate, which is itself an observable behavior).
//============================================================================

describe("Sky_NewMap worldspawn key parsing", () => {
  test("a worldspawn with no sky/skyname key leaves the skybox inactive", () => {
    Sky_LoadSkyBox(""); // start clean
    Sky_NewMap('{\n"classname" "worldspawn"\n}\n');
    expect(SkyActive()).toBe(false);
  });

  test("an unresolvable sky name (no gfx/env files found) fails to activate", () => {
    setComSearchpaths(null); // no mounted files at all -> every face load fails
    Sky_NewMap('{\n"classname" "worldspawn"\n"sky" "nonexistent_sky_xyz"\n}\n');
    expect(SkyActive()).toBe(false);
  });
});

//============================================================================
// Synthetic real-file load: Sky_LoadSkyBox / Sky_DrawSkyBox end to end
//============================================================================

// A minimal uncompressed 24-bit TGA (image_type 2), one solid color, the
// smallest input decodeTGA (src/lib/tga.ts) accepts.
function buildSolidTga(r: number, g: number, b: number): Uint8Array {
  const width = 2;
  const height = 2;
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

const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

describe("Sky_LoadSkyBox synthetic real-file load", () => {
  const scratchDir = mkdtempSync(join(scratchRoot, "refgl-sky-test-"));
  const baseDir = join(scratchDir, "quake");
  const SUF = ["rt", "bk", "lf", "ft", "up", "dn"] as const;

  function mountFilesystem(): void {
    ensureDir(join(baseDir, "id1"));

    // gfx/pop.lmp inside id1/pak0.pak: without it COM_CheckRegistered
    // leaves shareware mode on and COM_FindFile never searches loose
    // slash paths (the same trick test/ref_gl_colored_light.test.ts uses).
    const popLmp = new Uint8Array(256);
    for (let i = 0; i < 128; i++) {
      popLmp[i * 2] = (pop[i] >> 8) & 0xff;
      popLmp[i * 2 + 1] = pop[i] & 0xff;
    }
    writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

    for (let i = 0; i < 6; i++) {
      const shade = 32 * (i + 1);
      writeGameFile(baseDir, `id1/gfx/env/testsky${SUF[i]}.tga`, buildSolidTga(shade, shade, shade));
    }

    setComSearchpaths(null);
    COM_InitArgv(["quake", "-basedir", baseDir]);
    setComModified(false);
    COM_InitFilesystem();
    COM_CheckRegistered();
  }

  test("loads all six faces, uploads through GL_Upload32, and activates the skybox", () => {
    mountFilesystem();
    glState.texture_extension_number = 100;

    Sky_LoadSkyBox("testsky");

    expect(SkyActive()).toBe(true);

    // six distinct texture ids minted, one glTexImage2D per face
    const texImages = rec.calls.filter((c) => c.name === "qglTexImage2D");
    expect(texImages).toHaveLength(6);
    for (const call of texImages) {
      expect(call.args[3]).toBe(2); // width
      expect(call.args[4]).toBe(2); // height
    }
    expect(glState.texture_extension_number).toBe(106);
  });

  test("re-selecting the same name is a no-op (no new uploads)", () => {
    mountFilesystem();
    for (let i = 0; i < 6; i++) writeGameFile(baseDir, `id1/gfx/env/testsky2${SUF[i]}.tga`, buildSolidTga(1, 1, 1));

    glState.texture_extension_number = 200;
    Sky_LoadSkyBox("testsky2");
    expect(SkyActive()).toBe(true);
    const afterFirstLoad = glState.texture_extension_number;

    rec.clear();
    Sky_LoadSkyBox("testsky2"); // same name again -> early return, no re-upload
    expect(rec.calls).toHaveLength(0);
    expect(glState.texture_extension_number).toBe(afterFirstLoad);
  });

  test("Sky_DrawSkyBox binds all six textures and draws six GL_QUADS centered on the viewer", () => {
    mountFilesystem();
    for (let i = 0; i < 6; i++) writeGameFile(baseDir, `id1/gfx/env/testsky3a${SUF[i]}.tga`, buildSolidTga(10, 20, 30));
    glState.texture_extension_number = 300;
    Sky_LoadSkyBox("testsky3a");
    expect(SkyActive()).toBe(true);

    r_refdef.vieworg[0] = 64;
    r_refdef.vieworg[1] = 128;
    r_refdef.vieworg[2] = 256;

    rec.clear();
    Sky_DrawSkyBox();

    const binds = rec.calls.filter((c) => c.name === "qglBindTexture");
    expect(binds).toHaveLength(6);
    const begins = rec.calls.filter((c) => c.name === "qglBegin" && c.args[0] === GL_QUADS);
    expect(begins).toHaveLength(6);
    // every emitted vertex is re-centered on the current view origin
    const verts = rec.calls.filter((c) => c.name === "qglVertex3f");
    expect(verts.length).toBe(24); // 6 faces * 4 corners
    for (const v of verts) {
      expect(Math.abs((v.args[0] as number) - 64)).toBeGreaterThan(0); // offset by a nonzero cube radius
    }
    // depth writes toggle off then back on around the draw
    const depthOff = rec.calls.findIndex((c) => c.name === "qglDepthMask" && c.args[0] === false);
    const depthOn = rec.calls.findIndex((c) => c.name === "qglDepthMask" && c.args[0] === true);
    expect(depthOff).toBe(0);
    expect(depthOn).toBe(rec.calls.length - 1);
  });

  test("r_fastsky skips the skybox draw entirely", () => {
    mountFilesystem();
    for (let i = 0; i < 6; i++) writeGameFile(baseDir, `id1/gfx/env/testsky4${SUF[i]}.tga`, buildSolidTga(5, 5, 5));
    glState.texture_extension_number = 400;
    Sky_LoadSkyBox("testsky4");
    expect(SkyActive()).toBe(true);

    r_fastsky.value = 1;
    rec.clear();
    Sky_DrawSkyBox();
    expect(rec.calls).toHaveLength(0);
  });

  test("r_skyalpha < 1 blends the skybox quads", () => {
    mountFilesystem();
    for (let i = 0; i < 6; i++) writeGameFile(baseDir, `id1/gfx/env/testsky5${SUF[i]}.tga`, buildSolidTga(7, 7, 7));
    glState.texture_extension_number = 500;
    Sky_LoadSkyBox("testsky5");

    r_skyalpha.value = 0.5;
    rec.clear();
    Sky_DrawSkyBox();

    expect(rec.calls.some((c) => c.name === "qglEnable" && c.args[0] === GL_BLEND)).toBe(true);
    const color = rec.calls.find((c) => c.name === "qglColor4f");
    expect(color?.args).toEqual([1, 1, 1, 0.5]);
  });
});

//============================================================================
// SkyTintColor: r_skyfog's blend of the classic warp toward the fog color
//============================================================================

describe("SkyTintColor", () => {
  test("r_skyfog 0 always returns pure white, even with fog active", () => {
    r_skyfog.value = 0;
    Fog_Update(0.9, 1, 0, 0, 0);
    expect(SkyTintColor()).toEqual([1, 1, 1]);
  });

  test("no fog (density 0) returns pure white regardless of r_skyfog", () => {
    r_skyfog.value = 1;
    Fog_Update(0, 1, 0, 0, 0);
    expect(SkyTintColor()).toEqual([1, 1, 1]);
  });

  test("blends white toward the fog color by r_skyfog's fraction when fog is active", () => {
    r_skyfog.value = 1; // full blend -> tint equals the fog color exactly
    Fog_Update(0.5, 0.2, 0.4, 0.6, 0);
    const tint = SkyTintColor();
    expect(tint[0]).toBeCloseTo(0.2, 2);
    expect(tint[1]).toBeCloseTo(0.4, 2);
    expect(tint[2]).toBeCloseTo(0.6, 2);
  });

  test("a fractional r_skyfog blends partway between white and the fog color", () => {
    r_skyfog.value = 0.5;
    Fog_Update(0.5, 0, 0, 0, 0); // fog color black
    const tint = SkyTintColor();
    // 1 + (0-1)*0.5 = 0.5 on every channel
    expect(tint[0]).toBeCloseTo(0.5, 2);
    expect(tint[1]).toBeCloseTo(0.5, 2);
    expect(tint[2]).toBeCloseTo(0.5, 2);
  });
});

//============================================================================
// Sky_Init no longer owns the `sky` console command
//============================================================================

describe("Sky_Init", () => {
  test("registers no console command of its own -- src/client/sky_cmd.ts owns `sky` for both renderers", () => {
    // Asserted as "does not change", not "is false": another suite in the
    // same process may legitimately have imported src/client/sky_cmd.ts and
    // registered the shared command already.
    const before = Cmd_Exists("sky");
    Sky_Init();
    expect(Cmd_Exists("sky")).toBe(before);
  });
});

//============================================================================
// Guarded real-data test: mg1's real "sky_city" skybox from the re-release.
//============================================================================

const RERELEASE_DIR = process.env.Q1TS_RERELEASE ?? "/home/buzzkill/Projects/qfiles/q1/rerelease";
const HAVE_MG1 = existsSync(join(RERELEASE_DIR, "mg1", "pak0.pak")) && existsSync(join(RERELEASE_DIR, "id1", "pak0.pak"));

describe.skipIf(!HAVE_MG1)("mg1's real sky_city skybox (skipped when absent, e.g. on CI)", () => {
  test("Sky_LoadSkyBox loads all six sky_city faces from mg1/pak0.pak", () => {
    setComSearchpaths(null);
    // mg1 is a re-release DLC game directory layered over id1, exactly as
    // the real engine mounts it (-basedir the rerelease tree, -game mg1).
    COM_InitArgv(["quake", "-basedir", RERELEASE_DIR, "-game", "mg1"]);
    setComModified(false);
    COM_InitFilesystem();
    COM_CheckRegistered();

    glState.texture_extension_number = 900;
    // mg1's own maps' worldspawn "_sky" key is literally "sky_city/sky_city_"
    // (verified with `strings` against mg1/pak0.pak: the real files are
    // gfx/env/sky_city/sky_city_rt.tga etc, a subdirectory PLUS a repeated
    // name prefix, not a flat gfx/env/sky_cityrt.tga) -- Sky_LoadSkyBox
    // appends the face suffix directly onto whatever name it's given, so the
    // worldspawn value already carries the trailing underscore and path.
    //
    // The real faces are 1024x1024, four times what gl_draw.c's fixed
    // `static unsigned scaled[1024*512]` upload scratch would take. That
    // buffer follows the texture now (see gl_draw.ts's uploadTexelLimit), so
    // this loads at gl_max_size's own default and every face reaches
    // qglTexImage2D at its full on-disk size.
    gl_max_size.value = 1024;
    rec.clear();
    Sky_LoadSkyBox("sky_city/sky_city_");

    expect(SkyActive()).toBe(true);
    expect(glState.texture_extension_number).toBe(906);

    const uploads = rec.calls.filter((c) => c.name === "qglTexImage2D");
    expect(uploads).toHaveLength(6);
    for (const u of uploads) {
      expect(u.args[3]).toBe(1024);
      expect(u.args[4]).toBe(1024);
    }

    Sky_LoadSkyBox("");
    setComSearchpaths(null);
  });
});
