/*
U9's live gate: a listen server plus its loopback client, our own binary in
both seats (standing order 19), booted on the retail re-release id1 tree.

Guarded on Q1TS_DATA pointing at a basedir that actually has
`rerelease/id1/pak0.pak`. The child-process harness is test/protocol_live.ts's
(one OS process per boot, `+map e1m1`, frames paced the way sys_linux.c paces
Host_Frame, then a JSON line on stdout), so nothing in this process's module
registry is disturbed by a full Host_Init.

What it proves, which nothing before U9 could:
- the re-release progs' ClientConnect runs to completion. Before U9 its very
  first statement -- `bprint("$qc_entered", self.netname)` -- hit the
  unbound-builtin PR_RunError and every one of the 81 rerelease/id1 maps failed
  to boot.
- the print arrived localized: the retail loc table's `qc_entered` is
  "{0} entered the game\n", so the client's console holds the player's name and
  that text, not the raw `$qc_entered` key.
- the behaviour profile auto-detected as `rerelease`, and the server said so.
- no PR_RunError of any kind reached the log.
*/

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASEDIR = process.env.Q1TS_DATA ?? "";
const HAVE_RERELEASE = BASEDIR !== "" && existsSync(join(BASEDIR, "rerelease", "id1", "pak0.pak"));

// A throwaway gamedir, so Host_Shutdown's config.cfg does not land in the
// retail tree: the re-release id1 pak is mounted anyway, because the engine
// detects the nested `rerelease/` root inside a classic basedir
// (src/common/common.ts's COM_IsRereleaseRoot) -- which is exactly the setup
// a real install has, and the one the sweep exercises.
const GAME = "e2e_qex_t";
const MAP = "e1m1";
const mainTs = join(import.meta.dir, "..", "src", "main.ts");
const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

const logDir = mkdtempSync(join(tmpdir(), "q1-qex-live-"));

afterAll(() => {
  if (!process.env.Q1_KEEP_E2E_LOG) rmSync(logDir, { recursive: true, force: true });
  else console.log(`kept qex live logs in ${logDir}`);
});

// Every write the engine makes (config.cfg at shutdown, autosaves, the
// console log) goes to a throwaway home directory under the test scratch
// root, never into the retail tree Q1TS_DATA points at.
const SCRATCH_ROOT = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(SCRATCH_ROOT, { recursive: true });
const HOMEDIR = mkdtempSync(join(SCRATCH_ROOT, "qex-home-"));
afterAll(() => rmSync(HOMEDIR, { recursive: true, force: true }));

function buildScript(map: string): string {
  const args = ["q1ts", "-basedir", BASEDIR, "-homedir", HOMEDIR, "-game", GAME, "-nosound", "+map", map];
  return [
    `const { Sys_Main_Init, runFrames } = await import(${JSON.stringify(mainTs)});`,
    `const { cl, cls, SIGNONS } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "client", "client.ts"))});`,
    `const { cl_entities } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "client", "client.ts"))});`,
    `const { sv } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "server", "server.ts"))});`,
    `const { SV_Ruleset } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "progs", "ext", "ruleset.ts"))});`,
    `const { Sys_FloatTime } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "platform", "sys.ts"))});`,
    `Sys_Main_Init(${JSON.stringify(args)});`,
    `const deadline = Date.now() + 60000;`,
    `let oldtime = Sys_FloatTime() - 0.1;`,
    `while (cls.signon !== SIGNONS && Date.now() < deadline) {`,
    `  const newtime = Sys_FloatTime();`,
    `  const elapsed = newtime - oldtime;`,
    `  oldtime = newtime;`,
    `  runFrames(1, elapsed);`,
    `  await Bun.sleep(1);`,
    `}`,
    `for (let i = 0; i < 30; i++) {`,
    `  const newtime = Sys_FloatTime();`,
    `  const elapsed = newtime - oldtime;`,
    `  oldtime = newtime;`,
    `  runFrames(1, elapsed);`,
    `  await Bun.sleep(1);`,
    `}`,
    `const player = cl_entities[cl.viewentity];`,
    `const result = {`,
    `  signon: cls.signon,`,
    `  ruleset: SV_Ruleset(),`,
    `  svActive: sv.active,`,
    `  viewentity: cl.viewentity,`,
    `  playerHasModel: player ? player.model !== null : false,`,
    `  numEntities: cl.num_entities,`,
    `  levelname: cl.levelname,`,
    `};`,
    `console.log("QEX_RESULT " + JSON.stringify(result));`,
    `process.exit(0);`,
  ].join("\n");
}

interface LiveResult {
  signon: number;
  ruleset: string;
  svActive: boolean;
  viewentity: number;
  playerHasModel: boolean;
  numEntities: number;
  levelname: string;
}

function parseResult(log: string): LiveResult | null {
  for (const line of log.split("\n")) {
    if (!line.startsWith("QEX_RESULT ")) continue;
    const parsed: unknown = JSON.parse(line.slice("QEX_RESULT ".length));
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed;
    if (
      "signon" in r &&
      typeof r.signon === "number" &&
      "ruleset" in r &&
      typeof r.ruleset === "string" &&
      "svActive" in r &&
      typeof r.svActive === "boolean" &&
      "viewentity" in r &&
      typeof r.viewentity === "number" &&
      "playerHasModel" in r &&
      typeof r.playerHasModel === "boolean" &&
      "numEntities" in r &&
      typeof r.numEntities === "number" &&
      "levelname" in r &&
      typeof r.levelname === "string"
    ) {
      return {
        signon: r.signon,
        ruleset: r.ruleset,
        svActive: r.svActive,
        viewentity: r.viewentity,
        playerHasModel: r.playerHasModel,
        numEntities: r.numEntities,
        levelname: r.levelname,
      };
    }
  }
  return null;
}

async function runChild(tag: string, map: string): Promise<{ result: LiveResult | null; log: string; exitCode: number | string }> {
  const logPath = join(logDir, `${tag}.log`);
  const fd = openSync(logPath, "w");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", buildScript(map)],
    env: headlessEnv,
    stdout: fd,
    stderr: fd,
  });
  const exitCode = await Promise.race([child.exited, Bun.sleep(120000).then(() => "timeout" as const)]);
  if (exitCode === "timeout") child.kill(9);
  closeSync(fd);
  return { result: parseResult(readFileSync(logPath, "latin1")), log: readFileSync(logPath, "latin1"), exitCode };
}

describe.skipIf(!HAVE_RERELEASE)("the re-release id1 progs on a live listen server", () => {
  test("e1m1 boots, the player enters the game, and ClientConnect's localized bprint arrives", async () => {
    const { result, log, exitCode } = await runChild("rerelease-id1-e1m1", MAP);
    expect(exitCode).toBe(0);
    expect(result).not.toBeNull();
    if (result === null) return;

    // The behaviour profile auto-detected, and the server announced it.
    expect(result.ruleset).toBe("rerelease");
    expect(log).toContain("Server ruleset rerelease");

    // The signon sequence completed and the player spawned.
    expect(result.signon).toBe(4); // SIGNONS
    expect(result.svActive).toBe(true);
    expect(result.viewentity).toBeGreaterThan(0);
    expect(result.playerHasModel).toBe(true);
    expect(result.numEntities).toBeGreaterThan(1);
    expect(result.levelname.length).toBeGreaterThan(0);

    // ClientConnect's `bprint("$qc_entered", self.netname)` reached the client,
    // localized through the retail loc table's
    // `qc_entered = "{0} entered the game\n"` -- not as the raw key.
    expect(log).toContain("entered the game");
    expect(log).not.toContain("$qc_entered");

    // and nothing in the progs raised.
    expect(log).not.toContain("PR_RunError");
    expect(log).not.toContain("unbound builtin");
  }, 180000);
});
