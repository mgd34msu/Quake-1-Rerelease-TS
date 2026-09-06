// Self-sufficient test for src/client/cl_tent.ts (WinQuake cl_tent.c).
//
// cl_tent.ts's four sibling imports are all landed, real modules now:
//   - "./cl_main" (CL_AllocDlight) -- its real body only touches the
//     cl_dlights singleton, so it runs unmodified; wrapped with `spyOn`
//     (calls through) purely to observe the key/returned-dlight per call.
//   - "./r_part" (R_RunParticleEffect and friends) -- each real function is
//     a safe no-op when the particle pool is empty (this suite never calls
//     R_InitParticles/R_ClearParticles, so `free_particles` stays null and
//     every allocation loop's `if (!free_particles) return` fires
//     immediately); wrapped with `spyOn` (calls through) to observe the
//     org/dir/color/count arguments cl_tent.ts passes, the same thing the
//     old fakes recorded.
//   - "./snd_dma" (S_PrecacheSound, S_StartSound) -- these need
//     `sound_started` true to do anything at all (S_PrecacheSound returns
//     null outright otherwise), so this file installs the same fake
//     `SndDma` driver test/snd.test.ts uses and calls the real `S_Init()`
//     once; the missing "sound/*.wav" files this suite never fixtures are
//     handled by S_LoadSound's own graceful "Couldn't load" `Con_Printf` +
//     null return (confirmed: no COM_InitFilesystem call is needed either --
//     COM_FindFile degrades to "not found" with `com_searchpaths` still
//     null). S_PrecacheSound/S_StartSound are wrapped with `spyOn` (calls
//     through) to observe their arguments and, for S_PrecacheSound, its
//     returned SfxT (identified by `.name`, replacing the old fake's
//     identity-string return).
//   - "../common/model" (Mod_ForName) -- real behavior needs an actual
//     .mdl file reachable through COM_FindFile (fidelity this suite leaves
//     to model.test.ts: with `crash=true` and no such file, the real
//     function throws). Mod_ForName is the one export here that keeps a
//     full `spyOn(...).mockImplementation(...)` override rather than a
//     call-through wrap, returning a fresh `ModelT` per call so
//     CL_ParseTEnt's TE_LIGHTNING*/TE_BEAM dispatch can still be observed
//     by identity.
// Every spy wraps the real module's own exported property (mutated in
// place, restored via `mockRestore()` in `afterAll`) rather than replacing
// the whole module the way `mock.module` does, so no other file's import of
// the same specifier ever sees a partial export shape.
//
// `num_temp_entities` and the seven `cl_sfx_*` holders are live ES bindings
// (`export let`) on cl_tent.ts, so this file reads them off the imported
// module namespace object (`cl_tent.num_temp_entities`) rather than through
// a destructured copy, which would only capture the value at import time.

import { describe, test, expect, beforeEach, beforeAll, afterAll, spyOn, type Mock } from "bun:test";
import { SZ_Alloc, SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteCoord, net_message } from "../src/common/sizebuf";
import {
  TE_BEAM,
  TE_EXPLOSION,
  TE_EXPLOSION2,
  TE_GUNSHOT,
  TE_KNIGHTSPIKE,
  TE_LAVASPLASH,
  TE_LIGHTNING1,
  TE_LIGHTNING2,
  TE_LIGHTNING3,
  TE_SPIKE,
  TE_SUPERSPIKE,
  TE_TAREXPLOSION,
  TE_TELEPORT,
  TE_WIZSPIKE,
} from "../src/common/protocol";
import * as modelMod from "../src/common/model";
import { ModelT } from "../src/common/model";
import { SysError } from "../src/platform/sys";
import { cl, cl_beams, cl_entities, cl_visedicts, clState, DlightT, MAX_BEAMS, MAX_TEMP_ENTITIES, MAX_VISEDICTS } from "../src/client/client";
import { vid } from "../src/client/vid";
import * as cl_main from "../src/client/cl_main";
import * as r_part from "../src/client/r_part";
import * as snd_dma from "../src/client/snd_dma";
import { DmaT, setShm, sndDma, SfxT, type SndDma } from "../src/client/sound";
import * as cl_tent from "../src/client/cl_tent";

// -- spies wrapping the real cl_main/r_part/snd_dma/model exports (see the
// file header) ---------------------------------------------------------

const allocDlightSpy = spyOn(cl_main, "CL_AllocDlight");
const runParticleEffectSpy = spyOn(r_part, "R_RunParticleEffect");
const particleExplosionSpy = spyOn(r_part, "R_ParticleExplosion");
const particleExplosion2Spy = spyOn(r_part, "R_ParticleExplosion2");
const blobExplosionSpy = spyOn(r_part, "R_BlobExplosion");
const lavaSplashSpy = spyOn(r_part, "R_LavaSplash");
const teleportSplashSpy = spyOn(r_part, "R_TeleportSplash");
const precacheSoundSpy = spyOn(snd_dma, "S_PrecacheSound");
const startSoundSpy = spyOn(snd_dma, "S_StartSound");

// Mod_ForName's override REPLACES real behavior (unlike the call-through
// spies above), so unlike them it must not be installed at module scope --
// every test file's top-level code runs during bun test's shared
// file-loading pass, strictly before any test() body from any file
// actually executes, so a top-level replacement here would still be "in
// effect" while test/model.test.ts's own tests (which need the real
// Mod_ForName) run, in whichever file order bun happens to use. Creating it
// in `beforeAll` instead confines the replacement to this file's own
// test-execution window, symmetric with the `mockRestore()` in `afterAll`.
let lastFakeModel: ModelT | null = null;
let modForNameSpy: Mock<(name: string, crash: boolean) => ModelT | null>;

// src/platform/snd.ts installs the real SndDma at module load (a
// side-effect import reached through src/main.ts); installFakeSoundDriver
// below replaces it with this file's own fake for the duration of this
// suite. Hard-nulling it in afterAll (instead of restoring this snapshot)
// would permanently wipe out that real installation for the rest of this
// bun process, breaking any later suite that expects sndDma.current
// installed (test/main_boot.test.ts's own check in particular) (rule 15).
const savedSndDma = sndDma.current;

afterAll(() => {
  allocDlightSpy.mockRestore();
  runParticleEffectSpy.mockRestore();
  particleExplosionSpy.mockRestore();
  particleExplosion2Spy.mockRestore();
  blobExplosionSpy.mockRestore();
  lavaSplashSpy.mockRestore();
  teleportSplashSpy.mockRestore();
  precacheSoundSpy.mockRestore();
  startSoundSpy.mockRestore();
  modForNameSpy.mockRestore();
  sndDma.current = savedSndDma;
});

// -- fake SndDma driver (src/platform/snd.ts), same pattern as
// test/snd.test.ts -- S_PrecacheSound/S_StartSound both bail out
// immediately unless `sound_started` is true.
const FAKE_SAMPLES = 8192;
const fakeSndDma: SndDma = {
  SNDDMA_Init(): boolean {
    return true;
  },
  SNDDMA_GetDMAPos(): number {
    return 0;
  },
  SNDDMA_Shutdown(): void {},
  SNDDMA_Submit(): void {},
};
function installFakeSoundDriver(): void {
  const dma = new DmaT();
  dma.samplebits = 16;
  dma.channels = 2;
  dma.speed = 11025;
  dma.samples = FAKE_SAMPLES;
  dma.submission_chunk = 1;
  dma.samplepos = 0;
  dma.soundalive = true;
  dma.gamealive = true;
  dma.buffer = new Uint8Array((dma.samples * dma.samplebits) / 8);
  setShm(dma);
  sndDma.current = fakeSndDma;
}

// -- snapshot helpers replaying the old fakes' recorded-call shape, sourced
// from the real spies instead ------------------------------------------

interface ParticleCall {
  fn: string;
  args: unknown[];
}
function particleCallsSnapshot(): ParticleCall[] {
  const out: ParticleCall[] = [];
  for (const [org, dir, color, count] of runParticleEffectSpy.mock.calls) {
    out.push({ fn: "R_RunParticleEffect", args: [Array.from(org), Array.from(dir), color, count] });
  }
  for (const [org] of particleExplosionSpy.mock.calls) {
    out.push({ fn: "R_ParticleExplosion", args: [Array.from(org)] });
  }
  for (const [org, colorStart, colorLength] of particleExplosion2Spy.mock.calls) {
    out.push({ fn: "R_ParticleExplosion2", args: [Array.from(org), colorStart, colorLength] });
  }
  for (const [org] of blobExplosionSpy.mock.calls) {
    out.push({ fn: "R_BlobExplosion", args: [Array.from(org)] });
  }
  for (const [org] of lavaSplashSpy.mock.calls) {
    out.push({ fn: "R_LavaSplash", args: [Array.from(org)] });
  }
  for (const [org] of teleportSplashSpy.mock.calls) {
    out.push({ fn: "R_TeleportSplash", args: [Array.from(org)] });
  }
  return out;
}

interface SoundCall {
  entnum: number;
  entchannel: number;
  sfx: unknown;
  origin: number[];
  fvol: number;
  attenuation: number;
}
function soundCallsSnapshot(): SoundCall[] {
  return startSoundSpy.mock.calls.map(([entnum, entchannel, sfx, origin, fvol, attenuation]) => ({
    entnum,
    entchannel,
    sfx: sfx instanceof SfxT ? sfx.name : sfx,
    origin: Array.from(origin),
    fvol,
    attenuation,
  }));
}

interface DlightCall {
  key: number;
  dlight: DlightT;
}
function dlightCallsSnapshot(): DlightCall[] {
  const out: DlightCall[] = [];
  allocDlightSpy.mock.calls.forEach(([key], i) => {
    const result = allocDlightSpy.mock.results[i];
    if (result && result.type === "return") out.push({ key, dlight: result.value });
  });
  return out;
}

function modForNameCallsSnapshot(): Array<{ name: string; crash: boolean }> {
  return modForNameSpy.mock.calls.map(([name, crash]) => ({ name, crash }));
}

function precacheCallsSnapshot(): string[] {
  return precacheSoundSpy.mock.calls.map(([path]) => path);
}

function resetSpies(): void {
  allocDlightSpy.mockClear();
  runParticleEffectSpy.mockClear();
  particleExplosionSpy.mockClear();
  particleExplosion2Spy.mockClear();
  blobExplosionSpy.mockClear();
  lavaSplashSpy.mockClear();
  teleportSplashSpy.mockClear();
  precacheSoundSpy.mockClear();
  startSoundSpy.mockClear();
  modForNameSpy.mockClear();
}

// cl_tent.ts's cl_sfx_* holders are typed sound.ts's real `SfxT | null`;
// checking `.name` is the real-module equivalent of the old fake's identity
// return.
function expectSfxPath(value: unknown, expected: string): void {
  expect(value instanceof SfxT).toBe(true);
  if (value instanceof SfxT) {
    expect(value.name).toBe(expected);
  }
}

// -- shared fixtures ---------------------------------------------------------

function resetBeams(): void {
  for (const b of cl_beams) {
    b.entity = 0;
    b.model = null;
    b.endtime = 0;
    b.start[0] = b.start[1] = b.start[2] = 0;
    b.end[0] = b.end[1] = b.end[2] = 0;
  }
}

function beginTEntMessage(): void {
  SZ_Alloc(net_message, 2048);
  SZ_Clear(net_message);
}

function parseTEnt(): void {
  MSG_BeginReading();
  cl_tent.CL_ParseTEnt();
}

beforeAll(() => {
  installFakeSoundDriver();
  snd_dma.S_Init(); // real S_Init: precache/S_StartSound need sound_started true (see file header)
  modForNameSpy = spyOn(modelMod, "Mod_ForName").mockImplementation((_name: string, _crash: boolean): ModelT => {
    lastFakeModel = new ModelT();
    return lastFakeModel;
  });
});

beforeEach(() => {
  resetSpies();
  resetBeams();
  clState.cl_numvisedicts = 0;
  cl.time = 0;
  cl.viewentity = 0;
});

describe("CL_InitTEnts", () => {
  test("precaches the exact wav paths from cl_tent.c, in order", () => {
    precacheSoundSpy.mockClear();
    cl_tent.CL_InitTEnts();
    expect(precacheCallsSnapshot()).toEqual([
      "wizard/hit.wav",
      "hknight/hit.wav",
      "weapons/tink1.wav",
      "weapons/ric1.wav",
      "weapons/ric2.wav",
      "weapons/ric3.wav",
      "weapons/r_exp3.wav",
    ]);
    expectSfxPath(cl_tent.cl_sfx_wizhit, "wizard/hit.wav");
    expectSfxPath(cl_tent.cl_sfx_knighthit, "hknight/hit.wav");
    expectSfxPath(cl_tent.cl_sfx_tink1, "weapons/tink1.wav");
    expectSfxPath(cl_tent.cl_sfx_ric1, "weapons/ric1.wav");
    expectSfxPath(cl_tent.cl_sfx_ric2, "weapons/ric2.wav");
    expectSfxPath(cl_tent.cl_sfx_ric3, "weapons/ric3.wav");
    expectSfxPath(cl_tent.cl_sfx_r_exp3, "weapons/r_exp3.wav");
  });
});

describe("CL_ParseBeam", () => {
  test("overrides an existing beam entry for the same entity number", () => {
    cl.time = 100;
    cl_beams[3].entity = 77;
    cl_beams[3].model = new ModelT();
    cl_beams[3].endtime = 500;

    beginTEntMessage();
    MSG_WriteShort(net_message, 77);
    MSG_WriteCoord(net_message, 1);
    MSG_WriteCoord(net_message, 2);
    MSG_WriteCoord(net_message, 3);
    MSG_WriteCoord(net_message, 4);
    MSG_WriteCoord(net_message, 5);
    MSG_WriteCoord(net_message, 6);
    MSG_BeginReading();

    const newModel = new ModelT();
    cl_tent.CL_ParseBeam(newModel);

    expect(cl_beams[3].model).toBe(newModel);
    expect(cl_beams[3].entity).toBe(77);
    expect(cl_beams[3].endtime).toBeCloseTo(100.2, 5);
    expect(Array.from(cl_beams[3].start)).toEqual([1, 2, 3]);
    expect(Array.from(cl_beams[3].end)).toEqual([4, 5, 6]);
  });

  test("claims the first free slot when no entity matches an existing beam", () => {
    // resetBeams() (beforeEach) leaves every slot free (model === null)
    beginTEntMessage();
    MSG_WriteShort(net_message, 55);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_BeginReading();

    const m = new ModelT();
    cl_tent.CL_ParseBeam(m);

    expect(cl_beams[0].model).toBe(m);
    expect(cl_beams[0].entity).toBe(55);
  });

  test("an expired (endtime < cl.time) beam counts as a free slot", () => {
    cl.time = 100;
    // occupy every earlier slot with a still-active beam so the free-slot
    // loop is forced past them and must reach (and choose) slot 2
    for (let i = 0; i < 2; i++) {
      cl_beams[i].model = new ModelT();
      cl_beams[i].entity = 500 + i;
      cl_beams[i].endtime = cl.time + 1000;
    }
    cl_beams[2].model = new ModelT();
    cl_beams[2].entity = 1;
    cl_beams[2].endtime = 1; // long expired

    beginTEntMessage();
    MSG_WriteShort(net_message, 42);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_BeginReading();

    const m = new ModelT();
    cl_tent.CL_ParseBeam(m);

    expect(cl_beams[2].model).toBe(m);
    expect(cl_beams[2].entity).toBe(42);
  });

  test("prints \"beam list overflow!\" and changes nothing once every slot is taken by an unrelated, still-active entity", () => {
    cl.time = 100;
    for (const b of cl_beams) {
      b.entity = 999;
      b.model = new ModelT();
      b.endtime = cl.time + 1000;
    }
    const snapshotModels = cl_beams.map((b) => b.model);
    const snapshotEntities = cl_beams.map((b) => b.entity);

    beginTEntMessage();
    MSG_WriteShort(net_message, 1); // does not match any of the 999s
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_BeginReading();

    expect(() => cl_tent.CL_ParseBeam(new ModelT())).not.toThrow();
    expect(cl_beams.map((b) => b.model)).toEqual(snapshotModels);
    expect(cl_beams.map((b) => b.entity)).toEqual(snapshotEntities);
  });
});

describe("CL_ParseTEnt: particle-only cases", () => {
  test("TE_WIZSPIKE: color 20, count 30, wizhit sound", () => {
    cl_tent.CL_InitTEnts();
    resetSpies();
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_WIZSPIKE);
    MSG_WriteCoord(net_message, 1);
    MSG_WriteCoord(net_message, 2);
    MSG_WriteCoord(net_message, 3);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_RunParticleEffect", args: [[1, 2, 3], [0, 0, 0], 20, 30] }]);
    expect(soundCallsSnapshot()).toEqual([{ entnum: -1, entchannel: 0, sfx: "wizard/hit.wav", origin: [1, 2, 3], fvol: 1, attenuation: 1 }]);
  });

  test("TE_KNIGHTSPIKE: color 226, count 20, knighthit sound", () => {
    cl_tent.CL_InitTEnts();
    resetSpies();
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_KNIGHTSPIKE);
    MSG_WriteCoord(net_message, 4);
    MSG_WriteCoord(net_message, 5);
    MSG_WriteCoord(net_message, 6);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_RunParticleEffect", args: [[4, 5, 6], [0, 0, 0], 226, 20] }]);
    expect(soundCallsSnapshot()).toEqual([{ entnum: -1, entchannel: 0, sfx: "hknight/hit.wav", origin: [4, 5, 6], fvol: 1, attenuation: 1 }]);
  });

  test("TE_GUNSHOT: color 0, count 20, no sound", () => {
    resetSpies();
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_GUNSHOT);
    MSG_WriteCoord(net_message, 7);
    MSG_WriteCoord(net_message, 8);
    MSG_WriteCoord(net_message, 9);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_RunParticleEffect", args: [[7, 8, 9], [0, 0, 0], 0, 20] }]);
    expect(soundCallsSnapshot()).toEqual([]);
  });

  test("TE_LAVASPLASH: R_LavaSplash only", () => {
    resetSpies();
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_LAVASPLASH);
    MSG_WriteCoord(net_message, 10);
    MSG_WriteCoord(net_message, 11);
    MSG_WriteCoord(net_message, 12);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_LavaSplash", args: [[10, 11, 12]] }]);
  });

  test("TE_TELEPORT: R_TeleportSplash only", () => {
    resetSpies();
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_TELEPORT);
    MSG_WriteCoord(net_message, 13);
    MSG_WriteCoord(net_message, 14);
    MSG_WriteCoord(net_message, 15);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_TeleportSplash", args: [[13, 14, 15]] }]);
  });

  test("TE_TAREXPLOSION: R_BlobExplosion + r_exp3 sound, no dlight", () => {
    cl_tent.CL_InitTEnts();
    resetSpies();
    beginTEntMessage();
    MSG_WriteByte(net_message, TE_TAREXPLOSION);
    MSG_WriteCoord(net_message, 16);
    MSG_WriteCoord(net_message, 17);
    MSG_WriteCoord(net_message, 18);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_BlobExplosion", args: [[16, 17, 18]] }]);
    expect(soundCallsSnapshot()).toEqual([{ entnum: -1, entchannel: 0, sfx: "weapons/r_exp3.wav", origin: [16, 17, 18], fvol: 1, attenuation: 1 }]);
    expect(dlightCallsSnapshot()).toEqual([]);
  });
});

describe("CL_ParseTEnt: TE_SPIKE / TE_SUPERSPIKE (rand()%5 tink/ric sound selection)", () => {
  test("TE_SPIKE runs a color-0/count-10 particle effect and always picks one of the four spike sounds", () => {
    cl_tent.CL_InitTEnts();
    for (let i = 0; i < 25; i++) {
      resetSpies();
      beginTEntMessage();
      MSG_WriteByte(net_message, TE_SPIKE);
      MSG_WriteCoord(net_message, 1);
      MSG_WriteCoord(net_message, 1);
      MSG_WriteCoord(net_message, 1);
      parseTEnt();

      expect(particleCallsSnapshot()).toEqual([{ fn: "R_RunParticleEffect", args: [[1, 1, 1], [0, 0, 0], 0, 10] }]);
      expect(soundCallsSnapshot().length).toBe(1);
      const sfx = soundCallsSnapshot()[0]?.sfx;
      expect(typeof sfx).toBe("string");
      if (typeof sfx === "string") {
        expect(["weapons/tink1.wav", "weapons/ric1.wav", "weapons/ric2.wav", "weapons/ric3.wav"]).toContain(sfx);
      }
    }
  });

  test("TE_SUPERSPIKE runs a color-0/count-20 particle effect and always picks one of the four spike sounds", () => {
    cl_tent.CL_InitTEnts();
    for (let i = 0; i < 25; i++) {
      resetSpies();
      beginTEntMessage();
      MSG_WriteByte(net_message, TE_SUPERSPIKE);
      MSG_WriteCoord(net_message, 2);
      MSG_WriteCoord(net_message, 2);
      MSG_WriteCoord(net_message, 2);
      parseTEnt();

      expect(particleCallsSnapshot()).toEqual([{ fn: "R_RunParticleEffect", args: [[2, 2, 2], [0, 0, 0], 0, 20] }]);
      expect(soundCallsSnapshot().length).toBe(1);
      const sfx = soundCallsSnapshot()[0]?.sfx;
      expect(typeof sfx).toBe("string");
      if (typeof sfx === "string") {
        expect(["weapons/tink1.wav", "weapons/ric1.wav", "weapons/ric2.wav", "weapons/ric3.wav"]).toContain(sfx);
      }
    }
  });
});

describe("CL_ParseTEnt: TE_EXPLOSION / TE_EXPLOSION2 (350/0.5/300 dlight)", () => {
  test("TE_EXPLOSION: particle explosion, r_exp3 sound, dlight radius 350 / die cl.time+0.5 / decay 300", () => {
    cl_tent.CL_InitTEnts();
    resetSpies();
    cl.time = 12;

    beginTEntMessage();
    MSG_WriteByte(net_message, TE_EXPLOSION);
    MSG_WriteCoord(net_message, 1);
    MSG_WriteCoord(net_message, 2);
    MSG_WriteCoord(net_message, 3);
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_ParticleExplosion", args: [[1, 2, 3]] }]);
    expect(soundCallsSnapshot()).toEqual([{ entnum: -1, entchannel: 0, sfx: "weapons/r_exp3.wav", origin: [1, 2, 3], fvol: 1, attenuation: 1 }]);

    expect(dlightCallsSnapshot().length).toBe(1);
    expect(dlightCallsSnapshot()[0]?.key).toBe(0);
    const dl = dlightCallsSnapshot()[0]?.dlight;
    if (!dl) throw new Error("unreachable");
    expect(Array.from(dl.origin)).toEqual([1, 2, 3]);
    expect(dl.radius).toBe(350);
    expect(dl.die).toBeCloseTo(12.5, 5);
    expect(dl.decay).toBe(300);
  });

  test("TE_EXPLOSION2: color-mapped particle explosion with colorStart/colorLength bytes, same dlight shape", () => {
    cl_tent.CL_InitTEnts();
    resetSpies();
    cl.time = 20;

    beginTEntMessage();
    MSG_WriteByte(net_message, TE_EXPLOSION2);
    MSG_WriteCoord(net_message, 4);
    MSG_WriteCoord(net_message, 5);
    MSG_WriteCoord(net_message, 6);
    MSG_WriteByte(net_message, 200); // colorStart
    MSG_WriteByte(net_message, 8); // colorLength
    parseTEnt();

    expect(particleCallsSnapshot()).toEqual([{ fn: "R_ParticleExplosion2", args: [[4, 5, 6], 200, 8] }]);
    expect(soundCallsSnapshot()).toEqual([{ entnum: -1, entchannel: 0, sfx: "weapons/r_exp3.wav", origin: [4, 5, 6], fvol: 1, attenuation: 1 }]);

    expect(dlightCallsSnapshot().length).toBe(1);
    const dl = dlightCallsSnapshot()[0]?.dlight;
    if (!dl) throw new Error("unreachable");
    expect(dl.radius).toBe(350);
    expect(dl.die).toBeCloseTo(20.5, 5);
    expect(dl.decay).toBe(300);
  });
});

describe("CL_ParseTEnt: lightning bolt / beam dispatch (Mod_ForName + CL_ParseBeam)", () => {
  test.each([
    [TE_LIGHTNING1, "progs/bolt.mdl"],
    [TE_LIGHTNING2, "progs/bolt2.mdl"],
    [TE_LIGHTNING3, "progs/bolt3.mdl"],
    [TE_BEAM, "progs/beam.mdl"],
  ])("type %i loads %s with crash=true and stores a beam ending at cl.time+0.2", (type, path) => {
    modForNameSpy.mockClear();
    cl.time = 8;

    beginTEntMessage();
    MSG_WriteByte(net_message, type);
    MSG_WriteShort(net_message, 3); // entity
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 90);
    MSG_WriteCoord(net_message, 0);
    MSG_WriteCoord(net_message, 0);
    parseTEnt();

    expect(modForNameCallsSnapshot()).toEqual([{ name: path, crash: true }]);
    const b = cl_beams.find((x) => x.entity === 3 && x.model === lastFakeModel);
    expect(b).toBeDefined();
    if (!b) throw new Error("unreachable");
    expect(b.endtime).toBeCloseTo(8.2, 5);
    expect(Array.from(b.end)).toEqual([90, 0, 0]);
  });
});

describe("CL_ParseTEnt: unknown type", () => {
  test("throws SysError with the exact C message", () => {
    beginTEntMessage();
    MSG_WriteByte(net_message, 250);
    MSG_BeginReading();
    expect(() => cl_tent.CL_ParseTEnt()).toThrow(SysError);

    beginTEntMessage();
    MSG_WriteByte(net_message, 250);
    MSG_BeginReading();
    expect(() => cl_tent.CL_ParseTEnt()).toThrow("CL_ParseTEnt: bad type");
  });
});

describe("CL_NewTempEntity", () => {
  test("returns null once MAX_VISEDICTS is reached", () => {
    cl_tent.CL_UpdateTEnts(); // resets num_temp_entities to 0 (no active beams)
    clState.cl_numvisedicts = MAX_VISEDICTS;
    expect(cl_tent.CL_NewTempEntity()).toBeNull();
  });

  test("returns null once MAX_TEMP_ENTITIES is reached; pushes into cl_visedicts and sets colormap from vid.colormap otherwise", () => {
    cl_tent.CL_UpdateTEnts();
    clState.cl_numvisedicts = 0;
    vid.colormap = new Uint8Array([9, 9, 9]);

    let last = null;
    for (let i = 0; i < MAX_TEMP_ENTITIES; i++) {
      last = cl_tent.CL_NewTempEntity();
      expect(last).not.toBeNull();
    }
    expect(cl_tent.CL_NewTempEntity()).toBeNull();
    expect(clState.cl_numvisedicts).toBe(MAX_TEMP_ENTITIES);
    expect(cl_visedicts[0]).not.toBeNull();
    if (!last) throw new Error("unreachable");
    expect(last.colormap).toBe(vid.colormap);
  });
});

describe("CL_UpdateTEnts", () => {
  test("spawns ceil(dist/30) entities along a straight beam, with truncated yaw/pitch and a rand()%360 roll", () => {
    cl.time = 5;
    const b = cl_beams[0];
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.entity = 123; // not cl.viewentity, so start is not overwritten
    cl.viewentity = 999;
    b.start[0] = 0;
    b.start[1] = 0;
    b.start[2] = 0;
    b.end[0] = 90;
    b.end[1] = 0;
    b.end[2] = 0;

    cl_tent.CL_UpdateTEnts();

    expect(clState.cl_numvisedicts).toBe(3); // ceil(90/30)
    const origins = cl_visedicts.slice(0, 3).map((e) => (e ? Array.from(e.origin) : null));
    expect(origins).toEqual([
      [0, 0, 0],
      [30, 0, 0],
      [60, 0, 0],
    ]);
    for (const e of cl_visedicts.slice(0, 3)) {
      if (!e) throw new Error("unreachable");
      expect(e.angles[0]).toBeCloseTo(0, 5); // pitch
      expect(e.angles[1]).toBeCloseTo(0, 5); // yaw
      expect(e.angles[2]).toBeGreaterThanOrEqual(0);
      expect(e.angles[2]).toBeLessThan(360);
      expect(Number.isInteger(e.angles[2])).toBe(true);
      expect(e.model).toBe(b.model);
    }
  });

  test("a purely-vertical beam takes the dist[0]==dist[1]==0 branch: yaw 0, pitch 90 (or 270 pointing down)", () => {
    cl.time = 5;
    const up = cl_beams[0];
    up.model = new ModelT();
    up.endtime = cl.time + 1;
    up.entity = -1; // != cl.viewentity (0), so the start isn't overwritten from cl_entities
    up.start[0] = 0;
    up.start[1] = 0;
    up.start[2] = 0;
    up.end[0] = 0;
    up.end[1] = 0;
    up.end[2] = 50;

    cl_tent.CL_UpdateTEnts();
    expect(clState.cl_numvisedicts).toBe(2); // ceil(50/30)
    const e0 = cl_visedicts[0];
    if (!e0) throw new Error("unreachable");
    expect(e0.angles[1]).toBe(0); // yaw
    expect(e0.angles[0]).toBe(90); // pitch: dist[2] > 0

    resetBeams();
    clState.cl_numvisedicts = 0;
    cl_tent.CL_UpdateTEnts();

    const down = cl_beams[0];
    down.model = new ModelT();
    down.endtime = cl.time + 1;
    down.entity = -1; // != cl.viewentity (0)
    down.start[0] = 0;
    down.start[1] = 0;
    down.start[2] = 50;
    down.end[0] = 0;
    down.end[1] = 0;
    down.end[2] = 0;

    cl_tent.CL_UpdateTEnts();
    const e1 = cl_visedicts[0];
    if (!e1) throw new Error("unreachable");
    expect(e1.angles[1]).toBe(0);
    expect(e1.angles[0]).toBe(270); // pitch: dist[2] < 0
  });

  test("updates the beam start from cl_entities[cl.viewentity].origin when b.entity === cl.viewentity", () => {
    cl.time = 5;
    cl.viewentity = 7;
    cl_entities[7].origin[0] = 10;
    cl_entities[7].origin[1] = 20;
    cl_entities[7].origin[2] = 30;

    const b = cl_beams[0];
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.entity = 7;
    b.start[0] = 0; // stale -- must be refreshed from cl_entities before use
    b.start[1] = 0;
    b.start[2] = 0;
    b.end[0] = 40;
    b.end[1] = 20;
    b.end[2] = 30; // 30 units from the refreshed start -> exactly one entity

    cl_tent.CL_UpdateTEnts();

    expect(clState.cl_numvisedicts).toBe(1);
    const e0 = cl_visedicts[0];
    if (!e0) throw new Error("unreachable");
    expect(Array.from(e0.origin)).toEqual([10, 20, 30]);
  });

  test("skips a beam with no model or an expired endtime", () => {
    cl.time = 5;
    cl_beams[0].model = null; // no model -> skipped
    cl_beams[1].model = new ModelT();
    cl_beams[1].endtime = 1; // expired (< cl.time) -> skipped
    cl_beams[1].end[0] = 90;

    cl_tent.CL_UpdateTEnts();
    expect(clState.cl_numvisedicts).toBe(0);
  });

  test("stops early (returns) once MAX_TEMP_ENTITIES is exhausted, without throwing", () => {
    cl.time = 5;
    const b = cl_beams[0];
    b.model = new ModelT();
    b.endtime = cl.time + 1;
    b.start[0] = 0;
    b.start[1] = 0;
    b.start[2] = 0;
    // far longer than MAX_TEMP_ENTITIES*30
    b.end[0] = (MAX_TEMP_ENTITIES + 10) * 30;
    b.end[1] = 0;
    b.end[2] = 0;

    expect(() => cl_tent.CL_UpdateTEnts()).not.toThrow();
    expect(clState.cl_numvisedicts).toBe(MAX_TEMP_ENTITIES);
  });
});

describe("client.h constants this unit relies on", () => {
  test("MAX_BEAMS / MAX_TEMP_ENTITIES / MAX_VISEDICTS", () => {
    expect(MAX_BEAMS).toBe(24);
    expect(MAX_TEMP_ENTITIES).toBe(64);
    expect(MAX_VISEDICTS).toBe(256);
  });
});
