// Whether the real Quake data test/support/*_fixture.ts (and the several
// test files that build an equivalent scratch basedir inline, following the
// same recipe) actually finds on disk. CI -- and any checkout with no
// sibling ../qsrc/quake tree and no retail basedir -- has none of it: a
// suite that needs one of these booleans checks it and skips itself,
// instead of a fixture builder's `if (!existsSync(...)) throw` firing
// inside a beforeAll bun cannot skip around.
//
// Mirrors test/e2e/q1data.ts's own Q1TS_QSRC / Q1TS_DATA resolution, minus
// the throw.

import { existsSync } from "node:fs";

/** `../qsrc/quake` by default -- the same resolution every `*_fixture.ts` builder (and every test file with its own inline PROGS_DAT/QWPROGS_DAT constant) uses. */
export const QSRC_DIR = process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../../qsrc/quake`;

export const PROGS106_DAT = `${QSRC_DIR}/progs106/progs.dat`;
export const QWPROGS_DAT = `${QSRC_DIR}/QW/progs/qwprogs.dat`;

/** progs106/progs.dat is reachable under Q1TS_QSRC (or its default). */
export const HAVE_PROGS106 = existsSync(PROGS106_DAT);

/** QW/progs/qwprogs.dat is reachable under Q1TS_QSRC (or its default). */
export const HAVE_QWPROGS = existsSync(QWPROGS_DAT);

/** A retail basedir is set via Q1TS_DATA (test/e2e/q1data.ts's own variable) and actually holds an id1/. */
export const HAVE_DATA = ((): boolean => {
  const dir = process.env.Q1TS_DATA;
  if (dir === undefined || dir === "") return false;
  return existsSync(`${dir}/id1`) || existsSync(`${dir}/Id1`);
})();
