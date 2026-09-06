// Tests for src/lib/md5_model.ts (lifted from quake-2-re-ts
// src/qcommon/md5_model.ts at 7e88015, itself a port of q2repro's MD5
// skeletal model loader). See md5_model.ts's own header comment for the
// full decoupling writeup (inlined vector/quaternion math, Q1's own
// "beside the .mdl" file-discovery convention, the dropped .md5scale
// sidecar) and the Quake 1 mapping rules it documents (shader-to-skin
// naming, frame-index mapping, flags reuse).
//
// Three groups:
//
// 1. A synthetic minimal mesh+anim (one joint, one triangle, two frames)
//    with hand-computed expected skinned positions and normals -- the
//    arithmetic is worked out in this file's own comments, not just
//    round-tripped through the module's own code.
//
// 2. Error paths: malformed MD5Version, out-of-range counts, a vertex
//    whose weight range overruns numweights, a mismatched anim/mesh
//    numJoints, and a hierarchy entry whose parent isn't already built.
//
// 3. Guarded retail-data tests against the REAL Quake 1 re-release MD5
//    files, extracted from .../qfiles/q1/rerelease/{id1,mg3}/pak0.pak with
//    test/support/pak_reader_md5.ts (this SCOPE's own pak reader --
//    test/support/pak_reader.ts didn't exist when this unit started).
//    Skips itself when the retail install isn't present, mirroring every
//    other guarded retail test in this suite (test/lib_loc.test.ts's own
//    header comment documents the same existsSync-guard idiom). Parses
//    every progs/*.md5mesh + progs/*.md5anim pair in both paks (59 mesh
//    files / 58 anim files in id1, 5 pairs in mg3 -- see md5_model.ts's
//    header comment for the one mesh-without-anim exception,
//    progs/health100.md5mesh) and skins dog's frame 0 against the bounds
//    its own .md5anim declares.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  parseMd5Mesh,
  parseMd5Anim,
  calcSkelVert,
  md5Skin,
  frameJointsAt,
  createJointPose,
  buildFramePose,
  md5PathsFor,
  loadMd5Model,
  vec3,
  MD5_VERTEX_STRIDE,
  type Md5ModelT,
} from "../src/lib/md5_model";
import { Md5FormatError } from "../src/lib/errors";
import { openPak, readPakText, type OpenPak } from "./support/pak_reader_md5";

// ---------------------------------------------------------------------------
// Section 1: synthetic fixture -- one joint, one triangle, two frames
// ---------------------------------------------------------------------------

// Bind pose (mesh's own "joints" block) and both anim frames give joint0
// orientation (0,0,0) -- Quat_ComputeW(0,0,0) computes w = -sqrt(1-0) = -1,
// and Quat_ToAxis(x=0,y=0,z=0,w=-1) is the identity matrix (substituting
// directly into the formula: row0=(2*(1+0)-1, 0, 0)=(1,0,0), row1=(0,1,0),
// row2=(0,0,1)) -- so every rotation in this fixture is a no-op and only
// joint position (animated from frame 0 -> frame 1) and vertex weight
// offsets determine the skinned result.
//
// Weights: vertex 0/1/2 each bind 100% (bias 1.0) to joint0 at offsets
// (1,0,0)/(0,1,0)/(0,0,1). calcSkelVert's result is
// `VectorRotateByAxis(weight.pos, identity) + joint.pos`, scaled by bias
// 1.0 -- with identity rotation this is just `weight.pos + joint.pos`.
//
// joint0's *animated* position: frame 0 leaves it at the baseframe value
// (0,0,0); frame 1 moves it to (10,0,0) (numAnimatedComponents 3 = only
// position x/y/z animated, hierarchy flags 7 = bits 0|1|2).
//   frame 0: vert0=(1,0,0)+  (0,0,0)=(1,0,0); vert1=(0,1,0); vert2=(0,0,1)
//   frame 1: vert0=(1,0,0)+(10,0,0)=(11,0,0); vert1=(10,1,0); vert2=(10,0,1)
//
// Normals (MD5_ComputeNormals, bind pose only -- computed once at mesh
// parse time, independent of anim frame): the bind-pose world positions
// equal the weight offsets themselves (same identity-rotation, zero-joint-
// position reasoning as above) -- (1,0,0)/(0,1,0)/(0,0,1), the single
// triangle's own three corners. Its face normal is
// normalize(cross(v2-v0, v1-v0)) = normalize(cross((-1,0,1),(-1,1,0)))
// = normalize(-0.5,-0.5,-0.5) = (-1,-1,-1)/sqrt(3) -- exactly, since a
// single triangle contributes only one direction to each of its corners
// (the angle-weight scalar and the vertex-count normalization don't change
// direction). 1/sqrt(3) = 0.5773502691896258, so every vertex's normal is
// (-0.57735, -0.57735, -0.57735), unchanged across frames since joint
// orientation never animates in this fixture.
const SYNTHETIC_MESH = `MD5Version 10
commandline ""

numJoints 1
numMeshes 1

joints {
  "joint0" -1 ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

mesh {
  shader "test"

  numverts 3
  vert 0 ( 0.0 0.0 ) 0 1
  vert 1 ( 0.0 0.0 ) 1 1
  vert 2 ( 0.0 0.0 ) 2 1

  numtris 1
  tri 0 0 1 2

  numweights 3
  weight 0 0 1.0 ( 1.0 0.0 0.0 )
  weight 1 0 1.0 ( 0.0 1.0 0.0 )
  weight 2 0 1.0 ( 0.0 0.0 1.0 )
}
`;

const SYNTHETIC_ANIM = `MD5Version 10
commandline ""

numFrames 2
numJoints 1
frameRate 24
numAnimatedComponents 3

hierarchy {
  "joint0" -1 7 0
}

bounds {
  ( -1.0 -1.0 -1.0 ) ( 1.0 1.0 1.0 )
  ( 9.0 -1.0 -1.0 ) ( 11.0 1.0 1.0 )
}

baseframe {
  ( 0.0 0.0 0.0 ) ( 0.0 0.0 0.0 )
}

frame 0 {
  0.0 0.0 0.0
}

frame 1 {
  10.0 0.0 0.0
}
`;

const NEG_INV_SQRT3 = -1 / Math.sqrt(3);

function parseSynthetic(): Md5ModelT {
  const model = parseMd5Mesh(SYNTHETIC_MESH, "synthetic.md5mesh");
  parseMd5Anim(SYNTHETIC_ANIM, "synthetic.md5anim", model);
  return model;
}

describe("md5_model.ts -- synthetic fixture (one joint, one triangle, two frames)", () => {
  test("parses joint/mesh/frame counts", () => {
    const model = parseSynthetic();
    expect(model.numJoints).toBe(1);
    expect(model.numMeshes).toBe(1);
    expect(model.numFrames).toBe(2);
    expect(model.meshes[0].numVerts).toBe(3);
    expect(model.meshes[0].numIndices).toBe(3);
    expect(model.meshes[0].numWeights).toBe(3);
    expect(model.meshes[0].shader).toBe("test");
  });

  test("bind-pose normals: all three vertices get (-1,-1,-1)/sqrt(3), hand-derived above", () => {
    const model = parseSynthetic();
    for (const vert of model.meshes[0].vertices) {
      expect(vert.normal[0]).toBeCloseTo(NEG_INV_SQRT3, 4);
      expect(vert.normal[1]).toBeCloseTo(NEG_INV_SQRT3, 4);
      expect(vert.normal[2]).toBeCloseTo(NEG_INV_SQRT3, 4);
    }
  });

  test("frame 0: calcSkelVert reproduces the raw weight offsets (joint at origin, identity orientation)", () => {
    const model = parseSynthetic();
    const mesh = model.meshes[0];
    const joints = frameJointsAt(model, 0);
    const pos = vec3();
    const normal = vec3();

    calcSkelVert(mesh.vertices[0], mesh, joints, pos, normal);
    expect(pos[0]).toBeCloseTo(1, 5);
    expect(pos[1]).toBeCloseTo(0, 5);
    expect(pos[2]).toBeCloseTo(0, 5);
    expect(normal[0]).toBeCloseTo(NEG_INV_SQRT3, 4);

    calcSkelVert(mesh.vertices[1], mesh, joints, pos, normal);
    expect(pos[0]).toBeCloseTo(0, 5);
    expect(pos[1]).toBeCloseTo(1, 5);
    expect(pos[2]).toBeCloseTo(0, 5);

    calcSkelVert(mesh.vertices[2], mesh, joints, pos, normal);
    expect(pos[0]).toBeCloseTo(0, 5);
    expect(pos[1]).toBeCloseTo(0, 5);
    expect(pos[2]).toBeCloseTo(1, 5);
  });

  test("frame 1: joint0 has translated to (10,0,0) -- every vertex shifts by that offset", () => {
    const model = parseSynthetic();
    const mesh = model.meshes[0];
    const joints = frameJointsAt(model, 1);
    const pos = vec3();
    const normal = vec3();

    calcSkelVert(mesh.vertices[0], mesh, joints, pos, normal);
    expect(pos[0]).toBeCloseTo(11, 5);
    expect(pos[1]).toBeCloseTo(0, 5);
    expect(pos[2]).toBeCloseTo(0, 5);

    calcSkelVert(mesh.vertices[1], mesh, joints, pos, normal);
    expect(pos[0]).toBeCloseTo(10, 5);
    expect(pos[1]).toBeCloseTo(1, 5);
    expect(pos[2]).toBeCloseTo(0, 5);

    calcSkelVert(mesh.vertices[2], mesh, joints, pos, normal);
    expect(pos[0]).toBeCloseTo(10, 5);
    expect(pos[1]).toBeCloseTo(0, 5);
    expect(pos[2]).toBeCloseTo(1, 5);
  });

  test("md5Skin fills the interleaved position+normal buffer for all vertices, allocation-free (reused pose + reused out buffer)", () => {
    const model = parseSynthetic();
    const mesh = model.meshes[0];
    const pose = createJointPose(model);
    const out = new Float32Array(mesh.numVerts * MD5_VERTEX_STRIDE);

    buildFramePose(model, 0, 0, 0, 1, pose);
    md5Skin(mesh, pose, out);
    expect(Array.from(out.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(out.subarray(6, 9))).toEqual([0, 1, 0]);
    expect(Array.from(out.subarray(12, 15))).toEqual([0, 0, 1]);
    expect(out[3]).toBeCloseTo(NEG_INV_SQRT3, 4);

    // reuse the SAME pose + out buffers for frame 1 -- proves the per-frame
    // path really is allocation-free (no fresh arrays needed between calls).
    buildFramePose(model, 1, 1, 0, 1, pose);
    md5Skin(mesh, pose, out);
    expect(Array.from(out.subarray(0, 3))).toEqual([11, 0, 0]);
    expect(Array.from(out.subarray(6, 9))).toEqual([10, 1, 0]);
    expect(Array.from(out.subarray(12, 15))).toEqual([10, 0, 1]);
  });

  test("buildFramePose lerped halfway between frame 0 and frame 1 interpolates joint position linearly", () => {
    const model = parseSynthetic();
    const mesh = model.meshes[0];
    const pose = createJointPose(model);
    buildFramePose(model, 0, 1, 0.5, 0.5, pose);
    const out = new Float32Array(mesh.numVerts * MD5_VERTEX_STRIDE);
    md5Skin(mesh, pose, out);
    // joint0 at (5,0,0) halfway between (0,0,0) and (10,0,0)
    expect(out[0]).toBeCloseTo(6, 4); // vert0 = (1,0,0) + (5,0,0)
    expect(out[6]).toBeCloseTo(5, 4); // vert1 = (0,1,0) + (5,0,0)
  });

  test("loadMd5Model orchestrates mesh+anim parsing in one call", () => {
    const model = loadMd5Model(SYNTHETIC_MESH, "synthetic.md5mesh", SYNTHETIC_ANIM, "synthetic.md5anim");
    expect(model.numJoints).toBe(1);
    expect(model.numFrames).toBe(2);
  });

  test("md5PathsFor: Quake 1's own convention -- same directory/basename, extension swap, no subdirectory", () => {
    expect(md5PathsFor("progs/dog.mdl")).toEqual({ meshPath: "progs/dog.md5mesh", animPath: "progs/dog.md5anim" });
    expect(md5PathsFor("progs/boss.mdl")).toEqual({ meshPath: "progs/boss.md5mesh", animPath: "progs/boss.md5anim" });
  });
});

// ---------------------------------------------------------------------------
// Section 2: error paths
// ---------------------------------------------------------------------------

describe("md5_model.ts -- error paths (Md5FormatError)", () => {
  test("wrong MD5Version throws", () => {
    const bad = SYNTHETIC_MESH.replace("MD5Version 10", "MD5Version 11");
    expect(() => parseMd5Mesh(bad, "bad.md5mesh")).toThrow(Md5FormatError);
  });

  test("numJoints below the minimum (0) throws", () => {
    const bad = SYNTHETIC_MESH.replace("numJoints 1", "numJoints 0");
    expect(() => parseMd5Mesh(bad, "bad.md5mesh")).toThrow(Md5FormatError);
  });

  test("a vertex whose weight start/count overruns numweights throws", () => {
    const bad = SYNTHETIC_MESH.replace("vert 2 ( 0.0 0.0 ) 2 1", "vert 2 ( 0.0 0.0 ) 2 5");
    expect(() => parseMd5Mesh(bad, "bad.md5mesh")).toThrow(Md5FormatError);
  });

  test("a weight's joint index out of range throws (parseUintTok's own max bound: model.numJoints - 1)", () => {
    const bad = SYNTHETIC_MESH.replace("weight 0 0 1.0", "weight 0 3 1.0");
    expect(() => parseMd5Mesh(bad, "bad.md5mesh")).toThrow(Md5FormatError);
  });

  test("a triangle index >= numverts throws", () => {
    const bad = SYNTHETIC_MESH.replace("tri 0 0 1 2", "tri 0 0 1 9");
    expect(() => parseMd5Mesh(bad, "bad.md5mesh")).toThrow(Md5FormatError);
  });

  test("anim numJoints mismatched against the mesh's own numJoints throws", () => {
    const model = parseMd5Mesh(SYNTHETIC_MESH, "synthetic.md5mesh");
    const bad = SYNTHETIC_ANIM.replace("numJoints 1", "numJoints 2");
    expect(() => parseMd5Anim(bad, "bad.md5anim", model)).toThrow(Md5FormatError);
  });

  test("a hierarchy entry whose parent index isn't already built (parent >= i) throws", () => {
    const model = parseMd5Mesh(SYNTHETIC_MESH, "synthetic.md5mesh");
    // joint0 is index 0; giving it itself as parent (0 >= 0) is invalid.
    const bad = SYNTHETIC_ANIM.replace('"joint0" -1 7 0', '"joint0" 0 7 0');
    expect(() => parseMd5Anim(bad, "bad.md5anim", model)).toThrow(Md5FormatError);
  });

  test("a malformed token where a brace was expected throws with a diagnostic message", () => {
    const bad = SYNTHETIC_MESH.replace("joints {", "joints [");
    expect(() => parseMd5Mesh(bad, "bad.md5mesh")).toThrow(/expected "\{"/);
  });
});

// ---------------------------------------------------------------------------
// Section 3: guarded retail-data tests
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const ID1_PAK0 = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const MG3_PAK0 = `${RERELEASE_DATA_DIR}/mg3/pak0.pak`;
const HAVE_ID1 = existsSync(ID1_PAK0);
const HAVE_MG3 = existsSync(MG3_PAK0);

interface Md5PairResult {
  base: string;
  model: Md5ModelT;
  hasAnim: boolean;
  animParsed: boolean;
}

// mg3/progs/ogre_rocket is a REAL, genuinely broken pair shipped in the
// retail data: its .md5mesh declares numJoints 55, its .md5anim declares
// numJoints 39 -- see md5_model.ts's own header comment, mapping rule 5,
// for the full writeup (including why Ironwail itself would also reject
// this exact pair and fall back to progs/ogre_rocket.mdl). Every other
// mesh+anim pair in both paks has matching joint counts.
const KNOWN_JOINT_COUNT_MISMATCH = new Set(["progs/ogre_rocket"]);

function parseAllMd5Pairs(pak: OpenPak): Md5PairResult[] {
  const meshEntries = pak.entries.filter((e) => e.name.endsWith(".md5mesh"));
  const animNames = new Set(pak.entries.filter((e) => e.name.endsWith(".md5anim")).map((e) => e.name));
  const results: Md5PairResult[] = [];

  for (const entry of meshEntries) {
    const base = entry.name.slice(0, -".md5mesh".length);
    const meshText = readPakText(pak, entry.name);
    const model = parseMd5Mesh(meshText, entry.name);

    const animName = `${base}.md5anim`;
    const hasAnim = animNames.has(animName);
    let animParsed = false;
    if (hasAnim) {
      const animText = readPakText(pak, animName);
      const animNumJointsMatch = animText.match(/numJoints\s+(\d+)/);
      expect(animNumJointsMatch).not.toBeNull();
      const animNumJoints = Number(animNumJointsMatch![1]);

      if (KNOWN_JOINT_COUNT_MISMATCH.has(base)) {
        // Confirm the real mismatch is still there (so this doesn't go
        // silently stale if the retail data is ever updated), and that
        // parseMd5Anim rejects it exactly as documented.
        expect(animNumJoints).not.toBe(model.numJoints);
        expect(() => parseMd5Anim(animText, animName, model)).toThrow(Md5FormatError);
      } else {
        // Independently confirm the mapping rule ("anim numJoints == mesh
        // numJoints") from the RAW anim text, not just by relying on
        // parseMd5Anim's own internal throw-on-mismatch behavior.
        expect(animNumJoints).toBe(model.numJoints);
        parseMd5Anim(animText, animName, model);
        animParsed = true;
      }
    }

    results.push({ base, model, hasAnim, animParsed });
  }

  return results;
}

describe.skipIf(!HAVE_ID1)("md5_model.ts -- real Quake 1 re-release MD5 data (id1/pak0.pak)", () => {
  const pak = HAVE_ID1 ? openPak(ID1_PAK0) : null;

  test("id1/pak0.pak carries 59 progs/*.md5mesh and 58 progs/*.md5anim files", () => {
    expect(pak).not.toBeNull();
    const meshCount = pak!.entries.filter((e) => e.name.endsWith(".md5mesh")).length;
    const animCount = pak!.entries.filter((e) => e.name.endsWith(".md5anim")).length;
    expect(meshCount).toBe(59);
    expect(animCount).toBe(58);
  });

  test("every progs/*.md5mesh(+.md5anim) pair parses with sane counts and every index in range", () => {
    const results = parseAllMd5Pairs(pak!);
    expect(results.length).toBe(59);
    // exactly one mesh (progs/health100) ships with no .md5anim -- see
    // md5_model.ts's header comment, mapping rule 1.
    expect(results.filter((r) => !r.hasAnim).length).toBe(1);
    expect(results.find((r) => !r.hasAnim)!.base).toBe("progs/health100");

    for (const { model, hasAnim } of results) {
      expect(model.numJoints).toBeGreaterThan(0);
      expect(model.numMeshes).toBeGreaterThan(0);
      if (hasAnim) expect(model.numFrames).toBeGreaterThan(0);

      for (const mesh of model.meshes) {
        expect(mesh.numVerts).toBeGreaterThan(0);
        for (const jointNum of mesh.jointnums) {
          expect(jointNum).toBeGreaterThanOrEqual(0);
          expect(jointNum).toBeLessThan(model.numJoints);
        }
        for (const idx of mesh.indices) {
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(mesh.numVerts);
        }
        for (const vert of mesh.vertices) {
          expect(vert.start + vert.count).toBeLessThanOrEqual(mesh.numWeights);
        }
      }
    }
  });

  test("dog: shader name equals the model's own basename (mapping rule 2)", () => {
    const meshText = readPakText(pak!, "progs/dog.md5mesh");
    const model = parseMd5Mesh(meshText, "progs/dog.md5mesh");
    expect(model.meshes[0].shader).toBe("dog");
  });

  test("dog: frame 0 skins to finite coordinates within the bounds its .md5anim declares (small float32 margin)", () => {
    const meshText = readPakText(pak!, "progs/dog.md5mesh");
    const animText = readPakText(pak!, "progs/dog.md5anim");
    const model = parseMd5Mesh(meshText, "progs/dog.md5mesh");
    parseMd5Anim(animText, "progs/dog.md5anim", model);
    expect(model.numJoints).toBe(27);
    expect(model.numFrames).toBe(86);

    // Frame 0's declared bounds are the FIRST "( min ) ( max )" pair inside
    // the anim's own "bounds { ... }" block -- extracted independently from
    // the raw text since the parser itself discards bounds (see
    // md5_model.ts's own comment on why: q2repro's own finding that they're
    // "usually wrong anyways").
    const boundsBlock = animText.match(/bounds\s*\{([\s\S]*?)\n\}/);
    expect(boundsBlock).not.toBeNull();
    const firstFrameBounds = boundsBlock![1].trim().split("\n")[0];
    const nums = firstFrameBounds.match(/-?\d+\.\d+/g)!.map(Number);
    expect(nums.length).toBe(6);
    const [minx, miny, minz, maxx, maxy, maxz] = nums;

    const pose = createJointPose(model);
    buildFramePose(model, 0, 0, 0, 1, pose);

    const margin = 0.05; // float32 round-trip noise, not a real bounds violation -- see verification below
    let checked = 0;
    for (const mesh of model.meshes) {
      const out = new Float32Array(mesh.numVerts * MD5_VERTEX_STRIDE);
      md5Skin(mesh, pose, out);
      for (let v = 0; v < mesh.numVerts; v++) {
        const px = out[v * MD5_VERTEX_STRIDE];
        const py = out[v * MD5_VERTEX_STRIDE + 1];
        const pz = out[v * MD5_VERTEX_STRIDE + 2];
        expect(Number.isFinite(px)).toBe(true);
        expect(Number.isFinite(py)).toBe(true);
        expect(Number.isFinite(pz)).toBe(true);
        expect(px).toBeGreaterThanOrEqual(minx - margin);
        expect(px).toBeLessThanOrEqual(maxx + margin);
        expect(py).toBeGreaterThanOrEqual(miny - margin);
        expect(py).toBeLessThanOrEqual(maxy + margin);
        expect(pz).toBeGreaterThanOrEqual(minz - margin);
        expect(pz).toBeLessThanOrEqual(maxz + margin);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("boss and ogre: real animated monsters parse with finite frame-0 skin output", () => {
    for (const name of ["boss", "ogre"]) {
      const meshText = readPakText(pak!, `progs/${name}.md5mesh`);
      const animText = readPakText(pak!, `progs/${name}.md5anim`);
      const model = parseMd5Mesh(meshText, `progs/${name}.md5mesh`);
      parseMd5Anim(animText, `progs/${name}.md5anim`, model);

      const pose = createJointPose(model);
      buildFramePose(model, 0, 0, 0, 1, pose);
      for (const mesh of model.meshes) {
        const out = new Float32Array(mesh.numVerts * MD5_VERTEX_STRIDE);
        md5Skin(mesh, pose, out);
        for (const v of out) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe.skipIf(!HAVE_MG3)("md5_model.ts -- real Quake 1 re-release MD5 data (mg3/pak0.pak, the 5 extra pairs)", () => {
  const pak = HAVE_MG3 ? openPak(MG3_PAK0) : null;

  test("mg3/pak0.pak carries exactly 5 progs/*.md5mesh + 5 progs/*.md5anim files", () => {
    expect(pak).not.toBeNull();
    const meshCount = pak!.entries.filter((e) => e.name.endsWith(".md5mesh")).length;
    const animCount = pak!.entries.filter((e) => e.name.endsWith(".md5anim")).length;
    expect(meshCount).toBe(5);
    expect(animCount).toBe(5);
  });

  test("every mg3 md5mesh/md5anim pair parses with sane counts and every index in range (ogre_rocket's anim is a known, intentionally-rejected mismatch)", () => {
    const results = parseAllMd5Pairs(pak!);
    expect(results.length).toBe(5);
    expect(results.every((r) => r.hasAnim)).toBe(true);
    expect(results.filter((r) => !r.animParsed).map((r) => r.base)).toEqual(["progs/ogre_rocket"]);

    for (const { model, animParsed } of results) {
      expect(model.numJoints).toBeGreaterThan(0);
      if (animParsed) expect(model.numFrames).toBeGreaterThan(0);
      for (const mesh of model.meshes) {
        for (const jointNum of mesh.jointnums) expect(jointNum).toBeLessThan(model.numJoints);
        for (const idx of mesh.indices) expect(idx).toBeLessThan(mesh.numVerts);
      }
    }
  });
});

describe.skipIf(HAVE_ID1 && HAVE_MG3)("md5_model.ts -- SKIPPED retail tests", () => {
  test("retail data not found -- set up .../qfiles/q1/rerelease/{id1,mg3}/pak0.pak (or Q1TS_RERELEASE_DATA) to run the guarded md5_model.ts tests", () => {
    expect(HAVE_ID1 && HAVE_MG3).toBe(false);
  });
});
