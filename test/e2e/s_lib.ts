// E2E family S -- save games end to end. Shared boot/assert helpers for the
// s_*.ts drivers. Not a bun:test suite: each s_*.ts scenario is a standalone
// script run with `bun test/e2e/s_<name>.ts [args...]` (test/e2e/README.md
// "Headless recipe").
//
// Boot recipe deviation from every other family's a_lib.ts/b_lib.ts/n_lib.ts:
// this family issues its very first `map <name>` via `Cmd_ExecuteString`
// directly, BEFORE any `runFrames` call, instead of `Cbuf_AddText("map
// <name>\n")` followed by a pump loop. A queued `map` does run -- on frame 0,
// right behind the `playdemo demo1` Host_Startdemos_f/CL_NextDemo insert, in
// the same Cbuf_Execute drain (F8 verified this byte-for-byte against
// WinQuake's cmd.c under a re-release basedir too). What bit this family
// was a harness race, not the engine: the demo reaches SIGNONS first, so a
// waitInGame() poll can return true on demo1.dem's own map while the queued
// `map` is still in flight. Spawning the server synchronously before the
// first frame sidesteps the race, and Host_Startdemos_f's own
// `if (!sv.active && ...)` guard then skips the demo loop entirely.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cmd_ExecuteString, CmdSourceT } from "../../src/common/cmd";
import { Cvar_Set, Cvar_VariableValue } from "../../src/common/cvar";
import { cl, cls, SIGNONS, CactiveT } from "../../src/client/client";
import * as common from "../../src/common/common";
import { STAT_HEALTH, STAT_MONSTERS, STAT_TOTALMONSTERS } from "../../src/common/quakedef";
import { sv, svs, MOVETYPE_NOCLIP, SOLID_NOT, FL_GODMODE } from "../../src/server/server";
import { SV_LinkEdict } from "../../src/server/world";
import { EDICT_NUM, PR_GetString } from "../../src/progs/progs";
import type { EdictT } from "../../src/progs/progs";
import { Q1TS_DATA } from "./q1data";

export { Q1TS_DATA };
export const Q1TS_SCRATCH = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";

/** This unit's own scratch tree, separate from every other family's. */
export const S_SCRATCH = `${Q1TS_SCRATCH}/e2e_s`;

export type TreeName =
  | "classic-id1"
  | "classic-hipnotic"
  | "classic-rogue"
  | "id1"
  | "hipnotic"
  | "rogue"
  | "mg1"
  | "mg3"
  | "dopa"
  | "ctf";

export interface TreeConfig {
  basedir: string;
  flags: string[];
  isClassic: boolean; // classic-<x> trees: -norerelease, WinQuake content
  ruleset: "classic" | "rerelease"; // the sv_ruleset this tree is played under
  /** A short, fast-loading single-player map with monsters + items, per family E2's own tree/episode probing. */
  map: string;
}

export function treeConfig(tree: TreeName): TreeConfig {
  switch (tree) {
    case "classic-id1":
      return { basedir: Q1TS_DATA, flags: ["-norerelease"], isClassic: true, ruleset: "classic", map: "e1m1" };
    case "classic-hipnotic":
      return { basedir: Q1TS_DATA, flags: ["-norerelease", "-hipnotic"], isClassic: true, ruleset: "classic", map: "hip1m1" };
    case "classic-rogue":
      return { basedir: Q1TS_DATA, flags: ["-norerelease", "-rogue"], isClassic: true, ruleset: "classic", map: "r1m1" };
    case "id1":
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: [], isClassic: false, ruleset: "rerelease", map: "e1m1" };
    case "hipnotic":
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: ["-hipnotic"], isClassic: false, ruleset: "rerelease", map: "hip1m1" };
    case "rogue":
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: ["-rogue"], isClassic: false, ruleset: "rerelease", map: "r1m1" };
    case "mg1":
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: ["-mg1"], isClassic: false, ruleset: "rerelease", map: "mge1m1" };
    case "mg3":
      // BSP2; map1 is Dimension of the Past's own first level (has monsters+items).
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: ["-mg3"], isClassic: false, ruleset: "rerelease", map: "map1" };
    case "dopa":
      // BSP2.
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: ["-dopa"], isClassic: false, ruleset: "rerelease", map: "e5m1" };
    case "ctf":
      // No CTF map ships a monster (id's own ctf1-9 + test_ctf are all pure
      // PvP layouts -- confirmed by booting every one of them and counting
      // "monster_*" classnames, none found); the "kill a monster" leg of
      // s_roundtrip.ts is dropped for this tree only and reported as a
      // deviation rather than silently skipped (standing order 4).
      return { basedir: `${Q1TS_DATA}/rerelease`, flags: ["-ctf"], isClassic: false, ruleset: "rerelease", map: "ctf1" };
  }
}

export const ALL_TREES: TreeName[] = [
  "classic-id1", "classic-hipnotic", "classic-rogue",
  "id1", "hipnotic", "rogue", "mg1", "mg3", "dopa", "ctf",
];

export function isTreeName(s: string): s is TreeName {
  return (ALL_TREES as string[]).includes(s);
}

/* -------------------------------------------------------------------- */
/* PASS/FAIL/RESULT contract (test/e2e/README.md, E2E-COMMON.md)         */
/* -------------------------------------------------------------------- */

export const results: Array<{ name: string; pass: boolean; note: string }> = [];

export function check(name: string, pass: boolean, note = ""): boolean {
  results.push({ name, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${note ? " :: " + note : ""}`);
  return pass;
}

export function skip(name: string, note = ""): void {
  console.log(`[PASS] ${name} :: ${note || "skipped -- see note"}`);
  results.push({ name, pass: true, note });
}

export function finish(): never {
  const fail = results.filter((r) => !r.pass).length;
  console.log(`RESULT ${results.length - fail} ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

/* -------------------------------------------------------------------- */
/* boot / frame pump                                                     */
/* -------------------------------------------------------------------- */

/**
 * `gamedirSuffix` becomes both `-game e2e_s_<suffix>` and the `-homedir`
 * subtree name, so every invocation of every s_*.ts driver (and every
 * --tree/--protocol combination of s_roundtrip.ts) writes to its own
 * directory under S_SCRATCH -- saves never land in Q1TS_DATA/Q1TS_DATA's
 * rerelease tree, and two driver invocations never collide on the same
 * config.cfg/*.sav files even when run out of order.
 */
export function gamedirFor(suffix: string): string {
  return `e2e_s_${suffix.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

export function homedirFor(suffix: string): string {
  const dir = `${S_SCRATCH}/home_${suffix.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function boot(cfg: TreeConfig, gamedirSuffix: string, extra: string[] = []): void {
  const homedir = homedirFor(gamedirSuffix);
  const argv = [
    "quake",
    "-basedir", cfg.basedir,
    ...cfg.flags,
    "-homedir", homedir,
    "-game", gamedirFor(gamedirSuffix),
    "-nosound",
    ...extra,
  ];
  Sys_Main_Init(argv);
}

export function gamedir(): string {
  return common.com_gamedir;
}

export function cmd(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
}

export function exec(text: string): void {
  Cmd_ExecuteString(text, CmdSourceT.src_command);
}

export async function frames(n: number, dt = 0.05, sleepMs = 0): Promise<void> {
  for (let i = 0; i < n; i++) {
    runFrames(1, dt);
    if (sleepMs > 0) await Bun.sleep(sleepMs);
  }
}

export function inGame(): boolean {
  return cls.state === CactiveT.ca_connected && cls.signon === SIGNONS;
}

export async function waitInGame(maxFrames = 400): Promise<number> {
  for (let i = 0; i < maxFrames; i++) {
    await frames(1);
    if (inGame()) return i;
  }
  return -1;
}

/** See this file's header note: the one reliable way to load a map on both roots. */
export async function directMap(name: string, settle = 30): Promise<boolean> {
  exec(`map ${name}`);
  const waited = await waitInGame(400);
  if (waited < 0) return false;
  await frames(settle);
  return sv.active && sv.name === name;
}

export function setCvar(name: string, value: string): void {
  Cvar_Set(name, value);
}

/* -------------------------------------------------------------------- */
/* edict helpers                                                         */
/* -------------------------------------------------------------------- */

export function player(): EdictT {
  return EDICT_NUM(1);
}

export function classOf(e: EdictT): string {
  return PR_GetString(e.v.classname);
}

export function liveEdicts(): EdictT[] {
  const out: EdictT[] = [];
  for (let i = 1; i < sv.num_edicts; i++) {
    const e = sv.edicts[i];
    if (!e || e.free) continue;
    out.push(e);
  }
  return out;
}

export function edictIndex(ed: EdictT): number {
  for (let i = 0; i < sv.num_edicts; i++) if (sv.edicts[i] === ed) return i;
  return -1;
}

function center(e: EdictT): [number, number, number] {
  return [
    (e.v.absmin[0] + e.v.absmax[0]) / 2,
    (e.v.absmin[1] + e.v.absmax[1]) / 2,
    (e.v.absmin[2] + e.v.absmax[2]) / 2,
  ];
}

function aim(yaw: number, pitch: number): void {
  cl.viewangles[0] = pitch;
  cl.viewangles[1] = yaw;
  cl.viewangles[2] = 0;
  const p = player();
  p.v.v_angle[0] = pitch;
  p.v.v_angle[1] = yaw;
  p.v.v_angle[2] = 0;
  p.v.angles[1] = yaw;
}

function yawTo(a: readonly number[], b: readonly number[]): number {
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

function pitchTo(a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const horiz = Math.sqrt(dx * dx + dy * dy);
  return (-Math.atan2(dz, horiz) * 180) / Math.PI; // Quake pitch is negative-up
}

/**
 * A monster counts as dead once QC's own T_Damage/Killed has run its
 * th_die -- classic monster death (army_die etc.) neither ED_Frees the
 * edict nor removes it from sv.edicts, it plays a death animation and
 * leaves a corpse (SOLID_NOT after the anim settles), so `m.free` is NOT a
 * usable death signal (confirmed by probing monster_army on e1m1: health
 * goes negative and stays that way, deadflag flips to DEAD_DEAD, and the
 * edict is still present -- see this unit's report). health<=0 || deadflag
 * is the same criterion src/bots/bot_world.ts already uses for "is this
 * entity dead".
 */
export function isDead(m: EdictT): boolean {
  return m.free || m.v.health <= 0 || m.v.deadflag !== 0;
}

/**
 * Give the player every weapon (`impulse 9`, the same single-player cheat
 * test/e2e/n_lib.ts's giveAll() uses), stand them noclipped a short distance
 * back from the target with the rocket launcher selected (`impulse 7`), aim
 * at it, and hold +attack. Not a point-blank co-location: probing this
 * against monster_army on e1m1 found that placing the player's origin
 * exactly AT the target's own center causes it to take heavy unexplained
 * damage within a couple of frames, before any shot is fired (see this
 * unit's report) -- an interaction this helper avoids by standing off to
 * one side instead, which is also just how a player would actually do this.
 */
export async function killMonster(m: EdictT): Promise<boolean> {
  const p = player();
  const savedMovetype = p.v.movetype;
  const savedFlags = p.v.flags | 0;
  p.v.movetype = MOVETYPE_NOCLIP;
  p.v.flags = savedFlags | FL_GODMODE;
  p.v.health = 100;
  const c = center(m);
  const standPos: [number, number, number] = [c[0] - 100, c[1], c[2]];
  const eye: [number, number, number] = [standPos[0], standPos[1], standPos[2] + 22];
  const place = (): void => {
    p.v.origin[0] = standPos[0];
    p.v.origin[1] = standPos[1];
    p.v.origin[2] = standPos[2];
    p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
    SV_LinkEdict(p, false);
  };
  place();
  exec("impulse 9"); // give all weapons + ammo
  await frames(6);
  exec("impulse 7"); // select rocket launcher
  await frames(2);
  const yaw = yawTo(eye, c);
  const pitch = pitchTo(eye, c);
  aim(yaw, pitch);
  exec("+attack");
  let died = false;
  for (let i = 0; i < 60; i++) {
    aim(yaw, pitch);
    place();
    await frames(1);
    if (isDead(m)) {
      died = true;
      break;
    }
  }
  exec("-attack");
  await frames(4);
  p.v.movetype = savedMovetype;
  p.v.flags = savedFlags;
  return died;
}

/** Walk the player onto an item's origin so its touch function fires. */
export async function pickUp(item: EdictT): Promise<void> {
  const p = player();
  const savedMovetype = p.v.movetype;
  p.v.movetype = MOVETYPE_NOCLIP;
  p.v.origin[0] = item.v.origin[0];
  p.v.origin[1] = item.v.origin[1];
  p.v.origin[2] = item.v.origin[2] + 1;
  p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
  SV_LinkEdict(p, false);
  await frames(10);
  p.v.movetype = savedMovetype;
  // One walking frame so SV_CheckStuck refreshes oldorigin: a save taken
  // straight after a noclip hop carries the stale oldorigin and a load
  // then puts the player back there (F8's finding on the ctf leg).
  await frames(1);
}

export function ammoSnapshot(p: EdictT): { shells: number; nails: number; rockets: number; cells: number; health: number } {
  return {
    shells: p.v.ammo_shells,
    nails: p.v.ammo_nails,
    rockets: p.v.ammo_rockets,
    cells: p.v.ammo_cells,
    health: p.v.health,
  };
}

export { STAT_HEALTH, STAT_MONSTERS, STAT_TOTALMONSTERS, Cvar_VariableValue, cl, sv, svs, SOLID_NOT, FL_GODMODE };

/* -------------------------------------------------------------------- */
/* misc                                                                  */
/* -------------------------------------------------------------------- */

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function rmrf(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export { existsSync, readdirSync, readFileSync, writeFileSync };
