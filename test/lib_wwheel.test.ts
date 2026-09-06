// Tests for src/lib/wwheel.ts (a clean-room reader for the 2021
// re-release's weapon-wheel layout file, wwheel.txt -- see that file's
// header comment for the grammar). Self-sufficient per PORTING.md rule 13:
// section 1 builds every fixture inline. Section 2 is a guarded smoke test
// against the REAL retail wwheel.txt files (id1, mg3, ctf), extracted with
// test/support/pak_reader.ts.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { parseWwheel } from "../src/lib/wwheel";
import { PakFile } from "./support/pak_reader";

// ---------------------------------------------------------------------------
// Section 1: synthetic input
// ---------------------------------------------------------------------------

describe("wwheel.ts -- synthetic input", () => {
  test("parses a slot block with every known field", () => {
    const text = `
slot 0
{
    impulse     2
    icon        "gfx/weapons/ww_shotgun1_1.lmp"
    icon_sel    "gfx/weapons/ww_shotgun1_2.lmp"
    ammoicon    "sb_shells"
    entvaroffs  216
    weaponnum   1
}
`;
    const result = parseWwheel(text);
    expect(result.errors).toEqual([]);
    expect(result.slots.length).toBe(1);
    const slot = result.slots[0]!;
    expect(slot.slot).toBe(0);
    expect(slot.impulse).toBe(2);
    expect(slot.icon).toBe("gfx/weapons/ww_shotgun1_1.lmp");
    expect(slot.iconSel).toBe("gfx/weapons/ww_shotgun1_2.lmp");
    expect(slot.ammoicon).toBe("sb_shells");
    expect(slot.entvaroffs).toBe(216);
    expect(slot.weaponnum).toBe(1);
  });

  test("a slot may omit ammoicon/entvaroffs (the axe slot in every retail file does)", () => {
    const text = `
slot 7
{
    impulse     1
    weaponnum   4096
    icon        "gfx/weapons/ww_axe_1.lmp"
    icon_sel    "gfx/weapons/ww_axe_2.lmp"
}
`;
    const result = parseWwheel(text);
    expect(result.errors).toEqual([]);
    const slot = result.slots[0]!;
    expect(slot.ammoicon).toBeUndefined();
    expect(slot.entvaroffs).toBeUndefined();
    expect(slot.weaponnum).toBe(4096);
  });

  test("preserves slot order across multiple slots", () => {
    const text = `
slot 2
{
    impulse 4
}

slot 0
{
    impulse 2
}
`;
    const result = parseWwheel(text);
    expect(result.slots.map((s) => s.slot)).toEqual([2, 0]);
  });

  test("a header that isn't \"slot N\" is reported and the block is skipped", () => {
    const result = parseWwheel(`weapon 0\n{\n  impulse 2\n}\n`);
    expect(result.slots).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/not "slot N"/);
  });

  test("an unknown key is kept verbatim in .unknown and reported, not thrown", () => {
    const result = parseWwheel(`slot 0\n{\n  impulse 2\n  future_field 1 2 3\n}\n`);
    expect(result.slots.length).toBe(1);
    expect(result.slots[0]!.unknown).toEqual({ future_field: ["1", "2", "3"] });
    expect(result.errors.some((e) => e.includes('unknown wwheel key "future_field"'))).toBe(true);
  });

  test("a non-numeric field value is reported, not thrown, and the field is left unset", () => {
    const result = parseWwheel(`slot 0\n{\n  impulse notanumber\n}\n`);
    expect(result.slots[0]!.impulse).toBeUndefined();
    expect(result.errors.some((e) => e.includes('"impulse" expects a single number'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 2: guarded retail-file tests
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;

function pakGuard(dir: string): { pakPath: string; have: boolean } {
  const pakPath = `${RERELEASE_DATA_DIR}/${dir}/pak0.pak`;
  return { pakPath, have: existsSync(pakPath) };
}

const id1 = pakGuard("id1");
const mg3 = pakGuard("mg3");
const ctf = pakGuard("ctf");

describe.skipIf(!id1.have)("wwheel.ts -- real retail id1/wwheel.txt", () => {
  test("8 slots (0-7), no parse errors, no unrecognized keys", () => {
    const pak = new PakFile(id1.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    expect(result.errors).toEqual([]);
    expect(result.slots.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.slots.every((s) => Object.keys(s.unknown).length === 0)).toBe(true);
  });

  test("slot 0 is the shotgun (impulse 2, weaponnum 1)", () => {
    const pak = new PakFile(id1.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    const slot0 = result.slots.find((s) => s.slot === 0)!;
    expect(slot0.impulse).toBe(2);
    expect(slot0.weaponnum).toBe(1);
    expect(slot0.ammoicon).toBe("sb_shells");
  });

  test("slot 7 (axe) has no ammoicon/entvaroffs", () => {
    const pak = new PakFile(id1.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    const axe = result.slots.find((s) => s.slot === 7)!;
    expect(axe.ammoicon).toBeUndefined();
    expect(axe.entvaroffs).toBeUndefined();
    expect(axe.weaponnum).toBe(4096);
  });
});

describe.skipIf(!mg3.have)("wwheel.ts -- real retail mg3/wwheel.txt (extra laser slot)", () => {
  test("9 slots, no parse errors", () => {
    const pak = new PakFile(mg3.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    expect(result.errors).toEqual([]);
    expect(result.slots.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("slot 7 is the added laser weapon (large weaponnum bit)", () => {
    const pak = new PakFile(mg3.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    const laser = result.slots.find((s) => s.slot === 7)!;
    expect(laser.weaponnum).toBe(8388608);
  });
});

describe.skipIf(!ctf.have)("wwheel.ts -- real retail ctf/wwheel.txt (extra grapple slot)", () => {
  test("9 slots, no parse errors", () => {
    const pak = new PakFile(ctf.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    expect(result.errors).toEqual([]);
    expect(result.slots.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("slot 8 is the grapple hook (weaponnum 128)", () => {
    const pak = new PakFile(ctf.pakPath);
    const result = parseWwheel(pak.readText("wwheel.txt"));
    const grapple = result.slots.find((s) => s.slot === 8)!;
    expect(grapple.weaponnum).toBe(128);
  });
});
