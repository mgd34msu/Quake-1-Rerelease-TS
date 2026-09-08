// A module that registers a console command or cvar at LOAD time (a call at
// column 0, outside any function) is only safe when that module is imported
// before Host_Init runs: Cmd_AddCommand after `host_initialized` is a
// Sys_Error. sky_cmd.ts hit exactly that when a lazily-required client
// module first loaded after boot (see followups 2026-09-06, "Hazard").
//
// This pins the set of modules that register at load to the ones render.ts
// pulls in unconditionally at startup. A new module-level registration
// anywhere else fails here, before it can fail at runtime in whichever boot
// happens to load the module late.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** Modules render.ts imports at startup, so their load-time registrations run before Host_Init. */
const ALLOWED = new Set(["client/sky_cmd.ts", "client/fog_cmd.ts", "common/render_cvars.ts"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
}

describe("console registrations at module load", () => {
  test("only the modules render.ts loads at startup register commands or cvars at column 0", () => {
    const files: string[] = [];
    walk(SRC, files);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, "utf8");
      if (!/^(Cmd_AddCommand|Cvar_RegisterVariable)\s*\(/m.test(text)) continue;
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("render.ts imports every allowed module, so they are loaded before Host_Init", () => {
    const render = readFileSync(join(SRC, "client", "render.ts"), "utf8");
    for (const rel of ALLOWED) {
      const base = rel.replace(/^client\//, "./").replace(/^common\//, "../common/").replace(/\.ts$/, "");
      expect(render.includes(`"${base}"`)).toBe(true);
    }
  });
});

// The other direction: registrations that MUST happen at module load, because
// they are how Host_Init reaches the client at all. Moving this one into
// SCR_Init (17fbb93) left the NetQuake client with no screen cvars and no
// `screenshot` command; the regate caught it, this pins it.
describe("hooks Host_Init reaches the client through are installed at module load", () => {
  test("importing screen.ts installs hostClientHooks.scrInit and scrUpdateScreen", async () => {
    const screen = await import("../src/client/screen");
    const { hostClientHooks } = await import("../src/common/host");
    expect(hostClientHooks.scrInit).toBe(screen.SCR_Init);
    expect(typeof hostClientHooks.scrUpdateScreen).toBe("function");
  });
});
