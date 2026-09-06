// Tests for src/lib/mapdb.ts (a clean-room reader for the 2021 re-release's
// mapdb.json -- see that file's header comment for the real schema this
// parses). Self-sufficient per PORTING.md rule 13: section 1 below builds
// every JSON fixture inline, no game data. Section 2 is a guarded smoke
// test against the REAL retail mapdb.json, extracted from
// .../rerelease/id1/pak0.pak with test/support/pak_reader.ts (guard idiom
// mirrors test/support/fixture_availability.ts and test/lib_kpf_smoke.test.ts).

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { parseMapdb } from "../src/lib/mapdb";
import { PakFile } from "./support/pak_reader";

// ---------------------------------------------------------------------------
// Section 1: synthetic input
// ---------------------------------------------------------------------------

describe("mapdb.ts -- synthetic input", () => {
  test("parses a well-formed minimal document", () => {
    const result = parseMapdb(
      JSON.stringify({
        episodes: [{ dir: "id1", name: "$m_quake" }],
        maps: [{ title: "Place of Two Deaths", bsp: "dm1", episode: "id1", game: "id1", dm: true, coop: false, bots: true, sp: false }],
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.mapdb.episodes).toEqual([{ dir: "id1", name: "$m_quake" }]);
    expect(result.mapdb.maps.length).toBe(1);
    const map = result.mapdb.maps[0]!;
    expect(map.title).toBe("Place of Two Deaths");
    expect(map.bsp).toBe("dm1");
    expect(map.episode).toBe("id1");
    expect(map.game).toBe("id1");
    expect(map.dm).toBe(true);
    expect(map.bots).toBe(true);
    expect(map.sp).toBe(false);
    expect(map.coop).toBe(false);
  });

  test("every flag field defaults to false when omitted", () => {
    const result = parseMapdb(JSON.stringify({ episodes: [], maps: [{ title: "t", bsp: "b", episode: "e", game: "g" }] }));
    expect(result.errors).toEqual([]);
    const map = result.mapdb.maps[0]!;
    expect(map.sp).toBe(false);
    expect(map.dm).toBe(false);
    expect(map.coop).toBe(false);
    expect(map.bots).toBe(false);
    expect(map.ctf).toBe(false);
    expect(map.horde).toBe(false);
  });

  test("a title starting with \"$\" is passed through verbatim (a localization key, not resolved here)", () => {
    const result = parseMapdb(JSON.stringify({ episodes: [], maps: [{ title: "$m_some_map", bsp: "b", episode: "e", game: "g" }] }));
    expect(result.errors).toEqual([]);
    expect(result.mapdb.maps[0]!.title).toBe("$m_some_map");
  });

  test("invalid JSON is reported, not thrown", () => {
    const result = parseMapdb("{ not json");
    expect(result.mapdb).toEqual({ episodes: [], maps: [] });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/invalid JSON/);
  });

  test("a non-object root is reported", () => {
    const result = parseMapdb(JSON.stringify([1, 2, 3]));
    expect(result.errors).toEqual(["root value is not an object"]);
  });

  test("missing \"episodes\"/\"maps\" arrays are reported but don't abort the whole parse", () => {
    const result = parseMapdb(JSON.stringify({}));
    expect(result.mapdb).toEqual({ episodes: [], maps: [] });
    expect(result.errors).toContain('"episodes" is missing or not an array');
    expect(result.errors).toContain('"maps" is missing or not an array');
  });

  test("a malformed map entry is skipped and reported, valid entries around it still parse", () => {
    const result = parseMapdb(
      JSON.stringify({
        episodes: [],
        maps: [{ title: "ok1", bsp: "b1", episode: "e", game: "g" }, { title: "missing bsp", episode: "e", game: "g" }, { title: "ok2", bsp: "b2", episode: "e", game: "g" }],
      }),
    );
    expect(result.mapdb.maps.map((m) => m.title)).toEqual(["ok1", "ok2"]);
    expect(result.errors.some((e) => e.includes("maps[1]"))).toBe(true);
  });

  test("a malformed episode entry (non-object) is skipped and reported", () => {
    const result = parseMapdb(JSON.stringify({ episodes: ["not an object", { dir: "id1", name: "n" }], maps: [] }));
    expect(result.mapdb.episodes).toEqual([{ dir: "id1", name: "n" }]);
    expect(result.errors).toEqual(["episodes[0]: not an object"]);
  });
});

// ---------------------------------------------------------------------------
// Section 2: guarded retail-file test
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const ID1_PAK = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const HAVE_ID1_PAK = existsSync(ID1_PAK);

describe.skipIf(!HAVE_ID1_PAK)("mapdb.ts -- real retail mapdb.json (id1/pak0.pak)", () => {
  const pak = HAVE_ID1_PAK ? new PakFile(ID1_PAK) : null;
  const result = pak ? parseMapdb(pak.readText("mapdb.json")) : null;

  test("parses cleanly with no errors", () => {
    expect(result!.errors).toEqual([]);
  });

  test("has exactly 6 episodes and 143 maps", () => {
    expect(result!.mapdb.episodes.length).toBe(6);
    expect(result!.mapdb.maps.length).toBe(143);
  });

  test("episode dirs are id1, hipnotic, rogue, dopa, mg1, mg3 in that order", () => {
    expect(result!.mapdb.episodes.map((e) => e.dir)).toEqual(["id1", "hipnotic", "rogue", "dopa", "mg1", "mg3"]);
  });

  test("dm4 (\"The Bad Place\") is a bots-enabled deathmatch map under id1", () => {
    const dm4 = result!.mapdb.maps.find((m) => m.bsp === "dm4" && m.game === "id1");
    expect(dm4).toBeDefined();
    expect(dm4!.title).toBe("The Bad Place");
    expect(dm4!.dm).toBe(true);
    expect(dm4!.bots).toBe(true);
    expect(dm4!.sp).toBe(false);
  });

  test("ctf maps are listed under episode \"id1\" with game \"ctf\" (episode is not an alias for game)", () => {
    const ctfMaps = result!.mapdb.maps.filter((m) => m.game === "ctf");
    expect(ctfMaps.length).toBe(9);
    expect(ctfMaps.every((m) => m.episode === "id1")).toBe(true);
    expect(ctfMaps.every((m) => m.ctf === true)).toBe(true);
  });
});
