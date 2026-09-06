// Reader for the 2021 re-release's bot navigation mesh files,
// bots/navigation/<map>.nav (magic "NAV2"). Not a ported C file: none of
// Ironwail/vkQuake/QuakeSpasm implement bot navigation, and FTEQW is
// excluded as a reference (ARCHITECTURE.md ruling), so there is no GPLv2
// original to port from. This is a clean-room format derived empirically
// from the retail data files themselves. A file under src/lib imports
// nothing from src/ outside src/lib, so this module defines its own
// minimal Vec3-like type rather than importing mathlib.ts's Vec3.
//
// METHOD: every retail .nav file's header (version, node/link/hint counts)
// is trustworthy on its face (Bots and navigation ARCHITECTURE.md section:
// "NAV2 v12: nodes with flags/links/radius, links with targets and hint
// types"). Working from that and the brief's own byte-count algebra for
// dm4.nav (3302 bytes total; 20-byte header; 85 nodes * 8 bytes = 680; 2602
// bytes left for 197 links + 11 hints + node positions), every candidate
// field layout below was checked by (a) parsing ALL 67 real retail .nav
// files across id1 (42, excluding the 9 debug maps under
// bots/navigation/test/ -- see VERSIONS below), mg1 (11), mg3 (1), ctf (8),
// hipnotic (3), rogue (1) and dopa (1), requiring the computed end offset
// to land EXACTLY on end-of-file with no slack, every link's target node
// index to be < the node count, and every node's firstLink+linkCount to be
// <= the link count; and (b) cross-checking every node's parsed xyz
// position against its matching map's model-0 (worldspawn) bounding box,
// read from the compiled .bsp with the engine's own src/common/bspfile.ts
// DataView readers (test-only use, per this unit's brief -- src/lib itself
// never imports bspfile.ts). All 67 files pass (a) exactly; 65 of 67 pass
// (b) within a generous 64-unit margin -- the two exceptions are a single
// isolated (linkCount 0) far-flung outlier node in e1m4... [see
// e4m4.nav, node 382, at z=-7665 against a map whose z bounds are
// [-383, 471]: a real, disconnected, zero-link node, not a parser bug] and
// mg3's own remade dm1.nav, whose bundled maps/dm1.bsp's worldspawn bounds
// (y up to 1023) don't cover several node positions (y up to ~1600) --
// almost certainly a stale/mismatched .bsp shipped alongside that .nav in
// the retail pak, not a layout error here (every OTHER file, including
// id1's original dm1.nav against id1's dm1.bsp, matches cleanly). See
// test/lib_nav.test.ts for the exact assertions.
//
// VERSIONS: the retail files carry version numbers from 6 to 18, not a
// single constant 12 as the brief's overview states -- 12 is dm4.nav's own
// version, not a fixed format version. The split is clean: every file
// under bots/navigation/test/ (9 debug/QA maps: mals_combatbox,
// test_barrierjump, test_button, test_characters, test_door, test_nodes,
// test_obstacles, test_rockets, test_walkoffledge) carries version 6-11
// and uses a visibly different, smaller on-disk layout (hand-decoded for
// test_button.nav: 8-byte nodes and 12-byte float positions match the
// layout below, but the link record and the tail are different and this
// reader does not attempt to decode them -- these are debug assets, never
// referenced by mapdb.json, not needed for real bot play). Every file
// OUTSIDE bots/navigation/test/ -- every real single-player, deathmatch,
// horde and ctf map in every retail tree -- carries version 12-18 and
// matches the ONE layout documented below exactly. This reader supports
// version >= 12 only, erroring clearly (not guessing) below that.
//
// FIELD SEMANTICS: the byte layout below was pinned down first (see
// METHOD, above); the meaning of the link/hint/entity-table/flag fields
// was resolved afterwards by measuring every one of the 42 real
// (non-debug) .nav files in the retail id1 pak against the matching
// maps/*.bsp -- reproduced as assertions in the "NAV2 vocabulary, against
// the real id1 data" describe block in test/lib_bot_brain.test.ts. That
// evidence is folded into LAYOUT and NODE FLAGS below so this reader
// documents its own semantics rather than leaving it to a caller.
//
// LAYOUT (version >= 12):
//
//   header (20 bytes, or 24 for version >= 16):
//     char       magic[4]      "NAV2"
//     int32      version
//     int32      nodeCount
//     int32      linkCount
//     int32      hintCount
//     float32    scale             -- version >= 16 only; meaning
//                                     unconfirmed (never referenced by the
//                                     rest of the file's byte layout), kept
//                                     as NavFile.scale, defaults to 1 below
//                                     version 16.
//
//   nodeCount * 8-byte nodes, immediately after the header:
//     uint16     flags             -- see NODE FLAGS below.
//     uint16     linkCount
//     uint16     firstLink         -- index into the link array below
//     uint16     radius
//
//   nodeCount * 12-byte positions, immediately after ALL nodes (not
//   interleaved with the node records):
//     float32    x, y, z
//
//   linkCount * 6-byte links, immediately after all positions:
//     uint16     target            -- always < nodeCount, verified
//     uint16     type              -- the LINK TYPE, an enum with the same
//                                     ordinals as the 2023 Quake II
//                                     re-release's own nav link types
//                                     (quake-2-re-ts src/server/nav.ts's
//                                     NavLinkTypeT), truncated at 8 -- Quake
//                                     1 has no crouch and no ladders, so the
//                                     enum stops before those. Exported
//                                     below as NavLinkType/NavLinkTypeT.
//                                     Per-type counts and evidence, from
//                                     the id1 sweep:
//
//                                       0 Walk           39452 links;
//                                         average dz -0.9, average XY span
//                                         118.
//                                       1 LongJump         213; carries a
//                                         traversal; average dz -27.
//                                       2 Teleport         125; NEVER
//                                         carries a traversal; average XY
//                                         span 1142 units, and the single
//                                         nearest map entity to its
//                                         endpoints is
//                                         `info_teleport_destination` in 44
//                                         of 125 cases -- by far the top
//                                         classname.
//                                       3 WalkOffLedge    2866; average dz
//                                         -131.8, i.e. it drops. 2284 of
//                                         the 2866 have an all-zero
//                                         traversal funnel.
//                                       4 Pusher            11; average dz
//                                         +408, average XY span 757
//                                         (trigger_push arcs).
//                                       5 BarrierJump     255; dz in [-48,
//                                         256], average XY span 98 -- a hop
//                                         over something small.
//                                       6 Elevator        166; average dz
//                                         +184 with an average XY span of
//                                         only 91: straight up, on a
//                                         platform.
//                                       7 Train            21; average XY
//                                         span 462, and `path_corner` is
//                                         the nearest entity for 12 of the
//                                         21 -- func_train.
//                                       8 ManualLongJump  192; a jump the
//                                         mapper placed by hand.
//
//     uint16     traversal         -- a TRAVERSAL INDEX into the hint
//                                     array below, or 0xFFFF (65535)
//                                     meaning "none" (parsed as `null`
//                                     below). Every hint in every file is
//                                     referenced exactly once, and the
//                                     indices run 0..hintCount-1 in link
//                                     order (dm4: 11 hints, 11 links
//                                     referencing 0..10; e1m1: 78 hints,
//                                     indices 0..77). A link of type Walk
//                                     never carries one.
//
//   hintCount * 36-byte hints, immediately after all links:
//     float32    funnel[3], start[3], end[3]   -- three positions that
//                                     line up with the Quake II
//                                     NavTraversalT minus its ladder plane:
//
//                                       funnel   (0,0,0) when unused. Often
//                                                IDENTICAL across several
//                                                consecutive hints in the
//                                                same file (observed in
//                                                dm4.nav: hints 0,1,3,4,7
//                                                all share the exact same
//                                                value), consistent with
//                                                several hints pointing at
//                                                one shared destination (a
//                                                jump pad or similar).
//                                       start    average distance to the
//                                                link's SOURCE node: 1 unit
//                                                for Elevator, 24-37 units
//                                                for every other type.
//                                       end      average distance to the
//                                                link's TARGET node: 0-1
//                                                unit for
//                                                WalkOffLedge/Elevator/
//                                                ManualLongJump, 20-33 for
//                                                the rest.
//
//   one uint32 entityLinkCount, immediately after all hints, followed by
//   entityLinkCount fixed-size records (26/30/34 bytes depending on
//   version -- see ENTITY_LINK_TAIL_WORDS below). This whole trailing
//   section is 4 bytes (just the zero count) in the large majority of
//   retail files. It is the file's ENTITY-BOUND LINK table (Quake II's
//   nav_edict_t), exposed below as NavFile.entityLinks:
//     uint16     link              -- a LINK INDEX into the flat link
//                                     array above -- all 409 records
//                                     across the retail id1 files index a
//                                     valid link, and 163 of them index an
//                                     Elevator link and 19 a Train link.
//     float32    mins[3]           -- the bound entity's bounding box
//                                     MINS
//     float32    maxs[3]           -- ... and MAXS (mins is less than
//                                     maxs on every axis in every record;
//                                     this is a bounding box, not a
//                                     takeoff and a landing point).
//     uint16[]   tail              -- version-dependent length (0, 2 or 4
//                                     uint16 words -- see
//                                     ENTITY_LINK_TAIL_WORDS); last word is
//                                     0xFFFF in every non-empty sample
//                                     seen (a sentinel?), the rest vary in
//                                     a narrow small-signed-int16 range,
//                                     equivalently a small non-positive
//                                     int32 in [-1051, 0]; meaning not
//                                     confirmed, kept raw.
//
// NODE FLAGS (NavNode.flags), same sweep -- exported below as
// NavNodeFlags:
//
//   1   Teleporter     124 nodes; 100% of their outgoing links are
//                      Teleport.
//   2   Pusher          11 nodes; 100% of their outgoing links are Pusher.
//   4   ElevatorTop    159 nodes; their INCOMING links are Elevator (153 of
//                      them) and none of their outgoing links are.
//   8   ElevatorBottom 130 nodes; the mirror image -- 150 outgoing Elevator
//                      links, only 8 incoming.
//   16  UnderWater    1835 nodes; a point-contents walk of each map's own
//                      BSP hull puts 1835 of 1835 in water/slime/lava,
//                      against a 1.24% base rate for every other node.
//                      This one is airtight.
//   32/64/128/256      120-150 nodes each, no correlation with link types
//                      at all, and they occur almost exclusively in
//                      combination with one another (320, 352, 384, 288,
//                      96, 144, 160). Quake II's nav has four "re-check
//                      this node at runtime" flags in exactly these bit
//                      positions (CheckForHazard, CheckHasFloor,
//                      CheckInSolid, NoMonsters); that reading fits the
//                      distribution but nothing here confirms which is
//                      which, so they are exposed together below as
//                      NavNodeFlags.ConditionalMask / NavNode.conditionalMask
//                      rather than four guessed names.
//   No retail node uses bit 9 or above.

export interface NavVec3 {
  x: number;
  y: number;
  z: number;
}

/** NavLink.type's nine values; see this file's header for the evidence behind each. */
export const NavLinkType = {
  Walk: 0,
  LongJump: 1,
  Teleport: 2,
  WalkOffLedge: 3,
  Pusher: 4,
  BarrierJump: 5,
  Elevator: 6,
  Train: 7,
  ManualLongJump: 8,
} as const;
export type NavLinkTypeT = number;

/** NavNode.flags's bits; see NODE FLAGS in this file's header for the evidence behind each. */
export const NavNodeFlags = {
  Teleporter: 1,
  Pusher: 2,
  ElevatorTop: 4,
  ElevatorBottom: 8,
  UnderWater: 16,
  /** Bits 5..8 together: "the engine re-checks this node at runtime". See the file header. */
  ConditionalMask: 32 | 64 | 128 | 256,
} as const;
export type NavNodeFlagsT = number;

export class NavNode {
  flags = 0;
  linkCount = 0;
  firstLink = 0;
  radius = 0;
  position: NavVec3 = { x: 0, y: 0, z: 0 };

  /** The four unconfirmed "re-check at runtime" bits of `flags`, isolated together; see NODE FLAGS above. */
  get conditionalMask(): number {
    return this.flags & NavNodeFlags.ConditionalMask;
  }
}

export class NavLink {
  target = 0;
  type: NavLinkTypeT = NavLinkType.Walk;
  /** Index into the file's hint array, or null when the link carries no traversal (on-disk 0xFFFF). */
  traversal: number | null = null;
}

export class NavHint {
  funnel: NavVec3 = { x: 0, y: 0, z: 0 };
  start: NavVec3 = { x: 0, y: 0, z: 0 };
  end: NavVec3 = { x: 0, y: 0, z: 0 };
}

export class NavEntityLink {
  /** Index into the file's flat link array. */
  link = 0;
  mins: NavVec3 = { x: 0, y: 0, z: 0 };
  maxs: NavVec3 = { x: 0, y: 0, z: 0 };
  /** Version-dependent trailing words (0, 2 or 4 of them) whose meaning is not confirmed; see this file's header. */
  tail: number[] = [];
}

export class NavFile {
  version = 0;
  /** version >= 16 only; 1 for older versions, which have no on-disk scale field. */
  scale = 1;
  nodes: NavNode[] = [];
  links: NavLink[] = [];
  hints: NavHint[] = [];
  entityLinks: NavEntityLink[] = [];
}

export interface NavParseResult {
  file: NavFile | undefined;
  errors: string[];
}

const NAV_MAGIC = "NAV2";
const MIN_SUPPORTED_VERSION = 12;

const NODE_SIZE = 8;
const POSITION_SIZE = 12;
const LINK_SIZE = 6;
const HINT_SIZE = 36;
const ENTITY_LINK_FIXED_SIZE = 2 + 12 + 12; // link index + mins + maxs

/** Trailing uint16 word count in an entity-link record, by version: 0 for v12, 4 for v13/14, 2 for v15+ (confirmed up to v18; extrapolated beyond). */
function entityLinkTailWords(version: number): number {
  if (version <= 12) return 0;
  if (version <= 14) return 4;
  return 2;
}

function entityLinkRecordSize(version: number): number {
  return ENTITY_LINK_FIXED_SIZE + entityLinkTailWords(version) * 2;
}

function readVec3(view: DataView, offset: number): NavVec3 {
  return { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
}

/**
 * Parses a .nav file's raw bytes. Never throws -- a structural problem
 * (bad magic, an unsupported pre-retail debug-format version, or a byte
 * count that doesn't add up) is reported in `errors` and `file` is left
 * undefined rather than reading out of bounds or guessing. `errors` may
 * carry non-fatal warnings (e.g. an untested version above the confirmed
 * range) alongside a populated `file`.
 */
export function parseNav(bytes: Uint8Array): NavParseResult {
  const errors: string[] = [];

  if (bytes.length < 20) return { file: undefined, errors: ["file too short for a NAV2 header"] };

  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== NAV_MAGIC) return { file: undefined, errors: [`bad magic "${magic}", expected "${NAV_MAGIC}"`] };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getInt32(4, true);
  const nodeCount = view.getInt32(8, true);
  const linkCount = view.getInt32(12, true);
  const hintCount = view.getInt32(16, true);

  if (version < MIN_SUPPORTED_VERSION) {
    return {
      file: undefined,
      errors: [
        `nav version ${version} is older than ${MIN_SUPPORTED_VERSION}; only the retail bots/navigation/test/ debug maps use versions this old, ` +
          "with a different, unconfirmed record layout this reader does not decode",
      ],
    };
  }
  if (version > 18) {
    errors.push(`nav version ${version} is newer than any confirmed retail sample (max 18 seen); parsing with the v15+ layout as a best-effort guess`);
  }

  const headerSize = version >= 16 ? 24 : 20;
  if (bytes.length < headerSize) return { file: undefined, errors: [...errors, "file too short for its own header (version >= 16 needs a trailing scale field)"] };
  const scale = version >= 16 ? view.getFloat32(20, true) : 1;

  const nodeOff = headerSize;
  const posOff = nodeOff + nodeCount * NODE_SIZE;
  const linkOff = posOff + nodeCount * POSITION_SIZE;
  const hintOff = linkOff + linkCount * LINK_SIZE;
  const entityCountOff = hintOff + hintCount * HINT_SIZE;
  const entityItemsOff = entityCountOff + 4;

  if (entityItemsOff > bytes.length) {
    return { file: undefined, errors: [...errors, `file too short: expected at least ${entityItemsOff} bytes for ${nodeCount} nodes / ${linkCount} links / ${hintCount} hints, got ${bytes.length}`] };
  }

  const entityLinkCount = view.getUint32(entityCountOff, true);
  const recordSize = entityLinkRecordSize(version);
  const expectedEnd = entityItemsOff + entityLinkCount * recordSize;
  if (expectedEnd !== bytes.length) {
    return {
      file: undefined,
      errors: [...errors, `file length mismatch: computed end offset ${expectedEnd} (entityLinkCount=${entityLinkCount}, record size ${recordSize}) does not match actual length ${bytes.length}`],
    };
  }

  const file = new NavFile();
  file.version = version;
  file.scale = scale;

  for (let i = 0; i < nodeCount; i++) {
    const base = nodeOff + i * NODE_SIZE;
    const node = new NavNode();
    node.flags = view.getUint16(base, true);
    node.linkCount = view.getUint16(base + 2, true);
    node.firstLink = view.getUint16(base + 4, true);
    node.radius = view.getUint16(base + 6, true);
    node.position = readVec3(view, posOff + i * POSITION_SIZE);
    file.nodes.push(node);
    if (node.firstLink + node.linkCount > linkCount) {
      errors.push(`node ${i}: firstLink (${node.firstLink}) + linkCount (${node.linkCount}) exceeds the file's linkCount (${linkCount})`);
    }
  }

  for (let i = 0; i < linkCount; i++) {
    const base = linkOff + i * LINK_SIZE;
    const link = new NavLink();
    link.target = view.getUint16(base, true);
    link.type = view.getUint16(base + 2, true);
    const rawTraversal = view.getUint16(base + 4, true);
    link.traversal = rawTraversal === 0xffff ? null : rawTraversal;
    file.links.push(link);
    if (link.target >= nodeCount) errors.push(`link ${i}: target node ${link.target} is out of range (nodeCount=${nodeCount})`);
  }

  for (let i = 0; i < hintCount; i++) {
    const base = hintOff + i * HINT_SIZE;
    const hint = new NavHint();
    hint.funnel = readVec3(view, base);
    hint.start = readVec3(view, base + 12);
    hint.end = readVec3(view, base + 24);
    file.hints.push(hint);
  }

  const tailWords = entityLinkTailWords(version);
  for (let i = 0; i < entityLinkCount; i++) {
    const base = entityItemsOff + i * recordSize;
    const record = new NavEntityLink();
    record.link = view.getUint16(base, true);
    record.mins = readVec3(view, base + 2);
    record.maxs = readVec3(view, base + 14);
    for (let w = 0; w < tailWords; w++) record.tail.push(view.getUint16(base + ENTITY_LINK_FIXED_SIZE + w * 2, true));
    file.entityLinks.push(record);
  }

  return { file, errors };
}
