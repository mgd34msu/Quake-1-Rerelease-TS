// Tests for src/client/splitscreen.ts (U43) -- local splitscreen, two to four
// players on one screen, one loopback client each.
//
// Self-sufficient per the standing orders: every block that changes a shared
// singleton saves and restores it. That means `vid.width`/`vid.height`, the
// `cl_splitscreen`/`cl_splitscreen_layout`/`coop`/`deathmatch` cvars,
// `sv.active`, `svs.maxclients`/`maxclientslimit`/`clients`, `re.current`,
// `scrState`, the loopback driver's socket table (every socket this file
// opens is closed again), the injected fake gamepads, and the seat table
// itself (SS_Shutdown puts the client back on one seat, which is the state
// every other suite in this process expects to find).
//
// The five layers, and why each one is drawn where it is:
//
//  1. SS_Layout -- pure geometry, no fixtures. The layout table for 1/2/3/4
//     seats, plus the invariants that hold at every count (panes never
//     overlap, never leave the display, and tile it up to the alignment
//     slack that becomes the divider).
//  2. The seat switch -- SS_ActivateSeat repointing `cl`/`cls`/`cl_entities`,
//     which is the whole multiplexing mechanism (client.ts's live bindings).
//  3. net_loop.ts's multiple connection pairs, which is what lets a second
//     seat connect at all.
//  4. The server, guarded on progs106/progs.dat: two loopback sockets
//     through the ordinary SV_ConnectClient, landing on distinct player
//     edicts, with the svc_setviews byte in each local client's serverinfo.
//  5. The HUD and the input path: Sbar_Draw once per seat into that seat's
//     pane through a recording fake renderer, and a fake second controller
//     reaching seat 1's usercmd and nobody else's.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { COM_CheckRegistered, COM_InitArgv, COM_InitFilesystem } from "../src/common/common";
import { CvarT, Cvar_FindVar, Cvar_RegisterVariable, Cvar_Set } from "../src/common/cvar";
import { Cmd_ExecuteString, CmdSourceT } from "../src/common/cmd";
import { Mod_Init } from "../src/common/model";
import { PR_LoadProgs } from "../src/progs/pr_edict";
import { HostError, Host_Error, SeatError, coop, deathmatch, hostClientHooks, max_edicts, skill } from "../src/common/host";
import { sysState } from "../src/platform/sys";
import { ClientT, sv, svs } from "../src/server/server";
import { SV_ConnectClient, SV_Init, SV_SpawnServer, sv_protocol, svMainHooks } from "../src/server/sv_main";
import { NUM_FOR_EDICT } from "../src/progs/progs";
import { netLoopDriver } from "../src/common/net_loop";
import { NET_Close, NET_Init, getNetHostHooks, net_drivers, setNetHostHooks, type NetHostHooks } from "../src/common/net_main";
import { QsocketT } from "../src/common/net";
import { SizeBuf, SZ_Alloc } from "../src/common/sizebuf";
import { svc_setviews } from "../src/common/protocol";

import { CactiveT, cl, cls, cl_entities, ScoreboardT, SIGNONS } from "../src/client/client";
import { EntityT, ParticleT, r_refdef, re } from "../src/client/render";
import type { Renderer } from "../src/client/render";
import { vid, VrectT } from "../src/client/vid";
import { scrState, scr_vrect } from "../src/client/screen_types";
import { scr_viewsize } from "../src/client/screen";
import type { ModelLoaderHooks } from "../src/common/model";
import { TextureT } from "../src/common/model";
import { QpicT } from "../src/common/wad";
import { STAT_HEALTH } from "../src/common/quakedef";
import { Sbar_Changed, Sbar_Draw, Sbar_Init } from "../src/client/sbar";
import { UsercmdT } from "../src/server/server";
import { CL_SeatMove, cl_forwardspeed, cl_sidespeed } from "../src/client/cl_input";
import { host } from "../src/common/host";
import { keyState, KeydestT } from "../src/client/keys";
import {
  MAX_SEATS,
  SPLIT_LAYOUT_SIDE_BY_SIDE,
  SS_ActivateSeat,
  SS_ActiveSeat,
  SS_ApplySeatRect,
  SS_Canvas,
  SS_ConsolePrint,
  SS_DropSeat,
  SS_Init,
  SS_IsPrimary,
  SS_Layout,
  SS_PrintLine,
  SS_ReadFromServer,
  SS_Seat,
  SS_SeatButtons,
  SS_SeatColorCvar,
  SS_SeatCount,
  SS_SeatRect,
  SS_Reconcile,
  SS_HeldClientSlots,
  SS_ServerSpawned,
  SS_SetSeats,
  SS_Shutdown,
  SS_WidenServer,
  SS_WithSeat,
  cl_splitscreen_layout,
  seatDisconnectHooks,
} from "../src/client/splitscreen";
import * as consoleMod from "../src/client/console";
import {
  SDL_GamepadDevices,
  SDL_InjectFakeGamepadForTests,
  SDL_RemoveFakeGamepadForTests,
  SDL_SetFakeGamepadStateForTests,
  joy_enable,
} from "../src/platform/sdl";
import { PlayerDeviceCvarName, RegisterPlayerCvars } from "../src/platform/gamepad_assign";
import { HAVE_PROGS106 } from "./support/fixture_availability";
import { buildDedicatedFixture } from "./support/dedicated_fixture";

//=============================================================================
// shared save/restore
//=============================================================================

const savedVidWidth = vid.width;
const savedVidHeight = vid.height;
const savedSvActive = sv.active;
const savedMaxclients = svs.maxclients;
const savedMaxclientslimit = svs.maxclientslimit;
const savedClients = svs.clients;
/*
SS_WidenServer turns `coop` on for a multi-seat session, so this suite has to
put both game-type cvars back exactly as it found them -- BOTH halves of them.
Restoring only `.value` leaves `.string` reading "1.000000", and a cvar whose
two halves disagree is a singleton this suite mutated and did not restore
(standing order 13): menu.ts's mpGameType() picks the New Game screen's whole
map list off `coop`, so a leftover coop turns dm1 into a co-op map and the
Bots page reports itself disabled.
*/
const savedCoop = { value: coop.value, string: coop.string };
const savedDeathmatch = { value: deathmatch.value, string: deathmatch.string };

/** Put a cvar back to both halves of the value it had before this suite ran.
 *  Cvar_Set writes both when the cvar is registered; an unregistered cvar has
 *  no table entry to go through, so its fields are assigned directly. */
function restoreCvar(cvar: CvarT, saved: { value: number; string: string }): void {
  if (Cvar_FindVar(cvar.name) !== null) Cvar_Set(cvar.name, saved.string);
  cvar.value = saved.value;
  cvar.string = saved.string;
}
const savedRenderer = re.current;
const savedSbLines = scrState.sb_lines;
const savedNostdout = sysState.nostdout;
const savedLocalSeatCount = svMainHooks.localSeatCount;
const savedFrametime = host.frametime;
const savedKeyDest = keyState.key_dest;
const savedJoyEnable = joy_enable.value;
const savedVidNumpages = vid.numpages;
const savedConCurrent = scrState.scr_con_current;
const savedSkill = { value: skill.value, string: skill.string };
const savedLayout = { value: cl_splitscreen_layout.value, string: cl_splitscreen_layout.string };
const savedNetHooks = getNetHostHooks();

/*
net_loop.ts's Loop_Connect draws from net_main.ts's qsocket pool, and
NET_NewQSocket also refuses once `net_activeconnections` reaches the host's
maxclients -- so this file installs the same generously-sized fake
NetHostHooks test/net_loop.test.ts uses and calls the real NET_Init, which is
the only sanctioned way to seed that pool. Restored in afterAll.
*/
const fakeNetHooks: NetHostHooks = {
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

beforeAll(() => {
  sysState.nostdout = 1;
  SS_Init();
  // SS_WidenServer sets `coop` through the cvar table; a bare test process
  // has not run Host_InitLocal, so register the two it reads.
  if (Cvar_FindVar("coop") === null) Cvar_RegisterVariable(coop);
  if (Cvar_FindVar("deathmatch") === null) Cvar_RegisterVariable(deathmatch);
  setNetHostHooks(fakeNetHooks);
  NET_Init();
});

afterAll(() => {
  resetSuiteState();
  sysState.nostdout = savedNostdout;
  setNetHostHooks(savedNetHooks);
  cl.clear();
});

/*
Every seat is torn down, seat 0 is bound again, and every process-wide
singleton this suite touches is put back where it was found. Each describe
block runs this in its own afterAll, so no block inherits another's state and
nothing survives the file -- the last describe below then ASSERTS all of it,
which is what keeps this helper honest as the suite grows.

`coop` in particular: SS_WidenServer turns it on for a multi-seat session, and
menu.ts's mpGameType() picks the New Game screen's whole map list off it.
*/
function resetSuiteState(): void {
  SS_Shutdown();
  SS_ActivateSeat(0);

  restoreCvar(coop, savedCoop);
  restoreCvar(deathmatch, savedDeathmatch);
  restoreCvar(skill, savedSkill);
  restoreCvar(cl_splitscreen_layout, savedLayout);

  sv.active = savedSvActive;
  svs.maxclients = savedMaxclients;
  svs.maxclientslimit = savedMaxclientslimit;
  svs.clients = savedClients;

  vid.width = savedVidWidth;
  vid.height = savedVidHeight;
  vid.numpages = savedVidNumpages;
  scrState.sb_lines = savedSbLines;
  scrState.scr_con_current = savedConCurrent;
  re.current = savedRenderer;

  svMainHooks.localSeatCount = savedLocalSeatCount;
  host.frametime = savedFrametime;
  keyState.key_dest = savedKeyDest;
  joy_enable.value = savedJoyEnable;
}

/*
Every qsocket this file opens, so the hygiene block at the end can assert that
each one was closed through net_main's NET_Close (which runs NET_FreeQSocket
and takes it off `net_activeSockets`). Tracking THIS suite's own sockets is
the only sound check available: `net_activeSockets` is process-wide and other
suites in the same bun process leave their own loopback sockets on it, so
"nothing loopback-shaped is on the active list" would be a claim about them,
not about this file.
*/
const suiteSockets: QsocketT[] = [];

function trackSocket(sock: QsocketT | null): QsocketT | null {
  if (sock !== null) suiteSockets.push(sock);
  return sock;
}

/** The older, narrower name every block already used. */
function oneSeat(): void {
  SS_Shutdown();
  SS_ActivateSeat(0);
}

/** Raise the seat count with no server running -- SS_SetSeats' own
 *  "no server yet, widen the slot count for the next map" path, which is how
 *  a player types `cl_splitscreen 2` at the console before loading a map. */
function seats(n: number): void {
  sv.active = false;
  SS_SetSeats(n);
}

//=============================================================================
// 1. LAYOUT
//=============================================================================

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("SS_Layout -- the pane table", () => {
  test("one seat is the whole screen", () => {
    const [pane] = SS_Layout(1, 640, 480, 0);
    expect(pane).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });

  test("two seats are stacked top/bottom by default -- a full-width pane keeps the whole horizontal fov", () => {
    const panes = SS_Layout(2, 640, 480, 0);
    expect(panes.length).toBe(2);
    expect(panes[0]).toEqual({ x: 0, y: 0, width: 640, height: 240 });
    expect(panes[1]).toEqual({ x: 0, y: 240, width: 640, height: 240 });
  });

  test("cl_splitscreen_layout 1 cuts two seats left/right instead", () => {
    const panes = SS_Layout(2, 640, 480, SPLIT_LAYOUT_SIDE_BY_SIDE);
    expect(panes[0]).toEqual({ x: 0, y: 0, width: 320, height: 480 });
    expect(panes[1]).toEqual({ x: 320, y: 0, width: 320, height: 480 });
  });

  test("three seats are a full-width pane over two half-width ones", () => {
    const panes = SS_Layout(3, 640, 480, 0);
    expect(panes.length).toBe(3);
    expect(panes[0]).toEqual({ x: 0, y: 0, width: 640, height: 240 });
    expect(panes[1]).toEqual({ x: 0, y: 240, width: 320, height: 240 });
    expect(panes[2]).toEqual({ x: 320, y: 240, width: 320, height: 240 });
  });

  test("four seats tile the screen as quadrants", () => {
    const panes = SS_Layout(4, 640, 480, 0);
    expect(panes.length).toBe(4);
    expect(panes[0]).toEqual({ x: 0, y: 0, width: 320, height: 240 });
    expect(panes[1]).toEqual({ x: 320, y: 0, width: 320, height: 240 });
    expect(panes[2]).toEqual({ x: 0, y: 240, width: 320, height: 240 });
    expect(panes[3]).toEqual({ x: 320, y: 240, width: 320, height: 240 });

    // and they really do cover the screen exactly
    let area = 0;
    for (const p of panes) area += p.width * p.height;
    expect(area).toBe(640 * 480);
  });

  test("no two panes overlap, and none leaves the display, at every count and on an unaligned mode", () => {
    for (const [w, h] of [
      [640, 480],
      [1366, 768],
      [1920, 1080],
      [1023, 767],
    ] as const) {
      for (let n = 1; n <= MAX_SEATS; n++) {
        for (const mode of [0, 1, 2]) {
          const panes = SS_Layout(n, w, h, mode);
          expect(panes.length).toBe(n);
          for (const p of panes) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.x + p.width).toBeLessThanOrEqual(w);
            expect(p.y + p.height).toBeLessThanOrEqual(h);
            // the software rasterizer's span alignment
            expect(p.width % 8).toBe(0);
            expect(p.height % 2).toBe(0);
          }
          for (let i = 0; i < panes.length; i++) {
            for (let j = i + 1; j < panes.length; j++) {
              expect(overlaps(panes[i], panes[j])).toBe(false);
            }
          }
        }
      }
    }
  });

  test("the alignment slack is a divider, not a missing chunk of screen", () => {
    const panes = SS_Layout(4, 1023, 767, 0);
    let area = 0;
    for (const p of panes) area += p.width * p.height;
    // at most eight columns and two rows are given up in total
    expect(area).toBeGreaterThan(1023 * 767 - (8 * 767 + 2 * 1023));
  });

  test("the count is clamped to 1..MAX_SEATS", () => {
    expect(SS_Layout(0, 640, 480, 0).length).toBe(1);
    expect(SS_Layout(-3, 640, 480, 0).length).toBe(1);
    expect(SS_Layout(99, 640, 480, 0).length).toBe(MAX_SEATS);
  });
});

//=============================================================================
// 2. THE SEAT SWITCH
//=============================================================================

describe("SS_ActivateSeat -- the client's live bindings follow the seat", () => {
  // bun runs every test file in one process: a suite that ran before this
  // one may have seated players and left their view angles, stats and
  // entity frames behind. Start from dropped seats, and clear the few
  // fields the tests below assert on.
  beforeAll(() => {
    SS_Shutdown();
    SS_ActivateSeat(0);
    for (const seat of [1, 2]) {
      SS_WithSeat(seat, () => {
        cl.clear();
        cl.viewangles.fill(0);
        cl.stats.fill(0);
        cl_entities[3].frame = 0;
      });
    }
  });
  afterAll(resetSuiteState);

  test("seat 0 is the client.ts singletons; seat 1 has its own cl, cls and entity array", () => {
    const seat0cl = cl;
    const seat0cls = cls;
    const seat0ents = cl_entities;

    expect(SS_ActiveSeatIsPrimary()).toBe(true);

    SS_ActivateSeat(1);
    expect(cl).not.toBe(seat0cl);
    expect(cls).not.toBe(seat0cls);
    expect(cl_entities).not.toBe(seat0ents);
    // seat 0's array may have been grown by an earlier suite (the client
    // grows cl_entities as a server's edict count demands); a fresh seat
    // starts at the initial size. Both are real entity arrays.
    expect(cl_entities.length).toBeGreaterThan(0);
    expect(SS_IsPrimary()).toBe(false);

    SS_ActivateSeat(0);
    expect(cl).toBe(seat0cl);
    expect(cls).toBe(seat0cls);
    expect(cl_entities).toBe(seat0ents);
    expect(SS_IsPrimary()).toBe(true);
  });

  test("each seat keeps its own view angles, stats and entity snapshot", () => {
    cl.viewangles[1] = 45;
    cl.stats[STAT_HEALTH] = 100;
    cl_entities[3].frame = 7;

    SS_WithSeat(1, () => {
      expect(cl.viewangles[1]).toBe(0);
      expect(cl.stats[STAT_HEALTH]).toBe(0);
      expect(cl_entities[3].frame).toBe(0);
      cl.viewangles[1] = 300;
      cl.stats[STAT_HEALTH] = 25;
      cl_entities[3].frame = 2;
    });

    expect(cl.viewangles[1]).toBe(45);
    expect(cl.stats[STAT_HEALTH]).toBe(100);
    expect(cl_entities[3].frame).toBe(7);

    SS_WithSeat(1, () => {
      expect(cl.viewangles[1]).toBe(300);
      expect(cl.stats[STAT_HEALTH]).toBe(25);
      expect(cl_entities[3].frame).toBe(2);
    });

    cl.viewangles[1] = 0;
    cl.stats[STAT_HEALTH] = 0;
    cl_entities[3].frame = 0;
  });

  test("SS_WithSeat restores the previous seat even when the body throws", () => {
    expect(() => {
      SS_WithSeat(2, () => {
        throw new Error("Host_Error unwinding out of a seat's window");
      });
    }).toThrow("Host_Error unwinding out of a seat's window");
    expect(SS_IsPrimary()).toBe(true);
  });
});

/** Local helper so the first assertion above reads as a statement about the
 *  seat that is active, not about a module import. */
function SS_ActiveSeatIsPrimary(): boolean {
  return SS_IsPrimary();
}

//=============================================================================
// 3. THE VIEWPORT RECT
//=============================================================================

describe("SS_ApplySeatRect -- r_refdef.vrect per seat", () => {
  beforeAll(() => {
    vid.width = 640;
    vid.height = 480;
    scrState.sb_lines = 0;
  });
  afterAll(resetSuiteState);

  test("with one seat the rect SCR_CalcRefdef computed is left alone", () => {
    oneSeat();
    r_refdef.vrect.x = 0;
    r_refdef.vrect.y = 0;
    r_refdef.vrect.width = 640;
    r_refdef.vrect.height = 480;
    SS_ApplySeatRect(0);
    expect(r_refdef.vrect.width).toBe(640);
    expect(r_refdef.vrect.height).toBe(480);
  });

  test("with two seats each seat's view lands inside its own pane, and scr_vrect follows", () => {
    seats(2);
    for (let seat = 0; seat < 2; seat++) {
      SS_WithSeat(seat, () => {
        r_refdef.vrect.x = 0;
        r_refdef.vrect.y = 0;
        r_refdef.vrect.width = vid.width; // a full-size `viewsize 100` view
        r_refdef.vrect.height = vid.height;
        SS_ApplySeatRect(0);

        const pane = SS_SeatRect(seat);
        expect(r_refdef.vrect.x).toBeGreaterThanOrEqual(pane.x);
        expect(r_refdef.vrect.y).toBeGreaterThanOrEqual(pane.y);
        expect(r_refdef.vrect.x + r_refdef.vrect.width).toBeLessThanOrEqual(pane.x + pane.width);
        expect(r_refdef.vrect.y + r_refdef.vrect.height).toBeLessThanOrEqual(pane.y + pane.height);
        expect(scr_vrect.x).toBe(r_refdef.vrect.x);
        expect(scr_vrect.y).toBe(r_refdef.vrect.y);
        expect(scr_vrect.width).toBe(r_refdef.vrect.width);
        expect(scr_vrect.height).toBe(r_refdef.vrect.height);
      });
    }
  });

  test("a reduced viewsize keeps its proportion inside the pane", () => {
    // The fraction comes from `viewsize` -- where both renderers' R_SetVrect
    // reads it -- not from whatever r_refdef.vrect happens to hold, which by
    // the second seat is the FIRST seat's pane.
    if (Cvar_FindVar("viewsize") === null) Cvar_RegisterVariable(scr_viewsize);
    const savedViewsize = Cvar_FindVar("viewsize")?.string ?? "100";
    try {
      Cvar_Set("viewsize", "80");
      seats(2);
      SS_WithSeat(1, () => {
        r_refdef.vrect.x = 64;
        r_refdef.vrect.y = 48;
        r_refdef.vrect.width = 512;
        r_refdef.vrect.height = 384;
        SS_ApplySeatRect(0);
        const pane = SS_SeatRect(1);
        expect(r_refdef.vrect.width).toBeLessThan(pane.width);
        expect(r_refdef.vrect.x).toBeGreaterThan(pane.x);
        expect(r_refdef.vrect.y + r_refdef.vrect.height).toBeLessThanOrEqual(pane.y + pane.height);
      });
    } finally {
      Cvar_Set("viewsize", savedViewsize);
    }
  });

  test("the pane a seat gets does not shrink when the rect is cut again", () => {
    // A REGRESSION GUARD: measuring the view fraction off r_refdef.vrect made
    // this function's output its own next input, so every seat after the
    // first -- and every frame after the first -- got a smaller view than the
    // one before it.
    if (Cvar_FindVar("viewsize") === null) Cvar_RegisterVariable(scr_viewsize);
    const savedViewsize = Cvar_FindVar("viewsize")?.string ?? "100";
    try {
      Cvar_Set("viewsize", "90");
      seats(2);
      const cut = (seat: number): Rect =>
        SS_WithSeat(seat, () => {
          SS_ApplySeatRect(0);
          return { x: r_refdef.vrect.x, y: r_refdef.vrect.y, width: r_refdef.vrect.width, height: r_refdef.vrect.height };
        });

      const seat0First = cut(0);
      const seat1First = cut(1);
      // a second pass over both seats, the way the next frame's render loop
      // runs, lands on exactly the same two rects
      expect(cut(0)).toEqual(seat0First);
      expect(cut(1)).toEqual(seat1First);
      // and neither seat's view collapsed towards the 96-pixel floor
      expect(seat0First.width).toBeGreaterThan(SS_SeatRect(0).width / 2);
      expect(seat1First.width).toBeGreaterThan(SS_SeatRect(1).width / 2);
    } finally {
      Cvar_Set("viewsize", savedViewsize);
    }
  });

  test("four seats give four disjoint view rects", () => {
    seats(4);
    const rects: Rect[] = [];
    for (let seat = 0; seat < 4; seat++) {
      SS_WithSeat(seat, () => {
        r_refdef.vrect.x = 0;
        r_refdef.vrect.y = 0;
        r_refdef.vrect.width = vid.width;
        r_refdef.vrect.height = vid.height;
        SS_ApplySeatRect(0);
        rects.push({ x: r_refdef.vrect.x, y: r_refdef.vrect.y, width: r_refdef.vrect.width, height: r_refdef.vrect.height });
      });
    }
    expect(rects.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
  });
});

//=============================================================================
// 4. THE LOOPBACK DRIVER -- one connection pair per seat
//=============================================================================

describe("net_loop.ts -- a connection pair per seat", () => {
  const opened: QsocketT[] = [];

  afterAll(() => {
    // net_main's NET_Close, not the driver's own Close: only NET_Close runs
    // NET_FreeQSocket, which unlinks the socket from `net_activeSockets` and
    // puts it back on the free list. A socket closed at the driver level
    // stays on the active list forever and is walked by the next
    // NET_Shutdown in this bun process (standing order 13's "restores every
    // shared singleton it mutates ... loopback sockets"). NET_Close returns
    // early on an already-closed socket, so closing twice is safe.
    for (const s of opened) NET_Close(s);
    opened.length = 0;
  });

  test("two Connect(\"local\") calls give two independent pairs", () => {
    const clientA = trackSocket(netLoopDriver.Connect("local"));
    expect(clientA).not.toBeNull();
    const serverA = trackSocket(netLoopDriver.CheckNewConnections());
    expect(serverA).not.toBeNull();

    const clientB = trackSocket(netLoopDriver.Connect("local"));
    expect(clientB).not.toBeNull();
    const serverB = trackSocket(netLoopDriver.CheckNewConnections());
    expect(serverB).not.toBeNull();

    if (!clientA || !clientB || !serverA || !serverB) return;
    opened.push(clientA, clientB, serverA, serverB);

    expect(clientA).not.toBe(clientB);
    expect(serverA).not.toBe(serverB);
    expect(clientA.driverdata).toBe(serverA);
    expect(serverA.driverdata).toBe(clientA);
    expect(clientB.driverdata).toBe(serverB);
    expect(serverB.driverdata).toBe(clientB);

    // and nothing is left pending after both were accepted
    expect(trackSocket(netLoopDriver.CheckNewConnections())).toBeNull();
  });

  test("a seat's loopback sockets are closable through net_main -- the NET_Shutdown path", () => {
    // A REGRESSION GUARD for a real defect. NET_Close dispatches on
    // `net_drivers[sock.driver]`, and NET_NewQSocket stamps a new socket with
    // whatever `net_driverlevel` currently is -- which every one of
    // net_main's driver loops leaves at `net_numdrivers`, one past the end of
    // the table. A loopback socket opened by anything other than NET_Connect
    // walking the driver table therefore used to carry an index whose
    // `net_drivers[...]` is `undefined`, and the next NET_Close of it (the
    // sweep of `net_activeSockets` inside NET_Shutdown, on a dedicated
    // server's Host_Shutdown) threw `undefined is not an object (evaluating
    // 'sfunc(sock).Close')` instead of closing.
    const client = trackSocket(netLoopDriver.Connect("local"));
    const server = trackSocket(netLoopDriver.CheckNewConnections());
    if (!client || !server) throw new Error("loopback pair not created");

    expect(net_drivers[client.driver]).toBe(netLoopDriver);
    expect(net_drivers[server.driver]).toBe(netLoopDriver);

    expect(() => NET_Close(client)).not.toThrow();
    expect(() => NET_Close(server)).not.toThrow();
    // and both are off the active list, so a later NET_Shutdown never sees
    // them at all
    expect(client.disconnected).toBe(true);
    expect(server.disconnected).toBe(true);
  });

  test("a message on one seat's pair never lands on another's", () => {
    const clientA = trackSocket(netLoopDriver.Connect("local"));
    const serverA = trackSocket(netLoopDriver.CheckNewConnections());
    const clientB = trackSocket(netLoopDriver.Connect("local"));
    const serverB = trackSocket(netLoopDriver.CheckNewConnections());
    if (!clientA || !clientB || !serverA || !serverB) throw new Error("loopback pair not created");
    opened.push(clientA, clientB, serverA, serverB);

    const msg = new SizeBuf();
    SZ_Alloc(msg, 16);
    msg.data[0] = 0x42;
    msg.cursize = 1;

    expect(netLoopDriver.QSendMessage(clientA, msg)).toBe(1);
    expect(serverA.receiveMessageLength).toBeGreaterThan(0);
    expect(serverB.receiveMessageLength).toBe(0);
    expect(netLoopDriver.QGetMessage(serverA)).toBe(1);
    expect(netLoopDriver.QGetMessage(serverB)).toBe(0);
  });

  test("closing one seat's connection leaves the others connected", () => {
    const clientA = trackSocket(netLoopDriver.Connect("local"));
    const serverA = trackSocket(netLoopDriver.CheckNewConnections());
    const clientB = trackSocket(netLoopDriver.Connect("local"));
    const serverB = trackSocket(netLoopDriver.CheckNewConnections());
    if (!clientA || !clientB || !serverA || !serverB) throw new Error("loopback pair not created");
    opened.push(clientB, serverB);

    NET_Close(clientA);
    expect(serverA.driverdata).toBeNull();
    expect(clientB.driverdata).toBe(serverB);
    expect(serverB.driverdata).toBe(clientB);
    NET_Close(serverA);
  });
});

//=============================================================================
// 5. THE SERVER -- N local clients through the ordinary SV_ConnectClient
//=============================================================================

describe.skipIf(!HAVE_PROGS106)("two local seats are two ordinary server clients", () => {
  let scratchDir = "";

  beforeAll(() => {
    const fixture = buildDedicatedFixture("splitscreen-test-");
    scratchDir = fixture.scratchDir;

    COM_InitArgv(["quake", "-basedir", fixture.baseDir]);
    COM_InitFilesystem();
    COM_CheckRegistered();
    Mod_Init();
    PR_LoadProgs();
    if (Cvar_FindVar("sv_protocol") === null) Cvar_RegisterVariable(sv_protocol);
    if (Cvar_FindVar("max_edicts") === null) Cvar_RegisterVariable(max_edicts);
    SV_Init();

    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    svs.clients = [new ClientT(), new ClientT(), new ClientT(), new ClientT()];
    Cvar_Set("coop", "1");
    Cvar_Set("deathmatch", "0");
    skill.value = 1;
    Cvar_Set("sv_protocol", "666");
    SV_SpawnServer("world");
  });

  afterAll(() => {
    sv.clear();
    resetSuiteState();
    if (scratchDir !== "" && existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
  });

  test("the synthetic map really spawned", () => {
    expect(sv.active).toBe(true);
    expect(sv.name).toBe("world");
  });

  test("two loopback connections become two active clients on distinct player edicts", () => {
    const sockets: QsocketT[] = [];
    for (let seat = 0; seat < 2; seat++) {
      // BOTH sides of the pair are this test's to close: the client side is
      // the seat's end of the connection, and a socket that is never
      // NET_Close'd stays on net_main's active list for the rest of the
      // process (the hygiene block at the end of this file checks).
      const client = trackSocket(netLoopDriver.Connect("local"));
      const server = trackSocket(netLoopDriver.CheckNewConnections());
      expect(server).not.toBeNull();
      if (!server || !client) return;
      sockets.push(server, client);
      svs.clients[seat].netconnection = server;
      SV_ConnectClient(seat);
    }

    expect(svs.clients[0].active).toBe(true);
    expect(svs.clients[1].active).toBe(true);
    expect(svs.clients[0].edict).not.toBeNull();
    expect(svs.clients[1].edict).not.toBeNull();
    expect(NUM_FOR_EDICT(svs.clients[0].edict!)).toBe(1);
    expect(NUM_FOR_EDICT(svs.clients[1].edict!)).toBe(2);
    expect(svs.clients[0].netconnection).not.toBe(svs.clients[1].netconnection);
    // both connections came in over the loopback, from this same process
    expect(svs.clients[0].netconnection?.address).toBe("LOCAL");
    expect(svs.clients[1].netconnection?.address).toBe("LOCAL");
    // and each got its own signon stream
    expect(svs.clients[0].message.cursize).toBeGreaterThan(0);
    expect(svs.clients[1].message.cursize).toBeGreaterThan(0);

    for (const s of sockets) NET_Close(s);
  });

  test("a local client's serverinfo carries svc_setviews with the local seat count", () => {
    svMainHooks.localSeatCount = () => 3;
    const client = trackSocket(netLoopDriver.Connect("local"));
    const server = trackSocket(netLoopDriver.CheckNewConnections());
    if (!server || !client) throw new Error("loopback pair not created");
    svs.clients[2].netconnection = server;
    SV_ConnectClient(2);

    const bytes = svs.clients[2].message.data.subarray(0, svs.clients[2].message.cursize);
    let found = -1;
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === svc_setviews && bytes[i + 1] === 3) {
        found = i;
        break;
      }
    }
    expect(found).toBeGreaterThanOrEqual(0);

    NET_Close(server);
    NET_Close(client);
    svMainHooks.localSeatCount = () => 1;
  });

  test("with one seat no svc_setviews is written at all -- a classic session's byte stream is unchanged", () => {
    svMainHooks.localSeatCount = () => 1;
    const client = trackSocket(netLoopDriver.Connect("local"));
    const server = trackSocket(netLoopDriver.CheckNewConnections());
    if (!server || !client) throw new Error("loopback pair not created");
    svs.clients[3].netconnection = server;
    SV_ConnectClient(3);

    const bytes = svs.clients[3].message.data.subarray(0, svs.clients[3].message.cursize);
    expect(bytes.includes(svc_setviews)).toBe(false);
    NET_Close(server);
    NET_Close(client);
  });
});

//=============================================================================
// 6. THE HUD -- one status bar per seat, in that seat's pane
//=============================================================================

type DrawCall =
  | { fn: "Draw_Pic"; x: number; y: number; w: number; h: number }
  | { fn: "Draw_TransPic"; x: number; y: number; w: number; h: number }
  | { fn: "Draw_Fill"; x: number; y: number; w: number; h: number }
  | { fn: "Draw_TileClear"; x: number; y: number; w: number; h: number };

function makeRecordingRenderer(): { renderer: Renderer; calls: DrawCall[] } {
  const calls: DrawCall[] = [];

  const modelHooks: ModelLoaderHooks = {
    notexture: new TextureT(),
    textureLoaded(): void {},
    Mod_LoadLighting(): void {},
    Mod_LoadAliasModel(): void {},
    Mod_LoadSpriteModel(): void {},
  };

  function pic(): QpicT {
    const p = new QpicT();
    p.width = 8;
    p.height = 8;
    return p;
  }

  const renderer: Renderer = {
    modelHooks,
    R_Init(): void {},
    R_InitTextures(): void {},
    R_InitEfrags(): void {},
    R_RenderView(): void {},
    R_ViewChanged(_pvrect: VrectT, _lineadj: number, _aspect: number): void {},
    R_InitSky(_mt: TextureT): void {},
    R_AddEfrags(_ent: EntityT): void {},
    R_RemoveEfrags(_ent: EntityT): void {},
    R_NewMap(): void {},
    R_PushDlights(): void {},
    get r_cache_thrash(): boolean {
      return false;
    },
    D_SurfaceCacheForRes(): number {
      return 0;
    },
    D_FlushCaches(): void {},
    D_DeleteSurfaceCache(): void {},
    D_InitCaches(): void {},
    R_SetVrect(_pvrectin: VrectT, _pvrect: VrectT, _lineadj: number): void {},
    get draw_disc(): QpicT | null {
      return null;
    },
    Draw_Init(): void {},
    Draw_Character(): void {},
    Draw_DebugChar(): void {},
    Draw_Pic(x: number, y: number, p: QpicT): void {
      calls.push({ fn: "Draw_Pic", x, y, w: p.width, h: p.height });
    },
    Draw_TransPic(x: number, y: number, p: QpicT): void {
      calls.push({ fn: "Draw_TransPic", x, y, w: p.width, h: p.height });
    },
    Draw_TransPicTranslate(x: number, y: number, p: QpicT): void {
      calls.push({ fn: "Draw_TransPic", x, y, w: p.width, h: p.height });
    },
    Draw_ConsoleBackground(): void {},
    Draw_BeginDisc(): void {},
    Draw_EndDisc(): void {},
    Draw_TileClear(x: number, y: number, w: number, h: number): void {
      calls.push({ fn: "Draw_TileClear", x, y, w, h });
    },
    Draw_Fill(x: number, y: number, w: number, h: number): void {
      calls.push({ fn: "Draw_Fill", x, y, w, h });
    },
    Draw_FadeScreen(): void {},
    Draw_String(): void {},
    Draw_PicFromWad(): QpicT {
      return pic();
    },
    Draw_CachePic(): QpicT {
      return pic();
    },
    Draw_SubPic(): void {},
    Draw_Alt_String(): void {},
    Draw_GlyphAtlas(): void {},
    D_StartParticles(): void {},
    D_DrawParticle(_p: ParticleT): void {},
    D_EndParticles(): void {},
    V_CalcBlend(): void {},
    V_UpdatePalette(): void {},
    V_DrawCrosshair(): void {},
    R_TranslatePlayerSkin(_playernum: number): void {},
    SCR_CalcRefdef(): void {},
    BeginFrame(): void {},
    EndFrame(): void {},
    D_EnableBackBufferAccess(): void {},
    D_DisableBackBufferAccess(): void {},
    D_UpdateRects(_rect: VrectT): void {},
    GL_Set2D(): void {},
    SCR_TileClear(): void {},
    SCR_SoftwareTileClear(): void {},
    SCR_DrawCrosshair(): void {},
    SCR_ScreenShot_f(): void {},
    R_NetGraph(): void {},
    isGL: false,
  };

  return { renderer, calls };
}

describe("Sbar_Draw -- one status bar per seat, anchored to that seat's pane", () => {
  const recorder = makeRecordingRenderer();

  beforeAll(() => {
    vid.width = 640;
    vid.height = 480;
    vid.numpages = 2;
    scrState.sb_lines = 24 + 16 + 8;
    scrState.scr_con_current = 0;
    re.current = recorder.renderer;
    Sbar_Init();
    cl.clear();
    cl.maxclients = 2;
    cl.scores = [new ScoreboardT(), new ScoreboardT()];
    cl.stats[STAT_HEALTH] = 100;
  });

  afterAll(resetSuiteState);

  test("with one seat the bar is along the bottom of the whole screen", () => {
    oneSeat();
    expect(SS_Canvas()).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    recorder.calls.length = 0;
    Sbar_Changed();
    Sbar_Draw();
    expect(recorder.calls.length).toBeGreaterThan(0);
    for (const c of recorder.calls) expect(c.y).toBeGreaterThanOrEqual(480 - 48);
  });

  test("two seats draw two status bars, each along its own pane's bottom edge", () => {
    seats(2);
    const perSeat: DrawCall[][] = [];

    for (let seat = 0; seat < 2; seat++) {
      recorder.calls.length = 0;
      SS_WithSeat(seat, () => {
        cl.stats[STAT_HEALTH] = 100;
        cl.maxclients = 2;
        cl.scores = [new ScoreboardT(), new ScoreboardT()];
        Sbar_Changed();
        Sbar_Draw();
      });
      perSeat.push(recorder.calls.slice());
    }

    expect(perSeat[0].length).toBeGreaterThan(0);
    expect(perSeat[1].length).toBeGreaterThan(0);

    const paneTop = SS_SeatRect(0);
    const paneBottom = SS_SeatRect(1);
    expect(paneTop.height).toBe(240);
    expect(paneBottom.y).toBe(240);

    // Seat 0's bar sits along the bottom of the TOP pane, seat 1's along the
    // bottom of the BOTTOM pane, and neither escapes into the other's.
    for (const c of perSeat[0]) {
      expect(c.y).toBeGreaterThanOrEqual(paneTop.y + paneTop.height - 48);
      expect(c.y).toBeLessThan(paneBottom.y + 8);
    }
    for (const c of perSeat[1]) {
      expect(c.y).toBeGreaterThanOrEqual(paneBottom.y + paneBottom.height - 48);
      expect(c.y).toBeLessThan(paneBottom.y + paneBottom.height + 8);
    }

    // The two bars are drawn at different heights -- the same bar twice would
    // mean the seat canvas never reached sbar.ts.
    expect(perSeat[0][0].y).not.toBe(perSeat[1][0].y);
  });

  test("a four-way split centers each seat's bar inside its own quadrant", () => {
    seats(4);
    for (let seat = 0; seat < 4; seat++) {
      recorder.calls.length = 0;
      const pane = SS_SeatRect(seat);
      SS_WithSeat(seat, () => {
        cl.stats[STAT_HEALTH] = 100;
        Sbar_Changed();
        Sbar_Draw();
      });
      expect(recorder.calls.length).toBeGreaterThan(0);
      for (const c of recorder.calls) {
        expect(c.x).toBeGreaterThanOrEqual(pane.x);
        expect(c.x).toBeLessThanOrEqual(pane.x + pane.width);
        expect(c.y).toBeGreaterThanOrEqual(pane.y);
        expect(c.y).toBeLessThanOrEqual(pane.y + pane.height);
      }
    }
  });
});

//=============================================================================
// 7. INPUT -- the second pad drives seat 1 and nobody else
//=============================================================================

const PAD_A = -1; // see test/gamepad.test.ts: a pushed event's `which` is -1
const PAD_B = 7;

describe("a second controller reaches seat 1's usercmd", () => {
  const savedPrefs: string[] = [];

  beforeAll(() => {
    RegisterPlayerCvars({ yawsensitivity: "240", pitchsensitivity: "130", deadzone: "0.175", invert: "0" });
    for (let p = 0; p < MAX_SEATS; p++) {
      const cv = Cvar_FindVar(PlayerDeviceCvarName(p));
      savedPrefs.push(cv ? cv.string : "auto");
      if (cv) Cvar_Set(PlayerDeviceCvarName(p), "auto");
    }
    SDL_InjectFakeGamepadForTests(PAD_A, "guid-seat0", "Seat 0 pad");
    SDL_InjectFakeGamepadForTests(PAD_B, "guid-seat1", "Seat 1 pad");
    // A cvar is 0 until it is registered (cvar.ts's own note), and the seat
    // move scales its stick by cl_forwardspeed/cl_sidespeed -- register the
    // two this path reads so the fake pad produces the movement a real
    // session would.
    if (Cvar_FindVar("cl_forwardspeed") === null) Cvar_RegisterVariable(cl_forwardspeed);
    if (Cvar_FindVar("cl_sidespeed") === null) Cvar_RegisterVariable(cl_sidespeed);
    joy_enable.value = 1;
    keyState.key_dest = KeydestT.key_game;
    host.frametime = 0.05;
    seats(2);
    // CL_SeatMove builds nothing until the seat has finished signing on,
    // exactly as CL_BaseMove does for seat 0.
    SS_Seat(1).binding.cls.signon = SIGNONS;
  });

  afterAll(() => {
    SS_Seat(1).binding.cls.signon = 0;
    SDL_RemoveFakeGamepadForTests(PAD_A);
    SDL_RemoveFakeGamepadForTests(PAD_B);
    for (let p = 0; p < MAX_SEATS; p++) {
      if (Cvar_FindVar(PlayerDeviceCvarName(p))) Cvar_Set(PlayerDeviceCvarName(p), savedPrefs[p] ?? "auto");
    }
    resetSuiteState();
  });

  test("plug order gives the first pad to player 1 and the second to player 2", () => {
    const devices = SDL_GamepadDevices();
    expect(devices.find((d) => d.instanceId === PAD_A)?.player).toBe(0);
    expect(devices.find((d) => d.instanceId === PAD_B)?.player).toBe(1);
  });

  test("the second pad's sticks move seat 1 and turn seat 1's view, leaving seat 0 alone", () => {
    SS_WithSeat(0, () => {
      cl.viewangles[0] = 0;
      cl.viewangles[1] = 0;
    });
    SS_WithSeat(1, () => {
      cl.viewangles[0] = 0;
      cl.viewangles[1] = 0;
    });

    SDL_SetFakeGamepadStateForTests(PAD_B, { leftX: 0.9, leftY: -0.9, rightX: 0.9, rightY: 0 });

    const cmd = new UsercmdT();
    SS_WithSeat(1, () => {
      CL_SeatMove(cmd, 1);
    });

    expect(cmd.forwardmove).toBeGreaterThan(0);
    expect(cmd.sidemove).toBeGreaterThan(0);
    SS_WithSeat(1, () => {
      expect(cl.viewangles[1]).not.toBe(0); // yaw turned
    });
    SS_WithSeat(0, () => {
      expect(cl.viewangles[1]).toBe(0); // seat 0 untouched
    });

    SDL_SetFakeGamepadStateForTests(PAD_B, { leftX: 0, leftY: 0, rightX: 0, rightY: 0 });
  });

  test("the second pad's right trigger and A button become seat 1's attack and jump bits", () => {
    const SDL_BUTTON_A = 0;
    SDL_SetFakeGamepadStateForTests(PAD_B, { rightTrigger: 1, heldButtons: 1 << SDL_BUTTON_A });
    const cmd = new UsercmdT();
    SS_WithSeat(1, () => {
      CL_SeatMove(cmd, 1);
    });
    expect(SS_SeatButtons(1)).toBe(3); // attack | jump
    expect(SS_SeatButtons(0)).toBe(0); // seat 0's buttons are the bind system's

    SDL_SetFakeGamepadStateForTests(PAD_B, { rightTrigger: 0, heldButtons: 0 });
    SS_WithSeat(1, () => {
      CL_SeatMove(cmd, 1);
    });
    expect(SS_SeatButtons(1)).toBe(0);
  });

  test("seat 0's own pad never drives seat 1", () => {
    SDL_SetFakeGamepadStateForTests(PAD_A, { leftX: 1, leftY: -1 });
    SDL_SetFakeGamepadStateForTests(PAD_B, { leftX: 0, leftY: 0 });
    const cmd = new UsercmdT();
    SS_WithSeat(1, () => {
      CL_SeatMove(cmd, 1);
    });
    expect(cmd.forwardmove).toBe(0);
    expect(cmd.sidemove).toBe(0);
    SDL_SetFakeGamepadStateForTests(PAD_A, { leftX: 0, leftY: 0 });
  });
});

//=============================================================================
// 8. TEARDOWN -- cl_splitscreen 1
//=============================================================================

describe("cl_splitscreen tears seats up and down", () => {
  afterAll(resetSuiteState);

  test("cl_splitscreen 2 marks the second seat wanted and widens the server's slot count", () => {
    oneSeat();
    svs.maxclients = 1;
    svs.maxclientslimit = 1;
    Cvar_Set("coop", "0");
    Cvar_Set("deathmatch", "0");
    seats(2);
    expect(SS_SeatCount()).toBe(2);
    expect(SS_Seat(1).wanted).toBe(true);
    expect(svs.maxclients).toBeGreaterThanOrEqual(2);
    // more than one local player is a co-operative session
    expect(coop.value).toBe(1);
  });

  test("`cl_splitscreen 2` typed at the console really seats a second player", () => {
    // A REGRESSION GUARD, not a formality: cmd.ts's Cmd_AddCommand refuses a
    // name already registered as a cvar, so `cl_splitscreen` existing as both
    // would leave the console form setting a number nothing acts on.
    oneSeat();
    sv.active = false;
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    Cmd_ExecuteString("cl_splitscreen 2", CmdSourceT.src_command);
    expect(SS_SeatCount()).toBe(2);
    Cmd_ExecuteString("cl_splitscreen 1", CmdSourceT.src_command);
    expect(SS_SeatCount()).toBe(1);
  });

  test("cl_splitscreen 1 drops the second seat and wipes its client state", () => {
    seats(2);
    SS_WithSeat(1, () => {
      cl.stats[STAT_HEALTH] = 66;
      cl.viewangles[1] = 123;
    });

    seats(1);
    expect(SS_SeatCount()).toBe(1);
    expect(SS_Seat(1).wanted).toBe(false);
    expect(SS_Seat(1).binding.cl.stats[STAT_HEALTH]).toBe(0);
    expect(SS_Seat(1).binding.cl.viewangles[1]).toBe(0);
    expect(SS_IsPrimary()).toBe(true);
  });

  test("the seat count is clamped to 1..MAX_SEATS and the layout follows it", () => {
    seats(99);
    expect(SS_SeatCount()).toBe(MAX_SEATS);
    vid.width = 640;
    vid.height = 480;
    expect(SS_SeatRect(3).x).toBe(320);
    expect(SS_SeatRect(3).y).toBe(240);
    seats(0);
    expect(SS_SeatCount()).toBe(1);
  });

  test("a seat that is wanted opens its own loopback connection, with that seat bound", () => {
    const savedHooks = {
      disconnect: seatDisconnectHooks.disconnect,
      establishConnection: seatDisconnectHooks.establishConnection,
      readFromServer: seatDisconnectHooks.readFromServer,
      sendCmd: seatDisconnectHooks.sendCmd,
    };
    const asked: Array<{ host: string; seat: number }> = [];
    seatDisconnectHooks.establishConnection = (h: string) => {
      asked.push({ host: h, seat: SS_ActiveSeat() });
    };

    try {
      oneSeat();
      // A fresh seat is DISCONNECTED, not ca_dedicated: CL_EstablishConnection
      // refuses to open a connection from ca_dedicated, so a seat that
      // inherited ClientStaticT's construction default would never connect.
      expect(SS_Seat(1).binding.cls.state).toBe(CactiveT.ca_disconnected);

      svs.maxclients = 4;
      svs.maxclientslimit = 4;
      sv.active = false;
      SS_SetSeats(3);
      sv.active = true;
      SS_Reconcile();

      expect(asked.length).toBe(2);
      expect(asked[0]).toEqual({ host: "local", seat: 1 });
      expect(asked[1]).toEqual({ host: "local", seat: 2 });
      // and the switch was put back afterwards
      expect(SS_IsPrimary()).toBe(true);
    } finally {
      seatDisconnectHooks.disconnect = savedHooks.disconnect;
      seatDisconnectHooks.establishConnection = savedHooks.establishConnection;
      seatDisconnectHooks.readFromServer = savedHooks.readFromServer;
      seatDisconnectHooks.sendCmd = savedHooks.sendCmd;
      sv.active = false;
      oneSeat();
    }
  });

  test("SS_DropSeat on seat 0 is refused -- the primary client is not a seat that can be torn down", () => {
    seats(2);
    SS_DropSeat(0);
    expect(SS_SeatCount()).toBe(2);
    expect(SS_IsPrimary()).toBe(true);
    oneSeat();
  });

  test("cl_splitscreen_layout is a live preference", () => {
    seats(2);
    vid.width = 640;
    vid.height = 480;
    cl_splitscreen_layout.value = 0;
    expect(SS_SeatRect(1)).toEqual({ x: 0, y: 240, width: 640, height: 240 });
    cl_splitscreen_layout.value = SPLIT_LAYOUT_SIDE_BY_SIDE;
    expect(SS_SeatRect(1)).toEqual({ x: 320, y: 0, width: 320, height: 480 });
    cl_splitscreen_layout.value = 0;
  });
});

describe("a seat is a client with everything a client needs", () => {
  afterAll(resetSuiteState);

  test("a seat past 0 gets its own reliable message buffer, sized as CL_Init sizes seat 0's", () => {
    // Without it the seat's very first reliable command -- CL_SignonReply's
    // own `name`/`color`/`spawn` -- writes into a SizeBuf with maxsize 0 and
    // SZ_GetSpace throws before that seat has ever reached the game.
    oneSeat();
    for (let i = 1; i < MAX_SEATS; i++) expect(SS_Seat(i).binding.cls.message.maxsize).toBe(1024);
  });

  test("every seat's default colour puts it on a team of its own", () => {
    // Host_Color_f sets `edict->v.team` from the PANTS nibble, and the
    // re-release's CTF progs read that team: two seats sharing a pants
    // colour are two seats on one team.
    const primary = Cvar_FindVar("_cl_color");
    const pants = (n: number): number => n & 15;
    const seen: number[] = [];
    if (primary !== null) seen.push(pants(primary.value | 0));
    for (let i = 1; i < MAX_SEATS; i++) {
      const cvar = SS_SeatColorCvar(i);
      expect(cvar).not.toBeNull();
      if (cvar === null) continue;
      expect(cvar.archive).toBe(true);
      expect(seen).not.toContain(pants(cvar.value | 0));
      seen.push(pants(cvar.value | 0));
    }
  });

  test("SS_SeatColorCvar/SS_SeatNameCvar have nothing to hand seat 0", () => {
    expect(SS_SeatColorCvar(0)).toBeNull();
  });
});

describe("a slot count asked for under a live server waits for the next map", () => {
  afterAll(() => {
    SS_SetSeats(1); // drops the held count as well as the seats
    resetSuiteState();
  });

  test("SS_WidenServer does not touch a running server's slot count", () => {
    oneSeat();
    sv.active = true;
    svs.maxclients = 2;
    svs.maxclientslimit = 4;

    SS_WidenServer(4);

    // Raising it here would leave SV_UpdateToReliableMessages walking client
    // slots whose edict SV_SpawnServer never allocated.
    expect(svs.maxclients).toBe(2);
    expect(SS_HeldClientSlots()).toBe(4);
    // taken once, not handed out again
    expect(SS_HeldClientSlots()).toBe(0);

    sv.active = false;
    SS_SetSeats(1);
  });

  test("with no server running the slot count is applied straight away", () => {
    oneSeat();
    sv.active = false;
    svs.maxclients = 1;
    svs.maxclientslimit = 1;

    SS_WidenServer(3);

    expect(svs.maxclients).toBe(3);
    expect(svs.maxclientslimit).toBeGreaterThanOrEqual(3);
    expect(SS_HeldClientSlots()).toBe(0);
    SS_SetSeats(1);
  });

  test("`cl_splitscreen 3` at a 2-slot server leaves the seat count alone and says so", () => {
    oneSeat();
    sv.active = true;
    svs.maxclients = 2;
    svs.maxclientslimit = 4;

    SS_SetSeats(3);

    expect(SS_SeatCount()).toBe(1);
    expect(svs.maxclients).toBe(2);
    expect(SS_HeldClientSlots()).toBe(3);

    sv.active = false;
    SS_SetSeats(1);
  });
});

describe("a level change keeps the players it had", () => {
  const savedEstablish = seatDisconnectHooks.establishConnection;

  afterAll(() => {
    seatDisconnectHooks.establishConnection = savedEstablish;
    SS_SetSeats(1);
    resetSuiteState();
  });

  test("the seats a map change dropped come back once the primary client is on the new level", () => {
    seatDisconnectHooks.establishConnection = () => {};
    oneSeat();
    sv.active = false;
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    SS_SetSeats(3);
    expect(SS_SeatCount()).toBe(3);

    // what CL_Disconnect does on the way into a new level
    SS_Shutdown();
    expect(SS_SeatCount()).toBe(1);

    // and what the first frame on the new level finds
    sv.active = true;
    SS_Seat(0).binding.cls.state = CactiveT.ca_connected;
    SS_Reconcile();

    expect(SS_SeatCount()).toBe(3);
    expect(SS_Seat(1).wanted).toBe(true);
    expect(SS_Seat(2).wanted).toBe(true);

    SS_Seat(0).binding.cls.state = CactiveT.ca_disconnected;
    sv.active = false;
    SS_SetSeats(1);
  });

  test("`cl_splitscreen 1` is a player leaving splitscreen -- the next map does not bring the seats back", () => {
    seatDisconnectHooks.establishConnection = () => {};
    oneSeat();
    sv.active = false;
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    SS_SetSeats(3);
    SS_Shutdown();
    SS_SetSeats(1);

    sv.active = true;
    SS_Seat(0).binding.cls.state = CactiveT.ca_connected;
    SS_Reconcile();

    expect(SS_SeatCount()).toBe(1);

    SS_Seat(0).binding.cls.state = CactiveT.ca_disconnected;
    sv.active = false;
  });

  test("a changelevel puts every seat past 0 back to signon 0, the way `reconnect` does for the primary", () => {
    seatDisconnectHooks.establishConnection = () => {};
    oneSeat();
    sv.active = false;
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    SS_SetSeats(3);

    // Where a `changelevel` finds the session: every seat fully signed on and
    // still connected, because unlike `map` it never disconnects anyone.
    for (const i of [0, 1, 2]) {
      SS_Seat(i).binding.cls.state = CactiveT.ca_connected;
      SS_Seat(i).binding.cls.signon = SIGNONS;
    }

    // SV_SpawnServer reaches this hook just after SV_SendReconnect, whose
    // `reconnect` runs out of the shared command buffer and so only ever
    // lands on seat 0.
    SS_ServerSpawned();

    expect(SS_Seat(1).binding.cls.signon).toBe(0);
    expect(SS_Seat(2).binding.cls.signon).toBe(0);
    // Seat 0 is Host_Reconnect_f's, not this hook's.
    expect(SS_Seat(0).binding.cls.signon).toBe(SIGNONS);

    for (const i of [0, 1, 2]) {
      SS_Seat(i).binding.cls.state = CactiveT.ca_disconnected;
      SS_Seat(i).binding.cls.signon = 0;
    }
    sv.active = false;
    SS_SetSeats(1);
  });

  test("the seats that come back are clamped to the new server's slot count", () => {
    seatDisconnectHooks.establishConnection = () => {};
    oneSeat();
    sv.active = false;
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    SS_SetSeats(4);
    SS_Shutdown();

    svs.maxclients = 2;
    sv.active = true;
    SS_Seat(0).binding.cls.state = CactiveT.ca_connected;
    SS_Reconcile();

    expect(SS_SeatCount()).toBe(2);

    SS_Seat(0).binding.cls.state = CactiveT.ca_disconnected;
    sv.active = false;
    SS_SetSeats(1);
  });
});

//=============================================================================
// 9. HYGIENE -- this suite leaves the process exactly as it found it
//=============================================================================

/*
Runs last, and asserts rather than repairs: every block above puts the shared
state back in its own afterAll, and this block is what notices when a block
added later forgets to. It is a real guard, not a formality -- a leftover
`coop 1` from SS_WidenServer (menu.ts's mpGameType picks the New Game screen's
whole map list off that cvar) once made four of test/menu.test.ts's Bots-page
tests fail whenever that file ran after this one, because `.value` had been
restored and `.string` had not.
*/
//=============================================================================
// 6. A SEAT'S OWN FAILURES, AND THE ONE SHARED CONSOLE
//=============================================================================

/*
Host_Error's C comment is "This shuts down both the client and server", which
is the only answer a one-client engine can give. A seat is a client of its
own, so these two blocks pin down whose error it is (U43) and whose console
line it is.
*/
describe("a Host_Error raised in a seat's window is that seat's, not the session's", () => {
  const savedIsDedicated = sysState.isDedicated;
  const savedHooks = {
    clDisconnect: hostClientHooks.clDisconnect,
    setClsDemonum: hostClientHooks.setClsDemonum,
    scrEndLoadingPlaque: hostClientHooks.scrEndLoadingPlaque,
  };
  const savedReadFromServer = seatDisconnectHooks.readFromServer;

  beforeAll(() => {
    // Host_Error's dedicated branch is Sys_Error, which never returns; a
    // splitscreen session is a client one by definition. SCR_EndLoadingPlaque
    // is unhooked so this block does not reach into screen.ts's own state.
    sysState.isDedicated = false;
    hostClientHooks.scrEndLoadingPlaque = null;
  });

  afterAll(() => {
    sysState.isDedicated = savedIsDedicated;
    hostClientHooks.clDisconnect = savedHooks.clDisconnect;
    hostClientHooks.setClsDemonum = savedHooks.setClsDemonum;
    hostClientHooks.scrEndLoadingPlaque = savedHooks.scrEndLoadingPlaque;
    seatDisconnectHooks.readFromServer = savedReadFromServer;
    resetSuiteState();
  });

  function raiseInSeat(index: number, message: string): unknown {
    try {
      SS_WithSeat(index, () => {
        Host_Error(message);
      });
    } catch (e) {
      return e;
    }
    return null;
  }

  test("the seat and every seat above it go, and the server and the primary client stay", () => {
    oneSeat();
    sv.active = false;
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    SS_SetSeats(4);
    expect(SS_SeatCount()).toBe(4);
    sv.active = true; // the thing a seat's error must not shut down

    const thrown = raiseInSeat(2, "CL_ParseServerMessage: Illegible server message");

    expect(thrown).toBeInstanceOf(SeatError);
    expect(thrown instanceof SeatError ? thrown.seat : -1).toBe(2);
    expect(SS_SeatCount()).toBe(2);
    expect(SS_Seat(2).wanted).toBe(false);
    expect(SS_Seat(3).wanted).toBe(false);
    // the seat below it is untouched, and so is the server
    expect(SS_Seat(1).wanted).toBe(true);
    expect(sv.active).toBe(true);
    // SS_WithSeat's finally put the primary back
    expect(SS_IsPrimary()).toBe(true);

    sv.active = false;
    oneSeat();
  });

  test("a seat that dies mid-frame does not end the frame the other seats are in", () => {
    oneSeat();
    sv.active = false; // SS_Reconcile has no server to connect the seats to
    svs.maxclients = 4;
    svs.maxclientslimit = 4;
    SS_SetSeats(3);
    for (let i = 1; i < 3; i++) SS_Seat(i).binding.cls.state = CactiveT.ca_connected;

    const read: number[] = [];
    seatDisconnectHooks.readFromServer = (): number => {
      const seat = SS_ActiveSeat();
      read.push(seat);
      if (seat === 2) Host_Error("CL_ParseServerMessage: Bad server message");
      return 0;
    };

    expect(() => SS_ReadFromServer()).not.toThrow();

    expect(read).toEqual([0, 1, 2]);
    expect(SS_SeatCount()).toBe(2);
    expect(SS_IsPrimary()).toBe(true);

    seatDisconnectHooks.readFromServer = savedReadFromServer;
    oneSeat();
  });

  test("the primary client's own Host_Error still ends the session, as it always has", () => {
    oneSeat();
    sv.active = false;
    let disconnects = 0;
    let demonum = 0;
    hostClientHooks.clDisconnect = () => {
      disconnects++;
    };
    hostClientHooks.setClsDemonum = (n: number) => {
      demonum = n;
    };

    const thrown = raiseInSeat(0, "CL_ParseServerMessage: Illegible server message");

    expect(thrown).toBeInstanceOf(HostError);
    expect(thrown instanceof SeatError).toBe(false);
    expect(disconnects).toBe(1);
    expect(demonum).toBe(-1);

    hostClientHooks.clDisconnect = savedHooks.clDisconnect;
    hostClientHooks.setClsDemonum = savedHooks.setClsDemonum;
  });
});

describe("one console for the machine, however many seats are reading", () => {
  const savedReadFromServer = seatDisconnectHooks.readFromServer;

  afterAll(() => {
    seatDisconnectHooks.readFromServer = savedReadFromServer;
    resetSuiteState();
  });

  const DEATH = "beefy fell to his death\n";

  test("a line the server broadcast to every seat prints once", () => {
    oneSeat();
    seats(3);
    expect(SS_WithSeat(0, () => SS_PrintLine(DEATH))).toBe(DEATH);
    expect(SS_WithSeat(1, () => SS_PrintLine(DEATH))).toBeNull();
    expect(SS_WithSeat(2, () => SS_PrintLine(DEATH))).toBeNull();
  });

  test("a line only one seat was sent prints once and says whose it is", () => {
    oneSeat();
    seats(2);
    expect(SS_WithSeat(1, () => SS_PrintLine("You got the nailgun\n"))).toBe("[P2] You got the nailgun\n");
    // the primary player is the console's owner and is never labelled
    expect(SS_WithSeat(0, () => SS_PrintLine("You got the rocket launcher\n"))).toBe("You got the rocket launcher\n");
  });

  test("the seat's number goes in front of the line, not in front of each svc_print that makes it up", () => {
    oneSeat();
    seats(2);
    // id1's item pickup: sprint (other, "You got the "); sprint (other,
    // self.netname); sprint (other, "\n").
    expect(SS_WithSeat(1, () => SS_PrintLine("You got the "))).toBe("[P2] You got the ");
    expect(SS_WithSeat(1, () => SS_PrintLine("nailgun"))).toBe("nailgun");
    expect(SS_WithSeat(1, () => SS_PrintLine("\n"))).toBe("\n");
    // and the next line starts a new label. The last print here closes the
    // line, because where the console stands is shared state (rule 13).
    expect(SS_WithSeat(1, () => SS_PrintLine("You got the rocket launcher\n"))).toBe("[P2] You got the rocket launcher\n");
  });

  test("two pickups in one frame are two lines -- the fold is across seats, not within one", () => {
    oneSeat();
    seats(2);
    expect(SS_WithSeat(1, () => SS_PrintLine("You got the nailgun\n"))).toBe("[P2] You got the nailgun\n");
    expect(SS_WithSeat(1, () => SS_PrintLine("You got the nailgun\n"))).toBe("[P2] You got the nailgun\n");
  });

  test("with one seat nothing is folded and nothing is labelled", () => {
    oneSeat();
    expect(SS_PrintLine(DEATH)).toBe(DEATH);
    expect(SS_PrintLine(DEATH)).toBe(DEATH);
  });

  test("a blank line keeps its shape rather than becoming a labelled one", () => {
    oneSeat();
    seats(2);
    expect(SS_WithSeat(1, () => SS_PrintLine("\n"))).toBe("\n");
  });

  test("the fold lasts one frame: the next frame's copy of the same line prints again", () => {
    oneSeat();
    sv.active = false; // SS_Reconcile returns before it can connect anything
    seats(2);
    seatDisconnectHooks.readFromServer = (): number => 0;

    expect(SS_WithSeat(0, () => SS_PrintLine(DEATH))).toBe(DEATH);
    expect(SS_WithSeat(1, () => SS_PrintLine(DEATH))).toBeNull();

    SS_ReadFromServer(); // the next frame

    expect(SS_WithSeat(0, () => SS_PrintLine(DEATH))).toBe(DEATH);

    seatDisconnectHooks.readFromServer = savedReadFromServer;
  });

  test("SS_ConsolePrint is the console sink, and hands Con_Printf the text as an argument", () => {
    oneSeat();
    seats(2);
    const printSpy = spyOn(consoleMod, "Con_Printf");
    SS_WithSeat(1, () => {
      SS_ConsolePrint("100% of the way there\n");
    });
    // "%s" with the text as an argument, never the text as the format: a
    // server line with a % in it is not a format string.
    expect(printSpy).toHaveBeenCalledWith("%s", "[P2] 100% of the way there\n");

    printSpy.mockClear();
    SS_WithSeat(0, () => {
      SS_ConsolePrint("100% of the way there\n");
    });
    expect(printSpy).not.toHaveBeenCalled(); // seat 1 already printed it this frame
    printSpy.mockRestore();
  });
});

describe("this suite restores every singleton it touched", () => {
  test("seat 0 is bound and the client's live bindings are client.ts's own objects", () => {
    expect(SS_SeatCount()).toBe(1);
    expect(SS_ActiveSeat()).toBe(0);
    expect(SS_IsPrimary()).toBe(true);
    const seat0 = SS_Seat(0).binding;
    expect(cl).toBe(seat0.cl);
    expect(cls).toBe(seat0.cls);
    expect(cl_entities).toBe(seat0.cl_entities);
  });

  test("both halves of every cvar this suite set are back to their pre-suite values", () => {
    for (const [cvar, saved] of [
      [coop, savedCoop],
      [deathmatch, savedDeathmatch],
      [skill, savedSkill],
      [cl_splitscreen_layout, savedLayout],
    ] as const) {
      expect(cvar.value).toBe(saved.value);
      expect(cvar.string).toBe(saved.string);
    }
    expect(joy_enable.value).toBe(savedJoyEnable);
  });

  test("the server, video, screen, renderer and input singletons are back", () => {
    expect(sv.active).toBe(savedSvActive);
    expect(svs.maxclients).toBe(savedMaxclients);
    expect(svs.maxclientslimit).toBe(savedMaxclientslimit);
    expect(svs.clients).toBe(savedClients);
    expect(vid.width).toBe(savedVidWidth);
    expect(vid.height).toBe(savedVidHeight);
    expect(vid.numpages).toBe(savedVidNumpages);
    expect(scrState.sb_lines).toBe(savedSbLines);
    expect(scrState.scr_con_current).toBe(savedConCurrent);
    expect(re.current).toBe(savedRenderer);
    expect(keyState.key_dest).toBe(savedKeyDest);
    expect(host.frametime).toBe(savedFrametime);
    expect(svMainHooks.localSeatCount).toBe(savedLocalSeatCount);
  });

  test("every loopback socket this suite opened was closed through NET_Close", () => {
    // NET_Close is what runs NET_FreeQSocket, which unlinks the socket from
    // `net_activeSockets` and marks it disconnected; a socket closed only at
    // the driver level stays on that list and is walked by the next
    // NET_Shutdown in this bun process (a dedicated Host_Shutdown, say).
    expect(suiteSockets.length).toBeGreaterThan(0);
    const stillOpen = suiteSockets.filter((s) => !s.disconnected).map((s) => s.address);
    expect(stillOpen).toEqual([]);
  });

  test("and each of them dispatches to the loopback driver, so NET_Close could reach it", () => {
    for (const sock of suiteSockets) expect(net_drivers[sock.driver]).toBe(netLoopDriver);
  });
});

// The fixture directory join() import is used only when progs106 is present;
// referencing it here keeps the import honest under `skipIf`.
void join;
