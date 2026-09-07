/*
Harness for family U -- bots and monster navigation. Not a bun:test suite:
every u_*.ts driver is a standalone script run as `bun test/e2e/u_<name>.ts`.

Everything here runs one in-process engine (`Sys_Main_Init` + `runFrames`, the
same boot a_lib.ts and b_lib.ts use) with `-listen 12`, which is what makes
`svs.maxclients` big enough for a full bot roster plus the local player:
Host_FindMaxClients reads `-listen`'s argument straight into `svs.maxclients`,
the cap this file's callers actually rely on. `svs.maxclientslimit` (the
`svs.clients` array's own size) is a different, wider number since G6
(2026-09-07): it is always MAX_SCOREBOARD regardless of `-listen`, because the
re-release's Multiplayer menu and Bots page host up to a full scoreboard from
a plain boot with no `-listen` at all. A `maxplayers` typed after this file's
boot() can therefore raise `svs.maxclients` as high as MAX_SCOREBOARD, not
capped at whatever `-listen` asked for -- no driver in this family does that,
but a future one reading this comment should not assume the old ceiling.

The nav map list is read out of the mounted pak directories rather than
written down here. "Every map that has a .nav in this tree" has to keep
meaning that when the data changes, and the engine has no directory listing
over a pak to ask.
*/

import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { Q_SeedRandom } from "../../src/common/mathlib";
import * as consoleMod from "../../src/client/console";
import { conState } from "../../src/client/console";
import { FL_ONGROUND, svs } from "../../src/server/server";
import { Bot_Add, Bot_RemoveAll, Bot_Slots, bot_count } from "../../src/bots";
import { Q1TS_DATA, homedirArgs } from "./q1data";

//============================================================================
// driver contract: [PASS]/[FAIL] lines, a RESULT line, a non-zero exit

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/** Prints the RESULT line and leaves the process with the contract's exit code. */
export function finish(): never {
  const failed = results.filter((r) => !r.pass);
  for (const r of failed) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${results.length - failed.length} ${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

//============================================================================
// boot and frames

export const TREES = ["id1", "hipnotic", "rogue", "mg1", "mg3", "dopa", "ctf"] as const;
export type TreeName = (typeof TREES)[number];

export function isTree(name: string): name is TreeName {
  for (const t of TREES) if (t === name) return true;
  return false;
}

export function requireTree(name: string | undefined): TreeName {
  if (name !== undefined && isTree(name)) return name;
  console.log(`[FAIL] tree :: unknown tree "${name ?? ""}", expected one of ${TREES.join("|")}`);
  process.exit(2);
}

/**
 * Family U's UDP band (E2E-COMMON): a listen server binds its accept socket at
 * boot even when every client is in-process, so two U drivers running at once
 * -- or a U driver next to another family's -- need different ports or
 * NET_Init dies with "UDP_Listen: Unable to open accept socket".
 */
export const PORT_BASE = 26400;

/**
 * F13 registered `sv_randomseed` (SV_SpawnServer reseeds the QuakeC
 * random(), SV_MoveToGoal's chase-direction roll and, per bot_client.ts's
 * Bot_SpawnServer, addbot's own character/brain picks) but left every
 * family-u driver unseeded, so two runs of the same scenario are two
 * different matches. G5: `--seed <n>` on the command line, else Q1TS_SEED,
 * else 7 -- a default that is itself a seed, not 0, so a plain `bun
 * test/e2e/u_commands.ts` with no flags is replayable too. Passing 0 either
 * way asks for sv_randomseed's own default: WinQuake's unseeded engine.
 */
function seedArg(): string | undefined {
  const i = process.argv.indexOf("--seed");
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

export const DEFAULT_SEED = 7;

export function resolveSeed(): number {
  const arg = seedArg();
  if (arg !== undefined) {
    const n = Math.trunc(Number(arg));
    if (!Number.isNaN(n)) return n;
  }
  const env = process.env.Q1TS_SEED;
  if (env !== undefined && env !== "") {
    const n = Math.trunc(Number(env));
    if (!Number.isNaN(n)) return n;
  }
  return DEFAULT_SEED;
}

/** Resolved once per process, so every boot() in a driver pins the same run. */
export const SEED = resolveSeed();

/**
 * One listen server with room for `maxclients` slots. `-basedir Q1TS_DATA`
 * auto-detects the nested rerelease/ root; the episode trees come in on their
 * own flag, exactly as the re-release's own launcher passes them.
 */
export function boot(tree: TreeName, maxclients: number, port: number, extra: string[] = []): void {
  // F18: writes go to the per-family home directory like every other family;
  // without it the engine's default per-user directory (or the retail tree)
  // would receive this family's config and autosaves.
  const argv = [
    "quake",
    "-basedir",
    Q1TS_DATA,
    "-game",
    "e2e_u",
    ...homedirArgs("e2e_u"),
    "-nosound",
    "-port",
    String(port),
    "-listen",
    String(maxclients),
    "+sv_randomseed",
    String(SEED),
  ];
  if (tree !== "id1") argv.push(`-${tree}`);
  Sys_Main_Init([...argv, ...extra]);

  // G7 (family review, 2026-09-07): `+sv_randomseed` on the command line only
  // sets the CVAR early -- src/server/sv_main.ts's SV_SpawnServer is what
  // actually calls Q_SeedRandom, and it does that at the first `map`, not at
  // boot. Anything that draws from Q_rand() (mathlib.ts) before this driver's
  // first `map` command would still fall back to Math.random(), unseeded, no
  // matter what the cvar already reads. No driver in this family draws from
  // it that early today (nothing runs before the first `map` with a server
  // active), but that is a property of what each driver happens to do before
  // its first `map`, not something this shared boot() can guarantee on their
  // behalf -- so it seeds the generator itself, directly, right here, closing
  // the window instead of relying on it staying empty. SV_SpawnServer's own
  // call still re-applies the seed at every subsequent `map`, unchanged.
  Q_SeedRandom(SEED);

  // Host_Init leaves `exec quake.rc` sitting in the command buffer. Two echoes
  // queued behind it measure whether that buffer survives the exec chain; the
  // buffer is then drained here so no driver's real first command is the one
  // that gets lost. u_commands.ts asserts on bootProbe.
  Cbuf_AddText(`echo ${BOOT_PROBE_FIRST}\necho ${BOOT_PROBE_SECOND}\n`);
  frames(BOOT_DRAIN_FRAMES);
  const printed = conLines();
  bootProbe.first = printed.some((l) => l.includes(BOOT_PROBE_FIRST));
  bootProbe.second = printed.some((l) => l.includes(BOOT_PROBE_SECOND));
  bootProbe.ran = true;
}

/** Frames it takes for Host_Init's queued `exec quake.rc` chain to finish. */
export const BOOT_DRAIN_FRAMES = 8;
const BOOT_PROBE_FIRST = "U_BOOTPROBE_FIRST";
const BOOT_PROBE_SECOND = "U_BOOTPROBE_SECOND";

/** Whether each of the two echoes queued before the boot exec chain survived it. */
export const bootProbe: { ran: boolean; first: boolean; second: boolean } = { ran: false, first: false, second: false };

export function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

export function exec(text: string, n = 2, dt = 0.05): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n, dt);
}

/** `exec`, with the Host_Error a bad command raises returned instead of thrown. */
export function execGuarded(text: string, n = 2, dt = 0.05): string | null {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  return pumpGuarded(n, dt);
}

/**
 * `runFrames`, with Host_Error / PR_RunError / Sys_Error turned into a
 * returned message instead of an escaping throw. Returns null when the whole
 * run was clean.
 */
export function pumpGuarded(n: number, dt = 0.05, onFrame?: () => void): string | null {
  for (let i = 0; i < n; i++) {
    try {
      runFrames(1, dt);
    } catch (e) {
      return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    if (onFrame !== undefined) onFrame();
  }
  return null;
}

//============================================================================
// console scrollback

/** Whole console scrollback, oldest first, one string per row. */
export function conLines(): string[] {
  const text = consoleMod.con_text;
  if (text === null || text === undefined) return [];
  const width = conState.con_linewidth;
  const total = conState.con_totallines;
  const out: string[] = [];
  for (let i = conState.con_current - total + 1; i <= conState.con_current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < width; x++) s += String.fromCharCode(text[row * width + x]! & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}

/** A marker for conSince(): the scrollback row the console is writing now. */
export function conMark(): number {
  return conState.con_current;
}

/** Every non-blank line the console has printed since `mark`. */
export function conSince(mark: number): string[] {
  const text = consoleMod.con_text;
  if (text === null || text === undefined) return [];
  const width = conState.con_linewidth;
  const total = conState.con_totallines;
  const first = Math.max(mark, conState.con_current - total + 1);
  const out: string[] = [];
  for (let i = first; i <= conState.con_current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < width; x++) s += String.fromCharCode(text[row * width + x]! & 0x7f);
    const trimmed = s.replace(/\s+$/, "");
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

export function linesHave(lines: readonly string[], needle: string): boolean {
  const lower = needle.toLowerCase();
  return lines.some((l) => l.toLowerCase().includes(lower));
}

/** The engine's own fatal-error text, wherever it reached the console. */
export function consoleErrors(lines: readonly string[]): string[] {
  return lines.filter((l) => l.includes("Host_Error:") || l.includes("PR_RunError") || l.includes("program error") || l.includes("Sys_Error"));
}

//============================================================================
// which maps in a tree have a .nav

interface PakEntryT {
  name: string;
  size: number;
}

/** The directory of one .pak, or an empty list when the file is not a PACK. */
function pakDirectory(path: string): PakEntryT[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, 12, 0) !== 12) return [];
    if (header.toString("latin1", 0, 4) !== "PACK") return [];
    const dirofs = header.readInt32LE(4);
    const dirlen = header.readInt32LE(8);
    if (dirlen <= 0 || dirlen % 64 !== 0) return [];
    const dir = Buffer.alloc(dirlen);
    if (readSync(fd, dir, 0, dirlen, dirofs) !== dirlen) return [];
    const out: PakEntryT[] = [];
    for (let i = 0; i < dirlen / 64; i++) {
      const rec = dir.subarray(i * 64, (i + 1) * 64);
      let end = 0;
      while (end < 56 && rec[end] !== 0) end++;
      out.push({ name: rec.toString("latin1", 0, end).replace(/\\/g, "/").toLowerCase(), size: rec.readInt32LE(60) });
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

function treeEntries(root: string, tree: string): PakEntryT[] {
  const out: PakEntryT[] = [];
  for (let i = 0; i < 10; i++) out.push(...pakDirectory(`${root}/${tree}/pak${i}.pak`));
  return out;
}

/** Where -basedir Q1TS_DATA ends up mounting the re-release trees from. */
export function rereleaseRoot(): string {
  return existsSync(`${Q1TS_DATA}/rerelease/id1/pak0.pak`) ? `${Q1TS_DATA}/rerelease` : Q1TS_DATA;
}

export interface NavMapT {
  map: string;
  /** bytes of the .nav in the pak, for the results table. */
  navBytes: number;
  /** which tree the .bsp came from -- the episode dir, or id1 underneath it. */
  bspFrom: string;
}

/**
 * Every map in `tree` that ships a bots/navigation/<map>.nav AND a .bsp the
 * engine can actually load (the episode dir's own maps/, or id1's underneath
 * it). bots/navigation/test/ is skipped: those nine are QA assets in an older
 * NAV2 layout with no map behind them (src/lib/nav.ts's VERSIONS note).
 */
export function navMaps(tree: TreeName): NavMapT[] {
  const root = rereleaseRoot();
  const own = treeEntries(root, tree);
  const id1 = tree === "id1" ? own : treeEntries(root, "id1");

  const bspIn = (entries: readonly PakEntryT[]): Set<string> => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.name.startsWith("maps/") && e.name.endsWith(".bsp")) set.add(e.name.slice(5, -4));
    }
    return set;
  };
  const ownBsp = bspIn(own);
  const id1Bsp = bspIn(id1);

  const out: NavMapT[] = [];
  const seen = new Set<string>();
  for (const e of own) {
    if (!e.name.startsWith("bots/navigation/") || !e.name.endsWith(".nav")) continue;
    const rest = e.name.slice("bots/navigation/".length, -4);
    if (rest.includes("/")) continue; // bots/navigation/test/*
    if (seen.has(rest)) continue;
    const from = ownBsp.has(rest) ? tree : id1Bsp.has(rest) ? "id1" : "";
    if (from === "") continue;
    seen.add(rest);
    out.push({ map: rest, navBytes: e.size, bspFrom: from });
  }
  out.sort((a, b) => a.map.localeCompare(b.map));
  return out;
}

//============================================================================
// the bot roster

/**
 * The bots that are really in the game: a slot whose client_t is active and
 * spawned and still owns an edict. `Bot_Count()` counts the slot map instead,
 * which is not the same thing after Host_ShutdownServer has been through
 * svs.clients (see u_commands.ts's map-change scenario).
 */
export function liveBots(): number[] {
  const out: number[] = [];
  for (const [clientnum] of Bot_Slots()) {
    const client = svs.clients[clientnum];
    if (client === undefined || !client.active || !client.spawned || client.edict === null) continue;
    out.push(clientnum);
  }
  return out;
}

/**
 * Makes `want` bots really be in the game, rebuilding the roster from scratch
 * if the slot map and the client array have gone out of step. `recovered`
 * says the roster had to be rebuilt, which is the observable a caller asserts
 * on.
 *
 * G6 (2026-09-07, src/bots/bot_client.ts): `bot_count` now reconciles only
 * the auto-filled part of the roster; a hand-added bot is permanently
 * "extra" and neither counted nor removed by it. When `want` is what
 * `bot_count` is already asking for -- every per-map fallback in this family
 * (`bot_count N` set once, then `ensureBots(N)` after a map whose own
 * auto-fill came up short) -- the top-up is standing in for that quota, and
 * has to be added the same way the quota's own bots would be (`auto: true`),
 * or it becomes a bot the roster carries forever, uncounted, that the very
 * next bot-flagged map's real auto-fill then tops up *again* on top of --
 * doubling the roster and never coming back down (u_navmaps.ts's id1 sweep:
 * every real deathmatch map after the first vault/utility one measured 8
 * live bots against a `bot_count 4`). Only a caller asking for more than
 * `bot_count` currently wants (u_commands.ts's no-nav scenario, `bot_count
 * 0`) gets real hand-added extras, matching what the `addbot` command does.
 */
export function ensureBots(want: number): { live: number; recovered: boolean } {
  const before = liveBots().length;
  if (before >= want) return { live: before, recovered: false };
  if (Bot_Slots().size > before) Bot_RemoveAll();
  const auto = Math.trunc(bot_count.value) === want;
  while (liveBots().length < want && Bot_Add("random", "", auto) >= 0);
  return { live: liveBots().length, recovered: true };
}

//============================================================================
// watching bots play

export interface StillSnapshotT {
  origin: [number, number, number];
  health: number;
  waterlevel: number;
  movetype: number;
  onground: boolean;
  hasPath: boolean;
  target: number;
  attacking: boolean;
  forwardmove: number;
}

export interface BotObservationT {
  clientnum: number;
  name: string;
  /** Sum of per-frame origin deltas, ignoring respawn teleports. */
  distance: number;
  /** Longest run of frames the bot stood still while alive, in seconds. */
  longestStillSeconds: number;
  /** What the bot was doing at the end of that window, when it was long. */
  stillSnapshot: StillSnapshotT | null;
  /** Frames the brain held another entity as its combat target. */
  targetFrames: number;
  /** Frames where the bot gained an item bit, ammo, armour or health. */
  pickups: number;
  /** Frames where this bot's frag count went up. */
  frags: number;
  deaths: number;
  attackFrames: number;
  aliveFrames: number;
  team: number;
}

interface WatchStateT {
  clientnum: number;
  name: string;
  prev: [number, number, number];
  prevItems: number;
  prevHealth: number;
  prevArmor: number;
  prevAmmo: [number, number, number, number];
  prevFrags: number;
  distance: number;
  still: number;
  longestStill: number;
  stillSnapshot: StillSnapshotT | null;
  targetFrames: number;
  pickups: number;
  frags: number;
  deaths: number;
  attackFrames: number;
  aliveFrames: number;
  wasDead: boolean;
  skipNext: boolean;
}

/** A respawn moves the body across the level; that jump is not walking. */
const TELEPORT_STEP = 200;
/** Under this much movement in a frame the bot counts as standing still. */
const STILL_STEP = 1;

/**
 * Samples every live bot once per server frame. Construct it after the bots
 * are in the game, call sample() from the frame pump, read report() after.
 */
export class BotWatch {
  private readonly dt: number;
  private readonly state = new Map<number, WatchStateT>();

  constructor(dt = 0.05) {
    this.dt = dt;
    this.rescan();
  }

  /** Picks up bots that joined after construction (a `map` change re-seats them). */
  rescan(): void {
    for (const [clientnum, slot] of Bot_Slots()) {
      if (this.state.has(clientnum)) continue;
      const client = svs.clients[clientnum];
      const ent = client?.edict;
      if (client === undefined || ent === null || ent === undefined) continue;
      this.state.set(clientnum, {
        clientnum,
        name: slot.name,
        prev: [ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!],
        prevItems: ent.v.items | 0,
        prevHealth: ent.v.health,
        prevArmor: ent.v.armorvalue,
        prevAmmo: [ent.v.ammo_shells, ent.v.ammo_nails, ent.v.ammo_rockets, ent.v.ammo_cells],
        prevFrags: ent.v.frags,
        distance: 0,
        still: 0,
        longestStill: 0,
        stillSnapshot: null,
        targetFrames: 0,
        pickups: 0,
        frags: 0,
        deaths: 0,
        attackFrames: 0,
        aliveFrames: 0,
        wasDead: false,
        skipNext: false,
      });
    }
  }

  sample(): void {
    for (const s of this.state.values()) {
      const client = svs.clients[s.clientnum];
      const ent = client?.edict;
      if (client === undefined || !client.active || ent === null || ent === undefined) continue;

      const origin: [number, number, number] = [ent.v.origin[0]!, ent.v.origin[1]!, ent.v.origin[2]!];
      const health = ent.v.health;
      const dead = health <= 0 || ent.v.deadflag !== 0;
      const step = Math.hypot(origin[0] - s.prev[0], origin[1] - s.prev[1], origin[2] - s.prev[2]);

      if (!dead && !s.wasDead && !s.skipNext) {
        if (step < TELEPORT_STEP) s.distance += step;
        s.aliveFrames += 1;
        // A player the progs hold with MOVETYPE_NONE (hip1m1's spawn freeze
        // holds every client for ~5 s) is not a stuck bot: that time does
        // not count toward the standstill.
        const frozenByProgs = (ent.v.movetype | 0) === 0;
        // G5: a bot the brain isn't asking to go anywhere -- no forward or
        // side command, and no live combat target -- is holding position on
        // purpose (brain.ts's own defend/camp behavior for CTF: "the base a
        // carrier runs to, a defender guards, and an attacker camps"), not
        // stuck. brain.ts's own wedge timer draws the identical line: it is
        // gated on "pressing a move", because a standstill with nothing
        // commanded says nothing about whether the bot CAN move.
        const brain = Bot_Slots().get(s.clientnum)?.brain;
        const holdingOnPurpose = client.cmd.forwardmove === 0 && client.cmd.sidemove === 0 && (brain?.currentTarget() ?? -1) < 0;
        if (frozenByProgs || holdingOnPurpose) {
          s.still = 0;
        } else if (step < STILL_STEP) {
          s.still += 1;
          if (s.still > s.longestStill) {
            s.longestStill = s.still;
            s.stillSnapshot = {
              origin,
              health,
              waterlevel: ent.v.waterlevel | 0,
              movetype: ent.v.movetype,
              onground: ((ent.v.flags | 0) & FL_ONGROUND) !== 0,
              hasPath: brain !== undefined && brain.currentPath() !== null,
              target: brain?.currentTarget() ?? -1,
              attacking: ent.v.button0 !== 0,
              forwardmove: client.cmd.forwardmove,
            };
          }
        } else {
          s.still = 0;
        }
        if ((brain?.currentTarget() ?? -1) >= 0) s.targetFrames += 1;
        // A respawn refills items, health, armour and ammo in one frame; the
        // frame after a death is not a pickup.
        const items = ent.v.items | 0;
        const ammo: [number, number, number, number] = [ent.v.ammo_shells, ent.v.ammo_nails, ent.v.ammo_rockets, ent.v.ammo_cells];
        const gainedBit = (items & ~s.prevItems) !== 0;
        const gainedAmmo = ammo.some((v, i) => v > s.prevAmmo[i]!);
        const gainedArmor = ent.v.armorvalue > s.prevArmor;
        const gainedHealth = health > s.prevHealth;
        if (gainedBit || gainedAmmo || gainedArmor || gainedHealth) s.pickups += 1;
        if (ent.v.button0 !== 0) s.attackFrames += 1;
      } else {
        s.still = 0;
      }

      if (ent.v.frags > s.prevFrags) s.frags += ent.v.frags - s.prevFrags;
      if (dead && !s.wasDead) s.deaths += 1;

      s.skipNext = s.wasDead && !dead; // the respawn frame itself
      s.wasDead = dead;
      s.prev = origin;
      s.prevItems = ent.v.items | 0;
      s.prevHealth = health;
      s.prevArmor = ent.v.armorvalue;
      s.prevAmmo = [ent.v.ammo_shells, ent.v.ammo_nails, ent.v.ammo_rockets, ent.v.ammo_cells];
      s.prevFrags = ent.v.frags;
    }
  }

  report(): BotObservationT[] {
    const out: BotObservationT[] = [];
    for (const s of this.state.values()) {
      const ent = svs.clients[s.clientnum]?.edict ?? null;
      out.push({
        clientnum: s.clientnum,
        name: s.name,
        distance: s.distance,
        longestStillSeconds: s.longestStill * this.dt,
        stillSnapshot: s.stillSnapshot,
        targetFrames: s.targetFrames,
        pickups: s.pickups,
        frags: s.frags,
        deaths: s.deaths,
        attackFrames: s.attackFrames,
        aliveFrames: s.aliveFrames,
        team: ent === null ? 0 : ent.v.team | 0,
      });
    }
    out.sort((a, b) => a.clientnum - b.clientnum);
    return out;
  }
}

//============================================================================

/** A fixed-width results-table row, so a long run reads as a table in the log. */
export function row(cells: ReadonlyArray<string | number>, widths: readonly number[]): string {
  return cells
    .map((c, i) => {
      const s = typeof c === "number" ? String(c) : c;
      const w = widths[i] ?? 8;
      return i === 0 ? s.padEnd(w) : s.padStart(w);
    })
    .join(" ");
}
