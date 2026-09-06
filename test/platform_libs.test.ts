/*
Self-sufficient test for src/platform/libs.ts -- the native-library resolver
every bun:ffi consumer in the port goes through (sdl.ts, ref_gl/qgl.ts,
cd_ogg.ts, sockets.ts).

`librarySearch` takes the platform, the two candidate directories and the
environment override as arguments rather than reading `process`, so this one
Linux run checks the Windows and macOS lists too -- which is the only way
they can be checked at all, since the port has no Windows or macOS host (see
docs/PLATFORMS.md).
*/

import { describe, expect, test } from "bun:test";
import {
  currentLibrarySearch,
  libraryEnvVar,
  libraryLabel,
  librarySearch,
  librarySearchFailure,
  openLibrary,
  type LibraryDirs,
} from "../src/platform/libs";

const unixDirs: LibraryDirs = { exeDir: "/home/player/games/q1ts", cwd: "/home/player/quake" };
const winDirs: LibraryDirs = { exeDir: "C:\\Games\\Quake", cwd: "D:\\work" };

describe("librarySearch -- SDL2", () => {
  test("Linux tries the SONAME first, then the development symlink", () => {
    expect(librarySearch("sdl2", "linux", unixDirs, undefined).candidates).toEqual(["libSDL2-2.0.so.0", "libSDL2.so"]);
  });

  test("Windows tries the bare name (LoadLibrary's own search) then the exe directory then the cwd, with backslashes", () => {
    expect(librarySearch("sdl2", "win32", winDirs, undefined).candidates).toEqual([
      "SDL2.dll",
      "C:\\Games\\Quake\\SDL2.dll",
      "D:\\work\\SDL2.dll",
    ]);
  });

  test("macOS tries both dylib names, both Homebrew prefixes, then a copy next to the binary", () => {
    expect(librarySearch("sdl2", "darwin", unixDirs, undefined).candidates).toEqual([
      "libSDL2-2.0.0.dylib",
      "libSDL2.dylib",
      "/opt/homebrew/lib/libSDL2-2.0.0.dylib",
      "/usr/local/lib/libSDL2-2.0.0.dylib",
      "/home/player/games/q1ts/libSDL2-2.0.0.dylib",
    ]);
  });

  test("an unrecognised platform takes the Linux list", () => {
    expect(librarySearch("sdl2", "freebsd", unixDirs, undefined).candidates).toEqual(["libSDL2-2.0.so.0", "libSDL2.so"]);
  });
});

describe("librarySearch -- OpenGL", () => {
  test("Linux uses the same SONAME gl_vidlinuxglx.c dlopen()s", () => {
    expect(librarySearch("gl", "linux", unixDirs, undefined).candidates[0]).toBe("libGL.so.1");
  });

  test("Windows uses opengl32.dll, the GL 1.1 exports gl_vidnt.c links against", () => {
    expect(librarySearch("gl", "win32", winDirs, undefined).candidates).toEqual(["opengl32.dll"]);
  });

  test("macOS uses the OpenGL framework binary", () => {
    expect(librarySearch("gl", "darwin", unixDirs, undefined).candidates[0]).toBe("/System/Library/Frameworks/OpenGL.framework/OpenGL");
  });
});

describe("librarySearch -- libvorbisfile", () => {
  test("every platform offers more than one name, since the CD-audio replacement is optional", () => {
    for (const platform of ["linux", "win32", "darwin"]) {
      const dirs = platform === "win32" ? winDirs : unixDirs;
      expect(librarySearch("vorbisfile", platform, dirs, undefined).candidates.length).toBeGreaterThan(1);
    }
  });

  test("Linux keeps the SONAME the pre-resolver code used", () => {
    expect(librarySearch("vorbisfile", "linux", unixDirs, undefined).candidates).toEqual(["libvorbisfile.so.3", "libvorbisfile.so"]);
  });
});

describe("librarySearch -- the socket library", () => {
  test("Linux keeps libc.so.6 with the libc.so fallback net_udp.ts used before", () => {
    expect(librarySearch("sockets", "linux", unixDirs, undefined).candidates).toEqual(["libc.so.6", "libc.so"]);
  });

  test("Windows asks for Winsock 2, with net_wins.c's own wsock32.dll behind it", () => {
    expect(librarySearch("sockets", "win32", winDirs, undefined).candidates).toEqual(["ws2_32.dll", "wsock32.dll"]);
  });

  test("macOS reaches the socket calls through libSystem", () => {
    expect(librarySearch("sockets", "darwin", unixDirs, undefined).candidates[0]).toBe("libSystem.B.dylib");
  });
});

describe("the environment overrides", () => {
  test("each library has its own variable name", () => {
    expect(libraryEnvVar("sdl2")).toBe("Q1TS_SDL2_LIB");
    expect(libraryEnvVar("gl")).toBe("Q1TS_GL_LIB");
    expect(libraryEnvVar("vorbisfile")).toBe("Q1TS_VORBISFILE_LIB");
    expect(libraryEnvVar("sockets")).toBe("Q1TS_LIBC_LIB");
  });

  test("an override replaces the whole list rather than heading it, so a wrong path is an error and not a silent fall-through", () => {
    const search = librarySearch("sdl2", "linux", unixDirs, "/opt/sdl/lib/libSDL2-2.0.so.0");
    expect(search.candidates).toEqual(["/opt/sdl/lib/libSDL2-2.0.so.0"]);
  });

  test("an empty override is ignored", () => {
    expect(librarySearch("sdl2", "linux", unixDirs, "").candidates).toEqual(["libSDL2-2.0.so.0", "libSDL2.so"]);
  });
});

describe("librarySearchFailure", () => {
  test("names the library, every candidate with its own error, and the variable that overrides the list", () => {
    const search = librarySearch("vorbisfile", "linux", unixDirs, undefined);
    const message = librarySearchFailure(search, [
      { name: "libvorbisfile.so.3", error: "cannot open shared object file" },
      { name: "libvorbisfile.so", error: "cannot open shared object file" },
    ]);

    expect(message).toContain(libraryLabel("vorbisfile"));
    expect(message).toContain("libvorbisfile.so.3");
    expect(message).toContain("libvorbisfile.so");
    expect(message).toContain("cannot open shared object file");
    expect(message).toContain("Q1TS_VORBISFILE_LIB");
  });
});

describe("openLibrary", () => {
  test("reports rather than throws when nothing in the list loads", () => {
    const search = { kind: "sdl2", label: "SDL2", envVar: "Q1TS_SDL2_LIB", candidates: ["/nonexistent/one.so", "/nonexistent/two.so"] } as const;
    const opened = openLibrary(search, { nothing: { args: [], returns: "void" } } as const);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.message).toContain("/nonexistent/one.so");
      expect(opened.message).toContain("/nonexistent/two.so");
    }
  });

  test("falls through to a later candidate when an earlier one is missing", () => {
    // The socket library is the one native dependency this host is certain to
    // have, and the first candidate here cannot exist.
    const search = { kind: "sockets", label: "the system socket library", envVar: "Q1TS_LIBC_LIB", candidates: ["/nonexistent/libc.so.6", ...currentLibrarySearch("sockets").candidates] } as const;
    const opened = openLibrary(search, { strerror: { args: ["i32"], returns: "cstring" } } as const);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.name).not.toBe("/nonexistent/libc.so.6");
      // bun:ffi's "cstring" hands back a CString, so read it as text.
      expect(String(opened.lib.symbols.strerror(2) ?? "").length).toBeGreaterThan(0);
      opened.lib.close();
    }
  });
});

describe("currentLibrarySearch", () => {
  test("produces this host's own list, so the Linux run resolves the same names the pre-resolver code hardcoded", () => {
    const search = currentLibrarySearch("sdl2");
    expect(search.envVar).toBe("Q1TS_SDL2_LIB");
    // An override in the environment replaces the list; only assert the
    // built-in one when there is none.
    if (process.platform === "linux" && process.env.Q1TS_SDL2_LIB === undefined) {
      expect(search.candidates[0]).toBe("libSDL2-2.0.so.0");
    }
  });
});
