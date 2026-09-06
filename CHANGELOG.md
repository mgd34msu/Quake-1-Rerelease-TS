# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-05

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
