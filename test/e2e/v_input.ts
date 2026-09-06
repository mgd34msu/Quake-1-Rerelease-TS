/*
Driver 2/3 for family V (src/client/splitscreen.ts, U43): per-seat input
independence. Seat 0 keeps the keyboard and the bind system, exactly as a
one-seat session always has; a splitscreen seat past 0 has none of that and
takes its whole move from the controller gamepad_assign.ts routed to it
(src/platform/sdl.ts's IN_MoveSeat -- see that file's own header on
CL_SeatMove). This drives BOTH real input paths and checks neither leaks into
the other seat's usercmd:

  - a real SDL keyboard key, pushed through SDL's own event queue (the same
    mechanism test/e2e/g_lib.ts's g_s1_keyboard.ts uses) -- moves seat 0 only.
  - a second gamepad's stick and buttons -- moves seat 1 only.

Why not a real SDL_CONTROLLERAXISMOTION/BUTTONDOWN event for the SECOND pad
too: src/platform/sdl.ts's own SDL_SetFakeGamepadStateForTests doc comment
explains that SDL_PushEvent validates a controller event's `which` against
SDL's real open-joystick table, and this headless process never has one, so
a pushed controller event always comes back as `which == -1` and can only
ever reach a SOLE open device (gpDeviceByInstance's fallback) -- there is no
way to address a SECOND fake pad by a pushed event at all. That setter is the
documented seam for exactly this scenario (its own comment: "The second half
of that seam, for the SPLITSCREEN seats (U43)"), and it sets the same fields
SDL_PumpInput's real event decode would have latched, so everything
downstream -- gpDeviceForPlayer, PlayerTuning, the deadzone/easing math,
IN_MoveSeat's whole body -- is still the real code path; only SDL's own
event-decode step is stood in for, and only because this sandbox cannot
address a second device through it.

Usage:
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/v_input.ts [--tree classic|rerelease] [--vid soft|gl]

The wiring under test (gpDeviceForPlayer/IN_MoveSeat/the bind system) is
content-independent, so this is run once against classic dm4 by default; a
--tree rerelease run is available for completeness but not required by the
manifest.

Env: Q1TS_DATA (required), Q1TS_SCRATCH / V_HOME (see test/e2e/v_lib.ts).
*/
import { boot, activeIsGL, frames, exec, runCmd, inGame, seatUp, guardFrames, seatServerInfo, edictOrigin, dist3, check, summary, keyState, KeydestT, Cvar_Set, type TreeT, type VidT, defaultMap } from "./v_lib";
import { SS_SeatButtons, SS_SeatCount } from "../../src/client/splitscreen";
import { SDL_InjectFakeGamepadForTests, SDL_SetFakeGamepadStateForTests, SDL_RemoveFakeGamepadForTests, SDL_GamepadDevices } from "../../src/platform/sdl";
import { sdlKeyDown, sdlKeyUp, SDLK } from "./g_lib";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const tree = (argValue("--tree", "classic") === "rerelease" ? "rerelease" : "classic") as TreeT;
const vidArg = (argValue("--vid", "soft") === "gl" ? "gl" : "soft") as VidT;
const map = defaultMap(tree);

const PAD_SEAT0 = 9101;
const PAD_SEAT1 = 9102;
const SDL_BUTTON_A = 0; // SDL_CONTROLLER_BUTTON_A

console.log(`=== v_input: per-seat input independence, tree=${tree}, map=${map}, vid=${vidArg} ===`);

// `-listen 2` pre-sizes svs.maxclients/svs.clients for 2 players at boot --
// see test/e2e/v_seats.ts's header note on why this is the only order that
// avoids both (a) a `map`-triggered CL_Disconnect wiping a seat count
// requested before the first map, and (b) the crash from requesting more
// seats than an already-active server has room for.
// 26550/26551: family V's own port range (26500-26599, unclaimed in
// .orch/briefs/E2E-COMMON.md's table), offset from v_seats.ts's own ports so
// a parallel run of both never collides.
const port = 26550 + (tree === "rerelease" ? 1 : 0);
boot(tree, vidArg, ["-listen", "2", "-port", String(port)]);
frames(5);

if (activeIsGL() !== (vidArg === "gl")) {
  console.log(`ABORT: asked for ${vidArg}, got ${activeIsGL() ? "gl" : "soft"} refresh -- no such renderer on this SDL_VIDEODRIVER`);
  process.exit(2);
}

exec("disconnect", 10); // stop the startup demo loop -- cl_splitscreen refuses "during demo playback"
exec("deathmatch 1", 2);

exec(`map ${map}`, 60);
keyState.key_dest = KeydestT.key_game;
check("boot: seat 0 reaches the map as a connected listen-server client", inGame(0), `map=${map}`);

// Seating past 1 crashes the very next rendered frame before the new seat
// finishes connecting -- see test/e2e/v_seats.ts's own isolated repro of
// that defect (src/client/screen.ts's SCR_UpdateScreen has no per-seat
// signon guard). seatUp() works around it (scr_skipupdate) so this driver's
// own scenario -- unrelated to that defect -- can still run.
const su = seatUp(2);
check("cl_splitscreen 2: both seats sign on", !su.crashed && su.connectFrame >= 0, `crashed=${su.crashed} connectFrame=${su.connectFrame} error=${su.error ?? ""}`);
check("SS_SeatCount() reports 2", SS_SeatCount() === 2, `got ${SS_SeatCount()}`);

// A deterministic bind, independent of whatever config.cfg in V_HOME carries
// from a previous run -- see quakedef's own default binds for why this
// cannot be assumed.
Cvar_Set("in_player1_device", "auto");
Cvar_Set("in_player2_device", "auto");
runCmd("bind w +forward");

SDL_InjectFakeGamepadForTests(PAD_SEAT0, "guid-v-seat0", "V seat 0 pad");
SDL_InjectFakeGamepadForTests(PAD_SEAT1, "guid-v-seat1", "V seat 1 pad");

// The rest of this scenario's own frame pumps are wrapped: a plain 2-seat
// frame pump has crashed the software renderer here (`SysError: r_edge:
// active edge list is not terminated`, src/ref_soft/r_edge.ts -- see
// test/e2e/v_seats.ts's own report for the fuller repro and stack), and per
// that file's header note Sys_Error is FATAL (hostShutdown() runs before
// the throw), so this stops touching the engine the moment it happens.
const scenarioResult = guardFrames(() => {
  frames(2);

  const devices = SDL_GamepadDevices();
  const seat0Player = devices.find((d) => d.instanceId === PAD_SEAT0)?.player;
  const seat1Player = devices.find((d) => d.instanceId === PAD_SEAT1)?.player;
  check("plug order gives the first pad to player 1 (seat 0)", seat0Player === 0, `player=${seat0Player}`);
  check("plug order gives the second pad to player 2 (seat 1)", seat1Player === 1, `player=${seat1Player}`);

  const edict0 = seatServerInfo(0).edictIndex;
  const edict1 = seatServerInfo(1).edictIndex;
  check("seat 0's edict index resolved", edict0 > 0, `edictIndex=${edict0}`);
  check("seat 1's edict index resolved", edict1 > 0, `edictIndex=${edict1}`);

  const origin0Before = edictOrigin(edict0);
  const origin1Before = edictOrigin(edict1);

  // ---- controller drives seat 1 only ---------------------------------------

  SDL_SetFakeGamepadStateForTests(PAD_SEAT1, { leftX: 0, leftY: -0.9, rightX: 0, rightY: 0 });
  frames(30);
  SDL_SetFakeGamepadStateForTests(PAD_SEAT1, { leftX: 0, leftY: 0, rightX: 0, rightY: 0 });
  // Settle long enough for ground friction to fully stop the push above --
  // otherwise residual velocity from the shove reads as "moved" once the
  // keyboard section below measures against too-early a baseline.
  frames(30);

  const origin0AfterPad = edictOrigin(edict0);
  const origin1AfterPad = edictOrigin(edict1);

  check("seat 1's pad moved seat 1's player entity", dist3(origin1AfterPad, origin1Before) > 4, `moved ${dist3(origin1AfterPad, origin1Before).toFixed(2)} units`);
  check("seat 1's pad left seat 0's player entity in place", dist3(origin0AfterPad, origin0Before) < 1, `seat 0 moved ${dist3(origin0AfterPad, origin0Before).toFixed(2)} units`);

  // seat 1's pad also latches attack/jump onto that seat's own buttons, and
  // nowhere else (SS_SeatButtons(0) is always 0 -- seat 0's buttons come from
  // the bind system's kbuttons, never this table; see splitscreen.ts).
  SDL_SetFakeGamepadStateForTests(PAD_SEAT1, { rightTrigger: 1, heldButtons: 1 << SDL_BUTTON_A });
  frames(1);
  check("seat 1's pad sets seat 1's own attack|jump bits", SS_SeatButtons(1) === 3, `SS_SeatButtons(1)=${SS_SeatButtons(1)}`);
  check("seat 1's pad does not touch seat 0's button table", SS_SeatButtons(0) === 0, `SS_SeatButtons(0)=${SS_SeatButtons(0)}`);
  SDL_SetFakeGamepadStateForTests(PAD_SEAT1, { rightTrigger: 0, heldButtons: 0 });
  frames(1);

  // ---- keyboard drives seat 0 only ------------------------------------------

  sdlKeyDown(SDLK.w, 30);
  sdlKeyUp(SDLK.w, 2);

  const origin0AfterKey = edictOrigin(edict0);
  const origin1AfterKey = edictOrigin(edict1);

  check("the keyboard ('w'/+forward) moved seat 0's player entity", dist3(origin0AfterKey, origin0AfterPad) > 4, `moved ${dist3(origin0AfterKey, origin0AfterPad).toFixed(2)} units`);
  check("the keyboard left seat 1's player entity in place", dist3(origin1AfterKey, origin1AfterPad) < 1, `seat 1 moved ${dist3(origin1AfterKey, origin1AfterPad).toFixed(2)} units`);
});
check(
  "DEFECT if red: this scenario's frame pumps do not crash rendering (src/ref_soft/r_edge.ts \"active edge list is not terminated\" -- see test/e2e/v_seats.ts's own report)",
  !scenarioResult.crashed,
  scenarioResult.error ?? "",
);

// ---- teardown ---------------------------------------------------------------

SDL_RemoveFakeGamepadForTests(PAD_SEAT0);
SDL_RemoveFakeGamepadForTests(PAD_SEAT1);
if (!scenarioResult.crashed) {
  runCmd("cl_splitscreen 1");
  frames(10);
}

const failures = summary(`v_input --tree ${tree} --vid ${vidArg}`);
process.exit(failures === 0 ? 0 : 1);
