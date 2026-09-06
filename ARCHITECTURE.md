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

**RULING NEEDED (R1):** a TypeScript port of qcc (`../qsrc/quake-tools`,
GPLv2) extended with the FTEQCC features the re-release sources use
(`#0:name` builtins, `...` varargs, `#ifdef`), so we can build union
"crossover" progs from the GPLv2 QuakeC at build time and ship them as
part of the release (they are code, not game assets). This is the
stronger form of crossover and doubles as a QuakeC mod platform. It is a
separate deliverable of real size (qcc is about 5k lines of C). Default
if not ruled: the compat spawn table ships first; the compiler is a later
phase.

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

**RULING NEEDED (R2):** "all possible protocols". Committed: 15, 666, 999
with all `PRFL_*` flags, QW 28, and the QEX opcode set. Also cheap:
Nehahra 250 (demo playback only). DarkPlaces protocols 5 to 7 would need
the DarkPlaces source (GPLv2, not checked out) and add a large surface for
little re-release value; default: not in v1.

## Unified client and server

One binary. The client speaks NetQuake and QuakeWorld: the connection
kind (a QW handshake versus an NQ connect, or the demo file's header)
selects the codec and the client profile per connection, exactly as the
`qw.active` fold already gates 435 sites across both renderers, cvar,
cmd, console and view. The QW-only modules the fold never reached
(`cl_ents`, `cl_pred`, `cl_cam`, `skin`, and the QW halves of
`cl_parse`/`cl_input`/`cl_main`) become the QW client profile, selected
per connection instead of per process. The server side hosts both
profiles the same way; `-dedicated` runs headless. `qwsv` and `qwcl`
remain as thin entry points (aliases) until the fold is complete, then go.

Client features, all in scope: localization with TTF/kfont text from
`QuakeEX.kpf` (quake-2-re-ts `ttf.ts` and `kfont.ts` lifted), scaled HUD,
menus and console with mouse (`ui_scale.ts`/`ui_mouse.ts` pattern), the
weapon wheel from `wwheel.txt`, `mapdb.json`-driven New Game and
Content x Ruleset screens, a server browser (NQ `slist` and QW master
queries), local splitscreen (`svc_setviews`, per-seat HUD and sound;
quake-2-re-ts's `gamepad_assign.ts`), SDL GameController with
`gamecontrollerdb.txt` from the kpf, haptics from `tactile/*.bnvib`
(quake-2-re-ts `haptics.ts`), client-side prediction for QW and, as an
option, for NQ on 666/999, achievements as a no-op log, and the id Vault
gallery from `vault/`.

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
  `classic`), MD5 through the alias triangle pipeline, fog as a depth
  post-pass, skyboxes, lerp, replacement textures downsampled to the
  surface cache. **RULING NEEDED (R3):** the software renderer's colored
  lighting means a true-color output path in the software rasterizer,
  which is the largest single renderer lift on the software side. Default:
  in scope, sequenced after the GL renderer has every feature.

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
  qcc for union progs (default: table first, compiler later).
- **R2** protocol list beyond 15/666/999/28 + QEX (default: Nehahra 250
  playback only; DarkPlaces protocols not in v1).
- **R3** software renderer true-color colored lighting (default: in scope,
  after the GL feature set).
- **R4** binary name for the unified executable (default: `q1rets`, with
  `q1ts`/`qwsv`/`qwcl` kept as aliases until phase 5 completes).
