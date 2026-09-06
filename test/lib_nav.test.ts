// Tests for src/lib/nav.ts (a clean-room reader for the 2021 re-release's
// bot navigation mesh files, bots/navigation/<map>.nav -- see that file's
// header comment for the full derived layout and the evidence behind it).
// Self-sufficient per PORTING.md rule 13: section 1 builds every .nav byte
// buffer inline with the tiny writer below, no game data. Section 2 is a
// guarded sweep across EVERY real retail .nav file in id1 (minus the
// debug-format bots/navigation/test/ maps), mg1, mg3, ctf, hipnotic, rogue
// and dopa, extracted with test/support/pak_reader.ts, cross-checking node
// positions against each map's compiled .bsp bounds via the engine's own
// src/common/bspfile.ts DataView readers (test-only use, per this unit's
// brief -- src/lib/nav.ts itself never imports bspfile.ts).

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { parseNav } from "../src/lib/nav";
import { PakFile } from "./support/pak_reader";
import { readDheader, readDmodel, LUMP_MODELS } from "../src/common/bspfile";

// ---------------------------------------------------------------------------
// Section 1: synthetic input
// ---------------------------------------------------------------------------

interface BuildNode {
  flags: number;
  linkCount: number;
  firstLink: number;
  radius: number;
  x: number;
  y: number;
  z: number;
}
interface BuildLink {
  target: number;
  type: number;
  flags?: number;
  traversal: number;
}
interface BuildHint {
  funnel: [number, number, number];
  start: [number, number, number];
  end: [number, number, number];
}
interface BuildEntityLink {
  link: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  tail: number[];
}

// Mirrors nav.ts's own documented layout, in the write direction --
// deliberately independent of nav.ts's internals so a bug in one isn't
// masked by the same bug in the other.
function buildNav(opts: { version: number; nodes: BuildNode[]; links: BuildLink[]; hints: BuildHint[]; entityLinks: BuildEntityLink[] }): Uint8Array {
  const { version, nodes, links, hints, entityLinks } = opts;
  const headerSize = version >= 16 ? 24 : 20;
  const tailInt32Count = version <= 12 ? 0 : version <= 14 ? 2 : 1;
  const entityRecordSize = 2 + 12 + 12 + tailInt32Count * 4;
  const total = headerSize + nodes.length * 8 + nodes.length * 12 + links.length * 6 + hints.length * 36 + 4 + entityLinks.length * entityRecordSize;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4e; // N
  bytes[1] = 0x41; // A
  bytes[2] = 0x56; // V
  bytes[3] = 0x32; // 2
  view.setInt32(4, version, true);
  view.setInt32(8, nodes.length, true);
  view.setInt32(12, links.length, true);
  view.setInt32(16, hints.length, true);
  let off = 20;
  if (version >= 16) {
    view.setFloat32(20, 1, true);
    off = 24;
  }

  const posOff = off + nodes.length * 8;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const base = off + i * 8;
    view.setUint16(base, n.flags, true);
    view.setUint16(base + 2, n.linkCount, true);
    view.setUint16(base + 4, n.firstLink, true);
    view.setUint16(base + 6, n.radius, true);
    const pbase = posOff + i * 12;
    view.setFloat32(pbase, n.x, true);
    view.setFloat32(pbase + 4, n.y, true);
    view.setFloat32(pbase + 8, n.z, true);
  }

  const linkOff = posOff + nodes.length * 12;
  for (let i = 0; i < links.length; i++) {
    const l = links[i]!;
    const base = linkOff + i * 6;
    view.setUint16(base, l.target, true);
    view.setUint8(base + 2, l.type);
    view.setUint8(base + 3, l.flags ?? 0);
    view.setUint16(base + 4, l.traversal, true);
  }

  const hintOff = linkOff + links.length * 6;
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i]!;
    const base = hintOff + i * 36;
    view.setFloat32(base, h.funnel[0], true);
    view.setFloat32(base + 4, h.funnel[1], true);
    view.setFloat32(base + 8, h.funnel[2], true);
    view.setFloat32(base + 12, h.start[0], true);
    view.setFloat32(base + 16, h.start[1], true);
    view.setFloat32(base + 20, h.start[2], true);
    view.setFloat32(base + 24, h.end[0], true);
    view.setFloat32(base + 28, h.end[1], true);
    view.setFloat32(base + 32, h.end[2], true);
  }

  const entityCountOff = hintOff + hints.length * 36;
  view.setUint32(entityCountOff, entityLinks.length, true);
  const entityItemsOff = entityCountOff + 4;
  for (let i = 0; i < entityLinks.length; i++) {
    const e = entityLinks[i]!;
    const base = entityItemsOff + i * entityRecordSize;
    view.setUint16(base, e.link, true);
    view.setFloat32(base + 2, e.mins[0], true);
    view.setFloat32(base + 6, e.mins[1], true);
    view.setFloat32(base + 10, e.mins[2], true);
    view.setFloat32(base + 14, e.maxs[0], true);
    view.setFloat32(base + 18, e.maxs[1], true);
    view.setFloat32(base + 22, e.maxs[2], true);
    for (let w = 0; w < tailInt32Count; w++) view.setInt32(base + 26 + w * 4, e.tail[w] ?? 0, true);
  }

  return bytes;
}

const NODE_A: BuildNode = { flags: 0, linkCount: 1, firstLink: 0, radius: 32, x: 10, y: 20, z: 30 };
const NODE_B: BuildNode = { flags: 0, linkCount: 1, firstLink: 1, radius: 32, x: 40, y: 50, z: 60 };

describe("nav.ts -- synthetic input", () => {
  test("parses a minimal two-node, two-link, no-hint, no-entity-link v12 file", () => {
    const bytes = buildNav({
      version: 12,
      nodes: [NODE_A, NODE_B],
      links: [
        { target: 1, type: 0, traversal: 0xffff },
        { target: 0, type: 0, traversal: 0xffff },
      ],
      hints: [],
      entityLinks: [],
    });
    const result = parseNav(bytes);
    expect(result.errors).toEqual([]);
    expect(result.file).toBeDefined();
    const file = result.file!;
    expect(file.version).toBe(12);
    expect(file.heuristic).toBe(1);
    expect(file.nodes.length).toBe(2);
    expect(file.nodes[0]!.position).toEqual({ x: 10, y: 20, z: 30 });
    expect(file.nodes[1]!.position).toEqual({ x: 40, y: 50, z: 60 });
    expect(file.links.map((l) => l.target)).toEqual([1, 0]);
    expect(file.links.map((l) => l.traversal)).toEqual([null, null]);
    expect(file.hints).toEqual([]);
    expect(file.entityLinks).toEqual([]);
  });

  test("version >= 16 reads the extra header heuristic field", () => {
    const isolatedNode: BuildNode = { ...NODE_A, linkCount: 0, firstLink: 0 };
    const bytes = buildNav({ version: 16, nodes: [isolatedNode], links: [], hints: [], entityLinks: [] });
    const view = new DataView(bytes.buffer);
    view.setFloat32(20, 2.5, true); // overwrite the default 1 the builder wrote
    const result = parseNav(bytes);
    expect(result.errors).toEqual([]);
    expect(result.file!.heuristic).toBe(2.5);
  });

  test("parses hints (three vec3 positions each)", () => {
    const bytes = buildNav({
      version: 12,
      nodes: [],
      links: [],
      hints: [{ funnel: [0, 0, 0], start: [100, 200, 300], end: [400, 500, 600] }],
      entityLinks: [],
    });
    const result = parseNav(bytes);
    expect(result.errors).toEqual([]);
    const hint = result.file!.hints[0]!;
    expect(hint.funnel).toEqual({ x: 0, y: 0, z: 0 });
    expect(hint.start).toEqual({ x: 100, y: 200, z: 300 });
    expect(hint.end).toEqual({ x: 400, y: 500, z: 600 });
  });

  test("parses a v15 entity-link record (one trailing int32)", () => {
    const bytes = buildNav({
      version: 15,
      nodes: [],
      links: [],
      hints: [],
      entityLinks: [{ link: 1132, mins: [1, 2, 3], maxs: [4, 5, 6], tail: [-80] }],
    });
    const result = parseNav(bytes);
    expect(result.errors).toEqual([]);
    const e = result.file!.entityLinks[0]!;
    expect(e.link).toBe(1132);
    expect(e.mins).toEqual({ x: 1, y: 2, z: 3 });
    expect(e.maxs).toEqual({ x: 4, y: 5, z: 6 });
    expect(e.tail).toEqual([-80]);
  });

  test("parses a v13 entity-link record (a leading int32 plus the same one trailing int32)", () => {
    const bytes = buildNav({
      version: 13,
      nodes: [],
      links: [],
      hints: [],
      entityLinks: [{ link: 611, mins: [1, 2, 3], maxs: [4, 5, 6], tail: [0, -16] }],
    });
    const result = parseNav(bytes);
    expect(result.errors).toEqual([]);
    expect(result.file!.entityLinks[0]!.tail).toEqual([0, -16]);
  });

  test("a v12 entity-link record has zero trailing tail int32s", () => {
    const bytes = buildNav({
      version: 12,
      nodes: [],
      links: [],
      hints: [],
      entityLinks: [{ link: 121, mins: [1, 2, 3], maxs: [4, 5, 6], tail: [] }],
    });
    const result = parseNav(bytes);
    expect(result.file!.entityLinks[0]!.tail).toEqual([]);
  });

  test("a link whose flags byte is non-zero decodes type and flags as separate fields, not one combined value", () => {
    // Regression case for the family-u blocker: this reader used to read
    // target/type/traversal as three uint16s, so a non-zero byte +3 (the
    // real flags byte) got folded into the type field as `flags<<8|type`.
    // ManualLongJump (8) with flags 0xFF used to decode as type 0xFF08.
    const bytes = buildNav({
      version: 18,
      nodes: [{ ...NODE_A, firstLink: 0, linkCount: 1 }, { ...NODE_B, firstLink: 0, linkCount: 0 }],
      links: [{ target: 1, type: 8, flags: 0xff, traversal: 0xffff }],
      hints: [],
      entityLinks: [],
    });
    const result = parseNav(bytes);
    expect(result.errors).toEqual([]);
    const link = result.file!.links[0]!;
    expect(link.type).toBe(8);
    expect(link.flags).toBe(0xff);
  });

  test("bad magic is reported, not thrown", () => {
    const bytes = new Uint8Array(20);
    bytes.set([0x42, 0x41, 0x44, 0x21], 0); // "BAD!"
    const result = parseNav(bytes);
    expect(result.file).toBeUndefined();
    expect(result.errors[0]).toMatch(/bad magic/);
  });

  test("a file too short for even the header is reported, not thrown", () => {
    const result = parseNav(new Uint8Array(10));
    expect(result.file).toBeUndefined();
    expect(result.errors[0]).toMatch(/too short/);
  });

  test("a version below 12 (the retail debug-map format) is rejected with a clear message, not guessed", () => {
    const bytes = buildNav({ version: 11, nodes: [], links: [], hints: [], entityLinks: [] });
    const result = parseNav(bytes);
    expect(result.file).toBeUndefined();
    expect(result.errors[0]).toMatch(/older than 12/);
  });

  test("a link target out of range is reported but the file still parses", () => {
    const bytes = buildNav({ version: 12, nodes: [NODE_A], links: [{ target: 5, type: 0, traversal: 0 }], hints: [], entityLinks: [] });
    const result = parseNav(bytes);
    expect(result.file).toBeDefined();
    expect(result.errors.some((e) => e.includes("out of range"))).toBe(true);
  });

  test("a node whose firstLink+linkCount exceeds linkCount is reported but the file still parses", () => {
    const badNode: BuildNode = { ...NODE_A, firstLink: 5, linkCount: 3 };
    const bytes = buildNav({ version: 12, nodes: [badNode], links: [{ target: 0, type: 0, traversal: 0 }], hints: [], entityLinks: [] });
    const result = parseNav(bytes);
    expect(result.file).toBeDefined();
    expect(result.errors.some((e) => e.includes("exceeds the file's linkCount"))).toBe(true);
  });

  test("a truncated file (declared entityLinkCount doesn't fit) is reported, not thrown", () => {
    const bytes = buildNav({ version: 12, nodes: [], links: [], hints: [], entityLinks: [] });
    const truncated = bytes.slice(0, bytes.length - 1);
    const result = parseNav(truncated);
    expect(result.file).toBeUndefined();
    expect(result.errors[0]).toMatch(/too short/);
  });

  test("a file whose trailing byte count doesn't match any valid entityLinkCount is reported, not thrown", () => {
    const bytes = buildNav({ version: 12, nodes: [], links: [], hints: [], entityLinks: [] });
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    const result = parseNav(padded);
    expect(result.file).toBeUndefined();
    expect(result.errors[0]).toMatch(/length mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Section 2: guarded sweep across every real retail .nav file
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;

function pakGuard(dir: string): { pakPath: string; have: boolean } {
  const pakPath = `${RERELEASE_DATA_DIR}/${dir}/pak0.pak`;
  return { pakPath, have: existsSync(pakPath) };
}

const MOD_DIRS = ["id1", "mg1", "mg3", "ctf", "hipnotic", "rogue", "dopa"];
const paks = MOD_DIRS.map((dir) => ({ dir, ...pakGuard(dir) }));
const HAVE_ID1 = paks.find((p) => p.dir === "id1")!.have;

interface NavSample {
  dir: string;
  pakPath: string;
  navName: string;
  bspName: string;
}

function collectRealMapSamples(): NavSample[] {
  const samples: NavSample[] = [];
  for (const p of paks) {
    if (!p.have) continue;
    const pak = new PakFile(p.pakPath);
    for (const e of pak.list("bots/navigation/")) {
      if (e.name.includes("/test/")) continue; // older, structurally different debug format -- see nav.ts's header
      const base = e.name.slice("bots/navigation/".length).replace(/\.nav$/, "");
      samples.push({ dir: p.dir, pakPath: p.pakPath, navName: e.name, bspName: `maps/${base}.bsp` });
    }
  }
  return samples;
}

describe.skipIf(!HAVE_ID1)("nav.ts -- real retail dm4.nav (the brief's own worked example)", () => {
  const pak = HAVE_ID1 ? new PakFile(`${RERELEASE_DATA_DIR}/id1/pak0.pak`) : null;
  const result = pak ? parseNav(pak.read("bots/navigation/dm4.nav")) : null;

  test("parses with no errors: 85 nodes, 197 links, 11 hints, matching the brief's byte-count algebra", () => {
    expect(result!.errors).toEqual([]);
    expect(result!.file).toBeDefined();
    expect(result!.file!.nodes.length).toBe(85);
    expect(result!.file!.links.length).toBe(197);
    expect(result!.file!.hints.length).toBe(11);
    expect(result!.file!.entityLinks.length).toBe(0);
  });

  test("every link target is a valid node index", () => {
    for (const link of result!.file!.links) expect(link.target).toBeLessThan(85);
  });

  test("every node's firstLink+linkCount stays within the link array, and per-node counts sum to linkCount", () => {
    let sum = 0;
    for (const node of result!.file!.nodes) {
      expect(node.firstLink + node.linkCount).toBeLessThanOrEqual(197);
      sum += node.linkCount;
    }
    expect(sum).toBe(197);
  });
});

describe.skipIf(paks.every((p) => !p.have))("nav.ts -- full retail sweep (id1 + mg1 + mg3 + ctf + hipnotic + rogue + dopa)", () => {
  const samples = collectRealMapSamples();

  test("at least the expected real gameplay maps are present (skipped entirely if no pak is on disk)", () => {
    if (samples.length === 0) return; // no retail data at all reachable; every other test in this block is a no-op too
    expect(samples.length).toBeGreaterThanOrEqual(60);
  });

  test("every real map .nav file parses with zero structural errors", () => {
    for (const s of samples) {
      const pak = new PakFile(s.pakPath);
      const result = parseNav(pak.read(s.navName));
      expect([s.navName, result.errors]).toEqual([s.navName, []]);
      expect(result.file).toBeDefined();
    }
  }, 30000); // the retail sweep reads 67 pak-packed files and their maps; 5 s is not enough under a loaded host

  test("every v18 file's link type stays inside the nine-value enum (byte +2 read on its own, not folded with the flags byte at +3)", () => {
    let v18Files = 0;
    let v18Links = 0;
    for (const s of samples) {
      const pak = new PakFile(s.pakPath);
      const result = parseNav(pak.read(s.navName));
      const file = result.file;
      if (file === undefined || file.version !== 18) continue;
      v18Files++;
      for (const link of file.links) {
        v18Links++;
        expect([s.navName, link.type]).toEqual([s.navName, Math.max(0, Math.min(8, link.type))]);
      }
    }
    // ctf1-4, ctf6-9 and mg3's own remade dm1.nav: the 9 real v18 files.
    expect(v18Files).toBe(9);
    expect(v18Links).toBeGreaterThan(7000);
  });

  test("ctf1.nav has 5 LongJump and 4 ManualLongJump links, ctf2.nav has 11 Teleport links (F4's counts)", () => {
    const ctfPak = paks.find((p) => p.dir === "ctf");
    if (ctfPak === undefined || !ctfPak.have) return;
    const pak = new PakFile(ctfPak.pakPath);

    const ctf1 = parseNav(pak.read("bots/navigation/ctf1.nav")).file!;
    const ctf1LongJump = ctf1.links.filter((l) => l.type === 1).length;
    const ctf1ManualLongJump = ctf1.links.filter((l) => l.type === 8).length;
    expect(ctf1LongJump).toBe(5);
    expect(ctf1ManualLongJump).toBe(4);

    const ctf2 = parseNav(pak.read("bots/navigation/ctf2.nav")).file!;
    const ctf2Teleport = ctf2.links.filter((l) => l.type === 2).length;
    expect(ctf2Teleport).toBe(11);
  });

  test("every link in the 9 real v18 files carries a non-zero flags byte (0xFF or, in 7 of ctf1's links, 0x0F), and every other retail file's links carry flags 0", () => {
    let v18NonZero = 0;
    let v18Total = 0;
    let preV18NonZero = 0;
    const v18Values = new Set<number>();
    for (const s of samples) {
      const pak = new PakFile(s.pakPath);
      const file = parseNav(pak.read(s.navName)).file;
      if (file === undefined) continue;
      for (const link of file.links) {
        if (file.version === 18) {
          v18Total++;
          if (link.flags !== 0) v18NonZero++;
          v18Values.add(link.flags);
        } else if (link.flags !== 0) {
          preV18NonZero++;
        }
      }
    }
    expect(v18Total).toBe(v18NonZero);
    expect(preV18NonZero).toBe(0);
    expect([...v18Values].sort((a, b) => a - b)).toEqual([0x0f, 0xff]);
  });

  test("every node position lands inside its map's model-0 bounds (generous 128-unit margin; one isolated known-disconnected outlier node in e4m4.nav is exempted, and mg3's own dm1.nav is exempted -- its bundled maps/dm1.bsp's worldspawn bounds don't cover it in the retail data itself, not a parser issue -- see nav.ts's header)", () => {
    const KNOWN_ANOMALIES = new Set(["mg3:bots/navigation/dm1.nav"]);
    const MARGIN = 128;
    let checked = 0;

    for (const s of samples) {
      if (KNOWN_ANOMALIES.has(`${s.dir}:${s.navName}`)) continue;
      const pak = new PakFile(s.pakPath);
      if (!pak.has(s.bspName)) continue;
      const result = parseNav(pak.read(s.navName));
      if (!result.file) continue;

      const bspBytes = pak.read(s.bspName);
      const bspView = new DataView(bspBytes.buffer, bspBytes.byteOffset, bspBytes.byteLength);
      const header = readDheader(bspView, 0);
      const model0 = readDmodel(bspView, header.lumps[LUMP_MODELS]!.fileofs);
      checked++;

      let outOfBounds = 0;
      for (const node of result.file.nodes) {
        const p = node.position;
        const inBounds =
          p.x >= model0.mins[0]! - MARGIN &&
          p.x <= model0.maxs[0]! + MARGIN &&
          p.y >= model0.mins[1]! - MARGIN &&
          p.y <= model0.maxs[1]! + MARGIN &&
          p.z >= model0.mins[2]! - MARGIN &&
          p.z <= model0.maxs[2]! + MARGIN;
        if (!inBounds) outOfBounds++;
      }
      // e4m4.nav has exactly one isolated (linkCount 0) node parked far below the map; everything else must be in bounds.
      const allowed = s.navName === "bots/navigation/e4m4.nav" ? 1 : 0;
      expect([s.navName, outOfBounds]).toEqual([s.navName, allowed]);
    }

    expect(checked).toBeGreaterThan(0);
  }, 30000); // the retail sweep reads 67 pak-packed files and their maps; 5 s is not enough under a loaded host
});
