/*
t_demos_net -- recording a NETWORKED session and playing it back, on every
protocol this engine speaks.

  bun test/e2e/t_demos_net.ts --protocol 15  --port 26370
  bun test/e2e/t_demos_net.ts --protocol 666 --port 26372
  bun test/e2e/t_demos_net.ts --protocol 999 --port 26374
  bun test/e2e/t_demos_net.ts --protocol 28  --port 26376
  bun test/e2e/t_demos_net.ts --protocol 29  --port 26378

One dedicated server and one client, both the compiled binary, on real UDP.
The client records the session it is playing, and then two FRESH processes --
no server anywhere, nothing left over from the recording -- play that file
back: `playdemo` has to reach the same level title the live client was sent,
and `timedemo` has to report a frame count.

NetQuake and QuakeWorld put `record` at opposite ends of the connect:

  - NetQuake's CL_Record_f (src/client/cl_demo.ts) REFUSES once connected
    ("Client demo recording must be started before connecting"), so the
    disconnect/record/connect trio is the client's opening line, run in one
    console frame;
  - QuakeWorld's (src/qw/client/cl_demo.ts) refuses UNLESS `cls.state` is
    already ca_active ("You must be connected to record."), so the driver
    arms the client's console channel once the server has announced it
    entering, and only then tells it to record.

The QuakeWorld runs take the runner's `qwclient` lock: QuakeWorld's client
port is the hardcoded PORT_CLIENT = 27001 and only one can be alive at a time.
*/

import {
  argValue,
  baseArgs,
  check,
  contentById,
  clientLevelTitle,
  killSeat,
  qwBasedir,
  readDemoServerInfo,
  readLog,
  recordedDemoPath,
  serverProtocolLine,
  sleep,
  startPolledClient,
  startPolledQwClient,
  startServer,
  summary,
  waitFor,
  type PolledClientT,
} from "./t_lib";
import { homedirArgs } from "./q1data";
import { existsSync, statSync } from "node:fs";

const protocolArg = argValue("protocol", "666");
const port = Number(argValue("port", "26370"));
const isQw = protocolArg === "28" || protocolArg === "29";
const DEMO = `t_dem_${protocolArg}`;
const classic = contentById("classic-id1");
const GAME = `e2e_t_dem_${protocolArg}`;

console.log(`t_demos_net: protocol=${protocolArg} (${isQw ? "QuakeWorld" : "NetQuake"}) port=${port}`);

let liveTitle: string | null = null;
let demoPath: string | null = null;
let playbackArgs: string[] = [];

/** Hold forward+attack for `seconds` so the recording has motion in it. */
async function act(cl: PolledClientT, seconds: number): Promise<void> {
  await cl.run(["+forward", "+attack"]);
  await sleep(seconds * 1000);
  await cl.run(["-forward", "-attack"]);
}

if (!isQw) {
  // -------------------------------------------------------------- NetQuake --
  const sv = startServer(`t_dem_${protocolArg}_sv`, [
    ...baseArgs(classic, `${GAME}_sv`),
    "-port", String(port),
    "+deathmatch", "0",
    "+sv_protocol", protocolArg,
    "+map", "e1m1",
  ]);
  const up = await waitFor(sv, /Server protocol \d+ \(flags/, 90000);
  check(`the server serves e1m1 on protocol ${protocolArg}`, up, up ? "" : `no "Server protocol" line in ${sv.log}`);
  const p = serverProtocolLine(readLog(sv));

  const cl = startPolledClient(`t_dem_${protocolArg}_cl`, GAME, [...baseArgs(classic, GAME), "-port", String(port)], [
    "cl_shownet 0",
    "disconnect",
    `record ${DEMO}`,
    "connect 127.0.0.1",
  ]);

  const joined = await waitFor(sv, /entered the game/, 120000);
  check("the recording client is in the game", joined, (readLog(sv).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `no player entered (client log ${cl.seat.log})`);

  await cl.arm();
  await act(cl, 5);
  await cl.run(["stop"]);
  await sleep(1500);

  const clText = readLog(cl.seat);
  liveTitle = clientLevelTitle(clText);
  demoPath = recordedDemoPath(clText);
  check("the client recorded a demo of the live session", demoPath !== null && existsSync(demoPath) && statSync(demoPath).size > 0, demoPath === null ? "no 'recording to <path>.' line" : `${demoPath} (${existsSync(demoPath) ? statSync(demoPath).size : 0} bytes)`);
  check("the client's console reported completing the demo", /Completed demo/.test(clText), (clText.match(/.*(Completed demo|recording to).*/g) ?? []).slice(-2).join(" | "));

  const info = demoPath === null ? null : readDemoServerInfo(demoPath);
  check(
    `the recorded demo carries protocol ${protocolArg}`,
    info !== null && p !== null && info.protocol === p.protocol && info.protocol === Number(protocolArg) && info.flags === p.flags,
    info === null ? "no serverinfo message in the demo" : `demo ${info.protocol}/0x${info.flags.toString(16)}, server ${p === null ? "?" : p.protocol}/0x${(p?.flags ?? 0).toString(16)}`,
  );

  killSeat(cl.seat);
  killSeat(sv);
  playbackArgs = [...baseArgs(classic, GAME), "-port", String(port)];
} else {
  // ------------------------------------------------------------ QuakeWorld --
  const BASE = qwBasedir();
  const sv = startServer(`t_dem_${protocolArg}_sv`, [
    "-qw",
    "-basedir", BASE,
    ...homedirArgs("qw"),
    "-nosound",
    "-port", String(port),
    "+sv_qwprotocol", protocolArg,
    "+map", "dm1",
  ]);
  const up = await waitFor(sv, /Server protocol \d+ \(flags/, 90000);
  check(`the QuakeWorld server serves dm1 on protocol ${protocolArg}`, up, up ? "" : `no "Server protocol" line in ${sv.log}`);
  const p = serverProtocolLine(readLog(sv));
  check("the QuakeWorld server serves the protocol it was asked for", p !== null && p.protocol === Number(protocolArg), `asked for ${protocolArg}, got ${p === null ? "nothing" : p.protocol}`);

  /*
  The `record` goes in the opening cfg, which is the only console input a
  QuakeWorld client can be given, and QuakeWorld's CL_Record_f refuses it:
  every line of a cfg is executed AHEAD of the text the server stuffs to
  finish the join, so a cfg's `record` always runs while cls.state is still
  ca_connecting, and the console answers "You must be connected to record."
  There is no later moment to try again -- once the cfg is exhausted the
  buffer is empty and nothing can put a command into a running client. The
  assertions below are the behaviour that is wanted (record a live
  QuakeWorld session, replay it) and stay red until the engine offers a
  scriptable way in; see this unit's report.
  */
  const cl = startPolledQwClient(`t_dem_${protocolArg}_cl`, ["-qw", "-basedir", BASE, "-nosound"], [
    "cl_shownet 0",
    `connect 127.0.0.1:${port}`,
    "+forward",
    "+attack",
    `record ${DEMO}`,
  ]);
  const joined = await waitFor(sv, /entered the game/, 180000);
  check("the recording client is in the QuakeWorld game", joined, (readLog(sv).match(/.*entered the game.*/g) ?? []).slice(-1).join("") || `no player entered (client log ${cl.seat.log})`);
  await sleep(6000);
  await cl.run(["stop"], 30000);
  await sleep(1500);

  const clText = readLog(cl.seat);
  liveTitle = clientLevelTitle(clText);
  demoPath = recordedDemoPath(clText);
  check(
    "the client recorded a demo of the live QuakeWorld session",
    demoPath !== null && existsSync(demoPath) && statSync(demoPath).size > 0,
    demoPath === null ? `no 'recording to <path>.' line: ${(clText.match(/.*must be connected to record.*/gi) ?? ["record was never answered"]).slice(-1).join("")}` : `${demoPath} (${existsSync(demoPath) ? statSync(demoPath).size : 0} bytes)`,
  );
  check("the client's console reported completing the demo", /Completed demo/.test(clText), (clText.match(/.*(Completed demo|recording to|must be connected).*/gi) ?? []).slice(-2).join(" | "));

  killSeat(cl.seat);
  killSeat(sv);
  await sleep(3000);
  playbackArgs = ["-qw", "-basedir", BASE, "-nosound"];
}

check("the live client was sent a level title to compare playback against", liveTitle !== null && liveTitle.length > 0, `title=${liveTitle ?? "(none)"}`);

// ---------------------------------------------------------------------------
// playback, in a fresh process with no server anywhere
// ---------------------------------------------------------------------------

function playbackSeat(name: string, cmd: string): PolledClientT {
  const boot = ["cl_shownet 0", "disconnect", cmd];
  return isQw ? startPolledQwClient(name, playbackArgs, boot) : startPolledClient(name, GAME, playbackArgs, boot);
}

const play = playbackSeat(`t_dem_${protocolArg}_play`, `playdemo ${DEMO}`);
const playSaw = await waitFor(play.seat, /\[02\]/, 120000);
await sleep(2000);
const playText = readLog(play.seat);
const playTitle = clientLevelTitle(playText);
check(
  "playdemo in a fresh process reaches the same level title",
  playSaw && playTitle !== null && liveTitle !== null && playTitle.trim() === liveTitle.trim(),
  `live "${liveTitle ?? ""}" vs playback "${playTitle ?? ""}" (${play.seat.log})`,
);
killSeat(play.seat);
await sleep(isQw ? 3000 : 500);

const timed = playbackSeat(`t_dem_${protocolArg}_timedemo`, `timedemo ${DEMO}`);
const timedSaw = await waitFor(timed.seat, /\d+ frames\s+[\d.]+ seconds/, 180000);
const timedText = readLog(timed.seat);
const frames = /(\d+) frames\s+([\d.]+) seconds\s+([\d.]+) fps/.exec(timedText);
check(
  "timedemo reports a frame count",
  timedSaw && frames !== null && Number(frames[1]) > 0,
  frames === null ? `no "<n> frames <t> seconds <f> fps" line in ${timed.seat.log}` : frames[0],
);
killSeat(timed.seat);

check(
  "no seat hit a fatal engine error",
  !/Sys_Error|SysError|Fatal:|Host_Error/.test(playText + timedText),
  (playText + timedText).match(/.*(Sys_Error|Fatal:|Host_Error).*/g)?.slice(0, 2).join(" | ") ?? "",
);

summary(`t_demos_net ${protocolArg}`);
