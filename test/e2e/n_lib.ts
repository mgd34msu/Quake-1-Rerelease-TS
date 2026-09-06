// E2E agent N harness helpers (gameplay-interaction sweep).
// Not a unit test: driven by `bun test/e2e/n_*.ts` directly.
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText, Cbuf_Execute } from "../../src/common/cmd";
import { cl, cls, SIGNONS, CactiveT } from "../../src/client/client";
import { sv, MOVETYPE_NOCLIP, MOVETYPE_WALK } from "../../src/server/server";
import type { EdictT } from "../../src/progs/progs";
import { PR_GetString, pr } from "../../src/progs/progs";
import type { GlobalVars } from "../../src/progs/progdefs";
import { SV_LinkEdict } from "../../src/server/world";
import { re } from "../../src/client/render";
import { SCR_DrawCenterString } from "../../src/client/screen";
import { SV_Move, SV_PointContents, SV_TestEntityPosition, MOVE_NORMAL } from "../../src/server/world";
import { vec3 } from "../../src/common/mathlib";
import { CONTENTS_EMPTY } from "../../src/common/bspfile";
import { GetEdictFieldValue } from "../../src/progs/pr_edict";
import * as consoleMod from "../../src/client/console";
import { conState } from "../../src/client/console";
import { Q1TS_DATA } from "./q1data";

export const BASEDIR = Q1TS_DATA;

export function boot(extra: string[]): void {
  Sys_Main_Init(["quake", "-basedir", BASEDIR, "-game", "e2e_n", "-nosound", ...extra]);
}

export function cmd(text: string): void {
  Cbuf_AddText(text.endsWith("\n") ? text : text + "\n");
}

export function cmdNow(text: string): void {
  cmd(text);
  Cbuf_Execute();
}

export function frames(n: number, dt = 0.05): void {
  for (let i = 0; i < n; i++) runFrames(1, dt);
}

export function inGame(): boolean {
  return cls.state === CactiveT.ca_connected && cls.signon === SIGNONS;
}

export function waitInGame(maxFrames = 600): number {
  for (let i = 0; i < maxFrames; i++) {
    frames(1);
    if (inGame()) return i;
  }
  return -1;
}

export function loadMap(name: string): boolean {
  cmd(`map ${name}`);
  return waitInGame() >= 0;
}

/* ------------------------------------------------------------------ */
/* edict helpers                                                       */
/* ------------------------------------------------------------------ */

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

export function findByClass(name: string): EdictT[] {
  return liveEdicts().filter((e) => classOf(e) === name);
}

export function findByTargetname(name: string): EdictT[] {
  return liveEdicts().filter((e) => PR_GetString(e.v.targetname) === name);
}

export function center(e: EdictT): [number, number, number] {
  return [
    (e.v.absmin[0] + e.v.absmax[0]) / 2,
    (e.v.absmin[1] + e.v.absmax[1]) / 2,
    (e.v.absmin[2] + e.v.absmax[2]) / 2,
  ];
}

export function player(): EdictT {
  return sv.edicts[1];
}

/** Move the server player edict, zero its velocity and relink it. */
export function place(pos: readonly number[], yaw: number, pitch = 0): void {
  const p = player();
  p.v.origin[0] = pos[0];
  p.v.origin[1] = pos[1];
  p.v.origin[2] = pos[2];
  p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
  p.v.angles[0] = 0;
  p.v.angles[1] = yaw;
  p.v.angles[2] = 0;
  p.v.v_angle[0] = pitch;
  p.v.v_angle[1] = yaw;
  p.v.v_angle[2] = 0;
  p.v.fixangle = 1;
  SV_LinkEdict(p, false);
  cl.viewangles[0] = pitch;
  cl.viewangles[1] = yaw;
  cl.viewangles[2] = 0;
}

/** Keep the player exactly where it is (MOVETYPE_NOCLIP, no gravity, no drift). */
export function freeze(): void {
  const p = player();
  p.v.movetype = MOVETYPE_NOCLIP;
  p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
}

export function unfreeze(): void {
  player().v.movetype = MOVETYPE_WALK;
}

/** Re-assert the aim angles every frame while firing (client resends its cmd). */
export function aim(yaw: number, pitch = 0): void {
  cl.viewangles[0] = pitch;
  cl.viewangles[1] = yaw;
  cl.viewangles[2] = 0;
  const p = player();
  p.v.v_angle[0] = pitch;
  p.v.v_angle[1] = yaw;
  p.v.v_angle[2] = 0;
  p.v.angles[1] = yaw;
}

/** Hold +attack for n frames, re-asserting angles and position each frame. */
export function fire(n: number, yaw: number, pitch = 0, hold?: readonly number[]): void {
  cmd("+attack");
  for (let i = 0; i < n; i++) {
    aim(yaw, pitch);
    if (hold) {
      const p = player();
      p.v.origin[0] = hold[0];
      p.v.origin[1] = hold[1];
      p.v.origin[2] = hold[2];
      p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
      SV_LinkEdict(p, false);
    }
    frames(1);
  }
  cmd("-attack");
  frames(2);
}

/** yaw (degrees) that points from a towards b */
export function yawTo(a: readonly number[], b: readonly number[]): number {
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

export function pitchTo(a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const horiz = Math.sqrt(dx * dx + dy * dy);
  // Quake pitch is negative-up
  return (-Math.atan2(dz, horiz) * 180) / Math.PI;
}

/* ------------------------------------------------------------------ */
/* result table                                                        */
/* ------------------------------------------------------------------ */

const results: { id: string; pass: boolean; note: string }[] = [];

export function check(id: string, pass: boolean, note: string): boolean {
  results.push({ id, pass, note });
  console.log(`##N ${pass ? "PASS" : "FAIL"} ${id} :: ${note}`);
  return pass;
}

export function info(id: string, note: string): void {
  console.log(`##N INFO ${id} :: ${note}`);
}

export function summary(tag: string): void {
  const pass = results.filter((r) => r.pass).length;
  console.log(`##N SUMMARY ${tag} ${pass}/${results.length} passed`);
  for (const r of results) if (!r.pass) console.log(`##N   FAILED: ${r.id} :: ${r.note}`);
}

/* ------------------------------------------------------------------ */
/* centerprint readback (via the re.current.Draw_Character seam)        */
/* ------------------------------------------------------------------ */

/** Re-draw the current center string into a capture buffer and return its text. */
export function centerText(): string {
  const r = re.current;
  if (!r) return "";
  const chars: { x: number; y: number; num: number }[] = [];
  const orig = r.Draw_Character;
  r.Draw_Character = (x: number, y: number, num: number): void => {
    chars.push({ x, y, num });
  };
  try {
    SCR_DrawCenterString();
  } finally {
    r.Draw_Character = orig;
  }
  const rows = new Map<number, { x: number; num: number }[]>();
  for (const ch of chars) {
    const row = rows.get(ch.y) ?? [];
    row.push({ x: ch.x, num: ch.num });
    rows.set(ch.y, row);
  }
  const ys = Array.from(rows.keys()).sort((a, b) => a - b);
  return ys
    .map((y) =>
      (rows.get(y) ?? [])
        .sort((a, b) => a.x - b.x)
        .map((cc) => String.fromCharCode(cc.num & 127))
        .join(""),
    )
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* line-of-sight probing and shooting                                   */
/* ------------------------------------------------------------------ */

export interface LosSpot {
  stand: [number, number, number];
  yaw: number;
  pitch: number;
  dist: number;
}

/**
 * Find an open point (CONTENTS_EMPTY) from which a point traceline reaches
 * `ent`, searching outward in rings around its centre.
 */
export function losSpots(ent: EdictT, want = 1, minR = 48, maxR = 320): LosSpot[] {
  const c = center(ent);
  const p = player();
  const tgt = vec3();
  tgt[0] = c[0]; tgt[1] = c[1]; tgt[2] = c[2];
  const out: LosSpot[] = [];
  for (let r = minR; r <= maxR; r += 16) {
    for (let dz = 0; dz <= 64; dz += 16) {
      for (const sz of dz === 0 ? [0] : [dz, -dz]) {
        for (let a = 0; a < 360; a += 10) {
          const s = vec3();
          s[0] = c[0] + Math.cos((a * Math.PI) / 180) * r;
          s[1] = c[1] + Math.sin((a * Math.PI) / 180) * r;
          s[2] = c[2] + sz;
          if (SV_PointContents(s) !== CONTENTS_EMPTY) continue;
          const src = vec3();
          src[0] = s[0]; src[1] = s[1]; src[2] = s[2] + 16;
          const d = [tgt[0] - src[0], tgt[1] - src[1], tgt[2] - src[2]];
          const len = Math.hypot(d[0], d[1], d[2]);
          if (len < 8) continue;
          const end = vec3();
          for (let i = 0; i < 3; i++) end[i] = src[i] + (d[i] / len) * 2048;
          const tr = SV_Move(src, vec3(), vec3(), end, MOVE_NORMAL, p);
          if (tr.ent !== ent) continue;
          const eye: [number, number, number] = [s[0], s[1], s[2] + 16];
          out.push({ stand: [s[0], s[1], s[2]], yaw: yawTo(eye, c), pitch: pitchTo(eye, c), dist: len });
          if (out.length >= want) return out;
        }
      }
    }
  }
  return out;
}

/**
 * Find an open point (CONTENTS_EMPTY) from which a point traceline reaches
 * `ent`, searching outward in rings around its centre.
 */
export function losSpot(ent: EdictT, minR = 48, maxR = 320): LosSpot | null {
  return losSpots(ent, 1, minR, maxR)[0] ?? null;
}

export interface ShotResult {
  minHealth: number;
  died: boolean;
  freed: boolean;
  spot: LosSpot | null;
}

/**
 * Walk the player to a spot with line of sight to `ent`, hold it there, and
 * fire `weapon` at the entity for `nframes`, sampling its health every frame.
 */
export function shootEntity(ent: EdictT, weapon: number, nframes = 40, spotIn?: LosSpot | null): ShotResult {
  const spot = spotIn ?? losSpot(ent);
  if (!spot) return { minHealth: NaN, died: false, freed: false, spot: null };
  place(spot.stand, spot.yaw, spot.pitch);
  freeze();
  frames(4);
  cmd(`impulse ${weapon}`);
  frames(6);
  // re-aim from the settled eye height
  const p = player();
  const c = center(ent);
  const eye: [number, number, number] = [
    p.v.origin[0], p.v.origin[1], p.v.absmin[2] + (p.v.maxs[2] - p.v.mins[2]) * 0.7,
  ];
  const yaw = yawTo(eye, c);
  const pitch = pitchTo(eye, c);
  let minHealth = ent.v.health;
  let died = false;
  cmd("+attack");
  for (let i = 0; i < nframes; i++) {
    aim(yaw, pitch);
    p.v.origin[0] = spot.stand[0];
    p.v.origin[1] = spot.stand[1];
    p.v.origin[2] = spot.stand[2];
    p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
    SV_LinkEdict(p, false);
    frames(1);
    if (ent.free) { died = true; break; }
    if (ent.v.health < minHealth) minHealth = ent.v.health;
    if (ent.v.health <= 0) died = true;
  }
  cmd("-attack");
  frames(4);
  return { minHealth, died, freed: ent.free, spot };
}

/** impulse 9: all weapons + ammo (single player cheat). */
export function giveAll(): void {
  cmd("impulse 9");
  frames(8);
}

/* ------------------------------------------------------------------ */
/* QuakeC-declared field access (fields past entvars_t)                 */
/* ------------------------------------------------------------------ */

/** Read a QuakeC field by name as a float. NaN if the progs has no such field. */
export function qcFloat(ed: EdictT, field: string): number {
  const ofs = GetEdictFieldValue(ed, field);
  if (ofs < 0) return NaN;
  return ed.fields.f[ofs];
}

/** Read a QuakeC string field by name. "" if the progs has no such field. */
export function qcString(ed: EdictT, field: string): string {
  const ofs = GetEdictFieldValue(ed, field);
  if (ofs < 0) return "";
  return PR_GetString(ed.fields.i[ofs]);
}

export function qcVec(ed: EdictT, field: string): [number, number, number] {
  const ofs = GetEdictFieldValue(ed, field);
  if (ofs < 0) return [NaN, NaN, NaN];
  return [ed.fields.f[ofs], ed.fields.f[ofs + 1], ed.fields.f[ofs + 2]];
}

/* ------------------------------------------------------------------ */
/* motion sampling                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run `n` frames, recording for each watched edict the largest distance its
 * origin ever reached from where it started.
 */
export function watchOrigins(ents: readonly EdictT[], n: number, dt = 0.05): number[] {
  const start = ents.map((e) => Array.from(e.v.origin));
  const best = ents.map(() => 0);
  for (let i = 0; i < n; i++) {
    frames(1, dt);
    for (let k = 0; k < ents.length; k++) {
      const d = Math.hypot(
        ents[k].v.origin[0] - start[k][0],
        ents[k].v.origin[1] - start[k][1],
        ents[k].v.origin[2] - start[k][2],
      );
      if (d > best[k]) best[k] = d;
    }
  }
  return best;
}

/**
 * Fire at `ent` from `spot` for `n` frames while sampling several entities'
 * displacement and the target's own health/takedamage. Returns the peak
 * displacement of each watched entity plus the target's minimum health.
 */
export interface SampledShot {
  minHealth: number;
  sawTakedamageOff: boolean;
  moved: number[];
  spot: LosSpot | null;
}

export function shootAndWatch(
  ent: EdictT,
  weapon: number,
  watch: readonly EdictT[],
  nfire = 40,
  nafter = 80,
  spotIn?: LosSpot | null,
): SampledShot {
  const spot = spotIn ?? losSpot(ent);
  if (!spot) return { minHealth: NaN, sawTakedamageOff: false, moved: watch.map(() => 0), spot: null };
  place(spot.stand, spot.yaw, spot.pitch);
  freeze();
  frames(4);
  cmd(`impulse ${weapon}`);
  frames(6);
  const p = player();
  const c = center(ent);
  const eye: [number, number, number] = [
    p.v.origin[0], p.v.origin[1], p.v.absmin[2] + (p.v.maxs[2] - p.v.mins[2]) * 0.7,
  ];
  const yaw = yawTo(eye, c);
  const pitch = pitchTo(eye, c);

  const start = watch.map((e) => Array.from(e.v.origin));
  const moved = watch.map(() => 0);
  let minHealth = ent.v.health;
  let sawTakedamageOff = false;

  const sample = (): void => {
    for (let k = 0; k < watch.length; k++) {
      if (watch[k].free) continue;
      const d = Math.hypot(
        watch[k].v.origin[0] - start[k][0],
        watch[k].v.origin[1] - start[k][1],
        watch[k].v.origin[2] - start[k][2],
      );
      if (d > moved[k]) moved[k] = d;
    }
    if (!ent.free) {
      if (ent.v.health < minHealth) minHealth = ent.v.health;
      if (ent.v.takedamage === 0) sawTakedamageOff = true;
    }
  };

  cmd("+attack");
  for (let i = 0; i < nfire; i++) {
    aim(yaw, pitch);
    p.v.origin[0] = spot.stand[0];
    p.v.origin[1] = spot.stand[1];
    p.v.origin[2] = spot.stand[2];
    p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
    SV_LinkEdict(p, false);
    frames(1);
    sample();
  }
  cmd("-attack");
  for (let i = 0; i < nafter; i++) {
    frames(1);
    sample();
  }
  return { minHealth, sawTakedamageOff, moved, spot };
}

/**
 * Find an open point as close as possible to `ent`, for walking/touch tests.
 * Searches expanding rings at several heights and returns the nearest hit.
 */
export function nearSpot(ent: EdictT, minR = 24, maxR = 200): [number, number, number] | null {
  const c = center(ent);
  for (let r = minR; r <= maxR; r += 8) {
    for (let dz = 0; dz <= 48; dz += 12) {
      for (const sz of dz === 0 ? [0] : [dz, -dz]) {
        for (let a = 0; a < 360; a += 10) {
          const s = vec3();
          s[0] = c[0] + Math.cos((a * Math.PI) / 180) * r;
          s[1] = c[1] + Math.sin((a * Math.PI) / 180) * r;
          s[2] = c[2] + sz;
          if (SV_PointContents(s) !== CONTENTS_EMPTY) continue;
          return [s[0], s[1], s[2]];
        }
      }
    }
  }
  return null;
}

/** Find an open point inside (or as close as possible to) an entity's bbox. */
export function insideSpot(ent: EdictT): [number, number, number] | null {
  const lo = ent.v.absmin;
  const hi = ent.v.absmax;
  const cand: [number, number, number][] = [];
  const c = center(ent);
  cand.push([c[0], c[1], c[2]]);
  for (const fx of [0.5, 0.25, 0.75]) {
    for (const fy of [0.5, 0.25, 0.75]) {
      for (const fz of [0.5, 0.3, 0.7, 0.15]) {
        cand.push([
          lo[0] + (hi[0] - lo[0]) * fx,
          lo[1] + (hi[1] - lo[1]) * fy,
          lo[2] + (hi[2] - lo[2]) * fz,
        ]);
      }
    }
  }
  for (const p of cand) {
    const s = vec3();
    s[0] = p[0]; s[1] = p[1]; s[2] = p[2];
    if (SV_PointContents(s) === CONTENTS_EMPTY) return p;
  }
  return null;
}

/**
 * Place the player at `pos` (frozen, so it cannot fall out) and run `n` frames.
 * SV_Physics_Client calls SV_LinkEdict(ent, true) every frame, so touch
 * functions fire exactly as they would for a walking player.
 */
export function standAt(pos: readonly number[], n: number, yaw = 0): void {
  place(pos, yaw, 0);
  freeze();
  for (let i = 0; i < n; i++) {
    const p = player();
    p.v.origin[0] = pos[0];
    p.v.origin[1] = pos[1];
    p.v.origin[2] = pos[2];
    p.v.velocity[0] = p.v.velocity[1] = p.v.velocity[2] = 0;
    frames(1);
  }
}

/**
 * doors.qc / plats.qc spawn an invisible SOLID_TRIGGER "field" entity owned by
 * the door (spawn_field / plat_trigger_use). Standing in that field is what
 * actually calls door_touch, so touch tests aim at the field, not the brush.
 */
export function triggerFieldOf(owner: EdictT): EdictT | null {
  const idx = edictIndex(owner);
  for (const e of liveEdicts()) {
    if (e === owner) continue;
    if (e.v.solid !== 1) continue; // SOLID_TRIGGER
    if ((e.v.owner | 0) === idx) return e;
  }
  return null;
}

/**
 * Walk the player into `ent` for real: stand in front of it on the floor with
 * MOVETYPE_WALK and hold +forward, so SV_FlyMove's SV_Impact calls its touch
 * function. Doors with a targetname, health, or a key (self.items) never spawn
 * a trigger field (doors.qc's door_link returns early), so collision is the
 * only way to reach door_touch on them.
 */
export function walkInto(ent: EdictT, nframes = 40, startAt?: readonly number[]): boolean {
  const spots: readonly (readonly number[])[] = startAt
    ? [startAt]
    : [...faceSpots(ent), ...losSpots(ent, 6, 40, 260).map((s) => s.stand)];
  if (spots.length === 0) return false;
  const start = Array.from(ent.v.origin);
  for (const spot of spots) {
    const c = center(ent);
    let yaw = yawTo(spot, c);
    place(spot, yaw, 0);
    unfreeze();
    frames(16); // settle onto the floor
    const p = player();
    yaw = yawTo([p.v.origin[0], p.v.origin[1], p.v.origin[2]], c);
    cmd("+forward");
    for (let i = 0; i < nframes; i++) {
      aim(yaw, 0);
      frames(1);
      if (i % 8 === 7) {
        // keep steering at the target as we slide along walls
        yaw = yawTo([p.v.origin[0], p.v.origin[1], p.v.origin[2]], c);
      }
      const moved = Math.hypot(
        ent.v.origin[0] - start[0], ent.v.origin[1] - start[1], ent.v.origin[2] - start[2]);
      if (moved > 1) { cmd("-forward"); frames(2); return true; }
    }
    cmd("-forward");
    frames(4);
  }
  return true;
}

/**
 * Set an entity off the way a player would: stand in it if it is a trigger,
 * shoot it if it is shootable, otherwise walk into it. Returns how it was done.
 */
export function activate(ent: EdictT, weapon = 3): string {
  if (ent.v.solid === 1) {
    const inside = insideSpot(ent);
    if (inside) {
      standAt(inside, 20);
      const out = nearSpot(ent, 400, 1200);
      if (out) standAt(out, 8);
      return "touched";
    }
    return "trigger-unreachable";
  }
  if (ent.v.health > 0 && ent.v.takedamage > 0) {
    const spot = losSpot(ent, 48, 320);
    if (spot) {
      shootAndWatch(ent, weapon, [], 30, 20, spot);
      return "shot";
    }
  }
  return walkInto(ent, 40) ? "walked" : "unreachable";
}

/** Every entity whose `target` names `name`. */
export function targetedBy(name: string): EdictT[] {
  if (name === "") return [];
  return liveEdicts().filter((e) => PR_GetString(e.v.target) === name);
}

/** True if the player's bounding box fits (unobstructed) at `pos`. */
export function playerFits(pos: readonly number[]): boolean {
  const p = player();
  const save: [number, number, number] = [p.v.origin[0], p.v.origin[1], p.v.origin[2]];
  p.v.origin[0] = pos[0];
  p.v.origin[1] = pos[1];
  p.v.origin[2] = pos[2];
  SV_LinkEdict(p, false);
  const blocked = SV_TestEntityPosition(p);
  p.v.origin[0] = save[0];
  p.v.origin[1] = save[1];
  p.v.origin[2] = save[2];
  SV_LinkEdict(p, false);
  return blocked === null;
}

/**
 * Player-sized clear standing spots just off each of a brush entity's four
 * vertical faces, at several heights. Used to walk into doors and buttons that
 * have no trigger field and so must be reached by collision.
 */
export function faceSpots(ent: EdictT, gap = 40): [number, number, number][] {
  const lo = ent.v.absmin;
  const hi = ent.v.absmax;
  const c = center(ent);
  const out: [number, number, number][] = [];
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    for (const zf of [0.25, 0.5, 0.1, 0.75]) {
      const z = lo[2] + (hi[2] - lo[2]) * zf + 24;
      const x = dx === 0 ? c[0] : dx > 0 ? hi[0] + gap : lo[0] - gap;
      const y = dy === 0 ? c[1] : dy > 0 ? hi[1] + gap : lo[1] - gap;
      const probe = vec3();
      probe[0] = x; probe[1] = y; probe[2] = z;
      if (SV_PointContents(probe) !== CONTENTS_EMPTY) continue;
      if (!playerFits([x, y, z])) continue;
      out.push([x, y, z]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* console scrollback                                                   */
/* ------------------------------------------------------------------ */

/** Whole console scrollback as trimmed lines, oldest first. */
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

export function conHas(needle: string): boolean {
  return conLines().some((l) => l.includes(needle));
}

export function conTail(n = 12): string {
  return conLines().filter((l) => l.length > 0).slice(-n).join(" | ");
}

/** The QuakeC global block (total_secrets, killed_monsters, ...). */
export function qcGlobals(): GlobalVars {
  const g = pr.global_struct;
  if (g === null) throw new Error("pr.global_struct not set");
  return g;
}
