/*
Tests for src/ref_soft/draw.ts (WinQuake draw.c's port). Not a ported C file
-- test-only.

Self-sufficient per standing order 13: builds its own synthetic "gfx.wad" in
memory (conchars/disc/backtile), its own scratch id1/pak0.pak fixture (for
Draw_CachePic/Draw_ConsoleBackground's "gfx/conback.lmp"), and its own vid
state; every field this file writes on the shared `vid` / `vidBackend`
singletons is saved before and restored in afterAll. `com_searchpaths` /
`com_gamedir` (common.ts) are `export let` bindings with no restore hook --
test/host.test.ts's and test/sv_main.test.ts's suites leave the same fields
dirty after they run, an already-established precedent this file follows
too (adding one more game directory to the shared search path list has no
effect on any other suite's own lookups, which all resolve their own paths
first since COM_AddGameDirectory prepends).
*/

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SysError } from "../src/platform/sys";
import {
  CMP_NONE,
  TYP_NONE,
  TYP_QPIC,
  WADINFO_T_SIZE,
  LUMPINFO_T_SIZE,
  W_LoadWadFromBytes,
  QpicT,
} from "../src/common/wad";
import { COM_AddGameDirectory } from "../src/common/common";
import { vid, vidBackend, type VidBackend, type VrectT } from "../src/client/vid";
import { ensureDir, writePakToDisk } from "./support/pak_builder";
import {
  Draw_Init,
  Draw_Character,
  Draw_String,
  Draw_Pic,
  Draw_TransPic,
  Draw_TransPicTranslate,
  Draw_TileClear,
  Draw_Fill,
  Draw_FadeScreen,
  Draw_CachePic,
  Draw_ConsoleBackground,
  Draw_BeginDisc,
  Draw_EndDisc,
  draw_disc,
} from "../src/ref_soft/draw";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "draw2d-test-"));

// ---------------------------------------------------------------------------
// gfx.wad fixture: conchars (raw 128x128 bytes), disc (24x24 qpic), backtile
// (64x64 qpic gradient). Loaded via W_LoadWadFromBytes exactly as
// test/wad.test.ts's own builder does.
// ---------------------------------------------------------------------------

const CONCHARS_W = 128;
const CONCHARS_H = 128;
const DISC_W = 24;
const DISC_H = 24;
const BACKTILE_W = 64;
const BACKTILE_H = 64;

// num 65 ('A'): row = 65>>4 = 4, col = 65&15 = 1 -> base offset (row<<10)+(col<<3) = 4104
const A_GLYPH_OFFSET = (4 << 10) + (1 << 3);
// half-zero pattern per 8-pixel row, to exercise the "0 is transparent" rule
const A_ROW_PATTERN = [10, 0, 20, 0, 30, 0, 40, 0];

function buildConchars(): Uint8Array {
  // every character defaults to a uniform nonzero glyph (so
  // Draw_ConsoleBackground's version stamp is observably non-transparent
  // for every character it draws, not only 'A'); 'A' (num 65) gets the
  // half-zero test pattern above, overriding the default for that one cell.
  const bytes = new Uint8Array(CONCHARS_W * CONCHARS_H).fill(7);
  for (let r = 0; r < 8; r++) {
    const off = A_GLYPH_OFFSET + r * 128;
    for (let i = 0; i < 8; i++) bytes[off + i] = A_ROW_PATTERN[i] ?? 0;
  }
  return bytes;
}

function buildQpicBytes(width: number, height: number, pixel: (i: number) => number): Uint8Array {
  const bytes = new Uint8Array(8 + width * height);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  for (let i = 0; i < width * height; i++) bytes[8 + i] = pixel(i) & 0xff;
  return bytes;
}

function writeLumpName(bytes: Uint8Array, offset: number, name: string): void {
  for (let i = 0; i < 16; i++) bytes[offset + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0;
}

function buildGfxWad(): Uint8Array {
  const conchars = buildConchars();
  const disc = buildQpicBytes(DISC_W, DISC_H, (i) => i);
  const backtile = buildQpicBytes(BACKTILE_W, BACKTILE_H, (i) => i); // data[i] = i & 0xff, a plain gradient

  const headerSize = WADINFO_T_SIZE;
  const concharsFilepos = headerSize;
  const discFilepos = concharsFilepos + conchars.length;
  const backtileFilepos = discFilepos + disc.length;
  const infotableofs = backtileFilepos + backtile.length;
  const total = infotableofs + 3 * LUMPINFO_T_SIZE;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 3, true); // numlumps
  view.setInt32(8, infotableofs, true);

  bytes.set(conchars, concharsFilepos);
  bytes.set(disc, discFilepos);
  bytes.set(backtile, backtileFilepos);

  const entries: Array<{ filepos: number; size: number; type: number; name: string }> = [
    { filepos: concharsFilepos, size: conchars.length, type: TYP_NONE, name: "conchars" },
    { filepos: discFilepos, size: disc.length, type: TYP_QPIC, name: "disc" },
    { filepos: backtileFilepos, size: backtile.length, type: TYP_QPIC, name: "backtile" },
  ];

  let o = infotableofs;
  for (const e of entries) {
    view.setInt32(o, e.filepos, true);
    view.setInt32(o + 4, e.size, true);
    view.setInt32(o + 8, e.size, true);
    view.setInt8(o + 12, e.type);
    view.setInt8(o + 13, CMP_NONE);
    view.setInt8(o + 14, 0);
    view.setInt8(o + 15, 0);
    writeLumpName(bytes, o + 16, e.name);
    o += LUMPINFO_T_SIZE;
  }

  return bytes;
}

// ---------------------------------------------------------------------------
// gfx/conback.lmp fixture: a 320x200 qpic, row r filled with byte value
// (r & 0xff), stashed in a scratch id1/pak0.pak so Draw_CachePic finds it
// through a "pack" search entry (COM_FindFile's static_registered
// restriction only ever gates "dir" entries, never "pack" ones, so this
// needs no COM_CheckRegistered/gfx.pop.lmp dance).
// ---------------------------------------------------------------------------

function buildConback(): Uint8Array {
  return buildQpicBytes(320, 200, (i) => Math.floor(i / 320) & 0xff);
}

// ---------------------------------------------------------------------------
// vid / vidBackend fixture state, saved and restored around this whole file.
// ---------------------------------------------------------------------------

const savedBuffer = vid.buffer;
const savedConbuffer = vid.conbuffer;
const savedRowbytes = vid.rowbytes;
const savedConrowbytes = vid.conrowbytes;
const savedWidth = vid.width;
const savedHeight = vid.height;
const savedConwidth = vid.conwidth;
const savedConheight = vid.conheight;
const savedDirect = vid.direct;
const savedBackend = vidBackend.current;

const directRectCalls: Array<{ fn: "begin" | "end"; x: number; y: number; w: number; h: number }> = [];

const testBackend: VidBackend = {
  VID_SetPalette(): void {},
  VID_ShiftPalette(): void {},
  VID_Init(): void {},
  VID_Shutdown(): void {},
  VID_Update(_rects: VrectT | null): void {},
  VID_SetMode(): number {
    return 0;
  },
  VID_HandlePause(): void {},
  VID_LockBuffer(): void {},
  VID_UnlockBuffer(): void {},
  D_BeginDirectRect(x: number, y: number, _pbitmap: Uint8Array, width: number, height: number): void {
    directRectCalls.push({ fn: "begin", x, y, w: width, h: height });
  },
  D_EndDirectRect(x: number, y: number, width: number, height: number): void {
    directRectCalls.push({ fn: "end", x, y, w: width, h: height });
  },
};

const SENTINEL = 0x63;

function freshVidBuffer(): Uint8Array {
  return new Uint8Array(320 * 200).fill(SENTINEL);
}

beforeAll(() => {
  W_LoadWadFromBytes("gfx.wad", buildGfxWad());

  vid.width = 320;
  vid.height = 200;
  vid.rowbytes = 320;
  vid.conwidth = 320;
  vid.conheight = 200;
  vid.conrowbytes = 320;
  vid.direct = null;
  vid.buffer = freshVidBuffer();
  vid.conbuffer = freshVidBuffer();
  vidBackend.current = testBackend;

  Draw_Init();

  ensureDir(join(scratchDir, "id1"));
  writePakToDisk(join(scratchDir, "id1", "pak0.pak"), [{ name: "gfx/conback.lmp", data: buildConback() }]);
  COM_AddGameDirectory(join(scratchDir, "id1"));
});

afterAll(() => {
  vid.buffer = savedBuffer;
  vid.conbuffer = savedConbuffer;
  vid.rowbytes = savedRowbytes;
  vid.conrowbytes = savedConrowbytes;
  vid.width = savedWidth;
  vid.height = savedHeight;
  vid.conwidth = savedConwidth;
  vid.conheight = savedConheight;
  vid.direct = savedDirect;
  vidBackend.current = savedBackend;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("draw.ts (WinQuake draw.c)", () => {
  test("Draw_Init loads draw_disc from the wad as a QpicT", () => {
    expect(draw_disc).not.toBeNull();
    expect(draw_disc?.width).toBe(DISC_W);
    expect(draw_disc?.height).toBe(DISC_H);
  });

  test("Draw_Character('A') writes the glyph's non-zero bytes and leaves zeros untouched", () => {
    vid.conbuffer = freshVidBuffer();
    Draw_Character(8, 8, 65);

    for (let r = 0; r < 8; r++) {
      const rowOfs = (8 + r) * vid.conrowbytes + 8;
      for (let i = 0; i < 8; i++) {
        const expected = A_ROW_PATTERN[i] ?? 0;
        if (expected === 0) {
          expect(vid.conbuffer?.[rowOfs + i]).toBe(SENTINEL); // transparent: untouched
        } else {
          expect(vid.conbuffer?.[rowOfs + i]).toBe(expected);
        }
      }
    }
  });

  test("Draw_Character totally off screen (y <= -8) writes nothing", () => {
    vid.conbuffer = freshVidBuffer();
    Draw_Character(8, -8, 65);
    for (let i = 0; i < 320 * 200; i++) expect(vid.conbuffer?.[i]).toBe(SENTINEL);
  });

  test("Draw_Character negative y clips the top of the glyph", () => {
    vid.conbuffer = freshVidBuffer();
    Draw_Character(8, -3, 65); // drawline = 8 + (-3) = 5 rows, drawn starting at screen y=0

    // 5 rows should be written at screen y=0..4
    for (let r = 0; r < 5; r++) {
      const rowOfs = r * vid.conrowbytes + 8;
      for (let i = 0; i < 8; i++) {
        const expected = A_ROW_PATTERN[i] ?? 0;
        if (expected !== 0) expect(vid.conbuffer?.[rowOfs + i]).toBe(expected);
      }
    }

    // row 5 must be untouched: only 5 lines were drawn, not 8
    const row5Ofs = 5 * vid.conrowbytes + 8;
    for (let i = 0; i < 8; i++) expect(vid.conbuffer?.[row5Ofs + i]).toBe(SENTINEL);
  });

  test("Draw_String advances 8 pixels per character", () => {
    vid.conbuffer = freshVidBuffer();
    Draw_String(0, 16, "AAA");

    for (let charIdx = 0; charIdx < 3; charIdx++) {
      const baseX = charIdx * 8;
      for (let r = 0; r < 8; r++) {
        const rowOfs = (16 + r) * vid.conrowbytes + baseX;
        for (let i = 0; i < 8; i++) {
          const expected = A_ROW_PATTERN[i] ?? 0;
          if (expected !== 0) expect(vid.conbuffer?.[rowOfs + i]).toBe(expected);
        }
      }
    }
  });

  test("Draw_Pic copies a 4x4 pic exactly", () => {
    vid.buffer = freshVidBuffer();
    const pic = new QpicT();
    pic.width = 4;
    pic.height = 4;
    pic.data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    Draw_Pic(10, 20, pic);

    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        const ofs = (20 + v) * vid.rowbytes + 10 + u;
        expect(vid.buffer?.[ofs]).toBe(pic.data[v * 4 + u]);
      }
    }
  });

  test("Draw_Pic Sys_Errors on bad coordinates", () => {
    const pic = new QpicT();
    pic.width = 4;
    pic.height = 4;
    pic.data = new Uint8Array(16);

    expect(() => Draw_Pic(-1, 0, pic)).toThrow(SysError);
    expect(() => Draw_Pic(-1, 0, pic)).toThrow(/Draw_Pic: bad coordinates/);
    expect(() => Draw_Pic(vid.width - 3, 0, pic)).toThrow(SysError); // x + width > vid.width
  });

  test("Draw_TransPic skips TRANSPARENT_COLOR (255)", () => {
    vid.buffer = freshVidBuffer();
    const pic = new QpicT();
    pic.width = 3;
    pic.height = 1;
    pic.data = new Uint8Array([5, 255, 9]);

    Draw_TransPic(0, 0, pic);

    expect(vid.buffer?.[0]).toBe(5);
    expect(vid.buffer?.[1]).toBe(SENTINEL); // 255 (TRANSPARENT_COLOR) left untouched
    expect(vid.buffer?.[2]).toBe(9);
  });

  test("Draw_TransPicTranslate remaps non-transparent bytes through the translation table", () => {
    vid.buffer = freshVidBuffer();
    const pic = new QpicT();
    pic.width = 3;
    pic.height = 1;
    pic.data = new Uint8Array([5, 255, 9]);

    const translation = new Uint8Array(256);
    for (let i = 0; i < 256; i++) translation[i] = i; // identity, except the two remapped below
    translation[5] = 200;
    translation[9] = 201;

    Draw_TransPicTranslate(0, 0, pic, translation);

    expect(vid.buffer?.[0]).toBe(200);
    expect(vid.buffer?.[1]).toBe(SENTINEL); // 255 still skipped, never looked up in translation
    expect(vid.buffer?.[2]).toBe(201);
  });

  test("Draw_TileClear(3, 5, 130, 70) tiles the backtile with the correct phase", () => {
    vid.buffer = freshVidBuffer();
    Draw_TileClear(3, 5, 130, 70);

    // backtile.data[i] = i & 0xff (a plain gradient); the tile at (x,y) reads
    // backtile[(y % 64) * 64 + (x % 64)]
    const expectAt = (x: number, y: number): number => (((y % 64) * 64 + (x % 64)) & 0xff);

    expect(vid.buffer?.[5 * vid.rowbytes + 3]).toBe(expectAt(3, 5));

    // a pixel across the tile seam (x=64 is the start of the second 64-wide tile)
    expect(vid.buffer?.[5 * vid.rowbytes + 64]).toBe(expectAt(64, 5));

    // a pixel in the second tile row (y=64 is the start of the second tile row)
    expect(vid.buffer?.[64 * vid.rowbytes + 3]).toBe(expectAt(3, 64));

    // outside the tiled rect must be untouched
    expect(vid.buffer?.[0]).toBe(SENTINEL);
    expect(vid.buffer?.[199 * vid.rowbytes + 319]).toBe(SENTINEL);
  });

  test("Draw_Fill fills a box with a single color", () => {
    vid.buffer = freshVidBuffer();
    Draw_Fill(10, 10, 5, 3, 42);

    for (let v = 0; v < 3; v++) {
      for (let u = 0; u < 5; u++) {
        expect(vid.buffer?.[(10 + v) * vid.rowbytes + 10 + u]).toBe(42);
      }
    }
    // outside the box is untouched
    expect(vid.buffer?.[10 * vid.rowbytes + 9]).toBe(SENTINEL);
    expect(vid.buffer?.[9 * vid.rowbytes + 10]).toBe(SENTINEL);
  });

  test("Draw_FadeScreen zeroes the checker pattern", () => {
    vid.buffer = freshVidBuffer();
    Draw_FadeScreen();

    for (let y = 0; y < 4; y++) {
      const t = (y & 1) << 1;
      for (let x = 0; x < 8; x++) {
        const ofs = y * vid.rowbytes + x;
        if ((x & 3) !== t) expect(vid.buffer?.[ofs]).toBe(0);
        else expect(vid.buffer?.[ofs]).toBe(SENTINEL);
      }
    }
  });

  test("Draw_CachePic loads gfx/conback.lmp through the pak fixture and returns a QpicT", () => {
    const pic = Draw_CachePic("gfx/conback.lmp");
    expect(pic).not.toBeNull();
    expect(pic?.width).toBe(320);
    expect(pic?.height).toBe(200);

    // second call hits the cache (Cache_Check) instead of reloading; same
    // observable content either way (see draw.ts's file header)
    const pic2 = Draw_CachePic("gfx/conback.lmp");
    expect(pic2?.width).toBe(320);
    expect(pic2?.height).toBe(200);
  });

  test("Draw_ConsoleBackground(100) with conwidth 320 copies the top rows and stamps the version string", () => {
    vid.conwidth = 320;
    vid.conheight = 200;
    vid.conrowbytes = 320;
    vid.conbuffer = freshVidBuffer();

    Draw_ConsoleBackground(100);

    // v = (conheight - lines + y) * 200 / conheight = (200-100+y)*200/200 = 100+y
    // conback row r is filled with (r & 0xff); conwidth==320 takes the memcpy branch
    expect(vid.conbuffer?.[0 * vid.conrowbytes + 0]).toBe(100);
    expect(vid.conbuffer?.[0 * vid.conrowbytes + 200]).toBe(100); // far from the version stamp column
    expect(vid.conbuffer?.[50 * vid.conrowbytes + 0]).toBe(150);

    // version stamp: every character in "(Linux Quake 1.30) 1.09" has a
    // uniform nonzero glyph (buildConchars' default fill), so
    // Draw_CharToConback writes 0x60+7 = 0x67 somewhere within the stamped
    // rows (absolute conback rows 186..193, i.e. displayed y = row-100 =
    // 86..93 for lines=100) instead of the plain (row & 0xff) gradient.
    let sawStamp = false;
    for (let y = 86; y <= 93; y++) {
      const rowOfs = y * vid.conrowbytes;
      for (let x = 0; x < vid.conwidth; x++) {
        if (vid.conbuffer?.[rowOfs + x] === 0x67) sawStamp = true;
      }
    }
    expect(sawStamp).toBe(true);
  });

  test("Draw_BeginDisc / Draw_EndDisc call D_BeginDirectRect / D_EndDirectRect with the disc bitmap", () => {
    directRectCalls.length = 0;
    Draw_BeginDisc();
    Draw_EndDisc();

    expect(directRectCalls).toEqual([
      { fn: "begin", x: vid.width - 24, y: 0, w: 24, h: 24 },
      { fn: "end", x: vid.width - 24, y: 0, w: 24, h: 24 },
    ]);
  });
});
