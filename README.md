# Quake 1 Re-release TS

A TypeScript engine for the 2021 Quake re-release, running on
[Bun](https://bun.sh): one engine that plays the classic game, both
mission packs, and every re-release campaign (Dimension of the Past,
Dimension of the Machine, Dawn of the Machine, the re-release CTF) with
any content under any ruleset, over NetQuake protocols 15/666/999 and
QuakeWorld 28 (plus this engine's own wide QuakeWorld extension,
protocol 29), with both a software and an OpenGL renderer. It builds to
one binary, `q1rets`: NetQuake and QuakeWorld, client and dedicated
server, are chosen per connection and per command line, not by which
executable you launched.

Seeded from the faithful [Quake-1-TS](https://github.com/mgd34msu/Quake-1-TS)
v1.0.0 port and transformed in place; `ARCHITECTURE.md` is the design
contract and phase plan, `PORTING.md` carries the inherited C-to-TypeScript
conventions, `CHANGELOG.md` records what each release changed.

## Status

Landed (2026-09-06):

- One QuakeC VM with NetQuake and QuakeWorld host profiles; the re-release
  progs run with all 18 name-bound `ex_*` builtins, `checkextension`,
  localized prints, `MOVETYPE_GIB`, `SOLID_CORPSE`, the QEX opcodes, prompts,
  `setcolor`, and a `sv_ruleset classic|rerelease|auto` behaviour profile.
- Protocols 15, 666 and 999 behind a codec seam (protocol 15 byte-identical
  to the seed), plus QuakeWorld 28 and this engine's own wide QuakeWorld
  extension, protocol 29 (`sv_qwprotocol`). Wide limits (`max_edicts` up to
  32000, 8192 models, 2048 sounds), BSP2 and 2PSB maps, `.lit` colored
  lighting, BSPX directory, external `.ent` files and texture wads, textures
  of any size.
- Re-release roots detected (nested `rerelease/` or direct), `QuakeEX.kpf`
  mounted, `-mg1 -mg3 -dopa -ctf`, a runtime `game` command, and a per-user
  writable directory (`-homedir`/`-nohomedir`).
- The unified client and server: one binary speaks NetQuake and QuakeWorld,
  and hosts either server profile, chosen per connection and per command
  line instead of per process. `-dedicated -qw` is a QuakeWorld dedicated
  server; a plain `-dedicated` is NetQuake; `-qw` alone is a QuakeWorld
  client; anything else is NetQuake client/listen server. A QuakeWorld
  listen server is also reachable from that default (non-`-qw`) boot,
  with `sv_profile qw` then `map` bringing the QuakeWorld server profile
  up and the local client joining it over loopback.
- Local splitscreen (`cl_splitscreen`, two to four players): each seat is
  its own loopback client connection with its own view, HUD and input;
  `svc_setviews` tells a local client how many seats its own machine is
  running.
- A Multiplayer menu: a Bots page, a start-server screen (ruleset, bot
  count/skill, protocol), a join screen for NetQuake and QuakeWorld
  addresses, and CTF team selection.
- Bots and navigation: NAV2 pathing, `ex_walkpathtogoal` (falling back to
  `movetogoal` on a map with no `.nav`), a game-agnostic bot brain shared
  with quake-2-re-ts's binding work, `addbot`/`bot_count`/`bot_skill`.
- A fixed-step server clock (`sv_tickrate`, default 72) under the
  `rerelease` ruleset, with the renderer free-running and interpolating
  model pose, movement and lightstyle (`r_lerpmodels`/`r_lerpmove`) in both
  renderers.
- MD5 skeletal replacement models (`r_enhancedmodels`) drawn by both
  renderers, with pose lerp and (GL) shadow projection.
- Fog and skyboxes in both renderers (GL: real geometry and blending;
  software: fog as a depth post-pass, skyboxes as cube-mapped spans);
  colored lightmaps and entity lighting in both (`r_coloredlight` /
  `gl_coloredlight`), water/lava/slime/tele alpha, anisotropy (GL).
- Client-side text: kfont/TTF rendering from `QuakeEX.kpf`
  (`scr_usekfont`, `con_font`), a Unicode glyph table (not ASCII-only, to
  match the retail `qfont.kfont`), independent console/status-bar/crosshair
  scale, `$key` localized strings on the client, `language auto` resolved
  from the system locale.
- KEX-format savegames and autosave, SDL game controllers with the
  re-release's own mappings and `.bnvib` haptics, menus driven by
  `mapdb.json` (New Game, episodes, Content x Ruleset, add-ons), a compat
  spawn table so re-release maps and entity keys load under classic progs.
- Parsers for `mapdb.json`, `wwheel.txt`, the bot knowledge files and NAV2
  navmeshes.

Render-seam cleanup also landed: a shared `fog` command and `Draw_GlyphAtlas`
on the renderer interface, with the cvars both renderers read moved to one
shared module (`src/common/render_cvars.ts`). In flight: a per-profile
cvar/cmd registry for the handful of remaining qwcl/qwsv name collisions
where one tree registers a command and the other a cvar under the same name
(`name` itself is the one solved so far, by hand). Not started: the `-qw`
boot cannot host a server yet (the two boot paths still need merging); the
qcc union-progs compiler (R1) and the final byte-vector regate (phase 8) are
still open.

## Running

```sh
bun install
bun src/main.ts -basedir /path/to/quake                          # NetQuake, software renderer
bun src/main.ts -basedir /path/to/quake -vid_ref gl               # OpenGL renderer
bun src/main.ts -basedir /path/to/quake -dedicated 8 +map e1m1    # NetQuake dedicated server
bun src/main.ts -basedir /path/to/quake -qw                       # QuakeWorld client
bun src/main.ts -basedir /path/to/quake -dedicated -qw +map start # QuakeWorld dedicated server
```

`bun run start:qwcl` and `bun run start:qwsv` are exactly the last two
commands above (`bun run src/main.ts -qw` / `-dedicated -qw`), kept as
conveniences for old habits. `bun run build` produces the one compiled
binary, `q1rets`; see [Building from source](#building-from-source) below.

### Content and rulesets

- `-basedir <dir>` — the root holding `id1/` (and optionally `hipnotic/`,
  `rogue/`, `qw/`, `rerelease/`). Defaults to the current directory.
- `-rerelease <dir>` / `-classic <dir>` — point directly at the re-release
  (KEX) or classic content root instead of auto-detecting a nested
  `rerelease/` subdirectory inside `-basedir`.
- `-norerelease` — mount the classic tree only, even when a `rerelease/`
  subdirectory is present.
- **Writable directory.** By default the engine writes to
  `$XDG_DATA_HOME/q1rets` (`~/.local/share/q1rets` when that variable is
  unset), mirrored per game directory: `~/.local/share/q1rets/id1/`,
  `.../hipnotic/`, and so on, created on demand. `config.cfg`, savegames,
  autosaves, demos, screenshots and `qconsole.log` all land there, and that
  tier sits at the head of the search path so those files are found first.
  The install under `-basedir` is only ever read, so a read-only or shared
  retail copy is left untouched — the same quality-of-life rule QuakeSpasm
  and Ironwail follow on Linux, and an addition over WinQuake, which wrote
  into the game directory. The game directory's own `config.cfg` in the
  basedir is still exec'd and never overwritten.
- `-homedir <dir>` — write to `<dir>` instead of the default above (the
  same per-game-directory layout).
- `-nohomedir` — write into `<basedir>/<gamedir>` itself, the unmodified
  WinQuake behaviour.
- `-game <dir>` — an arbitrary override game directory, as the original.
  `-hipnotic`, `-rogue`, `-mg1`, `-mg3`, `-dopa`, `-ctf` each add the
  matching mission-pack or re-release campaign directory.
- `sv_ruleset classic|rerelease|auto` (default `auto`) — the behaviour
  profile. `auto` detects `rerelease` from the loaded `progs.dat`
  (`ex_centerprint` present, `centerprint` absent); `classic` and
  `rerelease` force it.

### Client and server

- `-dedicated [n]` — headless server, `n` client slots (default 8).
- `-qw` — boot the QuakeWorld tree instead of NetQuake: the QuakeWorld
  client alone, or, combined with `-dedicated`, the QuakeWorld dedicated
  server.
- `-vid_ref soft|gl` — pick the renderer at startup (also the `vid_ref`
  cvar, default `soft`).
- `-clientport <n>` — an addition: the UDP port the QuakeWorld client binds
  (id compiled in 27001), so two QuakeWorld clients can run on one host, a
  listen server's own client included.
- `+connect <host>` (NetQuake, port from `-port`/`net_hostport`) vs.
  `+connect <host>:<port>` (QuakeWorld, port in the address) — the same
  syntax id shipped for each. An explicit port in the address means
  QuakeWorld, no port means NetQuake; `cl_protocol nq|qw|auto` (default
  `auto`) overrides the guess outright.
- `sv_protocol 15|666|999|auto` (default `auto`) — the NetQuake wire
  protocol; `auto` picks 999 when a map needs the extra width, else 666,
  and never 15 unless asked. An explicit `sv_protocol 15` on a map protocol
  15 cannot address — a BSP2/2PSB world, or one whose bounds leave ±4096,
  which its 13.3 fixed-point coordinates would wrap — refuses the spawn
  (`sv_protocol 15 cannot carry maps/x.bsp …`) and leaves the previous map
  running, the same way a missing map does, instead of serving a level every
  entity in is misplaced.
- `cl_execonspawn <cfgname>` (default empty) — an addition: run `exec
  <cfgname>` once, on the first frame after this client has finished joining
  a server (SIGNONS on NetQuake, `ca_active` on QuakeWorld), then clear
  itself. Neither original tree can script anything for that moment: every
  line of the opening cfg executes ahead of the commands the server stuffs to
  complete the handshake, so a `record`, a level-dependent `bind` or a
  screenshot script placed after `connect` always ran too early. Arm it from
  the command line (`+cl_execonspawn joined.cfg`) or from a cfg, and set it
  again for each join you want it on.
- `sv_qwprotocol 28|29|auto` (default `auto`) — the QuakeWorld wire
  protocol; 29 is this engine's own wide extension (16-bit entity numbers,
  `U_MODEL2`/`U_FRAME2`, 999-style coords), negotiated when the client
  sends the `*wide 1` userinfo key.

### Bots

- `addbot [name] [skill]` — add one bot immediately.
- `bot_count <n>` (default `0`) — keep this many auto-filled bots on a
  bots-flagged deathmatch map (seated at load and topped up every frame).
  Bots added by hand with `addbot` are extra and stay until `kickbot`.
- `bot_skill practice|easy|medium|hard|expert|nightmare` (default
  `medium`).

### Simulation rate

- `sv_tickrate <n>` (default `72`) — the fixed-step server clock the
  `rerelease` ruleset runs on; the `classic` ruleset stays frame-coupled,
  as WinQuake always was.

### Text, scale and language

- `language <code>` (default `auto`, resolved from the system locale) —
  `$key` string and menu localization.
- `con_font kfont|...` (default `kfont`), `scr_usekfont 0|1` (default
  `0`) — where console/HUD glyphs come from; the retail `quake.rc` sets
  `scr_usekfont 1` to use the re-release's own bitmap font.
- `scr_conscale` (default `0` = auto: one step per 300 rows of window
  height, so 2 at 720p and 3 at 1080p), `scr_sbarscale` (default `0` =
  auto: the largest whole scale at which the 320-wide status bar fits the
  width and stays under a third of the height, so 4 at 720p and 6 at
  1080p), `scr_crosshairscale` (default `1`) — independent console, status
  bar and crosshair scale; a positive value pins the scale.
- `scr_menuscale` (default `0` = auto) — the scale the menu's fixed
  320x200 canvas is drawn at, centred in the window. `0` picks the
  largest whole scale at which 320x200 still fits
  (`min(floor(height/200), floor(width/320))`, never below 1), so the
  menus fill a large window instead of sitting in one corner of it; an
  explicit value is clamped to that same fit. This is an ADDITION: the
  scale is a pure drawing transform, and every menu's layout, cursor
  movement and column arithmetic stay in the original 320x200 units.

### Rendering

- `r_coloredlight` (software renderer, default `1`) / `gl_coloredlight`
  (OpenGL renderer, default `1`) — colored lightmap and dynamic-light data
  from `.lit` files and BSPX `RGBLIGHTING`, per renderer.
- `r_enhancedmodels` (default `1`) — load an MD5 replacement model
  (re-release content) alongside its classic `.mdl`, in either renderer.

### Input

- `joy_enable` (default `1`) plus `joy_deadzone_move`/`joy_deadzone_look`/
  `joy_deadzone_trigger`, `joy_outer_threshold_move`/
  `joy_outer_threshold_look`, `joy_sensitivity_yaw`/`joy_sensitivity_pitch`,
  `joy_invert`, `joy_exponent`/`joy_exponent_move`, `joy_swapmovelook`,
  `joy_rumble`/`joy_rumble_scale` — SDL GameController axis curves and
  `.bnvib` haptics, read from the re-release's `gamecontrollerdb.txt`.

Everything the seed documented still applies unchanged: `-width`/
`-height`, `-port <n>`, `-condebug`, `-nosound`, `-window`, `-safe`,
`-listen <n>`, `vid_restart`, and the rest of the classic parm and cvar
set. See `PORTING.md` and the source for the full list.

## Gates

    bun run check    # tsc --noEmit plus the zero-`any` grep
    bun test         # unit suite; needs no game data

## Building from source

```sh
bun install
bun run build             # ./q1rets, this platform
bun run build:linux-x64   # cross-compile into dist/linux-x64/
bun run build:release     # all four release targets, each zipped
```

`q1rets` is the only binary `bun build --compile` produces; `q1ts`,
`qwsv` and `qwcl` are gone as separate build targets (ARCHITECTURE.md
ruling R4). A release archive can still include copies of the compiled
binary under those old names for launch scripts that expect them:

```sh
bash scripts/release-build.sh --aliases linux-x64
```

`--aliases` copies the one `q1rets` binary to `q1ts`/`qwsv`/`qwcl` in the
output directory; it does not build anything different; each name still
needs `-dedicated`/`-qw` on the command line to pick a profile, the same
as `q1rets` does.

## Faithfulness notes

Behaviour that looks like a gap but is a deliberate, documented choice:

- The `b_*.bsp` icon-preview maps (weapon and powerup pickups rendered on
  the loading/New Game screens) have no `info_player_start` in any
  engine, including the retail one; the map-by-progs sweep accepts that
  as an expected residual rather than a bug.
- Menus are keyboard-only; the re-release's mouse-driven menu navigation
  (`ui_scale`/`ui_mouse`) has not landed yet, so a mouse click on a menu
  item does nothing.
- Where the open reference engines (Ironwail, vkQuake, QuakeSpasm)
  disagree with the re-release QuakeC's own stated intent, the QuakeC
  wins: for example `MOVETYPE_GIB` uses the re-release comment's
  "adjustable gravity, like MOVETYPE_BOUNCE" behaviour, not the fixed
  backoff of 1 the three open engines actually ship.
- `sv_protocol auto` widens to 999 based on a map's entity count and
  extents, not on its BSP version alone; a small BSP29 map with a very
  large entity count still gets the wide protocol even though it could
  fit in BSP29.
- QuakeWorld protocol 29 (`sv_qwprotocol`) has no reference implementation
  anywhere else; it is this engine's own specification, negotiated only
  with a client that opts in via `*wide 1`, so it never surprises a
  vanilla QuakeWorld client.

## Known limitations

- A QuakeWorld listen server is hosted from the default boot: `sv_profile qw`
  then `map <name>` stands the server up and connects the local client to it
  over UDP. The `-qw` boot itself is a QuakeWorld client only; hosting from
  it needs the two boots merged (in flight).
- A handful of qwcl/qwsv name collisions where one tree registers a command
  and the other a cvar of the same name still need one-off registration code
  rather than a general per-profile registry; `name` itself is the one
  solved so far.
- The software renderer's colored lighting is a true-color present path
  behind `r_coloredlight`; the classic 8-bit paletted path is kept for
  `sv_ruleset classic` rather than removed.
- Connecting to a real 2021 re-release (KEX) server is out of scope: KEX's
  own netcode is undocumented, and the interop target is this engine's
  own binary in both seats, plus byte-vector tests against the three
  GPLv2 open engines.
- Windows and macOS builds are cross-compiled but **untested** on real
  hardware; see `docs/PLATFORMS.md`.

## Lineage and attribution

- **id Software** and **ZeniMax Media Inc.**: Quake (1996), the 1999 GPL
  engine release, and the 2021 re-release QuakeC
  ([quake-rerelease-qc](https://github.com/id-Software/quake-rerelease-qc)),
  GPLv2.
- **Ironwail** (Andrei Drexler), **vkQuake** (Novum and contributors) and
  **QuakeSpasm** (Ozkan Sezer and contributors): GPLv2 engines used as
  references for protocols 666/999, BSP2, `.lit`, MD5 and re-release
  progs support.
- **Quake-1-TS** and **Quake-2-Re-release-TS**: our own ports this engine
  is seeded from and borrows from.

## License

GNU General Public License v2 (`LICENSE`). Game data is not included and
remains under its own terms. Quake is a registered trademark of id
Software LLC; this project is not affiliated with id Software, ZeniMax
Media or Bethesda Softworks.
