// Self-sufficient test for src/server/sv_user.ts (WinQuake sv_user.c).
//
// Builds a synthetic BSP (an infinite flat floor at z=0, per
// test/support/bsp_builder.ts -- the same fixture test/world.test.ts uses)
// so SV_Move-backed functions (SV_SetIdealPitch, SV_UserFriction) have a
// world to trace against, plus one bare player edict (test/pr_edict.test.ts's
// "bare EdictT" recipe -- no progs.dat execution needed anywhere in this
// file). SV_ReadClientMessage/SV_RunClients drive a real loopback QsocketT
// pair (net_loop.ts's Loop_Connect/CheckNewConnections, see
// test/net_loop.test.ts's file header for why NET_Init must be called here
// too: the qsocket pool is process-shared, and bun runs every test file in
// one process against one shared module instance).
//
// sv_user.ts imports `sv_friction`/`sv_stopspeed` from ./sv_phys and
// `svMainHooks` from ./sv_main -- both landed by the time this file was
// written, so the real cvars/hooks are used throughout, not fakes.

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COM_InitArgv, COM_InitFilesystem, COM_CheckRegistered, pop } from "../src/common/common";
import { writePakToDisk } from "./support/pak_builder";
import { Mod_ForName, Mod_Init, type ModelT } from "../src/common/model";
import { buildBsp, ensureDir, writeGameFile } from "./support/bsp_builder";
import { EdictT, setEdictTable } from "../src/progs/progs";
import { ENTVARS_SIZE_WORDS } from "../src/progs/progdefs";
import { YAW } from "../src/common/quakedef";
import { host } from "../src/common/host";
import { Cvar_RegisterVariable } from "../src/common/cvar";
import { SizeBuf, SZ_Alloc, SZ_Clear, MSG_WriteFloat, MSG_WriteAngle, MSG_WriteShort, MSG_WriteByte, MSG_WriteString, MSG_BeginReading, net_message } from "../src/common/sizebuf";
import { NET_Init, NET_Connect, NET_CheckNewConnections, setNetHostHooks, type NetHostHooks } from "../src/common/net_main";
import { netLoopDriver } from "../src/common/net_loop";
import { QsocketT } from "../src/common/net";
import { ClcOpsT } from "../src/common/protocol";
import { Cmd_AddCommand, CmdSourceT, cmdState } from "../src/common/cmd";
import { sv, svs, svState, UsercmdT, ClientT, MOVETYPE_WALK, MOVETYPE_NOCLIP, MOVETYPE_PUSH, FL_ONGROUND, SOLID_BSP } from "../src/server/server";
import { SV_ClearWorld } from "../src/server/world";
import { sv_friction, sv_stopspeed } from "../src/server/sv_phys";
import {
  cmd,
  wishdir,
  wishspeed,
  sv_edgefriction,
  sv_idealpitchscale,
  sv_maxspeed,
  sv_accelerate,
  svUserHooks,
  SV_SetIdealPitch,
  SV_UserFriction,
  SV_Accelerate,
  SV_AirAccelerate,
  SV_WaterMove,
  SV_AirMove,
  SV_ReadClientMove,
  SV_ReadClientMessage,
  SV_RunClients,
} from "../src/server/sv_user";

const scratchRoot = (process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests");
mkdirSync(scratchRoot, { recursive: true });
const scratchDir = mkdtempSync(join(scratchRoot, "sv_user-test-"));
const baseDir = join(scratchDir, "quake");

let mod: ModelT;

// Constructed eagerly (not inside beforeAll) because several describe()
// callbacks below reference `player` at describe-registration time (their
// bodies run synchronously, immediately, as the file is evaluated -- only
// test() bodies and beforeAll/beforeEach are deferred to the later execution
// phase). A `player` assigned only inside beforeAll would still read
// `undefined` at that earlier registration time; EdictT construction itself
// has no dependency on the BSP/model fixture beforeAll builds, so it is safe
// to build here instead.
const player = new EdictT(1, ENTVARS_SIZE_WORDS);

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

beforeAll(() => {
  ensureDir(join(baseDir, "id1"));
  writeGameFile(baseDir, "id1/maps/world.bsp", buildBsp());

  // gfx/pop.lmp inside id1/pak0.pak -- the registered-version check must
  // pass before COM_FindFile will search a loose "maps/world.bsp" path.
  const popLmp = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    popLmp[i * 2] = (pop[i] >> 8) & 0xff;
    popLmp[i * 2 + 1] = pop[i] & 0xff;
  }
  writePakToDisk(join(baseDir, "id1", "pak0.pak"), [{ name: "gfx/pop.lmp", data: popLmp }]);

  COM_InitArgv(["quake", "-basedir", baseDir]);
  COM_InitFilesystem();
  COM_CheckRegistered();
  Mod_Init();

  const loaded = Mod_ForName("maps/world.bsp", true);
  if (loaded === null) throw new Error("expected maps/world.bsp to load");
  mod = loaded;

  sv.worldmodel = mod;
  sv.models[1] = mod;

  // SV_SpawnServer's own edict-0 setup (sv_main.c): the world edict is a
  // SOLID_BSP/MOVETYPE_PUSH entity pointing at model slot 1.
  const world = new EdictT(0, ENTVARS_SIZE_WORDS);
  world.v.solid = SOLID_BSP;
  world.v.movetype = MOVETYPE_PUSH;
  world.v.modelindex = 1;

  sv.edicts = [world, player];
  sv.num_edicts = sv.edicts.length;
  sv.max_edicts = sv.edicts.length;
  setEdictTable(sv.edicts);

  SV_ClearWorld();

  // this file's own four cvars, plus sv_phys.ts's real sv_friction/
  // sv_stopspeed -- Cvar_RegisterVariable is a guarded no-op if another test
  // file already registered the same instance.
  Cvar_RegisterVariable(sv_edgefriction);
  Cvar_RegisterVariable(sv_idealpitchscale);
  Cvar_RegisterVariable(sv_maxspeed);
  Cvar_RegisterVariable(sv_accelerate);
  Cvar_RegisterVariable(sv_friction);
  Cvar_RegisterVariable(sv_stopspeed);
});

// test-only helper: puts the player edict and the module's `cmd` back into a
// known-good baseline before each test that reads/writes them directly.
function resetPlayer(): void {
  player.v.origin[0] = 0;
  player.v.origin[1] = 0;
  player.v.origin[2] = 50;
  player.v.velocity[0] = 0;
  player.v.velocity[1] = 0;
  player.v.velocity[2] = 0;
  player.v.angles[0] = 0;
  player.v.angles[1] = 0;
  player.v.angles[2] = 0;
  player.v.v_angle[0] = 0;
  player.v.v_angle[1] = 0;
  player.v.v_angle[2] = 0;
  player.v.punchangle[0] = 0;
  player.v.punchangle[1] = 0;
  player.v.punchangle[2] = 0;
  player.v.mins[0] = -16;
  player.v.mins[1] = -16;
  player.v.mins[2] = -24;
  player.v.maxs[0] = 16;
  player.v.maxs[1] = 16;
  player.v.maxs[2] = 32;
  player.v.view_ofs[0] = 0;
  player.v.view_ofs[1] = 0;
  player.v.view_ofs[2] = 22;
  player.v.movetype = MOVETYPE_WALK;
  player.v.flags = 0;
  player.v.health = 1;
  player.v.fixangle = 0;
  player.v.waterlevel = 0;
  player.v.watertype = 0;
  player.v.teleport_time = 0;
  player.v.idealpitch = 0;
  player.v.button0 = 0;
  player.v.button2 = 0;
  player.v.impulse = 0;
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.upmove = 0;
}

//============================================================================

describe("SV_Accelerate", () => {
  test("accelerates from rest toward wishdir, converging to wishspeed without ever exceeding it", () => {
    resetPlayer();
    svState.sv_player = player;
    host.frametime = 0.01;

    // prime the module's `wishdir`/`wishspeed` the only way sv_user.c itself
    // ever sets them: one real SV_AirMove call. MOVETYPE_NOCLIP's branch
    // computes wishdir/wishspeed exactly like every other movetype but skips
    // SV_UserFriction/SV_Accelerate/SV_AirAccelerate, so this primes state
    // without itself invoking the function under test.
    player.v.movetype = MOVETYPE_NOCLIP;
    player.v.angles[YAW] = 0;
    cmd.forwardmove = 1000; // clamped to sv_maxspeed (320) below
    SV_AirMove();
    expect(wishdir[0]).toBeCloseTo(1, 5);
    expect(wishspeed).toBeCloseTo(320, 3);

    player.v.velocity[0] = 0;
    player.v.velocity[1] = 0;
    player.v.velocity[2] = 0;
    player.v.movetype = MOVETYPE_WALK;

    for (let i = 0; i < 60; i++) {
      SV_Accelerate();
      expect(player.v.velocity[0]).toBeLessThanOrEqual(320.0001);
    }
    expect(player.v.velocity[0]).toBeCloseTo(320, 1);
    expect(player.v.velocity[1]).toBeCloseTo(0, 5);
    expect(player.v.velocity[2]).toBeCloseTo(0, 5);
  });
});

describe("SV_AirAccelerate", () => {
  test("caps wishspd at 30, clamping accelspeed to the addspeed that implies", () => {
    resetPlayer();
    svState.sv_player = player;
    host.frametime = 0.1;

    // prime the module's `wishspeed` to a known, large value -- SV_AirAccelerate's
    // own accelspeed formula reads the module global `wishspeed`, not the
    // local `wishspd` it just computed (sv_user.c's own bug, kept exactly as the C has it).
    player.v.movetype = MOVETYPE_NOCLIP;
    player.v.angles[YAW] = 0;
    cmd.forwardmove = 1000;
    SV_AirMove();
    expect(wishspeed).toBeCloseTo(320, 3);

    player.v.velocity[0] = 0;
    player.v.velocity[1] = 0;
    player.v.velocity[2] = 0;

    const wishveloc = new Float32Array([1000, 0, 0]); // far beyond the 30 cap
    SV_AirAccelerate(wishveloc);

    // uncapped, addspeed would be ~1000 (> accelspeed's 320, so accelspeed
    // would stay 320); capped at 30, addspeed is 30 (< 320), clamping
    // accelspeed down to 30.
    expect(player.v.velocity[0]).toBeCloseTo(30, 3);
    expect(player.v.velocity[1]).toBeCloseTo(0, 5);
    expect(player.v.velocity[2]).toBeCloseTo(0, 5);
  });
});

describe("SV_UserFriction", () => {
  test("slows a moving player on the solid floor (the edge-friction trace hits ground, not a dropoff)", () => {
    resetPlayer();
    svState.sv_player = player;
    host.frametime = 0.1;
    player.v.velocity[0] = 50;
    player.v.velocity[1] = 0;
    player.v.velocity[2] = 0;

    SV_UserFriction();

    const speedAfter = Math.hypot(player.v.velocity[0], player.v.velocity[1]);
    expect(speedAfter).toBeLessThan(50);
    expect(speedAfter).toBeGreaterThanOrEqual(0);
    // the synthetic BSP's floor is an infinite half-space with no real
    // dropoff, so the edge-friction trace here always has fraction < 1
    // (solid ground) and only sv_friction applies -- sv_friction *
    // sv_edgefriction (the actual-dropoff branch) is not exercisable with
    // this flat-floor fixture.
  });
});

describe("SV_SetIdealPitch", () => {
  test("flat ground leaves idealpitch at 0", () => {
    resetPlayer();
    svState.sv_player = player;
    player.v.flags = FL_ONGROUND;
    player.v.idealpitch = 999; // sentinel the C would also leave alone only via the explicit `idealpitch = 0` branch

    SV_SetIdealPitch();

    // flat, infinite ground: all six forward traces land at the same z, so
    // every `step` is inside +/-ON_EPSILON and `dir` never becomes nonzero.
    expect(player.v.idealpitch).toBe(0);
  });
});

describe("SV_AirMove", () => {
  test("computes wishdir/wishspeed from forwardmove/sidemove at yaw 0", () => {
    resetPlayer();
    svState.sv_player = player;
    host.frametime = 0.1;
    player.v.movetype = MOVETYPE_WALK;
    player.v.angles[YAW] = 0;
    cmd.forwardmove = 200;

    SV_AirMove();

    expect(wishdir[0]).toBeCloseTo(1, 5);
    expect(wishdir[1]).toBeCloseTo(0, 5);
    expect(wishdir[2]).toBeCloseTo(0, 5);
    expect(wishspeed).toBeCloseTo(200, 3); // below sv_maxspeed (320): no clamp
  });

  test("MOVETYPE_NOCLIP copies wishvel straight into velocity", () => {
    resetPlayer();
    svState.sv_player = player;
    host.frametime = 0.1;
    player.v.movetype = MOVETYPE_NOCLIP;
    player.v.angles[YAW] = 0;
    cmd.forwardmove = 200;
    cmd.upmove = 50; // upmove only feeds wishvel[2] for a non-MOVETYPE_WALK entity

    SV_AirMove();

    expect(player.v.velocity[0]).toBeCloseTo(200, 3);
    expect(player.v.velocity[1]).toBeCloseTo(0, 5);
    expect(player.v.velocity[2]).toBeCloseTo(50, 3);
  });
});

describe("SV_WaterMove", () => {
  test("with no input, adds a downward (-60) sink term", () => {
    resetPlayer();
    svState.sv_player = player;
    host.frametime = 0.1;

    SV_WaterMove();

    expect(player.v.velocity[2]).toBeLessThan(0);
    expect(player.v.velocity[0]).toBeCloseTo(0, 5);
    expect(player.v.velocity[1]).toBeCloseTo(0, 5);
  });
});

describe("SV_ReadClientMove", () => {
  test("parses a hand-built clc_move packet into cmd/v_angle/button0/button2/impulse and records a ping", () => {
    const client = new ClientT();
    client.edict = player;
    svState.host_client = client;
    sv.time = 10;

    SZ_Alloc(net_message, 2048);
    SZ_Clear(net_message);
    MSG_WriteFloat(net_message, 3); // ping = sv.time(10) - 3 = 7
    MSG_WriteAngle(net_message, 0); // pitch -- exact MSG_WriteAngle/ReadAngle round trip
    MSG_WriteAngle(net_message, 90); // yaw
    MSG_WriteAngle(net_message, 0); // roll
    MSG_WriteShort(net_message, 100);
    MSG_WriteShort(net_message, -50);
    MSG_WriteShort(net_message, 5);
    MSG_WriteByte(net_message, 3); // bits 0 and 1 set -> button0=1, button2=1
    MSG_WriteByte(net_message, 7); // impulse

    MSG_BeginReading();

    const move = new UsercmdT();
    SV_ReadClientMove(move);

    expect(client.ping_times[0]).toBeCloseTo(7, 5);
    expect(client.num_pings).toBe(1);
    expect(move.forwardmove).toBe(100);
    expect(move.sidemove).toBe(-50);
    expect(move.upmove).toBe(5);
    expect(player.v.v_angle[0]).toBeCloseTo(0, 5);
    expect(player.v.v_angle[1]).toBeCloseTo(90, 5);
    expect(player.v.v_angle[2]).toBeCloseTo(0, 5);
    expect(player.v.button0).toBe(1);
    expect(player.v.button2).toBe(1);
    expect(player.v.impulse).toBe(7);
  });

  test("a zero impulse byte leaves the edict's impulse field untouched", () => {
    const client = new ClientT();
    client.edict = player;
    svState.host_client = client;
    player.v.impulse = 42;
    sv.time = 10;

    SZ_Alloc(net_message, 2048);
    SZ_Clear(net_message);
    MSG_WriteFloat(net_message, 0);
    MSG_WriteAngle(net_message, 0);
    MSG_WriteAngle(net_message, 0);
    MSG_WriteAngle(net_message, 0);
    MSG_WriteShort(net_message, 0);
    MSG_WriteShort(net_message, 0);
    MSG_WriteShort(net_message, 0);
    MSG_WriteByte(net_message, 0);
    MSG_WriteByte(net_message, 0); // impulse byte 0 -- "if (i) impulse = i" does not fire

    MSG_BeginReading();
    SV_ReadClientMove(new UsercmdT());

    expect(player.v.impulse).toBe(42);
  });
});

//============================================================================
// SV_ReadClientMessage / SV_RunClients -- a real loopback QsocketT pair.

const fakeHooks: NetHostHooks = {
  svActive: () => false,
  svName: () => "",
  svsMaxclients: () => 32,
  svsMaxclientslimit: () => 32,
  setSvsMaxclients: () => {},
  clsStateDedicated: () => false,
  svsClients: () => [],
  deathmatch: () => false,
  hostClientPrivileged: () => false,
  svClientPrintf: () => {},
  scrUpdateScreen: () => {},
  menuSetReturnReason: () => {},
  menuHandleConnectError: () => {},
  menuConnectSucceeded: () => {},
  hostTime: () => 0,
};
setNetHostHooks(fakeHooks);
NET_Init(); // idempotent across test files sharing this process, see file header

// closed in this file's own afterAll, so a later test file's Loop_Connect
// still sees loop_client/loop_server reset to null, exactly as
// test/net_loop.test.ts leaves them.
const openLoopSockets: QsocketT[] = [];
afterAll(() => {
  for (const sock of openLoopSockets) netLoopDriver.Close(sock);
});

// Goes through net_main.ts's own NET_Connect/NET_CheckNewConnections (not
// netLoopDriver.Connect/CheckNewConnections directly, unlike
// test/net_loop.test.ts) because SV_ReadClientMessage calls net_main.ts's
// NET_GetMessage, which indexes net_drivers[sock.driver] -- that field is
// only ever set correctly (0, the loop driver's slot) when net_driverlevel
// has been reset to 0 first, which is NET_Connect's/NET_CheckNewConnections's
// own job. Calling netLoopDriver.Connect directly leaves sock.driver reading
// whatever net_driverlevel was last left at (net_numdrivers, from NET_Init's
// own driver-init loop), an out-of-range net_drivers index.
function connectLoopback(): { client: QsocketT; server: QsocketT } {
  const client = NET_Connect("local");
  if (client === null) throw new Error("expected a client socket");
  const server = NET_CheckNewConnections();
  if (server === null) throw new Error("expected a server socket");
  openLoopSockets.push(client, server);
  return { client, server };
}

function sendStringcmd(client: QsocketT, text: string): void {
  const msg = new SizeBuf();
  SZ_Alloc(msg, 2048);
  MSG_WriteByte(msg, ClcOpsT.clc_stringcmd);
  MSG_WriteString(msg, text);
  expect(netLoopDriver.QSendMessage(client, msg)).toBe(1);
}

// A real function boundary with an explicit return type, not a bare
// `cmdState.source` read: TS narrows a property read to the literal type of
// its last-seen assignment even across intervening calls it can't prove are
// unrelated, which makes a direct `expect(cmdState.source).toBe(otherMember)`
// a false "no overlap" compile error once this file resets cmdState.source
// to a known value before provoking a dispatch elsewhere.
function currentCmdSource(): CmdSourceT {
  return cmdState.source;
}

describe("SV_ReadClientMessage", () => {
  const { client, server } = connectLoopback();

  const hostClient = new ClientT();
  hostClient.active = true;
  hostClient.privileged = false;
  hostClient.name = "tester";
  hostClient.netconnection = server;
  hostClient.edict = player;
  // Own private fixture, not a shared singleton -- no restore needed. Sized
  // so SV_ClientPrintf (host.ts) has somewhere to write if "status" below
  // dispatches to the real Host_Status_f rather than this suite's own fake
  // handler (see that test's own comment).
  SZ_Alloc(hostClient.message, 2048);

  // svState.host_client is a shared, process-wide singleton -- other
  // describe blocks in this same file (SV_ReadClientMove's tests, which run
  // during the execution phase, after every describe() callback in the file
  // has already run eagerly at registration time) reassign it to their own
  // ClientT in between. Re-pointing it here before each test, rather than
  // once at describe-registration time, keeps it correctly wired to this
  // describe block's own hostClient/server pair for every test below.
  beforeEach(() => {
    svState.host_client = hostClient;
  });

  test('delivers clc_stringcmd "status" -- dispatches via Cmd_ExecuteString with src_client', () => {
    // "status" is a real command (host_cmd.ts's Host_InitCommands registers
    // it to Host_Status_f) with no unregister, matching the C -- once any
    // suite in this process has run a real boot (test/host_cmd.test.ts,
    // test/host.test.ts, test/main_boot.test.ts, ...) it is permanently
    // claimed and Cmd_AddCommand here would be a silent no-op, so this test
    // does not depend on ITS OWN handler being the one Cmd_ExecuteString
    // finds. sv_user.ts's allow-list gate (ret2=1 for the "status" prefix)
    // calls Cmd_ExecuteString(s, src_client) regardless of whether a handler
    // is registered at all, and Cmd_ExecuteString sets cmdState.source
    // unconditionally before it looks one up -- reset it to a different
    // value first so a stale src_client from an earlier test can't produce
    // a false pass (rule 15).
    cmdState.source = CmdSourceT.src_command;

    sendStringcmd(client, "status");
    expect(SV_ReadClientMessage()).toBe(true);
    expect(currentCmdSource()).toBe(CmdSourceT.src_client);
  });

  test('an unprivileged "kick" still dispatches -- sv_user.c:564 lists it in the always-allowed prefix table (ret=1) regardless of privilege; the real gate lives in host_cmd.c\'s Kick_f, landed since this test was written. Documented discrepancy from a naive "kick should be refused" expectation.', () => {
    // Same reasoning as the "status" test above: host_cmd.ts's Host_Kick_f
    // is now landed and permanently registered the moment any suite in this
    // process has booted for real, so assert through cmdState.source
    // (sv_user.ts's own dispatch decision) rather than a handler this test
    // installs, which may never run.
    cmdState.source = CmdSourceT.src_command;

    sendStringcmd(client, "kick somebody");
    expect(SV_ReadClientMessage()).toBe(true);
    expect(currentCmdSource()).toBe(CmdSourceT.src_client);
  });

  test("an unprivileged command NOT on the allow-list is refused (no dispatch)", () => {
    let ran = false;
    Cmd_AddCommand("notallowedcmd", () => {
      ran = true;
    });

    sendStringcmd(client, "notallowedcmd");
    expect(SV_ReadClientMessage()).toBe(true); // refused, but the client itself isn't dropped
    expect(ran).toBe(false);
  });

  test("clc_disconnect returns false", () => {
    const msg = new SizeBuf();
    SZ_Alloc(msg, 2048);
    MSG_WriteByte(msg, ClcOpsT.clc_disconnect);
    expect(netLoopDriver.QSendMessage(client, msg)).toBe(1);

    expect(SV_ReadClientMessage()).toBe(false);
  });

  test("an unknown opcode returns false", () => {
    const msg = new SizeBuf();
    SZ_Alloc(msg, 2048);
    MSG_WriteByte(msg, 50); // not a member of ClcOpsT
    expect(netLoopDriver.QSendMessage(client, msg)).toBe(1);

    expect(SV_ReadClientMessage()).toBe(false);
  });

  test("no pending message returns true without reading anything", () => {
    expect(SV_ReadClientMessage()).toBe(true);
  });
});

describe("SV_RunClients", () => {
  const { server } = connectLoopback();

  const runClient = new ClientT();
  runClient.active = true;
  runClient.spawned = true;
  runClient.edict = player;
  runClient.netconnection = server; // never sent to -- NET_GetMessage returns 0 (no message)
  runClient.cmd.forwardmove = 100;

  test("a spawned client with svUserHooks.keyDestIsGame null runs SV_ClientThink (velocity changes)", () => {
    resetPlayer();
    player.v.flags = FL_ONGROUND;
    host.frametime = 0.1;
    sv.time = 100;
    sv.paused = false;
    // src/client/keys.ts installs the real hook (`() => keyState.key_dest ===
    // KeydestT.key_game`) at module load, the moment anything in this
    // process imports it (src/main.ts does, so any suite that boots through
    // Sys_Main_Init pulls it in); this test's own subject is the hook-absent
    // fallback (sv_user.ts defaults `keyDestIsGame` to true when the hook
    // isn't installed), so force that precondition here instead of assuming
    // it's still unset process-wide (rule 15).
    const savedKeyDestIsGame = svUserHooks.keyDestIsGame;
    svUserHooks.keyDestIsGame = null;

    svs.maxclients = 1;
    svs.clients = [runClient];

    try {
      SV_RunClients();

      const speed = Math.hypot(player.v.velocity[0], player.v.velocity[1], player.v.velocity[2]);
      expect(speed).toBeGreaterThan(0);
    } finally {
      svUserHooks.keyDestIsGame = savedKeyDestIsGame;
    }
  });

  test("SV_RunClients does not run SV_ClientThink while sv.paused", () => {
    player.v.velocity[0] = 0;
    player.v.velocity[1] = 0;
    player.v.velocity[2] = 0;
    sv.paused = true;

    SV_RunClients();

    expect(player.v.velocity[0]).toBe(0);
    expect(player.v.velocity[1]).toBe(0);
    expect(player.v.velocity[2]).toBe(0);

    sv.paused = false; // restore -- `sv` is a shared, process-wide singleton
  });
});
