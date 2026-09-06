/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from WinQuake/mathlib.h and WinQuake/mathlib.c (GNU GPL v2 or later).

Deviations from PORTING.md / the C source:
- `mplane_t` and SIDE_FRONT/SIDE_BACK/SIDE_ON come from WinQuake/model.h (which
  duplicates the SIDE_* defines in gl_model.h), and PLANE_X..PLANE_ANYZ come from
  WinQuake/bspfile.h. The unit brief places all of them here so that the plane
  type this module's BoxOnPlaneSide takes is declared beside it; model.ts,
  gl_model.ts and bspfile.ts import them from here rather than redeclaring.
  (bspfile.ts re-exports PLANE_* so it still exports what bspfile.h exported.)
- `BOPS_Error` and `FloorDivMod`'s bad-denominator check call `Sys_Error` in the C.
  `src/platform/sys.ts` (and its `SysError` class) does not exist yet and is outside
  this unit's scope, so both throw a plain `Error` carrying the C's message text.
  They must be switched to `SysError` when sys.ts lands.
- `FloorDivMod`'s two `int *` out-parameters become a returned
  `{ quotient, rem }` object; there is exactly one call site (d_polyse.c).
- `Invert24To16` is declared `fixed16_t` (i.e. `int`), so the C's literal
  `return (0xFFFFFFFF)` converts to -1; `| 0` reproduces that. The C's
  double->int cast of the main expression is undefined for val in [256, 512]
  (the quotient exceeds INT_MAX there); JS `| 0` wraps modulo 2^32 where x86
  would yield INT_MIN. mathlib.c's version is the `#if !id386` fallback and has
  no C caller (the x86 build calls the .s implementation), so nothing observes it.
- mathlib.h declares no random()/crandom(); Quake's are QuakeC builtins over
  stdlib rand(). None are invented here.
- The `#if !id386` guards around BoxOnPlaneSide and Invert24To16, and the `#if 0`
  blocks inside anglemod and BoxOnPlaneSide, take the C path per PORTING.md.
  The `#if 0` fast axial case inside BoxOnPlaneSide stays dropped: in Quake 1
  (unlike Quake 2) that check lives only in the BOX_ON_PLANE_SIDE macro, so
  BoxOnPlaneSide itself always runs the signbits switch.
*/

// mathlib.h

import { PITCH, YAW, ROLL } from "./quakedef";

export type VecT = number;
export type Vec3 = Float32Array;
export type Vec5 = Float32Array;

export type Fixed4T = number;
export type Fixed8T = number;
export type Fixed16T = number;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export const M_PI = 3.14159265358979323846; // matches value in gcc v2 math.h

export const vec3_origin: Vec3 = vec3(0, 0, 0);
export const nanmask = 255 << 23;

const nanBuf = new ArrayBuffer(4);
const nanFloat = new Float32Array(nanBuf);
const nanInt = new Int32Array(nanBuf);

export function IS_NAN(x: number): boolean {
  nanFloat[0] = x;
  return (nanInt[0] & nanmask) === nanmask;
}

// 0-2 are axial planes
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;

// 3-5 are non-axial planes snapped to the nearest
export const PLANE_ANYX = 3;
export const PLANE_ANYY = 4;
export const PLANE_ANYZ = 5;

export const SIDE_FRONT = 0;
export const SIDE_BACK = 1;
export const SIDE_ON = 2;

export class MplaneT {
  normal: Vec3 = new Float32Array(3);
  dist = 0;
  type = 0; // for texture axis selection and fast side tests
  signbits = 0; // signx + signy<<1 + signz<<1
}

//============================================================================
// The DotProduct/VectorSubtract/VectorAdd/VectorCopy macros become real
// functions; TS has no macros.

export function DotProduct(x: Vec3, y: Vec3): number {
  return x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
}

export function VectorSubtract(a: Vec3, b: Vec3, c: Vec3): void {
  c[0] = a[0] - b[0];
  c[1] = a[1] - b[1];
  c[2] = a[2] - b[2];
}

export function VectorAdd(a: Vec3, b: Vec3, c: Vec3): void {
  c[0] = a[0] + b[0];
  c[1] = a[1] + b[1];
  c[2] = a[2] + b[2];
}

export function VectorCopy(a: Vec3, b: Vec3): void {
  b[0] = a[0];
  b[1] = a[1];
  b[2] = a[2];
}

//============================================================================
// mathlib.c -- math primitives

function DEG2RAD(a: number): number {
  return (a * M_PI) / 180.0;
}

export function ProjectPointOnPlane(dst: Vec3, p: Vec3, normal: Vec3): void {
  const inv_denom = 1.0 / DotProduct(normal, normal);

  const d = DotProduct(normal, p) * inv_denom;

  const n = vec3();
  n[0] = normal[0] * inv_denom;
  n[1] = normal[1] * inv_denom;
  n[2] = normal[2] * inv_denom;

  dst[0] = p[0] - d * n[0];
  dst[1] = p[1] - d * n[1];
  dst[2] = p[2] - d * n[2];
}

/*
** assumes "src" is normalized
*/
export function PerpendicularVector(dst: Vec3, src: Vec3): void {
  let pos = 0;
  let minelem = 1.0;

  /*
  ** find the smallest magnitude axially aligned vector
  */
  for (let i = 0; i < 3; i++) {
    if (Math.abs(src[i]) < minelem) {
      pos = i;
      minelem = Math.abs(src[i]);
    }
  }
  const tempvec = vec3(0.0, 0.0, 0.0);
  tempvec[pos] = 1.0;

  /*
  ** project the point onto the plane defined by src
  */
  ProjectPointOnPlane(dst, tempvec, src);

  /*
  ** normalize the result
  */
  VectorNormalize(dst);
}

export function RotatePointAroundVector(dst: Vec3, dir: Vec3, point: Vec3, degrees: number): void {
  const vf = vec3();
  const vr = vec3();
  const vup = vec3();

  vf[0] = dir[0];
  vf[1] = dir[1];
  vf[2] = dir[2];

  PerpendicularVector(vr, dir);
  CrossProduct(vr, vf, vup);

  const m: Mat3 = [vec3(), vec3(), vec3()];
  m[0][0] = vr[0];
  m[1][0] = vr[1];
  m[2][0] = vr[2];

  m[0][1] = vup[0];
  m[1][1] = vup[1];
  m[2][1] = vup[2];

  m[0][2] = vf[0];
  m[1][2] = vf[1];
  m[2][2] = vf[2];

  const im: Mat3 = [vec3(m[0][0], m[0][1], m[0][2]), vec3(m[1][0], m[1][1], m[1][2]), vec3(m[2][0], m[2][1], m[2][2])];

  im[0][1] = m[1][0];
  im[0][2] = m[2][0];
  im[1][0] = m[0][1];
  im[1][2] = m[2][1];
  im[2][0] = m[0][2];
  im[2][1] = m[1][2];

  const zrot: Mat3 = [vec3(), vec3(), vec3()];
  zrot[0][0] = zrot[1][1] = zrot[2][2] = 1.0;

  zrot[0][0] = Math.cos(DEG2RAD(degrees));
  zrot[0][1] = Math.sin(DEG2RAD(degrees));
  zrot[1][0] = -Math.sin(DEG2RAD(degrees));
  zrot[1][1] = Math.cos(DEG2RAD(degrees));

  const tmpmat: Mat3 = [vec3(), vec3(), vec3()];
  const rot: Mat3 = [vec3(), vec3(), vec3()];
  R_ConcatRotations(m, zrot, tmpmat);
  R_ConcatRotations(tmpmat, im, rot);

  for (let i = 0; i < 3; i++) {
    dst[i] = rot[i][0] * point[0] + rot[i][1] * point[1] + rot[i][2] * point[2];
  }
}

/*-----------------------------------------------------------------*/

export function anglemod(a: number): number {
  a = (360.0 / 65536) * (Math.trunc(a * (65536 / 360.0)) & 65535);
  return a;
}

/*
==================
BOPS_Error

Split out like this for ASM to call.
==================
*/
export function BOPS_Error(): never {
  throw new Error("BoxOnPlaneSide:  Bad signbits");
}

/*
==================
BoxOnPlaneSide

Returns 1, 2, or 1 + 2
==================
*/
export function BoxOnPlaneSide(emins: Vec3, emaxs: Vec3, p: MplaneT): number {
  let dist1: number;
  let dist2: number;
  let sides: number;

  // general case
  switch (p.signbits) {
    case 0:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      break;
    case 1:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      break;
    case 2:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      break;
    case 3:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      break;
    case 4:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      break;
    case 5:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      break;
    case 6:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      break;
    case 7:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      break;
    default:
      dist1 = dist2 = 0; // shut up compiler
      BOPS_Error();
      break;
  }

  sides = 0;
  if (dist1 >= p.dist) sides = 1;
  if (dist2 < p.dist) sides |= 2;

  return sides;
}

export function BOX_ON_PLANE_SIDE(emins: Vec3, emaxs: Vec3, p: MplaneT): number {
  return p.type < 3 ? (p.dist <= emins[p.type] ? 1 : p.dist >= emaxs[p.type] ? 2 : 3) : BoxOnPlaneSide(emins, emaxs, p);
}

export function AngleVectors(angles: Vec3, forward: Vec3, right: Vec3, up: Vec3): void {
  let angle: number;

  angle = angles[YAW] * ((M_PI * 2) / 360);
  const sy = Math.sin(angle);
  const cy = Math.cos(angle);
  angle = angles[PITCH] * ((M_PI * 2) / 360);
  const sp = Math.sin(angle);
  const cp = Math.cos(angle);
  angle = angles[ROLL] * ((M_PI * 2) / 360);
  const sr = Math.sin(angle);
  const cr = Math.cos(angle);

  forward[0] = cp * cy;
  forward[1] = cp * sy;
  forward[2] = -sp;
  right[0] = -1 * sr * sp * cy + -1 * cr * -sy;
  right[1] = -1 * sr * sp * sy + -1 * cr * cy;
  right[2] = -1 * sr * cp;
  up[0] = cr * sp * cy + -sr * -sy;
  up[1] = cr * sp * sy + -sr * cy;
  up[2] = cr * cp;
}

export function VectorCompare(v1: Vec3, v2: Vec3): number {
  for (let i = 0; i < 3; i++) if (v1[i] !== v2[i]) return 0;

  return 1;
}

export function VectorMA(veca: Vec3, scale: number, vecb: Vec3, vecc: Vec3): void {
  vecc[0] = veca[0] + scale * vecb[0];
  vecc[1] = veca[1] + scale * vecb[1];
  vecc[2] = veca[2] + scale * vecb[2];
}

export function _DotProduct(v1: Vec3, v2: Vec3): number {
  return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
}

export function _VectorSubtract(veca: Vec3, vecb: Vec3, out: Vec3): void {
  out[0] = veca[0] - vecb[0];
  out[1] = veca[1] - vecb[1];
  out[2] = veca[2] - vecb[2];
}

export function _VectorAdd(veca: Vec3, vecb: Vec3, out: Vec3): void {
  out[0] = veca[0] + vecb[0];
  out[1] = veca[1] + vecb[1];
  out[2] = veca[2] + vecb[2];
}

export function _VectorCopy(vin: Vec3, out: Vec3): void {
  out[0] = vin[0];
  out[1] = vin[1];
  out[2] = vin[2];
}

export function CrossProduct(v1: Vec3, v2: Vec3, cross: Vec3): void {
  cross[0] = v1[1] * v2[2] - v1[2] * v2[1];
  cross[1] = v1[2] * v2[0] - v1[0] * v2[2];
  cross[2] = v1[0] * v2[1] - v1[1] * v2[0];
}

export function Length(v: Vec3): number {
  let length: number;

  length = 0;
  for (let i = 0; i < 3; i++) length += v[i] * v[i];
  length = Math.sqrt(length); // FIXME

  return length;
}

export function VectorNormalize(v: Vec3): number {
  let length: number;
  let ilength: number;

  length = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  length = Math.sqrt(length); // FIXME

  if (length) {
    ilength = 1 / length;
    v[0] *= ilength;
    v[1] *= ilength;
    v[2] *= ilength;
  }

  return length;
}

export function VectorInverse(v: Vec3): void {
  v[0] = -v[0];
  v[1] = -v[1];
  v[2] = -v[2];
}

export function VectorScale(vin: Vec3, scale: number, out: Vec3): void {
  out[0] = vin[0] * scale;
  out[1] = vin[1] * scale;
  out[2] = vin[2] * scale;
}

export function Q_log2(val: number): number {
  let answer = 0;
  while ((val >>= 1)) answer++;
  return answer;
}

//============================================================================
// float[3][3] and float[3][4] become arrays of rows.

export type Mat3 = [Vec3, Vec3, Vec3];
export type Mat3x4 = [Float32Array, Float32Array, Float32Array];

/*
================
R_ConcatRotations
================
*/
export function R_ConcatRotations(in1: Mat3, in2: Mat3, out: Mat3): void {
  out[0][0] = in1[0][0] * in2[0][0] + in1[0][1] * in2[1][0] + in1[0][2] * in2[2][0];
  out[0][1] = in1[0][0] * in2[0][1] + in1[0][1] * in2[1][1] + in1[0][2] * in2[2][1];
  out[0][2] = in1[0][0] * in2[0][2] + in1[0][1] * in2[1][2] + in1[0][2] * in2[2][2];
  out[1][0] = in1[1][0] * in2[0][0] + in1[1][1] * in2[1][0] + in1[1][2] * in2[2][0];
  out[1][1] = in1[1][0] * in2[0][1] + in1[1][1] * in2[1][1] + in1[1][2] * in2[2][1];
  out[1][2] = in1[1][0] * in2[0][2] + in1[1][1] * in2[1][2] + in1[1][2] * in2[2][2];
  out[2][0] = in1[2][0] * in2[0][0] + in1[2][1] * in2[1][0] + in1[2][2] * in2[2][0];
  out[2][1] = in1[2][0] * in2[0][1] + in1[2][1] * in2[1][1] + in1[2][2] * in2[2][1];
  out[2][2] = in1[2][0] * in2[0][2] + in1[2][1] * in2[1][2] + in1[2][2] * in2[2][2];
}

/*
================
R_ConcatTransforms
================
*/
export function R_ConcatTransforms(in1: Mat3x4, in2: Mat3x4, out: Mat3x4): void {
  out[0][0] = in1[0][0] * in2[0][0] + in1[0][1] * in2[1][0] + in1[0][2] * in2[2][0];
  out[0][1] = in1[0][0] * in2[0][1] + in1[0][1] * in2[1][1] + in1[0][2] * in2[2][1];
  out[0][2] = in1[0][0] * in2[0][2] + in1[0][1] * in2[1][2] + in1[0][2] * in2[2][2];
  out[0][3] = in1[0][0] * in2[0][3] + in1[0][1] * in2[1][3] + in1[0][2] * in2[2][3] + in1[0][3];
  out[1][0] = in1[1][0] * in2[0][0] + in1[1][1] * in2[1][0] + in1[1][2] * in2[2][0];
  out[1][1] = in1[1][0] * in2[0][1] + in1[1][1] * in2[1][1] + in1[1][2] * in2[2][1];
  out[1][2] = in1[1][0] * in2[0][2] + in1[1][1] * in2[1][2] + in1[1][2] * in2[2][2];
  out[1][3] = in1[1][0] * in2[0][3] + in1[1][1] * in2[1][3] + in1[1][2] * in2[2][3] + in1[1][3];
  out[2][0] = in1[2][0] * in2[0][0] + in1[2][1] * in2[1][0] + in1[2][2] * in2[2][0];
  out[2][1] = in1[2][0] * in2[0][1] + in1[2][1] * in2[1][1] + in1[2][2] * in2[2][1];
  out[2][2] = in1[2][0] * in2[0][2] + in1[2][1] * in2[1][2] + in1[2][2] * in2[2][2];
  out[2][3] = in1[2][0] * in2[0][3] + in1[2][1] * in2[1][3] + in1[2][2] * in2[2][3] + in1[2][3];
}

/*
===================
FloorDivMod

Returns mathematically correct (floor-based) quotient and remainder for
numer and denom, both of which should contain no fractional part. The
quotient must fit in 32 bits.
====================
*/

export interface FloorDivModResult {
  quotient: number;
  rem: number;
}

export function FloorDivMod(numer: number, denom: number): FloorDivModResult {
  let q: number;
  let r: number;
  let x: number;

  if (denom <= 0.0) throw new Error(`FloorDivMod: bad denominator ${denom}\n`);

  if (numer >= 0.0) {
    x = Math.floor(numer / denom);
    q = Math.trunc(x);
    r = Math.trunc(Math.floor(numer - x * denom));
  } else {
    //
    // perform operations with positive values, and fix mod to make floor-based
    //
    x = Math.floor(-numer / denom);
    q = -Math.trunc(x);
    r = Math.trunc(Math.floor(-numer - x * denom));
    if (r !== 0) {
      q--;
      r = Math.trunc(denom) - r;
    }
  }

  return { quotient: q, rem: r };
}

/*
===================
GreatestCommonDivisor
====================
*/
export function GreatestCommonDivisor(i1: number, i2: number): number {
  if (i1 > i2) {
    if (i2 === 0) return i1;
    return GreatestCommonDivisor(i2, i1 % i2);
  } else {
    if (i1 === 0) return i2;
    return GreatestCommonDivisor(i1, i2 % i1);
  }
}

/*
===================
Invert24To16

Inverts an 8.24 value to a 16.16 value
====================
*/

export function Invert24To16(val: Fixed16T): Fixed16T {
  if (val < 256) return 0xffffffff | 0;

  return Math.trunc((0x10000 * 0x1000000) / val + 0.5) | 0;
}
