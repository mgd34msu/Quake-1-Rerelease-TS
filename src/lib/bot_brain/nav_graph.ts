// A searchable navigation graph built from a parsed NAV2 file, plus the A*
// that runs over it, the string-pulling pass that turns a node chain into a
// list of steering points, and the nearest-node lookup a path request starts
// from.
//
// WHAT THE NAV2 "UNKNOWN" FIELDS ACTUALLY ARE
// -------------------------------------------
// src/lib/nav.ts decodes the file's byte layout but names three fields
// conservatively ("unknown0", "unknown1", the trailing "jump link" array)
// because it had no source to confirm them against. This unit resolved all
// three empirically, by measuring every one of the 42 real (non-debug) .nav
// files in the retail id1 pak against the matching maps/*.bsp. The numbers
// below are from that sweep and are reproduced as assertions in
// test/lib_bot_brain.test.ts.
//
//   NavLink.unknown0 is the LINK TYPE, an enum with the same ordinals as
//   the 2023 Quake II re-release's own nav link types (quake-2-re-ts
//   src/server/nav.ts's NavLinkTypeT), truncated at 8 -- Quake 1 has no
//   crouch and no ladders, so the enum stops before those:
//
//     0 Walk           39452 links; average dz -0.9, average XY span 118.
//     1 LongJump         213; carries a traversal; average dz -27.
//     2 Teleport         125; NEVER carries a traversal; average XY span
//                        1142 units, and the single nearest map entity to
//                        its endpoints is `info_teleport_destination` in
//                        44 of 125 cases -- by far the top classname.
//     3 WalkOffLedge    2866; average dz -131.8, i.e. it drops. 2284 of the
//                        2866 have an all-zero traversal funnel.
//     4 Pusher            11; average dz +408, average XY span 757
//                        (trigger_push arcs).
//     5 BarrierJump     255; dz in [-48, 256], average XY span 98 -- a hop
//                        over something small.
//     6 Elevator        166; average dz +184 with an average XY span of
//                        only 91: straight up, on a platform.
//     7 Train            21; average XY span 462, and `path_corner` is the
//                        nearest entity for 12 of the 21 -- func_train.
//     8 ManualLongJump  192; a jump the mapper placed by hand.
//
//   NavLink.unknown1 is a TRAVERSAL INDEX into the file's hint array, with
//   0xFFFF meaning "none". Every hint in every file is referenced exactly
//   once, and the indices run 0..hintCount-1 in link order (dm4: 11 hints,
//   11 links referencing 0..10; e1m1: 78 hints, indices 0..77). A link with
//   type 0 (Walk) never carries one.
//
//   NavHint's three positions are that traversal, and they line up with the
//   Quake II NavTraversalT minus its ladder plane:
//     pos0 = funnel     (0,0,0) when unused
//     pos1 = start      average distance to the link's SOURCE node: 1 unit
//                       for Elevator, 24-37 units for every other type.
//     pos2 = end        average distance to the link's TARGET node: 0-1
//                       unit for WalkOffLedge/Elevator/ManualLongJump,
//                       20-33 for the rest.
//
//   The trailing array src/lib/nav.ts calls `jumpLinks` is NOT a jump list:
//   it is the file's ENTITY-BOUND LINK table (Quake II's nav_edict_t). Its
//   leading uint16 is a LINK INDEX -- all 409 records across the retail id1
//   files index a valid link, and 163 of them index an Elevator link and 19
//   a Train link -- and its two vectors are that entity's bounding box
//   MINS and MAXS, not a takeoff and a landing point (`from` is less than
//   `to` on every axis in every record). The trailing words are a small
//   non-positive int32 in [-1051, 0] whose meaning is still unconfirmed and
//   is kept raw. This graph exposes the table as `entityLinks` so a link
//   whose traversal depends on a door/plat/train can be recognised and
//   weighted, which is what it is for.
//
// NODE FLAGS (NavNode.flags), same sweep:
//
//   1   Teleporter     124 nodes; 100% of their outgoing links are Teleport.
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
//                      which, so they are exposed as one `conditional`
//                      predicate rather than four guessed names.
//   No retail node uses bit 9 or above.

import type { NavFile, NavNode } from "../nav";
import { bvec, bvecAdd, bvecDistance, bvecDistance2D, bvecNormalized, bvecScale, bvecSub, type BotVec3 } from "./math";

//============================================================================
// vocabulary

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

export const NavNodeFlag = {
  Teleporter: 1,
  Pusher: 2,
  ElevatorTop: 4,
  ElevatorBottom: 8,
  UnderWater: 16,
  /** Bits 5..8 together: "the engine re-checks this node at runtime". See the file header. */
  ConditionalMask: 32 | 64 | 128 | 256,
} as const;

/** The link types that only work by leaving the ground under power. */
export function navLinkIsJump(type: NavLinkTypeT): boolean {
  return type === NavLinkType.LongJump || type === NavLinkType.BarrierJump || type === NavLinkType.ManualLongJump;
}

/** The link types whose traversal is owned by a map entity (plat, train, push, teleport). */
export function navLinkIsEntity(type: NavLinkTypeT): boolean {
  return type === NavLinkType.Teleport || type === NavLinkType.Pusher || type === NavLinkType.Elevator || type === NavLinkType.Train;
}

//============================================================================
// graph

/** NavHint's three positions, named for what the sweep showed them to be. */
export interface NavTraversalT {
  funnel: BotVec3;
  start: BotVec3;
  end: BotVec3;
}

export interface NavGraphLinkT {
  /** Index of the node this link leaves. */
  from: number;
  /** Index of the node this link reaches. */
  to: number;
  type: NavLinkTypeT;
  traversal: NavTraversalT | null;
  /** The bounding box of the map entity that owns this link, when the file names one. */
  entityBounds: { mins: BotVec3; maxs: BotVec3 } | null;
}

export interface NavGraphNodeT {
  index: number;
  origin: BotVec3;
  radius: number;
  flags: number;
  links: NavGraphLinkT[];
}

/** What a searcher is willing to traverse. Mirrors the settings a skill turns on. */
export interface NavTraverseCapsT {
  jump: boolean;
  walkOffLedge: boolean;
  /** Elevator/Train/Pusher/Teleport links, i.e. the ones another entity has to move. */
  entityTraversal: boolean;
  /** Water nodes: a monster that cannot swim must not be routed through them. */
  swim: boolean;
  /** A drop this deep or deeper is refused. 0 disables the check. */
  maxDrop: number;
  /** A rise this high or higher over a jump link is refused. 0 disables the check. */
  maxJumpHeight: number;
  /**
   * A node the searcher refuses to stand on, whatever its flags say. The
   * caller supplies it because only the game can answer "is this point
   * inside lava"; the graph itself has no world to ask. Left undefined,
   * nothing is avoided.
   */
  avoid?: (node: NavGraphNodeT) => boolean;
}

export function defaultTraverseCaps(): NavTraverseCapsT {
  return { jump: true, walkOffLedge: true, entityTraversal: true, swim: true, maxDrop: 0, maxJumpHeight: 0 };
}

export interface NavPathT {
  /** The node chain A* found, start node first, goal node last. */
  nodes: number[];
  /** The steering points the follower actually walks, after string pulling. */
  points: BotVec3[];
  /** `points[i]` is reached by traversing this link; null for a plain walk segment. */
  links: Array<NavGraphLinkT | null>;
  /** Summed edge cost of the node chain. */
  cost: number;
}

/**
 * A NAV2 file turned into an adjacency structure. Built once per map load and
 * then read-only, so several bots and every monster share one instance.
 */
export class NavGraph {
  readonly nodes: NavGraphNodeT[] = [];
  readonly links: NavGraphLinkT[] = [];
  /** Every link the file bound to a map entity's bounding box. */
  readonly entityLinks: NavGraphLinkT[] = [];

  // A* scratch, sized once. Reused across searches; a search always writes
  // every slot it reads, so leftovers from the previous search never leak.
  private readonly gScore: Float64Array;
  private readonly cameFrom: Int32Array;
  private readonly generation: Int32Array;
  private searchGeneration = 0;

  constructor(file: NavFile) {
    for (let i = 0; i < file.nodes.length; i++) {
      const src: NavNode = file.nodes[i]!;
      this.nodes.push({
        index: i,
        origin: { x: src.position.x, y: src.position.y, z: src.position.z },
        radius: src.radius,
        flags: src.flags,
        links: [],
      });
    }

    for (let i = 0; i < file.nodes.length; i++) {
      const src = file.nodes[i]!;
      for (let k = 0; k < src.linkCount; k++) {
        const raw = file.links[src.firstLink + k];
        if (raw === undefined) continue;
        if (raw.target >= this.nodes.length) continue;

        let traversal: NavTraversalT | null = null;
        if (raw.unknown1 !== 0xffff) {
          const hint = file.hints[raw.unknown1];
          if (hint !== undefined) {
            traversal = {
              funnel: { x: hint.pos0.x, y: hint.pos0.y, z: hint.pos0.z },
              start: { x: hint.pos1.x, y: hint.pos1.y, z: hint.pos1.z },
              end: { x: hint.pos2.x, y: hint.pos2.y, z: hint.pos2.z },
            };
          }
        }

        const link: NavGraphLinkT = { from: i, to: raw.target, type: raw.unknown0, traversal, entityBounds: null };
        this.nodes[i]!.links.push(link);
        this.links.push(link);
      }
    }

    // The trailing table indexes the flat link array; see the file header.
    const flatIndexOf = new Map<number, NavGraphLinkT>();
    {
      let flat = 0;
      for (let i = 0; i < file.nodes.length; i++) {
        const src = file.nodes[i]!;
        for (let k = 0; k < src.linkCount; k++) flatIndexOf.set(src.firstLink + k, this.links[flat++]!);
      }
    }
    for (const record of file.jumpLinks) {
      const link = flatIndexOf.get(record.edict);
      if (link === undefined) continue;
      link.entityBounds = {
        mins: { x: record.from.x, y: record.from.y, z: record.from.z },
        maxs: { x: record.to.x, y: record.to.y, z: record.to.z },
      };
      this.entityLinks.push(link);
    }

    this.gScore = new Float64Array(this.nodes.length);
    this.cameFrom = new Int32Array(this.nodes.length);
    this.generation = new Int32Array(this.nodes.length);
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  //--------------------------------------------------------------------------

  /** True when this link is one the given capabilities allow. */
  linkTraversable(link: NavGraphLinkT, caps: NavTraverseCapsT): boolean {
    const from = this.nodes[link.from];
    const to = this.nodes[link.to];
    if (from === undefined || to === undefined) return false;

    if (!caps.swim && (to.flags & NavNodeFlag.UnderWater) !== 0) return false;
    if (caps.avoid !== undefined && caps.avoid(to)) return false;

    if (navLinkIsEntity(link.type)) {
      if (!caps.entityTraversal) return false;
    } else if (link.type === NavLinkType.WalkOffLedge) {
      if (!caps.walkOffLedge) return false;
      if (caps.maxDrop > 0 && to.origin.z < from.origin.z - caps.maxDrop) return false;
    } else if (navLinkIsJump(link.type)) {
      if (!caps.jump) return false;
      if (caps.maxJumpHeight > 0 && to.origin.z > from.origin.z + caps.maxJumpHeight) return false;
    }

    return true;
  }

  /**
   * The closest node to `point` that the caller can actually stand on. The
   * height window keeps a node on the floor above from winning over one in
   * the same room; the radius cap keeps a lookup from wandering across the
   * whole map. `visible` is the caller's own line-of-sight test, so the
   * brain never has to know how the game traces.
   */
  closestNode(point: BotVec3, opts: { maxRadius?: number; belowHeight?: number; aboveHeight?: number; visible?: (from: BotVec3, to: BotVec3) => boolean; caps?: NavTraverseCapsT } = {}): number {
    const maxRadius = opts.maxRadius ?? 512;
    const below = opts.belowHeight ?? 128;
    const above = opts.aboveHeight ?? 128;
    const caps = opts.caps;

    let best = -1;
    let bestDist = Infinity;
    // Two passes: the first insists on line of sight, the second drops that
    // requirement. A bot spawned inside a doorway can fail every trace and
    // still needs a node to start from.
    for (let pass = 0; pass < 2; pass++) {
      for (const node of this.nodes) {
        if (caps !== undefined && !caps.swim && (node.flags & NavNodeFlag.UnderWater) !== 0) continue;
        if (caps?.avoid !== undefined && caps.avoid(node)) continue;
        if (node.origin.z < point.z - below) continue;
        if (node.origin.z > point.z + above) continue;
        const d = bvecDistance2D(point, node.origin);
        if (d > maxRadius || d >= bestDist) continue;
        if (pass === 0 && opts.visible !== undefined && !opts.visible(point, node.origin)) continue;
        bestDist = d;
        best = node.index;
      }
      if (best >= 0) return best;
      if (opts.visible === undefined) break;
    }
    return best;
  }

  //--------------------------------------------------------------------------

  /**
   * A* from `startNode` to `goalNode`. The heuristic is straight-line
   * distance, which never overestimates a graph whose edge cost is also
   * distance, so the first time the goal comes off the open set the path is
   * optimal. A Teleport edge costs a flat 1 because its two endpoints are
   * arbitrarily far apart in world space and the traversal is free in time.
   */
  findPath(startNode: number, goalNode: number, caps: NavTraverseCapsT = defaultTraverseCaps()): number[] | null {
    if (startNode < 0 || goalNode < 0 || startNode >= this.nodes.length || goalNode >= this.nodes.length) return null;
    if (startNode === goalNode) return [startNode];

    const gen = ++this.searchGeneration;
    const goal = this.nodes[goalNode]!;

    // The open set is a sorted array: pushes are O(n) but n is the frontier,
    // not the graph, and the largest retail map has 526 nodes.
    const openNodes: number[] = [startNode];
    const openScores: number[] = [bvecDistance(this.nodes[startNode]!.origin, goal.origin)];

    this.gScore[startNode] = 0;
    this.cameFrom[startNode] = -1;
    this.generation[startNode] = gen;

    while (openNodes.length > 0) {
      const current = openNodes.shift()!;
      openScores.shift();

      if (current === goalNode) {
        const chain: number[] = [];
        for (let n = current; n !== -1; n = this.cameFrom[n]!) chain.push(n);
        chain.reverse();
        return chain;
      }

      const node = this.nodes[current]!;
      const currentG = this.gScore[current]!;

      for (const link of node.links) {
        if (!this.linkTraversable(link, caps)) continue;

        const target = this.nodes[link.to]!;
        const step = link.type === NavLinkType.Teleport ? 1 : bvecDistance(node.origin, target.origin);
        const tentative = currentG + step;

        if (this.generation[link.to] === gen && tentative >= this.gScore[link.to]!) continue;

        this.generation[link.to] = gen;
        this.gScore[link.to] = tentative;
        this.cameFrom[link.to] = current;

        const f = tentative + bvecDistance(target.origin, goal.origin);
        let at = openNodes.length;
        for (let i = 0; i < openNodes.length; i++) {
          if (f < openScores[i]!) {
            at = i;
            break;
          }
        }
        openNodes.splice(at, 0, link.to);
        openScores.splice(at, 0, f);
      }
    }

    return null;
  }

  /** The link the graph holds between two adjacent nodes, if there is one. */
  linkBetween(from: number, to: number): NavGraphLinkT | null {
    const node = this.nodes[from];
    if (node === undefined) return null;
    for (const link of node.links) if (link.to === to) return link;
    return null;
  }

  //--------------------------------------------------------------------------

  /**
   * Turns a node chain into steering points.
   *
   * Node radii are the pulling budget: a walk segment between two nodes may
   * be cut to any point inside the next node's radius, so a corridor of
   * wide, roughly collinear nodes collapses to its two ends instead of
   * making the bot slalom between node centres. A node whose incoming link
   * is anything but a plain Walk is a hard waypoint -- a jump takeoff, a
   * teleporter mouth or a plat has to be hit exactly -- and pulling stops
   * there and restarts on the far side.
   *
   * `visible` is the caller's own trace; without one this falls back to a
   * purely geometric test (the skipped node must lie within its own radius
   * of the straight line being cut), which is what the unit tests use.
   */
  stringPull(chain: number[], goal: BotVec3, visible?: (from: BotVec3, to: BotVec3) => boolean): NavPathT {
    const points: BotVec3[] = [];
    const links: Array<NavGraphLinkT | null> = [];
    let cost = 0;

    if (chain.length === 0) return { nodes: chain, points, links, cost };

    for (let i = 1; i < chain.length; i++) {
      const link = this.linkBetween(chain[i - 1]!, chain[i]!);
      cost += link !== null && link.type === NavLinkType.Teleport ? 1 : bvecDistance(this.nodes[chain[i - 1]!]!.origin, this.nodes[chain[i]!]!.origin);
    }

    // A traversal's start point sits within a couple of units of its source
    // node, so the walk run that leads into it would otherwise emit two
    // steering points on top of each other. The later, more precise one wins.
    const push = (point: BotVec3, link: NavGraphLinkT | null): void => {
      const last = points[points.length - 1];
      if (last !== undefined && bvecDistance(last, point) <= 16) {
        points[points.length - 1] = point;
        links[links.length - 1] = link;
        return;
      }
      points.push(point);
      links.push(link);
    };

    let i = 0;
    while (i < chain.length) {
      const link = i === 0 ? null : this.linkBetween(chain[i - 1]!, chain[i]!);
      const hard = link !== null && link.type !== NavLinkType.Walk;

      if (hard) {
        // A traversal names its own start and end; walk to the start, then
        // to the end, so the follower has an exact takeoff and landing.
        if (link.traversal !== null) {
          push(link.traversal.start, link);
          push(link.traversal.end, null);
        } else {
          push(this.nodes[chain[i]!]!.origin, link);
        }
        i++;
        continue;
      }

      // Plain walk: reach as far ahead as the run stays straight enough.
      let far = i;
      for (let j = i + 1; j < chain.length; j++) {
        const step = this.linkBetween(chain[j - 1]!, chain[j]!);
        if (step === null || step.type !== NavLinkType.Walk) break;
        if (!this.canCut(chain, i === 0 ? -1 : i, j, points, visible)) break;
        far = j;
      }

      if (far > i) {
        push(this.nodes[chain[far]!]!.origin, null);
        i = far + 1;
      } else {
        push(this.nodes[chain[i]!]!.origin, null);
        i++;
      }
    }

    // The caller's own goal is the last thing to walk to, unless the path
    // already ends on top of it.
    const last = points[points.length - 1];
    if (last === undefined || bvecDistance(last, goal) > 1) {
      points.push({ x: goal.x, y: goal.y, z: goal.z });
      links.push(null);
    }


    return { nodes: chain, points, links, cost };
  }

  /** Whether the straight line from `chain[from]` (or the last emitted point) to `chain[to]` still covers every node it skips. */
  private canCut(chain: number[], fromIdx: number, toIdx: number, emitted: BotVec3[], visible?: (from: BotVec3, to: BotVec3) => boolean): boolean {
    const start = fromIdx < 0 ? (emitted.length > 0 ? emitted[emitted.length - 1]! : this.nodes[chain[0]!]!.origin) : this.nodes[chain[fromIdx]!]!.origin;
    const end = this.nodes[chain[toIdx]!]!.origin;

    if (visible !== undefined && !visible(start, end)) return false;

    const dir = bvecSub(end, start);
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (len === 0) return true;
    const unit = bvecScale(dir, 1 / len);

    const first = fromIdx < 0 ? 1 : fromIdx + 1;
    for (let k = first; k < toIdx; k++) {
      const skipped = this.nodes[chain[k]!]!;
      const along = Math.max(0, Math.min(len, (skipped.origin.x - start.x) * unit.x + (skipped.origin.y - start.y) * unit.y + (skipped.origin.z - start.z) * unit.z));
      const closest = bvecAdd(start, bvecScale(unit, along));
      // The node's own radius is the mapper's statement of how much room
      // there is around it; a cut that stays inside it stays in the corridor.
      if (bvecDistance(closest, skipped.origin) > Math.max(skipped.radius, 8)) return false;
    }
    return true;
  }

  //--------------------------------------------------------------------------

  /** Plan from a world point to a world point in one call. */
  planPath(
    start: BotVec3,
    goal: BotVec3,
    opts: { caps?: NavTraverseCapsT; visible?: (from: BotVec3, to: BotVec3) => boolean; maxRadius?: number } = {},
  ): NavPathT | null {
    const caps = opts.caps ?? defaultTraverseCaps();
    const startNode = this.closestNode(start, { visible: opts.visible, caps, maxRadius: opts.maxRadius });
    if (startNode < 0) return null;
    const goalNode = this.closestNode(goal, { visible: opts.visible, caps, maxRadius: opts.maxRadius });
    if (goalNode < 0) return null;

    const chain = this.findPath(startNode, goalNode, caps);
    if (chain === null) return null;
    return this.stringPull(chain, goal, opts.visible);
  }
}

/** The unit direction from `from` to `to`, flattened when the two are nearly stacked. */
export function steerDirection(from: BotVec3, to: BotVec3): BotVec3 {
  const d = bvecSub(to, from);
  if (Math.abs(d.x) < 0.001 && Math.abs(d.y) < 0.001) return bvec(0, 0, 0);
  return bvecNormalized(bvec(d.x, d.y, 0));
}
