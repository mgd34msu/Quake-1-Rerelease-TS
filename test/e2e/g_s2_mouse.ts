// G scenario 2 -- mouse through real SDL events, plus the IN_Move arithmetic.
import {
  BASE, boot, frames, exec, check, summary, push, pump, sdlTap, sdlKeyDown, sdlKeyUp,
  drain, inputState, setRelDelta, SDLK, keyState, conHas, conTail, asBool,
} from "./g_lib";
import {
  IN_Init, IN_Commands, IN_Move, IN_ClearStates, IN_ModeChanged,
  SDL_AppActivate, SDL_SetFullscreenHint, SDL_MakeMouseMotionEvent,
  SDL_MakeMouseButtonEvent, SDL_MakeMouseWheelEvent, SDL_PushTestEvent,
  SDL_TEST_BUTTON_LEFT, SDL_TEST_BUTTON_MIDDLE, SDL_TEST_BUTTON_RIGHT,
  _windowed_mouse, m_filter,
} from "../../src/platform/sdl";
import { keybindings, KeydestT, K_MOUSE1, K_MOUSE2, K_MOUSE3, K_MWHEELUP, K_MWHEELDOWN } from "../../src/client/keys";
import { in_mlook, in_strafe, in_attack } from "../../src/client/cl_input";
import { cl } from "../../src/client/client";
import { UsercmdT } from "../../src/server/server";
import { PITCH, YAW } from "../../src/common/quakedef";
import { Cvar_SetValue } from "../../src/common/cvar";
import { sensitivity, m_pitch, m_yaw, m_forward, m_side, lookstrafe, lookspring } from "../../src/client/cl_main";
import { setNoclipAnglehack } from "../../src/common/host_cmd";
import { dlopen } from "bun:ffi";

boot(["-basedir", BASE, "-game", "e2e_g", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map e1m1", 25);
exec("unbindall", 2);
keyState.key_dest = KeydestT.key_game;
frames(5);
drain();

// ---- 2a: the mouse comes up out of Host_Init's own call order ------------
// host.c calls IN_Init BEFORE VID_Init on non-win32 ("mouse comes before video
// for security reasons"), and vid_x.c's IN_Init needs no display: mouse_avail
// is the -nomouse parm's answer and nothing else.
const st0 = inputState();
check("after Host_Init: SDL is armed", st0.libraryLoaded && st0.videoSubsystem, JSON.stringify(st0));
check("after Host_Init: mouse_avail is true (IN_Init runs before VID_Init)", st0.mouse_avail === true, `mouse_avail=${st0.mouse_avail}`);
// Capture policy (sdl.ts's wantMouseCapture/_windowed_mouse header comments):
// captured while the window is focused and (fullscreen || key_dest ===
// key_game); _windowed_mouse no longer gates this, only config-file
// round-tripping. key_dest is key_game here (set above), so this captures
// on that basis alone -- section 2b below proves the cvar is irrelevant.
IN_Commands();
check("IN_Commands captures the mouse straight out of a normal boot (key_dest is key_game)", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);
{
  const cmd = new UsercmdT();
  IN_ClearStates();
  setRelDelta(50, 0);
  const y = cl.viewangles[YAW];
  IN_Move(cmd);
  check("IN_Move turns the view once the mouse is captured", cl.viewangles[YAW] !== y, `yaw ${y} -> ${cl.viewangles[YAW]}`);
  cl.viewangles[YAW] = y;
}

// IN_Init is idempotent: re-running it with the backend armed changes nothing.
IN_Init();
const st1 = inputState();
check("re-running IN_Init after VID_Init leaves mouse_avail set", st1.mouse_avail === true, `mouse_avail=${st1.mouse_avail}`);

// ---- 2b: IN_Commands / IN_ActivateMouse gating ---------------------------
// Capture policy: captured while windowActive and (fullscreen || key_dest
// === key_game); released for the console, a menu, chat entry, unfocused
// windowed play, or IN_ModeChanged. _windowed_mouse stays registered for
// config-file compatibility but no longer participates -- each check below
// flips it to prove it has no effect on the outcome.
SDL_SetFullscreenHint(false);
keyState.key_dest = KeydestT.key_console;
Cvar_SetValue("_windowed_mouse", 0);
IN_Commands();
check("windowed + key_dest key_console: mouse stays inactive", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);
Cvar_SetValue("_windowed_mouse", 1);
IN_Commands();
check("_windowed_mouse no longer gates capture: still inactive in the console with the cvar at 1", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);
keyState.key_dest = KeydestT.key_game;
IN_Commands();
check("windowed + key_dest key_game captures the mouse under SDL_VIDEODRIVER=dummy", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);
Cvar_SetValue("_windowed_mouse", 0);
IN_Commands();
check("_windowed_mouse 0 no longer releases capture while key_dest is key_game", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);
keyState.key_dest = KeydestT.key_console;
SDL_SetFullscreenHint(true);
IN_Commands();
check("fullscreen always captures regardless of _windowed_mouse or key_dest", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);
keyState.key_dest = KeydestT.key_game;
SDL_AppActivate(false);
check("focus loss deactivates the mouse (SDL_AppActivate false)", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);
IN_Commands();
check("IN_Commands does not re-capture while the window is inactive", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);
SDL_AppActivate(true);
IN_Commands();
check("focus regained + IN_Commands re-captures", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);
IN_ModeChanged();
check("IN_ModeChanged drops the capture", inputState().mouse_active === false, `mouse_active=${inputState().mouse_active}`);
IN_Commands();
SDL_SetFullscreenHint(false);
// key_dest is still key_game here (never changed since the block above), so
// this recaptures on that basis; the cvar set is left in for config-file
// realism but no longer does anything to the outcome.
Cvar_SetValue("_windowed_mouse", 1);
IN_Commands();
check("mouse re-captured for the arithmetic tests (windowed, key_dest key_game)", inputState().mouse_active === true, `mouse_active=${inputState().mouse_active}`);

// ---- 2c: a pushed SDL_MOUSEMOTION drives the whole path ------------------
// SDL_PumpInput decodes xrel/yrel into mouse_x/mouse_y the way vid_x.c's
// GetEvent decodes MotionNotify, so no accumulator seam is needed here.
{
  drain();
  setRelDelta(0, 0);
  const accepted = SDL_PushTestEvent(SDL_MakeMouseMotionEvent(37, -21)) === 1;
  check("SDL accepts a pushed SDL_MOUSEMOTION", accepted, "SDL_PushEvent == 1");
  pump();
  const st = inputState();
  check("the pump decodes SDL_MOUSEMOTION into mouse_x/mouse_y", st.mouse_x === 37 && st.mouse_y === -21, `mouse_x=${st.mouse_x} mouse_y=${st.mouse_y}`);
  const cmd = new UsercmdT();
  const y = cl.viewangles[YAW];
  IN_Move(cmd);
  check("IN_Move consumes what the pump accumulated", cl.viewangles[YAW] !== y, `yaw ${y} -> ${cl.viewangles[YAW]}`);
  cl.viewangles[YAW] = y;
}

// ---- 2d: IN_Move arithmetic, deltas seeded at the accumulator ------------
function nearly(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}
function moveWith(dx: number, dy: number): { cmd: UsercmdT; pitch: number; yaw: number } {
  const cmd = new UsercmdT();
  IN_ClearStates();
  setRelDelta(dx, dy);
  IN_Move(cmd);
  return { cmd, pitch: cl.viewangles[PITCH], yaw: cl.viewangles[YAW] };
}

exec("bind MOUSE1 +attack", 1);
exec("bind m +mlook", 1);
exec("bind x +strafe", 1);
Cvar_SetValue("m_filter", 0);
Cvar_SetValue("sensitivity", 3);
Cvar_SetValue("m_pitch", 0.022);
Cvar_SetValue("m_yaw", 0.022);
Cvar_SetValue("m_forward", 1);
Cvar_SetValue("m_side", 0.8);
Cvar_SetValue("lookstrafe", 0);
frames(2);

// +mlook on: pitch tracks m_pitch * sensitivity * dy
sdlKeyDown(SDLK.m, 1);
check("SDL 'm' engages +mlook", (in_mlook.state & 1) !== 0, `state=${in_mlook.state}`);
cl.viewangles[PITCH] = 0;
cl.pitchvel = 5;
cl.nodrift = false;
{
  const r = moveWith(0, 40);
  const want = 0.022 * 3 * 40;
  check("+mlook: pitch += m_pitch * sensitivity * dy", nearly(r.pitch, want), `pitch=${r.pitch} want=${want} (0.022*3*40)`);
  check("+mlook calls V_StopPitchDrift", cl.pitchvel === 0 && asBool(cl.nodrift) === true, `pitchvel=${cl.pitchvel} nodrift=${cl.nodrift}`);
  check("+mlook: no forwardmove while looking", r.cmd.forwardmove === 0, `forwardmove=${r.cmd.forwardmove}`);
}
cl.viewangles[PITCH] = 0;
Cvar_SetValue("m_pitch", -0.022);
{
  const r = moveWith(0, 40);
  const want = -0.022 * 3 * 40;
  check("m_pitch -0.022 inverts the pitch", nearly(r.pitch, want), `pitch=${r.pitch} want=${want}`);
}
Cvar_SetValue("m_pitch", 0.022);
cl.viewangles[PITCH] = 0;
Cvar_SetValue("sensitivity", 10);
{
  const r = moveWith(0, 40);
  const want = 0.022 * 10 * 40;
  check("sensitivity 10 scales the pitch (vs 3)", nearly(r.pitch, want), `pitch=${r.pitch} want=${want}`);
}
Cvar_SetValue("sensitivity", 3);

// pitch clamps at +80 / -70 inside IN_Move itself
cl.viewangles[PITCH] = 0;
{
  const r = moveWith(0, 100000);
  check("IN_Move clamps pitch at +80", r.pitch === 80, `pitch=${r.pitch}`);
}
cl.viewangles[PITCH] = 0;
{
  const r = moveWith(0, -100000);
  check("IN_Move clamps pitch at -70", r.pitch === -70, `pitch=${r.pitch}`);
}

// yaw always follows dx while not strafing
cl.viewangles[YAW] = 0;
{
  const r = moveWith(50, 0);
  const want = -(0.022 * 3 * 50);
  check("yaw -= m_yaw * sensitivity * dx", nearly(r.yaw, want), `yaw=${r.yaw} want=${want}`);
}

// -mlook: dy becomes forwardmove
sdlKeyUp(SDLK.m, 1);
check("SDL 'm' release clears +mlook", (in_mlook.state & 1) === 0, `state=${in_mlook.state}`);
cl.viewangles[PITCH] = 0;
{
  const r = moveWith(0, 40);
  const want = -(1 * 3 * 40); // cmd.forwardmove -= m_forward * mouse_y
  check("without +mlook: forwardmove -= m_forward * sensitivity * dy", nearly(r.cmd.forwardmove, want), `forwardmove=${r.cmd.forwardmove} want=${want}`);
  check("without +mlook: pitch untouched", r.pitch === 0, `pitch=${r.pitch}`);
}
cl.viewangles[YAW] = 0;
{
  const r = moveWith(-30, 0);
  const want = -(0.022 * 3 * -30);
  check("without +mlook: dx still turns yaw", nearly(r.yaw, want), `yaw=${r.yaw} want=${want}`);
}

// +strafe: dx becomes sidemove
sdlKeyDown(SDLK.x, 1);
check("SDL 'x' engages +strafe", (in_strafe.state & 1) !== 0, `state=${in_strafe.state}`);
cl.viewangles[YAW] = 0;
{
  const r = moveWith(50, 0);
  const want = 0.8 * 3 * 50; // cmd.sidemove += m_side * mouse_x
  check("+strafe: sidemove += m_side * sensitivity * dx", nearly(r.cmd.sidemove, want), `sidemove=${r.cmd.sidemove} want=${want}`);
  check("+strafe: yaw untouched", r.yaw === 0, `yaw=${r.yaw}`);
}
// +strafe + noclip_anglehack: dy becomes upmove instead of forwardmove
setNoclipAnglehack(true);
{
  const r = moveWith(0, 40);
  const want = -(1 * 3 * 40);
  check("+strafe + noclip_anglehack: upmove -= m_forward * dy", nearly(r.cmd.upmove, want), `upmove=${r.cmd.upmove} want=${want}`);
  check("+strafe + noclip_anglehack: forwardmove stays 0", r.cmd.forwardmove === 0, `forwardmove=${r.cmd.forwardmove}`);
}
setNoclipAnglehack(false);
{
  const r = moveWith(0, 40);
  check("+strafe without the hack: forwardmove takes dy again", nearly(r.cmd.forwardmove, -(1 * 3 * 40)), `forwardmove=${r.cmd.forwardmove}`);
}
sdlKeyUp(SDLK.x, 1);

// lookstrafe + mlook: dx becomes sidemove without +strafe
Cvar_SetValue("lookstrafe", 1);
sdlKeyDown(SDLK.m, 1);
cl.viewangles[YAW] = 0;
{
  const r = moveWith(50, 0);
  check("lookstrafe 1 + +mlook: sidemove takes dx", nearly(r.cmd.sidemove, 0.8 * 3 * 50), `sidemove=${r.cmd.sidemove}`);
  check("lookstrafe 1 + +mlook: yaw untouched", r.yaw === 0, `yaw=${r.yaw}`);
}
sdlKeyUp(SDLK.m, 1);
Cvar_SetValue("lookstrafe", 0);

// lookspring: releasing +mlook restarts pitch drift
Cvar_SetValue("lookspring", 1);
sdlKeyDown(SDLK.m, 1);
cl.nodrift = true;
cl.pitchvel = 0;
sdlKeyUp(SDLK.m, 2);
check("lookspring 1: releasing +mlook calls V_StartPitchDrift", asBool(cl.nodrift) === false, `nodrift=${cl.nodrift} pitchvel=${cl.pitchvel}`);
Cvar_SetValue("lookspring", 0);
sdlKeyDown(SDLK.m, 1);
cl.nodrift = true;
sdlKeyUp(SDLK.m, 2);
check("lookspring 0: releasing +mlook leaves the drift alone", asBool(cl.nodrift) === true, `nodrift=${cl.nodrift}`);

// m_filter averages this delta with the previous one
Cvar_SetValue("m_filter", 1);
cl.viewangles[YAW] = 0;
IN_ClearStates();
setRelDelta(0, 0);
IN_Move(new UsercmdT()); // seed old_mouse_x at 0
cl.viewangles[YAW] = 0;
{
  const cmd = new UsercmdT();
  setRelDelta(100, 0);
  IN_Move(cmd);
  const want = -(0.022 * 3 * 50); // (100 + 0) * 0.5
  check("m_filter 1 halves a delta against the previous one", nearly(cl.viewangles[YAW], want), `yaw=${cl.viewangles[YAW]} want=${want}`);
}
Cvar_SetValue("m_filter", 0);

// ---- 2e: mouse buttons through SDL ---------------------------------------
for (const [name, button, keynum] of [
  ["MOUSE1", SDL_TEST_BUTTON_LEFT, K_MOUSE1],
  ["MOUSE2", SDL_TEST_BUTTON_RIGHT, K_MOUSE2],
  ["MOUSE3", SDL_TEST_BUTTON_MIDDLE, K_MOUSE3],
] as const) {
  const savedBind = keybindings[keynum];
  keybindings[keynum] = `echo GK2_${name}`;
  drain();
  SDL_PushTestEvent(SDL_MakeMouseButtonEvent(button, true));
  SDL_PushTestEvent(SDL_MakeMouseButtonEvent(button, false));
  pump();
  frames(1);
  check(`SDL button ${button} -> ${name}`, conHas(`GK2_${name}`), conTail(2));
  keybindings[keynum] = savedBind;
}

exec("bind MOUSE1 +attack", 1);
drain();
SDL_PushTestEvent(SDL_MakeMouseButtonEvent(SDL_TEST_BUTTON_LEFT, true));
pump();
frames(1);
check("bind mouse1 +attack fires from a real SDL button event", (in_attack.state & 1) !== 0, `state=${in_attack.state}`);
SDL_PushTestEvent(SDL_MakeMouseButtonEvent(SDL_TEST_BUTTON_LEFT, false));
pump();
frames(2);
check("SDL button up releases +attack", (in_attack.state & 1) === 0, `state=${in_attack.state}`);

// ---- 2f: mouse wheel ------------------------------------------------------
// An SDL2-side SDL_PushEvent cannot set SDL3's integer_x/integer_y, which is
// where sdl2-compat rebuilds SDL2's integer wheel.y from -- so a pushed SDL2
// wheel event always polls back as y == 0 and the pump correctly emits
// nothing (gate G-G2). Pushing the event through SDL3's own SDL_PushEvent
// sets that field and exercises the real decode.
for (const [name, y] of [["MWHEELUP", 1], ["MWHEELDOWN", -1]] as const) {
  drain();
  SDL_PushTestEvent(SDL_MakeMouseWheelEvent(y));
  const before = keyState.key_count;
  pump();
  check(`gate G-G2: an SDL2-pushed wheel y=${y} carries no integer y and yields no key`, keyState.key_count === before, `key_count ${before} -> ${keyState.key_count} (${name})`);
}

const sdl3 = dlopen("libSDL3.so.0", { SDL_PushEvent: { args: ["ptr"], returns: "bool" } } as const);
const SDL3_EVENT_SIZE = 128;
function pushSdl3Wheel(y: number): boolean {
  const e = new Uint8Array(SDL3_EVENT_SIZE);
  const v = new DataView(e.buffer);
  v.setUint32(0, 0x403, true); // SDL_EVENT_MOUSE_WHEEL
  v.setUint32(16, 1, true); // windowID
  v.setFloat32(24, 0, true); // x
  v.setFloat32(28, y, true); // y
  v.setUint32(32, 0, true); // direction
  v.setInt32(44, 0, true); // integer_x
  v.setInt32(48, y, true); // integer_y
  return sdl3.symbols.SDL_PushEvent(e);
}

for (const [name, y, keynum] of [["MWHEELUP", 1, K_MWHEELUP], ["MWHEELDOWN", -1, K_MWHEELDOWN]] as const) {
  const savedBind = keybindings[keynum];
  keybindings[keynum] = `echo GK2_${name}`;
  drain();
  check(`SDL3-native wheel push accepted (y=${y})`, pushSdl3Wheel(y), "");
  pump();
  frames(1);
  check(`SDL wheel y=${y} -> ${name} (press+release pair per notch)`, conHas(`GK2_${name}`), conTail(2));
  keybindings[keynum] = savedBind;
}

// the wheel synthesizes a down AND an up for each notch (keys.h's JACK comment)
{
  drain();
  const before = keyState.key_count;
  pushSdl3Wheel(1);
  pump();
  check("one wheel notch produces exactly two Key_Event calls", keyState.key_count === before + 2, `key_count ${before} -> ${keyState.key_count}`);
}

summary("G2 mouse");
