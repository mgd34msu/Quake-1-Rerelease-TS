/*
Self-sufficient per standing order 13: builds its own scratch dedicated-server
fixtures (test/support/dedicated_fixture.ts, the same recipe
test/host_cmd.test.ts uses, factored out per this unit's brief since that
file exports no builder of its own) and drives a real `-dedicated 1` boot
through src/main.ts's Sys_Main_Init + runFrames, never entering
Sys_Main_Loop's infinite loop.

Every process-wide flag Sys_Main_Init/Host_Init touches is captured before
and restored in afterAll (`bun test` runs every file in one process).
*/

import { describe, expect, test, afterAll } from "bun:test";
import { cmdHost } from "../src/common/cmd";
import { conState } from "../src/client/console";
import { setCvarServerHooks, Cvar_FindVar, Cvar_Set } from "../src/common/cvar";
import { Host_Shutdown, host } from "../src/common/host";
import { getNetHostHooks, net_activeconnections, net_landrivers, setNetActiveConnections, setNetHostHooks, setNetNumLandrivers, tcpipAvailable, my_tcpip_address, setTcpipAvailable, setMyTcpipAddress } from "../src/common/net_main";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { sv, svState, svs } from "../src/server/server";
import { Sys_Main_Init, runFrames } from "../src/main";
import { sndDma } from "../src/client/sound";
import { cdAudio } from "../src/client/cdaudio";
import { S_Init } from "../src/client/snd_dma";
import { COM_InitArgv, com_argc, com_argv } from "../src/common/common";
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
// Sys_Main_Init's own `registerLandriver(udpLandriver)` call (src/main.ts,
// guarded so it only ever pushes once per process) leaves udpLandriver in
// net_main.ts's shared `net_landrivers[]`/`net_numlandrivers` forever --
// nothing else in this port ever un-registers a landriver. A suite that
// hard-codes a landriver index against a fake table of its own (e.g.
// net_dgrm.test.ts's `fakeLandriver` at index 0) breaks if this file's boot
// runs first and shifts every later registration up by one, so this file
// restores both back to their pre-test length (rule 15).
const savedLandriverCount = net_landrivers.length;
// Host_Init calls console.ts's Con_Init directly (host.ts:1103, even on a
// dedicated boot), which sets conState.con_initialized = true and is never
// unset by anything else in this port; a later suite's Con_Printf call
// would otherwise see it still true process-wide and take the "signon !=
// SIGNONS" redraw branch it never used to reach.
const savedConInitialized = conState.con_initialized;

const builtFixtures: DedicatedFixture[] = [];

afterAll(() => {
  setTcpipAvailable(savedTcpipAvailable);
  setMyTcpipAddress(savedMyTcpipAddress);
  // UDP_Init (net_udp.c) sets `hostname` from gethostname when it is still UNNAMED; put back what this file found
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
  for (const fixture of builtFixtures) destroyDedicatedFixture(fixture);
});

// Host_Init's own Cmd_AddCommand calls (via Host_InitLocal -> host_cmd.ts's
// Host_InitCommands) throw Sys_Error once cmd.ts's cmdHost.initialized is
// true (cmd.ts:422) -- the same "a previous suite in this process may have
// set it" reset test/host_cmd.test.ts's beforeAll already needs, required
// here too since this file calls Host_Init (through Sys_Main_Init) more
// than once.
function bootDedicated(argv: string[]): void {
  cmdHost.initialized = false;
  Sys_Main_Init(argv);
}

describe("Sys_Main_Init + runFrames -- a real dedicated boot", () => {
  test.skipIf(!HAVE_PROGS106)("`+map world` spawns progs106's worldspawn and the server clock advances per frame", () => {
    const fixture = buildDedicatedFixture("main-boot-map-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-dedicated", "1", "-basedir", fixture.baseDir, "+map", "world"]);

    expect(host.initialized).toBe(true);
    expect(sysState.isDedicated).toBe(true);
    expect(svs.maxclients).toBe(1);
    expect(sv.active).toBe(false); // Host_Init only queues "exec quake.rc"; nothing has run it yet

    // The first frame's Cbuf_Execute drains "exec quake.rc" -> "exec
    // default.cfg" + "stuffcmds" -> "map world" (Host_Map_f), all before
    // that same frame's Host_ServerFrame call -- see cmd.ts's
    // Cbuf_Execute/Cbuf_InsertText, which re-scans the buffer after every
    // inserted command instead of waiting for the next frame.
    runFrames(1, 0.05);
    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");

    const t1 = sv.time;
    runFrames(10, 0.05);
    const t2 = sv.time;
    // sv_phys.ts's SV_Physics: `sv.time += host.frametime` once per server
    // frame while active and unpaused (svs.maxclients === 1 and no client
    // hook installed takes host.ts's Host_ServerFrame default of "always
    // run physics on a dedicated server").
    expect(t2 - t1).toBeCloseTo(0.5, 2);

    expect(() => Host_Shutdown()).not.toThrow();
    expect(() => Host_Shutdown()).not.toThrow(); // isdown guard, host.ts:1154 ("recursive shutdown")
  });

  test.skipIf(!HAVE_PROGS106)("`-nostdout` sets sysState.nostdout", () => {
    const fixture = buildDedicatedFixture("main-boot-nostdout-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-nostdout", "-dedicated", "1", "-basedir", fixture.baseDir]);

    expect(sysState.nostdout).toBe(1);

    expect(() => Host_Shutdown()).not.toThrow();
  });
});

/*
Q026: src/main.ts links snd_linux.c/cd_linux.c the way the C's Makefile does
-- src/platform/snd.ts and src/platform/cd_ogg.ts install sndDma.current /
cdAudio.current at module load and nothing else in the tree imports them, so
without those two side-effect imports Host_Init's S_Init and CDAudio_Init
would find both holders empty. The in-process assertion below can be
satisfied by another suite in this process having imported either platform
module first (bun shares one module registry), so the child process is what
actually proves src/main.ts's own import graph installs them.
*/
describe("the sound and CD backends src/main.ts links", () => {
  test.skipIf(!HAVE_PROGS106)("sndDma.current and cdAudio.current are installed once src/main.ts is loaded", () => {
    const fixture = buildDedicatedFixture("main-boot-snd-");
    builtFixtures.push(fixture);

    bootDedicated(["q1ts", "-dedicated", "1", "-nosound", "-basedir", fixture.baseDir]);

    expect(host.initialized).toBe(true);
    expect(sndDma.current).not.toBeNull();
    expect(cdAudio.current).not.toBeNull();

    expect(() => Host_Shutdown()).not.toThrow();
  });

  test("importing src/main.ts in a fresh process installs both holders", () => {
    const probe = [
      'await import("' + import.meta.dir + '/../src/main.ts");',
      'const { sndDma } = await import("' + import.meta.dir + '/../src/client/sound.ts");',
      'const { cdAudio } = await import("' + import.meta.dir + '/../src/client/cdaudio.ts");',
      'console.log(JSON.stringify({ snd: sndDma.current !== null, cd: cdAudio.current !== null }));',
    ].join("\n");

    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", probe],
      env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(JSON.stringify({ snd: true, cd: true }));
  });

  // snd_dma.c's S_Init returns right after the banner when -nosound is on the
  // command line, so it never reaches SNDDMA_Init/the SDL audio device.
  test("S_Init with -nosound does not throw under the dummy audio driver", () => {
    const savedArgv = com_argv.slice();
    const savedArgc = com_argc;
    try {
      COM_InitArgv(["q1ts", "-nosound"]);
      expect(() => S_Init()).not.toThrow();
    } finally {
      COM_InitArgv(["q1ts", ...savedArgv.slice(1, savedArgc)]);
    }
  });
});
