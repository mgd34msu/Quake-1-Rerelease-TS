import { mkdirSync } from "node:fs";

/*
Where the end-to-end harnesses find the game data and the repository.

`test/e2e/` drivers boot the real engine against real Quake data, which cannot
live in this repository. Every driver reads the base directory from one
environment variable, `Q1TS_DATA`, instead of a path baked into the file:

    Q1TS_DATA=/path/to/quake \
      SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy bun test/e2e/a_maps.ts

The directory `Q1TS_DATA` points at is what the engine is handed as `-basedir`:
it must contain `id1/pak0.pak` (mixed case is fine, `Sys_ResolveCase` handles
id's shipped `Id1/PAK0.PAK`), plus `qw/qwprogs.dat` for the QuakeWorld drivers
and `hipnotic/`, `rogue/` for the mission-pack ones.

Reading this module with `Q1TS_DATA` unset is an error, not a silent fallback:
a wrong base directory shows up as a screenshot of the wrong level or a
"Playing shareware version" banner half an hour into a run, which is worse than
refusing to start.

`bun test` never loads any of this — it only collects `*.test.ts`, and no file
under `test/e2e/` is named that way.
*/

/** Base directory holding `id1/pak0.pak`, from the `Q1TS_DATA` environment variable. */
export const Q1TS_DATA: string = ((): string => {
  const dir = process.env.Q1TS_DATA;
  if (dir === undefined || dir === "") {
    throw new Error(
      "Q1TS_DATA is not set. The test/e2e drivers need a Quake base directory " +
        "containing id1/pak0.pak (plus qw/qwprogs.dat for the QuakeWorld drivers). " +
        "Run them as: Q1TS_DATA=/path/to/quake bun test/e2e/<driver>.ts",
    );
  }
  return dir;
})();

/** Repository root, for drivers that spawn a second engine from source. */
export const Q1TS_REPO: string = `${import.meta.dir}/../..`;

/*
`-norerelease` mounts the classic root alone. The retail tree these drivers
run against nests the 2021 re-release under `rerelease/`, and a plain
`-basedir` auto-detects it, which changes what this family is looking at:
the re-release id1's `mapdb.json` turns the "New Game" menu item into the
episode picker, its progs.dat is a different program, and its maps are BSP2.
Families a-p are the classic-content families (the re-release ones are the
new q-z families in .orch/E2E-PLAN.md), so the classic root is what they
boot unless a caller asks for something else explicitly.
*/
export function classicArgv(argv: readonly string[]): string[] {
  if (argv.includes("-norerelease") || argv.includes("-rerelease")) return [...argv];
  return [argv[0] ?? "quake", "-norerelease", ...argv.slice(1)];
}

/*
Where a driver's own writes go.

The engine defaults to a per-user home directory for writes (F3: with no
`-homedir`, config.cfg / savegames / demos / screenshots / qconsole.log land
under $XDG_DATA_HOME/q1rets/<game> and com_gamedir points there). Two
consequences for these drivers: nothing may be assumed to appear under
$Q1TS_DATA/<game>, and a driver run must never write into the retail tree at
all. `-homedir <scratch>` settles both -- every family writes under
$Q1TS_HOMEDIR (the runner exports it; $Q1TS_SCRATCH/e2e/home by default), one
subdirectory per `-game` name, and a driver that wants to find what it wrote
reads the live com_gamedir rather than rebuilding the path.

The `glquake/` subdirectory is made here as well: the engine's own
Sys_mkdir for it is not recursive, so it silently does nothing when the
gamedir above it does not exist yet, and the GL renderer's .ms2 mesh-cache
write then fails through Sys_FileOpenWrite -- whose failure path is
Sys_Error, which tears down the video system mid-frame.
*/
export function homedirRoot(): string {
  const explicit = process.env.Q1TS_HOMEDIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  return `${process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests"}/e2e/home`;
}

export function homedirArgs(game: string): string[] {
  const root = homedirRoot();
  mkdirSync(`${root}/${game}/glquake`, { recursive: true });
  return ["-homedir", root];
}

/** homedirArgs for whichever `-game` an argv already names (id1 when it names none). */
export function homedirArgsFor(argv: readonly string[]): string[] {
  const i = argv.indexOf("-game");
  const game = i >= 0 && i + 1 < argv.length ? argv[i + 1] : "id1";
  return homedirArgs(game);
}
