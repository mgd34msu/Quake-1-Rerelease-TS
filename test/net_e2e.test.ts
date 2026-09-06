import { Cvar_FindVar, Cvar_Set } from "../src/common/cvar";
import { tcpipAvailable, my_tcpip_address, setTcpipAvailable, setMyTcpipAddress } from "../src/common/net_main";
/*
End-to-end test for the NetQuake `connect` handshake over real UDP between
two OS processes: a `-dedicated` server child and a client child, both
running src/main.ts under `bun` on 127.0.0.1.

This is the case .orch/e2e/D.md's Defect A said could never succeed. It
exercises what the unit tests cannot: net_dgrm.ts's `_Datagram_Connect`
busy-wait (which polls src/platform/net_udp.ts's UDP_Read synchronously,
never yielding to the event loop), the server's
Datagram_CheckNewConnections/SV_ConnectClient path, and the signon sequence
through to cls.signon === SIGNONS.

Both engines run as child processes. A client Host_Init touches most of the
process-wide singletons in the tree (video, sound, the renderer registry,
the hunk, cvars, the command table); booting one inside `bun test`'s shared
module registry both breaks and is broken by the other suites in this
process (rule 15). One OS process per engine is also how the C runs, and it
is what makes the UDP between them real rather than loopback.

Data: the real retail basedir. A client needs gfx/palette.lmp, gfx.wad's
conchars and the rest of id1's client assets, so the synthetic basedir
test/support/dedicated_fixture.ts builds (enough for a dedicated server)
cannot boot one; this suite needs a real installation and says so loudly if
it is missing.

Ports: 26240/26241 (this unit's assigned 26200-26299 range).
*/

import { describe, expect, test, afterAll } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CactiveT, SIGNONS } from "../src/client/client";
import { udpLandriver } from "../src/platform/net_udp";

// Real Quake data cannot ship in this repository, so this file's suites are
// opt-in: point Q1TS_DATA at a base directory holding id1/pak0.pak to run them
// (the same variable test/e2e/q1data.ts uses). With no data reachable every
// suite below skips, which is what a checkout with no pak files -- CI, or a
// fresh clone -- gets.
const BASEDIR = process.env.Q1TS_DATA ?? "";
const HAVE_DATA = BASEDIR !== "" && (existsSync(join(BASEDIR, "id1")) || existsSync(join(BASEDIR, "Id1")));
const GAME = "e2e_net_t";
const PORT = 26240;
const MAP = "dm3";
// A dedicated server has no client, so it never prints the map title
// CL_ParseServerInfo prints; the map's own .bsp load is what shows up in its
// log instead.
const MAP_LOADED = "maps/dm3.bsp";

if (HAVE_DATA) mkdirSync(join(BASEDIR, GAME), { recursive: true }); // Host_Shutdown writes config.cfg here

const logDir = mkdtempSync(join(tmpdir(), "q1-net-e2e-"));
const serverLogPath = join(logDir, "server.log");
const clientLogPath = join(logDir, "client.log");
const mainTs = join(import.meta.dir, "..", "src", "main.ts");

const headlessEnv = { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" };

// Both children write to a file descriptor rather than a pipe: a raw fd
// makes their writes land in the file as they happen, so waitForLog below
// can watch a child that is still running, with no pipe to fill up.
const serverLogFd = openSync(serverLogPath, "w");

// With no game data there is nothing for a dedicated server to serve and every
// suite below is skipped, so the child is a bun that exits at once: the handle
// still exists for afterAll and for the (skipped) stdin test to type-check
// against, and no engine is started.
const serverCmd: string[] = HAVE_DATA
  ? [
      process.execPath,
      "run",
      mainTs,
      "-basedir", BASEDIR,
      "-game", GAME,
      "-dedicated", "4",
      "-port", String(PORT),
      "-nosound",
      "+map", MAP,
    ]
  : [process.execPath, "-e", "0"];

const server = Bun.spawn({
  cmd: serverCmd,
  env: headlessEnv,
  stdin: "pipe", // a dedicated server reads its console off real stdin
  stdout: serverLogFd,
  stderr: serverLogFd,
});

function readLog(path: string): string {
  try {
    return readFileSync(path, "latin1");
  } catch {
    return "";
  }
}

async function waitForLog(path: string, needle: string, timeoutMs: number, fromOffset = 0): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readLog(path).slice(fromOffset).includes(needle)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(100);
  }
}

afterAll(async () => {
  server.kill(9);
  await server.exited;
  closeSync(serverLogFd);
  if (!process.env.Q1_KEEP_E2E_LOG) rmSync(logDir, { recursive: true, force: true });
  else console.log(`kept e2e logs in ${logDir}`);
});

/*
The client child: a real Sys_Main_Init boot with `+connect`, frames paced the
way sys_linux.c's own main loop paces Host_Frame (the server child runs in
real time, so feeding the client a fixed slice as fast as a loop can spin
would race its clock hundreds of seconds past the packets arriving), then a
`disconnect`. It reports one line of JSON the test compares whole.
*/
function buildClientScript(mode: "disconnect" | "hold"): string {
  return [
  `const { Sys_Main_Init, runFrames } = await import(${JSON.stringify(mainTs)});`,
  `const { cls, SIGNONS } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "client", "client.ts"))});`,
  `const { Sys_FloatTime } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "platform", "sys.ts"))});`,
  `const { Cbuf_AddText } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "common", "cmd.ts"))});`,
  // `connect 127.0.0.1` carries no port on purpose: WinQuake's COM_Parse
  // (common.c, "parse single characters") makes ':' a token of its own, so
  // Cmd_Argv(1) of "connect 127.0.0.1:26240" is only "127.0.0.1" and
  // PartialIPAddress fills the port in from net_hostport. `-port` is how a
  // NetQuake client picks the server's port, exactly as the C does it.
  `Sys_Main_Init(["q1ts", "-basedir", ${JSON.stringify(BASEDIR)}, "-game", ${JSON.stringify(GAME)},`,
  `  "-port", ${JSON.stringify(String(PORT))}, "-nosound", "+connect", "127.0.0.1"]);`,
  `const deadline = Date.now() + 20000;`,
  `let oldtime = Sys_FloatTime() - 0.1;`,
  `while (cls.signon !== SIGNONS && Date.now() < deadline) {`,
  `  const newtime = Sys_FloatTime();`,
  `  const elapsed = newtime - oldtime;`,
  `  oldtime = newtime;`,
  `  runFrames(1, elapsed);`,
  `  await Bun.sleep(1);`,
  `}`,
  `const signon = cls.signon;`,
  `const state = cls.state;`,
  `const address = cls.netcon ? cls.netcon.address : null;`,
  mode === "hold"
    ? // stay connected and keep pumping frames until the test kills this
      // process, so the server sees a client that simply stops talking
      [
        `console.log("E2E_HOLDING " + JSON.stringify({ signon, state, address }));`,
        `for (;;) {`,
        `  const newtime = Sys_FloatTime();`,
        `  const elapsed = newtime - oldtime;`,
        `  oldtime = newtime;`,
        `  runFrames(1, elapsed);`,
        `  await Bun.sleep(1);`,
        `}`,
      ].join("\n")
    : [
        `Cbuf_AddText("disconnect\\n");`,
        `runFrames(5, 0.05);`,
        // cl_main.c's CL_Disconnect closes the qsocket and drops the state
        // back to ca_disconnected; it deliberately leaves cls.netcon pointing
        // at the now-freed qsocket, so the socket's own `disconnected` flag is
        // what says the connection is gone.
        `const result = { signon, state, address, afterState: cls.state, afterSignon: cls.signon,`,
        `  afterDisconnected: cls.netcon ? cls.netcon.disconnected : null };`,
        `console.log("E2E_RESULT " + JSON.stringify(result));`,
        `process.exit(0);`,
      ].join("\n"),
  ].join("\n");
}

const clientScript = buildClientScript("disconnect");

function clientResultLine(log: string): string {
  for (const line of log.split("\n")) if (line.startsWith("E2E_RESULT ")) return line.slice("E2E_RESULT ".length);
  return "";
}

describe.skipIf(!HAVE_DATA)("a real client connects to a real dedicated server over UDP", () => {
  test(`the -dedicated child comes up on ${MAP} and holds port ${PORT}`, async () => {
    // Wait on the log, never by probing the port: a probe that binds 26240
    // while the child is still starting steals it from the child, which then
    // dies with "UDP_Listen: Unable to open accept socket".
    expect(await waitForLog(serverLogPath, MAP_LOADED, 90000)).toBe(true);

    // .orch/e2e/F.md's D1: NET_Init's `-port` has to reach the landriver, so
    // the accept socket binds 26240 and not DEFAULTnet_hostport (26000).
    // Nothing else can hold this port, so a bind failure here is the child's
    // own accept socket already owning it.
    expect(udpLandriver.OpenSocket(PORT)).toBe(-1);

    // ...and a port the child did not ask for is still free.
    const free = udpLandriver.OpenSocket(PORT + 1);
    expect(free).toBeGreaterThan(0);
    expect(udpLandriver.CloseSocket(free)).toBe(0);
  }, 100000);

  test("the client child reaches signon 4, then disconnects cleanly", async () => {
    const clientLogFd = openSync(clientLogPath, "w");
    const client = Bun.spawn({
      cmd: [process.execPath, "-e", clientScript],
      env: headlessEnv,
      stdout: clientLogFd,
      stderr: clientLogFd,
    });
    const exitCode = await client.exited;
    closeSync(clientLogFd);

    const log = readLog(clientLogPath);
    expect(clientResultLine(log)).toBe(
      JSON.stringify({
        signon: SIGNONS,
        state: CactiveT.ca_connected,
        address: `127.0.0.1:${PORT}`,
        afterState: CactiveT.ca_disconnected,
        afterSignon: 0,
        afterDisconnected: true,
      }),
    );
    expect(exitCode).toBe(0);

    // _Datagram_Connect's own progress messages: the retry path ("still
    // trying..."/"No Response") is what Defect A always ended in.
    expect(log).toContain("Connection accepted");
    expect(log).not.toContain("No Response");
  }, 60000);

  test("the server saw the client join", async () => {
    expect(await waitForLog(serverLogPath, "entered the game", 15000)).toBe(true);
  }, 20000);
});

/*
Bounded synchronous waits. net_dgrm.c's `_Datagram_Connect` polls
`dfunc.Read` from inside a `do { } while (ret == 0 && SetNetTime() -
start_time < 2.5)` loop, three times over, and net_main.c's `NET_Connect`
spins `while (slistInProgress) NET_Poll()` until Slist_Poll clears the flag
1.5 s in. Neither yields to the event loop, so if either bound were wrong --
or if Sys_FloatTime were a per-frame cached value rather than a live clock --
the engine would wedge instead of reporting failure.

Measured in a child process that stands up only the net stack (no Host_Init,
no video, no sound), so the number is the connect attempt itself and not a
boot time, and so nothing in `bun test`'s shared module registry is touched.
*/
describe.skipIf(!HAVE_DATA)("a connect to a dead port fails in bounded time", () => {
  const DEAD_PORT = 26243; // nothing binds this

  // A real engine boot, then `connect` typed at the console: NET_NewQSocket
  // refuses to hand out a qsocket unless svs.maxclients is set up, so a bare
  // net stack with no host hooks cannot reach _Datagram_Connect at all. The
  // measurement brackets only the console command, not the boot.
  const timingScript = [
    `const { Sys_Main_Init, runFrames } = await import(${JSON.stringify(mainTs)});`,
    `const { cls } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "client", "client.ts"))});`,
    `const { Cbuf_AddText } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "common", "cmd.ts"))});`,
    `Sys_Main_Init(["q1ts", "-basedir", ${JSON.stringify(BASEDIR)}, "-game", ${JSON.stringify(GAME)},`,
    `  "-port", ${JSON.stringify(String(DEAD_PORT))}, "-nosound"]);`,
    `runFrames(2, 0.05);`, // drain quake.rc/stuffcmds
    `const t0 = Date.now();`,
    `Cbuf_AddText("connect 127.0.0.1\\n");`,
    `runFrames(1, 0.05);`, // Host_Frame runs the whole connect attempt synchronously
    `const elapsedMs = Date.now() - t0;`,
    `console.log("TIMING " + JSON.stringify({ elapsedMs, connected: cls.netcon !== null }));`,
    `process.exit(0);`,
  ].join("\n");

  test("NET_Connect gives up with 'No Response' instead of wedging", async () => {
    const logPath = join(logDir, "timing.log");
    const fd = openSync(logPath, "w");
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", timingScript],
      env: headlessEnv,
      stdout: fd,
      stderr: fd,
    });

    const exitCode = await Promise.race([child.exited, Bun.sleep(90000).then(() => "timeout")]);
    closeSync(fd);
    if (exitCode === "timeout") child.kill(9);
    expect(exitCode).toBe(0);

    const log = readLog(logPath);
    expect(log).toContain("trying...");
    expect(log).toContain("still trying...");
    expect(log).toContain("No Response");
    expect(log).toContain("CL_Connect: connect failed");

    const line = log.split("\n").find((l) => l.startsWith("TIMING "));
    expect(line).toBeDefined();
    const measured: unknown = JSON.parse((line ?? "").slice("TIMING ".length));
    let elapsedMs = -1;
    let connected = true;
    if (typeof measured === "object" && measured !== null && "elapsedMs" in measured && "connected" in measured) {
      const e = measured.elapsedMs;
      const c = measured.connected;
      if (typeof e === "number") elapsedMs = e;
      if (typeof c === "boolean") connected = c;
    }

    expect(connected).toBe(false);
    // net_dgrm.c's own budget: 3 retries x 2.5 s = 7.5 s, after
    // NET_Connect's `while (slistInProgress) NET_Poll()` spin, which
    // Slist_Poll ends 1.5 s in. Never instant (the loop must actually run),
    // and bounded well under 20 s.
    expect(elapsedMs).toBeGreaterThan(5000);
    expect(elapsedMs).toBeLessThan(20000);
  }, 120000);
});

describe.skipIf(!HAVE_DATA)("a SIGKILLed client is timed out by the server", () => {
  test("the server drops a client whose process vanished", async () => {
    server.stdin.write("net_messagetimeout 3\n");
    server.stdin.flush();
    await Bun.sleep(500);

    const beforeJoin = readLog(serverLogPath).length;

    const holdLogPath = join(logDir, "hold.log");
    const holdFd = openSync(holdLogPath, "w");
    const holder = Bun.spawn({
      cmd: [process.execPath, "-e", buildClientScript("hold")],
      env: headlessEnv,
      stdout: holdFd,
      stderr: holdFd,
    });

    try {
      expect(await waitForLog(serverLogPath, "entered the game", 60000, beforeJoin)).toBe(true);
      expect(await waitForLog(holdLogPath, "E2E_HOLDING", 30000)).toBe(true);

      const beforeKill = readLog(serverLogPath).length;
      holder.kill(9);
      await holder.exited;

      // net_messagetimeout is 3 s; give the server room for its own frame
      // pacing on a loaded box.
      expect(await waitForLog(serverLogPath, "removed", 30000, beforeKill)).toBe(true);
    } finally {
      holder.kill(9);
      closeSync(holdFd);
    }
  }, 120000);
});
