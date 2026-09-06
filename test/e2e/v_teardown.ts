/*
Driver 3/3 for family V (src/client/splitscreen.ts, U43): seat teardown and
what survives a level change.

  1. `cl_splitscreen 1` from a 3-seat session drops the extra seats: the
     server's own bookkeeping (svs.clients[i].active -- SV_DropClient's "the
     body stays around" comment means the edict itself is never freed, so
     `.active` is the only correct signal) and the scoreboard seat 0's own
     client parses (cl.scores) both drop from 3 entries to 1.
  2. Re-seating to 3 afterwards works (proves the drop did not wedge the seat
     table).
  3. A `map` change with seats active is expected to KEEP the seat count --
     see this file's own note below on what the driver actually observes.

Usage:
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/v_teardown.ts [--tree classic|rerelease] [--vid soft|gl]

The mechanics under test (SS_SetSeats/SS_DropSeat/CL_Disconnect) are
content-independent, so this runs once against classic dm4/dm2 by default; a
--tree rerelease run (ctf1/ctf2) is available for completeness but not
required by the manifest.

Env: Q1TS_DATA (required), Q1TS_SCRATCH / V_HOME (see test/e2e/v_lib.ts).
*/
import { boot, activeIsGL, frames, exec, runCmd, inGame, waitInGame, seatUp, seatServerInfo, scoreboardNames, check, summary, keyState, KeydestT, SS_SeatCount, type TreeT, type VidT, defaultMap } from "./v_lib";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const tree = (argValue("--tree", "classic") === "rerelease" ? "rerelease" : "classic") as TreeT;
const vidArg = (argValue("--vid", "soft") === "gl" ? "gl" : "soft") as VidT;
const map1 = defaultMap(tree);
const map2 = tree === "classic" ? "dm2" : "ctf2";

console.log(`=== v_teardown: tree=${tree}, maps=${map1}->${map2}, vid=${vidArg} ===`);

// `-listen 3` pre-sizes svs.maxclients/svs.clients for 3 players at boot --
// see test/e2e/v_seats.ts's header note (a `map`-triggered CL_Disconnect
// wipes a seat count requested before the first map, and asking for more
// seats than an already-active server has room for crashes the engine).
// 26560/26561: family V's own port range (26500-26599, unclaimed in
// .orch/briefs/E2E-COMMON.md's table), offset from v_seats.ts/v_input.ts's
// own ports so a parallel run of all three never collides.
const port = 26560 + (tree === "rerelease" ? 1 : 0);
boot(tree, vidArg, ["-listen", "3", "-port", String(port)]);
frames(5);

if (activeIsGL() !== (vidArg === "gl")) {
  console.log(`ABORT: asked for ${vidArg}, got ${activeIsGL() ? "gl" : "soft"} refresh -- no such renderer on this SDL_VIDEODRIVER`);
  process.exit(2);
}

exec("disconnect", 10); // stop the startup demo loop -- cl_splitscreen refuses "during demo playback"
exec("deathmatch 1", 2);

exec(`map ${map1}`, 60);
keyState.key_dest = KeydestT.key_game;
check("boot: seat 0 reaches the map as a connected listen-server client", inGame(0), `map=${map1}`);

// ---- seat 3, confirm all 3 are up ------------------------------------------
//
// seatUp() (not a raw runCmd + frame pump) -- see test/e2e/v_seats.ts's own
// isolated repro of why: SCR_UpdateScreen has no per-seat signon guard and
// crashes rendering before a newly-wanted seat finishes connecting, even
// against a server (this one, via `-listen 3`) already correctly sized.

const su1 = seatUp(3);
check("cl_splitscreen 3: all three seats sign on", !su1.crashed && su1.connectFrame >= 0, `crashed=${su1.crashed} connectFrame=${su1.connectFrame} error=${su1.error ?? ""}`);
frames(15); // let the sign-on broadcast (svc_updatename etc.) reach seat 0's own scoreboard

const before = [0, 1, 2].map((i) => seatServerInfo(i));
check("before teardown: all 3 seats are active server-side", before.every((b) => b.active), JSON.stringify(before.map((b) => b.active)));
const scoresBefore = scoreboardNames(0);
check("before teardown: seat 0's scoreboard lists 3 players", scoresBefore.length === 3, `scores=${JSON.stringify(scoresBefore)}`);

// ---- cl_splitscreen 1: the extra seats leave the server --------------------

runCmd("cl_splitscreen 1");
check("cl_splitscreen 1: SS_SeatCount() drops immediately", SS_SeatCount() === 1, `got ${SS_SeatCount()}`);
frames(20); // the disconnect is a real clc_disconnect over loopback -- give the server a few frames to process it

const after = [0, 1, 2].map((i) => seatServerInfo(i));
check("after teardown: seat 0 is still active server-side", after[0].active, JSON.stringify(after[0]));
check("after teardown: seat 1 is no longer active server-side", after[1].active === false, JSON.stringify(after[1]));
check("after teardown: seat 2 is no longer active server-side", after[2].active === false, JSON.stringify(after[2]));

const scoresAfter = scoreboardNames(0);
check("after teardown: seat 0's scoreboard lists only 1 player", scoresAfter.length === 1, `scores=${JSON.stringify(scoresAfter)}`);

// ---- re-seating still works -------------------------------------------------

const su2 = seatUp(3);
check("re-seating to 3 after a drop works", !su2.crashed && su2.connectFrame >= 0 && SS_SeatCount() === 3, `crashed=${su2.crashed} connectFrame=${su2.connectFrame} SS_SeatCount()=${SS_SeatCount()}`);
frames(15);

// ---- a map change with seats active is expected to KEEP the seat count ----
//
// .orch/briefs/E6-splitscreen.md's own scenario. What this driver observes:
// `map <level>` (Host_Map_f, src/common/host_cmd.ts) calls
// `hostClientHooks.clDisconnect?.()` -- CL_Disconnect -- BEFORE SV_SpawnServer,
// and CL_Disconnect (src/client/cl_main.ts:294) calls SS_Shutdown() whenever
// `SS_IsPrimary() && SS_SeatCount() > 1`, which drops every seat past 0 and
// resets SS_SeatCount() to 1. Only seat 0 is then reconnected (Host_Map_f's
// own `Cmd_ExecuteString("connect local", ...)`), and nothing re-seats 1/2
// afterwards. If that is still true when this runs, the assertion below is
// the recorded defect -- see this file's report entry, not a driver bug: the
// check is left asserting the behaviour the brief specifies (red until
// fixed), per .orch/briefs/E2E-COMMON.md's driver contract.
const seatCountBeforeMap = SS_SeatCount();
exec(`map ${map2}`, 60);
keyState.key_dest = KeydestT.key_game;
const reconnectFrame = waitInGame(0, 400);
check(`map ${map2}: seat 0 reconnects to the new level`, reconnectFrame >= 0, reconnectFrame < 0 ? "timed out" : `within ${reconnectFrame} frames`);
frames(15);

check(`map ${map2}: SS_SeatCount() is unchanged by the level change`, SS_SeatCount() === seatCountBeforeMap, `before=${seatCountBeforeMap} after=${SS_SeatCount()}`);

const failures = summary(`v_teardown --tree ${tree} --vid ${vidArg}`);
process.exit(failures === 0 ? 0 : 1);
