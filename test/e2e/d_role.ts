// Runs as its OWN OS process (spawned by test/e2e/d_lib.ts's spawnRole, one
// per client/server "role" in a D-agent scenario) so that networking between
// roles goes over a real Bun.udpSocket on 127.0.0.1, not the in-process
// loopback net_loop.ts driver a single-process harness (test/e2e/b_lib.ts)
// would be stuck with.
//
// engine argv comes from this process's own argv (see d_lib.ts's spawnRole:
// `["bun", D_ROLE, ...spec.engineArgs]`), so COM_CheckParm etc. see exactly
// the parms a scenario asked for. A scripted command timeline (env
// D_SCRIPT_FILE, {atMs, cmd}[]) is injected via Cbuf_AddText at the given
// elapsed-wall-clock offsets -- this is the mechanism every non-dedicated
// role uses to "type" console commands, since there is no window/keyboard
// under SDL_VIDEODRIVER=dummy. A dedicated role additionally has its real
// Sys_ConsoleInput/stdin path exercised for free by Host_Frame -- the
// orchestrator can write lines straight to this process's stdin pipe and
// they go through the actual production code path, not this harness.
import { Sys_Main_Init, runFrames } from "../../src/main";
import { Cbuf_AddText } from "../../src/common/cmd";
import { conTail } from "./d_lib";

interface CmdStep {
  atMs: number;
  cmd: string;
}

const label = process.env.D_LABEL ?? "role";
const scriptFile = process.env.D_SCRIPT_FILE;
let steps: CmdStep[] = [];
let runMs = 30000;
if (scriptFile) {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(scriptFile).text());
    if (parsed && typeof parsed === "object" && "script" in parsed) {
      const p = parsed as { script: CmdStep[]; runMs: number };
      steps = p.script;
      runMs = p.runMs;
    }
  } catch (e) {
    console.log(`[d_role:${label}] failed to read script file: ${String(e)}`);
  }
}

console.log(`[d_role:${label}] booting with argv:`, process.argv.slice(2).join(" "));

try {
  Sys_Main_Init(["q1ts", ...process.argv.slice(2)]);
} catch (e) {
  console.log(`[d_role:${label}] Sys_Main_Init threw:`, e instanceof Error ? e.stack : String(e));
  process.exit(1);
}

const start = Date.now();
let nextStepIdx = 0;
let lastTick = 0;

while (Date.now() - start < runMs) {
  const elapsed = Date.now() - start;

  while (nextStepIdx < steps.length && steps[nextStepIdx].atMs <= elapsed) {
    const step = steps[nextStepIdx];
    console.log(`[d_role:${label}] t=${elapsed}ms >>> ${step.cmd}`);
    Cbuf_AddText(step.cmd.endsWith("\n") ? step.cmd : step.cmd + "\n");
    nextStepIdx++;
  }

  runFrames(1, 0.05);

  if (elapsed - lastTick > 1000) {
    lastTick = elapsed;
    console.log(`[d_role:${label}] tick t=${elapsed}ms\n---contail---\n${conTail(15)}\n---end contail---`);
  }

  await Bun.sleep(20);
}

console.log(`[d_role:${label}] runMs elapsed, final tail:\n${conTail(25)}`);
console.log(`[d_role:${label}] EXIT`);
process.exit(0);
