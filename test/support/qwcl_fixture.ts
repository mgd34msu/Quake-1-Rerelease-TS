// Test helper: builds a scratch `-basedir` a real qwcl boot can run against.
// Same scratch-basedir recipe as test/support/qwsv_fixture.ts, plus the four
// client-only assets QW/client/cl_main.c's Host_Init loads before it can
// bring the video and console up:
//
//   id1/pak0.pak   gfx/pop.lmp        COM_CheckRegistered ("Playing
//                                     registered version.")
//                  gfx.wad            W_LoadWadFile("gfx.wad") -- one lump
//                                     per name Draw_Init, SCR_Init and
//                                     Sbar_Init ask for by name; a missing
//                                     one is a Sys_Error in W_GetLumpinfo,
//                                     not a null.
//                  gfx/palette.lmp    host_basepal, 256 RGB triples
//                  gfx/colormap.lmp   host_colormap, 64 rows of 256 entries;
//                                     ints[2048] is what VID_Init reads for
//                                     vid.fullbright
//                  gfx/conback.lmp    Draw_ConsoleBackground's 320x200 qpic
//   id1/quake.rc   Host_Init's `exec quake.rc`; `stuffcmds` is what turns a
//   id1/default.cfg  `+cmd` on the command line into a real command, exactly
//                  as test/support/dedicated_fixture.ts's pair does.
//   qw/            Host_Init's Sys_mkdir("qw") makes this itself; created
//                  here too so COM_AddGameDirectory has it from the start.
//
// The pictures are synthetic and tiny (8x8, or 16x16 for "backtile", whose
// size the software renderer's tile-clear rectangle is built from): nothing
// in a boot reads their pixels for anything but drawing them.
//
// Not a ported C file -- test infrastructure only.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pop } from "../../src/qw/common";
import { writePakToDisk } from "./pak_builder";
import { ensureDir, writeGameFile } from "./bsp_builder";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../../src/common/wad";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");

const TYP_QPIC = 0x42;

// Every lump name the qwcl boot asks for by name: src/ref_soft/draw.ts's
// Draw_Init (conchars/disc/backtile), src/qw/client/screen.ts's SCR_Init
// (ram/net/turtle) and src/qw/client/sbar.ts's Sbar_Init (the rest, in its
// own order).
function sbarLumpNames(): string[] {
  const names: string[] = [];
  for (let i = 0; i < 10; i++) {
    names.push(`num_${i}`, `anum_${i}`);
  }
  names.push("num_minus", "anum_minus", "num_colon", "num_slash");

  const weapons = ["shotgun", "sshotgun", "nailgun", "snailgun", "rlaunch", "srlaunch", "lightng"];
  for (const w of weapons) names.push(`inv_${w}`, `inv2_${w}`);
  for (let i = 1; i <= 5; i++) for (const w of weapons) names.push(`inva${i}_${w}`);

  names.push("sb_shells", "sb_nails", "sb_rocket", "sb_cells");
  names.push("sb_armor1", "sb_armor2", "sb_armor3");
  names.push("sb_key1", "sb_key2", "sb_invis", "sb_invuln", "sb_suit", "sb_quad");
  names.push("sb_sigil1", "sb_sigil2", "sb_sigil3", "sb_sigil4");
  for (let i = 1; i <= 5; i++) names.push(`face${i}`, `face_p${i}`);
  names.push("face_invis", "face_invul2", "face_inv2", "face_quad");
  names.push("sbar", "ibar", "scorebar");
  return names;
}

// qpic_t on disk: two little-endian ints, then width*height palette indices.
function buildQpicLump(width: number, height: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(8 + width * height);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  bytes.fill(fill, 8);
  return bytes;
}

interface WadLump {
  name: string;
  type: number;
  data: Uint8Array;
}

function buildWad2(lumps: readonly WadLump[]): Uint8Array {
  let dataBytes = 0;
  for (const l of lumps) dataBytes += l.data.length;

  const infotableofs = WADINFO_T_SIZE + dataBytes;
  const bytes = new Uint8Array(infotableofs + lumps.length * LUMPINFO_T_SIZE);
  const view = new DataView(bytes.buffer);

  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, infotableofs, true);

  let filepos = WADINFO_T_SIZE;
  let infoOfs = infotableofs;
  for (const l of lumps) {
    bytes.set(l.data, filepos);
    view.setInt32(infoOfs, filepos, true);
    view.setInt32(infoOfs + 4, l.data.length, true);
    view.setInt32(infoOfs + 8, l.data.length, true);
    view.setInt8(infoOfs + 12, l.type);
    // W_CleanupName upper-cases and truncates to 15 chars; the names here are
    // already short and lower-case, which is what the lookup passes in too.
    for (let i = 0; i < l.name.length && i < 15; i++) bytes[infoOfs + 16 + i] = l.name.charCodeAt(i);
    filepos += l.data.length;
    infoOfs += LUMPINFO_T_SIZE;
  }
  return bytes;
}

function buildGfxWad(): Uint8Array {
  const lumps: WadLump[] = [
    // draw_chars: a raw 128x128 block of 8x8 characters, no qpic header.
    { name: "conchars", type: 0, data: new Uint8Array(128 * 128) },
    { name: "disc", type: TYP_QPIC, data: buildQpicLump(8, 8, 1) },
    { name: "backtile", type: TYP_QPIC, data: buildQpicLump(16, 16, 2) },
    { name: "ram", type: TYP_QPIC, data: buildQpicLump(8, 8, 3) },
    { name: "net", type: TYP_QPIC, data: buildQpicLump(8, 8, 4) },
    { name: "turtle", type: TYP_QPIC, data: buildQpicLump(8, 8, 5) },
  ];
  for (const name of sbarLumpNames()) lumps.push({ name, type: TYP_QPIC, data: buildQpicLump(8, 8, 6) });
  return buildWad2(lumps);
}

// 256 RGB triples, a plain grey ramp.
function buildPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i;
    pal[i * 3 + 1] = i;
    pal[i * 3 + 2] = i;
  }
  return pal;
}

// 64 shade rows of 256 entries. Identity rows keep every lookup in range;
// VID_Init reads ints[2048] (byte 8192) for `vid.fullbright = 256 - that`,
// so those four bytes carry 224, giving the retail data's 32 fullbrights.
function buildColormap(): Uint8Array {
  const cmap = new Uint8Array(256 * 64);
  for (let row = 0; row < 64; row++) for (let i = 0; i < 256; i++) cmap[row * 256 + i] = i;
  cmap[8192] = 224;
  cmap[8193] = 0;
  cmap[8194] = 0;
  cmap[8195] = 0;
  return cmap;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface QwclFixture {
  scratchDir: string;
  baseDir: string;
}

// `prefix` becomes the mkdtemp() prefix, so two fixtures built in the same
// test file never collide.
export function buildQwclFixture(prefix: string): QwclFixture {
  mkdirSync(scratchRoot, { recursive: true });
  const scratchDir = mkdtempSync(join(scratchRoot, prefix));
  const baseDir = join(scratchDir, "quake");

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  ensureDir(join(baseDir, "id1"));
  ensureDir(join(baseDir, "qw"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "gfx.wad", data: buildGfxWad() },
    { name: "gfx/palette.lmp", data: buildPalette() },
    { name: "gfx/colormap.lmp", data: buildColormap() },
    { name: "gfx/conback.lmp", data: buildQpicLump(320, 200, 7) },
  ]);

  writeGameFile(baseDir, "id1/quake.rc", latin1Bytes("exec default.cfg\nstuffcmds\n"));
  writeGameFile(baseDir, "id1/default.cfg", new Uint8Array(0));

  return { scratchDir, baseDir };
}

export function destroyQwclFixture(fixture: QwclFixture): void {
  rmSync(fixture.scratchDir, { recursive: true, force: true });
}
