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
//     uint16     flags
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
//     uint16     unknown0          -- 0 in every sample seen except a
//                                     handful of specific node-pairs in the
//                                     bots/navigation/test/ debug maps
//                                     (link size differs there anyway, so
//                                     not cross-checked against retail
//                                     content); meaning not confirmed.
//     uint16     unknown1          -- 0xFFFF (65535) in every debug-map
//                                     sample seen except one specific
//                                     link per test map (test_button.nav,
//                                     test_door.nav: a link gated by a
//                                     button/door has a distinct small
//                                     value here instead, e.g. 176 or 158)
//                                     -- consistent with an edict/entity
//                                     index the link is conditioned on,
//                                     but not confirmed against source, so
//                                     named conservatively.
//
//   hintCount * 36-byte hints, immediately after all links:
//     float32    pos0[3], pos1[3], pos2[3]   -- three positions. pos0 is
//                                     (0,0,0) in most samples (an
//                                     "unused" slot for most hints); pos2
//                                     is often IDENTICAL across several
//                                     consecutive hints in the same file
//                                     (observed in dm4.nav: hints 0,1,3,4,7
//                                     all share the exact same pos2),
//                                     consistent with several hints
//                                     pointing at one shared destination
//                                     (a jump pad or similar), but which
//                                     of the three is "approach" vs
//                                     "landing" is not confirmed against
//                                     source -- named pos0/pos1/pos2, not
//                                     "from"/"to", deliberately.
//
//   one uint32 jumpLinkCount, immediately after all hints, followed by
//   jumpLinkCount fixed-size records (26/30/34 bytes depending on
//   version -- see JUMP_LINK_TAIL_WORDS below). This whole trailing
//   section is 4 bytes (just the zero count) in the large majority of
//   retail files; every file with jumpLinkCount > 0 confirmed the record
//   layout: entries repeat a pattern of "one uint16 that is far too large
//   to be a node or hint index in that file (seen up to 1544 against a
//   526-node map) but is a plausible edict/entity index, followed by two
//   xyz float32 positions in the map's coordinate space" -- consistent
//   with a jump-pad/trigger cross-reference (an entity id plus a takeoff
//   and landing point), not confirmed against source. Record layout:
//     uint16     edict             -- see above; named conservatively
//     float32    from[3]
//     float32    to[3]
//     uint16[]   tail              -- version-dependent length (0, 2 or 4
//                                     uint16 words -- see
//                                     JUMP_LINK_TAIL_WORDS); last word is
//                                     0xFFFF in every non-empty sample
//                                     seen (a sentinel?), the rest vary in
//                                     a narrow small-signed-int16 range;
//                                     meaning not confirmed, kept raw.

export interface NavVec3 {
  x: number;
  y: number;
  z: number;
}

export class NavNode {
  flags = 0;
  linkCount = 0;
  firstLink = 0;
  radius = 0;
  position: NavVec3 = { x: 0, y: 0, z: 0 };
}

export class NavLink {
  target = 0;
  unknown0 = 0;
  unknown1 = 0;
}

export class NavHint {
  pos0: NavVec3 = { x: 0, y: 0, z: 0 };
  pos1: NavVec3 = { x: 0, y: 0, z: 0 };
  pos2: NavVec3 = { x: 0, y: 0, z: 0 };
}

export class NavJumpLink {
  edict = 0;
  from: NavVec3 = { x: 0, y: 0, z: 0 };
  to: NavVec3 = { x: 0, y: 0, z: 0 };
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
  jumpLinks: NavJumpLink[] = [];
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
const JUMP_LINK_FIXED_SIZE = 2 + 12 + 12; // edict + from + to

/** Trailing uint16 word count in a jump-link record, by version: 0 for v12, 4 for v13/14, 2 for v15+ (confirmed up to v18; extrapolated beyond). */
function jumpLinkTailWords(version: number): number {
  if (version <= 12) return 0;
  if (version <= 14) return 4;
  return 2;
}

function jumpLinkRecordSize(version: number): number {
  return JUMP_LINK_FIXED_SIZE + jumpLinkTailWords(version) * 2;
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
  const jumpCountOff = hintOff + hintCount * HINT_SIZE;
  const jumpItemsOff = jumpCountOff + 4;

  if (jumpItemsOff > bytes.length) {
    return { file: undefined, errors: [...errors, `file too short: expected at least ${jumpItemsOff} bytes for ${nodeCount} nodes / ${linkCount} links / ${hintCount} hints, got ${bytes.length}`] };
  }

  const jumpLinkCount = view.getUint32(jumpCountOff, true);
  const recordSize = jumpLinkRecordSize(version);
  const expectedEnd = jumpItemsOff + jumpLinkCount * recordSize;
  if (expectedEnd !== bytes.length) {
    return {
      file: undefined,
      errors: [...errors, `file length mismatch: computed end offset ${expectedEnd} (jumpLinkCount=${jumpLinkCount}, record size ${recordSize}) does not match actual length ${bytes.length}`],
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
    link.unknown0 = view.getUint16(base + 2, true);
    link.unknown1 = view.getUint16(base + 4, true);
    file.links.push(link);
    if (link.target >= nodeCount) errors.push(`link ${i}: target node ${link.target} is out of range (nodeCount=${nodeCount})`);
  }

  for (let i = 0; i < hintCount; i++) {
    const base = hintOff + i * HINT_SIZE;
    const hint = new NavHint();
    hint.pos0 = readVec3(view, base);
    hint.pos1 = readVec3(view, base + 12);
    hint.pos2 = readVec3(view, base + 24);
    file.hints.push(hint);
  }

  const tailWords = jumpLinkTailWords(version);
  for (let i = 0; i < jumpLinkCount; i++) {
    const base = jumpItemsOff + i * recordSize;
    const jump = new NavJumpLink();
    jump.edict = view.getUint16(base, true);
    jump.from = readVec3(view, base + 2);
    jump.to = readVec3(view, base + 14);
    for (let w = 0; w < tailWords; w++) jump.tail.push(view.getUint16(base + JUMP_LINK_FIXED_SIZE + w * 2, true));
    file.jumpLinks.push(jump);
  }

  return { file, errors };
}
