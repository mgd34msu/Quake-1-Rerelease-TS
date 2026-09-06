// Vector and angle arithmetic for the game-agnostic bot brain.
//
// A file under src/lib imports nothing from src/ outside src/lib
// (ARCHITECTURE.md, "Source layout"), so the brain cannot use
// src/common/mathlib.ts's `Vec3 = Float32Array`. `BotVec3` below is
// structurally identical to src/lib/nav.ts's `NavVec3`, so a parsed NAV2
// node position is a `BotVec3` with no conversion; the game binding
// converts at its own boundary.

export interface BotVec3 {
  x: number;
  y: number;
  z: number;
}

export function bvec(x = 0, y = 0, z = 0): BotVec3 {
  return { x, y, z };
}

export function bvecCopy(v: BotVec3): BotVec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function bvecAdd(a: BotVec3, b: BotVec3): BotVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function bvecSub(a: BotVec3, b: BotVec3): BotVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function bvecScale(v: BotVec3, s: number): BotVec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function bvecMA(base: BotVec3, scale: number, dir: BotVec3): BotVec3 {
  return { x: base.x + dir.x * scale, y: base.y + dir.y * scale, z: base.z + dir.z * scale };
}

export function bvecDot(a: BotVec3, b: BotVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function bvecLength(v: BotVec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function bvecLength2D(v: BotVec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function bvecDistance(a: BotVec3, b: BotVec3): number {
  return bvecLength(bvecSub(a, b));
}

export function bvecDistance2D(a: BotVec3, b: BotVec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Returns a unit-length copy; a zero vector comes back as (0,0,0). */
export function bvecNormalized(v: BotVec3): BotVec3 {
  const len = bvecLength(v);
  if (len === 0) return bvec();
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Wraps an angle into [0, 360), matching mathlib.ts's anglemod. */
export function angleMod(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** The shortest signed rotation from `from` to `to`, in (-180, 180]. */
export function angleDelta(from: number, to: number): number {
  let d = angleMod(to - from);
  if (d > 180) d -= 360;
  return d;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * The pitch/yaw a view must hold to look along `dir`. Quake's convention:
 * pitch is negative looking up, angles are (pitch, yaw, roll) in degrees.
 */
export function vectorToAngles(dir: BotVec3): { pitch: number; yaw: number } {
  if (dir.x === 0 && dir.y === 0) return { pitch: dir.z > 0 ? -90 : 90, yaw: 0 };
  const yaw = angleMod(Math.atan2(dir.y, dir.x) * RAD_TO_DEG);
  const forward = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
  const pitch = -Math.atan2(dir.z, forward) * RAD_TO_DEG;
  return { pitch, yaw };
}

/** mathlib.ts's AngleVectors, in this module's own vector type. */
export function angleVectors(pitch: number, yaw: number, roll: number): { forward: BotVec3; right: BotVec3; up: BotVec3 } {
  const sy = Math.sin(yaw * DEG_TO_RAD);
  const cy = Math.cos(yaw * DEG_TO_RAD);
  const sp = Math.sin(pitch * DEG_TO_RAD);
  const cp = Math.cos(pitch * DEG_TO_RAD);
  const sr = Math.sin(roll * DEG_TO_RAD);
  const cr = Math.cos(roll * DEG_TO_RAD);

  return {
    forward: { x: cp * cy, y: cp * sy, z: -sp },
    right: { x: -sr * sp * cy + cr * sy, y: -sr * sp * sy - cr * cy, z: -sr * cp },
    up: { x: cr * sp * cy + sr * sy, y: cr * sp * sy - sr * cy, z: cr * cp },
  };
}

/** The angle, in degrees, between `dir` and the view direction (pitch, yaw). */
export function angleBetween(pitch: number, yaw: number, dir: BotVec3): number {
  const { forward } = angleVectors(pitch, yaw, 0);
  const d = bvecNormalized(dir);
  const dot = Math.max(-1, Math.min(1, bvecDot(forward, d)));
  return Math.acos(dot) * RAD_TO_DEG;
}

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
