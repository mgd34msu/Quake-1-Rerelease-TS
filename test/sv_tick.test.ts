/*
U33 step 2: the re-release fixed-step server clock (`sv_tickrate`, host.ts's
Host_ServerFrame/Host_FilterTime) under the rerelease ruleset, and the
classic frame-coupled fallback (sv_tickrate 0, or the classic ruleset).

Self-sufficient per standing order 13: reuses test/support/dedicated_fixture.ts
(test/main_boot.test.ts's own recipe) to drive a real `-dedicated 1` boot
through src/main.ts's Sys_Main_Init + runFrames, the same way
test/main_boot.test.ts's own clock assertion does, so this file's classic-path
tests double as a second witness for that one staying green. Every
process-wide flag Sys_Main_Init/Host_Init touches, plus sv_ruleset/sv_tickrate
and host.svTickAccumulator, is captured before and restored in afterAll (`bun
test` runs every file in one process).
*/

import { describe, expect, test, afterAll } from "bun:test";
import { cmdHost } from "../src/common/cmd";
import { conState } from "../src/client/console";
import { setCvarServerHooks, Cvar_FindVar, Cvar_Set } from "../src/common/cvar";
import { Host_Shutdown, Host_ServerFrame, host, sv_tickrate } from "../src/common/host";
import {
  getNetHostHooks,
  net_activeconnections,
  net_landrivers,
  setNetActiveConnections,
  setNetHostHooks,
  setNetNumLandrivers,
  tcpipAvailable,
  my_tcpip_address,
  setTcpipAvailable,
  setMyTcpipAddress,
} from "../src/common/net_main";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { sv, svState, svs } from "../src/server/server";
import { Sys_Main_Init, runFrames } from "../src/main";
import { sv_ruleset, RULESET_CLASSIC, RULESET_RERELEASE } from "../src/progs/ext/ruleset";
import { buildDedicatedFixture, destroyDedicatedFixture, type DedicatedFixture } from "./support/dedicated_fixture";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const savedNostdout = sysState.nostdout;
const savedIsDedicated = sysState.isDedicated;
const savedCmdInitialized = cmdHost.initialized;
const savedNetHooks = getNetHostHooks();
const savedTcpipAvailable = tcpipAvailable;
const savedMyTcpipAddress = my_tcpip_address;
const savedHostnameCvar = Cvar_FindVar("hostname");
const savedHostnameValue = savedHostnameCvar !== null ? savedHostnameCvar.string : null;
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
const savedActiveConnections = net_activeconnections;
const savedLandriverCount = net_landrivers.length;
const savedConInitialized = conState.con_initialized;
const savedSvRuleset = sv_ruleset.string;
const savedSvTickrate = sv_tickrate.string;
const savedTickAccumulator = host.svTickAccumulator;

const builtFixtures: DedicatedFixture[] = [];

afterAll(() => {
  setTcpipAvailable(savedTcpipAvailable);
  setMyTcpipAddress(savedMyTcpipAddress);
  if (Cvar_FindVar("hostname") !== null) Cvar_Set("hostname", savedHostnameValue !== null ? savedHostnameValue : "UNNAMED");
  sysState.nostdout = savedNostdout;
  sysState.isDedicated = savedIsDedicated;
  cmdHost.initialized = savedCmdInitialized;
  setNetHostHooks(savedNetHooks);
  setHostShutdown(null);
  setCvarServerHooks(null);
  setNetActiveConnections(savedActiveConnections);
  net_landrivers.length = savedLandriverCount;
  setNetNumLandrivers(savedLandriverCount);
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;
  svState.host_client = null;
  svState.sv_player = null;
  sv.clear();
  conState.con_initialized = savedConInitialized;
  sv_ruleset.string = savedSvRuleset;
  sv_tickrate.string = savedSvTickrate;
  sv_tickrate.value = Number(savedSvTickrate);
  host.svTickAccumulator = savedTickAccumulator;
  for (const fixture of builtFixtures) destroyDedicatedFixture(fixture);
});

// See test/main_boot.test.ts's own copy of this helper for why
// cmdHost.initialized is reset before every boot in this process.
function bootDedicated(argv: string[]): void {
  cmdHost.initialized = false;
  Sys_Main_Init(argv);
}

describe("Host_ServerFrame's rerelease fixed-step clock", () => {
  test.skipIf(!HAVE_PROGS106)("rerelease ruleset + sv_tickrate 72: ten 0.05s frames advance sv.time by 0.5s in 36 steps", () => {
    const fixture = buildDedicatedFixture("sv-tick-72-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-dedicated", "1", "-basedir", fixture.baseDir, "+map", "world"]);
    runFrames(1, 0.05); // drains "exec quake.rc" -> "+map world", as in main_boot.test.ts
    expect(sv.active).toBe(true);

    Cvar_Set("sv_ruleset", RULESET_RERELEASE);
    Cvar_Set("sv_tickrate", "72");
    host.svTickAccumulator = 0; // a clean slate for the timed run below

    const t1 = sv.time;
    runFrames(10, 0.05); // 0.5s of real time
    const t2 = sv.time;

    // dt = 1/72; 10*0.05 = 0.5s of real time is spent in exactly 0.5/dt = 36
    // dt-sized chunks (36*dt = 0.5 exactly), so this single delta assertion
    // doubles as a step-count check -- a different step count would land on
    // a visibly different multiple of dt (35*dt = 0.4861, 37*dt = 0.5139).
    expect(t2 - t1).toBeCloseTo(0.5, 6);

    expect(() => Host_Shutdown()).not.toThrow();
  });

  test.skipIf(!HAVE_PROGS106)("sv_tickrate 0 under the rerelease ruleset falls back to the classic frame-coupled path", () => {
    const fixture = buildDedicatedFixture("sv-tick-0-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-dedicated", "1", "-basedir", fixture.baseDir, "+map", "world"]);
    runFrames(1, 0.05);
    expect(sv.active).toBe(true);

    Cvar_Set("sv_ruleset", RULESET_RERELEASE);
    Cvar_Set("sv_tickrate", "0");
    host.svTickAccumulator = 0;

    const t1 = sv.time;
    runFrames(10, 0.05);
    const t2 = sv.time;

    // Host_ServerFrame's `rerelease` branch never triggers with sv_tickrate
    // 0, so this is the same `sv.time += host.frametime` once per server
    // frame test/main_boot.test.ts's own clock assertion checks.
    expect(t2 - t1).toBeCloseTo(0.5, 2);
    expect(host.svTickAccumulator).toBe(0); // never touched outside the rerelease branch

    expect(() => Host_Shutdown()).not.toThrow();
  });

  test.skipIf(!HAVE_PROGS106)("the classic ruleset keeps the frame-coupled path even with sv_tickrate 72", () => {
    const fixture = buildDedicatedFixture("sv-tick-classic-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-dedicated", "1", "-basedir", fixture.baseDir, "+map", "world"]);
    runFrames(1, 0.05);
    expect(sv.active).toBe(true);

    Cvar_Set("sv_ruleset", RULESET_CLASSIC);
    Cvar_Set("sv_tickrate", "72");
    host.svTickAccumulator = 0;

    const t1 = sv.time;
    runFrames(10, 0.05);
    const t2 = sv.time;

    expect(t2 - t1).toBeCloseTo(0.5, 2);
    expect(host.svTickAccumulator).toBe(0);

    expect(() => Host_Shutdown()).not.toThrow();
  });

  test.skipIf(!HAVE_PROGS106)("a single oversized frame clamps to SV_TICK_MAX_STEPS(4) instead of spiralling", () => {
    const fixture = buildDedicatedFixture("sv-tick-clamp-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-dedicated", "1", "-basedir", fixture.baseDir, "+map", "world"]);
    runFrames(1, 0.05);
    expect(sv.active).toBe(true);

    Cvar_Set("sv_ruleset", RULESET_RERELEASE);
    Cvar_Set("sv_tickrate", "72");

    // Simulate a large backlog (e.g. a long stall) directly, bypassing
    // Host_FilterTime's own 0.1s-per-call clamp so the accumulator alone
    // drives the scenario: 1 second of pent-up time is far more than
    // SV_TICK_MAX_STEPS*dt (4/72 = 0.0556s).
    host.svTickAccumulator = 1;
    host.frametime = 0;

    const t1 = sv.time;
    Host_ServerFrame();
    const t2 = sv.time;

    const dt = 1 / 72;
    expect(t2 - t1).toBeCloseTo(4 * dt, 6); // exactly 4 steps' worth, not ~72
    // The un-run remainder stays in the accumulator (this design's own
    // choice per ARCHITECTURE.md -- see Host_ServerFrame's own comment):
    // the sim falls behind real time under sustained overload rather than
    // discarding it or trying to burn through the whole backlog at once.
    expect(host.svTickAccumulator).toBeCloseTo(1 - 4 * dt, 6);

    expect(() => Host_Shutdown()).not.toThrow();
  });
});
