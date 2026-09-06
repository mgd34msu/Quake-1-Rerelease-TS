import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { FloorDivMod, vec3 } from "../src/common/mathlib";
import { cl } from "../src/client/client";
import { vid } from "../src/client/vid";
import { scr_vrect } from "../src/client/screen_types";
import { MspriteframeT, MtriangleT } from "../src/ref_soft/model_types";
import {
  CYCLE,
  EmitpointT,
  ParticleT,
  allocFinalverts,
  r_affinetridesc,
  r_ppn,
  r_pright,
  r_pup,
  r_spritedesc,
  r_zpointdesc,
} from "../src/ref_soft/d_iface";
import { R_SKY_SMASK, R_SKY_TMASK, buildScantable, buildZspantable } from "../src/ref_soft/d_local";
import {
  AMP,
  AMP2,
  EspanT,
  SIN_BUFFER_SIZE,
  intsintable,
  modelorg,
  r_origin,
  r_refdef,
  rState,
  sintable,
  vpn,
  vright,
  vup,
} from "../src/ref_soft/r_local";
import { D_DrawSpans8, D_DrawZSpans, Turbulent8 } from "../src/ref_soft/d_scan";
import { D_WarpScreen } from "../src/ref_soft/d_scan";
import { D_Sky_uv_To_st, D_DrawSkyScans8 } from "../src/ref_soft/d_sky";
import { D_DrawZPoint } from "../src/ref_soft/d_zpoint";
import { D_DrawParticle } from "../src/ref_soft/d_part";
import { D_DrawSprite } from "../src/ref_soft/d_sprite";
import { D_FillRect } from "../src/ref_soft/d_fill";
import {
  D_PolysetDraw,
  D_PolysetSetUpForLineScan,
  D_PolysetUpdateTables,
  r_p0,
  r_p1,
  r_p2,
} from "../src/ref_soft/d_polyse";

const WIDTH = 64;
const HEIGHT = 32;

const screen = new Uint8Array(WIDTH * HEIGHT);
const zbuffer = new Int16Array(WIDTH * HEIGHT);

// r_main.c's R_InitTurb, inline so this suite does not depend on r_main.ts
// having been loaded.
function initTurbTables(): void {
  for (let i = 0; i < SIN_BUFFER_SIZE; i++) {
    sintable[i] = (AMP + Math.sin((i * 3.14159 * 2) / CYCLE) * AMP) | 0;
    intsintable[i] = (AMP2 + Math.sin((i * 3.14159 * 2) / CYCLE) * AMP2) | 0;
  }
}

function clearBuffers(): void {
  screen.fill(0);
  zbuffer.fill(0);
}

// every global this suite writes, so it can put them back for the next file
const saved = {
  vid_buffer: vid.buffer,
  vid_colormap: vid.colormap,
  vid_rowbytes: vid.rowbytes,
  vid_width: vid.width,
  vid_height: vid.height,
  cl_time: cl.time,
  scr_x: scr_vrect.x,
  scr_y: scr_vrect.y,
  scr_w: scr_vrect.width,
  scr_h: scr_vrect.height,
};

beforeAll(() => {
  initTurbTables();

  vid.buffer = screen;
  vid.rowbytes = WIDTH;
  vid.width = WIDTH;
  vid.height = HEIGHT;
  vid.colormap = new Uint8Array(256 * 64);
  for (let i = 0; i < 256 * 64; i++) vid.colormap[i] = i & 0xff;

  rState.d_viewbuffer = screen;
  rState.d_pzbuffer = zbuffer;
  rState.d_zwidth = WIDTH;
  rState.d_zrowbytes = WIDTH * 2;
  rState.screenwidth = WIDTH;

  buildScantable(HEIGHT, WIDTH);
  buildZspantable(HEIGHT, WIDTH);

  rState.xcenter = WIDTH / 2;
  rState.ycenter = HEIGHT / 2;
  rState.xscale = 1;
  rState.yscale = 1;
  rState.xscaleinv = 1;
  rState.yscaleinv = 1;

  r_refdef.vrect.x = 0;
  r_refdef.vrect.y = 0;
  r_refdef.vrect.width = WIDTH;
  r_refdef.vrect.height = HEIGHT;
  r_refdef.vrectright = WIDTH;
  r_refdef.vrectbottom = HEIGHT;
  r_refdef.fvrectx_adj = 0;
  r_refdef.fvrecty_adj = 0;
  r_refdef.fvrectright_adj = WIDTH;
  r_refdef.fvrectbottom_adj = HEIGHT;

  cl.time = 0;
});

afterAll(() => {
  vid.buffer = saved.vid_buffer;
  vid.colormap = saved.vid_colormap;
  vid.rowbytes = saved.vid_rowbytes;
  vid.width = saved.vid_width;
  vid.height = saved.vid_height;
  cl.time = saved.cl_time;
  scr_vrect.x = saved.scr_x;
  scr_vrect.y = saved.scr_y;
  scr_vrect.width = saved.scr_w;
  scr_vrect.height = saved.scr_h;

  rState.d_viewbuffer = null;
  rState.d_pzbuffer = null;
  rState.cacheblock = null;
  rState.cachewidth = 0;
  rState.acolormap = null;
  rState.r_skysource = null;
  rState.d_zwidth = 0;
  rState.d_zrowbytes = 0;
  rState.screenwidth = 0;
  rState.xcenter = 0;
  rState.ycenter = 0;
  rState.xscale = 0;
  rState.yscale = 0;
  rState.xscaleinv = 0;
  rState.yscaleinv = 0;
  rState.d_sdivzstepu = 0;
  rState.d_tdivzstepu = 0;
  rState.d_zistepu = 0;
  rState.d_sdivzstepv = 0;
  rState.d_tdivzstepv = 0;
  rState.d_zistepv = 0;
  rState.d_sdivzorigin = 0;
  rState.d_tdivzorigin = 0;
  rState.d_ziorigin = 0;
  rState.sadjust = 0;
  rState.tadjust = 0;
  rState.bbextents = 0;
  rState.bbextentt = 0;
  rState.d_vrectx = 0;
  rState.d_vrecty = 0;
  rState.d_vrectright_particle = 0;
  rState.d_vrectbottom_particle = 0;
  rState.d_pix_min = 0;
  rState.d_pix_max = 0;
  rState.d_pix_shift = 0;
  rState.d_y_aspect_shift = 0;
  rState.r_dowarp = false;
  rState.skytime = 0;
  rState.skyspeed = 0;
  rState.ubasestep = 0;
  rState.errorterm = 0;
  rState.erroradjustup = 0;
  rState.erroradjustdown = 0;

  r_refdef.vrect.x = 0;
  r_refdef.vrect.y = 0;
  r_refdef.vrect.width = 0;
  r_refdef.vrect.height = 0;
  r_refdef.vrectright = 0;
  r_refdef.vrectbottom = 0;
  r_refdef.fvrectx_adj = 0;
  r_refdef.fvrecty_adj = 0;
  r_refdef.fvrectright_adj = 0;
  r_refdef.fvrectbottom_adj = 0;

  r_affinetridesc.clear();
  r_spritedesc.clear();
  r_zpointdesc.clear();

  sintable.fill(0);
  intsintable.fill(0);
});

// a wall facing the viewer: 1/z is constant 1, so z == 0x10000 and one screen
// pixel steps s by exactly one texel
function setUnitGradients(): void {
  rState.d_sdivzorigin = 0;
  rState.d_sdivzstepu = 1;
  rState.d_sdivzstepv = 0;
  rState.d_tdivzorigin = 0;
  rState.d_tdivzstepu = 0;
  rState.d_tdivzstepv = 0;
  rState.d_ziorigin = 1;
  rState.d_zistepu = 0;
  rState.d_zistepv = 0;
  rState.sadjust = 0;
  rState.tadjust = 0;
}

describe("D_DrawSpans8", () => {
  test("writes the expected texels for a 1:1 wall span", () => {
    clearBuffers();

    const cacheblock = new Uint8Array(16 * 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) cacheblock[y * 16 + x] = (x + y) & 1 ? 200 : 100;
    }
    rState.cacheblock = cacheblock;
    rState.cachewidth = 16;

    setUnitGradients();
    rState.bbextents = (16 << 16) - 1;
    rState.bbextentt = (16 << 16) - 1;

    const span = new EspanT();
    span.u = 4;
    span.v = 3;
    span.count = 8;
    span.pnext = null;

    D_DrawSpans8(span);

    for (let k = 0; k < 8; k++) {
      expect(screen[3 * WIDTH + 4 + k]).toBe(cacheblock[4 + k]);
    }
    // nothing outside the span
    expect(screen[3 * WIDTH + 3]).toBe(0);
    expect(screen[3 * WIDTH + 12]).toBe(0);
    expect(screen[2 * WIDTH + 4]).toBe(0);
  });
});

describe("D_DrawZSpans", () => {
  test("writes izi >> 16 across the span", () => {
    clearBuffers();

    // 1/z chosen so izi = (zi * 0x8000 * 0x10000) is exactly 100 << 16 at u=4
    // and steps by one unit per pixel
    rState.d_zistepu = 1 / 32768;
    rState.d_zistepv = 0;
    rState.d_ziorigin = 96 / 32768;

    const span = new EspanT();
    span.u = 4;
    span.v = 3;
    span.count = 8;
    span.pnext = null;

    D_DrawZSpans(span);

    for (let k = 0; k < 8; k++) {
      expect(zbuffer[3 * WIDTH + 4 + k]).toBe(100 + k);
    }
    expect(zbuffer[3 * WIDTH + 3]).toBe(0);
    expect(zbuffer[3 * WIDTH + 12]).toBe(0);
  });
});

describe("D_DrawZPoint", () => {
  test("writes when nearer and rejects when farther", () => {
    clearBuffers();

    r_zpointdesc.u = 9;
    r_zpointdesc.v = 5;
    r_zpointdesc.zi = 0.5; // izi = 16384
    r_zpointdesc.color = 42;

    D_DrawZPoint();

    expect(zbuffer[5 * WIDTH + 9]).toBe(16384);
    expect(screen[5 * WIDTH + 9]).toBe(42);

    // a point behind what is already there is rejected
    zbuffer[5 * WIDTH + 9] = 20000;
    screen[5 * WIDTH + 9] = 0;

    D_DrawZPoint();

    expect(zbuffer[5 * WIDTH + 9]).toBe(20000);
    expect(screen[5 * WIDTH + 9]).toBe(0);
  });
});

describe("D_DrawParticle", () => {
  beforeAll(() => {
    r_pright[0] = 1;
    r_pright[1] = 0;
    r_pright[2] = 0;
    r_pup[0] = 0;
    r_pup[1] = 1;
    r_pup[2] = 0;
    r_ppn[0] = 0;
    r_ppn[1] = 0;
    r_ppn[2] = 1;
    r_origin[0] = 0;
    r_origin[1] = 0;
    r_origin[2] = 0;

    rState.d_pix_shift = 8;
    rState.d_pix_min = 1;
    rState.d_pix_max = 4;
    rState.d_y_aspect_shift = 0;
    rState.d_vrectx = 0;
    rState.d_vrecty = 0;
    rState.d_vrectright_particle = WIDTH - 4;
    rState.d_vrectbottom_particle = HEIGHT - 4;
  });

  test("draws a pix x pix block with the z test", () => {
    clearBuffers();

    const p = new ParticleT();
    p.org[0] = 0;
    p.org[1] = 0;
    p.org[2] = 32; // zi = 1/32, izi = 1024, pix = 1024 >> 8 = 4
    p.color = 111;

    D_DrawParticle(p);

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(screen[(16 + y) * WIDTH + 32 + x]).toBe(111);
        expect(zbuffer[(16 + y) * WIDTH + 32 + x]).toBe(1024);
      }
    }
    expect(screen[16 * WIDTH + 31]).toBe(0);
    expect(screen[16 * WIDTH + 36]).toBe(0);
    expect(screen[20 * WIDTH + 32]).toBe(0);
  });

  test("skips a particle behind the near clip", () => {
    clearBuffers();

    const p = new ParticleT();
    p.org[0] = 0;
    p.org[1] = 0;
    p.org[2] = 4; // < PARTICLE_Z_CLIP (8)
    p.color = 111;

    D_DrawParticle(p);

    expect(screen.some((b) => b !== 0)).toBe(false);
    expect(zbuffer.some((z) => z !== 0)).toBe(false);
  });
});

describe("D_DrawSprite", () => {
  test("draws the opaque texels of a 4x4 sprite and its z", () => {
    clearBuffers();

    vright[0] = 1;
    vright[1] = 0;
    vright[2] = 0;
    vup[0] = 0;
    vup[1] = 1;
    vup[2] = 0;
    vpn[0] = 0;
    vpn[1] = 0;
    vpn[2] = 1;

    modelorg[0] = 0;
    modelorg[1] = 0;
    modelorg[2] = -64;

    rState.xscaleinv = 1 / 64;
    rState.yscaleinv = 1 / 64;

    const pixels = new Uint8Array(4 * 4);
    for (let i = 0; i < 16; i++) pixels[i] = 10 + i;
    pixels[5] = 255; // the transparent texel

    const frame = new MspriteframeT();
    frame.width = 4;
    frame.height = 4;
    frame.pixels = pixels;
    r_spritedesc.pspriteframe = frame;

    // r_sprite.c sizes pverts MAXWORKINGVERTS + 1 so D_DrawSprite can copy
    // vertex 0 to slot [nump]
    const verts: EmitpointT[] = [];
    for (let i = 0; i < 5; i++) verts.push(new EmitpointT());
    r_spritedesc.pverts = verts;
    r_spritedesc.vpn[0] = 0;
    r_spritedesc.vpn[1] = 0;
    r_spritedesc.vpn[2] = 1;
    r_spritedesc.vright[0] = 1;
    r_spritedesc.vright[1] = 0;
    r_spritedesc.vright[2] = 0;
    r_spritedesc.vup[0] = 0;
    r_spritedesc.vup[1] = 1;
    r_spritedesc.vup[2] = 0;

    // screen quad (30,14) (34,14) (34,18) (30,18): going forward from the top
    // vertex is the right edge, backward is the left edge
    const quad: Array<[number, number]> = [
      [30, 14],
      [34, 14],
      [34, 18],
      [30, 18],
    ];
    const pverts = r_spritedesc.pverts;
    expect(pverts).not.toBeNull();
    if (pverts !== null) {
      for (let i = 0; i < 4; i++) {
        pverts[i].u = quad[i][0];
        pverts[i].v = quad[i][1];
        pverts[i].s = 0;
        pverts[i].t = 0;
        pverts[i].zi = 1 / 64;
      }
    }
    r_spritedesc.nump = 4;

    D_DrawSprite();

    // texel (s,t) at screen (u,v) is (u-30, v-14); pixels[5] is transparent
    for (let t = 0; t < 4; t++) {
      for (let s = 0; s < 4; s++) {
        const at = (14 + t) * WIDTH + 30 + s;
        if (t === 1 && s === 1) {
          expect(screen[at]).toBe(0);
          expect(zbuffer[at]).toBe(0);
        } else {
          expect(screen[at]).toBe(pixels[t * 4 + s]);
          expect(zbuffer[at]).toBe(512); // (1/64) * 0x8000 * 0x10000 >> 16
        }
      }
    }
    expect(screen[14 * WIDTH + 29]).toBe(0);
    expect(screen[18 * WIDTH + 30]).toBe(0);
  });
});

describe("D_PolysetDraw", () => {
  const skin = new Uint8Array(8 * 8);
  const colormap = new Uint8Array(256 * 64);

  function setupTriangle(drawtype: number): void {
    clearBuffers();

    skin.fill(0);
    skin[0] = 77;
    for (let i = 0; i < 256 * 64; i++) colormap[i] = i & 0xff;
    rState.acolormap = colormap;

    const fv = allocFinalverts(3);
    const verts: Array<[number, number]> = [
      [10, 4],
      [26, 4],
      [18, 20],
    ];
    for (let i = 0; i < 3; i++) {
      fv[i].v[0] = verts[i][0]; // u
      fv[i].v[1] = verts[i][1]; // v
      fv[i].v[2] = 0; // s
      fv[i].v[3] = 0; // t
      fv[i].v[4] = 0; // light
      fv[i].v[5] = 100 << 16; // 1/z
      fv[i].flags = 0;
    }

    const tri = new MtriangleT();
    tri.facesfront = 1;
    tri.vertindex[0] = 0;
    tri.vertindex[1] = 1;
    tri.vertindex[2] = 2;

    r_affinetridesc.pskin = skin;
    r_affinetridesc.skinwidth = 8;
    r_affinetridesc.skinheight = 8;
    r_affinetridesc.pfinalverts = fv;
    r_affinetridesc.ptriangles = [tri];
    r_affinetridesc.numtriangles = 1;
    r_affinetridesc.drawtype = drawtype;
    r_affinetridesc.seamfixupX16 = 0;

    D_PolysetUpdateTables();
  }

  function drawnPixels(): number {
    let n = 0;
    for (let i = 0; i < screen.length; i++) if (screen[i] !== 0) n++;
    return n;
  }

  test("non-subdiv rasterizes a filled triangle with z", () => {
    setupTriangle(0);

    D_PolysetDraw();

    const n = drawnPixels();
    // triangle area is 0.5 * 16 * 16 = 128; the fill rule and the edge
    // stepping put the count within an edge's worth of that
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(170);

    // the top row spans the full 16 pixels between the two flat-top vertices
    for (let x = 10; x < 26; x++) {
      expect(screen[4 * WIDTH + x]).toBe(77);
      expect(zbuffer[4 * WIDTH + x]).toBe(100);
    }

    // every drawn pixel came from skin[0] through the identity colormap, and
    // carries the triangle's constant 1/z
    for (let i = 0; i < screen.length; i++) {
      if (screen[i] !== 0) {
        expect(screen[i]).toBe(77);
        expect(zbuffer[i]).toBe(100);
      }
    }
  });

  test("subdiv covers a similar pixel count", () => {
    setupTriangle(0);
    D_PolysetDraw();
    const flat = drawnPixels();

    setupTriangle(1);
    D_PolysetDraw();
    const subdivided = drawnPixels();

    expect(subdivided).toBeGreaterThan(flat * 0.5);
    expect(subdivided).toBeLessThan(flat * 1.5);

    for (let i = 0; i < screen.length; i++) {
      if (screen[i] !== 0) expect(screen[i]).toBe(77);
    }
  });
});

describe("D_PolysetSetUpForLineScan", () => {
  test("agrees with FloorDivMod inside and outside the adivtab range", () => {
    const cases: Array<[number, number]> = [
      [8, 16],
      [-8, 16],
      [0, 5],
      [16, 1],
      [-15, 12],
      [40, 17], // outside the table: falls through to FloorDivMod
      [-100, 33],
      [200, 7],
    ];

    for (const [tm, tn] of cases) {
      D_PolysetSetUpForLineScan(0, 0, tm, tn);
      const expected = FloorDivMod(tm, tn);
      expect(rState.ubasestep).toBe(expected.quotient);
      expect(rState.erroradjustup).toBe(expected.rem);
      expect(rState.erroradjustdown).toBe(tn);
      expect(rState.errorterm).toBe(-1);
    }
  });
});

describe("Turbulent8", () => {
  test("writes the sintable-warped 64x64 lookup", () => {
    clearBuffers();

    const turbtex = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) turbtex[y * 64 + x] = ((x * 7 + y * 13) & 0xff) | 1;
    }
    rState.cacheblock = turbtex;
    rState.cachewidth = 64;

    setUnitGradients();
    rState.bbextents = (64 << 16) - 1;
    rState.bbextentt = (64 << 16) - 1;

    cl.time = 0;

    const span = new EspanT();
    span.u = 4;
    span.v = 3;
    span.count = 16;
    span.pnext = null;

    Turbulent8(span);

    // d_scan.c's own arithmetic, written out here from the C so the span walk
    // and the table indexing are checked rather than assumed
    const turb = 0; // (int)(cl.time*SPEED) & (CYCLE-1) with cl.time == 0
    let s = ((4 << 16) | 0) & ((CYCLE << 16) - 1);
    let t = 0;
    // count == 16 exactly, so the C takes the "last pixel in span" branch:
    // snext at u = 4+15, tnext clamped up to 16
    const snext = 19 << 16;
    const tnext = 16;
    const sstep = ((snext - s) / 15) | 0;
    const tstep = ((tnext - t) / 15) | 0;

    for (let j = 0; j < 16; j++) {
      const sturb = ((s + sintable[turb + ((t >> 16) & (CYCLE - 1))]) >> 16) & 63;
      const tturb = ((t + sintable[turb + ((s >> 16) & (CYCLE - 1))]) >> 16) & 63;
      expect(screen[3 * WIDTH + 4 + j]).toBe(turbtex[(tturb << 6) + sturb]);
      s = (s + sstep) | 0;
      t = (t + tstep) | 0;
    }
  });
});

describe("D_DrawSkyScans8", () => {
  test("writes texels from r_skysource", () => {
    clearBuffers();

    // r_sky.c's newsky is 128 rows of 256 bytes; the t index is scaled by that
    // stride, which is why d_sky.c shifts t right by 8 and s right by 16
    const sky = new Uint8Array(128 * 256);
    for (let i = 0; i < sky.length; i++) sky[i] = (i & 0xfe) | 1;
    rState.r_skysource = sky;

    vpn[0] = 0;
    vpn[1] = 0;
    vpn[2] = 1;
    vright[0] = 1;
    vright[1] = 0;
    vright[2] = 0;
    vup[0] = 0;
    vup[1] = 1;
    vup[2] = 0;
    rState.skytime = 0;
    rState.skyspeed = 0;

    const span = new EspanT();
    span.u = 8;
    span.v = 6;
    span.count = 16;
    span.pnext = null;

    D_DrawSkyScans8(span);

    const st = new Int32Array(2);
    D_Sky_uv_To_st(8, 6, st);
    const expectedFirst = sky[((st[1] & R_SKY_TMASK) >> 8) + ((st[0] & R_SKY_SMASK) >> 16)];
    expect(screen[6 * WIDTH + 8]).toBe(expectedFirst);

    for (let j = 0; j < 16; j++) expect(screen[6 * WIDTH + 8 + j]).not.toBe(0);
    expect(screen[6 * WIDTH + 7]).toBe(0);
    expect(screen[6 * WIDTH + 24]).toBe(0);
  });
});

describe("D_WarpScreen", () => {
  test("copies the warp buffer into vid.buffer through the sine tables", () => {
    screen.fill(0);

    const warpbuffer = new Uint8Array(WIDTH * HEIGHT);
    for (let i = 0; i < warpbuffer.length; i++) warpbuffer[i] = (i & 0xff) | 1;
    rState.d_viewbuffer = warpbuffer;
    rState.r_dowarp = true;

    scr_vrect.x = 0;
    scr_vrect.y = 0;
    scr_vrect.width = 8;
    scr_vrect.height = 8;
    r_refdef.vrect.x = 0;
    r_refdef.vrect.y = 0;
    r_refdef.vrect.width = 8;
    r_refdef.vrect.height = 8;

    cl.time = 0;

    // intsintable[0] is AMP2 + sin(0)*AMP2 == 3, so the top-left output pixel
    // samples rowptr[0+3] + column[3+0]: row (int)(3*8/14) == 1, column
    // (int)(3*8/14) == 1, i.e. warp buffer index 1*screenwidth + 1
    expect(intsintable[0]).toBe(3);

    D_WarpScreen();

    expect(screen[0]).toBe(warpbuffer[1 * WIDTH + 1]);

    // and the whole 8x8 destination was written from a buffer with no zeroes
    for (let v = 0; v < 8; v++) {
      for (let u = 0; u < 8; u++) expect(screen[v * WIDTH + u]).not.toBe(0);
    }

    rState.d_viewbuffer = screen;
    rState.r_dowarp = false;
    r_refdef.vrect.width = WIDTH;
    r_refdef.vrect.height = HEIGHT;
  });
});

describe("D_FillRect", () => {
  test("clips a rect that starts off the top left", () => {
    clearBuffers();

    D_FillRect({ x: -4, y: -4, width: 16, height: 16, pnext: null }, 9);

    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) expect(screen[y * WIDTH + x]).toBe(9);
    }
    expect(screen[0 * WIDTH + 12]).toBe(0);
    expect(screen[12 * WIDTH + 0]).toBe(0);
  });

  test("drops a rect that clips away to nothing", () => {
    clearBuffers();

    D_FillRect({ x: -20, y: 0, width: 16, height: 16, pnext: null }, 9);

    expect(screen.some((b) => b !== 0)).toBe(false);
  });

  test("preserved C bug: the bottom clamp uses rx, not ry", () => {
    clearBuffers();

    // ry + rheight (40) > vid.height (32), so the C sets rheight to
    // vid.height - rx == 22 instead of vid.height - ry == 2, and runs off the
    // bottom of the buffer
    D_FillRect({ x: 10, y: 30, width: 4, height: 10, pnext: null }, 5);

    for (let x = 10; x < 14; x++) {
      expect(screen[30 * WIDTH + x]).toBe(5);
      expect(screen[31 * WIDTH + x]).toBe(5);
    }
    expect(screen[29 * WIDTH + 10]).toBe(0);
  });
});

// r_p0/r_p1/r_p2 are exported so the edge table's "pointers" can be inspected
test("d_polyse exports the three vertex registers the edge table points at", () => {
  expect(r_p0.length).toBe(6);
  expect(r_p1.length).toBe(6);
  expect(r_p2.length).toBe(6);
});
