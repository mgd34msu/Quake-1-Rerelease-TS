/*
haptics.ts -- controller rumble driven by the 2021 re-release's `vibrate`
client command and its .bnvib tactile assets.

Adapted from ../quake-2-re-ts/src/platform/haptics.ts and its
src/qcommon/bnvib.ts sibling (both HEAD 7e88015, our own GPLv2 repo), merged
into this one file: this unit's SCOPE has no separate qcommon/bnvib.ts slot,
and this port's own "one native layer" ruling (ARCHITECTURE.md "Unified
client and server") keeps every SDL_GameController handle inside
src/platform/sdl.ts -- unlike quake-2-re-ts's haptics.ts, which dlopen()s its
own independent copy of libSDL2 and runs its own open/close/rescan loop,
this file has NO dlopen of its own.

DEPENDENCY INJECTION, NOT A STATIC IMPORT OF sdl.ts: src/client/cl_main.ts
imports this file for the `vibrate` command handler (Haptics_Vibrate_f,
this unit's SCOPE keeps that edit to one Cmd_AddCommand line), and sdl.ts
already imports cl_main.ts (winquakeInputRefs' sensitivity/m_pitch/m_yaw/
m_forward/m_side/lookstrafe reads, pre-existing). A third static edge from
this file back to sdl.ts (for the rumble calls) would close a
cl_main.ts -> haptics.ts -> sdl.ts -> cl_main.ts cycle, and sdl.ts's own
`winquakeInputRefs` is a plain top-level `const` object literal that reads
those cl_main.ts bindings at MODULE-EVALUATION time (not lazily inside a
function) -- exactly the shape a real ESM cycle deadlocks on ("Cannot access
'sensitivity' before initialization"), reproduced when this file plus
sdl.ts were both statically wired and a test run happened to import them in
the wrong order. HAPTICS_SetRumbleBackend below is the fix: sdl.ts calls it
once from IN_Init with its own SDL_RumbleActiveController/
SDL_StopActiveControllerRumble functions, so the dependency still flows
sdl.ts -> haptics.ts only, one-way, and this file never imports sdl.ts at
all.

=============================================================================
TRIGGER MODEL -- this port's own, verified against the actual retail QuakeC

quake-rerelease-qc/quakec/weapons.qc and quakec_ctf/weapons.qc both contain
`stuffcmd (self, "vibrate tactile/weapons/sgun1.bnvib")`-style calls (one per
weapon-fire cue, plus two player-pain calls) -- but EVERY one of them is
commented out in the shipped source (grepped both trees in full: every hit is
a `//stuffcmd`). The compiled retail progs.dat therefore never sends
`vibrate` during ordinary play; this is a dormant KEX feature, not something
this port's own testing can observe firing from real gameplay. The `vibrate`
command itself is still implemented faithfully (a mod's QuakeC, or a player
typing it at the console, can use it), and this is the reported finding
rather than an assumption -- see this unit's own report.

The literal argument QuakeC stuffs (e.g. "tactile/weapons/sgun1.bnvib") is
used AS-IS, with no path rewriting: verified against the real
id1/pak0.pak, which ships tactile/weapons/sgun1.bnvib (and 19 others,
tactile/player/*.bnvib + tactile/weapons/*.bnvib) at exactly that path --
see test/haptics.test.ts's retail-gated survey. QuakeEX.kpf separately ships
a bnvib/id1/*.bnvib tree under different names; nothing in the retail
QuakeC ever references that prefix, so this port does not either.

=============================================================================
BNVIB FORMAT ("binary NX vibration", Nintendo Switch HD-rumble data)

Reverse-engineered publicly by the Switch homebrew community
(switchbrew.org/wiki/BNVIB via the Wexos's Wiki mirror) and independently
confirmed here against all 20 retail id1/pak0.pak files (see
test/haptics.test.ts). Little-endian throughout.

  offset  size  field
  0x00    u32   metadataSize -- byte length of the metadata section that
                follows this field, EXCLUDING this field itself. Three
                documented values:
                  0x04 -- "raw": formatId + sampleRateHz only, no loop.
                  0x0c -- "loop": raw fields + loopStart/loopEnd sample
                          indices.
                  0x10 -- "loop+interval": loop fields + an interval sample
                          count from the end of the loop back to its start.
  0x04    u16   formatId -- documented "Always 3"; every one of the 20
                retail files agrees.
  0x06    u16   sampleRateHz -- documented "Always 200" (a 5ms sample
                period); all 20 retail files agree.
  0x08    u32   loopStart (sample index) -- present only if metadataSize is
                0x0c or 0x10.
  0x0c    u32   loopEnd (sample index) -- present only if metadataSize is
                0x0c or 0x10.
  0x10    u32   loopIntervalSamples -- present only if metadataSize is 0x10.
  4+metadataSize
          u32   dataSize -- byte length of the sample array that follows,
                EXCLUDING this field itself. Always a multiple of 4.
  ...     ...   dataSize bytes of 4-byte samples (dataSize/4 of them):
                  +0 u8  ampLow   -- low-band amplitude,  physical = B/255
                  +1 u8  freqLow  -- low-band frequency,  physical =
                                     10 * 2^(B/32) Hz
                  +2 u8  ampHigh  -- high-band amplitude, physical = B/255
                  +3 u8  freqHigh -- high-band frequency, physical =
                                     10 * 2^(B/32) Hz

RETAIL SURVEY FINDING: all 20 shipped id1/pak0.pak files use metadataSize =
0x04 ("raw"); none loop. The loop/loop+interval branches below are exercised
only by this file's own hand-built test vectors.

=============================================================================
DOWNMIX: bnvib's 2-band amplitude+frequency data -> SDL_GameControllerRumble

SDL_GameControllerRumble(controller, low_frequency_rumble,
high_frequency_rumble, duration_ms) takes two AMPLITUDE values for two
fixed-frequency motors -- there is no frequency parameter at all, where a
real Switch Joy-Con/Pro Controller's HD rumble hardware uses genuinely
variable-frequency LRA actuators. There is no publicly documented formula for
folding a band's amplitude AND frequency into one motor-intensity value, and
this file does not invent one (see ../quake-2-re-ts/src/platform/haptics.ts's
own header for the survey of prior art this follows: Ryujinx's own docs
describe HD rumble as "Emulated via standard rumble", amplitude only).
downmixBnvibSample maps ampLow/ampHigh straight to SDL's low/high motor
intensities and drops freqLow/freqHigh for motor-intensity purposes
(bnvibFrequencyHz is still exported for any future caller that wants the
decoded Hz value for something else).

=============================================================================
SCHEDULING

BnvibScheduler.play() latches a pattern and a start timestamp;
BnvibScheduler.update(nowMs), called once per client frame from
src/platform/sdl.ts's IN_Commands (Haptics_Frame below), computes which
5ms-at-200Hz sample index "now" falls into and, if it changed since the last
update, downmixes that sample and reissues the rumble sink with a duration
slightly longer than one sample period -- so an occasional late frame
doesn't cause an audible/felt gap before the next update() call, without
needing precise sub-frame timers. Looping patterns (none of the 20 retail
files use this, only this file's own tests do) wrap back to loop.startSample
after loop.endSample, holding the motors at zero during any
loopIntervalSamples silence gap.

=============================================================================
HEADLESS SAFETY

Every call into sdl.ts's rumble functions already degrades to a no-op when
the SDL backend is disarmed, no controller is open, or the platform has no
rumble-capable device -- this file adds no further native-layer guard of its
own. HAPTICS_SetSinkForTests lets a test replace the real SDL-backed sink
with a fake one and drive the scheduler with synthetic timestamps, so
test/haptics.test.ts never touches real hardware or the real SDL library.
*/

import { COM_LoadTempFile } from "../common/common";
import { Cmd_Argv } from "../common/cmd";
import { CvarT, Cvar_RegisterVariable } from "../common/cvar";
import { Con_DPrintf } from "../client/console";

//=============================================================================
// bnvib parsing -- lifted from ../quake-2-re-ts/src/qcommon/bnvib.ts (HEAD
// 7e88015), format re-verified against this port's own retail files (see
// this file's header).

export interface BnvibSampleT {
  ampLow: number; // raw byte 0-255
  freqLow: number; // raw byte 0-255
  ampHigh: number; // raw byte 0-255
  freqHigh: number; // raw byte 0-255
}

export interface BnvibLoopT {
  startSample: number;
  endSample: number;
  // present only when metadataSize === BNVIB_METADATA_LOOP_INTERVAL (0x10)
  intervalSamples?: number;
}

export interface BnvibPatternT {
  sampleRateHz: number;
  loop?: BnvibLoopT;
  samples: BnvibSampleT[];
}

export type ParseBnvibResultT = { ok: true; pattern: BnvibPatternT } | { ok: false; reason: string };

export const BNVIB_METADATA_RAW = 0x04;
export const BNVIB_METADATA_LOOP = 0x0c;
export const BNVIB_METADATA_LOOP_INTERVAL = 0x10;

// "Always 3" per the documented format; every retail file agrees.
const BNVIB_FORMAT_ID = 3;

/** Raw amplitude byte (0-255) -> the documented physical fraction (0.0-1.0). */
export function bnvibAmplitude(byte: number): number {
  return byte / 255;
}

/** Raw frequency byte (0-255) -> the documented physical frequency in Hz:
 *  10 * 2^(B/32). At B=0 this is 10Hz; at B=255 it is ~2503Hz. */
export function bnvibFrequencyHz(byte: number): number {
  return 10 * Math.pow(2, byte / 32);
}

/*
Parses one .bnvib file's bytes into a typed pattern. Never throws --
malformed/unrecognized input comes back as { ok: false, reason } so a caller
degrades to a no-op instead of taking down the client over a bad or
future-format asset.
*/
export function parseBnvib(data: Uint8Array): ParseBnvibResultT {
  if (data.length < 4) return { ok: false, reason: "too short for metadata size field" };

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const metadataSize = dv.getUint32(0, true);

  if (metadataSize !== BNVIB_METADATA_RAW && metadataSize !== BNVIB_METADATA_LOOP && metadataSize !== BNVIB_METADATA_LOOP_INTERVAL) {
    return { ok: false, reason: `unsupported metadata size 0x${metadataSize.toString(16)} (expected 0x04 raw, 0x0c loop, or 0x10 loop+interval)` };
  }

  const metadataEnd = 4 + metadataSize;
  if (data.length < metadataEnd + 4) return { ok: false, reason: "truncated before metadata section end" };

  const formatId = dv.getUint16(4, true);
  if (formatId !== BNVIB_FORMAT_ID) return { ok: false, reason: `unsupported formatId ${formatId} (expected ${BNVIB_FORMAT_ID})` };

  const sampleRateHz = dv.getUint16(6, true);

  let loop: BnvibLoopT | undefined;
  if (metadataSize === BNVIB_METADATA_LOOP || metadataSize === BNVIB_METADATA_LOOP_INTERVAL) {
    const startSample = dv.getUint32(8, true);
    const endSample = dv.getUint32(12, true);
    loop = { startSample, endSample };
    if (metadataSize === BNVIB_METADATA_LOOP_INTERVAL) {
      loop.intervalSamples = dv.getUint32(16, true);
    }
  }

  const dataSize = dv.getUint32(metadataEnd, true);
  if (dataSize % 4 !== 0) return { ok: false, reason: `sample data size ${dataSize} is not a multiple of 4` };

  const bodyStart = metadataEnd + 4;
  if (data.length < bodyStart + dataSize) return { ok: false, reason: "truncated sample data" };

  const sampleCount = dataSize / 4;
  const samples: BnvibSampleT[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const off = bodyStart + i * 4;
    samples[i] = {
      ampLow: data[off] ?? 0,
      freqLow: data[off + 1] ?? 0,
      ampHigh: data[off + 2] ?? 0,
      freqHigh: data[off + 3] ?? 0,
    };
  }

  return { ok: true, pattern: { sampleRateHz, loop, samples } };
}

//=============================================================================
// scheduler -- pattern + wall-clock timestamp in, motor intensities out.
// Lifted unchanged (aside from the import path) from
// ../quake-2-re-ts/src/platform/haptics.ts.

// low/high in [0,1]; durationMs is how long the caller should assume the
// motors stay at this intensity if no further call arrives.
export interface RumbleSinkT {
  setMotors(low: number, high: number, durationMs: number): void;
  stop(): void;
}

// test seam: records every call instead of touching SDL.
export class FakeRumbleSinkT implements RumbleSinkT {
  calls: Array<{ low: number; high: number; durationMs: number }> = [];
  stopped = 0;
  setMotors(low: number, high: number, durationMs: number): void {
    this.calls.push({ low, high, durationMs });
  }
  stop(): void {
    this.stopped++;
  }
}

// See this file's header "DOWNMIX" section. low/high are fractions in [0,1].
export function downmixBnvibSample(sample: BnvibSampleT): { low: number; high: number } {
  return { low: bnvibAmplitude(sample.ampLow), high: bnvibAmplitude(sample.ampHigh) };
}

const IDLE_HOLD_MS = 50;
// re-issued rumble duration padding over one sample period, so a late next
// frame doesn't cause a felt dropout before the following update() call.
const DURATION_PAD_MS = 20;

export class BnvibScheduler {
  private sink: RumbleSinkT;
  private pattern: BnvibPatternT | null = null;
  private startMs = 0;
  // -1: nothing applied yet; -2: holding idle (in a loop's silence gap)
  private lastAppliedIndex = -1;

  constructor(sink: RumbleSinkT) {
    this.sink = sink;
  }

  setSink(sink: RumbleSinkT): void {
    this.sink = sink;
  }

  play(pattern: BnvibPatternT, nowMs: number): void {
    this.pattern = pattern;
    this.startMs = nowMs;
    this.lastAppliedIndex = -1;
    this.update(nowMs);
  }

  stop(): void {
    if (this.pattern === null && this.lastAppliedIndex === -1) return;
    this.pattern = null;
    this.lastAppliedIndex = -1;
    this.sink.stop();
  }

  isPlaying(): boolean {
    return this.pattern !== null;
  }

  update(nowMs: number): void {
    const pattern = this.pattern;
    if (!pattern || pattern.samples.length === 0) return;

    const samplePeriodMs = 1000 / pattern.sampleRateHz;
    const total = pattern.samples.length;
    let index = Math.floor((nowMs - this.startMs) / samplePeriodMs);

    if (index >= total) {
      const loop = pattern.loop;
      const loopLen = loop ? loop.endSample - loop.startSample : 0;
      if (loop && loopLen > 0) {
        const cycleLen = loopLen + (loop.intervalSamples ?? 0);
        const posInCycle = (index - total) % cycleLen;
        if (posInCycle < loopLen) {
          index = loop.startSample + posInCycle;
        } else {
          if (this.lastAppliedIndex !== -2) {
            this.lastAppliedIndex = -2;
            this.sink.setMotors(0, 0, IDLE_HOLD_MS);
          }
          return;
        }
      } else {
        this.stop();
        return;
      }
    }

    if (index === this.lastAppliedIndex) return;
    this.lastAppliedIndex = index;

    const { low, high } = downmixBnvibSample(pattern.samples[index]);
    this.sink.setMotors(low, high, Math.ceil(samplePeriodMs) + DURATION_PAD_MS);
  }
}

//=============================================================================
// real sink -- routes through sdl.ts's own controller handle (this port's
// "one native layer" ruling; see this file's header), via an INJECTED
// backend rather than a static import of sdl.ts (see this file's own header
// comment on the ESM cycle that a static import would close).
// joy_rumble_scale is applied ONLY here, not inside BnvibScheduler, so the
// scheduler's own sample-timing math stays testable independent of this
// cvar.

export interface RumbleBackendT {
  rumble(low: number, high: number, durationMs: number): void;
  stop(): void;
}

let rumbleBackend: RumbleBackendT | null = null;

/** Called once from src/platform/sdl.ts's IN_Init, handing this file its own
 *  SDL_RumbleActiveController/SDL_StopActiveControllerRumble functions --
 *  see this file's header for why this is an injected backend rather than a
 *  static `import ... from "./sdl"`. Pass null to detach (test seam / this
 *  file's own HAPTICS_ResetForTests). */
export function HAPTICS_SetRumbleBackend(backend: RumbleBackendT | null): void {
  rumbleBackend = backend;
}

const sdlRumbleSink: RumbleSinkT = {
  setMotors(low, high, durationMs) {
    if (!rumbleBackend) return;
    const scale = joy_rumble_scale.value;
    const lo = Math.max(0, Math.min(1, low * scale));
    const hi = Math.max(0, Math.min(1, high * scale));
    rumbleBackend.rumble(lo, hi, durationMs);
  },
  stop() {
    rumbleBackend?.stop();
  },
};

//=============================================================================
// pattern cache -- COM_LoadTempFile + parseBnvib, memoized (including
// misses, so a sound with no tactile counterpart only costs one failed
// lookup ever).

const patternCache = new Map<string, BnvibPatternT | null>();

function loadBnvibPattern(path: string): BnvibPatternT | null {
  const cached = patternCache.get(path);
  if (cached !== undefined) return cached;

  let pattern: BnvibPatternT | null = null;
  const bytes = COM_LoadTempFile(path);
  if (bytes) {
    const result = parseBnvib(bytes);
    if (result.ok) pattern = result.pattern;
    else Con_DPrintf("vibrate: %s: %s\n", path, result.reason);
  } else {
    Con_DPrintf("vibrate: %s: file not found\n", path);
  }
  patternCache.set(path, pattern);
  return pattern;
}

//=============================================================================
// public API

/*
`joy_rumble` -- 0/1, default 1: master on/off for controller rumble. Default
"on" is the same convention this port's other joy_* and in_* enable cvars use
(e.g. sdl.ts's own IN_Init cvars): a config that never touches it sees
rumble whenever a rumble-capable controller happens to be present, which is
observably identical to "off" on a machine with no controller.
`joy_rumble_scale` -- linear multiplier on both motors' intensity, applied
after the .bnvib pattern's own downmixed amplitude and clamped to [0,1].
Not named in any reference source (Ironwail's own single `joy_rumble` cvar
is a 0..1 intensity, not a separate bool+scale pair) -- this port's own
two-cvar split, per this unit's brief.
*/
export const joy_rumble = new CvarT("joy_rumble", "1", true);
export const joy_rumble_scale = new CvarT("joy_rumble_scale", "1", true);

let currentNowMs = 0;
const scheduler = new BnvibScheduler(sdlRumbleSink);

/** Registers this file's two cvars. Called from src/platform/sdl.ts's
 *  IN_Init, alongside that file's other in_* and joy_* registrations -- this
 *  unit's SCOPE keeps src/client/cl_main.ts's edit to the single `vibrate`
 *  command line (see Haptics_Vibrate_f below), so cvar/command registration
 *  is split the same way sdl.ts already splits gamepad_assign.ts's
 *  RegisterPlayerCvars from cl_input.ts's IN_JoyMove. */
export function Haptics_Init(): void {
  Cvar_RegisterVariable(joy_rumble);
  Cvar_RegisterVariable(joy_rumble_scale);
}

function rumbleWanted(): boolean {
  return joy_rumble.value !== 0;
}

/*
==================
Haptics_Vibrate_f

The `vibrate <path>` client command the 2021 re-release's QuakeC stuffs
(commented out in the shipped source -- see this file's header). `path` is
used exactly as given (e.g. "tactile/weapons/sgun1.bnvib"), matching the
verified retail id1/pak0.pak layout.
==================
*/
export function Haptics_Vibrate_f(): void {
  const path = Cmd_Argv(1);
  if (!path) {
    Con_DPrintf("vibrate <tactile path>\n");
    return;
  }
  if (!rumbleWanted()) return;

  const pattern = loadBnvibPattern(path);
  if (!pattern) return;

  scheduler.play(pattern, currentNowMs);
}

/*
Called once per client frame from src/platform/sdl.ts's IN_Commands (already
called unconditionally once per frame while the input backend is live -- see
that function's own doc comment). Drives the scheduler's sample-index
timing.
*/
export function Haptics_Frame(nowMs: number): void {
  currentNowMs = nowMs;
  if (!rumbleWanted()) {
    scheduler.stop();
    return;
  }
  scheduler.update(nowMs);
}

export function HAPTICS_IsPlaying(): boolean {
  return scheduler.isPlaying();
}

// test seam: swap the real SDL-backed sink for a fake one (or back).
export function HAPTICS_SetSinkForTests(sink: RumbleSinkT | null): void {
  scheduler.setSink(sink ?? sdlRumbleSink);
}

// test seam: forget every cached pattern and stop any in-flight pattern,
// mirroring src/platform/sdl.ts's own SDL_ResetBackendForTests.
export function HAPTICS_ResetForTests(): void {
  scheduler.stop();
  scheduler.setSink(sdlRumbleSink);
  patternCache.clear();
  currentNowMs = 0;
}
