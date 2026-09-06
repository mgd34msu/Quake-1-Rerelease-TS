# Quake 1 TS

A faithful port of id Software's 1999 GPL Quake sources to
TypeScript, running on [Bun](https://bun.sh). It covers WinQuake 1.09 with
**both** the software renderer and the OpenGL renderer, and QuakeWorld 2.33's
client and server. Every `.c` file became one `.ts` module under strict
TypeScript with no `any` and no casts, and game logic still runs as `progs.dat`
bytecode through a ported QuakeC virtual machine, so the base game, both mission
packs and classic mods all load from their original data. It plays from the
retail or shareware pak files and builds into three standalone executables:
`q1ts` (single player and NetQuake), `qwsv` (QuakeWorld server) and `qwcl`
(QuakeWorld client).

The only user-facing behaviour the port adds is a `vid_ref` cvar to pick a
renderer at runtime, because `GLQUAKE` is a compile-time define in the C.
Everything else that differs from the original is deliberate, documented in the
porting notes, and listed under [Faithfulness notes](#faithfulness-notes) below.

## Status

Verified against retail data, both renderers:

- The full single-player campaign: all 38 base maps, plus the Scourge of
  Armagon (`hipnotic`) and Dissolution of Eternity (`rogue`) mission packs.
- Save and load, demo playback, recording and `timedemo`.
- Console, menus, key bindings, `config.cfg` round-trip, video modes and
  `vid_restart` switching between the software and OpenGL renderers mid-game.
- Sound and `music/NN.ogg` CD-track replacement.
- NetQuake multiplayer over real UDP: listen server and dedicated server.
- QuakeWorld: `qwsv` serving two real `qwcl` clients — frags, map changes,
  spectator mode, demos, `rcon`, bans.
- Real SDL keyboard and mouse input, the compiled binaries, command-line parms
  and signal handling.

The gate for any change is two commands:

```sh
bun run check    # tsc --noEmit, plus a grep that fails the build on any `any`
bun test         # 1817 tests, 0 failures
```

`bun test` uses synthetic fixtures and needs no game data. A handful of suites
boot the real engine and skip unless `Q1TS_DATA` points at an installation
(see [Development](#development)).

## Requirements

- **Bun 1.3 or newer.**
- **SDL2** — the one native windowing, input and audio layer, reached through
  `bun:ffi`. Required by `q1ts` and `qwcl`; `qwsv` needs no SDL at all.
- **An OpenGL driver** — only for `-vid_ref gl`. The software renderer needs
  nothing beyond SDL2.
- **libvorbisfile** — optional, for `music/NN.ogg` playback in place of the CD.

Per-OS package names and install commands are in
[docs/PLATFORMS.md](docs/PLATFORMS.md).

## Getting the game data

No game data ships here and none can: the pak files remain id Software /
Bethesda property. Bring your own copy —
the shareware `pak0.pak`, a retail install from Steam or GOG, or the original
CD.

The engine expects a *base directory* laid out the way Quake has always laid it
out:

```
<basedir>/
  id1/
    pak0.pak          shareware or retail episode 1
    pak1.pak          registered data (episodes 2-4)
  hipnotic/           Scourge of Armagon, optional
  rogue/              Dissolution of Eternity, optional
  qw/
    qwprogs.dat       QuakeWorld progs, for qwsv and qwcl
```

Case does not matter. id shipped the retail CD as `Id1/PAK0.PAK`, and
`Sys_ResolveCase` resolves that layout as-is, so you can point `-basedir`
straight at a mounted CD or an unmodified install.

`-basedir <dir>` selects the base directory; with none given, the engine looks
in the current directory. `-hipnotic` and `-rogue` add the matching mission-pack
directory to the search path, and `-game <dir>` adds an arbitrary mod directory,
exactly as the original does.

`qwprogs.dat` comes from id's QuakeWorld release, not from the retail paks. Both
QuakeWorld binaries need it, and both also need registered `id1` data (the
`gfx/pop.lmp` check that marks a copy as registered).

## Running

Three binaries, each the port of one of id's entry points.

### q1ts — single player and NetQuake

```sh
bun src/main.ts -basedir /path/to/quake                     # software renderer
bun src/main.ts -basedir /path/to/quake -vid_ref gl         # OpenGL renderer
bun src/main.ts -basedir /path/to/quake -hipnotic           # mission pack
bun src/main.ts -basedir /path/to/quake -listen 4 +map dm3  # listen server
bun src/main.ts -basedir /path/to/quake -dedicated 4 +map start
```

- `-vid_ref soft|gl` picks the renderer at startup. `-width`/`-height` set the
  window size; at the console, `vid_mode` and `vid_restart` change it later.
- `-dedicated <n>` runs a server with no window; console commands come from
  stdin. `-listen <n>` runs a playable server.
- `-port <n>` sets the UDP port.

A NetQuake client connects with the port on the *command line* and the host in
the `connect`:

```sh
bun src/main.ts -basedir /path/to/quake -port 26000 +connect 192.168.1.10
```

That is the original's syntax, not an omission: WinQuake's `COM_Parse` makes `:`
its own token, so `connect host:port` reaches `Host_Connect_f` as the bare host
and the port is dropped. `NET_StringToAdr` then fills the port in from
`net_hostport`, which is what `-port` sets.

### qwsv — QuakeWorld server

Headless by design: no SDL, no window, exactly as id's `qwsv` is.

```sh
bun run start:qwsv -- -basedir /path/to/quake -port 27500 +map start
```

- `-port <n>` defaults to 27500; `-port 0` binds any free port.
- With no `+map`, the server spawns `start` on its own.
- Maps load from `qw/maps/<name>.bsp` first, then `id1/`.
- `server.cfg` in the game directory runs at startup, and console commands
  (`status`, `map`, `kick`, `quit`, …) are read from stdin.

### qwcl — QuakeWorld client

A pure client with no server half, so it always plays on a remote server.

```sh
bun run start:qwcl -- -basedir /path/to/quake
```

Then at the console, or as `+connect …` on the command line (which `stuffcmds`
in `quake.rc` runs):

```
connect somehost:27500
```

QuakeWorld takes the port in the address string; that half is not like NetQuake.
`-game` is forced to `qw`, as in the original. The client creates `qw/` itself
and fills it with whatever the server sends — maps, models, sounds and player
skins are downloaded there on connect.

Running two clients on one machine needs `-ip` on the second: QuakeWorld's
client port is the hardcoded constant `PORT_CLIENT = 27001` and there is no
`-port` override, so only one `qwcl` can hold that port per address.

### Renderers

`vid_ref` (`soft` by default, or `gl`) is read once while the engine starts up,
*before* `quake.rc` runs, so `+vid_ref gl` on the command line comes too late.
Three ways to choose:

- `-vid_ref <soft|gl>` on the command line, honoured by all three binaries.
- The video menu's Apply.
- `vid_ref gl` then `vid_restart` at the console.

A `-vid_ref` parm holds for the whole session even when `config.cfg` archives a
different value: the parm is re-applied every time the renderer choice is
re-resolved, so it always wins back.

### Files the engine writes

Config, saves, demos and screenshots go in the *game* directory, which is a
subdirectory of the base directory: `id1/` for `q1ts` (or `hipnotic/`, `rogue/`,
whatever `-game` names), and `qw/` for `qwcl`. The two trees therefore keep
separate `config.cfg` files and never overwrite each other's settings.

- `screenshot` writes `quakeNN.pcx` there.
- CD music is replaced by `music/NN.ogg` under the game directory, played
  through the system libvorbisfile — track 2 is `music/02.ogg`, and so on.

## Tips

- QuakeWorld plays best with `cl_maxfps 72` and `rate 25000`.
- On Hyprland and other tiling compositors the game window is tiled into
  whatever free space the workspace has rather than floated at the size it
  asked for, which looks like fullscreen-in-a-window. The engine adopts whatever
  size the compositor hands it (runtime resizes are supported), so to get the
  size you asked for, add a float rule matched on the window class. That class
  is `bun` when running from source (`bun` is the process SDL sees) and the
  binary's own name (`q1ts`, `qwsv`, `qwcl`) for a compiled build; nothing sets
  `SDL_VIDEO_X11_WMCLASS` to anything else. Check with `hyprctl clients` or
  `xprop` if a rule does not match.

  ```
  windowrulev2 = float, class:^(bun)$, title:^(Quake)$
  windowrulev2 = size 1280 720, class:^(bun)$, title:^(Quake)$
  ```

  Or set `vid_fullscreen 1` for real, non-tiled fullscreen.

## Building from source

```sh
bun install
bun run build          # ./q1ts
bun run build:qwsv     # ./qwsv
bun run build:qwcl     # ./qwcl
bun run build:all      # all three
```

Each is a `bun build --compile` single-file executable that still needs SDL2
(and libGL, libvorbisfile) on the host at runtime; those are loaded through
`bun:ffi`, not linked in.

`bun run build:release` cross-compiles the release set into `dist/` — see
[docs/PLATFORMS.md](docs/PLATFORMS.md) for the targets and their prerequisites.

## Development

[PORTING.md](PORTING.md) is the contract: the file-by-file mapping to the C, the
type discipline, the renderer seam, how the QuakeC VM and the engine string
table work, and every documented deviation with its reasoning.

- `bun run check` — `tsc --noEmit` plus the gate that rejects `any` anywhere in
  `src/` or `test/`. It must print `CHECK OK`.
- `bun test` — the unit suite. It builds its own synthetic paks, maps and models
  and needs no game data.
- `test/e2e/` — manual end-to-end drivers that boot the real engine against real
  data through the actual SDL, UDP and filesystem backends. They are not
  `bun test` suites; each runs as its own process and reads the base directory
  from the `Q1TS_DATA` environment variable. See
  [test/e2e/README.md](test/e2e/README.md).

## Faithfulness notes

Behaviour that looks wrong but matches the original, and is kept on purpose:

- `quit` typed in-game opens the confirmation menu instead of quitting; only
  `quit` with no active game exits directly.
- The command line truncates at 50 arguments (`MAX_NUM_ARGVS`).
- The OpenGL renderer lights torches and fullbright texels differently from the
  software renderer. GLQuake modulates fullbright texels; the software renderer
  does not. Both are reproduced as written.
- The QuakeWorld client's UDP port is the fixed constant 27001; QuakeWorld 2.33
  has no `-port` for it.
- `kick` in QuakeWorld takes a userid, not a name.
- QuakeWorld 2.33 has no player-setup menu; name, colours and skin are set at
  the console (`name`, `color`, `skin`).
- Fullscreen on a tiling compositor is the compositor's decision, as above.

## Known limitations

- The Linux build is the one that has been exercised end to end. Windows and
  macOS binaries cross-compile but are **untested**; reports welcome.
- Hostname resolution goes no further than `localhost`. Bun has no synchronous
  DNS and the C's `gethostbyname` call sites are synchronous, so connect by IP
  address.
- IPX and serial/modem network drivers are not ported, along with the DOS,
  VESA, SVGAlib and Windows-native platform layers; SDL2 replaces all of them.
- QuakeWorld's `snap` (`SCR_RSShot_f`) reads the framebuffer through the
  software renderer only — there is no GL pixel-readback seam for it yet.
- Ctrl-C on a process wedged inside one of the C's bounded synchronous
  busy-waits can take a few seconds to take effect; see PORTING.md's signal
  section for why.

## Credits and license

The engine is id Software's. This is a port, not a new game.

    Quake, QuakeWorld and GLQuake engine source
    Copyright (C) 1996-1997 Id Software, Inc.

Released by id Software on 21 December 1999 under the GNU General Public
License, version 2. This port is a derivative work distributed under the same
terms, GPL-2.0-or-later; the full text is in [LICENSE](LICENSE).

Game data is not included and remains under its own, non-GPL terms. Quake is a
registered trademark of id Software LLC; this project is not affiliated with or
endorsed by id Software, ZeniMax Media or Bethesda Softworks.
