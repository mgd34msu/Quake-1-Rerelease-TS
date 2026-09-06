/*
Self-sufficient test for Q013: src/qw/server/world.ts (QW/server/world.c) and
the audited src/qw/server/model.ts (QW/server/model.c). Follows test/
world.test.ts's own synthetic-map recipe (test/support/bsp_builder's
buildBsp + test/support/pak_builder's writePakToDisk for gfx/pop.lmp, per
COM_CheckRegistered's requirement) adapted to QW's own file layer
(src/qw/common.ts's COM_InitArgv/COM_InitFilesystem, which seeds id1 AND qw
game directories) and QW's own server state (QwEdictT, src/qw/server/
server.ts's `sv`, src/qw/server/world.ts's functions).

Per test/qw_common.test.ts's own file header and standing order 15: QW's
common.ts shares com_searchpaths/com_modified with src/common/common.ts
(Task 1's unification), a process-wide singleton bun's single test process
never resets on its own between files. beforeEach/afterAll here reset both
to their module-load defaults, exactly as test/qw_common.test.ts does, so an
earlier- or later-run suite's own search path never leaks into this file's
gfx/pop.lmp / maps/world.bsp lookups.

Never rely on another test file having run first (standing order 13): this
file builds its own scratch basedir, its own id1/qw game directories, its
own pak0.pak + gfx/pop.lmp, and calls COM_InitArgv/COM_InitFilesystem/
COM_CheckRegistered/Mod_Init itself in its own beforeAll.
*/

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/qw/common";
import { setComSearchpaths, setComModified } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { Mod_Init, Mod_ForName } from "../src/qw/server/model";
import { ModelT } from "../src/common/model";
import { CONTENTS_EMPTY, CONTENTS_SOLID, readDheader, HEADER_LUMPS, LUMP_ENTITIES, LUMP_VISIBILITY, LUMP_LEAFS, LUMP_NODES } from "../src/common/bspfile";
import { Com_BlockChecksum } from "../src/qw/md4";
import { vec3 } from "../src/common/mathlib";
import { QwEdictT, LinkT, setEdictTable } from "../src/qw/server/progs";
import { QW_ENTVARS_SIZE_WORDS } from "../src/qw/server/progdefs";
import { sv, MOVETYPE_NONE, MOVETYPE_PUSH, SOLID_BBOX, SOLID_TRIGGER } from "../src/qw/server/server";
import {
  AREA_NODES,
  type AreanodeT,
  MOVE_NOMONSTERS,
  MOVE_NORMAL,
  SV_ClearWorld,
  SV_HullForBox,
  SV_HullPointContents,
  SV_LinkEdict,
  SV_Move,
  SV_PointContents,
  SV_RecursiveHullCheck,
  SV_TestEntityPosition,
  SV_TestPlayerPosition,
  SV_UnlinkEdict,
  TraceT,
  sv_areanodes,
  sv_numareanodes,
} from "../src/qw/server/world";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-world-test-"));
const baseDir = join(scratchDir, "quake");

let mod: ModelT;
let bspBytes: Uint8Array;

// test-only entities, one per column so different SV_Move/SV_TestPlayerPosition
// rays in different tests never see each other's entity.
let entLink: QwEdictT; // SOLID_BBOX, link/unlink round trip
let entMoveTarget: QwEdictT; // SOLID_BBOX, column x=0,y=0
let entNomonsters: QwEdictT; // SOLID_BBOX, column x=0,y=150
let entTrigger: QwEdictT; // SOLID_TRIGGER, column x=0,y=-150
let entFree: QwEdictT; // not linked, used only by SV_TestEntityPosition / as SV_TestPlayerPosition's moving ent
let entEmbedded: QwEdictT; // not linked, sits inside the world's solid half
let entPlayerTarget: QwEdictT; // SOLID_BBOX, column x=0,y=300 -- SV_TestPlayerPosition only

// see file header: com_searchpaths/com_modified are shared, process-wide
// singletons -- reset before/after every test so no other suite's search
// path or registration state leaks in or out.
beforeEach(() => {
  setComSearchpaths(null);
  setComModified(false);
});
afterAll(() => {
  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  ensureDir(join(baseDir, "qw"));

  bspBytes = buildBsp();
  writeGameFile(baseDir, "id1/maps/world.bsp", bspBytes);

  // gfx/pop.lmp inside id1/pak0.pak, exactly as test/world.test.ts does: the
  // registered-version check must pass before COM_FindFile will search a
  // loose "maps/world.bsp" path at all.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["qwsv", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  mod = loaded;

  sv.worldmodel = mod;
  sv.models[1] = mod;

  // SV_SpawnServer's own edict-0 setup (sv_init.c): the world edict is a
  // SOLID_BSP/MOVETYPE_PUSH entity pointing at model slot 1.
  const world = new QwEdictT(0, QW_ENTVARS_SIZE_WORDS);
  world.v.solid = 4; // SOLID_BSP -- server.ts's own constant, avoided here to
  // keep this file's import list free of a name only used once; see below
  // for the real SOLID_BSP-driven test.
  world.v.movetype = MOVETYPE_PUSH;
  world.v.modelindex = 1;

  entLink = new QwEdictT(1, QW_ENTVARS_SIZE_WORDS);
  entLink.v.solid = SOLID_BBOX;
  entLink.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entLink.v.origin, 100, 0, 50);
  vec3CopyInto(entLink.v.mins, -8, -8, -8);
  vec3CopyInto(entLink.v.maxs, 8, 8, 8);

  entMoveTarget = new QwEdictT(2, QW_ENTVARS_SIZE_WORDS);
  entMoveTarget.v.solid = SOLID_BBOX;
  entMoveTarget.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entMoveTarget.v.origin, 0, 0, 0);
  vec3CopyInto(entMoveTarget.v.mins, -16, -16, -16);
  vec3CopyInto(entMoveTarget.v.maxs, 16, 16, 16);

  entNomonsters = new QwEdictT(3, QW_ENTVARS_SIZE_WORDS);
  entNomonsters.v.solid = SOLID_BBOX;
  entNomonsters.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entNomonsters.v.origin, 0, 150, 0);
  vec3CopyInto(entNomonsters.v.mins, -16, -16, -16);
  vec3CopyInto(entNomonsters.v.maxs, 16, 16, 16);

  entTrigger = new QwEdictT(4, QW_ENTVARS_SIZE_WORDS);
  entTrigger.v.solid = SOLID_TRIGGER;
  entTrigger.v.movetype = MOVETYPE_NONE;
  entTrigger.v.touch = 999; // an arbitrary nonzero func_t; never executed (touch_triggers=false below)
  vec3CopyInto(entTrigger.v.origin, 0, -150, 0);
  vec3CopyInto(entTrigger.v.mins, -16, -16, -16);
  vec3CopyInto(entTrigger.v.maxs, 16, 16, 16);

  entFree = new QwEdictT(5, QW_ENTVARS_SIZE_WORDS);
  entFree.v.solid = SOLID_BBOX;
  vec3CopyInto(entFree.v.origin, 100, 100, 50); // z=50, well above the ground and away from every column above
  vec3CopyInto(entFree.v.mins, -8, -8, -8);
  vec3CopyInto(entFree.v.maxs, 8, 8, 8);

  entEmbedded = new QwEdictT(6, QW_ENTVARS_SIZE_WORDS);
  entEmbedded.v.solid = SOLID_BBOX;
  vec3CopyInto(entEmbedded.v.origin, 100, 100, -50); // z=-50, inside the world's solid half
  vec3CopyInto(entEmbedded.v.mins, -8, -8, -8);
  vec3CopyInto(entEmbedded.v.maxs, 8, 8, 8);

  entPlayerTarget = new QwEdictT(7, QW_ENTVARS_SIZE_WORDS);
  entPlayerTarget.v.solid = SOLID_BBOX;
  entPlayerTarget.v.movetype = MOVETYPE_NONE;
  vec3CopyInto(entPlayerTarget.v.origin, 0, 300, 0);
  vec3CopyInto(entPlayerTarget.v.mins, -16, -16, -16);
  vec3CopyInto(entPlayerTarget.v.maxs, 16, 16, 16);

  sv.edicts = [world, entLink, entMoveTarget, entNomonsters, entTrigger, entFree, entEmbedded, entPlayerTarget];
  sv.num_edicts = sv.edicts.length;
  setEdictTable(sv.edicts);
});

function vec3CopyInto(dst: Float32Array, x: number, y: number, z: number): void {
  dst[0] = x;
  dst[1] = y;
  dst[2] = z;
}

// test-only helper: walks an area-node tree looking for `ent`'s link on the
// named list. Not a C port -- world.h never exposed sv_areanodes for reading.
function findEdictInTree(node: AreanodeT, ent: QwEdictT, listKey: "solid_edicts" | "trigger_edicts"): boolean {
  const head = node[listKey];
  for (let l: LinkT | null = head.next; l !== null && l !== head; l = l.next) {
    if (l.owner === ent) return true;
  }
  if (node.axis === -1) return false;
  const c0 = node.children[0];
  const c1 = node.children[1];
  return (c0 !== null && findEdictInTree(c0, ent, listKey)) || (c1 !== null && findEdictInTree(c1, ent, listKey));
}

//============================================================================

describe("SV_ClearWorld", () => {
  test("builds all 32 area nodes, 31 of which SV_CreateAreaNode fills in", () => {
    SV_ClearWorld();
    expect(sv_areanodes.length).toBe(AREA_NODES);
    expect(sv_numareanodes).toBe(31); // a full depth-4 binary tree: 2^5 - 1
  });
});

describe("SV_LinkEdict / SV_UnlinkEdict", () => {
  test("a SOLID_BBOX entity lands in a solid_edicts list, not trigger_edicts", () => {
    SV_LinkEdict(entLink, false);
    expect(findEdictInTree(sv_areanodes[0], entLink, "solid_edicts")).toBe(true);
    expect(findEdictInTree(sv_areanodes[0], entLink, "trigger_edicts")).toBe(false);
    expect(entLink.area.prev).not.toBeNull();
  });

  test("SV_UnlinkEdict removes it from the tree", () => {
    SV_UnlinkEdict(entLink);
    expect(findEdictInTree(sv_areanodes[0], entLink, "solid_edicts")).toBe(false);
    expect(entLink.area.prev).toBeNull();
    expect(entLink.area.next).toBeNull();
  });
});

describe("SV_PointContents", () => {
  test("above the split plane is empty", () => {
    expect(SV_PointContents(vec3(0, 0, 10))).toBe(CONTENTS_EMPTY);
  });

  test("below the split plane is solid", () => {
    expect(SV_PointContents(vec3(0, 0, -10))).toBe(CONTENTS_SOLID);
  });
});

describe("SV_HullForBox / SV_HullPointContents (reused from src/server/world.ts)", () => {
  test("solid inside the box, empty outside", () => {
    const hull = SV_HullForBox(vec3(-16, -16, -16), vec3(16, 16, 16));
    expect(SV_HullPointContents(hull, hull.firstclipnode, vec3(0, 0, 0))).toBe(CONTENTS_SOLID);
    expect(SV_HullPointContents(hull, hull.firstclipnode, vec3(100, 100, 100))).toBe(CONTENTS_EMPTY);
  });
});

describe("SV_RecursiveHullCheck", () => {
  test("a ray straight down through a box hull hits the top face", () => {
    const hull = SV_HullForBox(vec3(-16, -16, -16), vec3(16, 16, 16));
    const start = vec3(0, 0, 100);
    const end = vec3(0, 0, -100);

    const trace = new TraceT();
    trace.clear();
    trace.fraction = 1;
    trace.allsolid = true;

    SV_RecursiveHullCheck(hull, hull.firstclipnode, 0, 1, start, end, trace);

    // 1/32 epsilon backs the crosspoint off toward the near (empty) side, so
    // the hit is a hair short of the exact geometric (100-16)/200 = 0.42.
    const expectedFraction = (84 - 0.03125) / 200;
    expect(trace.fraction).toBeCloseTo(expectedFraction, 4);
    expect(trace.allsolid).toBe(false);
    expect(trace.startsolid).toBe(false);

    // the hit face is the box's top (+Z) face
    expect(Math.abs(trace.plane.normal[2])).toBeCloseTo(1, 5);
    expect(trace.plane.normal[0]).toBeCloseTo(0, 5);
    expect(trace.plane.normal[1]).toBeCloseTo(0, 5);
    expect(trace.endpos[2]).toBeCloseTo(16 + 0.03125, 3);
  });
});

describe("SV_Move", () => {
  test("stops against a linked SOLID_BBOX entity", () => {
    SV_LinkEdict(entMoveTarget, false);

    const trace = SV_Move(vec3(0, 0, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, -100), MOVE_NORMAL, null);

    expect(trace.ent).toBe(entMoveTarget);
    expect(trace.fraction).toBeLessThan(1);
  });

  test("MOVE_NOMONSTERS skips a non-bsp (SOLID_BBOX) entity", () => {
    SV_LinkEdict(entNomonsters, false);

    const traceNormal = SV_Move(vec3(0, 150, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 150, -100), MOVE_NORMAL, null);
    expect(traceNormal.ent).toBe(entNomonsters);

    const traceNoMonsters = SV_Move(vec3(0, 150, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 150, -100), MOVE_NOMONSTERS, null);
    expect(traceNoMonsters.ent).not.toBe(entNomonsters);
    expect(traceNoMonsters.fraction).toBeGreaterThan(traceNormal.fraction);
  });

  test("a SOLID_TRIGGER entity is never clipped against (SV_ClipToLinks only walks solid_edicts)", () => {
    // touch_triggers=false: SV_TouchLinks (and PR_ExecuteProgram) never runs.
    SV_LinkEdict(entTrigger, false);
    expect(findEdictInTree(sv_areanodes[0], entTrigger, "trigger_edicts")).toBe(true);
    expect(findEdictInTree(sv_areanodes[0], entTrigger, "solid_edicts")).toBe(false);

    const trace = SV_Move(vec3(0, -150, 100), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, -150, -100), MOVE_NORMAL, null);
    expect(trace.ent).not.toBe(entTrigger);
  });
});

describe("SV_TestEntityPosition", () => {
  test("a free-standing box away from the world's solid half is not embedded", () => {
    expect(SV_TestEntityPosition(entFree)).toBeNull();
  });

  test("a box sitting inside the world's solid half is embedded", () => {
    expect(SV_TestEntityPosition(entEmbedded)).toBe(sv.edicts[0]);
  });
});

// QW-only (not in WinQuake's world.c): used by pmove/sv_user to test a
// candidate player origin against the world and every solid/bbox/slidebox
// entity, without going through a full SV_Move trace.
describe("SV_TestPlayerPosition (QW-only)", () => {
  test("a point below the split plane hits the world first, before any entity is checked", () => {
    expect(SV_TestPlayerPosition(entFree, vec3(0, 0, -10))).toBe(sv.edicts[0]);
  });

  test("a point inside a linked SOLID_BBOX entity's clip hull returns that entity", () => {
    SV_LinkEdict(entPlayerTarget, false);
    expect(SV_TestPlayerPosition(entFree, vec3(0, 300, 0))).toBe(entPlayerTarget);
  });

  test("a point clear of the world and every entity returns null", () => {
    expect(SV_TestPlayerPosition(entFree, vec3(500, 500, 10))).toBeNull();
  });
});

//============================================================================
// model checksums (src/common/model.ts's shared Mod_LoadBrushModel, folded
// in per QW/server/model.c -- see ModelT's checksum/checksum2 field header
// note): independently recompute the checksum/checksum2 loop over the exact
// same bytes buildBsp() produced, using only the pre-existing, shared
// readDheader/Com_BlockChecksum primitives (not Mod_LoadBrushModel itself),
// and assert the loaded ModelT's own fields match.

function referenceChecksums(buf: Uint8Array): { checksum: number; checksum2: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const header = readDheader(view, 0);

  let checksum = 0;
  let checksum2 = 0;
  for (let i = 0; i < HEADER_LUMPS; i++) {
    if (i === LUMP_ENTITIES) continue;
    const lump = header.lumps[i];
    checksum = (checksum ^ Com_BlockChecksum(buf.subarray(lump.fileofs, lump.fileofs + lump.filelen), lump.filelen)) >>> 0;

    if (i === LUMP_VISIBILITY || i === LUMP_LEAFS || i === LUMP_NODES) continue;
    checksum2 = (checksum2 ^ Com_BlockChecksum(buf.subarray(lump.fileofs, lump.fileofs + lump.filelen), lump.filelen)) >>> 0;
  }
  return { checksum, checksum2 };
}

describe("ModelT.checksum / .checksum2 (QW/server/model.c's Mod_LoadBrushModel addition)", () => {
  test("match an independently computed XOR-of-Com_BlockChecksum-per-lump over the same file bytes", () => {
    const expected = referenceChecksums(bspBytes);

    expect(mod.checksum).toBe(expected.checksum);
    expect(mod.checksum2).toBe(expected.checksum2);

    // sanity: excluding LUMP_VISIBILITY/LEAFS/NODES from checksum2 but not
    // checksum means the two values have no reason to coincide for a map
    // with non-empty node/leaf lumps.
    expect(mod.checksum).not.toBe(mod.checksum2);
  });

  test("a freshly constructed ModelT (never loaded) has both fields at their zero default", () => {
    const untracked = new ModelT();
    untracked.name = "never-loaded";
    expect(untracked.checksum).toBe(0);
    expect(untracked.checksum2).toBe(0);
  });
});
