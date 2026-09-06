// Q003 -- QW/client/md4.c ported to src/qw/md4.ts. RFC 1320 test vectors
// (the MD4 spec's own worked examples) plus Com_BlockChecksum's XOR-fold.
// Self-sufficient per rule 13: no shared state, nothing to reset.

import { describe, expect, test } from "bun:test";
import { MD4Ctx, MD4Init, MD4Update, MD4Final, Com_BlockChecksum, Com_BlockFullChecksum } from "../src/qw/md4";

function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function md4Digest(input: Uint8Array): Uint8Array {
  const ctx = new MD4Ctx();
  const digest = new Uint8Array(16);
  MD4Init(ctx);
  MD4Update(ctx, input, input.length);
  MD4Final(digest, ctx);
  return digest;
}

describe("MD4 (md4.c) against RFC 1320 test vectors", () => {
  test("MD4('') == 31d6cfe0d16ae931b73c59d7e0c089c0", () => {
    expect(toHex(md4Digest(bytesOf("")))).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
  });

  test("MD4('a') == bde52cb31de33e46245e05fbdbd6fb24", () => {
    expect(toHex(md4Digest(bytesOf("a")))).toBe("bde52cb31de33e46245e05fbdbd6fb24");
  });

  test("MD4('abc') == a448017aaf21d8525fc10ae87aa6729d", () => {
    expect(toHex(md4Digest(bytesOf("abc")))).toBe("a448017aaf21d8525fc10ae87aa6729d");
  });

  test("MD4('message digest') == d9130a8164549fe818874806e1c7014b", () => {
    expect(toHex(md4Digest(bytesOf("message digest")))).toBe("d9130a8164549fe818874806e1c7014b");
  });

  test("MD4('abcdefghijklmnopqrstuvwxyz') == d79e1c308aa5bbcdeea8ed63df412da9", () => {
    expect(toHex(md4Digest(bytesOf("abcdefghijklmnopqrstuvwxyz")))).toBe("d79e1c308aa5bbcdeea8ed63df412da9");
  });

  test("MD4('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') == 043f8582f241db351ce627e153e7f0e4", () => {
    expect(toHex(md4Digest(bytesOf("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")))).toBe(
      "043f8582f241db351ce627e153e7f0e4",
    );
  });

  test("MD4(80-digit repeating '1234567890') == e33b4ddc9c38f2199c3e7b164fcc0536", () => {
    expect(toHex(md4Digest(bytesOf("1234567890".repeat(8))))).toBe("e33b4ddc9c38f2199c3e7b164fcc0536");
  });

  test("a 200-byte input spanning multiple 64-byte transform blocks matches a second independent digest of the same bytes", () => {
    const input = new Uint8Array(200);
    for (let i = 0; i < input.length; i++) input[i] = i & 0xff;
    expect(toHex(md4Digest(input))).toBe(toHex(md4Digest(input)));
    // and does not degenerate to the empty-string digest
    expect(toHex(md4Digest(input))).not.toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
  });

  test("Com_BlockChecksum XOR-folds the same verified digest words", () => {
    const input = bytesOf("abc");
    const digest = md4Digest(input);
    expect(toHex(digest)).toBe("a448017aaf21d8525fc10ae87aa6729d");

    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
    const expected = (view.getInt32(0, true) ^ view.getInt32(4, true) ^ view.getInt32(8, true) ^ view.getInt32(12, true)) >>> 0;

    expect(Com_BlockChecksum(input, input.length)).toBe(expected);
  });

  test("Com_BlockFullChecksum writes the same 16-byte digest MD4Init/Update/Final produce", () => {
    const input = bytesOf("abc");
    const expected = md4Digest(input);

    const outbuf = new Uint8Array(16);
    Com_BlockFullChecksum(input, input.length, outbuf);

    expect(toHex(outbuf)).toBe(toHex(expected));
  });
});
