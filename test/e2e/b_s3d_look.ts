import { boot, frames, exec, tap, key, check, summary, keyState, Cvar_VariableValue } from "./b_lib";
import { KeydestT } from "../../src/client/keys";
import { cl } from "../../src/client/client";
import { PITCH, YAW } from "../../src/common/quakedef";
import { inputBackend } from "../../src/client/input";
import * as sdl from "../../src/platform/sdl";
import { Q1TS_DATA } from "./q1data";

const BASE = Q1TS_DATA;

boot(["-basedir", BASE, "-game", "e2e_b", "-nosound"]);
frames(5);
exec("disconnect", 3);
exec("map start", 20);
keyState.key_dest = KeydestT.key_game;
frames(5);

// ---- keyboard look -------------------------------------------------------
const p0 = cl.viewangles[PITCH];
exec("+lookup", 1);
frames(10);
exec("-lookup", 1);
const p1 = cl.viewangles[PITCH];
check("+lookup pitches the view up (pitch decreases)", p1 < p0, `pitch ${p0} -> ${p1}`);

exec("+lookdown", 1);
frames(10);
exec("-lookdown", 1);
const p2 = cl.viewangles[PITCH];
check("+lookdown pitches back down", p2 > p1, `pitch ${p1} -> ${p2}`);

exec("centerview", 2);
frames(3);
check("centerview zeroes the pitch", Math.abs(cl.viewangles[PITCH]) < 1e-6, `pitch=${cl.viewangles[PITCH]}`);

const y0 = cl.viewangles[YAW];
exec("+left", 1);
frames(10);
exec("-left", 1);
const y1 = cl.viewangles[YAW];
check("+left turns the view (yaw increases)", y1 > y0, `yaw ${y0} -> ${y1}`);

// cl_yawspeed scales the turn rate
exec("cl_yawspeed 280", 1);
const y2 = cl.viewangles[YAW];
exec("+left", 1);
frames(10);
exec("-left", 1);
const y3 = cl.viewangles[YAW];
check("cl_yawspeed 280 turns roughly twice as fast", y3 - y2 > (y1 - y0) * 1.5, `delta140=${(y1 - y0).toFixed(2)} delta280=${(y3 - y2).toFixed(2)}`);
exec("cl_yawspeed 140", 1);

// ---- mouse seam ----------------------------------------------------------
// IN_Move in src/platform/sdl.ts reads its deltas straight from
// SDL_GetRelativeMouseState and bails out at `if (!l || !mouse_active) return;`.
// mouse_active DOES become true headlessly (SDL_SetRelativeMouseMode(1)
// returns 0 under SDL_VIDEODRIVER=dummy and the port ignores that return
// value), so the corner this used to flag is closed -- see
// test/e2e/g_s2_mouse.ts (owned by the SDL-input agent) for the full
// arithmetic path driven end to end under the dummy driver. What genuinely
// cannot be fed headlessly is SDL's own relative-motion accumulator (gate
// G-G1 in .orch/e2e/G.md): a pushed SDL_MOUSEMOTION does not move it, so raw
// mouse deltas still need that agent's SDL_SetRelativeDeltaForTests seam,
// which is outside this file's SCOPE.
//
// Capture policy (sdl.ts's wantMouseCapture/_windowed_mouse header
// comments): captured while the window is focused and (fullscreen ||
// key_dest === key_game); released for the console, a menu, chat entry, or
// lost focus. _windowed_mouse stays registered for config-file
// compatibility only -- it no longer decides this.
const sdlExports = Object.keys(sdl).filter((k) => /mouse|delta|rel|motion/i.test(k));
console.log("  src/platform/sdl.ts mouse-related exports:", sdlExports.join(", ") || "(none)");
check("a synthetic-mouse-delta seam exists in src/platform/sdl.ts (SDL_SetRelativeDeltaForTests, gate G-G1)", sdlExports.includes("SDL_SetRelativeDeltaForTests"), `exports=${sdlExports.join(",") || "(none)"}`);
check("inputBackend.current is installed", inputBackend.current !== null, "");

keyState.key_dest = KeydestT.key_console;
sdl.IN_Commands();
check("windowed + key_dest key_console: mouse stays released", sdl.SDL_InputStateForTests().mouse_active === false, `mouse_active=${sdl.SDL_InputStateForTests().mouse_active}`);
keyState.key_dest = KeydestT.key_game;
sdl.IN_Commands();
check("windowed + key_dest key_game: mouse is captured", sdl.SDL_InputStateForTests().mouse_active === true, `mouse_active=${sdl.SDL_InputStateForTests().mouse_active}`);

// The cvars IN_Move reads are all registered and settable, which is as far as
// a headless run can go. _windowed_mouse's own default moved to "1" (config
// compatibility only, per its sdl.ts header comment) -- no longer asserted
// to gate anything here.
for (const n of ["sensitivity", "m_pitch", "m_yaw", "m_forward", "m_side", "m_filter", "lookspring", "lookstrafe", "_windowed_mouse"]) {
  const { Cvar_FindVar } = require("../../src/common/cvar");
  check(`IN_Move cvar ${n} registered`, Cvar_FindVar(n) !== null, `value=${Cvar_VariableValue(n)}`);
}

summary("S3d look/mouse");
process.exit(0);
