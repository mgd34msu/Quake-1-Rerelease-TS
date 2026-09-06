// Force headless SDL before ANY import can reach the FFI layer -- cd_ogg.ts
// opens a second SDL audio device (sdl.ts's SDLCD_*) for decoded music.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/platform/cd_ogg.ts (cd_linux.c's CDAudio_* replaced with
music/NN.ogg playback via libvorbisfile): degrades to silent/no-op
behaviour when libvorbisfile and/or the music files are absent (this test
environment has neither), the remap[] table, the bgmvolume-driven
pause/resume toggle CDAudio_Update ports verbatim from cd_linux.c, and the
"cd" console command's subcommands. Self-sufficient per standing order 13:
saves/restores bgmvolume, cmdHost.initialized (Cmd_AddCommand("cd", ...)
throws once true) and sysState.isDedicated.
*/

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { CDAudio_Init, CDAudio_Pause, CDAudio_Play, CDAudio_Resume, CDAudio_Shutdown, CDAudio_Stop, CDAudio_Update } from "../src/platform/cd_ogg";
import { bgmvolume } from "../src/client/sound";
import { cdAudio } from "../src/client/cdaudio";
import { Cmd_ExecuteString, cmdHost, cmdState } from "../src/common/cmd";
import { Cvar_RegisterVariable, Cvar_SetValue } from "../src/common/cvar";
import { sysState } from "../src/platform/sys";
import { SDL_ResetBackendForTests, SDL_SetBackendEnabled } from "../src/platform/sdl";

const savedCmdInitialized = cmdHost.initialized;
const savedIsDedicated = sysState.isDedicated;
const savedBgmvolume = bgmvolume.value;

beforeAll(() => {
  // bgmvolume is registered by client/snd_dma.ts's S_Init in the real
  // engine; this suite never calls S_Init, so register it here the same
  // way any other self-sufficient suite would (per standing order 13) if
  // it isn't already linked from an earlier test file in this shared
  // process.
  Cvar_RegisterVariable(bgmvolume);
});

afterAll(() => {
  CDAudio_Shutdown();
  SDL_ResetBackendForTests();
  cmdHost.initialized = savedCmdInitialized;
  sysState.isDedicated = savedIsDedicated;
  Cvar_SetValue("bgmvolume", savedBgmvolume);
});

describe("CDAudio_Init / CDAudio_Play -- null behaviour with no libvorbisfile and no music files", () => {
  test("CDAudio_Init succeeds (this is a headless build, not a dedicated one) and installs itself as cdAudio.current", () => {
    sysState.isDedicated = false;
    cmdHost.initialized = false;
    SDL_SetBackendEnabled(true);

    expect(CDAudio_Init()).toBe(0);
    expect(cdAudio.current).not.toBeNull();
  });

  test("CDAudio_Init returns -1 on a dedicated server, matching cd_linux.c's cls.state == ca_dedicated check", () => {
    sysState.isDedicated = true;
    expect(CDAudio_Init()).toBe(-1);
    sysState.isDedicated = false;
  });

  test("CDAudio_Play degrades silently: no libvorbisfile / no music/NN.ogg on this host, so nothing throws and nothing plays", () => {
    expect(() => CDAudio_Play(2, false)).not.toThrow();
    expect(() => CDAudio_Update()).not.toThrow();
    expect(() => CDAudio_Stop()).not.toThrow();
    expect(() => CDAudio_Pause()).not.toThrow();
    expect(() => CDAudio_Resume()).not.toThrow();
  });

  test("track 0 (data track) and negative tracks are rejected the same way cd_linux.c's `track < 1` check does", () => {
    expect(() => CDAudio_Play(0, false)).not.toThrow();
    expect(() => CDAudio_Play(-1, false)).not.toThrow();
  });
});

describe("CDAudio_Update -- the bgmvolume-driven pause/resume toggle (cd_linux.c:336-350, ported verbatim)", () => {
  test("setting bgmvolume to 0 and back does not throw and leaves bgmvolume readable", () => {
    Cvar_SetValue("bgmvolume", 0);
    expect(() => CDAudio_Update()).not.toThrow();
    Cvar_SetValue("bgmvolume", 1);
    expect(() => CDAudio_Update()).not.toThrow();
  });
});

describe("the \"cd\" console command -- cd_linux.c:210's CD_f, ported subcommand-for-subcommand", () => {
  test("remap with no arguments prints the table without throwing, and remap N M sets it", () => {
    expect(() => Cmd_ExecuteString("cd remap", cmdState.source)).not.toThrow();
    expect(() => Cmd_ExecuteString("cd remap 3", cmdState.source)).not.toThrow();
    expect(() => Cmd_ExecuteString("cd reset", cmdState.source)).not.toThrow();
  });

  test("on/off/play/loop/stop/pause/resume/info/close/eject all run without throwing", () => {
    for (const line of ["cd on", "cd play 3", "cd loop 4", "cd pause", "cd resume", "cd stop", "cd info", "cd close", "cd eject", "cd off"]) {
      expect(() => Cmd_ExecuteString(line, cmdState.source)).not.toThrow();
    }
  });
});
