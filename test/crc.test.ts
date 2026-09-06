import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  CRC_INIT_VALUE,
  CRC_XOR_VALUE,
  CRC_Init,
  CRC_ProcessByte,
  CRC_Value,
} from "../src/common/crc";

// Independent bitwise implementation of the same CRC (polynomial 0x1021,
// initial value 0xffff, xorout 0x0000, non-reflected -- the CCITT/XMODEM
// variant crc.c's table implements) used to check the table-driven module
// output without calling it.
function bitwiseCrc(bytes: readonly number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc ^ 0x0000;
}

describe("crc", () => {
  test("CRC_INIT_VALUE and CRC_XOR_VALUE match crc.c", () => {
    expect(CRC_INIT_VALUE).toBe(0xffff);
    expect(CRC_XOR_VALUE).toBe(0x0000);
  });

  test("CRC_Init returns CRC_INIT_VALUE", () => {
    expect(CRC_Init()).toBe(CRC_INIT_VALUE);
  });

  test("CRC of an empty stream equals CRC_Value(CRC_INIT_VALUE)", () => {
    const crc = CRC_Init();
    expect(CRC_Value(crc)).toBe(CRC_Value(CRC_INIT_VALUE));
    expect(CRC_Value(crc)).toBe(0xffff);
  });

  test("CRC of \"123456789\" matches an independent bitwise implementation", () => {
    const bytes = Array.from("123456789", (c) => c.charCodeAt(0));

    let crc = CRC_Init();
    for (const b of bytes) {
      crc = CRC_ProcessByte(crc, b);
    }
    const moduleValue = CRC_Value(crc);

    expect(moduleValue).toBe(bitwiseCrc(bytes));
  });

  // CRC_ProcessByte(0, i) == (0 << 8) ^ crctable[(0 >> 8) ^ i] == crctable[i],
  // since every table entry is already <= 0xffff. crctable is `static` in
  // crc.c (crc.h declares no accessor for it), so this is the only way to
  // check table entries without exporting something the C header doesn't.
  test("crctable's first 8 entries match crc.c verbatim", () => {
    const expected = [
      0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
    ];
    const actual = expected.map((_, i) => CRC_ProcessByte(0, i));
    expect(actual).toEqual(expected);
  });

  test("crctable's last 8 entries match crc.c verbatim", () => {
    const expected = [
      0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
    ];
    const actual = expected.map((_, i) => CRC_ProcessByte(0, 248 + i));
    expect(actual).toEqual(expected);
  });

  const progsPath = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;

  test("CRC of progs106/progs.dat matches the observed constant", () => {
    if (!existsSync(progsPath)) {
      // Fixture not present on this machine; PR_LoadProgs's CRC check has
      // nothing to verify against here.
      return;
    }

    const data = readFileSync(progsPath);
    expect(data.length).toBe(413116);

    let crc = CRC_Init();
    for (let i = 0; i < data.length; i++) {
      crc = CRC_ProcessByte(crc, data[i]!);
    }
    const value = CRC_Value(crc);

    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffff);
    // Observed value for this exact fixture (progs106/progs.dat, retail
    // version 6, 413116 bytes), computed the way PR_LoadProgs does.
    expect(value).toBe(24778);
  });
});
