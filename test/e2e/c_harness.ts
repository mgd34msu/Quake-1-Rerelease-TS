// Test infrastructure only (not a ported C file). Drives a real WinQuake
// client boot the same way test/main_boot.test.ts does in-process
// (Sys_Main_Init + runFrames from src/main.ts), but as its own child process
// so each scenario gets a clean SDL_AUDIODRIVER=disk capture file and a
// clean module-singleton state (bun shares one module registry per process,
// and src/main.ts's side-effecting imports install process-wide holders --
// see main_boot.test.ts's own header). Modeled on
// scratchpad/qwcl_drive.ts's shape (Cbuf_AddText injection timed against a
// wall-clock loop), generalized to a JSON timeline so scenario scripts stay
// thin.
//
// Invoked as: bun test/e2e/c_harness.ts <scenario.json>
// scenario.json:
//   {
//     "argv": ["-basedir", "...", "-game", "e2e_c", ...],
//     "timeline": [{"tSec": 0.5, "cmd": "soundinfo"}, ...],
//     "durationSec": 10,
//     "dt": 0.05
//   }
// Console output (Sys_Printf/Con_Printf's stdout) is left on this process's
// own stdout; the caller redirects it to a log file.

import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";

interface TimelineEntry {
  tSec: number;
  cmd: string;
}
interface Scenario {
  argv: string[];
  timeline: TimelineEntry[];
  durationSec: number;
  dt?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrows the scenario JSON at the boundary instead of asserting its shape. */
function parseScenario(raw: unknown, path: string): Scenario {
  if (!isRecord(raw)) throw new Error(`${path}: top level is not an object`);
  const argv = raw.argv;
  if (!Array.isArray(argv) || !argv.every((x) => typeof x === "string")) throw new Error(`${path}: "argv" must be an array of strings`);
  const timelineRaw = raw.timeline;
  if (!Array.isArray(timelineRaw)) throw new Error(`${path}: "timeline" must be an array`);
  const timeline: TimelineEntry[] = [];
  for (const e of timelineRaw) {
    if (!isRecord(e) || typeof e.tSec !== "number" || typeof e.cmd !== "string") throw new Error(`${path}: bad timeline entry ${JSON.stringify(e)}`);
    timeline.push({ tSec: e.tSec, cmd: e.cmd });
  }
  const durationSec = raw.durationSec;
  if (typeof durationSec !== "number") throw new Error(`${path}: "durationSec" must be a number`);
  const dtRaw = raw.dt;
  const dt = dtRaw === undefined ? undefined : typeof dtRaw === "number" ? dtRaw : undefined;
  return { argv: [...argv], timeline, durationSec, dt };
}

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("usage: bun c_harness.ts <scenario.json>");
    process.exit(1);
  }
  const scenario = parseScenario(JSON.parse(await Bun.file(scenarioPath).text()), scenarioPath);
  const dt = scenario.dt ?? 0.05;

  Sys_Main_Init(["q1ts", ...scenario.argv]);

  const pending = [...scenario.timeline].sort((a, b) => a.tSec - b.tSec);
  const start = Date.now();
  let fired = 0;

  while ((Date.now() - start) / 1000 < scenario.durationSec) {
    const elapsed = (Date.now() - start) / 1000;
    while (fired < pending.length && pending[fired].tSec <= elapsed) {
      const entry = pending[fired];
      console.log(`[c_harness] t=${elapsed.toFixed(2)}s firing: ${entry.cmd}`);
      Cbuf_AddText(entry.cmd + "\n");
      fired++;
    }
    runFrames(1, dt);
    await Bun.sleep(Math.max(1, Math.round(dt * 1000)));
  }
  // Drain any remaining timeline entries that never got a chance to fire
  // (a misconfigured scenario -- report it rather than silently dropping).
  for (; fired < pending.length; fired++) {
    console.log(`[c_harness] WARNING: timeline entry never fired (duration too short): ${JSON.stringify(pending[fired])}`);
  }
  console.log("[c_harness] done");
  process.exit(0);
}

await main();
