// The blend fraction both renderers' lerp sites compute from a start time,
// an end time and the current client time. QuakeSpasm/Ironwail's r_alias.c
// writes each one as `CLAMP (0, (cl.time - start) / (end - start), 1)`, whose
// C double division by a zero span yields an infinity or a NaN that CLAMP's
// two `<`/`>` comparisons both fail, letting it reach the transform. A span
// of zero arrives here from real retail data -- a re-release server's
// U_LERPFINISH byte can put `lerpfinish` exactly on `movelerpstart`, and an
// ALIAS_GROUP subframe interval can round to zero -- so the degenerate span
// is resolved once, here, as "the blend is already over" (1) rather than at
// each call site.
export function lerpFraction(now: number, start: number, end: number): number {
  const span = end - start;
  if (!(span > 0)) return 1;
  const frac = (now - start) / span;
  if (Number.isNaN(frac)) return 1;
  if (frac <= 0) return 0;
  if (frac >= 1) return 1;
  return frac;
}
