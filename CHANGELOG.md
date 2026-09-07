# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Milestone 2026-09-06
- Every retail map in all ten trees (classic id1/hipnotic/rogue and the
  re-release id1/hipnotic/rogue/mg1/mg3/dopa/ctf) boots headless under its
  own progs with the player entering, except the icon-preview `b_*` BSPs,
  which have no spawn point in any engine. `test/sweep_maps.test.ts` holds
  the exact residual baseline and passes with `Q1TS_DATA`.

### Added
- One QuakeC VM with host profiles; re-release `ex_*` builtins, extensions,
  rulesets, QEX opcodes, prompts, setcolor; localized prints.
- Protocol codecs 15/666/999 with wide limits; every coord and angle on the
  wire honours the 999 flags; demos re-derive their protocol.
- BSP2/2PSB, .lit, BSPX directory, .ent overrides, external texture wads,
  textures of any size, 2000-texel surfaces, 8192 known models.
- Re-release root detection, QuakeEX.kpf mounting, episode flags, runtime
  `game`, `-homedir`, `-norerelease`.
- OpenGL: colored lightmaps and entity lighting, fog, skyboxes, water and
  entity alpha, anisotropy. Software: colored lighting through a true-color
  frame (r_coloredlight), presented raw through SDL.
- 44.1 kHz sound; KEX savegames and autosave; SDL game controllers and
  .bnvib haptics; menus from mapdb.json with rulesets and add-ons.
- src/lib: zip, PNG, JPG, TGA, TTF, kfont, loc, mapdb, wwheel, bot data,
  NAV2, MD5 model loader, BSPX walker; a compat spawn table for re-release
  classnames under classic progs; the map-by-progs sweep harness.
- `ARCHITECTURE.md`: the design contract and phase plan for the re-release
  engine, with the four open rulings.
- `.orch/preferences.md`: standing orders for agent briefs (local, untracked).
- Bot AI and navigation: NAV2 pathing, `ex_walkpathtogoal` (falls back to
  `movetogoal` on a map with no `.nav`), a game-agnostic bot brain,
  `addbot`/`bot_count`/`bot_skill`.
- Entity `alpha`/`scale`/`lerpfinish` on the wire; `r_lerpmodels`/
  `r_lerpmove` model and movement interpolation; GL lightstyle lerp.
- Client-side kfont/TTF text rendered from `QuakeEX.kpf` behind
  `scr_usekfont`/`con_font`; `scr_conscale`/`scr_sbarscale`; `$key`
  localized strings reach the client.
- MD5 replacement models drawn by the software renderer.
- Fog as a depth post-pass in the software renderer.
- `loc_<lang>_mod.txt` localization merge; `language auto` resolved from
  the system locale.
- MD5 replacement models in the OpenGL renderer, with pose lerp.
- A Unicode glyph table read from `qfont.kfont` (the retail font is not
  ASCII-only) and UTF-8 text mapping.
- `sv_tickrate`: a fixed-step server clock under the `rerelease` ruleset,
  with the renderer free-running and interpolating.
- Cube-mapped skybox spans in the software renderer.
- Shadow projection for MD5-replaced models in the OpenGL renderer.
- Pose and movement lerp in the software renderer, including MD5 models.
- Multiplayer menu: a Bots page (roster, skill, count, gated on `bots/` data
  being mounted), a start-server screen (ruleset, bot count/skill, NetQuake
  protocol), a join screen for NetQuake and QuakeWorld addresses
  (`cl_protocol`), and CTF team selection.
- Local splitscreen: two to four players in one process on one listen
  server, each seat a full loopback client connection with its own view,
  HUD and usercmd; `cl_splitscreen` (command) and `cl_splitscreen_layout`
  (cvar: auto/side-by-side/stacked). `svc_setviews` carries the local seat
  count to loopback clients only.
- This engine's bot brain (`src/lib/bot_brain`) is now also bound by
  quake-2-re-ts; see that project's own changelog for its side of the work.
  Three fixes found while binding it there came back here: an unreachable
  goal is skipped for a while instead of re-picked every frame, the stuck
  trip counter survives a replan so the give-up limit is real, and a stuck
  bot sidesteps and hops for 0.6 s before giving up. The brain's run/walk
  speeds and a weapon-select callback are now config, `NavGraph` takes a
  neutral source (`navGraphFromNav2` builds it from a NAV2 file), and
  weapon selection sees real protection and water state.
- Test hygiene: `sv_tick`, `main_boot` and `screen` suites restore the host
  clock they touch so the dedicated boot test passes in any file order.

### Changed
- The classic conchars charset is the default text source for the menus,
  console, notify lines, centerprints and HUD on ALL content, including the
  2021 re-release trees: `con_font` now defaults to `classic` (it was
  `kfont`). `con_font kfont` / `con_font ttf:<name>` still switch every
  surface to a high-resolution font. `scr_usekfont` stopped being a
  whole-UI font switch and became the unicode-coverage opt-in its own
  comment in the re-release's `quake.rc` describes ("opt into unicode font
  rendering"): with the charset selected, a code point it has no cell for
  (Cyrillic, Greek, CJK out of a `loc_<lang>.txt`) is drawn from
  `fonts/qfont.kfont` fitted to the same row, and everything the charset can
  draw still comes from the charset. Mixing is per code point, so a Russian
  label draws its Latin and Cyrillic letters side by side at one row height.
- The engine writes to a per-user directory by default instead of the game
  install: `$XDG_DATA_HOME/q1rets` (`~/.local/share/q1rets` when unset),
  mirrored per game directory and created on demand, mounted at the head of
  the search path so its `config.cfg`, saves, autosaves, demos, screenshots
  and `qconsole.log` are found first. `-homedir <dir>` picks a different
  root; the new `-nohomedir` restores writing into `<basedir>/<gamedir>`.
  Each game directory's own `config.cfg` in the basedir is still exec'd and
  is never overwritten. QuakeSpasm/Ironwail-style quality of life, an
  addition over WinQuake.
- The New Game and multiplayer start-server screens queue `game <dir>`
  first, then the chosen cvars, then `map`, so a ruleset/protocol choice is
  applied after the gamedir switch rather than before it.
- Choosing an add-on on the Add-Ons screen now opens that add-on's own New
  Game (mapdb) screen once the switch has taken effect, via a new
  `menu_episodes [gamedir]` console command.
- The menus load localization through the same ordered loader the server
  uses (`Loc_ResolveLanguage` + `COM_LoadAllFiles` + `Loc_LoadOrdered`), so
  `language auto` and `loc_<lang>_mod.txt` overlays apply to menu text too.
- Repository seeded from Quake-1-TS v1.0.0 (86c6867) as commit 1; package
  renamed `quake-1-re-ts`.
- Three suites made order-independent (construction defaults checked on
  fresh instances; the QuakeWorld builtin table saved and restored).
- QuakeWorld protocol 28 extracted into the codec seam alongside 15/666/999,
  plus this engine's own wide QuakeWorld protocol 29 (`sv_qwprotocol`);
  `qwsv`/`qwcl` stayed green through the move.
- Per-profile `cmd`/`cvar`/console runtime: one client binary speaks
  NetQuake and QuakeWorld per connection instead of two processes (unified
  client, phase 5 part 1).
- NAV2 decoded field names cleaned up (`type`, `traversal`, `entityLinks`)
  to match how `nav_graph.ts` actually uses them.
- The server side of the same unification: one process hosts both the
  NetQuake and QuakeWorld server profiles, dispatching console commands by
  the console's own profile (unified server, phase 5 part 2).
- The QuakeWorld listen server: `sv_profile qw` followed by `map` brings the
  QuakeWorld server profile up in a process that booted plain (no `-qw`),
  and the local client joins it over loopback; `src/qw/net_udp.ts` now opens
  one UDP socket per side (client and server) instead of one per binary.
  Most cvars both trees declare under one name are now one shared object
  (`SV_RegisterSharedVariable`) instead of two (unified binary, phase 5
  part 3).
- The unified binary is the only build target: `package.json`'s `build`
  produces `q1rets` from `src/main.ts`; `scripts/release-build.sh` builds
  the same one binary for all four release targets, with `q1ts`/`qwsv`/
  `qwcl` available only as optional `--aliases` copies of it;
  `src/qw/main_cl.ts` and `src/qw/main_sv.ts` are now thin wrappers that
  insert `-qw` / `-dedicated -qw` (ARCHITECTURE.md ruling R4).
- Renderer seam cleanup: `Draw_GlyphAtlas` is a member of the `Renderer`
  interface both renderers implement (kfont_text.ts no longer reaches into
  either renderer module directly); one shared `fog` console command
  (`src/client/fog_cmd.ts`) dispatches through the active renderer instead
  of each renderer registering its own; `r_skyfog` and the other
  lerp/sky/alpha cvars both renderers read now live in
  `src/common/render_cvars.ts`, registered once so a software-only or
  dedicated process finds them without the GL renderer's `R_Init` ever
  running.

### Fixed
- Text drawn through the kfont/TTF path landed at the font's raw atlas size
  instead of the text cell its caller had laid out, so with a
  high-resolution font selected (which the re-release trees got by default)
  the console, the notify lines, centerprints and the HUD drew 28-pixel
  letters on an 8-pixel grid: rows overlapped the rows beneath them, glyphs
  overlapped their right-hand neighbours, and a string mixing font glyphs
  with charset fallbacks for the code points the retail `qfont.kfont` omits
  (`:`, `?`, `(`, `'` and 23 more) drew at two sizes on one row. `Text_Draw`
  and `Text_Width`'s `scale` is now stated in classic text cells for every
  font source, `Text_LineHeight` reports the drawn line height rather than
  the atlas's declaration, and `Text_RowScale` is 1 at the classic 8-pixel
  row -- which also un-squeezed the menu rows F14 had been shrinking to 8/28
  of their size (the Options, Keys, Multiplayer and New Game screens).
- The console's scrollback stores a "colored line" as the charset's high bit
  (`c | 0x80`); that whole byte was being handed to the glyph provider as a
  CODE POINT, so a coloured `Y` asked for U+00D9 and a kfont answered with
  an accented capital. The console now splits the cell into a code point and
  the alt flag, which reaches the charset's own golden-row select exactly as
  before and a golden tint on a kfont glyph.
- A zero-byte, truncated or otherwise malformed `.bsp` is refused by name
  (`Mod_LoadBrushModel: <map> is empty` / `is too short` / `has unsupported
  version` / `has lump N out of range`) on both servers, which keep running
  and fall back to `map start` like they do for a missing map, instead of an
  "Out of bounds access" abort that left the QuakeWorld server's UDP port
  bound; a dedicated QuakeWorld server releases its sockets on any remaining
  fatal exit.
- `Sys_Error` throws before any shutdown runs (the top-level handler shuts
  the host down once), so a recovered error no longer leaves a torn-down
  host behind a caller that carried on; every writer whose C original
  checked `fopen` for NULL (config.cfg, saves, demo record, the GL mesh
  cache, QuakeWorld downloads and config) fails with its original message
  instead of aborting the engine.
- Sound channels: 1024 channels and 128 dynamic channels (QuakeSpasm's
  values) replace WinQuake's 128 and 8; the re-release's mg1 maps placed
  more static sounds than the old cap and printed
  `total_channels == MAX_CHANNELS` while loading.
- `sv_protocol 15` refuses a map it cannot carry (BSP2 or extents past
  +-4096) with a message naming the pairing instead of serving a world its
  13.3 coordinates cannot address; `auto` is unchanged.
- A dedicated server's stdin is split into lines (one command per line,
  partial lines held until their newline), so two console lines can no
  longer fuse into one command.
- `cl_execonspawn <cfg>` runs a cfg once when the client reaches the game
  (both NetQuake and QuakeWorld), so a client can be scripted past its join,
  which a cfg on the command line cannot do (its lines run ahead of the
  server's stuffed join text).
- Both clients print `Client protocol N (flags 0x..)` when the serverinfo
  arrives, mirroring the server's own line.
- Two NetQuake clients from the same address (one machine, or a LAN behind
  one NAT) can both hold slots: a connect request from a known address on a
  different port is a new player, not the old one returning from a crash,
  unless that player's socket is already disconnected or has timed out;
  the identical address and port keeps WinQuake's reconnect handling.
- Bots: the wedge timer no longer fires on a bot circling its target in
  combat (it rested the goal it was fighting toward for twenty seconds); the
  seeded bot generator discards eight warm-up draws so adjacent small seeds
  no longer share their first decisions (seeded sequences change, unseeded
  behaviour does not).
- Horde maps (mg1) were unplayable under `deathmatch 1` for humans and bots
  alike: mg1's coop spawn points remove themselves outside coop, so
  everyone was parked at the intermission camera; a map `mapdb.json` flags
  `horde` now spawns in coop and the operator's values return on the next
  non-horde map. Bots keep their bot flag across respawns (the QuakeC
  resets it), treat horde as a team game, and `bot_count` applies from
  zero through a per-frame server hook. `sv_randomseed <n>` / `-randseed`
  seeds the generator the QuakeC `random()`, `SV_MoveToGoal` and the bot
  roster use, so a run can be replayed (0 = unseeded, the default).
- The `ctfscores` client command the re-release CTF progs stuff at every
  client is implemented: team scores and each flag's state (at base,
  carried, dropped) are kept per connection and drawn under the status bar
  and on the scoreboard, cleared on level change and disconnect.
- A code point the active kfont does not define draws the classic charset
  cell (the retail `qfont.kfont` lacks most punctuation, even `?`), so the
  Keys screen's unbound marker and console/HUD/menu punctuation are visible
  under `con_font kfont`; above 255 the font's own `?` is used, else the
  charset's.
- Menu text draws through the kfont/TTF path when a kfont is mounted, scaled
  to the classic 8-pixel row with the same column positions, so localized
  labels in Cyrillic and accented scripts render; classic content keeps the
  charset path byte-for-byte (cursor, slider and level-select marks stay
  charset artwork).
- Menus draw their labels through the localization table (`$m_*` keys with
  the English literal as fallback), so `language` changes the menus; the
  Options, difficulty, level-select, bots, setup, key-bind, quit and
  multiplayer screens are covered, and rows without a retail key stay
  English. `give a` (armour) and the current-ammo fix-up after a give come
  from Ironwail; `give all` grants every weapon, ammo, keys and armour as a
  documented addition (the reference engines treat it as armour 0).
- Saves: `load autosave` and the Load menu find slots in nested autosave
  directories (vault/, test/); the Load menu shows a KEX save's real
  comment instead of its game-name line; loading a CTF save no longer kills
  the player through the team-change path (the `color` command sent during
  the post-load signon wrote the client's colour over the restored team;
  it now recovers the colour from the restored team instead).
- GL renderer: alias models are no longer capped at 1024 vertices (half of
  GLQuake's own limit; mg3's statues and hanging players have up to 1912)
  and the triangle count is checked too, both against a 65536 ceiling with
  the count in the message; the texture upload scratch is sized from
  `gl_max_size` instead of a fixed 1024x512, so the re-release's 1024x1024
  skybox faces (mg1) upload. One shared `sky <name>` console command serves
  both renderers (the software renderer had none). The mesh cache writer
  creates the cache file's own directory, so a model under a `progs/`
  subdirectory (mg3's `rogue/`) no longer aborts the GL boot.
- Bots survive a `map` change: the roster (names, colours, skill) is kept
  across Host_ShutdownServer and re-seated on the next level; `bot_count`
  applies live and never removes a bot added with `addbot`; the connection
  counter is only decremented for clients that had a connection. Monster
  navigation (`walkpathtogoal`) sets `self` around the step, re-plans on
  repeated blocks and restores the yaw for the QuakeC fallback, so nav
  monsters now close more distance than `movetogoal` instead of an eighth.
  Bots fight monsters and regroup with the player in coop, treat the enemy
  flag (not their own) as the CTF objective, recover from being wedged
  within about a second, roam when a map has no navigation, and chat
  through the localized `m_bot_chat_*` variants for every event type
  (`bot_chat 0` silences them).
- Splitscreen: a level change no longer drops every seat past the first.
  The server's `reconnect` reset only the bound (primary) seat's signon, so
  the other seats carried a finished signon into the new level and died on
  "Received signon 1 when at 4"; every connected seat's signon is reset when
  the server spawns.
- Splitscreen: an error raised inside a non-primary seat's window drops that
  seat (and the seats above it) instead of shutting the server and the first
  player down; with several seats sharing one console a broadcast prints
  once and a seat-directed line once with a `[P<n>]` label.
- Splitscreen: `cl_splitscreen N` on an active server defers the widen to
  the next level instead of resizing a live client table; a seat that has
  not signed on shows the loading plaque instead of rendering without a
  world; each seat's message buffer is allocated; the loopback socket pool
  is sized for the seats; seat colours default to distinct teams under
  CTF; the seat rectangle no longer compounds across frames (the cause of
  the re-release two-seat hang); four seats and map changes with seats
  active work end to end. A missing optional pic never aborts the engine.
- `scr_sbarscale` scales the picture-based status bar elements in both
  renderers (numbers, faces, weapon and item icons, backgrounds), not only
  the kfont text, and a scale change redraws the bar. The scaled bar is
  anchored at the bottom centre so the whole of it stays on screen, and the
  3D view reserves the scaled bar height (`sb_lines`) in both renderers, as
  Ironwail does; the viewsize tiers are read from the cvar, not from
  `sb_lines`.
- A game-directory switch from the menu no longer reverts the chosen
  ruleset or protocol. The `game` command re-execs `quake.rc` with
  `Cbuf_InsertText` instead of appending it, so the new gamedir's archived
  `config.cfg` runs before the rest of the queued launch script rather than
  after the map had already spawned and clobbering `sv_ruleset`/
  `sv_protocol` back to `auto`.
- Playing from the menu no longer writes savegames, autosaves, `config.cfg`
  or `qconsole.log` into the retail install: `-game <dir>` was dropped by a
  subsequent `game <dir>`, and writes went to `<basedir>/<gamedir>`. See the
  writable-directory change above.
- Software renderer: the weapon view model's pose cache is keyed by model,
  so switching weapons no longer reads the previous weapon's vertex array
  (rogue r2m8 crashed on the lava nailgun); a view-model change also resets
  the animation lerp in both renderers. The alias bounding-box check and the
  MD5 draw path now agree on where a moving monster is (dopa e5m7 crashed
  and hipnotic hip1m2 hung on the unclipped draw path). Both renderers
  compute lerp fractions through one helper (`src/common/lerp_blend.ts`)
  that never yields a non-finite blend, the GL frame setup resets a stale
  pose index, and the software path culls a model whose transform is not
  finite instead of handing it to the rasterizer.
- MD5 replacement models move-lerp like `.mdl` models: the software MD5
  transform takes the same blended origin and angles the alias
  bounding-box check used (GL already shared one model matrix), and an
  entity slot handed out for the first time starts its animation and
  movement lerps at its real origin instead of blending in from the world
  origin for a frame.
- The retail sweep's per-map timeout follows its SIGTERM with SIGKILL, so a
  driver spinning inside one frame cannot stall the sweep.
- Software renderer at 2048 pixels wide and up: the 20.12 fixed-point edge
  coordinates overflowed 32-bit shifts at exactly 2048 (`vrectright << 20`
  is 2^31), the edge tail sorted before every real edge and the scan walked
  off the list; the shifts are now exact arithmetic and the edge, span and
  scan tables are sized for the mode table (up to 3840x2160, 4096 wide).
  Splitscreen panes re-derive the clip limits from the seat's own view
  rectangle, so a pane no longer removes edges it never inserted.
- `-vid_ref` on the command line applies once at video init instead of at
  every restart, so `vid_ref gl; vid_restart` works after a `-vid_ref soft`
  boot. Minimizing the window releases the mouse like losing focus, and
  restoring re-activates only when the window has input focus.
- The menus, status bar and console drew at 1x on a 320x200 layout in the
  top-left of any larger window (8 px glyphs on a 1080p screen). The
  classic menu tree now draws through one centred 320x200 canvas at
  `scr_menuscale` (default auto: 3x at 720p, 5x at 1080p) in both renderers,
  with the episode, add-on, level, Load/Save and Bots lists paged to the
  rows that fit; the status bar follows `scr_sbarscale` auto (4x at 720p,
  6x at 1080p) and the console, notify lines and centerprint follow
  `scr_conscale` auto (2x at 720p, 3x at 1080p). The Multiplayer menu's
  "Bots" row is drawn at the picture rows' height, and the Video menu has
  its `gfx/vidmodes.lmp` plaque.
- A `connect host:port` typed from a default (NetQuake) boot reached the
  QuakeWorld server and was then torn down by quake.rc's `startdemos`,
  which still sat behind the boot cfg in the command buffer: the
  QuakeWorld connect branch now clears the demo loop like WinQuake's
  `Host_Connect_f` does. `-clientport <n>` (an addition) moves the
  QuakeWorld client's fixed UDP port 27001 so two clients, or a listen
  server's own client and a guest, can share one host.
- config.cfg carries a `cfg_version` (an addition). A config written by an
  earlier build had archived `scr_sbarscale "1"`, `scr_conscale "1"` and
  `con_font "kfont"` as if the player had chosen them, so the new auto
  scales and the classic font never applied to an existing install;
  `cfg_migrate` (run once after quake.rc) resets those three to their
  defaults on a config below version 2 and stamps the current version.
  Later choices are kept.
- The QuakeWorld client's own menus, status bar, console, notify lines and
  centerprint scale to the window the same way the NetQuake client's now do,
  instead of drawing at fixed 8px/320-wide device pixels: the menu tree
  draws through the shared centred 320x200 canvas at `scr_menuscale`
  (`M_CanvasScale`/`M_CanvasX`/`M_CanvasY`, mirroring the NetQuake menu's own
  transform), the status bar scales and centres at `scr_sbarscale`
  (`+showscores`/team overlays and the mini deathmatch scoreboard scale with
  it), and the console/notify lines/centerprint scale at `scr_conscale`'s
  virtual width. The classic QuakeWorld bar drew flush against the window's
  left edge rather than centred (WinQuake's own centres); giving it the same
  bottom-centre anchor as the NetQuake bar is a deliberate, documented
  deviation from that original placement, not a fidelity break -- the
  headsup HUD (`cl_sbar 0`), which docks to the real window edges by design,
  scaled its picture-based elements but not yet its ammo/weapon strip (see
  below). At 320x200/`scr_*scale 1` every affected draw call is
  byte-identical to its pre-existing formula.
- The QuakeWorld headsup HUD (`cl_sbar 0`, its default)'s edge-docked
  ammo/weapon strip -- the bottom-right ammo counts and weapon icons drawn by
  `Sbar_DrawInventory`'s `headsup` branch -- now scales with `scr_sbarscale`
  like the rest of the status bar, instead of staying fixed at 8px glyphs and
  1x icons regardless of window size (at 1920x1080 that strip was unreadably
  tiny next to the now-scaled classic bar and console). It stays docked to
  the REAL window edges at every scale rather than centring, the opposite of
  the classic bar's own anchor -- a deliberate distinction, since headsup
  mode's whole point is real-edge docking. `Sbar_FinaleOverlay` and
  `Sbar_IntermissionNumber`, left at 1x by the change above, now scale too.
  Software and OpenGL both gained a `Draw_ScaledSubPic` renderer primitive
  (mirroring the existing `Draw_ScaledPic`) to draw a scaled sub-rectangle of
  a wad picture, which the ammo-count background swatches need.
- QuakeWorld's `quit` console command (a WinQuake-style convenience this
  port added; the real QuakeWorld client has none, only a menu "Quit" item)
  always opened the confirm-menu screen regardless of how it was invoked, so
  a `quit` issued from a cfg or script (nothing left to answer the "press Y
  to quit" prompt) hung forever instead of exiting. It now checks the same
  real `key_dest` state the NetQuake client's own `quit` does: typed at the
  actual console it disconnects and exits immediately, matching NetQuake;
  reached with the game or a menu focused it still opens the confirm menu
  exactly as before.
- A bot validated its corner cuts with a zero-width sight line, so the
  string puller approved shortcuts a 32-unit-wide player cannot fit
  through: on `ctf9` a flag carrier was handed a first steering point some
  750 units away through a gap beside a doorway, leaned on the wall next to
  the door until its two-second plan expired, and was then given the same
  route again. A cut is now checked by sweeping a box the size of the bot's
  own body, against the world and the brush models bolted to it and nothing
  else -- a team-mate standing in a doorway is not a reason to call the
  doorway too narrow, and whoever was standing there has moved by the time
  the bot walks the plan. Both ends of the sweep are dropped to the ground
  they stand on first, because the two kinds of point being joined do not
  measure from the same place: a `.nav` node sits on the floor and a player
  origin sits its own height above it. And the first cut is measured from
  where the bot actually stands rather than from the nav node the plan
  starts at, which is as often behind it as in front. `BotWorldT.traceBox`
  takes an `ignoreEntities` option (the Quake 1 binding answers it with
  `MOVE_NOMONSTERS`) and `BotWorldT.hull` lets a binding name a body other
  than the default `BOT_PLAYER_HULL`, which is the player of both Quake 1
  and Quake II; everything under `src/lib/bot_brain` stays game-agnostic.
- A `-vid_ref gl` boot whose config.cfg had archived `vid_ref "soft"` ran GL
  while the cvar still read soft, so the first `vid_restart` (or the video
  menu's Apply) silently dropped to the software renderer. Host_Init now
  re-asserts the command-line renderer after quake.rc and everything it
  execs have run.
- The Multiplayer menu's Bots page "Add" row (and `addbot` at the console)
  added a bot that the `bot_count` auto-fill kicked again on the next server
  frame, because the fill compared `bot_count` to the whole roster. It now
  governs only the bots it created: `bot_count 3` plus two hand-added bots
  is five bots, and a hand-added bot stays until `kickbot`. The "server is
  full" line is printed only for a hand-typed `addbot`, not once per frame
  by the auto-fill.
- A listen server booted without `-listen` had a fixed pool of 4 client
  slots, so `maxplayers 8` silently clamped to 4 and the Bots page could
  never seat a fourth bot. The pool is always the full 16-entry scoreboard
  (`svs.maxclients` still carries the `-listen`/`-dedicated`/`maxplayers`
  choice), as the re-release hosts 16 from a plain boot.
- Every mg1 Horde map aborted the client with "Illegible server message":
  when the player's weapon field is 0 (horde.qc spawns it that way) the
  non-`standard_quake` clientdata writer skipped the weapon byte the client
  reads unconditionally, shifting every later byte. The byte is written
  always, as QuakeSpasm and vkQuake do, on protocols 15, 666 and 999.
- An exec'd file that lacks a final newline (the re-release quake.rc) no
  longer fuses its last line with the next queued command.
- Localization files decode as UTF-8 (the re-release tables are UTF-8:
  Russian, accented French/German/Italian/Spanish, the trademark sign in
  English), and kfont text walks code points, so non-ASCII strings render
  their glyphs instead of mojibake; an unmapped code point draws the font's
  fallback glyph rather than nothing.
- A dedicated server no longer prints one "Unknown command" line for every
  client-only setting in the game's config.cfg (WinQuake did); the settings
  are counted and reported in one summary line per command-buffer pass, a
  one-word typo at the dedicated console still prints, and `developer`
  restores the per-line print.

## Quake-1-TS [1.0.0] - 2026-09-05 (the seed)

First release: id Software's 1999 GPL Quake sources ported to TypeScript on
Bun, one `.ts` module per `.c` file, verified against retail game data.

### Added

#### Engine core and the QuakeC virtual machine

- `mathlib`, `quakedef`, `bspfile`, `modelgen`, `spritegn` and `protocol`, with
  every struct size asserted against the C's `sizeof`.
- `common`/`sizebuf`, `cmd`, `cvar`, `crc`, `zone` and `wad`. `Hunk_*` returns
  exactly the requested size; the C's 16-byte rounding applies only to the mark
  counters, because TypedArray length is observable where padding is not.
- `pr_edict`, `pr_exec` and the 79-slot builtin table in `pr_cmds`: game logic
  runs as `progs.dat` bytecode, exactly as WinQuake does. No QuakeC is
  transliterated, so the base game, both mission packs and classic mods all run
  from their original data.
- `string_t` engine strings as a positive-indexed engine string table
  (`ENGINE_STRING_BASE`); `ED_Write` output is byte-identical to glibc `printf`
  and savegames round-trip byte-exact.
- `host`/`host_cmd`, `server`, `world`, `sv_main`, `sv_phys`, `sv_move` and
  `sv_user`; `main.ts` splits `sys_linux.c`'s `main` into init and loop halves.
- Shared model loader (`common/model.ts`) holding the server-visible half, with
  per-renderer hook sets for the rest — the split id's own `QW/server/model.c`
  draws.

#### Renderers

- Software renderer: `r_main`, `r_bsp`, `r_edge`, `r_surf`, `r_aclip`,
  `r_alias`, `r_sprite`, `r_sky`, `r_light`, `r_efrag`, `r_draw`, the `d_*`
  rasterizer and `draw`. The `.s` assembly paths are not ported; `nonintel.c` is
  the ported path.
- OpenGL renderer: `gl_rmain`, `gl_rmisc`, `gl_rlight`, `gl_refrag`, `gl_rsurf`,
  `gl_warp`, `gl_mesh`, `gl_draw`, `gl_model` hooks and `gl_ngraph`, over a
  `QGL` function table bound off `libGL.so.1` through SDL's `GetProcAddress`.
- Both renderers are compiled in and chosen at runtime through the one cvar this
  port adds, `vid_ref` (`soft`|`gl`), with a `-vid_ref <name>` command-line parm
  and a `vid_restart` console path. `GLQUAKE` is a compile-time define in the C;
  this is the single documented user-facing addition.
- `Renderer.Shutdown` teardown seam so a `vid_ref` switch can release QGL and
  restore the software present path's palette.

#### Client

- `cl_main`, `cl_parse`, `cl_input`, `cl_tent`, `cl_demo`, `chase`, `console`,
  `keys`, `menu`, `sbar`, `screen`, `view`, `r_part` and the sound stack.
- `console.ts` is a load-time leaf (lazy requires), so every fundamental module
  can print without re-entering `cvar`/`net_main` during their own init.

#### Networking

- `net`, `net_main`, `net_loop`, `net_dgrm` and `net_vcr`, including two shipped
  C bugs kept verbatim (`VCR_Listen` is never installed; `VCR_GetMessage` reads
  data only for `ret == 1`).
- UDP over libc sockets via `bun:ffi` with non-blocking `recvfrom`, for both the
  NetQuake and QuakeWorld layers.

#### QuakeWorld

- Shared QW layer: `protocol`, `bothdefs`, `common`, `net_chan`, `net_udp`,
  `md4`, `pmove`/`pmovetst`, and the `cvar`/`cmd`/`crc` deltas folded under a
  `qw.active` flag.
- `qwsv`: QW server progs host, `world`, an 83-entry builtin table, `sv_main`,
  `sv_init`, `sv_ccmds`, `sv_ents`, `sv_nchan`, `sv_send`, `sv_phys`, `sv_move`,
  `sv_user`, and `src/qw/main_sv.ts` as the headless entry point.
- `qwcl`: `cl_ents`, `cl_pred`, `cl_cam`, `skin`, `cl_main`, `cl_parse`,
  `cl_demo`, `cl_input`, `cl_tent`, `sbar`, `menu`, `screen`, `r_part`, QW's
  wholesale `console.c` rewrite as its own module, and `src/qw/main_cl.ts`.
- `Draw_SubPic`, `Draw_Alt_String`, `isGL` and an optional `R_NetGraph` on the
  `Renderer` interface, for the members QW's `draw.c`/`gl_draw.c` add.

#### Platform

- SDL2 through `bun:ffi` as the one native windowing, input and audio layer:
  `sdl`, `vid`, `glimp`, `swimp`, `snd`, `cd_ogg`, `net_udp`, `sys`,
  `vid_scale`, `vid_menu`. The DOS, VESA, SVGAlib, X11, Windows-native, IPX and
  serial platform files are not ported.
- CD music replaced by `music/NN.ogg` under the game directory, through the
  system libvorbisfile.
- Case-insensitive game-directory and pak lookup (`Sys_ResolveCase`), so id's
  shipped `Id1/PAK0.PAK` layout loads unmodified.
- `SIGINT`/`SIGTERM` handlers that shut down cleanly and write the config — a
  deliberate addition, since `sys_linux.c` and `sys_unix.c` install none.
- Mouse capture while the window is focused and either fullscreen or
  `key_dest == key_game`, released for the console, a menu, chat entry or lost
  focus. `_windowed_mouse` stays registered for config compatibility but no
  longer gates capture.

#### Tooling and tests

- `bun run check`: `tsc --noEmit` under strict TypeScript plus a gate that fails
  the build on any `any` in `src/` or `test/`.
- 1817 unit tests over 113 files, running on synthetic paks, maps and models
  built by `test/support/`, needing no game data.
- `test/e2e/`: headless end-to-end drivers (families A-P) that boot the real
  engine against real data through the actual SDL, UDP and filesystem backends,
  with a README mapping each driver to what it covers.
- `bun build --compile` targets for all three binaries: `build`, `build:qwsv`,
  `build:qwcl`, `build:all`.

### Fixed

Defects found while running the port against retail data and through the
end-to-end passes. Each was a port bug, not a change to Quake's behaviour.

- Engine string indices are positive. Negative ints are float NaN bit patterns,
  and qcc's `OP_STORE_V` argument copies canonicalized them: doors lost their
  model, `find()` failed, and hipnotic maps crashed on load.
- Engine strings can alias a live holder (`PR_SetStringRef`), so QuakeC
  `netname` follows a client rename in both trees the way the C's pointer does.
- QuakeWorld's engine string budget counts only engine strings; mods no longer
  exhaust `MAX_PRSTR`.
- The NetQuake and QuakeWorld UDP layers were rewritten over libc sockets: the
  synchronous connect handshake could never see a reply through Bun's async
  socket, and `ECONNREFUSED` no longer throws.
- `-port` is wired on the NetQuake side, and `NET_StringToAdr` resolves
  `localhost`.
- `vid_restart` reloads the level for the incoming renderer (cache flush, model
  reload in place, `R_NewMap`, efrags, player skins) and re-registers renderer
  commands during the switch. Mid-game `soft`↔`gl` works.
- A GL renderer restart zeroes every retained texture id (lightmaps, sky,
  particle, player, draw pics, bind caches) and never rewinds the name counter;
  restarted levels no longer sample lightmap atlases as wall textures.
- `SDL_WINDOWEVENT_SIZE_CHANGED` adopts the new size without recreating the
  context, and the console background re-initialises on a compositor resize (GL
  left most of the frame unpainted).
- Mouse: `mouse_avail` comes from `-nomouse` only, `SDL_MOUSEMOTION` is decoded
  in the event pump, and the QuakeWorld client reads its own input cvars.
- Shared `Mod_LoadTextures` runs on every path; a dedicated server hit "Bad
  surface extents" on real maps without it.
- The software renderer's platform layer never set `vid.aspect`, leaving `yscale`
  at 0 and collapsing the whole view.
- `VID_Init` sets `vid.conbuffer`/`conrowbytes`, so console text and status-bar
  glyphs draw in `qwcl` as well.
- One file-handle table: `COM_FindFile`/`handleRead` returned zero-filled buffers
  for pak files opened by the QuakeWorld pak loader.
- The QuakeWorld client's `pmodel`/`emodel` CRC excludes the trailing NUL, the
  same as the server's, ending the "non standard player/eyes model detected"
  warning on retail data.
- `PF_Find` accepts the empty string; `Sys_ConsoleInput` returns the C's read
  buffer; the `qwsv` redirect captures prints from shared modules.
- `-condebug` on a missing game directory no longer crashes;
  `Host_WriteConfiguration` prints instead of erroring; `Con_Printf` survives a
  torn-down renderer.
- Video menu ESC returns to the active menu module, so QuakeWorld's menu state no
  longer desynchronises from the shared video menu.
- `host_basepal`/`host_colormap` resolve through one helper: two holders for the
  same C global made GL `Draw_Fill` paint every `qwcl` scoreboard colour white.
- `CL_NewTranslation` evaluates the colour-change condition once for both the GL
  upload and the software table.
- QuakeWorld static entities are copied into the visedict list as the C does;
  `Netchan_Setup` keeps its message `SizeBuf` identity; `ftos`/`vtos` share one
  temp string and `infokey` its buffer.
- The GL screenshot path goes through the renderer seam (it wrote a black PCX)
  and the PCX writer walks rows top-down as the C does.
- `VID_CheckChanges` disables screen updates during a renderer switch and falls
  back to `soft` when GL fails to initialise.
- `NET_Init` bind failure raises `SysError` through `NET_Ready` instead of
  failing silently.

[1.0.0]: https://github.com/mgd34msu/Quake-1-TS/releases/tag/v1.0.0
