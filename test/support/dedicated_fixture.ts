// Test helper: builds a scratch `-basedir` a real dedicated Quake host can
// boot against -- id1/pak0.pak (progs106's progs.dat, gfx/pop.lmp, a
// synthetic gfx.wad, the synthetic maps/world.bsp from bsp_builder.ts, and
// the 26 model stubs progs106's worldspawn precaches), plus loose
// id1/quake.rc + id1/default.cfg so Host_Init's `exec quake.rc` (which the
// synthetic quake.rc `stuffcmds`s into "+map world" running off the command
// line) has something real to execute.
//
// Not a ported C file -- test infrastructure only. Copied out of
// test/host_cmd.test.ts's beforeAll (which does not export a builder of its
// own) into this shared test/support module per U036's brief, so
// test/main_boot.test.ts does not import another test file's internals.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pop } from "../../src/common/common";
import { writePakToDisk } from "./pak_builder";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./bsp_builder";
import { LUMPINFO_T_SIZE, WADINFO_T_SIZE } from "../../src/common/wad";

const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../../qsrc/quake`}/progs106/progs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");

// progs106/world.qc worldspawn's precache_model list, in its C order (kept
// in sync by hand with test/host_cmd.test.ts's own copy).
export const WORLDSPAWN_MODELS = [
  "progs/player.mdl",
  "progs/eyes.mdl",
  "progs/h_player.mdl",
  "progs/gib1.mdl",
  "progs/gib2.mdl",
  "progs/gib3.mdl",
  "progs/s_bubble.spr",
  "progs/s_explod.spr",
  "progs/v_axe.mdl",
  "progs/v_shot.mdl",
  "progs/v_nail.mdl",
  "progs/v_rock.mdl",
  "progs/v_shot2.mdl",
  "progs/v_nail2.mdl",
  "progs/v_rock2.mdl",
  "progs/bolt.mdl",
  "progs/bolt2.mdl",
  "progs/bolt3.mdl",
  "progs/lavaball.mdl",
  "progs/missile.mdl",
  "progs/grenade.mdl",
  "progs/spike.mdl",
  "progs/s_spike.mdl",
  "progs/backpack.mdl",
  "progs/zom_gib.mdl",
  "progs/v_light.mdl",
];

// The smallest legal WAD2 -- Host_Init calls W_LoadWadFile("gfx.wad")
// unconditionally, dedicated or not.
function buildWad2(): Uint8Array {
  const lumpData = new Uint8Array([1, 2, 3, 4]);
  const infotableofs = WADINFO_T_SIZE + lumpData.length;
  const buf = new ArrayBuffer(infotableofs + LUMPINFO_T_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes[0] = "W".charCodeAt(0);
  bytes[1] = "A".charCodeAt(0);
  bytes[2] = "D".charCodeAt(0);
  bytes[3] = "2".charCodeAt(0);
  view.setInt32(4, 1, true);
  view.setInt32(8, infotableofs, true);
  bytes.set(lumpData, WADINFO_T_SIZE);
  view.setInt32(infotableofs, WADINFO_T_SIZE, true);
  view.setInt32(infotableofs + 4, lumpData.length, true);
  view.setInt32(infotableofs + 8, lumpData.length, true);
  const name = "CONCHARS";
  for (let i = 0; i < name.length; i++) bytes[infotableofs + 16 + i] = name.charCodeAt(i);
  return bytes;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface DedicatedFixture {
  scratchDir: string;
  baseDir: string;
}

// `prefix` becomes the mkdtemp() prefix, so two fixtures built in the same
// test file (e.g. one per test) never collide.
export function buildDedicatedFixture(prefix: string): DedicatedFixture {
  if (!existsSync(PROGS_DAT)) throw new Error(`missing test fixture ${PROGS_DAT}`);

  mkdirSync(scratchRoot, { recursive: true });
  const scratchDir = mkdtempSync(join(scratchRoot, prefix));
  const baseDir = join(scratchDir, "quake");

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  const entries = [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs.dat", data: new Uint8Array(readFileSync(PROGS_DAT)) },
    { name: "gfx.wad", data: buildWad2() },
  ];
  for (const m of WORLDSPAWN_MODELS) {
    entries.push({ name: m, data: m.endsWith(".spr") ? buildSpr() : buildMdl({ numframes: 2 }) });
  }

  ensureDir(join(baseDir, "id1"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), entries);
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // Cmd_StuffCmds_f's own header comment: "+map world" on the command line
  // only becomes the "map world" command once something runs the
  // "stuffcmds" command; quake.rc is what WinQuake ships to do that. A
  // scratch fixture has no quake.rc of its own, so this is the minimal one
  // (loose files, no slash in either name, so COM_FindFile finds them even
  // in shareware/unregistered mode -- see PORTING.md's test-isolation note).
  writeGameFile(baseDir, "id1/quake.rc", latin1Bytes("exec default.cfg\nstuffcmds\n"));
  writeGameFile(baseDir, "id1/default.cfg", new Uint8Array(0));

  return { scratchDir, baseDir };
}

export function destroyDedicatedFixture(fixture: DedicatedFixture): void {
  rmSync(fixture.scratchDir, { recursive: true, force: true });
}
