// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/ref_gl/gl_draw.ts's Draw_Fill under qw.active
(QW/client/gl_draw.c:835).

The one C global `byte *host_basepal` has two holders in this port --
src/common/host.ts's `export let` on the WinQuake track and
src/qw/client/cl_main.ts's `{ data }` box on the qwcl one, whose own
Host_Init is what loads gfx/palette.lmp there. gl_vid.ts and ref_gl.ts each
resolve the pair through a `qw.active ? ... : ...` helper; gl_draw.ts's
Draw_Fill read src/common/host.ts's holder directly, which is null under
qwcl, so `glColor3f` was skipped entirely and every Draw_Fill painted with
whatever color was already current (white). That is what makes the
QuakeWorld scoreboard's per-player top/bottom color bars
(sbar.c's Sbar_DeathmatchOverlay -> Sbar_ColorForMap -> Draw_Fill) draw
white and never change with `color`. test/ref_gl_draw.test.ts covers the
WinQuake side's call sequence but states in its own header that it cannot
set src/common/host.ts's holder; the qwcl holder IS settable, so this file
asserts the exact palette-derived RGB the C computes.

Self-sufficient per standing order 13: installs its own QGLRecording as
`qglHolder.current` and its own synthetic 256-colour palette, and restores
`qglHolder.current`, `qw.active` and the qwcl `host_basepal` box in afterAll
(standing order 15).
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { QGLRecording, SetQGL, qglHolder } from "../src/ref_gl/qgl";
import { GL_QUADS, GL_TEXTURE_2D } from "../src/ref_gl/qgl";
import { Draw_Fill } from "../src/ref_gl/gl_draw";
import { qw } from "../src/common/quakedef";
import { host_basepal as qwHostBasepal } from "../src/qw/client/cl_main";

// A palette whose every entry is distinguishable: color i is (i, 255-i, i^0x55).
function buildPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i;
    pal[i * 3 + 1] = 255 - i;
    pal[i * 3 + 2] = i ^ 0x55;
  }
  return pal;
}

const savedQgl = qglHolder.current;
const savedQwActive = qw.active;
const savedQwBasepal = qwHostBasepal.data;

const palette = buildPalette();
let rec = new QGLRecording();

beforeAll(() => {
  rec = new QGLRecording();
  SetQGL(rec);
  qw.active = true;
  qwHostBasepal.data = palette;
});

afterAll(() => {
  qglHolder.current = savedQgl;
  qw.active = savedQwActive;
  qwHostBasepal.data = savedQwBasepal;
});

beforeEach(() => {
  rec.clear();
});

function colorCalls(): { readonly name: string; readonly args: readonly unknown[] }[] {
  return rec.calls.filter((c) => c.name === "qglColor3f");
}

describe("Draw_Fill under qw.active", () => {
  test("takes its color from the qwcl host_basepal holder", () => {
    Draw_Fill(10, 20, 40, 4, 72);

    const colors = colorCalls();
    expect(colors.length).toBe(2);
    // glColor3f (host_basepal[c*3]/255.0, [c*3+1]/255.0, [c*3+2]/255.0)
    expect(colors[0]).toEqual({
      name: "qglColor3f",
      args: [palette[72 * 3] / 255.0, palette[72 * 3 + 1] / 255.0, palette[72 * 3 + 2] / 255.0],
    });
    // ... glColor3f (1,1,1) afterwards
    expect(colors[1]).toEqual({ name: "qglColor3f", args: [1, 1, 1] });
  });

  test("two different palette indices produce two different colors", () => {
    // Sbar_ColorForMap(4) and Sbar_ColorForMap(12): 4*16+8 and 12*16+8
    Draw_Fill(0, 0, 40, 4, 72);
    const top = colorCalls()[0];
    rec.clear();
    Draw_Fill(0, 4, 40, 4, 200);
    const bottom = colorCalls()[0];

    expect(top).not.toEqual(bottom);
    expect(top.args).toEqual([palette[216] / 255.0, palette[217] / 255.0, palette[218] / 255.0]);
    expect(bottom.args).toEqual([palette[600] / 255.0, palette[601] / 255.0, palette[602] / 255.0]);
  });

  test("still emits gl_draw.c's full quad sequence around the color", () => {
    Draw_Fill(10, 20, 5, 3, 42);

    expect(rec.calls[0]).toEqual({ name: "qglDisable", args: [GL_TEXTURE_2D] });
    const beginIdx = rec.calls.findIndex((c) => c.name === "qglBegin");
    expect(rec.calls[beginIdx]).toEqual({ name: "qglBegin", args: [GL_QUADS] });
    expect(rec.calls[beginIdx + 1]).toEqual({ name: "qglVertex2f", args: [10, 20] });
    expect(rec.calls[beginIdx + 2]).toEqual({ name: "qglVertex2f", args: [15, 20] });
    expect(rec.calls[beginIdx + 3]).toEqual({ name: "qglVertex2f", args: [15, 23] });
    expect(rec.calls[beginIdx + 4]).toEqual({ name: "qglVertex2f", args: [10, 23] });
    expect(rec.calls[beginIdx + 5]).toEqual({ name: "qglEnd", args: [] });
    expect(rec.calls[beginIdx + 6]).toEqual({ name: "qglColor3f", args: [1, 1, 1] });
    expect(rec.calls[beginIdx + 7]).toEqual({ name: "qglEnable", args: [GL_TEXTURE_2D] });
  });
});
