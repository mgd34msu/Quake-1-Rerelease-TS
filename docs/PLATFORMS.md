# Platforms

The one binary -- `q1rets` (single player, NetQuake and QuakeWorld
multiplayer, and NetQuake or QuakeWorld dedicated server, all in the same
executable, selected by command-line flags -- see the README's "Running"
section) -- is built with `bun build --compile` for four targets. A release
archive can optionally also carry `q1ts`, `qwsv` and `qwcl` as copies of that
same binary under their old per-role names (`scripts/release-build.sh
--aliases`); they are not separate builds, and each still needs the same
flags as `q1rets` to pick a profile.

| Target | `bun build --target=` | Built here | Run here |
| --- | --- | --- | --- |
| Linux x64 | `bun-linux-x64` | yes | yes, this is the development platform |
| Windows x64 | `bun-windows-x64` | yes | **never tested** |
| macOS arm64 (Apple Silicon) | `bun-darwin-arm64` | yes | **never tested** |
| macOS x64 (Intel) | `bun-darwin-x64` | yes | **never tested** |

## The untested-platform statement, in plain terms

The port was written and verified on Linux x64 only. The Windows and macOS
builds compile, and every part of the platform layer that can be checked
without one of those machines is checked by the test suite -- the library
candidate lists (`test/platform_libs.test.ts`), and the `sockaddr_in` byte
layouts, socket constants and errno classification tables for all three
operating systems (`test/platform_sockets.test.ts`). What has never been run
on real hardware is everything that needs the machine itself: the actual
`socket`/`bind`/`recvfrom` calls through `ws2_32.dll` or `libSystem`, SDL2
window creation, the GL context, sound output, and reading input devices.

Treat the Windows and macOS binaries as untested builds. If one does not work,
that is expected to be a fixable bug, not a design limit -- see "Reporting a
failure" below.

## Runtime requirements

Bun is embedded in each binary. Nothing else is bundled: SDL2, OpenGL and
libvorbisfile are opened from the host at run time, the same three
dependencies the original C linked against (Xlib/DGA, libGL, and a CD-ROM
device, respectively).

None of the three is needed by `q1rets -dedicated` (NetQuake or, with `-qw`,
QuakeWorld): a dedicated server never opens a window, so it never loads
SDL2 or GL.

### Linux

Install from the distribution:

| Library | Debian/Ubuntu | Arch | Fedora |
| --- | --- | --- | --- |
| SDL2 | `libsdl2-2.0-0` | `sdl2` | `SDL2` |
| OpenGL | `libgl1` | `libglvnd` | `mesa-libGL` |
| libvorbisfile (optional) | `libvorbisfile3` | `libvorbis` | `libvorbis` |

Looked for as `libSDL2-2.0.so.0` then `libSDL2.so`; `libGL.so.1` then
`libGL.so`; `libvorbisfile.so.3` then `libvorbisfile.so`.

### Windows

- **SDL2**: put `SDL2.dll` (2.30 or newer) next to the `.exe`. Get it from
  the SDL release page's `SDL2-2.xx.x-win32-x64.zip`. It is looked for by
  bare name first (which lets Windows search the executable's own directory,
  the system directories and `PATH`), then explicitly in the executable's
  directory, then in the current directory.
- **OpenGL**: nothing to install. `opengl32.dll` ships with Windows. It
  exports OpenGL 1.1, which is the whole of what GLQuake's function table
  asks for; the handful of vendor extensions GLQuake probes for (multitexture,
  shared palettes, the EXT vertex arrays) are resolved through
  `SDL_GL_GetProcAddress`, which is `wglGetProcAddress` underneath, exactly as
  the C's `gl_vidnt.c` does.
- **libvorbisfile** (optional, for the music tracks): `libvorbisfile-3.dll`,
  `vorbisfile.dll` or `libvorbisfile.dll` next to the `.exe`, together with the
  `libvorbis`/`libogg` DLLs it depends on. Without it there is no CD audio and
  everything else works.
- **Sockets**: `ws2_32.dll` (built in). `WSAStartup` is called once, for
  Winsock 2.2, before any socket call.

### macOS

```
brew install sdl2 libvorbis
```

Both Homebrew prefixes are searched, so an Apple Silicon (`/opt/homebrew`) and
an Intel (`/usr/local`) install both work, as does a `.dylib` copied next to
the binary. OpenGL comes from
`/System/Library/Frameworks/OpenGL.framework/OpenGL` and needs no install.

Download the build that matches the machine: `darwin-arm64` for Apple Silicon
(M1 and later), `darwin-x64` for Intel. An arm64 Mac can run the x64 build
under Rosetta 2, but not the other way round.

**Gatekeeper.** These binaries are not signed and not notarized, so macOS
will refuse to run them after a download ("cannot be opened because the
developer cannot be verified"). Clear the quarantine attribute:

```
xattr -d com.apple.quarantine q1rets
```

(or `q1rets q1ts qwsv qwcl` if the archive was built with `--aliases`.)

macOS deprecated OpenGL in 10.14 and it still works; it is capped at a
compatibility profile, which is what GLQuake wants anyway. The software
renderer (`vid_ref soft`, the default) does not use GL at all.

## Overriding a library path

Each library has an environment variable that replaces the whole search list
with one explicit path. Use these when a library is installed somewhere the
default list does not look:

| Variable | Library |
| --- | --- |
| `Q1TS_SDL2_LIB` | SDL2 |
| `Q1TS_GL_LIB` | OpenGL |
| `Q1TS_VORBISFILE_LIB` | libvorbisfile |
| `Q1TS_LIBC_LIB` | the socket library (libc / libSystem / ws2_32) |

```
Q1TS_SDL2_LIB=/opt/sdl2/lib/libSDL2-2.0.so.0 ./q1rets
```

An override replaces the list rather than heading it, so a wrong path produces
an error naming that path instead of silently falling back to a system copy.

## What a missing library does

| Missing | Effect |
| --- | --- |
| SDL2 | `q1rets -dedicated` (NetQuake or, with `-qw`, QuakeWorld) keeps running normally -- it never opens a window, so it never needs SDL2. A **client** (`q1rets` without `-dedicated`, either profile) prints the search error and then exits with `Couldn't fall back to software refresh!`, because there is no other way to draw: both renderers put their pixels on screen through SDL. The message names every path tried. |
| OpenGL | `vid_ref gl` fails and falls back to the software renderer, the same path a rejected video mode takes. The default renderer is `soft`, so a machine with no usable GL is unaffected until it asks for GL. |
| libvorbisfile | No CD audio (the music tracks). Everything else works. This is deliberate: the C's `cd_linux.c` behaves the same way when it cannot open `/dev/cdrom`. |
| the socket library | `UDP_Init` returns -1, exactly as `-noudp` does, and the engine runs with the loopback driver only: single player works, network play does not. |

## Where the engine writes

By default the engine writes nothing into the game install. `config.cfg`,
savegames, autosaves, demos, screenshots and `qconsole.log` go to a per-user
directory, mirrored per game directory (`<home>/id1/`, `<home>/hipnotic/`, and
so on), created on demand and mounted at the head of the search path so those
files are found before the install's own copies. The install under `-basedir`
stays read-only, including each game directory's own `config.cfg`, which is
still exec'd and never overwritten.

| Platform | `<home>` with neither `-homedir` nor `-nohomedir` |
| --- | --- |
| Linux | `$XDG_DATA_HOME/q1rets`, or `~/.local/share/q1rets` when that variable is unset |
| macOS | `$XDG_DATA_HOME/q1rets` if set, otherwise `~/.local/share/q1rets` -- not `~/Library/Application Support`; untested, see the untested-platform statement above |
| Windows | `%XDG_DATA_HOME%\q1rets` if set, otherwise `%HOME%\.local\share\q1rets`; `%HOME%` is often unset on Windows, and with neither variable set the engine falls back to writing into the basedir as `-nohomedir` does. Untested. |

`-homedir <dir>` picks a different root; `-nohomedir` writes into
`<basedir>/<gamedir>` the way WinQuake did. This is a quality-of-life
addition over WinQuake, matching what QuakeSpasm and Ironwail do on Linux.

## Known platform limits

- **Windows console input.** `Sys_ConsoleInput` reads `stdin` as a stream.
  A dedicated server started from `cmd.exe` or PowerShell accepts typed
  commands; one started with no console attached (`start /b`, a service
  wrapper) has no stdin to read and takes no console commands. Same as on
  Linux with stdin closed.
- **Windows signals.** Windows has no `SIGTERM`. `Ctrl-C` (`SIGINT`) and
  `Ctrl-Break` (`SIGBREAK`) run the same clean shutdown -- config written,
  clients told the server is going away -- that `SIGINT`/`SIGTERM` run on
  Linux and macOS. A `taskkill` without `/f` sends a window-close message
  rather than a signal and is not handled; `taskkill /f` is an immediate
  termination with no shutdown, the same as `kill -9`.
- **Windows error text.** Winsock errors are reported by number
  (`Winsock error 10054`), not as a sentence: `ws2_32.dll` has no `strerror`,
  and the C runtime's would decode a Winsock code as an unrelated C `errno`.
  The C engine has the same bug and prints garbage; this prints the number.
- **No IPv6 anywhere.** The C is IPv4-only (`sockaddr_in`, dotted quads) and
  so is this port, on every platform.
- **No name resolution.** Neither the C's blocking `gethostbyname` path nor a
  replacement is used: server addresses must be dotted quads (`192.0.2.10`,
  `192.0.2.10:27500`), plus the literal name `localhost`. This is a port-wide
  ruling, not a platform limit, but it bites first when connecting by name.
- **macOS Retina scaling** has not been checked. The window is created at the
  requested pixel size; on a HiDPI display SDL may hand back a backing store
  at a different scale than the software renderer's blit expects.
- **Windows/macOS writable directory.** The default write root is chosen from
  `$XDG_DATA_HOME`/`$HOME` only (see "Where the engine writes" above); no
  `%APPDATA%` or `~/Library/Application Support` lookup exists yet, so on
  Windows the practical answer today is `-homedir <dir>` or `-nohomedir`.
- **Resident memory, and the `8.0 megabyte heap` line.** That line is the
  hunk figure the original C printed for its one `malloc`ed block, and it has
  nothing to do with what this port actually holds: `Hunk_AllocName` is one
  `new Uint8Array` per call and `Hunk_FreeToLowMark` is a no-op
  (`src/common/zone.ts`), so the number is bookkeeping. The real cost of a
  boot, measured on Linux x86-64, is around 400MB resident before a map is
  loaded -- a dedicated server with no level at all settles at 418MB after a
  minute of idling. Roughly 33MB of that is the Bun runtime, ~130MB more is
  parsing and JIT-compiling the bundled engine (`bun build --compile` embeds
  both), ~40MB is SDL shared memory even under the dummy video and audio
  drivers, and the rest is JavaScriptCore's heap reaching its working size
  over the first minute of the frame loop.
- **Resident memory tracks the biggest map played, not the current one.**
  JavaScriptCore does not return pages to the OS when a level is unloaded, so
  a long rotation reads as a series of steps up (mgdm1 ~470MB, mgdm3 ~640MB)
  that never step back down. This is a high-water mark, not a leak: with a
  full collection forced before each reading, the bytes actually retained are
  flat across repeated visits to the same map (mgdm1 holds 40.7MB of
  typed-array data on its first visit and 44.1MB on its third and fifth,
  while resident memory over the same visits reads 641MB, 930MB, 929MB).
  `test/e2e/z_soak.ts` asserts against the retained shape rather than the
  resident number for this reason.
- **Case-sensitive game data.** Only Linux (and a case-sensitive macOS volume)
  needs this, and it is handled: a mixed-case `Id1/PAK0.PAK` is found by a
  case-insensitive directory scan. Windows and the default macOS filesystem
  are case-insensitive already.

## Reporting a failure

Include:

1. The OS and CPU, and which build was downloaded (`windows-x64`,
   `darwin-arm64`, ...).
2. **The whole library-search error, pasted verbatim.** It lists every path
   that was tried and what each one said, which is the single most useful
   thing in a report -- for example:

   ```
   SDL: could not load SDL2. Tried:
     SDL2.dll: LoadLibrary failed
     C:\Games\Quake\SDL2.dll: LoadLibrary failed
     D:\work\SDL2.dll: LoadLibrary failed
   Set Q1TS_SDL2_LIB to the full path of the library to override this list.
   ```

3. The exact command line, including which of `-dedicated`/`-qw` were
   passed, and whether the binary was `q1rets` or one of its `--aliases`
   copies (`q1ts`/`qwsv`/`qwcl`).
4. For a graphics problem: the value of `vid_ref` (`soft` or `gl`), and
   whether the other one works.
5. For a network problem: whether `q1rets -dedicated +map start` on the
   same machine starts and prints `UDP Initialized`.

`Q1TS_NOHOMEDIR=1` in the environment has the same effect as `-nohomedir` for a
boot that passes neither flag; `bun run test` and `scripts/sandbox-verify.sh`
export it so unit tests never read or write the real per-user directory. The
e2e drivers pass an explicit `-homedir` under their scratch directory instead.
