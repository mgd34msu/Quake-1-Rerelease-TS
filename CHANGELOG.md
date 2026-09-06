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
