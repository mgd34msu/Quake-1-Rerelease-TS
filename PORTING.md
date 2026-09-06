# Quake (v1.09 GPL, Dec 1999) → TypeScript port conventions

Source tree: id's own GPL release of the Quake sources, unpacked next to this
repository as `../qsrc/quake` (see its `readme.txt`). Runtime: bun. This file is
the contract every change follows; the check gate is `bun run check`.

Conventions inherited from a sibling port of the Quake 2 sources (`quake-2-ts`,
not part of this repository) are restated here wherever they matter. References
to it below are provenance, not a dependency: nothing in this tree needs it.

Track order: WinQuake (single player + NetQuake multiplayer) is the complete,
runnable first deliverable. QuakeWorld (`QW/client`, `QW/server`) is a second
track that starts only after WinQuake plays with both renderers. Mission packs
need no code: they are QuakeC data (`progs.dat` inside their paks) plus the
`-hipnotic`/`-rogue` command-line handling that WinQuake already contains.

Not ported (ruled 2026-09-03, see `.orch/decisions.tsv`): `gas2masm/`,
`Mission Packs/quake-mp1/extras` (qbsp/light tool sources, maps, exes),
`QW/qwfwd/`, all `.s` assembly files and the headers that exist only for them
(`quakeasm.h`, `asm_i386.h`, `asm_draw.h`, `d_ifacea.h`, `block8.h`, `block16.h`),
the DOS/VESA/Sun/serial/IPX/Bangware platform files, and the vendored `dxsdk/`,
`scitech/`, `kit/`, `data/`, `docs/` directories. The Quake re-release is out of
scope entirely.

## Runtime and build

- `bun src/main.ts` runs from source. `bun run build` produces the single
  standalone binary `q1ts` via `bun build --compile`.
- SDL2 through `bun:ffi` is the one native windowing/input/audio layer. libGL is
  bound through the `QGL` function table (`src/ref_gl/qgl.ts`), loaded via SDL's
  GetProcAddress. `src/platform/` starts as a copy of `../quake-2-ts/src/platform/`
  (`sdl.ts`, `glimp.ts`, `swimp.ts`, `snd.ts`, `cd_ogg.ts`, `net_udp.ts`, `sys.ts`,
  `vid_scale.ts`) re-pointed at this engine's interfaces; it is adapted, not rewritten.
- Every native library is opened lazily, by name, through one resolver:
  `src/platform/libs.ts`. It holds the candidate list per library per OS (SDL2,
  OpenGL, libvorbisfile, and the socket library), tries them in order, honours a
  `Q1TS_SDL2_LIB`/`Q1TS_GL_LIB`/`Q1TS_VORBISFILE_LIB`/`Q1TS_LIBC_LIB` override,
  and on failure produces one message naming every path tried. No other module
  hardcodes a library file name. A failed load is never fatal: no SDL2 means
  headless, no libGL means the software renderer, no libvorbisfile means no CD
  audio, no socket library means the loopback driver only (as `-noudp`).
- The socket calls both LAN drivers make live in `src/platform/sockets.ts`, which
  is the port's substitute for the C shipping `net_udp.c` (BSD) and `net_wins.c`
  (Winsock) side by side: the entry-point names, the `sockaddr_in` layout
  (macOS's BSD `sin_len`/`sin_family` byte pair versus Linux's and Windows's
  16-bit family), the ioctl/sockopt constants, the errno accessor
  (`__errno_location`/`__error`/`WSAGetLastError`) and the errno classification
  tables the C spells out per platform. Everything above the FFI boundary there
  is a pure function of the target OS, so all three tables are unit-tested from
  the one Linux host (`test/platform_sockets.test.ts`).
- Release builds: `bun run build:release` cross-compiles all three binaries for
  `linux-x64`, `windows-x64`, `darwin-arm64` and `darwin-x64` into `dist/` via
  `scripts/release-build.sh`. Only Linux is executed and verified here; the other
  three are shipped as untested builds, and `docs/PLATFORMS.md` says so, lists
  what each OS needs installed, and says how to report a failure.
- Both renderers are compiled in and selected at runtime. Quake has no such switch
  (`GLQUAKE` is a compile-time define), so this port adds one cvar, `vid_ref`
  (`soft` | `gl`, archived, default `soft`), with the same load/fallback mechanics as
  Quake 2's `VID_CheckChanges`. This is a documented addition, the only new
  user-facing cvar the port introduces.
- Because `VID_Init` reads `vid_ref` before `quake.rc` (and so before `stuffcmds`
  runs any `+` argument), the renderer is also selectable with a command-line parm,
  `-vid_ref <soft|gl>`, read by `COM_CheckParm` inside `VID_Init` itself -- the same
  pre-init convention WinQuake uses for `-dedicated`, `-mem` and vid_x.c's
  `-width`/`-height`/`-winsize`; `vid_restart` after setting the cvar is the runtime
  path. All three binaries honour it. Command-line parms override archived cvars
  for the session, as the C's `-width`/`-height` do: `-vid_ref` is re-applied to
  the `vid_ref` cvar on every `VID_CheckChanges`, not just at boot, so `vid_ref`
  being archived (`config.cfg`'s own line re-executing on the next launch) can
  never silently switch the renderer the parm asked for.
- sys_linux.c/QW's sys_unix.c install no `signal(SIGINT, ...)`/`signal(SIGTERM,
  ...)` handler at all (grepped both C trees in full: absent) -- Ctrl-C/`kill`
  on the real engine is the OS default action, immediate termination, no
  `Host_Shutdown`/`SV_Shutdown`, no config write. This port deliberately installs
  one anyway (`src/platform/sys.ts`'s `installTerminationSignals`, called once
  from each binary's own `main()`): a dedicated server killed with Ctrl-C or
  `kill` should still write its config and send clients a final message, the
  same as typing `quit` at its own console does. The one-bullet deviation this
  entails: registering a `process.on("SIGTERM"/"SIGINT")` handler changes the
  signal's disposition from "the OS terminates the process immediately,
  regardless of what it's doing" to "queue the JS callback for the next time
  the event loop is free" -- Node/Bun's signal delivery for a *handled* signal
  is cooperative with the event loop, not asynchronous like the OS default is.
  A process wedged in a **synchronous, non-yielding** loop therefore cannot
  respond to SIGTERM/SIGINT at all until that loop returns control -- confirmed
  directly (`bun -e 'process.on("SIGTERM",()=>process.exit(0));while(true){}'`
  survives a `kill -TERM` indefinitely, where the same loop with no handler
  registered dies from the OS default instantly). `Sys_Main_Loop`'s own
  `await Bun.sleep(1)` after every `Host_Frame` call exists in part to keep
  this window bounded to one frame; a synchronous busy-wait *inside* a frame
  (e.g. `src/common/net_dgrm.ts`'s `_Datagram_Connect`, a `do { ... } while
  (ret === 0 && SetNetTime() - start_time < 2.5)` retry loop with no `await`
  anywhere in its body) reopens that window for up to its own bound (2.5s
  here) per call -- bounded C-style busy-waits translated straight from the
  original's blocking-socket retry loop are the only such loops this port
  knows of, and they are the reason a killed process can take a few seconds
  longer to die than an idle one, not a hang. This is a real, accepted
  trade-off of the deviation, not a defect in the handler itself: there is no
  pure-JS way to make a single-threaded event loop preempt a synchronous
  stretch of its own code, so the alternative would be dropping the graceful
  Ctrl-C handling entirely. `test/sys_exit.test.ts` documents both halves of
  this (the graceful case, and the busy-loop-defers-signals limitation)
  directly; if a future unit finds an *unbounded* synchronous loop reachable
  from a running server, that loop is the bug to fix (restore the missing
  `await`), not this handler. Windows has no `SIGTERM` at all (libuv can only
  watch `SIGINT`, `SIGBREAK`, `SIGHUP` and `SIGWINCH` there, and asking for
  anything else is an error rather than a handler that never fires), so
  `installTerminationSignals` registers `SIGINT` + `SIGBREAK` on `win32` and
  `SIGINT` + `SIGTERM` everywhere else, each inside its own `try` so a
  refused signal simply keeps its OS default -- which is what the C does with
  every signal anyway.
- Mouse capture is a documented deviation from `vid_x.c` (`src/platform/sdl.ts`):
  the reference file grabs/ungrabs the X11 pointer only on an edge of
  `_windowed_mouse`'s value, with no `key_dest` or window-focus check at all,
  so a window left at that cvar's faithful 1999 default (`"0"`, X11's opt-in
  etiquette) never captures the mouse in or out of a level -- the reported
  defect this port fixes. `wantMouseCapture` now grabs the mouse (SDL relative
  mode, cursor hidden via `SDL_ShowCursor`) whenever the window has focus and
  either the view is fullscreen or `key_dest == key_game`, and releases it for
  the console, a menu, chat entry, or a lost window focus (SDL's
  `SDL_WINDOWEVENT_FOCUS_LOST`/`GAINED` re-captures on refocus), matching what
  every maintained Quake engine does today. `_windowed_mouse` stays registered
  for config-file compatibility but no longer gates capture, and its default
  moves from `"0"` to `"1"`.

## Directory and file mapping (WinQuake)

WinQuake is one flat directory. The port groups it; every `.c` keeps its basename.

| C | TS |
|---|---|
| `quakedef.h`, `common.h`/`common.c` | `src/common/quakedef.ts`, `src/common/common.ts`; the `SZ_*`/`MSG_*` half of common.c → `src/common/sizebuf.ts` |
| `mathlib.h`/`.c` | `src/common/mathlib.ts` (Vec3 helpers, `anglemod`, `BoxOnPlaneSide`, `RotatePointAroundVector`) |
| `cmd`, `cvar`, `crc`, `zone`, `wad`, `host`, `host_cmd` | `src/common/<basename>.ts` |
| `bspfile.h`, `modelgen.h`, `spritegn.h`, `protocol.h` | `src/common/bspfile.ts`, `modelgen.ts`, `spritegn.ts`, `protocol.ts` (on-disk and wire formats, DataView-parsed) |
| `net.h`, `net_main.c`, `net_loop.c`, `net_dgrm.c`, `net_vcr.c` | `src/common/net.ts`, `net_main.ts`, `net_loop.ts`, `net_dgrm.ts`, `net_vcr.ts`. The `net_driver_t`/`net_landriver_t` tables keep their shape. |
| `net_udp.c`, `net_wins.c`, `net_bsd.c` | `src/platform/net_udp.ts` (one LAN driver, ported from the unix `net_udp.c`, on BSD sockets through `src/platform/sockets.ts`). `net_wins.c` is read for the Windows spellings that layer needs (`closesocket`/`ioctlsocket`/`WSAGetLastError`, the WSA error codes) but is not separately ported. `net_ser/net_comx/net_ipx/net_wipx/net_bw/net_mp/net_dos/net_win/net_none/mplib/mplpc` are not ported. |
| `model.h`/`model.c` + `gl_model.h`/`gl_model.c` | See "Model loading" below. Shared loader in `src/common/model.ts`; renderer-specific loaders in `src/ref_soft/model.ts` and `src/ref_gl/gl_model.ts`. |
| `progs.h`, `pr_comp.h`, `progdefs.q1` | `src/progs/progs.ts`, `pr_comp.ts`, `progdefs.ts`. `progdefs.q1` is canonical (CRC 5927); `progdefs.h` in the tree is the build's stale copy. |
| `pr_edict.c`, `pr_exec.c`, `pr_cmds.c` | `src/progs/<basename>.ts` |
| `server.h`, `sv_main`, `sv_phys`, `sv_move`, `sv_user`, `world.h`/`world.c` | `src/server/<basename>.ts` |
| `client.h`, `cl_main`, `cl_parse`, `cl_input`, `cl_tent`, `cl_demo`, `chase`, `console`, `keys`, `menu`, `sbar`, `view`, `r_part` | `src/client/<basename>.ts`. The `#ifdef GLQUAKE` branches in `view.c`, `r_part.c`, `cl_parse.c`, `host.c` go through the renderer seam (below); the file itself is ported once. |
| `screen.h`, `screen.c` + `gl_screen.c` | `src/client/screen.ts` ported from `screen.c`; the ~400 lines that differ under GLQUAKE (frame bracketing in `SCR_UpdateScreen`, `SCR_ScreenShot_f`, the GL-only `gl_*` cvars) become seam methods with one implementation per renderer. The seam unit lists the exact split in its report. |
| `render.h`, `draw.h`, `vid.h` | `src/client/render.ts` (the `Renderer` interface, this port's `refexport_t`), `src/client/draw.ts` (types only), `src/client/vid.ts` (`viddef_t`, `VID_*` interface) |
| `sound.h`, `snd_dma`, `snd_mem`, `snd_mix` | `src/client/<basename>.ts`; `snd_win/snd_dos/snd_linux/snd_sun/snd_gus/snd_next/snd_null` → `src/platform/snd.ts` (`SNDDMA_*`) |
| `input.h`; `in_win/in_dos/in_sun/in_null` | `src/client/input.ts` (interface); implementation inside `src/platform/sdl.ts` |
| `cdaudio.h`; `cd_win/cd_linux/cd_audio/cd_null` | `src/client/cdaudio.ts`; `src/platform/cd_ogg.ts` (music/NN.ogg via libvorbisfile, as in quake-2-ts) |
| `sys.h`; `sys_linux/sys_win/sys_dos/sys_sun/sys_wind/sys_null/conproc/dos_v2/vregset` | `src/platform/sys.ts` (one bun implementation; the only per-OS branch left in it is the signal list, since Windows has no `SIGTERM`) |
| (no C equivalent: the C's linker and headers) | `src/platform/libs.ts` (which file name each native library has on each OS, plus the `Q1TS_*_LIB` overrides) and `src/platform/sockets.ts` (the per-OS socket entry points, `sockaddr_in` layout, constants and errno tables both `net_udp.ts` files sit on) |
| `vid_win/vid_x/vid_svgalib/vid_dos/vid_ext/vid_vga/vid_sunx/vid_sunxil/vid_null`, `gl_vidnt/gl_vidlinux/gl_vidlinuxglx` | `src/platform/vid.ts` + `swimp.ts` (8-bit framebuffer → SDL streaming texture) + `glimp.ts` (SDL GL context) |
| `r_*.c`, `d_*.c`, `draw.c`, `nonintel.c`, `r_local.h`, `r_shared.h`, `d_local.h`, `d_iface.h`, `adivtab.h`, `anorms.h`, `anorm_dots.h` | `src/ref_soft/<basename>.ts` (`r_part.c` excepted, see client row). `nonintel.c` is the `id386 == 0` path and is the one that gets ported. |
| `gl_draw`, `gl_mesh`, `gl_refrag`, `gl_rlight`, `gl_rmain`, `gl_rmisc`, `gl_rsurf`, `gl_warp`, `gl_test`, `glquake.h`, `gl_warp_sin.h` | `src/ref_gl/<basename>.ts`; `src/ref_gl/qgl.ts` starts from quake-2-ts's table extended with the entry points `gl_*.c` uses (`glColor3f`, `glColorTableEXT`, `glMTexCoord2fSGIS`/`glSelectTextureSGIS`, the `*PointerEXT` vertex-array family, `glFogf/glFogfv/glFogi`, `glDrawBuffer/glReadBuffer`, `glDepthRange`, `glPolygonMode`) |
| `sys_linux.c`'s `main` + `host.c`'s `Host_Init/Host_Frame` | `src/main.ts` |

Entry point: `src/main.ts`. Dedicated server: `-dedicated` on the command line, same
as WinQuake (`isDedicated` in `sys.ts`); the client subsystems return early on it.

## Model loading (the one place the C is not one-file-one-module)

WinQuake links either `model.c` or `gl_model.c`; both load the same BSP, alias, and
sprite files but build different in-memory shapes for the renderer, while the
server needs only brush-model data (hulls, nodes, leafs, planes, visdata,
entities, submodels) from whichever one is linked. `QW/server/model.c` is id's own
trimmed server-only loader and is the proof of where the line falls.

- `src/common/model.ts` ports the server-visible loader: `Mod_Init`, `Mod_ForName`,
  `Mod_FindName`, `Mod_ClearAll`, `Mod_PointInLeaf`, `Mod_LeafPVS`, `Mod_DecompressVis`,
  and the brush lumps every consumer needs (`Mod_LoadVertexes`, `Edges`, `Planes`,
  `Nodes`, `Leafs`, `Clipnodes`, `Submodels`, `Entities`, `Visibility`, `Mod_MakeHull0`,
  `Mod_SetParent`). `model_t`'s fields are the union of `model.h` and `gl_model.h`.
- The active renderer installs a `ModelLoaderHooks` object (`textureLoaded`
  (the one per-renderer step inside the now-shared, unconditional
  `Mod_LoadTextures` -- WinQuake links it into the dedicated server too, so
  it always runs and cannot be a hook itself), `Mod_LoadLighting`,
  `Mod_LoadFaces`/`Texinfo`/`Marksurfaces`/`Surfedges` where they differ,
  `Mod_LoadAliasModel`, `Mod_LoadSpriteModel`, `GL_SubdivideSurface`).
  `src/ref_soft/model.ts` and `src/ref_gl/gl_model.ts` are those two hook sets, each
  ported from its own C file. With no renderer installed (dedicated), alias and
  sprite loads populate only `mins/maxs/flags/numframes/type`, which is what
  `QW/server/model.c` does.
- One `mod_known` table, one load per file, exactly as the C.

## Renderer seam

`src/client/render.ts` declares `interface Renderer` from `render.h` + `draw.h` +
the GLQUAKE-guarded pieces of `view.c` (`V_CalcBlend`, `V_UpdatePalette`), `r_part.c`
(`R_DrawParticles`), `cl_parse.c` (`R_TranslatePlayerSkin`), and `screen.c`
(`SCR_UpdateScreen`'s frame bracketing, `SCR_ScreenShot_f`). Each renderer exports a
`GetRenderer(): Renderer`. Particle *simulation* stays in `src/client/r_part.ts`;
only drawing crosses the seam. Nothing outside `src/ref_soft` and `src/ref_gl`
imports either renderer except `src/platform/vid.ts`, which selects one from
`vid_ref`. The seam unit ports `render.h` first and reports every method it had to
add beyond the header.

## QuakeC virtual machine

This port runs `progs.dat` bytecode exactly as WinQuake does. No QuakeC is
transliterated. `../qsrc/quake/progs106/progs.dat` (version 6, CRC 5927, the retail
build) is the test fixture; `progs106/*.qc` is reference for builtin semantics.

- `progs.dat` is parsed with `DataView` per `pr_comp.h` (`dprograms_t`, `dstatement_t`,
  `ddef_t`, `dfunction_t`) into typed arrays: statements as four `Int16Array`s (or one
  interleaved), functions and defs as arrays of small classes. Little-endian only.
- `pr_globals` is one `ArrayBuffer` with `Float32Array` and `Int32Array` views over the
  same bytes. `G_FLOAT(o)`, `G_INT(o)`, `G_VECTOR(o)` (a `subarray` view, length 3),
  `G_STRING(o)`, `G_EDICT(o)`, `G_FUNCTION(o)` are exported functions in `progs.ts`.
  `pr_global_struct` (`globalvars_t`) is an accessor object whose getters/setters hit
  fixed offsets from `progdefs.q1`.
- Each `EdictT` owns one `ArrayBuffer` of `progs.entityfields * 4` bytes with
  `Float32Array`/`Int32Array` views. `ent.v` is an `EntVars` accessor class generated
  from `progdefs.q1`'s `entvars_t`: scalar fields are getters/setters, vector fields
  return a persistent `subarray` view so `VectorCopy(ent.v.origin, out)` works with
  zero copies and `Vec3 = Float32Array` semantics hold. Fields beyond `entvars_t`
  (QuakeC-declared) are reached by offset via `E_FLOAT/E_INT/E_VECTOR/E_STRING(ed, ofs)`.
- `string_t`: progs strings stay offsets into the string block. The C also stores
  engine strings by pointer difference (`host_client->name - pr_strings`,
  `m - pr_strings` in `PF_setmodel`), which has no TS equivalent. Ruling: an engine
  string table in `progs.ts` — `PR_SetEngineString(s): number` (QW's own host calls
  it `PR_SetString`) returns `ENGINE_STRING_BASE + n`, and `PR_GetString(n): string`
  resolves either kind: `0 <= n < ENGINE_STRING_BASE` is a progs-block offset,
  `n >= ENGINE_STRING_BASE` is an engine string, anything else is a `Sys_Error`
  (the C would read whatever `pr_strings + n` pointed at; a bounds error is the
  faithful-but-safe port behaviour). `ED_NewString` allocates there too. This is the
  port's one deviation inside the VM; every call site keeps its C name and shape.

  **Engine string indices must be positive.** They were negative until 2026-09-05,
  matching the C's `-num_prstr` and the "pointer below `pr_strings`" test, and that
  silently destroyed engine strings at runtime. The globals block and every edict's
  field block are one `ArrayBuffer` viewed as both `Int32Array` and `Float32Array`.
  Every negative int32 in `[-0x7FFFFF, -1]` has all float32 exponent bits set with a
  non-zero mantissa — it *is* a NaN bit pattern — and JavaScript does not preserve
  NaN payloads across a float read/write: `f[b] = f[a]` canonicalises to
  `0x7FC00000`. qcc moves **every** builtin argument with `OP_STORE_V`, a three-word
  float copy, so a negative `string_t` was wiped on the way into `setmodel`, `find`,
  `precache_sound` and the rest. (Proven on retail data: doors.qc `func_door`
  statements `OP_LOAD_S self.model -> t`, `OP_STORE_V t -> OFS_PARM1`,
  `OP_CALL2 setmodel` — `PF_setmodel` then wrote `0x7FC00000` into `e.v.model`.)
  `ENGINE_STRING_BASE` is `0x40000000`: above every progs string offset, below
  `0x7F800000` (the smallest int32 that reinterprets as a NaN), so every `string_t`
  the engine hands to progs is an ordinary finite float32 and round-trips a float
  copy exactly. Progs-block offsets were always safe for the same reason — they are
  small positive ints. Never encode any progs-visible value as a negative int32 that
  can reach a float view; if a new one is needed, base it above `0x40000000` too.
- `EDICT_TO_PROG`/`PROG_TO_EDICT`: the C stores a byte offset. This port stores the
  edict index (`sv.edicts[i]`). Savegame text uses `NUM_FOR_EDICT` in both, so the
  on-disk format is unaffected. Report any place that inspects the raw value.
- `PR_ExecuteProgram` is a `switch` over `OP_*` with the C's exact per-op semantics,
  including the `100000` runaway-loop check, `pr_depth`/`MAX_STACK_DEPTH`,
  `localstack`, and the `OP_STATE` frame/think idiom. `PR_RunError` throws `HostError`.
- Builtins: `pr_builtin[]` in `pr_cmds.ts`, same numbering, same `PF_` names.
  `PF_Fixme` throws exactly where the C does.
- `ED_Write`/`ED_ParseEdict`/`ED_ParseGlobals` (savegame text) must produce
  byte-identical output to the C: `%f` formatting in `Com_sprintf` follows printf
  rounding, and field order follows `pr_fielddefs` order.

## Memory (zone.c)

`Hunk_*`, `Cache_*`, `Z_*` keep their names and call sites; their bodies are
allocation-free wrappers:

- `Hunk_AllocName`/`Hunk_Alloc`/`Hunk_HighAllocName`/`Hunk_TempAlloc` → allocate the
  typed array or object the caller needs. `Hunk_LowMark`/`FreeToLowMark`/`HighMark`/
  `FreeToHighMark`/`Hunk_Check` are no-ops that still exist, because they bracket
  temporary loads in the C and the call order is part of the fidelity.
- `cache_user_t` → `class CacheUser<T> { data: T | null }`. `Cache_Alloc` sets `data`,
  `Cache_Check` returns it, `Cache_Free` nulls it. Eviction never happens; `Cache_Flush`
  (the `flush` command) nulls every user so the next `Cache_Check` misses and reloads,
  which is the observable C behaviour. `Cache_Report`/`Hunk_Print`/`Z_Print` print a
  line saying the port has no allocator statistics.
- `Z_Malloc`/`Z_Free` → plain allocation. `Memory_Init` keeps its signature.

## Core data shapes (unchanged from quake-2-ts unless listed)

- `type Vec3 = Float32Array` (length 3), `vec3()` in `src/common/mathlib.ts`. Out-param
  style everywhere: `VectorAdd(a, b, out)`.
- C `int` arithmetic truncates: `| 0`; unsigned: `>>> 0`.
- C structs → `class` with every field initialised in the declaration. `memset` →
  `clear()`.
- `qboolean` → `boolean`; C truthiness on ints/pointers made explicit.
- C enums → TS `enum` with the same numeric values (`svc_*`, `clc_*` cross the wire).
  `#define` constants → `export const`.
- `sizebuf_t` → `SizeBuf` over `Uint8Array` + `DataView`; `MSG_Write*`/`MSG_Read*`
  byte-exact with protocol 15. `MSG_WriteCoord`/`WriteAngle` keep the C's
  `(int)(f*8)` / `((int)f*256/360) & 255` truncation.
- `link_t` (the doubly linked `area` lists in `world.c`) → a small `Link` class with
  `prev/next` object references; `STRUCT_FROM_LINK` becomes a `owner` back-reference.
- Binary formats (`bspfile.h`, `modelgen.h`, `spritegn.h`, `wad.h`, PAK, LMP, PCX-less:
  Quake uses raw 8-bit lumps) → `DataView` at C offsets.
- `entity_state_t`, `usercmd_t`, `client_t`, `server_t`, `client_state_t` keep the C
  field names.

## Globals and module structure

- Shared mutable globals (`sv`, `svs`, `cl`, `cls`, `host_client`, `sv_player`,
  `pr_global_struct`, `r_refdef`, `vid`, `scr_vrect`) become exported `const` singleton
  objects mutated in place, declared in the module that owns them in C, never
  reassigned; `memset` → `clear()`.
- C globals that are reassigned pointers (`host_client`, `sv_player`, `currententity`,
  `loadmodel`, `cl.worldmodel`) become fields on their owning singleton or a small
  exported holder with a setter. Header modules (`quakedef.ts`, `server.ts`,
  `client.ts`, `progs.ts`, `r_local.ts`, `glquake.ts`) hold shared types, constants,
  and singletons. `import type` for type-only imports.
- Import-cycle rule as quake-2-ts: the *less fundamental* module resolves lazily with
  Bun's synchronous `require()`; report each use.
- No `console.log` outside `src/platform/sys.ts` (`Sys_Printf` is the one print
  boundary).

## Idiom map

- `Sys_Error` → `class SysError extends Error`; `Host_Error` → `class HostError`
  thrown and caught by `Host_Frame`'s `longjmp` equivalent (`try/catch` around
  `_Host_Frame`); `Host_EndGame` → `class HostEndGame`. Never throw bare strings.
- `Con_Printf`/`Con_DPrintf`/`Sys_Printf` varargs → `Com_sprintf(fmt, ...args)` in
  `src/common/sprintf.ts` (libc's vsprintf, not a Quake file; `%s %d %i %u %f %g %c %x
  %%`, width/precision as used, printf rounding for `%f`); `va()` → template literals
  when trivial. `Sys_Error`/`Sys_Printf`/`Sys_Quit`/`Sys_FloatTime` are already in
  `src/platform/sys.ts` and `Con_Printf`/`Con_DPrintf`/`Con_SafePrintf` in
  `src/client/console.ts` (a placeholder U047 replaces); import them, never redeclare.
- `strcpy/strncpy/Q_strcasecmp/strtok` → string operations; `COM_Parse` keeps a
  parse-state object; `com_token` becomes its return value.
- `#ifdef _WIN32/__linux__/id386/GLQUAKE/QUAKE2/SWDS` → take the portable, non-asm
  path; GLQUAKE branches go through the seam; `QUAKE2` (the abandoned Quake 2
  prototype blocks in `sv_phys.c`, `cl_parse.c`, `menu.c`) and `#if 0` are dropped
  silently.
- `goto` → early return / labelled break / state flag, original order preserved.
- `rand()`/`random()` → `Math.random()`-backed helpers in `mathlib.ts`.
- File I/O: `node:fs` sync calls only in `src/platform` and `src/common/common.ts`
  (`COM_*File*`, PAK parsing per `common.c`'s `pack_t`/`dpackfile_t`).
- Game directory / pak case-insensitivity: id Software's own distribution ships
  `Id1/PAK0.PAK`; the C built `%s/id1` and `pak%i.pak` lowercase and relied on
  DOS/Windows case-insensitivity, so `COM_AddGameDirectory` (and QW's
  `COM_Gamedir`) resolve the game directory and each `pak%i.pak` through
  `Sys_ResolveCase` (`src/platform/sys.ts`) on this case-sensitive target;
  `COM_FindFile`'s loose-file lookup stays case-sensitive, matching the C.
- `Sys_FloatTime` → monotonic clock in `src/platform/sys.ts`, seconds as double.
- CD audio → `cd_ogg.ts`; the physical CD is replaced by `music/NN.ogg` rips
  (Quake tracks 2–11; mission packs have their own).

## Type discipline (enforced)

`tsc --strict` with zero `any` (grep-gated, including `as any`, `<any>`, `any[]`).
No `as` casts except `as const`; parse external bytes/strings into typed shapes at
the boundary and trust the types inside. Discriminated unions where the C switches
on a type tag. Exhaustive switches get `default: { const _exhaustive: never = x; }`
only where the input type is closed.

## What "done" means for a unit

`bun run check` passes with the unit's files included, the module exports what its C
header exported, tests are self-sufficient, and TODOs are absent — a function you
cannot port faithfully is a reported deviation, not a `// TODO`.

## QuakeWorld track (QW 2.33: `QW/client`, `QW/server`, `QW/progs`)

QuakeWorld is two more binaries built from a modified copy of the WinQuake tree:
`qwcl` (client, protocol 28, client-side prediction) and `qwsv` (standalone server).
Measured against WinQuake: 15 client files are byte-identical, ~40 differ by fewer than
200 lines (renderers, sound, memory, math: `#include`/ifdef churn plus small QW hooks),
and the rest differ wholesale or are new (`cl_ents`, `pmove`, `pmovetst`, `cl_cam`,
`net_chan`, `cl_pred`, `skin`, `md4`, `gl_ngraph`; the whole server).

Rulings:

- **One engine, two extra entry points.** `src/qw/main_cl.ts` (qwcl: `sys_linux.c` main +
  `Host_Init/Host_Frame` from QW `client/cl_main.c`) and `src/qw/main_sv.ts` (qwsv:
  `server/sys_unix.c` main + `SV_Init/SV_Frame`). `package.json` gains `start:qwcl`,
  `start:qwsv`, `build:qwcl`, `build:qwsv`.
- **Identical files are not re-ported**: the QW binary imports the landed WinQuake module.
- **Small deltas fold into the landed module** under a runtime flag `qw.active` (holder in
  `src/common/quakedef.ts`, set true by the QW entry points before Host_Init). Each branch
  carries a comment naming the QW file and line it comes from. This is the port's
  equivalent of the `#ifdef QUAKEWORLD` id never wrote; the C keeps two trees instead. A
  delta qualifies as "small" when it is additive and under ~200 changed lines; the unit
  brief lists them.
- **Wholesale-different and new files** get their own modules under `src/qw/client/` and
  `src/qw/server/`, one `.ts` per `.c`, same basename, ported fresh from the QW source
  (starting from the landed WinQuake port where the C started from WinQuake).
- **Client state is a superset.** `ClientStateT`/`ClientStaticT` in `src/client/client.ts`
  keep the WinQuake fields and gain a `qw` member (`QwClientStateExtT` / `QwClientStaticExtT`,
  defined in `src/qw/client/client.ts`) holding QW-only fields (`players[]`, `frames[]`,
  `validsequence`, `spectator`, `simorg/simvel/simangles`, `netchan`, `qport`, `userinfo`,
  `download*`, ...). Shared code (renderers, sound, sbar seam) reads the common fields on
  `cl`/`cls`; QW modules read `cl.qw`. `CactiveT` gains QW's `ca_demostart`, `ca_onserver`,
  `ca_active` values after the WinQuake ones.
- **Cvars gain `info`.** Corrected 2026-09-05: QW 2.33's actual `cvar_t` (QW/client/cvar.h)
  has no `CVAR_*` bitmask at all -- just two `qboolean`s, `archive` and `info` (a single
  flag meaning "propagate to userinfo" on the client binary, "propagate to serverinfo" on
  the server binary, read differently depending on which binary is compiled). `CvarT`
  keeps `archive`/`server` and gains a plain `info: boolean` (5th constructor argument,
  default `false`) instead of a synthesized flags word. QW `cvar.c`'s userinfo/serverinfo
  propagation, its `Cvar_RegisterVariable`'s post-link `Cvar_Set` call, and its
  `Cvar_CompleteVariable`'s exact-match-first check are each small, additive deltas over
  the landed `Cvar_Set`/`Cvar_RegisterVariable`/`Cvar_CompleteVariable`, so they are folded
  into `src/common/cvar.ts` under `qw.active` (via a registrable `setCvarInfoHook`) rather
  than kept as a second `Cvar_Set` in `src/qw/cvar.ts`, which is now re-exports plus a thin
  `qwCvarHooks` adapter for tests and the qwcl/qwsv entry points. The same fold applies to
  `src/qw/cmd.ts`'s `Cbuf_InsertText`/`Cmd_StuffCmds_f`/`Cmd_ExecuteString`, each of which
  duplicated a shared `src/common/cmd.ts` function to change one small thing; folded there
  under `qw.active` too, so the shared `Cmd_ExecuteString`/`Cvar_Command` path every
  registered command goes through behaves as QW when qw.active. `Cmd_ForwardToServer`
  stays hook-based, as it already was.
- **Protocol, netchan, common** are separate QW modules: `src/qw/protocol.ts` (protocol 28,
  `svc_*`/`clc_*` renumbered, `PF_*`/`U_*`/`SU_*`? per QW `protocol.h`), `src/qw/net_chan.ts`
  + `src/qw/net_udp.ts` (QW's packet API over `Bun.udpSocket`, the `netadr_t` shape as in
  Quake 2's port) + `src/qw/md4.ts`, `src/qw/common.ts` (QW `common.c`: `Info_*`,
  `MSG_ReadDeltaUsercmd`/`MSG_WriteDeltaUsercmd`, the `COM_*` changes), `src/qw/pmove.ts` +
  `pmovetst.ts` (shared by qwcl and qwsv), `src/qw/bothdefs.ts`.
- **The QW server is its own progs host**: `src/qw/server/` gets `qwsvdef.ts`, `server.ts`,
  `progdefs.ts` (QW `progdefs.h`, CRC 54730), `pr_edict.ts`/`pr_exec.ts`/`pr_cmds.ts`
  (ported from the landed `src/progs` modules with the QW diff applied), `world.ts`,
  `sv_main.ts`, `sv_init.ts`, `sv_ccmds.ts`, `sv_ents.ts`, `sv_nchan.ts`, `sv_send.ts`,
  `sv_phys.ts`, `sv_move.ts`, `sv_user.ts`. Its model loader is `src/common/model.ts`'s
  hook-less (dedicated) path, which is what QW `server/model.c` is. Test fixture:
  `../qsrc/quake/QW/progs/qwprogs.dat` (retail QW progs, in the tree).
- Not ported: `QW/qwfwd`, `gas2masm`, the per-OS files (`net_wins`, `sys_win`, `vid_*`,
  `in_*`, `cd_*`, `snd_win`: the platform layer already exists), `gl_vidlinux_svga/x11`.

Delivery order: QW common (protocol, bothdefs, common, cvar, netchan/udp/md4, pmove) →
qwsv (headers, progs, world, sv_*) with a headless qwsv boot on `qwprogs.dat` as the
milestone → qwcl (client ext, cl_ents/pred/cam, cl_main/parse/demo, input/tent/skin,
sbar/menu/screen/view deltas, the folded renderer deltas) → both binaries build.
