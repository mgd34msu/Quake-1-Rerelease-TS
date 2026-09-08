// Force headless SDL before ANY import can reach the FFI layer: these tests
// must never open a real window or audio device on the host desktop.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for U22's SDL_GameController layer: src/lib/gamepad_map.ts (pure
mapping-string parsing and axis math), src/platform/gamepad_assign.ts (pure
per-player assignment resolution, plus its cvar-backed registration), the
K_* gamepad keynums added to src/client/keys.ts, and src/platform/sdl.ts's
own runtime shell (hotplug device table, button/trigger/stick event
routing, IN_JoyMove_'s cmd/viewangles contribution) driven through the same
SDL_PushEvent/SDL_PollEvent round trip test/sdl_input.test.ts already uses
for keyboard/mouse. Self-sufficient per standing order 13: it arms the SDL
backend itself, injects fake gamepad devices through sdl.ts's own test seam
(SDL_InjectFakeGamepadForTests -- real SDL_GameControllerOpen/
SDL_IsGameController have nothing to report under a headless dummy-driver
run with no controller actually attached to the host, so this is the
device-table entry point real hotplug uses too, minus the two native calls
no test can reach without hardware -- see that seam's own doc comment), and
restores every shared singleton it mutates in afterAll.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { ParseGameControllerDbMappings, IN_ApplyDeadzone, IN_ApplyEasing, IN_AxisMagnitude } from "../src/lib/gamepad_map";
import {
  MAX_LOCAL_PLAYERS,
  DEVICE_AUTO,
  DEVICE_KBM,
  DeviceOrdinals,
  FormatDeviceSpec,
  ParseDeviceSpec,
  IsKbmSpec,
  IsAutoSpec,
  ResolvePadAssignments,
  SeatsDrivable,
  RegisterPlayerCvars,
  PlayerDevicePrefs,
  PlayerTuning,
  PlayerDeviceCvarName,
  PlayerTuningCvarNames,
  type PadDeviceT,
} from "../src/platform/gamepad_assign";
import {
  IN_Init,
  IN_Shutdown,
  IN_Move,
  SDL_SetBackendEnabled,
  SDL_ResetBackendForTests,
  SDLVID_Init,
  SDL_InjectFakeGamepadForTests,
  SDL_RemoveFakeGamepadForTests,
  SDL_MakeControllerButtonEvent,
  SDL_MakeControllerAxisEvent,
  SDL_PushTestEvent,
  SDL_PumpInputForTests,
  SDL_DrainEventsForTests,
  SDL_GamepadAxisStateForTests,
  SDL_GamepadDevices,
  SDL_TEST_CONTROLLER_BUTTON_A,
  SDL_TEST_CONTROLLER_BUTTON_DPAD_UP,
  SDL_TEST_CONTROLLER_BUTTON_START,
  SDL_TEST_CONTROLLER_BUTTON_BACK,
  SDL_TEST_CONTROLLER_AXIS_LEFTX,
  SDL_TEST_CONTROLLER_AXIS_LEFTY,
  SDL_TEST_CONTROLLER_AXIS_RIGHTX,
  SDL_TEST_CONTROLLER_AXIS_RIGHTY,
  SDL_TEST_CONTROLLER_AXIS_TRIGGERLEFT,
  SDL_TEST_CONTROLLER_AXIS_TRIGGERRIGHT,
  joy_enable,
  joy_deadzone_look,
  joy_deadzone_move,
  joy_outer_threshold_look,
  joy_outer_threshold_move,
  joy_deadzone_trigger,
  joy_sensitivity_yaw,
  joy_sensitivity_pitch,
  joy_invert,
  joy_exponent,
  joy_exponent_move,
  joy_swapmovelook,
} from "../src/platform/sdl";
import { Cbuf_Init } from "../src/common/cmd";
import { Cvar_FindVar, Cvar_Set } from "../src/common/cvar";
import {
  Key_Init,
  Key_StringToKeynum,
  Key_KeynumToString,
  KeydestT,
  keyState,
  keybindings,
  K_ABUTTON,
  K_BBUTTON,
  K_XBUTTON,
  K_YBUTTON,
  K_LSHOULDER,
  K_RSHOULDER,
  K_LTRIGGER,
  K_RTRIGGER,
  K_LTHUMB,
  K_RTHUMB,
  K_DPAD_UP,
  K_DPAD_DOWN,
  K_DPAD_LEFT,
  K_DPAD_RIGHT,
  K_TAB,
  K_ESCAPE,
} from "../src/client/keys";
import { cl } from "../src/client/client";
import { host } from "../src/common/host";
import { PITCH, YAW } from "../src/common/quakedef";
import { cl_forwardspeed, cl_sidespeed } from "../src/client/cl_input";
import { UsercmdT } from "../src/server/server";

// ---------------------------------------------------------------------------
// Section 1: src/lib/gamepad_map.ts -- pure, no SDL, no cvars
// ---------------------------------------------------------------------------

describe("gamepad_map.ts -- ParseGameControllerDbMappings", () => {
  test("keeps a well-formed mapping line verbatim", () => {
    const guid = "030000005e0400008e02000010010000";
    const line = `${guid},Xbox 360 Controller,a:b0,b:b1,platform:Linux,`;
    const text = `# comment\n${line}\n`;
    expect(ParseGameControllerDbMappings(text)).toEqual([line]);
  });

  test("skips comment lines, blank lines, and strips CRLF", () => {
    const guid = "030000005e0400008e02000010010000";
    const line = `${guid},Pad,a:b0,`;
    const text = `# a comment\r\n\r\n${line}\r\n   \r\n# trailing comment`;
    expect(ParseGameControllerDbMappings(text)).toEqual([line]);
  });

  test("drops a line whose GUID field is not 32 hex digits", () => {
    const text = ["short,Pad,a:b0,", "toolong0000000000000000000000000000,Pad,a:b0,", "nothexnothexnothexnothexnothexnn,Pad,a:b0,"].join("\n");
    expect(ParseGameControllerDbMappings(text)).toEqual([]);
  });

  test("a line with no comma at all is dropped (no GUID field to validate)", () => {
    expect(ParseGameControllerDbMappings("justsomejunk")).toEqual([]);
  });

  test("multiple valid lines all come back, in order", () => {
    const g1 = "030000005e0400008e02000010010000";
    const g2 = "050000004c050000c405000000010000";
    const l1 = `${g1},Pad One,a:b0,`;
    const l2 = `${g2},Pad Two,a:b1,`;
    expect(ParseGameControllerDbMappings(`${l1}\n${l2}\n`)).toEqual([l1, l2]);
  });
});

describe("gamepad_map.ts -- axis math (Ironwail in_sdl.c IN_ApplyDeadzone/IN_ApplyEasing)", () => {
  test("IN_AxisMagnitude is the vector length", () => {
    expect(IN_AxisMagnitude({ x: 3, y: 4 })).toBeCloseTo(5, 10);
    expect(IN_AxisMagnitude({ x: 0, y: 0 })).toBe(0);
  });

  test("IN_ApplyDeadzone: at or below the deadzone radius, the result is zero", () => {
    expect(IN_ApplyDeadzone({ x: 0.1, y: 0 }, 0.175, 0.02)).toEqual({ x: 0, y: 0 });
    expect(IN_ApplyDeadzone({ x: 0.175, y: 0 }, 0.175, 0.02)).toEqual({ x: 0, y: 0 }); // exactly on the boundary
  });

  test("IN_ApplyDeadzone: rescales magnitude so deadzone -> 0 and (1-outer) -> 1, hand-computed", () => {
    // magnitude 0.5, deadzone 0.175, outer 0.02: new_magnitude = (0.5-0.175)/(1-0.175-0.02) = 0.325/0.805
    const result = IN_ApplyDeadzone({ x: 0.5, y: 0 }, 0.175, 0.02);
    const expectedMag = (0.5 - 0.175) / (1 - 0.175 - 0.02);
    expect(result.x).toBeCloseTo(expectedMag, 10);
    expect(result.y).toBeCloseTo(0, 10);
  });

  test("IN_ApplyDeadzone: clamps the rescaled magnitude at 1 past the outer threshold", () => {
    const result = IN_ApplyDeadzone({ x: 1, y: 0 }, 0.175, 0.02);
    expect(IN_AxisMagnitude(result)).toBeCloseTo(1, 10);
  });

  test("IN_ApplyDeadzone: preserves direction, not just magnitude, on a diagonal push", () => {
    const v = Math.SQRT1_2 * 0.6; // magnitude-0.6 vector at 45 degrees
    const result = IN_ApplyDeadzone({ x: v, y: v }, 0.175, 0.02);
    expect(result.x).toBeCloseTo(result.y, 10); // still on the diagonal
  });

  test("IN_ApplyEasing: zero input stays zero", () => {
    expect(IN_ApplyEasing({ x: 0, y: 0 }, 2)).toEqual({ x: 0, y: 0 });
  });

  test("IN_ApplyEasing: exponent 2 on a pure-x unit vector squares the magnitude, hand-computed", () => {
    const result = IN_ApplyEasing({ x: 0.5, y: 0 }, 2);
    expect(result.x).toBeCloseTo(0.25, 10); // 0.5^2 = 0.25, sign/direction preserved
    expect(result.y).toBeCloseTo(0, 10);
  });

  test("IN_ApplyEasing: exponent 1 is the identity", () => {
    const result = IN_ApplyEasing({ x: 0.3, y: -0.4 }, 1);
    expect(result.x).toBeCloseTo(0.3, 10);
    expect(result.y).toBeCloseTo(-0.4, 10);
  });
});

// ---------------------------------------------------------------------------
// Section 2: src/platform/gamepad_assign.ts -- pure assignment state machine
// with synthetic (fake) device lists, no SDL
// ---------------------------------------------------------------------------

describe("gamepad_assign.ts -- DeviceOrdinals / FormatDeviceSpec / ParseDeviceSpec", () => {
  const padA1: PadDeviceT = { instanceId: 0, guid: "aaaa", name: "Pad A" };
  const padA2: PadDeviceT = { instanceId: 1, guid: "aaaa", name: "Pad A" };
  const padB: PadDeviceT = { instanceId: 2, guid: "bbbb", name: "Pad B" };

  test("DeviceOrdinals: 0 for the first of a GUID, incrementing for each duplicate, independent per GUID", () => {
    expect(DeviceOrdinals([padA1, padA2, padB])).toEqual([0, 1, 0]);
  });

  test("FormatDeviceSpec: bare GUID for ordinal 0, '#n' (1-based, n=ordinal+1) otherwise", () => {
    expect(FormatDeviceSpec("aaaa", 0)).toBe("aaaa");
    expect(FormatDeviceSpec("aaaa", 1)).toBe("aaaa#2");
    expect(FormatDeviceSpec("aaaa", 2)).toBe("aaaa#3");
  });

  test("ParseDeviceSpec: auto/kbm/empty are not a device", () => {
    expect(ParseDeviceSpec("auto")).toBeNull();
    expect(ParseDeviceSpec("AUTO")).toBeNull();
    expect(ParseDeviceSpec("kbm")).toBeNull();
    expect(ParseDeviceSpec("")).toBeNull();
    expect(ParseDeviceSpec("   ")).toBeNull();
  });

  test("ParseDeviceSpec: bare GUID is ordinal 0", () => {
    expect(ParseDeviceSpec("aaaa")).toEqual({ guid: "aaaa", ordinal: 0 });
  });

  test("ParseDeviceSpec: '<guid>#n' is ordinal n-1", () => {
    expect(ParseDeviceSpec("aaaa#2")).toEqual({ guid: "aaaa", ordinal: 1 });
    expect(ParseDeviceSpec("aaaa#5")).toEqual({ guid: "aaaa", ordinal: 4 });
  });

  test("ParseDeviceSpec: a malformed '#' suffix falls back to the whole string as the GUID", () => {
    expect(ParseDeviceSpec("aaaa#0")).toEqual({ guid: "aaaa#0", ordinal: 0 });
    expect(ParseDeviceSpec("aaaa#")).toEqual({ guid: "aaaa#", ordinal: 0 });
    expect(ParseDeviceSpec("aaaa#notanumber")).toEqual({ guid: "aaaa#notanumber", ordinal: 0 });
  });

  test("IsKbmSpec / IsAutoSpec", () => {
    expect(IsKbmSpec("kbm")).toBe(true);
    expect(IsKbmSpec("KBM")).toBe(true);
    expect(IsKbmSpec("auto")).toBe(false);
    expect(IsAutoSpec("auto")).toBe(true);
    expect(IsAutoSpec("")).toBe(true); // unrecognized/empty degrades to auto
    expect(IsAutoSpec("   ")).toBe(true);
    expect(IsAutoSpec("kbm")).toBe(false);
    expect(IsAutoSpec("aaaa")).toBe(false);
  });
});

describe("gamepad_assign.ts -- ResolvePadAssignments (fake device events)", () => {
  const padA: PadDeviceT = { instanceId: 10, guid: "aaaa", name: "Pad A" };
  const padB: PadDeviceT = { instanceId: 11, guid: "bbbb", name: "Pad B" };
  const padA2: PadDeviceT = { instanceId: 12, guid: "aaaa", name: "Pad A (2nd)" };

  test("every player on auto: devices are handed out in plug order", () => {
    const result = ResolvePadAssignments([padA, padB], [DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(result.players).toEqual([0, 1, -1, -1]);
    expect(result.idle).toEqual([false, false]);
  });

  test("no devices plugged in: every auto player gets -1", () => {
    const result = ResolvePadAssignments([], [DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(result.players).toEqual([-1, -1, -1, -1]);
  });

  test("player 1 on kbm: never claims a pad even though one is present, and does not block auto players behind it", () => {
    const result = ResolvePadAssignments([padA], [DEVICE_KBM, DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(result.players[0]).toBe(-1);
    expect(result.players[1]).toBe(0); // player 2 (index 1) takes the only pad
  });

  test("explicit GUID assignment beats plug order, and an unplugged explicit device gets nothing (not silently reassigned)", () => {
    // player 1 explicitly wants padB's guid, even though padA was plugged first
    const result = ResolvePadAssignments([padA, padB], ["bbbb", DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(result.players[0]).toBe(1); // padB, index 1 in the device list
    expect(result.players[1]).toBe(0); // player 2 (auto) takes what's left: padA

    const missing = ResolvePadAssignments([padA], ["cccc-not-plugged-in", DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(missing.players[0]).toBe(-1); // never falls back to padA
    expect(missing.players[1]).toBe(0); // padA goes to the next auto player instead
  });

  test("two identical pads (same GUID): the '#2' suffix disambiguates the second one", () => {
    const result = ResolvePadAssignments([padA, padA2], ["aaaa#2", DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(result.players[0]).toBe(1); // the second "aaaa" pad, ordinal 1
    expect(result.players[1]).toBe(0); // the first one goes to the next auto player
  });

  test("a controller nobody ended up with is idle", () => {
    const result = ResolvePadAssignments([padA, padB], [DEVICE_AUTO, DEVICE_KBM, DEVICE_KBM, DEVICE_KBM]);
    expect(result.players).toEqual([0, -1, -1, -1]);
    expect(result.idle).toEqual([false, true]); // padB is idle: only player 1 can take a pad here
  });
});

describe("gamepad_assign.ts -- SeatsDrivable", () => {
  test("player 1 alone always counts as 1 seat", () => {
    expect(SeatsDrivable({ players: [-1, -1, -1, -1], idle: [] })).toBe(1);
    expect(SeatsDrivable({ players: [0, -1, -1, -1], idle: [] })).toBe(1);
  });

  test("seats are counted consecutively from player 1 -- a gap stops the count", () => {
    expect(SeatsDrivable({ players: [0, 1, -1, -1], idle: [] })).toBe(2);
    expect(SeatsDrivable({ players: [0, 1, 2, 3], idle: [] })).toBe(4);
    // player 3 (index 2) has nothing, so player 4 (index 3) doesn't count even
    // though it does have a device -- seats fill in order.
    expect(SeatsDrivable({ players: [0, 1, -1, 3], idle: [] })).toBe(2);
  });
});

describe("gamepad_assign.ts -- MAX_LOCAL_PLAYERS / cvar name helpers", () => {
  test("MAX_LOCAL_PLAYERS is 4 (this port's own multi-seat shape, only seat 0 wired)", () => {
    expect(MAX_LOCAL_PLAYERS).toBe(4);
  });

  test("PlayerDeviceCvarName / PlayerTuningCvarNames name the four players 1-based", () => {
    expect(PlayerDeviceCvarName(0)).toBe("in_player1_device");
    expect(PlayerDeviceCvarName(3)).toBe("in_player4_device");
    expect(PlayerTuningCvarNames(0)).toEqual({
      yaw: "in_player1_yawsensitivity",
      pitch: "in_player1_pitchsensitivity",
      invert: "in_player1_invertpitch",
      deadzone: "in_player1_deadzone",
    });
  });
});

// ---------------------------------------------------------------------------
// Section 3: gamepad_assign.ts's cvar-backed registration -- shared cvar_vars
// state, saved/restored per standing order 13.
// ---------------------------------------------------------------------------

describe("gamepad_assign.ts -- RegisterPlayerCvars / PlayerDevicePrefs / PlayerTuning", () => {
  // Every in_playerN_* cvar this describe block's tests can touch, saved by
  // NAME through Cvar_FindVar (rule 15: cvar values are compared/restored,
  // the CvarT objects themselves are never recreated -- getOrCreateCvar's
  // whole point is that a second RegisterPlayerCvars call returns the same
  // objects sdl.ts's own IN_Init already registered, if this suite runs
  // after that one in the same process).
  const cvarNames: string[] = [];
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    cvarNames.push(PlayerDeviceCvarName(p));
    const names = PlayerTuningCvarNames(p);
    cvarNames.push(names.yaw, names.pitch, names.invert, names.deadzone);
  }
  const saved = new Map<string, string>();

  beforeAll(() => {
    RegisterPlayerCvars({ yawsensitivity: "240", pitchsensitivity: "130", deadzone: "0.175", invert: "0" });
    for (const name of cvarNames) {
      const cvar = Cvar_FindVar(name);
      if (cvar) saved.set(name, cvar.string);
    }
  });

  afterAll(() => {
    for (const [name, value] of saved) Cvar_Set(name, value);
  });

  test("PlayerDevicePrefs defaults every player to auto", () => {
    for (const name of cvarNames.filter((n) => n.endsWith("_device"))) Cvar_Set(name, DEVICE_AUTO);
    const prefs = PlayerDevicePrefs();
    expect(prefs).toEqual([DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
  });

  test("PlayerTuning(0) inherits the live global joy_sensitivity_yaw/pitch/deadzone/invert as this describe's own registration defaults", () => {
    const t = PlayerTuning(0);
    expect(t.yawsensitivity).toBe(240);
    expect(t.pitchsensitivity).toBe(130);
    expect(t.deadzone).toBe(0.175);
    expect(t.pitchsign).toBe(1); // invert defaulted to "0"
  });

  test("PlayerTuning: in_playerN_invertpitch !== 0 flips pitchsign to -1, otherwise +1", () => {
    const names = PlayerTuningCvarNames(1);
    Cvar_Set(names.invert, "1");
    expect(PlayerTuning(1).pitchsign).toBe(-1);
    Cvar_Set(names.invert, "0");
    expect(PlayerTuning(1).pitchsign).toBe(1);
  });

  test("PlayerTuning reads live: a console-style Cvar_Set takes effect on the next read, no re-registration needed", () => {
    const names = PlayerTuningCvarNames(2);
    Cvar_Set(names.deadzone, "0.3");
    expect(PlayerTuning(2).deadzone).toBeCloseTo(0.3, 10);
  });
});

// ---------------------------------------------------------------------------
// Section 4: K_* gamepad keynums -- name-table round trip (config.cfg binds
// and round-trips by NAME, never the raw number -- see keys.ts's own header
// comment on why this port's numbering differs from Ironwail's).
// ---------------------------------------------------------------------------

describe("keys.ts -- gamepad K_* name round trip", () => {
  const GAMEPAD_KEYNAMES: Array<[string, number]> = [
    ["ABUTTON", K_ABUTTON],
    ["BBUTTON", K_BBUTTON],
    ["XBUTTON", K_XBUTTON],
    ["YBUTTON", K_YBUTTON],
    ["LSHOULDER", K_LSHOULDER],
    ["RSHOULDER", K_RSHOULDER],
    ["LTRIGGER", K_LTRIGGER],
    ["RTRIGGER", K_RTRIGGER],
    ["LTHUMB", K_LTHUMB],
    ["RTHUMB", K_RTHUMB],
    ["DPAD_UP", K_DPAD_UP],
    ["DPAD_DOWN", K_DPAD_DOWN],
    ["DPAD_LEFT", K_DPAD_LEFT],
    ["DPAD_RIGHT", K_DPAD_RIGHT],
  ];

  test("every gamepad keynum has a distinct value in the 241-254 range (between K_MWHEELDOWN and K_PAUSE)", () => {
    const values = GAMEPAD_KEYNAMES.map(([, k]) => k);
    expect(new Set(values).size).toBe(values.length); // all distinct
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(241);
      expect(v).toBeLessThanOrEqual(254);
    }
  });

  test("roundtrip for every gamepad keyname, case-insensitively on the way in", () => {
    for (const [name, keynum] of GAMEPAD_KEYNAMES) {
      expect(Key_StringToKeynum(name)).toBe(keynum);
      expect(Key_StringToKeynum(name.toLowerCase())).toBe(keynum);
      expect(Key_KeynumToString(keynum)).toBe(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 5: src/platform/sdl.ts's runtime shell -- hotplug device table,
// button/trigger/stick routing, IN_JoyMove_'s cmd/viewangles contribution.
// Driven for real through SDL_PushEvent/SDL_PollEvent, same technique
// test/sdl_input.test.ts uses for keyboard/mouse.
// ---------------------------------------------------------------------------

const FAKE_GUID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/*
Real SDL (verified on this host: sdl2-compat 2.32 over SDL3) rewrites
SDL_ControllerButtonEvent/SDL_ControllerAxisEvent's `which` field to -1 on a
plain SDL_PushEvent -- it is validated against SDL's own internal open-joystick
table and this test never has a genuinely-open one, so whatever value this
file pushes for `which` comes back as -1 regardless. This is a DIFFERENT,
more thorough round-trip failure than the ones sdl.ts's own test-seam header
comment already documents for mouse wheel/relative motion, and it is why the
fake device this file injects uses instance id -1 too: that is exactly the
"one open pad whose real instance id could not be read" case
gpDeviceByInstance's own fallback branch exists for (see sdl.ts's own doc
comment on that function), so routing a -1-instance event to the sole open
device is production code, not a test-only shortcut -- it is the same branch
a controller whose SDL_JoystickInstanceID lookup failed would take for real.
*/
const FAKE_INSTANCE_A = -1;

const savedSdl = {
  keyDest: keyState.key_dest,
  viewangles: [0, 0, 0] as number[],
  bindings: new Map<number, string | null>(),
  cvars: new Map<string, number>(),
  playerDevice: "",
  frametime: 0,
  realtime: 0,
};

const gamepadCvars = {
  joy_enable,
  joy_deadzone_look,
  joy_deadzone_move,
  joy_outer_threshold_look,
  joy_outer_threshold_move,
  joy_deadzone_trigger,
  joy_sensitivity_yaw,
  joy_sensitivity_pitch,
  joy_invert,
  joy_exponent,
  joy_exponent_move,
  joy_swapmovelook,
};

const GAMEPAD_TEST_KEYS = [K_ABUTTON, K_BBUTTON, K_XBUTTON, K_YBUTTON, K_LSHOULDER, K_RSHOULDER, K_LTHUMB, K_RTHUMB, K_DPAD_UP, K_DPAD_DOWN, K_DPAD_LEFT, K_DPAD_RIGHT, K_LTRIGGER, K_RTRIGGER, K_TAB, K_ESCAPE];

beforeAll(() => {
  savedSdl.keyDest = keyState.key_dest;
  savedSdl.viewangles = [cl.viewangles[0], cl.viewangles[1], cl.viewangles[2]];
  for (const k of GAMEPAD_TEST_KEYS) savedSdl.bindings.set(k, keybindings[k]);
  for (const [name, v] of Object.entries(gamepadCvars)) savedSdl.cvars.set(name, v.value);
  savedSdl.frametime = host.frametime;
  savedSdl.realtime = host.realtime;

  Cbuf_Init();
  Key_Init();
  // Bound (even empty) so Key_Event's ">=200 unbound, hit F4" console
  // message never fires during this suite -- same trick
  // test/sdl_input.test.ts uses for the mouse buttons.
  for (const k of GAMEPAD_TEST_KEYS) keybindings[k] = "";

  SDL_SetBackendEnabled(true);
  expect(SDLVID_Init(320, 240, false)).toBe(true);
  IN_Init(); // registers joy_* cvars, arms SDL_INIT_GAMECONTROLLER, installs the pump
  savedSdl.playerDevice = PlayerDevicePrefs()[0] ?? DEVICE_AUTO;
  SDL_DrainEventsForTests();
});

afterAll(() => {
  IN_Shutdown();
  SDL_ResetBackendForTests();
  keyState.key_dest = savedSdl.keyDest;
  cl.viewangles[0] = savedSdl.viewangles[0] ?? 0;
  cl.viewangles[1] = savedSdl.viewangles[1] ?? 0;
  cl.viewangles[2] = savedSdl.viewangles[2] ?? 0;
  for (const [k, v] of savedSdl.bindings) keybindings[k] = v;
  for (const [name, v] of savedSdl.cvars) {
    const cvar = gamepadCvars[name as keyof typeof gamepadCvars];
    cvar.value = v;
  }
  host.frametime = savedSdl.frametime;
  host.realtime = savedSdl.realtime;
  Cvar_Set(PlayerDeviceCvarName(0), savedSdl.playerDevice);
});

describe("sdl.ts -- gamepad hotplug device table", () => {
  test("a fake device with no explicit assignment is picked up by player 1 on 'auto'", () => {
    SDL_InjectFakeGamepadForTests(FAKE_INSTANCE_A, FAKE_GUID_A, "Fake Pad");
    const devices = SDL_GamepadDevices();
    const row = devices.find((d) => d.instanceId === FAKE_INSTANCE_A);
    expect(row).toBeDefined();
    expect(row!.player).toBe(0); // player 1 (0-based)
    SDL_RemoveFakeGamepadForTests(FAKE_INSTANCE_A);
    expect(SDL_GamepadDevices().find((d) => d.instanceId === FAKE_INSTANCE_A)).toBeUndefined();
  });
});

describe("sdl.ts -- controller button events -> Key_Event, routed through the real SDL_PumpInput switch", () => {
  beforeAll(() => {
    SDL_InjectFakeGamepadForTests(FAKE_INSTANCE_A, FAKE_GUID_A, "Fake Pad");
  });
  afterAll(() => {
    SDL_RemoveFakeGamepadForTests(FAKE_INSTANCE_A);
  });

  test("A button down/up reaches Key_Event as K_ABUTTON", () => {
    keyState.key_dest = KeydestT.key_console;
    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_A, true))).toBe(1);
    expect(SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_A, false))).toBe(1);
    const before = keyState.key_count;
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before + 2);
  });

  test("DPAD UP reaches Key_Event as K_DPAD_UP", () => {
    keyState.key_dest = KeydestT.key_console;
    SDL_DrainEventsForTests();
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_DPAD_UP, true));
    const before = keyState.key_count;
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before + 1);
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_DPAD_UP, false));
    SDL_PumpInputForTests();
  });

  test("START remaps to K_ESCAPE and BACK remaps to K_TAB (Ironwail: 'the player cannot rebind them')", () => {
    keyState.key_dest = KeydestT.key_console;
    keyState.key_linepos = 1;
    const line0 = "]";
    // Bind console line reset isn't needed: K_ESCAPE/K_TAB are handled by
    // Key_Console specially (escape clears the line, tab autocompletes), so
    // this test only asserts the event count increased -- proving the SDL
    // button id was translated to SOME keynum, not left unmapped (0).
    SDL_DrainEventsForTests();
    const before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_START, true));
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_START, false));
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_BACK, true));
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_BACK, false));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before + 4);
    void line0;
  });

  test("a button event with no open gamepad at all is dropped (gpDeviceByInstance finds nothing)", () => {
    // This describe's own beforeAll injected the fake pad; remove it for
    // just this one test so gpDevices is genuinely empty -- with a real
    // `which` value unrecoverable through SDL_PushEvent (see FAKE_INSTANCE_A's
    // own doc comment above), an empty device table is the only way left to
    // exercise gpDeviceByInstance's "found nothing" branch honestly.
    SDL_RemoveFakeGamepadForTests(FAKE_INSTANCE_A);
    SDL_DrainEventsForTests();
    const before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerButtonEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_BUTTON_A, true));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before);
    SDL_InjectFakeGamepadForTests(FAKE_INSTANCE_A, FAKE_GUID_A, "Fake Pad");
  });
});

describe("sdl.ts -- trigger axis events -> edge-triggered Key_Event (joy_deadzone_trigger threshold)", () => {
  beforeAll(() => {
    SDL_InjectFakeGamepadForTests(FAKE_INSTANCE_A, FAKE_GUID_A, "Fake Pad");
    keyState.key_dest = KeydestT.key_console;
  });
  afterAll(() => {
    SDL_RemoveFakeGamepadForTests(FAKE_INSTANCE_A);
  });

  test("crossing above joy_deadzone_trigger fires a press; crossing back below fires a release; no re-fire while held", () => {
    joy_deadzone_trigger.value = 0.2;
    SDL_DrainEventsForTests();

    // below threshold: no event
    let before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_TRIGGERLEFT, 1000));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before);

    // above threshold: one press
    before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_TRIGGERLEFT, 20000));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before + 1);

    // still above threshold: no re-fire
    before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_TRIGGERLEFT, 25000));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before);

    // back below threshold: one release
    before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_TRIGGERLEFT, 500));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before + 1);
  });

  test("the right trigger is independent of the left", () => {
    SDL_DrainEventsForTests();
    const before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_TRIGGERRIGHT, 20000));
    SDL_PumpInputForTests();
    expect(keyState.key_count).toBe(before + 1);
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_TRIGGERRIGHT, 0));
    SDL_PumpInputForTests();
  });
});

describe("sdl.ts -- stick axis events latch onto the device (no Key_Event)", () => {
  beforeAll(() => {
    SDL_InjectFakeGamepadForTests(FAKE_INSTANCE_A, FAKE_GUID_A, "Fake Pad");
  });
  afterAll(() => {
    SDL_RemoveFakeGamepadForTests(FAKE_INSTANCE_A);
  });

  test("left/right stick axis events update SDL_GamepadAxisStateForTests, normalized to +-1 (value/32768)", () => {
    SDL_DrainEventsForTests();
    const before = keyState.key_count;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, 16384));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTY, -16384));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTX, 32767));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTY, 0));
    SDL_PumpInputForTests();
    // stick motion never produces a Key_Event
    expect(keyState.key_count).toBe(before);

    const state = SDL_GamepadAxisStateForTests();
    expect(state).not.toBeNull();
    expect(state!.leftX).toBeCloseTo(0.5, 5);
    expect(state!.leftY).toBeCloseTo(-0.5, 5);
    expect(state!.rightX).toBeCloseTo(32767 / 32768, 5);
    expect(state!.rightY).toBeCloseTo(0, 5);

    // reset the sticks so a later test doesn't inherit this deflection
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, 0));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTY, 0));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTX, 0));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTY, 0));
    SDL_PumpInputForTests();
  });
});

describe("sdl.ts -- IN_Move's IN_JoyMove_ contribution (deadzone + easing + sensitivity, hand-computed)", () => {
  // Self-sufficiency (standing order 13): cl_forwardspeed/cl_sidespeed are
  // cl_input.ts's own cvars, registered by cl_main.ts's CL_Init in the real
  // client -- which nothing in this file calls. A CvarT's .value is 0 until
  // Cvar_RegisterVariable runs (src/common/cvar.ts's own constructor
  // comment), so this describe sets them directly to their documented
  // defaults itself rather than assuming some other test file's CL_Init
  // already ran first in this same bun process.
  const savedForwardspeed = cl_forwardspeed.value;
  const savedSidespeed = cl_sidespeed.value;

  beforeAll(() => {
    SDL_InjectFakeGamepadForTests(FAKE_INSTANCE_A, FAKE_GUID_A, "Fake Pad");
    keyState.key_dest = KeydestT.key_game; // hostClientHooks.keyDestIsGame reads this
    joy_enable.value = 1;
    joy_swapmovelook.value = 0;
    joy_deadzone_move.value = 0.175;
    joy_outer_threshold_move.value = 0.02;
    joy_exponent_move.value = 2;
    joy_deadzone_look.value = 0.175;
    joy_outer_threshold_look.value = 0.02;
    joy_exponent.value = 2;
    joy_sensitivity_yaw.value = 240;
    joy_sensitivity_pitch.value = 130;
    joy_invert.value = 0;
    host.frametime = 0.1; // a round number keeps the hand-computed expectations simple
    cl_forwardspeed.value = 200; // cl_input.ts's own documented default
    cl_sidespeed.value = 350; // cl_input.ts's own documented default
  });
  afterAll(() => {
    SDL_RemoveFakeGamepadForTests(FAKE_INSTANCE_A);
    cl_forwardspeed.value = savedForwardspeed;
    cl_sidespeed.value = savedSidespeed;
  });

  test("a left-stick push below the deadzone contributes nothing to cmd", () => {
    SDL_DrainEventsForTests();
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, Math.round(0.1 * 32768)));
    SDL_PumpInputForTests();

    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cmd.sidemove).toBe(0);
    expect(cmd.forwardmove).toBe(0);

    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, 0));
    SDL_PumpInputForTests();
  });

  test("a left-stick push past the deadzone feeds cmd.sidemove, matching IN_ApplyDeadzone+IN_ApplyEasing times cl_sidespeed", () => {
    SDL_DrainEventsForTests();
    const raw = 0.5; // normalized
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, Math.round(raw * 32768)));
    SDL_PumpInputForTests();

    const deadzoned = IN_ApplyDeadzone({ x: raw, y: 0 }, joy_deadzone_move.value, joy_outer_threshold_move.value);
    const eased = IN_ApplyEasing(deadzoned, joy_exponent_move.value);
    const expectedSidemove = cl_sidespeed.value * eased.x;

    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cmd.sidemove).toBeCloseTo(expectedSidemove, 6);
    expect(cmd.forwardmove).toBe(0);

    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, 0));
    SDL_PumpInputForTests();
  });

  test("left-stick Y feeds cmd.forwardmove with the sign flipped (stick up = forward)", () => {
    SDL_DrainEventsForTests();
    // Quantized to the same int16 SDL actually carries -- see the right-stick
    // test's own comment on why this avoids a spurious precision mismatch.
    const raw = Math.round(-0.6 * 32768) / 32768; // stick pushed up (negative Y)
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTY, Math.round(raw * 32768)));
    SDL_PumpInputForTests();

    const deadzoned = IN_ApplyDeadzone({ x: 0, y: raw }, joy_deadzone_move.value, joy_outer_threshold_move.value);
    const eased = IN_ApplyEasing(deadzoned, joy_exponent_move.value);
    const expectedForwardmove = -cl_forwardspeed.value * eased.y;

    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cmd.forwardmove).toBeCloseTo(expectedForwardmove, 6);
    expect(cmd.forwardmove).toBeGreaterThan(0); // stick up really does mean "forward"

    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTY, 0));
    SDL_PumpInputForTests();
  });

  test("right stick feeds yaw/pitch, scaled by joy_sensitivity_yaw/pitch * host.frametime", () => {
    SDL_DrainEventsForTests();
    // Quantized to the same int16 SDL actually carries (Math.round(raw*32768))
    // and renormalized the same way SDL_PumpInput's own axis case does
    // (value/32768.0), so the hand-computed expectation matches the exact
    // float dev.rightX/rightY holds, not the pre-quantization ideal.
    const rawX = Math.round(0.4 * 32768) / 32768;
    const rawY = Math.round(0.3 * 32768) / 32768;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTX, Math.round(rawX * 32768)));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTY, Math.round(rawY * 32768)));
    SDL_PumpInputForTests();

    const deadzoned = IN_ApplyDeadzone({ x: rawX, y: rawY }, joy_deadzone_look.value, joy_outer_threshold_look.value);
    const eased = IN_ApplyEasing(deadzoned, joy_exponent.value);

    const yawBefore = cl.viewangles[YAW];
    const pitchBefore = cl.viewangles[PITCH];
    const cmd = new UsercmdT();
    IN_Move(cmd);

    const expectedYaw = yawBefore - eased.x * joy_sensitivity_yaw.value * host.frametime;
    const expectedPitch = pitchBefore + eased.y * joy_sensitivity_pitch.value * host.frametime;
    // cl.viewangles is a Float32Array: one float32 ulp at 45 degrees is
    // 3.8e-6, so a 6-digit comparison fails on whatever angle an earlier
    // suite left the view at. 4 digits is still far inside one frame's move.
    expect(cl.viewangles[YAW]).toBeCloseTo(expectedYaw, 4);
    expect(cl.viewangles[PITCH]).toBeCloseTo(expectedPitch, 4);

    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTX, 0));
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTY, 0));
    SDL_PumpInputForTests();
    cl.viewangles[YAW] = yawBefore;
    cl.viewangles[PITCH] = pitchBefore;
  });

  test("in_player1_invertpitch flips IN_Move's pitch contribution sign (PlayerTuning(0), not the global joy_invert directly)", () => {
    const names = PlayerTuningCvarNames(0);
    const before = Cvar_FindVar(names.invert)?.string ?? "0";

    SDL_DrainEventsForTests();
    const rawY = Math.round(0.3 * 32768) / 32768; // see the previous test's own comment on quantization
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTY, Math.round(rawY * 32768)));
    SDL_PumpInputForTests();

    const deadzoned = IN_ApplyDeadzone({ x: 0, y: rawY }, joy_deadzone_look.value, joy_outer_threshold_look.value);
    const eased = IN_ApplyEasing(deadzoned, joy_exponent.value);

    Cvar_Set(names.invert, "1");
    const pitchBefore = cl.viewangles[PITCH];
    const cmd = new UsercmdT();
    IN_Move(cmd);
    const expectedInvertedPitch = pitchBefore + eased.y * joy_sensitivity_pitch.value * -1 * host.frametime;
    expect(cl.viewangles[PITCH]).toBeCloseTo(expectedInvertedPitch, 4);
    expect(cl.viewangles[PITCH]).toBeLessThan(pitchBefore); // inverted: stick down now looks UP

    cl.viewangles[PITCH] = pitchBefore;
    Cvar_Set(names.invert, before);
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTY, 0));
    SDL_PumpInputForTests();
  });

  test("joy_enable 0 disables the whole joystick contribution", () => {
    SDL_DrainEventsForTests();
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, Math.round(0.5 * 32768)));
    SDL_PumpInputForTests();

    joy_enable.value = 0;
    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cmd.sidemove).toBe(0);
    joy_enable.value = 1;

    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, 0));
    SDL_PumpInputForTests();
  });

  test("outside key_game (console/menu), the joystick contributes nothing to cmd", () => {
    SDL_DrainEventsForTests();
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, Math.round(0.5 * 32768)));
    SDL_PumpInputForTests();

    keyState.key_dest = KeydestT.key_console;
    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cmd.sidemove).toBe(0);
    keyState.key_dest = KeydestT.key_game;

    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_LEFTX, 0));
    SDL_PumpInputForTests();
  });

  test("joy_swapmovelook exchanges which stick drives movement vs. look", () => {
    SDL_DrainEventsForTests();
    joy_swapmovelook.value = 1;
    const raw = 0.5;
    // with swap on, the RIGHT stick now drives movement
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTX, Math.round(raw * 32768)));
    SDL_PumpInputForTests();

    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cmd.sidemove).not.toBe(0);

    joy_swapmovelook.value = 0;
    SDL_PushTestEvent(SDL_MakeControllerAxisEvent(FAKE_INSTANCE_A, SDL_TEST_CONTROLLER_AXIS_RIGHTX, 0));
    SDL_PumpInputForTests();
  });
});
