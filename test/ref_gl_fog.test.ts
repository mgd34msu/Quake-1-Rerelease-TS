// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U21's src/ref_gl/gl_fog.ts: QuakeSpasm's global GL_EXP2 fog,
ported as a documented quality-of-life addition (no WinQuake original --
see that file's header). Covers Fog_ParseServerMessage's wire normalization
(FitzQuake's svc_fog layout: density/r/g/b bytes over 255, a centisecond
short clamped >=0), Fog_ParseWorldspawn's "fog" worldspawn key and its
sscanf-style partial-match reset semantics, Fog_Update's fade math (a linear
blend between the old and new color/density over `time` seconds of
cl.time), Fog_GetColor's fade blend + clamp + 24-bit rounding, Fog_FogCommand_f's
argc branches called directly, and (U44) the ONE shared 'fog' console command
(src/client/fog_cmd.ts) reaching this renderer through
src/client/render.ts's Renderer.fogCommand/fogGetState seam members when
`re.current` is the GL renderer.

Self-sufficient per standing order 13: every shared singleton this file
writes (qglHolder.current, cl.time, re.current, and every module-private
fog_* value gl_fog.ts keeps, reset indirectly through
Fog_ParseWorldspawn("") in afterAll rather than reached into directly since
they are not exported) is restored in afterAll.
*/

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { Cmd_ExecuteString, CmdSourceT, Cmd_TokenizeString } from "../src/common/cmd";
import { cl } from "../src/client/client";
import { re } from "../src/client/render";
import { glRenderer } from "../src/ref_gl/ref_gl";
import { GL_EXP2, GL_FOG, GL_FOG_COLOR, GL_FOG_DENSITY, GL_FOG_MODE, QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import {
  Fog_DisableGFog,
  Fog_EnableGFog,
  Fog_FogCommand_f,
  Fog_GetColor,
  Fog_GetDensity,
  Fog_Init,
  Fog_ParseServerMessage,
  Fog_ParseWorldspawn,
  Fog_SetupFrame,
  Fog_SetupState,
  Fog_Update,
} from "../src/ref_gl/gl_fog";

const rec = new QGLRecording();

const saved = {
  qgl: qglHolder.current,
  time: cl.time,
  renderer: re.current,
};

// gl_fog.ts's fog_* state is module-private; the only reset surface it
// exposes is Fog_ParseWorldspawn on an empty (no "fog" key) entity lump,
// which the file's own header documents as resetting to the no-fog
// defaults. Every test starts from that known state.
function resetFog(): void {
  cl.time = 0;
  Fog_ParseWorldspawn('{\n"classname" "worldspawn"\n}\n');
}

beforeEach(() => {
  rec.clear();
  SetQGL(rec);
  resetFog();
  // U44: the shared 'fog' console command (src/client/fog_cmd.ts) dispatches
  // through getRenderer().fogCommand -- this file's density/color assertions
  // only make sense when the active renderer is the GL one whose gl_fog.ts
  // state this file reads.
  re.current = glRenderer;
});

afterAll(() => {
  SetQGL(saved.qgl);
  cl.time = saved.time;
  re.current = saved.renderer;
  resetFog();
});

//============================================================================
// Fog_ParseServerMessage (FitzQuake/Ironwail svc_fog wire layout)
//============================================================================

describe("Fog_ParseServerMessage", () => {
  test("normalizes the 0-255 density/rgb bytes and the centisecond time short", () => {
    cl.time = 5;
    Fog_ParseServerMessage(128, 255, 0, 64, 200); // time=200cs=2s

    // immediately after the call, cl.time (5) < fade_done (5+2=7): mid-fade.
    // At t=5 with fade starting at 5 and lasting 2s, f = (7-5)/2 = 1 -- the
    // fade is 100% old still, so density/color read as the PRE-update values
    // (the no-fog default) until time actually advances.
    expect(Fog_GetDensity()).toBeCloseTo(0, 5);

    // advancing to the end of the fade reads the new value exactly.
    cl.time = 7;
    expect(Fog_GetDensity()).toBeCloseTo(128 / 255, 4);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(1, 2); // 255/255
    expect(c[1]).toBeCloseTo(0, 2); // 0/255
    expect(c[2]).toBeCloseTo(64 / 255, 2);
  });

  test("a negative wire time clamps to 0 (no fade -- takes effect immediately)", () => {
    cl.time = 10;
    Fog_ParseServerMessage(255, 0, 0, 0, -50);
    // time<0 -> clamped to 0 -> Fog_Update's `time>0` fade branch never
    // runs, so the new density is visible on the very same tick.
    expect(Fog_GetDensity()).toBeCloseTo(1, 4);
  });

  test("density 0 turns fog fully off", () => {
    cl.time = 0;
    Fog_ParseServerMessage(0, 128, 128, 128, 0);
    expect(Fog_GetDensity()).toBe(0);
  });
});

//============================================================================
// Fog_ParseWorldspawn
//============================================================================

describe("Fog_ParseWorldspawn", () => {
  test("reads \"density red green blue\" from the \"fog\" key", () => {
    const ents = '{\n"classname" "worldspawn"\n"fog" "0.5 0.2 0.4 0.6"\n}\n';
    Fog_ParseWorldspawn(ents);
    expect(Fog_GetDensity()).toBeCloseTo(0.5, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(0.2, 2);
    expect(c[1]).toBeCloseTo(0.4, 2);
    expect(c[2]).toBeCloseTo(0.6, 2);
  });

  test("a worldspawn with no \"fog\" key resets to no fog", () => {
    Fog_ParseWorldspawn('{\n"classname" "worldspawn"\n"fog" "0.9 1 1 1"\n}\n');
    expect(Fog_GetDensity()).toBeCloseTo(0.9, 5);

    Fog_ParseWorldspawn('{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n}\n');
    expect(Fog_GetDensity()).toBe(0);
  });

  test("a partial fog value (sscanf-style) fills left-to-right and stops at the first bad token", () => {
    // only density and red parse; green/blue stay at the just-applied
    // no-fog reset (DEFAULT_GRAY, 0.3) rather than the old fog's color.
    const ents = '{\n"classname" "worldspawn"\n"fog" "0.4 0.1 bogus 0.9"\n}\n';
    Fog_ParseWorldspawn(ents);
    expect(Fog_GetDensity()).toBeCloseTo(0.4, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(0.1, 2);
    expect(c[1]).toBeCloseTo(0.3, 2); // DEFAULT_GRAY, untouched
    expect(c[2]).toBeCloseTo(0.3, 2); // DEFAULT_GRAY, untouched
  });

  test("an underscore-prefixed key (\"_fog\") is treated the same as \"fog\"", () => {
    Fog_ParseWorldspawn('{\n"classname" "worldspawn"\n"_fog" "0.7 0 0 0"\n}\n');
    expect(Fog_GetDensity()).toBeCloseTo(0.7, 5);
  });
});

//============================================================================
// Fog_Update fade math
//============================================================================

describe("Fog_Update fade", () => {
  test("blends old and new density/color linearly over the fade time", () => {
    cl.time = 0;
    Fog_Update(0, 0, 0, 0, 0); // establish a known starting point: no fog
    cl.time = 10;
    Fog_Update(1.0, 1, 1, 1, 4); // fade to full white fog over 4 seconds

    cl.time = 10; // fade just started: 0% new, 100% old
    expect(Fog_GetDensity()).toBeCloseTo(0, 4);

    cl.time = 12; // halfway
    expect(Fog_GetDensity()).toBeCloseTo(0.5, 4);
    const half = Fog_GetColor();
    expect(half[0]).toBeCloseTo(0.5, 1);

    cl.time = 14; // fade complete
    expect(Fog_GetDensity()).toBeCloseTo(1, 4);

    cl.time = 20; // long after: stays at the new value
    expect(Fog_GetDensity()).toBeCloseTo(1, 4);
  });

  test("a fade interrupted by a new Fog_Update blends from the in-progress value, not from scratch", () => {
    cl.time = 0;
    Fog_Update(0, 0, 0, 0, 0);
    cl.time = 0;
    Fog_Update(1, 0, 0, 0, 10); // fade density 0->1 over 10s
    cl.time = 5; // halfway: density reads ~0.5
    expect(Fog_GetDensity()).toBeCloseTo(0.5, 4);

    // now fade to 0 again over 10s, starting from wherever the in-progress
    // fade currently reads (~0.5), not from the fully-faded-in 1.0.
    Fog_Update(0, 0, 0, 0, 10);
    cl.time = 5; // immediately after the new Fog_Update: 0% into the new fade
    expect(Fog_GetDensity()).toBeCloseTo(0.5, 3);
  });
});

//============================================================================
// Fog_GetColor: clamping and 24-bit rounding
//============================================================================

describe("Fog_GetColor", () => {
  test("clamps out-of-range channels to [0,1]", () => {
    // the 'fog' console command already clamps r/g/b itself (covered
    // below), so drive this through Fog_Update directly to prove
    // Fog_GetColor's OWN clamp, independent of any caller's clamp.
    cl.time = 0;
    Fog_Update(0.5, 1.5, -0.5, 2, 0);
    const c = Fog_GetColor();
    expect(c[0]).toBe(1);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(1);
  });

  test("rounds each channel to the nearest 24-bit (1/255) step", () => {
    cl.time = 0;
    Fog_Update(0.5, 0.501, 0.501, 0.501, 0);
    const c = Fog_GetColor();
    // 0.501*255 = 127.755 -> rounds to 128 -> 128/255
    expect(c[0]).toBeCloseTo(128 / 255, 6);
  });
});

//============================================================================
// Fog_EnableGFog / Fog_DisableGFog / Fog_SetupFrame / Fog_SetupState
//============================================================================

describe("Fog_EnableGFog / Fog_DisableGFog", () => {
  test("enables GL_FOG only when density is above zero", () => {
    cl.time = 0;
    Fog_Update(0, 0, 0, 0, 0);
    rec.clear();
    Fog_EnableGFog();
    expect(rec.calls.some((c) => c.name === "qglEnable" && c.args[0] === GL_FOG)).toBe(false);

    Fog_Update(0.5, 0, 0, 0, 0);
    rec.clear();
    Fog_EnableGFog();
    expect(rec.calls.some((c) => c.name === "qglEnable" && c.args[0] === GL_FOG)).toBe(true);

    Fog_DisableGFog();
    expect(rec.calls.some((c) => c.name === "qglDisable" && c.args[0] === GL_FOG)).toBe(true);
  });
});

describe("Fog_SetupFrame", () => {
  test("uploads the current color and density/64 via glFogfv/glFogf", () => {
    cl.time = 0;
    Fog_Update(0.5, 1, 0, 0, 0);
    rec.clear();
    Fog_SetupFrame();

    const colorCall = rec.calls.find((c) => c.name === "qglFogfv" && c.args[0] === GL_FOG_COLOR);
    expect(colorCall).toBeTruthy();
    const densityCall = rec.calls.find((c) => c.name === "qglFogf" && c.args[0] === GL_FOG_DENSITY);
    expect(densityCall?.args[1]).toBeCloseTo(0.5 / 64, 6);
  });
});

describe("Fog_SetupState", () => {
  test("sets GL_FOG_MODE to GL_EXP2", () => {
    rec.clear();
    Fog_SetupState();
    expect(rec.calls).toEqual([{ name: "qglFogi", args: [GL_FOG_MODE, GL_EXP2] }]);
  });
});

//============================================================================
// 'fog' console command (Fog_Init registers it)
//============================================================================

describe("fog console command", () => {
  beforeEach(() => {
    // U44: Fog_Init no longer touches the shared command table at all (the
    // ONE 'fog' command is registered once, at module load, by
    // src/client/fog_cmd.ts -- see this file's header). Calling Fog_Init()
    // here just re-runs Fog_SetupState (harmless, idempotent); every "fog
    // ..." command below reaches this file's own Fog_FogCommand_f through
    // fog_cmd.ts's shared dispatch + glRenderer.fogCommand, since the outer
    // beforeEach set `re.current = glRenderer`.
    Fog_Init();
  });

  const exec = (text: string): void => Cmd_ExecuteString(text, CmdSourceT.src_command);

  test("no args prints the current values and does not change them", () => {
    cl.time = 0;
    Fog_Update(0.42, 0.1, 0.2, 0.3, 0);
    exec("fog");
    expect(Fog_GetDensity()).toBeCloseTo(0.42, 5);
  });

  test("one arg sets density only, color unchanged", () => {
    cl.time = 0;
    Fog_Update(0.1, 0.2, 0.3, 0.4, 0);
    exec("fog 0.8");
    expect(Fog_GetDensity()).toBeCloseTo(0.8, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(0.2, 2);
    expect(c[1]).toBeCloseTo(0.3, 2);
    expect(c[2]).toBeCloseTo(0.4, 2);
  });

  test("three args set r g b only, density unchanged", () => {
    cl.time = 0;
    Fog_Update(0.7, 0, 0, 0, 0);
    exec("fog 0.1 0.2 0.3");
    expect(Fog_GetDensity()).toBeCloseTo(0.7, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(0.1, 2);
    expect(c[1]).toBeCloseTo(0.2, 2);
    expect(c[2]).toBeCloseTo(0.3, 2);
  });

  test("four args set density r g b together", () => {
    exec("fog 0.9 1 0 0.5");
    expect(Fog_GetDensity()).toBeCloseTo(0.9, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(1, 2);
    expect(c[1]).toBeCloseTo(0, 2);
    expect(c[2]).toBeCloseTo(0.5, 2);
  });

  test("r/g/b clamp to [0,1] and density clamps to >=0", () => {
    exec("fog -1 2 -2 3");
    expect(Fog_GetDensity()).toBe(0);
    const c = Fog_GetColor();
    expect(c[0]).toBe(1);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(1);
  });
});

//============================================================================
// U44: the renderer seam (src/client/render.ts's Renderer.fogCommand/
// fogGetState) reaches THIS renderer's Fog_FogCommand_f/Fog_GetDensity/
// Fog_GetColor when it is the active one, without the caller (fog_cmd.ts,
// or a test) needing to know or import which renderer that is.
//============================================================================

describe("glRenderer.fogCommand / fogGetState (U44 seam)", () => {
  const exec = (text: string): void => Cmd_ExecuteString(text, CmdSourceT.src_command);

  test("fogCommand forwards to this renderer's own Fog_FogCommand_f", () => {
    // Fog_FogCommand_f reads Cmd_Argc()/Cmd_Argv() itself (see this file's
    // header note on `args` going unused); Cmd_TokenizeString sets those.
    Cmd_TokenizeString("fog 0.6 1 0 0");
    glRenderer.fogCommand?.(["fog", "0.6", "1", "0", "0"]);
    expect(Fog_GetDensity()).toBeCloseTo(0.6, 5);
    const c = Fog_GetColor();
    expect(c[0]).toBeCloseTo(1, 2);
  });

  test("fogGetState reports the same density/color Fog_GetDensity/Fog_GetColor do", () => {
    Fog_Update(0.33, 0.2, 0.4, 0.6, 0);
    const state = glRenderer.fogGetState?.();
    expect(state).toBeDefined();
    expect(state?.density).toBeCloseTo(Fog_GetDensity(), 6);
    expect(state?.color[0]).toBeCloseTo(Fog_GetColor()[0], 6);
    expect(state?.color[1]).toBeCloseTo(Fog_GetColor()[1], 6);
    expect(state?.color[2]).toBeCloseTo(Fog_GetColor()[2], 6);
  });

  test("the shared 'fog' console command reaches this renderer through re.current, not a direct import", () => {
    // re.current is set to glRenderer by this file's own beforeEach; the
    // "fog" command itself is registered exactly once, at module load, by
    // src/client/fog_cmd.ts -- neither this test nor gl_fog.ts's own
    // Fog_Init ever calls Cmd_AddCommand("fog", ...) (see this file's
    // header note on U44).
    exec("fog 0.77 0 1 0");
    expect(glRenderer.fogGetState?.()?.density).toBeCloseTo(0.77, 5);
  });
});
