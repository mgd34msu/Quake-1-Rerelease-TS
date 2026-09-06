import { describe, expect, test } from "bun:test";
import {
  vec3,
  vec3_origin,
  nanmask,
  IS_NAN,
  M_PI,
  MplaneT,
  PLANE_X,
  PLANE_ANYZ,
  SIDE_FRONT,
  SIDE_BACK,
  SIDE_ON,
  DotProduct,
  _DotProduct,
  VectorSubtract,
  _VectorSubtract,
  VectorAdd,
  _VectorAdd,
  VectorCopy,
  _VectorCopy,
  VectorMA,
  VectorScale,
  VectorCompare,
  VectorInverse,
  VectorNormalize,
  CrossProduct,
  Length,
  Q_log2,
  anglemod,
  AngleVectors,
  BoxOnPlaneSide,
  BOX_ON_PLANE_SIDE,
  BOPS_Error,
  ProjectPointOnPlane,
  PerpendicularVector,
  RotatePointAroundVector,
  R_ConcatRotations,
  R_ConcatTransforms,
  FloorDivMod,
  GreatestCommonDivisor,
  Invert24To16,
  type Mat3,
  type Mat3x4,
} from "../src/common/mathlib";
import { PITCH, YAW, ROLL } from "../src/common/quakedef";

describe("vector macros", () => {
  test("DotProduct", () => {
    expect(DotProduct(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
    expect(_DotProduct(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
  });

  test("VectorAdd / VectorSubtract / VectorCopy", () => {
    const out = vec3();
    VectorAdd(vec3(1, 2, 3), vec3(4, 5, 6), out);
    expect(Array.from(out)).toEqual([5, 7, 9]);
    _VectorAdd(vec3(1, 2, 3), vec3(4, 5, 6), out);
    expect(Array.from(out)).toEqual([5, 7, 9]);

    VectorSubtract(vec3(1, 2, 3), vec3(4, 5, 6), out);
    expect(Array.from(out)).toEqual([-3, -3, -3]);
    _VectorSubtract(vec3(1, 2, 3), vec3(4, 5, 6), out);
    expect(Array.from(out)).toEqual([-3, -3, -3]);

    VectorCopy(vec3(7, 8, 9), out);
    expect(Array.from(out)).toEqual([7, 8, 9]);
    _VectorCopy(vec3(1, 1, 1), out);
    expect(Array.from(out)).toEqual([1, 1, 1]);
  });

  test("VectorMA / VectorScale / VectorInverse", () => {
    const out = vec3();
    VectorMA(vec3(1, 2, 3), 2, vec3(10, 20, 30), out);
    expect(Array.from(out)).toEqual([21, 42, 63]);

    VectorScale(vec3(1, 2, 3), 3, out);
    expect(Array.from(out)).toEqual([3, 6, 9]);

    const v = vec3(1, -2, 3);
    VectorInverse(v);
    expect(Array.from(v)).toEqual([-1, 2, -3]);
  });

  test("VectorCompare returns the C's int 0/1", () => {
    expect(VectorCompare(vec3(1, 2, 3), vec3(1, 2, 3))).toBe(1);
    expect(VectorCompare(vec3(1, 2, 3), vec3(1, 2, 4))).toBe(0);
  });

  test("CrossProduct", () => {
    const out = vec3();
    CrossProduct(vec3(1, 0, 0), vec3(0, 1, 0), out);
    expect(Array.from(out)).toEqual([0, 0, 1]);
    CrossProduct(vec3(0, 1, 0), vec3(0, 0, 1), out);
    expect(Array.from(out)).toEqual([1, 0, 0]);
  });

  test("Length and VectorNormalize", () => {
    expect(Length(vec3(3, 4, 0))).toBeCloseTo(5, 6);
    expect(Length(vec3(0, 0, 0))).toBe(0);

    const v = vec3(3, 4, 0);
    expect(VectorNormalize(v)).toBeCloseTo(5, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
    expect(v[2]).toBeCloseTo(0, 6);

    // a zero vector is left alone and reports length 0
    const z = vec3(0, 0, 0);
    expect(VectorNormalize(z)).toBe(0);
    expect(Array.from(z)).toEqual([0, 0, 0]);
  });

  test("vec3_origin is the zero vector", () => {
    expect(Array.from(vec3_origin)).toEqual([0, 0, 0]);
  });
});

describe("constants", () => {
  test("M_PI, nanmask, plane and side constants", () => {
    expect(M_PI).toBe(3.14159265358979323846);
    expect(nanmask).toBe(255 << 23);
    expect(PLANE_X).toBe(0);
    expect(PLANE_ANYZ).toBe(5);
    expect(SIDE_FRONT).toBe(0);
    expect(SIDE_BACK).toBe(1);
    expect(SIDE_ON).toBe(2);
    expect(PITCH).toBe(0);
    expect(YAW).toBe(1);
    expect(ROLL).toBe(2);
  });

  test("IS_NAN matches the C's exponent-mask test on a float", () => {
    expect(IS_NAN(NaN)).toBe(true);
    expect(IS_NAN(Infinity)).toBe(true);
    expect(IS_NAN(-Infinity)).toBe(true);
    expect(IS_NAN(0)).toBe(false);
    expect(IS_NAN(1)).toBe(false);
    expect(IS_NAN(-12345.5)).toBe(false);
  });
});

describe("Q_log2", () => {
  test("counts the shifts the C's while loop performs", () => {
    expect(Q_log2(1)).toBe(0);
    expect(Q_log2(2)).toBe(1);
    expect(Q_log2(3)).toBe(1);
    expect(Q_log2(8)).toBe(3);
    expect(Q_log2(255)).toBe(7);
    expect(Q_log2(256)).toBe(8);
    expect(Q_log2(0)).toBe(0);
  });
});

describe("anglemod", () => {
  test("quantizes to the C's 16-bit angle grid", () => {
    expect(anglemod(0)).toBe(0);
    expect(anglemod(90)).toBe(90);
    expect(anglemod(180)).toBe(180);
    expect(anglemod(270)).toBe(270);
    expect(anglemod(360)).toBe(0);
    expect(anglemod(450)).toBe(90);
    expect(anglemod(-90)).toBe(270);
  });

  test("keeps the C's quantization error rather than returning exact degrees", () => {
    expect(anglemod(-1)).toBe(359.000244140625);
    expect(anglemod(45.5)).toBe(45.4998779296875);
    expect(anglemod(1000)).toBe(279.99755859375);
  });
});

describe("AngleVectors", () => {
  test("zero angles: forward=+X, right=-Y, up=+Z", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(vec3(0, 0, 0), forward, right, up);
    expect(forward[0]).toBeCloseTo(1, 6);
    expect(forward[1]).toBeCloseTo(0, 6);
    expect(forward[2]).toBeCloseTo(0, 6);
    expect(right[0]).toBeCloseTo(0, 6);
    expect(right[1]).toBeCloseTo(-1, 6);
    expect(right[2]).toBeCloseTo(0, 6);
    expect(up[0]).toBeCloseTo(0, 6);
    expect(up[1]).toBeCloseTo(0, 6);
    expect(up[2]).toBeCloseTo(1, 6);
  });

  test("yaw=90: forward=+Y, right=+X, up=+Z", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    // angles are indexed [PITCH, YAW, ROLL]
    AngleVectors(vec3(0, 90, 0), forward, right, up);
    expect(forward[0]).toBeCloseTo(0, 6);
    expect(forward[1]).toBeCloseTo(1, 6);
    expect(forward[2]).toBeCloseTo(0, 6);
    expect(right[0]).toBeCloseTo(1, 6);
    expect(right[1]).toBeCloseTo(0, 6);
    expect(right[2]).toBeCloseTo(0, 6);
    expect(up[2]).toBeCloseTo(1, 6);
  });

  test("pitch=90 looks straight down (-Z), the C's sign convention", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(vec3(90, 0, 0), forward, right, up);
    expect(forward[0]).toBeCloseTo(0, 6);
    expect(forward[1]).toBeCloseTo(0, 6);
    expect(forward[2]).toBeCloseTo(-1, 6);
    expect(right[1]).toBeCloseTo(-1, 6);
    expect(up[0]).toBeCloseTo(1, 6);
  });

  test("roll=90 rolls right onto +Z and up onto +Y", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(vec3(0, 0, 90), forward, right, up);
    expect(forward[0]).toBeCloseTo(1, 6);
    expect(right[2]).toBeCloseTo(-1, 6);
    expect(up[1]).toBeCloseTo(-1, 6);
  });
});

describe("BoxOnPlaneSide", () => {
  // Independent reference: the switch in the C picks, per signbits, the box
  // corner that maximizes and the corner that minimizes dot(normal, corner).
  // Walking all eight corners computes the same two numbers without the table.
  function brute(emins: Float32Array, emaxs: Float32Array, p: MplaneT): number {
    let dist1 = -Infinity;
    let dist2 = Infinity;
    for (let i = 0; i < 8; i++) {
      const c = vec3(
        i & 1 ? emaxs[0] : emins[0],
        i & 2 ? emaxs[1] : emins[1],
        i & 4 ? emaxs[2] : emins[2],
      );
      const d = DotProduct(p.normal, c);
      if (d > dist1) dist1 = d;
      if (d < dist2) dist2 = d;
    }
    let sides = 0;
    if (dist1 >= p.dist) sides = 1;
    if (dist2 < p.dist) sides |= 2;
    return sides;
  }

  function planeFor(nx: number, ny: number, nz: number, dist: number): MplaneT {
    const p = new MplaneT();
    p.normal[0] = nx;
    p.normal[1] = ny;
    p.normal[2] = nz;
    p.dist = dist;
    // Mod_LoadPlanes: bits |= 1<<j for each normal[j] < 0
    let bits = 0;
    for (let j = 0; j < 3; j++) if (p.normal[j] < 0) bits |= 1 << j;
    p.signbits = bits;
    p.type = PLANE_ANYZ;
    return p;
  }

  test("all 8 signbits cases agree with an 8-corner brute-force check", () => {
    const boxes: Array<[Float32Array, Float32Array]> = [
      [vec3(-10, -10, -10), vec3(10, 10, 10)],
      [vec3(0, 0, 0), vec3(1, 2, 3)],
      [vec3(-64, -32, -16), vec3(-8, -4, -2)],
      [vec3(5, 5, 5), vec3(100, 200, 300)],
      [vec3(-1, -1, -1), vec3(-1, -1, -1)],
    ];
    const dists = [-500, -37.5, -1, 0, 1, 12.25, 500];

    let cases = 0;
    for (let signbits = 0; signbits < 8; signbits++) {
      const nx = (signbits & 1 ? -1 : 1) * 0.5773502691896258;
      const ny = (signbits & 2 ? -1 : 1) * 0.5773502691896258;
      const nz = (signbits & 4 ? -1 : 1) * 0.5773502691896258;
      for (const [emins, emaxs] of boxes) {
        for (const dist of dists) {
          const p = planeFor(nx, ny, nz, dist);
          expect(p.signbits).toBe(signbits);
          expect(BoxOnPlaneSide(emins, emaxs, p)).toBe(brute(emins, emaxs, p));
          cases++;
        }
      }
    }
    expect(cases).toBe(8 * boxes.length * dists.length);
  });

  test("straddling, in front and behind produce 3, 1 and 2", () => {
    const p = planeFor(1, 0, 0, 5);
    expect(BoxOnPlaneSide(vec3(10, -1, -1), vec3(20, 1, 1), p)).toBe(1);
    expect(BoxOnPlaneSide(vec3(-20, -1, -1), vec3(0, 1, 1), p)).toBe(2);
    expect(BoxOnPlaneSide(vec3(0, -1, -1), vec3(10, 1, 1), p)).toBe(3);
  });

  test("BOX_ON_PLANE_SIDE takes the fast axial path for type < 3", () => {
    const p = new MplaneT();
    p.normal[0] = 1;
    p.dist = 5;
    p.type = PLANE_X;
    p.signbits = 0;

    expect(BOX_ON_PLANE_SIDE(vec3(10, -10, -10), vec3(20, 10, 10), p)).toBe(1);
    expect(BOX_ON_PLANE_SIDE(vec3(-10, -10, -10), vec3(0, 10, 10), p)).toBe(2);
    expect(BOX_ON_PLANE_SIDE(vec3(0, -10, -10), vec3(10, 10, 10), p)).toBe(3);

    // and falls through to BoxOnPlaneSide for non-axial planes
    const q = planeFor(0.5773502691896258, 0.5773502691896258, 0.5773502691896258, 0);
    expect(BOX_ON_PLANE_SIDE(vec3(-1, -1, -1), vec3(1, 1, 1), q)).toBe(BoxOnPlaneSide(vec3(-1, -1, -1), vec3(1, 1, 1), q));
  });

  test("a bad signbits value reaches BOPS_Error", () => {
    const p = planeFor(1, 1, 1, 0);
    p.signbits = 9;
    expect(() => BoxOnPlaneSide(vec3(-1, -1, -1), vec3(1, 1, 1), p)).toThrow("BoxOnPlaneSide:  Bad signbits");
    expect(() => BOPS_Error()).toThrow("BoxOnPlaneSide:  Bad signbits");
  });
});

describe("ProjectPointOnPlane / PerpendicularVector", () => {
  test("projects onto the plane through the origin with the given normal", () => {
    const dst = vec3();
    ProjectPointOnPlane(dst, vec3(1, 2, 3), vec3(0, 0, 1));
    expect(dst[0]).toBeCloseTo(1, 6);
    expect(dst[1]).toBeCloseTo(2, 6);
    expect(dst[2]).toBeCloseTo(0, 6);
  });

  test("PerpendicularVector returns a unit vector orthogonal to src", () => {
    for (const src of [vec3(0, 0, 1), vec3(1, 0, 0), vec3(0, 1, 0)]) {
      const dst = vec3();
      PerpendicularVector(dst, src);
      expect(DotProduct(dst, src)).toBeCloseTo(0, 6);
      expect(Length(dst)).toBeCloseTo(1, 6);
    }
  });
});

describe("RotatePointAroundVector", () => {
  test("90 degrees about +Z takes +X to +Y and +Y to -X", () => {
    const dst = vec3();
    RotatePointAroundVector(dst, vec3(0, 0, 1), vec3(1, 0, 0), 90);
    expect(dst[0]).toBeCloseTo(0, 6);
    expect(dst[1]).toBeCloseTo(1, 6);
    expect(dst[2]).toBeCloseTo(0, 6);

    RotatePointAroundVector(dst, vec3(0, 0, 1), vec3(0, 1, 0), 90);
    expect(dst[0]).toBeCloseTo(-1, 6);
    expect(dst[1]).toBeCloseTo(0, 6);
    expect(dst[2]).toBeCloseTo(0, 6);
  });

  test("leaves a point on the axis untouched and preserves length", () => {
    const dst = vec3();
    RotatePointAroundVector(dst, vec3(0, 0, 1), vec3(0, 0, 5), 37);
    expect(dst[0]).toBeCloseTo(0, 5);
    expect(dst[1]).toBeCloseTo(0, 5);
    expect(dst[2]).toBeCloseTo(5, 5);

    RotatePointAroundVector(dst, vec3(0, 0, 1), vec3(3, 4, 0), 137);
    expect(Length(dst)).toBeCloseTo(5, 5);
  });

  test("360 degrees is the identity", () => {
    const dst = vec3();
    RotatePointAroundVector(dst, vec3(0, 0, 1), vec3(1, 2, 3), 360);
    expect(dst[0]).toBeCloseTo(1, 5);
    expect(dst[1]).toBeCloseTo(2, 5);
    expect(dst[2]).toBeCloseTo(3, 5);
  });
});

describe("R_ConcatRotations / R_ConcatTransforms", () => {
  test("multiplying by the identity reproduces the input", () => {
    const a: Mat3 = [vec3(1, 2, 3), vec3(4, 5, 6), vec3(7, 8, 9)];
    const ident: Mat3 = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    const out: Mat3 = [vec3(), vec3(), vec3()];
    R_ConcatRotations(a, ident, out);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
    expect(Array.from(out[1])).toEqual([4, 5, 6]);
    expect(Array.from(out[2])).toEqual([7, 8, 9]);
  });

  test("R_ConcatRotations composes two 90-degree yaw rotations into 180", () => {
    const rot90: Mat3 = [vec3(0, -1, 0), vec3(1, 0, 0), vec3(0, 0, 1)];
    const out: Mat3 = [vec3(), vec3(), vec3()];
    R_ConcatRotations(rot90, rot90, out);
    expect(Array.from(out[0])).toEqual([-1, 0, 0]);
    expect(Array.from(out[1])).toEqual([0, -1, 0]);
    expect(Array.from(out[2])).toEqual([0, 0, 1]);
  });

  test("R_ConcatTransforms accumulates the translation column", () => {
    const mkRow = (a: number, b: number, c: number, d: number): Float32Array => {
      const r = new Float32Array(4);
      r[0] = a;
      r[1] = b;
      r[2] = c;
      r[3] = d;
      return r;
    };
    // two pure translations compose additively
    const t1: Mat3x4 = [mkRow(1, 0, 0, 10), mkRow(0, 1, 0, 20), mkRow(0, 0, 1, 30)];
    const t2: Mat3x4 = [mkRow(1, 0, 0, 1), mkRow(0, 1, 0, 2), mkRow(0, 0, 1, 3)];
    const out: Mat3x4 = [mkRow(0, 0, 0, 0), mkRow(0, 0, 0, 0), mkRow(0, 0, 0, 0)];
    R_ConcatTransforms(t1, t2, out);
    expect(Array.from(out[0])).toEqual([1, 0, 0, 11]);
    expect(Array.from(out[1])).toEqual([0, 1, 0, 22]);
    expect(Array.from(out[2])).toEqual([0, 0, 1, 33]);
  });
});

describe("FloorDivMod", () => {
  test("positive numerator: plain truncating divide", () => {
    expect(FloorDivMod(7, 2)).toEqual({ quotient: 3, rem: 1 });
    expect(FloorDivMod(6, 3)).toEqual({ quotient: 2, rem: 0 });
    expect(FloorDivMod(0, 4)).toEqual({ quotient: 0, rem: 0 });
  });

  test("negative numerator: floor-based, so quotient rounds down and rem stays positive", () => {
    expect(FloorDivMod(-7, 2)).toEqual({ quotient: -4, rem: 1 });
    expect(FloorDivMod(-6, 3)).toEqual({ quotient: -2, rem: 0 });
    expect(FloorDivMod(-1, 4)).toEqual({ quotient: -1, rem: 3 });
  });

  test("quotient*denom + rem reconstructs the numerator", () => {
    for (const numer of [-97, -50, -7, -1, 0, 1, 7, 50, 97]) {
      for (const denom of [1, 2, 3, 7, 10]) {
        const { quotient, rem } = FloorDivMod(numer, denom);
        expect(quotient * denom + rem).toBe(numer);
        expect(rem).toBeGreaterThanOrEqual(0);
        expect(rem).toBeLessThan(denom);
      }
    }
  });

  test("a non-positive denominator is the C's Sys_Error case", () => {
    expect(() => FloorDivMod(10, 0)).toThrow("FloorDivMod: bad denominator 0");
    expect(() => FloorDivMod(10, -2)).toThrow("FloorDivMod: bad denominator -2");
  });
});

describe("GreatestCommonDivisor", () => {
  test("matches the C's recursive Euclid", () => {
    expect(GreatestCommonDivisor(12, 18)).toBe(6);
    expect(GreatestCommonDivisor(18, 12)).toBe(6);
    expect(GreatestCommonDivisor(17, 5)).toBe(1);
    expect(GreatestCommonDivisor(0, 9)).toBe(9);
    expect(GreatestCommonDivisor(9, 0)).toBe(9);
    expect(GreatestCommonDivisor(8, 8)).toBe(8);
  });
});

describe("Invert24To16", () => {
  test("saturates below 256 to the C's 0xFFFFFFFF, delivered as int -1", () => {
    expect(Invert24To16(0)).toBe(-1);
    expect(Invert24To16(1)).toBe(-1);
    expect(Invert24To16(255)).toBe(-1);
  });

  test("inverts an 8.24 value to 16.16", () => {
    // (double)0x10000 * (double)0x1000000 == 2^40
    expect(Invert24To16(1024)).toBe(1073741824); // 2^40 / 2^10 == 2^30
    expect(Invert24To16(65536)).toBe(16777216); // 2^40 / 2^16 == 2^24
    expect(Invert24To16(1048576)).toBe(1048576); // 2^40 / 2^20 == 2^20
    expect(Invert24To16(1000000)).toBe(1099512);
  });

  test("val in [256,512] overflows int, where the C's double->int cast is undefined", () => {
    // documented divergence: JS `| 0` wraps modulo 2^32; x86 would yield INT_MIN.
    // mathlib.c's version is the !id386 fallback and has no C caller.
    expect(Invert24To16(256)).toBe(0);
  });
});
