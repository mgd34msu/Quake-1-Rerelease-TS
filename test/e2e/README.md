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

The seven lettered families (A-G) each cover a different corner of the engine,
later letters (H-P) were added as specific areas needed drivers, and Q-Z are the
re-release-era families from `.orch/E2E-PLAN.md`. This file is the map from each
family to its runnable drivers, plus the operational details (env vars, data path,
ports) needed to actually run them.

**One command runs all of them: `scripts/e2e.sh`.** Each family declares its
runnable drivers in `test/e2e/<letter>_manifest.json`; the runner globs those,
runs them in a pool, and prints a pass/fail table. See "Running everything"
below. The per-driver invocations further down are still exactly what the
manifests spell out, and are what to reach for when re-running one by hand.

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

## Running everything: `scripts/e2e.sh`

```
scripts/e2e.sh                          # every driver in every manifest
scripts/e2e.sh --family ab              # only families a and b
scripts/e2e.sh --name 'e_s*' --jobs 1   # one family's drivers, serially
scripts/e2e.sh --needs gl               # only the drivers that want a GL context
scripts/e2e.sh --no-needs long          # drop the soaks
scripts/e2e.sh --list                   # print the selected manifest, run nothing
```

`scripts/e2e.sh` is a thin wrapper (like `scripts/sweep.sh`): it resolves
`Q1TS_DATA`, `Q1TS_SCRATCH`, `Q1TS_HOMEDIR` and `SDL_AUDIODRIVER` and forwards
its arguments to `test/e2e/run_all.ts`, which does the real work — globbing
`test/e2e/*_manifest.json`, filtering, running each driver under
`timeout -k 10 <timeoutSec>` in a `--jobs N` pool (default 2), capturing its
combined stdout+stderr to `$Q1TS_SCRATCH/e2e/logs/<name>.log`, printing the
family/driver/pass/fail/seconds/status table, and writing
`$Q1TS_SCRATCH/e2e/report.json`. It exits non-zero if any driver failed or
timed out.

A driver is PASS only when it exits 0 and printed no `[FAIL]` line.

### What a driver has to print

Every driver is a standalone program that prints one line per assertion and
one final summary line, then exits non-zero if anything failed:

```
[PASS] <name> :: <note>
[FAIL] <name> :: <note>
RESULT <pass> <fail>
```

`RESULT` is authoritative when present; without it the runner counts the
`[PASS]`/`[FAIL]` lines, so a driver killed by `timeout` still reports the
assertions it got through. Each family's `summary()` (`a_lib.ts`, `b_lib.ts`,
`d_lib.ts`, `e_lib.ts`, `g_lib.ts`, `j_lib.ts`, `n_lib.ts`) prints the
`RESULT` line and ends the process with the right status, so a driver that
bails out early cannot fall through to a trailing `process.exit(0)` and
report green.

Assertions are about OBSERVABLE behaviour — a level name on screen, an entity
count, a frag in the scoreboard, a non-blank screenshot with the expected
colours, a cvar value, a console line — never "did not crash".

### Manifest schema

One `<letter>_manifest.json` per family:

```json
{
  "family": "r",
  "drivers": [
    {
      "name": "r_id1_soft",
      "cmd": ["bun", "test/e2e/r_content.ts", "--tree", "id1"],
      "env": { "SDL_VIDEODRIVER": "dummy" },
      "timeoutSec": 300,
      "needs": ["rerelease"],
      "lock": "qwclient"
    }
  ]
}
```

| field | required | meaning |
|---|---|---|
| `name` | yes | unique across every manifest; names the log file |
| `cmd` | yes | argv, run from the repository root |
| `env` | no | added to the runner's own environment for this driver |
| `timeoutSec` | no | default 300; the driver runs under `timeout -k 10 <n>` |
| `needs` | no | `classic`, `rerelease`, `gl`, `qw`, `binary`, `audio`, `long` |
| `lock` | no | two drivers naming the same lock never run at the same time |

`${Q1TS_DATA}`, `${Q1TS_SCRATCH}`, `${Q1TS_HOMEDIR}` and `${Q1TS_BINARY}` are
substituted in every `cmd` element and `env` value.

`lock` is this runner's addition to the schema in `.orch/briefs/E2E-COMMON.md`.
QuakeWorld's client port is the hardcoded `PORT_CLIENT = 27001` in
`src/qw/protocol.ts` with no `-port` override, so only one qwcl can be alive
on the host at a time; every QW-using driver takes `"lock": "qwclient"`.
Families that hand a file from one driver to the next (family B's config.cfg,
family A's save game and recorded demo) use a lock to order them, since the
pool otherwise starts them together.

`needs: ["binary"]` is what makes the runner build the compiled engine once at
`$Q1TS_SCRATCH/e2e/q1rets` and export `Q1TS_BINARY` (standing order 19: a live
gate runs our own compiled binary in both seats). `--build` forces the build
even when nothing selected asks for it; setting `Q1TS_BINARY` to an existing
file uses that instead.

## Where the engine writes

The engine defaults to a per-user home directory for writes (no `-homedir`
means `$XDG_DATA_HOME/q1rets/<game>`, and `com_gamedir` points there), so a
driver must never rebuild a write path by hand out of `Q1TS_DATA` and a
`-game` name. Two rules follow:

- every family's `boot()` passes `-homedir $Q1TS_HOMEDIR`. The runner hands
  each driver `$Q1TS_HOMEDIR/<family>` (the root defaults to
  `$Q1TS_SCRATCH/e2e/home`), so a run never writes into the retail install,
  never inherits the developer's own config.cfg, and one family's archived
  config never leaks into another family's boot;
- the runner also strips `Q1TS_NOHOMEDIR` from every driver's environment.
  It is `COM_DefaultHomeDir`'s `-nohomedir`, and it would send the writes of
  any driver that passes no explicit `-homedir` back into the basedir, i.e.
  into the retail install;
- a driver looking for a file it wrote reads the live `com_gamedir`
  (`a_lib.ts`'s `gamedir()`, `b_lib.ts`'s `gamedir()`, and so on), or takes
  the path out of the engine's own `COM_WriteFile: <path>` console line.

The classic families (a-p) also boot with `-norerelease`: the retail tree
nests the 2021 re-release under `rerelease/` and a plain `-basedir`
auto-detects it, which changes what those families are looking at (a
re-release `mapdb.json` turns the "New Game" menu item into the episode
picker, the progs.dat is a different program, the maps are BSP2). The
re-release families are the new q-z ones.

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

Each family uses its own `-game e2e_<letter>` name (`e2e_a`, `e2e_b`, `e2e_c`,
`e2e_d`/`e2e_d2`, `e2e_g`, ...) so config.cfg, save games, demos and screenshots
from different families never collide — **always pass `-game e2e_<letter>` when
re-running a driver**, or its writes will land in another family's directory.
Family A goes further and gives every driver in its manifest its own `A_GAME`,
because `shot()` clears every `quake*.pcx` in the game directory while looking
for the one it just took. Those directories live under `Q1TS_HOMEDIR`, not
under `Q1TS_DATA` — see "Where the engine writes" above.

Three more variables, all optional:

- **`Q1TS_SCRATCH`** — where drivers put logs, screenshots and throwaway basedirs.
  Defaults to `/tmp/q1ts-tests`.
- **`Q1TS_HOMEDIR`** — what the drivers pass as `-homedir`, i.e. where the engine
  writes. Defaults to `$Q1TS_SCRATCH/e2e/home`; under the runner each driver
  sees `$Q1TS_HOMEDIR/<family>`.
- **`Q1TS_QSRC`** — id's source release, for the drivers and unit suites that read
  `progs106/progs.dat` or `QW/progs/qwprogs.dat` as fixtures. Defaults to
  `../qsrc/quake` relative to the repository.

Family E (QuakeWorld) is the exception to the shared basedir: it runs against an
isolated one under `$Q1TS_SCRATCH/eb`, with `Id1` symlinked back to `$Q1TS_DATA`
and a private writable `qw/` holding a copy of `qwprogs.dat`, so its demos and
screenshots do not collide with the families sharing the main basedir.
`e_lib.ts`'s `ensureBasedir()` builds that tree itself at import — nothing has to
be set up by hand any more — and clears any zero-byte file left under `qw/maps`
(see the defect note below). `o_qwcl_video.ts` builds its own scratch basedir the
same way.

**A zero-byte map file takes the server down.** A failed client download leaves
the file it was going to write behind with no content; `COM_FindFile` then
prefers that empty file over the real map in the pak, and loading it ends the
qwsv process with `Fatal: Out of bounds access`. Reproduce with:

```
: > $Q1TS_SCRATCH/eb/qw/maps/dm2.bsp
$Q1TS_SCRATCH/e2e/q1rets -dedicated -qw -basedir $Q1TS_SCRATCH/eb -port 27699 +map dm2
```

## Ports

Real UDP is used wherever two engine processes talk to each other (families D, E,
parts of G); everything else is single-process or uses the loopback in-process
network path and needs no port at all.

| Family | Port usage |
|---|---|
| A | UDP 26050 for the dedicated-server scenario (`a_dedicated.ts`, driven over stdin, no client connects); every other scenario is single-player / loopback and needs no port |
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

## Families

Every letter that has, or is reserved for, a family of drivers. The classic
families a-p came first; q-z are the re-release-era families added by the
E2E program in `.orch/E2E-PLAN.md`.

| letter | family | manifest |
|---|---|---|
| a | WinQuake client: maps, both renderers, mission packs, gameplay commands, save/load, demos, dedicated server, soak | `a_manifest.json` |
| b | console, menus, bindings/config, video, HUD | `b_manifest.json` |
| c | sound and CD-music audio | `c_manifest.json` |
| d | WinQuake multiplayer: listen server, dedicated server, loopback | `d_manifest.json` |
| e | QuakeWorld: qwsv + qwcl | `e_manifest.json` |
| f | smoke / CLI / environment | no committed driver, see below |
| g | real SDL input: event pump, key table, mouse, modal, window events | `g_manifest.json` |
| h | mouse-capture policy | `h_manifest.json` |
| i | GL `vid_restart` texture-name reuse | `i_manifest.json` |
| j | ambient sound spatialization, intermission/finale | `j_manifest.json` |
| k | GL alias-model lighting | `k_manifest.json` |
| l | window resize, both renderers | `l_manifest.json` |
| m | GL world-surface lighting | `m_manifest.json` |
| n | gameplay-interaction sweep: items, monsters, messages, physics, secrets, shooting, touch | `n_manifest.json` |
| o | qwcl video menu, fullscreen and resize | `o_manifest.json` |
| p | QuakeWorld jump and air control | `p_manifest.json` |
| q | video / platform | E11 |
| r | re-release content | E2 |
| s | save games | E5 |
| t | protocols and the compiled binary | E3 |
| u | bots | E4 |
| v | splitscreen | E6 |
| w | menus / input / controllers | E7 |
| x | demos | E8 |
| y | audio | E9 |
| z | soak | E10 |

## Files that are not manifest drivers

Two kinds of file under `test/e2e/` are deliberately absent from every
manifest.

**Helper processes** — these are spawned BY a driver and hang or do nothing
when run on their own:

| file | what it is |
|---|---|
| `c_harness.ts`, `c_harness_qw.ts` | the engine hosts family C's scenario JSON runs in; `c_run.ts` writes the JSON and spawns them |
| `c_analyzer.ts` | the raw-PCM analyzer `c_run.ts` imports |
| `d_role.ts` | one engine role of a family-D scenario, spawned by `d_lib.ts` |
| `e_c2.ts` | family E's second qwcl, driven over stdin by `e_s46.ts`/`e_s8.ts`/`e_s9.ts`; run alone it waits on stdin forever |
| `g_s4_child.ts` | the child window `g_s4_window.ts` spawns |
| `p_jump_sv.ts` | the instrumented qwsv `p_jump.ts`/`p_bhop.ts` spawn |
| `*_lib.ts`, `q1data.ts` | shared helpers |

**Probes with no assertion** — each one prints diagnostics for a defect that
has since been fixed by design and asserts nothing, so the runner could only
ever report "it exited 0". They are kept for the next investigation of the
same area rather than deleted:

| file | why it is not in a manifest |
|---|---|
| `a_probe_find.ts` | wraps builtin #18 to dump what `find` was passed for defect D1 in `.orch/e2e/A.md`; prints a trace, asserts nothing |
| `b_smoke2.ts` | boots, loads e1m1, screenshots, prints "done"; every assertion it could make is in `b_smoke.ts` and `b_s4_video.ts` |
| `b_repro_find.ts`, `b_repro_find2.ts`, `b_repro_find3.ts` | minimal repros for the same `find` defect; they replay a command sequence and print it |
| `b_repro_chlvl.ts`, `b_repro_chlvl2.ts` | minimal repros for the `changelevel` maxclients crash; `a_gameplay.ts` asserts the fixed behaviour |
| `b_repro_disc.ts` | prints `cls.state` around `disconnect`; `b_s6_misc.ts` asserts it |
| `n_diag.ts`, `n_entdump.ts`, `n_ogre.ts`, `n_probe.ts`, `n_scan.ts` | entity/keys/trigger dumps used while writing the family-N drivers; they print `##N INFO` rows and make no claim |

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
| `a_probe_find.ts` | diagnostic probe for the `find` builtin (defect D1 in `.orch/e2e/A.md`); not in the manifest, see "Files that are not manifest drivers" |

`A_GAME` picks the `-game` directory (default `e2e_a`). Every family-A driver
in the manifest gets its own, because `shot()` clears every `quake*.pcx` in the
game directory while looking for the one it just took — two drivers sharing one
directory steal each other's screenshots. Family B does the same through
`B_GAME`, except for the `lock: "b_config"` chain (`b_s3_bind` →
`b_s3b_quit_console` → `b_s3c_reread` → `b_s3b_quit_menu`), which deliberately
hands one config.cfg from each driver to the next and is serialised instead.

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
Generic JSON-timeline drivers, not per-scenario files: a scenario is argv plus
timed `Cbuf_AddText` injections, described by a JSON file. Those JSON files were
never committed, so `c_run.ts` writes the one it needs into
`$Q1TS_SCRATCH/e2e/c/` per run and a scenario is a name on its command line.

| File | Covers |
|---|---|
| `c_run.ts` | the family's driver: builds a scenario, runs it under `SDL_AUDIODRIVER=disk`, and asserts on the console lines and on the captured PCM |
| `c_harness.ts` | the engine host: drives a real WinQuake client (`Sys_Main_Init`/`runFrames`) against a scenario JSON |
| `c_harness_qw.ts` | same shape, drives the QuakeWorld client instead |
| `c_analyzer.ts` | raw-PCM RMS / silence / dominant-frequency analyzer for the `SDL_AUDIODRIVER=disk` capture file |

Scenarios: `init` (SNDDMA_Init opened a device, `soundinfo` prints its spec),
`commands` (`play`/`stopsound`/`playvol`/`soundlist`/`volume`), `play`,
`playvol`, `ingame` (firing a weapon on e1m1), `demo` (demo playback audio),
`cd` (the `cd` command set on a host with no drive), `qw` (the QuakeWorld
client's own sound path), `soak` (a minute of repeated sounds).

```
bun test/e2e/c_run.ts --scenario play
```

Every scenario starts with one `disconnect`: quake.rc leaves the client inside
`startdemos demo1 demo2 demo3`, and a capture full of the boot demo's own
gunfire proves nothing about the sound the scenario asked for. The first two
0.5s analysis windows still carry that demo's tail, so the quiet-baseline and
audio-appeared judgements are both made from t=1.0s on.

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

`d_lib.ts`'s `spawnRole()` runs a DEDICATED seat as the compiled binary when
`Q1TS_BINARY` is set (standing order 19), delivering its scripted console
lines over the engine's real stdin. A CLIENT seat stays on `d_role.ts`:
`Sys_ConsoleInput` reads stdin only when `cls.state == ca_dedicated` (faithful
to `sys_linux.c`), so there is no channel into a shipped client's console at
all, and `d_role.ts` is the same engine from the same source with a
`Cbuf_AddText` timeline bolted on.

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
| `e_c2.ts` | a second qwcl as its own OS process, driven line-by-line over stdin; a helper, not a manifest driver |
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
(the `<scratchpad>/eb` basedir builds itself — see "Retail data" above)

`e_lib.ts`'s `startServer()` runs the qwsv seat as the compiled binary with
`-dedicated -qw` when `Q1TS_BINARY` is set (standing order 19), and registers
a process-exit hook that kills every server it started: a qwsv that dies on a
Sys_Error does not necessarily release its UDP port, and one orphan holding
27600-27699 makes every later run of the family look like an engine failure.

### F — smoke / CLI / environment (no committed driver, no manifest)
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
