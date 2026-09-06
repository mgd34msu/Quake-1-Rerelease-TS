// F16, the server half of test/model_malformed.test.ts: a map file that is
// present but unloadable is refused by name and BOTH servers stay up. E1's
// repro was `: > <basedir>/qw/maps/dm2.bsp` followed by
// `-dedicated -qw +map dm2`, which reached Mod_LoadModel's first DataView
// read and killed the process with "Fatal: Out of bounds access".
//
// Two child `bun` processes, each src/main.ts, each fed every malformed
// shape in turn and asked for a good map again afterwards:
//
//   1. `-dedicated -qw` -- SV_SpawnServer (src/qw/server/sv_init.ts) now
//      loads the world with crash=false, so the refusal leaves sv.state at
//      ss_dead and the server keeps serving, exactly as it does for a map
//      name that does not exist at all.
//   2. `-dedicated -noudp` -- the NetQuake SV_SpawnServer, whose Mod_ForName
//      has always been crash=false: what changed for it is that a file that
//      exists but does not parse now takes the same "Couldn't spawn server"
//      exit instead of aborting inside a lump reader.
//
// Why child processes: a full Host_Init in the `bun test` process would
// register every command and cvar the whole engine has and leave them there
// for every other file (the same reason test/unified_server.test.ts,
// test/qw_listen.test.ts and test/qwcl_boot.test.ts each use one).
// Everything the assertions read is printed as one JSON line. THIS process
// mutates nothing shared: the fixtures live under mkdtemp scratch trees that
// afterAll removes.
//
// Ports: 27690-27699 (this unit's range).

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildQwclFixture, destroyQwclFixture, type QwclFixture } from "./support/qwcl_fixture";
import { buildBsp, buildMdl, buildSpr, ensureDir, writeGameFile } from "./support/bsp_builder";
import { HAVE_PROGS106, HAVE_QWPROGS, PROGS106_DAT, QWPROGS_DAT } from "./support/fixture_availability";
import { DVERTEX_T_SIZE, LUMP_MODELS, LUMP_T_SIZE, LUMP_VERTEXES } from "../src/common/bspfile";

const repoRoot = join(import.meta.dir, "..");

const QW_MARKER = "<<<F16_QW_JSON>>>";
const NQ_MARKER = "<<<F16_NQ_JSON>>>";

const QW_MAP = "start";
const NQ_MAP = "nqstart";
const QW_PORT = "27690";
const NQ_PORT = "27691";

const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const ENTITIES =
  '{\n"classname" "worldspawn"\n"wad" "gfx/base.wad"\n"worldtype" "0"\n}\n' +
  '{\n"classname" "info_player_start"\n"origin" "16 16 24"\n"angle" "90"\n}\n';

// A .bsp with its ENTITIES lump replaced, appended after the last lump so no
// other lump's offset moves (test/unified_server.test.ts's own recipe).
function withEntities(bsp: Uint8Array, text: string): Uint8Array {
  const ent = latin1Bytes(`${text}\0`);
  const out = new Uint8Array(bsp.length + ent.length);
  out.set(bsp);
  out.set(ent, bsp.length);
  const view = new DataView(out.buffer);
  view.setInt32(4, bsp.length, true);
  view.setInt32(8, ent.length, true);
  return out;
}

const GOOD = withEntities(buildBsp(), ENTITIES);

function lumpField(bsp: Uint8Array, lump: number, field: 0 | 1, value: number): Uint8Array {
  const out = new Uint8Array(bsp);
  new DataView(out.buffer).setInt32(4 + lump * LUMP_T_SIZE + field * 4, value, true);
  return out;
}

function version(bsp: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(bsp);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
}

// The shapes E1's brief names, plus the two a half-finished download leaves
// on disk in practice.
const MALFORMED: ReadonlyArray<readonly [string, Uint8Array]> = [
  ["empty", new Uint8Array(0)],
  ["shorthdr", GOOD.subarray(0, 12)],
  ["badversion", version(GOOD, 30)],
  ["lumprange", lumpField(GOOD, LUMP_MODELS, 0, GOOD.length)],
  ["truncated", GOOD.subarray(0, GOOD.length - 64)],
  ["funnysize", lumpField(GOOD, LUMP_VERTEXES, 1, DVERTEX_T_SIZE * 3 - 1)],
];

const BAD_NAMES = MALFORMED.map(([name]) => name);

//============================================================================

const QW_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText } from "./src/common/cmd";
import { ServerStateT, sv } from "./src/qw/server/server";
import { SV_Shutdown } from "./src/qw/server/sv_main";

const baseDir = process.argv[1];
const port = process.argv[2];
const bad = process.argv.slice(3);

// No +map: SV_Init's own tail spawns "${QW_MAP}", which is the state a live
// server is in when an operator types a bad map name at it.
Sys_Main_Init(["quake", "-dedicated", "-qw", "-basedir", baseDir, "-port", port]);
await NET_Ready();

// Everything goes through the frame loop rather than a bare Cbuf_Execute:
// the console drain belongs to SV_Frame, which src/main.ts's Host_Frame is
// what reaches.
function pump(text, frames) {
  Cbuf_AddText(text);
  for (let i = 0; i < frames; i++) Host_Frame(0.05);
}

const booted = sv.state === ServerStateT.ss_active;

const results = [];
for (const map of bad) {
  let threw = null;
  try {
    pump("map " + map + "\\n", 4);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const refused = sv.state !== ServerStateT.ss_active;
  let recovered = false;
  try {
    pump("map ${QW_MAP}\\n", 4);
    recovered = sv.state === ServerStateT.ss_active;
  } catch (e) {
    threw = threw === null ? (e instanceof Error ? e.message : String(e)) : threw;
  }
  results.push({ map, threw, refused, recovered });
}

const snapshot = { booted, results, state: sv.state };

SV_Shutdown();
NET_Shutdown();
process.stdout.write("${QW_MARKER}" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`;

// E1's repro verbatim: the bad map is on the command line, so the refusal
// happens inside SV_Init, before the server has ever been up.
const QW_BOOT_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { ServerStateT, sv } from "./src/qw/server/server";
import { SV_Shutdown } from "./src/qw/server/sv_main";

const baseDir = process.argv[1];
const port = process.argv[2];
const map = process.argv[3];

Sys_Main_Init(["quake", "-dedicated", "-qw", "-basedir", baseDir, "-port", port, "+map", map]);
await NET_Ready();
for (let i = 0; i < 4; i++) Host_Frame(0.05);

// SV_Init falls back to "map ${QW_MAP}" when the command line's map left the
// server dead, so a boot that refuses the bad map still comes up serving.
const snapshot = { state: sv.state, active: sv.state === ServerStateT.ss_active, name: sv.name };

SV_Shutdown();
NET_Shutdown();
process.stdout.write("${QW_MARKER}" + JSON.stringify(snapshot) + "\\n");
process.exit(0);
`;

const NQ_SCRIPT = `
import { Sys_Main_Init, Host_Frame } from "./src/main";
import { Cbuf_AddText } from "./src/common/cmd";
import { sv } from "./src/server/server";

const baseDir = process.argv[1];
const port = process.argv[2];
const bad = process.argv.slice(3);

// -noudp: this child needs no socket at all, and the port belongs to the
// QuakeWorld child above.
Sys_Main_Init(["quake", "-dedicated", "-noudp", "-basedir", baseDir, "-port", port]);

function pump(text, frames) {
  Cbuf_AddText(text);
  for (let i = 0; i < frames; i++) Host_Frame(0.05);
}

pump("map ${NQ_MAP}\\n", 4);
const booted = sv.active;

const results = [];
for (const map of bad) {
  let threw = null;
  try {
    pump("map " + map + "\\n", 4);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const refused = !sv.active;
  let recovered = false;
  try {
    pump("map ${NQ_MAP}\\n", 4);
    recovered = sv.active;
  } catch (e) {
    threw = threw === null ? (e instanceof Error ? e.message : String(e)) : threw;
  }
  results.push({ map, threw, refused, recovered });
}

process.stdout.write("${NQ_MARKER}" + JSON.stringify({ booted, results, active: sv.active }) + "\\n");
process.exit(0);
`;

//============================================================================

function markerLine(text: string, marker: string): string | null {
  for (const line of text.split("\n")) if (line.startsWith(marker)) return line.slice(marker.length);
  return null;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${what} snapshot is not an object`);
  return { ...value };
}

function bool(r: Record<string, unknown>, key: string): boolean {
  const v = r[key];
  if (typeof v !== "boolean") throw new Error(`snapshot field ${key} is not a boolean`);
  return v;
}

function str(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`snapshot field ${key} is not a string`);
  return v;
}

function rows(r: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = r[key];
  if (!Array.isArray(v)) throw new Error(`snapshot field ${key} is not an array`);
  return v.map((e, i) => record(e, `${key}[${i}]`));
}

// Set F16_DEBUG to have a failing run print a child's whole console.
function dumpOnDemand(label: string, text: string): void {
  if (process.env.F16_DEBUG === undefined) return;
  console.log(`=== ${label} ===\n${text}`);
}

const fixtures: QwclFixture[] = [];

afterAll(() => {
  for (const f of fixtures) destroyQwclFixture(f);
});

// One loadable file per model name the progs can precache: PF_precache_model
// runs Mod_ForName with crash=true, so a worldspawn that names a file this
// fixture does not have aborts the spawn for a reason that has nothing to do
// with what is under test. Read out of the progs' own string data rather
// than kept as a hand-written list that goes stale against the .dat.
function materializeProgsModels(baseDir: string, progsPath: string): void {
  const bytes = new Uint8Array(readFileSync(progsPath));
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);

  for (const m of text.matchAll(/(?:progs|maps)\/[A-Za-z0-9_]+\.(?:mdl|spr|bsp)/g)) {
    const name = m[0];
    const data = name.endsWith(".mdl") ? buildMdl({ numframes: 2 }) : name.endsWith(".spr") ? buildSpr() : GOOD;
    writeGameFile(baseDir, `id1/${name}`, data);
  }
}

function buildFixture(prefix: string): QwclFixture {
  const fixture = buildQwclFixture(prefix);
  fixtures.push(fixture);
  const baseDir = fixture.baseDir;

  // SV_SpawnServer's SV_CheckModel reads these two by name before any progs
  // runs, on both trees.
  writeGameFile(baseDir, "id1/progs/player.mdl", buildMdl({ numframes: 2 }));
  writeGameFile(baseDir, "id1/progs/eyes.mdl", buildMdl({ numframes: 2 }));

  ensureDir(join(baseDir, "id1", "maps"));
  ensureDir(join(baseDir, "qw", "maps"));

  if (HAVE_PROGS106) {
    writeGameFile(baseDir, "id1/progs.dat", new Uint8Array(readFileSync(PROGS106_DAT)));
    materializeProgsModels(baseDir, PROGS106_DAT);
  }
  if (HAVE_QWPROGS) {
    writeGameFile(baseDir, "qw/qwprogs.dat", new Uint8Array(readFileSync(QWPROGS_DAT)));
    materializeProgsModels(baseDir, QWPROGS_DAT);
  }

  writeGameFile(baseDir, `id1/maps/${NQ_MAP}.bsp`, GOOD);
  writeGameFile(baseDir, `qw/maps/${QW_MAP}.bsp`, GOOD);
  for (const [name, bsp] of MALFORMED) {
    writeGameFile(baseDir, `id1/maps/${name}.bsp`, bsp);
    writeGameFile(baseDir, `qw/maps/${name}.bsp`, bsp);
  }

  return fixture;
}

//============================================================================

describe.if(HAVE_QWPROGS)("the QuakeWorld server refuses a malformed map and keeps serving", () => {
  const fixture = buildFixture("f16-qw-badmap-");

  const child = Bun.spawnSync(["timeout", "180", "bun", "-e", QW_SCRIPT, "--", fixture.baseDir, QW_PORT, ...BAD_NAMES], {
    cwd: repoRoot,
    env: headlessEnv,
  });
  const log = `${child.stdout.toString()}\n${child.stderr.toString()}`;
  dumpOnDemand("-dedicated -qw", log);

  const json = markerLine(log, QW_MARKER);
  const snapshot = json === null ? null : record(JSON.parse(json), "qw");

  test("the server came up on the good map at all", () => {
    if (snapshot === null) throw new Error(`the QuakeWorld server produced no snapshot:\n${log}`);
    expect(bool(snapshot, "booted")).toBe(true);
  });

  for (const name of BAD_NAMES) {
    test(`maps/${name}.bsp is refused by name, and the server takes a good map afterwards`, () => {
      if (snapshot === null) throw new Error(`the QuakeWorld server produced no snapshot:\n${log}`);
      const row = rows(snapshot, "results").find((r) => r["map"] === name);
      if (row === undefined) throw new Error(`no result row for ${name}`);
      expect(row["threw"]).toBeNull();
      expect(bool(row, "refused")).toBe(true);
      expect(bool(row, "recovered")).toBe(true);
      expect(log).toContain(`Mod_LoadBrushModel: maps/${name}.bsp `);
      expect(log).toContain(`Couldn't spawn server maps/${name}.bsp`);
    });
  }

  test("and nothing reached the old unnamed abort", () => {
    expect(log).not.toContain("Out of bounds access");
    expect(log).not.toContain("Fatal:");
  });
});

describe.if(HAVE_QWPROGS)("E1's repro: the malformed map is on the command line", () => {
  const fixture = buildFixture("f16-qw-boot-");

  const child = Bun.spawnSync(["timeout", "180", "bun", "-e", QW_BOOT_SCRIPT, "--", fixture.baseDir, "27692", "empty"], {
    cwd: repoRoot,
    env: headlessEnv,
  });
  const log = `${child.stdout.toString()}\n${child.stderr.toString()}`;
  dumpOnDemand("-dedicated -qw +map empty", log);

  const json = markerLine(log, QW_MARKER);
  const snapshot = json === null ? null : record(JSON.parse(json), "qwboot");

  test("the boot refuses it by name and comes up on the fallback map instead", () => {
    if (snapshot === null) throw new Error(`the QuakeWorld server produced no snapshot:\n${log}`);
    expect(log).toContain("Mod_LoadBrushModel: maps/empty.bsp is empty");
    expect(log).not.toContain("Out of bounds access");
    expect(bool(snapshot, "active")).toBe(true);
    expect(str(snapshot, "name")).toBe(QW_MAP);
  });
});

describe.if(HAVE_PROGS106)("the NetQuake server refuses a malformed map and keeps serving", () => {
  const fixture = buildFixture("f16-nq-badmap-");

  const child = Bun.spawnSync(["timeout", "180", "bun", "-e", NQ_SCRIPT, "--", fixture.baseDir, NQ_PORT, ...BAD_NAMES], {
    cwd: repoRoot,
    env: headlessEnv,
  });
  const log = `${child.stdout.toString()}\n${child.stderr.toString()}`;
  dumpOnDemand("-dedicated -noudp", log);

  const json = markerLine(log, NQ_MARKER);
  const snapshot = json === null ? null : record(JSON.parse(json), "nq");

  test("the server came up on the good map at all", () => {
    if (snapshot === null) throw new Error(`the NetQuake server produced no snapshot:\n${log}`);
    expect(bool(snapshot, "booted")).toBe(true);
  });

  for (const name of BAD_NAMES) {
    test(`maps/${name}.bsp is refused by name, and the server takes a good map afterwards`, () => {
      if (snapshot === null) throw new Error(`the NetQuake server produced no snapshot:\n${log}`);
      const row = rows(snapshot, "results").find((r) => r["map"] === name);
      if (row === undefined) throw new Error(`no result row for ${name}`);
      expect(row["threw"]).toBeNull();
      expect(bool(row, "refused")).toBe(true);
      expect(bool(row, "recovered")).toBe(true);
      expect(log).toContain(`Mod_LoadBrushModel: maps/${name}.bsp `);
      expect(log).toContain(`Couldn't spawn server maps/${name}.bsp`);
    });
  }

  test("and nothing reached the old unnamed abort", () => {
    expect(log).not.toContain("Out of bounds access");
    expect(log).not.toContain("Fatal:");
  });
});
