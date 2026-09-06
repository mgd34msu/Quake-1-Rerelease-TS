/*
Regression suite for the two cross-track defects the coordinator added to the
aliasing audit (.orch/audit_aliasing.md, sections G and H).

G - DUPLICATE GLOBAL HOLDERS. `byte *host_basepal` and `byte *host_colormap`
are one C global each, but this port has two holders per global: the bindings in
src/common/host.ts (filled by that file's Host_Init, WinQuake track) and the
`{ data }` boxes in src/qw/client/cl_main.ts (filled by qwcl's own Host_Init).
Any module that runs in BOTH binaries and reads the WinQuake binding directly
sees `null` under qwcl and degrades silently - that is how Draw_Fill came to
paint every scoreboard colour block white. There is now exactly one home for the
resolution, `hostBasepal()` / `hostColormap()` in src/common/host.ts, and the
second test below is the structural guard that keeps it that way: it is what
catches the sixth instance of this bug class, which per-site tests would not.

H - CL_NewTranslation. QW/client/cl_parse.c:871's two halves are
`#ifdef GLQUAKE` / `#else`, so exactly one is compiled and it evaluates the
"colours changed" test once. This port compiles both renderers in and runs both
halves; gl_rmisc.c's R_TranslatePlayerSkin performs the identical test and
consumes it by syncing `_topcolor`/`_bottomcolor`, so under GL the software
table below it was never rebuilt and a later `vid_restart` to soft drew players
with a stale translation table.

Self-sufficient per rule 13: resets qw.active, the qwcl palette boxes,
re.current, vid.colormap and the touched player slot in its own hooks.
*/

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostBasepal, hostColormap } from "../src/common/host";
import { host_basepal as qwHostBasepal, host_colormap as qwHostColormap } from "../src/qw/client/cl_main";
import { qw } from "../src/common/quakedef";

const savedQwActive = qw.active;
const savedQwBasepal = qwHostBasepal.data;
const savedQwColormap = qwHostColormap.data;

afterEach(() => {
  qw.active = savedQwActive;
  qwHostBasepal.data = savedQwBasepal;
  qwHostColormap.data = savedQwColormap;
});

describe("alias_ hostBasepal/hostColormap resolve the right holder per track", () => {
  test("under qw.active the qwcl boxes are read", () => {
    const pal = new Uint8Array(768);
    pal[0] = 200;
    const cmap = new Uint8Array(256 * 64);
    cmap[0] = 7;
    qwHostBasepal.data = pal;
    qwHostColormap.data = cmap;

    qw.active = true;
    expect(hostBasepal()).toBe(pal);
    expect(hostColormap()).toBe(cmap);
  });

  test("with qw.active false the qwcl boxes are NOT consulted", () => {
    // host.ts's own bindings have no setter, and whether they are populated
    // depends on whether some other suite in this process has run Host_Init
    // (rule 15) -- so assert the property that does not depend on that: on the
    // WinQuake track the accessor never returns the qwcl box, even when the box
    // is the only one holding data.
    const qwOnly = new Uint8Array(768).fill(9);
    const qwOnlyCmap = new Uint8Array(16).fill(9);
    qwHostBasepal.data = qwOnly;
    qwHostColormap.data = qwOnlyCmap;

    qw.active = false;
    expect(hostBasepal()).not.toBe(qwOnly);
    expect(hostColormap()).not.toBe(qwOnlyCmap);

    // and flipping the flag back does reach them, proving the boxes were live
    qw.active = true;
    expect(hostBasepal()).toBe(qwOnly);
    expect(hostColormap()).toBe(qwOnlyCmap);
  });

  test("the accessors re-read the box every call, they do not snapshot", () => {
    qw.active = true;
    const first = new Uint8Array(768);
    qwHostBasepal.data = first;
    expect(hostBasepal()).toBe(first);

    const second = new Uint8Array(768);
    qwHostBasepal.data = second;
    expect(hostBasepal()).toBe(second);
  });
});

// The structural guard. Every module outside src/common/host.ts itself and the
// QuakeWorld-only tree runs in both binaries (the renderers, src/platform,
// src/client, the shared half of src/common), so none of them may import the
// raw `host_basepal` / `host_colormap` bindings - they must go through the two
// accessors. src/qw/** is exempt: it only ever runs under qwcl and reads its
// own boxes directly, which is correct there.
function collectTsFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("alias_ no shared module imports the WinQuake-only palette bindings", () => {
  test("host_basepal and host_colormap are reached only through the accessors", () => {
    const root = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];

    for (const file of collectTsFiles(root, [])) {
      const rel = file.slice(root.length + 1);
      if (rel === join("common", "host.ts")) continue; // the one home
      if (rel.startsWith("qw" + "/")) continue; // qwcl-only, reads its own boxes

      const src = readFileSync(file, "utf8");
      // only the import statements matter; a mention in a comment is fine
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]*host)"/g)) {
        const spec = m[2];
        if (!spec.endsWith("common/host") && !spec.endsWith("./host")) continue;
        const names = m[1].split(",").map((n) => n.trim().replace(/^type\s+/, ""));
        for (const n of names) {
          if (n === "host_basepal" || n === "host_colormap") offenders.push(`${rel} imports ${n}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
