/*
Self-sufficient test for Q014: src/qw/server/sv_main.ts (QW/server/sv_main.c).

Covers the parts of sv_main.c that can be driven without a real UDP socket or
a spawned map: the IP filter list, SV_CalcPing, SV_CheckTimeouts, the
connectionless packet dispatcher (getchallenge + connect), SV_ExtractFromUserinfo's
name rules, SV_CheckVars's needpass serverinfo, and the `info`-flagged cvar ->
svs.info propagation that src/common/cvar.ts's Cvar_Set performs through
setCvarInfoHook when qw.active is set.

Standing order 13 / rule 15 hygiene, all done by this file itself:
- builds its own scratch -basedir (id1/pak0.pak with gfx/pop.lmp plus a loose
  qw/qwprogs.dat, the real retail QuakeWorld progs) and re-initializes
  com_searchpaths/com_modified through src/qw/common.ts, then restores them.
- net_message is the process-wide src/common/sizebuf.ts singleton; its
  data/maxsize/cursize are snapshotted and restored.
- NET_SendPacket is replaced with a queueing mockImplementation installed in
  beforeAll and mockRestore'd in afterAll (never mock.module).
- sv/svs/netchanState/sysState/qw.active, the cvar info hook, and every
  sv_main cvar this file writes are reset by this suite; cvar values are
  compared as numbers.
- pr_exec's builtin table gets a stub set through setBuiltins, exactly as
  test/qwsv_progs.test.ts does, since PR_ExecuteProgram(SetNewParms) runs
  during SVC_DirectConnect.
*/

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { sysState } from "../src/platform/sys";
import { setComSearchpaths, setComModified } from "../src/common/common";
import { qw } from "../src/common/quakedef";
import { Cmd_TokenizeString } from "../src/common/cmd";
import { CvarT, Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set, getCvarInfoHook, setCvarInfoHook } from "../src/common/cvar";
import { net_message } from "../src/common/sizebuf";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, Info_ValueForKey, pop } from "../src/qw/common";
import { writePakToDisk } from "./support/pak_builder";
import { MAX_EDICTS } from "../src/qw/bothdefs";
import { MAX_CLIENTS } from "../src/qw/protocol";
import * as netUdp from "../src/qw/net_udp";
import { NetadrT, NET_StringToAdr, net_from } from "../src/qw/net_udp";
import { netchanState, Netchan_Setup } from "../src/qw/net_chan";
import { EDICT_NUM } from "../src/qw/server/progs";
import { PR_AllocEdicts, PR_LoadProgs } from "../src/qw/server/pr_edict";
import { setBuiltins } from "../src/qw/server/pr_exec";
import { ClientStateT, ClientT, ServerStateT, sv, svs } from "../src/qw/server/server";
import { SV_SendServerInfoChange } from "../src/qw/server/sv_ccmds";
import {
  IpfilterT,
  SV_AddIP_f,
  SV_CalcPing,
  SV_CheckTimeouts,
  SV_CheckVars,
  SV_ConnectionlessPacket,
  SV_CvarInfoHook,
  SV_ExtractFromUserinfo,
  SV_FilterPacket,
  SV_RemoveIP_f,
  StringToFilter,
  filterban,
  maxclients,
  maxspectators,
  password,
  spectator_password,
  sv_highchars,
  svMainState,
  timeout as sv_timeout,
  watervis,
  zombietime,
} from "../src/qw/server/sv_main";
import { HAVE_QWPROGS } from "./support/fixture_availability";

const QWPROGS_DAT = `${process.env.Q1TS_QSRC ?? `${import.meta.dir}/../../qsrc/quake`}/QW/progs/qwprogs.dat`;

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "qwsv-main-test-"));
const baseDir = join(scratchDir, "quake");

interface SentPacket {
  length: number;
  data: Uint8Array;
  to: NetadrT;
}

const sentPackets: SentPacket[] = [];
const sendPacketSpy = spyOn(netUdp, "NET_SendPacket"); // module scope: bare spyOn (rule 15)

const savedNostdout = sysState.nostdout;
const savedQwActive = qw.active;
// cvarInfoHook (src/common/cvar.ts) is a process-wide singleton this file
// swaps in SV_CvarInfoHook for -- other test files (e.g. test/qw_cvar_cmd.
// test.ts) share the same process and expect whatever was ambient before
// this file ran to still be installed once it's done (rule 15), not null.
const savedCvarInfoHook = getCvarInfoHook();

let savedNetMessageData: Uint8Array;
let savedNetMessageMaxsize: number;
let savedNetMessageCursize: number;

let savedNetchanIsClient: boolean;
let savedNetchanRealtime: number;

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function latin1String(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// hand-build net_message the way NET_GetPacket would have filled it
function setNetMessage(text: string): void {
  const bytes = latin1Bytes(text);
  net_message.data.fill(0);
  net_message.data.set(bytes, 0);
  net_message.cursize = bytes.length;
}

function setNetFrom(s: string): void {
  const a = new NetadrT();
  NET_StringToAdr(s, a);
  net_from.ip.set(a.ip);
  net_from.port = a.port;
  net_from.pad = a.pad;
}

function registerOnce(v: CvarT): void {
  if (Cvar_FindVar(v.name) === null) Cvar_RegisterVariable(v);
}

function resetClients(): void {
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const cl = svs.clients[i];
    cl.state = ClientStateT.cs_free;
    cl.spectator = 0;
    cl.name = "";
    cl.userinfo = "";
    cl.userid = 0;
    cl.old_frags = 0;
    cl.lossage = 0;
    cl.connection_started = 0;
    cl.lastnametime = 0;
    cl.lastnamecount = 0;
    cl.messagelevel = 0;
    cl.send_message = false;
    cl.sendinfo = false;
    cl.download = null;
    cl.upload = null;
    cl.edict = null;
    for (let j = 0; j < cl.frames.length; j++) cl.frames[j].ping_time = 0;
    Netchan_Setup(cl.netchan, new NetadrT(), 0);
  }
}

// reads the slot's state through a call so the enclosing test's assignment
// narrowing does not collapse `expect()`'s overload to a single literal
function clientState(i: number): ClientStateT {
  return svs.clients[i].state;
}

function resetChallenges(): void {
  for (let i = 0; i < svs.challenges.length; i++) {
    svs.challenges[i].adr = new NetadrT();
    svs.challenges[i].challenge = 0;
    svs.challenges[i].time = 0;
  }
}

function wireServerBuffers(): void {
  sv.reliable_datagram.data = sv.reliable_datagram_buf;
  sv.reliable_datagram.maxsize = sv.reliable_datagram_buf.length;
  sv.reliable_datagram.cursize = 0;
  sv.reliable_datagram.allowoverflow = true;
  sv.reliable_datagram.overflowed = false;

  sv.datagram.data = sv.datagram_buf;
  sv.datagram.maxsize = sv.datagram_buf.length;
  sv.datagram.cursize = 0;
  sv.datagram.allowoverflow = true;
  sv.datagram.overflowed = false;
}

beforeAll(() => {
  sysState.nostdout = 1;

  // No throw: a missing QW/progs/qwprogs.dat means every describe() below is
  // wrapped in describe.skipIf(!HAVE_QWPROGS), so this beforeAll simply has
  // nothing to set up for tests that never run. afterAll below guards its
  // own restoration of the five fields this would otherwise have set.
  if (!HAVE_QWPROGS) return;

  savedNetMessageData = net_message.data;
  savedNetMessageMaxsize = net_message.maxsize;
  savedNetMessageCursize = net_message.cursize;
  net_message.data = new Uint8Array(8192);
  net_message.maxsize = net_message.data.length;
  net_message.cursize = 0;

  savedNetchanIsClient = netchanState.isClient;
  savedNetchanRealtime = netchanState.realtime;

  sendPacketSpy.mockImplementation((length: number, data: Uint8Array, to: NetadrT) => {
    const copy = new NetadrT();
    copy.ip.set(to.ip);
    copy.port = to.port;
    copy.pad = to.pad;
    sentPackets.push({ length, data: data.slice(0, length), to: copy });
  });

  // own scratch gamedir, same recipe as test/qwsv_progs.test.ts
  setComSearchpaths(null);
  setComModified(false);

  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  mkdirSync(join(baseDir, "id1"), { recursive: true });
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  mkdirSync(join(baseDir, "qw"), { recursive: true });
  writeFileSync(join(baseDir, "qw", "qwprogs.dat"), new Uint8Array(readFileSync(QWPROGS_DAT)));

  COM_InitArgv(["qwsv", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();

  PR_LoadProgs();
  PR_AllocEdicts(MAX_EDICTS);
  sv.num_edicts = 1;
  sv.time = 0;

  const stubs: Array<() => void> = [];
  for (let i = 0; i < 300; i++) stubs.push(() => {});
  setBuiltins(stubs);

  netchanState.isClient = false;
});

afterAll(() => {
  sendPacketSpy.mockRestore();
  setCvarInfoHook(savedCvarInfoHook);

  qw.active = savedQwActive;
  sysState.nostdout = savedNostdout;

  // These five are only assigned inside the beforeAll above, which returns
  // early (without touching net_message/netchanState at all) when
  // QW/progs/qwprogs.dat is missing -- nothing to restore in that case.
  if (HAVE_QWPROGS) {
    net_message.data = savedNetMessageData;
    net_message.maxsize = savedNetMessageMaxsize;
    net_message.cursize = savedNetMessageCursize;

    netchanState.isClient = savedNetchanIsClient;
    netchanState.realtime = savedNetchanRealtime;
  }

  setComSearchpaths(null);
  setComModified(false);
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeEach(() => {
  sentPackets.length = 0;
  resetClients();
  resetChallenges();
  wireServerBuffers();

  sv.paused = false;
  sv.state = ServerStateT.ss_dead;
  svs.info = "";
  svs.logsequence = 1;
  svs.logtime = 0;
  svs.stats.packets = 0;

  svMainState.realtime = 0;
  netchanState.realtime = 0;

  filterban.value = 1;
  filterban.string = "1";
  sv_timeout.value = 65;
  zombietime.value = 2;
  password.string = "";
  spectator_password.string = "";
  sv_highchars.value = 1;
  maxclients.value = 8;
  maxspectators.value = 8;

  qw.active = false;
  setCvarInfoHook(null);
});

//============================================================================

describe.skipIf(!HAVE_QWPROGS)("StringToFilter", () => {
  test("a full dotted quad masks every octet", () => {
    const f = new IpfilterT();
    expect(StringToFilter("192.246.40.70", f)).toBe(true);
    expect(f.mask >>> 0).toBe(0xffffffff);
    // *(unsigned *)b over byte[4] is a little-endian pack
    expect(f.compare >>> 0).toBe(((70 << 24) | (40 << 16) | (246 << 8) | 192) >>> 0);
  });

  test('a partial "192.168.1" style address leaves the trailing octet unmasked', () => {
    const f = new IpfilterT();
    expect(StringToFilter("192.168.1", f)).toBe(true);
    expect(f.mask >>> 0).toBe(0x00ffffff);
    expect(f.compare >>> 0).toBe(((1 << 16) | (168 << 8) | 192) >>> 0);
  });

  test("a zero octet gets no mask byte -- id's own rule, ported to match the C exactly", () => {
    const f = new IpfilterT();
    expect(StringToFilter("10.0.0.1", f)).toBe(true);
    expect(f.mask >>> 0).toBe(0xff0000ff);
    expect(f.compare >>> 0).toBe(((1 << 24) | 10) >>> 0);
  });

  test("rejects an address that does not start with a digit", () => {
    const f = new IpfilterT();
    expect(StringToFilter("localhost", f)).toBe(false);
    expect(StringToFilter("", f)).toBe(false);
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_AddIP_f / SV_RemoveIP_f / SV_FilterPacket", () => {
  afterEach(() => {
    Cmd_TokenizeString("removeip 192.168.1");
    SV_RemoveIP_f();
  });

  test("filterban 1: a matching address is filtered, a non-matching one is not", () => {
    Cmd_TokenizeString("addip 192.168.1");
    SV_AddIP_f();

    filterban.value = 1;

    setNetFrom("192.168.1.55:27001");
    expect(SV_FilterPacket()).toBe(true);

    setNetFrom("10.0.0.5:27001");
    expect(SV_FilterPacket()).toBe(false);
  });

  test("filterban 0 inverts the polarity: only listed addresses are allowed", () => {
    Cmd_TokenizeString("addip 192.168.1");
    SV_AddIP_f();

    filterban.value = 0;

    setNetFrom("192.168.1.55:27001");
    expect(SV_FilterPacket()).toBe(false);

    setNetFrom("10.0.0.5:27001");
    expect(SV_FilterPacket()).toBe(true);
  });

  test("removeip drops the entry again", () => {
    Cmd_TokenizeString("addip 192.168.1");
    SV_AddIP_f();

    setNetFrom("192.168.1.55:27001");
    expect(SV_FilterPacket()).toBe(true);

    Cmd_TokenizeString("removeip 192.168.1");
    SV_RemoveIP_f();

    expect(SV_FilterPacket()).toBe(false);
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_CalcPing", () => {
  test("returns 9999 with no timed frames", () => {
    const cl = new ClientT();
    expect(SV_CalcPing(cl)).toBe(9999);
  });

  test("averages the positive frame ping_times and returns milliseconds", () => {
    const cl = new ClientT();
    cl.frames[0].ping_time = 0.05;
    cl.frames[1].ping_time = 0.15;
    cl.frames[2].ping_time = 0; // ignored: not > 0
    expect(SV_CalcPing(cl)).toBe(100);
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_CheckTimeouts", () => {
  test("drops a cs_connected client whose netchan has gone quiet past timeout", () => {
    const cl = svs.clients[0];
    cl.state = ClientStateT.cs_connected;
    cl.name = "quiet";
    cl.edict = EDICT_NUM(1);
    cl.netchan.last_received = 0;

    svMainState.realtime = 100; // droptime = 100 - 65 = 35 > last_received
    SV_CheckTimeouts();

    expect(clientState(0)).toBe(ClientStateT.cs_free);
  });

  test("keeps a client whose netchan is still fresh", () => {
    const cl = svs.clients[0];
    cl.state = ClientStateT.cs_connected;
    cl.name = "chatty";
    cl.edict = EDICT_NUM(1);
    cl.netchan.last_received = 90;

    svMainState.realtime = 100;
    SV_CheckTimeouts();

    expect(clientState(0)).toBe(ClientStateT.cs_connected);
  });

  test("frees a zombie once zombietime has elapsed", () => {
    const cl = svs.clients[0];
    cl.state = ClientStateT.cs_zombie;
    cl.connection_started = 0;

    svMainState.realtime = 10; // > zombietime (2)
    SV_CheckTimeouts();

    expect(clientState(0)).toBe(ClientStateT.cs_free);
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_ConnectionlessPacket -> SVC_GetChallenge", () => {
  test("stores a challenge for the sender and echoes it back out of band", () => {
    setNetFrom("192.168.1.20:27001");
    setNetMessage("\xff\xff\xff\xffgetchallenge\n");

    SV_ConnectionlessPacket();

    expect(sentPackets.length).toBe(1);
    const p = sentPackets[0];
    expect(Array.from(p.data.subarray(0, 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
    // S2C_CHALLENGE ('c') followed by the decimal challenge number
    const body = latin1String(p.data.subarray(4)).replace(/\0+$/, "");
    expect(body[0]).toBe("c");

    const echoed = Number(body.slice(1));
    const stored = svs.challenges.find((c) => c.adr.ip[0] === 192 && c.adr.ip[1] === 168 && c.adr.ip[2] === 1 && c.adr.ip[3] === 20);
    expect(stored).toBeDefined();
    if (stored === undefined) throw new Error("challenge not stored");
    expect(echoed).toBe(stored.challenge);
  });

  test("a second getchallenge from the same address reuses the stored challenge", () => {
    setNetFrom("192.168.1.20:27001");
    setNetMessage("\xff\xff\xff\xffgetchallenge\n");
    SV_ConnectionlessPacket();
    const first = latin1String(sentPackets[0].data.subarray(5)).replace(/\0+$/, "");

    sentPackets.length = 0;
    setNetMessage("\xff\xff\xff\xffgetchallenge\n");
    SV_ConnectionlessPacket();
    const second = latin1String(sentPackets[0].data.subarray(5)).replace(/\0+$/, "");

    expect(second).toBe(first);
  });

  test("the stored challenge address does not alias the net_from singleton", () => {
    setNetFrom("192.168.1.20:27001");
    setNetMessage("\xff\xff\xff\xffgetchallenge\n");
    SV_ConnectionlessPacket();

    setNetFrom("10.9.8.7:27001");

    const stored = svs.challenges.find((c) => c.adr.ip[0] === 192 && c.adr.ip[3] === 20);
    expect(stored).toBeDefined();
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_ConnectionlessPacket -> SVC_Ping / unknown", () => {
  test("ping is acknowledged with a single A2A_ACK byte", () => {
    setNetFrom("192.168.1.20:27001");
    setNetMessage("\xff\xff\xff\xffping\n");

    SV_ConnectionlessPacket();

    expect(sentPackets.length).toBe(1);
    expect(sentPackets[0].length).toBe(1);
    expect(String.fromCharCode(sentPackets[0].data[0])).toBe("l"); // A2A_ACK
  });

  test("an unrecognised connectionless command sends nothing", () => {
    setNetFrom("192.168.1.20:27001");
    setNetMessage("\xff\xff\xff\xffnonsense\n");

    SV_ConnectionlessPacket();

    expect(sentPackets.length).toBe(0);
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_ConnectionlessPacket -> SVC_DirectConnect", () => {
  function getChallengeFor(adr: string): number {
    setNetFrom(adr);
    setNetMessage("\xff\xff\xff\xffgetchallenge\n");
    SV_ConnectionlessPacket();
    const body = latin1String(sentPackets[0].data.subarray(5)).replace(/\0+$/, "");
    sentPackets.length = 0;
    return Number(body);
  }

  test("a valid connect creates a cs_connected client and answers S2C_CONNECTION", () => {
    const challenge = getChallengeFor("192.168.1.30:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\bob"\n`);
    SV_ConnectionlessPacket();

    const cl = svs.clients[0];
    expect(cl.state).toBe(ClientStateT.cs_connected);
    expect(cl.name).toBe("bob");
    expect(cl.netchan.qport).toBe(4711);
    expect(cl.spectator).toBe(0);
    expect(cl.userid).toBeGreaterThan(0);
    expect(cl.edict).toBe(EDICT_NUM(1));

    expect(sentPackets.length).toBe(1);
    expect(String.fromCharCode(sentPackets[0].data[4])).toBe("j"); // S2C_CONNECTION
  });

  test("a wrong protocol version is rejected with A2C_PRINT and no client slot", () => {
    getChallengeFor("192.168.1.31:27001");

    setNetMessage('\xff\xff\xff\xffconnect 15 4711 0 "\\name\\bob"\n');
    SV_ConnectionlessPacket();

    expect(svs.clients[0].state).toBe(ClientStateT.cs_free);
    expect(sentPackets.length).toBe(1);
    expect(String.fromCharCode(sentPackets[0].data[4])).toBe("n"); // A2C_PRINT
  });

  test("a bad challenge is rejected", () => {
    const challenge = getChallengeFor("192.168.1.32:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge + 1} "\\name\\bob"\n`);
    SV_ConnectionlessPacket();

    expect(svs.clients[0].state).toBe(ClientStateT.cs_free);
    expect(sentPackets.length).toBe(1);
    expect(String.fromCharCode(sentPackets[0].data[4])).toBe("n"); // A2C_PRINT
  });

  test("a wrong spectator password is rejected", () => {
    spectator_password.string = "letmein";
    const challenge = getChallengeFor("192.168.1.33:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\bob\\spectator\\wrong"\n`);
    SV_ConnectionlessPacket();

    expect(svs.clients[0].state).toBe(ClientStateT.cs_free);
  });

  test("the right spectator password connects as a spectator and the key is replaced by *spectator", () => {
    spectator_password.string = "letmein";
    const challenge = getChallengeFor("192.168.1.34:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\bob\\spectator\\letmein"\n`);
    SV_ConnectionlessPacket();

    const cl = svs.clients[0];
    expect(cl.state).toBe(ClientStateT.cs_connected);
    expect(cl.spectator).toBe(1);
    expect(Info_ValueForKey(cl.userinfo, "spectator")).toBe("");
    expect(Info_ValueForKey(cl.userinfo, "*spectator")).toBe("1");
  });

  test("a wrong game password is rejected", () => {
    password.string = "hunter2";
    const challenge = getChallengeFor("192.168.1.35:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\bob\\password\\nope"\n`);
    SV_ConnectionlessPacket();

    expect(svs.clients[0].state).toBe(ClientStateT.cs_free);
  });

  test("the password key is stripped from the stored userinfo on success", () => {
    password.string = "hunter2";
    const challenge = getChallengeFor("192.168.1.36:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\bob\\password\\hunter2"\n`);
    SV_ConnectionlessPacket();

    const cl = svs.clients[0];
    expect(cl.state).toBe(ClientStateT.cs_connected);
    expect(Info_ValueForKey(cl.userinfo, "password")).toBe("");
  });

  test("maxclients 0 refuses the connection as full", () => {
    maxclients.value = 0;
    const challenge = getChallengeFor("192.168.1.37:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\bob"\n`);
    SV_ConnectionlessPacket();

    expect(svs.clients[0].state).toBe(ClientStateT.cs_free);
    expect(sentPackets.length).toBe(1);
    expect(String.fromCharCode(sentPackets[0].data[4])).toBe("n"); // A2C_PRINT
  });

  test("sv_highchars 0 strips non-printable characters out of the stored userinfo", () => {
    sv_highchars.value = 0;
    const challenge = getChallengeFor("192.168.1.38:27001");

    setNetMessage(`\xff\xff\xff\xffconnect 28 4711 ${challenge} "\\name\\b\xe1o\xf2b"\n`);
    SV_ConnectionlessPacket();

    const cl = svs.clients[0];
    expect(cl.state).toBe(ClientStateT.cs_connected);
    expect(cl.userinfo.includes("\xe1")).toBe(false);
    expect(cl.userinfo.includes("\xf2")).toBe(false);
    expect(cl.name).toBe("bob");
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_ExtractFromUserinfo", () => {
  test("an absent name becomes unnamed", () => {
    const cl = new ClientT();
    cl.userinfo = "";
    SV_ExtractFromUserinfo(cl);
    expect(cl.name).toBe("unnamed");
    expect(Info_ValueForKey(cl.userinfo, "name")).toBe("unnamed");
  });

  test('a whitespace-only name becomes unnamed', () => {
    const cl = new ClientT();
    cl.userinfo = "\\name\\   ";
    SV_ExtractFromUserinfo(cl);
    expect(cl.name).toBe("unnamed");
  });

  test('"console" is reserved and becomes unnamed', () => {
    const cl = new ClientT();
    cl.userinfo = "\\name\\CONSOLE";
    SV_ExtractFromUserinfo(cl);
    expect(cl.name).toBe("unnamed");
  });

  test("leading and trailing whitespace is trimmed", () => {
    const cl = new ClientT();
    cl.userinfo = "\\name\\  bob  ";
    SV_ExtractFromUserinfo(cl);
    expect(cl.name).toBe("bob");
  });

  test("a duplicate of a spawned client's name gets a (n) prefix", () => {
    const other = svs.clients[0];
    other.state = ClientStateT.cs_spawned;
    other.name = "bob";

    const cl = new ClientT();
    cl.userinfo = "\\name\\bob";
    SV_ExtractFromUserinfo(cl);

    expect(cl.name).toBe("(1)bob");
  });

  test("the stored name is truncated to sizeof(cl->name)-1 = 31 characters", () => {
    const cl = new ClientT();
    const long = "abcdefghijklmnopqrstuvwxyz0123456789";
    cl.userinfo = `\\name\\${long}`;
    SV_ExtractFromUserinfo(cl);
    expect(cl.name.length).toBe(31);
    expect(cl.name).toBe(long.slice(0, 31));
  });

  test("the rate key is clamped to 500..10000 and stored as seconds per byte", () => {
    const cl = new ClientT();
    cl.userinfo = "\\name\\bob\\rate\\100";
    SV_ExtractFromUserinfo(cl);
    expect(cl.netchan.rate).toBeCloseTo(1 / 500, 10);

    const cl2 = new ClientT();
    cl2.userinfo = "\\name\\jim\\rate\\99999";
    SV_ExtractFromUserinfo(cl2);
    expect(cl2.netchan.rate).toBeCloseTo(1 / 10000, 10);
  });

  test("the msg key becomes the client's message level", () => {
    const cl = new ClientT();
    cl.userinfo = "\\name\\bob\\msg\\2";
    SV_ExtractFromUserinfo(cl);
    expect(cl.messagelevel).toBe(2);
  });
});

describe.skipIf(!HAVE_QWPROGS)("SV_CheckVars", () => {
  test("a game password alone sets needpass 1", () => {
    password.string = "hunter2";
    spectator_password.string = "";
    SV_CheckVars();
    expect(Info_ValueForKey(svs.info, "needpass")).toBe("1");
  });

  test("both passwords set needpass 3", () => {
    password.string = "hunter2";
    spectator_password.string = "letmein";
    SV_CheckVars();
    expect(Info_ValueForKey(svs.info, "needpass")).toBe("3");
  });

  test('"none" counts as no password', () => {
    password.string = "none";
    spectator_password.string = "none";
    SV_CheckVars();
    expect(Info_ValueForKey(svs.info, "needpass")).toBe("");
  });

  test("clearing both passwords removes needpass again", () => {
    password.string = "hunter2";
    SV_CheckVars();
    expect(Info_ValueForKey(svs.info, "needpass")).toBe("1");

    password.string = "";
    SV_CheckVars();
    expect(Info_ValueForKey(svs.info, "needpass")).toBe("");
  });
});

// SV_SendServerInfoChange is sv_ccmds.c-owned (src/qw/server/sv_ccmds.ts)
// but exercised here too: SV_CvarInfoHook (this file) calls it, and this
// suite already builds the fixture SV_CvarInfoHook's own tests need.
describe.skipIf(!HAVE_QWPROGS)("SV_SendServerInfoChange", () => {
  test("writes svc_serverinfo to the reliable datagram once a map is running", () => {
    sv.state = ServerStateT.ss_active;
    sv.reliable_datagram.cursize = 0;

    SV_SendServerInfoChange("watervis", "1");

    expect(sv.reliable_datagram.cursize).toBeGreaterThan(0);
    expect(sv.reliable_datagram.data[0]).toBe(52); // svc_serverinfo
    expect(latin1String(sv.reliable_datagram.data.subarray(1, sv.reliable_datagram.cursize))).toBe("watervis\0" + "1\0");
  });

  test("writes nothing while sv.state is ss_dead", () => {
    sv.state = ServerStateT.ss_dead;
    sv.reliable_datagram.cursize = 0;

    SV_SendServerInfoChange("watervis", "1");

    expect(sv.reliable_datagram.cursize).toBe(0);
  });
});

describe.skipIf(!HAVE_QWPROGS)("info cvar -> svs.info propagation through Cvar_Set", () => {
  beforeEach(() => {
    qw.active = true;
    setCvarInfoHook(SV_CvarInfoHook);
    registerOnce(watervis);
    registerOnce(maxspectators);
    svs.info = "";
  });

  afterEach(() => {
    setCvarInfoHook(null);
    qw.active = false;
    Cvar_Set("watervis", "0");
    Cvar_Set("maxspectators", "8");
  });

  test("an info-flagged cvar lands in svs.info when qw.active", () => {
    expect(watervis.info).toBe(true);

    Cvar_Set("watervis", "1");

    expect(Info_ValueForKey(svs.info, "watervis")).toBe("1");
    expect(watervis.value).toBe(1);
  });

  test("the same set also queues an svc_serverinfo for connected clients", () => {
    sv.state = ServerStateT.ss_active;
    sv.reliable_datagram.cursize = 0;

    Cvar_Set("maxspectators", "4");

    expect(Info_ValueForKey(svs.info, "maxspectators")).toBe("4");
    expect(sv.reliable_datagram.data[0]).toBe(52); // svc_serverinfo
  });

  test("with the hook removed the cvar still changes but svs.info does not", () => {
    setCvarInfoHook(null);
    svs.info = "";

    Cvar_Set("watervis", "1");

    expect(watervis.value).toBe(1);
    expect(Info_ValueForKey(svs.info, "watervis")).toBe("");
  });
});
