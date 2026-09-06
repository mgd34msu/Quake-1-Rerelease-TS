// Force headless SDL before ANY import can reach the FFI layer: these tests
// must never open a real window or audio device on the host desktop.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for the input half of src/platform/sdl.ts driven through SDL's own
event queue: an SDL_Event built by this file's seam is handed to
SDL_PushEvent, and SDL_PumpInput (registered as sys.ts's key-event pump by
IN_Init) polls it back out with SDL_PollEvent -- the same call a real
keyboard or mouse goes through. Self-sufficient per standing order 13: it
arms the backend itself and undoes everything it touched in afterAll
(keyState, key_lines, keybindings, cl.viewangles, the mouse cvars, and the
SDL backend itself).

The mouse path runs end to end through the queue too: SDL_PumpInput decodes
SDL_MOUSEMOTION's xrel/yrel into mouse_x/mouse_y itself (vid_x.c's GetEvent
does the same with MotionNotify), so a pushed motion event reaches IN_Move's
arithmetic without any stand-in for SDL's own relative-motion accumulator.

The one thing a pushed event still cannot reach is SDL2's integer mouse-wheel
delta, which sdl2-compat recomputes from an SDL3 field an SDL2-side push never
sets -- see sdl.ts's test seam header.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  IN_Commands,
  IN_Init,
  IN_Move,
  IN_MoveQw,
  IN_ClearStates,
  IN_Shutdown,
  SDL_DrainEventsForTests,
  SDL_InputStateForTests,
  SDL_MakeKeyEvent,
  SDL_MakeMouseButtonEvent,
  SDL_MakeMouseMotionEvent,
  SDL_MakeQuitEvent,
  SDL_PushTestEvent,
  SDL_ResetBackendForTests,
  SDL_SetBackendEnabled,
  SDL_SetFullscreenHint,
  SDL_SetRelativeDeltaForTests,
  SDL_TEST_BUTTON_LEFT,
  SDL_TEST_BUTTON_MIDDLE,
  SDL_TEST_BUTTON_RIGHT,
  SDL_TEST_WINDOWEVENT_FOCUS_GAINED,
  SDL_TEST_WINDOWEVENT_FOCUS_LOST,
  SDL_MakeWindowEvent,
  SDL_MakeWindowSizeChangedEvent,
  SDL_SetWindowSizeChangedHandler,
  SDL_TEST_WINDOWEVENT_SIZE_CHANGED,
  SDLVID_Init,
  _windowed_mouse,
  m_filter,
} from "../src/platform/sdl";
import { Sys_SendKeyEvents } from "../src/platform/sys";
// the handler platform/vid.ts registers at module scope, restored by the
// SIZE_CHANGED tests below after they swap in a stub
import { VID_SizeChanged } from "../src/platform/vid";
import { Cbuf_Init } from "../src/common/cmd";
import { Key_Init, KeydestT, keyState, key_lines, keybindings, K_MOUSE1, K_MOUSE2, K_MOUSE3 } from "../src/client/keys";
import { cl } from "../src/client/client";
import { UsercmdT } from "../src/server/server";
import { QwUsercmdT } from "../src/qw/protocol";
import { PITCH, YAW } from "../src/common/quakedef";
import { in_mlook, in_strafe } from "../src/client/cl_input";
import { m_forward, m_pitch, m_side, m_yaw, sensitivity, lookstrafe } from "../src/client/cl_main";
import { qw } from "../src/common/quakedef";
import { com_argc, com_argv, setComArgc, setComArgv } from "../src/common/common";
import { qwInputHooks, type QwInputRefs } from "../src/client/input";
// the QuakeWorld tree's OWN input globals and cvars -- the ones a qwcl process
// registers and mutates, and the ones IN_MoveQw has to read there.
import { in_mlook as qw_in_mlook, in_strafe as qw_in_strafe } from "../src/qw/client/cl_input";
import {
  lookstrafe as qw_lookstrafe,
  sensitivity as qw_sensitivity,
  m_pitch as qw_m_pitch,
  m_yaw as qw_m_yaw,
  m_forward as qw_m_forward,
  m_side as qw_m_side,
} from "../src/qw/client/cl_main";

const SDLK_w = 119;
const SDLK_UP = (1 << 30) | 82;

// everything this suite mutates, captured before it runs
const saved = {
  key_dest: keyState.key_dest,
  edit_line: keyState.edit_line,
  key_linepos: keyState.key_linepos,
  key_count: keyState.key_count,
  line: "",
  bindings: new Map<number, string | null>(),
  viewangles: [0, 0, 0],
  cvars: new Map<string, number>(),
  mlook: 0,
  strafe: 0,
  qwActive: false,
  qwHooks: null as QwInputRefs | null,
  qwCvars: new Map<string, number>(),
  qwMlook: 0,
  qwStrafe: 0,
  argc: 0,
  argv: [] as string[],
};

const cvars = { sensitivity, m_pitch, m_yaw, m_forward, m_side, lookstrafe, m_filter, _windowed_mouse };
const qwCvars = {
  sensitivity: qw_sensitivity,
  m_pitch: qw_m_pitch,
  m_yaw: qw_m_yaw,
  m_forward: qw_m_forward,
  m_side: qw_m_side,
  lookstrafe: qw_lookstrafe,
};

beforeAll(() => {
  saved.line = key_lines[keyState.edit_line];
  saved.viewangles = [cl.viewangles[0], cl.viewangles[1], cl.viewangles[2]];
  saved.mlook = in_mlook.state;
  saved.strafe = in_strafe.state;
  for (const k of [K_MOUSE1, K_MOUSE2, K_MOUSE3]) saved.bindings.set(k, keybindings[k]);
  for (const [name, v] of Object.entries(cvars)) saved.cvars.set(name, v.value);
  saved.qwActive = qw.active;
  saved.qwHooks = qwInputHooks.current;
  saved.qwMlook = qw_in_mlook.state;
  saved.qwStrafe = qw_in_strafe.state;
  for (const [name, v] of Object.entries(qwCvars)) saved.qwCvars.set(name, v.value);
  saved.argc = com_argc;
  saved.argv = com_argv;

  // a bound (even empty) mouse button keeps Key_Event's "is unbound" message
  // out of a console this suite never initialized
  for (const k of [K_MOUSE1, K_MOUSE2, K_MOUSE3]) keybindings[k] = "";

  // keys.c's own tables (consolekeys[], keyshift[]) and the command buffer
  // Key_Event writes into: this suite must not assume another file built them.
  Cbuf_Init();
  Key_Init();

  SDL_SetBackendEnabled(true);
  expect(SDLVID_Init(320, 240, false)).toBe(true);
  IN_Init(); // arms mouse_avail and installs SDL_PumpInput as the key pump
  SDL_DrainEventsForTests();
});

afterAll(() => {
  IN_Shutdown();
  SDL_ResetBackendForTests();
  keyState.key_dest = saved.key_dest;
  keyState.edit_line = saved.edit_line;
  keyState.key_linepos = saved.key_linepos;
  keyState.key_count = saved.key_count;
  key_lines[saved.edit_line] = saved.line;
  for (const [k, v] of saved.bindings) keybindings[k] = v;
  cl.viewangles[0] = saved.viewangles[0];
  cl.viewangles[1] = saved.viewangles[1];
  cl.viewangles[2] = saved.viewangles[2];
  in_mlook.state = saved.mlook;
  in_strafe.state = saved.strafe;
  for (const [name, v] of saved.cvars) {
    const cvar = cvars[name as keyof typeof cvars];
    cvar.value = v;
  }
  for (const [name, cvar] of Object.entries(qwCvars)) {
    const v = saved.qwCvars.get(name);
    if (v !== undefined) cvar.value = v;
  }
  qw.active = saved.qwActive;
  qwInputHooks.current = saved.qwHooks;
  qw_in_mlook.state = saved.qwMlook;
  qw_in_strafe.state = saved.qwStrafe;
  setComArgc(saved.argc);
  setComArgv(saved.argv);
  SDL_SetFullscreenHint(false);
});

describe("src/platform/sdl.ts -- pushed SDL key events reach Key_Event", () => {
  test("IN_Init arms the backend and the event pump under the dummy driver", () => {
    const st = SDL_InputStateForTests();
    expect(st.libraryLoaded).toBe(true);
    expect(st.videoSubsystem).toBe(true);
    // IN_Init sets mouse_avail only because this suite armed SDL BEFORE
    // calling it; Host_Init's own order is the other way round (see G.md).
    expect(st.mouse_avail).toBe(true);
  });

  test("a key down/up pair pushed through SDL is delivered to Key_Event", () => {
    SDL_DrainEventsForTests();
    keyState.key_dest = KeydestT.key_console;
    keyState.edit_line = 0;
    keyState.key_linepos = 1;
    key_lines[0] = "]";

    expect(SDL_PushTestEvent(SDL_MakeKeyEvent(SDLK_w, true))).toBe(1);
    expect(SDL_PushTestEvent(SDL_MakeKeyEvent(SDLK_w, false))).toBe(1);

    const before = keyState.key_count;
    Sys_SendKeyEvents();

    expect(keyState.key_count).toBe(before + 2);
    // SDLK_w passes through unmapped as lowercase ascii, so the console line
    // proves the exact key number Key_Event received.
    expect(key_lines[0]).toBe("]w");
    expect(keyState.key_linepos).toBe(2);
  });

  test("a repeat=1 key event is dropped by the pump", () => {
    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeKeyEvent(SDLK_w, true, true))).toBe(1);
    const before = keyState.key_count;
    Sys_SendKeyEvents();
    expect(keyState.key_count).toBe(before);
  });

  test("a mapped special key arrives as its K_* number, not its SDLK_* value", () => {
    SDL_DrainEventsForTests();
    keyState.key_dest = KeydestT.key_game;
    // K_UPARROW is 128; binding it to "" keeps the dispatch inert while still
    // proving Key_Event was reached with a key the console would not accept.
    const before = keyState.key_count;
    expect(SDL_PushTestEvent(SDL_MakeKeyEvent(SDLK_UP, true))).toBe(1);
    expect(SDL_PushTestEvent(SDL_MakeKeyEvent(SDLK_UP, false))).toBe(1);
    Sys_SendKeyEvents();
    expect(keyState.key_count).toBe(before + 2);
  });

  test("mouse buttons arrive as K_MOUSE1/2/3", () => {
    keyState.key_dest = KeydestT.key_game;
    for (const button of [SDL_TEST_BUTTON_LEFT, SDL_TEST_BUTTON_RIGHT, SDL_TEST_BUTTON_MIDDLE]) {
      SDL_DrainEventsForTests();
      const before = keyState.key_count;
      expect(SDL_PushTestEvent(SDL_MakeMouseButtonEvent(button, true))).toBe(1);
      expect(SDL_PushTestEvent(SDL_MakeMouseButtonEvent(button, false))).toBe(1);
      Sys_SendKeyEvents();
      expect(keyState.key_count).toBe(before + 2);
    }
  });

  test("a window focus event toggles windowActive without quitting", () => {
    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_LOST))).toBe(1);
    Sys_SendKeyEvents();
    expect(SDL_InputStateForTests().windowActive).toBe(false);

    expect(SDL_PushTestEvent(SDL_MakeWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_GAINED))).toBe(1);
    Sys_SendKeyEvents();
    expect(SDL_InputStateForTests().windowActive).toBe(true);
  });

  test("SDL_MakeQuitEvent builds an SDL_QUIT the queue accepts", () => {
    // pushed but NOT pumped: SDL_PumpInput would call Sys_Quit and take the
    // test runner's process down with it (that path is covered end to end by
    // test/e2e/g_s4_window.ts, which runs it in a child process).
    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeQuitEvent())).toBe(1);
    expect(SDL_DrainEventsForTests()).toBeGreaterThanOrEqual(1);
  });
});

// IN_Commands is the engine's own per-frame capture gate; every mouse test
// below needs it to have taken the pointer, exactly as a running Host_Frame
// would have. key_dest is what actually drives capture now (see sdl.ts's
// wantMouseCapture); _windowed_mouse is set too only to prove it no longer
// matters (a stray "0" left over from another test must not defeat capture).
function captureMouse(): void {
  _windowed_mouse.value = 1;
  keyState.key_dest = KeydestT.key_game;
  SDL_SetFullscreenHint(false);
  IN_Commands();
  expect(SDL_InputStateForTests().mouse_active).toBe(true);
}

describe("src/platform/sdl.ts -- mouse motion and IN_Move", () => {
  test("the pump accumulates a pushed SDL_MOUSEMOTION into mouse_x/mouse_y", () => {
    SDL_DrainEventsForTests();
    SDL_SetRelativeDeltaForTests(0, 0);
    expect(SDL_PushTestEvent(SDL_MakeMouseMotionEvent(37, -21))).toBe(1);
    Sys_SendKeyEvents();
    const st = SDL_InputStateForTests();
    expect(st.mouse_x).toBe(37);
    expect(st.mouse_y).toBe(-21);

    // GetEvent runs once per event, so two events in one frame sum
    expect(SDL_PushTestEvent(SDL_MakeMouseMotionEvent(3, 1))).toBe(1);
    Sys_SendKeyEvents();
    expect(SDL_InputStateForTests().mouse_x).toBe(40);
    expect(SDL_InputStateForTests().mouse_y).toBe(-20);
    SDL_SetRelativeDeltaForTests(0, 0);
  });

  test("IN_Commands captures the mouse and IN_Move applies the delta arithmetic", () => {
    _windowed_mouse.value = 1;
    m_filter.value = 0;
    sensitivity.value = 3;
    m_pitch.value = 0.022;
    m_yaw.value = 0.022;
    m_forward.value = 1;
    m_side.value = 0.8;
    lookstrafe.value = 0;
    SDL_SetFullscreenHint(false);
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(true);

    // no +mlook: dx turns the yaw, dy becomes forwardmove
    in_mlook.state = 0;
    in_strafe.state = 0;
    cl.viewangles[YAW] = 0;
    cl.viewangles[PITCH] = 0;
    const cmd = new UsercmdT();
    IN_ClearStates();
    SDL_SetRelativeDeltaForTests(50, 40);
    IN_Move(cmd);
    expect(cl.viewangles[YAW]).toBeCloseTo(-(0.022 * 3 * 50), 4);
    expect(cmd.forwardmove).toBeCloseTo(-(1 * 3 * 40), 4);
    expect(cl.viewangles[PITCH]).toBe(0);

    // +mlook: dy becomes pitch instead
    in_mlook.state = 1;
    cl.viewangles[PITCH] = 0;
    const cmd2 = new UsercmdT();
    IN_ClearStates();
    SDL_SetRelativeDeltaForTests(0, 40);
    IN_Move(cmd2);
    expect(cl.viewangles[PITCH]).toBeCloseTo(0.022 * 3 * 40, 4);
    expect(cmd2.forwardmove).toBe(0);
    in_mlook.state = 0;

    // the accumulator is consumed, not carried into the next frame
    expect(SDL_InputStateForTests().mouse_x).toBe(0);
    expect(SDL_InputStateForTests().mouse_y).toBe(0);
  });

  test("a pushed SDL_MOUSEMOTION drives cl.viewangles[PITCH] through the whole path", () => {
    captureMouse();
    sensitivity.value = 3;
    m_pitch.value = 0.022;
    m_filter.value = 0;
    in_mlook.state = 1;
    in_strafe.state = 0;
    cl.viewangles[PITCH] = 0;
    cl.viewangles[YAW] = 0;

    SDL_DrainEventsForTests();
    SDL_SetRelativeDeltaForTests(0, 0);
    expect(SDL_PushTestEvent(SDL_MakeMouseMotionEvent(0, 40))).toBe(1);
    Sys_SendKeyEvents();

    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cl.viewangles[PITCH]).toBeCloseTo(0.022 * 3 * 40, 4);
    expect(cl.viewangles[YAW]).toBe(0);
    in_mlook.state = 0;
  });

  test("under qw.active IN_MoveQw reads QuakeWorld's own cvars and buttons", () => {
    captureMouse();
    // the WinQuake objects are left at values that would give a different
    // answer, so a wrong read shows up as a wrong number, not as a zero.
    sensitivity.value = 1;
    m_pitch.value = 0.5;
    m_yaw.value = 0.5;
    in_mlook.state = 0;
    in_strafe.state = 0;

    qw_sensitivity.value = 3;
    qw_m_pitch.value = 0.022;
    qw_m_yaw.value = 0.022;
    qw_m_forward.value = 1;
    qw_m_side.value = 0.8;
    qw_lookstrafe.value = 0;
    qw_in_strafe.state = 0;
    qw_in_mlook.state = 1; // QW's +mlook, not the NetQuake tree's
    m_filter.value = 0;

    qwInputHooks.current = {
      in_strafe: qw_in_strafe,
      in_mlook: qw_in_mlook,
      lookstrafe: qw_lookstrafe,
      sensitivity: qw_sensitivity,
      m_pitch: qw_m_pitch,
      m_yaw: qw_m_yaw,
      m_forward: qw_m_forward,
      m_side: qw_m_side,
    };
    qw.active = true;
    try {
      cl.viewangles[PITCH] = 0;
      cl.viewangles[YAW] = 0;
      SDL_DrainEventsForTests();
      SDL_SetRelativeDeltaForTests(0, 0);
      expect(SDL_PushTestEvent(SDL_MakeMouseMotionEvent(50, 40))).toBe(1);
      Sys_SendKeyEvents();

      const cmd = new QwUsercmdT();
      IN_MoveQw(cmd);
      expect(cl.viewangles[PITCH]).toBeCloseTo(0.022 * 3 * 40, 4);
      expect(cl.viewangles[YAW]).toBeCloseTo(-(0.022 * 3 * 50), 4);
      expect(cmd.forwardmove).toBe(0);
    } finally {
      qw.active = false;
      qwInputHooks.current = null;
      qw_in_mlook.state = 0;
    }

    // with qw.active back off the same pushed delta takes the WinQuake objects
    cl.viewangles[PITCH] = 0;
    cl.viewangles[YAW] = 0;
    in_mlook.state = 1;
    SDL_DrainEventsForTests();
    SDL_SetRelativeDeltaForTests(0, 0);
    expect(SDL_PushTestEvent(SDL_MakeMouseMotionEvent(0, 40))).toBe(1);
    Sys_SendKeyEvents();
    const cmd2 = new UsercmdT();
    IN_Move(cmd2);
    expect(cl.viewangles[PITCH]).toBeCloseTo(0.5 * 1 * 40, 4);
    in_mlook.state = 0;
  });
});

describe("src/platform/sdl.ts -- IN_Init, -nomouse and mouse_avail", () => {
  // vid_x.c's IN_Init: `if (COM_CheckParm("-nomouse")) return; mouse_x =
  // mouse_y = 0.0; mouse_avail = 1;` -- the parm is the only thing that
  // decides mouse_avail, which is why host.c can call IN_Init before VID_Init
  // ("on non win32, mouse comes before video for security reasons") and still
  // end up with a working mouse.
  function reInit(argv: string[]): void {
    IN_Shutdown();
    setComArgv([...argv, " "]);
    setComArgc(argv.length);
    IN_Init();
  }

  test("IN_Init with no -nomouse sets mouse_avail", () => {
    reInit(["quake", "-basedir", "/nonexistent"]);
    expect(SDL_InputStateForTests().mouse_avail).toBe(true);
  });

  test("-nomouse leaves mouse_avail false and makes mouse motion inert", () => {
    reInit(["quake", "-nomouse"]);
    expect(SDL_InputStateForTests().mouse_avail).toBe(false);

    // IN_Commands is the only thing that ever takes the pointer, and its very
    // first line is `if (!mouse_avail) return;`
    _windowed_mouse.value = 1;
    SDL_SetFullscreenHint(false);
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(false);

    sensitivity.value = 3;
    m_pitch.value = 0.022;
    in_mlook.state = 1;
    cl.viewangles[PITCH] = 0;
    cl.viewangles[YAW] = 0;
    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeMouseMotionEvent(50, 40))).toBe(1);
    Sys_SendKeyEvents();
    const cmd = new UsercmdT();
    IN_Move(cmd);
    expect(cl.viewangles[PITCH]).toBe(0);
    expect(cl.viewangles[YAW]).toBe(0);
    expect(cmd.forwardmove).toBe(0);
    in_mlook.state = 0;

    // and the keyboard still works with -nomouse: IN_Init installs the pump
    // before the parm check, exactly as the C registers its cvars before it
    keyState.key_dest = KeydestT.key_game;
    SDL_DrainEventsForTests();
    const before = keyState.key_count;
    expect(SDL_PushTestEvent(SDL_MakeKeyEvent(SDLK_w, true))).toBe(1);
    Sys_SendKeyEvents();
    expect(keyState.key_count).toBe(before + 1);

    reInit(["quake"]);
    expect(SDL_InputStateForTests().mouse_avail).toBe(true);
  });
});

// Defect: "you are not capturing the mouse" -- windowed play never grabbed
// the mouse because wantMouseCapture gated on _windowed_mouse (faithfully
// defaulted to "0", vid_x.c's 1999 opt-in), and the user's own archived
// config.cfg carries that same "0" forward. The fix moves capture onto
// key_dest (see sdl.ts's own header comment on the deviation from vid_x.c,
// which has no such check at all): captured while playing with the window
// focused, released for the console/menu/message line or a loss of focus,
// forced on in fullscreen regardless. _windowed_mouse stays registered (for
// config compatibility) but is proven inert below.
describe("src/platform/sdl.ts -- mouse capture follows key_dest and window focus, not _windowed_mouse", () => {
  // the previous describe block's last call, reInit(["quake"]), already left
  // mouse_avail true and mouse_active false -- nothing further to arm here.
  afterAll(() => {
    keyState.key_dest = KeydestT.key_game;
    SDL_SetFullscreenHint(false);
    IN_Commands();
  });

  test("windowed + key_dest key_game captures the mouse and hides the cursor, even with _windowed_mouse 0", () => {
    _windowed_mouse.value = 0; // the reported defect's exact archived config value
    SDL_SetFullscreenHint(false);
    keyState.key_dest = KeydestT.key_game;
    IN_Commands();
    const st = SDL_InputStateForTests();
    expect(st.mouse_active).toBe(true);
    expect(st.cursorVisible).toBe(false);
  });

  test("switching key_dest to key_console releases the mouse and shows the cursor", () => {
    keyState.key_dest = KeydestT.key_console;
    IN_Commands();
    const st = SDL_InputStateForTests();
    expect(st.mouse_active).toBe(false);
    expect(st.cursorVisible).toBe(true);
  });

  test("key_menu and key_message also release the mouse", () => {
    for (const dest of [KeydestT.key_menu, KeydestT.key_message]) {
      keyState.key_dest = KeydestT.key_game;
      IN_Commands();
      expect(SDL_InputStateForTests().mouse_active).toBe(true);

      keyState.key_dest = dest;
      IN_Commands();
      expect(SDL_InputStateForTests().mouse_active).toBe(false);
    }
  });

  test("losing window focus releases the mouse regardless of key_dest, and it re-captures on refocus", () => {
    keyState.key_dest = KeydestT.key_game;
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(true);

    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_LOST))).toBe(1);
    Sys_SendKeyEvents();
    expect(SDL_InputStateForTests().windowActive).toBe(false);
    expect(SDL_InputStateForTests().mouse_active).toBe(false);
    expect(SDL_InputStateForTests().cursorVisible).toBe(true);

    // still released while unfocused even though key_dest never left key_game
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(false);

    SDL_DrainEventsForTests();
    expect(SDL_PushTestEvent(SDL_MakeWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_GAINED))).toBe(1);
    Sys_SendKeyEvents();
    expect(SDL_InputStateForTests().windowActive).toBe(true);
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(true);
  });

  test("fullscreen forces capture even with the console up, windowed does not", () => {
    keyState.key_dest = KeydestT.key_console;
    SDL_SetFullscreenHint(true);
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(true);

    SDL_SetFullscreenHint(false);
    IN_Commands();
    expect(SDL_InputStateForTests().mouse_active).toBe(false);
  });
});

/*
SDL_WINDOWEVENT_SIZE_CHANGED, the one window event the pump used to drop:
vid_x.c ignores ConfigureNotify (its X11 window is fixed-size), which left a
window a compositor had resized rendering the old mode's resolution into a
differently sized drawable. The pump now decodes data1/data2 and hands them
to whatever handler src/platform/vid.ts registered.
*/
describe("SDL_PumpInput -- SDL_WINDOWEVENT_SIZE_CHANGED", () => {
  test("decodes data1/data2 and calls the registered size handler", () => {
    const seen: Array<{ width: number; height: number }> = [];
    SDL_DrainEventsForTests();
    SDL_SetWindowSizeChangedHandler((width, height) => {
      seen.push({ width, height });
    });
    try {
      expect(SDL_PushTestEvent(SDL_MakeWindowSizeChangedEvent(1181, 502))).toBe(1);
      Sys_SendKeyEvents();
      expect(seen).toEqual([{ width: 1181, height: 502 }]);
    } finally {
      // platform/vid.ts installs VID_SizeChanged at module scope; put it back
      // rather than leaving a later suite with this file's stub (rule 15).
      SDL_SetWindowSizeChangedHandler(VID_SizeChanged);
    }
  });

  test("a window event that is not SIZE_CHANGED never reaches the size handler", () => {
    const seen: number[] = [];
    SDL_DrainEventsForTests();
    SDL_SetWindowSizeChangedHandler((width) => {
      seen.push(width);
    });
    try {
      expect(SDL_PushTestEvent(SDL_MakeWindowEvent(SDL_TEST_WINDOWEVENT_FOCUS_GAINED))).toBe(1);
      Sys_SendKeyEvents();
      expect(seen).toEqual([]);
      expect(SDL_TEST_WINDOWEVENT_SIZE_CHANGED).toBe(6);
    } finally {
      SDL_SetWindowSizeChangedHandler(VID_SizeChanged);
    }
  });
});
