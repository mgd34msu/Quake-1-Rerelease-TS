// Test infrastructure only. Same shape as c_harness.ts, but drives the
// QuakeWorld client entry point (src/qw/main_cl.ts) instead of src/main.ts,
// for scenario 6 (sound with no server needed for `play`/`soundinfo`).
// Mirrors scratchpad/qwcl_drive.ts, which proved this boot path works
// headless (SDL_VIDEODRIVER=dummy) well enough to reach cls.state===5 and
// take a screenshot.

import { Sys_Main_Init, runFrames } from "../../src/qw/main_cl";
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

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("usage: bun c_harness_qw.ts <scenario.json>");
    process.exit(1);
  }
  const scenario = JSON.parse(await Bun.file(scenarioPath).text()) as Scenario;
  const dt = scenario.dt ?? 0.05;

  Sys_Main_Init(["qwcl", ...scenario.argv]);

  const pending = [...scenario.timeline].sort((a, b) => a.tSec - b.tSec);
  const start = Date.now();
  let fired = 0;

  while ((Date.now() - start) / 1000 < scenario.durationSec) {
    const elapsed = (Date.now() - start) / 1000;
    while (fired < pending.length && pending[fired].tSec <= elapsed) {
      const entry = pending[fired];
      console.log(`[c_harness_qw] t=${elapsed.toFixed(2)}s firing: ${entry.cmd}`);
      Cbuf_AddText(entry.cmd + "\n");
      fired++;
    }
    runFrames(1, dt);
    await Bun.sleep(Math.max(1, Math.round(dt * 1000)));
  }
  for (; fired < pending.length; fired++) {
    console.log(`[c_harness_qw] WARNING: timeline entry never fired (duration too short): ${JSON.stringify(pending[fired])}`);
  }
  console.log("[c_harness_qw] done");
  process.exit(0);
}

await main();
