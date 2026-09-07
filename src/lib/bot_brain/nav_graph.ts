// A searchable navigation graph built from a parsed NAV2 file, plus the A*
// that runs over it, the string-pulling pass that turns a node chain into a
// list of steering points, and the nearest-node lookup a path request starts
// from.
//
// The NAV2 field meanings (link types, traversal hints, the entity-bound
// link table, node flags) are documented on src/lib/nav.ts itself, which is
// where this unit's empirical sweep against the retail id1 pak ended up
// once the fields were confirmed -- see that file's header. The sweep's
// assertions live in test/lib_bot_brain.test.ts's "NAV2 vocabulary, against
// the real id1 data" describe block.

import { bvec, bvecAdd, bvecDistance, bvecDistance2D, bvecNormalized, bvecScale, bvecSub, type BotVec3 } from "./math";

//============================================================================
// vocabulary
//
// Declared here rather than imported from src/lib/nav.ts, so this directory
// stays game-agnostic (ARCHITECTURE.md, "Bots and navigation") and can be fed
// back into quake-2-re-ts's src/qcommon/bot_brain wholesale. The values are
// src/lib/nav.ts's own NavLinkType/NavNodeFlags, reproduced verbatim; see
// that file's header for the sweep that confirmed them.

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

export const NavNodeFlags = {
  Teleporter: 1,
  Pusher: 2,
  ElevatorTop: 4,
  ElevatorBottom: 8,
  UnderWater: 16,
  /** Bits 5..8 together: "the engine re-checks this node at runtime". See src/lib/nav.ts's header. */
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

//============================================================================
// what a graph is built from
//
// GAME-AGNOSTIC BY CONSTRUCTION. This class used to take a parsed NAV2 file
// (src/lib/nav.ts's `NavFile`) straight off the loader, so it carried Quake
// 1's own byte-layout vocabulary into its constructor. Quake II's NAV3 files
// hold the same graph in a different layout, read by a different loader, so
// the constructor now takes the neutral description below -- nodes and
// links, with the traversal and entity bounds already resolved -- and the
// NAV2 decode moved into `navGraphFromNav2`, which still accepts a Quake 1
// `NavFile` structurally (see `Nav2FileT` below): nothing in this directory
// imports src/lib/nav.ts, so the whole directory can be lifted into a second
// game's tree unchanged, the way quake-2-re-ts's src/qcommon/bot_brain does.

export interface NavGraphSourceNodeT {
  origin: BotVec3;
  radius: number;
  flags: number;
}

export interface NavGraphSourceLinkT {
  /** Index into `NavGraphSourceT.nodes` of the node this link leaves. */
  from: number;
  /** Index into `NavGraphSourceT.nodes` of the node this link reaches. */
  to: number;
  type: NavLinkTypeT;
  traversal: NavTraversalT | null;
  entityBounds: { mins: BotVec3; maxs: BotVec3 } | null;
}

export interface NavGraphSourceT {
  nodes: readonly NavGraphSourceNodeT[];
  links: readonly NavGraphSourceLinkT[];
}

//----------------------------------------------------------------------------
// the Quake 1 NAV2 file, structurally. src/lib/nav.ts's own `NavFile`/
// `NavNode`/`NavLink`/`NavHint`/`NavEntityLink` satisfy these without a
// conversion; declared here rather than imported so this directory keeps
// importing nothing outside itself.

export interface Nav2NodeT {
  position: BotVec3;
  radius: number;
  flags: number;
  firstLink: number;
  linkCount: number;
}

export interface Nav2LinkT {
  target: number;
  type: NavLinkTypeT;
  /** Index into the file's hint array, or null when the link carries no traversal. */
  traversal: number | null;
}

export interface Nav2HintT {
  funnel: BotVec3;
  start: BotVec3;
  end: BotVec3;
}

export interface Nav2EntityLinkT {
  /** Index into the file's flat link array. */
  link: number;
  mins: BotVec3;
  maxs: BotVec3;
}

export interface Nav2FileT {
  nodes: readonly Nav2NodeT[];
  links: readonly Nav2LinkT[];
  hints: readonly Nav2HintT[];
  entityLinks: readonly Nav2EntityLinkT[];
}

/**
 * The NAV2 decode this class's constructor used to be, unchanged: node link
 * ranges resolved against the flat link array, traversal indices resolved
 * against the hint array, and the trailing entity table attached to the flat
 * link each record indexes.
 */
export function navGraphFromNav2(file: Nav2FileT): NavGraph {
  const nodes: NavGraphSourceNodeT[] = [];
  for (const src of file.nodes) {
    nodes.push({ origin: { x: src.position.x, y: src.position.y, z: src.position.z }, radius: src.radius, flags: src.flags });
  }

  const links: NavGraphSourceLinkT[] = [];
  // The trailing table indexes the FILE's flat link array; `flatIndexOf` maps
  // a slot of that array to the link this builder actually produced from it,
  // because a link naming an out-of-range target is dropped and the two
  // arrays then no longer line up.
  const flatIndexOf = new Map<number, NavGraphSourceLinkT>();
  for (let i = 0; i < file.nodes.length; i++) {
    const src = file.nodes[i]!;
    for (let k = 0; k < src.linkCount; k++) {
      const slot = src.firstLink + k;
      const raw = file.links[slot];
      if (raw === undefined) continue;
      if (raw.target >= nodes.length) continue;

      let traversal: NavTraversalT | null = null;
      if (raw.traversal !== null) {
        const hint = file.hints[raw.traversal];
        if (hint !== undefined) {
          traversal = {
            funnel: { x: hint.funnel.x, y: hint.funnel.y, z: hint.funnel.z },
            start: { x: hint.start.x, y: hint.start.y, z: hint.start.z },
            end: { x: hint.end.x, y: hint.end.y, z: hint.end.z },
          };
        }
      }

      const link: NavGraphSourceLinkT = { from: i, to: raw.target, type: raw.type, traversal, entityBounds: null };
      flatIndexOf.set(slot, link);
      links.push(link);
    }
  }

  for (const record of file.entityLinks) {
    const link = flatIndexOf.get(record.link);
    if (link === undefined) continue;
    link.entityBounds = {
      mins: { x: record.mins.x, y: record.mins.y, z: record.mins.z },
      maxs: { x: record.maxs.x, y: record.maxs.y, z: record.maxs.z },
    };
  }

  return new NavGraph({ nodes, links });
}

/**
 * A navigation graph turned into an adjacency structure. Built once per map
 * load and then read-only, so several bots and every monster share one
 * instance. See `NavGraphSourceT` above for what it is built from and
 * `navGraphFromNav2` for the Quake 1 file that used to be its only input.
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

  constructor(source: NavGraphSourceT) {
    for (let i = 0; i < source.nodes.length; i++) {
      const src = source.nodes[i]!;
      this.nodes.push({
        index: i,
        origin: { x: src.origin.x, y: src.origin.y, z: src.origin.z },
        radius: src.radius,
        flags: src.flags,
        links: [],
      });
    }

    for (const raw of source.links) {
      if (raw.from < 0 || raw.from >= this.nodes.length) continue;
      if (raw.to < 0 || raw.to >= this.nodes.length) continue;

      const link: NavGraphLinkT = {
        from: raw.from,
        to: raw.to,
        type: raw.type,
        traversal:
          raw.traversal === null
            ? null
            : {
                funnel: { x: raw.traversal.funnel.x, y: raw.traversal.funnel.y, z: raw.traversal.funnel.z },
                start: { x: raw.traversal.start.x, y: raw.traversal.start.y, z: raw.traversal.start.z },
                end: { x: raw.traversal.end.x, y: raw.traversal.end.y, z: raw.traversal.end.z },
              },
        entityBounds:
          raw.entityBounds === null
            ? null
            : {
                mins: { x: raw.entityBounds.mins.x, y: raw.entityBounds.mins.y, z: raw.entityBounds.mins.z },
                maxs: { x: raw.entityBounds.maxs.x, y: raw.entityBounds.maxs.y, z: raw.entityBounds.maxs.z },
              },
      };
      this.nodes[raw.from]!.links.push(link);
      this.links.push(link);
      if (link.entityBounds !== null) this.entityLinks.push(link);
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

    if (!caps.swim && (to.flags & NavNodeFlags.UnderWater) !== 0) return false;
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
        if (caps !== undefined && !caps.swim && (node.flags & NavNodeFlags.UnderWater) !== 0) continue;
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
