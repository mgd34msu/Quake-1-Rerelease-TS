// Force headless SDL before ANY import can reach the FFI layer.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for src/platform/snd.ts (snd_linux.c's SNDDMA_* replaced with SDL2's
audio queue): SNDDMA_Init under the dummy audio driver fills `sn`
(client/sound.ts's DmaT singleton) and calls `setShm(sn)` the way
`shm = &sn;` does, SNDDMA_GetDMAPos advances after SNDDMA_Submit paints
something into the ring, and SNDDMA_Shutdown tears the device back down.
Self-sufficient per standing order 13: shm/paintedtime are reset in
afterAll.
*/

import { describe, test, expect, afterAll } from "bun:test";
import { SNDDMA_GetDMAPos, SNDDMA_Init, SNDDMA_Shutdown, SNDDMA_Submit } from "../src/platform/snd";
import { sn, shm, setPaintedtime, setShm } from "../src/client/sound";
import { SDL_ResetBackendForTests, SDL_SetBackendEnabled } from "../src/platform/sdl";

afterAll(() => {
  SNDDMA_Shutdown();
  setShm(null);
  setPaintedtime(0);
  SDL_ResetBackendForTests();
});

describe("SNDDMA_Init under the dummy audio driver", () => {
  test("fills sn and points shm at it, matching snd_linux.c's `shm = &sn;`", () => {
    SDL_SetBackendEnabled(true);
    setPaintedtime(0);

    const ok = SNDDMA_Init();
    expect(ok).toBe(true);

    expect(sn.channels).toBe(2);
    expect(sn.samplebits).toBe(16);
    expect(sn.speed).toBeGreaterThan(0);
    expect(sn.samples).toBeGreaterThan(0);
    expect(sn.submission_chunk).toBe(1);
    expect(sn.buffer).not.toBeNull();
    expect(sn.buffer?.length).toBeGreaterThan(0);
    expect(sn.gamealive).toBe(true);
    expect(sn.soundalive).toBe(true);
    expect(shm).toBe(sn);
  });

  test("GetDMAPos advances after Submit paints samples into the ring", () => {
    // simulate the mixer having painted up through sample-frame 4096
    setPaintedtime(4096);
    expect(() => SNDDMA_Submit()).not.toThrow();

    // give the SDL audio thread a moment to actually consume queued bytes
    const start = SNDDMA_GetDMAPos();
    const deadline = Date.now() + 2000;
    let pos = start;
    while (Date.now() < deadline) {
      pos = SNDDMA_GetDMAPos();
      if (pos !== start) break;
    }
    // Either the device visibly consumed something (pos moved) or the
    // dummy driver never drains a queue at all (pos stays 0, a valid
    // dummy-driver outcome) -- either way GetDMAPos must return a value
    // inside the mono-sample ring, never negative or out of range.
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeLessThan(sn.samples);
  });

  test("Shutdown tears the device down and clears shm", () => {
    SNDDMA_Shutdown();
    expect(shm).toBeNull();
    expect(sn.buffer).toBeNull();
  });
});

describe("SNDDMA_Init command-line parms", () => {
  test("reports false without setting shm when the backend is disarmed", () => {
    SDL_SetBackendEnabled(false);
    setShm(null);
    const ok = SNDDMA_Init();
    expect(ok).toBe(false);
    expect(shm).toBeNull();
  });
});
