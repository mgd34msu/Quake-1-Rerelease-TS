/*
Family X, driver 3: `timedemo demo1` on classic and re-release id1 prints
frames/seconds/fps, and its frame count matches a plain `playdemo` run of the
same file.

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/x_timedemo.ts --tree classic-id1
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/x_timedemo.ts --tree rr-id1

src/client/cl_demo.ts's CL_TimeDemo_f prints exactly
`Con_Printf("%i frames %5.1f seconds %5.1f fps\n", frames, time, frames/time)`
where `frames = host.framecount - cls.td_startframe - 1` (the first frame is
never counted, since cls.td_starttime is grabbed on the SECOND frame so the
demo's own load time is excluded).

"Frames match playdemo's count" is NOT frame-for-frame equality, and asserting
it as such is a defect in an EARLIER draft of this driver, not in the engine:
CL_GetMessage's demo-playback branch reads at most one demo message per
engine frame either way, but the two modes gate that read differently --
`cls.timedemo` forces a fresh message every single frame
(`if (host.framecount === cls.td_lastframe) return 0`, which only ever
matches once), while plain playback waits for simulated time to catch up
(`cl.time <= cl.mtime[0]`) before reading the next one. With this driver's
fixed `frames(1, 0.05)` pump, a plain `playdemo` run therefore needs strictly
more (or equal) engine frames than `timedemo` needs to consume the same
sequence of messages -- confirmed empirically (classic id1 demo1: timedemo
969 frames vs. playdemo's own 1485 pumped frames, a ~65% ratio, not a bug).
What IS a meaningful cross-check is the inequality itself
(`timedemo <= playdemo`, which must always hold: playback can only stall,
never race, ahead of timedemo) and that the two are not wildly out of
proportion (a ratio far under 1 would mean the recorded demo has vastly fewer
messages than frames the driver pumped through it -- a genuinely truncated or
corrupt-looking demo). test/e2e/t_demos_net.ts (unit E3) makes the same
choice for the same reason: it only asserts a positive frame count out of
`timedemo`, never a frame-for-frame match against a separately measured
`playdemo` run.

Booting id1 auto-starts its own `startdemos` loop (see x_startdemos.ts's
header for the mechanics); `map <startmap>` then `disconnect` clears
cls.demonum the same way test/e2e/a_demos.ts does (CL_EstablishConnection
sets cls.demonum = -1), so this driver's own `timedemo`/`playdemo` commands
are not racing the tree's own loop.
*/

import { arg, bootTree, check, classicConfig, cls, cmd, conMark, conSince, finish, frames, homedirFor, treeConfig, waitInGame } from "./r_lib";
import type { GamedirConfigT } from "../support/sweep_lib";

type TimedemoTreeT = "classic-id1" | "rr-id1";
function isTimedemoTree(s: string): s is TimedemoTreeT {
  return s === "classic-id1" || s === "rr-id1";
}

function cfgFor(tree: TimedemoTreeT): GamedirConfigT {
  return tree === "classic-id1" ? classicConfig("id1") : treeConfig("id1");
}

const treeArg = arg("tree", "classic-id1");
if (!isTimedemoTree(treeArg)) {
  console.log(`[FAIL] tree-argument :: unknown tree "${treeArg}" (only classic-id1 and rr-id1, per this unit's brief)`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const tree = treeArg;
const tag = `timedemo_${tree}`;
const demoName = "demo1";

const cfg = cfgFor(tree);
const home = homedirFor(tag);
bootTree({ cfg, vid: "soft", homedir: home });
frames(20);

// Clear the tree's own auto-started startdemos loop the same way
// test/e2e/a_demos.ts does: connect to a real map (which resets
// cls.demonum), then disconnect, leaving a clean disconnected client.
cmd("map e1m1", 2);
const joined = waitInGame(600);
check(`${tag}/reaches-a-clean-start`, joined >= 0, `waitInGame frames=${joined}`);
cmd("disconnect", 10);
cls.demonum = -1;

const engineErrors: string[] = [];
function pumpUntilDemoEnds(maxFrames: number): number {
  let used = 0;
  let started = false;
  for (let i = 0; i < maxFrames; i++) {
    try {
      frames(1, 0.05);
    } catch (e) {
      engineErrors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      break;
    }
    used++;
    if (cls.demoplayback) started = true;
    if (started && !cls.demoplayback) break;
  }
  return used;
}

// ---------------------------------------------------------------------------
// plain playdemo, as a frame-count baseline
// ---------------------------------------------------------------------------

const playMark = conMark();
cmd(`playdemo ${demoName}`, 2);
const playFrames = pumpUntilDemoEnds(8000);
check(`${tag}/playdemo-baseline-runs`, playFrames > 20 && !cls.demoplayback, `playFrames=${playFrames} demoplayback=${cls.demoplayback}`);
cmd("disconnect", 10);
cls.demonum = -1;

// ---------------------------------------------------------------------------
// timedemo
// ---------------------------------------------------------------------------

const timedemoMark = conMark();
cmd(`timedemo ${demoName}`, 2);
const timedemoRunFrames = pumpUntilDemoEnds(8000);
check(`${tag}/timedemo-runs`, timedemoRunFrames > 20 && !cls.demoplayback, `timedemoRunFrames=${timedemoRunFrames} demoplayback=${cls.demoplayback}`);

const printedLines = conSince(timedemoMark);
const m = /(\d+)\s+frames\s+([\d.]+)\s+seconds\s+([\d.]+)\s+fps/.exec(printedLines.join("\n"));
check(`${tag}/prints-frames-seconds-fps`, m !== null, m === null ? printedLines.slice(-6).join(" | ") : m[0]);

if (m !== null) {
  const reportedFrames = Number(m[1]);
  const seconds = Number(m[2]);
  const fps = Number(m[3]);
  check(`${tag}/reported-frames-positive`, reportedFrames > 0, `frames=${reportedFrames}`);
  check(`${tag}/reported-seconds-positive`, seconds > 0, `seconds=${seconds}`);
  check(`${tag}/fps-consistent`, Math.abs(fps - reportedFrames / seconds) < 0.2, `fps=${fps} frames/seconds=${(reportedFrames / seconds).toFixed(2)}`);

  // See file header: timedemo reads exactly one message per engine frame and
  // so can never need MORE frames than a paced playdemo run of the same
  // file needs (playdemo can only stall waiting for cl.time, never skip
  // ahead), and the two should not be wildly out of proportion either.
  const ratio = reportedFrames / playFrames;
  check(
    `${tag}/frames-match-playdemo-within-tolerance`,
    reportedFrames <= playFrames + 2 && ratio >= 0.3,
    `timedemo=${reportedFrames} playdemo=${playFrames} ratio=${ratio.toFixed(2)} (timedemo must be <= playdemo, and not wildly smaller)`,
  );
}

check(`${tag}/no-engine-exception`, engineErrors.length === 0, engineErrors.join(" | "));

const badLines = [...conSince(playMark)].filter((l) => /Host_Error|Sys_Error|Illegible/i.test(l));
check(`${tag}/no-host-error-or-illegible`, badLines.length === 0, badLines.slice(0, 4).join(" | "));

finish(tag);
