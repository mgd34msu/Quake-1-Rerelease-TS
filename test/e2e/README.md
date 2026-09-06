# test/e2e — manual end-to-end drivers

Everything under `test/e2e/` runs a real build of the engine (WinQuake `src/main.ts`,
QuakeWorld `src/qw/main_cl.ts` / `src/qw/main_sv.ts`) against real retail game data,
through the actual SDL/UDP/filesystem backends. **These are not `bun test` suites.**

`bun test` only picks up files matching `*.test.ts`, `*_test.ts` or `*.spec.ts`
(confirmed: `bun test test/e2e/` reports "did not match any test files" against this
tree). None of the harness files below use that naming, and none should be renamed to
match it — a plain `bun test` run must never spawn a live SDL/UDP engine process.
Each file is invoked directly with `bun test/e2e/<file>.ts [args...]` as its own
process (see "How to run" below).

The seven lettered families (A-G) each cover a different corner of the engine, and
later letters (H-P) were added as specific areas needed drivers. This file is the map
from each family to its runnable drivers, plus the operational details (env vars, data
path, ports) needed to actually run them.

References below to `.orch/e2e/<LETTER>.md` are the per-family narrative reports —
defects found, repro steps, log excerpts — written while the port was being built.
Those are development notes and are not part of the published repository; the drivers
themselves and this file are self-contained.

## Headless recipe

Every driver runs with no window and no real audio device:

```
Q1TS_DATA=/path/to/quake SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/<file>.ts
```

- `SDL_VIDEODRIVER=dummy` — software renderer (`-vid_ref soft`, the default).
- `SDL_VIDEODRIVER=offscreen` — real GL context, no window (`-vid_ref gl`); used by
  every family's GL-renderer scenario.
- `SDL_AUDIODRIVER=dummy` — silently discards audio; used everywhere except family C's
  audio-capture scenarios.
- `SDL_AUDIODRIVER=disk` — writes raw PCM to a capture file on disk instead of a
  device; family C's `c_harness.ts`/`c_harness_qw.ts` need this to get audio evidence
  (see `.orch/e2e/C.md` "How the audio was captured" for the capture-file mechanics and
  this host's sdl2-compat quirk).
- Always pass `-nosound` on the engine command line too, except in family C's sound
  scenarios (which need sound enabled to have anything to capture).

`Q1TS_DATA` is required by every driver (see "Retail data" below). The per-family
"How to run" examples further down omit it for brevity and assume it is already
exported.

## Retail data

Every driver reads its base directory from one environment variable, **`Q1TS_DATA`**.
There is no default and no fallback: `test/e2e/q1data.ts` throws at import if the
variable is unset, because a wrong basedir shows up as a screenshot of the wrong level
half an hour into a run.

```
export Q1TS_DATA=/path/to/quake
```

That directory is what the engine is handed as `-basedir`. It needs `id1/pak0.pak`
(mixed case is fine — `Sys_ResolveCase` resolves id's shipped `Id1/PAK0.PAK` +
`Id1/PAK1.PAK` as-is), plus `hipnotic/` and `rogue/` for the mission-pack drivers and
`qw/qwprogs.dat` for the QuakeWorld ones. Registered data is required: every family
confirms "Playing registered version" in its boot log. A symlink tree over a read-only
install works and is what the original runs used.

Each family uses its own `-game e2e_<letter>` subdirectory (`e2e_a`, `e2e_b`, `e2e_c`,
`e2e_d`/`e2e_d2`, `e2e_g`, ...) under it so config.cfg, save games, demos and
screenshots from different families never collide — **always pass `-game e2e_<letter>`
when re-running a driver**, or its writes will land in another family's directory (or
the basedir's root).

Two more variables, both optional:

- **`Q1TS_SCRATCH`** — where drivers put logs, screenshots and throwaway basedirs.
  Defaults to `/tmp/q1ts-tests`.
- **`Q1TS_QSRC`** — id's source release, for the drivers and unit suites that read
  `progs106/progs.dat` or `QW/progs/qwprogs.dat` as fixtures. Defaults to
  `../qsrc/quake` relative to the repository.

Family E (QuakeWorld) is the exception to the shared basedir: it builds an isolated one
under `$Q1TS_SCRATCH/eb`, with `Id1` symlinked back to `$Q1TS_DATA` and a private
writable `qw/` holding a copy of `qwprogs.dat`, so its demos and screenshots do not
collide with the families sharing the main basedir. That directory is not created for
you — make it (symlink `Id1`, copy `qw/qwprogs.dat`) before running any `e_*.ts`
driver, or point `e_lib.ts`'s `BASEDIR` at an isolated basedir of your own.
`o_qwcl_video.ts` does the same thing and builds its scratch basedir itself.

## Ports

Real UDP is used wherever two engine processes talk to each other (families D, E,
parts of G); everything else is single-process or uses the loopback in-process
network path and needs no port at all.

| Family | Port usage |
|---|---|
| A | None (single-player / loopback only; dedicated-server scenario driven over stdin, no client connects) |
| B | None (single in-process client; the "Join a game" menu path is exercised but never actually connects) |
| C | Default WinQuake port for the in-game sound scenario; QuakeWorld's client port is **not** configurable (`PORT_CLIENT = 27001` is a hardcoded constant in `src/qw/protocol.ts`, no `-port` override exists) — only one `qwcl` process can be alive system-wide at a time, so C's QW scenario and any of E's/G's qwcl runs will collide if run concurrently |
| D | UDP 26100-26199 (two WinQuake processes per scenario, `-port <n>` / `-port <n+1>`) |
| E | UDP 27600-27699 for `qwsv -port <n>`; the qwcl side is in-process (no port of its own) except `e_c2.ts`'s second, subprocess qwcl, which is also bound by the 27001 constant above |
| F | Ad hoc, one-off (no committed driver — see "Family F" below) |
| G | One `qwsv` on 27842 for its SDL/QuakeWorld scenario; also gated on the 27001 `PORT_CLIENT` constant being free |

**NetQuake vs QuakeWorld `connect` syntax differs and both directions have bitten this
suite:**
- **NetQuake** (WinQuake `+connect`/`connect`): the command takes a **host only**.
  WinQuake's `COM_Parse` makes `:` its own token, so `connect 127.0.0.1:26101` reaches
  `Host_Connect_f` as the bare string `127.0.0.1` — the port is silently dropped, not
  parsed. `net_main.c`'s `NET_StringToAdr` falls back to the connecting process's own
  `net_hostport` (its `-port` parm) whenever the address string has no `:port` suffix.
  So a NetQuake client harness must pass `-port <serverport>` (the *listening* side's
  port, not its own) and `+connect 127.0.0.1` with no port suffix — see `d_s1.ts` for
  the corrected form. Two colon-suffixed `+connect` invocations elsewhere in this
  family's earlier draft were found and fixed the same way.
- **QuakeWorld** (`qwcl` / `main_cl.ts`): `connect host:port` is correct and required —
  QW's protocol expects the port in the string; every `e_*.ts`/`g_s5_qw.ts` driver
  already uses this form and needs no change.

## Family summaries

Full detail, defects, and log excerpts for each family are in `.orch/e2e/<LETTER>.md`.

### A — WinQuake client, both renderers, mission packs, demos, dedicated
Base id1 maps and hipnotic/rogue maps on both renderers, gameplay commands
(`kill`/`restart`/`changelevel`/`skill`/`deathmatch`/`coop`), save/load, demos
(`playdemo`/`timedemo`/`record`/`playback`), a stdin-driven dedicated server, and a
3-minute stability soak.

| File | Covers |
|---|---|
| `a_lib.ts` | boot / frame-pump / screenshot helpers shared by the rest of the family |
| `a_maps.ts` | every base map, both renderers (`--vid gl` for GL) |
| `a_gameplay.ts` | gameplay command set on a clean map and on `e1m1` |
| `a_saveload.ts` | save, then load in a fresh process vs. in-process |
| `a_demos.ts` | playdemo / timedemo / record / playback / loop |
| `a_mpfeat.ts` | rogue/hipnotic progs features (`give all`, `impulse 9`, weapons) |
| `a_dedicated.ts` | dedicated server driven over stdin (no CLI args; edit the constants at the top to point elsewhere) |
| `a_stability.ts` | long-running live-play soak |
| `a_probe_find.ts` | diagnostic probe for the `find` builtin (defect D1 in `.orch/e2e/A.md`) |

How to run, e.g.:
```
SDL_VIDEODRIVER=dummy  SDL_AUDIODRIVER=dummy bun test/e2e/a_maps.ts --out <dir> --settle 100
SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/a_maps.ts --vid gl --out <dir> --settle 100
bun test/e2e/a_gameplay.ts --out <dir> --map dm1
bun test/e2e/a_gameplay.ts --out <dir> --map e1m1 --nokill
bun test/e2e/a_saveload.ts --mode write   # then --mode fresh
bun test/e2e/a_demos.ts --mode play|timedemo|record|playrec|loop
bun test/e2e/a_dedicated.ts
bun test/e2e/a_stability.ts --map e1m1 --seconds 180
```

### B — console, menus, bindings/config, video, HUD
Single in-process WinQuake client throughout (no second process, no real UDP).

| File | Covers |
|---|---|
| `b_lib.ts` | boot/frames/exec/key/type helpers, console-buffer reader, `shot()` screenshot capture |
| `b_s1_console.ts` | console: toggle, typing, TAB completion, history, PGUP/PGDN, `clear`, messagemode |
| `b_s2_menu.ts` | every menu screen and transition (main, singleplayer, multiplayer, options, keys, video, help, quit) |
| `b_s3_bind.ts` | bindings, aliases, cvars |
| `b_s3b_quit.ts` | `quit` from the console (writes config.cfg) vs. `quit` in-game (quit menu); takes an optional mode arg (`bun test/e2e/b_s3b_quit.ts menu`) |
| `b_s3c_reread.ts` | relaunch and re-read `config.cfg` |
| `b_s3d_look.ts` | keyboard look, centerview, mouse seam |
| `b_s4_video.ts` | generic driver: `bun test/e2e/b_s4_video.ts <shotname> [engine args] -- [console cmds]`, with `SHOT:<name>` / `WAIT:<n>` pseudo-commands |
| `b_s5_hud.ts` | statusbar / HUD |
| `b_s6_misc.ts` | stuffcmds, playdemo, timedemo, demos |
| `b_repro_find*.ts`, `b_repro_chlvl*.ts`, `b_repro_disc.ts`, `b_smoke*.ts` | minimal standalone repros for specific defects, see `.orch/e2e/B.md` |

How to run, e.g.:
```
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/b_s1_console.ts
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/b_s2_menu.ts
bun test/e2e/b_s3b_quit.ts          # console quit
bun test/e2e/b_s3b_quit.ts menu     # in-game quit menu
```

### C — sound and CD-music audio
Generic JSON-timeline drivers, not per-scenario files: scenario configs (argv +
timed `Cbuf_AddText` injections) are JSON, written to the scratchpad, not committed —
see `.orch/e2e/C.md` for the exact JSON shape and the scenarios it covers (sound init,
`play`/`playvol`/`stopsound`/`soundlist`/`volume`, in-game weapon/movement sound,
demo audio, CD music, QuakeWorld client sound, a sound-stress soak).

| File | Covers |
|---|---|
| `c_harness.ts` | drives a real WinQuake client (`Sys_Main_Init`/`runFrames`) against a scenario JSON: `bun test/e2e/c_harness.ts <scenario.json>` |
| `c_harness_qw.ts` | same shape, drives the QuakeWorld client instead |
| `c_analyzer.ts` | raw-PCM RMS / silence / dominant-frequency analyzer for the `SDL_AUDIODRIVER=disk` capture file |

How to run: write a scenario JSON per `.orch/e2e/C.md`'s format, then
```
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=disk bun test/e2e/c_harness.ts <scenario.json> > <log>
bun test/e2e/c_analyzer.ts <capture-file>
```

### D — WinQuake multiplayer (listen server / dedicated / loopback)
Two real OS processes (`Bun.spawn`, one engine each) talking real UDP over
127.0.0.1, using the 26100-26199 port band.

| File | Covers |
|---|---|
| `d_lib.ts` | spawn/log/console helpers shared by the family |
| `d_role.ts` | per-process engine driver (one role = one `Bun.spawn`'d engine with a scripted command timeline) |
| `d_s1.ts` | scenario 1 — listen server (role A hosts + role B connects) |
| `d_s2.ts` | scenario 2 — dedicated server, console-only (no connecting clients) |
| `d_s5.ts` | scenario 5 — loopback single-player (`+map dm1`, no `-listen`; unaffected by the real-UDP-connect defect since it never opens a socket) |

Scenarios 3/4/6/7 in `.orch/e2e/D.md` were exercised with ad hoc scripts, not
committed files, once they hit the same blocking defect as S1 (see that report).

How to run:
```
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/d_s1.ts
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/d_s2.ts
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/d_s5.ts
```

### E — QuakeWorld (qwsv + qwcl)
Real `qwsv` subprocess (`bun src/qw/main_sv.ts -basedir <B> -port <P> +map <M>`) plus
an in-process qwcl (`Sys_Main_Init`/`runFrames` from `src/qw/main_cl.ts`), real UDP,
ports in the 27600-27699 band. `e_c2.ts` and `e_s46.ts`/`e_s8.ts`/`e_s9.ts` add a
second, subprocess qwcl for multi-client scenarios (bound by the fixed
`PORT_CLIENT = 27001` constant — see "Ports" above).

| File | Covers |
|---|---|
| `e_lib.ts` | shared helpers: in-process qwcl boot/pump/console reader, qwsv subprocess + stdin console, screenshot capture |
| `e_c2.ts` | a second qwcl as its own OS process, driven line-by-line over stdin |
| `e_s0.ts` | smoke: server boots, client connects, screenshot |
| `e_s1.ts` | scenario 1, qwsv console commands |
| `e_s1b.ts`, `e_s1c.ts` | scenario-1 diagnostics |
| `e_s2.ts`, `e_s2b.ts` | scenario 2, qwcl commands and cvars |
| `e_s3.ts` | scenario 3, movement / prediction / firing |
| `e_s46.ts` | scenarios 4 and 6, spectator mode and two real clients |
| `e_s5.ts` | scenario 5, demos |
| `e_s7.ts` | scenario 7, every map with a client following |
| `e_s8.ts` | scenario 8, robustness |
| `e_s9.ts` | scenario 9, the 3-minute run |

How to run, e.g.:
```
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/e_s0.ts
SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy bun test/e2e/e_s7.ts   # includes a GL check
```
(recreate the `<scratchpad>/eb` basedir first — see "Retail data" above)

### F — smoke / CLI / environment (no committed driver)
`.orch/e2e/F.md` covers building all three binaries, banner/exit-code checks,
basedir variants (mixed-case, trailing slash, relative, `-game`), `-hipnotic`/
`-rogue`, missing-basedir fallback, `-port`, `-condebug`, `-nostdout`/`-noconinput`/
`-mem`/`-safe`, unknown flags, quoted `+exec`/`+echo`, minimal/hostile environments,
and signal handling (`SIGINT`/`SIGTERM`) on the dedicated server. All of it was run
against private scratch binaries built and deleted outside the repo, or as ad hoc
one-line invocations — **no `f_*.ts` file exists under `test/e2e/`**. Re-running any
of it means reconstructing the invocation from `.orch/e2e/F.md`'s per-scenario
"Reproduce" lines; there is nothing here to `bun test/e2e/f_....ts`.

### G — real SDL input (event pump, key table, mouse, modal, window events)
Owned and maintained by a different concurrent agent (`src/platform/sdl.ts`,
`src/client/input.ts`, `src/qw/client/cl_input.ts`, `test/sdl_input.test.ts`,
`test/e2e/g_*.ts`) — listed here only so the family index is complete; do not edit
those files from this README's owning agent. See `.orch/e2e/G.md` for its own
keyboard/mouse/modal/window/QuakeWorld scenarios (`g_s1_keyboard.ts` through
`g_s5_qw.ts`), its `asDest()`/`asBool()` TypeScript-narrowing launder helpers in
`g_lib.ts`, and its `qwsv -port 27842` scenario.

**Mouse capture policy (affects `b_s3d_look.ts` and `g_s2_mouse.ts`/`g_s2b_nomouse.ts`/
`g_s4_window.ts`/`g_s5_qw.ts`):** `src/platform/sdl.ts`'s `wantMouseCapture` now grabs the
mouse whenever the window is focused and either fullscreen or `key_dest === key_game`, and
releases it for the console, a menu, chat entry, or lost focus. `_windowed_mouse` stays
registered (default now `"1"`) purely for config-file round-tripping and no longer gates
capture at all — the harness files above assert on `key_dest`/focus/fullscreen instead of
setting the cvar to predict the outcome. `-nomouse` is unaffected: it still disables the
mouse outright by leaving `mouse_avail` false, which short-circuits `IN_Commands` before
`wantMouseCapture` is ever reached.

### P — QuakeWorld jump and air control (`p_*.ts`)
Instrumented qwsv plus one in-process qwcl, for the "I press jump, hear the jump
sound, but do not jump" report and for bunny-hop feel. Ports 27700-27799.

| File | Covers |
|---|---|
| `p_jump_sv.ts` | the qwsv the two drivers spawn: real `src/qw/main_sv.ts` with call-through `spyOn` wrappers on `src/qw/pmove.ts`'s `PlayerMove` and `src/qw/server/sv_send.ts`'s `SV_StartSound`, appending one JSON record per client command to the file named by `-jumplog` |
| `p_jump.ts` | repeated jump cycles while walking and turning; counts commands where QC `PlayerJump`'s `player/plyrjmp8.wav` played but `pmove.c` `JumpButton` added no +270, and prints which of `JumpButton`'s branches bailed |
| `p_bhop.ts` | scripted strafe-jump; reports per-hop apex speed and the usercmd `msec` distribution |

```
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy P_PORT=27761 P_SLEEP=5 \
  bun test/e2e/p_jump.ts dm3 200 settle
```
`p_jump.ts` takes `[map] [jumps] [mode]`; the modes are `settle` (one press per
landing), `spam` (tapped every third frame) and `hold` (pressed in mid-air and
kept down across the landing). `P_SLEEP` is the wall-clock ms between client
frames (5 runs the client faster than real time, 13 matches it) and `P_JITTER`
adds random seconds to each frame time, which is what pushes `cmd->msec` up
towards the 50 ms mark where `SV_RunCmd` splits a command in half.

Each record carries `cmd.buttons`, `pmove.oldbuttons` before and after,
`PM_CatagorizePosition`'s `onground`/`waterlevel`/`watertype`, the gap from
`pmove.origin[2]` down to whatever is under the player, `sv_player->v.flags`
(so QC `FL_ONGROUND`/`FL_JUMPRELEASED` can be read), `button0`/`button2`,
`health`, and `velocity` before and after. The probe reproduces `PlayerMove`'s
own prefix (`NudgePosition` then `PM_CatagorizePosition`) on a snapshot and
restores it, so the numbers are exactly the ones `JumpButton` is about to see.

The `p_bhop.ts` speed column is only meaningful in an open area — a scripted
bot hits geometry within a few hops on every retail map. The deterministic
air-control measurement lives in `test/qw_pmove.test.ts` instead, on the
synthetic infinite floor from `test/support/bsp_builder.ts`.
