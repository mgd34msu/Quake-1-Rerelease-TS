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
