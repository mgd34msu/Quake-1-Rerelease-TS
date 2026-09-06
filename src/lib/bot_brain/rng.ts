// The brain never calls Math.random: every decision that rolls a die takes
// its numbers from a `BotRandomT` the caller injects, so a fixed seed
// replays a bot's whole match exactly. src/bots seeds one generator per bot
// slot; the tests seed theirs by hand.

export interface BotRandomT {
  /** A float in [0, 1). */
  next(): number;
}

/**
 * Warm-up draws thrown away at construction, before the caller sees any of
 * them. xorshift32 mixes a seed's bits through its three shifts (13, 17, 5)
 * one call at a time, and a small seed's few set bits take several calls to
 * reach the whole 32-bit word: seeded 1 through 8, every one of them rolls
 * the same "true" out of its first two calls to `randomChance(rng, 25)`,
 * which skews anything gated on an early roll (a bot's character pick, its
 * attacker/defender split) whenever seeds are handed out as small sequential
 * integers rather than full-width random words. Measured against seed vs.
 * seed+1's state words, the two have converged to roughly half their bits
 * differing (full avalanche) by the fifth discarded call; eight keeps a
 * comfortable margin over that. This only changes what a given SEED produces
 * -- an unseeded generator's long-run behavior is the same either way -- so
 * every test and savegame that pins a seeded sequence's values gets new
 * ones.
 */
const WARMUP_DRAWS = 8;

/**
 * xorshift32. Chosen because its whole state is one 32-bit word, so a bot's
 * RNG position is trivially observable in a test and trivially serializable
 * into a savegame later.
 */
export class Xorshift32 implements BotRandomT {
  private state: number;

  constructor(seed: number) {
    // 0 is xorshift's fixed point; any seed that lands there is nudged off it.
    this.state = seed | 0 ? seed | 0 : 0x1a2b3c4d;
    for (let i = 0; i < WARMUP_DRAWS; i++) this.next();
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x |= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x |= 0;
    this.state = x;
    return (x >>> 0) / 0x100000000;
  }

  /** The current state word, for tests and for savegame round-trips. */
  peek(): number {
    return this.state;
  }
}

/** A float in [lo, hi). */
export function randomRange(rng: BotRandomT, lo: number, hi: number): number {
  return lo + rng.next() * (hi - lo);
}

/** An integer in [0, count). */
export function randomIndex(rng: BotRandomT, count: number): number {
  if (count <= 0) return 0;
  const i = Math.floor(rng.next() * count);
  return i >= count ? count - 1 : i;
}

/** True with probability `percent` out of 100, matching bots/*.txt's `chance` scale. */
export function randomChance(rng: BotRandomT, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return rng.next() * 100 < percent;
}
