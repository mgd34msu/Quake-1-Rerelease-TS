/*
Copyright (C) 1996-1997 Id Software, Inc.
Ported from QW/client/md4.c (GNU GPL v2 or later), which itself embeds RSA
Data Security, Inc.'s MD4 Message-Digest Algorithm reference implementation
(Copyright (C) 1990-2, RSA Data Security, Inc. -- see the license text kept
in the C source, reproduced in this unit's report).

Q003. Copied from ../quake-2-ts/src/qcommon/md4.ts, which is byte-identical
to QW's algorithm (RFC 1320 MD4, the same MD4Init/MD4Update/MD4Final/
MD4Transform/Encode/Decode bodies, confirmed by diffing both C sources) --
adapted only for QW's own header/module framing. UINT4 (32-bit unsigned)
fields are Uint32Array elements so that stores truncate mod 2^32 the same
way the C `unsigned long`/`int` fields did.

Deviations from the C source:
- Com_BlockFullChecksum (`void Com_BlockFullChecksum (void *buffer, int len,
  unsigned char *outbuf)`) is ported as a thin wrapper: MD4Init/MD4Update/
  MD4Final into the caller-supplied 16-byte `outbuf`, exactly as the C does.
*/

/* Constants for MD4Transform routine. */
const S11 = 3;
const S12 = 7;
const S13 = 11;
const S14 = 19;
const S21 = 3;
const S22 = 5;
const S23 = 9;
const S24 = 13;
const S31 = 3;
const S32 = 9;
const S33 = 11;
const S34 = 15;

// PADDING[0] = 0x80, rest zero -- matches the C static initializer.
const PADDING = new Uint8Array(64);
PADDING[0] = 0x80;

/* MD4 context. */
export class MD4Ctx {
  readonly state: Uint32Array; // state (ABCD)
  readonly count: Uint32Array; // number of bits, modulo 2^64 (lsb first)
  readonly buffer: Uint8Array; // input buffer

  constructor() {
    this.state = new Uint32Array(4);
    this.count = new Uint32Array(2);
    this.buffer = new Uint8Array(64);
  }
}

/* F, G and H are basic MD4 functions. */
function F(x: number, y: number, z: number): number {
  return ((x & y) | (~x & z)) >>> 0;
}
function G(x: number, y: number, z: number): number {
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}
function H(x: number, y: number, z: number): number {
  return (x ^ y ^ z) >>> 0;
}

/* ROTATE_LEFT rotates x left n bits. */
function ROTATE_LEFT(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/* FF, GG and HH are transformations for rounds 1, 2 and 3. */
/* Rotation is separate from addition to prevent recomputation. */
function FF(a: number, b: number, c: number, d: number, x: number, s: number): number {
  return ROTATE_LEFT((a + F(b, c, d) + x) >>> 0, s);
}

function GG(a: number, b: number, c: number, d: number, x: number, s: number): number {
  return ROTATE_LEFT((a + G(b, c, d) + x + 0x5a827999) >>> 0, s);
}

function HH(a: number, b: number, c: number, d: number, x: number, s: number): number {
  return ROTATE_LEFT((a + H(b, c, d) + x + 0x6ed9eba1) >>> 0, s);
}

/* MD4 initialization. Begins an MD4 operation, writing a new context. */
export function MD4Init(context: MD4Ctx): void {
  context.count[0] = 0;
  context.count[1] = 0;

  /* Load magic initialization constants. */
  context.state[0] = 0x67452301;
  context.state[1] = 0xefcdab89;
  context.state[2] = 0x98badcfe;
  context.state[3] = 0x10325476;
}

/* Decodes input (unsigned char) into output (UINT4). Assumes len is a multiple of 4. */
function Decode(output: Uint32Array, input: Uint8Array, len: number): void {
  let i = 0;
  for (let j = 0; j < len; i++, j += 4) {
    output[i] = (input[j] | (input[j + 1] << 8) | (input[j + 2] << 16) | (input[j + 3] << 24)) >>> 0;
  }
}

/* Encodes input (UINT4) into output (unsigned char). Assumes len is a multiple of 4. */
function Encode(output: Uint8Array, input: Uint32Array, len: number): void {
  let i = 0;
  for (let j = 0; j < len; i++, j += 4) {
    output[j] = input[i] & 0xff;
    output[j + 1] = (input[i] >>> 8) & 0xff;
    output[j + 2] = (input[i] >>> 16) & 0xff;
    output[j + 3] = (input[i] >>> 24) & 0xff;
  }
}

/* MD4 basic transformation. Transforms state based on block. */
function MD4Transform(state: Uint32Array, block: Uint8Array): void {
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  const x = new Uint32Array(16);

  Decode(x, block, 64);

  /* Round 1 */
  a = FF(a, b, c, d, x[0], S11); /* 1 */
  d = FF(d, a, b, c, x[1], S12); /* 2 */
  c = FF(c, d, a, b, x[2], S13); /* 3 */
  b = FF(b, c, d, a, x[3], S14); /* 4 */
  a = FF(a, b, c, d, x[4], S11); /* 5 */
  d = FF(d, a, b, c, x[5], S12); /* 6 */
  c = FF(c, d, a, b, x[6], S13); /* 7 */
  b = FF(b, c, d, a, x[7], S14); /* 8 */
  a = FF(a, b, c, d, x[8], S11); /* 9 */
  d = FF(d, a, b, c, x[9], S12); /* 10 */
  c = FF(c, d, a, b, x[10], S13); /* 11 */
  b = FF(b, c, d, a, x[11], S14); /* 12 */
  a = FF(a, b, c, d, x[12], S11); /* 13 */
  d = FF(d, a, b, c, x[13], S12); /* 14 */
  c = FF(c, d, a, b, x[14], S13); /* 15 */
  b = FF(b, c, d, a, x[15], S14); /* 16 */

  /* Round 2 */
  a = GG(a, b, c, d, x[0], S21); /* 17 */
  d = GG(d, a, b, c, x[4], S22); /* 18 */
  c = GG(c, d, a, b, x[8], S23); /* 19 */
  b = GG(b, c, d, a, x[12], S24); /* 20 */
  a = GG(a, b, c, d, x[1], S21); /* 21 */
  d = GG(d, a, b, c, x[5], S22); /* 22 */
  c = GG(c, d, a, b, x[9], S23); /* 23 */
  b = GG(b, c, d, a, x[13], S24); /* 24 */
  a = GG(a, b, c, d, x[2], S21); /* 25 */
  d = GG(d, a, b, c, x[6], S22); /* 26 */
  c = GG(c, d, a, b, x[10], S23); /* 27 */
  b = GG(b, c, d, a, x[14], S24); /* 28 */
  a = GG(a, b, c, d, x[3], S21); /* 29 */
  d = GG(d, a, b, c, x[7], S22); /* 30 */
  c = GG(c, d, a, b, x[11], S23); /* 31 */
  b = GG(b, c, d, a, x[15], S24); /* 32 */

  /* Round 3 */
  a = HH(a, b, c, d, x[0], S31); /* 33 */
  d = HH(d, a, b, c, x[8], S32); /* 34 */
  c = HH(c, d, a, b, x[4], S33); /* 35 */
  b = HH(b, c, d, a, x[12], S34); /* 36 */
  a = HH(a, b, c, d, x[2], S31); /* 37 */
  d = HH(d, a, b, c, x[10], S32); /* 38 */
  c = HH(c, d, a, b, x[6], S33); /* 39 */
  b = HH(b, c, d, a, x[14], S34); /* 40 */
  a = HH(a, b, c, d, x[1], S31); /* 41 */
  d = HH(d, a, b, c, x[9], S32); /* 42 */
  c = HH(c, d, a, b, x[5], S33); /* 43 */
  b = HH(b, c, d, a, x[13], S34); /* 44 */
  a = HH(a, b, c, d, x[3], S31); /* 45 */
  d = HH(d, a, b, c, x[11], S32); /* 46 */
  c = HH(c, d, a, b, x[7], S33); /* 47 */
  b = HH(b, c, d, a, x[15], S34); /* 48 */

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;

  /* Zeroize sensitive information. */
  x.fill(0);
}

/* MD4 block update operation. Continues an MD4 message-digest operation,
   processing another message block, and updating the context. */
export function MD4Update(context: MD4Ctx, input: Uint8Array, inputLen: number): void {
  /* Compute number of bytes mod 64 */
  let index = (context.count[0] >>> 3) & 0x3f;

  /* Update number of bits */
  const inputLenBits = (inputLen << 3) >>> 0;
  context.count[0] = context.count[0] + inputLenBits;
  if (context.count[0] < inputLenBits) {
    context.count[1] = context.count[1] + 1;
  }

  context.count[1] = context.count[1] + (inputLen >>> 29);

  const partLen = 64 - index;

  /* Transform as many times as possible. */
  let i: number;
  if (inputLen >= partLen) {
    context.buffer.set(input.subarray(0, partLen), index);
    MD4Transform(context.state, context.buffer);

    for (i = partLen; i + 63 < inputLen; i += 64) {
      MD4Transform(context.state, input.subarray(i, i + 64));
    }

    index = 0;
  } else {
    i = 0;
  }

  /* Buffer remaining input */
  context.buffer.set(input.subarray(i, inputLen), index);
}

/* MD4 finalization. Ends an MD4 message-digest operation, writing the
   message digest and zeroizing the context. */
export function MD4Final(digest: Uint8Array, context: MD4Ctx): void {
  const bits = new Uint8Array(8);

  /* Save number of bits */
  Encode(bits, context.count, 8);

  /* Pad out to 56 mod 64. */
  const index = (context.count[0] >>> 3) & 0x3f;
  const padLen = index < 56 ? 56 - index : 120 - index;
  MD4Update(context, PADDING, padLen);

  /* Append length (before padding) */
  MD4Update(context, bits, 8);

  /* Store state in digest */
  Encode(digest, context.state, 16);

  /* Zeroize sensitive information. */
  context.state.fill(0);
  context.count.fill(0);
  context.buffer.fill(0);
}

//===================================================================

export function Com_BlockChecksum(buffer: Uint8Array, length: number): number {
  const ctx = new MD4Ctx();
  const digest = new Uint8Array(16);

  MD4Init(ctx);
  MD4Update(ctx, buffer, length);
  MD4Final(digest, ctx);

  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const d0 = view.getInt32(0, true);
  const d1 = view.getInt32(4, true);
  const d2 = view.getInt32(8, true);
  const d3 = view.getInt32(12, true);

  return (d0 ^ d1 ^ d2 ^ d3) >>> 0;
}

export function Com_BlockFullChecksum(buffer: Uint8Array, len: number, outbuf: Uint8Array): void {
  const ctx = new MD4Ctx();

  MD4Init(ctx);
  MD4Update(ctx, buffer, len);
  MD4Final(outbuf, ctx);
}
