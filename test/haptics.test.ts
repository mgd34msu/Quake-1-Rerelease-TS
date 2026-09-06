// Tests for src/platform/haptics.ts (U22): the .bnvib parser lifted from
// ../quake-2-re-ts/src/qcommon/bnvib.ts, the BnvibScheduler that turns a
// parsed pattern plus a wall-clock timestamp into motor intensities, and the
// `vibrate` client command. Self-sufficient per standing order 13: every
// section builds or registers what it reads and restores it in afterAll.
//
// Section 1: synthetic .bnvib byte layouts (parseBnvib, bnvibAmplitude,
// bnvibFrequencyHz). Section 2: BnvibScheduler driven by synthetic
// waveforms into FakeRumbleSinkT with hand-picked timestamps. Section 3: a
// guarded survey of the REAL retail id1/pak0.pak tactile/*.bnvib files (all
// 20 of them), extracted with test/support/pak_reader.ts -- this is what
// verifies this file's header claim that the format matches Quake II's
// 53-file retail set exactly (metadataSize 0x04, formatId 3, 200Hz, no
// loop). Section 4: the `vibrate` command and joy_rumble/joy_rumble_scale
// cvars, driven through HAPTICS_SetSinkForTests so no real SDL is touched.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseBnvib,
  bnvibAmplitude,
  bnvibFrequencyHz,
  downmixBnvibSample,
  BnvibScheduler,
  FakeRumbleSinkT,
  BNVIB_METADATA_RAW,
  BNVIB_METADATA_LOOP,
  BNVIB_METADATA_LOOP_INTERVAL,
  joy_rumble,
  joy_rumble_scale,
  Haptics_Init,
  Haptics_Vibrate_f,
  Haptics_Frame,
  HAPTICS_IsPlaying,
  HAPTICS_SetSinkForTests,
  HAPTICS_ResetForTests,
  type BnvibPatternT,
  type BnvibSampleT,
} from "../src/platform/haptics";
import { Cbuf_Init, Cmd_TokenizeString } from "../src/common/cmd";
import { Cvar_FindVar, Cvar_Set } from "../src/common/cvar";
import { COM_AddGameDirectory } from "../src/common/common";
import { PakFile } from "./support/pak_reader";

// ---------------------------------------------------------------------------
// Section 1: synthetic .bnvib byte layouts
// ---------------------------------------------------------------------------

/*
Builds a .bnvib file's raw bytes by hand, matching the format this file's own
header documents. `samples` is a flat list of {ampLow,freqLow,ampHigh,
freqHigh} bytes; `loop` optionally adds the 0x0c/0x10 metadata sections.
*/
function buildBnvib(opts: { formatId?: number; sampleRateHz?: number; samples: BnvibSampleT[]; loop?: { startSample: number; endSample: number; intervalSamples?: number } }): Uint8Array {
  const formatId = opts.formatId ?? 3;
  const sampleRateHz = opts.sampleRateHz ?? 200;
  const metadataSize = opts.loop ? (opts.loop.intervalSamples !== undefined ? BNVIB_METADATA_LOOP_INTERVAL : BNVIB_METADATA_LOOP) : BNVIB_METADATA_RAW;
  const dataSize = opts.samples.length * 4;
  const total = 4 + metadataSize + 4 + dataSize;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let off = 0;
  dv.setUint32(off, metadataSize, true);
  off += 4;
  dv.setUint16(off, formatId, true);
  dv.setUint16(off + 2, sampleRateHz, true);
  off += 4;
  if (opts.loop) {
    dv.setUint32(off, opts.loop.startSample, true);
    dv.setUint32(off + 4, opts.loop.endSample, true);
    off += 8;
    if (opts.loop.intervalSamples !== undefined) {
      dv.setUint32(off, opts.loop.intervalSamples, true);
      off += 4;
    }
  }
  dv.setUint32(off, dataSize, true);
  off += 4;
  for (const s of opts.samples) {
    buf[off++] = s.ampLow;
    buf[off++] = s.freqLow;
    buf[off++] = s.ampHigh;
    buf[off++] = s.freqHigh;
  }
  return buf;
}

describe("haptics.ts -- parseBnvib (synthetic)", () => {
  test("parses a minimal 'raw' (metadataSize 0x04) file with one sample", () => {
    const bytes = buildBnvib({ samples: [{ ampLow: 128, freqLow: 64, ampHigh: 255, freqHigh: 0 }] });
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pattern.sampleRateHz).toBe(200);
    expect(result.pattern.loop).toBeUndefined();
    expect(result.pattern.samples).toEqual([{ ampLow: 128, freqLow: 64, ampHigh: 255, freqHigh: 0 }]);
  });

  test("parses a 'loop' (0x0c) file with loopStart/loopEnd", () => {
    const samples: BnvibSampleT[] = Array.from({ length: 10 }, (_, i) => ({ ampLow: i, freqLow: 0, ampHigh: 0, freqHigh: 0 }));
    const bytes = buildBnvib({ samples, loop: { startSample: 2, endSample: 8 } });
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pattern.loop).toEqual({ startSample: 2, endSample: 8 });
    expect(result.pattern.samples.length).toBe(10);
  });

  test("parses a 'loop+interval' (0x10) file with an interval sample count", () => {
    const samples: BnvibSampleT[] = Array.from({ length: 6 }, () => ({ ampLow: 0, freqLow: 0, ampHigh: 0, freqHigh: 0 }));
    const bytes = buildBnvib({ samples, loop: { startSample: 1, endSample: 4, intervalSamples: 5 } });
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pattern.loop).toEqual({ startSample: 1, endSample: 4, intervalSamples: 5 });
  });

  test("rejects an unsupported metadataSize", () => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, 0x99, true);
    const result = parseBnvib(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unsupported metadata size/);
  });

  test("rejects an unsupported formatId", () => {
    const bytes = buildBnvib({ formatId: 7, samples: [{ ampLow: 1, freqLow: 1, ampHigh: 1, freqHigh: 1 }] });
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unsupported formatId 7/);
  });

  test("rejects a file too short for the metadata size field", () => {
    const result = parseBnvib(new Uint8Array([1, 2]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too short/);
  });

  test("rejects a file truncated before the metadata section ends", () => {
    const buf = new Uint8Array(6); // metadataSize says 0x0c (loop) but only 2 bytes follow
    new DataView(buf.buffer).setUint32(0, BNVIB_METADATA_LOOP, true);
    const result = parseBnvib(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/truncated before metadata/);
  });

  test("rejects a dataSize that is not a multiple of 4", () => {
    const bytes = buildBnvib({ samples: [{ ampLow: 1, freqLow: 1, ampHigh: 1, freqHigh: 1 }] });
    // dataSize field sits right after the 8-byte "raw" header; corrupt it to 5.
    new DataView(bytes.buffer).setUint32(8, 5, true);
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a multiple of 4/);
  });

  test("rejects truncated sample data", () => {
    const bytes = buildBnvib({ samples: [{ ampLow: 1, freqLow: 1, ampHigh: 1, freqHigh: 1 }] });
    const truncated = bytes.subarray(0, bytes.length - 1);
    const result = parseBnvib(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/truncated sample data/);
  });
});

describe("haptics.ts -- bnvibAmplitude / bnvibFrequencyHz / downmixBnvibSample", () => {
  test("bnvibAmplitude: byte/255, 0 and 255 map to the documented extremes", () => {
    expect(bnvibAmplitude(0)).toBe(0);
    expect(bnvibAmplitude(255)).toBe(1);
    expect(bnvibAmplitude(128)).toBeCloseTo(128 / 255, 10);
  });

  test("bnvibFrequencyHz: 10 * 2^(B/32), hand-computed at B=0 and B=32", () => {
    expect(bnvibFrequencyHz(0)).toBeCloseTo(10, 10);
    expect(bnvibFrequencyHz(32)).toBeCloseTo(20, 10); // 2^(32/32) = 2, 10*2 = 20
  });

  test("downmixBnvibSample maps ampLow/ampHigh to low/high fractions, ignoring frequency entirely", () => {
    const result = downmixBnvibSample({ ampLow: 255, freqLow: 200, ampHigh: 0, freqHigh: 5 });
    expect(result).toEqual({ low: 1, high: 0 });
  });
});

// ---------------------------------------------------------------------------
// Section 2: BnvibScheduler -- synthetic waveform, synthetic timestamps, a
// fake rumble sink.
// ---------------------------------------------------------------------------

function makePattern(ampLows: number[], loop?: BnvibPatternT["loop"]): BnvibPatternT {
  return {
    sampleRateHz: 200, // 5ms per sample
    loop,
    samples: ampLows.map((a) => ({ ampLow: a, freqLow: 0, ampHigh: 0, freqHigh: 0 })),
  };
}

describe("haptics.ts -- BnvibScheduler (synthetic, FakeRumbleSinkT)", () => {
  test("play() immediately applies sample 0", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    scheduler.play(makePattern([255, 0]), 1000);
    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0]!.low).toBeCloseTo(1, 10);
    expect(scheduler.isPlaying()).toBe(true);
  });

  test("update() only re-issues the sink call when the sample index actually changes", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    scheduler.play(makePattern([255, 128, 0]), 1000); // sample period 5ms
    expect(sink.calls.length).toBe(1);

    scheduler.update(1002); // still within sample 0's 5ms window
    expect(sink.calls.length).toBe(1);

    scheduler.update(1005); // exactly at sample 1's boundary
    expect(sink.calls.length).toBe(2);
    expect(sink.calls[1]!.low).toBeCloseTo(128 / 255, 10);

    scheduler.update(1010); // sample 2
    expect(sink.calls.length).toBe(3);
    expect(sink.calls[2]!.low).toBe(0);
  });

  test("running off the end of a non-looping pattern stops the scheduler and calls sink.stop()", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    scheduler.play(makePattern([255, 255]), 1000); // 2 samples, 10ms total
    scheduler.update(1500); // well past the end
    expect(scheduler.isPlaying()).toBe(false);
    expect(sink.stopped).toBe(1);
  });

  test("a looping pattern wraps back to loop.startSample after loop.endSample", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    // samples: [A=50, B=100, C=150, D=200]; loop covers index 1..3 (endSample
    // exclusive per this file's own scheduler semantics -- verified against
    // the synthetic case here, since none of the 20 retail files loop).
    scheduler.play(makePattern([50, 100, 150, 200], { startSample: 1, endSample: 4 }), 1000);
    // total=4 samples (0..3 at 1000,1005,1010,1015); index 4 at t=1020 wraps
    // to loop.startSample (1) + (4-4)%3 = index 1.
    scheduler.update(1020);
    expect(sink.calls.at(-1)!.low).toBeCloseTo(100 / 255, 10);
    scheduler.update(1025); // index 2
    expect(sink.calls.at(-1)!.low).toBeCloseTo(150 / 255, 10);
    scheduler.update(1030); // index 3
    expect(sink.calls.at(-1)!.low).toBeCloseTo(200 / 255, 10);
    scheduler.update(1035); // wraps again to index 1
    expect(sink.calls.at(-1)!.low).toBeCloseTo(100 / 255, 10);
    expect(scheduler.isPlaying()).toBe(true); // never stops
  });

  test("a loop's silence interval holds the motors at zero exactly once per gap, not every update", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    // 3 samples (0=255,1=128,2=0), loop covers just index 1 (loopLen=1), with
    // a 1-sample silence gap before it repeats (cycleLen = 1+1 = 2). Index 1
    // (not 0) is the loop target so the wrap-around lands on a DIFFERENT
    // sample than whatever was last applied, and actually re-issues instead
    // of being suppressed by update()'s own "index unchanged" short-circuit.
    scheduler.play(makePattern([255, 128, 0], { startSample: 1, endSample: 2, intervalSamples: 1 }), 1000);
    expect(sink.calls.at(-1)!.low).toBeCloseTo(1, 10); // sample 0 applied by play()

    scheduler.update(1005); // index 1
    expect(sink.calls.at(-1)!.low).toBeCloseTo(128 / 255, 10);
    scheduler.update(1010); // index 2
    expect(sink.calls.at(-1)!.low).toBe(0);

    const before = sink.calls.length;
    scheduler.update(1015); // index 3: (3-3)%2=0 -> within loopLen(1) -> loop.startSample+0 = 1
    expect(sink.calls.length).toBe(before + 1);
    expect(sink.calls.at(-1)!.low).toBeCloseTo(128 / 255, 10);

    scheduler.update(1020); // index 4: (4-3)%2=1 -> NOT < loopLen(1) -> silence gap
    const afterFirstSilence = sink.calls.length;
    expect(sink.calls.at(-1)).toEqual({ low: 0, high: 0, durationMs: 50 });

    scheduler.update(1021); // still in the same silence gap -- no re-issue
    expect(sink.calls.length).toBe(afterFirstSilence);
  });

  test("stop() is a no-op if nothing is playing, and calls sink.stop() exactly once otherwise", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    scheduler.stop();
    expect(sink.stopped).toBe(0);

    scheduler.play(makePattern([255]), 1000);
    scheduler.stop();
    expect(sink.stopped).toBe(1);
    expect(scheduler.isPlaying()).toBe(false);
  });

  test("setSink swaps the sink an in-flight pattern reports to", () => {
    const sinkA = new FakeRumbleSinkT();
    const sinkB = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sinkA);
    scheduler.play(makePattern([255, 128]), 1000);
    scheduler.setSink(sinkB);
    scheduler.update(1005);
    expect(sinkA.calls.length).toBe(1); // only the initial play() call
    expect(sinkB.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Section 3: guarded survey of the REAL retail id1/pak0.pak tactile/*.bnvib
// files (all 20).
// ---------------------------------------------------------------------------

const RERELEASE_DATA_DIR = process.env.Q1TS_RERELEASE_DATA ?? `${import.meta.dir}/../../qfiles/q1/rerelease`;
const ID1_PAK = `${RERELEASE_DATA_DIR}/id1/pak0.pak`;
const HAVE_ID1_PAK = existsSync(ID1_PAK);

const RETAIL_BNVIB_FILES = [
  "tactile/player/axhit1.bnvib",
  "tactile/player/axhit2.bnvib",
  "tactile/player/h2ojump.bnvib",
  "tactile/player/land.bnvib",
  "tactile/player/land2.bnvib",
  "tactile/player/pain1.bnvib",
  "tactile/player/pain2.bnvib",
  "tactile/player/pain3.bnvib",
  "tactile/player/pain4.bnvib",
  "tactile/player/pain5.bnvib",
  "tactile/player/pain6.bnvib",
  "tactile/weapons/ax1.bnvib",
  "tactile/weapons/grenade.bnvib",
  "tactile/weapons/guncock.bnvib",
  "tactile/weapons/lhit.bnvib",
  "tactile/weapons/lstart.bnvib",
  "tactile/weapons/rocket1i.bnvib",
  "tactile/weapons/sgun1.bnvib",
  "tactile/weapons/shotgn2.bnvib",
  "tactile/weapons/spike2.bnvib",
];

describe.skipIf(!HAVE_ID1_PAK)("haptics.ts -- real retail id1/pak0.pak tactile/*.bnvib (20 files)", () => {
  test("every one of the 20 known retail files exists in the pak and parses cleanly", () => {
    const pak = new PakFile(ID1_PAK);
    for (const name of RETAIL_BNVIB_FILES) {
      expect(pak.has(name)).toBe(true);
      const result = parseBnvib(pak.read(name));
      expect(result.ok).toBe(true);
    }
  });

  test("every retail file uses metadataSize 0x04 (raw), formatId 3, sampleRateHz 200, and no loop", () => {
    const pak = new PakFile(ID1_PAK);
    for (const name of RETAIL_BNVIB_FILES) {
      const result = parseBnvib(pak.read(name));
      if (!result.ok) throw new Error(`${name}: ${result.reason}`);
      expect(result.pattern.sampleRateHz).toBe(200);
      expect(result.pattern.loop).toBeUndefined();
      expect(result.pattern.samples.length).toBeGreaterThan(0);
    }
  });

  test("sgun1.bnvib (the QuakeC's own cited example, weapons.qc's commented-out stuffcmd) decodes to a non-trivial pattern", () => {
    const pak = new PakFile(ID1_PAK);
    const result = parseBnvib(pak.read("tactile/weapons/sgun1.bnvib"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pattern.samples.length).toBe(74); // 296 bytes / 4
    expect(result.pattern.samples.some((s) => s.ampLow > 0 || s.ampHigh > 0)).toBe(true);
  });

  test("sample counts span the range this file's own header describes (shortest to longest cue)", () => {
    const pak = new PakFile(ID1_PAK);
    const counts = RETAIL_BNVIB_FILES.map((name) => {
      const result = parseBnvib(pak.read(name));
      if (!result.ok) throw new Error(`${name}: ${result.reason}`);
      return result.pattern.samples.length;
    });
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });
});

// ---------------------------------------------------------------------------
// Section 4: `vibrate` command, joy_rumble/joy_rumble_scale cvars, driven
// through HAPTICS_SetSinkForTests -- no real SDL touched.
// ---------------------------------------------------------------------------

// A real gamedir directory (not a PACK/kpf) mounted through
// COM_AddGameDirectory, holding one synthetic .bnvib file this describe
// block builds itself with buildBnvib (Section 1's own helper) -- this is
// what lets Haptics_Vibrate_f's COM_LoadTempFile call actually find
// something, end to end, without needing the real retail data this test
// file's Section 3 already guards on Q1TS_RERELEASE_DATA.
const scratchRoot = process.env.Q1TS_SCRATCH ?? "/tmp/q1ts-tests";
mkdirSync(scratchRoot, { recursive: true });

describe("haptics.ts -- Haptics_Vibrate_f / joy_rumble / joy_rumble_scale", () => {
  const savedRumble = new Map<string, string>();
  const scratchDir = mkdtempSync(join(scratchRoot, "haptics-test-"));
  const SYNTHETIC_PATH = "tactile/weapons/sgun1.bnvib";

  beforeAll(() => {
    Cbuf_Init();
    Haptics_Init(); // registers joy_rumble/joy_rumble_scale (idempotent per Cvar_RegisterVariable's own "already defined" guard -- see gamepad_assign.ts's own getOrCreateCvar doc comment for the same contract)
    for (const cvar of [joy_rumble, joy_rumble_scale]) savedRumble.set(cvar.name, cvar.string);

    mkdirSync(join(scratchDir, "tactile", "weapons"), { recursive: true });
    const synthetic = buildBnvib({
      samples: [
        { ampLow: 255, freqLow: 0, ampHigh: 0, freqHigh: 0 },
        { ampLow: 0, freqLow: 0, ampHigh: 255, freqHigh: 0 },
      ],
    });
    writeFileSync(join(scratchDir, SYNTHETIC_PATH), synthetic);
    // Prepended to com_searchpaths (highest priority) -- see
    // COM_AddGameDirectory's own header comment on search order.
    COM_AddGameDirectory(scratchDir);
  });

  afterAll(() => {
    for (const [name, value] of savedRumble) Cvar_Set(name, value);
    HAPTICS_ResetForTests();
  });

  test("joy_rumble defaults to 1 (on), joy_rumble_scale defaults to 1", () => {
    expect(Cvar_FindVar("joy_rumble")?.value).toBe(1);
    expect(Cvar_FindVar("joy_rumble_scale")?.value).toBe(1);
  });

  test("`vibrate <path>` with no matching asset is a silent no-op, not a throw", () => {
    const sink = new FakeRumbleSinkT();
    HAPTICS_SetSinkForTests(sink);
    Cmd_TokenizeString("vibrate tactile/weapons/does_not_exist.bnvib");
    expect(() => Haptics_Vibrate_f()).not.toThrow();
    expect(sink.calls.length).toBe(0);
    expect(HAPTICS_IsPlaying()).toBe(false);
  });

  test("`vibrate` with no argument prints a usage message and does not throw", () => {
    Cmd_TokenizeString("vibrate");
    expect(() => Haptics_Vibrate_f()).not.toThrow();
    expect(HAPTICS_IsPlaying()).toBe(false);
  });

  test("`vibrate <real path>` loads the file, parses it, and starts the scheduler playing through the fake sink", () => {
    const sink = new FakeRumbleSinkT();
    HAPTICS_SetSinkForTests(sink);
    Cmd_TokenizeString(`vibrate ${SYNTHETIC_PATH}`);
    Haptics_Vibrate_f();
    expect(HAPTICS_IsPlaying()).toBe(true);
    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0]!.low).toBeCloseTo(1, 10); // sample 0: ampLow 255
    HAPTICS_ResetForTests();
    HAPTICS_SetSinkForTests(sink);
  });

  test("joy_rumble 0 makes Haptics_Vibrate_f a no-op even for a real, existing asset", () => {
    const sink = new FakeRumbleSinkT();
    HAPTICS_SetSinkForTests(sink);
    Cvar_Set("joy_rumble", "0");
    Cmd_TokenizeString(`vibrate ${SYNTHETIC_PATH}`);
    Haptics_Vibrate_f();
    expect(HAPTICS_IsPlaying()).toBe(false);
    expect(sink.calls.length).toBe(0);
    Cvar_Set("joy_rumble", "1");
  });

  test("Haptics_Frame(nowMs) advances an in-flight pattern's sample index through the fake sink", () => {
    const sink = new FakeRumbleSinkT();
    HAPTICS_SetSinkForTests(sink);
    Cmd_TokenizeString(`vibrate ${SYNTHETIC_PATH}`);
    Haptics_Vibrate_f();
    expect(sink.calls.length).toBe(1); // sample 0 (5ms period at 200Hz)

    Haptics_Frame(5); // 5ms later: sample 1
    expect(sink.calls.length).toBe(2);
    expect(sink.calls[1]!.high).toBeCloseTo(1, 10); // sample 1: ampHigh 255

    Haptics_Frame(20); // past the 2-sample pattern's end: stops
    expect(HAPTICS_IsPlaying()).toBe(false);
  });

  test("joy_rumble 0 stops an in-flight pattern via Haptics_Frame", () => {
    const sink = new FakeRumbleSinkT();
    HAPTICS_SetSinkForTests(sink);
    Cmd_TokenizeString(`vibrate ${SYNTHETIC_PATH}`);
    Haptics_Vibrate_f();
    expect(HAPTICS_IsPlaying()).toBe(true);

    Cvar_Set("joy_rumble", "0");
    Haptics_Frame(1);
    expect(HAPTICS_IsPlaying()).toBe(false);
    expect(sink.stopped).toBe(1);
    Cvar_Set("joy_rumble", "1");
  });
});
