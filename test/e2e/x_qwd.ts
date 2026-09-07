/*
Family X, driver 5: QuakeWorld demo record/playback, at protocols 28 and 29.

  bun test/e2e/x_qwd.ts --protocol 28 --port 26840
  bun test/e2e/x_qwd.ts --protocol 29 --port 26850

A dedicated qwsv plus a `-qw` client, both the compiled binary (standing
order 19), real UDP in this unit's 26800-26899 band. test/e2e/t_lib.ts (unit
E3, family T) is only read here, never written: `startServer`/`startQwClient`/
`killSeat`/`waitFor`/`readLog`/`clientLevelTitle`/`recordedDemoPath`/
`qwBasedir`/`waits` and the headless-env enforcement baked into its seat
spawner are reused rather than re-derived.

src/qw/client/cl_demo.ts's CL_Record_f refuses unless `cls.state` is already
`ca_active` ("You must be connected to record."), the OPPOSITE of NetQuake's
CL_Record_f (which refuses if ALREADY connected). test/e2e/t_demos_net.ts's
own QuakeWorld scenario stays red for exactly this reason: a QW client only
has ONE scriptable channel, its opening cfg, and its own comment notes every
line of that cfg runs AHEAD of the text the server stuffs to finish the join,
so a `record` placed right after `connect` in the same cfg always lands
before `cls.state` reaches `ca_active`.

STATUS (this unit's report has the full account): every design tried below
reaches "the client joined" (confirmed off the SERVER's own log) but
`record` still lands before the CLIENT's own `cls.state` reaches `ca_active`
-- this driver is RED on the `record`/playback assertions and left that way
on purpose (a driver asserts the correct behaviour and stays red until it is
true, per .orch/briefs/E2E-COMMON.md), not silently downgraded to "did not
crash". The mechanics below are real, confirmed findings, kept as exact
context for whoever picks this back up -- not a solved problem.

Four designs were tried:

  1. t_lib.ts's `PolledClientT` (`arm()`/`run()`), `arm()` called immediately
     after spawning, before confirming the join off the server's own log: the
     step chain engaged WHILE the connect handshake was still in flight, and
     an armed client's looping cfg starves anything the server still needs to
     stuff to finish that handshake (t_lib.ts's own header note) -- the join
     never completed at all ("no player entered").
  2. Same `PolledClientT`, `arm()` called only AFTER `waitFor(sv, /entered
     the game/)` confirmed the join (test/e2e/t_deathmatch.ts's own ordering
     for its two NetQuake clients). The join itself took longer, real-time,
     than the boot cfg's fixed pre-arm window (t_lib.ts:
     `ARM_ATTEMPTS * ARM_ATTEMPT_FRAMES`, sized to fit one 3500-byte cfg) has
     room for -- by the time `arm()` ran, the boot cfg's last pre-arm attempt
     had already happened and found nothing, and there was no scheduled
     attempt left to pick up the step files `arm()` just wrote. `arm()`
     itself then timed out.
  3. A one-shot script (`startQwClient`, no arm/run) with a large `waits(N)`
     join-settle budget between `connect` and `record`. Tried N = 1500, 6000
     and 20000 (all multi-segment, chained via t_lib.ts's `writeScriptInto`):
     `record` failed with "You must be connected to record." every time,
     always landing just before the server's stuffed "Checking skins..." and
     "entered the game". A real, confirmed contributor here: `writeScriptInto`
     chains anything over 1600 bytes via a trailing `exec <name>_N+1.cfg` per
     segment, and `exec` is `Cbuf_InsertText`, which splices AT THE FRONT of
     whatever is still queued -- while the server's stuffed join-completion
     text arrives via `Cbuf_AddText`, which APPENDS TO THE END. Every new
     segment's `exec` therefore re-inserts ahead of that appended text,
     pushing it further back each time, so it can only reach the front of the
     buffer once the LAST segment in the chain stops re-inserting -- the same
     starvation t_lib.ts's own header already documents for an ARMED polled
     client, just reached by chaining instead of looping.
  4. A SINGLE, unchained cfg segment (kept under 1600 bytes on purpose, no
     trailing `exec` at all, so (3)'s starvation mechanism cannot apply):
     tried a 200-frame idle join-settle before `record`, and separately
     `+forward`/`+attack` BEFORE `record` (real usercmd packets reaching the
     server, not just idle time) with a 150-frame settle. Both still failed
     the same way, `record` still landing before "entered the game". This
     rules out both "not enough idle settle time" and "the server needs a
     real usercmd packet before it will finish spawning the client" as
     the/a sufficient explanation on their own.

Two real, independently confirmed facts remain unreconciled: (3)'s chaining
mechanism is a genuine starvation risk (proven mechanically from the source,
not just observed), and this session's host was independently confirmed to
be under severe, unrelated contention (this unit's report: a different
project's orphaned process pegging a full core for 25+ hours, plus this
qwsv/qwcl pair measured accumulating far fewer CPU-seconds than wall-clock
seconds while running) -- but (4) shows the failure reproduces even with NO
chaining and a modest, single-segment budget, which contention alone does
not explain (a slow host should just need more real seconds, not fail the
same way regardless of how those seconds are spent). Something about this
engine's dedicated qwsv's own spawn-completion timing for a scripted,
`-nosound`, headless client is not yet understood; the recording script below
keeps design (4)'s movement (a reasonable thing to do in a recorded demo
regardless) and a config kept deliberately in ONE segment, but this is the
best-reasoned attempt on record, not a confirmed fix.
*/

import { argValue, check, clientLevelTitle, killSeat, qwBasedir, readLog, recordedDemoPath, startQwClient, startServer, summary, waitFor, waits, type SeatT } from "./t_lib";
import { existsSync, statSync } from "node:fs";

const PROTOCOL_ARG = argValue("protocol", "28");
if (PROTOCOL_ARG !== "28" && PROTOCOL_ARG !== "29") {
  console.log(`[FAIL] protocol-argument :: unknown protocol "${PROTOCOL_ARG}"`);
  console.log("RESULT 0 1");
  process.exit(1);
}
const DEFAULT_PORT: Record<string, string> = { "28": "26840", "29": "26850" };
const port = argValue("port", DEFAULT_PORT[PROTOCOL_ARG]);
const DEMO = `x_qwd_${PROTOCOL_ARG}`;
const tag = `x_qwd_${PROTOCOL_ARG}`;

// Real Host_Frame ticks, kept small on purpose -- see file header. The whole
// recScript below (literal commands plus these wait budgets) must stay
// under t_lib.ts's 1600-byte CFG_SEGMENT_BYTES so it is written as a SINGLE
// cfg segment with no chained `exec`, which is what keeps the server's own
// appended join-completion text from ever being pushed back.
//
// Design (4) from the file header: a single unchained segment, with movement
// before `record` (not confirmed to fix the underlying issue -- see file
// header STATUS -- but a reasonable thing to do in a recorded demo either
// way, and it does not make the failure any worse).
const CONNECT_SETTLE = 30;
const MOVE_SETTLE = 150;
const HOLD_FRAMES = 60;

const BASE = qwBasedir();

const sv: SeatT = startServer(`${tag}_sv`, ["-qw", "-basedir", BASE, "-nosound", "-port", port, "+sv_qwprotocol", PROTOCOL_ARG, "+map", "dm1"]);
const svUp = await waitFor(sv, /Server protocol \d+ \(flags/, 90000);
check(`${tag}/server-serves-the-protocol`, svUp, svUp ? "" : `no "Server protocol" line in ${sv.log}`);

const recScript = [
  "cl_shownet 0",
  `connect 127.0.0.1:${port}`,
  ...waits(CONNECT_SETTLE),
  "+forward",
  "+attack",
  ...waits(MOVE_SETTLE),
  "-forward",
  "-attack",
  `record ${DEMO}`,
  "+forward",
  "+attack",
  ...waits(HOLD_FRAMES),
  "-forward",
  "-attack",
  "stop",
  ...waits(10),
];
const recScriptBytes = recScript.join("\n").length;
check(`${tag}/recording-script-is-one-segment`, recScriptBytes < 1600, `${recScriptBytes} bytes (must stay under t_lib.ts's 1600-byte CFG_SEGMENT_BYTES -- see file header)`);

const cl: SeatT = startQwClient(`${tag}_cl`, ["-qw", "-basedir", BASE, "-nosound"], recScript);

const joined = await waitFor(sv, /entered the game/, 120000);
check(`${tag}/client-joined`, joined, joined ? "" : (readLog(sv).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `no player entered (client log ${cl.log})`);

const recCompleted = await waitFor(cl, /Completed demo/, 120000);
check(`${tag}/live-recording-completes`, recCompleted, recCompleted ? "" : readLog(cl).slice(-800));

const clText = readLog(cl);
check(`${tag}/record-was-accepted`, !/must be connected to record/i.test(clText), (clText.match(/.*must be connected to record.*/gi) ?? []).slice(-1).join(""));

const liveTitle = clientLevelTitle(clText);
check(`${tag}/live-title-seen`, liveTitle !== null && liveTitle.length > 0, `title=${liveTitle ?? "(none)"}`);

const demoPath = recordedDemoPath(clText);
check(`${tag}/demo-file-on-disk`, demoPath !== null && existsSync(demoPath) && statSync(demoPath).size > 0, demoPath === null ? "no 'recording to <path>.' line" : `${demoPath} (${existsSync(demoPath) ? statSync(demoPath).size : 0} bytes)`);
check(`${tag}/console-reports-completion`, /Completed demo/.test(clText), (clText.match(/.*(Completed demo|recording to).*/g) ?? []).slice(-2).join(" | "));

killSeat(cl);
killSeat(sv);

// ---------------------------------------------------------------------------
// playback in fresh processes, no server anywhere
// ---------------------------------------------------------------------------

const playbackArgs = ["-qw", "-basedir", BASE, "-nosound"];

const play = startQwClient(`${tag}_play`, playbackArgs, ["cl_shownet 0", `playdemo ${DEMO}`]);
const playSaw = await waitFor(play, /\[02\]/, 60000);
const playText = readLog(play);
const playTitle = clientLevelTitle(playText);
check(
  `${tag}/playback-title-matches`,
  playSaw && playTitle !== null && liveTitle !== null && playTitle.trim() === liveTitle.trim(),
  `live="${liveTitle ?? ""}" play="${playTitle ?? ""}" (${play.log})`,
);
killSeat(play);

const timed = startQwClient(`${tag}_timedemo`, playbackArgs, ["cl_shownet 0", `timedemo ${DEMO}`]);
const timedSaw = await waitFor(timed, /\d+ frames\s+[\d.]+ seconds/, 60000);
const timedText = readLog(timed);
const framesMatch = /(\d+)\s+frames\s+([\d.]+)\s+seconds\s+([\d.]+)\s+fps/.exec(timedText);
check(`${tag}/timedemo-reports-frames`, timedSaw && framesMatch !== null && Number(framesMatch[1]) > 0, framesMatch === null ? `no frame line in ${timed.log}` : framesMatch[0]);
killSeat(timed);

const allLogs = `${clText}\n${playText}\n${timedText}`;
check(`${tag}/no-fatal-engine-error`, !/Sys_Error|Fatal:|Host_Error/.test(allLogs), (allLogs.match(/.*(Sys_Error|Fatal:|Host_Error).*/g) ?? []).slice(0, 3).join(" | "));

summary(`x_qwd ${PROTOCOL_ARG}`);
