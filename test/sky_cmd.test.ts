/*
Tests for src/client/sky_cmd.ts: the ONE shared `sky` console command, which
replaces gl_sky.ts's own Sky_Init registration so that a binary carrying both
renderers has exactly one `sky` (see that file's header, and
src/client/fog_cmd.ts's for the same story about `fog`). Every assertion here
is about the dispatch: which renderer's skyLoadSkyBox is reached, with what
name, and what the argument-less form prints.

Self-sufficient per standing order 13: `re.current` is saved and restored in
afterAll, a fresh fake Renderer is installed per test, and the Con_Printf spy
is installed in beforeAll and restored in afterAll. Importing the module under
test registers `sky` at module load, which is the behaviour the first test
asserts; Cmd_AddCommand has no reclaim path, so nothing here unregisters it.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import type { QpicT } from "../src/common/wad";
import { Cmd_ExecuteString, Cmd_Exists, CmdSourceT } from "../src/common/cmd";
import * as consoleModule from "../src/client/console";
import { re, type Renderer } from "../src/client/render";
import "../src/client/sky_cmd";

// A do-nothing Renderer recording only the skyLoadSkyBox calls this unit
// cares about, following test/r_part.test.ts's own minimal-fixture precedent.
function makeFakeRenderer(loaded: string[], isGL: boolean, withSky = true): Renderer {
  const hooks: ModelLoaderHooks = {
    notexture: new TextureT(),
    textureLoaded(): void {},
    Mod_LoadLighting(): void {},
    Mod_LoadAliasModel(): void {},
    Mod_LoadSpriteModel(): void {},
  };
  const r: Renderer = {
    modelHooks: hooks,
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
      return null;
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
    isGL,
    SCR_ScreenShot_f(): void {},
  };
  if (withSky) r.skyLoadSkyBox = (name: string): void => void loaded.push(name);
  return r;
}

const savedRenderer = re.current;
let printed: string[] = [];
let printSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  printSpy = spyOn(consoleModule, "Con_Printf").mockImplementation((fmt: string, ...args: unknown[]): void => {
    printed.push(`${fmt}|${args.map((a) => String(a)).join(",")}`);
  });
});

beforeEach(() => {
  printed = [];
});

afterAll(() => {
  printSpy.mockRestore();
  re.current = savedRenderer;
});

function sky(line: string): void {
  Cmd_ExecuteString(line, CmdSourceT.src_command);
}

describe("the shared `sky` console command", () => {
  test("importing src/client/sky_cmd.ts registers `sky` at module load", () => {
    expect(Cmd_Exists("sky")).toBe(true);
  });

  test("`sky <name>` reaches the active renderer's skyLoadSkyBox", () => {
    const loaded: string[] = [];
    re.current = makeFakeRenderer(loaded, true);

    sky("sky sky_city/sky_city_");

    expect(loaded).toEqual(["sky_city/sky_city_"]);
  });

  test("the same command reaches the software renderer when that is the active one", () => {
    const loaded: string[] = [];
    re.current = makeFakeRenderer(loaded, false);

    sky("sky mge2m1/mge2m1_");

    expect(loaded).toEqual(["mge2m1/mge2m1_"]);
  });

  test("switching the active renderer switches where the next `sky` goes", () => {
    const glLoaded: string[] = [];
    const softLoaded: string[] = [];

    re.current = makeFakeRenderer(glLoaded, true);
    sky("sky first");
    re.current = makeFakeRenderer(softLoaded, false);
    sky("sky second");

    expect(glLoaded).toEqual(["first"]);
    expect(softLoaded).toEqual(["second"]);
  });

  test("`sky` with no argument reports the last name and loads nothing", () => {
    const loaded: string[] = [];
    re.current = makeFakeRenderer(loaded, true);

    sky("sky reported");
    printed = [];
    sky("sky");

    expect(loaded).toEqual(["reported"]);
    expect(printed).toEqual(['"sky" is "%s"\n|reported']);
  });

  test("a trailing space is still the no-argument form (one token)", () => {
    const loaded: string[] = [];
    re.current = makeFakeRenderer(loaded, true);

    sky("sky trailing");
    printed = [];
    sky("sky ");

    expect(loaded).toEqual(["trailing"]);
    expect(printed).toHaveLength(1);
  });

  test("an empty name unloads: it is passed straight through to the renderer", () => {
    const loaded: string[] = [];
    re.current = makeFakeRenderer(loaded, true);

    sky('sky ""');

    expect(loaded).toEqual([""]);
  });

  test("a renderer with no skybox support at all is a no-op, not a throw", () => {
    const loaded: string[] = [];
    re.current = makeFakeRenderer(loaded, false, false);

    expect(() => sky("sky nowhere")).not.toThrow();
    expect(loaded).toEqual([]);
  });
});
