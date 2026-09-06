# Architecture

Design contract for quake-1-re-ts, written 2026-09-06 at kickoff. Sections
marked **RULING NEEDED** are open until Mike rules; everything else is a
commitment with a reference to check against. The transformation follows
the seed-and-transform process that built quake-2-re-ts: commit 1 is the
working Quake-1-TS v1.0.0 tree, and every later step keeps `bun run check`
clean, the suite green, and the classic games playable.

## Charter

The TypeScript engine for the 2021 Quake re-release, on Bun (`bun
src/main.ts` runs from source, `bun build --compile` produces the
executables). Not a bug-for-bug port: quality-of-life changes are welcome
and are documented as additions. Everything is first class and everything
interoperates with everything: classic and re-release content, every
`progs.dat`, NetQuake and QuakeWorld, protocols 15, 666, 999 and 28, and one
unified client binary. 99.9% TypeScript; the rest is a couple of shell
scripts. Anything GPLv2 may be read and ported. FTEQW is excluded as a
reference for this project.

## What the re-release actually is

The 2023 Quake II re-release shipped a 103k-line C++ game module. The 2021
Quake re-release shipped **QuakeC only**; the KEX engine is closed. That
inverts the shape of the work: the game code already runs as bytecode
through the seed's QuakeC virtual machine, and the port is an engine
extension effort specified from three sources: the QuakeC in
`../qsrc/quake-rerelease-qc`, the retail data in `../qfiles/q1/rerelease`,
and the GPLv2 engines Ironwail, vkQuake and QuakeSpasm in `../qsrc`.

Facts verified against the retail paks (2026-09-06):

- Every re-release `progs.dat` is version 6, CRC 5927 (the 1.06 entity
  layout), opcodes 65 and below. The seed VM loads them today.
- They bind 18 builtins **by name** (`= #0:ex_name`): `ex_bprint`,
  `ex_sprint`, `ex_centerprint` (variadic, `$key` localization with `{0}`
  argument slots), `ex_finaleFinished`, `ex_localsound`, `ex_draw_point`,
  `ex_draw_line`, `ex_draw_arrow`, `ex_draw_ray`, `ex_draw_circle`,
  `ex_draw_bounds`, `ex_draw_worldtext`, `ex_draw_sphere`,
  `ex_draw_cylinder`, `ex_bot_movetopoint`, `ex_bot_followentity`,
  `ex_CheckPlayerEXFlags`, `ex_walkpathtogoal`. CTF adds `ex_prompt`,
  `ex_promptchoice`, `ex_clearprompt` and `setcolor` as builtin 401.
  `checkextension` is builtin 99 and is asked for `EX_EXTENDED_EF`,
  `EX_MOVETYPE_GIB`, `EX_PROMPT`, `DP_SV_SETCOLOR`.
- They expect engine-owned globals `campaign`, `campaign_valid`,
  `cheats_allowed`, read the cvars `horde`, `campaign`, `sv_cheats`,
  `pr_checkextension`, `gamecfg`, and set `campaign` and `sv_gravity`.
- They write opcodes vanilla never had: `svc_spawnedmonster` 39,
  `svc_achievement` 52, `svc_chat` 53, `svc_levelcompleted` 54,
  `svc_backtolobby` 55, `svc_localsound` 56, `svc_prompt` 57, plus
  `TE_EXPLOSION2` 12 and `TE_BEAM` 13. Gameplay constants:
  `MOVETYPE_GIB` 11, `SOLID_CORPSE` 5, `EF_QUADLIGHT` 16,
  `EF_PENTALIGHT` 32, `EF_CANDLELIGHT` 64, `FL_ISBOT` and friends.
- They stuff `bf`, `fog ...`, `vibrate tactile/<file>.bnvib` and `color` to
  clients, and run `switchweapon N M` through the `quickswitch_*` aliases.
- **The bot AI is engine-side.** `bots/bot.qc` is two empty hooks,
  `Bot_PreThink` and `Bot_PostThink`, "called by the engine every frame
  before/after running the bots update in C++". The engine consumes
  `bots/characters.txt`, `weapons.txt`, `items.txt`, `monsters.txt`,
  `interactables.txt`, `game_rules.txt`, `teams.txt`, `settings_*.txt` and
  `bots/navigation/<map>.nav` (magic `NAV2`, version 12).
- Formats: BSP2 (all of dopa, most of mg1 and mg3), BSPX `FACENORMALS`
  (mg3), `.lit`, `.md5mesh`/`.md5anim`, PNG HUD art, TGA skyboxes under
  `gfx/env/`, external `gfx/*.wad` texture wads, 44.1 kHz 16-bit wavs,
  `music/trackNN.ogg`, `mapdb.json` (143 maps with `sp`/`dm`/`coop`/`bots`/
  `ctf`/`horde` flags), `localization/loc_<lang>.txt` (1635 keys, 7
  languages, per-platform variants), `wwheel.txt`, `tactile/*.bnvib`, and
  `QuakeEX.kpf` (a zip: fonts as `.kfont`+PNG and TTF/OTF, UI images,
  `gamecontrollerdb.txt`, KEX's own shaders which we do not use).
- Demos in the re-release paks are ordinary protocol 15 demos.

None of the three open engines implement bots, navmesh pathing, the debug
draw builtins, `setcolor`, the lobby opcodes, `QuakeEX.kpf` mounting, BSPX,
or a fixed-tick server. Those are ours to design; the closest reference we
own is quake-2-re-ts's bot, nav, localization and cgame work.

## Reference sources

| Path | Role | License |
|---|---|---|
| `../quake-1-ts` | The seed. Faithful WinQuake 1.09 + QuakeWorld 2.33. Read-only from here on. | GPLv2 |
| `../qsrc/quake` | id's 1999 source: WinQuake, QW, progs106, mission-pack QC | GPLv2 |
| `../qsrc/quake-rerelease-qc` | 2021 re-release QuakeC: base, ctf, hipnotic, rogue, mg1, mg3 | GPLv2 |
| `../qsrc/ironwail` | Reference for protocols 666/999, BSP2, `.lit`, MD5, localization, `ex_*` binding, KEX savegames, install detection | GPLv2 |
| `../qsrc/vkquake` | Same lineage; widest `sv_gameplayfix_*` set, `ex_*` set, MD5 | GPLv2 |
| `../qsrc/quakespasm` | The simplest shared baseline of the three | GPLv2 |
| `../quake-2-re-ts` | Our own: protocol codec seam, TTF rasterizer, loc parser, PNG/JPG/TGA/zip decoders, MD5 loader, nav + bots, cgame host, UI scale + mouse menus, gamepad/haptics, test harness design | GPLv2 |
| `../qsrc/quake-tools` | qcc (reference QuakeC compiler), qutils | GPLv2 |
| `../qfiles/q1` | Retail data: classic `id1`/`hipnotic`/`rogue`/`qw`, and `rerelease/{id1,hipnotic,rogue,mg1,mg3,dopa,ctf}` + `QuakeEX.kpf` | commercial, never committed |

Excluded: `../qsrc/fteqw` (Mike's ruling). GPLv3 projects are excluded
entirely, including as reading references, as in quake-2-re-ts.

Ruling (Mike, 2026-09-06): **lift from quake-2-re-ts wherever the lifted
code lands with the gates still green.** Game-agnostic modules (protocol
codec seam, `sizebuf` helpers, TTF and kfont, loc parser, PNG/JPG/TGA/zip
decoders, MD5 loader, nav loader, UI scale and mouse menus, gamepad
assignment and haptics, the sweep harness) are copied and adapted rather
than rewritten. Each lifted file names its source path and commit in its
header.

## Core model: one engine, one VM, content x ruleset

```
                 engine core (wide state, protocol codec layer,
                 one QuakeC VM with a host profile, bot AI, nav)
                /                |                 \
   NetQuake host profile   QuakeWorld host profile   (later: crossover)
   progs.dat: id1 1.06,    qwprogs.dat
   rerelease id1/hipnotic/
   rogue/mg1/mg3/dopa/ctf
```

Quake has no game DLL. The "module" is a `progs.dat`, and there is exactly
one implementation of the machine that runs it. So where quake-2-re-ts
needed peer game-API bindings, this engine needs:

- **One QuakeC VM** (`src/progs`) with a **host profile** selecting the
  builtin table and system-defs CRC: `nq` (79 numbered builtins, CRC 5927)
  or `qw` (QW's table, CRC 54730). Landed 2026-09-06 (U1): the core is
  `src/progs/{progs_core,pr_edict_core,pr_exec_core}.ts` plus
  `progdefs_layout.ts` (one union field table, accessors generated onto
  prototypes); `src/progs/profiles/{profile,nq,qw}.ts` are the profiles;
  the old module paths are thin bindings that keep every export. The QW-only builtins (`logfrag`, `infokey`,
  `stof`, `multicast`) and NQ-only `particle` live in the profile tables.
- **Name-bound builtins**: after load, every function with
  `first_statement == 0 && parm_start == 0 && locals == 0` is looked up by
  name in the profile's extension table and bound (Ironwail's
  `PR_InitBuiltins`, `pr_edict.c:1858-1900`). Unbound names get a builtin
  that raises a clear `PR_RunError` naming the function.
- **`checkextension` (99)** answers from an extension registry; the
  registry is the single place an extension is declared.
- **Progs CRC**: the header CRC is checked against the profile's known set
  (5927 for NQ, 54730 for QW) and unknown CRCs are an error, as today. If a
  future compat progs of ours needs a wider `progdefs`, it is added to the
  known set with its own accessor layout; never by relaxing the check.

### Rulesets

A ruleset is the pair (content's `progs.dat`, engine behaviour profile).
The behaviour profile is `classic` or `rerelease`, auto-detected from the
loaded progs (`ex_centerprint` present and `centerprint` absent means
`rerelease`, as Ironwail and QuakeSpasm both detect it) and overridable
with `sv_ruleset classic|rerelease|auto`. The profile controls what the
QuakeC cannot: `MOVETYPE_GIB` physics, `SOLID_CORPSE`, unmasking the
`EF_QEX_*` light flags, `$key` print formatting, the `campaign` /
`cheats_allowed` / `campaign_valid` globals, `switchweapon` and the weapon
wheel, bot hooks, `sv_gameplayfix_*` defaults, and the extension registry's
answers. Under `classic`, a 1.06 map under 1.06 progs plays as WinQuake did
(the seed's fidelity is the harness). Under `rerelease`, the re-release
progs play as the KEX engine does, as far as the QuakeC and data specify it.

Where the open engines disagree with the QuakeC, the QuakeC wins: for
example Ironwail, vkQuake and QuakeSpasm give `MOVETYPE_GIB` a backoff of
1 (gibs stop dead), while the re-release QuakeC's comment says "like
MOVETYPE_BOUNCE, but with adjustable gravity". We implement the QuakeC's
description and keep the decision in the file header.

### Content crossover

Content chooses its progs by default (mg1 maps run mg1's progs). Every
progs runs on every map the engine can load. A classname the running
progs has no spawn function for is handled by a **compat spawn table**
in the engine (TypeScript): a per-classname rule that maps it to the
nearest classname the progs does have (with field rewrites) or inhibits
it. This is the Quake 1 shape of quake-2-re-ts's "classic modules gained
re-release entity classes as content, not rules". It covers, for
instance, mg1's `func_bob`, `fog` and horde entities under 1.06 progs.

**RULING R1 (default in effect):** a TypeScript port of qcc (`../qsrc/quake-tools`,
GPLv2) extended with the FTEQCC features the re-release sources use
(`#0:name` builtins, `...` varargs, `#ifdef`), so we can build union
"crossover" progs from the GPLv2 QuakeC at build time and ship them as
part of the release (they are code, not game assets). This is the
stronger form of crossover and doubles as a QuakeC mod platform. It is a
separate deliverable of real size (qcc is about 5k lines of C). The
default stands: the compat spawn table shipped first (U12, landed
2026-09-06) and is what runs today; the qcc union-progs compiler is a
later phase and has not been started.

## Engine core commitments

- **Wide internal state, narrowed only at the wire.** Limits follow
  Ironwail/vkQuake: `MAX_EDICTS` 32000 with a `max_edicts` cvar (default
  16384, clamped at map load), `MAX_MODELS` 8192, `MAX_SOUNDS` 2048,
  `MAX_CL_STATS` 256, `MAX_STATIC_ENTITIES` 4096, `MAX_MSGLEN` and
  `MAX_DATAGRAM` 64000. Entity state gains `alpha`, `scale`, `frame` and
  `modelindex` as 16-bit, `lerpfinish`. `MAX_LIGHTSTYLES` stays 64.
- **Widening is decided from the map at load**, orthogonal to ruleset,
  as quake-2-re-ts does: a BSP2 map, or a BSP29 map whose entity count or
  extents exceed protocol 15's reach, forces a wide protocol for that
  session. A classic map under `sv_protocol 15` stays byte-compatible with
  vanilla clients.
- **Model loading**: the shared loader gains BSP2 and 2PSB (a `bsp2`
  width flag threaded through `Mod_LoadEdges/Faces/Nodes/Leafs/Clipnodes/
  Marksurfaces`, Ironwail `gl_model.c:2426-2441`), 32-bit in-memory
  clipnodes, `.lit` version 1 (and a version 2 reader if the data ever
  needs it), BSPX lump directory with `FACENORMALS`, `RGBLIGHTING`,
  `LMSHIFT`/`LMOFFSET`/`LMSTYLE`, `LIGHTING_E5BGR9` and `BRUSHLIST`
  parsed (BSPX has no open reference among the three engines; the lump
  layouts come from the published BSPX spec and our own quake-2-re-ts
  `bspx.ts` directory walker), external `<map>@<crc>.ent` / `<map>.ent`,
  external `gfx/*.wad` texture wads, MD5 mesh/anim as replacement models
  (`progs/<name>.md5mesh` beside the `.mdl`, same-or-higher search-path
  tier rule from quake-2-re-ts), PNG/TGA/JPG replacement textures with
  the logical-vs-upload-size rule (standing order 20).
- **Collision** for arbitrary entity sizes on BSP29/BSP2: the three fixed
  hulls stay the classic path; BSPX `BRUSHLIST` provides exact brush
  collision when a map carries it. No open engine among our references
  implements it, so it is written from the spec and tested on mg3 data.
- **Physics tick.** WinQuake ticks the server at the render rate, capped
  at 72 Hz; every open engine keeps that and warns above 72. We keep
  frame-coupled physics as the `classic` behaviour, and add a fixed-step
  server clock (`sv_tickrate`, default 72) that the `rerelease` profile
  uses, with the renderer free-running and interpolating (`r_lerpmodels`,
  `r_lerpmove`, lightstyle lerp). Because no reference does this, it
  lands behind the profile switch and the classic path stays untouched.
- **Sound**: mixer default 44.1 kHz, 16-bit stereo (one change in
  `src/platform/snd.ts`), any-rate resampling on load, `localsound`,
  `svc_spawnstaticsound2`. Music: `music/NN.ogg` and `music/trackNN.ogg`,
  codec priority ogg first.
- **Filesystem**: search-path nodes gain a `zip` kind (mounts
  `QuakeEX.kpf` and any `.pk3`/`.kpf`), a `rerelease/` subdirectory is
  detected inside a classic tree (both trees mounted, the way
  quake-2-re-ts detects a nested re-release), the mission-pack flags grow
  `mg1`, `mg3`, `dopa`, `ctf`, a `game` command switches gamedir at
  runtime, a per-user home directory tier holds configs, saves and
  replacement assets, and `mapdb.json` drives the New Game menus.
- **64-bit values** never reach a float view (the engine string rule in
  PORTING.md stands: every progs-visible engine value is a finite float32).

## Protocol layer

Modeled on quake-2-re-ts's `ProtocolCodec` seam (`src/qcommon/protocol/
codec.ts`): one interface holding only the operations that vary per
protocol (serverinfo, entity baseline and delta, client data, sound,
static entities, coordinates and angles, usercmd), with byte-identical
operations staying plain shared functions. Codecs:

| Protocol | Codec | Reference |
|---|---|---|
| 15 NetQuake | the seed's code, extracted verbatim | `src/common/protocol.ts`, id's `sv_main.c` |
| 666 FitzQuake | `U_EXTEND1/2`, `B_LARGEMODEL/FRAME`, `SND_LARGEENTITY/SOUND`, `SU_EXTEND1-3`, alpha, lerpfinish, `svc_skybox/bf/fog/spawnbaseline2/spawnstatic2/spawnstaticsound2` | Ironwail `protocol.h`, `sv_main.c`, `cl_parse.c` |
| 999 RMQ | 666 plus `PRFL_*` flags; the server sends `PRFL_INT32COORD \| PRFL_SHORTANGLE` like Ironwail/vkQuake (`sv_main.c:1962`) | same |
| 28 QuakeWorld | the seed's `src/qw` protocol, extracted into a codec | `src/qw/protocol.ts`, id's QW |
| 29 QuakeWorld wide | this engine's own extension (landed 2026-09-06, U18): a `U_EXTEND` byte carrying 16-bit entity numbers, `U_MODEL2`/`U_FRAME2` high bytes, alpha and scale as in 666; short `svc_modellist`/`svc_soundlist` counts and sound indices; coords and angles as 999's `PRFL_INT32COORD\|PRFL_SHORTANGLE`. Negotiated by the client's `*wide 1` userinfo key and `sv_qwprotocol` (`28\|29\|auto`, default auto) | no GPLv2 reference; `src/common/protocol/qw29.ts` is the specification, pinned by `test/protocol_qw29.test.ts` |
| QEX extension set | `svc_spawnedmonster` 39, `svc_botchat` 38, `svc_setviews` 45, `svc_updateping` 46, `svc_updatesocial` 47, `svc_updateplinfo` 48, `svc_rawprint` 49, `svc_servervars` 50, `svc_seq` 51, `svc_achievement` 52, `svc_chat` 53, `svc_levelcompleted` 54, `svc_backtolobby` 55, `svc_localsound` 56, `svc_prompt` 57, layered on 666/999 (the re-release did not bump the version) | the QuakeC, the Steam community protocol note the three engines cite; semantics of the lobby opcodes are ours where the QuakeC does not define them |

- `sv_protocol` cvar: `15`, `666`, `999` or `auto` (default `auto`: 999
  when the map needs width, else 666; `15` only when asked). Demos are a
  raw capture of one client's stream, so their protocol is re-derived
  from the recorded serverinfo exactly as on connect (Ironwail
  `cl_demo.c:133-146`). `.dem` (NetQuake, any protocol) and `.qwd`
  (QuakeWorld) both play back.
- Interop target: our binary in both seats first (standing order 19);
  byte-vector tests against Ironwail/vkQuake/QuakeSpasm's encoders; real
  Ironwail demos as fixtures. KEX's own netcode is undocumented, so
  connecting to a real re-release server is out of scope.
- quake-2-re-ts's recreated KEX Quake II protocol (`q2repro.ts`, 1038) is
  Quake II shaped; what transfers is the codec seam, the negotiation
  pattern (per-session protocol chosen at map load), the demo rule, and
  `sizebuf.ts`'s helpers. Mike's note that the Quake II KEX wire may share
  ideas with Quake's is kept as a lead: if the lobby opcodes' payloads
  ever need guessing, `kexdemo.ts` is the first place to look.

**RULING R2 (ruled, default stands):** "all possible protocols". Committed
and landed: 15, 666, 999 with all `PRFL_*` flags, QW 28, and the QEX opcode
set, plus this engine's own wide QuakeWorld protocol 29 (U18). Also cheap:
Nehahra 250 (demo playback only) -- not started. DarkPlaces protocols 5 to 7
would need the DarkPlaces source (GPLv2, not checked out) and add a large
surface for little re-release value; ruled: not in v1.

## Unified client and server

Landed: one binary, `q1rets` (ruling R4, U42). The client speaks NetQuake
and QuakeWorld per connection rather than per process
(`src/common/profile.ts`): the connect rule that the `connect` console
command follows and `src/client/cl_main.ts` implements picks the profile
before the handshake even starts -- `cl_protocol qw|nq` forces it
outright, an address with an explicit `:port` means QuakeWorld and one
with no port means NetQuake, and `playdemo`/`timedemo` take it from the
file (`.qwd` is QuakeWorld, `.dem`, any protocol, is NetQuake). The
`qw.active` fold that used to gate 435 sites across both renderers,
cvar, cmd, console and view is now this per-connection profile switch
instead of a process-wide flag.

`cmd_functions` and `cvar_vars` are each one table for the whole process
(U38/U41): `Cmd_AddCommand` takes an optional profile scope, and lookup
(`Cmd_ExecuteString`, `Cmd_CompleteCommand`) prefers the entry whose
profile matches the profile in force, falling back to an unscoped
registration -- the duplicate-name rejection is per (name, profile) pair
rather than per name, covering the roughly 90 command names (`say`,
`status`, `kick`, `connect`, `+attack`, `screenshot`, `menu_main`, ...)
both trees register. A command arriving from the dedicated stdin
console, an rcon packet, or a connected client's `clc_stringcmd`
resolves against THAT SERVER's profile no matter what the local client
is doing; `cmdConsole.profile`, set around a drain by
`Cmd_WithConsoleProfile`, is that console-source profile. Most cvars
both trees declare under one name are folded onto one shared `CvarT`
object (`SV_RegisterSharedVariable`) rather than kept as two.

The server side holds at most one server per process
(`connectionProfile.server`, published as `sv.profile`): `-dedicated -qw`
(what the `qwsv` entry point now passes) boots straight onto the
QuakeWorld server tree, and a plain `-dedicated` boots NetQuake's. The
same choice is reachable at runtime from a NetQuake boot with no
`-qw` at all: `sv_profile qw` followed by `map <name>`
(`Host_Map_QW_f`, `src/common/host_cmd.ts`) brings the QuakeWorld server
profile up in a process that already has a client, and the local client's
own `connect local` then joins it exactly as a LAN client would -- this
is how the QuakeWorld listen server is hosted from the DEFAULT boot.
`src/qw/net_udp.ts` gives that configuration one UDP socket per side
(client and server), rather than the C's one socket per binary, now that
both halves can share a process.

Still open: the `-qw` boot itself is a QuakeWorld CLIENT only, with no
server of its own -- hosting from it needs the two boot paths merged,
which has not happened. And while the general mechanisms above (the
profile-scoped command table and the shared-cvar registration) resolve
most of the ~90 duplicate names, a handful of collisions where one tree's
name is a COMMAND and the other's is a CVAR of the same name are not
covered by either general mechanism -- `Cvar_RegisterVariable`'s "is a
command" guard leaves the cvar object unlinked from `cvar_vars` and
unreachable by name. `name` itself is the one of these solved so far
(`Host_Name_QW_f` reads and writes QuakeWorld's `name` cvar object
directly via `Cvar_SetObject`, bypassing the by-name lookup that would
otherwise miss it); a general per-profile cvar/cmd registry that would
cover the rest of this kind of collision without one-off code per name
does not exist yet.

`qwsv` and `qwcl` remain as thin entry points (aliases, R4) that insert
`-qw` / `-dedicated -qw` onto the command line before it reaches this
same binary's `main`.

Client features, all in scope: localization with TTF/kfont text from
`QuakeEX.kpf` (quake-2-re-ts `ttf.ts` and `kfont.ts` lifted), scaled HUD,
menus and console with mouse (`ui_scale.ts`/`ui_mouse.ts` pattern), the
weapon wheel from `wwheel.txt`, `mapdb.json`-driven New Game and
Content x Ruleset screens, a server browser (NQ `slist` and QW master
queries), local splitscreen (landed, see below), SDL GameController with
`gamecontrollerdb.txt` from the kpf, haptics from `tactile/*.bnvib`
(quake-2-re-ts `haptics.ts`), client-side prediction for QW and, as an
option, for NQ on 666/999, achievements as a no-op log, and the id Vault
gallery from `vault/`.

### Splitscreen

Landed (U43, `src/client/splitscreen.ts`): two to four players in one
process, on one listen server. There is no C original to port against --
WinQuake and QuakeWorld are single-seat binaries and the KEX engine's own
splitscreen is not observable -- so this is an original module built on
what the re-release QuakeC does leave on the wire, `svc_setviews` (45).

Each seat past 0 is a FULL client connection over the loopback driver
(its own `NET_Connect("local")`, running the ordinary prespawn / name /
color / spawn / begin signon and getting its own player edict out of
`SV_ConnectClient`), not a second camera hung off one connection -- to
the server a seat is indistinguishable from a second player who happened
to connect from the same process. This is affordable because `cl`,
`cls`, `cl_entities` and `cl_visedicts` are live ESM bindings
(`export let`) in `src/client/client.ts`: `SS_ActivateSeat` repoints all
four at another seat's objects, so parse, input and draw run inside
whichever seat's window is active with no call-site change anywhere in
the client, the same one-switch-read-everywhere shape as the `qw.active`
fold. `cl_splitscreen` is a console COMMAND, not a cvar -- seating a
player is an action (it opens a connection, spawns an edict and re-cuts
the screen), not a preference with something to archive -- while
`cl_splitscreen_layout` (auto / side-by-side / stacked) is an archived
cvar, since which way the screen is cut genuinely is one.

Per seat: the connection, the whole of `ClientStateT` (view angles,
stats, items, intermission, scoreboard, ...), the entity snapshot
(`cl_entities`/`cl_visedicts`), the viewport rect, the HUD, the usercmd
and the name/color the seat signs on with. Shared, deliberately: the
world model and its efrag links (a seat's own `svc_spawnstatic`s for
statics seat 0 already linked are dropped rather than linked twice),
lightstyles, dlights (entity-keyed, so seats' copies of one muzzle flash
collapse onto one slot), temp entities and beams, the console, the menu,
the bind system and the sound listener -- sound is mixed from SEAT 0's
ears only, since `snd_mix.ts` has no multi-listener render path; each
seat's own local sounds still play, just spatialized from seat 0.
QuakeWorld connections stay single-seat (`cl_splitscreen` is refused
under the `qw` profile), since QW's per-connection prediction and
netchan state live on `cl.qw`/`cls.qw`, which the seat switch does not
yet cover connection by connection.

`svc_setviews` is given its own documented semantics here, since the KEX
engine's are not observable: the server tells a client how many LOCAL
seats that client's own machine is running, so the client can tell "one
of N views on one screen" from "one of N players on N machines". This
port sends it from `SV_SendServerinfo` to loopback (local) clients only
and parses it into `cl.numviews`; nothing in this engine's behaviour is
gated on the received value -- the seat count a client actually draws
with is its own local `cl_splitscreen`, authoritative on the machine that
owns the screen -- so a server that never sends it (every non-re-release
server) leaves `cl.numviews` at 1 and behaves exactly as it did before
splitscreen existed.

## Renderers

Both renderers load and draw everything. Feature list:

- **GL**: BSP2, colored lightmaps (`.lit`, BSPX RGB lighting), MD5
  skeletal models (quake-2-re-ts `md5_model.ts`), fog (`svc_fog`,
  worldspawn `fog`, the height/sky fog formulas from Ironwail
  `gl_fog.c`), entity alpha and water/lava/slime/tele alpha, TGA/PNG
  skyboxes, model and movement lerp, lightstyle lerp, overbright and
  fullbrights, replacement textures at any resolution, shadow mapping
  (quake-2-re-ts `gl_shadowmap.ts`), `r_scale`, anisotropy, vsync,
  `host_maxfps` free-running.
- **Software**: BSP2, colored lighting (three-channel blocklights with a
  15-bit or true-color present path; the 8-bit paletted path stays for
  `classic`), MD5 through the alias triangle pipeline (U26), fog as a
  depth post-pass (U27), cube-mapped skybox spans (U34), pose and
  movement lerp including MD5 (U39), replacement textures downsampled to
  the surface cache. **RULING R3 (done):** the software renderer's colored
  lighting true-color output path landed with U25, ahead of the phase-7
  regate; fog, skyboxes, MD5 and lerp above followed it, so the software
  renderer now carries the same fog/skybox/MD5/lerp feature set the GL
  renderer does, each in the shape its own rasterizer needs.

Both renderers read one shared cvar set rather than each declaring its
own copy: `src/common/render_cvars.ts` (U44) registers
`r_enhancedmodels`, `r_lerpmove`, `r_lerpmodels`, `r_nolerp_list`,
`r_lerplightstyles`, `r_skyfog`, `r_fastsky`, `r_skyalpha` and the
water/lava/slime/tele alpha cvars once, at module load, so a
software-only or dedicated-server process (which never runs the GL
renderer's own `R_Init`) still finds them registered instead of stuck at
`CvarT`'s unregistered-0 default. `src/client/fog_cmd.ts` (U44) is the
same fix for the `fog` console command: one registration that dispatches
through the active renderer's own `Renderer.fogCommand` seam member,
replacing the two separate `Cmd_AddCommand("fog", ...)` calls (one per
renderer) that used to fight over the same name in a process with both
renderers compiled in.

## Bots and navigation

Ruling (Mike, 2026-09-06): the bot brain is written as a **game-agnostic
module** so it can be fed back into quake-2-re-ts, which today has the nav
loader and the game-side adapter but no decision-making (the Quake II
brain is also inside the closed KEX engine). The world it reasons about
(positions, visibility, items, weapons, damage) is presented through a
small interface each game binds; Quake 1 binds it first.

Engine-side, from scratch, data-driven: `.nav` (NAV2 v12: nodes with
flags/links/radius, links with targets and hint types), the eight
`bots/*.txt` knowledge files, per-skill `settings_PC.txt` tuning
(aiming spring model, senses, behaviours, movement, weapons), `addbot`/
`kickbot`/`bot_skill`, `Bot_PreThink`/`Bot_PostThink` calls into the
progs, `ex_bot_movetopoint`/`ex_bot_followentity` returning the
`BOT_GOAL_*` states, and `ex_walkpathtogoal` for monsters (returns
in-progress/success/error and falls back to `movetogoal` when a map has
no nav). Reference for structure: quake-2-re-ts `src/server/nav.ts` and
`src/kexgame/bots/`. Bots work under every profile and every progs that
has the hooks; under 1.06 progs they still path and fight, without the
hook calls.

Landed: `src/lib/bot_brain/**` is the game-agnostic brain the ruling
above asked for -- one instance per bot, one `think()` per server frame,
knowing the world only through the small `BotWorldT` interface
(`src/lib/bot_brain/world.ts`) and nothing else from outside `src/lib`.
`src/bots/**` is the Quake 1 binding: `src/bots/index.ts` registers
`svMainHooks.isBot`/`.botThink`/`.spawnServer` (so `SV_RunClients`,
`SV_SendClientMessages` and `SV_SpawnServer` treat a client slot with no
socket as a bot instead of a broken connection), the three re-release
navigation builtins (`qexBotHooks`/`qexNavHooks`), and the
`addbot`/`kickbot` commands with the `bot_skill`/`bot_count` cvars.
`bot_count` applies live from any count (a per-frame server hook reconciles
the roster even with no bot present) and never removes a bot added with
`addbot`. A map that the retail `mapdb.json` flags `horde` spawns in coop:
mg1's coop spawn points remove themselves under deathmatch, so a human or
bot in a horde map under `deathmatch 1` was parked at the intermission
camera forever (a documented addition; the operator's deathmatch/coop and
`horde` values are restored at the next non-horde map). `sv_randomseed <n>`
(also `-randseed <n>`; 0 = unseeded, the default) seeds the generator the
QuakeC `random()` builtin, `SV_MoveToGoal` and the bot roster draw from, so
a run can be replayed; it is applied at every `SV_SpawnServer`.

`.nav` (NAV2, magic `NAV2`, versions 12 to 18 across the retail trees; the
link record is `int16 target, uint8 type, uint8 flags, int16 traversal`,
the v16+ header float is the pathing heuristic) decodes into nodes (flags,
links, radius) and links (targets, hint types, flags), with entity links
read separately; `src/lib/nav.ts` and `src/lib/bot_brain/nav_graph.ts` name
these fields `type`, `traversal` and `entityLinks` (renamed from an
earlier pass to match how `nav_graph.ts` actually uses them, rather than
the raw NAV2 field names).

quake-2-re-ts binds this same brain (U36): it had the nav loader and the
game-side adapter already but no decision-making of its own, since the
Quake II brain is inside the closed KEX engine there too. That
integration surfaced three bugs, fixed back in the shared
`src/lib/bot_brain/brain.ts` rather than in either game's binding, since
the brain is the one module both games run: (1) a goal the nav graph
cannot reach used to wedge a bot permanently -- picking the same
unreachable item every frame and walking into the wall between it and
the bot with no stuck detection on that code path -- fixed by
`unreachableUntil`, which benches an unreachable goal entity for a
while; (2) the give-up escalation counted stuck trips on
`pathState.stuckCount`, which both `clearPath` and `setPath` zero, and
the stuck branch calls `clearPath` on every trip short of giving up, so
the tally could never reach `STUCK_GIVE_UP` -- fixed by moving the tally
onto the brain itself as `stuckTrips`; (3) a bot stopped dead-on against
a wall has no tangential velocity to slide along it with, so it presses
forward at full speed and does not move, and re-planning just produces
the same route into the same wall -- fixed by `unstickUntil`/
`unstickSide`, which open a short sidestep-and-hop window on every stuck
trip.

## Savegames

Classic text saves stay byte-identical for classic content. KEX
re-release saves are read (Ironwail `SAVEGAME_VERSION_KEX`,
`host_cmd.c:2574-2594`) and written when the `rerelease` profile is
active, so saves round-trip with the retail game. Autosave slots
(Ironwail `autosave/`) as an addition.

## Source layout

- `src/lib/` — game-agnostic modules: decoders (zip, PNG, JPG, TGA), the
  TTF rasterizer and kfont atlas reader, the localization parser, the BSPX
  lump-directory walker, the NAV file reader, the bot brain. Rule: a file
  under `src/lib` imports nothing from `src/` outside `src/lib` (Node/Bun
  built-ins are fine). Lifted files keep quake-2-re-ts's structure and name
  their source path and commit in the header.
- `src/common/` — engine common (filesystem, cvars, commands, model
  loader, mathlib). `src/common/protocol/` holds the codec seam and one
  file per codec (`nq15.ts`, `fitz666.ts`, `rmq999.ts`, `qw28.ts`, `qex.ts`).
- `src/progs/` — the one QuakeC VM. `src/progs/profiles/` holds the
  NetQuake and QuakeWorld host profiles (builtin tables, progdefs layouts,
  known CRCs, extension registry). `src/qw/server/pr_*.ts` become thin
  bindings of the unified VM to the QW profile.
- `src/server/`, `src/client/`, `src/ref_soft/`, `src/ref_gl/`,
  `src/platform/`, `src/qw/` — as in the seed, transformed in place.
- `src/bots/` — the Quake 1 binding of the bot brain plus nav integration.

## Porting standards (inherited, still binding)

Strict TypeScript, zero `any`, no casts but `as const`. One `.ts` per
original `.c` where one exists; new subsystems named for what they do.
Fidelity razor: observable behaviour, per profile. Deviations and
additions documented in file headers and CHANGELOG. The standing orders
live in `.orch/preferences.md` and go into every brief.

## Phase plan (each phase ships something playable, suite green)

1. **Foundations.** Unify the two VMs under a host profile. Widen limits.
   Extract protocol 15 into the codec seam; add 666 and 999; demo protocol
   re-derivation; `sv_protocol`. BSP2/2PSB, `.lit`, BSPX directory,
   `.ent`, external wads. Sound at 44.1 kHz. Milestone: every re-release
   map (dopa, mg1, mg3 included) loads and plays headless under its own
   progs with the `ex_*` builtins stubbed to log.
2. **Re-release progs support.** Name-bound builtins, `checkextension`,
   the `ex_*` set with real semantics, localization (loc parser lifted),
   `campaign`/`cheats_allowed`/`campaign_valid`, `MOVETYPE_GIB`,
   `SOLID_CORPSE`, `EF_QEX_*`, the QEX opcodes, prompts, `switchweapon`,
   behaviour profiles and `sv_ruleset`. Milestone: the map x progs sweep
   (quake-2-re-ts's harness design: subprocess per boot, pinned RNG,
   exact residual table) is green for all seven re-release trees and the
   three classic ones.
3. **Content and filesystem.** `rerelease/` detection, kpf zip mount,
   homedir tier, `game` command, `mapdb.json`, compat spawn table,
   Content x Ruleset menu. Milestone: any map under any progs from the
   menu.
4. **GL renderer features.** MD5, colored lighting, fog, alpha, skyboxes,
   lerp, replacement textures, TTF/kfont HUD, scaled UI with mouse,
   weapon wheel, shadow mapping.
5. **Unified binary.** QW folded in per connection; `-dedicated`;
   splitscreen; controller and haptics; server browser.
6. **Bots and nav.**
7. **Software renderer features** (R3), KEX saves, autosave, id Vault,
   achievements log.
8. **Regate and RC.** Full sweep, byte-vector protocol tests against the
   three engines, Ironwail demo fixtures, own-binary self-play at 15, 666,
   999 and 28, five-platform builds after sign-off.

Phases 2 and 3 can overlap once phase 1 lands; 4 and 5 are engine work
under running games; 6 depends on 2; 7 depends on 4.

## Rulings requested

- **R1** crossover progs: compat spawn table only, or also a TypeScript
  qcc for union progs (default: table first, compiler later). **Table
  shipped** (U12, landed); the compiler has not been started and stays a
  later phase.
- **R2** protocol list beyond 15/666/999/28 + QEX (default: Nehahra 250
  playback only; DarkPlaces protocols not in v1). **As ruled**: 15, 666,
  999, QW 28 and this engine's own QW 29 are landed; Nehahra 250 and
  DarkPlaces stay out of v1.
- **R3** software renderer true-color colored lighting (default: in scope,
  after the GL feature set). **Done** (U25), with fog, skyboxes, MD5 and
  lerp following it in the software renderer (U26/U27/U34/U39) ahead of
  the phase-7 regate.
- **R4** binary name for the unified executable (default: `q1rets`, with
  `q1ts`/`qwsv`/`qwcl` kept as aliases until phase 5 completes). **Done**
  (U42): `q1rets` is the only `bun build --compile` target; the other
  three names are optional `--aliases` copies from
  `scripts/release-build.sh`.
