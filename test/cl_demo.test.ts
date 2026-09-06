// Self-sufficient tests for src/client/cl_demo.ts (WinQuake cl_demo.c, unit U045).
//
// cl_demo.ts reaches CL_Disconnect (cl_main.ts) through a lazy `require()`
// (see cl_demo.ts's own file header for why: cl_main.ts already has a static
// import of this module's exports, so PORTING.md's import-cycle rule makes
// this module resolve its side lazily). cl_main.ts is a real, landed module
// now, so `clMainMod().CL_Disconnect()` reaches the real CL_Disconnect.
//
// Filesystem setup follows PORTING.md's test-isolation recipe
// (COM_InitArgv + COM_InitFilesystem against a scratch `-basedir`, no pak
// needed since every demo filename here is a bare, slash-free basename that
// COM_FindFile's loose-file branch finds even in shareware/unregistered
// mode).
//
// cl_main.ts is a real, landed module now, so CL_PlayDemo_f's
// `clMainMod().CL_Disconnect()` call (cl_demo.ts's file header explains the
// lazy `require()`) reaches the real CL_Disconnect. Its own body
// (S_StopAllSounds(true), then a demoplayback/ca_connected-gated disconnect
// sequence) is safe to run for real in every scenario this file drives
// (S_StopAllSounds is a no-op with no sound device started, and
// NET_SendUnreliableMessage/NET_Close both tolerate a null cls.netcon). A
// call-through `spyOn` (real behavior preserved, just observed) replaces
// the old fake's call counter.

import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { ClientT, sv, svs } from "../src/server/server";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, com_gamedir } from "../src/common/common";
import { Cmd_TokenizeString, cmdState, CmdSourceT } from "../src/common/cmd";
import { NET_MAXMESSAGE } from "../src/common/net";
import { net_message } from "../src/common/sizebuf";
import { SvcOpsT } from "../src/common/protocol";
import { cls, cl, CactiveT, SIGNONS } from "../src/client/client";
import { host } from "../src/common/host";
import * as cl_main from "../src/client/cl_main";
import { CL_GetMessage, CL_PlayDemo_f, CL_Record_f, CL_Stop_f, CL_StopPlayback, CL_TimeDemo_f, CL_FinishTimeDemo, CL_WriteDemoMessage } from "../src/client/cl_demo";
import { HAVE_PROGS106 } from "./support/fixture_availability";

const disconnectSpy = spyOn(cl_main, "CL_Disconnect");

// resetClientState() (below) parks cls.state at ca_disconnected as this
// file's own beforeEach baseline, not the pristine ca_dedicated default, and
// nothing puts it back afterward -- the last test to run here leaks whatever
// it left cls.state as into the rest of this bun process (rule 15).
// Snapshot captured before resetClientState ever runs, restored below.
const savedClsState = cls.state;

afterAll(() => {
  disconnectSpy.mockRestore();
  cls.state = savedClsState;
});

// -- shared scratch dir / gamedir setup --------------------------------------

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "cl-demo-test-"));

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// Every call gets its own basedir/id1, so distinct tests never share a
// filename or a stale com_gamedir left by an earlier test in this file.
//
// `withProgs`: CL_Record_f's own C-faithful behavior runs `Cmd_ExecuteString
// ("map <name>")` whenever a map argument is given (cl_demo.ts:284), and
// SV_SpawnServer always loads progs.dat before ever checking whether the
// named map itself exists (sv_main.ts's PR_LoadProgs call precedes its
// graceful Mod_ForName/"Couldn't spawn server" handling) -- so if the
// process-wide `Cmd_AddCommand("map", ...)` registration has already
// happened (any file that has run host_cmd.ts's init this process), "map"
// stops being a silent no-op and PR_LoadProgs throws a fatal SysError
// without a real progs.dat reachable. Self-sufficient per standing order
// 13: rather than depend on whether some other file registered "map" yet,
// this places a real progs.dat (the same PORTING.md test fixture every
// other suite uses) as a loose file in this test's own scratch id1/, so
// PR_LoadProgs always succeeds and SV_SpawnServer's own graceful
// "Couldn't spawn server maps/somemap.bsp" (the map itself is never
// fixtured) path is what actually runs, exactly as it would whether or not
// "map" happened to be registered yet.
const PROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/progs106/progs.dat`;
function initGamedir(prefix: string, opts?: { withProgs?: boolean }): void {
  const baseDir = join(scratchDir, prefix);
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  if (opts?.withProgs) writeFileSync(join(baseDir, "id1", "progs.dat"), readFileSync(PROGS_DAT));
  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
}

function resetClientState(): void {
  cls.state = CactiveT.ca_disconnected;
  cls.demorecording = false;
  cls.demoplayback = false;
  cls.timedemo = false;
  cls.forcetrack = 0;
  cls.demofile = null;
  cls.signon = 0;
  cls.demonum = 0;
  cls.td_lastframe = 0;
  cls.td_startframe = 0;
  cls.td_starttime = 0;
  cls.netcon = null;
  cl.mtime[0] = 0;
  cl.mtime[1] = 0;
  cl.time = 0;
  cl.viewangles[0] = cl.viewangles[1] = cl.viewangles[2] = 0;
  cl.mviewangles[0][0] = cl.mviewangles[0][1] = cl.mviewangles[0][2] = 0;
  cl.mviewangles[1][0] = cl.mviewangles[1][1] = cl.mviewangles[1][2] = 0;
  net_message.data = new Uint8Array(NET_MAXMESSAGE);
  net_message.maxsize = NET_MAXMESSAGE;
  net_message.cursize = 0;
  host.framecount = 0;
  host.realtime = 0;
  disconnectSpy.mockClear();
}

beforeEach(resetClientState);

// ============================================================================

describe("CL_Record_f", () => {
  test("cmd_source other than src_command is a no-op", () => {
    initGamedir("wrongsource-");
    cmdState.source = CmdSourceT.src_client;
    Cmd_TokenizeString("record foo");
    CL_Record_f();
    expect(cls.demorecording).toBe(false);
  });

  test("wrong arg count refuses to record", () => {
    initGamedir("argcount-");
    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("record");
    CL_Record_f();
    expect(cls.demorecording).toBe(false);
  });

  test("a '..' in the demo name is refused", () => {
    initGamedir("dotdot-");
    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("record ../evil");
    CL_Record_f();
    expect(cls.demorecording).toBe(false);
  });

  test("already connected refusal when only a demoname is given", () => {
    initGamedir("alreadyconnected-");
    cmdState.source = CmdSourceT.src_command;
    cls.state = CactiveT.ca_connected;
    Cmd_TokenizeString("record foo");
    CL_Record_f();
    expect(cls.demorecording).toBe(false);
  });

  test.skipIf(!HAVE_PROGS106)("a forced track number becomes cls.forcetrack and demorecording turns on", () => {
    initGamedir("forcetrack-", { withProgs: true });
    // `record <demo> <map>` runs `map somemap`, and SV_SpawnServer walks
    // svs.clients[0..svs.maxclients): size the slots the way Host_FindMaxClients
    // does for a single-player host, and put the previous state back after.
    const savedMaxclients = svs.maxclients;
    const savedMaxclientslimit = svs.maxclientslimit;
    const savedClients = svs.clients;
    svs.maxclients = 1;
    svs.maxclientslimit = 4;
    svs.clients = Array.from({ length: 4 }, () => new ClientT());
    try {
      cmdState.source = CmdSourceT.src_command;
      Cmd_TokenizeString("record demoX somemap 7");
      CL_Record_f();
      expect(cls.forcetrack).toBe(7);
      expect(cls.demorecording).toBe(true);
      CL_Stop_f();
    } finally {
      sv.clear();
      svs.maxclients = savedMaxclients;
      svs.maxclientslimit = savedMaxclientslimit;
      svs.clients = savedClients;
    }
  });

  test("no track argument leaves forcetrack at -1", () => {
    initGamedir("notrack-");
    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("record demoY");
    CL_Record_f();
    expect(cls.forcetrack).toBe(-1);
    expect(cls.demorecording).toBe(true);
    CL_Stop_f();
  });
});

describe("CL_Record_f + CL_WriteDemoMessage + CL_Stop_f byte layout", () => {
  test("produce a .dem file with the exact C byte layout", () => {
    initGamedir("bytelayout-");

    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("record roundtrip");
    CL_Record_f();
    expect(cls.demorecording).toBe(true);
    expect(cls.forcetrack).toBe(-1);

    // first recorded message
    net_message.cursize = 4;
    net_message.data.set([1, 2, 3, 4], 0);
    cl.viewangles[0] = 10;
    cl.viewangles[1] = 20;
    cl.viewangles[2] = 30;
    CL_WriteDemoMessage();

    // second recorded message
    net_message.cursize = 2;
    net_message.data.set([9, 9], 0);
    cl.viewangles[0] = -1.5;
    cl.viewangles[1] = 0;
    cl.viewangles[2] = 180;
    CL_WriteDemoMessage();

    cmdState.source = CmdSourceT.src_command;
    CL_Stop_f();
    expect(cls.demorecording).toBe(false);

    const raw = readFileSync(join(com_gamedir, "roundtrip.dem"));
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    // track header line: "-1\n"
    expect(raw[0]).toBe("-".charCodeAt(0));
    expect(raw[1]).toBe("1".charCodeAt(0));
    expect(raw[2]).toBe("\n".charCodeAt(0));
    let pos = 3;

    // message 1: int32 length, 3 floats, payload bytes
    expect(view.getInt32(pos, true)).toBe(4);
    pos += 4;
    expect(view.getFloat32(pos, true)).toBeCloseTo(10, 5);
    pos += 4;
    expect(view.getFloat32(pos, true)).toBeCloseTo(20, 5);
    pos += 4;
    expect(view.getFloat32(pos, true)).toBeCloseTo(30, 5);
    pos += 4;
    expect(Array.from(raw.subarray(pos, pos + 4))).toEqual([1, 2, 3, 4]);
    pos += 4;

    // message 2
    expect(view.getInt32(pos, true)).toBe(2);
    pos += 4;
    expect(view.getFloat32(pos, true)).toBeCloseTo(-1.5, 5);
    pos += 4;
    expect(view.getFloat32(pos, true)).toBeCloseTo(0, 5);
    pos += 4;
    expect(view.getFloat32(pos, true)).toBeCloseTo(180, 5);
    pos += 4;
    expect(Array.from(raw.subarray(pos, pos + 2))).toEqual([9, 9]);
    pos += 2;

    // CL_Stop_f's own disconnect message: length 1, the viewangles at that
    // moment (still message 2's, unchanged since), payload [svc_disconnect]
    expect(view.getInt32(pos, true)).toBe(1);
    pos += 4;
    pos += 12;
    expect(raw[pos]).toBe(SvcOpsT.svc_disconnect);
    pos += 1;

    expect(pos).toBe(raw.length);
  });
});

describe("CL_PlayDemo_f", () => {
  test("parses a positive forcetrack header and enters playback state", () => {
    initGamedir("playdemo-pos-");
    writeFileSync(join(com_gamedir, "posTrack.dem"), Buffer.from("5\n"));

    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("play posTrack");
    CL_PlayDemo_f();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(cls.demoplayback).toBe(true);
    expect(cls.state).toBe(CactiveT.ca_connected);
    expect(cls.forcetrack).toBe(5);
  });

  test("parses a negative forcetrack header", () => {
    initGamedir("playdemo-neg-");
    writeFileSync(join(com_gamedir, "negTrack.dem"), Buffer.from("-7\n"));

    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("play negTrack");
    CL_PlayDemo_f();

    expect(cls.forcetrack).toBe(-7);
  });

  test("a missing demo file sets demonum to -1 and does not enter playback", () => {
    initGamedir("playdemo-missing-");
    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("play nosuchfile");
    CL_PlayDemo_f();

    expect(cls.demoplayback).toBe(false);
    expect(cls.demonum).toBe(-1);
  });

  test("cmd_source other than src_command is a no-op", () => {
    initGamedir("playdemo-wrongsource-");
    cmdState.source = CmdSourceT.src_client;
    Cmd_TokenizeString("play whatever");
    CL_PlayDemo_f();
    expect(cls.demoplayback).toBe(false);
    expect(disconnectSpy).toHaveBeenCalledTimes(0);
  });
});

describe("CL_GetMessage demo playback", () => {
  test("returns recorded messages in order with mtime gating, then 0 at EOF after CL_StopPlayback", () => {
    initGamedir("getmessage-");

    function messageBytes(payload: number[], angles: [number, number, number]): Uint8Array {
      const buf = new Uint8Array(4 + 12 + payload.length);
      const view = new DataView(buf.buffer);
      view.setInt32(0, payload.length, true);
      view.setFloat32(4, angles[0], true);
      view.setFloat32(8, angles[1], true);
      view.setFloat32(12, angles[2], true);
      buf.set(payload, 16);
      return buf;
    }

    const demoBytes = Buffer.concat([
      Buffer.from("0\n"),
      Buffer.from(messageBytes([1, 2, 3], [1, 2, 3])),
      Buffer.from(messageBytes([9, 8], [4, 5, 6])),
    ]);
    writeFileSync(join(com_gamedir, "playback.dem"), demoBytes);

    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("play playback");
    CL_PlayDemo_f();
    expect(cls.demoplayback).toBe(true);

    // fully connected (SIGNONS), so CL_GetMessage's mtime-gating branch is active
    cls.signon = SIGNONS;
    cl.time = 0;
    cl.mtime[0] = 0;

    // not yet due: cl.time (0) <= cl.mtime[0] (0)
    expect(CL_GetMessage()).toBe(0);

    // advance past cl.mtime[0] so the first message is due
    cl.time = 1;
    expect(CL_GetMessage()).toBe(1);
    expect(net_message.cursize).toBe(3);
    expect(Array.from(net_message.data.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(cl.mviewangles[0][0]).toBeCloseTo(1, 5);
    expect(cl.mviewangles[0][1]).toBeCloseTo(2, 5);
    expect(cl.mviewangles[0][2]).toBeCloseTo(3, 5);

    // CL_GetMessage never advances cl.mtime[0] itself (CL_ParseServerMessage,
    // the real caller, does that from the svc_time the payload would carry);
    // simulate that here so the next read is due.
    cl.mtime[0] = 2;
    cl.time = 3;
    expect(CL_GetMessage()).toBe(1);
    expect(net_message.cursize).toBe(2);
    expect(Array.from(net_message.data.subarray(0, 2))).toEqual([9, 8]);
    expect(cl.mviewangles[0][0]).toBeCloseTo(4, 5);
    // mviewangles[1] shifted from the previous newest (1,2,3) -- VectorCopy(mviewangles[0], mviewangles[1])
    expect(cl.mviewangles[1][0]).toBeCloseTo(1, 5);

    // EOF: the final content fread comes up short, so CL_StopPlayback runs
    cl.mtime[0] = 4;
    cl.time = 5;
    expect(CL_GetMessage()).toBe(0);
    expect(cls.demoplayback).toBe(false);
    expect(cls.state).toBe(CactiveT.ca_disconnected);

    // demoplayback is now false: falls through to the network branch, whose
    // cls.netcon is null -> NET_GetMessage returns -1
    expect(CL_GetMessage()).toBe(-1);
  });

  test("CL_StopPlayback is a no-op when not playing back", () => {
    initGamedir("stopplayback-noop-");
    expect(() => CL_StopPlayback()).not.toThrow();
    expect(cls.demoplayback).toBe(false);
  });
});

describe("CL_TimeDemo_f / CL_FinishTimeDemo", () => {
  test("CL_TimeDemo_f plays the demo and arms the frame counters", () => {
    initGamedir("timedemo-");
    writeFileSync(join(com_gamedir, "tdemo.dem"), Buffer.from("0\n"));

    cmdState.source = CmdSourceT.src_command;
    host.framecount = 100;
    Cmd_TokenizeString("timedemo tdemo");
    CL_TimeDemo_f();

    expect(cls.demoplayback).toBe(true); // CL_PlayDemo_f ran underneath
    expect(cls.timedemo).toBe(true);
    expect(cls.td_startframe).toBe(100);
    expect(cls.td_lastframe).toBe(-1);
  });

  test("CL_TimeDemo_f with the wrong arg count prints usage and does not play", () => {
    initGamedir("timedemo-argcount-");
    cmdState.source = CmdSourceT.src_command;
    Cmd_TokenizeString("timedemo");
    CL_TimeDemo_f();
    expect(cls.demoplayback).toBe(false);
    expect(cls.timedemo).toBe(false);
  });

  test("CL_FinishTimeDemo's frame/time math and the zero-time guard", () => {
    cls.timedemo = true;
    cls.td_startframe = 100;
    cls.td_starttime = 0;
    host.framecount = 150;
    host.realtime = 10;

    CL_FinishTimeDemo();

    expect(cls.timedemo).toBe(false); // frames = (150-100)-1 = 49; time = 10-0 = 10; fps = 4.9
  });

  test("CL_FinishTimeDemo substitutes 1 for a zero elapsed time", () => {
    cls.timedemo = true;
    cls.td_startframe = 5;
    cls.td_starttime = 3;
    host.framecount = 10;
    host.realtime = 3; // realtime - td_starttime == 0

    expect(() => CL_FinishTimeDemo()).not.toThrow();
    expect(cls.timedemo).toBe(false);
  });
});
