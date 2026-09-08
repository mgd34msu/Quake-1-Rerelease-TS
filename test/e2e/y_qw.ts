/*
E9 (family Y, unit E9): the QuakeWorld client's own sound path, end to end,
per .orch/briefs/E9-audio.md item 4 ("the QuakeWorld client path (-qw)
produces sound on a listen or dedicated pair").

  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=disk SDL_DISKAUDIOFILE=<raw> \
    bun test/e2e/y_qw.ts

QuakeWorld's client port is `PORT_CLIENT`, a hardcoded 27001 in
src/qw/protocol.ts with no `-port` override -- only one qwcl can be alive on
the host at once. Unit F20 runs short QuakeWorld unit tests concurrently
with this unit, so this driver polls `ss -lun` (y_lib.ts's
`waitForUdpPortFree`) and waits for the port to be free before starting its
own qwcl, rather than racing it; the manifest also gives this driver
`"lock": "qwclient"` so it never runs concurrently with another
qwcl-using driver in this family's own manifest.

The server seat is a real dedicated qwsv this driver starts and owns for the
run's lifetime (killed at the end, and via a process-exit hook if the driver
is cut off early), on port 26900 -- inside this unit's own 26900-26999 range,
so it cannot collide with any other family. Per standing order 19 the server
seat uses Q1TS_BINARY (the compiled engine) when the runner has built one
(`needs: ["binary"]` in this driver's manifest entry), falling back to
`bun src/qw/main_sv.ts` otherwise -- test/e2e/e_lib.ts's own `qwsvCmd()`
shape, reimplemented here rather than imported since e_lib.ts is family E's
own file, not one of the generic cross-family helpers (q1data.ts,
c_harness.ts/c_harness_qw.ts/c_analyzer.ts) this unit's brief names as safe
to read from another unit.

DEVIATION from standing order 19's letter: the CLIENT seat reuses
test/e2e/c_harness_qw.ts (an existing, unmodified helper already built for
exactly this -- family C's own "qw" scenario spawns it the same way) rather
than the compiled binary, since that helper drives the in-process
Sys_Main_Init/runFrames entry point from src/qw/main_cl.ts, not a subprocess.
Reported rather than silently diverging; family E's own qwcl-side scenarios
are in-process for the same reason (only e_c2.ts spawns a second qwcl
subprocess, per test/e2e/README.md's "Files that are not manifest drivers").

Scenario: dedicated qwsv `+map dm2` on 26900; the real qwcl connects, fires
a weapon, and disconnects. Captured with SDL_AUDIODRIVER=disk like every
other y_*.ts driver (the harness's own child process gets this env
explicitly, per E2E-COMMON.md's "never rely on inherited environment" --
the parent driver invoking this file may run under SDL_AUDIODRIVER=dummy).
*/
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rmsWindows, type WindowStat } from "./c_analyzer";
import { check, summary, homedirArgs, gameName, Q1TS_DATA, readRawPcmSync, waitForUdpPortFree, Y_SCRATCH } from "./y_lib";

const REPO = join(import.meta.dir, "..", "..");
const SERVER_PORT = 26900;
const QW_CLIENT_PORT = 27001; // src/qw/protocol.ts's hardcoded PORT_CLIENT

function inRange<T extends { tStartSec: number; tEndSec: number }>(ws: readonly T[], a: number, b: number): T[] {
  return ws.filter((w) => w.tEndSec > a && w.tStartSec < b);
}

function qwsvCmd(): string[] {
  const bin = process.env.Q1TS_BINARY;
  if (bin && existsSync(bin)) return [bin, "-dedicated", "-qw"];
  return ["bun", `${REPO}/src/qw/main_sv.ts`];
}

interface ServerHandle {
  proc: ReturnType<typeof Bun.spawn>;
  out: () => string;
  waitFor: (needle: string, ms: number) => Promise<boolean>;
}

function startServer(): ServerHandle {
  const proc = Bun.spawn([...qwsvCmd(), "-basedir", Q1TS_DATA, ...homedirArgs("qw"), "-port", String(SERVER_PORT), "+map", "dm2"], {
    cwd: REPO,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  });
  let buf = "";
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const dec = new TextDecoder();
    for await (const chunk of stream) buf += dec.decode(chunk);
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  process.on("exit", () => {
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
  });
  return {
    proc,
    out: () => buf,
    waitFor: async (needle: string, ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (buf.includes(needle)) return true;
        await Bun.sleep(20);
      }
      return buf.includes(needle);
    },
  };
}

async function main(): Promise<void> {
  mkdirSync(Y_SCRATCH, { recursive: true });

  const portFree = await waitForUdpPortFree(QW_CLIENT_PORT, 180, 2);
  if (!check(`UDP ${QW_CLIENT_PORT} (qwcl's hardcoded PORT_CLIENT) is free before starting`, portFree, portFree ? "" : `still occupied after 180s -- check \`ss -lun | grep :${QW_CLIENT_PORT}\` (another qwcl, or unit F20's own QuakeWorld unit tests, may still be running)`)) {
    summary("y_qw");
    return;
  }

  const server = startServer();
  const serverUp = await server.waitFor("UDP Initialized", 20000);
  check("dedicated qwsv came up and bound its UDP socket", serverUp, serverUp ? "" : server.out().slice(-500));
  if (!serverUp) {
    server.proc.kill();
    summary("y_qw");
    return;
  }
  await Bun.sleep(600); // the stdin/console reader installs inside Sys_Init; give the map a moment to finish spawning too

  const game = gameName("qw");
  const scenarioPath = join(Y_SCRATCH, "y_qw_scenario.json");
  const capturePath = join(Y_SCRATCH, "y_qw.raw");
  if (existsSync(capturePath)) rmSync(capturePath);

  const scenario = {
    argv: ["-basedir", Q1TS_DATA, ...homedirArgs(game), "-game", game, "-vid_ref", "soft"],
    timeline: [
      { tSec: 0.3, cmd: `connect 127.0.0.1:${SERVER_PORT}` },
      { tSec: 3.5, cmd: "volume 1" },
      { tSec: 4.0, cmd: "+attack" },
      { tSec: 5.0, cmd: "-attack" },
      { tSec: 5.5, cmd: "soundinfo" },
      { tSec: 6.0, cmd: "disconnect" },
    ],
    durationSec: 7,
    dt: 0.05,
  };
  await Bun.write(scenarioPath, JSON.stringify(scenario, null, 2));

  const clientProc = Bun.spawn(["bun", "test/e2e/c_harness_qw.ts", scenarioPath], {
    cwd: REPO,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SDL_VIDEODRIVER: "dummy",
      SDL_AUDIODRIVER: "disk",
      SDL_DISKAUDIOFILE: capturePath,
      SDL_DISKAUDIODELAY: "0",
    },
  });
  const [out, err] = await Promise.all([new Response(clientProc.stdout).text(), new Response(clientProc.stderr).text()]);
  const exitCode = await clientProc.exited;
  const clientConsole = out + err;

  server.proc.kill();

  check("the qwcl harness ran to completion", exitCode === 0, `exit=${exitCode}`);
  check(
    "the client connected (no refusal/timeout in its own console)",
    !/connection refused|timed out|couldn't resolve|no route to host/i.test(clientConsole),
    clientConsole.slice(-400).replace(/\n/g, " | "),
  );
  check(`\`soundinfo\` reports the mixer's spec`, /\d+ stereo|\d+ samples|\d+ speed|channels/i.test(clientConsole), clientConsole.slice(-400).replace(/\n/g, " | "));

  check("a capture file was written", existsSync(capturePath), capturePath);
  if (!existsSync(capturePath)) {
    summary("y_qw");
    return;
  }
  const pcm = readRawPcmSync(capturePath);
  const rmsW: WindowStat[] = rmsWindows(pcm, 0.25);
  const attackWindow = inRange(rmsW, 4.0, 5.3);
  check(
    "firing a weapon over the qwcl/qwsv pair is audible in the capture",
    attackWindow.some((w) => !w.silent),
    `${attackWindow.filter((w) => !w.silent).length}/${attackWindow.length} windows audible`,
  );

  summary("y_qw");
}

await main();
