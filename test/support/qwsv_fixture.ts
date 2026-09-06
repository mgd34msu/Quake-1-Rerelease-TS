// Test helper: builds a scratch `-basedir` a real qwsv boot can run against.
//
//   id1/pak0.pak   gfx/pop.lmp (the registered-version check), plus the two
//                  models SV_SpawnServer checksums by name
//                  (progs/player.mdl, progs/eyes.mdl -- see
//                  src/qw/server/sv_init.ts's SV_CheckModel).
//   qw/qwprogs.dat the real retail QuakeWorld progs, copied out of
//                  ../qsrc/quake/QW/progs/qwprogs.dat.
//   qw/maps/start.bsp  the synthetic BSP29 from test/support/bsp_builder.ts,
//                  whose entity lump is already worldspawn +
//                  info_player_start.
//   qw/server.cfg  SV_Init's `exec server.cfg`; sets `hostname` so a test can
//                  see that it really ran.
//
// Not a ported C file -- test infrastructure only.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pop } from "../../src/qw/common";
import { writePakToDisk } from "./pak_builder";
import { buildBsp, buildMdl, ensureDir, writeGameFile } from "./bsp_builder";

const QWPROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../../qsrc/quake`}/QW/progs/qwprogs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");

// what qw/server.cfg sets, so a test can assert the exec happened
export const QWSV_FIXTURE_HOSTNAME = "qwsv-scratch";

// the map name the fixture ships, i.e. what `+map <name>` takes
export const QWSV_FIXTURE_MAP = "start";

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface QwsvFixture {
  scratchDir: string;
  baseDir: string;
}

// `prefix` becomes the mkdtemp() prefix, so two fixtures built in the same
// test file never collide.
export function buildQwsvFixture(prefix: string): QwsvFixture {
  if (!existsSync(QWPROGS_DAT)) throw new Error(`missing test fixture ${QWPROGS_DAT}`);

  mkdirSync(scratchRoot, { recursive: true });
  const scratchDir = mkdtempSync(join(scratchRoot, prefix));
  const baseDir = join(scratchDir, "quake");

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }

  ensureDir(join(baseDir, "id1"));
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [
    { name: "gfx/pop.lmp", data: popLmp },
    { name: "progs/player.mdl", data: buildMdl({ numframes: 2 }) },
    { name: "progs/eyes.mdl", data: buildMdl({ numframes: 2 }) },
  ]);

  writeGameFile(baseDir, "qw/qwprogs.dat", new Uint8Array(readFileSync(QWPROGS_DAT)));
  writeGameFile(baseDir, `qw/maps/${QWSV_FIXTURE_MAP}.bsp`, buildBsp());
  writeGameFile(baseDir, "qw/server.cfg", latin1Bytes(`hostname "${QWSV_FIXTURE_HOSTNAME}"\n`));

  return { scratchDir, baseDir };
}

export function destroyQwsvFixture(fixture: QwsvFixture): void {
  rmSync(fixture.scratchDir, { recursive: true, force: true });
}
