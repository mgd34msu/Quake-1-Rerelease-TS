# Quake 1 Re-release TS

A TypeScript engine for the 2021 Quake re-release, running on
[Bun](https://bun.sh): one engine that plays the classic game, both
mission packs, and every re-release campaign (Dimension of the Past,
Dimension of the Machine, Dawn of the Machine, the re-release CTF) with
any content under any ruleset, over NetQuake protocols 15/666/999 and
QuakeWorld 28, with both a software and an OpenGL renderer.

**Status: phase 2 in progress (2026-09-06).** Seeded from the faithful
[Quake-1-TS](https://github.com/mgd34msu/Quake-1-TS) v1.0.0 port and
transformed in place; `ARCHITECTURE.md` is the design contract and phase
plan, `PORTING.md` carries the inherited C-to-TypeScript conventions,
`CHANGELOG.md` records what each release changed. Landed so far:

- One QuakeC VM with NetQuake and QuakeWorld host profiles; the re-release
  progs run with all 18 name-bound `ex_*` builtins, `checkextension`,
  localized prints, `MOVETYPE_GIB`, `SOLID_CORPSE`, the QEX opcodes, prompts,
  `setcolor`, and a `sv_ruleset classic|rerelease|auto` behaviour profile.
- Protocols 15, 666 and 999 behind a codec seam (protocol 15 byte-identical
  to the seed), wide limits (`max_edicts` up to 32000, 8192 models, 2048
  sounds), BSP2 and 2PSB maps, `.lit` colored lighting, BSPX directory,
  external `.ent` files and texture wads, textures of any size.
- Re-release roots detected (nested `rerelease/` or direct), `QuakeEX.kpf`
  mounted, `-mg1 -mg3 -dopa -ctf`, a runtime `game` command, `-homedir`.
- OpenGL: colored lightmaps and entity lighting, fog, skyboxes, water and
  entity alpha, anisotropy. Sound at 44.1 kHz. KEX-format savegames and
  autosave. SDL game controllers with the re-release's mappings and
  `.bnvib` haptics. Parsers for `mapdb.json`, `wwheel.txt`, the bot
  knowledge files and NAV2 navmeshes; MD5 model loader; TTF and kfont
  rasterizers; a compat spawn table so re-release maps load under classic
  progs.

In flight: menus driven by `mapdb.json`, software-renderer colored
lighting, the protocol-999 fix for messages outside the codec. Next: bots
and navmesh pathing, client-side lerp, localization on the client with
TTF text, the unified client and server binary, splitscreen.

### Running (today, the seed)

    bun install
    bun src/main.ts -basedir /path/to/quake            # software renderer
    bun src/main.ts -basedir /path/to/quake -vid_ref gl

The base directory is a classic Quake install (`id1/`, optional
`hipnotic/`, `rogue/`, `qw/`). Re-release data support (`rerelease/`
nested inside it, or pointed at directly) lands in the phases described
in `ARCHITECTURE.md`.

### Gates

    bun run check    # tsc --noEmit plus the zero-`any` grep
    bun test         # unit suite; needs no game data

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
