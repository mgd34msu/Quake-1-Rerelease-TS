/*
Copyright (C) 1996-1997 Id Software, Inc.

Not a WinQuake/QW source file. The C tree resolves its native dependencies at
link time (`-lX11 -lGL -lvorbisfile`, `winsock.dll` via LoadLibrary in
net_wins.c, `opengl32.dll` via the import library in gl_vidnt.c). A
`bun build --compile` binary has no link step, so every native dependency is
opened at run time through `bun:ffi`'s dlopen -- which needs the file name the
host OS actually ships. This module is the one place those names live: one
candidate list per library per OS, tried in order, with an environment
override and a single error message that names what was tried.

The candidate lists follow the C's own choices where the C makes one:
gl_vidlinuxglx.c:545 dlopen()s "libGL.so.1", gl_vidnt.c links opengl32,
net_wins.c:130 LoadLibrary()s "wsock32.dll" (this port asks for ws2_32.dll --
see sockets.ts). SDL2 and libvorbisfile are this port's own substitutions for
Xlib/DGA and cd_linux.c's /dev/cdrom ioctls, so their names come from what the
three target OSes ship.

Nothing here opens a library at module load; `openLibrary` is called lazily by
each consumer (sdl.ts, qgl.ts, cd_ogg.ts, sockets.ts), so a dedicated server
that never touches video still never touches libSDL2.
*/

import { dlopen, type Library, type Symbols } from "bun:ffi";

export type LibraryKind = "sdl2" | "gl" | "vorbisfile" | "sockets";

// Where the process can look for a library that ships next to the game rather
// than in a system directory. Passed in rather than read from `process` so the
// candidate builder stays a pure function the test suite can drive for every
// OS from this one (Linux) host.
export interface LibraryDirs {
  readonly exeDir: string;
  readonly cwd: string;
}

export interface LibrarySearch {
  readonly kind: LibraryKind;
  readonly label: string;
  readonly envVar: string;
  readonly candidates: readonly string[];
}

const labels: Readonly<Record<LibraryKind, string>> = {
  sdl2: "SDL2",
  gl: "OpenGL",
  vorbisfile: "libvorbisfile",
  sockets: "the system socket library",
};

const envVars: Readonly<Record<LibraryKind, string>> = {
  sdl2: "Q1TS_SDL2_LIB",
  gl: "Q1TS_GL_LIB",
  vorbisfile: "Q1TS_VORBISFILE_LIB",
  sockets: "Q1TS_LIBC_LIB",
};

export function libraryLabel(kind: LibraryKind): string {
  return labels[kind];
}

export function libraryEnvVar(kind: LibraryKind): string {
  return envVars[kind];
}

// node:path would give this host's separator for every platform; the point of
// taking `platform` as an argument is that one Linux test run can check the
// Windows list, so the separator is chosen from the argument too.
function joinPath(platform: string, dir: string, file: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  if (dir.length === 0) return file;
  const last = dir.charAt(dir.length - 1);
  if (last === "/" || last === "\\") return `${dir}${file}`;
  return `${dir}${sep}${file}`;
}

function sdl2Candidates(platform: string, dirs: LibraryDirs): string[] {
  switch (platform) {
    case "win32":
      // Bun's dlopen is LoadLibraryW, whose own search order already covers
      // the executable's directory, the system directories and PATH; the
      // explicit paths after it cover a cwd that LoadLibrary skips when
      // SafeDllSearchMode is on, and make the error message concrete.
      return ["SDL2.dll", joinPath(platform, dirs.exeDir, "SDL2.dll"), joinPath(platform, dirs.cwd, "SDL2.dll")];
    case "darwin":
      return [
        "libSDL2-2.0.0.dylib",
        "libSDL2.dylib",
        "/opt/homebrew/lib/libSDL2-2.0.0.dylib",
        "/usr/local/lib/libSDL2-2.0.0.dylib",
        joinPath(platform, dirs.exeDir, "libSDL2-2.0.0.dylib"),
      ];
    default:
      return ["libSDL2-2.0.so.0", "libSDL2.so"];
  }
}

function glCandidates(platform: string): string[] {
  switch (platform) {
    case "win32":
      // opengl32.dll exports GL 1.1 and nothing later. That is the whole of
      // what GLQuake's qgl table asks for; every extension entry point goes
      // through SDL_GL_GetProcAddress (wglGetProcAddress underneath), never
      // through this handle -- see qgl.ts.
      return ["opengl32.dll"];
    case "darwin":
      return ["/System/Library/Frameworks/OpenGL.framework/OpenGL", "/System/Library/Frameworks/OpenGL.framework/Versions/Current/OpenGL"];
    default:
      return ["libGL.so.1", "libGL.so"];
  }
}

function vorbisfileCandidates(platform: string, dirs: LibraryDirs): string[] {
  switch (platform) {
    case "win32":
      return [
        "libvorbisfile-3.dll",
        "vorbisfile.dll",
        "libvorbisfile.dll",
        joinPath(platform, dirs.exeDir, "libvorbisfile-3.dll"),
        joinPath(platform, dirs.exeDir, "vorbisfile.dll"),
      ];
    case "darwin":
      return [
        "libvorbisfile.3.dylib",
        "libvorbisfile.dylib",
        "/opt/homebrew/lib/libvorbisfile.3.dylib",
        "/usr/local/lib/libvorbisfile.3.dylib",
        joinPath(platform, dirs.exeDir, "libvorbisfile.3.dylib"),
      ];
    default:
      return ["libvorbisfile.so.3", "libvorbisfile.so"];
  }
}

function socketsCandidates(platform: string): string[] {
  switch (platform) {
    case "win32":
      // net_wins.c:130 LoadLibrary()s "wsock32.dll", the Winsock 1.1
      // compatibility stub. This port asks for Winsock 2 directly (see
      // sockets.ts's WSAStartup note); wsock32.dll stays as a fallback
      // because it forwards every entry point used here to ws2_32.dll.
      return ["ws2_32.dll", "wsock32.dll"];
    case "darwin":
      return ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"];
    default:
      return ["libc.so.6", "libc.so"];
  }
}

/*
The pure half: given an OS, the two directories a game-local copy could sit
in, and the environment override's value, produce the ordered candidate list.
An override replaces the list rather than heading it, so a user who points
Q1TS_SDL2_LIB at the wrong file gets an error naming that file instead of a
silent fall-through to a system copy.
*/
export function librarySearch(kind: LibraryKind, platform: string, dirs: LibraryDirs, override: string | undefined): LibrarySearch {
  const label = labels[kind];
  const envVar = envVars[kind];

  if (override !== undefined && override.length > 0) {
    return { kind, label, envVar, candidates: [override] };
  }

  switch (kind) {
    case "sdl2":
      return { kind, label, envVar, candidates: sdl2Candidates(platform, dirs) };
    case "gl":
      return { kind, label, envVar, candidates: glCandidates(platform) };
    case "vorbisfile":
      return { kind, label, envVar, candidates: vorbisfileCandidates(platform, dirs) };
    case "sockets":
      return { kind, label, envVar, candidates: socketsCandidates(platform) };
  }
}

function exeDirOf(execPath: string): string {
  const cut = Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"));
  return cut > 0 ? execPath.slice(0, cut) : "";
}

// The same thing for the process this code is actually running in.
export function currentLibrarySearch(kind: LibraryKind): LibrarySearch {
  const dirs: LibraryDirs = { exeDir: exeDirOf(process.execPath), cwd: process.cwd() };
  return librarySearch(kind, process.platform, dirs, process.env[envVars[kind]]);
}

export interface LibraryAttempt {
  readonly name: string;
  readonly error: string;
}

export function librarySearchFailure(search: LibrarySearch, attempts: readonly LibraryAttempt[]): string {
  const tried = attempts.map((a) => `  ${a.name}: ${a.error}`).join("\n");
  return `could not load ${search.label}. Tried:\n${tried}\nSet ${search.envVar} to the full path of the library to override this list.`;
}

export type OpenedLibrary<Fns extends Symbols> =
  | { readonly ok: true; readonly name: string; readonly lib: Library<Fns> }
  | { readonly ok: false; readonly message: string };

/*
Try each candidate in turn. Never throws: every consumer of this module has a
defined behaviour for "the library is not here" (SDL2 -> headless, libGL ->
the software renderer, libvorbisfile -> no CD audio, sockets -> loopback
only), and a throw from a lazy dlopen deep inside a frame would bypass all of
them.
*/
export function openLibrary<Fns extends Symbols>(search: LibrarySearch, symbols: Fns): OpenedLibrary<Fns> {
  const attempts: LibraryAttempt[] = [];
  for (const name of search.candidates) {
    try {
      return { ok: true, name, lib: dlopen(name, symbols) };
    } catch (err) {
      attempts.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: false, message: librarySearchFailure(search, attempts) };
}
