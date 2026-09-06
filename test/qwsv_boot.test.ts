/*
Self-sufficient test for Q017: src/qw/main_sv.ts (QW/server/sys_unix.c's
main()) -- the headless qwsv boot milestone PORTING.md's QuakeWorld track
names.

The boot runs in a child `bun` process rather than in this one, and this file
asserts against the child's captured stdout plus a JSON snapshot of server
state the child prints at the end. That is not a convenience: `SV_Init` calls
`SV_InitOperatorCommands`, which registers `map`, `status`, `kick`, `say` and
thirty more names into src/common/cmd.ts's single process-wide
`cmd_functions` table, and `Cmd_AddCommand` is first-wins ("%s already
defined"). WinQuake's `Host_InitCommands` registers its own `map`
(Host_Map_f) into the same table, so in one `bun test` process exactly one of
the two trees owns the name and the other silently loses it -- whichever
suite ran first. Booting qwsv in-process therefore either runs WinQuake's
Host_Map_f (and dies in the WinQuake progs loader) or steals `map` from
test/host_cmd.test.ts and test/main_boot.test.ts, depending on file order.
The child process gives each tree its own registry, which is what the C's two
separate binaries have; see this unit's report for the src/common/cmd.ts
seam that would let the boot run in-process.

The child builds its own scratch -basedir (test/support/qwsv_fixture.ts:
id1/pak0.pak with gfx/pop.lmp and the two models SV_SpawnServer checksums,
the real retail qw/qwprogs.dat, a synthetic qw/maps/start.bsp, and a
qw/server.cfg) and drives Sys_Main_Init + runFrames, never entering
Sys_Main_Loop's infinite loop. `-port 0` binds an ephemeral UDP port
(src/qw/net_udp.ts hands the parsed `-port` value straight to Bun.udpSocket,
and 0 means "any free port"), so the boot can never collide with anything
already listening on 27500.

Standing order 13 / rule 15: this file's own child-process boot touches no
shared singleton of its own -- everything the boot mutates lives and dies in
the child. The one exception is the final describe block, added for
.orch/e2e/E.md defect C: it runs in-process (no SV_Init/Cmd_AddCommand
involved, so none of the collision risk the rest of this file's own header
describes applies) and touches two shared singletons directly --
src/client/console.ts's `qwConsoleHooks` and src/qw/server/sv_send.ts's
`sv_redirected`/`outputbuf` -- both reset in its own afterEach/afterAll.
*/

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { QWSV_FIXTURE_HOSTNAME, QWSV_FIXTURE_MAP } from "./support/qwsv_fixture";
import * as sysModule from "../src/platform/sys";
import { qwConsoleHooks, Con_Printf as WinQuakeConPrintf } from "../src/client/console";
import { Con_Printf as SvSendConPrintf, SV_BeginRedirect } from "../src/qw/server/sv_send";
import { RedirectT } from "../src/qw/server/server";
import { HAVE_QWPROGS } from "./support/fixture_availability";

const repoRoot = join(import.meta.dir, "..");

const JSON_MARKER = "<<<QWSV_BOOT_JSON>>>";

// Runs the whole boot and prints one JSON line of everything this file
// asserts on. Kept as a script rather than a checked-in driver module so the
// unit adds no source file outside its SCOPE.
const CHILD_SCRIPT = `
import { buildQwsvFixture, destroyQwsvFixture, QWSV_FIXTURE_MAP } from "./test/support/qwsv_fixture";
import { Sys_Main_Init, runFrames } from "./src/qw/main_sv";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cbuf_Execute } from "./src/common/cmd";
import { Info_ValueForKey } from "./src/qw/common";
import { PR_GetString, qwpr } from "./src/qw/server/progs";
import { ServerStateT, sv, svs } from "./src/qw/server/server";
import { SV_GetConsoleCommands, SV_Shutdown, hostname, svMainState } from "./src/qw/server/sv_main";
import { sys_extrasleep, sys_nostdout } from "./src/qw/sys_sv";

const fixture = buildQwsvFixture("qwsv-boot-child-");
try {
  Sys_Main_Init(["qwsv", "-basedir", fixture.baseDir, "-port", "0", "+map", QWSV_FIXTURE_MAP]);

  // Bun's UDP bind is asynchronous where the C's is not -- src/qw/net_udp.ts's NET_Ready.
  await NET_Ready();

  const timeAfterInit = sv.time;
  const realtimeAfterInit = svMainState.realtime;

  runFrames(10, 0.1);

  // Sys_ConsoleInput's line queue has no injection seam, so this drives the
  // same path SV_Frame does (an empty queue) and then queues the command the
  // way a typed line would.
  SV_GetConsoleCommands();
  Cbuf_AddText("status\\n");
  Cbuf_Execute();

  const world = sv.worldmodel;
  const globalStruct = qwpr.global_struct;

  const snapshot = {
    hostInitialized: svMainState.host_initialized,
    stateIsActive: sv.state === ServerStateT.ss_active,
    svName: sv.name,
    svModelname: sv.modelname,
    spawncount: svs.spawncount,
    infoMap: Info_ValueForKey(svs.info, "map"),
    infoHostname: Info_ValueForKey(svs.info, "hostname"),
    hostnameString: hostname.string,
    sysNostdout: sys_nostdout.value,
    sysExtrasleep: sys_extrasleep.value,
    worldName: world === null ? null : world.name,
    worldChecksum2: world === null ? 0 : world.checksum2,
    worldIsModelSlot1: world !== null && sv.models[1] === world,
    modelPrecache1: sv.model_precache[1],
    pvsBuilt: sv.pvs !== null,
    phsBuilt: sv.phs !== null,
    numEdicts: sv.num_edicts,
    worldClassname: PR_GetString(sv.edicts[0].v.classname),
    worldFree: sv.edicts[0].free,
    worldModelindex: sv.edicts[0].v.modelindex,
    playerModelPrecached: sv.model_precache.includes("progs/player.mdl"),
    soundPrecacheCount: sv.sound_precache.filter((s) => s !== null && s !== "").length,
    lightstyle0: sv.lightstyles[0],
    timeAfterInit,
    timeAfterFrames: sv.time,
    realtimeAfterInit,
    realtimeAfterFrames: svMainState.realtime,
    frametime: globalStruct === null ? null : globalStruct.frametime,
    hostFrametime: svMainState.host_frametime,
  };

  SV_Shutdown();
  SV_Shutdown(); // safe to repeat
  NET_Shutdown();

  process.stdout.write("${JSON_MARKER}" + JSON.stringify(snapshot) + "\\n");
} finally {
  destroyQwsvFixture(fixture);
}
process.exit(0);
`;

interface BootSnapshot {
  hostInitialized: boolean;
  stateIsActive: boolean;
  svName: string;
  svModelname: string;
  spawncount: number;
  infoMap: string;
  infoHostname: string;
  hostnameString: string;
  sysNostdout: number;
  sysExtrasleep: number;
  worldName: string | null;
  worldChecksum2: number;
  worldIsModelSlot1: boolean;
  modelPrecache1: string | null;
  pvsBuilt: boolean;
  phsBuilt: boolean;
  numEdicts: number;
  worldClassname: string;
  worldFree: boolean;
  worldModelindex: number;
  playerModelPrecached: boolean;
  soundPrecacheCount: number;
  lightstyle0: string;
  timeAfterInit: number;
  timeAfterFrames: number;
  realtimeAfterInit: number;
  realtimeAfterFrames: number;
  frametime: number | null;
  hostFrametime: number;
}

function parseSnapshot(value: unknown): BootSnapshot {
  if (typeof value !== "object" || value === null) throw new Error("boot snapshot is not an object");
  const record: Record<string, unknown> = { ...value };

  const str = (key: string): string => {
    const v = record[key];
    if (typeof v !== "string") throw new Error(`boot snapshot field ${key} is not a string`);
    return v;
  };
  const strOrNull = (key: string): string | null => {
    const v = record[key];
    if (v === null) return null;
    if (typeof v !== "string") throw new Error(`boot snapshot field ${key} is not a string or null`);
    return v;
  };
  const num = (key: string): number => {
    const v = record[key];
    if (typeof v !== "number") throw new Error(`boot snapshot field ${key} is not a number`);
    return v;
  };
  const numOrNull = (key: string): number | null => {
    const v = record[key];
    if (v === null) return null;
    if (typeof v !== "number") throw new Error(`boot snapshot field ${key} is not a number or null`);
    return v;
  };
  const bool = (key: string): boolean => {
    const v = record[key];
    if (typeof v !== "boolean") throw new Error(`boot snapshot field ${key} is not a boolean`);
    return v;
  };

  return {
    hostInitialized: bool("hostInitialized"),
    stateIsActive: bool("stateIsActive"),
    svName: str("svName"),
    svModelname: str("svModelname"),
    spawncount: num("spawncount"),
    infoMap: str("infoMap"),
    infoHostname: str("infoHostname"),
    hostnameString: str("hostnameString"),
    sysNostdout: num("sysNostdout"),
    sysExtrasleep: num("sysExtrasleep"),
    worldName: strOrNull("worldName"),
    worldChecksum2: num("worldChecksum2"),
    worldIsModelSlot1: bool("worldIsModelSlot1"),
    modelPrecache1: strOrNull("modelPrecache1"),
    pvsBuilt: bool("pvsBuilt"),
    phsBuilt: bool("phsBuilt"),
    numEdicts: num("numEdicts"),
    worldClassname: str("worldClassname"),
    worldFree: bool("worldFree"),
    worldModelindex: num("worldModelindex"),
    playerModelPrecached: bool("playerModelPrecached"),
    soundPrecacheCount: num("soundPrecacheCount"),
    lightstyle0: str("lightstyle0"),
    timeAfterInit: num("timeAfterInit"),
    timeAfterFrames: num("timeAfterFrames"),
    realtimeAfterInit: num("realtimeAfterInit"),
    realtimeAfterFrames: num("realtimeAfterFrames"),
    frametime: numOrNull("frametime"),
    hostFrametime: num("hostFrametime"),
  };
}

let bootLog = "";
let bootStderr = "";
let bootExitCode = -1;
let snapshot: BootSnapshot | null = null;

beforeAll(() => {
  // No throw either way: the child script's own buildQwsvFixture() would
  // throw "missing test fixture" with no QW/progs/qwprogs.dat reachable, but
  // the describe() below is wrapped in describe.skipIf(!HAVE_QWPROGS), so
  // there is no point spawning a child doomed to fail for tests that never run.
  if (!HAVE_QWPROGS) return;

  const proc = Bun.spawnSync(["timeout", "120", "bun", "-e", CHILD_SCRIPT], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  bootLog = new TextDecoder().decode(proc.stdout);
  bootStderr = new TextDecoder().decode(proc.stderr);
  bootExitCode = proc.exitCode ?? -1;

  const markerAt = bootLog.indexOf(JSON_MARKER);
  if (markerAt === -1) return;
  const lineEnd = bootLog.indexOf("\n", markerAt);
  const jsonText = bootLog.slice(markerAt + JSON_MARKER.length, lineEnd === -1 ? undefined : lineEnd);
  snapshot = parseSnapshot(JSON.parse(jsonText));
});

function requireSnapshot(): BootSnapshot {
  if (snapshot === null) throw new Error(`qwsv boot produced no snapshot.\nstdout:\n${bootLog}\nstderr:\n${bootStderr}`);
  return snapshot;
}

describe.skipIf(!HAVE_QWPROGS)("Sys_Main_Init + runFrames -- a real qwsv boot", () => {
  test("the boot process exits cleanly and never reaches SV_Error", () => {
    expect(bootExitCode).toBe(0);
    expect(bootStderr).toBe("");
    expect(bootLog).not.toContain("SV_Error");
    expect(bootLog).not.toContain("Fatal");
  });

  test("SV_Init's own banner reaches stdout", () => {
    expect(bootLog).toContain("Playing registered version.");
    expect(bootLog).toContain("Exe: ");
    expect(bootLog).toContain("Server Version ");
    expect(bootLog).toContain("======== QuakeWorld Initialized ========");
    expect(bootLog).toContain("UDP Initialized");
  });

  test("SV_Init runs server.cfg", () => {
    expect(bootLog).toContain("execing server.cfg");
    const s = requireSnapshot();
    expect(s.hostnameString).toBe(QWSV_FIXTURE_HOSTNAME);
    expect(s.infoHostname).toBe(QWSV_FIXTURE_HOSTNAME);
  });

  test("Sys_Init registers sys_unix.c's own cvars", () => {
    const s = requireSnapshot();
    expect(s.sysNostdout).toBe(0);
    expect(s.sysExtrasleep).toBe(0);
  });

  test("`+map start` spawned an active server", () => {
    const s = requireSnapshot();
    expect(s.hostInitialized).toBe(true);
    expect(s.stateIsActive).toBe(true);
    expect(s.svName).toBe(QWSV_FIXTURE_MAP);
    expect(s.svModelname).toBe(`maps/${QWSV_FIXTURE_MAP}.bsp`);
    expect(s.spawncount).toBeGreaterThan(0);
    expect(s.infoMap).toBe(QWSV_FIXTURE_MAP);
  });

  test("the world model loaded, with a nonzero checksum2", () => {
    const s = requireSnapshot();
    expect(s.worldName).toBe(`maps/${QWSV_FIXTURE_MAP}.bsp`);
    expect(s.worldChecksum2).not.toBe(0);
    expect(s.worldIsModelSlot1).toBe(true);
    expect(s.modelPrecache1).toBe(`maps/${QWSV_FIXTURE_MAP}.bsp`);
    // SV_CalcPHS ran over it
    expect(bootLog).toContain("Building PHS...");
    expect(s.pvsBuilt).toBe(true);
    expect(s.phsBuilt).toBe(true);
  });

  test("qwprogs' worldspawn ran on edict 0", () => {
    const s = requireSnapshot();
    expect(s.numEdicts).toBeGreaterThan(0);
    expect(s.worldFree).toBe(false);
    expect(s.worldClassname).toBe("worldspawn");
    expect(s.worldModelindex).toBe(1);

    // its precache_model / precache_sound / lightstyle builtin calls
    expect(s.playerModelPrecached).toBe(true);
    expect(s.soundPrecacheCount).toBeGreaterThan(0);
    expect(s.lightstyle0).toBe("m");
  });

  test("StartFrame runs and the server clock advances per frame", () => {
    const s = requireSnapshot();
    // SV_Frame: `if (!sv.paused) { realtime += time; sv.time += time; }`
    expect(s.timeAfterFrames - s.timeAfterInit).toBeCloseTo(1.0, 5);
    expect(s.realtimeAfterFrames - s.realtimeAfterInit).toBeCloseTo(1.0, 5);
    // SV_Physics -> SV_ProgStartFrame: pr_global_struct->frametime =
    // host_frametime, bounded by sv_mintic/sv_maxtic
    expect(s.frametime).toBeCloseTo(0.1, 5);
    expect(s.hostFrametime).toBeCloseTo(0.1, 5);
  });

  test("a `status` console command runs through Cbuf without throwing", () => {
    expect(bootLog).toContain("net address      : ");
    expect(bootLog).toContain("cpu utilization  : ");
  });
});

//=============================================================================
// .orch/e2e/E.md defect C: five modules shared with qwcl (src/qw/common.ts,
// cmd.ts, net_chan.ts, net_udp.ts, pmovetst.ts) call Con_Printf/Con_DPrintf
// imported from src/client/console.ts (WinQuake's file). qwcl installs
// `qwConsoleHooks` to redirect those calls into its own console; qwsv
// (src/qw/main_sv.ts's Sys_Main_Init) now does the same, pointed at
// src/qw/server/sv_send.ts's redirect-aware Con_Printf instead -- the one
// real Con_Printf implementation in the qwsv binary (see that file's own
// header). Before this fix, a Con_Printf from one of those five files fell
// through to console.ts's own bare-Sys_Printf body, bypassing
// SV_BeginRedirect/outputbuf entirely: a client's `rcon`/`cmd status`
// redirect would see nothing back if the message happened to originate from
// one of those five files.
//
// In-process (not the child-process harness above): no SV_Init/Cmd_AddCommand
// call is involved, so none of this file's own collision concern applies.
// Mirrors the hook wiring src/qw/main_sv.ts's Sys_Main_Init does, without
// running a whole boot.
//=============================================================================

describe("qwsv Con_Printf redirect reaches shared modules (.orch/e2e/E.md defect C)", () => {
  const savedHook = qwConsoleHooks.Con_Printf;
  const sysPrintfSpy = spyOn(sysModule, "Sys_Printf"); // bare call-through spy (rule 15)

  beforeAll(() => {
    // the same link step src/qw/main_sv.ts's Sys_Main_Init performs
    qwConsoleHooks.Con_Printf = SvSendConPrintf;
  });

  afterEach(() => {
    sysPrintfSpy.mockClear();
    SV_BeginRedirect(RedirectT.RD_NONE); // clears sv_redirected and outputbuf, no network send
  });

  afterAll(() => {
    qwConsoleHooks.Con_Printf = savedHook;
    sysPrintfSpy.mockRestore();
  });

  test("without a redirect window, a shared module's Con_Printf still reaches the server's real stdout", () => {
    WinQuakeConPrintf("SYSEXIT_E_C_MARKER_NO_REDIRECT\n");
    const printed = sysPrintfSpy.mock.calls.filter((c) => String(c[1]).includes("SYSEXIT_E_C_MARKER_NO_REDIRECT"));
    expect(printed.length).toBeGreaterThan(0);
  });

  test("SV_BeginRedirect(RD_CLIENT) captures a shared module's Con_Printf instead of printing it locally", () => {
    SV_BeginRedirect(RedirectT.RD_CLIENT);
    WinQuakeConPrintf("SYSEXIT_E_C_MARKER_REDIRECTED\n");
    const printed = sysPrintfSpy.mock.calls.filter((c) => String(c[1]).includes("SYSEXIT_E_C_MARKER_REDIRECTED"));
    // The whole point of the fix: this message must NOT reach the server's
    // own stdout while a redirect window (rcon / `cmd status` from a client)
    // is open -- it belongs in sv_send.ts's outputbuf instead.
    expect(printed.length).toBe(0);
  });
});
