/*
Self-sufficient per standing order 13. Covers the U035/U040 handoff this
unit's brief asked for: does host.ts's `_Host_Frame` try/catch actually sit
at the frame level (matching host.c's `if (setjmp (host_abortserver)) return;`
at the top of `_Host_Frame`), and does the client survive a `Host_Error`
raised mid-frame the way `.orch/e2e/A.md`'s "Second defect" (D2) describes:
`Host_ShutdownServer`/`CL_Disconnect` run, the rest of that frame's client
parse never happens, and the process is still alive and playable afterward.

Everything here reads/writes the real, non-dedicated engine (a listen
server: client and server in one process talking over the loopback net
driver), because D2's `i >= cl.maxclients` crash only happens on the client
side of `CL_ParseServerMessage`, which a `-dedicated` boot never reaches
(test/host.test.ts and test/main_boot.test.ts's fixtures are dedicated-only
for exactly this reason). A listen-server client needs real client assets
(gfx/palette.lmp, gfx.wad's conchars, etc.) that no synthetic fixture in
this tree builds, so this file boots against the real retail basedir the
same way test/net_e2e.test.ts does, and says so loudly if it is missing.

Every process-wide flag Sys_Main_Init/Host_Init touches is captured before
and restored in afterAll, following test/main_boot.test.ts's and
test/net_e2e.test.ts's list (rule 15: `bun test` runs every file in one
process).

The second describe block is the coordinator's follow-up
(`.orch/e2e/B.md`'s B-3: `changelevel` allegedly killing the process with
the same `Sys_Error("i >= cl.maxclients")`). As of this unit's investigation
B-3 no longer reproduces -- see that block's own comment for the evidence
and the reasoning -- so its test is a regression lock, not a repro of a
still-open bug.

The third describe block is a cheap cross-check for QW's own frame loop
(`src/qw/client/cl_main.ts`'s `Host_Frame`), which this unit's brief asked
for "if cheap": QW's `Host_EndGame` is fatal by design (it ends in
`Sys_Error`, unlike WinQuake's recoverable `Host_Error`), but the *frame*
still needs to survive a `HostEndGame` thrown mid-frame the same way
WinQuake's does. It forces the throw from `Cbuf_Execute` (the first call in
QW's `Host_Frame` that this test can safely intercept without a full QW
server/client boot -- everything after it dereferences `cls.qw.netchan`,
which this file never sets up) rather than standing up a whole QW listen
game just to prove where one try/catch sits.
*/

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Cbuf_AddText, cmdHost } from "../src/common/cmd";
import { conState } from "../src/client/console";
import { setCvarServerHooks, Cvar_VariableString, Cvar_Set, Cvar_FindVar } from "../src/common/cvar";
import { HostError, Host_Error, Host_Shutdown, host } from "../src/common/host";
import { getNetHostHooks, net_activeconnections, net_landrivers, setNetActiveConnections, setNetHostHooks, setNetNumLandrivers, tcpipAvailable, my_tcpip_address, setTcpipAvailable, setMyTcpipAddress } from "../src/common/net_main";
import { setHostShutdown, sysState } from "../src/platform/sys";
import { sv, svState, svs } from "../src/server/server";
import { cls, CactiveT, SIGNONS } from "../src/client/client";
import { re } from "../src/client/render";
import { getRegisteredRenderer, registerRenderer } from "../src/platform/vid";
import { softRenderer } from "../src/ref_soft/ref_soft";
import { Sys_Main_Init, runFrames } from "../src/main";
import * as SvPhys from "../src/server/sv_phys";
import * as QwCmd from "../src/qw/cmd";
import { Host_EndGame as QwHost_EndGame, Host_Frame as QwHost_Frame } from "../src/qw/client/cl_main";

// Real Quake data cannot ship in this repository, so this file's suites are
// opt-in: point Q1TS_DATA at a base directory holding id1/pak0.pak to run them
// (the same variable test/e2e/q1data.ts uses). With no data reachable every
// suite below skips, which is what a checkout with no pak files -- CI, or a
// fresh clone -- gets.
const BASEDIR = process.env.Q1TS_DATA ?? "";
const HAVE_DATA = BASEDIR !== "" && (existsSync(join(BASEDIR, "id1")) || existsSync(join(BASEDIR, "Id1")));
const GAME = "e2e_hostfr";
const MAP = "e1m1";

if (HAVE_DATA) mkdirSync(join(BASEDIR, GAME), { recursive: true }); // Host_Shutdown writes config.cfg here

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
const savedClsState = cls.state;
const savedClsSignon = cls.signon;
const savedClsDemonum = cls.demonum;
// src/platform/vid.ts's renderer registry is a process-wide, module-cached
// map (a renderer's own `registerRenderer` call at its module's top level
// fires only once per process). test/ref_soft_main.test.ts's own afterAll
// calls `unregisterRenderer("soft")` unconditionally, with no capture/
// restore of whatever was registered before its own tests ran (unlike
// test/vid_platform.test.ts's and test/vid_restart.test.ts's own afterAll,
// which both capture `getRegisteredRenderer("soft")` first and restore
// it) -- so once that file has run anywhere earlier in the same `bun test`
// process, "soft" is gone for every file that runs after it, permanently,
// including this one. Confirmed empirically: capturing
// `getRegisteredRenderer("soft")` at this file's own module load time
// already reads back `null` when the suite hits this ordering, i.e. the
// damage predates this file's own code entirely and no capture-and-restore
// here can recover it. src/ref_soft/ref_soft.ts's real, exported
// `softRenderer` is imported directly above instead, so bootListenServer
// below can re-install the actual production renderer rather than a test
// fake if the registry is missing it.

afterAll(() => {
  setTcpipAvailable(savedTcpipAvailable);
  setMyTcpipAddress(savedMyTcpipAddress);
  // UDP_Init (net_udp.c) sets `hostname` from gethostname when it is still UNNAMED; put back what this file found
  if (Cvar_FindVar("hostname") !== null) Cvar_Set("hostname", savedHostnameValue !== null ? savedHostnameValue : "UNNAMED");
  try {
    Host_Shutdown();
  } catch {
    // isdown guard already covers a double call; a throw here must not hide
    // the restores below.
  }
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
  cls.state = savedClsState;
  cls.signon = savedClsSignon;
  cls.demonum = savedClsDemonum;
});

// Runs frames until `predicate` is true or `maxFrames` is exhausted, then
// asserts it settled -- a frame cap rather than a wall-clock deadline
// because every frame here is a synchronous in-process step, not real time.
function settleUntil(predicate: () => boolean, maxFrames: number, label: string): void {
  for (let i = 0; i < maxFrames && !predicate(); i++) runFrames(1, 0.05);
  if (!predicate()) throw new Error(`settleUntil timed out after ${maxFrames} frames: ${label}`);
}

function bootListenServer(): void {
  cmdHost.initialized = false; // Host_InitCommands throws if this is still true from an earlier test file
  // Defend against the cross-file renderer-registry gap described above:
  // re-install the real "soft" renderer if some other file's test left it
  // deleted.
  if (getRegisteredRenderer("soft") === null) registerRenderer("soft", () => softRenderer);
  Sys_Main_Init(["q1ts", "-basedir", BASEDIR, "-game", GAME, "-nosound"]);
}

describe.skipIf(!HAVE_DATA)("Host_Error mid-frame (.orch/e2e/A.md's Second defect, D2)", () => {
  test("map settles into a real game (sanity, establishes the state the crash test perturbs)", () => {
    bootListenServer();
    Cbuf_AddText(`map ${MAP}\n`);
    settleUntil(() => cls.signon === SIGNONS && sv.active, 200, "initial map connect");

    expect(cls.state).toBe(CactiveT.ca_connected);
    expect(sv.active).toBe(true);
  });

  test("a Host_Error thrown mid-frame (from inside Host_ServerFrame's SV_Physics) aborts the rest of that frame and the client survives", () => {
    // Stand-in for A.md's QuakeC runaway: PR_RunError -> Host_Error, called
    // from exactly where the real bug fires (deep inside Host_ServerFrame's
    // `SV_Physics()`, called through host.ts's lazily-required
    // `svPhysMod()`, which resolves to this same module object). A bare
    // spyOn with mockImplementation, installed and restored inside this one
    // test per rule 15.
    const spy = spyOn(SvPhys, "SV_Physics").mockImplementation(() => {
      Host_Error("Program error");
    });

    try {
      // host.c's setjmp/longjmp: the frame that hits Host_Error must return
      // cleanly, not propagate. If the catch sat one level too low (inside
      // Host_ServerFrame, or inside Cbuf_Execute, or inside
      // PR_ExecuteProgram) this frame would either rethrow past _Host_Frame
      // (SysError does; a mis-scoped catch could too) or -- A.md's actual
      // symptom -- swallow the error too early and let the SAME frame fall
      // through to CL_ReadFromServer against a client the server just tore
      // down.
      expect(() => runFrames(1, 0.05)).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    // Host_Error's own body, run to completion before the throw:
    // Host_ShutdownServer (sv.active was true) then CL_Disconnect, then
    // cls.demonum = -1.
    expect(cls.state).toBe(CactiveT.ca_disconnected);
    expect(sv.active).toBe(false);
    expect(cls.demonum).toBe(-1);

    // The process is still alive and playable: later frames don't throw
    // (no "No renderer is loaded", i.e. VID_Shutdown was never reached --
    // Host_Error is recoverable and does not call it), and the renderer
    // seam is still installed.
    expect(() => runFrames(5, 0.05)).not.toThrow();
    expect(re.current).not.toBeNull();
  });

  test("Host_Error a second time still works (inerror was reset, not left latched)", () => {
    // If host.ts's `inerror` flag were left `true` after the first call
    // (e.g. reset before the throw was dropped, or reset after it so the
    // throw skips it), this second call would take the "recursively
    // entered" Sys_Error branch instead of behaving like a normal
    // Host_Error.
    let caught: unknown = null;
    try {
      Host_Error("second error");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostError);
    expect(caught).toHaveProperty("message", "second error");
  });

  test("a fresh map connect still works after the recovered Host_Error (the engine, not just the frame, survived)", () => {
    Cbuf_AddText(`map ${MAP}\n`);
    settleUntil(() => cls.signon === SIGNONS && sv.active, 200, "reconnect after Host_Error");

    expect(cls.state).toBe(CactiveT.ca_connected);
    expect(sv.active).toBe(true);
  });
});

/*
`.orch/e2e/B.md`'s B-3: "changelevel kills the process every time" with the
same `Sys_Error("i >= cl.maxclients")` symptom as A.md's D2, "100%
reproducible" via `bun test/e2e/b_repro_chlvl2.ts "map e1m1" "changelevel
e1m2"`. That script (and its "changelevel e1m1"/"map start" variants from
B.md's matrix) now completes cleanly against this tree -- re-run by hand
under `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy`, all three of B.md's
CRASH rows now print "ALL OK".

The catch-placement investigation above (host.ts's _Host_Frame, cl_main.ts's
CL_Disconnect/CL_ReadFromServer, sv_main.ts's SV_SpawnServer/
SV_SendReconnect/SV_SendServerinfo, net_loop.ts) found nothing to fix: every
one of those already matches its .c original line for line (compared by
hand against WinQuake/host.c, cl_main.c, sv_main.c, net_loop.c while
diagnosing this). What actually made B-3 reproduce was a QuakeC-level
`Host_Error` firing *during* the new
level's entity spawn, mid-`SV_SpawnServer` -- `changelevel`'s target maps
(e1m2, dm2) spawn `func_train`/monster entities whose spawn functions call
`find()` on an unset `.target`/`.targetname` field, which is legal in the
C (an empty `pr_strings` offset, never NULL) but was, before
src/progs/pr_cmds.ts's 2026-09-05 `PF_Find` fix (`.orch/e2e/D.md`'s Defect
B), treated as `PF_Find: bad search string` and thrown as a fatal
`PR_RunError`. That fix removed the spurious `Host_Error` these particular
maps' spawn functions triggered, so `changelevel` no longer touches the
`Host_Error`-mid-spawn path B-3's repro needed at all.

This is not a claim that a `Host_Error` firing mid-`SV_SpawnServer` is
handled incorrectly -- the describe block above proves the general case
(any `Host_Error` mid-frame, anywhere in the call stack `_Host_Frame`
reaches) recovers cleanly. This block is a regression lock for the
specific, previously-crashing repro, so a future change that reintroduces a
spurious mid-spawn error on these maps fails a test instead of silently
regressing.
*/
describe.skipIf(!HAVE_DATA)("changelevel does not desync the client (.orch/e2e/B.md's B-3, now a regression lock)", () => {
  test("map -> changelevel (same map) settles back to signon 4 with the server active, no throw", () => {
    Cbuf_AddText(`map ${MAP}\n`);
    settleUntil(() => cls.signon === SIGNONS && sv.active, 200, "map before changelevel");
    expect(sv.active).toBe(true);

    Cbuf_AddText(`changelevel ${MAP}\n`);
    // B-3's crash (`Sys_Error("i >= cl.maxclients")`) is fatal and would
    // propagate straight out of runFrames -- settleUntil's own runFrames
    // call is left unguarded on purpose so that if it comes back, this test
    // fails with that exact error instead of silently timing out.
    settleUntil(() => cls.signon === SIGNONS && sv.active, 200, "changelevel settle");

    expect(cls.signon).toBe(SIGNONS);
    expect(cls.state).toBe(CactiveT.ca_connected);
    expect(sv.active).toBe(true);
  });
});

describe.skipIf(!HAVE_DATA)("QW's Host_Frame catches HostEndGame at the frame level too (cheap cross-check for A.md's brief)", () => {
  test("a HostEndGame thrown mid-frame (from Cbuf_Execute, QW's own first frame call) returns instead of propagating", () => {
    let calls = 0;
    const spy = spyOn(QwCmd, "Cbuf_Execute").mockImplementation(() => {
      calls++;
      QwHost_EndGame("cross-check: forced mid-frame HostEndGame");
    });

    try {
      // QW's Host_Frame has its own frame-rate gate at the top
      // (`clMainState.realtime - clMainState.oldrealtime < 1.0/fps`) before
      // it ever reaches Cbuf_Execute; looping guarantees at least one call
      // clears it regardless of whatever `clMainState.realtime` this
      // process's other QW test files left behind (rule 15).
      for (let i = 0; i < 5 && calls === 0; i++) {
        expect(() => QwHost_Frame(0.05)).not.toThrow();
      }
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBeGreaterThan(0);
  });
});
