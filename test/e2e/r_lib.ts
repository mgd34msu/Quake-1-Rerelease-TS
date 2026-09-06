/*
Harness helpers for the R end-to-end family (2021 re-release content in both
renderers). Not a bun:test suite -- each r_*.ts driver is a standalone script
run as `bun test/e2e/r_<name>.ts` (test/e2e/README.md "Headless recipe"), and
prints the `[PASS]/[FAIL] name :: note` + `RESULT <pass> <fail>` contract from
.orch/briefs/E2E-COMMON.md.

Shape follows test/e2e/b_lib.ts and test/e2e/j_lib.ts (boot / frames / exec /
console-scrollback reader / screenshot). Two things are taken from elsewhere
rather than re-derived here:

- test/support/sweep_lib.ts owns the retail-tree table (`rereleaseConfigs`),
  the pak enumerator that reports each map's on-disk BSP version
  (`enumerateGamedirMaps`), and the console-line classifier the map sweep and
  test/support/sweep_baseline.json already agree on. Reusing it means "beyond
  the known baseline" means exactly the same thing here as it does in
  test/sweep_maps.test.ts, and a residue accepted there is accepted here
  under the same `<gamedir>/<map>` key. Those files belong to another unit
  and are imported, never edited.
- src/client/menu_content.ts owns the mapdb.json read (LoadMapdb), so the
  episode/map selection below sees exactly the catalog the New Game menu
  sees, through the engine's own mounted filesystem.

Framebuffer evidence is read live out of the renderer (the software
renderer's `vid.buffer`/`vid.buffer32`, the GL renderer's `qglReadPixels`)
the way test/e2e/m_gl_world_light.ts does, rather than by decoding a written
screenshot file: the pixels are the same ones the screenshot would hold, and
a live read costs no PCX/TGA decoder. `shot()` still writes a real screenshot
through the `screenshot` command, so the file path is exercised too.
*/

import { existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute, Cmd_Exists } from "../../src/common/cmd";
import { Cvar_Set, Cvar_VariableString, Cvar_VariableValue } from "../../src/common/cvar";
import { Key_Event, keyState, KeydestT } from "../../src/client/keys";
import { conState } from "../../src/client/console";
import * as consoleMod from "../../src/client/console";
import * as common from "../../src/common/common";
import { COM_FClose, COM_FRead, COM_FindFile } from "../../src/common/common";
import { cl, cls, CactiveT, SIGNONS } from "../../src/client/client";
import { sv } from "../../src/server/server";
import { EDICT_NUM, PR_GetString } from "../../src/progs/progs";
import { vid, d_8to24table } from "../../src/client/vid";
import { rState } from "../../src/ref_soft/r_shared";
import { glState } from "../../src/ref_gl/glquake";
import { qglHolder, GL_RGB, GL_UNSIGNED_BYTE } from "../../src/ref_gl/qgl";
import { r_refdef, re, type GlyphAtlasSourceT } from "../../src/client/render";
import { SCR_DrawCenterString, SCR_UpdateScreen } from "../../src/client/screen";
import { test_ResetGlyphCache } from "../../src/client/kfont_text";
import { LoadMapdb, realContentFsSeam } from "../../src/client/menu_content";
import type { Mapdb, MapdbMap } from "../../src/lib/mapdb";
import {
  CONSOLE_CLASS_KEYS,
  classifyConsoleLines,
  enumerateGamedirMaps,
  isRecordObject,
  isStringArray,
  rereleaseConfigs,
  type ConsoleClassKeyT,
  type GamedirConfigT,
} from "../support/sweep_lib";
import { Q1TS_DATA } from "./q1data";

// ===========================================================================
// results contract
// ===========================================================================

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

/** Prints the family's summary + `RESULT <pass> <fail>` line and exits non-zero on any failure. */
export function finish(label: string): never {
  const bad = results.filter((r) => !r.pass);
  const passed = results.length - bad.length;
  console.log(`\n===SUMMARY ${label}=== ${passed}/${results.length} passed`);
  for (const r of bad) console.log(`  FAIL: ${r.name} :: ${r.note}`);
  console.log(`RESULT ${passed} ${bad.length}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

// ===========================================================================
// command line + scratch
// ===========================================================================

export function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

export function flag(name: string): boolean {
  return process.argv.indexOf(`--${name}`) >= 0;
}

export const SCRATCH = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";

/** Per-run writable root. Everything the engine writes (config.cfg, screenshots,
 * savegames) lands under here via `-homedir`, never in the retail tree. */
export function homedirFor(tag: string): string {
  const dir = `${SCRATCH}/r/${tag}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const SHOTDIR = `${SCRATCH}/r/shots`;

// ===========================================================================
// retail trees
// ===========================================================================

export const TREES = ["id1", "hipnotic", "rogue", "mg1", "mg3", "dopa", "ctf"] as const;
export type TreeT = (typeof TREES)[number];

export function isTree(s: string): s is TreeT {
  for (const t of TREES) if (t === s) return true;
  return false;
}

/** The re-release config for one tree, straight out of sweep_lib's own table
 * (same basedir, same episode flags, same `<gamedir>/<map>` label the sweep
 * baseline is keyed by). */
export function treeConfig(tree: TreeT): GamedirConfigT {
  const want = `rerelease/${tree}`;
  for (const cfg of rereleaseConfigs(Q1TS_DATA)) {
    if (cfg.label === want) return cfg;
  }
  throw new Error(`no rerelease config for tree "${tree}"`);
}

/** The classic (1999 data, `-norerelease`) config for id1/hipnotic/rogue. */
export function classicConfig(tree: "id1" | "hipnotic" | "rogue"): GamedirConfigT {
  const extra: Record<string, readonly string[]> = {
    id1: ["-norerelease"],
    hipnotic: ["-hipnotic", "-norerelease"],
    rogue: ["-rogue", "-norerelease"],
  };
  return { label: tree, basedir: Q1TS_DATA, pakSubdir: tree, extraArgs: extra[tree] ?? ["-norerelease"] };
}

/** `<map> -> on-disk BSP version fact ("BSP2", "2PSB", "29", ...)` for one tree's own paks. */
export function bspVersionsOf(cfg: GamedirConfigT): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of enumerateGamedirMaps(cfg)) out.set(m.map, m.bspVersion);
  return out;
}

// ===========================================================================
// boot / frame pump / console
// ===========================================================================

export interface BootOptions {
  readonly cfg: GamedirConfigT;
  /** "soft" or "gl"; picks -vid_ref and the screenshot extension. */
  readonly vid: string;
  /** Writable root for this run; `-homedir`. */
  readonly homedir: string;
  readonly extra?: readonly string[];
}

let bootedVid = "soft";

export function bootTree(opts: BootOptions): string[] {
  const argv = [
    "quake",
    "-basedir",
    opts.cfg.basedir,
    ...opts.cfg.extraArgs,
    "-homedir",
    opts.homedir,
    "-nosound",
    "-vid_ref",
    opts.vid,
    ...(opts.extra ?? []),
  ];
  bootedVid = opts.vid;
  console.log(`[R] boot: ${argv.slice(1).join(" ")}`);
  Sys_Main_Init(argv);
  return argv;
}

export function isGL(): boolean {
  return qglHolder.current !== null;
}

export function shotExt(): string {
  return bootedVid === "gl" ? ".tga" : ".pcx";
}

export function frames(n = 1, dt = 0.05): void {
  runFrames(n, dt);
}

export function cmd(text: string, n = 2): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  frames(n);
}

export function cmdNow(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
  Cbuf_Execute();
}

export function tap(k: number): void {
  Key_Event(k, true);
  Key_Event(k, false);
}

export function inGame(): boolean {
  return cls.state === CactiveT.ca_connected && cls.signon === SIGNONS;
}

/** Pumps frames until the client is fully in game. Returns the frames used, or -1 on timeout. */
export function waitInGame(maxFrames = 600): number {
  for (let i = 0; i < maxFrames; i++) {
    frames(1);
    if (inGame()) return i;
  }
  return -1;
}

export interface MapLoadResultT {
  readonly ok: boolean;
  /** Frames spent reaching the in-game state, or -1 on timeout. */
  readonly frames: number;
  /** The Sys_Error / exception text, when the load threw instead of finishing. */
  readonly error: string | null;
}

/**
 * `map <name>`, wait for the player to enter, settle for `settle` frames.
 *
 * The throw is caught rather than allowed to kill the process: a Sys_Error
 * partway through a sweep (a model the renderer refuses, a lump it cannot
 * read) is a result about that map, and the driver still owes its remaining
 * maps a run and the runner a RESULT line.
 */
export function loadMapCatching(name: string, settle = 30, maxFrames = 700): MapLoadResultT {
  try {
    cmd(`map ${name}`, 2);
    const used = waitInGame(maxFrames);
    if (used < 0) return { ok: false, frames: -1, error: null };
    keyState.key_dest = KeydestT.key_game;
    frames(settle);
    return { ok: true, frames: used, error: null };
  } catch (e) {
    return { ok: false, frames: -1, error: e instanceof Error ? e.message : String(e) };
  }
}

/** `disconnect`, tolerating a server left in a broken state by a failed load. */
export function disconnectCatching(): void {
  try {
    cmd("disconnect", 6);
  } catch {
    /* a failed map load can leave the server mid-spawn; the next `map` resets it */
  }
}

/** Whole console scrollback as trimmed lines, oldest first (b_lib.ts's reader). */
export function conLines(): string[] {
  const t = consoleMod.con_text;
  if (!t) return [];
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  const out: string[] = [];
  for (let i = conState.con_current - total + 1; i <= conState.con_current; i++) {
    if (i < 0) continue;
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(t[row * w + x] & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}

/** A cursor into the console ring, for conSince(). */
export function conMark(): number {
  return conState.con_current;
}

/** The console lines written since `mark`, oldest first. */
export function conSince(mark: number): string[] {
  const t = consoleMod.con_text;
  if (!t) return [];
  const w = conState.con_linewidth;
  const total = conState.con_totallines;
  const from = Math.max(mark + 1, conState.con_current - total + 1, 0);
  const out: string[] = [];
  for (let i = from; i <= conState.con_current; i++) {
    const row = i % total;
    let s = "";
    for (let x = 0; x < w; x++) s += String.fromCharCode(t[row * w + x] & 0x7f);
    out.push(s.replace(/\s+$/, ""));
  }
  return out;
}

export function conHas(needle: string): boolean {
  return conLines().some((l) => l.includes(needle));
}

export function conTail(n = 12): string {
  return conLines()
    .filter((l) => l.length > 0)
    .slice(-n)
    .join("\n");
}

// ===========================================================================
// console-error gate (shared with test/sweep_maps.test.ts's baseline)
// ===========================================================================

const BASELINE_PATH = `${import.meta.dir}/../support/sweep_baseline.json`;

/** `<gamedir>/<map>` -> console classes accepted as known, non-fatal noise. */
export function loadSweepBaseline(): Readonly<Record<string, readonly string[]>> {
  if (!existsSync(BASELINE_PATH)) return {};
  const raw: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (!isRecordObject(raw)) throw new Error("sweep_baseline.json: root is not an object");
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isStringArray(value)) throw new Error(`sweep_baseline.json: "${key}" is not a string array`);
    out[key] = value;
  }
  return out;
}

/**
 * Every console class in `lines` that the baseline does not already list for
 * `<gamedir>/<map>`. An empty result is the brief's "no Host_Error /
 * PR_RunError / 'is not a field' console lines beyond the known baseline".
 */
export function unexplainedConsoleClasses(
  lines: readonly string[],
  baseline: Readonly<Record<string, readonly string[]>>,
  recordKey: string,
): string[] {
  const allowed = new Set(baseline[recordKey] ?? []);
  const classified = classifyConsoleLines(lines);
  const out: string[] = [];
  for (const key of CONSOLE_CLASS_KEYS) {
    const hits: readonly string[] = classified[key];
    if (hits.length > 0 && !allowed.has(key)) out.push(`${key} (${hits.length}x) e.g. "${hits[0]}"`);
  }
  return out;
}

export function consoleClassCounts(lines: readonly string[]): string {
  const classified = classifyConsoleLines(lines);
  const parts: string[] = [];
  for (const key of CONSOLE_CLASS_KEYS) {
    const hits: readonly string[] = classified[key];
    if (hits.length > 0) parts.push(`${key}=${hits.length}`);
  }
  return parts.length === 0 ? "clean" : parts.join(" ");
}

export type { ConsoleClassKeyT };

// ===========================================================================
// mapdb.json (read through the engine's own mounted filesystem, post-boot)
// ===========================================================================

export function loadMapdb(): Mapdb | null {
  return LoadMapdb(realContentFsSeam).mapdb;
}

/**
 * The episode key a map name belongs to: everything before the trailing
 * `m<digits>` (or trailing digits) of its bsp name. "e1m1" -> "e1",
 * "hip2m3" -> "hip2", "r1m4" -> "r1", "mge1m1" -> "mge1", "start" ->
 * "start", "map2b" -> "map". Data-driven so no per-tree table of episode
 * prefixes has to be maintained here.
 */
export function episodeKey(bsp: string): string {
  const m = /^(.*?)(?:m\d+[a-z]?|\d+[a-z]?)$/.exec(bsp);
  if (m !== null && m[1].length > 0) return m[1];
  return bsp;
}

/**
 * The maps one tree's driver loads. The brief's rule: the FIRST map of every
 * episode for the big trees, every map for the short ones (mg1/mg3/dopa/ctf).
 *
 * "Episode" here is the in-game episode, not mapdb.json's `episodes[]` array
 * -- that array has one entry per CONTENT DIRECTORY (id1, hipnotic, rogue,
 * dopa, mg1, mg3), so "the first map of every mapdb episode" would be a
 * single map per tree and would never reach e2m1/e3m1/e4m1 at all. The
 * grouping used instead is episodeKey() over the tree's own maps in
 * mapdb.json's order, which yields start/e1/e2/e3/e4/end for id1,
 * start/hip1/hip2/hip3/hipdm/hipend for hipnotic and start/r1/r2 for rogue.
 */
export function mapsForTree(mapdb: Mapdb, tree: TreeT): MapdbMap[] {
  const mine = mapdb.maps.filter((m) => m.game === tree);
  if (tree === "mg1" || tree === "mg3" || tree === "dopa" || tree === "ctf") return mine;

  const sp = mine.filter((m) => m.sp);
  const seen = new Set<string>();
  const out: MapdbMap[] = [];
  for (const m of sp) {
    const key = episodeKey(m.bsp);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// ===========================================================================
// BSP version of a map, as the engine's own filesystem resolves it
// ===========================================================================

/** The 4-byte version tag of `maps/<name>.bsp` as the mounted search path resolves it. */
export function bspVersionOfLoadedMap(name: string): string {
  const found = COM_FindFile(`maps/${name}.bsp`, "file");
  if (found.file === null) return "not-found";
  const buf = new Uint8Array(4);
  const n = COM_FRead(found.file, buf, 4);
  COM_FClose(found.file);
  if (n < 4) return "short-read";
  const fourcc = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (fourcc === "BSP2" || fourcc === "2PSB") return fourcc;
  return String(new DataView(buf.buffer, 0, 4).getInt32(0, true));
}

// ===========================================================================
// server-side entity facts
// ===========================================================================

export interface EntityCensusT {
  readonly edicts: number;
  readonly monsters: number;
  readonly pickups: number;
  readonly players: number;
  /** trigger_changelevel count: an episode-select / hub screen has these and no monsters. */
  readonly changelevels: number;
}

const PICKUP_PREFIXES = ["item_", "weapon_"] as const;

export function entityCensus(): EntityCensusT {
  let monsters = 0;
  let pickups = 0;
  let players = 0;
  let changelevels = 0;
  for (let i = 0; i < sv.num_edicts; i++) {
    let classname = "";
    try {
      const ed = EDICT_NUM(i);
      if (ed.free) continue;
      classname = PR_GetString(ed.v.classname);
    } catch {
      continue;
    }
    if (classname.startsWith("monster_")) monsters++;
    else if (PICKUP_PREFIXES.some((p) => classname.startsWith(p))) pickups++;
    else if (classname === "player") players++;
    else if (classname === "trigger_changelevel") changelevels++;
  }
  return { edicts: sv.num_edicts, monsters, pickups, players, changelevels };
}

/**
 * The brief's "monsters/items present (edict count above a per-map floor)".
 *
 * The floor is 16 spawned edicts, which every real level clears and the
 * shipped icon-preview BSPs (b_batt0 and friends, two edicts each) do not.
 * Combat content is required on top of that for every map EXCEPT an
 * episode-select / hub screen, which is identified by the evidence -- no
 * monsters at all and at least one trigger_changelevel -- rather than by
 * naming maps, the same way test/sweep_maps.test.ts identifies the
 * spawn-point-free utility BSPs from SelectSpawnPoint's own error.
 */
export function populationVerdict(c: EntityCensusT): { ok: boolean; kind: string } {
  const hub = c.monsters === 0 && c.changelevels > 0;
  const ok = c.edicts >= 16 && c.players >= 1 && (hub || c.monsters + c.pickups >= 1);
  return { ok, kind: hub ? "hub" : "level" };
}

export function classnamesOf(): string[] {
  const out: string[] = [];
  for (let i = 0; i < sv.num_edicts; i++) {
    try {
      const ed = EDICT_NUM(i);
      if (ed.free) continue;
      out.push(PR_GetString(ed.v.classname));
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ===========================================================================
// framebuffer
// ===========================================================================

export interface RegionT {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function fbWidth(): number {
  return isGL() ? glState.glwidth : vid.width;
}

export function fbHeight(): number {
  return isGL() ? glState.glheight : vid.height;
}

/** The 3D view rectangle, which is where world pixels actually live. */
export function viewRegion(): RegionT {
  const r = r_refdef.vrect;
  if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height };
  return { x: 0, y: 0, w: fbWidth(), h: fbHeight() };
}

export function wholeScreen(): RegionT {
  return { x: 0, y: 0, w: fbWidth(), h: fbHeight() };
}

/**
 * An RGB snapshot of `region` (top-left origin, 3 bytes per pixel).
 *
 * Software reads the true-color buffer when the frame is on the colored-light
 * path (src/ref_soft/r_coloredlight.ts's R_ColoredLightAvailable -- the ONLY
 * path a `.lit` file's colours can reach a pixel on) and the 8-bit buffer
 * through `d_8to24table` otherwise. GL reads the real framebuffer back with
 * qglReadPixels, flipping to the same top-left origin.
 */
export function fbSnapshot(region: RegionT): Uint8Array | null {
  const out = new Uint8Array(region.w * region.h * 3);
  const q = qglHolder.current;
  if (q !== null) {
    const w = glState.glwidth;
    const h = glState.glheight;
    const buf = new Uint8Array(w * h * 3);
    q.qglReadPixels(glState.glx, glState.gly, w, h, GL_RGB, GL_UNSIGNED_BYTE, buf);
    for (let y = 0; y < region.h; y++) {
      const sy = h - 1 - (region.y + y);
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < region.w; x++) {
        const sx = region.x + x;
        if (sx < 0 || sx >= w) continue;
        const s = (sy * w + sx) * 3;
        const d = (y * region.w + x) * 3;
        out[d] = buf[s];
        out[d + 1] = buf[s + 1];
        out[d + 2] = buf[s + 2];
      }
    }
    return out;
  }

  const fb32 = vid.buffer32;
  if (rState.r_truecolor && fb32 !== null) {
    for (let y = 0; y < region.h; y++) {
      for (let x = 0; x < region.w; x++) {
        const t = fb32[(region.y + y) * vid.rowbytes + (region.x + x)];
        const d = (y * region.w + x) * 3;
        out[d] = t & 255;
        out[d + 1] = (t >>> 8) & 255;
        out[d + 2] = (t >>> 16) & 255;
      }
    }
    return out;
  }

  const fb = vid.buffer;
  if (fb === null) return null;
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const t = d_8to24table[fb[(region.y + y) * vid.rowbytes + (region.x + x)]];
      const d = (y * region.w + x) * 3;
      out[d] = t & 255;
      out[d + 1] = (t >>> 8) & 255;
      out[d + 2] = (t >>> 16) & 255;
    }
  }
  return out;
}

export interface RegionStatsT {
  readonly pixels: number;
  readonly minLum: number;
  readonly maxLum: number;
  readonly meanLum: number;
  /** How many distinct quantized RGB values the region holds (1 == flat fill). */
  readonly distinct: number;
  /** The largest per-pixel (max channel - min channel): how coloured the region is. */
  readonly maxChroma: number;
  /** Fraction of pixels whose max-min channel spread is at least 24. */
  readonly chromaFraction: number;
  /** Fraction of pixels brighter than 8: how much of the region is not black. */
  readonly litFraction: number;
}

export function regionStats(rgb: Uint8Array | null): RegionStatsT {
  if (rgb === null || rgb.length === 0) {
    return { pixels: 0, minLum: 0, maxLum: 0, meanLum: 0, distinct: 0, maxChroma: 0, chromaFraction: 0, litFraction: 0 };
  }
  const n = rgb.length / 3;
  let minLum = 255;
  let maxLum = 0;
  let sum = 0;
  let maxChroma = 0;
  let chroma = 0;
  let lit = 0;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (hi < minLum) minLum = hi;
    if (hi > maxLum) maxLum = hi;
    sum += hi;
    const c = hi - lo;
    if (c > maxChroma) maxChroma = c;
    if (c >= 24) chroma++;
    if (hi > 8) lit++;
    if (seen.size < 4096) seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }
  return {
    pixels: n,
    minLum,
    maxLum,
    meanLum: sum / n,
    distinct: seen.size,
    maxChroma,
    chromaFraction: chroma / n,
    litFraction: lit / n,
  };
}

export function statsNote(s: RegionStatsT): string {
  return (
    `px=${s.pixels} lum=${s.minLum}..${s.maxLum} mean=${s.meanLum.toFixed(1)} distinct=${s.distinct}` +
    ` chroma=${s.maxChroma}/${(s.chromaFraction * 100).toFixed(1)}% lit=${(s.litFraction * 100).toFixed(1)}%`
  );
}

/** Fraction of pixels that differ by more than `threshold` on any channel. */
export function diffFraction(a: Uint8Array | null, b: Uint8Array | null, threshold = 8): number {
  if (a === null || b === null || a.length !== b.length || a.length === 0) return -1;
  const n = a.length / 3;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    if (
      Math.abs(a[o] - b[o]) > threshold ||
      Math.abs(a[o + 1] - b[o + 1]) > threshold ||
      Math.abs(a[o + 2] - b[o + 2]) > threshold
    ) {
      diff++;
    }
  }
  return diff / n;
}

/** Mean absolute per-channel difference between two snapshots of the same region. */
export function meanAbsDiff(a: Uint8Array | null, b: Uint8Array | null): number {
  if (a === null || b === null || a.length !== b.length || a.length === 0) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * The brief's "a screenshot that is not blank and whose top rows differ from
 * the bottom rows": true when the region carries more than one colour AND its
 * top eighth and bottom eighth are not the same picture.
 */
export interface FrameEvidenceT {
  readonly blank: boolean;
  readonly topBottomDiffer: boolean;
  readonly stats: RegionStatsT;
  readonly topBottomDiff: number;
  readonly note: string;
}

export function frameEvidence(region: RegionT): FrameEvidenceT {
  const rgb = fbSnapshot(region);
  const stats = regionStats(rgb);
  const band = Math.max(1, Math.floor(region.h / 8));
  const top = fbSnapshot({ x: region.x, y: region.y, w: region.w, h: band });
  const bottom = fbSnapshot({ x: region.x, y: region.y + region.h - band, w: region.w, h: band });
  const tb = meanAbsDiff(top, bottom);
  // A dark corner of a real level (mg1's mge1m2, mg3's map3) has a small mean
  // difference between its top and bottom bands simply because both bands are
  // mostly near-black, so the mean alone is not the discriminator wanted here.
  // What separates "a rendered scene" from "one flat fill" is that a
  // measurable share of the two bands' pixels are actually different colours.
  const tbFraction = diffFraction(top, bottom, 4);
  const blank = stats.distinct <= 4 || stats.litFraction < 0.02;
  return {
    blank,
    topBottomDiffer: tb > 2 || tbFraction >= 0.02,
    stats,
    topBottomDiff: tb,
    note: `${statsNote(stats)} topVsBottom=${tb.toFixed(2)} topVsBottomPx=${(tbFraction * 100).toFixed(1)}%`,
  };
}

// ===========================================================================
// drawn-text readback
// ===========================================================================

/**
 * The characters `run()` draws, as rows of text, by capturing the active
 * renderer's Draw_Character.
 *
 * The re-release's own quake.rc sets `scr_usekfont 1`, so
 * src/client/kfont_text.ts's Text_Draw takes its glyph-atlas branch and emits
 * no Draw_Character calls at all -- a Draw_Character capture reads back empty
 * on re-release content unless the classic charset is selected for the
 * duration. `con_font classic` (kfont_text.ts's loadFont: mode "classic"
 * returns no font) does exactly that, and is restored afterwards, so this
 * reads the real string through the real draw path.
 */
export function captureDrawnText(run: () => void): string {
  const r = re.current;
  if (r === null) return "";
  const savedFont = Cvar_VariableString("con_font");
  Cvar_Set("con_font", "classic");
  test_ResetGlyphCache();

  const chars: Array<{ x: number; y: number; num: number }> = [];
  const original = r.Draw_Character;
  r.Draw_Character = (x: number, y: number, num: number): void => {
    chars.push({ x, y, num });
  };
  try {
    run();
  } finally {
    r.Draw_Character = original;
    Cvar_Set("con_font", savedFont);
    test_ResetGlyphCache();
  }

  const rows = new Map<number, Array<{ x: number; num: number }>>();
  for (const ch of chars) {
    const row = rows.get(ch.y) ?? [];
    row.push({ x: ch.x, num: ch.num });
    rows.set(ch.y, row);
  }
  return Array.from(rows.keys())
    .sort((a, b) => a - b)
    .map((y) =>
      (rows.get(y) ?? [])
        .sort((a, b) => a.x - b.x)
        .map((c) => String.fromCharCode(c.num & 127))
        .join(""),
    )
    .join("\n");
}

/** One text glyph as the renderer was asked to draw it. */
export interface GlyphDrawT {
  readonly kind: "classic-char" | "atlas";
  /** For a classic character, the charset index; for an atlas glyph, its source rectangle. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly srcX: number;
  readonly srcY: number;
  readonly srcW: number;
  readonly srcH: number;
  readonly num: number;
  /** GlyphAtlasSourceT.kind: "classic" for the 8x8 charset atlas, "custom" for a kfont/TTF. */
  readonly source: string;
}

/**
 * Every text glyph `run()` asks the renderer to draw, in order.
 *
 * Captures both text primitives: Draw_Character (the classic 8x8 charset path
 * kfont_text.ts's Text_Draw takes at scale 1 with no font selected) and
 * Draw_GlyphAtlas (the kfont/TTF path, and the scaled classic path). Unlike a
 * pixel diff, this does not care where on screen the text landed or whether
 * the console backdrop had finished sliding, so it is the readback used for
 * "did this font/scale/codepoint actually draw".
 */
export function captureGlyphDraws(run: () => void): GlyphDrawT[] {
  const r = re.current;
  if (r === null) return [];
  const out: GlyphDrawT[] = [];

  const originalChar = r.Draw_Character;
  const originalAtlas = r.Draw_GlyphAtlas;
  r.Draw_Character = (x: number, y: number, num: number): void => {
    out.push({ kind: "classic-char", x, y, w: 8, h: 8, srcX: 0, srcY: 0, srcW: 8, srcH: 8, num, source: "charset" });
  };
  r.Draw_GlyphAtlas = (
    dstX: number,
    dstY: number,
    dstW: number,
    dstH: number,
    source: GlyphAtlasSourceT,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
  ): void => {
    out.push({ kind: "atlas", x: dstX, y: dstY, w: dstW, h: dstH, srcX, srcY, srcW, srcH, num: -1, source: source.kind });
  };
  try {
    run();
  } finally {
    r.Draw_Character = originalChar;
    r.Draw_GlyphAtlas = originalAtlas;
  }
  return out;
}

/** A stable signature of a glyph run: its source rectangles and destination sizes, ignoring where it landed. */
export function glyphSignature(glyphs: readonly GlyphDrawT[]): string {
  return glyphs.map((g) => `${g.source}:${g.num}:${g.srcX},${g.srcY},${g.srcW},${g.srcH}@${g.w}x${g.h}`).join(" ");
}

/** The centerprint string currently on screen, as drawn. */
export function centerprintText(): string {
  return captureDrawnText(() => {
    SCR_DrawCenterString();
  });
}

/** Every character one screen refresh draws, as rows of text. */
export function screenText(): string {
  return captureDrawnText(() => {
    SCR_UpdateScreen();
  });
}

// ===========================================================================
// screenshots (the real `screenshot` command, so that path is exercised too)
// ===========================================================================

function shotFiles(gamedir: string): Set<string> {
  if (!existsSync(gamedir)) return new Set<string>();
  return new Set(readdirSync(gamedir).filter((f) => /^quake\d+\.(pcx|tga)$/i.test(f)));
}

/** Runs `screenshot` and moves the file to <SHOTDIR>/<name>.<ext>. Returns the path, or null. */
export function shot(name: string): string | null {
  const gamedir = common.com_gamedir;
  mkdirSync(SHOTDIR, { recursive: true });
  const before = shotFiles(gamedir);
  cmd("screenshot", 2);
  frames(2);
  for (const f of shotFiles(gamedir)) {
    if (before.has(f)) continue;
    const ext = f.slice(f.lastIndexOf("."));
    const dest = `${SHOTDIR}/${name}${ext}`;
    try {
      if (existsSync(dest)) unlinkSync(dest);
      copyFileSync(`${gamedir}/${f}`, dest);
      unlinkSync(`${gamedir}/${f}`);
    } catch {
      return null;
    }
    return dest;
  }
  return null;
}

// ===========================================================================
// a generated skybox, since no retail re-release tree ships one
// ===========================================================================

const SKY_SUFFIXES = ["rt", "bk", "lf", "ft", "up", "dn"] as const;

function tga24(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(18 + width * height * 3);
  out[2] = 2; // uncompressed true-color
  out[12] = width & 255;
  out[13] = (width >> 8) & 255;
  out[14] = height & 255;
  out[15] = (height >> 8) & 255;
  out[16] = 24;
  out[17] = 0x20; // top-left origin
  let o = 18;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      out[o++] = b;
      out[o++] = g;
      out[o++] = r;
    }
  }
  return out;
}

/**
 * Writes six loud, per-face-distinct 64x64 TGAs to
 * `<homedir>/id1/gfx/env/<name><suf>.tga`.
 *
 * Only mg1 and mg3 ship retail skyboxes (`gfx/env/<set>/<face>.tga`, covered
 * by r_formats.ts's `sky` phase); id1, hipnotic, rogue, dopa and ctf carry
 * none, so testing the loader on the id1 tree means supplying faces. The
 * homedir tier is mounted at the head of the search path, so the engine finds
 * these exactly the way it would find a mod's.
 */
export function writeSkybox(homedir: string, name: string): string {
  const dir = `${homedir}/id1/gfx/env`;
  mkdirSync(dir, { recursive: true });
  const faceColors: ReadonlyArray<[number, number, number]> = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
  ];
  for (let i = 0; i < SKY_SUFFIXES.length; i++) {
    const base = faceColors[i];
    const bytes = tga24(64, 64, (x, y) => {
      const checker = ((x >> 3) + (y >> 3)) & 1;
      return checker === 1 ? base : [255 - base[0], 255 - base[1], 255 - base[2]];
    });
    writeFileSync(`${dir}/${name}${SKY_SUFFIXES[i]}.tga`, bytes);
  }
  return dir;
}

// ===========================================================================
// misc re-exports the drivers use
// ===========================================================================

export {
  Cvar_Set,
  Cvar_VariableString,
  Cvar_VariableValue,
  Cmd_Exists,
  cl,
  cls,
  sv,
  keyState,
  KeydestT,
  conState,
  vid,
  rState,
  glState,
  r_refdef,
  common,
  Q1TS_DATA,
};
