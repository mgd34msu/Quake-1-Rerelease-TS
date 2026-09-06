/*
gamepad_assign.ts -- WHICH CONTROLLER DRIVES WHICH LOCAL PLAYER, and each
player's own stick tuning.

Adapted from ../quake-2-re-ts/src/platform/gamepad_assign.ts (HEAD 7e88015,
our own GPLv2 repo) onto this port's cvar API: that file's `Cvar_Get`-based
registration (src/qcommon/cvar.ts's own idempotent "first call wins the
default" contract) becomes `new CvarT(...)` + `Cvar_RegisterVariable(...)`
here, guarded by a Cvar_FindVar lookup that reproduces the same "first call
wins, later calls just return the existing cvar" contract on top of this
port's own cvar.ts (see getOrCreateCvar below) -- src/common/cvar.ts has no
Cvar_Get of its own and is outside this unit's SCOPE, so this file builds
the one idiom it needs locally rather than adding one there.

THE MODEL (unchanged from quake-2-re-ts's own original design -- there is
nothing to port this from; WinQuake never had SDL_GameController, and the
2021 rerelease's own KEX engine is closed, so its controller-assignment UI's
behavior is not observable from anything available here):

Four PLAYERS, numbered 1..4 the way a future Controllers menu would show
them. Player 1 is this engine's ordinary client -- the only seat that
exists in this port today (PORTING.md/ARCHITECTURE.md: this repo has no
splitscreen yet) -- and always has the keyboard and mouse, plus optionally
a pad (the "primary" one, the only pad whose buttons reach the bind system).
Players 2..4 are reserved for a future splitscreen seat and are resolved by
every function below exactly as quake-2-re-ts resolves them, but nothing in
src/platform/sdl.ts or src/client/cl_input.ts reads player index 1, 2 or 3
yet -- see this unit's own report for the follow-up that wires them once
splitscreen seats exist.

One CVAR_ARCHIVE cvar per player says what drives it:

  in_player1_device .. in_player4_device

    "auto"          plug/enumeration order. The default, so a player who
                    never opens a (future) Controllers screen sees no
                    change whatsoever.
    "kbm"           player 1 only: keyboard and mouse, and deliberately NO
                    pad, even when pads are plugged in. On players 2..4
                    there is no keyboard to fall back to, so it is treated
                    as "nothing drives this player".
    "<guid>"        a specific controller, by SDL joystick GUID.
    "<guid>#n"      the n-th (1-based) controller sharing that GUID, for
                    the two-identical-pads case where the GUID alone cannot
                    tell them apart.

WHY GUID AND NOT INSTANCE ID. SDL hands out a fresh instance id every time a
device is opened, so an instance id does not survive a replug, let alone a
reboot. The GUID is derived from the device's bus/vendor/product/version, so
it is stable across replugs and boots; its one blind spot (two physically
identical controllers sharing a GUID) is what the "#n" suffix disambiguates,
falling back to plug order because nothing else distinguishes them.

RESOLUTION ORDER (ResolvePadAssignments below, and the only place the rule
lives):
  1. Explicit assignments are honored first, whatever order the devices were
     plugged in. A player whose named controller is not currently present
     gets nothing -- never silently handed some other pad.
  2. Players left on "auto" then take the still-unclaimed controllers in
     plug order.
  3. Any controller no player ended up with is idle.

PER-PLAYER TUNING. Four more CVAR_ARCHIVE cvars per player:

  in_playerN_yawsensitivity    in_playerN_pitchsensitivity
  in_playerN_invertpitch       in_playerN_deadzone

registered by RegisterPlayerCvars with the LIVE value of the matching global
joy_* cvar as their default (joy_sensitivity_yaw/joy_sensitivity_pitch/
joy_deadzone_look/joy_invert -- src/platform/sdl.ts's own IN_Init registers
those first and passes their current .string down as `defaults`), so an
existing config's `set joy_sensitivity_yaw 300` becomes every player's
default too,
and nobody's aim changes because this file was added. joy_deadzone_move and
the forward/side speed cvars stay global for every player -- movement speed
and its own deadzone are not knobs this port exposes per-seat.
*/

import { CvarT, Cvar_RegisterVariable, Cvar_FindVar } from "../common/cvar";

/*
Local players the assignment model covers. A plain constant rather than a
server-side import: this is a src/platform module and must not reach into
the server (there is no splitscreen seat table to import from yet anyway --
see this file's header).
*/
export const MAX_LOCAL_PLAYERS = 4;

/** "follow plug order", the default -- pre-existing behavior. */
export const DEVICE_AUTO = "auto";
/** Player 1 only: keyboard and mouse, no pad. */
export const DEVICE_KBM = "kbm";

/** One controller SDL currently has open, as the assignment model sees it.
 *  `guid` is SDL's own joystick GUID string; `name` is the human-readable
 *  controller name, used only for display. */
export interface PadDeviceT {
  readonly instanceId: number;
  readonly guid: string;
  readonly name: string;
}

export interface AssignmentT {
  /** Index into the device list for each player (0 = player 1), or -1 when
   *  nothing drives that player. */
  readonly players: number[];
  /** Parallel to the device list: true when no player is using that device. */
  readonly idle: boolean[];
}

/*
Position of each device among the devices sharing its GUID, in list (plug)
order. This is the number the "#n" suffix names, minus one -- so the first
pad with a given GUID is ordinal 0 and is written as the bare GUID, the
second is ordinal 1 and is written "<guid>#2".
*/
export function DeviceOrdinals(devices: readonly PadDeviceT[]): number[] {
  const seen = new Map<string, number>();
  const out: number[] = [];
  for (const dev of devices) {
    const n = seen.get(dev.guid) ?? 0;
    out.push(n);
    seen.set(dev.guid, n + 1);
  }
  return out;
}

/** The cvar value naming this device: the bare GUID for the first pad of its
 *  kind, "<guid>#n" (n 1-based) for a later duplicate. */
export function FormatDeviceSpec(guid: string, ordinal: number): string {
  return ordinal <= 0 ? guid : `${guid}#${ordinal + 1}`;
}

/** Split a "<guid>[#n]" cvar value. Returns null for "auto", "kbm", an empty
 *  value, or anything else that does not name a device. */
export function ParseDeviceSpec(spec: string): { guid: string; ordinal: number } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === DEVICE_AUTO || lowered === DEVICE_KBM) return null;

  const hash = trimmed.lastIndexOf("#");
  if (hash < 0) return { guid: trimmed, ordinal: 0 };

  const guid = trimmed.slice(0, hash);
  const n = Number(trimmed.slice(hash + 1));
  // A "#" with nothing usable after it is a typo, not a duplicate index --
  // fall back to the whole string as a GUID rather than silently matching
  // some other pad.
  if (!guid || !Number.isFinite(n) || Math.trunc(n) < 1) return { guid: trimmed, ordinal: 0 };
  return { guid, ordinal: Math.trunc(n) - 1 };
}

/** True when this player's preference is "keyboard and mouse, no pad". Only
 *  meaningful for player 1 (index 0); see this file's header. */
export function IsKbmSpec(spec: string): boolean {
  return spec.trim().toLowerCase() === DEVICE_KBM;
}

/** True when this player is on the default plug-order behavior. An
 *  unrecognized or empty value is treated as "auto", so a hand-mangled
 *  config degrades to the pre-existing behavior instead of leaving a player
 *  with no input at all. */
export function IsAutoSpec(spec: string): boolean {
  const lowered = spec.trim().toLowerCase();
  if (!lowered) return true;
  if (lowered === DEVICE_AUTO) return true;
  if (lowered === DEVICE_KBM) return false;
  return false;
}

/*
==================
ResolvePadAssignments

The whole routing rule, as a pure function of "what is plugged in" and "what
the four cvars say". src/platform/sdl.ts calls it on every hotplug event;
the tests call it directly, which is the reason it takes plain data instead
of reading the cvars itself.

`prefs[i]` is player i+1's in_playerN_device value. Devices are in plug
order, which is the order SDL handed them to us.
==================
*/
export function ResolvePadAssignments(devices: readonly PadDeviceT[], prefs: readonly string[]): AssignmentT {
  const ordinals = DeviceOrdinals(devices);
  const players: number[] = new Array(MAX_LOCAL_PLAYERS).fill(-1);
  const claimed: boolean[] = new Array(devices.length).fill(false);

  // Pass 1 -- explicit assignments, which beat plug order by construction.
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    const spec = prefs[p] ?? DEVICE_AUTO;
    const parsed = ParseDeviceSpec(spec);
    if (!parsed) continue; // auto or kbm; handled below / not a pad at all

    let found = -1;
    for (let d = 0; d < devices.length; d++) {
      const dev = devices[d];
      if (!dev || claimed[d]) continue;
      if (dev.guid !== parsed.guid) continue;
      if (ordinals[d] !== parsed.ordinal) continue;
      found = d;
      break;
    }
    // Not present: this player gets nothing this session (see header rule 1).
    if (found < 0) continue;
    players[p] = found;
    claimed[found] = true;
  }

  // Pass 2 -- "auto" players take what is left, in plug order. "kbm" is
  // skipped here: it is an explicit refusal of a pad, not a fall-through.
  let next = 0;
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    const spec = prefs[p] ?? DEVICE_AUTO;
    if (players[p] >= 0) continue;
    if (IsKbmSpec(spec)) continue;
    if (!IsAutoSpec(spec)) continue; // named a device that is not plugged in
    while (next < devices.length && claimed[next]) next++;
    if (next >= devices.length) break;
    players[p] = next;
    claimed[next] = true;
  }

  return { players, idle: claimed.map((c) => !c) };
}

/*
==================
SeatsDrivable

How many seats the hardware and the assignments can actually fill right
now: player 1 always counts (it has the keyboard and mouse whatever else is
true), and each player after it counts only while every player before it is
also driveable, because seats are filled in order.
==================
*/
export function SeatsDrivable(assignment: AssignmentT): number {
  let n = 1;
  for (let p = 1; p < MAX_LOCAL_PLAYERS; p++) {
    if (assignment.players[p] === undefined || (assignment.players[p] ?? -1) < 0) break;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// CVARS
// ---------------------------------------------------------------------------

/** in_player1_device .. in_player4_device, by 0-based player index. */
export function PlayerDeviceCvarName(player: number): string {
  return `in_player${player + 1}_device`;
}

export interface PlayerTuningCvarNamesT {
  readonly yaw: string;
  readonly pitch: string;
  readonly invert: string;
  readonly deadzone: string;
}

export function PlayerTuningCvarNames(player: number): PlayerTuningCvarNamesT {
  const n = player + 1;
  return {
    yaw: `in_player${n}_yawsensitivity`,
    pitch: `in_player${n}_pitchsensitivity`,
    invert: `in_player${n}_invertpitch`,
    deadzone: `in_player${n}_deadzone`,
  };
}

/*
Reproduces src/common/cvar.ts's Cvar_Get contract ("first call registers
with this default and returns it; a later call with the same name just
returns the already-registered cvar") on top of this port's own
new-CvarT-then-Cvar_RegisterVariable idiom, which has no such helper of its
own (Cvar_RegisterVariable prints "already defined" and refuses a SECOND,
DIFFERENT CvarT object under a name already taken -- see that function's own
doc comment). Looking the name up first and only constructing+registering a
new object on a miss is what makes RegisterPlayerCvars below safe to call
from every IN_Init the way sdl.ts's own _windowed_mouse/m_filter
registrations already are, without the "already defined" console spam a
naive re-registration would produce.
*/
function getOrCreateCvar(name: string, defaultValue: string, archive: boolean): CvarT {
  const existing = Cvar_FindVar(name);
  if (existing) return existing;
  const cvar = new CvarT(name, defaultValue, archive);
  Cvar_RegisterVariable(cvar);
  return cvar;
}

const playerDeviceCvars: CvarT[] = new Array(MAX_LOCAL_PLAYERS);
const playerYawCvars: CvarT[] = new Array(MAX_LOCAL_PLAYERS);
const playerPitchCvars: CvarT[] = new Array(MAX_LOCAL_PLAYERS);
const playerInvertCvars: CvarT[] = new Array(MAX_LOCAL_PLAYERS);
const playerDeadzoneCvars: CvarT[] = new Array(MAX_LOCAL_PLAYERS);

/** The live global joy_* cvars' current string values, used as this call's
 *  per-player tuning defaults -- see this file's header on why the timing
 *  (read AFTER the globals are registered and any config.cfg has run)
 *  matters. */
export interface GlobalJoyDefaultsT {
  readonly yawsensitivity: string;
  readonly pitchsensitivity: string;
  readonly deadzone: string;
  readonly invert: string;
}

/*
==================
RegisterPlayerCvars

Registers all twenty cvars (four players x device + four tuning knobs).
Idempotent via getOrCreateCvar above, so calling this from every IN_Init (or
later from a Controllers menu) costs nothing and never rewrites a value.
==================
*/
export function RegisterPlayerCvars(defaults: GlobalJoyDefaultsT): void {
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    playerDeviceCvars[p] = getOrCreateCvar(PlayerDeviceCvarName(p), DEVICE_AUTO, true);
    const names = PlayerTuningCvarNames(p);
    playerYawCvars[p] = getOrCreateCvar(names.yaw, defaults.yawsensitivity, true);
    playerPitchCvars[p] = getOrCreateCvar(names.pitch, defaults.pitchsensitivity, true);
    playerInvertCvars[p] = getOrCreateCvar(names.invert, defaults.invert, true);
    playerDeadzoneCvars[p] = getOrCreateCvar(names.deadzone, defaults.deadzone, true);
  }
}

/** Every player's device preference, in player order -- the array
 *  ResolvePadAssignments wants. */
export function PlayerDevicePrefs(): string[] {
  const out: string[] = [];
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    const cv = playerDeviceCvars[p];
    out.push(cv ? cv.string : DEVICE_AUTO);
  }
  return out;
}

export interface PlayerTuningT {
  yawsensitivity: number;
  pitchsensitivity: number;
  /** +1 normally, -1 when the player has invert-pitch on. Pre-multiplied so
   *  the axis math in sdl.ts stays a single multiply. */
  pitchsign: number;
  deadzone: number;
}

/** This player's live stick tuning. Reads the cvars every call, matching
 *  every other joy_* cvar in this port being read live once per frame -- a
 *  console `in_player1_deadzone 0.3` takes effect on the next frame. */
export function PlayerTuning(player: number): PlayerTuningT {
  const yaw = playerYawCvars[player];
  const pitch = playerPitchCvars[player];
  const invert = playerInvertCvars[player];
  const deadzone = playerDeadzoneCvars[player];
  return {
    yawsensitivity: yaw ? yaw.value : 1,
    pitchsensitivity: pitch ? pitch.value : 1,
    pitchsign: invert && invert.value !== 0 ? -1 : 1,
    deadzone: deadzone ? deadzone.value : 0.175,
  };
}
