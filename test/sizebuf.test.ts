import { describe, expect, test, beforeEach } from "bun:test";
import { SysError } from "../src/platform/sys";
import {
  SizeBuf,
  SZ_Alloc,
  SZ_Clear,
  SZ_GetSpace,
  SZ_Write,
  SZ_Print,
  MSG_WriteChar,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteFloat,
  MSG_WriteString,
  MSG_WriteCoord,
  MSG_WriteAngle,
  MSG_BeginReading,
  MSG_ReadChar,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadFloat,
  MSG_ReadString,
  MSG_ReadCoord,
  MSG_ReadAngle,
  net_message,
  msgState,
} from "../src/common/sizebuf";

// Points net_message at `buf`'s written bytes and starts a fresh read, the
// way net_main.c's packet receive path hands a filled sizebuf_t to the
// MSG_Read* functions.
function beginReadingFrom(buf: SizeBuf): void {
  net_message.data = buf.data;
  net_message.maxsize = buf.maxsize;
  net_message.cursize = buf.cursize;
  MSG_BeginReading();
}

describe("SizeBuf / SZ_*", () => {
  test("SZ_Alloc clamps startsize to a 256 byte minimum", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 10);
    expect(buf.maxsize).toBe(256);
    expect(buf.data.length).toBe(256);
    expect(buf.cursize).toBe(0);

    const buf2 = new SizeBuf();
    SZ_Alloc(buf2, 1000);
    expect(buf2.maxsize).toBe(1000);
  });

  test("SZ_GetSpace advances cursize and returns the prior offset", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);
    const o1 = SZ_GetSpace(buf, 4);
    expect(o1).toBe(0);
    const o2 = SZ_GetSpace(buf, 3);
    expect(o2).toBe(4);
    expect(buf.cursize).toBe(7);
  });

  test("SZ_Write copies exactly `length` bytes at the current offset", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);
    SZ_Write(buf, new Uint8Array([1, 2, 3, 4, 5]), 3);
    expect(Array.from(buf.data.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(buf.cursize).toBe(3);
  });

  test("SZ_Clear resets cursize without touching allocated data", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);
    SZ_Write(buf, new Uint8Array([9, 9]), 2);
    SZ_Clear(buf);
    expect(buf.cursize).toBe(0);
    expect(buf.data.length).toBe(256);
  });

  test("SZ_GetSpace overflow with allowoverflow=false throws (Sys_Error)", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);
    buf.allowoverflow = false;
    expect(() => SZ_GetSpace(buf, 300)).toThrow(SysError);
  });

  test("SZ_GetSpace overflow with allowoverflow=true clears and sets overflowed", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);
    buf.allowoverflow = true;
    SZ_Write(buf, new Uint8Array([1, 2, 3]), 3);
    expect(buf.cursize).toBe(3);

    // requesting more than maxsize-cursize but <= maxsize overflows,
    // clears, then writes fresh from offset 0
    const offset = SZ_GetSpace(buf, 254);
    expect(buf.overflowed).toBe(true);
    expect(offset).toBe(0);
    expect(buf.cursize).toBe(254);
  });

  test("SZ_GetSpace: length > maxsize always throws, even with allowoverflow", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);
    buf.allowoverflow = true;
    expect(() => SZ_GetSpace(buf, 9999)).toThrow(SysError);
  });

  test("SZ_Print appends the string plus NUL, or overwrites a trailing NUL", () => {
    const buf = new SizeBuf();
    SZ_Alloc(buf, 256);

    SZ_Print(buf, "abc"); // buf.cursize was 0 (data[-1] undefined -> falsy) -> full append
    expect(buf.cursize).toBe(4); // "abc\0"
    expect(Array.from(buf.data.subarray(0, 4))).toEqual([97, 98, 99, 0]);

    SZ_Print(buf, "de"); // trailing 0 present -> write over it
    expect(buf.cursize).toBe(6); // "abcde\0"
    expect(Array.from(buf.data.subarray(0, 6))).toEqual([97, 98, 99, 100, 101, 0]);
  });
});

describe("MSG_Write*/MSG_Read* roundtrip", () => {
  let buf: SizeBuf;

  beforeEach(() => {
    buf = new SizeBuf();
    SZ_Alloc(buf, 4096);
    net_message.data = new Uint8Array(0);
    net_message.maxsize = 0;
    net_message.cursize = 0;
    msgState.readcount = 0;
    msgState.badread = false;
  });

  test("MSG_WriteChar/MSG_ReadChar roundtrip, including negative values", () => {
    for (const v of [0, 1, -1, 127, -128, 63, -64]) {
      const b = new SizeBuf();
      SZ_Alloc(b, 16);
      MSG_WriteChar(b, v);
      beginReadingFrom(b);
      expect(MSG_ReadChar()).toBe(v);
      expect(msgState.badread).toBe(false);
    }
  });

  test("MSG_WriteByte/MSG_ReadByte roundtrip", () => {
    for (const v of [0, 1, 128, 255]) {
      const b = new SizeBuf();
      SZ_Alloc(b, 16);
      MSG_WriteByte(b, v);
      beginReadingFrom(b);
      expect(MSG_ReadByte()).toBe(v);
    }
  });

  test("MSG_WriteShort/MSG_ReadShort roundtrip, including negative shorts", () => {
    for (const v of [0, 1, -1, 32767, -32768, -12345, 12345]) {
      const b = new SizeBuf();
      SZ_Alloc(b, 16);
      MSG_WriteShort(b, v);
      beginReadingFrom(b);
      expect(MSG_ReadShort()).toBe(v);
    }
  });

  test("MSG_WriteLong/MSG_ReadLong roundtrip, including negative longs", () => {
    for (const v of [0, 1, -1, 2147483647, -2147483648, -123456789, 123456789]) {
      const b = new SizeBuf();
      SZ_Alloc(b, 16);
      MSG_WriteLong(b, v);
      beginReadingFrom(b);
      expect(MSG_ReadLong()).toBe(v);
    }
  });

  test("MSG_WriteFloat/MSG_ReadFloat roundtrip (single precision)", () => {
    for (const v of [0, 1, -1, 3.5, -3.5, 123.25, -0.0001220703125]) {
      const b = new SizeBuf();
      SZ_Alloc(b, 16);
      MSG_WriteFloat(b, v);
      beginReadingFrom(b);
      expect(MSG_ReadFloat()).toBeCloseTo(v, 5);
    }
  });

  test("MSG_WriteString/MSG_ReadString roundtrip, plain ASCII", () => {
    MSG_WriteString(buf, "hello world");
    beginReadingFrom(buf);
    expect(MSG_ReadString()).toBe("hello world");
  });

  test("MSG_WriteString/MSG_ReadString roundtrip with embedded high bytes (Latin-1, not UTF-8)", () => {
    // Quake's colored/high-bit character set: bytes 0x80..0xfe round-trip
    // as-is through charCodeAt & 0xff / fromCharCode, never as UTF-8. (0xff
    // is excluded here -- see the dedicated quirk test below.)
    const s = String.fromCharCode(0x81, 0x9f, 0xa0, 0xfe, 65, 0x80);
    MSG_WriteString(buf, s);
    beginReadingFrom(buf);
    const out = MSG_ReadString();
    expect(out).toBe(s);
    expect(out.charCodeAt(0)).toBe(0x81);
    expect(out.charCodeAt(3)).toBe(0xfe);
  });

  test("a 0xff byte reads back as MSG_ReadChar's -1 sentinel and truncates MSG_ReadString", () => {
    // (signed char)0xff == -1, the same value MSG_ReadChar returns for "no
    // more data" -- MSG_ReadString's `c == -1` check cannot tell them apart.
    // This is the C's actual behavior (exactly as the original), not a porting bug.
    const s = String.fromCharCode(65, 66, 0xff, 67, 68);
    MSG_WriteString(buf, s);
    beginReadingFrom(buf);
    expect(MSG_ReadString()).toBe("AB");
  });

  test("MSG_WriteString(null) writes a single NUL byte, reads back as empty string", () => {
    MSG_WriteString(buf, null);
    expect(buf.cursize).toBe(1);
    expect(buf.data[0]).toBe(0);
    beginReadingFrom(buf);
    expect(MSG_ReadString()).toBe("");
  });

  test("MSG_ReadString stops at the first NUL even if more bytes follow", () => {
    SZ_Write(buf, new Uint8Array([104, 105, 0, 106, 107]), 5); // "hi\0jk"
    beginReadingFrom(buf);
    expect(MSG_ReadString()).toBe("hi");
  });

  test("MSG_ReadString truncates at 2047 characters (sizeof(string)-1)", () => {
    const long = "a".repeat(3000);
    MSG_WriteString(buf, long);
    beginReadingFrom(buf);
    const out = MSG_ReadString();
    expect(out.length).toBe(2047);
    expect(out).toBe("a".repeat(2047));
  });

  test("MSG_WriteCoord/MSG_ReadCoord: (int)(f*8) truncation", () => {
    // 1.99*8 = 15.92 -> (int) truncates to 15 -> read back as 15/8 = 1.875
    const b = new SizeBuf();
    SZ_Alloc(b, 16);
    MSG_WriteCoord(b, 1.99);
    beginReadingFrom(b);
    expect(MSG_ReadCoord()).toBeCloseTo(1.875, 6);
  });

  test("MSG_WriteCoord/MSG_ReadCoord: negative value truncation", () => {
    // -1.99*8 = -15.92 -> (int) truncates toward zero to -15 -> -15/8 = -1.875
    const b = new SizeBuf();
    SZ_Alloc(b, 16);
    MSG_WriteCoord(b, -1.99);
    beginReadingFrom(b);
    expect(MSG_ReadCoord()).toBeCloseTo(-1.875, 6);
  });

  test("MSG_WriteAngle/MSG_ReadAngle: ((int)f*256/360) & 255 truncation", () => {
    // (int)45.9 = 45; 45*256/360 = 32 (exact); read back 32*(360/256) = 45
    const b = new SizeBuf();
    SZ_Alloc(b, 16);
    MSG_WriteAngle(b, 45.9);
    beginReadingFrom(b);
    expect(MSG_ReadAngle()).toBeCloseTo(45, 6);
  });

  test("MSG_WriteAngle/MSG_ReadAngle: negative angle wraps through & 255", () => {
    // (int)(-10) = -10; -10*256/360 = -7.11 -> (int) truncates to -7;
    // -7 & 255 = 249 (byte); read back as signed char 249-256=-7 -> -7*(360/256) = -9.84375
    const b = new SizeBuf();
    SZ_Alloc(b, 16);
    MSG_WriteAngle(b, -10);
    beginReadingFrom(b);
    expect(MSG_ReadAngle()).toBeCloseTo(-9.84375, 6);
  });

  test("MSG_ReadChar/Byte/Short/Long set msg_badread and return -1 past cursize", () => {
    const b = new SizeBuf();
    SZ_Alloc(b, 16);
    MSG_WriteByte(b, 42); // cursize = 1
    beginReadingFrom(b);

    expect(MSG_ReadByte()).toBe(42);
    expect(msgState.badread).toBe(false);

    expect(MSG_ReadByte()).toBe(-1); // nothing left
    expect(msgState.badread).toBe(true);
  });

  test("MSG_BeginReading resets readcount and badread", () => {
    const b = new SizeBuf();
    SZ_Alloc(b, 16);
    MSG_WriteByte(b, 1);
    beginReadingFrom(b);
    MSG_ReadByte();
    MSG_ReadByte(); // triggers badread
    expect(msgState.badread).toBe(true);

    MSG_BeginReading();
    expect(msgState.readcount).toBe(0);
    expect(msgState.badread).toBe(false);
  });

  test("multiple values in sequence roundtrip through one buffer", () => {
    MSG_WriteByte(buf, 7);
    MSG_WriteShort(buf, -1000);
    MSG_WriteLong(buf, 99999);
    MSG_WriteString(buf, "seq");
    MSG_WriteFloat(buf, 2.5);

    beginReadingFrom(buf);
    expect(MSG_ReadByte()).toBe(7);
    expect(MSG_ReadShort()).toBe(-1000);
    expect(MSG_ReadLong()).toBe(99999);
    expect(MSG_ReadString()).toBe("seq");
    expect(MSG_ReadFloat()).toBeCloseTo(2.5, 6);
    expect(msgState.badread).toBe(false);
  });
});
