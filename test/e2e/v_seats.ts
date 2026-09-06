/*
Driver 1/3 for family V (src/client/splitscreen.ts, U43): seating N players on
one listen server, and everything a seat is supposed to have of its own once
it is up -- a distinct player entity server-side, its own name and colour, its
own non-blank slice of the frame, and its own HUD health.

Usage:
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
    bun test/e2e/v_seats.ts --seats <2|3|4> [--layout auto|side|stacked] [--tree classic|rerelease] [--vid soft|gl]

`--tree classic` (default) boots id1 alone (`-norerelease`) on `dm4`; `--tree
rerelease` boots the re-release's `ctf` pack (`-basedir <Q1TS_DATA>/rerelease
-ctf`) on `ctf1` -- the two maps .orch/briefs/E6-splitscreen.md names. `--vid`
picks the refresh (`-vid_ref`); the manifest runs both against each tree.

IMPORTANT for reading this file's checks: `Sys_Error` in this engine is
FATAL, not a per-frame recoverable event -- it calls `hostShutdown()` (tears
down the renderer, closes connections) before throwing (src/platform/sys.ts's
own `Sys_Error`). A `try`/`catch` here stops the uncaught JS exception from
killing the DRIVER process, but the ENGINE is already gone once one fires:
every check after a caught crash that still tries to touch the engine is
itself another manifestation of that first crash (a follow-on "No renderer is
loaded", say), not an independent finding. This file orders its checks so the
SAFE ones (identity, viewports, layout) run BEFORE the riskiest one (`kill`,
which has crashed rendering here -- see below), and stops attempting further
engine interaction the moment something throws.

Env: Q1TS_DATA (required, see test/e2e/q1data.ts), Q1TS_SCRATCH / V_HOME (see
test/e2e/v_lib.ts).
*/
import {
  boot,
  activeIsGL,
  frames,
  exec,
  runCmd,
  inGame,
  seatUp,
  guardFrames,
  seatHealth,
  seatServerInfo,
  shot,
  decode,
  regionIsLive,
  regionsDiffer,
  check,
  summary,
  keyState,
  KeydestT,
  Cvar_Set,
  type TreeT,
  type VidT,
  defaultMap,
} from "./v_lib";
import { SS_SeatCount, SS_Viewports, SPLIT_LAYOUT_AUTO, SPLIT_LAYOUT_SIDE_BY_SIDE, SPLIT_LAYOUT_STACKED } from "../../src/client/splitscreen";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const seatsArg = Number(argValue("--seats", "2"));
if (![2, 3, 4].includes(seatsArg)) {
  console.log(`v_seats: --seats must be 2, 3 or 4 (got ${argValue("--seats", "2")})`);
  process.exit(2);
}
const N = seatsArg;

const layoutArg = argValue("--layout", "auto");
const LAYOUT_MAP: Record<string, number> = { auto: SPLIT_LAYOUT_AUTO, side: SPLIT_LAYOUT_SIDE_BY_SIDE, stacked: SPLIT_LAYOUT_STACKED };
const layoutValue = LAYOUT_MAP[layoutArg];
if (layoutValue === undefined) {
  console.log(`v_seats: --layout must be auto, side or stacked (got ${layoutArg})`);
  process.exit(2);
}

const tree = (argValue("--tree", "classic") === "rerelease" ? "rerelease" : "classic") as TreeT;
const vidArg = (argValue("--vid", "soft") === "gl" ? "gl" : "soft") as VidT;
const map = defaultMap(tree);

console.log(`=== v_seats: ${N} seats, layout=${layoutArg}, tree=${tree}, map=${map}, vid=${vidArg} ===`);

// `-listen N` (src/common/host.ts's Host_FindMaxClients, read once at boot)
// pre-sizes svs.maxclients/svs.clients for N players before ANY map spawns,
// which is the only order that avoids the SS_WidenServer defect this file
// repros at the end (`cl_splitscreen N` requested before the first map is
// also wiped back to 1 by that map's own CL_Disconnect -- see
// test/e2e/v_teardown.ts's "map change" note -- so pre-sizing at boot is the
// only order left that reaches a working multi-seat session at all).
// Family V is not in .orch/briefs/E2E-COMMON.md's port table (a newer
// family); 26500-26599 is not claimed by any listed family there. Derived
// from the args rather than fixed, so the manifest's several v_seats
// invocations (different --seats/--tree/--vid) never collide with each
// other or with a concurrent worker's driver when run in parallel.
const port = 26500 + N + (tree === "rerelease" ? 10 : 0) + (vidArg === "gl" ? 20 : 0);
// `-listen N` exactly (not padded) -- see this file's own report entry on a
// SIXTH defect this deliberately exposes at N=3/4: NET_Init
// (src/common/net_main.ts) sizes the loopback qsocket pool as
// `svs.maxclientslimit() + 1` -- one server-side socket per player slot plus
// ONE extra, correct for a pre-splitscreen process (exactly one client). A
// splitscreen seat needs TWO qsockets each (net_loop.ts's own U43 header: a
// client-side AND a server-side socket per seat, now a table of pairs
// instead of WinQuake's one pair) -- N seats need 2N sockets, but the pool
// only ever has maxclientslimit+1. At N=3 (Host_FindMaxClients floors
// maxclientslimit to 4, giving a 5-socket pool) the 3rd seat's connect is
// the 6th socket request and fails: `Loop_Connect: no qsocket available`,
// then `Host_Error: CL_Connect: connect failed` -- which does not just fail
// that ONE seat, it disconnects seat 0 too ("Client Buzzkill removed",
// "CL_SendMove: lost server connection"), tearing down the whole session
// over one seat's connect failure. Padding `-listen` well past N would hide
// this (and would also raise svs.maxclients past MAX_SEATS, which would
// mask this file's separate SS_WidenServer repro at the end), so N=3 and
// N=4 runs are EXPECTED to fail seating from here on, for this reason.
boot(tree, vidArg, ["-listen", String(N), "-port", String(port)]);
frames(5);

if (activeIsGL() !== (vidArg === "gl")) {
  console.log(`ABORT: asked for ${vidArg}, got ${activeIsGL() ? "gl" : "soft"} refresh -- no such renderer on this SDL_VIDEODRIVER`);
  process.exit(2);
}

exec("disconnect", 10); // stop the startup demo loop -- cl_splitscreen refuses "during demo playback"
Cvar_Set("cl_splitscreen_layout", String(layoutValue));
exec("deathmatch 1", 2); // Host_FindMaxClients already set this for -listen N > 1; explicit for clarity

exec(`map ${map}`, 60);
keyState.key_dest = KeydestT.key_game;
check("boot: seat 0 reaches the map as a connected listen-server client", inGame(0), `map=${map}`);

// seatUp() works around TWO defects just to get a seat connected at all --
// see test/e2e/v_lib.ts's own comments on both, and this file's isolated,
// unmodified repro of one of them at the very end:
//   1. SCR_UpdateScreen (src/client/screen.ts) has no per-seat signon guard
//      and crashes rendering before a newly-wanted seat finishes connecting.
//   2. makeSeat() (src/client/splitscreen.ts) never allocates a new seat's
//      ClientStaticT.message buffer, crashing on that seat's first reliable
//      send otherwise.
const su = seatUp(N);
check(`cl_splitscreen ${N}: all seats connect`, !su.crashed, su.error ?? "");
check(`all ${N} seats sign on`, su.connectFrame >= 0, su.connectFrame < 0 ? "timed out waiting for signon" : `signed on within ${su.connectFrame} frames`);
check("SS_SeatCount() reports the requested count", SS_SeatCount() === N, `got ${SS_SeatCount()}`);

// ---- server-side identity: N distinct player entities ---------------------

const infos = Array.from({ length: N }, (_, i) => seatServerInfo(i));
for (let i = 0; i < N; i++) {
  check(`seat ${i}: server marks the client active`, infos[i].active, JSON.stringify(infos[i]));
  check(`seat ${i}: server's player edict has classname "player"`, infos[i].classname === "player", `got "${infos[i].classname}"`);
  check(`seat ${i}: edict's netname matches the client's sign-on name`, infos[i].netname === infos[i].name && infos[i].name.length > 0, `netname="${infos[i].netname}" name="${infos[i].name}"`);
}

const names = new Set(infos.map((i) => i.name));
check("every seat signed on with a distinct name", names.size === N, `names=${JSON.stringify(infos.map((i) => i.name))}`);
const colors = new Set(infos.map((i) => i.colors));
// Under the re-release CTF progs a player's colour IS their team and there
// are two teams, so at most two distinct colours exist; the progs balance any
// third seat onto one of them (F10). Classic deathmatch keeps one per seat.
const distinctColours = tree === "rerelease" ? Math.min(N, 2) : N;
check(`every seat signed on with a distinct colour (${distinctColours} expected)`, colors.size === distinctColours, `colors=${JSON.stringify(infos.map((i) => i.colors))}`);

// ---- viewports: non-blank, and distinct from each other --------------------
//
// Run BEFORE the 'kill' section below, which has crashed rendering here --
// see that section's own note. Everyone is still alive at this point, so
// this is the scenario's best chance to get a clean screenshot.
//
// DEFECT (observed on a classic dm4, 2-seat run, software renderer, no
// death involved at all): a plain frame pump right here threw `SysError:
// r_edge: active edge list is not terminated` (src/ref_soft/r_edge.ts:118,
// via R_RemoveEdges/R_ScanEdges) while rendering one seat's view. As this
// file's header explains, Sys_Error is FATAL here (hostShutdown() runs
// before the throw), so every stage from here on is wrapped and guarded,
// and the pipeline stops touching the engine the moment one of them crashes
// (`engineAlive`).
let engineAlive = true;

const viewportResult = guardFrames(() => {
  exec("clear", 1);
  frames(20);
});
check("DEFECT if red: a plain multi-seat frame pump does not crash rendering (src/ref_soft/r_edge.ts \"active edge list is not terminated\")", !viewportResult.crashed, viewportResult.error ?? "");
engineAlive = engineAlive && !viewportResult.crashed;

if (engineAlive) {
  const shotPath = shot("seats");
  if (shotPath === null) {
    check("screenshot written", false, "no file produced");
  } else {
    const img = decode(shotPath);
    check(`screenshot matches the booted mode (${img.width}x${img.height})`, img.width === 640 && img.height === 480, `got ${img.width}x${img.height}`);
    const rects = SS_Viewports();
    for (let i = 0; i < N; i++) {
      const r = rects[i];
      if (!r) {
        check(`seat ${i}: has a viewport rect`, false, "SS_Viewports() returned too few rects");
        continue;
      }
      check(`seat ${i}: viewport is not blank`, regionIsLive(img, r), JSON.stringify(r));
    }
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const ri = rects[i];
        const rj = rects[j];
        if (!ri || !rj) continue;
        check(`seat ${i} vs seat ${j}: viewports show different content`, regionsDiffer(img, ri, rj), "");
      }
    }
  }
}

// ---- cl_splitscreen_layout is a live preference ----------------------------

if (engineAlive) {
  const layoutResult = guardFrames(() => {
    Cvar_Set("cl_splitscreen_layout", String(SPLIT_LAYOUT_SIDE_BY_SIDE));
    frames(2);
  });
  check("DEFECT if red: switching cl_splitscreen_layout does not crash rendering", !layoutResult.crashed, layoutResult.error ?? "");
  engineAlive = engineAlive && !layoutResult.crashed;

  if (engineAlive) {
    const rectsSide = SS_Viewports();
    Cvar_Set("cl_splitscreen_layout", String(SPLIT_LAYOUT_STACKED));
    frames(2);
    const rectsStacked = SS_Viewports();

    if (N === 2) {
      check("2 seats: side-by-side and stacked layouts produce different rects", JSON.stringify(rectsSide) !== JSON.stringify(rectsStacked), `side=${JSON.stringify(rectsSide)} stacked=${JSON.stringify(rectsStacked)}`);

      Cvar_Set("cl_splitscreen_layout", String(SPLIT_LAYOUT_SIDE_BY_SIDE));
      let sidePath: string | null = null;
      const sideShotResult = guardFrames(() => {
        frames(2);
        exec("clear", 1);
        frames(15);
        sidePath = shot("layout_side");
      });
      check("side-by-side layout: frame pump/screenshot does not crash rendering", !sideShotResult.crashed, sideShotResult.error ?? "");
      if (!sideShotResult.crashed) {
        if (sidePath === null) {
          check("side-by-side layout: screenshot written", false, "no file produced");
        } else {
          const img = decode(sidePath);
          const rects = SS_Viewports();
          for (let i = 0; i < N; i++) {
            const r = rects[i];
            if (r) check(`side-by-side layout: seat ${i}'s viewport is not blank`, regionIsLive(img, r), JSON.stringify(r));
          }
        }
      }
      engineAlive = engineAlive && !sideShotResult.crashed;
    } else {
      // SS_Layout only branches on cl_splitscreen_layout for the 2-seat case
      // (src/client/splitscreen.ts's own doc comment on SS_Layout) -- 3 and 4
      // seats always tile the same way regardless of the cvar. Documented,
      // not a defect: asserted here so a change to that rule shows up as a
      // driver failure instead of silently drifting.
      check(`${N} seats: layout cvar has no effect on the tiling (documented: SS_Layout only branches for 2 seats)`, JSON.stringify(rectsSide) === JSON.stringify(rectsStacked), `side=${JSON.stringify(rectsSide)} stacked=${JSON.stringify(rectsStacked)}`);
    }
  }
}

// ---- damage isolates to one seat's HUD -------------------------------------

if (engineAlive) {
  const healthBefore = Array.from({ length: N }, (_, i) => seatHealth(i));
  const victim = N - 1;
  const killResult = guardFrames(() => {
    runCmd("kill", victim);
    frames(40);
  });
  check(`DEFECT if red: seat ${victim}'s death does not crash rendering (src/ref_soft/r_edge.ts "active edge list is not terminated")`, !killResult.crashed, killResult.error ?? "");
  engineAlive = engineAlive && !killResult.crashed;

  if (engineAlive) {
    const healthAfter = Array.from({ length: N }, (_, i) => seatHealth(i));
    const victimAfter = seatServerInfo(victim);
    // QuakeC's ClientKill respawns the player in the same frame
    // (respawn() -> PutClientInServer), so health reads full again by the
    // time the next frame is observed, in a one-seat game too; the "player
    // N suicides" line appears once per seat because every seat's console
    // shares one buffer (F10). What must hold: the seat stays connected and
    // came back at full health, and no other seat was touched.
    check(
      `seat ${victim}: 'kill' on that seat alone keeps its connection and respawns it at full health`,
      victimAfter.active && healthAfter[victim] === 100,
      `before=${healthBefore[victim]} after=${healthAfter[victim]} victimActive=${victimAfter.active} victimInfo=${JSON.stringify(victimAfter)}`,
    );
    for (let i = 0; i < N; i++) {
      if (i === victim) continue;
      check(`seat ${i}: HUD health is untouched by seat ${victim}'s death`, healthAfter[i] === healthBefore[i], `before=${healthBefore[i]} after=${healthAfter[i]}`);
    }
  }
}

// ---- teardown, back to a clean 1-seat state --------------------------------

if (engineAlive) {
  runCmd("cl_splitscreen 1");
  frames(10);

  // ---- isolated repro 1: SCR_UpdateScreen has no per-seat signon guard ----
  //
  // DEFECT: raising `cl_splitscreen` past 1 crashes the very next rendered
  // frame, even against a server already correctly sized for it (svs.maxclients
  // is still N here, from -listen N above -- no SS_WidenServer involved).
  // src/client/screen.ts's SCR_UpdateScreen, in its `seats > 1` branch, calls
  // V_RenderView() for every seat SS_SeatCount() now reports with no check
  // that the seat has actually finished connecting; a newly-wanted seat's
  // ClientStateT is fresh (splitscreen.ts's `makeSeat`, `cl.worldmodel` still
  // null) until it processes its own signon messages, and R_PushDlights
  // throws `SysError: R_PushDlights: no worldmodel` (src/ref_soft/r_light.ts:125)
  // before that ever happens. A real player typing `cl_splitscreen 2` at the
  // console has no way around this -- run RAW here (no `scr_skipupdate`
  // suppression, unlike this file's own `seatUp()` above) to prove it.
  console.log(`--- isolated repro 1: cl_splitscreen 2 with no scr_skipupdate suppression (server already sized for it) ---`);
  runCmd("cl_splitscreen 2");
  const renderResult = guardFrames(() => frames(5));
  check(
    "DEFECT: cl_splitscreen 2 on a server already sized for it does not crash rendering before the new seat finishes connecting (src/client/screen.ts SCR_UpdateScreen)",
    !renderResult.crashed,
    renderResult.error ?? "(did not crash)",
  );

  // ---- isolated repro 2: cl_splitscreen on an already-active, undersized server
  //
  // DEFECT: `cl_splitscreen <n>` issued once a server is already running and
  // `svs.maxclients < n` prints "this server has %i player slots; %i takes
  // effect on the next map" (src/client/splitscreen.ts's SS_SetSeats) and calls
  // SS_WidenServer, which sets `svs.maxclients`/`svs.maxclientslimit` on the
  // LIVE serverstatic_t with no `sv.active` guard at all. The already-running
  // server's `svs.clients` array (and the edicts behind it) stay sized for the
  // OLD maxclients, so the very next `SV_SendClientMessages` ->
  // `SV_UpdateToReliableMessages` frame walks `svs.clients[i]` up to the NEW
  // maxclients and finds a ClientT whose `.edict` was never allocated:
  //   SysError: SV_UpdateToReliableMessages: client has no edict
  //   at src/server/sv_main.ts:937
  // The console message's own promise ("takes effect on the next map") is not
  // honoured -- nothing defers the mutation, and the server does not survive
  // long enough to reach a next map. Skipped if repro 1 above already
  // crashed (fatal, per this file's header) and only reproducible when
  // N < MAX_SEATS(4): SS_SetSeats clamps its argument to MAX_SEATS, so at
  // N=4 there is no larger seat count left to request that would still
  // exceed svs.maxclients.
  if (!renderResult.crashed && N < 4) {
    const over = N + 1;
    console.log(`--- isolated repro 2: cl_splitscreen ${over} on a server already active with only ${N} slots (svs.maxclients never rose past -listen ${N}) ---`);
    runCmd(`cl_splitscreen ${over}`);
    const widenResult = guardFrames(() => frames(5));
    check(
      `DEFECT: cl_splitscreen ${over} on an already-active server with ${N} slots does not crash the engine (src/client/splitscreen.ts SS_WidenServer / src/server/sv_main.ts:937)`,
      !widenResult.crashed,
      widenResult.error ?? "(did not crash)",
    );
  }
}

const failures = summary(`v_seats --seats ${N} --layout ${layoutArg} --tree ${tree} --vid ${vidArg}`);
process.exit(failures === 0 ? 0 : 1);
