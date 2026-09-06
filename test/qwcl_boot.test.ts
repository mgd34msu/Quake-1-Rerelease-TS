/*
Self-sufficient test for Q025: src/qw/main_cl.ts (QW/client/sys_linux.c's
main()) -- the qwcl boot milestone PORTING.md's QuakeWorld track names.

The boot runs in a child `bun` process rather than in this one, for exactly
the reason test/qwsv_boot.test.ts's own header gives: src/common/cmd.ts has
one process-wide `cmd_functions` table and `Cmd_AddCommand` is first-wins, so
the QW client's Cbuf_Init/Cmd_Init/CL_Init/M_Init/Sbar_Init/SCR_Init and
WinQuake's Host_Init would fight over `toggleconsole`, `screenshot`,
`+showscores` and thirty more names depending on which suite ran first. The
child also gets its own SDL, its own UDP socket on PORT_CLIENT, and its own
`re.current`/`vid`/`conState` singletons, so this file mutates no shared
state of its own (standing order 13, test hygiene rule 15).

`SDL_VIDEODRIVER=dummy` / `SDL_AUDIODRIVER=dummy` make the child headless:
the software renderer still allocates and paints `vid.buffer`, which is what
the "SCR_UpdateScreen really ran" assertions below read.

The child builds its own scratch -basedir (test/support/qwcl_fixture.ts:
id1/pak0.pak with gfx/pop.lmp, a synthetic gfx.wad, gfx/palette.lmp,
gfx/colormap.lmp and gfx/conback.lmp, plus a loose id1/quake.rc +
id1/default.cfg) and drives Sys_Main_Init + runFrames, never entering
Sys_Main_Loop's infinite loop.
*/

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

const JSON_MARKER = "<<<QWCL_BOOT_JSON>>>";

// Runs the whole boot and prints one JSON line of everything this file
// asserts on. Kept as a script rather than a checked-in driver module so the
// unit adds no source file outside its SCOPE (test/qwsv_boot.test.ts does the
// same).
const CHILD_SCRIPT = `
import { buildQwclFixture, destroyQwclFixture } from "./test/support/qwcl_fixture";
import { Sys_Main_Init, runFrames } from "./src/qw/main_cl";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cvar_Set, Cvar_VariableString } from "./src/common/cvar";
import { CactiveT, cls } from "./src/client/client";
import { vid } from "./src/client/vid";
import { re } from "./src/client/render";
import { scrState } from "./src/client/screen_types";
import { con_main, conState } from "./src/qw/client/console";
import { clMainState } from "./src/qw/client/cl_main";
import { cmdHost } from "./src/common/cmd";
import { host } from "./src/common/host";
import { Info_ValueForKey } from "./src/qw/common";

const fixture = buildQwclFixture("qwcl-boot-child-");
try {
  Sys_Main_Init(["qwcl", "-basedir", fixture.baseDir]);

  // Bun's UDP bind is asynchronous where the C's is not -- src/qw/net_udp.ts's NET_Ready.
  await NET_Ready();

  runFrames(10, 0.1);

  // Cvar_Set (src/common/cvar.ts, a shared WinQuake-track module, same as
  // net_udp.ts) prints "Cvar_Set: variable %s not found\\n" via the same
  // Con_Printf import net_udp.ts uses, but unlike NET_Init's own prints (see
  // below) this one runs well after Con_Init, so it is what actually proves
  // the qwConsoleHooks forward -- called here, after Con_Init, specifically
  // for that.
  Cvar_Set("qwcl_boot_probe_missing_cvar", "1");

  // con_main.text is the QW console scrollback: one CON_TEXTSIZE byte per
  // character, high bit = colored, 0 = end of line.
  let conText = "";
  for (let i = 0; i < con_main.text.length; i++) {
    const c = con_main.text[i] & 0x7f;
    conText += c === 0 ? "\\n" : String.fromCharCode(c);
  }

  const snapshot = {
    hostInitialized: clMainState.host_initialized,
    cmdHostInitialized: cmdHost.initialized,
    conInitialized: conState.con_initialized,
    clsStateName: CactiveT[cls.state],
    vidRef: Cvar_VariableString("vid_ref"),
    rendererLoaded: re.current !== null,
    rendererIsGL: re.current === null ? null : re.current.isGL,
    vidWidth: vid.width,
    vidHeight: vid.height,
    vidBufferLen: vid.buffer === null ? 0 : vid.buffer.length,
    vidBufferPainted: vid.buffer === null ? false : vid.buffer.some((b) => b !== 0),
    scrConCurrent: scrState.scr_con_current,
    conLinewidth: conState.con_linewidth,
    conTotallines: conState.con_totallines,
    conCurrent: con_main.current,
    conOrmask: conState.con_ormask,
    hostFramecount: clMainState.host_framecount,
    realtime: clMainState.realtime,
    // realtime / host_frametime / host_framecount are single C globals that
    // this port keeps in two holders; QW's Host_Frame republishes them into
    // the host holder (src/common/host.ts), which every shared src/client
    // module reads.
    hostHolderRealtime: host.realtime,
    hostHolderFrametime: host.frametime,
    hostHolderFramecount: host.framecount,
    vidConbufferIsBuffer: vid.conbuffer !== null && vid.conbuffer === vid.buffer,
    vidConrowbytes: vid.conrowbytes,
    userinfo: cls.qw.userinfo,
    userinfoVer: Info_ValueForKey(cls.qw.userinfo, "*ver"),
    userinfoName: Info_ValueForKey(cls.qw.userinfo, "name"),
    // src/qw/net_udp.ts is shared by qwsv and qwcl and imports Con_Printf
    // from WinQuake's src/client/console.ts, forwarded into QW's own
    // con_main.text by src/qw/main_cl.ts's qwConsoleHooks -- but NET_Init's
    // own "UDP Initialized"/"IP address " prints run before Con_Init (QW/
    // client/cl_main.c's Host_Init: NET_Init(PORT_CLIENT) at line ~26,
    // Con_Init() at line ~31), so with NET_Init synchronous again neither
    // ever reaches con_main.text (faithful: the console doesn't exist yet
    // when they print) -- confirmed directly, not asserted here. The
    // Cvar_Set probe above runs after Con_Init instead, so it is what
    // actually proves the forward still works.
    conHasCvarSetWarning: conText.includes("Cvar_Set: variable qwcl_boot_probe_missing_cvar not found"),
    conHasBanner: conText.includes("QuakeWorld Initialized"),
  };

  NET_Shutdown();

  process.stdout.write("${JSON_MARKER}" + JSON.stringify(snapshot) + "\\n");
} finally {
  destroyQwclFixture(fixture);
}
process.exit(0);
`;

// Same boot with -nostdout, which src/qw/main_cl.ts turns into
// sysState.nostdout: Sys_Printf goes silent, so nothing but the marker line
// reaches stdout.
const NOSTDOUT_SCRIPT = `
import { buildQwclFixture, destroyQwclFixture } from "./test/support/qwcl_fixture";
import { Sys_Main_Init, runFrames } from "./src/qw/main_cl";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { sysState } from "./src/platform/sys";
import { clMainState } from "./src/qw/client/cl_main";

const fixture = buildQwclFixture("qwcl-boot-nostdout-");
try {
  Sys_Main_Init(["qwcl", "-nostdout", "-basedir", fixture.baseDir]);
  await NET_Ready();
  runFrames(2, 0.1);
  NET_Shutdown();
  process.stdout.write("${JSON_MARKER}" + JSON.stringify({ nostdout: sysState.nostdout, hostInitialized: clMainState.host_initialized }) + "\\n");
} finally {
  destroyQwclFixture(fixture);
}
process.exit(0);
`;

/*
The same boot, then a `vid_restart`. QW's Host_Init sets host_initialized,
which is what arms both Cmd_AddCommand's after-host-init guard AND (through
VID_CheckChanges's `cmdHost.rendererSwitch = cmdHost.initialized`) the
re-registration window that lets the incoming renderer replace the outgoing
one's commands and re-link its own cvar_t objects quietly. With qwcl setting
only its own clMainState.host_initialized, that window never opened and a
vid_restart printed a screenful of "Can't register variable X, allready
defined" / "Cmd_AddCommand: X already defined" while every renderer command
went on pointing at the torn-down renderer.
*/
const VID_RESTART_SCRIPT = `
import { buildQwclFixture, destroyQwclFixture } from "./test/support/qwcl_fixture";
import { Sys_Main_Init, runFrames } from "./src/qw/main_cl";
import { NET_Ready, NET_Shutdown } from "./src/qw/net_udp";
import { Cbuf_AddText, Cmd_Exists, cmdHost } from "./src/common/cmd";
import { con_main } from "./src/qw/client/console";
import { re } from "./src/client/render";
import { vid } from "./src/client/vid";

function conText() {
  let t = "";
  for (let i = 0; i < con_main.text.length; i++) {
    const c = con_main.text[i] & 0x7f;
    t += c === 0 ? "\\n" : String.fromCharCode(c);
  }
  return t;
}

const fixture = buildQwclFixture("qwcl-vidrestart-child-");
try {
  Sys_Main_Init(["qwcl", "-basedir", fixture.baseDir]);
  await NET_Ready();
  runFrames(6, 0.1);

  const before = conText();

  Cbuf_AddText("vid_restart\\n");
  runFrames(8, 0.1);

  // only what the restart itself printed
  const printed = conText().slice(before.length);

  NET_Shutdown();
  process.stdout.write("${JSON_MARKER}" + JSON.stringify({
    cmdHostInitialized: cmdHost.initialized,
    restartNoise: printed.includes("allready defined") || printed.includes("already defined"),
    noisySample: (printed.match(/[^\\n]*all?ready defined[^\\n]*/) || [""])[0],
    timerefreshExists: Cmd_Exists("timerefresh"),
    rendererLoaded: re.current !== null,
    vidWidth: vid.width,
    vidHeight: vid.height,
  }) + "\\n");
} finally {
  destroyQwclFixture(fixture);
}
process.exit(0);
`;

interface BootSnapshot {
  hostInitialized: boolean;
  cmdHostInitialized: boolean;
  conInitialized: boolean;
  clsStateName: string;
  vidRef: string;
  rendererLoaded: boolean;
  rendererIsGL: boolean | null;
  vidWidth: number;
  vidHeight: number;
  vidBufferLen: number;
  vidBufferPainted: boolean;
  scrConCurrent: number;
  conLinewidth: number;
  conTotallines: number;
  conCurrent: number;
  conOrmask: number;
  hostFramecount: number;
  realtime: number;
  hostHolderRealtime: number;
  hostHolderFrametime: number;
  hostHolderFramecount: number;
  vidConbufferIsBuffer: boolean;
  vidConrowbytes: number;
  userinfo: string;
  userinfoVer: string;
  userinfoName: string;
  conHasCvarSetWarning: boolean;
  conHasBanner: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("boot snapshot is not an object");
  return { ...value };
}

function str(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`boot snapshot field ${key} is not a string`);
  return v;
}
function num(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (typeof v !== "number") throw new Error(`boot snapshot field ${key} is not a number`);
  return v;
}
function bool(r: Record<string, unknown>, key: string): boolean {
  const v = r[key];
  if (typeof v !== "boolean") throw new Error(`boot snapshot field ${key} is not a boolean`);
  return v;
}
function boolOrNull(r: Record<string, unknown>, key: string): boolean | null {
  const v = r[key];
  if (v === null) return null;
  if (typeof v !== "boolean") throw new Error(`boot snapshot field ${key} is not a boolean or null`);
  return v;
}

function parseSnapshot(value: unknown): BootSnapshot {
  const r = record(value);
  return {
    hostInitialized: bool(r, "hostInitialized"),
    cmdHostInitialized: bool(r, "cmdHostInitialized"),
    conInitialized: bool(r, "conInitialized"),
    clsStateName: str(r, "clsStateName"),
    vidRef: str(r, "vidRef"),
    rendererLoaded: bool(r, "rendererLoaded"),
    rendererIsGL: boolOrNull(r, "rendererIsGL"),
    vidWidth: num(r, "vidWidth"),
    vidHeight: num(r, "vidHeight"),
    vidBufferLen: num(r, "vidBufferLen"),
    vidBufferPainted: bool(r, "vidBufferPainted"),
    scrConCurrent: num(r, "scrConCurrent"),
    conLinewidth: num(r, "conLinewidth"),
    conTotallines: num(r, "conTotallines"),
    conCurrent: num(r, "conCurrent"),
    conOrmask: num(r, "conOrmask"),
    hostFramecount: num(r, "hostFramecount"),
    realtime: num(r, "realtime"),
    hostHolderRealtime: num(r, "hostHolderRealtime"),
    hostHolderFrametime: num(r, "hostHolderFrametime"),
    hostHolderFramecount: num(r, "hostHolderFramecount"),
    vidConbufferIsBuffer: bool(r, "vidConbufferIsBuffer"),
    vidConrowbytes: num(r, "vidConrowbytes"),
    userinfo: str(r, "userinfo"),
    userinfoVer: str(r, "userinfoVer"),
    userinfoName: str(r, "userinfoName"),
    conHasCvarSetWarning: bool(r, "conHasCvarSetWarning"),
    conHasBanner: bool(r, "conHasBanner"),
  };
}

interface ChildRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  json: unknown;
}

function runChild(script: string): ChildRun {
  const proc = Bun.spawnSync(["timeout", "120", "bun", "-e", script], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SDL_VIDEODRIVER: "dummy", SDL_AUDIODRIVER: "dummy" },
  });

  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);

  let json: unknown = null;
  const markerAt = stdout.indexOf(JSON_MARKER);
  if (markerAt !== -1) {
    const lineEnd = stdout.indexOf("\n", markerAt);
    json = JSON.parse(stdout.slice(markerAt + JSON_MARKER.length, lineEnd === -1 ? undefined : lineEnd));
  }

  return { stdout, stderr, exitCode: proc.exitCode ?? -1, json };
}

let boot: ChildRun | null = null;
let nostdout: ChildRun | null = null;
let vidRestart: ChildRun | null = null;
let snapshot: BootSnapshot | null = null;

beforeAll(() => {
  boot = runChild(CHILD_SCRIPT);
  if (boot.json !== null) snapshot = parseSnapshot(boot.json);
  nostdout = runChild(NOSTDOUT_SCRIPT);
  vidRestart = runChild(VID_RESTART_SCRIPT);
});

function requireBoot(): ChildRun {
  if (boot === null) throw new Error("qwcl boot never ran");
  return boot;
}

function requireSnapshot(): BootSnapshot {
  const b = requireBoot();
  if (snapshot === null) throw new Error(`qwcl boot produced no snapshot.\nstdout:\n${b.stdout}\nstderr:\n${b.stderr}`);
  return snapshot;
}

describe("Sys_Main_Init + runFrames -- a real qwcl boot", () => {
  test("the boot process exits cleanly and never reaches Host_Error/Sys_Error", () => {
    const b = requireBoot();
    expect(b.exitCode).toBe(0);
    expect(b.stderr).toBe("");
    expect(b.stdout).not.toContain("Host_Error");
    expect(b.stdout).not.toContain("Sys_Error");
    expect(b.stdout).not.toContain("SysError");
    expect(b.stdout).not.toContain("Fatal");
  });

  test("Host_Init's own banner reaches stdout", () => {
    const b = requireBoot();
    expect(b.stdout).toContain("Playing registered version."); // COM_CheckRegistered
    expect(b.stdout).toContain("Console initialized."); // Con_Init
    expect(b.stdout).toContain("16.0 megs RAM used."); // parms.memsize = 16*1024*1024
    expect(b.stdout).toContain("Client Version 2.40 (Build ");
    // Con_Printf ("\\x1d\\x1e\\x1e\\x1e\\x1e\\x1e\\x1f QuakeWorld Initialized ...")
    // -- Sys_Printf renders the control bytes as [1d]/[1e]/[1f], as the C's does.
    expect(b.stdout).toContain("[1d][1e][1e][1e][1e][1e][1f] QuakeWorld Initialized [1d][1e][1e][1e][1e][1e][1f]");
    expect(b.stdout).toContain("UDP Initialized"); // NET_Init (PORT_CLIENT)
  });

  test("Host_Init runs quake.rc and its own queued commands", () => {
    const b = requireBoot();
    expect(b.stdout).toContain("/id1/quake.rc");
    expect(b.stdout).toContain("/id1/default.cfg");
    // Cbuf_AddText ("echo Type connect <internet address> ...")
    expect(b.stdout).toContain("Type connect <internet address> or use GameSpy to connect to a game.");
  });

  test("Host_Init finishes with the client disconnected and initialized", () => {
    const s = requireSnapshot();
    expect(s.hostInitialized).toBe(true);
    /*
    QW/client/cl_main.c's Host_Init ends with `host_initialized = true`, and
    QW/client/cmd.c:516 reads THAT SAME global in Cmd_AddCommand's
    "after host_initialized" guard. This port splits the one C global across
    two holders -- clMainState.host_initialized and src/common/cmd.ts's
    cmdHost.initialized -- and qwcl used to set only the first, so the guard
    never armed: Cmd_AddCommand's re-point branch (which cmd.ts reaches only
    once `initialized` is true) stayed off, and after a vid_restart every
    renderer command still pointed at the torn-down renderer's function while
    every re-registered cvar printed "allready defined".
    */
    expect(s.cmdHostInitialized).toBe(true);
    expect(s.conInitialized).toBe(true);
    expect(s.clsStateName).toBe("ca_disconnected"); // by name -- CactiveT's QW values follow WinQuake's
  });

  test("CL_Init built the userinfo string, `*ver` and `name` included", () => {
    const s = requireSnapshot();
    expect(s.userinfoVer).toMatch(/^2\.40-\d+$/); // Info_SetValueForStarKey ("*ver", va("%4.2f-%i", VERSION, build_number()))
    expect(s.userinfoName).toBe("unnamed");
    expect(s.userinfo).toContain("\\rate\\2500");
    expect(s.userinfo).toContain("\\topcolor\\0");
    expect(s.userinfo).toContain("\\bottomcolor\\0");
    expect(s.userinfo).toContain("\\msg\\1");
  });

  test("VID_Init selected the software renderer and allocated its framebuffer", () => {
    const s = requireSnapshot();
    expect(s.vidRef).toBe("soft"); // PORTING.md's one added cvar, default soft
    expect(s.rendererLoaded).toBe(true);
    expect(s.rendererIsGL).toBe(false);
    expect(s.vidWidth).toBe(640);
    expect(s.vidHeight).toBe(480);
    expect(s.vidBufferLen).toBe(640 * 480);
  });

  test("Host_Frame published realtime/host_frametime/host_framecount into the shared `host` holder", () => {
    const s = requireSnapshot();
    // view.c's V_CalcBob/CalcGunAngle/DropPunchAngle, screen.c's
    // SCR_SetUpToDrawConsole and cl_input.c's CL_AdjustAngles all read these
    // as `host.frametime` / `host.realtime`; leaving them at 0 froze the
    // console fully open (scr_con_current never slid down), which in turn made
    // Sbar_Draw return early on its `scr_con_current == vid.height` check.
    expect(s.hostHolderRealtime).toBeCloseTo(s.realtime, 5);
    expect(s.hostHolderFrametime).toBeGreaterThan(0);
    expect(s.hostHolderFramecount).toBe(s.hostFramecount);
  });

  test("VID_Init pointed vid.conbuffer at the software framebuffer", () => {
    const s = requireSnapshot();
    // vid_x.c's `vid.conbuffer = vid.buffer; vid.conrowbytes = vid.rowbytes;`
    // -- draw.c's Draw_Character/Draw_String/Draw_ConsoleBackground/
    // Draw_Pixel write through these, so a null conbuffer means no console
    // text and no status-bar characters anywhere.
    expect(s.vidConbufferIsBuffer).toBe(true);
    expect(s.vidConrowbytes).toBe(s.vidWidth);
  });

  test("Host_Frame ran SCR_UpdateScreen and the software renderer painted a frame", () => {
    const s = requireSnapshot();
    expect(s.hostFramecount).toBe(10);
    expect(s.realtime).toBeCloseTo(1.0, 5);
    // SCR_SetUpToDrawConsole slides the console all the way down while
    // disconnected (scr_con_current -> vid.height), and SCR_DrawConsole ->
    // Con_DrawConsole -> Draw_ConsoleBackground fills vid.buffer with it.
    expect(s.scrConCurrent).toBe(480);
    expect(s.vidBufferPainted).toBe(true);
  });

  test("Con_Init sized the QW console off the real video mode", () => {
    const s = requireSnapshot();
    expect(s.conLinewidth).toBe((640 >> 3) - 2); // Con_Resize's `width = (vid.width >> 3) - 2`
    expect(s.conTotallines).toBe(Math.trunc(16384 / s.conLinewidth)); // CON_TEXTSIZE / con_linewidth
    expect(s.conCurrent).toBeGreaterThan(0); // Host_Init's prints landed in con_main
    expect(s.conOrmask).toBe(0); // only svc_print's PRINT_CHAT case sets it
  });

  test("a shared WinQuake-track module's Con_Printf reaches the QW console buffer", () => {
    // src/common/cvar.ts (Cvar_Set) imports Con_Printf from WinQuake's
    // src/client/console.ts, the same shared import src/qw/net_udp.ts uses
    // (qwsv needs it there too); src/qw/main_cl.ts's qwConsoleHooks forward
    // is what puts its output in con_main.text. net_udp.ts's own "UDP
    // Initialized"/"IP address " prints happen during NET_Init, which QW's
    // Host_Init calls before Con_Init, so they never land in con_main.text
    // (see the child script's own comment) -- the Cvar_Set probe there runs
    // after Con_Init instead, so it is what actually exercises the forward.
    const s = requireSnapshot();
    expect(s.conHasCvarSetWarning).toBe(true);
    // and cl_main.ts's own Con_Printf, which never needed the forward
    expect(s.conHasBanner).toBe(true);
  });

  test("-nostdout silences Sys_Printf for the whole boot", () => {
    if (nostdout === null) throw new Error("the -nostdout boot never ran");
    expect(nostdout.exitCode).toBe(0);
    expect(nostdout.stderr).toBe("");
    expect(nostdout.stdout).not.toContain("QuakeWorld Initialized");
    expect(nostdout.stdout).not.toContain("Playing registered version.");

    const r = record(nostdout.json);
    expect(num(r, "nostdout")).toBe(1);
    expect(bool(r, "hostInitialized")).toBe(true);
  });
});

describe("vid_restart under qwcl", () => {
  test("the restart re-registers quietly and keeps the renderer's commands", () => {
    if (vidRestart === null) throw new Error("the vid_restart boot never ran");
    expect(vidRestart.exitCode).toBe(0);
    expect(vidRestart.stderr).toBe("");

    const r = record(vidRestart.json);
    // the guard QW/client/cl_main.c's `host_initialized = true` arms, which is
    // also what opens VID_CheckChanges's re-registration window
    expect(bool(r, "cmdHostInitialized")).toBe(true);
    // no "Can't register variable X, allready defined" / "Cmd_AddCommand: X
    // already defined" from the re-run of Draw_Init/SCR_Init/R_Init/Sbar_Init
    expect(str(r, "noisySample")).toBe("");
    expect(bool(r, "restartNoise")).toBe(false);
    // and the renderer's own commands are still reachable afterwards -- with
    // the window open, Cmd_AddCommand re-points them at the incoming
    // renderer's functions instead of refusing the name
    expect(bool(r, "timerefreshExists")).toBe(true);
    expect(bool(r, "rendererLoaded")).toBe(true);
    expect(num(r, "vidWidth")).toBeGreaterThan(0);
    expect(num(r, "vidHeight")).toBeGreaterThan(0);
  });
});
