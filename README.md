# Quake 1 Re-release TS

A TypeScript engine for the 2021 Quake re-release, running on
[Bun](https://bun.sh): one engine that plays the classic game, both
mission packs, and every re-release campaign (Dimension of the Past,
Dimension of the Machine, Dawn of the Machine, the re-release CTF) with
any content under any ruleset, over NetQuake protocols 15/666/999 and
QuakeWorld 28, with both a software and an OpenGL renderer.

**Status: kickoff (2026-09-06).** The tree is the faithful
[Quake-1-TS](https://github.com/mgd34msu/Quake-1-TS) v1.0.0 port, seeded
as commit 1, and is being transformed in place. `ARCHITECTURE.md` is the
design contract and phase plan; `PORTING.md` carries the inherited
C-to-TypeScript conventions; `CHANGELOG.md` records what each release
changed.

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
